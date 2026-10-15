/**
 * Step 2 — route-level cross-tenant isolation smoke.
 * Boots nothing itself: expects the API on :4000. Creates two probe tenants with
 * owner SQL, seeds tenant A with fixture rows across every module, then drives
 * the HTTP API as tenant B's director: every list endpoint must show zero of
 * A's ids, every foreign-id detail/write probe must be rejected, uploads to
 * foreign parents must fail, and a final SQL verification proves nothing in A
 * changed and nothing was written into B. Positive controls (A sees its own
 * data) guard against a vacuous pass. Cleans up everything it creates.
 * Run: npx tsx scripts/smoke-isolation.ts   (DNS_FALLBACK=1 if local DNS broken)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET);
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label, detail.slice(0, 140)); }
}

async function mint(sub: string, tid: string, typ: string, roles: string[]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000cc", typ, roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("1h").sign(key);
}

async function call(path: string, token: string, init: any = {}) {
  const headers: any = { ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...init, headers });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await owner.connect();

  const health = await fetch(API + "/health").then(r => r.json()).catch(() => null);
  if (!health) { console.error("API not running on :4000 — boot it first"); process.exit(1); }

  const T1 = randomUUID(), T2 = randomUUID();
  const d1 = randomUUID(), d2 = randomUUID(), sp1 = randomUUID();
  const ids = { T1, T2, d1, d2, sp1 } as Record<string, string>;
  const seed = async (name: string) => { ids[name] = randomUUID(); return ids[name]; };
  const c1 = await seed("c1"), s1 = await seed("s1"), ct1 = await seed("ct1"), dr1 = await seed("dr1"),
    v1 = await seed("v1"), rt1 = await seed("rt1"), rc1 = await seed("rc1"), tr1 = await seed("tr1"),
    inv1 = await seed("inv1"), ii1 = await seed("ii1"), ex1 = await seed("ex1"), emp1 = await seed("emp1"),
    ot1 = await seed("ot1"), ev1 = await seed("ev1"), oc1 = await seed("oc1"), ob1 = await seed("ob1"),
    rl1 = await seed("rl1"), se1 = await seed("se1"), msg1 = await seed("msg1"), fl1 = await seed("fl1"),
    inc1 = await seed("inc1"), iv1 = await seed("iv1"), doc1 = await seed("doc1"), br1 = await seed("br1"),
    sa1 = await seed("sa1"), sfs1 = await seed("sfs1");
  const allT1 = Object.values(ids).filter(v => ![T2, d2].includes(v));

  const role = (await owner.query(
    `select id from roles where key = 'director' and tenant_id is null`)).rows[0];

  // Dependency-ordered (deepest children first) per pg_constraint:
  // trip_checkpoint_logs→(route_checkpoints,trips); routes→trips→(freight_invoices,
  // freight_expenses,fuel_logs,incidents,trip_shipments); shipper_accounts→shipper_file_shares;
  // freight_invoice_(items|payments)→freight_invoices; (employees,cargo_shipments)→(evaluations,
  // office_tasks,office_costs,cargo_tasks,messages); screening_checks→screening_entries.
  const WIPE = ["trip_checkpoint_logs", "route_checkpoints", "shipper_file_shares", "shipper_accounts",
    "freight_invoice_payments", "freight_invoice_items", "freight_invoices", "freight_expenses",
    "fuel_logs", "incidents", "trip_shipments", "trips", "routes", "message_reads", "messages",
    "office_costs", "office_tasks", "employee_evaluations", "employees", "screening_checks",
    "screening_entries", "cargo_tasks", "cargo_shipments", "clients", "drivers", "vessels",
    "office_budgets", "regulatory_licences", "inventory_items", "documents", "branches",
    "sessions", "otp_codes", "password_resets", "settings", "subscriptions"];
  const wipeRoles = `delete from user_roles where user_id in
    (select id from users where tenant_id = any($1::uuid[]))`;

  // Pre-clean: sweep any residue from an earlier crashed run (fixtures are named Iso*).
  const oldT = (await owner.query(
    `select id from tenants where name in ('Iso Alpha Ltd','Iso Beta Ltd')`)).rows.map(r => r.id);
  if (oldT.length) {
    for (const t of WIPE) await owner.query(`delete from ${t} where tenant_id = any($1::uuid[])`, [oldT]);
    await owner.query(wipeRoles, [oldT]);
    await owner.query(`delete from users where tenant_id = any($1::uuid[])`, [oldT]);
    await owner.query(`delete from tenants where id = any($1::uuid[])`, [oldT]);
    console.log("pre-clean removed", oldT.length, "stale probe tenants");
  }

  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const ins = (t: string, cols: string, vals: string) => `insert into ${t} (${cols}) values (${vals})`;

  // ---- tenant A (data owner) + tenant B (attacker) -------------------------
  await oi(ins("tenants", "id, type, name", `$1,'transporter','Iso Alpha Ltd'`), [T1]);
  await oi(ins("tenants", "id, type, name", `$1,'transporter','Iso Beta Ltd'`), [T2]);
  for (const [u, t, name] of [[d1, T1, "Alpha Director"], [d2, T2, "Beta Director"], [sp1, T1, "Iso Shipper"]]) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status)
              values ($1,$2,$3,$4,'active')`,
      [u, t, t === T1 && name === "Iso Shipper" ? "shipper" : "director", name]);
  }
  await oi(ins("user_roles", "user_id, role_id", `$1,$2`), [d1, role.id]);
  await oi(ins("user_roles", "user_id, role_id", `$1,$2`), [d2, role.id]);

  await oi(ins("clients", "id, tenant_id, name", `$1,$2,'Iso Secret Client Co'`), [c1, T1]);
  await oi(`insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
             container_type, consignee_name, consignor_name, stage, status)
           values ($1,$2,'ISO-95001',1,2026,'import','40ft','Iso Secret Cargo Co','Iso Supplier','customs','open')`, [s1, T1]);
  await oi(ins("cargo_tasks", "id, tenant_id, shipment_id, title", `$1,$2,$3,'Iso secret task'`), [ct1, T1, s1]);
  await oi(ins("drivers", "id, tenant_id, full_name", `$1,$2,'Iso Secret Driver'`), [dr1, T1]);
  await oi(ins("vessels", "id, tenant_id, name, vessel_type, plate_number", `$1,$2,'Iso Secret Truck','truck_head','ISO-T-1'`), [v1, T1]);
  await oi(ins("routes", "id, tenant_id, name", `$1,$2,'Iso Secret Route'`), [rt1, T1]);
  await oi(ins("route_checkpoints", "id, tenant_id, route_id, seq, kind, name", `$1,$2,$3,1,'border','Iso CP'`), [rc1, T1, rt1]);
  await oi(ins("trips", "id, tenant_id, route_id", `$1,$2,$3`), [tr1, T1, rt1]);
  await oi(ins("freight_invoices", "id, tenant_id, invoice_number, customer_name", `$1,$2,'ISO-INV-9001','Iso Secret Client Co'`), [inv1, T1]);
  await oi(ins("freight_invoice_items", "id, tenant_id, invoice_id, seq, description", `$1,$2,$3,1,'Iso line'`), [ii1, T1, inv1]);
  await oi(ins("freight_expenses", "id, tenant_id, supplier_name, amount", `$1,$2,'Iso Supplier','5000'`), [ex1, T1]);
  await oi(ins("employees", "id, tenant_id, full_name", `$1,$2,'Iso Secret Employee'`), [emp1, T1]);
  await oi(ins("office_tasks", "id, tenant_id, employee_id, title", `$1,$2,$3,'Iso office task'`), [ot1, T1, emp1]);
  await oi(`insert into employee_evaluations (id, tenant_id, employee_id, period,
             task_completion, punctuality, client_satisfaction, collaboration)
           values ($1,$2,$3,'2026-10-01',4,4,4,4)`, [ev1, T1, emp1]);
  await oi(`insert into office_costs (id, tenant_id, cost_date, category, description, amount)
           values ($1,$2,'2026-10-10','meals','Iso secret lunch','9000')`, [oc1, T1]);
  await oi(ins("office_budgets", "id, tenant_id, period, category, amount", `$1,$2,'2026-10-01','meals','500000'`), [ob1, T1]);
  await oi(ins("regulatory_licences", "id, tenant_id, title, expiry_date", `$1,$2,'Iso TRA Bond','2027-01-01'`), [rl1, T1]);
  await oi(ins("screening_entries", "id, tenant_id, party_name, reason", `$1,$2,'Iso Bad Actor','fraud'`), [se1, T1]);
  await oi(ins("messages", "id, tenant_id, created_by, shipment_id, body", `$1,$2,$3,$4,'Iso secret msg'`), [msg1, T1, d1, s1]);
  await oi(ins("fuel_logs", "id, tenant_id, litres", `$1,$2,'50'`), [fl1, T1]);
  await oi(ins("incidents", "id, tenant_id, description", `$1,$2,'Iso secret incident'`), [inc1, T1]);
  await oi(ins("inventory_items", "id, tenant_id, name", `$1,$2,'Iso Secret Item'`), [iv1, T1]);
  await oi(`insert into documents (id, tenant_id, entity_type, entity_id, kind, file_name, mime_type,
             size_bytes, storage_path, uploaded_by, created_by, updated_by)
           values ($1,$2,'shipment',$3,'invoice','iso-secret.pdf','application/pdf',1,'iso/secret.pdf',$4,$4,$4)`,
    [doc1, T1, s1, d1]);
  await oi(ins("branches", "id, tenant_id, kind, name", `$1,$2,'branch','Iso Secret Branch'`), [br1, T1]);
  await oi(ins("shipper_accounts", "id, tenant_id, client_id, user_id", `$1,$2,$3,$4`), [sa1, T1, c1, sp1]);
  await oi(ins("shipper_file_shares", "id, tenant_id, shipper_account_id, shipment_id", `$1,$2,$3,$4`), [sfs1, T1, sa1, s1]);
  const portalRole = (await owner.query(
    `select id from roles where key = 'shipper_portal' and tenant_id is null`)).rows[0];
  await oi(ins("user_roles", "user_id, role_id", `$1,$2`), [sp1, portalRole.id]);

  const tok1 = await mint(d1, T1, "director", ["director"]);
  const tok2 = await mint(d2, T2, "director", ["director"]);
  const spTok1 = await mint(sp1, T1, "shipper", ["shipper_portal"]);
  const spTok2 = await mint(sp1, T2, "shipper", ["shipper_portal"]); // forged: shipper living in wrong tenant

  // ---- positive controls: A sees its own data -------------------------------
  const own = await call("/cargo", tok1);
  check("positive: A's cargo list contains s1", JSON.stringify(own.body).includes(s1));
  const ownDetail = await call(`/cargo/${s1}`, tok1);
  check("positive: A reads own cargo detail", ownDetail.status === 200);

  // ---- B list contamination --------------------------------------------------
  const lists = ["/cargo", "/cargo/analytics", "/clients", "/drivers", "/vessels", "/trips", "/routes",
    "/invoices", "/ledger/receivables", "/ledger/payables", "/employees", "/office-tasks", "/evaluations",
    "/office-costs", "/office-costs/summary", "/office-costs/file-costs", "/office-budgets", "/licences",
    "/screening/entries", "/screening/matches", "/screening/checks", "/messages/threads", `/messages?shipmentId=${s1}`,
    "/notifications", "/calendar/events?month=2026-10", `/documents?entityType=shipment&entityId=${s1}`, "/documents/vault", "/fuel-logs", "/incidents",
    "/inventory", "/branches", "/shipper-accounts", "/users", "/reports/cargo", "/reports/summary", "/profile"];
  for (const p of lists) {
    const r = await call(p, tok2);
    const hay = JSON.stringify(r.body ?? "");
    const leaked = allT1.filter(id => hay.includes(id));
    // foreign-parent entity lists legitimately 404 for tenant B — that is the isolation working
    const okStatus = r.status === 200 || (r.status === 404 && (p.includes(`shipmentId=${s1}`) || p.includes(`entityId=${s1}`)));
    check(`B list clean ${p}`, okStatus && leaked.length === 0, `[${r.status}] ${leaked.join(",")}`);
  }
  const ownDocs = await call(`/documents?entityType=shipment&entityId=${s1}`, tok1);
  check("positive: A lists own shipment documents", ownDocs.status === 200 &&
    JSON.stringify(ownDocs.body).includes(doc1), `[${ownDocs.status}]`);

  // ---- B foreign-id probes (reads and writes must not succeed) --------------
  const probes: [string, string, any?][] = [
    [`/cargo/${s1}`, "GET"], [`/cargo/${s1}/stage`, "PUT", { stage: "arrival" }],
    [`/cargo/${s1}`, "DELETE"], [`/cargo/${s1}/tasks`, "POST", { title: "probe" }],
    [`/cargo/${s1}/duplicate`, "POST"],
    [`/clients/${c1}`, "DELETE"], [`/clients/${c1}`, "PUT", { name: "hijacked" }],
    [`/drivers/${dr1}`, "DELETE"], [`/vessels/${v1}`, "DELETE"],
    [`/trips/${tr1}`, "GET"], [`/trips/${tr1}`, "DELETE"],
    [`/routes/${rt1}`, "GET"], [`/routes/${rt1}`, "DELETE"],
    [`/invoices/${inv1}`, "GET"], [`/invoices/${inv1}`, "DELETE"],
    [`/invoices/${inv1}/status`, "PUT", { status: "paid" }],
    [`/employees/${emp1}`, "DELETE"], [`/office-tasks/${ot1}`, "DELETE"], [`/evaluations/${ev1}`, "DELETE"],
    [`/office-costs/${oc1}`, "DELETE"], [`/office-costs/${oc1}/decision`, "POST", { decision: "approved" }],
    [`/office-budgets/${ob1}`, "DELETE"], [`/licences/${rl1}`, "DELETE"], [`/screening/entries/${se1}`, "DELETE"],
    [`/messages/${msg1}`, "DELETE"], [`/messages`, "POST", { body: "probe", shipmentId: s1 }],
    [`/fuel-logs/${fl1}`, "DELETE"], [`/incidents/${inc1}`, "DELETE"], [`/inventory/${iv1}`, "DELETE"],
    [`/branches/${br1}`, "DELETE"],
    [`/documents/${doc1}/url`, "GET"], [`/documents/${doc1}/content`, "GET"], [`/documents/${doc1}`, "DELETE"],
    [`/shipper-accounts/${sa1}`, "GET"], [`/shipper-accounts/${sa1}`, "DELETE"],
    [`/shipper-accounts/${sa1}/shares`, "POST", { shipmentId: s1 }],
    [`/users/${d1}/status`, "PUT", { status: "deactivated" }]
  ];
  for (const [p, method, body] of probes) {
    const r = await call(p, tok2, { method, ...(body ? {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    } : {}) });
    const strict = method === "GET" || method === "DELETE" || p.includes("/url");
    const okRes = strict ? r.status === 404 || r.status === 403 : r.status >= 400;
    check(`B probe ${method} ${p}`, okRes, `[${r.status}]`);
  }

  // ---- B upload into A's shipment --------------------------------------------
  const fd = new FormData();
  fd.set("entityType", "shipment"); fd.set("entityId", s1); fd.set("kind", "invoice");
  fd.set("file", new Blob([Buffer.from("probe")], { type: "application/pdf" }), "probe.pdf");
  const up = await fetch(`${API}/documents`, { method: "POST", headers: { Authorization: `Bearer ${tok2}` }, body: fd });
  check("B cannot upload into A's shipment", up.status >= 400, `[${up.status}]`);

  // content spoofing: markup disguised as an image, and png bytes declared as pdf
  const spoof = new FormData();
  spoof.set("entityType", "shipment"); spoof.set("entityId", s1); spoof.set("kind", "invoice");
  spoof.set("file", new Blob([Buffer.from("<html><script>alert(1)</script>payload payload".padEnd(64))],
    { type: "image/png" }), "spoof.png");
  const sp = await fetch(`${API}/documents`, { method: "POST", headers: { Authorization: `Bearer ${tok1}` }, body: spoof });
  check("upload rejected when content is markup declared as png", sp.status === 400, `[${sp.status}]`);
  const realPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const spoof2 = new FormData();
  spoof2.set("entityType", "shipment"); spoof2.set("entityId", s1); spoof2.set("kind", "invoice");
  spoof2.set("file", new Blob([realPng], { type: "application/pdf" }), "mismatch.pdf");
  const sp2 = await fetch(`${API}/documents`, { method: "POST", headers: { Authorization: `Bearer ${tok1}` }, body: spoof2 });
  check("upload rejected when png bytes are declared as pdf", sp2.status === 400, `[${sp2.status}]`);
  const okFd = new FormData();
  okFd.set("entityType", "shipment"); okFd.set("entityId", s1); okFd.set("kind", "invoice");
  okFd.set("file", new Blob([realPng], { type: "image/png" }), "real.png");
  const okUp = await fetch(`${API}/documents`, { method: "POST", headers: { Authorization: `Bearer ${tok1}` }, body: okFd });
  check("positive: a genuine PNG still uploads", okUp.status === 201, `[${okUp.status}] ${JSON.stringify(okUp.body ?? {}).slice(0, 80)}`);
  if (okUp.status === 201 && okUp.body?.id) await call(`/documents/${okUp.body.id}`, tok1, { method: "DELETE" });

  // ---- portal forged-tenant and no-account shippers --------------------------
  check("forged shipper (A user, B tenant) portal overview 403", (await call("/portal/overview", spTok2)).status === 403);
  const dirPortal = await call("/portal/files", tok2);
  const dirEmpty = JSON.stringify(dirPortal.body?.files ?? dirPortal.body) === "[]";
  check("director token gets 403 or empty portal", dirPortal.status === 403 || (dirPortal.status === 200 && dirEmpty),
    `[${dirPortal.status}] ${JSON.stringify(dirPortal.body).slice(0, 80)}`);
  const posPortal = await call("/portal/files", spTok1);
  check("positive: A's shipper sees its shared file", posPortal.status === 200 &&
    JSON.stringify(posPortal.body).includes(s1), `[${posPortal.status}]`);

  // ---- SQL verification: A untouched, B empty --------------------------------
  const untouched = await oi(
    `select (select deleted_at is null from cargo_shipments where id=$1) as s1_alive,
            (select consignee_name from cargo_shipments where id=$1) as s1_name,
            (select count(*) from messages where tenant_id=$2)::int as msgs,
            (select status from users where id=$3) as d1_status,
            (select count(*) from freight_invoices where id=$4) as inv_rows`,
    [s1, T1, d1, inv1]);
  const U = untouched.rows[0];
  check("A cargo survived all probes untouched", U.s1_alive && U.s1_name === "Iso Secret Cargo Co");
  check("A messages row count unchanged", U.msgs === 1);
  check("A director not deactivated by probe", U.d1_status === "active");
  check("A invoice not deleted", Number(U.inv_rows) === 1);

  const writebacks = ["cargo_shipments", "cargo_tasks", "clients", "drivers", "vessels", "routes",
    "trips", "freight_invoices", "freight_expenses", "employees", "office_tasks", "office_costs",
    "office_budgets", "regulatory_licences", "screening_entries", "messages", "fuel_logs",
    "incidents", "inventory_items", "documents", "branches", "shipper_accounts", "shipper_file_shares"];
  const wrote = [];
  for (const t of writebacks) {
    const r = await oi(`select count(*)::int as n from ${t} where tenant_id = $1`, [T2]);
    if (r.rows[0].n > 0) wrote.push(`${t}:${r.rows[0].n}`);
  }
  check("B created zero rows in any tenant table", wrote.length === 0, wrote.join(","));

  // ---- cleanup (shared dependency-ordered WIPE list) -------------------------
  for (const t of WIPE) {
    await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [[T1, T2]]);
  }
  await oi(wipeRoles, [[T1, T2]]);
  await oi(`delete from users where tenant_id = any($1::uuid[])`, [[T1, T2]]);
  await oi(`delete from tenants where id = any($1::uuid[])`, [[T1, T2]]);
  const residue = await oi(
    `select (select count(*) from users where tenant_id = any($1::uuid[]))::int as u,
            (select count(*) from tenants where id = any($1::uuid[]))::int as t`, [[T1, T2]]);
  console.log("cleanup:", JSON.stringify(residue.rows[0]));
  await owner.end();

  console.log(failures ? `${failures} FAILED` : "all route-level isolation checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
