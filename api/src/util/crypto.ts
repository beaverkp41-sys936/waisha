import {
  createCipheriv, createDecipheriv, createHmac,
  createHash, randomBytes, timingSafeEqual
} from "node:crypto";
import { env } from "../env.js";

const fieldKey = Buffer.from(env.FIELD_ENCRYPTION_KEY, "hex");
const searchKey = Buffer.from(env.SEARCH_HASH_KEY, "hex");

/** AES-256-GCM field-level encryption. Output layout: iv(12) | authTag(16) | ciphertext. */
export function encryptField(plain: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fieldKey, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptField(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = createDecipheriv("aes-256-gcm", fieldKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** Keyed hash for case-insensitive lookup on encrypted columns. */
export function searchHash(value: string): string {
  return createHmac("sha256", searchKey).update(value.trim().toLowerCase()).digest("hex");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacValue(value: string): string {
  return createHmac("sha256", searchKey).update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}