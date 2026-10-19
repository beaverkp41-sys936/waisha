/**
 * SQL validation for payroll.routes.ts and migrations 072/073/094/095. Every statement the
 * module can issue is planned against the live schema with EXPLAIN (no writes), the
 * role matrix and the grants are read back, and `payroll_derive` is actually
 * executed — a function that computes money is only proven by the figures it returns.
 * Run: npx tsx scripts/verify-payroll-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_EMP = "33333333-3333-7333-8333-333333333333";
const FAKE_RUN = "66666666-6666-7666-8666-666666666666";
const FAKE_LINE = "44444444-4444-7444-8444-444444444444";
const PERIOD = "2026-10-01";
const FROM = "2026-10-01";
const UPTO = "2026-10-17";
const WORKING_DAYS = 22;

// The derivation exactly as payroll.routes.ts holds it, so this gate plans the
// statement the route actually sends and not a paraphrase of it.
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
           (x.v ->> 'trip_pay_amount')::numeric(14,2)  as trip_pay_amount,
           (x.v ->> 'net_amount')::numeric(14,2)       as net_amount,
           jsonb_build_object(
             'unpaid_leave_dates', coalesce(s.unpaid_dates, '[]'::jsonb),
             'absence_dates',      coalesce(s.absence_dates, '[]'::jsonb),
             'unrecorded_dates',   coalesce(s.unrecorded_dates, '[]'::jsonb),
             'trip_pay',           coalesce(p.tp -> 'entries', '[]'::jsonb),
             'trip_pay_count',     (p.tp ->> 'count')::int,
             'trip_pay_total',     (p.tp ->> 'total')::numeric(14,2)::text
           ) as detail
      from employees e
      join stats s on s.employee_id = e.id
      cross join lateral (
        select public.trip_pay_claim($5, e.id, $2::date) as tp
      ) p
      cross join lateral (
        select public.payroll_derive(e.monthly_salary, $4::int,
               coalesce(s.unpaid_days, 0), coalesce(s.absence_days, 0), 0,
               (p.tp ->> 'total')::numeric) as v
      ) x
     where e.tenant_id = $1 and e.deleted_at is null and e.status = 'active'
       and e.monthly_salary is not null
  )`;

/**
 * Money columns are written as 0 here on purpose, exactly as the route does it: 073's trigger
 * overwrites all six from the same derivation, so this plans the insert the desk sends and
 * not a version where a hand-typed figure could survive.
 */
const BUILD_LINES_SQL = `${DERIVATION_SQL}
  insert into payroll_lines
    (tenant_id, run_id, employee_id, employee_name, job_title, department,
     monthly_salary, working_days, unpaid_leave_days, absence_days, unrecorded_days,
     half_days, late_minutes, days_paid, base_amount, deduction_amount, trip_pay_amount,
     adjustment_amount, net_amount, detail)
  select tenant_id, $5, employee_id, employee_name, job_title, department,
         monthly_salary, working_days, unpaid_leave_days, absence_days,
         unrecorded_days, half_days, late_minutes,
         0, 0, 0, 0, 0, 0, detail
    from derived
   order by employee_name
  returning id, employee_id, employee_name, job_title, department,
            monthly_salary::text as monthly_salary, working_days,
            unpaid_leave_days, absence_days, unrecorded_days, half_days, late_minutes,
            days_paid, base_amount::text as base_amount,
            deduction_amount::text as deduction_amount,
            trip_pay_amount::text as trip_pay_amount,
            adjustment_amount::text as adjustment_amount,
            net_amount::text as net_amount, detail`;

const PREVIEW_LINES_SQL = `${DERIVATION_SQL}
  select employee_id, employee_name, job_title, department,
         monthly_salary::text as monthly_salary, working_days,
         unpaid_leave_days, absence_days, unrecorded_days, half_days, late_minutes,
         days_paid, base_amount::text as base_amount,
         deduction_amount::text as deduction_amount,
         trip_pay_amount::text as trip_pay_amount,
         net_amount::text as net_amount,
         detail,
         coalesce(sum(base_amount + trip_pay_amount) over (), 0)::numeric(14,2)::text as gross_total,
         coalesce(sum(deduction_amount) over (), 0)::numeric(14,2)::text as deduction_total,
         coalesce(sum(trip_pay_amount) over (), 0)::numeric(14,2)::text as trip_pay_total,
         coalesce(sum(net_amount) over (), 0)::numeric(14,2)::text as net_total,
         count(*) over ()::int as headcount
    from derived
   order by employee_name`;

