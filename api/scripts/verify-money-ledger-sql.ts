/**
 * Live proof for #344b — the double-entry book (migration 133, and from #344c
 * `api/src/routes/control-money.routes.ts` once the desk exists).
 *
 * This file exists because of where 133's rules are kept, and because of when one of them runs.
 *
 * The book's central rule is that a movement balances. It is not a column, not a check on one row,
 * not a line in the door — it is a DEFERRED constraint trigger, because the whole set of legs only
 * exists when the transaction closes. That makes it the one rule in this repository which cannot be
 * proved by inserting a row and reading it back: inside a transaction an unbalanced posting is
 * perfectly legal, and it is the COMMIT that refuses it. So phase 10 opens a transaction for real,
 * five times, and expects the server to say no. A commit refused by a deferred trigger is rolled
 * back by the server itself, which is why this gate can prove the rule and still leave nothing.
 *
 * Where the rules are kept also decides the shape of this file. The API reaches the book through
 * nine definers, and a definer is a narrow door: it takes a book, a seat, a day and a set of legs,
 * and it derives the figure, the number and the totals. So an HTTP walk cannot hand the database a
 * lying row — and every rule that decides whether a row is honest lives in a trigger below the door.
 * "A leg is never rewritten", "a movement is deleted by nobody", "a frozen account takes no leg in
 * either direction", "a leg does not reach into another book" and "the cached figure is not the
 * book's answer" are only reachable by writing the row itself, so this gate writes the rows.
 *
 * The consequence, and the reason phases 1 to 9 and 12 run inside one transaction that is rolled
 * back at phase 13: a posting cannot be tidied up afterwards. `money_postings` refuses DELETE and
 * `money_entries` refuses UPDATE, so one movement left behind by a verification script sits in the
 * office's ledger for good, and its only repair is a reversal that records the script in the book.
 * So the only movement this gate ever commits is one the server refuses to keep. The three fixture
 * books are companies, never the office: the door proofs, the doomed commits and the app_runtime
 * probes all write into a synthetic register, where a check that failed to refuse would corrupt a
 * company's book and shout about it in phase 13 instead of quietly signing the office's ledger.
 *
 * It is also the only way an edited 133 reaches dev: 133 is already recorded in `schema_migrations`,
 * so `pnpm migrate` will never run it again. Phase 0 re-executes the file's function bodies, its
 * index lines and its privilege lines, and commits them only under `--apply`. The file's own
 * `begin;`/`commit;` are never run — a COMMIT inside the rehearsal would end the rehearsal, and the
 * rollback that followed would be a warning about nothing.
 *
 * Run: npx tsx scripts/verify-money-ledger-sql.ts          (from api/, rehearses and rolls back)
 *      npx tsx scripts/verify-money-ledger-sql.ts --apply  (133's DDL re-applied to dev)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { URL as url_URL } from "node:url";
import pg from "pg";

const FILE = "migrations/133_the_book_that_balances_itself.sql";
const ROUTE = "src/routes/control-money.routes.ts";
const PROBE = "src/routes/control-analytics.routes.ts";
const APPLY = process.argv.includes("--apply");

const HEX = randomUUID().replace(/-/g, "");
const STAMP = `133sql${HEX.slice(0, 6)}`;
const CODE = (who: string) => `gate-${who}-${STAMP}`;
const BOOK = (who: string) => `Ledger Gate ${who} ${STAMP}`;
const EMAIL = (who: string) => `ledger.${who}.${STAMP}@waisha.test`;
const MEMO = (what: string) => `Ledger Gate ${STAMP} ${what}`;

const DAY = "2026-10-20";
const REASON = "The office stopped this account pending an explanation.";
const ANOTHER = "A second sentence, offered by a desk that was refused.";
const UNDO = "The desk paid the wrong line and is saying so on the papers.";

const KINDS = ["adjustment", "cost", "escrow", "fee", "invoice", "manual", "opening", "payroll",
  "payout", "payment", "refund", "reversal", "tax"];
const MONIES = ["TZS", "USD"];
const SIDES = ["credit", "debit"];
const ACCOUNT_KINDS = ["asset", "equity", "expense", "income", "liability"];
const CHART = ["COST-OPS", "ESCROW-TZS", "FEE-INCOME", "GATE-WAIT", "OPS-BANK", "OPS-CASH",
  "OPS-USD", "PAYOUT-DUE", "REFUND-DUE", "WALLET-TZS"];

const DOORS = ["open_money_account", "freeze_money_account", "record_money_posting",
  "reverse_money_posting", "money_account_row", "money_book", "money_register",
  "money_posting_detail", "money_book_is_square"];
const BODIES = ["prevent_money_entry_mutation", "money_posting_keeps_its_words",
  "money_leg_names_its_own_book", "money_totals_follow_the_legs", "posting_balances_at_commit"];
const ALL_FNS = [...DOORS, ...BODIES];
const REGISTERS = ["money_accounts", "money_postings", "money_entries"];

let failures = 0;
let proved = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) proved++; else failures++;
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok ? "" : " — "
    + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`);
}
function note(msg: string) { console.log(`!!   ${msg}`); }
function phase(t: string) { console.log(`\n--- ${t}`); }
/** Order-insensitive equality. Every list below comes out of a CHECK, and a CHECK's alternation is
 *  a set, not a sequence: the migration writes `('debit','credit')` while the alphabet reads
 *  `credit, debit`, and a gate that compared the two by position would fail on a file that is right. */
const same = (a: string[], b: string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && y.every((w, i) => x[i] === w);
};
/** The same list read from places that disagree about case: a money is `TZS` on the desk and `tzs`
 *  in the deparser's output, and only a comparison that knows that can tell a real drift from a
 *  typographic one. */
const sameFold = (a: string[], b: string[]) =>
  same(a.map((w) => w.toLowerCase()), b.map((w) => w.toLowerCase()));

/** The quoted words of a CHECK, as `pg_get_constraintdef` prints them. Every definition read below
 *  is lower-cased on the way in, because the deparser writes `IS NOT NULL`, `Btrim` and `ARRAY` in
 *  its own case while the needles are the words the migration was typed in. */
function quoted(def: string): string[] {
  return [...def.matchAll(/'([a-z_0-9]+)'(?:::text)?/g)].map((m) => m[1]);
}

function wordsFor(cons: { conname: string; def: string }[], name: string): string[] {
  const hit = cons.find((c) => c.conname === name);
  return hit ? quoted(hit.def) : [];
}

/** A word list written inside the migration itself — the door's own vocabulary, read the way the
 *  gate reads the catalog's. The two have to agree, and nothing but a file and a query can say so.
 *  The words come back lower-cased because that is how the catalog side of the comparison is read:
 *  `lower(pg_get_constraintdef(...))` prints the `TZS` the CHECK stores as `tzs`, and a word that
 *  changes case in transit is not a different word. */
