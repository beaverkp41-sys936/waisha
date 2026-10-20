import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";

// env.ts validates at import time, so project modules are imported after the env block.
process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const { issueAccessToken, verifyAccessToken, readAccessClaims } = await import("../src/security/jwt.js");
const { identityBucket } = await import("../src/security/ratelimit.js");
const { httpUrl, webAddress } = await import("../src/security/url.js");
const { requireSupportReadonly, claimsAreBorrowed } = await import("../src/security/support.js");

const UID = "1f0a2b3c-4d5e-4a1b-9c8d-1e2f3a4b5c6d";
const TID = "2f0a2b3c-4d5e-4a1b-9c8d-1e2f3a4b5c6d";
const SID = "3f0a2b3c-4d5e-4a1b-9c8d-1e2f3a4b5c6d";
const GOOD = { sub: UID, tid: TID, sid: SID, typ: "transporter_director", roles: ["transporter_director"] };
const ACTOR = "4f0a2b3c-4d5e-4a1b-9c8d-1e2f3a4b5c6d";
const BORROWED = await issueAccessToken({ ...GOOD, act: ACTOR });
const OWN = await issueAccessToken(GOOD);

// Every one of the forty-one duplicated requireAuth copies reads req.user.tid as the RLS
// tenant and req.user.sub as the actor. A signature proves who minted the token; only this
// guard proves the payload is shaped like one this API issues.
describe("readAccessClaims", () => {
  it("accepts what issueAccessToken puts on the wire", () => {
    expect(readAccessClaims({ ...GOOD })).toEqual(GOOD);
  });

  it("accepts a seat that holds no duties, because deny-all is a valid state", () => {
    expect(readAccessClaims({ ...GOOD, roles: [] })).not.toBeNull();
  });

  it("refuses a missing or malformed subject, tenant or session", () => {
    expect(readAccessClaims({ ...GOOD, sub: undefined })).toBeNull();
    expect(readAccessClaims({ ...GOOD, tid: undefined })).toBeNull();
    expect(readAccessClaims({ ...GOOD, sid: null })).toBeNull();
    expect(readAccessClaims({ ...GOOD, tid: "not-a-uuid" })).toBeNull();
    // set_config('app.tenant_id', …) with the text "null" is a query in a tenant nobody
    // signed into, which is exactly the case a signature check cannot see.
    expect(readAccessClaims({ ...GOOD, tid: "null" })).toBeNull();
    expect(readAccessClaims({ ...GOOD, sid: 42 })).toBeNull();
  });

  it("refuses a role list that is not a list of short strings", () => {
    expect(readAccessClaims({ ...GOOD, roles: "admin" })).toBeNull();
    expect(readAccessClaims({ ...GOOD, roles: [1, 2] })).toBeNull();
    expect(readAccessClaims({ ...GOOD, roles: Array(65).fill("a") })).toBeNull();
    expect(readAccessClaims({ ...GOOD, roles: ["z".repeat(65)] })).toBeNull();
  });

  it("bounds the role label without inventing a vocabulary for it", () => {
    expect(readAccessClaims({ ...GOOD, typ: "" })).toBeNull();
    expect(readAccessClaims({ ...GOOD, typ: 7 })).toBeNull();
    expect(readAccessClaims({ ...GOOD, typ: "k".repeat(65) })).toBeNull();
    expect(readAccessClaims({ ...GOOD, typ: "staff" })).not.toBeNull();
  });
});

describe("verifyAccessToken", () => {
  it("round-trips a token this API minted", async () => {
    expect(await verifyAccessToken(await issueAccessToken(GOOD))).toEqual(GOOD);
  });

  it("refuses a token minted with another secret", async () => {
    const forged = await new SignJWT({ tid: TID, sid: SID, typ: "staff", roles: ["staff"] })
      .setProtectedHeader({ alg: "HS256" }).setSubject(UID).setExpirationTime("15m")
      .sign(new TextEncoder().encode("y".repeat(32)));
    expect(await verifyAccessToken(forged)).toBeNull();
  });

  it("refuses a correctly signed token whose claims are not ours", async () => {
    const shaped = await new SignJWT({ tid: null, sid: SID, typ: "staff", roles: ["staff"] })
      .setProtectedHeader({ alg: "HS256" }).setSubject(UID).setExpirationTime("15m")
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
    expect(await verifyAccessToken(shaped)).toBeNull();
  });

  it("refuses garbage rather than throwing at the caller", async () => {
    expect(await verifyAccessToken("not.a.jwt")).toBeNull();
    expect(await verifyAccessToken("")).toBeNull();
  });
});

// Buckets land in a readable table and reach the error register, so the identifier that
// keys a per-person cap goes in hashed — while an attacker farming sources still burns
// their own addresses, not somebody else's mailbox.
describe("identityBucket", () => {
  it("keys on the identity, not the shape it was typed in", () => {
    const a = identityBucket("forgot:mail", "  Fatuma.Juma@Waisha.Co.TZ ");
    expect(a).toBe(identityBucket("forgot:mail", "fatuma.juma@waisha.co.tz"));
    expect(a).toMatch(/^forgot:mail:[0-9a-f]{32}$/);
  });

  it("never puts the address or the token in the bucket", () => {
    const mail = identityBucket("forgot:mail", "fatuma.juma@waisha.co.tz");
    expect(mail.toLowerCase()).not.toContain("fatuma");
    expect(mail).not.toContain("@");
    const tok = identityBucket("reset:tok", "Ab40c9d2e1f-32byte-reset-token");
    expect(tok).not.toContain("reset-token");
  });

  it("keeps two surfaces in two buckets", () => {
    expect(identityBucket("forgot:mail", "a@b.co.tz"))
      .not.toBe(identityBucket("reset:tok", "a@b.co.tz"));
  });
});

