import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, searchHash, sha256, randomToken } from "../util/crypto.js";
import { hashPassword } from "../security/argon2.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { sendMail } from "../mail/mail.js";
import { inviteEmail } from "../mail/templates.js";
import { env } from "../env.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

const inviteSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  phone: e164.nullable().optional(),
  roleKeys: z.array(z.string().trim().min(1).max(40)).min(1).max(5)
});

const editSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: e164.nullable().optional(),
  jobTitle: z.string().trim().max(80).nullable().optional(),
  roleKeys: z.array(z.string().trim().min(1).max(40)).min(1).max(5).optional()
});

// Self-service: a member maintains their own profile, never their roles.
const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: e164.nullable().optional(),
  jobTitle: z.string().trim().max(80).nullable().optional()
});

const statusSchema = z.object({
  status: z.enum(["active", "deactivated"])
});

const INVITE_TTL_DAYS = 7;
// Transporter-office roles offered for assignment. Platform roles
// (super_admin, billing_admin, …) and field roles without portal logins are
// deliberately excluded — allowlist, not denylist, so future platform seeds
// don't leak into the tenant form.
const ASSIGNABLE_ROLES = [
  "director", "general_manager", "operations_manager", "fleet_manager",
  "finance_officer", "dispatcher", "checkpoint_clerk", "hr_officer",
  "workshop_manager", "customer_service", "auditor"
];

async function validateRoleKeys(c: any, roleKeys: string[]) {
  const unknown = roleKeys.filter((k) => !ASSIGNABLE_ROLES.includes(k));
  if (unknown.length) {
    throw new ApiError("VALIDATION_FAILED", `Unknown role: ${unknown.join(", ")}`, 400,
      unknown.map((k) => ({ field: "roleKeys", message: `Unknown role ${k}` })));
  }
  const found = await c.query(
    `select key from roles where tenant_id is null and key = any($1) and is_system`,
    [roleKeys]);
  const known = new Set(found.rows.map((r: any) => r.key));
  const missing = roleKeys.filter((k) => !known.has(k));
  if (missing.length) {
    throw new ApiError("VALIDATION_FAILED", `Unknown role: ${missing.join(", ")}`, 400,
      missing.map((k) => ({ field: "roleKeys", message: `Unknown role ${k}` })));
  }
}

async function listRoleKeys(c: any, userId: string): Promise<string[]> {
  const r = await c.query(
    `select r.key from user_roles ur join roles r on r.id = ur.role_id
     where ur.user_id = $1 and (ur.expires_at is null or ur.expires_at > now())
     order by r.name`,
    [userId]);
  return r.rows.map((x: any) => x.key);
}

/** Portal seat counting: directors and staff on the roster, deleted excluded. */
async function countSeats(c: any, tid: string): Promise<number> {
  const r = await c.query(
    `select count(*)::int as n from users
     where tenant_id = $1 and deleted_at is null and user_type in ('director','staff')`,
    [tid]);
  return r.rows[0].n;
}

