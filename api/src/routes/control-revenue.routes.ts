import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { requireControl } from "./control.routes.js";
import { controlCan } from "./control-analytics.routes.js";

/**
 * The customer and money registers, and the bundle price list (spec §8; task #104).
 *
 * 068 does the arithmetic. A register that crossed tenants from a route would either
 * return nothing (RLS, no app.tenant_id) or everything (the owner connection), and
 * neither of those is a number the office can be held to. So these handlers bind
 * parameters, convert numeric — which pg hands back as a string — into the numbers a
 * chart and a total line need, and gate.
 *
 * The gate is the role_permissions matrix, not the role keys in the session, for the
 * same reason 066's is: get_control_session returns roles only.
 */

const VIEW = "control.subscriptions.view";
const ANALYTICS = "control.analytics.view";
const PRICING = "control.plans.manage";

const SUB_STATUS = ["pending", "trial", "active", "grace", "expired", "suspended", "cancelled"];
const LEDGER_STATUS = [
  "draft", "issued", "paid", "void", "refunded",
  "awaiting_verification", "live", "rejected", "expired", "cancelled"
];
const CYCLES = ["monthly", "quarterly", "annual"];
const SOURCES = ["subscription", "search_pass"];

// ---------- statements (run verbatim by verify-control-revenue-sql.ts) ----------

/** Params: status, cycle, offering, search, dueWithinDays, limit. */
export const REGISTER_SQL =
  "select * from platform_auth.control_subscription_register($1,$2,$3,$4,$5,$6)";

/** Params: source, status, search, from, to, limit. */
export const LEDGER_SQL =
  "select * from platform_auth.control_payment_ledger($1,$2,$3,$4,$5,$6)";

/** Params: days. */
export const MIX_SQL = "select * from platform_auth.control_revenue_mix($1)";

export const GROUPS_SQL = `
  select id, key, name, description, services, seat_limit,
         price_monthly, price_quarterly, price_annual, currency, sort, is_active, updated_at
    from service_groups
   order by sort, key`;

/** The same row by its key, for the before-image in the audit entry. Params: key. */
export const GROUP_BY_KEY_SQL = `
  select id, key, name, description, services, seat_limit,
         price_monthly, price_quarterly, price_annual, currency, sort, is_active, updated_at
    from service_groups
   where key = $1`;

/** Params: key, name, seatLimit, monthly, quarterly, annual, sort, isActive. */
export const GROUP_UPDATE_SQL = `
  update service_groups set
    name = coalesce($2, name),
    description = coalesce($3, description),
    seat_limit = coalesce($4, seat_limit),
    price_monthly = coalesce($5, price_monthly),
    price_quarterly = coalesce($6, price_quarterly),
    price_annual = coalesce($7, price_annual),
    sort = coalesce($8, sort),
    is_active = coalesce($9, is_active),
    updated_by = $10,
    updated_at = now()
  where key = $1
  returning id, key, name, description, services, seat_limit,
            price_monthly, price_quarterly, price_annual, currency, sort, is_active, updated_at`;

