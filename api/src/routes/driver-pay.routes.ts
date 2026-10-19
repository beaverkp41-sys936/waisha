/**
 * Driver pay — what a leg earns, and where it is paid from (task #173).
 *
 * Two questions this module answers and nothing else did: what does this driver get for a
 * trip, and what has their driving actually earned that nobody has paid yet. The first is an
 * agreement (`driver_pay_terms`, 094), the second is a register (`trip_pay_entries`) that the
 * database itself writes when a trip becomes completed. 095 carries the register into the
 * payroll line, so the money leaves through the salary run and nothing here pays anybody by
 * hand.
 *
 * The desk therefore has exactly one thing to do in here: say what the arrangement is, name
 * the roster seat it is paid into, and read the register for legs that have not been priced
 * because the arrangement was missing. Re-pricing is offered rather than assumed, because a
 * rate typed after the fact should not silently rewrite what a driver was owed last month —
 * the clerk presses it, and the audit says they did.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const BASES = ["per_trip", "per_km", "per_tonne", "percent_of_freight", "salary_only"] as const;

const BASIS_LABELS: Record<(typeof BASES)[number], string> = {
  per_trip: "a flat sum for the trip",
  per_km: "per kilometre on the route",
  per_tonne: "per tonne actually carried",
  percent_of_freight: "a share of what the trip charged",
  salary_only: "salary only — driving earns nothing extra"
};

const termsSchema = z.object({
  basis: z.enum(BASES),
  rate: z.number().nonnegative().max(100_000_000).nullish(),
  employeeId: z.string().uuid().nullable().optional(),
  note: z.string().trim().max(500).nullable().optional()
}).strict();

const accrueSchema = z.object({
  tripId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  limit: z.number().int().min(1).max(500).default(200)
}).strict();

/** The money columns are read as text: a numeric(14,2) through JSON is a float story. */
export const TERMS_SELECT_SQL = `
  with entries as (
    select driver_id,
           count(*) filter (where paid_run_id is null)::int as unpaid_count,
           coalesce(sum(amount) filter (where paid_run_id is null), 0)::numeric(14,2)::text as unpaid_total,
           count(*) filter (where paid_run_id is null and employee_id is null)::int as unlinked_count,
           count(*)::int as entry_count,
           coalesce(sum(amount), 0)::numeric(14,2)::text as earned_total
      from trip_pay_entries
     where tenant_id = $1 group by driver_id
  ),
  unpriced as (
    select t.driver_id, count(*)::int as n
      from trips t
      left join trip_pay_entries e on e.trip_id = t.id and e.driver_id = t.driver_id
     where t.tenant_id = $1
       and t.status = 'completed' and t.deleted_at is null and t.driver_id is not null
       and e.id is null
     group by t.driver_id
  )
  select d.id as driver_id, d.full_name as driver_name, d.status as driver_status,
         d.licence_class, d.assigned_vessel_id,
         p.id as terms_id, p.basis, p.rate::text as rate, p.currency, p.note,
         p.employee_id, e.full_name as employee_name, e.job_title as employee_job,
         e.status as employee_status,
         p.updated_at as terms_updated_at,
         coalesce(en.unpaid_count, 0)::int as unpaid_count,
         coalesce(en.unpaid_total, '0.00') as unpaid_total,
         coalesce(en.unlinked_count, 0)::int as unlinked_count,
         coalesce(en.entry_count, 0)::int as entry_count,
         coalesce(en.earned_total, '0.00') as earned_total,
         coalesce(up.n, 0)::int as unpriced_trips
    from drivers d
    left join driver_pay_terms p on p.driver_id = d.id and p.tenant_id = $1 and p.deleted_at is null
    left join employees e on e.id = p.employee_id and e.tenant_id = $1
    left join entries en on en.driver_id = d.id
    left join unpriced up on up.driver_id = d.id
   where d.tenant_id = $1 and d.deleted_at is null`;

export const REGISTER_SELECT_SQL = `
  select e.id, e.trip_id, t.reference as trip_reference, t.status as trip_status,
         t.distance_km, to_char(coalesce(t.actual_arrival, t.created_at) at time zone 'Africa/Dar_es_Salaam','YYYY-MM-DD') as trip_on,
         e.driver_id, d.full_name as driver_name,
         e.employee_id, coalesce(emp.full_name, '— not on the roster —') as employee_name,
         e.basis, e.rate::text as rate, e.quantity::text as quantity,
         e.amount::text as amount, e.currency,
         to_char(e.earned_on, 'YYYY-MM-DD') as earned_on,
         e.paid_run_id, r.period::text as paid_period, r.status as paid_run_status,
         v.plate_number, v.name as vessel_name,
         e.note, e.created_at, e.updated_at
    from trip_pay_entries e
    join trips t on t.id = e.trip_id
    join drivers d on d.id = e.driver_id
    left join employees emp on emp.id = e.employee_id
    left join payroll_runs r on r.id = e.paid_run_id
    left join vessels v on v.id = t.vessel_id`;

