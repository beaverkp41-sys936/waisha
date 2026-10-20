/**
 * Read the printed fields of a clearing document — a liner's advisory, a TIRA/TANSAD
 * declaration, a bill of lading, an agent's invoice — into the fields a WAISHA cargo file
 * is built from.
 *
 * The rules are the ones 052's charges reader runs on, and for the same reason: a value is
 * only claimed when the page itself says it. Every candidate carries the line it came from
 * and that line's number, so a clerk reviewing a draft is looking at the paper's own words
 * beside the field rather than at a paragraph the reader composed. Anything the rules do
 * not place is left out and counted in `missing` — an empty field the clerk fills takes five
 * seconds; a filled one that is wrong takes a phone call to the port.
 *
 * Two shapes are checked rather than trusted. Container numbers are validated against their
 * ISO 6346 check digit, because a mis-read digit on a container is a container that cannot
 * be found; a number whose digit does not agree is still offered, marked. Dates are read
 * day-first, because that is what Tanzanian papers print, and the printed text stays beside
 * the ISO value so an ambiguous one is corrected at a glance. Numbers must carry their unit
 * to be believed at all — `12.500` is either twelve and a half tonnes or twelve thousand
 * five hundred kilos and nothing on the page says which.
 *
 * Nothing money-related is proposed. `processing_cost`, `payment_amount` and
 * `payment_status` are this office's own decisions, not facts printed on somebody else's
 * document, and a charge read off a liner's advisory is a different number from what the
 * office bills the customer.
 */

export type ScanValue = string | number | string[];
export type ScanField = { value: ScanValue; raw: string; line: number; variants: number };

export type ContainerReading = {
  number: string;
  line: number;
  /** False when the printed digits disagree with their ISO 6346 check digit. */
  valid: boolean;
};

export type CargoScan = {
  /** Keyed by the cargo form's own field names, so a draft drops straight into the form. */
  fields: Record<string, ScanField>;
  containers: ContainerReading[];
  printed_reference: string | null;
  /** Fields a file of this shape is expected to carry that the reader could not place. */
  missing: string[];
  notes: string[];
  linesRead: number;
  /** Lines that yielded nothing, kept for the clerk. */
  unparsed: string[];
};

/** What a review is measured against. `missing` is only honest if the list is explicit. */
export const EXPECTED_FIELDS = [
  "shipmentType", "consigneeName", "consignorName", "billNumber", "cargoDescription",
  "hsCode", "containerNumbers", "weightTonnes", "eta", "termsDelivery", "tansadNumber"
] as const;

const MAX_UNPARSED = 120;

/**
 * A tail runs on until the next printed label — never into the next field's value. But a label
 * only counts as one when the page punctuates it as one: `HS Code:` ends the consignee's value,
 * while the words inside `Dar es Salaam Container Terminal` are that company's own name. Cutting
 * on the bare word would file a truncated party, and a truncated name is the one error a clerk
 * is likeliest to sign off, because it still reads like a company.
 */
const LABEL_WORDS = [
  "hs\\s*code", "hsn", "bhtn", "tariff(?:\\s*item)?", "classification", "consignee",
  "consignor", "shipper", "exporter", "importer", "notify(?:\\s*party)?", "vessel", "voyage",
  "b\\s*\\/\\s*l", "bill\\s*of\\s*lading", "container", "seal", "packages?", "gross\\s*weight",
  "net\\s*weight", "weight", "measurement", "cbm", "eta", "etb", "arrival", "discharge",
  "tansad", "tdsid", "dsid", "rcn", "ref(?:erence)?", "office\\s+of", "border", "icd", "depot",
  "terms", "freight", "total", "amount", "page"
];
const LABEL_STOPS = new RegExp(
  `\\b(?:${LABEL_WORDS.join("|")})(?:\\s*(?:no\\.?|number))?\\s*[:=]`, "i");

const cutAtLabel = (v: string) => (v.split(LABEL_STOPS)[0] ?? "").trim();

const clean = (v: string | undefined): string | undefined => {
  // A value cut at the next label keeps the punctuation that separated them; nothing on these
  // papers ends in a comma, and a form that shows "ABC LIMITED," as a name looks like an error.
  const t = v?.replace(/\s+/g, " ").trim().replace(/[,;]+$/, "");
  return t && t.length >= 2 && !/^[\/.-]+$/.test(t) && !/^n\/?a$/i.test(t) ? t : undefined;
};

