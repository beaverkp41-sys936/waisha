/**
 * The five things the office checks about an account, in the desk's own words (127; task #342).
 *
 * This is the web half of a three-way contract: `api/src/customers/checks.ts` is what the routes
 * accept, `customer_verifications` is what the table allows, and `smoke-customers.ts` reads the
 * `kind` CHECK straight out of `pg_constraint` and refuses to pass unless all three say the same
 * five words. A kind added here without the table is a select box that 400s; one added to the
 * table without this file is a kind no clerk can raise or name.
 *
 * The hints are copies of the route's patterns, not a second rule: the desk uses them to say what
 * a box expects *before* the write, and the register still refuses whatever it refuses.
 */

export const CHECK_KINDS = [
  "national_id", "tin", "trade_licence", "transport_licence", "insurance"
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const KIND_LABELS: Record<CheckKind, string> = {
  national_id: "National ID (NIDA)",
  tin: "Taxpayer number (TRA TIN)",
  trade_licence: "Trade licence",
  transport_licence: "Transport licence",
  insurance: "Insurance certificate"
};

/** What the register expects a number of each kind to look like. Mirrors KIND_SHAPES on the API. */
export const KIND_SHAPES: Record<CheckKind, { pattern: RegExp; hint: string }> = {
  national_id: { pattern: /^\d{8,20}$/, hint: "8 to 20 digits, with no letters" },
  tin: { pattern: /^\d{9,12}$/, hint: "9 to 12 digits" },
  trade_licence: { pattern: /^[A-Z0-9][A-Z0-9/-]{3,39}$/i, hint: "4 to 40 letters or digits, slash or dash" },
  transport_licence: { pattern: /^[A-Z0-9][A-Z0-9/-]{3,39}$/i, hint: "4 to 40 letters or digits, slash or dash" },
  insurance: { pattern: /^[A-Z0-9][A-Z0-9/-]{3,39}$/i, hint: "4 to 40 letters or digits, slash or dash" }
};

/** The three kinds that carry a day they lapse — the same list the table's CHECK reads. A national
 *  ID does not expire here, because the office does not decide when a card stops being a card. */
export const EXPIRING_KINDS: CheckKind[] = ["trade_licence", "transport_licence", "insurance"];
export const expiresOnKind = (k: string) => EXPIRING_KINDS.includes(k as CheckKind);

/** The two open states, then the three terminal answers. A line holding an answer is frozen by a
 *  trigger, so this order is also the order a clerk can never go backwards through. */
export const OPEN_STATES = ["awaiting", "submitted"] as const;
export const ANSWERS = ["approved", "rejected", "needs_more"] as const;
export const CHECK_STATES = [...OPEN_STATES, ...ANSWERS] as const;

export const isOpenState = (s: string) => (OPEN_STATES as readonly string[]).includes(s);

export const CHECK_STATE_LABELS: Record<string, string> = {
  awaiting: "Waiting on the account",
  submitted: "Paper in, waiting on an answer",
  approved: "Approved",
  rejected: "Refused",
  needs_more: "More information asked"
};

export const CHECK_EDGE: Record<string, string> = {
  awaiting: "var(--warning)", submitted: "var(--adm-accent)", approved: "var(--success)",
  rejected: "var(--danger)", needs_more: "var(--gold)"
};

/** The trust bands `platform_auth.customer_trust` answers with. Nothing on this desk stores a
 *  score, so the words the read uses are the only ones a clerk will ever see. */
export const BAND_LABELS: Record<string, string> = {
  strong: "Strong", good: "Good", steady: "Steady", watched: "Watched",
  unverified: "Never verified", held: "Held by the office", closed: "Closed"
};
export const BAND_EDGE: Record<string, string> = {
  strong: "var(--success)", good: "var(--success)", steady: "var(--adm-accent)",
  watched: "var(--warning)", unverified: "var(--ink-soft)", held: "var(--danger)",
  closed: "var(--ink-soft)"
};

/** The account states `tenants.status` allows (001), and the words 078's register uses for them. */
export const ACCOUNT_STATES: [string, string][] = [
  ["pending_verification", "Not verified yet"], ["trial", "On trial"], ["active", "Active"],
  ["grace", "In grace"], ["expired", "Lapsed"], ["suspended", "Suspended"]
];

/** The board's own filter words — these are `platform_auth.customer_board`'s `p_status` cases,
 *  not a preference. `p_kind` on the board means "has an open line of this kind". */
export const BOARD_STATES: [string, string][] = [
  ["waiting", "Waiting on a check"], ["refused", "Refused or sent back"],
  ["expired", "Paper past its day"], ["clear", "Clear"], ["none", "Never checked"]
];

/** The `source` values `platform_auth.customer_timeline` emits. The definer filters with
 *  `source = p_kind`, so a chip named for a value it never emits shows an empty story. */
export const TIMELINE_SOURCES: [string, string][] = [
  ["account", "The account itself"], ["decision", "Blocks and notices"],
  ["verification", "Checks"], ["note", "The office's notes"], ["tag", "Labels"],
  ["call", "Calls"], ["service", "Disputes and papers"], ["exit", "The exit"],
  ["office", "Other office writes"]
];

/** The number as the desk read it, cut the way the register stores it: nothing but the tail is
 *  ever put on screen, and the whole value only comes from the route that is allowed to reveal it. */
export function referenceTail(value: string): string {
  return value.trim().replace(/\s+/g, "").slice(-4).toUpperCase();
}

/** True when the typed number is the shape this kind expects — the desk's early warning, not a
 *  second validator with authority. The route's `normaliseReference` is the one that decides. */
export function referenceLooksRight(kind: string, raw: string): boolean {
  const rule = KIND_SHAPES[kind as CheckKind];
  if (!rule || !raw.trim()) return true;
  return rule.pattern.test(raw.trim().replace(/\s+/g, ""));
}
