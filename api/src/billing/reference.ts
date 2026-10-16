/**
 * Turn the text lines of a charges invoice (TPA port charges, a liner house
 * demurrage bill, a forwarding agent's proforma) into the fields a quotation is
 * built from. The rules are deliberately conservative: a number is only claimed
 * as amount/VAT/total when the printed arithmetic proves it (amount + VAT =
 * total), and every original line is kept next to what was parsed out of it so a
 * clerk can see what the reader guessed and correct it inline. Nothing here
 * talks to a port or revenue-authority system.
 */
export type ExtractedLine = {
  raw: string;
  description: string | null;
  quantity: number | null;
  unit: string | null;
  basis: string | null;
  amount: number | null;
  vat: number | null;
  total: number | null;
  /** Figures on the row that could not be classified — shown, never dropped. */
  figures: number[];
};

export type ExtractedHeader = {
  document_no?: string;
  document_date?: string;
  vessel?: string;
  voyage?: string;
  bl_number?: string;
  trade_type?: string;
  consignee?: string;
  agent?: string;
  tin?: string;
  currency?: string;
  printed_total?: number;
  printed_vat?: number;
  printed_subtotal?: number;
  exchange_rate?: number;
};

export type ReferenceExtraction = {
  header: ExtractedHeader;
  lines: ExtractedLine[];
  /** What the reader did not manage, kept verbatim for the clerk. */
  unparsed: string[];
  notes: string;
};

const MONEY = /^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$|^\d+(?:\.\d{1,2})?$/;
const UNITS = new Set(["TEU", "FEU", "CONTAINER", "CONTAINERS", "PCS", "PC", "KG", "KGS",
  "MT", "TONNE", "TONNES", "CBM", "DAY", "DAYS", "LOT", "TRIP", "VEHICLE", "ITEM", "DOZEN", "PALLETS"]);
/** Customs valuation labels — they are bases, not billing units. */
const BASIS = new Set(["CIF", "FOB", "CUSTOM_DUTY", "DUTY_PAID_VALUE", "TAIF", "ASV"]);