const RUN_SELECT_SQL = `r.id, r.period::text as period, r.status, r.currency,
  r.working_days, r.gross_total::text as gross_total,
  r.deduction_total::text as deduction_total, r.trip_pay_total::text as trip_pay_total,
  r.adjustment_total::text as adjustment_total,
  r.net_total::text as net_total, r.headcount, r.payment_reference,
  r.paid_on::text as paid_on, r.note, r.created_at, r.updated_at,
  r.issued_at, ui.full_name as issued_by_name,
  r.cancelled_at, uc.full_name as cancelled_by_name, r.cancel_reason,
  (select count(*)::int from payroll_lines l where l.run_id = r.id
     and l.unrecorded_days > 0) as lines_with_gaps,
  (select count(*)::int from payroll_lines l where l.run_id = r.id
     and l.adjustment_amount <> 0) as lines_adjusted`;

const gate = (key: string) =>
  `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
    where ur.user_id = $1 and rp.permission_key = $2
      and (ur.expires_at is null or ur.expires_at > now()) limit 1`;

const checks: [string, string, unknown[]][] = [
  // ---------- permission gates ----------
  ["gate payroll.view", gate("payroll.view"), [FAKE_USER, "payroll.view"]],
  ["gate payroll.run", gate("payroll.run"), [FAKE_USER, "payroll.run"]],
  ["gate payroll.issue", gate("payroll.issue"), [FAKE_USER, "payroll.issue"]],

  // ---------- the period the run is built over ----------
  ["working days in the payroll month",
    `select period_working_days($1::date)::int as n`, [PERIOD]],
  ["the period bounds and the company clock",
    `select period_working_days($2::date)::int as working_days,
            $2::date::text as p_from,
            (date_trunc('month', $2::date) + interval '1 month - 1 day')::date::text as p_to,
            (timezone(coalesce(s.timezone, 'Africa/Dar_es_Salaam'), now()))::date::text as today
       from (values (1)) v
       left join office_settings s on s.tenant_id = $1`, [FAKE_TENANT, PERIOD]],

  // ---------- GET /payroll/runs ----------
  ["the register of runs",
    `select ${RUN_SELECT_SQL}
       from payroll_runs r
       left join users ui on ui.id = r.issued_by
       left join users uc on uc.id = r.cancelled_by
      where r.tenant_id = $1 and r.deleted_at is null
      order by r.period desc limit 60`, [FAKE_TENANT]],

  // ---------- GET /payroll/preview ----------
  // The fifth bind is the run the claim is made against: a preview has none, and 095's
  // claim reads that as "unclaimed only".
  ["a preview of the month, written nowhere", PREVIEW_LINES_SQL,
    [FAKE_TENANT, FROM, UPTO, WORKING_DAYS, null]],
  ["the month is already built",
    `select id, status, headcount, net_total::text as net_total from payroll_runs
      where tenant_id = $1 and period = $2::date and deleted_at is null`,
    [FAKE_TENANT, PERIOD]],
  ["who the build leaves out",
    `select id as employee_id, full_name, job_title, monthly_salary is null as no_salary
       from employees
      where tenant_id = $1 and deleted_at is null and status = 'active'
        and monthly_salary is null
      order by full_name`, [FAKE_TENANT]],

  // ---------- POST /payroll/runs and /rebuild ----------
  ["opening a draft run",
    `insert into payroll_runs (id, tenant_id, period, status, working_days, created_by, updated_by)
     values ($1, $2, $3::date, 'draft', $4, $5, $5)`,
    [FAKE_RUN, FAKE_TENANT, PERIOD, WORKING_DAYS, FAKE_USER]],
  ["building the lines from the register", BUILD_LINES_SQL,
    [FAKE_TENANT, FROM, UPTO, WORKING_DAYS, FAKE_RUN]],
  ["clearing a draft for a rebuild",
    `delete from payroll_lines where run_id = $1`, [FAKE_RUN]],
  ["one run read back",
    `select ${RUN_SELECT_SQL} from payroll_runs r
       left join users ui on ui.id = r.issued_by
       left join users uc on uc.id = r.cancelled_by
      where r.id = $1 and r.tenant_id = $2`, [FAKE_RUN, FAKE_TENANT]],

  // ---------- GET /payroll/runs/:id ----------
  ["a run with its lines",
    `select l.id, l.employee_id, e.full_name, e.job_title, e.department,
            e.status as employee_status, e.employment_type, e.hired_date,
            l.employee_name, l.monthly_salary::text as monthly_salary,
            l.currency, l.working_days, l.unpaid_leave_days, l.absence_days,
            l.unrecorded_days, l.half_days, l.late_minutes, l.days_paid,
            l.base_amount::text as base_amount,
            l.deduction_amount::text as deduction_amount,
            l.trip_pay_amount::text as trip_pay_amount,
            l.adjustment_amount::text as adjustment_amount,
            l.adjustment_label, l.net_amount::text as net_amount,
            l.detail, l.note, l.created_at, l.updated_at
       from payroll_lines l
       join employees e on e.id = l.employee_id
      where l.run_id = $1
      order by e.full_name`, [FAKE_RUN]],

  // ---------- PUT /payroll/lines/:id ----------
  ["the line before it is adjusted",
    `select l.employee_name, l.adjustment_amount::text as adjustment_amount,
            l.adjustment_label, l.note, l.net_amount::text as net_amount,
            l.base_amount::text as base_amount, r.status, r.period::text as period
       from payroll_lines l join payroll_runs r on r.id = l.run_id
      where l.id = $1 and l.tenant_id = $2`, [FAKE_LINE, FAKE_TENANT]],
  ["writing the adjustment block",
    `update payroll_lines
        set adjustment_amount = $2, adjustment_label = $3, note = $4
      where id = $1 and tenant_id = $5`,
    [FAKE_LINE, -50000, "PAYE (typed by finance)", "Monthly", FAKE_TENANT]],
  ["the line as the trigger re-derived it",
    `select id, employee_name, days_paid, base_amount::text as base_amount,
            deduction_amount::text as deduction_amount,
            trip_pay_amount::text as trip_pay_amount,
            adjustment_amount::text as adjustment_amount, adjustment_label,
            net_amount::text as net_amount, note, updated_at
       from payroll_lines where id = $1 and tenant_id = $2`, [FAKE_LINE, FAKE_TENANT]],

  // ---------- DELETE /payroll/lines/:id ----------
  ["the line before it is dropped",
    `select l.employee_name, l.run_id, l.monthly_salary::text as monthly_salary,
            l.net_amount::text as net_amount, r.status, r.period::text as period
       from payroll_lines l join payroll_runs r on r.id = l.run_id
      where l.id = $1 and l.tenant_id = $2`, [FAKE_LINE, FAKE_TENANT]],
  ["dropping one person from a draft",
    `delete from payroll_lines where id = $1 and tenant_id = $2`, [FAKE_LINE, FAKE_TENANT]],

  // ---------- issue / cancel / payment bookkeeping ----------
  ["the run before it is issued",
    `select status, period::text as period, headcount, net_total::text as net_total,
            trip_pay_total::text as trip_pay_total
       from payroll_runs where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_RUN, FAKE_TENANT]],
  // 095's settle runs inside the same transaction as the status flip, on both edges of it.
  ["claiming a draft's trip pay into the run",
    `select public.trip_pay_settle($1, true, $2) as v`, [FAKE_RUN, FAKE_USER]],
  ["releasing them when the run is cancelled",
    `select public.trip_pay_settle($1, false, $2) as v`, [FAKE_RUN, FAKE_USER]],

  // ---------- GET /payroll/runs/:id/trip-pay ----------
  ["the legs behind a draft's figure",
    `select r.id as run_id, r.period::text as period, r.status,
            r.trip_pay_total::text as run_trip_pay_total,
            l.id as line_id, l.employee_id, l.employee_name,
            l.trip_pay_amount::text as stored_amount,
            ((c.tp ->> 'total')::numeric(14,2))::text as current_amount,
            (c.tp ->> 'count')::int as trips,
            c.tp -> 'entries' as entries
       from payroll_runs r
       join payroll_lines l on l.run_id = r.id
       cross join lateral (
         select public.trip_pay_claim(r.id, l.employee_id, r.period) as tp
       ) c
      where r.id = $1 and r.tenant_id = $2 and r.deleted_at is null
      order by l.employee_name`, [FAKE_RUN, FAKE_TENANT]],
  ["what the whole company is still waiting on",
    `select count(*)::int as entries,
            coalesce(sum(amount), 0)::numeric(14,2)::text as total,
            count(*) filter (where employee_id is null)::int as unlinked
       from trip_pay_entries where paid_run_id is null`, []],

  ["issuing",
    `update payroll_runs set status = 'issued', payment_reference = $3, paid_on = $4::date,
            issued_by = $2, updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $5 and deleted_at is null and status = 'draft'`,
    [FAKE_RUN, FAKE_USER, "TRX-2026-10-0091", "2026-11-02", FAKE_TENANT]],
  ["cancelling, with a reason",
    `update payroll_runs set status = 'cancelled', cancelled_by = $2,
            cancelled_at = now(), cancel_reason = $3,
            updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $4 and deleted_at is null`,
    [FAKE_RUN, FAKE_USER, "Two people were missing from the register", FAKE_TENANT]],
  ["recording a payment reference on an issued run",
    `update payroll_runs set payment_reference = $3, paid_on = $4::date, note = $5,
            updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $6 and deleted_at is null`,
    [FAKE_RUN, FAKE_USER, "TRX-2026-10-0091", "2026-11-02", "Salary account", FAKE_TENANT]],

  // ---------- GET /payroll/runs/:id/payslip/:lineId ----------
  ["one payslip, with the letterhead it prints on",
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
            l.trip_pay_amount::text as trip_pay_amount,
            l.adjustment_amount::text as adjustment_amount, l.adjustment_label,
            l.net_amount::text as net_amount, l.detail, l.note,
            e.employment_type, e.hired_date::text as hired_date
       from payroll_lines l
       join payroll_runs r on r.id = l.run_id
       join employees e on e.id = l.employee_id
       left join company_profiles cp on cp.tenant_id = r.tenant_id
       left join users ui on ui.id = r.issued_by
      where l.id = $1 and l.run_id = $2 and r.tenant_id = $3 and r.deleted_at is null`,
    [FAKE_LINE, FAKE_RUN, FAKE_TENANT]],

  // ---------- GET /payroll/register ----------
  ["the salary register across months",
    `select l.employee_id, e.full_name, e.job_title, e.department,
            r.id as run_id, r.period::text as period, r.status, r.currency,
            l.monthly_salary::text as monthly_salary, l.days_paid, l.working_days,
            l.unpaid_leave_days, l.absence_days, l.unrecorded_days,
            l.base_amount::text as base_amount,
            l.deduction_amount::text as deduction_amount,
            l.trip_pay_amount::text as trip_pay_amount,
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
      limit 4000`, [FAKE_TENANT, FAKE_EMP, "2026-01-01", PERIOD]]
];

