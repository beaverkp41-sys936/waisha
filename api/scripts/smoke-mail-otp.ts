/**
 * Mail-verified signup smoke — the CFA / office bundles, the email code, the register and
 * the two error paths the office reported (112, #129).
 *
 * Run: npx tsx scripts/smoke-mail-otp.ts   (API on :4000, RESEND_API_KEY set in api/.env)
 *
 * What this can prove and what it cannot, stated up front: with a Resend key whose domain
 * is not yet verified, the provider accepts the send only for the account owner's own
 * address and refuses every other recipient. So the assertions below are about the shape of
 * the answer and the evidence left behind — a code stored against the email hash, one
 * register line per attempt with the provider's own words, and a client that is told the
 * truth in `codeSent` — rather than about a message landing in somebody's inbox. That
 * inbox test is the one thing this suite cannot do, and says so.
 */
import "dotenv/config";
import pg from "pg";
import { searchHash } from "../src/util/crypto.js";
import { hashOtp, maskEmail } from "../src/security/otp.js";

const API = "http://localhost:4000/api/v1";
const STAMP = Date.now().toString().slice(-8);
const PASSWORD = `Ml-${STAMP}-Q7!m`;
const OTP_KNOWN = "864213";
const EMAIL_SWEEP = `%.${STAMP}@waisha.test`;
const NAME_SWEEP = `Mail % ${STAMP}`;

/** The three bundles the sign-up card offers. Each one is signed up for real, because the
 *  office's report was that a CFA choosing "CFA" or "Office" errored — a single bundle
 *  passing proves nothing about the other two. */
