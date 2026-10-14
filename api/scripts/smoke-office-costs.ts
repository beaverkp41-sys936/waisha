/**
 * End-to-end smoke test for Office Management (costs) against a running API
 * (port 4000). Forges access tokens exactly like the other module smoke tests:
 * real director for the flow, random user for the 403 gate, fake tenant for
 * scoping. Cleans up everything it creates (costs/budgets soft-delete; the
 * probe cargo file and employee are swept by the owner connection).
 *
 * Run: npx tsx scripts/smoke-office-costs.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const SMOKE_EMP = "Kilian Smoke Costs Worker";
const SMOKE_FILE = "9SMOKE-004-2026";
const DESC_A = "Smoke Costs A office allowance";
const DESC_B = "Smoke Costs B team lunch";
const DESC_C = "Smoke Costs C file transport";

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

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = iso(new Date());
const month = today.slice(0, 7);
const pastMonth = iso(new Date(Date.now() - 60 * 86400000)).slice(0, 7);

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
  await owner.query(
    `update employees set deleted_at = now()
     where tenant_id = $1 and full_name = $2 and deleted_at is null`, [tenant_id, SMOKE_EMP]);
  const file = await owner.query(
    `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
       container_type, consignee_name, consignor_name, status,
       payment_amount, processing_cost, created_by)
     values (gen_random_uuid(), $1, $2, 9103, date_part('year', now())::int, 'import',
       '40ft', 'Smoke Costs Consignee', 'Smoke Costs Consignor', 'open',
       500000, 200000, $3)
     returning id`, [tenant_id, SMOKE_FILE, user_id]);
  const fileId: string = file.rows[0].id;

  const token = await mint(user_id, tenant_id);
  const bogusUserToken = await mint("99999999-9999-7999-8999-999999999999", tenant_id, ["staff"]);
  const fakeTenantToken = await mint(user_id, "00000000-0000-7000-8000-000000000000");

  let empId: string | null = null;
  const costIds: string[] = [];
  const budgetIds: string[] = [];
  let docId: string | null = null;

  const costRow = async (id: string) => {
    const res = await call(`/office-costs?month=${month}`, token);
    return (res.json ?? []).find((c: any) => c.id === id);
  };

  try {
    // ---- gates ----
    const noAuth = await call("/office-costs", null);
    check("costs without auth → 401", noAuth.status === 401, noAuth.status);

    const noPerm = await call("/office-costs", bogusUserToken);
    check("costs with no granted role → 403", noPerm.status === 403, noPerm.status);

    const noPermDecision = await call(`/office-costs/${crypto.randomUUID()}/decision`, bogusUserToken, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("decision with no granted role → 403", noPermDecision.status === 403, noPermDecision.status);

    const noPermBudget = await call("/office-budgets", bogusUserToken, {
      method: "POST", body: JSON.stringify({ period: month, category: "meals", amount: 1000 })
    });
    check("budget write with no granted role → 403", noPermBudget.status === 403, noPermBudget.status);

    const fakeTenantList = await call("/office-costs", fakeTenantToken);
    check("foreign tenant → no data (403, or empty view)",
      fakeTenantList.status === 403 || (fakeTenantList.status === 200 && (fakeTenantList.json ?? []).length === 0),
      { status: fakeTenantList.status, rows: fakeTenantList.json?.length });

    // ---- fixtures ----
    const emp = await call("/employees", token, {
      method: "POST", body: JSON.stringify({ fullName: SMOKE_EMP, jobTitle: "Dispatch clerk", department: "Operations" })
    });
    check("create smoke employee → 201", emp.status === 201, emp.status + " " + JSON.stringify(emp.json));
    empId = emp.json?.id ?? null;

    // ---- create entries ----
    const a = await call("/office-costs", token, {
      method: "POST",
      body: JSON.stringify({
        costDate: today, category: "allowance", description: DESC_A, amount: 120000,
        employeeId: empId, paymentMethod: "mobile_money"
      })
    });
    check("create allowance → 201", a.status === 201, a.status + " " + JSON.stringify(a.json));
    costIds.push(a.json?.id);

    const b = await call("/office-costs", token, {
      method: "POST",
      body: JSON.stringify({
        costDate: today, category: "meals", description: DESC_B, amount: 45000,
        payee: "Mama Asha Cafe", receiptNo: "R-9001"
      })
    });
    check("create meals cost → 201", b.status === 201, b.status);
    costIds.push(b.json?.id);

    const c = await call("/office-costs", token, {
      method: "POST",
      body: JSON.stringify({
        costDate: today, category: "transport", description: DESC_C, amount: 30000,
        shipmentId: fileId, paymentMethod: "cash"
      })
    });
    check("create file-linked cost → 201", c.status === 201, c.status);
    costIds.push(c.json?.id);

    const rowA = await costRow(a.json?.id);
    check("entry listed: plain date, pending, employee joined, files joined",
      rowA?.cost_date === today && rowA?.status === "pending" && rowA?.amount === 120000 &&
      rowA?.employee_name === SMOKE_EMP && rowA?.approved_by === null &&
      rowA?.document_count === 0 && rowA?.latest_document_id === null,
      { d: rowA?.cost_date, s: rowA?.status, e: rowA?.employee_name });
    const rowC = await costRow(c.json?.id);
    check("file-linked entry carries its file number", rowC?.file_number === SMOKE_FILE, rowC?.file_number);

    // ---- validation ----
    const badCat = await call("/office-costs", token, {
      method: "POST", body: JSON.stringify({ costDate: today, category: "bribes", description: "Smoke bad", amount: 10 })
    });
    check("unknown category → 400", badCat.status === 400, badCat.status);
    const badAmt = await call("/office-costs", token, {
      method: "POST", body: JSON.stringify({ costDate: today, category: "other", description: "Smoke bad", amount: -5 })
    });
    check("negative amount → 400", badAmt.status === 400, badAmt.status);
    const ghostEmp = await call("/office-costs", token, {
      method: "POST", body: JSON.stringify({ costDate: today, category: "allowance", description: "Smoke bad", amount: 10, employeeId: crypto.randomUUID() })
    });
    check("unknown employee → 400", ghostEmp.status === 400, ghostEmp.status);
    const ghostShip = await call("/office-costs", token, {
      method: "POST", body: JSON.stringify({ costDate: today, category: "other", description: "Smoke bad", amount: 10, shipmentId: crypto.randomUUID() })
    });
    check("unknown cargo file → 400", ghostShip.status === 400, ghostShip.status);

    // ---- list filters ----
    const listAll = await call(`/office-costs?month=${month}`, token);
    check("month filter: three entries", (listAll.json ?? []).length === 3, listAll.json?.length);
    check("all pending → newest first",
      listAll.json?.[0]?.id === c.json?.id && listAll.json?.[1]?.id === b.json?.id && listAll.json?.[2]?.id === a.json?.id,
      listAll.json?.map((r: any) => r.description));
    const listOld = await call(`/office-costs?month=${pastMonth}`, token);
    check("past month filter: none", (listOld.json ?? []).length === 0, listOld.json?.length);
    const listMeals = await call(`/office-costs?month=${month}&category=meals`, token);
    check("category filter: meals only", (listMeals.json ?? []).length === 1 && listMeals.json[0].id === b.json?.id);
    const listFile = await call(`/office-costs?month=${month}&shipmentId=${fileId}`, token);
    check("file filter: the file-linked entry", (listFile.json ?? []).length === 1 && listFile.json[0].id === c.json?.id);
    const listSearch = await call(`/office-costs?month=${month}&search=lunch`, token);
    check("search hits the description", (listSearch.json ?? []).length === 1 && listSearch.json[0].id === b.json?.id);
    const listMiss = await call(`/office-costs?month=${month}&search=zzz-nothing`, token);
    check("search miss: empty", (listMiss.json ?? []).length === 0);

    // ---- approvals ----
    const apprA = await call(`/office-costs/${a.json?.id}/decision`, token, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("approve A → 200", apprA.status === 200, apprA.status + " " + JSON.stringify(apprA.json));
    const rowA2 = await costRow(a.json?.id);
    check("A approved: status, approver, timestamp",
      rowA2?.status === "approved" && rowA2?.approved_by === user_id &&
      rowA2?.approved_by_name === full_name && !!rowA2?.approved_at && rowA2?.review_note === null,
      { s: rowA2?.status, by: rowA2?.approved_by_name });

    const apprAgain = await call(`/office-costs/${a.json?.id}/decision`, token, {
      method: "POST", body: JSON.stringify({ decision: "reject" })
    });
    check("re-deciding a reviewed entry → 409", apprAgain.status === 409 && apprAgain.json?.error?.code === "CONFLICT",
      { status: apprAgain.status, code: apprAgain.json?.error?.code });

    const rejB = await call(`/office-costs/${b.json?.id}/decision`, token, {
      method: "POST", body: JSON.stringify({ decision: "reject", note: "Duplicate receipt" })
    });
    check("reject B with note → 200", rejB.status === 200, rejB.status);
    const rowB2 = await costRow(b.json?.id);
    check("B rejected with its note", rowB2?.status === "rejected" && rowB2?.review_note === "Duplicate receipt",
      { s: rowB2?.status, n: rowB2?.review_note });

    const apprC = await call(`/office-costs/${c.json?.id}/decision`, token, {
      method: "POST", body: JSON.stringify({ decision: "approve", note: "File cost ok" })
    });
    check("approve C → 200", apprC.status === 200, apprC.status);

    // ---- edit resets a decided entry to pending ----
    const editC = await call(`/office-costs/${c.json?.id}`, token, {
      method: "PUT", body: JSON.stringify({ amount: 35000 })
    });
    check("edit approved C → 200", editC.status === 200, editC.status);
    const rowC3 = await costRow(c.json?.id);
    check("edited entry back to pending, approval cleared",
      rowC3?.status === "pending" && rowC3?.amount === 35000 && rowC3?.approved_by === null &&
      rowC3?.approved_at === null && rowC3?.review_note === null,
      { s: rowC3?.status, a: rowC3?.amount, by: rowC3?.approved_by });
    const apprC2 = await call(`/office-costs/${c.json?.id}/decision`, token, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("re-approve C → 200", apprC2.status === 200, apprC2.status);

    const editB = await call(`/office-costs/${b.json?.id}`, token, {
      method: "PUT", body: JSON.stringify({ description: DESC_B + " (corrected)", amount: 46000 })
    });
    check("edit rejected B → 200", editB.status === 200, editB.status);
    const rowB3 = await costRow(b.json?.id);
    check("B corrected and pending again",
      rowB3?.status === "pending" && rowB3?.amount === 46000 &&
      rowB3?.description === DESC_B + " (corrected)" && rowB3?.review_note === null,
      { s: rowB3?.status, d: rowB3?.description });

    // ---- foreign tenant cannot touch entries ----
    const foreignEdit = await call(`/office-costs/${a.json?.id}`, fakeTenantToken, {
      method: "PUT", body: JSON.stringify({ amount: 1 })
    });
    check("foreign tenant cannot edit entry → 404", foreignEdit.status === 404, foreignEdit.status);
    const foreignDel = await call(`/office-costs/${b.json?.id}`, fakeTenantToken, { method: "DELETE" });
    check("foreign tenant cannot delete entry → 404", foreignDel.status === 404, foreignDel.status);
    const foreignDecision = await call(`/office-costs/${b.json?.id}/decision`, fakeTenantToken, {
      method: "POST", body: JSON.stringify({ decision: "approve" })
    });
    check("foreign tenant cannot decide entry → 404", foreignDecision.status === 404, foreignDecision.status);

    const listAfter = await call(`/office-costs?month=${month}`, token);
    check("pending rows lead the register",
      listAfter.json?.[0]?.id === b.json?.id && listAfter.json?.[1]?.id === c.json?.id && listAfter.json?.[2]?.id === a.json?.id,
      listAfter.json?.map((r: any) => `${r.status}:${r.description}`));

    // ---- summary: no budgets yet ----
    const sum1 = await call(`/office-costs/summary?month=${month}`, token);
    const s1 = sum1.json;
    check("summary: spent = approved only", s1?.totals?.spent === 155000, s1?.totals);
    check("summary: pending tracked separately",
      s1?.totals?.pending === 46000 && s1?.totals?.pendingCount === 1 && s1?.totals?.approvedCount === 2,
      { p: s1?.totals?.pending, pc: s1?.totals?.pendingCount, ac: s1?.totals?.approvedCount });
    check("summary: budgets zero before they are set", s1?.totals?.budget === 0 && s1?.totals?.remaining === -155000,
      { b: s1?.totals?.budget, r: s1?.totals?.remaining });
    const catOf = (j: any, cat: string) => (j?.categories ?? []).find((r: any) => r.category === cat);
    check("summary: all eight categories reported", (s1?.categories ?? []).length === 8, s1?.categories?.length);
    check("summary: allowance/spent, meals/pending, transport/spent",
      catOf(s1, "allowance")?.spent === 120000 && catOf(s1, "meals")?.spent === 0 &&
      catOf(s1, "meals")?.pending === 46000 && catOf(s1, "transport")?.spent === 35000,
      { a: catOf(s1, "allowance"), m: catOf(s1, "meals"), t: catOf(s1, "transport") });
    check("summary: six trend buckets ending this month",
      (s1?.months ?? []).length === 6 && s1.months[5].month === month && s1.months[5].value === 155000,
      s1?.months);

    // ---- budgets ----
    const budA = await call("/office-budgets", token, {
      method: "POST", body: JSON.stringify({ period: month, category: "allowance", amount: 100000 })
    });
    check("set allowance budget → 200", budA.status === 200 && !!budA.json?.id, budA.status + " " + JSON.stringify(budA.json));
    budgetIds.push(budA.json?.id);

    const budM1 = await call("/office-budgets", token, {
      method: "POST", body: JSON.stringify({ period: month, category: "meals", amount: 20000 })
    });
    check("set meals budget → 200", budM1.status === 200, budM1.status);
    budgetIds.push(budM1.json?.id);
    const budM2 = await call("/office-budgets", token, {
      method: "POST", body: JSON.stringify({ period: month, category: "meals", amount: 21000 })
    });
    check("re-set meals budget upserts the same row", budM2.status === 200 && budM2.json?.id === budM1.json?.id,
      { first: budM1.json?.id, second: budM2.json?.id });

    const budList = await call(`/office-budgets?period=${month}`, token);
    check("budget list: two rows for the month",
      (budList.json ?? []).length === 2 &&
      (budList.json ?? []).find((r: any) => r.category === "meals")?.amount === 21000,
      budList.json);
    const budBad = await call("/office-budgets", token, {
      method: "POST", body: JSON.stringify({ period: month, category: "bribes", amount: 1000 })
    });
    check("unknown budget category → 400", budBad.status === 400, budBad.status);

    const sum2 = await call(`/office-costs/summary?month=${month}`, token);
    check("summary: budget vs spend joined",
      sum2.json?.totals?.budget === 121000 && sum2.json?.totals?.remaining === -34000 &&
      catOf(sum2.json, "meals")?.budget === 21000 && catOf(sum2.json, "meals")?.remaining === 21000 &&
      catOf(sum2.json, "allowance")?.remaining === -20000,
      { b: sum2.json?.totals?.budget, r: sum2.json?.totals?.remaining });

    // ---- file costs against revenue ----
    const fc = await call("/office-costs/file-costs", token);
    check("file costs: totals for the probe file",
      fc.json?.totals?.files === 1 && fc.json?.totals?.allocated === 35000 && fc.json?.totals?.pending === 0,
      fc.json?.totals);
    const fcRow = (fc.json?.rows ?? []).find((r: any) => r.id === fileId);
    check("file costs: row joins shipment revenue, margin computed",
      fcRow?.payment_amount === 500000 && fcRow?.processing_cost === 200000 &&
      fcRow?.allocated === 35000 && fcRow?.margin === 265000 && fcRow?.entries === 1,
      fcRow && { pay: fcRow.payment_amount, proc: fcRow.processing_cost, alloc: fcRow.allocated, margin: fcRow.margin });

    // ---- receipt rides the vault ----
    const fd = new FormData();
    fd.append("entityType", "office_cost");
    fd.append("entityId", a.json?.id);
    fd.append("kind", "receipt");
    fd.append("file", new Blob([PNG_1PX], { type: "image/png" }), "smoke-receipt.png");
    const up = await call("/documents", token, { method: "POST", body: fd });
    check("receipt upload → 201", up.status === 201, up.status + " " + JSON.stringify(up.json));
    docId = up.json?.id ?? null;

    const rowA3 = await costRow(a.json?.id);
    check("entry shows its receipt", rowA3?.document_count === 1 && rowA3?.latest_document_id === docId,
      { n: rowA3?.document_count, id: rowA3?.latest_document_id });

    const docs = await call(`/documents?entityType=office_cost&entityId=${a.json?.id}`, token);
    check("documents list for the entry", (docs.json ?? []).length === 1 && docs.json[0].id === docId);
    const url = await call(`/documents/${docId}/url`, token);
    check("signed URL for the receipt", url.status === 200 && typeof url.json?.url === "string", url.status);
    const vault = await call("/documents/vault?entityType=office_cost", token);
    const vaultRow = (vault.json ?? []).find((d: any) => d.id === docId);
    check("vault labels the cost row", vaultRow?.entity_label === DESC_A && vaultRow?.kind === "receipt",
      vaultRow?.entity_label);

    // ---- notifications ----
    const notif = await call("/notifications", token);
    const items = notif.json?.items ?? [];
    const pendNotif = items.find((i: any) => i.type === "office_cost_pending");
    check("notification: costs awaiting approval",
      !!pendNotif && pendNotif.severity === "info" &&
      pendNotif.title.includes("awaiting approval") && pendNotif.detail === "Total 46,000 to review" &&
      pendNotif.href === "/app/office/costs", pendNotif);
    const overNotif = items.find((i: any) => i.type === "office_budget_over");
    check("notification: allowance budget exceeded",
      !!overNotif && overNotif.severity === "critical" &&
      overNotif.title === "Office budget exceeded: Allowances" &&
      overNotif.detail === "Spent 120,000 of 100,000 this month" &&
      overNotif.href === "/app/office/costs", overNotif);
    const nearNotif = items.find((i: any) => i.type === "office_budget_near");
    check("no near-limit alert when spend is zero", !nearNotif, nearNotif);

    // ---- deletes cascade softly ----
    const delDoc = await call(`/documents/${docId}`, token, { method: "DELETE" });
    check("delete the receipt → 200", delDoc.status === 200, delDoc.status);
    const delCost = await call(`/office-costs/${c.json?.id}`, token, { method: "DELETE" });
    check("delete a cost entry → 200", delCost.status === 200, delCost.status);
    const afterDel = await costRow(c.json?.id);
    check("deleted entry gone from the register", !afterDel);

    const delBud = await call(`/office-budgets/${budM1.json?.id}`, token, { method: "DELETE" });
    check("delete the meals budget → 200", delBud.status === 200, delBud.status);
    const budLeft = await call(`/office-budgets?period=${month}`, token);
    check("budget list drops the deleted row", (budLeft.json ?? []).length === 1 && budLeft.json[0].category === "allowance",
      budLeft.json);

    const ghostDel = await call(`/office-budgets/${crypto.randomUUID()}`, token, { method: "DELETE" });
    check("deleting a ghost budget → 404", ghostDel.status === 404, ghostDel.status);
  } finally {
    // Cleanup. API deletes exercise the real paths where still live; owner
    // sweeps handle the rest (costs/budgets soft-delete, file + employee).
    if (docId) await call(`/documents/${docId}`, token, { method: "DELETE" }).catch(() => { });
    for (const id of costIds) {
      if (id) await call(`/office-costs/${id}`, token, { method: "DELETE" }).catch(() => { });
    }
    for (const id of budgetIds) {
      if (id) await call(`/office-budgets/${id}`, token, { method: "DELETE" }).catch(() => { });
    }
    if (empId) await call(`/employees/${empId}`, token, { method: "DELETE" }).catch(() => { });

    await owner.query(
      `update documents d set deleted_at = now() from office_costs oc
       where d.entity_type = 'office_cost' and d.entity_id = oc.id and d.tenant_id = $1
         and oc.description like 'Smoke Costs%' and d.deleted_at is null`, [tenant_id]).catch(() => { });
    await owner.query(
      `update office_costs set deleted_at = now()
       where tenant_id = $1 and description like 'Smoke Costs%' and deleted_at is null`, [tenant_id]).catch(() => { });
    await owner.query(
      `update employees set deleted_at = now()
       where tenant_id = $1 and full_name like 'Kilian Smoke%' and deleted_at is null`, [tenant_id]).catch(() => { });
    await owner.query(
      `update cargo_shipments set deleted_at = now()
       where tenant_id = $1 and file_number = $2 and deleted_at is null`, [tenant_id, SMOKE_FILE]).catch(() => { });

    const left = await owner.query(
      `select
         (select count(*) from office_costs where tenant_id = $1 and description like 'Smoke Costs%' and deleted_at is null)::int as costs,
         (select count(*) from office_budgets where tenant_id = $1 and period = $2::date and deleted_at is null)::int as budgets,
         (select count(*) from employees where tenant_id = $1 and full_name like 'Kilian Smoke%' and deleted_at is null)::int as employees,
         (select count(*) from cargo_shipments where tenant_id = $1 and file_number = $3 and deleted_at is null)::int as files`,
      [tenant_id, `${month}-01`, SMOKE_FILE]);
    const L = left.rows[0];
    console.log(`cleanup: costs=${L.costs} budgets=${L.budgets} employees=${L.employees} files=${L.files} remaining`);
    await owner.end();
  }

  console.log(failures ? `${failures} FAILED` : "all office cost smoke checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
