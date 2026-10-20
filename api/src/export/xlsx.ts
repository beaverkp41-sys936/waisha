import { Workbook, type Cell as XlsxCell, type Worksheet } from "exceljs";
import { money, type Cell, type PreparedTable } from "./table.js";

/**
 * An Excel workbook for a report table.
 *
 * Written as a real .xlsx rather than a CSV because the thing an accountant does with a
 * register is sort it, filter it and add it up: a CSV loses the number formats, the
 * frozen header and the totals, and arrives as one flat column when the text contains a
 * comma. Money cells are numbers with a `#,##0.00` format, so SUM works on them the
 * moment the file opens.
 */

const SHEET_NAME_BAD = /[\\/*?:[\]]/g;
const HEADER_FILL = "FF1F3A2C";

function sheetName(table: PreparedTable): string {
  return (table.title.replace(SHEET_NAME_BAD, " ").trim() || "Report").slice(0, 31);
}

/** Dates go in as real dates so a filter or a pivot treats them as a timeline. */
function dateCell(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function widthOf(label: string, type: string, values: Cell[]): number {
  const longest = values.reduce<number>((max, v) => {
    const text = v === null || v === undefined ? "" : typeof v === "number" ? money(v) : String(v);
    return Math.max(max, text.length);
  }, label.length);
  const floor = type === "money" ? 13 : type === "date" ? 12 : 10;
  return Math.min(46, Math.max(floor, longest + 2));
}

function styleHeader(cell: XlsxCell): void {
  cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  cell.border = { bottom: { style: "thin", color: { argb: "FF0F1E17" } } };
}

function fillSheet(ws: import("exceljs").Worksheet, table: PreparedTable): void {
  // Widths are derived before the sheet is written, but `header` is deliberately not
  // set here: exceljs answers a declared header by inserting its own row at the top of
  // the sheet, and the register would then start with two label lines — one of them
  // unstyled, sitting above the title.
  ws.columns = table.columns.map((c, i) => ({
    key: `c${i}`,
    width: widthOf(c.label, c.type, table.cells.map((r) => r[i]))
  }));

  // The title block occupies the rows above the header, so the table always starts on a
  // known line and the frozen pane can be set against it.
  const intro: string[] = [table.title];
  if (table.subtitle) intro.push(table.subtitle);
  for (const m of table.meta) intro.push(`${m.label}: ${m.value}`);
  intro.push(`Generated ${table.generatedAt.toISOString().slice(0, 10)} · ` +
    `${table.cells.length} row${table.cells.length === 1 ? "" : "s"} · ${table.actor}`);

  for (const line of intro) {
    const row = ws.addRow([line]);
    row.getCell(1).font = line === table.title ? { bold: true, size: 14 } : { size: 10, italic: true };
    row.getCell(1).alignment = { horizontal: "left" };
  }
  ws.addRow([]);

  const headerRow = ws.addRow(table.columns.map((c) => c.label));
  headerRow.eachCell(styleHeader);
  headerRow.height = 22;
  ws.views = [{ state: "frozen", ySplit: headerRow.number }];
  ws.autoFilter = { from: { row: headerRow.number, column: 1 },
    to: { row: headerRow.number, column: table.columns.length } };

  for (const cells of table.cells) {
    const row = ws.addRow(cells.map((v, i) => {
      const type = table.columns[i].type;
      if (v === null) return null;
      if (type === "date" && typeof v === "string") return dateCell(v);
      return v;
    }));
    row.eachCell((cell, colNumber) => {
      const type = table.columns[colNumber - 1].type;
      if (type === "money") {
        cell.numFmt = "#,##0.00";
        cell.alignment = { horizontal: "right" };
      } else if (type === "number") {
        cell.numFmt = "#,##0.0#";
        cell.alignment = { horizontal: "right" };
      } else if (type === "date") {
        cell.numFmt = "yyyy-mm-dd";
      } else {
        cell.alignment = { vertical: "top", wrapText: cell.value !== null
          && String(cell.value ?? "").length > 60 };
      }
    });
  }

  // One totals line: the figure every register is opened for.
  const sumColumns = table.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.type === "money" || c.type === "number");
  if (sumColumns.length && table.cells.length) {
    const totals = table.columns.map(() => null as string | number | null);
    totals[0] = `Total (${table.cells.length} rows)`;
    for (const { c, i } of sumColumns) {
      const sum = table.cells.reduce((acc, row) => acc + (typeof row[i] === "number"
        ? (row[i] as number) : 0), 0);
      totals[i] = Number(sum.toFixed(2));
    }
    const row = ws.addRow(totals);
    row.eachCell((cell, colNumber) => {
      cell.font = { bold: true };
      cell.border = { top: { style: "thin", color: { argb: HEADER_FILL } } };
      const type = table.columns[colNumber - 1].type;
      if (type === "money") cell.numFmt = "#,##0.00";
      if (type === "number") cell.numFmt = "#,##0.0#";
      if (type === "money" || type === "number") cell.alignment = { horizontal: "right" };
    });
  }
}

/**
 * One workbook, several registers — the shape a cargo bundle needs, because a file's
 * story is a shipment line plus its tasks, stages, costs, documents and messages, and an
 * accountant reads that as tabs of one file rather than six downloads.
 *
 * Each sheet carries its own title block, frozen header and totals, exactly as the
 * single-register writer lays them out.
 */
export async function buildWorkbook(tables: PreparedTable[]): Promise<Buffer> {
  if (!tables.length) throw new Error("buildWorkbook needs at least one table.");
  const wb = new Workbook();
  wb.creator = "Waisha";
  wb.title = tables[0].title;
  wb.created = tables[0].generatedAt;

  const taken = new Set<string>();
  for (const table of tables) {
    let name = sheetName(table);
    for (let n = 2; taken.has(name); n++) name = `${sheetName(table).slice(0, 26)} (${n})`;
    taken.add(name);
    const ws = wb.addWorksheet(name, {
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
      headerFooter: { oddFooter: `&L&9${table.title} · ${table.generatedAt.toISOString()
        .slice(0, 16).replace("T", " ")} · ${table.actor}&9&R&9Page &P of &N&9` }
    });
    fillSheet(ws, table);
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/** The single-register case the export route answers with today. */
export async function buildXlsx(table: PreparedTable): Promise<Buffer> {
  return buildWorkbook([table]);
}
