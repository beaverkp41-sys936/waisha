import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { asText, type Cell, type ExportColumn, type PreparedTable } from "./table.js";

/**
 * A printed page for a report table.
 *
 * pdf-lib and the Helvetica that ships inside the file, not a headless browser: the
 * alternative is a Chromium on the API box that renders the web page, which is slow,
 * memory-hungry on a Render instance, and quietly breaks whenever a stylesheet changes.
 * This writes a paginated register with the header row repeated on every sheet and a
 * page count in the footer, which is what a report is handed over as.
 *
 * The two standard fonts are WinAnsi-encoded, so anything outside that alphabet is
 * substituted or dropped before it reaches the page — one em dash in a consignee's name
 * would otherwise throw in the middle of a draw and lose the whole file.
 */

const A4 = { long: 841.89, short: 595.28 };
const MARGIN = 34;
const ROW_H = 16;
const HEAD_H = 22;
const GAP = 6;

const INK = rgb(0.1, 0.12, 0.11);
const SOFT = rgb(0.35, 0.38, 0.36);
const BAND = rgb(0.12, 0.23, 0.17);
const STRIPE = rgb(0.96, 0.97, 0.96);
const LINE = rgb(0.78, 0.8, 0.79);

/** Characters a Latin-1 font cannot draw, said in a way a reader still recognises. */
const SAY_INSTEAD: [RegExp, string][] = [
  // Every dash in the Unicode hyphen family, and the minus sign, come out as a hyphen:
  // a file number typed as EXP‑2026‑1000 must not print as EXP20261000, which is a
  // different number and reads as the same one.
  [/[‐‑‒―–—−]/g, "-"], [/[‘’]/g, "'"], [/[“”]/g, '"'], [/…/g, "..."], [/[•·]/g, "*"],
  [/≥/g, ">="], [/≤/g, "<="], [/→/g, "->"], [/×/g, "x"], [/±/g, "+/-"], [/°/g, " deg"]
];

const WINANSI_HIGH = new Set([0x20ac, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178]);

function printable(text: string): string {
  let out = "";
  let s = text;
  for (const [from, to] of SAY_INSTEAD) s = s.replace(from, to);
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WINANSI_HIGH.has(c)) out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * What a column would like to be, measured in points with the page's own font.
 *
 * Numbers never get to truncate: a register whose duty column reads `98,764....` is
 * worse than useless, because the figure on the page then contradicts the figure in the
 * system. Text columns are the flexible ones — a consignee's name may end in an ellipsis
 * and the row is still identifiable.
 */
function naturalWidths(columns: ExportColumn[], cells: Cell[][], body: PDFFont,
  head: PDFFont, size: number): { width: number; flexible: boolean; floor: number }[] {
  const pad = 2 * GAP;
  // One point of slack on anything sized by measured text. A cell is clipped against its
  // own width minus the padding, so a column that came out exactly as wide as the word
  // inside it sits on a floating-point hair from being narrower than it — which is how
  // "Billed" arrives on the page as "Bil..." even when nothing else was squeezed.
  const room = (textW: number) => textW + pad + 1;
  return columns.map((c, i) => {
    // The header is drawn in the bold face and clipped against this same width, so it
    // has to be measured in the bold face — Helvetica is narrower than Helvetica-Bold
    // and "Duty payable" arrives on the page already cut short otherwise.
    const labelW = head.widthOfTextAtSize(printable(c.label), size);
    // No column gives way past the word that names it: a register whose own labels are
    // ellipsised is not a report, it is a warning.
    const header = room(labelW);
    let content = 0;
    for (const row of cells) {
      const text = printable(asText(row[i], c.type));
      if (!text) continue;
      content = Math.max(content, body.widthOfTextAtSize(text, size));
      if (content > 300) break;
    }
    const numeric = c.type === "money" || c.type === "number";
    if (c.width) return { width: c.width, flexible: false, floor: Math.min(c.width, header) };
    if (numeric) {
      const width = Math.max(header, room(Math.min(150, content)));
      return { width, flexible: false, floor: width };
    }
    if (c.type === "date") return { width: Math.max(header, room(68)), flexible: false,
      floor: Math.max(header, room(68)) };
    if (c.type === "bool") return { width: Math.max(header, room(34)), flexible: false,
      floor: Math.max(header, room(34)) };
    return { width: Math.max(header, Math.min(260, Math.max(84, room(content)))),
      flexible: true, floor: header };
  });
}

