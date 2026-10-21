/**
 * The paper a clearing desk holds that the platform had no word for until 117.
 *
 * The office asked for seven document types on a cargo file — Prevision, Delivery Note, TDRN,
 * invoices, and the warehouse's receipt, entry and exit. Two of those already had a kind
 * (`delivery_note`, `invoice`), so what is genuinely new is the five below, and they belong in
 * one const rather than in whichever route file remembers to type them: three channels accept
 * cargo paper (the vault, the job document register, the PDF scanner), and a kind offered on two
 * of them is a kind a clerk files under one name and cannot find under another.
 *
 * The words the clerk sees live with the pages that print them (`web/components/doc-kinds.ts`);
 * this file is only the vocabulary the server will store.
 */
export const CARGO_PAPER_KINDS = [
  "prevision",          // the office's estimate of what the file will cost, before the bill lands
  "tdrn",               // the desk's own name for the port's release paper — kept unexpanded
  "warehouse_receipt",  // the store acknowledges it holds the cargo
  "warehouse_entry",    // goods in
  "warehouse_exit"      // goods out
] as const;
