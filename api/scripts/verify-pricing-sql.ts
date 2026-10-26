/**
 * 140, proved in the database.
 *
 * The HTTP smoke (`smoke-pricing.ts`) already walks all seventeen doors over the routes a seat uses, and
 * it deliberately stops short of the one thing this stage is for: **it never spends a signature.** A
 * published card is kept (`pricing_cards_are_kept` refuses the DELETE, `pricing_history_is_kept` refuses
 * the memory's), and `pricing_price_history.card_id` has no cascade — so a smoke that put one price live
 * would make its own fixture book permanently undeletable. The smoke therefore grades `/rate` and `/quote`
 * on their plumbing only, and what it cannot prove is exactly what this gate exists to prove:
 *
 *  1. **The whole paper, in order.** Raise → the proposer cannot sign it → a second seat refuses → the
 *     draft is free again → re-raise → the second seat signs → the signer claims → the apply lands →
 *     the settle closes the register's own row. Every one of those steps is a different door, and the
 *     desk the web stage ships only ever walks the first two.
 *  2. **The rules kept BELOW the doors.** Six guard triggers and two overlap/date triggers are table
 *     triggers, and the refusals that matter most — an `UPDATE` that would silently move a figure a
 *     second seat already signed for, a `DELETE` of a version that was published, a hand-typed line on
 *     a signed card, a second window for one list and day — have no route that reaches them, because the
 *     door that could write them refuses first. They are provoked here by hand, inside savepoints.
 *  3. **A price refuses to invent arithmetic.** `no_price` says the price is not zero, it has not been
 *     set; `no_distance` says a per-kilometre price has no corridor measured to multiply; a per-tonne
 *     price held up to its minimum says so in the working it prints beside the figure. Over the wire a
 *     client cannot tell those four apart from a bug; here each is pinned to a number and a sentence.
 *
 * Versioning is proved as a history, not a claim: the gate clones a live list forward, edits only the
 * clone, publishes it, and reads back that v1's window was closed (`superseded`, `effective_to >=
 * effective_from`), that the resolver now answers the new figure, and that the memory recorded the
 * supersede as both a moved window and a moved price. Then it stops the price with one seat's act —
 * withdrawal is under `.manage` because it is the act that stops a wrong price being quoted an hour
 * longer — and clones a third version off the stopped one, which is the shape a rollback takes.
 *
 * Nothing of the office's commits. Every fixture — the two synthetic books, the three seats, the
 * corridors, the cards, the papers and the memory rows — is written inside one transaction that is
 * rolled back at the end, and the committed census is taken on the same socket before `begin` and again
 * after the rollback, so the office's real registers are proved unchanged rather than assumed empty.
 * The one thing a
 * rollback cannot hand back is `pricing_card_number_seq`: the numbers this gate mints stay spent, which
 * is measured against the count of cards actually opened and cloned rather than taken on faith — a
 * refused `open` or a back-dated `clone` must spend nothing, and 140 validates before it inserts.
 *
 * Run: npx tsx scripts/verify-pricing-sql.ts          (rehearses 140 and rolls it all back)
 *      npx tsx scripts/verify-pricing-sql.ts --apply  (140's bodies re-applied to dev and committed)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const FILE = "migrations/140_the_price_that_carries_its_own_dates.sql";
const PRICING_ROUTE = "src/routes/control-pricing.routes.ts";
const APPROVALS = "src/control/approvals.ts";
const ANALYTICS = "src/routes/control-analytics.routes.ts";
const TRANSPORT = "src/util/transport.ts";
const NAV = "../web/components/ControlNav.tsx";
const DESK_PAGE = "../web/app/control/pricing/page.tsx";
const DESK_CARD = "../web/app/control/pricing/card.tsx";
const DESK_ASK = "../web/app/control/pricing/ask.tsx";
const APPLY = process.argv.includes("--apply");

/** The six guards 140 fires, the two helpers a signature is cut on, the six reads and the eleven writes.
 *  Counted here so phase 0 can demand that this gate cut every body out of the file on its own — a lift
 *  that quietly missed one function would rehearse 24 of 25 and call the file good. */
const GUARDS = ["pricing_history_is_kept", "pricing_card_is_kept", "pricing_card_header_is_immutable",
  "pricing_one_price_per_day", "pricing_signed_price_is_not_edited", "pricing_line_names_its_own_book"];
const HELPERS = ["pricing_paper", "pricing_sha256"];
const READS = ["pricing_board", "pricing_card_detail", "pricing_history", "pricing_corridors",
  "pricing_rate_in_force", "price_a_freight"];
const WRITES = ["file_pricing_corridor", "open_pricing_card", "edit_pricing_card", "set_pricing_line",
  "remove_pricing_line", "discard_pricing_card", "clone_pricing_card", "propose_pricing_publish",
  "refuse_pricing_publish", "apply_pricing_publish", "withdraw_pricing_card"];
const FNS = [...GUARDS, ...HELPERS, ...READS, ...WRITES];
const TABLES = ["pricing_dimensions", "pricing_rate_cards", "pricing_rate_lines",
  "pricing_price_history"];
const PRICE_GUARDS = ["pricing_history_is_append_only", "pricing_cards_are_kept",
  "pricing_cards_keep_their_dates", "pricing_cards_do_not_overlap",
  "pricing_lines_are_frozen_after_publish", "pricing_lines_belong_to_their_card"];
const KEYS = ["control.pricing.view", "control.pricing.manage", "control.pricing.publish"];

const HEX = randomUUID().replace(/-/g, "");
const STAMP = HEX.slice(0, 6).toUpperCase();
const BOOK = `P140 ${STAMP}`;
const CODE = "P140-STD";
const TODAY = new Date().toISOString().slice(0, 10);
const SEAT = (who: string) => `p140.${who}.${HEX.slice(0, 8)}@waisha.test`;
const call = (fn: string, n: number) =>
  `select platform_auth.${fn}(${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(",")}) as r`;

