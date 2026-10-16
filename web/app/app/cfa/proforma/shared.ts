/** Shared pieces of the proforma/quotation generator. Kept out of the page
 * files so the editor and the printed sheet never say different things. */

export const SECTIONS = ["statutory", "port", "transport"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_TITLES: Record<Section, string> = {
  statutory: "EAC Customs Union — Statutory Taxes and Duties",
  port: "Port, Terminal and Clearing Charges",
  transport: "Transport, Delivery and Incidental Charges"
};

export const SECTION_SHORT: Record<Section, string> = {
  statutory: "Statutory taxes and duties",
  port: "Port and clearing",
  transport: "Transport and incidental"
};

export const SECTION_NOTE: Record<Section, string> = {
  statutory: "Import duty on the EAC Common External Tariff band, VAT on imports, excise duty, the railway development levy and the customs processing / import declaration fee.",
  port: "Port clearance and handling, wharfage, verification and scanning fees, and the agency / clearing and forwarding fee.",
  transport: "Freight charges, local transport and cartage, storage and demurrage."
};

export const BASES = ["cif", "fob", "duty_paid_value", "per_unit", "per_container", "per_day", "flat"] as const;
export type Basis = (typeof BASES)[number];

export const BASIS_LABELS: Record<Basis, string> = {
  cif: "on CIF value",
  fob: "on FOB value",
  duty_paid_value: "on duty-paid value",
  per_unit: "per unit",
  per_container: "per container",
  per_day: "per day",
  flat: "flat charge"
};

/** Printed beside the description: the valuation base belongs on the document. */
export const BASIS_PRINT: Record<string, string> = {
  cif: "on CIF",
  fob: "on FOB",
  duty_paid_value: "on duty-paid value",
  per_unit: "per unit",
  per_container: "per container",
  per_day: "per day",
  flat: ""
};

export const TAXES = ["vat", "excise", "none"] as const;
export type TaxKind = (typeof TAXES)[number];

export const TAX_LABELS: Record<TaxKind, string> = {
  vat: "VAT",
  excise: "Excise",
  none: "No tax"
};

export const SOURCE_LABELS: Record<string, string> = {
  in_both: "In both files",
  amount_mismatch: "Files disagree",
  primary_only: "Primary file only",
  secondary_only: "Secondary file only"
};

export const CURRENCIES = [
  { code: "TZS", label: "TZS — Tanzanian Shilling" },
  { code: "USD", label: "USD — US Dollar" },
  { code: "EUR", label: "EUR — Euro" },
  { code: "GBP", label: "GBP — Pound Sterling" },
  { code: "CNY", label: "CNY — Chinese Yuan" },
  { code: "KES", label: "KES — Kenyan Shilling" },
  { code: "other", label: "Other (specify)" }
];

export const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", issued: "Issued", accepted: "Accepted",
  declined: "Declined", converted: "Converted to invoice", cancelled: "Cancelled"
};

export interface CatalogRow {
  id: string;
  code: string;
  label: string;
  section: Section;
  basis: Basis;
  defaultRate: number | null;
  rateType: string | null;
  eacExempt: boolean;
  sort: number;
  notes: string | null;
  tenantOwn: boolean;
}

export interface RefFile {
  id: string;
  role: "primary" | "secondary";
  documentId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  extractStatus: string;
  extraction: any;
  extractNotes: string | null;
}

export interface Check {
  ok: boolean;
  kind: string;
  label: string;
  detail: string;
}

export interface ProposalLine {
  seq: number;
  section: Section;
  catalog_code: string | null;
  description: string;
  basis: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  amount: number;
  tax_kind: TaxKind;
  tax_rate: number;
  tax_amount: number;
  total: number;
  source: string;
  note: string | null;
  primary_raw: string | null;
  secondary_raw: string | null;
}

export interface Proposal {
  lines: ProposalLine[];
  unknown: { role: string; raw: string; description: string | null; amount: number | null }[];
  checks: Check[];
  read: { primary: boolean; secondary: boolean };
}

/** The sheet is edited as strings; numbers are parsed only at the boundary. */
export interface LineDraft {
  key: string;
  section: Section;
  catalogCode: string;
  description: string;
  basis: Basis;
  quantity: string;
  unit: string;
  unitPrice: string;
  taxKind: TaxKind;
  taxRate: string;
  sourceDocumentId: string | null;
  verified: boolean;
  notes: string;
  /** Display-only provenance, so the clerk can see which file a line came from. */
  sourceFile: string | null;
}

let seed = 0;
const uid = () => `ln${++seed}-${Math.random().toString(36).slice(2, 7)}`;

export function newLine(section: Section = "port", patch: Partial<LineDraft> = {}): LineDraft {
  return {
    key: uid(),
    section,
    catalogCode: "",
    description: "",
    basis: "flat",
    quantity: "1",
    unit: "",
    unitPrice: "",
    taxKind: "none",
    taxRate: "0",
    sourceDocumentId: null,
    verified: false,
    notes: "",
    sourceFile: null,
    ...patch
  };
}

export function unitForBasis(basis: Basis): string {
  if (basis === "per_container") return "container";
  if (basis === "per_day") return "day";
  if (basis === "per_unit") return "unit";
  return "";
}

export function fromCatalog(row: CatalogRow): Partial<LineDraft> {
  return {
    catalogCode: row.code,
    description: row.label,
    section: row.section,
    basis: row.basis,
    unit: unitForBasis(row.basis),
    // A flat money rate is a price the office may pre-fill. A percentage is a
    // rule about somebody else's assessment, so it is shown as a note instead
    // of being turned into a figure Waisha cannot prove.
    unitPrice: row.rateType === "amount" && row.defaultRate !== null ? String(row.defaultRate) : "",
    notes: row.rateType === "percent" && row.defaultRate !== null
      ? `Standard rate is ${row.defaultRate}% ${BASIS_LABELS[row.basis] ?? row.basis}. Enter the amount the authority assessed.`
      : row.notes ?? ""
  };
}

export function fromProposal(p: ProposalLine, sourceDocumentId: string | null): LineDraft {
  return newLine(p.section, {
    catalogCode: p.catalog_code ?? "",
    description: p.description,
    basis: (BASES as readonly string[]).includes(p.basis) ? (p.basis as Basis) : "flat",
    quantity: String(p.quantity || 1),
    unit: p.unit ?? "",
    unitPrice: String(p.unit_price),
    taxKind: p.tax_kind,
    taxRate: String(p.tax_rate),
    sourceDocumentId,
    verified: p.source === "in_both",
    notes: p.note ?? ""
  });
}

export const money = (n: number) => Math.round(n * 100) / 100;
export const fmt = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function lineAmount(l: LineDraft) {
  return money((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0));
}
export function lineTax(l: LineDraft) {
  return l.taxKind === "none" ? 0 : money((lineAmount(l) * (Number(l.taxRate) || 0)) / 100);
}
export function lineTotal(l: LineDraft) {
  return money(lineAmount(l) + lineTax(l));
}

export function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}
