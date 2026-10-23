/**
 * The two kinds of ask a data subject can make, and the ten things an erasure may touch
 * (129; task #342).
 *
 * The same three-way contract 117 and 127 left for cargo papers and checks:
 * `api/src/customers/data-request.ts` is what the routes accept, `customer_data_requests` is what
 * the table allows, and 129's gate reads the `categories` CHECK straight out of `pg_constraint` and
 * refuses to pass unless all three carry the same ten words. A category added here without the
 * table is a tick box the register answers with a 400; one added to the table without this file is
 * a category no clerk can name or tick.
 *
 * What is deliberately *not* written here is the mask's arithmetic. The counts beside each category
 * and the twelve things that stay whatever the desk ticks come out of `data_request_preview` as
 * rows and sentences from SQL, because a page that counted them again would be a second opinion
 * about what an erasure does — and the second opinion is what a supervisory question contradicts.
 */

/** What the routes accept, what the table allows, and what the desk prints: `export` and `erase`. */
export const DATA_REQUEST_KINDS = ["export", "erase"] as const;
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number];

/** The register's own sentence for each kind, copied from the API so a desk reads the words the
 *  route was written with rather than a paraphrase of them. */
export const KIND_SENTENCES: Record<DataRequestKind, string> = {
  export: "A copy of everything the registers hold about this account (Article 15).",
  erase: "A mask of the personal data inside the categories ticked below (Article 17)."
};

/** The short name a chip or a filter carries. */
export const KIND_LABELS: Record<DataRequestKind, string> = {
  export: "A copy (Article 15)",
  erase: "An erasure (Article 17)"
};
export const kindWord = (k: string | null | undefined) =>
  k ? KIND_LABELS[k as DataRequestKind] ?? k : "—";

/** The ten things 129's mask may touch, in the order the mask walks them — account first, because
 *  the name every other row points at is the one being erased; papers last, because the register
 *  row is masked while the bytes behind it wait for the storage sweep. */
export const CATEGORIES = [
  "account", "seats", "sessions", "profile", "contacts", "drivers",
  "cargo_people", "calls", "messages", "papers"
] as const;
export type DataCategory = (typeof CATEGORIES)[number];

/** What the desk prints beside each tick box: the word the signature is asked for, in one line.
 *  Copies of `CATEGORY_LABELS` on the API — the smoke insists the two lists and the CHECK agree. */
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
export const categoryWord = (c: string) => CATEGORY_LABELS[c as DataCategory] ?? c;

/** The five states the register itself uses, and the words a clerk reads. `pending_signature` and
 *  `erased` only ever hold for an erasure and `delivered` only for a copy — a CHECK on the row says
 *  so, which is why the two kind chips and the five status chips cannot be combined into a filter
 *  that answers with an empty queue. */
