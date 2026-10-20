/**
 * End-to-end smoke for cargo PDF intake (#226) against a running API on :4000.
 *
 * The promise this surface makes is narrow, so the checks are narrow too: a digital PDF's text
 * layer is read and every candidate keeps the line it came from; a page with no text layer is
 * filed as "needs typing" rather than guessed at; nothing money-related leaves a page; and the
 * intake desk never writes a cargo row — `POST /cargo` still issues the file number, and
 * `commit` only links the paper to the file the clerk went on to save.
 *
 * So the pages really are PDFs with a real text layer, they really go through the multipart
 * endpoint (which is where field order bites), and the cargo file really is opened by the desk
 * with its own sequence. The read-backs are SQL, because a page that *looks* filed in the HTTP
 * response but is not stamped in the register is exactly the bug this route could hide.
 *
 * Run: npx tsx scripts/smoke-cargo-intake.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const CONSIGNEE = `Intake Smoke Consignee ${STAMP}`;
const CONSIGNOR = `Intake Smoke Consignor ${STAMP}`;
const BATCH = randomUUID();

/** One page with a real text layer, so the server-side reader has something to pull. */
function makePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => "\\" + m);
  const content = ["BT", "/F1 9 Tf", "1 0 0 1 40 800 Tm", "12 TL",
    ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");

  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** The paper the desk is meant to file: a C10 with the fields printed the way a typist prints them. */
const DECLARATION = makePdf([
  "UNITED REPUBLIC OF TANZANIA",
  "ELECTRONIC SINGLE ADMIN DOCUMENT — C10 IMPORT DECLARATION",
  `TANSAD No: 380999-2026-${STAMP.slice(-6)}`,
  "Type of Declaration: IMPORT",
  "Office of Declaration: Dar es Salaam",
  "Border Point: Dar es Salaam Port",
  "Nominated ICD: TICT",
  "Cabinet Position: BAY 12 SLOT 04",
  `Consignee: ${CONSIGNEE}`,
  `Consignor: ${CONSIGNOR}`,
  "Shipping Line: MAERSK LINE",
  "B/L No: MEDU4471902",
  "HS Code: 8701.21.90",
  "Cargo Description: Used tractor units, three units",
  "Container No: MSCU1234566",
  "Container No: TCLU7891024",
  "Container No: MSCU1234567",
  "Container Type: 40' HC",
  "Gross Weight: 24.750 tonnes",
  "Measurement: 30.5 CBM",
  "ETA: 2026-11-05",
  "Discharge Date: 2026-11-06",
  "Carry In Date: 2026-11-08",
  "Terms of Delivery: CIF",
  "Total Charges: 4,820,000",
  "Amount Payable: 4,820,000",
  `RCN No: RCN-2026-${STAMP.slice(-4)}`,
  `Our Ref: WSH-${STAMP}`
]);

/** A photographed page: a page of the sheet, but no words the reader can pull. */
const PHOTOCOPY = makePdf([]);

/** Not a PDF at all, whatever the filename and the declared mime say. */
const NOT_A_PDF = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(`intake smoke not a pdf ${STAMP}`, "utf8")
]);

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

/**
 * Everything this run plants, held at module scope so the sweep still knows about it when the
 * run throws half-way through. A page left on a live desk is a number a real clerk cannot use,
 * and the register's FK to its document is what decides the order the rows go in.
 */
const ownerRef = { client: null as pg.Client | null };
const draftIds: string[] = [];
const paperIds: string[] = [];
const fileIds: string[] = [];
/** Both batch ids this run uses, so the sweep catches a page whose response was never read. */
const sweptBatches = [BATCH];
const oi = (sql: string, p: unknown[] = []) => ownerRef.client!.query(sql, p as any[]);

