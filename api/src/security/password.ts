import { createHash } from "node:crypto";
import { z } from "zod";

export const passwordSchema = z.string()
  .min(10, "At least 10 characters")
  .regex(/[A-Z]/, "Needs an uppercase letter")
  .regex(/[a-z]/, "Needs a lowercase letter")
  .regex(/[0-9]/, "Needs a digit")
  .regex(/[^A-Za-z0-9]/, "Needs a symbol");

/** HIBP k-anonymity check. Fails closed: an outage blocks signup rather than weakening it. */
export async function pwnedCount(password: string): Promise<number> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const res = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
    headers: { "Add-Padding": "true" },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error("HIBP unavailable");
  const body = await res.text();
  for (const line of body.split("\n")) {
    const [suffix, count] = line.trim().split(":");
    if (suffix === sha1.slice(5)) return parseInt(count, 10);
  }
  return 0;
}