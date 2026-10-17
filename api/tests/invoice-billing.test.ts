import { describe, it, expect } from "vitest";

process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const { computeBillingTotals } = await import("../src/routes/invoices.routes.js");

type Line = { description: string; quantity: number; unitPrice: number;
  unit?: string | null; section?: "statutory" | "port" | "transport";
  taxKind?: "vat" | "excise" | "none"; taxRate?: number };

const line = (d: string, quantity: number, unitPrice: number, extra: Partial<Line> = {}): Line =>
  ({ description: d, quantity, unitPrice, ...extra });

describe("computeBillingTotals", () => {
  it("foots a taxed line into charge, tax and line total", () => {
    const t = computeBillingTotals([line("Import duty", 1, 1_000_000, { section: "statutory" }),
      line("VAT on imports", 1, 2_000_000, { section: "statutory", taxKind: "vat", taxRate: 18 })]);
    expect(t.lines[1]).toEqual({ amount: 2_000_000, taxAmount: 360_000, total: 2_360_000, section: "statutory" });
    expect(t.subtotal).toBe(3_000_000);
    expect(t.vatAmount).toBe(360_000);
    expect(t.total).toBe(3_360_000);
  });

  it("carries line tax inside its block so the three blocks sum to the total", () => {
    const t = computeBillingTotals([
      line("IDF", 1, 100_000, { section: "statutory", taxKind: "vat", taxRate: 0.6 }),
      line("Wharfage", 4, 25_000, { section: "port" }),
      line("Cartage", 1, 180_000, { section: "transport" })
    ]);
    expect(t.statutoryTotal).toBe(100_600);
    expect(t.portTotal).toBe(100_000);
    expect(t.transportTotal).toBe(180_000);
    expect(t.statutoryTotal + t.portTotal + t.transportTotal).toBe(t.total);
  });

  it("keeps excise out of the VAT column but inside the total", () => {
    const t = computeBillingTotals([
      line("Clearing agency fee", 1, 500_000, { section: "port", taxKind: "vat", taxRate: 18 }),
      line("Excisable cargo", 1, 200_000, { section: "statutory", taxKind: "excise", taxRate: 10 })
    ]);
    expect(t.vatAmount).toBe(90_000);
    expect(t.total).toBe(590_000 + 220_000);
    expect(t.total - t.subtotal - t.vatAmount).toBe(20_000);
  });

  it("treats an untaxed or unsectioned line as a plain transport charge", () => {
    const t = computeBillingTotals([line("Local cartage", 2, 45_500)]);
    expect(t.lines[0].taxAmount).toBe(0);
    expect(t.transportTotal).toBe(91_000);
    expect(t.statutoryTotal).toBe(0);
    expect(t.total).toBe(91_000);
  });

  it("rounds once, to the stored figure, instead of compounding float noise", () => {
    const t = computeBillingTotals([line("Scanning", 3, 10.005, { taxKind: "vat", taxRate: 18 })]);
    expect(t.lines[0].amount).toBe(30.02);
    expect(t.lines[0].taxAmount).toBe(5.4);
    expect(t.total).toBe(35.42);
  });

  it("returns zeros for an empty sheet rather than NaN", () => {
    const t = computeBillingTotals([]);
    expect([t.subtotal, t.vatAmount, t.total, t.statutoryTotal]).toEqual([0, 0, 0, 0]);
  });
});
