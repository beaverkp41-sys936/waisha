import { z } from "zod";

/**
 * The shape every export is built from.
 *
 * A report is a title, the filters it was run under, some columns and rows of cells.
 * That is what the operator is already looking at, so it is what the desk sends us: one
 * contract, and every register in the product — payroll, ledger, cargo, compliance, the
 * control desks — gets PDF and Excel without each route growing its own writer.
 *
 * The rows arrive from a browser, so nothing here is trusted. Every value is coerced to
 * a string, a finite number, a boolean or null against the column's declared type;
 * anything else is dropped rather than guessed at, and a cell that does not survive
 * coercion shows as empty. An export can therefore never carry more than the caller
 * could have read on screen, but it can never inject a formula, a control character or
 * a 40 MB payload either.
 */

const MAX_COLUMNS = 40;
const MAX_ROWS = 20_000;
const MAX_CELL = 400;
const MAX_TITLE = 120;

const cellValue = z.union([z.string().max(4_000), z.number(), z.boolean(), z.null()]);

const columnSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  type: z.enum(["text", "money", "number", "date", "bool"]).default("text"),
  /** Preferred width in points for the PDF; the Excel writer derives its own. */
  width: z.number().int().min(40).max(600).optional()
});

export const exportTableSchema = z.object({
  report: z.string().min(2).max(40),
  title: z.string().min(1).max(MAX_TITLE),
  subtitle: z.string().max(160).optional(),
  meta: z.array(z.object({ label: z.string().max(60), value: z.string().max(160) }))
    .max(12).optional(),
  columns: z.array(columnSchema).min(1).max(MAX_COLUMNS),
  rows: z.array(z.record(z.string().max(60), cellValue.nullable())).max(MAX_ROWS)
});

export type ExportColumn = z.infer<typeof columnSchema>;
export type Cell = string | number | boolean | null;

export type PreparedTable = {
  report: string;
  title: string;
  subtitle?: string;
  meta: { label: string; value: string }[];
  columns: ExportColumn[];
  cells: Cell[][];
  generatedAt: Date;
  actor: string;
};

/** Control characters are legal in a JSON string and ruin a printed page. */
function cleanText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_CELL);
}

/**
 * `"1 250,00"`, `"TZS 45,000"`, `""` and `null` all mean the same thing in a money
 * column, and a register that cannot add up is worse than one with a blank in it.
 */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const digits = v.replace(/[^0-9.,\-]/g, "");
  if (!digits) return null;
  // A trailing-comma decimal ("4500,75") is what a European-edited sheet looks like.
  const normalized = /,\d{1,2}$/.test(digits) && digits.includes(".")
    ? digits.replace(/\./g, "").replace(",", ".")
    : digits.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Kept as text on purpose: the writers format dates, but only in the sheet's own cells. */
function toDate(v: unknown): string | null {
  if (typeof v === "number" && v > 0) return new Date(v).toISOString().slice(0, 10);
  if (typeof v !== "string") return null;
  const head = cleanText(v).slice(0, 10);
  if (ISO_DATE.test(head)) return head;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

export function prepareTable(
  input: z.infer<typeof exportTableSchema>,
  actor: string
): PreparedTable {
  const columns = input.columns.map((c) => ({ ...c, label: cleanText(c.label) || c.key }));
  const cells = input.rows.map((row) => columns.map((c) => {
    const raw = row[c.key];
    if (raw === null || raw === undefined) return null;
    switch (c.type) {
      case "money":
      case "number":
        return toNumber(raw);
      case "date":
        return toDate(raw);
      case "bool":
        return typeof raw === "boolean" ? raw : null;
      default:
        return typeof raw === "number" ? String(raw) : cleanText(String(raw));
    }
  }));

  return {
    report: cleanText(input.report),
    title: cleanText(input.title),
    subtitle: input.subtitle ? cleanText(input.subtitle) : undefined,
    meta: (input.meta ?? []).map((m) => ({ label: cleanText(m.label), value: cleanText(m.value) })),
    columns,
    cells,
    generatedAt: new Date(),
    actor
  };
}

export function money(n: number): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(n);
}

export function number(n: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);
}

export function asText(cell: Cell, type: ExportColumn["type"]): string {
  if (cell === null) return "";
  if (typeof cell === "boolean") return cell ? "Yes" : "No";
  if (typeof cell === "number") return type === "money" ? money(cell) : number(cell);
  return cell;
}

/** A download name a browser will accept and a human will still recognise. */
export function fileName(table: PreparedTable, ext: string): string {
  const stem = table.title.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "report";
  return `${stem}-${table.generatedAt.toISOString().slice(0, 10)}.${ext}`;
}
