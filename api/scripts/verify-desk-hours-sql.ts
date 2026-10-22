/**
 * Live proof for #339 — a desk keeps its hours and its promises (migration 123).
 *
 * The four things this stage promises are all facts of the schema, so all four are proved here
 * rather than in a route: the week a desk works, the clock that counts only the minutes inside
 * it, the queue number minted under a row lock, and the guard that will not file away a desk
 * still holding work. A CHECK cannot be demonstrated by reading it and EXPLAIN cannot see
 * inside a SECURITY DEFINER body — the proof is the exception a trigger raises, and the two
 * different numbers two clerks get when they ask for one in the same instant.
 *
 * Everything runs inside one transaction that is rolled back. The numbering race is the one
 * probe that cannot: a lock is only proved by somebody waiting on it, so the race desk and the
 * two calls it mints are committed on a second connection and deleted again by that same
 * connection before this script finishes. The refusal probes sit behind SAVEPOINTs — a raised
 * trigger aborts the transaction, and every later query in an aborted transaction answers
 * "current transaction is aborted" instead of the question it was asked.
 *
 * Dates are written as Dar es Salaam wall-clock, because that is how a desk reads its own week:
 * 2026-03-02 is a Monday, 03-06 a Friday, 03-07 a Saturday, 03-08 a Sunday.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-desk-hours-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else {
    failures++;
    console.log("FAIL ", label,
      (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400));
  }
}

function ownerUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  return url;
}

const TZ = "Africa/Dar_es_Salaam";
const WEEK = {
  mon: { open: "08:00", close: "17:30" }, tue: { open: "08:00", close: "17:30" },
  wed: { open: "08:00", close: "17:30" }, thu: { open: "08:00", close: "17:30" },
  fri: { open: "08:00", close: "17:30" }, sat: { open: "09:00", close: "13:00" },
  sun: null
};
const SHUT = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
/**
 * A wall-clock string read in the desk's own zone, which is how the office says an hour.
 * The `::timestamp` is not decoration: an untyped literal before `at time zone` is resolved the
 * other way round — Postgres reads it as a timestamptz and hands back the wall clock of the zone
 * — so every date below would arrive six hours after the hour the script wrote.
 */
const at = (wall: string) => `'${wall}'::timestamp at time zone '${TZ}'`;
/** The same instant back as the wall clock a desk would write on its own board. */
const asWall = (expr: string) => `to_char((${expr}) at time zone '${TZ}','YYYY-MM-DD HH24:MI:SS')`;

