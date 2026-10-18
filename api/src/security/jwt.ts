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
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function issueAccessToken(c: AccessClaims): Promise<string> {
  return new SignJWT({ tid: c.tid, sid: c.sid, typ: c.typ, roles: c.roles })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime("15m")
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
  const { sub, tid, sid, typ, roles } = payload as Partial<AccessClaims>;
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
  return { sub, tid, sid, typ, roles };
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key);
    return readAccessClaims(payload);
  } catch {
    return null;
  }
}