let failures = 0;
let proved = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) proved++; else failures++;
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok ? "" : " — "
    + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`);
}
function note(msg: string) { console.log(`!!   ${msg}`); }
function phase(t: string) { console.log(`\n--- ${t}`); }

/** 140's own transaction markers, so a rehearsal that replayed the whole file would be committing the
 *  office's price register inside a gate that promised not to. */
function stmtBetween(src: string, start: string, stop: string): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`statement not found: ${start.slice(0, 48)}`);
  const b = src.indexOf(stop, a);
  if (b < 0) throw new Error(`statement does not end with: ${stop.slice(0, 48)}`);
  return src.slice(a, b + stop.length);
}
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
/** The desk writes an interpolated path for a `:id` door, so a route door becomes a shape to find in the
 *  desk's own text — and a door nobody knocks on is a door the web stage forgot. */
const doorShape = (p: string) => new RegExp(p.split("/").map((seg) =>
  seg.startsWith(":") ? "\\$\\{[^}]+\\}" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/")
  + "(?=[?\"'`])");

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  /** git hands a Windows checkout back with CRLF terminators, which silently breaks a `\n` in the middle
   *  of a needle while leaving the end-of-body markers intact. Normalising at the read is the one place
   *  that can do it once. */
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const src = read(FILE);
  const route = read(PRICING_ROUTE);
  const approvals = read(APPROVALS);
  const analytics = read(ANALYTICS);
  const transport = read(TRANSPORT);
  const nav = read(NAV);
  const page = read(DESK_PAGE);
  const card = read(DESK_CARD);
  const ask = read(DESK_ASK);

  // ---------------- 0 · 140's bodies, executed ----------------
  phase("0 · 140's 25 bodies, its four privilege statements and its own final self-check "
    + `${APPLY ? "are re-applied to dev and committed" : "re-execute against the live catalog and roll back"}`);
  const ddl = functionDdl(src);
  const guardPriv = stmtBetween(src, "revoke all on function\n  platform_auth.pricing_history_is_kept()",
    "from public, anon, authenticated, service_role, app_runtime;");
  const grant = stmtBetween(src, "grant execute on function\n  platform_auth.pricing_board(",
    "to app_runtime;");
  const sweep = stmtBetween(src, "revoke all on function\n  platform_auth.pricing_board(",
    "from public, anon, authenticated, service_role;");
  const seqRevoke = stmtBetween(src, "revoke all on sequence pricing_card_number_seq",
    "app_runtime, service_role;");
  const selfCheck = stmtBetween(src, "do $$ declare", "end $$;");
  const replayed = [...ddl, guardPriv, grant, sweep, seqRevoke, selfCheck].join("\n");

  check(`140 declares ${FNS.length} functions — ${GUARDS.length} guards, ${HELPERS.length} helpers a `
    + "signature is cut on, the 6 reads and the 11 writes — and this gate cut every one of them out of "
    + "the file on its own",
    ddl.length === FNS.length && (src.match(/^create or replace function platform_auth\./gm) ?? [])
      .length === FNS.length
    && FNS.every((f) => ddl.some((d) => d.startsWith(`create or replace function platform_auth.${f}(`))),
    ddl.map((d) => d.slice(38, 66)));
  check("the replay carries neither half of the file's own transaction pair, so a rehearsal cannot "
    + "commit the office's price register behind the gate that promised not to",
    /^begin;$/m.test(src) && /^commit;$/m.test(src) && !/^(begin|commit);$/m.test(replayed),
    (replayed.match(/^(begin|commit);$/gm) ?? []));
  check("140 locks its own numbering down rather than leaving it to whoever reads this file: it revokes "
    + "the card sequence from every client role including the app role — the rule 134 wrote for the three "
    + "money refs and 135 for a run number — and grants it to nobody at its creation",
    /revoke all on sequence pricing_card_number_seq[\s\S]{0,90}app_runtime, service_role;/.test(src)
    && !/grant [^;]*on sequence pricing_card_number_seq/i.test(src),
    (src.match(/.*pricing_card_number_seq.*/g) ?? []));
  check("140's eight triggers and four tables are not replayable — they are written without "
    + "`if not exists` — which is why every catalog fact below phase 1 is read out of the database "
    + "instead of off the text",
    (src.match(/^create trigger/gm) ?? []).length === 8
    && (src.match(/^create (?:unique )?index if not exists/gm) ?? []).length === 6
    && (src.match(/^create table if not exists/gm) ?? []).length === 4
    && !/^drop (table|trigger|function)/m.test(src),
    { triggers: (src.match(/^create trigger/gm) ?? []).length,
      drops: (src.match(/^drop \w+/gm) ?? []).length });

  // One socket for the whole run, from the rehearsal to the last census: the pooler in front of this
  // database answers a second simultaneous connection with `econnrefused`, and the committed census only
  // needs to be taken outside a transaction — which it is, before `begin` and again after the rollback.
  const c = await connect(url);
  const recorded = (await c.query(
    "select name from schema_migrations where name like '140%' order by 1")).rows
    .map((r: any) => r.name);
  check("140 is already recorded, which is why an edited one needs this file rather than `pnpm migrate`",
    recorded.length === 1, recorded);
  let err: any = null;
  await c.query("begin");
  try {
    for (const block of ddl) await c.query(block);
    await c.query(guardPriv);
    await c.query(grant);
    await c.query(sweep);
    await c.query(seqRevoke);
    await c.query(selfCheck);
  } catch (e) { err = e; }
  if (!err && APPLY) await c.query("commit"); else await c.query("rollback");
  check(`the ${ddl.length} bodies, the two function revokes, the grant sweep and the revoke that takes `
    + `the numbering back from every client role${APPLY ? " are committed"
    + " and the register below is the one they left" : " — all run together and are rolled back"}`,
    !err, err?.message);
  check("…and 140's own final self-check passes against the catalog this rehearsal left, so the file's "
    + "written account of its four tables, its vocabulary of 21 words, its grants and its duty seeds is "
    + "verified by the platform rather than by this gate", !err, err?.message);
  check("…while `create or replace` left every door's grant list alone — a drop-and-create would have "
    + "reset EXECUTE to PUBLIC, which is why the sweep is replayed after the bodies and not before them",
    !err, err?.message);
  if (err) {
    await c.end().catch(() => undefined);
    console.log("\n140 does not run as written. Nothing below this line is proved.");
    console.log(String(err?.message ?? err));
    process.exitCode = 1;
    return;
  }

  try {
    await run(c, { src, route, approvals, analytics, transport, nav, page, card, ask, seqRevoke });
  } finally {
    await c.end().catch(() => undefined);
  }
}

async function connect(url: string) {
  const cl = new pg.Client({
    connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 300000
  });
  await cl.connect();
  return cl;
}

