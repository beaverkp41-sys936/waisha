import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { env, isProd } from "../env.js";

// The Supabase pooler serves a self-signed CA chain, so full verification
// needs a pinned CA: set DB_SSL_CA_FILE to the bundle on the deploy target.
// Without it we still encrypt, but cannot verify the chain — warn loudly.
const ssl = env.DB_SSL_CA_FILE
  ? { require: true, ca: readFileSync(env.DB_SSL_CA_FILE, "utf8") }
  : { rejectUnauthorized: false };
if (!env.DB_SSL_CA_FILE && isProd) {
  console.warn("[db] TLS certificate verification DISABLED — set DB_SSL_CA_FILE to the Supabase CA bundle");
}

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  ssl
});

/** Run inside one transaction with app.tenant_id set — RLS scopes every statement. */
export async function withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Transaction without tenant scope — pre-auth flows only (sign-up, OTP). */
export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}