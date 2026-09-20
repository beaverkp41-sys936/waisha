import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { pool, withTenant, withTx } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, decryptField, searchHash, sha256, randomToken } from "../util/crypto.js";
import { hashPassword, verifyPassword } from "../security/argon2.js";
import { issueAccessToken, verifyAccessToken } from "../security/jwt.js";
import { passwordSchema, pwnedCount } from "../security/password.js";
import { validateTin } from "../security/tin.js";
import { generateOtp, hashOtp, maskPhone, OTP_TTL_MINUTES, OTP_RESEND_SECONDS } from "../security/otp.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { sendMail, sendSms } from "../mail/mail.js";
import { env, isProd } from "../env.js";

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +255712345678");
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const REFRESH_COOKIE = "waisha_refresh";

function setRefreshCookie(reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true, secure: isProd, sameSite: "strict",
    path: "/api/v1/auth", maxAge: 7 * 24 * 3600
  });
}
function clearRefreshCookie(reply: FastifyReply) {
  reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
}

/** bytea arrives as a hex string when it passes through jsonb — normalise it. */
function bufFromHex(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  return Buffer.from(String(v).replace(/^\\x/, ""), "hex");
}

async function issueSession(
  reply: FastifyReply, req: any,
  userId: string, tenantId: string, typ: string, roles: string[]
): Promise<string> {
  const refresh = randomToken(32);
  const familyExpiry = new Date(Date.now() + 12 * 3600 * 1000); // absolute 12h cap
  const sid = uuidv7();
  await withTenant(tenantId, (c) => c.query(
    `insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
       refresh_token_hash, user_agent, ip, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, least(now() + interval '7 days', $5))`,
    [sid, userId, tenantId, sid, familyExpiry, sha256(refresh),
     req.headers["user-agent"] ?? null, req.ip ?? null]
  ));
  setRefreshCookie(reply, refresh);
  return issueAccessToken({ sub: userId, tid: tenantId, sid, typ, roles });
}