export async function usersRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- List (with seat counter) ----------
  app.get("/users", { preHandler: [requireAuth, requirePermission("users.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select u.id, u.full_name, u.email, u.status, u.user_type, u.job_title,
                u.last_login_at, u.created_at,
                (select d.id from documents d
                  where d.entity_type = 'user' and d.entity_id = u.id
                    and d.kind = 'avatar' and d.deleted_at is null
                  order by d.created_at desc limit 1) as avatar_document_id,
                coalesce((select json_agg(json_build_object('key', r.key, 'name', r.name)
                            order by r.name)
                          from user_roles ur join roles r on r.id = ur.role_id
                          where ur.user_id = u.id
                            and (ur.expires_at is null or ur.expires_at > now())),
                         '[]'::json) as roles
         from users u
         where u.tenant_id = $1 and u.deleted_at is null
           and u.user_type in ('director','staff')
         order by u.created_at`, [req.user.tid]));

      const licence = await pool.query("select platform_auth.get_licence($1) as l", [req.user.tid]);
      const seatsLicensed = Number(licence.rows[0]?.l?.seats_licensed ?? 0);
      return {
        users: rows,
        seatLimit: seatsLicensed > 0 ? seatsLicensed : null,
        seatsUsed: rows.length
      };
    });

  // ---------- Roles for the assignment form ----------
  app.get("/roles", { preHandler: [requireAuth] }, async () => {
    const { rows } = await pool.query(
      `select key, name from roles
       where tenant_id is null and is_system and key = any($1::text[])
       order by name`,
      [ASSIGNABLE_ROLES]);
    return rows;
  });

  // ---------- Invite (creates the user + role grants + accept token) ----------
  app.post("/users", { preHandler: [requireAuth, requirePermission("users.create")] },
    async (req: any, reply) => {
      // Each invite mints a live accept link and posts an email. The ceiling is a flood
      // brake, not an onboarding limit — a director staffing a new office by hand has to
      // stay well inside it.
      await enforceRateLimit(`invite:uid:${req.user.sub}`, 40, 3600);
      const body = inviteSchema.parse(req.body);

      const licence = await pool.query("select platform_auth.get_licence($1) as l", [req.user.tid]);
      const seatsLicensed = Number(licence.rows[0]?.l?.seats_licensed ?? 0);

      const id = uuidv7();
      let tenantName = "your company";
      let inviteUrl = "";
      try {
        await withTenant(req.user.tid, async (c) => {
          const seats = await countSeats(c, req.user.tid);
          if (seatsLicensed > 0 && seats >= seatsLicensed) {
            throw new ApiError("TRIAL_LIMIT",
              `Your licence covers ${seatsLicensed} ${seatsLicensed === 1 ? "user" : "users"}. ` +
              `Deactivate someone or upgrade the plan to invite more.`,
              403);
          }
          const dup = await c.query(
            `select id from users where tenant_id = $1 and email_normalized_search = $2
             and deleted_at is null`,
            [req.user.tid, searchHash(body.email)]);
          if (dup.rowCount) {
            throw new ApiError("CONFLICT", "This email is already in use in your organisation.", 409);
          }
          const tname = await c.query("select name from tenants where id = $1", [req.user.tid]);
          tenantName = tname.rows[0]?.name ?? tenantName;

          await validateRoleKeys(c, body.roleKeys);

          await c.query(
            `insert into users (id, tenant_id, user_type, email, email_normalized_search,
               phone_encrypted, phone_search, password_hash, status, full_name)
             values ($1,$2,'staff',$3,$4,$5,$6,$7,'pending_verification',$8)`,
            [id, req.user.tid, body.email, searchHash(body.email),
             body.phone ? encryptField(body.phone) : null,
             body.phone ? searchHash(body.phone) : null,
             // Unusable until the invite is accepted: nobody knows this preimage.
             await hashPassword(randomToken(32)), body.fullName]);
          await c.query(
            `insert into user_roles (user_id, role_id, granted_by)
             select $1, id, $3 from roles where tenant_id is null and key = any($2)`,
            [id, body.roleKeys, req.user.sub]);

          const token = randomToken(32);
          await c.query(
            `insert into password_resets (id, user_id, tenant_id, token_hash, expires_at)
             values ($1,$2,$3,$4, now() + interval '${INVITE_TTL_DAYS} days')`,
            [uuidv7(), id, req.user.tid, sha256(token)]);
          inviteUrl = `${env.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;

          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "users", entityId: id,
            action: "staff.invited",
            after: { email: body.email, roles: body.roleKeys, expiresDays: INVITE_TTL_DAYS }
          });
        });
      } catch (e: any) {
        if (e.code === "23505") {
          throw new ApiError("CONFLICT", "This email is already registered on WAISHA.", 409);
        }
        throw e;
      }

      // Convenience copy only — the accept URL is returned to the director regardless, so a
      // mail outage never blocks onboarding. It is still reported: a director who cannot see
      // that the invite did not go out will wait for an email instead of sending the link.
      const invite = await sendMail(
        inviteEmail(body.email, { fullName: body.fullName, tenantName, url: inviteUrl, days: INVITE_TTL_DAYS }),
        { purpose: "staff_invite", tenantId: req.user.tid, userId: id });

      return reply.status(201).send({ id, inviteUrl, mailSent: invite.delivered });
    });

  // ---------- Self-service profile (no roles, no permission needed) ----------
  app.put("/users/me/profile", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const body = profileSchema.parse(req.body);
    const uid = req.user.sub;

    await withTenant(req.user.tid, async (c) => {
      if (body.fullName) {
        await c.query(
          `update users set full_name = $2, updated_by = $2, updated_at = now()
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [uid, body.fullName, req.user.tid]);
      }
      if ("phone" in body) {
        await c.query(
          `update users set phone_encrypted = $2, phone_search = $3,
             updated_by = $1, updated_at = now()
           where id = $1 and tenant_id = $4 and deleted_at is null`,
          [uid,
           body.phone != null ? encryptField(body.phone) : null,
           body.phone != null ? searchHash(body.phone) : null,
           req.user.tid]);
      }
      if ("jobTitle" in body) {
        await c.query(
          `update users set job_title = $2, updated_by = $1, updated_at = now()
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [uid, body.jobTitle ?? null, req.user.tid]);
      }
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: uid, ip: req.ip,
        requestId: req.requestId, entity: "users", entityId: uid,
        action: "profile.updated",
        after: { fullName: body.fullName ?? null, jobTitle: body.jobTitle ?? null }
      });
    });
    return reply.send({ ok: true });
  });

  // ---------- Edit (name and role set) ----------
  app.put("/users/:id", { preHandler: [requireAuth, requirePermission("users.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = editSchema.parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const target = await c.query(
          `select id, status from users where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!target.rowCount) throw new ApiError("NOT_FOUND", "Staff member not found", 404);
        if (id === req.user.sub) {
          throw new ApiError("CONFLICT", "Use the Account page for your own profile.", 409);
        }
        if (target.rows[0].status === "deactivated") {
          throw new ApiError("CONFLICT", "Reactivate this member before editing.", 409);
        }

        if (body.fullName) {
          await c.query(
            `update users set full_name = $2, updated_by = $3, updated_at = now()
             where id = $1 and tenant_id = $4 and deleted_at is null`,
            [id, body.fullName, req.user.sub, req.user.tid]);
        }
        if ("phone" in body) {
          await c.query(
            `update users set phone_encrypted = $2, phone_search = $3,
               updated_by = $4, updated_at = now()
             where id = $1 and tenant_id = $5 and deleted_at is null`,
            [id,
             body.phone != null ? encryptField(body.phone) : null,
             body.phone != null ? searchHash(body.phone) : null,
             req.user.sub, req.user.tid]);
        }
        if ("jobTitle" in body) {
          await c.query(
            `update users set job_title = $2, updated_by = $3, updated_at = now()
             where id = $1 and tenant_id = $4 and deleted_at is null`,
            [id, body.jobTitle ?? null, req.user.sub, req.user.tid]);
        }

        if (body.roleKeys) {
          const before = await listRoleKeys(c, id);
          await validateRoleKeys(c, body.roleKeys);
          await c.query("delete from user_roles where user_id = $1", [id]);
          await c.query(
            `insert into user_roles (user_id, role_id, granted_by)
             select $1, id, $3 from roles where tenant_id is null and key = any($2)`,
            [id, body.roleKeys, req.user.sub]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "users", entityId: id,
            action: "staff.roles_changed",
            before: { roles: before }, after: { roles: body.roleKeys }
          });
        }
      });
      return reply.send({ ok: true });
    });

  // ---------- Status (activate / deactivate) ----------
  app.put("/users/:id/status", { preHandler: [requireAuth, requirePermission("users.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = statusSchema.parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const target = await c.query(
          `select id, status, user_type from users where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!target.rowCount) throw new ApiError("NOT_FOUND", "Staff member not found", 404);
        const prev = target.rows[0].status;
        if (id === req.user.sub) {
          throw new ApiError("CONFLICT", "You cannot change your own status.", 409);
        }
        if (prev === body.status) return; // caller sees { ok: true }
        if (body.status === "active" && prev === "pending_verification") {
          throw new ApiError("CONFLICT",
            "This member has not accepted their invite yet — resend it instead.", 409);
        }

        await c.query(
          `update users set status = $2, updated_by = $3, updated_at = now()
           where id = $1 and tenant_id = $4 and deleted_at is null`,
          [id, body.status, req.user.sub, req.user.tid]);
        if (body.status === "deactivated") {
          await c.query(
            `update sessions set revoked_at = now(), revoked_reason = 'deactivated'
             where user_id = $1 and revoked_at is null`, [id]);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "users", entityId: id,
          action: "staff.status_changed",
          before: { status: prev }, after: { status: body.status }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Reinvite (fresh accept link) ----------
  app.post("/users/:id/reinvite", { preHandler: [requireAuth, requirePermission("users.create")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      // A reinvite retires every outstanding link for that seat and issues a new one, so
      // it needs its own count: repeated here is not merely noisy, it invalidates the
      // link the invitee may be about to click.
      await enforceRateLimit(`reinvite:uid:${req.user.sub}`, 20, 3600);

      let inviteUrl = "";
      let mailSent = false;
      await withTenant(req.user.tid, async (c) => {
        const target = await c.query(
          `select u.id, u.status, u.email, u.full_name, t.name as tenant_name
             from users u join tenants t on t.id = u.tenant_id
            where u.id = $1 and u.tenant_id = $2 and u.deleted_at is null`,
          [id, req.user.tid]);
        if (!target.rowCount) throw new ApiError("NOT_FOUND", "Staff member not found", 404);
        if (target.rows[0].status !== "pending_verification") {
          throw new ApiError("CONFLICT", "This member already accepted their invite.", 409);
        }

        const token = randomToken(32);
        await c.query(
          `update password_resets set used_at = now() where user_id = $1 and used_at is null`,
          [id]);
        await c.query(
          `insert into password_resets (id, user_id, tenant_id, token_hash, expires_at)
           values ($1,$2,$3,$4, now() + interval '${INVITE_TTL_DAYS} days')`,
          [uuidv7(), id, req.user.tid, sha256(token)]);
        inviteUrl = `${env.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "users", entityId: id,
          action: "staff.reinvited", after: { email: target.rows[0].email }
        });

        const resent = await sendMail(
          inviteEmail(target.rows[0].email, {
            fullName: target.rows[0].full_name ?? "",
            tenantName: target.rows[0].tenant_name, url: inviteUrl, days: INVITE_TTL_DAYS
          }),
          { purpose: "staff_invite", tenantId: req.user.tid, userId: id });
        mailSent = resent.delivered;
      });
      return reply.send({ ok: true, inviteUrl, mailSent });
    });
}
