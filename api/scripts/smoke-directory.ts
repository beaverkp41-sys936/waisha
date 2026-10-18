/**
 * Directory and search-pass smoke — the metered marketplace walked for real.
 *
 * Drives the routes added for #100 against a running API (port 4000): a seeker signs
 * up, verifies by email, claims the free credit, searches an empty board, then a
 * transporter publishes its listing and the same seeker searches again. It checks the
 * four things the design in 061 actually depends on:
 *
 *  - the meter cannot be skipped or padded (no claim → no read, one credit per claim,
 *    paging a live claim stays free, and a card that is not on the board refunds the
 *    credit because consume and read share one transaction);
 *  - the disclosure is the PUBLISHED COPY, so a card carries no tenant id, no TIN, no
 *    BRLA, no licence number and no sealed phone — asserted by comparing the key set of
 *    a result row against directory_card's own columns;
 *  - the eligibility trigger's refusal answers 409 with the database's sentence rather
 *    than 500 (the P0001 mapping in plugins/errors.ts), and a suspended listing cannot
 *    be re-published by its owner;
 *  - the read carries the same permission answer as the write gate (canManage), so the
 *    editor never offers a director-only button to a manager whose click would 403;
 *  - the control side works through the real cookie path: a session row, the queue,
 *    the approval that re-bases the week, and moderation.
 *
 * The control TOTP ceremony is NOT exercised here — a session row is inserted for the
 * fixture's platform user so the cookie authenticates through get_control_session
 * exactly as a signed-in admin's would. The staff tokens are minted directly, which is
 * what every other smoke does, and the seeker goes through the real signup / verify /
 * login path because verification is the gate the meter reads.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-directory.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";
import { hashOtp } from "../src/security/otp.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const FIRST = "Joseph";
const LAST = "Mbwana";
const EMAIL = `smoke.dir.${STAMP}@waisha.test`;
const PHONE = `+2557${STAMP}`;
const PASSWORD = `Sd-${STAMP}-T4!k`;
const OTP_KNOWN = "864210";
const EMAIL_SWEEP = `smoke.dir.%@waisha.test`;

const CARRIER = `Dir Smoke Carrier Ltd ${STAMP}`;
const PENDING_CO = `Dir Smoke Pending Ltd ${STAMP}`;
const CONTROL_EMAIL = `smoke.dir.control.${STAMP}@waisha.test`;
const CONTACT = "Grace Mwajuma";
const CHANNEL = "+255 755 100 200 (WhatsApp)";
const WEAK_REF = `TP${STAMP}X`;
/** The exact columns directory_card declares — anything else in a row is a leak. */
const CARD_KEYS = ["id", "company_name", "serves", "headline", "description",
  "services_offered", "corridors_served", "home_base", "region_names", "website",
  "fleet_size_declared", "year_established", "licence_valid_to", "licence_state",
  "contact_name", "contact_channel", "is_verified", "published_at", "total"];

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
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  // Throttle windows are clock-aligned, so a leftover bucket would decide pass/fail
  // instead of the code. Cleared before the phases that could hit one.
  const clearBuckets = async (...prefixes: string[]) => {
    for (const p of prefixes) await oi(`delete from rate_limits where bucket like $1`, [`${p}%`]);
  };

  const roleOf = async (k: string) => (await oi(
    `select id from roles where key = $1 and tenant_id is null`, [k])).rows[0]?.id;
  const directorRole = await roleOf("director");
  const superAdminRole = await roleOf("super_admin");
  // 061 gives directory.view to operations_manager but keeps directory.manage for the
  // director alone, so this seat is the only way to prove the read's canManage flag
  // tracks the write gate instead of disagreeing with it.
  const opsRole = await roleOf("operations_manager");
  if (!directorRole || !superAdminRole || !opsRole) throw new Error("global director / super_admin / operations_manager role missing");

  const regions = (await oi(
    `select id, name_en from geo_regions where country = 'TZ' and is_active
      order by id limit 3`)).rows;
  if (regions.length < 3) throw new Error("geo_regions seed missing");
  const [R1, R2, R3] = regions.map((r: any) => r.id as number);

  const TA = randomUUID(), TP = randomUUID(), TC = randomUUID();
  const uA = randomUUID(), uP = randomUUID(), uC = randomUUID(), uM = randomUUID();
  const CONTROL_TOKEN = `dir-smoke-control-${STAMP}`;
  const ourTenants = [TA, TP, TC];

  // A crashed earlier run leaves fixtures behind, and they carry that run's stamp, so
  // the sweep matches the family by prefix rather than by this run's exact names — a
  // stale LIVE listing from a crashed run would otherwise sit on the board and answer
  // every search this script makes, and "found 1" on an empty board is a lie.
  const sweep = async () => {
    const tids = (await oi(
      `select id from tenants where name like 'Dir Smoke %'`)).rows
      .map((r: any) => r.id);
    const emails = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...emails].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    // Order is load-bearing: seeker_searches points at both a pass and a listing, so it
    // has to leave before the rows it references. audit_logs refuses DELETE through its
    // own append-only trigger and is left in place on purpose.
    for (const t of ["seeker_searches", "seeker_search_passes", "directory_listing_regions",
      "directory_listings", "seekers", "company_profiles", "otp_codes", "sessions"]) {
      await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    }
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      await oi(`delete from seekers where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      await oi(`delete from otp_codes where user_id = any($1::uuid[])`, [uids]).catch(() => { });
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await clearBuckets("signup:", "otp:", "otp-resend:", "login:", "ip:");

  // ---------------- fixtures ----------------
  await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'trial')`,
    [TA, CARRIER]);
  await oi(`insert into tenants (id, type, name, status) values ($1,'transporter',$2,'pending_verification')`,
    [TP, PENDING_CO]);
  await oi(`insert into tenants (id, type, name, status) values ($1,'platform',$2,'active')`,
    [TC, `Dir Smoke Control ${STAMP}`]);
  await oi(`insert into company_profiles (id, tenant_id, company_name, description,
             services_offered, corridors_served, website, fleet_size_declared,
             year_established, transport_licence_no, transport_licence_expiry,
             tin_display, brela_number)
           values ($1,$2,$3,'Haulage since 2011.','Clearing, bonding, transport',
             'Dar - Arusha - Namanga','carrier.example.com',24,2011,
             $4, current_date + 400, $5, $6)`,
    [randomUUID(), TA, CARRIER, `TRL-DO-NOT-PUBLISH-${STAMP}`, `75${STAMP}`, `BRL${STAMP}`]);
  await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
            values ($1,$2,'director',$3,'active',$4)`, [uA, TA, "Carrier Director", `dir.a.${STAMP}@waisha.test`]);
  await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
            values ($1,$2,'director',$3,'active',$4)`, [uP, TP, "Pending Director", `dir.p.${STAMP}@waisha.test`]);
  await oi(`insert into users (id, tenant_id, user_type, full_name, status, email)
            values ($1,$2,'staff',$3,'active',$4)`,
    [uM, TA, "Carrier Ops Manager", `dir.m.${STAMP}@waisha.test`]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uM, opsRole]);
  await oi(`insert into users (id, tenant_id, user_type, full_name, status, email, totp_enabled)
            values ($1,$2,'platform',$3,'active',$4,true)`, [uC, TC, "Dir Smoke Admin", CONTROL_EMAIL]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uA, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uP, directorRole]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uC, superAdminRole]);
  await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
             refresh_token_hash, user_agent, ip, expires_at)
           values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-directory',$6,
             now() + interval '2 hours')`,
    [randomUUID(), uC, TC, randomUUID(), sha256(CONTROL_TOKEN), "127.0.0.1"]);

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);
  const tokA = await mint(uA, TA, ["director"]);
  const tokP = await mint(uP, TP, ["director"]);
  const tokM = await mint(uM, TA, ["operations_manager"]);
  const cookie = { Cookie: `waisha_control=${CONTROL_TOKEN}` };

  let seekerTok = "";
  let userId = "";
  let seekerTenantId = "";
  let listingA = "";
  let listingP = "";
  let searchId = "";

  try {
    // ---------------- the seeker arrives ----------------
    phase("seeker signup and verification");
    const su = await call("/auth/seeker/signup", null, {
      method: "POST", body: JSON.stringify({
        firstName: FIRST, lastName: LAST, phone: PHONE, email: EMAIL, password: PASSWORD,
        confirmPassword: PASSWORD, lookingFor: ["transporter"], acceptTerms: true
      })
    });
    userId = su.json?.userId ?? "";
    check("seeker signup → 201", su.status === 201 && !!userId, { s: su.status, b: su.json });

    await oi(`update otp_codes set code_hash = $2
              where user_id = $1 and purpose = 'signup' and expires_at > now()`,
      [userId, hashOtp(OTP_KNOWN)]);
    await clearBuckets("otp:");
    const verify = await call("/auth/otp/verify", null, {
      method: "POST", body: JSON.stringify({ userId, code: OTP_KNOWN })
    });
    check("email code verifies the account", verify.status === 200, { s: verify.status, b: verify.json });

    const login = await call("/auth/login", null, {
      method: "POST", body: JSON.stringify({ mode: "seeker", email: EMAIL, password: PASSWORD })
    });
    seekerTok = login.json?.accessToken ?? "";
    check("real seeker login hands out a token", login.status === 200 && !!seekerTok,
      { s: login.status, code: login.json?.error?.code });

    // ---------------- the meter before anything is listed ----------------
    phase("gate and meter, empty board");
    const passes = await call("/seeker/passes", seekerTok);
    const pstate = passes.json;
    check("GET /seeker/passes reads the meter and both products",
      passes.status === 200 && pstate?.found === true && pstate?.verified === true &&
      (pstate?.products ?? []).length === 2 &&
      pstate.products.some((p: any) => p.key === "free" && Number(p.price) === 0) &&
      pstate.products.some((p: any) => p.key === "weekly" && Number(p.price) === 3000 &&
        p.window_hours === 168 && p.searches_allowed === 30),
      { s: passes.status, products: pstate?.products });

    const early = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({})
    });
    check("searching with no pass → 409 NO_SEARCH_PASS, no credit invented",
      early.status === 409 && early.json?.error?.code === "NO_SEARCH_PASS",
      { s: early.status, code: early.json?.error?.code });
    // The seeker's own tenant, not the carrier's — signup opened a shell whose id the
    // signup response deliberately does not echo, and it is the tenant every pass,
    // search and listing row hangs off, so the teardown has to sweep it too.
    seekerTenantId = (await oi(
      `select tenant_id from seekers where user_id = $1`, [userId])).rows[0]?.tenant_id ?? "";
    const passRowsBefore = (await oi(
      `select count(*)::int as n from seeker_search_passes where tenant_id = $1`,
      [seekerTenantId])).rows[0]?.n;
    check("a refused search created no pass: the meter only answers, it never grants",
      passRowsBefore === 0, { seekerTenantId, passRowsBefore });

    const claim = await call("/seeker/passes/free", seekerTok, { method: "POST" });
    check("claiming the free credit → 201 with one search",
      claim.status === 201 && claim.json?.remaining === 1 && !!claim.json?.passId,
      { s: claim.status, b: claim.json });
    const freePass = claim.json?.passId;

    const claimAgain = await call("/seeker/passes/free", seekerTok, { method: "POST" });
    // 061 anchors the free credit on the CLAIM, so a second attempt the same day is the
    // "wait" branch — it names the hour the credit unlocks rather than stacking credits.
    check("a second claim the same day is refused, not stacked",
      claimAgain.status === 409 && claimAgain.json?.error?.code === "FREE_SEARCH_NOT_READY" &&
      !!claimAgain.json?.error?.details?.[0]?.resetsAt,
      { s: claimAgain.status, code: claimAgain.json?.error?.code, d: claimAgain.json?.error?.details });

    await clearBuckets("directory-search:");
    const empty = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({ query: "Carrier" })
    });
    searchId = empty.json?.searchId ?? "";
    check("searching an empty board costs the credit and answers found 0",
      empty.status === 200 && empty.json?.found === 0 && empty.json?.remaining === 0 &&
      (empty.json?.results ?? []).length === 0, { s: empty.status, b: empty.json });

    const spent = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({})
    });
    check("with the credit spent the meter refuses, and says when it resets",
      spent.status === 409 && spent.json?.error?.code === "SEARCH_PASS_EXHAUSTED" &&
      Number(spent.json?.error?.details?.[0]?.freeWaitMinutes) > 0,
      { s: spent.status, code: spent.json?.error?.code, d: spent.json?.error?.details });

    const log = await call("/seeker/searches", seekerTok);
    check("the seeker's own log shows the one search it paid for",
      log.status === 200 && log.json?.length === 1 && log.json[0].query === "Carrier" &&
      log.json[0].credits_left === 0, log.json);

    // ---------------- the company publishes ----------------
    phase("company listing");
    const asSeeker = await call("/directory/listing", seekerTok);
    check("a seeker cannot read a company's listing surface",
      asSeeker.status === 403 && /role does not allow/i.test(asSeeker.json?.error?.message ?? ""),
      { s: asSeeker.status, m: asSeeker.json?.error?.message });
    const dirSearch = await call("/directory/search", tokA, { method: "POST", body: JSON.stringify({}) });
    check("a director without directory.search is refused by the permission gate",
      dirSearch.status === 403 && /role does not allow/i.test(dirSearch.json?.error?.message ?? ""),
      { s: dirSearch.status, m: dirSearch.json?.error?.message });

    const before = await call("/directory/listing", tokA);
    check("nothing is listed yet, and the profile is offered as the starting point",
      before.status === 200 && before.json?.listing === null &&
      before.json?.suggestions?.company_name === CARRIER &&
      before.json?.stats?.listed === false, { s: before.status, b: before.json });

    const save = await call("/directory/listing", tokA, {
      method: "PUT", body: JSON.stringify({
        serves: ["transporter", "cfa"], companyName: CARRIER,
        headline: "24-tonne fleet on the northern corridor",
        description: "Bonded and dry freight, Dar es Salaam to Arusha, Namanga and Nakonde.",
        servicesOffered: "Clearing, bonding, haulage, transit",
        corridorsServed: "Dar - Arusha - Namanga", homeBase: "Dar es Salaam",
        website: "https://carrier.example.com", fleetSizeDeclared: 24, yearEstablished: 2011,
        contactName: CONTACT, contactChannel: CHANNEL, regionIds: [R1, R2]
      })
    });
    listingA = save.json?.id ?? "";
    check("saving the listing stores a draft, not a publication",
      save.status === 200 && save.json?.created === true && save.json?.status === "draft",
      { s: save.status, b: save.json });

    const afterSave = await call("/directory/listing", tokA);
    check("the licence is copied as a DATE from the profile, never as the number",
      afterSave.status === 200 &&
      /^\d{4}-\d{2}-\d{2}$/.test(afterSave.json?.listing?.licence_valid_to ?? "") &&
      !JSON.stringify(afterSave.json).includes("TRL-DO-NOT-PUBLISH"),
      { lic: afterSave.json?.listing?.licence_valid_to });

    // The page uses this flag to choose between a live form and "only a director can
    // publish", so it must agree with the gate on the write it replaces — a flag that
    // said true while the route said 403 would be a button that only hurts.
    const managerRead = await call("/directory/listing", tokM);
    const managerSave = await call("/directory/listing", tokM, {
      method: "PUT", body: JSON.stringify({
        serves: ["transporter"], companyName: `${CARRIER} renamed by a manager`,
        contactName: CONTACT, contactChannel: CHANNEL, regionIds: [R1]
      })
    });
    check("an operations manager reads the listing with canManage false and is refused the write",
      managerRead.status === 200 && managerRead.json?.canManage === false &&
      managerSave.status === 403 && managerSave.json?.error?.code === "FORBIDDEN",
      { read: managerRead.status, cm: managerRead.json?.canManage, s: managerSave.status, code: managerSave.json?.error?.code });
    const unchanged = await oi(
      `select company_name from directory_listings where tenant_id = $1`, [TA]);
    check("the refused write left the saved card alone",
      unchanged.rows[0]?.company_name === CARRIER, unchanged.rows[0]);
    const directorFlag = await call("/directory/listing", tokA);
    check("the director who may publish is told so on the same read",
      directorFlag.json?.canManage === true, { cm: directorFlag.json?.canManage });

    const publish = await call("/directory/listing/publish", tokA, { method: "POST" });
    check("publishing stamps published_at and goes live",
      publish.status === 200 && publish.json?.status === "live" && !!publish.json?.published_at,
      { s: publish.status, b: publish.json });

    // ---------------- the eligibility trigger answers 409, not 500 ----------------
    phase("eligibility guard");
    const saveP = await call("/directory/listing", tokP, {
      method: "PUT", body: JSON.stringify({
        serves: ["cfa"], companyName: PENDING_CO, headline: "Clearing desk at the ICD",
        contactName: "Faraja Ngowi", contactChannel: "0765 000 111", regionIds: [R1]
      })
    });
    listingP = saveP.json?.id ?? "";
    check("a pending_verification company can save its draft",
      saveP.status === 200 && saveP.json?.status === "draft", { s: saveP.status, b: saveP.json });

    const publishP = await call("/directory/listing/publish", tokP, { method: "POST" });
    check("the trigger's refusal surfaces as 409 with its own sentence, never 500",
      publishP.status === 409 && publishP.json?.error?.code === "CONFLICT" &&
      /cannot be published yet/i.test(publishP.json?.error?.message ?? ""),
      { s: publishP.status, e: publishP.json?.error });

    // ---------------- the metered read, now that there is something to find ----------------
    phase("metered read");
    // The free credit is spent and anchored on its claim, so age it past 24 hours
    // rather than waiting a day: that is exactly what the clock would have done.
    await oi(`update seeker_search_passes set created_at = created_at - interval '25 hours'
              where tenant_id = (select tenant_id from seekers where user_id = $1) and kind = 'free'`,
      [userId]);
    const claim2 = await call("/seeker/passes/free", seekerTok, { method: "POST" });
    check("the free credit unlocks again once the 24 hours have passed",
      claim2.status === 201 && claim2.json?.remaining === 1, { s: claim2.status, b: claim2.json });

    await clearBuckets("directory-search:");
    const found = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({ kind: "transporter", regionId: R1, query: "Carrier" })
    });
    searchId = found.json?.searchId ?? "";
    const card = (found.json?.results ?? [])[0] ?? {};
    check("the live listing is found, verified badge off, licence state derived",
      found.status === 200 && found.json?.found === 1 && card.company_name === CARRIER &&
      card.is_verified === false && card.licence_state === "valid" &&
      (card.region_names ?? []).length === 2, { s: found.status, card });
    check("the card is the published COPY and nothing else — no tenant id, TIN, BRLA or licence number",
      Object.keys(card).sort().join(",") === [...CARD_KEYS].sort().join(","),
      { keys: Object.keys(card) });
    check("the disclosure carries the named contact the company chose to publish",
      card.contact_name === CONTACT && card.contact_channel === CHANNEL &&
      card.home_base === "Dar es Salaam", { c: card.contact_name });

    const page = await call(`/directory/search/${searchId}?limit=20&offset=0`, seekerTok);
    check("paging a live claim is free: the same credit answers again",
      page.status === 200 && page.json?.found === 1 && page.json?.results?.length === 1,
      { s: page.status, b: page.json });
    const searchesNow = (await oi(
      `select count(*)::int as n from seeker_searches where tenant_id =
         (select tenant_id from seekers where user_id = $1)`, [userId])).rows[0].n;
    const passNow = (await oi(
      `select searches_used from seeker_search_passes where id = $1`, [freePass ?? "00000000-0000-0000-0000-000000000000"])).rows[0];
    check("one credit, one log row — the page did not spend a second",
      searchesNow === 2 && passNow?.searches_used === 1, { searchesNow, used: passNow?.searches_used });

    const opened = await call(`/directory/companies/${listingA}?searchId=${searchId}`, seekerTok);
    check("opening a card off a paid claim reveals the card",
      opened.status === 200 && opened.json?.company_name === CARRIER,
      { s: opened.status, code: opened.json?.error?.code });

    const forgedClaim = await call(`/directory/companies/${listingA}?searchId=${randomUUID()}`, seekerTok);
    check("a search id that was never paid for cannot open anything",
      forgedClaim.status === 410 && forgedClaim.json?.error?.code === "SEARCH_EXPIRED",
      { s: forgedClaim.status, code: forgedClaim.json?.error?.code, b: forgedClaim.json });

    await oi(`update seeker_searches set created_at = created_at - interval '6 minutes'
              where tenant_id = (select tenant_id from seekers where user_id = $1)`, [userId]);
    const stalePage = await call(`/directory/search/${searchId}?limit=20&offset=0`, seekerTok);
    check("the claim check expires with the search, so paging stops being free forever",
      stalePage.status === 410 && stalePage.json?.error?.code === "SEARCH_EXPIRED",
      { s: stalePage.status, code: stalePage.json?.error?.code });

    // ---------------- recording money, and the office confirming it ----------------
    phase("weekly pass and control verification");
    await clearBuckets("seeker-weekly:");
    const weekly = await call("/seeker/passes/weekly", seekerTok, {
      method: "POST", body: JSON.stringify({ reference: WEAK_REF, method: "mpesa" })
    });
    check("a typed reference records a pass that cannot search yet",
      weekly.status === 201 && weekly.json?.status === "awaiting_verification" &&
      Number(weekly.json?.amount) === 3000 && weekly.json?.currency === "TZS",
      { s: weekly.status, b: weekly.json });

    const dupRef = await call("/seeker/passes/weekly", seekerTok, {
      method: "POST", body: JSON.stringify({ reference: `${WEAK_REF}-again`, method: "mpesa" })
    });
    check("a second weekly while one is pending is refused, not queued",
      dupRef.status === 409 && dupRef.json?.error?.code === "PASS_ALREADY_RECORDED",
      { s: dupRef.status, code: dupRef.json?.error?.code });

    const shortRef = await call("/seeker/passes/weekly", seekerTok, {
      method: "POST", body: JSON.stringify({ reference: "abc", method: "mpesa" })
    });
    check("a stub of a reference is refused before it reaches the office queue",
      shortRef.status === 400, { s: shortRef.status });

    await clearBuckets("directory-search:");
    const tooEarly = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({ passId: weekly.json?.passId })
    });
    check("an unconfirmed pass cannot be searched with, and nothing is spent",
      tooEarly.status === 409 && tooEarly.json?.error?.code === "PASS_AWAITING_VERIFICATION",
      { s: tooEarly.status, code: tooEarly.json?.error?.code });

    const noCookie = await call("/control/directory/passes", null);
    check("the pending queue needs the control cookie", noCookie.status === 401, noCookie.status);

    const queue = await call("/control/directory/passes", null, { headers: cookie });
    const queued = (queue.json ?? []).find((p: any) => p.payment_reference === WEAK_REF);
    check("the office sees the reference, the amount and the seeker's name",
      queue.status === 200 && !!queued && Number(queued.amount) === 3000 &&
      queued.currency === "TZS" && queued.seeker_name === `${FIRST} ${LAST}`,
      { s: queue.status, queued });

    await clearBuckets("pass-verify:");
    const approve = await call(`/control/directory/passes/${weekly.json?.passId}/verify`, null, {
      method: "POST", headers: cookie, body: JSON.stringify({ approve: true, note: "Seen on the M-Pesa statement." })
    });
    check("confirming the money starts the week from that instant",
      approve.status === 200 && approve.json?.pass_status === "live" &&
      approve.json?.searches_allowed === 30 && !!approve.json?.expires_at,
      { s: approve.status, b: approve.json });

    const approveAgain = await call(`/control/directory/passes/${weekly.json?.passId}/verify`, null, {
      method: "POST", headers: cookie, body: JSON.stringify({ approve: true })
    });
    check("confirming twice is a conflict, not a fresh week",
      approveAgain.status === 409 && approveAgain.json?.error?.code === "PASS_NOT_PENDING",
      { s: approveAgain.status, code: approveAgain.json?.error?.code });

    const weekSearch = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({ passId: weekly.json?.passId, kind: "cfa" })
    });
    check("the confirmed pass searches, and 29 of 30 are left",
      weekSearch.status === 200 && weekSearch.json?.remaining === 29 &&
      weekSearch.json?.found === 1 && weekSearch.json?.passKind === "weekly",
      { s: weekSearch.status, r: weekSearch.json?.remaining, f: weekSearch.json?.found });

    // ---------------- a card that costs nothing when there is nothing there ----------------
    phase("refund on a failed read");
    const logSql = `select count(*)::int as n from seeker_searches where tenant_id =
                      (select tenant_id from seekers where user_id = $1)`;
    const usedSql = `select searches_used from seeker_search_passes where id = $1`;
    const beforeFail = (await oi(logSql, [userId])).rows[0].n;
    const usedBefore = (await oi(usedSql, [weekly.json?.passId])).rows[0].searches_used;
    const draftCard = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({ passId: weekly.json?.passId, listingId: listingP })
    });
    const afterFail = (await oi(logSql, [userId])).rows[0].n;
    const usedAfter = (await oi(usedSql, [weekly.json?.passId])).rows[0].searches_used;
    check("opening a draft listing answers 404 and the rollback returns the credit",
      draftCard.status === 404 && beforeFail === afterFail && usedBefore === usedAfter,
      { s: draftCard.status, logRows: [beforeFail, afterFail], used: [usedBefore, usedAfter] });

    const realCard = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({ passId: weekly.json?.passId, listingId: listingA })
    });
    check("opening a live card directly spends its own credit and returns the company",
      realCard.status === 200 && realCard.json?.company?.company_name === CARRIER &&
      realCard.json?.remaining === 28, { s: realCard.status, r: realCard.json?.remaining });

    const stats = await call("/directory/listing", tokA);
    check("the company sees only the count of opens on ITS OWN card",
      stats.status === 200 && stats.json?.stats?.card_opens === 1 &&
      stats.json?.stats?.listed === true &&
      !JSON.stringify(stats.json?.stats).includes("search_id"),
      { s: stats.status, st: stats.json?.stats });

    // ---------------- moderation ----------------
    phase("moderation");
    const register = await call(`/control/directory/listings?q=Dir Smoke Carrier`, null, { headers: cookie });
    const row = (register.json ?? []).find((l: any) => l.listing_id === listingA);
    check("the control register shows status, regions and the search count",
      register.status === 200 && !!row && row.status === "live" &&
      (row.region_names ?? []).length === 2 && Number(row.searches) >= 1,
      { s: register.status, row });

    await clearBuckets("listing-moderate:");
    const bare = await call(`/control/directory/listings/${listingA}/moderate`, null, {
      method: "POST", headers: cookie, body: JSON.stringify({ action: "suspend" })
    });
    check("a suspension without a reason the company can act on is refused",
      bare.status === 400, { s: bare.status, e: bare.json?.error });

    const suspend = await call(`/control/directory/listings/${listingA}/moderate`, null, {
      method: "POST", headers: cookie, body: JSON.stringify({ action: "suspend", note: "Licence lapsed on the TRA register." })
    });
    check("suspending takes the listing off the board",
      suspend.status === 200 && suspend.json?.listing_status === "suspended",
      { s: suspend.status, b: suspend.json });

    const hidden = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({ passId: weekly.json?.passId, query: "Carrier" })
    });
    check("a suspended listing disappears from the seeker's results",
      hidden.status === 200 && hidden.json?.found === 0, { s: hidden.status, f: hidden.json?.found });

    const republish = await call("/directory/listing/publish", tokA, { method: "POST" });
    check("the owner cannot publish its way past a suspension",
      republish.status === 403 && republish.json?.error?.code === "LISTING_SUSPENDED" &&
      /TRA register/i.test(String(republish.json?.error?.details?.[0]?.note ?? "")),
      { s: republish.status, code: republish.json?.error?.code });

    const reinstate = await call(`/control/directory/listings/${listingA}/moderate`, null, {
      method: "POST", headers: cookie, body: JSON.stringify({ action: "reinstate" })
    });
    const badge = await call(`/control/directory/listings/${listingA}/moderate`, null, {
      method: "POST", headers: cookie, body: JSON.stringify({ action: "verify" })
    });
    const back = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({ passId: weekly.json?.passId, regionId: R2 })
    });
    check("reinstated and verified, the card is findable again with the badge on",
      reinstate.status === 200 && reinstate.json?.listing_status === "live" &&
      badge.json?.is_verified === true && back.status === 200 && back.json?.found === 1 &&
      back.json?.results?.[0]?.is_verified === true,
      { r: reinstate.json?.listing_status, b: badge.json?.is_verified, f: back.json?.found });

    const unregRegion = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({ passId: weekly.json?.passId, regionId: R3 })
    });
    check("the region filter really filters: an unlisted region finds nobody",
      unregRegion.status === 200 && unregRegion.json?.found === 0,
      { s: unregRegion.status, f: unregRegion.json?.found });

    const regionsList = await call("/directory/regions", seekerTok);
    check("the region filter lists only regions with companies in them",
      regionsList.status === 200 && (regionsList.json ?? []).length >= 2 &&
      regionsList.json.every((r: any) => Number(r.companies) > 0),
      { s: regionsList.status, n: regionsList.json?.length });

    // ---------------- the seeker's own profile ----------------
    phase("seeker profile");
    const badRegion = await call("/directory/search", seekerTok, {
      method: "POST", body: JSON.stringify({ passId: weekly.json?.passId, regionId: 999999 })
    });
    check("a region that does not exist is refused before a credit is spent",
      badRegion.status === 400, { s: badRegion.status, e: badRegion.json?.error?.code });

    const prof = await call("/seeker/profile", seekerTok);
    check("the profile masks the phone and shows the email verification stamp",
      prof.status === 200 && prof.json?.email === EMAIL && prof.json?.phoneMasked?.endsWith(PHONE.slice(-3)) &&
      !JSON.stringify(prof.json).includes(PHONE) && !!prof.json?.emailVerifiedAt &&
      prof.json?.phoneVerifiedAt === null,
      { s: prof.status, p: prof.json?.phoneMasked });

    await clearBuckets("seeker-profile:");
    const edit = await call("/seeker/profile", seekerTok, {
      method: "PUT", body: JSON.stringify({ firstName: "Amina", industry: "Building materials" })
    });
    check("editing one name keeps the other and stores the industry",
      edit.status === 200 && edit.json?.first_name === "Amina" &&
      edit.json?.last_name === LAST && edit.json?.industry === "Building materials",
      { s: edit.status, b: edit.json });
    const joined = (await oi(
      `select u.full_name, s.looking_for from users u join seekers s on s.user_id = u.id
        where u.id = $1`, [userId])).rows[0];
    check("the office-facing name follows the change and looking_for is untouched",
      joined?.full_name === `Amina ${LAST}` && (joined?.looking_for ?? []).join() === "transporter",
      joined);

    const nothing = await call("/seeker/profile", seekerTok, {
      method: "PUT", body: JSON.stringify({})
    });
    check("an empty edit is refused rather than writing a blank profile",
      nothing.status === 400, { s: nothing.status });

    // ---------------- nothing leaks ----------------
    phase("leak scan");
    const LEAKS = ["tin_display", "brela", "password_hash", "code_hash", "phone_encrypted",
      "transport_licence_no", "TRL-DO-NOT-PUBLISH", "75" + STAMP, "BRL" + STAMP,
      "syntax error at or near", "duplicate key value violates", "node_modules", "Postgres"];
    const hit = LEAKS.filter((m) => bodies.some((b) => b.includes(m)));
    check("no field name, stored number or engine string ever reached a client",
      hit.length === 0, hit);

    const staff = await call("/employees", seekerTok);
    check("a seeker token is still locked out of the staff surface",
      staff.status === 403 && /portal accounts/i.test(staff.json?.error?.message ?? ""),
      { s: staff.status, m: staff.json?.error?.message });
  } finally {
    // ---------------- teardown ----------------
    phase("teardown");
    // The seeker's tenant is part of the sweep: signup minted it, so it was never one
    // of the three ids this script chose.
    const all = [...ourTenants, seekerTenantId].filter(Boolean);
    for (const t of ["seeker_searches", "seeker_search_passes", "directory_listing_regions",
      "directory_listings", "otp_codes", "sessions", "seekers", "company_profiles"]) {
      await oi(`delete from ${t} where tenant_id = any($1::uuid[])`, [all]).catch(() => { });
    }
    await oi(`delete from rate_limits where bucket like 'signup:%' or bucket like 'otp%'
              or bucket like 'login:%' or bucket like 'directory%' or bucket like 'seeker%'
              or bucket like 'pass-verify:%' or bucket like 'listing-moderate:%'`).catch(() => { });
    const uids = [uA, uP, uC, uM, userId].filter(Boolean);
    await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from seekers where user_id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from users where id = any($1::uuid[])`, [uids]).catch(() => { });
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]).catch(() => { });
    // Then the prefix sweep, which also clears what an earlier crashed run left behind
    // and this run's id list never knew about.
    await sweep();

    const residue = await oi(
      `select (select count(*) from directory_listings where tenant_id = any($1::uuid[])) as listings,
              (select count(*) from seeker_search_passes where tenant_id = any($1::uuid[])) as passes,
              (select count(*) from seeker_searches where tenant_id = any($1::uuid[])) as searches,
              (select count(*) from seekers where tenant_id = any($1::uuid[])) as seekers,
              (select count(*) from users where tenant_id = any($1::uuid[])) as users,
              (select count(*) from tenants where id = any($1::uuid[])) as tenants,
              (select count(*) from tenants where name like 'Dir Smoke %') as smoke_tenants,
              (select count(*) from directory_listings
                where company_name like 'Dir Smoke %') as smoke_listings,
              (select count(*) from users where email like $2) as smoke_users`,
      [all, EMAIL_SWEEP]);
    check("cleanup: no probe rows left", Object.values(residue.rows[0]).every((n: any) => Number(n) === 0),
      residue.rows[0]);
    await owner.end();
  }

  console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURE(S)`} — smoke-directory`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
