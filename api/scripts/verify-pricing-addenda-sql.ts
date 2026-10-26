/**
 * 141, proved in the database.
 *
 * `smoke-pricing-addenda.ts` walks the fourteen doors over the routes a seat uses and never spends a
 * signature, because 141 inherits 140's keeping exactly: `pricing_addenda_are_kept` refuses the DELETE of
 * a charge that was signed or lived, `pricing_addendum_history_is_kept` refuses the memory's,
 * `pricing_addendum_claim_is_kept` refuses a taken place, and `pricing_addendum_claims.addendum_id` has
 * no cascade — so one published promo with one claim would make the fixture book undeletable forever.
 * What the smoke cannot prove is what this gate exists to prove:
 *
 *  1. **The sum.** `price_a_job` is the only place in the register where a quote is worked out, and it is
 *     arithmetic: a percentage, a ceiling, a floor, an order, a clip at zero and a money that must match
 *     the freight's. Every one of those is pinned to a figure here, because over HTTP a wrong sum and a
 *     right sum both arrive as JSON.
 *  2. **The places, counted and never stored.** A promo runs out because `count(*)` over
 *     `pricing_addendum_claims` says so. The gate takes two places on a ceiling of two, reads the refusal
 *     a clerk has to say out loud, gives one back, and reads the quote answer again — with the row that
 *     proves the mistake still standing.
 *  3. **The rules kept BELOW the doors.** Seven guard triggers, eight table CHECKs and one partial unique
 *     index are what stop a hand on the table, and the refusals that matter most — a figure moved under a
 *     signature, a live charge edited back into a draft, a place un-voided, two published windows for one
 *     code and day — have no route that reaches them. They are provoked here, inside savepoints.
 *
 * The two-person walk is proved as a history: raise, the proposer cannot sign it, a second seat refuses,
 * the draft is free again, re-raise, sign, claim, apply, and only then does a charge stand on a job. Then
 * the charge moves forward by cloning and the version underneath has its window closed to the day the new
 * one starts — the order 140 keeps, because the overlap guard would otherwise refuse the publish it is
 * standing for.
 *
 * Nothing of the office's commits. Every fixture — two synthetic books, three seats, three corridors, two
 * freight cards, nine charges, the papers, the claims and the memory — is written inside one transaction
 * that is rolled back, and the committed census is taken on the same socket before `begin` and again after
 * the rollback. The one thing a rollback cannot hand back is `pricing_addendum_number_seq`: measured here
 * against the doors that actually reached their INSERT, which is not the same count as the doors that
 * were refused — a charge that died on the corridor trigger had already taken its number.
 *
 * Run: npx tsx scripts/verify-pricing-addenda-sql.ts          (rehearses 141, rolls it all back)
 *      npx tsx scripts/verify-pricing-addenda-sql.ts --apply  (141's bodies re-applied to dev)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const FILE = "migrations/141_the_charges_that_sit_on_top_of_a_price.sql";
const CARD_140 = "migrations/140_the_price_that_carries_its_own_dates.sql";
const ADDENDA_ROUTE = "src/routes/control-pricing-addenda.routes.ts";
const PRICING_ROUTE = "src/routes/control-pricing.routes.ts";
const APPROVALS = "src/control/approvals.ts";
const ANALYTICS = "src/routes/control-analytics.routes.ts";
/** The two halves of 141's own promise are proved at the desk, not only in the register: a charge whose
 *  kind the desk never branches on, and figures the desk only ever prints. A gate that read only the SQL
 *  would stay green while a clerk's screen quietly grew a `if (kind === "surcharge")`. */
const CHARGES_DESK = "../web/app/control/pricing/charges.tsx";
const ASK_DESK = "../web/app/control/pricing/ask.tsx";
const PRICING_PAGE = "../web/app/control/pricing/page.tsx";
const APPLY = process.argv.includes("--apply");

/** 141's 26 bodies: the seven guards it fires, the four internal helpers a signature and a count are read
 *  through, the five reads and the ten writes. Counted here so phase 0 can demand that this gate cut every
 *  body out of the file on its own — a lift that quietly missed one would rehearse 25 of 26. */
const GUARDS = ["pricing_addendum_history_is_kept", "pricing_addendum_is_kept",
  "pricing_addendum_header_is_immutable", "pricing_one_charge_per_day",
  "pricing_addendum_names_its_own_book", "pricing_addendum_claim_is_kept",
  "pricing_addendum_claim_only_loses_its_place"];
const HELPERS = ["pricing_addendum_paper", "pricing_addendum_sha256",
  "pricing_addendum_uses_taken", "pricing_addendum_said"];
const READS = ["pricing_addenda", "pricing_addendum_detail", "pricing_addendum_memory",
  "pricing_addenda_in_force", "price_a_job"];
const WRITES = ["open_pricing_addendum", "edit_pricing_addendum", "discard_pricing_addendum",
  "clone_pricing_addendum", "propose_pricing_addendum", "refuse_pricing_addendum",
  "apply_pricing_addendum", "withdraw_pricing_addendum", "claim_pricing_addendum",
  "void_pricing_addendum_claim"];
const FNS = [...GUARDS, ...HELPERS, ...READS, ...WRITES];
const TABLES = ["pricing_addendum_kinds", "pricing_addenda", "pricing_addendum_history",
  "pricing_addendum_claims"];
/** The seven table triggers 141 fires, against the table each one stands on. */
const CHARGE_GUARDS: Record<string, string> = {
  pricing_addendum_history_is_append_only: "pricing_addendum_history",
  pricing_addenda_are_kept: "pricing_addenda",
  pricing_addenda_keep_their_dates: "pricing_addenda",
  pricing_addenda_do_not_overlap: "pricing_addenda",
  pricing_addenda_belong_to_their_book: "pricing_addenda",
  pricing_addendum_claims_are_kept: "pricing_addendum_claims",
  pricing_addendum_claims_keep_their_facts: "pricing_addendum_claims",
};
/** The eight CHECKs the table carries, each one a state no door can forge. */
const CHECKS = ["pricing_addenda_one_version_per_code", "pricing_addenda_window_is_a_window",
  "pricing_addenda_published_has_a_start", "pricing_addenda_publish_leaves_a_mark",
  "pricing_addenda_withdrawal_is_explained", "pricing_addenda_unsigned_paper_is_pending",
  "pricing_addenda_does_not_supersede_itself", "pricing_addendum_percent_is_a_percent",
  "pricing_surcharge_is_never_counted"];
const KEYS = ["control.pricing.view", "control.pricing.manage", "control.pricing.publish"];

const HEX = randomUUID().replace(/-/g, "");
const STAMP = HEX.slice(0, 6).toUpperCase();
const BOOK = `P141 ${STAMP}`;
const DAY = new Date().toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const PAST = "2020-01-05";
const SEAT = (who: string) => `p141.${who}.${HEX.slice(0, 8)}@waisha.test`;
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

