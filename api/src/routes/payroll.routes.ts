import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
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

const periodOnly = z.string().regex(/^\d{4}-\d{2}-01$/);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Money arrives as a JSON number, as it does everywhere else in this API
// (consolidation's fees and payments). Rounded to whole cents before it is sent, so
// a caller cannot post 1234.567 and have Postgres silently pick a cent.
const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * 072 and 073 raise P0001 from the run gate, the draft gate and the line gate. The
 * global handler already turns those into a 409 carrying the database's own
 * sentence — "An issued payroll run cannot be reopened. Cancel it and build a new
 * one." — which is the sentence the office needs, so the routes do not paraphrase it.
 */

/** The month the run is built over, and the last day of it that has actually arrived. */
async function periodBounds(c: PoolClient, tenantId: string, period: string) {
  // Every date here is cast to text on purpose. pg hands a bare `date` column to JS
  // as a Date, and then `from > today` and the month-end test below compare date
  // objects whose string form is a locale sentence — "Wed Sep 30 2026…" sorts after
  // "Sun Oct 18 2026…" by its first letter, so an elapsed September would be
  // counted as not-yet-arrived. YYYY-MM-DD strings compare the way a calendar does.
  const { rows } = await c.query(
    `select period_working_days($2::date)::int as working_days,
            $2::date::text as p_from,
            (date_trunc('month', $2::date) + interval '1 month - 1 day')::date::text as p_to,
            (timezone(coalesce(s.timezone, 'Africa/Dar_es_Salaam'), now()))::date::text as today
       from (values (1)) v
       left join office_settings s on s.tenant_id = $1`,
    [tenantId, period]);
  const r = rows[0];
  const upto = r.p_to <= r.today ? r.p_to : r.today;
  return {
    workingDays: Number(r.working_days),
    from: r.p_from as string,
    to: r.p_to as string,
    upto: upto as string,
    today: r.today as string
  };
}

const RUN_SELECT_SQL = `r.id, r.period::text as period, r.status, r.currency,
  r.working_days, r.gross_total::text as gross_total,
  r.deduction_total::text as deduction_total, r.adjustment_total::text as adjustment_total,
  r.net_total::text as net_total, r.headcount, r.payment_reference,
  r.paid_on::text as paid_on, r.note, r.created_at, r.updated_at,
  r.issued_at, ui.full_name as issued_by_name,
  r.cancelled_at, uc.full_name as cancelled_by_name, r.cancel_reason,
  (select count(*)::int from payroll_lines l where l.run_id = r.id
     and l.unrecorded_days > 0) as lines_with_gaps,
  (select count(*)::int from payroll_lines l where l.run_id = r.id
     and l.adjustment_amount <> 0) as lines_adjusted`;

/**
 * The whole point of the module in one statement: for every active person with a
 * salary on file, what the register and the leave queue say about each working day
 * that has actually arrived.
 *
 * A day is charged only when it is approved unpaid leave, or an absence somebody
 * recorded that is not already covered by approved leave. A weekday with no row at
 * all is `unrecorded_days` — reported on the payslip and worth nothing — because a
 * clerk who forgot to clock four people in must not cost them four days' pay.
 *
 * The money columns come from `public.payroll_derive` (073), which is the same
 * function the line trigger stamps the stored row with. That is why a preview can
 * promise the number it shows is the number a build produces: they read one body of
 * arithmetic, not two copies of it.
 *
 * $1 tenant, $2 first day, $3 last day counted, $4 divisor — and the insert variant
 * adds $5 as the run. Every parameter a caller sends is referenced, because
 * PostgreSQL cannot infer the type of one the query never mentions.
 */