/**
 * `1,234.5` and `1234.5` mean one number: a comma grouping is thousands, because nothing on
 * these papers uses a comma as the decimal mark. A lone three-digit group after a dot is not
 * answered — `12.500` is twelve and a half or twelve thousand five hundred, and the page does
 * not say which. Except when it says *tonnes*: a tonnage printed to kilo precision is the one
 * figure these documents always carry three decimals for, and no container file weighs twelve
 * thousand tonnes. Kilos keep the refusal, where the same shape really is two numbers.
 */
const toNumber = (token: string, threeDecimalsAreFine = false): number | null => {
  const t = token.trim();
  if (!/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(t)) return null;
  if (!threeDecimalsAreFine && !t.includes(",") && /^\.\d{3}$/.test(t.slice(t.indexOf(".")))) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/**
 * Day-first, because that is what these papers print (12/10/2026 is the 12th of October).
 * A first component above twelve settles the question outright; the printed text is kept
 * beside the value either way.
 */
function parseDate(raw: string | undefined): string | null {
  const t = clean(raw);
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  const a = Number(m[1]), b = Number(m[2]);
  const dayFirst = a > 12 || b <= 12;
  const day = dayFirst ? m[1] : m[2];
  const month = dayFirst ? m[2] : m[1];
  return iso(year, month, day);
}

/** The same date searched for inside a line, when the label and its value are separated. */
const DATE_IN_LINE = /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/;

const iso = (y: string, mo: string, d: string): string | null => {
  const year = Number(y), month = Number(mo), day = Number(d);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/**
 * ISO 6346: an eleven-character mark — four letters, six serial digits, one check digit.
 * Letters take 10..38 with the multiples of eleven left out of the series, the first ten
 * characters are weighted by powers of two from the left, and the eleventh is the remainder
 * modulo eleven — a remainder of ten is written as zero.
 */
const LETTER_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  let v = 10;
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    while (v % 11 === 0) v++;
    map[c] = v++;
  }
  return map;
})();

function containerCheckOk(body: string): boolean {
  if (!/^[A-Z]{4}\d{7}$/.test(body)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = body[i];
    const value = /[A-Z]/.test(c) ? LETTER_VALUES[c] : Number(c);
    sum += value * 2 ** i;
  }
  const check = sum % 11;
  return (check === 10 ? 0 : check) === Number(body[10]);
}

/** The check digit itself, so a fixture and a probe can produce a real mark. */
export function containerCheckDigit(serial10: string): number | null {
  if (!/^[A-Z]{4}\d{6}$/.test(serial10)) return null;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = serial10[i];
    const value = /[A-Z]/.test(c) ? LETTER_VALUES[c] : Number(c);
    sum += value * 2 ** i;
  }
  const check = sum % 11;
  return check === 10 ? 0 : check;
}

/**
 * One labelled field, taken from the first line whose tail casts. A later line carrying the
 * same label with a *different* value is counted in `variants` rather than silently dropped,
 * because two different consignees on one page is something the clerk has to see.
 */
function pick(
  lines: string[],
  label: RegExp,
  cast: (tail: string, line: string) => ScanValue | null
): ScanField | null {
  let hit: ScanField | null = null;
  const seen = new Set<string>();
  lines.forEach((line, i) => {
    const m = line.match(label);
    if (!m) return;
    const tail = line.slice((m.index ?? 0) + m[0].length);
    const value = cast(tail, line);
    if (value === null) return;
    const current = hit;
    const key = JSON.stringify(value);
    if (!current) {
      hit = { value, raw: line.trim().slice(0, 300), line: i + 1, variants: 1 };
      seen.add(key);
    } else if (!seen.has(key)) {
      seen.add(key);
      hit = { ...current, variants: current.variants + 1 };
    }
  });
  return hit;
}

const tailText = (max: number) => (tail: string): ScanValue | null => {
  const t = clean(cutAtLabel(tail));
  return t && t.length <= max ? t : null;
};

