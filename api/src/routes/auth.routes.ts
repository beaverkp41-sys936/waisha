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
import { generateOtp, hashOtp, maskPhone, maskEmail, OTP_TTL_MINUTES, OTP_RESEND_SECONDS } from "../security/otp.js";
import { enforceRateLimit, identityBucket } from "../security/ratelimit.js";
import { blockedMessage, tenantBlockState } from "../security/tenant-state.js";
import { writeAudit } from "../audit/audit.js";
import { sendMail, sendSms } from "../mail/mail.js";
import { otpEmail, resetEmail } from "../mail/templates.js";
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

  /**
   * HIBP breach check, with one retry.
   *
   * The range endpoint answers in a couple of hundred milliseconds or returns 429 — it
   * rate-limits the shared egress of every client on it, which for a machine behind one
   * office connection is exactly the situation during a busy morning of registrations. One
   * second later the same call usually succeeds. Without the retry, that 429 surfaced as a
   * "Request validation failed" the person could do nothing about, and their next few tries
   * were consumed by the sign-up limiter before they ever reached a database.
   *
   * It still fails closed if both tries fail: the posture 001's password check was written
   * with ("an outage blocks signup rather than weakening it") is a deliberate decision, and
   * quietly accepting a password that appears in a breach dump is a worse trade than asking
   * somebody to try again in a minute. What changes is that the refusal now says what it is
   * — a distinct code, and the fact that no account was created — instead of looking like a
   * validation error in the person's own typing.
   */
  async function checkPwned(password: string): Promise<void> {
    let n: number | null = null;
    for (let attempt = 1; attempt <= 2 && n === null; attempt++) {
      try {
        n = await pwnedCount(password);
      } catch {
        if (attempt === 2) break;
        await new Promise(r => setTimeout(r, 750));
      }
    }
    if (n === null) {
      throw new ApiError("PASSWORD_CHECK_UNAVAILABLE",
        "WAISHA could not reach the password-safety service, so your account was not created. "
        + "Nothing you typed has been kept — try again in a minute.", 503);
    }
    if (n > 0) {
      throw new ApiError("VALIDATION_FAILED", "This password has appeared in a known data breach. Choose another.", 400, [{ field: "password" }]);
    }
  }

  /**
   * The sign-up limiter shared by all three self-registration doors.
   *
   * The IP ceiling used to be 10 an hour. That reads sensible for a person and is wrong for
   * a clearing office: six clerks on one +255 broadband line registering their own companies
   * and their shippers over a morning hit it, and the answer they got back — "Too many
   * attempts. Please wait and try again." with no idea how long — is the report this task
   * started from. 40 an hour per connection still bounds a flood, and the bucket keyed on the
   * address itself is what stops one target being ground at, which an IP ceiling never could.
   */
  async function limitSignup(req: any, email: string): Promise<void> {
    await enforceRateLimit(`signup:ip:${req.ip}`, 40, 3600);
    await enforceRateLimit(identityBucket("signup:email", email), 6, 86400);
  }

  // ---------------- Transporter sign-up (spec 4.2) ----------------
  const transporterSignup = z.object({
    companyName: z.string().trim().min(3).max(120),
    tin: z.string().trim().min(9).max(14),
    phone: e164,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    // 060's three bundles: what the company wants from WAISHA. Optional because an
    // account that skipped the question must not be guessed into the priciest one.
    serviceGroup: z.string().trim().max(40).nullish(),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the Terms and Privacy Policy" }) })
  }).refine(d => d.password === d.confirmPassword, {
    path: ["confirmPassword"], message: "Passwords do not match"
  });

  app.post("/auth/transporter/signup", async (req: any, reply) => {
    const data = transporterSignup.parse(req.body);
    await limitSignup(req, data.email);
    const tin = validateTin(data.tin);
    await checkPwned(data.password);

    // Resolved from the table, never from a list kept in the client: the control panel
    // reprices and deactivates these rows, and a signup that accepted a stale key would
    // record a bundle the platform no longer sells.
    let serviceGroupId: string | null = null;
    if (data.serviceGroup) {
      const g = await pool.query(
        "select id from service_groups where key = $1 and is_active", [data.serviceGroup]);
      if (!g.rowCount) {
        throw new ApiError("VALIDATION_FAILED", "That service package is not available.", 400,
          [{ field: "serviceGroup", message: "Not a WAISHA package" }]);
      }
      serviceGroupId = g.rows[0].id;
    }

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
           phone_encrypted, phone_search, email, status, service_group_id)
         values ($1,'transporter',$2,$3,$4,$5,$6,$7,'pending_verification',$8)`,
        [tenantId, data.companyName, encryptField(tin), searchHash(tin),
         encryptField(data.phone), searchHash(data.phone), data.email, serviceGroupId]);
      await c.query(
        `insert into users (id, tenant_id, user_type, email, email_normalized_search,
           phone_encrypted, phone_search, password_hash, status, full_name)
         values ($1,$2,'director',$3,$4,$5,$6,$7,'pending_verification',$8)`,
        [userId, tenantId, data.email, searchHash(data.email),
         encryptField(data.phone), searchHash(data.phone),
         await hashPassword(data.password), data.companyName]);
      await c.query(
        `insert into otp_codes (id, user_id, tenant_id, purpose, channel, destination_search,
           code_hash, expires_at, resend_available_at)
         values ($1,$2,$3,'signup','email',$4,$5, now() + interval '5 minutes', now())`,
        [uuidv7(), userId, tenantId, searchHash(data.email), hashOtp(code)]);
      await writeAudit(c, {
        tenantId, actorUserId: userId, ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        requestId: req.requestId,
        entity: "tenants", entityId: tenantId, action: "signup.initiated",
        after: { companyName: data.companyName, serviceGroup: data.serviceGroup ?? null }
      });
    });

    // The code goes to the address, not to the phone. This insert used to leave channel out,
    // so it took 001's 'sms' default and the route then "sent" an SMS through a transport that
    // only writes to stdout: a company could register, was told a text was on its way, and
    // could never finish signing up. 060 already made this call for seekers — email is the one
    // channel that reaches a person until an SMS aggregator is wired.
    //
    // The receipt decides what the screen says next. It is deliberately not an exception: the
    // tenant, the seat and the OTP are already committed, and answering a person who had
    // successfully registered with a 500 left them retrying into "this email is already
    // registered". They are told the code did not go, and the register holds why.
    const receipt = await sendMail(otpEmail(data.email, code, OTP_TTL_MINUTES),
      { purpose: "signup_otp", tenantId, userId });
    return reply.status(201).send({
      userId, emailMasked: maskEmail(data.email), channel: "email",
      codeSent: receipt.delivered,
      // The code screen opens immediately and the server refuses a resend until this
      // instant, so the countdown the person sees is the wait rather than a guess.
      resendAt: new Date(Date.now() + OTP_RESEND_SECONDS * 1000).toISOString()
    });
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
    const data = shipperSignup.parse(req.body);
    await limitSignup(req, data.email);
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
        `insert into otp_codes (id, user_id, tenant_id, purpose, channel, destination_search,
           code_hash, expires_at, resend_available_at)
         values ($1,$2,$3,'signup','email',$4,$5, now() + interval '5 minutes', now())`,
        [uuidv7(), userId, tenantId, searchHash(data.email), hashOtp(code)]);
      await writeAudit(c, {
        tenantId, actorUserId: userId, ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        requestId: req.requestId,
        entity: "tenants", entityId: tenantId, action: "signup.initiated",
        after: { fullName }
      });
    });

    // The code goes to the address, not to the phone. This insert used to leave channel out,
    // so it took 001's 'sms' default and the route then "sent" an SMS through a transport that
    // only writes to stdout: a company could register, was told a text was on its way, and
    // could never finish signing up. 060 already made this call for seekers — email is the one
    // channel that reaches a person until an SMS aggregator is wired.
    //
    // The receipt decides what the screen says next. It is deliberately not an exception: the
    // tenant, the seat and the OTP are already committed, and answering a person who had
    // successfully registered with a 500 left them retrying into "this email is already
    // registered". They are told the code did not go, and the register holds why.
    const receipt = await sendMail(otpEmail(data.email, code, OTP_TTL_MINUTES),
      { purpose: "signup_otp", tenantId, userId });
    return reply.status(201).send({
      userId, emailMasked: maskEmail(data.email), channel: "email",
      codeSent: receipt.delivered,
      // The code screen opens immediately and the server refuses a resend until this
      // instant, so the countdown the person sees is the wait rather than a guess.
      resendAt: new Date(Date.now() + OTP_RESEND_SECONDS * 1000).toISOString()
    });
  });

  // ---------------- Seeker sign-up (spec: find a transporter or a CFA) ----------------
  // Deliberately the shortest form in the system: two names, a phone, an email, a
  // password. A seeker is not onboarding a company, so there is no TIN, no NIDA and
  // no company name to ask for. Verification goes out by EMAIL because the SMS
  // transport is still a dev console stub, and an email code is the one channel that
  // actually reaches a person today.
  const seekerSignup = z.object({
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().min(1).max(60),
    phone: e164,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
    lookingFor: z.array(z.enum(["transporter", "cfa"])).max(2).optional(),
    industry: z.string().trim().max(120).optional(),
    acceptTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the Terms and Privacy Policy" }) })
  }).refine(d => d.password === d.confirmPassword, {
    path: ["confirmPassword"], message: "Passwords do not match"
  }).refine(d => new Set(d.lookingFor ?? []).size === (d.lookingFor ?? []).length, {
    path: ["lookingFor"], message: "Choose each option once"
  });

  app.post("/auth/seeker/signup", async (req: any, reply) => {
    const data = seekerSignup.parse(req.body);
    await limitSignup(req, data.email);
    await checkPwned(data.password);

    const tenantId = uuidv7();
    const userId = uuidv7();
    const seekerId = uuidv7();
    const code = generateOtp();
    const fullName = `${data.firstName} ${data.lastName}`;
    // Empty means "not answered yet". 060's rule: never default to both, or every
    // statistic about what seekers want becomes a flat 100%.
    const lookingFor = [...new Set(data.lookingFor ?? [])];

    await withTx(async (c) => {
      // Both probes run against users, not tenants: a seeker must not be able to take
      // an email or a phone a transporter or a shipper already holds.
      const dupe = await c.query(
        "select platform_auth.check_seeker_duplicates($1, $2) as kind",
        [data.email, searchHash(data.phone)]);
      const kind = dupe.rows[0].kind;
      if (kind === "email") throw new ApiError("CONFLICT", "This email is already registered", 409);
      if (kind === "phone") throw new ApiError("CONFLICT", "This phone is already registered", 409);

      await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await c.query(
        `insert into tenants (id, type, name, status) values ($1,'seeker',$2,'pending_verification')`,
        [tenantId, fullName]);
      await c.query(
        `insert into users (id, tenant_id, user_type, email, email_normalized_search,
           phone_encrypted, phone_search, password_hash, status, full_name)
         values ($1,$2,'seeker',$3,$4,$5,$6,$7,'pending_verification',$8)`,
        [userId, tenantId, data.email, searchHash(data.email),
         encryptField(data.phone), searchHash(data.phone),
         await hashPassword(data.password), fullName]);
      await c.query(
        `insert into seekers (id, tenant_id, user_id, first_name, last_name, looking_for,
           industry, country, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,'Tanzania',$3,$3)`,
        [seekerId, tenantId, userId, data.firstName, data.lastName, lookingFor,
         data.industry ?? null]);
      await c.query(
        `insert into otp_codes (id, user_id, tenant_id, purpose, channel, destination_search,
           code_hash, expires_at, resend_available_at)
         values ($1,$2,$3,'signup','email',$4,$5, now() + interval '5 minutes', now())`,
        [uuidv7(), userId, tenantId, searchHash(data.email), hashOtp(code)]);
      await writeAudit(c, {
        tenantId, actorUserId: userId, ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        requestId: req.requestId,
        entity: "tenants", entityId: tenantId, action: "signup.initiated",
        after: { fullName, lookingFor }
      });
    });

    const receipt = await sendMail(otpEmail(data.email, code, OTP_TTL_MINUTES),
      { purpose: "signup_otp", tenantId, userId });
    return reply.status(201).send({
      userId, seekerId, emailMasked: maskEmail(data.email), channel: "email",
      codeSent: receipt.delivered,
      // The code screen opens immediately and the server refuses a resend until this
      // instant, so the countdown the person sees is the wait rather than a guess.
      resendAt: new Date(Date.now() + OTP_RESEND_SECONDS * 1000).toISOString()
    });
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

    // Seekers is RLS-scoped to the seeker's own tenant and this route holds only a
    // user id, so the verification stamp goes through 060's definer. The metered read
    // path in 061 reads that stamp — without it every search answers "not_verified".
    const isSeeker = user.user_type === "seeker";
    const channel = isSeeker ? (user.channel ?? "email") : null;
    await withTenant(user.tenant_id, async (c) => {
      await c.query("update users set status='active', failed_login_count=0 where id=$1", [userId]);
      const roleKey = isSeeker ? "seeker" : user.user_type === "shipper" ? "shipper" : "director";
      await c.query(
        `insert into user_roles (user_id, role_id)
         select $1, id from roles where tenant_id is null and key = $2
         on conflict do nothing`, [userId, roleKey]);
      if (isSeeker) {
        await c.query("select platform_auth.mark_seeker_verified($1,$2)", [userId, channel]);
        // A seeker shell never enters the licence lifecycle, so unlike a transporter
        // (008's claim_trial) or a paying shipper (009) nothing else would ever move
        // its tenant off pending_verification. The admin panel counts companies by
        // this column, so it has to be truthful.
        await c.query("update tenants set status='active' where id=$1", [user.tenant_id]);
      }
      await writeAudit(c, {
        tenantId: user.tenant_id, actorUserId: userId, ip: req.ip,
        requestId: req.requestId,
        entity: "users", entityId: userId, action: "account.verified",
        after: channel ? { user_type: user.user_type, channel } : undefined
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
    // channel is read back from the newest signup row, so it must be carried into the
    // replacement one: relying on the column's 'sms' default would quietly move a seeker
    // onto the console-only transport on their second resend, and verify would then
    // stamp phone_verified_at for a phone nobody ever texted.
    const byEmail = user.channel === "email";
    await withTenant(user.tenant_id, (c) => c.query(
      `insert into otp_codes (id, user_id, tenant_id, purpose, channel, destination_search,
         code_hash, expires_at, resend_available_at)
       values ($1,$2,$3,'signup',$4,$5,$6, now() + interval '5 minutes', now())`,
      [uuidv7(), userId, user.tenant_id, byEmail ? "email" : "sms",
       byEmail ? searchHash(user.email) : (user.phone_search ?? ""), hashOtp(code)]));

    const ctx = { purpose: "otp_resend" as const, tenantId: user.tenant_id, userId };
    let receipt;
    if (byEmail) {
      receipt = await sendMail(otpEmail(user.email, code, OTP_TTL_MINUTES), ctx);
    } else {
      const phone = decryptField(bufFromHex(user.phone_encrypted));
      receipt = await sendSms(phone,
        `Your WAISHA verification code is ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`, ctx);
    }
    // codeSent is what the screen reads out. A resend that the provider refused used to
    // answer 200 and mean "a code is on its way", which is the promise this route can no
    // longer keep quietly — the person is about to wait for something that did not go.
    return reply.send({
      resendAt: new Date(Date.now() + OTP_RESEND_SECONDS * 1000).toISOString(),
      channel: byEmail ? "email" : "sms",
      emailMasked: byEmail ? maskEmail(user.email) : null,
      codeSent: receipt.delivered
    });
  });

  /** Shipper and seeker sign-in both accept one free-text identity box, so the
   * email/phone split is decided here once rather than re-typed per branch.
   * Lowercasing is not cosmetic: signup stores email_normalized_search from an
   * address Zod already folded to lower case, so a login typed as "A@X.COM"
   * would hash to a different value and the row would simply not be found. */
  function identitySearches(id: string): { emailSearch: string | null; phoneSearch: string | null } {
    const value = id.toLowerCase();
    const isPhone = /^\+?\d{8,15}$/.test(value.replace(/[\s-]/g, ""));
    return {
      emailSearch: value.includes("@") ? searchHash(value) : null,
      phoneSearch: isPhone ? searchHash("+" + value.replace(/\D/g, "")) : null
    };
  }

  // ---------------- Login (spec 3: all four types) ----------------
  const loginSchema = z.object({
    mode: z.enum(["transporter", "shipper", "customer", "seeker"]),
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
    } else if (data.mode === "shipper" || data.mode === "seeker") {
      const id = (data.email ?? data.phone ?? "").trim();
      if (!id) {
        throw new ApiError("VALIDATION_FAILED", "Email or phone is required", 400, [{ field: "email" }]);
      }
      const { emailSearch, phoneSearch } = identitySearches(id);
      // 060 mirrored lookup_shipper_login's envelope exactly so this branch stays one
      // shape — status, lockout and session code below is shared, not duplicated.
      const r = data.mode === "seeker"
        ? await pool.query("select platform_auth.lookup_seeker_login($1,$2) as r",
            [emailSearch, phoneSearch])
        : await pool.query("select platform_auth.lookup_shipper_login($1,$2) as r",
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

    if (!found) {
      // Anomaly feed (spec 12): every attempt against an unknown identity is recorded.
      await pool.query(
        `insert into audit_logs (id, tenant_id, actor_user_id, ip, user_agent, request_id, entity, action, after)
         values ($1, null, null, $2, $3, $4, 'auth', 'login_failed.unknown', $5::jsonb)`,
        [uuidv7(), req.ip ?? null, req.headers["user-agent"] ?? null,
         req.requestId, JSON.stringify({ mode: data.mode })]);
      await new Promise(r => setTimeout(r, 600)); // uniform delay; removes timing as an enumeration signal
      throw new ApiError("INVALID_CREDENTIALS", "Invalid credentials", 401);
    }

    await enforceRateLimit(`login:uid:${found.user_id}`, 5, 900);
    if (found.locked_until && new Date(found.locked_until) > new Date()) {
      throw new ApiError("ACCOUNT_LOCKED", "Account temporarily locked. Try again later.", 423);
    }

    const ok = found.password_hash && await verifyPassword(found.password_hash, data.password);
    if (!ok) {
      let failures = 1;
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
        failures = row?.failed_login_count ?? 1;
        // Anomaly feed (spec 12): audit EVERY failed attempt, not only lockouts.
        await writeAudit(c, {
          tenantId: found.tenant_id, actorUserId: found.user_id, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
          entity: "auth", entityId: found.user_id, action: "login_failed",
          after: { failures }
        });
        if (row && row.failed_login_count % 5 === 0) {
          await writeAudit(c, {
            tenantId: found.tenant_id, actorUserId: found.user_id, ip: req.ip,
            userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
            entity: "users", entityId: found.user_id, action: "auth.lockout",
            after: { lockout_count: row.lockout_count, until: row.locked_until }
          });
        }
      });
      // Progressive delay: grows with the failure count, capped at 2s.
      await new Promise(r => setTimeout(r, Math.min(300 * failures, 2000)));
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

    // The company is shut, so the person is not let in — even though they knew their
    // password. This sits after the password check on purpose: telling an anonymous
    // caller that a company is blocked is an existence signal, and the suite that
    // proves enumeration parity (smoke-security-e2e phase H) compares this path with
    // the wrong-password path byte for byte. The counters were reset above because a
    // correct password is a correct password; a block the office imposed must not
    // stack toward a lockout that outlives the block.
    const blockState = await tenantBlockState(found.tenant_id);
    if (blockState) {
      await withTenant(found.tenant_id, (c) => writeAudit(c, {
        tenantId: found.tenant_id, actorUserId: found.user_id,
        ip: req.ip, userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
        entity: "auth", entityId: found.user_id, action: "auth.login_blocked",
        after: { reason_code: blockState.reason_code, since: blockState.since }
      }));
      throw new ApiError("TENANT_BLOCKED", blockedMessage(blockState), 403);
    }

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

  // What this seat is allowed to do, read from the same role_permissions matrix
  // requirePermission gates against. A page that cannot see its own duties can
  // only guess, and a guess means offering a button the server will refuse.
  app.get("/auth/permissions", { preHandler: [requireAuth] }, async (req: any) => {
    return withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        `select distinct rp.permission_key as key
           from user_roles ur
           join role_permissions rp on rp.role_id = ur.role_id
          where ur.user_id = $1
            and (ur.expires_at is null or ur.expires_at > now())
          order by 1`, [req.user.sub]);
      return { keys: r.rows.map((x: { key: string }) => x.key) };
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
    // 20 an hour per connection, not 5. This is the same mistake limitSignup() had to be
    // taken off: a clearing office shares one +255 broadband line, and five forgotten
    // passwords between eight clerks in a morning used to answer the sixth with "Too many
    // attempts" and no idea when to come back — which reads as a broken platform, not as a
    // limit. The real ceiling is the one keyed on the address below, because that is what
    // stops any single person's inbox being flooded; an IP ceiling never could.
    await enforceRateLimit(`forgot:ip:${req.ip}`, 20, 3600);
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    // The same address again on a different connection. An IP-only ceiling is worth
    // nothing to an attacker with a handful of source addresses, and this route mints a
    // live 30-minute token and sends an email to somebody who did not ask for either.
    await enforceRateLimit(identityBucket("forgot:mail", email), 5, 3600);

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
      // The answer stays neutral to the caller, but the register is not neutral: a reset
      // that never reached the provider is the reason a person phones the office, and the
      // desk has to be able to see it happened without asking them to try again.
      await sendMail(resetEmail(email, link, 30),
        { purpose: "password_reset", tenantId: user.tenant_id, userId: user.id });
    }
    // Neutral always — prevents account enumeration (spec 4.1)
    return reply.send({ message: "If that email is registered, a reset link has been sent" });
  });

  app.post("/auth/reset-password", async (req: any, reply) => {
    await enforceRateLimit(`reset:ip:${req.ip}`, 10, 3600);
    const { token, password } = z.object({
      token: z.string().min(10), password: passwordSchema
    }).parse(req.body);
    // Keyed on the token itself. Guessing a 32-byte reset token is not a solvable budget
    // question, but a leaked link is: this is the door that revokes every session and
    // replaces the password, so it must not also be the door that guesses the old one.
    await enforceRateLimit(identityBucket("reset:tok", token), 10, 3600);
    await checkPwned(password);

    const r = await pool.query("select platform_auth.consume_reset_token($1) as r", [sha256(token)]);
    const rec = r.rows[0].r;
    if (rec.status !== "ok") {
      throw new ApiError("TOKEN_EXPIRED", "This reset link is invalid or has expired.", 400);
    }

    await withTenant(rec.tenant_id, async (c) => {
      const cur = await c.query("select status, user_type from users where id=$1", [rec.user_id]);
      // Invited staff verify their email by possessing this link, so accepting
      // the invite completes verification. Directors/shippers must still pass
      // the phone OTP flow — don't let a reset bypass it.
      const invited = cur.rows[0]?.status === "pending_verification" &&
        cur.rows[0]?.user_type === "staff";
      await c.query(
        `update users set password_hash=$2${invited ? ", status='active'" : ""} where id=$1`,
        [rec.user_id, await hashPassword(password)]);
      await c.query(
        `update sessions set revoked_at = now(), revoked_reason = 'password_reset'
         where user_id = $1 and revoked_at is null`, [rec.user_id]);
      await writeAudit(c, {
        tenantId: rec.tenant_id, actorUserId: rec.user_id, ip: req.ip,
        requestId: req.requestId,
        entity: "users", entityId: rec.user_id, action: "password.reset"
      });
      if (invited) {
        await writeAudit(c, {
          tenantId: rec.tenant_id, actorUserId: rec.user_id, ip: req.ip,
          requestId: req.requestId,
          entity: "users", entityId: rec.user_id, action: "staff.invite_accepted",
          after: { status: "active" }
        });
      }
    });
    return reply.send({ ok: true });
  });
}