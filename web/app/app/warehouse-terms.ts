/**
 * The warehouse register's own words, in one place.
 *
 * Two desks print a hold — the warehouse page and the panel on a cargo file — and both read the
 * same five figures the server returns. The status is a CHECK that migration 118 owns, and
 * `released` is not a button: it is the register's conclusion that the dockets have taken
 * everything out. A label missing here is not refused by the server, it just prints a raw key.
 */

export const HOLD_STATUS: Record<string, { label: string; color: string; note: string }> = {
  stored: {
    label: "In store", color: "var(--gold)",
    note: "Goods the store is still holding — every day past the free period costs the file."
  },
  released: {
    label: "Released", color: "var(--success)",
    note: "The dockets have taken the whole of what came in. The hold and its tariff are frozen, "
      + "and a new delivery opens a hold of its own."
  },
  cancelled: {
    label: "Called off", color: "var(--ink-soft)",
    note: "Opened in error and never counted into the store, with a name and a reason on it."
  }
};

export const DOCKET_KIND: Record<string, { label: string; short: string; sign: string }> = {
  entry: { label: "Goods in", short: "In", sign: "+" },
  exit: { label: "Goods out", short: "Out", sign: "−" }
};

/** Money is never added across currencies, but a single-currency figure is read with its symbol. */
export const money = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A count of bags, pallets or cartons keeps whatever decimals the docket was written with. */
export const units = (n: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { maximumFractionDigits: 3 });

/** "TZS 12,500.00", or the currency list when one hold's holds span more than one. */
export const sum = (n: number, currencies: string[] | null | undefined) => {
  const list = (currencies ?? []).filter(Boolean);
  if (!list.length) return money(n);
  return list.length === 1 ? `${list[0]} ${money(n)}` : `${money(n)} (${list.join(" / ")})`;
};

/** How long a hold has been sitting, in the words a clerk uses on the phone. */
export function heldFor(days: number, chargeDays: number, freeDays: number): string {
  if (!days) return "no day counted yet";
  const sat = `${days} day${days === 1 ? "" : "s"} in the store`;
  if (!chargeDays) return freeDays ? `${sat} — all inside the ${freeDays}-day free period` : sat;
  return `${sat} · ${chargeDays} chargeable`;
}
