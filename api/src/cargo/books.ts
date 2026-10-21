/**
 * The two books an office keeps its cargo files in.
 *
 * The office asked to stop reading inbound clearing work off the same list as outbound
 * movement. 034 already records which of the four movements a file is — `shipment_type`, the
 * same column the file number's prefix is cut from — so this is a reading of that column, not a
 * new one: no migration, and nothing here can disagree with the number printed on the file.
 *
 * One const, imported by the register that filters on it, by the desk that names the books and
 * by the alerts that link into them, so the platform holds the split in exactly one place.
 */
export const CARGO_BOOKS = [
  { key: "clearing", label: "Clearing", types: ["import", "transhipment"] },
  { key: "transport", label: "Transport", types: ["export", "transit"] }
] as const;

export type CargoBookKey = (typeof CARGO_BOOKS)[number]["key"];

export const BOOK_OF_TYPE: Record<string, CargoBookKey> = {};
export const TYPES_OF_BOOK: Record<string, readonly string[]> = {};
for (const book of CARGO_BOOKS) {
  TYPES_OF_BOOK[book.key] = book.types;
  for (const type of book.types) BOOK_OF_TYPE[type] = book.key;
}

/** Which book a type stands in, in the office's own words. Null for a type the desk does not keep. */
export function bookOf(shipmentType: string): { key: CargoBookKey; label: string } | null {
  const key = BOOK_OF_TYPE[shipmentType];
  if (!key) return null;
  return { key, label: CARGO_BOOKS.find(b => b.key === key)!.label };
}

/** The register a file is listed in — an alert that opens the wrong book sends the clerk looking. */
export function bookHref(shipmentType: string): string {
  const book = bookOf(shipmentType);
  return book ? `/app/cfa/cargo?book=${book.key}` : "/app/cfa/cargo";
}