// z.string().url() is not a scheme guard: javascript:, data: and vbscript: all parse. These
// two run on values a seeker reads out of the public marketplace.
describe("httpUrl — a stored address that must be safe to put in an anchor", () => {
  const ok = (v: string) => expect(httpUrl().safeParse(v).success, v).toBe(true);
  const no = (v: string) => expect(httpUrl().safeParse(v).success, v).toBe(false);

  it("takes a page address and nothing else", () => {
    ok("https://waisha.co.tz");
    ok("http://waisha.co.tz/pricing");
    ok("  https://waisha.co.tz  ");
    no("waisha.co.tz");
    no("javascript:alert(1)");
    no("data:text/html,<script>alert(1)</script>");
    no("vbscript:msgbox(1)");
    no("ftp://waisha.co.tz");
    no("file:///etc/passwd");
    no("");
  });

  it("holds its ceiling", () => {
    no(`https://waisha.co.tz/${"a".repeat(200)}`);
  });
});

describe("webAddress — the same rule, tolerant of the bare domain an office types", () => {
  const ok = (v: string) => expect(webAddress().safeParse(v).success, v).toBe(true);
  const no = (v: string) => expect(webAddress().safeParse(v).success, v).toBe(false);

  it("takes a bare domain or an http(s) address", () => {
    ok("waisha.co.tz");
    ok("Waisha.Co.TZ/pricing");
    ok("https://waisha.co.tz");
  });

  it("refuses any other scheme, written or not", () => {
    no("javascript:alert(document.cookie)");
    no("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==");
    no("mailto:someone@waisha.co.tz");
    no("about:blank");
    no("");
    no("   ");
    no("x".repeat(301));
  });
});

// A borrowed seat carries the worn person's roles, so every requirePermission in the API
// answers as it would for them — the wall that keeps the promise "it saves nothing" cannot
// live in a route, because forty-one route files repeat their own requireAuth and one of them
// forgetting is the bug. This is the second global preHandler, so these are its own rules.
describe("requireSupportReadonly — the write wall of a borrowed seat", () => {
  const req = (method: string, url: string, token: string, stash?: any) =>
    ({
      method, url,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(stash ? { authClaims: stash } : {})
    }) as any;

  /** Whatever the guard throws, or null when it let the request through. */
  const wall = async (r: any) => {
    try { await requireSupportReadonly(r); return null; }
    catch (e: any) { return e; }
  };

  it("mints a token that says somebody else is driving", async () => {
    expect(await verifyAccessToken(BORROWED)).toEqual({ ...GOOD, act: ACTOR });
    expect(claimsAreBorrowed(await verifyAccessToken(OWN))).toBe(false);
    expect(claimsAreBorrowed(await verifyAccessToken(BORROWED))).toBe(true);
  });

  for (const m of ["GET", "HEAD", "OPTIONS"])
    it(`lets ${m} through: the whole point of the view is to read`, async () => {
      expect(await wall(req(m, "/api/v1/clients", BORROWED))).toBeNull();
    });

  for (const m of ["POST", "PUT", "PATCH", "DELETE"])
    it(`refuses ${m} on a company table by name, with a 403 and a sentence`, async () => {
      const e = await wall(req(m, "/api/v1/clients/1f0a2b3c-4d5e-4a1b-9c8d-1e2f3a4b5c6d", BORROWED));
      expect(e?.code).toBe("SUPPORT_READONLY");
      expect(e?.statusCode).toBe(403);
      expect(String(e?.message)).toMatch(/saves nothing/);
    });

  it("leaves an ordinary seat's write alone — the wall is the mark, not the method", async () => {
    expect(await wall(req("POST", "/api/v1/clients", OWN))).toBeNull();
  });

  // The banner's "switch back" is a POST, and it runs on the desk's own cookie. A guard that
  // refused /control would trap the admin inside the view they came to leave.
  it("exempts the control surface, query string and all", async () => {
    expect(await wall(req("POST", "/api/v1/control/support/sessions/x/close", BORROWED))).toBeNull();
    expect(await wall(req("POST", "/api/v1/control/tenants/block?x=1", BORROWED))).toBeNull();
  });

  it("exempts the crash intake, because the crash worth collecting is the one on the call", async () => {
    expect(await wall(req("POST", "/api/v1/client-errors", BORROWED))).toBeNull();
  });

  it("reads the claims the audience hook already stashed rather than asking again", async () => {
    const e = await wall(req("POST", "/api/v1/clients", "", { ...GOOD, act: ACTOR }));
    expect(e?.code).toBe("SUPPORT_READONLY");
  });

  it("does not invent a support session out of a token it cannot verify", async () => {
    expect(await wall(req("POST", "/api/v1/clients", "not.a.jwt"))).toBeNull();
    expect(await wall(req("POST", "/api/v1/clients", ""))).toBeNull();
  });
});
