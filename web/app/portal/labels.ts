export const STAGE_LABELS: Record<string, string> = {
  pre_arrival: "Pre-arrival", arrival: "Arrival", customs: "Customs",
  inspection: "Inspection", release: "Release", exit: "Exit"
};
export const STAGE_COLORS: Record<string, string> = {
  pre_arrival: "var(--ink-soft)", arrival: "var(--brand)", customs: "var(--gold)",
  inspection: "var(--warning)", release: "var(--gold-green)", exit: "var(--success)"
};
export const STAGE_ORDER = ["pre_arrival", "arrival", "customs", "inspection", "release", "exit"];
export const TYPE_LABELS: Record<string, string> = {
  export: "Export", import: "Import", transhipment: "Transhipment", transit: "Transit"
};
export const CONTAINER_LABELS: Record<string, string> = {
  "20ft": "20FT", "40ft": "40FT", loose_cargo: "Loose Cargo", car: "Car"
};
export const PAYMENT_COLORS: Record<string, string> = {
  unpaid: "var(--danger)", partial: "var(--gold)", paid: "var(--success)"
};
export const INVOICE_STATUS_COLORS: Record<string, string> = {
  draft: "var(--ink-soft)", sent: "var(--brand)", paid: "var(--success)",
  partial: "var(--gold)", overdue: "var(--danger)", cancelled: "var(--ink-soft)"
};

export const fmt = (n: number) =>
  n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB",
    { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}
