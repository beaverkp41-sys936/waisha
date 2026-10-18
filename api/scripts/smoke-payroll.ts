/**
 * Payroll smoke — migrations 072/073 and payroll.routes.ts walked for end to end.
 *
 * It runs on a throwaway company it creates and destroys, because a payroll is not
 * test data you may write into somebody else's live tenant: 072 keeps one run per
 * company per month and an issued run is a record that people were paid.
 *
 * What it exists to prove:
 *  - the preview and the build agree. `GET /payroll/preview` and the line trigger
 *    read the same `payroll_derive` (073), so the figure shown before a month is
 *    committed is the figure that lands on the payslip — asserted line by line,
 *    which is the only thing that keeps "one copy of the arithmetic" honest;
 *  - the month that is counted is the month that arrived. The bounds come back as
 *    text dates on purpose: a last day of September that compared against today as
 *    a JS Date string would count forty days of a thirty-day month, and every
 *    figure under it would be wrong in a way nobody sees;
 *  - only two things cost a day. Approved unpaid leave and a recorded absence are
 *    charged; a weekday with no attendance row at all is reported as an unrecorded
 *    day and costs nothing, so a clerk's forgetting cannot reduce somebody's pay;
 *  - the office cannot type a payslip figure. Only the labelled adjustment block is
 *    writable, an unexplained one is refused, and the run's totals foot from lines;
 *  - issued is frozen. Lines, period and rebuild are all refused after issue, and
 *    the only way out is a cancel that names a person and a reason;
 *  - the matrix holds. hr_officer — the seat that owns the register and the leave
 *    queue — sees no payroll at all, which is the segregation 072 chose deliberately.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-payroll.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const COMPANY = `Payroll Smoke Haulers Ltd ${STAMP}`;
const SWEEP = `Payroll Smoke %`;

const FULL = `Payroll Smoke Full ${STAMP}`;      // never charged: no register at all
const ABSENT = `Payroll Smoke Absent ${STAMP}`;  // two recorded absences
const UNPAID = `Payroll Smoke Unpaid ${STAMP}`;  // three days of approved unpaid leave
const LATE = `Payroll Smoke Half ${STAMP}`;      // half days and lateness, charged nothing
const NO_PAY = `Payroll Smoke Unpaid Rate ${STAMP}`; // on the roster, no salary on file
const LEFT = `Payroll Smoke Leaver ${STAMP}`;    // inactive, must not appear

const SAL_FULL = 1_000_000;
const SAL_ABSENT = 800_000;
const SAL_UNPAID = 500_000;
const SAL_LATE = 250_000;
const SAL_LEFT = 900_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) =>
  iso(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000));
const firstOfMonth = (s: string) => `${s.slice(0, 7)}-01`;
const addMonths = (s: string, n: number) =>
  iso(new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1 + n, 1)));
const lastOfMonth = (s: string) =>
  iso(new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0)));
const isWeekday = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
};
const weekdaysBetween = (from: string, to: string) => {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWeekday(d)) n++;
  return n;
};

/** Lines are keyed by the person they belong to, so an assertion can name somebody. */
const byId = (rows: any[]) =>
  Object.fromEntries((rows ?? []).map((r) => [r.employee_name, r.id]));

/**
 * The expected money, computed here in JavaScript as an independent witness. The
 * point is that it is written twice, in two languages: if 073's function and the
 * build ever drift apart, this suite is the thing that says so.
 */
function expect(salary: number, divisor: number, unpaid: number, absent: number, adjustment = 0) {
  const charged = Math.min(divisor, unpaid + absent);
  const daysPaid = Math.max(0, divisor - charged);
  const base = Math.round((salary * daysPaid / divisor) * 100) / 100;
  const deduction = Math.round((salary * (divisor - daysPaid) / divisor) * 100) / 100;
  return {
    days_paid: daysPaid,
    base_amount: base.toFixed(2),
    deduction_amount: deduction.toFixed(2),
    net_amount: (Math.round((base + adjustment) * 100) / 100).toFixed(2)
  };
}

/**
 * Lines are cascade-bound to their run and 073's trigger refuses to delete a line
 * whose run is issued, so a run is cancelled before its rows can be taken away —
 * the same exit the module gives a real office. Without this, a crashed earlier run
 * would leave an issued payroll the teardown cannot clear.
 */
