import { describe, it, expect } from "vitest";
import { parseReference, toNumber } from "../src/billing/reference.js";
import { matchCatalog, reconcile } from "../src/billing/reconcile.js";
import type { CatalogRow } from "../src/billing/reconcile.js";

// Line shapes modelled on a Tanzania Ports Authority charges invoice and a
// liner demurrage advice — text layer as it comes out of the page.
const TPA = [
  "TANZANIA PORTS AUTHORITY",
  "Handled TZDAR Invoice No PS202610X00123A",
  "Trade Type DOMESTIC_IMPORT Prev. Invoice No ---",
  "Vessel Name MSC SOME VESSEL Invoice Date 2026-10-09",
  "Agent Name SOME AGENT LIMITED B/L No MEDU123456789",
  "Consignee",
  "Name SOME CONSIGNEE LIMITED Invoice Type CARGO",
  "Service Name Rate Amount VAT Total Amount",
  "Green Port Initiatives 3 TEU 397,302.00 71,514.36 468,816.36",
  "Port Infrastructure Development 22,986.53 0.00 22,986.53",
  "WHAFAGE SERVICES 25,559.45 CIF 1,083,177.69 194,971.98 1,278,149.67",
  "Reefer plug electricity 1 DAYS 45,000.00 8,100.00 53,100.00",
  "Total Charges in TZS 1,503,466.22",
  "VAT Amount in TZS 266,486.34",
  "Total Billed Amount in TZS 1,769,952.56",
  "Exchange Rate: 2,648.68"
];

const CATALOG: CatalogRow[] = [
  { code: "VAT_IMPORT", label: "VAT on imports", section: "statutory", basis: "duty_paid_value",
    default_rate: 18, rate_type: "percent", eac_exempt: false, sort: 50 },
  { code: "IMPORT_DUTY", label: "Import Duty (EAC CET band)", section: "statutory", basis: "cif",
    default_rate: null, rate_type: null, eac_exempt: true, sort: 10 },
  { code: "RDL", label: "Railway Development Levy (RDL)", section: "statutory", basis: "cif",
    default_rate: 2, rate_type: "percent", eac_exempt: false, sort: 40 },
  { code: "GREEN_PORT", label: "Green Port Initiatives", section: "port", basis: "per_container",
    default_rate: null, rate_type: null, eac_exempt: false, sort: 130 },
  { code: "PORT_INFRA_DEV", label: "Port Infrastructure Development", section: "port", basis: "flat",
    default_rate: null, rate_type: null, eac_exempt: false, sort: 140 },
  { code: "WHARFAGE", label: "Wharfage", section: "port", basis: "per_unit",
    default_rate: null, rate_type: null, eac_exempt: false, sort: 120 },
  { code: "DEMURRAGE", label: "Demurrage", section: "transport", basis: "per_day",
    default_rate: null, rate_type: null, eac_exempt: false, sort: 240 },
  { code: "AGENCY_CF", label: "Agency / Clearing & Forwarding Fee", section: "port", basis: "flat",
    default_rate: null, rate_type: null, eac_exempt: false, sort: 160 }
];

