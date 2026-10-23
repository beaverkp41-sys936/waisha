/**
 * The ten things an erasure may erase, and the two kinds of ask (129; task #342).
 *
 * One author per side, as 117 left the cargo paper kinds and 127 left the check kinds: this file
 * is what the routes accept, `web/app/control/customers/data-requests.ts` is what the desk prints,
 * and 129's smoke reads the `categories` CHECK out of `pg_constraint` and insists the three agree.
 * A word added here without the table is a 400 the desk cannot explain; a word added to the table
 * without this file is a category nobody can tick.
 *
 * The order is the order the mask walks them — account first, because the name every other row
 * points at is the one being erased, papers last, because the register row is masked while the
 * bytes behind it wait for the storage sweep.
 */

export const DATA_REQUEST_KINDS = ["export", "erase"] as const;
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number];

export const KIND_SENTENCES: Record<DataRequestKind, string> = {
  export: "A copy of everything the registers hold about this account (Article 15).",
  erase: "A mask of the personal data inside the categories ticked below (Article 17)."
};

export const CATEGORIES = [
  "account", "seats", "sessions", "profile", "contacts", "drivers",
  "cargo_people", "calls", "messages", "papers"
] as const;
export type DataCategory = (typeof CATEGORIES)[number];

/** What the desk prints beside each tick box: the word the signature is asked for, in one line. */
export const CATEGORY_LABELS: Record<DataCategory, string> = {
  account: "The account itself — its name, email, TIN, phone and address",
  seats: "The people with a seat — name, email, phone, NIDA and two-factor secret",
  sessions: "Every sign-in — the device and the IP it came from",
  profile: "The trading profile and the public directory listing",
  contacts: "Contacts, consignee books and the offices on file",
  drivers: "Drivers — NIDA, phone, date of birth and next of kin",
  cargo_people: "The people named on a cargo file — consignee, consignor and the notes",
  calls: "The calls this account phoned in — who rang, what they said, how it was answered",
  messages: "The messages exchanged on the platform",
  papers: "The names of the stored files — the bytes wait for the storage sweep"
};

/** The five states the register itself uses. `pending_signature` and `erased` only ever hold for an
 *  erasure, and `delivered` only for a copy — a CHECK on the row says so, so a filter that mixes
 *  them answers with an empty queue rather than a lie. */
export const REQUEST_STATUSES = [
  "raised", "pending_signature", "delivered", "erased", "refused"
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const OPEN_STATUSES: RequestStatus[] = ["raised", "pending_signature"];

export const STATUS_LABELS: Record<RequestStatus, string> = {
  raised: "Raised",
  pending_signature: "Waiting on a second signature",
  delivered: "Copy handed over",
  erased: "Erased",
  refused: "Refused"
};

/** The categories each kind may carry, which is the difference between the two kinds and not a
 *  detail: a copy is not a menu, and an erasure that names nothing is a refusal wearing a form. */
export const categoriesAllowedFor = (kind: string) => kind === "erase";

/** The `asked_in` column is 3-80 characters on the row, so the desk is told the same floor it will
 *  be refused below rather than by a constraint it cannot read. */
export const ASKED_IN_EXAMPLES = [
  "call", "email", "letter", "walked in", "web form", "through a lawyer"
] as const;

/**
 * The sections a copy carries, in the order `platform_auth.data_export` builds them.
 *
 * The labels come out of the definer with the rows, because the manifest the subject reads and the
 * sheet beside it must be the same words. This list is what the API walks when it writes the
 * archive, and what the smoke counts: a section added in SQL and not here is a folder nobody opens.
 */
export const EXPORT_SECTIONS = [
  "account", "profile", "seats", "logins", "checks", "notes", "labels", "calls", "call_events",
  "cargo", "papers", "contacts", "drivers", "money", "service", "actions", "requests"
] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

/**
 * The columns `data_export` hands back as ciphertext on purpose.
 *
 * A definer runs inside the database and this platform's key does not live there, so an encrypted
 * value leaves SQL as hex and the route that assembles the bundle decrypts it and drops the hex.
 * Naming them here is what keeps a new encrypted column from shipping as a wall of base16 in the
 * copy a data subject is owed — the smoke fails on a `*_hex` key that is not in this list.
 */
export const HEX_FIELDS = [
  "tin_hex", "phone_hex", "nida_hex", "reference_hex", "reporter_phone_hex"
] as const;

/** `tin_hex` is the account's TIN, `reference_hex` a NIDA or licence number on a check line. The
 *  plain key the decrypted value is written under — a name a subject reads, not a column. */
export const HEX_PLAIN_NAMES: Record<(typeof HEX_FIELDS)[number], string> = {
  tin_hex: "tin",
  phone_hex: "phone",
  nida_hex: "nida",
  reference_hex: "reference",
  reporter_phone_hex: "reporter_phone"
};
