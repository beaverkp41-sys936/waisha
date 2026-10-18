/**
 * The platform org chart over HTTP — smoke for #130c (routes on migration 084).
 *
 * verify-departments-sql.ts already proves the statements and the indexes; this proves the
 * parts a database cannot: that the route passes the caller's own tenant rather than a
 * query parameter, that reading the chart and reshaping it are two different duties, that a
 * cover date survives the trip through Dar es Salaam as the day the person named, and that
 * every move leaves a sentence in the register that the audit trail can be matched against.
 *
 * Fixtures are two platform tenants of this run's own — never the desk the real platform
 * sits on — and everything is torn down by those ids. The writes stay under the route's own
 * rate ceilings so a 429 can never be mistaken for a broken guard.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-control-departments.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const TENANT_SWEEP = "Dept Smoke %";
const EMAIL_SWEEP = `smoke.dept.%@waisha.test`;

const HOUR = 3600000, DAY = 24 * HOUR;
/** Dar es Salaam is UTC+3 all year, so a cover day means that day at 23:59 there. */
function darDate(ms: number): string {
  const d = new Date(ms + 3 * HOUR);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const COVER_DAY = darDate(Date.now() + 12 * DAY);

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
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "platform_analyst", "support_engineer", "customer_service_agent", "director"]]
  )).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)?.id;
  if (!rid("super_admin") || !rid("platform_analyst")) throw new Error("global platform roles missing");

  const TC = randomUUID();        // the desk this run works on
  const TB = randomUUID();        // another platform tenant, to prove the route scopes itself
  const uSA = randomUUID();       // Super Admin: reads and reshapes
  const uAN = randomUUID();       // analyst: reads only
  const uCS = randomUUID();       // customer service: neither duty
  const uDIR = randomUUID();      // director: signed in, holds no control key
  const u1 = randomUUID();        // plain seat, will head the support desk
  const u2 = randomUUID();        // plain seat, will be an acting head on a cover
  const u3 = randomUUID();        // plain seat, will be moved and then released
  const uSus = randomUUID();      // suspended: on the platform, not placeable
  const uStf = randomUUID();      // staff-type in the same tenant: not a platform seat
  const uFor = randomUUID();      // Super Admin of the other tenant

  const tok = (who: string) => `dept-smoke-${who}-${STAMP}`;
  const ck = (who: string) => ({ Cookie: `waisha_control=${tok(who)}` });
  const allUsers = [uSA, uAN, uCS, uDIR, u1, u2, u3, uSus, uStf, uFor];

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    // The register is append-only for the app role and this table has a mutation trigger:
    // only the owner, which bypasses it, can take a smoke's own evidence away.
    await oi(`delete from platform_duty_transitions where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    await oi(`delete from platform_seat_departments where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    await oi(`delete from platform_departments where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await clearBuckets("dept:uid:", "dept-register:uid:", "dept-write:uid:", "audit:");

  // ---------------- fixtures ----------------
  await oi(`insert into tenants (id, type, name, status) values
      ($1,'platform',$2,'active'), ($3,'platform',$4,'active')`,
    [TC, `Dept Smoke Platform ${STAMP}`, TB, `Dept Smoke Foreign ${STAMP}`]);

  const seat = (id: string, tenant: string, type: string, name: string, status: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
             last_login_at, created_at)
        values ($1,$2,$3,$4,$5,$6,$7, now() - interval '2 hours', now() - interval '200 days')`,
      [id, tenant, type, name, `smoke.dept.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`,
        status, status === "active"]);
  await seat(uSA, TC, "platform", "Sada Admin", "active");
  await seat(uAN, TC, "platform", "Annie Analyst", "active");
  await seat(uCS, TC, "platform", "Cally Service", "active");
  await seat(uDIR, TC, "platform", "Daudi Director", "active");
  await seat(u1, TC, "platform", "Ephant First", "active");
  await seat(u2, TC, "platform", "Faida Second", "active");
  await seat(u3, TC, "platform", "Gito Third", "active");
  await seat(uSus, TC, "platform", "Hassan Suspended", "suspended");
  await seat(uStf, TC, "staff", "Ishma Company", "active");
  await seat(uFor, TB, "platform", "Juma Otherdesk", "active");

  await oi(`insert into user_roles (user_id, role_id) values
      ($1,$2), ($3,$4), ($5,$6), ($7,$8), ($9,$2)`,
    [uSA, rid("super_admin"), uAN, rid("platform_analyst"), uCS, rid("customer_service_agent"),
      uDIR, rid("director"), uFor]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2), ($3,$2), ($4,$2), ($5,$2)`,
    [u1, rid("support_engineer"), u2, u3, uSus]);

  const openSession = (uid: string, tenant: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-control-departments',$6,
          now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
  for (const [uid, tenant, who] of [
    [uSA, TC, "sa"], [uAN, TC, "an"], [uCS, TC, "cs"], [uDIR, TC, "dir"], [uFor, TB, "for"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);

  let support = "", ops = "", retired = "";

  try {
    // ---------------- the door ----------------
    phase("authentication");
    const anon = await call("/control/departments", null);
    check("an anonymous request is turned away before the chart is read", anon.status === 401,
      { s: anon.status });
    const forged = await call("/control/departments", null,
      { headers: { Cookie: `waisha_control=dept-smoke-no-session-${STAMP}` } });
    check("a cookie with no session row behind it is refused", forged.status === 401,
      { s: forged.status });
    const bearer = await call("/control/departments", await mint(uSA, TC, ["super_admin"]));
    check("a bearer token does not open the control surface — the cookie does", bearer.status === 401,
      { s: bearer.status });
    const anonWrite = await call("/control/departments", null, {
      method: "POST", body: JSON.stringify({ key: "sneak", name: "Written at the door" })
    });
    check("nor can the chart be reshaped anonymously", anonWrite.status === 401,
      { s: anonWrite.status });

    // ---------------- two duties ----------------
    phase("read is one duty, reshape is another");
    const asSA = await call("/control/departments", null, { headers: ck("sa") });
    check("the Super Admin reads the chart and is told it may also reshape it",
      asSA.status === 200 && asSA.json?.can_manage === true &&
      Array.isArray(asSA.json?.departments) && asSA.json?.summary, { s: asSA.status });
    const asAN = await call("/control/departments", null, { headers: ck("an") });
    check("the analyst reads the same chart with the pen taken away",
      asAN.status === 200 && asAN.json?.can_manage === false,
      { s: asAN.status, can: asAN.json?.can_manage });

    const writeBy = (path: string, body: object) =>
      call(path, null, { method: "POST", headers: ck("an"), body: JSON.stringify(body) });
    const anOpen = await writeBy("/control/departments",
      { key: "analyst_desk", name: "A desk nobody asked for" });
    check("…and an analyst cannot open a desk", anOpen.status === 403,
      { s: anOpen.status, m: anOpen.json?.error?.message });

    // A duty the seat holds but the navigation never probes is invisible: the desk is
    // reachable by URL and unreadable by eye. control-analytics.routes.ts keeps the list.
    const navSA = await call("/control/auth/permissions", null, { headers: ck("sa") });
    check("the navigation is told the Super Admin may read and reshape the chart",
      navSA.status === 200 &&
      (navSA.json?.permissions ?? []).includes("control.departments.view") &&
      (navSA.json?.permissions ?? []).includes("control.departments.manage"),
      { s: navSA.status });
    const navAN = await call("/control/auth/permissions", null, { headers: ck("an") });
    check("…and an analyst is offered the chart but never the pen",
      (navAN.json?.permissions ?? []).includes("control.departments.view") &&
      !(navAN.json?.permissions ?? []).includes("control.departments.manage"),
      { s: navAN.status, p: navAN.json?.permissions });

    // ---------------- opening desks ----------------
    phase("opening desks");
    const mkSupport = await call("/control/departments", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ key: "verify_support", name: "Smoke Support", purpose: "Answers the companies.", sort: 10 })
    });
    support = mkSupport.json?.id ?? "";
    check("a desk is opened with its key, name, order and a flag that it is live",
      mkSupport.status === 200 && mkSupport.json?.key === "verify_support" &&
      mkSupport.json?.is_active === true, { s: mkSupport.status, b: mkSupport.json });
    const mkOps = await call("/control/departments", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ key: "verify_ops", name: "Smoke Operations", sort: 20 })
    });
    ops = mkOps.json?.id ?? "";
    const mkRetired = await call("/control/departments", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ key: "verify_retired", name: "Smoke Retired", sort: 90 })
    });
    retired = mkRetired.json?.id ?? "";
    check("the other two desks open beside it", !!ops && !!retired && mkOps.status === 200
      && mkRetired.status === 200);

    const dupe = await call("/control/departments", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ key: "verify_support", name: "Second support desk" })
    });
    check("a key already answered to is refused, by name, before the index sees it",
      dupe.status === 409 && /Smoke Support/.test(dupe.json?.error?.message ?? ""),
      { s: dupe.status, m: dupe.json?.error?.message });
    const caps = await call("/control/departments", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ key: "Verify_Support", name: "Shouted key" })
    });
    check("a key is lowercased before it is matched, so a desk typed in capitals cannot " +
      "make a second one that differs only by case",
      caps.status === 409 && /Smoke Support/.test(caps.json?.error?.message ?? ""),
      { s: caps.status, m: caps.json?.error?.message });
    const sneak = await call("/control/departments", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ key: "verify_sneak", name: "Extra field", head_user_id: u1 })
    });
    check("an invented field on the body is refused, not ignored", sneak.status === 400,
      { s: sneak.status });

    const renamed = await call(`/control/departments/${retired}`, null, {
      method: "PATCH", headers: ck("sa"), body: JSON.stringify({ sort: 40 })
    });
    check("a patch that names only the order keeps the name and the purpose",
      renamed.status === 200 && renamed.json?.name === "Smoke Retired" && renamed.json?.sort === 40,
      renamed.json);
    const emptyPatch = await call(`/control/departments/${retired}`, null, {
      method: "PATCH", headers: ck("sa"), body: JSON.stringify({})
    });
    check("a patch that changes nothing is refused instead of stamping the row",
      emptyPatch.status === 400, { s: emptyPatch.status });
    const badId = await call("/control/departments/not-a-uuid", null, {
      method: "PATCH", headers: ck("sa"), body: JSON.stringify({ sort: 3 })
    });
    check("a malformed id is a 404, not a database error", badId.status === 404,
      { s: badId.status });

    // ---------------- placing seats ----------------
    phase("placing seats");
    const place = await call(`/control/departments/${support}/seats`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userIds: [u1, u2], reason: "Both are needed on the support desk." })
    });
    check("two seats are placed and the desk says so",
      place.status === 200 && place.json?.placed === 2 && place.json?.already_seated?.length === 0,
      { s: place.status, b: place.json });
    const placedAgain = await call(`/control/departments/${support}/seats`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userIds: [u1, u2], reason: "Placed a second time by mistake." })
    });
    check("pressing Assign twice places nobody and names who was already there",
      placedAgain.status === 200 && placedAgain.json?.placed === 0 &&
      (placedAgain.json?.already_seated ?? []).length === 2, placedAgain.json);
    const foreign = await call(`/control/departments/${support}/seats`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userIds: [uFor], reason: "A seat from the other tenant." })
    });
    check("another tenant's platform seat cannot be placed here", foreign.status === 400,
      { s: foreign.status, m: foreign.json?.error?.message });
    const companySeat = await call(`/control/departments/${support}/seats`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userIds: [uStf], reason: "A company seat on the platform chart." })
    });
    check("nor can a company seat inside the same tenant", companySeat.status === 400,
      { s: companySeat.status });
    const suspended = await call(`/control/departments/${support}/seats`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userIds: [uSus], reason: "Somebody who is off the desk." })
    });
    check("a suspended seat is refused with the reason, not a silent skip",
      suspended.status === 409 && /Hassan/.test(suspended.json?.error?.message ?? ""),
      { s: suspended.status, m: suspended.json?.error?.message });
    const shortReason = await call(`/control/departments/${support}/seats`, null, {
      method: "POST", headers: ck("sa"), body: JSON.stringify({ userIds: [u3], reason: "why" })
    });
    check("a seat cannot be placed without a sentence a person would defend",
      shortReason.status === 400, { s: shortReason.status });

    const past = await call(`/control/departments/${ops}/seats`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userIds: [u3], reason: "A cover that already ran out.", endsOn: "2020-01-05" })
    });
    check("a cover whose date has already run out is refused before it reaches the table",
      past.status === 400, { s: past.status, m: past.json?.error?.message });
    const cover = await call(`/control/departments/${ops}/seats`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userIds: [u3], reason: "Covering the operations desk while away.", endsOn: COVER_DAY })
    });
    check("a cover that has not run out is placed with its date",
      cover.status === 200 && cover.json?.placed === 1, { s: cover.status, b: cover.json });

    const chart = await call("/control/departments", null, { headers: ck("sa") });
    const sup = (chart.json?.departments ?? []).find((d: any) => d.id === support);
    const op = (chart.json?.departments ?? []).find((d: any) => d.id === ops);
    check("the chart counts what sits in each desk and orders by sort",
      chart.status === 200 && sup?.seat_count === 2 && op?.seat_count === 1 &&
      chart.json.departments[0].key === "verify_support",
      chart.json?.departments?.map((d: any) => `${d.key}/${d.seat_count}`));
    check("a placed seat leaves the unplaced list in the same breath",
      (chart.json?.unassigned ?? []).every((u: any) => ![u1, u2, u3].includes(u.user_id)) &&
      (chart.json?.unassigned ?? []).some((u: any) => u.user_id === uSus),
      chart.json?.unassigned?.map((u: any) => u.full_name));
    const ends = op?.seats?.find((s: any) => s.user_id === u3)?.ends_at;
    check("a cover named as one day reads back as that day at 23:59 in Dar es Salaam",
      String(ends).startsWith(COVER_DAY) && String(ends).slice(11, 16) === "20:59",
      { wanted: COVER_DAY, got: ends });
    check("a seat on the chart carries its duties and no contact or credential column",
      sup?.seats?.every((s: any) => Array.isArray(s.duties) && s.duties.includes("support_engineer")),
      sup?.seats?.map((s: any) => [s.full_name, s.duties]));
    const chartKeys = Object.keys(sup?.seats?.[0] ?? {});
    const LEAKY = ["email", "phone", "nida", "password", "hash", "token", "secret", "encrypted",
      "otp", "refresh"];
    check("…and none of the columns a chart has no business showing",
      !chartKeys.some((k) => LEAKY.some((p) => k.toLowerCase().includes(p))), chartKeys.join(","));

    // ---------------- who answers for the desk ----------------
    phase("naming a head");
    const head = await call(`/control/departments/${support}/head`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: u1, reason: "She has run the queue since the start." })
    });
    check("appointing a head names the seat and records the act",
      head.status === 200 && head.json?.head_user_id === u1 && !!head.json?.transition_id,
      { s: head.status, b: head.json });
    const withHead = await call("/control/departments", null, { headers: ck("sa") });
    const supNow = withHead.json.departments.find((d: any) => d.id === support);
    check("…and the chart leads that desk with her, standing head",
      supNow?.head_name === "Ephant First" && supNow?.seats?.[0]?.standing === "head" &&
      supNow?.seats?.[0]?.user_id === u1,
      supNow?.seats?.map((s: any) => `${s.full_name}/${s.standing}`));
    const dbHeads = await oi(
      `select count(*)::int as n from platform_seat_departments
        where department_id = $1 and released_at is null and standing = 'head'`, [support]);
    check("…and the database holds exactly one live head for it", dbHeads.rows[0].n === 1, dbHeads.rows[0]);

    const twice = await call(`/control/departments/${support}/head`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: u1, reason: "Appointed her again by mistake." })
    });
    check("appointing the same seat twice says so instead of doubling the headship",
      twice.status === 409, { s: twice.status, m: twice.json?.error?.message });
    const foreignHead = await call(`/control/departments/${support}/head`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: uFor, reason: "Somebody from the other tenant." })
    });
    check("a head cannot be imported from another tenant", foreignHead.status === 404,
      { s: foreignHead.status });
    const deadHead = await call(`/control/departments/${support}/head`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: uSus, reason: "A seat that is off the desk." })
    });
    check("nor can a suspended seat be made answerable for a desk", deadHead.status === 409,
      { s: deadHead.status });
    const analystHead = await call(`/control/departments/${support}/head`, null, {
      method: "POST", headers: ck("an"),
      body: JSON.stringify({ userId: u2, reason: "An analyst naming a head." })
    });
    check("the analyst cannot name a head either", analystHead.status === 403,
      { s: analystHead.status });

    const acting = await call(`/control/departments/${support}/head`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: u2, reason: "Taking the desk while Ephant is on leave.", endsOn: COVER_DAY })
    });
    check("an acting head is appointed with an end date, in place",
      acting.status === 200 && acting.json?.head_user_id === u2, { s: acting.status, b: acting.json });
    const handover = await call("/control/departments", null, { headers: ck("sa") });
    const supHand = handover.json.departments.find((d: any) => d.id === support);
    check("…the old head steps down on the same desk rather than leaving it",
      supHand?.head_name === "Faida Second" &&
      supHand?.seats?.some((s: any) => s.full_name === "Ephant First" && s.standing === "member"),
      supHand?.seats?.map((s: any) => `${s.full_name}/${s.standing}`));
    const coverRow = supHand?.seats?.find((s: any) => s.user_id === u2);
    check("…and the acting headship carries the cover date it was named with",
      coverRow?.standing === "head" && String(coverRow?.ends_at).startsWith(COVER_DAY), coverRow);

    const drop = await call(`/control/departments/${support}/head`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: null, reason: "Nobody is answerable this week." })
    });
    check("a headship can be given up, and the desk keeps its seats",
      drop.status === 200 && drop.json?.head_user_id === null, { s: drop.status, b: drop.json });
    const dropped = await oi(`select head_user_id from platform_departments where id = $1`, [support]);
    check("…in the database as well as in the response", dropped.rows[0].head_user_id === null);
    const dropTwice = await call(`/control/departments/${support}/head`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: null, reason: "There is no head to release." })
    });
    check("releasing a headship that was already released says so", dropTwice.status === 409,
      { s: dropTwice.status });

    // ---------------- moving a seat ----------------
    phase("moving a seat");
    const rehead = await call(`/control/departments/${support}/head`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: u1, reason: "Back on the support desk as its head." })
    });
    check("Ephant takes the desk again", rehead.status === 200 && rehead.json?.head_user_id === u1,
      { s: rehead.status });
    const moved = await call("/control/departments/move", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: u1, toDepartmentId: ops, reason: "The operations desk is short one engineer." })
    });
    check("a move takes the seat off one desk and on to the next",
      moved.status === 200 && moved.json?.released === 1 && moved.json?.joined === 1 &&
      moved.json?.from === "Smoke Support" && moved.json?.to === "Smoke Operations", moved.json);
    const supportAfter = await oi(
      `select head_user_id from platform_departments where id = $1`, [support]);
    check("…and the desk it left cannot still call it answerable",
      supportAfter.rows[0]?.head_user_id === null, supportAfter.rows[0]);
    const moveTwice = await call("/control/departments/move", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: u1, toDepartmentId: ops, reason: "Already sitting there." })
    });
    check("moving a seat to the only desk it sits in is refused, not repeated",
      moveTwice.status === 409, { s: moveTwice.status, m: moveTwice.json?.error?.message });
    const moveNobody = await call("/control/departments/move", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: uFor, toDepartmentId: ops, reason: "A seat from elsewhere." })
    });
    check("a seat in another tenant cannot be moved by this desk", moveNobody.status === 404,
      { s: moveNobody.status });
    const moveNowhere = await call("/control/departments/move", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: u1, toDepartmentId: randomUUID(), reason: "A desk that is not there." })
    });
    check("nor can it be moved to a desk that does not exist", moveNowhere.status === 404,
      { s: moveNowhere.status });

    const leave = await call("/control/departments/leave", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: u2, reason: "Left the platform for another company." })
    });
    check("a seat that goes takes its membership with it",
      leave.status === 200 && leave.json?.released === 1, { s: leave.status, b: leave.json });
    const leaveTwice = await call("/control/departments/leave", null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userId: u2, reason: "There is nothing left to release." })
    });
    check("releasing a seat that sits nowhere says so", leaveTwice.status === 409,
      { s: leaveTwice.status });
    const unplacedNow = await call("/control/departments", null, { headers: ck("sa") });
    check("…and it is back on the unplaced list",
      (unplacedNow.json?.unassigned ?? []).some((u: any) => u.user_id === u2),
      unplacedNow.json?.unassigned?.map((u: any) => u.full_name));

    // ---------------- closing a desk ----------------
    phase("closing a desk, with somewhere for its people to go");
    // Two seats on the desk about to close: one that has nowhere else to be, one that already
    // sits at the target. The first is moved, the second only leaves — and both must be in
    // the register, or a closing team could drop a person out of the record.
    const parked = await call(`/control/departments/${retired}/seats`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ userIds: [uDIR, u3], reason: "A seat parked on the desk about to close." })
    });
    check("both seats are placed on the desk that is about to close",
      parked.status === 200 && parked.json?.placed === 2, parked.json);
    const closeBare = await call(`/control/departments/${retired}/close`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ reason: "The team moved into operations." })
    });
    check("a desk with seats in it cannot be closed without saying where they go",
      closeBare.status === 409 && /move to/.test(closeBare.json?.error?.message ?? ""),
      { s: closeBare.status, m: closeBare.json?.error?.message });
    const closeSelf = await call(`/control/departments/${retired}/close`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ reason: "The team moved into operations.", moveTo: retired })
    });
    check("…and it cannot absorb itself", closeSelf.status === 400, { s: closeSelf.status });
    const closeGhost = await call(`/control/departments/${retired}/close`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ reason: "The team moved into operations.", moveTo: randomUUID() })
    });
    check("nor send its people to a desk that is not there", closeGhost.status === 400,
      { s: closeGhost.status });
    const closed = await call(`/control/departments/${retired}/close`, null, {
      method: "POST", headers: ck("sa"),
      body: JSON.stringify({ reason: "The team moved into operations.", moveTo: ops })
    });
    check("a desk closes once its seats have somewhere to go, and reports both counts",
      closed.status === 200 && closed.json?.closed === true && closed.json?.seats_released === 2
      && closed.json?.seats_moved === 1, { s: closed.status, b: closed.json });
    const closedRow = await oi(
      `select deleted_at is not null as gone, deleted_by from platform_departments where id = $1`,
      [retired]);
    check("…by tombstone, not by delete, with the person who did it stamped on it",
      closedRow.rows[0]?.gone === true && closedRow.rows[0]?.deleted_by === uSA, closedRow.rows[0]);
    const afterClose = await call("/control/departments", null, { headers: ck("sa") });
    check("the closed desk leaves the chart and appears in the closed list, named",
      !afterClose.json.departments.some((d: any) => d.id === retired) &&
      (afterClose.json?.closed ?? []).some((d: any) => d.id === retired && d.closed_by === "Sada Admin"),
      afterClose.json?.closed);
    const reopenTwice = await call(`/control/departments/${support}/reopen`, null, {
      method: "POST", headers: ck("sa"), body: JSON.stringify({ reason: "It was never closed." })
    });
    check("reopening a desk that is open says so", reopenTwice.status === 409,
      { s: reopenTwice.status });
    const reopened = await call(`/control/departments/${retired}/reopen`, null, {
      method: "POST", headers: ck("sa"), body: JSON.stringify({ reason: "The team was needed again." })
    });
    check("a closed desk reopens under the same id, so the history still points at it",
      reopened.status === 200 && reopened.json?.closed === false, { s: reopened.status });
    const seatBack = await oi(
      `select released_at is not null as gone from platform_seat_departments
        where department_id = $1 and user_id = $2`, [retired, u3]);
    check("…and its old seat is not resurrected by the reopen",
      seatBack.rows.every((r: any) => r.gone === true), seatBack.rows);

    // ---------------- the register ----------------
    phase("the register of moves");
    const reg = await call("/control/departments/register?days=30&limit=60", null, { headers: ck("sa") });
    const items = reg.json?.items ?? [];
    check("the register reads back with a count that cannot disagree with the rows",
      reg.status === 200 && items.length === reg.json?.total && reg.json.total > 10,
      { n: items.length, total: reg.json?.total });
    const acts = [...new Set(items.map((r: any) => r.action))];
    check("every kind of act this desk performs wrote a line",
      ["department_created", "department_updated", "department_closed", "department_reopened",
        "seat_joined", "seat_moved", "seat_released", "head_appointed", "head_released"]
        .every((a) => acts.includes(a)), acts);
    check("a line says who moved, from what to what, and why in a sentence",
      items.every((r: any) => r.reason && r.reason.length >= 4 &&
        (r.seat_name || r.action.startsWith("department_"))),
      items.slice(0, 3).map((r: any) => [r.action, r.seat_name, r.reason]));
    check("it keeps the labels as they were said, beside the desk ids",
      items.some((r: any) => r.action === "seat_moved" && r.from_label === "Smoke Support"
        && r.to_label === "Smoke Operations" && r.to_department_id === ops),
      items.find((r: any) => r.action === "seat_moved"));
    // The seat that already sat at the target was not placed again, so it left the closing
    // desk without a seat_moved line — and a person who vanishes from a chart with no line
    // about it is exactly what this register exists to prevent.
    check("a seat that already sat where it was sent still leaves a line of its own",
      items.some((r: any) => r.action === "seat_released" && r.user_id === u3
        && r.from_department_id === retired && r.detail?.already_at === "Smoke Operations"),
      items.filter((r: any) => r.action === "seat_released").map((r: any) => r.seat_name));
    const byAction = await call("/control/departments/register?action=head_appointed", null, { headers: ck("sa") });
    check("filtering by act returns only that act",
      byAction.status === 200 && byAction.json.items.length > 0 &&
      byAction.json.items.every((r: any) => r.action === "head_appointed"),
      { n: byAction.json?.items?.length });
    const bySeat = await call(`/control/departments/register?user=${u1}`, null, { headers: ck("sa") });
    check("filtering by seat returns only that seat's moves",
      bySeat.status === 200 && bySeat.json.items.length > 0 &&
      bySeat.json.items.every((r: any) => r.user_id === u1), { n: bySeat.json?.items?.length });
    const byWord = await call("/control/departments/register?q=" + encodeURIComponent("on leave"),
      null, { headers: ck("sa") });
    check("a word finds the moves that mentioned it and nothing else",
      byWord.status === 200 && byWord.json.items.length > 0 &&
      byWord.json.items.every((r: any) => /on leave/i.test(
        [r.reason, r.seat_name, r.from_label, r.to_label].filter(Boolean).join(" "))),
      byWord.json?.items?.map((r: any) => r.reason));
    const badAction = await call("/control/departments/register?action=seat_promoted", null, { headers: ck("sa") });
    check("an act this vocabulary does not have is refused, not silently empty",
      badAction.status === 400, { s: badAction.status });
    const badUser = await call("/control/departments/register?user=not-a-uuid", null, { headers: ck("sa") });
    check("a malformed seat id on a filter is refused", badUser.status === 400, { s: badUser.status });
    const badDays = await call("/control/departments/register?days=0", null, { headers: ck("sa") });
    const badLimit = await call("/control/departments/register?limit=5000", null, { headers: ck("sa") });
    check("a window or a page size outside the desk's own bounds is refused",
      badDays.status === 400 && badLimit.status === 400, { d: badDays.status, l: badLimit.status });
    const regKeys = Object.keys(items[0] ?? {});
    check("…and a register line carries no contact, hash or payload column either",
      !regKeys.some((k) => LEAKY.some((p) => k.toLowerCase().includes(p))), regKeys.join(","));

    // ---------------- the same acts in the forensic trail ----------------
    phase("the trail");
    const tr = await call(`/control/audit?actorUserId=${uSA}&limit=400`, null, { headers: ck("sa") });
    const mine = (tr.json ?? []).filter((r: any) => String(r.action).startsWith("control.departments."));
    check("every write left an audit row too, under the same act name",
      tr.status === 200 && mine.length >= items.length, { audit: mine.length, register: items.length });
    check("an audit row carries the transition id, so the two registers cannot drift apart",
      mine.every((r: any) => !!r.after?.transition_id) &&
      mine.some((r: any) => items.some((i: any) => i.id === r.after.transition_id)),
      mine.slice(0, 2).map((r: any) => [r.action, r.after?.transition_id]));

    // ---------------- another tenant, same routes ----------------
    phase("the other platform tenant sees none of this");
    const otherChart = await call("/control/departments", null, { headers: ck("for") });
    check("the other desk reads its own empty chart, not this one",
      otherChart.status === 200 && otherChart.json?.departments?.length === 0 &&
      otherChart.json?.summary?.departments === 0,
      { n: otherChart.json?.departments?.length, summary: otherChart.json?.summary });
    const otherReg = await call("/control/departments/register", null, { headers: ck("for") });
    check("…and its register is empty, though this one is full",
      otherReg.status === 200 && otherReg.json?.total === 0, { total: otherReg.json?.total });
    const otherPatch = await call(`/control/departments/${support}`, null, {
      method: "PATCH", headers: ck("for"), body: JSON.stringify({ name: "Renamed from next door" })
    });
    check("a rewrite aimed at another tenant's desk id changes nothing — 404",
      otherPatch.status === 404, { s: otherPatch.status });
    const stillThere = await oi(`select name from platform_departments where id = $1`, [support]);
    check("…and the desk keeps its own name", stillThere.rows[0]?.name === "Smoke Support",
      stillThere.rows[0]);
    const otherSeats = await call(`/control/departments/${support}/seats`, null, {
      method: "POST", headers: ck("for"),
      body: JSON.stringify({ userIds: [uFor], reason: "Placing my own seat on their desk." })
    });
    check("nor can it place a seat into another tenant's desk", otherSeats.status === 404,
      { s: otherSeats.status });
    const otherClose = await call(`/control/departments/${support}/close`, null, {
      method: "POST", headers: ck("for"), body: JSON.stringify({ reason: "Shutting their desk down." })
    });
    check("…and it cannot close it either", otherClose.status === 404, { s: otherClose.status });
    const otherMove = await call("/control/departments/move", null, {
      method: "POST", headers: ck("for"),
      body: JSON.stringify({ userId: uFor, toDepartmentId: support, reason: "Across the wall." })
    });
    check("…and a move across the wall stops at the target desk", otherMove.status === 404,
      { s: otherMove.status });

    // ---------------- nobody without the duty ----------------
    phase("the seats that hold neither duty");
    const csChart = await call("/control/departments", null, { headers: ck("cs") });
    const dirChart = await call("/control/departments", null, { headers: ck("dir") });
    check("customer service and a director are turned away with 403, not an empty chart",
      csChart.status === 403 && dirChart.status === 403, { cs: csChart.status, dir: dirChart.status });
    const csReg = await call("/control/departments/register", null, { headers: ck("cs") });
    check("…and they cannot read the register either", csReg.status === 403, { s: csReg.status });
    const anClose = await call(`/control/departments/${retired}/close`, null, {
      method: "POST", headers: ck("an"), body: JSON.stringify({ reason: "An analyst shutting a desk." })
    });
    check("an analyst cannot close a desk", anClose.status === 403, { s: anClose.status });
    const anMove = await call("/control/departments/leave", null, {
      method: "POST", headers: ck("an"), body: JSON.stringify({ userId: u1, reason: "An analyst emptying a desk." })
    });
    check("…or take a seat off every desk", anMove.status === 403, { s: anMove.status });

    // ---------------- nothing leaks ----------------
    phase("leak scan");
    // A seat's own work address is a forensic field the audit reader carries on purpose
    // (066); what must never appear is the engine's own words or a credential column.
    const LEAKS = ["syntax error at or near", "duplicate key value violates",
      "insert into platform_", "node_modules", "Postgres", "app_runtime", "refresh_token_hash",
      "$2b$", "email_normalized"];
    const hit = LEAKS.filter((m) => bodies.some((b) => b.toLowerCase().includes(m.toLowerCase())));
    check("no engine string, table name or credential column ever reached a client",
      hit.length === 0, hit);

    const survived = await oi(
      `select (select count(*)::int from platform_seat_departments
               where tenant_id = $1 and released_at is null and ends_at <= now()) as stale_covers,
              (select count(*)::int from platform_departments d
                where d.tenant_id = $1 and d.deleted_at is null and d.head_user_id is not null
                  and not exists (select 1 from platform_seat_departments m
                     where m.department_id = d.id and m.released_at is null and m.standing = 'head')) as headless_leads,
              (select count(*)::int from platform_seat_departments m
                where m.tenant_id = $1 and m.released_at is null
                group by m.department_id, m.user_id having count(*) > 1) as doubled`,
      [TC]);
    check("the chart is left in a state the design says it must always be in",
      survived.rows[0].stale_covers === 0 && survived.rows[0].headless_leads === 0
      && !survived.rows[0].doubled, survived.rows[0]);
  } finally {
    // ---------------- teardown ----------------
    phase("teardown");
    await oi(`delete from platform_duty_transitions where tenant_id = any($1::uuid[])`, [[TC, TB]]).catch(() => { });
    await oi(`delete from platform_seat_departments where tenant_id = any($1::uuid[])`, [[TC, TB]]).catch(() => { });
    await oi(`delete from platform_departments where tenant_id = any($1::uuid[])`, [[TC, TB]]).catch(() => { });
    await oi(`delete from user_roles where user_id = any($1::uuid[])`, [allUsers]).catch(() => { });
    await oi(`delete from sessions where user_id = any($1::uuid[])`, [allUsers]).catch(() => { });
    await clearBuckets("dept:uid:", "dept-register:uid:", "dept-write:uid:", "audit:");
    await oi(`delete from users where id = any($1::uuid[])`, [allUsers]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [[TC, TB]]).catch(() => { });
    await sweep();

    const residue = await oi(
      `select (select count(*) from platform_duty_transitions where tenant_id = any($1::uuid[])) as moves,
              (select count(*) from platform_seat_departments where tenant_id = any($1::uuid[])) as memberships,
              (select count(*) from platform_departments where tenant_id = any($1::uuid[])) as desks,
              (select count(*) from user_roles where user_id = any($1::uuid[])) as duties,
              (select count(*) from sessions where user_id = any($1::uuid[])) as sessions,
              (select count(*) from users where id = any($1::uuid[])) as users,
              (select count(*) from tenants where id = any($1::uuid[])) as tenants,
              (select count(*) from tenants where name like $2) as smoke_tenants,
              (select count(*) from users where email like $3) as smoke_users,
              (select count(*) from rate_limits where bucket like 'dept:%') as buckets`,
      [[TC, TB], TENANT_SWEEP, EMAIL_SWEEP]);
    check("cleanup: no desk, seat, move, duty, session, tenant or bucket survives the run " +
      "(the audit trail is append-only and stays)",
      Object.values(residue.rows[0]).every((n: any) => Number(n) === 0), residue.rows[0]);
    await owner.end();
  }

  console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURE(S)`} — smoke-control-departments`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