/** Fill the page when there is room; take it back from the text columns when there is not. */
function fit(specs: { width: number; flexible: boolean; floor: number }[], avail: number): number[] {
  const totalOf = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  let widths = specs.map((s) => s.width);
  const total = totalOf(widths);
  if (total <= avail) {
    const flexSum = widths.reduce((s, w, i) => (specs[i].flexible ? s + w : s), 0);
    if (flexSum > 0) {
      const slack = avail - total;
      widths = widths.map((w, i) => (specs[i].flexible ? w + (slack * w) / flexSum : w));
    }
    return widths;
  }
  const shrinkable = widths.reduce((s, w, i) => (specs[i].flexible ? s + (w - specs[i].floor) : s), 0);
  const cut = Math.min(total - avail, Math.max(0, shrinkable));
  const base = shrinkable || 1;
  widths = widths.map((w, i) => (specs[i].flexible ? Math.max(specs[i].floor, w - cut * ((w - specs[i].floor) / base)) : w));
  const still = totalOf(widths) - avail;
  // Only a real overflow reaches the last pass. A column that ended up exactly as wide
  // as its own label is one floating-point hair from being narrower than it, and the
  // printer would then cut the word that names the column — "Billed" arriving as
  // "Bil...". Sub-point overflow costs nobody anything; a cut header costs the file.
  if (still > 0.75) {
    // This is the only place a label is allowed to be cut, and it is reached only when
    // every floor has already been taken down to and the type has already stepped as far
    // as it will go: a genuinely over-wide register, which is what the row cap and the
    // 41-column guard send the operator to Excel for.
    const all = totalOf(widths);
    widths = widths.map((w) => Math.max(34, w - (still * w) / all));
  }
  return widths;
}

function clip(text: string, max: number, font: PDFFont, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= max) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > max) {
    cut = cut.slice(0, Math.max(1, cut.length - Math.max(1, Math.ceil(cut.length / 6))));
  }
  return `${cut}...`;
}

