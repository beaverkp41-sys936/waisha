/**
 * A desk's terms, its numbers and its routing rules over HTTP — smoke for #339c (123's routes).
 *
 * verify-desk-hours-sql.ts proves the week, the working-minutes clock, the row-locked queue
 * number and the archive guard inside the database. This proves the parts a database cannot see:
 * that a term the desk did not send keeps what it said, that 123's own refusals arrive as a 409
 * in words rather than a 500 about a constraint, that reading the chart and setting its terms are
 * two duties, that every rule write leaves a register line and an audit row with a before and an
 * after, and that the matcher's answer the desk is shown is the definer's answer and not a guess.
 *
 * It also proves the two rules the desk cannot check for itself: a rule that narrows on nothing
 * would swallow the whole queue, and a desk with a call standing on it cannot be filed away — the
 * second one is refused by 123's trigger, and the route has to pass that sentence through.
 *
 * Fixtures are this run's own two platform tenants, its own company, its own desks and its own
 * rules — never the desk the real office sits on — and everything is torn down by those ids. The
 * live platform's row counts are read before and after to prove it. Writes stay under each seat's
 * own rate ceilings, and the tail of the rule writes is done from a second admin seat, so a 429
 * cannot be mistaken for a broken guard.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-departments-sla.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const TENANT_SWEEP = "Sla Smoke %";
const EMAIL_SWEEP = `smoke.sla.%@waisha.test`;
const PHONE = `+255714${STAMP}`;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const bodies: string[] = [];
async function call(path: string, opts: { ck?: string; token?: string; method?: string; body?: any } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    headers: {
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.ck ? { Cookie: `waisha_control=${opts.ck}` } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {})
    }
  });
  const text = await res.text();
  bodies.push(text);
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const WEEK_OPEN = {
  mon: { open: "08:00", close: "17:30" }, tue: { open: "08:00", close: "17:30" },
  wed: { open: "08:00", close: "17:30" }, thu: { open: "08:00", close: "17:30" },
  fri: { open: "08:00", close: "17:00" }, sat: { open: "09:00", close: "13:00" },
  sun: null
};
const WEEK_SHUT = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };

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
    [["super_admin", "platform_analyst", "customer_service_agent"]]
  )).rows;
  const rid = (k: string) => roleIds.find((r: any) => r.key === k)?.id;
  if (!rid("super_admin") || !rid("platform_analyst")) {
    throw new Error("the global platform roles 084 and 123's routes run on are missing");
  }

  const live = (await oi(
    `select id from tenants where type = 'platform' and deleted_at is null
      order by created_at limit 1`)).rows[0]?.id;
  if (!live) throw new Error("no live platform tenant to compare against");
  const before = async (table: string) => (await oi(
    `select count(*)::int as n from ${table} where tenant_id = $1`, [live])).rows[0].n;
  const liveTicketsBefore = await before("support_tickets");
  const liveDesksBefore = await before("platform_departments");
  const liveRulesBefore = await before("support_ticket_routes");

  const geo = await oi(`select id, name_en as name from geo_regions where is_active order by id limit 2`);
  if (geo.rows.length < 2) throw new Error("geo_regions needs two live regions for a rule to name");
  const [R1, R2] = [geo.rows[0].id as number, geo.rows[1].id as number];
  // Far enough past the real ids to match no region, small enough to stay inside the route's own
  // number ceiling — so the refusal below comes from the desk's lookup, not from a schema bound.
  const RBOGUS = (await oi(`select coalesce(max(id), 0) + 9000 as n from geo_regions`)).rows[0].n as number;

  // ---------------- fixtures ----------------
  const TC = randomUUID();        // the platform whose chart this run reshapes
  const TB = randomUUID();        // a second platform desk: its chart is not ours
  const CO = randomUUID();        // a company with a head office in R1
  const CN = randomUUID();        // a company with no branch on file at all

  const uSA = randomUUID();       // super_admin: reads the chart and owns its terms and rules
  const uSA2 = randomUUID();      // a second admin seat — see the rule-write ceiling below
  const uAN = randomUUID();       // platform_analyst: reads, writes nothing
  const uCS = randomUUID();       // customer_service_agent: neither department key
  const uFor = randomUUID();      // super_admin of the other platform desk

  const D1 = randomUUID();        // Support Desk     — open, the one this run gives terms
  const D2 = randomUUID();        // Billing & Revenue — open, escalation target
  const D3 = randomUUID();        // Retired Desk      — closed

  const RA = randomUUID();        // Bills on WhatsApp  → D1
  const RB = randomUUID();        // Urgent anything      → D1
  const RC = randomUUID();        // Cargo in R1          → D2

  const tok = (who: string) => `sla-smoke-${who}-${STAMP}`;
  const ck = (who: string) => tok(who);

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    const tks = (await oi(`select id from support_tickets where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    if (tks.length) {
      await oi(`delete from support_ticket_events where ticket_id = any($1::uuid[])`, [tks]);
      await oi(`delete from support_tickets where id = any($1::uuid[])`, [tks]);
    }
    await oi(`delete from support_ticket_routes where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from platform_duty_transitions where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from platform_seat_departments where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from platform_departments where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from branches where tenant_id = any($1::uuid[])`, [all]);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await clearBuckets("dept:", "dept-one:", "dept-write:", "dept-rules:", "dept-rules-write:",
    "tickets:", "tickets-write:", "audit:");

  await oi(`insert into tenants (id, type, name, status) values
      ($1,'platform',$2,'active'), ($3,'platform',$4,'active'),
      ($5,'transporter',$6,'active'), ($7,'transporter',$8,'active')`,
    [TC, `Sla Smoke Platform ${STAMP}`, TB, `Sla Smoke Foreign ${STAMP}`,
      CO, `Sla Smoke Kilimanjaro Freight`, CN, `Sla Smoke No Branch Ltd`]);

  const seat = (id: string, tenant: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,'platform',$3,$4,'active',true, now() - interval '2 hours',
                now() - interval '200 days')`,
      [id, tenant, name, `smoke.sla.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`]);
  await seat(uSA, TC, "Sada Admin");
  await seat(uSA2, TC, "Bina Admin");
  await seat(uAN, TC, "Annie Analyst");
  await seat(uCS, TC, "Cally Service");
  await seat(uFor, TB, "Juma Otherdesk");

  await oi(`insert into user_roles (user_id, role_id) values ($1,$2),($3,$2),($4,$5),($6,$7),($8,$2)`,
    [uSA, rid("super_admin"), uSA2, uAN, rid("platform_analyst"),
      uCS, rid("customer_service_agent"), uFor]);

  await oi(`insert into platform_departments (id, tenant_id, key, name, purpose, sort) values
      ($1,$3,'sla_support_${STAMP}','Support Desk','Answers the calls',10),
      ($2,$3,'sla_billing_${STAMP}','Billing and Revenue','The bills',20)`, [D1, D2, TC]);
  await oi(`insert into platform_departments (id, tenant_id, key, name, sort, deleted_at, deleted_by)
            values ($1,$2,'sla_retired_${STAMP}','Retired Desk',30, now(), $3)`, [D3, TC, uSA]);
  await oi(`insert into platform_departments (id, tenant_id, key, name, sort)
            values ($1,$2,'sla_other_${STAMP}','Foreign Desk',10)`, [randomUUID(), TB]);

  await oi(`insert into branches (tenant_id, kind, name, region_id)
            values ($1,'hq',$2,$3)`, [CO, `Sla Smoke HQ`, R1]);

  const openSession = (uid: string, tenant: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-departments-sla','127.0.0.1',
                now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who))]);
  for (const [uid, tenant, who] of [
    [uSA, TC, "sa"], [uSA2, TC, "sa2"], [uAN, TC, "an"], [uCS, TC, "cs"], [uFor, TB, "for"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);

  let ticketRef = "";
  let ticketId = "";

  try {
    // ---------------- the door and the two duties ----------------
    phase("the door and the two duties");
    check("an anonymous request does not reach the rules",
      (await call("/control/departments/routes")).status === 401);
    // 099 opened the door to a cookie only; the three new surfaces must inherit that, not
    // quietly accept an access token the desk was never signed into.
    const bearer = await call("/control/departments/routes", {
      token: await mint(uSA, TC, ["super_admin"])
    });
    check("an access token does not open the rules desk — the session cookie does",
      bearer.status === 401, { s: bearer.status });
    const anRead = await call("/control/departments/routes", { ck: ck("an") });
    check("the seat that only reads is let in and told it only reads",
      anRead.status === 200 && anRead.json.can_manage === false,
      { s: anRead.status, cm: anRead.json?.can_manage });
    const anWrite = await call("/control/departments/routes", {
      ck: ck("an"), body: { name: "Analyst tries", departmentId: D1, channels: ["email"], reason: "x" }
    });
    check("…and its write is refused in words, not by a silent empty page",
      anWrite.status === 403 && /duty|allow/i.test(anWrite.json?.error?.message ?? ""),
      { s: anWrite.status, m: anWrite.json?.error?.message });
    check("…as is a write to a desk's terms",
      (await call(`/control/departments/${D1}/terms`, {
        ck: ck("an"), method: "PUT", body: { maxOpenTickets: 5, reason: "Analyst tries." }
      })).status === 403);
    check("a seat with neither department key is turned away from the rules",
      (await call("/control/departments/routes", { ck: ck("cs") })).status === 403);
    const foreign = await call("/control/departments/routes", { ck: ck("for") });
    check("a second platform desk reads its own empty rules, not this one's",
      foreign.status === 200 && foreign.json.rules.length === 0,
      { s: foreign.status, n: foreign.json?.rules?.length });

    // ---------------- the terms ----------------
    phase("a desk sets its terms");
    const terms = await call(`/control/departments/${D1}/terms`, {
      ck: ck("sa"), method: "PUT", body: {
        firstResponseMinutes: 120, resolveMinutes: 1440, businessHours: WEEK_OPEN,
        escalationDepartmentId: D2, maxOpenTickets: 3,
        reason: "The office agreed a two-hour answer and a same-week fix."
      }
    });
    check("all five terms land in one write",
      terms.status === 200 && terms.json.first_response_minutes === 120
      && terms.json.resolve_minutes === 1440 && terms.json.max_open_tickets === 3
      && terms.json.escalation_department_id === D2,
      { s: terms.status, j: terms.json });
    const d1row = (await oi(
      `select first_response_minutes, resolve_minutes, business_hours, escalation_department_id,
              max_open_tickets, ticket_seq::int as ticket_seq, key
         from platform_departments where id = $1`, [D1])).rows[0];
    check("…and the row says what the desk said",
      d1row.first_response_minutes === 120 && d1row.resolve_minutes === 1440
      && d1row.escalation_department_id === D2 && d1row.max_open_tickets === 3
      && d1row.business_hours.fri.close === "17:00" && d1row.business_hours.sun === null
      && d1row.ticket_seq === 0);
    check("the terms write is one line in the desk's register and one in the audit trail",
      (await oi(`select count(*)::int as n from platform_duty_transitions
                  where tenant_id = $1 and action = 'department_updated'
                    and to_department_id = $2 and reason like '%two-hour answer%'`,
        [TC, D1])).rows[0].n === 1
      && (await oi(`select count(*)::int as n from audit_logs
                     where tenant_id = $1 and entity = 'platform_departments'
                       and action = 'control.departments.department_updated'
                       and after ? 'first_response_minutes'`, [TC])).rows[0].n === 1);
    check("a desk that only changes its ceiling keeps the clocks it already set",
      (await call(`/control/departments/${D1}/terms`, {
        ck: ck("sa"), method: "PUT", body: { maxOpenTickets: 6, reason: "Six calls at a time now." }
      })).status === 200 && (await oi(
        `select first_response_minutes, resolve_minutes, max_open_tickets
           from platform_departments where id = $1`, [D1])).rows[0].resolve_minutes === 1440);
    check("…and an absent key is not read as a clearing",
      (await oi(`select escalation_department_id from platform_departments where id = $1`,
        [D1])).rows[0].escalation_department_id === D2);

    const upside = await call(`/control/departments/${D1}/terms`, {
      ck: ck("sa"), method: "PUT", body: {
        firstResponseMinutes: 600, resolveMinutes: 240, reason: "An hour to answer, four to fix."
      }
    });
    check("an answer cannot be promised after the fix is owed",
      upside.status === 400 && /first response has to fit/i.test(upside.json?.error?.message ?? ""),
      { s: upside.status, m: upside.json?.error?.message });
    check("a desk cannot escalate to itself",
      (await call(`/control/departments/${D1}/terms`, {
        ck: ck("sa"), method: "PUT",
        body: { escalationDepartmentId: D1, reason: "Send it back to us." }
      })).status === 400);
    check("…or to a desk that has been filed away",
      (await call(`/control/departments/${D1}/terms`, {
        ck: ck("sa"), method: "PUT",
        body: { escalationDepartmentId: D3, reason: "Send it to the retired desk." }
      })).status === 400);
    const loop = await call(`/control/departments/${D2}/terms`, {
      ck: ck("sa"), method: "PUT",
      body: { escalationDepartmentId: D1, reason: "Billing sends its work up to Support." }
    });
    check("a chain that comes back to the desk it started at is refused by name",
      loop.status === 409 && /Support Desk/.test(loop.json?.error?.message ?? ""),
      { s: loop.status, m: loop.json?.error?.message });
    check("a week is refused before it reaches the database's own shape check",
      (await call(`/control/departments/${D1}/terms`, {
        ck: ck("sa"), method: "PUT", body: {
          businessHours: { mon: { open: "25:00", close: "17:30" } }, reason: "A desk that never opens."
        }
      })).status === 400);
    check("…and so is a day that closes before it opens",
      (await call(`/control/departments/${D1}/terms`, {
        ck: ck("sa"), method: "PUT", body: {
          businessHours: { mon: { open: "17:30", close: "08:00" } }, reason: "Backwards."
        }
      })).status === 400);
    check("a write that names no term is refused rather than rewriting nothing quietly",
      (await call(`/control/departments/${D1}/terms`, {
        ck: ck("sa"), method: "PUT", body: { reason: "Just a reason." }
      })).status === 400);
    const shut = await call(`/control/departments/${D1}/terms`, {
      ck: ck("sa"), method: "PUT",
      body: { businessHours: WEEK_SHUT, reason: "Shut the desk for the test." }
    });
    check("a desk that promises an answer but is shut every day is told so",
      shut.status === 200 && typeof shut.json.clock_note === "string"
      && /no call can be given a due date/.test(shut.json.clock_note),
      { s: shut.status, note: shut.json?.clock_note });
    const reopened = await call(`/control/departments/${D1}/terms`, {
      ck: ck("sa"), method: "PUT",
      body: { businessHours: WEEK_OPEN, reason: "Open the desk again." }
    });
    check("…and the week goes back when the desk reopens",
      reopened.status === 200 && reopened.json.clock_note === null
      && reopened.json.business_hours?.mon?.open === "08:00",
      { s: reopened.status, note: reopened.json?.clock_note });

    // ---------------- the desk's numbers ----------------
    phase("one desk, with its numbers");
    const logged = await call("/control/tickets", {
      ck: ck("sa"), body: {
        reporterName: "Amina Client", reporterPhone: PHONE, channel: "whatsapp",
        companyTenantId: CO, category: "licence_billing",
        subject: "The invoice will not open", body: "The PDF link the system sent says forbidden.",
        priority: "high", departmentId: D1, reason: "Rang in about an invoice she cannot read."
      }
    });
    ticketId = logged.json?.id ?? "";
    ticketRef = logged.json?.ref ?? "";
    check("a call is logged onto the desk the detail read counts",
      logged.status === 201 && !!ticketId, { s: logged.status, j: logged.json });
    const one = await call(`/control/departments/${D1}?days=30`, { ck: ck("sa") });
    check("the detail read answers the desk's own numbers",
      one.status === 200 && one.json.department.name === "Support Desk"
      && one.json.kpi.live === 1 && one.json.kpi.unworked === 0
      && one.json.kpi.waiting === 1 && one.json.tickets.length === 1,
      { s: one.status, kpi: one.json?.kpi, t: one.json?.tickets?.length });
    check("…with room under the ceiling and the chain above and below it",
      one.json.headroom === 5 && one.json.escalation.up.length === 1
      && one.json.escalation.up[0].name === "Billing and Revenue"
      && one.json.escalation.down.length === 0 && one.json.open_week === true,
      { hr: one.json?.headroom, up: one.json?.escalation?.up, dn: one.json?.escalation?.down });
    // The desk's terms were set two phases ago, so the call standing on it must carry a number
    // of its own and two live clocks. A desk with no terms prints no clock at all — that case is
    // the tickets-clock smoke's job, on a bare desk.
    check("…and the calls standing on it carry their desk number and both clock states",
      one.json.tickets[0].ref === ticketRef && one.json.tickets[0].has_phone === true
      && one.json.tickets[0].dept_number === 1
      && one.json.tickets[0].dept_ref === `${d1row.key.toUpperCase()}-1`
      && one.json.tickets[0].response_due_at !== null
      && ["on_time", "at_risk", "breached", "kept", "late"].includes(one.json.tickets[0].response_clock)
      && one.json.tickets[0].resolution_clock === "on_time"
      && one.json.kpi.no_clock === 0 && one.json.kpi.numbers_issued === 1,
      { t: one.json?.tickets?.[0], kpi: one.json?.kpi, key: d1row.key });
    check("a detail read of a desk never prints the callback number",
      !one.text.includes(PHONE) && !one.text.includes("reporter_phone_encrypted"),
      { has: one.text.includes(PHONE) });
    check("the rules panel on the desk is empty until a rule names it",
      one.json.rules.length === 0);
    check("an unknown desk id is a 404 in words, not a 500 about a uuid",
      (await call(`/control/departments/${randomUUID()}?days=30`, { ck: ck("sa") })).status === 404
      && (await call("/control/departments/not-a-uuid", { ck: ck("sa") })).status === 404);

    // ---------------- the routing rules ----------------
    phase("who takes a call nobody pointed anywhere");
    const mk = (body: any) => call("/control/departments/routes", { ck: ck("sa"), body });
    const ra = await mk({
      name: "Bills on WhatsApp", departmentId: D1, channels: ["whatsapp"],
      categories: ["licence_billing"], precedence: 10, note: "The office's own billing chats.",
      reason: "Billing chats should reach Support without a clerk deciding."
    });
    const RAID = ra.json?.id ?? "";
    check("a rule is written and said back in one sentence",
      ra.status === 200 && /called on whatsapp/.test(ra.json?.sentence ?? "")
      && /goes to Support Desk/.test(ra.json?.sentence ?? ""),
      { s: ra.status, sen: ra.json?.sentence });
    const ruleRow = (await oi(
      `select id, name, department_id, channels, categories, precedence, is_active, note,
              created_by, deleted_at, tenant_id from support_ticket_routes where id = $1`,
      [RAID])).rows[0];
    check("…in this run's own tenant, by the seat that wrote it, with the reason kept",
      ruleRow?.tenant_id === TC && ruleRow?.created_by === uSA && ruleRow?.precedence === 10
      && ruleRow?.is_active === true && ruleRow?.deleted_at === null
      && (await oi(`select count(*)::int as n from audit_logs where tenant_id = $1
                     and entity = 'support_ticket_routes' and entity_id = $2
                     and after -> 'reason' is not null`, [TC, RAID])).rows[0].n === 1,
      { row: ruleRow });
    check("two rules cannot answer to one name",
      (await mk({ name: "Bills on WhatsApp", departmentId: D1, channels: ["email"],
        reason: "A second one with the same name." })).status === 409);
    const catchAll = await mk({ name: "Everything to Support", departmentId: D1,
      channels: [], categories: [], reason: "One rule for the whole queue." });
    check("a rule that narrows on nothing is refused before it can swallow the queue",
      catchAll.status === 400 && /narrows on nothing/.test(catchAll.json?.error?.message ?? ""),
      { s: catchAll.status, m: catchAll.json?.error?.message });
    check("…nor is one that names a region nobody recognises",
      (await mk({ name: "Ghost region", departmentId: D1, regionIds: [RBOGUS],
        reason: "A region id from a dream." })).status === 400);
    check("…nor one aimed at a desk that has been filed away",
      (await mk({ name: "To the retired desk", departmentId: D3, channels: ["email"],
        reason: "Point it at the closed desk." })).status === 400);
    const rb = await mk({
      name: "Urgent anything", departmentId: D1, priorities: ["urgent"], languages: ["en"],
      precedence: 10, reason: "Urgent calls should not wait for a category."
    });
    const RBID = rb.json?.id ?? "";
    check("a second rule at the same precedence is allowed, and the list says so",
      rb.status === 200 && rb.json.narrows.join() === "priorities,languages",
      { s: rb.status, n: rb.json?.narrows });
    const rc = await mk({
      name: "Cargo out of the home region", departmentId: D2, categories: ["cargo_clearing"],
      regionIds: [R1, R2], precedence: 5, reason: "Clearing calls go to Billing, region first."
    });
    const RCID = rc.json?.id ?? "";
    check("a region rule keeps its regions by name, not only by id",
      rc.status === 200 && rc.json.sentence.includes("from ") && rc.json.fired === 0,
      { s: rc.status, sen: rc.json?.sentence });

    const list = await call("/control/departments/routes", { ck: ck("an") });
    check("the list is in the order the matcher reads it, with the clash named",
      list.status === 200 && list.json.rules.length === 3
      && list.json.rules[0].name === "Cargo out of the home region"
      && list.json.precedence_clashes.length === 1
      && list.json.precedence_clashes[0].precedence === 10
      && list.json.precedence_clashes[0].names.length === 2
      && list.json.regions.length >= 2
      && list.json.desks.some((d: any) => d.id === D1 && d.live_tickets === 1),
      { n: list.json?.rules?.length, cl: list.json?.precedence_clashes });

    phase("the matcher, asked without writing anything");
    const m1 = await call("/control/departments/routes/match", {
      ck: ck("sa"), body: { channel: "whatsapp", category: "licence_billing",
        priority: "normal", language: "en" }
    });
    check("a billing chat is taken by the rule that names both predicates",
      m1.status === 200 && m1.json.routed_to?.rule_name === "Bills on WhatsApp"
      && m1.json.routed_to.department_name === "Support Desk"
      && m1.json.rules_that_fit.length === 1 && /does not log it/.test(m1.json.note),
      { s: m1.status, r: m1.json?.routed_to, f: m1.json?.rules_that_fit });
    const m2 = await call("/control/departments/routes/match", {
      ck: ck("sa"), body: { channel: "phone_call", category: "licence_billing",
        priority: "urgent", language: "en" }
    });
    check("an urgent call the channel rule does not fit goes to the urgency rule",
      m2.json.routed_to?.rule_name === "Urgent anything"
      && m2.json.rules_that_fit.length === 1,
      { r: m2.json?.routed_to, f: m2.json?.rules_that_fit });
    const m3 = await call("/control/departments/routes/match", {
      ck: ck("sa"), body: { channel: "phone_call", category: "cargo_clearing",
        priority: "normal", language: "en", companyId: CO }
    });
    check("the company's own head office region decides, and the desk is told which",
      m3.status === 200 && m3.json.call.regionId === R1
      && m3.json.company === "Sla Smoke Kilimanjaro Freight"
      && typeof m3.json.region_name === "string" && m3.json.region_name.length > 0
      && m3.json.region_note === null,
      { s: m3.status, call: m3.json?.call, co: m3.json?.company, rn: m3.json?.region_name });
    check("…a region rule wins on precedence over the ones that also fit",
      m3.json.routed_to?.rule_name === "Cargo out of the home region"
      && m3.json.region_name && m3.json.rules_that_fit.length >= 1
      && m3.json.rules_that_fit.some((r: any) => r.won === true),
      { r: m3.json?.routed_to, f: m3.json?.rules_that_fit });
    const m4 = await call("/control/departments/routes/match", {
      ck: ck("sa"), body: { channel: "email", category: "onboarding",
        priority: "low", language: "sw" }
    });
    check("a call no rule fits is said to need a clerk, not routed to a guess",
      m4.status === 200 && m4.json.routed_to === null
      && m4.json.rules_that_fit.length === 0 && /No live rule fits/.test(m4.json.note),
      { r: m4.json?.routed_to, f: m4.json?.rules_that_fit });
    const m5 = await call("/control/departments/routes/match", {
      ck: ck("sa"), body: { channel: "phone_call", category: "cargo_clearing",
        priority: "normal", language: "en", companyId: CN }
    });
    check("a company with no head office on file matches a region rule not at all",
      m5.json.routed_to === null && /no head office region on file/.test(m5.json.region_note ?? ""),
      { r: m5.json?.routed_to, note: m5.json?.region_note });
    check("an id that is not a live company is refused rather than read as no region",
      (await call("/control/departments/routes/match", {
        ck: ck("sa"), body: { channel: "phone_call", category: "cargo_clearing",
          priority: "normal", companyId: randomUUID() }
      })).status === 400);
    check("a channel word the register does not use is refused, not answered as no_rule",
      (await call("/control/departments/routes/match", {
        ck: ck("sa"), body: { channel: "telegram", category: "cargo_clearing", priority: "low" }
      })).status === 400);
    check("the dry run wrote nothing",
      (await oi(`select count(*)::int as n from support_tickets where tenant_id = $1`,
        [TC])).rows[0].n === 1);

    phase("editing a rule keeps its presence rules");
    // The rule-write ceiling is twenty a seat per five minutes, and this file alone asks a desk
    // to take, edit, switch off and retire twenty-one of them. The tail of the run is written
    // from the second admin seat so a 429 cannot be read as a broken guard.
    const patch = (id: string, body: any, who = "sa") =>
      call(`/control/departments/routes/${id}`, { ck: ck(who), method: "PATCH", body });
    const moved = await patch(RAID, { precedence: 50, note: "Kept, but later now.",
      reason: "Support should answer the urgent calls first." });
    check("an edit changes only what it names",
      moved.status === 200 && moved.json.precedence === 50 && moved.json.note === "Kept, but later now."
      && moved.json.channels.join() === "whatsapp" && moved.json.changed.join() === "precedence,note",
      { s: moved.status, j: moved.json });
    check("…and leaves the row in step with the sentence",
      (await oi(`select precedence, categories, is_active from support_ticket_routes where id = $1`,
        [RAID])).rows[0].precedence === 50);
    const dropOne = await patch(RAID, { channels: [], reason: "The channel is not the point." });
    check("a predicate sent empty stops narrowing, and the rule still narrows on something",
      dropOne.status === 200 && dropOne.json.channels.length === 0
      && dropOne.json.narrows.join() === "categories",
      { s: dropOne.status, m: dropOne.json?.error?.message, n: dropOne.json?.narrows });
    const dropLast = await patch(RAID, { categories: [], reason: "Take the last predicate off." });
    check("the last predicate cannot be dropped — the rule would take everything",
      dropLast.status === 400 && /narrow on nothing/.test(dropLast.json?.error?.message ?? "")
      && /Bills on WhatsApp/.test(dropLast.json?.error?.message ?? ""),
      { s: dropLast.status, m: dropLast.json?.error?.message });
    check("…and the row is exactly as it was before the refusal",
      (await oi(`select categories, channels from support_ticket_routes where id = $1`,
        [RAID])).rows[0].categories.join() === "licence_billing");
    check("two rules cannot be renamed into one name",
      (await patch(RAID, { name: "Urgent anything", reason: "Same name as the other one." })).status === 409);
    const off = await patch(RBID, { isActive: false, reason: "Urgency is not a route today." });
    check("a switched-off rule stops taking calls",
      off.status === 200 && off.json.is_active === false
      && (await call("/control/departments/routes/match", {
        ck: ck("sa"), body: { channel: "phone_call", category: "complaint",
          priority: "urgent", language: "en" }
      })).json.routed_to === null,
      { s: off.status });
    check("…and the list no longer offers it",
      (await call("/control/departments/routes", { ck: ck("an") })).json.rules.length === 3);
    await patch(RBID, { isActive: true, reason: "Urgency is a route again." });
    check("an edit of a rule that is not there is a 404",
      (await patch(randomUUID(), { precedence: 3, reason: "Nothing to change." })).status === 404
      && (await patch("nonsense", { precedence: 3, reason: "Nothing to change." })).status === 404);
    check("an edit that names nothing is refused",
      (await patch(RAID, { reason: "Only a reason." })).status === 400);

    phase("one rule, and the desk it points at");
    const detail = await call(`/control/departments/routes/${RCID}`, { ck: ck("an") });
    check("the detail read says what the rule does and where it sends it",
      detail.status === 200 && detail.json.department_name === "Billing and Revenue"
      && detail.json.desk_is_open === true && detail.json.regions.length === 2
      && detail.json.can_manage === false && detail.json.fired === 0,
      { s: detail.status, j: detail.json });
    const onDesk = await call(`/control/departments/${D2}?days=30`, { ck: ck("sa") });
    check("the desk's own page lists the rule that points at it and only that one",
      onDesk.json.rules.length === 1 && onDesk.json.rules[0].id === RCID
      && onDesk.json.escalation.down.some((d: any) => d.name === "Support Desk"),
      { r: onDesk.json?.rules, dn: onDesk.json?.escalation?.down });

    phase("retiring a rule keeps the evidence");
    const retire = await call(`/control/departments/routes/${RCID}/retire`, {
      ck: ck("sa"), body: { reason: "Region routing was a pilot and it did not help." }
    });
    const retiredRow = (await oi(
      `select deleted_at is not null as gone, deleted_by is not null as by_whom,
              is_active, precedence, name
         from support_ticket_routes where id = $1`, [RCID])).rows[0];
    check("a retire is a stamp, not a deletion",
      retire.status === 200 && retire.json.retired === true && retiredRow?.gone === true
      && retiredRow?.by_whom === true && retiredRow?.is_active === false
      && retiredRow?.precedence === 5 && retiredRow?.name === "Cargo out of the home region",
      { s: retire.status, row: retiredRow });
    check("…the retired rule still answers a read, with its sentence",
      (await call(`/control/departments/routes/${RCID}`, { ck: ck("an") })).json.deleted_at !== null
      && /goes to Billing and Revenue/.test(retire.json.sentence));
    check("…and cannot be edited any more",
      (await patch(RCID, { precedence: 1, reason: "Bring it back by number." })).status === 409);
    check("…nor retired twice",
      (await call(`/control/departments/routes/${RCID}/retire`, {
        ck: ck("sa"), body: { reason: "Retire it again." }
      })).status === 409);
    check("a call shaped like the pilot is now left for a clerk",
      (await call("/control/departments/routes/match", {
        ck: ck("sa"), body: { channel: "phone_call", category: "cargo_clearing",
          priority: "normal", language: "en", regionId: R1 }
      })).json.routed_to === null);
    check("the desk the rule aimed at is unchanged by the retire",
      (await oi(`select count(*)::int as n from platform_departments where id = $2 and tenant_id = $1
                  and deleted_at is null`, [TC, D2])).rows[0].n === 1);

    // ---------------- closing a desk that still holds work ----------------
    phase("a desk with a call on it cannot be filed away");
    const closeBare = await call(`/control/departments/${D1}/close`, {
      ck: ck("sa"), method: "POST", body: { reason: "Support is being folded up." }
    });
    check("the refusal names the calls standing on the desk",
      closeBare.status === 409 && ticketRef && closeBare.text.includes(ticketRef)
      && /cannot be filed away/.test(closeBare.json?.error?.message ?? ""),
      { s: closeBare.status, m: closeBare.json?.error?.message });
    check("…and the calls did not move",
      (await oi(`select department_id from support_tickets where id = $1`, [ticketId]))
        .rows[0].department_id === D1);
    check("the calls cannot be moved to a desk that is itself filed away",
      (await call(`/control/departments/${D1}/close`, {
        ck: ck("sa"), method: "POST",
        body: { moveTicketsTo: D3, reason: "Fold Support, drop the calls on the retired desk." }
      })).status === 400);
    const closed = await call(`/control/departments/${D1}/close`, {
      ck: ck("sa"), method: "POST",
      body: { moveTicketsTo: D2, reason: "Fold Support; Billing takes its calls." }
    });
    check("with a refuge named, the desk closes and the call carries over",
      closed.status === 200 && closed.json.tickets_moved === 1
      && (await oi(`select department_id, status from support_tickets where id = $1`, [ticketId]))
        .rows[0].department_id === D2,
      { s: closed.status, j: closed.json });
    check("…every carried call gets its own line in the incidence's history",
      (await oi(`select count(*)::int as n from support_ticket_events
                  where ticket_id = $1 and action = 'reallocated'
                    and reason like 'Closing Support Desk%'`, [ticketId])).rows[0].n === 1);
    check("…and the closed desk keeps a rule pointed at it from firing",
      (await patch(RBID, { note: "Still here, nowhere to go.", reason: "Annotate the orphan." }, "sa2"))
        .status === 400);
    const back = await call(`/control/departments/${D1}/reopen`, {
      ck: ck("sa"), method: "POST", body: { reason: "Support is open again for the test." }
    });
    const repoint = await patch(RBID, { note: "Back in service.", reason: "The desk reopened." }, "sa2");
    check("a closed desk can be reopened and its rule pointed again",
      back.status === 200 && repoint.status === 200
      && repoint.json.note === "Back in service.", { back: back.json, repoint: repoint.json });

    // ---------------- scope and residue ----------------
    phase("the register keeps what this run did");
    const audit = await oi(
      `select count(*)::int as lines,
              count(*) filter (where after ? 'reason')::int as with_reason,
              count(distinct action)::int as actions,
              count(distinct entity)::int as entities
         from audit_logs where tenant_id = $1
           and entity in ('platform_departments','support_ticket_routes')`, [TC]);
    const register = await oi(
      `select count(*)::int as lines from platform_duty_transitions
        where tenant_id = $1 and action = any($2::text[])`,
      [TC, ["department_updated", "department_closed", "department_reopened"]]);
    // record() writes the register line and the audit line in one transaction, so the two
    // counts agreeing is the proof that no act was allowed to happen unrecorded.
    check("every term and rule write left an audit line with a reason, one per register line",
      audit.rows[0].lines === register.rows[0].lines && audit.rows[0].lines >= 12
      && audit.rows[0].with_reason === audit.rows[0].lines
      && audit.rows[0].entities === 2 && audit.rows[0].actions >= 3,
      { audit: audit.rows[0], register: register.rows[0] });
    const transitions = (await oi(
      `select count(*)::int as n from platform_duty_transitions where tenant_id = $1
         and reason is not null and char_length(trim(reason)) >= 4`, [TC])).rows[0].n;
    check("…and a sentence in the desk's own register for each of them",
      transitions >= 10, { transitions });
    check("no rule in this run's chart points at another tenant's desk",
      (await oi(`select count(*)::int as n from support_ticket_routes r
                  join platform_departments d on d.id = r.department_id
                 where r.tenant_id = $1 and d.tenant_id <> $1`, [TC])).rows[0].n === 0);
    check("the platform desk the real office sits on was not touched",
      (await before("support_tickets")) === liveTicketsBefore
      && (await before("platform_departments")) === liveDesksBefore
      && (await before("support_ticket_routes")) === liveRulesBefore);
  } finally {
    await sweep();
    await clearBuckets("dept:", "dept-one:", "dept-write:", "dept-rules:", "dept-rules-write:",
      "tickets:", "tickets-write:");
    const residue = await oi(
      `select (select count(*)::int from tenants where name like $1) as t,
              (select count(*)::int from users where email like $2) as u,
              (select count(*)::int from platform_departments where tenant_id in
                 (select id from tenants where name like $1)) as d,
              (select count(*)::int from support_ticket_routes where tenant_id in
                 (select id from tenants where name like $1)) as r,
              (select count(*)::int from support_tickets where tenant_id in
                 (select id from tenants where name like $1)) as k,
              (select count(*)::int from branches where tenant_id in
                 (select id from tenants where name like $1)) as b`,
      [TENANT_SWEEP, EMAIL_SWEEP]);
    check("the smoke's tenants, desks, rules, calls and branches are gone",
      residue.rows[0].d === 0 && residue.rows[0].r === 0 && residue.rows[0].k === 0
      && residue.rows[0].b === 0 && residue.rows[0].t === 0 && residue.rows[0].u === 0,
      residue.rows[0]);
    const left = await oi(
      `select (select count(*)::int from support_ticket_events where tenant_id in
                 (select tenant_id from support_ticket_events group by tenant_id
                   having max(ts) > now() - interval '5 minutes')
                and tenant_id not in (select id from tenants)) as orphan_events,
              (select count(*)::int from platform_duty_transitions where tenant_id in
                 (select id from tenants where name like $1)) as gone_transitions`,
      [TENANT_SWEEP]);
    check("no event line was left pointing at a tenant that is no longer there",
      left.rows[0].orphan_events === 0 && left.rows[0].gone_transitions === 0,
      left.rows[0]);
    console.log(`\n${failures ? `${failures} FAILURE(S)` : "all checks passed"} — `
      + `${STAMP}`);
    await owner.end();
    process.exit(failures ? 1 : 0);
  }
}

main().catch((e) => { console.error("CRASHED:", e?.response?.data ?? e); process.exit(1); });
