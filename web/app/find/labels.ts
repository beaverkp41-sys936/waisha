/** Shared formatting for the seeker shell. Kept out of the components so the meter,
 *  the search page and the account page all describe the same numbers the same way. */

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB",
    { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** numeric(12,2) arrives as a string from pg. A seeker reads prices, not decimals. */
export function money(v: string | number | null | undefined, currency = "TZS"): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  const symbol = currency === "TZS" ? "TSh" : currency;
  return `${symbol} ${n.toLocaleString("en-TZ", { maximumFractionDigits: n % 1 === 0 ? 0 : 2 })}`;
}

/** Minutes → "23h 41m". The free credit counts down in minutes, so the UI never needs seconds. */
export function hm(totalMinutes: number): string {
  const m = Math.max(0, Math.floor(totalMinutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export const SERVES_LABELS: Record<string, string> = {
  transporter: "Transporter", cfa: "Clearing & forwarding"
};

export const KIND_OPTIONS = [
  { value: "", label: "Transporter or CFA" },
  { value: "transporter", label: "Transporters only" },
  { value: "cfa", label: "Clearing & forwarding only" }
];

export const LICENCE_LABELS: Record<string, string> = {
  valid: "Licence valid", expiring_soon: "Licence expiring soon",
  expired: "Licence expired", not_declared: "Licence not declared"
};

export const LICENCE_COLORS: Record<string, string> = {
  valid: "var(--success)", expiring_soon: "var(--warning)",
  expired: "var(--danger)", not_declared: "var(--ink-soft)"
};

/** The closed list the 061 meter accepts for a recorded payment. Nothing is charged
 *  inside WAISHA — this only names the channel the reference came from. */
export const PAYMENT_METHODS = [
  { value: "mpesa", label: "M-Pesa" },
  { value: "airtel_money", label: "Airtel Money" },
  { value: "tigo_pesa", label: "Tigo Pesa" },
  { value: "halotel_cash", label: "Halotel Cash" },
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "cash", label: "Cash at the office" },
  { value: "other", label: "Something else" }
];

export function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

/** Empty string when the API sent no code — the callers test membership in a Set, and
 *  null would force a narrow on every one of them for no benefit. */
export function errorCode(json: any): string {
  return json?.error?.code ?? "";
}

export function errorDetail(json: any): any {
  const d = json?.error?.details;
  return Array.isArray(d) && d.length ? d[0] : {};
}