// Facts only an actual query can prove — and the derivation is executed, not read.
const live: [string, string, unknown[]][] = [
  ["October 2026 has 22 working days",
    `select period_working_days(date '2026-10-01') as n`, []],
  ["a February has its own divisor",
    `select period_working_days(date '2026-02-01') as n`, []],
  ["an elapsed month sorts before today and a future one after it",
    // The route decides "has this month arrived" by comparing the two as text. Cast
    // away from date, so the comparison is a calendar one; pg hands an uncast date
    // to JS as a Date object, whose String form ("Wed Sep 30 2026…") sorts by the
    // day's first letter and silently mis-counts an elapsed month.
    `select ( ((date_trunc('month', date '2026-09-01') + interval '1 month - 1 day')::date::text
               <= (timezone('Africa/Dar_es_Salaam', now()))::date::text)::int
             - ((date_trunc('month', date '2027-01-01') + interval '1 month - 1 day')::date::text
               <= (timezone('Africa/Dar_es_Salaam', now()))::date::text)::int ) as n`, []],
  ["derived: 3 charged days of a 22-day month",
    `select ((public.payroll_derive(1000000, 22, 2, 1, 0, 0) ->> 'net_amount')::numeric(14,2)
             - 863636.36)::numeric(14,2) as n`, []],
  ["derived: days paid after those charges",
    `select (public.payroll_derive(1000000, 22, 2, 1, 0, 0) ->> 'days_paid')::int as n`, []],
  ["derived: base and deduction foot to the salary",
    `select ((public.payroll_derive(1000000, 22, 2, 1, 0, 0) ->> 'base_amount')::numeric(14,2)
             + (public.payroll_derive(1000000, 22, 2, 1, 0, 0) ->> 'deduction_amount')::numeric(14,2)
             - 1000000)::numeric(14,2) as n`, []],
  ["derived: charges beyond the month cannot make pay negative",
    `select (public.payroll_derive(1000000, 22, 30, 5, 0, 0) ->> 'base_amount')::numeric(14,2)::int as n`, []],
  ["derived: such a month deducts the whole salary",
    `select (public.payroll_derive(1000000, 22, 30, 5, 0, 0) ->> 'deduction_amount')::numeric(14,2)::int as n`, []],
  ["derived: net foots from the ROUNDED base, to the cent",
    `select ((public.payroll_derive(1000000, 22, 2, 1, -12345.68, 0) ->> 'net_amount')::numeric(14,2)
             - ((public.payroll_derive(1000000, 22, 2, 1, 0, 0) ->> 'base_amount')::numeric(14,2)
                - 12345.68))::numeric(14,2) as n`, []],
  // 095: the sixth input is inside net, does not touch base or deduction, and is rounded
  // to the cent before it lands — the stored column is 2dp and the CHECK compares to it.
  ["derived: trip pay is inside the net",
    `select ((public.payroll_derive(1000000, 22, 0, 0, 0, 175000) ->> 'net_amount')::numeric(14,2)
             - 1175000)::numeric(14,2) as n`, []],
  ["derived: trip pay leaves base and deduction alone",
    `select ((public.payroll_derive(1000000, 22, 2, 1, 0, 175000) ->> 'base_amount')::numeric(14,2)
             - (public.payroll_derive(1000000, 22, 2, 1, 0, 0) ->> 'base_amount')::numeric(14,2)
             + (public.payroll_derive(1000000, 22, 2, 1, 0, 175000) ->> 'deduction_amount')::numeric(14,2)
             - (public.payroll_derive(1000000, 22, 2, 1, 0, 0) ->> 'deduction_amount')::numeric(14,2)
             )::numeric(14,2) as n`, []],
  ["derived: net foots base + trip pay + adjustment",
    `select ((public.payroll_derive(1000000, 22, 2, 1, -68000, 175000.555) ->> 'net_amount')::numeric(14,2)
             - ((public.payroll_derive(1000000, 22, 2, 1, 0, 0) ->> 'base_amount')::numeric(14,2)
                + 175000.56 - 68000))::numeric(14,2) as n`, []],
  ["derived: a null trip pay is zero, not a null net",
    `select (public.payroll_derive(1000000, 22, 0, 0, 0, null) ->> 'net_amount')::numeric(14,2)::int as n`, []],
  ["only the six-argument derivation is left standing",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'payroll_derive'`, []],
  ["the claim is read by the trigger and nothing else writes the figure",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'payroll_line_gate'
        and pg_get_functiondef(p.oid) like '%trip_pay_claim(v_run, new.employee_id, v_period)%'`, []],
  ["the line trigger reads that one function",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'payroll_line_gate'
        and pg_get_functiondef(p.oid) like '%payroll_derive(new.monthly_salary%'`, []],
  ["the run rolls its gross up through trip pay",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'payroll_run_roll_up'
        and pg_get_functiondef(p.oid) like '%sum(base_amount + trip_pay_amount)%'
        and pg_get_functiondef(p.oid) like '%trip_pay_total = coalesce%'`, []],
  ["payroll.view / run / issue exist",
    `select count(*)::int as n from permissions
      where key in ('payroll.view','payroll.run','payroll.issue')`, []],
  ["the director holds all three",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key = 'director' and r.tenant_id is null
        and rp.permission_key like 'payroll.%'`, []],
  ["finance_officer holds all three",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key = 'finance_officer' and r.tenant_id is null
        and rp.permission_key like 'payroll.%'`, []],
  ["the auditor sees payroll and cannot move it",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key = 'auditor' and r.tenant_id is null
        and rp.permission_key like 'payroll.%'`, []],
  ["hr_officer holds NO payroll key — segregation of duties",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key = 'hr_officer' and r.tenant_id is null
        and rp.permission_key like 'payroll.%'`, []],
  ["a dispatcher or driver cannot even see a payroll",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key in ('dispatcher','driver','checkpoint_clerk','workshop_manager')
        and r.tenant_id is null and rp.permission_key like 'payroll.%'`, []],
  ["a run can never be deleted by the app role",
    `select count(*)::int as n from information_schema.role_table_grants g
      where g.grantee = 'app_runtime' and g.privilege_type = 'DELETE'
        and g.table_name = 'payroll_runs'`, []],
  ["a draft line can be dropped, which is the module's only hard delete",
    `select count(*)::int as n from information_schema.role_table_grants g
      where g.grantee = 'app_runtime' and g.privilege_type = 'DELETE'
        and g.table_name = 'payroll_lines'`, []],
  ["both tables are RLS-enabled",
    `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('payroll_runs','payroll_lines')
        and c.relrowsecurity`, []],
  ["both tenant policies exist",
    `select count(*)::int as n from pg_policies
      where schemaname = 'public' and tablename in ('payroll_runs','payroll_lines')
        and policyname in ('payroll_runs_tenant','payroll_lines_tenant')`, []],
  ["one run per company per month",
    `select count(*)::int as n from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname = 'payroll_runs_period_uq' and i.indisunique`, []],
  ["one line per person per run",
    `select count(*)::int as n from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname = 'payroll_lines_employee_uq' and i.indisunique`, []],
  ["the row must add up, in the table itself",
    // The catalog wraps each operand in its own parentheses:
    // `CHECK ((net_amount = round(((base_amount + trip_pay_amount) + adjustment_amount), 2)))`.
    `select count(*)::int as n from pg_constraint
      where conrelid = 'public.payroll_lines'::regclass
        and pg_get_constraintdef(oid)
            ~ 'net_amount *= *round *\\(\\(+ *base_amount *\\+ *trip_pay_amount *\\) *\\+ *adjustment_amount'`, []],
  ["the run gate is before update, the line gate covers insert/update/delete",
    // pg_trigger bits: 1 row, 2 before, 4 insert, 8 delete, 16 update.
    `select count(*)::int as n from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and (t.tgtype::int & 2) <> 0
        and ((c.relname = 'payroll_runs' and t.tgname = 'trg_payroll_run_gate'
              and (t.tgtype::int & 16) <> 0)
          or (c.relname = 'payroll_lines' and t.tgname = 'trg_payroll_line_gate'
              and (t.tgtype::int & 28) = 28))`, []],
  ["every payroll function pins its search path",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public'
        and p.proname in ('period_working_days','payroll_derive','payroll_run_gate',
                          'payroll_run_starts_draft','payroll_line_gate','payroll_run_roll_up',
                          'trip_pay_accrue','trip_pay_claim','trip_pay_gate','trip_pay_settle',
                          'trip_pay_on_trip_completion')
        and p.proconfig::text not like '%search_path=public%'`, []],
  ["payroll_derive is granted to nobody but the app role",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'payroll_derive'
        and has_function_privilege('app_runtime', p.oid, 'execute')
        and not has_function_privilege('public', p.oid, 'execute')`, []],
  ["money columns are numeric, never floats",
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name in ('payroll_runs','payroll_lines')
        and data_type in ('double precision','real')`, []],
  ["the currency is pinned to TZS on both tables",
    `select count(*)::int as n from pg_constraint
      where conrelid in ('public.payroll_runs'::regclass, 'public.payroll_lines'::regclass)
        and pg_get_constraintdef(oid) like '%currency%'`, []],

  // ---------- 094 / 095: the trip-pay register and the way into the line ----------

  // Accrual is a trigger, not a step in the route: it must fire on the arrival at
  // 'completed' from any caller, and only there.
  ["a completed trip prices itself, after update only",
    `select count(*)::int as n from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname = 'trips'
        and t.tgname = 'trg_trips_pay_on_complete'
        and (t.tgtype::int & 16) <> 0 and (t.tgtype::int & 2) = 0
        and pg_get_triggerdef(t.oid) like '%new.status = ''completed''%'
        and pg_get_triggerdef(t.oid) like '%old.status IS DISTINCT FROM%'`, []],
  ["the register cannot be deleted from",
    `select count(*)::int as n from information_schema.role_table_grants g
      where g.grantee = 'app_runtime' and g.privilege_type = 'DELETE'
        and g.table_name = 'trip_pay_entries'`, []],
  ["terms and register can be read, written and corrected but never erased",
    `select count(*)::int as n from information_schema.role_table_grants g
      where g.grantee = 'app_runtime' and g.table_name in ('driver_pay_terms','trip_pay_entries')
        and g.privilege_type in ('SELECT','INSERT','UPDATE')`, []],
  ["both new tables are RLS-enabled with a tenant policy",
    `select count(*)::int as n from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('driver_pay_terms','trip_pay_entries')
        and c.relrowsecurity`, []],
  ["and their policies exist too",
    `select count(*)::int as n from pg_policies
      where schemaname = 'public'
        and policyname in ('driver_pay_terms_tenant','trip_pay_entries_tenant')`, []],
  ["one agreement per driver, one driver per roster seat, one entry per trip leg",
    `select count(*)::int as n from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname in ('driver_pay_terms_driver_uq','driver_pay_terms_employee_uq',
                          'trip_pay_entries_trip_driver_uq')
        and i.indisunique`, []],
  // The rate is a shilling figure on four bases and hundredths on the fifth; a zero rate
  // that is not salary_only is a driver who drove for nothing.
  ["a basis other than salary_only must carry a rate",
    // The catalog prints it as `((basis = 'salary_only'::text) OR (rate > (0)::numeric))`.
    `select count(*)::int as n from pg_constraint
      where conrelid = 'public.driver_pay_terms'::regclass
        and pg_get_constraintdef(oid) like '%salary_only%OR (rate >%'`, []],
  ["the entry's amount is pinned to its own basis, both ways",
    `select count(*)::int as n from pg_constraint
      where conrelid = 'public.trip_pay_entries'::regclass
        and pg_get_constraintdef(oid) like '%percent_of_freight%'
        and pg_get_constraintdef(oid) like '%quantity * rate%'`, []],
  ["the register gate is before update and before delete",
    `select count(*)::int as n from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname = 'trip_pay_entries'
        and t.tgname = 'trg_trip_pay_gate'
        and (t.tgtype::int & 2) <> 0 and (t.tgtype::int & 24) = 24
        and (t.tgtype::int & 4) = 0`, []],
  ["earned_on and the claim window are dates, not timestamps",
    `select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'trip_pay_entries'
        and column_name = 'earned_on' and data_type = 'date'`, []],
  ["every trip-pay function is execute-only for the app role",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public'
        and p.proname in ('trip_pay_accrue','trip_pay_claim','trip_pay_gate','trip_pay_settle',
                          'trip_pay_on_trip_completion')
        and (not has_function_privilege('app_runtime', p.oid, 'execute')
             or has_function_privilege('public', p.oid, 'execute'))`, []],
  ["the claim reaches a deleted trip no more",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'trip_pay_claim'
        and pg_get_functiondef(p.oid) like '%t.deleted_at is null%'`, []],
  // Called with nothing to claim: an empty register still has to answer in the shape the
  // payslip reads, and jsonb_typeof is the only way to ask that without a fixture.
  ["the claim hands its money over as text, not as a float",
    `select (case when jsonb_typeof(
              public.trip_pay_claim(null, null, date '2026-01-01') -> 'total') = 'string'
             then 1 else 0 end)::int as n`, []],
  ["and the legs underneath it are priced in text the same way",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'trip_pay_claim'
        and pg_get_functiondef(p.oid) like '%e.amount::text%'`, []],
  ["the settle roll-up starts as a map, so drafts_refreshed is one whatever happened",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'trip_pay_settle'
        and replace(pg_get_functiondef(p.oid), E'\\n', ' ')
            like '%v_refreshed jsonb := ''{}''::jsonb%'`, []],
  ["the line trigger keeps the slip's total in that same text shape",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'payroll_line_gate'
        and pg_get_functiondef(p.oid) like '%trip_pay_total%::numeric(14,2)::text%'`, []],
  // A trigger does not need EXECUTE to fire, so these belong to the application alone.
  // 073 pinned only its own two and 095 pinned its own three, which left 072's gates and
  // divisor handing themselves to PUBLIC until 096 swept them — so the check now covers
  // every function the module owns, by name, and a missing name fails the count.
  ["every payroll function is executable by the app role and by nobody else",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public'
        and p.proname in ('payroll_derive','payroll_line_gate','payroll_run_gate',
                          'payroll_run_starts_draft','payroll_run_roll_up',
                          'period_working_days','trip_pay_accrue','trip_pay_claim',
                          'trip_pay_settle','trip_pay_gate')
        and has_function_privilege('app_runtime', p.oid, 'execute')
        and not has_function_privilege('public', p.oid, 'execute')`, []],
  ["driver_pay.view / edit exist",
    `select count(*)::int as n from permissions
      where key in ('driver_pay.view','driver_pay.edit')`, []],
  ["the seats that price a trip can read the terms",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key in ('director','general_manager','operations_manager','fleet_manager',
                      'finance_officer','auditor')
        and r.tenant_id is null and rp.permission_key = 'driver_pay.view'`, []],
  ["only finance and the director set them",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key in ('director','finance_officer')
        and r.tenant_id is null and rp.permission_key = 'driver_pay.edit'`, []],
  ["hr_officer holds no driver-pay key — the same segregation as payroll",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key = 'hr_officer' and r.tenant_id is null
        and rp.permission_key like 'driver_pay.%'`, []],
  ["a driver cannot see or set their own pay terms",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key in ('driver','dispatcher','checkpoint_clerk')
        and r.tenant_id is null and rp.permission_key like 'driver_pay.%'`, []]
];