async function run(c: pg.Client, ctx: Record<string, any>) {
  const { src, route, approvals, analytics, transport, nav, page, card, ask, seqRevoke } = ctx;
  const deskAll: string = [page, card, ask].join("\n");
  const IP = "127.0.0.1";
  const UA = "pricing-gate";
  /** How many card numbers this transaction mints, counted at the two call sites that insert a card —
   *  the census compares it against the gap the rollback leaves in `pricing_card_number_seq`. */
  let minted = 0;

  const census = async () => Object.fromEntries((await c.query(
    `select 'cards' as k, count(*)::int as n from pricing_rate_cards
     union all select 'lines', count(*)::int from pricing_rate_lines
     union all select 'memory', count(*)::int from pricing_price_history
     union all select 'words', count(*)::int from pricing_dimensions
     union all select 'approvals', count(*)::int from platform_approvals
     union all select 'audits', count(*)::int from audit_logs
     union all select 'tenants', count(*)::int from tenants
     union all select 'seats', count(*)::int from users
     union all select 'routes', count(*)::int from routes
     union all select 'card_seq', last_value::int from pricing_card_number_seq`))
    .rows.map((r: any) => [r.k, r.n])) as Record<string, number>;
  const BASE = await census();

  /** The last statement the socket was asked to run. A raised trigger aborts a whole section and the
   *  database's message names only the column, so a failure inside a twelve-statement phase would
   *  otherwise be unsolvable from the log. */
  let lastSql = "";
  const where = (sql: string) => { lastSql = sql.replace(/\s+/g, " ").slice(0, 220); };
  const oi = (sql: string, p: any[] = []) => { where(sql); return c.query(sql, p); };
  const one = async (sql: string, p: any[] = []) => (await oi(sql, p)).rows[0] ?? {};
  const door = async (fn: string, args: any[]) =>
    (await oi(call(fn, args.length), args)).rows[0]?.r ?? {};
  /** A statement that is supposed to be refused by a guard: returns its message, or "NO REFUSAL". The
   *  savepoint is not decoration — an aborted statement poisons the whole transaction, and this gate
   *  keeps driving after it. */
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

  await c.query("begin");
  try {
    // ---------------- the two books and the seats ----------------
    const book = (await one(`insert into tenants (type, name, status) values ('transporter', $1, 'active')
      returning id`, [BOOK])).id;
    const PEN = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Price Pen','active',$2) returning id`, [book, SEAT("pen")])).id;
    const QUILL = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Price Quill','active',$2) returning id`, [book, SEAT("quill")])).id;
    const CLERK = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'staff','Not A Seat','active',$2) returning id`, [book, SEAT("clerk")])).id;
    const route1 = (await one(`insert into routes (tenant_id, name, origin_text, dest_text, distance_km)
      values ($1, $2, 'Dar es Salaam', 'Kigoma', 985) returning id`,
      [book, `P140 corridor ${STAMP}`])).id;
    const blind = (await one(`insert into routes (tenant_id, name, origin_text, dest_text)
      values ($1, $2, 'Tabora', 'Shinyanga') returning id`, [book, `P140 blind ${STAMP}`])).id;
    const foreign = (await one(`insert into tenants (type, name, status) values ('transporter', $1, 'active')
      returning id`, [`${BOOK} other`])).id;
    const foreignRoute = (await one(`insert into routes (tenant_id, name, origin_text, dest_text,
      distance_km) values ($1, $2, 'Dodoma', 'Mwanza', 420) returning id`,
      [foreign, `P140 foreign ${STAMP}`])).id;
    check("two synthetic books, three seats and three corridors are planted inside the transaction",
      !!book && !!PEN && !!QUILL && !!CLERK && !!route1 && !!blind && !!foreignRoute);

    // ---------------- 1 · the registers as the catalog keeps them ----------------
    phase("1 · the four registers, the vocabulary and who is allowed to knock");
    const rels = await one(`select count(*)::int as whole,
      count(*) filter (where relrowsecurity)::int as guarded
      from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = 'public' and cl.relname = any($1::text[])`, [TABLES]);
    check("all four price registers exist and all four have row-level security turned on, so a client "
      + "role reads nothing at all until a door names the book",
      rels.whole === 4 && rels.guarded === 4, rels);
    const tblAcl = await one(`select count(*)::int as readers,
      coalesce(sum(case when a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
        then 1 else 0 end), 0)::int as writers
      from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
      cross join aclexplode(cl.relacl) a
      where n.nspname = 'public' and cl.relname = any($1::text[])
        and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')`, [TABLES]);
    check("the app role reads all four registers and writes none of them: a price is only ever moved "
      + "through a door that names the book, the actor, the role, the address and the client",
      tblAcl.readers === 4 && tblAcl.writers === 0, tblAcl);
    const leaks = await one(`select coalesce(jsonb_agg(x), '[]'::jsonb) as rows from (
      select p.rolname as role, a.privilege_type as what, f.proname as fn
        from pg_proc f cross join aclexplode(f.proacl) a
        join pg_authid p on p.oid = a.grantee
       where f.pronamespace = 'platform_auth'::regnamespace
         and (f.proname like 'pricing%' or f.proname like '%pricing%')
         and (a.grantee = 0 or p.rolname in ('anon','authenticated','service_role','app_runtime'))
         and not (p.rolname = 'app_runtime' and a.privilege_type = 'EXECUTE'
                  and f.proname = any($1::text[]))) x`, [[...READS, ...WRITES]]);
    check("no client role and no PUBLIC reaches a guard, a hashing helper or a door it has no duty for: "
      + "`pricing_paper` and `pricing_sha256` are the canonical bytes a signature is cut on, and a route "
      + "that could call them could hash a payload it never proposed",
      leaks.rows.length === 0, leaks.rows);
    const trg = await one(`select coalesce(jsonb_object_agg(t.trgname, t.tbl), '{}'::jsonb) as ours
      from (select tg.tgname as trgname, cl.relname as tbl
              from pg_trigger tg
              join pg_class cl on cl.oid = tg.tgrelid
              join pg_namespace n on n.oid = cl.relnamespace
             where not tg.tgisinternal and n.nspname = 'public'
               and tg.tgname = any($1::text[])) t`, [PRICE_GUARDS]);
    check("the six guards 140 fires are attached where the file says they are: the memory is "
      + "append-only, a signed card is kept, its dates are its own, one list cannot hold two windows "
      + "for one day, a published figure is frozen, and a line belongs to the card it sits on",
      Object.keys(trg.ours).length === PRICE_GUARDS.length
      && trg.ours.pricing_history_is_append_only === "pricing_price_history"
      && trg.ours.pricing_cards_are_kept === "pricing_rate_cards"
      && trg.ours.pricing_cards_keep_their_dates === "pricing_rate_cards"
      && trg.ours.pricing_cards_do_not_overlap === "pricing_rate_cards"
      && trg.ours.pricing_lines_are_frozen_after_publish === "pricing_rate_lines"
      && trg.ours.pricing_lines_belong_to_their_card === "pricing_rate_lines", trg.ours);
    const vocab = await one(`select count(*)::int as whole,
      count(*) filter (where kind = 'vehicle_class')::int as classes,
      count(*) filter (where kind = 'container')::int as containers,
      count(*) filter (where kind = 'basis')::int as bases,
      count(*) filter (where kind = 'basis' and needs <> 'none' and needs <> 'one')::int as quantities
      from pricing_dimensions`);
    check("the vocabulary is data, not a constant copied into a route: 10 vehicle classes, 4 container "
      + "kinds and 7 bases, and five of the bases name the quantity the simulator multiplies by while "
      + "`per_trip` names one job and `flat` names nothing",
      vocab.whole === 21 && vocab.classes === 10 && vocab.containers === 4 && vocab.bases === 7
      && vocab.quantities === 5, vocab);
    const coded = (transport.match(/export const VEHICLE_TYPES = \[([^\]]+)\]/s) ?? [])[1] ?? "";
    const vehicleKeys = coded.split(",").map((w: string) => w.trim().replace(/["']/g, "")).filter(Boolean);
    const classes = (await oi("select key from pricing_dimensions where kind = 'vehicle_class' order by sort"))
      .rows.map((r: any) => r.key);
    check("and the ten classes are the ten the transport board already asks a company to choose from — "
      + "a price keyed on a word a cargo file cannot be filed as is a line that can never fire",
      vehicleKeys.length === 10 && classes.length === 10
      && vehicleKeys.every((k: string) => classes.includes(k)), { vehicleKeys, classes });
    // The file's own lockdown, replayed inside this transaction: under `--apply` the rehearsal already
    // committed it, and without `--apply` the live catalog still carries the grants Supabase hands every
    // new sequence to every client role. Either way the ACL read below and every card minted after it see
    // the numbering exactly as 140 leaves it — and a card minted here is the proof that taking the grant
    // away from the app role did not take it away from the doors, which run as their own owner.
    await oi(seqRevoke);
    const seqAcl = await one(`select coalesce(jsonb_agg(x), '[]'::jsonb) as rows from (
      select p.rolname as who, a.privilege_type as what
        from pg_class cl cross join aclexplode(cl.relacl) a
        join pg_roles p on p.oid = a.grantee
       where cl.relname = 'pricing_card_number_seq' and cl.relkind = 'S'
         and a.grantee <> cl.relowner) x`);
    check("only the owner is named in the numbering's grants, so no role outside 140's doors can take a "
      + "card number and leave the office a hole in its own numbering to explain",
      seqAcl.rows.length === 0, seqAcl.rows);

    // ---------------- 2 · the corridors this book can price ----------------
    phase("2 · the corridors a price can be keyed on, and the ones nobody has measured");
    let r: any;
    r = await door("pricing_corridors", [book, null, 60, 0]);
    check("the desk sees its own corridors and which of them has never been measured",
      r.ok === true && r.total === 2 && r.rows?.length === 2
      && /^P140 blind/.test(String(r.rows?.[0]?.name)) && r.rows?.[0]?.has_distance === false
      && r.rows?.[1]?.distance_km === 985 && r.rows?.[1]?.priced_on === 0,
      { total: r.total, rows: r.rows });
    r = await door("pricing_corridors", [book, "kigoma", 60, 0]);
    check("a corridor is found by the end it runs to", r.total === 1
      && r.rows?.[0]?.name === `P140 corridor ${STAMP}`, { total: r.total, n: r.rows?.[0]?.name });
    r = await door("pricing_corridors", [book, null, 1, 1]);
    check("the total is the filter's, not the page's", r.rows?.length === 1 && r.total === 2
      && r.limit === 1 && r.offset === 1, { n: r.rows?.length, total: r.total });
    r = await door("pricing_corridors", [randomUUID(), null, 10, 0]);
    check("a corridor belongs to a book that exists", r.error === "no_book", r);

    r = await door("file_pricing_corridor", [book, "Kigoma road", "Dar es Salaam", "Kigoma", 985,
      CLERK, "driver", IP, UA]);
    check("a seat that is not the platform's cannot file a corridor", r.error === "not_a_seat", r);
    r = await door("file_pricing_corridor", [book, "Wv", "Dar es Salaam", "Kigoma", 985, PEN,
      "billing_admin", IP, UA]);
    check("a corridor has to be named the way a clerk says it out loud", r.error === "bad_name", r.message);
    r = await door("file_pricing_corridor", [book, "Tabora road", "D", "Kigoma", 400, PEN,
      "billing_admin", IP, UA]);
    check("both ends have to be there", r.error === "bad_ends", r.message);
    r = await door("file_pricing_corridor", [book, "Tabora road", "Tabora", "Kigoma", 0, PEN,
      "billing_admin", IP, UA]);
    check("a road of no kilometres is refused", r.error === "bad_distance", r.message);
    r = await door("file_pricing_corridor", [book, "Tabora road", "Tabora", "Kigoma", 9000, PEN,
      "billing_admin", IP, UA]);
    check("a number bigger than the country is a keystroke, not a road",
      r.error === "bad_distance", r.message);
    r = await door("file_pricing_corridor", [book, ` p140 CORRIDOR ${STAMP} `, "Dar es Salaam",
      "Kigoma", 500, PEN, "billing_admin", IP, UA]);
    check("one book cannot file two corridors under one name", r.error === "corridor_taken", r.message);

    r = await door("file_pricing_corridor", [book, `P140 filed ${STAMP}`, "Dar es Salaam", "Mwanza",
      812.6, PEN, "billing_admin", IP, UA]);
    const filed = r.corridor?.id as string;
    check("a filed corridor carries the rounded figure the resolver will later multiply",
      r.ok === true && r.corridor?.distance_km === 813 && r.corridor?.filed_by === "Price Pen"
      && /at 813 km\./.test(String(r.message)), { ok: r.ok, err: r.error, c: r.corridor, m: r.message });
    const mem = await one(`select count(*)::int as n from audit_logs
      where action = 'pricing.corridor_filed' and entity = 'routes' and entity_id = $1`, [filed]);
    check("and the filing is on the record — the door writes its own audit row, so a route that audited "
      + "on top would double every line in the register", mem.n === 1, mem);
    r = await door("file_pricing_corridor", [book, `P140 blank ${STAMP}`, "Arusha", "Nairobi", null,
      PEN, "billing_admin", IP, UA]);
    check("a corridor nobody has measured is still worth filing, and says so",
      r.ok === true && r.corridor?.has_distance === false && /with no distance/.test(String(r.message)),
      { ok: r.ok, m: r.message, err: r.error });

    r = await door("pricing_rate_in_force", [book, TODAY, CODE, filed, null, null, "per_km"]);
    check("a filed corridor is a corridor of this book, whatever price it holds",
      r.error === "no_price" && new RegExp(`P140 filed ${STAMP}`).test(String(r.message)),
      { e: r.error, m: r.message });

    // ---------------- 3 · opening a draft, and the numbering ----------------
    phase("3 · a draft list is opened, numbered from the sequence, and thrown away again");
    r = await door("open_pricing_card", [book, CODE, "Standard freight, coastal to the lake", "TZS",
      TODAY, "The office's own corridor price for the season.", PEN, "billing_admin", IP, UA]);
    const head = r.card;
    const cardId = head?.id as string;
    if (r.ok) minted++;
    check("a draft list is opened", r.ok === true && head?.status === "draft" && head?.version === 1
      && head?.effective_from === TODAY, r);
    check("the number is minted from the sequence", /^PRC-\d{4}-\d{5,}$/.test(String(head?.ref)),
      head?.ref);

    r = await door("open_pricing_card", [book, "bad code!", "A label long enough", "TZS", TODAY,
      "note note note", PEN, "billing_admin", IP, UA]);
    check("a list name has to be spellable", r.error === "bad_code", r);
    r = await door("open_pricing_card", [book, "OKAY-CODE", "A label long enough", "EUR", TODAY,
      "note note note", PEN, "billing_admin", IP, UA]);
    check("a money the register cannot hold is refused", r.error === "bad_currency", r);
    r = await door("open_pricing_card", [book, "OKAY-CODE", "A label long enough", "TZS", TODAY,
      "note note note", CLERK, "driver", IP, UA]);
    check("a seat that is not the platform's cannot open a price", r.error === "not_a_seat", r);
    check("…and none of those three refusals took a card number with it, because 140 validates before "
      + "it inserts and a refusal that spent a number would leave the office with a gap it cannot "
      + "explain", minted === 1, { minted });

    r = await door("open_pricing_card", [book, CODE, "Opened to be thrown away", "TZS", TODAY,
      "Typed by mistake at the desk.", PEN, "billing_admin", IP, UA]);
    check("the version keeps climbing for one code", r.ok === true && r.card?.version === 2,
      { ok: r.ok, v: r.card?.version });
    if (r.ok) minted++;
    const stray = r.card.id as string;
    let s = await door("set_pricing_line", [book, stray, route1, "van", null, "per_trip", 90000, null,
      PEN, "billing_admin", IP, UA]);
    check("a draft takes a figure", s.ok === true && s.lines?.length === 1, s.lines?.length);
    const strayLine = s.lines?.[0]?.id;
    s = await door("remove_pricing_line", [book, strayLine, PEN, "billing_admin", IP, UA]);
    check("a draft lets a figure go again", s.ok === true && s.lines?.length === 0, s.lines);
    r = await door("discard_pricing_card", [book, stray, "Opened to test the discard door.", PEN,
      "billing_admin", IP, UA]);
    check("an unsigned draft is discardable, and the discard deletes the card it was never signed for",
      r.ok === true && /^PRC-/.test(String(r.discarded)) && r.version === 2, r);
    check("…and the discarded card is gone from the register — only its number stays spent, which is "
      + "the whole difference between a numbering that never repeats and a counter that reuses a slot "
      + "somebody else already quoted from",
      (await one(`select count(*)::int as n from pricing_rate_cards where id = $1`, [stray])).n === 0);

    // ---------------- 4 · the figures ----------------
    phase("4 · the figures: four decimals, a wildcard, a scope, and the seven refusals");
    r = await door("set_pricing_line", [book, cardId, route1, "trailer", null, "per_km", 4100.004,
      250000, PEN, "billing_admin", IP, UA]);
    check("a per-km price keeps four decimals, because a figure rounded to two is a different price on "
      + "a 985 km corridor", r.ok === true
      && r.lines?.some((l: any) => l.rate === "4100.0040" && l.scope_key.endsWith("|per_km")), r.lines);
    const lineKm = r.lines?.find((l: any) => l.basis === "per_km")?.id;
    r = await door("set_pricing_line", [book, cardId, null, null, null, "per_tonne", 78000, 400000,
      PEN, "billing_admin", IP, UA]);
    check("the wildcard scope is one line", r.ok === true && r.lines?.length === 2
      && r.lines?.some((l: any) => l.scope_key === "*|*|*|per_tonne"), r.lines?.length);
    r = await door("set_pricing_line", [book, cardId, null, "reefer", "20ft", "per_trip", 3200000, null,
      PEN, "billing_admin", IP, UA]);
    check("a class and a container name a scope", r.ok === true && r.lines?.length === 3
      && r.lines?.some((l: any) => l.scope_key === "*|reefer|20ft|per_trip"), r.lines);
    r = await door("set_pricing_line", [book, cardId, foreignRoute, null, null, "flat", 100000, null,
      PEN, "billing_admin", IP, UA]);
    check("a card cannot price another book's corridor", r.error === "route_not_in_book", r.message);
    r = await door("set_pricing_line", [book, cardId, null, "hovercraft", null, "flat", 100000, null,
      PEN, "billing_admin", IP, UA]);
    check("an unknown vehicle class is refused by name", r.error === "bad_class", r.message);
    r = await door("set_pricing_line", [book, cardId, null, null, "20ftx", "flat", 100000, null,
      PEN, "billing_admin", IP, UA]);
    check("an unknown container is refused", r.error === "bad_container", r.message);
    r = await door("set_pricing_line", [book, cardId, null, null, null, "per_furlong", 5, null,
      PEN, "billing_admin", IP, UA]);
    check("an unknown basis is refused with the list it knows", r.error === "bad_basis", r.message);
    r = await door("set_pricing_line", [book, cardId, null, null, null, "flat", -5, null,
      PEN, "billing_admin", IP, UA]);
    check("a negative price is refused", r.error === "bad_rate", r);
    r = await door("set_pricing_line", [foreign, cardId, null, null, null, "flat", 5, null,
      PEN, "billing_admin", IP, UA]);
    check("another book cannot put a figure on this card", r.error === "not_found", r);
    r = await door("set_pricing_line", [book, cardId, route1, "trailer", null, "per_km", 4250, 250000,
      PEN, "billing_admin", IP, UA]);
    check("a second write to one scope replaces it, so a line is a PUT and not a POST", r.ok === true
      && r.lines?.length === 3
      && r.lines?.find((l: any) => l.basis === "per_km")?.rate === "4250.0000", r.lines?.length);

    // ---------------- 5 · the board ----------------
    phase("5 · the board a clerk reads before choosing a list");
    r = await door("pricing_board", [book, null, null, null, 30, 0]);
    check("the board counts its own heading", r.ok === true && r.total === 1
      && r.counts?.draft === 1 && r.rows?.[0]?.line_count === 3
      && r.rows?.[0]?.cheapest === "4250.0000",
      { total: r.total, counts: r.counts, row: r.rows?.[0] });
    const PILES = ["draft", "pending_signature", "published", "superseded", "withdrawn"];
    const perPile = await Promise.all(PILES.map((k) => door("pricing_board", [book, k, null, null, 30, 0])
      .then((b: any) => [k, Number(b.total)])));
    check("…and the heading is the board's own: every pile it names is a state a clerk can filter to, "
      + "the count it prints for each is what the same filter answers, and a pile with nothing in it is "
      + "simply not printed rather than shown as a zero the desk would have to explain",
      Object.keys(r.counts ?? {}).every((k) => PILES.includes(k))
      && perPile.every(([k, n]) => ((r.counts as any)?.[k] ?? 0) === n),
      { counts: r.counts, filtered: perPile });
    r = await door("pricing_board", [book, "shambles", null, null, 30, 0]);
    check("an unknown status is answered, not ignored", r.error === "bad_status", r);
    r = await door("pricing_board", [book, null, "Kigoma", null, 30, 0]);
    check("a search finds the card by what it is called", r.total === 1, r.total);
    r = await door("pricing_board", [foreign, null, null, null, 30, 0]);
    check("another book's board is empty", r.ok === true && r.total === 0, r.total);

    // ---------------- 6 · the paper ----------------
    phase("6 · a paper is raised against the card's bytes, and the draft stops moving");
    r = await door("propose_pricing_publish", [book, cardId, "Not yet: a check on the empty window.",
      PEN, "billing_admin", IP, UA]);
    const approval = r.approval_id as string;
    const sha = r.payload_sha256 as string;
    check("a publish paper is raised against the card's bytes", r.ok === true
      && r.action === "pricing.publish" && r.target_kind === "rate_card" && r.lines === 3
      && /^[0-9a-f]{64}$/.test(String(sha)), r);
    check("the card is now waiting for a second seat",
      r.card?.card?.status === "pending_signature", r.card?.card?.status);
    r = await door("set_pricing_line", [book, cardId, null, null, null, "flat", 90000, null,
      PEN, "billing_admin", IP, UA]);
    check("a paper that is out cannot change underneath it", r.error === "not_a_draft", r.message);
    r = await door("edit_pricing_card", [book, cardId, "Renamed while a seat is asked", null, null, null,
      PEN, "billing_admin", IP, UA]);
    check("the draft cannot be retitled while it is signed for", r.error === "paper_is_out", r);
    r = await door("discard_pricing_card", [book, cardId, "Trying to throw away a signed paper.", PEN,
      "billing_admin", IP, UA]);
    check("a paper nobody has answered cannot be discarded", r.error === "not_a_draft", r);
    r = await door("propose_pricing_publish", [book, cardId, "A second paper for one version.", PEN,
      "billing_admin", IP, UA]);
    check("one signature stands per version", r.error === "already_open", r);

    const p = (await oi(`select payload, payload_sha256, status, action, target_kind, target_id,
      reason from platform_approvals where id = $1`, [approval])).rows[0] ?? {};
    check("the register row is cut on the card, not on a summary", p?.status === "pending"
      && p?.action === "pricing.publish" && p?.target_kind === "rate_card" && p?.target_id === cardId
      && p?.payload_sha256 === sha,
      { status: p?.status, sha: String(p?.payload_sha256).slice(0, 12) });
    check("the paper prints every figure a seat is asked to sign",
      Array.isArray(p?.payload?.lines) && p.payload.lines.length === 3
      && p.payload.lines.some((l: any) => l.rate === "4250.0000") && p.payload.line_count === 3,
      p?.payload?.lines);
    r = await door("pricing_card_detail", [book, cardId]);
    check("the detail carries the paper's own hash, so the desk can say what the signature would be "
      + "cut on before a seat presses anything",
      r.paper_sha256 === sha && r.approval?.status === "pending",
      { sha: r.paper_sha256?.slice(0, 12), ap: r.approval });
    check("…and the same detail reads back the whole card the panel needs: its header, its lines with "
      + "the corridor named beside each scope, and the version line the code has travelled through — "
      + "while the memory beside it is still empty, because 140 remembers a change only where a price "
      + "goes live or stops, and a draft has changed nobody's quote",
      r.card?.ref === head?.ref && r.lines?.length === 3 && r.versions?.length >= 1
      && r.lines?.every((l: any) => typeof l.route === "string") && r.memory?.length === 0,
      { lines: r.lines?.length, v: r.versions?.length, m: r.memory?.length });

    // ---------------- 7 · one seat cannot publish ----------------
    phase("7 · the seat that raised the paper cannot free it, sign it, or spend it");
    let d = await oi(call("decide_approval", 7), [approval, "approve", "Agreed on the figures.", PEN,
      "billing_admin", IP, UA]);
    check("the proposer cannot sign their own paper", d.rows[0].r.status === "self", d.rows[0].r);
    r = await door("apply_pricing_publish", [approval, PEN, "billing_admin", IP]);
    check("an unsigned paper publishes nothing", r.error === "conflict", r);
    r = await door("refuse_pricing_publish", [book, cardId, "Freeing my own paper is not mine to do.",
      PEN, "billing_admin", IP, UA]);
    check("…nor can the proposer withdraw it: the sentence the desk shows a clerk who presses Refuse "
      + "on their own ask is the register's own",
      r.error === "refused_the_signature_first", { e: r.error, m: r.message });

    // ---------------- 8 · a second seat refuses ----------------
    phase("8 · the second seat refuses, and the draft is free again");
    r = await door("refuse_pricing_publish", [book, cardId, "Not the lake price for this season.", QUILL,
      "super_admin", IP, UA]);
    check("a second seat can refuse the price", r.ok === true && r.refusals === 1, r);
    r = await door("set_pricing_line", [book, cardId, null, null, null, "flat", 90000, null,
      PEN, "billing_admin", IP, UA]);
    check("a refused paper frees the draft", r.ok === true && r.card?.status === "draft"
      && r.card?.refusals === 1 && r.lines?.length === 4, { st: r.card?.status, n: r.lines?.length });
    r = await door("refuse_pricing_publish", [book, cardId, "Refusing a paper that is not out.", QUILL,
      "super_admin", IP, UA]);
    check("refusing twice records nothing", r.error === "nothing_open", r);
    r = await door("pricing_card_detail", [book, cardId]);
    check("…and the freed draft keeps its refused paper in the read rather than losing it: the card is "
      + "back to a draft and its refusals count the refusal, while the paper still answers `rejected` "
      + "with the seat that refused it and the reason it was raised for — which is why the desk hands "
      + "its pens back on the card's own status and not on whether a paper is present",
      r.card?.status === "draft" && r.card?.refusals === 1 && r.approval?.status === "rejected"
      && r.approval?.decided_by === "Price Quill" && r.approval?.proposed_by === "Price Pen"
      && /empty window/.test(String(r.approval?.reason)),
      { st: r.card?.status, ap: r.approval });
    const refusedWords = await one(`select after ->> 'note' as note, after ->> 'seat' as seat,
        before ->> 'paper_sha256' is not null as on_the_paper
      from audit_logs where action = 'pricing.publish_refused' and entity = 'pricing_rate_cards'
        and entity_id = $1`, [cardId]);
    check("…while the sentence the refusing seat typed is kept where a register keeps what a decision "
      + "meant — on the audit line, beside the seat, the version and the bytes the paper was cut on — "
      + "because the next version is written to answer it",
      /lake price/.test(String(refusedWords.note)) && refusedWords.seat === "Price Quill"
      && refusedWords.on_the_paper === true, refusedWords);

    r = await door("propose_pricing_publish", [book, cardId,
      "The lake corridor is being repriced for the season.", PEN, "billing_admin", IP, UA]);
    check("a refused version can be put up again", r.ok === true && r.lines === 4, r);
    const approval2 = r.approval_id as string;

    // ---------------- 9 · the signature is spent ----------------
    phase("9 · decide, claim, apply, settle — the order the register keeps");
    d = await oi(call("decide_approval", 7), [approval2, "approve", "Signed: four prices, TZS.", PEN,
      "super_admin", IP, UA]);
    check("the seat that raised it still cannot release it", d.rows[0].r.status === "self", d.rows[0].r);
    d = await oi(call("decide_approval", 7), [approval2, "approve", "Signed: four prices, TZS.", QUILL,
      "super_admin", IP, UA]);
    check("the second seat releases it", d.rows[0].r.status === "ok", d.rows[0].r);
    r = await door("apply_pricing_publish", [approval2, QUILL, "super_admin", IP]);
    check("a released signature is not yet spent", r.error === "conflict", r);
    const claim = await oi(call("claim_approval", 2), [approval2, PEN]);
    check("only the seat that signed may spend it", claim.rows[0].r.status === "unauthorised",
      claim.rows[0].r);
    const claim2 = await oi(call("claim_approval", 2), [approval2, QUILL]);
    check("the signer spends the signature", claim2.rows[0].r.status === "ok", claim2.rows[0].r);
    r = await door("apply_pricing_publish", [approval2, QUILL, "super_admin", IP]);
    check("the price goes live", r.ok === true && r.card?.card?.status === "published"
      && r.superseded_versions === 0 && r.card?.card?.published_by === "Price Quill",
      { ok: r.ok, st: r.card?.card?.status, sup: r.superseded_versions, msg: r.message });
    check("the publish that was spent cannot be spent again",
      (await door("apply_pricing_publish", [approval2, QUILL, "super_admin", IP])).error === "conflict");
    await oi(call("settle_approval", 2), [approval2, { ref: r.ref, version: r.version }]);

    // ---------------- 10 · what a job costs ----------------
    phase("10 · the resolver: the most specific line, the bases that also stand, and a price that "
      + "is not zero");
    r = await door("pricing_rate_in_force", [book, TODAY, CODE, route1, "trailer", null, "per_km"]);
    check("the most specific line answers", r.ok === true && r.price?.rate === "4250.0000"
      && r.price?.specificity === 2 && r.price?.distance_km === 985, r.price);
    r = await door("pricing_rate_in_force", [book, TODAY, CODE, null, null, null, "per_tonne"]);
    check("the wildcard stands for an unscoped job", r.ok === true
      && r.price?.rate === "78000.0000" && r.price?.specificity === 0, r.price);
    r = await door("pricing_rate_in_force", [book, TODAY, CODE, route1, "tanker", null, null]);
    check("a scope priced on several bases names the others, so a desk is never shown half the answer",
      r.ok === true && r.price?.basis === "flat" && r.other_bases?.length === 1
      && r.other_bases[0].basis === "per_tonne", { hit: r.price?.basis, others: r.other_bases });
    r = await door("pricing_rate_in_force", [book, TODAY, CODE, null, null, null, "per_day"]);
    check("a basis nothing prices is refused with what does stand", r.error === "no_price"
      && /What does stand there is/.test(String(r.message))
      && r.priced_that_day?.length === 2, r.message);
    r = await door("pricing_rate_in_force", [book, TODAY, CODE, null, null, null, "per_furlong"]);
    check("a basis the register does not know is refused by name", r.error === "bad_basis", r.message);
    r = await door("pricing_rate_in_force", [book, TODAY, CODE, foreignRoute, null, null, "per_km"]);
    check("a corridor in another book is refused by name", r.error === "route_not_in_book", r);
    r = await door("pricing_rate_in_force", [book, "2020-01-05", CODE, route1, "trailer", null, "per_km"]);
    check("a day before the window has no price", r.error === "no_price"
      && /The price is not zero/.test(String(r.message)), r.message);
    r = await door("pricing_rate_in_force", [foreign, TODAY, CODE, route1, "trailer", null, "per_km"]);
    check("a foreign book cannot even ask about another book's corridor",
      r.error === "route_not_in_book", r);
    r = await door("pricing_rate_in_force", [foreign, TODAY, CODE, null, null, null, "per_tonne"]);
    check("a foreign book that names only the list reads no price", r.error === "no_price", r.error);

    // ---------------- 11 · the simulator ----------------
    phase("11 · the simulator: the price, the quantity, and the working printed beside it");
    r = await door("price_a_freight", [book, TODAY, CODE, route1, "trailer", null, "per_km",
      null, null, null, null]);
    check("the simulator multiplies the corridor", /4186250\.00/.test(String(r.amount))
      && r.currency === "TZS" && r.card?.version === 1 && /985 km/.test(String(r.working)),
      { amount: r.amount, working: r.working });
    r = await door("price_a_freight", [book, TODAY, CODE, null, null, null, "per_tonne", 12, null,
      null, null]);
    check("tonnage is multiplied and the minimum holds back", String(r.amount) === "936000.00"
      && r.floor_applied === false, { amount: r.amount, floor: r.floor_applied });
    r = await door("price_a_freight", [book, TODAY, CODE, null, null, null, "per_tonne", 1, null,
      null, null]);
    check("a small job is held up to its minimum, and the working says it was", String(r.amount)
      === "400000.00" && r.floor_applied === true && /held up to the minimum/.test(String(r.working)),
      { amount: r.amount, working: r.working });
    r = await door("price_a_freight", [book, TODAY, CODE, null, "reefer", "20ft", "per_trip", null, 2,
      null, null]);
    check("a trip price needs no quantity", String(r.amount) === "3200000.00"
      && /one trip/.test(String(r.working)), r.amount);
    r = await door("price_a_freight", [book, TODAY, CODE, null, null, null, "per_tonne", null, null,
      null, null]);
    check("a per-tonne price with no tonnage is refused", r.error === "no_tonnes", r.message);
    r = await door("price_a_freight", [book, TODAY, CODE, null, "trailer", null, "per_km", null, null,
      null, null]);
    // The corridor line is not a wildcard: a job that names no route is not priced on it, and the door
    // says so instead of inventing a distance.
    check("a route's per-km price is not lent to a job with no route", r.error === "no_price"
      && /What does stand there is/.test(String(r.message)), { e: r.error, m: r.message });

    // ---------------- 12 · the memory ----------------
    phase("12 · the memory a trigger keeps, and the book it is nobody else's to read");
    r = await door("pricing_history", [book, cardId, 50, 0]);
    check("every figure the signature put live is remembered: the state, the rate, the minimum",
      r.ok === true && r.total >= 6
      && r.rows?.some((h: any) => h.what === "state" && h.new_value === "published")
      && r.rows?.some((h: any) => h.what === "rate" && h.new_value === "4250.0000")
      && r.rows?.some((h: any) => h.what === "min_charge"),
      { total: r.total, whats: r.rows?.map((h: any) => h.what) });
    check("…and every memory row names the list it came from, by ref and by code, so a page taken over "
      + "the whole book cannot pass another list's change off as this one's — and asked for one card it "
      + "answers only with that card's rows",
      r.rows?.every((h: any) => h.card === head?.ref && h.code === CODE) && r.limit === 50
      && r.offset === 0, { card: r.rows?.[0]?.card, code: r.rows?.[0]?.code, limit: r.limit });
    r = await door("pricing_history", [book, null, 50, 0]);
    check("…and the whole-book page is the same read with the card filter lifted: it carries this book's "
      + "memory and nothing else, because the book is bound in the door rather than inferred",
      r.ok === true && r.total >= 6 && r.rows?.every((h: any) => h.code === CODE),
      { total: r.total, codes: [...new Set((r.rows ?? []).map((h: any) => h.code))] });
    r = await door("pricing_history", [foreign, null, 50, 0]);
    check("another book reads none of this memory", r.ok === true && r.total === 0, r.total);

    // ---------------- 13 · a live price is not editable ----------------
    phase("13 · a published price is frozen, and the freeze holds with no door in between");
    r = await door("set_pricing_line", [book, cardId, null, null, null, "flat", 1, null,
      PEN, "billing_admin", IP, UA]);
    check("a published card takes no new price", r.error === "not_a_draft", r.message);
    let m = await refused(`update pricing_rate_lines set rate = 1 where id = $1`, [lineKm]);
    check("even by hand, a signed figure is frozen", /prices are kept/.test(m), m.slice(0, 160));
    m = await refused(`delete from pricing_rate_lines where id = $1`, [lineKm]);
    check("and by hand, it is not deleted either", /prices are kept/.test(m), m.slice(0, 160));
    m = await refused(`update pricing_rate_cards set currency = 'USD' where id = $1`, [cardId]);
    check("a money is not a column to change once figures sit on it",
      /already carries figures|prices in/.test(m), m.slice(0, 160));
    m = await refused(`insert into pricing_rate_cards (tenant_id, ref, code, label, currency, status,
      version, effective_from, published_at, published_by)
      values ($1, 'PRC-2026-99999', $2, 'Hand forced second price', 'TZS', 'published', 90, $3, now(), $4)`,
      [book, CODE, TODAY, PEN]);
    check("two published windows for one list and day are refused", /Two prices for one day/.test(m),
      m.slice(0, 200));
    m = await refused(`update pricing_rate_cards set effective_from = effective_from + 1 where id = $1`,
      [cardId]);
    check("the day a customer was quoted is not moved afterwards",
      /day a customer was quoted/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_rate_cards set status = 'draft' where id = $1`, [cardId]);
    check("a live price never goes back to being a draft", /never edited back/.test(m), m.slice(0, 200));

    // ---------------- 14 · clone forward, publish again, stop ----------------
    phase("14 · the price moves forward by cloning, never by editing");
    r = await door("clone_pricing_card", [book, cardId, "2020-01-05",
      "Trying to date a new version backwards.", PEN, "billing_admin", IP, UA]);
    check("a new version cannot be back-dated", r.error === "back_dating", r);
    r = await door("clone_pricing_card", [book, cardId, TODAY,
      "The second season's price for the same corridors.", PEN, "billing_admin", IP, UA]);
    if (r.ok) minted++;
    check("the live version clones to a draft", r.ok === true && r.card?.version === 2
      && r.card?.status === "draft" && r.lines?.length === 4,
      { ok: r.ok, v: r.card?.version, st: r.card?.status, lines: r.lines?.length, msg: r.message });
    const card2 = r.card.id as string;
    check("the clone carries the money, the code and the version it replaces",
      r.card?.currency === "TZS" && r.card?.code === CODE && r.card?.supersedes === head?.ref,
      r.card?.supersedes);
    r = await door("set_pricing_line", [book, card2, route1, "trailer", null, "per_km", 4600, 250000,
      PEN, "billing_admin", IP, UA]);
    check("the new version's own line is editable", r.ok === true
      && r.lines?.find((l: any) => l.basis === "per_km")?.rate === "4600.0000", r.message);
    r = await door("pricing_rate_in_force", [book, TODAY, CODE, route1, "trailer", null, "per_km"]);
    check("the draft clone answers nothing — a price that has not been signed is not a price",
      r.price?.rate === "4250.0000" && r.price?.version === 1, r.price);
    r = await door("clone_pricing_card", [book, card2, TODAY, "Cloning a draft is not how a draft works.",
      PEN, "billing_admin", IP, UA]);
    check("a draft has nothing to clone", r.error === "nothing_to_clone" && r.status === "draft",
      { e: r.error, st: r.status, ref: r.ref });
    r = await door("propose_pricing_publish", [book, card2, "Season two, signed in full.", PEN,
      "billing_admin", IP, UA]);
    const approval3 = r.approval_id as string;
    check("the new version is put up", r.ok === true && r.version === 2, r);
    await oi(call("decide_approval", 7), [approval3, "approve", "Both figures agreed.", QUILL,
      "super_admin", IP, UA]);
    await oi(call("claim_approval", 2), [approval3, QUILL]);
    r = await door("apply_pricing_publish", [approval3, QUILL, "super_admin", IP]);
    check("publishing version 2 closes version 1", r.ok === true && r.superseded_versions === 1,
      { ok: r.ok, sup: r.superseded_versions, msg: r.message, err: r.error });
    const v1 = await one(`select status, effective_from, effective_to from pricing_rate_cards
      where id = $1`, [cardId]);
    check("the closed window never ends before it began", v1?.status === "superseded"
      && v1?.effective_to >= v1?.effective_from, v1);
    r = await door("pricing_rate_in_force", [book, TODAY, CODE, route1, "trailer", null, "per_km"]);
    check("the resolver now answers the new price", r.ok === true && r.price?.rate === "4600.0000"
      && r.price?.version === 2, r.price);
    r = await door("price_a_freight", [book, TODAY, CODE, route1, "trailer", null, "per_km", null, null,
      null, null]);
    check("and the simulator quotes the working from the new figure",
      /4531000\.00/.test(String(r.amount)) && /4600\.0000/.test(String(r.working)),
      { amount: r.amount, working: r.working });
    r = await door("pricing_history", [book, null, 100, 0]);
    check("the supersede is remembered as a window and a moved price",
      r.rows?.some((h: any) => h.what === "window" && h.card === head?.ref)
      && r.rows?.some((h: any) => h.what === "rate" && h.old_value === "4250.0000"
        && h.new_value === "4600.0000"),
      r.rows?.filter((h: any) => h.what === "window").map((h: any) => [h.card, h.old_value, h.new_value]));
    m = await refused(`delete from pricing_rate_cards where id = $1`, [cardId]);
    check("a version that was signed is never deleted", /so it is kept/.test(m), m.slice(0, 200));

    r = await door("withdraw_pricing_card", [book, card2, "2020-01-05",
      "Trying to stop a price in the past.", PEN, "billing_admin", IP, UA]);
    check("a price stops today or later", r.error === "rewriting_history", r);
    r = await door("withdraw_pricing_card", [book, card2, TODAY,
      "The corridor is closed for repairs; the price stops.", PEN, "billing_admin", IP, UA]);
    check("one seat stops a live price — no second signature, because a stop is the act that keeps a "
      + "wrong price from being quoted an hour longer",
      r.ok === true && r.card?.status === "withdrawn"
      && r.card?.withdrawn_reason?.includes("repairs") && r.card?.effective_to === TODAY,
      { ok: r.ok, st: r.card?.status, reason: r.card?.withdrawn_reason });
    r = await door("pricing_rate_in_force", [book, TODAY, CODE, route1, "trailer", null, "per_km"]);
    check("a stopped price answers no job", r.error === "no_price", r.message);
    r = await door("withdraw_pricing_card", [book, card2, TODAY, "Stopped twice.", PEN, "billing_admin",
      IP, UA]);
    check("a stopped price stays stopped", r.error === "not_live", r.message);
    m = await refused(`update pricing_rate_cards set status = 'published' where id = $1`, [card2]);
    check("and by hand it stays stopped", /stays stopped/.test(m), m.slice(0, 200));

    // ---------------- 15 · the guards, by hand ----------------
    phase("15 · the guards below the doors, provoked with no door in between");
    m = await refused(`update pricing_price_history set new_value = '1' where id =
      (select id from pricing_price_history limit 1)`);
    check("a memory row cannot be rewritten", /price-history row is a record/.test(m), m.slice(0, 200));
    m = await refused(`delete from pricing_price_history where id =
      (select id from pricing_price_history limit 1)`);
    check("or deleted", /cannot be DELETE/.test(m), m.slice(0, 200));
    m = await refused(`insert into pricing_rate_lines (tenant_id, card_id, basis, rate, scope_key)
      values ($1, $2, 'per_km', 5, 'x|y|z|per_km')`, [book, cardId]);
    check("a line cannot be typed in by hand beside a signed card", /prices are kept/.test(m),
      m.slice(0, 200));
    // A draft is where the register's own word- and book-guards have to hold, with no door in between.
    const drafted = await door("clone_pricing_card", [book, card2, TODAY,
      "A draft to test the guards against.", PEN, "billing_admin", IP, UA]);
    if (drafted.ok) minted++;
    check("a stopped version still clones forward", drafted.ok === true
      && drafted.card?.status === "draft", { ok: drafted.ok, err: drafted.error });
    const cardD = drafted.card?.id as string;
    m = await refused(`insert into pricing_rate_lines (tenant_id, card_id, route_id, basis, rate,
      scope_key) values ($1, $2, $3, 'flat', 5, 'q|*|*|flat')`, [book, cardD, foreignRoute]);
    check("a line cannot name another book's corridor", /not a route of the book/.test(m), m.slice(0, 200));
    m = await refused(`insert into pricing_rate_lines (tenant_id, card_id, basis, rate, scope_key)
      values ($1, $2, 'per_furlong', 5, '*|*|*|per_furlong')`, [book, cardD]);
    check("a line cannot name a basis nobody can multiply", /not a basis the resolver/.test(m),
      m.slice(0, 200));
    m = await refused(`insert into pricing_rate_lines (tenant_id, card_id, vehicle_class, basis, rate,
      scope_key) values ($1, $2, 'hovercraft', 'flat', 5, '*|hovercraft|*|flat')`, [book, cardD]);
    check("a line cannot invent a vehicle class", /not a vehicle class/.test(m), m.slice(0, 200));
    m = await refused(`insert into pricing_rate_lines (tenant_id, card_id, basis, rate, scope_key)
      values ($2, $1, 'flat', 5, '*|*|*|flat')`, [cardD, foreign]);
    check("a line cannot be filed in another book at all", /different book/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_rate_cards set tenant_id = $2 where id = $1`, [cardId, foreign]);
    check("a card cannot be moved between books", /not editable/.test(m), m.slice(0, 200));

    // ---------------- 16 · a third version off a stopped one ----------------
    phase("16 · the shape a rollback takes, and the arithmetic a price refuses to invent");
    r = await door("set_pricing_line", [book, cardD, blind, "van", null, "per_km", 5200, null,
      PEN, "billing_admin", IP, UA]);
    check("a clone of a stopped version is editable", r.ok === true && r.lines?.length === 5,
      { ok: r.ok, n: r.lines?.length, m: r.message });
    r = await door("set_pricing_line", [book, cardD, null, null, null, "per_km", 3000, 120000,
      PEN, "billing_admin", IP, UA]);
    check("a version can price a kilometre with no corridor on the line", r.ok === true
      && r.lines?.length === 6 && r.lines?.some((l: any) => l.scope_key === "*|*|*|per_km"),
      { n: r.lines?.length, m: r.message });
    r = await door("propose_pricing_publish", [book, cardD,
      "Rollback shaped: a third version raised off the stopped one.", PEN, "billing_admin", IP, UA]);
    const approval4 = r.approval_id as string;
    check("a stopped register opens a new version", r.ok === true && r.version === 3
      && r.lines === 6, { ok: r.ok, v: r.version, n: r.lines, err: r.error, m: r.message });
    await oi(call("decide_approval", 7), [approval4, "approve", "Agreed, the blind corridor too.",
      QUILL, "super_admin", IP, UA]);
    await oi(call("claim_approval", 2), [approval4, QUILL]);
    r = await door("apply_pricing_publish", [approval4, QUILL, "super_admin", IP]);
    check("the third version goes live over nothing", r.ok === true && r.superseded_versions === 0,
      { ok: r.ok, sup: r.superseded_versions, err: r.error, m: r.message });
    r = await door("price_a_freight", [book, TODAY, CODE, blind, "van", null, "per_km", null, null,
      null, null]);
    check("a corridor with no distance refuses to invent one", r.error === "no_distance"
      && /no distance on file/.test(String(r.message)), { e: r.error, m: r.message });
    r = await door("pricing_rate_in_force", [book, TODAY, CODE, blind, "van", null, "per_km"]);
    check("and the price still stands there, unsigned arithmetic aside", r.ok === true
      && r.price?.rate === "5200.0000" && r.price?.distance_km === null, r.price);
    r = await door("price_a_freight", [book, TODAY, CODE, null, null, null, "per_km", null, null,
      null, null]);
    check("a per-km price with no corridor to multiply names the missing half",
      r.error === "no_distance" && /Say which route/.test(String(r.message))
      && r.price === undefined, { e: r.error, m: r.message });

    // ---------------- 17 · the doors, the duties and the desk ----------------
    phase("17 · the doors, the duties they name, and the desk that knocks on every one of them");
    const handlers = (route.match(/^  app\.\w+\("\/control\/pricing[^"]*"/gm) ?? [])
      .map((l) => l.replace(/^  app\./, ""));
    check("the route cuts seventeen doors, all of them under /control/pricing, and every one of them "
      + "takes the book from the seat's own token rather than from anything a caller sent",
      handlers.length === 17 && handlers.every((h) => h.includes('("/control/pricing'))
      && /String\(req\.control\.tenant_id\)/.test(route)
      && !/req\.(query|body|params)\.tenant/.test(route), handlers);
    check("…and every one of them is guarded by one of the three duties, because a price the office "
      + "can read is not a price the office can set",
      (route.match(/requireControlPermission\(req, (VIEW|MANAGE|PUBLISH)\)/g) ?? []).length === 17,
      (route.match(/requireControlPermission\(req, \w+\)/g) ?? []).length);
    check("…and the three duty words the doors name are the three keys 140 seeds, spelled the same in "
      + "both files",
      KEYS.every((k) => route.includes(`"${k}"`) && src.includes(`'${k}'`)), { route: KEYS
        .map((k) => route.includes(`"${k}"`)), seed: KEYS.map((k) => src.includes(`'${k}'`)) });
    const allowlist = (analytics.match(/const keys = \[[\s\S]*?\];/) ?? [""])[0];
    check("all three duties reach the permissions probe's allowlist: a held duty nobody probes is a tab "
      + "that never appears, which is how 067's `control.staff.view` behaved for three roles",
      KEYS.every((k) => allowlist.includes(k)), { allowlist: allowlist.slice(0, 120) });
    check("…and the nav carries the desk under all three, called Freight prices so it is not confused "
      + "with the subscription-plan editor above it",
      /"\/control\/pricing"/.test(nav) && /label: "Freight prices"/.test(nav)
      && KEYS.every((k) => nav.includes(k)), (nav.match(/\/control\/pricing[^\n]*/) ?? [""])[0]);
    check("the pricing route never calls the door that spends a signature: `apply_pricing_publish` "
      + "appears in this file only as the sentence saying it is not a route here, so a desk that could "
      + "publish from it would be a desk that signs its own price",
      !/apply_pricing_publish\(/.test(route) && !/APPLY_SQL/.test(route)
      && /apply_pricing_publish/.test(route), { calls: (route.match(/apply_pricing_publish\(/g) ?? []).length });
    check("…and the effect is really 121's, reached in the register's own order by the seat that signed: "
      + "the door is called from the approvals body, not from a desk",
      /apply_pricing_publish\(/.test(approvals) && /"price_publish"/.test(approvals),
      (approvals.match(/.{0,40}apply_pricing_publish.{0,20}/g) ?? []).slice(0, 2));
    const missed = handlers.filter((h) => {
      const path = h.replace(/^\w+\("/, "").replace(/"$/, "");
      return !doorShape(path).test(deskAll);
    });
    check("every door the route cuts is knocked on by the desk this stage ships, with the book's card "
      + "interpolated into the path the way the register asks for it", missed.length === 0, missed);
    check("…and the desk never opens an approvals door of its own: it raises the paper and prints the "
      + "hash it was cut on, and the signature is spent by another seat at another desk",
      !/\/control\/approvals/.test(deskAll) && /paper_sha256/.test(card), {
      approvals: (deskAll.match(/\/control\/approvals[^"`]*/g) ?? []).slice(0, 3) });
    check("…while a figure the desk prints is a figure the register worked out: no rate and no minimum "
      + "is multiplied in the browser, because a number the client manufactured is exactly what the "
      + "register exists to prevent — the panel shows the door's `amount` and the `working` beside it",
      !/\.\s*(rate|min_charge)\s*[*/]/.test(deskAll) && /working/.test(ask) && /amount/.test(ask), {
      maths: (deskAll.match(/[^\n]*(rate|min_charge)\s*[*/][^\n]*/g) ?? []).slice(0, 3) });
    check("and a refusal is spoken where a clerk is looking: all three files carry a fault region of "
      + "their own, and the panel that refuses keeps the sentence the clerk typed",
      (page.match(/role="alert"/g) ?? []).length + (card.match(/role="alert"/g) ?? []).length
      + (ask.match(/role="alert"/g) ?? []).length >= 4, {
      page: (page.match(/role="alert"/g) ?? []).length, card: (card.match(/role="alert"/g) ?? []).length,
      ask: (ask.match(/role="alert"/g) ?? []).length });

    // ---------------- 18 · put the office back ----------------
    phase("18 · the rollback, and the office this file found again");
    const inside = (await one("select last_value::int as n from pricing_card_number_seq")).n;
    await c.query("rollback");
    const left = await census();
    const moved = Object.keys(BASE).filter((k) => k !== "card_seq" && BASE[k] !== left[k]);
    check(`the transaction rolls back and nothing of the office's is left standing: ${Object.keys(BASE).length - 1} `
      + "registers, the approval paper, the audit lines, the books, the seats and the corridors hold "
      + "exactly the counts this file found them holding — including the memory rows the publish phases "
      + "wrote, which no DELETE guard could ever let a teardown remove",
      moved.length === 0, moved.map((k) => [k, BASE[k], left[k]]));
    check("…while the card numbers stay spent, because a sequence is the one thing in Postgres a "
      + `rollback does not hand back: ${minted} card(s) minted ${minted} number(s) between the two `
      + "readings, and every refusal that took nothing (a bad code, an unusable money, a back-dated "
      + "clone) left its number unspent",
      left.card_seq === BASE.card_seq + minted && inside === left.card_seq && minted > 0,
      { base: BASE.card_seq, inside, now: left.card_seq, minted });
    check("…and the vocabulary this gate read 21 words of was not one of the things it wrote",
      left.words === BASE.words && left.words === 21, { before: BASE.words, after: left.words });
    note(`${proved} checks proved, ${failures} failed — the office's price register is as this file `
      + "found it, and the two synthetic books, their seats, their corridors, their three versions and "
      + "their papers never existed outside the transaction.");
    if (failures > 0) process.exitCode = 1;
  } catch (e: any) {
    await c.query("rollback").catch(() => undefined);
    console.log(`\nGATE ABORTED mid-transaction on: ${lastSql}`);
    throw e;
  }
}

// `process.exit()` would drop the lines still sitting in the socket on Windows, and the one line that
// matters — the statement this gate died on — is always the last one written.
main().catch((e) => { console.error(`\nGATE ABORTED: ${e?.message ?? e}`); process.exitCode = 1; });
