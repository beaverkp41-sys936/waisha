import { SignJWT, jwtVerify } from "jose";
import { env } from "../env.js";

const key = new TextEncoder().encode(env.JWT_SECRET);

export interface AccessClaims {
  sub: string;   // user id
  tid: string;   // tenant id
  sid: string;   // session id
  typ: string;   // user type
  roles: string[];
}

export async function issueAccessToken(c: AccessClaims): Promise<string> {
  return new SignJWT({ tid: c.tid, sid: c.sid, typ: c.typ, roles: c.roles })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key);
    return payload as unknown as AccessClaims;
  } catch {
    return null;
  }
}