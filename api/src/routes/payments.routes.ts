import { Readable } from "node:stream";
import { createHmac, timingSafeEqual } from "node:crypto";
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
import { getProvider, loadActiveGateway, type ActiveGateway } from "../payments/registry.js";
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

    // The push leaves the building after the charge is written, so a network that refuses it
    // must not leave a row that reads "pending" forever: the customer was never prompted, and a
    // countdown on their screen would be a lie. The payment is closed as failed and the reason
    // is named — the same way every other outbound call in this API now reports itself.
    try {
      await (await getProvider()).push({
        intentReference, amount: amounts.total, currency: "TZS",
        phone: body.payerPhone, description: `WAISHA ${p.name} licence`
      });
    } catch (e) {
      const detail = e instanceof ApiError ? e.code : "GATEWAY_PUSH_REFUSED";
      const reason = String((e as Error)?.message ?? e).slice(0, 300);
      // The third argument of `complete_payment` is the network's transaction id, and there was
      // no transaction — so it stays null and the reason goes to `raw_response`, which is where
      // an answer from the network belongs. A failure string in the txn column reads as a
      // settlement reference to everybody who looks at the register afterwards.
      await pool.query("select platform_auth.complete_payment($1,'failed',null) from payments "
        + "where intent_reference = $1 and tenant_id = $2 and status = 'pending'",
        [intentReference, req.user.tid]);
      await pool.query(
        `update payments set raw_response = $2::jsonb
          where intent_reference = $1 and tenant_id = $3`,
        [intentReference, JSON.stringify({ push_refused: detail, reason, at: new Date().toISOString() }),
         req.user.tid]);
      throw new ApiError(detail,
        "The payment network did not accept this charge, so nothing is on its way to your phone. "
        + "Your company is not being billed for it — try again, or tell the platform office if "
        + "it happens twice.", 502);
    }

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
    // The door is shut by the register, not by an environment variable: the moment a real rail
    // is switched on at the desk, this route stops answering, because a way to mark a payment
    // paid without paying is not a thing that may exist alongside a live gateway.
    const live = await loadActiveGateway();
    if (live || env.PAYMENT_PROVIDER !== "mock") {
      throw new ApiError("NOT_FOUND", "Not found", 404);
    }
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

  // ---------- The provider's answer, whenever it arrives ----------
  //
  // This is the half that makes "activate it and the system works" true. A push only starts a
  // payment: the customer stands at their phone for ten seconds, or cancels, or the network
  // drops it, and only the provider knows which. Without a door that can close a charge, an
  // activated gateway would leave every company stuck on `pending` until the ten-minute lazy
  // expiry timed it out — money collected and a licence still locked.
  //
  // **The signature is HMAC-SHA256 over the raw bytes of the body**, sent as
  // `x-waisha-signature: sha256=<hex>`, keyed by the webhook secret filed for whichever rail is
  // live. Raw bytes rather than the re-serialised object because that is the only thing both
  // sides can agree on — a JSON round-trip reorders keys and changes number formatting, and a
  // verification that fails for that reason looks exactly like an attack. `preParsing` below is
  // what keeps those bytes: Fastify hands routes a parsed object and throws the body away.
  //
  // A real network will very likely sign differently — its own header, sometimes a different
  // scheme — and that is an adapter change, not a redesign. What is fixed here is the three
  // things that must not be negotiable: an unsigned call completes nothing, a repeated call
  // completes nothing twice, and every attempt is written down whether or not it was accepted.
  app.post("/payments/webhook", {
    preParsing: async (req: any, _reply, payload) => {
      const chunks: Buffer[] = [];
      for await (const c of payload) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
      req.rawBody = Buffer.concat(chunks);
      // Capped before it is ever parsed: this door is open to the internet by design, and the
      // body is held in memory twice — once as bytes, once as an object.
      if (req.rawBody.length > 64 * 1024) {
        throw new ApiError("VALIDATION_FAILED", "Payload too large", 413);
      }
      return Readable.from([req.rawBody]);
    }
  }, async (req: any, reply) => {
    await enforceRateLimit(`webhook:ip:${req.ip}`, 120, 60);
    const gateway = await loadActiveGateway();
    // No rail, no secret: nothing could verify a call, so nothing is listening. 404 rather than
    // 401 because a closed door should not advertise that knocking harder is allowed.
    if (!gateway?.webhookSecret) throw new ApiError("NOT_FOUND", "Not found", 404);

    const raw: Buffer = req.rawBody ?? Buffer.alloc(0);
    const header = String(req.headers["x-waisha-signature"] ?? "");
    const expected = "sha256=" + createHmac("sha256", gateway.webhookSecret).update(raw).digest("hex");
    const signatureValid = header.length === expected.length
      && timingSafeEqual(Buffer.from(header), Buffer.from(expected));

    const parsed = z.object({
      reference: z.string().min(6).max(64),
      outcome: z.enum(["approved", "failed", "timed_out", "cancelled"]),
      nonce: z.string().min(6).max(128).optional(),
      event: z.string().max(48).optional()
    }).safeParse(req.body);

    // One writer for the ledger, and it is called on every path out of this route — including
    // the two refusals. A provider that keeps retrying a payload the platform cannot read is a
    // support conversation, and this table is the only place that conversation can be had. The
    // insert is the last statement rather than the first because the ledger has no UPDATE
    // policy: the row is written once, with the outcome in it.
    const record = async (eventType: string, payload: unknown, nonce: string | null,
                          error: string | null, processed: boolean) => {
      await pool.query(
        `insert into payment_webhooks (provider, event_type, signature_valid, replay_nonce,
             payload, processed_at, processing_error)
         values ($1,$2,$3,$4,$5::jsonb, case when $6 then now() else null end, $7)
         on conflict (replay_nonce) do nothing`,
        [gateway.providerKey, eventType, signatureValid, nonce, JSON.stringify(payload),
         processed, error]);
    };

    if (!signatureValid) {
      await record("rejected", { reason: "signature does not match" }, null, "signature rejected", false);
      throw new ApiError("WEBHOOK_SIGNATURE", "Signature does not match this gateway.", 401);
    }
    if (!parsed.success) {
      await record("unparsed", { unreadable: true }, null, "payload unreadable", false);
      throw new ApiError("VALIDATION_FAILED", "Payload does not describe a payment outcome.", 400);
    }

    const { reference, outcome } = parsed.data;
    // Replay, checked before anything is touched. `payment_webhooks.replay_nonce` is unique, so
    // this read is not the guard — it is the fast path. Two deliveries of one nonce arriving
    // together both get through here, and the definer below is what makes the second one cost
    // nothing: `complete_payment` answers `already_final` for a payment it has already closed.
    if (parsed.data.nonce) {
      const seen = await pool.query("select 1 from payment_webhooks where replay_nonce = $1",
        [parsed.data.nonce]);
      if (seen.rowCount) return reply.send({ status: "duplicate" });
    }

    let result: any = null;
    let failure: string | null = null;
    try {
      const r = await pool.query("select platform_auth.complete_payment($1,$2,null) as r",
        [reference, outcome]);
      result = r.rows[0].r;
      if (result?.status === "ok" && result.payment_status === "approved") {
        await pool.query(
          `insert into audit_logs (id, tenant_id, entity, entity_id, action, after)
           select $1, p.tenant_id, 'payments', p.id, 'payment.approved.webhook', $2::jsonb
             from payments p where p.intent_reference = $3`,
          [uuidv7(), JSON.stringify({ via: "webhook", provider: gateway.providerKey, reference }), reference]);
      }
    } catch (e) {
      failure = String((e as Error)?.message ?? e).slice(0, 300);
    }

    await record(parsed.data.event ?? outcome, parsed.data, parsed.data.nonce ?? null, failure, !failure);

    if (failure) {
      throw new ApiError("WEBHOOK_PROCESSING_FAILED",
        "The outcome was received but the charge could not be closed. The platform office has "
        + "been told.", 500);
    }
    return reply.send({ status: "processed", result });
  });
}