export const toNumber = (token: string): number | null => {
  if (!MONEY.test(token)) return null;
  const n = Number(token.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/**
 * Read one printed row. Only three figures whose arithmetic agrees
 * (amount + VAT = total) are claimed as such; every other number that could not
 * be classified stays in `figures` and the row keeps its raw text, so nothing
 * the reader failed to understand disappears from the clerk's view.
 */
function parseLine(line: string): ExtractedLine | null {
  const tokens = line.split(/\s+/).filter(Boolean);
  const positions: number[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (toNumber(tokens[i]) === null) break;
    positions.unshift(i);
    if (positions.length >= 6) break;
  }
  if (!positions.length) return null; // no figures at all: prose or a heading

  // Charges on these documents print to two decimals or with a thousands
  // separator, so a bare integer tail ("page 1") is not evidence of a money row
  // unless the row also carries a proved amount/VAT/total.
  const strong = tokens.slice(positions[0]).some((t) => /[.,]\d/.test(t));

  const figures = positions.map((i) => toNumber(tokens[i]) as number);
  const head = tokens.slice(0, positions[0]);
  const out: ExtractedLine = {
    raw: line, description: null, quantity: null, unit: null,
    basis: null, amount: null, vat: null, total: null, figures: []
  };

  if (figures.length >= 3) {
    const [a, v, t] = figures.slice(-3);
    if (Math.abs(a + v - t) <= 0.02) {
      out.amount = a; out.vat = v; out.total = t;
      out.figures = figures.slice(0, -3);
    } else {
      out.amount = figures[figures.length - 1];
      out.figures = figures.slice(0, -1);
    }
  } else {
    out.amount = figures[figures.length - 1];
    out.figures = figures.slice(0, -1);
  }
  if (!strong && out.vat === null) return null;

  // Words in front of the figures: valuation basis, billing unit, name.
  const words = head.slice();
  const upper = words.length ? words[words.length - 1].toUpperCase() : "";
  if (BASIS.has(upper)) { out.basis = upper; words.pop(); }
  else if (UNITS.has(upper)) {
    out.unit = upper;
    words.pop();
    // "Green Port Initiatives 3 TEU …" — the figure in front of a real billing
    // unit is the quantity, never a money amount.
    const q = words.length ? toNumber(words[words.length - 1]) : null;
    if (q !== null && q > 0 && q <= 100000) { out.quantity = q; words.pop(); }
    else if (out.figures.length) {
      const last = out.figures[out.figures.length - 1];
      if (last > 0 && last <= 100000) {
        out.quantity = last;
        out.figures = out.figures.slice(0, -1);
      }
    }
  }
  // A figure left in front of the classified money (a printed rate) stays in
  // `figures` instead of being glued onto the charge name.
  for (;;) {
    const t = words.length ? toNumber(words[words.length - 1]) : null;
    if (t === null) break;
    out.figures.push(t);
    words.pop();
  }
  const description = words.join(" ").replace(/[^\w&/().,%-]+/g, " ").trim();
  out.description = description.length >= 2 ? description : null;
  return out;
}

/**
 * Value tails run on until the next field label printed on the same line. Only
 * labels that are followed by a value are listed — a name that happens to
 * contain "consignee" or "total" must survive intact.
 */
const LABEL_STOPS = /\b(?:invoice\s+date|invoice\s+no|invoice\s+type|prev\.?\s+invoice|trade\s+type|handled|call\s+id|control\s+no|document\s+no|b\s*\/\s*l|voyage|vessel\s+name|agent\s+tin|tin)\b/i;

const grab = (text: string, re: RegExp, cutAtLabel = false): string | undefined => {
  const m = text.match(re);
  let v = m?.[1]?.trim();
  if (v && cutAtLabel) v = (v.split(LABEL_STOPS)[0] ?? "").trim();
  return v && v !== "---" && v !== "N/A" ? v : undefined;
};

const grabMoney = (text: string, re: RegExp): number | undefined => {
  const v = grab(text, re);
  return v ? toNumber(v.replace(/\s+/g, "")) ?? undefined : undefined;
};

/** ISO-ise the date shapes these documents use; leave anything odd alone. */
function normaliseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    // Portal prints are month/day/year; nothing here can be a day-first locale
    // claim, so an impossible month falls back to day-first instead.
    const monthFirst = Number(m[1]) <= 12;
    const month = monthFirst ? m[1] : m[2];
    const day = monthFirst ? m[2] : m[1];
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return undefined;
}

export function parseReference(lines: string[]): ReferenceExtraction {
  const text = lines.join("\n");
  const header: ExtractedHeader = {
    document_no: grab(text, /\b(?:invoice|advisement|document|reference)\s*(?:no\.?|number)[:\s]+([A-Za-z0-9][A-Za-z0-9/._-]{4,})/i),
    document_date: normaliseDate(grab(text, /\b(?:invoice|document|advisement)\s*date[:\s]+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/i)),
    vessel: grab(text, /\bvessel\s*name[:\s]+(.+)/i, true),
    voyage: grab(text, /\bvoyage[:\s]+([A-Za-z0-9-]{3,})/i),
    bl_number: grab(text, /\b(?:b\s*\/\s*l|bill\s*of\s*lading)(?:\s*no\.?)?[:\s]+([A-Za-z0-9]{6,})/i),
    trade_type: grab(text, /\btrade\s*type[:\s]+([A-Za-z_]{4,})/i),
    // The label is often printed alone above its value, so `\s` may cross one
    // line break — but the value itself must stay on one line, never the
    // column headings of the charge table that follow it.
    consignee: grab(text, /\bconsignee\s*(?:name)?[:\s]+(.+)/i, true),
    agent: grab(text, /\bage(?:nt|ncy)\s*name[:\s]+(.+)/i, true),
    tin: grab(text, /\btin[:\s]+(\d{3}-?\d{3}-?\d{3})/i),
    currency: grab(text, /\b(TZS|USD|KES|UGX|EUR|GBP|ZAR)\b/i)?.toUpperCase(),
    // Two decimals are required here: these footers sit right above rows whose
    // quantity ("3 TEU") would otherwise be read as the total.
    printed_total: grabMoney(text, /total\s+billed\s+amount[^\d]*([\d,]+\.\d{2})/i)
      ?? grabMoney(text, /total\s+charges[^\d]*([\d,]+\.\d{2})/i)
      ?? grabMoney(text, /total\s+amount[^\d]*([\d,]+\.\d{2})/i),
    printed_vat: grabMoney(text, /vat\s+amount[^\d]*([\d,]+\.\d{2})/i),
    printed_subtotal: grabMoney(text, /net\s+(?:amount|total)[^\d]*([\d,]+\.\d{2})/i),
    exchange_rate: grabMoney(text, /exchange\s*rate[:\s]*([\d,.]+)/i)
  };

  const parsed: ExtractedLine[] = [];
  const unparsed: string[] = [];
  const skip = /^(?:tanzania ports authority|office of the port director|port charges invoice|scan & pay|service name\b|total (?:charges|billed|amount)\b|vat amount\b|exchange rate\b|\d+\/\d+\/\d+.*\d{1,2}:\d{2}\s*(?:am|pm)|https?:\S+|\d+\/\d+$)/i;

  for (const line of lines) {
    if (skip.test(line)) { unparsed.push(line); continue; }
    const p = parseLine(line);
    // A real charge row carries a name and at least one figure we placed.
    if (p?.description && p.amount !== null) parsed.push(p);
    else unparsed.push(line);
  }

  const notes = parsed.length
    ? `${parsed.length} charge row(s) read from ${lines.length} text line(s).`
    : "No charge rows could be read from the text layer.";

  return { header, lines: parsed, unparsed, notes };
}
