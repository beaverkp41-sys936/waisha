import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { requireControl } from "./control.routes.js";
import { controlCan } from "./control-analytics.routes.js";

/**
 * The customer and money registers, the bundle price list (spec §8; task #104) and the
 * churn half of the advisory (task #155).
 *
 * 068 does the arithmetic. A register that crossed tenants from a route would either
 * return nothing (RLS, no app.tenant_id) or everything (the owner connection), and
 * neither of those is a number the office can be held to. So these handlers bind
 * parameters, convert numeric — which pg hands back as a string — into the numbers a
 * chart and a total line need, and gate.
 *
 * The gate is the role_permissions matrix, not the role keys in the session, for the
 * same reason 066's is: get_control_session returns roles only.
 *
 * 086 added the exit door, and it is gated on control.subscriptions.manage rather than on
 * whoever can read the register: recording that a customer is gone is an act with a reason
 * attached to it, and the seats that watch numbers are not the seats that sign them. The
 * audit row is written inside the definer, as it is on the tenants desk — one door, one
 * register, one trail, so a handler cannot record an exit without saying why.
 */

const VIEW = "control.subscriptions.view";
const MANAGE = "control.subscriptions.manage";
const ANALYTICS = "control.analytics.view";
const PRICING = "control.plans.manage";

const SUB_STATUS = ["pending", "trial", "active", "grace", "expired", "suspended", "cancelled"];
/** Exported so the SQL gate can prove the zod enum, the definer's guard and the table's
 *  CHECK are the same seven words. */
export const EXIT_REASONS = [
  "company_decision", "price", "went_dormant", "service_failure",
  "terms_violation", "payment_default", "other"
];
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

/** Params: subscription, reason, note, actor user, actor role, ip. */
export const CANCEL_SQL =
  "select platform_auth.cancel_subscription($1,$2,$3,$4,$5,$6) as r";

/** Params: days. */
export const CHURN_SQL = "select platform_auth.churn_report($1) as r";

/** Params: tenant, limit. */
export const EXITS_SQL = "select platform_auth.control_subscription_exits($1,$2) as a";

/** Params: days. 088 — package income allocated across the three offices, six lines. */
export const ALLOC_LINES_SQL = "select * from platform_auth.control_module_allocation($1)";

/** Params: days, limit. The same allocation one company at a time. */
export const ALLOC_TENANTS_SQL =
  "select * from platform_auth.control_module_allocation_tenants($1,$2)";

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

/**
 * The two lines the churn half of the advisory can raise (task #155).
 *
 * Both come from the same definer the Customers desk reads, so the advisory and the desk
 * cannot quote different numbers for the same window. The first is about the register: an
 * exit nobody recorded is a lost customer the office has not admitted to yet. The second is
 * about the clock: 008's gate reads tenants.licence_expires_at, not subscriptions.status, so
 * a company whose term has passed keeps its 'active' status forever and no status-based
 * query can see it. That is exactly why the card on the advisory used to say churn was
 * unmeasurable, and it is why this line quotes the date instead of the column.
 */
export async function churnAdvisory(days = 90) {
  const items: Array<Record<string, unknown>> = [];
  const { rows } = await pool.query(CHURN_SQL, [days]);
  const r = rows[0]?.r ?? {};
  const exits = Number(r.exits?.companies ?? 0);
  const lost = Number(r.exits?.mrr_lost ?? 0);
  const outOfTerm = Number(r.today?.out_of_term ?? 0);
  const atRisk = Number(r.today?.mrr_at_risk ?? 0);
  const topReason = (r.by_reason ?? [])[0] ?? null;

  if (exits > 0) {
    items.push({
      item_id: "churn_recorded_exits", rank: 4,
      priority: exits >= 3 ? "high" : "medium", kind: "retention",
      area: "Revenue",
      title: `${exits} customer${exits === 1 ? "" : "s"} recorded as an exit in the last ${r.window_days ?? days} days`,
      detail: "An exit is a person on the desk writing down that a company is gone and why — "
        + "the only churn figure this system can state as a fact rather than as an inference "
        + "from a date. The monthly rate they were paying is deducted from the recurring line; "
        + "what they had already paid stays on the ledger, because a refund is a different act "
        + "and the system moves no money.",
      metric: Math.round(lost), unit: "TZS monthly lost",
      action: topReason
        ? `Read Who left on the Customers desk — the commonest reason so far is "${topReason.reason_code}".`
        : "Read Who left on the Customers desk.",
      evidence: (r.by_reason ?? []).slice(0, 6).map((x: any) => `${x.reason_code}: ${x.companies}`)
    });
  }
  if (outOfTerm > 0) {
    items.push({
      item_id: "churn_out_of_term", rank: 6,
      priority: outOfTerm >= 5 ? "high" : "medium", kind: "retention",
      area: "Revenue",
      title: `${outOfTerm} customer${outOfTerm === 1 ? "" : "s"} are past their term with no exit recorded`,
      detail: "The licence gate compares tenants.licence_expires_at with now() and never "
        + "writes subscriptions.status, so a company that stopped paying sits at 'active' in the "
        + "status column while its term date runs behind it. These are not yet churn — some of "
        + "them will renew — but they are the set a renewal call is for, and until the desk "
        + "records each one as an exit or a sale, no churn rate in this system can count them.",
      metric: Math.round(atRisk), unit: "TZS monthly at risk",
      action: "Work the renewal window on the Customers desk, then record an exit for whoever "
        + "is not coming back.",
      evidence: []
    });
  }

  return {
    items,
    headline: {
      exits,
      mrr_lost: Math.round(lost),
      exit_rate_pct: r.exit_rate_pct === null || r.exit_rate_pct === undefined
        ? null : Number(r.exit_rate_pct),
      out_of_term: outOfTerm,
      mrr_at_risk: Math.round(atRisk),
      window_days: Number(r.window_days ?? days)
    }
  };
}

