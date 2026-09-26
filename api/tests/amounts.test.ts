import { describe, it, expect } from "vitest";

process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const { computeAmounts, detectProvider } = await import("../src/payments/amounts.js");

const plan = { price_monthly: 350000, price_quarterly: 997500, price_annual: 3500000, vat_rate: 0.18 };

describe("computeAmounts", () => {
  it("monthly: subtotal + 18% VAT", () => {
    expect(computeAmounts(plan, "monthly")).toEqual(
      { subtotal: 350000, vatRate: 0.18, vatAmount: 63000, total: 413000 });
  });
  it("annual uses the annual price", () => {
    const a = computeAmounts(plan, "annual");
    expect(a.subtotal).toBe(3500000);
    expect(a.total).toBe(4130000);
  });
  it("detectProvider maps common TZ prefixes", () => {
    expect(detectProvider("+255754000440")).toBe("mpesa");
    expect(detectProvider("+255782000000")).toBe("airtel");
    expect(detectProvider("+255712000000")).toBe("tigopesa");
  });
});