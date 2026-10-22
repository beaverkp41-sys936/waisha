/**
 * The placeholders a canned reply may use (125), and the one function that fills them in.
 *
 * `support_canned_replies` refuses a body containing any other brace at the table itself, so a
 * desk cannot write `{plate}` and have it reach a caller still spelled with braces. That trigger
 * and this file are the same rule written twice on purpose — the way 112 wrote its purpose list
 * twice — and verify-inbox-sql.ts is what keeps the two copies agreeing. If you add a token
 * here, add it to `platform_auth.canned_reply_tokens_are_known()` in the same breath.
 *
 * A token with no value is dropped rather than printed: "Hello {name}" with nobody on the call
 * should read "Hello", not "Hello {name}". The route still reports which ones were empty,
 * because a reply that went out with a hole in it is the desk's business, not a silent edit.
 */

export const CANNED_TOKENS = ["name", "ref", "company", "department", "agent", "subject"] as const;
export type CannedToken = typeof CANNED_TOKENS[number];

/** Everything the six tokens can be filled from. All optional: the register holds an email
 *  only when the caller gave one, and a walk-in call has no company link to read. */
export interface CannedContext {
  name?: string | null;
  ref?: string | null;
  company?: string | null;
  department?: string | null;
  agent?: string | null;
  subject?: string | null;
}

const KNOWN = new Set<string>(CANNED_TOKENS);
const KNOWN_TOKEN_RE = /\{(name|ref|company|department|agent|subject)\}/g;
const ANY_BRACE_RE = /\{([^{}]*)\}/g;

/** The words in braces that this file does not know, plus any unbalanced brace. Same test the
 *  trigger runs, so a body the desk can type is exactly a body the table will accept. */
export function unknownTokens(body: string): string[] {
  const rest = body.replace(KNOWN_TOKEN_RE, "");
  const found: string[] = [];
  for (const m of rest.matchAll(ANY_BRACE_RE)) found.push(m[0]);
  if (found.length === 0 && /[{}]/.test(rest)) found.push(rest.match(/[{}]/)![0]);
  return [...new Set(found)];
}

export interface RenderedReply {
  text: string;
  /** Token names the body asked for that the register could not answer. */
  unfilled: CannedToken[];
}

/** Fill one body in. Deterministic and total — it never throws, whatever the body says. */
export function renderCanned(body: string, ctx: CannedContext): RenderedReply {
  const unfilled = new Set<CannedToken>();
  const text = body.replace(KNOWN_TOKEN_RE, (raw, token: string) => {
    if (!KNOWN.has(token)) return raw;
    const value = ctx[token as CannedToken];
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) {
      unfilled.add(token as CannedToken);
      return "";
    }
    return trimmed;
  });
  // Two dropped tokens in a row leave a double space behind, which reads as a typing mistake on
  // a message that is about to go to a customer.
  return { text: text.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.;:!?])/g, "$1").trim(),
    unfilled: [...unfilled] };
}

/** The context an incidence can answer for, in the shapes both the preview and the real reply
 *  read. Kept as a plain function of a ticket row plus the seat, so the desk previewing a reply
 *  and the register sending it can never disagree about what `{agent}` means. */
export function contextForTicket(ticket: Record<string, any>, agentName: string | null):
  CannedContext {
  return {
    name: ticket?.reporter_name ?? null,
    ref: ticket?.ref ?? null,
    company: ticket?.company_name ?? null,
    department: ticket?.department_name ?? null,
    agent: agentName,
    subject: ticket?.subject ?? null
  };
}
