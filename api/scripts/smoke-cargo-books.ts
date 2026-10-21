/**
 * #188 — the two cargo books smoke (Clearing vs Transport).
 *
 * The office asked to stop reading inbound clearing work off the same list as outbound movement.
 * Nothing was added to the schema to do it: the split is a reading of 034's `shipment_type`. So
 * this smoke's job is to prove three things over real HTTP:
 *   1. `?book=` returns exactly the family it names, and a type from the other book is refused
 *      rather than answered with an empty list;
 *   2. `/cargo/books` counts agree with the register and with the rows in the database, so a
 *      number on a tab cannot become a different story from the files under it;
 *   3. everything that hands a clerk to a file — the file page, an alert, a calendar event —
 *      hands them to the book that actually holds it.
 * A foreign tenant, a seat without the duty and a file that tried to change books close the run.
 * Fixtures are named Bookprobe* on their own tenants; everything is wiped at the end.
 * Run: npx tsx scripts/smoke-cargo-books.ts   (DNS_FALLBACK=1 if local DNS is broken)
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
  else { failures++; console.log("FAIL ", label, detail.slice(0, 220)); }
}

async function mint(sub: string, tid: string, typ: string, roles: string[]) {
  return new SignJWT({ tid, sid: "00000000-7000-8000-0000-0000000000cc", typ, roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("1h").sign(key);
}

async function call(path: string, token: string, init: any = {}) {
  const headers: any = { ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts: any = { ...init, headers };
  if (opts.body !== undefined && !opts.method) opts.method = "POST";
  const res = await fetch(API + path, opts);
  let body: any = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}
const json = (body: any) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const post = (body: any) => ({ method: "POST", ...json(body) });

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shiftDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
const monthOf = (day: string) => day.slice(0, 7);
const CLEARING = ["import", "transhipment"];
const TRANSPORT = ["export", "transit"];

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const health = await fetch(API + "/health").then(r => r.json()).catch(() => null);
  if (!health) { console.error("API not running on :4000 — boot it first"); process.exit(1); }

  const T1 = randomUUID(), T2 = randomUUID();
  const d1 = randomUUID(), d2 = randomUUID(), noDuty = randomUUID();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const WIPE = ["job_handovers", "job_documents", "job_activity", "cargo_tasks", "job_stages",
    "jobs", "cargo_import_masters", "cargo_shipments", "alert_reads", "documents",
    "company_profiles", "sessions", "otp_codes", "password_resets"];
  const wipeRoles = `delete from user_roles where user_id in
    (select id from users where tenant_id = any($1::uuid[]))`;

  // Pre-clean residue of an earlier crashed run (fixtures are named Bookprobe*).
  const oldT = (await oi(
    `select id from tenants where name in ('Bookprobe Clear Ltd','Bookprobe Transit Ltd')`)).rows.map(r => r.id);
  if (oldT.length) {
    for (const t of WIPE) await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [oldT]);
    await oi(wipeRoles, [oldT]);
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [oldT]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [oldT]);
    console.log("pre-clean removed", oldT.length, "stale probe tenants");
  }

  await oi(`insert into tenants (id, type, name) values ($1,'transporter','Bookprobe Clear Ltd')`, [T1]);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter','Bookprobe Transit Ltd')`, [T2]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, company_code)
            values ($1,$2,'Bookprobe Clear Ltd','BP1')`, [randomUUID(), T1]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, company_code)
            values ($1,$2,'Bookprobe Transit Ltd','BP2')`, [randomUUID(), T2]);
  for (const [u, t, name] of [[d1, T1, "Bookprobe Alpha Director"], [d2, T2, "Bookprobe Beta Director"],
    [noDuty, T1, "Bookprobe No Duty"]]) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status)
              values ($1,$2,'staff',$3,'active')`, [u, t, name]);
  }
  const directorRole = (await oi(
    `select id from roles where key = 'director' and tenant_id is null`)).rows[0]?.id;
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [d1, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [d2, directorRole]);
  // noDuty holds no role at all: the duty keys must refuse it, not the tenant check.

  const tok1 = await mint(d1, T1, "director", ["director"]);
  const tok2 = await mint(d2, T2, "director", ["director"]);
  const tokBare = await mint(noDuty, T1, "staff", []);

  // ---------- 1. Six files, three in each book ----------
  // Two ETAs are already past, so the unpaid-alert path fires on both books too.
  const eta = { i1: shiftDays(2), i2: shiftDays(-2), t1: shiftDays(1),
    e1: shiftDays(3), r1: shiftDays(-1), r2: shiftDays(5) };
  const FILES: [string, string, string][] = [
    ["i1", "import", "Bookprobe Rice Trader"],
    ["i2", "import", "Bookprobe Building Materials"],
    ["t1", "transhipment", "Bookprobe Copper Belt"],
    ["e1", "export", "Bookprobe Coffee Buyer"],
    ["r1", "transit", "Bookprobe Fuel Carrier"],
    ["r2", "transit", "Bookprobe Timber Transit"]
  ];
  const ids: Record<string, string> = {};
  const numbers: Record<string, string> = {};
  for (const [tag, type, consignee] of FILES) {
    const res = await call("/cargo", tok1, post({
      shipmentType: type, containerType: "loose_cargo",
      consigneeName: consignee, consignorName: `Bookprobe Sender ${tag}`,
      eta: (eta as any)[tag]
    }));
    ids[tag] = res.body?.id ?? "";
    numbers[tag] = res.body?.fileNumber ?? "";
    check(`file created (${tag} ${type})`, res.status === 201 && !!ids[tag], `[${res.status}]`);
  }

  const listBook = async (book: string, extra = "") => {
    const r = await call(`/cargo?book=${book}${extra}`, tok1);
    return { rows: (r.body ?? []) as any[], status: r.status };
  };

  // ---------- 2. Each register lists only its own family ----------
  const clearing = await listBook("clearing");
  check("?book=clearing lists exactly the three inbound files",
    clearing.status === 200 && clearing.rows.length === 3 &&
      [ids.i1, ids.i2, ids.t1].every(x => clearing.rows.some(r => r.id === x)) &&
      [ids.e1, ids.r1, ids.r2].every(x => !clearing.rows.some(r => r.id === x)),
    `[${clearing.status}] n=${clearing.rows.length}`);
  check("every clearing row is an import or a transhipment",
    clearing.rows.every(r => CLEARING.includes(r.shipment_type)),
    JSON.stringify(clearing.rows.map(r => r.shipment_type)));
  const transport = await listBook("transport");
  check("?book=transport lists exactly the three outbound files",
    transport.status === 200 && transport.rows.length === 3 &&
      [ids.e1, ids.r1, ids.r2].every(x => transport.rows.some(r => r.id === x)),
    `[${transport.status}] n=${transport.rows.length}`);
  check("every transport row is an export or a transit",
    transport.rows.every(r => TRANSPORT.includes(r.shipment_type)),
    JSON.stringify(transport.rows.map(r => r.shipment_type)));
  check("a book's own file numbers carry its own prefixes",
    clearing.rows.every(r => r.file_number.startsWith("4") || r.file_number.startsWith("7")) &&
      transport.rows.every(r => r.file_number.startsWith("1") || r.file_number.startsWith("8")),
    JSON.stringify([...clearing.rows, ...transport.rows].map(r => r.file_number)));

  const unsplit = await call("/cargo", tok1);
  check("a register asked without a book still lists all six (nothing hidden)",
    unsplit.status === 200 && (unsplit.body ?? []).length === 6, `[${unsplit.status}]`);

  check("?book=clearing&shipmentType=import narrows within the book",
    JSON.stringify((await listBook("clearing", "&shipmentType=import")).rows.map((r: any) => r.id).sort())
      === JSON.stringify([ids.i1, ids.i2].sort()));
  const oneTranshipment = await listBook("clearing", "&shipmentType=transhipment");
  check("the book keeps a type that holds only one file",
    oneTranshipment.rows.length === 1 && oneTranshipment.rows[0].id === ids.t1,
    `n=${oneTranshipment.rows.length}`);
  const mixedWish = await call("/cargo?book=clearing&shipmentType=export", tok1);
  check("a type from the other book is refused, not answered with an empty list",
    mixedWish.status === 400 && JSON.stringify(mixedWish.body).includes("not filed in the clearing book"),
    `[${mixedWish.status}] ${JSON.stringify(mixedWish.body).slice(0, 160)}`);
  const badBook = await call("/cargo?book=all", tok1);
  check("a book the desk does not keep is named as a bad request",
    badBook.status === 400, `[${badBook.status}]`);
  const stageInsideBook = await listBook("transport", "&stage=pre_arrival");
  check("stage and book filters stack",
    stageInsideBook.status === 200 && stageInsideBook.rows.length === 3 &&
      stageInsideBook.rows.every(r => TRANSPORT.includes(r.shipment_type)),
    `n=${stageInsideBook.rows.length}`);

  // ---------- 3. The counts the tabs print ----------
  const booksRes = await call("/cargo/books", tok1);
  const bookOf = (k: string) => (booksRes.body?.books ?? []).find((b: any) => b.key === k);
  const typeCount = (b: any, t: string) => b?.types?.find((x: any) => x.value === t)?.count;
  check("/cargo/books answers with both books, in the office's words",
    booksRes.status === 200 && bookOf("clearing")?.label === "Clearing" &&
      bookOf("transport")?.label === "Transport", `[${booksRes.status}] ${JSON.stringify(booksRes.body)}`);
  check("clearing counts 3 (2 import, 1 transhipment)",
    bookOf("clearing")?.count === 3 && typeCount(bookOf("clearing"), "import") === 2 &&
      typeCount(bookOf("clearing"), "transhipment") === 1, JSON.stringify(bookOf("clearing")));
  check("transport counts 3 (1 export, 2 transit)",
    bookOf("transport")?.count === 3 && typeCount(bookOf("transport"), "export") === 1 &&
      typeCount(bookOf("transport"), "transit") === 2, JSON.stringify(bookOf("transport")));
  check("the two books add up to the whole desk",
    booksRes.body?.total === 6 && bookOf("clearing").count + bookOf("transport").count === 6,
    `total=${booksRes.body?.total}`);
  const dbCounts = await oi(
    `select shipment_type, count(*)::int as n from cargo_shipments
     where tenant_id = $1 and deleted_at is null group by shipment_type`, [T1]);
  check("the counts come from the rows, not from the 200 the register may cut",
    dbCounts.rows.every(r => typeCount(bookOf((CLEARING as string[]).includes(r.shipment_type) ? "clearing" : "transport"),
      r.shipment_type) === r.n), JSON.stringify(dbCounts.rows));

  // ---------- 4. The file page names its own book ----------
  const i1Detail = await call(`/cargo/${ids.i1}`, tok1);
  check("an import file says it stands in the Clearing book",
    i1Detail.status === 200 && i1Detail.body?.book?.key === "clearing" &&
      i1Detail.body?.book?.label === "Clearing", JSON.stringify(i1Detail.body?.book));
  const r1Detail = await call(`/cargo/${ids.r1}`, tok1);
  check("a transit file says it stands in the Transport book",
    r1Detail.body?.book?.key === "transport" && r1Detail.body?.book?.label === "Transport",
    JSON.stringify(r1Detail.body?.book));

  const moved = await call(`/cargo/${ids.i1}`, tok1,
    { method: "PUT", ...json({ shipmentType: "export", consigneeName: "Bookprobe Rice Trader" }) });
  const afterMove = await oi(
    `select shipment_type, file_number from cargo_shipments where id = $1`, [ids.i1]);
  check("a file cannot be pushed into the other book by editing it",
    moved.status === 200 && afterMove.rows[0].shipment_type === "import" &&
      afterMove.rows[0].file_number === numbers.i1,
    `[${moved.status}] ${JSON.stringify(afterMove.rows[0])}`);
  check("…and it is still listed under clearing afterwards",
    (await listBook("clearing")).rows.some(r => r.id === ids.i1));

  // ---------- 5. A cancelled file stays on the list its tab counts ----------
  const cancelled = await call(`/cargo/${ids.r2}/status`, tok1,
    { method: "PUT", ...json({ status: "cancelled" }) });
  const transportAfterCancel = await listBook("transport");
  check("cancelling keeps the file on its register, with its status said",
    cancelled.status === 200 && transportAfterCancel.rows.length === 3 &&
      transportAfterCancel.rows.find(r => r.id === ids.r2)?.status === "cancelled",
    `[${cancelled.status}] n=${transportAfterCancel.rows.length}`);
  const booksAfterCancel = await call("/cargo/books", tok1);
  check("the tab count agrees with the rows under it through a cancel",
    (booksAfterCancel.body?.books ?? []).find((b: any) => b.key === "transport")?.count ===
      transportAfterCancel.rows.length,
    `count=${(booksAfterCancel.body?.books ?? []).find((b: any) => b.key === "transport")?.count}`);

  // A task on an outbound file, due today, so the alert and the calendar both have to route it.
  const taskOnExport = await call(`/cargo/${ids.e1}/tasks`, tok1,
    post({ title: "Bookprobe seal the export manifest", dueDate: shiftDays(0), assignedTo: d1 }));
  check("a task can be hung on an export file",
    taskOnExport.status === 201 && !!taskOnExport.body?.id, `[${taskOnExport.status}]`);

  const removed = await call(`/cargo/${ids.i2}`, tok1, { method: "DELETE" });
  const clearingAfterDelete = await listBook("clearing");
  const booksAfterDelete = await call("/cargo/books", tok1);
  check("a deleted file leaves both the register and its count",
    removed.status === 200 && clearingAfterDelete.rows.length === 2 &&
      (booksAfterDelete.body?.books ?? []).find((b: any) => b.key === "clearing")?.count === 2 &&
      booksAfterDelete.body?.total === 5,
    `[${removed.status}] n=${clearingAfterDelete.rows.length} total=${booksAfterDelete.body?.total}`);

  // ---------- 6. Alerts and calendar hand the clerk to the right book ----------
  const notif = await call("/notifications", tok1);
  const notes: any[] = notif.body?.items ?? [];
  const byKey = (p: string) => notes.find(n => String(n.key).startsWith(p));
  check("an inbound ETA alert opens the clearing register",
    byKey(`cargo_eta:${ids.i1}`)?.href === "/app/cfa/cargo?book=clearing",
    JSON.stringify(byKey(`cargo_eta:${ids.i1}`)?.href));
  check("an outbound payment alert opens the transport register",
    byKey(`cargo_payment:${ids.r1}`)?.href === "/app/cfa/cargo?book=transport",
    JSON.stringify(byKey(`cargo_payment:${ids.r1}`)?.href));
  const taskAlert = byKey(`cargo_task:${taskOnExport.body?.id}`);
  check("an export task deadline opens the transport register",
    taskAlert?.href === "/app/cfa/cargo?book=transport", JSON.stringify(taskAlert?.href));
  const cargoAlerts = notes.filter(n => String(n.href).includes("/app/cfa/cargo"));
  // Resolve every cargo alert back to the row it was built from, in SQL, so the sweep is the
  // server's own answer checked against the database rather than a second copy of the split.
  const typeOfShipment = new Map((await oi(
    `select id, shipment_type from cargo_shipments where tenant_id = $1`, [T1]
  )).rows.map(r => [r.id, r.shipment_type]));
  const typeOfTask = new Map((await oi(
    `select k.id, s.shipment_type from cargo_tasks k
       join cargo_shipments s on s.id = k.shipment_id where k.tenant_id = $1`, [T1]
  )).rows.map(r => [r.id, r.shipment_type]));
  const misplaced: string[] = [];
  for (const n of cargoAlerts) {
    const [kind, ref] = String(n.key).split(":");
    const type = kind === "cargo_task" ? typeOfTask.get(ref) : typeOfShipment.get(ref);
    const want = CLEARING.includes(String(type)) ? "clearing"
      : TRANSPORT.includes(String(type)) ? "transport" : null;
    if (!want || !String(n.href).endsWith(`book=${want}`)) misplaced.push(`${n.key} (${type}) → ${n.href}`);
  }
  check("every cargo alert opens the register that holds its file",
    cargoAlerts.length >= 3 && misplaced.length === 0, JSON.stringify(misplaced));

  const cal = await call(`/calendar/events?month=${monthOf(eta.i1)}`, tok1);
  const calEvents: any[] = cal.body?.events ?? [];
  const etaEvent = calEvents.find(e => String(e.label).startsWith(`${numbers.i1} arrives`));
  check("the calendar's ETA event opens the clearing register",
    cal.status === 200 && etaEvent?.href === "/app/cfa/cargo?book=clearing",
    JSON.stringify(etaEvent));
  const cal2 = await call(`/calendar/events?month=${monthOf(shiftDays(0))}`, tok1);
  const taskEvent = (cal2.body?.events ?? []).find(
    (e: any) => String(e.label).includes("Bookprobe seal the export manifest"));
  check("the calendar's task event opens the transport register",
    taskEvent?.href === "/app/cfa/cargo?book=transport", JSON.stringify(taskEvent));
  const calCargo = (calEvents ?? []).filter((e: any) => String(e.href).includes("/app/cfa/cargo"));
  check("no calendar cargo event opens the default register",
    calCargo.length > 0 && calCargo.every((e: any) => String(e.href).includes("book=")),
    JSON.stringify(calCargo.map((e: any) => `${e.type}→${e.href}`)));

  // ---------- 7. A foreign tenant sees neither the rows nor the counts ----------
  for (const p of ["/cargo?book=clearing", "/cargo?book=transport", "/cargo/books", "/cargo"]) {
    const r = await call(p, tok2);
    const hay = JSON.stringify(r.body ?? "");
    const leaked = Object.values(ids).filter(x => x && hay.includes(x));
    check(`B reads ${p} with nothing of A's in it`,
      r.status === 200 && leaked.length === 0 && !hay.includes("Bookprobe Rice"),
      `[${r.status}] ${leaked.join(",")}`);
  }
  const bBooks = await call("/cargo/books", tok2);
  check("B's books both count zero",
    (bBooks.body?.books ?? []).every((b: any) => b.count === 0) && bBooks.body?.total === 0,
    JSON.stringify(bBooks.body));
  for (const p of [`/cargo/${ids.i1}`, `/cargo/${ids.e1}/tasks`]) {
    const r = await call(p, tok2, p.includes("tasks") ? post({ title: "Beta on Alpha's file" }) : {});
    check(`B probe ${p} rejected`, r.status === 404 || r.status === 403, `[${r.status}]`);
  }
  const bBadBook = await call("/cargo?book=clearing&shipmentType=export", tok2);
  check("the book/type mismatch is refused before any row is read",
    bBadBook.status === 400, `[${bBadBook.status}]`);

  // ---------- 8. A seat without the duty ----------
  for (const p of ["/cargo?book=clearing", "/cargo/books"]) {
    const r = await call(p, tokBare);
    check(`no-duty seat cannot read ${p}`, r.status === 403, `[${r.status}]`);
  }
  const anonBooks = await fetch(API + "/cargo/books");
  check("/cargo/books is not open to an anonymous caller", anonBooks.status === 401,
    `[${anonBooks.status}]`);

  // ---------- 9. SQL read-back ----------
  const sql = await oi(
    `select
       (select count(*) from cargo_shipments where tenant_id = $1 and deleted_at is null
         and shipment_type = any($3::text[]))::int as a_clearing,
       (select count(*) from cargo_shipments where tenant_id = $1 and deleted_at is null
         and shipment_type = any($4::text[]))::int as a_transport,
       (select count(*) from cargo_shipments where tenant_id = $1 and deleted_at is null)::int as a_all,
       (select count(*) from cargo_shipments where tenant_id = $1
         and deleted_at is not null)::int as a_soft_deleted,
       (select count(*) from cargo_shipments where tenant_id = $2)::int as b_rows,
       (select count(*) from cargo_shipments where tenant_id = $2
         and id = any($5::uuid[]))::int as b_holds_a,
       (select count(*) from cargo_tasks where tenant_id = $2
         and shipment_id = any($5::uuid[]))::int as b_tasks_on_a,
       (select count(*) from cargo_shipments where tenant_id = $1
         and shipment_type = 'import' and file_number not like '4%')::int as wrong_prefix,
       (select count(*) from cargo_shipments where tenant_id = $1
         and shipment_type = 'transhipment' and file_number not like '7%')::int as wrong_th7
     `, [T1, T2, CLEARING, TRANSPORT, Object.values(ids)]);
  const sq = sql.rows[0];
  check("SQL: the books hold 2 clearing and 3 transport files, 5 in all",
    sq.a_clearing === 2 && sq.a_transport === 3 && sq.a_all === 5, JSON.stringify(sq));
  check("SQL: the deleted file is soft-deleted, not gone",
    sq.a_soft_deleted === 1, `a_soft_deleted=${sq.a_soft_deleted}`);
  check("SQL: tenant B holds no row of this run",
    sq.b_rows === 0 && sq.b_holds_a === 0 && sq.b_tasks_on_a === 0, JSON.stringify(sq));
  check("SQL: every file number prefix matches the book it is listed in",
    sq.wrong_prefix === 0 && sq.wrong_th7 === 0, JSON.stringify(sq));

  // ---------- cleanup ----------
  for (const t of WIPE) await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [[T1, T2]]);
  await oi(wipeRoles, [[T1, T2]]);
  await oi(`delete from users where tenant_id = any($1::uuid[])`, [[T1, T2]]);
  await oi(`delete from tenants where id = any($1::uuid[])`, [[T1, T2]]);
  const residue = await oi(
    `select (select count(*) from cargo_shipments where tenant_id = any($1::uuid[]))::int as s,
            (select count(*) from cargo_tasks where tenant_id = any($1::uuid[]))::int as k,
            (select count(*) from jobs where tenant_id = any($1::uuid[]))::int as j,
            (select count(*) from tenants where id = any($1::uuid[]))::int as t`, [[T1, T2]]);
  const re = residue.rows[0];
  check("cleanup: no probe rows left", re.s === 0 && re.k === 0 && re.j === 0 && re.t === 0,
    JSON.stringify(re));
  console.log(`\ncargo books smoke: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " FAILURES"}`);
  await owner.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