/**
 * What "a unit of work" means in 088's allocation, in the words the desk prints.
 *
 * An allocation weighted by work is only honest if the reader knows what was counted, so the
 * definition travels with the numbers instead of living in a migration comment nobody opens.
 */
export const ALLOCATION_UNITS = [
  "transport — trips, bookings accepted, and invoices tied to a trip",
  "cfa — cargo files and invoices that are not tied to a trip",
  "office — office tasks and payroll runs that were issued"
];

/**
 * The two lines the allocation half of the advisory can raise (task #155).
 *
 * 088 replaced the card that said revenue per module cannot be measured with a number that is
 * an allocation, so what is left to report is where that allocation had to lean on a
 * fall-back: money split evenly because a company recorded no work, and money that no
 * subscription explains at all. Both are read from the same definer the Revenue desk draws,
 * so the advisory and the desk cannot quote different figures for the same window.
 */
export async function moduleAllocationAdvisory(days = 90) {
  const items: Array<Record<string, unknown>> = [];
  const { rows } = await pool.query(ALLOC_LINES_SQL, [days]);
  const line = (m: string) => rows.find(r => r.module === m) ?? {};
  const windowDays = Number(rows[0]?.window_days ?? days);
  const total = Number(rows[0]?.platform_income ?? 0);
  const offices = ["transport", "cfa", "office"];
  const evenIncome = offices.reduce((s, m) => s + Number(line(m).even_income ?? 0), 0);
  const usageIncome = offices.reduce((s, m) => s + Number(line(m).usage_income ?? 0), 0);
  const unattributed = Number(line("unattributed").income ?? 0);
  const unattributedCustomers = Number(line("unattributed").customers ?? 0);

  if (evenIncome > 0) {
    items.push({
      item_id: "allocation_even_fall_back", rank: 5,
      priority: total > 0 && evenIncome / total >= 0.2 ? "medium" : "low", kind: "revenue",
      area: "Revenue",
      title: `${fmt(evenIncome)} TZS of package income was split evenly because no bought `
        + `office recorded any work`,
      detail: "088 splits a bundle across the offices it sells in proportion to the work each "
        + "one recorded in the window. A company that recorded none still has to be placed "
        + "somewhere, so its money is shared evenly between the offices it bought and the row "
        + "is labelled 'even'. That part of each column is a convention, not evidence — the "
        + "rest is usage.",
      metric: Math.round(evenIncome), unit: "TZS allocated by convention",
      action: "Read Allocation on the Revenue desk: every company in the even column is one "
        + "whose offices recorded nothing, which is also a retention conversation.",
      evidence: offices.map(m => `${m}: ${fmt(Number(line(m).even_income ?? 0))}`)
    });
  }
  if (unattributed > 0) {
    items.push({
      item_id: "allocation_unattributed", rank: 5,
      priority: "medium", kind: "revenue", area: "Revenue",
      title: `${fmt(unattributed)} TZS was paid with no subscription behind the invoice`,
      detail: "A paid invoice is money the window holds, but with no subscription it has no "
        + "package, so nothing says which office it belongs to. 088 keeps it as its own line "
        + "instead of dropping it or guessing: it is in the total and in no office. Every "
        + "rupee of it is a register that has not been finished.",
      metric: Math.round(unattributed), unit: "TZS with no offering",
      action: `Open the Allocation panel's company list and look for the ${unattributedCustomers} `
        + "company rows basis 'no subscription', then link each payment to the subscription it "
        + "was made against.",
      evidence: []
    });
  }

  return {
    items,
    headline: {
      window_days: windowDays,
      income: Math.round(total),
      usage_income: Math.round(usageIncome),
      even_income: Math.round(evenIncome),
      unattributed_income: Math.round(unattributed),
      currency: "TZS"
    }
  };
}

