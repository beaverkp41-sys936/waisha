/**
 * #189 — the cargo paper kinds smoke (prevision, TDRN and the three warehouse slips).
 *
 * The office asked for seven names on a cargo file. Two of them (`delivery_note`, `invoice`)
 * were already stored under those words, so migration 117 widened `documents.kind` by five. That
 * is a CHECK the database owns, and three HTTP channels and four desks read it, so this smoke
 * proves the whole seam over real requests:
 *   1. the live constraint holds every kind it held before plus the five, and still refuses a
 *      near-miss at the row (a zod list that drifted from the CHECK would pass here and rot);
 *   2. a clerk can file each new kind on a cargo file through the vault, register it on the
 *      job's paper trail, and scan it on the intake shelf and commit it — and the kind survives
 *      the commit, which re-points the paper rather than rewriting it;
 *   3. the two walls that were deliberately kept up are still up: `attendance_proof` is not a
 *      shelf kind anywhere, and a job register is not a place to file a logo;
 *   4. a seat without the duty and a foreign tenant's file get nothing.
 * Fixtures live on their own `Paperprobe*` tenants and are wiped, with a residue count at the end.
 * Run: npx tsx scripts/smoke-cargo-paper-kinds.ts   (DNS_FALLBACK=1 if local DNS is broken)
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
  else { failures++; console.log("FAIL ", label, detail.slice(0, 240)); }
}

const NEW_KINDS = ["prevision", "tdrn", "warehouse_receipt", "warehouse_entry", "warehouse_exit"];
/** Every value `documents_kind_check` holds after 117 — copied from the migration, asserted below. */
const ALL_KINDS = ["logo", "avatar", "licence", "insurance", "inspection", "road_licence",
  "delivery_note", "invoice", "bill_of_lading", "packing_list", "contract", "other", "attachment",
  "receipt", "shipper_upload", "arrival_notice", "delivery_order", "declaration", "assessment",
  "release_note", "permit", "pod", "handover", "proforma", "attendance_proof",
  ...NEW_KINDS];

