/** Money math for the payment page (spec 5.2): cycle price + VAT line. */
export interface PlanPricing {
  price_monthly: string | number;
  price_quarterly: string | number;
  price_annual: string | number;
  vat_rate: string | number;
}

export type Cycle = "monthly" | "quarterly" | "annual";

export function computeAmounts(plan: PlanPricing, cycle: Cycle) {
  const base = {
    monthly: plan.price_monthly,
    quarterly: plan.price_quarterly,
    annual: plan.price_annual
  }[cycle];
  const subtotal = Math.round(Number(base) * 100) / 100;
  const vatRate = Number(plan.vat_rate);
  const vatAmount = Math.round(subtotal * vatRate * 100) / 100;
  return {
    subtotal, vatRate, vatAmount,
    total: Math.round((subtotal + vatAmount) * 100) / 100
  };
}

/** Provider auto-detection from the number prefix (spec 5.2).
 *  Prefixes are best-effort for TZ - verify the full map against each
 *  network's current ranges at launch; the UI override dropdown remains. */
export function detectProvider(e164: string): "mpesa" | "airtel" | "tigopesa" | "halopesa" | "azampesa" {
  const n = e164.replace(/\D/g, "").replace(/^255/, "0");
  if (/^0(75|76)/.test(n)) return "mpesa";
  if (/^0(78|68)/.test(n)) return "airtel";
  if (/^0(65|67|71)/.test(n)) return "tigopesa";
  if (/^062/.test(n)) return "halopesa";
  return "azampesa";
}