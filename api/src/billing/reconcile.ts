/**
 * Cross-verify the two uploaded reference files against each other and against
 * the charge catalog, and propose the quotation lines they imply. Matching is
 * by label keyword, so a line that the catalog does not know is reported as
 * unknown instead of being forced into a code. Every figure returned here is a
 * proposal: the clerk edits it inline before the document is saved or printed.
 */
import type { ExtractedLine, ReferenceExtraction } from "./reference.js";

export type CatalogRow = {
  code: string;
  label: string;
  section: "statutory" | "port" | "transport";
  basis: string;
  default_rate: number | null;
  rate_type: string | null;
  eac_exempt: boolean;
  sort: number;
};

export type SuggestedLine = {
  seq: number;
  section: "statutory" | "port" | "transport";
  catalog_code: string | null;
  description: string;
  basis: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  amount: number;
  tax_kind: "vat" | "excise" | "none";
  tax_rate: number;
  tax_amount: number;
  total: number;
  /** in_both | amount_mismatch | primary_only | secondary_only */
  source: string;
  note: string | null;
  primary_raw: string | null;
  secondary_raw: string | null;
};

export type Verification = {
  ok: boolean;
  kind: string;
  label: string;
  detail: string;
};

const money = (n: number) => Math.round(n * 100) / 100;
const SECTION_ORDER = { statutory: 0, port: 1, transport: 2 } as const;

