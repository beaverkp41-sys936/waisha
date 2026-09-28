import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { searchHash, sha256, randomToken } from "../util/crypto.js";
import { hashPassword, verifyPassword } from "../security/argon2.js";
import { passwordSchema, pwnedCount } from "../security/password.js";
import {
  generateTotpSecret, enrollmentQr, verifyTotp,
  generateRecoveryCodes, hashRecoveryCode
} from "../security/totp.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";

const CONTROL_COOKIE = "waisha_control";
const isProd = process.env.NODE_ENV === "production";

function setControlCookie(reply: FastifyReply, token: string) {
  reply.setCookie(CONTROL_COOKIE, token, {
    httpOnly: true, secure: isProd, sameSite: "strict",
    path: "/api/v1/control", maxAge: 2 * 3600 // 2h absolute; hardened per spec 8
  });
}
function clearControlCookie(reply: FastifyReply) {
  reply.clearCookie(CONTROL_COOKIE, { path: "/api/v1/control" });
}

async function requireControl(req: any) {
  const token = req.cookies[CONTROL_COOKIE];
  if (!token) throw new ApiError("TOKEN_EXPIRED", "Control sign-in required", 401);
  const r = await pool.query("select platform_auth.get_control_session($1) as s", [sha256(token)]);
  const s = r.rows[0]?.s;
  if (!s || new Date(s.expires_at) < new Date()) throw new ApiError("TOKEN_EXPIRED", "Control sign-in required", 401);
  req.control = s;
}

function hasLicenceRole(roles: string[] | undefined): boolean {
  return !!roles && (roles.includes("super_admin") || roles.includes("billing_admin"));
}

