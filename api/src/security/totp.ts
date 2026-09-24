/**
 * RFC 6238 (TOTP) — self-contained implementation on node:crypto.
 * Correctness is pinned by api/tests/totp.test.ts against the published
 * RFC 4226 Appendix D test vectors. No third-party TOTP dependency:
 * the standard is small and frozen; the code is auditable line by line.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { toDataURL } from "qrcode";
import { hmacValue } from "../util/crypto.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DIGITS = 6;
const PERIOD_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character in secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP — dynamic truncation, 6 digits. Exported for RFC test vectors. */
export function hotpCode(base32Secret: string, counter: number): string {
  const key = base32Decode(base32Secret);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20)); // 160-bit secret — the standard strength
}

export async function enrollmentQr(email: string, secret: string): Promise<string> {
  const label = encodeURIComponent(`WAISHA Control:${email}`);
  const params = new URLSearchParams({
    secret, issuer: "WAISHA Control",
    algorithm: "SHA1", digits: String(DIGITS), period: String(PERIOD_SECONDS)
  });
  return toDataURL(`otpauth://totp/${label}?${params.toString()}`);
}

/** Verify the current code, tolerating ±1 period (30s) of clock drift. */
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const normalized = token.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(Date.now() / 1000 / PERIOD_SECONDS);
  for (let drift = -window; drift <= window; drift++) {
    const candidate = hotpCode(secret, counter + drift);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(normalized))) return true;
  }
  return false;
}

/** Recovery codes: 10 single-use; stored keyed-hashed, never plain. */
export function generateRecoveryCodes(count = 10): { plain: string[]; hashes: string[] } {
  const plain: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomBytes(5).toString("hex");
    plain.push(code);
    hashes.push(hmacValue(code));
  }
  return { plain, hashes };
}

export function hashRecoveryCode(code: string): string {
  return hmacValue(code.trim().toLowerCase());
}