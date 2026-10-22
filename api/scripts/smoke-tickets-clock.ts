/**
 * A call's number, its two promises and its move up the chain, over HTTP — smoke for #339d.
 *
 * verify-customer-service-sql.ts proves the clock arithmetic, the row-locked mint and the
 * coalesce that keeps a breached deadline alive through an escalation, all inside one rolled
 * back transaction. None of that is what this run is for. What only a live API can answer is
 * whether a clerk sitting at the desk actually gets those facts: that the terms written a
 * minute earlier through /departments/:id/terms are the ones a call logged seconds later is
 * measured against, that the two sentences a call with no clock gets are said in words rather
 * than delivered as a NULL a panel has to interpret, that a desk at its own ceiling takes the
 * call anyway when it is the phone that rang and refuses it when it is a person choosing to
 * hand work over, and that an escalation past a full desk is allowed because a ticket nobody
 * can move is a ticket nobody is answering.
 *
 * The three shapes 123 is really about are all here too: a routed call takes a desk but keeps
 * 101's `open` state and holds no allocation — a rule is not a person who picked up the phone;
 * a queue number minted by one desk still names that desk after another one drops the call; and
 * `first_response_at` is only ever set by a human act, never by the logging of the call.
 *
 * The clock in this run is the real one, so every deadline is asserted as an ordering against
 * the desk's own promise — owed at least its full ninety minutes of real time after the ring —
 * never as a date written in this file. That arithmetic belongs to the SQL gate, which pins the
 * ring to a Friday evening it chooses.
 *
 * Fixtures are this run's own platform tenants, its own five desks, its own two rules, its own
 * company and its own calls — never the desk the real office sits on — and every one of them is
 * torn down by those ids. The live platform's row counts are read before and after to prove it.
 * Writes are split between two seats so a limiter window cannot be mistaken for a broken guard.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/smoke-tickets-clock.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);

const STAMP = Date.now().toString().slice(-8);
const TENANT_SWEEP = "Tck Smoke %";
const EMAIL_SWEEP = `smoke.tck.%@waisha.test`;
const MARK = `tcksmoke${STAMP}`;
const PHONE = `+255715${STAMP.slice(0, 6)}`;
const MIN = 60_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function phase(name: string) { console.log(`\n--- ${name} ---`); }

const ms = (v: unknown) => (v instanceof Date ? v.getTime() : v ? new Date(String(v)).getTime() : 0);

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
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

/** The week an office would actually keep: a Friday that shuts at 17:00 and a Sunday with no
 *  open time at all. */