const DERIVATION_SQL = `
  with pd as (
    select d::date as day
      from generate_series($2::date, $3::date, interval '1 day') d
     where extract(isodow from d) between 1 and 5
  ),
  daygrid as (
    select e.id as employee_id, m.day,
      exists(select 1 from employee_attendance a
               where a.employee_id = e.id and a.tenant_id = e.tenant_id
                 and a.work_date = m.day and a.deleted_at is null) as has_row,
      (select a.day_status from employee_attendance a
        where a.employee_id = e.id and a.tenant_id = e.tenant_id
          and a.work_date = m.day and a.deleted_at is null limit 1) as day_status,
      coalesce((select a.minutes_late from employee_attendance a
          where a.employee_id = e.id and a.tenant_id = e.tenant_id
            and a.work_date = m.day and a.deleted_at is null limit 1), 0) as minutes_late,
      exists(select 1 from leave_requests l
               where l.employee_id = e.id and l.tenant_id = e.tenant_id
                 and l.deleted_at is null and l.status = 'approved'
                 and m.day between l.starts_on and l.ends_on) as on_leave,
      exists(select 1 from leave_requests l
               where l.employee_id = e.id and l.tenant_id = e.tenant_id
                 and l.deleted_at is null and l.status = 'approved'
                 and l.leave_kind = 'unpaid'
                 and m.day between l.starts_on and l.ends_on) as on_unpaid
      from employees e
      cross join pd m
     where e.tenant_id = $1 and e.deleted_at is null and e.status = 'active'
       and e.monthly_salary is not null
  ),
  stats as (
    select employee_id,
      count(*) filter (where on_unpaid)::int as unpaid_days,
      count(*) filter (where day_status = 'absent' and not on_leave)::int as absence_days,
      count(*) filter (where not has_row)::int as unrecorded_days,
      count(*) filter (where day_status = 'half_day')::int as half_days,
      sum(minutes_late)::int as late_minutes,
      coalesce(jsonb_agg(to_char(day, 'YYYY-MM-DD') order by day)
        filter (where on_unpaid), '[]'::jsonb) as unpaid_dates,
      coalesce(jsonb_agg(to_char(day, 'YYYY-MM-DD') order by day)
        filter (where day_status = 'absent' and not on_leave), '[]'::jsonb) as absence_dates,
      coalesce(jsonb_agg(to_char(day, 'YYYY-MM-DD') order by day)
        filter (where not has_row), '[]'::jsonb) as unrecorded_dates
      from daygrid
     group by employee_id
  ),
  derived as (
    select e.tenant_id, e.id as employee_id, e.full_name as employee_name,
           e.job_title, e.department, e.monthly_salary,
           $4::int as working_days,
           coalesce(s.unpaid_days, 0)::int    as unpaid_leave_days,
           coalesce(s.absence_days, 0)::int   as absence_days,
           coalesce(s.unrecorded_days, 0)::int as unrecorded_days,
           coalesce(s.half_days, 0)::int      as half_days,
           coalesce(s.late_minutes, 0)::int   as late_minutes,
           (x.v ->> 'days_paid')::int         as days_paid,
           (x.v ->> 'base_amount')::numeric(14,2)      as base_amount,
           (x.v ->> 'deduction_amount')::numeric(14,2) as deduction_amount,
           (x.v ->> 'net_amount')::numeric(14,2)       as net_amount,
           jsonb_build_object(
             'unpaid_leave_dates', coalesce(s.unpaid_dates, '[]'::jsonb),
             'absence_dates',      coalesce(s.absence_dates, '[]'::jsonb),
             'unrecorded_dates',   coalesce(s.unrecorded_dates, '[]'::jsonb)
           ) as detail
      from employees e
      join stats s on s.employee_id = e.id
      cross join lateral (
        select public.payroll_derive(e.monthly_salary, $4::int,
               coalesce(s.unpaid_days, 0), coalesce(s.absence_days, 0), 0) as v
      ) x
     where e.tenant_id = $1 and e.deleted_at is null and e.status = 'active'
       and e.monthly_salary is not null
  )`;

/**
 * Money columns are written as 0 here on purpose: 073's trigger overwrites all four
 * from the same derivation, so a route that forgets the arithmetic cannot put a
 * wrong number on a payslip — and the RETURNING clause reads back what was stamped.
 */
const BUILD_LINES_SQL = `${DERIVATION_SQL}
  insert into payroll_lines
    (tenant_id, run_id, employee_id, employee_name, job_title, department,
     monthly_salary, working_days, unpaid_leave_days, absence_days, unrecorded_days,
     half_days, late_minutes, days_paid, base_amount, deduction_amount,
     adjustment_amount, net_amount, detail)
  select tenant_id, $5, employee_id, employee_name, job_title, department,
         monthly_salary, working_days, unpaid_leave_days, absence_days,
         unrecorded_days, half_days, late_minutes,
         0, 0, 0, 0, 0, detail
    from derived
   order by employee_name
  returning id, employee_id, employee_name, job_title, department,
            monthly_salary::text as monthly_salary, working_days,
            unpaid_leave_days, absence_days, unrecorded_days, half_days, late_minutes,
            days_paid, base_amount::text as base_amount,
            deduction_amount::text as deduction_amount,
            adjustment_amount::text as adjustment_amount,
            net_amount::text as net_amount, detail`;

