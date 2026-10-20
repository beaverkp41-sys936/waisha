/**
 * The assigned approver over HTTP — smoke for #183 (migration 108, the leave half of
 * api/src/routes/attendance.routes.ts, the approver field of employees.routes.ts).
 *
 * verify-leave-approver.ts proves the database will not accept a bad row. This proves the parts
 * only the wire can show: that naming an approver is a PUT the roster answers, that an ask
 * lands on the desk it was routed to at the moment it was raised, that the person it landed on
 * answers it while holding no deciding key at all, that the office is turned away while the row
 * is with a person, that an escalation carries the reason somebody typed, and that none of it
 * reaches into another company's register.
 *
 * The fixtures are this run's own: two companies, the seats inside them and the staff records
 * behind those seats, all swept by tenant at the end. Seats and their staff rows are inserted by
 * the owner because the API has no endpoint for creating a sign-in; every act the stage performs
 * goes over HTTP. `audit_logs` keeps its rows by design — the guard refuses a delete for the
 * owner too — so this run's leave lines are counted rather than swept.
 *
 * Run: npx tsx scripts/smoke-leave-approver.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const MARK = `108 smoke ${STAMP}`;
const TEN_SWEEP = "Leave Smoke %";
const EMAIL_SWEEP = "smoke.leave.%@waisha.test";

const DAY = 86_400_000;
const MON0 = Date.UTC(2027, 0, 4);            // a Monday; every probe gets a week of its own
const wd = (week: number, dow: number) =>
  new Date(MON0 + (week * 7 + dow) * DAY).toISOString().slice(0, 10);
const SPAN = (week: number, from = 0, to = 2) => ({ startsOn: wd(week, from), endsOn: wd(week, to) });

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

async function mint(sub: string, tid: string, role: string) {
  return new SignJWT({ tid, sid: randomUUID(), typ: role, roles: [role] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);
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
  return { status: res.status, json, text };
}
const code = (j: any) => j?.error?.code ?? j?.code;
const field = (j: any) => j?.error?.details?.[0]?.field ?? j?.details?.[0]?.field;
const msg = (j: any) => String(j?.error?.message ?? j?.message ?? "");

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const ROLES = ["hr_officer", "director", "general_manager", "checkpoint_clerk",
    "customer_service", "dispatcher", "auditor"];
  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1::text[])`, [ROLES])).rows;
  const rid = (k: string) => {
    const id = roleRows.find((r: any) => r.key === k)?.id;
    if (!id) throw new Error(`the platform role ${k} is missing`);
    return id;
  };

  /** Every table this run can touch, in the order the foreign keys allow. */
  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TEN_SWEEP]))
      .rows.map((r: any) => r.id as string);
    if (!tids.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [tids]))
      .rows.map((r: any) => r.id as string);
    const steps: [string, string, any[]][] = [
      ["leave_requests", `delete from leave_requests where tenant_id = any($1::uuid[])`, [tids]],
      ["employee_attendance", `delete from employee_attendance where tenant_id = any($1::uuid[])`, [tids]],
      ["office_settings", `delete from office_settings where tenant_id = any($1::uuid[])`, [tids]],
      ["employees", `delete from employees where tenant_id = any($1::uuid[])`, [tids]]
    ];
    if (uids.length) {
      steps.push(["user_roles", `delete from user_roles where user_id = any($1::uuid[])`, [uids]]);
      steps.push(["sessions", `delete from sessions where user_id = any($1::uuid[])`, [uids]]);
    }
    steps.push(["users", `delete from users where tenant_id = any($1::uuid[])`, [tids]]);
    steps.push(["company_profiles", `delete from company_profiles where tenant_id = any($1::uuid[])`, [tids]]);
    steps.push(["tenants", `delete from tenants where id = any($1::uuid[])`, [tids]]);
    for (const [name, sql, params] of steps) {
      try {
        const r = await oi(sql, params);
        console.log(`sweep ${name}: ${r.rowCount ?? 0}`);
      } catch (e: any) {
        // department_members only exists from 084 on; nothing here writes it.
        console.log(`sweep ${name}: skipped (${String(e.message).slice(0, 60)})`);
      }
    }
  };
  await sweep();

  const T = randomUUID();     // the company the whole flow runs inside
  const F = randomUUID();     // a second company, for the boundary refusals
  await oi(`insert into tenants (id, type, name, status) values
      ($1,'transporter',$2,'active'), ($3,'transporter',$4,'active')`,
    [T, `Leave Smoke Office ${STAMP}`, F, `Leave Smoke Foreign ${STAMP}`]);

  const tk: Record<string, string> = {};
  const uid: Record<string, string> = {};
  const seat = async (who: string, role: string, name: string, status = "active") => {
    const id = randomUUID();
    await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled)
        values ($1,$2,'staff',$3,$4,$5,false)`,
      [id, T, name, `smoke.leave.${who}.${STAMP}@waisha.test`, status]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, rid(role)]);
    uid[who] = id;
    tk[who] = await mint(id, T, role);
    return id;
  };

  // Every name below is unique inside the company, so the sweeps that follow — this one and the
  // next run's stale sweep — can all key off the email marker.
  await seat("hr", "hr_officer", "Heshi Officer");
  await seat("clerk", "checkpoint_clerk", "Chaji Clerk");
  await seat("appr", "customer_service", "Amina Approver");
  await seat("boss", "general_manager", "Baraka Boss");
  await seat("other", "dispatcher", "Daudi Dispatcher");
  await seat("audit", "auditor", "Auditi Watcher");
  await seat("dead", "general_manager", "Dead Seat", "suspended");
  // A director with no staff record behind the seat: the token is real, the person is not on the
  // roster, so the ask has to be told what is missing rather than fail quietly.
  await seat("dir", "director", "Dosi Director");
  // Another company's director, holding every leave key there is — and none of this company's rows.
  const fDir = randomUUID();
  await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled)
      values ($1,$2,'director',$3,$4,'active',false)`,
    [fDir, F, "Foreign Director", `smoke.leave.foreign.${STAMP}@waisha.test`]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [fDir, rid("director")]);
  tk.foreign = await mint(fDir, F, "director");

  // The staff records the seats sign in as. Linked by the owner because no route creates a seat.
  const emp: Record<string, string> = {};
  const staff = async (who: string | null, name: string, title: string) => {
    const r = await oi(`insert into employees (id, tenant_id, full_name, job_title, department,
          employment_type, status, user_id, hired_date)
        values (gen_random_uuid(),$1,$2,$3,'Back office','permanent','active',$4,
          now() - interval '200 days')
        returning id`, [T, name, title, who ? uid[who] : null]);
    const id = r.rows[0].id as string;
    if (who) emp[who] = id;
    return id;
  };
  await staff("clerk", "Chaji Clerk", "Documents clerk");
  await staff("appr", "Amina Approver", "Customer service lead");
  await staff("boss", "Baraka Boss", "General manager");
  await staff("other", "Daudi Dispatcher", "Dispatcher");
  const E_PLAIN = await staff(null, "Mteja Sahih", "Fresher");

  const roster = () => call("/employees", tk.hr);
  const empRow = async (id: string) => (await roster()).json?.find((e: any) => e.id === id);
  const db = (id: string) => !id ? Promise.resolve(undefined as any) : oi(
    `select status, decided_by, decided_at, decision_note, working_days,
            starts_on::text as starts_on, ends_on::text as ends_on, employee_id, created_by,
            routed_to_user_id, routed_reason, routed_note,
            escalated_at, escalated_by, escalated_from
       from leave_requests where id = $1`, [id]).then((r) => r.rows[0]);
  const ask = (who: string, body: any) =>
    call("/leave", tk[who], { method: "POST", body: JSON.stringify(body) });

  let raised = 0;
  /** Raises a request and returns its id, failing the run if the ask itself did not land. */
  const raise = async (label: string, who: string, body: any) => {
    const r = await ask(who, { reason: `${MARK} ${body.leaveKind} ${++raised}`, ...body });
    check(`${label} — the ask is accepted`, r.status === 201, { status: r.status, text: r.text });
    return String(r.json?.id ?? "");
  };

  try {
    // ================================================================
    phase("1 · the assignment: who decides this person's leave");
    // ================================================================
    const before = await empRow(emp.clerk);
    check("the roster carries the approver columns, empty before the office names anyone",
      before?.leave_approver_user_id === null && before?.leave_approver_name === null,
      { id: before?.leave_approver_user_id, name: before?.leave_approver_name });

    const set = await call(`/employees/${emp.clerk}`, tk.hr, {
      method: "PUT", body: JSON.stringify({ leaveApproverUserId: uid.appr })
    });
    check("the office names a colleague as the approver → 200", set.status === 200, set.text);
    const after = await empRow(emp.clerk);
    check("…and the roster shows the seat and the name it belongs to",
      after?.leave_approver_user_id === uid.appr && after?.leave_approver_name === "Amina Approver",
      { seat: after?.leave_approver_user_id, name: after?.leave_approver_name });
    const setAudit = await oi(
      `select count(*)::int as n from audit_logs where tenant_id = $1
         and entity = 'employees' and entity_id = $2 and action = 'employee.leave_approver_set'`,
      [T, emp.clerk]);
    check("…and the forensic register has its own line for the making of an approver",
      n(setAudit.rows[0].n) === 1, setAudit.rows[0].n);

    const own = await call(`/employees/${emp.clerk}`, tk.hr, {
      method: "PUT", body: JSON.stringify({ leaveApproverUserId: uid.clerk })
    });
    check("naming the person's own seat is refused, on the field the office just touched",
      own.status === 400 && code(own.json) === "VALIDATION_FAILED"
      && field(own.json) === "leaveApproverUserId" && /own seat/.test(msg(own.json)),
      { status: own.status, text: own.text });
    const foreign = await call(`/employees/${emp.clerk}`, tk.hr, {
      method: "PUT", body: JSON.stringify({ leaveApproverUserId: fDir })
    });
    check("…so is a seat from another company, which would park the leave where nobody sees it",
      foreign.status === 400 && /another company/.test(msg(foreign.json)),
      { status: foreign.status, text: foreign.text });
    const dead = await call(`/employees/${emp.clerk}`, tk.hr, {
      method: "PUT", body: JSON.stringify({ leaveApproverUserId: uid.dead })
    });
    check("…and a seat that cannot sign in is a conflict, not a silent assignment",
      dead.status === 409 && code(dead.json) === "CONFLICT" && /not active/.test(msg(dead.json)),
      { status: dead.status, text: dead.text });
    check("…while the row is still pointed at the approver it was given",
      (await empRow(emp.clerk))?.leave_approver_user_id === uid.appr);
    const noKey = await call(`/employees/${emp.clerk}`, tk.clerk, {
      method: "PUT", body: JSON.stringify({ leaveApproverUserId: uid.other })
    });
    check("a person cannot name their own approver from their own desk (no employees.edit)",
      noKey.status === 403, noKey.status);

    const cleared = await call(`/employees/${emp.clerk}`, tk.hr, {
      method: "PUT", body: JSON.stringify({ leaveApproverUserId: null })
    });
    check("the assignment can be taken back off again → 200", cleared.status === 200, cleared.text);
    check("…and the roster says nobody was named",
      (await empRow(emp.clerk))?.leave_approver_user_id === null);

    // ================================================================
    phase("2 · the route is stamped when the ask is made");
    // ================================================================
    const OFFICE1 = await raise("an ask with nobody named", "clerk",
      { ...SPAN(1), leaveKind: "sick" });
    const o1 = await db(OFFICE1);
    check("…goes to the office with the reason written on the row",
      o1?.routed_reason === "office" && o1?.routed_to_user_id === null
      && /has no approver assigned/.test(String(o1?.routed_note)), o1 && { r: o1.routed_reason, note: o1.routed_note });
    check("…and the days are counted Monday to Friday, the sign in plain date order",
      n(o1?.working_days) === 3 && o1?.starts_on === wd(1, 0) && o1?.ends_on === wd(1, 2),
      o1 && { d: o1.working_days, s: o1.starts_on, e: o1.ends_on });

    await call(`/employees/${emp.clerk}`, tk.hr, {
      method: "PUT", body: JSON.stringify({ leaveApproverUserId: uid.appr })
    });
    const A1 = await raise("once named, the next ask", "clerk",
      { ...SPAN(5), leaveKind: "annual", reason: `${MARK} annual three days` });
    const a1 = await db(A1);
    check("…lands on that person's desk and is stamped as assigned",
      a1?.routed_reason === "assigned" && a1?.routed_to_user_id === uid.appr
      && a1?.routed_note === null, a1 && { r: a1.routed_reason, to: a1.routed_to_user_id });
    check("…with the person who asked recorded as its author, not as its decider",
      String(a1?.created_by) === uid.clerk && a1?.decided_by === null && a1?.status === "pending",
      a1 && { by: a1.created_by, st: a1.status });

    const queue = await call("/leave/for-me", tk.appr);
    const q1 = (queue.json ?? []).find((r: any) => r.id === A1);
    check("the queue of the person it was sent to holds it, and nothing that was not sent to them",
      queue.status === 200 && (queue.json ?? []).length === 1 && q1?.full_name === "Chaji Clerk"
      && q1?.routed_reason === "assigned" && q1?.raised_by_me === false,
      { status: queue.status, rows: queue.json?.length });
    check("…and it tells them what the ask costs: three working days of a 2027 annual year",
      n(q1?.working_days) === 3 && q1?.annual_taken === 0 && q1?.annual_also_waiting === 0,
      q1 && { d: q1.working_days, taken: q1.annual_taken, also: q1.annual_also_waiting });
    check("…while a colleague who was not asked holds no queue at all",
      (await call("/leave/for-me", tk.other)).json?.length === 0);

    const A1b = await raise("a second annual ask", "clerk", { ...SPAN(9), leaveKind: "annual" });
    const queue2 = (await call("/leave/for-me", tk.appr)).json ?? [];
    const q1b = queue2.find((r: any) => r.id === A1b);
    check("…is counted against the same year, so the approver sees the pile, not one row",
      queue2.length === 2 && n(q1b?.annual_also_waiting) === 3
      && n(q1b?.working_days) === 3, { rows: queue2.length, also: q1b?.annual_also_waiting });
    check("…and the older ask is answered first",
      queue2[0]?.id === A1 && queue2[1]?.id === A1b, queue2.map((r: any) => r.id === A1));

    // The approver themself goes away, decided by the office — then the chain has to notice.
    const APPR1 = await raise("the approver's own ask", "appr",
      { ...SPAN(2, 0, 4), leaveKind: "unpaid" });
    check("…is the office's to answer, since nobody was named above them",
      (await db(APPR1))?.routed_reason === "office");
    const away = await call(`/leave/${APPR1}/decision`, tk.hr, {
      method: "POST", body: JSON.stringify({ decision: "approve", note: "Go, and take the week." })
    });
    check("…and the office grants it", away.status === 200 && (await db(APPR1))?.status === "approved",
      away.text);

    const A2 = await raise("an ask across the approver's own week off", "clerk",
      { ...SPAN(2), leaveKind: "sick" });
    const a2 = await db(A2);
    check("…does not sit on their desk until they come back: it goes to the office, by name",
      a2?.routed_reason === "office" && a2?.routed_to_user_id === null
      && /Amina Approver is on approved leave across those days/.test(String(a2?.routed_note)),
      a2 && { r: a2.routed_reason, note: a2.routed_note });

    await call(`/employees/${emp.clerk}`, tk.hr, {
      method: "PUT", body: JSON.stringify({ leaveApproverUserId: null, supervisorId: emp.boss })
    });
    const S1 = await raise("with no approver but a supervisor on the roster", "clerk",
      { ...SPAN(4), leaveKind: "other" });
    check("…the ask goes to the supervisor's own seat",
      (await db(S1))?.routed_reason === "supervisor"
      && (await db(S1))?.routed_to_user_id === uid.boss, await db(S1));
    check("…which is the desk that now holds it",
      (await call("/leave/for-me", tk.boss)).json?.some((r: any) => r.id === S1) === true);

    await oi(`update users set status = 'suspended' where id = $1`, [uid.boss]);
    const D1 = await raise("while that supervisor's seat is suspended", "clerk",
      { ...SPAN(8), leaveKind: "sick" });
    const d1 = await db(D1);
    check("…the ask is not left with a seat that cannot sign in — the office is told why",
      d1?.routed_reason === "office" && /not answering any more/.test(String(d1?.routed_note)),
      d1 && { r: d1.routed_reason, note: d1.routed_note });
    await oi(`update users set status = 'active' where id = $1`, [uid.boss]);

    const clash = await ask("clerk", { ...SPAN(5), leaveKind: "sick" });
    check("one person cannot be away twice, even when both asks went to the same desk",
      clash.status === 409 && code(clash.json) === "CONFLICT"
      && /already has a leave request covering/.test(msg(clash.json)),
      { status: clash.status, text: clash.text });
    const BOSS1 = await raise("the office raising an ask for a colleague", "hr",
      { employeeId: emp.boss, ...SPAN(10), leaveKind: "other" });
    const bossRow = await db(BOSS1);
    check("…is allowed, is written against that colleague and is the office's own act",
      String(bossRow?.employee_id) === emp.boss && String(bossRow?.created_by) === uid.hr,
      bossRow && { e: bossRow.employee_id, by: bossRow.created_by });
    const twin = await ask("other", { ...SPAN(10), leaveKind: "sick" });
    check("…while the same dates for a different person are two separate asks",
      twin.status === 201, twin.text);
    check("…and the answer comes back with the days as plain dates, never as a shifted instant",
      twin.json?.starts_on === wd(10, 0) && twin.json?.ends_on === wd(10, 2)
      && n(twin.json?.working_days) === 3,
      twin.json && { s: twin.json.starts_on, e: twin.json.ends_on });

    // ================================================================
    phase("3 · who is allowed to answer");
    // ================================================================
    const hrTry = await call(`/leave/${A1}/decision`, tk.hr, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("the office holding leave.decide cannot take a row off the person it was sent to",
      hrTry.status === 403 && /Amina Approver/.test(msg(hrTry.json))
      && /escalate it to the office/.test(msg(hrTry.json)), { status: hrTry.status, text: hrTry.text });
    const dirTry = await call(`/leave/${A1}/decision`, tk.dir, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("…nor can a director who simply got there first", dirTry.status === 403, dirTry.text);
    const stranger = await call(`/leave/${A1}/decision`, tk.other, {
      method: "POST", body: JSON.stringify({ decision: "reject", note: "No." })
    });
    check("…nor a colleague who was never asked, and the refusal names who was",
      stranger.status === 403 && /Amina Approver/.test(msg(stranger.json)), stranger.text);
    const self = await call(`/leave/${A1}/decision`, tk.clerk, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("…and the person who asked cannot grant their own leave",
      self.status === 403 && /came from you/.test(msg(self.json)), self.text);
    const untouched = await db(A1);
    check("…and not one of those refusals moved the row",
      untouched?.status === "pending" && untouched?.decided_by === null
      && untouched?.decided_at === null && String(untouched?.routed_to_user_id) === uid.appr,
      untouched && { st: untouched.status, by: untouched.decided_by });

    const answer = await call(`/leave/${A1}/decision`, tk.appr, {
      method: "POST", body: JSON.stringify({ decision: "approve", note: "Enjoy the week" })
    });
    check("the person it was sent to answers it, holding no deciding key of their own",
      answer.status === 200 && answer.json?.status === "approved", answer.text);
    const decided = await db(A1);
    check("…with the answer, the seat, the moment and the note all on the row",
      decided?.status === "approved" && String(decided?.decided_by) === uid.appr
      && !!decided?.decided_at && decided?.decision_note === "Enjoy the week", decided);
    check("…and the route it took is left exactly as the ask stamped it",
      String(decided?.routed_to_user_id) === uid.appr && decided?.routed_reason === "assigned"
      && decided?.routed_note === null && decided?.escalated_at === null, decided);
    const again = await call(`/leave/${A1}/decision`, tk.appr, {
      method: "POST", body: JSON.stringify({ decision: "reject" })
    });
    check("the same request is not answered twice", again.status === 409, again.text);

    const balances = await call("/leave/balances?year=2027", tk.hr);
    const clerkBal = (balances.json?.rows ?? []).find((r: any) => r.employee_id === emp.clerk);
    check("the register counts the granted days against the year's entitlement",
      balances.status === 200 && n(clerkBal?.annualUsed) === 3
      && n(clerkBal?.annualPending) === 3 && n(clerkBal?.entitlement) === 28
      && n(clerkBal?.annualRemaining) === 25, clerkBal);

    const officeTry = await call(`/leave/${OFFICE1}/decision`, tk.other, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("a request the office is holding is not answered from a desk without the key",
      officeTry.status === 403 && /office/.test(msg(officeTry.json)), officeTry.text);
    const officeDecide = await call(`/leave/${OFFICE1}/decision`, tk.hr, {
      method: "POST", body: JSON.stringify({ decision: "approve", note: "Approved by the office." })
    });
    check("…while the office answers it", officeDecide.status === 200
      && (await db(OFFICE1))?.status === "approved", officeDecide.text);

    // Back to a named approver, so the next ask is a person's rather than the office's.
    await call(`/employees/${emp.clerk}`, tk.hr, {
      method: "PUT", body: JSON.stringify({ leaveApproverUserId: uid.appr })
    });
    const REJ1 = await raise("a refusal is a decision too", "clerk",
      { ...SPAN(11), leaveKind: "sick" });
    check("…and it is stamped onto the approver's desk before it is answered",
      (await db(REJ1))?.routed_reason === "assigned"
      && String((await db(REJ1))?.routed_to_user_id) === uid.appr, await db(REJ1));
    const rejected = await call(`/leave/${REJ1}/decision`, tk.appr, {
      method: "POST", body: JSON.stringify({ decision: "reject", note: "Quarter end, not then." })
    });
    const rejRow = await db(REJ1);
    check("…and a refusal by the assigned approver lands as refused with its reason",
      rejected.status === 200 && rejRow?.status === "rejected"
      && String(rejRow?.decided_by) === uid.appr && rejRow?.decision_note === "Quarter end, not then.",
      rejRow && { st: rejRow.status, note: rejRow.decision_note });
    const bossOwn = await call(`/leave/${BOSS1}/decision`, tk.boss, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("the person an ask was raised for cannot answer it, even with the office as the author",
      bossOwn.status === 403 && /came from you/.test(msg(bossOwn.json)), bossOwn.text);

    const noRoute = await call(`/leave/${randomUUID()}/decision`, tk.hr, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("a request id that is not there is a 404, not a guess", noRoute.status === 404, noRoute.status);
    const badBody = await call(`/leave/${S1}/decision`, tk.boss, {
      method: "POST", body: JSON.stringify({ decision: "maybe" })
    });
    check("an answer that is neither of the two words never reaches the row",
      badBody.status === 400, badBody.status);

    // ================================================================
    phase("4 · an escalation carries the reason somebody typed");
    // ================================================================
    const ESC1 = await raise("an ask the holder cannot answer", "clerk",
      { ...SPAN(12), leaveKind: "unpaid" });
    const byStranger = await call(`/leave/${ESC1}/escalate`, tk.other, {
      method: "POST", body: JSON.stringify({})
    });
    check("a stranger to the chain cannot move it upstairs", byStranger.status === 403, byStranger.text);
    const byHolder = await call(`/leave/${ESC1}/escalate`, tk.appr, {
      method: "POST", body: JSON.stringify({ note: "I am away myself that week." })
    });
    check("the person holding it can send it up, and the typed reason travels with it",
      byHolder.status === 200 && byHolder.json?.routedReason === "escalated", byHolder.text);
    const escRow = await db(ESC1);
    check("…so the row now says the office holds it, from whose desk it left and who moved it",
      escRow?.routed_reason === "escalated" && escRow?.routed_to_user_id === null
      && escRow?.routed_note === "I am away myself that week."
      && String(escRow?.escalated_by) === uid.appr && String(escRow?.escalated_from) === uid.appr
      && !!escRow?.escalated_at && escRow?.status === "pending",
      escRow && { r: escRow.routed_reason, n: escRow.routed_note, from: escRow.escalated_from });
    check("…and it has left the queue it was in",
      (await call("/leave/for-me", tk.appr)).json?.some((r: any) => r.id === ESC1) === false);
    const twice = await call(`/leave/${ESC1}/escalate`, tk.appr, { method: "POST", body: "{}" });
    check("the office is not asked twice", twice.status === 409 && /not asked twice/.test(msg(twice.json)),
      twice.text);
    const escDecide = await call(`/leave/${ESC1}/decision`, tk.hr, {
      method: "POST", body: JSON.stringify({ decision: "approve", note: "Taken from a stuck desk." })
    });
    check("…and the office, once handed it, may answer it",
      escDecide.status === 200 && (await db(ESC1))?.status === "approved", escDecide.text);
    const decidedEsc = await call(`/leave/${ESC1}/escalate`, tk.clerk, { method: "POST", body: "{}" });
    check("a request that has been answered is not moved",
      decidedEsc.status === 409 && /already been answered/.test(msg(decidedEsc.json)), decidedEsc.text);

    const ESC2 = await raise("the requester sending their own ask up", "clerk",
      { ...SPAN(13), leaveKind: "bereavement" });
    const byOwner = await call(`/leave/${ESC2}/escalate`, tk.clerk, { method: "POST", body: "{}" });
    const esc2 = await db(ESC2);
    check("…is allowed, and the register says whose desk it came off without being told",
      byOwner.status === 200 && /Sent up from Amina Approver to the office\./.test(String(esc2?.routed_note)),
      esc2 && { note: esc2.routed_note });
    const editEscalated = await call(`/leave/${ESC2}`, tk.clerk, {
      method: "PUT", body: JSON.stringify({ reason: `${MARK} moved to a shorter span`, endsOn: wd(13, 0) })
    });
    const esc2b = await db(ESC2);
    check("…and an edited request keeps the route it was escalated onto, rather than falling back",
      editEscalated.status === 200 && esc2b?.routed_reason === "escalated"
      && String(esc2b?.escalated_at) === String(esc2?.escalated_at)
      && n(esc2b?.working_days) === 1,
      esc2b && { r: esc2b.routed_reason, d: esc2b.working_days });

    const ESC3 = await raise("an ask sitting on a desk that will not clear", "clerk",
      { ...SPAN(15), leaveKind: "sick" });
    const byOffice = await call(`/leave/${ESC3}/escalate`, tk.hr, {
      method: "POST", body: JSON.stringify({ note: "Three weeks with no answer." })
    });
    check("the office can take it in from under a desk that is not answering",
      byOffice.status === 200 && (await db(ESC3))?.routed_reason === "escalated", byOffice.text);
    const esc3 = await db(ESC3);
    check("…while naming the desk it took it from", String(esc3?.escalated_from) === uid.appr, esc3);

    // ================================================================
    phase("5 · the ask itself stays the requester's to change, until it is answered");
    // ================================================================
    const EDIT1 = await raise("an ask that will be moved", "clerk", { ...SPAN(16), leaveKind: "other" });
    await call(`/employees/${emp.clerk}`, tk.hr, {
      method: "PUT", body: JSON.stringify({ leaveApproverUserId: null, supervisorId: emp.boss })
    });
    const moved = await call(`/leave/${EDIT1}`, tk.clerk, {
      method: "PUT", body: JSON.stringify({ startsOn: wd(16, 0), endsOn: wd(16, 3) })
    });
    const movedRow = await db(EDIT1);
    check("moving the dates re-runs the chain, so the ask follows the person named since",
      moved.status === 200 && movedRow?.routed_reason === "supervisor"
      && String(movedRow?.routed_to_user_id) === uid.boss && n(movedRow?.working_days) === 4,
      movedRow && { r: movedRow.routed_reason, d: movedRow.working_days });
    check("…and the answer is not edited under anyone's hand: it is still waiting",
      movedRow?.status === "pending" && movedRow?.decided_by === null);
    const byOther = await call(`/leave/${EDIT1}`, tk.other, {
      method: "PUT", body: JSON.stringify({ reason: "somebody else's ask" })
    });
    check("somebody else's request is not edited from another desk", byOther.status === 403, byOther.status);
    const decidedEdit = await call(`/leave/${REJ1}`, tk.clerk, {
      method: "PUT", body: JSON.stringify({ endsOn: wd(11, 4) })
    });
    check("a request that has been answered is not edited by the person who asked",
      decidedEdit.status === 409 && /not edited/.test(msg(decidedEdit.json)), decidedEdit.text);
    const officeEdit = await call(`/leave/${REJ1}`, tk.hr, {
      method: "PUT", body: JSON.stringify({ reason: "corrected by the office" })
    });
    check("…nor from the office's desk, which is the one seat that clears the ownership gate",
      officeEdit.status === 409 && /not edited/.test(msg(officeEdit.json)), officeEdit.text);
    const strangerEdit = await call(`/leave/${REJ1}`, tk.appr, {
      method: "PUT", body: JSON.stringify({ endsOn: wd(11, 4) })
    });
    check("…and a desk that holds neither the ask nor the key is turned away before that, on 403",
      strangerEdit.status === 403 && /somebody else/.test(msg(strangerEdit.json)), strangerEdit.text);

    const closeOwn = await call(`/leave/${A2}/cancel`, tk.clerk, {
      method: "POST", body: JSON.stringify({ note: "Never mind, I will stay." })
    });
    check("the requester closes their own waiting ask", closeOwn.status === 200
      && (await db(A2))?.status === "cancelled", closeOwn.text);
    const freed = await ask("clerk", { ...SPAN(2), leaveKind: "other" });
    check("…which frees those dates for a fresh ask on the same days", freed.status === 201, freed.text);
    const granted = await call(`/leave/${A1}/cancel`, tk.clerk, { method: "POST", body: "{}" });
    check("leave that was granted is not closed by the person who asked",
      granted.status === 403 && /closed by the office/.test(msg(granted.json)), granted.text);
    const officeClose = await call(`/leave/${A1}/cancel`, tk.hr, {
      method: "POST", body: JSON.stringify({ note: "Back on second thoughts." })
    });
    const closedA1 = await db(A1);
    check("…while the office that granted it can close it, note and all",
      officeClose.status === 200 && closedA1?.status === "cancelled"
      && closedA1?.decision_note === "Back on second thoughts."
      && String(closedA1?.decided_by) === uid.appr, closedA1 && { st: closedA1.status, n: closedA1.decision_note });
    const closeRejected = await call(`/leave/${REJ1}/cancel`, tk.hr, { method: "POST", body: "{}" });
    check("a refused request stays on record as refused",
      closeRejected.status === 409 && /as refused/.test(msg(closeRejected.json)), closeRejected.text);
    const balances2 = await call("/leave/balances?year=2027", tk.hr);
    const clerkBal2 = (balances2.json?.rows ?? []).find((r: any) => r.employee_id === emp.clerk);
    check("…and a closed grant stops counting against the year it was taken from",
      n(clerkBal2?.annualUsed) === 0 && n(clerkBal2?.annualPending) === 3
      && n(clerkBal2?.annualRemaining) === 28, clerkBal2);

    // ================================================================
    phase("6 · the register says, per row, what this seat may do");
    // ================================================================
    const as = async (who: string, qs = "") => (await call(`/leave${qs}`, tk[who])).json ?? [];
    const hrRows = await as("hr");
    const pick = (rows: any[], id: string) => rows.find((r: any) => r.id === id);
    check("the office sees a row that is with a person but cannot decide it — and can move it",
      pick(hrRows, S1)?.can_decide === false && pick(hrRows, S1)?.can_escalate === true,
      pick(hrRows, S1) && { d: pick(hrRows, S1).can_decide, e: pick(hrRows, S1).can_escalate });
    check("…while an escalated row is the office's to answer",
      pick(hrRows, ESC3)?.can_decide === true && pick(hrRows, ESC3)?.can_escalate === false,
      pick(hrRows, ESC3) && { d: pick(hrRows, ESC3).can_decide });
    check("…and an answered row offers neither act",
      pick(hrRows, ESC1)?.can_decide === false && pick(hrRows, ESC1)?.can_escalate === false
      && pick(hrRows, REJ1)?.can_decide === false);
    // The web register prints a Withdraw link straight from can_cancel, so the field
    // has to say what /leave/:id/cancel then enforces: a seat with the deciding key
    // may close a pending ask or unwind a grant, and a refusal is never a draft.
    const closeActs = (rows: any[]) => rows.filter((r: any) =>
      r.can_cancel !== (r.status === "pending" || r.status === "approved"));
    check("…while the office is offered the close of a waiting or granted day and of no refusal",
      hrRows.length > 0 && closeActs(hrRows).length === 0
      && hrRows.some((r: any) => r.status === "approved" && r.can_cancel === true)
      && hrRows.some((r: any) => r.status === "rejected" && r.can_cancel === false),
      closeActs(hrRows).map((r: any) => ({ id: r.id, st: r.status, c: r.can_cancel })));
    check("…with the holder, the reason and the escalation all named on the row",
      pick(hrRows, ESC3)?.routed_reason === "escalated"
      && pick(hrRows, ESC3)?.escalated_by_name === "Heshi Officer"
      && pick(hrRows, ESC3)?.escalated_from_name === "Amina Approver"
      && pick(hrRows, ESC3)?.routed_note === "Three weeks with no answer.",
      pick(hrRows, ESC3) && { by: pick(hrRows, ESC3).escalated_by_name });
    const apprRows = await as("appr");
    check("the assigned approver holds the deciding of their own rows and no others",
      apprRows.length > 0 && apprRows.every((r: any) => r.can_decide === false
        || r.routed_to_user_id === uid.appr),
      apprRows.map((r: any) => !!r.can_decide));
    const clerkRows = await as("clerk");
    check("…and the requester sees their own asks as nobody's to decide but the chain's",
      clerkRows.length > 0 && clerkRows.every((r: any) => r.can_decide === false)
      && pick(clerkRows, S1)?.mine === true && pick(clerkRows, BOSS1)?.mine === false,
      { n: clerkRows.length, mine: pick(clerkRows, S1)?.mine });
    const clerkClose = clerkRows.filter((r: any) =>
      r.can_cancel !== (r.status === "pending" && r.mine));
    check("…and is offered the withdrawal of a waiting ask but never of a granted day",
      clerkClose.length === 0 && pick(clerkRows, S1)?.can_cancel === true
      && pick(clerkRows, ESC1)?.can_cancel === false,
      { bad: clerkClose.map((r: any) => r.status + ":" + r.can_cancel) });
    const pending = await as("hr", "?status=pending");
    check("the register filters to what is still waiting",
      pending.length > 0 && pending.every((r: any) => r.status === "pending"), pending.length);
    const oneEmp = await as("hr", `?employeeId=${emp.clerk}`);
    check("…and to one person's book",
      oneEmp.length > 0 && oneEmp.every((r: any) => r.employee_id === emp.clerk), oneEmp.length);
    const ghost = await call(`/leave?employeeId=${E_PLAIN}`, tk.hr);
    check("a staff record with no asks reads empty rather than as an error",
      ghost.status === 200 && (ghost.json ?? []).length === 0, ghost.status);

    const auditView = await as("audit");
    check("a seat holding only leave.view reads the register",
      auditView.length > 0 && auditView.every((r: any) => r.can_decide === false),
      { rows: auditView.length });
    const auditAsk = await ask("audit", { ...SPAN(20), leaveKind: "sick" });
    check("…but cannot raise an ask", auditAsk.status === 403, auditAsk.status);
    const auditQueue = await call("/leave/for-me", tk.audit);
    check("…nor open a queue it was never given", auditQueue.status === 403, auditQueue.status);
    const noToken = await call("/leave", null);
    check("with no token there is no register", noToken.status === 401, noToken.status);
    const noSeat = await call("/leave", tk.dir, {
      method: "POST", body: JSON.stringify({ ...SPAN(21), leaveKind: "sick" })
    });
    check("a director whose sign-in is not on the staff register is told so, on the field",
      noSeat.status === 400 && field(noSeat.json) === "employeeId" && /not linked to a staff record/.test(msg(noSeat.json)),
      { status: noSeat.status, text: noSeat.text });
    const badDates = await ask("clerk", { startsOn: wd(22, 3), endsOn: wd(22, 1), leaveKind: "sick" });
    check("an ask whose end is before its start never reaches the register",
      badDates.status === 400 && field(badDates.json) === "endsOn", badDates.status);

    // ================================================================
    phase("7 · none of it reaches across into another company");
    // ================================================================
    const fDecide = await call(`/leave/${S1}/decision`, tk.foreign, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("another company's director decides nobody's leave: the row is not in their book",
      fDecide.status === 404, fDecide.text);
    const fEscalate = await call(`/leave/${S1}/escalate`, tk.foreign, { method: "POST", body: "{}" });
    check("…nor moves it upstairs", fEscalate.status === 404, fEscalate.status);
    const fEdit = await call(`/leave/${S1}`, tk.foreign, {
      method: "PUT", body: JSON.stringify({ reason: "from elsewhere" })
    });
    check("…nor edits it", fEdit.status === 404, fEdit.status);
    const fCancel = await call(`/leave/${S1}/cancel`, tk.foreign, { method: "POST", body: "{}" });
    check("…nor closes it", fCancel.status === 404, fCancel.status);
    const fList = await call("/leave", tk.foreign);
    check("…and their register reads empty, with no id list to fish from",
      fList.status === 200 && (fList.json ?? []).length === 0,
      { status: fList.status, rows: fList.json?.length });
    const fQueue = await call("/leave/for-me", tk.foreign);
    check("…and no queue", fQueue.status === 200 && (fQueue.json ?? []).length === 0, fQueue.status);
    const fAsk = await call("/leave", tk.foreign, {
      method: "POST", body: JSON.stringify({ employeeId: emp.clerk, ...SPAN(23), leaveKind: "sick" })
    });
    check("an employee id from this company is not a person over there", fAsk.status === 400, fAsk.status);
    const stillThere = await db(S1);
    check("…after every one of those attempts the row is exactly what this company left it",
      stillThere?.status === "pending" && String(stillThere?.routed_to_user_id) === uid.boss
      && stillThere?.routed_reason === "supervisor", stillThere && { st: stillThere.status });

    // ================================================================
    phase("8 · the book of acts");
    // ================================================================
    const acts = (await oi(
      `select action, count(*)::int as n from audit_logs
        where tenant_id = $1 and entity in ('leave_requests','employees')
        group by action order by action`, [T])).rows as { action: string; n: number }[];
    const has = (a: string, atLeast = 1) =>
      (acts.find((x) => x.action === a)?.n ?? 0) >= atLeast;
    check("every ask, answer, move and edit left its own line",
      has("leave.requested", 8) && has("leave.approved", 3) && has("leave.rejected", 1)
      && has("leave.escalated", 3) && has("leave.cancelled", 2) && has("leave.updated", 2)
      && has("leave.requested_for_staff", 1), acts);
    check("…including the making and the taking back of an approver",
      has("employee.leave_approver_set", 2) && has("employee.leave_approver_cleared", 2), acts);
    const deciders = await oi(
      `select count(distinct actor_user_id)::int as n from audit_logs
        where tenant_id = $1 and action like 'leave.%'`, [T]);
    check("…and the register can say that more than one desk took part, not only the office",
      n(deciders.rows[0].n) >= 3, deciders.rows[0]);

    console.log(`\n${MARK}: ${raised} asks raised across ${ROLES.length} seats and two companies`);
  } finally {
    await sweep();
    const left = await oi(
      `select (select count(*)::int from tenants where name like $1) as companies,
              (select count(*)::int from users where email like $2) as seats,
              (select count(*)::int from employees
                where tenant_id = any($3::uuid[])
                   or user_id in (select id from users where email like $2)) as staff,
              (select count(*)::int from leave_requests
                where tenant_id = any($3::uuid[])
                   or created_by in (select id from users where email like $2)) as asks`,
      [TEN_SWEEP, EMAIL_SWEEP, [T, F]]);
    const L = left.rows[0];
    console.log(`cleanup: companies=${L.companies} seats=${L.seats} staff=${L.staff} asks=${L.asks} remaining ` +
      `(audit_logs rows are kept by design)`);
    await owner.end();
  }

  console.log(failures ? `${failures} FAILED` : "all leave-approver smoke checks passed");
  if (failures) process.exit(1);
}

function n(v: unknown): number { return Number(v ?? 0); }

main().catch((e) => { console.error("smoke crashed:", String((e as any)?.message ?? e).slice(0, 600)); process.exit(1); });
