/**
 * The platform staff desk — smoke for #103 over HTTP (routes on 067's duty split).
 *
 * Six seats in one platform tenant, differing only in their duty: a suspended Super
 * Admin whose token still works (that is the point — get_control_session never re-reads
 * users.status, which is exactly why this desk must revoke sessions when it suspends),
 * an active Super Admin, an analyst who may read and not write, a customer service agent
 * who may do neither, a director with no control key at all, and a staff-type account
 * that shares the tenant but is not platform staff. A second tenant holds a foreign
 * seat, because the verify script proves the SQL cannot see it and only HTTP proves the
 * route passes the caller's tenant rather than a query parameter.
 *
 * What it proves:
 *  - reading the roster and rewriting it are two duties, and `can_manage` tells the UI
 *    which one it is looking at;
 *  - the roster, the profile and the work log carry no payload and no encrypted
 *    identity — the forensic reader owns those, and it asks for a different key;
 *  - the last-admin guard fires on the state a write would PRODUCE, so a suspended
 *    admin cannot empty the desk of its only working key by demoting or suspending it;
 *  - a seat's company duties survive a platform-duty rewrite, and a company role cannot
 *    be granted from this desk at all;
 *  - suspension takes effect: the same cookie that worked a second earlier is 401
 *    afterwards, and the count of killed sessions is in the audit row;
 *  - a picture is a real picture (magic bytes, not a declared mimetype), it replaces the
 *    one before it rather than stacking, and the signed URL opens without a cookie.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-control-staff.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";
import { deleteObject, storageConfigured } from "../src/storage/supabase.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const TENANT_SWEEP = "Staff Smoke %";
const EMAIL_SWEEP = `smoke.staff.%@waisha.test`;

// A real 1x1 PNG — the route sniffs magic bytes, so a .png name on a text file is refused.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const bodies: string[] = [];
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
  bodies.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function postFile(path: string, cookie: string, file: Blob, name = "photo.png") {
  const fd = new FormData();
  fd.append("file", file, name);
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { Cookie: cookie }, body: fd });
  const text = await res.text();
  bodies.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const clearBuckets = async (...prefixes: string[]) => {
    for (const p of prefixes) await oi(`delete from rate_limits where bucket like $1`, [`${p}%`]);
  };

  const roleIds = (await oi(
    `select id, key from roles where tenant_id is null
       and key = any($1)`,
    [["super_admin", "platform_analyst", "compliance_officer", "customer_service_agent",
      "support_engineer", "director"]]
  )).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)?.id;
  if (!rid("super_admin") || !rid("platform_analyst") || !rid("director")) {
    throw new Error("global platform roles missing");
  }

  const TC = randomUUID();     // the desk
  const TB = randomUUID();     // another platform tenant, to prove the route scopes itself
  const uKEEP = randomUUID();  // suspended super admin, live token
  const uLAST = randomUUID();  // the only ACTIVE super admin on the desk
  const uAN = randomUUID();    // analyst: reads, never writes
  const uCS = randomUUID();    // customer service: no roster duty at all
  const uDIR = randomUUID();   // director: signed in, holds no control key
  const uOTH = randomUUID();   // analyst to be suspended
  const uSTF = randomUUID();   // staff-type account in the same tenant
  const uFOR = randomUUID();   // platform seat on the other desk

  const tok = (who: string) => `staff-smoke-${who}-${STAMP}`;
  const ck = (who: string) => ({ Cookie: `waisha_control=${tok(who)}` });
  const allUsers = [uKEEP, uLAST, uAN, uCS, uDIR, uOTH, uSTF, uFOR];

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    if (uids.length) {
      await oi(`delete from documents where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    }
    // A company role made by an earlier aborted run would hold the tenant alive.
    await oi(`delete from roles where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await clearBuckets("control-avatar:", "audit:", "costs:");

  // ---------------- fixtures ----------------
  await oi(`insert into tenants (id, type, name, status) values
      ($1,'platform',$2,'active'), ($3,'platform',$4,'active')`,
    [TC, `Staff Smoke Platform ${STAMP}`, TB, `Staff Smoke Foreign ${STAMP}`]);

  /** lastLoginMins is a number of minutes ago, or null for a seat that never signed in. */
  const seat = (id: string, tenant: string, type: string, name: string, email: string,
    status: string, lastLoginMins: number | null, title: string | null) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, job_title, email, status,
             totp_enabled, last_login_at, created_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,
                case when $9::int is null then null
                     else now() - make_interval(mins => $9::int) end,
                now() - interval '120 days')`,
      [id, tenant, type, name, title, email, status, status === "active", lastLoginMins]);
  await seat(uKEEP, TC, "platform", "Keeper Suspended", `smoke.staff.keeper.${STAMP}@waisha.test`,
    "suspended", 3 * 24 * 60, null);
  await seat(uLAST, TC, "platform", "Last Active Admin", `smoke.staff.last.${STAMP}@waisha.test`,
    "active", 40, "Head of the desk");
  await seat(uAN, TC, "platform", "Annie Analyst", `smoke.staff.an.${STAMP}@waisha.test`,
    "active", 120, null);
  await seat(uCS, TC, "platform", "Cally Service", `smoke.staff.cs.${STAMP}@waisha.test`,
    "active", null, null);
  await seat(uDIR, TC, "platform", "Daudi Director", `smoke.staff.dir.${STAMP}@waisha.test`,
    "active", 9 * 24 * 60, null);
  await seat(uOTH, TC, "platform", "Omar Analyst", `smoke.staff.oth.${STAMP}@waisha.test`,
    "active", 300, null);
  await seat(uSTF, TC, "staff", "Staff Not On Desk", `smoke.staff.stf.${STAMP}@waisha.test`,
    "active", 60, null);
  await seat(uFOR, TB, "platform", "Foreign Admin", `smoke.staff.for.${STAMP}@waisha.test`,
    "active", 10, null);

  await oi(`insert into user_roles (user_id, role_id) values
      ($1,$2), ($3,$2), ($4,$5), ($6,$5), ($7,$8), ($9,$10), ($11,$12)`,
    [uKEEP, rid("super_admin"), uLAST, uAN, rid("platform_analyst"), uOTH,
      uCS, rid("customer_service_agent"), uDIR, rid("director"), uFOR, rid("super_admin")]);
  // One of Annie's duties has already lapsed: it is neither a duty nor a permission.
  await oi(`insert into user_roles (user_id, role_id, expires_at)
            values ($1,$2, now() - interval '1 day')`, [uAN, rid("compliance_officer")]);
  // A company duty on a platform seat, which the desk must not be able to touch or grant.
  const officeRole = randomUUID();
  await oi(`insert into roles (id, tenant_id, key, name) values ($1,$2,$3,'Office clerk')`,
    [officeRole, TC, `office_clerk_${STAMP}`]);
  await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [uAN, officeRole]);

  const openSession = (uid: string, tenant: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-control-staff',$6,
          now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
  for (const [uid, tenant, who] of [
    [uKEEP, TC, "keeper"], [uLAST, TC, "last"], [uAN, TC, "an"], [uCS, TC, "cs"],
    [uDIR, TC, "dir"], [uOTH, TC, "oth"], [uFOR, TB, "for"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);
  const staffJWT = await mint(uSTF, TC, ["staff"]);

  const uids = allUsers;
  try {
    // ---------------- the door ----------------
    phase("authentication");
    const anon = await call("/control/staff", null);
    check("an anonymous request is turned away before the roster is read",
      anon.status === 401, { s: anon.status, e: anon.json?.error?.code });

    const forged = await call("/control/staff", null, {
      headers: { Cookie: `waisha_control=staff-smoke-no-session-${STAMP}` }
    });
    check("a cookie with no session row behind it is refused", forged.status === 401,
      { s: forged.status });

    const bearer = await call("/control/staff", staffJWT);
    check("a staff bearer token does not open the control surface — the cookie does",
      bearer.status === 401, { s: bearer.status });

    const anonWrite = await call(`/control/staff/${uAN}`, null, {
      method: "PATCH", body: JSON.stringify({ jobTitle: "handed out at the door" })
    });
    check("the desk cannot be written anonymously", anonWrite.status === 401,
      { s: anonWrite.status });

    // ---------------- whose duty is which ----------------
    phase("read is one duty, write is another");
    const asSA = await call("/control/staff", null, { headers: ck("last") });
    check("the Super Admin reads the roster and is told it may also write",
      asSA.status === 200 && asSA.json?.can_manage === true &&
      Array.isArray(asSA.json?.staff), { s: asSA.status });

    const asAN = await call("/control/staff", null, { headers: ck("an") });
    check("the analyst reads it too — control.staff.view is a real duty",
      asAN.status === 200 && asAN.json?.can_manage === false,
      { s: asAN.status, can: asAN.json?.can_manage });

    const anPatch = await call(`/control/staff/${uCS}`, null, {
      method: "PATCH", headers: ck("an"), body: JSON.stringify({ jobTitle: "no" })
    });
    check("…and is refused the pen: reading a roster is not editing one",
      anPatch.status === 403 && anPatch.json?.error?.code === "FORBIDDEN",
      { s: anPatch.status, m: anPatch.json?.error?.message });

    const anRoles = await call(`/control/staff/${uCS}/roles`, null, {
      method: "POST", headers: ck("an"), body: JSON.stringify({ roleKeys: ["billing_admin"] })
    });
    check("an analyst cannot hand out duties", anRoles.status === 403, { s: anRoles.status });

    const anStatus = await call(`/control/staff/${uCS}/status`, null, {
      method: "POST", headers: ck("an"),
      body: JSON.stringify({ status: "suspended", reason: "should not be possible" })
    });
    check("an analyst cannot suspend a seat", anStatus.status === 403, { s: anStatus.status });

    const anAvatar = await postFile(`/control/staff/${uCS}/avatar`,
      `waisha_control=${tok("an")}`, new Blob([PNG], { type: "image/png" }));
    check("nor hang a picture on somebody else's profile", anAvatar.status === 403,
      { s: anAvatar.status });

    const asCS = await call("/control/staff", null, { headers: ck("cs") });
    check("customer service is not on this desk at all — 403, not 200-and-empty",
      asCS.status === 403, { s: asCS.status });

    const asDIR = await call("/control/staff", null, { headers: ck("dir") });
    check("a director signed into the control shell holds no roster duty",
      asDIR.status === 403, { s: asDIR.status });

    const anRoles2 = await call("/control/staff/roles", null, { headers: ck("an") });
    check("the duty catalogue is a read, so the analyst may see what each role grants",
      anRoles2.status === 200 && (anRoles2.json?.roles ?? []).length >= 6 &&
      anRoles2.json.roles.every((r: any) => Array.isArray(r.permissions)),
      { s: anRoles2.status, n: anRoles2.json?.roles?.length });

    // ---------------- the roster ----------------
    phase("the roster");
    const staff: any[] = asSA.json.staff;
    const byId = (id: string) => staff.find((s: any) => s.user_id === id);
    check("every platform seat on this desk is listed",
      [uKEEP, uLAST, uAN, uCS, uDIR, uOTH].every((id) => !!byId(id)),
      staff.map((s: any) => s.full_name));
    check("an account that is not platform staff is not on a staff roster",
      !byId(uSTF) && !byId(uFOR), { n: staff.length });
    const onDesk = (await oi(
      `select id from users where tenant_id = $1 and user_type = 'platform'`, [TC]
    )).rows.map((r: any) => r.id);
    check("the roster is exactly this caller's tenant, and every platform seat in it",
      onDesk.every((id: string) => !!byId(id)) &&
      staff.every((s: any) => onDesk.includes(s.user_id)) &&
      staff.length === onDesk.length,
      { api: staff.length, db: onDesk.length });

    const foreignRoster = await call("/control/staff", null, { headers: ck("for") });
    check("the other desk lists only its own one seat",
      foreignRoster.status === 200 && foreignRoster.json?.staff?.length === 1 &&
      foreignRoster.json.staff[0].user_id === uFOR,
      { n: foreignRoster.json?.staff?.length });

    check("every row arrives with numbers where the charts need numbers",
      staff.every((s: any) => ["permission_count", "events_30d", "events_7d",
        "active_sessions"].every((k) => typeof s[k] === "number")),
      Object.entries(staff[0] ?? {}).filter(([, v]) => typeof v === "string").map(([k]) => k));

    check("duties are displayable: a key array and a name array of the same length",
      staff.every((s: any) => Array.isArray(s.roles) && Array.isArray(s.role_names) &&
        s.roles.length === s.role_names.length), staff.map((s: any) => s.roles));

    check("a lapsed delegation is not shown as a duty",
      JSON.stringify(byId(uAN)?.roles) === JSON.stringify(["platform_analyst"]),
      byId(uAN)?.roles);

    check("the newest sign-in leads and a seat that never signed in last",
      staff[0]?.user_id === uLAST && staff[staff.length - 1]?.user_id === uCS,
      staff.map((s: any) => [s.full_name, s.last_login_at]));

    check("granted_permissions is the desk's total, not a second query's guess",
      asSA.json.granted_permissions === staff.reduce((n: number, s: any) => n + s.permission_count, 0),
      { reported: asSA.json.granted_permissions });

    const rosterKeys = Object.keys(staff[0]);
    const LEAKY = ["encrypted", "_search", "nida", "phone", "password", "secret", "token",
      "otp_code", "before", "after", "user_agent"];
    check("a roster row carries no encrypted identity, hash or payload column",
      !rosterKeys.some((k) => LEAKY.some((p) => k.toLowerCase().includes(p))), rosterKeys.join(","));

    const q = await call(`/control/staff?q=${encodeURIComponent("Annie")}`, null, { headers: ck("last") });
    check("search by name finds one seat", q.status === 200 && q.json?.staff?.length === 1 &&
      q.json.staff[0].user_id === uAN, { n: q.json?.staff?.length });
    const qt = await call("/control/staff?q=Head%20of%20the%20desk", null, { headers: ck("last") });
    check("search by job title finds one seat", qt.status === 200 &&
      qt.json?.staff?.length === 1 && qt.json.staff[0].user_id === uLAST,
      { n: qt.json?.staff?.length });
    const qr = await call("/control/staff?role=super_admin", null, { headers: ck("last") });
    check("filtering by duty finds both Super Admins, including the suspended one",
      qr.status === 200 && (qr.json?.staff ?? []).length === 2 &&
      [uKEEP, uLAST].every((id) => qr.json.staff.some((s: any) => s.user_id === id)),
      { n: qr.json?.staff?.length });
    const qn = await call("/control/staff?q=zznothingzz", null, { headers: ck("last") });
    check("a term that matches nothing returns nothing, not everybody",
      qn.status === 200 && qn.json?.staff?.length === 0, { n: qn.json?.staff?.length });

    // ---------------- one person's duty profile ----------------
    phase("a duty profile");
    const prof = await call(`/control/staff/${uAN}?days=30`, null, { headers: ck("last") });
    const p = prof.json ?? {};
    check("the profile carries identity, duties, stats, charts and a log",
      prof.status === 200 && p.user_id === uAN && p.full_name === "Annie Analyst" &&
      p.status === "active" && Array.isArray(p.duties) && p.stats &&
      Array.isArray(p.workload) && Array.isArray(p.duty_mix) && Array.isArray(p.work_log) &&
      Array.isArray(p.permission_keys),
      { s: prof.status, keys: Object.keys(p) });

    check("a seat reading its own profile is told so, and another's is not",
      prof.json?.is_self === false);
    const own = await call(`/control/staff/${uAN}`, null, { headers: ck("an") });
    check("…and the same call made by Annie about Annie says is_self",
      own.status === 200 && own.json?.is_self === true, own.json?.is_self);

    check("progress is a comparison, not a bare count",
      typeof p.stats.events_in_window === "number" &&
      typeof p.stats.events_previous_window === "number" &&
      typeof p.stats.events_last_7d === "number" &&
      typeof p.stats.entities_touched === "number" &&
      typeof p.stats.days_active === "number" &&
      (p.stats.trend_pct === null || typeof p.stats.trend_pct === "number"),
      p.stats);

    check("the workload axis is exactly the window asked for, in plain date strings",
      p.workload.length === 30 &&
      p.workload.every((w: any) => /^\d{4}-\d{2}-\d{2}$/.test(w.day) && typeof w.events === "number"),
      { n: p.workload.length, first: p.workload[0], last: p.workload[p.workload.length - 1] });

    const p7 = await call(`/control/staff/${uAN}?days=7`, null, { headers: ck("last") });
    check("a shorter window is honoured", p7.status === 200 && p7.json?.workload?.length === 7 &&
      p7.json.stats.window_days === 7, { n: p7.json?.workload?.length });

    const pBad1 = await call("/control/staff/" + uAN + "?days=200", null, { headers: ck("last") });
    const pBad2 = await call("/control/staff/" + uAN + "?days=3", null, { headers: ck("last") });
    check("a window outside seven to one hundred and eighty days is refused",
      pBad1.status === 400 && pBad2.status === 400, { s: [pBad1.status, pBad2.status] });

    check("the work log is action and subject only — no payload reaches a roster",
      p.work_log.every((l: any) => !["before", "after", "ip", "user_agent"].some((k) => k in l)),
      Object.keys(p.work_log[0] ?? {}));

    const noSeat = await call(`/control/staff/${uSTF}`, null, { headers: ck("last") });
    check("a staff-type account in the same tenant is not a platform seat to open",
      noSeat.status === 404, { s: noSeat.status });
    const foreignSeat = await call(`/control/staff/${uFOR}`, null, { headers: ck("last") });
    check("nor is another tenant's seat — 404, so no write can be aimed at it either",
      foreignSeat.status === 404, { s: foreignSeat.status });
    const junk = await call("/control/staff/not-a-uuid", null, { headers: ck("last") });
    check("a malformed id is a 404, not a database error", junk.status === 404,
      { s: junk.status, e: junk.json?.error?.code });

    const anSeesProfile = await call(`/control/staff/${uLAST}`, null, { headers: ck("an") });
    check("the analyst may read a profile it cannot edit",
      anSeesProfile.status === 200 && anSeesProfile.json?.can_manage === false,
      { s: anSeesProfile.status });

    // ---------------- writing a seat ----------------
    phase("writing a seat");
    const patch = await call(`/control/staff/${uAN}`, null, {
      method: "PATCH", headers: ck("last"),
      body: JSON.stringify({ jobTitle: "Marketplace analyst", fullName: "Annie A. Analyst" })
    });
    check("a job title and a name can be set by the desk",
      patch.status === 200 && patch.json?.job_title === "Marketplace analyst" &&
      patch.json?.full_name === "Annie A. Analyst", { s: patch.status, b: patch.json });

    const patchKeep = await call(`/control/staff/${uAN}`, null, {
      method: "PATCH", headers: ck("last"), body: JSON.stringify({ jobTitle: null })
    });
    check("clearing a job title keeps the name — an absent field is not a wipe",
      patchKeep.status === 200 && patchKeep.json?.job_title === null &&
      patchKeep.json?.full_name === "Annie A. Analyst", patchKeep.json);

    const patchSneak = await call(`/control/staff/${uAN}`, null, {
      method: "PATCH", headers: ck("last"),
      body: JSON.stringify({ jobTitle: "x", status: "suspended" })
    });
    check("a status cannot be smuggled into a profile edit",
      patchSneak.status === 400, { s: patchSneak.status, e: patchSneak.json?.error?.code });

    const patchLong = await call(`/control/staff/${uAN}`, null, {
      method: "PATCH", headers: ck("last"), body: JSON.stringify({ jobTitle: "n".repeat(200) })
    });
    check("and an over-long title is refused before it reaches the table",
      patchLong.status === 400, { s: patchLong.status });

    const selfPatch = await call(`/control/staff/${uLAST}`, null, {
      method: "PATCH", headers: ck("last"), body: JSON.stringify({ jobTitle: "I write my own title" })
    });
    check("a seat may edit its own record from this desk — only duties and status are locked",
      selfPatch.status === 200, { s: selfPatch.status });

    const assign = await call(`/control/staff/${uCS}/roles`, null, {
      method: "POST", headers: ck("last"),
      body: JSON.stringify({ roleKeys: ["platform_analyst", "support_engineer"] })
    });
    check("duties can be handed to a seat that had none of them",
      assign.status === 200 &&
      JSON.stringify(assign.json?.roles) === JSON.stringify(["platform_analyst", "support_engineer"]),
      { s: assign.status, b: assign.json });
    const rosterAfterAssign = await call("/control/staff?role=support_engineer", null, { headers: ck("last") });
    check("…and the roster agrees, which is what the UI reads",
      (rosterAfterAssign.json?.staff ?? []).some((s: any) => s.user_id === uCS),
      rosterAfterAssign.json?.staff?.map((s: any) => s.roles));

    const replace = await call(`/control/staff/${uCS}/roles`, null, {
      method: "POST", headers: ck("last"), body: JSON.stringify({ roleKeys: ["customer_service_agent"] })
    });
    const csRow = (await call("/control/staff", null, { headers: ck("last") })).json.staff
      .find((s: any) => s.user_id === uCS);
    check("assigning replaces the set instead of stacking it, so a revoked duty is gone",
      replace.status === 200 && JSON.stringify(csRow?.roles) ===
      JSON.stringify(["customer_service_agent"]), csRow?.roles);

    const selfRoles = await call(`/control/staff/${uLAST}/roles`, null, {
      method: "POST", headers: ck("last"), body: JSON.stringify({ roleKeys: ["platform_analyst"] })
    });
    check("a seat cannot rewrite its own duties — that is how a platform loses its keys",
      selfRoles.status === 403, { s: selfRoles.status, m: selfRoles.json?.error?.message });

    const badRole = await call(`/control/staff/${uCS}/roles`, null, {
      method: "POST", headers: ck("last"),
      body: JSON.stringify({ roleKeys: [`office_clerk_${STAMP}`] })
    });
    check("a company's own role cannot be granted from the platform desk",
      badRole.status === 400, { s: badRole.status, e: badRole.json?.error?.code });

    const invented = await call(`/control/staff/${uCS}/roles`, null, {
      method: "POST", headers: ck("last"), body: JSON.stringify({ roleKeys: ["god_mode"] })
    });
    check("nor can an invented one", invented.status === 400, { s: invented.status });

    // `director` is a *global* role, so a tenant_id check alone would wave it through —
    // and hand the seat 207 keys over some company's own data.
    const companyTemplate = await call(`/control/staff/${uCS}/roles`, null, {
      method: "POST", headers: ck("last"), body: JSON.stringify({ roleKeys: ["director"] })
    });
    check("a global role with no control key is a company template, not a platform duty",
      companyTemplate.status === 400,
      { s: companyTemplate.status, e: companyTemplate.json?.error?.code });
    const catalogue = (await call("/control/staff/roles", null, { headers: ck("last") })).json.roles;
    check("…and it is not even offered",
      !catalogue.some((r: any) => r.key === "director") && catalogue.length >= 6,
      { n: catalogue.length, keys: catalogue.map((r: any) => r.key) });

    const anStill = await call(`/control/staff/${uAN}`, null, { headers: ck("last") });
    check("Annie kept her company duty through the desk's own writes",
      anStill.json.duties.length === 1 && anStill.json.duties[0].key === "platform_analyst",
      anStill.json.duties.map((d: any) => d.key));
    const officeStill = (await oi(
      `select count(*)::int as n from user_roles ur join roles r on r.id = ur.role_id
        where ur.user_id = $1 and r.key = $2`, [uAN, `office_clerk_${STAMP}`])).rows[0].n;
    check("…in the database as well as in the response", officeStill === 1, { officeStill });

    // ---------------- the last admin ----------------
    phase("nobody empties the desk");
    const keeperWorks = await call("/control/auth/me", null, { headers: ck("keeper") });
    check("a suspended Super Admin's live token still authenticates — get_control_session " +
      "is status-blind, which is why this desk must revoke sessions",
      keeperWorks.status === 200 && (keeperWorks.json?.roles ?? []).includes("super_admin"),
      { s: keeperWorks.status, j: keeperWorks.json });

    const demoteLast = await call(`/control/staff/${uLAST}/status`, null, {
      method: "POST", headers: ck("keeper"),
      body: JSON.stringify({ status: "suspended", reason: "would leave no admin at all" })
    });
    check("so even that seat cannot suspend the only ACTIVE Super Admin — 409",
      demoteLast.status === 409 && demoteLast.json?.error?.code === "CONFLICT",
      { s: demoteLast.status, e: demoteLast.json?.error?.code, m: demoteLast.json?.error?.message });

    const stripLast = await call(`/control/staff/${uLAST}/roles`, null, {
      method: "POST", headers: ck("keeper"), body: JSON.stringify({ roleKeys: [] })
    });
    check("nor strip its duty — the guard judges the state the write would produce",
      stripLast.status === 409, { s: stripLast.status });

    const lastStill = (await oi(
      `select status from users where id = $1`, [uLAST])).rows[0]?.status;
    check("and the refused writes changed nothing", lastStill === "active", { lastStill });

    const harmless = await call(`/control/staff/${uDIR}/status`, null, {
      method: "POST", headers: ck("keeper"),
      body: JSON.stringify({ status: "suspended", reason: "a director is not the safety net" })
    });
    check("the same write on a seat that is not the last admin is allowed",
      harmless.status === 200 && harmless.json?.status === "suspended",
      { s: harmless.status, b: harmless.json });

    const reason = await call(`/control/staff/${uDIR}/status`, null, {
      method: "POST", headers: ck("last"), body: JSON.stringify({ status: "active", reason: "x" })
    });
    check("a status change always says why — a one-letter reason is refused",
      reason.status === 400, { s: reason.status });

    // ---------------- suspension has to actually stop someone ----------------
    phase("suspension takes effect");
    const othBefore = await call("/control/auth/me", null, { headers: ck("oth") });
    check("Omar is signed in before it happens", othBefore.status === 200, { s: othBefore.status });

    const suspend = await call(`/control/staff/${uOTH}/status`, null, {
      method: "POST", headers: ck("last"),
      body: JSON.stringify({ status: "suspended", reason: "left the platform desk" })
    });
    check("suspending a seat reports how many live sessions died with it",
      suspend.status === 200 && suspend.json?.sessions_revoked === 1,
      { s: suspend.status, b: suspend.json });

    const othAfter = await call("/control/auth/me", null, { headers: ck("oth") });
    check("…and the same cookie is refused a second later",
      othAfter.status === 401, { s: othAfter.status });

    const rosterSuspended = await call("/control/staff", null, { headers: ck("last") });
    check("the suspended seat stays on the roster, marked off the desk",
      rosterSuspended.json.staff.find((s: any) => s.user_id === uOTH)?.status === "suspended" &&
      rosterSuspended.json.staff.find((s: any) => s.user_id === uOTH)?.active_sessions === 0,
      rosterSuspended.json.staff.find((s: any) => s.user_id === uOTH));

    const revokeOnly = await call(`/control/staff/${uAN}/sessions/revoke`, null, {
      method: "POST", headers: ck("last")
    });
    check("sessions can be ended without taking the seat off the desk — a lost phone",
      revokeOnly.status === 200 && typeof revokeOnly.json?.revoked === "number",
      { s: revokeOnly.status, b: revokeOnly.json });
    const anAfter = await call("/control/auth/me", null, { headers: ck("an") });
    check("…and her token really is gone", anAfter.status === 401, { s: anAfter.status });

    const selfStatus = await call(`/control/staff/${uLAST}/status`, null, {
      method: "POST", headers: ck("last"),
      body: JSON.stringify({ status: "deactivated", reason: "my own session out of service" })
    });
    check("a seat cannot put its own control session out of service from this desk",
      selfStatus.status === 403, { s: selfStatus.status });

    // ---------------- the picture ----------------
    phase("the picture");
    if (!storageConfigured()) {
      const gone = await call(`/control/staff/${uLAST}/avatar`, null, { headers: ck("last") });
      check("with no storage configured the desk says so instead of pretending",
        gone.status === 503, { s: gone.status });
      console.log("skip   storage is not configured — the upload checks did not run");
    } else {
      const none = await call(`/control/staff/${uCS}/avatar`, null, { headers: ck("last") });
      check("a seat with no picture on file answers 404, so the UI shows the monogram",
        none.status === 404, { s: none.status });

      const fake = await postFile(`/control/staff/${uLAST}/avatar`, `waisha_control=${tok("last")}`,
        new Blob(["pretend this is a png"], { type: "image/png" }));
      check("a text file declared as image/png is refused — the sniff, not the browser, decides",
        fake.status === 400, { s: fake.status, m: fake.json?.error?.message });

      const pdf = await postFile(`/control/staff/${uLAST}/avatar`, `waisha_control=${tok("last")}`,
        new Blob([Buffer.from("%PDF-1.4 fake pdf bytes here")], { type: "application/pdf" }));
      check("a document is not a picture", pdf.status === 400, { s: pdf.status });

      const huge = await postFile(`/control/staff/${uLAST}/avatar`, `waisha_control=${tok("last")}`,
        new Blob([Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)])], { type: "image/png" }));
      check("a picture over the cap is refused before it is stored", huge.status === 400,
        { s: huge.status });

      const up = await postFile(`/control/staff/${uLAST}/avatar`, `waisha_control=${tok("last")}`,
        new Blob([PNG], { type: "image/png" }), "photo.png");
      check("a real PNG uploads and is recorded against the seat",
        up.status === 200 && up.json?.id && up.json?.replaced === 0 &&
        up.json?.size_bytes === PNG.length, { s: up.status, b: up.json });

      const shown = (await call("/control/staff", null, { headers: ck("last") })).json.staff
        .find((s: any) => s.user_id === uLAST);
      check("the roster now carries the picture's document id",
        shown?.avatar_document_id === up.json?.id, { got: shown?.avatar_document_id });

      const signed = await call(`/control/staff/${uLAST}/avatar`, null, { headers: ck("last") });
      check("the desk hands out a signed URL rather than the bytes",
        signed.status === 200 && /^https?:\/\//.test(String(signed.json?.url)) &&
        signed.json?.id === up.json?.id, { s: signed.status, url: signed.json?.url?.slice(0, 60) });

      const img = await fetch(String(signed.json?.url));
      const got = Buffer.from(await img.arrayBuffer());
      check("…and the signed link opens without any cookie and returns the same PNG",
        img.status === 200 && got.length === PNG.length &&
        got.subarray(0, 8).equals(PNG.subarray(0, 8)),
        { s: img.status, n: got.length, ct: img.headers.get("content-type") });

      const up2 = await postFile(`/control/staff/${uLAST}/avatar`, `waisha_control=${tok("last")}`,
        new Blob([PNG], { type: "image/png" }), "second.png");
      check("a second picture replaces the first instead of stacking behind it",
        up2.status === 200 && up2.json?.replaced === 1 && up2.json?.id !== up.json?.id,
        { s: up2.status, b: up2.json });
      const docs = (await oi(
        `select deleted_at is not null as retired from documents
          where tenant_id = $1 and entity_type='user' and entity_id = $2 and kind='avatar'
          order by created_at`, [TC, uLAST])).rows;
      check("…with the old row retired, not deleted, so the trail still points at it",
        docs.length === 2 && docs[0].retired === true && docs[1].retired === false,
        { docs });

      const forOther = await postFile(`/control/staff/${uFOR}/avatar`,
        `waisha_control=${tok("last")}`, new Blob([PNG], { type: "image/png" }));
      check("a picture cannot be attached to another tenant's seat",
        forOther.status === 404, { s: forOther.status });
    }

    // ---------------- the trail these writes left ----------------
    phase("the trail");
    const tr = await call(`/control/audit?actorUserId=${uLAST}&limit=400`,
      null, { headers: ck("last") });
    const mine = (tr.json ?? []).filter((r: any) =>
      String(r.action).startsWith("control.staff."));
    const acts = [...new Set(mine.map((r: any) => r.action))];
    check("every write this desk made is in the forensic trail, attributed",
      tr.status === 200 && ["control.staff.profile_updated", "control.staff.roles_assigned",
        "control.staff.status_changed", "control.staff.sessions_revoked"]
        .every((a) => acts.includes(a)), { acts });
    const suspended = mine.find((r: any) => r.action === "control.staff.status_changed" &&
      r.after?.status === "suspended" && r.after?.sessions_revoked === 1);
    check("the suspension entry records the reason and how many sessions it killed",
      !!suspended && suspended.after?.reason === "left the platform desk" &&
      suspended.before?.status === "active", suspended);
    check("a duty entry shows the set before and after, so a revoked key is traceable",
      mine.some((r: any) => r.action === "control.staff.roles_assigned" &&
        Array.isArray(r.before?.roles) && Array.isArray(r.after?.roles)),
      mine.find((r: any) => r.action === "control.staff.roles_assigned")?.after);

    const csTrail = await call(`/control/audit?limit=5`, null, { headers: ck("cs") });
    check("the seat that may not see the roster may not see the trail either",
      csTrail.status === 403, { s: csTrail.status });

    // ---------------- nothing leaks ----------------
    phase("leak scan");
    const LEAKS = ["syntax error at or near", "duplicate key value violates",
      "insert into", "node_modules", "Postgres", "app_runtime", "refresh_token_hash",
      "$2b$", "encrypted"];
    const hit = LEAKS.filter((m) => bodies.some((b) => b.toLowerCase().includes(m.toLowerCase())));
    check("no engine string, credential column or hash ever reached a client",
      hit.length === 0, hit);

    const emails = staff.filter((s: any) => !String(s.email ?? "").startsWith("smoke.staff."));
    check("the roster only ever carries a seat's own work address", emails.length === 0, emails);
  } finally {
    // ---------------- teardown ----------------
    phase("teardown");
    const paths = (await oi(
      `select storage_path from documents where tenant_id = any($1::uuid[])`, [[TC, TB]]
    )).rows.map((r: any) => r.storage_path);
    await oi(`delete from documents where tenant_id = any($1::uuid[])`, [[TC, TB]]).catch(() => { });
    if (storageConfigured()) {
      for (const path of paths) await deleteObject(path).catch(() => { });
    }
    // Grants go before the role they point at — the reverse order is an FK wall.
    await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi("delete from roles where id = $1", [officeRole]).catch(() => { });
    await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await clearBuckets("control-avatar:", "audit:", "costs:");
    await oi(`delete from users where id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [[TC, TB]]).catch(() => { });
    await sweep();

    const residue = await oi(
      `select (select count(*) from documents where tenant_id = any($1::uuid[])) as docs,
              (select count(*) from roles where id = $2) as role,
              (select count(*) from user_roles where user_id = any($1::uuid[])) as grants,
              (select count(*) from sessions where user_id = any($1::uuid[])) as sessions,
              (select count(*) from users where id = any($1::uuid[])) as users,
              (select count(*) from tenants where id = any($1::uuid[])) as tenants,
              (select count(*) from tenants where name like $3) as smoke_tenants,
              (select count(*) from users where email like $4) as smoke_users,
              (select count(*) from rate_limits where bucket like 'control-avatar:%') as buckets`,
      [uids, officeRole, TENANT_SWEEP, EMAIL_SWEEP]);
    check("cleanup: no fixture row, duty, session, picture or bucket survives the run " +
      "(the audit trail is append-only and stays)",
      Object.values(residue.rows[0]).every((n: any) => Number(n) === 0), residue.rows[0]);
    await owner.end();
  }

  console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURE(S)`} — smoke-control-staff`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