const mkClient = () => new pg.Client({
  connectionString: ownerUrl(), ssl: { rejectUnauthorized: false }, statement_timeout: 60000
});

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = mkClient();
  await owner.connect();
  const one = async (sql: string, p: any[] = []) => (await owner.query(sql, p)).rows[0];

  // A gate that died halfway leaves a committed race desk behind — the numbering probe is the
  // one part that cannot sit in a transaction. Clear what an earlier crash left before counting
  // anything, or the first assertion of the run measures the last one's wreckage. Tickets first:
  // they reference the desk, and one statement cannot be sure of the order it removes them in.
  const calls = await owner.query(
    `delete from support_tickets
      where company_name = 'Probe Freight Ltd' or ref like 'CS-2099-%'`);
  const rules = await owner.query(`delete from support_ticket_routes where name like 'Probe%'`);
  const desks = await owner.query(
    `delete from platform_departments where key like 'zzprobe%' or key like 'zzrace%'`);
  if (calls.rowCount! + desks.rowCount! + rules.rowCount! > 0)
    console.log(`swept a previous run: ${desks.rowCount} desk(s), ${calls.rowCount} call(s), `
      + `${rules.rowCount} rule(s)`);

  // The register belongs to the platform tenant — the one every existing desk already sits on.
  const anchor = await one(
    `select d.tenant_id,
            (select id from users u where u.user_type = 'platform' and u.deleted_at is null
               and u.status = 'active' order by u.created_at limit 1) as seat,
            (select count(*)::int from platform_departments p2
              where p2.deleted_at is null and p2.tenant_id = d.tenant_id) as live_desks
       from platform_departments d where d.deleted_at is null order by d.sort limit 1`);
  if (!anchor?.tenant_id) throw new Error("No platform tenant owns a department — 084 is missing.");
  if (!anchor?.seat) throw new Error("No live platform seat to write a register row against.");
  const TEN = anchor.tenant_id as string;
  const ACT = anchor.seat as string;
  const START_DESKS = Number(anchor.live_desks);
  const START_TICKETS = Number((await one(`select count(*)::int as n from support_tickets`)).n);
  console.log(`\n--- 0 · the register: tenant ${TEN.slice(0, 8)}, seat ${ACT.slice(0, 8)}, `
    + `${START_DESKS} live desk(s), ${START_TICKETS} incidence(s) on the boards ---`);

  // ================================================================
  // The race cannot be played inside a transaction nobody else can see, so it goes first, on
  // its own connection, on a desk this script creates and removes itself.
  console.log("\n--- 1 · two clerks, one desk, one instant ---");

  const solo = mkClient();
  const mate = mkClient();
  await solo.connect();
  await mate.connect();
  const raceKey = `zzrace${Date.now().toString(36)}`;
  const raceDesk = (await solo.query(
    `insert into platform_departments (tenant_id, key, name, purpose)
     values ($1,$2,'Probe race desk','Probe desk, read only by this script.') returning id`,
    [TEN, raceKey])).rows[0].id as string;
  const raceKeyUpper = (await solo.query(
    `select upper(key) as k from platform_departments where id = $1`, [raceDesk])).rows[0].k;
  const raced: any[] = [];
  try {
    const go = async (cl: pg.Client) => {
      await cl.query("begin");
      // `select * from f()` on a jsonb-returning function gives one column called after the
      // function, not the object's own keys: the answer has to be named to be read.
      const m = (await cl.query(
        `select platform_auth.next_ticket_number($1) as m`, [raceDesk])).rows[0].m;
      await cl.query(
        `insert into support_tickets (tenant_id, ref, reporter_name, company_name, category,
           subject, body, created_by, status, department_id, numbered_by, dept_number, dept_ref)
         values ($1,$2,'Probe Caller','Probe Freight Ltd','other','A probe call about a probe problem',
           'The body of a call written only to prove the clock and the number work.',$3,
           'open',$4,$4,$5,$6)`,
        [TEN, `CS-2099-${90000 + Number(m.number)}`, ACT, raceDesk,
          m.number, m.ref]);
      await cl.query("commit");
      raced.push(m);
      return m;
    };
    const both = await Promise.all([go(solo), go(mate)]);
    check("two clerks asking the same desk in the same instant get two different numbers",
      both[0]?.ref !== both[1]?.ref && new Set(raced.map((r) => r.ref)).size === 2, raced);
    check("…so the second one waited on the row instead of reading the same counter twice",
      Math.abs(Number(both[0].number) - Number(both[1].number)) === 1,
      raced.map((r) => `${r.number}/${r.ref}`));
    check("…and the desk's counter moved exactly as many times as there were calls",
      Number((await solo.query(
        `select ticket_seq as seq from platform_departments where id = $1`, [raceDesk]))
        .rows[0].seq) === 2);
    check("…which is why the number cannot be steered by whoever happens to call the minter",
      Number((await solo.query(
        `select count(*)::int as n from support_tickets where department_id = $1`, [raceDesk]))
        .rows[0].n) === 2 && raced.every((r) => r.ref === `${raceKeyUpper}-${r.number}`), raced);
  } finally {
    // A probe that died mid-transaction leaves the connection answering "current transaction is
    // aborted" to everything, including the cleanup — so the rollback comes before the deletes.
    await solo.query("rollback").catch(() => {});
    await mate.query("rollback").catch(() => {});
    await solo.query(`delete from support_tickets where department_id = $1`, [raceDesk]).catch(() => {});
    await solo.query(`delete from platform_departments where id = $1`, [raceDesk]).catch(() => {});
    await solo.end().catch(() => {});
    await mate.end().catch(() => {});
  }

  await owner.query("begin");

  let made = 0;
  /** A desk of our own, so no probe disturbs the desks the office actually has. */
  const newDesk = async (name: string, extra: Record<string, string> = {}) => {
    made++;
    const cols = Object.keys(extra);
    const row = await one(
      `insert into platform_departments (tenant_id, key, name, purpose${cols.length ? ", " + cols.join(", ") : ""})
       values ($1,$2,$3,'Probe desk, read only by this script.'${cols.length ? ", " + cols.map((_, i) => `$${i + 4}`).join(", ") : ""})
       returning id, upper(key) as key`,
      [TEN, `zzprobe${made}`, name, ...cols.map((c) => extra[c])]);
    return row as { id: string; key: string };
  };
  const desk = async (name: string, extra?: Record<string, string>) => (await newDesk(name, extra)).id;
  const deskKey = async (id: string) =>
    (await one(`select upper(key) as k from platform_departments where id = $1`, [id])).k as string;

  let refSeq = 90000;
  const newTicket = async (cols: Record<string, any> = {}) => {
    refSeq++;
    const base: Record<string, any> = {
      tenant_id: TEN, ref: `CS-2099-8${refSeq}`, reporter_name: "Probe Caller",
      company_name: "Probe Freight Ltd", category: "other",
      subject: "A probe call about a probe problem",
      body: "The body of a call written only to prove the clock and the number work.",
      created_by: ACT, status: "open", ...cols
    };
    const names = Object.keys(base);
    const row = await one(
      `insert into support_tickets (${names.join(",")})
       values (${names.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
      Object.values(base));
    return row.id as string;
  };

  const mint = async (dept: string) =>
    (await one(`select platform_auth.next_ticket_number($1) as m`, [dept])).m;
  const route = async (p: any[]) =>
    (await one(`select platform_auth.route_ticket($1::uuid,$2,$3,$4,$5,$6::int) as m`, p)).m;
  // The clock is asked in the desk's own wall clock and the answer is read back the same way:
  // that is the form a desk would write on its board, and the only form worth asserting.
  // Every value inlined here is a date written in this file, never a string from a caller.
  const owed = (wall: string, mins: number, hours: unknown) => one(
    `select ${asWall(`platform_auth.work_minutes(${at(wall)}, $1, $2::jsonb)`)} as due`,
    [mins, JSON.stringify(hours)]).then((r: any) => r?.due ?? null);
  const isOpen = (wall: string, hours: unknown) => one(
    `select platform_auth.inside_hours(${at(wall)}, $1::jsonb) as open`, [JSON.stringify(hours)]);

  /** Runs a write expected to fail and hands back the message, leaving the transaction usable. */
  const refuses = async (sql: string, p: any[] = []) => {
    const tag = "sp" + randomUUID().replace(/-/g, "").slice(0, 10);
    await owner.query(`savepoint ${tag}`);
    const err = await owner.query(sql, p).then(() => null as string | null, (e) => String(e.message));
    await owner.query(`rollback to savepoint ${tag}`);
    return err ?? "";
  };
  const keep = (sql: string, p: any[] = []) => owner.query(sql, p);

  // ================================================================
  console.log("\n--- 2 · what the desk and the register now hold ---");

  const columns = (await owner.query(
    `select table_name, column_name, is_nullable, column_default, data_type from information_schema.columns
      where table_schema = 'public' and (
            (table_name = 'platform_departments' and column_name in
              ('first_response_minutes','resolve_minutes','business_hours',
               'escalation_department_id','max_open_tickets','ticket_seq'))
         or (table_name = 'support_tickets' and column_name in
              ('dept_number','dept_ref','numbered_by','language','response_due_at',
               'resolution_due_at','first_response_at','escalated_from_id','escalated_at',
               'after_hours')))`)).rows;
  const col = (t: string, c: string) =>
    columns.find((r: any) => r.table_name === t && r.column_name === c);
  check("the desk carries its promise: a first-response clock, a resolution clock, its week",
    !!col("platform_departments", "first_response_minutes")
    && !!col("platform_departments", "resolve_minutes")
    && !!col("platform_departments", "business_hours"));
  check("…a desk above it, a ceiling on the work it may hold, and its own counter",
    !!col("platform_departments", "escalation_department_id")
    && !!col("platform_departments", "max_open_tickets")
    && !!col("platform_departments", "ticket_seq"));
  const onTicket = ["dept_number", "dept_ref", "numbered_by", "language", "response_due_at",
    "resolution_due_at", "first_response_at", "escalated_from_id", "escalated_at", "after_hours"];
  check("the register carries the number, the clock, the answer stamp and the escalation",
    onTicket.every((c) => !!col("support_tickets", c)), onTicket.filter((c) => !col("support_tickets", c)));
  check("an out-of-hours call is marked at birth, and the language defaults to the office's own",
    col("support_tickets", "after_hours")?.is_nullable === "NO"
    && /false/.test(col("support_tickets", "after_hours")?.column_default ?? "")
    && /^'en'/.test(col("support_tickets", "language")?.column_default ?? ""),
    [col("support_tickets", "after_hours"), col("support_tickets", "language")]);
  const stamps = ["response_due_at", "resolution_due_at", "first_response_at"];
  check("the three answer times are owed dates, not a text field somebody fills in later",
    stamps.every((c) => col("support_tickets", c)?.data_type === "timestamp with time zone"),
    stamps.map((c) => `${c}:${col("support_tickets", c)?.data_type}`));

  const defs = (await owner.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid in ('platform_departments'::regclass,'support_tickets'::regclass)
        and contype = 'c'`)).rows.map((r: any) => r.def);
  const says = (re: RegExp[], label: string) =>
    check(label, defs.some((d) => re.every((r) => r.test(d))),
      defs.filter((d) => re[0].test(d))[0] ?? defs.slice(0, 3));
  says([/first_response_minutes IS NULL/i, /first_response_minutes >= 5/i, /<= 4320/i],
    "a promise is bounded, not free text: 5 minutes to 3 days for a first answer");
  says([/resolve_minutes IS NULL/i, /resolve_minutes >= 15/i, /<= 20160/i],
    "…and 15 minutes to 14 days for a resolution");
  says([/max_open_tickets IS NULL/i, /max_open_tickets >= 1/i, /<= 500/i],
    "the ceiling is a figure a desk can set, not an unbounded column");
  says([/escalation_department_id IS NULL/i, /escalation_department_id <> id/i],
    "a desk may not escalate to itself");
  says([/jsonb_typeof\(business_hours\)/i, /'object'/i], "the week is an object and nothing else");
  says([/dept_number IS NULL/i, /dept_ref IS NULL/i, /numbered_by IS NULL/i],
    "a queue number is only half a fact: number, readable form and minting desk are three, or none");
  says([/dept_ref ~/i, /\[A-Z\]/i], "the readable form is a desk key and a number, in capitals");
  says([/dept_ref ~~/i, /'%-'/i], "…and it has to end with the counter it was minted from");
  says([/\blanguage\b/i, /'en'/i, /'sw'/i],
    "the two languages the office answers in are named in the schema");
  says([/ticket_seq >= 0/i], "a desk's counter cannot be walked backwards by a hand-edited row");

  const idxDefs = (await owner.query(
    `select indexname as name, indexdef as def from pg_indexes
      where schemaname = 'public' and tablename in ('support_tickets','platform_departments')
        and indexname in ('support_tickets_desk_number','support_tickets_desk_ref',
                          'support_tickets_sla','platform_departments_escalation')`)).rows;
  const iof = (n: string) => idxDefs.find((r: any) => r.name === n)?.def ?? "";
  check("a desk cannot hand out one of its own numbers twice, even after the call is retired",
    /unique/i.test(iof("support_tickets_desk_number"))
    && !/deleted_at/.test(iof("support_tickets_desk_number")), iof("support_tickets_desk_number"));
  check("…and the reference a caller quotes is unique platform-wide for the same reason",
    /unique/i.test(iof("support_tickets_desk_ref"))
    && !/deleted_at/.test(iof("support_tickets_desk_ref")), iof("support_tickets_desk_ref"));
  check("the queue can be read in promise order, which is how a desk finds what is late",
    /resolution_due_at/.test(iof("support_tickets_sla"))
    // Decompile reads as `= ANY (ARRAY[…])`, never as the `in (…)` the migration wrote.
    && /= ANY/.test(iof("support_tickets_sla"))
    && /'open'::text/.test(iof("support_tickets_sla"))
    && /'in_progress'::text/.test(iof("support_tickets_sla")),
    iof("support_tickets_sla"));
  check("the desk above a desk can be asked for, which is what an escalation read costs nothing",
    /escalation_department_id/.test(iof("platform_departments_escalation")),
    iof("platform_departments_escalation"));

  const rp = await one(
    `select c.relrowsecurity as secured,
            (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
            (select coalesce(string_agg(privilege_type, ',' order by privilege_type), '')
               from information_schema.table_privileges tp
              where tp.table_name = c.relname
                and tp.grantee in ('app_runtime','public','anon','authenticated')) as facing
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'support_ticket_routes'`);
  check("routing rules are row-secured on the tenant that owns the register",
    rp?.secured === true && Number(rp?.policies ?? -1) === 1, rp);
  check("…the API role may write them, and nobody may delete one: a retired rule is tombstoned",
    /select/i.test(rp?.facing ?? "") && /insert/i.test(rp.facing) && /update/i.test(rp.facing)
    && !/delete/i.test(rp.facing), rp?.facing);

  const actionCheck = (await owner.query(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'support_ticket_events'::regclass and contype = 'c'`))
    .rows.map((r: any) => r.def);
  check("the register has a word for a rule doing it and a word for the desk above doing it",
    actionCheck.some((d) => /'routed'/.test(d) && /'escalated'/.test(d)), actionCheck);
  check("…and it kept every word 101 and 103 already wrote lines with",
    actionCheck.some((d) => ["logged", "closed", "withdrawn", "resolved", "reopened", "note_added",
      "priority_changed", "status_changed", "allocated", "reallocated"]
      .every((w) => d.includes(`'${w}'`))), actionCheck[0]);

  const fns = (await owner.query(
    `select p.proname as name, p.prosecdef as definer,
            coalesce(nullif(array_to_string(p.proconfig, ','),''),'(unset)') as config,
            has_function_privilege('app_runtime', p.oid, 'execute') as to_runtime,
            has_function_privilege('public', p.oid, 'execute') as to_public,
            has_function_privilege('anon', p.oid, 'execute') as to_anon
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth'
        and p.proname in ('next_ticket_number','route_ticket','department_open_tickets',
                          'work_minutes','inside_hours','department_hours_are_readable',
                          'escalation_path_does_not_loop','desk_holds_no_open_tickets')`)).rows;
  const fnAt = (n: string) => fns.find((r: any) => r.name === n) ?? {};
  check("all eight new functions exist, in the schema every other definer already lives in",
    fns.length === 8, fns.map((r: any) => r.name));
  check("every one is pinned to a search path, so a hijacked one finds nothing to call",
    fns.every((r: any) => /search_path=public/.test(r.config)),
    fns.map((r: any) => `${r.name}:${r.config}`));
  check("none of them is executable by PUBLIC — the default Supabase leaves behind",
    fns.every((r: any) => r.to_public === false && r.to_anon === false),
    fns.map((r: any) => `${r.name}:public=${r.to_public}`));
  check("the five doors the API needs are granted to the API role",
    ["next_ticket_number", "route_ticket", "department_open_tickets", "work_minutes",
      "inside_hours"].every((n) => fnAt(n).to_runtime === true),
    fns.map((r: any) => `${r.name}:${r.to_runtime}`));
  check("the three trigger bodies are not: a guard is fired, never called",
    ["department_hours_are_readable", "escalation_path_does_not_loop",
      "desk_holds_no_open_tickets"].every((n) => fnAt(n).to_runtime === false),
    fns.map((r: any) => `${r.name}:${r.to_runtime}`));
  check("the minter, the matcher and the counter escalate; the clock needs no escalation to have",
    fnAt("next_ticket_number").definer === true && fnAt("route_ticket").definer === true
    && fnAt("department_open_tickets").definer === true
    && fnAt("work_minutes").definer === false && fnAt("inside_hours").definer === false,
    fns.map((r: any) => `${r.name}:${r.definer}`));

  const born = await one(
    `select business_hours as hours, ticket_seq as seq, first_response_minutes as fr,
            resolve_minutes as rm, max_open_tickets as mx
       from platform_departments where id = $1`, [await desk("Probe inherits")]);
  check("a new desk is born with the office's published week, not a clock that never opens",
    born?.hours?.mon?.open === "08:00" && born?.hours?.sat?.close === "13:00"
    && born?.hours?.sun === null, born?.hours);
  check("…and no promise at all until the office sets one",
    born?.fr === null && born?.rm === null && born?.mx === null && Number(born?.seq) === 0, born);

  // ================================================================
  console.log("\n--- 3 · the week a desk works is a shape, not a string ---");

  const week = await desk("Probe week");
  const setWeek = (hours: unknown) => refuses(
    `update platform_departments set business_hours = $2 where id = $1`,
    [week, JSON.stringify(hours)]);
  const e1 = await setWeek({ ...WEEK, mondays: null });
  check("a day nobody recognises is refused before it can reach the clock", /nobody recognises/i.test(e1), e1);
  const e2 = await setWeek({ ...WEEK, wed: { open: "17:30", close: "08:00" } });
  check("a window that closes before it opens is refused", /closes before/i.test(e2), e2);
  const e3 = await setWeek({ ...WEEK, thu: { open: "10:00", close: "10:00" } });
  check("…and so is one that opens and shuts in the same minute, which could promise nothing",
    /closes before or at the minute/i.test(e3), e3);
  const e4 = await setWeek({ ...WEEK, fri: { open: "8am", close: "17:30" } });
  check("a window that is not a pair of HH:MM times is refused", /pair of HH:MM/i.test(e4), e4);
  const e5 = await setWeek({ ...WEEK, sat: { open: "09:00" } });
  check("a window with only half of it is refused", /pair of HH:MM/i.test(e5), e5);
  const e6 = await setWeek([1, 2, 3]);
  check("a week that is not a day map is refused", /keyed by weekday/i.test(e6), e6);
  const e7 = await setWeek({ ...WEEK, sun: { open: "10:00", close: "12:00" } });
  check("a legal week is accepted, including a desk that chooses to open on Sunday", e7 === "", e7);

  // ================================================================
  console.log("\n--- 4 · the escalation path has to end somewhere ---");

  const a = await desk("Probe desk A");
  const b = await desk("Probe desk B");
  const up = await desk("Probe desk C");
  const link = (from: string, to: string | null) => refuses(
    `update platform_departments set escalation_department_id = $2::uuid where id = $1`, [from, to]);
  // A BEFORE trigger is answered before a constraint is, so a desk pointing at itself meets the
  // walk on its first step. Either refusal is the schema's own; what matters is that the row stays.
  const self = await refuses(
    `update platform_departments set escalation_department_id = id where id = $1`, [a]);
  check("a desk cannot point at itself, and the refusal is the row's own, not a route's",
    /comes back to itself|not_own_escalation/i.test(self), self);
  check("…and the refused write left nothing behind to escalate to",
    (await one(`select escalation_department_id as up from platform_departments where id = $1`, [a]))
      ?.up === null);
  // Kept in the transaction rather than rolled back to a savepoint, so the links below are a
  // real chain for the walk to follow.
  await keep(`update platform_departments set escalation_department_id = $2 where id = $1`, [a, b]);
  check("a chain one desk deep is accepted",
    (await one(`select escalation_department_id as up from platform_departments where id = $1`, [a]))?.up === b);
  check("…and two desks that escalate to each other are refused by the walk, in SQL",
    /comes back to itself/i.test(await link(b, a)));
  await keep(`update platform_departments set escalation_department_id = $2 where id = $1`, [b, up]);
  check("a three-desk loop is caught at the third step, not by a route that happens to remember it",
    /comes back to itself/i.test(await link(up, a)));
  check("…and a chain that runs out to the top of the chart is accepted", (await link(up, null)) === "");
  check("a desk may not name a desk that is not on the chart",
    /violates foreign key|is not present in table/i.test(await link(up, randomUUID())));

  // ================================================================
  console.log("\n--- 5 · the promise counts only the minutes a desk is open ---");

  const w1 = await owed("2026-03-02 10:00", 60, WEEK);
  check("an hour asked for at 10:00 on a Monday is owed at 11:00 the same day",
    w1 === "2026-03-02 11:00:00", w1);
  const w2 = await owed("2026-03-02 06:00", 30, WEEK);
  check("a call that arrives before opening is owed from opening, not from arrival",
    w2 === "2026-03-02 08:30:00", w2);
  const w3 = await owed("2026-03-06 18:00", 600, WEEK);
  check("ten working hours from a Friday evening wait for Saturday, then for Monday morning",
    w3 === "2026-03-09 14:00:00", w3);
  const w4 = await owed("2026-03-08 02:00", 30, WEEK);
  check("two in the morning on a Sunday is not owed before Monday opens",
    w4 === "2026-03-09 08:30:00", w4);
  const w5 = await owed("2026-03-07 23:00", 30, WEEK);
  check("…and a Saturday night call is owed half an hour into Monday's morning, not Sunday's",
    w5 === "2026-03-09 08:30:00", w5);
  const w6 = await owed("2026-03-06 17:20", 30, WEEK);
  check("the last ten minutes of Friday are spent before Saturday is reached",
    w6 === "2026-03-07 09:20:00", w6);
  const w7 = await owed("2026-03-02 10:00", 0, WEEK);
  check("a zero-minute promise is the instant it was raised at",
    w7 === "2026-03-02 10:00:00", w7);
  const w8 = await owed("2026-03-02 10:00", 120, SHUT);
  check("a desk that is never open is owed no date at all, rather than an invented one",
    w8 === null, w8);
  const w9 = await owed("2026-03-02 10:00", 999999,
    { ...WEEK, tue: null, wed: null, thu: null, fri: null, sat: null });
  check("a promise the clock cannot reach inside 400 days is answered with nothing",
    w9 === null, w9);
  const w10 = await owed("2026-03-05 15:00", 180, WEEK);
  check("a three-hour promise made at 15:00 on a Thursday spends Thursday's last half hour",
    w10 === "2026-03-06 08:30:00", w10);
  const w11 = await owed("2026-03-02 09:00", 510, WEEK);
  check("exactly one working day from 09:00 on a Monday is owed at closing, not the next morning",
    w11 === "2026-03-02 17:30:00", w11);

  check("half past eight on a Monday is inside the week",
    (await isOpen("2026-03-02 08:30", WEEK))?.open === true);
  check("five past five is inside, and seventeen thirty exactly is not: the close is exclusive",
    (await isOpen("2026-03-02 17:00", WEEK))?.open === true
    && (await isOpen("2026-03-02 17:30", WEEK))?.open === false);
  check("Saturday is a half day and Sunday is shut",
    (await isOpen("2026-03-07 10:00", WEEK))?.open === true
    && (await isOpen("2026-03-07 14:00", WEEK))?.open === false
    && (await isOpen("2026-03-08 10:00", WEEK))?.open === false);
  const utc = await one(
    `select platform_auth.inside_hours('2026-03-07 23:00+00'::timestamptz, $1::jsonb) as open`,
    [JSON.stringify(WEEK)]);
  check("the answer is given in the desk's own clock: 23:00 UTC is 02:00 on a Sunday in Dar es Salaam",
    utc?.open === false, utc);
  const utc2 = await one(
    `select platform_auth.inside_hours('2026-03-06 22:00+00'::timestamptz, $1::jsonb) as open`,
    [JSON.stringify(WEEK)]);
  check("…and 22:00 UTC on a Friday is 01:00 Saturday, still shut, not a Friday evening",
    utc2?.open === false, utc2);
  check("an empty week and a null instant both mean closed, not an error",
    (await isOpen("2026-03-02 10:00", SHUT))?.open === false
    && (await one(`select platform_auth.inside_hours(null, $1::jsonb) as open`,
      [JSON.stringify(WEEK)]))?.open === false);

  // ================================================================
  console.log("\n--- 6 · the queue number is minted once ---");

  const bill = await desk("Probe billing desk");
  const billKey = await deskKey(bill);
  const m1 = await mint(bill);
  const m2 = await mint(bill);
  check("the desk hands out its own number, in its own name",
    m1?.status === "ok" && Number(m1?.number) === 1 && m1?.ref === `${billKey}-1`, m1);
  check("…and the next call gets the next number, not the same one again",
    m2?.status === "ok" && Number(m2?.number) === 2 && m2?.ref === `${billKey}-2`, m2);
  check("the mint names the desk, so the register can say who issued the number",
    m2?.department_id === bill && m2?.department_key === billKey && !!m2?.department_name, m2);
  check("a desk that is not on the chart cannot give a call its number",
    (await mint(randomUUID()))?.status === "unavailable");
  const filed = await desk("Probe filed desk");
  await keep(`update platform_departments set deleted_at = now() where id = $1`, [filed]);
  check("…and neither can one that has been filed away",
    (await mint(filed))?.status === "unavailable");

  // A number already in the register is never handed out again: the counter steps over it and
  // the hole in the desk's sequence is what says so.
  const skip = await desk("Probe skip desk");
  const skipKey = await deskKey(skip);
  await newTicket({ department_id: skip, numbered_by: skip, dept_number: 1, dept_ref: `${skipKey}-1` });
  const m3 = await mint(skip);
  check("a number already taken is skipped, and the hole in the desk's sequence says so",
    Number(m3?.number) === 2 && m3?.ref === `${skipKey}-2`, m3);
  check("…and two calls cannot be written to the register under one desk number",
    /duplicate key value/i.test(await refuses(
      `insert into support_tickets (tenant_id, ref, reporter_name, company_name, category,
         subject, body, created_by, status, department_id, numbered_by, dept_number, dept_ref)
       values ($1,'CS-2099-77777','Probe Caller','Probe Freight Ltd','other',
         'A probe call about a probe problem',
         'The body of a call written only to prove the clock and the number work.',$2,
         'open',$3,$3,1,$4)`, [TEN, ACT, skip, `${skipKey}-1`])));
  check("…nor under one readable form anywhere else on the platform either",
    /duplicate key value/i.test(await refuses(
      `insert into support_tickets (tenant_id, ref, reporter_name, company_name, category,
         subject, body, created_by, status, department_id, numbered_by, dept_number, dept_ref)
       values ($1,'CS-2099-77778','Probe Caller','Probe Freight Ltd','other',
         'A probe call about a probe problem',
         'The body of a call written only to prove the clock and the number work.',$2,
         'open',$3,$4,1,$5)`, [TEN, ACT, bill, bill, `${skipKey}-1`])));

  const moved = await newTicket({ department_id: bill, status: "allocated", allocated_by: ACT,
    allocated_at: new Date(), numbered_by: bill, dept_number: Number(m2.number), dept_ref: m2.ref });
  await keep(`update support_tickets set department_id = $2 where id = $1`, [moved, up]);
  const afterMove = await one(
    `select dept_number, dept_ref, numbered_by, department_id from support_tickets where id = $1`,
    [moved]);
  check("a call that moves desks keeps the number it was given and the desk that minted it",
    afterMove?.dept_ref === m2.ref && afterMove?.numbered_by === bill
    && afterMove?.department_id === up, afterMove);
  check("…and the desk it moved to has spent none of its own numbers for it",
    Number((await one(`select ticket_seq as seq from platform_departments where id = $1`, [up]))?.seq) === 0);

  // ================================================================
  console.log("\n--- 7 · who takes the call is a rule the desk can read ---");

  const rd = await desk("Probe routing desk");
  const rd2 = await desk("Probe second desk");
  const addRule = (cols: Record<string, any>) => refuses(
    `insert into support_ticket_routes (tenant_id, name, department_id, channels, categories,
        priorities, languages, region_ids, precedence, is_active, note, created_by)
      values ($1,$2,$3,$4::text[],$5::text[],$6::text[],$7::text[],$8::int[],$9,$10,$11,$12)`,
    [TEN, cols.name, cols.department_id, cols.channels ?? [], cols.categories ?? [],
      cols.priorities ?? [], cols.languages ?? [], cols.region_ids ?? [],
      cols.precedence ?? 100, cols.is_active ?? true, cols.note ?? "Probe rule.", ACT]);

  check("with no rules written nothing is routed — the register does not guess a desk",
    (await route([TEN, "phone_call", "licence_billing", "normal", "en", null]))?.status === "no_rule");
  check("a rule that narrows nothing is refused: a catch-all would swallow the whole queue",
    /check constraint/i.test(await addRule({ name: "Probe catch-all", department_id: rd })));
  check("…and a channel spelled wrong is refused at the table, not quietly never matched",
    /check constraint/i.test(await addRule({ name: "Probe bad channel", department_id: rd,
      channels: ["phonecall"] })));
  check("…so is a priority outside the register's own words",
    /check constraint/i.test(await addRule({ name: "Probe bad priority", department_id: rd,
      priorities: ["now"] })));
  check("…and a language the office does not answer in",
    /check constraint/i.test(await addRule({ name: "Probe bad language", department_id: rd,
      languages: ["sw-FR"] })));
  check("a precedence nobody can rank is refused",
    /check constraint/i.test(await addRule({ name: "Probe bad precedence", department_id: rd,
      categories: ["other"], precedence: 0 })));
  check("a rule has to name a desk that is on the chart",
    /violates foreign key/i.test(await addRule({ name: "Probe ghost rule",
      department_id: randomUUID(), categories: ["other"] })));
  check("two rules cannot be born with the same name on one tenant",
    await (async () => {
      await keep(`insert into support_ticket_routes (tenant_id, name, department_id, categories)
                  values ($1,'Probe named rule',$2,'{other}')`, [TEN, rd]);
      return /duplicate key value/i.test(await refuses(
        `insert into support_ticket_routes (tenant_id, name, department_id, categories)
         values ($1,'Probe named rule',$2,'{complaint}')`, [TEN, rd2]));
    })());

  await keep(`insert into support_ticket_routes (tenant_id, name, department_id, categories, precedence)
              values ($1,'Probe licence rule',$2,'{licence_billing}',50)`, [TEN, rd]);
  await keep(`insert into support_ticket_routes (tenant_id, name, department_id, priorities, precedence)
              values ($1,'Probe urgent rule',$2,'{urgent}',10)`, [TEN, rd2]);
  const r1 = await route([TEN, "phone_call", "licence_billing", "normal", "en", null]);
  check("a rule on the category a call belongs to fires, and names the desk it hands it to",
    r1?.status === "rule" && r1?.rule_name === "Probe licence rule" && r1?.department_id === rd, r1);
  const r2 = await route([TEN, "whatsapp", "cargo_clearing", "urgent", "sw", null]);
  check("…and when two rules fit one call, the lower precedence wins, because a call has one desk",
    r2?.rule_name === "Probe urgent rule" && Number(r2?.precedence) === 10, r2);
  check("a call in neither rule's world is not routed at all",
    (await route([TEN, "email", "onboarding", "low", "en", null]))?.status === "no_rule");
  check("the match says which lists fitted, so a desk can ask why this call landed here",
    JSON.stringify(r1?.matched_by ?? {}).includes("licence_billing"), r1?.matched_by);
  check("…and the desk it names is spelled the way the desk's own counter spells it",
    r1?.department_key === await deskKey(rd), r1?.department_key);

  await keep(`insert into support_ticket_routes (tenant_id, name, department_id, languages, precedence)
              values ($1,'Probe swahili rule',$2,'{sw}',5)`, [TEN, rd]);
  const rsw = await route([TEN, "phone_call", "licence_billing", "urgent", "sw", null]);
  check("a call spoken in Swahili is routed by the rule that says so, ahead of the urgent one",
    rsw?.rule_name === "Probe swahili rule", rsw);
  await keep(`insert into support_ticket_routes (tenant_id, name, department_id, region_ids,
              precedence, channels) values ($1,'Probe coast rule',$2,'{111}',1,$3)`,
    [TEN, rd, ["walk_in"]]);
  check("a region rule does not fire for a caller whose company has no region on file",
    (await route([TEN, "walk_in", "onboarding", "low", "en", null]))?.status === "no_rule");
  check("…and it fires when the region is the one it names",
    (await route([TEN, "walk_in", "onboarding", "low", "en", 111]))?.rule_name === "Probe coast rule");

  const loaded = await desk("Probe loaded desk", { max_open_tickets: "2" });
  await keep(`update support_ticket_routes set categories = '{complaint}', department_id = $2
              where tenant_id = $1 and name = 'Probe licence rule'`, [TEN, loaded]);
  await newTicket({ department_id: loaded, status: "in_progress" });
  await newTicket({ department_id: loaded, status: "allocated" });
  const r3 = await route([TEN, "phone_call", "complaint", "normal", "en", null]);
  check("the match carries the ceiling the desk set and the work it is holding, so a clerk can be told",
    r3?.max_open_tickets === 2 && Number(r3?.open_tickets) === 2, r3);
  await keep(`update support_ticket_routes set is_active = false
              where tenant_id = $1 and name = 'Probe urgent rule'`, [TEN]);
  check("a rule switched off stops routing, and its history stays where it was written",
    (await route([TEN, "phone_call", "cargo_clearing", "urgent", "en", null]))?.status === "no_rule");
  await keep(`update support_ticket_routes set deleted_at = now()
              where tenant_id = $1 and name = 'Probe swahili rule'`, [TEN]);
  check("…and so does one that has been retired rather than deleted",
    (await route([TEN, "phone_call", "onboarding", "low", "sw", null]))?.rule_name
      !== "Probe swahili rule");
  const coastDesk = (await one(
    `select department_id as d from support_ticket_routes
      where tenant_id = $1 and name = 'Probe coast rule'`, [TEN])).d;
  await keep(`delete from support_tickets where department_id = $1`, [moved]).catch(() => {});
  await keep(`update platform_departments set deleted_at = now() where id = $1`, [coastDesk]);
  check("a rule pointing at a desk that has since been filed away does not hand a call to it",
    (await route([TEN, "walk_in", "onboarding", "low", "en", 111]))?.status === "no_rule");

  // ================================================================
  console.log("\n--- 8 · a desk with work on it cannot be filed away ---");

  const busy = await desk("Probe busy desk");
  const open1 = await newTicket({ department_id: busy, status: "allocated" });
  await newTicket({ department_id: busy, status: "in_progress" });
  const counted = await one(`select platform_auth.department_open_tickets($1) as n`, [busy]);
  check("the counter the guard uses counts the work on the desk, not its history",
    Number(counted?.n) === 2, counted);
  const refused = await refuses(
    `update platform_departments set deleted_at = now(), head_user_id = null, is_active = false
       where id = $1`, [busy]);
  check("the register refuses to file away a desk holding two open incidences",
    /still holds 2 open incidence/i.test(refused), refused);
  check("…and it says what to do first, in the sentence a desk can act on",
    /move them to another desk/i.test(refused), refused);
  await keep(
    `update support_tickets set status = 'closed', resolved_at = now(), resolved_by = $2,
            resolution = 'Probe: the desk answered it and closed the call.'
      where department_id = $1`, [busy, ACT]);
  const settled = await refuses(
    `update platform_departments set deleted_at = now() where id = $1`, [busy]);
  check("a desk whose calls are all settled can be filed away, because nothing is owed on it",
    settled === "", settled);

  const rename = await desk("Probe rename desk");
  await newTicket({ department_id: rename });
  await newTicket({ department_id: rename, deleted_at: new Date(), deleted_by: ACT });
  check("…and a retired call is not counted against a desk, so old paper cannot freeze a close",
    Number((await one(`select platform_auth.department_open_tickets($1) as n`, [rename]))?.n) === 1);
  check("the guard polices filing a desk away, not renaming one that is holding work",
    (await refuses(`update platform_departments set name = 'Probe renamed, still busy' where id = $1`,
      [rename])) === "");
  check("…but the same desk still cannot be closed while that one call sits on it",
    /still holds 1 open incidence/i.test(await refuses(
      `update platform_departments set deleted_at = now() where id = $1`, [rename])));
  // The guard's own sentence says what to do — move them to another desk — so the way out is
  // proved by taking it rather than by reading the message again.
  const refuge = await desk("Probe refuge desk");
  await keep(`update support_tickets set department_id = $2
              where department_id = $1`, [rename, refuge]);
  check("moving the work to the desk above is the way out the guard names, and then the desk can go",
    (await refuses(`update platform_departments set deleted_at = now() where id = $1`,
      [rename])) === "");
  check("…and the desk that took the work is now holding the one live call, not the retired one",
    Number((await one(`select platform_auth.department_open_tickets($1) as n`, [refuge]))?.n) === 1);

  // ================================================================
  console.log("\n--- 9 · cleanup: a gate that reads the shape leaves no register behind ---");

  await owner.query("rollback");
  const residue = await one(
    `select (select count(*)::int from platform_departments
             where key like 'zzprobe%' or key like 'zzrace%') as desks,
            (select count(*)::int from support_tickets where company_name = 'Probe Freight Ltd') as tickets,
            (select count(*)::int from support_ticket_routes where name like 'Probe%') as rules,
            (select count(*)::int from platform_departments where deleted_at is null) as live,
            (select count(*)::int from support_tickets) as tickets_now`);
  check("the probe desks, calls and rules are gone",
    Number(residue?.desks) === 0 && Number(residue?.tickets) === 0 && Number(residue?.rules) === 0,
    residue);
  check("…and the live chart and the register are exactly as this script found them",
    Number(residue?.live) === START_DESKS && Number(residue?.tickets_now) === START_TICKETS,
    { ...residue, START_DESKS, START_TICKETS });

  await owner.end();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error("GATE FAILED:", e.message, (e?.stack ?? "").split("\n")[1] ?? "");
  process.exit(1);
});