const money = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const count = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function controlRevenueRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- the customer register ----------
  app.get("/control/subscriptions", { preHandler: [requireControl] }, async (req: any) => {
    if (!(await controlCan(req, VIEW)) && !(await controlCan(req, ANALYTICS))) {
      throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
    }
    await enforceRateLimit(`register:uid:${req.control.user_id}`, 120, 60);
    const q = z.object({
      status: z.enum(SUB_STATUS as [string, ...string[]]).optional(),
      cycle: z.enum(CYCLES as [string, ...string[]]).optional(),
      // A bundle key, a plan key, or one of the two words that split the register by
      // how the customer was sold rather than by what they were sold.
      offering: z.string().trim().max(40).optional(),
      q: z.string().trim().max(80).optional(),
      dueWithin: z.coerce.number().int().min(1).max(365).optional(),
      limit: z.coerce.number().int().min(1).max(400).default(200)
    }).parse(req.query ?? {});

    const { rows } = await pool.query(REGISTER_SQL,
      [q.status ?? null, q.cycle ?? null, q.offering ?? null, q.q ?? null,
        q.dueWithin ?? null, q.limit]);

    return {
      total: count(rows[0]?.matched),
      mrr: money(rows[0]?.matched_mrr),
      currency: "TZS",
      companies: rows.map(r => ({
        tenant_id: r.tenant_id,
        company_name: r.company_name,
        company_type: r.company_type,
        company_status: r.company_status,
        subscription_id: r.subscription_id,
        subscription_status: r.subscription_status,
        billing_cycle: r.billing_cycle,
        seats_licensed: count(r.seats_licensed),
        auto_renew: r.auto_renew,
        offering: r.offering,
        offering_name: r.offering_name,
        offering_kind: r.offering_kind,
        services: r.services ?? [],
        monthly_equivalent: money(r.monthly_equivalent),
        collected: money(r.collected),
        invoices_paid: count(r.invoices_paid),
        period_start: r.period_start,
        period_end: r.period_end,
        days_to_renewal: r.days_to_renewal === null ? null : count(r.days_to_renewal),
        licence_expires_at: r.licence_expires_at,
        grace_ends_at: r.grace_ends_at,
        trial_ends_at: r.trial_ends_at,
        signed_up_at: r.signed_up_at
      }))
    };
  });

  // ---------- the money ledger ----------
  app.get("/control/payments", { preHandler: [requireControl] }, async (req: any) => {
    if (!(await controlCan(req, VIEW))) {
      throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
    }
    await enforceRateLimit(`ledger:uid:${req.control.user_id}`, 120, 60);
    const q = z.object({
      source: z.enum(SOURCES as [string, ...string[]]).optional(),
      status: z.enum(LEDGER_STATUS as [string, ...string[]]).optional(),
      q: z.string().trim().max(80).optional(),
      // Dates, not timestamps: the ledger's own window is judged on the calendar day
      // in Dar, and sending a timestamp invites the server's zone back in.
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.coerce.number().int().min(1).max(400).default(200)
    }).parse(req.query ?? {});

    const { rows } = await pool.query(LEDGER_SQL,
      [q.source ?? null, q.status ?? null, q.q ?? null, q.from ?? null, q.to ?? null, q.limit]);

    return {
      total: count(rows[0]?.matched),
      income: money(rows[0]?.matched_income),
      currency: "TZS",
      entries: rows.map(r => ({
        source: r.source,
        payment_id: r.payment_id,
        reference: r.reference,
        payer_name: r.payer_name,
        payer_kind: r.payer_kind,
        detail: r.detail,
        channel: r.channel,
        amount: money(r.amount),
        vat: money(r.vat),
        currency: r.currency,
        status: r.status,
        recorded_at: r.recorded_at,
        money_at: r.money_at,
        period_start: r.period_start,
        period_end: r.period_end,
        note: r.note
      }))
    };
  });

  // ---------- what is selling ----------
  app.get("/control/revenue/mix", { preHandler: [requireControl] }, async (req: any) => {
    if (!(await controlCan(req, ANALYTICS)) && !(await controlCan(req, VIEW))) {
      throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
    }
    const q = z.object({ days: z.coerce.number().int().min(7).max(730).default(90) })
      .parse(req.query ?? {});
    const { rows } = await pool.query(MIX_SQL, [q.days]);
    return {
      days: q.days,
      currency: "TZS",
      offerings: rows.map(r => ({
        offering: r.offering,
        offering_name: r.offering_name,
        offering_kind: r.offering_kind,
        customers: count(r.customers),
        invoices_paid: count(r.invoices_paid),
        income: money(r.income),
        share: money(r.share)
      }))
    };
  });

  // ---------- the bundle price list ----------
  //
  // Read on the analytics key because every screen that shows revenue shows the ladder
  // beside it; written only on control.plans.manage, which 005 gave to super_admin and
  // billing_admin. service_groups is platform-owned reference data with an RLS policy
  // that admits app_runtime (060), so this is the same door the plans editor uses.
  app.get("/control/service-groups", { preHandler: [requireControl] }, async (req: any) => {
    if (!(await controlCan(req, ANALYTICS)) && !(await controlCan(req, PRICING))) {
      throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
    }
    const { rows } = await pool.query(GROUPS_SQL);
    return rows.map(r => ({
      ...r,
      price_monthly: money(r.price_monthly),
      price_quarterly: money(r.price_quarterly),
      price_annual: money(r.price_annual)
    }));
  });

  const price = z.number().nonnegative().max(9_999_999_999).optional();

  app.put("/control/service-groups/:key", { preHandler: [requireControl] }, async (req: any) => {
    if (!(await controlCan(req, PRICING))) {
      throw new ApiError("FORBIDDEN", "Only the pricing desk may change a package price.", 403);
    }
    await enforceRateLimit(`bundles:uid:${req.control.user_id}`, 60, 3600);
    const { key } = req.params as { key: string };
    const body = z.object({
      name: z.string().trim().min(2).max(60).optional(),
      description: z.string().trim().max(400).optional(),
      seatLimit: z.number().int().min(1).max(1000).optional(),
      priceMonthly: price,
      priceQuarterly: price,
      priceAnnual: price,
      sort: z.number().int().min(0).max(99).optional(),
      isActive: z.boolean().optional()
    }).parse(req.body);

    return withTenant(req.control.tenant_id, async (c) => {
      const was = await c.query(GROUP_BY_KEY_SQL, [key]);
      if (!was.rows.length) {
        throw new ApiError("NOT_FOUND", "No such WAISHA package.", 404);
      }
      const after = await c.query(GROUP_UPDATE_SQL, [
        key, body.name ?? null, body.description ?? null, body.seatLimit ?? null,
        body.priceMonthly ?? null, body.priceQuarterly ?? null, body.priceAnnual ?? null,
        body.sort ?? null, body.isActive ?? null, req.control.user_id]);
      const row = after.rows[0];
      await writeAudit(c, {
        tenantId: req.control.tenant_id, actorUserId: req.control.user_id,
        actorRole: (req.control.roles ?? [])[0] ?? null, ip: req.ip, requestId: req.requestId,
        entity: "service_groups", entityId: row.id,
        action: "control.service_groups.updated",
        before: {
          name: was.rows[0].name, seat_limit: was.rows[0].seat_limit,
          price_monthly: was.rows[0].price_monthly, price_quarterly: was.rows[0].price_quarterly,
          price_annual: was.rows[0].price_annual, is_active: was.rows[0].is_active
        },
        after: {
          name: row.name, seat_limit: row.seat_limit,
          price_monthly: row.price_monthly, price_quarterly: row.price_quarterly,
          price_annual: row.price_annual, is_active: row.is_active
        }
      });
      return {
        ...row,
        price_monthly: money(row.price_monthly),
        price_quarterly: money(row.price_quarterly),
        price_annual: money(row.price_annual)
      };
    });
  });
}
