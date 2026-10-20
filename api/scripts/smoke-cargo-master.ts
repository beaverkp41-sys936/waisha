/**
 * End-to-end smoke for the import master document (#187, migration 111) on a running API at :4000.
 *
 * 111 says what a signed cover sheet is: three papers of one cargo file, named by the number printed
 * on them, frozen once a seat holding `shipments.declare` signs them, and re-pointable afterwards
 * because a bill of lading turns up a week late. The routes are the desk a clerk walks up to, so the
 * questions this script asks are the ones a desk can get wrong: does the same duty that edits a file
 * also sign it (it must not), does a refusal leave a half-sheet behind (it must not), does a signed
 * figure come back changed through a body that says it did not (it must not), does the archive hold
 * the bytes that were uploaded rather than a promise about them, and does a neighbour get a 404 for
 * a file number it can see in the wrong company's list.
 *
 * Two companies are planted. The sheet is filled, signed, re-pointed and bundled over HTTP and every
 * claim is read back from the register itself; the database's own guards are tested by writing
 * around the API as the migration owner, because a trigger nobody tries to bypass is a trigger
 * nobody proved. The archive is opened here by its central directory, its CRCs recomputed, and its
 * SHA256SUMS.txt checked line by line — and again by `unzip -t` when that program is on the machine.
 *
 * Run: npx tsx scripts/smoke-cargo-master.ts   (with the API booted and 111 applied)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const COMPANY = `Master Smoke ${STAMP}`;
const OTHER = `Master Stranger ${STAMP}`;
const FILE_A = `4MSR-${STAMP}-2026`;
const FILE_B = `4MSR-${STAMP}-B-2026`;
const FILE_C = `4STR-${STAMP}-2026`;
const FILE_NO = "INV-2026-0188";
const PL_NO = "PL-0188";
const BILL_NO = "MEDUX-1188245";
const INVOICE_PDF = `invoice-${STAMP}.pdf`;

const DAY = 24 * 3600 * 1000;
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (s: string, n: number) => iso(new Date(new Date(`${s}T12:00:00`).getTime() + n * DAY));
const TODAY = iso(new Date());
const YESTERDAY = shift(TODAY, -1);

async function mint(sub: string, tid: string, roleKey: string) {
  return new SignJWT({ tid, sid: "00000000-7000-7000-8000-0000000000bb", typ: roleKey, roles: [roleKey] })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("30m").sign(key);
}

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** The bundle answers as bytes on a hijacked socket; a JSON reader would mangle it. */
async function callRaw(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, buf, headers: res.headers };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function refusedAs(r: { status: number; json: any }, status: number, code: string, re?: RegExp) {
  return r.status === status && r.json?.error?.code === code
    && (!re || re.test(String(r.json?.error?.message ?? "")));
}
const field = (j: any) => (j?.error?.details ?? []).map((d: any) => d.field);
const msg = (r: { json: any }) => String(r.json?.error?.message ?? "");
const n = (v: unknown) => (v === null || v === undefined ? NaN : Number(v));
const payload = (label: string) =>
  Buffer.from(`%PDF-1.4\n${label} of ${FILE_A} ${STAMP}\n%%EOF\n`, "utf8");