/** Keywords that identify each catalog code on a printed charges invoice. */
const SYNONYMS: Record<string, string[]> = {
  IMPORT_DUTY: ["import duty", "custom duty", "customs duty", "cet duty", "duty on import"],
  EXCISE_DUTY: ["excise"],
  IDL: ["industrial development levy", "idl"],
  RDL: ["railway development", "rdl"],
  VAT_IMPORT: ["vat on import", "import vat", "value added tax", "vat"],
  CPF_IDF: ["customs processing", "processing fee", "import declaration fee", "idf", "cpf"],
  PORT_CLEARANCE: ["port clearance", "terminal handling", "clearance and handling",
    "clearance & handling", "handling charge"],
  WHARFAGE: ["wharfage", "whafage"],
  GREEN_PORT: ["green port"],
  PORT_INFRA_DEV: ["port infrastructure", "infrastructure development"],
  VERIFY_SCAN: ["verification", "scanning", "scan fee"],
  AGENCY_CF: ["agency fee", "agency charge", "agency", "clearing and forwarding",
    "clearing & forwarding", "clearing agency", "forwarding fee", "c/f", "c and f"],
  FREIGHT: ["freight"],
  CARTAGE: ["cartage", "local transport", "delivery charge", "trucking"],
  STORAGE: ["storage"],
  DEMURRAGE: ["demurrage"],
  INCIDENTAL: ["incidental", "sundry", "miscellaneous"]
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function matchCatalog(description: string, catalog: CatalogRow[]): CatalogRow | null {
  const text = norm(description);
  if (!text) return null;
  // Longest keyword first, so "port infrastructure development" cannot be
  // captured by the shorter "handling"-style entries.
  const candidates: { code: string; hit: number }[] = [];
  for (const [code, words] of Object.entries(SYNONYMS)) {
    for (const w of words) {
      const i = text.indexOf(norm(w));
      if (i >= 0) { candidates.push({ code, hit: norm(w).length + (100 - i) }); break; }
    }
  }
  // A charge code the office added itself is only knowable from its label —
  // the platform keyword list can never anticipate a local tariff name.
  for (const row of catalog) {
    const label = norm(row.label);
    if (label.length < 5) continue;
    const i = text.indexOf(label);
    if (i >= 0) candidates.push({ code: row.code, hit: label.length + (100 - i) + 1 });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.hit - a.hit);
  const byCode = new Map(catalog.map((row) => [row.code, row]));
  for (const c of candidates) {
    const row = byCode.get(c.code);
    if (row) return row;
  }
  return null;
}

/** Combine the rows of one file that resolve to the same catalog code. */
function groupByCode(ex: ReferenceExtraction, catalog: CatalogRow[]) {
  const matched = new Map<string, { row: CatalogRow; lines: ExtractedLine[] }>();
  const unknown: ExtractedLine[] = [];
  for (const line of ex.lines) {
    const row = line.description ? matchCatalog(line.description, catalog) : null;
    if (!row) { unknown.push(line); continue; }
    const bucket = matched.get(row.code) ?? { row, lines: [] };
    bucket.lines.push(line);
    matched.set(row.code, bucket);
  }
  return { matched, unknown };
}

const sum = (lines: ExtractedLine[], pick: (l: ExtractedLine) => number | null) =>
  money(lines.reduce((acc, l) => acc + (pick(l) ?? 0), 0));

export type Reconciled = {
  lines: SuggestedLine[];
  unknown: { role: "primary" | "secondary"; raw: string; description: string | null; amount: number | null }[];
  checks: Verification[];
};

/**
 * Build the proposed bill. Primary wins for a figure the two files disagree on
 * (it is the document the clerk designated as the one to bill from), and the
 * disagreement is reported instead of hidden.
 */
export function reconcile(
  primary: ReferenceExtraction | null,
  secondary: ReferenceExtraction | null,
  catalog: CatalogRow[]
): Reconciled {
  const p = primary ? groupByCode(primary, catalog) : null;
  const s = secondary ? groupByCode(secondary, catalog) : null;

  const codes = new Set<string>([...(p?.matched.keys() ?? []), ...(s?.matched.keys() ?? [])]);
  const lines: SuggestedLine[] = [];

  for (const code of codes) {
    const pb = p?.matched.get(code);
    const sb = s?.matched.get(code);
    const row = (pb?.row ?? sb?.row) as CatalogRow;
    const pAmount = pb ? sum(pb.lines, (l) => l.amount) : null;
    const sAmount = sb ? sum(sb.lines, (l) => l.amount) : null;
    const pVat = pb ? sum(pb.lines, (l) => l.vat) : null;
    const sVat = sb ? sum(sb.lines, (l) => l.vat) : null;

    let source: SuggestedLine["source"];
    let note: string | null = null;
    if (pAmount !== null && sAmount !== null) {
      source = Math.abs(pAmount - sAmount) <= 0.02 ? "in_both" : "amount_mismatch";
      if (source === "amount_mismatch") {
        note = `Primary ${pAmount.toLocaleString("en-US")} vs secondary ${sAmount.toLocaleString("en-US")}.`;
      }
    } else {
      source = pAmount !== null ? "primary_only" : "secondary_only";
      note = pAmount !== null ? "Not present in the secondary file."
        : "Not present in the primary file.";
    }

    // The primary figure is what we bill from when both files exist.
    const amount = pAmount ?? sAmount ?? 0;
    const vat = (pAmount !== null ? pVat : sVat) ?? null;
    const qtyLines = (pb?.lines ?? sb?.lines ?? []);
    const quantity = sum(qtyLines, (l) => l.quantity) || 1;
    const unit = qtyLines.find((l) => l.unit)?.unit ?? null;
    const basis = qtyLines.find((l) => l.basis)?.basis?.toLowerCase() ?? row.basis;
    const combined = qtyLines.length > 1
      ? `${qtyLines.length} rows on the source document were combined into this line.`
      : null;
    if (combined) note = note ? `${note} ${combined}` : combined;

    const hasVat = vat !== null && vat > 0;
    const taxRate = hasVat && amount > 0 ? Math.round((vat! / amount) * 10000) / 100 : 0;
    lines.push({
      seq: 0,
      section: row.section,
      catalog_code: row.code,
      description: row.label,
      basis,
      quantity,
      unit,
      unit_price: quantity > 0 ? money(amount / quantity) : money(amount),
      amount,
      tax_kind: hasVat ? "vat" : "none",
      tax_rate: taxRate,
      tax_amount: hasVat ? money(vat!) : 0,
      total: money(amount + (hasVat ? vat! : 0)),
      source,
      note,
      primary_raw: pb ? pb.lines.map((l) => l.raw).join(" / ") : null,
      secondary_raw: sb ? sb.lines.map((l) => l.raw).join(" / ") : null
    });
  }

  lines.sort((a, b) => {
    const sec = SECTION_ORDER[a.section] - SECTION_ORDER[b.section];
    if (sec) return sec;
    const sortBy = (c: CatalogRow) => c.sort;
    const byCode = new Map(catalog.map((row) => [row.code, row]));
    return (sortBy(byCode.get(a.catalog_code!) ?? { sort: 999 } as CatalogRow))
      - (sortBy(byCode.get(b.catalog_code!) ?? { sort: 999 } as CatalogRow));
  });
  lines.forEach((l, i) => { l.seq = i + 1; });

  const unknown = [
    ...(p?.unknown ?? []).map((l) => ({ role: "primary" as const, raw: l.raw, description: l.description, amount: l.amount })),
    ...(s?.unknown ?? []).map((l) => ({ role: "secondary" as const, raw: l.raw, description: l.description, amount: l.amount }))
  ];

  return { lines, unknown, checks: verify(primary, secondary, lines) };
}

/** Arithmetic that must hold before any of this is trusted. */
export function verify(
  primary: ReferenceExtraction | null,
  secondary: ReferenceExtraction | null,
  lines: SuggestedLine[]
): Verification[] {
  const checks: Verification[] = [];
  const TOL = 0.05;

  for (const [role, ex] of [["primary", primary], ["secondary", secondary]] as const) {
    if (!ex) continue;
    const printed = ex.header.printed_total ?? null;
    const net = ex.header.printed_subtotal ?? null;
    const vat = ex.header.printed_vat ?? null;
    if (printed === null) {
      checks.push({ ok: false, kind: `${role}_total_unstated`,
        label: `${role} total`, detail: "The file states no total to check against." });
      continue;
    }
    if (net !== null && vat !== null) {
      const ok = Math.abs(net + vat - printed) <= TOL;
      checks.push({ ok, kind: `${role}_internal_total`,
        label: `${role} arithmetic`,
        detail: `${net.toLocaleString("en-US")} + ${vat.toLocaleString("en-US")} vs printed ${printed.toLocaleString("en-US")}` });
    }
    if (role === "primary" && primary?.lines.length) {
      const fromRows = money(primary.lines.reduce((a, l) => a + (l.amount ?? 0), 0));
      const ok = Math.abs(fromRows - printed) <= TOL;
      checks.push({ ok, kind: "primary_rows_vs_total", label: "rows against the printed total",
        detail: `${fromRows.toLocaleString("en-US")} read from rows vs ${printed.toLocaleString("en-US")} printed (${Math.abs(fromRows - printed).toFixed(2)} apart)` });
    }
  }

  if (primary && secondary) {
    const pt = primary.header.printed_total ?? null;
    const st = secondary.header.printed_total ?? null;
    if (pt !== null && st !== null) {
      const ok = Math.abs(pt - st) <= TOL;
      checks.push({ ok, kind: "files_agree", label: "the two files",
        detail: ok ? "Both files bill the same total."
          : `Primary bills ${pt.toLocaleString("en-US")}, secondary bills ${st.toLocaleString("en-US")}.` });
    }
    const conflicts = lines.filter((l) => l.source === "amount_mismatch").length;
    checks.push({ ok: conflicts === 0, kind: "line_conflicts", label: "line by line",
      detail: conflicts ? `${conflicts} charge(s) differ between the two files.`
        : "Every charge found in both files carries the same amount." });
  }

  if (lines.length) {
    const total = money(lines.reduce((a, l) => a + l.total, 0));
    const printed = primary?.header.printed_total ?? secondary?.header.printed_total ?? null;
    checks.push({
      ok: printed === null ? true : Math.abs(total - printed) <= TOL,
      kind: "proposed_vs_printed", label: "proposed bill",
      detail: printed === null
        ? `Proposed total ${total.toLocaleString("en-US")}; no printed total to compare with.`
        : `Proposed total ${total.toLocaleString("en-US")} vs ${printed.toLocaleString("en-US")} printed.`
    });
  }
  return checks;
}
