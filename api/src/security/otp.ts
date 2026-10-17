import { randomInt } from "node:crypto";
import { hmacValue } from "../util/crypto.js";

export const OTP_TTL_MINUTES = 5;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_LOCKOUT_MINUTES = 15;

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashOtp(code: string): string {
  return hmacValue(code);
}

export function maskPhone(e164: string): string {
  return e164.length <= 4 ? "***" : `+${"*".repeat(e164.length - 4)}${e164.slice(-3)}`;
}

/** Keep the local part's first character and the whole domain, so the verify panel
 * can say "a***@example.co.tz" without echoing a full address back to a caller who
 * may not own it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}${"*".repeat(Math.max(1, at - 1))}${email.slice(at)}`;
}