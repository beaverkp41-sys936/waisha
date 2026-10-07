/**
 * Duty computation — the single source of truth for the duty calculator.
 * Pure function: the API runs it per request and the tests pin the math.
 *
 * TRA import stack (Taxes and Duties at a Glance 2025/26):
 *   CIF (TZS)          = (FOB + freight + insurance) x exchange rate
 *   Import duty        = rate x CIF
 *   Excise             = rate x (CIF + import duty)   |  amount x units
 *   Railway dev. levy  = 2% x CIF
 *   Customs proc. fee  = 0.6% x FOB (TZS)
 *   VAT                = 18% x (CIF + import duty + excise)   [duty-paid value]
 *   Total landed cost  = CIF + import duty + excise + levy + fee + VAT
 */

export interface DutyRates {
  vatRate: number;
  railwayLevyRate: number;
  customsProcessingRate: number;
  importDutyRate: number;
  excise: { basis: "duty_paid_value" | "per_unit"; rate: number } | null;
  exciseUnits?: number;
}

export interface DutyBreakdown {
  cifTzs: number;
  fobTzs: number;
  importDuty: number;
  excise: number;
  railwayLevy: number;
  customsProcessingFee: number;
  vat: number;
  totalLandedCost: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function calculateDuty(
  input: { fob: number; freight: number; insurance: number; exchangeRate: number },
  rates: DutyRates
): DutyBreakdown {
  const fobTzs = r2(Math.max(input.fob, 0) * Math.max(input.exchangeRate, 0));
  const cifTzs = r2(fobTzs + Math.max(input.freight, 0) * input.exchangeRate
    + Math.max(input.insurance, 0) * input.exchangeRate);

  const importDuty = r2(cifTzs * (rates.importDutyRate / 100));

  let excise = 0;
  if (rates.excise) {
    excise = rates.excise.basis === "duty_paid_value"
      ? r2((cifTzs + importDuty) * (rates.excise.rate / 100))
      : r2(rates.excise.rate * Math.max(rates.exciseUnits ?? 0, 0));
  }

  const railwayLevy = r2(cifTzs * (rates.railwayLevyRate / 100));
  const customsProcessingFee = r2(fobTzs * (rates.customsProcessingRate / 100));
  const vat = r2((cifTzs + importDuty + excise) * (rates.vatRate / 100));
  const totalLandedCost = r2(cifTzs + importDuty + excise + railwayLevy + customsProcessingFee + vat);

  return { cifTzs, fobTzs, importDuty, excise, railwayLevy, customsProcessingFee, vat, totalLandedCost };
}
