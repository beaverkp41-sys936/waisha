import type { FastifyRequest } from "fastify";
import { pool } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { verifyAccessToken } from "./jwt.js";

/**
 * The block, enforced.
 *
 * 001 allowed `status = 'suspended'` on a tenant and nothing in the codebase ever wrote
 * it, so "blocking a company" was a value in a CHECK constraint, not a capability. From
 * 078 the control desk can block one, and from 080 can close one, and an act that only
 * changes a column is a note to nobody: this module is what makes it stop serving the
 * company.
 *
 * Two doors, because the two clocks are different. A block or a close revokes the refresh
 * sessions immediately, so the next token rotation fails and the client is bounced to
 * sign-in — but an access token is valid for 15 minutes from issue and is not consulted
 * against the database by any route. This module closes that window.
 *
 * `/api/v1/auth/` stays open on purpose. Signing out, `/auth/me` and the refresh
 * handshake are how a person who has just been blocked finds out what happened to them
 * and gets out cleanly; closing them would turn a stated, explained suspension into a
 * wall of 403s with no message on it.
 */

export interface BlockState {
  reason_code: string;
  note: string;
  since: string | null;
  by: string;
  /** True when the company was closed rather than temporarily blocked (080). */
  closed?: boolean;
}

/** Authoritative, single-company read. Params: tenant. */
export const BLOCK_STATE_SQL =
  "select platform_auth.tenant_block_state($1) as s";

/** The whole out-of-service set in one read. No params. */
export const SUSPENSIONS_SQL =
  "select platform_auth.tenant_suspensions() as s";

/**
 * The login path asks one company, right now, because the answer is the sentence that
 * person is reading and it cannot be stale.
 */
export async function tenantBlockState(tenantId: string): Promise<BlockState | null> {
  if (!tenantId) return null;
  const { rows } = await pool.query(BLOCK_STATE_SQL, [tenantId]);
  return (rows[0]?.s as BlockState | null) ?? null;
}

const REASONS: Record<string, string> = {
  terms_violation: "a breach of the WAISHA terms",
  long_idle: "no paid licence for an extended period",
  payment_default: "an unpaid subscription",
  abuse: "misuse of the platform",
  complaint: "a complaint against the company",
  security: "a security concern",
  other: "a decision by the WAISHA office"
};

/** The sentence the blocked person reads, and the sentence the SMS carries. */
export function blockedMessage(s: BlockState): string {
  const why = REASONS[s.reason_code] ?? s.reason_code;
  const by = s.by === "system" ? "the WAISHA policy clock" : "the WAISHA office";
  const act = s.closed
    ? `WAISHA access for this company has been withdrawn by ${by} — ${why}.`
    : `WAISHA access for this company is suspended by ${by} — ${why}.`;
  return `${act} ${s.note} Contact support@tengoaegis.com to resolve it.`;
}

/**
 * The set of companies out of service, held in the process for a few seconds.
 *
 * Without this, every authenticated request would add a round trip to the pool to ask a
 * question whose answer is "nobody is blocked" almost all of the time. `requireAuth`
 * verifies a signature and touches no database, so a per-request query here would be the
 * first thing the whole portal pays for. The set is small by design — the desk blocks
 * deliberately, and the idle clock only after six weeks — so reading it wholesale is
 * cheaper than asking company by company.
 *
 * Twenty seconds is the cost of the approximation, and it is a cost the office accepts:
 * the block itself commits immediately, the sessions are revoked immediately, and this
 * cache only governs the window that closes the fifteen-minute tokens. A stale entry here
 * delays enforcement by seconds; a stale `unblock` delays a company coming back by the
 * same few seconds, which is not a harm.
 */
const SNAPSHOT_TTL_MS = 20_000;

let snapshot: { at: number; p: Promise<Map<string, BlockState>> } | null = null;

async function loadSuspensions(): Promise<Map<string, BlockState>> {
  const { rows } = await pool.query(SUSPENSIONS_SQL);
  const list = (rows[0]?.s as { tenant_id: string; state: BlockState | null }[] | null) ?? [];
  const map = new Map<string, BlockState>();
  for (const entry of list) if (entry.state) map.set(entry.tenant_id, entry.state);
  return map;
}

function suspendedTenants(): Promise<Map<string, BlockState>> {
  const now = Date.now();
  if (snapshot && now - snapshot.at < SNAPSHOT_TTL_MS) return snapshot.p;
  // Concurrency: the first request of the window installs the promise and everyone else
  // in the window awaits that same one, so a burst of traffic is one query, not one per
  // request. A read that fails is dropped at once rather than held for the TTL, because
  // a failed read is not evidence that nobody is blocked.
  const p = loadSuspensions();
  snapshot = { at: now, p };
  p.catch(() => { if (snapshot?.p === p) snapshot = null; });
  return p;
}

const AUTH_PREFIX = "/api/v1/auth/";

/**
 * Drop the cached set so the next request re-reads it.
 *
 * Called by the code that changes the set — the desk's own block/unblock/close and the
 * idle sweep — so pressing Block cuts the company on this process at once instead of up
 * to a TTL later. Another replica still converges on the clock, which is the residue the
 * cache is paid for; the acts that must land immediately (the status, the revoked
 * sessions, the register row) are already committed before this is called.
 */
export function forgetSuspensions(): void {
  snapshot = null;
}

export async function requireOperationalTenant(req: FastifyRequest) {
  const path = req.url.split("?")[0];
  if (path.startsWith(AUTH_PREFIX)) return;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!bearer) return;
  const claims = await verifyAccessToken(bearer);
  if (!claims?.tid) return;

  let blocked: Map<string, BlockState>;
  try {
    blocked = await suspendedTenants();
  } catch {
    // Fail open, deliberately. If this read cannot be answered the database is unhealthy,
    // and every route's own query is about to fail for every company as well — shutting
    // the whole portal on a healthy-looking token to enforce a block that the revoked
    // sessions already impose at the next rotation trades a certain outage for an
    // uncertain one. The login path does not fail open: it reads its answer direct.
    return;
  }

  const state = blocked.get(claims.tid);
  if (!state) return;
  throw new ApiError("TENANT_BLOCKED", blockedMessage(state), 403);
}