export async function authRoutes(app: FastifyInstance, _opts: unknown) {

  const requireAuth = async (req: any) => {
    const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const claims = auth ? await verifyAccessToken(auth) : null;
    if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
    req.user = claims;
  };

  async function checkPwned(password: string): Promise<void> {
    let n = 0;
    try { n = await pwnedCount(password); }
    catch { throw new ApiError("VALIDATION_FAILED", "Password breach check is temporarily unavailable. Please try again.", 503); }
    if (n > 0) {
      throw new ApiError("VALIDATION_FAILED", "This password has appeared in a known data breach. Choose another.", 400, [{ field: "password" }]);
    }
  }

  // ---------------- Transporter sign-up (spec 4.2) ----------------
  const transporterSignup = z.object({
    companyName: z.string().trim().min(3).max(120),
    tin: z.string().trim().min(9).max(14),
    phone: e164,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the Terms and Privacy Policy" }) })
  }).refine(d => d.password === d.confirmPassword, {
    path: ["confirmPassword"], message: "Passwords do not match"
  });

  app.post("/auth/transporter/signup", async (req: any, reply) => {
    await enforceRateLimit(`signup:ip:${req.ip}`, 10, 3600);
    const data = transporterSignup.parse(req.body);
    const tin = validateTin(data.tin);
    await checkPwned(data.password);

    const tenantId = uuidv7();
    const userId = uuidv7();
    const code = generateOtp();

    await withTx(async (c) => {
      const dupe = await c.query(
        "select platform_auth.check_signup_duplicates($1, $2) as kind",
        [searchHash(tin), data.email]);
      const kind = dupe.rows[0].kind;
      if (kind === "tin") throw new ApiError("CONFLICT", "This TIN is already registered", 409);
      if (kind === "email") throw new ApiError("CONFLICT", "This email is already registered", 409);

      await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await c.query(
        `insert into tenants (id, type, name, tin_encrypted, tin_search,
           phone_encrypted, phone_search, email, status)
         values ($1,'transporter',$2,$3,$4,$5,$6,$7,'pending_verification')`,
        [tenantId, data.companyName, encryptField(tin), searchHash(tin),
         encryptField(data.phone), searchHash(data.phone), data.email]);
      await c.query(
        `insert into users (id, tenant_id, user_type, email, email_normalized_search,
           phone_encrypted, phone_search, password_hash, status, full_name)
         values ($1,$2,'director',$3,$4,$5,$6,$7,'pending_verification',$8)`,
        [userId, tenantId, data.email, searchHash(data.email),
         encryptField(data.phone), searchHash(data.phone),
         await hashPassword(data.password), data.companyName]);
      await c.query(
        `insert into otp_codes (id, user_id, tenant_id, purpose, destination_search,
           code_hash, expires_at, resend_available_at)
         values ($1,$2,$3,'signup',$4,$5, now() + interval '5 minutes', now())`,
        [uuidv7(), userId, tenantId, searchHash(data.phone), hashOtp(code)]);
      await writeAudit(c, {
        tenantId, actorUserId: userId, ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        requestId: req.requestId,
        entity: "tenants", entityId: tenantId, action: "signup.initiated",
        after: { companyName: data.companyName }
      });
    });

    await sendSms(data.phone, `Your WAISHA verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`);
    return reply.status(201).send({ userId, phoneMasked: maskPhone(data.phone) });
  });

  // ---------------- Shipper sign-up (spec 4.3) ----------------
  const shipperSignup = z.object({
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().min(1).max(60),
    nida: z.string().regex(/^\d{20}$/, "NIDA must be 20 digits"),
    phone: e164,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the Terms and Privacy Policy" }) })
  }).refine(d => d.password === d.confirmPassword, {
    path: ["confirmPassword"], message: "Passwords do not match"
  });

  app.post("/auth/shipper/signup", async (req: any, reply) => {
    await enforceRateLimit(`signup:ip:${req.ip}`, 10, 3600);
    const data = shipperSignup.parse(req.body);
    await checkPwned(data.password);

    const tenantId = uuidv7();
    const userId = uuidv7();
    const code = generateOtp();
    const fullName = `${data.firstName} ${data.lastName}`;

    await withTx(async (c) => {
      const dupe = await c.query(
        "select platform_auth.check_shipper_duplicates($1, $2) as kind",
        [data.email, searchHash(data.nida)]);
      const kind = dupe.rows[0].kind;
      if (kind === "email") throw new ApiError("CONFLICT", "This email is already registered", 409);
      if (kind === "nida") throw new ApiError("CONFLICT", "This NIDA is already registered", 409);

      await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await c.query(
        `insert into tenants (id, type, name, status) values ($1,'shipper',$2,'pending_verification')`,
        [tenantId, fullName]);
      await c.query(
        `insert into users (id, tenant_id, user_type, email, email_normalized_search,
           phone_encrypted, phone_search, nida_encrypted, nida_search, password_hash, status, full_name)
         values ($1,$2,'shipper',$3,$4,$5,$6,$7,$8,$9,'pending_verification',$10)`,
        [userId, tenantId, data.email, searchHash(data.email),
         encryptField(data.phone), searchHash(data.phone),
         encryptField(data.nida), searchHash(data.nida),
         await hashPassword(data.password), fullName]);
      await c.query(
        `insert into otp_codes (id, user_id, tenant_id, purpose, destination_search,
           code_hash, expires_at, resend_available_at)
         values ($1,$2,$3,'signup',$4,$5, now() + interval '5 minutes', now())`,
        [uuidv7(), userId, tenantId, searchHash(data.phone), hashOtp(code)]);
      await writeAudit(c, {
        tenantId, actorUserId: userId, ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        requestId: req.requestId,
        entity: "tenants", entityId: tenantId, action: "signup.initiated",
        after: { fullName }
      });
    });

    await sendSms(data.phone, `Your WAISHA verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`);
    return reply.status(201).send({ userId, phoneMasked: maskPhone(data.phone) });
  });

  // ---------------- OTP verify / resend ----------------
  app.post("/auth/otp/verify", async (req: any, reply) => {
    await enforceRateLimit(`otp:ip:${req.ip}`, 20, 900);
    const { userId, code } = z.object({
      userId: z.string().uuid(),
      code: z.string().regex(/^\d{6}$/)
    }).parse(req.body);

    const u = await pool.query("select platform_auth.get_user_for_otp($1) as u", [userId]);
    const user = u.rows[0].u;
    if (!user) throw new ApiError("NOT_FOUND", "Account not found", 404);
    if (user.status !== "pending_verification") {
      throw new ApiError("CONFLICT", "This account is already verified", 409);
    }

    const r = await pool.query(
      "select platform_auth.consume_otp($1,'signup',$2) as r", [userId, hashOtp(code)]);
    const res = r.rows[0].r;
    if (res.status === "locked") {
      throw new ApiError("OTP_LOCKED", "Too many incorrect attempts. Try again in 15 minutes.", 423, [{ until: res.until }]);
    }
    if (res.status === "expired") throw new ApiError("OTP_EXPIRED", "This code has expired. Request a new one.", 400);
    if (res.status === "none") throw new ApiError("OTP_INVALID", "No active code. Request a new one.", 400);
    if (res.status !== "ok") {
      throw new ApiError("OTP_INVALID", `Incorrect code. ${res.attempts_left ?? 0} attempts remaining.`, 400);
    }

    await withTenant(user.tenant_id, async (c) => {
      await c.query("update users set status='active', failed_login_count=0 where id=$1", [userId]);
      const roleKey = user.user_type === "shipper" ? "shipper" : "director";
      await c.query(
        `insert into user_roles (user_id, role_id)
         select $1, id from roles where tenant_id is null and key = $2
         on conflict do nothing`, [userId, roleKey]);
      await writeAudit(c, {
        tenantId: user.tenant_id, actorUserId: userId, ip: req.ip,
        requestId: req.requestId,
        entity: "users", entityId: userId, action: "account.verified"
      });
    });
    return reply.send({ ok: true });
  });

  app.post("/auth/otp/resend", async (req: any, reply) => {
    await enforceRateLimit(`otp-resend:ip:${req.ip}`, 6, 900);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);

    const u = await pool.query("select platform_auth.get_user_for_otp($1) as u", [userId]);
    const user = u.rows[0].u;
    if (!user || user.status !== "pending_verification") {
      throw new ApiError("NOT_FOUND", "No pending verification for this account", 404);
    }

    const last = await pool.query(
      "select platform_auth.last_otp_created_at($1,'signup') as t", [userId]);
    const lastAt = last.rows[0].t ? new Date(last.rows[0].t) : null;
    if (lastAt) {
      const elapsed = (Date.now() - lastAt.getTime()) / 1000;
      if (elapsed < OTP_RESEND_SECONDS) {
        throw new ApiError("RATE_LIMITED",
          `Please wait ${Math.ceil(OTP_RESEND_SECONDS - elapsed)}s before requesting a new code.`, 429);
      }
    }

    const code = generateOtp();
    await withTenant(user.tenant_id, (c) => c.query(
      `insert into otp_codes (id, user_id, tenant_id, purpose, destination_search,
         code_hash, expires_at, resend_available_at)
       values ($1,$2,$3,'signup',$4,$5, now() + interval '5 minutes', now())`,
      [uuidv7(), userId, user.tenant_id, user.phone_search ?? "", hashOtp(code)]));

    const phone = decryptField(bufFromHex(user.phone_encrypted));
    await sendSms(phone, `Your WAISHA verification code is ${code}. It expires in 5 minutes.`);
    return reply.send({ resendAt: new Date(Date.now() + OTP_RESEND_SECONDS * 1000).toISOString() });
  });

  // ---------------- Login (spec 3: all four types) ----------------
  const loginSchema = z.object({
    mode: z.enum(["transporter", "shipper", "customer"]),
    tin: z.string().trim().optional(),
    companyName: z.string().trim().optional(),
    username: z.string().trim().optional(),
    email: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    password: z.string().min(1)
  });

  app.post("/auth/login", async (req: any, reply) => {
    await enforceRateLimit(`login:ip:${req.ip}`, 10, 300); // tightened from 20 (hardening)
    const data = loginSchema.parse(req.body);

    let found: any;
    if (data.mode === "transporter") {
      if (!data.tin || !data.email) {
        throw new ApiError("VALIDATION_FAILED", "TIN and email are required", 400, [{ field: "tin" }]);
      }
      const r = await pool.query("select platform_auth.lookup_transporter_login($1,$2) as r",
        [searchHash(validateTin(data.tin)), searchHash(data.email)]);
      found = r.rows[0].r;
    } else if (data.mode === "shipper") {
      const id = (data.email ?? data.phone ?? "").trim();
      if (!id) {
        throw new ApiError("VALIDATION_FAILED", "Email or phone is required", 400, [{ field: "email" }]);
      }
      const isPhone = /^\+?\d{8,15}$/.test(id.replace(/[\s-]/g, ""));
      const emailSearch = id.includes("@") ? searchHash(id) : null;
      const phoneSearch = isPhone ? searchHash("+" + id.replace(/\D/g, "")) : null;
      const r = await pool.query("select platform_auth.lookup_shipper_login($1,$2) as r",
        [emailSearch, phoneSearch]);
      found = r.rows[0].r;
    } else {
      if (!data.companyName || !data.tin || !data.username) {
        throw new ApiError("VALIDATION_FAILED", "Company name, TIN and username are required", 400);
      }
      const r = await pool.query("select platform_auth.lookup_customer_login($1,$2,$3) as r",
        [data.companyName.trim().toLowerCase(), searchHash(validateTin(data.tin)), searchHash(data.username)]);
      found = r.rows[0].r;
    }

    if (!found) throw new ApiError("INVALID_CREDENTIALS", "Invalid credentials", 401);

    await enforceRateLimit(`login:uid:${found.user_id}`, 5, 900);
    if (found.locked_until && new Date(found.locked_until) > new Date()) {
      throw new ApiError("ACCOUNT_LOCKED", "Account temporarily locked. Try again later.", 423);
    }

    const ok = found.password_hash && await verifyPassword(found.password_hash, data.password);
    if (!ok) {
      await withTenant(found.tenant_id, async (c) => {
        // Exponential lockout (Session 3d): every 5 consecutive failures doubles
        // the lockout duration, capped at 24h. Reset only by a successful login.
        const r = await c.query(
          `update users set
             failed_login_count = failed_login_count + 1,
             lockout_count = case when failed_login_count + 1 >= 5
               then lockout_count + 1 else lockout_count end,
             locked_until = case when failed_login_count + 1 >= 5
               then now() + least(make_interval(mins => (15 * power(2, least(lockout_count, 9)))::int), interval '24 hours')
               else locked_until end
           where id = $1
           returning failed_login_count, lockout_count, locked_until`,
          [found.user_id]);
        const row = r.rows[0];
        if (row && row.failed_login_count % 5 === 0) {
          await writeAudit(c, {
            tenantId: found.tenant_id, actorUserId: found.user_id, ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
            entity: "users", entityId: found.user_id, action: "auth.lockout",
            after: { lockout_count: row.lockout_count, until: row.locked_until }
          });
        }
      });
      throw new ApiError("INVALID_CREDENTIALS", "Invalid credentials", 401);
    }
    if (found.user_status === "pending_verification") {
      throw new ApiError("PENDING_VERIFICATION", "Verify your account to continue.", 403, [{ userId: found.user_id }]);
    }
    if (found.user_status !== "active") {
      throw new ApiError("FORBIDDEN", "This account is not active.", 403);
    }

    await withTenant(found.tenant_id, (c) =>
      c.query("update users set failed_login_count=0, lockout_count=0, locked_until=null, last_login_at=now() where id=$1",
        [found.user_id]));

    const roles: string[] = found.roles ?? [];
    const accessToken = await issueSession(reply, req, found.user_id, found.tenant_id, roles[0] ?? "staff", roles);

    await withTenant(found.tenant_id, (c) => writeAudit(c, {
      tenantId: found.tenant_id, actorUserId: found.user_id,
      actorRole: roles[0] ?? null,
      ip: req.ip, userAgent: req.headers["user-agent"] ?? null,
      requestId: req.requestId,
      entity: "sessions", action: "auth.login"
    }));

    return reply.send({ accessToken, roles });
  });

  // ---------------- Refresh (rotation + family reuse detection) ----------------
  app.post("/auth/refresh", async (req: any, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) throw new ApiError("TOKEN_EXPIRED", "No session", 401);

    const newToken = randomToken(32);
    const r = await pool.query("select platform_auth.rotate_refresh($1,$2,$3,$4) as r",
      [sha256(token), sha256(newToken), req.headers["user-agent"] ?? null, req.ip ?? null]);
    const res = r.rows[0].r;
    if (res.status === "reuse") {
      clearRefreshCookie(reply);
      throw new ApiError("TOKEN_REUSE", "Session revoked for security. Sign in again.", 401);
    }
    if (res.status !== "ok") {
      clearRefreshCookie(reply);
      throw new ApiError("TOKEN_EXPIRED", "Your session has ended. Sign in again.", 401);
    }

    const rolesResult = await withTenant(res.tenant_id, (c) => c.query(
      `select coalesce(array_agg(r.key), '{}') as roles
       from user_roles ur join roles r on r.id = ur.role_id
       where ur.user_id = $1`, [res.user_id]));
    const roles: string[] = rolesResult.rows[0].roles ?? [];

    const accessToken = await issueAccessToken({
      sub: res.user_id, tid: res.tenant_id, sid: res.session_id,
      typ: roles[0] ?? "staff", roles
    });
    setRefreshCookie(reply, newToken);
    return reply.send({ accessToken, roles });
  });

  // ---------------- Logout / sessions ----------------
  app.post("/auth/logout", async (req: any, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) {
      await pool.query("select platform_auth.revoke_session_by_hash($1)", [sha256(token)]);
    }
    clearRefreshCookie(reply);
    return reply.send({ ok: true });
  });

  app.get("/auth/me", { preHandler: [requireAuth] }, async (req: any) => {
    return withTenant(req.user.tid, async (c) => {
      // Explicit column list — credentials never leave the database row.
      const u = await c.query(
        `select u.id, u.email, u.full_name, u.user_type, u.language,
                t.name as tenant_name, t.type as tenant_type, t.status as tenant_status
         from users u join tenants t on t.id = u.tenant_id
         where u.id = $1`, [req.user.sub]);
      return u.rows[0] ?? null;
    });
  });

  app.get("/auth/sessions", { preHandler: [requireAuth] }, async (req: any) => {
    return withTenant(req.user.tid, async (c) => {
      const rows = await c.query(
        `select id, user_agent, ip, created_at, last_refreshed_at, expires_at,
                (id = $2) as current
         from sessions
         where user_id = $1 and revoked_at is null and expires_at > now()
         order by created_at desc`, [req.user.sub, req.user.sid]);
      return rows.rows;
    });
  });

  app.delete("/auth/sessions/:id", { preHandler: [requireAuth] }, async (req: any, reply) => {
    await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        `update sessions set revoked_at = now(), revoked_reason = 'user_revoke'
         where id = $1 and user_id = $2 and revoked_at is null`,
        [req.params.id, req.user.sub]);
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Session not found", 404);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId,
        entity: "sessions", entityId: req.params.id, action: "session.revoked"
      });
    });
    return reply.send({ ok: true });
  });

  // ---------------- Forgot / reset password (spec 4.1) ----------------
  app.post("/auth/forgot-password", async (req: any, reply) => {
    await enforceRateLimit(`forgot:ip:${req.ip}`, 5, 3600);
    const { email } = z.object({ email: emailSchema }).parse(req.body);

    const u = await pool.query(
      "select platform_auth.lookup_active_user_by_email($1) as u", [searchHash(email)]);
    const user = u.rows[0].u;
    if (user) {
      const token = randomToken(32);
      await withTenant(user.tenant_id, (c) => c.query(
        `insert into password_resets (id, user_id, tenant_id, token_hash, expires_at)
         values ($1,$2,$3,$4, now() + interval '30 minutes')`,
        [uuidv7(), user.id, user.tenant_id, sha256(token)]));
      const link = `${env.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;
      await sendMail({
        to: email, subject: "Reset your WAISHA password",
        text: `Use this link within 30 minutes: ${link}`,
        html: `<p>Use this link within 30 minutes to reset your WAISHA password:</p><p><a href="${link}">${link}</a></p><p>If you did not request this, ignore this email.</p>`
      });
    }
    // Neutral always — prevents account enumeration (spec 4.1)
    return reply.send({ message: "If that email is registered, a reset link has been sent" });
  });

  app.post("/auth/reset-password", async (req: any, reply) => {
    await enforceRateLimit(`reset:ip:${req.ip}`, 10, 3600);
    const { token, password } = z.object({
      token: z.string().min(10), password: passwordSchema
    }).parse(req.body);
    await checkPwned(password);

    const r = await pool.query("select platform_auth.consume_reset_token($1) as r", [sha256(token)]);
    const rec = r.rows[0].r;
    if (rec.status !== "ok") {
      throw new ApiError("TOKEN_EXPIRED", "This reset link is invalid or has expired.", 400);
    }

    await withTenant(rec.tenant_id, async (c) => {
      await c.query("update users set password_hash=$2 where id=$1",
        [rec.user_id, await hashPassword(password)]);
      await c.query(
        `update sessions set revoked_at = now(), revoked_reason = 'password_reset'
         where user_id = $1 and revoked_at is null`, [rec.user_id]);
      await writeAudit(c, {
        tenantId: rec.tenant_id, actorUserId: rec.user_id, ip: req.ip,
        requestId: req.requestId,
        entity: "users", entityId: rec.user_id, action: "password.reset"
      });
    });
    return reply.send({ ok: true });
  });
}