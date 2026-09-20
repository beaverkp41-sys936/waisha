import { env } from "../env.js";
import { ApiError } from "../util/errors.js";

export function normalizeTin(input: string): string {
  return input.replace(/\D/g, "");
}

export function formatTin(digits: string): string {
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 9)}`;
}

export function validateTin(input: string): string {
  const digits = normalizeTin(input);
  if (!/^\d{9}$/.test(digits)) {
    throw new ApiError("VALIDATION_FAILED", "TIN must be 9 digits", 400,
      [{ field: "tin", message: "Expected NNN-NNN-NNN" }]);
  }
  if (env.TIN_CHECKSUM_MODE === "strict") {
    throw new ApiError("CONFIG", "Strict TIN checksum requested but TRA weights are not registered", 500);
  }
  return formatTin(digits);
}