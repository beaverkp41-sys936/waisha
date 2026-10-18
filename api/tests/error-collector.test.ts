import { describe, it, expect } from "vitest";

// env must exist BEFORE project modules load (env.ts validates at import time),
// so project modules are imported dynamically after the env block.
process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const { normalisePath, scrub, fingerprintOf } = await import("../src/security/error-record.js");

// The register is read by whoever opens the error desk, and it is written from inside a
// failure path that cannot afford to throw. These three functions decide both of the
// properties that matter — one bug one line, and no contact details in the line — and
// neither is something the database is able to complain about.
describe("error register path normalisation", () => {
  it("collapses id-shaped segments so a route groups instead of exploding", () => {
    expect(normalisePath("/api/v1/cargo/41780/docs")).toBe("/api/v1/cargo/:id/docs");
    expect(normalisePath("/api/v1/cargo/1f0a2b3c-4d5e-4a1b-9c8d-1e2f3a4b5c6d"))
      .toBe("/api/v1/cargo/:id");
    expect(normalisePath("/api/v1/x/deadbeefdeadbeef1234")).toBe("/api/v1/x/:id");
  });
  it("drops the query and the fragment, which carry parameters and never a place", () => {
    expect(normalisePath("/api/v1/booking?tin=987654321#after")).toBe("/api/v1/booking");
  });
  it("leaves a word that happens to contain digits alone", () => {
    expect(normalisePath("/api/v1/control/tenants/policy/idle"))
      .toBe("/api/v1/control/tenants/policy/idle");
  });
  it("clamps to the column's ceiling", () =>
    expect(normalisePath("/" + "z".repeat(900)).length).toBe(300));
});

describe("error register scrub", () => {
  const pii = scrub(
    "seat ada@alpha.co.tz phone +255712345678 alt 0765432198 nida 198765432 "
    + "bearer abcdef123456 password: hunter2secret token=eyJhbGciOiJIU api_key: k-9988776655",
    500) ?? "";

  it("removes addresses, MSISDNs, long digit runs and credential values", () => {
    for (const leak of ["ada@alpha.co.tz", "255712345678", "0765432198", "198765432",
      "abcdef123456", "hunter2secret", "eyJhbGciOiJIU", "k-9988776655"]) {
      expect(pii).not.toContain(leak);
    }
  });
  it("keeps the sentence readable, with the masks where the secrets were", () => {
    expect(pii).toContain("e***@masked");
    expect(pii).toContain("+255*******");
    expect(pii).toContain("0*******");
    expect(pii).toContain("###########");
    expect(pii).toContain("password: ***");
    expect(pii).toContain("token=***");
    expect(pii).toContain("api_key: ***");
    expect(pii).toContain("bearer ***");
  });
  it("masks an address on a dotted domain whole, TLD and all", () => {
    expect(scrub("charge failed for ada@alpha.co.tz", 200)).toBe("charge failed for e***@masked");
  });
  it("does not mask a credential WORD alone, so prose still reads as prose", () => {
    expect(scrub("the refresh token is missing for this seat", 200))
      .toBe("the refresh token is missing for this seat");
  });
  it("drops control characters but keeps a stack's newlines and tabs", () => {
    expect(scrub("a\u0000b\u0007c\nd\te", 100)).toBe("a b c\nd\te");
  });
  it("clamps to the caller's ceiling and treats empty as null", () => {
    expect((scrub("x".repeat(900), 500) ?? "").length).toBe(500);
    expect(scrub("", 500)).toBeNull();
    expect(scrub(null, 500)).toBeNull();
  });
});

describe("error register fingerprint", () => {
  const at = (message: string, rest = {}) =>
    fingerprintOf({ kind: "server", message, route: "/api/v1/cargo/:id", status: 500,
      code: "INTERNAL", ...rest });

  it("is the same line for the same bug at a different id", () => {
    expect(at("lock timeout on row 41")).toBe(at("lock timeout on row 77"));
  });
  it("is the same line when the message quotes two different seats", () => {
    expect(at("column user_id is missing for 2f4a1b6c-7d8e-4a1b-9c8d-1e2f3a4b5c6d"))
      .toBe(at("column user_id is missing for 9a8b7c6d-5e4f-4013-a2b1-0f1e2d3c4b5a"));
  });
  it("is a different line for a different sentence, kind, status or code", () => {
    expect(at("lock timeout")).not.toBe(at("connection reset"));
    expect(at("lock timeout")).not.toBe(at("lock timeout", { kind: "client" }));
    expect(at("lock timeout")).not.toBe(at("lock timeout", { status: 503 }));
    expect(at("lock timeout")).not.toBe(at("lock timeout", { code: "TIMEOUT" }));
    expect(at("lock timeout")).not.toBe(
      fingerprintOf({ kind: "server", message: "lock timeout", path: "/api/v1/drivers",
        status: 500, code: "INTERNAL" }));
  });
  it("gives one bug one line only if the key is built from the scrubbed text", () => {
    const a = scrub("charge failed for ada@alpha.co.tz", 500);
    const b = scrub("charge failed for ben@bravo.co.tz", 500);
    expect(at(a ?? "")).toBe(at(b ?? ""));
    expect(at("charge failed for ada@alpha.co.tz"))
      .not.toBe(at("charge failed for ben@bravo.co.tz"));
  });
  it("is 32 lowercase hex characters", () => {
    expect(at("anything")).toMatch(/^[0-9a-f]{32}$/);
  });
});