async function mint(sub: string, tid: string, roles: string[]) {
  return new SignJWT({ tid, sid: "00000000-7000-8000-0000-0000000000dd", typ: "director", roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("1h").sign(key);
}

/** One page with a real text layer: the intake reader must have something to pull. */
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

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const health = await fetch(API + "/health").then(r => r.json()).catch(() => null);
  if (!health) { console.error("API not running on :4000 — boot it first"); process.exit(1); }

  const startedAt = new Date();
  const STAMP = Date.now().toString().slice(-7);
  const T1 = randomUUID(), T2 = randomUUID();
  const clerk = randomUUID(), noDuty = randomUUID(), foreignSeat = randomUUID();
  const docIds: string[] = [];
  const draftIds: string[] = [];

  // audit_logs is deliberately absent: platform_auth.prevent_audit_mutation() raises on any delete,
  // so this run's lines stay as the record that it happened.
  const WIPE = ["job_handovers", "job_documents", "job_activity", "cargo_tasks", "job_stages",
    "jobs", "cargo_import_masters", "cargo_intake_drafts", "cargo_shipments", "alert_reads",
    "documents", "company_profiles", "sessions", "otp_codes", "password_resets"];

  // Pre-clean the residue of an earlier crashed run (fixtures are named Paperprobe*).
  const oldT = (await oi(
    `select id from tenants where name like 'Paperprobe%'`)).rows.map(r => r.id);
  if (oldT.length) {
    for (const t of WIPE) await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [oldT]);
    await oi(`delete from user_roles where user_id in
      (select id from users where tenant_id = any($1::uuid[]))`, [oldT]);
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [oldT]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [oldT]);
    console.log("pre-clean removed", oldT.length, "stale probe tenants");
  }

  /**
   * Teardown plus the proof it worked. A run that cannot build its fixture must still wipe: a
   * leftover Paperprobe tenant shows up in the office's own lists and silently reuses the
   * company_code the next run tries to insert.
   */
  async function wipe() {
    for (const t of [T1, T2]) {
      for (const table of WIPE) {
        await oi(`delete from ${table} where tenant_id = any($1::uuid[])`, [[t]]);
      }
      await oi(`delete from user_roles where user_id in (select id from users where tenant_id = $1)`, [t]);
      await oi(`delete from users where tenant_id = $1`, [t]);
      await oi(`delete from tenants where id = $1`, [t]);
    }
    const residue = await oi(
      `select (select count(*) from tenants where name like 'Paperprobe%') as tenants,
              (select count(*) from documents where file_name like '%' || $1 || '%') as paper,
              (select count(*) from cargo_shipments where consignee_name like 'Paperprobe%') as files,
              (select count(*) from users where full_name like 'Paperprobe%') as seats`, [STAMP]);
    const r0: any = residue.rows[0];
    check("teardown leaves no probe rows behind",
      Number(r0.tenants) === 0 && Number(r0.paper) === 0 && Number(r0.files) === 0 && Number(r0.seats) === 0,
      JSON.stringify(r0));
  }

  await oi(`insert into tenants (id, type, name) values ($1,'transporter','Paperprobe Clearing Ltd')`, [T1]);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter','Paperprobe Other Ltd')`, [T2]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, company_code)
            values ($1,$2,'Paperprobe Clearing Ltd','PP1')`, [randomUUID(), T1]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, company_code)
            values ($1,$2,'Paperprobe Other Ltd','PP2')`, [randomUUID(), T2]);
  for (const [u, t, name] of [[clerk, T1, "Paperprobe Clerk"], [noDuty, T1, "Paperprobe No Duty"],
    [foreignSeat, T2, "Paperprobe Foreign Director"]]) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status)
              values ($1,$2,'staff',$3,'active')`, [u, t, name]);
  }
  const directorRole = (await oi(
    `select id from roles where key = 'director' and tenant_id is null`)).rows[0]?.id;
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [clerk, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [foreignSeat, directorRole]);
  // noDuty holds no role at all: the refusals below must be about the duty, not the tenant.

  const tok = await mint(clerk, T1, ["director"]);
  const tokNoDuty = await mint(noDuty, T1, []);
  const tokForeign = await mint(foreignSeat, T2, ["director"]);

  const call = async (path: string, token: string, init: any = {}) => {
    const headers: any = { ...(init.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const opts: any = { ...init, headers };
    if (opts.body !== undefined && !(opts.body instanceof FormData) && !opts.method) opts.method = "POST";
    const res = await fetch(API + path, opts);
    let body: any = null;
    try { body = await res.json(); } catch { /* non-json */ }
    return { status: res.status, body };
  };
  const postJson = (b: any) => ({ method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b) });

  const BATCH = randomUUID();

  /** Vault upload — every metadata field before the file part, or the API never sees them. */
  const upload = (token: string, entityType: string, entityId: string, kind: string, name: string) => {
    const fd = new FormData();
    fd.append("entityType", entityType);
    if (entityId) fd.append("entityId", entityId);
    fd.append("kind", kind);
    fd.append("file", new Blob([makePdf([`PAPERPROBE ${kind} ${STAMP}`])],
      { type: "application/pdf" }), name);
    return call("/documents", token, { method: "POST", body: fd });
  };
  /** Intake page — same field-before-file rule, and the kind is the shelf slot's own. */
  const scanPage = async (token: string, kind: string, lines: string[], name: string) => {
    const fd = new FormData();
    fd.append("label", `Paperprobe ${kind} ${STAMP}`);
    fd.append("batchId", BATCH);
    fd.append("shipmentType", "import");
    fd.append("kind", kind);
    fd.append("file", new Blob([makePdf(lines)], { type: "application/pdf" }), name);
    const res = await fetch(API + "/cargo/intake", { method: "POST",
      headers: { Authorization: `Bearer ${token}` }, body: fd });
    const j: any = await res.json().catch(() => null);
    if (j?.id) draftIds.push(String(j.id));
    return { status: res.status, j };
  };

  // ---------- 1. The column, as the database actually holds it ----------
  const con = await oi(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'documents_kind_check' and conrelid = 'documents'::regclass`);
  const def = String(con.rows[0]?.def ?? "");
  const held = new Set((def.match(/'([^']+)'/g) ?? []).map(s => s.replace(/'/g, "")));
  check("the live CHECK exists on documents.kind", def.length > 0, def.slice(0, 120));
  check("it holds exactly the 30 kinds 117 leaves, no more and no fewer",
    held.size === 30 && ALL_KINDS.every(k => held.has(k)),
    `n=${held.size} missing=${ALL_KINDS.filter(k => !held.has(k)).join(",")}`);
  for (const k of NEW_KINDS) {
    check(`the column holds '${k}'`, held.has(k), def.slice(0, 80));
  }
  const before = [...held].filter(k => !NEW_KINDS.includes(k));
  check("nothing that was filed before 117 was dropped by the widening",
    before.length === 25 && before.includes("bill_of_lading") && before.includes("attendance_proof"),
    `n=${before.length}`);

  // The CHECK, not the zod list, is what a drifted enum would hide behind.
  let rawRejected = "";
  try {
    await oi(`insert into documents (id, tenant_id, entity_type, entity_id, kind, storage_path,
               file_name, mime_type, size_bytes)
             values ($1,$2,'tenant',$2,'warehouse_exitx','x/y','a.pdf','application/pdf',10)`,
      [randomUUID(), T1]);
  } catch (e: any) { rawRejected = String(e.code ?? ""); }
  check("a near-miss kind is refused by the row itself (23514)", rawRejected === "23514", rawRejected);
  let rawOk = false;
  try {
    const ins = await oi(
      `insert into documents (id, tenant_id, entity_type, entity_id, kind, storage_path,
         file_name, mime_type, size_bytes)
       values ($1,$2,'tenant',$2,'tdrn','paperprobe/raw','raw-tdrn.pdf','application/pdf',10)
       returning id`, [randomUUID(), T1]);
    rawOk = !!ins.rows[0]?.id;
    await oi(`delete from documents where id = $1`, [ins.rows[0].id]);
  } catch { rawOk = false; }
  check("and a real one lands, straight past every route", rawOk);

  // ---------- 2. The vault: filing the paper on a cargo file ----------
  const created = await call("/cargo", tok, postJson({
    shipmentType: "import", containerType: "40ft", containerCount: 1,
    containerNumbers: [`PPQU0000${STAMP.slice(-4)}`],
    consigneeName: `Paperprobe Consignee ${STAMP}`, consignorName: "Paperprobe Supplier",
    eta: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
  }));
  const shipment = String(created.body?.id ?? "");
  check("a cargo file to hang paper on", created.status === 201 && !!shipment,
    `[${created.status}] ${JSON.stringify(created.body).slice(0, 200)}`);
  // Without the file every section below is the same 400 wearing five different hats, and a uuid
  // cast of "" throws before teardown runs. Stop, wipe, and let the one failure speak.
  if (!shipment) {
    await wipe();
    await owner.end();
    console.log(`\n${failures} FAILURE(S) — no fixture file, the run stopped early.`);
    process.exit(1);
  }

  const filed: Record<string, string> = {};
  for (const kind of NEW_KINDS) {
    const r = await upload(tok, "shipment", shipment, kind, `${kind}-${STAMP}.pdf`);
    const id = String(r.body?.id ?? "");
    if (id) docIds.push(id);
    filed[kind] = id;
    const row = id ? await oi(
      `select kind, entity_type, entity_id, tenant_id, file_name, mime_type, deleted_at is not null as gone
       from documents where id = $1`, [id]) : { rows: [{}] };
    const d: any = row.rows[0];
    check(`the vault files '${kind}' on the file`,
      r.status === 201 && d?.kind === kind && d?.entity_type === "shipment" &&
        d?.entity_id === shipment && d?.tenant_id === T1 && d?.gone === false,
      `[${r.status}] ${JSON.stringify(r.body).slice(0, 140)}`);
  }

  const listAll = await call(`/documents?entityType=shipment&entityId=${shipment}`, tok);
  check("the file's own document list shows all five",
    listAll.status === 200 && NEW_KINDS.every(k =>
      (listAll.body ?? []).some((d: any) => d.kind === k)),
    `n=${(listAll.body ?? []).length}`);
  const listOne = await call(`/documents?entityType=shipment&entityId=${shipment}&kind=prevision`, tok);
  check("…and a kind filter narrows it to the prevision alone",
    listOne.status === 200 && (listOne.body ?? []).length === 1 &&
      listOne.body[0].kind === "prevision", `n=${(listOne.body ?? []).length}`);
  const vaultFilter = await call("/documents/vault?kind=warehouse_exit", tok);
  check("the vault's kind filter answers with the warehouse exit",
    vaultFilter.status === 200 && (vaultFilter.body ?? []).some((d: any) => d.id === filed.warehouse_exit),
    `[${vaultFilter.status}] n=${(vaultFilter.body ?? []).length}`);
  const badFilter = await call("/documents/vault?kind=warehouse_exitx", tok);
  check("a kind the column does not hold is a bad request, not an empty shelf",
    badFilter.status === 400, `[${badFilter.status}]`);

  const alibi = await upload(tok, "shipment", shipment, "attendance_proof", "alibi.pdf");
  check("the vault will not file an attendance proof — that kind only comes from a day",
    alibi.status === 400, `[${alibi.status}] ${JSON.stringify(alibi.body).slice(0, 120)}`);
  const noDutyUpload = await upload(tokNoDuty, "shipment", shipment, "tdrn", "tdrn.pdf");
  check("a seat without documents.create is refused the TDRN",
    noDutyUpload.status === 403, `[${noDutyUpload.status}]`);
  const crossUpload = await upload(tokForeign, "shipment", shipment, "tdrn", "tdrn.pdf");
  check("another company cannot file its paper onto this file",
    crossUpload.status === 404 || crossUpload.status === 403, `[${crossUpload.status}]`);
  const crossRead = await call(`/documents?entityType=shipment&entityId=${shipment}`, tokForeign);
  check("…and cannot read the file's paper back out of the vault",
    crossRead.status === 200 && (crossRead.body ?? []).length === 0,
    `[${crossRead.status}] n=${(crossRead.body ?? []).length}`);

  const audited = await oi(
    `select count(*)::int as n from audit_logs where tenant_id = $1 and entity = 'documents'
      and action = 'document.uploaded' and ts > $2`, [T1, startedAt]);
  check("every new paper filed is on the record", audited.rows[0].n >= 5, `n=${audited.rows[0].n}`);

  // ---------- 3. The job's paper trail ----------
  const jobsList = await call("/jobs", tok);
  const job = (jobsList.body ?? []).find((j: any) => j.shipment_id === shipment);
  const jobId = String(job?.id ?? "");
  check("the file's job is there to register paper against", !!jobId, `[${jobsList.status}]`);
  if (!jobId) {
    await wipe();
    await owner.end();
    console.log(`\n${failures} FAILURE(S) — no job to register paper on, the run stopped early.`);
    process.exit(1);
  }
  for (const kind of NEW_KINDS) {
    const r = await call(`/jobs/${jobId}/documents`, tok, postJson({
      title: `Paperprobe ${kind} ${STAMP}`, kind, direction: "received",
      fromParty: "Paperprobe Store", documentId: filed[kind]
    }));
    const row = await oi(
      `select j.kind, d.kind as filed_kind from job_documents j
         left join documents d on d.id = j.document_id
        where j.id = $1 and j.tenant_id = $2`, [String(r.body?.id ?? ""), T1]);
    check(`the job register takes '${kind}' and keeps it on both rows`,
      r.status === 201 && row.rows[0]?.kind === kind && row.rows[0]?.filed_kind === kind,
      `[${r.status}] ${JSON.stringify(row.rows[0] ?? {})}`);
  }
  const jobLogo = await call(`/jobs/${jobId}/documents`, tok, postJson({ title: "A logo", kind: "logo" }));
  check("a job's register is not a place to file a logo", jobLogo.status === 400, `[${jobLogo.status}]`);
  const jobDrift = await call(`/jobs/${jobId}/documents`, tok,
    postJson({ title: "Almost", kind: "warehouse_exitx" }));
  check("…and not a place to file a kind the column does not hold",
    jobDrift.status === 400, `[${jobDrift.status}]`);

  // ---------- 4. The intake shelf ----------
  const scanned = await scanPage(tok, "tdrn",
    ["TANZANIA REVENUE AUTHORITY", "TDRN — TRANSIT DECLARATION AND RELEASE NOTE",
      "Notice No: TRN-2026-" + STAMP, `Consignee: Paperprobe Consignee ${STAMP}`,
      "Container No: PPQU0000" + STAMP.slice(-4), "ETA: 2026-11-05"], "tdrn-scan.pdf");

  const tdrnDoc = String(scanned.j?.documentId ?? "");
  check("the shelf scans a TDRN page", scanned.status < 300 && !!tdrnDoc,
    `[${scanned.status}] ${JSON.stringify(scanned.j).slice(0, 140)}`);
  if (tdrnDoc) {
    const scanDoc = await oi(
      `select kind, entity_type from documents where id = $1 and tenant_id = $2`, [tdrnDoc, T1]);
    check("…and files it as a TDRN on the shelf", scanDoc.rows[0]?.kind === "tdrn" &&
      scanDoc.rows[0]?.entity_type === "cargo_intake", JSON.stringify(scanDoc.rows[0] ?? {}));

    const scanned2 = await scanPage(tok, "warehouse_entry",
      ["WAREHOUSE ENTRY NOTE", `Goods: cement, 400 bags`, `Ref: WE-${STAMP}`], "entry-scan.pdf");
    check("…a warehouse entry too", scanned2.status < 300 && scanned2.j?.documentId,
      `[${scanned2.status}]`);

    const committed = await call(`/cargo/intake/${scanned.j.id}/commit`, tok,
      postJson({ shipmentId: shipment }));
    const afterCommit = await oi(
      `select kind, entity_type, entity_id from documents where id = $1`, [tdrnDoc]);
    check("committing the page moves it onto the file and keeps its kind",
      committed.status === 200 && afterCommit.rows[0]?.kind === "tdrn" &&
        afterCommit.rows[0]?.entity_type === "shipment" &&
        afterCommit.rows[0]?.entity_id === shipment,
      `[${committed.status}] ${JSON.stringify(afterCommit.rows[0] ?? {})}`);
  } else {
    check("the shelf files a scanned TDRN as a TDRN", false, "the page never reached the shelf");
    check("committing the page moves it onto the file and keeps its kind", false, "no page to commit");
  }

  const shelfDrift = await scanPage(tok, "warehouse_exitx", ["nothing"], "bad.pdf");
  check("a near-miss kind on the shelf is refused", shelfDrift.status === 400, `[${shelfDrift.status}]`);
  const shelfAlibi = await scanPage(tok, "attendance_proof", ["nothing"], "alibi.pdf");
  check("…and so is a kind no shelf may hold", shelfAlibi.status === 400, `[${shelfAlibi.status}]`);

  // ---------- 5. Nothing outside this run was touched ----------
  const foreignFiles = await oi(
    `select count(*)::int as n from documents where tenant_id = $2 and entity_type = 'shipment'
      and entity_id = $1`, [shipment, T2]);
  check("the other company's own vault stayed empty of this file's paper",
    foreignFiles.rows[0].n === 0, `n=${foreignFiles.rows[0].n}`);

  await wipe();
  await owner.end();
  console.log(failures ? `\n${failures} FAILURE(S)` : `\nAll #189 cargo-paper checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => { console.error("SMOKE CRASHED:", e); process.exit(2); });
