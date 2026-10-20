import { pool } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { sha256 } from "../util/crypto.js";

/** Fixed-window limiter backed by Postgres (atomic). Throws 429 when exceeded. */
export async function enforceRateLimit(bucket: string, limit: number, windowSeconds: number) {
  const { rows } = await pool.query(
    "select platform_auth.hit_rate_limit($1, $2, make_interval(secs => $3)) as allowed",
    [bucket, limit, windowSeconds]
  );
  if (!rows[0].allowed) {
    // platform_auth.hit_rate_limit aligns its window to the epoch (001), so the instant this
    // bucket empties is computable here and the person can be told when. "Please wait and try
    // again" with no number is how a blocked office reads a limiter as a broken product: they
    // retry immediately, burn the next window on refusals, and give up.
    const waitSeconds = windowSeconds - Math.floor(Date.now() / 1000) % windowSeconds;
    const when = waitSeconds >= 120
      ? `${Math.round(waitSeconds / 60)} minutes`
      : `${Math.max(waitSeconds, 10)} seconds`;
    throw new ApiError("RATE_LIMITED",
      `Too many attempts from here. You can try again in about ${when}.`, 429,
      [{ retryIn: waitSeconds }]);
  }
}

/**
 * A bucket keyed on something the caller typed.
 *
 * An IP-only ceiling is a per-attacker ceiling: with a handful of source addresses,
 * every cap here scales linearly, so one victim's account is still grindable. The fix
 * is a second bucket on the *target* — but the target is an email address or a reset
 * token, and `rate_limits` is a plain readable table whose buckets end up in the error
 * register and the anomaly feed. So the identifier goes in hashed and truncated: stable
 * enough to count, useless enough to leak.
 */
export function identityBucket(prefix: string, identifier: string): string {
  return `${prefix}:${sha256(identifier.trim().toLowerCase()).slice(0, 32)}`;
}
