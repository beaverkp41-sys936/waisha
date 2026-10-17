/**
 * End-to-end smoke for migration 065 — the attendance register, the leave queue
 * and the working-day settings — against a running API (port 4000).
 *
 * It mints tokens like the other module smokes, and it proves the part step 8
 * could not: a *non-director* seat doing exactly what its matrix grants and
 * nothing more. A throwaway staff user is given the dispatcher role, linked to a
 * staff record, and then held to that line — it can clock itself in and ask for
 * leave, and cannot correct anyone's day, set the working day or decide a request.
 *
 * Everything it creates is deleted by the owner connection at the end, and the
 * residue count is printed so a partial run is visible.
 *
 * Run: npx tsx scripts/smoke-attendance.ts
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString(36);
const EMP_IN = `Kilian Smoke Attender ${STAMP}`;
const EMP_OUT = `Kilian Smoke Absentee ${STAMP}`;
const USER_EMAIL = `smoke-attendance-${STAMP}@example.invalid`;
const USER_NAME = `Kilian Smoke Dispatcher ${STAMP}`;
const REASON = `Smoke leave ${STAMP}`;

async function mint(sub: string, tid: string, roles: string[] = ["director"]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000aa", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("15m").sign(key);
}

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

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const nextDayOfWeek = (from: string, want: number) => {
  for (let i = 1; i <= 7; i++) if (dow(addDays(from, i)) === want) return addDays(from, i);
  return addDays(from, 7);
};

async function main() {
  const owner = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await owner.connect();

  const who = await owner.query(
    `select u.id as user_id, u.tenant_id, u.full_name from users u
     where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
     order by (select count(*) from employees e where e.tenant_id = u.tenant_id and e.deleted_at is null) desc,
              u.created_at limit 1`);
  if (!who.rowCount) throw new Error("No active director found");
  const { user_id, tenant_id, full_name } = who.rows[0];
  console.log(`probe tenant ${tenant_id} as "${full_name}"`);

  const dispatcherRole = await owner.query(
    `select id from roles where key = 'dispatcher' and tenant_id is null`);
  if (!dispatcherRole.rowCount) throw new Error("No dispatcher role");

  // Clear anything a previous interrupted run left behind.
  const SMOKE_EMPS = `select id from employees where tenant_id = $1 and full_name like 'Kilian Smoke Att%'`;
  await owner.query(`delete from employee_attendance where employee_id in (${SMOKE_EMPS})`, [tenant_id]);
  await owner.query(`delete from leave_requests where employee_id in (${SMOKE_EMPS})`, [tenant_id]);
  await owner.query(
    `delete from employees where tenant_id = $1 and full_name like 'Kilian Smoke Att%'`, [tenant_id]);
  await owner.query(`delete from users where email = $1`, [USER_EMAIL]);

  const staff = await owner.query(
    `insert into users (tenant_id, user_type, email, status, full_name)
     values ($1, 'staff', $2, 'active', $3) returning id`,
    [tenant_id, USER_EMAIL, USER_NAME]);
  const staffId: string = staff.rows[0].id;
  await owner.query(`insert into user_roles (user_id, role_id) values ($1, $2)`,
    [staffId, dispatcherRole.rows[0].id]);

  const director = await mint(user_id, tenant_id);
  const staffToken = await mint(staffId, tenant_id, ["staff"]);
  const nobodyToken = await mint("99999999-9999-7999-8999-999999999999", tenant_id, ["staff"]);
  const foreignToken = await mint(user_id, "00000000-0000-7000-8000-000000000000");

  let empIn: string | null = null;
  let empOut: string | null = null;
  let lineId: string | null = null;
  let leaveId: string | null = null;
  let weekendId: string | null = null;
  let hadSettingsRow = false;
  let savedSettings: any = null;
  let today = new Date().toISOString().slice(0, 10);

  try {
    // ---------- gates ----------
    const noAuth = await call("/attendance/today", null);
    check("register without auth → 401", noAuth.status === 401, noAuth.status);

    const noRole = await call("/attendance/today", nobodyToken);
    check("register with no role at all → 403", noRole.status === 403, noRole.status);

    const noRoleLeave = await call("/leave", nobodyToken);
    check("leave queue with no role → 403", noRoleLeave.status === 403, noRoleLeave.status);

    const noRoleSettings = await call("/office-settings", nobodyToken);
    check("working day with no role → 403", noRoleSettings.status === 403, noRoleSettings.status);

    const foreign = await call("/attendance/today", foreignToken);
    check("foreign tenant sees no register",
      foreign.status === 403 || (foreign.status === 200 && (foreign.json?.rows ?? []).length === 0),
      { status: foreign.status, rows: foreign.json?.rows?.length });

    // ---------- fixtures ----------
    const e1 = await call("/employees", director, {
      method: "POST", body: JSON.stringify({ fullName: EMP_IN, jobTitle: "Records clerk", department: "Office" })
    });
    check("staff record for the clocker → 201", e1.status === 201, e1.json);
    empIn = e1.json?.id ?? null;

    const e2 = await call("/employees", director, {
      method: "POST", body: JSON.stringify({ fullName: EMP_OUT, jobTitle: "Messenger", department: "Office" })
    });
    check("staff record for the absentee → 201", e2.status === 201, e2.json);
    empOut = e2.json?.id ?? null;

    await owner.query(`update employees set user_id = $2 where id = $1`, [empIn, staffId]);

    // ---------- the working day ----------
    const settings = await call("/office-settings", director);
    check("settings read before anyone sets them → 200", settings.status === 200, settings.json);
    today = settings.json?.today ?? today;
    hadSettingsRow = settings.json?.saved === true;
    savedSettings = hadSettingsRow ? settings.json : null;
    const isWeekday = settings.json?.isWeekday === true;
    check("the register's today is the company's own date, not UTC",
      settings.json?.zone === "Africa/Dar_es_Salaam", settings.json);
    // The probe tenant is a live company's, so it may already keep a working day.
    // Either way the read has to be self-consistent: a stored row says it is
    // stored, and its absence says the migration defaults are speaking.
    check(hadSettingsRow ? "a stored working day reads back as stored" : "no settings row yet, so the defaults speak",
      hadSettingsRow ? settings.json?.saved === true
        : settings.json?.saved === false && settings.json?.workStart === "08:00" && settings.json?.grace === 15,
      settings.json);

    const badZone = await call("/office-settings", director, {
      method: "PUT", body: JSON.stringify({ workStart: "08:00", workEnd: "17:00", lateGraceMinutes: 15, annualLeaveDays: 28, timezone: "Mars/Olympus" })
    });
    check("an invented timezone is refused", badZone.status === 400, badZone.json);

    const backwardsDay = await call("/office-settings", director, {
      method: "PUT", body: JSON.stringify({ workStart: "17:00", workEnd: "08:00", lateGraceMinutes: 15, annualLeaveDays: 28, timezone: "Africa/Dar_es_Salaam" })
    });
    check("a working day that ends before it starts is refused", backwardsDay.status === 400, backwardsDay.json);

    const setOk = await call("/office-settings", director, {
      method: "PUT", body: JSON.stringify({ workStart: "08:00", workEnd: "17:00", lateGraceMinutes: 15, annualLeaveDays: 28, timezone: "Africa/Dar_es_Salaam" })
    });
    check("the working day is written → 200", setOk.status === 200, setOk.json);
    check("the row now exists", setOk.json?.saved === true, setOk.json);

    const staffSetsDay = await call("/office-settings", staffToken, {
      method: "PUT", body: JSON.stringify({ workStart: "06:00", workEnd: "16:00", lateGraceMinutes: 0, annualLeaveDays: 40, timezone: "Africa/Dar_es_Salaam" })
    });
    check("a dispatcher cannot set the working day → 403", staffSetsDay.status === 403, staffSetsDay.status);

    // ---------- clocking ----------
    const clockIn = await call("/attendance/clock-in", staffToken, { method: "POST", body: JSON.stringify({}) });
    check("a dispatcher clocks itself in → 201", clockIn.status === 201, clockIn.json);
    lineId = clockIn.json?.id ?? null;
    check("the day is stamped against the company date",
      clockIn.json?.work_date === today, { got: clockIn.json?.work_date, wanted: today });
    check("the lateness is a number, whatever the server clock says",
      typeof clockIn.json?.minutes_late === "number", clockIn.json);

    const again = await call("/attendance/clock-in", staffToken, { method: "POST", body: "null" });
    check("a second clock-in on the same day → 409", again.status === 409, again.json);

    const backDate = await call("/attendance/clock-in", staffToken, {
      method: "POST", body: JSON.stringify({ at: `${addDays(today, -1)}T05:00:00.000Z` })
    });
    check("a dispatcher cannot stamp a time that has passed → 403", backDate.status === 403, backDate.status);

    const forSomeoneElse = await call("/attendance/clock-in", staffToken, {
      method: "POST", body: JSON.stringify({ employeeId: empOut })
    });
    check("a dispatcher cannot clock another person in → 403", forSomeoneElse.status === 403, forSomeoneElse.status);

    const clockOut = await call("/attendance/clock-out", staffToken, { method: "POST", body: "null" });
    check("the dispatcher closes its own day → 200", clockOut.status === 200, clockOut.json);
    check("the closed day carries both stamps",
      clockOut.json?.clock_in !== null && clockOut.json?.clock_out !== null
      && typeof clockOut.json?.hours_worked === "number", clockOut.json);

    const closeTwice = await call("/attendance/clock-out", staffToken, { method: "POST", body: "null" });
    check("closing a closed day → 409", closeTwice.status === 409, closeTwice.json);

    const future = await call("/attendance/day", director, {
      method: "POST", body: JSON.stringify({ employeeId: empOut, workDate: addDays(today, 3), dayStatus: "holiday" })
    });
    check("a day that has not arrived cannot be stated → 400", future.status === 400, future.json);

    const yesterday = addDays(today, -1);
    const stated = await call("/attendance/day", director, {
      method: "POST", body: JSON.stringify({ employeeId: empOut, workDate: yesterday, dayStatus: "absent", note: "Smoke no-show" })
    });
    check("the desk states a day without a clock → 201", stated.status === 201, stated.json);

    const staffStates = await call("/attendance/day", staffToken, {
      method: "POST", body: JSON.stringify({ employeeId: empOut, workDate: yesterday, dayStatus: "holiday" })
    });
    check("a dispatcher cannot state someone's day → 403", staffStates.status === 403, staffStates.status);

    const corrected = await call(`/attendance/${lineId}`, director, {
      method: "PUT", body: JSON.stringify({ dayStatus: "half_day", note: "Left for the clinic" })
    });
    check("the desk corrects a line → 200", corrected.status === 200, corrected.json);
    check("the correction stuck", corrected.json?.day_status === "half_day", corrected.json);

    const cleared = await call(`/attendance/${lineId}`, director, {
      method: "PUT", body: JSON.stringify({ clockIn: null })
    });
    check("clearing the arrival clears the departure and the lateness",
      cleared.status === 200 && cleared.json?.clock_in === null && cleared.json?.clock_out === null
      && cleared.json?.minutes_late === null, cleared.json);

    const restamped = await call(`/attendance/${lineId}`, director, {
      method: "PUT", body: JSON.stringify({ clockIn: `${today}T05:20:00.000Z`, clockOut: `${today}T10:00:00.000Z`, dayStatus: "present" })
    });
    check("a corrected arrival is re-stamped by the database",
      restamped.status === 200 && restamped.json?.minutes_late === 5, restamped.json);
    check("twenty minutes past an eight o'clock start with a quarter hour of grace is five minutes late",
      restamped.json?.day_status === "late", restamped.json?.day_status);
    check("the hours between the two stamps are derived, not stored",
      Math.abs(Number(restamped.json?.hours_worked) - 4.6667) < 0.01, restamped.json?.hours_worked);

    const early = await call(`/attendance/${lineId}`, director, {
      method: "PUT", body: JSON.stringify({ clockIn: `${today}T05:05:00.000Z`, clockOut: `${today}T12:00:00.000Z`, dayStatus: "present" })
    });
    check("a quarter past eight is not late once the grace is taken off",
      early.json?.minutes_late === 0 && early.json?.day_status === "present", early.json);
    check("the day length is the clock between the two stamps, to the minute",
      Math.abs(Number(early.json?.hours_worked) - 6.9167) < 0.01, early.json?.hours_worked);

    const todayBoard = await call("/attendance/today", director);
    const onBoard = (todayBoard.json?.rows ?? []).find((r: any) => r.employee_id === empIn);
    check("today's board carries the clocked person", !!onBoard, todayBoard.json?.rows?.length);
    check("the board names the day in the company's own calendar",
      todayBoard.json?.workDate === today, todayBoard.json?.workDate);

    const boardAsStaff = await call("/attendance/me", staffToken);
    check("the staff screen finds the linked record", boardAsStaff.json?.linked === true, boardAsStaff.json?.linked);
    check("the staff screen shows the day just clocked",
      (boardAsStaff.json?.attendance ?? []).some((r: any) => r.work_date === today), boardAsStaff.json?.attendance?.length);

    const register = await call(`/attendance?from=${yesterday}&to=${today}`, director);
    check("the register covers two people over two days",
      (register.json?.lines ?? []).length >= 2, register.json?.lines?.length);
    check("per-person totals are computed",
      (register.json?.totals ?? []).length >= 2, register.json?.totals?.length);

    const tooLong = await call(`/attendance?from=${addDays(today, -400)}&to=${today}`, director);
    check("a 400-day register is refused rather than dumped", tooLong.status === 400, tooLong.status);

    // ---------- leave ----------
    const mon = nextDayOfWeek(today, 1);
    const fri = addDays(mon, 4);
    const request = await call("/leave", staffToken, {
      method: "POST",
      body: JSON.stringify({ leaveKind: "annual", startsOn: mon, endsOn: fri, reason: REASON })
    });
    check("a dispatcher asks for a week off → 201", request.status === 201, request.json);
    leaveId = request.json?.id ?? null;
    check("the five working days are counted by the trigger",
      request.json?.working_days === 5, request.json);

    const weekend = await call("/leave", staffToken, {
      method: "POST",
      body: JSON.stringify({ leaveKind: "other", startsOn: nextDayOfWeek(today, 6), endsOn: addDays(nextDayOfWeek(today, 6), 1), reason: `${REASON} weekend` })
    });
    check("a weekend request costs no working days",
      weekend.status === 201 && weekend.json?.working_days === 0, weekend.json);
    weekendId = weekend.json?.id ?? null;

    const clash = await call("/leave", director, {
      method: "POST",
      body: JSON.stringify({ employeeId: empIn, leaveKind: "sick", startsOn: addDays(mon, 2), endsOn: addDays(mon, 3), reason: `${REASON} clash` })
    });
    check("an overlapping request is refused by the database",
      clash.status === 409 && /already has a leave request/.test(clash.json?.error?.message ?? ""),
      clash.json);

    const forSomeoneElseLeave = await call("/leave", staffToken, {
      method: "POST",
      body: JSON.stringify({ employeeId: empOut, leaveKind: "annual", startsOn: mon, endsOn: fri, reason: `${REASON} proxy` })
    });
    check("a dispatcher cannot ask on another's behalf → 403",
      forSomeoneElseLeave.status === 403, forSomeoneElseLeave.status);

    const decideAsStaff = await call(`/leave/${leaveId}/decision`, staffToken, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("a dispatcher cannot approve leave → 403", decideAsStaff.status === 403, decideAsStaff.status);

    const queue = await call("/leave?status=pending", director);
    check("the desk sees the pending request",
      (queue.json ?? []).some((r: any) => r.id === leaveId), queue.json?.length);
    check("the queue marks it as the caller's own for the requester",
      (await call("/leave?status=pending", staffToken)).json?.some((r: any) => r.id === leaveId && r.mine === true));

    const approve = await call(`/leave/${leaveId}/decision`, director, {
      method: "POST", body: JSON.stringify({ decision: "approve", note: "Cover arranged" })
    });
    check("the director approves → 200", approve.status === 200, approve.json);

    const reDecide = await call(`/leave/${leaveId}/decision`, director, {
      method: "POST", body: JSON.stringify({ decision: "reject" })
    });
    check("a decided request is not decided twice → 409", reDecide.status === 409, reDecide.json);

    const edited = await call(`/leave/${leaveId}`, staffToken, {
      method: "PUT", body: JSON.stringify({ endsOn: addDays(fri, 5) })
    });
    check("a granted request is not edited → 409", edited.status === 409, edited.json);

    const balances = await call("/leave/balances", director);
    const bal = (balances.json?.rows ?? []).find((r: any) => r.employee_id === empIn);
    check("the balance sheet counts the granted week",
      bal?.annualUsed === 5 && bal?.entitlement === 28, bal);
    check("the balance sheet still shows the days left",
      bal?.annualRemaining === 23, bal);

    // The weekend request is still waiting. A request that costs nobody a single
    // working day still occupies a deciding seat until it is answered, so it has
    // to be refused here — only then does the silence below mean a drained queue.
    const refuse = await call(`/leave/${weekendId}/decision`, director, {
      method: "POST", body: JSON.stringify({ decision: "reject", note: "The yard is open both days" })
    });
    check("the director refuses → 200", refuse.status === 200, refuse.json);

    const answered = await call("/leave?status=rejected", director);
    check("the refused request is listed among the answered",
      (answered.json ?? []).some((r: any) => r.id === weekendId), answered.json?.length);
    const afterRefusal = await call("/leave/balances", director);
    const bal3 = (afterRefusal.json?.rows ?? []).find((r: any) => r.employee_id === empIn);
    check("a refused request takes no days off anyone", bal3?.annualUsed === 5, bal3);

    // The bell is tenant-wide and the probe tenant is a live company's, so the
    // honest assertion is not "no alert" but "the alert mirrors the queue": the
    // seat is told exactly when there is something to decide, and not otherwise.
    const alerts = await call("/notifications", director);
    const queueNow = await owner.query(
      `select count(*)::int as n from leave_requests
        where tenant_id = $1 and deleted_at is null and status = 'pending'`, [tenant_id]);
    const bellShowsQueue = JSON.stringify(alerts.json?.items ?? []).includes("leave_pending");
    check("the leave alert mirrors the queue the deciding seat can see",
      bellShowsQueue === (Number(queueNow.rows[0]?.n ?? 0) > 0),
      { bellShowsQueue, pending: queueNow.rows[0]?.n, counts: alerts.json?.counts });

    const cancel = await call(`/leave/${leaveId}/cancel`, staffToken, {
      method: "POST", body: JSON.stringify({ note: "Plans changed" })
    });
    check("a dispatcher cannot close granted leave → 403", cancel.status === 403, cancel.status);

    const cancelByDesk = await call(`/leave/${leaveId}/cancel`, director, {
      method: "POST", body: JSON.stringify({ note: "Smoke teardown" })
    });
    check("the office closes granted leave → 200", cancelByDesk.status === 200, cancelByDesk.json);

    const afterCancel = await call("/leave/balances", director);
    const bal2 = (afterCancel.json?.rows ?? []).find((r: any) => r.employee_id === empIn);
    check("a cancelled request costs nothing", bal2?.annualUsed === 0, bal2);

    const pendingNow = await call("/leave", staffToken, {
      method: "POST", body: JSON.stringify({ leaveKind: "sick", startsOn: yesterday, endsOn: yesterday, reason: `${REASON} pending` })
    });
    check("a back-dated sick day is allowed", pendingNow.status === 201, pendingNow.json);
    const alerts2 = await call("/notifications", director);
    check("a waiting request now alerts the deciding seat",
      JSON.stringify(alerts2.json ?? {}).includes("leave_pending"),
      Object.keys(alerts2.json ?? {}));
    const alertsStaff = await call("/notifications", staffToken);
    check("the requester is not told to decide its own queue",
      !JSON.stringify(alertsStaff.json ?? {}).includes("leave_pending"));

    // The register nudge. Today is a rest day or a working day in the company's
    // own calendar, and the alert has to know which — nagging about an empty
    // register on a Saturday is how a feature like this gets switched off.
    await owner.query(`delete from employee_attendance where employee_id in (${SMOKE_EMPS})`, [tenant_id]);
    const alerts3 = await call("/notifications", director);
    const openKeys = JSON.stringify(alerts3.json?.items ?? []);
    if (isWeekday) {
      check("an empty register alerts the seat that can fill it",
        openKeys.includes("attendance_open"), alerts3.json?.counts);
    } else {
      check("a rest day raises no alarm about an empty register",
        !openKeys.includes("attendance_open"), { isWeekday, today });
    }
    const alerts4 = await call("/notifications", staffToken);
    check("the same gap does not alert a person who cannot correct it",
      !JSON.stringify(alerts4.json?.items ?? []).includes("attendance_open"));

    const boardAfterWipe = await call("/attendance/today", director);
    const wiped = (boardAfterWipe.json?.rows ?? []).find((r: any) => r.employee_id === empIn);
    check("a person with no line and no leave shows as unrecorded",
      wiped && wiped.attendance_id === null && wiped.leave_id === null, wiped);
  } finally {
    await owner.query(`delete from employee_attendance where employee_id in (${SMOKE_EMPS})`, [tenant_id])
      .then(() => { }).catch(() => { });
    await owner.query(`delete from leave_requests where employee_id in (${SMOKE_EMPS})`, [tenant_id])
      .then(() => { }).catch(() => { });
    await owner.query(
      `delete from employees where tenant_id = $1 and full_name like 'Kilian Smoke Att%'`, [tenant_id])
      .then(() => { }).catch(() => { });
    await owner.query(`delete from users where id = $1`, [staffId]).then(() => { }).catch(() => { });
    // The working day was written for a live tenant; put back what was found, and
    // take the row away only if the run is the one that created it.
    if (hadSettingsRow && savedSettings) {
      await owner.query(
        `update office_settings set work_start = $3, work_end = $4, late_grace_minutes = $5,
                annual_leave_days = $6, timezone = $7 where tenant_id = $1 and tenant_id = $2`,
        [tenant_id, tenant_id, savedSettings.workStart, savedSettings.workEnd,
         savedSettings.grace, savedSettings.annualLeaveDays, savedSettings.zone]).catch(() => { });
    } else {
      await owner.query(`delete from office_settings where tenant_id = $1`, [tenant_id])
        .then(() => { }).catch(() => { });
    }

    const left = await owner.query(
      `select
        (select count(*) from employee_attendance a
           join employees e on e.id = a.employee_id
          where a.tenant_id = $1 and e.full_name like 'Kilian Smoke Att%')::int as attendance,
        (select count(*) from leave_requests l
           join employees e on e.id = l.employee_id
          where l.tenant_id = $1 and e.full_name like 'Kilian Smoke Att%')::int as leave,
        (select count(*) from employees where tenant_id = $1 and full_name like 'Kilian Smoke Att%')::int as employees,
        (select count(*) from users where email = $2)::int as staff_user,
        (select count(*) from office_settings where tenant_id = $1)::int as settings`,
      [tenant_id, USER_EMAIL]);
    const L = left.rows[0];
    console.log(`cleanup: attendance=${L.attendance} leave=${L.leave} employees=${L.employees} staff_user=${L.staff_user} settings=${L.settings} remaining`);
    await owner.end();
  }

  console.log(failures ? `${failures} FAILED` : "all attendance smoke checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
