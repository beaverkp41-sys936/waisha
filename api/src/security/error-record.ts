import { createHash } from "node:crypto";
import { env } from "../env.js";
import { pool } from "../db/pool.js";

/**
 * The error collector (082).
 *
 * A 500 used to be written to the process log and lost with the next restart, so the
 * operator learned about a failure when a customer complained about it. Everything the
 * system gets wrong now lands in `app_errors` — the API's own unhandled failures, and
 * what the browser reports about itself.
 *
 * Three rules hold this together:
 *  - the collector never throws and never blocks a response. A register that can break
 *    the request it is recording is how one bad route becomes every bad route;
 *  - nothing is written to the table directly. `platform_auth.record_error` is the only
 *    door, and it clamps and folds repeats — so a bug in a handler cannot be edited into
 *    silence by the same handler;
 *  - what goes in is scrubbed first. This table is read by whoever opens the desk, and an
 *    stack trace that quotes a user's NIDA number or a phone number would turn a
 *    reliability register into a PII register.
 */

/** Exported so the verify script executes the identical string, not a re-typing. */
export const RECORD_ERROR_SQL =
  "select platform_auth.record_error($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)";

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;
const NUMBERED = /^\d{2,}$/;

/**
 * `/api/v1/cargo/1f0a…/docs?x=1` and `/api/v1/cargo/22/docs` are the same place, and a
 * register that keys on the raw URL produces one line per order number instead of one
 * line per bug. Id-shaped segments collapse to `:id`, the query string goes entirely.
 */
export function normalisePath(url: string): string {
  const path = (url ?? "").split("?")[0].split("#")[0];
  return path
    .split("/")
    .map((seg) => (UUID_SEGMENT.test(seg) || LONG_HEX.test(seg) || NUMBERED.test(seg) ? ":id" : seg))
    .join("/")
    .slice(0, 300);
}

/**
 * Contact-shaped text never enters the register. Emails, Tanzanian and international
 * MSISDNs, any long digit run, and anything following a credential word are replaced
 * before hashing, so the fingerprint and the stored message both describe the failure
 * without repeating the data that was inside it.
 */
export function scrub(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const text = String(value)
    // The domain half has to swallow every label: `@alpha.co.tz` masked with a pattern that
    // stops at the second-to-last dot leaves the TLD sitting in the register after the mask.
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "e***@masked")
    .replace(/\+?255[67]\d{8}/g, "+255*******")
    .replace(/\b0?[67]\d{8}\b/g, "0*******")
    .replace(/\b\d{9,}\b/g, "###########")
    // The separator is optional in the wild: "Authorization: Bearer eyJ…" and "bearer eyJ…"
    // are both traces that appear in a stack. A word alone is not enough to mask — "token
    // is missing" has to stay readable — so a space-separated value is only replaced when it
    // actually looks like a credential (it carries a digit or is long enough to be one).
    .replace(/\b(bearer|authorization|password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*|\s+)(\S+)/gi,
      (all, word, sep, value) =>
        (/[=:]/.test(String(sep)) || /\d/.test(value) || value.length >= 12 ? `${word}${sep}***` : all))
    // Control characters would corrupt the stack block in the desk; newlines stay.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
  return text.slice(0, max).trim() || null;
}

/**
 * The message with its particulars removed, so the same bug twice is one fingerprint. An id
 * quoted inside the sentence is a particular too: a route that names the seat it failed on
 * would otherwise give one bug one line per customer.
 */
function messageShape(message: string): string {
  return String(message)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "*")
    .replace(/['"`][^'"`]*['"`]/g, "*")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export interface ErrorSeed {
  kind: "server" | "client";
  message: string;
  code?: string | null;
  status?: number | null;
  method?: string | null;
  path?: string | null;
  route?: string | null;
  detail?: string | null;
  requestId?: string | null;
  tenantId?: string | null;
  actorUserId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * kind + code + status + where it happened + the shape of the message. A route that
 * throws two different errors is two lines; the same error reached from two ids is one.
 *
 * Callers must hand this the text that is going to be *stored*, not the raw input: the
 * key is what folds a storm into one line, so a raw order id or a customer address in the
 * material would give the same bug one line per victim — and would let the unscrubbed
 * request into the one place a hash of it is kept for a year.
 */
export function fingerprintOf(seed: ErrorSeed): string {
  const where = seed.route || seed.path || "(none)";
  const material = [seed.kind, seed.code ?? "", seed.status ?? "", where, messageShape(seed.message)].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

/**
 * Fire-and-forget from a request path: the caller has already failed, and making them
 * wait on a second database round trip to be told so is the worse bug. The promise is
 * returned anyway so a test can await it; production callers ignore it.
 */
export function recordError(seed: ErrorSeed): Promise<void> {
  const message = scrub(seed.message, 500);
  if (!message) return Promise.resolve();
  const path = seed.path ? normalisePath(seed.path) : null;
  // The key is built from exactly what is stored, so one bug is one line however many
  // customers, orders or ids it happened to.
  const params = [
    seed.kind,
    fingerprintOf({ ...seed, message, path }),
    scrub(seed.code, 60),
    seed.status ?? null,
    scrub(seed.method, 8),
    path,
    scrub(seed.route, 120),
    message,
    scrub(seed.detail, 4000),
    scrub(seed.requestId, 64),
    // Server-observed attribution only — see the intake route: a browser never supplies a
    // tenant or a seat, so nobody can write themselves into another company's history.
    seed.tenantId ?? null,
    seed.actorUserId ?? null,
    scrub(seed.ip, 60),
    scrub(seed.userAgent, 200),
    env.NODE_ENV
  ];
  return pool.query(RECORD_ERROR_SQL, params)
    .then(() => undefined)
    .catch(() => {
      // The register being unreachable is itself a failure, but writing it anywhere the
      // collector also reads would loop, and logging it as an error would flood the log
      // the register was meant to replace. The request id already went to the caller.
    });
}

/**
 * Fastify's route pattern for the request that failed. `routeOptions` is a getter that
 * dereferences the route context, so on a failure raised before routing it throws — and
 * an error handler that throws is how one broken request becomes a hung one.
 */
function routeOf(req: any): string | null {
  try { return req?.routeOptions?.url ?? null; } catch { return null; }
}

/** The API's own 5xx, from inside the error handler. */
export function captureServerError(args: {
  err: any;
  req: any;
  statusCode: number;
  requestId: string;
}): void {
  const { err, req, statusCode, requestId } = args;
  void recordError({
    kind: "server",
    message: String(err?.message ?? "Unhandled error").slice(0, 500),
    code: err?.code ?? "INTERNAL",
    status: statusCode,
    method: req?.method ?? null,
    path: req?.url ?? null,
    route: routeOf(req),
    detail: typeof err?.stack === "string" ? err.stack : null,
    requestId,
    // Only ever the tenant the server put on the token itself.
    tenantId: req?.user?.tid ?? req?.control?.tenant_id ?? null,
    actorUserId: req?.user?.sub ?? req?.control?.user_id ?? null,
    ip: req?.ip ?? null,
    userAgent: req?.headers?.["user-agent"] ?? null
  });
}
