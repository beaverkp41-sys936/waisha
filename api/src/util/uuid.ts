import { randomBytes } from "node:crypto";

/** RFC 9562 UUID v7 — 48-bit unix-ms timestamp + random bits. */
export function uuidv7(): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Date.now(), 0, 6);   // 48-bit unix ms in bytes 0-5 (safe until year ~89000)
  randomBytes(10).copy(bytes, 6);        // random bits in bytes 6-15
  bytes[6] = (bytes[6] & 0x0f) | 0x70;   // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // RFC variant
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}