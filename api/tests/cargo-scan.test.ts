import { describe, it, expect } from "vitest";
import { scanCargoDocument, containerCheckDigit, EXPECTED_FIELDS } from "../src/cargo/scan.js";

// Line shapes modelled on what the clearing desk actually receives: a shipping line's
// arrival advice, a TIRA/TANSAD declaration, an agent's invoice. Text layer as it comes out
// of the page — labels and values on one line, tables that run on, dates day-first.
const ARRIVAL_ADVICE = [
  "MSC ARINA / V.412W",
  "ARRIVAL ADVICE - DAR ES SALAAM",
  "Bill of Lading No: MEDU4471902",
  "Consignee: KILOMBA HOLIDAYS LIMITED, P O BOX 1234, DAR ES SALAAM",
  "Shipper: HANNOVER HOLZ GmbH",
  "Goods Description: 2 X 20FT CONTAINERS DRY SALMON WOOD PACKAGED IN PALLETS",
  "HS Code 44039900",
  "Gross Weight: 18,420 KGS",
  "Measurement: 28.5 CBM",
  "Container No: MSCU1234566 TCLU7891024",
  "Container Size/Type: 20'GP",
  "Terms of Delivery: CIF",
  "ETA: 12/10/2026",
  "Discharge Date: 14/10/2026",
  "Total Charges in TZS 4,503,466.22"
];

const DECLARATION = [
  "UNITED REPUBLIC OF TANZANIA",
  "CUSTOMS DECLARATION (ENTRY FOR HOME USE C10)",
  "TANSAD No: 380999-2026-004521",
  "Office of Declaration: DAR ES SALAAM PORT OFFICE",
  "Border Point: DAR ES SALAAM PORT",
  "Type of Declaration: IMPORT",
  "Importer: MWANZA STEEL LIMITED",
  "Exporter: TOSHIBA CORPORATION JAPAN",
  "B/L No: TCLU7891024",
  "Nominated ICD: TCT TERMINAL",
  "RCN No: 2026RCN000145",
  "Gross Weight 12.5 Tonnes",
  "Packages: 400 CARTONS"
];

const f = (scan: ReturnType<typeof scanCargoDocument>, key: string) => scan.fields[key];

