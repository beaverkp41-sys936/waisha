/**
 * End-to-end smoke for POST /exports/cargo-file (#285) against a running API on :4000.
 *
 * One cargo file, every register this platform holds on it, in Excel and as a printed book.
 * The questions this has to answer are the ones an auditor asks a pile of paper: did every
 * entity arrive (a checklist tick three desks away counts as much as the shipment row), did
 * only this file's entities arrive, is a cancelled invoice absent, is the money still money,
 * is the encrypted PII that sits in these same tables nowhere in the answer — and does the
 * printed page say the same file number the desk shows?
 *
 * The fixture plants its own two companies, its own director and its own clerk seat that
 * deliberately lacks the export duty, then plants the whole graph by SQL as the migration
 * owner and tears it down by tenant id. Decoys are planted on purpose: an invoice raised on
 * another file's proforma, an invoice with no proforma behind it, a cancelled invoice, a
 * second master sheet on a second file. Each one is a row a sloppy chain walk would pick up.
 *
 * Run: npx tsx scripts/smoke-cargo-file.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";
import { Workbook } from "exceljs";
import { randomUUID } from "node:crypto";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const COMPANY = `File Smoke ${STAMP}`;
const STRANGER = `File Stranger ${STAMP}`;
const FILE_A = `CF-${STAMP}`;          // the file being exported
const FILE_E = `CF-${STAMP}-E`;        // a second file of the same company: decoy parent
const FILE_X = `CF-${STAMP}-X`;        // deleted file
const FILE_F = `CF-FOREIGN-${STAMP}`;  // another company's file

const CONSIGNEE = `File Smoke Consignee ${STAMP}`;
const PII = `PII-NOT-ON-PAPER-${STAMP}`;
const SHIP_BILL = 1234567.89;
const INV_TOTAL = 777777.55;
const INV_LINE = 500000.5;
const DN_TOTAL = 90000.25;
const PAYMENT = 250000;
const INV_NO = `CF-INV-${STAMP}`;
const INV_E_NO = `CF-INVE-${STAMP}`;
const INV_LOOSE_NO = `CF-INVFREE-${STAMP}`;
const INV_DEAD_NO = `CF-INVDEAD-${STAMP}`;
const DN_NO = `CF-DN-${STAMP}`;
const DN_E_NO = `CF-DNE-${STAMP}`;
const MASTER_PL = `PL-CF-${STAMP}`;
const MASTER_E_PL = `PL-CFE-${STAMP}`;
const DRAFT_REF = `DEC-${STAMP}`;
const DRAFT_E_REF = `DECE-${STAMP}`;
const QUOTE_A = `CFQ-${STAMP}`;
const QUOTE_E = `CFQE-${STAMP}`;
const TASK_TITLE = "Deliver the originals to the yard";
const TASK_E_TITLE = "File the other week's declaration";
const STEP_NAME = "Duty paid at the border";
const CHECK_LABEL = "Revenue receipt keyed";
const CHECK_E_LABEL = "Other file ticked";
const DOC_ONE = "clearing-licence.pdf";
const DOC_TWO = "delivery-note.pdf";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

/** One sheet as lines of strings. */
type Sheet = string[][];
/**
 * The lines under a sheet's header, split at its totals line when it has one.
 *
 * The header is found from the "Generated …" line the writer puts above it rather than
 * from a list of labels, because a register's first column is whatever the table happens
 * to start with — `id`, `tenant_id`, `invoice_number` — and `humanize` leaves the second
 * word of `tenant_id` in lower case. A list of expected labels would be a second source
 * of truth about a sheet the writer already describes.
 */
function underHeader(sheet: Sheet): { head: string[]; data: Sheet; totals: string[] | null } {
  const at = sheet.findIndex((r) => String(r[0] ?? "").startsWith("Generated "));
  if (at < 0) return { head: [], data: [], totals: null };
  const rest = sheet.slice(at + 1).filter((r) => r.some((v) => v !== ""));
  const head = rest.shift() ?? [];
  const last = rest[rest.length - 1] ?? [];
  const totals = /^Total \(\d+ rows\)$/.test(String(last[0] ?? "")) ? last : null;
  return { head, data: totals ? rest.slice(0, -1) : rest, totals };
}
const sourceTableOf = (sheet: Sheet): string => {
  const line = sheet.find((r) => String(r[0] ?? "").startsWith("Source table: "));
  return String(line?.[0] ?? "").replace("Source table: ", "");
};

/**
 * Every page of the book, read by pdfjs.
 *
 * The API's own reader stops at eight pages because it is reading a scanned document, not
 * auditing a book; this one has to see the last register to know it was printed.
 */
async function printedPages(bytes: Buffer): Promise<{ lines: string[]; pageCount: number }> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false
  }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent({ includeMarkedContent: false });
    let current = "";
    for (const item of content.items as any[]) {
      if (typeof item.str !== "string") continue;
      current += item.str;
      if (item.hasEOL) {
        const line = current.replace(/\s+/g, " ").trim();
        if (line) lines.push(line);
        current = "";
      }
    }
    const tail = current.replace(/\s+/g, " ").trim();
    if (tail) lines.push(tail);
  }
  await doc.destroy().catch(() => undefined);
  return { lines, pageCount: doc.numPages };
}

