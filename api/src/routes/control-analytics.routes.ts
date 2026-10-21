import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { requireControl } from "./control.routes.js";

/**
 * Control-panel analytics and the forensic audit reader (066).
 *
 * Every number here is a cross-tenant aggregate, so it can only come from a
 * SECURITY DEFINER function — a bare pool query has no app.tenant_id and RLS hands
 * back zero rows. The routes therefore do no arithmetic of their own; they bind
 * parameters, shape the payload and gate it.
 *
 * The gate is the seeded role_permissions matrix, not the role keys in the session:
 * get_control_session returns roles only, so hasLicenceRole was the whole of the
 * control panel's authorisation, and a platform_analyst could be stopped from the
 * money by nothing but a route that had never heard of them.
 */

const ANALYTICS = "control.analytics.view";
const AUDIT = "control.audit.view";
const COSTS = "control.costs.manage";

export async function controlCan(req: any, permissionKey: string): Promise<boolean> {
  const c = req.control;
  if (!c?.user_id || !c?.tenant_id) return false;
  const held = await controlHolds(req, [permissionKey]);
  return held.includes(permissionKey);
}

/**
 * One query for the whole set. The panel's navigation probe asks for a dozen keys and
 * each round trip over the pooler is the difference between a tab that opens and a
 * tab that stalls; user_roles is already indexed by user.
 */
export async function controlHolds(req: any, keys: string[]): Promise<string[]> {
  const c = req.control;
  if (!c?.user_id || !c?.tenant_id) return [];
  return withTenant(c.tenant_id, async (client) => {
    const r = await client.query(
      `select distinct rp.permission_key as key
         from user_roles ur
         join role_permissions rp on rp.role_id = ur.role_id
        where ur.user_id = $1 and rp.permission_key = any($2)
          and (ur.expires_at is null or ur.expires_at > now())`,
      [c.user_id, keys]);
    return r.rows.map((row: any) => row.key as string);
  });
}

/** Read gate. Analytics is the floor for every screen in this module. */
export async function requireControlPermission(req: any, permissionKey: string) {
  if (!(await controlCan(req, permissionKey))) {
    throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
  }
}

/**
 * pg hands a `date` back as a Date at local midnight, so JSON.stringify would render
 * it in UTC — and on a +3 machine the axis label moves to the month before. The
 * server on Render is UTC and dev is not, which is exactly the kind of difference
 * that shows up as a chart one month to the left and no error anywhere.
 */