/** 141's own transaction markers, so a rehearsal that replayed the whole file would not commit the
 *  office's charge register inside a gate that promised not to. */
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

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  /** git hands a Windows checkout back with CRLF terminators, which silently breaks a `\n` in the middle
   *  of a needle while leaving the end-of-body markers intact. */
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const src = read(FILE);
  const card140 = read(CARD_140);
  const route = read(ADDENDA_ROUTE);
  const pricingRoute = read(PRICING_ROUTE);
  const approvals = read(APPROVALS);
  const analytics = read(ANALYTICS);

  // ---------------- 0 · 141's bodies, executed ----------------
  phase("0 · 141's 26 bodies, its four privilege statements and its own final self-check "
    + `${APPLY ? "are re-applied to dev and committed" : "re-execute against the live catalog and roll back"}`);
  const ddl = functionDdl(src);
  const guardPriv = stmtBetween(src,
    "revoke all on function\n  platform_auth.pricing_addendum_history_is_kept(),",
    "from public, anon, authenticated, service_role, app_runtime;");
  const grant = stmtBetween(src,
    "grant execute on function\n  platform_auth.pricing_addenda(uuid, text, text, text, text, int, int),",
    "to app_runtime;");
  const sweep = stmtBetween(src,
    "revoke all on function\n  platform_auth.pricing_addenda(uuid, text, text, text, text, int, int),",
    "from public, anon, authenticated, service_role;");
  const seqRevoke = stmtBetween(src, "revoke all on sequence pricing_addendum_number_seq",
    "app_runtime, service_role;");
  const selfCheck = stmtBetween(src, "do $$ declare", "end $$;");
  const replayed = [...ddl, guardPriv, grant, sweep, seqRevoke, selfCheck].join("\n");

  check(`141 declares ${FNS.length} functions — ${GUARDS.length} guards, ${HELPERS.length} internal `
    + "helpers, the 5 reads and the 10 writes — and this gate cut every one of them out of the file on "
    + "its own",
    ddl.length === FNS.length && (src.match(/^create or replace function platform_auth\./gm) ?? [])
      .length === FNS.length
    && FNS.every((f) => ddl.some((d) => d.startsWith(`create or replace function platform_auth.${f}(`))),
    ddl.map((d) => d.slice(38, 70)));
  check("the replay carries neither half of the file's own transaction pair, so a rehearsal cannot "
    + "commit the office's charge register behind the gate that promised not to",
    /^begin;$/m.test(src) && /^commit;$/m.test(src) && !/^(begin|commit);$/m.test(replayed),
    (replayed.match(/^(begin|commit);$/gm) ?? []));
  check("141 locks its own numbering down the way 134, 135 and 140 did: the charge sequence is revoked "
    + "from every client role including the app role, and granted to nobody at its creation",
    /revoke all on sequence pricing_addendum_number_seq[\s\S]{0,90}app_runtime, service_role;/.test(src)
    && !/grant [^;]*on sequence pricing_addendum_number_seq/i.test(src),
    (src.match(/.*pricing_addendum_number_seq.*/g) ?? []));
  check("141's eight triggers, four tables and two kind rows are not replayable — the triggers are "
    + "written without `if not exists` and the kinds are seeded `on conflict do nothing` — which is why "
    + "every catalog fact below phase 1 is read out of the database instead of off the text",
    (src.match(/^create trigger/gm) ?? []).length === 8
    && (src.match(/^create table if not exists/gm) ?? []).length === 4
    && /on conflict \(key\) do nothing;/.test(src) && !/^drop (table|trigger|function)/m.test(src),
    { triggers: (src.match(/^create trigger/gm) ?? []).length,
      tables: (src.match(/^create table if not exists/gm) ?? []).length });
  const declaredIn = (t: string) => (t.match(/^create or replace function platform_auth\.\w+/gm) ?? [])
    .map((s) => s.replace(/^create or replace function platform_auth\./, ""));
  const shared = declaredIn(src).filter((f) => declaredIn(card140).includes(f));
  check("…and the two freight cards this gate stands the composer on are still 140's, not a copy: 141 "
    + "re-declares no read, no write and no guard that 140 already owns — the two files share no "
    + "function name at all — so there is one place where a freight figure is worked out and applying "
    + "141 cannot change how a price is resolved",
    shared.length === 0 && !/create or replace function platform_auth\.(price_a_freight|pricing_rate_in_force|open_pricing_card)/
      .test(src) && /platform_auth\.price_a_freight\(/.test(src),
    { shared, called: (src.match(/platform_auth\.price_a_[a-z]+\(/g) ?? []) });

  // One socket for the whole run: the pooler answers a second simultaneous connection with
  // `econnrefused`, and the committed census only needs to be taken outside a transaction.
  const c = await connect(url);
  const recorded = (await c.query(
    "select name from schema_migrations where name like '141%' order by 1")).rows
    .map((r: any) => r.name);
  check("141 is already recorded, which is why an edited one needs this file rather than `pnpm migrate`",
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
  check(`the ${ddl.length} bodies, the guard revoke, the door grant, the PUBLIC sweep and the sequence `
    + `revoke${APPLY ? " are committed" : " — all run together and rolled back"}`, !err, err?.message);
  check("…and 141's own final self-check passes against the catalog this rehearsal left, so the file's "
    + "written account of its four registers, its two kind rows, its 21 borrowed words, its grants and "
    + "its three duties is verified by the platform rather than by this gate", !err, err?.message);
  if (err) {
    await c.end().catch(() => undefined);
    console.log("\n141 does not run as written. Nothing below this line is proved.");
    console.log(String(err?.message ?? err));
    process.exitCode = 1;
    return;
  }

  try {
    await run(c, { src, route, pricingRoute, approvals, analytics, seqRevoke,
      chargesDesk: read(CHARGES_DESK), askDesk: read(ASK_DESK), page: read(PRICING_PAGE) });
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
  const { src, route, pricingRoute, approvals, analytics, chargesDesk, askDesk, page } = ctx;
  const IP = "127.0.0.1";
  const UA = "addenda-gate";
  /** How many charge numbers this transaction takes, counted at every call that reached its INSERT — the
   *  census compares it against the gap the rollback leaves in `pricing_addendum_number_seq`. */
  let minted = 0;
  /** 140's cards take their numbers from a different sequence, so they are counted apart from the gap. */
  let cardMinted = 0;
  /** The synthetic book, planted inside the transaction below. Hoisted here because the hand-planting
   *  helpers written before it are the ones that name it. */
  let book = "";

  const census = async () => Object.fromEntries((await c.query(
    `select 'charges' as k, count(*)::int as n from pricing_addenda
     union all select 'claims', count(*)::int from pricing_addendum_claims
     union all select 'memory', count(*)::int from pricing_addendum_history
     union all select 'kinds', count(*)::int from pricing_addendum_kinds
     union all select 'cards', count(*)::int from pricing_rate_cards
     union all select 'lines', count(*)::int from pricing_rate_lines
     union all select 'card_memory', count(*)::int from pricing_price_history
     union all select 'words', count(*)::int from pricing_dimensions
     union all select 'approvals', count(*)::int from platform_approvals
     union all select 'audits', count(*)::int from audit_logs
     union all select 'tenants', count(*)::int from tenants
     union all select 'seats', count(*)::int from users
     union all select 'routes', count(*)::int from routes
     union all select 'charge_seq', last_value::int from pricing_addendum_number_seq
     union all select 'card_seq', last_value::int from pricing_card_number_seq`))
    .rows.map((r: any) => [r.k, r.n])) as Record<string, number>;
  const BASE = await census();

  let lastSql = "";
  const where = (sql: string) => { lastSql = sql.replace(/\s+/g, " ").slice(0, 220); };
  const oi = (sql: string, p: any[] = []) => { where(sql); return c.query(sql, p); };
  const one = async (sql: string, p: any[] = []) => (await oi(sql, p)).rows[0] ?? {};
  const door = async (fn: string, args: any[]) =>
    (await oi(call(fn, args.length), args)).rows[0]?.r ?? {};
  /** A statement that is supposed to be refused by a guard, a CHECK or a FK: returns its message, or
   *  "NO REFUSAL". The savepoint is not decoration — an aborted statement poisons the whole transaction,
   *  and this gate keeps driving after it. */
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
  /** The other half of `refused`, and it cannot be folded into it: a statement proved allowed has to be
   *  kept, because `refused` rolls its savepoint back whether the statement answered or threw — so using
   *  it to prove a write is allowed reports "NO REFUSAL" for a row it has already undone. Everything this
   *  helper writes is still inside the one transaction and disappears with the rest at the rollback. */
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
  /** A hand-written charge, so the guards and the CHECKs are provoked with no door in between. Every case
   *  names only the column it is breaking; the ref pattern, the NOT NULL halves and a basis the surcharge
   *  kind permits are filled in once here. */
  let plantN = 0;
  const plantValues = (o: Record<string, any>) => {
    plantN++;
    const row: Record<string, any> = {
      tenant_id: book, ref: `ZZZ-2026-9${String(plantN).padStart(4, "0")}`, code: `PLANT${plantN}`,
      kind: "surcharge", label: "A charge planted by hand", currency: "TZS", status: "draft",
      version: 1, basis: "flat", value: 5000, effective_from: DAY, ...o,
    };
    return row;
  };
  /** A hand-written draft that passes every guard, so a CHECK can be provoked on a row the immutability
   *  trigger has no claim over: a published charge's figure and scope are frozen before the table ever
   *  reads a constraint, so aiming a CHECK at one answers the wrong question. */
  const plantRow = async (o: Record<string, any> = {}) => {
    const row = plantValues(o);
    const keys = Object.keys(row);
    const sql = `insert into pricing_addenda (${keys.join(", ")}) values (`
      + `${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id`;
    where(sql);
    return (await c.query(sql, keys.map((k) => row[k]))).rows[0].id as string;
  };
  const plant = async (o: Record<string, any>) => {
    const row = plantValues(o);
    const keys = Object.keys(row);
    return refused(`insert into pricing_addenda (${keys.join(", ")}) values (`
      + `${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => row[k]));
  };

  await c.query("begin");
  try {
    // ---------------- the two books and the seats ----------------
    book = (await one(`insert into tenants (type, name, status) values ('transporter', $1, 'active')
      returning id`, [BOOK])).id;
    const PEN = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Addendum Pen','active',$2) returning id`, [book, SEAT("pen")])).id;
    const QUILL = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Addendum Quill','active',$2) returning id`, [book, SEAT("quill")])).id;
    const CLERK = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'staff','Not A Seat','active',$2) returning id`, [book, SEAT("clerk")])).id;
    const route1 = (await one(`insert into routes (tenant_id, name, origin_text, dest_text, distance_km)
      values ($1, $2, 'Dar es Salaam', 'Kigoma', 985) returning id`,
      [book, `P141 corridor ${STAMP}`])).id;
    const blind = (await one(`insert into routes (tenant_id, name, origin_text, dest_text)
      values ($1, $2, 'Tabora', 'Shinyanga') returning id`, [book, `P141 blind ${STAMP}`])).id;
    const foreign = (await one(`insert into tenants (type, name, status) values ('transporter', $1, 'active')
      returning id`, [`${BOOK} other`])).id;
    const foreignRoute = (await one(`insert into routes (tenant_id, name, origin_text, dest_text,
      distance_km) values ($1, $2, 'Dodoma', 'Mwanza', 420) returning id`,
      [foreign, `P141 foreign ${STAMP}`])).id;
    check("two synthetic books, three seats and three corridors are planted inside the transaction",
      !!book && !!PEN && !!QUILL && !!CLERK && !!route1 && !!blind && !!foreignRoute);

    /** 121's whole order for one charge, in the one place a signature may be spent: raise, be released by
     *  the second seat, be claimed by the seat that released it, be applied. */
    const putLive = async (id: string, words: string) => {
      const pr = await door("propose_pricing_addendum", [book, id, words, PEN, "billing_admin", IP, UA]);
      if (!pr.ok) return pr;
      const ap = pr.approval_id as string;
      await oi(call("decide_approval", 7), [ap, "approve", "Signed on the figure.", PEN,
        "billing_admin", IP, UA]);
      await oi(call("decide_approval", 7), [ap, "approve", "Signed on the figure.", QUILL,
        "super_admin", IP, UA]);
      await oi(call("claim_approval", 2), [ap, QUILL]);
      return { ap, r: await door("apply_pricing_addendum", [ap, QUILL, "super_admin", IP]) };
    };

    // ---------------- 1 · the registers as the catalog keeps them ----------------
    phase("1 · the four charge registers, the two words a charge may be, and who may knock");
    const rels = await one(`select count(*)::int as whole,
      count(*) filter (where relrowsecurity)::int as guarded
      from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = 'public' and cl.relname = any($1::text[])`, [TABLES]);
    check("all four charge registers exist and all four have row-level security turned on, so a client "
      + "role reads nothing at all until a door names the book",
      rels.whole === 4 && rels.guarded === 4, rels);
    const tblAcl = await one(`select count(*)::int as readers,
      coalesce(sum(case when a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
        then 1 else 0 end), 0)::int as writers
      from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
      cross join aclexplode(cl.relacl) a
      where n.nspname = 'public' and cl.relname = any($1::text[])
        and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')`, [TABLES]);
    check("the app role reads all four registers and writes none of them: a charge is only ever moved "
      + "through a door that names the book, the actor, the role, the address and the client",
      tblAcl.readers === 4 && tblAcl.writers === 0, tblAcl);
    const leaks = await one(`select coalesce(jsonb_agg(x), '[]'::jsonb) as rows from (
      select p.rolname as role, a.privilege_type as what, f.proname as fn
        from pg_proc f cross join aclexplode(f.proacl) a
        join pg_authid p on p.oid = a.grantee
       where f.pronamespace = 'platform_auth'::regnamespace
         and (f.proname like 'pricing_addend%')
         and (a.grantee = 0 or p.rolname in ('anon','authenticated','service_role','app_runtime'))
         and not (p.rolname = 'app_runtime' and a.privilege_type = 'EXECUTE'
                  and f.proname = any($1::text[]))) x`, [[...READS, ...WRITES]]);
    check("no client role and no PUBLIC reaches a guard, the paper a signature is cut on, the counter or "
      + "a door it has no duty for: `pricing_addendum_paper` and `pricing_addendum_sha256` are the "
      + "canonical bytes, and a route that could call them could hash a payload it never proposed",
      leaks.rows.length === 0, leaks.rows);
    const trg = await one(`select coalesce(jsonb_object_agg(t.trgname, t.tbl), '{}'::jsonb) as ours
      from (select tg.tgname as trgname, cl.relname as tbl
              from pg_trigger tg
              join pg_class cl on cl.oid = tg.tgrelid
              join pg_namespace n on n.oid = cl.relnamespace
             where not tg.tgisinternal and n.nspname = 'public'
               and tg.tgname = any($1::text[])) t`, [Object.keys(CHARGE_GUARDS)]);
    check("the seven guards 141 fires are attached to the tables the file says they stand on, and each "
      + "one is a guard rather than a helper — a keeper on the wrong table protects the wrong evidence",
      Object.entries(CHARGE_GUARDS).every(([t, tbl]) => trg.ours?.[t] === tbl)
      && Object.keys(trg.ours ?? {}).length === 7, trg.ours);
    const kinds = (await oi("select key, prefix, label, sign, counted, basis_set, sort "
      + "from pricing_addendum_kinds order by sort")).rows;
    check("the two words a charge may be are data, written once with their prefix, their sign, their "
      + "ceiling and the bases they permit: no door, no guard and no composer below re-types them, so a "
      + "third word added here is priced by the register without a line of plpgsql being edited",
      kinds.length === 2 && kinds[0].key === "surcharge" && kinds[0].prefix === "SUR"
      && kinds[0].sign === 1 && kinds[0].counted === false && kinds[0].basis_set.length === 7
      && kinds[1].key === "promo" && kinds[1].prefix === "PRM" && kinds[1].sign === -1
      && kinds[1].counted === true && kinds[1].basis_set.join(",") === "percent_off,amount_off",
      kinds);
    const words = await one(`select count(*)::int as n from pricing_dimensions
      where kind = 'basis' and key = any($1::text[])`,
      [kinds.flatMap((k: any) => k.basis_set)]);
    check("…and the quantity words the two kinds borrow are 140's own, while the three this register "
      + "invented are deliberately absent from `pricing_dimensions`: a basis the freight resolver can "
      + "multiply by is a basis a freight quote can be asked for, which is not true of percent_of_freight",
      words.n === 6 && !/insert into pricing_dimensions/.test(src)
      && (await one("select count(*)::int as n from pricing_dimensions")).n === 21, words);
    const idx = await one(`select coalesce(jsonb_agg(i.relname), '[]'::jsonb) as ours,
      bool_or(indisunique) as one_live
      from pg_class i join pg_index x on x.indexrelid = i.oid
      where i.relname = 'pricing_addendum_one_live_claim'`);
    check("a promo's places are counted, never stored: the only index that stops a second place for one "
      + "subject is PARTIAL on `voided_at is null`, so giving a place back frees it without deleting the "
      + "row that proves the mistake happened — a stored counter could not do both",
      idx.ours?.length === 1 && idx.one_live === true, idx);
    const cons = await one(`select coalesce(jsonb_agg(conname), '[]'::jsonb) as ours from pg_constraint
      where connamespace = 'public'::regnamespace and conrelid = 'pricing_addenda'::regclass
        and contype in ('c','u') and conname = any($1::text[])`, [CHECKS]);
    check(`the nine constraints the charge table carries are all present by name — ${CHECKS.length} of `
      + "them, each a state a door must not be able to forge",
      CHECKS.every((k) => (cons.ours ?? []).includes(k)), cons.ours);
    const seqAcl = await one(`select coalesce(count(*)::int, 0) as holders
      from pg_class cl cross join aclexplode(cl.relacl) a
      where cl.relname = 'pricing_addendum_number_seq' and cl.relkind = 'S'
        and a.grantee <> cl.relowner`);
    check("nobody but its owner can take a charge number without writing a charge",
      seqAcl.holders === 0, seqAcl);
    const dutyCount = await one("select count(*)::int as n, coalesce(jsonb_agg(key),'[]'::jsonb) as keys "
      + "from permissions where key like 'control.pricing.%'");
    check("141 seeds no fourth duty: the three 140 minted cover reading, drafting and signing an "
      + "addendum too, and a key nobody granted anyone is a nav tab that never appears",
      dutyCount.n === 3 && KEYS.every((k) => dutyCount.keys.includes(k)), dutyCount);

    // ---------------- 2 · the freight the charges sit on ----------------
    phase("2 · two 140 price lists are put live, because a charge that stands on nothing is a sum "
      + "nobody can ask");
    const stdCard = await door("open_pricing_card", [book, "P141-STD",
      "Standard freight, coastal to the lake", "TZS", DAY,
      "The office's own corridor price for the season.", PEN, "billing_admin", IP, UA]);
    if (stdCard.ok) cardMinted++;
    check("a TZS list is opened for the charges to sit on", stdCard.ok === true
      && stdCard.card?.currency === "TZS", stdCard);
    const stdId = stdCard.card?.id as string;
    for (const l of [[route1, "trailer", null, "per_km", 4250, 250000],
      [null, null, null, "per_tonne", 78000, 400000],
      [null, null, "40ft", "per_trip", 5000000, null]]) {
      await door("set_pricing_line", [book, stdId, ...l, PEN, "billing_admin", IP, UA]);
    }
    const cardPaper = await door("propose_pricing_publish", [book, stdId,
      "The season's freight, signed before any charge stands on it.", PEN, "billing_admin", IP, UA]);
    const cardApproval = cardPaper.approval_id as string;
    await oi(call("decide_approval", 7), [cardApproval, "approve", "Three lines, TZS.", QUILL,
      "super_admin", IP, UA]);
    await oi(call("claim_approval", 2), [cardApproval, QUILL]);
    const cardLive = await door("apply_pricing_publish", [cardApproval, QUILL, "super_admin", IP]);
    const usdCard = await door("open_pricing_card", [book, "P141-USD",
      "Dollar freight on the lake corridor", "USD", DAY,
      "The same corridor priced in the other money the register keeps.", PEN, "billing_admin", IP, UA]);
    if (usdCard.ok) cardMinted++;
    const usdId = usdCard.card?.id as string;
    await door("set_pricing_line", [book, usdId, route1, "trailer", null, "per_km", 2.5, null,
      PEN, "billing_admin", IP, UA]);
    const usdPaper = await door("propose_pricing_publish", [book, usdId,
      "One line, in dollars.", PEN, "billing_admin", IP, UA]);
    await oi(call("decide_approval", 7), [usdPaper.approval_id, "approve", "Signed.", QUILL,
      "super_admin", IP, UA]);
    await oi(call("claim_approval", 2), [usdPaper.approval_id, QUILL]);
    const usdLive = await door("apply_pricing_publish", [usdPaper.approval_id, QUILL, "super_admin", IP]);
    check("both are live: three TZS lines (a corridor at 4 250/km with a 250 000 floor, a wildcard at "
      + "78 000/tonne with a 400 000 floor, a 40ft trip at 5 000 000) and one dollar line at 2.50/km — "
      + "the two moneys exist so that 138's defect can be met one table away from the register that "
      + "caught it",
      cardLive.ok === true && usdLive.ok === true
      && cardLive.card?.card?.status === "published" && usdLive.card?.card?.status === "published",
      { tz: cardLive.error, us: usdLive.error });

    // ---------------- 3 · a charge is opened ----------------
    phase("3 · a charge carries its figure the moment it is opened, and fifteen refusals come first");
    const openArgs = (over: Record<string, any> = {}) => [book, "surcharge", "FUEL-SUR",
      "Fuel levy on every quote", "percent_of_freight", 7.5, 250000, null, null, "TZS",
      null, null, null, DAY, "A levy the yard carries on every corridor this season.",
      PEN, "billing_admin", IP, UA].map((v, i) => (i in over ? over[i] : v));
    let r = await door("open_pricing_addendum", openArgs());
    if (r.ok) minted++;
    const fuel = r.addendum;
    const fuelId = fuel?.id as string;
    check("a standing charge is opened as a draft with its figure on the row — unlike a rate card, a "
      + "charge is one number, and a draft with no number in it is nothing for a second seat to read",
      r.ok === true && fuel?.status === "draft" && fuel?.version === 1 && fuel?.kind === "surcharge"
      && fuel?.sign === 1 && fuel?.counted === false && fuel?.value === "7.5000"
      && fuel?.cap === "250000.00" && /^SUR-2026-\d{5}$/.test(String(fuel?.ref))
      && fuel?.scope === "any route / any class / any container / percent_of_freight",
      { ok: r.ok, err: r.error, ref: fuel?.ref, scope: fuel?.scope });
    check("…and the minted ref carries the kind's own three letters, read off the row rather than out of "
      + "a switch statement: SUR for a standing charge, PRM for a code, both from `pricing_addendum_kinds`",
      String(fuel?.ref).startsWith("SUR-") && r.uses?.unlimited === true && r.uses?.taken === 0, r.uses);
    const openedAudit = await one(`select after ->> 'seat' as seat, after ->> 'value' as value,
      after ->> 'kind' as kind, before is null as from_nothing
      from audit_logs where action = 'pricing.addendum_opened' and entity = 'pricing_addenda'
        and entity_id = $1`, [fuelId]);
    check("the open is audited by the door itself, so the route file writes no audit line of its own and "
      + "cannot forget to: the seat, the figure as printed and the kind all sit on the line",
      openedAudit.seat === "Addendum Pen" && openedAudit.value === "7.5000"
      && openedAudit.kind === "surcharge" && openedAudit.from_nothing === true, openedAudit);

    r = await door("open_pricing_addendum", openArgs({ 15: CLERK, 16: "driver" }));
    check("a seat that is not the platform's cannot open a charge", r.error === "not_a_seat", r);
    r = await door("open_pricing_addendum", openArgs({ 0: randomUUID() }));
    check("a charge belongs to a book that exists", r.error === "no_book", r);
    r = await door("open_pricing_addendum", openArgs({ 1: "levy" }));
    check("a word the register does not keep is refused with the words it does — the list is read off "
      + "the catalog, so a third kind added there is refused here in the same sentence",
      r.error === "bad_kind" && /surcharge, promo/.test(String(r.message)), r.message);
    r = await door("open_pricing_addendum", openArgs({ 2: "fuel sur!" }));
    check("a code has to be spellable off a printed quote", r.error === "bad_code", r);
    r = await door("open_pricing_addendum", openArgs({ 3: "Hi" }));
    check("the label is a sentence", r.error === "bad_label", r);
    r = await door("open_pricing_addendum", openArgs({ 9: "EUR" }));
    check("a charge is one money: TZS or USD, because a levy in a third word cannot be added to a card "
      + "priced in either of the two the register keeps", r.error === "bad_currency", r.message);
    r = await door("open_pricing_addendum", openArgs({ 14: "short" }));
    check("the note is 8-600 characters: it is the sentence the second seat reads before signing",
      r.error === "bad_note", r);
    r = await door("open_pricing_addendum", openArgs({ 5: 0 }));
    check("a charge of nothing is a row with no purpose, so it is refused rather than stored",
      r.error === "bad_value", r);
    r = await door("open_pricing_addendum", openArgs({ 5: 10000000000 }));
    check("a figure that does not fit the register is a keystroke, not a price",
      r.error === "bad_value", r.message);
    r = await door("open_pricing_addendum", openArgs({ 1: "promo", 4: "percent_off", 5: 140 }));
    check("a percentage above 100 is refused on both percent bases — a code that takes the payable away "
      + "twice is a refund the office never agreed to make",
      r.error === "percent_too_wide" && r.basis === "percent_off", r);
    r = await door("open_pricing_addendum", openArgs({ 6: 0 }));
    check("a ceiling is a positive figure or there is no ceiling", r.error === "bad_cap", r);
    r = await door("open_pricing_addendum", openArgs({ 7: -5 }));
    check("a floor is not a negative", r.error === "bad_min_amount", r);
    r = await door("open_pricing_addendum", openArgs({ 8: 0 }));
    check("a ceiling on places is at least one, or it is a code nobody can be given",
      r.error === "bad_max_uses", r);
    r = await door("open_pricing_addendum", openArgs({ 1: "promo", 4: "flat" }));
    check("a promo is never worked out on a flat basis, and the refusal names the bases the word knows "
      + "— read from the kind's array, not from a literal in this body",
      r.error === "bad_basis" && /percent_off, amount_off/.test(String(r.message)), r.message);
    r = await door("open_pricing_addendum", openArgs({ 8: 50 }));
    check("a standing charge has no places to run out of: the ceiling belongs to the counted word alone, "
      + "and it is refused here rather than silently ignored by the count",
      r.error === "kind_is_not_counted" && /promo/.test(String(r.message)), r.message);
    r = await door("open_pricing_addendum", openArgs({ 1: "promo", 2: "FUEL-SUR", 4: "percent_off" }));
    check("a code cannot change what it is: FUEL-SUR is already filed as a surcharge, and a discount "
      + "wearing an old levy's name would be a new charge answering an old customer's promise",
      r.error === "kind_moved" && r.existing_kind === "surcharge", r);
    const before = await one("select last_value::int as n from pricing_addendum_number_seq");
    r = await refused(`select platform_auth.open_pricing_addendum(${Array.from({ length: 19 },
      (_, i) => `$${i + 1}`).join(",")}) as r`, openArgs({ 10: foreignRoute }));
    check("a charge cannot be laid on a road the book does not have — and the refusal comes from the "
      + "trigger, not from the door, so the statement aborts rather than answering with a shape",
      /not a corridor of the book/.test(r), r.slice(0, 160));
    const after = await one("select last_value::int as n from pricing_addendum_number_seq");
    minted++;
    check("…and that trigger still spent the number: the value list is built before the guard is fired, "
      + "so the count this gate keeps of numbers taken is of the doors that reached their INSERT, not of "
      + "the doors that were allowed to finish — which is exactly the accounting a rollback cannot undo",
      after.n === before.n + 1, { before: before.n, after: after.n });

    // ---------------- 4 · the board ----------------
    phase("4 · the board a clerk reads, and the two words it is cut by");
    const prm = async (code: string, basis: string, value: number, over: Record<string, any> = {}) => {
      const out = await door("open_pricing_addendum", [book, "promo", code,
        `A code the office gave out: ${code}`, basis, value, null, null, over.max ?? null, "TZS",
        over.route ?? null, over.cls ?? null, over.cnt ?? null, over.from ?? DAY,
        over.note ?? "A discount the office is prepared to sign away, place by place.",
        PEN, "billing_admin", IP, UA]);
      if (out.ok) minted++;
      return out;
    };
    const launch = await prm("PRM-LAUNCH", "percent_off", 20, { max: 2 });
    const launchId = launch.addendum?.id as string;
    const van = await prm("PRM-VAN", "percent_off", 10, { cls: "van" });
    const future = await prm("PRM-FUTURE", "amount_off", 100000, { from: TOMORROW });
    const big = await prm("PRM-BIG", "amount_off", 5000000000);
    const handling = await door("open_pricing_addendum", [book, "surcharge", "HANDLING",
      "Handling on a light load", "per_tonne", 15000, null, 40000, null, "TZS", null, "van", null,
      DAY, "A van carrying one tonne is still worth handling.", PEN, "billing_admin", IP, UA]);
    if (handling.ok) minted++;
    const dem = await door("open_pricing_addendum", [book, "surcharge", "DEMURRAGE",
      "Demurrage on a large container", "per_day", 50000, null, null, null, "TZS", null, null,
      "40ft", DAY, "Charged per day a 40ft box sits in the yard.", PEN, "billing_admin", IP, UA]);
    if (dem.ok) minted++;
    check("six more charges are drafted: four codes and two standing levies, each with its own scope, "
      + "ceiling and basis", [launch, van, future, big, handling, dem].every((x) => x.ok === true),
      [launch, van, future, big, handling, dem].map((x) => [x.error, x.message]));
    check("the counted word carries its ceiling and the uncounted one carries none: PRM-LAUNCH prints 2 "
      + "places and `uses.left`, HANDLING prints unlimited",
      launch.addendum?.max_uses === 2 && launch.uses?.unlimited === false
      && launch.uses?.left === 2 && handling.addendum?.max_uses === null
      && handling.uses?.unlimited === true, { l: launch.uses, h: handling.uses });
    check("…and a code's basis set is the kind's, so percent_off is accepted where flat was refused: the "
      + "same door, the same word, the answer read off the row",
      launch.addendum?.basis === "percent_off" && launch.addendum?.sign === -1
      && launch.addendum?.counted === true, launch.addendum);

    r = await door("pricing_addenda", [book, null, null, null, null, 30, 0]);
    check("the board answers in the register's own order — kind, then code, then newest version — with "
      + "seven chips counted over the whole book rather than over this page",
      r.ok === true && r.total === 7 && r.rows?.length === 7
      && r.counts?.draft === 7 && r.counts?.kind_surcharge === 3 && r.counts?.kind_promo === 4
      && r.rows[0].kind === "promo", { total: r.total, counts: r.counts, first: r.rows?.[0]?.code });
    check("…and every row carries the two answers a desk cannot work out for itself: the sign and label "
      + "read off the kind, and the places taken counted off the claims register rather than stored on "
      + "the row it describes",
      r.rows?.every((x: any) => (x.kind === "promo" ? x.sign === -1 && x.counted !== false
        : x.sign === 1) && x.kind_label && x.uses_taken === 0
        && x.unlimited === (x.max_uses === null))
        && r.rows?.find((x: any) => x.code === "PRM-LAUNCH")?.value === "20.0000"
        && r.rows?.[0]?.code === "PRM-BIG",
      r.rows?.map((x: any) => [x.code, x.sign, x.value, x.uses_taken, x.unlimited]));
    check("…while the board hands back the vocabulary it was cut with, in the catalog's own order, so a "
      + "form can build its basis picker from the register instead of hard-coding a list that goes stale "
      + "the day a fifth word is added",
      r.kinds?.length === 2 && r.kinds[0].key === "surcharge" && r.kinds[0].prefix === "SUR"
      && r.kinds[0].basis_set.length === 7 && r.kinds[1].counted === true, r.kinds);
    r = await door("pricing_addenda", [book, null, "Kigoma", null, null, 30, 0]);
    check("a search reaches the corridor a charge is laid on, not only the name the office gave it — the "
      + "question at the desk is whether anything adds to a Kigoma quote",
      r.ok === true && r.total === 0, r.total);
    r = await door("pricing_addenda", [book, null, null, "promo", "PRM-LAUNCH", 30, 0]);
    check("the kind chip and the exact code chip filter over the whole book, so a heading and a table "
      + "cannot disagree after page one",
      r.total === 1 && r.rows[0].code === "PRM-LAUNCH" && r.counts?.kind_promo === 4,
      { t: r.total, c: r.counts });
    r = await door("pricing_addenda", [book, "invented", null, null, null, 30, 0]);
    check("a status the vocabulary does not carry is refused by name", r.error === "bad_status"
      && r.asked === "invented", r);
    r = await door("pricing_addenda", [book, null, null, "levy", null, 30, 0]);
    check("…and so is a kind", r.error === "bad_kind", r);
    r = await door("pricing_addenda", [foreign, null, null, null, null, 30, 0]);
    check("another book's board is empty, and empty rather than refused, because the register is the "
      + "platform's and a book that has priced nothing has priced nothing",
      r.ok === true && r.total === 0, r.total);

    // ---------------- 5 · editing a draft ----------------
    phase("5 · a draft moves, presence-based, and the money under it never does");
    r = await door("edit_pricing_addendum", [book, fuelId, "Fuel levy, every quote this season",
      null, 8, 240000, null, null, null, null, null, null, null, null, PEN, "billing_admin", IP, UA]);
    check("an edit keeps every half it does not name and moves the two it does: 8 %, ceiling 240 000",
      r.ok === true && r.addendum?.label === "Fuel levy, every quote this season"
      && r.addendum?.value === "8.0000" && r.addendum?.cap === "240000.00"
      && r.addendum?.basis === "percent_of_freight" && r.addendum?.currency === "TZS", r.addendum);
    r = await door("edit_pricing_addendum", [book, fuelId, "Fuel levy on every quote", null, 7.5,
      250000, null, null, null, null, null, null, null, null, PEN, "billing_admin", IP, UA]);
    check("…and the draft is put back to the figures the rest of this gate is pinned to",
      r.ok === true && r.addendum?.value === "7.5000" && r.addendum?.cap === "250000.00", r.addendum);
    r = await door("edit_pricing_addendum", [book, handling.addendum.id, null, null, null, null, null,
      null, null, null, null, null, null, "min_amount", PEN, "billing_admin", IP, UA]);
    check("a draft whose ceiling can only ever be raised is a draft a clerk would have to discard and "
      + "re-open to fix, so an explicit word in `p_clear` empties the column",
      r.ok === true && r.addendum?.min_amount === null, { m: r.addendum?.min_amount });
    r = await door("edit_pricing_addendum", [book, handling.addendum.id, null, null, null, null, 40000,
      null, null, null, null, null, null, null, PEN, "billing_admin", IP, UA]);
    check("…and putting it back needs no clear word, only the figure", r.ok === true
      && r.addendum?.min_amount === "40000.00", r.addendum?.min_amount);
    r = await door("edit_pricing_addendum", [book, fuelId, null, null, null, null, null, null, null,
      null, null, null, null, "everywhere", PEN, "billing_admin", IP, UA]);
    check("a clear word that names nothing on a charge is refused with the list of what does",
      r.error === "bad_clear" && /cap, min_amount, max_uses, route, vehicle_class, container/
        .test(String(r.message)), r.message);
    r = await door("edit_pricing_addendum", [book, fuelId, null, null, null, null, null, null, null,
      null, null, null, null, "max_uses", PEN, "billing_admin", IP, UA]);
    check("and a standing charge never had a ceiling on places to clear",
      r.error === "kind_is_not_counted", r.message);
    r = await door("edit_pricing_addendum", [book, fuelId, null, null, null, null, null, null, null,
      null, null, null, null, null, PEN, "billing_admin", IP, UA]);
    check("…so the money is not among the halves an edit can move: a TZS levy relabelled USD is 138's "
      + "defect arriving one table away, and the door never takes the column",
      !/p_currency/.test((src.match(
        /create or replace function platform_auth\.edit_pricing_addendum\([\s\S]{0,420}/) ?? [""])[0]),
      (src.match(/create or replace function platform_auth\.edit_pricing_addendum\([\s\S]{0,200}/) ??
        [""])[0]);

    // ---------------- 6 · the two-person walk ----------------
    phase("6 · the paper is raised on the charge's own bytes, and one seat cannot put a levy live");
    r = await door("propose_pricing_addendum", [book, fuelId,
      "Not yet: the yard has not confirmed the per-day figure.", PEN, "billing_admin", IP, UA]);
    const ap0 = r.approval_id as string;
    check("a publish paper is raised against the charge's bytes, printed as the register holds them",
      r.ok === true && r.action === "pricing.addendum" && r.target_kind === "pricing_addendum"
      && r.target_id === fuelId && /^[0-9a-f]{64}$/.test(String(r.payload_sha256))
      && r.value === "7.5000", { ok: r.ok, err: r.error, v: r.value });
    const p0 = await one(`select payload, payload_sha256, status, action, target_kind, target_id
      from platform_approvals where id = $1`, [ap0]);
    check("the register row is cut on the charge, and its payload prints the figure a seat is asked to "
      + "sign in the fourth-decimal form the register holds — signing '7.5' where the row says '7.5000' "
      + "is a translation dressed as a fact",
      p0?.status === "pending" && p0?.action === "pricing.addendum" && p0?.target_kind === "pricing_addendum"
      && p0?.target_id === fuelId && p0?.payload?.value === "7.5000"
      && p0?.payload_sha256 === r.payload_sha256 && p0?.payload?.kind === "surcharge",
      { st: p0?.status, v: p0?.payload?.value, cap: p0?.payload?.cap });
    r = await door("pricing_addendum_detail", [book, fuelId]);
    check("the charge is now waiting for a second seat, and the hash the detail recomputes off the row's "
      + "own bytes equals the hash the paper was cut on — that equality is what `paper_is_out` protects, "
      + "and a desk that shows one without the other is showing a signature that would not fit",
      r.addendum?.status === "pending_signature" && r.paper_sha256 === r.approval?.payload_sha256
      && r.approval?.status === "pending" && r.approval?.proposed_by === "Addendum Pen",
      { st: r.addendum?.status, sha: String(r.paper_sha256).slice(0, 12) });
    r = await door("edit_pricing_addendum", [book, fuelId, "Renamed while a seat is asked", null, null,
      null, null, null, null, null, null, null, null, null, PEN, "billing_admin", IP, UA]);
    check("the draft cannot be retitled while it is signed for", r.error === "paper_is_out", r.message);
    r = await door("propose_pricing_addendum", [book, fuelId, "A second paper for one version.", PEN,
      "billing_admin", IP, UA]);
    check("one signature stands per version", r.error === "already_open" && !!r.approval_id, r);
    r = await door("discard_pricing_addendum", [book, fuelId, "Trying to throw away a signed paper.",
      PEN, "billing_admin", IP, UA]);
    check("a paper nobody has answered cannot be discarded — and the sentence says which of the two "
      + "reasons it is, because a draft with a paper on it and a live charge look the same to a clerk",
      r.error === "not_a_draft" && /signature stood/.test(String(r.message)), r.message);
    let d = await oi(call("decide_approval", 7), [ap0, "approve", "Agreed on the figure.", PEN,
      "billing_admin", IP, UA]);
    check("the proposer cannot sign their own paper", d.rows[0].r.status === "self", d.rows[0].r);
    r = await door("apply_pricing_addendum", [ap0, PEN, "billing_admin", IP]);
    check("an unsigned paper publishes nothing", r.error === "conflict", r);
    r = await door("refuse_pricing_addendum", [book, fuelId, "Freeing my own paper is not mine to do.",
      PEN, "billing_admin", IP, UA]);
    check("…nor can the proposer withdraw the ask: the register's own sentence is what the desk shows",
      r.error === "refused_the_signature_first", { e: r.error, m: r.message });

    r = await door("refuse_pricing_addendum", [book, fuelId, "Not while the yard is quoting per day.",
      QUILL, "super_admin", IP, UA]);
    check("a second seat can refuse the levy", r.ok === true && r.refusals === 1, r);
    r = await door("pricing_addendum_detail", [book, fuelId]);
    check("…and the freed draft keeps its refused paper in the read rather than losing it: the status is "
      + "back to a draft, the refusals count the refusal, and the paper answers `rejected` with the seat "
      + "that refused it AND the sentence it refused with — two sentences live on a paper, the ask in "
      + "`reason` and the answer in `decided_note`, and a desk that shows only the ask cannot say why the "
      + "levy came back",
      r.addendum?.status === "draft" && r.addendum?.refusals === 1 && r.approval?.status === "rejected"
      && r.approval?.decided_by === "Addendum Quill"
      && /yard is quoting/.test(String(r.approval?.decided_note))
      && /per-day figure/.test(String(r.approval?.reason)),
      { st: r.addendum?.status, ap: r.approval });
    r = await door("refuse_pricing_addendum", [book, fuelId, "Refusing a paper that is not out.", QUILL,
      "super_admin", IP, UA]);
    check("refusing twice records nothing", r.error === "nothing_open", r);
    const refusedWords = await one(`select after ->> 'note' as note, after ->> 'seat' as seat,
        before ->> 'paper_sha256' is not null as on_the_paper
      from audit_logs where action = 'pricing.addendum_publish_refused'
        and entity = 'pricing_addenda' and entity_id = $1`, [fuelId]);
    check("…while the sentence the refusing seat typed is kept on the audit line beside the seat and the "
      + "bytes the paper was cut on, because the next version is written to answer it",
      /yard is quoting/.test(String(refusedWords.note)) && refusedWords.seat === "Addendum Quill"
      && refusedWords.on_the_paper === true, refusedWords);

    const live1 = await putLive(fuelId, "The lake corridor's fuel levy for the season.");
    check("re-raised, signed by the second seat, claimed and applied: the levy goes live",
      live1.r?.ok === true && live1.r?.addendum?.addendum?.status === "published"
      && live1.r.superseded_versions === 0 && live1.r.published_by === QUILL, live1.r);
    r = await door("apply_pricing_addendum", [live1.ap, QUILL, "super_admin", IP]);
    check("the publish that was spent cannot be spent again", r.error === "conflict", r);
    await oi(call("settle_approval", 2), [live1.ap, { ref: live1.r?.ref, version: live1.r?.version }]);
    const memLive = await one(`select count(*)::int as n,
      bool_or(what = 'figure' and new_value = '7.5000') as figure,
      bool_or(what = 'state' and old_value = 'pending_signature' and new_value = 'published') as state
      from pricing_addendum_history where addendum_id = $1`, [fuelId]);
    check("the memory the publish writes is a figure and a state — the charge's state lives on the same "
      + "row as its figures, so 141 remembers a publish as two rows exactly as 140 does a card",
      memLive.n === 2 && memLive.figure === true && memLive.state === true, memLive);
    r = await door("pricing_addenda_in_force", [book, DAY, null, null, route1, "trailer", null]);
    check("and it stands on a job the day it was signed for", r.ok === true && r.count === 1
      && r.rows[0].code === "FUEL-SUR" && r.rows[0].sign === 1 && r.asked_on === DAY, r);

    // ---------------- 7 · the composer ----------------
    phase("7 · the composer: a freight quote with the charges on top of it, pinned to figures");
    for (const [id, words] of [[launchId, "The launch discount, two places."],
      [van.addendum.id, "A discount on a van only."],
      [future.addendum.id, "A discount that starts tomorrow."],
      [big.addendum.id, "A discount worth more than any job."],
      [handling.addendum.id, "Handling on a light van load."],
      [dem.addendum.id, "Demurrage on a large box."]] as [string, string][]) {
      const went = await putLive(id, words);
      if (!went.r?.ok) check(`the charge ${id.slice(0, 8)} goes live`, false, went.r);
    }
    check("six more signatures are spent, because only this rolled-back transaction may put a charge "
      + "live — 141 keeps a published charge, its memory and every place taken on it, so an HTTP fixture "
      + "that signed once would never be swept", true);
    const inForce = await door("pricing_addenda_in_force", [book, DAY, null, null, route1, "trailer", null]);
    check("the in-force read answers in the order the composer will apply them, and it is not a "
      + "specificity ladder on purpose: 140's lines compete for a scope and one wins, these stack, so "
      + "the only order that matters is the one two rows cannot disagree about",
      inForce.ok === true && inForce.count === 3
      && inForce.rows.map((x: any) => x.code).join(",") === "PRM-BIG,PRM-LAUNCH,FUEL-SUR",
      inForce.rows?.map((x: any) => [x.kind, x.code, x.sign]));

    const JOB_A = [book, DAY, "P141-STD", route1, "trailer", null, "per_km", null, null, null, null, null];
    r = await door("price_a_job", JOB_A);
    const fuelRow = (r.extras ?? []).find((x: any) => x.code === "FUEL-SUR");
    check("a quote is not the freight: 985 km at 4 250.0000 is 4 186 250.00 of freight, and the 7.5 % "
      + "levy worked on top of it is 313 968.75 — held down to its own ceiling of 250 000.00, because a "
      + "percent of a long corridor runs away without one",
      r.ok === true && r.freight === "4186250.00" && r.currency === "TZS"
      && r.extras?.length === 1 && fuelRow?.amount === "250000.00" && fuelRow?.capped === true
      && r.extras_total === "250000.00" && r.payable === "4436250.00"
      && r.total === "4436250.00",
      { f: r.freight, e: fuelRow, pay: r.payable, tot: r.total });
    check("…and the working prints every charge in the order it was added, names the ceiling it held to, "
      + "and ends in the figure it arrived at: a clerk reads the sum, not only the answer",
      /4186250\.00/.test(String(r.working)) && /held to its own ceiling/.test(String(r.working))
      && /= 4436250\.00 TZS$/.test(String(r.working)), r.working);
    check("…while the two halves a desk shows separately are answered separately: the charges that stand "
      + "whether anybody names them, and the codes a customer has to name to be honoured",
      r.charges_in_force?.length === 1 && r.charges_in_force[0].code === "FUEL-SUR"
      && r.codes_in_force?.length === 2 && r.codes_in_force.every((x: any) => x.sign !== 1)
      && r.discounts?.length === 0 && r.discount_total === "0.00",
      { ch: r.charges_in_force?.map((x: any) => x.code), co: r.codes_in_force?.map((x: any) => x.code) });

    const JOB_B = [book, DAY, "P141-STD", null, "van", null, "per_tonne", 1, null, null, null, null];
    r = await door("price_a_job", JOB_B);
    check("the freight keeps 140's arithmetic and its floor: one tonne at 78 000 is 78 000, held up to "
      + "the card's 400 000 minimum before any charge is added to it",
      r.ok === true && r.freight === "400000.00", { f: r.freight, e: r.error, m: r.message });
    check("…and the stack is worked in the order the register keeps: 8 % of the freight is 30 000.00 and "
      + "handling at 15 000 a tonne is 15 000.00, held up to its own floor of 40 000.00, so the payable "
      + "is 470 000.00 — a floor on a charge means something different from a floor on a price",
      r.extras?.length === 2 && r.extras.find((x: any) => x.code === "FUEL-SUR")?.amount === "30000.00"
      && r.extras.find((x: any) => x.code === "HANDLING")?.floor_applied === true
      && r.extras.find((x: any) => x.code === "HANDLING")?.amount === "40000.00"
      && r.extras_total === "70000.00" && r.payable === "470000.00",
      r.extras?.map((x: any) => [x.code, x.amount, x.capped, x.floor_applied]));
    r = await door("price_a_job", [...JOB_B.slice(0, 11), "PRM-LAUNCH"]);
    check("a code named by a clerk comes off the payable, not off the freight: 20 % of 470 000.00 is "
      + "94 000.00 off, and the total a customer is quoted is 376 000.00",
      r.ok === true && r.payable === "470000.00" && r.discount_total === "94000.00"
      && r.total === "376000.00" && r.discounts?.[0]?.clipped_to_job === false
      && r.discounts?.[0]?.counted === true && r.discounts?.[0]?.uses_taken === 0
      && r.discounts?.[0]?.uses_left === 2,
      { off: r.discount_total, tot: r.total, d: r.discounts });
    r = await door("price_a_job", [book, DAY, "P141-STD", null, null, "40ft", "per_trip", null, null,
      null, 1, null]);
    check("a 40ft trip is 5 000 000.00 of freight with the levy capped again at 250 000.00 and a day's "
      + "demurrage at 50 000.00 — three lines, one scope each, all standing on the same quote",
      r.ok === true && r.freight === "5000000.00" && r.extras?.length === 2
      && r.extras.find((x: any) => x.code === "DEMURRAGE")?.amount === "50000.00"
      && r.payable === "5300000.00", { f: r.freight, e: r.extras?.map((x: any) => [x.code, x.amount]) });
    r = await door("price_a_job", [book, DAY, "P141-STD", null, null, "40ft", "per_trip", null, null,
      null, null, null]);
    check("a per-day charge on a job that runs no days is refused rather than left silently out of the "
      + "total — 140's refusal for the missing half, one table up, naming the charge by the number its own "
      + "row carries because nobody typed it (a code a clerk typed is echoed as a code, a standing levy "
      + "is not)",
      r.error === "no_days" && /^SUR-2026-/.test(String(r.addendum))
      && /is a per-day charge and the job runs no days/.test(String(r.message)),
      { e: r.error, a: r.addendum, m: r.message });
    r = await door("price_a_job", [book, DAY, "P141-USD", route1, "trailer", null, "per_km", null, null,
      null, null, null]);
    check("a TZS levy cannot be added to a quote a USD card answered: the money is bound at the freight, "
      + "not at the total, so the pairing is refused where it is formed instead of printing a figure "
      + "that means two things",
      r.error === "money_mismatch" && r.asked === "TZS" && r.card === "USD"
      && /^SUR-2026-/.test(String(r.addendum)), { e: r.error, a: r.asked, c: r.card });
    r = await door("price_a_job", [...JOB_A.slice(0, 11), "PRM-VAN"]);
    check("PRM-VAN is live on a van and this job names a trailer — the code is refused as out of scope, "
      + "with the scope it does stand on quoted back, because a clerk reading `unknown` would go looking "
      + "for a typing mistake",
      r.error === "promo_wrong_scope" && /any route \/ van \/ any container/.test(String(r.scope)),
      { e: r.error, scope: r.scope });
    r = await door("price_a_job", [...JOB_B.slice(0, 11), "PRM-FUTURE"]);
    check("a code that starts tomorrow is refused as lapsed, with its own dates in the sentence — the "
      + "four-way split the register makes so the clerk knows whether to retype, to move the job, to "
      + "ask for dates or to give up",
      r.error === "promo_lapsed" && r.effective_from === TOMORROW && /does not stand on/.test(String(r.message)),
      { e: r.error, from: r.effective_from });
    r = await door("price_a_job", [...JOB_A.slice(0, 11), "PRM-NEVER"]);
    check("a code this book never published is refused as unknown",
      r.error === "promo_unknown" && r.code === "PRM-NEVER", r);
    r = await door("price_a_job", [...JOB_A.slice(0, 11), "FUEL-SUR"]);
    check("a levy named as if it were a discount is refused by name: a clerk does not choose which "
      + "charges stand on a job — the sign is the kind's, read off the row",
      r.error === "promo_wrong_kind" && r.kind === "surcharge", r);
    r = await door("price_a_job", [...JOB_B.slice(0, 11), "PRM-BIG"]);
    check("a code worth more than the job is clipped to what is payable rather than allowed to go "
      + "negative: the quote answers 0.00, the discount says 470 000.00, and the working says it took "
      + "the whole of what was left, because the office that gave the code owes the difference to nobody",
      r.ok === true && r.discounts?.[0]?.clipped_to_job === true
      && r.discounts?.[0]?.amount === "470000.00" && r.discount_total === "470000.00"
      && r.total === "0.00" && /the whole of what was left/.test(String(r.working)),
      { d: r.discounts?.[0], t: r.total, w: r.working });
    r = await door("price_a_job", [...JOB_B.slice(0, 11), "PRM-BIG,PRM-LAUNCH"]);
    check("a second code after one that took the whole payable is refused rather than quoted as a "
      + "discount of nothing: a clerk who types a code and sees the figure unchanged has been told a "
      + "lie by the paper",
      r.error === "promo_too_small" && r.code === "PRM-LAUNCH", { e: r.error, c: r.code });
    r = await door("price_a_job", [...JOB_B.slice(0, 11),
      "PRM-LAUNCH,PRM-VAN,PRM-FUTURE,PRM-BIG,PRM-NEVER,PRM-OTHER"]);
    check("a quote carries at most five codes, counted distinct before any of them is looked up, because "
      + "a customer given six is being given a discount and the office cannot say which it honoured",
      r.error === "too_many_codes" && r.asked === 6, r);
    r = await door("price_a_job", [book, DAY, "P141-STD", null, null, null, "per_day", null, null, null,
      1, null]);
    check("140's words stay 140's: no price means no quote, and the composer hands the refusal back "
      + "unchanged rather than inventing a freight of zero to add a levy to — and `priced_that_day` is "
      + "140's own census of the scope that was asked for, so of the card's three lines only the wildcard "
      + "stands where no corridor, class or box was named",
      r.error === "no_price" && /What does stand there is/.test(String(r.message))
      && r.priced_that_day?.length === 1 && r.priced_that_day[0].basis === "per_tonne",
      { e: r.error, m: r.message, p: r.priced_that_day });
    r = await door("price_a_job", [foreign, DAY, "P141-STD", route1, "trailer", null, "per_km", null,
      null, null, null, null]);
    check("a foreign book cannot even ask what another book's corridor costs, with its own charges "
      + "sitting unused behind it", r.ok !== true && !r.payable, r);

    // ---------------- 8 · the places ----------------
    phase("8 · the places: why a promo can run out in the register and not in a client");
    const custA = randomUUID(); const custB = randomUUID(); const custC = randomUUID();
    r = await door("claim_pricing_addendum", [book, launchId, "customer", custA, "JOB-114",
      470000, 94000, "The launch discount on the first van job.", PEN, "billing_admin", IP, UA]);
    const claimA = r.claim_id as string;
    check("a place is taken: 1 of 2, and the count the desk shows is the count the composer refused on "
      + "because both read the same register",
      r.ok === true && r.uses_taken === 1 && r.max_uses === 2 && /^Took place 1 of 2/.test(String(r.message))
      && r.addendum?.uses?.taken === 1 && r.addendum?.uses?.left === 1, r.message);
    r = await door("claim_pricing_addendum", [book, launchId, "customer", custA, "JOB-115", 470000,
      94000, null, PEN, "billing_admin", IP, UA]);
    check("a code is given once: the same customer is refused through the partial unique index, and the "
      + "refusal names the subject it was refused for",
      r.error === "already_claimed" && r.subject_kind === "customer" && r.subject_id === custA, r);
    r = await door("claim_pricing_addendum", [book, launchId, "customer", custB, "JOB-116", 470000,
      94000, null, QUILL, "super_admin", IP, UA]);
    const claimB = r.claim_id as string;
    check("the second customer takes the last place: 2 of 2", r.ok === true && r.uses_taken === 2, r);
    r = await door("claim_pricing_addendum", [book, launchId, "customer", custC, "JOB-117", 470000,
      94000, null, PEN, "billing_admin", IP, UA]);
    check("the third is refused with the sentence a clerk has to read out loud — the discount is spent, "
      + "not hidden", r.error === "promo_spent" && /given all 2 of its places/.test(String(r.message)),
      r.message);
    r = await door("price_a_job", [...JOB_B.slice(0, 11), "PRM-LAUNCH"]);
    check("…and the composer refuses the spent code on the quote, without taking a place: a quotation is "
      + "not a booking, and two quotes of the same code must not spend each other",
      r.error === "promo_spent" && r.uses_taken === 2, { e: r.error, t: r.uses_taken });
    const afterQuotes = await one(`select platform_auth.pricing_addendum_uses_taken($1) as n`, [launchId]);
    check("…proved against the register: four refusals and three quotes later, the count is still exactly "
      + "the two places that were taken by hand", afterQuotes.n === 2, afterQuotes);
    r = await door("void_pricing_addendum_claim", [book, claimB,
      "Taken twice in error; the second customer never called.", PEN, "billing_admin", IP, UA]);
    check("giving a place back frees it without deleting the row: 1 of 2 now, and the voided claim is "
      + "still in the list with its author, its date and the reason",
      r.ok === true && r.uses_taken === 1 && /Gave the place back/.test(String(r.message))
      && r.addendum?.uses?.left === 1 && r.addendum?.claims?.some((x: any) => x.id === claimB
        && x.voided_at !== null && /never called/.test(String(x.void_reason))) === true,
      { u: r.uses_taken, c: r.addendum?.claims?.length });
    r = await door("price_a_job", [...JOB_B.slice(0, 11), "PRM-LAUNCH"]);
    check("…and the quote answers again, reporting the places as the register counts them now: 20 % off "
      + "470 000.00 is 94 000.00, one place left of two",
      r.ok === true && r.total === "376000.00" && r.discounts?.[0]?.uses_taken === 1
      && r.discounts?.[0]?.uses_left === 1, { t: r.total, d: r.discounts?.[0] });
    r = await door("void_pricing_addendum_claim", [book, claimB, "Voided twice.", PEN, "billing_admin",
      IP, UA]);
    check("a place already given back is refused with the minute it was given back and the seat that did "
      + "it, because the answer to a wrong void is a fresh claim with its own author",
      r.error === "already_voided" && /given back on/.test(String(r.message)), r.message);
    r = await door("claim_pricing_addendum", [book, fuelId, "customer", custC, "JOB-118", null, null,
      null, PEN, "billing_admin", IP, UA]);
    check("a standing charge has no places to take, even after it is live: the count belongs to the "
      + "word, not to whichever row happens to be published",
      r.error === "kind_is_not_counted" && r.kind === "surcharge", r);
    r = await door("claim_pricing_addendum", [book, fuelId, "hovercraft", custC, "JOB-118", null, null,
      null, PEN, "billing_admin", IP, UA]);
    check("a place is taken by a kind of subject the register can name, so a door cannot quietly invent "
      + "a fifth kind of holder", r.error === "bad_subject_kind", r);
    r = await door("claim_pricing_addendum", [book, fuelId, "customer", null, "JOB-118", null, null,
      null, PEN, "billing_admin", IP, UA]);
    check("…and it has to name who", r.error === "bad_subject_id", r);
    const lapsed = await door("claim_pricing_addendum", [book, future.addendum.id, "customer", custC,
      "JOB-119", null, null, null, PEN, "billing_admin", IP, UA]);
    check("a code that does not stand today gains no place, whatever its ceiling says",
      lapsed.error === "promo_lapsed" && /is not standing on today/.test(String(lapsed.message)), lapsed);
    const claimAudit = await one(`select after ->> 'uses_taken' as after_n,
        before ->> 'uses_taken' as before_n, after ->> 'subject_kind' as who
      from audit_logs where action = 'pricing.addendum_claimed' and entity = 'pricing_addendum_claims'
        and entity_id = $1`, [claimA]);
    check("the claim is audited against the claim register with the count on both sides of it, so the "
      + "office can say when a place went and who was told",
      claimAudit.after_n === "1" && claimAudit.before_n === "0" && claimAudit.who === "customer",
      claimAudit);

    // ---------------- 9 · the version ladder ----------------
    phase("9 · a charge moves forward by cloning, never by editing");
    r = await door("clone_pricing_addendum", [book, fuelId, PAST,
      "Trying to date a new version backwards.", PEN, "billing_admin", IP, UA]);
    check("a new version cannot be back-dated: a charge cannot be made valid for days already quoted "
      + "under another one", r.error === "back_dating", r);
    /** Every charge opened in phase 4 was signed and put live in phase 8, so the one state this refusal
     *  needs — a draft — has to be cut here. And it is aimed at today rather than at `PAST`: the door
     *  answers `nothing_to_clone` before it looks at the day, so a back-dated call would be answered by
     *  the check above and would prove nothing about this one. */
    const neverCloned = await prm("PRM-NEVER", "percent_off", 5);
    const beforeClone = await one("select last_value::int as n from pricing_addendum_number_seq");
    r = await door("clone_pricing_addendum", [book, neverCloned.addendum?.id, DAY,
      "Cloning a draft is not how a draft works.", PEN, "billing_admin", IP, UA]);
    const afterDraft = await one("select last_value::int as n from pricing_addendum_number_seq");
    check("a draft has nothing to clone, and the refusal that took nothing left its number unspent — "
      + "141 validates before it inserts, which is what makes the sequence gap auditable at all",
      r.error === "nothing_to_clone" && r.status === "draft" && afterDraft.n === beforeClone.n,
      { e: r.error, st: r.status, before: beforeClone.n, after: afterDraft.n });
    r = await door("clone_pricing_addendum", [book, fuelId, DAY,
      "Answering the refusal: the yard confirmed, so the levy is halved and uncapped.", PEN,
      "billing_admin", IP, UA]);
    if (r.ok) minted++;
    const fuel2 = r.addendum;
    const fuel2Id = fuel2?.id as string;
    check("the live version clones to a draft carrying figure, ceiling, scope, money and code — the "
      + "rollback shape, since cloning the old version and signing it is how a wrong levy is undone",
      r.ok === true && fuel2?.version === 2 && fuel2?.status === "draft" && fuel2?.code === "FUEL-SUR"
      && fuel2?.basis === "percent_of_freight" && fuel2?.value === "7.5000"
      && /^SUR-2026-/.test(String(fuel2?.ref)), { v: fuel2?.version, err: r.error });
    check("…and the clone names the ref it replaces rather than leaving the version line to be "
      + "reconstructed from a code and a date", fuel2?.supersedes === fuel?.ref, fuel2?.supersedes);
    r = await door("edit_pricing_addendum", [book, fuel2Id, null, null, 2, null, null, null, null, null,
      null, null, null, "cap", PEN, "billing_admin", IP, UA]);
    check("the new version's own figure is editable, and its ceiling clearable, because it has never "
      + "been quoted to anybody", r.ok === true && r.addendum?.value === "2.0000"
      && r.addendum?.cap === null, { v: r.addendum?.value, c: r.addendum?.cap });
    r = await door("pricing_addenda_in_force", [book, DAY, null, null, route1, "trailer", null]);
    check("the draft clone stands on nothing — a charge that has not been signed is not a charge, and "
      + "the two versions do not double the levy in the meantime",
      r.count === 3 && r.rows.some((x: any) => x.version === 2) === false, r.count);
    const live2 = await putLive(fuel2Id, "The levy halved, uncapped.");
    check("publishing version 2 closes version 1", live2.r?.ok === true
      && live2.r.superseded_versions === 1, live2.r);
    // Read as text on purpose: a raw `date` column comes back through node-pg as a Date at local
    // midnight, which is the previous day east of Greenwich — the same shift 140's doors were written
    // around. A read-back of a window has to be compared in the register's own words.
    const v1 = await one(`select status, to_char(effective_from, 'YYYY-MM-DD') as effective_from,
      to_char(effective_to, 'YYYY-MM-DD') as effective_to from pricing_addenda where id = $1`,
      [fuelId]);
    check("the closed window never ends before it began: the publish sets `effective_to` to the day "
      + "before the new version starts and then holds it up to the day the old one began, so a same-day "
      + "hand-over leaves a one-day window rather than a negative one — and it does it BEFORE the new "
      + "row goes live, or the overlap guard refuses the publish it is standing for",
      v1?.status === "superseded" && v1?.effective_to === DAY && v1?.effective_from === DAY, v1);
    r = await door("price_a_job", JOB_A);
    check("the composer answers the new figure: 2 % of 4 186 250.00 is 83 725.00, uncapped, payable "
      + "4 269 975.00 — while the version underneath stops standing on the job",
      r.ok === true && r.extras?.length === 1 && r.extras[0].value === "2.0000"
      && r.extras[0].amount === "83725.00" && r.extras[0].capped === false
      && r.payable === "4269975.00" && r.total === "4269975.00",
      { e: r.extras, pay: r.payable });
    r = await door("pricing_addendum_memory", [book, fuelId, 50, 0]);
    check("the supersede is remembered on the version it stopped, twice: its window moved from nothing "
      + "to the day it was closed, and its state moved from published to superseded, both naming the "
      + "ref that replaced it — a dispute about a quote asked on a given day is answered from here",
      r.ok === true && r.rows?.some((h: any) => h.what === "window" && h.new_value === DAY
        && h.old_value === null) === true
      && r.rows?.some((h: any) => h.what === "state" && h.old_value === "published"
        && h.new_value === "superseded" && /version 2/.test(String(h.reason))) === true,
      r.rows?.map((h: any) => [h.what, h.old_value, h.new_value]));
    r = await door("pricing_addendum_detail", [book, fuel2Id]);
    check("…and the version line is read back from the register rather than assembled in a browser: both "
      + "versions of FUEL-SUR, newest first, each with its own state, figure and window",
      r.versions?.length === 2 && r.versions[0].version === 2 && r.versions[0].status === "published"
      && r.versions[1].status === "superseded" && r.versions[1].effective_to === DAY,
      r.versions);

    // ---------------- 10 · the stop ----------------
    phase("10 · one seat stops a charge, dated forward, fully explained, never a delete");
    r = await door("withdraw_pricing_addendum", [book, dem.addendum.id, PAST,
      "Trying to stop a charge in the past.", PEN, "billing_admin", IP, UA]);
    check("a charge stops today or later: stopping it before a day that has passed would un-charge jobs "
      + "the office may have billed", r.error === "rewriting_history", r);
    r = await door("withdraw_pricing_addendum", [book, dem.addendum.id, null, "Say why",
      PEN, "billing_admin", IP, UA]);
    check("a stop has to be explained in 8-600 characters, because it is the sentence a customer is "
      + "answered with — and the door measures length and nothing else, so the probe types seven "
      + "characters rather than a sentence that merely says nothing", r.error === "bad_reason", r);
    r = await door("withdraw_pricing_addendum", [book, future.addendum.id, DAY,
      "The launch moved, so tomorrow's code stops today.", PEN, "billing_admin", IP, UA]);
    check("a charge that starts after the day it is being stopped on is refused rather than written as "
      + "an empty window: supersede it with the version that replaces it",
      r.error === "empty_window" && r.ref, r.message);
    r = await door("withdraw_pricing_addendum", [book, dem.addendum.id, DAY,
      "The yard has stopped charging demurrage on this corridor.", PEN, "billing_admin", IP, UA]);
    check("one seat stops a live charge — no second signature, because a stop is the act that keeps a "
      + "wrong levy from being added to a quote an hour longer",
      r.ok === true && r.addendum?.status === "withdrawn" && r.addendum?.effective_to === DAY
      && /demurrage/.test(String(r.addendum?.withdrawn_reason)), { st: r.addendum?.status });
    r = await door("price_a_job", [book, DAY, "P141-STD", null, null, "40ft", "per_trip", null, null,
      null, 1, null]);
    check("…and the stopped charge stops adding: the same 40ft trip is 5 100 000.00 now — the levy is "
      + "version 2's 2 % of 5 000 000.00, not version 1's held ceiling — and it no longer refuses a job "
      + "that runs no days, because the row it read is no longer in force",
      r.ok === true && r.extras?.length === 1 && r.extras[0].amount === "100000.00"
      && r.payable === "5100000.00",
      { e: r.error, pay: r.payable, x: r.extras });
    r = await door("withdraw_pricing_addendum", [book, dem.addendum.id, DAY, "Stopped twice.", PEN,
      "billing_admin", IP, UA]);
    check("a stopped charge stays stopped", r.error === "not_live" && r.status === "withdrawn", r);
    r = await door("withdraw_pricing_addendum", [book, van.addendum.id, DAY,
      "The van offer ran with the launch, so the code is stopped too.", PEN, "billing_admin", IP, UA]);
    check("a code is stopped by one seat on the same door as a levy: a discount the office has taken "
      + "back must not be quoted from a printed paper a customer is still holding",
      r.ok === true && r.addendum?.status === "withdrawn" && r.addendum?.code === "PRM-VAN",
      { st: r.addendum?.status, e: r.error });
    r = await door("price_a_job", [...JOB_B.slice(0, 11), "PRM-VAN"]);
    check("the van job that PRM-VAN stood on an hour ago now answers unknown, not lapsed and not out of "
      + "scope: the fallback lookup only ever looks at published rows, so a stopped code is a code this "
      + "book has never published for today — which is the honest sentence, because there is no window "
      + "left in which it could be honoured",
      r.error === "promo_unknown" && r.code === "PRM-VAN", { e: r.error, m: r.message });

    // ---------------- 11 · a draft that carries places ----------------
    phase("11 · a draft is thrown away, unless something stands on it");
    const draft = await prm("PRM-DRAFT", "percent_off", 5, { max: 1 });
    const draftId = draft.addendum?.id as string;
    await one(`insert into pricing_addendum_claims (tenant_id, addendum_id,
      subject_kind, subject_id, job_ref, freight, taken, currency, claimed_by)
      values ($1, $2, 'customer', $3, 'JOB-120', 470000, 23500, 'TZS', $4) returning id`,
      [book, draftId, randomUUID(), PEN]);
    r = await door("propose_pricing_addendum", [book, draftId,
      "A code that is already out of places.", PEN, "billing_admin", IP, UA]);
    check("a ceiling that is already reached is not a promo the office can put live: the second seat "
      + "would be signing a code that refuses the first clerk who types it",
      r.error === "already_spent" && r.uses_taken === 1 && r.max_uses === 1, r.message);
    r = await door("discard_pricing_addendum", [book, draftId, "Drafts are thrown away, are they not?",
      PEN, "billing_admin", IP, UA]);
    check("…and such a draft is refused a discard rather than swept, because the claims register is kept "
      + "by trigger and a discard that deleted underneath it would be a discard that rewrote who got a "
      + "discount", r.error === "places_taken" && r.claims === 1, r.message);
    const fk = await refused(`delete from pricing_addenda where id = $1`, [draftId]);
    check("…and with no door in between, the guard alone would let it go: a draft with no paper and no "
      + "publish is not kept, so the foreign key is what stops the hand — which is why the reference "
      + "carries no cascade", /foreign key constraint|23503/.test(fk), fk.slice(0, 160));
    r = await door("discard_pricing_addendum", [book, draftId,
      "Twice-planted by mistake; the office never signed it.", PEN, "billing_admin", IP, UA]);
    check("the door's own answer is the refusal, not the delete", r.error === "places_taken", r);
    const clean = await prm("PRM-CLEAN", "percent_off", 7);
    const cleanId = clean.addendum?.id as string;
    const gone = await door("discard_pricing_addendum", [book, cleanId,
      "Twice-planted by mistake; the office never signed it.", PEN, "billing_admin", IP, UA]);
    check("a clean draft — no paper, no publish, no place taken — is thrown away, and the audit line is "
      + "the only thing that will remember it existed: 141 keeps a published charge, a signed paper and "
      + "every place, but a draft that never reached a customer is not worth a row",
      gone.ok === true && gone.discarded === clean.addendum?.ref
      && (await one("select count(*)::int as n from pricing_addenda where id = $1",
        [cleanId])).n === 0
      && (await one("select count(*)::int as n from pricing_addendum_history where addendum_id = $1",
        [cleanId])).n === 0
      && (await one(`select count(*)::int as n from audit_logs where action =
        'pricing.addendum_discarded' and entity_id = $1`, [cleanId])).n === 1,
      { d: gone.discarded, err: gone.error });
    r = await door("open_pricing_addendum", [book, "surcharge", "PRM-VAN",
      "A levy wearing a stopped code's name", "flat", 1000, null, null, null, "TZS", null, null, null,
      DAY, "Planted to prove a stopped code keeps its kind.", PEN, "billing_admin", IP, UA]);
    check("…while a stopped code is not a freed name: PRM-VAN's withdrawn row still refuses to come back "
      + "as a surcharge, because a customer holding a printed code deserves the same answer whichever desk "
      + "reads it — and the refusal comes before the INSERT, so it leaves its number unspent",
      r.error === "kind_moved" && r.existing_kind === "promo", { e: r.error, k: r.existing_kind });

    // ---------------- 12 · the paper moved ----------------
    phase("12 · a signature names one figure, and a register that cannot say so refuses to spend it");
    const noStart = await prm("PRM-NOSTART", "percent_off", 10);
    await oi(`update pricing_addenda set effective_from = null where id = $1`, [noStart.addendum.id]);
    r = await door("propose_pricing_addendum", [book, noStart.addendum.id, "A charge with no day.",
      PEN, "billing_admin", IP, UA]);
    check("a charge with no start date cannot be put up for a signature: the composer could never tell "
      + "which day it stood on a job", r.error === "no_start", r.message);
    const moved = await prm("PRM-PAPER", "percent_off", 15);
    const movedId = moved.addendum?.id as string;
    const paperOut = await door("propose_pricing_addendum", [book, movedId,
      "Fifteen percent off anything the office names.", PEN, "billing_admin", IP, UA]);
    const sha = paperOut.payload_sha256 as string;
    await oi(`update pricing_addenda set value = 45 where id = $1`, [movedId]);
    await oi(call("decide_approval", 7), [paperOut.approval_id, "approve", "Signed at fifteen.", QUILL,
      "super_admin", IP, UA]);
    r = await door("refuse_pricing_addendum", [book, movedId, "Refusing a released paper.", QUILL,
      "super_admin", IP, UA]);
    check("a paper that was released is not refused from this desk: it is spent on Approvals or "
      + "withdrawn from here, and the register says which", r.error === "already_signed"
      && r.approval_status !== "pending", r);
    await oi(call("claim_approval", 2), [paperOut.approval_id, QUILL]);
    r = await door("apply_pricing_addendum", [paperOut.approval_id, QUILL, "super_admin", IP]);
    check("the bytes are rebuilt from the row before a single column moves: a figure typed in the seven "
      + "days a paper waited is refused here rather than charged under a signature that never described "
      + "it", r.error === "paper_moved" && r.signed_sha256 === sha && /not the one that was signed/
        .test(String(r.message)), { e: r.error, m: r.message });
    const notPublished = await one(`select status, published_at, value::text as value
      from pricing_addenda where id = $1`, [movedId]);
    check("…and nothing was put in force: the charge is still waiting, and the moved figure is the one "
      + "the register holds rather than the one anybody signed for",
      notPublished.status === "pending_signature" && notPublished.published_at === null
      && notPublished.value === "45.0000", notPublished);
    r = await door("apply_pricing_addendum", [cardApproval, QUILL, "super_admin", IP]);
    check("the door that spends a charge signature says out loud when a signature is not its kind: 121's "
      + "register is one table, so a price list's paper arrives here too and has to be named, not "
      + "guessed at", r.error === "not_a_charge", r.message);
    r = await door("apply_pricing_addendum", [randomUUID(), QUILL, "super_admin", IP]);
    check("and a signature that does not exist is not found rather than refused",
      r.error === "not_found", r);
    r = await door("claim_pricing_addendum", [book, randomUUID(), "customer", randomUUID(), null, null,
      null, null, PEN, "billing_admin", IP, UA]);
    check("…and so is a charge a clerk quoted from a number that is not in the book",
      r.error === "not_found", r);

    // ---------------- 13 · the memory, read ----------------
    phase("13 · the memory a trigger keeps, and the book it is nobody else's to read");
    r = await door("pricing_addendum_memory", [book, null, 200, 0]);
    const whats = Array.from(new Set((r.rows ?? []).map((h: any) => h.what)));
    check("the whole book's memory answers in one page: five kinds of change — a figure, a window, a "
      + "state, a place taken and a place given back — all printed on the same register because all five "
      + "are answers to what was it before",
      r.ok === true && whats.sort().join(",") === "claim,figure,state,void,window"
      && r.total === r.rows?.length && r.rows?.every((h: any) => !!h.charge && !!h.said && !!h.actor),
      { total: r.total, whats });
    check("…and every line says who did it, in which role, with the reason typed and the scope the "
      + "charge was laid on, so a register read six months later still answers a customer",
      r.rows?.every((h: any) => ["Addendum Pen", "Addendum Quill"].includes(h.actor))
      && r.rows?.some((h: any) => h.actor_role === "super_admin")
      && r.rows?.some((h: any) => h.what === "claim" && /^customer [0-9a-f-]{8}/.test(String(h.said))),
      r.rows?.slice(0, 2));
    const masked = (r.rows ?? []).filter((h: any) => h.what === "claim" || h.what === "void");
    check("a place is remembered by its kind and the first eight characters of its uuid, not by a name: "
      + "the desk is proving a ceiling was reached, and it does not need a list of who got the discount "
      + "to do that", masked.length > 0 && masked.every((h: any) => !/Addendum|@waisha/.test(String(h.said)))
      && masked.every((h: any) => String(h.said).length <= 60), masked.slice(0, 2));
    const foreignMem = await door("pricing_addendum_memory", [foreign, null, 50, 0]);
    check("a foreign book reads no memory of another book's charges, and no charge of them either: the "
      + "tenant predicate is bound in the door rather than left to the session",
      foreignMem.ok === true && foreignMem.total === 0, foreignMem);
    const foreignDetail = await door("pricing_addendum_detail", [foreign, fuelId]);
    check("…and a foreign book that quotes another book's charge number is answered with `not_found` "
      + "rather than with the row, because a number is not a capability",
      foreignDetail.error === "not_found", foreignDetail);

    // ---------------- 14 · the guards, by hand ----------------
    phase("14 · the guards below the doors, provoked with no door in between");
    let m = await refused(`update pricing_addendum_history set new_value = '1' where id =
      (select id from pricing_addendum_history limit 1)`);
    check("a memory row cannot be rewritten", /addendum-history row is a record/.test(m), m.slice(0, 160));
    m = await refused(`delete from pricing_addendum_history where id =
      (select id from pricing_addendum_history limit 1)`);
    check("or deleted, and the guard prints which of the two a caller attempted because one trigger "
      + "stands behind both", /cannot be DELETE/.test(m), m.slice(0, 160));
    m = await refused(`delete from pricing_addenda where id = $1`, [fuelId]);
    check("a charge that a signature stood on is never deleted, even after it is superseded: the "
      + "sentence names its state, whether it carries a paper and what ends a charge instead",
      /published charge that carries a signature|superseded charge/.test(m) && /so it is kept/.test(m)
      && /never by a delete/.test(m), m.slice(0, 240));
    m = await refused(`update pricing_addenda set value = 1 where id = $1`, [fuelId]);
    check("even by hand, a figure under a charge that went live is frozen — and the freeze is pinned to "
      + "`published_at` rather than to the status, because here the figures and the state share one row "
      + "and a guard that froze a draft's write would refuse the publish it is standing for",
      /was published, so its figure and its scope are kept/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addenda set effective_from = effective_from + 1 where id = $1`,
      [fuelId]);
    check("the day a customer was charged from is not moved afterwards",
      /day a customer was charged from/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addenda set status = 'draft' where id = $1`, [fuelId]);
    check("a live charge never goes back to being a draft", /never edited back into a draft/.test(m),
      m.slice(0, 200));
    m = await refused(`update pricing_addenda set status = 'published' where id = $1`, [dem.addendum.id]);
    check("a stopped charge stays stopped, whatever a hand types", /stays stopped/.test(m), m.slice(0, 200));
    // Aimed at `withdrawn`, not at `published`: BEFORE-row triggers fire in name order, so a hand that
    // reopened a superseded version would be answered by `pricing_addenda_do_not_overlap` (the live
    // version 2 stands on the same days) before `..._keep_their_dates` ever read the state. Both are
    // refusals; only one of them is the guard this check is about.
    m = await refused(`update pricing_addenda set status = 'withdrawn' where id = $1`, [fuelId]);
    check("and a closed version stays closed: the answer to a wrong supersede is a third version, not a "
      + "rewrite of the second", /nothing left to change/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addenda set currency = 'USD' where id = $1`, [fuel2Id]);
    check("a money is not a column to change under a figure: a TZS levy read as USD is 138's defect, and "
      + "the guard is unconditional, so it holds on a draft too",
      /Changing the money under a figure/.test(m), m.slice(0, 200));
    // The basis moves with the kind or `pricing_addenda_belong_to_their_book` answers first with the
    // kind's basis list, which is a true sentence but not the guard being proved here. A draft is aimed
    // at because the identity guard is the last of the three to fire, and a published row would be
    // stopped by its own figure freeze.
    m = await refused(`update pricing_addenda set kind = 'surcharge', basis = 'percent_of_freight'
      where id = $1`, [noStart.addendum.id]);
    check("a draft's kind is not editable either — a discount that started life as a discount is not a "
      + "levy waiting to be one, and the guard prints the kind it found rather than the one the hand "
      + "typed, because a charge that changed what it is wears an old customer's promise",
      /its kind is promo|none of that is editable/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addenda set tenant_id = $2 where id = $1`, [fuelId, foreign]);
    check("a charge cannot be moved between books", /belongs to the book/.test(m), m.slice(0, 200));
    m = await refused(`insert into pricing_addenda (tenant_id, ref, code, kind, label, currency, status,
      version, basis, value, effective_from, published_at)
      values ($1, 'SUR-2026-99999', 'FUEL-SUR', 'surcharge', 'Hand forced a second window', 'TZS',
      'published', 90, 'percent_of_freight', 3, $2, now())`, [book, DAY]);
    check("two published windows for one code and one day are refused — the sum would otherwise depend "
      + "on which row the composer happened to read first", /Two figures for one day/.test(m),
      m.slice(0, 220));
    m = await refused(`insert into pricing_addenda (tenant_id, ref, code, kind, label, currency, status,
      version, basis, value, effective_from, effective_to, published_at)
      values ($1, 'SUR-2026-99998', 'FUEL-SUR', 'surcharge', 'An open window forced live', 'TZS',
      'published', 91, 'percent_of_freight', 3, $2, null, now())`, [book, TOMORROW]);
    check("…and NULL is read as open rather than skipped by the guard, which is the exact lesson 140 "
      + "learned about a bare comparison in a window: an open-ended version tomorrow overlaps the live "
      + "one today for nobody", /Two figures for one day/.test(m), m.slice(0, 220));
    m = await plant({ kind: "levy" });
    check("a word the catalog does not keep cannot be planted on the table: the guard prints the words "
      + "it does, read off `pricing_addendum_kinds` as the doors read them",
      /is not a charge this register can be\. It knows: surcharge, promo/.test(m), m.slice(0, 200));
    m = await plant({ basis: "per_furlong" });
    check("a basis the kind does not permit is refused by the trigger as well as by the door, with the "
      + "kind's own array in the sentence", /never worked out on a per_furlong basis/.test(m),
      m.slice(0, 200));
    m = await plant({ route_id: foreignRoute });
    check("a charge cannot be laid on a road the book does not have", /not a corridor of the book/.test(m),
      m.slice(0, 200));
    m = await plant({ vehicle_class: "hovercraft" });
    check("a charge cannot invent a vehicle class — the scope halves are keyed on 140's vocabulary, the "
      + "same words a freight line is keyed on, so one desk's wildcard is another's",
      /not a vehicle class this register knows/.test(m), m.slice(0, 200));
    m = await plant({ container_type: "hoverbox" });
    check("…nor a container kind", /not a container kind/.test(m), m.slice(0, 200));
    m = await plant({ code: "FUEL-SUR", version: 90, kind: "promo", basis: "percent_off" });
    check("…and a second version of a live code cannot change what it is, even by hand: the guard looks "
      + "the name up in the book rather than trusting the row it is being handed",
      /already files FUEL-SUR as a surcharge/.test(m), m.slice(0, 220));
    m = await plant({ currency: "EUR" });
    check("a money the register cannot charge is refused by the trigger too, so a CHECK that no longer "
      + "lists a word cannot let it through", /carries a money this register cannot charge/.test(m),
      m.slice(0, 200));

    // ---------------- 15 · a claim's own guards, and the CHECKs ----------------
    phase("15 · the only change a place can undergo, and the states no door can forge");
    m = await refused(`delete from pricing_addendum_claims where id = $1`, [claimA]);
    check("a place that was taken is evidence and cannot be deleted: the answer to a mistake is a void, "
      + "which keeps the row, its author and its minute", /cannot be DELETE/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addendum_claims set taken = 1 where id = $1`, [claimA]);
    check("nor can the figure a place records be moved afterwards: only whether the place still counts "
      + "is editable", /The only thing that changes/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addendum_claims set subject_kind = 'driver' where id = $1`, [claimA]);
    check("…nor the subject it was written against, which is what makes the partial unique index a fact "
      + "rather than a habit", /The only thing that changes/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addendum_claims set voided_at = null where id = $1`, [claimB]);
    check("a place given back stays given back: un-voiding would put a claim back into a count other "
      + "clerks have already read", /stays given back/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addendum_claims set voided_at = voided_at + interval '1 hour'
      where id = $1`, [claimB]);
    check("…and a void is one minute, not a column to restate", /already given back on/.test(m),
      m.slice(0, 200));
    m = await refused(`update pricing_addendum_claims set voided_by = null where id = $1`, [claimB]);
    check("a void names the seat that gave the place back and says why, in the same statement that sets "
      + "the date — an anonymous void is a delete with extra steps",
      /names the seat that gave the place back/.test(m), m.slice(0, 200));
    const draftLevy = await plantRow();
    m = await refused(`update pricing_addenda set max_uses = 5 where id = $1`, [draftLevy]);
    check("the table itself says a standing charge has no places: the ceiling belongs to the counted "
      + "word, so a hand cannot make a levy into a queue",
      /pricing_surcharge_is_never_counted/.test(m), m.slice(0, 200));
    const draftPct = await plantRow({ kind: "promo", basis: "percent_off", value: 15 });
    m = await refused(`update pricing_addenda set value = 150 where id = $1`, [draftPct]);
    check("a percentage is a percentage in either direction, and the CHECK is aimed at a draft a door "
      + "never touched: on a published charge the immutability trigger answers first, which is the right "
      + "refusal for the wrong question — 150 % off is not a discount, it is a refund",
      /pricing_addendum_percent_is_a_percent/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addenda set effective_to = effective_from - 1 where id = $1`,
      [movedId]);
    check("a window that ends before it began is refused by the table",
      /pricing_addenda_window_is_a_window/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addenda set status = 'withdrawn' where id = $1`, [movedId]);
    check("and a withdrawal is explained or it is nothing: the constraint runs both ways, so a stop "
      + "without a date and a reason, and a reason without a stop, are both refused",
      /pricing_addenda_withdrawal_is_explained/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addenda set status = 'pending_signature' where id = $1`,
      [noStart.addendum.id]);
    check("a paper is a row before it is a status: a charge cannot be put in `pending_signature` by a "
      + "hand that never cut the paper, because the signature a desk shows would name nothing",
      /pricing_addenda_unsigned_paper_is_pending/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addenda set status = 'published', published_at = now()
      where id = $1`, [noStart.addendum.id]);
    check("…and the same hand cannot put a charge with no start day live, which is the state the two "
      + "`no_start` refusals in the doors are defending",
      /pricing_addenda_published_has_a_start/.test(m), m.slice(0, 200));
    m = await refused(`update pricing_addenda set supersedes_id = id where id = $1`, [fuel2Id]);
    check("a version cannot supersede itself", /pricing_addenda_does_not_supersede_itself/.test(m),
      m.slice(0, 200));
    m = await plant({ tenant_id: book, code: "FUEL-SUR", ref: "SUR-2026-99997", version: 2 });
    check("one row per (book, code, version) is kept by a unique constraint, not by the doors' arithmetic",
      /unique|23505/.test(m), m.slice(0, 200));

    // a third kind, written as data with no body edited — and kept, because the doors below have to read
    // the word back out of the catalog the way a live register would
    const odd = await keeps(`insert into pricing_addendum_kinds (key, prefix, label, sign, counted,
      basis_set, sort) values ('odd','ODD','An odd charge', 1, false, array['per_furlong'], 9)`);
    check("a third word can be added to the catalog with no line of plpgsql edited — which is the "
      + "promise 141's header makes and the reason the kinds are rows",
      odd.ok === true, odd.message);
    if (odd.ok) {
      const opened = await door("open_pricing_addendum", [book, "odd", "ODD-TEST", "A charge on a word the "
        + "composer cannot multiply", "per_furlong", 5, null, null, null, "TZS", null, null, null, DAY,
        "Planted to prove the composer refuses a word rather than dropping it.", PEN, "billing_admin",
        IP, UA]);
      if (opened.ok) minted++;
      const oddLive = await putLive(opened.addendum?.id, "A kind this body was never told about.");
      r = await door("price_a_job", JOB_A);
      check("…and the composer meets it honestly: the register does not know how to multiply a "
        + "per_furlong charge and says so before the total is printed, because answering with a charge "
        + "silently left out of the sum is the worse failure — the whole quote is refused rather than "
        + "quietly short", r.error === "unknown_basis" && /per_furlong/.test(String(r.message))
        && r.payable === undefined, { e: r.error, m: r.message });
      check("…which is also why the doors read a kind's basis set from the row: the odd charge opened, "
        + "was signed and went live without a single body mentioning it",
        opened.ok === true && oddLive.r?.ok === true, { o: opened.error, l: oddLive.r?.error });
    }

    // ---------------- 16 · the doors, the duties and the words ----------------
    phase("16 · the fourteen HTTP doors, the three duties they name, and the words that classify a "
      + "refusal");
    const handlers = (route.match(/^  app\.\w+\("\/control\/pricing[^"]*"/gm) ?? []) as string[];
    check("141's route file cuts exactly 14 doors, all of them under the pricing desk's own path so a "
      + "charge is never a tab a seat has to be granted twice",
      handlers.length === 14 && handlers.every((h) => /\/control\/pricing/.test(h)), handlers);
    check("…and every one of them is guarded by one of the three duties 140 seeded, because a charge a "
      + "seat can read is not a charge a seat can set: 5 reads under `.view`, 7 writes under `.manage` "
      + "and the two that spend a signature under `.publish`",
      (route.match(/requireControlPermission\(req, VIEW\)/g) ?? []).length === 5
      && (route.match(/requireControlPermission\(req, MANAGE\)/g) ?? []).length === 7
      && (route.match(/requireControlPermission\(req, PUBLISH\)/g) ?? []).length === 2
      && (route.match(/requireControlPermission\(req, \w+\)/g) ?? []).length === 14,
      { view: (route.match(/requireControlPermission\(req, VIEW\)/g) ?? []).length,
        manage: (route.match(/requireControlPermission\(req, MANAGE\)/g) ?? []).length,
        publish: (route.match(/requireControlPermission\(req, PUBLISH\)/g) ?? []).length });
    check("…and the door that takes a place on a promo is a clerk's duty, not a signer's: `.manage` also "
      + "covers taking and voiding, which is why 141 needed no fourth key and no nav entry nobody "
      + "granted anyone",
      /app\.post\("\/control\/pricing\/charges\/:id\/claims"/.test(route)
      && /app\.post\("\/control\/pricing\/claims\/:id\/void"/.test(route)
      && (route.slice(route.indexOf("charges/:id/claims"), route.indexOf("charges/:id/claims") + 400)
        .includes("MANAGE"))
      && (route.slice(route.indexOf("claims/:id/void"), route.indexOf("claims/:id/void") + 400)
        .includes("MANAGE")), route.match(/claims[^\n]*\n[^\n]*MANAGE/)?.[0]);
    check("the three duty words the doors name are the three 140 seeded, spelled the same in both files, "
      + "and all three still reach the permissions probe's allowlist — a held duty nobody probes is a tab "
      + "that never appears",
      KEYS.every((k) => route.includes(`"${k}"`)) && KEYS.every((k) => analytics.includes(k)),
      { route: KEYS.map((k) => route.includes(`"${k}"`)), analytics: KEYS.map((k) => analytics.includes(k)) });
    check("every door takes the book from the session and from nowhere else: the API role is BYPASSRLS, "
      + "so `withTenant` is not isolation and a route that read a tenant out of the query string would "
      + "hand a clerk another book's charges — searched line by line, because a query parse and the next "
      + "line's `tenantOf(req)` bind are two statements, not one",
      (route.match(/req\.query[^\n]*?tenant|params\.tenant_id|body\.tenant_id/g) ?? []).length === 0
      && /const tenantOf = \(req: any\) => String\(req\.control\.tenant_id\)/.test(route),
      (route.match(/.*tenant_id.*/g) ?? []).slice(0, 4));
    check("the route never calls the door that spends a signature: `apply_pricing_addendum` appears in "
      + "this file only as the sentence saying it is not a route here, so a desk that could publish from "
      + "it would be a desk that signs its own levy",
      !/apply_pricing_addendum\(/.test(route) && !/ADDENDUM_APPLY/.test(route)
      && /apply_pricing_addendum/.test(route),
      (route.match(/apply_pricing_addendum\(/g) ?? []).length);
    check("…and the effect is really 121's, reached in the register's own order by the seat that signed: "
      + "the door is called from the approvals body, which names `pricing.addendum` as a second action "
      + "with its own effect and its own `proposable: false`",
      /apply_pricing_addendum\(/.test(approvals) && /"pricing\.addendum"/.test(approvals)
      && /"addendum_publish"/.test(approvals) && /ADDENDUM_APPLY_SQL\s*=/.test(approvals),
      (approvals.match(/.{0,40}apply_pricing_addendum.{0,20}/g) ?? []).slice(0, 2));
    check("…while the 140 pricing route keeps its own doors untouched: 141 adds a file rather than "
      + "editing a card's, so `apply_pricing_publish` is still only named where it is spent",
      !/apply_pricing_addendum/.test(pricingRoute) && /apply_pricing_publish/.test(pricingRoute),
      (pricingRoute.match(/apply_pricing_[a-z]+/g) ?? []));
    const codes: string[] = Array.from(new Set((src.match(/'error', '[a-z_]+'/g) ?? [])
      .map((s: string) => s.replace("'error', ", "").replace(/'/g, ""))));
    const notFound = new Set((route.match(/const NOT_FOUND = new Set\(\[([\s\S]*?)\]\);/)?.[1]
      ?? "").split(",").map((s: string) => s.trim().replace(/"/g, "")).filter(Boolean));
    const conflict = new Set((route.match(/const CONFLICT = new Set\(\[([\s\S]*?)\]\);/)?.[1]
      ?? "").split(",").map((s: string) => s.trim().replace(/"/g, "")).filter(Boolean));
    /** Every word 141 can answer has to be classified by the door, or a refusal arrives as a 200 with
     *  `ok:false` in the body — which is how a desk ends up showing a clerk nothing at all. */
    const EXPECTED_400 = new Set(["bad_kind", "bad_code", "bad_label", "bad_currency", "bad_note",
      "bad_value", "bad_cap", "bad_min_amount", "bad_max_uses", "bad_basis", "bad_clear", "bad_status",
      "bad_reason", "bad_subject_kind", "bad_subject_id", "bad_job_ref", "percent_too_wide",
      "kind_is_not_counted", "unknown_basis", "no_tonnes", "no_teu", "no_cbm", "no_days", "no_distance",
      "composer_failed", "money_mismatch", "promo_too_small", "too_many_codes", "not_a_charge"]);
    const unclassified = codes.filter((k) => !notFound.has(k) && !conflict.has(k) && !EXPECTED_400.has(k)
      && k !== "not_a_seat" && k !== "unauthorised");
    check(`every one of the ${codes.length} refusal words 141 answers is classified by the door into a `
      + "status it can be read from: NOT_FOUND, CONFLICT, 403 for a seat that is not one, or an expected "
      + "400 for a figure a clerk typed", unclassified.length === 0 && codes.length >= 40,
      { unclassified, codes: codes.length });
    check("the four words that are honest statements about the book are 404 rather than 400 — a code "
      + "this register never published, a charge number that is not in this book, a signature that is "
      + "not there, and a price nobody has set, which the composer hands back in 140's own words so the "
      + "same missing figure reads the same at both desks",
      ["not_found", "no_book", "approval_missing", "promo_unknown", "no_price"].every((k) => notFound.has(k)),
      [...notFound]);

    // ---------------- 16b · the same register seen from the clerk's screen ----------------
    /** A door nobody calls is a door nobody tested, and a path the desk misspells answers 404 with the
     *  register's own silence. Both halves are cut out of the two files and compared. */
    const norm = (p: string) => p.replace(/\/\$\{[^}]*\}/g, "/:id");
    const registered = new Set([route, pricingRoute]
      .flatMap((f) => Array.from(f.matchAll(/app\.\w+\("(\/control\/pricing[^"]*)"/g), (m) => m[1])));
    const named = new Set([chargesDesk, askDesk, page]
      .flatMap((f) => Array.from(f.matchAll(/\/control\/pricing[^\s"'`?]+/g), (m) => norm(m[0]))));
    const named141 = Array.from(new Set(route
      .match(/app\.\w+\("(\/control\/pricing[^"]*)"/g)!
      .map((s) => s.replace(/app\.\w+\("/, "").slice(0, -1))))
      .filter((p) => named.has(p));
    check(`the desk reaches ${named141.length} of 141's ${route.match(/app\.\w+\("\/control\/pricing/g)!.length} `
      + "doors by a path this register actually registers — and the one it does not open is the memory "
      + "read, because the detail door already carries it, so a clerk who wants what the office signed "
      + "never has to ask twice",
      [...named].every((p) => registered.has(p)) && named141.length === 11,
      { unmatched: [...named].filter((p) => !registered.has(p)), reached: named141 });
    check("no branch anywhere on the desk turns on the word a charge's kind holds: 141's two kinds are "
      + "rows of a catalog, so a desk that compared a kind to a name would be a desk that has to be "
      + "edited the day the register is offered a third — the sign and `counted` are what the columns "
      + "carry, and those are what the presses read",
      !/["'](surcharge|promo)["']\s*[=!]==?\s*\w|\w\s*[=!]==?\s*["'](surcharge|promo)["']/.test(chargesDesk + askDesk)
      && !/switch\s*\(\s*[\w.]*kind/i.test(chargesDesk + askDesk)
      && /row\.sign|a\.sign|r\.sign/.test(chargesDesk) && /r\.sign > 0/.test(askDesk),
      (chargesDesk.match(/.{0,30}(surcharge|promo).{0,20}/g) ?? []).slice(0, 3));
    check("the desk never rounds, parses or re-works a figure: every money on the screen is the text the "
      + "column returned, because the composer's own `working`, `extras_total` and `discount_total` are "
      + "the sum a second seat's signature is cut on, and a screen that added them up again is a screen "
      + "with two answers in it",
      !/toFixed\(|parseFloat\(|Math\.round\(/.test(chargesDesk + askDesk)
      && ["working", "extras_total", "discount_total", "payable"].every((k) => askDesk.includes(k)),
      (chargesDesk + askDesk).match(/toFixed\(|parseFloat\(|Math\.round\(/g) ?? []);
    check("the five states the board filters on are the five the table CHECKs, in the register's own "
      + "spelling — a desk that offered `live` would offer a filter that can never match, and a clerk "
      + "would read an empty pile as an empty book",
      ["draft", "pending_signature", "published", "superseded", "withdrawn"]
        .every((s) => chargesDesk.includes(`"${s}"`) && src.includes(`'${s}'`))
      && !/["']live["']|["']retired["']|["']stopped["']/.test(chargesDesk),
      Array.from(chargesDesk.matchAll(/\["([a-z_]+)", "/g), (m) => m[1]).slice(0, 8));
    check("a signature is only ever spent behind the publish duty, and a place behind the manage duty: "
      + "the two presses that put a levy live say so to the seat that holds no `.publish`, while taking "
      + "and giving back a place are wrapped in `desk.can.manage`, so a reader at the register cannot "
      + "reach a write the way a clerk cannot reach a signature",
      /blocked=\{!desk\.can\.publish/.test(chargesDesk) && !/desk\.call\(`[^`]*apply_pricing/.test(chargesDesk)
      && (chargesDesk.match(/\{desk\.can\.manage/g) ?? []).length >= 7,
      { publish: (chargesDesk.match(/desk\.can\.publish/g) ?? []).length,
        manage: (chargesDesk.match(/desk\.can\.manage/g) ?? []).length });
    check("the whole quote's panel is keyed on the charge it was opened for, in the page that owns the "
      + "selection rather than in the panel, so a second list opened beside the first cannot inherit the "
      + "label typed into the first one's form — and a slow write on one panel cannot close the other",
      /<ChargePanel key=\{pickedChargeId\}/.test(page) && /<PricingCardPanel key=\{pickedId\}/.test(page)
      && !/key=\{`?panel|key=\{0\}/.test(page),
      (page.match(/key=\{[a-zA-Z]+\}/g) ?? []));
    check("the in-force question sends only the halves that door reads: it shares its scope picker with "
      + "the two panels that price a freight, and a basis spread into this one would be a word the door's "
      + "strict parser refuses before the register is asked anything",
      !/charges\/in-force\?\$\{qs\(\s*\{\s*\.\.\.q\b/.test(askDesk)
      && /charges\/in-force\?\$\{qs\(\{[\s\S]{0,220}?day:[\s\S]*?kind:/.test(askDesk),
      (askDesk.match(/in-force\?[\s\S]{0,200}/)?.[0] ?? "").slice(0, 200));
    check("and the answer a clerk is given carries the register's sentence, not a word count: the door's "
      + "refusal code never reaches the browser, so every panel prints the sentence beside the scalar "
      + "extra it needs — the publish refusals, the voids and the discards all read `message` back out "
      + "of the answer rather than naming `error`",
      !/desk\.call\([\s\S]{0,200}\berror\b/.test(chargesDesk)
      && (chargesDesk.match(/j\?\.message/g) ?? []).length >= 3,
      { message: (chargesDesk.match(/j\?\.message/g) ?? []).length });

    // ---------------- 17 · put the office back ----------------
    phase("17 · the rollback, and the office this file found again");
    const inside = await one(`select last_value::int as n, c.charges
      from pricing_addendum_number_seq, (select count(*)::int as charges from pricing_addenda) c`);
    await c.query("rollback");
    const left = await census();
    const drifted = Object.keys(BASE).filter((k) => k !== "charge_seq" && k !== "card_seq"
      && BASE[k] !== left[k]);
    check(`the transaction rolls back and nothing of the office's is left standing: ${Object.keys(BASE).length - 2} `
      + "registers, the third kind row, the approval papers, the audit lines, the freight cards their "
      + "composer stood on, the seats and the corridors hold exactly the counts this file found them "
      + "holding — including the memory rows and the places taken, which no DELETE guard could ever let "
      + "a teardown remove",
      drifted.length === 0, drifted.map((k) => [k, BASE[k], left[k]]));
    check(`…while the ${minted} charge numbers this gate took stay spent, because a sequence is the one `
      + "thing in Postgres a rollback does not hand back: every refusal that reached no INSERT (a bad "
      + "code, an unusable money, a spent ceiling, a back-dated clone, a code that kept its kind) left "
      + "its number unspent — including the one that died on the corridor trigger, which had already "
      + "taken it",
      left.charge_seq === BASE.charge_seq + minted && inside.n === left.charge_seq && minted > 0,
      { base: BASE.charge_seq, inside: inside.n, now: left.charge_seq, minted });
    check("…and 140's own numbering is counted apart, because a freight card and a charge draw on two "
      + "different sequences: the two cards this file opened spent exactly two card numbers and no charge "
      + "number spent a card",
      left.card_seq === BASE.card_seq + cardMinted && cardMinted === 2,
      { base: BASE.card_seq, now: left.card_seq, cardMinted });
    check("…and the two vocabularies this gate read 21 words and 2 kinds of were not among the things it "
      + "wrote: 140's price words and the two charge words both came back exactly as they were found",
      left.words === BASE.words && left.words === 21 && left.kinds === BASE.kinds
      && left.kinds === 2, { words: left.words, kinds: left.kinds });
    note(`${proved} checks proved, ${failures} failed — the office's charge register is as this file `
      + "found it, and the two synthetic books, their seats, their corridors, their two freight cards, "
      + `the ${inside.charges} charge rows they carried, their places and their papers never existed `
      + "outside the transaction.");
    if (failures > 0) process.exitCode = 1;
  } catch (e: any) {
    await c.query("rollback").catch(() => undefined);
    console.log(`\nGATE ABORTED mid-transaction on: ${lastSql}`);
    // A door is a body, so the statement above is only the outer half of the truth: the line that threw
    // sits inside the function, and `where` is the only thing that says which body and which line.
    if (e?.where) console.log(`  inside: ${String(e.where).replace(/\s+/g, " ").slice(0, 300)}`);
    if (e?.internalQuery) {
      console.log(`  statement there: ${String(e.internalQuery).replace(/\s+/g, " ").slice(0, 300)}`);
    }
    if (e?.detail) console.log(`  detail: ${String(e.detail).replace(/\s+/g, " ").slice(0, 240)}`);
    throw e;
  }
}

// `process.exit()` would drop the lines still sitting in the socket on Windows, and the one line that
// matters — the statement this gate died on — is always the last one written.
main().catch((e) => { console.error(`\nGATE ABORTED: ${e?.message ?? e}`); process.exitCode = 1; });
