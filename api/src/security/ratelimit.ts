import { pool } from "../db/pool.js";
import { ApiError } from "../util/errors.js";

/** Fixed-window limiter backed by Postgres (atomic). Throws 429 when exceeded. */
export async function enforceRateLimit(bucket: string, limit: number, windowSeconds: number) {
  const { rows } = await pool.query(
    "select platform_auth.hit_rate_limit($1, $2, make_interval(secs => $3)) as allowed",
    [bucket, limit, windowSeconds]
  );
  if (!rows[0].allowed) {
    throw new ApiError("RATE_LIMITED", "Too many attempts. Please wait and try again.", 429);
  }
}