/** The whole company's ledger state, independent of whatever window the desk filtered to. */
export const REGISTER_TOTALS_SQL = `
  select count(*) filter (where paid_run_id is null)::int as unpaid_count,
         coalesce(sum(amount) filter (where paid_run_id is null), 0)::numeric(14,2)::text as unpaid_total,
         count(*) filter (where paid_run_id is null and employee_id is null)::int as unlinked_count,
         coalesce(sum(amount) filter (where paid_run_id is null and employee_id is null), 0)::numeric(14,2)::text as unlinked_total,
         count(*) filter (where paid_run_id is not null)::int as claimed_count,
         coalesce(sum(amount) filter (where paid_run_id is not null), 0)::numeric(14,2)::text as claimed_total
    from trip_pay_entries
   where tenant_id = $1`;

/**
 * Legs that happened and were never priced. Each reason is something the desk can act on,
 * and "missing_entry" is the one the re-price button fixes.
 */
export const REGISTER_GAPS_SQL = `
  select case when t.driver_id is null then 'no_driver'
              when p.driver_id is null then 'no_terms'
              when p.basis = 'salary_only' then 'salary_only'
              when p.employee_id is null then 'no_roster_seat'
              else 'missing_entry' end as reason,
         count(*)::int as trips,
         coalesce(sum(coalesce(t.distance_km, 0)), 0)::int as km
    from trips t
    left join driver_pay_terms p on p.driver_id = t.driver_id and p.tenant_id = $1 and p.deleted_at is null
    left join trip_pay_entries e on e.trip_id = t.id and e.driver_id = t.driver_id
   where t.tenant_id = $1
     and t.status = 'completed' and t.deleted_at is null and e.id is null
   group by 1 order by 1`;

// Static halves, concatenated: the statement reaching .query() is assembled from constants in
// this file, so the filter values stay parameters and the scanner can prove it.
export const ACCRUE_PICK_SQL = "select t.id from trips t where ";
export const ACCRUE_PICK_TAIL = " order by coalesce(t.actual_arrival, t.created_at) desc limit $";