async function main() {
  const startedAt = new Date();
  const owner = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL,
    ssl: { rejectUnauthorized: false } });
  await owner.connect();
  const oi = (sql: string, p: unknown[] = []) => owner.query(sql, p as any[]);

  const T = randomUUID();
  const T2 = randomUUID();

  /** Every row a company of this run's shape could hold, then the company itself. */
  async function sweep(at: string) {
    for (const sql of [
      "delete from debit_note_items where tenant_id = $1",
      "delete from debit_notes where tenant_id = $1",
      "delete from freight_invoice_items where tenant_id = $1",
      "delete from freight_invoice_payments where tenant_id = $1",
      "delete from billing_documents where tenant_id = $1",
      "delete from freight_invoices where tenant_id = $1",
      "delete from quotation_items where tenant_id = $1",
      "delete from quotations where tenant_id = $1",
      "delete from office_task_step_checks where tenant_id = $1",
      "delete from office_task_steps where tenant_id = $1",
      "delete from office_tasks where tenant_id = $1",
      "delete from employees where tenant_id = $1",
      "delete from cargo_import_masters where tenant_id = $1",
      "delete from cargo_intake_drafts where tenant_id = $1",
      "delete from job_documents where tenant_id = $1",
      "delete from message_reads where tenant_id = $1",
      "delete from messages where tenant_id = $1",
      "delete from office_costs where tenant_id = $1",
      "delete from job_handovers where tenant_id = $1",
      "delete from job_activity where tenant_id = $1",
      "delete from cargo_tasks where tenant_id = $1",
      "delete from job_stages where tenant_id = $1",
      "delete from jobs where tenant_id = $1",
      "delete from documents where tenant_id = $1",
      "delete from cargo_shipments where tenant_id = $1",
      "delete from user_roles where user_id in (select id from users where tenant_id = $1)",
      "delete from sessions where user_id in (select id from users where tenant_id = $1)",
      "delete from roles where tenant_id = $1",
      "delete from users where tenant_id = $1",
      "delete from tenants where id = $1"
    ]) {
      await oi(sql, [at]).catch((e: any) => console.log(`teardown note: ${String(e.message).slice(0, 90)}`));
    }
  }

  // A run killed mid-flight leaves its companies behind with ids this run cannot know, so
  // they are found by the name the run stamped on them.
  const orphans = await oi("select id from tenants where name ~ '^File (Smoke|Stranger) [0-9]{8}$'");
  if (orphans.rowCount) {
    console.log(`sweeping ${orphans.rowCount} company(ies) left by an earlier run`);
    for (const r of orphans.rows) await sweep(r.id as string);
  }

  const roleOf = async (k: string) => {
    const r = await oi("select id from roles where key = $1 and tenant_id is null", [k]);
    if (!r.rowCount) throw new Error(`No global ${k} role — the seed is missing`);
    return r.rows[0].id as string;
  };
  const director = await roleOf("director");

  for (const [id, name] of [[T, COMPANY], [T2, STRANGER]] as [string, string][]) {
    await oi("insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')",
      [id, name]);
  }

  const uid: Record<string, string> = {};
  const seat = async (who: string, at: string, name: string, roleId: string) => {
    const u = await oi("insert into users (tenant_id, user_type, email, status, full_name)" +
      " values ($1,'staff',$2,'active',$3) returning id",
      [at, `${who}.cf.${STAMP}@${at.slice(0, 8)}.example.org`, name]);
    const id = u.rows[0].id as string;
    await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [id, roleId]);
    uid[who] = id;
    return id;
  };
  await seat("dir", T, "File Smoke Director", director);
  await seat("dir2", T2, "File Stranger Director", director);

  // A clerk of this company that may open the file and may not export it: the only honest
  // way to prove the duty gate is a seat whose role holds the view and leaves the export off.
  const clerkRole = (await oi("insert into roles (id, tenant_id, key, name, is_system)" +
    " values (gen_random_uuid(),$1,'file_smoke_clerk','File smoke clerk',false) returning id",
    [T])).rows[0].id as string;
  await oi("insert into role_permissions (role_id, permission_key) values ($1,'shipments.view')",
    [clerkRole]);
  await seat("clk", T, "File Smoke Clerk", clerkRole);

  const mint = (sub: string, role: string, at = T) =>
    new SignJWT({ tid: at, sid: randomUUID(), typ: role, roles: [role] })
      .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
      .setIssuedAt().setExpirationTime("20m").sign(key);
  const tok: Record<string, string> = {
    dir: await mint(uid.dir, "director"),
    dir2: await mint(uid.dir2, "director", T2),
    clk: await mint(uid.clk, "file_smoke_clerk")
  };
  const auth = (t: string | null): Record<string, string> => t ? { Authorization: `Bearer ${t}` } : {};
  console.log(`company ${COMPANY} file ${FILE_A} clerk seat without the export duty`);

  // --- the cargo files --------------------------------------------------------------------
  const F = { a: randomUUID(), e: randomUUID(), x: randomUUID(), foreign: randomUUID(),
    job: randomUUID(), stage: randomUUID(), task: randomUUID(), taskE: randomUUID(),
    activity: randomUUID(), handover: randomUUID(), jobDoc: randomUUID(),
    quoteA: randomUUID(), quoteE: randomUUID(), qItem: randomUUID(), qItemE: randomUUID(),
    invA: randomUUID(), invE: randomUUID(), invLoose: randomUUID(), invDead: randomUUID(),
    invLineA: randomUUID(), invLineA2: randomUUID(), invLineE: randomUUID(),
    payA: randomUUID(), payE: randomUUID(),
    dnA: randomUUID(), dnE: randomUUID(), dnLineA: randomUUID(), dnLineE: randomUUID(),
    emp: randomUUID(), otA: randomUUID(), otE: randomUUID(),
    stepA: randomUUID(), stepE: randomUUID(), checkA: randomUUID(), checkA2: randomUUID(),
    checkE: randomUUID(), masterA: randomUUID(), masterE: randomUUID(),
    draftA: randomUUID(), draftE: randomUUID(), batchA: randomUUID(), batchE: randomUUID(),
    message: randomUUID(), cost: randomUUID() };
  const seq = 4_000_000 + Math.floor(Math.random() * 90_000);

  const SHIPMENT = `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year,
      shipment_type, container_type, consignee_name, consignor_name, cargo_description,
      weight_tonnes, eta, stage, status, payment_amount, processing_cost, notes,
      created_by, updated_by)
    values ($1,$2,$3,$4,2026,'import','40ft',$5,$6,$7,12.5,'2026-11-05','customs','open',$8,$9,$10,$11,$11)`;
  await oi(SHIPMENT, [F.a, T, FILE_A, seq, CONSIGNEE, "File Smoke Consignor",
    "Machine spare parts", SHIP_BILL, 1000.5, `planted by smoke-cargo-file ${STAMP}`, uid.dir]);
  await oi(SHIPMENT, [F.e, T, FILE_E, seq + 1, "Second File Smoke Consignee",
    "File Smoke Consignor", "Bagged cement", null, null, "the decoy file of this company", uid.dir]);
  await oi(SHIPMENT, [F.x, T, FILE_X, seq + 2, "Cancelled File Consignee",
    "File Smoke Consignor", "A file the desk closed", null, null, "soft-deleted before export", uid.dir]);
  await oi(SHIPMENT, [F.foreign, T2, FILE_F, seq + 3, "Another Company Consignee",
    "Another Company Consignor", "Not ours", null, null, "planted so the gate has a real row", uid.dir2]);

  // --- the classic registers on file A ------------------------------------------------------
  await oi("insert into jobs (id, tenant_id, shipment_id, notes, created_by, updated_by)" +
    " values ($1,$2,$3,$4,$5,$5)", [F.job, T, F.a, `job opened for ${FILE_A}`, uid.dir]);
  await oi("insert into job_stages (id, tenant_id, job_id, shipment_id, stage_key, name, position," +
    " status) values ($1,$2,$3,$4,'customs','Customs assessment',4,'in_progress')",
    [F.stage, T, F.job, F.a]);
  await oi("insert into cargo_tasks (id, tenant_id, shipment_id, title, assigned_to, stage_id," +
    " status) values ($1,$2,$3,$4,$5,$6,'pending')",
    [F.task, T, F.a, TASK_TITLE, uid.dir, F.stage]);
  await oi("insert into cargo_tasks (id, tenant_id, shipment_id, title, assigned_to, status)" +
    " values ($1,$2,$3,$4,$5,'pending')",
    [F.taskE, T, F.e, TASK_E_TITLE, uid.dir]);
  await oi("insert into job_activity (id, tenant_id, job_id, shipment_id, actor_user_id," +
    " actor_role, action, summary) values ($1,$2,$3,$4,$5,'director','stage.started',$6)",
    [F.activity, T, F.job, F.a, uid.dir, `Opened ${FILE_A} for the file smoke`]);
  await oi("insert into job_handovers (id, tenant_id, job_id, shipment_id, received_by_name," +
    " received_by_id_number, method) values ($1,$2,$3,$4,$5,$6,'signature')",
    [F.handover, T, F.job, F.a, "Originals counter", PII]);

  // --- money: proforma → invoice → lines → payment → debit note → lines ----------------------
  const QUOTE = `insert into quotations (id, tenant_id, quotation_number, customer_name,
      customer_phone_encrypted, customer_phone_search, shipment_id, trade_type, notes,
      created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,'import',$8,$9,$9)`;
  await oi(QUOTE, [F.quoteA, T, QUOTE_A, CONSIGNEE, PII, PII, F.a, `proforma for ${FILE_A}`, uid.dir]);
  await oi(QUOTE, [F.quoteE, T, QUOTE_E, "Second File Smoke Consignee", PII, PII, F.e,
    "proforma of the decoy file", uid.dir]);
  const QITEM = `insert into quotation_items (id, tenant_id, quotation_id, seq, section,
      description, amount, total) values ($1,$2,$3,$4,'statutory',$5,$6,$6)`;
  await oi(QITEM, [F.qItem, T, F.quoteA, 1, "Import declaration fee", 80_000]);
  await oi(QITEM, [F.qItemE, T, F.quoteE, 1, "Declaration fee of the other file", 60_000]);

  const INVOICE = `insert into freight_invoices (id, tenant_id, invoice_number, customer_name,
      issue_date, due_date, currency, vat_rate, subtotal, vat_amount, total, amount_paid,
      status, source_quotation_id, created_by, updated_by, deleted_at)
    values ($1,$2,$3,$4,'2026-10-02','2026-11-01','TZS',18,$5,$6,$7,$8,'sent',$9,$10,$10,$11)`;
  await oi(INVOICE, [F.invA, T, INV_NO, CONSIGNEE, 659242.55, 118535, INV_TOTAL, 0,
    F.quoteA, uid.dir, null]);
  await oi(INVOICE, [F.invE, T, INV_E_NO, "Second File Smoke Consignee", 500000, 90000, 590000, 0,
    F.quoteE, uid.dir, null]);
  await oi(INVOICE, [F.invDead, T, INV_DEAD_NO, CONSIGNEE, 100000, 18000, 118000, 0,
    F.quoteA, uid.dir, new Date()]);
  // An invoice with nothing behind it: no proforma, so no chain to this file.
  await oi(INVOICE, [F.invLoose, T, INV_LOOSE_NO, "A walk-in customer", 200000, 36000, 236000, 0,
    null, uid.dir, null]);
  const ILINE = `insert into freight_invoice_items (id, tenant_id, invoice_id, seq, description,
      quantity, unit, unit_price, amount) values ($1,$2,$3,$4,$5,1,'job',$6,$6)`;
  await oi(ILINE, [F.invLineA, T, F.invA, 1, "Clearing and forwarding", INV_LINE]);
  await oi(ILINE, [F.invLineA2, T, F.invA, 2, "Bonded warehouse storage", 277777.55]);
  await oi(ILINE, [F.invLineE, T, F.invE, 1, "Charges of the decoy invoice", 500000]);
  const IPAY = `insert into freight_invoice_payments (id, tenant_id, invoice_id, amount, method,
      reference, paid_at, recorded_by) values ($1,$2,$3,$4,'mobile_money',$5,'2026-10-06',$6)`;
  await oi(IPAY, [F.payA, T, F.invA, PAYMENT, `CFPAY-${STAMP}`, uid.dir]);
  await oi(IPAY, [F.payE, T, F.invE, 1000, `CFPAYE-${STAMP}`, uid.dir]);

  const DN = `insert into debit_notes (id, tenant_id, debit_note_number, customer_name, reason,
      related_invoice_id, issue_date, currency, vat_rate, subtotal, vat_amount, total, status,
      created_by, updated_by)
    values ($1,$2,$3,$4,'Re-rating of storage',  $6,'2026-10-07','TZS',18,$7,16200.05,$5,'draft',$8,$8)`;
  await oi(DN, [F.dnA, T, DN_NO, CONSIGNEE, DN_TOTAL, F.invA, 73800.2, uid.dir]);
  await oi(DN, [F.dnE, T, DN_E_NO, "Second File Smoke Consignee", 56200.05, F.invE, 40000, uid.dir]);
  const DNLINE = `insert into debit_note_items (id, tenant_id, debit_note_id, seq, description,
      quantity, unit, unit_price, amount) values ($1,$2,$3,1,'Extra storage days',2,'day',$4,$4)`;
  await oi(DNLINE, [F.dnLineA, T, F.dnA, 73800.2]);
  await oi(DNLINE, [F.dnLineE, T, F.dnE, 40000]);

  // --- the office side, three hops in -------------------------------------------------------
  await oi("insert into employees (id, tenant_id, full_name, job_title, phone_search, skills)" +
    " values ($1,$2,'Amina Field Clerk','Clerk',$3,'{}')", [F.emp, T, PII]);
  const OTASK = `insert into office_tasks (id, tenant_id, employee_id, shipment_id, title,
      priority, due_date, status, created_by, updated_by)
    values ($1,$2,$3,$4,$5,'normal','2026-10-20','in_progress',$6,$6)`;
  await oi(OTASK, [F.otA, T, F.emp, F.a, "Collect the delivery note", uid.dir]);
  await oi(OTASK, [F.otE, T, F.emp, F.e, "Close the other file", uid.dir]);
  const STEP = `insert into office_task_steps (id, tenant_id, office_task_id, seq, name, status,
      created_by, updated_by) values ($1,$2,$3,1,$4,'not_started',$5,$5)`;
  await oi(STEP, [F.stepA, T, F.otA, STEP_NAME, uid.dir]);
  await oi(STEP, [F.stepE, T, F.otE, "Step of the other task", uid.dir]);
  const CHECK = `insert into office_task_step_checks (id, tenant_id, step_id, seq, label,
      requires_document, ticked_at, ticked_by) values ($1,$2,$3,$4,$5,false,now(),$6)`;
  await oi(CHECK, [F.checkA, T, F.stepA, 1, CHECK_LABEL, uid.dir]);
  await oi(CHECK, [F.checkA2, T, F.stepA, 2, "Copy filed in the vault", uid.dir]);
  await oi(CHECK, [F.checkE, T, F.stepE, 1, CHECK_E_LABEL, uid.dir]);
  // A step is born open and closed afterwards, so the fixture takes the same road a clerk
  // does: ticks first, then the status change — and the gate stamps the hour it closed.
  await oi("update office_task_steps set status = 'done', completed_by = $1" +
    " where id = any($2::uuid[]) and tenant_id = $3", [uid.dir, [F.stepA, F.stepE], T]);

  // --- the papers: master sheet, scanned intake page, stored documents -----------------------
  const MASTER = `insert into cargo_import_masters (id, tenant_id, shipment_id, packing_list_number,
      notes, created_by) values ($1,$2,$3,$4,$5,$6)`;
  await oi(MASTER, [F.masterA, T, F.a, MASTER_PL, `master sheet of ${FILE_A}`, uid.dir]);
  await oi(MASTER, [F.masterE, T, F.e, MASTER_E_PL, "master sheet of the decoy file", uid.dir]);

  async function upload(entityType: string, entityId: string, kind: string, fileName: string,
    bytes: Buffer): Promise<string> {
    const fd = new FormData();
    // Metadata before the file part: the API reads multipart fields in stream order.
    fd.append("entityType", entityType);
    fd.append("entityId", entityId);
    fd.append("kind", kind);
    fd.append("file", new Blob([bytes], { type: "application/pdf" }), fileName);
    const res = await fetch(`${API}/documents`, { method: "POST", headers: auth(tok.dir), body: fd });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.id) throw new Error(`upload ${fileName} answered ${res.status} ${JSON.stringify(j)}`);
    return String(j.id);
  }
  const paper = (label: string) =>
    Buffer.from(`%PDF-1.4\n${label} of ${FILE_A} ${STAMP}\n%%EOF\n`, "utf8");
  const docOne = paper("the clearing licence");
  const docTwo = paper("the delivery note");
  const docIds = {
    one: await upload("shipment", F.a, "permit", DOC_ONE, docOne),
    two: await upload("shipment", F.a, "delivery_note", DOC_TWO, docTwo)
  };
  await oi("insert into job_documents (id, tenant_id, job_id, shipment_id, title, kind, direction," +
    " status, document_id, created_by, updated_by) values ($1,$2,$3,$4,'Original licence','permit'," +
    "'received','received',$5,$6,$6)", [F.jobDoc, T, F.job, F.a, docIds.one, uid.dir]);

  const DRAFT = `insert into cargo_intake_drafts (id, tenant_id, batch_id, position, label,
      document_id, shipment_type, printed_reference, extract_status, extraction,
      committed_shipment_id, committed_at, created_by)
    values ($1,$2,$3,1,$4,$5,'import',$6,'extracted','{}'::jsonb,$7,now(),$8)`;
  await oi(DRAFT, [F.draftA, T, F.batchA, `Declaration page 1 of ${FILE_A}`, docIds.two,
    DRAFT_REF, F.a, uid.dir]);
  await oi(DRAFT, [F.draftE, T, F.batchE, "Declaration page 1 of the other file", docIds.two,
    DRAFT_E_REF, F.e, uid.dir]);

  await oi("insert into messages (id, tenant_id, shipment_id, body, created_by)" +
    " values ($1,$2,$3,$4,$5)",
    [F.message, T, F.a, `Arrival notice for ${FILE_A}`, uid.dir]);
  await oi("insert into message_reads (tenant_id, user_id, shipment_id, last_read_at)" +
    " values ($1,$2,$3,now())", [T, uid.clk, F.a]);
  await oi("insert into office_costs (id, tenant_id, cost_date, category, description, amount," +
    " shipment_id, created_by, updated_by) values ($1,$2,'2026-10-01','transport',$3,250000,$4,$5,$5)",
    [F.cost, T, `Trucking for ${FILE_A}`, F.a, uid.dir]);

  // --- the two formats ----------------------------------------------------------------------
  async function call(body: unknown, t: string | null = tok.dir) {
    const res = await fetch(`${API}/exports/cargo-file`, {
      method: "POST", headers: { "Content-Type": "application/json", ...auth(t) },
      body: JSON.stringify(body)
    });
    return { res, status: res.status, json: res.ok ? null : await res.json().catch(() => null) };
  }

  const xlsx = await call({ id: F.a, format: "xlsx" });
  const xType = xlsx.res.headers.get("content-type") ?? "";
  const xName = xlsx.res.headers.get("content-disposition") ?? "";
  check("the workbook answers as a spreadsheet named for the file and the day",
    xlsx.status === 200 && xType.includes("spreadsheetml.sheet")
    && /^attachment; filename="cargo-file-cf-\d{8}-\d{4}-\d{2}-\d{2}\.xlsx"$/.test(xName),
    { status: xlsx.status, xType, xName });
  const xBytes = Buffer.from(await xlsx.res.arrayBuffer());
  check("the workbook is a zip of sheets, not an error page under a .xlsx name",
    xBytes.subarray(0, 2).toString("latin1") === "PK", xBytes.subarray(0, 8).toString("hex"));

  const wb = new Workbook();
  await wb.xlsx.load(xBytes as any);
  const sheets = new Map<string, Sheet>();
  for (const ws of wb.worksheets) {
    const rows: Sheet = [];
    // exceljs types `values` as a getter/setter union, so it is read as the array it is at runtime.
    ws.eachRow((row) => rows.push((row.values as unknown as unknown[]).slice(1)
      .map((v) => String(v ?? ""))));
    sheets.set(ws.name, rows);
  }
  const byTable = new Map<string, Sheet>();
  for (const s of sheets.values()) {
    const t = sourceTableOf(s);
    if (t) byTable.set(t, s);
  }

  // Every entity that was planted on this file, by the table it lives in.
  const EXPECTED: [string, string, number][] = [
    ["cargo_shipments", "Shipment", 1],
    ["cargo_intake_drafts", "Intake drafts", 1],
    ["cargo_import_masters", "Import masters", 1],
    ["office_task_step_checks", "Step checks", 2],
    ["freight_invoices", "Freight invoices", 1],
    ["freight_invoice_items", "Invoice lines", 2],
    ["freight_invoice_payments", "Invoice payments", 1],
    ["debit_notes", "Debit notes", 1],
    ["debit_note_items", "Debit note lines", 1],
    ["office_task_steps", "Task steps", 1],
    ["office_tasks", "Office tasks", 1],
    ["quotations", "Quotations", 1],
    ["quotation_items", "Quotation lines", 1],
    ["cargo_tasks", "Tasks", 1],
    ["job_stages", "Stages", 1],
    ["jobs", "Job", 1],
    ["job_activity", "Activity", 1],
    ["job_handovers", "Handovers", 1],
    ["job_documents", "File documents", 1],
    ["messages", "Messages", 1],
    ["message_reads", "Read states", 1],
    ["office_costs", "Office costs", 1],
    ["documents", "Documents", 2]
  ];
  for (const [table, sheet, rows] of EXPECTED) {
    const s = underHeader(byTable.get(table) ?? sheets.get(sheet) ?? []);
    check(`${sheet} is printed with its ${rows} row(s)`,
      s.head.length > 0 && s.data.length === rows,
      { present: sheets.has(sheet), head: s.head.slice(0, 4), found: s.data.length });
  }

  // The rows that belong to another file of the same company, to an invoice with no
  // proforma behind it, or to a cancelled invoice must not reach this export.
  const allCells = [...sheets.values()].flat().flat().map((v) => String(v));
  const decoys = [INV_E_NO, INV_LOOSE_NO, INV_DEAD_NO, DN_E_NO, MASTER_E_PL, DRAFT_E_REF,
    QUOTE_E, TASK_E_TITLE, CHECK_E_LABEL, CONSIGNEE.replace("File Smoke", "Second File Smoke")];
  check("a decoy row of another cargo file is nowhere in the workbook",
    decoys.every((d) => !allCells.some((c) => c.includes(d))),
    decoys.filter((d) => allCells.some((c) => c.includes(d))));
  for (const absent of ["Manifests", "Parcels", "Requests", "Bookings", "Shipper shares"]) {
    check(`a register this file never used is absent rather than an empty ${absent} sheet`,
      !sheets.has(absent), [...sheets.keys()]);
  }

  const docs = underHeader(sheets.get("Documents") ?? []);
  check("the documents register lists the stored pages without claiming to pack them",
    docs.data.length === 2 && docs.data.every((r) => r.some((v) => v.endsWith(".pdf")))
    && !docs.head.includes("Path in archive") && !docs.head.includes("SHA-256")
    && !docs.head.includes("In this archive"),
    { head: docs.head, data: docs.data });

  const inv = underHeader(byTable.get("freight_invoices") ?? []);
  const totalCol = inv.head.indexOf("Total");
  const paidCol = inv.head.indexOf("Amount paid");
  check("the invoice total arrives as money, not as a string of digits",
    totalCol > 0 && Number(inv.data[0]?.[totalCol]) === INV_TOTAL
    && Number(inv.data[0]?.[paidCol]) === 0,
    { head: inv.head, row: inv.data[0] });
  const lines = underHeader(byTable.get("freight_invoice_items") ?? []);
  const lineAmt = lines.head.indexOf("Amount");
  check("both charge lines of that invoice came with it and add up",
    lineAmt > 0 && lines.data.length === 2
    && Math.abs(Number(lines.totals?.[lineAmt]) - (INV_LINE + 277777.55)) < 0.005
    && lines.data.every((r) => r[lines.head.indexOf("Invoice id")]?.length === 36),
    { head: lines.head, totals: lines.totals });
  const dn = underHeader(byTable.get("debit_notes") ?? []);
  check("the debit note raised against that invoice is on the page with its number",
    dn.data.length === 1 && dn.data[0][dn.head.indexOf("Debit note number")] === DN_NO
    && Number(dn.data[0][dn.head.indexOf("Total")]) === DN_TOTAL,
    { head: dn.head, row: dn.data[0] });
  const checks = underHeader(byTable.get("office_task_step_checks") ?? []);
  const labelCol = checks.head.indexOf("Label");
  const tickedCol = checks.head.indexOf("Ticked at");
  check("a checklist tick three desks away arrives, stamped with the hour it was put there",
    checks.data.length === 2 && tickedCol > 0
    && [CHECK_LABEL, "Copy filed in the vault"].every((l) => checks.data.some((r) => r[labelCol] === l))
    && checks.data.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r[tickedCol] ?? "")),
    { head: checks.head, rows: checks.data });
  // A foreign id is only printed as a name when its own table can be read, so the naming
  // is looked for on the register whose parent really is a person: `employee_id`.
  const ot = underHeader(byTable.get("office_tasks") ?? []);
  const empCol = ot.head.indexOf("Employee id name");
  check("an id on a register three desks deep is printed beside the name its parent gives it",
    empCol > 0 && ot.data.length === 1 && ot.data[0][empCol] === "Amina Field Clerk",
    { head: ot.head, row: ot.data[0] });
  const draft = underHeader(byTable.get("cargo_intake_drafts") ?? []);
  check("the scanned page this file was typed from is on the record with its printed number",
    draft.data.length === 1
    && draft.data[0][draft.head.indexOf("Printed reference")] === DRAFT_REF,
    { head: draft.head, row: draft.data[0] });
  const ship = underHeader(byTable.get("cargo_shipments") ?? []);
  check("the file itself leads, with the figure the clerk billed",
    ship.data.length === 1 && ship.data[0][ship.head.indexOf("File number")] === FILE_A
    && Number(ship.data[0][ship.head.indexOf("Payment amount")]) === SHIP_BILL,
    { head: ship.head, row: ship.data[0] });

  const wbLeaks = [...sheets.entries()]
    .filter(([, rows]) => rows.some((r) => r.some((v) => v.includes(PII))))
    .map(([name]) => name);
  check("the planted NIDA, phone and id-number material is in no sheet",
    wbLeaks.length === 0, wbLeaks);

  const pdf = await call({ id: F.a, format: "pdf" });
  const pName = pdf.res.headers.get("content-disposition") ?? "";
  check("the same file answers as a book, named for the same file and the same day",
    pdf.status === 200 && (pdf.res.headers.get("content-type") ?? "").includes("application/pdf")
    && pName === xName.replace(/\.xlsx"$/, ".pdf\"")
    && /^attachment; filename="cargo-file-cf-\d{8}-\d{4}-\d{2}-\d{2}\.pdf"$/.test(pName),
    { status: pdf.status, xName, pName });
  const pBytes = Buffer.from(await pdf.res.arrayBuffer());
  check("the printed file is a pdf", pBytes.subarray(0, 5).toString("latin1") === "%PDF-",
    pBytes.subarray(0, 16).toString("latin1"));

  const printed = await printedPages(pBytes);
  // Spaces are squeezed out of both sides: pdfjs pads between the cells of a row, and the
  // promise is that the letters arrive in order, not that they arrive adjacent.
  const page = printed.lines.join("").replace(/\s+/g, "");
  check("the book prints the file number whole, not cut to fit",
    page.includes(FILE_A) && !page.includes(`${FILE_A.slice(0, 6)}...`), printed.lines.slice(0, 4));
  check("its cover says what it is",
    page.includes("Cargofile") && page.includes("Everyregister"), printed.lines.slice(0, 6));
  const titles = EXPECTED.map(([, s]) => s.replace(/\s+/g, ""));
  const missingTitles = titles.filter((t) => !page.includes(t));
  check("every register is named in the book", missingTitles.length === 0, missingTitles);
  check("the money is printed as money",
    page.includes("1,234,567.89") && page.includes("777,777.55") && page.includes("90,000.25"),
    printed.lines.filter((l) => /[\d],[\d]{3}/.test(l)).slice(0, 3));
  check("a register with two rows says so on the page",
    page.includes("Total-2rows"), printed.lines.filter((l) => l.startsWith("Total ")).slice(0, 6));
  check("the book is at least one page per register",
    printed.pageCount >= EXPECTED.length,
    { pages: printed.pageCount, registers: EXPECTED.length });
  check("every page says where it stands in the book",
    printed.lines.some((l) => /^Page 1 of \d+$/.test(l))
    && /^Page \d+ of \d+$/.test(printed.lines.at(-1) ?? ""),
    printed.lines.slice(0, 2).concat(printed.lines.slice(-2)));
  const decoyOnPaper = decoys.filter((d) => page.includes(d.replace(/\s+/g, "")));
  check("no decoy of another file reaches the printed page", decoyOnPaper.length === 0, decoyOnPaper);
  check("the printed page holds no planted PII",
    !printed.lines.some((l) => l.includes(PII)), printed.lines.filter((l) => l.includes(PII)));

  // The same company's second file, asked for on its own: the walk must be per file, not
  // per desk, so this book carries its own rows and none of the first file's.
  const bare = await call({ id: F.e, format: "pdf" });
  const bareBytes = Buffer.from(await bare.res.arrayBuffer());
  const barePrinted = bare.status === 200 ? await printedPages(bareBytes) : { lines: [], pageCount: 0 };
  check("the decoy file exports as its own book, with none of this file's rows in it",
    bare.status === 200
    && barePrinted.lines.join("").replace(/\s+/g, "").includes(FILE_E)
    && !barePrinted.lines.some((l) => l.includes(INV_NO))
    && !barePrinted.lines.some((l) => l.includes(DRAFT_REF)),
    { status: bare.status, pages: barePrinted.pageCount });

  // --- the gates ----------------------------------------------------------------------------
  const noToken = await call({ id: F.a, format: "xlsx" }, null);
  check("no token, no file", noToken.status === 401, noToken.status);
  const noTokenPdf = await call({ id: F.a, format: "pdf" }, null);
  check("…and none of the book either", noTokenPdf.status === 401, noTokenPdf.status);

  const clerk = await call({ id: F.a, format: "xlsx" }, tok.clk);
  const clerkJson: any = clerk.json;
  check("a seat that may open the file but may not export it is refused before a byte exists",
    clerk.status === 403 && clerkJson?.error?.code === "FORBIDDEN"
    && String(clerkJson?.error?.message).includes("shipments.export"),
    { status: clerk.status, body: clerkJson });

  const foreign = await call({ id: F.foreign, format: "xlsx" });
  check("another company's file is not on this desk",
    foreign.status === 404 && (foreign.json as any)?.error?.code === "NOT_FOUND",
    { status: foreign.status, body: foreign.json });
  const stranger = await call({ id: F.a, format: "pdf" }, tok.dir2);
  check("…and the other company is told the same about our file",
    stranger.status === 404, { status: stranger.status, body: stranger.json });
  // Asked for while it is still open, then closed and asked for again: only the pair shows
  // that it was the closure that refused it, rather than a bad id or a wrong tenant.
  const whileOpen = await call({ id: F.x, format: "xlsx" });
  await oi("update cargo_shipments set deleted_at = now() where id = $1", [F.x]);
  const closedXlsx = await call({ id: F.x, format: "xlsx" });
  const closedPdf = await call({ id: F.x, format: "pdf" });
  check("a file the desk has closed is not exported in either format, and the closure is "
    + "what refused it — the same row answered while it was open",
    whileOpen.status === 200 && closedXlsx.status === 404 && closedPdf.status === 404,
    { whileOpen: whileOpen.status, closedXlsx: closedXlsx.status, closedPdf: closedPdf.status });

  const ghost = await call({ id: randomUUID(), format: "xlsx" });
  check("an id that holds nothing is refused as not found", ghost.status === 404, ghost.status);
  const junkId = await call({ id: "not-a-uuid", format: "xlsx" });
  check("an id that is not an id is refused", junkId.status === 400, junkId.status);
  const junkFormat = await call({ id: F.a, format: "docx" });
  check("a format this writer does not speak is refused", junkFormat.status === 400, junkFormat.status);
  const noBody = await call({}, tok.dir);
  check("an export with no file named is refused", noBody.status === 400, noBody.status);

  // --- the audit trail ----------------------------------------------------------------------
  // Scoped to the file this smoke exported, because the same seat wrote audit rows for the
  // second file and the closed one above; counted over the whole company, its own noise
  // would read as a finding.
  const audit = await oi(
    "select action, entity, entity_id, after from audit_logs where tenant_id = $1" +
    " and action in ('export.file.xlsx','export.file.pdf') and entity_id = $2 and ts >= $3" +
    " order by ts desc",
    [T, F.a, startedAt]);
  const byAction = new Map(audit.rows.map((r: any) => [r.action, r]));
  check("both exports are on the record, each naming the file it wrote",
    byAction.has("export.file.xlsx") && byAction.has("export.file.pdf")
    && audit.rows.every((r: any) => r.entity === "cargo_shipments" && r.entity_id === F.a),
    audit.rows.map((r: any) => ({ action: r.action, entity: r.entity, id: r.entity_id })));
  const ax: any = (byAction.get("export.file.xlsx") as any)?.after ?? {};
  check("the log says how many registers and rows the operator was handed",
    ax.report === "cargo-file" && ax.file_number === FILE_A
    && ax.registers >= EXPECTED.length && ax.rows >= EXPECTED.length
    && ax.documents === 2 && ax.bytes > 1000 && ax.truncated === 0, ax);
  const ap: any = (byAction.get("export.file.pdf") as any)?.after ?? {};
  check("…and that the book was handed exactly the registers and rows the spreadsheet was",
    ap.report === "cargo-file" && ap.file_number === FILE_A
    && ap.registers === ax.registers && ap.rows === ax.rows && ap.bytes > 1000,
    { pdf: ap, xlsx: ax });
  check("no other company's audit row was touched",
    !(await oi("select 1 from audit_logs where tenant_id = $1 and action like 'export.file%' limit 1",
      [T2])).rowCount, undefined);

  // --- teardown -----------------------------------------------------------------------------
  for (const id of [docIds.one, docIds.two]) {
    const del = await fetch(`${API}/documents/${id}`, { method: "DELETE", headers: auth(tok.dir) });
    if (!del.ok) console.log(`note   document ${id} delete answered ${del.status}`);
  }
  for (const at of [T, T2]) await sweep(at);
  const residue = await oi(
    "select (select count(*) from cargo_shipments where id = any($1::uuid[]))::int as files," +
    " (select count(*) from freight_invoices where source_quotation_id in" +
    "   (select id from quotations where shipment_id = any($1::uuid[])))::int as invoices," +
    " (select count(*) from debit_note_items where tenant_id = any($2::uuid[]))::int as dn_lines," +
    " (select count(*) from office_task_step_checks where tenant_id = any($2::uuid[]))::int as ticks," +
    " (select count(*) from users where tenant_id = any($2::uuid[]))::int as seats," +
    " (select count(*) from tenants where id = any($2::uuid[]))::int as companies",
    [[F.a, F.e, F.x, F.foreign], [T, T2]]);
  check("the fixture left no business row, seat or company behind",
    Object.values(residue.rows[0]).every((v) => Number(v) === 0), residue.rows[0]);

  await owner.end();
  console.log(`\nworkbook ${xBytes.length} bytes / ${sheets.size} sheets, `
    + `book ${pBytes.length} bytes / ${printed.pageCount} pages, extracted ${printed.lines.length} lines`);
  console.log(failures === 0 ? "cargo file smoke clean" : `${failures} FAILED CHECK(S)`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
