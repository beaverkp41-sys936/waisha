import { SignJWT, jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { env } from "../env.js";

const key = new TextEncoder().encode(env.JWT_SECRET);

export interface AccessClaims {
  sub: string;   // user id
  tid: string;   // tenant id
  sid: string;   // session id
  typ: string;   // the seat's first role — see readAccessClaims, this is not users.user_type
  roles: string[];
  /**
   * The platform seat actually driving this session, when it is not the subject's own
   * (migrations/106). Absent means "this person is themselves".
   */
  act?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `expiresIn` exists for one caller. A borrowed support seat can never renew — its row has
 * no usable refresh token and `rotate_refresh` refuses a borrowed row (106) — so the bearer
 * is the only clock it has, and the desk signs it for exactly `SUPPORT_WINDOW_MINUTES` rather
 * than trusting this default to agree with a constant in another file. Today both are 15 m.
 */
export async function issueAccessToken(c: AccessClaims, expiresIn = "15m"): Promise<string> {
  return new SignJWT({ tid: c.tid, sid: c.sid, typ: c.typ, roles: c.roles, ...(c.act ? { act: c.act } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/**
 * The shape every route assumes and none of them checks.
 *
 * Forty-one files carry the same three-line `requireAuth`, and each goes on to use
 * `req.user.tid` as the RLS tenant and `req.user.sub` as the actor without looking at
 * what arrived. A signature alone does not prove the payload is one this API issued:
 * `tid: null` reaches `set_config('app.tenant_id', …)` as the text "null" and `typ: 42`
 * reaches a string column, so a token shaped like ours but not minted by our own
 * `issueAccessToken` stops being an authorization question and becomes a 500 — or, if a
 * cast ever softens, a query in a tenant nobody signed into.
 *
 * Returning null is the only safe answer here: every caller already turns it into 401.
 */
export function readAccessClaims(payload: JWTPayload): AccessClaims | null {
  const { sub, tid, sid, typ, roles, act } = payload as Partial<AccessClaims>;
  if (typeof sub !== "string" || !UUID.test(sub)) return null;
  if (typeof tid !== "string" || !UUID.test(tid)) return null;
  if (typeof sid !== "string" || !UUID.test(sid)) return null;
  // Mislabeled at birth ("user type" in the comment, roles[0] in the value) and read by
  // nothing today. Bounded and string-typed rather than matched to a vocabulary, because
  // inventing a second source of truth for a claim nobody consumes is how it goes wrong.
  if (typeof typ !== "string" || typ.length === 0 || typ.length > 64) return null;
  if (!Array.isArray(roles) || roles.length > 64 || !roles.every((r) => typeof r === "string" && r.length <= 64)) {
    return null;
  }
  // The borrowed-seat mark, if the route's own guard is to trust it. A UUID or nothing: an
  // `act` that is a string, an array, or somebody else's tenant would be a claim the
  // read-only guard reads and the audit trail writes, which is exactly the shape of the
  // bugs 106 was written to prevent. Absent is the ordinary seat and stays untouched.
  if (act !== undefined && act !== null && (typeof act !== "string" || !UUID.test(act))) return null;
  return { sub, tid, sid, typ, roles, ...(typeof act === "string" ? { act } : {}) };
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key);
    return readAccessClaims(payload);
  } catch {
    return null;
  }
}