describe("reference reader", () => {
  it("reads a thousands-separated money token and rejects prose", () => {
    expect(toNumber("1,083,177.69")).toBe(1083177.69);
    expect(toNumber("25559.45")).toBe(25559.45);
    expect(toNumber("1/1")).toBeNull();
    expect(toNumber("TZDAR")).toBeNull();
  });

  it("pulls the header fields a bill is filed under", () => {
    const ex = parseReference(TPA);
    expect(ex.header.document_no).toBe("PS202610X00123A");
    expect(ex.header.document_date).toBe("2026-10-09");
    expect(ex.header.vessel).toBe("MSC SOME VESSEL");
    expect(ex.header.trade_type).toBe("DOMESTIC_IMPORT");
    expect(ex.header.bl_number).toBe("MEDU123456789");
    expect(ex.header.consignee).toBe("SOME CONSIGNEE LIMITED");
    expect(ex.header.currency).toBe("TZS");
    expect(ex.header.printed_total).toBe(1769952.56);
    expect(ex.header.exchange_rate).toBe(2648.68);
    expect(ex.header.agent).toBe("SOME AGENT LIMITED");
  });

  it("reads a colon layout without swallowing the charge table headings", () => {
    const ex = parseReference([
      "TANZANIA PORTS AUTHORITY",
      "PORT CHARGES INVOICE",
      "INVOICE NO: TPA/2026/00442",
      "DOCUMENT DATE: 25/10/2026",
      "VESSEL NAME: MSC SOME VESSEL",
      "CONSIGNEE: SMOKE BILLING CONSIGNEE LIMITED",
      "Service name  Basis  Quantity  Unit  Amount  VAT  Total",
      "WHARFAGE SERVICES CIF 1 CONTAINER 120,000.00 21,600.00 141,600.00",
      "TOTAL BILLED AMOUNT 120,000.00"
    ]);
    expect(ex.header.document_no).toBe("TPA/2026/00442");
    expect(ex.header.document_date).toBe("2026-10-25");
    expect(ex.header.consignee).toBe("SMOKE BILLING CONSIGNEE LIMITED");
    expect(ex.header.printed_total).toBe(120000);
    expect(ex.lines).toHaveLength(1);
  });

  it("keeps amount, VAT and total when the printed arithmetic agrees", () => {
    const ex = parseReference(TPA);
    const green = ex.lines.find((l) => l.description === "Green Port Initiatives");
    expect(green).toMatchObject({ quantity: 3, unit: "TEU", amount: 397302, vat: 71514.36, total: 468816.36 });
  });

  it("records a valuation basis instead of mistaking it for a billing unit", () => {
    const ex = parseReference(TPA);
    const wharf = ex.lines.find((l) => l.description === "WHAFAGE SERVICES");
    expect(wharf).toMatchObject({ basis: "CIF", amount: 1083177.69, vat: 194971.98, total: 1278149.67 });
    // The unclassifiable rate figure stays visible rather than becoming a quantity.
    expect(wharf!.figures).toContain(25559.45);
  });

  it("does not invent rows for headings and totals", () => {
    const ex = parseReference(TPA);
    const descriptions = ex.lines.map((l) => l.description);
    expect(descriptions).not.toContain(null);
    expect(descriptions.some((d) => /total|service name/i.test(d ?? ""))).toBe(false);
    expect(ex.unparsed.join(" ")).toContain("Total Billed Amount");
  });

  it("reports a file with no readable rows as needing manual entry", () => {
    const ex = parseReference(["Scanned attachment page 1", "no figures here"]);
    expect(ex.lines).toEqual([]);
    expect(ex.notes).toMatch(/No charge rows/);
  });
});

describe("catalog matching", () => {
  it("matches printed service names to catalog codes, misspelling included", () => {
    expect(matchCatalog("WHAFAGE SERVICES", CATALOG)?.code).toBe("WHARFAGE");
    expect(matchCatalog("Wharfage on cargo", CATALOG)?.code).toBe("WHARFAGE");
    expect(matchCatalog("Green Port Initiatives", CATALOG)?.code).toBe("GREEN_PORT");
    expect(matchCatalog("Port Infrastructure Development", CATALOG)?.code).toBe("PORT_INFRA_DEV");
    expect(matchCatalog("Railway Development Levy", CATALOG)?.code).toBe("RDL");
    expect(matchCatalog("Import Duty", CATALOG)?.code).toBe("IMPORT_DUTY");
    expect(matchCatalog("Agency fee — clearing and forwarding", CATALOG)?.code).toBe("AGENCY_CF");
    expect(matchCatalog("AGENCY C AND F FEE", CATALOG)?.code).toBe("AGENCY_CF");
  });

  it("recognises a charge code the office named itself", () => {
    const withLocal: CatalogRow[] = [...CATALOG,
      { code: "REEFER_PLUG", label: "Reefer plug electricity", section: "port", basis: "per_day",
        default_rate: 45000, rate_type: "amount", eac_exempt: false, sort: 170 }];
    expect(matchCatalog("REEFER PLUG ELECTRICITY 1 DAYS", withLocal)?.code).toBe("REEFER_PLUG");
    expect(matchCatalog("OXYGEN FUEL LEVY", withLocal)).toBeNull();
  });

  it("returns null for a charge the catalog does not know", () => {
    expect(matchCatalog("Reefer plug electricity", CATALOG)).toBeNull();
    expect(matchCatalog("", CATALOG)).toBeNull();
  });
});

