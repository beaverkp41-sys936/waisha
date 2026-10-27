/**
 * 143, proved in the database.
 *
 * The count desk is the first register in this program whose whole purpose is to be trusted a month later.
 * A price list that adds up wrong is caught the day it is quoted; a reading of the 26th that quietly drifted
 * is caught in April, by somebody who has already reported the March. So the questions below are not "does
 * the JSON arrive" — over HTTP a wrong sum and a right sum are the same shape. They are: does every cut
 * still explain the figure it is filed under, does a re-take remember what the first count said, does a
 * window say out loud when it is missing days, and can a seat erase any of it.
 *
 *  1. **The arithmetic, pinned to figures.** `revenue_cut_sum` over a non-array, over a bucket whose
 *     `total` is not a number, over nothing. The period helpers by their round trips rather than by three
 *     printed dates, and the label by the day it has to name — a `D` in a format string is the day of the
 *     WEEK, and the count would have stayed right while the desk said "tuesday 3 Oct" about the 27th.
 *  2. **The reading, once.** `revenue_read_day` is the only body in 143 that does arithmetic, so it is
 *     driven against hand-posted movements with a contra-revenue leg in them: income 150,000 over credits
 *     of 170,000 and debits of 20,000, four buckets per cut, a `no desk named` and a `no road named`
 *     bucket each carrying their negative figure, and a reversed movement that still counts on the day it
 *     earned. A day whose only movements are costs reads as zero rather than as one movement.
 *  3. **The register's own honesty.** A re-take bumps `revisions` by exactly one and carries what it
 *     replaced; an untouched re-take says `unchanged` and rewrites nothing — not even `taken_at`; a day
 *     with nothing in it is passed over by the sweep rather than written as a zero, unless a seat named a
 *     money and asked for the zero on purpose. The sweep re-checks a day whose reading IS a zero: that is
 *     the half 143's section 11 promises and a legs-only money list would have broken.
 *  4. **The rules kept BELOW the doors.** Ten CHECKs on a reading, two on a promise, a partial unique
 *     index, four guard triggers. The refusals that matter most — a day the book moved being erased, a
 *     period moving under a promise, a figure retyped under a signature, two live ambitions for one
 *     month — have no route that reaches them. They are provoked by hand, inside savepoints.
 *  5. **One money, always.** Every read refuses a third word, and no figure in this register is ever the
 *     sum of both. 138's defect is a TZS column with a dollar in it; the answer below is that the shilling
 *     fold and the dollar fold never meet.
 *
 * Nothing of the office's commits. Every fixture — two synthetic office books, four seats, five accounts,
 * two departments, a road, a trip and eight movements — is written inside one transaction that is rolled
 * back, and the committed census is taken on the same socket before `begin` and again after the rollback.
 * The one thing a rollback cannot hand back is the two numbering sequences, so their gaps are counted
 * against the doors that actually reached an INSERT.
 *
 * Every day the fixtures use is read out of Postgres (`current_date` and its offsets), never from the
 * session's clock: a machine west of Greenwich and the book a day apart would make "yesterday" a tomorrow
 * and every `day_is_in_the_future` refusal below would prove nothing.
 *
 * Run: npx tsx scripts/verify-revenue-snapshot-sql.ts          (rehearses 143, rolls it all back)
 *      npx tsx scripts/verify-revenue-snapshot-sql.ts --apply  (143's bodies re-applied to dev)
 *
 * 143 is already recorded on dev, so an amendment to it — the money list in `take_revenue_day`, the
 * comments that describe it — reaches dev through `--apply` and not through `pnpm migrate`. Phase 1
 * compares the live bodies against this file before anything is driven, so a stale dev is named rather than
 * silently rehearsed.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const FILE = "migrations/143_the_count_the_office_keeps_of_the_money_in.sql";
const ROUTE = "src/routes/control-revenue-count.routes.ts";
const MAIN = "src/main.ts";
const ANALYTICS = "src/routes/control-analytics.routes.ts";
const DESK = "../web/app/control/revenue/page.tsx";
const NAV = "../web/components/ControlNav.tsx";
const APPLY = process.argv.includes("--apply");

/** 143's 27 bodies: the four guards it fires, the ten internals that are the register's own working, the
 *  seven reads and the six writes. Counted here so phase 0 can demand that this gate cut every body out of
 *  the file on its own — a lift that quietly missed one would rehearse 26 of 27. */
const GUARDS = ["revenue_snapshot_header_is_immutable", "revenue_snapshot_is_kept",
  "revenue_target_header_is_immutable", "revenue_target_is_kept"];
const HELPERS = ["revenue_cut_sum", "revenue_source_said", "revenue_period_start", "revenue_period_end",
  "revenue_period_label", "revenue_seat_said", "revenue_income_legs", "revenue_route_named",
  "revenue_desk_named", "revenue_read_day"];
const READS = ["revenue_snapshot_detail", "revenue_snapshot_list", "revenue_count_state",
  "revenue_window", "revenue_cut", "revenue_target_detail", "revenue_target_list"];
const WRITES = ["take_revenue_day", "count_revenue_days", "discard_revenue_day", "set_revenue_target",
  "withdraw_revenue_target", "discard_revenue_target"];
const FNS = [...GUARDS, ...HELPERS, ...READS, ...WRITES];
/** The fourteen bodies the app role must never reach: the register's working and its guards. A client that
 *  could call `revenue_income_legs` would hold a reader that bypasses row-level security on the book. */
const INTERNAL = [...GUARDS, ...HELPERS];
const TABLES = ["revenue_periods", "revenue_snapshots", "revenue_targets"];
const POLICIES = ["revenue_periods_readable", "revenue_snapshots_tenant", "revenue_targets_tenant"];
const TRIGGERS: Record<string, string> = {
  revenue_snapshot_headers_are_immutable: "revenue_snapshots",
  revenue_snapshots_are_kept: "revenue_snapshots",
  revenue_target_headers_are_immutable: "revenue_targets",
  revenue_targets_are_kept: "revenue_targets",
};
/** The ten rules a reading keeps for itself. */
const SNAPSHOT_CHECKS = ["revenue_snapshot_one_reading_per_day", "revenue_snapshot_is_a_difference",
  "revenue_snapshot_accounts_add_up", "revenue_snapshot_sources_add_up", "revenue_snapshot_desks_add_up",
  "revenue_snapshot_roads_add_up", "revenue_snapshot_cuts_are_arrays", "revenue_snapshot_empty_is_empty",
  "revenue_snapshot_remembers", "revenue_snapshot_keeps_its_first_moment"];
const TARGET_CHECKS = ["revenue_target_period_is_aligned", "revenue_target_stop_is_explained"];
const PERIOD_CHECKS = ["revenue_periods_one_word", "revenue_periods_one_order"];
const KEYS = ["control.revenue.view", "control.revenue.count", "control.revenue.target"];
/** The thirteen words 133 lets a movement be standing for. `revenue_source_said` has to have one for each,
 *  and the register's list is the ledger's, not a copy of it. */
const SOURCE_WORDS = ["opening", "manual", "adjustment", "reversal", "invoice", "payment", "refund",
  "payout", "fee", "escrow", "cost", "payroll", "tax"];

const HEX = randomUUID().replace(/-/g, "");
const STAMP = HEX.slice(0, 6).toUpperCase();
const BASE = parseInt(HEX.slice(0, 4), 16);
const OFFICE = `C143 office ${STAMP}`;
const OTHER = `C143 other office ${STAMP}`;
const COMPANY = `C143 company ${STAMP}`;
const ROAD = `Dar es Salaam to Mwanza (143 gate ${STAMP})`;
const SEAT = (who: string) => `c143.${who}.${HEX.slice(0, 8)}@waisha.test`;
const call = (fn: string, n: number) =>
  `select platform_auth.${fn}(${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(",")}) as r`;
/** jsonb hands numbers back as numbers and a bare numeric column hands them back as strings; 133's
 *  `numeric(14,2)` also normalises "150000" and "150000.00" apart. Everything below compares figures by
 *  value, which is the only comparison that means the same thing on both sides. */
const n = (x: unknown) => Number(x);