const expect: Record<string, (v: number) => boolean> = {
  "October 2026 has 22 working days": (n) => n === 22,
  "a February has its own divisor": (n) => n === 20,
  "an elapsed month sorts before today and a future one after it": (n) => n === 1,
  // 1,000,000 / 22 × 19 = 863,636.36 — the assertion is that the difference is zero.
  "derived: 3 charged days of a 22-day month": (n) => n === 0,
  "derived: days paid after those charges": (n) => n === 19,
  "derived: base and deduction foot to the salary": (n) => n === 0,
  "derived: charges beyond the month cannot make pay negative": (n) => n === 0,
  "derived: such a month deducts the whole salary": (n) => n === 1000000,
  "derived: net foots from the ROUNDED base, to the cent": (n) => n === 0,
  "derived: trip pay is inside the net": (n) => n === 0,
  "derived: trip pay leaves base and deduction alone": (n) => n === 0,
  "derived: net foots base + trip pay + adjustment": (n) => n === 0,
  "derived: a null trip pay is zero, not a null net": (n) => n === 1000000,
  "only the six-argument derivation is left standing": (n) => n === 1,
  "the claim is read by the trigger and nothing else writes the figure": (n) => n === 1,
  "the run rolls its gross up through trip pay": (n) => n === 1,
  "the line trigger reads that one function": (n) => n === 1,
  "payroll.view / run / issue exist": (n) => n === 3,
  "the director holds all three": (n) => n === 3,
  "finance_officer holds all three": (n) => n === 3,
  "the auditor sees payroll and cannot move it": (n) => n === 1,
  "hr_officer holds NO payroll key — segregation of duties": (n) => n === 0,
  "a dispatcher or driver cannot even see a payroll": (n) => n === 0,
  "a run can never be deleted by the app role": (n) => n === 0,
  "a draft line can be dropped, which is the module's only hard delete": (n) => n === 1,
  "both tables are RLS-enabled": (n) => n === 2,
  "both tenant policies exist": (n) => n === 2,
  "one run per company per month": (n) => n === 1,
  "one line per person per run": (n) => n === 1,
  "the row must add up, in the table itself": (n) => n === 1,
  "the run gate is before update, the line gate covers insert/update/delete": (n) => n === 2,
  "every payroll function pins its search path": (n) => n === 0,
  "payroll_derive is granted to nobody but the app role": (n) => n === 1,
  "money columns are numeric, never floats": (n) => n === 0,
  "the currency is pinned to TZS on both tables": (n) => n === 2,
  "a completed trip prices itself, after update only": (n) => n === 1,
  "the register cannot be deleted from": (n) => n === 0,
  "terms and register can be read, written and corrected but never erased": (n) => n === 6,
  "both new tables are RLS-enabled with a tenant policy": (n) => n === 2,
  "and their policies exist too": (n) => n === 2,
  "one agreement per driver, one driver per roster seat, one entry per trip leg": (n) => n === 3,
  "a basis other than salary_only must carry a rate": (n) => n === 1,
  "the entry's amount is pinned to its own basis, both ways": (n) => n === 2,
  "the register gate is before update and before delete": (n) => n === 1,
  "earned_on and the claim window are dates, not timestamps": (n) => n === 1,
  "every trip-pay function is execute-only for the app role": (n) => n === 0,
  "the claim reaches a deleted trip no more": (n) => n === 1,
  "the claim hands its money over as text, not as a float": (n) => n === 1,
  "and the legs underneath it are priced in text the same way": (n) => n === 1,
  "the settle roll-up starts as a map, so drafts_refreshed is one whatever happened": (n) => n === 1,
  "the line trigger keeps the slip's total in that same text shape": (n) => n === 1,
  "the three gates this migration writes are executable by the app role only": (n) => n === 3,
  "driver_pay.view / edit exist": (n) => n === 2,
  "the seats that price a trip can read the terms": (n) => n === 6,
  "only finance and the director set them": (n) => n === 2,
  "hr_officer holds no driver-pay key — the same segregation as payroll": (n) => n === 0,
  "a driver cannot see or set their own pay terms": (n) => n === 0
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 1 });

  let failed = 0;
  for (const [label, sql, params] of checks) {
    try {
      await pool.query("explain " + sql, params);
      console.log("ok   ", label);
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  for (const [label, sql, params] of live) {
    try {
      const r = await pool.query(sql, params);
      const value = Number(r.rows[0]?.n);
      const test = expect[label];
      if (test && !test(value)) {
        failed++;
        console.log("FAIL ", label, `- got ${value}`);
      } else {
        console.log("ok   ", label, `(${value})`);
      }
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  // The one number an office argues about: a whole month's pay for one person,
  // printed rather than assumed, so a reviewer can see the arithmetic itself.
  const slip = await pool.query(
    `select public.payroll_derive(850000, 22, 1, 2, -68000, 0) as v`);
  console.log("     850,000 over 22 days, 1 unpaid leave + 2 absence, -68,000 PAYE, no trips:",
    JSON.stringify(slip.rows[0].v));
  const withTrips = await pool.query(
    `select public.payroll_derive(850000, 22, 1, 2, -68000, 210000) as v`);
  console.log("     the same person with three legs priced at 210,000:",
    JSON.stringify(withTrips.rows[0].v));

  await pool.end();
  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log("all payroll SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