/** The same derivation, read instead of written. Nothing is inserted, nothing to undo. */
const PREVIEW_LINES_SQL = `${DERIVATION_SQL}
  select employee_id, employee_name, job_title, department,
         monthly_salary::text as monthly_salary, working_days,
         unpaid_leave_days, absence_days, unrecorded_days, half_days, late_minutes,
         days_paid, base_amount::text as base_amount,
         deduction_amount::text as deduction_amount, net_amount::text as net_amount,
         detail,
         coalesce(sum(base_amount) over (), 0)::numeric(14,2)::text as gross_total,
         coalesce(sum(deduction_amount) over (), 0)::numeric(14,2)::text as deduction_total,
         coalesce(sum(net_amount) over (), 0)::numeric(14,2)::text as net_total,
         count(*) over ()::int as headcount
    from derived
   order by employee_name`;

/** The people a build deliberately left out, in the words the desk needs. */
async function skippedRoster(c: PoolClient, tenantId: string) {
  const { rows } = await c.query(
    `select id as employee_id, full_name, job_title, monthly_salary is null as no_salary
       from employees
      where tenant_id = $1 and deleted_at is null and status = 'active'
        and monthly_salary is null
      order by full_name`,
    [tenantId]);
  return rows;
}

function boundsBody(b: Awaited<ReturnType<typeof periodBounds>>) {
  return { from: b.from, to: b.to, countedUpTo: b.upto, today: b.today,
           workingDays: b.workingDays };
}

