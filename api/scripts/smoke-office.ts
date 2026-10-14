/**
 * End-to-end smoke test for Office/Employees against a running API (port 4000).
 * Forges access tokens exactly like the other module smoke tests: real director
 * for the flow, random user for the 403 gate, fake tenant for scoping.
 * Cleans up everything it creates (office_tasks are hard-deleted — the table
 * keeps no history for tenants; employees/evaluations soft-delete).
 *
 * Run: npx tsx scripts/smoke-office.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const SMOKE_SUP = "Kilian Smoke Supervisor";
const SMOKE_EMP = "Kilian Smoke Intern";
const SMOKE_FILE = "9SMOKE-003-2026";

async function mint(sub: string, tid: string, roles: string[] = ["director"]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000aa", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("15m").sign(key);
}

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : init.body ? { "Content-Type": "application/json" } : {}),
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

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const DAY = 24 * 3600 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = iso(new Date());
const soon = iso(new Date(Date.now() + 12 * DAY));
const past = iso(new Date(Date.now() - DAY));
const hired = iso(new Date(Date.now() - 200 * DAY));
const thisMonth = today.slice(0, 7);

async function main() {
  const owner = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await owner.connect();

  const who = await owner.query(
    `select u.id as user_id, u.tenant_id, u.full_name from users u
     where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
     order by (select count(*) from cargo_shipments s where s.tenant_id = u.tenant_id and s.deleted_at is null) desc,
              u.created_at limit 1`);
  if (!who.rowCount) throw new Error("No active director found");
  const { user_id, tenant_id, full_name } = who.rows[0];
  console.log(`probe tenant ${tenant_id} as "${full_name}"`);

  await owner.query(
    `update cargo_shipments set deleted_at = now()
     where tenant_id = $1 and file_number = $2 and deleted_at is null`, [tenant_id, SMOKE_FILE]);
  const file = await owner.query(
    `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
       container_type, consignee_name, consignor_name, status, created_by)
     values (gen_random_uuid(), $1, $2, 9102, date_part('year', now())::int, 'import',
       '40ft', 'Smoke Office Consignee', 'Smoke Office Consignor', 'open', $3)
     returning id`, [tenant_id, SMOKE_FILE, user_id]);
  const fileId: string = file.rows[0].id;

  const token = await mint(user_id, tenant_id);
  const bogusUserToken = await mint("99999999-9999-7999-8999-999999999999", tenant_id, ["staff"]);
  const fakeTenantToken = await mint(user_id, "00000000-0000-7000-8000-000000000000");

  const taskIds: string[] = [];
  let supId: string | null = null;
  let empId: string | null = null;
  let evalId: string | null = null;
  let docId: string | null = null;

  const empRow = async (id: string) => {
    const res = await call("/employees", token);
    return (res.json ?? []).find((e: any) => e.id === id);
  };

  try {
    // ---- gates ----
    const noAuth = await call("/employees", null);
    check("employees without auth → 401", noAuth.status === 401, noAuth.status);

    const noPerm = await call("/employees", bogusUserToken);
    check("employees with no granted role → 403", noPerm.status === 403, noPerm.status);

    const noPermTasks = await call("/office-tasks", bogusUserToken);
    check("office-tasks with no granted role → 403", noPermTasks.status === 403, noPermTasks.status);

    const noPermEval = await call("/evaluations", bogusUserToken);
    check("evaluations with no granted role → 403", noPermEval.status === 403, noPermEval.status);

    const fakeTenant = await call("/employees", fakeTenantToken);
    check("foreign tenant → no data (403, or empty view)",
      fakeTenant.status === 403 || (fakeTenant.status === 200 && (fakeTenant.json ?? []).length === 0),
      { status: fakeTenant.status, rows: fakeTenant.json?.length });

    // ---- roster ----
    const sup = await call("/employees", token, {
      method: "POST",
      body: JSON.stringify({ fullName: SMOKE_SUP, jobTitle: "Operations Lead", department: "Operations", hiredDate: hired })
    });
    check("create supervisor → 201", sup.status === 201, sup.status + " " + JSON.stringify(sup.json));
    supId = sup.json?.id ?? null;

    const emp = await call("/employees", token, {
      method: "POST",
      body: JSON.stringify({
        fullName: SMOKE_EMP, phone: "+255754111888", jobTitle: "Intern", department: "Operations",
        skills: ["dispatch", "filing"], employmentType: "intern", hiredDate: hired,
        contractStart: today, contractEnd: soon, supervisorId: supId, monthlySalary: 450000
      })
    });
    check("create intern → 201", emp.status === 201, emp.status + " " + JSON.stringify(emp.json));
    empId = emp.json?.id ?? null;

    const e1 = await empRow(empId!);
    check("intern listed with type/status/absorbed",
      e1?.employment_type === "intern" && e1?.status === "active" && e1?.intern_absorbed === false, e1 && {
        t: e1.employment_type, s: e1.status, a: e1.intern_absorbed
      });
    check("contract dates are plain YYYY-MM-DD",
      e1?.contract_start === today && e1?.contract_end === soon && e1?.hired_date === hired,
      { start: e1?.contract_start, end: e1?.contract_end, hired: e1?.hired_date });
    check("contract countdown computed", e1?.contract_days >= 11 && e1?.contract_days <= 12, e1?.contract_days);
    check("supervisor joined by name", e1?.supervisor_id === supId && e1?.supervisor_name === SMOKE_SUP, e1?.supervisor_name);
    check("skills and salary round-trip",
      JSON.stringify(e1?.skills) === JSON.stringify(["dispatch", "filing"]) && e1?.monthly_salary === 450000,
      { skills: e1?.skills, salary: e1?.monthly_salary });
    check("phone stored but never raw in list", e1?.has_phone === true &&
      !("phone" in e1) && !("phone_encrypted" in e1) && !("phone_search" in e1), Object.keys(e1 ?? {}).length);
    check("rating empty before evaluations",
      e1?.rating === null && e1?.rating_period === null && e1?.evaluation_count === 0);
    check("task counters start at zero",
      e1?.open_tasks === 0 && e1?.overdue_tasks === 0 && e1?.done_tasks === 0 && e1?.late_tasks === 0);

    // ---- validation ----
    const badName = await call("/employees", token, { method: "POST", body: JSON.stringify({ fullName: "x" }) });
    check("short fullName → 400", badName.status === 400, badName.status);
    const badPhone = await call("/employees", token, {
      method: "POST", body: JSON.stringify({ fullName: "Smoke Bad Phone", phone: "0712345678" })
    });
    check("local-format phone → 400", badPhone.status === 400, badPhone.status);
    const ghostSup = await call("/employees", token, {
      method: "POST", body: JSON.stringify({ fullName: "Smoke Ghost Sup", supervisorId: crypto.randomUUID() })
    });
    check("unknown supervisor → 400", ghostSup.status === 400, ghostSup.status);
    const selfSup = await call(`/employees/${supId}`, token, {
      method: "PUT", body: JSON.stringify({ supervisorId: supId })
    });
    check("self-supervision → 400", selfSup.status === 400, selfSup.status);
    const foreignEdit = await call(`/employees/${empId}`, fakeTenantToken, {
      method: "PUT", body: JSON.stringify({ department: "X" })
    });
    check("foreign tenant cannot edit employee → 404", foreignEdit.status === 404, foreignEdit.status);

    // ---- presence-based phone semantics ----
    const keepPhone = await call(`/employees/${empId}`, token, {
      method: "PUT", body: JSON.stringify({ department: "Dispatch" })
    });
    check("PUT without phone → 200", keepPhone.status === 200, keepPhone.status);
    const e2 = await empRow(empId!);
    check("blank phone keeps stored value", e2?.has_phone === true && e2?.department === "Dispatch", e2?.has_phone);
    const clearPhone = await call(`/employees/${empId}`, token, {
      method: "PUT", body: JSON.stringify({ phone: null })
    });
    check("explicit null clears phone", clearPhone.status === 200 && (await empRow(empId!))?.has_phone === false);
    const rePhone = await call(`/employees/${empId}`, token, {
      method: "PUT", body: JSON.stringify({ phone: "+255754111999" })
    });
    check("new phone stored", rePhone.status === 200 && (await empRow(empId!))?.has_phone === true);

    // ---- tasks ----
    const tA = await call("/office-tasks", token, {
      method: "POST",
      body: JSON.stringify({ employeeId: empId, title: "Smoke A chase TRA returns", priority: "high", dueDate: soon })
    });
    check("create task A (future due) → 201", tA.status === 201, tA.status + " " + JSON.stringify(tA.json));
    taskIds.push(tA.json?.id);

    const tB = await call("/office-tasks", token, {
      method: "POST",
      body: JSON.stringify({ employeeId: empId, title: "Smoke B reconcile fuel sheet", dueDate: past })
    });
    check("create task B (past due) → 201", tB.status === 201, tB.status);
    taskIds.push(tB.json?.id);

    const tC = await call("/office-tasks", token, {
      method: "POST",
      body: JSON.stringify({
        employeeId: empId, shipmentId: fileId, title: "Smoke C collect release order",
        priority: "urgent", dueDate: today
      })
    });
    check("create task C (due today, file-linked) → 201", tC.status === 201, tC.status);
    taskIds.push(tC.json?.id);

    const tD = await call("/office-tasks", token, {
      method: "POST",
      body: JSON.stringify({ employeeId: empId, title: "Smoke D overdue follow-up", priority: "low", dueDate: past })
    });
    check("create task D (overdue) → 201", tD.status === 201, tD.status);
    taskIds.push(tD.json?.id);

    const badTask = await call("/office-tasks", token, {
      method: "POST", body: JSON.stringify({ employeeId: crypto.randomUUID(), title: "Smoke ghost" })
    });
    check("unknown employee on task → 400", badTask.status === 400, badTask.status);
    const badShip = await call("/office-tasks", token, {
      method: "POST", body: JSON.stringify({ employeeId: empId, shipmentId: crypto.randomUUID(), title: "Smoke ghost ship" })
    });
    check("unknown cargo file on task → 400", badShip.status === 400, badShip.status);

    const list1 = await call(`/office-tasks?employeeId=${empId}`, token);
    const rows1 = list1.json ?? [];
    check("four tasks listed for the employee", rows1.length === 4, rows1.length);
    const rowA = rows1.find((t: any) => t.id === tA.json?.id);
    const rowC = rows1.find((t: any) => t.id === tC.json?.id);
    const rowD = rows1.find((t: any) => t.id === tD.json?.id);
    check("task C shows its cargo file", rowC?.file_number === SMOKE_FILE, rowC?.file_number);
    check("due dates in plain days",
      rowC?.due_date === today && rowC?.days === 0 && rowA?.days >= 11 && rowA?.days <= 12 && rowD?.days === -1,
      { c: rowC?.days, a: rowA?.days, d: rowD?.days });
    check("open tasks sort urgent → high → normal → low",
      rows1[0]?.id === tC.json?.id && rows1[1]?.id === tA.json?.id &&
      rows1[2]?.id === tB.json?.id && rows1[3]?.id === tD.json?.id,
      rows1.map((t: any) => t.priority));

    const e3 = await empRow(empId!);
    check("counters: 4 open, 2 overdue",
      e3?.open_tasks === 4 && e3?.overdue_tasks === 2 && e3?.done_tasks === 0 && e3?.late_tasks === 0,
      { open: e3?.open_tasks, over: e3?.overdue_tasks });

    const doneA = await call(`/office-tasks/${tA.json?.id}`, token, {
      method: "PUT", body: JSON.stringify({ status: "done" })
    });
    check("complete A → 200", doneA.status === 200, doneA.status);
    const list2 = await call(`/office-tasks?employeeId=${empId}`, token);
    const rowA2 = (list2.json ?? []).find((t: any) => t.id === tA.json?.id);
    check("A done on time (due in future)", rowA2?.status === "done" && !!rowA2?.done_at && rowA2?.on_time === true,
      { s: rowA2?.status, ot: rowA2?.on_time, at: !!rowA2?.done_at });

    const doneB = await call(`/office-tasks/${tB.json?.id}`, token, {
      method: "PUT", body: JSON.stringify({ status: "done" })
    });
    check("complete B → 200", doneB.status === 200, doneB.status);
    const list3 = await call(`/office-tasks?employeeId=${empId}`, token);
    const rowB3 = (list3.json ?? []).find((t: any) => t.id === tB.json?.id);
    check("B done late (due passed)", rowB3?.on_time === false, rowB3?.on_time);

    const reopenB = await call(`/office-tasks/${tB.json?.id}`, token, {
      method: "PUT", body: JSON.stringify({ status: "pending" })
    });
    check("reopen B → 200", reopenB.status === 200, reopenB.status);
    const list4 = await call(`/office-tasks?employeeId=${empId}`, token);
    const rowB4 = (list4.json ?? []).find((t: any) => t.id === tB.json?.id);
    check("reopen clears done_at/on_time", rowB4?.done_at === null && rowB4?.on_time === null,
      { at: rowB4?.done_at, ot: rowB4?.on_time });

    const doneB2 = await call(`/office-tasks/${tB.json?.id}`, token, {
      method: "PUT", body: JSON.stringify({ status: "done" })
    });
    check("re-complete B late again", doneB2.status === 200 &&
      (await call(`/office-tasks?employeeId=${empId}`, token)).json?.find((t: any) => t.id === tB.json?.id)?.on_time === false);

    const editC = await call(`/office-tasks/${tC.json?.id}`, token, {
      method: "PUT", body: JSON.stringify({ title: "Smoke C collect release order now", priority: "high" })
    });
    check("edit C details → 200", editC.status === 200, editC.status);
    const list5 = await call(`/office-tasks?employeeId=${empId}`, token);
    const rowC5 = (list5.json ?? []).find((t: any) => t.id === tC.json?.id);
    check("C keeps its due date after edit",
      rowC5?.title === "Smoke C collect release order now" && rowC5?.due_date === today && rowC5?.days === 0,
      { t: rowC5?.title, d: rowC5?.due_date });

    const e4 = await empRow(empId!);
    check("counters after lifecycle: 2 open, 1 overdue, 2 done, 1 late",
      e4?.open_tasks === 2 && e4?.overdue_tasks === 1 && e4?.done_tasks === 2 && e4?.late_tasks === 1,
      { open: e4?.open_tasks, over: e4?.overdue_tasks, done: e4?.done_tasks, late: e4?.late_tasks });

    const finalOrder = await call(`/office-tasks?employeeId=${empId}`, token);
    check("open group leads, then done by priority",
      finalOrder.json?.[0]?.id === tC.json?.id && finalOrder.json?.[1]?.id === tD.json?.id &&
      finalOrder.json?.[2]?.id === tA.json?.id && finalOrder.json?.[3]?.id === tB.json?.id,
      finalOrder.json?.map((t: any) => `${t.status}:${t.priority}`));

    const foreignTask = await call(`/office-tasks/${tD.json?.id}`, fakeTenantToken, {
      method: "PUT", body: JSON.stringify({ status: "done" })
    });
    check("foreign tenant cannot edit task → 404", foreignTask.status === 404, foreignTask.status);
    const foreignTaskDel = await call(`/office-tasks/${tD.json?.id}`, fakeTenantToken, { method: "DELETE" });
    check("foreign tenant cannot delete task → 404", foreignTaskDel.status === 404, foreignTaskDel.status);

    // ---- evaluations ----
    const ev = await call("/evaluations", token, {
      method: "POST",
      body: JSON.stringify({
        employeeId: empId, period: thisMonth,
        taskCompletion: 4, punctuality: 5, clientSatisfaction: 4, collaboration: 5
      })
    });
    check("create evaluation → 201", ev.status === 201, ev.status + " " + JSON.stringify(ev.json));
    evalId = ev.json?.id ?? null;

    const evDup = await call("/evaluations", token, {
      method: "POST",
      body: JSON.stringify({
        employeeId: empId, period: thisMonth,
        taskCompletion: 3, punctuality: 3, clientSatisfaction: 3, collaboration: 3
      })
    });
    check("duplicate month → 409 CONFLICT", evDup.status === 409 && evDup.json?.error?.code === "CONFLICT",
      { status: evDup.status, code: evDup.json?.error?.code });

    const evList = await call(`/evaluations?employeeId=${empId}`, token);
    const evRow = (evList.json ?? []).find((x: any) => x.id === evalId);
    check("evaluation listed with average and evaluator",
      evRow?.average === 4.5 && evRow?.period === `${thisMonth}-01` &&
      evRow?.employee_name === SMOKE_EMP && evRow?.evaluated_by_name === full_name,
      { avg: evRow?.average, period: evRow?.period, by: evRow?.evaluated_by_name });

    const e5 = await empRow(empId!);
    check("roster shows latest rating", e5?.rating === 4.5 && e5?.rating_period === `${thisMonth}-01` && e5?.evaluation_count === 1,
      { r: e5?.rating, p: e5?.rating_period });

    const evUpd = await call(`/evaluations/${evalId}`, token, {
      method: "PUT",
      body: JSON.stringify({ taskCompletion: 3, punctuality: 3, clientSatisfaction: 3, collaboration: 3 })
    });
    check("edit evaluation → 200", evUpd.status === 200, evUpd.status);
    check("roster follows edited scores", (await empRow(empId!))?.rating === 3);

    const foreignEval = await call(`/evaluations/${evalId}`, fakeTenantToken, {
      method: "PUT", body: JSON.stringify({ taskCompletion: 1 })
    });
    check("foreign tenant cannot edit evaluation → 404", foreignEval.status === 404, foreignEval.status);

    const evDel = await call(`/evaluations/${evalId}`, token, { method: "DELETE" });
    check("delete evaluation → 200", evDel.status === 200, evDel.status);
    const e6 = await empRow(empId!);
    check("rating cleared with the evaluation", e6?.rating === null && e6?.evaluation_count === 0,
      { r: e6?.rating, n: e6?.evaluation_count });

    // ---- notifications ----
    const notif = await call("/notifications", token);
    const items = notif.json?.items ?? [];
    const contractNotif = items.find((i: any) => i.type === "contract_expiring" && i.title.includes(SMOKE_EMP));
    check("notification: internship expiring soon",
      !!contractNotif && contractNotif.href === "/app/office/employees" && contractNotif.title.includes("internship ends in"),
      contractNotif);
    const dueNotif = items.find((i: any) => i.type === "task_deadline" && i.title.includes("Smoke C"));
    check("notification: task due today",
      !!dueNotif && dueNotif.title === "Task due today: Smoke C collect release order now" &&
      dueNotif.detail === `Assigned to ${SMOKE_EMP}` && dueNotif.severity === "warning", dueNotif);
    const overNotif = items.find((i: any) => i.type === "task_deadline" && i.title.includes("Smoke D"));
    check("notification: overdue task critical",
      !!overNotif && overNotif.title === "Task overdue: Smoke D overdue follow-up" && overNotif.severity === "critical",
      overNotif);

    // ---- calendar ----
    const evNow = await call(`/calendar/events?month=${today.slice(0, 7)}`, token);
    const taskEvent = (evNow.json?.events ?? []).find((e: any) =>
      e.type === "task_due" && e.label === "Task due: Smoke C collect release order now");
    check("calendar: task due today", !!taskEvent && taskEvent.date === today &&
      taskEvent.href === "/app/office/employees" && taskEvent.detail === `Assigned to ${SMOKE_EMP}`, taskEvent);

    const soonMonth = soon.slice(0, 7);
    const evSoon = await call(`/calendar/events?month=${soonMonth}`, token);
    const contractEvent = (evSoon.json?.events ?? []).find((e: any) =>
      e.type === "doc_expiry" && e.label === `${SMOKE_EMP} contract ends`);
    check("calendar: internship ends on its date", !!contractEvent && contractEvent.date === soon &&
      contractEvent.detail === "Internship ends — absorb or close", contractEvent);

    // ---- absorb the intern ----
    const absorb = await call(`/employees/${empId}`, token, {
      method: "PUT", body: JSON.stringify({ employmentType: "permanent", absorbed: true })
    });
    check("absorb intern → 200", absorb.status === 200, absorb.status);
    const e7 = await empRow(empId!);
    check("absorbed → permanent + flag", e7?.employment_type === "permanent" && e7?.intern_absorbed === true,
      { t: e7?.employment_type, a: e7?.intern_absorbed });

    // ---- contract scan rides the vault ----
    const fd = new FormData();
    fd.append("entityType", "employee");
    fd.append("entityId", empId!);
    fd.append("kind", "contract");
    fd.append("file", new Blob([PNG_1PX], { type: "image/png" }), "smoke-contract.png");
    const up = await call("/documents", token, { method: "POST", body: fd });
    check("contract scan upload → 201", up.status === 201, up.status + " " + JSON.stringify(up.json));
    docId = up.json?.id ?? null;

    const e8 = await empRow(empId!);
    check("roster shows its document", e8?.document_count === 1 && e8?.latest_document_id === docId,
      { n: e8?.document_count, id: e8?.latest_document_id });

    const docs = await call(`/documents?entityType=employee&entityId=${empId}`, token);
    check("documents list for the employee", (docs.json ?? []).length === 1 && docs.json[0].id === docId);

    const url = await call(`/documents/${docId}/url`, token);
    check("signed URL for the scan", url.status === 200 && typeof url.json?.url === "string", url.status);

    const vault = await call("/documents/vault?entityType=employee", token);
    const vaultRow = (vault.json ?? []).find((d: any) => d.id === docId);
    check("vault labels the employee row", vaultRow?.entity_label === SMOKE_EMP && vaultRow?.kind === "contract",
      vaultRow?.entity_label);

    // ---- delete cascades ----
    const foreignDel = await call(`/employees/${supId}`, fakeTenantToken, { method: "DELETE" });
    check("foreign tenant cannot delete employee → 404", foreignDel.status === 404, foreignDel.status);

    const delEmp = await call(`/employees/${empId}`, token, { method: "DELETE" });
    check("delete employee → 200", delEmp.status === 200, delEmp.status);
    const e9 = await empRow(empId!);
    check("deleted employee gone from roster", !e9);

    const after = await call(`/office-tasks?employeeId=${empId}`, token);
    const afterRows = after.json ?? [];
    const statusOf = (id: string) => afterRows.find((t: any) => t.id === id)?.status;
    check("open tasks cancelled with the employee",
      statusOf(tC.json?.id) === "cancelled" && statusOf(tD.json?.id) === "cancelled", afterRows.map((t: any) => t.status));
    check("completed task history kept",
      statusOf(tA.json?.id) === "done" && statusOf(tB.json?.id) === "done");

    const docLeft = await owner.query(
      "select count(*)::int as n from documents where id = $1 and deleted_at is null", [docId]);
    check("contract scan soft-deleted with the employee", docLeft.rows[0].n === 0, docLeft.rows[0].n);

    const delSup = await call(`/employees/${supId}`, token, { method: "DELETE" });
    check("delete supervisor → 200", delSup.status === 200, delSup.status);
  } finally {
    // Cleanup. API deletes exercise the real paths where still live; owner
    // sweeps handle rows already deleted above plus the hard delete of
    // office_tasks (the table keeps no deleted_at).
    if (docId) await call(`/documents/${docId}`, token, { method: "DELETE" }).catch(() => { });
    for (const id of taskIds) {
      if (id) await call(`/office-tasks/${id}`, token, { method: "DELETE" }).catch(() => { });
    }
    if (evalId) await call(`/evaluations/${evalId}`, token, { method: "DELETE" }).catch(() => { });
    if (empId) await call(`/employees/${empId}`, token, { method: "DELETE" }).catch(() => { });
    if (supId) await call(`/employees/${supId}`, token, { method: "DELETE" }).catch(() => { });

    await owner.query(
      `delete from office_tasks t using employees e
       where t.employee_id = e.id and e.tenant_id = $1 and e.full_name like 'Kilian Smoke%'`, [tenant_id]).catch(() => { });
    await owner.query(
      `update employee_evaluations ev set deleted_at = now() from employees e
       where ev.employee_id = e.id and e.tenant_id = $1 and e.full_name like 'Kilian Smoke%'
         and ev.deleted_at is null`, [tenant_id]).catch(() => { });
    await owner.query(
      `update documents d set deleted_at = now() from employees e
       where d.entity_type = 'employee' and d.entity_id = e.id and d.tenant_id = $1
         and e.full_name like 'Kilian Smoke%' and d.deleted_at is null`, [tenant_id]).catch(() => { });
    await owner.query(
      `update employees set deleted_at = now()
       where tenant_id = $1 and full_name like 'Kilian Smoke%' and deleted_at is null`, [tenant_id]).catch(() => { });
    await owner.query(
      `update cargo_shipments set deleted_at = now()
       where tenant_id = $1 and file_number = $2 and deleted_at is null`, [tenant_id, SMOKE_FILE]).catch(() => { });

    const left = await owner.query(
      `select
         (select count(*) from employees where tenant_id = $1 and full_name like 'Kilian Smoke%' and deleted_at is null)::int as employees,
         (select count(*) from office_tasks t join employees e on e.id = t.employee_id
           where t.tenant_id = $1 and e.full_name like 'Kilian Smoke%')::int as tasks,
         (select count(*) from employee_evaluations ev join employees e on e.id = ev.employee_id
           where ev.tenant_id = $1 and e.full_name like 'Kilian Smoke%' and ev.deleted_at is null)::int as evals,
         (select count(*) from cargo_shipments where tenant_id = $1 and file_number = $2 and deleted_at is null)::int as files`,
      [tenant_id, SMOKE_FILE]);
    const L = left.rows[0];
    console.log(`cleanup: employees=${L.employees} tasks=${L.tasks} evals=${L.evals} files=${L.files} remaining`);
    await owner.end();
  }

  console.log(failures ? `${failures} FAILED` : "all office smoke checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