const WEEK = {
  mon: { open: "08:00", close: "17:30" }, tue: { open: "08:00", close: "17:30" },
  wed: { open: "08:00", close: "17:30" }, thu: { open: "08:00", close: "17:30" },
  fri: { open: "08:00", close: "17:00" }, sat: { open: "09:00", close: "13:00" },
  sun: null
};

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
  if (!rid("super_admin") || !rid("platform_analyst") || !rid("customer_service_agent")) {
    throw new Error("the global roles 101 and 123's duties are seeded on are missing");
  }

  const live = (await oi(
    `select id from tenants where type = 'platform' and deleted_at is null
      order by created_at limit 1`)).rows[0]?.id;
  if (!live) throw new Error("no live platform tenant to compare against");
  const before = async (table: string) => (await oi(
    `select count(*)::int as n from ${table} where tenant_id = $1`, [live])).rows[0].n;
  const start = {
    tickets: await before("support_tickets"),
    desks: await before("platform_departments"),
    rules: await before("support_ticket_routes")
  };

  const geo = await oi(`select id, name_en as name from geo_regions where is_active order by id limit 2`);
  if (geo.rows.length < 2) throw new Error("geo_regions needs two live regions for a rule to name");
  const R1 = geo.rows[0].id as number;

  // ---------------- fixtures ----------------
  const TC = randomUUID();          // the platform whose queue this run works
  const TB = randomUUID();          // a second platform desk: its register is not ours
  const CO = randomUUID();          // a company whose head office is in R1
  const CN = randomUUID();          // a company with no branch on file at all

  const uSA = randomUUID();         // super_admin: sets terms and rules, and can move work
  const uAN = randomUUID();         // platform_analyst: reads the register, writes nothing
  const uCS = randomUUID();         // customer_service_agent: answers phones, sets no terms
  const uFor = randomUUID();        // super_admin of the other platform tenant

  const D1 = randomUUID();          // Support Desk        — terms, escalation above to D2
  const D2 = randomUUID();          // Billing and Revenue — the desk above
  const D3 = randomUUID();          // The Squeeze         — a ceiling of one, deliberately
  const D4 = randomUUID();          // Regional Desk       — a rule's target
  const D5 = randomUUID();          // Bare Desk           — open, with no terms set at all

  const tok = (who: string) => `tck-smoke-${who}-${STAMP}`;
  const ck = (who: string) => tok(who);

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))] as string[];
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
    // audit_logs is append-only (082's trigger refuses a delete), and that is the point: the
    // lines this run wrote stay as the register's own evidence, with their tenant gone.
    await oi(`delete from branches where tenant_id = any($1::uuid[])`, [all]);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
  };
  await sweep();
  await clearBuckets("tickets:", "tickets-one:", "tickets-write:", "dept:", "dept-one:",
    "dept-write:", "dept-rules:", "dept-rules-write:", "audit:");

  await oi(`insert into tenants (id, type, name, status) values
      ($1,'platform',$2,'active'), ($3,'platform',$4,'active'),
      ($5,'transporter',$6,'active'), ($7,'transporter',$8,'active')`,
    [TC, `Tck Smoke Platform ${STAMP}`, TB, `Tck Smoke Foreign ${STAMP}`,
      CO, `Tck Smoke Kilimanjaro Freight`, CN, `Tck Smoke No Branch Ltd`]);

  const seat = (id: string, tenant: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,'platform',$3,$4,'active',true, now() - interval '2 hours',
                now() - interval '200 days')`,
      [id, tenant, name, `smoke.tck.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`]);
  await seat(uSA, TC, "Tasa Admin");
  await seat(uAN, TC, "Annie Analyst");
  await seat(uCS, TC, "Cally Service");
  await seat(uFor, TB, "Juma Otherdesk");

  await oi(`insert into user_roles (user_id, role_id) values ($1,$2),($3,$4),($5,$6),($7,$2)`,
    [uSA, rid("super_admin"), uAN, rid("platform_analyst"),
      uCS, rid("customer_service_agent"), uFor]);

  const desk = (id: string, deskKey: string, name: string, sort: number) =>
    oi(`insert into platform_departments (id, tenant_id, key, name, purpose, sort)
        values ($1,$2,$3,$4,'Smoke desk, read only by this script.',$5)`,
      [id, TC, deskKey, name, sort]);
  await desk(D1, `tck_support_${STAMP}`, "Support Desk", 10);
  await desk(D2, `tck_billing_${STAMP}`, "Billing and Revenue", 20);
  await desk(D3, `tck_squeeze_${STAMP}`, "The Squeeze", 30);
  await desk(D4, `tck_region_${STAMP}`, "Regional Desk", 40);
  await desk(D5, `tck_bare_${STAMP}`, "Bare Desk", 50);
  await desk(randomUUID(), `tck_other_${STAMP}`, "Foreign Desk", 10);
  /** A queue number is spelled with the desk's key as the chart stores it — in capitals. */
  const upperKey = async (id: string) => (await oi(
    `select upper(key) as k from platform_departments where id = $1`, [id])).rows[0].k as string;

  await oi(`insert into branches (tenant_id, kind, name, region_id)
            values ($1,'hq',$2,$3)`, [CO, `Tck Smoke HQ`, R1]);

  const openSession = (uid: string, tenant: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-tickets-clock','127.0.0.1',
                now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who))]);
  for (const [uid, tenant, who] of [
    [uSA, TC, "sa"], [uAN, TC, "an"], [uCS, TC, "cs"], [uFor, TB, "for"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  const mint = async (sub: string, tid: string, roles: string[]) =>
    new SignJWT({ tid, sid: randomUUID(), typ: roles[0], roles })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sub).setIssuedAt().setExpirationTime("15m").sign(key);

  /** The register row as the table holds it: the instants for comparing, the desk's wall clock
   *  for reading, since that is how a desk writes its own board. */
  const row = async (id: string) => (await oi(
    `select t.status, t.department_id, t.numbered_by, t.dept_ref, t.dept_number,
            t.allocated_by, t.allocated_at, t.ts, t.response_due_at, t.resolution_due_at,
            t.first_response_at, t.after_hours, t.escalated_from_id, t.escalated_at,
            t.deleted_at,
            to_char(t.ts at time zone 'Africa/Dar_es_Salaam', 'YYYY-MM-DD HH24:MI') as rang,
            to_char(t.response_due_at at time zone 'Africa/Dar_es_Salaam',
              'YYYY-MM-DD HH24:MI') as owed_answer,
            to_char(t.resolution_due_at at time zone 'Africa/Dar_es_Salaam',
              'YYYY-MM-DD HH24:MI') as owed_fix
       from support_tickets t where t.id = $1`, [id])).rows[0];
  // 104's sequence, not (ts, id): two acts of one request share the transaction's now(),
  // and id is a random uuid, so ordering by those printed the allocated line above the
  // "logged" line that caused it — the same trap the register's own SQL avoids.
  const events = async (id: string) => (await oi(
    `select seq, action, reason, detail from support_ticket_events
      where ticket_id = $1 order by seq`, [id])).rows;

  const logBody = (over: Record<string, any> = {}) => ({
    reporterName: "Amina Juma", reporterPhone: PHONE, channel: "phone_call",
    companyName: "Tck Smoke Freight", category: "cargo_clearing",
    subject: `Clearing stuck at the port ${MARK}`,
    body: "The caller says a container has been held since Tuesday and nobody has answered "
      + "the reference she was given.",
    priority: "normal", ...over
  });

  try {
    // ---------------- the door ----------------
    phase("who may open the register");
    check("an anonymous request does not reach the queue",
      (await call("/control/tickets")).status === 401);
    const bearer = await call("/control/tickets", { token: await mint(uSA, TC, ["super_admin"]) });
    check("an access token does not open it either — the desk signs in with its session cookie",
      bearer.status === 401, { s: bearer.status });
    const anRead = await call("/control/tickets", { ck: ck("an") });
    check("the seat that only reads gets in and is told it only reads",
      anRead.status === 200 && anRead.json?.can_manage === false,
      { s: anRead.status, cm: anRead.json?.can_manage });
    const anWrite = await call("/control/tickets", { ck: ck("an"), body: logBody() });
    check("…and its attempt to log a call is refused in words, not by a silent empty page",
      anWrite.status === 403 && /duty|allow/i.test(anWrite.json?.error?.message ?? ""),
      { s: anWrite.status, m: anWrite.json?.error?.message });
    const csTerms = await call(`/control/departments/${D1}/terms`, {
      ck: ck("cs"), method: "PUT", body: { firstResponseMinutes: 60, reason: "An hour to answer." }
    });
    check("the seat that answers the phone may take a call but may not set a desk's promise",
      csTerms.status === 403 && /duty|allow|department/i.test(csTerms.json?.error?.message ?? ""),
      { s: csTerms.status, m: csTerms.json?.error?.message });
    const foreign = await call("/control/tickets", { ck: ck("for") });
    check("a second platform desk reads its own empty register, not this one's",
      foreign.status === 200 && foreign.json?.items?.length === 0
      && foreign.json?.summary?.n === 0,
      { s: foreign.status, n: foreign.json?.summary?.n });

    // ---------------- a desk's terms, then a call measured against them ----------------
    phase("the terms a desk just set are the ones its next call is held to");
    const t1 = await call(`/control/departments/${D1}/terms`, {
      ck: ck("sa"), method: "PUT", body: {
        firstResponseMinutes: 90, resolveMinutes: 960, businessHours: WEEK,
        escalationDepartmentId: D2, maxOpenTickets: 3,
        reason: "Ninety minutes to answer, a day and a half to fix, three calls at a time."
      }
    });
    check("Support Desk has terms now",
      t1.status === 200 && t1.json?.first_response_minutes === 90,
      { s: t1.status, j: t1.json });
    for (const [id, body] of [
      [D2, { firstResponseMinutes: 240, resolveMinutes: 2880, businessHours: WEEK,
        maxOpenTickets: 5, reason: "Four hours to answer, a week to fix." }],
      [D3, { firstResponseMinutes: 30, resolveMinutes: 120, businessHours: WEEK,
        escalationDepartmentId: D1, maxOpenTickets: 1, reason: "One call at a time, honestly." }],
      [D4, { firstResponseMinutes: 45, resolveMinutes: 480, businessHours: WEEK,
        maxOpenTickets: 4, reason: "A region's own desk." }]
    ] as [string, Record<string, any>][]) {
      const r = await call(`/control/departments/${id}/terms`, {
        ck: ck("sa"), method: "PUT", body
      });
      if (r.status !== 200) throw new Error(`terms for a fixture desk failed: ${r.text.slice(0, 300)}`);
    }
    const keyD1 = await upperKey(D1);
    const keyD5 = await upperKey(D5);
    const keyD3 = await upperKey(D3);

    const c1 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D1, reason: "Named straight to Support." })
    });
    const r1 = await row(c1.json?.id);
    check("a call logged straight to a desk takes that desk's own queue number as it is written",
      c1.status === 201 && c1.json?.dept_ref === `${keyD1}-1`
      && c1.json?.dept_number === 1 && c1.json?.status === "allocated",
      { s: c1.status, ref: c1.json?.dept_ref, num: c1.json?.dept_number, st: c1.json?.status });
    check("…the number is spelled from the desk's key in capitals, which is what the caller is "
      + "read over the phone", new RegExp(`^${keyD1}-[0-9]+$`).test(String(c1.json?.dept_ref)),
      c1.json?.dept_ref);
    check("…the promises are counted from the minute the phone rang, not from this request, and "
      + "are never shorter in real time than the working minutes the desk promised",
      ms(r1?.response_due_at) - ms(r1?.ts) >= 90 * MIN
      && ms(r1?.resolution_due_at) - ms(r1?.ts) >= 960 * MIN,
      r1 && [r1.rang, r1.owed_answer, r1.owed_fix]);
    check("…an answer is always owed before the fix, whichever way the desk's week falls",
      !!r1?.owed_answer && !!r1?.owed_fix && r1.rang <= r1.owed_answer
      && r1.owed_answer <= r1.owed_fix, r1 && [r1.rang, r1.owed_answer, r1.owed_fix]);
    check("…the desk's terms come back with the call so a panel can explain a deadline without "
      + "a second query",
      c1.json?.clock?.first_response_minutes === 90 && c1.json?.clock?.resolve_minutes === 960
      && c1.json?.clock?.department === "Support Desk", c1.json?.clock);
    check("the out-of-hours mark is the desk's week read at the minute of the ring, so it can "
      + "never contradict the answer the register gives about the desk being open",
      c1.json?.clock?.after_hours === !c1.json?.clock?.desk_is_open_now,
      c1.json?.clock && [c1.json.clock.after_hours, c1.json.clock.desk_is_open_now]);
    check("…and when the desk is shut the caller is told the clock waits for opening rather than "
      + "being handed a date and no explanation",
      c1.json?.clock_note === null || /out of hours/i.test(String(c1.json?.clock_note)),
      c1.json?.clock_note);
    check("logging a call does not stop the answer clock — the stamp belongs to the first human act",
      r1?.first_response_at === null, r1?.first_response_at);
    const c1events = await events(c1.json.id);
    check("one line for the call and one for the desk it landed on, each with its own sentence",
      c1events.length === 2 && c1events[0].action === "logged"
      && c1events[1].action === "allocated"
      && c1events[1].detail?.by === "the clerk who took the call",
      c1events.map((e: any) => e.action));
    check("…the number and both deadlines are written into the register line, not only into the answer",
      c1events[0].detail?.dept_ref === `${keyD1}-1` && !!c1events[0].detail?.response_due_at,
      c1events[0].detail);

    // ---------------- a desk that set nothing ----------------
    phase("a desk that has promised nothing is not given a promise");
    const c6 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D5, subject: `No clock on this one ${MARK}` })
    });
    const r6 = await row(c6.json?.id);
    check("Bare Desk numbers the call it is holding, because a number is not a promise",
      c6.status === 201 && c6.json?.dept_ref === `${keyD5}-1`,
      { s: c6.status, ref: c6.json?.dept_ref });
    check("…and its two deadlines stay empty rather than being filled in on the desk's behalf",
      r6?.owed_answer === null && r6?.owed_fix === null, r6 && [r6.owed_answer, r6.owed_fix]);
    check("…the sentence names which desk set nothing and where that changes",
      /has set no answer time/i.test(String(c6.json?.clock_note))
      && /Bare Desk/.test(String(c6.json?.clock_note)), c6.json?.clock_note);

    // ---------------- who takes a call nobody chose ----------------
    phase("the rules answer, and a routed call is not an allocated one");
    const ruleA = await call("/control/departments/routes", {
      ck: ck("sa"), body: {
        name: `Bills on WhatsApp ${MARK}`, departmentId: D1, channels: ["whatsapp"],
        categories: ["licence_billing"], precedence: 30,
        reason: "Billing questions that arrive on WhatsApp are Support's for now."
      }
    });
    check("a rule is written and answers to the name it was given",
      ruleA.status === 200 && ruleA.json?.name === `Bills on WhatsApp ${MARK}` && !!ruleA.json?.id,
      { s: ruleA.status, j: ruleA.json });
    const c2 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({
        channel: "whatsapp", category: "licence_billing",
        subject: `Licence charge looks wrong ${MARK}`, reporterName: "Baraka Mushi"
      })
    });
    const r2 = await row(c2.json?.id);
    check("a call nobody pointed anywhere is answered by the rules, not by a guess",
      c2.status === 201 && c2.json?.routed_by_rule === `Bills on WhatsApp ${MARK}`
      && c2.json?.allocated_to === "Support Desk",
      { s: c2.status, rule: c2.json?.routed_by_rule, to: c2.json?.allocated_to });
    check("…it takes the desk's queue number exactly as a hand-named call does",
      r2?.dept_ref === `${keyD1}-2` && r2?.dept_number === 2 && r2?.numbered_by === D1,
      r2 && [r2.dept_ref, r2.dept_number, r2.numbered_by]);
    check("…and it stays `open` with no allocation: the number says whose problem it is, the "
      + "state says nobody has started — a rule is not a person who picked up the phone",
      r2?.status === "open" && r2?.department_id === D1 && r2?.allocated_by === null
      && r2?.allocated_at === null, r2 && [r2.status, r2.allocated_by, r2.allocated_at]);
    const c2events = await events(c2.json.id);
    const routedLine = c2events.find((e: any) => e.action === "routed");
    check("the register has its own word for a rule doing it, and the line carries the rule's id "
      + "so a renamed rule still shows what it did",
      routedLine?.detail?.rule_id === ruleA.json?.id
      && routedLine?.detail?.precedence === 30
      && /sent it to Support Desk/.test(String(routedLine?.reason)),
      routedLine && [routedLine.detail, routedLine.reason]);
    check("…which is the line the rules board counts as a firing",
      (await oi(`select count(*)::int as n from support_ticket_events e
                 where e.detail->>'rule_id' = $1 and e.action = 'routed'`,
        [ruleA.json?.id])).rows[0].n === 1);

    const ruleB = await call("/control/departments/routes", {
      ck: ck("sa"), body: {
        name: `Fleet from the home region ${MARK}`, departmentId: D4, channels: ["email"],
        categories: ["transport_fleet"], regionIds: [R1],
        reason: "A fleet problem from a company whose office we have on file goes to the region."
      }
    });
    const c5 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({
        channel: "email", category: "transport_fleet", companyTenantId: CO,
        companyName: undefined, subject: `A truck is parked ${MARK}`,
        reporterName: "Esther Nyange"
      })
    });
    const r5 = await row(c5.json?.id);
    check("a rule narrowed on a region reads that region from the company's own head office",
      ruleB.status === 200 && c5.status === 201
      && c5.json?.routed_by_rule === `Fleet from the home region ${MARK}`
      && r5?.department_id === D4, { s: c5.status, to: c5.json?.allocated_to });
    check("…the name typed by the clerk is replaced by the platform's own spelling, so the link "
      + "and the label cannot disagree about who a call was about",
      c5.json?.company_name === "Tck Smoke Kilimanjaro Freight", c5.json?.company_name);
    const c5events = await events(c5.json.id);
    check("…and the region the matcher tested is written into the line, not left to be inferred",
      Number(c5events.find((e: any) => e.action === "routed")?.detail?.region_tested) === R1,
      c5events.find((e: any) => e.action === "routed")?.detail);

    const c4 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({
        channel: "email", category: "transport_fleet", companyTenantId: CN,
        companyName: undefined, subject: `Nobody has this call ${MARK}`,
        reporterName: "Joseph Athumani"
      })
    });
    const r4 = await row(c4.json?.id);
    check("a company with no branch on file matches a region rule not at all — the register does "
      + "not read a missing head office as any head office",
      c4.status === 201 && c4.json?.routed_by_rule === null && c4.json?.allocated_to === null
      && r4?.department_id === null && r4?.dept_ref === null,
      { s: c4.status, to: c4.json?.allocated_to, dept: r4?.department_id });
    check("…and the answer says so plainly: nobody holds it, so nothing has been promised",
      /No routing rule fits/i.test(String(c4.json?.clock_note)) && c4.json?.clock === null,
      c4.json?.clock_note);
    const c3 = await call("/control/tickets", {
      ck: ck("cs"),
      body: logBody({ category: "complaint", subject: `An agent was rude ${MARK}`,
        reporterName: "Fatuma Hassan" })
    });
    check("a call no rule covers and nobody names is kept anyway, unnumbered and unclocked",
      c3.status === 201 && c3.json?.dept_ref === null && c3.json?.clock === null,
      { s: c3.status, ref: c3.json?.dept_ref });

    // ---------------- the ceiling: taken by phone, refused by hand ----------------
    phase("a full desk takes a call and refuses a hand-over");
    const f1 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D3, subject: `First at the squeeze ${MARK}`,
        reporterName: "Hamisi Salum" })
    });
    check("one call at a time is the ceiling The Squeeze set for itself, and it is not yet full",
      f1.status === 201 && f1.json?.dept_ref === `${keyD3}-1` && f1.json?.over_ceiling === false,
      { s: f1.status, ref: f1.json?.dept_ref, oc: f1.json?.over_ceiling });
    const f2 = await call("/control/tickets", {
      ck: ck("cs"), body: logBody({ departmentId: D3, subject: `Second at the squeeze ${MARK}`,
        reporterName: "Rashida Ali" })
    });
    check("…a second one is still written down: the call has already happened, and refusing to "
      + "keep it is the one act a register has no excuse for",
      f2.status === 201 && f2.json?.dept_ref === `${keyD3}-2`,
      { s: f2.status, ref: f2.json?.dept_ref });
    check("…and the desk is told, in the same answer, that it is now past its own line",
      f2.json?.over_ceiling === true, f2.json?.over_ceiling);
    const push = await call(`/control/tickets/${c3.json.id}/allocate`, {
      ck: ck("sa"), body: { departmentId: D3, reason: "Support is busy, try the squeeze." }
    });
    check("a person choosing to hand work to a full desk is refused, and the refusal names both "
      + "figures and the way out",
      push.status === 409 && /ceiling it set for itself/.test(push.json?.error?.message ?? "")
      && /2 live calls, 1 allowed/.test(push.json?.error?.message ?? "")
      && /Escalate the incidence to the desk above/.test(push.json?.error?.message ?? ""),
      { s: push.status, m: push.json?.error?.message });
    const r3a = await row(c3.json.id);
    check("…and refusing the move left the call exactly where it was — unheld and unnumbered",
      r3a?.department_id === null && r3a?.dept_ref === null,
      r3a && [r3a.department_id, r3a.dept_ref]);

    // ---------------- the clock is stopped by a person ----------------
    phase("the answer stamp is a human act");
    const noteOnBare = await call(`/control/tickets/${c4.json.id}/note`, {
      ck: ck("cs"), body: { reason: "Tried the caller back, no answer." }
    });
    check("a note on a call nobody holds stops no clock: a sentence in the margin is not an "
      + "answer to the caller",
      noteOnBare.status === 200 && noteOnBare.json?.first_response_at === null
      && (await row(c4.json.id)).first_response_at === null,
      { s: noteOnBare.status, fr: noteOnBare.json?.first_response_at });
    const noteHeld = await call(`/control/tickets/${c6.json.id}/note`, {
      ck: ck("cs"), body: { reason: "Called back and explained the file is with the clearing agent." }
    });
    const r6b = await row(c6.json.id);
    check("the same note on a call a desk holds is a human answer whatever the status column says",
      noteHeld.status === 200 && !!noteHeld.json?.first_response_at && !!r6b?.first_response_at,
      noteHeld.json);
    check("…and it never invents deadlines a bare desk never set",
      r6b?.owed_answer === null && r6b?.owed_fix === null, r6b && [r6b.owed_answer, r6b.owed_fix]);

    const work = await call(`/control/tickets/${c1.json.id}/work`, {
      ck: ck("cs"), body: { status: "in_progress", reason: "Pulled the file and rang the agent." }
    });
    check("saying work has started stops the answer clock and keeps the desk's queue number",
      work.status === 200 && work.json?.status === "in_progress" && !!work.json?.first_response_at
      && work.json?.dept_ref === `${keyD1}-1`,
      { s: work.status, ref: work.json?.dept_ref, fr: work.json?.first_response_at });
    const reWork = await call(`/control/tickets/${c1.json.id}/work`, {
      ck: ck("cs"), body: { status: "in_progress", reason: "Started again." }
    });
    check("…and saying it twice is refused rather than silently re-stamped",
      reWork.status === 409 && /already in_progress/.test(reWork.json?.error?.message ?? ""),
      { s: reWork.status, m: reWork.json?.error?.message });

    // ---------------- a breach the desk can see from the queue ----------------
    phase("the queue reads the clock in three words");
    await oi(`update support_tickets set response_due_at = now() - interval '2 hours'
               where id = $1`, [c2.json.id]);
    const late = await call("/control/tickets?clock=late", { ck: ck("sa") });
    const lateRows = late.json?.items ?? [];
    const breached = lateRows.find((t: any) => t.id === c2.json.id);
    check("a call whose answer time has passed with nobody on it is the first thing the desk is "
      + "shown when it asks what is late",
      late.status === 200 && !!breached && !lateRows.some((t: any) => t.id === c1.json.id),
      { s: late.status, n: lateRows.length });
    check("…the row says `breached` in the same words the header counts in, and which desk is "
      + "holding it",
      breached?.response_state === "breached" && breached?.department_name === "Support Desk",
      breached && [breached.response_state, breached.department_name]);
    check("…and the header's own overdue count is the same filter the rows came from",
      Number(late.json?.summary?.overdue) === lateRows.length && lateRows.length >= 1,
      { overdue: late.json?.summary?.overdue, rows: lateRows.length });
    await call(`/control/tickets/${c2.json.id}/note`, {
      ck: ck("cs"), body: { reason: "Answered: the charge was a duplicate line, now corrected." }
    });
    const c2again = (await call(`/control/tickets?q=${encodeURIComponent(`${keyD1}-2`)}`,
      { ck: ck("sa") })).json?.items?.[0];
    check("answering a breached call does not erase the breach — it is measured against the "
      + "deadline it missed, and reads `late`",
      c2again?.response_state === "late" && c2again?.dept_ref === `${keyD1}-2`,
      c2again && [c2again.response_state, c2again.dept_ref]);
    const r5b = await row(c5.json.id);
    check("…and answering one call stops no other desk's clock — the stamp belongs to the "
      + "incidence it was said on",
      r5b?.first_response_at === null && r5b?.status === "open", r5b && [r5b.first_response_at, r5b.status]);

    const noClock = await call("/control/tickets?clock=no_clock", { ck: ck("sa") });
    const noClockIds = (noClock.json?.items ?? []).map((t: any) => t.id);
    check("the calls with nothing promised about them are a filter, not a footnote",
      noClock.status === 200 && noClockIds.includes(c6.json.id) && !noClockIds.includes(c1.json.id),
      { s: noClock.status, n: noClockIds.length });
    const searched = await call(`/control/tickets?q=${encodeURIComponent(`${keyD1}-1`)}`,
      { ck: ck("sa") });
    check("the queue can be searched by the number the caller was actually read out",
      searched.status === 200 && searched.json?.items?.length === 1
      && searched.json.items[0].id === c1.json.id,
      { s: searched.status, n: searched.json?.items?.length });
    check("…and the row names the desk that minted it, not only the one holding it",
      searched.json?.items?.[0]?.numbered_by_name === "Support Desk"
      && searched.json.items[0].dept_ref === `${keyD1}-1`, searched.json?.items?.[0]);
    const queue = (await call("/control/tickets", { ck: ck("sa") })).json;
    check("the board counts the calls still waiting for a number, which is what it needs before "
      + "it can promise anything",
      Number(queue?.summary?.unnumbered) >= 2 && Number(queue?.summary?.no_clock) >= 1,
      queue?.summary);
    const load = queue?.departments ?? [];
    const squeeze = load.find((d: any) => d.id === D3);
    check("the desk board shows each desk living past the ceiling it set, by name and by number",
      squeeze?.live_tickets === 2 && squeeze?.max_open_tickets === 1 && squeeze?.unnumbered === 0,
      squeeze);
    const bareBoard = load.find((d: any) => d.id === D5);
    check("…and a desk holding a call with no clock is visible as exactly that",
      bareBoard?.no_clock === 1 && bareBoard?.live_tickets === 1, bareBoard);
    const regional = load.find((d: any) => d.id === D4);
    check("…while a desk with a call nobody has answered yet is not credited with an answer",
      regional?.unanswered === 1 && regional?.overdue === 0 && regional?.working === 0, regional);

    // ---------------- escalation ----------------
    phase("the desk above takes it, and nothing the caller was told moves");
    const dueBefore = await row(c1.json.id);
    const nowhere = await call(`/control/tickets/${c1.json.id}/escalate`, {
      ck: ck("sa"), body: { departmentId: randomUUID(), reason: "Somewhere that is not a desk." }
    });
    check("an escalation cannot be pointed at a desk that is not on the chart",
      nowhere.status === 400 && /not an open desk/.test(nowhere.json?.error?.message ?? ""),
      { s: nowhere.status, m: nowhere.json?.error?.message });
    const itself = await call(`/control/tickets/${c1.json.id}/escalate`, {
      ck: ck("sa"), body: { departmentId: D1, reason: "Keep it where it is failing." }
    });
    check("…or at the desk already failing to answer it — escalating to the same desk moves nothing",
      itself.status === 400 && /already holds/.test(itself.json?.error?.message ?? ""),
      { s: itself.status, m: itself.json?.error?.message });
    const unheld = await call(`/control/tickets/${c3.json.id}/escalate`, {
      ck: ck("sa"), body: { reason: "It is nowhere's, so it cannot go up." }
    });
    check("a call nobody holds cannot be escalated: there is no desk above an empty chair",
      unheld.status === 409 && /no desk above it/i.test(unheld.json?.error?.message ?? ""),
      { s: unheld.status, m: unheld.json?.error?.message });

    const up = await call(`/control/tickets/${c1.json.id}/escalate`, {
      ck: ck("sa"), body: { departmentId: D3, reason: "Support could not answer in ninety "
        + "minutes and the caller is waiting on the quay." }
    });
    const r1b = await row(c1.json.id);
    check("an escalation onto a desk already past its own ceiling is allowed: a ticket nobody "
      + "can move is a ticket nobody is answering",
      up.status === 200 && up.json?.over_ceiling === true,
      { s: up.status, oc: up.json?.over_ceiling, m: up.json?.error?.message });
    check("…the caller keeps the queue number the first desk issued, whichever desk dropped it",
      r1b?.dept_ref === `${keyD1}-1` && r1b?.numbered_by === D1 && r1b?.department_id === D3,
      r1b && [r1b.dept_ref, r1b.numbered_by, r1b.department_id]);
    check("…and both promises ride up untouched, so a hand-over cannot erase the breach it is "
      + "an admission of",
      r1b?.owed_answer === dueBefore?.owed_answer && r1b?.owed_fix === dueBefore?.owed_fix
      && ms(r1b?.response_due_at) === ms(dueBefore?.response_due_at),
      [dueBefore && [dueBefore.owed_answer, dueBefore.owed_fix],
        r1b && [r1b.owed_answer, r1b.owed_fix]]);
    check("…the desk above now holds it, and the failed desk is named as who to blame",
      r1b?.escalated_from_id === D1 && !!r1b?.escalated_at && r1b?.status === "allocated"
      && r1b?.allocated_by === uSA, r1b && [r1b.escalated_from_id, r1b.status, r1b.allocated_by]);
    check("…the clock the new desk starts only fills the deadlines that were never started",
      up.json?.clock?.department === "The Squeeze"
      && up.json?.clock?.first_response_minutes === 30
      && ms(up.json?.clock?.response_due_at) === ms(dueBefore?.response_due_at),
      up.json?.clock);
    const upEvents = await events(c1.json.id);
    const escLine = upEvents.find((e: any) => e.action === "escalated");
    check("one line says the desk above took it, names who failed, and records the ceiling it "
      + "went over rather than being stopped by it",
      escLine?.detail?.kept_number === `${keyD1}-1` && escLine?.detail?.over_ceiling === true
      && Number(escLine?.detail?.ceiling) === 1
      && /caller is waiting on the quay/.test(String(escLine?.reason)),
      escLine && [escLine.detail, escLine.reason]);
    const detail = await call(`/control/tickets/${c1.json.id}`, { ck: ck("sa") });
    check("the detail read shows who minted the number, who holds the call and who failed to answer",
      detail.json?.ticket?.numbered_by_name === "Support Desk"
      && detail.json?.ticket?.department_name === "The Squeeze"
      && detail.json?.ticket?.escalated_from_name === "Support Desk",
      detail.json?.ticket && [detail.json.ticket.numbered_by_name,
        detail.json.ticket.department_name, detail.json.ticket.escalated_from_name]);
    check("…the terms shown next to the dates they produced are now the holding desk's while the "
      + "dates stay the answering desk's — which is the whole reason the pair is kept",
      detail.json?.ticket?.first_response_minutes === 30
      && ms(detail.json?.ticket?.response_due_at) === ms(dueBefore?.response_due_at),
      detail.json?.ticket && [detail.json.ticket.first_response_minutes,
        detail.json.ticket.response_due_at]);
    check("…the desk above Support is named in the same read, so the panel can offer the next "
      + "move without a second query",
      detail.json?.can_escalate === true && !!detail.json?.ticket?.escalation_name,
      detail.json && [detail.json.can_escalate, detail.json.ticket?.escalation_name]);
    const listText = (await call(`/control/tickets?q=${encodeURIComponent(MARK)}`,
      { ck: ck("sa") })).text;
    check("the callback number is on no list row — only the flag that one is on file — while the "
      + "detail read decrypts it for the seat that has to ring back",
      !listText.includes("reporter_phone_encrypted") && !listText.includes(PHONE)
      && listText.includes('"has_phone":true') && detail.json?.ticket?.phone === PHONE,
      { phone: detail.json?.ticket?.phone });

    // ---------------- settle, refuse, reopen ----------------
    phase("settling, and what a reopen does to a promise");
    const settled = await call(`/control/tickets/${c6.json.id}/resolve`, {
      ck: ck("cs"), body: { outcome: "resolved",
        resolution: "The clearing agent produced the prevision and the container is released.",
        reason: "Confirmed with the caller." }
    });
    check("a call settles with the sentence about what was done, and keeps its number",
      settled.status === 200 && settled.json?.status === "resolved"
      && settled.json?.dept_ref === `${keyD5}-1`,
      { s: settled.status, ref: settled.json?.dept_ref });
    const escSettled = await call(`/control/tickets/${c6.json.id}/escalate`, {
      ck: ck("sa"), body: { reason: "Move a finished job up the chain." }
    });
    check("a finished job cannot be escalated, and the answer says to reopen it instead",
      escSettled.status === 409 && /Reopen it/i.test(escSettled.json?.error?.message ?? ""),
      { s: escSettled.status, m: escSettled.json?.error?.message });
    const allocSettled = await call(`/control/tickets/${c6.json.id}/allocate`, {
      ck: ck("sa"), body: { departmentId: D2, reason: "Hand a resolved one to Billing." }
    });
    check("…nor handed to another desk while the row still claims it was finished",
      allocSettled.status === 409 && /Reopen it first/.test(allocSettled.json?.error?.message ?? ""),
      { s: allocSettled.status, m: allocSettled.json?.error?.message });
    const quietWork = await call(`/control/tickets/${c6.json.id}/work`, {
      ck: ck("cs"), body: { status: "in_progress", reason: "Quietly editing a finished job." }
    });
    check("…so a second attempt is a reopened one, not a quiet edit of the status column",
      quietWork.status === 409 && /rang back/.test(quietWork.json?.error?.message ?? ""),
      { s: quietWork.status, m: quietWork.json?.error?.message });
    const reopened = await call(`/control/tickets/${c6.json.id}/work`, {
      ck: ck("cs"), body: { status: "in_progress", reopen: true,
        reason: "The caller rang back: the release was for the wrong container." }
    });
    const r6c = await row(c6.json.id);
    check("a reopen clears the answer stamp — the first answer belongs to the attempt that failed",
      reopened.status === 200 && reopened.json?.status === "in_progress"
      && r6c?.first_response_at === null,
      { s: reopened.status, fr: r6c?.first_response_at });
    check("…and it never invents deadlines a bare desk never set",
      r6c?.owed_answer === null && r6c?.owed_fix === null, r6c && [r6c.owed_answer, r6c.owed_fix]);
    const badResolve = await call(`/control/tickets/${c6.json.id}/resolve`, {
      ck: ck("cs"), body: { outcome: "resolved", resolution: "  ", reason: "Nothing was done." }
    });
    check("…and settling still needs the sentence about what was done: four characters or the "
      + "desk is turned away", badResolve.status === 400,
      { s: badResolve.status, m: badResolve.json?.error?.message });

    // ---------------- the acts all recorded themselves ----------------
    phase("every act left its two lines");
    const tally = (await oi(
      `select (select count(*)::int from support_ticket_events where tenant_id = $1) as events,
              (select count(*)::int from audit_logs where tenant_id = $1
                 and entity = 'support_tickets') as audit,
              (select count(*)::int from audit_logs where tenant_id = $1
                 and entity = 'support_tickets' and after ? 'reason') as with_reason,
              (select count(*)::int from audit_logs where tenant_id = $1
                 and entity = 'support_tickets' and action = 'control.tickets.logged') as logged,
              (select count(*)::int from support_ticket_events where tenant_id = $1
                 and action = any($2::text[])) as chain_actions,
              (select count(*)::int from audit_logs where tenant_id = $1
                 and entity = 'support_tickets' and before ? 'ref' and after ? 'event_id'
                 and ip is not null and user_agent is not null) as complete`,
      [TC, ["routed", "escalated"]])).rows[0];
    check("one audit row per register line, each carrying the reason in its after-image",
      tally.audit === tally.events && tally.with_reason === tally.audit, tally);
    check("…the eight calls this run logged are eight lines, and a rule and the desk above each "
      + "got their own word",
      tally.logged === 8 && tally.chain_actions >= 3, tally);
    check("…each one names the incidence, who acted from what address on what device, and which "
      + "register line it is the twin of",
      tally.complete === tally.audit, tally);
    const doubles = (await oi(
      `select dept_ref, count(*)::int as n from support_tickets where tenant_id = $1
         and dept_ref is not null group by 1 having count(*) > 1`, [TC])).rows;
    check("no two of this run's calls share a desk's queue number, however many desks handed "
      + "them between them", doubles.length === 0, doubles);
    const halves = (await oi(
      `select count(*)::int as n from support_tickets where tenant_id = $1
         and (case when dept_ref is null then 0 else 1 end
            + case when dept_number is null then 0 else 1 end
            + case when numbered_by is null then 0 else 1 end) not in (0, 3)`, [TC])).rows[0].n;
    check("…and every row that has one part of a number has all three: figure, form and the desk "
      + "that issued it", halves === 0, halves);

    check("the platform desk the real office sits on was not touched",
      (await before("support_tickets")) === start.tickets
      && (await before("platform_departments")) === start.desks
      && (await before("support_ticket_routes")) === start.rules,
      { now: [await before("support_tickets"), await before("platform_departments"),
        await before("support_ticket_routes")], start });
  } finally {
    await sweep();
    await clearBuckets("tickets:", "tickets-one:", "tickets-write:", "dept:", "dept-one:",
      "dept-write:", "dept-rules:", "dept-rules-write:");
    const residue = await oi(
      `select (select count(*)::int from tenants where name like $1) as t,
              (select count(*)::int from users where email like $2) as u,
              (select count(*)::int from platform_departments where tenant_id in
                 (select id from tenants where name like $1)) as d,
              (select count(*)::int from support_ticket_routes where tenant_id in
                 (select id from tenants where name like $1)) as r,
              (select count(*)::int from support_tickets where tenant_id in
                 (select id from tenants where name like $1)) as k,
              (select count(*)::int from support_ticket_events where tenant_id in
                 (select id from tenants where name like $1)) as e,
              (select count(*)::int from branches where tenant_id in
                 (select id from tenants where name like $1)) as b,
              (select coalesce(sum(ticket_seq), 0)::int as q from platform_departments where tenant_id in
                 (select id from tenants where name like $1))`,
      [TENANT_SWEEP, EMAIL_SWEEP]);
    check("this run's tenants, seats, desks, rules, calls, register lines and branches are gone",
      residue.rows[0].t === 0 && residue.rows[0].u === 0 && residue.rows[0].d === 0
      && residue.rows[0].r === 0 && residue.rows[0].k === 0 && residue.rows[0].e === 0
      && residue.rows[0].b === 0, residue.rows[0]);
    check("…and no desk counter was left holding a number this run handed out",
      residue.rows[0].q === 0, residue.rows[0]);
    const kept = (await oi(
      `select count(*)::int as n from audit_logs where actor_user_id = any($1::uuid[])
         and entity = 'support_tickets'`,
      [[uSA, uAN, uCS, uFor]])).rows[0].n;
    check("…while every audit line it wrote is still there, because the trail is append-only and "
      + "a smoke that could erase its own evidence would prove nothing", kept > 0, { kept });
    console.log(`\n${failures ? `${failures} FAILURE(S)` : "all checks passed"} — ${MARK}`);
    await owner.end();
    process.exit(failures ? 1 : 0);
  }
}

main().catch((e) => { console.error("CRASHED:", e?.response?.data ?? e); process.exit(1); });