export async function buildPdf(table: PreparedTable): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const numeric = table.columns.map((c) => c.type === "money" || c.type === "number");
  let body = 8.5;
  // The totals line is drawn into the same columns, so it takes part in the measuring:
  // a sum is always wider than any row it adds up, and a clipped total is the one
  // figure on the page that somebody signs for.
  const sums: Cell[] = table.columns.map((c, i) => !numeric[i] ? null
    : Number(table.cells.reduce((acc, row) => acc + (typeof row[i] === "number"
      ? (row[i] as number) : 0), 0).toFixed(2)));
  const measure = (size: number) =>
    naturalWidths(table.columns, [...table.cells, sums], regular, bold, size);
  // Landscape is not a preference: a fourteen-column payroll register does not fit
  // portrait at a legible size, and a report nobody can read is worse than one printed
  // sideways.
  let specs = measure(8.5);
  const landscape = specs.reduce((a, s) => a + s.width, 0) > A4.short - 2 * MARGIN;
  const pageW = landscape ? A4.long : A4.short;
  const pageH = landscape ? A4.short : A4.long;
  const avail = pageW - 2 * MARGIN;
  // No column gives way past its own header name, which leaves the type size as the
  // only other lever a wide register has. Step it down until the floors fit: 6.5pt of
  // Helvetica on a printed page is small but whole, and a duty figure that arrives in
  // full is worth more than a large one with its tail on the cutting mat.
  for (const size of [7.5, 6.5, 5.8]) {
    if (specs.reduce((a, s) => a + s.floor, 0) <= avail) break;
    specs = measure(size);
    body = size;
  }
  const col = fit(specs, avail);

  const bottom = MARGIN + 20;
  let page = doc.addPage([pageW, pageH]);

  const drawHeader = () => {
    let line = pageH - MARGIN - 15;
    page.drawText(printable(table.title).slice(0, 92), {
      x: MARGIN, y: line, size: 15, font: bold, color: INK
    });
    line -= 14;
    if (table.subtitle) {
      page.drawText(clip(printable(table.subtitle), avail, regular, 9.5), {
        x: MARGIN, y: line, size: 9.5, font: regular, color: SOFT
      });
      line -= 12;
    }
    const meta = table.meta.map((m) => `${printable(m.label)}: ${printable(m.value)}`).join("    ");
    const stamp = `Generated ${table.generatedAt.toISOString().slice(0, 10)} at ${table.generatedAt
      .toISOString().slice(11, 16)}Z by ${printable(table.actor)}`;
    for (const text of [meta, stamp]) {
      if (!text.trim()) continue;
      page.drawText(clip(text, avail, regular, 8), {
        x: MARGIN, y: line, size: 8, font: regular, color: SOFT
      });
      line -= 10;
    }
    page.drawLine({ start: { x: MARGIN, y: line - 4 }, end: { x: pageW - MARGIN, y: line - 4 },
      thickness: 1, color: BAND });
    return line - HEAD_H - 6;
  };

  const drawHeadRow = (at: number) => {
    page.drawRectangle({ x: MARGIN, y: at - HEAD_H, width: avail, height: HEAD_H, color: BAND });
    let x = MARGIN + GAP;
    table.columns.forEach((c, i) => {
      page.drawText(clip(printable(c.label), col[i] - 2 * GAP, bold, body), {
        x, y: at - HEAD_H + 7, size: body, font: bold, color: rgb(1, 1, 1)
      });
      x += col[i];
    });
    return at - HEAD_H;
  };

  const startPage = () => {
    page = doc.addPage([pageW, pageH]);
    return drawHeadRow(drawHeader());
  };

  let y = drawHeadRow(drawHeader());

  const drawRow = (cells: Cell[], style: "body" | "total") => {
    const font = style === "total" ? bold : regular;
    let x = MARGIN + GAP;
    cells.forEach((cell, i) => {
      const text = printable(asText(cell, table.columns[i].type));
      const shown = clip(text || (style === "body" ? "—" : ""), col[i] - 2 * GAP, font, body);
      page.drawText(shown, {
        x: numeric[i] ? x + col[i] - 2 * GAP - font.widthOfTextAtSize(shown, body) : x,
        y, size: body, font, color: text ? INK : SOFT
      });
      x += col[i];
    });
  };

  table.cells.forEach((row, n) => {
    if (y < bottom) y = startPage();
    if (n % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - 1, width: avail, height: ROW_H - 1,
      color: STRIPE });
    drawRow(row, "body");
    page.drawLine({ start: { x: MARGIN, y: y - 1 }, end: { x: pageW - MARGIN, y: y - 1 },
      thickness: 0.4, color: LINE });
    y -= ROW_H;
  });

  if (numeric.some(Boolean) && table.cells.length) {
    if (y < bottom + ROW_H + 4) y = startPage();
    page.drawLine({ start: { x: MARGIN, y: y + 1 }, end: { x: pageW - MARGIN, y: y + 1 },
      thickness: 1, color: BAND });
    // The label goes where there is room for it. In column zero it lands in a
    // narrow "File no." and the whole line is clipped away before it can be read.
    const labelAt = table.columns.reduce((best, c, i) => {
      if (numeric[i] || c.type === "date" || c.type === "bool") return best;
      return best < 0 || col[i] > col[best] ? i : best;
    }, -1);
    const totals: Cell[] = table.columns.map((c, i) => numeric[i] ? sums[i]
      : i === (labelAt < 0 ? 0 : labelAt) ? `Total - ${table.cells.length} rows` : "");
    drawRow(totals, "total");
    y -= ROW_H;
  }

  const pages = doc.getPageCount();
  doc.getPages().forEach((p, i) => {
    const label = `Page ${i + 1} of ${pages}`;
    p.drawText(label, {
      x: pageW - MARGIN - regular.widthOfTextAtSize(label, 8), y: MARGIN / 2,
      size: 8, font: regular, color: SOFT
    });
  });

  doc.setTitle(printable(table.title));
  doc.setCreator("Waisha");
  doc.setCreationDate(table.generatedAt);
  return Buffer.from(await doc.save());
}