describe("cargo document reader", () => {
  it("reads the parties off an arrival advice without running past the next label", () => {
    const s = scanCargoDocument(ARRIVAL_ADVICE);
    // The consignee tail must stop at the address rather than swallowing the whole line?
    // It cannot: the address is part of the printed consignee value, so what is asserted
    // here is that no *other field's label* leaked into it.
    expect(String(f(s, "consigneeName").value)).toContain("KILOMBA HOLIDAYS LIMITED");
    expect(String(f(s, "consigneeName").value)).not.toMatch(/shipper|goods|hs code/i);
    expect(f(s, "consignorName").value).toBe("HANNOVER HOLZ GmbH");
    expect(f(s, "billNumber").value).toBe("MEDU4471902");
    expect(f(s, "cargoDescription").value).toContain("DRY SALMON WOOD");
  });

  it("keeps the line each value was read from", () => {
    const s = scanCargoDocument(ARRIVAL_ADVICE);
    expect(f(s, "billNumber").line).toBe(3);
    expect(f(s, "billNumber").raw).toContain("MEDU4471902");
    expect(f(s, "eta").line).toBe(13);
  });

  it("converts a stated unit rather than assuming one", () => {
    const s = scanCargoDocument(ARRIVAL_ADVICE);
    expect(f(s, "weightTonnes").value).toBeCloseTo(18.42, 3);
    expect(f(s, "cbm").value).toBe(28.5);
  });

  it("refuses a weight whose unit the page did not state", () => {
    const s = scanCargoDocument(["Gross Weight: 18420"]);
    expect(f(s, "weightTonnes")).toBeUndefined();
    expect(s.missing).toContain("weightTonnes");
  });

  it("refuses a figure whose decimal mark the page makes ambiguous", () => {
    const s = scanCargoDocument(["Gross Weight: 12.500 KGS"]);
    expect(f(s, "weightTonnes")).toBeUndefined();
  });

  // Tonnage is the one figure these papers always print to kilo precision, and the unit they
  // state is what settles it: 24.750 tonnes is a weight, 24750 tonnes is a cargo ship.
  it("believes a tonnage stated in tonnes to three decimals", () => {
    const s = scanCargoDocument(["Gross Weight: 24.750 tonnes"]);
    expect(f(s, "weightTonnes").value).toBe(24.75);
    expect(f(s, "weightTonnes").raw).toContain("24.750");
  });

  it("reads a size marked with the quote a PDF text layer really prints", () => {
    // The straight apostrophe a typist types arrives as ’ (U+2019) through the text layer.
    const box = "Container No: MSCU1234566";
    expect(f(scanCargoDocument([box, "Container Type: 40\u2019 HC"]), "containerType").value).toBe("40ft");
    expect(f(scanCargoDocument([box, "Container Size/Type: 20'GP"]), "containerType").value).toBe("20ft");
    expect(f(scanCargoDocument([box, "Size: 40 HC"]), "containerType").value).toBe("40ft");
    // A date is not a size: the marker has to be there.
    expect(f(scanCargoDocument([box, "Discharge 20/10/2026"]), "containerType")).toBeUndefined();
  });

  it("does not cut a company name at a word that happens to be another field's label", () => {
    const s = scanCargoDocument([
      "Consignee: DAR ES SALAAM CONTAINER TERMINAL LIMITED",
      "RCN No: RCN-2026-004521"
    ]);
    expect(f(s, "consigneeName").value).toBe("DAR ES SALAAM CONTAINER TERMINAL LIMITED");
    expect(f(s, "rcnNumber").value).toBe("RCN-2026-004521");
  });

  it("still stops a value at the next label the page punctuates as one", () => {
    const s = scanCargoDocument(["Consignee: ABC TRADERS LIMITED, HS Code: 8701.21.90"]);
    expect(f(s, "consigneeName").value).toBe("ABC TRADERS LIMITED");
    expect(f(s, "hsCode").value).toBe("8701.21.90");
  });

  it("normalises a BHTN code to the dotted shape the file stores", () => {
    const s = scanCargoDocument(ARRIVAL_ADVICE);
    expect(f(s, "hsCode").value).toBe("4403.99.00");
  });

  it("validates container numbers against their own check digit", () => {
    const s = scanCargoDocument(ARRIVAL_ADVICE);
    expect(f(s, "containerNumbers").value).toEqual(["MSCU1234566", "TCLU7891024"]);
    expect(s.containers.every(c => c.valid)).toBe(true);
    expect(f(s, "containerType").value).toBe("20ft");
  });

  it("still offers a number whose check digit does not agree, and marks it", () => {
    const s = scanCargoDocument([
      "Container No: MSCU1234567",
      "Arrival Advice"
    ]);
    expect(f(s, "containerNumbers").value).toEqual(["MSCU1234567"]);
    expect(s.containers[0].valid).toBe(false);
    expect(s.notes.join(" ")).toMatch(/check digit/);
  });

  // The standard's own worked example, so the check-digit rule is pinned to a fact outside
  // this file rather than to whatever the implementation happens to compute.
  it("reproduces the ISO 6346 worked example", () => {
    expect(containerCheckDigit("CSQU305438")).toBe(3);
    expect(scanCargoDocument(["Container No: CSQU3054383"]).containers[0].valid).toBe(true);
  });

  it("reads a customs reference printed either as TANSAD or as Declaration", () => {
    const d = scanCargoDocument(["Declaration No.: 380999-2026-004521"]);
    expect(d.fields.tansadNumber?.value).toBe("380999-2026-004521");
    // A bare "Type of Declaration: IMPORT" is a movement type, not a number.
    expect(f(scanCargoDocument(DECLARATION), "tansadNumber").value).toBe("380999-2026-004521");
    const only = scanCargoDocument(["Type of Declaration: IMPORT"]);
    expect(only.fields.tansadNumber).toBeUndefined();
  });

  it("does not read a date as a container size", () => {
    const s = scanCargoDocument(["Discharge 20/10/2026", "Weight 5 Tonnes"]);
    expect(f(s, "containerType")).toBeUndefined();
  });

  it("reads day-first dates and keeps the printed text beside them", () => {
    const s = scanCargoDocument(ARRIVAL_ADVICE);
    expect(f(s, "eta").value).toBe("2026-10-12");
    expect(f(s, "eta").raw).toContain("12/10/2026");
    expect(f(s, "dischargeDate").value).toBe("2026-10-14");
  });

  it("settles an unambiguous date whichever way the page wrote it", () => {
    const s = scanCargoDocument(["ETA: 25/12/26"]);
    expect(f(s, "eta").value).toBe("2026-12-25");
  });

  it("takes incoterms only where the page labels them", () => {
    expect(f(scanCargoDocument(ARRIVAL_ADVICE), "termsDelivery").value).toBe("CIF");
    // A stray FOB in a freight clause is not the file's terms of delivery.
    const s = scanCargoDocument(["Freight payable at FOB London"]);
    expect(f(s, "termsDelivery")).toBeUndefined();
  });

  it("counts a container stack from the numbers it found", () => {
    const s = scanCargoDocument(ARRIVAL_ADVICE);
    expect(s.notes.join(" ")).toMatch(/2 container number\(s\) found/);
  });

  it("files loose cargo without inventing containers", () => {
    const s = scanCargoDocument(["Cargo: CEMENT IN BULK", "Net Weight 30 TONNES"]);
    expect(f(s, "containerType").value).toBe("loose_cargo");
    expect(f(s, "containerNumbers")).toBeUndefined();
    expect(f(s, "weightTonnes").value).toBe(30);
  });

  it("proposes nothing about money, and says so when the page is full of it", () => {
    const s = scanCargoDocument(ARRIVAL_ADVICE);
    expect(f(s, "paymentAmount")).toBeUndefined();
    expect(f(s, "processingCost")).toBeUndefined();
    expect(f(s, "paymentStatus")).toBeUndefined();
    expect(s.notes.join(" ")).toMatch(/belong on an invoice/);
  });

  it("prefers the customs number as the reference the desk searches on", () => {
    const s = scanCargoDocument(DECLARATION);
    expect(s.printed_reference).toBe("380999-2026-004521");
    expect(f(s, "shipmentType").value).toBe("import");
    expect(f(s, "consigneeName").value).toBe("MWANZA STEEL LIMITED");
    expect(f(s, "consignorName").value).toBe("TOSHIBA CORPORATION JAPAN");
    expect(f(s, "officeDeclaration").value).toBe("DAR ES SALAAM PORT OFFICE");
    expect(f(s, "borderPoint").value).toBe("dar es salaam");
    expect(f(s, "nominatedIcd").value).toBe("TCT TERMINAL");
    expect(f(s, "rcnNumber").value).toBe("2026RCN000145");
    expect(f(s, "weightTonnes").value).toBe(12.5);
  });

  it("does not let a packages line answer for the container count", () => {
    const s = scanCargoDocument(DECLARATION);
    expect(f(s, "containerNumbers")).toBeUndefined();
  });

  it("reports a page that names two different consignees instead of choosing one", () => {
    const s = scanCargoDocument([
      "Consignee: ALPHA STEEL LIMITED",
      "Consignee: BETA TIMBERS LIMITED"
    ]);
    expect(f(s, "consigneeName").variants).toBe(2);
    expect(s.notes.join(" ")).toMatch(/2 different consignees/);
  });

  it("keeps the lines it could not place rather than dropping them", () => {
    const s = scanCargoDocument(ARRIVAL_ADVICE);
    expect(s.unparsed.join("\n")).toContain("MSC ARINA / V.412W");
    expect(s.unparsed.join("\n")).toContain("Total Charges in TZS 4,503,466.22");
    expect(s.linesRead).toBe(ARRIVAL_ADVICE.length);
  });

  it("answers an empty page with nothing but the fields the clerk must type", () => {
    const s = scanCargoDocument([]);
    expect(Object.keys(s.fields)).toEqual([]);
    expect(s.printed_reference).toBeNull();
    expect(s.missing).toEqual([...EXPECTED_FIELDS]);
  });

  it("never proposes a container count the numbers do not support", () => {
    const s = scanCargoDocument(["Containers: 5", "Container No: MSCU1234566"]);
    expect(f(s, "containerNumbers").value).toEqual(["MSCU1234566"]);
  });

  it("says plainly when a page does not say which way the goods are moving", () => {
    const s = scanCargoDocument(ARRIVAL_ADVICE);
    // "ARRIVAL ADVICE" is not a declaration type, so the field stays open — but the clerk
    // is told, rather than left with a silently-defaulted import.
    expect(f(s, "shipmentType")).toBeUndefined();
    const d = scanCargoDocument(DECLARATION);
    expect(d.notes.join(" ")).not.toMatch(/does not say whether/);
  });
});
