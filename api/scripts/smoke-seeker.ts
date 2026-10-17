/**
 * Seeker self-signup smoke — the whole lifecycle against a running API (port 4000).
 *
 * Signs a seeker up for real, walks the email-OTP verification through the wrong /
 * resent / verified paths, logs in through /auth/login mode=seeker, and then probes
 * the audience gate: which surfaces a seeker token may knock on and which it may
 * not. The resend assertions are the point of the suite — a second resend must stay
 * on the email channel, because the SMS transport is a dev console stub and a seeker
 * flipped onto it would never receive a code and so could never verify.
 *
 * Run: npx tsx scripts/smoke-seeker.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";
import { decryptField, searchHash } from "../src/util/crypto.js";
import { hashOtp } from "../src/security/otp.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const FIRST = "Amina";
const LAST = "Mushi";
const EMAIL = `smoke.seeker.${STAMP}@waisha.test`;
const PHONE = `+2557${STAMP}`;
const PASSWORD = `Sk-${STAMP}-Q7!m`;
const OTP_KNOWN = "246810";
const OTP_WRONG = "135790";
const TIN = `9${STAMP}`;
/** Every address this suite can create, including the probe addresses. */
const EMAIL_SWEEP = `%.${STAMP}@waisha.test`;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const transcript: string[] = [];

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  transcript.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

