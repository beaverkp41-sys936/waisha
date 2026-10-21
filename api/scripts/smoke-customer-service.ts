/**
 * The command center and the customer service register over HTTP — smoke for #243, #246, #241.
 *
 * verify-customer-service-sql.ts proves the statements, the grants and the CHECKs. This proves
 * the parts a database cannot see: that the queue is the caller's own tenant's and not a query
 * parameter, that reading a register and writing one are two duties and that running the
 * register is not a door to the platform's own words, that an incidence gets its number from
 * the sequence and every act gets its own audit key, that the callback number is on no list
 * row and only in the detail read, and that a save which fails validation writes nothing.
 *
 * It also proves 099 at the door: a seat that is not a platform seat cannot open a control
 * desk at all, which is the guarantee that lets a platform-wide register run on one tenant
 * bind.
 *
 * Fixtures are this run's own two platform tenants, its own company and its own desks — never
 * the platform the real office sits on, and the live register's row count is read before and
 * after to prove it. Everything is torn down by those ids. `content_blocks` has no tenant
 * column (the words belong to the platform), so the one line this run writes there is
 * `footer.copyright`, which the seed left empty: the restore is a return to empty, not a guess
 * at somebody's sentence. Writes stay under each desk's own rate ceilings.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-customer-service.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { CONTENT_FIELDS } from "../src/content/fields.js";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const MARK = `cs${STAMP}`;
const TENANT_SWEEP = "CS Smoke %";
const EMAIL_SWEEP = `smoke.cs.%@waisha.test`;
// Two callback numbers of this run's own, so a hash lookup counts this smoke and nothing else.
const PHONE_A = `+255713${STAMP}`;
const PHONE_B = `+255754${STAMP}`;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const bodies: string[] = [];
async function call(path: string, opts: { token?: string; ck?: string; method?: string; body?: any } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    ...(opts.body === undefined ? {} : {
      body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body)
    }),
    headers: {
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.ck ? { Cookie: opts.ck } : {})
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
    [["super_admin", "platform_analyst", "customer_service_agent", "support_engineer", "director"]]
  )).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)?.id;
  if (!rid("super_admin") || !rid("platform_analyst") || !rid("customer_service_agent"))
    throw new Error("the global roles 101 and 100 were granted to are missing");

  const live = (await oi(
    `select id from tenants where type = 'platform' and deleted_at is null
      order by created_at limit 1`)).rows[0]?.id;
  if (!live) throw new Error("no live platform tenant to compare against");
  const liveBefore = (await oi(
    "select count(*)::int as n from support_tickets where tenant_id = $1", [live])).rows[0].n;
  const liveAuditBefore = (await oi(
    "select count(*)::int as n from audit_logs where tenant_id = $1", [live])).rows[0].n;

  // ---------------- fixtures ----------------
  const TC = randomUUID();          // the platform whose register this run writes
  const TB = randomUUID();          // a second platform desk: its register is not ours
  const CO = randomUUID();          // a company the call is about
  const SK = randomUUID();          // a seeker account: never a company

  const uCS = randomUUID();     // super_admin: runs the register and owns the words
  const uAgent = randomUUID();  // customer_service_agent: the queue and the pen, no copy desk
  const uEng = randomUUID();    // support_engineer: sits at billing
  const uAn = randomUUID();     // platform_analyst: reads both desks, writes neither
  const uDir = randomUUID();    // director: a control session with no keys at all
  const uFor = randomUUID();    // super_admin of the other platform desk
  const uCfo = randomUUID();    // a company seat: 099 turns it away from the door

  const D1 = randomUUID();      // Support Desk       — open
  const D2 = randomUUID();      // Billing & Revenue  — open, uEng sits here
  const D3 = randomUUID();      // Retired Desk       — closed

  const tok = (who: string) => `cs-smoke-${who}-${STAMP}`;
  const ck = (who: string) => `waisha_control=${tok(who)}`;

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    // The app role cannot take these away — the register is append-only and the incidences are
    // closed, never deleted. Only the owner bypasses the guards, and only for this run's rows.
    // audit_logs is the one exception: prevent_audit_mutation() raises for the owner too, so a
    // run's audit lines stay behind on purpose, exactly as 084's smoke leaves its own. The
    // tenant rows still go, because audit_logs.tenant_id carries no foreign key.
    const tidsT = (await oi(`select id from support_tickets where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    if (tidsT.length) {
      await oi(`delete from support_ticket_events where ticket_id = any($1::uuid[])`, [tidsT]);
      await oi(`delete from support_tickets where id = any($1::uuid[])`, [tidsT]);
    }
    await oi(`delete from platform_seat_departments where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from platform_departments where tenant_id = any($1::uuid[])`, [all]);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await clearBuckets("tickets", "content", "audit");

  await oi(`insert into tenants (id, type, name, status) values
      ($1,'platform',$2,'active'), ($3,'platform',$4,'active'),
      ($5,'transporter',$6,'active'), ($7,'seeker',$8,'active')`,
    [TC, `CS Smoke Platform ${STAMP}`, TB, `CS Smoke Foreign ${STAMP}`,
      CO, `CS Smoke Cargo Ltd`, SK, `CS Smoke Seeker`]);

  const seat = (id: string, tenant: string, type: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,$3,$4,$5,'active',$6, now() - interval '2 hours', now() - interval '200 days')`,
      [id, tenant, type, name, `smoke.cs.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`,
        type === "platform"]);
  await seat(uCS, TC, "platform", "Sammy Service");
  await seat(uAgent, TC, "platform", "Amina Client");
  await seat(uEng, TC, "platform", "Emmanuel Engineer");
  await seat(uAn, TC, "platform", "Annie Analyst");
  await seat(uDir, TC, "platform", "Daudi Director");
  await seat(uFor, TB, "platform", "Juma Otherdesk");
  await seat(uCfo, CO, "staff", "Company Finance");

  await oi(`insert into user_roles (user_id, role_id) values ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10),($11,$2)`,
    [uCS, rid("super_admin"), uAgent, rid("customer_service_agent"), uEng, rid("support_engineer"),
      uAn, rid("platform_analyst"), uDir, rid("director"), uFor]);

  await oi(`insert into platform_departments (id, tenant_id, key, name, purpose, sort) values
      ($1,$3,'smoke_support_${STAMP}','Support Desk','Answers the calls',10),
      ($2,$3,'smoke_billing_${STAMP}','Billing & Revenue','The bills',20)`, [D1, D2, TC]);
  await oi(`insert into platform_departments (id, tenant_id, key, name, sort, deleted_at, deleted_by)
            values ($1,$2,'smoke_retired_${STAMP}','Retired Desk',30, now(), $3)`, [D3, TC, uCS]);
  await oi(`insert into platform_seat_departments (tenant_id, user_id, department_id, standing, assigned_by)
            values ($1,$2,$3,'member',$2)`, [TC, uEng, D2]);

  const openSession = (uid: string, tenant: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-customer-service',$6,
          now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
  for (const [uid, tenant, who] of [
    [uCS, TC, "cs"], [uAgent, TC, "agent"], [uEng, TC, "eng"], [uAn, TC, "an"],
    [uDir, TC, "dir"], [uFor, TB, "for"], [uCfo, CO, "cfo"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);

  // The one line of the platform's own copy this run touches, and what it said before.
  const COPYRIGHT = "footer.copyright";
  const hoursBefore = (await oi(
    "select value from content_blocks where key = 'footer.hours' and locale = 'en'")).rows[0]?.value ?? "";

  let A = "", B = "", C = "";   // the three incidences this run logs

  try {
    // ---------------- the door ----------------
    phase("the door (099)");
    check("an anonymous request is turned away before the register is read",
      (await call("/control/tickets")).status === 401);
    check("a cookie with no session row behind it is refused",
      (await call("/control/tickets", { ck: "waisha_control=cs-smoke-none" })).status === 401);
    const bearer = await call("/control/tickets",
      { token: await mint(uCS, TC, ["super_admin"]) });
    check("a bearer access token does not open a control desk — the cookie does",
      bearer.status === 401, { s: bearer.status });
    check("nor can a call be logged anonymously",
      (await call("/control/tickets", { body: { x: 1 } })).status === 401);
    check("the copy desk is behind the same door",
      (await call("/control/content")).status === 401);
    check("and it cannot be written from outside either",
      (await call("/control/content", { method: "PUT", body: { values: {} } })).status === 401);
    check("a company seat is refused a control session at all, whatever its role",
      (await call("/control/tickets", { ck: ck("cfo") })).status === 401,
      "this is what lets a platform-wide register bind one tenant");

    phase("the words are public before anybody signs in");
    const pub = await call("/content/footer");
    check("the footer payload answers an anonymous visitor",
      pub.status === 200 && typeof pub.json?.supportEmail === "string" &&
      Array.isArray(pub.json?.links) && "copyright" in pub.json && "hours" in pub.json,
      { keys: Object.keys(pub.json ?? {}) });
    const pubSw = await call("/content/footer?lang=sw");
    check("…in the language the visitor asked for", pubSw.status === 200 &&
      typeof pubSw.json?.supportEmail === "string");
    // 105 sent the mark to the sign-in card; 116 brought it back to the bar and took it off
    // the card, so it is said once. The block is still keyed `login.brand`.
    check("the bar is the one place the mark is said",
      typeof pubSw.json?.brand === "string" && pubSw.json.brand.length > 0,
      { keys: Object.keys(pubSw.json ?? {}) });
    const pubCopy = await call("/content/copy?lang=sw");
    check("the sign-in payload carries its own sentences and no imprint",
      typeof pubCopy.json?.loginSubtitle === "string" &&
      pubCopy.json.loginSubtitle.length > 0 && !("loginBrand" in (pubCopy.json ?? {})),
      { keys: Object.keys(pubCopy.json ?? {}) });
    check("an unknown language falls back to English rather than answering empty",
      (await call("/content/footer?lang=fr")).json?.supportEmail === pub.json?.supportEmail);

    // ---------------- two duties ----------------
    phase("reading a register and writing one are two duties");
    const dirQ = await call("/control/tickets", { ck: ck("dir") });
    check("a control seat that holds no register key is refused the queue, not shown an empty one",
      dirQ.status === 403, { s: dirQ.status });
    check("…and refused the copy desk too",
      (await call("/control/content", { ck: ck("dir") })).status === 403);
    const anQ = await call("/control/tickets", { ck: ck("an") });
    check("the analyst reads the queue with the pen taken away",
      anQ.status === 200 && anQ.json?.can_manage === false && Array.isArray(anQ.json?.items),
      { s: anQ.status, can: anQ.json?.can_manage });
    const anWrite = await call("/control/tickets",
      { ck: ck("an"), body: logBody(`Analyst wrote a call (${MARK})`) });
    check("…and cannot log one, in words that say which half is missing",
      anWrite.status === 403 && /read|settling/.test(anWrite.json?.error?.message ?? ""),
      { s: anWrite.status, m: anWrite.json?.error?.message });
    const agentQ = await call("/control/tickets", { ck: ck("agent") });
    check("the agent reads it holding the pen",
      agentQ.status === 200 && agentQ.json?.can_manage === true);
    check("running the register is not a door to the platform's own words",
      (await call("/control/content", { ck: ck("agent") })).status === 403);

    const navCS = await call("/control/auth/permissions", { ck: ck("cs") });
    check("the navigation is offered the register and the copy desk to a Super Admin",
      ["control.tickets.view", "control.tickets.manage", "control.content.manage"]
        .every(k => (navCS.json?.permissions ?? []).includes(k)), navCS.json?.permissions);
    const navAn = await call("/control/auth/permissions", { ck: ck("an") });
    check("…an analyst is offered the queue but never the pen, and never the words",
      (navAn.json?.permissions ?? []).includes("control.tickets.view") &&
      !(navAn.json?.permissions ?? []).includes("control.tickets.manage") &&
      !(navAn.json?.permissions ?? []).includes("control.content.manage"),
      navAn.json?.permissions);
    const navAgent = await call("/control/auth/permissions", { ck: ck("agent") });
    check("…and an agent gets the register without control.view",
      (navAgent.json?.permissions ?? []).includes("control.tickets.manage") &&
      !(navAgent.json?.permissions ?? []).includes("control.content.manage"),
      navAgent.json?.permissions);

    // ---------------- logging calls ----------------
    phase("logging the calls");
    const first = await call("/control/tickets", {
      ck: ck("cs"), body: {
        ...logBody(`The onboarding will not finish (${MARK})`),
        reporterPhone: PHONE_A, departmentId: D2,
        reason: "Billing owns the invoice page — it is where the onboarding stops."
      }
    });
    A = first.json?.id ?? "";
    check("a call logged straight to a department gets its number and leaves the pool",
      first.status === 201 && /^CS-\d{4}-\d{5,}$/.test(first.json?.ref ?? "") &&
      first.json?.status === "allocated" && first.json?.allocated_to === "Billing & Revenue",
      { s: first.status, r: first.json });
    const second = await call("/control/tickets", {
      ck: ck("agent"), body: { ...logBody(`A trip shows the wrong plate (${MARK})`), reporterPhone: PHONE_B }
    });
    B = second.json?.id ?? "";
    check("a call nobody has pointed yet is logged open, with no department invented for it",
      second.status === 201 && second.json?.status === "open" && second.json?.department_id === null,
      { s: second.status, r: second.json });
    check("the numbers come from the sequence, so two calls cannot share one",
      !!A && !!B && A !== B && first.json.ref !== second.json.ref,
      [first.json?.ref, second.json?.ref]);

    const aboutCompany = await call("/control/tickets", {
      ck: ck("agent"), body: {
        ...logBody(`A licence that did not arrive (${MARK})`),
        companyTenantId: CO, companyName: "typed wrongly by the desk"
      }
    });
    C = aboutCompany.json?.id ?? "";
    check("a company on the platform is linked, and the register keeps the platform's spelling",
      aboutCompany.status === 201 && aboutCompany.json?.company_name === "CS Smoke Cargo Ltd",
      { s: aboutCompany.status, n: aboutCompany.json?.company_name });
    const ghost = await call("/control/tickets", {
      ck: ck("agent"), body: { ...logBody(`Ghost company (${MARK})`), companyTenantId: randomUUID() }
    });
    check("a forged or stale company id is refused in words the desk can act on",
      ghost.status === 400 && /not a live account/i.test(ghost.json?.error?.message ?? ""),
      { s: ghost.status, m: ghost.json?.error?.message });
    const seekerAsCompany = await call("/control/tickets", {
      ck: ck("agent"), body: { ...logBody(`Seeker as company (${MARK})`), companyTenantId: SK }
    });
    check("a job seeker account is not offered as a company",
      seekerAsCompany.status === 400, { s: seekerAsCompany.status });
    const noCompany = await call("/control/tickets", {
      ck: ck("agent"), body: { ...logBody(`Nobody said who rang (${MARK})`), companyName: null }
    });
    check("a call with nobody named is refused rather than filed under blank",
      noCompany.status === 400 && /which company rang/i.test(noCompany.json?.error?.message ?? ""),
      { s: noCompany.status, m: noCompany.json?.error?.message });
    const thinBody = await call("/control/tickets", {
      ck: ck("agent"), body: { ...logBody(`Too short (${MARK})`), body: "it broke" }
    });
    check("one sentence about the problem is the floor",
      thinBody.status === 400, { s: thinBody.status });
    const closedDesk = await call("/control/tickets", {
      ck: ck("agent"), body: { ...logBody(`Handed to a closed desk (${MARK})`), departmentId: D3 }
    });
    check("work cannot be handed to a desk that has been closed",
      closedDesk.status === 400 && /not an open desk/i.test(closedDesk.json?.error?.message ?? ""),
      { s: closedDesk.status, m: closedDesk.json?.error?.message });
    const badCategory = await call("/control/tickets", {
      ck: ck("agent"), body: { ...logBody(`Wrong shelf (${MARK})`), category: "lost_parcel" }
    });
    check("a category the register does not keep is refused",
      badCategory.status === 400, { s: badCategory.status });

    // ---------------- the queue ----------------
    phase("the queue, and the number that is not in it");
    const q = await call(`/control/tickets?q=${MARK}&days=2`, { ck: ck("agent") });
    const items = q.json?.items ?? [];
    check("the search finds the calls this desk logged, in its own register",
      q.status === 200 && items.length === 3 && items.every((r: any) => r.subject.includes(MARK)),
      { n: items.length });
    const rowOf = (id: string) => items.find((r: any) => r.id === id);
    check("no list row carries the callback number, encrypted or not — only that one is on file",
      items.every((r: any) => !("phone" in r) && !("reporter_phone_encrypted" in r)) &&
      rowOf(A)?.has_phone === true && rowOf(B)?.has_phone === true &&
      rowOf(C)?.has_phone === false &&
      ![PHONE_A, PHONE_B].some((p) => q.text.includes(p.slice(1))),
      { phone: [rowOf(A)?.has_phone, rowOf(B)?.has_phone, rowOf(C)?.has_phone] });
    check("the header counts the filter the rows came from, and what is pressing",
      q.json?.summary?.n === items.length && q.json?.summary?.working >= 1 &&
      q.json?.summary?.settled === 0, q.json?.summary);
    check("the desks are listed with what each is holding, and the closed one is not offered",
      (q.json?.departments ?? []).length === 2 &&
      (q.json?.departments ?? []).every((d: any) => typeof d.unallocated === "number") &&
      !(q.json?.departments ?? []).some((d: any) => d.name === "Retired Desk"),
      q.json?.departments?.map((d: any) => `${d.name}:${d.unallocated}/${d.working}`));
    const qOpen = await call(`/control/tickets?q=${MARK}&status=open&days=2`, { ck: ck("agent") });
    check("the open tab shows only the call nobody has taken yet",
      qOpen.json?.items?.length === 2 &&
      qOpen.json.items.every((r: any) => r.status === "open"), { n: qOpen.json?.items?.length });
    const qBad = await call(`/control/tickets?status=${MARK}`, { ck: ck("agent") });
    check("a state an incidence cannot be in is refused by name",
      qBad.status === 400 && /Not a state/.test(qBad.json?.error?.message ?? ""),
      { s: qBad.status, m: qBad.json?.error?.message });
    const byPhone = await call(`/control/tickets?phone=${PHONE_A}&days=2`, { ck: ck("agent") });
    check("a number typed at the desk finds that caller's calls through the hash — even though "
      + "a raw + in a query string reaches the API as a space",
      byPhone.json?.items?.length === 1 && byPhone.json?.items[0]?.id === A &&
      byPhone.json?.filters?.phone_searched === true && !byPhone.text.includes(PHONE_A.slice(1)),
      { n: byPhone.json?.items?.length });
    const spaced = await call(`/control/tickets?phone=${encodeURIComponent(PHONE_A.replace("+255", "+255 "))}`,
      { ck: ck("agent") });
    check("…and a number typed the way it was heard, with spaces, finds the same call",
      spaced.status === 200 && spaced.json?.items?.length === 1 &&
      spaced.json?.items[0]?.id === A, { n: spaced.json?.items?.length });
    const shortPhone = await call(`/control/tickets?phone=${encodeURIComponent(PHONE_A.slice(0, 7))}`,
      { ck: ck("agent") });
    check("a term too short to be a number is refused in words, not answered with an empty register",
      shortPhone.status === 400 &&
      /eight digits/.test(JSON.stringify(shortPhone.json?.error?.details ?? "")),
      { s: shortPhone.status, d: shortPhone.json?.error?.details });
    const mine = await call(`/control/tickets?mine=1&days=2`, { ck: ck("eng") });
    check("an engineer's own tab holds only what sits at their desk",
      mine.json?.my_departments?.length === 1 &&
      mine.json?.my_departments[0]?.name === "Billing & Revenue" &&
      mine.json?.items?.length === 1 && mine.json?.items[0]?.id === A,
      { desks: mine.json?.my_departments?.map((d: any) => d.name), n: mine.json?.items?.length });
    const mineAn = await call(`/control/tickets?mine=1&days=2`, { ck: ck("an") });
    check("a seat that sits at no desk is told so with an empty tab, not the whole platform",
      mineAn.json?.my_departments?.length === 0 && mineAn.json?.items?.length === 0,
      { n: mineAn.json?.items?.length });
    const byCompany = await call(`/control/tickets?company=${CO}&days=2`, { ck: ck("an") });
    check("one company's calls are found by its link, not by its spelling",
      byCompany.json?.items?.length === 1 && byCompany.json?.items[0]?.id === C,
      { n: byCompany.json?.items?.length });
    const foreign = await call(`/control/tickets?days=2`, { ck: ck("for") });
    check("the other platform desk reads its own empty register, not ours",
      foreign.status === 200 && foreign.json?.items?.length === 0 &&
      foreign.json?.summary?.n === 0, { n: foreign.json?.items?.length });

    // ---------------- one incidence in full ----------------
    phase("the detail, where the number is allowed");
    const det = await call(`/control/tickets/${A}`, { ck: ck("an") });
    check("the detail read decrypts the callback number for a seat with the view duty",
      det.status === 200 && det.json?.ticket?.phone === PHONE_A &&
      det.json?.ticket?.phone_unreadable === false &&
      !det.text.includes("reporter_phone_encrypted"), { s: det.status });
    check("and says how many calls this number has made, without listing them",
      det.json?.ticket?.caller_history?.calls === 1 &&
      det.json?.ticket?.caller_history?.still_open === 1, det.json?.ticket?.caller_history);
    check("the body, the names and the problem are all there to read",
      det.json?.ticket?.body?.includes(MARK) && det.json?.ticket?.reporter_name ===
      "Mwanajibu A. Chachu" && det.json?.ticket?.department_name === "Billing & Revenue");
    const evs = (det.json?.events ?? []).map((e: any) => e.action);
    check("logging it straight to a desk wrote both lines of the register",
      evs.length === 2 && evs[0] === "logged" && evs[1] === "allocated" &&
      det.json.events[1].reason.includes("Billing owns"), evs);
    check("a seat with no register key cannot even open the detail",
      (await call(`/control/tickets/${A}`, { ck: ck("dir") })).status === 403);
    check("another platform desk's session cannot read it — the id is not a permission",
      (await call(`/control/tickets/${A}`, { ck: ck("for") })).status === 404);
    check("an id that is not a uuid is refused without reaching the table",
      (await call(`/control/tickets/${MARK}`, { ck: ck("an") })).status === 404);

    // ---------------- the moves ----------------
    phase("the moves the desk offers, and the machine behind them");
    const workEarly = await call(`/control/tickets/${B}/work`,
      { ck: ck("agent"), method: "POST", body: { status: "in_progress", reason: "Started the plate fix." } });
    check("work cannot be said to have started on a call nobody holds",
      workEarly.status === 409 && /nobody's yet/i.test(workEarly.json?.error?.message ?? ""),
      { s: workEarly.status, m: workEarly.json?.error?.message });
    const settleEarly = await call(`/control/tickets/${B}/resolve`,
      { ck: ck("agent"), method: "POST", body: resolveBody("resolved", "Fixed the plate.") });
    check("nor can it be called finished before a department has it",
      settleEarly.status === 409 && /Nobody holds/i.test(settleEarly.json?.error?.message ?? ""),
      { s: settleEarly.status, m: settleEarly.json?.error?.message });
    const alloc = await call(`/control/tickets/${B}/allocate`,
      { ck: ck("agent"), method: "POST", body: { departmentId: D1, reason: "Support has the fleet screens." } });
    check("handing it to a department moves it out of the pool",
      alloc.status === 200 && alloc.json?.status === "allocated" &&
      alloc.json?.department_name === "Support Desk" && !!alloc.json?.allocated_at,
      { s: alloc.status, r: alloc.json });
    const sameDesk = await call(`/control/tickets/${B}/allocate`,
      { ck: ck("agent"), method: "POST", body: { departmentId: D1, reason: "Handed it twice." } });
    check("handing it to the desk that already holds it is refused, not re-dated",
      sameDesk.status === 409 && /already holds/i.test(sameDesk.json?.error?.message ?? ""),
      { s: sameDesk.status, m: sameDesk.json?.error?.message });
    const toClosed = await call(`/control/tickets/${B}/allocate`,
      { ck: ck("agent"), method: "POST", body: { departmentId: D3, reason: "Handed to a closed desk." } });
    check("…and so is handing it to a desk that has been closed",
      toClosed.status === 400, { s: toClosed.status });
    const back = await call(`/control/tickets/${B}/allocate`,
      { ck: ck("agent"), method: "POST", body: { departmentId: null, reason: "Wrong team — back in the pool." } });
    check("sending it back to the pool clears the allocation the table insists on",
      back.status === 200 && back.json?.status === "open" && back.json?.allocated_at === null,
      { s: back.status, r: back.json });
    await call(`/control/tickets/${B}/allocate`,
      { ck: ck("agent"), method: "POST", body: { departmentId: D1, reason: "Support again, with the fleet list." } });
    const started = await call(`/control/tickets/${B}/work`,
      { ck: ck("eng"), method: "POST", body: { status: "in_progress", reason: "Support opened the plate." } });
    check("work can be said to have started once a department holds it",
      started.status === 200 && started.json?.status === "in_progress", { s: started.status });
    const again = await call(`/control/tickets/${B}/work`,
      { ck: ck("eng"), method: "POST", body: { status: "in_progress", reason: "Started it twice." } });
    check("saying it twice is refused — the register would otherwise lie about when",
      again.status === 409, { s: again.status });
    const rated = await call(`/control/tickets/${B}/priority`,
      { ck: ck("agent"), method: "POST", body: { priority: "low", reason: "The fleet list shows it is one truck." } });
    check("it can be re-rated, and the reason travels with the rating",
      rated.status === 200 && rated.json?.priority === "low", { s: rated.status });
    const rerate = await call(`/control/tickets/${B}/priority`,
      { ck: ck("agent"), method: "POST", body: { priority: "low", reason: "Rated it twice." } });
    check("re-rating it to what it already is is refused",
      rerate.status === 409 && /already low/i.test(rerate.json?.error?.message ?? ""),
      { s: rerate.status, m: rerate.json?.error?.message });
    const thinNote = await call(`/control/tickets/${B}/note`,
      { ck: ck("agent"), method: "POST", body: { reason: "ok" } });
    check("a note shorter than a sentence is refused — the register is not a scratch pad",
      thinNote.status === 400, { s: thinNote.status });
    const note = await call(`/control/tickets/${B}/note`,
      { ck: ck("agent"), method: "POST", body: { reason: "Called back: the plate is TRK-4417, not TRK-4412." } });
    check("something can be said about it without changing its state",
      note.status === 200 && !!note.json?.id, { s: note.status });
    const thinRes = await call(`/control/tickets/${B}/resolve`,
      { ck: ck("eng"), method: "POST", body: { outcome: "resolved", resolution: "ok", reason: "The plate is fixed." } });
    check("a resolution of one word is refused by the desk, not only by the table",
      thinRes.status === 400, { s: thinRes.status });
    const resolved = await call(`/control/tickets/${B}/resolve`,
      { ck: ck("eng"), method: "POST", body: resolveBody("resolved", "Corrected the plate on the trip to TRK-4417.") });
    check("it settles only with the sentence about what was done",
      resolved.status === 200 && resolved.json?.status === "resolved" &&
      !!resolved.json?.resolved_at && resolved.json?.resolution?.includes("TRK-4417"),
      { s: resolved.status, r: resolved.json });
    const reResolved = await call(`/control/tickets/${B}/resolve`,
      { ck: ck("eng"), method: "POST", body: resolveBody("resolved", "Same answer, twice.") });
    check("resolving it again is refused", reResolved.status === 409 && /already resolved/i.test(reResolved.json?.error?.message ?? ""),
      { s: reResolved.status, m: reResolved.json?.error?.message });
    const moveSettled = await call(`/control/tickets/${B}/allocate`,
      { ck: ck("agent"), method: "POST", body: { departmentId: D2, reason: "Moved a finished job." } });
    check("a settled incidence cannot be quietly pointed at a new desk",
      moveSettled.status === 409 && /Reopen it first/i.test(moveSettled.json?.error?.message ?? ""),
      { s: moveSettled.status, m: moveSettled.json?.error?.message });
    const reopenPlain = await call(`/control/tickets/${B}/work`,
      { ck: ck("eng"), method: "POST", body: { status: "in_progress", reason: "The caller rang back." } });
    check("taking a finished job back into work needs the reopen tick, not a status edit",
      reopenPlain.status === 409 && /rang back/i.test(reopenPlain.json?.error?.message ?? ""),
      { s: reopenPlain.status, m: reopenPlain.json?.error?.message });
    const reopened = await call(`/control/tickets/${B}/work`,
      { ck: ck("eng"), method: "POST", body: { status: "in_progress", reopen: true, reason: "The caller rang back: the wrong plate is on the invoice too." } });
    check("…and with it, the work is taken back and the old answer is kept beside the line",
      reopened.status === 200 && reopened.json?.status === "in_progress", { s: reopened.status });
    const earlyTomb = await call(`/control/tickets/${B}/tombstone`,
      { ck: ck("agent"), method: "POST", body: { reason: "Withdrawn while still in work." } });
    check("a withdrawal is refused while the job is unfinished — hiding is not an answer",
      earlyTomb.status === 409 && /Close .* first/i.test(earlyTomb.json?.error?.message ?? ""),
      { s: earlyTomb.status, m: earlyTomb.json?.error?.message });
    const settled = await call(`/control/tickets/${B}/resolve`,
      { ck: ck("eng"), method: "POST", body: resolveBody("resolved", "Fixed the trip and the invoice together.") });
    check("a reopened job can be settled again",
      settled.status === 200 && settled.json?.status === "resolved", { s: settled.status });
    const closed = await call(`/control/tickets/${B}/resolve`,
      { ck: ck("agent"), method: "POST", body: resolveBody("closed", "The caller confirmed both are right now.") });
    check("and closed once the answer is agreed",
      closed.status === 200 && closed.json?.status === "closed", { s: closed.status });
    const withdrawn = await call(`/control/tickets/${B}/tombstone`,
      { ck: ck("agent"), method: "POST", body: { reason: "Duplicate of a call logged twice in one morning." } });
    check("a closed incidence can be taken off the boards",
      withdrawn.status === 200 && withdrawn.json?.withdrawn === true, { s: withdrawn.status });

    const afterQueue = await call(`/control/tickets?q=${MARK}&days=2`, { ck: ck("agent") });
    check("the withdrawn call is gone from the queue while the other two stay",
      afterQueue.json?.items?.length === 2 &&
      !afterQueue.json?.items?.some((r: any) => r.id === B), { n: afterQueue.json?.items?.length });
    check("…and its detail read says it is not in the register",
      (await call(`/control/tickets/${B}`, { ck: ck("agent") })).status === 404);

    // ---------------- the register of acts ----------------
    phase("every act is its own act, in the order it happened (103, 104)");
    const evRows = (await oi(
      `select action, reason, detail from support_ticket_events
        where ticket_id = $1 order by seq`, [B])).rows;
    check("the register of one incidence reads as the story the desk lived through",
      evRows.map(r => r.action).join(",") ===
      "logged,allocated,reallocated,allocated,status_changed,priority_changed,note_added," +
      "resolved,reopened,resolved,closed,withdrawn",
      evRows.map(r => r.action).join(","));
    check("each line carries the sentence that defended it",
      evRows.every(r => (r.reason ?? "").length >= 4) &&
      evRows.filter(r => r.action === "reallocated")[0]?.reason === "Wrong team — back in the pool.",
      evRows.map(r => `${r.action}:${r.reason}`).join(" | ").slice(0, 300));
    const tomb = (await oi(
      `select action, to_label, detail from support_ticket_events
        where ticket_id = $1 order by seq desc limit 1`, [B])).rows[0];
    check("a withdrawal is recorded as a withdrawal, not as a second closing",
      tomb?.action === "withdrawn" && tomb?.detail?.withdrawn === true &&
      tomb?.to_label === "withdrawn from the register", JSON.stringify(tomb));
    const aud = (await oi(
      `select action, after from audit_logs
        where tenant_id = $1 and entity = 'support_tickets' order by ts`, [TC])).rows;
    const acts = [...new Set(aud.map(r => r.action.replace("control.tickets.", "")))];
    check("Forensics names each act the desk took, and the withdrawal has its own key",
      ["logged", "allocated", "reallocated", "status_changed", "priority_changed", "note_added",
        "resolved", "reopened", "closed", "withdrawn"].every(k => acts.includes(k)), acts);
    check("exactly one withdrawal is in the audit trail of this run",
      aud.filter(r => r.action === "control.tickets.withdrawn").length === 1,
      aud.filter(r => r.action === "control.tickets.withdrawn").length);
    check("a closing is never the key for a removal",
      !aud.some(r => r.action === "control.tickets.closed" && r.after?.reason?.includes("Duplicate of a call")));
    check("the audit line quotes the reason the operator typed",
      aud.some(r => r.after?.reason === "Billing owns the invoice page — it is where the onboarding stops."),
      aud.slice(0, 2).map(r => r.after?.reason));
    const paired = (await oi(
      `select count(*)::int as n from audit_logs a
         join support_ticket_events e on e.id = (a.after->>'event_id')::uuid
        where a.tenant_id = $1 and a.entity = 'support_tickets'`, [TC])).rows[0].n;
    check("every audit row points back at the register line that caused it",
      paired === aud.length, `${paired} of ${aud.length}`);

    // ---------------- the command center ----------------
    phase("the command center rewords the platform without a deploy");
    const desk = await call("/control/content", { ck: ck("cs") });
    const footerFields = desk.json?.groups?.[0]?.fields ?? [];
    const signinFields = desk.json?.groups?.[1]?.fields ?? [];
    // Compared against the registry rather than a number written here: 105 moved the brand
    // line from the footer group into the sign-in group, and a hard-coded 9/3 blamed the
    // desk for a change the registry had made on purpose.
    const keysOf = (group: string) =>
      CONTENT_FIELDS.filter((f) => f.group === group).map((f) => f.key).sort().join(",");
    const listed = (fs: any[]) => fs.map((f) => f.key).sort().join(",");
    check("the copy desk offers every footer line in both locales, each with who last wrote it",
      desk.status === 200 && desk.json?.can_manage === true &&
      desk.json?.locales?.join(",") === "en,sw" && desk.json?.groups?.length === 2 &&
      listed(footerFields) === keysOf("footer") && listed(signinFields) === keysOf("signin") &&
      footerFields.every((f: any) => "en" in f.values && "sw" in f.values &&
        "at" in (f.edited?.en ?? {}) && "by" in (f.edited?.en ?? {})),
      { s: desk.status, n: footerFields.length, can: desk.json?.can_manage,
        locales: desk.json?.locales, groups: desk.json?.groups?.map((g: any) => `${g.group}:${g.fields.length}`),
        expected: `${keysOf("footer")} | ${keysOf("signin")}`,
        missing: footerFields.filter((f: any) => !("en" in (f.values ?? {})) || !("sw" in (f.values ?? {}))
          || !("by" in (f.edited?.en ?? {}))).map((f: any) => f.key) });
    const wrote = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: {
        values: { [COPYRIGHT]: { en: `© ${STAMP} written by the smoke`, sw: `© ${STAMP} imeandikwa na jaribio` } },
        note: "The smoke's own run marker — restored to empty before this script exits."
      }
    });
    check("saving two lines reports the two lines it moved",
      wrote.status === 200 && wrote.json?.changed === 2 &&
      (wrote.json?.lines ?? []).length === 2, { s: wrote.status, c: wrote.json?.changed });
    const twice = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: {
        values: { [COPYRIGHT]: { en: `© ${STAMP} written by the smoke` } },
        note: "The same line sent again by the same seat, so nothing should move."
      }
    });
    // The desk builds its own writability from this answer. A PUT that answers without it turns
    // a seat that has just published into a reader, and its Update buttons vanish until reload.
    // The no-op branch is the one that was missing it.
    check("…and the answer still says the seat may keep writing",
      wrote.json?.can_manage === true && twice.json?.can_manage === true &&
      twice.json?.changed === 0,
      { first: wrote.json?.can_manage, second: twice.json?.can_manage,
        changed: twice.json?.changed });
    const pubAfter = await call("/content/footer");
    check("the public footer prints the new sentence straight away",
      pubAfter.json?.copyright === `© ${STAMP} written by the smoke`, pubAfter.json?.copyright);
    check("…in the language the visitor asked for",
      (await call("/content/footer?lang=sw")).json?.copyright === `© ${STAMP} imeandikwa na jaribio`);
    check("the desk reads back what it wrote, with the seat named",
      (wrote.json?.groups?.[0]?.fields ?? []).find((f: any) => f.key === COPYRIGHT)?.edited?.en?.by ===
      "Sammy Service",
      (wrote.json?.groups?.[0]?.fields ?? []).find((f: any) => f.key === COPYRIGHT)?.edited);
    const noop = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: {
        values: { [COPYRIGHT]: { en: `© ${STAMP} written by the smoke` } }, note: "Nothing to change."
      }
    });
    check("saving a line that already says that changes nothing and is not audited",
      noop.status === 200 && noop.json?.changed === 0 && noop.json?.unchanged === true,
      { s: noop.status, c: noop.json?.changed });

    const hostile = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: {
        values: {
          "footer.links": { en: [{ label: "Docs", href: "javascript:alert(1)" }] },
          "footer.hours": { en: `Answering hours written by ${MARK} that must not land` },
          [COPYRIGHT]: { en: `© ${STAMP} a line that should not have landed` }
        },
        note: "One bad address in a save of three lines."
      }
    });
    check("an address that would execute is refused over HTTP, in the field's own words",
      hostile.status === 400 && /full address|click/i.test(hostile.json?.error?.message ?? ""),
      { s: hostile.status, m: hostile.json?.error?.message });
    const halfWritten = await call("/content/footer");
    check("…and neither good line in that same save was written either — a footer is applied whole",
      halfWritten.json?.copyright === `© ${STAMP} written by the smoke` &&
      halfWritten.json?.hours === hoursBefore,
      { copyright: halfWritten.json?.copyright, hours: halfWritten.json?.hours });
    const unknown = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: { values: { "footer.secret": { en: "x" } }, note: "Not a block." }
    });
    check("a key no page reads is refused by name",
      unknown.status === 400 && /footer\.secret/.test(JSON.stringify(unknown.json?.error?.details ?? "")),
      { s: unknown.status, d: unknown.json?.error?.details });
    const cleared = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: { values: { [COPYRIGHT]: { en: "", sw: "" } }, note: "Back to showing nothing." }
    });
    check("an empty line is a deliberate hide, not a crash and not a delete",
      cleared.status === 200 && cleared.json?.changed === 2 &&
      (await call("/content/footer")).json?.copyright === "");
    const blockRow = await oi(
      "select count(*)::int as n from content_blocks where key = $1", [COPYRIGHT]);
    check("the row itself survives — DELETE is not a thing the desk can do",
      blockRow.rows[0].n === 2, blockRow.rows[0].n);
    const contentAudit = (await oi(
      `select action, before, after from audit_logs
        where tenant_id = $1 and entity = 'content_blocks' order by ts`, [TC])).rows;
    check("every copy save is answerable from Forensics, with the words before and after",
      contentAudit.length === 2 && contentAudit[0].action === "control.content.updated" &&
      contentAudit[0].before?.[`footer.copyright.en`] === "" &&
      contentAudit[0].after?.note?.includes("smoke") && contentAudit[0].after?.lines === 2,
      contentAudit.map(r => `${r.action}:${r.after?.lines}`));
    check("and a save that changed nothing added no audit line",
      contentAudit.length === 2, contentAudit.length);
    const stillOurs = await oi(
      "select value from content_blocks where key = 'footer.hours' and locale = 'en'");
    check("the hours line is exactly as the office left it",
      stillOurs.rows[0]?.value === hoursBefore);

    // ---- the copy desk's per-line buttons (#287) ----
    // Each Update / Retire on the desk PUTs one locale of one key, so a half-typed line sitting
    // elsewhere on the desk cannot hold it hostage. The server was always able to do that; these
    // are the shape the buttons actually send, checked as the desk sends them.
    const auditLines = () => oi(
      `select after->>'lines' as n from audit_logs
        where tenant_id = $1 and entity = 'content_blocks' order by ts`, [TC]);
    const auditBefore = (await auditLines()).rows.length;

    const twoTongues = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: {
        values: { [COPYRIGHT]: { en: `© ${STAMP} english line`, sw: `© ${STAMP} mstari wa kiswahili` } },
        note: "Both tongues of one line, so a one-tongue save has something to leave alone."
      }
    });
    check("a line written in both tongues counts as the two tongues it moved",
      twoTongues.status === 200 && twoTongues.json?.changed === 2,
      { s: twoTongues.status, c: twoTongues.json?.changed });

    const oneTongue = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: {
        values: { [COPYRIGHT]: { en: `© ${STAMP} english line, rewritten on its own` } },
        note: "What the Update button on one column of one line sends."
      }
    });
    check("a save of one tongue reports exactly the one line it moved",
      oneTongue.status === 200 && oneTongue.json?.changed === 1 &&
      (oneTongue.json?.lines ?? []).join("|") === "footer.copyright (en)",
      { s: oneTongue.status, c: oneTongue.json?.changed, l: oneTongue.json?.lines });
    check("…it rewords the language it was sent in",
      (await call("/content/footer")).json?.copyright === `© ${STAMP} english line, rewritten on its own`);
    check("…and leaves the other language's sentence standing",
      (await call("/content/footer?lang=sw")).json?.copyright === `© ${STAMP} mstari wa kiswahili`);

    const retireEn = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: {
        values: { [COPYRIGHT]: { en: "" } }, note: "What Retire on one column sends."
      }
    });
    check("retiring one language hides that language only",
      retireEn.status === 200 && retireEn.json?.changed === 1 &&
      (await call("/content/footer")).json?.copyright === "" &&
      (await call("/content/footer?lang=sw")).json?.copyright === `© ${STAMP} mstari wa kiswahili`,
      { s: retireEn.status, c: retireEn.json?.changed });

    const others = (oneTongue.json?.groups ?? []).flatMap((g: any) => g.fields)
      .filter((f: any) => f.key !== COPYRIGHT);
    const pristine = new Set((desk.json?.groups ?? []).flatMap((g: any) => g.fields)
      .filter((f: any) => f.key !== COPYRIGHT).map((f: any) =>
        `${f.key}|${JSON.stringify(f.values)}`));
    check("…and the rest of the register came back from that save exactly as it was read",
      others.length > 0 && others.every((f: any) =>
        pristine.has(`${f.key}|${JSON.stringify(f.values)}`)),
      { checked: others.length, moved: others.filter((f: any) =>
        !pristine.has(`${f.key}|${JSON.stringify(f.values)}`)).map((f: any) => f.key) });

    const tail = (await auditLines()).rows.slice(auditBefore);
    check("each of those per-line saves is audited with the count it claimed",
      tail.map((r: any) => r.n).join(",") === "2,1,1", tail.map((r: any) => r.n));

    // The desk keeps the reason box empty until the operator says why, and the button is
    // disabled rather than the request being thrown away — so an absent note must still work,
    // and a note over the ceiling must be refused before anything is written.
    const noNote = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: { values: { [COPYRIGHT]: { en: `© ${STAMP} no note given` } } }
    });
    check("a line can be published without a note; the audit just carries none",
      noNote.status === 200 && noNote.json?.changed === 1, { s: noNote.status });
    const longNote = await call("/control/content", {
      ck: ck("cs"), method: "PUT", body: {
        values: { [COPYRIGHT]: { en: `© ${STAMP} should not have landed` },
          note: "x".repeat(301)
        }
      }
    });
    check("a note past the ceiling is refused before the line is written",
      longNote.status === 400 &&
      (await call("/content/footer")).json?.copyright === `© ${STAMP} no note given`,
      { s: longNote.status, v: (await call("/content/footer")).json?.copyright });

    // ---------------- the live register was not touched ----------------
    phase("the real office's register is untouched");
    const liveAfter = (await oi(
      "select count(*)::int as n from support_tickets where tenant_id = $1", [live])).rows[0].n;
    check("no incidence was logged into the platform the real office sits on",
      liveAfter === liveBefore, { before: liveBefore, after: liveAfter });
    const liveAuditAfter = (await oi(
      "select count(*)::int as n from audit_logs where tenant_id = $1", [live])).rows[0].n;
    check("…and its audit trail did not grow either",
      liveAuditAfter === liveAuditBefore, { before: liveAuditBefore, after: liveAuditAfter });
    const withA = bodies.filter(b => b.includes(PHONE_A));
    const withB = bodies.filter(b => b.includes(PHONE_B));
    const snippet = (b: string) => b.slice(Math.max(0, b.indexOf(PHONE_B) - 60), b.indexOf(PHONE_B) + 40);
    check("across every payload of the run the callback number appears in exactly one — its detail read",
      withA.length === 1 && withA[0].includes("Mwanajibu") && withB.length === 0,
      { appearances: withA.length, bWhere: withB.map(snippet) });
  } finally {
    // The one global row this run touched goes back to the empty line the seed left it at.
    await oi(`update content_blocks set value = '', updated_by = null, updated_at = now()
               where key = $1 and locale = any($2)`, [COPYRIGHT, ["en", "sw"]]).catch(() => { });
    const hours = await oi(
      "select value from content_blocks where key = 'footer.hours' and locale = 'en'").catch(() => null);
    if (hours && hours.rows[0]?.value !== hoursBefore) {
      await oi(`update content_blocks set value = $1 where key = 'footer.hours' and locale = 'en'`,
        [hoursBefore]).catch(() => { });
    }
    await sweep();
    await clearBuckets("tickets", "content", "audit");
    const left = await oi(
      `select (select count(*)::int from tenants where name like $1) as t,
              (select count(*)::int from support_tickets where tenant_id in
                 (select id from tenants where name like $1)) as k,
              (select count(*)::int from support_ticket_events where tenant_id in
                 (select id from tenants where name like $1)) as e,
              (select value from content_blocks where key = 'footer.copyright' and locale = 'en') as c`,
      [TENANT_SWEEP]);
    check("teardown left none of this run's tenants, incidences, acts or words behind",
      left.rows[0].t === 0 && left.rows[0].k === 0 && left.rows[0].e === 0 &&
      left.rows[0].c === "", JSON.stringify(left.rows[0]));
    check("the public footer prints the platform's own line again",
      (await call("/content/footer")).json?.copyright === "");
    await owner.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "all checks passed"} — marker ${MARK}`);
  if (failures) process.exitCode = 1;
}

function logBody(subject: string) {
  return {
    reporterName: "Mwanajibu A. Chachu",
    reporterEmail: `caller${MARK}@example.co.tz`,
    channel: "phone_call",
    companyName: "CS Smoke Cargo Ltd",
    category: "system_error",
    subject,
    body: `Rangia ya ${MARK}: sehemu ya mfumo haifanyi kazi, na mteja alisema kwamba hatua inayofuata haionekani.`,
    priority: "urgent"
  };
}
function resolveBody(outcome: "resolved" | "closed", resolution: string) {
  return { outcome, resolution, reason: `${resolution} Verified with the caller on the line.` };
}

main().catch((e) => { console.error(e); process.exit(1); });