/** Standard ZIP central directory: the only trustworthy list of what an archive holds. */
function zipRead(buf: Buffer): Map<string, { data: Buffer; crc: number }> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, { data: Buffer; crc: number }>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central record ${i} is not a signature`);
    const size = buf.readUInt32LE(p + 24);
    const crc = buf.readUInt32LE(p + 16);
    const name = buf.subarray(p + 46, p + 46 + buf.readUInt16LE(p + 28)).toString("utf8");
    const next = p + 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    // A ZIP's compression method is two bytes; reading four here picks up the MS-DOS mod time and
    // reports a stored entry as deflated.
    if (buf.readUInt16LE(p + 10) !== 0) throw new Error(`${name} is deflated, and this writer only stores`);
    const lho = buf.readUInt32LE(p + 42);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`local header for ${name} is missing`);
    const at = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    out.set(name, { data: buf.subarray(at, at + size), crc });
    p = next;
  }
  return out;
}
/** A throw out of the archive reader would end the run before teardown, so later reads report and continue. */
function zipSafe(buf: Buffer, label: string) {
  try { return { entries: zipRead(buf), openErr: null }; }
  catch (e: any) { return { entries: new Map<string, { data: Buffer; crc: number }>(), openErr: String(e?.message ?? e) }; }
}
const TABLE = [Uint32Array.from({ length: 256 }, (_v, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
})];
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[0][(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, p: unknown[] = []) => owner.query(sql, p as any[]);

  const sweep = async (tid: string) => {
    for (const sql of [
      `delete from cargo_import_masters where tenant_id = $1`,
      `delete from documents where tenant_id = $1`,
      `delete from cargo_tasks where tenant_id = $1`,
      `delete from cargo_shipments where tenant_id = $1`,
      `delete from user_roles where user_id in (select id from users where tenant_id = $1)`,
      `delete from roles where tenant_id = $1`,
      `delete from sessions where user_id in (select id from users where tenant_id = $1)`,
      `delete from users where tenant_id = $1`,
      `delete from tenants where id = $1`
    ]) {
      await oi(sql, [tid]).catch((e: any) => console.log(`sweep note: ${String(e.message).slice(0, 90)}`));
    }
  };
  const orphans = await oi(
    `select id from tenants where name ~ '^Master (Smoke|Stranger) [0-9]{8}$'`);
  if (orphans.rowCount) {
    console.log(`sweeping ${orphans.rowCount} fixture company(ies) left by an earlier run`);
    for (const r of orphans.rows) await sweep(r.id as string);
  }

  const T = randomUUID();
  const T2 = randomUUID();
  const roleOf = async (k: string) => {
    const r = await oi(`select id from roles where key = $1 and tenant_id is null`, [k]);
    if (!r.rowCount) throw new Error(`No global ${k} role`);
    return r.rows[0].id as string;
  };
  const uploaderKey = (await oi(
    `select r.key from roles r join role_permissions rp on rp.role_id = r.id
      where r.tenant_id is null and rp.permission_key = 'documents.create'
      order by r.key limit 1`)).rows[0]?.key as string | undefined;
  if (!uploaderKey) throw new Error("No global role holds documents.create");

  const roles = {
    dir: await roleOf("director"), aud: await roleOf("auditor"),
    dsp: await roleOf("dispatcher"), upl: await roleOf(uploaderKey)
  };
  for (const [tid, name] of [[T, COMPANY], [T2, OTHER]] as [string, string][]) {
    await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'active')`,
      [tid, name]);
  }

  const uid: Record<string, string> = {};
  const seats: Record<string, { id: string; roleKey: string }> = {};
  const seat = async (who: string, tid: string, name: string, roleId: string, roleKey: string) => {
    const u = await oi(`insert into users (tenant_id, user_type, email, status, full_name)
                        values ($1,'staff',$2,'active',$3) returning id`,
      [tid, `${who}.ms.${STAMP}@example.org`, name]);
    const id = u.rows[0].id as string;
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, roleId]);
    uid[who] = id; seats[who] = { id, roleKey };
    return id;
  };
  await seat("dir", T, "Baraka Boss", roles.dir, "director");
  await seat("aud", T, "Daudi Auditor", roles.aud, "auditor");
  await seat("dsp", T, "Saida Dispatcher", roles.dsp, "dispatcher");
  await seat("upl", T, "Grace Records", roles.upl, uploaderKey);
  await seat("dir2", T2, "Stranger Boss", roles.dir, "director");

  // A clearing clerk of this company: it may fill the sheet and must not sign it. 111 gave the
  // signature to exactly the seats that can edit a file, so the only way to prove the second door
  // is a real one is a tenant role that holds the first and leaves the second off.
  const clerkRole = (await oi(
    `insert into roles (id, tenant_id, key, name, is_system)
     values (gen_random_uuid(),$1,'clearing_clerk','Clearing clerk (fixture)',false)
     returning id`, [T])).rows[0].id as string;
  for (const duty of ["shipments.view", "shipments.edit"]) {
    await oi(`insert into role_permissions (role_id, permission_key) values ($1,$2)
              on conflict do nothing`, [clerkRole, duty]);
  }
  await seat("clk", T, "Amina Ya Keragi", clerkRole, "clearing_clerk");

  const tok: Record<string, string> = {};
  for (const who of Object.keys(seats)) {
    tok[who] = await mint(seats[who].id, seats[who].id === uid.dir2 ? T2 : T, seats[who].roleKey);
  }

  // --- the cargo files, planted -------------------------------------------------------------
  const SHIP = `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year,
      shipment_type, container_type, consignee_name, consignor_name, cargo_description,
      shipping_line, bill_number, weight_tonnes, cbm, eta, stage, status, payment_status,
      notes, created_by, updated_by)
    values ($1,$2,$3,$4,2026,'import','40ft',$5,$6,'Machine spare parts',$7,$8,12.5,28.4,
      $9,'customs','open','unpaid',$10,$11,$11)`;
  const S1 = randomUUID(), S2 = randomUUID(), S3 = randomUUID();
  const seq = 4_100_000 + Math.floor(Math.random() * 80_000);
  await oi(SHIP, [S1, T, FILE_A, seq, `Master Smoke Consignee ${STAMP}`, "Master Smoke Consignor",
    "Maersk East Africa", BILL_NO, YESTERDAY, "the file the master is signed on", uid.dir]);
  await oi(SHIP, [S2, T, FILE_B, seq + 1, "Second Master Consignee", "Master Smoke Consignor",
    "MSC", null, YESTERDAY, "a file with no sheet at all", uid.dir]);
  await oi(SHIP, [S3, T2, FILE_C, seq + 2, "Stranger Consignee", "Stranger Consignor",
    "CMA CGM", null, YESTERDAY, "another company's import", uid.dir2]);

  // --- the papers, uploaded through the vault -----------------------------------------------
  const upload = async (shipmentId: string, kind: string, name: string) => {
    const fd = new FormData();
    fd.append("entityType", "shipment");
    fd.append("entityId", shipmentId);
    fd.append("kind", kind);
    fd.append("file", new Blob([payload(name)], { type: "application/pdf" }), name);
    return call("/documents", tok.upl, { method: "POST", body: fd });
  };
  const up1 = await upload(S1, "invoice", INVOICE_PDF);
  const up2 = await upload(S1, "packing_list", `packing-${STAMP}.pdf`);
  const up3 = await upload(S1, "bill_of_lading", `bill-${STAMP}.pdf`);
  const up4 = await upload(S1, "contract", `contract-${STAMP}.pdf`);
  const up5 = await upload(S2, "invoice", `other-file-${STAMP}.pdf`);
  const up6 = await upload(S3, "invoice", `stranger-${STAMP}.pdf`);
  const stored = up1.status === 201;
  if (!stored) {
    console.log(`note  this API has no file store (upload answered ${up1.status}), so the paper and`,
      "bundle halves below read the register's pointers, not stored bytes.");
  }
  check("the vault will not file a paper onto a neighbour's cargo file for this company",
    up6.status >= 400, { status: up6.status, message: msg(up6) });

  // The neighbour needs a paper of its own for the cross-tenant guards below to point at. It cannot
  // come through the vault — that is what the line just above proves — so it is planted as the
  // migration owner, which is also how it would exist in reality: written by its own company.
  const strangerPaper = up6.status === 201
    ? (up6.json?.id as string)
    : (await oi(`insert into documents (tenant_id, entity_type, entity_id, kind, file_name,
                                        mime_type, size_bytes, storage_path, uploaded_by)
                 values ($1,'shipment',$2,'invoice',$3,'application/pdf',40,$4,$5) returning id`,
      [T2, S3, `stranger-${STAMP}.pdf`, `smoke/stranger-${STAMP}.pdf`, uid.dir2])).rows[0].id as string;

  const D = {
    invoice: up1.json?.id as string | undefined,
    packing: up2.json?.id as string | undefined,
    bill: up3.json?.id as string | undefined,
    contract: up4.json?.id as string | undefined,
    otherFile: up5.json?.id as string | undefined,
    stranger: strangerPaper
  };

  const master = (who: string, body: Record<string, unknown>) =>
    call(`/cargo/${S1}/master`, tok[who], { method: "PUT", body: JSON.stringify(body) });
  const read = (who: string, id = S1) => call(`/cargo/${id}/master`, tok[who]);
  const sign = (who: string, id = S1) =>
    call(`/cargo/${id}/master/declare`, tok[who], { method: "POST", body: "{}" });

  const FIGURES = {
    invoiceNumber: FILE_NO, invoiceDate: YESTERDAY, invoiceCurrency: "usd", invoiceValue: 18450.5,
    packingListNumber: PL_NO, packagesCount: 48, packageType: "pallets",
    grossWeightKg: 12500.4, netWeightKg: 11800,
    billKind: "bill_of_lading", billNumber: BILL_NO, billDate: YESTERDAY,
    invoiceDocumentId: D.invoice, packingDocumentId: D.packing, billDocumentId: D.bill,
    notes: "Packing list emailed by the agent; original to follow at the ICD."
  };

  // =========================================================================
  console.log(`\n--- 1 · the doors (fixture ${COMPANY}, uploader role ${uploaderKey}) ---`);
  // =========================================================================

  for (const [label, path, init] of [
    [`GET /cargo/:id/master`, `/cargo/${S1}/master`, { method: "GET" }],
    [`PUT /cargo/:id/master`, `/cargo/${S1}/master`, { method: "PUT", body: "{}" }],
    [`POST /cargo/:id/master/declare`, `/cargo/${S1}/master/declare`, { method: "POST", body: "{}" }],
    [`POST /cargo/:id/master/bundle`, `/cargo/${S1}/master/bundle`, { method: "POST" }]
  ] as [string, string, RequestInit][]) {
    const r = await call(path, null, init);
    check(`${label} refuses a tokenless call`, r.status === 401, { status: r.status, body: r.json });
  }

  const shape = await read("dir");
  check("the sheet answer carries the file, the row, the papers, the state, the checks and the buttons",
    shape.status === 200
    && Object.keys(shape.json).sort().join(",") === "can,file,master,papers,state,warnings",
    { status: shape.status, keys: Object.keys(shape.json).sort().join(",") });
  check("…the file is an import on the customs stage, and no sheet has been written to it yet",
    shape.json?.file?.file_number === FILE_A && shape.json?.file?.shipment_type === "import"
    && shape.json?.master === null && shape.json?.state?.has_master === false
    && shape.json?.state?.declared === false && shape.json?.state?.can_sign === false
    && shape.json?.warnings?.length === 0,
    { file: shape.json?.file, state: shape.json?.state });
  const listedPapers = shape.json?.papers ?? [];
  check("…the four papers already on the file are listed for the pickers, newest first",
    listedPapers.length === (stored ? 4 : 0)
    && (!stored || listedPapers.some((p: any) => p.file_name === INVOICE_PDF))
    && (!stored || String(listedPapers[0]?.created_at) >= String(listedPapers.at(-1)?.created_at)),
    { length: listedPapers.length, newest: listedPapers[0]?.file_name,
      oldest: listedPapers.at(-1)?.file_name });
  check("…and a paper is described by what a clerk picks it by, never by where its bytes live",
    !stored || Object.keys((shape.json.papers ?? [])[0]).sort().join(",")
      === "created_at,file_name,id,kind,mime_type,size_bytes",
    Object.keys((shape.json.papers ?? [])[0] ?? {}).sort().join(","));
  check("…the director may fill it, sign it and bundle it",
    shape.json?.can?.edit === true && shape.json?.can?.declare === true
    && shape.json?.can?.bundle === true, shape.json?.can);

  const audShape = await read("aud");
  check("an auditor reads the same sheet and is offered the bundle but neither pen nor signature",
    audShape.status === 200 && JSON.stringify(audShape.json?.file) === JSON.stringify(shape.json?.file)
    && audShape.json?.can?.edit === false && audShape.json?.can?.declare === false
    && audShape.json?.can?.bundle === true, audShape.json?.can);
  const dspShape = await read("dsp");
  check("a dispatcher reads it too, and is offered nothing at all",
    dspShape.status === 200 && dspShape.json?.can?.edit === false
    && dspShape.json?.can?.declare === false && dspShape.json?.can?.bundle === false,
    dspShape.json?.can);

  const foreign = await read("dir2");
  check("a neighbour that guesses this file's id is told there is no such file",
    refusedAs(foreign, 404, "NOT_FOUND"), { status: foreign.status, message: msg(foreign) });
  const bogus = await read("dir", randomUUID());
  check("…so is a number that was never a cargo file at all",
    refusedAs(bogus, 404, "NOT_FOUND"), bogus.status);
  const notUuid = await call(`/cargo/not-a-file/master`, tok.dir, { method: "GET" });
  check("a file that is not an id is refused before the database is asked",
    notUuid.status === 400, { status: notUuid.status });

  for (const [label, path, init] of [
    ["fill", `/cargo/${S1}/master`, { method: "PUT", body: JSON.stringify({ notes: "x" }) }],
    ["sign", `/cargo/${S1}/master/declare`, { method: "POST", body: "{}" }]
  ] as [string, string, RequestInit][]) {
    for (const who of ["aud", "dsp"]) {
      const r = await call(path, tok[who], init);
      check(`a ${who} seat cannot ${label} a master`,
        refusedAs(r, 403, "FORBIDDEN"), { status: r.status, message: msg(r) });
    }
  }
  const dspBundle = await call(`/cargo/${S1}/master/bundle`, tok.dsp, { method: "POST" });
  check("…nor pull the archive down, which is the export key's own door",
    refusedAs(dspBundle, 403, "FORBIDDEN"), { status: dspBundle.status, message: msg(dspBundle) });
  const earlyBundle = await call(`/cargo/${S1}/master/bundle`, tok.aud, { method: "POST" });
  check("an auditor with the export key still has nothing to bundle while the file has no sheet",
    refusedAs(earlyBundle, 409, "CONFLICT", /no master sheet/),
    { status: earlyBundle.status, message: msg(earlyBundle) });
  const earlySign = await sign("dir");
  check("a director cannot sign a sheet that has never been saved",
    refusedAs(earlySign, 409, "CONFLICT", /no master sheet to sign/),
    { status: earlySign.status, message: msg(earlySign) });

  // =========================================================================
  console.log("\n--- 2 · what a sheet refuses to be ---");
  // =========================================================================

  const netHigh = await master("dir", { netWeightKg: 13000, grossWeightKg: 12000 });
  check("a net above the gross is refused on the net box, because the packing list says both",
    refusedAs(netHigh, 400, "VALIDATION_FAILED", /net weight cannot be above/)
    && field(netHigh.json).includes("netWeightKg"),
    { status: netHigh.status, fields: field(netHigh.json), message: msg(netHigh) });

  const loneValue = await master("dir", { invoiceValue: 900000 });
  check("a value with no number and currency beside it is refused on the value box",
    refusedAs(loneValue, 400, "VALIDATION_FAILED", /is a guess/)
    && field(loneValue.json).includes("invoiceValue"),
    { status: loneValue.status, fields: field(loneValue.json) });

  const shortCurrency = await master("dir", { invoiceCurrency: "US" });
  check("a two-letter currency never reaches the register",
    shortCurrency.status === 400, { status: shortCurrency.status, message: msg(shortCurrency) });

  const invented = await master("dir", { invoiceDocumentId: randomUUID() });
  check("the invoice line refuses a paper id that is nothing at all",
    refusedAs(invented, 400, "VALIDATION_FAILED", /already on this cargo file/)
    && field(invented.json).includes("invoiceDocumentId"),
    { status: invented.status, fields: field(invented.json), message: msg(invented) });

  if (stored) {
    const onOtherFile = await master("dir", { invoiceDocumentId: D.otherFile });
    check("…or one that is a real paper of this company on a different cargo file",
      refusedAs(onOtherFile, 400, "VALIDATION_FAILED", /already on this cargo file/)
      && field(onOtherFile.json).includes("invoiceDocumentId"),
      { status: onOtherFile.status, message: msg(onOtherFile) });
  } else {
    console.log("note  no store, so the refusal about a paper on another of this company's files cannot be planted");
  }
  const borrowed = await master("dir", { billDocumentId: D.stranger });
  check("…or one that belongs to another company — the composite key makes it unpointable",
    refusedAs(borrowed, 400, "VALIDATION_FAILED", /already on this cargo file/)
    && field(borrowed.json).includes("billDocumentId"),
    { status: borrowed.status, message: msg(borrowed) });

  const rowCount0 = await oi(`select count(*)::int as n from cargo_import_masters where tenant_id = $1`, [T]);
  check("and not one of those refusals left half a sheet in the register",
    rowCount0.rows[0].n === 0, rowCount0.rows[0]);

  // =========================================================================
  console.log("\n--- 3 · filling it in, one desk at a time ---");
  // =========================================================================

  const clerkFirst = await master("clk", { packingListNumber: PL_NO, packagesCount: 48,
    packageType: "pallets", grossWeightKg: 12500.4 });
  check("the clearing clerk with no signature key can open the sheet and fill the packing list",
    clerkFirst.status === 200 && clerkFirst.json?.state?.has_master === true
    && clerkFirst.json?.can?.declare === false
    && clerkFirst.json?.master?.packing_list_number === PL_NO,
    { status: clerkFirst.status, message: msg(clerkFirst) });
  const opened = await oi(
    `select id, tenant_id, shipment_id, invoice_number, packing_list_number, packages_count,
            gross_weight_kg, net_weight_kg, declared_at, declared_by, created_by, updated_by
       from cargo_import_masters where tenant_id = $1`, [T]);
  check("…one row, filed against this file and this company, with nothing signed",
    opened.rowCount === 1 && opened.rows[0]?.shipment_id === S1
    && opened.rows[0]?.invoice_number === null
    && n(opened.rows[0]?.packages_count) === 48 && n(opened.rows[0]?.gross_weight_kg) === 12500.4
    && !opened.rows[0]?.declared_at && opened.rows[0]?.created_by === uid.clk, opened.rows[0]);
  const openAudit = await oi(
    `select action, "after"->>'file_number' as fn, "after"->'fields' as fields
       from audit_logs where tenant_id = $1 and entity = 'cargo_import_masters'`, [T]);
  check("…the opening is audited as its own act with the boxes it wrote",
    openAudit.rowCount === 1 && openAudit.rows[0]?.action === "master.opened"
    && openAudit.rows[0]?.fn === FILE_A
    && String(openAudit.rows[0]?.fields).includes("packing_list_number"), openAudit.rows[0]);

  const clerkSigns = await sign("clk");
  check("…and the same seat is refused the signature by the duty, not by the sheet's shape",
    refusedAs(clerkSigns, 403, "FORBIDDEN"),
    { status: clerkSigns.status, message: msg(clerkSigns) });
  const stillUnsigned = await oi(`select declared_at from cargo_import_masters where tenant_id = $1`, [T]);
  check("…the refusal wrote no stamp", !stillUnsigned.rows[0]?.declared_at, stillUnsigned.rows[0]);

  const half = await master("dir", { invoiceNumber: FILE_NO, invoiceDate: YESTERDAY,
    invoiceCurrency: "usd", invoiceValue: 18450.5, invoiceDocumentId: D.invoice });
  check("the director adds the invoice half, and the currency arrives upper-cased by the register",
    half.status === 200 && half.json?.master?.invoice_currency === "USD"
    && half.json?.master?.invoice_number === FILE_NO
    && half.json?.master?.invoice_date === YESTERDAY, half.json?.master);
  const gapsHalf = String(half.json?.state?.gaps ?? "");
  check("…a sheet this incomplete is not signable, and the desk is told the whole list in one breath",
    half.json?.state?.complete === false && half.json?.state?.can_sign === false
    && /packing list paper/.test(gapsHalf)
    && /kind of transport document/.test(gapsHalf)
    && /bill or air waybill paper/.test(gapsHalf)
    && !/invoice number/.test(gapsHalf) && !/invoice paper/.test(gapsHalf)
    && !/packing list number/.test(gapsHalf) && !/package count/.test(gapsHalf)
    && !/gross weight/.test(gapsHalf),
    { gaps: gapsHalf, state: half.json?.state });
  const keptFigures = await oi(
    `select packing_list_number, packages_count, gross_weight_kg, invoice_document_id
       from cargo_import_masters where tenant_id = $1`, [T]);
  check("…and a write that named only the invoice left the clerk's packing figures alone",
    keptFigures.rows[0]?.packing_list_number === PL_NO
    && n(keptFigures.rows[0]?.packages_count) === 48
    && n(keptFigures.rows[0]?.gross_weight_kg) === 12500.4, keptFigures.rows[0]);

  if (stored) {
    const wrongKind = await master("dir", { invoiceDocumentId: D.contract });
    check("a scan filed as a contract can be pointed at the invoice line — the clerk's own archive",
      wrongKind.status === 200 && wrongKind.json?.master?.invoice_document_id === D.contract,
      { status: wrongKind.status, message: msg(wrongKind) });
    check("…and the desk says out loud that the paper does not read like an invoice",
      (wrongKind.json?.warnings ?? []).some((w: string) =>
        /filed under the kind "contract"/.test(w) && /invoice/i.test(w)),
      wrongKind.json?.warnings);
    await master("dir", { invoiceDocumentId: D.invoice });
  }
  const cleanKind = await read("dir");
  check("…point it back at the invoice and the check disappears",
    (cleanKind.json?.warnings ?? []).length === 0, cleanKind.json?.warnings);

  if (stored) {
    const mistyped = await master("dir", { billKind: "bill_of_lading", billNumber: "MEDUX-1188246",
      billDate: YESTERDAY, billDocumentId: D.bill });
    check("a bill number one digit off the cargo file's own is a warning, not a refusal",
      mistyped.status === 200 && (mistyped.json?.warnings ?? []).some((w: string) =>
        /MEDUX-1188246/.test(w) && /MEDUX-1188245/.test(w) && /mistyped/.test(w)),
      mistyped.json?.warnings);
    const agreed = await master("dir", { billNumber: BILL_NO });
    check("…corrected on the sheet, the two agree and the check is gone",
      agreed.status === 200 && (agreed.json?.warnings ?? []).length === 0, agreed.json?.warnings);
  } else {
    await master("dir", { billKind: "bill_of_lading", billNumber: BILL_NO, billDate: YESTERDAY });
  }

  const cleared = await master("dir", { packageType: null });
  check("a box sent as null is cleared, and one left out of the body is kept",
    cleared.status === 200 && cleared.json?.master?.package_type === null
    && cleared.json?.master?.packages_count === 48, cleared.json?.master);
  await master("dir", { packageType: "pallets" });

  const noteOnly = await master("dir", { notes: "Packing list emailed by the agent." });
  check("the clerk's note is its own write",
    noteOnly.status === 200 && noteOnly.json?.master?.notes === "Packing list emailed by the agent.",
    noteOnly.json?.master?.notes);

  const twoRows = await oi(`select count(*)::int as n from cargo_import_masters where tenant_id = $1`, [T]);
  check("…and eleven writes to one file is still one sheet, not two",
    twoRows.rows[0].n === 1, twoRows.rows[0]);

  const listDraft = await call(`/cargo?search=${encodeURIComponent(FILE_A)}`, tok.dir, { method: "GET" });
  const rowA = (listDraft.json as any[])?.find?.((r) => r.id === S1);
  check("the cargo register carries the sheet's state on its own row, so a desk can see who has declared",
    listDraft.status === 200 && rowA?.master_state === "draft", { row: rowA?.master_state });
  const rowB = (await call(`/cargo?search=${encodeURIComponent(FILE_B)}`, tok.dir, { method: "GET" }))
    .json as any[];
  check("…a file nobody has opened answers null rather than a phantom state",
    rowB?.[0]?.master_state === null, rowB?.[0]?.master_state);

  // =========================================================================
  console.log("\n--- 4 · signing it ---");
  // =========================================================================

  const signedTooEarly = await sign("dir");
  check("the sheet refuses a signature while the transport document is not whole",
    refusedAs(signedTooEarly, 400, "VALIDATION_FAILED", /cannot be signed without/),
    { status: signedTooEarly.status, message: msg(signedTooEarly) });
  check("…naming every gap in the clerk's own words, and nothing that is already filled in",
    /packing list paper/.test(msg(signedTooEarly))
    && !/bill or air waybill paper/.test(msg(signedTooEarly))
    && !/invoice number/.test(msg(signedTooEarly))
    && !/gross weight/.test(msg(signedTooEarly)), msg(signedTooEarly));
  const noStampYet = await oi(`select declared_at, declared_by from cargo_import_masters where tenant_id = $1`, [T]);
  check("…the refusal left no signature on the row",
    !noStampYet.rows[0]?.declared_at && !noStampYet.rows[0]?.declared_by, noStampYet.rows[0]);

  if (!stored) {
    console.log("note  no file store, so the three papers cannot be pointed at real bytes and the",
      "sheet cannot be completed — the signature half below is skipped, not faked.");
  } else {
    const whole = await master("dir", { ...FIGURES, notes: "Packing list emailed by the agent." });
    check("filled to the last box, the sheet reads whole and the button opens",
      whole.status === 200 && whole.json?.state?.complete === true
      && whole.json?.state?.gaps === null && whole.json?.state?.can_sign === true
      && whole.json?.state?.papers_named === 3, whole.json?.state);

    const signed = await sign("dir");
    const stamp = await oi(
      `select declared_at, declared_by, updated_by, invoice_value, net_weight_kg,
              to_char(declared_at at time zone 'Africa/Dar_es_Salaam','YYYY-MM-DD') as declared_day
         from cargo_import_masters where tenant_id = $1`, [T]);
    check("a director holding the signature key signs the declaration",
      signed.status === 200 && signed.json?.state?.declared === true
      && signed.json?.state?.declared_on === stamp.rows[0]?.declared_day
      && /^\d{4}-\d{2}-\d{2}$/.test(String(signed.json?.state?.declared_on ?? ""))
      && signed.json?.state?.declared_by === "Baraka Boss"
      && signed.json?.state?.can_sign === false,
      { status: signed.status, declared_on: signed.json?.state?.declared_on,
        declared_day: stamp.rows[0]?.declared_day, message: msg(signed) });
    check("…the stamp is this seat and the figures it froze are the ones typed",
      stamp.rows[0]?.declared_at instanceof Date && stamp.rows[0]?.declared_at !== null
      && stamp.rows[0]?.declared_by === uid.dir
      && n(stamp.rows[0]?.invoice_value) === 18450.5 && n(stamp.rows[0]?.net_weight_kg) === 11800,
      { declared_at: String(stamp.rows[0]?.declared_at), declared_by: stamp.rows[0]?.declared_by });
    const signAudit = await oi(
      `select action, actor_user_id, "after"->>'declared_at' as at, "after"->>'declared_on' as "on",
              "after"->>'invoice_number' as inv
         from audit_logs where tenant_id = $1 and entity = 'cargo_import_masters'
           and action = 'master.declared'`, [T]);
    const stampIso = stamp.rows[0]?.declared_at instanceof Date
      ? stamp.rows[0].declared_at.toISOString() : null;
    check("…the signature is audited with the number it was given against, an instant and a day",
      signAudit.rowCount === 1 && signAudit.rows[0]?.actor_user_id === uid.dir
      && signAudit.rows[0]?.at === stampIso
      && signAudit.rows[0]?.on === stamp.rows[0]?.declared_day
      && signAudit.rows[0]?.inv === FILE_NO,
      { at: signAudit.rows[0]?.at, on: signAudit.rows[0]?.on, stampIso,
        wanted: stamp.rows[0]?.declared_day });

    const resign = await sign("dir");
    check("a sheet cannot be signed twice, even by the seat that signed it",
      refusedAs(resign, 409, "CONFLICT", /already signed/), msg(resign));

    const movedFigure = await master("dir", { invoiceValue: 999 });
    check("a signed figure is refused by the box that names it, with the date and the signer in the sentence",
      refusedAs(movedFigure, 409, "CONFLICT", /signed on .*Baraka Boss/)
      && field(movedFigure.json).includes("invoiceValue"),
      { status: movedFigure.status, fields: field(movedFigure.json), message: msg(movedFigure) });
    const twoFigures = await master("dir", { invoiceValue: 1, grossWeightKg: 2, billNumber: "X" });
    check("…and the refusal lists every box it would have rewritten, not only the first",
      refusedAs(twoFigures, 409, "CONFLICT")
      && field(twoFigures.json).join(",").includes("invoiceValue")
      && field(twoFigures.json).join(",").includes("grossWeightKg")
      && field(twoFigures.json).join(",").includes("billNumber"),
      field(twoFigures.json));
    const frozenRow = await oi(`select invoice_value, gross_weight_kg, bill_number
                                  from cargo_import_masters where tenant_id = $1`, [T]);
    check("…the register never saw either attempt",
      n(frozenRow.rows[0]?.invoice_value) === 18450.5
      && n(frozenRow.rows[0]?.gross_weight_kg) === 12500.4
      && frozenRow.rows[0]?.bill_number === BILL_NO, frozenRow.rows[0]);

    const unchanged = await master("dir", { ...FIGURES });
    check("resending the whole sheet unchanged is not a rewrite, so the desk can save without thinking",
      unchanged.status === 200 && unchanged.json?.master?.invoice_value !== null,
      { status: unchanged.status, message: msg(unchanged) });

    const lateNote = await master("dir", { notes: "Original packing list handed to the customs officer at the ICD." });
    check("a signed sheet still takes a longer note",
      lateNote.status === 200 && /handed to the customs officer/.test(String(lateNote.json?.master?.notes ?? "")),
      { status: lateNote.status, message: msg(lateNote) });

    const latePaper = await master("dir", { billDocumentId: D.contract });
    check("…and still takes the paper that arrived late, because a declaration is about figures, not bytes",
      latePaper.status === 200 && latePaper.json?.master?.bill_document_id === D.contract,
      { status: latePaper.status, message: msg(latePaper) });
    await master("dir", { billDocumentId: D.bill });

    const signedAsAuditor = await read("aud");
    check("an auditor reads the signed sheet as declared, with the signer's name and no pen",
      signedAsAuditor.json?.state?.declared === true
      && signedAsAuditor.json?.state?.declared_by === "Baraka Boss"
      && signedAsAuditor.json?.can?.edit === false, signedAsAuditor.json?.state);

    const listSigned = await call(`/cargo?search=${encodeURIComponent(FILE_A)}`, tok.dir, { method: "GET" });
    check("the register's row now says signed",
      ((listSigned.json as any[])?.find?.((r) => r.id === S1))?.master_state === "signed",
      (listSigned.json as any[])?.find?.((r) => r.id === S1)?.master_state);
  }

  // =========================================================================
  console.log("\n--- 5 · what the database itself refuses ---");
  // =========================================================================
  //
  // Every refusal above was reached through a route that checks the same thing first, which is
  // how a guard quietly stops existing while the code in front of it keeps passing. These are the
  // rules 111 wrote for itself, run as the migration owner over the API's head: un-sign a sheet,
  // rewrite a frozen figure, move a signature, point a line at a stranger's paper.

  const signedRow = await oi(
    `select id from cargo_import_masters where tenant_id = $1 and declared_at is not null`, [T]);
  const MID = signedRow.rows[0]?.id as string | undefined;

  /** Run a statement 111 exists to stop, and report what it said instead of letting it pass. */
  async function refuses(sql: string, params: unknown[], expect: RegExp, label: string) {
    let said: string | null = null;
    let changed = 0;
    try { changed = (await oi(sql, params)).rowCount ?? 0; }
    catch (e: any) { said = String(e?.message ?? e); }
    check(label, said !== null && expect.test(said),
      said ?? { note: `the statement ran and changed ${changed} row(s)` });
  }

  if (!MID) {
    console.log("note  this API has no file store, so the sheet could not be completed and signed —",
      "the frozen-sheet proofs below are skipped rather than faked with an owner write.");
  } else {
    await refuses(`update cargo_import_masters set declared_at = null where id = $1`, [MID],
      /not unsigned/, "the sheet cannot be un-signed, not even by the migration owner");
    await refuses(`update cargo_import_masters set declared_at = now() + interval '30 days' where id = $1`, [MID],
      /not unsigned/, "…nor can its signature be moved to another day, which is the same erasure with a number on it");
    await refuses(`update cargo_import_masters set invoice_value = 1 where id = $1`, [MID],
      /figures are not rewritten/, "a signed invoice value is not a draft any more");
    await refuses(`update cargo_import_masters set bill_number = 'ZZZ', packages_count = 1 where id = $1`, [MID],
      /figures are not rewritten/, "…nor two figures at once, nor the package count a broker quoted from");
    await refuses(`update cargo_import_masters set created_by = $2 where id = $1`, [MID, uid.dsp],
      /figures are not rewritten/, "…nor the seat that opened it, which is what a back-dated authorship looks like");
    await refuses(`update cargo_import_masters set shipment_id = $2 where id = $1`, [MID, S2],
      /not a paper on this cargo file/, "a signed declaration cannot be moved onto another cargo file");
    await refuses(`update cargo_import_masters set declared_by = $2 where id = $1`, [MID, uid.clk],
      /not re-signed to another seat/, "a signature belongs to the seat that made it");

    const keptOpen = await oi(`update cargo_import_masters
                                  set notes = 'Filed against the same declaration: the original bill arrived late.'
                                where id = $1`, [MID]);
    check("…while the note a signed row still takes is the note, so the freeze is not a wall",
      keptOpen.rowCount === 1, { rowCount: keptOpen.rowCount });

    if (stored) {
      await refuses(`update cargo_import_masters set invoice_document_id = $2 where id = $1`, [MID, D.otherFile],
        /not a paper on this cargo file/,
        "the trigger checks the vault pointer before it checks anything else, so a write around the API is stopped at the catalog");
      await refuses(`update cargo_import_masters set bill_document_id = $2 where id = $1`, [MID, D.stranger],
        /not a paper on this cargo file/,
        "…and a paper that is this company's but filed on a neighbour's file is not on this file either");
    }
  }

  const dup = await oi(
    `insert into cargo_import_masters (tenant_id, shipment_id, created_by) values ($1,$2,$3)`,
    [T, S1, uid.dir]).then(() => null).catch((e: any) => String(e?.message ?? e));
  check("a cargo file cannot be given a second sheet, which is what makes the register's flag a scalar",
    dup !== null && /cargo_import_masters_file_uq|duplicate key/.test(dup), dup);
  await refuses(`insert into cargo_import_masters (tenant_id, shipment_id, created_by) values ($1,$2,$3)`,
    [T, S3, uid.dir], /violates foreign key constraint/,
    "…nor a sheet of this company against another company's cargo file");
  await refuses(`insert into cargo_import_masters (tenant_id, shipment_id, created_by,
       invoice_number, declared_by, declared_at) values ($1,$2,$3,'INV-ONLY',$4,now())`,
    [T, S2, uid.dir, uid.dir], /cannot be signed without/,
    "a signature cannot be smuggled in on the insert of a half-filled sheet");
  await refuses(`insert into cargo_import_masters (tenant_id, shipment_id, created_by,
       invoice_value, declared_by) values ($1,$2,$3,500,$4)`,
    [T, S2, uid.dir, uid.dir], /violates check constraint/,
    "…nor a value with no invoice number behind it, which is a guess wearing a signature");

  const draftOnB = await oi(
    `insert into cargo_import_masters (tenant_id, shipment_id, created_by, packing_list_number)
     values ($1,$2,$3,'PL-DRAFT') returning id`, [T, S2, uid.dir]);
  const signDraft = await oi(
    `update cargo_import_masters set declared_at = now(), declared_by = $2 where id = $1`,
    [draftOnB.rows[0].id, uid.dir]).then(() => null).catch((e: any) => String(e?.message ?? e));
  check("signing an existing row goes through the same completeness gate as an insert",
    signDraft !== null && /cannot be signed without/.test(signDraft), signDraft);
  const buriedDraft = await oi(`delete from cargo_import_masters where id = $1`, [draftOnB.rows[0].id]);
  check("…and the half-row that attempt left behind is the owner's to remove, not the desk's",
    buriedDraft.rowCount === 1, { rowCount: buriedDraft.rowCount });

  const freezeKept = await oi(
    `select invoice_value, gross_weight_kg, bill_number, declared_at, declared_by, notes
       from cargo_import_masters where tenant_id = $1`, [T]);
  check("after all of that, the sheet holds exactly what the director signed",
    n(freezeKept.rows[0]?.invoice_value) === 18450.5
    && n(freezeKept.rows[0]?.gross_weight_kg) === 12500.4
    && freezeKept.rows[0]?.bill_number === BILL_NO
    && !!freezeKept.rows[0]?.declared_at && freezeKept.rows[0]?.declared_by === uid.dir,
    freezeKept.rows[0]);

  // =========================================================================
  console.log("\n--- 6 · the archive a clearing agent hands over ---");
  // =========================================================================

  const clerkBundle = await call(`/cargo/${S1}/master/bundle`, tok.clk, { method: "POST" });
  check("the clerk that filled and cannot sign the sheet cannot pull the archive down either — it is the export key's own door",
    refusedAs(clerkBundle, 403, "FORBIDDEN"), { status: clerkBundle.status, message: msg(clerkBundle) });
  const noSheet = await call(`/cargo/${S2}/master/bundle`, tok.aud, { method: "POST" });
  check("a file with no sheet answers with a sentence a clerk can act on, not an empty zip",
    refusedAs(noSheet, 409, "CONFLICT", /no master sheet/),
    { status: noSheet.status, message: msg(noSheet) });

  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const bundle = async (who: string) => callRaw(`/cargo/${S1}/master/bundle`, tok[who], {
    method: "POST", headers: { Origin: webOrigin }
  });
  const raw = await bundle("aud");
  const wantPapers = MID ? 3 : 0;
  check("a read-only seat holding the export key gets the archive, as bytes",
    raw.status === 200 && /application\/zip/.test(String(raw.headers.get("content-type"))),
    { status: raw.status, contentType: raw.headers.get("content-type"), head: raw.buf.subarray(0, 200).toString() });
  check("…named for the cargo file and the sheet, not for a uuid the desk never typed",
    String(raw.headers.get("content-disposition") ?? "")
      === `attachment; filename="master-${FILE_A}-${S1.slice(0, 8)}.zip"`,
    raw.headers.get("content-disposition"));
  check("…with the headers the reply pipeline would have set, replayed onto the raw socket",
    raw.headers.get("cache-control") === "no-store"
    && raw.headers.get("x-content-type-options") === "nosniff",
    { cache: raw.headers.get("cache-control"), nosniff: raw.headers.get("x-content-type-options") });
  check("…and the browser's own origin still gets its CORS answer, or the desk cannot download it",
    raw.headers.get("access-control-allow-origin") === webOrigin,
    raw.headers.get("access-control-allow-origin"));

  let entries = new Map<string, { data: Buffer; crc: number }>();
  let openErr: string | null = null;
  try { entries = zipRead(raw.buf); } catch (e: any) { openErr = String(e?.message ?? e); }
  check("the archive opens by its central directory", openErr === null && entries.size > 0, openErr);
  const names = [...entries.keys()];
  const folder = `master-${FILE_A}-${S1.slice(0, 8)}`;
  check(`…and holds exactly four entries plus one per paper (${wantPapers})`,
    names.length === wantPapers + 4, { names });

  const sheet = entries.get(`${folder}/master-sheet.pdf`);
  check("…the cover sheet is a real PDF, printed server-side from the same figures",
    sheet?.data.subarray(0, 5).toString() === "%PDF-" && (sheet?.data.length ?? 0) > 1500
    && sheet?.data.subarray(-6).toString().includes("%%EOF"),
    { head: sheet?.data.subarray(0, 8).toString(), bytes: sheet?.data.length });

  const PAPERS: [string, string][] = [
    ["commercial-invoice", INVOICE_PDF],
    ["packing-list", `packing-${STAMP}.pdf`],
    ["bill-of-lading-air-waybill", `bill-${STAMP}.pdf`]
  ];
  for (const [slug, name] of PAPERS) {
    const want = `${folder}/papers/${slug}-${name}`;
    check(`…the ${slug} entry is the very bytes that were uploaded for it`,
      wantPapers === 0 ? !names.includes(want)
        : names.includes(want) && entries.get(want)!.data.equals(payload(name)),
      { want, names });
  }

  const badCrc = names.filter((x) => crc32(entries.get(x)!.data) !== entries.get(x)!.crc);
  check("every entry's CRC in the central directory matches the bytes it points at",
    badCrc.length === 0, badCrc);

  const sumsText = entries.get("SHA256SUMS.txt")?.data.toString("utf8") ?? "";
  const sumLines = sumsText.split("\n").filter(Boolean);
  const listed = sumLines.map((l) => l.slice(66));
  check("SHA256SUMS.txt lists every entry but itself",
    sumLines.length === names.length - 1
    && names.filter((x) => x !== "SHA256SUMS.txt").every((x) => listed.includes(x)),
    { lines: sumLines.length, names: names.length, listed });
  const badSums = sumLines.filter((l) =>
    !/^[0-9a-f]{64} {2}/.test(l) || !entries.get(l.slice(66))?.data
      || createHash("sha256").update(entries.get(l.slice(66))!.data).digest("hex") !== l.slice(0, 64));
  check("…and every hash is the hash of the bytes actually in the archive",
    badSums.length === 0, badSums);

  const readme = entries.get(`${folder}/README.txt`)?.data.toString("utf8") ?? "";
  const recordText = entries.get(`${folder}/master.json`)?.data.toString("utf8") ?? "";
  let record: any = {};
  try { record = JSON.parse(recordText); } catch (e: any) { record = { parseError: String(e) }; }
  check("the note inside the folder says what it is and which seat made it",
    readme.includes(`Master document — ${FILE_A}`) && /Generated \d{4}-\d{2}-\d{2} .+ UTC by Daudi Auditor\./.test(readme),
    readme.slice(0, 200));
  check("…and lists every entry under the name the archive really carries",
    names.filter((x) => x !== "SHA256SUMS.txt").every((x) => readme.includes(x)),
    names.filter((x) => !readme.includes(x)));
  check(MID ? "…a signed sheet is described as signed, with the day and the signer"
    : "…an unfinished sheet is described as not signed, which is the honest half",
    MID ? /DECLARATION\nSigned \d{4}-\d{2}-\d{2} by Baraka Boss/.test(readme)
      : /DECLARATION\nNot signed\./.test(readme), readme.split("DECLARATION")[1]?.slice(0, 160));
  const sheetRow = MID ? (await oi(
    `select declared_at,
            to_char(declared_at at time zone 'Africa/Dar_es_Salaam','YYYY-MM-DD') as day
       from cargo_import_masters where id = $1`, [MID])).rows[0] : null;
  const deskNow = MID ? await read("dir") : null;
  check("…the machine-readable record carries that office's day beside the UTC instant, so a reader needs no calendar maths",
    MID ? record.declared_on === sheetRow?.day
      && String(record.declared_at) === (sheetRow?.declared_at instanceof Date
        ? sheetRow.declared_at.toISOString() : null)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(record.declared_at))
      && deskNow?.json?.state?.declared_on === record.declared_on
      : record.declared_on === null && record.declared_at === null,
    { declared_on: record.declared_on, declared_at: record.declared_at, day: sheetRow?.day,
      desk: deskNow?.json?.state?.declared_on });
  check("…nothing in the folder prints where the bytes live inside the bucket",
    !/storage_path|storage\.supabase/.test(readme + recordText), {
      inReadme: /storage_path/.test(readme), inJson: /storage_path/.test(recordText) });
  check("master.json carries the declaration, the file's own figures apart from the sheet's, and the papers",
    record.file_number === FILE_A && record.declared === (MID !== undefined)
    && record.master?.invoice?.number === FILE_NO
    && n(record.master?.invoice?.value) === 18450.5
    && record.master?.packing_list?.packages_count === 48
    && n(record.master?.packing_list?.gross_weight_kg) === 12500.4
    && record.master?.transport_document?.kind === "bill_of_lading"
    && record.master?.transport_document?.number === BILL_NO
    && n(record.cargo_file?.weight_tonnes) === 12.5
    && record.papers?.length === wantPapers && record.papers_missing?.length === 0
    && record.warnings?.length === 0,
    { declared: record.declared, papers: record.papers?.length,
      missing: record.papers_missing?.length, warnings: record.warnings });

  const bundleAudit = await oi(
    `select action, actor_user_id, "after"->>'file_number' as fn, "after"->>'declared' as declared,
            "after"->>'papers' as papers, "after"->>'papers_skipped' as skipped,
            "after"->>'entries' as entries, "after"->>'aborted' as aborted,
            "after"->'failure' as failure
       from audit_logs where tenant_id = $1 and action = 'master.bundled' order by ts desc limit 1`, [T]);
  check("the download is audited by the seat that asked for it, with what it carried",
    bundleAudit.rowCount === 1 && bundleAudit.rows[0]?.actor_user_id === uid.aud
    && bundleAudit.rows[0]?.fn === FILE_A
    && bundleAudit.rows[0]?.declared === String(MID !== undefined)
    && bundleAudit.rows[0]?.papers === String(wantPapers)
    && bundleAudit.rows[0]?.skipped === "0"
    && bundleAudit.rows[0]?.entries === String(wantPapers + 4)
    && bundleAudit.rows[0]?.aborted === "false" && bundleAudit.rows[0]?.failure === null,
    bundleAudit.rows[0]);

  if (stored) {
    const buriedPaper = await oi(
      `update documents set deleted_at = now() where id = $1 and tenant_id = $2`, [D.packing, T]);
    check("the vault can bury a paper a signed sheet already points at",
      buriedPaper.rowCount === 1, { rowCount: buriedPaper.rowCount });
    const dangling = await read("dir");
    check("the sheet then says out loud that the line points at a paper that is no longer on the file",
      (dangling.json?.warnings ?? []).some((w: string) =>
        /the packing list points at a paper that is no longer on this cargo file/.test(w)),
      dangling.json?.warnings);
    check("…while the signature and the figures it froze are untouched",
      dangling.json?.state?.declared === true && (dangling.json?.master?.invoice_value ?? null) !== null,
      dangling.json?.state);

    const thin = await bundle("aud");
    const thinZip = zipSafe(thin.buf, "the archive with the buried paper");
    if (thinZip.openErr) check("the archive with the buried paper opens", false, thinZip.openErr);
    const thinEntries = thinZip.entries;
    const thinReadme = thinEntries.get(`${folder}/README.txt`)?.data.toString("utf8") ?? "";
    const thinRecord = JSON.parse(thinEntries.get(`${folder}/master.json`)?.data.toString("utf8") ?? "{}");
    const missEntry = `${folder}/papers/packing-list-paper`;
    check("…and the archive answers it the way a clerk needs: the other two packed, the third named under NOT IN THIS FOLDER with a reason",
      thinEntries.size === wantPapers + 3
      && !names.every((x) => thinEntries.has(x))
      && /NOT IN THIS FOLDER\n/.test(thinReadme) && thinReadme.includes(missEntry)
      && /no longer on this file/.test(thinReadme)
      && thinRecord.papers?.length === 2 && thinRecord.papers_missing?.length === 1
      && thinRecord.papers_missing[0]?.entry === missEntry,
      { size: thinEntries.size, missing: thinRecord.papers_missing });

    const restored = await oi(
      `update documents set deleted_at = null where id = $1 and tenant_id = $2`, [D.packing, T]);
    const fullAgain = await bundle("aud");
    const againZip = zipSafe(fullAgain.buf, "the archive after the paper came back");
    if (againZip.openErr) check("the archive after the paper came back opens", false, againZip.openErr);
    check("put the paper back and the next archive carries it again — nothing about this is cached",
      restored.rowCount === 1 && againZip.entries.size === wantPapers + 4
      && againZip.entries.has(`${folder}/papers/packing-list-packing-${STAMP}.pdf`),
      { size: againZip.entries.size, names: [...againZip.entries.keys()] });

    const zipFile = join(tmpdir(), `waisha-master-bundle-${STAMP}.zip`);
    writeFileSync(zipFile, raw.buf);
    const probe = spawnSync("unzip", ["-t", zipFile], { encoding: "utf8" });
    rmSync(zipFile, { force: true });
    if (probe.error) console.log("note  `unzip` is not on this machine, so the archive was read by its central directory and CRCs only");
    else check("a standard unzip reader tests every entry without complaint",
      probe.status === 0, { status: probe.status, out: String(probe.stdout ?? "").slice(-160) });
  }

  // =========================================================================
  console.log("\n--- 7 · two companies, one register ---");
  // =========================================================================

  const neighbourFill = await call(`/cargo/${S1}/master`, tok.dir2, {
    method: "PUT", body: JSON.stringify({ notes: "a neighbour's pen" }) });
  check("a neighbour's director is told there is no such cargo file, filling or reading or signing",
    refusedAs(neighbourFill, 404, "NOT_FOUND"), { status: neighbourFill.status, message: msg(neighbourFill) });
  const neighbourSign = await sign("dir2");
  check("…nor stamp a signature on it",
    refusedAs(neighbourSign, 404, "NOT_FOUND"), { status: neighbourSign.status, message: msg(neighbourSign) });
  const neighbourBundle = await call(`/cargo/${S1}/master/bundle`, tok.dir2, { method: "POST" });
  check("…nor pull its archive down",
    refusedAs(neighbourBundle, 404, "NOT_FOUND"), { status: neighbourBundle.status });

  const planted = await oi(
    `insert into cargo_import_masters (tenant_id, shipment_id, created_by, packing_list_number, notes)
     values ($1,$2,$3,'PL-STR-1','A sheet that belongs to the other company only.')`,
    [T2, S3, uid.dir2]);
  check("the other company may keep a sheet on its own file", planted.rowCount === 1, { rowCount: planted.rowCount });
  const theirSheet = await read("dir2", S3);
  check("…and reads it as their own, with their own file number on it",
    theirSheet.status === 200 && theirSheet.json?.state?.has_master === true
    && theirSheet.json?.file?.file_number === FILE_C
    && theirSheet.json?.master?.packing_list_number === "PL-STR-1",
    { status: theirSheet.status, file: theirSheet.json?.file?.file_number });
  const myView = await read("dir", S3);
  check("…while this company is told the file does not exist, and its own sheet is nowhere in that answer",
    refusedAs(myView, 404, "NOT_FOUND"), { status: myView.status, message: msg(myView) });
  const theirList = await call(`/cargo?search=${encodeURIComponent(FILE_C)}`, tok.dir2, { method: "GET" });
  check("the register's new sheet flag is bound to the company asking, not to the row it happened to find",
    ((theirList.json as any[]) ?? []).find((r) => r.id === S3)?.master_state === "draft",
    ((theirList.json as any[]) ?? []).find((r) => r.id === S3)?.master_state);
  const myList = await call(`/cargo?search=${encodeURIComponent(FILE_C)}`, tok.dir, { method: "GET" });
  check("…and the neighbour's file, with its flag on it, is not in this company's list at all",
    Array.isArray(myList.json) && myList.json.length === 0, myList.json);
  const myFiles = await call(`/cargo?search=${encodeURIComponent(STAMP)}`, tok.dir, { method: "GET" });
  check("…and a search that matches both companies' file numbers answers with this company's files only",
    Array.isArray(myFiles.json) && myFiles.json.length === 2
    && myFiles.json.every((r: any) => String(r.file_number).startsWith("4MSR")),
    (myFiles.json as any[])?.map?.((r: any) => [r.file_number, r.master_state]));
  const theirFiles = await call(`/cargo?search=${encodeURIComponent(STAMP)}`, tok.dir2, { method: "GET" });
  check("…while the neighbour's own register shows its file and its sheet, and nothing of this one",
    Array.isArray(theirFiles.json) && theirFiles.json.length === 1
    && theirFiles.json[0]?.file_number === FILE_C
    && theirFiles.json[0]?.master_state === "draft",
    (theirFiles.json as any[])?.map?.((r: any) => [r.file_number, r.master_state]));

  // =========================================================================
  console.log("\n--- 8 · the promises the catalog made ---");
  // =========================================================================

  const privs = await oi(
    `select has_table_privilege('app_runtime','cargo_import_masters','select') as s,
            has_table_privilege('app_runtime','cargo_import_masters','insert') as i,
            has_table_privilege('app_runtime','cargo_import_masters','update') as u,
            has_table_privilege('app_runtime','cargo_import_masters','delete') as d,
            has_table_privilege('app_runtime','cargo_import_masters','truncate') as t`);
  check("the API's own role may write a sheet and may never delete one — a declaration to customs is kept",
    privs.rows[0]?.s === true && privs.rows[0]?.i === true && privs.rows[0]?.u === true
    && privs.rows[0]?.d === false && privs.rows[0]?.t === false, privs.rows[0]);
  const rls = await oi(
    `select c.relrowsecurity as on_, count(*)::int as policies,
            bool_and(p.qual like '%app.tenant_id%') as using_bound,
            bool_and(coalesce(p.with_check, '') like '%app.tenant_id%') as check_bound,
            bool_and('app_runtime' = any(p.roles)) as for_runtime
       from pg_class c
       join pg_policies p on p.tablename = c.relname
      where c.oid = 'cargo_import_masters'::regclass
      group by c.relrowsecurity`);
  check("…the table is under RLS with one tenant-bound policy, like every other tenant table",
    rls.rows[0]?.on_ === true && rls.rows[0]?.policies === 1 && rls.rows[0]?.using_bound === true
    && rls.rows[0]?.check_bound === true && rls.rows[0]?.for_runtime === true, rls.rows[0]);
  const signerRule = await oi(
    `select conname, confdeltype from pg_constraint
      where conrelid = 'cargo_import_masters'::regclass and conname like '%declared_by%'`);
  check("…and the one change a signed sheet tolerates is the platform's own: the signer's row may go, the timestamp stays",
    signerRule.rows[0]?.confdeltype === "n", signerRule.rows);

  const guards = await oi(
    `select p.proname as fn, p.proacl is not null as pinned,
            has_function_privilege('app_runtime', p.oid, 'execute') as api_runs,
            coalesce(p.proconfig::text, '') as cfg,
            exists (select 1 from aclexplode(p.proacl) a
                     where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_runs
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('cargo_import_master_shape','cargo_import_master_gaps')
      order by p.proname`);
  check("both guards have an ACL, run for the API role, are not PUBLIC's to run, and pin their own search_path",
    guards.rowCount === 2 && guards.rows.every((g) => g.pinned === true && g.api_runs === true
      && g.public_runs === false && /search_path=public/.test(String(g.cfg))), guards.rows);

  const duty = await oi(
    `select r.key, bool_or(rp.permission_key = 'shipments.declare') as declares,
            bool_or(rp.permission_key = 'shipments.edit') as edits
       from roles r join role_permissions rp on rp.role_id = r.id
      where r.tenant_id is null
        and rp.permission_key in ('shipments.edit','shipments.declare')
      group by r.key order by r.key`);
  check("the signature was handed to exactly the desks that can edit a file, and to none that only reads it",
    duty.rowCount! > 0 && duty.rows.every((d) => d.declares === false || d.edits === true)
    && !duty.rows.some((d) => d.key === "auditor" && d.declares === true), duty.rows);
  const fixtureDuty = await oi(
    `select bool_or(permission_key = 'shipments.edit') as edits,
            bool_or(permission_key = 'shipments.declare') as declares
       from role_permissions where role_id = $1`, [clerkRole]);
  check("…which is why this fixture's clearing clerk holds the first and not the second",
    fixtureDuty.rows[0]?.edits === true && fixtureDuty.rows[0]?.declares === false,
    fixtureDuty.rows[0]);

  const wantActions = ["master.bundled", "master.opened", "master.updated"];
  if (MID) wantActions.push("master.declared");
  const acts = await oi(
    `select action, count(*)::int as n,
            count(*) filter (where entity_id is null)::int as unnumbered,
            count(*) filter (where actor_user_id is null)::int as nameless
       from audit_logs where tenant_id = $1 and entity = 'cargo_import_masters'
      group by action order by action`, [T]);
  check("every act on a sheet left its own line in the audit register, numbered and attributed",
    acts.rows.map((r) => r.action).join(",") === wantActions.sort().join(",")
    && acts.rows.every((r) => r.unnumbered === 0 && r.nameless === 0), acts.rows);

  const printed = await oi(
    `select count(*)::int as n from audit_logs
      where tenant_id = any($1::uuid[]) and entity = 'cargo_import_masters'
        and (before::text ~ 'nida|phone_search' or after::text ~ 'nida|phone_search')`, [[T, T2]]);
  check("and not one audit line about a sheet carries searchable PII", printed.rows[0]?.n === 0, printed.rows[0]);

  // =========================================================================
  console.log("\n--- teardown ---");
  // =========================================================================

  for (const [tid, label] of [[T, COMPANY], [T2, OTHER]] as [string, string][]) {
    console.log(`  sweeping ${label}`);
    for (const [what, sql] of [
      ["cargo_import_masters", `delete from cargo_import_masters where tenant_id = $1`],
      ["documents", `delete from documents where tenant_id = $1`],
      ["cargo_tasks", `delete from cargo_tasks where tenant_id = $1`],
      ["cargo_shipments", `delete from cargo_shipments where tenant_id = $1`],
      ["user_roles", `delete from user_roles where user_id in (select id from users where tenant_id = $1)`],
      ["roles", `delete from roles where tenant_id = $1`],
      ["sessions", `delete from sessions where user_id in (select id from users where tenant_id = $1)`],
      ["users", `delete from users where tenant_id = $1`],
      ["tenants", `delete from tenants where id = $1`]
    ]) {
      const r = await oi(sql, [tid]).catch((e: any) => {
        console.log(`  sweep ${what} FAILED: ${String(e.message).slice(0, 100)}`);
        return { rowCount: -1 };
      });
      console.log(`  ${label} · ${what}: ${r.rowCount} row(s)`);
    }
  }

  const left = await oi(
    `select (select count(*)::int from cargo_import_masters where tenant_id = any($1::uuid[])) as sheets,
            (select count(*)::int from documents where tenant_id = any($1::uuid[])) as papers,
            (select count(*)::int from cargo_tasks where tenant_id = any($1::uuid[])) as tasks,
            (select count(*)::int from cargo_shipments where tenant_id = any($1::uuid[])) as files,
            (select count(*)::int from roles where tenant_id = any($1::uuid[])) as duties,
            (select count(*)::int from users where tenant_id = any($1::uuid[])) as seats,
            (select count(*)::int from tenants where id = any($1::uuid[])) as companies`, [[T, T2]]);
  check("the fixture is gone from every register it wrote",
    Object.values(left.rows[0]).every((v) => Number(v) === 0), left.rows[0]);
  const stray = await oi(
    `select (select count(*)::int from cargo_import_masters
              where shipment_id in (select id from cargo_shipments where file_number like $1)) as sheets,
            (select count(*)::int from cargo_shipments where file_number in ($2,$3,$4)) as files,
            (select count(*)::int from documents where file_name like $1) as papers,
            (select count(*)::int from roles where key = 'clearing_clerk' and tenant_id is not null) as duties,
            (select count(*)::int from users where email like '%.ms.%@example.org') as seats,
            (select count(*)::int from tenants where name ~ '^Master (Smoke|Stranger) [0-9]{8}$') as companies`,
    [`%${STAMP}%`, FILE_A, FILE_B, FILE_C]);
  check("…and nothing this run minted is left anywhere on the database",
    Object.values(stray.rows[0]).every((v) => Number(v) === 0), stray.rows[0]);
  const kept = await oi(
    `select count(*)::int as n from audit_logs where tenant_id = any($1::uuid[])`, [[T, T2]]);
  console.log(`(audit_logs keeps ${kept.rows[0]?.n} rows for the swept tenants — the register is append-only`
    + (stored ? ", and the bucket keeps the uploaded PDFs the way every earlier smoke leaves them)" : ")"));

  await owner.end();
}

main().then(() => {
  if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
  console.log("\ncargo master smoke passed");
}).catch((e) => { console.error(e); process.exit(1); });