/** A code the page writes with slashes or dashes keeps them; a name does not need a quote. */
const codeText = (max: number) => (tail: string): ScanValue | null => {
  const t = clean(cutAtLabel(tail))?.replace(/\s+/g, "");
  return t && /^[A-Za-z0-9][A-Za-z0-9/.#-]{4,}$/.test(t) && t.length <= max ? t : null;
};

const NUMBER_WITH_UNIT = /\s*([0-9][\d,.]*)\s*(tonnes?|tons?|kgs?|cbm|m³|m3|mt|t)?/i;

function pickNumber(
  lines: string[], label: RegExp, unit: "weight" | "volume"
): ScanField | null {
  return pick(lines, label, (tail) => {
    const m = tail.match(NUMBER_WITH_UNIT);
    if (!m) return null;
    const u = (m[2] ?? "").toLowerCase();
    const n = toNumber(m[1] ?? "", unit === "weight" && /^(mt|tonnes?|tons?|t)$/.test(u));
    if (n === null || n <= 0 || n > 1_000_000) return null;
    if (unit === "weight") {
      // Kilos are the shape these papers print and tonnes the shape the file stores, so the
      // conversion is arithmetic the page authorised by naming its unit. A number with no
      // unit is left alone: tonnes and kilos are two and a half orders of magnitude apart.
      if (/^kgs?$/.test(u)) return Math.round((n / 1000) * 1000) / 1000;
      if (/^(mt|tonnes?|tons?|t)$/.test(u)) return n;
      return null;
    }
    return /^(cbm|m³|m3)$/.test(u) ? n : null;
  });
}

/** BHTN prints 8701.21.90 — four digits, then pairs. */
function normaliseHs(raw: string | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 10) return null;
  const head = digits.slice(0, 4);
  const rest = digits.slice(4).match(/.{1,2}/g) ?? [];
  return [head, ...rest.slice(0, 3)].join(".");
}

/** The port, border and one-stop offices this desk can answer for by name. */
const BORDER_POINTS = [
  "dar es salaam", "tunduma", "nakunda", "namayumba", "sirari", "rusumo", "katoma",
  "chorowe", "ragwe", "silvara", "mabuti", "ulemu", "kyela", "tungama", "kamango",
  "kidatu", "korogwe", "isaka", "arusha one stop", "mwanza", "mtwara"
];
const INCOTERMS = ["CIF", "CFR", "EXW", "FCA", "CPT", "CIP", "DAP", "DDP", "FAS", "FOB"];
const MOVEMENT_TYPES = ["import", "export", "transhipment", "transit"];

/**
 * Container numbers, in the order printed and de-duplicated, plus the size the page states.
 * A size needs a marker to be believed — `20` on a line that says `20/10/2026` is a date.
 *
 * A bill-of-lading line is skipped outright: liner numbers are issued in the same
 * four-letters-seven-digits shape as containers (MEDU4471902 is an MSC bill, not a box), so
 * reading them as a stack would give the file a container that no terminal has ever seen.
 */
const BL_LINE = /\b(?:b\s*\/\s*l|bill\s*of\s*lading|waybill|awb)\b/i;

