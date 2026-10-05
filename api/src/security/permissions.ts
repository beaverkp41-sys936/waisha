import type { FastifyRequest } from "fastify";
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
export function requirePermission(permissionKey: string) {
  return async (req: FastifyRequest & { user?: { sub: string; tid: string } }) => {
    if (!req.user?.sub || !req.user?.tid) {
      throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
    }
    const userId = req.user.sub;
    const tid = req.user.tid;
    const r = await withTenant(tid, (c) => c.query(
      `select 1 from user_roles ur
       join role_permissions rp on rp.role_id = ur.role_id
       where ur.user_id = $1 and rp.permission_key = $2
         and (ur.expires_at is null or ur.expires_at > now())
       limit 1`,
      [userId, permissionKey]));
    if (!r.rowCount) {
      throw new ApiError("FORBIDDEN", "Your role does not allow this action.", 403);
    }
  };
}