function monthKey(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** numeric arrives as a string; the charts need numbers. */
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const MONTHS = z.coerce.number().int().min(3).max(60).default(12);

export async function controlAnalyticsRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- what may this person see? the panel builds its own navigation ----------
  app.get("/control/auth/permissions", { preHandler: [requireControl] }, async (req: any) => {
    // Every key a SCREEN in web/components/ControlNav.tsx filters on has to be probed
    // here. A duty that is missing from this list is held but never visible, so the
    // seat reads the desk as broken rather than as closed — which is how control.staff.view
    // behaved for three roles after 067 shipped it.
    const keys = ["control.view", ANALYTICS, COSTS, AUDIT,
      "control.tenants.manage", "control.licences.manage", "control.payments.manage",
      "control.plans.manage", "control.content.manage", "control.staff.manage",
      "control.staff.view", "control.subscriptions.view", "control.subscriptions.manage",
      "control.system.view",
      "control.system.manage", "control.recommendations.view",
      "control.recommendations.manage", "control.impersonate",
      "control.departments.view", "control.departments.manage",
      "control.tickets.view", "control.tickets.manage",
      "control.gateway.view", "control.gateway.manage",
      // The two-person register. Reading it and signing it are separate duties: a seat
      // that can see a ban waiting but cannot sign it is the second opinion the rule asks
      // for, and 121 seeded `decide` only onto the roles that can already manage tenants.
      "control.approvals.view", "control.approvals.decide"];
    return { roles: req.control.roles ?? [], permissions: await controlHolds(req, keys) };
  });

  // ---------- the landing numbers ----------
  app.get("/control/analytics/overview",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, ANALYTICS);
      await enforceRateLimit(`analytics:uid:${req.control.user_id}`, 120, 60);
      const { rows } = await pool.query("select platform_auth.control_overview() as o");
      return rows[0].o;
    });

  // ---------- growth ----------
  app.get("/control/analytics/growth",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, ANALYTICS);
      const { months } = z.object({ months: MONTHS }).parse(req.query ?? {});
      const { rows } = await pool.query("select * from platform_auth.control_growth($1)", [months]);
      return rows.map(r => ({
        month: monthKey(r.month),
        new_companies: r.new_companies,
        new_seekers: r.new_seekers,
        new_users: r.new_users,
        activated: r.activated,
        lapsed: r.lapsed,
        searches: r.searches
      }));
    });

  // ---------- the P&L ----------
  app.get("/control/analytics/revenue",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, ANALYTICS);
      const { months } = z.object({ months: MONTHS }).parse(req.query ?? {});
      const { rows } = await pool.query("select * from platform_auth.control_revenue($1)", [months]);
      return rows.map(r => ({
        month: monthKey(r.month),
        subscription_income: num(r.subscription_income),
        pass_income: num(r.pass_income),
        gross: num(r.gross),
        vat: num(r.vat),
        net: num(r.net),
        costs: num(r.costs),
        profit: num(r.profit),
        paid_invoices: r.paid_invoices,
        paid_passes: r.paid_passes
      }));
    });

  // ---------- the forecast ----------
  //
  // Flat rows, grouped here by metric rather than in the chart library, because the
  // fit constants (slope, r2) belong to the series and not to a point: repeating them
  // per month would let the UI read a projected point's own slope as a new fact.
  app.get("/control/analytics/forecast",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, ANALYTICS);
      const q = z.object({ months: MONTHS, horizon: z.coerce.number().int().min(1).max(24).default(6) })
        .parse(req.query ?? {});
      const { rows } = await pool.query(
        "select * from platform_auth.control_forecast($1,$2)", [q.months, q.horizon]);
      const metrics: Record<string, {
        slope: number | null; fit_r2: number | null;
        series: { month: string; actual: number | null; projected: number | null }[]
      }> = {};
      for (const r of rows) {
        const m = (metrics[r.metric] ??= {
          slope: num(r.slope), fit_r2: num(r.fit_r2), series: []
        });
        m.series.push({ month: monthKey(r.month), actual: num(r.actual), projected: num(r.projected) });
      }
      for (const m of Object.values(metrics)) m.series.sort((a, b) => a.month.localeCompare(b.month));
      return { months: q.months, horizon: q.horizon, currency: "TZS", metrics };
    });

  // ---------- the cost ledger ----------
  app.get("/control/costs",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, ANALYTICS);
      const q = z.object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional()
      }).parse(req.query ?? {});
      const { rows } = await pool.query(
        `select id, period::text as period, category, amount, currency, note, updated_at
           from platform_costs
          where ($1::date is null or period >= $1)
            and ($2::date is null or period <= $2)
          order by period desc, category`,
        [q.from ? monthKey(q.from) : null, q.to ? monthKey(q.to) : null]);
      return rows.map(r => ({ ...r, amount: num(r.amount) }));
    });

  // One write, because the month key is the row's identity: recording October's
  // hosting twice must replace the figure, not sit next to it and double-count.
  // No DELETE — a month that has been reported on keeps its numbers, and the
  // correction of a mistake is itself a change of amount, which is audited.
  app.post("/control/costs",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, COSTS);
      await enforceRateLimit(`costs:uid:${req.control.user_id}`, 60, 3600);
      const body = z.object({
        period: z.string().regex(/^\d{4}-\d{2}-01$/, "use the first day of a month"),
        category: z.enum(["infrastructure", "salaries", "marketing", "licences", "support", "other"]),
        amount: z.number().min(0).max(9_999_999_999),
        note: z.string().trim().max(280).optional()
      }).strict().parse(req.body);

      const id = uuidv7();
      // withTenant already owns the transaction: one commit for the row and its audit
      // entry, and a throw rolls both back.
      return withTenant(req.control.tenant_id, async (c) => {
        const before = await c.query(
          "select amount, note from platform_costs where period = $1 and category = $2",
          [body.period, body.category]);
        const r = await c.query(
          `insert into platform_costs (id, period, category, amount, currency, note, created_by, updated_by)
           values ($1,$2::date,$3,$4,'TZS',$5,$6,$6)
           on conflict (period, category) do update
             set amount = excluded.amount, note = excluded.note,
                 updated_by = excluded.updated_by, updated_at = now()
           returning id, period::text as period, category, amount, currency, note`,
          [id, body.period, body.category, body.amount, body.note ?? null, req.control.user_id]);
        await writeAudit(c, {
          tenantId: req.control.tenant_id, actorUserId: req.control.user_id,
          actorRole: (req.control.roles ?? [])[0] ?? null, ip: req.ip, requestId: req.requestId,
          entity: "platform_costs", entityId: r.rows[0].id,
          action: before.rowCount ? "control.costs.corrected" : "control.costs.recorded",
          before: before.rows[0] ?? null,
          after: {
            period: r.rows[0].period, category: r.rows[0].category,
            amount: r.rows[0].amount, note: r.rows[0].note
          }
        });
        return { ...r.rows[0], amount: num(r.rows[0].amount) };
      });
    });

  // ---------- the forensic trail ----------
  app.get("/control/audit",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, AUDIT);
      await enforceRateLimit(`audit:uid:${req.control.user_id}`, 120, 60);
      const q = z.object({
        tenantId: z.string().uuid().optional(),
        actorUserId: z.string().uuid().optional(),
        entity: z.string().trim().max(80).optional(),
        action: z.string().trim().max(120).optional(),
        q: z.string().trim().max(200).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100)
      }).parse(req.query ?? {});
      const { rows } = await pool.query(
        `select * from platform_auth.list_audit_for_control($1,$2,$3,$4,$5,$6,$7,$8)`,
        [q.tenantId ?? null, q.actorUserId ?? null, q.entity ?? null, q.action ?? null,
          q.q ?? null, q.from ?? null, q.to ?? null, q.limit]);
      return rows;
    });

  app.get("/control/audit/actions",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, AUDIT);
      const q = z.object({ days: z.coerce.number().int().min(1).max(730).default(90) })
        .parse(req.query ?? {});
      const { rows } = await pool.query(
        "select * from platform_auth.list_audit_actions(now() - make_interval(days => $1))",
        [q.days]);
      return rows.map(r => ({ ...r, last_seen: new Date(r.last_seen).toISOString() }));
    });

  // The register of people behind the trail (071). A forensic read is asked backwards:
  // not "what happened" but "who touched this, and how far did they reach" — and 066's
  // reader cannot answer it, because its only actor filter is a uuid the operator would
  // have to already possess. Counts and clocks only; no payload, no address, no PII.
  app.get("/control/audit/actors",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, AUDIT);
      await enforceRateLimit(`audit-actors:uid:${req.control.user_id}`, 60, 60);
      const q = z.object({
        tenantId: z.string().uuid().optional(),
        days: z.coerce.number().int().min(1).max(730).default(30),
        limit: z.coerce.number().int().min(1).max(500).default(100)
      }).parse(req.query ?? {});
      const { rows } = await pool.query(
        `select * from platform_auth.list_audit_actors_for_control(
           $1, now() - make_interval(days => $2), null, $3)`,
        [q.tenantId ?? null, q.days, q.limit]);
      return rows.map(r => ({
        ...r,
        first_seen: new Date(r.first_seen).toISOString(),
        last_seen: new Date(r.last_seen).toISOString()
      }));
    });
}