export async function controlRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Step 1: password ----------
  app.post("/control/auth/login", async (req: any, reply) => {
    await enforceRateLimit(`control:ip:${req.ip}`, 5, 900);
    const { email, password } = z.object({
      email: z.string().trim().toLowerCase().email(),
      password: z.string().min(1)
    }).parse(req.body);

    const u = await pool.query("select platform_auth.lookup_platform_login($1) as u",
      [searchHash(email)]);
    const user = u.rows[0].u;
    if (!user) {
      await new Promise(r => setTimeout(r, 600));
      throw new ApiError("INVALID_CREDENTIALS", "Invalid credentials", 401);
    }
    await enforceRateLimit(`control:uid:${user.user_id}`, 5, 900);
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw new ApiError("ACCOUNT_LOCKED", "Account temporarily locked.", 423);
    }
    const ok = user.password_hash && await verifyPassword(user.password_hash, password);
    if (!ok) {
      await withTenant(user.tenant_id, (c) => c.query(
        `update users set failed_login_count = failed_login_count + 1,
           locked_until = case when failed_login_count + 1 >= 5
             then now() + least(make_interval(mins => (15 * power(2, least(lockout_count, 9)))::int), interval '24 hours')
             else locked_until end
         where id = $1`, [user.user_id]));
      throw new ApiError("INVALID_CREDENTIALS", "Invalid credentials", 401);
    }
    if (user.status !== "active") throw new ApiError("FORBIDDEN", "Account not active.", 403);

    // Password OK. Issue a short-lived "pending TOTP" challenge token.
    const challenge = randomToken(32);
    await withTenant(user.tenant_id, (c) => c.query(
      `insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
         refresh_token_hash, user_agent, ip, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now() + interval '10 minutes')`,
      [uuidv7(), user.user_id, user.tenant_id, uuidv7(),
       new Date(Date.now() + 10 * 60 * 1000), sha256(challenge),
       req.headers["user-agent"] ?? null, req.ip ?? null]));

    return reply.send({
      challengeToken: challenge,
      totpEnabled: user.totp_enabled,
      email: user.full_name ?? email
    });
  });

  // ---------- Step 2a: TOTP enrollment (forced when totpEnabled=false) ----------
  app.post("/control/auth/totp/setup", async (req: any, reply) => {
    const { challengeToken } = z.object({ challengeToken: z.string().min(10) }).parse(req.body);
    const s = await pool.query("select platform_auth.get_control_session($1) as s", [sha256(challengeToken)]);
    const sess = s.rows[0]?.s;
    if (!sess || new Date(sess.expires_at) < new Date()) throw new ApiError("TOKEN_EXPIRED", "Challenge expired - sign in again", 401);

    const secret = generateTotpSecret();
    await withTenant(sess.tenant_id, async (c) => {
      const enc = (await import("../util/crypto.js")).encryptField(secret);
      await c.query("update users set totp_secret_encrypted=$2 where id=$1", [sess.user_id, enc]);
      await writeAudit(c, {
        tenantId: sess.tenant_id, actorUserId: sess.user_id, ip: req.ip,
        requestId: req.requestId, entity: "users", entityId: sess.user_id,
        action: "control.totp.setup_initiated"
      });
    });
    const qr = await enrollmentQr(sess.email ?? "", secret);
    return reply.send({ qrDataUrl: qr });
  });

  // ---------- Step 2b: confirm enrollment OR verify on every login ----------
  app.post("/control/auth/totp/verify", async (req: any, reply) => {
    await enforceRateLimit(`control-totp:ip:${req.ip}`, 10, 900);
    const { challengeToken, code } = z.object({
      challengeToken: z.string().min(10),
      code: z.string().min(6).max(20)
    }).parse(req.body);

    const s = await pool.query("select platform_auth.get_control_session($1) as s", [sha256(challengeToken)]);
    const sess = s.rows[0]?.s;
    if (!sess || new Date(sess.expires_at) < new Date()) throw new ApiError("TOKEN_EXPIRED", "Challenge expired - sign in again", 401);

    // RLS-safe read: the secret fetch needs the tenant context (production runs
    // as the restricted role; a context-less read returns zero rows).
    const u = await withTenant(sess.tenant_id, (c) => c.query(
      "select totp_secret_encrypted from users where id=$1", [sess.user_id]));
    if (!u.rows[0]) {
      // Fail closed: with the tenant context set, an empty read means the
      // session and the user no longer align - force a fresh sign-in.
      throw new ApiError("TOKEN_EXPIRED", "Challenge expired - sign in again", 401);
    }
    const secret = (await import("../util/crypto.js"))
      .decryptField(Buffer.from(u.rows[0].totp_secret_encrypted));

    const usingRecovery = code.trim().length > 6;
    let verified = false;
    if (usingRecovery) {
      const rh = hashRecoveryCode(code);
      const r = await withTenant(sess.tenant_id, (c) => c.query(
        `update recovery_codes set used_at=now()
         where user_id=$1 and code_hash=$2 and used_at is null
         returning id`, [sess.user_id, rh]));
      verified = r.rowCount ? true : false;
      if (verified) {
        await withTenant(sess.tenant_id, (c) => writeAudit(c, {
          tenantId: sess.tenant_id, actorUserId: sess.user_id, ip: req.ip,
          requestId: req.requestId, entity: "users", entityId: sess.user_id,
          action: "control.recovery_code_used"
        }));
      }
    } else {
      verified = verifyTotp(secret, code);
    }
    if (!verified) {
      // One attempt per challenge: burn it on failure. Brute force now costs a
      // full password login per guess — every one of them audited.
      await withTenant(sess.tenant_id, (c) => {
        c.query(
          `update sessions set revoked_at = now(), revoked_reason = 'control_totp_failed'
           where refresh_token_hash = $1`, [sha256(challengeToken)]);
        return writeAudit(c, {
          tenantId: sess.tenant_id, actorUserId: sess.user_id, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
          entity: "auth", entityId: sess.user_id, action: "control.totp.failed"
        });
      });
      throw new ApiError("OTP_INVALID", "Invalid code. Sign in again.", 400);
    }

    // Promote the challenge session into a full control session (2h).
    const newToken = randomToken(32);
    await withTenant(sess.tenant_id, async (c) => {
      await c.query(
        `update sessions set revoked_at = now(), revoked_reason='control_challenge'
         where refresh_token_hash = $1`, [sha256(challengeToken)]);
      await c.query(
        `insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
           refresh_token_hash, user_agent, ip, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8, now() + interval '2 hours')`,
        [uuidv7(), sess.user_id, sess.tenant_id, uuidv7(),
         new Date(Date.now() + 2 * 3600 * 1000), sha256(newToken),
         req.headers["user-agent"] ?? null, req.ip ?? null]);
      if (!sess.totp_enabled) {
        await c.query("update users set totp_enabled=true where id=$1", [sess.user_id]);
        await writeAudit(c, {
          tenantId: sess.tenant_id, actorUserId: sess.user_id, ip: req.ip,
          requestId: req.requestId, entity: "users", entityId: sess.user_id,
          action: "control.totp.enabled"
        });
      }
    });

    // First enrollment: hand back the recovery codes exactly once.
    if (!sess.totp_enabled) {
      const { plain, hashes } = generateRecoveryCodes(10);
      for (const h of hashes) {
        await withTenant(sess.tenant_id, (c) => c.query(
          "insert into recovery_codes (user_id, code_hash) values ($1,$2)", [sess.user_id, h]));
      }
      setControlCookie(reply, newToken);
      return reply.send({ ok: true, recoveryCodes: plain });
    }

    setControlCookie(reply, newToken);
    return reply.send({ ok: true });
  });

  // ---------- Change own password (spec 20; retires bootstrap credentials) ----------
  app.post("/control/auth/change-password", { preHandler: [requireControl] }, async (req: any, reply) => {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1),
      newPassword: passwordSchema
    }).parse(req.body);

    const u = await withTenant(req.control.tenant_id, (c) => c.query(
      "select password_hash from users where id=$1", [req.control.user_id]));
    const ok = u.rows[0]?.password_hash && await verifyPassword(u.rows[0].password_hash, currentPassword);
    if (!ok) throw new ApiError("INVALID_CREDENTIALS", "Current password is incorrect.", 401);

    // HIBP check, fail-open on outage: the caller is already TOTP-authenticated,
    // and being locked out of one's own control panel is the worse failure mode.
    const pwned = await pwnedCount(newPassword).catch(() => -1);
    if (pwned > 0) {
      throw new ApiError("VALIDATION_FAILED",
        "This password has appeared in a known data breach. Choose another.", 400,
        [{ field: "newPassword" }]);
    }

    await withTenant(req.control.tenant_id, async (c) => {
      await c.query("update users set password_hash=$2 where id=$1",
        [req.control.user_id, await hashPassword(newPassword)]);
      // Every other control session dies; this one survives.
      await c.query(
        `update sessions set revoked_at = now(), revoked_reason = 'password_change'
         where user_id = $1 and revoked_at is null
           and refresh_token_hash <> $2`,
        [req.control.user_id, sha256(req.cookies[CONTROL_COOKIE] ?? "")]);
      await writeAudit(c, {
        tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
        requestId: req.requestId, entity: "users", entityId: req.control.user_id,
        action: "control.password_changed"
      });
    });
    return reply.send({ ok: true });
  });

  // ---------- Session info ----------
  app.get("/control/auth/me", { preHandler: [requireControl] }, async (req: any) => {
    return { userId: req.control.user_id, roles: req.control.roles ?? [] };
  });

  app.post("/control/auth/logout", async (req: any, reply) => {
    const token = req.cookies[CONTROL_COOKIE];
    if (token) {
      await pool.query("select platform_auth.revoke_session_by_hash($1)", [sha256(token)]);
    }
    clearControlCookie(reply);
    return reply.send({ ok: true });
  });

  // ---------- Tenants: list (Control; super_admin / billing_admin) ----------
  app.get("/control/tenants", { preHandler: [requireControl] }, async (req: any) => {
    if (!hasLicenceRole(req.control.roles ?? [])) throw new ApiError("FORBIDDEN", "Not permitted", 403);
    const q = ((req.query as any)?.q ?? "").toString().trim();
    const { rows } = await pool.query(
      "select * from platform_auth.list_tenants_for_control($1)", [q || null]);
    return rows;
  });

  // ---------- Tenants: manual activate / extend (money verified out-of-band) ----------
  app.post("/control/tenants/:id/activate", { preHandler: [requireControl] }, async (req: any, reply) => {
    if (!hasLicenceRole(req.control.roles ?? [])) throw new ApiError("FORBIDDEN", "Not permitted", 403);
    await enforceRateLimit(`activate:uid:${req.control.user_id}`, 20, 3600);
    const { id } = req.params as { id: string };
    const body = z.object({
      planKey: z.enum(["starter", "business", "enterprise"]),
      billingCycle: z.enum(["monthly", "quarterly", "annual"]),
      provider: z.enum(["azampesa", "mpesa", "tigopesa", "airtel", "halopesa", "bank"]),
      providerTxnId: z.string().max(100).optional(),
      amountOverride: z.number().positive().optional()
    }).parse(req.body);
    const r = await pool.query(
      "select platform_auth.manual_activate($1,$2,$3,$4,$5,$6,$7) as r",
      [id, body.planKey, body.billingCycle, body.provider,
       body.providerTxnId ?? null, body.amountOverride ?? null, req.control.user_id]);
    const res = r.rows[0].r;
    if (res.status === "ok") return reply.send(res);
    throw new ApiError("VALIDATION_FAILED", res.message ?? "Activation failed", 400);
  });

  // ---------- Public plans list (payment page, pre-auth) ----------
  app.get("/control/plans-public", async () => {
    const { rows } = await pool.query(
      "select key, name, seat_limit, price_monthly, price_quarterly, price_annual, vat_rate from plans where is_active = true order by price_monthly");
    return rows;
  });

  // ---------- Plans editor (Super Admin / billing) ----------
  app.get("/control/plans", { preHandler: [requireControl] }, async (req: any) => {
    const { rows } = await pool.query(
      "select id, key, name, seat_limit, price_monthly, price_quarterly, price_annual, vat_rate, is_active from plans order by price_monthly");
    return rows;
  });

  app.put("/control/plans/:key", { preHandler: [requireControl] }, async (req: any, reply) => {
    const { key } = req.params as { key: string };
    const body = z.object({
      name: z.string().min(2).max(60).optional(),
      seatLimit: z.number().int().min(1).max(10000).optional(),
      priceMonthly: z.number().nonnegative().optional(),
      priceQuarterly: z.number().nonnegative().optional(),
      priceAnnual: z.number().nonnegative().optional(),
      isActive: z.boolean().optional()
    }).parse(req.body);

    const updated = await pool.query(
      `update plans set
         name = coalesce($2, name),
         seat_limit = coalesce($3, seat_limit),
         price_monthly = coalesce($4, price_monthly),
         price_quarterly = coalesce($5, price_quarterly),
         price_annual = coalesce($6, price_annual),
         is_active = coalesce($7, is_active),
         updated_at = now()
       where key = $1
       returning *`, [key, body.name ?? null, body.seatLimit ?? null,
        body.priceMonthly ?? null, body.priceQuarterly ?? null,
        body.priceAnnual ?? null, body.isActive ?? null]);
    if (!updated.rowCount) throw new ApiError("NOT_FOUND", "Plan not found", 404);
    return updated.rows[0];
  });
}