import { Pool, type PoolClient } from "pg";
import { env } from "../env.js";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  ssl: { rejectUnauthorized: false } // Supabase pooler; CA pinning lands in the hardening phase
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