async function sweep() {
  if (!ownerRef.client) return;
  const steps: [string, string, unknown[]][] = [
    ["cargo_tasks", "delete from cargo_tasks where shipment_id = any($1::uuid[])", [fileIds]],
    ["job_activity", "delete from job_activity where shipment_id = any($1::uuid[])", [fileIds]],
    ["job_stages", "delete from job_stages where shipment_id = any($1::uuid[])", [fileIds]],
    ["jobs", "delete from jobs where shipment_id = any($1::uuid[])", [fileIds]],
    ["cargo_intake_drafts", "delete from cargo_intake_drafts where id = any($1::uuid[])" +
      " or batch_id = any($2::uuid[])", [draftIds, sweptBatches]],
    ["documents", "delete from documents where id = any($1::uuid[])", [paperIds]],
    ["cargo_shipments", "delete from cargo_shipments where id = any($1::uuid[])", [fileIds]]
  ];
  for (const [name, sql, p] of steps) {
    try {
      const r = await oi(sql, p);
      console.log(`tore down ${name}: ${r.rowCount} row(s)`);
    } catch (e: any) {
      console.log(`note   teardown ${name} failed — ${e.message}`);
    }
  }
}

async function main() {
  const startedAt = Date.now();
  ownerRef.client = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL,
    ssl: { rejectUnauthorized: false } });
  await ownerRef.client.connect();

  const who = await oi(
    "select u.id, u.tenant_id, u.full_name, cp.company_code from users u" +
    " join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id" +
    " join company_profiles cp on cp.tenant_id = u.tenant_id" +
    " where r.key = 'director' and u.deleted_at is null" +
    " and cp.company_code is not null and length(cp.company_code) = 3 limit 1");
  if (!who.rowCount) throw new Error("no director seat with a company code — seed a CFA first");
  const { id: userId, tenant_id: tid, company_code: companyCode } = who.rows[0];

  const mint = (sub: string, role: string, tenant: string) =>
    new SignJWT({ tid: tenant, sid: randomUUID(), typ: role, roles: [role] })
      .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
      .setIssuedAt().setExpirationTime("20m").sign(key);
  const token = await mint(userId, "director", tid);
  const auth = (tok: string | null): Record<string, string> =>
    tok ? { Authorization: `Bearer ${tok}` } : {};
  console.log(`seat ${userId} tenant ${tid} code ${companyCode} batch ${BATCH.slice(0, 8)}`);

  // A second company's shelf, if one exists: the desk must answer 404, not 403, for a page
  // that is simply not theirs.
  const foreignSeat = (await oi(
    "select u.id, u.tenant_id from users u" +
    " join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id" +
    " where r.key = 'director' and u.deleted_at is null and u.tenant_id <> $1 limit 1",
    [tid])).rows[0] as { id: string; tenant_id: string } | undefined;
  // A cargo file belonging to another company, planted so the commit guard has something
  // real to refuse even when the database holds only one CFA.
  const foreignTenantId = foreignSeat?.tenant_id
    ?? (await oi("select id from tenants where id <> $1 limit 1", [tid])).rows[0]?.id;
  const foreignShipment = randomUUID();
  fileIds.push(foreignShipment);
  const FSEQ = 5_000_000 + Math.floor(Math.random() * 90_000);
  if (foreignTenantId) {
    await oi("insert into cargo_shipments (id, tenant_id, file_number, seq, file_year," +
      " shipment_type, container_type, consignee_name, consignor_name, stage, status," +
      " created_by, updated_by) values ($1,$2,$3,$4,2026,'import','20ft'," +
      "'Another Company Consignee','Another Company Consignor','pre_arrival','open',$5,$5)",
      [foreignShipment, foreignTenantId, `4FOR-${STAMP}`, FSEQ, userId]);
  }

  // --- the multipart channel ---------------------------------------------------------------
  async function uploadPage(opts: { position?: number; label?: string; batchId?: string;
    kind?: string; shipmentType?: string; file?: { bytes: Buffer; name: string; mime: string } }) {
    const fd = new FormData();
    // Every metadata field before the file part: the API reads multipart fields in stream order.
    if (opts.position !== undefined) fd.append("position", String(opts.position));
    if (opts.label) fd.append("label", opts.label);
    if (opts.batchId) fd.append("batchId", opts.batchId);
    if (opts.kind) fd.append("kind", opts.kind);
    if (opts.shipmentType) fd.append("shipmentType", opts.shipmentType);
    const f = opts.file ?? { bytes: DECLARATION, name: "c10-declaration.pdf", mime: "application/pdf" };
    fd.append("file", new Blob([f.bytes], { type: f.mime }), f.name);
    const res = await fetch(`${API}/cargo/intake`, { method: "POST", headers: auth(token), body: fd });
    const j: any = await res.json().catch(() => null);
    // Recorded the moment the desk answers with an id, so a throw later in the run still
    // reaches the sweep with this page in hand.
    if (j?.id) draftIds.push(String(j.id));
    if (j?.documentId) paperIds.push(String(j.documentId));
    return { status: res.status, j };
  }
  const get = async (path: string, tok: string | null = token) => {
    const res = await fetch(`${API}${path}`, { headers: auth(tok) });
    return { status: res.status, j: await res.json().catch(() => null) };
  };
  const post = async (path: string, body: unknown, tok: string | null = token) => {
    const res = await fetch(`${API}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...auth(tok) },
      body: JSON.stringify(body)
    });
    return { status: res.status, j: await res.json().catch(() => null) };
  };
  const del = async (path: string, tok: string | null = token) => {
    const res = await fetch(`${API}${path}`, { method: "DELETE", headers: auth(tok) });
    return { status: res.status, j: await res.json().catch(() => null) };
  };

  const page1 = await uploadPage({ position: 1, label: "C10 import declaration", batchId: BATCH,
    kind: "declaration", shipmentType: "import" });
  check("a numbered page is stored and read", page1.status === 201 && !!page1.j?.id, page1);
  const d1 = page1.j ?? {};
  check("the reading is reported as a reading, not a guess",
    d1.extractStatus === "extracted" && /field\(s\) read from \d+ line/.test(String(d1.extractNotes)),
    { status: d1.extractStatus, notes: d1.extractNotes });
  check("the batch the clerk named is the batch the page is filed under",
    d1.batchId === BATCH && d1.position === 1 && d1.truncated === false,
    { batch: d1.batchId, position: d1.position, truncated: d1.truncated });

  const ex = d1.extraction?.fields ?? {};
  const val = (k: string) => ex[k]?.value;
  check("the parties came off the paper with the line they came from",
    val("consigneeName") === CONSIGNEE && val("consignorName") === CONSIGNOR
    && Number(ex.consigneeName?.line) > 0 && typeof ex.consigneeName?.raw === "string",
    { consignee: ex.consigneeName, consignor: ex.consignorName });
  check("the references came off the paper",
    val("tansadNumber") === `380999-2026-${STAMP.slice(-6)}` && val("billNumber") === "MEDU4471902"
    && val("hsCode") === "8701.21.90" && val("referenceNumber") === `WSH-${STAMP}`
    && String(val("rcnNumber") ?? "").startsWith("RCN-2026-"), ex);
  check("the movement and the offices came off the paper",
    val("shipmentType") === "import" && val("officeDeclaration") === "Dar es Salaam"
    && val("borderPoint") === "dar es salaam" && val("nominatedIcd") === "TICT"
    && val("cabinetPosition") === "BAY 12 SLOT 04",
    { type: val("shipmentType"), office: val("officeDeclaration"), border: val("borderPoint"),
      icd: val("nominatedIcd"), cabinet: val("cabinetPosition") });
  check("the calendar is ISO at the desk and the printed line is kept beside it",
    val("eta") === "2026-11-05" && val("dischargeDate") === "2026-11-06"
    && val("carryInDate") === "2026-11-08" && String(ex.eta?.raw ?? "").includes("2026-11-05"),
    { eta: ex.eta, discharge: ex.dischargeDate, carryIn: ex.carryInDate });
  check("a number is only believed with its unit",
    Number(val("weightTonnes")) === 24.75 && Number(val("cbm")) === 30.5
    && val("termsDelivery") === "CIF" && val("containerType") === "40ft",
    { weight: ex.weightTonnes, cbm: ex.cbm, terms: ex.termsDelivery, size: ex.containerType });
  const containers = d1.extraction?.containers ?? [];
  check("three container marks were read and the count is taken from them",
    containers.length === 3 && val("containerNumbers")?.length === 3
    && /3 container number\(s\) found/.test((d1.extraction?.notes ?? []).join(" ")),
    { containers, containerField: ex.containerNumbers });
  check("a mark that fails its own check digit is offered, marked",
    containers.filter((c: any) => !c.valid).map((c: any) => c.number).join() === "MSCU1234567"
    && containers.filter((c: any) => c.valid).map((c: any) => c.number).join() === "MSCU1234566,TCLU7891024",
    containers);
  check("the bill of lading number was not read as a container",
    !containers.some((c: any) => c.number === "MEDU4471902"), containers);
  const money = ["processingCost", "paymentAmount", "paymentStatus"].filter((k) => ex[k]);
  check("nothing money-related left the page", money.length === 0 && !("charges" in ex),
    { money, keys: Object.keys(ex) });
  check("the page's charges are recorded as a refusal, not a value",
    (d1.extraction?.notes ?? []).some((n: string) => /charges.*invoice/i.test(n)),
    d1.extraction?.notes);

  const page2 = await uploadPage({ position: 2, label: "Packing list (photocopy)", batchId: BATCH,
    kind: "packing_list",
    file: { bytes: PHOTOCOPY, name: "packing-list-scan.pdf", mime: "application/pdf" } });
  check("a page with no text layer is a result, not an error",
    page2.status === 201 && page2.j?.extractStatus === "manual", page2);
  check("and it says so in the words the clerk needs",
    /No text layer.*typed in/.test(String(page2.j?.extractNotes ?? "")),
    { notes: page2.j?.extractNotes });

  const page3 = await uploadPage({ batchId: BATCH, label: "Arrival notice, no number given",
    kind: "arrival_notice",
    file: { bytes: makePdf(["MAERSK LINE", "ARRIVAL NOTICE", `ETA: 2026-11-05`,
      `B/L No: MEDU4471902`, `Consignee: ${CONSIGNEE}`]),
      name: "arrival-notice.pdf", mime: "application/pdf" } });
  check("a page numbered by nobody takes the next free number",
    page3.status === 201 && page3.j?.position === 3, { status: page3.status, j: page3.j });
  check("the server minted the batch id the desk will append to",
    page3.j?.batchId === BATCH, page3.j?.batchId);

  const clash = await uploadPage({ position: 1, batchId: BATCH });
  check("a number that is taken is refused, and says what holds it",
    clash.status === 409 && /Page 1 of this batch already holds "C10 import declaration"/
      .test(String(clash.j?.error?.message ?? "")), clash);

  const otherBatch = randomUUID();
  sweptBatches.push(otherBatch);
  const sameNumberElsewhere = await uploadPage({ position: 1, batchId: otherBatch });
  check("the same number in another batch is a different page",
    sameNumberElsewhere.status === 201 && sameNumberElsewhere.j?.position === 1,
    sameNumberElsewhere);

  const disguised = await uploadPage({ batchId: BATCH,
    file: { bytes: NOT_A_PDF as unknown as Buffer, name: "declaration.pdf", mime: "application/pdf" } });
  check("bytes that are not a PDF are refused whatever they are called",
    disguised.status === 400 && /Only PDF files/.test(String(disguised.j?.error?.message ?? "")),
    disguised);
  const wrongMime = await uploadPage({ batchId: BATCH,
    file: { bytes: DECLARATION, name: "c10.pdf", mime: "image/png" } });
  check("a PDF declared as a picture is refused too",
    wrongMime.status === 400, wrongMime);

  const shelf = await get(`/cargo/intake?batchId=${BATCH}`);
  check("the shelf answers as a shelf, not as a cargo file",
    shelf.status === 200 && Array.isArray(shelf.j?.drafts) && Array.isArray(shelf.j?.batches),
    { status: shelf.status, keys: Object.keys(shelf.j ?? {}) });
  const listed = (shelf.j?.drafts ?? []).filter((d: any) => d.batch_id === BATCH);
  check("every page of this batch is listed, numbered and typed",
    listed.length === 3 && [1, 2, 3].every((p) => listed.some((d: any) => d.position === p)),
    listed.map((d: any) => [d.position, d.extract_status, d.file_name]));
  const batchRow = (shelf.j?.batches ?? []).find((b: any) => b.batch_id === BATCH);
  check("the batch counts what a clerk can still act on",
    batchRow?.pages === 3 && batchRow?.read_ok === 2 && batchRow?.needs_typing === 1
    && batchRow?.filed === 0, batchRow);
  check("the count of pages still to type is on the answer",
    typeof shelf.j?.needsTyping === "number" && shelf.j.needsTyping >= 1,
    shelf.j?.needsTyping);
  const unfiled = await get(`/cargo/intake?batchId=${BATCH}&unfiled=true&status=manual`);
  check("a filter for typing work returns only typing work",
    unfiled.status === 200 && (unfiled.j?.drafts ?? []).length === 1
    && unfiled.j.drafts[0].position === 2 && unfiled.j.drafts[0].extract_status === "manual",
    unfiled.j?.drafts?.map((d: any) => [d.position, d.extract_status]));

  const one = await get(`/cargo/intake/${d1.id}`);
  check("one page carries its reading as an object, not a string",
    one.status === 200 && typeof one.j?.extraction === "object"
    && one.j?.extraction?.fields?.consigneeName?.value === CONSIGNEE,
    { type: typeof one.j?.extraction });
  check("and the vault's own name for it",
    one.j?.file_name === "c10-declaration.pdf" && one.j?.mime_type === "application/pdf"
    && one.j?.document_kind === "declaration" && one.j?.size_bytes > 200
    && one.j?.committed_file_number === null,
    { name: one.j?.file_name, kind: one.j?.document_kind, size: one.j?.size_bytes });

  const reread = await post(`/cargo/intake/${d1.id}/read`, {});
  check("a re-read of the stored bytes reads the same page",
    reread.status === 200 && reread.j?.extractStatus === "extracted"
    && reread.j?.extraction?.fields?.consigneeName?.value === CONSIGNEE, reread.j);

  const relabel = await post(`/cargo/intake/${page2.j.id}/details`,
    { position: 5, label: "Packing list, page two", shipmentType: "transit" });
  check("the clerk can give a page another number, name and movement",
    relabel.status === 200, relabel);
  const afterLabel = await get(`/cargo/intake/${page2.j.id}`);
  check("and the shelf reads back what was written, from the same row",
    afterLabel.j?.position === 5 && afterLabel.j?.label === "Packing list, page two"
    && afterLabel.j?.shipment_type === "transit",
    { p: afterLabel.j?.position, l: afterLabel.j?.label, t: afterLabel.j?.shipment_type });
  const relabelClash = await post(`/cargo/intake/${page2.j.id}/details`, { position: 1 });
  check("a number another page holds is refused on a re-number too",
    relabelClash.status === 409, relabelClash);

  // --- the desk still owns the file number ---------------------------------------------------
  const scannedPayload = {
    shipmentType: "import", hsCode: val("hsCode"), cargoDescription: val("cargoDescription"),
    containerType: val("containerType"), containerCount: 3,
    containerNumbers: val("containerNumbers"), weightTonnes: Number(val("weightTonnes")),
    cbm: Number(val("cbm")), consigneeName: val("consigneeName"), consignorName: val("consignorName"),
    shippingLine: val("shippingLine"), billNumber: val("billNumber"), eta: val("eta"),
    dischargeDate: val("dischargeDate"), carryInDate: val("carryInDate"),
    termsDelivery: val("termsDelivery"), tansadNumber: val("tansadNumber"),
    rcnNumber: val("rcnNumber"), referenceNumber: val("referenceNumber"),
    officeDeclaration: val("officeDeclaration"), borderPoint: val("borderPoint"),
    nominatedIcd: val("nominatedIcd"), cabinetPosition: val("cabinetPosition"),
    paymentStatus: "unpaid"
  };
  const opened = await post("/cargo", scannedPayload);
  check("the cargo desk opens the file, with its own number",
    opened.status === 201 && new RegExp(`^4${companyCode}-\\d{3}-\\d{4}$`).test(String(opened.j?.fileNumber)),
    opened);
  const shipmentId = opened.j?.id;
  if (shipmentId) fileIds.push(shipmentId);

  const tooYoung = await post("/cargo", { ...scannedPayload, consigneeName: "" });
  check("a scanned page cannot smuggle an empty consignee past the desk",
    tooYoung.status === 400, tooYoung.status);

  const commit = await post(`/cargo/intake/${d1.id}/commit`, { shipmentId });
  check("the page is filed against the file it became", commit.status === 200 && commit.j?.ok === true,
    commit);
  const stamped = await oi(
    "select d.committed_shipment_id, d.committed_at, f.entity_type, f.entity_id" +
    " from cargo_intake_drafts d join documents f on f.id = d.document_id where d.id = $1", [d1.id]);
  check("the register holds the link, not just the response",
    stamped.rows[0]?.committed_shipment_id === shipmentId && !!stamped.rows[0]?.committed_at,
    stamped.rows[0]);
  check("and the paper itself moved onto the cargo file",
    stamped.rows[0]?.entity_type === "shipment" && stamped.rows[0]?.entity_id === shipmentId,
    stamped.rows[0]);

  const commitAgain = await post(`/cargo/intake/${d1.id}/commit`, { shipmentId });
  check("a retried commit is a no-op, not a second filing", commitAgain.status === 200,
    commitAgain);
  const commitElsewhere = await post(`/cargo/intake/${d1.id}/commit`, { shipmentId: foreignShipment });
  check("a page cannot be filed against a second file",
    commitElsewhere.status === 409, commitElsewhere);

  const afterCommit = await get(`/cargo/intake/${d1.id}`);
  check("the shelf now names the file this page became",
    afterCommit.j?.committed_file_number === opened.j?.fileNumber,
    { file: afterCommit.j?.committed_file_number });
  const rereadFiled = await post(`/cargo/intake/${d1.id}/read`, {});
  check("a filed page keeps the reading the desk reviewed",
    rereadFiled.status === 409 && /stands as it was/.test(String(rereadFiled.j?.error?.message ?? "")),
    rereadFiled);
  const relabelFiled = await post(`/cargo/intake/${d1.id}/details`, { label: "rewritten after filing" });
  check("a filed page cannot be relabelled out of its own history", relabelFiled.status === 409,
    relabelFiled);
  const removeFiled = await del(`/cargo/intake/${d1.id}`);
  check("a filed page is not taken off the shelf by the intake desk",
    removeFiled.status === 409 && /Remove it from the file's documents/.test(
      String(removeFiled.j?.error?.message ?? "")), removeFiled);

  const onFile = await get(`/documents?entityType=shipment&entityId=${shipmentId}`);
  check("the source page is on the cargo file for anyone who opens its documents",
    onFile.status === 200 && (onFile.j ?? []).some((f: any) => f.id === d1.documentId),
    onFile.j?.map?.((f: any) => [f.id, f.file_name]));
  const stillOnShelfAsPaper = await get("/documents/vault?entityType=cargo_intake");
  check("and it left the intake shelf as loose paper",
    stillOnShelfAsPaper.status === 200
    && (stillOnShelfAsPaper.j ?? []).every((f: any) => f.id !== d1.documentId),
    stillOnShelfAsPaper.j?.map?.((f: any) => [f.id, f.entity_label]));

  // --- the gates -----------------------------------------------------------------------------
  const trainee = await mint(randomUUID(), "trainee", tid);
  const noDutyUpload = await fetch(`${API}/cargo/intake`, {
    method: "POST", headers: auth(trainee),
    body: (() => { const fd = new FormData(); fd.append("batchId", BATCH);
      fd.append("file", new Blob([DECLARATION], { type: "application/pdf" }), "gated.pdf"); return fd; })()
  });
  check("a seat without the extract duty cannot put a page on the shelf",
    noDutyUpload.status === 403, noDutyUpload.status);
  const noDutyList = await get("/cargo/intake", trainee);
  check("nor read the shelf", noDutyList.status === 403, noDutyList.status);
  const noDutyCommit = await post(`/cargo/intake/${page2.j.id}/commit`,
    { shipmentId }, trainee);
  check("nor file a page against a cargo file", noDutyCommit.status === 403, noDutyCommit.status);
  const anonymous = await get("/cargo/intake", null);
  check("no token, no shelf", anonymous.status === 401, anonymous.status);

  if (foreignSeat) {
    const strangerToken = await mint(foreignSeat.id, "director", foreignSeat.tenant_id);
    const strangerRead = await get(`/cargo/intake/${d1.id}`, strangerToken);
    check("another company's director gets a 404 for this page",
      strangerRead.status === 404, strangerRead.status);
    const strangerShelf = await get("/cargo/intake", strangerToken);
    check("and their own shelf holds none of these pages",
      strangerShelf.status === 200
      && (strangerShelf.j?.drafts ?? []).every((d: any) => d.batch_id !== BATCH),
      strangerShelf.j?.drafts?.length);
    const strangerCommit = await post(`/cargo/intake/${page2.j.id}/commit`,
      { shipmentId }, strangerToken);
    check("and cannot file this company's page onto this company's file",
      strangerCommit.status === 404, strangerCommit);
  } else {
    check("a second company's director was available for the cross-tenant gates", false,
      { foreignTenantId });
  }
  const strangerShipment = await post(`/cargo/intake/${page2.j.id}/commit`,
    { shipmentId: randomUUID() });
  check("a commit to a file that is not on this desk is refused before a stamp",
    strangerShipment.status === 404, strangerShipment);

  // --- taking pages off, both ways -----------------------------------------------------------
  const removed = await del(`/cargo/intake/${page3.j.id}`);
  check("an unfiled page is taken off the shelf", removed.status === 200, removed);
  const retired = await oi(
    "select d.deleted_at is not null as draft, f.deleted_at is not null as paper" +
    " from cargo_intake_drafts d join documents f on f.id = d.document_id where d.id = $1",
    [page3.j.id]);
  check("and its paper goes with it — no draft left holding a number",
    retired.rows[0]?.draft === true && retired.rows[0]?.paper === true, retired.rows[0]);

  const page4 = await uploadPage({ batchId: BATCH, label: "Delivery note typed later",
    kind: "delivery_note", file: { bytes: PHOTOCOPY, name: "delivery-note.pdf", mime: "application/pdf" } });
  const vaultDelete = await del(`/documents/${page4.j.documentId}`);
  check("the paper can also be removed from the vault", vaultDelete.status === 200, vaultDelete);
  const cascade = await oi("select deleted_at is not null as gone from cargo_intake_drafts where id = $1",
    [page4.j.id]);
  check("and removing it frees the number it was holding",
    cascade.rows[0]?.gone === true, cascade.rows[0]);

  // --- the record of what happened -----------------------------------------------------------
  const audit = await oi(
    "select action, entity, entity_id, after from audit_logs where tenant_id = $1" +
    " and entity = 'cargo_intake' and ts > $2 order by ts", [tid, new Date(startedAt)]);
  const actions = audit.rows.map((r: any) => r.action);
  check("every write to the shelf is on the record",
    ["intake.page.uploaded", "intake.page.uploaded", "intake.page.uploaded",
      "intake.page.reread", "intake.page.labeled", "intake.page.committed",
      "intake.page.removed"].every((a) => actions.includes(a)), actions);
  const committed = audit.rows.find((r: any) => r.action === "intake.page.committed");
  check("the filing names the file it filed to, and its number",
    committed?.entity_id === d1.id && committed?.after?.fileNumber === opened.j?.fileNumber
    && committed?.after?.shipmentId === shipmentId, committed?.after);
  check("the record holds no consignee name, only what the desk did",
    !JSON.stringify(audit.rows.map((r: any) => r.after)).includes(CONSIGNEE), undefined);

  // --- teardown ------------------------------------------------------------------------------
  // The pages still on the shelf go back through the desk, because that is the path that also
  // frees the stored object. The sweep then takes the register rows: drafts before papers (the
  // register's own FK), papers before the files a filed page was hooked onto.
  const livePageIds = [page2, sameNumberElsewhere]
    .map((p: any) => p.j?.id).filter(Boolean) as string[];
  for (const id of livePageIds) {
    const r = await del(`/cargo/intake/${id}`);
    if (r.status !== 200) console.log(`note   intake page ${id} delete answered ${r.status}`);
  }
  await sweep();

  const residue = await oi(
    "select (select count(*) from cargo_intake_drafts where tenant_id = $1 and created_at > $3)::int as drafts," +
    " (select count(*) from documents where tenant_id = $1 and created_at > $3)::int as papers," +
    " (select count(*) from cargo_shipments where id = any($2::uuid[]))::int as files," +
    " (select count(*) from jobs where shipment_id = any($2::uuid[]))::int as jobs," +
    " (select count(*) from cargo_tasks where shipment_id = any($2::uuid[]))::int as tasks",
    [tid, fileIds, new Date(startedAt)]);
  check("the fixture left no business row behind",
    Object.values(residue.rows[0]).every((n) => Number(n) === 0), residue.rows[0]);

  await ownerRef.client!.end();
  console.log(failures === 0 ? "\ncargo intake smoke clean" : `\n${failures} FAILED CHECK(S)`);
}

main()
  .then(() => process.exit(failures ? 1 : 0))
  // A throw half-way through leaves pages holding numbers on a live desk, so the sweep runs
  // here too — one per table, each reported, each allowed to fail on its own.
  .catch(async (e) => { console.error(e); await sweep(); process.exit(1); });
