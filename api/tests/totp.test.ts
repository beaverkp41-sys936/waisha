import { describe, it, expect } from "vitest";

process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const { hotpCode, verifyTotp, generateTotpSecret } = await import("../src/security/totp.js");

// Canonical vectors: RFC 4226 Appendix D (secret = ASCII "12345678901234567890").
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP (RFC 6238)", () => {
  it("matches the published RFC 4226 HOTP vectors", () => {
    expect(hotpCode(RFC_SECRET, 0)).toBe("755224");
    expect(hotpCode(RFC_SECRET, 1)).toBe("287082");
    expect(hotpCode(RFC_SECRET, 2)).toBe("359152");
    expect(hotpCode(RFC_SECRET, 3)).toBe("969429");
    expect(hotpCode(RFC_SECRET, 4)).toBe("338314");
    expect(hotpCode(RFC_SECRET, 8)).toBe("399871");
  });

  it("verifies the live code, tolerates ±1 period, rejects outside window", () => {
    const secret = generateTotpSecret();
    const counter = Math.floor(Date.now() / 1000 / 30);
    expect(verifyTotp(secret, hotpCode(secret, counter))).toBe(true);
    expect(verifyTotp(secret, hotpCode(secret, counter - 1))).toBe(true);   // drift back
    expect(verifyTotp(secret, hotpCode(secret, counter + 5))).toBe(false);  // far future
    expect(verifyTotp(secret, "abc")).toBe(false);                          // malformed
  });
});