describe("reconciliation", () => {
  const primary = parseReference(TPA);

  it("proposes lines in the three printed blocks, statutory first", () => {
    const r = reconcile(primary, null, CATALOG);
    expect(r.lines.length).toBeGreaterThan(0);
    const sections = r.lines.map((l) => l.section);
    expect(sections).toEqual([...sections].sort((a, b) =>
      ["statutory", "port", "transport"].indexOf(a) - ["statutory", "port", "transport"].indexOf(b)));
    expect(r.lines.every((l) => l.section === "port")).toBe(true);
    expect(r.lines.map((l) => l.seq)).toEqual([1, 2, 3]);
  });

  it("keeps quantity x unit price equal to the amount read from the file", () => {
    const r = reconcile(primary, null, CATALOG);
    for (const l of r.lines) {
      expect(Math.round(l.quantity * l.unit_price * 100) / 100).toBe(l.amount);
      expect(l.total).toBe(Math.round((l.amount + l.tax_amount) * 100) / 100);
    }
  });

  it("derives the VAT percentage a line was billed at", () => {
    const r = reconcile(primary, null, CATALOG);
    const green = r.lines.find((l) => l.catalog_code === "GREEN_PORT");
    expect(green?.tax_kind).toBe("vat");
    expect(green?.tax_rate).toBeCloseTo(18, 1);
    const infra = r.lines.find((l) => l.catalog_code === "PORT_INFRA_DEV");
    expect(infra?.tax_kind).toBe("none");
  });

  it("flags the charge that differs between the two files and bills from the primary", () => {
    const secondary = parseReference([
      ...TPA.slice(0, 8),
      "Green Port Initiatives 3 TEU 300,000.00 54,000.00 354,000.00",
      "Demurrage 5 DAYS 250,000.00 45,000.00 295,000.00",
      "Total Billed Amount in TZS 649,000.00"
    ]);
    const r = reconcile(primary, secondary, CATALOG);
    const green = r.lines.find((l) => l.catalog_code === "GREEN_PORT");
    expect(green?.source).toBe("amount_mismatch");
    expect(green?.amount).toBe(397302);
    expect(green?.note).toMatch(/vs secondary/);
    const dem = r.lines.find((l) => l.catalog_code === "DEMURRAGE");
    expect(dem?.source).toBe("secondary_only");
    expect(dem?.unit).toBe("DAYS");
    expect(r.checks.find((c) => c.kind === "line_conflicts")?.ok).toBe(false);
  });

  it("reports which lines the catalog could not place", () => {
    const r = reconcile(primary, null, CATALOG);
    const reefer = r.unknown.find((u) => u.description === "Reefer plug electricity");
    expect(reefer).toBeTruthy();
    expect(reefer?.amount).toBe(45000);
    // Header rows are kept out of the charge list, not invented into it.
    expect(r.unknown.some((u) => /Total Billed Amount/i.test(u.raw))).toBe(false);
  });

  it("checks its own proposal against the printed total", () => {
    const r = reconcile(primary, null, CATALOG);
    const proposal = r.checks.find((c) => c.kind === "proposed_vs_printed");
    expect(proposal).toBeTruthy();
    // 1,769,952.56 printed vs the three rows read — deliberately not equal here.
    expect(typeof proposal!.ok).toBe("boolean");
    expect(proposal!.detail).toMatch(/Proposed total/);
  });

  it("reconciles the rows with the printed total when the rows carry their own VAT", () => {
    // A printed total is gross. Comparing only the net column of the rows to it
    // would fail every correctly-read advisement, as the real TPA invoice shown
    // in the office does.
    const gross = parseReference([
      ...TPA.slice(0, 8),
      "Green Port Initiatives 3 TEU 397,302.00 71,514.36 468,816.36",
      "Port Infrastructure Development 22,986.53 0.00 22,986.53",
      "WHAFAGE SERVICES 25,559.45 CIF 1,083,177.69 194,971.98 1,278,149.67",
      "Total Billed Amount in TZS 1,769,952.56"
    ]);
    expect(397302 + 22986.53 + 1083177.69 + 71514.36 + 194971.98).toBeCloseTo(1769952.56, 2);
    const c = reconcile(gross, null, CATALOG).checks.find(k => k.kind === "primary_rows_vs_total");
    expect(c?.ok).toBe(true);
    expect(c?.detail).toMatch(/\+ 266,486\.34 read on the rows/);
  });

  it("still reports rows that genuinely miss the printed total", () => {
    // The shipped fixture bills a reefer row its printed total never counts.
    const c = reconcile(primary, null, CATALOG).checks.find(k => k.kind === "primary_rows_vs_total");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toMatch(/53,100\.00 apart/);
  });

  it("counts a charge only the secondary bills on top of the primary total", () => {
    const onlyPrimary = parseReference([
      ...TPA.slice(0, 8),
      "Green Port Initiatives 3 TEU 397,302.00 71,514.36 468,816.36",
      "Total Billed Amount in TZS 468,816.36"
    ]);
    const second = parseReference([
      ...TPA.slice(0, 8),
      "Demurrage 5 DAYS 250,000.00 45,000.00 295,000.00",
      "Total Billed Amount in TZS 295,000.00"
    ]);
    const r = reconcile(onlyPrimary, second, CATALOG);
    expect(r.lines.map(l => l.source)).toEqual(["primary_only", "secondary_only"]);
    const c = r.checks.find(k => k.kind === "proposed_vs_printed");
    expect(c?.ok).toBe(true);
    expect(c?.detail).toMatch(/plus 295,000\.00 the secondary file bills on top/);
  });
});