async function wipeTenantRows(oi: (sql: string, params?: any[]) => Promise<any>, ids: string[]) {
  await oi(`update payroll_runs set status = 'cancelled',
                   cancelled_by = coalesce(cancelled_by, $2::uuid),
                   cancelled_at = coalesce(cancelled_at, now()),
                   cancel_reason = coalesce(cancel_reason, 'Smoke teardown')
              where tenant_id = any($1::uuid[]) and status = 'issued'`,
    [ids, randomUUID()]).catch(() => { });
  for (const sql of [
    `delete from payroll_lines where tenant_id = any($1::uuid[])`,
    `delete from payroll_runs where tenant_id = any($1::uuid[])`,
    `delete from employee_attendance where tenant_id = any($1::uuid[])`,
    `delete from leave_requests where tenant_id = any($1::uuid[])`,
    `delete from office_settings where tenant_id = any($1::uuid[])`,
    `delete from company_profiles where tenant_id = any($1::uuid[])`
  ]) await oi(sql, [ids]).catch(() => { });
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = async (sql: string, params: any[] = []) => owner.query(sql, params);

  const roleOf = async (k: string) => (await oi(
    `select id from roles where key = $1 and tenant_id is null`, [k])).rows[0]?.id;
  const directorRole = await roleOf("director");
  const financeRole = await roleOf("finance_officer");
  const hrRole = await roleOf("hr_officer");
  const auditorRole = await roleOf("auditor");
  if (!directorRole || !financeRole || !hrRole || !auditorRole) {
    throw new Error("director / finance_officer / hr_officer / auditor role missing");
  }

  const T = randomUUID();
  const uDirector = randomUUID();
  const uFinance = randomUUID();
  const uHr = randomUUID();
  const uAuditor = randomUUID();
  const FOREIGN = "00000000-0000-7000-8000-000000000000";

  // A crashed run leaves its own stamp behind, and a stale draft for the same month
  // would make "build the month" answer 409 before the first real assertion ran.
  const sweep = async () => {
    const ids = (await oi(`select id from tenants where name like $1`, [SWEEP]))
      .rows.map((r: any) => r.id);
    if (!ids.length) return;
    await wipeTenantRows(oi, ids);
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [ids]))
      .rows.map((r: any) => r.id);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    }
    const eids = (await oi(`select id from employees where tenant_id = any($1::uuid[])`, [ids]))
      .rows.map((r: any) => r.id);
    if (eids.length) await oi(`delete from employees where id = any($1::uuid[])`, [eids]);
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [ids]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [ids]);
  };
  await sweep();
  await oi(`delete from rate_limits where bucket like 'payroll-build%'`).catch(() => { });

  // ---------- the month under test: the one that has entirely arrived ----------
  const period = firstOfMonth(addDays(firstOfMonth(iso(new Date())), -1));
  const monthEnd = lastOfMonth(period);
  const divisor = weekdaysBetween(period, monthEnd);
  // The month the office is standing in, and the one that has not begun. Which of
  // them can be paid against is decided by a date comparison in the route.
  const thisMonth = addMonths(period, 1);
  const nextMonth = addMonths(period, 2);
  // A month with nobody charged, used to empty a run through the API and prove an
  // empty document cannot be signed.
  const quietPeriod = firstOfMonth(addDays(period, -60));
  const quietDivisor = weekdaysBetween(quietPeriod, lastOfMonth(quietPeriod));

  await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`,
    [T, COMPANY]);
  await oi(`insert into company_profiles (id, tenant_id, company_name) values ($1,$2,$3)`,
    [randomUUID(), T, COMPANY]);
  // 065's defaults are the tested ones: the divisor and the lateness grace both read
  // this row, and a smoke that left it out would judge the module against nothing.
  await oi(`insert into office_settings (tenant_id, work_start, work_end, late_grace_minutes,
             annual_leave_days, timezone)
           values ($1, time '08:00', time '17:00', 15, 28, 'Africa/Dar_es_Salaam')`, [T]);

  const seats: [string, string, string, string, string][] = [
    [uDirector, "director", "Payroll Smoke Director", `pay.d.${STAMP}@waisha.test`, directorRole],
    [uFinance, "staff", "Payroll Smoke Finance", `pay.f.${STAMP}@waisha.test`, financeRole],
    [uHr, "staff", "Payroll Smoke HR", `pay.h.${STAMP}@waisha.test`, hrRole],
    [uAuditor, "staff", "Payroll Smoke Auditor", `pay.a.${STAMP}@waisha.test`, auditorRole]
  ];
  for (const [id, type, name, email, role] of seats) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
              values ($1,$2,$3,$4,'active',$5)`, [id, T, type, name, email]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, role]);
  }

  const staff: [string, string, number][] = [
    [FULL, "Accounts clerk", SAL_FULL],
    [ABSENT, "Driver", SAL_ABSENT],
    [UNPAID, "Dispatcher", SAL_UNPAID],
    [LATE, "Messenger", SAL_LATE]
  ];
  const empId: Record<string, string> = {};
  for (const [name, title, salary] of staff) {
    const id = randomUUID();
    empId[name] = id;
    await oi(`insert into employees (id, tenant_id, full_name, job_title, department,
               employment_type, status, monthly_salary, hired_date)
             values ($1,$2,$3,$4,'Office','permanent','active',$5, date '2024-01-15')`,
      [id, T, name, title, salary]);
  }
  // On the roster, paid nothing: the build must name it as skipped rather than
  // leave a person quietly missing from a salary run.
  empId[NO_PAY] = randomUUID();
  await oi(`insert into employees (id, tenant_id, full_name, job_title, department,
               employment_type, status, monthly_salary, hired_date)
             values ($1,$2,$3,'Office assistant','Office','permanent','active',null,
                     date '2024-01-15')`, [empId[NO_PAY], T, NO_PAY]);
  // Someone who left before the month: paid for their last month elsewhere, never in this run.
  empId[LEFT] = randomUUID();
  await oi(`insert into employees (id, tenant_id, full_name, job_title, department,
             employment_type, status, monthly_salary)
           values ($1,$2,$3,'Driver','Office','permanent','left',$4)`,
    [empId[LEFT], T, LEFT, SAL_LEFT]);

  // ---------- what the register and the leave queue say about that month ----------
  // Every fixture day below is picked out of the month's own working days. A leave
  // that runs Friday to Sunday is one charged day, not three — 065's trigger counts
  // weekdays and the payroll reads that count, so a fixture that straddles a weekend
  // tests the calendar, not the money.
  const workdays = (() => {
    const out: string[] = [];
    for (let d = period; d <= monthEnd; d = addDays(d, 1)) if (isWeekday(d)) out.push(d);
    return out;
  })();
  const absences = [workdays[0], workdays[1]];
  for (const day of absences) {
    await oi(`insert into employee_attendance
                (id, tenant_id, employee_id, work_date, day_status, note, created_by, updated_by)
              values ($1,$2,$3,$4::date,'absent','Smoke no-show',$5,$5)`,
      [randomUUID(), T, empId[ABSENT], day, uDirector]);
  }
  // Approved unpaid leave, three working days — decided the way the desk decides it,
  // then the row is read by the build exactly as a granted request would be.
  const leaveStart = workdays[3];
  const leaveEnd = workdays[5];
  await oi(`insert into leave_requests
              (id, tenant_id, employee_id, leave_kind, starts_on, ends_on, status, reason,
               decided_by, decided_at, created_by, updated_by)
            values ($1,$2,$3,'unpaid',$4::date,$5::date,'approved','Smoke unpaid leave',
                    $6, now(), $6, $6)`,
    [randomUUID(), T, empId[UNPAID], leaveStart, leaveEnd, uHr]);
  // A day that was clocked late and a half day: both reported, neither charged.
  await oi(`insert into employee_attendance
              (id, tenant_id, employee_id, work_date, clock_in, clock_out, day_status,
               note, created_by, updated_by)
            values ($1,$2,$3,$4::date, $5, $6, 'late','Smoke late arrival',$7,$7)`,
    [randomUUID(), T, empId[LATE], workdays[0],
     `${workdays[0]}T05:40:00.000Z`, `${workdays[0]}T10:00:00.000Z`, uHr]);
  await oi(`insert into employee_attendance
              (id, tenant_id, employee_id, work_date, day_status, note, created_by, updated_by)
            values ($1,$2,$3,$4::date,'half_day','Smoke half day',$5,$5)`,
    [randomUUID(), T, empId[LATE], workdays[1], uHr]);

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);
  const tokD = await mint(uDirector, T, ["director"]);
  const tokF = await mint(uFinance, T, ["finance_officer"]);
  const tokH = await mint(uHr, T, ["hr_officer"]);
  const tokR = await mint(uAuditor, T, ["auditor"]);
  const tokForeign = await mint(uDirector, FOREIGN, ["director"]);

  let runId = "";
  let lineIds: Record<string, string> = {};

  try {
    phase("the seats that payroll is not for");
    const anon = await call("/payroll/runs", null);
    check("the register of runs without auth → 401", anon.status === 401, anon.status);

    const hrView = await call("/payroll/runs", tokH);
    check("hr_officer — the seat that owns the register and the leave queue — sees no payroll",
      hrView.status === 403, hrView.status);
    const hrBuild = await call("/payroll/runs", tokH, {
      method: "POST", body: JSON.stringify({ period })
    });
    check("hr_officer cannot build a payroll run → 403", hrBuild.status === 403, hrBuild.status);
    const hrPreview = await call(`/payroll/preview?period=${period}`, tokH);
    check("nor even preview what the register would cost → 403",
      hrPreview.status === 403, hrPreview.status);

    const auditorBuild = await call("/payroll/runs", tokR, {
      method: "POST", body: JSON.stringify({ period })
    });
    check("the auditor can look but not run → 403", auditorBuild.status === 403, auditorBuild.status);
    const auditorList = await call("/payroll/runs", tokR);
    check("and does see the register of runs → 200", auditorList.status === 200, auditorList.status);

    const financeList = await call("/payroll/runs", tokF);
    check("finance_officer reads the runs it is trusted to build → 200",
      financeList.status === 200, financeList.status);

    const foreign = await call(`/payroll/preview?period=${period}`, tokForeign);
    check("another company's director gets nothing from this payroll",
      foreign.status === 200
        ? (foreign.json?.lines ?? []).length === 0
        : foreign.status === 403 || foreign.status === 404,
      { s: foreign.status, lines: foreign.json?.lines?.length });

    phase("the month is previewed before anyone commits to it");
    const prev = await call(`/payroll/preview?period=${period}`, tokD);
    check("preview → 200", prev.status === 200, prev.json);
    const companyToday = String(prev.json?.bounds?.today ?? "");
    check("the month counted is whole: its divisor and its last day",
      prev.json?.bounds?.workingDays === divisor
        && prev.json?.bounds?.countedUpTo === monthEnd,
      prev.json?.bounds);
    const prevLines: any[] = prev.json?.lines ?? [];
    check("the four people with a salary are in it and the leaver is not",
      prevLines.length === 4 && !prevLines.some((l) => l.employee_name === LEFT),
      prevLines.map((l) => l.employee_name));
    check("the person with no salary on file is named as skipped, not silently missing",
      (prev.json?.skipped ?? []).some((s: any) => s.full_name === NO_PAY),
      prev.json?.skipped);

    const byName = (rows: any[]) =>
      Object.fromEntries((rows ?? []).map((r) => [r.employee_name, r]));
    const pv = byName(prevLines);
    check("a clean month costs nothing: unrecorded days are reported and not charged",
      pv[FULL]?.unrecorded_days === divisor && pv[FULL]?.absence_days === 0
        && pv[FULL]?.days_paid === divisor && pv[FULL]?.net_amount === SAL_FULL.toFixed(2),
      pv[FULL]);
    check("two recorded absences are charged against the divisor",
      pv[ABSENT]?.absence_days === 2 && pv[ABSENT]?.days_paid === divisor - 2, pv[ABSENT]);
    check("three approved unpaid-leave days are charged",
      pv[UNPAID]?.unpaid_leave_days === 3 && pv[UNPAID]?.days_paid === divisor - 3, pv[UNPAID]);
    check("a late arrival and a half day are shown and charge nothing",
      pv[LATE]?.half_days === 1 && Number(pv[LATE]?.late_minutes) > 0
        && pv[LATE]?.days_paid === divisor, pv[LATE]);
    check("the dates that were charged are on the line, so a dispute is settled by reading",
      (pv[ABSENT]?.detail?.absence_dates ?? []).length === 2
        && (pv[UNPAID]?.detail?.unpaid_leave_dates ?? []).length === 3,
      pv[ABSENT]?.detail);
    for (const [name, salary, unpaid, absent] of [
      [FULL, SAL_FULL, 0, 0], [ABSENT, SAL_ABSENT, 0, 2],
      [UNPAID, SAL_UNPAID, 3, 0], [LATE, SAL_LATE, 0, 0]
    ] as any[]) {
      const want = expect(salary, divisor, unpaid, absent);
      const got = pv[name];
      check(`${name.replace("Payroll Smoke ", "").replace(` ${STAMP}`, "")}: the previewed money is the pro-rata it should be`,
        got?.base_amount === want.base_amount && got?.deduction_amount === want.deduction_amount
          && got?.net_amount === want.net_amount,
        { want, got: got && { base: got.base_amount, ded: got.deduction_amount, net: got.net_amount } });
    }
    check("the preview's own totals foot from its lines",
      prev.json?.totals?.headcount === 4
        && Math.abs(Number(prev.json?.totals?.net_total)
          - prevLines.reduce((s: number, l: any) => s + Number(l.net_amount), 0)) < 0.005,
      prev.json?.totals);
    check("nothing was written by the preview",
      (await oi(`select count(*)::int as n from payroll_lines l join payroll_runs r on r.id = l.run_id
                  where r.tenant_id = $1`, [T])).rows[0].n === 0,
      "a preview that leaves rows behind is a build in disguise");

    const partial = await call(`/payroll/preview?period=${thisMonth}`, tokD);
    check("the month that has partly arrived is counted up to the company's own today, not past it",
      partial.status === 200 && partial.json?.bounds?.countedUpTo === companyToday
        && partial.json?.bounds?.workingDays === weekdaysBetween(thisMonth, lastOfMonth(thisMonth)),
      { s: partial.status, b: partial.json?.bounds });
    check("and a day that has not come round yet is not charged to anybody",
      (partial.json?.lines ?? []).every((l: any) =>
        l.absence_days === 0 && l.unpaid_leave_days === 0),
      (partial.json?.lines ?? []).map((l: any) => `${l.employee_name}:${l.absence_days}`));

    const future = await call(`/payroll/preview?period=${nextMonth}`, tokD);
    check("a month that has not arrived cannot be previewed → 400",
      future.status === 400, future.json);

    const badPeriod = await call(`/payroll/preview?period=${monthEnd}`, tokD);
    check("a period that is not the first of a month is refused → 400",
      badPeriod.status === 400, badPeriod.status);

    phase("the draft is built, and it must match what was shown");
    const built = await call("/payroll/runs", tokD, {
      method: "POST", body: JSON.stringify({ period })
    });
    check("build → 201", built.status === 201, built.json);
    runId = built.json?.id ?? "";
    check("the run opens as a draft with its own divisor",
      built.json?.status === "draft" && built.json?.working_days === divisor,
      { s: built.json?.status, d: built.json?.working_days });
    const bd = byName(built.json?.lines ?? []);
    let drift = "";
    for (const name of [FULL, ABSENT, UNPAID, LATE]) {
      const a = pv[name], b = bd[name];
      if (!a || !b) { drift = `${name} missing from one side`; break; }
      for (const col of ["days_paid", "base_amount", "deduction_amount", "net_amount"]) {
        if (String(a[col]) !== String(b[col])) {
          drift = `${name} ${col}: preview ${a[col]} vs built ${b[col]}`;
          break;
        }
      }
      if (drift) break;
    }
    check("every line the preview promised is exactly the line the build wrote",
      drift === "", drift);
    check("the run's totals foot from its own lines, and nobody typed them",
      built.json?.headcount === 4
        && Math.abs(Number(built.json?.net_total)
          - (built.json?.lines ?? []).reduce((s: number, l: any) => s + Number(l.net_amount), 0)) < 0.005,
      { headcount: built.json?.headcount, net: built.json?.net_total });
    check("the build counts the lines that have gaps so the desk is told",
      built.json?.lines_with_gaps === 4, built.json?.lines_with_gaps);

    lineIds = byId(built.json?.lines ?? []);

    const again = await call("/payroll/runs", tokD, {
      method: "POST", body: JSON.stringify({ period })
    });
    check("a second build of the same month is refused, and points at rebuild",
      again.status === 409 && /rebuild_instead/.test(JSON.stringify(again.json)), again.json);

    const badBody = await call("/payroll/runs", tokD, {
      method: "POST", body: JSON.stringify({ period, note: "sneaked in" })
    });
    check("a build takes nothing but the month → 400", badBody.status === 400, badBody.json);

    phase("a run emptied of people cannot be signed");
    const quiet = await call("/payroll/runs", tokD, {
      method: "POST", body: JSON.stringify({ period: quietPeriod })
    });
    check("an earlier month builds too", quiet.status === 201 && quiet.json?.headcount === 4,
      { s: quiet.status, h: quiet.json?.headcount });
    check("with that month's own divisor, not this month's",
      quiet.json?.working_days === quietDivisor, quiet.json?.working_days);
    const quietId = quiet.json?.id ?? "";
    for (const l of quiet.json?.lines ?? []) {
      await call(`/payroll/lines/${l.id}`, tokD, { method: "DELETE" });
    }
    const emptied = await call(`/payroll/runs/${quietId}`, tokD);
    check("and the run re-foots to nothing as its last line goes",
      (emptied.json?.lines ?? []).length === 0 && emptied.json?.headcount === 0
        && emptied.json?.net_total === "0.00",
      { h: emptied.json?.headcount, net: emptied.json?.net_total });
    const issueEmpty = await call(`/payroll/runs/${quietId}/issue`, tokD, {
      method: "POST", body: "null"
    });
    check("an empty run cannot be issued → 409", issueEmpty.status === 409, issueEmpty.json);
    const cancelQuiet = await call(`/payroll/runs/${quietId}/cancel`, tokD, {
      method: "POST", body: JSON.stringify({ reason: "Smoke: this month was already paid" })
    });
    check("a draft can be cancelled, and that is how it is left",
      cancelQuiet.json?.status === "cancelled", cancelQuiet.json);

    phase("the only figure the office may type");
    const unlabelled = await call(`/payroll/lines/${lineIds[ABSENT]}`, tokD, {
      method: "PUT", body: JSON.stringify({ adjustmentAmount: -50000 })
    });
    check("a deduction with no reason on it is refused",
      unlabelled.status === 400 && /adjustmentLabel/.test(JSON.stringify(unlabelled.json)),
      unlabelled.json);

    const ADJUST = -68_000.5;
    const adjusted = await call(`/payroll/lines/${lineIds[ABSENT]}`, tokD, {
      method: "PUT",
      body: JSON.stringify({ adjustmentAmount: ADJUST, adjustmentLabel: "PAYE (typed by finance)", note: "September" })
    });
    check("the adjustment block writes → 200", adjusted.status === 200, adjusted.json);
    check("the adjustment is stored to the cent, not to the cent-and-a-bit",
      adjusted.json?.adjustment_amount === ADJUST.toFixed(2), adjusted.json?.adjustment_amount);
    check("net follows the typed figure, and base is left where the register put it",
      adjusted.json?.net_amount === expect(SAL_ABSENT, divisor, 0, 2, ADJUST).net_amount
        && adjusted.json?.base_amount === bd[ABSENT].base_amount,
      { net: adjusted.json?.net_amount, base: adjusted.json?.base_amount });
    const afterAdjust = await call(`/payroll/runs/${runId}`, tokD);
    check("the run's adjustment total and adjusted-line count follow the one typed figure",
      afterAdjust.json?.adjustment_total === ADJUST.toFixed(2)
        && afterAdjust.json?.lines_adjusted === 1,
      { adj: afterAdjust.json?.adjustment_total, n: afterAdjust.json?.lines_adjusted });

    const belowZero = await call(`/payroll/lines/${lineIds[LATE]}`, tokD, {
      method: "PUT",
      body: JSON.stringify({ adjustmentAmount: -(SAL_LATE * 2), adjustmentLabel: "More than the pay" })
    });
    check("an adjustment that takes the net below zero is refused → 409",
      belowZero.status === 409, belowZero.json);

    const derivedColumn = await oi(
      `update payroll_lines set absence_days = absence_days + 1 where id = $1`, [lineIds[ABSENT]])
      .then(() => "written")
      .catch((e: any) => e.message);
    check("a derived column cannot be re-typed even by the owner connection",
      derivedColumn === "written"
        ? (await oi(`select absence_days from payroll_lines where id = $1`, [lineIds[ABSENT]]))
            .rows[0].absence_days === bd[ABSENT].absence_days
        : /derived from the roster/.test(String(derivedColumn)),
      derivedColumn);

    const drop = await call(`/payroll/lines/${lineIds[LATE]}`, tokD, { method: "DELETE" });
    check("one person can be dropped from a draft → 200", drop.status === 200, drop.json);
    const withThree = await call(`/payroll/runs/${runId}`, tokD);
    const cents = (n: string) => Math.round(Number(n) * 100);
    const threeCents = cents(expect(SAL_FULL, divisor, 0, 0).net_amount)
      + cents(expect(SAL_ABSENT, divisor, 0, 2, ADJUST).net_amount)
      + cents(expect(SAL_UNPAID, divisor, 3, 0).net_amount);
    check("and the run re-foots without them, the typed adjustment included",
      withThree.json?.headcount === 3
        && withThree.json?.net_total === (threeCents / 100).toFixed(2),
      { net: withThree.json?.net_total, wanted: (threeCents / 100).toFixed(2) });

    const rebuilt = await call(`/payroll/runs/${runId}/rebuild`, tokD, {
      method: "POST", body: "null"
    });
    check("a rebuild brings the dropped person back from the register → 200",
      rebuilt.status === 200 && rebuilt.json?.headcount === 4, rebuilt.json?.headcount);
    check("and the typed adjustment is gone with the line it was written on",
      byName(rebuilt.json?.lines ?? [])[ABSENT]?.adjustment_amount === "0.00",
      byName(rebuilt.json?.lines ?? [])[ABSENT]);
    // Rebuild deletes and re-inserts, so every line id the smoke held is now stale.
    lineIds = byId(rebuilt.json?.lines ?? []);

    phase("issuing freezes the document");
    const auditorIssue = await call(`/payroll/runs/${runId}/issue`, tokR, {
      method: "POST", body: "null"
    });
    check("the auditor cannot issue → 403", auditorIssue.status === 403, auditorIssue.status);
    const issued = await call(`/payroll/runs/${runId}/issue`, tokF, {
      method: "POST", body: JSON.stringify({ paymentReference: "SMOKE-REF-1", paidOn: monthEnd })
    });
    check("finance issues the run → 200", issued.status === 200, issued.json);
    check("the issue stamps who signed it and when",
      issued.json?.status === "issued" && issued.json?.issued_by_name === "Payroll Smoke Finance"
        && !!issued.json?.issued_at,
      { s: issued.json?.status, by: issued.json?.issued_by_name });
    check("and freezes the totals with it: the adjustment column is back to nothing",
      issued.json?.adjustment_total === "0.00" && issued.json?.headcount === 4,
      { adj: issued.json?.adjustment_total, h: issued.json?.headcount });

    const frozenLine = (await call(`/payroll/runs/${runId}`, tokD)).json?.lines?.[0];
    const lateEdit = await call(`/payroll/lines/${frozenLine.id}`, tokD, {
      method: "PUT", body: JSON.stringify({ adjustmentAmount: 1000, adjustmentLabel: "Too late" })
    });
    check("a line of an issued run cannot be edited → 409", lateEdit.status === 409, lateEdit.json);
    const lateDelete = await call(`/payroll/lines/${frozenLine.id}`, tokD, { method: "DELETE" });
    check("nor deleted → 409", lateDelete.status === 409, lateDelete.json);
    const lateRebuild = await call(`/payroll/runs/${runId}/rebuild`, tokD, {
      method: "POST", body: "null"
    });
    check("nor rebuilt → 409", lateRebuild.status === 409, lateRebuild.json);
    const reBased = await oi(
      `update payroll_runs set period = $2::date where id = $1 and tenant_id = $3`,
      [runId, thisMonth, T]).then(() => "written").catch((e: any) => e.message);
    check("nor re-based on another month, even by the owner connection",
      /cannot be re-based/.test(String(reBased))
        || (await oi(`select period::text as p from payroll_runs where id = $1`, [runId]))
          .rows[0].p === period,
      reBased);
    const reopen = await call(`/payroll/runs/${runId}`, tokD, {
      method: "PUT", body: JSON.stringify({ note: "typed after the fact" })
    });
    check("but the payment bookkeeping stays open on an issued run → 200",
      reopen.status === 200 && reopen.json?.note === "typed after the fact", reopen.json);
    check("and the reference typed at issue survives a note-only edit",
      reopen.json?.payment_reference === "SMOKE-REF-1", reopen.json?.payment_reference);
    const issueTwice = await call(`/payroll/runs/${runId}/issue`, tokF, {
      method: "POST", body: "null"
    });
    check("issuing a run that is already issued says so instead of stamping it again",
      issueTwice.json?.already === true, issueTwice.json);

    phase("the payslip and the salary register");
    const slip = await call(`/payroll/runs/${runId}/payslip/${lineIds[ABSENT]}`, tokD);
    check("one person's slip reads as a document → 200", slip.status === 200, slip.json);
    check("with the letterhead it prints on and the name that signed it",
      slip.json?.company_name === COMPANY && slip.json?.issued_by_name === "Payroll Smoke Finance",
      { co: slip.json?.company_name, by: slip.json?.issued_by_name });
    check("the slip foots: base plus adjustment equals net",
      Math.round((Number(slip.json?.base_amount) + Number(slip.json?.adjustment_amount)) * 100)
        === Math.round(Number(slip.json?.net_amount) * 100),
      { base: slip.json?.base_amount, adj: slip.json?.adjustment_amount, net: slip.json?.net_amount });
    check("and it carries the days the register charged, so the figure has a story",
      (slip.json?.detail?.absence_dates ?? []).length === 2 && slip.json?.days_paid === divisor - 2,
      { detail: slip.json?.detail, days: slip.json?.days_paid });
    const leaky = Object.keys(slip.json ?? {}).filter((k) =>
      /phone|nida|encrypt|email|address/i.test(k));
    check("a payslip carries no contact or identity field", leaky.length === 0, leaky);
    const foreignSlip = await call(`/payroll/runs/${runId}/payslip/${lineIds[ABSENT]}`, tokForeign);
    check("another company cannot read this slip",
      foreignSlip.status === 404 || foreignSlip.status === 403, foreignSlip.status);

    const register = await call(`/payroll/register?from=${period}&to=${period}`, tokD);
    check("the salary register reads back the month that was run → 200",
      register.status === 200, register.json);
    check("with one line per person and a per-person total",
      (register.json?.rows ?? []).length === 4
        && (register.json?.employees ?? []).length === 4,
      { rows: register.json?.rows?.length, people: register.json?.employees?.length });
    const regFull = (register.json?.employees ?? []).find((e: any) => e.full_name === FULL);
    check("the register's own arithmetic agrees with the slip",
      regFull?.net_total === expect(SAL_FULL, divisor, 0, 0).net_amount
        && regFull?.months === 1, regFull);
    check("the register totals foot to the sum of its people",
      Math.abs(Number(register.json?.totals?.net)
        - (register.json?.employees ?? []).reduce((s: number, e: any) => s + Number(e.net_total), 0)) < 0.005,
      register.json?.totals);
    check("and it counts the people rather than handing back the array",
      register.json?.totals?.people === 4, register.json?.totals);
    const asAuditor = await call(`/payroll/register?from=${period}&to=${period}`, tokR);
    check("the auditor reads the register it cannot change → 200",
      asAuditor.status === 200, asAuditor.status);

    phase("a fresh month, built while the last one stays signed");
    const second = await call("/payroll/runs", tokF, {
      method: "POST", body: JSON.stringify({ period: thisMonth })
    });
    check("this month can be built while last month stays issued → 201",
      second.status === 201, second.json);
    check("with the whole month as its divisor but only the days that have arrived counted",
      second.json?.working_days === weekdaysBetween(thisMonth, lastOfMonth(thisMonth))
        && second.json?.bounds?.countedUpTo === companyToday,
      { d: second.json?.working_days, b: second.json?.bounds });
    const futureRun = await call("/payroll/runs", tokF, {
      method: "POST", body: JSON.stringify({ period: nextMonth })
    });
    check("the month that has not begun cannot be built → 400",
      futureRun.status === 400, futureRun.json);

    const runs = await call("/payroll/runs", tokD);
    check("the register of runs lists the months, newest first",
      (runs.json?.runs ?? []).length === 3
        && String(runs.json.runs[0].period) >= String(runs.json.runs[1].period)
        && String(runs.json.runs[1].period) >= String(runs.json.runs[2].period),
      (runs.json?.runs ?? []).map((r: any) => `${r.period}/${r.status}`));
    check("and says which of them were cancelled, with the reason on the row",
      (runs.json?.runs ?? []).filter((r: any) => r.status === "cancelled").length === 1
        && !!runs.json.runs.find((r: any) => r.status === "cancelled")?.cancel_reason,
      (runs.json?.runs ?? []).map((r: any) => `${r.status}:${r.cancel_reason ?? ""}`));

    phase("the only way out of an issued payroll");
    const noReason = await call(`/payroll/runs/${runId}/cancel`, tokD, {
      method: "POST", body: JSON.stringify({})
    });
    check("cancelling without a reason is refused → 400", noReason.status === 400, noReason.json);
    const cancelled = await call(`/payroll/runs/${runId}/cancel`, tokD, {
      method: "POST", body: JSON.stringify({ reason: "Two people were missing from the register" })
    });
    check("a cancel that names a reason → 200", cancelled.json?.status === "cancelled", cancelled.json);
    const reIssue = await call(`/payroll/runs/${runId}/issue`, tokD, { method: "POST", body: "null" });
    check("a cancelled run cannot be issued again → 409", reIssue.status === 409, reIssue.json);
    const bookCancelled = await call(`/payroll/runs/${runId}`, tokD, {
      method: "PUT", body: JSON.stringify({ note: "still open?" })
    });
    check("and its bookkeeping is closed too → 409", bookCancelled.status === 409, bookCancelled.json);
    const afterCancel = await call(`/payroll/runs/${runId}`, tokD);
    check("its lines survive the cancel — a payroll is corrected, never erased",
      (afterCancel.json?.lines ?? []).length === 4
        && afterCancel.json?.cancelled_by_name === "Payroll Smoke Director",
      { lines: afterCancel.json?.lines?.length, by: afterCancel.json?.cancelled_by_name });
    const cancelledRegister = await call(`/payroll/register?from=${period}&to=${period}`, tokD);
    check("the cancelled month leaves the salary register, so what was never paid is not totalled",
      (cancelledRegister.json?.rows ?? []).length === 0,
      cancelledRegister.json?.rows?.length);

    phase("the audit trail");
    const audit = await oi(
      `select action, entity, after from audit_logs
        where tenant_id = $1 and (action like 'payroll.%')
        order by ts`, [T]);
    const actions = audit.rows.map((r: any) => r.action);
    check("every payroll act is on the record",
      ["payroll.run.built", "payroll.line.adjusted", "payroll.line.removed",
       "payroll.run.rebuilt", "payroll.run.issued", "payroll.run.cancelled",
       "payroll.run.payment_recorded"].every((a) => actions.includes(a)), actions);
    const adjust = audit.rows.find((r: any) => r.action === "payroll.line.adjusted");
    check("the adjustment names the figure and the label, so a disputed cent has an author",
      adjust?.after?.adjustmentAmount === ADJUST.toFixed(2)
        && adjust?.after?.adjustmentLabel === "PAYE (typed by finance)",
      adjust?.after);
    check("the issue records the net that was signed off",
      !!audit.rows.find((r: any) => r.action === "payroll.run.issued")?.after?.netTotal,
      audit.rows.find((r: any) => r.action === "payroll.run.issued")?.after);
  } finally {
    await wipeTenantRows(oi, [T]);
    await oi(`delete from user_roles where user_id in (select id from users where tenant_id = $1)`, [T])
      .catch(() => { });
    await oi(`delete from sessions where user_id in (select id from users where tenant_id = $1)`, [T])
      .catch(() => { });
    await oi(`delete from employees where tenant_id = $1`, [T]).catch(() => { });
    await oi(`delete from users where tenant_id = $1`, [T]).catch(() => { });
    await oi(`delete from tenants where id = $1`, [T]).catch(() => { });

    const left = await oi(
      `select
        (select count(*) from payroll_runs where tenant_id = $1)::int as runs,
        (select count(*) from payroll_lines l where l.tenant_id = $1)::int as lines,
        (select count(*) from employees where tenant_id = $1)::int as staff,
        (select count(*) from users where tenant_id = $1)::int as seats,
        (select count(*) from tenants where id = $1)::int as tenant`, [T]);
    console.log(`\ncleanup: ${JSON.stringify(left.rows[0])}`);
    console.log("(audit rows are append-only by design and stay — a payroll trail outlives the company that made it)");
    await owner.end();
  }

  console.log(failures ? `${failures} FAILED` : "all payroll smoke checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