let failures = 0;
let proved = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) proved++; else failures++;
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok ? "" : " — "
    + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 420)}`);
}
function note(msg: string) { console.log(`!!   ${msg}`); }
function phase(t: string) { console.log(`\n--- ${t}`); }

function functionDdl(src: string): string[] {
  const out: string[] = [];
  const re = /^create or replace function platform_auth\.[a-z_0-9]+\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index);
    const plpgsql = rest.indexOf("\nend $$;");
    const sql = rest.indexOf("\n$$;");
    const end = plpgsql < 0 ? sql : (sql < 0 ? plpgsql : Math.min(plpgsql, sql));
    if (end < 0) throw new Error(`no end-of-body for ${rest.slice(0, 60)}`);
    out.push(rest.slice(0, end + (rest[end + 1] === "e" ? "\nend $$;".length : "\n$$;".length)));
  }
  return out;
}
function stmtBetween(src: string, start: string, stop: string): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`statement not found: ${start.slice(0, 48)}`);
  const b = src.indexOf(stop, a);
  if (b < 0) throw new Error(`statement has no end: ${stop.slice(0, 48)}`);
  return src.slice(a, b + stop.length);
}
/** The body between `as $$` and the closing marker, whitespace-normalised, so a live `prosrc` can be
 *  compared with the file this gate is about to drive. */
function bodyOf(ddl: string): string {
  const a = ddl.indexOf("as $$");
  return ddl.slice(a + 5, ddl.lastIndexOf("$$")).replace(/\s+/g, " ").trim();
}
/** Both route and desk are checked as CODE, with the comment blocks stripped: 143's own header says "a route
 *  that summed a `snapshots` array … would be that second path", and a needle that matched the sentence
 *  warning against it would be a check that passes by reading the warning. */
function codeOnly(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  /** git hands a Windows checkout back with CRLF terminators, which silently breaks a `\n` in the middle of
   *  a needle while leaving the end-of-body markers intact. */
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const src = read(FILE);

  phase("0 · 143's 27 bodies, its internal revoke, its door grant, its PUBLIC sweep and its two sequence "
    + `revokes ${APPLY ? "are re-applied to dev and committed" : "re-execute against the live catalog "
      + "and roll back"}`);
  const ddl = functionDdl(src);
  const internalRevoke = stmtBetween(src,
    "revoke execute on function\n  platform_auth.revenue_cut_sum(jsonb),",
    "from public, anon, authenticated, service_role, app_runtime;");
  const grant = stmtBetween(src,
    "grant execute on function\n  platform_auth.revenue_snapshot_detail(uuid, uuid),",
    "to app_runtime;");
  const sweep = stmtBetween(src,
    "revoke all on function\n  platform_auth.revenue_snapshot_detail(uuid, uuid),",
    "from public, anon, authenticated, service_role;");
  const seqRevokes = [
    stmtBetween(src, "revoke all on revenue_snapshot_number_seq", "service_role, app_runtime;"),
    stmtBetween(src, "revoke all on revenue_target_number_seq", "service_role, app_runtime;")];

  check(`143 declares ${FNS.length} functions — ${GUARDS.length} guards, ${HELPERS.length} internals, `
    + `the ${READS.length} reads and the ${WRITES.length} writes — and this gate cut every one of them out `
    + "of the file on its own",
    ddl.length === FNS.length
    && (src.match(/^create or replace function platform_auth\./gm) ?? []).length === FNS.length
    && FNS.every((f) => ddl.some((d) => d.startsWith(`create or replace function platform_auth.${f}(`))),
    ddl.map((d) => d.slice(38, 74)));
  check("143 re-declares nothing 133, 134 or 142 owns: the audit pen, the seat test and the commission "
    + "figures are called, never rewritten, so counting a day cannot change how a cut or a payout is "
    + "worked out",
    !/create or replace function platform_auth\.(money_audit|approval_seat|commission_figure|commission_on|price_a_job|post_movement)/
      .test(src),
    (src.match(/^create or replace function platform_auth\.\w+/gm) ?? []).length);
  check("neither numbering sequence is granted to a client role at creation and both are revoked down to "
    + "the owner — 134's, 135's, 140's, 141's and 142's rule applied to a count",
    !/grant [^;]*on revenue_(snapshot|target)_number_seq/i.test(src)
    && seqRevokes.every((s) => /app_runtime/.test(s)), seqRevokes);
  check("the replay carries neither half of the file's own transaction pair, so a rehearsal cannot commit "
    + "the office's register behind a gate that promised not to",
    !/^(begin|commit);$/m.test([ddl, internalRevoke, grant, sweep, ...seqRevokes].join("\n")));

  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false },
    statement_timeout: 300000 });
  await c.connect();
  const recorded = (await c.query("select name from schema_migrations where name like '143%' order by 1"))
    .rows.map((r: any) => r.name);
  check("143 is already recorded, which is why an amended one needs this file rather than `pnpm migrate`",
    recorded.length === 1, recorded);

  let err: any = null;
  await c.query("begin");
  try {
    for (const block of ddl) await c.query(block);
    await c.query(internalRevoke);
    await c.query(grant);
    await c.query(sweep);
    for (const s of seqRevokes) await c.query(s);
  } catch (e) { err = e; }
  if (!err && APPLY) await c.query("commit"); else await c.query("rollback");
  check(`the ${ddl.length} bodies, the internal revoke, the door grant, the PUBLIC sweep and the two `
    + `sequence revokes${APPLY ? " are committed" : " — all ran together and rolled back"}`,
    !err, err?.message);
  if (err) {
    await c.end().catch(() => undefined);
    console.log("\n143 does not run as written. Nothing below this line is proved.");
    console.log(String(err?.message ?? err));
    process.exitCode = 1;
    return;
  }
  try { await run(c, src, ddl); } finally { await c.end().catch(() => undefined); }
}

async function run(c: pg.Client, src: string, ddl: string[]) {
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const route = read(ROUTE);
  const main = read(MAIN);
  const analytics = read(ANALYTICS);
  const desk = read(DESK);
  const nav = read(NAV);
  const routeCode = codeOnly(route);
  const IP = "127.0.0.1";
  const UA = "revenue-count-gate";

  const census = async (): Promise<Record<string, number>> => Object.fromEntries((await c.query(
    `select 'periods' as k, count(*)::int as n from revenue_periods
     union all select 'readings', count(*)::int from revenue_snapshots
     union all select 'promises', count(*)::int from revenue_targets
     union all select 'books', count(*)::int from tenants
     union all select 'seats', count(*)::int from users
     union all select 'postings', count(*)::int from money_postings
     union all select 'legs', count(*)::int from money_entries
     union all select 'accounts', count(*)::int from money_accounts`)).rows
    .map((r: any) => [r.k, r.n]));

  const one = async (sql: string, p: any[] = []) => (await c.query(sql, p)).rows[0];
  const oi = (sql: string, p: any[] = []) => c.query(sql, p);
  const door = async (fn: string, args: any[]) =>
    (await oi(call(fn, args.length), args)).rows[0]?.r ?? {};
  /** A statement proved refused: returns its message, or "NO REFUSAL". The savepoint is not decoration —
   *  an aborted statement poisons the whole transaction, and this gate keeps driving after it. */
  const refused = async (sql: string, p: any[] = []) => {
    await c.query("savepoint guard");
    try {
      await c.query(sql, p);
      await c.query("rollback to savepoint guard");
      return "NO REFUSAL";
    } catch (e: any) {
      await c.query("rollback to savepoint guard");
      return String(e.message);
    }
  };
  /** The other half, and it cannot be folded into it: a statement proved allowed has to be kept, because
   *  `refused` rolls its savepoint back whether the statement answered or threw. */
  const keeps = async (sql: string, p: any[] = []) => {
    await c.query("savepoint allowed");
    try {
      const rows = (await oi(sql, p)).rows;
      await c.query("release savepoint allowed");
      return { ok: true as const, rows, message: "NO REFUSAL" };
    } catch (e: any) {
      await c.query("rollback to savepoint allowed");
      return { ok: false as const, rows: [] as any[], message: String(e.message) };
    }
  };

  // ---------------- the days, from the book's own clock ----------------
  const D = await one(`select current_date::text as today, (current_date - 1)::text as d1,
      (current_date - 2)::text as d2, (current_date - 3)::text as d3, (current_date - 4)::text as d4,
      (current_date - 5)::text as d5, (current_date - 6)::text as d6, (current_date + 1)::text as tomorrow,
      (current_date - 91)::text as w91, (current_date - 92)::text as w93,
      (current_date - 730)::text as edge, (current_date - 731)::text as past_edge,
      (current_date + 800)::text as far_forward,
      date_trunc('month', current_date)::date::text as month_start,
      (date_trunc('month', current_date) + interval '1 month')::date::text as month_end,
      date_trunc('week', current_date)::date::text as week_start,
      extract(year from current_date)::int as year`);

  const before = await census();
  const snapSeq = (await one("select last_value::int as n from revenue_snapshot_number_seq")).n;
  const tgtSeq = (await one("select last_value::int as n from revenue_target_number_seq")).n;
  const YEAR = D.year;

  await c.query("begin");
  try {
    // ---------------- 1 · the catalog, the privileges and the two hands ----------------
    phase("1 · what the catalog holds, who may reach it, and who may hold which duty");

    const liveRows = (await c.query(
      `select p.proname as name, p.prosrc as body from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'platform_auth' and p.proname = any($1::text[])`, [FNS])).rows;
    const live = liveRows as { name: string, body: string }[];
    const stale = FNS.filter((f) => {
      const row = live.find((l) => l.name === f);
      const want = ddl.find((d) => d.startsWith(`create or replace function platform_auth.${f}(`));
      if (!row || !want) return true;
      return bodyOf(want) !== row.body.replace(/\s+/g, " ").trim();
    });
    check("the 27 bodies this gate is about to drive are the bodies in the file — dev was amended by hand "
        + "and a gate that rehearsed a stale body would prove the old arithmetic",
      stale.length === 0, { stale, note: APPLY ? "just committed" : "run with --apply first" });

    const rls = await c.query(
      `select c.relname as t, c.relrowsecurity as on from pg_class c
         join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname = 'public' and c.relname = any($1::text[])`, [TABLES]);
    const pols = (await c.query(
      `select policyname as k from pg_policies where tablename = any($1::text[])`,
      [TABLES])).rows.map((r: any) => r.k);
    check("the three registers are row-level-security on, each with the policy its own section wrote — the "
        + "office's role bypasses RLS, so this is the shape for the day it does not, not a decoration",
      TABLES.every((t) => rls.rows.find((r: any) => r.t === t)?.on === true)
      && POLICIES.every((p) => pols.includes(p)), { pols });

    /** `aclexplode` names its grantee by oid, and PUBLIC is oid 0: joined through `pg_roles` it arrives as
     *  NULL, which would make a PUBLIC grant invisible to a role-name filter rather than reported as one.
     *  `grantee::regrole` prints 0 as `public`, so the sweep 143 writes is the sweep this gate can see. */
    const tableAcl = await c.query(
      `select c.relname as t, lower(a.grantee::regrole::text) as who,
              array_agg(distinct a.privilege_type) as what
         from pg_class c
         join pg_namespace ns on ns.oid = c.relnamespace
         cross join aclexplode(COALESCE(c.relacl, '{}'::aclitem[])) a
        where ns.nspname = 'public' and c.relname = any($1::text[])
        group by 1,2`, [TABLES]);
    const appSel = (t: string) => tableAcl.rows.find((r: any) => r.t === t && r.who === "app_runtime");
    const clientWrites = tableAcl.rows.filter((r: any) =>
      ["public", "anon", "authenticated", "service_role"].includes(r.who)
      && (r.what as string[]).some((p) => p !== "USAGE"));
    check("the app role holds SELECT and nothing else on the count: no door the register has is a table "
        + "grant, and a desk that could UPDATE a reading would be a second arithmetic path wearing SQL",
      TABLES.every((t) => {
        const w = appSel(t)?.what as string[] | undefined;
        return !!w && w.length === 1 && w[0] === "SELECT";
      }) && clientWrites.length === 0, { rows: tableAcl.rows, clientWrites });

    /** Two catalog shapes make a privilege check lie. `aclexplode` prints its grantee by oid and PUBLIC is
     *  oid 0, so a `join pg_roles` gives NULL where the truth is `public` — 129's gate learned that a filter
     *  matching only `public` calls an open door shut. And `privilege_type` comes back in the catalog's own
     *  upper case: a `.includes("Execute")` test never matches, so every door looks shut and every leak
     *  looks swept. Both are fixed at the source: the role is printed through `regrole` and lowered, the
     *  privilege is compared in upper case. */
    const fnAcl = await c.query(
      `select p.proname as name, lower(a.grantee::regrole::text) as who,
              array_agg(distinct a.privilege_type) as what
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         cross join aclexplode(p.proacl) a
        where n.nspname = 'platform_auth' and p.proname = any($1::text[])
        group by 1,2`, [FNS]);
    const leak = (who: string) => fnAcl.rows
      .filter((r: any) => r.who === who && (r.what as string[]).includes("EXECUTE"))
      .map((r: any) => r.name);
    /** A body with no `proacl` entry at all is a body still granted to PUBLIC: `create or replace function`
     *  grants EXECUTE to PUBLIC and a revoke that missed one leaves the default in place rather than an
     *  empty list, so a missing row is the leak, not the absence of one. */
    const noAcl = FNS.filter((f) => !fnAcl.rows.some((r: any) => r.name === f));
    const doorsOpen = [...READS, ...WRITES]
      .filter((f) => fnAcl.rows.some((r: any) => r.name === f && r.who === "app_runtime"
        && (r.what as string[]).includes("EXECUTE")));
    const internalsClosed = INTERNAL
      .filter((f) => !fnAcl.rows.some((r: any) => r.name === f && r.who === "app_runtime"));
    check(`all ${READS.length + WRITES.length} doors are open to the app role and none of the `
        + `${INTERNAL.length} internals is: the thirteen calls are the only path a client has, and the leg `
        + "reader that bypasses the policy stays the register's own working",
      doorsOpen.length === READS.length + WRITES.length && internalsClosed.length === INTERNAL.length,
      { missing: [...READS, ...WRITES].filter((f) => !doorsOpen.includes(f)),
        reached: INTERNAL.filter((f) => !internalsClosed.includes(f)) });
    check("…and no Supabase-side role can execute any of the 27: a drop-and-create resets EXECUTE to PUBLIC, "
        + "so a grant list that was rewritten without the sweep is a door every authenticated company clerk "
        + "can kick",
      leak("anon").length === 0 && leak("authenticated").length === 0
      && leak("service_role").length === 0 && leak("public").length === 0 && noAcl.length === 0,
      { anon: leak("anon"), authenticated: leak("authenticated"), service_role: leak("service_role"),
        public: leak("public"), noAcl });

    const seqAcl = await c.query(
      `select c.relname as s, a.grantee::regrole::text as who, a.privilege_type as what
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join aclexplode(c.relacl) a
        where n.nspname = 'public'
          and c.relname in ('revenue_snapshot_number_seq','revenue_target_number_seq')
          and a.grantee <> 0 and a.grantee <> (select oid from pg_roles where rolname = 'postgres')`);
    check("neither count sequence can be reached by a client role: a clerk with nextval could mint a "
        + "reference the register did not write",
      seqAcl.rows.length === 0, seqAcl.rows);

    const trg = (await c.query(
      `select tgname as k from pg_trigger where not tgisinternal and tgname = any($1::text[])`,
      [Object.keys(TRIGGERS)])).rows.map((r: any) => r.k);
    check("the four guards stand on the tables whose rows they keep — two against a move and two against a "
        + "delete — which is the only reason the register outlives the doors that write it",
      Object.keys(TRIGGERS).every((t) => trg.includes(t)), trg);

    /** The fourteen names go in as ONE array parameter. Left flat, `pg` counts them as fourteen bind
     *  positions against a statement that has one and the whole gate stops at the socket. */
    const cons = (await c.query(
      `select conname as k from pg_constraint where conname = any($1::text[])`,
      [[...SNAPSHOT_CHECKS, ...TARGET_CHECKS, ...PERIOD_CHECKS]])).rows.map((r: any) => r.k);
    const idx = await one(
      `select indexdef as d from pg_indexes where indexname = 'revenue_target_one_per_period_idx'`);
    check(`the ${SNAPSHOT_CHECKS.length} reading rules, the ${TARGET_CHECKS.length} promise rules and the `
        + `${PERIOD_CHECKS.length} period words are all in the catalog, and the one-live-ambition rule is `
        + "an index whose predicate says live",
      [...SNAPSHOT_CHECKS, ...TARGET_CHECKS, ...PERIOD_CHECKS].every((k) => cons.includes(k))
      && /WHERE/.test(idx?.d ?? "") && /'live'/.test(idx?.d ?? ""),
      { missing: [...SNAPSHOT_CHECKS, ...TARGET_CHECKS, ...PERIOD_CHECKS].filter((k) => !cons.includes(k)),
        indexdef: idx?.d });

    const duties = await c.query(
      `select p.key as k, coalesce(string_agg(r.key, ',' order by r.key), '') as roles
         from permissions p
         left join role_permissions rp on rp.permission_key = p.key
         left join roles r on r.id = rp.role_id and r.tenant_id is null
        where p.key = any($1::text[]) group by 1`, [KEYS]);
    const held = (k: string) => duties.rows.find((r: any) => r.k === k)?.roles ?? "";
    check("the three duties exist and are held by platform roles — a key with no seat is a nav entry that "
        + "answers a clerk with an empty panel, which is 140's allowlist trap",
      KEYS.every((k) => duties.rows.some((r: any) => r.k === k))
      && held("control.revenue.view").split(",").filter(Boolean).length >= 2, duties.rows);
    check("the hand that counts is not the hand that promises: `control.revenue.count` and "
        + "`control.revenue.target` are held by different role sets, so no seat both records the "
        + "achievement and sets the figure it is measured against — 135's refusal of .post and .recon "
        + "worn by one role, restated for a month's plan",
      held("control.revenue.count").length > 0 && held("control.revenue.target").length > 0
      && held("control.revenue.count") !== held("control.revenue.target"),
      { count: held("control.revenue.count"), target: held("control.revenue.target") });
    const blind = await one(
      `select coalesce(string_agg(r.key, ','), '') as k from roles r
         join role_permissions rp on rp.role_id = r.id
        where r.tenant_id is null
          and rp.permission_key in ('control.revenue.count','control.revenue.target')
          and not exists (select 1 from role_permissions x where x.role_id = r.id
                            and x.permission_key = 'control.revenue.view')`);
    check("…and no role may count or promise against the book without being able to read it: the door would "
        + "open on a panel the seat cannot see", blind.k === "", blind);

    const periods = await c.query("select key, trunc, sort from revenue_periods order by sort");
    check("the register's own list of granularities is the three words the fold answers, in the order the "
        + "desk prints them: a fourth row with no branch in `revenue_period_start` would be a picker option "
        + "that refuses the press",
      periods.rows.length === 3
      && JSON.stringify(periods.rows.map((r: any) => [r.key, r.trunc, r.sort]))
         === JSON.stringify([["day", "none", 1], ["week", "week", 2], ["month", "month", 3]]),
      periods.rows);

    // ---------------- 2 · the arithmetic, pinned to figures ----------------
    phase("2 · the sum behind every CHECK, the words beside every figure, the period maths");

    const emptySum = await one(`select platform_auth.revenue_cut_sum('[]'::jsonb) as v`);
    const notArray = await one(
      `select platform_auth.revenue_cut_sum('{"total": 5}'::jsonb) as a,
              platform_auth.revenue_cut_sum('null'::jsonb) as b,
              platform_auth.revenue_cut_sum('3'::jsonb) as c`);
    const badBucket = await one(
      `select platform_auth.revenue_cut_sum(
         '[{"total": 100.55},{"total":"abc"},{"no":"total"},{"total": -0.55}]'::jsonb) as v`);
    check("a cut sums to its buckets and a cut that is not a list sums to nothing: the table's four "
        + "add-up CHECKs call this body, so a non-array has to answer 0 rather than abort a constraint — "
        + "and a bucket whose figure is not a number adds nothing, which is the CHECK's own refusal, not "
        + "an exception escaping a constraint",
      Number(emptySum.v) === 0 && Number(notArray.a) === 0 && Number(notArray.b) === 0
      && Number(notArray.c) === 0 && Number(badBucket.v) === 100, { emptySum, notArray, badBucket });

    const said = await c.query(
      `select k as word, platform_auth.revenue_source_said(k) as said
         from unnest($1::text[]) k`, [SOURCE_WORDS]);
    const stranger = await one(
      `select platform_auth.revenue_source_said('zzz') as w,
              platform_auth.revenue_source_said(null) as nul,
              platform_auth.revenue_source_said('') as blank`);
    check(`every one of 133's ${SOURCE_WORDS.length} movement kinds has its own words in `
      + "revenue_source_said, and a kind the register does not know is named as unknown rather than "
      + "printed as a sentence that could be any of the thirteen",
      said.rows.length === SOURCE_WORDS.length
      && said.rows.every((r: any) => r.said && !/does not know/.test(r.said))
      && new Set(said.rows.map((r: any) => r.said)).size === SOURCE_WORDS.length
      && /does not know/.test(stranger.w) && /^unknown/.test(stranger.nul)
      && /^unknown/.test(stranger.blank), { said: said.rows, stranger });

    const wk = await one(`select platform_auth.revenue_period_start('week', date '2026-10-21')::text as s`);
    const ends = await one(
      `select platform_auth.revenue_period_end('week', date '2026-10-19')::text as w,
              platform_auth.revenue_period_end('month', date '2026-01-01')::text as m,
              platform_auth.revenue_period_end('day', date '2026-10-26')::text as d,
              (platform_auth.revenue_period_end('week', date '2026-10-19')
                 - date '2026-10-19')::int as wd`);
    check("a week starts on Monday because that is the day the office opens, a period ends on the first day "
      + "of the next one, and the round trip holds: an inclusive end would make the first day of the next "
      + "period belong to two counts at once",
      String(wk.s).slice(0, 10) === "2026-10-19" && ends.w === "2026-10-26" && ends.m === "2026-02-01"
      && ends.d === "2026-10-27" && ends.wd === 7, { wk, ends });
    const back = await one(
      `select (platform_auth.revenue_period_start('month',
                 platform_auth.revenue_period_end('month', date '2026-01-01') - 1) = date '2026-01-01') as m,
              (platform_auth.revenue_period_start('week',
                 platform_auth.revenue_period_end('week', date '2026-10-19') - 1) = date '2026-10-19') as w`);
    check("…and the day before an end still answers to the period it was derived from, in both folds",
      back.m === true && back.w === true, back);

    const labels = await one(
      `select platform_auth.revenue_period_label('day', date '2026-10-27') as d,
              platform_auth.revenue_period_label('week', date '2026-10-26') as w,
              platform_auth.revenue_period_label('month', date '2026-10-01') as m`);
    /** The bug this line exists for: `D` is the day of the WEEK. A label built with it called the 27th
     *  "tuesday 3 Oct" — the arithmetic stayed right and the desk said a wrong date in a place no sum can
     *  argue with. */
    check("the words beside the figures name the day they mean: a day label carries the day of the MONTH, "
        + "a week label carries both ends, and no label is padded out with the spaces to_char's default "
        + "width would leave in the middle of a sentence",
      /27.*October.*2026/.test(labels.d) && !/^\s|\s$/.test(labels.d)
      && /26.*October.*0?1.*November.*2026/.test(labels.w) && /October.*2026/.test(labels.m), labels);

    const seat = await one(`select platform_auth.revenue_seat_said(gen_random_uuid()) as nothing`);
    check("a seat that is not in the register prints as nothing rather than as an empty name the desk has "
        + "to explain — `taken_by_name` is a sentence about who counted, and a wrong name is worse than a "
        + "missing one",
      seat.nothing === null, seat);

    // ---------------- the fixtures ----------------
    phase("the fixtures: two office books, four seats, five accounts, a road and eight movements");

    const office = (await one(`insert into tenants (type, name, status) values ('platform', $1, 'active')
      returning id`, [OFFICE])).id;
    const other = (await one(`insert into tenants (type, name, status) values ('platform', $1, 'active')
      returning id`, [OTHER])).id;
    const company = (await one(`insert into tenants (type, name, status) values ('transporter', $1,
      'active') returning id`, [COMPANY])).id;
    const pen = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Counting Pen','active',$2) returning id`, [office, SEAT("pen")])).id;
    const quill = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Counting Quill','active',$2) returning id`, [office, SEAT("quill")])).id;
    const bare = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','No Desk Pen','active',$2) returning id`, [office, SEAT("bare")])).id;
    const late = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Late Pen','active',$2) returning id`, [office, SEAT("late")])).id;
    const clerk = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'staff','Not A Seat','active',$2) returning id`, [company, SEAT("clerk")])).id;
    const ghost = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Suspended Pen','suspended',$2) returning id`, [office, SEAT("ghost")])).id;

    const acc = async (code: string, label: string, kind: string, currency: string) => (await one(
      `insert into money_accounts (tenant_id, code, label, kind, currency) values ($1,$2,$3,$4,$5)
       returning id`, [office, code, label, kind, currency])).id;
    const incFee = await acc("FEE-INCOME-143", "Platform fee income (TZS)", "income", "TZS");
    const incTransit = await acc("TRANSIT-INCOME-143", "Transit levy income (TZS)", "income", "TZS");
    const cash = await acc("OPS-CASH-143", "Till the office pays from (TZS)", "asset", "TZS");
    const spend = await acc("COST-OPS-143", "Platform costs (TZS)", "expense", "TZS");
    const incUsd = await acc("FEE-INCOME-USD-143", "Platform fee income (USD)", "income", "USD");
    const cashUsd = await acc("OPS-CASH-USD-143", "Dollar till (USD)", "asset", "USD");
    const otherCash = (await one(`insert into money_accounts (tenant_id, code, label, kind, currency)
      values ($1,'OTHER-CASH-143','Other office till','asset','TZS') returning id`, [other])).id;

    const dept = async (key: string, name: string) => (await one(
      `insert into platform_departments (tenant_id, key, name, purpose)
       values ($1,$2,$3,'The register of counts needs two desks to cut by.') returning id`,
      [office, key, name])).id;
    const counting = await dept(`c143_counting_${HEX.slice(0, 6)}`, "Counting desk");
    const billing = await dept(`c143_billing_${HEX.slice(0, 6)}`, "Billing desk");
    const join = async (who: string, where: string, standing: string, starts: string) =>
      oi(`insert into platform_seat_departments (tenant_id, user_id, department_id, standing, starts_at)
          values ($1,$2,$3,$4,$5::timestamptz)`, [office, who, where, standing, starts]);
    /** The midday the register compares memberships against is a bare `time`, so it is read in the server's
     *  own zone. A start pinned to 09:00Z would sit on the wrong side of that comparison in a book kept
     *  east of Greenwich, so the two standing memberships are dated a clear week and a clear day before the
     *  days they must cover, and only the late seat is pinned inside its own day. */
    await join(pen, counting, "head", `${D.d5}T12:00:00+00`);
    await join(quill, billing, "member", `${D.d5}T12:00:00+00`);
    await join(late, counting, "member", `${D.d2}T06:00:00+00`);

    const routeId = (await one(`insert into routes (tenant_id, name) values ($1,$2) returning id`,
      [office, ROAD])).id;
    const trip = (await one(`insert into trips (tenant_id, route_id) values ($1,$2) returning id`,
      [office, routeId])).id;
    const otherTrip = (await one(`insert into trips (tenant_id, route_id) values ($1,$2) returning id`,
      [other, (await one(`insert into routes (tenant_id, name) values ($1,$2) returning id`,
        [other, `${ROAD} (the other book)`])).id])).id;
    /** A movement whose paper has no road at all. An invoice genuinely carries none — `revenue_route_named`
     *  looks at a trip, a request and a consolidation and nothing else — so the pointer is a bare uuid and
     *  the reading files that money under `no road named` instead of dropping it. */
    const noRoad = randomUUID();

    let postN = 0;
    /** 133's own shape, driven by hand: a two-sided movement, credit one side debit the other, every amount
     *  positive and the direction saying which way it went. The doors that would normally write this are
     *  133's, and this gate is about the register that reads them. */
    const post = async (o: { day: string, currency: string, kind: string, figure: number,
      credit: string, debit: string, seat: string, sourceId?: string, reversed?: boolean,
      memo?: string }) => {
      postN++;
      const ref = `PST-${YEAR}-${BASE}${String(postN).padStart(2, "0")}`;
      const id = (await one(`insert into money_postings (tenant_id, ref, posted_on, memo, currency,
          source_kind, source_id, total, status, raised_by, reversed_by, reversed_at, reversal_note)
         values ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$10,
                 case when $9 = 'reversed' then now() end,
                 case when $9 = 'reversed' then 'The office undid the whole movement.' end)
         returning id`,
        [office, ref, o.day, o.memo ?? `Count gate movement ${postN} on ${o.day}`, o.currency, o.kind,
          o.sourceId ?? null, o.figure, o.reversed ? "reversed" : "posted", o.seat])).id;
      await oi(`insert into money_entries (posting_id, tenant_id, account_id, direction, amount, detail)
         values ($1,$2,$3,'credit',$5,'the credit side'), ($1,$2,$4,'debit',$5,'the debit side')`,
        [id, office, o.credit, o.debit, o.figure]);
      return id;
    };

    /** The day the register is proved on: +100,000 fee on a named road, +40,000 levy on an invoice that
     *  names no road, a 20,000 contra-debit against the levy account, and a 30,000 adjustment that was
     *  later reversed but still belongs to the day it earned. */
    await post({ day: D.d1, currency: "TZS", kind: "fee", figure: 100000, credit: incFee, debit: cash,
      seat: pen, sourceId: trip });
    await post({ day: D.d1, currency: "TZS", kind: "invoice", figure: 40000, credit: incTransit,
      debit: cash, seat: quill, sourceId: noRoad });
    await post({ day: D.d1, currency: "TZS", kind: "refund", figure: 20000, credit: cash,
      debit: incTransit, seat: bare, sourceId: noRoad });
    await post({ day: D.d1, currency: "TZS", kind: "adjustment", figure: 30000, credit: incFee,
      debit: cash, seat: pen, sourceId: trip, reversed: true });
    await post({ day: D.d1, currency: "USD", kind: "fee", figure: 500, credit: incUsd, debit: cashUsd,
      seat: quill, sourceId: noRoad });
    await post({ day: D.d2, currency: "TZS", kind: "invoice", figure: 60000, credit: incTransit,
      debit: cash, seat: late, sourceId: trip });
    await post({ day: D.d5, currency: "TZS", kind: "fee", figure: 7000, credit: incFee, debit: cash,
      seat: pen, sourceId: trip });
    /** A day with a movement and no income in it: costs against the till. The reading of this day is a
     *  zero, and `postings` counts 0 rather than 1 — a day that reads as twelve movements reads as twelve
     *  earnings to whoever is holding the screen. */
    await post({ day: D.d4, currency: "TZS", kind: "cost", figure: 9000, credit: cash, debit: spend,
      seat: pen });

    check("two books, six seats (one suspended, one staff), six accounts, two desks, three memberships, a "
      + "road, a trip in each book and eight movements are planted inside the transaction",
      !!office && !!other && !!company && !!pen && !!quill && !!bare && !!late && !!clerk && !!ghost
      && !!incFee && !!incUsd && !!spend && !!counting && !!trip && !!otherTrip && postN === 8);

    // ---------------- 3 · the reading, written once ----------------
    phase("3 · revenue_read_day — the one body in 143 that does arithmetic");

    const read1 = await door("revenue_read_day", [office, D.d1, "TZS"]);
    const sums = (cut: string) => (read1[cut] as any[]).reduce((t: number, b: any) => t + Number(b.total), 0);
    check("the reading is the two piles and nothing else: income 150,000 over credits 170,000 and debits "
        + "20,000, four movements and four legs — the CHECK `revenue_snapshot_is_a_difference` restated as a "
        + "figure rather than as a rule",
      n(read1.income) === 150000 && n(read1.credit_total) === 170000 && n(read1.debit_total) === 20000
      && n(read1.entries) === 4 && n(read1.postings) === 4 && n(read1.income)
        === n(read1.credit_total) - n(read1.debit_total), read1);
    check("a reversed movement still counts on the day it earned: it is one of the four and it is reported "
        + "as reversed, because its mirror is its own movement on its own day — filtering on status would "
        + "strip the day that earned the money and charge today with somebody else's correction",
      n(read1.reversed_postings) === 1 && n(read1.postings) === 4,
      { reversed: read1.reversed_postings, postings: read1.postings });
    check("all four cuts are partial sums of the same rows, so they cannot disagree with the figure they "
        + "are supposed to explain: each adds to 150,000, including the bucket that is negative",
      ["by_account", "by_source", "by_desk", "by_route"].every((k) => Math.abs(sums(k) - 150000) < 0.005),
      { account: sums("by_account"), source: sums("by_source"), desk: sums("by_desk"),
        route: sums("by_route") });
    const acct = (k: string) => (read1.by_account as any[]).find((b) => b.key === k);
    check("an account cut keeps credit, debit and net apart: the levy account shows 40,000 in and 20,000 "
        + "out and nets 20,000, which is the only reason a contra-revenue day prints as a negative figure "
        + "instead of being filed as zero",
      n(acct("FEE-INCOME-143")?.total) === 130000 && n(acct("FEE-INCOME-143")?.credit) === 130000
      && n(acct("TRANSIT-INCOME-143")?.total) === 20000 && n(acct("TRANSIT-INCOME-143")?.credit) === 40000
      && n(acct("TRANSIT-INCOME-143")?.debit) === 20000, read1.by_account);
    const src = (k: string) => (read1.by_source as any[]).find((b) => b.key === k);
    check("a source cut names each bucket with the register's own word and counts movements, not legs: "
        + "the fee is 100,000 over 1, the refund is -20,000 over 1, the reversed adjustment is still 30,000",
      src("fee")?.label === "A fee" && n(src("fee")?.total) === 100000 && n(src("fee")?.postings) === 1
      && src("refund")?.label === "A refund" && n(src("refund")?.total) === -20000
      && src("adjustment")?.label === "An adjustment" && n(src("adjustment")?.total) === 30000,
      read1.by_source);
    const deskB = (k: string) => (read1.by_desk as any[]).find((b) => b.key === k);
    check("a desk cut is the department the seat stood in ON the day counted: the two head's movements land "
        + "on Counting desk, the invoice on Billing desk, and the seat with no team lands in a named "
        + "bucket rather than being dropped",
      n(deskB("Counting desk")?.total) === 130000 && n(deskB("Billing desk")?.total) === 40000
      && n(deskB("no desk named")?.total) === -20000 && deskB("no desk named")?.label === "No desk named",
      read1.by_desk);
    const road = (k: string) => (read1.by_route as any[]).find((b) => b.key === k);
    check("a road is read through the trip the movement points at; an invoice carries no road at all, so "
        + "20,000 files itself under \"no road named\" and the desk is told, in the cut's own note, that "
        + "most of the book lands there",
      n(road(ROAD)?.total) === 130000 && n(road("no road named")?.total) === 20000, read1.by_route);

    const readUsd = await door("revenue_read_day", [office, D.d1, "USD"]);
    check("the same day in the other money is a different row: 500 dollars, one movement, and no shilling "
        + "figure anywhere in it — 138's lesson, that a sum of two monies is a number with no meaning",
      n(readUsd.income) === 500 && n(readUsd.postings) === 1 && readUsd.currency === "USD"
      && (readUsd.by_account as any[]).length === 1, readUsd);

    const readCost = await door("revenue_read_day", [office, D.d4, "TZS"]);
    check("a day whose only movements are costs reads as an empty day: income 0, entries 0, postings 0 and "
        + "four empty arrays, which is what makes an honest zero possible and what `postings` is for",
      n(readCost.income) === 0 && n(readCost.entries) === 0 && n(readCost.postings) === 0
      && ["by_account", "by_source", "by_desk", "by_route"].every((k) => readCost[k].length === 0), readCost);

    const readOther = await door("revenue_read_day", [other, D.d1, "TZS"]);
    check("the other office's book reads its own nothing: the legs, the accounts and the entries are bound "
        + "to the book inside `revenue_income_legs`, because this schema's role bypasses row-level security "
        + "and `withTenant` is not the guard",
      n(readOther.income) === 0 && n(readOther.postings) === 0 && readOther.currency === "TZS", readOther);

    /** The two road calls differ ONLY in which trip they hand the resolver, and the desk calls differ only
     *  in which day they ask about: `late` joined the counting desk on the 2 days ago, so the day BEFORE its
     *  start must answer NULL and the day of its start must answer with the desk. Written the other way
     *  round — this office's name against the other office's trip — the check passes for the wrong reason
     *  and calls a correct register a leak. */
    const named = await one(
      `select platform_auth.revenue_route_named($1,$2) as own,
              platform_auth.revenue_route_named($1,$3) as crossed,
              platform_auth.revenue_route_named($1,$4) as paper,
              platform_auth.revenue_desk_named($1,$5,$6::date) as head_day,
              platform_auth.revenue_desk_named($1,$7,$8::date) as before_it_joined,
              platform_auth.revenue_desk_named($1,$7,$9::date) as after_it_joined,
              platform_auth.revenue_desk_named($1,$10,$6::date) as no_team`,
      [office, trip, otherTrip, noRoad, pen, D.d1, late, D.d3, D.d2, bare]);
    check("both resolvers are bound to their book and to their day: a trip in another office answers NULL "
        + "to this one, a paper with no road answers NULL to both, and a seat that joined the desk the day "
        + "after is not filed under it for the day before",
      named.own === ROAD && named.crossed === null && named.paper === null
      && named.head_day === "Counting desk" && named.before_it_joined === null
      && named.after_it_joined === "Counting desk" && named.no_team === null, named);

    const legs = await c.query(`select count(*)::int as n, coalesce(sum(amount),0) as v,
        count(distinct posted_on)::int as days from platform_auth.revenue_income_legs($1)`, [office]);
    check("the population every figure in this register is built from is the income legs of one book and "
        + "nothing else: seven legs over 257,500 — every one of the eight movements but the cost-only one "
        + "touches an income account, the contra debit counts as a leg of its own, and the dollar leg is "
        + "there because the reader, not the population, is what filters by money — spanning three days",
      legs.rows[0].n === 7 && Number(legs.rows[0].v) === 257500 && legs.rows[0].days === 3, legs.rows[0]);

    // ---------------- 4 · the door that counts a day ----------------
    phase("4 · take_revenue_day — taken, unchanged, retaken, and the four refusals between them");

    const noSeat = await door("take_revenue_day",
      [office, D.d1, "TZS", null, clerk, "finance_officer", IP, UA]);
    const ghostSeat = await door("take_revenue_day",
      [office, D.d1, "TZS", null, ghost, "finance_officer", IP, UA]);
    const noBook = await door("take_revenue_day",
      [randomUUID(), D.d1, "TZS", null, pen, "finance_officer", IP, UA]);
    const noDay = await door("take_revenue_day",
      [office, null, "TZS", null, pen, "finance_officer", IP, UA]);
    const future = await door("take_revenue_day",
      [office, D.tomorrow, "TZS", null, pen, "finance_officer", IP, UA]);
    const tooFar = await door("take_revenue_day",
      [office, D.past_edge, "TZS", null, pen, "finance_officer", IP, UA]);
    const badNote = await door("take_revenue_day",
      [office, D.d1, "TZS", "recount", pen, "finance_officer", IP, UA]);
    const badMoney = await door("take_revenue_day",
      [office, D.d1, "EUR", null, pen, "finance_officer", IP, UA]);
    const emptyDay = await door("take_revenue_day",
      [office, D.d6, null, null, pen, "finance_officer", IP, UA]);
    check("the count refuses a seat that is not one, a book that is not there, a day that has not happened, "
        + "a day out of reach, a note too short to read in April, a third money and an empty day nobody "
        + "named a money for — eleven codes and every one of them a sentence, not a status",
      [noSeat, ghostSeat, noBook, noDay, future, tooFar, badNote, badMoney, emptyDay].every((r: any) =>
        r.ok === false)
      && [noSeat.error, ghostSeat.error].every((e: string) => e === "not_a_seat")
      && noBook.error === "no_book" && noDay.error === "no_day"
      && future.error === "day_is_in_the_future" && tooFar.error === "day_too_far_back"
      && badNote.error === "bad_note" && badMoney.error === "name_the_money"
      && emptyDay.error === "name_the_money",
      { noSeat, ghostSeat, noBook, noDay, future, tooFar, badNote, badMoney, emptyDay });

    const t1 = await door("take_revenue_day",
      [office, D.d1, "TZS", null, pen, "finance_officer", IP, UA]);
    const snap1 = (t1.snapshots as any[])[0];
    const readingId = snap1?.snapshot?.id as string;
    check("a day counted for the first time comes back `taken`, in one money, with the register's own "
        + "reference and the figure the book gave: 150,000 across four movements, one revision, no previous",
      t1.ok === true && t1.read === 1 && t1.changed === 1 && snap1.state === "taken"
      && /^RSV-\d{4}-\d{5,}$/.test(snap1.ref) && n(snap1.income) === 150000
      && n(snap1.snapshot.revisions) === 1 && snap1.snapshot.previous === null
      && snap1.snapshot.taken_by_name === "Counting Pen", { t1, snap: snap1?.snapshot });

    const row1 = await one(`select * from revenue_snapshots where id = $1`, [readingId]);
    const audit1 = await one(`select action, actor_role, entity, ip, user_agent, after as a, before as b
      from audit_logs where entity_id = $1 order by ts`, [readingId]);
    check("the row carries what the reading said, in all four cuts, and the audit line is written by the "
        + "door inside the same statement — a route that audited on top would double every line in the "
        + "register",
      n(row1.income) === 150000 && n(row1.credit_total) === 170000 && n(row1.debit_total) === 20000
      && row1.postings === 4 && row1.reversed_postings === 1 && JSON.stringify(row1.by_source)
        .includes("A refund") && audit1.action === "revenue_snapshot_taken"
      && audit1.actor_role === "finance_officer" && audit1.a?.seat === "Counting Pen" && audit1.b === null,
      { row1, audit1 });

    const t2 = await door("take_revenue_day",
      [office, D.d1, "TZS", null, quill, "finance_officer", IP, UA]);
    const unchanged = (t2.snapshots as any[])[0];
    const row2 = await one(`select revisions, taken_at, taken_by, previous, first_taken_at
      from revenue_snapshots where id = $1`, [readingId]);
    check("counting the same day again when nothing moved says `unchanged` and rewrites nothing: not the "
        + "figures, not the seat, not the minute — the register must not look like a day that was re-read "
        + "when it was only looked at",
      t2.changed === 0 && unchanged.state === "unchanged" && row2.revisions === 1
      && row2.taken_by === pen && String(row2.taken_at) === String(row1.taken_at)
      && row2.previous === null, { t2, row2 });

    await post({ day: D.d1, currency: "TZS", kind: "payment", figure: 1000, credit: incFee, debit: cash,
      seat: pen, sourceId: noRoad });
    const t3 = await door("take_revenue_day",
      [office, D.d1, "TZS", "The office posted a payment the desk had missed.", pen,
        "finance_officer", IP, UA]);
    const retaken = (t3.snapshots as any[])[0];
    const prev = retaken.snapshot.previous;
    check("and when the book has moved underneath it, the re-take bumps revisions by exactly one, keeps "
        + "the figures it replaced in `previous`, and does not lose the seat that counted it first — a day "
        + "that moved is a day that can say what it used to be",
      t3.changed === 1 && retaken.state === "retaken" && n(retaken.income) === 151000
      && n(retaken.snapshot.revisions) === 2 && n(prev.income) === 150000 && prev.taken_by_name === "Counting Pen"
      && n(prev.by_account.find((b: any) => b.key === "FEE-INCOME-143").total) === 130000, retaken.snapshot);
    /** Every line the gate writes shares one `now()` — the whole rehearsal is one transaction — so `ts`
     *  cannot pick the newest. `ctid` is the insert order inside the partition, and the check names the
     *  action it wants rather than trusting a tie-break to hand it the right line. */
    const auditLines = await c.query(`select action, before as b, after as a from audit_logs
      where entity_id = $1 order by ctid`, [readingId]);
    const audit3 = auditLines.rows.find((r: any) => r.action === "revenue_snapshot_retaken");
    check("…and the re-take's audit line carries the OLD figures in `before`, so the register can be "
        + "reconstructed from the audit alone and does not depend on `previous` surviving",
      !!audit3 && n(audit3.b?.income) === 150000 && n(audit3.b?.revisions) === 1
      && n(audit3.a?.income) === 151000, { lines: auditLines.rows, audit3 });

    const t4 = await door("take_revenue_day", [office, D.d1, null, null, pen, "finance_officer", IP, UA]);
    check("naming no money counts every money the book moved in that day — two readings, the shilling one "
        + "already said the same thing and the dollar one is new, in one press",
      t4.read === 2 && t4.changed === 1
      && (t4.snapshots as any[]).some((s) => s.currency === "TZS" && s.state === "unchanged")
      && (t4.snapshots as any[]).some((s) => s.currency === "USD" && s.state === "taken"), t4.snapshots);

    const z3 = await door("take_revenue_day",
      [office, D.d3, "TZS", "Counted the 3rd: the book held nothing.", pen, "finance_officer", IP, UA]);
    const z3row = await one(`select id, postings, income, by_account from revenue_snapshots
      where tenant_id = $1 and snapshot_day = $2 and currency = 'TZS'`, [office, D.d3]);
    check("an honest zero exists only when a seat names the money: the 3rd is written as 0 over no "
        + "movements and four empty arrays, which is the row `discard_revenue_day` is allowed to erase and "
        + "the row the sweep exists to re-check",
      z3.ok === true && (z3.snapshots as any[])[0].state === "taken" && z3row.postings === 0
      && n(z3row.income) === 0 && JSON.stringify(z3row.by_account) === "[]", { z3, z3row });
    const z4 = await door("take_revenue_day", [office, D.d4, null, null, pen, "finance_officer", IP, UA]);
    check("naming no money for a cost-only day still refuses, because there is no reading of it yet: a "
        + "zero has to be a zero in a money, or the row means nothing",
      z4.ok === false && z4.error === "name_the_money", z4);
    const z4t = await door("take_revenue_day", [office, D.d4, "TZS", null, pen, "finance_officer", IP, UA]);
    const z4id = (z4t.snapshots as any[])[0].snapshot.id as string;
    const otherRefusal = await door("take_revenue_day",
      [other, D.d1, null, null, pen, "finance_officer", IP, UA]);
    check("…and a book that moved nothing answers the same refusal for its own day, so the register never "
        + "writes a reading on top of another office's silence",
      z4t.ok === true && (z4t.snapshots as any[])[0].state === "taken"
      && otherRefusal.ok === false && otherRefusal.error === "name_the_money", { z4t, otherRefusal });

    const dupes = await one(`select count(*)::int as n from revenue_snapshots where tenant_id = $1
      and currency = 'TZS' and snapshot_day = $2`, [office, D.d1]);
    check("however many presses the day was through, one day in one money in one book is one reading — the "
        + "unique key the door's own FOR UPDATE path relies on",
      dupes.n === 1, dupes);

    // ---------------- 5 · the sweep ----------------
    phase("5 · count_revenue_days — a quarter at a time, and every day it already counted re-checked");

    const sFuture = await door("count_revenue_days",
      [office, D.d5, D.tomorrow, pen, "finance_officer", IP, UA]);
    const sFar = await door("count_revenue_days",
      [office, D.past_edge, D.d5, pen, "finance_officer", IP, UA]);
    const sWide = await door("count_revenue_days", [office, D.w93, D.today, pen, "finance_officer", IP, UA]);
    const sBad = await door("count_revenue_days", [office, D.d2, D.d5, pen, "finance_officer", IP, UA]);
    const sNone = await door("count_revenue_days", [office, null, D.today, pen, "finance_officer", IP, UA]);
    const sNoSeat = await door("count_revenue_days", [office, D.d5, D.d1, clerk, "x", IP, UA]);
    check("the sweep refuses a window that reaches tomorrow, one further back than two years, one wider "
        + "than a quarter, one whose last day comes first, one with no ends at all, and one ordered by a "
        + "seat that is not one: a book is counted a quarter at a time on this connection",
      [sFuture, sFar, sWide, sBad, sNone, sNoSeat].every((r: any) => r.ok === false)
      && sFuture.error === "window_reaches_tomorrow" && sFar.error === "window_too_far_back"
      && sWide.error === "window_too_wide" && sBad.error === "bad_window"
      && sNone.error === "no_window" && sNoSeat.error === "not_a_seat",
      { sFuture, sFar, sWide, sBad, sNone, sNoSeat });

    const wide = await one(`select (current_date - $1::date + 1)::int as days, $2::int as over`,
      [D.w93, 92]);
    check("…and the 92-day limit is the limit the message names, counted the same way the door counts it",
      wide.days === 93 && wide.over === 92, wide);

    const sweepA = await door("count_revenue_days",
      [office, D.d4, D.d1, pen, "finance_officer", IP, UA]);
    const zeroAgain = (sweepA.readings as any[]).filter((r) => r.day === D.d3);
    check("a window the book moved in is read day by day, and days_read plus passed_over is the width of "
        + "the window exactly — a sweep that silently skipped a day would be the register reporting a "
        + "month it had not counted",
      sweepA.ok === true && sweepA.days_read + sweepA.passed_over === 4, { w: sweepA.from_day,
        to: sweepA.to_day, read: sweepA.days_read, passed: sweepA.passed_over });
    /** The regression the amendment to `take_revenue_day` exists for. A zero reading has no legs, so the
     *  money list built from legs alone came up empty for exactly the day the snapshot arm had just pulled
     *  into the sweep — and the door answered `name_the_money` instead of re-checking. */
    /** The key is ALWAYS there and the value is NULL when nothing was refused: `jsonb_build_object` cannot
     *  omit a key, so `refused === undefined` is a check that can never pass and `refused.length` is a crash
     *  on the clean run. */
    check("a day whose ONLY reading is a zero is re-checked by the sweep, not refused: the money list is "
        + "the union of the day's legs and the day's readings, and the section-11 promise that every day "
        + "already counted is re-checked is false without it",
      zeroAgain.length === 1 && zeroAgain[0].state === "unchanged"
      && zeroAgain[0].currency === "TZS" && sweepA.refused == null,
      { zeroAgain, refused: sweepA.refused });
    check("…and the sweep reports its own refusals rather than swallowing them, so a run that read six days "
        + "and skipped one cannot be presented as a clean quarter",
      sweepA.refused == null || (sweepA.refused as any[]).length === 0, sweepA.refused);

    await post({ day: D.d2, currency: "TZS", kind: "fee", figure: 5000, credit: incFee, debit: cash,
      seat: quill, sourceId: trip });
    const sweepB = await door("count_revenue_days",
      [office, D.d4, D.d1, pen, "finance_officer", IP, UA]);
    const d2row = await one(`select revisions, previous, income from revenue_snapshots
      where tenant_id = $1 and snapshot_day = $2 and currency = 'TZS'`, [office, D.d2]);
    check("the re-check is the half that makes the register trustworthy: a movement posted late for a day "
        + "already counted is found by the next sweep, the reading is re-taken, and the figure the office "
        + "reported is proven not to have drifted under it",
      sweepB.retaken >= 1 && (sweepB.readings as any[]).some((r) => r.day === D.d2
        && r.state === "retaken") && d2row.revisions === 2 && n(d2row.income) === 65000
      && n(d2row.previous.income) === 60000, { sweepB, d2row });

    const sweepWide = await door("count_revenue_days",
      [office, D.w91, D.d1, pen, "finance_officer", IP, UA]);
    check("empty days inside a quarter are reported as passed over rather than written as zeros, and the "
        + "list of them is capped at thirty with the answer saying it is capped — a count that prints "
        + "ninety dates is a page nobody reads, and a capped array presented as complete is the same "
        + "omission the cuts refuse",
      sweepWide.ok === true && sweepWide.passed_over > 30
      && (sweepWide.passed_over_days as any[]).length === 30
      && sweepWide.passed_over_days_capped === true
      && sweepWide.days_read + sweepWide.passed_over === 91,
      { read: sweepWide.days_read, passed: sweepWide.passed_over,
        list: (sweepWide.passed_over_days as any[]).length });
    const zeros = await one("select count(*)::int as n from revenue_snapshots where tenant_id = $1 "
      + "and postings = 0", [office]);
    check("…and the passed-over days stayed out of the register: two zero readings exist because a seat "
        + "named them, not because a sweep wrote them",
      zeros.n === 2, zeros);
    const swept = await one(`select count(*)::int as n from revenue_snapshots where tenant_id = $1
      and currency = 'TZS' and snapshot_day = $2`, [office, D.d5]);
    check("a day the book moved and nobody had read is counted by the sweep, which is the door the "
        + "morning loop calls and the reason the register can be brought up to date by one press",
      swept.n === 1, swept);

    // ---------------- 6 · the one erase ----------------
    phase("6 · discard_revenue_day, and the guard that refuses the same delete by itself");

    const dNoSeat = await door("discard_revenue_day",
      [office, readingId, "The desk mis-clicked.", clerk, "x", IP, UA]);
    const dBadReason = await door("discard_revenue_day",
      [office, readingId, "oops", pen, "finance_officer", IP, UA]);
    const dGone = await door("discard_revenue_day",
      [office, randomUUID(), "The desk mis-clicked it.", pen, "finance_officer", IP, UA]);
    const dMoved = await door("discard_revenue_day",
      [office, readingId, "The office wants the 26th gone.", pen, "finance_officer", IP, UA]);
    const still = await one("select count(*)::int as n from revenue_snapshots where id = $1", [readingId]);
    check("the erase refuses a seat that is not one, a reason too short to read after the row is gone, a "
        + "reading that is not in this book, and — the whole point — a day the book moved; and the refusal "
        + "is reached before the delete, because the row is still there",
      [dNoSeat, dBadReason, dGone, dMoved].every((r: any) => r.ok === false)
      && dNoSeat.error === "not_a_seat" && dBadReason.error === "bad_reason"
      && dGone.error === "not_found" && dMoved.error === "counted_a_day_that_moved"
      && dMoved.postings === 5 && still.n === 1, { dMoved, still });
    check("…and the door says it in the same words the guard does, so a clerk is never told that a press "
        + "broke: the sentence names the reference, the movements and the alternative",
      /counted 5 movement/.test(dMoved.message) && /re-taking/.test(dMoved.message), dMoved.message);

    const keptBy = await refused("delete from revenue_snapshots where id = $1", [readingId]);
    check("the rule lives below the door: a bare DELETE of a reading that moved money is refused by the "
        + "table's own keep-trigger, with the register's sentence — 140's rule for a price a seat was asked "
        + "to sign, applied to a statement the office has already read out",
      /23514|is kept/.test(keptBy), keptBy);
    const emptyDelete = await keeps("delete from revenue_snapshots where id = $1", [z3row.id]);
    check("…and the same DELETE of a day that held nothing is allowed, which is the only case where the row "
        + "asserted nothing: a mis-clicked desk must not accumulate permanent zeros the register cannot "
        + "answer with",
      emptyDelete.ok === true, emptyDelete.message);
    const gone = await door("discard_revenue_day",
      [office, z4id, "Fixture run left the 4th empty.", pen, "finance_officer", IP, UA]);
    const goneAudit = await one(`select action, after as a from audit_logs where entity_id = $1
      and action = 'revenue_snapshot_discarded'`, [z4id]);
    check("through the door the empty reading goes with its reason and its seat in the audit line — the "
        + "only erase in the register, and it is the one row the audit can still explain after the row is "
        + "gone",
      gone.ok === true && gone.discarded?.startsWith("RSV-") && goneAudit.a?.reason === "Fixture run left "
      + "the 4th empty." && goneAudit.a?.seat === "Counting Pen", { gone, goneAudit });

    // ---------------- 7 · the rules the doors never reach ----------------
    phase("7 · the guards, provoked by hand — every one of these is unreachable from a route");

    await c.query("savepoint guard_demo");
    const immut = [
      ["the day it counts", `update revenue_snapshots set snapshot_day = snapshot_day + 1 where id = $1`],
      ["the money it is a count in", `update revenue_snapshots set currency = 'USD' where id = $1`],
      ["its own reference", `update revenue_snapshots set ref = 'RSV-2030-00001' where id = $1`],
      ["whose book it is", `update revenue_snapshots set tenant_id = $2 where id = $1`],
      ["the moment it was first taken", `update revenue_snapshots set first_taken_at = now() + interval '1 hour' where id = $1`],
    ] as [string, string][];
    const immutRefused: Record<string, string> = {};
    for (const [what, sql] of immut) {
      const p = /tenant_id/.test(sql) ? [readingId, other] : [readingId];
      immutRefused[what] = await refused(sql, p);
    }
    check("a reading's identity is its day, its money, its reference, its book and its first moment — all "
        + "five are refused by the immutability guard, so a re-take cannot quietly become a different "
        + "day's count",
      Object.values(immutRefused).every((m) => /identity|23514/.test(m) && m !== "NO REFUSAL"),
      immutRefused);
    const figureStep = await keeps(
      "update revenue_snapshots set income = income, note = note where id = $1", [readingId]);
    check("…and a figure is not part of that identity: an UPDATE that touches only the numbers is allowed, "
        + "which is the only way the register can answer a day the book moved",
      figureStep.ok === true, figureStep.message);
    const revJump = await refused(
      `update revenue_snapshots set revisions = revisions + 2,
         previous = jsonb_build_object('income', income) where id = $1`, [readingId]);
    const revDown = await refused(
      `update revenue_snapshots set revisions = revisions - 1 where id = $1`, [readingId]);
    const revNoPrev = await refused(
      `update revenue_snapshots set revisions = revisions + 1, previous = null where id = $1`, [readingId]);
    const revLegal = await keeps(
      `update revenue_snapshots set revisions = revisions + 1,
         previous = jsonb_build_object('income', income, 'revisions', revisions) where id = $1`,
      [readingId]);
    check("a day is re-taken one count at a time: a jump of two would be a reading that left no trace, a "
        + "step down would be the register forgetting, a re-take with nothing to carry would lose the "
        + "figures, and the legal single step with its previous is allowed",
      /one count at a time|23514/.test(revJump) && revJump !== "NO REFUSAL" && revDown !== "NO REFUSAL"
      && revNoPrev !== "NO REFUSAL" && revLegal.ok === true, { revJump, revDown, revNoPrev, revLegal });

    const notDiff = await refused(
      `insert into revenue_snapshots (tenant_id, ref, snapshot_day, currency, income, credit_total,
          debit_total, postings, taken_by)
       values ($1,'RSV-2031-90001',$2::date,'TZS', 100, 90, 10, 1, $3)`, [office, D.d6, pen]);
    const cutShort = await refused(
      `insert into revenue_snapshots (tenant_id, ref, snapshot_day, currency, income, credit_total,
          debit_total, postings, by_account, taken_by)
       values ($1,'RSV-2031-90002',$2::date,'TZS', 100, 100, 0, 1,
               jsonb_build_array(jsonb_build_object('key','A','total',60)), $3)`,
      [office, D.d6, pen]);
    const objectCut = await refused(
      `insert into revenue_snapshots (tenant_id, ref, snapshot_day, currency, income, credit_total,
          debit_total, postings, by_account, taken_by)
       values ($1,'RSV-2031-90003',$2::date,'TZS', 0, 0, 0, 0, '{}'::jsonb, $3)`,
      [office, D.d6, pen]);
    const lieEmpty = await refused(
      `insert into revenue_snapshots (tenant_id, ref, snapshot_day, currency, income, credit_total,
          debit_total, postings, entries, by_account, taken_by)
       values ($1,'RSV-2031-90004',$2::date,'TZS', 0, 0, 0, 0, 0,
               jsonb_build_array(jsonb_build_object('key','A','total',0)), $3)`,
      [office, D.d6, pen]);
    const honestZero = await keeps(
      `insert into revenue_snapshots (tenant_id, ref, snapshot_day, currency, income, credit_total,
          debit_total, postings, entries, taken_by)
       values ($1,'RSV-2031-90005',$2::date,'TZS', 0, 0, 0, 0, 0, $3)`, [office, D.d6, pen]);
    const forgot = await refused(
      `insert into revenue_snapshots (tenant_id, ref, snapshot_day, currency, income, credit_total,
          debit_total, postings, revisions, taken_by)
       values ($1,'RSV-2031-90006',$2::date,'TZS', 100, 100, 0, 1, 3, $3)`, [office, D.d6, pen]);
    const backwards = await refused(
      `insert into revenue_snapshots (tenant_id, ref, snapshot_day, currency, income, credit_total,
          debit_total, postings, first_taken_at, taken_at, taken_by)
       values ($1,'RSV-2031-90007',$2::date,'TZS', 100, 100, 0, 1, now(), now() - interval '1 hour', $3)`,
      [office, D.d6, pen]);
    const dupeDay = await refused(
      `insert into revenue_snapshots (tenant_id, ref, snapshot_day, currency, income, credit_total,
          debit_total, postings, taken_by)
       values ($1,'RSV-2031-90008',$2::date,'TZS', 100, 100, 0, 1, $3)`, [office, D.d1, pen]);
    check("a reading cannot be written that is not the difference of its own two piles, that carries a cut "
        + "which does not add up, that wears an object where the register says array, that claims an empty "
        + "day over figures, that was counted three times and remembers nothing, whose first moment comes "
        + "after its last, or that is a second reading of a day already read — and the honest zero writes",
      [notDiff, cutShort, objectCut, lieEmpty, forgot, backwards, dupeDay].every((m) => m !== "NO REFUSAL")
      && honestZero.ok === true, { notDiff, cutShort, objectCut, lieEmpty, forgot, backwards, dupeDay });

    const tMisaligned = await refused(
      `insert into revenue_targets (tenant_id, ref, currency, period_kind, period_start, amount, raised_by)
       values ($1,'RTG-2031-90001','TZS','month',$2, 1000, $3)`, [office, D.d1, pen]);
    const tUnexplained = await refused(
      `insert into revenue_targets (tenant_id, ref, currency, period_kind, period_start, amount, status,
          raised_by) values ($1,'RTG-2031-90002','TZS','day',$2, 1000, 'withdrawn', $3)`,
      [office, D.d6, pen]);
    const tLiveStopped = await refused(
      `insert into revenue_targets (tenant_id, ref, currency, period_kind, period_start, amount, status,
          withdrawn_at, raised_by) values ($1,'RTG-2031-90003','TZS','day',$2, 1000, 'live', now(), $3)`,
      [office, D.d6, pen]);
    check("a promise cannot be filed on a day its own period does not start on, cannot be stopped without "
        + "a seat, a minute and a sentence, and cannot be live and stopped at once — and every one of these "
        + "three savepoints is rolled back, so none of them leaves a live row that would make the index "
        + "refusal below fire for the wrong reason",
      [tMisaligned, tUnexplained, tLiveStopped].every((m) => m !== "NO REFUSAL"),
      { tMisaligned, tUnexplained, tLiveStopped });

    const tTarget = await door("set_revenue_target",
      [office, "day", D.d6, 250000, "TZS", "A day's ambition for the empty 6th.", pen, "billing_admin",
        IP, UA]);
    const tId = tTarget.target?.id as string;
    const tRow = await one("select ref, status, period_kind, amount, currency from revenue_targets "
      + "where id = $1", [tId]);
    check("the door stands an ambition up on the empty 6th as a live day promise of 250,000 shillings with "
        + "an RTG reference of its own: the guards below are provoked against a row the door wrote, not "
        + "against paper the door would have refused",
      tTarget.ok === true && tRow.status === "live" && tRow.period_kind === "day"
      && tRow.currency === "TZS" && n(tRow.amount) === 250000 && /^RTG-\d{4}-\d{5,}$/.test(tRow.ref),
      { tTarget, tRow });
    /** The index refusal needs a live row to collide with, and the row it collides with is the one the DOOR
     *  wrote — a bare INSERT of its own would have been rolled back by the savepoint above and the fourth
     *  promise would have filed cleanly, which is what this check printed the first time it was run. */
    const tSecondLive = await refused(
      `insert into revenue_targets (tenant_id, ref, currency, period_kind, period_start, amount, raised_by)
       values ($1,'RTG-2031-90004','TZS','day',$2, 2000, $3)`, [office, D.d6, pen]);
    check("…and a second live promise for the same day in the same money is refused by the partial unique "
        + "index rather than by a door that could be made to skip it: the register keeps one ambition per "
        + "period, not one ambition per press",
      tSecondLive !== "NO REFUSAL" && /duplicate key/i.test(tSecondLive), tSecondLive);
    const tMoves = [
      ["its period", `update revenue_targets set period_start = period_start + 1 where id = $1`],
      ["its kind", `update revenue_targets set period_kind = 'week' where id = $1`],
      ["its money", `update revenue_targets set currency = 'USD' where id = $1`],
      ["its reference", `update revenue_targets set ref = 'RTG-2031-90009' where id = $1`],
      ["its figure", `update revenue_targets set amount = amount + 1 where id = $1`],
    ] as [string, string][];
    const tRefused: Record<string, string> = {};
    for (const [what, sql] of tMoves) tRefused[what] = await refused(sql, [tId]);
    check("an ambition's period, money, reference and figure are what it promised, and the guard refuses "
        + "every one of them moving: the four headers as its identity, and the figure separately, because "
        + "retyping an amount under a signature would make the attainment a moving target",
      Object.values(tRefused).every((m) => m !== "NO REFUSAL"
        && (/identity/.test(m) || /re-typed/.test(m))), tRefused);
    const stopIt = await keeps(
      `update revenue_targets set status = 'withdrawn', withdrawn_by = $2, withdrawn_at = now(),
         withdrawn_reason = 'The office changed what it meant to earn.' where id = $1`, [tId, quill]);
    check("…and the one change a live promise can undergo is to stop: that UPDATE is allowed, which is why "
        + "the door's withdrawal is a state change and not a delete",
      stopIt.ok === true, stopIt.message);
    const revive = await refused(
      `update revenue_targets set status = 'live', withdrawn_by = null, withdrawn_at = null,
         withdrawn_reason = null where id = $1`, [tId]);
    check("a stopped ambition does not come back by UPDATE: the guard refuses the revival in its own words, "
        + "because a revived row would overwrite the reason it stopped — the office states a fresh promise "
        + "for the period instead, which is what the partial index is there to allow",
      revive !== "NO REFUSAL" && /does not come back/.test(revive), revive);
    const keptStop = await refused("delete from revenue_targets where id = $1", [tId]);
    check("a stopped promise's row and its reason are kept against a bare DELETE, because the decision is "
        + "the record — only an ambition nobody ever stood up can be thrown away",
      keptStop !== "NO REFUSAL" && /withdrawn/.test(keptStop), keptStop);
    const freshT = await door("set_revenue_target",
      [office, "day", D.d3, 100000, "USD", "A dollar ambition for a day with no dollar book.", pen,
        "billing_admin", IP, UA]);
    const deleteFresh = await keeps("delete from revenue_targets where id = $1",
      [freshT.target?.id]);
    check("…and a never-counted, never-stopped promise does delete, which is the case the guard exists to "
        + "let through: a slip of the keyboard for a period nobody has been measured against",
      freshT.ok === true && deleteFresh.ok === true, deleteFresh.message);
    const countedTarget = await keeps(
      `insert into revenue_targets (tenant_id, ref, currency, period_kind, period_start, amount, raised_by)
       values ($1,'RTG-2031-90010','TZS','week', $2::date, 500000, $3)`, [office, D.week_start, pen]);
    const deleteCounted = await refused(`delete from revenue_targets
      where tenant_id = $1 and ref = 'RTG-2031-90010'`, [office]);
    check("a target that a reading has fallen inside is kept against a delete — what the office has been "
        + "measured against cannot be un-said, and the guard uses the same period helper the fold does "
        + "rather than a second copy of `+ 7`",
      countedTarget.ok === true && deleteCounted !== "NO REFUSAL"
      && /counted against/.test(deleteCounted), { countedTarget, deleteCounted });
    await c.query("rollback to savepoint guard_demo");
    const residue = await one("select count(*)::int as n from revenue_snapshots where tenant_id = $1 "
      + "and ref like '%900%'", [office]);
    check("…and every hand-prooked write above was rolled back to the phase's own savepoint, so the doors "
        + "below are driven against a register that holds only what the doors wrote",
      residue.n === 0, residue);

    // ---------------- 8 · the ambition, through its doors ----------------
    phase("8 · set, withdraw and throw away a promise");

    const badPeriod = await door("set_revenue_target",
      [office, "quarter", D.d1, 1000, "TZS", null, pen, "billing_admin", IP, UA]);
    const noDayT = await door("set_revenue_target",
      [office, "month", null, 1000, "TZS", null, pen, "billing_admin", IP, UA]);
    const badMoneyT = await door("set_revenue_target",
      [office, "month", D.d1, 1000, "EUR", null, pen, "billing_admin", IP, UA]);
    const zero = await door("set_revenue_target",
      [office, "month", D.d1, 0, "TZS", null, pen, "billing_admin", IP, UA]);
    const minus = await door("set_revenue_target",
      [office, "month", D.d1, -5000, "TZS", null, pen, "billing_admin", IP, UA]);
    const huge = await door("set_revenue_target",
      [office, "month", D.d1, 10000000001, "TZS", null, pen, "billing_admin", IP, UA]);
    const shortNote = await door("set_revenue_target",
      [office, "month", D.d1, 500000, "TZS", "big", pen, "billing_admin", IP, UA]);
    const outOfReach = await door("set_revenue_target",
      [office, "month", D.far_forward, 500000, "TZS", null, pen, "billing_admin", IP, UA]);
    const notSeatT = await door("set_revenue_target",
      [office, "month", D.d1, 500000, "TZS", null, clerk, "billing_admin", IP, UA]);
    check("a promise refuses the word that is not a period, no day at all, a third money, a figure of "
        + "nothing, a negative one, one larger than the register carries, a note too short to read in "
        + "April, a period out of two years' reach and a seat that cannot sign — and a target of nothing "
        + "is not an ambition",
      [badPeriod, noDayT, badMoneyT, zero, minus, huge, shortNote, outOfReach, notSeatT].every(
        (r: any) => r.ok === false)
      && badPeriod.error === "bad_period" && noDayT.error === "no_day"
      && badMoneyT.error === "name_the_money" && zero.error === "bad_amount"
      && minus.error === "bad_amount" && huge.error === "amount_out_of_range"
      && shortNote.error === "bad_note" && outOfReach.error === "period_out_of_reach"
      && notSeatT.error === "not_a_seat",
      { badPeriod, noDayT, badMoneyT, zero, minus, huge, shortNote, outOfReach, notSeatT });

    const month = await door("set_revenue_target",
      [office, "month", D.d1, 400000, "TZS", "October, counted the way the office means it.", pen,
        "billing_admin", IP, UA]);
    const monthId = month.target?.id as string;
    check("a clerk who names a Wednesday and means the month gets the first the month starts on, and the "
        + "answer prints the period it actually wrote with `derived` saying so — nobody has to work out "
        + "whether the desk understood them",
      month.ok === true && month.derived === true && month.period_start === D.month_start
      && /^RTG-\d{4}-\d{5,}$/.test(month.wrote) && n(month.target.amount) === 400000
      && month.target.label === month.period && month.target.status === "live", { month });
    const dupeT = await door("set_revenue_target",
      [office, "month", D.d1, 900000, "TZS", null, quill, "billing_admin", IP, UA]);
    check("a second promise for the same month in the same money is refused with the first one's number, "
        + "its figure and the sentence that says what to press instead — withdrawing it and setting the new "
        + "figure as its own target, so the office can still say what it first meant to earn",
      dupeT.ok === false && dupeT.error === "target_exists" && dupeT.ref === month.wrote
      && /withdraw/.test(dupeT.message), dupeT);

    const detail = await door("revenue_target_detail", [office, monthId]);
    const ownSum = await one(`select coalesce(sum(income),0)::numeric(14,2) as v, count(*)::int as n
      from revenue_snapshots where tenant_id = $1 and currency = 'TZS'
        and snapshot_day >= $2::date and snapshot_day < $3::date`, [office, D.month_start, D.month_end]);
    check("what the register has said against the promise is read out of the register: counted_days and "
        + "actual equal the same sum taken straight off the readings, and gap and attainment are the "
        + "door's own arithmetic rather than a desk's",
      detail.counted_days === ownSum.n && n(detail.actual) === n(ownSum.v)
      && n(detail.gap) === n(detail.amount) - n(detail.actual)
      && n(detail.attainment) === Math.round(n(detail.actual) / n(detail.amount) * 1000) / 10,
      { detail, ownSum });
    const wT = await door("withdraw_revenue_target",
      [office, monthId, "The office will aim lower and say so.", quill, "billing_admin", IP, UA]);
    check("a promise stops with the seat, the minute and the sentence attached, and the row stays: a "
        + "register that let an ambition be un-said would leave the months it was counted against without "
        + "the figure they were measured by",
      wT.ok === true && wT.target.status === "withdrawn"
      && wT.target.withdrawn_by_name === "Counting Quill" && /aim lower/.test(wT.target.withdrawn_reason),
      wT.target);
    const wTwice = await door("withdraw_revenue_target",
      [office, monthId, "Stopped again anyway.", pen, "billing_admin", IP, UA]);
    const discardStopped = await door("discard_revenue_target",
      [office, monthId, "Throw the stopped one away too.", pen, "billing_admin", IP, UA]);
    check("a stopped promise does not stop twice and is not thrown away — its row is the record that "
        + "somebody decided it",
      wTwice.error === "already_withdrawn" && discardStopped.error === "stop_is_recorded",
      { wTwice, discardStopped });
    const renewed = await door("set_revenue_target",
      [office, "month", D.d1, 350000, "TZS", "The renewal the withdrawal makes room for.", pen,
        "billing_admin", IP, UA]);
    check("…and the partial index lets the office state a fresh figure for the same month the moment the "
        + "first promise is stopped, while the stopped one stays in the register: one live ambition per "
        + "period is not one ambition per period",
      renewed.ok === true && n(renewed.target.amount) === 350000
      && renewed.wrote !== month.wrote, renewed);
    const countedAgainst = await door("discard_revenue_target",
      [office, renewed.target.id, "It has days under it.", pen, "billing_admin", IP, UA]);
    check("a promise the register has already counted against cannot be discarded: the door names the "
        + "days and says to withdraw instead, because the office was measured against this figure and that "
        + "is a fact the register keeps",
      countedAgainst.ok === false && countedAgainst.error === "already_counted_against"
      && countedAgainst.days > 0, countedAgainst);
    const weekT = await door("set_revenue_target",
      [office, "week", D.d1, 200000, "TZS", "A week's ambition, on the Monday it starts.", pen,
        "billing_admin", IP, UA]);
    check("a week named by any day inside it is filed on the Monday, and the answer says which Monday it "
        + "chose and that it derived it",
      weekT.ok === true && weekT.period_start === D.week_start && weekT.derived === (D.week_start !== D.d1),
      weekT);

    // ---------------- 9 · the reads, their caps and their one money ----------------
    phase("9 · the register, the fold, the cuts and the state — as reads, not as arithmetic");

    const listDefault = await door("revenue_snapshot_list", [office, null, null, null, 40, 0]);
    const listEur = await door("revenue_snapshot_list", [office, "EUR", null, null, 40, 0]);
    // p_from comes before p_to in the door's own signature, so an inverted window is the *later* day asked
    // for first. Passing them the other way round hands the door a legal window and the refusal never fires.
    const listBad = await door("revenue_snapshot_list", [office, "TZS", D.d1, D.d2, 40, 0]);
    const listClamp = await door("revenue_snapshot_list", [office, "TZS", null, null, 500, -5]);
    const listPage = await door("revenue_snapshot_list", [office, "TZS", null, null, 1, 0]);
    const tzRows = await one(`select count(*)::int as n, coalesce(sum(income),0)::numeric(14,2) as v
      from revenue_snapshots where tenant_id = $1 and currency = 'TZS'`, [office]);
    check("the register defaults to one money rather than defaulting the pair together — 138's defect in a "
        + "list is a total that is neither of the two — and a third word, a last day before the first, an "
        + "offset below nothing and a page of five hundred are each answered in the door's own words",
      listDefault.currency === "TZS" && listEur.ok === false && listEur.error === "name_the_money"
      && listBad.ok === false && listBad.error === "bad_window" && listClamp.limit === 200
      && listClamp.offset === 0,
      // Four doors and one line: a failure printed as the four whole answers is a failure whose clause
      // nobody can see, because the harness cuts the detail short.
      { currency: listDefault.currency, eur: [listEur.ok, listEur.error],
        bad: [listBad.ok, listBad.error], clamp: [listClamp.limit, listClamp.offset] });
    check("…and the count and the window total travel with the page over the whole filtered window, not "
        + "over the rows on it: a clerk shown one reading and a figure from a different one adds the "
        + "column by hand and gets the wrong sum",
      listPage.rows.length === 1 && listPage.counted_days === tzRows.n
      && n(listPage.window_income) === n(tzRows.v)
      && n(listDefault.window_income) === n(tzRows.v), { listPage, tzRows });
    const usdList = await door("revenue_snapshot_list", [office, "USD", null, null, 40, 0]);
    check("…and the dollar register holds the dollar readings only: no shilling figure crosses into it",
      (usdList.rows as any[]).every((r) => r.currency === "USD") && n(usdList.counted_days) >= 1
      && n(usdList.window_income) === 500, usdList);

    const crossDetail = await door("revenue_snapshot_detail", [other, readingId]);
    const ownDetail = await door("revenue_snapshot_detail", [office, readingId]);
    check("one reading reads back with its four cuts, its revisions, what the count before it said, the "
        + "seat that took it and the ambitions its day falls inside — and the same number in another "
        + "office's book answers not_found rather than somebody else's figures",
      crossDetail.ok === false && crossDetail.error === "not_found"
      && ownDetail.ok === true && n(ownDetail.revisions) === 2 && n(ownDetail.previous.income) === 150000
      && ownDetail.taken_by_name === "Counting Pen" && (ownDetail.targets as any[]).length >= 1
      && ownDetail.week_start === D.week_start && ownDetail.month_start === D.month_start,
      { crossDetail, ownDetail });

    // The sweep in phase 5 already read every day the book had income on, so the register has no gap left
    // to find — an honest `uncounted_days: []` and a check that could never pass. What the office is doing
    // when this read matters is posting money after the last count, so the gate plants exactly that: one
    // fee on a day no door has read.
    await post({ day: D.d3, currency: "TZS", kind: "fee", figure: 12000, credit: incFee, debit: cash,
      seat: pen, sourceId: trip });

    const stateBad = await door("revenue_count_state", [randomUUID(), 30]);
    const state1 = await door("revenue_count_state", [office, 120]);
    const stateClamp = await door("revenue_count_state", [office, 0]);
    const stateMax = await door("revenue_count_state", [office, 5000]);
    check("how current the register is is answered per money, and a window of nothing or of five thousand "
        + "days is clamped to what the fold can actually walk — 1 to 730 — rather than being read as an "
        + "exhaustive query",
      stateBad.ok === false && stateBad.error === "no_book" && state1.currencies.length === 2
      && stateClamp.days === 1 && stateMax.days === 730, { stateBad, stateClamp, stateMax });
    const tzState = (state1.currencies as any[]).find((r) => r.currency === "TZS");
    const usdState = (state1.currencies as any[]).find((r) => r.currency === "USD");
    check("a day the book moved income and the office never read is a gap in the register, not a day with "
        + "nothing in it — the count lists it in `uncounted_days` and points at the oldest one, because a "
        + "month reported from a register that stopped on the 21st is part of a month reported as all of it",
      tzState.yesterday_counted === true && n(tzState.income_in_window) > 0
      && tzState.uncounted_days.length === 1 && tzState.uncounted_days.includes(D.d3)
      && tzState.next_day === D.d3 && tzState.uncounted_count === 1
      && tzState.snapshots === (await one(`select count(*)::int as n from revenue_snapshots
          where tenant_id = $1 and currency = 'TZS'`, [office])).n, tzState);
    check("…and the dollar register says its own piece: it holds one reading and its gap list is its own, "
        + "not the shilling one copied across",
      usdState.snapshots === 1 && !usdState.uncounted_days.includes(D.d5)
      && n(usdState.income_in_window) === 500, usdState);

    const winBad = await door("revenue_window", [office, "quarter", D.d5, null, "TZS"]);
    const winEur = await door("revenue_window", [office, "month", D.d5, null, "EUR"]);
    const winNone = await door("revenue_window", [office, "month", null, null, "TZS"]);
    const winWide = await door("revenue_window", [office, "day", D.w91, D.today, "TZS"]);
    check("a fold refuses the word it does not know, a third money, no first day at all and a window wider "
        + "than sixty periods — an open-ended fold would walk the book from its first movement and answer "
        + "twenty seconds after the clerk stopped reading the screen",
      [winBad, winEur, winNone, winWide].every((r: any) => r.ok === false)
      && winBad.error === "bad_period" && winEur.error === "name_the_money"
      && winNone.error === "no_window" && winWide.error === "window_too_wide" && winWide.periods > 60,
      { winBad, winEur, winNone, winWide });

    const winMonth = await door("revenue_window", [office, "month", D.month_start, null, "TZS"]);
    const mRow = (winMonth.rows as any[]).find((r) => r.period_start === D.month_start);
    check("the month prints its actual, its ambition, the gap between them and the attainment to a tenth — "
        + "and the figures add up across the rows the answer carries, because the fold's totals are the "
        + "rows' totals and not a second pass over the book",
      winMonth.ok === true && mRow && n(winMonth.actual) === n(winMonth.rows
        .reduce((t: number, r: any) => t + Number(r.actual), 0))
      && n(winMonth.gap) === n(winMonth.target) - n(winMonth.actual)
      && mRow.target?.amount !== undefined && (mRow.attainment === null
        || Math.abs(n(mRow.actual) / n(mRow.target.amount) * 100 - n(mRow.attainment)) < 0.06),
      { winMonth, mRow });
    const winDay = await door("revenue_window", [office, "day", D.d5, D.d1, "TZS"]);
    const d5Row = (winDay.rows as any[]).find((r) => r.period_start === D.d5);
    const d4Row = (winDay.rows as any[]).find((r) => r.period_start === D.d4);
    check("a day folded on its own says whether it is complete: the 5th was counted by the sweep, and the "
        + "4th — whose only reading was the honest zero erased in the phase above — is an empty period that "
        + "is not complete even though nothing is missing from it, because a fold that called an unread day "
        + "complete would report a month out of a register that stopped",
      winDay.periods === 5 && d5Row?.complete === true && n(d5Row.snapshots) === 1
      && d5Row.uncounted_count === 0 && n(d4Row.actual) === 0 && n(d4Row.snapshots) === 0
      && d4Row.complete === false && d4Row.uncounted_count === 0,
      { periods: winDay.periods, d5Row, d4Row });
    const winUsd = await door("revenue_window", [office, "month", D.month_start, null, "USD"]);
    const uRow = (winUsd.rows as any[]).find((r) => r.period_start === D.month_start);
    check("…and the same month folded in dollars answers 500 with no shilling target attached to it: the "
        + "fold matches only a live promise of the same kind, the same start AND the same money",
      n(winUsd.actual) === 500 && (uRow?.target === null || uRow?.target === undefined), winUsd);

    const cutBad = await door("revenue_cut", [office, "customer", null, null, "TZS", 12]);
    check("the register keeps exactly four cuts and names them when a fifth is asked for, rather than "
        + "guessing which of the four the caller meant",
      cutBad.ok === false && cutBad.error === "bad_cut" && /account, source, desk and route/
        .test(cutBad.message), cutBad);
    for (const kind of ["account", "source", "desk", "route"]) {
      const r = await door("revenue_cut", [office, kind, null, null, "TZS", 60]);
      check(`the "${kind}" cut merged across the register adds back to the income the list totals — the `
        + "screen never re-walks the book to answer a question the register has already answered, and never "
        + "produces a total that disagrees with the day it was drawn from",
        r.ok === true && Math.abs(n(r.income) - n(tzRows.v)) < 0.005
        && Math.abs(n(r.income) - (r.rows as any[]).reduce((t: number, b) => t + Number(b.total), 0))
          < 0.005, { income: r.income, sum: (r.rows as any[]).reduce((t: number, b) => t + Number(b.total), 0) });
    }
    const cutSmall = await door("revenue_cut", [office, "source", null, null, "TZS", 2]);
    const cutClamp = await door("revenue_cut", [office, "source", null, null, "TZS", 999]);
    check("a cut printed two deep says how many buckets it left out rather than presenting a short list as "
        + "the whole book, and a page of nine hundred is clamped to the sixty the door will answer",
      cutSmall.rows.length === 2 && cutSmall.omitted === cutSmall.buckets - 2
      && cutSmall.buckets > 2 && cutClamp.limit === 60, { cutSmall, cutClamp });
    const cutRoute = await door("revenue_cut", [office, "route", null, null, "TZS", 12]);
    const cutAcc = await door("revenue_cut", [office, "account", null, null, "TZS", 12]);
    check("the two cuts that file money under a bucket the register invented carry their note beside the "
        + "figures — \"no road named\" and \"no desk named\" are honest only while the desk is told what "
        + "they mean — and the two that do not, say nothing",
      /no road named/.test(cutRoute.note ?? "") && /no desk named/.test((await door("revenue_cut",
        [office, "desk", null, null, "TZS", 12])).note ?? "") && cutAcc.note === null,
      { route: cutRoute.note, account: cutAcc.note });
    const cutUsd = await door("revenue_cut", [office, "account", null, null, "USD", 12]);
    check("a cut is taken in one money and shows only that money's buckets: the dollar cut answers one "
        + "income account and 500, with no shilling line in it",
      n(cutUsd.income) === 500 && (cutUsd.rows as any[]).length === 1
      && cutUsd.rows[0].key === "FEE-INCOME-USD-143", cutUsd);

    const targetsLive = await door("revenue_target_list", [office, "TZS", null, null, null, false]);
    const targetsAll = await door("revenue_target_list", [office, "TZS", null, null, null, true]);
    check("the ambitions are listed live by default and the stopped ones only when asked: \"we promised "
        + "400,000 and stopped promising it\" is a fact the office has to be able to say, and it is a "
        + "different fact from the one a live target carries",
      (targetsLive.rows as any[]).every((r) => r.status === "live")
      && targetsAll.count > targetsLive.count
      && (targetsAll.rows as any[]).some((r) => r.status === "withdrawn" && r.ref === month.wrote)
      && (targetsAll.rows as any[]).every((r) => r.counted_days !== undefined && !!r.label),
      { live: targetsLive.count, all: targetsAll.count });
    const targetsWeek = await door("revenue_target_list",
      [office, "TZS", "week", null, null, false]);
    const targetsEur = await door("revenue_target_list",
      [office, "EUR", null, null, null, false]);
    check("…and a filter by period and a third money are answered the same way the doors answer them "
        + "everywhere else",
      (targetsWeek.rows as any[]).every((r) => r.kind === "week") && targetsEur.ok === false,
      { targetsWeek, targetsEur });

    // ---------------- 10 · the desk, the doors and the two paths between them ----------------
    phase("10 · what only the files can say");

    const readDoors = READS.filter((f) => new RegExp(`platform_auth\\.${f}\\(`).test(route));
    const writeDoors = WRITES.filter((f) => new RegExp(`platform_auth\\.${f}\\(`).test(route));
    check(`the desk reaches every door the register has — ${READS.length} reads and ${WRITES.length} `
        + "writes, each one a definer call the route hands the book to from the session rather than from "
        + "the caller",
      readDoors.length === READS.length && writeDoors.length === WRITES.length,
      { missing: [...READS, ...WRITES].filter((f) => !readDoors.includes(f) && !writeDoors.includes(f)) });
    const calls = (route.match(/door\(req,/g) ?? []).length;
    const sessionBound = (route.match(/\[tenantOf\(req\)/g) ?? []).length;
    check("143's doors take the book from `req.control.tenant_id` and bind it in `$1` on every call: "
        + "`withTenant` wraps the one socket the door opens and is not the guard, because this schema's "
        + "role bypasses row-level security — a call that named no book would answer one office's question "
        + "out of another office's register",
      /String\(req\.control\.tenant_id\)/.test(route) && calls === sessionBound && calls === 13
      && (route.match(/withTenant\(/g) ?? []).length === 1, { calls, sessionBound });
    check("…and 143 writes no audit row of its own: each door calls `money_audit` inside its statement, so "
        + "a day counted, a promise raised and a stopped ambition are recorded by the same write that makes "
        + "them, and a route that audited on top would double every line",
      !/writeAudit\(/.test(route) && !/audit_logs/.test(routeCode),
      (routeCode.match(/writeAudit\(|audit_logs/g) ?? []));
    check("no arithmetic is done on the way through: the route holds no `reduce`, no `+=`, no percentage "
        + "and no sum of its own — 138's defect is a second arithmetic path, and a route that summed a "
        + "`snapshots` array would end a screen showing one figure while the book carries another",
      !/reduce\(|\+=|\bSum\b|\/ 100|\* 100/.test(routeCode),
      (routeCode.match(/.{0,30}(reduce\(|\+=|\/ 100|\* 100).{0,20}/g) ?? []).slice(0, 4));
    check("the refusals are carried in the door's own words with the status the code implies, and the "
        + "calendar check catches a shape-only date before Postgres answers 22007: 143 answers in its own "
        + "shape and the sentence is the half a clerk needs",
      /NOT_FOUND|FORBIDDEN|CONFLICT/.test(route) && /23505/.test(route)
      && /counted_a_day_that_moved|stop_is_recorded|already_withdrawn|already_counted_against/.test(route)
      && /There is no day/.test(route) && /23514.*23503.*42501/s.test(routeCode.replace(/,/, ",")),
      (route.match(/const (NOT_FOUND|FORBIDDEN|CONFLICT) = new Set[^;]+;/g) ?? []));
    check("the door's refusal sentence is passed through untouched rather than paraphrased, and the "
        + "details the register attached (which day, which figure, how many movements) go with it",
      /const \{ ok, error, message, \.\.\.extra \} = j;/.test(routeCode)
      && /Object\.keys\(extra\)\.length \? \[extra\] : \[\]/.test(routeCode));
    check("the sweep's own 92-day guard sits beside the door's, so a clerk is stopped at the field rather "
        + "than after the press — and the message says what to do instead of only what failed",
      /A sweep reads at most 92 days/.test(routeCode) && /new Date\(`\$\{b\.to\}T00:00:00Z`/.test(routeCode));
    check("there is no nightly clock in this layer and the reason is on the record: 143's sweep door "
        + "refuses anything but a live platform seat because the reading it writes carries `taken_by` into "
        + "a register nobody may rewrite — a clock has no seat, and pointing one at the roster would put an "
        + "automated act behind a named person's signature",
      /not_a_seat/.test(route) && !/setInterval|cron|schedule/.test(routeCode)
      && /GET \/book\/state.*reports|reports the days/.test(route), (routeCode.match(/setInterval|cron/) ?? []));
    check("the desk is mounted on the API root and its three duties are in the permissions probe's list, "
        + "so a seat that holds one is not told it does not",
      /controlRevenueCountRoutes/.test(main) && KEYS.every((k) => analytics.includes(`"${k}"`)),
      { probe: KEYS.map((k) => analytics.includes(`"${k}"`)) });

    const newPanels = desk.slice(desk.indexOf("function CountBook"),
      desk.indexOf("export default function ControlRevenuePage"));
    const newCode = codeOnly(newPanels);
    check("the count desk branches on `control.revenue.count` and the promise desk on "
        + "`control.revenue.target`, and both are inside the `control.revenue.view` gate — a seat that may "
        + "read is not a seat that may write, and the panel that cannot be pressed is not shown as one that "
        + "can",
      /canCount = perm\.includes\("control\.revenue\.count"\)/.test(newCode)
      && /canTarget = perm\.includes\("control\.revenue\.target"\)/.test(newCode)
      && /perm\.includes\("control\.revenue\.view"\)/.test(codeOnly(desk.slice(desk.indexOf(newPanels) + newPanels.length))
        + desk.slice(desk.indexOf("export default")))
      , { count: /control\.revenue\.count/.test(newCode), target: /control\.revenue\.target/.test(newCode) });
    check("no figure is worked out in the browser: the count desk prints what `revenue_window`, "
        + "`revenue_cut` and `revenue_snapshot_list` answer, and neither adds a column, divides a bucket by "
        + "an income nor rounds a percentage itself",
      !/reduce\(|\+=|\/ 100|\* 100/.test(newCode),
      (newCode.match(/.{0,36}(reduce\(|\+=|\/ 100|\* 100).{0,24}/g) ?? []).slice(0, 4));
    check("the desk reaches all ten of the register's shapes — state, book, one reading, the four cuts, "
        + "take, sweep, discard, window and the two target doors — and asks for one money rather than "
        + "leaving the pair to be folded together",
      ["/book/state", "/revenue/book?", "/book/take", "/book/sweep", "/discard", "/revenue/window",
        "/revenue/targets", "/revenue/cut/"].every((p) => newCode.includes(p))
      && /currency=/.test(newCode), (newCode.match(/\/control\/revenue\/[a-z/${}.-]*/g) ?? []));
    check("a passed-over day and a gap are said out loud on the screen rather than printed as nothing: the "
        + "desk carries the sweep's `passed_over`, the state's `uncounted_days` and the fold's `complete`",
      /passed_over/.test(newCode) && /uncounted/.test(newCode) && /complete/.test(newCode));
    check("the nav entry offers the desk to a seat holding any of the three 143 duties and keeps the "
        + "analytics key the old panel is gated on — a held duty that is not in the allowlist stays "
        + "invisible, which is 140's trap",
      /"\/control\/revenue"/.test(nav) && KEYS.every((k) => nav.includes(`"${k}"`))
      && nav.includes("control.analytics.view"), (nav.match(/control\.revenue\.\w+/g) ?? []));

  } finally {
    await c.query("rollback");
  }

  // ---------------- 11 · nothing of the office's ----------------
  phase("11 · the census the rollback has to hand back");
  const after = await census();
  const snapGap = (await one("select last_value::int as n from revenue_snapshot_number_seq")).n;
  const tgtGap = (await one("select last_value::int as n from revenue_target_number_seq")).n;
  check(`every committed count is what it was before the rehearsal: ${Object.keys(before).map((k) =>
    k + "=" + before[k] + "→" + after[k]).join("  ")}`,
    Object.keys(before).every((k) => before[k] === after[k]), { before, after });
  check(`the two sequences are the one thing a rollback cannot hand back — ${snapGap - snapSeq} reading `
    + "number(s) and " + (tgtGap - tgtSeq) + " promise number(s) spent by doors that reached their INSERT, "
    + "against rows the office does not hold",
    snapGap - snapSeq >= 1 && tgtGap - tgtSeq >= 1, { snapGap, tgtGap, snapSeq, tgtSeq });

  console.log(`\n${failures ? "FAILED" : "PROVED"}: ${proved} checks passed, ${failures} failed.`);
  if (failures) process.exitCode = 1;
}

main().catch(async (e) => { console.error("FAILED:", (e as Error).message); process.exit(1); });
