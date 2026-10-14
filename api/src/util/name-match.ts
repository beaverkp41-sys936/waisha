/**
 * Watchlist name matching — deliberately simple and explainable.
 * Names normalise to uppercase alphanumeric tokens with legal suffixes
 * removed ("Acme Trading Ltd" and "ACME TRADING COMPANY LIMITED" both
 * become {ACME, TRADING}), then match when one token set is a subset of
 * the other. Over-flagging is preferred to missing a hit: the officer
 * reviews and dismisses.
 */
const LEGAL_SUFFIXES = new Set([
  "LTD", "LIMITED", "CO", "COMPANY", "CORP", "CORPORATION", "INC",
  "LLC", "PLC", "LP", "LLP"
]);

export function nameTokens(name: string): string[] {
  const raw = name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  if (!raw) return [];
  const rawTokens = raw.split(/\s+/);
  const cleaned = rawTokens.filter((t) => !LEGAL_SUFFIXES.has(t));
  // A name that is entirely legal suffixes keeps its raw tokens so it can
  // still match itself instead of collapsing to an empty set.
  return cleaned.length ? cleaned : rawTokens;
}

export function namesMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const largeSet = new Set(large);
  return small.every((t) => largeSet.has(t));
}
