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