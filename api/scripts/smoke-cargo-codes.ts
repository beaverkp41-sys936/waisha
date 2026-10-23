/**
 * #383/#384 and #390-#393 — the mode of transport, the customs regime and the codes it prints.
 *
 * The office asked for the four movements with their numbers (import 4, export 1, transit 8,
 * transhipment 7), for a file to say which mode it travels by, and for a CPC section under Customs
 * that fits the movement it is filed under. Migration 130 made both lists tables; 132 put the
 * classification block behind them, so a movement now carries its own words, the series it is
 * declared under and the shape of a code of that series — which is how T1, T2 and TR became
 * declarable when 130's four-digit CHECK could only refuse them. This run proves the chain over real
 * HTTP:
 *   1. `/cargo/codes` carries the prefixes, the six modes with the document each one travels on, the
 *      sixteen procedures and the regime words each movement prints — and the words it answers with
 *      are read back out of the same rows, so the form has no copy of any of it;
 *   2. a mode and a CPC land on the file, come back with their labels, are kept or cleared by the
 *      presence rule the rest of this API writes by, and a code of either shape — 40 or T1, typed in
 *      either case — is filed in the capitals the block prints it in;
 *   3. a code that contradicts the movement is refused with the box named, at the route and again in
 *      SQL, so no desk can file an import code on a transit file whatever shape its own code is;
 *   4. the master sheet's transport document follows the file's mode: a contradiction typed into the
 *      sheet is refused, a mode changed afterwards is said as a warning, and a note still saves.
 * Fixtures are named Codeprobe* on their own tenants and every one is wiped at the end.
 * Run: npx tsx scripts/smoke-cargo-codes.ts   (DNS_FALLBACK=1 if local DNS is broken)
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
  else { failures++; console.log("FAIL ", label, detail.slice(0, 260)); }
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
const put = (body: any) => ({ method: "PUT", ...json(body) });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shiftDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
const text = (v: any) => JSON.stringify(v ?? "");

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

  const T1 = randomUUID(), T2 = randomUUID();
  const d1 = randomUUID(), d2 = randomUUID(), noDuty = randomUUID();

  const WIPE = ["job_handovers", "job_documents", "job_activity", "cargo_tasks", "job_stages",
    "jobs", "warehouse_slips", "warehouse_stays", "cargo_intake_drafts", "cargo_import_masters",
    "cargo_shipments", "alert_reads", "documents", "company_profiles", "sessions", "otp_codes",
    "password_resets"];
  const wipeRoles = `delete from user_roles where user_id in
    (select id from users where tenant_id = any($1::uuid[]))`;

  // Residue of a crashed run shares the fixture names, and the company code is unique per tenant.
  const oldT = (await oi(
    `select id from tenants where name in ('Codeprobe Sea Ltd','Codeprobe Air Ltd')`)).rows.map(r => r.id);
  if (oldT.length) {
    for (const t of WIPE) await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [oldT]);
    await oi(wipeRoles, [oldT]);
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [oldT]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [oldT]);
    console.log("pre-clean removed", oldT.length, "stale codeprobe tenants");
  }

  await oi(`insert into tenants (id, type, name) values ($1,'transporter','Codeprobe Sea Ltd')`, [T1]);
  await oi(`insert into tenants (id, type, name) values ($1,'transporter','Codeprobe Air Ltd')`, [T2]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, company_code)
            values ($1,$2,'Codeprobe Sea Ltd','CP1')`, [randomUUID(), T1]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, company_code)
            values ($1,$2,'Codeprobe Air Ltd','CP2')`, [randomUUID(), T2]);
  for (const [u, t, name] of [[d1, T1, "Codeprobe Alpha Director"], [d2, T2, "Codeprobe Beta Director"],
    [noDuty, T1, "Codeprobe No Duty"]]) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, status)
              values ($1,$2,'staff',$3,'active')`, [u, t, name]);
  }
  const directorRole = (await oi(
    `select id from roles where key = 'director' and tenant_id is null`)).rows[0]?.id;
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [d1, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [d2, directorRole]);

  const tok1 = await mint(d1, T1, "director", ["director"]);
  const tok2 = await mint(d2, T2, "director", ["director"]);
  const tokBare = await mint(noDuty, T1, "staff", []);

  // ---------- 1. The lists the desk declares from ----------
  const codes = await call("/cargo/codes", tok1);
  const c = codes.body ?? {};
  const typeOf = (v: string) => (c.types ?? []).find((t: any) => t.value === v);
  const modeOf = (n: number) => (c.modes ?? []).find((m: any) => m.code === n);
  const procOf = (p: string) => (c.procedures ?? []).find((x: any) => x.code === p);
  check("/cargo/codes answers 200 with the four movements",
    codes.status === 200 && (c.types ?? []).length === 4, `[${codes.status}] ${text(c.types)}`);
  check("each movement arrives with the digit its file number starts on and its book",
    typeOf("import")?.prefix === "4" && typeOf("import")?.book?.key === "clearing"
      && typeOf("transhipment")?.prefix === "7" && typeOf("transhipment")?.book?.key === "clearing"
      && typeOf("export")?.prefix === "1" && typeOf("export")?.book?.key === "transport"
      && typeOf("transit")?.prefix === "8" && typeOf("transit")?.book?.key === "transport",
    text(c.types));
  check("each movement is handed with the block's own words: what it does and the codes it prints",
    (c.types ?? []).length === 4 && (c.types ?? []).every((t: any) =>
      String(t.regime_note ?? "").length > 40 && String(t.series_words ?? "").length > 3)
      && typeOf("import")?.series_words === "codes 40 and 42"
      && typeOf("export")?.series_words === "code 10"
      && /general indicator TR/.test(String(typeOf("transhipment")?.series_words ?? ""))
      && /T1 and 80/.test(String(typeOf("transit")?.series_words ?? "")),
    text((c.types ?? []).map((t: any) => [t.value, t.series_words])));
  check("the six published modes, each with the document it travels on",
    (c.modes ?? []).length === 6 && modeOf(1)?.bill_kind === "bill_of_lading"
      && modeOf(1)?.bill_label === "Bill of lading" && modeOf(1)?.carrier_word === "Shipping line"
      && modeOf(4)?.bill_kind === "air_waybill" && modeOf(4)?.carrier_word === "Airline"
      && modeOf(2)?.bill_kind === "rail_waybill" && modeOf(3)?.bill_kind === "road_waybill",
    text(c.modes));
  check("the two modes that ride on somebody else's paper name no document and no carrier",
    modeOf(5)?.bill_kind === null && modeOf(5)?.bill_label === null && modeOf(5)?.carrier_word === null
      && modeOf(6)?.bill_kind === null && modeOf(6)?.carrier_word === null,
    text([modeOf(5), modeOf(6)]));
  check("the sixteen procedures, each bound to the regime its code is printed under",
    (c.procedures ?? []).length === 16 && procOf("4000")?.shipment_type === "import"
      && procOf("4200")?.shipment_type === "import" && procOf("1000")?.shipment_type === "export"
      && procOf("7000")?.shipment_type === "transhipment" && procOf("8000")?.shipment_type === "transit"
      && procOf("8200")?.shipment_type === "transit", text(c.procedures));
  check("…and the block's short codes and transit papers are among them, under their own movement",
    procOf("40")?.shipment_type === "import" && procOf("42")?.shipment_type === "import"
      && procOf("10")?.shipment_type === "export" && procOf("80")?.shipment_type === "transit"
      && procOf("T1")?.shipment_type === "transit" && procOf("T2")?.shipment_type === "transit"
      && procOf("50")?.shipment_type === "transhipment" && procOf("60")?.shipment_type === "transhipment"
      && procOf("70")?.shipment_type === "transhipment" && procOf("TR")?.shipment_type === "transhipment",
    text((c.procedures ?? []).map((p: any) => [p.code, p.shipment_type])));
  check("every procedure's label is the EAC wording a counter reads",
    procOf("4000")?.label === "Direct Import for Home Consumption"
      && procOf("8200")?.label === "Inland Container Depot / Bonded Warehouse"
      && procOf("T1")?.label === "Community Transit Paper (T1)"
      && procOf("40")?.label === "Permanent / Definitive Entry", text(c.procedures));
  const regimes = await oi(`select shipment_type, series_words, note, code_pattern, file_prefix
    from customs_regime`);
  const regimeOf = (v: string) => regimes.rows.find(r => r.shipment_type === v);
  check("SQL: the words the API answered with are the regime rows themselves, and the digit too",
    regimes.rowCount === 4 && (c.types ?? []).every((t: any) => {
      const r = regimeOf(t.value);
      return r && r.series_words === t.series_words && r.note === t.regime_note
        && r.file_prefix === t.prefix;
    }), text((c.types ?? []).map((t: any) => [t.value, t.prefix, t.series_words])));
  check("SQL: every code the desk was handed fits the pattern of the regime it stands under",
    (await oi(`select count(*)::int as n from customs_procedure_code c
       join customs_regime r on r.shipment_type = c.shipment_type
      where c.code !~ r.code_pattern`)).rows[0].n === 0,
    text((await oi(`select code, shipment_type from customs_procedure_code c
      where c.code !~ (select code_pattern from customs_regime where shipment_type = c.shipment_type)`))
      .rows));
  check("the lists are platform reference data: B is handed the same six modes",
    (await call("/cargo/codes", tok2)).body?.modes?.length === 6);
  check("/cargo/codes is not open to an anonymous caller",
    (await fetch(API + "/cargo/codes")).status === 401);
  check("…nor to a seat without the cargo duty", (await call("/cargo/codes", tokBare)).status === 403);

  // ---------- 2. A file carries a mode and a procedure ----------
  const sea = await call("/cargo", tok1, post({
    shipmentType: "import", containerType: "loose_cargo", modeCode: 1, cpcCode: "4000",
    consigneeName: "Codeprobe Rice Trader", consignorName: "Codeprobe Sender Sea",
    eta: shiftDays(3), billNumber: "MEDUX-7700001", shippingLine: "Codeprobe Line"
  }));
  const seaId = sea.body?.id ?? "";
  check("an import file saved with mode 1 and CPC 4000",
    sea.status === 201 && !!seaId && String(sea.body?.fileNumber ?? "").startsWith("4"),
    `[${sea.status}] ${text(sea.body)}`);
  const rail = await call("/cargo", tok1, post({
    shipmentType: "transit", containerType: "loose_cargo", modeCode: 2, cpcCode: "8000",
    consigneeName: "Codeprobe Copper Buyer", consignorName: "Codeprobe Sender Rail",
    eta: shiftDays(5)
  }));
  const railId = rail.body?.id ?? "";
  check("a transit file saved with mode 2 and CPC 8000",
    rail.status === 201 && String(rail.body?.fileNumber ?? "").startsWith("8"), `[${rail.status}]`);
  const mail = await call("/cargo", tok1, post({
    shipmentType: "transhipment", containerType: "loose_cargo", modeCode: 5, cpcCode: "7000",
    consigneeName: "Codeprobe Postal Parcel", consignorName: "Codeprobe Sender Mail",
    eta: shiftDays(9)
  }));
  const mailId = mail.body?.id ?? "";
  check("a mode that names no transport document is accepted",
    mail.status === 201, `[${mail.status}] ${text(mail.body)}`);

  const seaRow = (await oi(`select mode_code, cpc_code, file_number, shipment_type
    from cargo_shipments where id = $1`, [seaId])).rows[0];
  check("SQL: both codes are on the row the file number was cut from",
    seaRow?.mode_code === 1 && seaRow?.cpc_code === "4000"
      && seaRow?.shipment_type === "import" && seaRow?.file_number.startsWith("4"),
    text(seaRow));

  const seaDetail = await call(`/cargo/${seaId}`, tok1);
  check("the file page answers the mode in words and names the paper it travels on",
    seaDetail.status === 200 && seaDetail.body?.mode_code === 1
      && seaDetail.body?.mode_label === "Maritime (Sea)"
      && seaDetail.body?.mode_bill_kind === "bill_of_lading"
      && seaDetail.body?.mode_carrier_word === "Shipping line", text(seaDetail.body?.mode_code));
  check("…and the CPC with the label and the note the list holds",
    seaDetail.body?.cpc_code === "4000"
      && seaDetail.body?.cpc_label === "Direct Import for Home Consumption"
      && /Duty and the statutory taxes/.test(String(seaDetail.body?.cpc_note ?? "")),
    text([seaDetail.body?.cpc_code, seaDetail.body?.cpc_label]));
  const mailDetail = await call(`/cargo/${mailId}`, tok1);
  check("a postal file has a mode in words and no document expected of its sheet",
    mailDetail.body?.mode_label === "Mail (Postal)" && mailDetail.body?.mode_bill_kind === null,
    text([mailDetail.body?.mode_label, mailDetail.body?.mode_bill_kind]));

  // ---------- 3. A code that contradicts the movement is refused ----------
  const wrongProc = await call("/cargo", tok1, post({
    shipmentType: "transit", containerType: "loose_cargo", cpcCode: "4000",
    consigneeName: "Codeprobe Wrong Procedure", consignorName: "Codeprobe Sender Wrong"
  }));
  check("an 8-prefix file cannot declare under an import procedure",
    wrongProc.status === 400 && /is a procedure for import/.test(text(wrongProc.body))
      && /field.*cpcCode/.test(text(wrongProc.body)), `[${wrongProc.status}] ${text(wrongProc.body)}`);
  const ghostProc = await call("/cargo", tok1, post({
    shipmentType: "import", containerType: "loose_cargo", cpcCode: "4900",
    consigneeName: "Codeprobe Unknown Procedure", consignorName: "Codeprobe Sender Ghost"
  }));
  check("a CPC the office does not declare under is named, not filed",
    ghostProc.status === 400 && /not a procedure the office declares under/.test(text(ghostProc.body)),
    `[${ghostProc.status}] ${text(ghostProc.body)}`);
  const ghostMode = await call("/cargo", tok1, post({
    shipmentType: "import", containerType: "loose_cargo", modeCode: 9,
    consigneeName: "Codeprobe Unknown Mode", consignorName: "Codeprobe Sender Mode"
  }));
  check("a mode outside the six is refused before the row is written",
    ghostMode.status === 400 && /modeCode/i.test(text(ghostMode.body)),
    `[${ghostMode.status}] ${text(ghostMode.body)}`);
  const looseProc = await call("/cargo", tok1, post({
    shipmentType: "import", containerType: "loose_cargo", cpcCode: "400",
    consigneeName: "Codeprobe Short CPC", consignorName: "Codeprobe Sender Short"
  }));
  check("a CPC of no shape the block prints is refused as a shape, not as a search",
    looseProc.status === 400 && /the block prints/i.test(text(looseProc.body)),
    `[${looseProc.status}] ${text(looseProc.body)}`);
  const letterOnWrong = await call("/cargo", tok1, post({
    shipmentType: "transhipment", containerType: "loose_cargo", cpcCode: "T1",
    consigneeName: "Codeprobe Wrong Paper", consignorName: "Codeprobe Sender Letter"
  }));
  check("a transit paper cannot be filed on a transhipment movement, and the series says so",
    letterOnWrong.status === 400 && /is a procedure for transit/.test(text(letterOnWrong.body))
      && /codes T1 and 80/.test(text(letterOnWrong.body)) && /begins 7/.test(text(letterOnWrong.body)),
    `[${letterOnWrong.status}] ${text(letterOnWrong.body)}`);
  check("none of the refusals left a file behind",
    Number((await oi(`select count(*)::int as n from cargo_shipments where tenant_id = $1`, [T1]))
      .rows[0].n) === 3);

  // ---------- 4. The presence rule: absent keeps, explicit null clears ----------
  const keepMode = await call(`/cargo/${seaId}`, tok1, put({ notes: "Codeprobe note only" }));
  const afterKeep = (await oi(`select mode_code, cpc_code from cargo_shipments where id = $1`, [seaId]))
    .rows[0];
  check("a write that says nothing about the codes keeps both",
    keepMode.status === 200 && afterKeep?.mode_code === 1 && afterKeep?.cpc_code === "4000",
    `[${keepMode.status}] ${text(afterKeep)}`);
  const toAir = await call(`/cargo/${seaId}`, tok1, put({ modeCode: 4 }));
  const afterAir = (await oi(`select mode_code, cpc_code from cargo_shipments where id = $1`, [seaId]))
    .rows[0];
  check("a mode can be moved on an open file and the procedure rides with it",
    toAir.status === 200 && afterAir?.mode_code === 4 && afterAir?.cpc_code === "4000",
    `[${toAir.status}] ${text(afterAir)}`);
  const cleared = await call(`/cargo/${seaId}`, tok1, put({ cpcCode: null }));
  check("an explicit null clears the procedure — the box is empty, not unchanged",
    cleared.status === 200
      && (await oi(`select cpc_code from cargo_shipments where id = $1`, [seaId])).rows[0].cpc_code === null,
    `[${cleared.status}]`);
  const backToSea = await call(`/cargo/${seaId}`, tok1, put({ modeCode: 1, cpcCode: "4000" }));
  check("…and it is declared again in the same motion",
    backToSea.status === 200
      && (await oi(`select mode_code from cargo_shipments where id = $1`, [seaId])).rows[0].mode_code === 1,
    `[${backToSea.status}] ${text(backToSea.body)}`);
  const mismatchOnOpen = await call(`/cargo/${railId}`, tok1, put({ cpcCode: "7000" }));
  check("a stored movement, not the form's belief, decides which CPC fits an edit",
    mismatchOnOpen.status === 400 && /is a procedure for transhipment/.test(text(mismatchOnOpen.body))
      && /begins 8/.test(text(mismatchOnOpen.body)), `[${mismatchOnOpen.status}] ${text(mismatchOnOpen.body)}`);

  // ---------- 4b. The codes the block prints short, or as letters ----------
  const toShort = await call(`/cargo/${seaId}`, tok1, put({ cpcCode: "40" }));
  check("a two-digit code the block prints is filed on a movement that prints it",
    toShort.status === 200
      && (await oi(`select cpc_code from cargo_shipments where id = $1`, [seaId])).rows[0]
        ?.cpc_code === "40", `[${toShort.status}] ${text(toShort.body)}`);
  const shortDetail = await call(`/cargo/${seaId}`, tok1);
  check("…and it comes back with the words of the regime that prints it",
    shortDetail.body?.cpc_code === "40"
      && shortDetail.body?.cpc_label === "Permanent / Definitive Entry"
      && /home consumption/.test(String(shortDetail.body?.cpc_note ?? "")),
    text([shortDetail.body?.cpc_code, shortDetail.body?.cpc_label]));
  const toPaper = await call(`/cargo/${railId}`, tok1, put({ cpcCode: "t1" }));
  const afterPaper = (await oi(`select cpc_code from cargo_shipments where id = $1`, [railId])).rows[0];
  check("a transit paper typed in small letters is filed in the capitals the block prints",
    toPaper.status === 200 && afterPaper?.cpc_code === "T1", `[${toPaper.status}] ${text(afterPaper)}`);
  const paperDetail = await call(`/cargo/${railId}`, tok1);
  check("…so the file page reads the indicator back as the paper it is",
    paperDetail.body?.cpc_code === "T1"
      && paperDetail.body?.cpc_label === "Community Transit Paper (T1)",
    text([paperDetail.body?.cpc_code, paperDetail.body?.cpc_label]));
  const paperOnSea = await call(`/cargo/${seaId}`, tok1, put({ cpcCode: "T2" }));
  check("…but the same letters on an import file are refused with its own series named",
    paperOnSea.status === 400 && /is a procedure for transit/.test(text(paperOnSea.body))
      && /codes T1 and 80/.test(text(paperOnSea.body)) && /begins 4/.test(text(paperOnSea.body)),
    `[${paperOnSea.status}] ${text(paperOnSea.body)}`);
  const byLetter = await call("/cargo?search=T1", tok1);
  check("a clerk can find the file by reading its indicator across a counter",
    (byLetter.body ?? []).some((r: any) => r.id === railId), text(byLetter.body));
  await call(`/cargo/${railId}`, tok1, put({ cpcCode: "8000" }));
  await call(`/cargo/${seaId}`, tok1, put({ cpcCode: "4000" }));
  const putBack = await oi(`select cpc_code from cargo_shipments where id = any($1::uuid[])`,
    [[seaId, railId]]);
  check("both files are put back to the codes the rest of this run reads them under",
    putBack.rows.map(r => r.cpc_code).sort().join(",") === "4000,8000", text(putBack.rows));

  // ---------- 5. The register reads both codes ----------
  const register = await call("/cargo?book=clearing", tok1);
  const regRows: any[] = register.body ?? [];
  const seaRowReg = regRows.find(r => r.id === seaId);
  check("the clearing register carries the mode and the procedure in words",
    register.status === 200 && seaRowReg?.mode_code === 1
      && seaRowReg?.mode_label === "Maritime (Sea)" && seaRowReg?.cpc_code === "4000"
      && seaRowReg?.cpc_label === "Direct Import for Home Consumption", text(seaRowReg));
  const byCpc = await call("/cargo?search=4000", tok1);
  check("a clerk can find the file by reading its CPC across a counter",
    (byCpc.body ?? []).some(r => r.id === seaId) && (byCpc.body ?? []).length === 1,
    text((byCpc.body ?? []).map((r: any) => r.file_number)));
  const byMode = await call("/cargo?search=8000", tok1);
  check("…or by the transit procedure it declares under",
    (byMode.body ?? []).some(r => r.id === railId), text(byMode.body));

  // ---------- 6. The master sheet follows the file's mode ----------
  const gate = await call(`/cargo/${seaId}/master`, tok1);
  check("the master gate carries the mode the file travels by and the paper it expects",
    gate.status === 200 && gate.body?.file?.mode_label === "Maritime (Sea)"
      && gate.body?.file?.mode_bill_kind === "bill_of_lading",
    `[${gate.status}] ${text(gate.body?.file)}`);
  const wrongPaper = await call(`/cargo/${seaId}/master`, tok1, put({
    billKind: "air_waybill", billNumber: "MEDUX-7700001"
  }));
  check("a sheet that names an air waybill on a sea movement is refused with both papers said",
    wrongPaper.status === 400 && /moves by Maritime \(Sea\)/.test(text(wrongPaper.body))
      && /Bill of lading/.test(text(wrongPaper.body)) && /Air waybill/.test(text(wrongPaper.body))
      && /field.*billKind/.test(text(wrongPaper.body)),
    `[${wrongPaper.status}] ${text(wrongPaper.body)}`);
  const rightPaper = await call(`/cargo/${seaId}/master`, tok1, put({
    billKind: "bill_of_lading", billNumber: "MEDUX-7700001", billDate: shiftDays(-2),
    invoiceNumber: "INV-CP-01", invoiceCurrency: "USD", invoiceValue: 1000
  }));
  check("the paper the mode travels by is saved",
    rightPaper.status === 200 && rightPaper.body?.master?.bill_kind === "bill_of_lading",
    `[${rightPaper.status}] ${text(rightPaper.body?.state)}`);

  // Now move the file to an air mode under the desk's feet: the sheet keeps its signed-off words,
  // says the pair out loud, and must still accept a note and a pointer.
  await call(`/cargo/${seaId}`, tok1, put({ modeCode: 4 }));
  const staleGate = await call(`/cargo/${seaId}/master`, tok1);
  check("a mode changed after the sheet was filled is said as a warning, naming both papers",
    (staleGate.body?.warnings ?? []).some((w: string) => /sheet's transport document is Bill of lading/.test(w)
      && /Air transport/i.test(w) && /whose paper is Air waybill/.test(w)),
    text(staleGate.body?.warnings));
  const noteAfterMode = await call(`/cargo/${seaId}/master`, tok1, put({ notes: "AWB to follow by email" }));
  check("…and the note still saves, because a body that never named a document contradicts nothing",
    noteAfterMode.status === 200 && noteAfterMode.body?.master?.notes === "AWB to follow by email",
    `[${noteAfterMode.status}] ${text(noteAfterMode.body?.error ?? noteAfterMode.body?.message ?? "")}`);
  const stillBl = (await oi(`select bill_kind, notes from cargo_import_masters where shipment_id = $1`,
    [seaId])).rows[0];
  check("SQL: the sheet keeps the document it named and takes the new note",
    stillBl?.bill_kind === "bill_of_lading" && stillBl?.notes === "AWB to follow by email",
    text(stillBl));
  const fixPaper = await call(`/cargo/${seaId}/master`, tok1, put({ billKind: "air_waybill" }));
  check("naming the paper the file now travels by saves, and the warning leaves",
    fixPaper.status === 200 && fixPaper.body?.master?.bill_kind === "air_waybill"
      && (fixPaper.body?.warnings ?? []).every((w: string) => !/out of date/.test(w)),
    `[${fixPaper.status}] ${text(fixPaper.body?.warnings)}`);
  const mailSheet = await call(`/cargo/${mailId}/master`, tok1, put({
    billKind: "road_waybill", billNumber: "POST-CP-7000"
  }));
  check("a postal file's sheet is free to name any paper — its mode names none",
    mailSheet.status === 200 && mailSheet.body?.master?.bill_kind === "road_waybill",
    `[${mailSheet.status}] ${text(mailSheet.body?.message ?? "")}`);

  // ---------- 7. The guards in SQL, whatever the route believes ----------
  const guards: [string, string, string | null, string][] = [
    ["a transit file cannot be given an import procedure",
      `update cargo_shipments set cpc_code = '4000' where id = $1`, railId, "is a procedure for import"],
    ["an import file cannot be given an export procedure",
      `update cargo_shipments set cpc_code = '1000' where id = $1`, seaId, "is a procedure for export"],
    ["an import file cannot be given a transit paper",
      `update cargo_shipments set cpc_code = 'T2' where id = $1`, seaId, "is a procedure for transit"],
    ["a mode outside the six cannot be bound by SQL either",
      `update cargo_shipments set mode_code = 7 where id = $1`, seaId, "23503"],
    ["a procedure cannot be invented on a movement it does not name",
      `insert into customs_procedure_code (code, shipment_type, label)
       values ('4300','export','Codeprobe Invented Procedure')`, null, "23514"],
    ["the list itself refuses a number outside the series its regime prints",
      `insert into customs_procedure_code (code, shipment_type, label)
       values ('45','transit','Codeprobe Wrong Series')`, null, "cannot be a transit procedure"],
    ["…and refuses a letter the block never prints",
      `insert into customs_procedure_code (code, shipment_type, label)
       values ('T3','transhipment','Codeprobe Wrong Indicator')`, null, "23514"],
    ["…or a code that would belong to no regime",
      `insert into customs_procedure_code (code, shipment_type, label)
       values ('99','import','Codeprobe No Regime')`, null, "23514"]
  ];
  await oi("begin");
  let sp = 0;
  for (const [label, sql, bind, want] of guards) {
    const name = `sp${sp++}`;
    await oi(`savepoint ${name}`);
    let caught = "";
    try {
      await oi(sql, bind === null ? [] : [bind]);
      caught = "NO ERROR — the write went through";
    } catch (e: any) { caught = `${e.code ?? "?"} ${e.message ?? ""}`; }
    await oi(`rollback to savepoint ${name}`);
    check(`SQL guard: ${label}`, new RegExp(want, "i").test(caught), caught.slice(0, 200));
  }
  await oi("rollback");
  check("the guard probes left the file and the vocabulary as the desk left them",
    (await oi(`select mode_code, cpc_code from cargo_shipments where id = $1`, [seaId])).rows[0]
      ?.cpc_code === "4000"
      && (await oi(`select count(*)::int as n from customs_procedure_code`)).rows[0].n === 16
      && (await oi(`select count(*)::int as n from customs_regime`)).rows[0].n === 4);

  // ---------- 8. A foreign tenant sees neither the codes nor the sheet ----------
  for (const p of [`/cargo/${seaId}`, `/cargo/${seaId}/master`]) {
    const r = await call(p, tok2);
    check(`B reads ${p} and gets nothing of A's file`, r.status === 404, `[${r.status}] ${text(r.body)}`);
  }
  const bWrite = await call(`/cargo/${railId}/master`, tok2, put({ billKind: "rail_waybill" }));
  check("B cannot answer for A's sheet", bWrite.status === 404, `[${bWrite.status}]`);
  const bRegister = await call("/cargo", tok2);
  check("B's register holds none of this run's files",
    (bRegister.body ?? []).every((r: any) => ![seaId, railId, mailId].includes(r.id)),
    text((bRegister.body ?? []).map((r: any) => r.file_number)));
  const noDutyWrite = await call(`/cargo/${railId}`, tokBare, put({ modeCode: 3 }));
  check("a seat without the cargo duty cannot recode a file", noDutyWrite.status === 403,
    `[${noDutyWrite.status}]`);

  // ---------- 9. What the desk declared is what the database holds ----------
  const final = await oi(
    `select s.id, s.file_number, s.shipment_type, s.mode_code, m.label as mode_label,
            m.bill_kind as mode_bill_kind, s.cpc_code, p.label as cpc_label,
            r.code_pattern, r.file_prefix, r.series_words,
            k.bill_kind as sheet_kind
       from cargo_shipments s
       left join mode_of_transport m on m.code = s.mode_code
       left join customs_procedure_code p on p.code = s.cpc_code
       left join customs_regime r on r.shipment_type = s.shipment_type
       left join cargo_import_masters k on k.shipment_id = s.id and k.deleted_at is null
      where s.tenant_id = $1 and s.deleted_at is null
      order by s.file_number`, [T1]);
  const rows = final.rows;
  check("SQL: every file's mode and procedure are read back through the two lists, in words",
    rows.length === 3 && rows.every(r => !!r.mode_label && !!r.cpc_label), text(rows));
  check("SQL: only the four paper-carrying modes name a document",
    rows.every(r => (r.mode_code <= 4 ? !!r.mode_bill_kind : !r.mode_bill_kind)),
    text(rows.map(r => [r.file_number, r.mode_code, r.mode_bill_kind])));
  check("SQL: every file's code fits the series its own regime prints, and its number the digit too",
    rows.every(r => new RegExp(r.code_pattern).test(r.cpc_code)
      && String(r.file_number)[0] === r.file_prefix),
    text(rows.map(r => [r.file_number, r.shipment_type, r.cpc_code, r.code_pattern])));
  check("SQL: the sea file's sheet now names the air waybill the file's mode travels on",
    rows.find(r => r.id === seaId)?.sheet_kind === "air_waybill",
    text(rows.map(r => [r.file_number, r.mode_code, r.cpc_code, r.sheet_kind])));

  const audit = await oi(
    `select action, count(*)::int as n from audit_logs
      where tenant_id = $1 and entity in ('cargo_shipments','cargo_import_masters')
      group by action`, [T1]);
  check("every write is in the audit register under its own entity",
    audit.rows.length >= 2 && audit.rows.some(r => r.action === "shipment.updated")
      && audit.rows.some(r => /master\./.test(r.action)), text(audit.rows));

  // ---------- cleanup ----------
  for (const t of WIPE) await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [[T1, T2]]);
  await oi(wipeRoles, [[T1, T2]]);
  await oi(`delete from users where tenant_id = any($1::uuid[])`, [[T1, T2]]);
  await oi(`delete from tenants where id = any($1::uuid[])`, [[T1, T2]]);
  const residue = await oi(
    `select (select count(*) from cargo_shipments where tenant_id = any($1::uuid[]))::int as s,
            (select count(*) from cargo_import_masters where tenant_id = any($1::uuid[]))::int as m,
            (select count(*) from customs_procedure_code)::int as p,
            (select count(*) from customs_regime)::int as g,
            (select count(*) from tenants where id = any($1::uuid[]))::int as t`, [[T1, T2]]);
  const re = residue.rows[0];
  check("cleanup: no probe rows left and both reference lists still hold everything they declare",
    re.s === 0 && re.m === 0 && re.t === 0 && re.p === 16 && re.g === 4, text(re));
  console.log(`\ncargo codes smoke: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " FAILURES"}`);
  await owner.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