function readContainers(lines: string[]): {
  containers: ContainerReading[];
  size: { value: string; raw: string; line: number } | null;
  loose: { raw: string; line: number } | null;
} {
  const containers: ContainerReading[] = [];
  const seen = new Set<string>();
  let size: { value: string; raw: string; line: number } | null = null;
  let loose: { raw: string; line: number } | null = null;

  lines.forEach((line, i) => {
    if (!BL_LINE.test(line)) {
      for (const m of line.matchAll(/\b([A-Z]{4})\s?(\d{6})\s?(\d)\b/g)) {
        const body = `${m[1]}${m[2]}${m[3]}`;
        if (seen.has(body)) continue;
        seen.add(body);
        containers.push({ number: body, line: i + 1, valid: containerCheckOk(body) });
      }
    }
    if (!size) {
      // The quote that marks feet reaches this line as four different characters: a typist
      // writes ', a PDF text layer often yields the right single quote, and a measuring-prime
      // sheet gives ′. A size needs one of those markers — or the word — to be believed,
      // because `20` on a line that says `20/10/2026` is a date.
      const marker = line.match(/\b(20|40)(?=['′’´`]| ?(?:ft|gp|hc|hq|ot|rf|dv|tp)\b)/i);
      if (marker) size = {
        value: marker[1] === "20" ? "20ft" : "40ft",
        raw: line.trim().slice(0, 300), line: i + 1
      };
    }
    if (!loose && /\b(?:in\s*bulk|loose\s*cargo|break[\s-]*bulk)\b/i.test(line)) {
      loose = { raw: line.trim().slice(0, 300), line: i + 1 };
    }
  });

  // The ISO type code (22G1, 45G1) names the length without saying feet.
  if (!size) {
    for (let i = 0; i < lines.length && !size; i++) {
      const code = lines[i].match(/\b([24])\d[A-Z]\d\b/);
      if (code) size = {
        value: code[1] === "2" ? "20ft" : "40ft",
        raw: lines[i].trim().slice(0, 300), line: i + 1
      };
    }
  }
  return { containers, size, loose };
}

export function scanCargoDocument(lines: string[]): CargoScan {
  const fields: Record<string, ScanField> = {};
  const notes: string[] = [];
  const set = (key: string, hit: ScanField | null) => { if (hit) fields[key] = hit; };
  const text = lines.join("\n");

  set("shipmentType", pick(lines,
    /\b(?:type\s*of\s*(?:declaration|movement|transaction|goods)|declaration\s*type|movement\s*type|procedure\s*type)\b[:\s]*/i,
    (tail) => {
      const t = cutAtLabel(tail).toLowerCase();
      return MOVEMENT_TYPES.find(k => t.startsWith(k)) ?? null;
    }));

  set("consigneeName", pick(lines,
    /\b(?:consignee|importer|consignee\s*\/\s*importer)(?:\s*(?:name|'s\s*name))?\b[:\s]+/i, tailText(160)));
  set("consignorName", pick(lines,
    /\b(?:consignor|shipper|exporter)(?:\s*(?:name|'s\s*name))?\b[:\s]+/i, tailText(160)));
  set("cargoDescription", pick(lines,
    /\b(?:goods\s*(?:described|description)|description\s*of\s*goods|particulars(?:\s+furnished\s*(?:by\s*the\s*(?:shipper|exporter))?)?|commodity|cargo\s*description|shipment\s*contents)\b[:\s]+/i,
    tailText(500)));
  set("hsCode", pick(lines,
    /\b(?:hs\s*code|hsn|bhtn|tariff\s*item|hs\s*classification)\b[:\s]*/i,
    (tail) => normaliseHs(cutAtLabel(tail))));
  set("declarationMode", pick(lines,
    /\b(?:type\s*of\s*procedure|customs\s*regime|mode\s*of\s*transport)\b[:\s]+/i, tailText(60)));

  // A code label is followed by whatever the typist used to separate it — colon, full stop
  // after an abbreviation, or both — and the value itself starts at the first real character.
  set("billNumber", pick(lines,
    /\b(?:b\s*\/\s*l|bill\s*of\s*lading|waybill|awb)(?:\s*(?:no\.?|number))?\b[:.\s]*/i, codeText(60)));
  set("tansadNumber", pick(lines,
    /\b(?:tansad|tdsid|dsid)(?:\s*(?:no\.?|number))?\b[:.\s]*|\bdeclaration\s*(?:no\.?|number)\b[:.\s]*/i,
    codeText(60)));
  set("rcnNumber", pick(lines, /\brcn\b(?:\s*(?:no\.?|number))?[:.\s]+/i, codeText(60)));
  set("referenceNumber", pick(lines,
    /\b(?:our|your|client|file)\s*ref(?:erence)?\b(?:\s*(?:no\.?|number))?[:.\s]+/i, codeText(60)));
  set("shippingLine", pick(lines,
    /\b(?:shipping\s*line|carrier|liner(?:\s*(?:agent|company))?|name\s*of\s*(?:shipping\s*)?line)\b[:\s]+/i,
    tailText(120)));

  const eta = pick(lines,
    /\b(?:eta|etb|expected\s*(?:arrival|berthing)|arrival\s*date|date\s*of\s*arrival)\b[:\s]*/i,
    (tail, line) => parseDate(cutAtLabel(tail)) ?? parseDate(line.match(DATE_IN_LINE)?.[0]));
  set("eta", eta);
  set("dischargeDate", pick(lines,
    /\b(?:discharge\s*date|date\s*(?:of\s*)?discharge|ex\s*vessel)\b[:\s]*/i,
    (tail) => parseDate(cutAtLabel(tail)) ?? parseDate(tail.match(DATE_IN_LINE)?.[0])));
  set("carryInDate", pick(lines,
    /\b(?:carry[\s-]*in\s*(?:date)?|gate[\s-]*in\s*(?:date)?)\b[:\s]*/i,
    (tail) => parseDate(cutAtLabel(tail)) ?? parseDate(tail.match(DATE_IN_LINE)?.[0])));
  set("orderDate", pick(lines,
    /\b(?:order\s*date|date\s*of\s*order|booking\s*date)\b[:\s]*/i,
    (tail) => parseDate(cutAtLabel(tail)) ?? parseDate(tail.match(DATE_IN_LINE)?.[0])));
  set("documentReceiptDate", pick(lines,
    /\b(?:document\s*(?:receipt|received)\s*date|date\s*received)\b[:\s]*/i,
    (tail) => parseDate(cutAtLabel(tail)) ?? parseDate(tail.match(DATE_IN_LINE)?.[0])));

  set("weightTonnes", pickNumber(lines,
    /\b(?:gross\s*weight|total\s*weight|net\s*weight|weight)\b[:\s]*/i, "weight"));
  set("cbm", pickNumber(lines,
    /\b(?:measurement|volume|total\s*cbm|cbm)\b[:\s]*/i, "volume"));

  set("termsDelivery", pick(lines,
    /\b(?:terms\s*(?:of\s*(?:delivery|sale|shipment))?(?::|\s+)|incoterms?\s*[:\s])\s*/i,
    (tail) => {
      const m = tail.match(new RegExp(`^(${INCOTERMS.join("|")})\\b`, "i"));
      return m?.[1]?.toUpperCase() ?? null;
    }));

  set("officeDeclaration", pick(lines,
    /\b(?:office\s+of\s+(?:declaration|clearing|import)|declaring\s+office|declarating\s+office|customs\s+office|entry\s+office)\b[:\s]+/i,
    tailText(120)));
  set("borderPoint", pick(lines,
    /\b(?:border\s*point|point\s*of\s*(?:entry|exit|clearance)|clearing\s*(?:point|office)|port\s*of\s*(?:entry|discharge))\b[:\s]+/i,
    (tail) => {
      const t = cutAtLabel(tail).toLowerCase();
      return BORDER_POINTS.find(b => t.includes(b)) ?? null;
    }));
  set("nominatedIcd", pick(lines,
    /\b(?:nominated\s*icd|icd|container\s*depot|depot)\b[:\s]+/i, tailText(120)));
  set("cabinetPosition", pick(lines,
    /\b(?:cabinet\s*position|bay\s*(?:position|no\.?)|slot\s*(?:position|no\.?))\b[:\s]+/i, tailText(60)));

  const { containers, size, loose } = readContainers(lines);
  if (containers.length) {
    fields.containerNumbers = {
      value: containers.map(c => c.number),
      raw: containers.slice(0, 3).map(c => c.number).join(", ")
        + (containers.length > 3 ? ` (+${containers.length - 3} more)` : ""),
      line: containers[0].line,
      variants: 1
    };
    if (size) fields.containerType = { value: size.value, raw: size.raw, line: size.line, variants: 1 };
    const suspect = containers.filter(c => !c.valid);
    if (suspect.length) {
      notes.push(`${suspect.length} container number(s) do not agree with their own check digit — read them against the paper before saving.`);
    }
    notes.push(`${containers.length} container number(s) found; the count is taken from them.`);
  } else if (loose) {
    fields.containerType = { value: "loose_cargo", raw: loose.raw, line: loose.line, variants: 1 };
    notes.push("The page says loose or bulk cargo, so container count and numbers do not apply.");
  }

  const printed_reference =
    (fields.tansadNumber?.value as string)
    ?? (fields.rcnNumber?.value as string)
    ?? (fields.billNumber?.value as string)
    ?? (fields.referenceNumber?.value as string)
    ?? null;

  if (eta && eta.variants > 1) {
    notes.push(`The page names ${eta.variants} different arrival dates — the first was used.`);
  }
  const consignee = fields.consigneeName;
  if (consignee && consignee.variants > 1) {
    notes.push(`The page names ${consignee.variants} different consignees — confirm which one this file is for.`);
  }
  if (/\b(?:amount\s*(?:due|payable)|total\s*(?:charges|amount))\b/i.test(text)) {
    notes.push("The page carries charges. They belong on an invoice, not on the cargo file, so nothing was taken from them.");
  }
  if (!/\b(?:import|export)\b/i.test(text)) {
    notes.push("The page does not say whether this is an import or an export.");
  }

  const missing = EXPECTED_FIELDS.filter(k => !fields[k]);
  const usedLines = new Set(Object.values(fields).map(f => f.line));
  const unparsed = lines
    .filter((l, i) => !usedLines.has(i + 1) && l.trim().length >= 4)
    .slice(0, MAX_UNPARSED);

  return {
    fields, containers, printed_reference, missing, notes,
    linesRead: lines.length, unparsed
  };
}
