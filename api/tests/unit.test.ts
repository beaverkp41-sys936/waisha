import { describe, it, expect } from "vitest";

// env must exist BEFORE project modules load (env.ts validates at import time),
// so project modules are imported dynamically after the env block.
process.env.JWT_SECRET ??= "x".repeat(32);
process.env.FIELD_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.SEARCH_HASH_KEY ??= "b".repeat(64);
process.env.DATABASE_URL ??= "postgres://unused";
process.env.WEB_ORIGIN ??= "http://localhost:3000";

const { validateTin } = await import("../src/security/tin.js");
const { passwordSchema } = await import("../src/security/password.js");
const { uuidv7 } = await import("../src/util/uuid.js");
const { encryptField, decryptField, searchHash } = await import("../src/util/crypto.js");

describe("TIN", () => {
  it("accepts 9 digits and formats", () => expect(validateTin("123456789")).toBe("123-456-789"));
  it("rejects short", () => expect(() => validateTin("12345")).toThrow());
});
describe("password policy", () => {
  it("requires all classes", () => {
    expect(passwordSchema.safeParse("Abcdefg1!x").success).toBe(true);
    expect(passwordSchema.safeParse("abcdefg1!x").success).toBe(false);
    expect(passwordSchema.safeParse("Abcdef1!x").success).toBe(false);
  });
});
describe("uuidv7", () => {
  it("has version 7 and variant bits", () => {
    const u = uuidv7();
    expect(u[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(u[19]);
  });
});
describe("field encryption", () => {
  it("roundtrips and search-hash is stable", () => {
    expect(decryptField(encryptField("+255712345678"))).toBe("+255712345678");
    expect(searchHash(" Foo@Bar.COM ")).toBe(searchHash("foo@bar.com"));
  });
});