export async function driverPayRoutes(app: FastifyInstance, _opts: unknown) {

  /**
   * Every driver, what they are paid, and what their driving has earned that is still
   * waiting. One read for the desk: a row that says `4 legs unpriced` is a row the clerk can
   * fix in the same breath, rather than a list of names and a second screen of numbers.
   */
  app.get("/driver-pay/terms", { preHandler: [requireAuth, requirePermission("driver_pay.view")] },
    async (req: any) => {
      const q = z.object({ driverId: z.string().uuid().optional() }).parse(req.query);
      return withTenant(req.user.tid, async (c) => {
        const rows = await c.query(
          TERMS_SELECT_SQL +
          (q.driverId ? " and d.id = $2" : "") +
          " order by d.full_name",
          q.driverId ? [req.user.tid, q.driverId] : [req.user.tid]);
        return {
          drivers: rows.rows,
          basisLabels: BASIS_LABELS,
          // The roster seats a driver can be paid into. Empty is not the desk's problem to
          // guess at: Office -> Employees is where a person gets a salary at all.
          employees: (await c.query(
            `select id, full_name, job_title, department, status,
                    monthly_salary::text as monthly_salary
               from employees
              where tenant_id = $1 and deleted_at is null and status = 'active'
                and monthly_salary is not null
              order by full_name`, [req.user.tid])).rows
        };
      });
    });

  /**
   * Set or change one driver's arrangement. Existing unclaimed earnings are deliberately
   * left alone: they are re-priced only when the desk asks, because a rate typed this
   * afternoon must not quietly rewrite what last week's legs were worth.
   */
  app.put("/driver-pay/terms/:driverId",
    { preHandler: [requireAuth, requirePermission("driver_pay.edit")] },
    async (req: any) => {
      const driverId = z.string().uuid().parse((req.params as { driverId: string }).driverId);
      const body = termsSchema.parse(req.body);
      const rate = body.basis === "salary_only" ? 0 : Math.round((body.rate ?? 0) * 10000) / 10000;
      if (body.basis !== "salary_only" && rate <= 0) {
        throw new ApiError("VALIDATION_FAILED",
          `${BASIS_LABELS[body.basis]} needs a rate above zero. Choose "salary only" if driving earns nothing extra.`,
          400, [{ field: "rate" }]);
      }
      return withTenant(req.user.tid, async (c) => {
        const driver = await c.query(
          `select id, full_name, status from drivers
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [driverId, req.user.tid]);
        if (!driver.rowCount) throw new ApiError("NOT_FOUND", "Driver not found", 404);

        if (body.employeeId) {
          const emp = await c.query(
            `select id, full_name from employees
              where id = $1 and tenant_id = $2 and deleted_at is null and status = 'active'`,
            [body.employeeId, req.user.tid]);
          if (!emp.rowCount) {
            throw new ApiError("VALIDATION_FAILED",
              "That roster seat is not an active employee of this company, so nothing could be paid through it.",
              400, [{ field: "employeeId" }]);
          }
          // The database also refuses this (094's unique index), but only here can the
          // sentence name the driver it collides with.
          const clash = await c.query(
            `select d.full_name from driver_pay_terms p
               join drivers d on d.id = p.driver_id
              where p.employee_id = $1 and p.driver_id <> $2 and p.deleted_at is null
                and p.tenant_id = $3`,
            [body.employeeId, driverId, req.user.tid]);
          if (clash.rowCount) {
            throw new ApiError("CONFLICT",
              `${clash.rows[0].full_name} is already paid through that roster seat. One driver per payslip line.`,
              409, [{ field: "employeeId" }]);
          }
        }

        const prev = await c.query(
          `select p.id, p.basis, p.rate::text as rate, p.employee_id, p.note,
                  e.full_name as employee_name
             from driver_pay_terms p
             left join employees e on e.id = p.employee_id
            where p.driver_id = $1 and p.tenant_id = $2 and p.deleted_at is null`,
          [driverId, req.user.tid]);

        if (prev.rowCount) {
          await c.query(
            `update driver_pay_terms
                set basis = $2, rate = $3, employee_id = $4, note = $5,
                    updated_by = $6, updated_at = now()
              where id = $1 and tenant_id = $7`,
            [prev.rows[0].id, body.basis, rate, body.employeeId ?? null, body.note ?? null,
             req.user.sub, req.user.tid]);
        } else {
          await c.query(
            `insert into driver_pay_terms
               (id, tenant_id, driver_id, employee_id, basis, rate, note, created_by, updated_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
            [uuidv7(), req.user.tid, driverId, body.employeeId ?? null, body.basis, rate,
             body.note ?? null, req.user.sub]);
        }

        // Naming the roster seat is what makes an already-earned leg payable, so the existing
        // unclaimed rows pick it up here. A row a run has claimed keeps what it said when it
        // was paid — 094's gate refuses to let it move either way.
        let relinked = 0;
        if (body.employeeId) {
          const stamped = await c.query(
            `update trip_pay_entries set employee_id = $2, updated_by = $3
              where driver_id = $1 and tenant_id = $4 and paid_run_id is null
                and employee_id is distinct from $2`,
            [driverId, body.employeeId, req.user.sub, req.user.tid]);
          relinked = stamped.rowCount ?? 0;
        }

        const after = await c.query(
          `select p.id, p.basis, p.rate::text as rate, p.employee_id, e.full_name as employee_name,
                  p.note, p.updated_at
             from driver_pay_terms p
             left join employees e on e.id = p.employee_id
            where p.driver_id = $1 and p.tenant_id = $2 and p.deleted_at is null`,
          [driverId, req.user.tid]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "driver_pay_terms", entityId: after.rows[0]?.id,
          action: "driver_pay.terms_set",
          before: prev.rowCount
            ? { driver: driver.rows[0].full_name, basis: prev.rows[0].basis,
                rate: prev.rows[0].rate, employee: prev.rows[0].employee_name ?? null,
                note: prev.rows[0].note ?? null }
            : { driver: driver.rows[0].full_name, basis: null },
          after: { driver: driver.rows[0].full_name, basis: after.rows[0]?.basis,
                   basisMeaning: BASIS_LABELS[body.basis], rate: after.rows[0]?.rate,
                   employee: after.rows[0]?.employee_name ?? null,
                   note: after.rows[0]?.note ?? null, entries_relinked: relinked }
        });

        return { ...after.rows[0], driver_name: driver.rows[0].full_name,
                 basis_meaning: BASIS_LABELS[body.basis], entries_relinked: relinked,
                 unclaimed: await unpaidFor(c, driverId, req.user.tid) };
      });
    });

  /**
   * The ledger. What the desk reads here is what the payroll line will be stamped with,
   * because both go through 095's claim — there is no second copy of the sum in this file.
   */
  app.get("/driver-pay/register", { preHandler: [requireAuth, requirePermission("driver_pay.view")] },
    async (req: any) => {
      const q = z.object({
        from: dateOnly.optional(),
        to: dateOnly.optional(),
        driverId: z.string().uuid().optional(),
        employeeId: z.string().uuid().optional(),
        state: z.enum(["unpaid", "paid", "all"]).default("all"),
        limit: z.coerce.number().int().min(1).max(500).default(200)
      }).parse(req.query);

      // Seeded with the company rather than appended to it: the dev runtime role holds
      // BYPASSRLS, so an explicit predicate on every read is the wall, not a policy.
      const where: string[] = ["e.tenant_id = $1"];
      const params: unknown[] = [req.user.tid];
      const bind = (v: unknown) => { params.push(v); return `$${params.length}` };
      if (q.from) where.push(`e.earned_on >= ${bind(q.from)}::date`);
      if (q.to) where.push(`e.earned_on <= ${bind(q.to)}::date`);
      if (q.driverId) where.push(`e.driver_id = ${bind(q.driverId)}`);
      if (q.employeeId) where.push(`e.employee_id = ${bind(q.employeeId)}`);
      if (q.state === "unpaid") where.push("e.paid_run_id is null");
      if (q.state === "paid") where.push("e.paid_run_id is not null");
      params.push(q.limit);

      return withTenant(req.user.tid, async (c) => {
        const rows = await c.query(
          REGISTER_SELECT_SQL +
          " where " + where.join(" and ") +
          ` order by e.earned_on desc, t.reference nulls last, e.created_at desc limit $${params.length}`,
          params);

        const totals = await c.query(REGISTER_TOTALS_SQL, [req.user.tid]);

        const gaps = await c.query(REGISTER_GAPS_SQL, [req.user.tid]);

        return { entries: rows.rows, totals: totals.rows[0], gaps: gaps.rows,
                 basisLabels: BASIS_LABELS,
                 returned: rows.rows.length,
                 window: { from: q.from ?? null, to: q.to ?? null, state: q.state } };
      });
    });

  /**
   * Re-price the register — one leg, or the legs in a window. The same function the completion
   * trigger calls, so a backfilled row is not a different kind of row; a row already inside a
   * run is reported and left alone rather than corrected underneath the payslip.
   */
  app.post("/driver-pay/accrue", { preHandler: [requireAuth, requirePermission("driver_pay.edit")] },
    async (req: any) => {
      await enforceRateLimit(`driver-pay-accrue:uid:${req.user.sub}`, 20, 3600);
      const body = accrueSchema.parse(req.body ?? {});
      return withTenant(req.user.tid, async (c) => {
        const targets: { id: string }[] = [];
        const picked: { id: string }[] = [];
        if (body.tripId) {
          const one = await c.query(
            `select id from trips
              where id = $1 and tenant_id = $2 and deleted_at is null and status = 'completed'`,
            [body.tripId, req.user.tid]);
          if (!one.rowCount) {
            throw new ApiError("CONFLICT",
              "Only a completed trip can be priced. Mark it completed first.", 409);
          }
          picked.push({ id: one.rows[0].id });
        } else {
          const filters: string[] = ["t.tenant_id = $1", "t.status = 'completed'", "t.deleted_at is null"];
          const params: unknown[] = [req.user.tid];
          const bind = (v: unknown) => { params.push(v); return `$${params.length}` };
          if (body.driverId) filters.push(`t.driver_id = ${bind(body.driverId)}`);
          if (body.from) filters.push(
            `coalesce(t.actual_arrival::date, t.created_at::date) >= ${bind(body.from)}::date`);
          if (body.to) filters.push(
            `coalesce(t.actual_arrival::date, t.created_at::date) <= ${bind(body.to)}::date`);
          params.push(body.limit);
          const found = await c.query(
            ACCRUE_PICK_SQL + filters.join(" and ") + ACCRUE_PICK_TAIL + params.length, params);
          picked.push(...found.rows);
        }
        targets.push(...picked);

        const tallies: Record<string, number> = {};
        const results: unknown[] = [];
        for (const t of targets) {
          const r = await c.query("select public.trip_pay_accrue($1, $2) as v",
            [t.id, req.user.sub]);
          const v = r.rows[0].v as { status: string; reason?: string; amount?: string };
          const key = v.status === "skipped" ? `skipped_${v.reason}` : v.status;
          tallies[key] = (tallies[key] ?? 0) + 1;
          if (results.length < 40) results.push(v);
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null,
          requestId: req.requestId, entity: "trip_pay_entries", entityId: body.tripId ?? null,
          action: "driver_pay.register_repriced",
          before: { trips: targets.length, from: body.from ?? null, to: body.to ?? null,
                    driver: body.driverId ?? null },
          after: { tallies }
        });

        return { trips: targets.length, tallies, sample: results };
      });
    });

  /** One driver's waiting earnings, for the terms panel to state what is still owed. */
  async function unpaidFor(c: any, driverId: string, tenantId: string) {
    const r = await c.query(
      `select count(*)::int as count,
              coalesce(sum(amount), 0)::numeric(14,2)::text as total,
              count(*) filter (where employee_id is null)::int as unlinked
         from trip_pay_entries
        where driver_id = $1 and tenant_id = $2 and paid_run_id is null`, [driverId, tenantId]);
    return r.rows[0];
  }
}