export const REQUEST_STATUSES = [
  "raised", "pending_signature", "delivered", "erased", "refused"
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const STATUS_LABELS: Record<RequestStatus, string> = {
  raised: "Raised",
  pending_signature: "Waiting on a second signature",
  delivered: "Copy handed over",
  erased: "Masked",
  refused: "Refused"
};
export const statusWord = (s: string | null | undefined) =>
  s ? STATUS_LABELS[s as RequestStatus] ?? s : "—";
export const STATUS_EDGE: Record<string, string> = {
  raised: "var(--warning)", pending_signature: "var(--adm-accent)", delivered: "var(--success)",
  erased: "var(--gold)", refused: "var(--danger)"
};

/** The two states that still hold the account's one open slot of that kind. The raise form says so
 *  and the register answers a second one with a conflict rather than a row. */
export const OPEN_REQUESTS: RequestStatus[] = ["raised", "pending_signature"];
export const isOpenRequest = (s: string | null | undefined) =>
  !!s && OPEN_REQUESTS.includes(s as RequestStatus);

/**
 * The eight chips the board counts, in the order the desk prints them.
 *
 * `sends` is what a chip hands back as a filter and it is the definer's own parameter: the six
 * status chips send `status`, the two kind chips send `kind`. A chip named for a word
 * `data_requests_board` never counts would read as nought forever.
 */
export const BOARD_CHIPS: { key: string; label: string; sends: { status?: string; kind?: string } }[] = [
  { key: "all", label: "Every paper", sends: {} },
  { key: "raised", label: "Raised, nothing done", sends: { status: "raised" } },
  { key: "pending_signature", label: "Waiting on a second seat", sends: { status: "pending_signature" } },
  { key: "delivered", label: "Copy handed over", sends: { status: "delivered" } },
  { key: "erased", label: "Masked", sends: { status: "erased" } },
  { key: "refused", label: "Refused", sends: { status: "refused" } },
  { key: "export", label: "All the copies", sends: { kind: "export" } },
  { key: "erase", label: "All the erasures", sends: { kind: "erase" } }
];

/** The categories each kind may carry — the difference between the two kinds, not a detail. A copy
 *  is not a menu; an erasure that names nothing is a refusal wearing a form. */
export const categoriesAllowedFor = (kind: string) => kind === "erase";

/** The `asked_in` column is 3-80 characters, so the desk is told the floor it will be refused at
 *  rather than by a constraint it cannot read. Copies of `ASKED_IN_EXAMPLES` on the API. */
export const ASKED_IN_EXAMPLES = [
  "call", "email", "letter", "walked in", "web form", "through a lawyer"
] as const;

/** 8 characters is the floor both `raise_data_request` and `refuse_data_request` enforce, because
 *  the sentence is the one a second seat reads and a supervisory question quotes back. */
export const REASON_FLOOR = 8;

/** How many folders `platform_auth.data_export` writes into the archive: one per section, as CSV and
 *  as JSON, beside a README, a manifest and a checksum list. 129's gate counts the sections in a
 *  real bundle; this is the number the desk is allowed to promise. */
export const EXPORT_SECTION_COUNT = 17;

/** A hash is 64 characters, which is not a thing a person reads. The head and the tail are enough to
 *  see that two of them are the same paper. */
export const shaWords = (sha: string | null | undefined) =>
  sha ? `${sha.slice(0, 12)}…${sha.slice(-6)}` : "nothing hashed yet";

/**
 * The counts `data_request_preview` carries for one category, in the office's own words.
 *
 * The keys come straight out of 129's SQL and the desk prints every one it is handed rather than a
 *  list of its own: a category whose counters were written here would drift the moment the mask
 *  reached one more column. `withdrawn_from_board` is the table's own key name for the listings
 *  still live on the public board, so the word beside it says what the predicate counts.
 */
const FIELD_WORDS: Record<string, string> = {
  rows: "row(s)",
  name_copies: "named on other office files",
  with_tin: "with a TIN",
  with_phone: "with a phone",
  with_email: "with an email",
  with_slug: "with a trading name",
  with_nida: "with a NIDA",
  with_totp: "with a two-factor secret",
  active: "still working",
  live: "not signed out",
  with_ip: "with an address recorded",
  with_device: "with a device recorded",
  with_brela: "with a BRELA number",
  with_vat: "with a VAT number",
  with_licence: "with a transport licence",
  with_pay_bank: "with a bank account",
  with_pay_mobile: "with a mobile-money number",
  listings: "on the public board",
  withdrawn_from_board: "still live on the board",
  with_contact: "with a contact channel",
  with_address: "with an address",
  with_dob: "with a date of birth",
  with_next_of_kin: "with a next of kin",
  with_consignee: "naming a consignee",
  with_consignor: "naming a consignor",
  with_notes: "with a note on the file",
  with_reporter_name: "naming who rang",
  with_reporter_email: "with their email",
  with_reporter_phone: "with their phone",
  with_words: "with the office's words",
  with_resolution: "with how it was answered",
  with_names: "with a file name"
};
const fieldWord = (key: string) => FIELD_WORDS[key] ?? key.replace(/_/g, " ");

/** `"3 row(s) · with a NIDA — 2 · with a phone — 3"` — one line per category, read off the preview.
 *  A counter that reads nought is left out, because "0 with a next of kin" is not a fact about the
 *  account; the row count is always printed, and zero rows is the fact that line carries. */
export function maskWords(mask: Record<string, unknown> | undefined): string {
  if (!mask) return "the register gave no count";
  const extra: string[] = [];
  let head = "";
  for (const [key, value] of Object.entries(mask)) {
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    if (key === "rows") head = `${n} ${fieldWord(key)}`;
    else if (n > 0) extra.push(`${fieldWord(key)} — ${n}`);
  }
  if (!head && extra.length === 0) return "the register gave no count";
  return [head || "counted", ...extra].join(" · ");
}

/** The count one category actually reached. `erased` is the object 129 writes in the same
 *  transaction as the answer, so a category that was ticked but held nothing reads 0 rather than
 *  empty — which is the difference between "nothing to erase there" and "the mask skipped it". */
export function erasedCount(erased: Record<string, unknown> | null | undefined,
  category: string): number | null {
  if (!erased || typeof erased !== "object") return null;
  const v = (erased as Record<string, unknown>)[category];
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** The list a signature is taken against, in the order the register sorted it on the way in. */
export function categoryList(cats: string[] | null | undefined): string {
  if (!cats || cats.length === 0) return "nothing was named";
  return cats.join(", ");
}
