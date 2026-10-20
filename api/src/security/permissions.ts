import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";

/**
 * Permission gate — the first consumer of the seeded role_permissions matrix.
 * The lookup is authoritative against the DB (JWT role keys are advisory only),
 * so role changes take effect immediately, not on next token refresh.
 *
 * Chain after requireAuth: { preHandler: [requireAuth, requirePermission("x.view")] }.
 * Directors pass every check — the seed grants the director role all keys.
 */

/** Check a permission on the caller's open transaction (for conditional rules). */
export async function checkPermission(c: PoolClient, userId: string, permissionKey: string): Promise<boolean> {
  const r = await c.query(
    `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now())
     limit 1`,
    [userId, permissionKey]);
  return !!r.rowCount;
}

/**
 * Several duties in one lookup, for a surface that has to ask about all of them at once.
 *
 * Asking separately is one round trip per key, and against a pooler on another continent that
 * is how a desk which reads its own rows in a second spends fifteen waiting for its buttons.
 */
export async function checkPermissions(
  c: PoolClient, userId: string, permissionKeys: string[]
): Promise<Set<string>> {
  if (!permissionKeys.length) return new Set();
  const r = await c.query(
    `select distinct rp.permission_key from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = any($2::text[])
       and (ur.expires_at is null or ur.expires_at > now())`,
    [userId, permissionKeys]);
  return new Set(r.rows.map((row: any) => row.permission_key as string));
}

export function requirePermission(permissionKey: string) {
  return async (req: FastifyRequest & { user?: { sub: string; tid: string } }) => {
    if (!req.user?.sub || !req.user?.tid) {
      throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
    }
    const userId = req.user.sub;
    const tid = req.user.tid;
    const ok = await withTenant(tid, (c) => checkPermission(c, userId, permissionKey));
    if (!ok) {
      throw new ApiError("FORBIDDEN", "Your role does not allow this action.", 403);
    }
  };
}