const signupPayload = (over: Record<string, unknown> = {}) => JSON.stringify({
  firstName: FIRST, lastName: LAST, phone: PHONE, email: EMAIL,
  password: PASSWORD, confirmPassword: PASSWORD,
  lookingFor: ["transporter"], acceptTerms: true, ...over
});
const cookieOf = (h: Headers) =>
  (typeof h.getSetCookie === "function" ? h.getSetCookie() : [])
    .find((c) => c.startsWith("waisha_refresh="))?.split(";")[0] ?? "";

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const clearBuckets = async (...prefixes: string[]) => {
    for (const p of prefixes) await oi(`delete from rate_limits where bucket like $1`, [`${p}%`]);
  };

  // Sweep rows a crashed earlier run may have left; the address stamp identifies
  // them, so a rerun does not trip its own duplicate probes.
  let ourTenants: string[] = [];
  const sweep = async () => {
    const ids = (await oi(
      `select id, tenant_id from users where email like $1`, [EMAIL_SWEEP])).rows;
    if (!ids.length) return;
    const uids = ids.map((r: any) => r.id);
    const tids = [...new Set(ids.map((r: any) => r.tenant_id))];
    ourTenants = [...new Set([...ourTenants, ...tids])];
    await oi(`delete from seekers where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from seeker_searches where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from seeker_search_passes where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from directory_listing_regions where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from directory_listings where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from otp_codes where tenant_id = any($1::uuid[])`, [tids]);
    await oi(`delete from sessions where tenant_id = any($1::uuid[])`, [tids]);
    await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [tids]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [tids]);
  };
  await sweep();
  await clearBuckets("signup:", "otp:", "otp-resend:", "login:");

  // One real director: the cross-account-type collision probe and the
  // promoted-account guard both need a staff identity that exists.
  const dir = (await oi(
    `select u.id as user_id, u.email, u.tenant_id from users u
      where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
      order by u.created_at limit 1`)).rows[0];
  if (!dir) throw new Error("Smoke needs one active director in the database");

  let userId: string | null = null;
  let seekerId: string | null = null;
  let tenantId: string | null = null;

  try {
    // ---------------- validation ----------------
    phase("validation");
    const mismatch = await call("/auth/seeker/signup", null, {
      method: "POST", body: signupPayload({ confirmPassword: "Another-Pass1!x" })
    });
    check("passwords that do not match → 400 on confirmPassword",
      mismatch.status === 400 &&
      mismatch.json?.error?.details?.some((d: any) => d.field === "confirmPassword"),
      { s: mismatch.status, d: mismatch.json?.error?.details });

    const noTerms = await call("/auth/seeker/signup", null, {
      method: "POST", body: signupPayload({ acceptTerms: false })
    });
    check("terms not accepted → 400 naming the Terms",
      noTerms.status === 400 &&
      noTerms.json?.error?.details?.some((d: any) => /Terms/.test(d.message ?? "")),
      { s: noTerms.status, d: noTerms.json?.error?.details });

    const localPhone = await call("/auth/seeker/signup", null, {
      method: "POST", body: signupPayload({ phone: "0712345678", email: `loc.${STAMP}@waisha.test` })
    });
    check("local-format phone → 400, E.164 required",
      localPhone.status === 400 &&
      localPhone.json?.error?.details?.some((d: any) => d.field === "phone"),
      { s: localPhone.status });

    const weak = await call("/auth/seeker/signup", null, {
      method: "POST",
      body: signupPayload({ password: "short", confirmPassword: "short", email: `weak.${STAMP}@waisha.test` })
    });
    check("weak password → 400", weak.status === 400 &&
      weak.json?.error?.details?.some((d: any) => d.field === "password"), { s: weak.status });

    const dupChoice = await call("/auth/seeker/signup", null, {
      method: "POST",
      body: signupPayload({ lookingFor: ["transporter", "transporter"], email: `dup.${STAMP}@waisha.test` })
    });
    check("the same option chosen twice → 400 on lookingFor",
      dupChoice.status === 400 &&
      dupChoice.json?.error?.details?.some((d: any) => d.field === "lookingFor"),
      { s: dupChoice.status, d: dupChoice.json?.error?.details });

    const blankName = await call("/auth/seeker/signup", null, {
      method: "POST", body: signupPayload({ firstName: "   ", email: `blank.${STAMP}@waisha.test` })
    });
    check("blank first name → 400", blankName.status === 400, blankName.status);

    const threeOptions = await call("/auth/seeker/signup", null, {
      method: "POST",
      body: signupPayload({ lookingFor: ["transporter", "cfa", "office"], email: `tri.${STAMP}@waisha.test` })
    });
    check("an option that is not transporter or cfa → 400", threeOptions.status === 400,
      threeOptions.status);

    // ---------------- collisions ----------------
    phase("duplicate identities");
    const asTransporter = await call("/auth/transporter/signup", null, {
      method: "POST",
      body: JSON.stringify({
        companyName: `Seeker Clash Ltd ${STAMP}`, tin: TIN, phone: `+2556${STAMP}`,
        email: dir.email, password: PASSWORD, confirmPassword: PASSWORD, acceptTerms: true
      })
    });
    check("an email already held by a director blocks a transporter signup too → 409",
      asTransporter.status === 409 && asTransporter.json?.error?.code === "CONFLICT",
      { s: asTransporter.status, code: asTransporter.json?.error?.code });

    const emailClash = await call("/auth/seeker/signup", null, {
      method: "POST", body: signupPayload({ email: dir.email, phone: `+2556${STAMP}` })
    });
    check("a director's email blocks a seeker signup → 409 email",
      emailClash.status === 409 &&
      emailClash.json?.error?.message === "This email is already registered",
      { s: emailClash.status, m: emailClash.json?.error?.message });

    // The phone half of the duplicate probe has to wait until a seeker actually
    // holds this number — see the collision re-check in the signup phase.

    // ---------------- signup ----------------
    phase("signup");
    // Every signup attempt above counted in the same 10-per-hour bucket — the
    // throttle runs before validation, so a 400 costs a slot too. Buckets are
    // clock-aligned windows, not history; clearing them here is what keeps the
    // result about the code rather than about when the suite last ran.
    await clearBuckets("signup:");
    const created = await call("/auth/seeker/signup", null, { method: "POST", body: signupPayload() });
    userId = created.json?.userId ?? null;
    seekerId = created.json?.seekerId ?? null;
    check("valid seeker signup → 201 with userId and seekerId",
      created.status === 201 && !!userId && !!seekerId, { s: created.status, b: created.json });

    check("the response masks the address and echoes no plaintext copy",
      created.json?.emailMasked === `${EMAIL[0]}${"*".repeat(EMAIL.indexOf("@") - 1)}@waisha.test` &&
      !created.text.includes(EMAIL),
      { masked: created.json?.emailMasked });

    const rows = (await oi(
      `select u.status as user_status, u.user_type, u.email, u.email_normalized_search,
              u.phone_search, u.phone_encrypted, u.password_hash, u.tenant_id,
              tn.type as tenant_type, tn.status as tenant_status, tn.name as tenant_name,
              s.id as seeker_row_id, s.first_name, s.last_name, s.looking_for, s.country,
              s.industry, s.email_verified_at, s.phone_verified_at
         from users u
         join tenants tn on tn.id = u.tenant_id
         join seekers s on s.user_id = u.id
        where u.id = $1`, [userId])).rows[0];
    tenantId = rows?.tenant_id ?? null;

    check("one transaction wrote all three rows in the shape the schema promises",
      rows?.user_type === "seeker" && rows?.tenant_type === "seeker" &&
      rows?.user_status === "pending_verification" && rows?.tenant_status === "pending_verification" &&
      rows?.tenant_name === `${FIRST} ${LAST}` && rows?.first_name === FIRST &&
      rows?.last_name === LAST && rows?.country === "Tanzania" && rows?.seeker_row_id === seekerId &&
      rows?.email_verified_at === null && rows?.phone_verified_at === null,
      rows && { ut: rows.user_type, tt: rows.tenant_type, us: rows.user_status, ts: rows.tenant_status });

    check("profile holds exactly the one option the seeker picked",
      (rows?.looking_for ?? []).length === 1 && rows?.looking_for[0] === "transporter",
      rows?.looking_for);

    const phoneClash = await call("/auth/seeker/signup", null, {
      method: "POST", body: signupPayload({ email: `ph.${STAMP}@waisha.test` })
    });
    check("the phone the account just claimed blocks a second seeker → 409 phone",
      phoneClash.status === 409 &&
      phoneClash.json?.error?.message === "This phone is already registered",
      { s: phoneClash.status, m: phoneClash.json?.error?.message });

    const emailClash2 = await call("/auth/seeker/signup", null, { method: "POST", body: signupPayload() });
    check("the address the account just claimed blocks a second seeker → 409 email",
      emailClash2.status === 409 &&
      emailClash2.json?.error?.message === "This email is already registered",
      { s: emailClash2.status, m: emailClash2.json?.error?.message });

    const silentAsk = await call("/auth/seeker/signup", null, {
      method: "POST",
      body: signupPayload({ email: `ask.${STAMP}@waisha.test`, phone: `+2555${STAMP}`, lookingFor: undefined })
    });
    const silentRow = silentAsk.json?.seekerId
      ? (await oi(`select looking_for from seekers where id = $1`, [silentAsk.json.seekerId])).rows[0]
      : null;
    check("omitting looking_for stores an empty array, never both options",
      Array.isArray(silentRow?.looking_for) && silentRow?.looking_for.length === 0,
      { s: silentAsk.status, lf: silentRow?.looking_for });

    const decPhone = rows?.phone_encrypted ? decryptField(rows.phone_encrypted) : null;
    check("password is stored hashed, not in the clear",
      String(rows?.password_hash ?? "").startsWith("$argon2"),
      { head: String(rows?.password_hash ?? "").slice(0, 14) });
    check("phone encrypted at rest and reversible; email indexed only by hash",
      decPhone === PHONE && rows?.phone_search === searchHash(PHONE) &&
      rows?.email_normalized_search === searchHash(EMAIL) && rows?.email === EMAIL,
      { dec: decPhone, hashOk: rows?.email_normalized_search === searchHash(EMAIL) });

    const otpRow = (await oi(
      `select id, purpose, channel, destination_search, attempts,
              expires_at > now() as live
         from otp_codes where user_id = $1 order by created_at desc limit 1`, [userId])).rows[0];
    check("the code went out by EMAIL against the address hash, not the phone",
      otpRow?.purpose === "signup" && otpRow?.channel === "email" &&
      otpRow?.destination_search === searchHash(EMAIL) && otpRow?.live === true,
      otpRow);

    const initiated = (await oi(
      `select action, after from audit_logs
        where entity_id = $1 and action = 'signup.initiated' limit 1`, [tenantId])).rows[0];
    check("the signup is audited against the tenant shell with what they asked for",
      initiated?.action === "signup.initiated" &&
      initiated?.after?.fullName === `${FIRST} ${LAST}` &&
      Array.isArray(initiated?.after?.lookingFor) && initiated.after.lookingFor[0] === "transporter",
      initiated && { a: initiated.action, after: initiated.after });

    // ---------------- before verification ----------------
    phase("before verification");
    const earlyLogin = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "seeker", email: EMAIL, password: PASSWORD })
    });
    check("seeker login before verifying → 403 PENDING_VERIFICATION carrying the userId",
      earlyLogin.status === 403 && earlyLogin.json?.error?.code === "PENDING_VERIFICATION" &&
      earlyLogin.json?.error?.details?.[0]?.userId === userId,
      { s: earlyLogin.status, code: earlyLogin.json?.error?.code });

    const tooSoon = await call("/auth/otp/resend", null, {
      method: "POST", body: JSON.stringify({ userId })
    });
    check("resend inside the 60s window → 429", tooSoon.status === 429, tooSoon.status);

    // The window is a genuine wait. The fixture ages the newest code row instead of
    // sleeping — which is exactly what a minute of wall clock would have done.
    await oi(`update otp_codes set created_at = now() - interval '90 seconds' where id = $1`, [otpRow.id]);
    await clearBuckets("otp-resend:");

    const unguessable = await call("/auth/otp/verify", null, {
      method: "POST", body: JSON.stringify({ userId, code: OTP_KNOWN })
    });
    check("the stored code is the random one, not the value the fixture guessed",
      unguessable.status === 400 && unguessable.json?.error?.code === "OTP_INVALID",
      { s: unguessable.status, code: unguessable.json?.error?.code });

    // ---------------- resend keeps its channel ----------------
    phase("resend");
    const resent = await call("/auth/otp/resend", null, {
      method: "POST", body: JSON.stringify({ userId })
    });
    check("resend for a pending seeker → 200 with the next window",
      resent.status === 200 && !!resent.json?.resendAt, { s: resent.status, b: resent.json });

    const otps = (await oi(
      `select channel, destination_search from otp_codes
        where user_id = $1 and purpose = 'signup' order by created_at desc limit 2`, [userId])).rows;
    check("the replacement row is still channel=email against the address hash",
      otps.length === 2 && otps[0]?.channel === "email" &&
      otps[0]?.destination_search === searchHash(EMAIL),
      otps.map((o: any) => `${o.channel}:${String(o.destination_search).slice(0, 8)}`));
    check("nothing was ever written for the console-only SMS transport",
      otps.every((o: any) => o.channel !== "sms"), otps.map((o: any) => o.channel));

    const wrongAgain = await call("/auth/otp/verify", null, {
      method: "POST", body: JSON.stringify({ userId, code: OTP_WRONG })
    });
    check("the resent row is the one the verifier reads, and it refuses a wrong code",
      wrongAgain.status === 400 && wrongAgain.json?.error?.code === "OTP_INVALID",
      { s: wrongAgain.status, m: wrongAgain.json?.error?.message });

    // ---------------- verify ----------------
    phase("verify");
    await oi(`update otp_codes set attempts = 0, locked_until = null, code_hash = $2
              where user_id = $1 and purpose = 'signup' and expires_at > now()`,
      [userId, hashOtp(OTP_KNOWN)]);
    await clearBuckets("otp:");

    const verified = await call("/auth/otp/verify", null, {
      method: "POST", body: JSON.stringify({ userId, code: OTP_KNOWN })
    });
    check("correct email code → 200", verified.status === 200, { s: verified.status, b: verified.json });

    const after = (await oi(
      `select u.status as user_status, tn.status as tenant_status,
              s.email_verified_at, s.phone_verified_at,
              coalesce((select array_agg(r.key) from user_roles ur
                         join roles r on r.id = ur.role_id where ur.user_id = u.id), '{}') as roles
         from users u join tenants tn on tn.id = u.tenant_id
         join seekers s on s.user_id = u.id where u.id = $1`, [userId])).rows[0];
    check("the user and its tenant shell both flipped to active",
      after?.user_status === "active" && after?.tenant_status === "active",
      { u: after?.user_status, t: after?.tenant_status });
    check("EMAIL is the channel stamped on the profile; a phone nobody texted stays null",
      after?.email_verified_at instanceof Date && after?.phone_verified_at === null,
      { e: after?.email_verified_at, p: after?.phone_verified_at });
    check("the global seeker role is granted and nothing else",
      (after?.roles ?? []).length === 1 && after?.roles[0] === "seeker", after?.roles);

    const audit = (await oi(
      `select action, after from audit_logs
        where entity_id = $1 and action = 'account.verified' order by ts desc limit 1`, [userId])).rows[0];
    check("verification is audited with the channel that proved it",
      audit?.action === "account.verified" && audit?.after?.channel === "email",
      audit && { a: audit.action, after: audit.after });

    const secondVerify = await call("/auth/otp/verify", null, {
      method: "POST", body: JSON.stringify({ userId, code: OTP_KNOWN })
    });
    check("verifying twice → 409, the account is already live", secondVerify.status === 409,
      secondVerify.status);
    const lateResend = await call("/auth/otp/resend", null, {
      method: "POST", body: JSON.stringify({ userId })
    });
    check("resend after verification → 404, nothing is pending", lateResend.status === 404,
      lateResend.status);

    // The metered read path in 061 refuses an unverified profile, so the stamp the
    // route just wrote is what unlocks a seeker at all. Read it back the way the
    // definer will.
    const gate = (await oi(
      `select (select coalesce(array_agg(r.key), '{}') from user_roles ur
                join roles r on r.id = ur.role_id where ur.user_id = $1) as roles,
              (select email_verified_at is not null from seekers where user_id = $1) as verified`,
      [userId])).rows[0];
    check("the profile is now readable by the search meter (verified, seeker role)",
      gate?.verified === true && gate?.roles.includes("seeker"), gate);

    // ---------------- login ----------------
    phase("login");
    await clearBuckets("login:");
    const badPw = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "seeker", email: EMAIL, password: "Wrong-Passw0rd!x" })
    });
    check("wrong password → 401", badPw.status === 401, badPw.status);
    const failRow = (await oi(`select failed_login_count from users where id = $1`, [userId])).rows[0];
    check("the failure counted against the seeker's own row", failRow?.failed_login_count === 1, failRow);

    const upper = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "seeker", email: EMAIL.toUpperCase(), password: PASSWORD })
    });
    check("an address typed in upper case still logs in", upper.status === 200, upper.status);

    const login = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "seeker", email: EMAIL, password: PASSWORD })
    });
    const seekerToken = login.json?.accessToken ?? null;
    check("seeker login by email → 200 with the seeker role",
      login.status === 200 && (login.json?.roles ?? []).join() === "seeker",
      { s: login.status, roles: login.json?.roles });
    check("a successful login cleared the failure counter",
      (await oi(`select failed_login_count from users where id = $1`, [userId])).rows[0]
        ?.failed_login_count === 0);

    const claims = JSON.parse(Buffer.from(String(seekerToken).split(".")[1], "base64url").toString());
    check("the token carries typ=seeker, the seeker's own tenant and a session id",
      claims.typ === "seeker" && (claims.roles ?? []).join() === "seeker" &&
      claims.tid === tenantId && !!claims.sid,
      { typ: claims.typ, roles: claims.roles, tid: claims.tid });

    const phoneLogin = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "seeker", phone: PHONE, password: PASSWORD })
    });
    check("seeker login by phone → 200", phoneLogin.status === 200, phoneLogin.status);

    const wrongTab = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "transporter", tin: TIN, email: EMAIL, password: PASSWORD })
    });
    check("a seeker cannot sign in through the transporter tab", wrongTab.status === 401,
      { s: wrongTab.status, code: wrongTab.json?.error?.code });

    const ghost = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "seeker", email: `nobody.${STAMP}@waisha.test`, password: PASSWORD })
    });
    check("an unknown seeker address → 401 with the same shape as a wrong password",
      ghost.status === 401 && ghost.json?.error?.code === "INVALID_CREDENTIALS", ghost.status);

    const me = await call("/auth/me", seekerToken);
    check("/auth/me reports the seeker's own tenant type and no credential column",
      me.status === 200 && me.json?.user_type === "seeker" && me.json?.tenant_type === "seeker" &&
      me.json?.email === EMAIL && !("password_hash" in (me.json ?? {})),
      { s: me.status, tt: me.json?.tenant_type, keys: Object.keys(me.json ?? {}) });

    const sessions = await call("/auth/sessions", seekerToken);
    check("/auth/sessions lists the seeker's own live sessions and marks this one",
      sessions.status === 200 && Array.isArray(sessions.json) &&
      sessions.json.some((s: any) => s.current === true),
      { s: sessions.status, n: sessions.json?.length });

    const refresh = await call("/auth/refresh", null, {
      method: "POST", headers: { Cookie: cookieOf(login.headers) }
    });
    check("the seeker session refreshes like any other",
      refresh.status === 200 && !!refresh.json?.accessToken, { s: refresh.status, b: refresh.json });

    // ---------------- audience boundary ----------------
    phase("audience");
    for (const p of ["/drivers", "/invoices", "/notifications", "/fleet", "/trips", "/routes"]) {
      const r = await call(p, seekerToken);
      check(`GET ${p} with a seeker token → 403 FORBIDDEN`,
        r.status === 403 && r.json?.error?.code === "FORBIDDEN",
        { s: r.status, code: r.json?.error?.code });
    }
    const injectDriver = await call("/drivers", seekerToken, {
      method: "POST",
      body: JSON.stringify({ fullName: "Injected Driver", phone: PHONE, nida: "199400112233445566" })
    });
    check("a seeker cannot create a driver — and so cannot mint NIDA records",
      injectDriver.status === 403, injectDriver.status);
    const trial = await call("/licence/trial", seekerToken, { method: "POST" });
    check("a seeker cannot start a licence trial in somebody else's company",
      trial.status === 403, trial.status);
    const anonTrial = await call("/licence/trial", null, { method: "POST" });
    check("a request with no credential is still answered 401, not 403",
      anonTrial.status === 401, anonTrial.status);

    // The audience gate and the permission gate must be tellable apart. /portal is
    // open to every external surface, but portal.view belongs to the shipper role,
    // so a seeker reaching it is stopped by the permission check, not by the gate —
    // which is what proves /seeker and /directory will be reachable once #100 builds
    // them behind the same open prefix.
    const portal = await call("/portal/overview", seekerToken);
    check("an open prefix with an ungranted key fails on the permission gate, not the audience gate",
      portal.status === 403 &&
      !/not available to portal accounts/.test(portal.json?.error?.message ?? "") &&
      /role does not allow/.test(portal.json?.error?.message ?? ""),
      { s: portal.status, m: portal.json?.error?.message });

    const seekerSurface = await call("/seeker/passes", seekerToken);
    const directorySurface = await call("/directory/search", seekerToken);
    check("the seeker and directory prefixes answer 404 from the router, not 403 from the gate",
      seekerSurface.status === 404 && directorySurface.status === 404,
      { seeker: seekerSurface.status, directory: directorySurface.status });

    // A freshly promoted account still carries its old role set inside a live token.
    // The gate re-reads user_roles before denying, or the promotion would lock a
    // person out of the surface they were just given.
    const promoted = await new SignJWT({
      tid: dir.tenant_id, sid: "00000000-0000-7000-8000-0000000000aa", typ: "seeker", roles: ["seeker"]
    }).setProtectedHeader({ alg: "HS256" }).setSubject(dir.user_id)
      .setIssuedAt().setExpirationTime("15m").sign(key);
    const promotedDrivers = await call("/drivers", promoted);
    check("a director whose stale token still says seeker is not locked out",
      promotedDrivers.status === 200,
      { s: promotedDrivers.status, code: promotedDrivers.json?.error?.code });

    const staffToken = await new SignJWT({
      tid: dir.tenant_id, sid: "00000000-0000-7000-8000-0000000000aa", typ: "director", roles: ["director"]
    }).setProtectedHeader({ alg: "HS256" }).setSubject(dir.user_id)
      .setIssuedAt().setExpirationTime("15m").sign(key);
    const staffDrivers = await call("/drivers", staffToken);
    check("control: the same route is 200 for an honest director token",
      staffDrivers.status === 200, staffDrivers.status);

    // ---------------- logout ----------------
    phase("logout");
    const loggedOut = await call("/auth/logout", null, {
      method: "POST", headers: { Cookie: cookieOf(refresh.headers) }
    });
    const revoked = (await oi(
      `select count(*)::int as n from sessions
        where user_id = $1 and revoked_reason = 'logout'`, [userId])).rows[0];
    check("logout revokes the seeker's live session by refresh-token hash",
      loggedOut.status === 200 && revoked?.n === 1,
      { s: loggedOut.status, revoked: revoked?.n });

    // ---------------- response hygiene ----------------
    phase("response hygiene");
    const leakMarkers = ["password_hash", "code_hash", "phone_encrypted", "destination_search",
      "nida_encrypted", "email_normalized_search", "Postgres", "duplicate key value violates",
      "node_modules", "FastifyError"];
    const leaks = transcript.filter((t) => leakMarkers.some((m) => t.includes(m)));
    check("no response body carried a credential column, a hash or an engine string",
      leaks.length === 0, leaks.map((l) => l.slice(0, 120)));
  } finally {
    await clearBuckets("signup:", "otp:", "otp-resend:", "login:");
    await sweep();
    const residue = await oi(
      `select (select count(*) from users where tenant_id = any($1::uuid[]))::int as users,
              (select count(*) from tenants where id = any($1::uuid[]))::int as tenants,
              (select count(*) from seekers where tenant_id = any($1::uuid[]))::int as seekers,
              (select count(*) from otp_codes where tenant_id = any($1::uuid[]))::int as otps,
              (select count(*) from sessions where tenant_id = any($1::uuid[]))::int as sessions,
              (select count(*) from user_roles where user_id = any($2::uuid[]))::int as roles,
              (select count(*) from rate_limits where bucket like 'signup:ip:%'
                 or bucket like 'otp%' or bucket like 'login:%')::int as buckets,
              (select count(*) from audit_logs where tenant_id = any($1::uuid[]))::int as audit_rows`,
      [ourTenants, userId ? [userId] : []]);
    const R = residue.rows[0];
    console.log(`cleanup: users=${R.users} tenants=${R.tenants} seekers=${R.seekers} otps=${R.otps} ` +
      `sessions=${R.sessions} | audit rows kept=${R.audit_rows} | throttle buckets cleared=${R.buckets}`);
    check("teardown left no seeker rows behind",
      R.users === 0 && R.tenants === 0 && R.seekers === 0 && R.otps === 0 &&
      R.sessions === 0 && R.roles === 0, R);
    await owner.end();
  }

  console.log(failures ? `${failures} FAILED` : "all seeker signup smoke checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
