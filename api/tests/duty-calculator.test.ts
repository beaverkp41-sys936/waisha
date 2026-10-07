import { describe, it, expect } from "vitest";

process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const { calculateDuty } = await import("../src/operations/duty-calculator.js");

const BASE = {
  vatRate: 18,
  railwayLevyRate: 2,
  customsProcessingRate: 0.6,
  importDutyRate: 25,
  excise: null as null | { basis: "duty_paid_value" | "per_unit"; rate: number },
  exciseUnits: undefined as number | undefined
};

describe("calculateDuty", () => {
  it("computes the full stack: CIF, duty, RDL, CPF, VAT and landed cost", () => {
    // FOB 10,000 USD, freight 500, insurance 100, FX 2,500 → CIF = 26.5m TZS
    const out = calculateDuty(
      { fob: 10_000, freight: 500, insurance: 100, exchangeRate: 2_500 },
      BASE
    );
    expect(out.fobTzs).toBe(25_000_000);
    expect(out.cifTzs).toBe(26_500_000);
    expect(out.importDuty).toBe(6_625_000);      // 25% x CIF
    expect(out.railwayLevy).toBe(530_000);       // 2% x CIF
    expect(out.customsProcessingFee).toBe(150_000); // 0.6% x FOB
    expect(out.vat).toBe(5_962_500);             // 18% x CIF + duty
    expect(out.totalLandedCost).toBe(39_767_500);
  });

  it("raw materials band: 0% duty, VAT still applies on CIF", () => {
    const out = calculateDuty(
      { fob: 1_000, freight: 0, insurance: 0, exchangeRate: 2_500 },
      { ...BASE, importDutyRate: 0 }
    );
    expect(out.cifTzs).toBe(2_500_000);
    expect(out.importDuty).toBe(0);
    expect(out.vat).toBe(450_000);               // 18% x CIF (no duty)
    expect(out.totalLandedCost).toBe(3_015_000); // CIF + RDL 50k + CPF 15k + VAT
  });

  it("percent excise rides on the duty-paid value (CIF + duty)", () => {
    const out = calculateDuty(
      { fob: 10_000, freight: 0, insurance: 0, exchangeRate: 2_500 },
      { ...BASE, excise: { basis: "duty_paid_value", rate: 10 } }
    );
    // DPV = 25m + 6.25m duty = 31.25m → excise 3.125m; VAT on 34.375m = 6.1875m
    expect(out.excise).toBe(3_125_000);
    expect(out.vat).toBe(6_187_500);
  });

  it("per-unit excise (fuel levy style) multiplies by units", () => {
    const out = calculateDuty(
      { fob: 0, freight: 0, insurance: 0, exchangeRate: 1 },
      { ...BASE, importDutyRate: 0, excise: { basis: "per_unit", rate: 523 }, exciseUnits: 1_000 }
    );
    expect(out.excise).toBe(523_000);
  });

  it("never produces negative or NaN figures from odd input", () => {
    const out = calculateDuty(
      { fob: -5, freight: -1, insurance: 0, exchangeRate: 0 },
      { ...BASE, excise: { basis: "per_unit", rate: 523 }, exciseUnits: -3 }
    );
    expect(out.cifTzs).toBe(0);
    expect(out.importDuty).toBe(0);
    expect(out.excise).toBe(0);
    expect(out.totalLandedCost).toBe(0);
  });
});
