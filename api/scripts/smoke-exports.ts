/**
 * End-to-end smoke for the report export path (#224) against a running API on :4000.
 *
 * It exports the cargo register the fixture tenant really holds, reads both files back
 * with the libraries that open them (ExcelJS for the workbook, pdfjs for the page) and
 * then asks the questions an operator would notice the answer to: did every row arrive,
 * is the money a number, does the printed page carry the same figure as the screen, is
 * anything the browser typed being treated as a formula, and did the desk leave an
 * audit row that names the report without copying the rows into the log.
 *
 * Nothing here logs in — tokens are minted, so the login throttle is not touched, and
 * the run writes no business rows, so it needs no teardown beyond the audit trail
 * (append-only by design).
 *
 * Run: npx tsx scripts/smoke-exports.ts   (with the API booted)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";
import { Workbook } from "exceljs";
import { extractTextLines } from "../src/billing/pdf.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

async function mint(sub: string, tid: string, roles: string[] = ["director"]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000bb", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("15m").sign(key);
}

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

const sumBy = (list: any[], key: string) =>
  Number(list.reduce((acc, row) => acc + (Number(row[key]) || 0), 0).toFixed(2));

async function main() {
  const startedAt = Date.now();
  const owner = new pg.Client({ connectionString: process.env.MIGRATE_DATABASE_URL,
    ssl: { rejectUnauthorized: false } });
  await owner.connect();

  const who = await owner.query(
    "select u.id, u.tenant_id, u.full_name from users u" +
    " join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id" +
    " where r.key = 'director' and u.deleted_at is null" +
    " and u.tenant_id = (select tenant_id from cargo_shipments where deleted_at is null" +
    "   order by created_at desc limit 1) limit 1");
  if (!who.rowCount) throw new Error("no director seat with cargo on hand — seed the sweep fixture first");
  const { id: userId, tenant_id: tid, full_name: fullName } = who.rows[0];
  const token = await mint(userId, tid);
  console.log(`seat ${fullName} tenant ${tid}`);

  const call = async (path: string, init: RequestInit = {}, tok: string | null = token) => {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }
    });
    return res;
  };

  // --- the register the desk is showing -------------------------------------------------
  const cargoRes = await call("/cargo");
  const files: any[] = await cargoRes.json() as any;
  const rows = Array.isArray(files) ? files : (files as any).rows ?? [];
  check(`cargo register read (${rows.length} files)`, cargoRes.ok && rows.length > 0);

  const columns = [
    { key: "file", label: "File no.", type: "text" },
    { key: "consignee", label: "Consignee", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "stage", label: "Stage", type: "text" },
    { key: "eta", label: "ETA", type: "date" },
    { key: "weight", label: "Weight (t)", type: "number" },
    { key: "billed", label: "Billed", type: "money" },
    { key: "cost", label: "Processing cost", type: "money" },
    // A column of its own, because a hostile string that is never sent is a check
    // that never runs.
    { key: "note", label: "Operator note", type: "text" }
  ];
  const tableRows = rows.map((f: any) => ({
    file: f.file_number, consignee: f.consignee_name, type: f.shipment_type,
    stage: f.stage, eta: typeof f.eta === "string" ? f.eta.slice(0, 10) : f.eta,
    weight: f.weight_tonnes, billed: f.payment_amount, cost: f.processing_cost,
    // hostile input, because an operator pastes it into a name field all the time
    note: "=HYPERLINK(\"http://evil.test\")"
  }));

  const payload = (format: string, extra: any = {}) => JSON.stringify({
    format, report: "cargo",
    title: "Cargo files — smoke register",
    subtitle: "Every file the desk can see, opened from the export endpoint",
    meta: [{ label: "Shipment type", value: "All" }, { label: "Stage", value: "All" }],
    columns, rows: tableRows, ...extra
  });

  // --- duty list -------------------------------------------------------------------------
  const reportsRes = await call("/exports/reports");
  const reportsJson: any = await reportsRes.json();
  check("duty list names the cargo register", reportsRes.ok
    && Array.isArray(reportsJson?.reports) && reportsJson.reports.includes("cargo"),
    reportsJson?.reports?.length);

  // --- the workbook ----------------------------------------------------------------------
  const xlsxRes = await call("/exports/table", { method: "POST", body: payload("xlsx") });
  const xlsxType = xlsxRes.headers.get("content-type") ?? "";
  const disposition = xlsxRes.headers.get("content-disposition") ?? "";
  check("xlsx answered as a sheet, not JSON", xlsxRes.ok && xlsxType.includes("spreadsheetml"),
    { status: xlsxRes.status, xlsxType });
  check("xlsx filename is a slug of the title", /^attachment; filename="cargo-files-smoke-register-\d{4}-\d{2}-\d{2}\.xlsx"$/.test(disposition),
    disposition);
  const xbytes = Buffer.from(await xlsxRes.arrayBuffer());
  check("xlsx carries the zip signature", xbytes.subarray(0, 2).toString("latin1") === "PK",
    xbytes.subarray(0, 4).toString("hex"));

  const wb = new Workbook();
  // exceljs pins an older @types/node than this package resolves, so its `Buffer` and
  // node's are structurally different types. The bytes are the bytes.
  await wb.xlsx.load(xbytes as any);
  const ws = wb.worksheets[0];
  let head = 0;
  ws.eachRow((row, n) => { if (!head && String(row.getCell(1).value ?? "") === "File no.") head = n; });
  check("workbook has one header row inside the first 12 lines", head > 0 && head <= 12, head);
  // one header line, every row of the register, and the totals line the sheet exists for
  check("workbook holds every row of the register plus its totals line",
    ws.rowCount === head + rows.length + 1, { rowCount: ws.rowCount, head, rows: rows.length });
  const lastRow = ws.getRow(ws.rowCount);
  check("the last line is the totals row",
    String(lastRow.getCell(1).value ?? "").startsWith(`Total (${rows.length} rows)`),
    String(lastRow.getCell(1).value ?? ""));
  const firstData = ws.getRow(head + 1);
  check("header labels survive", JSON.stringify(ws.getRow(head).values)
    .includes("Processing cost") && JSON.stringify(ws.getRow(head).values).includes("Operator note"));
  check("the file number on the sheet is the file number in the system",
    String(firstData.getCell(1).value) === String(rows[0].file_number),
    [String(firstData.getCell(1).value), rows[0].file_number]);
  const arrived = rows.every((f: any, i: number) =>
    String(ws.getRow(head + 1 + i).getCell(1).value) === String(f.file_number));
  check("every row arrived, in the order the desk showed them", arrived);
  // A register that holds no money yet has no figure to format, and an assertion about a
  // blank cell is not proof of anything. Find a row that really carries a bill, and say
  // plainly when the live data offers none.
  const billedAt = rows
    .map((f: any, i: number) => ({ f, i }))
    .find(({ f }: { f: any; i: number }) => f.payment_amount != null);
  const withBills = rows.filter((f: any) => f.payment_amount != null).length;
  console.log(`money on hand: ${withBills} of ${rows.length} files carry a billed figure` +
    (withBills ? "" : " — the fabricated register below carries the money assertions"));
  if (billedAt) {
    const moneyCell = ws.getRow(head + 1 + billedAt.i).getCell(7);
    check("billed arrives as a number so SUM works", typeof moneyCell.value === "number",
      { value: String(moneyCell.value), source: billedAt.f.payment_amount });
    check("money cell carries a number format", moneyCell.numFmt === "#,##0.00", moneyCell.numFmt);
    check("the billed figure on the sheet is the figure in the system",
      Math.abs(Number(moneyCell.value) - Number(billedAt.f.payment_amount)) < 0.005,
      { sheet: moneyCell.value, source: billedAt.f.payment_amount });
  }
  const dateIsReal = firstData.getCell(5).value instanceof Date;
  check("ETA arrives as a real date", dateIsReal || rows[0].eta == null,
    String(firstData.getCell(5).value));

  let formulas = 0;
  ws.eachRow((row) => row.eachCell((cell) => {
    const v: any = cell.value;
    if (v && typeof v === "object" && "formula" in v) formulas++;
  }));
  check("no cell became a formula", formulas === 0, formulas);
  const noteCell = String(firstData.getCell(9).value ?? "");
  check("the pasted =HYPERLINK reached the sheet as text, not a formula",
    noteCell === tableRows[0].note && firstData.getCell(9).type !== 2, noteCell);
  const sheetTotal = Number(lastRow.getCell(7).value);
  check("the sheet's own total adds up",
    Math.abs(sheetTotal - sumBy(rows, "payment_amount")) < 0.005,
    { sheetTotal, expected: sumBy(rows, "payment_amount") });
  check("the workbook footer carries the page counter",
    String((ws as any).headerFooter?.oddFooter ?? "").includes("Page &P of &N"),
    String((ws as any).headerFooter?.oddFooter ?? "").slice(0, 80));

  // --- the printed page ------------------------------------------------------------------
  const pdfRes = await call("/exports/table", { method: "POST", body: payload("pdf") });
  check("pdf answered as a pdf", pdfRes.ok
    && (pdfRes.headers.get("content-type") ?? "").includes("application/pdf"), pdfRes.status);
  const pbytes = Buffer.from(await pdfRes.arrayBuffer());
  check("pdf carries the %PDF signature", pbytes.subarray(0, 5).toString("latin1") === "%PDF-",
    pbytes.subarray(0, 8).toString("latin1"));
  const text = await extractTextLines(pbytes);
  // The reader stops at 8 pages on purpose. If a run hits that, the checks below that
  // read the last page cannot be honest, so the truncation is reported as a failure of
  // this run rather than silently passing a page the reader never saw.
  check("every printed page reached the reader", !text.truncated,
    { pageCount: text.pageCount, lines: text.lines.length });
  check("page count footer is honest", text.pageCount >= 1
    && text.lines.some((l) => new RegExp(`Page 1 of ${text.pageCount}`).test(l)),
    { pageCount: text.pageCount });
  const joined = text.lines.join("  ");
  check("printed page names the register and the seat",
    joined.includes("Cargo files - smoke register") && joined.includes(String(fullName)),
    text.lines.slice(0, 4));
  const liveHead = text.lines.find((l) => /File no\./.test(l)) ?? "";
  check("every declared column header survives onto the page",
    columns.every((c) => joined.includes(c.label)),
    { missing: columns.filter((c) => !joined.includes(c.label)).map((c) => c.label),
      printed: liveHead });
  // The page prints a plain hyphen for every Unicode dash, so the expectation is
  // normalised the same way. The promise is that the file number arrived whole, not
  // which dash the operator's browser happened to hold.
  const asPrinted = (s: string) => s.replace(/[‐‑‒―–—−]/g, "-");
  const wantedFile = asPrinted(String(rows[0].file_number));
  // A text column may be shortened to fit the page — that is the deal the printer makes
  // with prose. What it must never do is change a character or cut one off without
  // saying so: a file number printed as a different number is a wrong number.
  const fileLines = text.lines.filter((l) => l.includes(wantedFile.slice(0, 6)));
  check("the first file number is on the page whole or cut short in the open",
    fileLines.length > 0
      && (joined.includes(wantedFile) || fileLines[0].includes("...")),
    { wanted: wantedFile, printed: fileLines.slice(0, 1) });
  const cutFigures = text.lines.filter((l) => /[\d]{3,}[,.]?\d*\.\.\./.test(l));
  check("no figure on the page is cut short", cutFigures.length === 0, cutFigures.slice(0, 2));
  check("the totals line adds the register up",
    text.lines.some((l) => /Total - \d+ rows/.test(l)), text.lines.slice(-2));

  const expectedBilled = sumBy(rows, "payment_amount");
  const totalLine = text.lines.find((l) => /Total - \d+ rows/.test(l)) ?? "";
  // Compared as numbers, not as text: a printed figure is the thing a person signs for,
  // and how pdfjs chooses to space the glyphs is not part of the promise.
  const printedFigures = (totalLine.match(/[\d,]+(?:\.\d+)?/g) ?? [])
    .map((s) => Number(s.replace(/,/g, "")));
  check("the printed total equals the sum of the register",
    expectedBilled === 0 || printedFigures.some((f) => Math.abs(f - expectedBilled) < 0.005),
    { expectedBilled, printedFigures: printedFigures.slice(0, 6) });
  const printedCost = sumBy(rows, "processing_cost");
  check("the second money column is totalled too",
    printedCost === 0 || printedFigures.some((f) => Math.abs(f - printedCost) < 0.005),
    { printedCost });

  // --- a register that certainly carries money --------------------------------------------
  // The files on this tenant are unpaid, so the live register above cannot prove the
  // number path: a blank money cell is skipped by ExcelJS's eachCell and measured as
  // empty by the page. This register is invented on the spot — same endpoint, same duty,
  // rows that never existed — and it holds a bill in every line, including one with
  // thousands and decimals and one at zero.
  const bills = [
    { no: "SMK‑2026‑001", party: "Mwanza Bulk Ltd", kg: 12.5, duty: 98764.5 },
    { no: "SMK-2026-002", party: "Tabora Freight Co", kg: 3, duty: 1250 },
    { no: "SMK-2026-003", party: "Dodoma Consolidators", kg: 0.75, duty: 0 }
  ];
  const billBody = (format: string) => JSON.stringify({
    format, report: "cargo", title: "Cargo duty - fabricated register",
    columns: [
      { key: "no", label: "File no.", type: "text" },
      { key: "party", label: "Consignee", type: "text" },
      { key: "kg", label: "Weight (t)", type: "number" },
      { key: "duty", label: "Duty payable", type: "money" }
    ],
    rows: bills.map((b) => ({ no: b.no, party: b.party, kg: b.kg, duty: b.duty }))
  });
  const dutySum = Number(bills.reduce((a, b) => a + b.duty, 0).toFixed(2));

  const fx = await call("/exports/table", { method: "POST", body: billBody("xlsx") });
  const fabWb = new Workbook();
  await fabWb.xlsx.load(Buffer.from(await fx.arrayBuffer()) as any);
  const fws = fabWb.worksheets[0];
  let fhead = 0;
  fws.eachRow((row, n) => { if (!fhead && String(row.getCell(1).value ?? "") === "File no.") fhead = n; });
  const dutyCell = fws.getRow(fhead + 1).getCell(4);
  check("a duty figure is typed as a number in the cell", typeof dutyCell.value === "number",
    String(dutyCell.value));
  check("and carries the money format a SUM needs", dutyCell.numFmt === "#,##0.00",
    dutyCell.numFmt);
  check("the workbook total equals the register's duties",
    Math.abs(Number(fws.getRow(fws.rowCount).getCell(4).value) - dutySum) < 0.005,
    { sheet: fws.getRow(fws.rowCount).getCell(4).value, expected: dutySum });
  check("a zero duty stays a zero rather than turning blank",
    Number(fws.getRow(fhead + 3).getCell(4).value) === 0,
    String(fws.getRow(fhead + 3).getCell(4).value));

  const fp = await call("/exports/table", { method: "POST", body: billBody("pdf") });
  const ftext = await extractTextLines(Buffer.from(await fp.arrayBuffer()));
  // Compared with the spaces squeezed out: pdfjs pads between the cells of a row, and the
  // promise is that the letters arrive in order, not that they arrive adjacent.
  const packed = ftext.lines.join("").replace(/\s+/g, "");
  const headLine = ftext.lines.find((l) => /File no\./.test(l)) ?? "";
  check("the printed page carries the full nine-thousand-figure duty",
    packed.includes("98,764.50"), ftext.lines.slice(0, 3));
  check("it carries the zero duty too", packed.includes("0.00"));
  check("and the duty column's own header is whole", headLine.includes("Duty payable"), headLine);
  // The first of these three arrives with a non-breaking hyphen in the source. Printed
  // whole, it proves the page substituted the dash rather than dropping it — the failure
  // mode that turns EXP‑2026‑1000 into EXP20261000 and reads as the same number.
  check("every file number prints whole when the page has room for it",
    ["SMK-2026-001", "SMK-2026-002", "SMK-2026-003"].every((f) => packed.includes(f)),
    ftext.lines.slice(3, 6));
  check("the printed duty total equals the workbook's",
    packed.includes(new Intl.NumberFormat("en-US", { minimumFractionDigits: 2,
      maximumFractionDigits: 2 }).format(dutySum)), { dutySum });
  check("no duty figure on the page is cut short",
    !/[0-9]{3}(,[0-9]{3})*\.[0-9]{2}\.\.\./.test(packed));

  // --- the gates -------------------------------------------------------------------------
  const unknown = await call("/exports/table",
    { method: "POST", body: payload("xlsx", { report: "secrets" }) });
  check("an unlisted report is refused", unknown.status === 400, await unknown.text());

  const noToken = await call("/exports/table", { method: "POST", body: payload("xlsx") }, null);
  check("no token, no file", noToken.status === 401, noToken.status);

  const stranger = await mint("00000000-0000-4000-8000-0000000000ff", tid, ["trainee"]);
  const denied = await call("/exports/table", { method: "POST", body: payload("xlsx") }, stranger);
  check("a seat without the export duty is refused", denied.status === 403,
    { status: denied.status, body: (await denied.text()).slice(0, 120) });

  const big = JSON.parse(payload("pdf"));
  big.rows = Array.from({ length: 3001 }, (_, i) => ({ file: `X-${i}`, billed: 1 }));
  const capped = await call("/exports/table", { method: "POST", body: JSON.stringify(big) });
  check("a 3001-row print is sent to Excel instead", capped.status === 413,
    { status: capped.status, body: (await capped.text()).slice(0, 140) });

  const oversized = JSON.parse(payload("xlsx"));
  oversized.columns = Array.from({ length: 41 }, (_, i) => ({ key: `c${i}`, label: `Col ${i}`, type: "text" }));
  const rejected = await call("/exports/table", { method: "POST", body: JSON.stringify(oversized) });
  check("41 columns are refused before anything is built", rejected.status >= 400, rejected.status);

  // --- the audit trail -------------------------------------------------------------------
  const audit = await owner.query(
    "select action, entity, entity_id, after from audit_logs where tenant_id = $1" +
    " and entity = 'report_exports' order by ts desc limit 4", [tid]);
  const acts = audit.rows.map((r) => r.action);
  check("both exports are on the record", acts.includes("export.xlsx") && acts.includes("export.pdf"), acts);
  // entity_id is a uuid: an export is not a row, and a log that cannot say which record
  // it touched must not pretend to by stuffing a name into that column.
  check("the export rows name no business record",
    audit.rows.every((r) => r.entity_id === null), audit.rows.map((r) => r.entity_id));
  const payloadKeys = Object.keys(audit.rows[0]?.after ?? {}).sort().join(",");
  check("the audit row describes the file, not its contents",
    payloadKeys === "bytes,columns,report,rows,title", payloadKeys);
  const leaked = JSON.stringify(audit.rows.map((r) => r.after))
    .includes(String(rows[0]?.consignee_name ?? "\u0000"));
  check("no customer name was copied into the log", !leaked);

  const residue = await owner.query(
    "select (select count(*) from cargo_shipments where tenant_id=$1 and created_at > $2)::int as new_files," +
    " (select count(*) from invoices where tenant_id=$1 and created_at > $2)::int as new_bills",
    [tid, new Date(startedAt)]);
  check("the export path wrote no business rows",
    residue.rows[0].new_files === 0 && residue.rows[0].new_bills === 0, residue.rows[0]);

  await owner.end();
  console.log(`\n${failures === 0 ? "export smoke clean" : `${failures} FAILED CHECK(S)`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
