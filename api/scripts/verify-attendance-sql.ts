/**
 * SQL validation for attendance.routes.ts plus the leave/attendance blocks in
 * notifications.routes.ts — every statement the module can issue is planned
 * against the live schema with EXPLAIN (no writes), and the 065 role matrix plus
 * the date functions are checked by actually reading them.
 * Run: npx tsx scripts/verify-attendance-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_EMP = "33333333-3333-7333-8333-333333333333";
const FAKE_LINE = "44444444-4444-7444-8444-444444444444";
const FAKE_LEAVE = "55555555-5555-7555-8555-555555555555";
const DAY = "2026-10-17";
const FROM = "2026-10-01";
const TO = "2026-10-17";
const AT = "2026-10-17T05:07:00.000Z";

const gate = (key: string) =>
  `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
    where ur.user_id = $1 and rp.permission_key = $2
      and (ur.expires_at is null or ur.expires_at > now()) limit 1`;

const COMPANY_DAY_SQL = `select coalesce(s.work_start, time '08:00')::text as work_start,
            coalesce(s.work_end, time '17:00')::text as work_end,
            coalesce(s.late_grace_minutes, 15)::int as late_grace_minutes,
            coalesce(s.annual_leave_days, 28)::int as annual_leave_days,
            coalesce(s.timezone, 'Africa/Dar_es_Salaam') as timezone,
            (timezone(coalesce(s.timezone, 'Africa/Dar_es_Salaam'), now()))::date::text as today,
            extract(isodow from timezone(coalesce(s.timezone, 'Africa/Dar_es_Salaam'), now()))::int as isodow,
            (s.tenant_id is not null) as saved
       from (values (1)) v
       left join office_settings s on s.tenant_id = $1`;

const checks: [string, string, unknown[]][] = [
  // ---------- permission gates ----------
  ["gate attendance.view", gate("attendance.view"), [FAKE_USER, "attendance.view"]],
  ["gate attendance.clock", gate("attendance.clock"), [FAKE_USER, "attendance.clock"]],
  ["gate attendance.edit", gate("attendance.edit"), [FAKE_USER, "attendance.edit"]],
  ["gate leave.view", gate("leave.view"), [FAKE_USER, "leave.view"]],
  ["gate leave.request", gate("leave.request"), [FAKE_USER, "leave.request"]],
  ["gate leave.decide", gate("leave.decide"), [FAKE_USER, "leave.decide"]],
  ["gate office_settings.manage", gate("office_settings.manage"), [FAKE_USER, "office_settings.manage"]],

  // ---------- the company calendar ----------
  ["office settings read with defaults", COMPANY_DAY_SQL, [FAKE_TENANT]],
  ["a stamp read as a local working day",
    `select (timezone($1, $2::timestamptz))::date::text as d`, ["Africa/Dar_es_Salaam", AT]],
  ["weekday count helper", `select working_days_between($1::date, $2::date) as days`, [FROM, TO]],

  // ---------- roster resolution ----------
  ["own staff record behind a sign-in",
    `select id, full_name, status from employees
      where tenant_id = $1 and user_id = $2 and deleted_at is null
      order by created_at limit 1`, [FAKE_TENANT, FAKE_USER]],
  ["target staff record",
    `select id, full_name, status from employees where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_EMP, FAKE_TENANT]],

  // ---------- GET /attendance/today ----------
  ["today board",
    `select e.id as employee_id, e.full_name, e.job_title, e.department, e.employment_type,
            e.user_id is not null as has_account,
            a.id as attendance_id, a.day_status, a.clock_in, a.clock_out,
            a.minutes_late, a.note,
            (extract(epoch from (a.clock_out - a.clock_in)) / 3600)::float8 as hours_worked,
            lr.id as leave_id, lr.leave_kind, lr.status as leave_status,
            lr.starts_on::text as leave_starts_on, lr.ends_on::text as leave_ends_on
       from employees e
       left join employee_attendance a
         on a.tenant_id = e.tenant_id and a.employee_id = e.id
        and a.deleted_at is null and a.work_date = $2::date
       left join leave_requests lr
         on lr.tenant_id = e.tenant_id and lr.employee_id = e.id
        and lr.deleted_at is null and lr.status = 'approved'
        and $2::date between lr.starts_on and lr.ends_on
      where e.tenant_id = $1 and e.deleted_at is null and e.status = 'active'
      order by e.full_name`, [FAKE_TENANT, DAY]],

  // ---------- GET /attendance/me ----------
  ["own attendance over a period",
    `select a.id, a.work_date::text as work_date, a.day_status, a.clock_in, a.clock_out,
            a.minutes_late, a.note,
            (extract(epoch from (a.clock_out - a.clock_in)) / 3600)::float8 as hours_worked
       from employee_attendance a
      where a.tenant_id = $1 and a.employee_id = $2 and a.deleted_at is null
        and a.work_date between $3::date and $4::date
      order by a.work_date desc`, [FAKE_TENANT, FAKE_EMP, FROM, TO]],
  ["own leave queue and history",
    `select id, leave_kind, starts_on::text as starts_on, ends_on::text as ends_on,
            working_days, status, reason, decision_note
       from leave_requests
      where tenant_id = $1 and employee_id = $2 and deleted_at is null
        and (status = 'pending' or ends_on >= $3::date)
      order by starts_on desc limit 40`, [FAKE_TENANT, FAKE_EMP, FROM]],
  ["own annual days taken",
    `select coalesce(sum(working_days), 0)::int as days
       from leave_requests
      where tenant_id = $1 and employee_id = $2 and deleted_at is null
        and status = 'approved' and leave_kind = 'annual'
        and extract(year from starts_on) = $3::int`, [FAKE_TENANT, FAKE_EMP, 2026]],

  // ---------- GET /attendance ----------
  ["register lines",
    `select a.id, a.employee_id, e.full_name, e.job_title, e.department,
            e.employment_type, a.work_date::text as work_date, a.day_status,
            a.clock_in, a.clock_out, a.minutes_late, a.note,
            (extract(epoch from (a.clock_out - a.clock_in)) / 3600)::float8 as hours_worked
       from employee_attendance a
       join employees e on e.id = a.employee_id
      where a.tenant_id = $1 and a.deleted_at is null
        and a.work_date between $2::date and $3::date
        and ($4::uuid is null or a.employee_id = $4)
        and ($5::text is null or a.day_status = $5)
      order by a.work_date desc, e.full_name
      limit 3000`, [FAKE_TENANT, FROM, TO, FAKE_EMP, "present"]],
  ["register totals per person",
    `select a.employee_id, e.full_name,
            count(*)::int as days,
            count(*) filter (where a.day_status in ('present','late'))::int as present_days,
            count(*) filter (where a.day_status = 'late')::int as late_days,
            count(*) filter (where a.day_status = 'half_day')::int as half_days,
            count(*) filter (where a.day_status = 'absent')::int as absent_days,
            count(*) filter (where a.day_status = 'on_leave')::int as leave_days,
            count(*) filter (where a.day_status = 'holiday')::int as holiday_days,
            count(*) filter (where a.clock_in is not null)::int as clocked_days,
            coalesce(sum(a.minutes_late), 0)::int as minutes_late,
            coalesce(sum(extract(epoch from (a.clock_out - a.clock_in))), 0)::float8 / 3600 as hours_worked
       from employee_attendance a
       join employees e on e.id = a.employee_id
      where a.tenant_id = $1 and a.deleted_at is null
        and a.work_date between $2::date and $3::date
        and ($4::uuid is null or a.employee_id = $4)
      group by a.employee_id, e.full_name
      order by e.full_name`, [FAKE_TENANT, FROM, TO, null]],
  ["leave overlapping a period",
    `select l.id, l.employee_id, e.full_name, l.leave_kind, l.status,
            l.starts_on::text as starts_on, l.ends_on::text as ends_on, l.working_days
       from leave_requests l
       join employees e on e.id = l.employee_id
      where l.tenant_id = $1 and l.deleted_at is null
        and l.status in ('pending','approved')
        and l.starts_on <= $3::date and l.ends_on >= $2::date
      order by l.starts_on`, [FAKE_TENANT, FROM, TO]],

  // ---------- clocking ----------
  ["a person's line for one day",
    `select id, clock_in, clock_out, day_status from employee_attendance
      where tenant_id = $1 and employee_id = $2 and work_date = $3::date and deleted_at is null`,
    [FAKE_TENANT, FAKE_EMP, DAY]],
  ["closing an open clock-in",
    `update employee_attendance
        set clock_in = $2, day_status = 'present', note = coalesce(note, $3),
            updated_by = $4, updated_at = now()
      where id = $1 and tenant_id = $5`,
    [FAKE_LINE, AT, "Self clock-in", FAKE_USER, FAKE_TENANT]],
  ["opening a line for the day",
    `insert into employee_attendance
       (id, tenant_id, employee_id, work_date, clock_in, day_status, note, created_by, updated_by)
     values ($1, $2, $3, $4::date, $5, 'present', $6, $7, $7)`,
    [FAKE_LINE, FAKE_TENANT, FAKE_EMP, DAY, AT, "Self clock-in", FAKE_USER]],
  ["the stamped line read back",
    `select work_date::text as work_date, day_status, clock_in, clock_out, minutes_late,
            (extract(epoch from (clock_out - clock_in)) / 3600)::float8 as hours_worked
       from employee_attendance where id = $1 and tenant_id = $2`, [FAKE_LINE, FAKE_TENANT]],
  ["closing the day",
    `update employee_attendance set clock_out = $2, updated_by = $3, updated_at = now()
      where id = $1 and tenant_id = $4`,
    [FAKE_LINE, "2026-10-17T10:30:00.000Z", FAKE_USER, FAKE_TENANT]],

  // ---------- a stated day ----------
  ["stating a day on an existing line",
    `update employee_attendance
        set day_status = $3,
            clock_in   = coalesce($4, clock_in),
            clock_out  = coalesce($5, clock_out),
            note       = coalesce($6, note),
            updated_by = $7, updated_at = now()
      where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_LINE, FAKE_TENANT, "absent", null, null, "Absent without notice", FAKE_USER]],
  ["stating a day that was never recorded",
    `insert into employee_attendance
       (id, tenant_id, employee_id, work_date, day_status, clock_in, clock_out, note, created_by, updated_by)
     values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $9)`,
    [FAKE_LINE, FAKE_TENANT, FAKE_EMP, DAY, "holiday", null, null, "Eid", FAKE_USER]],

  // ---------- correcting a line ----------
  ["a correction with a fresh stamp",
    `update employee_attendance
        set updated_by = $2, updated_at = now(), work_date = $4, day_status = $5,
            clock_in = $6, clock_out = $7, note = $8, minutes_late = null
      where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_LINE, FAKE_USER, FAKE_TENANT, FROM, "late", AT, "2026-10-17T10:30:00.000Z", "Fixed by HR"]],

  // ---------- leave ----------
  ["leave queue",
    `select l.id, l.employee_id, e.full_name, e.job_title, e.department,
            l.leave_kind, l.starts_on::text as starts_on, l.ends_on::text as ends_on,
            l.working_days, l.reason, l.status, l.decision_note, l.created_at,
            l.decided_by, u.full_name as decided_by_name, l.decided_at,
            (l.created_by = $6::uuid or e.user_id = $6::uuid) as mine
       from leave_requests l
       join employees e on e.id = l.employee_id
       left join users u on u.id = l.decided_by
      where l.tenant_id = $1 and l.deleted_at is null
        and ($2::text is null or l.status = $2)
        and ($3::uuid is null or l.employee_id = $3)
        and ($4::date is null or l.ends_on >= $4)
        and ($5::date is null or l.starts_on <= $5)
      order by case when l.status = 'pending' then 0 else 1 end,
               l.starts_on desc, l.created_at desc
      limit 500`, [FAKE_TENANT, "pending", FAKE_EMP, FROM, TO, FAKE_USER]],
  ["the active roster for balances",
    `select id as employee_id, full_name, job_title, department
       from employees
      where tenant_id = $1 and deleted_at is null and status = 'active'
      order by full_name`, [FAKE_TENANT]],
  ["days taken and queued, per person and kind",
    `select employee_id, leave_kind, status,
            coalesce(sum(working_days), 0)::int as days, count(*)::int as requests
       from leave_requests
      where tenant_id = $1 and deleted_at is null
        and status in ('approved','pending')
        and extract(year from starts_on) = $2::int
      group by employee_id, leave_kind, status`, [FAKE_TENANT, 2026]],
  ["raising a request",
    `insert into leave_requests
       (id, tenant_id, employee_id, leave_kind, starts_on, ends_on, reason, created_by, updated_by)
     values ($1, $2, $3, $4, $5::date, $6::date, $7, $8, $8)`,
    [FAKE_LEAVE, FAKE_TENANT, FAKE_EMP, "annual", "2026-12-21", "2026-12-28", "Home for the holidays", FAKE_USER]],
  ["a request read back",
    `select l.id, l.employee_id, e.full_name, l.leave_kind, l.starts_on::text as starts_on,
            l.ends_on::text as ends_on, l.working_days, l.status, l.reason
       from leave_requests l join employees e on e.id = l.employee_id
      where l.id = $1 and l.tenant_id = $2`, [FAKE_LEAVE, FAKE_TENANT]],
  ["editing a pending request",
    `update leave_requests set updated_by = $2, updated_at = now(), starts_on = $4, ends_on = $5,
            leave_kind = $6, reason = $7
      where id = $1 and tenant_id = $3`,
    [FAKE_LEAVE, FAKE_USER, FAKE_TENANT, "2026-12-22", "2026-12-30", "annual", "Dates moved"]],
  ["deciding a request",
    `update leave_requests set status = $4, decided_by = $2, decided_at = now(),
            decision_note = $5, updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_LEAVE, FAKE_USER, FAKE_TENANT, "approved", "Cover arranged"]],
  ["cancelling a request",
    `update leave_requests set status = 'cancelled',
            decision_note = coalesce($4, decision_note),
            updated_by = $2, updated_at = now()
      where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_LEAVE, FAKE_USER, FAKE_TENANT, "Plans changed"]],

  // ---------- office settings ----------
  ["a timezone the server knows",
    `select name from pg_timezone_names where name = $1 limit 1`, ["Africa/Dar_es_Salaam"]],
  ["the working day upsert",
    `insert into office_settings
       (tenant_id, work_start, work_end, late_grace_minutes, annual_leave_days, timezone, updated_by)
     values ($1, $2::time, $3::time, $4, $5, $6, $7)
     on conflict (tenant_id) do update set
       work_start = excluded.work_start, work_end = excluded.work_end,
       late_grace_minutes = excluded.late_grace_minutes,
       annual_leave_days = excluded.annual_leave_days,
       timezone = excluded.timezone, updated_by = excluded.updated_by, updated_at = now()`,
    [FAKE_TENANT, "08:00", "17:00", 15, 28, "Africa/Dar_es_Salaam", FAKE_USER]],

  // ---------- the two new alerts ----------
  ["alert: the leave queue",
    `select count(*)::int as n, min(starts_on)::text as first_starts
       from leave_requests
      where tenant_id = $1 and deleted_at is null and status = 'pending'`, [FAKE_TENANT]],
  ["alert: today's empty register",
    `select (timezone(coalesce(s.timezone, 'Africa/Dar_es_Salaam'), now()))::date::text as today,
            extract(isodow from timezone(coalesce(s.timezone, 'Africa/Dar_es_Salaam'), now()))::int as isodow,
            coalesce((
              select count(*)::int from employees e
               where e.tenant_id = $1 and e.deleted_at is null and e.status = 'active'
                 and not exists (
                   select 1 from employee_attendance a
                    where a.tenant_id = e.tenant_id and a.employee_id = e.id
                      and a.deleted_at is null
                      and a.work_date = (timezone(coalesce(s.timezone, 'Africa/Dar_es_Salaam'), now()))::date)
                 and not exists (
                   select 1 from leave_requests lr
                    where lr.tenant_id = e.tenant_id and lr.employee_id = e.id
                      and lr.deleted_at is null and lr.status = 'approved'
                      and (timezone(coalesce(s.timezone, 'Africa/Dar_es_Salaam'), now()))::date
                          between lr.starts_on and lr.ends_on)
            ), 0)::int as missing
       from (values (1)) v
       left join office_settings s on s.tenant_id = $1`, [FAKE_TENANT]]
];

// Read-only facts about 065 that only an actual query can prove.
const live: [string, string, unknown[]][] = [
  ["working days in a Mon–Fri week", `select working_days_between(date '2026-10-19', date '2026-10-25') as n`, []],
  ["a weekend only counts its weekdays", `select working_days_between(date '2026-10-17', date '2026-10-18') as n`, []],
  ["hr_officer holds the people matrix",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key = 'hr_officer' and r.tenant_id is null
        and rp.permission_key in ('attendance.edit','leave.decide','office_settings.manage',
                                  'employees.create','evaluations.create')`, []],
  ["hr_officer holds none of the money or the delete keys",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key = 'hr_officer' and r.tenant_id is null
        and (rp.permission_key like '%.delete'
             or rp.permission_key like 'office_costs%'
             or rp.permission_key like 'invoices%'
             or rp.permission_key like 'ledger%'
             or rp.permission_key like 'payments%')`, []],
  ["a dispatcher can clock in and ask for leave, nothing else",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key = 'dispatcher' and r.tenant_id is null
        and rp.permission_key in ('attendance.clock','attendance.view','leave.request','leave.view')`, []],
  ["a dispatcher cannot decide leave or correct a register",
    `select count(*)::int as n from roles r
       join role_permissions rp on rp.role_id = r.id
      where r.key = 'dispatcher' and r.tenant_id is null
        and rp.permission_key in ('attendance.edit','leave.decide','office_settings.manage')`, []],
  ["attendance and leave are write-only, never deletable",
    `select count(*)::int as n from information_schema.role_table_grants g
      where g.grantee = 'app_runtime' and g.privilege_type = 'DELETE'
        and g.table_name in ('employee_attendance','leave_requests','office_settings')`, []],
  ["the three tables are RLS-enabled",
    `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('employee_attendance','leave_requests','office_settings')
        and c.relrowsecurity`, []],
  ["065's permission keys all exist",
    `select count(*)::int as n from permissions
      where key in ('attendance.view','attendance.clock','attendance.edit','leave.view',
                    'leave.request','leave.decide','office_settings.manage')`, []],
  ["the lateness stamp reads the company clock, not UTC",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'attendance_stamp_lateness'
        and pg_get_functiondef(p.oid) like '%timezone(v_zone%'`, []],
  ["the future-day guard reads the company date, not current_date",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public' and p.proname = 'attendance_no_future'
        and pg_get_functiondef(p.oid) like '%office_settings%'`, []],
  ["every 065 function pins its search path",
    `select count(*)::int as n from pg_proc p
       join pg_namespace gn on gn.oid = p.pronamespace
      where gn.nspname = 'public'
        and p.proname in ('working_days_between','leave_stamp_working_days','leave_no_overlap',
                          'attendance_stamp_lateness','attendance_no_future')
        and p.proconfig::text not like '%search_path=public%'`, []]
];

const expect: Record<string, (v: number) => boolean> = {
  "working days in a Mon–Fri week": (n) => n === 5,
  "a weekend only counts its weekdays": (n) => n === 0,
  "hr_officer holds the people matrix": (n) => n === 5,
  "hr_officer holds none of the money or the delete keys": (n) => n === 0,
  "a dispatcher can clock in and ask for leave, nothing else": (n) => n === 4,
  "a dispatcher cannot decide leave or correct a register": (n) => n === 0,
  "attendance and leave are write-only, never deletable": (n) => n === 0,
  "the three tables are RLS-enabled": (n) => n === 3,
  "065's permission keys all exist": (n) => n === 7,
  "the lateness stamp reads the company clock, not UTC": (n) => n === 1,
  "the future-day guard reads the company date, not current_date": (n) => n === 1,
  "every 065 function pins its search path": (n) => n === 0
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

  for (const [label, sql] of live) {
    try {
      const r = await pool.query(sql);
      const value = Number(r.rows[0]?.n ?? r.rows[0]?.d);
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

  // The one probe EXPLAIN cannot stand in for: the day-boundary read has to
  // actually run to show the wall clock crossing a date line.
  const crossing = await pool.query(
    `select (timezone('Africa/Dar_es_Salaam', timestamptz '2026-10-17T22:00:00Z'))::date::text as d`);
  console.log("     Oct 17 22:00Z in Dar es Salaam is", crossing.rows[0].d);
  if (crossing.rows[0].d !== "2026-10-18") {
    failed++;
    console.log("FAIL the local date boundary");
  }

  await pool.end();
  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log("all attendance SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
