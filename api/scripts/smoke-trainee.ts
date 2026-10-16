/**
 * End-to-end smoke for the trainee and procedural-workflow module (056 +
 * procedures.routes.ts + trainee-reports.routes.ts): the personnel profile the
 * intake form collects, the procedure library, a task's copied flow with its
 * mandatory checklist, and the single signed completion report.
 *
 * Proves the six promises the migration and routes make:
 *   1. the profile stores what the form asks and nothing else — age is read off
 *      the date of birth, the emergency phone is sealed and never returned;
 *   2. the shipped procedures are a read-only library — a tenant works on a copy;
 *   3. assigning a procedure lays its steps and checklist under the task at that
 *      moment, so a later library edit cannot rewrite in-flight work;
 *   4. the gates are the database's: a step will not close with its checklist
 *      open, a later step will not close before an earlier one, the task will not
 *      close before Final Sign-off, and a closed step's ticks are evidence;
 *   5. a completion report is generated as a draft, cannot close without all
 *      three sign-offs and the supervisor's remarks, and is immutable afterwards;
 *   6. the roles decide who may do any of it, and no tenant sees another's.
 *
 * Everything it creates is removed through the owner connection.
 *
 * Run: npx tsx scripts/smoke-trainee.ts   (needs the API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const EMPLOYEE = "SMOKE TRAINEE AMINA JUMA NIDA";
const COLLEGE = "SMOKE Institute of Business Studies";
const DEPARTMENT = "SMOKE Operations";
const PROCEDURE = "SMOKE House clearing flow";
const TASK_A = "SMOKE trainee flow task";
const TASK_B = "SMOKE plain task";
const EMERGENCY_PHONE = "+255710000999";
const REPORT_START = iso(-90);
const REPORT_END = iso(0);

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label, String(JSON.stringify(detail)).slice(0, 300)); }
}

function iso(daysFromNow: number) {
  return new Date(Date.now() + daysFromNow * 86400000).toISOString().slice(0, 10);
}

async function mint(sub: string, tid: string, roles: string[] = ["director"]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000aa", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("15m").sign(key);
}

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  // The API wraps failures as { error: { code, message, details } }; the checks
  // below read message directly.
  if (json?.error && !json.message) json = { ...json, ...json.error };
  return { status: res.status, json, text };
}
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

/** The first sentence of the trigger's raise — that is what the route forwards. */
const gate = (r: { status: number; json: any }) =>
  r.status === 409 && String(r.json?.message ?? "").length > 0;

/**
 * Children first. The flow rows cascade from the step, the signatures from the
 * report, so the order below is the only one that leaves nothing behind. Tasks
 * and the employee are matched on the SMOKE fixture names, so an interrupted run
 * cannot strand a trainee or a half-ticked checklist.
 *
 * audit_logs is append-only by design — prevent_audit_mutation refuses the
 * delete even on the owner connection — so this fixture's entries stay on the
 * record, which is what they are for.
 */
