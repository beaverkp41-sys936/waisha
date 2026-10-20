/**
 * End-to-end smoke for the cargo batch archive (#225) against a running API on :4000.
 *
 * A batch export is the one report that reads the database instead of the screen, so the
 * questions it has to answer are heavier than "did the file open": does every register
 * hung off the file arrive, do the stored documents arrive as the bytes that were
 * uploaded, does a folder name built from a file number stay inside the archive, is the
 * encrypted PII that sits in those same tables absent from every entry — and is the
 * archive readable by a program that has never met this writer?
 *
 * So the archive is opened by Info-ZIP's `unzip` (which checks every CRC), listed again
 * by Windows' own bsdtar, and its integrity re-computed by `sha256sum -c` against the
 * SHA256SUMS.txt inside it. Nothing here parses the ZIP format: every assertion below is
 * made against a tree an independent program extracted.
 *
 * The fixture is planted by SQL as the migration owner and torn down by the ids it minted,
 * but the documents go through the real upload endpoint, because an archive of cargo is
 * only worth checking if its bytes came out of Supabase Storage.
 *
 * Run: npx tsx scripts/smoke-cargo-batch.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";
import { Workbook } from "exceljs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const TMP = path.resolve("tmp-cargo-batch-smoke");
const ARCHIVE = path.join(TMP, "batch.zip");
const OUT = path.join(TMP, "out");

const STAMP = Date.now().toString().slice(-8);
const FILE_A = `ZIP-${STAMP}`;
const FILE_B = `ZIP-${STAMP}-B`;
const CONSIGNEE = `Batch Smoke Consignee ${STAMP}`;
/** Planted into every encrypted, hashed and identity column the bundle tables hold. */
const PII = `PII-NEVER-PRINTED-${STAMP}`;
const BILL = 512345.67;
const COST = 1000.5;
const ETA = "2026-11-05";
const payload = (label: string) =>
  Buffer.from(`%PDF-1.4\n${label} of ${FILE_A} ${STAMP}\n%%EOF\n`, "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

/** Run an outside program. The archive is judged by these, never by this script. */
function sh(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.error) throw new Error(`${cmd} could not run: ${r.error.message}`);
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** One sheet as lines of strings; blank lines are never read, so indices are relative. */
type Sheet = string[][];
/** The lines under a sheet's header, split at its totals line when it has one. */
function underHeader(sheet: Sheet): { head: string[]; data: Sheet; totals: string[] | null } {
  const at = sheet.findIndex((r) => ["ID", "Path in archive", "File number"].includes(String(r[0])));
  if (at < 0) return { head: [], data: [], totals: null };
  const after = sheet.slice(at + 1);
  const last = after[after.length - 1] ?? [];
  const totals = /^Total \(\d+ rows\)$/.test(String(last[0] ?? "")) ? last : null;
  return { head: sheet[at], data: totals ? after.slice(0, -1) : after, totals };
}
const sourceTableOf = (sheet: Sheet): string => {
  const line = sheet.find((r) => String(r[0] ?? "").startsWith("Source table: "));
  return String(line?.[0] ?? "").replace("Source table: ", "");
};

async function main() {
  const startedAt = Date.now();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const owner = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL,
    ssl: { rejectUnauthorized: false } });
  await owner.connect();
  const oi = (sql: string, p: unknown[] = []) => owner.query(sql, p as any[]);

  const who = await oi(
    "select u.id, u.tenant_id, u.full_name from users u" +
    " join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id" +
    " where r.key = 'director' and u.deleted_at is null" +
    " and u.tenant_id = (select tenant_id from cargo_shipments where deleted_at is null" +
    "   order by created_at desc limit 1) limit 1");
  if (!who.rowCount) throw new Error("no director seat on hand — seed the sweep fixture first");
  const { id: userId, tenant_id: tid, full_name: fullName } = who.rows[0];

  const mint = (sub: string, role: string) => new SignJWT({ tid, sid: randomUUID(), typ: role, roles: [role] })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("20m").sign(key);
  const token = await mint(userId, "director");
  const auth = (tok: string | null): Record<string, string> =>
    tok ? { Authorization: `Bearer ${tok}` } : {};
  console.log(`seat ${fullName} tenant ${tid} files ${FILE_A} + ${FILE_B}`);

  // Another company's file: the batch must not be able to reach it. Planted rather than
  // hunted for, because a database holding only one cargo tenant still has to prove this.
  const otherTenant = (await oi("select id from tenants where id <> $1 limit 1", [tid]))
    .rows[0]?.id as string | undefined;
  const foreignId = otherTenant ? randomUUID() : undefined;

  // --- plant ------------------------------------------------------------------------------
  const F = { a: randomUUID(), b: randomUUID(), task1: randomUUID(), task2: randomUUID(),
    job: randomUUID(), stage1: randomUUID(), stage2: randomUUID(), activity: randomUUID(),
    handover: randomUUID(), jobDoc: randomUUID(), message: randomUUID(),
    quotation: randomUUID(), item1: randomUUID(), item2: randomUUID(), cost: randomUUID() };
  const seq = 4_000_000 + Math.floor(Math.random() * 90_000);

  const SHIPMENT = `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year,
      shipment_type, container_type, consignee_name, consignor_name, cargo_description,
      weight_tonnes, eta, stage, status, payment_amount, processing_cost, notes,
      created_by, updated_by)
    values ($1,$2,$3,$4,$5,'import','40ft',$6,$7,$8,12.5,$9,'customs','open',$10,$11,$12,$13,$13)`;
  await oi(SHIPMENT, [F.a, tid, FILE_A, seq, 2026, CONSIGNEE, "Batch Smoke Consignor",
    "Machine spare parts", ETA, BILL, COST, `planted by smoke-cargo-batch ${STAMP}`, userId]);
  await oi(SHIPMENT, [F.b, tid, FILE_B, seq + 1, 2026, "Second Batch Consignee",
    "Batch Smoke Consignor", "Bagged cement", ETA, null, null, "second file of the batch", userId]);
  // The other company's own file, in its own tenant, planted so the gate has something
  // real to refuse.
  if (otherTenant) {
    await oi(SHIPMENT, [foreignId, otherTenant, `ZIP-FOREIGN-${STAMP}`, seq + 2, 2026,
      "Another Company Consignee", "Another Company Consignor", "A file that is not ours",
      ETA, null, null, `planted by smoke-cargo-batch ${STAMP} to prove the gate`, userId]);
  }
  const planted = [F.a, F.b, foreignId].filter(Boolean) as string[];

  await oi("insert into jobs (id, tenant_id, shipment_id, notes, created_by, updated_by) " +
    "values ($1,$2,$3,$4,$5,$5)", [F.job, tid, F.a, `job opened for ${FILE_A}`, userId]);
  for (const [stageId, stageKey, name, position] of [
    [F.stage1, "customs", "Customs assessment", 4],
    [F.stage2, "release", "Release from the terminal", 5]]) {
    await oi("insert into job_stages (id, tenant_id, job_id, shipment_id, stage_key, name, " +
      "position, status) values ($1,$2,$3,$4,$5,$6,$7,'in_progress')",
      [stageId, tid, F.job, F.a, stageKey, name, position]);
  }
  for (const [taskId, title, stageId] of [
    [F.task1, "Verify the declaration", F.stage1], [F.task2, "Pay the duty", null]]) {
    await oi("insert into cargo_tasks (id, tenant_id, shipment_id, title, assigned_to, " +
      "stage_id, status) values ($1,$2,$3,$4,$5,$6,'pending')",
      [taskId, tid, F.a, title, userId, stageId]);
  }
  await oi("insert into job_activity (id, tenant_id, job_id, shipment_id, actor_user_id, " +
    "actor_role, action, summary) values ($1,$2,$3,$4,$5,'director','stage.started',$6)",
    [F.activity, tid, F.job, F.a, userId, `Opened ${FILE_A} for the batch smoke`]);
  // The one bundle column that holds an identity document: it must not move.
  await oi("insert into job_handovers (id, tenant_id, job_id, shipment_id, received_by_name, " +
    "received_by_id_number, method) values ($1,$2,$3,$4,$5,$6,'signature')",
    [F.handover, tid, F.job, F.a, "Originals counter", PII]);

  await oi("insert into quotations (id, tenant_id, quotation_number, customer_name, " +
    "customer_phone_encrypted, customer_phone_search, shipment_id, trade_type, notes, " +
    "created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,'import',$8,$9,$9)",
    [F.quotation, tid, `ZIPQ-${STAMP}`, CONSIGNEE, PII, PII, F.a,
      `proforma raised for ${FILE_A}`, userId]);
  for (const [itemId, section, description, amount] of [
    [F.item1, "statutory", "Import declaration fee", 80_000],
    [F.item2, "port", "Handling at the terminal", 145_000]]) {
    await oi("insert into quotation_items (id, tenant_id, quotation_id, seq, section, " +
      "description, amount, total) values ($1,$2,$3,$4,$5,$6,$7,$7)",
      [itemId, tid, F.quotation, itemId === F.item1 ? 1 : 2, section, description, amount]);
  }
  await oi("insert into office_costs (id, tenant_id, cost_date, category, description, amount, " +
    "shipment_id, created_by, updated_by) values ($1,$2,'2026-10-01','transport',$3,$4,$5,$6,$6)",
    [F.cost, tid, `Trucking for ${FILE_A}`, 250_000, F.a, userId]);
  await oi("insert into messages (id, tenant_id, shipment_id, body, created_by) " +
    "values ($1,$2,$3,$4,$5)",
    [F.message, tid, F.a, `Arrival notice for ${FILE_A} — the consignee asked for the originals`, userId]);

  // --- the documents, through the real upload path -----------------------------------------
  async function upload(entityType: string, entityId: string, kind: string,
    fileName: string, bytes: Buffer): Promise<string> {
    const fd = new FormData();
    // Metadata before the file part: the API reads multipart fields in stream order.
    fd.append("entityType", entityType);
    fd.append("entityId", entityId);
    fd.append("kind", kind);
    fd.append("file", new Blob([bytes], { type: "application/pdf" }), fileName);
    const res = await fetch(`${API}/documents`, { method: "POST", headers: auth(token), body: fd });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.id) {
      throw new Error(`upload ${kind}/${fileName} answered ${res.status} ${JSON.stringify(j)}`);
    }
    return String(j.id);
  }

  const bl1 = payload("bill of lading");
  const bl2 = payload("bill of lading, the second copy that shares its name");
  const quote = payload("the proforma as issued");
  const receipt = payload("the trucking receipt");
  const note = payload("a page of the thread");
  const docIds = {
    bl1: await upload("shipment", F.a, "bill_of_lading", "manifest-a.pdf", bl1),
    bl2: await upload("shipment", F.a, "bill_of_lading", "manifest-a.pdf", bl2),
    quote: await upload("quotation", F.quotation, "proforma", "quote.pdf", quote),
    receipt: await upload("office_cost", F.cost, "invoice", "receipt.pdf", receipt),
    note: await upload("message", F.message, "attachment", "note.pdf", note)
  };
  // The clearing register points at a stored document — which is how a file's originals
  // reach the archive without the register itself holding any bytes.
  await oi("insert into job_documents (id, tenant_id, job_id, shipment_id, title, kind, " +
    "direction, status, document_id, created_by, updated_by) " +
    "values ($1,$2,$3,$4,$5,'bill_of_lading','received','received',$6,$7,$7)",
    [F.jobDoc, tid, F.job, F.a, "Original bill of lading", docIds.bl1, userId]);

  const folderA = `${FILE_A}-${F.a.slice(0, 8)}`;
  const folderB = `${FILE_B}-${F.b.slice(0, 8)}`;
  const expected = new Map<string, Buffer>([
    ["bill_of_lading-manifest-a.pdf", bl1],
    ["bill_of_lading-manifest-a (2).pdf", bl2],
    ["quotation-proforma-quote.pdf", quote],
    ["office_cost-invoice-receipt.pdf", receipt],
    ["message-attachment-note.pdf", note]
  ]);

  // --- the archive -------------------------------------------------------------------------
  const call = async (body: unknown, tok: string | null = token) => {
    const res = await fetch(`${API}/exports/cargo-batch`, {
      method: "POST", headers: { "Content-Type": "application/json", ...auth(tok) },
      body: JSON.stringify(body)
    });
    return res;
  };

  const res = await call({ ids: [F.a, F.b, F.a] });
  const zipType = res.headers.get("content-type") ?? "";
  check("the batch answers as a zip, not JSON", res.ok && zipType.includes("application/zip"),
    { status: res.status, zipType, body: res.ok ? "" : (await res.text()).slice(0, 200) });
  const disposition = res.headers.get("content-disposition") ?? "";
  check("the download is named for the day it was packed",
    /^attachment; filename="cargo-files-\d{4}-\d{2}-\d{2}\.zip"$/.test(disposition), disposition);
  check("a streamed archive is not sniffable and not cacheable",
    res.headers.get("x-content-type-options") === "nosniff"
    && res.headers.get("cache-control") === "no-store",
    { nosniff: res.headers.get("x-content-type-options"), cache: res.headers.get("cache-control") });

  const bytes = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(ARCHIVE, bytes);
  check("the bytes are a zip", bytes.subarray(0, 2).toString("latin1") === "PK",
    bytes.subarray(0, 4).toString("hex"));

  const tested = sh("unzip", ["-t", "batch.zip"], TMP);
  check("Info-ZIP finds no CRC error in the archive", tested.ok && /No errors detected/.test(tested.out),
    tested.out.slice(0, 240));
  const listed = sh("unzip", ["-Z1", "batch.zip"], TMP).out.split(/\r?\n/).filter(Boolean);
  check("every document landed under its own entry name",
    [...expected.keys()].every((n) => listed.includes(`${folderA}/documents/${n}`)), listed);
  check("a duplicate name became a second entry instead of overwriting the first",
    listed.some((n) => n.endsWith("bill_of_lading-manifest-a.pdf"))
    && listed.some((n) => n.endsWith("bill_of_lading-manifest-a (2).pdf")), listed);
  check("nothing escaped the folder it was given",
    listed.every((n) => !n.startsWith("/") && !n.includes("..")),
    listed.filter((n) => n.startsWith("/") || n.includes("..")));

  const extracted = sh("unzip", ["-qq", "-o", "batch.zip", "-d", "out"], TMP);
  check("Info-ZIP extracted the tree", extracted.ok, extracted.out.slice(0, 240));
  const bsdtar = sh("C:/Windows/System32/tar.exe", ["-tf", "batch.zip"], TMP);
  check("Windows' own archive reader lists the same archive",
    bsdtar.ok && bsdtar.out.split(/\r?\n/).filter(Boolean).length >= listed.length,
    bsdtar.out.slice(0, 200));
  const sums = sh("sha256sum", ["-c", "SHA256SUMS.txt"], OUT);
  check("every entry matches the SHA256SUMS.txt inside the archive", sums.ok, sums.out.slice(0, 320));

  const dirA = path.join(OUT, folderA);
  const dirB = path.join(OUT, folderB);
  const readText = (p: string) => fs.readFileSync(p, "utf8");
  check("each file gets a folder of its own, with a readme, a record and a workbook",
    [dirA, dirB].every((d) => ["README.txt", "record.json", "cargo-file.xlsx"]
      .every((n) => fs.existsSync(path.join(d, n))))
    && fs.existsSync(path.join(OUT, "README.txt"))
    && fs.existsSync(path.join(OUT, "batch-register.xlsx")), fs.readdirSync(OUT));
  check("a file with no documents gets no empty documents folder",
    !fs.existsSync(path.join(dirB, "documents")) && fs.existsSync(path.join(dirA, "documents")),
    fs.readdirSync(dirB));

  for (const [name, source] of expected) {
    const onDisk = fs.readFileSync(path.join(dirA, "documents", name));
    check(`the stored ${name} is byte-for-byte the upload`, onDisk.equals(source),
      { onDisk: onDisk.length, uploaded: source.length });
  }

  // --- record.json -------------------------------------------------------------------------
  const record = JSON.parse(readText(path.join(dirA, "record.json")));
  check("the record names the file, the seat and the moment",
    record.file_number === FILE_A && record.shipment_id === F.a
    && record.generated_by === fullName && /^\d{4}-\d{2}-\d{2}T/.test(String(record.generated_at)),
    { file: record.file_number, by: record.generated_by });
  const wantRows: Record<string, number> = {
    cargo_shipments: 1, cargo_tasks: 2, jobs: 1, job_stages: 2, job_activity: 1,
    job_handovers: 1, job_documents: 1, messages: 1, quotations: 1, quotation_items: 2,
    office_costs: 1
  };
  const gotRows = Object.fromEntries(Object.entries(record.registers ?? {})
    .map(([t, r]) => [t, (r as unknown[]).length]));
  check("every register hung off the file is in the record, with its rows",
    Object.entries(wantRows).every(([t, n]) => gotRows[t] === n), { wantRows, gotRows });
  check("a register this file never used is absent rather than an empty sheet",
    !("office_tasks" in gotRows) && !("transport_requests" in gotRows)
    && !("consolidation_parcels" in gotRows), Object.keys(gotRows));

  const shipped = (record.registers.cargo_shipments as any[])[0];
  check("the money and the calendar day survive as they were filed",
    Number(shipped.payment_amount) === BILL && Number(shipped.processing_cost) === COST
    && shipped.eta === ETA, { pay: shipped.payment_amount, cost: shipped.processing_cost, eta: shipped.eta });
  const costed = (record.registers.office_costs as any[])[0];
  check("a cost line arrives filed against the same file and with its figure whole",
    costed.shipment_id === F.a && costed.category === "transport" && Number(costed.amount) === 250_000,
    costed);
  const taskRows = record.registers.cargo_tasks as any[];
  check("an id the database declares a link for is printed beside the row it points at",
    taskRows[0].assigned_to_name === fullName
    && taskRows[0].stage_id_name === "Customs assessment"
    && taskRows[0].shipment_id_name === undefined, { row: taskRows[0] });
  const threaded = (record.registers.messages as any[])[0];
  check("an id the database declares no link for is left as an id rather than guessed at",
    !("created_by_name" in threaded) && typeof threaded.created_by === "string",
    Object.keys(threaded));
  const paths = (record.documents ?? []).map((d: any) => String(d.path_in_archive));
  check("the record lists each document at the path it was really written to",
    paths.length === expected.size && new Set(paths).size === paths.length
    && paths.every((p) => fs.existsSync(path.join(OUT, p)))
    && paths.some((p) => p.endsWith("(2).pdf"))
    && record.documents.every((d: any) => d.in_archive === true && d.size_bytes > 0),
    { paths, docs: record.documents });

  const withheld = record.withheld_columns ?? {};
  check("the record says which columns were withheld, and out of which tables",
    (withheld.job_handovers ?? []).includes("received_by_id_number")
    && (withheld.quotations ?? []).includes("customer_phone_encrypted")
    && (withheld.quotations ?? []).includes("customer_phone_search"), withheld);
  const readmeA = readText(path.join(dirA, "README.txt"));
  check("the readme repeats the withheld names, so the absence explains itself",
    readmeA.includes("customer_phone_encrypted") && readmeA.includes("never read out"), readmeA.slice(-260));

  // The API's connection holds BYPASSRLS, so each register's own tenant column is the
  // only thing scoping its read. A register added to the bundle without one exports
  // nothing (readCargoBundle refuses it) — and this says which tables that would be.
  const registerTables = Object.keys(record.registers ?? {});
  const scoped = await oi(
    "select table_name, bool_or(column_name = 'tenant_id') as has_tenant" +
    " from information_schema.columns where table_schema = 'public' and table_name = any($1::text[])" +
    " group by table_name", [registerTables]);
  check("every register the archive read carries the tenant column its SQL scopes on",
    scoped.rowCount === registerTables.length
    && scoped.rows.every((r: any) => r.has_tenant === true),
    scoped.rows.filter((r: any) => r.has_tenant !== true));

  // The PII planted in the encrypted, hashed and identity columns must be nowhere.
  const tree: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else tree.push(p);
    }
  };
  walk(OUT);
  const leaks = tree.filter((p) => !p.endsWith(".xlsx")).filter((p) => readText(p).includes(PII));
  check("the planted NIDA and phone material appears in no entry", leaks.length === 0, leaks);

  // --- the workbooks ------------------------------------------------------------------------
  async function sheetsOf(file: string): Promise<Map<string, Sheet>> {
    const wb = new Workbook();
    await wb.xlsx.load(fs.readFileSync(file) as any);
    const out = new Map<string, Sheet>();
    for (const ws of wb.worksheets) {
      const rows: Sheet = [];
      ws.eachRow((row) => rows.push(row.values.slice(1).map((v) => String(v ?? ""))));
      out.set(ws.name, rows);
    }
    return out;
  }
  const wbA = await sheetsOf(path.join(dirA, "cargo-file.xlsx"));
  check("one sheet per register, plus a sheet for the documents",
    wbA.size === Object.keys(gotRows).length + 1, [...wbA.keys()]);
  const perTable = new Map([...wbA.values()].map((s) => [sourceTableOf(s), s]));
  check("each sheet says which table it came from",
    Object.keys(gotRows).every((t) => perTable.has(t)), Object.keys(gotRows).filter((t) => !perTable.has(t)));
  check("every sheet carries the same rows the record holds",
    Object.entries(gotRows).every(([t, n]) => {
      const s = underHeader(perTable.get(t) ?? []);
      return s.head.length > 0 && s.data.length === n
        && (s.totals === null || s.totals[0] === `Total (${n} rows)`);
    }), Object.entries(gotRows).map(([t, n]) => [t, underHeader(perTable.get(t) ?? []).data.length, n]));

  const shipment = underHeader(perTable.get("cargo_shipments") ?? []);
  const payCol = shipment.head.indexOf("Payment amount");
  const costCol = shipment.head.indexOf("Processing cost");
  check("the billed figure is a number on the sheet and in its totals line",
    payCol > 0 && Number(shipment.data[0]?.[payCol]) === BILL
    && Number(shipment.totals?.[payCol]) === BILL, { payCol, row: shipment.data[0] });
  check("the second money column is carried and totalled too",
    costCol > 0 && Number(shipment.data[0]?.[costCol]) === COST
    && Number(shipment.totals?.[costCol]) === COST, { costCol, row: shipment.data[0] });
  const tasks = underHeader(perTable.get("cargo_tasks") ?? []);
  const assigned = tasks.head.indexOf("Assigned to");
  check("the register prints the seat's name beside the id that points at it",
    assigned > 0 && tasks.head[assigned + 1] === "Assigned to name"
    && tasks.data[0]?.[assigned + 1] === fullName, { head: tasks.head, row: tasks.data[0] });

  const docsSheet = underHeader(wbA.get("Documents") ?? []);
  const entryCol = docsSheet.head.indexOf("Path in archive");
  const shaCol = docsSheet.head.indexOf("SHA-256");
  const inCol = docsSheet.head.indexOf("In this archive");
  const entries = docsSheet.data.map((r) => r[entryCol]);
  const shaByName = new Map(docsSheet.data.map((r) => [r[entryCol], r[shaCol]]));
  const realSha = (name: string) => createHash("sha256")
    .update(fs.readFileSync(path.join(dirA, "documents", name))).digest("hex");
  check("the documents sheet states the checksum of the bytes it points at",
    entryCol >= 0 && shaCol > 0 && inCol > 0
    && new Set(entries).size === entries.length
    && entries.every((e) => docsSheet.data.some((r) => r[inCol] === "true" && r[entryCol] === e))
    && [...expected.keys()].every((n) => shaByName.get(`${folderA}/documents/${n}`) === realSha(n)),
    { head: docsSheet.head, entries, shaCol, inCol });

  const batchWb = await sheetsOf(path.join(OUT, "batch-register.xlsx"));
  const batch = underHeader([...batchWb.values()][0] ?? []);
  check("the batch register lists both files with what each one holds",
    batch.data.length === 2 && batch.data[0][0] === FILE_A && batch.data[1][0] === FILE_B
    && batch.data[0].includes(String(expected.size)) && batch.data[1].includes("0"),
    batch.data);

  const wbLeaks: string[] = [];
  for (const [file, sheets] of [
    [path.join(dirA, "cargo-file.xlsx"), wbA],
    [path.join(dirB, "cargo-file.xlsx"), await sheetsOf(path.join(dirB, "cargo-file.xlsx"))],
    [path.join(OUT, "batch-register.xlsx"), batchWb]]) {
    for (const [name, rows] of sheets as Map<string, Sheet>) {
      if (rows.some((r) => r.some((v) => v.includes(PII)))) wbLeaks.push(`${file}#${name}`);
    }
  }
  check("no sheet of any workbook in the archive carries the planted PII", wbLeaks.length === 0, wbLeaks);

  const rootReadme = readText(path.join(OUT, "README.txt"));
  check("the root readme counts the files it holds after the duplicate id was dropped",
    /2 of 2 requested file\(s\)/.test(rootReadme) && rootReadme.includes(FILE_A)
    && rootReadme.includes(FILE_B), rootReadme.slice(0, 300));
  // The manifest is a list of folders, not a copy of the registers: the second copy of
  // the archive is the one that carries the customers, and it stays inside the tenant.
  check("the manifest names files and counts, not the people on them",
    !rootReadme.includes(CONSIGNEE) && new RegExp(`${FILE_A}.*5 document\\(s\\)`).test(rootReadme)
    && new RegExp(`${FILE_B}.*0 document\\(s\\)`).test(rootReadme),
    rootReadme.slice(120, 460));
  check("the root readme tells the reader how to check the archive",
    rootReadme.includes("sha256sum -c SHA256SUMS.txt"), undefined);

  // --- the gates ----------------------------------------------------------------------------
  const noToken = await call({ ids: [F.a] }, null);
  check("no token, no archive", noToken.status === 401, noToken.status);

  const denied = await call({ ids: [F.a] }, await mint("00000000-0000-4000-8000-0000000000ff", "trainee"));
  check("a seat without the export duty is refused before a byte exists", denied.status === 403,
    { status: denied.status, body: (await denied.text()).slice(0, 160) });

  if (foreignId) {
    const stranger = await call({ ids: [foreignId] });
    const said = (await stranger.text()).slice(0, 160);
    check("another company's file is not on this desk, so nothing is exported",
      stranger.status === 404 && !said.includes(FILE_A), { status: stranger.status, said });
    const mixed = await call({ ids: [F.a, foreignId] });
    const mixedBytes = Buffer.from(await mixed.arrayBuffer());
    // One foreign id in a selection of otherwise-legal files must stop the whole batch:
    // a partial archive would read as a complete one to whoever opened it.
    check("a foreign id in a legal batch is refused before a byte is written",
      mixed.status === 404 && mixedBytes.subarray(0, 2).toString("latin1") !== "PK",
      { status: mixed.status, head: mixedBytes.subarray(0, 4).toString("hex"),
        body: mixedBytes.toString("utf8").slice(0, 120) });
  } else {
    check("a second company was planted for the cross-tenant gate", false, { otherTenant });
  }

  const tooMany = await call({ ids: Array.from({ length: 26 }, () => F.a) });
  check("26 files in one batch are refused", tooMany.status === 400,
    { status: tooMany.status, body: (await tooMany.text()).slice(0, 160) });
  const nothing = await call({ ids: [] });
  check("an empty selection is refused", nothing.status === 400, nothing.status);
  const junk = await call({ ids: ["not-a-uuid"] });
  check("an id that is not an id is refused", junk.status === 400, junk.status);

  // --- the audit trail ------------------------------------------------------------------------
  const audit = await oi(
    "select action, entity, entity_id, after from audit_logs where tenant_id = $1" +
    " and entity = 'report_exports' and action = 'export.zip' order by ts desc limit 1", [tid]);
  const a: any = audit.rows[0]?.after ?? {};
  check("the packed archive is on the record", audit.rowCount === 1, audit.rowCount);
  check("the audit row names the batch, not its contents",
    Object.keys(a).sort().join(",") === "aborted,bytes,documents_skipped,entries,failure,files,report,requested",
    Object.keys(a));
  check("the log says what was actually written",
    a.files === 2 && a.requested === 2 && a.entries === listed.length && a.bytes === bytes.length
    && a.aborted === false && a.documents_skipped === 0 && a.failure === null,
    { log: a, entries: listed.length, bytes: bytes.length });
  check("no business record is stuffed into the entity_id of an export row",
    audit.rows[0]?.entity_id === null, audit.rows[0]?.entity_id);
  check("the consignee's name was not copied into the log", !JSON.stringify(a).includes(CONSIGNEE), undefined);

  // --- teardown -------------------------------------------------------------------------------
  for (const id of Object.values(docIds)) {
    const del = await fetch(`${API}/documents/${id}`, { method: "DELETE", headers: auth(token) });
    if (!del.ok) console.log(`note   document ${id} delete answered ${del.status}`);
  }
  const teardown: [string, string, unknown[]][] = [
    ["job_documents", "delete from job_documents where id = $1", [F.jobDoc]],
    ["documents", "delete from documents where id = any($1::uuid[])", [Object.values(docIds)]],
    ["quotation_items", "delete from quotation_items where id = any($1::uuid[])", [[F.item1, F.item2]]],
    ["quotations", "delete from quotations where id = $1", [F.quotation]],
    ["office_costs", "delete from office_costs where id = $1", [F.cost]],
    ["messages", "delete from messages where id = $1", [F.message]],
    ["job_handovers", "delete from job_handovers where id = $1", [F.handover]],
    ["job_activity", "delete from job_activity where id = $1", [F.activity]],
    ["cargo_tasks", "delete from cargo_tasks where id = any($1::uuid[])", [[F.task1, F.task2]]],
    ["job_stages", "delete from job_stages where id = any($1::uuid[])", [[F.stage1, F.stage2]]],
    ["jobs", "delete from jobs where id = $1", [F.job]],
    ["cargo_shipments", "delete from cargo_shipments where id = any($1::uuid[])", [planted]]
  ];
  for (const [name, sql, p] of teardown) {
    const r = await oi(sql, p);
    console.log(`tore down ${name}: ${r.rowCount} row(s)`);
  }
  const residue = await oi(
    "select (select count(*) from cargo_shipments where id = any($1::uuid[]))::int as files," +
    " (select count(*) from jobs where id = $2)::int as jobs," +
    " (select count(*) from quotations where id = $3)::int as quotations," +
    " (select count(*) from cargo_shipments where tenant_id = $4 and created_at > $5)::int as new_files," +
    " (select count(*) from cargo_shipments where tenant_id = $6 and created_at > $5)::int as foreign_files",
    [planted, F.job, F.quotation, tid, new Date(startedAt), otherTenant]);
  check("the fixture left no business row behind",
    Object.values(residue.rows[0]).every((n) => Number(n) === 0), residue.rows[0]);

  await owner.end();
  console.log(`\narchive ${bytes.length} bytes, ${listed.length} entries, extracted to ${OUT}`);
  console.log(failures === 0 ? "cargo batch smoke clean" : `${failures} FAILED CHECK(S)`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
