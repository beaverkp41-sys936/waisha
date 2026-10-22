/**
 * The five things the office checks about an account (127; task #342).
 *
 * One author per side, as 117 left the cargo paper kinds: this file is what the routes accept,
 * `web/app/control/customers/checks.ts` is what the desk prints, and `smoke-customers.ts` reads
 * the `kind` CHECK out of `pg_constraint` and insists the three agree. A sixth kind added here
 * without the table is a 400 the desk cannot explain, and one added to the table without this
 * file is a kind nobody can raise.
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

/**
 * The shape a number must have before the desk may write it down.
 *
 * This is not a validation of the real world — a licence number issued in Dar es Salaam does not
 * consult this file — it is the guard that keeps a slip of the keyboard out of a register whose
 * whole point is a number that can be quoted back years later. A desk that is refused here is
 * told what the box expects, and a check that must go through against that rule is a note plus a
 * phone call, not a lie typed into a pattern.
 */
export const KIND_SHAPES: Record<CheckKind, { pattern: RegExp; hint: string }> = {
  national_id: { pattern: /^\d{8,20}$/, hint: "8 to 20 digits, with no letters" },
  tin: { pattern: /^\d{9,12}$/, hint: "9 to 12 digits" },
  trade_licence: { pattern: /^[A-Z0-9][A-Z0-9/-]{3,39}$/i, hint: "4 to 40 letters or digits, slash or dash" },
  transport_licence: { pattern: /^[A-Z0-9][A-Z0-9/-]{3,39}$/i, hint: "4 to 40 letters or digits, slash or dash" },
  insurance: { pattern: /^[A-Z0-9][A-Z0-9/-]{3,39}$/i, hint: "4 to 40 letters or digits, slash or dash" }
};

/**
 * The three kinds that carry a day they lapse — the same list `customer_verifications` checks
 * `expires_on` against. Two authors, one rule: a national ID does not expire on this register,
 * because the office does not decide when a card stops being a card.
 */
export const EXPIRING_KINDS: CheckKind[] = ["trade_licence", "transport_licence", "insurance"];

export const OPEN_STATES = ["awaiting", "submitted"] as const;
/** The three terminal answers. A line that holds one of these is frozen by a trigger. */
export const ANSWERS = ["approved", "rejected", "needs_more"] as const;
export const CHECK_STATES = [...OPEN_STATES, ...ANSWERS] as const;

export type CheckState = (typeof CHECK_STATES)[number];

export const isOpenState = (s: string) => (OPEN_STATES as readonly string[]).includes(s);
export const isAnswer = (s: string) => (ANSWERS as readonly string[]).includes(s);
export const expiresOnKind = (k: string) => (EXPIRING_KINDS as readonly string[]).includes(k);

/** The kinds that lapse, in the words a refusal uses — built from the list and the labels above,
 *  so a sentence naming them cannot be told apart from the rule it is refusing. */
export const EXPIRING_WORDS = EXPIRING_KINDS.map((k) => KIND_LABELS[k].toLowerCase()).join(", or ");

/** The longest number any of these kinds is, and the tail length the register keeps. */
export const REFERENCE_MAX = 40;
export const TAIL_MAX = 4;

/**
 * The number as the desk read it: spaces and dashes inside the value are the way a person types a
 * long digit string, so they go before the pattern is tested and before the bytes are written.
 * Nothing else is changed — a licence number with a slash in the middle keeps the slash.
 */
export function normaliseReference(kind: string, raw: string): string {
  const k = kind as CheckKind;
  const rule = KIND_SHAPES[k];
  if (!rule) throw new Error(`unknown check kind ${kind}`);
  const value = raw.trim().replace(/\s+/g, "");
  if (!rule.pattern.test(value)) {
    throw new ReferenceRefusal(
      `A ${KIND_LABELS[k]} reads as ${rule.hint}. “${value.slice(0, 40)}” does not.`);
  }
  return value;
}

/** Thrown instead of an ApiError so this module stays free of the HTTP layer; the route turns it
 *  into a 400 that names the field. */
export class ReferenceRefusal extends Error { }

/** The last characters the desk is allowed to show without a decision about who may see them. */
export function referenceTail(value: string): string {
  return value.slice(-TAIL_MAX).toUpperCase();
}