const fmt = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 2 });

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
      // The desk renders the exit control only when this is true. It is read from the same
      // matrix the POST checks, so a seat can never be shown a door it is about to be
      // refused at.
      can_manage: await controlCan(req, MANAGE),
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

  // ---------- record an exit ----------
  //
  // The reason and the note come from the person at the desk; the before-image comes from
  // the database, priced the way the register prices. This handler cannot invent a lost
  // month's revenue, and the definer refuses a second exit on a row already cancelled, so
  // the register cannot be padded by a double click.
  app.post("/control/subscriptions/:id/cancel", { preHandler: [requireControl] }, async (req: any) => {
    if (!(await controlCan(req, MANAGE))) {
      throw new ApiError("FORBIDDEN", "Only the seats that sell a subscription may end one.", 403);
    }
    await enforceRateLimit(`cancel:uid:${req.control.user_id}`, 12, 3600);
    const { id } = req.params as { id: string };
    const body = z.object({
      reasonCode: z.enum(EXIT_REASONS as [string, ...string[]]),
      // The sentence that explains this exit in a year. A floor, not just a ceiling:
      // "left" is not a reason, and 8 characters is the cheapest way to say that in a
      // schema instead of in a policy nobody reads.
      note: z.string().trim().min(8).max(600)
    }).strict().parse(req.body);

    const { rows } = await pool.query(CANCEL_SQL, [
      id, body.reasonCode, body.note, req.control.user_id,
      (req.control.roles ?? [])[0] ?? null, req.ip
    ]);
    const res = rows[0]?.r as { status?: string; message?: string } | undefined;
    if (!res) throw new ApiError("UPSTREAM_ERROR", "The exit could not be recorded.", 502);
    if (res.status !== "ok") {
      if (res.status === "not_found") {
        throw new ApiError("NOT_FOUND", `No subscription ${id} on the register.`, 404);
      }
      if (res.status === "conflict") {
        throw new ApiError("CONFLICT", res.message ?? "That exit is already recorded.", 409);
      }
      throw new ApiError("VALIDATION_FAILED", res.message ?? "The exit was refused.", 400);
    }
    return res;
  });

  // ---------- who left, and what the base looks like today ----------
  app.get("/control/churn", { preHandler: [requireControl] }, async (req: any) => {
    if (!(await controlCan(req, VIEW)) && !(await controlCan(req, ANALYTICS))) {
      throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
    }
    await enforceRateLimit(`churn:uid:${req.control.user_id}`, 60, 60);
    const q = z.object({
      days: z.coerce.number().int().min(7).max(730).default(90)
    }).parse(req.query ?? {});
    const { rows } = await pool.query(CHURN_SQL, [q.days]);
    const r = rows[0]?.r ?? {};
    // The definer hands back jsonb, so its numerics are already JSON numbers; only the
    // missing-figure cases need a decision, and the desk says "no exits recorded" when the
    // rate has no denominator rather than printing 0%.
    return {
      ...r,
      exits: {
        companies: count(r.exits?.companies),
        mrr_lost: money(r.exits?.mrr_lost),
        seats_lost: count(r.exits?.seats_lost),
        paid_before_exit: money(r.exits?.paid_before_exit),
        avg_tenure_days: r.exits?.avg_tenure_days === null || r.exits?.avg_tenure_days === undefined
          ? null : count(r.exits.avg_tenure_days),
        still_cancelled: count(r.exits?.still_cancelled),
        came_back: count(r.exits?.came_back),
        currency: r.exits?.currency ?? "TZS"
      },
      exit_rate_pct: r.exit_rate_pct === null || r.exit_rate_pct === undefined
        ? null : Number(r.exit_rate_pct),
      sold_before_window: count(r.sold_before_window),
      by_reason: (r.by_reason ?? []).map((x: any) => ({
        reason_code: x.reason_code,
        companies: count(x.companies),
        mrr_lost: money(x.mrr_lost)
      })),
      by_month: (r.by_month ?? []).map((x: any) => ({
        month: x.month,
        cancellations: count(x.cancellations),
        out_of_term: count(x.out_of_term),
        mrr_lost: money(x.mrr_lost)
      })),
      today: {
        customers: count(r.today?.customers),
        live: count(r.today?.live),
        out_of_term: count(r.today?.out_of_term),
        cancelled: count(r.today?.cancelled),
        blocked: count(r.today?.blocked),
        closed: count(r.today?.closed),
        mrr_live: money(r.today?.mrr_live),
        mrr_at_risk: money(r.today?.mrr_at_risk),
        seats_live: count(r.today?.seats_live),
        currency: r.today?.currency ?? "TZS"
      },
      recent: (r.recent ?? []).map((x: any) => ({
        ...x,
        monthly_equivalent: money(x.monthly_equivalent),
        collected: money(x.collected)
      }))
    };
  });

  // Every exit one company has, newest first — the sentence a renewal conversation needs
  // before it is had ("you left us in March, and said it was the price").
  app.get("/control/churn/exits/:tenantId", { preHandler: [requireControl] }, async (req: any) => {
    if (!(await controlCan(req, VIEW)) && !(await controlCan(req, MANAGE))) {
      throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
    }
    const { tenantId } = req.params as { tenantId: string };
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(20)
    }).parse(req.query ?? {});
    const { rows } = await pool.query(EXITS_SQL, [tenantId, q.limit]);
    return {
      tenant_id: tenantId,
      exits: (rows[0]?.a ?? []).map((x: any) => ({
        ...x, monthly_equivalent: money(x.monthly_equivalent), collected: money(x.collected)
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

  // ---------- how the money falls across the offices ----------
  //
  // An allocation, not a measurement: no table holds a price per office, so 088 splits a
  // bundle across the offices it sells in proportion to the work each one recorded, keeps the
  // ladder rung whole, keeps search passes beside it, and keeps money with no subscription on
  // a line of its own. The response says so in `basis` on every line and prints the unit
  // definition, because a split that reads like a measurement is the failure this panel has
  // to prevent.
  app.get("/control/revenue/allocation", { preHandler: [requireControl] }, async (req: any) => {
    if (!(await controlCan(req, ANALYTICS)) && !(await controlCan(req, VIEW))) {
      throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
    }
    await enforceRateLimit(`alloc:uid:${req.control.user_id}`, 60, 60);
    const q = z.object({ days: z.coerce.number().int().min(7).max(730).default(90) })
      .parse(req.query ?? {});
    const { rows } = await pool.query(ALLOC_LINES_SQL, [q.days]);
    return {
      days: Number(rows[0]?.window_days ?? q.days),
      currency: "TZS",
      allocated: true,
      unit_definition: ALLOCATION_UNITS,
      platform_income: money(rows[0]?.platform_income),
      lines: rows.map(r => ({
        module: r.module,
        module_label: r.module_label,
        basis: r.basis,
        customers: count(r.customers),
        units: count(r.units),
        income: money(r.income),
        share: money(r.share),
        usage_income: money(r.usage_income),
        even_income: money(r.even_income)
      }))
    };
  });

  /** Params for the per-company reader: days, limit. */
  app.get("/control/revenue/allocation/companies",
    { preHandler: [requireControl] }, async (req: any) => {
      if (!(await controlCan(req, ANALYTICS)) && !(await controlCan(req, VIEW))) {
        throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
      }
      await enforceRateLimit(`allocco:uid:${req.control.user_id}`, 60, 60);
      const q = z.object({
        days: z.coerce.number().int().min(7).max(730).default(90),
        limit: z.coerce.number().int().min(1).max(400).default(200)
      }).parse(req.query ?? {});
      const { rows } = await pool.query(ALLOC_TENANTS_SQL, [q.days, q.limit]);
      return {
        days: Number(rows[0]?.window_days ?? q.days),
        currency: "TZS",
        total: count(rows[0]?.matched),
        total_income: money(rows[0]?.matched_income),
        companies: rows.map(r => ({
          tenant_id: r.tenant_id,
          company_name: r.company_name,
          company_type: r.company_type,
          offering: r.offering,
          offering_name: r.offering_name,
          services: r.services ?? [],
          basis: r.basis,
          invoices_paid: count(r.invoices_paid),
          income: money(r.income),
          transport_units: count(r.transport_units),
          cfa_units: count(r.cfa_units),
          office_units: count(r.office_units),
          transport_income: money(r.transport_income),
          cfa_income: money(r.cfa_income),
          office_income: money(r.office_income),
          transport_share: money(r.transport_share),
          cfa_share: money(r.cfa_share),
          office_share: money(r.office_share)
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
