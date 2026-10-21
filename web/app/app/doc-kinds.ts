/**
 * What each kind of paper is called, in one place.
 *
 * Four desks print a document's kind — the vault, a cargo file, a job's paper trail and the PDF
 * scanner — and each used to carry its own short list of names. The gaps showed as raw keys on
 * screen (`warehouse_entry` where a clerk expected "Warehouse entry"), which is what happens when
 * a kind is added to the column and only some of the pages hear about it.
 *
 * `documents.kind` is a CHECK the database owns (034 through 117); this is its reading, and the
 * two must agree. A kind missing here is not refused by the server — it just prints ugly.
 *
 * The order of `CARGO_PAPER_KINDS` is the order a clerk reads the desk: what the goods were
 * bought for, what the office reckoned they would cost, what moved them, what the store signed.
 * The seven names are the ones the office asked to file on a cargo file (#189); `prevision`,
 * `tdrn` and the three warehouse slips are new kinds, while `invoice` and `delivery_note` are
 * papers the platform already stored under these same words.
 */
export const CARGO_PAPER_KINDS: { kind: string; label: string }[] = [
  { kind: "invoice", label: "Invoice" },
  { kind: "prevision", label: "Prevision" },
  { kind: "bill_of_lading", label: "Bill of Lading" },
  { kind: "packing_list", label: "Packing list" },
  { kind: "tdrn", label: "TDRN" },
  { kind: "delivery_note", label: "Delivery note" },
  { kind: "warehouse_receipt", label: "Warehouse receipt" },
  { kind: "warehouse_entry", label: "Warehouse entry" },
  { kind: "warehouse_exit", label: "Warehouse exit" },
  { kind: "other", label: "Other" }
];

/** Every value the column can hold, as the desk names it. */
export const DOC_KIND_LABELS: Record<string, string> = {
  logo: "Logo", avatar: "Photo", licence: "Licence", insurance: "Insurance",
  inspection: "Inspection report", road_licence: "Road licence",
  delivery_note: "Delivery note", invoice: "Invoice", bill_of_lading: "Bill of Lading",
  packing_list: "Packing list", contract: "Contract", other: "Other", attachment: "Attachment",
  receipt: "Receipt", shipper_upload: "Shipper upload", proforma: "Proforma",
  arrival_notice: "Arrival notice", delivery_order: "Delivery order",
  declaration: "Customs declaration", assessment: "Customs assessment",
  release_note: "Release note", permit: "Permit", pod: "Proof of delivery",
  handover: "Handover note", attendance_proof: "Attendance proof",
  prevision: "Prevision", tdrn: "TDRN",
  warehouse_receipt: "Warehouse receipt", warehouse_entry: "Warehouse entry",
  warehouse_exit: "Warehouse exit"
};

/** Unknown kind → the key itself, so a new kind reads as a name rather than a blank cell. */
export const kindLabel = (kind: string) => DOC_KIND_LABELS[kind] ?? kind;