function wordsInList(src: string, start: string): string[] {
  const a = src.indexOf(start);
  if (a < 0) return [];
  const rest = src.slice(a + start.length);
  const close = rest.indexOf(")");
  if (close < 0) return [];
  return [...rest.slice(0, close).matchAll(/'([a-z_0-9]+)'/gi)].map((m) => m[1].toLowerCase());
}
function wordsOf(src: string, name: string): string[] {
  const m = src.match(new RegExp(`const ${name}[^=]+=\\s*\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/["']([a-z_.]+)["']/g)].map((x) => x[1]) : [];
}
/** A desk's zod enum, read out of the route file. Case is folded because the two monies are spelled
 *  upper — `["TZS","USD"]` is the same pair the book keeps, and a reader that only saw lower-case
 *  words would report the desk as sending no currency at all. */
function zodEnum(src: string, name: string): string[] {
  const m = src.match(new RegExp(`const ${name}[^=]+=\\s*z\\.enum\\(\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/["']([a-z_0-9]+)["']/gi)].map((x) => x[1].toLowerCase()) : [];
}

const SPELL: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20
};

/** One `create or replace function … $$;` block at a time. A whole migration file cannot be re-run,
 *  because `create index` and `create trigger` have no idempotent form for every shape — but 133's
 *  function bodies, its privilege lines and its index lines (which are all `if exists`) can, and
 *  those three are exactly what an in-place edit to a recorded migration ever touches. Three of the
 *  fourteen bodies are `language sql`, which ends at `$$;` rather than at `end $$;`, so a scanner
 *  that looked for one terminator alone would swallow the next function into the previous one. */
function functionDdl(src: string): string[] {
  const out: string[] = [];
  const re = /^create or replace function platform_auth\.[a-z_]+\(/gm;
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
/** The text between a function's dollar quotes, with whitespace collapsed — the shape both the file
 *  and `pg_get_functiondef` agree on, so a body can be compared to the body the platform is running.
 *  Comments are kept by both, which is what makes the comparison strict enough to be worth making. */
function bodyOf(block: string): string {
  const open = block.match(/\$\w*\$/);
  if (!open || open.index === undefined) return "";
  const tag = open[0];
  const close = block.indexOf(tag, open.index + tag.length);
  if (close < 0) return "";
  return block.slice(open.index + tag.length, close).replace(/\s+/g, " ").trim();
}
/** 133's fourteen bodies, keyed by name, as the file writes them. */
function fileBodies(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of functionDdl(src)) {
    const name = /platform_auth\.([a-z_]+)\(/.exec(b)?.[1];
    if (name) out[name] = bodyOf(b);
  }
  return out;
}
function indexDdl(src: string): string[] {
  return [...src.matchAll(
    /^(create (?:unique )?index if not exists [^;]+;|drop index if exists [^;]+;)/gm
  )].map((m) => m[0]);
}
/** A door whose argument list changes is not replaced — `create or replace` adds a second function
 *  and the old one stays in the catalog with its grants. 133 drops the one-argument account reader by
 *  name, and a rehearsal that skipped the drop would leave dev holding a door the file no longer has. */
function dropDdl(src: string): string[] {
  return [...src.matchAll(/^drop function if exists [^;]+;/gm)].map((m) => m[0]);
}
function stmtBetween(src: string, start: string, stop: string): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`statement not found: ${start}`);
  const b = src.indexOf(stop, a);
  if (b < 0) throw new Error(`statement does not end with: ${stop}`);
  return src.slice(a, b + stop.length);
}

/** app_runtime URL: dev hands us the owner URL, so rebuild it (066's shape). The password is read
 *  from the environment and never printed — every value in `api/.env` has already leaked once. */
function appUrl(): string | null {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  const u = new url_URL(url);
  if (u.username.startsWith("app_runtime")) return url;
  if (!process.env.APP_DB_PASSWORD) return null;
  const ref = u.username.split(".")[1];
  u.username = "app_runtime" + (ref ? "." + ref : "");
  u.password = encodeURIComponent(process.env.APP_DB_PASSWORD);
  return u.toString();
}

const POST_SQL = `select platform_auth.record_money_posting(
  $1::uuid, $2::date, $3, $4, $5, $6::uuid, $7, $8, $9::uuid, $10::jsonb) as r`;
const REVERSE_SQL = `select platform_auth.reverse_money_posting($1, $2, $3, $4) as r`;
const FREEZE_SQL = `select platform_auth.freeze_money_account($1, $2, $3, $4, $5) as r`;
const OPEN_SQL = `select platform_auth.open_money_account($1, $2, $3, $4, $5, $6, $7) as r`;
const BOOK_SQL = `select platform_auth.money_book($1) as r`;
const SQUARE_SQL = `select platform_auth.money_book_is_square($1) as r`;
const DETAIL_SQL = `select platform_auth.money_posting_detail($1, $2) as r`;
const REGISTER_SQL = `select platform_auth.money_register($1, $2, $3, $4, $5, $6, $7) as r`;

/** The legs, in the shape the door takes them: a uuid, a side, and a figure sent as a string so
 *  that no float is ever allowed to decide what the book says it moved. */
const L = (account: string, direction: string, amount: string, detail?: string) =>
  ({ account, direction, amount, ...(detail ? { detail } : {}) });

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  const src = readFileSync(FILE, "utf8");
  const routeSrc = existsSync(ROUTE) ? readFileSync(ROUTE, "utf8") : "";
  const probeSrc = readFileSync(PROBE, "utf8");

  // ---------------- 0 · the file, executed ----------------
  phase("0 · 133's bodies, its index lines and its privileges re-execute against the live catalog");
  const ddl = functionDdl(src);
  const idx = indexDdl(src);
  const dropped = dropDdl(src);
  const priv = [
    stmtBetween(src, "revoke all on function\n  platform_auth.prevent_money_entry_mutation",
      "from public, anon, authenticated, app_runtime;"),
    stmtBetween(src, "grant execute on function", "to app_runtime;"),
    stmtBetween(src, "revoke all on function\n  platform_auth.open_money_account",
      "from public, anon, authenticated, service_role;")
  ];
  const replayed = [...dropped, ...ddl, ...idx, ...priv].join("\n");
  check("133 opens and closes its own transaction, and this gate replays neither half of that pair",
    /^begin;$/m.test(src) && /^commit;$/m.test(src) && !/^(begin|commit);$/m.test(replayed),
    (src.match(/^(begin|commit);$/gm) ?? []));
  check(`the file declares ${ddl.length} functions and this gate found every one of them`,
    ddl.length === (src.match(/^create or replace function platform_auth\./gm) ?? []).length
    && ddl.length === 14, ddl.length);
  check("…the five trigger bodies and the nine doors are cut apart, not run together",
    ddl.length === 14
    && BODIES.every((b) => ddl.some((d) => d.startsWith(`create or replace function platform_auth.${b}(`)))
    && DOORS.every((d) => ddl.some((d2) => d2.startsWith(`create or replace function platform_auth.${d}(`))),
    ddl.map((d) => d.slice(38, 60)));
  check("…and the three `language sql` readers end at their own `$$;`, so none of them swallowed "
    + "the function after it", ddl.filter((d) => /\nend \$\$;$/.test(d)).length === 11,
    ddl.filter((d) => !/\nend \$\;$/.test(d)).map((d) => d.slice(38, 62)));
  check("…no body of 133 was written to count rows the Oracle way, which is legal to create and "
    + "fatal to run", !/%rowcount/i.test(replayed),
    (replayed.match(/.{0,40}%rowcount.{0,20}/i) ?? [""])[0]);

  const runner = new pg.Client({
    connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 300000
  });
  await runner.connect();
  const recorded = (await runner.query(
    `select name from schema_migrations where name like '133%'`)).rows;
  check("133 is already recorded, which is why an edited 133 needs this file rather than "
    + "`pnpm migrate`", recorded.length === 1, recorded);
  let err: any = null;
  await runner.query("begin");
  try {
    for (const s of dropped) await runner.query(s);
    for (const block of ddl) await runner.query(block);
    for (const s of idx) await runner.query(s);
    for (const p of priv) await runner.query(p);
  } catch (e) { err = e; }
  if (!err && APPLY) await runner.query("commit"); else await runner.query("rollback");
  check(`the ${dropped.length} drop, the ${ddl.length} bodies, the ${idx.length} index lines and the `
    + `${priv.length} privilege statements run together`
    + `${APPLY ? " and are committed" : " and are rolled back"}`, !err, err?.message);
  check("…and `create or replace` left every door's grant list alone — a drop-and-create would "
    + "have reset EXECUTE to PUBLIC", !err, err?.message);
  await runner.end();
  if (err) { console.log(`\n133's own DDL does not run. Nothing below this line is proved.`); process.exit(1); }

  // ---------------- three books that are not the office's ----------------
  const PLAT = (await (await connect(url)).query(
    `select id from tenants where type = 'platform' and deleted_at is null limit 1`)).rows[0]?.id;
  if (!PLAT) throw new Error("no platform tenant to hold the office's book");

  // Fixtures that must be COMMITTED: phase 10 opens its own transaction on a separate connection,
  // and a doomed commit cannot see a book that another connection has not finished writing.
  const fixt = await connect(url);
  /** A rehearsal that was killed part way through leaves its books, seats and chart committed, and
   *  this run's teardown cannot reach them: the uuids are minted afresh every time. They are cleared
   *  by the words this file puts into them and by nothing looser — 133's own office chart has a
   *  `GATE-WAIT` account, so a sweep on `code ilike 'gate-%'` would delete a line the desk needs. A
   *  leftover is matched by its book, or by a code that carries this file's stamp, and by nothing
   *  else. */
  const sweep = async (what: string, sql: string) => {
    try {
      const n = (await fixt.query(sql)).rowCount ?? 0;
      if (n) note(`an earlier rehearsal left ${n} ${what} behind, and they are cleared before this `
        + "run opens its own — a gate that cannot tell its leftovers from its fixtures would report "
        + "a dirty dev book as though 133 had leaked it");
      return n;
    } catch (e: any) {
      check(`the run cannot clear an earlier rehearsal's ${what}`, false,
        String(e.message).split("\n")[0]);
      return -1;
    }
  };
  const LEFT = `where tenant_id in (select id from tenants where name like 'Ledger Gate %')`;
  await sweep("leg of a leftover book", `delete from money_entries ${LEFT}`);
  await sweep("movement of a leftover book", `delete from money_postings ${LEFT}`);
  await sweep("account of a leftover book", `delete from money_accounts ${LEFT}
     or code ilike '%133sql%'`);
  await sweep("seat of a leftover book", `delete from users
     where email like '%.133sql%@waisha.test'`);
  await sweep("book of a leftover rehearsal", `delete from tenants
     where name like 'Ledger Gate %' and type <> 'platform'`);

  /** The committed state of the book before this file touches it, taken after the sweep so that it
   *  is the book the office would recognise rather than the book plus somebody's crashed rehearsal.
   *  Phase 13 reads it again after its own teardown, so the gate can say what it left behind instead
   *  of asserting that a dev database is empty — which stops being true the day #344c writes a real
   *  movement. */
  const BASE = Object.fromEntries((await fixt.query(
    `select 'postings' as k, count(*)::int as n from money_postings
     union all select 'legs', count(*)::int from money_entries
     union all select 'accounts', count(*)::int from money_accounts
     union all select 'seq', last_value::int from money_posting_number_seq`)).rows
    .map((r: any) => [r.k, r.n])) as Record<string, number>;

  const TB = randomUUID(), TD = randomUUID(), TR = randomUUID();
  const PEN = randomUUID(), QUILL = randomUUID(), ASH = randomUUID(), INK = randomUUID();
  const BOOKS = [TB, TD, TR];
  await fixt.query(`insert into tenants (id, type, name, status) values
      ($1,'transporter',$2,'active'), ($3,'transporter',$4,'active'), ($5,'transporter',$6,'active')`,
    [TB, BOOK("Trader"), TD, BOOK("Doomed"), TR, BOOK("Runtime")]);
  await fixt.query(`insert into users (id, tenant_id, user_type, full_name, status, email) values
      ($1,$2,'platform','Ledger Pen','active',$3),
      ($4,$5,'director','Ledger Quill','active',$6),
      ($7,$8,'director','Ledger Ash','active',$9),
      ($10,$11,'director','Ledger Ink','active',$12)`,
    [PEN, PLAT, EMAIL("pen"), QUILL, TB, EMAIL("quill"), ASH, TD, EMAIL("ash"),
      INK, TR, EMAIL("ink")]);
  const openF = async (tenant: string, code: string, label: string, kind: string,
    currency: string, actor: string, why?: string) => {
    const r = (await fixt.query(OPEN_SQL,
      [tenant, code, label, kind, currency, why ?? null, actor])).rows[0]?.r as Record<string, any>;
    if (r?.code !== code.toUpperCase()) throw new Error(`fixture account ${code} came back ${r?.code}`);
    return r;
  };
  // A code is `^[A-Z0-9][A-Z0-9_-]{1,29}$`, so a fixture name is spelled with dashes and never with
  // the space a desk would type and the door would refuse.
  const GATE_IN = await openF(TB, CODE("in"), "Gate money in (TZS)", "asset", "TZS", QUILL,
    "Opened by the gate to prove the door works on a company's own book.");
  const GATE_OUT = await openF(TB, CODE("out"), "Gate money out (TZS)", "asset", "TZS", QUILL);
  const GATE_USD = await openF(TB, CODE("usd"), "Gate dollars (USD)", "asset", "USD", QUILL);
  const GATE_STOP = await openF(TB, CODE("stop"), "Gate stopped account", "asset", "TZS", QUILL);
  const DOOM_IN = await openF(TD, "doom-in", "Doomed money in", "asset", "TZS", ASH);
  const DOOM_OUT = await openF(TD, "doom-out", "Doomed money out", "asset", "TZS", ASH);
  const RUN_IN = await openF(TR, "run-in", "Runtime money in", "asset", "TZS", INK);
  const RUN_OUT = await openF(TR, "run-out", "Runtime money out", "asset", "TZS", INK);
  await fixt.end();

  const owner = await connect(url);
  const tidy = await connect(url);
  try {
    await run(url, src, routeSrc, probeSrc, owner, tidy, PLAT,
      { TB, TD, TR, PEN, QUILL, ASH, INK, GATE_IN, GATE_OUT, GATE_USD, GATE_STOP,
        DOOM_IN, DOOM_OUT, RUN_IN, RUN_OUT, BOOKS, BASE });
  } finally {
    // Both sockets go here. `tidy` outlives every check because the teardown reads it after the
    // rollback, and a run that prints its verdict and then keeps the process alive reads to the next
    // stage as a gate still running — one such pass cost half an hour of waiting on a green file.
    await owner.end().catch(() => undefined);
    await tidy.end().catch(() => undefined);
  }
}

async function connect(url: string) {
  const c = new pg.Client({
    connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 180000
  });
  await c.connect();
  return c;
}

type Book = Record<string, any>;

async function run(url: string, src: string, routeSrc: string, probeSrc: string,
  owner: pg.Client, tidy: pg.Client, PLAT: string, F: Record<string, any>) {
  const TB = F.TB as string, TD = F.TD as string, TR = F.TR as string;
  const PEN = F.PEN as string, QUILL = F.QUILL as string, ASH = F.ASH as string;
  const INK = F.INK as string, BOOKS = F.BOOKS as string[];
  const GATE_IN = F.GATE_IN as Book, GATE_OUT = F.GATE_OUT as Book, GATE_USD = F.GATE_USD as Book;
  const GATE_STOP = F.GATE_STOP as Book;
  const DOOM_IN = F.DOOM_IN as Book, DOOM_OUT = F.DOOM_OUT as Book;
  const RUN_IN = F.RUN_IN as Book, RUN_OUT = F.RUN_OUT as Book;

  // The committed state of the book before anything here runs, read in `main()` ahead of the
  // fixtures it minted — see the note above the capture.
  const BASE = F.BASE as Record<string, number>;

  // Phases 1 to 9 and 12 are one transaction, rolled back at phase 13. Every statement of every
  // phase is wrapped in a savepoint: a raised trigger aborts the transaction, and every query after
  // that would answer "current transaction is aborted" instead of the question it was asked.
  await owner.query("begin");
  const oi = (sql: string, p: any[] = []) => owner.query(sql, p);
  const one = async (sql: string, p: any[] = []) => (await oi(sql, p)).rows[0];
  let sp = 0;
  const guarded = async (sql: string, p: any[] = []) => {
    const name = `s${++sp}`;
    await oi(`savepoint ${name}`);
    try {
      const rows = (await oi(sql, p)).rows;
      await oi(`release savepoint ${name}`);
      return { rows, err: null as any };
    } catch (e: any) {
      await oi(`rollback to savepoint ${name}`);
      return { rows: null as any, err: e };
    }
  };
  /** Some rules are only true as a pair of statements — a half movement plus the question asked
   *  early — so they get one savepoint for the whole pair rather than one for each. */
  const block = async (stmts: [string, any[]][]) => {
    const name = `s${++sp}`;
    await oi(`savepoint ${name}`);
    let last: any[] = [];
    try {
      for (const [sql, p] of stmts) last = (await oi(sql, p)).rows;
      await oi(`release savepoint ${name}`);
      return { rows: last, err: null as any };
    } catch (e: any) {
      await oi(`rollback to savepoint ${name}`);
      return { rows: null as any, err: e };
    }
  };
  /** `want` is either a constraint name or a piece of the sentence, and the two are told apart by
   *  their shape: a constraint is one lowercase word with underscores, and no refusal an operator
   *  is meant to read is written like that. A CHECK or a UNIQUE violation names itself in the
   *  error's own field; a foreign key writes the name into its message and leaves the field empty,
   *  so a named rule is accepted from either place. */
  const fails = async (label: string, sql: string, p: any[] = [], want = "") => {
    const { err } = await guarded(sql, p);
    check(label, !!err, err ? "" : "expected a refusal, and the statement succeeded");
    if (err && want) {
      const named = /^[a-z0-9_]+$/.test(want);
      const hit = named ? (err.constraint === want
        || String(err.message).includes(want)) : String(err.message).includes(want);
      check(`…by ${want}`, hit, { constraint: err.constraint, message: err.message });
    }
    return err;
  };
  /** The same refusal asked of a statement built by `hdr`/`leg`, which hand back a pair. */
  const refuses = (label: string, st: [string, any[]], want = "") =>
    fails(label, st[0], st[1], want);
  const okDo = async (label: string, sql: string, p: any[] = []) => {
    const { err, rows } = await guarded(sql, p);
    if (err) check(`${label} — it raised`, false, err.message);
    return rows as Record<string, any>[];
  };
  /** A definer answers with a jsonb value, so its refusal is read rather than caught. A door that
   *  raises instead of answering is a different fault and is labelled as one. */
  const call = async (label: string, sql: string, p: any[] = []) => {
    const { err, rows } = await guarded(sql, p);
    if (err) {
      check(`${label} — the door raised instead of answering`, false, err.message);
      return null as Book | null;
    }
    return (rows?.[0]?.r ?? null) as Book | null;
  };
  /** The door that posts a movement, used here only for the movements that are supposed to happen.
   *  It runs inside the gate's own transaction, so nothing it writes can outlive the run. */
  let posted = 0;
  const post = async (label: string, tenant: string, actor: string, legs: any[],
    o: Record<string, any> = {}) => {
    posted++;
    const r = await call(label, POST_SQL, [tenant, o.day ?? DAY,
      o.memo ?? MEMO(`movement number ${posted}`), o.currency ?? "TZS",
      o.kind ?? "manual", o.sourceId ?? null, o.sourceRef ?? null, o.idem ?? null, actor,
      JSON.stringify(legs)]);
    check("…the door took it", r?.ok === true && r?.replayed === false, r);
    return r?.posting as Book;
  };

  // ---------------- 1 · the shape of the book ----------------
  phase("1 · the shape of the book, read out of the catalog");
  const cons = (await oi(`select conrelid::regclass::text as tbl, conname, contype,
      lower(pg_get_constraintdef(oid)) as def
    from pg_constraint
    where conrelid = any($1::regclass[])
    order by 1,2`, [REGISTERS])).rows as { tbl: string; conname: string; contype: string;
    def: string }[];
  const cols = (await oi(`select table_schema || '.' || table_name as tbl, column_name as col,
      data_type as type,
      coalesce(numeric_precision, 0) as prec, coalesce(numeric_scale, 0) as scale,
      is_nullable as nul
    from information_schema.columns where table_name = any($1) order by 1,2`,
    [REGISTERS])).rows as Record<string, any>[];
  const idxRows = (await oi(`select tablename as tbl, indexname as name, lower(indexdef) as def
    from pg_indexes where tablename = any($1) order by 1,2`, [REGISTERS])).rows;
  const trigRows = (await oi(`select tgname as name, lower(pg_get_triggerdef(oid)) as def,
      tgrelid::regclass::text as tbl
    from pg_trigger where tgrelid = any($1::regclass[]) and not tgisinternal order by 1`,
    [REGISTERS])).rows;
  const grants = (await oi(`select c.relname as register,
      case when a.grantee = 0 then 'PUBLIC' else gr.rolname end as who,
      array_agg(distinct a.privilege_type order by a.privilege_type) as what
    from pg_class c cross join aclexplode(c.relacl) a
    left join pg_roles gr on gr.oid = a.grantee
    where c.relname = any($1) group by 1,2 order by 1,2`, [REGISTERS])).rows;
  const fnGrants = (await oi(`select p.proname as name,
      case when a.grantee = 0 then 'PUBLIC' else gr.rolname end as who,
      array_agg(distinct a.privilege_type order by a.privilege_type) as what
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join aclexplode(p.proacl) a left join pg_roles gr on gr.oid = a.grantee
    where n.nspname = 'platform_auth' and p.proname = any($1::text[])
    group by 1,2 order by 1,2`, [ALL_FNS])).rows;
  const fnDefs = (await oi(`select p.proname as name, p.prosecdef as definer,
      p.oid::regprocedure::text as sig,
      coalesce(array_to_string(p.proconfig, ','), '') as cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform_auth' and p.proname = any($1::text[]) order by 1`,
    [ALL_FNS])).rows;
  check("fourteen functions, and fourteen only: a door whose argument list changed is a SECOND "
    + "function, not a replaced one, so the old shape would still be in the catalog holding its own "
    + "grants", fnDefs.length === 14 && ALL_FNS.every((f) => fnDefs.filter((d: any) => d.name === f)
    .length === 1), fnDefs.map((d: any) => d.sig));
  const CLIENTS = ["app_runtime", "anon", "authenticated", "service_role", "PUBLIC"];

  // The stale-dev trap. 133 is already recorded in `schema_migrations`, so editing the file does not
  // change what the platform runs until `--apply` re-executes it — and a gate that then tested the
  // old bodies would report the old bodies' behaviour as though it had proved the file. This run
  // found the trap real: dev was holding a leg guard that read `v_account.tenant_id` from a record
  // its own select list never filled, which raises 42703 on every leg written.
  const liveBodies = (await oi(`select p.proname as name, pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform_auth' and p.proname = any($1::text[]) order by 1`,
  [ALL_FNS])).rows;
  const asWritten = fileBodies(src);
  const drift = liveBodies.filter((r: any) => asWritten[r.name] !== bodyOf(r.def));
  check("the fourteen bodies the platform is running are byte-for-byte the fourteen in the file, so "
    + "everything below is a statement about this file and not about a draft somebody left on dev",
    drift.length === 0 && ALL_FNS.every((f) => !!asWritten[f]),
    { differ: drift.map((d: any) => d.name), apply: "run with --apply to put the file's bodies on "
      + "the platform, then run this gate again" });

  check("the three registers are one book: the chart, the movements and the legs",
    REGISTERS.every((t) => cols.some((c) => c.tbl === `public.${t}`)),
    [...new Set(cols.map((c) => c.tbl))]);
  check("every one of them is row-security-bound to a book, and the policy binds the one setting "
    + "the API is told to set",
    (await one(`select count(*)::int as n from pg_policies
      where tablename = any($1)
        and lower(qual::text) like '%current_setting(''app.tenant_id''%'
        and lower(with_check::text) like '%current_setting(''app.tenant_id''%'`, [REGISTERS]))?.n === 3
    && (await one(`select count(*)::int as n from pg_class where relname = any($1)
      and relrowsecurity`, [REGISTERS]))?.n === 3,
    await oi(`select tablename, policyname, cmd, roles::text as who from pg_policies
      where tablename = any($1)`, [REGISTERS]));
  check("…and a policy is not the guard: the app role is granted SELECT and nothing else, so the "
    + "doors are the only way in",
    REGISTERS.every((t) => {
      const forT = grants.filter((g: any) => g.register === t);
      const app = forT.find((g: any) => g.who === "app_runtime");
      return app?.what.join(",") === "SELECT"
        && !forT.some((g: any) => ["anon", "authenticated", "service_role", "PUBLIC"].includes(g.who));
    }), JSON.stringify(grants));
  check("…which is why 133's own sweep cannot be satisfied by a write grant: no role a client can "
    + "be holds INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER on the book",
    !grants.some((g: any) => CLIENTS.includes(g.who) && g.what.some((w: string) =>
      ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].includes(w))),
    JSON.stringify(grants));

  check("the chart is keyed per book, so two offices may both call an account OPS-CASH",
    cons.some((c) => c.conname === "money_accounts_code_per_book"
      && c.def === "unique (tenant_id, code)"),
    cons.find((c) => c.conname === "money_accounts_code_per_book")?.def);
  check("…and a movement's number is unique across every book, because a person says it out loud "
    + "on the phone",
    cons.some((c) => c.conname === "money_postings_ref_key" && c.def === "unique (ref)"),
    cons.filter((c) => c.def.startsWith("unique")).map((c) => [c.conname, c.def]));
  check("the number itself is shaped, not merely unique: PST-, four digits, five digits or more",
    /ref ~ '\^pst-\[0-9\]\{4\}-\[0-9\]\{5,\}\$'/.test(
      cons.find((c) => c.conname === "money_postings_ref_check")?.def ?? ""),
    cons.find((c) => c.conname === "money_postings_ref_check")?.def);
  check("…and it is minted from its own sequence, which the app role may use and read but cannot "
    + "write the row it numbers",
    (await one(`select count(*)::int as n from pg_class where relname = 'money_posting_number_seq'
      and relkind = 'S'`))?.n === 1
    && (await one(`select count(*)::int as n from pg_class c
      cross join aclexplode(c.relacl) a join pg_roles r on r.oid = a.grantee
      where c.relname = 'money_posting_number_seq' and r.rolname = 'app_runtime'`))?.n === 2,
    await one(`select relacl::text as acl from pg_class where relname = 'money_posting_number_seq'`));
  // Recorded rather than asserted, because it is a fact about this server rather than about 133:
  // `information_schema.sequence_usage` is not present here at all, so a dependency check copied from
  // the SQL standard would not merely have missed a sequence that is only ever advanced inside a
  // function — it would have refused to run. The gate reads pg_class and pg_proc instead.
  const seqUsage = await guarded(
    `select count(*)::int as n from information_schema.sequence_usage where object_name = $1`,
    ["money_posting_number_seq"]);
  note("…and the sequence's user is proved from `pg_class` and the door's own body, because "
    + "`information_schema.sequence_usage` answers this book with "
    + (seqUsage.err ? `${seqUsage.err.code} (${String(seqUsage.err.message).split("\n")[0]})`
      : `"${seqUsage.rows?.[0]?.n ?? "?"} row(s)"`)
    + " — the standard view is not exposed here, so a dependency gate must not lean on it");

  check("a retry of the same request is refused by the row, per book, and only when a key was given",
    idxRows.some((i: any) => i.name === "money_postings_idempotency_per_book"
      && i.def.startsWith("create unique index money_postings_idempotency_per_book")
      && i.def.includes("using btree (tenant_id, idempotency_key)")
      && i.def.includes("where (idempotency_key is not null)")),
    idxRows.find((i: any) => i.name === "money_postings_idempotency_per_book")?.def);

  const money = cols.filter((c) => c.type === "numeric");
  check("every figure in the book is numeric(14,2): a money column typed as a float is a rounding "
    + "error waiting for a Friday",
    money.length === 4 && money.every((c) => c.prec === 14 && c.scale === 2),
    money.map((c) => [c.tbl, c.col, `${c.prec},${c.scale}`, c.type]));
  check("…and there is no float anywhere in the three registers, not even a `real` in a column that "
    + "sounds harmless",
    !cols.some((c) => ["real", "double precision"].includes(c.type)),
    JSON.stringify(cols.filter((c) => /float|real|double/.test(c.type))));
  check("a leg is positive and says which side it is on, so `debit` and `credit` never have to be "
    + "inferred from a sign",
    cons.some((c) => c.conname === "money_entries_amount_check"
      && c.def.includes("amount > (0)::numeric"))
    && same(wordsFor(cons, "money_entries_direction_check"), SIDES),
    cons.filter((c) => c.tbl === "public.money_entries").map((c) => c.conname));
  check("…while a running total may be zero, because an account that has settled is a real thing",
    cons.some((c) => c.conname === "money_accounts_debit_total_check"
      && c.def.includes(">= (0)::numeric"))
    && cons.some((c) => c.conname === "money_accounts_credit_total_check"),
    cons.filter((c) => /total_check/.test(c.conname)).map((c) => c.def));

  check("the paper a movement stands for is a pointer, not a foreign key — 129's erasure must not "
    + "be able to reach the book through an invoice",
    !cons.some((c) => c.conname === "money_postings_source_id_fkey")
    && cols.some((c) => c.tbl === "public.money_postings" && c.col === "source_id"
      && c.nul === "YES"),
    cons.filter((c) => c.contype === "f").map((c) => c.conname));
  const fks = cons.filter((c) => c.contype === "f").map((c) => c.conname).sort();
  check("…while the seats and the rows a leg has to join really are foreign keys",
    ["money_accounts_frozen_by_fkey", "money_accounts_tenant_id_fkey",
      "money_entries_account_id_fkey", "money_entries_posting_id_fkey",
      "money_entries_tenant_id_fkey", "money_postings_raised_by_fkey",
      "money_postings_reversed_by_fkey", "money_postings_tenant_id_fkey"]
      .every((k) => fks.includes(k)), fks);
  check("…and the leg's own joins are the ones that make a lying row impossible rather than merely "
    + "unlikely: it cannot name a movement that is not there",
    cons.some((c) => c.conname === "money_entries_posting_id_fkey"
      && c.def === "foreign key (posting_id) references money_postings(id)")
    && cons.some((c) => c.conname === "money_entries_account_id_fkey"
      && c.def === "foreign key (account_id) references money_accounts(id)"),
    cons.filter((c) => c.conname.includes("entries_")).map((c) => c.def));

  check("a freeze is explained in the row that carries it, in both directions",
    cons.some((c) => c.conname === "money_account_freeze_is_explained"
      && c.def === "check (((status = 'frozen'::text) = (frozen_reason is not null)))"),
    cons.find((c) => c.conname === "money_account_freeze_is_explained")?.def);
  check("…and a reversal is, too — a movement cannot be marked undone without the sentence that "
    + "says why and the seat that said it",
    cons.some((c) => c.conname === "money_posting_reversal_is_explained"
      && c.def.includes("status <> 'reversed'::text")
      && c.def.includes("reversal_note is not null")
      && c.def.includes("reversed_by is not null")),
    cons.find((c) => c.conname === "money_posting_reversal_is_explained")?.def);

  const balanceTrig = trigRows.filter((t: any) => ["money_posting_balances",
    "money_legs_balance_their_posting"].includes(t.name));
  check("the balance rule is a constraint trigger that is deferrable and initially deferred, on the "
    + "movement and on its legs",
    balanceTrig.length === 2 && balanceTrig.every((t: any) => t.def.includes("constraint trigger")
      && t.def.includes("deferrable initially deferred") && t.def.includes("after insert")),
    JSON.stringify(trigRows.filter((t: any) => t.def.includes("constraint"))));
  check("…on both tables on purpose: a movement with no legs at all must fail exactly as loudly as "
    + "one with a single leg",
    balanceTrig.some((t: any) => t.tbl === "money_postings")
    && balanceTrig.some((t: any) => t.tbl === "money_entries"),
    JSON.stringify(balanceTrig.map((t: any) => [t.name, t.tbl])));
  check("the append-only guards are ordinary immediate triggers — a deferred one would let a "
    + "rewrite sit in the transaction until the commit, which is not a guard",
    ["money_entries_are_kept", "money_postings_keep_their_words"].every((k) => {
      const t = trigRows.find((x: any) => x.name === k);
      // The catalog rewrites `before delete or update` in its own order, whatever the migration typed.
      return !!t && /before (delete or update|update or delete)/.test(t.def)
        && !t.def.includes("deferrable");
    }), JSON.stringify(trigRows.filter((t: any) => !t.def.includes("constraint"))
      .map((t: any) => [t.name, t.def])));
  check("a leg is checked as it arrives, before the row exists, so a frozen account is refused "
    + "without the book having to be re-read",
    trigRows.some((t: any) => t.name === "money_legs_belong_to_their_book"
      && t.def.includes("before insert")),
    trigRows.find((t: any) => t.name === "money_legs_belong_to_their_book")?.def);
  check("…and the totals follow the legs after the row lands, which is the only reason the register "
    + "can print a figure without walking the book",
    trigRows.some((t: any) => t.name === "money_totals_follow_legs" && t.def.includes("after insert")),
    trigRows.find((t: any) => t.name === "money_totals_follow_legs")?.def);
  check("…six triggers, which is 133's whole rule set: two deferred, four immediate, and no rule "
    + "left to be written in the API where a different client could skip it",
    trigRows.length === 6, JSON.stringify(trigRows.map((t: any) => t.name)));

  check("every one of 133's fourteen functions is a definer with its own search path",
    fnDefs.length === 14 && fnDefs.every((f: any) => f.definer
      && f.cfg.includes("search_path=public")), JSON.stringify(fnDefs));
  check("…and a trigger body is fired, never called: no client role can execute any of the five",
    BODIES.every((b) => fnDefs.some((f: any) => f.name === b))
    && !fnGrants.some((g: any) => BODIES.includes(g.name) && CLIENTS.includes(g.who)),
    JSON.stringify(fnGrants.filter((g: any) => BODIES.includes(g.name))));
  check("…while every door and reader is executable by the app role and by nothing a client can be",
    DOORS.every((d) => fnGrants.some((g: any) => g.name === d && g.who === "app_runtime"
      && g.what.includes("EXECUTE")))
    && !fnGrants.some((g: any) => ["PUBLIC", "anon", "authenticated", "service_role"]
      .includes(g.who)), JSON.stringify(fnGrants.filter((g: any) => DOORS.includes(g.name))));
  check("…which is the line 114 lists and every stage since has honoured: a `create or replace` "
    + "hands EXECUTE back to PUBLIC, so the revoke after the grant is the whole defence",
    (await one(`select count(*)::int as n from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace cross join aclexplode(p.proacl) a
      where n.nspname = 'platform_auth' and p.proname = any($1::text[]) and a.grantee = 0`,
      [ALL_FNS]))?.n === 0,
    await one(`select p.proname as name, a.grantee::text as who, a.privilege_type as what
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join aclexplode(p.proacl) a
      where n.nspname = 'platform_auth' and p.proname = any($1::text[]) and a.grantee = 0`,
      [ALL_FNS]));

  check("the book holds no sealed number, no credential and no figure a client could read out of a "
    + "list endpoint",
    !(await one(`select string_agg(c.table_name || '.' || c.column_name, ',') as cols
      from information_schema.columns c
      where c.table_name = any($1)
        and c.column_name ~ '(^|_)(nida|phone|password|otp|secret|tin|brla|token|email)($|_)'`,
      [REGISTERS]))?.cols,
    await one(`select string_agg(column_name, ',') as cols from information_schema.columns
      where table_name = any($1)`, [REGISTERS]));

  // ---------------- 2 · the words agree ----------------
  phase("2 · the vocabularies: the row's words, the door's words, the sentence's number");
  const srcKinds = wordsInList(src, "p_source_kind not in (");
  const rowKinds = wordsFor(cons, "money_postings_source_kind_check");
  check("the thirteen kinds a movement may stand for are the same thirteen words in the CHECK and "
    + "in the door",
    same(rowKinds, KINDS) && same(srcKinds, KINDS) && rowKinds.length === 13,
    { row: [...rowKinds].sort(), door: [...srcKinds].sort() });
  // The sentence is written across two lines of the raise, because a plpgsql message literal is
  // allowed to wrap and the two halves are welded back together only when the server raises it. So
  // the weld happens here first: two literals with a newline between them are one literal.
  const prose = src.replace(/'\s*\n\s*'/g, "").replace(/\s+/g, " ")
    .match(/not one of the ([a-z]+) kinds/)?.[1] ?? "";
  check("…and the door's own sentence counts them right — a refusal that promises the wrong number "
    + "of kinds is a refusal nobody believes",
    SPELL[prose] === rowKinds.length, { sentence: prose, in_the_row: rowKinds.length });
  check("…with the same list in both places, so the words a movement can stand for cannot drift "
    + "apart from the words the row can hold",
    same(srcKinds, rowKinds), { door: srcKinds, row: rowKinds });
  check("the five classical kinds of account are the row's, and none of them is a word a movement "
    + "can be standing for",
    same(wordsFor(cons, "money_accounts_kind_check"), ACCOUNT_KINDS)
    && !rowKinds.some((k) => ACCOUNT_KINDS.includes(k)), wordsFor(cons, "money_accounts_kind_check"));
  const natural = wordsInList(src, "case when ac.kind in (");
  check("which side a balance is printed on is derived from the kind and never typed, and the two "
    + "halves of that rule between them name all five kinds",
    same(natural, ["asset", "expense"])
    && ACCOUNT_KINDS.filter((k) => !natural.includes(k)).length === 3,
    { debit_grows: natural, credit_grows: ACCOUNT_KINDS.filter((k) => !natural.includes(k)) });
  const srcMonies = wordsInList(src, "if v_currency not in (");
  check("the two monies the book keeps are the row's CHECK, the door's list and 126's pair",
    sameFold(wordsFor(cons, "money_postings_currency_check"), MONIES)
    && sameFold(wordsFor(cons, "money_accounts_currency_check"), MONIES)
    && sameFold(srcMonies, MONIES), { row: wordsFor(cons, "money_postings_currency_check"),
      door: srcMonies });
  check("…and one currency for a whole movement, because \"the debits equal the credits\" means "
    + "nothing across two monies — the refusal says what an exchange actually costs instead",
    src.includes("a movement that changes") && src.includes("two postings with an exchange line"),
    src.match(/is a % account and this posting is in %[^;]*/)?.[0]);
  check("the two states of a movement are posted and reversed; a corrected figure is not a state a "
    + "book is allowed to have",
    same(wordsFor(cons, "money_postings_status_check"), ["posted", "reversed"])
    && same(wordsFor(cons, "money_accounts_status_check"), ["frozen", "open"]),
    wordsFor(cons, "money_postings_status_check"));
  check("a leg is on one of two sides and the door reads the same two words",
    same(wordsFor(cons, "money_entries_direction_check"), SIDES)
    && src.includes("not in ('debit', 'credit')"), wordsFor(cons, "money_entries_direction_check"));
  check("…and the leg's `detail` and the movement's `memo` are both long enough to be read, so a "
    + "blank cannot be filed as an explanation",
    cons.some((c) => c.conname === "money_entries_detail_check"
      && c.def.includes("char_length(trim(both from detail))"))
    && cons.some((c) => c.conname === "money_postings_memo_check"
      && c.def.includes("char_length(trim(both from memo))")),
    cons.filter((c) => /detail_check|memo_check/.test(c.conname)).map((c) => c.def));

  if (routeSrc) {
    const zKind = zodEnum(routeSrc, "sourceKind");
    const zMoney = zodEnum(routeSrc, "currency");
    const zSide = zodEnum(routeSrc, "direction");
    check("the desk's zod enums send no word the register cannot hold",
      zKind.length > 0 && sameFold(zKind, KINDS) && sameFold(zMoney, MONIES)
      && sameFold(zSide, SIDES),
      { zKind, zMoney, zSide });
    const keys = wordsOf(probeSrc, "keys");
    check("…and the three money duties are in the permissions probe's allowlist, or the desk is "
      + "held and invisible", ["control.money.view", "control.money.post", "control.money.freeze"]
        .every((k) => keys.includes(k)), keys.filter((k) => k.startsWith("control.money")));
  } else {
    note(`${ROUTE} does not exist yet (#344c) — when the desk lands, its zod enums and the `
      + `permissions allowlist are compared here. A duty that is held but never probed reads as a `
      + `broken tab, which is exactly how control.staff.view behaved for three roles.`);
  }

  // ---------------- 3 · the chart and the doors that keep it ----------------
  phase("3 · the office's own chart, and the two doors that open and stop an account");
  const chart = (await oi(`select id, code, label, kind, currency, status, debit_total, credit_total,
      entry_count, frozen_reason from money_accounts where tenant_id = $1 order by code`,
    [PLAT])).rows as Record<string, any>[];
  const A = Object.fromEntries(chart.map((r) => [r.code, r]));
  check("the platform book opens with ten named accounts and no money in any of them",
    chart.length === 10 && same(chart.map((r) => r.code), CHART)
    && chart.every((r) => Number(r.debit_total) === 0 && Number(r.credit_total) === 0
      && r.entry_count === 0 && r.status === "open" && r.frozen_reason === null),
    chart.map((r) => [r.code, r.debit_total, r.entry_count]));
  // The claim is about what the *migration* seeds, not about what the doors do: `insert into
  // money_postings` appears in 133 a dozen times once the door's own body is counted, so the only
  // way to ask this question is to ask it of the file with every body taken out.
  let outside = src;
  for (const b of functionDdl(src)) outside = outside.replace(b, "");
  check("…because an opening figure is declared by the office on the desk under `opening`, and a "
    + "migration that invented one would hand the book a number nothing was ever owed",
    (await one(`select count(*)::int as n from money_postings where tenant_id = $1`, [PLAT]))?.n === 0
    && !outside.includes("insert into money_postings")
    && !outside.includes("insert into money_entries"),
    { seededMovements: (await one(`select count(*)::int as n from money_postings`, []))?.n,
      writesOutsideDoors: /insert into money_(postings|entries)/.test(outside) });
  check("…and exactly one of the ten is kept in USD, which is the pair the CHECK allows and the "
    + "reason the register can filter by money",
    chart.filter((r) => r.currency === "USD").length === 1
    && chart.some((r) => r.code === "OPS-USD" && r.currency === "USD"),
    chart.map((r) => [r.code, r.currency]));
  check("the ten name the money the office already holds somewhere else: escrow, wallet, gateway, "
    + "refunds and payouts each have a line before the money arrives",
    ["WALLET-TZS", "ESCROW-TZS", "GATE-WAIT", "REFUND-DUE", "PAYOUT-DUE", "FEE-INCOME", "COST-OPS"]
      .every((c) => chart.some((r) => r.code === c)), chart.map((r) => r.code));
  check("…and every one of them carries the sentence that says what it is for, because a chart a "
    + "new clerk cannot read is a chart they will misuse",
    (await one(`select count(*)::int as n from money_accounts
      where tenant_id = $1 and (note is null or char_length(trim(note)) < 8)`, [PLAT]))?.n === 0,
    await one(`select code, note from money_accounts where tenant_id = $1 limit 1`, [PLAT]));

  // Two accounts for the office's book, opened inside the transaction that phase 10 rolls back: one
  // USD line and one `equity`, so that the five classical kinds are all present in the chart the
  // reads below print. The office's committed chart stays at the ten 133 seeded.
  const USD = await call("a door takes a lowercase code and books the uppercase one, because a code "
    + "quoted on paper is read over a counter", OPEN_SQL,
    [PLAT, CODE("usd"), "  Gate dollars (USD)  ", "asset", "USD", null, PEN]);
  check("…and trims the label it was handed rather than storing the desk's stray spaces",
    USD?.code === CODE("usd").toUpperCase() && USD?.label === "Gate dollars (USD)"
    && USD?.currency === "USD" && USD?.status === "open",
    { code: USD?.code, label: USD?.label });
  check("…and the row it returns carries no tenant id, because an account id is not a way to find "
    + "out whose book you are in",
    !("tenant_id" in (USD ?? {})), Object.keys(USD ?? {}));
  const EQ = await call("a fifth kind of account opens, so the natural-side rule is proved on all "
    + "five kinds rather than on the four a chart happens to have", OPEN_SQL,
    [PLAT, CODE("eqty"), "Gate capital (TZS)", "equity", "TZS",
      "Opened by the gate so the equity kind is read, not merely allowed.", PEN]);
  check("…and it is the door's, not the migration's, that names it: the seeded chart has no equity "
    + "line, so a desk that could not open one would be stuck with four of five kinds",
    EQ?.kind === "equity" && !chart.some((r) => r.kind === "equity"), { kind: EQ?.kind });
  await fails("the same code cannot be opened twice in one book — two accounts for the same money "
    + "is how a book stops meaning anything", OPEN_SQL,
    [PLAT, CODE("usd"), "Duplicate", "asset", "USD", null, PEN],
    "already has an account called");
  check("…and the refusal quotes the code it means, upper-cased, so the desk sees the name it is "
    + "already holding rather than the one it just typed",
    String((await guarded(OPEN_SQL,
      [PLAT, CODE("usd"), "Duplicate", "asset", "USD", null, PEN])).err?.message ?? "")
      .includes(CODE("usd").toUpperCase()), "the second refusal repeats the name");
  await fails("an account cannot be opened in a book the seat does not belong to, even by the "
    + "office's own pen", OPEN_SQL,
    [TB, CODE("nope"), "A stranger's account", "asset", "TZS", null, PEN],
    "does not belong to that book");
  await fails("…and no account is opened by a door that was not told who opened it", OPEN_SQL,
    [PLAT, CODE("nobody"), "An anonymous account", "asset", "TZS", null, null],
    "needs a book and a named seat");

  const froz = await call("freezing an account takes a reason and keeps it in the row",
    FREEZE_SQL, [TB, GATE_STOP.id, REASON, QUILL, true]);
  check("…with the seat and the moment written beside it, because a freeze somebody cannot be asked "
    + "about is not a decision, it is an outage",
    froz?.ok === true && froz?.account?.status === "frozen"
    && froz?.account?.frozen_reason === REASON && !!froz?.account?.frozen_at,
    { status: froz?.account?.status, at: froz?.account?.frozen_at });
  const twice = await call("freezing a stopped account says so instead of taking a new sentence",
    FREEZE_SQL, [TB, GATE_STOP.id, ANOTHER, QUILL, true]);
  check("…and keeps the reason it was stopped with, rather than letting a later desk quietly "
    + "rewrite why",
    twice?.ok === false && twice?.error === "already" && twice?.reason === REASON
    && twice?.label === "Gate stopped account", twice);
  const thaw = await call("unfreezing clears the reason, because a warning that outlives its "
    + "answer is noise", FREEZE_SQL, [TB, GATE_STOP.id, null, QUILL, false]);
  check("…and the seat that froze it goes with the sentence it wrote",
    thaw?.ok === true && thaw?.account?.status === "open"
    && thaw?.account?.frozen_reason === null && thaw?.account?.frozen_by === null,
    { s: thaw?.account?.status, r: thaw?.account?.frozen_reason });
  const thawed = await call("unfreezing an open account answers instead of pretending to work",
    FREEZE_SQL, [TB, GATE_STOP.id, null, QUILL, false]);
  check("…with `already_open`, which is the difference between a door that did nothing and one "
    + "that broke", thawed?.ok === false && thawed?.error === "already_open", thawed);
  await call("and stopped again, so the refusals below meet a frozen account the way a desk would",
    FREEZE_SQL, [TB, GATE_STOP.id, REASON, QUILL, true]);
  await fails("freezing without a sentence a later seat can read is refused — five words is a "
    + "grumble, not a reason", FREEZE_SQL,
    [TB, GATE_OUT.id, "hasty", QUILL, true], "needs a sentence");
  check("…and the account this probe tried to freeze is still open, because a gate that half works "
    + "leaves the next phase reading a ledger it thinks the office stopped",
    (await one(`select status from money_accounts where id = $1 and tenant_id = $2`,
      [GATE_OUT.id, TB]))?.status === "open",
    { status: (await one(`select status from money_accounts where id = $1 and tenant_id = $2`,
      [GATE_OUT.id, TB]))?.status });
  await fails("…and so is a freeze that was not told who ordered it", FREEZE_SQL,
    [TB, GATE_OUT.id, REASON, null, true], "freezing an account names the seat");
  const missFreeze = await call("freezing an account of another book answers `not_found` rather "
    + "than touching it", FREEZE_SQL, [TB, A["OPS-CASH"].id, REASON, QUILL, true]);
  check("…which is the difference between a door that cannot see it and one that will not open",
    missFreeze?.ok === false && missFreeze?.error === "not_found", missFreeze);
  await fails("…while a stranger's seat cannot freeze the office's treasury even knowing its id",
    FREEZE_SQL, [PLAT, A["OPS-CASH"].id, REASON, QUILL, true], "does not belong to that book");

  // ---------------- 4 · a movement that balances ----------------
  phase("4 · the door is the only way a movement enters, so it is the thing that has to be strict");
  const M1 = MEMO("cash put into escrow against the job");
  const K1 = `idem-${STAMP}-one`;
  const P1 = await post("the office moves cash into escrow: two legs, one figure, a number of its "
    + "own", PLAT, PEN, [
    L(A["OPS-CASH"].id, "debit", "150000.00", "out of treasury"),
    L(A["ESCROW-TZS"].id, "credit", "150000.00", "held against the job")
  ], { memo: M1, kind: "escrow", idem: K1, sourceRef: "JOB-77" });
  check("…the movement is stamped `PST-` and the year, and its figure is its own, not a placeholder "
    + "the desk filled in later",
    /^PST-20\d\d-\d{5,}$/.test(P1?.ref ?? "") && P1?.status === "posted"
    && Number(P1?.total) === 150000, P1?.ref);
  check("…printed with two decimals, because a figure the desk cannot re-type is a figure it cannot "
    + "audit",
    (await one(`select platform_auth.money_posting_detail($1,$2) #>> '{total}' as txt`,
      [PLAT, P1?.id]))?.txt === "150000.00");
  check("…carrying the paper it stands for, as a reference the office can quote and a pointer it "
    + "will not be chained to",
    P1?.source_kind === "escrow" && P1?.source_ref === "JOB-77" && P1?.source_id === null,
    { kind: P1?.source_kind, ref: P1?.source_ref, id: P1?.source_id });
  check("…and the two legs are there in the order the register prints them: the side that left, "
    + "then the side that arrived",
    (P1?.legs ?? []).length === 2 && P1?.legs?.[0]?.direction === "debit"
    && P1?.legs?.[0]?.code === "OPS-CASH" && P1?.legs?.[0]?.amount != null
    && P1?.legs?.[1]?.direction === "credit" && P1?.legs?.[1]?.code === "ESCROW-TZS",
    JSON.stringify(P1?.legs));
  check("…and each leg names the account it moved, in the chart's own words, so a reader never has "
    + "to join a uuid back to a name",
    P1?.legs?.every((l: any) => !!l.label && !!l.kind && l.currency === "TZS"),
    JSON.stringify(P1?.legs?.[0]));
  check("…the read carries no tenant id and no idempotency key — a register is not a way to "
    + "enumerate whose book you are in",
    !("tenant_id" in (P1 ?? {})) && !("idempotency_key" in (P1 ?? {})), Object.keys(P1 ?? {}));
  check("…and it names the seat that wrote it by the words on the seat, because a book entry nobody "
    + "is answerable for is not a book entry",
    P1?.raised_by_name === "Ledger Pen" && P1?.reversed_by_name === null
    && P1?.reversal_note === null && P1?.reversed_at === null,
    { raised: P1?.raised_by_name });

  const again = await call("the same request with the same key answers with the movement it already "
    + "made", POST_SQL,
    [PLAT, DAY, M1, "TZS", "escrow", null, "JOB-77", K1, PEN, JSON.stringify([
      L(A["OPS-CASH"].id, "debit", "150000.00", "out of treasury"),
      L(A["ESCROW-TZS"].id, "credit", "150000.00", "held against the job")])]);
  check("…with `replayed` on it and the same number, which is the whole point of the key",
    again?.ok === true && again?.replayed === true && again?.posting?.id === P1?.id
    && again?.posting?.ref === P1?.ref, { replayed: again?.replayed, id: again?.posting?.id });
  check("…and the legs were not written twice — a retry that adds a second line to the escrow is a "
    + "double payment wearing an idempotency key",
    (again?.posting?.legs ?? []).length === 2
    && (await one(`select count(*)::int as n from money_entries where posting_id = $1`,
      [P1?.id]))?.n === 2);
  check("…and no second movement exists under that key in that book",
    (await one(`select count(*)::int as n from money_postings where tenant_id = $1
      and idempotency_key = $2`, [PLAT, K1]))?.n === 1);

  const TB1 = await post("the same key in another book is another movement, because two offices "
    + "retrying with the same string do not answer for each other", TB, QUILL,
    [L(GATE_OUT.id, "debit", "90.00", "the counterparty pays out"),
      L(GATE_IN.id, "credit", "90.00", "and receives")], { idem: K1 });
  check("…and both movements are on a register, one per book",
    !!TB1?.id
    && (await one(`select count(*)::int as n from money_postings where idempotency_key = $1`,
      [K1]))?.n === 2,
    await oi(`select tenant_id, ref from money_postings where idempotency_key = $1`, [K1]));
  check("…with the company's own pen on the company's movement, not the office's",
    TB1?.raised_by_name === "Ledger Quill", { by: TB1?.raised_by_name });

  const P3 = await post("three legs balance too: costs leave two lines and arrive in one",
    PLAT, PEN, [
      L(A["COST-OPS"].id, "debit", "1000.00", "the garage"),
      L(A["REFUND-DUE"].id, "debit", "250.00", "a refund called back"),
      L(A["OPS-BANK"].id, "credit", "1250.00", "out of the bank")
    ], { memo: MEMO("three legs against one bank line"), kind: "cost" });
  check("…with the figure copied from the legs — one thousand two hundred and fifty, from three "
    + "lines, neither more nor less",
    Number(P3?.total) === 1250 && (P3?.legs ?? []).length === 3, { total: P3?.total });

  const P4 = await post("a USD movement needs two USD accounts and does not touch the TZS side of "
    + "the book", PLAT, PEN, [
    L(USD?.id as string, "debit", "100.00", "dollars bought"),
    L(A["OPS-USD"].id, "credit", "100.00", "out of the USD bank")
  ], { memo: MEMO("dollars moved between the two USD lines"), currency: "USD", kind: "adjustment" });
  check("…and the register says which money it moved, not merely how much",
    P4?.currency === "USD" && Number(P4?.total) === 100
    && P4?.legs?.every((l: any) => l.currency === "USD"), { c: P4?.currency, t: P4?.total });
  const USDrow = await one(`select debit_total, credit_total from money_accounts where id = $1`,
    [USD?.id]);
  check("…while the shilling accounts are untouched by it, which is the only reason a book in two "
    + "monies can still be added up",
    Number(USDrow?.debit_total) === 100
    && Number((await one(`select debit_total from money_accounts where code = 'OPS-CASH'
      and tenant_id = $1`, [PLAT]))?.debit_total) === 150000, USDrow);

  // ---------------- 5 · the refusals a desk is told about ----------------
  phase("5 · the refusals, in the words the desk would be told");
  const shortLegs = await fails("one leg is refused before the door writes anything: money that "
    + "moves leaves one account and enters another", POST_SQL,
    [PLAT, DAY, MEMO("a single leg"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00")])], "two legs or more");
  check("…and the sentence says how many were given",
    /and 1 were given/.test(String(shortLegs?.message)), shortLegs?.message);
  await fails("no legs at all is the same refusal and not a crash, and it counts them as zero",
    POST_SQL, [PLAT, DAY, MEMO("no legs at all"), "TZS", "manual", null, null, null, PEN, "[]"],
    "and 0 were given");
  await fails("…nor is a body that is not an array a way to slip a movement through", POST_SQL,
    [PLAT, DAY, MEMO("legs sent as an object"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify({ account: A["OPS-CASH"].id })], "and 0 were given");
  await fails("a movement all on one side is refused by the door, which names both figures",
    POST_SQL, [PLAT, DAY, MEMO("two debits, no credit"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "40.00"),
        L(A["OPS-BANK"].id, "debit", "60.00")])], "are all on one side — 100.00 debited, 0.00");
  const unbalanced = await fails("a movement that does not balance is refused, and the sentence "
    + "names the difference it is out by", POST_SQL,
    [PLAT, DAY, MEMO("ten short"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "100.00"),
        L(A["ESCROW-TZS"].id, "credit", "90.00")])], "does not balance");
  check("…out by ten, in the words an office can act on rather than a rule it broke",
    /carry 100\.00 debited against 90\.00 credited \(out by 10\.00\)/
      .test(String(unbalanced?.message)), unbalanced?.message);
  await fails("a currency the book does not keep is refused with both words it does", POST_SQL,
    [PLAT, DAY, MEMO("a movement in euros"), "EUR", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00"),
        L(A["OPS-BANK"].id, "credit", "10.00")])], "is not a money this register holds");
  const P5 = await post("a currency of only spaces is not a third money: the register takes the "
    + "default it was built on rather than storing an empty string", PLAT, PEN,
    [L(A["OPS-CASH"].id, "debit", "10.00"), L(A["OPS-BANK"].id, "credit", "10.00")],
    { memo: MEMO("a movement with no currency named"), currency: "  " });
  check("…which is the sentence the CHECK cannot say, because a row-level check on a column with a "
    + "default would have to refuse the very value the default hands it",
    P5?.currency === "TZS", { currency: P5?.currency });
  await fails("a source the book cannot name is refused with the word quoted back", POST_SQL,
    [PLAT, DAY, MEMO("a movement standing for a donation"), "TZS", "donation", null, null, null,
      PEN, JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00"),
        L(A["OPS-BANK"].id, "credit", "10.00")])], "is not one of the thirteen");
  await fails("…and so is a movement that says nothing about what it stands for", POST_SQL,
    [PLAT, DAY, MEMO("a movement with no kind"), "TZS", null, null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00"),
        L(A["OPS-BANK"].id, "credit", "10.00")])], '(nothing)" is not one of the thirteen');
  await fails("a leg that does not name an account is refused by its number in the list", POST_SQL,
    [PLAT, DAY, MEMO("an account typed as a code"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([{ account: "OPS-CASH", direction: "debit", amount: "10.00" },
        L(A["OPS-BANK"].id, "credit", "10.00")])], "must name the account it moves");
  await fails("a side that is neither debit nor credit is refused with the word that was sent",
    POST_SQL, [PLAT, DAY, MEMO("a leg on side d"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00"),
        { account: A["OPS-BANK"].id, direction: "d", amount: "10.00" }])], 'on side "d"');
  const P6 = await post("…while the same word in another case, with spaces around it, is taken and "
    + "stored lower-case, because a desk types in a hurry and a register that refused it would be "
    + "refusing a movement that is perfectly clear", PLAT, PEN,
    [L(A["OPS-CASH"].id, "Debit", "10.00"), L(A["OPS-BANK"].id, " CREDIT ", "10.00")],
    { memo: MEMO("a leg on side DEBIT in caps") });
  check("…and what the book keeps is the word the CHECK allows, not the word the desk typed — a "
    + "side stored as `Debit` is a side no sum will ever find",
    P6?.legs?.[0]?.direction === "debit" && P6?.legs?.[1]?.direction === "credit"
    && String(P6?.legs?.[0]?.direction) === "debit", JSON.stringify(P6?.legs));
  await fails("a figure with a thousand separator in it is refused, because the book keeps digits",
    POST_SQL, [PLAT, DAY, MEMO("a leg with a comma"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "1,000.00"),
        L(A["OPS-BANK"].id, "credit", "1000.00")])], 'carries "1,000.00"');
  await fails("…and so is a third of a cent, which no bank will hand over", POST_SQL,
    [PLAT, DAY, MEMO("a leg with three decimals"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.005"),
        L(A["OPS-BANK"].id, "credit", "10.005")])], 'carries "10.005"');
  await fails("…and so is a leading zero, which is a desk's typing error and not a figure",
    POST_SQL, [PLAT, DAY, MEMO("a leg typed with a leading zero"), "TZS", "manual", null, null,
      null, PEN, JSON.stringify([L(A["OPS-CASH"].id, "debit", "010.00"),
        L(A["OPS-BANK"].id, "credit", "010.00")])], 'carries "010.00"');
  await fails("…and a leg that moves nothing at all, which is a line and not a movement", POST_SQL,
    [PLAT, DAY, MEMO("a leg of nothing"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "0.00"),
        L(A["OPS-BANK"].id, "credit", "10.00")])], "moves 0.00: a leg that moves nothing");
  await fails("a movement written by a seat of another book is refused — a book cannot be signed "
    + "with somebody else's name", POST_SQL,
    [PLAT, DAY, MEMO("a movement signed by a company's seat"), "TZS", "manual", null, null, null,
      QUILL, JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00"),
        L(A["OPS-BANK"].id, "credit", "10.00")])], "does not belong to that book");
  await fails("…and the office's own pen cannot sign in a company's book either, which is the same "
    + "door from the other side", POST_SQL,
    [TB, DAY, MEMO("a movement signed by the office"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(GATE_OUT.id, "debit", "10.00"),
        L(GATE_IN.id, "credit", "10.00")])], "does not belong to that book");
  await fails("a movement with no seat named is refused, because an anonymous movement cannot be "
    + "answered for", POST_SQL,
    [PLAT, DAY, MEMO("a movement by nobody"), "TZS", "manual", null, null, null, null,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00"),
        L(A["OPS-BANK"].id, "credit", "10.00")])], "needs a book and the seat");
  await fails("a leg aimed at another book's account is refused by the name of the account it "
    + "reached for", POST_SQL,
    [PLAT, DAY, MEMO("a leg reaching into a company's chart"), "TZS", "manual", null, null, null,
      PEN, JSON.stringify([L(GATE_OUT.id, "debit", "10.00"),
        L(A["OPS-BANK"].id, "credit", "10.00")])], "is not in that book");
  await fails("a USD account cannot stand in a TZS movement, and the refusal says what an exchange "
    + "actually costs", POST_SQL,
    [PLAT, DAY, MEMO("dollars inside a shilling movement"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-USD"].id, "debit", "10.00"),
        L(A["OPS-CASH"].id, "credit", "10.00")])], "is a USD account and this posting is in TZS");
  const stopErr = await guarded(POST_SQL,
    [TB, DAY, MEMO("a movement through a stopped account"), "TZS", "manual", null, null, null,
      QUILL, JSON.stringify([L(GATE_STOP.id, "debit", "10.00"),
        L(GATE_OUT.id, "credit", "10.00")])]);
  check("a frozen account takes no leg in either direction, and the door does not write a header "
    + "to find out", !!stopErr.err, stopErr.err ? "" : "the movement was accepted");
  check("…and the refusal is the account's own reason, not a general one — the desk must not have "
    + "to go and look", String(stopErr.err?.message).includes(REASON), stopErr.err?.message);
  check("…named by the label a person reads on the chart rather than by an id",
    String(stopErr.err?.message).includes("Gate stopped account is frozen"),
    stopErr.err?.message);

  const badWords = await fails("a memo shorter than a sentence is refused by the row, since the "
    + "door does not spell out every CHECK", POST_SQL,
    [PLAT, DAY, "short", "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00"),
        L(A["OPS-BANK"].id, "credit", "10.00")])], "money_postings_memo_check");
  check("…and the register says which rule it broke by name, so the desk can be told what to type",
    badWords?.constraint === "money_postings_memo_check", badWords?.constraint);
  await fails("a paper reference of two letters is refused", POST_SQL,
    [PLAT, DAY, MEMO("a two-letter reference"), "TZS", "invoice", null, "AB", null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00"),
        L(A["OPS-BANK"].id, "credit", "10.00")])], "money_postings_source_ref_check");
  await fails("…and so is an idempotency key too short to be one", POST_SQL,
    [PLAT, DAY, MEMO("a short key"), "TZS", "manual", null, null, "abc", PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00"),
        L(A["OPS-BANK"].id, "credit", "10.00")])], "money_postings_idempotency_key_check");
  await fails("a figure past the register's own ceiling is refused by the row, and by the leg as "
    + "well as by the header", POST_SQL,
    [PLAT, DAY, MEMO("an implausible movement"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "99999999999.00"),
        L(A["ESCROW-TZS"].id, "credit", "99999999999.00")])], "money_postings_total_check");
  await fails("…and a leg detail of one letter is refused, because a leg that says nothing is a "
    + "leg that will be read as an answer later", POST_SQL,
    [PLAT, DAY, MEMO("a leg with a one-letter detail"), "TZS", "manual", null, null, null, PEN,
      JSON.stringify([L(A["OPS-CASH"].id, "debit", "10.00", "x"),
        L(A["OPS-BANK"].id, "credit", "10.00", "x")])], "money_entries_detail_check");
  const P7 = await post("a movement dated in the future is booked like any other day — the book "
    + "keeps the day the office says the money moved, and no date rule is invented here", PLAT, PEN,
    [L(A["OPS-CASH"].id, "debit", "10.00"), L(A["OPS-BANK"].id, "credit", "10.00")],
    { memo: MEMO("a movement dated ahead"), day: "2030-01-01" });
  check("…which is the sentence the desk has to be told, because a book that silently moved a "
    + "movement to today would be a book that disagreed with the papers",
    String(P7?.posted_on).slice(0, 10) === "2030-01-01", { day: P7?.posted_on });
  check("…and of all the refusals above, not one left a row behind: the door works the figure out "
    + "before the header exists, so a movement it rejects was never half-written",
    (await one(`select count(*)::int as n from money_postings where tenant_id = $1`, [PLAT]))?.n === 6
    && (await one(`select count(*)::int as n from money_entries where tenant_id = $1`, [PLAT]))?.n === 13,
    await one(`select (select count(*) from money_postings where tenant_id = $1) as postings,
      (select count(*) from money_entries where tenant_id = $1) as legs`, [PLAT]));

  // ---------------- 6 · the undoing is a movement, not an edit ----------------
  phase("6 · a movement is undone by a mirror, and the wrong figure stays in the book as the mistake it was");
  const today = (await one("select current_date::text as d"))?.d;
  const R1 = await call("reversing a movement posts its mirror: the same legs with the sides swapped",
    REVERSE_SQL, [PLAT, P1?.id, UNDO, PEN]);
  check("…and the mirror is a movement of its own, numbered of its own, in the money of the one it "
    + "answers", R1?.ok === true && /^PST-20\d\d-\d{5,}$/.test(String(R1?.reversal?.ref ?? ""))
    && R1?.reversal?.id !== P1?.id && R1?.reversal?.currency === "TZS"
    && R1?.original_ref === P1?.ref, { ref: R1?.reversal?.ref });
  check("…standing for the paper it undoes, which is the difference between an undoing and a second "
    + "payment into escrow",
    R1?.reversal?.source_kind === "reversal" && R1?.reversal?.source_id === P1?.id
    && R1?.reversal?.source_ref === P1?.ref,
    { kind: R1?.reversal?.source_kind, id: R1?.reversal?.source_id, ref: R1?.reversal?.source_ref });
  check("…dated the day the office noticed rather than the day it got it wrong, because the mirror is "
    + "a fresh act and a book is kept by the day things happened",
    R1?.reversal?.posted_on === today, { mirror: R1?.reversal?.posted_on, today });
  check("…and saying so in its own words, so a register line reads as an undoing before anybody "
    + "opens it", /^Reversal of PST-/.test(String(R1?.reversal?.memo ?? ""))
    && String(R1?.reversal?.memo).includes(String(P1?.ref)), R1?.reversal?.memo);
  check("…with the original's legs turned over: the side that was debited is credited, the figure is "
    + "the same, and every line names the movement it mirrors",
    (R1?.reversal?.legs ?? []).length === 2 && R1?.reversal?.legs?.[0]?.code === "ESCROW-TZS"
    && R1?.reversal?.legs?.[0]?.direction === "debit" && R1?.reversal?.legs?.[1]?.code === "OPS-CASH"
    && R1?.reversal?.legs?.[1]?.direction === "credit"
    && (R1?.reversal?.legs ?? []).every((l: any) => Number(l.amount) === 150000
      && l.detail === `mirror of ${P1?.ref}`), JSON.stringify(R1?.reversal?.legs));

  const back = await call("…and the movement it answers says so in its own row", DETAIL_SQL,
    [PLAT, P1?.id]);
  check("…reversed, with the sentence, the seat and the moment written beside it",
    back?.status === "reversed" && back?.reversal_note === UNDO
    && back?.reversed_by_name === "Ledger Pen" && !!back?.reversed_at, { s: back?.status });
  check("…and the mirror is listed on it from both ends of the question, so a desk reading the wrong "
    + "movement is shown the right one without having to go and look for it",
    back?.answered_by?.ref === R1?.reversal?.ref && (back?.answers ?? []).length === 1
    && back?.answers?.[0]?.ref === R1?.reversal?.ref, { answers: back?.answers });
  check("…while the mistake itself is kept whole — the figure, both legs and the day it was written "
    + "on are still there, because a book that overwrites its own errors has no history left to "
    + "audit", Number(back?.total) === 150000 && (back?.legs ?? []).length === 2
    && back?.legs?.[0]?.direction === "debit" && back?.legs?.[0]?.code === "OPS-CASH"
    && back?.memo === M1 && back?.posted_on === DAY, { total: back?.total, day: back?.posted_on });
  const net = await one(`select coalesce(sum(e.amount) filter (where e.direction = 'debit'), 0) as d,
      coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0) as c
    from money_entries e join money_accounts ac on ac.id = e.account_id
    where ac.code = 'ESCROW-TZS' and e.tenant_id = $1`, [PLAT]);
  check("…and the account the mistake touched is back to where it was, proved from the legs rather "
    + "than from a column somebody could have reset by hand",
    Number(net?.d) === 150000 && Number(net?.c) === 150000, net);

  const undoAgain = await call("a movement is undone once", REVERSE_SQL, [PLAT, P1?.id, ANOTHER, PEN]);
  check("…and the second ask answers with the number it already carries, rather than writing a "
    + "second mirror that would double the undoing",
    undoAgain?.ok === false && undoAgain?.error === "already_reversed"
    && undoAgain?.ref === P1?.ref, undoAgain);
  await fails("undoing an undoing is refused outright: it is a fresh movement and must be written out "
    + "with its own words", REVERSE_SQL, [PLAT, R1?.reversal?.id, ANOTHER, PEN],
    "is itself a reversal");
  await fails("…and reversing on a sentence of four letters is refused, because why an office changed "
    + "its mind is the first thing a later reader asks", REVERSE_SQL,
    [PLAT, P3?.id, "nope", PEN], "needs the sentence that says why");
  const foreign = await call("a company's movement cannot be undone by the office's pen merely "
    + "naming its id, because the door looks the movement up inside the book it was told",
    REVERSE_SQL, [PLAT, TB1?.id, ANOTHER, PEN]);
  check("…and the answer is `not_found` — the same word for a movement in another book as for one "
    + "that never existed, so a uuid is not a way to enumerate somebody else's register",
    foreign?.ok === false && foreign?.error === "not_found", foreign);
  await fails("…while a seat of another book cannot sign the mirror at all, and the refusal comes "
    + "from the door the mirror has to be written through", REVERSE_SQL,
    [PLAT, P3?.id, ANOTHER, QUILL], "does not belong to that book");
  check("…and the movement that attempt reached for is still standing exactly as it was posted",
    (await one(`select status, total from money_postings where id = $1`, [P3?.id]))
    ?.status === "posted");
  const sq6 = await call("the book still agrees with itself after an undoing", SQUARE_SQL, [PLAT]);
  check("…because a mirror is a movement like any other, and the balance rule does not care which "
    + "side of a mistake it is counting",
    sq6?.square === true && sq6?.postings === 7 && sq6?.refs?.length === 0, sq6);

  // ---------------- 7 · the three reads the desk is built on ----------------
  phase("7 · the reads: the book, the register, one movement");
  const bk = await call("the office's book reads back its own chart with both sets of figures",
    BOOK_SQL, [PLAT]);
  const accts = (bk?.accounts ?? []) as any[];
  const chartOrder = accts.every((a, i) => i === 0
    || `${a.kind}/${a.code}` >= `${accts[i - 1].kind}/${accts[i - 1].code}`);
  check("…twelve lines, the ten 133 seeded plus the two the gate opened, ordered by kind and then by "
    + "code so the chart reads as a chart rather than as a list of inserts",
    accts.length === 12 && same(accts.map((a) => a.code),
      [...CHART, CODE("usd").toUpperCase(), CODE("eqty").toUpperCase()]) && chartOrder,
    accts.map((a) => [a.kind, a.code]));
  check("…and the five classical kinds are all present, because the natural side is derived from the "
    + "kind and a chart that never shows one of five never proves the rule for it",
    ACCOUNT_KINDS.every((k) => accts.some((a) => a.kind === k)),
    [...new Set(accts.map((a) => a.kind))].sort());
  check("…every line's cached figure equals the figure recomputed from its legs, so the pair the desk "
    + "prints agrees while the book is honest",
    accts.every((a) => a.drift === false
      && String(a.cached?.debit) === String(a.recomputed?.debit)
      && String(a.cached?.credit) === String(a.recomputed?.credit)),
    accts.filter((a) => a.drift).map((a) => a.code));
  check("…and the side a balance is printed on is a fact about the account, not a choice: assets and "
    + "expenses grow on the debit, the other three on the credit",
    accts.every((a) => a.natural_side === (["asset", "expense"].includes(a.kind) ? "debit" : "credit"))
    && accts.every((a) => Number(a.balance) === Number(a.recomputed_balance)),
    accts.map((a) => [a.code, a.kind, a.natural_side, a.balance]));
  check("…the escrow line the mistake touched reads back at nothing, from the legs",
    accts.some((a) => a.code === "ESCROW-TZS" && Number(a.recomputed?.debit) === 150000
      && Number(a.recomputed?.credit) === 150000 && Number(a.balance) === 0),
    accts.find((a) => a.code === "ESCROW-TZS"));
  const t7 = bk?.totals ?? {};
  const want = await one(`select (select count(*)::int from money_accounts where tenant_id = $1) as a,
      (select count(*)::int from money_accounts where tenant_id = $1 and status = 'frozen') as f,
      (select count(*)::int from money_postings where tenant_id = $1) as p,
      (select count(*)::int from money_postings where tenant_id = $1 and status = 'reversed') as r,
      (select count(*)::int from money_postings where tenant_id = $1 and currency = 'TZS') as tz,
      (select count(*)::int from money_postings where tenant_id = $1 and currency = 'USD') as us,
      (select count(*)::int from money_entries where tenant_id = $1) as l,
      (select coalesce(sum(amount) filter (where direction = 'debit'), 0) from money_entries
        where tenant_id = $1) as d,
      (select coalesce(sum(amount) filter (where direction = 'credit'), 0) from money_entries
        where tenant_id = $1) as c`, [PLAT]);
  check("…and the totals the book prints are the book's own rows counted from the registers, not a "
    + "number the reader carried in from the test",
    t7.accounts === want?.a && t7.frozen_accounts === want?.f && t7.postings === want?.p
    && t7.movements_reversed === want?.r && t7.tzs_postings === want?.tz
    && t7.usd_postings === want?.us && t7.legs === want?.l
    && Number(t7.debited) === Number(want?.d) && Number(t7.credited) === Number(want?.c),
    { book: t7, sql: want });
  check("…which is seven movements and fifteen legs, six of them shillings and one dollar, one of "
    + "them reversed, and the two sides equal to the cent — the run book this gate wrote",
    t7.postings === 7 && t7.legs === 15 && t7.tzs_postings === 6 && t7.usd_postings === 1
    && t7.movements_reversed === 1 && Number(t7.debited) === 301380
    && Number(t7.out_by) === 0 && t7.square === true,
    { p: t7.postings, l: t7.legs, d: t7.debited, out: t7.out_by });
  const tbBook = await call("a company's book reads only its own chart", BOOK_SQL, [TB]);
  check("…twelve accounts and their movements never appear in it, which is the one thing a definer "
    + "cannot rely on row security for",
    (tbBook?.accounts ?? []).length === 4 && !(tbBook?.accounts ?? []).some((a: any) => CHART
      .includes(a.code)) && tbBook?.totals?.postings === 1 && tbBook?.totals?.legs === 2
    && tbBook?.totals?.frozen_accounts === 1,
    { n: (tbBook?.accounts ?? []).length, t: tbBook?.totals });
  const empty = await call("a book with nothing in it answers with an empty chart rather than an "
    + "error", BOOK_SQL, [TR]);
  check("…and the totals say zero on every line, because a desk that reads `undefined` invents a "
    + "figure", (empty?.accounts ?? []).length === 2 && empty?.totals?.postings === 0
    && empty?.totals?.legs === 0 && empty?.totals?.square === true
    && Number(empty?.totals?.debited) === 0, empty?.totals);
  const leakRow = await call("an account read names the book it is asking about, so a uuid from "
    + "another register answers with nothing", `select platform_auth.money_account_row($1, $2) as r`,
    [PLAT, GATE_IN.id]);
  check("…which is why 133's account reader takes the book as well as the id: the id is on a screen "
    + "and comes back in a request", leakRow === null, leakRow);
  const ownRow = await call("…and the same door reads its own account whole",
    `select platform_auth.money_account_row($1, $2) as r`, [TB, GATE_IN.id]);
  // The account this run has been paying money into, so its leg count is not zero: the reader's
  // figure has to agree with the register's, which is the claim a desk actually rests on.
  const inLegs = (await one(`select count(*)::int as n from money_entries
    where account_id = $1 and tenant_id = $2`, [GATE_IN.id, TB]))?.n;
  check("…with the balance figures on it and without the owner column",
    ownRow?.code === CODE("in").toUpperCase() && !("tenant_id" in (ownRow ?? {}))
    && ["debit_total", "credit_total", "entry_count", "last_posted_at"].every(
      (k) => k in (ownRow ?? {}))
    && ownRow?.entry_count === inLegs && inLegs > 0,
    { keys: Object.keys(ownRow ?? {}), reader: ownRow?.entry_count, register: inLegs });

  const reg = await call("the register reads the whole book newest first", REGISTER_SQL,
    [PLAT, null, null, null, null, null, null]);
  check("…seven movements, all of them returned, and the count is the book's rather than the page's",
    reg?.count === 7 && reg?.returned === (reg?.rows ?? []).length && reg?.limit === 60
    && reg?.offset === 0, { c: reg?.count, r: reg?.returned, l: reg?.limit });
  check("…with the undoing on the top line, which is the page an office wants: every movement written "
    + "here shares one transaction timestamp, so the register's own tie-break is the number",
    reg?.rows?.[0]?.ref === R1?.reversal?.ref
    && same((reg?.rows ?? []).map((x: any) => x.ref), (reg?.rows ?? []).map((x: any) => x.ref)
      .slice().sort().reverse()), (reg?.rows ?? []).map((x: any) => x.ref));
  const first = (reg?.rows ?? []).find((x: any) => x.ref === P1?.ref) ?? {};
  check("…and each line says which account the money left and which it entered, in the chart's own "
    + "codes, because a list of amounts does not answer the question a register is asked",
    first?.moved === "OPS-CASH out, ESCROW-TZS in" && (first?.sides ?? []).length === 2
    && Number(first?.debited) === Number(first?.credited)
    && first?.raised_by === "Ledger Pen" && first?.posted_on === DAY,
    { moved: first?.moved, sides: first?.sides?.length });
  check("…the day is sent as the day the papers carry rather than as a moment that would land on the "
    + "wrong side of midnight, and every figure on the page survives the trip back to the desk down "
    + "to its last cent",
    /^\d{4}-\d{2}-\d{2}$/.test(String(first?.posted_on ?? ""))
    && (reg?.rows ?? []).every((x: any) => {
      const cents = Number(x.total) * 100;
      return Math.abs(cents - Math.round(cents)) < 1e-6 && Number.isFinite(cents);
    })
    && Number(first?.total) === 150000 && Math.round(Number(first?.total) * 100) === 15000000,
    { day: first?.posted_on, total: first?.total, shape: typeof first?.total });
  note("…which is the honest shape of that claim: a figure that leaves the register inside jsonb "
    + "arrives at the desk as a number, not as the two-decimal string the book prints. `150000.00` "
    + "is proved in SQL above, where `#>> '{total}'` keeps the columns; a gate that demanded the "
    + "same string from the client would be blaming node-pg for the book. So the register is proved "
    + "not to lose cents, and the desk that formats it must do the two decimals itself.");
  check("…and no line carries a tenant id or an idempotency key: the register is a page of a book, "
    + "not a way to enumerate whose books exist",
    (reg?.rows ?? []).every((x: any) => !("tenant_id" in x) && !("idempotency_key" in x)),
    Object.keys(reg?.rows?.[0] ?? {}));
  for (const [st, n] of [["posted", 6], ["reversed", 1]] as [string, number][]) {
    const r2 = await call(`a register filtered to ${st} movements`, REGISTER_SQL,
      [PLAT, st, null, null, null, null, null]);
    check(`…answers ${n} row(s) of ${st} and still counts the whole book at seven`,
      r2?.count === n && (r2?.rows ?? []).length === n
      && r2?.rows?.every((x: any) => x.status === st), { n: r2?.count, rows: r2?.rows?.length });
  }
  const usdReg = await call("a register cut to one money", REGISTER_SQL,
    [PLAT, null, "USD", null, null, null, null]);
  check("…finds the one dollar movement and the six shilling ones are not in it, which is the only "
    + "reason two monies can be kept in one book",
    usdReg?.count === 1 && usdReg?.rows?.[0]?.ref === P4?.ref
    && usdReg?.rows?.every((x: any) => x.currency === "USD"), usdReg?.rows?.map((x: any) => x.ref));
  const escrowLeg = await one(`select id from money_accounts where tenant_id = $1 and code = 'ESCROW-TZS'`,
    [PLAT]);
  const byAcct = await call("a register asked for one account", REGISTER_SQL,
    [PLAT, null, null, escrowLeg?.id, null, null, null]);
  check("…answers both the mistake and its undoing, because the office asks what happened to this "
    + "line, not what happened on one day",
    byAcct?.count === 2 && same((byAcct?.rows ?? []).map((x: any) => x.ref),
      [P1?.ref, R1?.reversal?.ref]), byAcct?.rows?.map((x: any) => x.ref));
  const byStamp = await call("a search on the gate's own word", REGISTER_SQL,
    [PLAT, null, null, null, STAMP, null, null]);
  check("…finds every movement the gate wrote, since each one's words carry it",
    byStamp?.count === 7 && (byStamp?.rows ?? []).length === 7, byStamp?.count);
  const byRef = await call("…and a search on a movement's number", REGISTER_SQL,
    [PLAT, null, null, null, P1?.ref, null, null]);
  check("…finds the movement and the mirror that quotes it in its own words, which is the pair an "
    + "office wants side by side rather than one of",
    byRef?.count === 2 && same((byRef?.rows ?? []).map((x: any) => x.ref),
      [P1?.ref, R1?.reversal?.ref]), byRef?.rows?.map((x: any) => x.ref));
  for (const [lim, want2] of [[null, 60], [5000, 200], [0, 1], [-5, 1]] as [any, number][]) {
    const r3 = await call(`a page asked for ${lim === null ? "no limit at all" : `limit ${lim}`}`,
      REGISTER_SQL, [PLAT, null, null, null, null, lim, 0]);
    check(`…is clamped to ${want2}, because a register that honours any number a client types is a `
      + "way to ask for the whole book", r3?.limit === want2
      && (r3?.rows ?? []).length === Math.min(want2, r3?.count ?? 0), { lim, got: r3?.limit });
  }
  const paged = await call("a page past the end of the book", REGISTER_SQL,
    [PLAT, null, null, null, null, 3, 99]);
  check("…answers empty rows and a full count rather than an error, and a negative offset is taken "
    + "as zero", paged?.count === 7 && (paged?.rows ?? []).length === 0 && paged?.returned === 0, paged);
  const negOff = await call("…which is what the same door does with an offset below nothing",
    REGISTER_SQL, [PLAT, null, null, null, null, 3, -10]);
  check("…offset clamped to zero and the first three rows handed back",
    negOff?.offset === 0 && (negOff?.rows ?? []).length === 3, { o: negOff?.offset });

  const P3d = await call("one movement, opened", DETAIL_SQL, [PLAT, P3?.id]);
  check("…carries its three legs, the two sides that balance the third, and no answer, because "
    + "nobody has undone it", (P3d?.legs ?? []).length === 3
    && P3d?.legs?.filter((l: any) => l.direction === "debit").length === 2
    && P3d?.answers === null && P3d?.answered_by === null && P3d?.status === "posted",
    { legs: P3d?.legs?.length, answers: P3d?.answers });
  check("…and the source pointer is a pointer: `source_id` is allowed to be nothing at all and the "
    + "paper reference is what a desk quotes",
    P3d?.source_id === null && P3d?.source_ref === null && P3d?.idempotency_key === undefined,
    Object.keys(P3d ?? {}));
  const cross = await call("a movement of another book read through this one's door", DETAIL_SQL,
    [PLAT, TB1?.id]);
  check("…answers nothing, which is the same answer as a movement that never existed",
    cross === null, cross);

  // ---------------- 8 · the rows written without the door ----------------
  phase("8 · below the door: the rules a writer that skips it still cannot break");
  let hand = 0;
  const hdr = (id: string, total: string, o: Record<string, any> = {}): [string, any[]] => {
    hand++;
    return [`insert into money_postings (id, tenant_id, ref, posted_on, memo, currency, source_kind,
        total, raised_by)
      values ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::numeric, $9::uuid)`,
      [id, o.tenant ?? PLAT, `PST-2099-9${String(hand).padStart(4, "0")}`, DAY,
        MEMO(`a header written by hand number ${hand}`), o.currency ?? "TZS",
        o.kind ?? "manual", total, o.actor ?? PEN]];
  };
  const leg = (pid: string, account: string, dir: string, amount: string,
    o: Record<string, any> = {}): [string, any[]] =>
    [`insert into money_entries (posting_id, tenant_id, account_id, direction, amount, detail)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5::numeric, $6)`,
      [pid, o.tenant ?? PLAT, account, dir, amount,
        o.detail ?? "a leg the gate wrote without the door"]];
  /** The balance rule is DEFERRED: inside a transaction a half movement is perfectly legal and only
   *  the closing of the transaction refuses it. `SET CONSTRAINTS ALL IMMEDIATE` asks that question on
   *  demand, which is how a gate can prove a commit-time rule and still roll the whole run back.
   *  The question is asked LAST, after the shape has been written with the rule still deferred —
   *  asking it first would refuse the header while it has no legs at all and every probe would read
   *  as the zero-leg sentence. Phase 10 asks the same thing of a real COMMIT, on a connection that
   *  means it. */
  const ASK: [string, any[]] = ["set constraints all immediate", []];
  const relax = () => oi("set constraints all deferred");
  const atOnce = async (label: string, stmts: [string, any[]][], want = "") => {
    const { err } = await block([...stmts, ASK]);
    await relax();
    check(label, !!err, err ? "" : "expected the balance rule to refuse, and it accepted");
    if (err && want) check(`…in the words "${want}"`, String(err.message).includes(want), err.message);
    return err;
  };

  // The positive control first, and it does double duty: asking the commit question after the hand-
  // written movement also fires the queued events of every movement the door wrote in phases 4 to 6,
  // so all eight of them are proved against the rule in one statement.
  const HID = randomUUID();
  const H2 = randomUUID();
  const OPS_CASH = A["OPS-CASH"].id;
  const OPS_BANK = A["OPS-BANK"].id;
  const good = await block([hdr(HID, "25.00"), leg(HID, OPS_CASH, "debit", "25.00"),
    leg(HID, OPS_BANK, "credit", "25.00"), ASK]);
  await relax();
  check("a balanced movement written leg by leg without the door passes the question a commit asks — "
    + "and so did all eight movements the door had already written, whose queued events fired in "
    + "this same statement", !good.err, good.err?.message);
  check("…with its figure, its two sides and its number in the book, since nothing above the row "
    + "decided them",
    (await one(`select ref, total from money_postings where id = $1`, [HID]))?.total != null
    && (await one(`select count(*)::int as n from money_entries where posting_id = $1`, [HID]))?.n === 2);
  const afterHand = await one(`select debit_total, entry_count from money_accounts where id = $1`,
    [OPS_CASH]);
  check("…and the account's cached figure rose by the leg that was written by hand, because the "
    + "trigger that keeps it hangs on the leg and not on the door",
    Number(afterHand?.debit_total) === 150055 && afterHand?.entry_count === 6,
    { total: afterHand?.debit_total, n: afterHand?.entry_count });

  // The five shapes the door refuses to write, written here by hand and closed with the question.
  const N0 = randomUUID();
  await atOnce("a movement with no legs at all is refused by the rule on the header, which exists "
    + "for exactly this shape — a leg can only report a movement that has one",
    [hdr(N0, "20.00")], "carries 0 leg(s). Money that moves has to leave one account");
  const N1 = randomUUID();
  await atOnce("one leg is refused at the commit too, and the count in the sentence is the number a "
    + "desk has to be told",
    [hdr(N1, "40.00"), leg(N1, OPS_CASH, "debit", "40.00")], "carries 1 leg(s)");
  const N2 = randomUUID();
  await atOnce("two debits with no credit is a movement that only goes one way, and the refusal says "
    + "both figures rather than the word `unbalanced`",
    [hdr(N2, "20.00"), leg(N2, OPS_CASH, "debit", "10.00"), leg(N2, OPS_BANK, "debit", "10.00")],
    "is all on one side — 20.00 debited, 0.00 credited");
  const N3 = randomUUID();
  await atOnce("ten short is refused, and the sentence carries the difference and the money it is "
    + "short in, because an office reconciles in one currency at a time",
    [hdr(N3, "100.00"), leg(N3, OPS_CASH, "debit", "100.00"),
      leg(N3, A["ESCROW-TZS"].id, "credit", "90.00")],
    "does not balance: debits 100.00 against credits 90.00 (out by 10.00 TZS)");
  const N4 = randomUUID();
  await atOnce("a header whose figure disagrees with its own legs is refused even though the legs "
    + "balance each other, because the total is copied from them and a typed total is a typed lie",
    [hdr(N4, "30.00"), leg(N4, OPS_CASH, "debit", "10.00"), leg(N4, OPS_BANK, "credit", "10.00")],
    "says it moved 30.00 but its legs add up to 10.00");
  check("…and none of the five left a row behind: a rollback discards the events the rolled-back "
    + "statements had queued, so a probe cannot come back later and refuse a commit that has done "
    + "nothing wrong",
    (await one(`select count(*)::int as n from money_postings where id = any($1::uuid[])`,
      [[N0, N1, N2, N3, N4]]))?.n === 0
    && (await one(`select count(*)::int as n from money_entries where posting_id = any($1::uuid[])`,
      [[N0, N1, N2, N3, N4]]))?.n === 0,
    await oi(`select id, ref from money_postings where id = any($1::uuid[])`, [[N0, N1, N2, N3, N4]]));
  const sq8 = await call("the book still agrees with itself after five refused movements", SQUARE_SQL,
    [PLAT]);
  check("…because the rule that refused them never let them into the count",
    sq8?.square === true && sq8?.postings === 8 && sq8?.refs?.length === 0, sq8);

  // ---- append-only, below the door ----
  const legRow = await one(`select id from money_entries where posting_id = $1 limit 1`, [HID]);
  await fails("a leg cannot be rewritten by anybody, not even the seat that owns the book, and the "
    + "refusal points at the movement a mirror should be posted against",
    `update money_entries set amount = 26.00 where id = $1`, [legRow?.id], "is never rewritten");
  check("…naming it by the number a desk can quote rather than by a uuid",
    (await one(`select ref from money_postings where id = $1`, [HID]))?.ref != null);
  await fails("…and a leg cannot be erased, which is the rule that makes an append-only book an "
    + "append-only book rather than a suggestion",
    `delete from money_entries where id = $1`, [legRow?.id], "is never erased");
  await fails("a posted movement's own words are frozen: the day, the figure and the pen that signed "
    + "it are the three things an auditor came to read",
    `update money_postings set total = 26.00 where id = $1`, [HID], "stays that way");
  await fails("…and so is its memo, which is the sentence that explains the figure",
    `update money_postings set memo = $2 where id = $1`, [HID, MEMO("a memo rewritten after the "
      + "fact, which the guard refuses")], "stays that way");
  await fails("a movement may be marked undone by hand, but only with the sentence and the seat that "
    + "did it — the row refuses an unexplained reversal as loudly as the door does",
    `update money_postings set status = 'reversed' where id = $1`, [HID],
    "money_posting_reversal_is_explained");
  const H2ok = await block([hdr(H2, "40.00"), leg(H2, A["COST-OPS"].id, "debit", "40.00"),
    leg(H2, OPS_BANK, "credit", "40.00"), ASK]);
  await relax();
  check("a second movement written by hand is the stand-in for the one whose bookkeeping is about to "
    + "be done by hand", !H2ok.err, H2ok.err?.message);
  const byHand = await guarded(`update money_postings set status = 'reversed', reversal_note = $2,
      reversed_by = $3, reversed_at = now() where id = $1`, [H2, UNDO, PEN]);
  check("…and marking it undone with a reason and a seat is the one update the guard allows, because "
    + "that is the bookkeeping `reverse_money_posting` does", !byHand.err, byHand.err?.message);
  await fails("…while a movement that has already been undone cannot be touched again, which is the "
    + "row-level half of `a movement is undone once`",
    `update money_postings set reversal_note = $2 where id = $1`,
    [H2, MEMO("a second attempt at the reason")], "is already reversed");
  await fails("a movement is deleted by nobody. This is the sentence a desk must be told when it "
    + "asks for a row to go, and the reason a fixture book with legs in it can never be torn down",
    `delete from money_postings where id = $1`, [HID], "is deleted by nobody");
  const keptWhole = await one(`select total, status, memo from money_postings where id = $1`, [HID]);
  check("…and after eleven attempts to change what the book already holds, the movement is still "
    + "there with the figure and the words it was written with",
    Number(keptWhole?.total) === 25 && keptWhole?.status === "posted"
    && String(keptWhole?.memo).includes("by hand number 1"), keptWhole);

  // ---- the belonging guards, asked of a leg the door never approved ----
  // A BEFORE-row trigger runs ahead of the foreign keys, which are only settled after the row is
  // written, so the guard's own sentences are what a desk is told and the keys are the second line
  // underneath. Both are proved, in the order the server reaches them.
  const GHOST = randomUUID();
  await fails("a leg standing on a movement that is not in the book is refused by the guard, which "
    + "reaches it before the foreign key is ever asked",
    `insert into money_entries (posting_id, tenant_id, account_id, direction, amount)
       values ($1::uuid, $2::uuid, $3::uuid, 'debit', 5)`, [GHOST, PLAT, OPS_CASH],
    "cannot stand on a posting that is not in the book");
  await fails("…and a leg naming an account that does not exist by the sentence that says so",
    `insert into money_entries (posting_id, tenant_id, account_id, direction, amount)
       values ($1::uuid, $2::uuid, $3::uuid, 'debit', 5)`, [HID, PLAT, GHOST],
    "cannot name an account that does not exist");
  const crossLeg = await refuses("a leg cannot be written in one book on a movement from another, "
    + "which is the shape a hand-crafted request takes when a uuid is quoted from somebody else's "
    + "screen",
    leg(HID, GATE_IN.id, "debit", "5.00", { tenant: TB }),
    "names a different book from the posting it stands on");
  check("…and the guard reaches that question before it ever looks at the account the leg names, "
    + "which is why a leg carrying two books in one row is refused for the first one it disagrees "
    + "with", /different book/.test(String(crossLeg?.message)), crossLeg?.message);
  await refuses("…and a leg cannot reach through to another book's chart, the refusal naming the "
    + "account it reached for", leg(HID, GATE_IN.id, "debit", "5.00"),
    "is not in that book, so debit cannot move money through it");
  const froze = leg(TB1?.id as string, GATE_STOP.id, "debit", "5.00", { tenant: TB });
  await refuses("a frozen account takes a leg from a hand the same way it takes one from the door: "
    + "the reason is quoted out of the row rather than made to be looked up", froze, "is frozen —");
  check("…with the sentence the office wrote when it stopped it",
    String((await guarded(froze[0], froze[1])).err?.message).includes(REASON), REASON);
  await refuses("a dollar leg inside a shilling movement is refused at the row as well as at the "
    + "door, because the money a leg moves is decided by the account it names",
    leg(HID, USD?.id as string, "debit", "5.00"), "is a USD account and this posting is in TZS");
  await refuses("the two sides are words and not a sign: a hand-written `Debit` is refused by the "
    + "row, since nothing above the row is normalising it",
    leg(HID, OPS_CASH, "Debit", "5.00"), "money_entries_direction_check");
  await refuses("…and so is a negative figure, which is the shape a single-entry book would have "
    + "written instead of a second leg",
    leg(HID, OPS_CASH, "debit", "-5.00"), "money_entries_amount_check");
  await refuses("…and a leg dated into a book by a seat that has none: the row's `tenant_id` is the "
    + "only book a hand can write into, and it cannot be made to disagree with the movement above it",
    leg(HID, OPS_CASH, "debit", "5.00", { tenant: TR }), "different book");
  const afterGuards = await one(`select count(*)::int as n from money_entries where posting_id = $1`,
    [HID]);
  check("none of the seven reached the book, so the movement the gate wrote by hand still carries "
    + "exactly the two legs it was balanced with", afterGuards?.n === 2, afterGuards);

  // ---- the cached figure is a cache ----
  await okDo("an account's cached total can be moved by a hand, because the guard that keeps the "
    + "book is on the legs and not on the chart",
    `update money_accounts set debit_total = debit_total + 5.00 where id = $1`, [OPS_CASH]);
  const bkDrift = await call("…and the book prints the cached figure beside the one recomputed from "
    + "the legs, so the drift is a number on a screen rather than a rumour", BOOK_SQL, [PLAT]);
  const drifted = (bkDrift?.accounts ?? []).filter((a: any) => a.drift === true);
  check("…naming the one account that drifted and no other",
    drifted.length === 1 && drifted[0]?.code === "OPS-CASH"
    && Number(drifted[0]?.cached?.debit) === 150060 && Number(drifted[0]?.recomputed?.debit) === 150055,
    drifted);
  const sqDrift = await call("…while the balance rule still calls the book square", SQUARE_SQL, [PLAT]);
  check("because it counts the legs and not the columns that summarise them: a wrong cache is a "
    + "display fault, a wrong leg is the book itself, and only one of the two is called a lie",
    sqDrift?.square === true && sqDrift?.unbalanced === 0, sqDrift);
  await okDo("putting the cache back is arithmetic on the legs, which is what a reconciliation door "
    + "will do in 135", `update money_accounts set
        debit_total = coalesce((select sum(e.amount) from money_entries e
          where e.account_id = money_accounts.id and e.direction = 'debit'), 0),
        credit_total = coalesce((select sum(e.amount) from money_entries e
          where e.account_id = money_accounts.id and e.direction = 'credit'), 0),
        entry_count = coalesce((select count(*) from money_entries e
          where e.account_id = money_accounts.id), 0)::int
      where id = $1`, [OPS_CASH]);
  const bkFixed = await call("…and the book agrees with itself again", BOOK_SQL, [PLAT]);
  check("with no line flagged, which is the state the desk should be in every morning",
    (bkFixed?.accounts ?? []).every((a: any) => a.drift === false)
    && Number((bkFixed?.accounts ?? []).find((a: any) => a.code === "OPS-CASH")?.cached?.debit) === 150055,
    (bkFixed?.accounts ?? []).filter((a: any) => a.drift !== false).map((a: any) => a.code));
  note("133 opens no repair door: it makes drift visible and leaves the fixing to #344e's "
    + "reconciliation, which will need a signature of its own because it changes a figure a desk "
    + "has already read.");

  // ---------------- 9 · the plans a big book pays for ----------------
  phase("9 · EXPLAIN: which index serves a book that has outgrown its page");
  // The office's book holds nine movements this morning, so a planner working from today's numbers
  // would seq-scan all four reads and be right to. `enable_seqscan = off` turns each of these into a
  // question about the book the office will have in a year: is there an index that serves the shape,
  // and does it serve the order the desk asked for, or is a Sort sitting on top of it.
  await oi("set local enable_seqscan = off");
  check("the setting that forces the question is the one this session says it set",
    (await one("show enable_seqscan"))?.enable_seqscan === "off", await one("show enable_seqscan"));
  const plan = async (sql: string, p: any[] = []) => {
    const { rows, err } = await guarded(`explain (format json) ${sql}`, p);
    if (err) {
      check(`…the plan for "${sql.replace(/\s+/g, " ").slice(0, 70)}" could not be built`, false,
        err.message);
      return null as Record<string, any> | null;
    }
    return (rows?.[0]?.["QUERY PLAN"]?.[0]?.Plan ?? null) as Record<string, any> | null;
  };
  const nodes: Record<string, any>[] = [];
  const walk = (n: any) => {
    if (!n) return;
    nodes.push(n);
    (n.Plans ?? []).forEach(walk);
    (n.Subplans ?? []).forEach(walk);
  };
  const used = (root: any) => { nodes.length = 0; walk(root);
    return nodes.map((n) => n["Index Name"]).filter(Boolean) as string[]; };
  const shape = (root: any) => { nodes.length = 0; walk(root);
    return nodes.map((n) => n["Node Type"]) as string[]; };
  const table = (root: any) => { nodes.length = 0; walk(root);
    return nodes.filter((n) => n["Node Type"] === "Seq Scan")
      .map((n) => n["Relation Name"]) as string[]; };

  const pageOf = stmtBetween(src, "select p2.id, p2.raised_at", "limit v_limit offset v_offset")
    .replace(/\bp_tenant\b/g, "$1::uuid").replace(/\bp_status\b/g, "$2::text")
    .replace(/\bp_currency\b/g, "$3::text").replace(/\bp_account\b/g, "$4::uuid")
    .replace(/\bp_search\b/g, "$5::text").replace(/\bv_limit\b/g, "$6::int")
    .replace(/\bv_offset\b/g, "$7::int");
  check("the paged read below is the register's own statement cut out of the file with only its "
    + "plpgsql variables swapped for bind parameters, so what follows is a plan for 133 and not for "
    + "a paraphrase of it", pageOf.includes("order by p2.raised_at desc")
    && pageOf.includes("limit $6::int offset $7::int")
    && !/\b(p_tenant|p_status|v_limit|v_offset)\b/.test(pageOf), pageOf.slice(0, 160));
  const pgPage = await plan(pageOf, [PLAT, null, null, null, null, 60, 0]);
  check("the register's page is served by the index built for it — one book, newest first",
    used(pgPage).includes("money_postings_book_recent_idx"), { idx: used(pgPage) });
  check("…and it arrives already in the order the desk asked for, so sixty movements out of six "
    + "hundred are cut off the top of an index rather than sorted out of a table",
    !shape(pgPage).includes("Sort"), { nodes: shape(pgPage) });
  check("…with no sequential read of the movements anywhere in the plan",
    table(pgPage).length === 0, { seq: table(pgPage) });

  const legsOf = `select e.direction, e.amount, ac.code from money_entries e
     join money_accounts ac on ac.id = e.account_id where e.posting_id = $1::uuid`;
  check("the legs below are the lateral the register joins for every row of its page — the file "
    + "asks the same question per movement, which is why the key is on the movement alone",
    src.includes("where e.posting_id = p.id"));
  const pgLegs = await plan(legsOf, [HID]);
  check("one movement's legs are found by the index on the movement they hang from",
    used(pgLegs).includes("money_entries_posting_idx") && table(pgLegs).length === 0,
    { idx: used(pgLegs), seq: table(pgLegs) });

  const stmtOf = `select e.created_at, e.direction, e.amount from money_entries e
     where e.account_id = $1::uuid order by e.created_at desc limit 50`;
  const pgStmtFreely = await plan(stmtOf, [OPS_CASH]);
  await oi("set local enable_sort = off");
  const pgStmt = await plan(stmtOf, [OPS_CASH]);
  await oi("reset enable_sort");
  check("an account's statement is served by the index that pairs the account with the date, so the "
    + "ledger a desk scrolls newest-first is an index walk and not a sort of every leg in the book",
    used(pgStmt).includes("money_entries_account_idx") && !shape(pgStmt).includes("Sort")
    && table(pgStmt).length === 0,
    { idx: used(pgStmt), nodes: shape(pgStmt), if_sorting_is_allowed: shape(pgStmtFreely) });
  note("…which is only visible with `enable_sort` turned off, and the gate says so rather than "
    + "quietly leaving it off: on a book this size the planner takes the same rows out of the same "
    + `index, sorts them, and calls it cheaper — "${shape(pgStmtFreely).join(" -> ")}". What the `
    + "index has to answer is whether it can hand the legs back in the order the desk asked for, "
    + "because a year of movements in an office's busiest account is the day that sort stops being "
    + "cheap. The reset above puts the session back the way the office's own doors run.");

  const chartOf = `select a.code, a.label, a.kind from money_accounts a
     where a.tenant_id = $1::uuid order by a.kind, a.code`;
  const pgChart = await plan(chartOf, [PLAT]);
  check("the chart opens grouped by kind and ordered by code — the order the book prints it in — off "
    + "the one index that carries all three",
    used(pgChart).includes("money_accounts_book_idx") && !shape(pgChart).includes("Sort")
    && table(pgChart).length === 0, { idx: used(pgChart), nodes: shape(pgChart) });

  const idemLit = `select p.id, p.ref from money_postings p
     where p.tenant_id = $1::uuid and p.idempotency_key = 'gate-key-probe-133'`;
  const pgIdem = await plan(idemLit, [PLAT]);
  check("a retry lookup finds the key through the partial unique index, which is the only place a "
    + "key is written",
    used(pgIdem).includes("money_postings_idempotency_per_book") && table(pgIdem).length === 0,
    { idx: used(pgIdem), seq: table(pgIdem) });
  const pgIdemP = await plan(`select p.id from money_postings p
     where p.tenant_id = $1::uuid and idempotency_key = $2::text`, [PLAT, "gate-key-probe-133"]);
  note("The door sends the key as a bind parameter, and a partial index only serves a clause whose "
    + "nullness the planner can prove. With the key spelled as a constant the plan reads "
    + `"${used(pgIdem).join(", ") || "a sequential read"}"; with the same clause as a parameter it `
    + `reads "${used(pgIdemP).join(", ") || "a sequential read"}". A retry read that missed the `
    + "index would still be correct and merely slow, which is why this is a note and not a "
    + "requirement.");

  check("the two indexes 133 drops really are gone, so no plan can quietly fall back onto a key the "
    + "file decided was the wrong shape",
    !idxRows.some((i: any) => ["money_postings_book_day_idx", "money_entries_book_idx"]
      .includes(i.name))
    && src.includes("drop index if exists money_postings_book_day_idx")
    && src.includes("drop index if exists money_entries_book_idx"),
    idxRows.filter((i: any) => /day_idx|book_idx$/.test(i.name)).map((i: any) => i.name));
  await oi("set local enable_seqscan to default");
  note("These four plans are the whole reason 133 builds an index per read rather than one per "
    + "column: a register page, a movement's legs, an account's statement and the chart. The legs "
    + "index is on the movement alone because the register asks for the legs of each row it shows, "
    + "not for a book's legs in a day — which is exactly what the dropped day index was.");

  // ---------------- 10 · the rule that only speaks at COMMIT ----------------
  phase("10 · five transactions that mean it, and the server that closes them");
  // Everything above proved the deferred rule by asking it early. This proves it the way the desk
  // will meet it: a real connection, a real COMMIT, and no `set constraints` at all. The inserts are
  // expected to succeed — inside an open transaction a half movement is legal — and only the closing
  // of the transaction is allowed to refuse. A commit refused by a deferred trigger is rolled back by
  // the server itself, so this is the one part of the gate that tests the rule for real and still
  // leaves nothing in the book.
  const doomed = await connect(url);
  const D = (total: string, legs: [string, string, string][], o: Record<string, any> = {}):
    [string, [string, any[]][]] => {
    const id = randomUUID();
    return [id, [hdr(id, total, { tenant: TD, actor: ASH, ...o }),
      ...legs.map(([ac, dir, amt]) => leg(id, ac, dir, amt, { tenant: TD }))]];
  };
  const FIVE: [string, [string, any[]][], string][] = [
    ["a movement with no legs, committed as it stands, is refused at the close by the rule on the "
      + "header", D("12.00", [])[1], "carries 0 leg(s)"],
    ["…and one leg is refused at the close too, with its count in the sentence",
      D("12.00", [[DOOM_IN.id, "debit", "12.00"]])[1], "carries 1 leg(s)"],
    ["two debits are refused at the close as the one-sided movement they are",
      D("12.00", [[DOOM_IN.id, "debit", "6.00"], [DOOM_OUT.id, "debit", "6.00"]])[1],
      "is all on one side — 12.00 debited, 0.00 credited"],
    ["a shilling short is refused at the close, and the difference and the money it is short in are "
      + "both in the words",
      D("12.00", [[DOOM_IN.id, "debit", "12.00"], [DOOM_OUT.id, "credit", "11.00"]])[1],
      "does not balance: debits 12.00 against credits 11.00 (out by 1.00 TZS)"],
    ["a total typed away from its own legs is refused at the close even though the legs balance "
      + "each other",
      D("7.00", [[DOOM_IN.id, "debit", "9.00"], [DOOM_OUT.id, "credit", "9.00"]])[1],
      "says it moved 7.00 but its legs add up to 9.00"]
  ];
  for (const [label, stmts, want] of FIVE) {
    let wrote = 0, mid: any = null, closed: any = null;
    await doomed.query("begin");
    try {
      for (const [sql, p] of stmts) { await doomed.query(sql, p); wrote++; }
    } catch (e: any) { mid = e; }
    if (!mid) { try { await doomed.query("commit"); } catch (e: any) { closed = e; } }
    else await doomed.query("rollback").catch(() => undefined);
    check(label, wrote === stmts.length && !mid && !!closed,
      mid ? `the write itself raised: ${mid.message}`
        : (closed ? "" : "the commit was accepted, so the rule did not run at the close"));
    if (closed) check(`…at the COMMIT, in the words "${want}"`,
      String(closed.message).includes(want), closed.message);
  }

  // The duplicate key is the one shape here that the server would keep, so this pair is closed by
  // hand instead of by a doomed commit: the first of the two is a balanced movement, and an accepted
  // movement can never be removed.
  const D1 = randomUUID();
  const KEY = MEMO("the same key sent twice");
  const hdrKey = (id: string, key: string): [string, any[]] => [
    `insert into money_postings (id, tenant_id, ref, posted_on, memo, currency, source_kind,
        total, raised_by, idempotency_key)
      values ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::numeric, $9::uuid, $10)`,
    [id, TD, `PST-2099-8${String(++hand).padStart(4, "0")}`, DAY, MEMO("a header carrying a key"),
      "TZS", "manual", "12.00", ASH, key]];
  await doomed.query("begin");
  let pair: any = null, dup: any = null;
  try {
    for (const [sql, p] of [hdrKey(D1, KEY),
      leg(D1, DOOM_IN.id, "debit", "12.00", { tenant: TD }),
      leg(D1, DOOM_OUT.id, "credit", "12.00", { tenant: TD })]) await doomed.query(sql, p);
  } catch (e: any) { pair = e; }
  if (!pair) { try { await doomed.query(...hdrKey(randomUUID(), KEY)); } catch (e: any) { dup = e; } }
  await doomed.query("rollback").catch(() => undefined);
  check("a balanced movement written straight onto the rows is accepted while the transaction is "
    + "open, because the rule that judges it has not been asked yet", !pair, pair?.message);
  check("…while a second movement carrying the same book's same key is refused at the insert rather "
    + "than at the close, because the key is a row and not a habit", !!dup
    && (dup?.code === "23505" || String(dup?.message).includes("money_postings_idempotency_per_book")),
    dup ? { code: dup.code, constraint: dup.constraint } : "the duplicate key was accepted");
  check("…and the refusal names the partial index, which is the only place a key is written",
    String(dup?.constraint ?? dup?.message).includes("money_postings_idempotency_per_book"),
    { constraint: dup?.constraint, message: dup?.message });

  // One branch of the commit rule has no road to it, and the gate says so rather than leaving the
  // reader to hunt for a probe that would reach it.
  const GONE = randomUUID();
  await doomed.query("begin");
  let unhook: any = null, unhookErr: any = null;
  try {
    for (const [sql, p] of [hdr(GONE, "4.00", { tenant: TD, actor: ASH }),
      leg(GONE, DOOM_IN.id, "debit", "4.00", { tenant: TD }),
      leg(GONE, DOOM_OUT.id, "credit", "4.00", { tenant: TD })]) await doomed.query(sql, p);
    await doomed.query(`delete from money_postings where id = $1`, [GONE]);
  } catch (e: any) { unhookErr = e; }
  await doomed.query("rollback").catch(() => undefined);
  check("the balance trigger's sentence about a movement whose header has gone out of the book "
    + "cannot be reached, because the guard under it refuses a delete for every role that exists",
    !!unhookErr && !unhook && String(unhookErr.message).includes("is deleted by nobody"),
    unhookErr ? { code: unhookErr.code, message: unhookErr.message } : "the delete was accepted");
  note("`133: the posting a leg stood on is gone from the book` is therefore a sentence this schema "
    + "can only raise by dropping a trigger. It is kept as the last line under a broken append-only "
    + "guard, not as a case the desk will ever be shown.");
  await doomed.end().catch(() => undefined);

  const leftBehind = await tidy.query(
    `select (select count(*)::int from money_postings where tenant_id = any($1::uuid[])) as postings,
            (select count(*)::int from money_entries where tenant_id = any($1::uuid[])) as legs,
            (select count(*)::int from money_postings) as all_postings,
            (select count(*)::int from money_entries) as all_legs`, [BOOKS]);
  check("every one of the six doomed transactions left nothing behind in any book — the company's "
    + "register and the office's are both still at the counts they held before this run began",
    leftBehind.rows[0].postings === 0 && leftBehind.rows[0].legs === 0
    && leftBehind.rows[0].all_postings === BASE.postings
    && leftBehind.rows[0].all_legs === BASE.legs, leftBehind.rows[0]);
  const seqNow = (await tidy.query(`select last_value::int as v from money_posting_number_seq`))
    .rows[0]?.v as number;
  check("…while the numbering has moved ahead of where it was, since a rolled back transaction "
    + "cannot hand a number back", seqNow > BASE.seq, { before: BASE.seq, now: seqNow });
  note("So the book's numbers are never dense: the six doomed commits and the refused door posts "
    + "above each burned a number that names nothing. A desk that reconciled movements by counting "
    + "their numbers would find a gap every time somebody typed a movement wrong, which is why the "
    + "register counts rows and never reads a difference in the numbering as a missing page.");

  // ---------------- 11 · the hands that answer the desk ----------------
  phase("11 · what the role that serves the API may and may not do to the book");
  const AU = appUrl();
  let rt: pg.Client | null = null;
  if (!AU) {
    note("APP_DB_PASSWORD is not set, so app_runtime cannot be reached from here. Phase 1 read its "
      + "grants out of the catalog; what cannot be proved without its own connection is what the "
      + "role actually answers when it tries the door.");
  } else {
    try { rt = await connect(AU); } catch (e: any) {
      note(`app_runtime could not connect: ${e.message}`);
    }
  }
  if (rt) {
    const rq = async (sql: string, p: any[] = []) => {
      try { return { rows: (await rt!.query(sql, p)).rows, err: null as any }; }
      catch (e: any) { return { rows: null as any, err: e }; }
    };
    const who = (await rq(`select current_user as who,
      has_schema_privilege('app_runtime', 'platform_auth', 'USAGE') as into_schema`)).rows?.[0];
    check("this really is the role the desk answers with, and it may reach the schema the doors "
      + "stand in", /^app_runtime/.test(String(who?.who)) && who?.into_schema === true, who);

    check("with no book named for the session, the chart the role is granted reads back empty — the "
      + "grant is harmless because the policy is what binds it",
      (await rq(`select count(*)::int as n from money_accounts`)).rows?.[0]?.n === 0,
      (await rq(`select count(*)::int as n from money_accounts`)).rows?.[0]);
    await rq(`select set_config('app.tenant_id', $1, false)`, [TR]);
    const seen = (await rq(`select code from money_accounts order by code`)).rows ?? [];
    check("…and name the book to the session and it sees that book's chart and no other, which is "
      + "the half the API has to get right on every statement",
      seen.length === 2 && seen.every((r: any) => String(r.code).startsWith("RUN-")), seen);

    const writes: [string, any[]][] = [
      ["insert into money_accounts (tenant_id, code, label, kind, currency) values "
        + "($1::uuid,$2,$3,'asset','TZS')", [TR, CODE("rt"), "A probe the role may not write"]],
      ["insert into money_postings (tenant_id, ref, posted_on, memo, currency, source_kind, total) "
        + "values ($1::uuid,'PST-2099-70001',$2::date,$3,'TZS','manual',5)",
        [TR, DAY, MEMO("a movement the role may not write")]],
      ["insert into money_entries (posting_id, tenant_id, account_id, direction, amount) "
        + "values ($1::uuid,$2::uuid,$3::uuid,'debit',5)", [D1, TR, RUN_IN.id]],
      ["update money_accounts set label = $2 where id = $1", [RUN_IN.id, "A label the role may not write"]],
      ["update money_postings set memo = $2 where tenant_id = $1", [TR, MEMO("a memo the role may not write")]],
      ["update money_entries set detail = $2 where tenant_id = $1", [TR, "a leg the role may not move"]],
      ["delete from money_accounts where tenant_id = $1", [TR]],
      ["delete from money_postings where tenant_id = $1", [TR]],
      ["delete from money_entries where tenant_id = $1", [TR]],
      ["truncate money_entries", []]
    ];
    for (const [sql, p] of writes) {
      const { err } = await rq(sql, p);
      check(`the app role is refused "${sql.replace(/\s+/g, " ").slice(0, 46)}…" by its own lack of `
        + "a grant, not by a policy it could set around",
        !!err && err.code === "42501" && /permission denied/.test(String(err.message)),
        err ? { code: err.code, message: err.message } : "the statement was accepted");
    }
    const privs = (await rq(`select c.relname as t,
        has_table_privilege('app_runtime', c.oid, 'SELECT') as s,
        has_table_privilege('app_runtime', c.oid, 'INSERT') as i,
        has_table_privilege('app_runtime', c.oid, 'UPDATE') as u,
        has_table_privilege('app_runtime', c.oid, 'DELETE') as t2
      from pg_class c where c.relname::text = any($1::text[]) order by 1`, [REGISTERS])).rows ?? [];
    check("the role's own answer about the three registers: read, and nothing else, on all three",
      privs.length === 3 && privs.every((r: any) => r.s === true && r.i === false
        && r.u === false && r.t2 === false), privs);

    const fnPrivs: Record<string, boolean> = {};
    for (const d of fnDefs as Record<string, any>[]) {
      const { rows } = await rq(
        `select has_function_privilege('app_runtime', $1::regprocedure, 'EXECUTE') as can`, [d.sig]);
      fnPrivs[d.name] = rows?.[0]?.can === true;
    }
    check("the nine doors are executable by the role that answers the desk, which is the only way an "
      + "API route can reach the book at all", DOORS.every((d) => fnPrivs[d] === true),
      DOORS.filter((d) => fnPrivs[d] !== true));
    check("…and the five trigger bodies are not, so a role that can name a column in a request "
      + "cannot call the code that decides whether the row is honest",
      BODIES.every((b) => fnPrivs[b] === false), BODIES.filter((b) => fnPrivs[b] !== false));

    const acrossBook = (await rq(BOOK_SQL, [PLAT])).rows?.[0]?.r as Book;
    check("a definer is not bound by the session's setting: asked for the office's book while its "
      + "own session names a company, the door answers with ten of the office's accounts",
      (acrossBook?.accounts ?? []).length === 10, { accounts: (acrossBook?.accounts ?? []).length,
        session: "TR"});
    note("That is the shape of the bug #344c must not ship: the door trusts the uuid it is handed, "
      + "RLS does not second-guess a definer, and the API role is a bypassing one. The route has to "
      + "take p_tenant from the session and never from the request body, and the seat check inside "
      + "the door below is the last thing standing between a company and another company's ledger.");
    const wrongSeat = await rq(POST_SQL, [TR, DAY, MEMO("a movement signed by a pen from another "
      + "book"), "TZS", "manual", null, null, null, PEN, JSON.stringify(
      [L(RUN_IN.id, "debit", "7.00"), L(RUN_OUT.id, "credit", "7.00")])]);
    check("…and the door refuses it, because the seat that signs a movement has to belong to the "
      + "book it is written in even when the caller holds every grant",
      !!wrongSeat.err && /does not belong to that book/.test(String(wrongSeat.err.message)),
      wrongSeat.err ? { code: wrongSeat.err.code, message: wrongSeat.err.message }
        : "a foreign pen signed a movement into a company's book");

    await rt.query("begin");
    let viaDoor: Book | null = null, doorErr: any = null;
    try {
      await rt.query(`select set_config('app.tenant_id', $1, true)`, [TR]);
      viaDoor = (await rt.query(POST_SQL, [TR, DAY,
        MEMO("a movement posted through the door by the role that serves the desk"), "TZS",
        "manual", null, null, null, INK,
        JSON.stringify([L(RUN_IN.id, "debit", "7.00"), L(RUN_OUT.id, "credit", "7.00")])]))
        .rows[0]?.r as Book;
    } catch (e: any) { doorErr = e; }
    await rt.query("rollback").catch(() => undefined);
    check("the app role can post a balanced movement through the door, and the door numbers it, "
      + "sums it and answers with the whole row the way the desk will read it",
      !doorErr && viaDoor?.ok === true && String(viaDoor?.posting?.ref ?? "").startsWith("PST-"),
      doorErr?.message ?? viaDoor);
    check("…and the transaction this script closes by hand keeps it out of the book, which is the "
      + "only reason a gate may post at all through a live door",
      (await tidy.query(`select count(*)::int as n from money_postings
        where tenant_id = any($1::uuid[])`, [BOOKS])).rows[0]?.n === 0);
    const squareAfter = (await tidy.query(SQUARE_SQL, [PLAT])).rows[0]?.r as Book;
    check("the office's committed book still reads square after the doomed commits and the runtime "
      + "probes, because none of them ever reached it",
      squareAfter?.square === true && squareAfter?.postings === BASE.postings, squareAfter);
    await rt.end().catch(() => undefined);
  }

  // ---------------- 12 · the duties ----------------
  phase("12 · the three duties 133 hands out, and the two 126 already owned");
  const duties = (await oi(`select key, description from permissions where key like 'control.money%'
    order by 1`)).rows;
  check("three duties and only three, so a desk cannot grow a fourth way into the book",
    duties.length === 3 && same(duties.map((d: any) => d.key),
      ["control.money.view", "control.money.post", "control.money.freeze"]), duties);
  check("…each described for the person who is being given it rather than for the migration that "
    + "inserted it: the house's `Control - ` shape, a whole action in it, and no reference to the "
    + "file that granted it",
    duties.every((d: any) => String(d.description).startsWith("Control - ")
      && d.description.length > 40
      && !/\b(133|migration|added|insert|table)\b/i.test(d.description)),
    duties.map((d: any) => [d.description.length, d.description]));
  const holders = (await oi(`select p.key, array_agg(r.key order by r.key) as who
    from role_permissions rp
    join permissions p on p.key = rp.permission_key
    join roles r on r.id = rp.role_id
   where p.key like 'control.money%' and r.tenant_id is null
   group by 1 order by 1`)).rows as Record<string, any>[];
  const held = (k: string) => (holders.find((h) => h.key === k)?.who ?? []) as string[];
  check("reading the book is a wider duty than writing in it: six roles hold the view and three the "
    + "pen, so an analyst can see a movement without being able to make one",
    same(held("control.money.view"), ["auditor", "billing_admin", "compliance_officer",
      "finance_officer", "platform_analyst", "super_admin"])
    && same(held("control.money.post"), ["billing_admin", "finance_officer", "super_admin"]),
    holders);
  check("…and freezing an account is narrower again, held by the seat that settles disputes and not "
    + "by the one that writes, because a freeze stops somebody else's movement",
    same(held("control.money.freeze"), ["compliance_officer", "super_admin"]), held("control.money.freeze"));
  check("the money the office can move is not the money it can stop: a finance officer posts and "
    + "cannot freeze, a compliance officer reads and freezes but cannot post",
    held("control.money.post").includes("finance_officer")
    && !held("control.money.freeze").includes("finance_officer")
    && held("control.money.freeze").includes("compliance_officer")
    && !held("control.money.post").includes("compliance_officer"), holders.map((h) => [h.key, h.who]));
  check("every duty is a subset of the read, so nobody can hold a pen over a book they cannot see",
    held("control.money.post").every((r) => held("control.money.view").includes(r))
    && held("control.money.freeze").every((r) => held("control.money.view").includes(r)), holders);
  check("…and no company's own role holds any of them, because the insert said so in its where "
    + "clause rather than trusting a key nobody invented for a tenant",
    (await one(`select count(*)::int as n from role_permissions rp
      join roles r on r.id = rp.role_id
      where rp.permission_key like 'control.money%' and r.tenant_id is not null`))?.n === 0);
  const noComments = src.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const paid = (await oi(`select p.key, array_agg(r.key order by r.key) as who
    from role_permissions rp
    join permissions p on p.key = rp.permission_key
    join roles r on r.id = rp.role_id
   where p.key in ('control.payments.manage','control.approvals.decide') and r.tenant_id is null
   group by 1 order by 1`)).rows as Record<string, any>[];
  check("asking for a signature on a movement and giving one are still 126's two keys, unchanged: "
    + "the file neither redefines them nor hands them to a new role",
    paid.length === 2 && !noComments.includes("control.payments.manage")
    && !noComments.includes("control.approvals.decide"),
    { keys: paid.map((p2) => [p2.key, p2.who]), inFile: noComments.includes("control.payments") });
  check("…which is the sentence the comment above the duties promises, and a gate that only read "
    + "the comment would have believed it either way",
    (() => {
      // The file wraps that sentence across a comment break, so the promise is matched against the
      // prose rather than against one source line — the same words a seat reading the migration sees.
      const flat = src.replace(/-- ?/g, " ").replace(/\s+/g, " ");
      return flat.includes("Asking for a signature on a money movement still costs")
        && flat.includes("126's keys, no new ones invented for money")
        && flat.includes("`control.payments.manage`") && flat.includes("`control.approvals.decide`");
    })());

  // ---------------- 13 · the rollback ----------------
  phase("13 · the run closes, and what it leaves behind");
  await owner.query("rollback");
  const after = (await tidy.query(
    `select (select count(*)::int from money_postings) as postings,
            (select count(*)::int from money_entries) as legs,
            (select count(*)::int from money_accounts) as accounts,
            (select count(*)::int from money_accounts where tenant_id = any($1::uuid[])) as ours,
            (select count(*)::int from tenants where id = any($1::uuid[])) as books,
            (select count(*)::int from users where tenant_id = any($1::uuid[])) as seats,
            (select last_value::int from money_posting_number_seq) as seq`, [BOOKS])).rows[0] as Record<string, number>;
  check("every movement and every leg this run wrote — through the door, by hand, and on a second "
    + "connection — is gone from the committed book, which is what the office's ledger sees",
    after.postings === BASE.postings && after.legs === BASE.legs, { base: BASE, after });
  check("…while the numbering keeps the numbers it spent, exactly as it did at phase 10",
    after.seq > BASE.seq, { before: BASE.seq, after: after.seq });
  check("and the three fixture books, their seats and their charts are still standing, because the "
    + "rollback undid the gate's own writes and never touched what it had committed to set them up "
    + "— three seats, since the office's own pen sits in the platform's book and not in a fixture",
    after.books === 3 && after.seats === 3 && after.ours === 8, after);
  const tear = async (sql: string, params: any[] = [BOOKS]) => {
    const { err } = await guardedOn(tidy, sql, params);
    if (err) check(`the run cannot tidy up after itself: ${sql.replace(/\s+/g, " ").slice(0, 48)}`,
      false, err.message);
  };
  await tear(`delete from money_accounts where tenant_id = any($1::uuid[])`);
  await tear(`delete from users where tenant_id = any($1::uuid[])`);
  await tear(`delete from tenants where id = any($1::uuid[])`);
  // The office's own pen signs the platform's book, so a teardown keyed on the fixture books walks
  // straight past it. It goes by this run's stamp — the same shape the pre-flight sweep used, which
  // is how a crashed rehearsal's seat is cleared before this run opens its own.
  await tear(`delete from users where email like '%.133sql%@waisha.test'`, []);
  const clean = (await tidy.query(
    `select (select count(*)::int from money_accounts) as accounts,
            (select count(*)::int from money_accounts
               where tenant_id in (select id from tenants where name like 'Ledger Gate %')
                  or code ilike '%133sql%') as probes,
            (select count(*)::int from tenants where name like 'Ledger Gate %') as books,
            (select count(*)::int from users where email like '%.133sql%@waisha.test') as seats`
    )).rows[0] as Record<string, number>;
  check("the three fixture books, every seat that signed in this run and every account the gate "
    + "opened are gone, and the chart this run found when it started is the only one left standing",
    clean.accounts === BASE.accounts && clean.probes === 0 && clean.books === 0
    && clean.seats === 0, { base: BASE.accounts, clean });
  note("…leftovers are counted by book and by stamp rather than by the shape of a code, because "
    + "133's own office chart holds `GATE-WAIT`: a sweep written as `code ilike 'gate-%'` would "
    + "have deleted a line of the platform's book, and a probe count written the same way would "
    + "have reported it as this file's rubbish. The office's chart is the office's business.");
  check("…which is the whole teardown rule of this file: a book with a committed leg in it can never "
    + "be tidied, so nothing above was ever allowed to commit one",
    (await tidy.query(`select count(*)::int as n from money_entries`)).rows[0]?.n === BASE.legs);
  const stillOne = (await tidy.query(
    `select count(*)::int as n from schema_migrations where name like '133%'`)).rows[0]?.n;
  check("133 is still recorded exactly once"
    + (APPLY ? ", and the DDL committed above is now what the platform runs"
      : ", and this rehearsal added no record of its own"), stillOne === 1, stillOne);
  if (APPLY) {
    const recheck = (await tidy.query(`select p.proname as name, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1::text[])`, [ALL_FNS])).rows;
    const again = fileBodies(src);
    const differs = recheck.filter((r: any) => again[r.name] !== bodyOf(r.def));
    check("…and the byte-for-byte read from phase 1 now passes, which is the point of the run: the "
      + "bodies below were tested as the file writes them", differs.length === 0,
      differs.map((d: any) => d.name));
  }

  console.log(`\n${proved} checks proved, ${failures} failed — ${APPLY
    ? "133's DDL was committed to dev above, so the file is what the platform runs"
    : "a rehearsal: the DDL, the book and the fixtures were all rolled back"}`);
  if (failures) process.exitCode = 1;
}

/** Teardown runs on its own connection, outside the rolled-back transaction, so a refusal there is
 *  a finding and not a poison: the labels say which. */
async function guardedOn(c: pg.Client, sql: string, p: any[]) {
  try { return { rows: (await c.query(sql, p)).rows, err: null as any }; }
  catch (e: any) { return { rows: null as any, err: e }; }
}

main().catch((e) => { console.error(e); process.exit(1); });