const BUNDLES = [
  { key: "cfa_office", label: "CFA", tinHead: "1" },
  { key: "transport_office", label: "Office", tinHead: "2" },
  { key: "transport_cfa_office", label: "CFA + Office", tinHead: "3" }
] as const;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const clearBuckets = async (...prefixes: string[]) => {
    for (const p of prefixes) await oi(`delete from rate_limits where bucket like $1`, [`${p}%`]);
  };

  const tenantIds: string[] = [];
  const userIds: string[] = [];
  const sweep = async () => {
    const ids = (await oi(
      `select id, tenant_id from users where email like $1`, [EMAIL_SWEEP])).rows;
    if (!ids.length) return;
    const uids = ids.map((r: any) => r.id);
    const tids = [...new Set(ids.map((r: any) => r.tenant_id))];
    tenantIds.push(...tids); userIds.push(...uids);
    await oi(`delete from message_deliveries where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from otp_codes where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from password_resets where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    // The licence walk below claims a trial, and claim_trial writes a subscription that
    // points at the tenant. Referencing rows go first or the company cannot be taken out.
    await oi(`delete from payments where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from invoices where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from subscriptions where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from sessions where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [tids]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [tids]).catch(() => { });
  };
  await sweep();
  await clearBuckets("signup:", "otp:", "otp-resend:", "forgot:", "reset:", "login:", "trial:");

  console.log(`stamp ${STAMP} — API on :4000`);

  // ---------------- the price list the card draws from ----------------
  phase("bundles on sale");
  const groups = await call("/content/service-groups");
  // The door answers a bare array, not an envelope — a suite that reads `json.groups`
  // off it would report an empty price list and call that a bug in the platform.
  const offered: string[] = (Array.isArray(groups.json) ? groups.json
    : groups.json?.groups ?? groups.json?.items ?? []).map((g: any) => g.key);
  check("the price list answers the whole row the card prices itself from",
    offered.length >= 3, offered);
  for (const b of BUNDLES) {
    check(`GET /content/service-groups still lists ${b.key}`, offered.includes(b.key), offered);
  }

  // ---------------- three signups, one per bundle ----------------
  phase("signup");
  const made: Array<{ bundle: typeof BUNDLES[number]; userId: string; tenantId: string;
    email: string; tin: string; codeSent: unknown; resendAt: string }> = [];
  for (const b of BUNDLES) {
    const email = `${b.key}.${STAMP}@waisha.test`;
    const tin = `${b.tinHead}${STAMP}`;
    const r = await call("/auth/transporter/signup", {
      method: "POST",
      body: JSON.stringify({
        companyName: `Mail ${b.label} ${STAMP} Ltd`, tin, phone: `+2557${b.tinHead}${STAMP.slice(0, 7)}`,
        email, password: PASSWORD, confirmPassword: PASSWORD,
        serviceGroup: b.key, acceptTerms: true
      })
    });
    check(`${b.label} company signup → 201`, r.status === 201, { s: r.status, b: r.json });
    if (r.status !== 201) continue;
    made.push({ bundle: b, userId: r.json.userId, tenantId: "", email, tin,
      codeSent: r.json.codeSent, resendAt: r.json.resendAt });

    // The reply is what the screen renders, so every part of it has to be in it.
    check(`${b.label}: channel is email and the address comes back masked`,
      r.json.channel === "email" && r.json.emailMasked === maskEmail(email),
      { channel: r.json.channel, masked: r.json.emailMasked });
    const waitMs = new Date(r.json.resendAt ?? 0).getTime() - Date.now();
    check(`${b.label}: resendAt is in the future, so the countdown is real`,
      typeof r.json.codeSent === "boolean" && waitMs > 0,
      { codeSent: r.json.codeSent, waitMs });

    const seat = (await oi(`select tenant_id from users where id = $1`, [r.json.userId])).rows[0];
    made[made.length - 1].tenantId = seat?.tenant_id ?? "";
    const otp = (await oi(
      `select purpose, channel, destination_search, expires_at > now() as live
         from otp_codes where user_id = $1 order by created_at desc limit 1`,
      [r.json.userId])).rows[0];
    check(`${b.label}: the code is stored against the email hash, not the phone`,
      otp?.purpose === "signup" && otp?.channel === "email" &&
      otp?.destination_search === searchHash(email) && otp?.live === true, otp);

    const listed = (await oi(
      `select service_group_id from tenants where id = $1`, [seat?.tenant_id])).rows[0];
    const sg = (await oi(
      `select key from service_groups where id = $1`, [listed?.service_group_id])).rows[0];
    check(`${b.label}: the tenant is filed under the bundle that was asked for`,
      sg?.key === b.key, sg);
  }
  if (made.length !== BUNDLES.length) throw new Error("a signup failed; stopping before verification");

  // ---------------- the delivery register ----------------
  phase("delivery register");
  const reg = await oi(
    `select id, channel, purpose, status, to_masked, subject, error, provider_message_id, attempts, user_id
       from message_deliveries
      where user_id = any($1::uuid[]) order by created_at`, [made.map(m => m.userId)]);
  check("one register line per signup attempt", reg.rowCount === made.length, reg.rowCount);
  for (const row of reg.rows) {
    check(`${row.purpose}/${row.status} to ${row.to_masked}: masked, never a full address`,
      /^\S\*\*\*@/.test(String(row.to_masked)) && !row.to_masked.includes(row.user_id),
      { to_masked: row.to_masked });
    check(`${row.purpose}/${row.status}: status is a real outcome, not the 'skipped' of a missing key`,
      row.status === "sent" || row.status === "failed", { status: row.status, error: row.error });
    if (row.status === "failed") {
      check(`${row.purpose}: a refused send keeps the provider's words and the attempt count`,
        /\d{3}/.test(String(row.error)) && row.attempts >= 1,
        { error: String(row.error).slice(0, 60), attempts: row.attempts });
    }
  }
  const leaked = reg.rows.filter(r => String(r.error ?? "").includes("@waisha.test"));
  check("no register line quotes an address this suite created", leaked.length === 0,
    leaked.map(l => l.id));

  // ---------------- the code the person is waiting for ----------------
  phase("verify and sign in");
  const cfa = made.find(m => m.bundle.key === "cfa_office")!;
  await oi(`update otp_codes set attempts = 0, locked_until = null, code_hash = $2
            where user_id = $1 and purpose = 'signup' and expires_at > now()`,
    [cfa.userId, hashOtp(OTP_KNOWN)]);
  await clearBuckets("otp:");
  const verified = await call("/auth/otp/verify", {
    method: "POST", body: JSON.stringify({ userId: cfa.userId, code: OTP_KNOWN })
  });
  check("correct email code → 200", verified.status === 200, { s: verified.status, b: verified.json });

  const after = (await oi(
    `select u.status as user_status, t.status as tenant_status,
            coalesce((select array_agg(r.key) from user_roles ur
                       join roles r on r.id = ur.role_id where ur.user_id = u.id), '{}') as roles
       from users u join tenants t on t.id = u.tenant_id where u.id = $1`, [cfa.userId])).rows[0];
  check("the director went active and got its duty",
    after?.user_status === "active" && (after?.roles ?? []).includes("director"), after);
  // A company does not become live when the code is typed: it becomes live when it takes
  // a trial or the office activates it (008). Asserting 'active' here would be asserting a
  // flow the platform never claimed to run — and would hide the state a new CFA actually
  // lands in, which is the one that has to answer on the licence door below.
  check("the company is still held for its first licence decision",
    after?.tenant_status === "pending_verification", after);

  const signIn = await call("/auth/login", {
    method: "POST",
    body: JSON.stringify({ mode: "transporter", tin: cfa.tin, email: cfa.email, password: PASSWORD })
  });
  check("the verified CFA signs in with TIN + email", signIn.status === 200 && !!signIn.json?.accessToken,
    { s: signIn.status, m: signIn.json?.error?.message });
  const bearer = (path: string, init: RequestInit = {}) => call(path, {
    ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${signIn.json.accessToken}` }
  });

  // ---------------- the gate a new company is standing in front of ----------------
  // 113: tenant_is_operational() answered `not exists` of its own live-licence test, so
  // GET /licence published the opposite of the truth and the banner read "Trial ended —
  // read-only" on the first morning of a live trial. Both directions are asserted here
  // because one of them is what a paid company sees and the other is what a lapsed one
  // must see; a suite that only checked the good case would pass on the inverted copy.
  phase("the 48-hour trial and the licence gate");
  const held = await bearer("/licence");
  check("a company that has not chosen reads /licence as not operational",
    held.json?.tenant_status === "pending_verification" && held.json?.operational === false,
    { status: held.json?.tenant_status, operational: held.json?.operational });

  const claimed = await bearer("/licence/trial", { method: "POST" });
  check("the director starts the 48-hour trial", claimed.status === 200 && claimed.json?.status === "ok",
    { s: claimed.status, b: claimed.json, e: claimed.json?.error });

  const running = await bearer("/licence");
  check("a live trial reads operational — this is the row 113 turned around",
    running.json?.tenant_status === "trial" && running.json?.operational === true &&
    !!running.json?.trial_ends_at,
    { status: running.json?.tenant_status, operational: running.json?.operational });

  const again = await bearer("/licence/trial", { method: "POST" });
  check("one trial per company: a second claim is refused, not silently granted",
    again.status === 409, { s: again.status, m: again.json?.error?.message });

  await oi(`update tenants set trial_ends_at = now() - interval '1 hour' where id = $1`,
    [cfa.tenantId]);
  const lapsed = await bearer("/licence");
  check("an ended trial reads operational=false, so the banner tells the truth",
    lapsed.json?.operational === false, { operational: lapsed.json?.operational });

  // ---------------- the two paths that used to answer "unexpected error" ----------------
  phase("resend cooldown and forgot-password");
  const office = made.find(m => m.bundle.key === "transport_office")!;
  const tooSoon = await call("/auth/otp/resend", {
    method: "POST", body: JSON.stringify({ userId: office.userId })
  });
  check("a resend inside the window answers 429 and names the wait",
    tooSoon.status === 429 && /Please wait \d+s/.test(String(tooSoon.json?.error?.message)),
    { s: tooSoon.status, m: tooSoon.json?.error?.message });

  await oi(`update otp_codes set created_at = now() - interval '3 minutes'
            where user_id = $1 and purpose = 'signup'`, [office.userId]);
  await clearBuckets("otp-resend:");
  const resent = await call("/auth/otp/resend", {
    method: "POST", body: JSON.stringify({ userId: office.userId })
  });
  check("after the window a resend answers 200 and reports whether it went",
    resent.status === 200 && typeof resent.json?.codeSent === "boolean" &&
    resent.json?.channel === "email", { s: resent.status, b: resent.json });
  const resendLine = (await oi(
    `select purpose, status, to_masked from message_deliveries
      where user_id = $1 and purpose = 'otp_resend' order by created_at desc limit 1`,
    [office.userId])).rows[0];
  check("the resend is its own line in the register", resendLine?.purpose === "otp_resend", resendLine);

  // A person who forgets their password twice a day is the other half of the "too many
  // attempts" complaint: the answer has to say how long to wait, and the same email must
  // be counted whatever IP it came from.
  await clearBuckets("forgot:");
  const forgot: number[] = [];
  for (let i = 0; i < 7; i++) {
    const f = await call("/auth/forgot-password", {
      method: "POST", body: JSON.stringify({ email: cfa.email })
    });
    forgot.push(f.status);
    if (f.status === 429) {
      check("the forgot-password ceiling tells the caller when to come back",
        /try again in about/.test(String(f.json?.error?.message)) &&
        Number(f.json?.error?.details?.[0]?.retryIn) > 0,
        { m: f.json?.error?.message, d: f.json?.error?.details });
    }
  }
  check("the first five reset asks answer the same neutral way, then the ceiling",
    forgot.slice(0, 5).every(s => s === 200) && forgot.slice(5).every(s => s === 429), forgot);
  check("the ceiling counts the address, not only the connection",
    forgot[5] === 429, { statuses: forgot });

  // 113's sibling: the connection ceiling used to be the same 5, so a sixth clerk on the
  // office's shared +255 line was told "too many attempts" by somebody else's forgotten
  // password. This address was never asked about before, so a 429 here means the ceiling
  // is still being counted per connection rather than per inbox.
  const unknown = await call("/auth/forgot-password", {
    method: "POST", body: JSON.stringify({ email: `nobody.${STAMP}@waisha.test` })
  });
  check("a second address from the same connection is not punished for the first",
    unknown.status === 200 && typeof unknown.json?.message === "string",
    { s: unknown.status, m: unknown.json?.error?.message });

  const resetLines = await oi(
    `select status, to_masked from message_deliveries
      where purpose = 'password_reset' and created_at >= now() - interval '5 minutes'`);
  check("every reset attempt reached the register too", (resetLines.rowCount ?? 0) >= 1,
    resetLines.rows.map(r => r.status));

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${made.length} companies signed up, `
    + `${reg.rowCount} register line(s) written.`);
  console.log("Not provable here: that an inbox received anything. Resend refuses every");
  console.log("recipient but the account owner until a sending domain is verified, so the");
  console.log("inbound half of this test is the one a person has to look at.");

  await sweep();
  await clearBuckets("signup:", "otp:", "otp-resend:", "forgot:", "reset:", "login:", "trial:");
  const left = (await oi(
    `select count(*)::int as n from tenants where name like $1`, [NAME_SWEEP])).rows[0];
  check("teardown took the fixtures out", left?.n === 0, left);
  const orphans = await oi(
    `select count(*)::int as n from message_deliveries where user_id = any($1::uuid[])`,
    [userIds]);
  check("teardown took the register lines out", orphans.rows[0]?.n === 0, orphans.rows[0]);

  await owner.end();
  if (failures) process.exitCode = 1;
}

main().catch(async e => {
  console.log("smoke failed:", String(e).slice(0, 400));
  process.exitCode = 1;
});
