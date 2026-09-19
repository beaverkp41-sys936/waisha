export const VESSEL_STATUSES = ["on_route", "standby", "booked", "in_garage", "out_of_service"] as const;
export const TENANT_STATUSES = ["pending_verification", "trial", "active", "grace", "expired", "suspended"] as const;
export const USER_STATUSES = ["pending_verification", "active", "suspended", "deactivated"] as const;
export const LOCALES = ["en", "sw"] as const;
export type Locale = (typeof LOCALES)[number];
export const API_ERROR_CODES = [
  "VALIDATION_FAILED", "INVALID_CREDENTIALS", "ACCOUNT_LOCKED", "OTP_EXPIRED",
  "OTP_INVALID", "OTP_LOCKED", "TOKEN_EXPIRED", "TOKEN_REUSE", "PENDING_VERIFICATION",
  "RATE_LIMITED", "EMAIL_NOT_FOUND_NEUTRAL", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "INTERNAL"
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];