async function wipe(owner: pg.Client, tid: string) {
  const smokeEmployees = `select id from employees where tenant_id = $1 and full_name like 'SMOKE %'`;
  const smokeTasks = `select id from office_tasks where tenant_id = $1 and title like 'SMOKE %'`;
  const smokeProcedures = `select id from task_procedures where tenant_id = $1 and name like 'SMOKE %'`;
  // A signed report and its signatures are immutable by design (056 + 057), and
  // the gate does not care who is asking. So teardown follows the same path an
  // operator would: reopen the paper, then the blocks come off.
  await owner.query(`update trainee_reports set status = 'draft', updated_at = now()
    where tenant_id = $1 and status = 'complete'
      and employee_id in (${smokeEmployees})`, [tid]);
  await owner.query(`delete from trainee_report_signoffs where tenant_id = $1
    and report_id in (select id from trainee_reports where tenant_id = $1
      and employee_id in (${smokeEmployees}))`, [tid]);
  await owner.query(`delete from trainee_reports where tenant_id = $1
    and employee_id in (${smokeEmployees})`, [tid]);
  await owner.query(`delete from employee_evaluations where tenant_id = $1
    and employee_id in (${smokeEmployees})`, [tid]);
  await owner.query(`delete from office_task_step_checks where tenant_id = $1
    and step_id in (select id from office_task_steps where tenant_id = $1
      and office_task_id in (${smokeTasks}))`, [tid]);
  await owner.query(`delete from office_task_steps where tenant_id = $1
    and office_task_id in (${smokeTasks})`, [tid]);
  await owner.query(`delete from office_tasks where tenant_id = $1
    and title like 'SMOKE %'`, [tid]);
  await owner.query(`delete from task_procedure_steps where tenant_id = $1
    and procedure_id in (${smokeProcedures})`, [tid]);
  await owner.query(`delete from task_procedures where tenant_id = $1
    and name like 'SMOKE %'`, [tid]);
  await owner.query(`delete from employees where tenant_id = $1 and full_name like 'SMOKE %'`, [tid]);
  // A run interrupted inside the role tests leaves a fixture login behind; the
  // user_roles row must go first — it references the user.
  await owner.query(`delete from user_roles where user_id in
    (select id from users where tenant_id = $1 and full_name like 'SMOKE %')`, [tid]);
  await owner.query(`delete from users where tenant_id = $1 and full_name like 'SMOKE %'`, [tid]);
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await owner.connect();

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health) { console.error("API not running on :4000 — boot it first"); process.exit(1); }

  const who = await owner.query(
    `select u.id as user_id, u.tenant_id from users u
     where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
       and exists (select 1 from company_profiles cp where cp.tenant_id = u.tenant_id)
     order by u.created_at limit 1`);
  if (!who.rowCount) throw new Error("No active director with a company profile found");
  const tid: string = who.rows[0].tenant_id;
  const uid: string = who.rows[0].user_id;
  console.log(`trainee tenant ${tid} as director ${uid}`);

  await wipe(owner, tid);
  const token = await mint(uid, tid);

  // ---------- 1. The personnel profile the intake form collects ----------

  const badDob = await call("/employees", token, post({
    fullName: "SMOKE TRAINEE TOO YOUNG", dateOfBirth: iso(400)
  }));
  check("intake refuses a date of birth in the future",
    badDob.status === 400 && /future/i.test(String(badDob.json?.message)), badDob.json);

  const emp = await call("/employees", token, post({
    fullName: EMPLOYEE,
    dateOfBirth: "2003-03-05",
    gender: "female",
    academicStatus: "student",
    college: COLLEGE,
    qualifications: ["Diploma in Clearing and Forwarding", "Certificate in ICT"],
    emergencyContactName: "SMOKE Halima Juma",
    emergencyRelationship: "Mother",
    emergencyPhone: EMERGENCY_PHONE,
    jobTitle: "Trainee Operations Officer",
    department: DEPARTMENT,
    employmentType: "intern",
    status: "active",
    contractStart: REPORT_START,
    contractEnd: REPORT_END
  }));
  check("profile: the trainee is registered", emp.status === 201, emp.json);
  const employeeId: string = emp.json?.id ?? "";

  const sheet = await call(`/employees/${employeeId}`, token);
  const p = sheet.json ?? {};
  check("profile sheet: legal name, college and qualifications read back",
    p.full_name === EMPLOYEE && p.college === COLLEGE
    && Array.isArray(p.qualifications) && p.qualifications.length === 2, p);
  check("age is derived from the date of birth, never stored",
    Number(p.age) === 23 && p.date_of_birth === "2003-03-05", { age: p.age, dob: p.date_of_birth });
  check("academic status is the status the form offers",
    p.academic_status === "student" && p.gender === "female", p);
  check("the emergency phone is sealed — the sheet says it exists, not what it is",
    p.has_emergency_phone === true && !JSON.stringify(sheet.json).includes(EMERGENCY_PHONE)
    && !("emergency_phone" in p), p);
  check("the emergency relationship reads back",
    p.emergency_relationship === "Mother", p);

  const roster = await call("/employees", token);
  const listed = (roster.json ?? []).find((x: any) => x.id === employeeId);
  check("the roster carries the profile block additively",
    !!listed && listed.full_name === EMPLOYEE && "flowed_tasks" in listed
    && "avatar_document_id" in listed && "latest_document_id" in listed, listed);

  const edited = await call(`/employees/${employeeId}`, token, put({
    academicStatus: "graduate", qualifications: ["Degree in Logistics"]
  }));
  const after = await call(`/employees/${employeeId}`, token);
  check("profile edit is presence-based — untouched fields survive",
    edited.status === 200 && after.json?.academic_status === "graduate"
    && after.json?.college === COLLEGE && after.json?.gender === "female"
    && after.json?.qualifications?.length === 1, after.json);

  // ---------- 2. The procedure library is read-only below the tenant line ----------

  const lib = await call("/procedures", token);
  const rows: any[] = lib.json ?? [];
  const std = rows.find((x) => x.name === "Standard administrative task");
  const clearing = rows.find((x) => x.name === "Import clearing file");
  const induction = rows.find((x) => x.name === "Trainee induction and completion");
  check("library: the three shipped defaults are there, system-owned",
    !!std && !!clearing && !!induction && std.is_system === true, rows.map((x) => x.name));
  check("the standard flow runs Initiation to Final Sign-off in five steps",
    std?.steps?.length === 5 && std.steps[0].name === "Initiation"
    && std.steps[4].name === "Final Sign-off" && std.steps[4].is_final === true, std?.steps);
  check("the clearing flow carries the customs paperwork as document milestones",
    clearing?.steps?.length === 7
    && clearing.steps[1].required_documents?.includes("bill_of_lading")
    && clearing.steps[2].required_documents?.includes("declaration"), clearing?.steps?.[2]);

  const touchDefault = await call(`/procedures/${std.id}`, token, put({ name: "SMOKE renamed default" }));
  check("a shipped default cannot be edited from a tenant",
    touchDefault.status === 409 && /system default/i.test(String(touchDefault.json?.message)),
    touchDefault.json);
  const retireDefault = await call(`/procedures/${std.id}`, token, { method: "DELETE" });
  check("a shipped default cannot be retired from a tenant",
    retireDefault.status === 409 || retireDefault.status === 403, retireDefault.json);

  const authored = await call("/procedures", token, post({
    name: PROCEDURE, description: "The house version, with a revenue-signing end.", scope: "cargo",
    steps: [
      { seq: 1, name: "Initiation", instructions: "Open on the mandate.",
        checklist: ["Client instructed"], requiredDocuments: ["contract"] },
      { seq: 2, name: "Final Sign-off", instructions: "Close and sign.",
        checklist: ["Supervisor approved"], isFinal: true }
    ]
  }));
  check("author: a tenant writes its own procedure", authored.status === 201, authored.json);
  const ownId: string = authored.json?.id ?? "";

  const badSeq = await call("/procedures", token, post({
    name: "SMOKE broken flow", scope: "office",
    steps: [{ seq: 1, name: "Only step" }, { seq: 3, name: "Gap in the middle" }]
  }));
  check("author: step numbering must be dense from 1",
    badSeq.status === 400 && /numbered from 1/i.test(String(badSeq.json?.message)), badSeq.json);
  const noEnd = await call("/procedures", token, post({
    name: "SMOKE endless flow", scope: "office", steps: [{ seq: 1, name: "Start only" }]
  }));
  check("author: every flow needs a Final Sign-off step",
    noEnd.status === 400 && /final sign-off/i.test(String(noEnd.json?.message)), noEnd.json);

  const copy = await call(`/procedures/${induction.id}/duplicate`, token,
    post({ name: `${PROCEDURE} copy` }));
  check("duplicate takes a tenant-owned copy of a default", copy.status === 201, copy.json);
  const copyId: string = copy.json?.id ?? "";
  const lib2 = await call("/procedures", token);
  const copied = (lib2.json ?? []).find((x: any) => x.id === copyId);
  check("the copy carries the default's steps and belongs to the tenant",
    copied?.is_system === false && copied?.steps?.length === induction.steps.length
    && copied.steps[0].name === induction.steps[0].name, copied?.steps?.length);
  const editCopy = await call(`/procedures/${copyId}`, token, put({ isActive: false }));
  check("a tenant can change its own copy", editCopy.status === 200, editCopy.json);

  // ---------- 3. Assigning a procedure lays the flow under the task ----------

  const task = await call("/office-tasks", token, post({
    employeeId, title: TASK_A, priority: "normal", dueDate: iso(3), procedureId: std.id
  }));
  check("assign: the task is created on the procedure", task.status === 201, task.json);
  const taskId: string = task.json?.id ?? "";

  let flow = (await call(`/office-tasks/${taskId}/flow`, token)).json;
  check("the flow is a copy of the procedure, not a pointer into it",
    flow?.procedureId === std.id && flow.stepsTotal === 5 && flow.checksTotal === 11
    && flow.currentSeq === 1, { steps: flow?.stepsTotal, checks: flow?.checksTotal,
      current: flow?.currentSeq });
  check("every copied step starts not_started with its checklist unticked",
    flow.steps.every((s: any) => s.status === "not_started")
    && flow.steps.every((s: any) => s.checks.every((c: any) => !c.ticked_at)), flow.steps?.[0]);
  check("the flow indicator names where the work stands",
    flow.steps[0].name === "Initiation" && flow.steps[4].is_final === true, flow.steps?.[4]);

  // A library edit after assignment must not reach the task already running it.
  const authored2 = await call("/procedures", token, post({
    name: "SMOKE late edit", scope: "office",
    steps: [{ seq: 1, name: "Only step", checklist: ["One"], isFinal: true }]
  }));
  const lateId: string = authored2.json?.id ?? "";
  await call(`/procedures/${lateId}`, token, put({
    steps: [{ seq: 1, name: "Rewritten step", checklist: ["One", "Two"], isFinal: true }]
  }));
  flow = (await call(`/office-tasks/${taskId}/flow`, token)).json;
  check("a later library edit cannot rewrite a flow already in motion",
    flow.stepsTotal === 5 && flow.checksTotal === 11, { steps: flow?.stepsTotal, checks: flow?.checksTotal });

  const plainTask = await call("/office-tasks", token, post({
    employeeId, title: TASK_B, priority: "low"
  }));
  const plainId: string = plainTask.json?.id ?? "";
  const plainFlow = await call(`/office-tasks/${plainId}/flow`, token);
  check("a task without a procedure has no flow invented for it",
    plainFlow.status === 200 && plainFlow.json?.stepsTotal === 0
    && plainFlow.json?.currentSeq === null, plainFlow.json);

  // ---------- 4. The gates belong to the database ----------

  const step1 = flow.steps[0];
  const closeWithOpenChecklist = await call(`/task-steps/${step1.id}`, token, put({ status: "done" }));
  check("a step will not close while its checklist is open",
    gate(closeWithOpenChecklist) && /unchecked item/i.test(String(closeWithOpenChecklist.json?.message)),
    closeWithOpenChecklist.json);

  const skipAhead = await call(`/task-steps/${flow.steps[2].id}`, token, put({ status: "done" }));
  check("a later step will not close before an earlier one",
    gate(skipAhead) && /earlier step/i.test(String(skipAhead.json?.message)), skipAhead.json);

  const closeTheTask = await call(`/office-tasks/${taskId}`, token, put({ status: "done" }));
  check("the task will not close before the flow reaches its end",
    gate(closeTheTask) && /open procedural step/i.test(String(closeTheTask.json?.message))
    && /Final Sign-off closes the flow/i.test(String(closeTheTask.json?.message)), closeTheTask.json);

  const blockedSilently = await call(`/task-steps/${step1.id}`, token, put({ status: "blocked" }));
  check("a blocked step must say what is holding it",
    blockedSilently.status === 400 && /blocked step must say/i.test(String(blockedSilently.json?.message)),
    blockedSilently.json);
  const blocked = await call(`/task-steps/${step1.id}`, token,
    put({ status: "blocked", blockedReason: "Waiting for the client's instruction." }));
  const blockedRead = (await call(`/office-tasks/${taskId}/flow`, token)).json
    .steps.find((s: any) => s.seq === 1);
  check("a blocked step records the reason and stays open",
    blocked.status === 200 && blockedRead.status === "blocked"
    && /client/.test(String(blockedRead.blocked_reason)), blockedRead);

  // Walk the flow: tick everything, close every step in order.
  for (const step of flow.steps) {
    await call(`/task-steps/${step.id}`, token, put({ status: "in_progress" }));
    for (const item of step.checks) {
      const tick = await call(`/task-step-checks/${item.id}`, token,
        put({ ticked: true, evidence: `SMOKE ${item.label}` }));
      if (tick.status !== 200) check(`ticking ${item.label} on step ${step.seq}`, tick.status, tick.json);
    }
    const done = await call(`/task-steps/${step.id}`, token, put({ status: "done" }));
    if (done.status !== 200) check(`closing step ${step.seq}`, done.status, done.json);
  }
  flow = (await call(`/office-tasks/${taskId}/flow`, token)).json;
  check("every step closed once its checklist was satisfied",
    flow.stepsDone === 5 && flow.checksOpen === 0 && flow.currentSeq === null,
    { done: flow?.stepsDone, open: flow?.checksOpen, current: flow?.currentSeq });
  check("a closed step carries the stamp and the hand that closed it",
    flow.steps.every((s: any) => !!s.completed_at && s.status === "done"), flow.steps?.[0]);
  check("ticks are evidence: who, and when, on every mandatory item",
    flow.steps.every((s: any) => s.checks.every((c: any) => !!c.ticked_at && !!c.ticked_by)),
    flow.steps?.[0]?.checks?.[0]);

  const untickAClosedStep = await call(`/task-step-checks/${flow.steps[0].checks[0].id}`, token,
    put({ ticked: false }));
  check("a closed step's ticks cannot be pulled from underneath it",
    gate(untickAClosedStep) && /reopen it/i.test(String(untickAClosedStep.json?.message)),
    untickAClosedStep.json);

  const taskDone = await call(`/office-tasks/${taskId}`, token, put({ status: "done" }));
  check("the task closes once Final Sign-off is reached", taskDone.status === 200, taskDone.json);
  const reopened = await call(`/office-tasks/${taskId}`, token, put({ status: "in_progress" }));
  const reopenedFlow = (await call(`/office-tasks/${taskId}/flow`, token)).json;
  check("reopening the task does not reopen its closed steps",
    reopened.status === 200 && reopenedFlow.stepsDone === 5, reopenedFlow?.stepsDone);
  await call(`/office-tasks/${taskId}`, token, put({ status: "done" }));

  const listWithFlow = await call("/office-tasks", token);
  const listedTask = (listWithFlow.json ?? []).find((x: any) => x.id === taskId);
  check("the task list shows where each flow stands",
    !!listedTask && listedTask.procedure_name === "Standard administrative task"
    && Number(listedTask.steps_total) === 5 && Number(listedTask.current_step ?? 0) === 0, listedTask);

  check("attaching a procedure after the fact lays the same copy",
    (await call(`/office-tasks/${plainId}/flow`, token,
      post({ procedureId: std.id })).then((r) => r.status)) === 201);

  // ---------- 5. The signed completion report ----------

  await call("/evaluations", token, post({
    employeeId, period: "2026-09", taskCompletion: 4, punctuality: 3,
    clientSatisfaction: 5, collaboration: 4, notes: "SMOKE mid-term review"
  }));

  const report = await call("/trainee-reports/generate", token, post({ employeeId }));
  check("generate: the report opens as a draft from the record",
    report.status === 201, report.json);
  const reportId: string = report.json?.id ?? "";

  const early = (await call(`/trainee-reports/${reportId}`, token)).json?.report ?? {};
  check("the draft already knows the period the register holds",
    early.period_start === REPORT_START && early.period_end === REPORT_END
    && early.status === "draft" && early.full_name === EMPLOYEE, early);
  check("tasks are counted from the record, not typed",
    Number(early.tasks_total) >= 2 && Number(early.tasks_done) >= 1, early);
  check("grades average the evaluation record inside the period",
    Number(early.grade_task_completion) === 4 && Number(early.grade_punctuality) === 3
    && Number(early.grade_client_satisfaction) === 5 && Number(early.grade_collaboration) === 4, early);
  check("the overview lists what was actually done",
    /SMOKE trainee flow task/.test(String(early.task_overview)), early.task_overview);

  const closeTooEarly = await call(`/trainee-reports/${reportId}/close`, token, post({}));
  check("a report cannot close with no sign-offs on it",
    gate(closeTooEarly) && /all three sign-offs/i.test(String(closeTooEarly.json?.message))
    && /HOD, HR Manager and Direct Supervisor/i.test(String(closeTooEarly.json?.message)),
    closeTooEarly.json);

  const hod = await call(`/trainee-reports/${reportId}/signoffs`, token,
    post({ role: "hod", signatoryName: "SMOKE HOD Mkinga", signatoryTitle: "Head of Operations" }));
  check("sign-off block 1: the Head of Department signs", hod.status === 201, hod.json);
  const stillShort = await call(`/trainee-reports/${reportId}/close`, token, post({}));
  check("two signatures short is still not a signed report",
    gate(stillShort) && /1 present/i.test(String(stillShort.json?.message)), stillShort.json);

  const hr = await call(`/trainee-reports/${reportId}/signoffs`, token,
    post({ role: "hr_manager", signatoryName: "SMOKE HR Mwinyi" }));
  const sup = await call(`/trainee-reports/${reportId}/signoffs`, token,
    post({ role: "direct_supervisor", signatoryName: "SMOKE Supervisor Kassim" }));
  check("sign-off blocks 2 and 3: HR Manager and Direct Supervisor sign",
    hr.status === 201 && sup.status === 201, { hr: hr.json, sup: sup.json });

  const dupeRole = await call(`/trainee-reports/${reportId}/signoffs`, token,
    post({ role: "hod", signatoryName: "SMOKE HOD again" }));
  check("one signature per role on a report",
    dupeRole.status === 409 || dupeRole.status === 400, dupeRole.json);

  const closeNoRemarks = await call(`/trainee-reports/${reportId}/close`, token, post({}));
  check("the supervisor's remarks are required before signature closes the paper",
    gate(closeNoRemarks) && /remarks/i.test(String(closeNoRemarks.json?.message)), closeNoRemarks.json);

  const written = await call(`/trainee-reports/${reportId}`, token, put({
    supervisorRemarks: "SMOKE Amina worked the clearing file end to end and signed her own declarations.",
    attendanceNote: "Present on 58 of 60 working days.",
    taskCompletion: 4, punctuality: 3, clientSatisfaction: 5, collaboration: 4
  }));
  check("remarks, attendance and grades are written before signing off",
    written.status === 200, written.json);

  const closed = await call(`/trainee-reports/${reportId}/close`, token, post({}));
  check("all three sign-offs plus remarks close the report", closed.status === 200, closed.json);

  const signed = (await call(`/trainee-reports/${reportId}`, token)).json ?? {};
  const done0 = signed.report ?? {};
  check("the closed report reads as one signed page",
    done0.status === "complete" && !!done0.completed_at && done0.signoffs?.length === 3,
    { status: done0.status, at: done0.completed_at, n: done0.signoffs?.length });
  check("the sign-off block is ordered HOD, HR Manager, Direct Supervisor",
    done0.signoffs?.[0]?.role === "hod" && done0.signoffs?.[1]?.role === "hr_manager"
    && done0.signoffs?.[2]?.role === "direct_supervisor"
    && done0.signoffs.every((s: any) => !!s.signedAt && !!s.signatoryName), done0.signoffs);
  check("the report carries the letterhead it will print with",
    !!signed.letterhead, signed.letterhead);
  const register = await call(`/trainee-reports?employeeId=${employeeId}`, token);
  const onRegister = (register.json ?? []).find((x: any) => x.id === reportId);
  check("the register counts the signatures and rates the trainee",
    Number(onRegister?.signed_count) === 3 && onRegister?.status === "complete", onRegister);

  const immovable = await call(`/trainee-report-signoffs/${hod.json.id}`, token, { method: "DELETE" });
  check("a signature is immutable once the report is signed off",
    gate(immovable) && /immutable once the report is signed off/i.test(String(immovable.json?.message)),
    immovable.json);
  const rewrite = await call(`/trainee-reports/${reportId}`, token, put({ supervisorRemarks: "SMOKE rewritten" }));
  check("a signed report is not a draft again without reopening",
    gate(rewrite) && /immutable once the report is signed off/i.test(String(rewrite.json?.message)),
    rewrite.json);
  const dropReport = await call(`/trainee-reports/${reportId}`, token, { method: "DELETE" });
  check("a signed report cannot be deleted",
    dropReport.status === 409 && /Nothing was removed/i.test(String(dropReport.json?.message)),
    dropReport.json);

  const reopenedReport = await call(`/trainee-reports/${reportId}/reopen`, token, post({}));
  check("reopen is the only way back to a draft, and it is for a signature correction",
    reopenedReport.status === 200, reopenedReport.json);
  const whileOpen = await call(`/trainee-report-signoffs/${hod.json.id}`, token, { method: "DELETE" });
  check("a reopened report lets a mis-signed block be pulled again",
    whileOpen.status === 200, whileOpen.json);
  const replaceSign = await call(`/trainee-reports/${reportId}/signoffs`, token,
    post({ role: "hod", signatoryName: "SMOKE HOD Mrema", signatoryTitle: "Head of Operations" }));
  check("the corrected signature is registered", replaceSign.status === 201, replaceSign.json);
  const reClosed = await call(`/trainee-reports/${reportId}/close`, token, post({}));
  check("and the reopened report closes again on three signatures", reClosed.status === 200, reClosed.json);

  const earlyPaper = await call("/trainee-reports/generate", token, post({
    employeeId, periodStart: REPORT_START, periodEnd: iso(30)
  }));
  check("a draft may be opened for a period still running", earlyPaper.status === 201, earlyPaper.json);
  const cannotClose = await call(`/trainee-reports/${earlyPaper.json?.id}/close`, token, post({}));
  check("a period that has not ended yet cannot be signed off",
    gate(cannotClose) && /period is still open/i.test(String(cannotClose.json?.message)),
    cannotClose.json);

  // ---------- 6. Who is allowed any of it ----------

  const anon = await call("/procedures", null);
  check("the library is not public", anon.status === 401, anon.json);

  const traineeUserId = randomUUID();
  const role = await owner.query("select id from roles where key = 'trainee'");
  if (role.rowCount) {
    await owner.query(`insert into users (id, tenant_id, user_type, full_name, status)
      values ($1,$2,'trainee','SMOKE Trainee Reader','active')`, [traineeUserId, tid]);
    await owner.query("insert into user_roles (user_id, role_id) values ($1,$2)",
      [traineeUserId, role.rows[0].id]);
    const traineeToken = await mint(traineeUserId, tid, ["trainee"]);

    const sees = await call(`/office-tasks/${taskId}/flow`, traineeToken);
    check("a trainee may read the flow they are working through", sees.status === 200, sees.json);
    const seesReport = await call(`/trainee-reports/${reportId}`, traineeToken);
    check("a trainee may read their own completion report", seesReport.status === 200, seesReport.json);
    const ticks = await call(`/task-step-checks/${flow.steps[0].checks[1].id}`, traineeToken,
      put({ ticked: true }));
    check("a trainee cannot tick someone else's checklist", ticks.status === 403, ticks.json);
    const authors = await call("/trainee-reports/generate", traineeToken, post({ employeeId }));
    check("a trainee cannot author a completion report", authors.status === 403, authors.json);
    const signs = await call(`/trainee-reports/${reportId}/signoffs`, traineeToken,
      post({ role: "hod", signatoryName: "SMOKE Self" }));
    check("a trainee cannot sign off their own report", signs.status === 403, signs.json);
    const writes = await call("/procedures", traineeToken, post({
      name: "SMOKE trainee procedure", scope: "office",
      steps: [{ seq: 1, name: "Step", isFinal: true }]
    }));
    check("a trainee cannot author a procedure", writes.status === 403, writes.json);
  } else {
    check("the trainee role exists to be tested against", false, "no seeded trainee role");
  }

  // A second tenant: the library's defaults are theirs too, the smoke tenant's
  // own rows are not.
  const other = await owner.query(
    `select u.id as user_id, u.tenant_id from users u
     where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
       and u.tenant_id <> $1 and u.id <> $2
     order by u.created_at limit 1`, [tid, uid]);
  if (other.rowCount) {
    const otherToken = await mint(other.rows[0].user_id, other.rows[0].tenant_id);
    const theirLib = await call("/procedures", otherToken);
    const names = (theirLib.json ?? []).map((x: any) => x.name);
    check("cross-tenant: the shipped defaults are shared, the house copy is not",
      names.includes("Standard administrative task") && !names.includes(PROCEDURE), names);
    const theirSheet = await call(`/employees/${employeeId}`, otherToken);
    check("cross-tenant: another house's trainee is not on the sheet",
      theirSheet.status === 404, theirSheet.json);
    const theirFlow = await call(`/office-tasks/${taskId}/flow`, otherToken);
    check("cross-tenant: another house's task flow is unreadable",
      theirFlow.status === 404, theirFlow.json);
    const theirReport = await call(`/trainee-reports/${reportId}`, otherToken);
    check("cross-tenant: another house's completion report is not on the printer",
      theirReport.status === 404, theirReport.json);
    const theirEdit = await call(`/procedures/${ownId}`, otherToken, put({ name: "SMOKE stolen" }));
    check("cross-tenant: another house cannot edit the copy",
      theirEdit.status === 404 || theirEdit.status === 403, theirEdit.json);
  } else {
    console.log("note   no second tenant found — cross-tenant checks skipped");
  }

  // ---------- teardown ----------

  await owner.query("delete from user_roles where user_id = $1", [traineeUserId]);
  await owner.query("delete from users where id = $1 and tenant_id = $2", [traineeUserId, tid]);
  await wipe(owner, tid);
  const residue = await owner.query(
    `select (select count(*) from employees where tenant_id = $1 and full_name like 'SMOKE %')
          + (select count(*) from office_tasks where tenant_id = $1 and title like 'SMOKE %')
          + (select count(*) from task_procedures where tenant_id = $1 and name like 'SMOKE %')
          + (select count(*) from trainee_reports where tenant_id = $1
              and employee_id in (select id from employees where full_name like 'SMOKE %'))
          + (select count(*) from office_task_steps where tenant_id = $1
              and office_task_id in (select id from office_tasks where title like 'SMOKE %'))
          + (select count(*) from users where id = $2) as n`, [tid, traineeUserId]);
  check("teardown leaves no rows behind", Number(residue.rows[0].n) === 0, residue.rows[0]);

  await owner.end();
  console.log(failures ? `\n${failures} FAILED` : "\nall trainee and flow checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