export async function payrollRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- The register of runs ----------

  /** Every month this company has run payroll for, newest first. */
  app.get("/payroll/runs", { preHandler: [requireAuth, requirePermission("payroll.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select ${RUN_SELECT_SQL}
           from payroll_runs r
           left join users ui on ui.id = r.issued_by
           left join users uc on uc.id = r.cancelled_by
          where r.tenant_id = $1 and r.deleted_at is null
          order by r.period desc limit 60`,
        [req.user.tid]));
      return { runs: rows };
    });

  /**
   * What a build would produce, without writing anything. The office looks at this
   * before it commits a month, because the number that decides a payslip is the
   * attendance register — and a missing day is far cheaper to see here than after
   * the money has moved.
   */
  app.get("/payroll/preview", { preHandler: [requireAuth, requirePermission("payroll.view")] },
    async (req: any) => {
      const q = z.object({ period: periodOnly }).parse(req.query);
      return withTenant(req.user.tid, async (c) => {
        const bounds = await periodBounds(c, req.user.tid, q.period);
        if (bounds.from > bounds.today) {
          throw new ApiError("VALIDATION_FAILED",
            "That month has not arrived yet, so there is no register to pay against.", 400,
            [{ field: "period" }]);
        }
        const lines = await c.query(PREVIEW_LINES_SQL,
          [req.user.tid, bounds.from, bounds.upto, bounds.workingDays]);
        const existing = await c.query(
          `select id, status, headcount, net_total::text as net_total from payroll_runs
            where tenant_id = $1 and period = $2::date and deleted_at is null`,
          [req.user.tid, q.period]);
        const first = lines.rows[0] as any;
        return {
          period: q.period,
          bounds: boundsBody(bounds),
          totals: first
            ? { gross_total: first.gross_total, deduction_total: first.deduction_total,
                net_total: first.net_total, headcount: first.headcount }
            : { gross_total: "0.00", deduction_total: "0.00", net_total: "0.00", headcount: 0 },
          lines: lines.rows.map((r: any) => ({
            employee_id: r.employee_id, employee_name: r.employee_name,
            job_title: r.job_title, department: r.department,
            monthly_salary: r.monthly_salary, working_days: r.working_days,
            unpaid_leave_days: r.unpaid_leave_days, absence_days: r.absence_days,
            unrecorded_days: r.unrecorded_days, half_days: r.half_days,
            late_minutes: r.late_minutes, days_paid: r.days_paid,
            base_amount: r.base_amount, deduction_amount: r.deduction_amount,
            net_amount: r.net_amount, detail: r.detail
          })),
          alreadyBuilt: existing.rows[0] ?? null,
          // Someone with no salary on file is not in the run and the desk must be
          // told, rather than left to notice an absent name.
          skipped: await skippedRoster(c, req.user.tid)
        };
      });
    });

  /**
   * Create the draft run for a month. One run per company per period, so a second
   * build is a rebuild of the existing draft, never a parallel document that then
   * has to be reconciled by hand.
   */
  app.post("/payroll/runs", { preHandler: [requireAuth, requirePermission("payroll.run")] },
    async (req: any, reply) => {
      await enforceRateLimit(`payroll-build:uid:${req.user.sub}`, 20, 3600);
      const body = z.object({ period: periodOnly }).strict().parse(req.body);
      const clash = await pool_periodClash(req.user.tid, body.period);
      if (clash) {
        throw new ApiError("CONFLICT",
          `There is already a ${clash.status} payroll run for that month.`, 409,
          [{ reason: clash.status === "draft" ? "rebuild_instead" : "already_issued",
            runId: clash.id }]);
      }
      return withTenant(req.user.tid, async (c) => {
        const bounds = await periodBounds(c, req.user.tid, body.period);
        if (bounds.from > bounds.today) {
          throw new ApiError("VALIDATION_FAILED",
            "That month has not arrived yet, so there is no register to pay against.", 400,
            [{ field: "period" }]);
        }
        const id = uuidv7();
        await c.query(
          `insert into payroll_runs (id, tenant_id, period, status, working_days, created_by, updated_by)
           values ($1, $2, $3::date, 'draft', $4, $5, $5)`,
          [id, req.user.tid, body.period, bounds.workingDays, req.user.sub]);
        const lines = await c.query(BUILD_LINES_SQL,
          [req.user.tid, bounds.from, bounds.upto, bounds.workingDays, id]);
        const saved = await c.query(`select ${RUN_SELECT_SQL} from payroll_runs r
          left join users ui on ui.id = r.issued_by
          left join users uc on uc.id = r.cancelled_by
          where r.id = $1 and r.tenant_id = $2`, [id, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "payroll_runs", entityId: id,
          action: "payroll.run.built",
          after: { period: body.period, headcount: saved.rows[0]?.headcount,
                   netTotal: saved.rows[0]?.net_total, countedUpTo: bounds.upto }
        });
        return reply.status(201).send({
          ...saved.rows[0],
          bounds: boundsBody(bounds),
          lines: lines.rows,
          skipped: await skippedRoster(c, req.user.tid)
        });
      });
    });

  /** One run and its lines — the document the payslip sheet prints from. */
  app.get("/payroll/runs/:id", { preHandler: [requireAuth, requirePermission("payroll.view")] },
    async (req: any) => {
      const runId = z.string().uuid().parse((req.params as { id: string }).id);
      return withTenant(req.user.tid, async (c) => {
        const run = await c.query(`select ${RUN_SELECT_SQL} from payroll_runs r
          left join users ui on ui.id = r.issued_by
          left join users uc on uc.id = r.cancelled_by
          where r.id = $1 and r.tenant_id = $2 and r.deleted_at is null`,
          [runId, req.user.tid]);
        if (!run.rowCount) throw new ApiError("NOT_FOUND", "Payroll run not found", 404);
        const lines = await c.query(
          `select l.id, l.employee_id, e.full_name, e.job_title, e.department,
                  e.status as employee_status, e.employment_type, e.hired_date,
                  l.employee_name, l.monthly_salary::text as monthly_salary,
                  l.currency, l.working_days, l.unpaid_leave_days, l.absence_days,
                  l.unrecorded_days, l.half_days, l.late_minutes, l.days_paid,
                  l.base_amount::text as base_amount,
                  l.deduction_amount::text as deduction_amount,
                  l.adjustment_amount::text as adjustment_amount,
                  l.adjustment_label, l.net_amount::text as net_amount,
                  l.detail, l.note, l.created_at, l.updated_at
             from payroll_lines l
             join employees e on e.id = l.employee_id
            where l.run_id = $1
            order by e.full_name`,
          [runId]);
        return { ...run.rows[0], lines: lines.rows };
      });
    });

  /**
   * Throw the draft's lines away and derive them again from the register as it
   * stands now. Only a draft can be rebuilt — an issued run is a record of what
   * was paid, and 072's gates refuse to touch it whatever this route does.
   */
  app.post("/payroll/runs/:id/rebuild",
    { preHandler: [requireAuth, requirePermission("payroll.run")] },
    async (req: any) => {
      const runId = z.string().uuid().parse((req.params as { id: string }).id);
      return withTenant(req.user.tid, async (c) => {
        const run = await c.query(
          `select period::text as period, status, working_days from payroll_runs
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [runId, req.user.tid]);
        if (!run.rowCount) throw new ApiError("NOT_FOUND", "Payroll run not found", 404);
        if (run.rows[0].status !== "draft") {
          throw new ApiError("CONFLICT",
            "Only a draft is rebuilt. An issued run keeps the figures it was issued with.", 409);
        }
        const bounds = await periodBounds(c, req.user.tid, run.rows[0].period);
        await c.query("delete from payroll_lines where run_id = $1", [runId]);
        const lines = await c.query(BUILD_LINES_SQL,
          [req.user.tid, bounds.from, bounds.upto,
           Number(run.rows[0].working_days), runId]);
        const saved = await c.query(`select ${RUN_SELECT_SQL} from payroll_runs r
          left join users ui on ui.id = r.issued_by
          left join users uc on uc.id = r.cancelled_by
          where r.id = $1 and r.tenant_id = $2`, [runId, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "payroll_runs", entityId: runId,
          action: "payroll.run.rebuilt",
          after: { headcount: saved.rows[0]?.headcount, netTotal: saved.rows[0]?.net_total,
                   countedUpTo: bounds.upto }
        });
        return { ...saved.rows[0], bounds: boundsBody(bounds), lines: lines.rows,
                 skipped: await skippedRoster(c, req.user.tid) };
      });
    });

  /**
   * The only hand-written figure in the module. Everything else on the line is
   * derived and 072 refuses to let it be re-typed; this is the block the office
   * owns — a statutory deduction, a loan recovery, a bonus — and it carries its
   * own label so a slip never shows a number nobody can explain.
   */
  app.put("/payroll/lines/:id", { preHandler: [requireAuth, requirePermission("payroll.run")] },
    async (req: any) => {
      const lineId = z.string().uuid().parse((req.params as { id: string }).id);
      const body = z.object({
        adjustmentAmount: z.number().min(-1_000_000_000).max(1_000_000_000),
        adjustmentLabel: z.string().trim().min(2).max(120).nullish(),
        note: z.string().trim().max(500).nullish()
      }).strict().parse(req.body);
      const amount = cents(body.adjustmentAmount);
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select l.employee_name, l.adjustment_amount::text as adjustment_amount,
                  l.adjustment_label, l.note, l.net_amount::text as net_amount,
                  l.base_amount::text as base_amount, r.status, r.period::text as period
             from payroll_lines l join payroll_runs r on r.id = l.run_id
            where l.id = $1 and l.tenant_id = $2`,
          [lineId, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Payroll line not found", 404);
        if (prev.rows[0].status !== "draft") {
          throw new ApiError("CONFLICT",
            "That run has been issued, so its lines cannot change. Cancel the run and build a new one.",
            409);
        }
        if (amount !== 0 && !body.adjustmentLabel) {
          // A deduction with no name on it is the thing an employee disputes first.
          throw new ApiError("VALIDATION_FAILED",
            "Say what the adjustment is for. An unexplained figure cannot be defended on a payslip.",
            400, [{ field: "adjustmentLabel" }]);
        }
        // No updated_by: 072 gave the line no actor column, because who changed an
        // adjustment is recorded in the audit trail with the before/after figure.
        await c.query(
          `update payroll_lines
              set adjustment_amount = $2, adjustment_label = $3, note = $4
            where id = $1 and tenant_id = $5`,
          [lineId, amount, amount === 0 ? null : body.adjustmentLabel ?? null,
           body.note ?? null, req.user.tid]);
        const saved = await c.query(
          `select id, employee_name, days_paid, base_amount::text as base_amount,
                  deduction_amount::text as deduction_amount,
                  adjustment_amount::text as adjustment_amount, adjustment_label,
                  net_amount::text as net_amount, note, updated_at
             from payroll_lines where id = $1 and tenant_id = $2`,
          [lineId, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "payroll_lines", entityId: lineId,
          action: "payroll.line.adjusted",
          before: { employee: prev.rows[0].employee_name, period: prev.rows[0].period,
                    adjustmentAmount: prev.rows[0].adjustment_amount,
                    netAmount: prev.rows[0].net_amount },
          after: { employee: saved.rows[0]?.employee_name,
                   adjustmentAmount: saved.rows[0]?.adjustment_amount,
                   adjustmentLabel: saved.rows[0]?.adjustment_label ?? null,
                   netAmount: saved.rows[0]?.net_amount }
        });
        return saved.rows[0];
      });
    });

  /** Drop one person from a draft. 072 allows this line delete and nothing else. */
  app.delete("/payroll/lines/:id", { preHandler: [requireAuth, requirePermission("payroll.run")] },
    async (req: any) => {
      const lineId = z.string().uuid().parse((req.params as { id: string }).id);
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select l.employee_name, l.run_id, l.monthly_salary::text as monthly_salary,
                  l.net_amount::text as net_amount, r.status, r.period::text as period
             from payroll_lines l join payroll_runs r on r.id = l.run_id
            where l.id = $1 and l.tenant_id = $2`,
          [lineId, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Payroll line not found", 404);
        if (prev.rows[0].status !== "draft") {
          throw new ApiError("CONFLICT",
            "That run has been issued, so its lines cannot change. Cancel the run and build a new one.",
            409);
        }
        await c.query("delete from payroll_lines where id = $1 and tenant_id = $2",
          [lineId, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "payroll_lines", entityId: lineId,
          action: "payroll.line.removed",
          before: { employee: prev.rows[0].employee_name, period: prev.rows[0].period,
                    netAmount: prev.rows[0].net_amount }
        });
        return { ok: true, runId: prev.rows[0].run_id };
      });
    });

  /**
   * The run becomes the document. Issuing is the only write that changes a
   * payroll's life, so it is its own verb with its own permission rather than a
   * field on PUT — the same reason publishing has its own route in the directory.
   */
  app.post("/payroll/runs/:id/issue",
    { preHandler: [requireAuth, requirePermission("payroll.issue")] },
    async (req: any) => {
      const runId = z.string().uuid().parse((req.params as { id: string }).id);
      const body = z.object({
        paymentReference: z.string().trim().max(160).nullish(),
        paidOn: dateOnly.nullable().optional()
      }).strict().parse(req.body ?? {});
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select status, period::text as period, headcount, net_total::text as net_total
             from payroll_runs where id = $1 and tenant_id = $2 and deleted_at is null`,
          [runId, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Payroll run not found", 404);
        if (prev.rows[0].status === "issued") {
          return { ok: true, already: true, status: "issued" };
        }
        // 072's gate raises this too, but only if an update reaches it — the statement
        // below is guarded on status='draft', so a cancelled run would slip through as
        // a quiet 200 that changed nothing. Say it here instead.
        if (prev.rows[0].status === "cancelled") {
          throw new ApiError("CONFLICT",
            "A cancelled run cannot be issued. Build a new one for the month.", 409);
        }
        if (Number(prev.rows[0].headcount) === 0) {
          throw new ApiError("CONFLICT", "There is nobody in this run to issue.", 409);
        }
        // The reference is typed after the fact, by the person who actually moved
        // the money, and it may be filled in later — issuing does not require it.
        await c.query(
          `update payroll_runs set status = 'issued', payment_reference = $3, paid_on = $4::date,
                  issued_by = $2, updated_by = $2, updated_at = now()
            where id = $1 and tenant_id = $5 and deleted_at is null and status = 'draft'`,
          [runId, req.user.sub, body.paymentReference ?? null, body.paidOn ?? null,
           req.user.tid]);
        const saved = await c.query(`select ${RUN_SELECT_SQL} from payroll_runs r
          left join users ui on ui.id = r.issued_by
          left join users uc on uc.id = r.cancelled_by
          where r.id = $1 and r.tenant_id = $2`, [runId, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "payroll_runs", entityId: runId,
          action: "payroll.run.issued",
          before: { status: prev.rows[0].status, netTotal: prev.rows[0].net_total },
          after: { period: saved.rows[0]?.period, headcount: saved.rows[0]?.headcount,
                   netTotal: saved.rows[0]?.net_total,
                   paymentReference: saved.rows[0]?.payment_reference ?? null,
                   paidOn: saved.rows[0]?.paid_on ?? null }
        });
        return saved.rows[0];
      });
    });

  /** Cancel is the only way out of an issued run, and it names a person and a reason. */
  app.post("/payroll/runs/:id/cancel",
    { preHandler: [requireAuth, requirePermission("payroll.issue")] },
    async (req: any) => {
      const runId = z.string().uuid().parse((req.params as { id: string }).id);
      const body = z.object({ reason: z.string().trim().min(5).max(500) })
        .strict().parse(req.body ?? {});
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select status, period::text as period from payroll_runs
            where id = $1 and tenant_id = $2 and deleted_at is null`,
          [runId, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Payroll run not found", 404);
        if (prev.rows[0].status === "cancelled") return { ok: true, status: "cancelled" };
        await c.query(
          `update payroll_runs set status = 'cancelled', cancelled_by = $2,
                  cancelled_at = now(), cancel_reason = $3,
                  updated_by = $2, updated_at = now()
            where id = $1 and tenant_id = $4 and deleted_at is null`,
          [runId, req.user.sub, body.reason, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "payroll_runs", entityId: runId,
          action: "payroll.run.cancelled",
          before: { status: prev.rows[0].status, period: prev.rows[0].period },
          after: { status: "cancelled", reason: body.reason }
        });
        return { ok: true, status: "cancelled" };
      });
    });

  /**
   * Payment bookkeeping, open on an issued run on purpose: the reference for a
   * transfer is usually known the day after the run is signed, not before.
   */
  app.put("/payroll/runs/:id", { preHandler: [requireAuth, requirePermission("payroll.issue")] },
    async (req: any) => {
      const runId = z.string().uuid().parse((req.params as { id: string }).id);
      const body = z.object({
        paymentReference: z.string().trim().max(160).nullish(),
        paidOn: dateOnly.nullable().optional(),
        note: z.string().trim().max(1000).nullish()
      }).strict().parse(req.body);
      return withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select status, payment_reference, paid_on::text as paid_on, note
             from payroll_runs where id = $1 and tenant_id = $2 and deleted_at is null`,
          [runId, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Payroll run not found", 404);
        if (prev.rows[0].status === "cancelled") {
          throw new ApiError("CONFLICT", "A cancelled run is left as it is. Build a new one.", 409);
        }
        // Absent key keeps the stored value, like the drivers PUT: a desk that only
        // adds a date must not blank the reference it typed last week.
        const reference = "paymentReference" in body
          ? body.paymentReference ?? null : prev.rows[0].payment_reference;
        const paidOn = "paidOn" in body ? body.paidOn ?? null : prev.rows[0].paid_on;
        const note = "note" in body ? body.note ?? null : prev.rows[0].note;
        await c.query(
          `update payroll_runs set payment_reference = $3, paid_on = $4::date, note = $5,
                  updated_by = $2, updated_at = now()
            where id = $1 and tenant_id = $6 and deleted_at is null`,
          [runId, req.user.sub, reference, paidOn, note, req.user.tid]);
        const saved = await c.query(`select ${RUN_SELECT_SQL} from payroll_runs r
          left join users ui on ui.id = r.issued_by
          left join users uc on uc.id = r.cancelled_by
          where r.id = $1 and r.tenant_id = $2`, [runId, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "payroll_runs", entityId: runId,
          action: "payroll.run.payment_recorded",
          before: { paymentReference: prev.rows[0].payment_reference, paidOn: prev.rows[0].paid_on },
          after: { paymentReference: saved.rows[0]?.payment_reference ?? null,
                   paidOn: saved.rows[0]?.paid_on ?? null }
        });
        return saved.rows[0];
      });
    });

  // ---------- The payslip and the salary register ----------

  /**
   * One person's slip for one run, read as a document rather than as a line: the
   * sheet needs the letterhead the invoice sheet uses and the name of whoever
   * signed the run, not only the arithmetic. No employee phone or address is read
   * here — a payslip is handed over, and a slip that carried contact data would be
   * a PII copy outside the encrypted column.
   */
  app.get("/payroll/runs/:id/payslip/:lineId",
    { preHandler: [requireAuth, requirePermission("payroll.view")] },
    async (req: any) => {
      const { id, lineId } = req.params as { id: string; lineId: string };
      const runId = z.string().uuid().parse(id);
      const lineRowId = z.string().uuid().parse(lineId);
      return withTenant(req.user.tid, async (c) => {
        const { rows } = await c.query(
          `select cp.company_name, cp.tin_display,
                  r.id as run_id, r.period::text as period, r.status, r.currency,
                  r.working_days as run_working_days,
                  r.payment_reference, r.paid_on::text as paid_on,
                  r.issued_at, ui.full_name as issued_by_name,
                  l.id, l.employee_id, l.employee_name, l.job_title, l.department,
                  l.monthly_salary::text as monthly_salary, l.working_days,
                  l.unpaid_leave_days, l.absence_days, l.unrecorded_days, l.half_days,
                  l.late_minutes, l.days_paid, l.base_amount::text as base_amount,
                  l.deduction_amount::text as deduction_amount,
                  l.adjustment_amount::text as adjustment_amount, l.adjustment_label,
                  l.net_amount::text as net_amount, l.detail, l.note,
                  e.employment_type, e.hired_date::text as hired_date
             from payroll_lines l
             join payroll_runs r on r.id = l.run_id
             join employees e on e.id = l.employee_id
             left join company_profiles cp on cp.tenant_id = r.tenant_id
             left join users ui on ui.id = r.issued_by
            where l.id = $1 and l.run_id = $2 and r.tenant_id = $3 and r.deleted_at is null`,
          [lineRowId, runId, req.user.tid]);
        if (!rows.length) throw new ApiError("NOT_FOUND", "Payslip not found", 404);
        return rows[0];
      });
    });

  /**
   * The salary register: one person's pay across the months that were actually
   * run. This is the view the office is asked for at an audit — not what the
   * contract says, but what was paid, and when.
   */
  app.get("/payroll/register", { preHandler: [requireAuth, requirePermission("payroll.view")] },
    async (req: any) => {
      const q = z.object({
        employeeId: z.string().uuid().optional(),
        from: periodOnly.optional(),
        to: periodOnly.optional()
      }).parse(req.query);
      return withTenant(req.user.tid, async (c) => {
        const { rows } = await c.query(
          `select l.employee_id, e.full_name, e.job_title, e.department,
                  r.id as run_id, r.period::text as period, r.status, r.currency,
                  l.monthly_salary::text as monthly_salary, l.days_paid, l.working_days,
                  l.unpaid_leave_days, l.absence_days, l.unrecorded_days,
                  l.base_amount::text as base_amount,
                  l.deduction_amount::text as deduction_amount,
                  l.adjustment_amount::text as adjustment_amount,
                  l.adjustment_label, l.net_amount::text as net_amount,
                  r.paid_on::text as paid_on, r.payment_reference
             from payroll_lines l
             join payroll_runs r on r.id = l.run_id
             join employees e on e.id = l.employee_id
            where r.tenant_id = $1 and r.deleted_at is null and r.status <> 'cancelled'
              and ($2::uuid is null or l.employee_id = $2)
              and ($3::date is null or r.period >= $3)
              and ($4::date is null or r.period <= $4)
            order by e.full_name, r.period desc
            limit 4000`,
          [req.user.tid, q.employeeId ?? null, q.from ?? null, q.to ?? null]);
        // Per-person totals accumulate in whole cents, because adding `numeric`
        // strings through a JS float is exactly how a register drifts by a cent.
        const toCents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
        const asMoney = (c: number) => (c / 100).toFixed(2);
        const perEmployee = new Map<string, any>();
        for (const r of rows as any[]) {
          const cur = perEmployee.get(r.employee_id) ?? {
            employee_id: r.employee_id, full_name: r.full_name, job_title: r.job_title,
            department: r.department, periods: [] as string[],
            months: 0, days_paid: 0, net: 0, base: 0, deductions: 0, adjustments: 0
          };
          cur.months += 1;
          cur.days_paid += Number(r.days_paid);
          cur.net += toCents(r.net_amount);
          cur.base += toCents(r.base_amount);
          cur.deductions += toCents(r.deduction_amount);
          cur.adjustments += toCents(r.adjustment_amount);
          cur.periods.push(r.period);
          perEmployee.set(r.employee_id, cur);
        }
        const people = [...perEmployee.values()]
          .sort((a: any, b: any) => String(a.full_name).localeCompare(String(b.full_name)));
        const money = (key: "net" | "base" | "deductions" | "adjustments") =>
          asMoney(people.reduce((s: number, p: any) => s + p[key], 0));
        return {
          window: { from: q.from ?? null, to: q.to ?? null },
          totals: {
            people: people.length,
            net: money("net"),
            base: money("base"),
            deductions: money("deductions"),
            adjustments: money("adjustments")
          },
          rows,
          employees: people.map((p: any) => ({
            employee_id: p.employee_id, full_name: p.full_name, job_title: p.job_title,
            department: p.department, months: p.months, days_paid: p.days_paid,
            periods: p.periods,
            net_total: asMoney(p.net), base_total: asMoney(p.base),
            deduction_total: asMoney(p.deductions), adjustment_total: asMoney(p.adjustments)
          }))
        };
      });
    });
}

/**
 * Read outside the tenant transaction on purpose: the period clash is answered
 * from the run's own status so the caller can be pointed at the right next verb,
 * and a build that then races with another one is stopped by
 * payroll_runs_period_uq anyway.
 */
async function pool_periodClash(tenantId: string, period: string) {
  const found = await withTenant(tenantId, (c) => c.query(
    `select id, status from payroll_runs
      where tenant_id = $1 and period = $2::date and deleted_at is null`,
    [tenantId, period]));
  return found.rows[0] ?? null;
}
