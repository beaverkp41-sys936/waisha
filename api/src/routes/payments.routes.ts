import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, randomToken } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { computeAmounts, detectProvider, type Cycle } from "../payments/amounts.js";
import { getProvider } from "../payments/provider.js";
import { env } from "../env.js";
import { requirePermission } from "../security/permissions.js";

const PENDING_TIMEOUT_MINUTES = 10;

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

export async function paymentsRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Create a payment intent (spec 5.2) ----------
  app.post("/payments/intent", { preHandler: [requireAuth, requirePermission("billing.edit")] }, async (req: any, reply) => {
    await enforceRateLimit(`pay:uid:${req.user.sub}`, 10, 3600);
    const body = z.object({
      planKey: z.enum(["starter", "business", "enterprise"]),
      billingCycle: z.enum(["monthly", "quarterly", "annual"]),
      seats: z.number().int().min(1).max(10000),
      payerPhone: z.string().regex(/^\+[1-9]\d{7,14}$/)
    }).parse(req.body);

    // Idempotency-Key (spec 10): same key returns the same intent, never a double charge.
    // Bound to this tenant on purpose: the key is a client-supplied header, so an unbound
    // lookup would hand a caller another company's intent_reference for the crime of
    // guessing its key, and would skip creating the charge this seat actually asked for.
    const idemKey = (req.headers["idempotency-key"] as string | undefined)?.trim() || uuidv7();
    const existing = await withTenant(req.user.tid, (c) => c.query(
      "select intent_reference from payments where idempotency_key = $1 and tenant_id = $2",
      [idemKey, req.user.tid]));
    if (existing.rowCount) {
      return reply.send({ intentReference: existing.rows[0].intent_reference, idempotent: true });
    }

    const plan = await pool.query(
      "select * from plans where key = $1 and is_active = true", [body.planKey]);
    if (!plan.rowCount) throw new ApiError("VALIDATION_FAILED", "Plan unavailable", 400, [{ field: "planKey" }]);
    const p = plan.rows[0];
    if (body.seats > p.seat_limit) {
      throw new ApiError("VALIDATION_FAILED",
        `The ${p.name} plan covers up to ${p.seat_limit} seats.`, 400, [{ field: "seats" }]);
    }

    const amounts = computeAmounts(p, body.billingCycle as Cycle);
    const providerName = detectProvider(body.payerPhone);
    const intentReference = `WSH-${randomToken(12).replace(/[-_]/g, "").slice(0, 14).toUpperCase()}`;

    await withTenant(req.user.tid, async (c) => {
      // Upsert the live subscription (trial stays trial until approval flips it)
      const months = body.billingCycle === "quarterly" ? 3 : body.billingCycle === "annual" ? 12 : 1;
      const sub = await c.query(
        `update subscriptions set plan_id=$2, billing_cycle=$3, seats_licensed=$4
         where tenant_id=$1 and deleted_at is null
         returning id`, [req.user.tid, p.id, body.billingCycle, body.seats]);
      let subscriptionId = sub.rows[0]?.id;
      if (!subscriptionId) {
        const ins = await c.query(
          `insert into subscriptions (tenant_id, plan_id, billing_cycle, status, seats_licensed,
             current_period_start, current_period_end)
           values ($1,$2,$3,'pending',$4, now(), now() + make_interval(months => $5))
           returning id`, [req.user.tid, p.id, body.billingCycle, body.seats, months]);
        subscriptionId = ins.rows[0].id;
      }
      const seq = await c.query("select nextval('invoice_number_seq') as n");
      const number = `INV-${new Date().toISOString().slice(0, 4)}-${String(seq.rows[0].n).padStart(6, "0")}`;
      const inv = await c.query(
        `insert into invoices (tenant_id, subscription_id, number, billing_cycle, seats,
           amount_subtotal, vat_rate, vat_amount, amount_total, status,
           period_start, period_end, due_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'issued',
           current_date, (current_date + make_interval(months => $10))::date,
           now() + interval '7 days')
         returning id`, [req.user.tid, subscriptionId, number, body.billingCycle, body.seats,
          amounts.subtotal, amounts.vatRate, amounts.vatAmount, amounts.total, months]);
      const pay = await c.query(
        `insert into payments (tenant_id, invoice_id, provider, intent_reference,
           payer_phone_encrypted, amount, currency, status, idempotency_key)
         values ($1,$2,$3,$4,$5,$6,'TZS','pending',$7)
         returning id`, [req.user.tid, inv.rows[0].id, providerName, intentReference,
          encryptField(body.payerPhone), amounts.total, idemKey]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "payments", entityId: pay.rows[0].id,
        action: "payment.intent.created",
        after: { intentReference, plan: body.planKey, cycle: body.billingCycle,
                 seats: body.seats, total: amounts.total, provider: providerName }
      });
    });

    await getProvider().push({
      intentReference, amount: amounts.total, currency: "TZS",
      phone: body.payerPhone, description: `WAISHA ${p.name} licence`
    });

    return reply.status(201).send({
      intentReference, provider: providerName,
      subtotal: amounts.subtotal, vat: amounts.vatAmount, total: amounts.total,
      timeoutAt: new Date(Date.now() + PENDING_TIMEOUT_MINUTES * 60 * 1000).toISOString()
    });
  });

  // ---------- Status polling (countdown fallback; spec 5.2) ----------
  app.get("/payments/:ref/status", { preHandler: [requireAuth] }, async (req: any) => {
    const { ref } = req.params as { ref: string };
    // Lazy expiry: a pending payment older than the window becomes timed_out.
    // Both halves bind this tenant. The reference is the URL segment, so an unbound
    // read would price another company's licence to whoever asked, and an unbound
    // expiry — the FROM is what decides whether the definer runs — would let a
    // stranger time a payment off that is not theirs.
    await withTenant(req.user.tid, (c) => c.query(
      `select platform_auth.complete_payment($1, 'timed_out') as r
       from payments where intent_reference = $2 and tenant_id = $3 and status = 'pending'
         and requested_at < now() - make_interval(mins => $4)`,
      [ref, ref, req.user.tid, PENDING_TIMEOUT_MINUTES]));
    const current = await withTenant(req.user.tid, (c) => c.query(
      `select status, provider, amount, completed_at, invoice_id
       from payments where intent_reference = $1 and tenant_id = $2`, [ref, req.user.tid]));
    if (!current.rowCount) throw new ApiError("NOT_FOUND", "Payment not found", 404);
    const licence = await pool.query("select platform_auth.get_licence($1) as l", [req.user.tid]);
    return {
      payment: current.rows[0],
      licence: licence.rows[0].l
    };
  });

  // ---------- SANDBOX ONLY: operator simulates the customer's approval ----------
  app.post("/payments/mock/complete", async (req: any, reply) => {
    if (env.PAYMENT_PROVIDER !== "mock") throw new ApiError("NOT_FOUND", "Not found", 404);
    if (!env.PAYMENT_MOCK_KEY || req.headers["x-mock-key"] !== env.PAYMENT_MOCK_KEY) {
      throw new ApiError("FORBIDDEN", "Invalid mock key", 403);
    }
    const { intentReference, outcome } = z.object({
      intentReference: z.string().min(6),
      outcome: z.enum(["approved", "failed", "timed_out", "cancelled"])
    }).parse(req.body);
    const r = await pool.query(
      "select platform_auth.complete_payment($1,$2,null) as r", [intentReference, outcome]);
    const res = r.rows[0].r;
    if (res.status === 'ok' && res.payment_status === 'approved') {
      await pool.query(
        `insert into audit_logs (id, tenant_id, entity, entity_id, action, after)
         select $1, p.tenant_id, 'payments', p.id, 'payment.approved.mock', $2::jsonb
         from payments p where p.intent_reference = $3`,
        [uuidv7(), JSON.stringify({ via: "mock/operator", ref: intentReference }), intentReference]);
    }
    return reply.send(res);
  });

  // ---------- AzamPay webhook (dormant until PAYMENT_PROVIDER=azampay) ----------
  app.post("/payments/webhook", async (req: any, reply) => {
    if (env.PAYMENT_PROVIDER !== "azampay") throw new ApiError("NOT_FOUND", "Not found", 404);
    // VERIFY-ON-INTEGRATION: exact signature header + scheme per AzamPay docs.
    // Planned: HMAC-SHA256 over raw body with AZAMPAY_WEBHOOK_SECRET, replay
    // nonce stored in payment_webhooks.replay_nonce (unique), then
    // platform_auth.complete_payment(...) — the handler is wired and waiting.
    throw new ApiError("NOT_IMPLEMENTED", "Webhook activates with AzamPay credentials.", 501);
  });
}