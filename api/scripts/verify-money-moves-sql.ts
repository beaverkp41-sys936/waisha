/**
 * Live proof for #344g/h/i — the money that waits and the money that leaves (migration 134,
 * `api/src/routes/control-money-moves.routes.ts` and the wallets/escrow/payouts panels of
 * `web/app/control/money/moves.tsx`).
 *
 * 134 put three new desks on top of 133's book, and every one of their rules is kept below the door:
 * a wallet is a liability line the office owes a company, money waits in escrow only against a job
 * that exists, and money leaves the office only when a *second* seat has signed the exact bytes the
 * releasing row still holds. None of those four facts is a column. They are 18 trigger guards, 26
 * bodies that answer nobody, and 30 doors that derive the figures a desk never types. So this file
 * writes rows directly, walks both signature states end to end, and reads the catalog back — the
 * same shape of proof 133's gate is, for the half of the money that 133 could not express.
 *
 * What decides the run's shape is that a payout cannot be tidied up. `money_payouts` refuses DELETE
 * once a movement stands under it, `money_payout_batches` refuses DELETE once it has asked for a
 * signature, and every release, payment and reversal this file walks writes a real movement into the
 * office's ledger. So phases 1 to 16 are ONE transaction that is rolled back at the end, and the only
 * figures committed by the whole run are the ones `--apply` writes when an edited 134 has to reach
 * dev — 134 is recorded in `schema_migrations`, which means `pnpm migrate` will never run it again.
 * 133's gate needed doomed COMMITs because its balance rule is deferred; 134 declares no deferrable
 * trigger at all (its own census asserts "None of them is deferrable"), so one rollback is enough
 * here and no phase has to ask the server to refuse a commit.
 *
 * The fixtures are minted inside that same transaction — companies, seats, a call, a dispute, a
 * payroll run and a refund paper — because nothing below this line may survive it, and a fixture
 * committed on a dev book is a company the office has to explain. The one thing that cannot be
 * proved this way is the row filter on the five registers, so the app-role phase proves the grants
 * and the policies and says plainly that an uncommitted fixture is invisible to a second connection.
 *
 * Run: npx tsx scripts/verify-money-moves-sql.ts          (from api/, rehearses and rolls back)
 *      npx tsx scripts/verify-money-moves-sql.ts --apply  (134's DDL re-applied to dev)
 */
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as url_URL } from "node:url";
import pg from "pg";

const FILE = "migrations/134_the_money_that_waits_and_the_money_that_leaves.sql";
const ROUTE = "src/routes/control-money-moves.routes.ts";
const EFFECTS = "src/control/approvals.ts";
const PROBE = "src/routes/control-analytics.routes.ts";
const APPLY = process.argv.includes("--apply");

const HEX = randomUUID().replace(/-/g, "");
const STAMP = `134sql${HEX.slice(0, 6)}`;
const BOOK = (who: string) => `Moves Gate ${who} ${STAMP}`;
const SEAT = (who: string) => `Moves ${who} ${STAMP}`;
const EMAIL = (who: string) => `moves.${who}.${STAMP}@waisha.test`;
const MEMO = (what: string) => `Moves Gate ${STAMP} ${what}`;
const LINE = (head: string, digits: string) => `${head}${digits}`;
/** The code 134 mints a wallet's liability line with: the first eight hex digits of the md5 of the
 *  holder's own uuid and the money, upper-cased, in the shape `WLT-<8>-<CUR>`. Recomputed here rather
 *  than read out of the door's answer, because the guard's rule is that a wallet moves through the line
 *  its holder and money mint — and a gate that only quoted the door back would be checking that a
 *  function agrees with itself. Pass the holder's id, not its name: the mint is on the uuid, which is
 *  why renaming a company never orphans its line. */
const MINT = (holder: string, cur: string) => `WLT-${createHash("md5")
  .update(`${holder}|${cur}`).digest("hex").slice(0, 8).toUpperCase()}-${cur}`;

const DAY = "2026-10-20";
const PURPOSE = "The office pays this driver for the corridor run it completed.";
const REASON = "The caller is owed money back and the desk has agreed the figure.";
const PLAN = "Hold the demurrage until the clearing agent shows the receipt.";
const NOTE = "Paid by bank transfer, receipt 4471, the clerk who signed is named on it.";
const REFUSE = "The plan does not match what the agent actually charged.";
const STOP = "The holder is under a compliance check and cannot move this money.";
const FAIL = "The rail refused the number: the subscriber is not registered.";

/** The two SQLSTATEs a refusal arrives in, the one a unique pair answers with, the one a column's
 *  foreign key answers with when the row it points at is not in the register, and the one a client
 *  role's hand is answered with. `23505` is not on `guardRefusal`'s map list, because a duplicate key
 *  is the register's own answer rather than a sentence a guard wrote. */
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY = "23503";
const DOOR_RAISE = "P0001";
const UNIQUE_VIOLATION = "23505";
const NO_PRIVILEGE = "42501";

/** 134's own census, spelled out here so that a phase can compare a number with a name rather than
 *  with a literal nobody can read. Eighteen write doors, twelve reads, eighteen guards, eight
 *  helpers — 56 bodies, which is what phase 0 counts. */
const WRITE_DOORS = ["open_money_wallet", "fund_money_wallet", "move_money_wallet",
  "freeze_money_wallet", "raise_money_escrow", "propose_escrow_discharge",
  "refuse_escrow_discharge", "apply_escrow_discharge", "raise_money_payout",
  "open_money_payout_batch", "propose_money_payout", "propose_money_payout_batch",
  "decline_money_payout", "decline_money_payout_batch", "apply_payout_release",
  "mark_money_payout_paid", "mark_money_payout_failed", "close_money_payout_batch"];
const READ_DOORS = ["money_rails", "money_wallet_board", "money_wallet_detail",
  "money_escrow_board", "money_escrow_detail", "money_payout_board", "money_payout_detail",
  "money_payout_batch_board", "money_payout_batch_detail", "money_payable", "money_payees",
  "money_subjects"];
const GUARDS = ["money_wallet_holder_is_a_company", "money_wallet_owns_its_line",
  "money_wallet_identity_is_kept", "escrow_names_its_subject",
  "escrow_wallets_hold_the_same_money", "escrow_plan_is_kept", "escrow_needs_two_seats",
  "escrow_is_not_deleted", "payout_names_its_payee", "payout_line_fits_its_rail",
  "payout_source_is_a_real_paper", "payout_accounts_are_honest", "payout_line_fits_its_batch",
  "payout_frozen_after_signature", "payout_needs_two_seats", "payout_is_not_deleted",
  "payout_batch_figures_are_kept", "payout_batch_is_not_deleted"];
const HELPERS = ["money_figure", "money_move_is_the_office", "money_leg", "money_audit",
  "money_wallet_balance", "money_inflow_account", "money_payout_accounts", "money_approval"];
const DOORS = [...WRITE_DOORS, ...READ_DOORS];
const INTERNAL = [...GUARDS, ...HELPERS];
const ALL_FNS = [...DOORS, ...INTERNAL];

/** The five registers, in the order 134's own `v_walls` lists them. */
const REGISTERS = ["money_payout_rails", "money_wallets", "money_escrow_holds",
  "money_payout_batches", "money_payouts"];
const TRIGGERS = ["money_wallets_name_their_holder", "money_wallets_own_their_lines",
  "money_wallets_keep_their_identity", "money_escrow_names_its_job",
  "money_escrow_wallets_match", "money_escrow_plan_kept", "money_escrow_holds_two_seats",
  "money_escrow_holds_are_kept", "money_payouts_name_their_payee", "money_payouts_fit_their_rails",
  "money_payouts_stand_on_real_papers", "money_payouts_name_honest_lines",
  "money_payouts_fit_their_batches", "money_payouts_keep_their_signed_figure",
  "money_payouts_two_seats", "money_payouts_are_kept",
  "money_payout_batches_keep_their_totals", "money_payout_batches_are_kept"];
const SEQUENCES = ["escrow_hold_number_seq", "payout_batch_number_seq", "payout_number_seq"];
const RAILS = ["mpesa", "tigopesa", "airtel", "halopesa", "bank", "cash"];
const USD_LINES = ["WALLET-USD", "ESCROW-USD", "PAYOUT-DUE-USD", "REFUND-DUE-USD",
  "FEE-INCOME-USD", "COST-OPS-USD", "OPS-USD"];
const DUTIES = ["control.money.pay", "control.money.escrow", "control.money.reveal"];

let failures = 0;
let proved = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) proved++; else failures++;
  // A failed line has to be readable on its own: the checks that compare a whole detail read
  // (`{plan, payee, post, approval}`) cannot be diagnosed inside a short slice, and this file is read
  // from a redirect, not a terminal, so a long tail costs nothing a 400-character one would hide.
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok ? "" : " — "
    + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 4000)}`);
}
function note(msg: string) { console.log(`!!   ${msg}`); }
function phase(t: string) { console.log(`\n--- ${t}`); }
/** Order-insensitive equality: a CHECK's alternation is a set, and the migration writes
 *  `('TZS','USD')` while the alphabet reads `tzs, usd`. */
const same = (a: string[], b: string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && y.every((w, i) => x[i] === w);
};
const sameFold = (a: string[], b: string[]) =>
  same(a.map((w) => w.toLowerCase()), b.map((w) => w.toLowerCase()));

/** The quoted words of a constraint definition as `pg_get_constraintdef` prints it. The whole
 *  definition is lower-cased on the way in, because the deparser writes `IN`, `Btrim` and `::text`
 *  in its own shapes while the needles are the words the migration was typed in. */
function quoted(def: string): string[] {
  return [...def.matchAll(/'([a-z_0-9]+)'(?:::text)?/g)].map((m) => m[1]);
}
/** The word list a column's own CHECK keeps, read out of the shape the deparser writes. Postgres
 *  prints `currency in ('TZS','USD')` back as `currency = ANY (ARRAY['TZS'::text, 'USD'::text])`, so
 *  the needle is the printed form. A second constraint may quote the same list for a different rule —
 *  `money_payouts_check5` re-uses `payee_kind = any (array[…])` to say that a withdrawal pays only a
 *  company or a stranger — so the column's own constraint, which Postgres names
 *  `<table>_<column>_check`, is read first, and a column with no such line is reported as no words
 *  rather than as a guess picked out of somebody else's rule. */
function wordsForColumn(cons: { def: string }[] | Record<string, any>[], column: string,
  table = ""): string[] {
  const named = cons.filter((c) => String((c as Book).conname ?? "") === `${table}_${column}_check`);
  if (named.length === 1) return quoted(named[0].def);
  const hits = cons.filter((c) => c.def.includes(`${column} = any (array[`));
  return hits.length === 1 ? quoted(hits[0].def) : [];
}
/** The same list as the migration file writes it, read from inside the table it belongs to. 134
 *  repeats `currency text not null check (currency in (` on three registers and
 *  `status text not null default 'open' check (status in (` on two, so a search that stopped at the
 *  first hit in the file would compare one table's words with another table's column and call the
 *  mismatch a pass. */
function wordsInTable(src: string, table: string, start: string): string[] {
  const a = src.indexOf(`create table if not exists ${table} (`);
  if (a < 0) return [];
  const close = src.indexOf("\n);", a);
  const body = src.slice(a, close < 0 ? undefined : close);
  const i = body.indexOf(start);
  if (i < 0) return [];
  const rest = body.slice(i + start.length);
  const stop = rest.indexOf(")");
  if (stop < 0) return [];
  return [...rest.slice(0, stop).matchAll(/'([a-z_0-9]+)'/gi)].map((m) => m[1].toLowerCase());
}
/** A CHECK read back out of the catalog is not the text it was typed in: the deparser re-parenthesises
 *  it, prints `Btrim` and adds `::text` to every literal. Stripping the three shapes a rule cannot
 *  change lets a fragment written in the migration's own words be matched against the live row. */
const flat = (s: string) => s.toLowerCase()
  .replace(/::(text|numeric|uuid|integer|date)/g, "")
  .replace(/[()\s]/g, "");
/** 134's money words are upper-case on the desk, and the desk's zod enum keeps them that way. */
function zodEnum(src: string, name: string): string[] {
  const m = src.match(new RegExp(`const ${name}[^=]+=\\s*z\\.enum\\(\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/["']([a-z_0-9]+)["']/gi)].map((x) => x[1]) : [];
}

const SPELL: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, twenty: 20, thirty: 30, fifty: 50, "fifty-six": 56
};

/** One `create or replace function … $$;` block at a time. 134's tables, its triggers, its seeds and
 *  its closing census cannot be re-run — `create table` has no idempotent form for a column added
 *  later, the seeds assert the registers are empty, and the census raises when the office has already
 *  used a desk. What an in-place edit of a recorded migration ever touches is the bodies, the two
 *  `if not exists` index lines and the four privilege statements, and those four sets are what phase 0
 *  replays. Ten of the 56 bodies are `language sql` and end at `$$;` rather than at `end $$;`, so a
 *  scanner that looked for one terminator alone would swallow the following function. */
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
function bodyOf(block: string): string {
  const open = block.match(/\$\w*\$/);
  if (!open || open.index === undefined) return "";
  const tag = open[0];
  const close = block.indexOf(tag, open.index + tag.length);
  if (close < 0) return "";
  return block.slice(open.index + tag.length, close).replace(/\s+/g, " ").trim();
}
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

/** Every connection this file opens is the same shape: the server is remote and its certificate is
 *  not one a script can verify, and a statement that hangs on an index collision would otherwise
 *  keep the gate running until the runner is killed. */
async function connect(url: string) {
  const c = new pg.Client({
    connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 180000
  });
  await c.connect();
  return c;
}

// ---------------- the doors, as calls ----------------
/** Every constant below is 134's own argument list, positionally: a door whose parameters are
 *  reordered is a desk that pays the wrong person, and the only defence is that this file spells the
 *  order out and the server refuses a shape it does not recognise. */
const OPEN_W = `select platform_auth.open_money_wallet(
  $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8) as r`;
const FUND_W = `select platform_auth.fund_money_wallet(
  $1::uuid, $2::uuid, $3::numeric, $4, $5, $6::date, $7::uuid, $8, $9, $10, $11) as r`;
const MOVE_W = `select platform_auth.move_money_wallet(
  $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5, $6::date, $7::uuid, $8, $9, $10, $11) as r`;
const FREEZE_W = `select platform_auth.freeze_money_wallet(
  $1::uuid, $2::uuid, $3, $4::uuid, $5::boolean, $6, $7, $8) as r`;
const RAISE_E = `select platform_auth.raise_money_escrow(
  $1::uuid, $2, $3::uuid, $4::numeric, $5, $6::uuid, $7, $8, $9, $10::date,
  $11::uuid, $12, $13, $14, $15) as r`;
const PROPOSE_E = `select platform_auth.propose_escrow_discharge(
  $1::uuid, $2::uuid, $3, $4::numeric, $5::numeric, $6::numeric, $7::uuid, $8,
  $9::uuid, $10, $11, $12) as r`;
const REFUSE_E = `select platform_auth.refuse_escrow_discharge(
  $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7) as r`;
const APPLY_E = `select platform_auth.apply_escrow_discharge($1::uuid, $2::uuid, $3, $4) as r`;
const RAISE_P = `select platform_auth.raise_money_payout(
  $1::uuid, $2, $3::uuid, $4, $5, $6::bytea, $7, $8, $9::numeric, $10::numeric, $11, $12,
  $13::uuid, $14, $15, $16::uuid, $17::uuid, $18, $19, $20) as r`;
const OPEN_B = `select platform_auth.open_money_payout_batch(
  $1::uuid, $2, $3, $4::uuid, $5, $6, $7) as r`;
const PROPOSE_P = `select platform_auth.propose_money_payout(
  $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7) as r`;
const PROPOSE_PB = `select platform_auth.propose_money_payout_batch(
  $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7) as r`;
const DECLINE_P = `select platform_auth.decline_money_payout(
  $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7) as r`;
const DECLINE_PB = `select platform_auth.decline_money_payout_batch(
  $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7) as r`;
const APPLY_R = `select platform_auth.apply_payout_release($1::uuid, $2::uuid, $3, $4) as r`;
const PAID_P = `select platform_auth.mark_money_payout_paid(
  $1::uuid, $2::uuid, $3, $4::date, $5::uuid, $6, $7, $8) as r`;
const FAILED_P = `select platform_auth.mark_money_payout_failed(
  $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7) as r`;
const CLOSE_B = `select platform_auth.close_money_payout_batch(
  $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7) as r`;
/** 133's own reversal door, reached here by a hand rather than by 134's failed door: a seat with the
 *  money duty can reverse any posted movement, including the accrual a payout stands on. */
const REVERSE_P = `select platform_auth.reverse_money_posting($1::uuid, $2::uuid, $3, $4::uuid) as r`;
/** 133's booking door, reached here without 134 standing in front of it. 12c needs it because `money_payouts_check7`
 *  will not let a payout read `released` without a movement under it, so the only release a hand can write is one
 *  that goes and books the accrual itself — and then the question is what the reads can still see. */
const RECORD_P = `select platform_auth.record_money_posting(
  $1::uuid, $2::date, $3, $4, $5, $6::uuid, $7, $8, $9::uuid, $10::jsonb) as r`;

const RAILS_SQL = `select platform_auth.money_rails($1::uuid) as r`;
const W_BOARD = `select platform_auth.money_wallet_board(
  $1::uuid, $2, $3, $4, $5::int, $6::int) as r`;
const W_DETAIL = `select platform_auth.money_wallet_detail($1::uuid, $2::uuid) as r`;
const E_BOARD = `select platform_auth.money_escrow_board(
  $1::uuid, $2, $3, $4, $5::int, $6::int) as r`;
const E_DETAIL = `select platform_auth.money_escrow_detail($1::uuid, $2::uuid) as r`;
const P_BOARD = `select platform_auth.money_payout_board(
  $1::uuid, $2, $3, $4, $5, $6, $7, $8::int, $9::int) as r`;
const P_DETAIL = `select platform_auth.money_payout_detail($1::uuid, $2::uuid) as r`;
const B_BOARD = `select platform_auth.money_payout_batch_board(
  $1::uuid, $2, $3, $4, $5::int, $6::int) as r`;
const B_DETAIL = `select platform_auth.money_payout_batch_detail($1::uuid, $2::uuid) as r`;
const PAYABLE = `select platform_auth.money_payable($1::uuid) as r`;
const PAYEES = `select platform_auth.money_payees($1::uuid, $2, $3, $4::int) as r`;
const SUBJECTS = `select platform_auth.money_subjects($1::uuid, $2, $3, $4::int) as r`;

// 121's spend order and 133's book, taken verbatim from the desk's own module so that this gate and
// the routes walk the same SQL rather than two near-identical copies.
const DECIDE_SQL = `select platform_auth.decide_approval(
  $1::uuid, $2, $3, $4::uuid, $5, $6, $7) as r`;
const CLAIM_SQL = `select platform_auth.claim_approval($1::uuid, $2::uuid) as r`;
const SETTLE_SQL = `select platform_auth.settle_approval($1::uuid, $2::jsonb) as r`;
const FREEZE_ACC = `select platform_auth.freeze_money_account($1::uuid, $2::uuid, $3, $4::uuid,
  $5::boolean) as r`;
const SQUARE_SQL = `select platform_auth.money_book_is_square($1::uuid) as r`;
const BOOK_SQL = `select platform_auth.money_book($1::uuid) as r`;

/** The legs, in the shape 133's door takes them — used only by the two phases that need a movement
 *  this file writes by hand, so that a guard can be shown refusing an account rather than a figure. */
const L = (account: string, direction: string, amount: string, detail?: string) =>
  ({ account, direction, amount, ...(detail ? { detail } : {}) });

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  const src = readFileSync(FILE, "utf8");
  const routeSrc = readFileSync(ROUTE, "utf8");
  const effectSrc = readFileSync(EFFECTS, "utf8");
  const probeSrc = readFileSync(PROBE, "utf8");

  // ---------------- 0 · the file, executed ----------------
  phase("0 · 134's bodies, its two index lines and its four privilege statements re-run "
    + "against the live catalog");
  const ddl = functionDdl(src);
  const idx = indexDdl(src);
  const priv = [
    stmtBetween(src, "revoke all on function\n  platform_auth.money_wallet_holder_is_a_company(),",
      "from public, anon, authenticated, app_runtime, service_role;"),
    stmtBetween(src, "grant execute on function", "to app_runtime;"),
    stmtBetween(src, "revoke all on function\n  platform_auth.open_money_wallet("
      + "uuid, uuid, text, text, uuid, text, text, text),",
      "from public, anon, authenticated, service_role;"),
    stmtBetween(src, `revoke all on sequence ${SEQUENCES[0]}`,
      "from public, anon, authenticated, app_runtime, service_role;")
  ];
  const replayed = [...ddl, ...idx, ...priv].join("\n");

  check("134 opens and closes its own transaction, and this gate replays neither half of that pair",
    /^begin;$/m.test(src) && /^commit;$/m.test(src)
    && !/^(begin|commit);$/m.test(replayed),
    (src.match(/^(begin|commit);$/gm) ?? []));
  check(`the file declares ${ddl.length} functions and this gate found every one of them`,
    ddl.length === (src.match(/^create or replace function platform_auth\./gm) ?? []).length
    && ddl.length === 56, ddl.length);
  check("…18 write doors, 12 reads, 18 guards and 8 helpers, which is the 56 the file's own census "
    + "says it leaves behind",
    ddl.length === WRITE_DOORS.length + READ_DOORS.length + GUARDS.length + HELPERS.length
    && WRITE_DOORS.length === 18 && READ_DOORS.length === 12
    && GUARDS.length === 18 && HELPERS.length === 8
    && DOORS.every((d) => ddl.some((b) => b.startsWith(`create or replace function platform_auth.${d}(`)))
    && INTERNAL.every((d) => ddl.some((b) => b.startsWith(`create or replace function platform_auth.${d}(`))),
    ddl.length);
  const sqlBodies = ddl.filter((d) => /\blanguage sql\b/.test(d));
  const plpgsqlBodies = ddl.filter((d) => /\blanguage plpgsql\b/.test(d));
  check("…and the ten `language sql` bodies end at their own `$$;`, so none of them swallowed the "
    + "function after it",
    sqlBodies.length === 10 && plpgsqlBodies.length === 46 && ddl.length === 56
    && sqlBodies.every((d) => d.endsWith("\n$$;") && !d.endsWith("end $$;"))
    && plpgsqlBodies.every((d) => d.endsWith("\nend $$;")),
    { sql: sqlBodies.length, plpgsql: plpgsqlBodies.length,
      loose: ddl.filter((d) => !d.endsWith("\nend $$;") && !d.endsWith("\n$$;")).length });
  check("…the file's own word for each count is the number this gate holds — 56 bodies, 18 guards, "
    + "30 doors, 5 registers",
    Object.entries(SPELL).length > 0
    && /Eighteen guards/.test(src) && /30 doors/.test(src) && /five registers/.test(src),
    src.match(/(Eighteen|eighteen) (guards|doors)/g)?.[0]);
  check("…and this gate never re-runs a table, a trigger, a seed or the closing census",
    !/create table|create trigger|create policy|insert into money_payout_rails/.test(replayed)
    && !/\bdo \$\$ declare/.test(replayed),
    (replayed.match(/create (table|trigger|policy)/g) ?? [""])[0]);

  const runner = new pg.Client({
    connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 300000
  });
  await runner.connect();
  const recorded = (await runner.query(
    `select name from schema_migrations where name like '134%'`)).rows;
  check("134 is already recorded, which is why an edited 134 needs this file rather than "
    + "`pnpm migrate`", recorded.length === 1, recorded);
  let err: any = null;
  await runner.query("begin");
  try {
    for (const block of ddl) await runner.query(block);
    for (const s of idx) await runner.query(s);
    for (const p of priv) await runner.query(p);
  } catch (e) { err = e; }
  if (!err && APPLY) await runner.query("commit"); else await runner.query("rollback");
  check(`the ${ddl.length} bodies, the ${idx.length} index lines and the ${priv.length} privilege `
    + `statements run together${APPLY ? " and are committed" : " and are rolled back"}`,
    !err, err?.message);
  await runner.end();
  if (err) {
    console.log(`\n134's own DDL does not run. Nothing below this line is proved.`);
    process.exit(1);
  }

  const owner = new pg.Client({
    connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 300000
  });
  await owner.connect();
  try {
    await run(url, src, routeSrc, effectSrc, probeSrc, owner);
  } finally {
    await owner.end().catch(() => undefined);
  }
  console.log(`\n${proved} checks proved, ${failures} failed — `
    + `${failures ? "134 is not standing as written" : "the office may hold, park and pay"}`);
  if (failures) process.exitCode = 1;
}

const BASE_QUERIES = [
  ["wallets", "select count(*)::int n from money_wallets"],
  ["holds", "select count(*)::int n from money_escrow_holds"],
  ["batches", "select count(*)::int n from money_payout_batches"],
  ["payouts", "select count(*)::int n from money_payouts"],
  ["postings", "select count(*)::int n from money_postings"],
  ["legs", "select count(*)::int n from money_entries"],
  ["accounts", "select count(*)::int n from money_accounts"],
  ["approvals", "select count(*)::int n from platform_approvals"],
  ["audits", "select count(*)::int n from audit_logs"],
  ["tenants", "select count(*)::int n from tenants"],
  ["seats", "select count(*)::int n from users"]
] as const;

type Book = Record<string, any>;

async function run(url: string, src: string, routeSrc: string, effectSrc: string,
  probeSrc: string, owner: pg.Client) {
  // Everything from here to the end of the file is ONE transaction, rolled back at phase 16. A
  // release, a payment or a reversal writes a real movement into the office's ledger, and the only
  // honest way to prove those walks is to undo them rather than to reverse them with a second
  // movement that names this script in the book.
  const BASE: Record<string, number> = {};
  for (const [k, sql] of BASE_QUERIES) BASE[k] = (await owner.query(sql)).rows[0].n;
  const SEQ: Record<string, number> = {};
  for (const s of SEQUENCES) {
    SEQ[s] = Number((await owner.query(`select last_value from ${s}`)).rows[0].last_value);
  }
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
  /** Some rules are only true as a pair of statements — a plan and the signature asked over it — so
   *  they get one savepoint for the whole pair rather than one for each. */
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
  /** A guard raises, and the raise is the proof. `want` is a piece of the sentence — every one of
   *  them is prefixed `134: ` in the file, and this gate quotes the words the migration actually
   *  wrote. `state` is which half of the desk's error mapper catches it: a trigger guard ends with
   *  `using errcode = '23514'` because the rule is a check the row breaks, while a door's own
   *  `raise exception` defaults to P0001. `guardRefusal` maps both, but only a gate that says which
   *  one fired can tell a guard that was bypassed from a sentence that was edited. */
  const fails = async (label: string, sql: string, p: any[] = [], want = "",
    state = CHECK_VIOLATION) => {
    const { err } = await guarded(sql, p);
    check(label, !!err, err ? "" : "expected a refusal, and the statement succeeded");
    if (err && want) {
      const hit = String(err.message).includes(want) || err.constraint === want;
      check(`…by ${want.slice(0, 52)}`, hit, { code: err.code, message: err.message });
      check(`…raised as ${state}, the SQLSTATE the desk maps to a written refusal`,
        err.code === state, { code: err.code, message: err.message });
    }
    return err;
  };
  const okDo = async (label: string, sql: string, p: any[] = []) => {
    const { err, rows } = await guarded(sql, p);
    if (err) check(`${label} — it raised`, false, err.message);
    return rows as Record<string, any>[];
  };
  /** A door answers. A door that raises where it should have answered is a different fault and is
   *  labelled as one, because the desk's error mapper reads `r.error` and nothing else. */
  const call = async (label: string, sql: string, p: any[] = []) => {
    const { err, rows } = await guarded(sql, p);
    if (err) {
      check(`${label} — the door raised instead of answering`, false, err.message);
      return null as Book | null;
    }
    return (rows?.[0]?.r ?? null) as Book | null;
  };
  /** The refusal a door answers with, asserted as a code. */
  const refuses = async (label: string, sql: string, p: any[], code: string) => {
    const r = await call(label, sql, p);
    check(`…with ${code}`, r?.ok === false && r?.error === code, r);
    return r;
  };
  const row = async (table: string, id: string, cols = "*") =>
    (await one(`select ${cols} from ${table} where id = $1::uuid`, [id])) as Book;
  const acc = async (code: string, book: string) =>
    (await one(`select id, code, kind, currency, status, label from money_accounts
                  where tenant_id = $1::uuid and code = $2`, [book, code])) as Book;

  const PLAT = (await one(
    `select id from tenants where type = 'platform' and deleted_at is null limit 1`)).id as string;
  if (!PLAT) throw new Error("no platform tenant to hold the office's book");

  // ---------------- 1 · what the catalog says 134 left ----------------
  phase("1 · the census, read out of the live catalog rather than repeated from the file");
  const fnRows = (await oi(`select p.proname, p.prosrc as body,
       p.proacl is not null as swept, p.prosecdef as definer, p.provolatile,
       has_function_privilege('app_runtime', p.oid, 'EXECUTE') as by_app,
       has_function_privilege('anon', p.oid, 'EXECUTE')
         or has_function_privilege('authenticated', p.oid, 'EXECUTE')
         or has_function_privilege('service_role', p.oid, 'EXECUTE') as by_client
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'platform_auth' and p.proname = any($1::text[])`, [ALL_FNS])).rows as Book[];
  check("all 56 of 134's bodies are in the catalog, and nothing else of theirs is missing",
    fnRows.length === 56, fnRows.length);
  const fileBody = fileBodies(src);
  const drift = fnRows.filter((r) => fileBody[r.proname]
    && String(r.body).replace(/\s+/g, " ").trim() !== fileBody[r.proname]);
  check("the body the platform is running is the body this file writes, for every one of the 56 — "
    + "an in-place edit of 134 that was never applied would show up here and nowhere else",
    drift.length === 0, drift.map((r) => r.proname));
  check("…and every one of them has an ACL, because `create or replace` hands EXECUTE back to PUBLIC "
    + "and an ACL of NULL is a door that was never swept",
    fnRows.every((r) => r.swept === true), fnRows.filter((r) => !r.swept).map((r) => r.proname));
  check("the 30 doors answer the app role and no other client role",
    DOORS.every((d) => { const r = fnRows.find((x) => x.proname === d);
      return !!r && r.by_app === true && r.by_client === false; }),
    DOORS.filter((d) => { const r = fnRows.find((x) => x.proname === d);
      return !r || r.by_app !== true || r.by_client !== false; }));
  check("the 18 guards and the 8 helpers answer nobody who can call them",
    INTERNAL.every((d) => { const r = fnRows.find((x) => x.proname === d);
      return !!r && r.by_app === false && r.by_client === false; }),
    INTERNAL.filter((d) => { const r = fnRows.find((x) => x.proname === d);
      return !r || r.by_app !== false || r.by_client !== false; }));
  check("…so a desk cannot name a liability line, write an audit row or ask what a payout was signed "
    + "for without going through a door", INTERNAL.length === 26, INTERNAL.length);
  check("every door that writes is SECURITY DEFINER, and the readers that hide a book are too",
    WRITE_DOORS.every((d) => fnRows.find((x) => x.proname === d)?.definer === true)
    && ["money_payable", "money_payees", "money_subjects", "money_wallet_board"].every(
      (d) => fnRows.find((x) => x.proname === d)?.definer === true),
    fnRows.filter((r) => r.definer === false).map((r) => r.proname));
  check("…and the only two functions the platform is allowed to treat as fixed for the life of a "
    + "session are the figure and the leg — a door that reads a book is never marked immutable, and "
    + "a door that writes one never claims to be stable",
    fnRows.filter((r) => r.provolatile === 'i').map((r) => r.proname).sort().join(',')
      === 'money_figure,money_leg'
    && WRITE_DOORS.every((d) => fnRows.find((x) => x.proname === d)?.provolatile === 'v'),
    { immutable: fnRows.filter((r) => r.provolatile === 'i').map((r) => r.proname),
      stableDoors: WRITE_DOORS.filter(
        (d) => fnRows.find((x) => x.proname === d)?.provolatile !== 'v') });

  const trig = (await one(`select count(*)::int as live,
       count(*) filter (where tgdeferrable)::int as deferred,
       count(*) filter (where tgenabled <> 'O')::int as disabled
    from pg_trigger where tgname = any($1::text[]) and not tgisinternal`, [TRIGGERS])) as Book;
  check("18 guard triggers are live and enabled", trig.live === 18 && trig.disabled === 0, trig);
  check("…and none of them is deferrable, which is why this gate needs one rollback instead of "
    + "133's doomed commits: a signature spent on a paper that fails at COMMIT is a signature gone",
    trig.deferred === 0, trig);
  const updTrig = (await one(`select count(*)::int as n from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
    where t.tgname like 'trg_money_%_updated' and not t.tgisinternal
      and c.relname = any($1::text[])`, [REGISTERS])).n;
  check("the four registers that carry `updated_at` each keep it from their own trigger — the rails "
    + "table does not have one and 134's file says so", updTrig === 4, updTrig);

  const reg = (await oi(`select c.relname, c.relrowsecurity as rls,
       (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
       (select count(*)::int from pg_class x cross join aclexplode(x.relacl) a
          where x.oid = c.oid and a.grantee = 0) as public_lines,
       (select count(*)::int from pg_class x cross join aclexplode(x.relacl) a
          where x.oid = c.oid and a.privilege_type = 'SELECT'
            and a.grantee = (select oid from pg_roles where rolname = 'app_runtime')) as app_reads,
       (select count(*)::int from pg_class x cross join aclexplode(x.relacl) a
          where x.oid = c.oid
            and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
            and a.grantee <> 0 and a.grantee <> x.relowner) as app_writes
    from pg_class c where c.relkind = 'r' and c.relname = any($1::text[])`, [REGISTERS])).rows as Book[];
  check("134's five registers exist, all with row-level security on and at least one policy",
    reg.length === 5 && reg.every((r) => r.rls === true && r.policies >= 1), reg);
  check("…the app role may read every one of them, which is the whole of what the boards can show",
    reg.every((r) => r.app_reads === 1), reg.map((r) => [r.relname, r.app_reads]));
  check("…and may write none of them: a desk that could INSERT a payout could name a payee nobody "
    + "signed and leave `accrual_posting_id` NULL, which is a paper that owes the book nothing",
    reg.every((r) => r.app_writes === 0), reg.map((r) => [r.relname, r.app_writes]));
  check("…PUBLIC holds no privilege line on any of the five",
    reg.every((r) => r.public_lines === 0), reg.map((r) => [r.relname, r.public_lines]));
  const burners = (await oi(`select s.sq, has_sequence_privilege('app_runtime', s.sq, 'USAGE') as by_app,
       has_sequence_privilege('authenticated', s.sq, 'USAGE') as by_auth
    from unnest($1::text[]) s(sq)`, [SEQUENCES])).rows as Book[];
  check("the three numbers a paper is minted from cannot be advanced by a client role, so a refund "
    + "cannot be made to skip a payout ref", burners.every((b) => !b.by_app && !b.by_auth), burners);

  const railRows = (await oi(`select code, family, needs, label, retired from money_payout_rails
    order by code`)).rows as Book[];
  check("the rails are the whole vocabulary a payout can be written in: six, none retired",
    railRows.length === 6 && railRows.every((r) => !r.retired)
    && sameFold(railRows.map((r) => r.code), RAILS), railRows.map((r) => [r.code, r.retired]));
  check("…three families, and only the desk's cash pays without a number",
    railRows.filter((r) => r.needs === "none").length === 1
    && railRows.filter((r) => r.needs === "none").every((r) => r.family === "cash")
    && railRows.filter((r) => r.needs === "phone").length === 4
    && railRows.filter((r) => r.needs === "account").length === 1,
    railRows.map((r) => [r.code, r.family, r.needs]));

  const usd = (await oi(`select code, kind, currency, status from money_accounts
    where tenant_id = $1::uuid and code = any($2::text[])`, [PLAT, USD_LINES])).rows as Book[];
  check("a USD wallet, hold and payout each have a USD line to point at, because 133's own leg "
    + "trigger refuses a movement that changes money",
    usd.length === 7 && usd.every((r) => r.currency === "USD" && r.status === "open"),
    usd.map((r) => r.code));
  const tzsHead = await acc("WALLET-TZS", PLAT);
  const tzsLegs = (await one(`select count(*)::int as n from money_entries
    where account_id = $1::uuid`, [tzsHead.id])).n;
  check("133's `WALLET-TZS` is filed as a liability, because money a company put with the office is "
    + "what the office owes", tzsHead.kind === "liability", tzsHead);
  check("…and that correction could not have rewritten history, because the line still carries no "
    + "legs: 134 only edits it while it is empty", tzsLegs === 0, tzsLegs);

  const duties = (await oi(`select p.key,
       coalesce(array_agg(r.key) filter (where r.key is not null), '{}') as roles
    from permissions p
    left join role_permissions rp on rp.permission_key = p.key
    left join roles r on r.id = rp.role_id and r.tenant_id is null
   where p.key = any($1::text[]) group by p.key order by p.key`, [DUTIES])).rows as Book[];
  check("three duties are registered, and they are held by exactly the 8 platform role lines 134 "
    + "hands them out as",
    duties.length === 3 && duties.reduce((n, d) => n + d.roles.length, 0) === 8, duties);
  check("…pay and escrow are different seats, so the desk that pays is not the desk that adjudicates "
    + "a job",
    sameFold(duties.find((d) => d.key === DUTIES[0]).roles,
      ["super_admin", "billing_admin", "finance_officer"])
    && sameFold(duties.find((d) => d.key === DUTIES[1]).roles,
      ["super_admin", "finance_officer", "compliance_officer"]),
    duties.map((d) => [d.key, d.roles]));
  check("…and revealing an account number is a key of its own, held by two seats and by nobody else",
    sameFold(duties.find((d) => d.key === DUTIES[2]).roles, ["super_admin", "finance_officer"]),
    duties.find((d) => d.key === DUTIES[2])?.roles);
  const pen = (await one(`select count(*)::int as n from role_permissions rp
    join roles r on r.id = rp.role_id join permissions p on p.key = rp.permission_key
   where r.tenant_id is null and p.key like 'control.money.%'
     and p.key <> 'control.money.view'
     and r.key in ('platform_analyst','auditor')`)).n;
  check("an analyst and an auditor read the book and hold no pen on it", pen === 0, pen);

  // ---------------- 2 · the words, in the table and in the file ----------------
  phase("2 · every vocabulary read out of the catalog and compared with the words the migration "
    + "was typed in");
  const consBy = async (table: string) => (await oi(`select conname,
       lower(pg_get_constraintdef(oid)) as def
    from pg_constraint where conrelid = $1::regclass and contype = 'c'`, [table])).rows as Book[];
  /** (table, column, the words the file types into that column's own CHECK). The needle is the text
   *  immediately before the list, exactly as 134 was written, so a word added to the table without
   *  being added to the file — or the other way round — is a failed line, not a silent pass. */
  const VOCAB: [string, string, string][] = [
    ["money_payout_rails", "family", "family text not null check (family in ("],
    ["money_payout_rails", "needs", "needs text not null check (needs in ("],
    ["money_wallets", "currency", "currency text not null check (currency in ("],
    ["money_wallets", "status", "status text not null default 'open' check (status in ("],
    ["money_escrow_holds", "currency", "currency text not null check (currency in ("],
    ["money_escrow_holds", "subject_kind", "subject_kind text not null check (subject_kind in ("],
    ["money_escrow_holds", "reason_code", "reason_code text not null check (reason_code in ("],
    ["money_escrow_holds", "status", "status text not null default 'raised' check (status in ("],
    ["money_escrow_holds", "discharge_kind", "discharge_kind text check (discharge_kind in ("],
    ["money_payout_batches", "currency", "currency text not null check (currency in ("],
    ["money_payout_batches", "status", "status text not null default 'open' check (status in ("],
    ["money_payouts", "currency", "currency text not null check (currency in ("],
    ["money_payouts", "payee_kind", "payee_kind text not null check (payee_kind in ("],
    ["money_payouts", "source_kind", "source_kind text not null check (source_kind in ("],
    ["money_payouts", "status", "status text not null default 'raised' check (status in ("]
  ];
  for (const [table, column, needle] of VOCAB) {
    const inFile = wordsInTable(src, table, needle);
    const inTable = wordsForColumn(await consBy(table), column, table);
    check(`${table}.${column} keeps exactly the ${inFile.length || "?"} words the file lists under it`,
      inFile.length > 0 && inTable.length > 0 && sameFold(inFile, inTable), { inFile, inTable });
  }
  const holdCur = wordsForColumn(await consBy("money_escrow_holds"), "currency", "money_escrow_holds");
  const payCur = wordsForColumn(await consBy("money_payouts"), "currency", "money_payouts");
  const walCur = wordsForColumn(await consBy("money_wallets"), "currency", "money_wallets");
  check("the two monies are the same pair on every register, and they are the pair 133's book keeps",
    sameFold(holdCur, payCur) && sameFold(payCur, walCur) && sameFold(walCur, ["TZS", "USD"]),
    { walCur, holdCur, payCur });
  /** A reason code is not a new vocabulary: 134 reuses 131's ban words on purpose, so that the desk
   *  which stops a card and the desk which parks money answer with the same seven words. */
  const banWords = wordsForColumn(await consBy("money_escrow_holds"), "reason_code",
    "money_escrow_holds");
  check("…a hold is refused for the same seven words a card is banned with, and 134 invents no "
    + "eighth reason",
    banWords.length === 7 && banWords.includes("payment_default") && banWords.includes("other"),
    banWords);
  const refs: [string, string][] = [
    ["money_escrow_holds", "^ESC-[0-9]{4}-[0-9]{5,}$"],
    ["money_payout_batches", "^PBT-[0-9]{4}-[0-9]{5,}$"],
    ["money_payouts", "^PAY-[0-9]{4}-[0-9]{5,}$"]
  ];
  for (const [table, want] of refs) {
    const defs = (await consBy(table)).map((d) => flat(d.def));
    check(`${table}.ref is a printed number the office can quote, and no desk can type it`,
      defs.some((d) => d.includes(flat(want))), defs.filter((d) => d.includes("~")));
  }
  const shape = (await oi(`select conrelid::regclass::text as tbl, conname,
       lower(pg_get_constraintdef(oid)) as def
    from pg_constraint where contype = 'c'
      and conrelid in ('money_wallets'::regclass,'money_escrow_holds'::regclass,
                       'money_payouts'::regclass,'money_payout_batches'::regclass)`)).rows as Book[];
  /** The pairing rules a desk could otherwise argue about. 134 names three constraints and leaves the
   *  rest anonymous, so these are matched by the fragment the file types them in — flattened the way
   *  the deparser flattens it — and reported under whatever name the catalog gave them. */
  const pairs: [string, string, string][] = [
    ["money_wallets", "status = 'frozen' = frozen_reason is not null",
      "a frozen wallet carries the sentence and an open wallet carries nothing"],
    ["money_wallets", "tenant_id <> owner_tenant_id",
      "the office never holds a wallet for itself"],
    ["money_escrow_holds", "coalesce(to_payee, 0) + coalesce(back_to_payer, 0) "
      + "+ coalesce(fee_amount, 0) = amount", "the three sides of a plan are the whole held figure"],
    ["money_escrow_holds", "discharge_kind = 'refunded' or payee_wallet_id is not null",
      "a plan that pays somebody names the wallet the money lands in"],
    ["money_escrow_holds", "status <> 'pending_discharge' or approval_id is not null",
      "a paper that says it is waiting for a signature has asked for one"],
    ["money_payouts", "payee_kind = 'other' = payee_id is null",
      "a payee the register has no paper for carries no id"],
    ["money_payouts", "payee_ref_encrypted is null or payee_ref_hash is not null",
      "an encrypted payee line always comes with the hash the desk searches on"],
    ["money_payouts", "fee_amount >= 0", "the office's cut cannot be below zero"],
    ["money_payouts", "fee_amount <= amount", "nor above the money it rides on"],
    ["money_payouts", "source_kind <> 'wallet_withdrawal' or payee_kind = any (array['company'",
      "a withdrawal never pays a driver or a staff member"],
    ["money_payout_batches", "status = 'open' or total_amount > 0 and lines > 0",
      "a batch that has left the board is a batch that held something"],
    ["money_payouts", "status <> 'paid' or paid_by is not null",
      "a paid line names the seat that confirmed the cash left"]
  ];
  for (const [table, fragment, what] of pairs) {
    const want = flat(fragment);
    const hit = shape.find((s) => s.tbl === table && flat(s.def).includes(want));
    check(`the rule that ${what} is a line in ${table}, not only a sentence in a door`, !!hit,
      { fragment, in: hit?.conname });
  }
  /** The payee's company is copied out of the register, not read off the kind: `payee_names_its_payee`
   *  writes a driver's and a staff member's own company into `payee_tenant_id` exactly as it writes a
   *  company's, so a CHECK that paired the company with the `company` kind aborted every payout to a
   *  person. 134 repairs that rule in place, and this is what a repaired book has to look like — a
   *  gate that only ran the file's words would never have seen the row it was refusing. */
  const companyPair = shape.filter((s) => s.tbl === "money_payouts"
    && flat(s.def).includes(flat("payee_kind = 'company'"))
    && flat(s.def).includes(flat("payee_tenant_id is not null")));
  const tenantRule = shape.find((s) => s.conname === "money_payouts_payee_tenant_follows_kind");
  check("nothing in `money_payouts` still refuses a payout because its payee is a person rather than "
    + "a company", companyPair.length === 0, companyPair.map((s) => [s.conname, s.def]));
  check("…and the rule that stands where it was is the named one, holding exactly the pair the guard "
    + "writes: a payee the registers do not know is the only one with no company",
    !!tenantRule
    && flat(tenantRule.def) === flat("check ((payee_kind = 'other') = (payee_tenant_id is null))"),
    tenantRule?.def);
  const uniq = (await oi(`select conname, lower(pg_get_constraintdef(oid)) as def from pg_constraint
    where contype = 'u' and conrelid in ('money_wallets'::regclass,'money_escrow_holds'::regclass,
      'money_payouts'::regclass,'money_payout_batches'::regclass)`)).rows as Book[];
  check("one wallet per holder per money, one live hold per job, and one signature cannot be spent "
    + "twice by two lines",
    ["money_wallet_one_per_holder", "money_payout_one_approval", "money_payout_batch_one_approval"]
      .every((n) => uniq.some((u) => u.conname === n)),
    uniq.map((u) => u.conname));
  const partial = (await oi(`select indexname as relname, lower(indexdef) as d from pg_indexes
    where tablename = any($1::text[])`, [REGISTERS])).rows as Book[];
  check("the two partial indexes that make a job holdable once and a revealed line searchable are "
    + "real indexes on the live catalog",
    partial.some((p) => p.relname === "money_escrow_one_live_per_job"
      && p.d.includes("pending_discharge"))
    && partial.some((p) => p.relname === "money_payouts_payee_idx"),
    partial.map((p) => p.relname));

  // ---------------- 3 · the office's book, and every other book ----------------
  phase("3 · a wallet, a hold and a payout are the office's own money as it owes it, so no other "
    + "book can be asked for one");
  /** A person is not a company. The word is read out of `tenants`' own type CHECK rather than typed
   *  in here, because 060 added it to a CHECK written in 005 and a gate that hardcoded `seeker` would
   *  be asserting its own memory instead of the register's. */
  const typeCheck = (await one(`select lower(pg_get_constraintdef(oid)) as def from pg_constraint
    where contype = 'c' and conrelid = 'tenants'::regclass
      and pg_get_constraintdef(oid) ilike '%transporter%'`)) as Book;
  const TYPES = quoted(String(typeCheck.def ?? ""));
  const otherType = TYPES.find((w) => !["transporter", "shipper", "platform"].includes(w)) || "";
  check("the register lets a tenant be something that is not a company at all, which is the shape "
    + "the holder guard is written against", TYPES.length >= 4 && !!otherType, TYPES);
  const holderA = (await one(`insert into tenants (type, name, status)
    values ('transporter', $1, 'active') returning id`, [BOOK("Holder A")])).id;
  const holderB = (await one(`insert into tenants (type, name, status)
    values ('transporter', $1, 'active') returning id`, [BOOK("Holder B")])).id;
  const shipper = (await one(`insert into tenants (type, name, status)
    values ('shipper', $1, 'active') returning id`, [BOOK("Shipper")])).id;
  const gone = (await one(`insert into tenants (type, name, status, deleted_at)
    values ('transporter', $1, 'active', now()) returning id`, [BOOK("Gone")])).id;
  const seeker = otherType
    ? (await guarded(`insert into tenants (type, name, status) values ($1, $2, 'active')
        returning id`, [otherType, BOOK("Person")])).rows?.[0]?.id as string | undefined
    : undefined;
  /** A holder nobody has opened a wallet for yet. The seat refusals below have to be asked of a
   *  company that does not already hold one, because the door asks its seat question first and its
   *  one-per-holder question second — a duplicate would answer with the holder's name instead of
   *  with the seat, and the gate would be reading the wrong refusal. */
  const holderC = (await one(`insert into tenants (type, name, status)
    values ('transporter', $1, 'active') returning id`, [BOOK("Holder C")])).id;
  /** The register lets a company name run to 120 characters and 133 gives a movement's quote 60, so
   *  a full-length name is the shape that breaks a `source_ref` built out of it. This holder exists
   *  only to be paid with one. */
  const LONG_NAME = `${BOOK("Long-name — the freight and clearing company whose own name runs")
    + " past the sixty characters a movement quote is allowed to carry"}`.slice(0, 120);
  const longName = (await one(`insert into tenants (type, name, status)
    values ('shipper', $1, 'active') returning id`, [LONG_NAME])).id;
  const PEN = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
    values ($1,'platform',$2,'active',$3) returning id`,
    [PLAT, SEAT("Pen"), EMAIL("pen")])).id;
  const QUILL = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
    values ($1,'platform',$2,'active',$3) returning id`,
    [PLAT, SEAT("Quill"), EMAIL("quill")])).id;
  const ASH = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
    values ($1,'platform',$2,'active',$3) returning id`,
    [PLAT, SEAT("Ash"), EMAIL("ash")])).id;
  const INK = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
    values ($1,'platform',$2,'active',$3) returning id`,
    [PLAT, SEAT("Ink"), EMAIL("ink")])).id;
  const COMPANY_USER = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
    values ($1,'director',$2,'active',$3) returning id`,
    [holderA, SEAT("Trader"), EMAIL("trader")])).id;
  /** The two halves of the seat rule the door asks: `status = 'active'` and `deleted_at is null`, and
   *  one seat that is in neither book. Each is a different way for a hand to be told it cannot open a
   *  balance for somebody else. */
  const SUSPENDED_SEAT = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
    values ($1,'platform',$2,'suspended',$3) returning id`,
    [PLAT, SEAT("Rest"), EMAIL("rest")])).id;
  const DELETED_SEAT = (await one(`insert into users (tenant_id, user_type, full_name, status, email,
      deleted_at) values ($1,'platform',$2,'active',$3, now()) returning id`,
    [PLAT, SEAT("Gone-seat"), EMAIL("gone-seat")])).id;
  const STRANGE_SEAT = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
    values ($1,'platform',$2,'active',$3) returning id`,
    [holderC, SEAT("Stranger"), EMAIL("stranger")])).id;
  note("the fixtures — three holders, a shipper, a company whose name fills the register's own "
    + "length limit, a deleted company"
    + `${seeker ? ", a person" : ""}`
    + ", four live seats in the office's book, a suspended and a deleted one, a company seat and a "
    + "seat in another book — are all minted inside the transaction, and every one of them is undone "
    + "at the rollback");

  const OPS_BANK = await acc("OPS-BANK", PLAT);
  const OPS_CASH = await acc("OPS-CASH", PLAT);
  const GATE_WAIT = await acc("GATE-WAIT", PLAT);
  const COST_OPS = await acc("COST-OPS", PLAT);
  const PAYABLE_DUE = await acc("PAYOUT-DUE", PLAT);
  const FEE_INCOME = await acc("FEE-INCOME", PLAT);
  check("the office's own chart is where these doors live: bank, till, gateway, expense, payable and "
    + "income lines all read open",
    [OPS_BANK, OPS_CASH, GATE_WAIT, COST_OPS, PAYABLE_DUE, FEE_INCOME].every((a) => a?.id
      && a.status === "open"), [OPS_BANK, OPS_CASH, GATE_WAIT].map((a) => a?.code));
  const NO_BODY = randomUUID();

  /** The 10 write doors that ask the office question first, and the sentence each of them says when
   *  the answer is no. A company's own book has its own chart and none of these desks; a door that
   *  would open a wallet there would be a door that moves money between two different offices' books. */
  const OFFICE_DOORS: [string, string, any[]][] = [
    ["open_money_wallet", "a wallet is a line in the office's own book",
      [holderA, holderB, "TZS", "Not the office's book.", PEN, "finance_officer", "127.0.0.1", "gate"]],
    ["fund_money_wallet", "only the office's book can hold a wallet balance",
      [holderA, NO_BODY, 100000, "bank", MEMO("wrong book"), DAY, PEN, "finance_officer",
        "127.0.0.1", "gate", null]],
    ["move_money_wallet", "a wallet balance only moves inside the office's book",
      [holderA, NO_BODY, NO_BODY, 100000, MEMO("wrong book"), DAY, PEN, "finance_officer",
        "127.0.0.1", "gate", null]],
    ["freeze_money_wallet", "freezing a wallet is the office stopping its own money",
      [holderA, NO_BODY, STOP, PEN, true, "compliance_officer", "127.0.0.1", "gate"]],
    ["raise_money_escrow", "money waits in escrow only in the office's own book",
      [holderA, "call", NO_BODY, 100000, "TZS", null, "bank", "other", PLAN, DAY,
        PEN, "compliance_officer", "127.0.0.1", "gate", null]],
    ["raise_money_payout", "money leaves the office only from the office's own book",
      [holderA, "other", null, BOOK("Payee"), "cash", null, null, null, 100000, 0, "TZS",
        "manual", null, null, PURPOSE, null, PEN, "finance_officer", "127.0.0.1", "gate"]],
    ["open_money_payout_batch", "a payout batch is the office paying several people at once",
      [holderA, MEMO("batch"), "TZS", PEN, "finance_officer", "127.0.0.1", "gate"]],
    ["mark_money_payout_paid", "only the office confirms money leaving its own book",
      [holderA, NO_BODY, NOTE, DAY, PEN, "finance_officer", "127.0.0.1", "gate"]],
    ["mark_money_payout_failed", "only the office records its own payments failing",
      [holderA, NO_BODY, FAIL, PEN, "finance_officer", "127.0.0.1", "gate"]],
    ["close_money_payout_batch", "only the office closes its own batches",
      [holderA, NO_BODY, NOTE, PEN, "finance_officer", "127.0.0.1", "gate"]]
  ];
  for (const [door, want, args] of OFFICE_DOORS) {
    await fails(`134: ${door} refuses a book that is not the office's`,
      `select platform_auth.${door}(${args.map((_, i) => `$${i + 1}`).join(",")})`, args,
      want, DOOR_RAISE);
  }
  /** The seven board reads answer instead of raising, because a board that raised would be an error
   *  page on a desk that merely opened the wrong book. `money_payable` prints accounts/drift/square
   *  where the other six print count/returned/limit, so only the parts every one of them keeps is
   *  asserted here. */
  const OFFICE_READS: [string, any[]][] = [
    ["money_wallet_board", [holderA, null, null, null, 20, 0]],
    ["money_escrow_board", [holderA, null, null, null, 20, 0]],
    ["money_payout_board", [holderA, null, null, null, null, null, null, 20, 0]],
    ["money_payout_batch_board", [holderA, null, null, null, 20, 0]],
    ["money_payable", [holderA]],
    ["money_payees", [holderA, "company", "Moves", 10]],
    ["money_subjects", [holderA, "call", "CS", 10]]
  ];
  for (const [read, args] of OFFICE_READS) {
    const label = `${read} answers a company's book with an empty board rather than a raised error`;
    const r = await call(label,
      `select platform_auth.${read}(${args.map((_, i) => `$${i + 1}`).join(",")}) as r`, args);
    check(`…${read} says there are no rows and names the book it belongs to`,
      r?.rows?.length === 0 && typeof r?.error === "string" && /office/i.test(r.error)
      && (r.count === undefined || r.count === 0), r);
  }
  const railsOther = await call("money_rails is the one read that answers any book, because the "
    + "rails are the office's vocabulary and a CFA desk has to be able to name one",
    RAILS_SQL, [holderA]);
  check("…and it still prints the six rails without touching a register",
    railsOther?.rows?.length === 6, railsOther?.rows?.length);
  /** Small read helpers used by every phase below: the legs a movement left behind, a wallet's live
   *  balance as the book computes it, and the cached figure the account row carries. A door that
   *  books money has to agree with all three, and `money_payable` is the desk's own way of saying
   *  whether they do. */
  const legRows = async (postingId: string) => (await oi(`select lower(e.direction) as side,
       e.amount, a.code
    from money_entries e join money_accounts a on a.id = e.account_id
    where e.posting_id = $1::uuid order by a.code, lower(e.direction)`, [postingId])).rows as Book[];
  const walletBal = async (id: string) => Number((await one(
    `select platform_auth.money_wallet_balance($1::uuid) as b`, [id])).b);
  const accFig = async (id: string) => (await one(`select (credit_total - debit_total) as cached,
       entry_count as legs, status from money_accounts where id = $1::uuid`, [id])) as Book;
  const square = async () => (await one(
    `select platform_auth.money_book_is_square($1::uuid) as r`, [PLAT])).r as Book;
  const payable = async () => (await call("money_payable reads the office's own liabilities",
    PAYABLE, [PLAT])) as Book;
  /** 121's spend order, walked statement by statement with every answer handed back. `block()` gives a
   *  caller only the last statement's rows, and the interesting answer of a discharge is the movement
   *  its effect door booked — so this walk keeps `decide`, `claim`, the effect and `settle` apart.
   *  `extra` runs between the claim and the effect: seven days is long enough for a desk to stop a
   *  wallet after a signature was released, and proving that 134 re-reads the payee needs a step in
   *  which to stop it. `wantRaise` is for the walks that are *meant* to be refused — a guard's raise
   *  unwinds the whole signature, so the gate hands the sentence back and lets the caller prove the
   *  state the rollback left behind rather than pretending the paper moved. */
  const walk = async (label: string, approval: string, decider: string, effect: string,
    note_: string, extra: [string, any[]][] = [], effectActor = decider, wantRaise = "") => {
    const out: Book = {};
    const name = `s${++sp}`;
    await oi(`savepoint ${name}`);
    try {
      out.decide = (await oi(DECIDE_SQL, [approval, "approve", note_, decider, "finance_officer",
        "127.0.0.1", "gate"])).rows?.[0]?.r;
      out.claim = (await oi(CLAIM_SQL, [approval, decider])).rows?.[0]?.r;
      for (const [sql, p] of extra) out.step = (await oi(sql, p)).rows?.[0]?.r;
      out.effect = (await oi(effect, [approval, effectActor, "finance_officer", "127.0.0.1"]))
        .rows?.[0]?.r;
      out.settle = (await oi(SETTLE_SQL, [approval,
        JSON.stringify({ via: "verify-money-moves-sql" })])).rows?.[0]?.r;
      await oi(`release savepoint ${name}`);
      if (wantRaise) check(`${label} — the walk was meant to meet a guard and did not`, false);
      return out;
    } catch (e: any) {
      await oi(`rollback to savepoint ${name}`);
      if (!wantRaise) {
        check(`${label} — the walk raised`, false, e.message);
        return null;
      }
      check(label, String(e.message).includes(wantRaise) || e.constraint === wantRaise,
        { code: e.code, message: e.message });
      check(`…raised as ${CHECK_VIOLATION}, the SQLSTATE the desk maps to a written refusal`,
        e.code === CHECK_VIOLATION, { code: e.code, message: e.message });
      out.err = e;
      return out;
    }
  };

  // ---------------- 4 · a wallet, and the four lines it is made of ----------------
  phase("4 · a wallet is one company, one money, one liability line — and the register keeps all "
    + "three even when a hand writes the row instead of the door");
  const openWallet = async (label: string, owner: string, cur: string, note_: string,
    actor = PEN, role = "finance_officer", book = PLAT) => {
    const r = await call(label, OPEN_W, [book, owner, cur, note_, actor, role, "127.0.0.1", "gate"]);
    return r?.wallet?.id as string | undefined;
  };
  const WAL_A = await openWallet("the office opens a TZS wallet for the first holder",
    holderA, "TZS", "Balance the holder left with us for demurrage.");
  const WAL_B = await openWallet("…and one for the second", holderB, "TZS",
    "Their deposit for the corridor runs.");
  const WAL_S = await openWallet("…and one for a shipper, because a wallet is not a transport thing",
    shipper, "TZS", "Freight money they advanced.");
  const WAL_AUSD = await openWallet("…and a USD wallet for the first holder", holderA, "USD",
    "The dollar line the same company keeps with us.");
  check("four wallets are open, each under its own holder",
    !!(WAL_A && WAL_B && WAL_S && WAL_AUSD), { WAL_A, WAL_B, WAL_S, WAL_AUSD });
  const walA = await row("money_wallets", WAL_A!);
  check("…and a wallet carries no typed code: the line's own WLT- code is minted from the holder "
    + "and the money, and the wallet only points at it",
    walA.account_id && String(walA.code ?? "") === "", { code: walA.code });
  const walLine = (await one(`select code, kind, currency, status from money_accounts
    where id = $1::uuid`, [walA.account_id])) as Book;
  check("…the line it points at is a liability in that money, in the office's book, and open",
    /^WLT-[0-9a-f]{8}-TZS$/i.test(String(walLine.code)) && walLine.kind === "liability"
    && walLine.currency === "TZS" && walLine.status === "open", walLine);
  const walUsdLine = (await one(`select id, code, kind, currency, status from money_accounts
    where id = $1::uuid`, [(await row("money_wallets", WAL_AUSD!)).account_id])) as Book;
  check("…the USD wallet got the USD line, so one holder's two monies never share a balance",
    /-USD$/.test(String(walUsdLine.code)) && walUsdLine.currency === "USD", walUsdLine);
  /** The door's own refusals, in the order the door asks them. These are the answers a desk gets; the
   *  guard sentences below are what a hand that skips the desk gets. */
  await fails("open_money_wallet refuses to open a wallet for a company the register does not have",
    OPEN_W, [PLAT, NO_BODY, "TZS", "Nobody here.", PEN, "finance_officer", "127.0.0.1", "gate"],
    "is not one", DOOR_RAISE);
  await fails("…for a company the office has closed",
    OPEN_W, [PLAT, gone, "TZS", "A dead holder.", PEN, "finance_officer", "127.0.0.1", "gate"],
    "is not one", DOOR_RAISE);
  await fails("…for a person rather than a company, which is the shape 060 added to `tenants`",
    OPEN_W, [PLAT, seeker ?? holderA, "TZS", "Not a company.", PEN, "finance_officer",
      "127.0.0.1", "gate"], seeker ? "is not one" : "no gate", DOOR_RAISE);
  await fails("…for the office's own row, which is the wallet 134 was written to stop",
    OPEN_W, [PLAT, PLAT, "TZS", "The office paying itself.", PEN, "finance_officer",
      "127.0.0.1", "gate"], "is not one", DOOR_RAISE);
  await fails("…in a money the book does not keep",
    OPEN_W, [PLAT, holderB, "KES", "Nairobi money.", PEN, "finance_officer", "127.0.0.1", "gate"],
    "is neither", DOOR_RAISE);
  const HOLDER_C_NAME = BOOK("Holder C");
  /** Every seat refusal is asked of Holder C, which holds no wallet yet: the door asks the seat
   *  question before the one-per-holder question, so a holder that already had a balance would have
   *  answered the second one and the gate would be reading the wrong refusal. */
  await fails("…under a seat that sits in a company's book and not the office's",
    OPEN_W, [PLAT, holderC, "TZS", "A trader cannot open a wallet.", COMPANY_USER,
      "director", "127.0.0.1", "gate"], "only a live seat in the office", DOOR_RAISE);
  await fails("…under a seat that is in no book the office keeps at all",
    OPEN_W, [PLAT, holderC, "TZS", "A stranger's seat.", STRANGE_SEAT, "finance_officer",
      "127.0.0.1", "gate"], "only a live seat in the office", DOOR_RAISE);
  await fails("…under a seat the office has suspended",
    OPEN_W, [PLAT, holderC, "TZS", "A seat off the board.", SUSPENDED_SEAT, "finance_officer",
      "127.0.0.1", "gate"], "only a live seat in the office", DOOR_RAISE);
  await fails("…under a seat the office has struck out of its book",
    OPEN_W, [PLAT, holderC, "TZS", "A seat that is gone.", DELETED_SEAT, "finance_officer",
      "127.0.0.1", "gate"], "only a live seat in the office", DOOR_RAISE);
  const WLT_LINES_BEFORE = (await one(`select count(*)::int as n from money_accounts
    where tenant_id = $1::uuid and code like 'WLT-%'`, [PLAT])).n;
  const dup = await fails("…twice for the same holder and the same money",
    OPEN_W, [PLAT, holderA, "TZS", "A second TZS line.", PEN, "finance_officer",
      "127.0.0.1", "gate"], "already holds a", DOOR_RAISE);
  check("…the door says which holder already holds one, which is what 133's line-mint answer could "
    + "not: it named the account, not the company",
    String(dup?.message).includes("Moves Gate Holder A")
    && String(dup?.message).includes("already holds a TZS wallet"), dup?.message);
  await fails("…while the same holder keeps its USD line, because the pair is one per money rather "
    + "than one per company",
    OPEN_W, [PLAT, holderA, "USD", "Second try at the dollars.", PEN, "finance_officer",
      "127.0.0.1", "gate"], "already holds a USD wallet", DOOR_RAISE);
  const WLT_LINES_AFTER = (await one(`select count(*)::int as n from money_accounts
    where tenant_id = $1::uuid and code like 'WLT-%'`, [PLAT])).n;
  check("…and it asks before it mints: both duplicates left no second liability line in the office's "
    + "chart, so a holder offered a wallet twice does not end up with an orphan line to explain",
    WLT_LINES_BEFORE === WLT_LINES_AFTER, { before: WLT_LINES_BEFORE, after: WLT_LINES_AFTER });
  note("what this leaves the register's own `money_wallet_one_per_holder` index for is two seats "
    + "clicking in the same instant: a hand cannot reach it, because a correctly minted line for that "
    + "holder and money is already owned by the wallet they hold, so the door, then the line guard, "
    + "each answer first");

  /** The same rules read as trigger refusals, written by a hand that has the owner connection.
   *  A door is one path to a row; the guard is the reason the other paths do not work. */
  const HOLDER_A_NAME = String(walA.holder_name);
  const forgeW = (vals: any[], label: string, want: string) => fails(label,
    `insert into money_wallets (tenant_id, owner_tenant_id, account_id, currency, holder_name,`
    + ` opened_by) values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid)`, vals, want);
  await forgeW([PLAT, NO_BODY, walA.account_id, "TZS", "Somebody", PEN],
    "the holder guard refuses a wallet for a company that does not exist",
    "a company the office does not have");
  await forgeW([PLAT, gone, walA.account_id, "TZS", BOOK("Gone"), PEN],
    "…refuses a wallet for a company the office closed", "was closed");
  await forgeW([PLAT, PLAT, walA.account_id, "TZS", "Waisha", PEN],
    "…refuses the office holding a wallet for itself, which is money with no payer",
    "is a platform account");
  await forgeW([holderA, holderB, walA.account_id, "TZS", HOLDER_A_NAME, PEN],
    "…refuses a wallet written into a company's own book instead of the office's",
    "this book is not the office's");
  await forgeW([PLAT, holderA, walA.account_id, "TZS", "Renamed Holder", PEN],
    "…refuses a wallet whose holder_name is not the company's own name",
    "the register says");
  await forgeW([PLAT, shipper, OPS_BANK.id, "TZS", BOOK("Shipper"), PEN],
    "…and the line guard refuses a wallet that points at the office's bank asset instead of a WLT- "
    + "liability", "its own WLT- liability line");
  await forgeW([PLAT, holderC, walA.account_id, "TZS", HOLDER_C_NAME, PEN],
    "…refuses a wallet for a holder that has no balance yet, written onto the line another holder's "
    + "door minted", "is not the line this holder's TZS money mints");
  await forgeW([PLAT, holderC, walUsdLine.id, "USD", HOLDER_C_NAME, PEN],
    "…refuses the same trick in the other money, because the code a line is minted with carries the "
    + "holder and the money in it", "is not the line this holder's USD money mints");
  const WAL_C = await openWallet("…so the office opens that third holder's wallet through the door, "
    + "under a live seat in its own book", holderC, "TZS", "Their deposit against a corridor run.");
  /** The one rule of the register that only a hand can show: the door answers a duplicate in words,
   *  so the pair of unique indexes behind it is the answer to two seats clicking in the same instant.
   *  Writing the row twice here is the only way to see which half of the register stops it. */
  const twice = await fails("…and the register's own two unique pairs, not a door, are what stop a "
    + "second wallet standing on that line",
    `insert into money_wallets (tenant_id, owner_tenant_id, account_id, currency, holder_name,
      opened_by) values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid)`,
    [PLAT, holderC, String((await row("money_wallets", WAL_C!)).account_id), "TZS",
      HOLDER_C_NAME, PEN], "duplicate key value violates unique constraint", UNIQUE_VIOLATION);
  check("…and it is `money_wallet_one_per_holder` or the one-line-one-wallet pair that answers, "
    + "which is the pair 134 leaves as the backstop to its own door",
    ["money_wallet_one_per_holder", "money_wallet_account_is_its_own"]
      .includes(String(twice?.constraint)), twice?.constraint);
  /** The mint, recomputed rather than quoted back. Five lines now stand in the office's chart and each
   *  is the code its own holder and money hash to — which is what lets the guard say a line belongs to
   *  a holder without keeping a column that says so, and why a company that changes its name keeps the
   *  balance it was opened with. */
  for (const [what, holder, cur, wallet] of [
    ["the first holder's TZS", holderA, "TZS", WAL_A],
    ["the second holder's", holderB, "TZS", WAL_B],
    ["the shipper's", shipper, "TZS", WAL_S],
    ["the first holder's USD", holderA, "USD", WAL_AUSD],
    ["the third holder's", holderC, "TZS", WAL_C]
  ] as [string, string, string, string | undefined][]) {
    const w = await row("money_wallets", wallet!);
    const line = (await one(`select code, currency from money_accounts where id = $1::uuid`,
      [w.account_id])) as Book;
    check(`…${what} balance rides the line its own ${cur} mints for that company, so the pairing the `
      + "guard reads is a hash of the book's two halves rather than a typed figure",
      String(line.code) === MINT(holder, cur) && String(line.currency) === cur
      && String(w.owner_tenant_id) === String(holder) && String(w.currency) === cur,
      { code: line.code, wanted: MINT(holder, cur) });
  }
  check("…and one holder's two monies mint two different lines, because the money is inside the hash "
    + "rather than bolted on after it", String(walLine.code) === MINT(holderA, "TZS")
    && String(walUsdLine.code) === MINT(holderA, "USD")
    && String(walLine.code) !== String(walUsdLine.code),
    { tzs: walLine.code, usd: walUsdLine.code });
  await forgeW([PLAT, holderA, walUsdLine.id, "TZS", HOLDER_A_NAME, PEN],
    "…refuses a TZS wallet riding the holder's USD line", "one money per line");
  await fails("…and an account that is not in the office's book at all",
    `insert into money_wallets (tenant_id, owner_tenant_id, account_id, currency, holder_name,
      opened_by) values ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid)`,
    [PLAT, holderA, (await one(`insert into money_accounts (tenant_id, code, label, kind, currency,
        note) values ($1::uuid,'WLT-FOREIGN0','A foreign line','liability','TZS',
        'Minted only to be refused by the wallet guard.') returning id`,
      [holderA])).id, "TZS", HOLDER_A_NAME, PEN],
    "is not a line in the office's book");
  /** Identity: the pair a balance is a sum of. These are UPDATE forgeries, and the identity guard is
   *  the first of the three to fire because the trigger names sort `keep` before `name` and `own` —
   *  so even a rename, which is the holder guard's own sentence on an INSERT, is answered here first
   *  on a row that already carries a balance. */
  for (const [sql, p, what] of [
    [`update money_wallets set currency = 'USD' where id = $1::uuid`, [WAL_A],
      "re-typed out of TZS"],
    [`update money_wallets set account_id = $2::uuid where id = $1::uuid`, [WAL_A, WAL_B],
      "re-pointed at another holder's line"],
    [`update money_wallets set owner_tenant_id = $2::uuid where id = $1::uuid`, [WAL_A, holderB],
      "handed to a different company"],
    [`update money_wallets set holder_name = 'Renamed Holder' where id = $1::uuid`, [WAL_A],
      "renamed under a balance"],
    [`update money_wallets set opened_by = $2::uuid where id = $1::uuid`, [WAL_A, QUILL],
      "re-aimed at the seat that opened it"]
  ] as [string, any[], string][]) {
    await fails(`the identity guard refuses a wallet ${what}`, sql, p,
      "one holder, one money and one line");
  }
  /** The freeze walk, in the order an office does it: stop the money through the door, try to clear
   *  the state by hand without clearing the stamp (the half CHECK `money_wallet_freeze_is_explained`
   *  cannot see), answer a second stop with the first reason, then open it again and check that both
   *  halves went together. */
  const fr = await call("the office freezes a holder's wallet through the door",
    FREEZE_W, [PLAT, WAL_A, STOP, PEN, true, "compliance_officer", "127.0.0.1", "gate"]);
  check("…and the door stamps the reason, the seat and the hour on the row",
    fr?.ok === true && fr?.wallet?.status === "frozen"
    && fr?.wallet?.frozen_reason === STOP && !!fr?.wallet?.frozen_at && !!fr?.wallet?.frozen_by,
    { ok: fr?.ok, wallet: fr?.wallet?.status });
  const walAfterFreeze = await accFig(String(fr?.wallet?.account?.id));
  check("…the account line is frozen with the row, because 133's leg guard is what actually stops "
    + "a movement and it reads the account, not this register",
    walAfterFreeze.status === "frozen", walAfterFreeze);
  await fails("…the identity guard refuses an UPDATE that clears the state and leaves the stamp",
    `update money_wallets set status = 'open' where id = $1::uuid`, [WAL_A],
    "carries no freeze stamp");
  const again = await call("freezing it again answers that it is already stopped rather than "
    + "stamping a second reason", FREEZE_W, [PLAT, WAL_A, STOP, INK, true,
    "compliance_officer", "127.0.0.1", "gate"]);
  check("…with the first reason still on the row", again?.ok === false
    && again?.error === "already" && again?.reason === STOP, again);
  /** A frozen balance cannot be moved in either direction, and the door says so as an answer — a desk
   *  that reads `error` shows the holder's own sentence rather than a fault page. */
  const intoFrozen = await refuses("fund_money_wallet answers a frozen wallet with its own error",
    FUND_W, [PLAT, WAL_A, 50000, "bank", MEMO("into a stop"), DAY, PEN, "finance_officer",
      "127.0.0.1", "gate", null], "frozen");
  check("…and says whose money is stopped, which is the sentence the office reads back to the holder",
    intoFrozen?.ok === false && intoFrozen?.error === "frozen"
    && String(intoFrozen?.holder) === HOLDER_A_NAME
    && String(intoFrozen?.message).includes(STOP), intoFrozen);
  await refuses("and a movement out of a frozen wallet answers the same way",
    MOVE_W, [PLAT, WAL_A, WAL_B, 50000, MEMO("out of a stop"), DAY, PEN, "finance_officer",
      "127.0.0.1", "gate", null], "frozen");
  const opened = await call("and the office unfreezes it through the door, which clears both",
    FREEZE_W, [PLAT, WAL_A, "", PEN, false, "compliance_officer", "127.0.0.1", "gate"]);
  check("…the wallet is open again with no reason, no seat and no hour left on it",
    opened?.ok === true && opened?.wallet?.status === "open"
    && !opened?.wallet?.frozen_reason && !opened?.wallet?.frozen_at
    && !opened?.wallet?.frozen_by, opened?.wallet);
  const acctAfter = await accFig(String(opened?.wallet?.account?.id));
  check("…and its line is open again too, so the pair cannot be left half-stopped",
    acctAfter.status === "open", acctAfter);
  const openAgain = await refuses("an unfreeze of a wallet that was never stopped answers already_open",
    FREEZE_W, [PLAT, WAL_A, "", PEN, false, "compliance_officer", "127.0.0.1", "gate"],
    "already_open");
  check("…and names the holder it found already open, rather than pretending it stopped something",
    openAgain?.ok === false && String(openAgain?.holder) === HOLDER_A_NAME, openAgain);
  await fails("freeze_money_wallet refuses a stop with less than a sentence of reason",
    FREEZE_W, [PLAT, WAL_A, "no", PEN, true, "compliance_officer", "127.0.0.1", "gate"],
    "needs a sentence", DOOR_RAISE);
  const missing = await call("freeze_money_wallet answers a wallet that is not in this book",
    FREEZE_W, [PLAT, NO_BODY, STOP, PEN, true, "compliance_officer", "127.0.0.1", "gate"]);
  check("…with not_found, which is the answer the desk prints as a line rather than a fault",
    missing?.ok === false && missing?.error === "not_found", missing);

  // ---------------- 5 · money into a wallet, and between two holders ----------------
  phase("5 · the only way a balance changes is a movement: the door books it, the book recomputes it, "
    + "and nothing trusts the figure on the row");
  const fund = async (label: string, wallet: string, amount: number, from: string, memo: string,
    idem: string | null = null, actor = PEN) => call(label, FUND_W,
    [PLAT, wallet, amount, from, memo, DAY, actor, "finance_officer", "127.0.0.1", "gate", idem]);
  const F_A = await fund("the office takes 900 000 into the first holder's wallet from the bank",
    WAL_A!, 900000, "bank", MEMO("bank in"), MEMO("fund A once"));
  const codeOf = async (id: string) => String((await one(
    `select code from money_accounts where id = $1::uuid`, [id])).code);
  const WAL_A_LINE = String(walA.account_id);
  const WAL_B_LINE = String((await row("money_wallets", WAL_B!)).account_id);
  const WAL_S_LINE = String((await row("money_wallets", WAL_S!)).account_id);
  const WAL_U_LINE = String((await row("money_wallets", WAL_AUSD!)).account_id);
  /** Every movement in is the same three-part proof: the figure the door answers with, the two legs
   *  it left behind, and the cached total on the line. The line the money comes out of is named too,
   *  because a TZS balance funded from OPS-BANK and a USD one from OPS-USD is 133's one-money rule
   *  read from the paying end rather than the receiving one. */
  const fundedIn = async (what: string, res: Book | null, line: string, want: number,
    fromCode: string) => {
    const lg = await legRows(String(res?.posting?.id));
    const lineCode = await codeOf(line);
    check(`${what} — ${want} in from ${fromCode} onto ${lineCode}, on two legs the book adds up`,
      res?.ok === true && res?.replayed === false && Number(res?.wallet?.balance) === want
      && lg.length === 2
      && lg.some((l) => l.side === "debit" && l.code === fromCode && Number(l.amount) === want)
      && lg.some((l) => l.side === "credit" && l.code === lineCode && Number(l.amount) === want)
      && Number((await accFig(line)).cached) === want, { ok: res?.ok, legs: lg });
  };
  await fundedIn("the first holder's balance", F_A, WAL_A_LINE, 900000, "OPS-BANK");
  const F_B = await fund("…and 500 000 into the second holder's wallet from the desk's own till",
    WAL_B!, 500000, "cash", MEMO("till in"), null);
  await fundedIn("the second holder's balance", F_B, WAL_B_LINE, 500000, "OPS-CASH");
  const F_S = await fund("…and 250 000 for the shipper out of the gateway line, because rail money "
    + "the office has actually been paid is money it can take in",
    WAL_S!, 250000, "gateway", MEMO("rail in"), null);
  await fundedIn("the shipper's balance", F_S, WAL_S_LINE, 250000, "GATE-WAIT");
  const F_U = await fund("…and 500 dollars into the first holder's USD line",
    WAL_AUSD!, 500, "bank", MEMO("usd in"), null);
  await fundedIn("the same holder's USD balance", F_U, WAL_U_LINE, 500, "OPS-USD");
  /** The four figures a balance is claimed on have to be one figure: the door's answer, the sum the
   *  book computes from the legs, the cached column on the account row, and the detail the desk opens.
   *  A register with no column to write a number into is the point of the design, so this is also the
   *  proof that there is no column to fake. */
  const noFigures = (await oi(`select column_name as c from information_schema.columns
     where table_name = 'money_wallets'
       and column_name in ('balance','amount','credit_total','debit_total','total')`)).rows as Book[];
  check("…and the register itself keeps no figure: a wallet's balance exists only as a sum of "
    + "movements, so there is no column for a hand to write one into",
    noFigures.length === 0, noFigures);
  const fourA = [Number(F_A?.wallet?.balance), await walletBal(WAL_A!),
    Number((await accFig(WAL_A_LINE)).cached)];
  /** A posting's own legs net to zero — that is what makes it a movement rather than a figure — so the
   *  balance is the credit side of it, and the debit side is the line the office took the money out
   *  of. Both halves are read here, because a door that booked one leg only would still answer 900
   *  000 on the wallet. */
  const legsA = await legRows(String(F_A?.posting?.id));
  const creditA = legsA.filter((l) => l.side === "credit").reduce((s, l) => s + Number(l.amount), 0);
  const debitA = legsA.filter((l) => l.side === "debit").reduce((s, l) => s + Number(l.amount), 0);
  check("…the door's answer, the book's own sum and the cached line are the same number, and the two "
    + "legs the movement left are equal and opposite around it",
    fourA.every((f) => f === 900000) && creditA === 900000 && debitA === 900000
    && creditA === debitA, { fourA, creditA, debitA });
  check("…the movement the door booked is a printed PST- number the office can quote, filed as a "
    + "payment against the wallet it funded",
    /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(F_A?.posting?.ref))
    && F_A?.posting?.source_kind === "payment"
    && String(F_A?.posting?.source_id) === WAL_A, { ref: F_A?.posting?.ref,
      kind: F_A?.posting?.source_kind });
  const POSTINGS_BEFORE = (await one(`select count(*)::int as n from money_postings
    where tenant_id = $1::uuid`, [PLAT])).n;
  const F_A_DUP = await fund("sending the same idempotency key twice is the office answering its own "
    + "retry rather than taking the money a second time",
    WAL_A!, 900000, "bank", MEMO("bank in"), MEMO("fund A once"));
  check("…the answer says replayed, names the movement that already stands, and leaves the balance "
    + "where it was",
    F_A_DUP?.ok === true && F_A_DUP?.replayed === true
    && String(F_A_DUP?.posting?.id) === String(F_A?.posting?.id)
    && Number(F_A_DUP?.wallet?.balance) === 900000,
    { replayed: F_A_DUP?.replayed, same: String(F_A_DUP?.posting?.id) === String(F_A?.posting?.id) });
  check("…and no second movement was written",
    (await one(`select count(*)::int as n from money_postings where tenant_id = $1::uuid`,
      [PLAT])).n === POSTINGS_BEFORE, POSTINGS_BEFORE);
  /** The three words a seat can type into `p_from`, and what the office says to a seat that types a
   *  fourth. `money_inflow_account` is one of the eight helpers no client role may call, so the
   *  sentence below is what the door says, not what a desk can ask directly. */
  await fails("fund_money_wallet refuses a line that is none of the three money comes in from",
    FUND_W, [PLAT, WAL_A, 100000, "mpesa", MEMO("wrong line"), DAY, PEN, "finance_officer",
      "127.0.0.1", "gate", null], `"mpesa" is none of those`, DOOR_RAISE);
  await fails("…and a USD balance cannot be funded from the gateway, because the office has one "
    + "gateway line and it is in TZS",
    FUND_W, [PLAT, WAL_AUSD, 100, "gateway", MEMO("usd rail"), DAY, PEN, "finance_officer",
      "127.0.0.1", "gate", null], "no USD gateway", DOOR_RAISE);
  for (const [amt, why] of [[0, "zero"], [-5000, "a negative"],
    [10000000001, "a figure above the ten billion the book carries"]] as [number, string][]) {
    await fails(`fund_money_wallet refuses ${why} going into a balance`, FUND_W,
      [PLAT, WAL_A, amt, "bank", MEMO("figure"), DAY, PEN, "finance_officer", "127.0.0.1",
        "gate", null], "figure above zero", DOOR_RAISE);
  }
  await fails("…a movement in that does not say where the money came from",
    FUND_W, [PLAT, WAL_A, 100000, "bank", "cash in", DAY, PEN, "finance_officer", "127.0.0.1",
      "gate", null], "needs the sentence", DOOR_RAISE);
  await fails("…and one that says too much, because the memo is the whole of what a later reader "
    + "gets", FUND_W,
    [PLAT, WAL_A, 100000, "bank", MEMO("x".repeat(200)), DAY, PEN, "finance_officer", "127.0.0.1",
      "gate", null], "8-200 characters", DOOR_RAISE);
  await refuses("fund_money_wallet answers a wallet that is not in this book", FUND_W,
    [PLAT, NO_BODY, 100000, "bank", MEMO("nobody"), DAY, PEN, "finance_officer", "127.0.0.1",
      "gate", null], "not_found");
  const B_NAME = String((await row("money_wallets", WAL_B!)).holder_name);
  await call("the office stops the second holder's wallet before the pair of movements is walked",
    FREEZE_W, [PLAT, WAL_B, STOP, QUILL, true, "compliance_officer", "127.0.0.1", "gate"]);
  const frz = await call("and money cannot be taken into a stopped balance", FUND_W,
    [PLAT, WAL_B, 100000, "bank", MEMO("into a stop"), DAY, PEN, "finance_officer", "127.0.0.1",
      "gate", null]);
  check("…the answer is `frozen`, and it repeats the sentence the stop was made with and the holder "
    + "it belongs to, because the desk has to tell somebody why",
    frz?.ok === false && frz?.error === "frozen" && String(frz?.message).includes(STOP)
    && frz?.holder === B_NAME, frz);
  await call("and the office lets the balance move again", FREEZE_W,
    [PLAT, WAL_B, "", QUILL, false, "compliance_officer", "127.0.0.1", "gate"]);

  const move = async (label: string, from: string, to: string, amount: number, memo: string,
    idem: string | null = null, actor = PEN) => call(label, MOVE_W,
    [PLAT, from, to, amount, memo, DAY, actor, "finance_officer", "127.0.0.1", "gate", idem]);
  const M_AB = await move("holder A pays 200 000 of its own balance to holder B",
    WAL_A!, WAL_B!, 200000, MEMO("A to B"), MEMO("move once"));
  const mA = await codeOf(WAL_A_LINE);
  const mB = await codeOf(WAL_B_LINE);
  const mLegs = await legRows(String(M_AB?.posting?.id));
  check("…both wallets answer their new figures, and the two legs are the payer's line debited and "
    + "the payee's line credited",
    M_AB?.ok === true && Number(M_AB?.from?.balance) === 700000
    && Number(M_AB?.to?.balance) === 700000 && mLegs.length === 2
    && mLegs.some((l) => l.side === "debit" && l.code === mA && Number(l.amount) === 200000)
    && mLegs.some((l) => l.side === "credit" && l.code === mB && Number(l.amount) === 200000),
    { from: M_AB?.from?.balance, to: M_AB?.to?.balance, legs: mLegs });
  check("…the cached figure on each line followed the legs, so neither balance is a number the "
    + "register was told",
    Number((await accFig(WAL_A_LINE)).cached) === 700000
    && Number((await accFig(WAL_B_LINE)).cached) === 700000
    && (await accFig(WAL_A_LINE)).legs === 2 && (await accFig(WAL_B_LINE)).legs === 2,
    { a: await accFig(WAL_A_LINE), b: await accFig(WAL_B_LINE) });
  /** 133's source vocabulary has no `transfer`, and this is the one place 134 has to explain why: a
   *  balance moved between two of the office's own holders is the office's own pen. The two names in
   *  `source_ref` are what makes that readable a month later — and both of them do not fit inside the
   *  60 characters 133 gives the quote, so the door clamps the pair instead of refusing the payment. */
  const mPost = await row("money_postings", String(M_AB?.posting?.id));
  const mRef = `${HOLDER_A_NAME} -> ${B_NAME}`;
  check("…the movement is filed under `manual` and its quote carries both holders up to the 60 "
    + "characters 133 gives one, so a register read a month later still says whose money went where "
    + "as far as it is allowed to say it",
    mPost.source_kind === "manual" && String(mPost.source_ref) === mRef.slice(0, 60)
    && mRef.length > 60 && String(mPost.source_ref).length === 60
    && String(mPost.source_ref).startsWith(String(HOLDER_A_NAME).slice(0, 20))
    && mPost.currency === "TZS" && Number(mPost.total) === 200000,
    { kind: mPost.source_kind, ref: mPost.source_ref, wanted: mRef.length });
  const M_AB_DUP = await move("and the same key moved again answers the first movement",
    WAL_A!, WAL_B!, 200000, MEMO("A to B"), MEMO("move once"));
  check("…a replayed key is answered with the movement already there, and neither balance moves a "
    + "second time",
    M_AB_DUP?.ok === true && M_AB_DUP?.replayed === true
    && String(M_AB_DUP?.posting?.id) === String(M_AB?.posting?.id)
    && Number(M_AB_DUP?.from?.balance) === 700000,
    { replayed: M_AB_DUP?.replayed, bal: M_AB_DUP?.from?.balance });
  await fails("move_money_wallet refuses a balance moved into the wallet it left",
    MOVE_W, [PLAT, WAL_A, WAL_A, 100000, MEMO("round about"), DAY, PEN, "finance_officer",
      "127.0.0.1", "gate", null], "is not a movement", DOOR_RAISE);
  await fails("…and a movement that would change money, because this book has no exchange line yet",
    MOVE_W, [PLAT, WAL_A, WAL_AUSD, 100000, MEMO("into dollars"), DAY, PEN, "finance_officer",
      "127.0.0.1", "gate", null], "no exchange yet", DOOR_RAISE);
  const short = await call("move_money_wallet answers a balance that does not have the money",
    MOVE_W, [PLAT, WAL_A, WAL_B, 800000, MEMO("more than held"), DAY, PEN, "finance_officer",
      "127.0.0.1", "gate", null]);
  check("…with what the holder has, what was asked and by how much the two differ, which is the "
    + "sentence a clerk reads over the phone",
    short?.ok === false && short?.error === "short" && Number(short?.balance) === 700000
    && Number(short?.amount) === 800000 && Number(short?.short_by) === 100000
    && short?.currency === "TZS" && short?.holder === HOLDER_A_NAME, short);
  await refuses("…a wallet on the paying side that is not in this book", MOVE_W,
    [PLAT, NO_BODY, WAL_B, 100000, MEMO("no payer"), DAY, PEN, "finance_officer", "127.0.0.1",
      "gate", null], "from_not_found");
  await refuses("…and one on the receiving side", MOVE_W,
    [PLAT, WAL_A, NO_BODY, 100000, MEMO("no payee"), DAY, PEN, "finance_officer", "127.0.0.1",
      "gate", null], "to_not_found");
  await fails("…and a movement that gives no reason", MOVE_W,
    [PLAT, WAL_A, WAL_B, 100000, "a move", DAY, PEN, "finance_officer", "127.0.0.1", "gate", null],
    "8-200 characters of reason", DOOR_RAISE);
  await call("the office stops the receiving wallet", FREEZE_W,
    [PLAT, WAL_B, STOP, QUILL, true, "compliance_officer", "127.0.0.1", "gate"]);
  const frzMove = await call("and a balance cannot be moved into a stopped one, in either direction",
    MOVE_W, [PLAT, WAL_A, WAL_B, 100000, MEMO("into a stop"), DAY, PEN, "finance_officer",
      "127.0.0.1", "gate", null]);
  check("…the answer names the wallet that is stopped, not the one the desk filled in first",
    frzMove?.ok === false && frzMove?.error === "frozen" && frzMove?.holder === B_NAME, frzMove);
  const frzBack = await call("…and the same refusal reads the other way round", MOVE_W,
    [PLAT, WAL_B, WAL_A, 100000, MEMO("out of a stop"), DAY, PEN, "finance_officer", "127.0.0.1",
      "gate", null]);
  check("…with the same holder, because a frozen wallet takes no movement in either direction",
    frzBack?.error === "frozen" && frzBack?.holder === B_NAME, frzBack);
  await call("and the office lets it move again", FREEZE_W,
    [PLAT, WAL_B, "", QUILL, false, "compliance_officer", "127.0.0.1", "gate"]);
  /** The dead branch of the inflow helper, asked directly because no door can reach it: every money a
   *  wallet can hold already has its bank line in this chart. Calling a helper is what the owner
   *  connection is for, and phase 14 proves a client role cannot. */
  await fails("money_inflow_account's own words: a money with no line to take it in is refused "
    + "rather than answered with NULL",
    `select platform_auth.money_inflow_account($1::uuid, $2, $3) as r`, [PLAT, "bank", "EUR"],
    "no open OPS-BANK line", DOOR_RAISE);
  const sq5 = await square();
  check("after four movements in and one between holders, the office's book still answers that it "
    + "balances with itself — every leg 134 wrote is one 133 can check",
    sq5?.square === true && sq5?.unbalanced === 0 && sq5?.short_legged === 0
    && sq5?.figure_disagrees === 0, sq5);
  const pay5 = await payable();
  check("…and every liability the office now owes is on the board it reads its own money off: the "
    + "two escrow headings, the four payable lines and the five holder lines the doors minted, with "
    + "nothing the book and the cached column disagree about",
    pay5?.square === true && Number(pay5?.disagrees) === 0 && Number(pay5?.drift) === 0
    && Number(pay5?.accounts) === 11 && String(pay5?.bound) === String(PLAT),
    { accounts: pay5?.accounts, drift: pay5?.drift, disagrees: pay5?.disagrees });
  const held5 = (pay5?.held ?? []) as Book[];
  /** The third holder's wallet stands unfunded on purpose — it was opened to prove the register's own
   *  unique pair, and 134 never took money into it. So `wallets` counts four TZS balances while `held`
   *  is still the 1 650 000 the three funded ones carry, and that difference is the point: an empty
   *  balance is a liability the office owes of nothing, not a line that disappears from the board. */
  check("…the money the office is holding is totalled by money and not mixed: 1 650 000 TZS over the "
    + "four TZS balances the doors opened and 500 dollars over one, with an unfunded wallet counted "
    + "and not silently dropped",
    held5.length === 2
    && held5.some((h) => h.currency === "TZS" && Number(h.held) === 1650000 && h.wallets === 4)
    && held5.some((h) => h.currency === "USD" && Number(h.held) === 500 && h.wallets === 1), held5);
  const wRows = (pay5?.rows ?? []).filter((r: Book) => String(r.account).startsWith("WLT-"));
  check("…a holder's balance carries no paper beside it, and `papers` is null precisely because "
    + "nothing but the movements says what the office owes",
    wRows.length === 5 && wRows.every((r: Book) => r.papers === null && Number(r.drift) === 0),
    wRows.map((r: Book) => [r.account, r.papers]));
  check("…and the fifth of them is the empty one, printed as a zero liability rather than left off",
    wRows.some((r: Book) => Number(r.cached) === 0 && Number(r.drift) === 0)
    && wRows.some((r: Book) => String(r.account) === MINT(holderC, "TZS")),
    wRows.map((r: Book) => [r.account, r.cached]));
  /** The fifth defect this gate found in 134, and the reason it was fixed in the migration rather than
   *  written off here: `tenants.name` runs to 120 characters, 133 gives an account label 80 and a
   *  movement's quote 60. A holder whose name filled the register's own limit could not be given a
   *  balance at all — the door died on 133's label CHECK and the desk read a fault page about an
   *  account code nobody typed. Both figures are clamped rather than refused, because a company whose
   *  name runs long is still owed its money and a desk cannot be told to rename its customer before it
   *  can hold it. Appended after the board checks above so the 11 lines and 1 650 000 they read stay
   *  the numbers the gate compares against. */
  const WAL_LONG = await openWallet("a company whose name fills the register's own 120 characters is "
    + "still owed a balance, so the office opens its wallet", longName, "TZS",
    "Their freight money, held under a name longer than a quote can carry.");
  const longWallet = await row("money_wallets", WAL_LONG!);
  const longLine = (await one(`select code, label, kind, currency from money_accounts
    where id = $1::uuid`, [longWallet.account_id])) as Book;
  check("…the line it mints is still the code that holder and money hash to, and only the label is "
    + "clamped to the 80 characters 133 gives one — the name that did not fit is shortened, not "
    + "rejected, and the wallet still carries all 120 characters of it",
    LONG_NAME.length === 120 && String(longWallet.holder_name) === LONG_NAME
    && String(longLine.code) === MINT(longName, "TZS") && longLine.kind === "liability"
    && longLine.currency === "TZS" && String(longLine.label) === LONG_NAME.slice(0, 80)
    && String(longLine.label).length === 80,
    { name: LONG_NAME.length, code: longLine.code, wanted: MINT(longName, "TZS"),
      label: longLine.label, labelLen: String(longLine.label).length });
  const F_L = await fund("…and 40 000 of that holder's money is taken in from the bank, because the "
    + "clamp has to be proven on a movement and not only on a label",
    WAL_LONG!, 40000, "bank", MEMO("long name in"), null);
  await fundedIn("a holder whose name runs longer than a quote", F_L,
    String(longWallet.account_id), 40000, "OPS-BANK");
  const lPost = await row("money_postings", String(F_L?.posting?.id));
  check("…and the quote that movement files under is the holder's name and its money cut at the 60 "
    + "characters 133 gives it, so the money letter falls outside the clamp for a name this long",
    String(lPost.source_ref) === `${LONG_NAME} TZS`.slice(0, 60)
    && String(lPost.source_ref).length === 60
    && String(lPost.source_ref) === LONG_NAME.slice(0, 60)
    && Number(lPost.total) === 40000 && lPost.currency === "TZS",
    { ref: lPost.source_ref, len: String(lPost.source_ref).length });
  note("that a 120-character holder name pushes the money letter off the end of `source_ref` is a "
    + "limit of the 60 characters 133 gives a quote, not of this door — and the clamp is the honest "
    + "answer, because the money is not lost: the line each leg touches is single-currency, so the "
    + "figure and the money are both still readable from the legs. A quote that had to hold the whole "
    + "name would have made the payment impossible instead.");

  // ---------------- 6 · money that waits against a job ----------------
  phase("6 · a hold takes its number, its words and its company out of the job it waits on, and the "
    + "money only moves once the paper can say what it is waiting for");
  /** The four registers 134 lets a desk park money against, each reached through its own chain: a
   *  booking through the file, the job and the request 044/048 put in front of it, a call straight out
   *  of the service register 125 wrote, a dispute through the call it answers. None of the three words
   *  the paper prints — its number, its sentence, whose it is — is typed by the seat raising it. */
  const num = (at: number) => String((parseInt(HEX.slice(at, at + 6), 16) % 900000) + 100000);
  const T_REF = `CS-2026-${num(0)}`;
  const T_REF2 = `CS-2025-${num(3)}`;
  const T_REF3 = `CS-2024-${num(6)}`;
  const D_REF = `DP-2026-${num(9)}`;
  /** One counter for the whole run, because 052 gave a cargo file its number out of the year and a
   *  sequence per (company, type, year) — and a fixture that wrote `seq 1` twice would answer the
   *  register's own unique pair before the door it is meant to prove ever ran. */
  let fileSeq = 0;
  const file = async (label: string, consignee: string, desc: string | null) => (await one(
    `insert into cargo_shipments (tenant_id, file_number, seq, file_year, shipment_type,
        container_type, consignee_name, consignor_name, cargo_description)
      values ($1, $2, $3, 2026, 'import', '40ft', $4, $5, $6) returning id`,
    [holderA, BOOK(`CF ${label}`), ++fileSeq, consignee, BOOK("Consignor"), desc])).id as string;
  const mkBooking = async (label: string, route: string | null, cargoLabel: string,
    company: string) => {
    const shipment = await file(`${label} chain`, BOOK("Line consignee"), null);
    const job = (await one(`insert into jobs (tenant_id, shipment_id) values ($1, $2) returning id`,
      [holderA, shipment])).id as string;
    const request = (await one(`insert into transport_requests (tenant_id, job_id, shipment_id,
        cargo_label, pickup_text, dest_text, required_date, contact_name, contact_channel,
        company_name) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [holderA, job, shipment, BOOK("Cargo on the request"), "Dar es Salaam port",
        BOOK("Mbeya"), DAY, BOOK("Contact"), "+255700000111", BOOK("Requesting company")]))
      .id as string;
    const booking = (await one(`insert into transport_bookings (request_id, tenant_id, contact_name,
        contact_channel, cargo_label, pickup_text, dest_text, required_date, company_name,
        route_label, status) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed')
        returning id`,
      [request, holderA, BOOK("Contact"), "+255700000111", cargoLabel, "Dar es Salaam port",
        BOOK("Mbeya"), DAY, company, route])).id as string;
    return { shipment, job, request, booking };
  };
  const mkTicket = async (ref: string, subject: string, company: string, ctid: string | null) =>
    (await one(`insert into support_tickets (tenant_id, ref, reporter_name, company_name, category,
        subject, body, created_by, company_tenant_id)
      values ($1, $2, $3, $4, 'complaint', $5, $6, $7, $8) returning id`,
      [PLAT, ref, BOOK("Reporter"), company, subject,
        "The caller says the storage charge was wrong and wants the money held until it is checked.",
        PEN, ctid])).id as string;
  const CF_MAIN = await file("main", BOOK("Consignee two"),
    "Demurrage on a container that stayed past its free days.");
  const CF_USD = await file("usd", BOOK("Consignee dollar"), "Clearing charges agreed in dollars.");
  const CF_BLANK = await file("blank", "   ", null);
  const CF_GONE = await file("gone", BOOK("Consignee closed"), "A file the office deleted.");
  const BK_MAIN = await mkBooking("main", BOOK("Dar — Dodoma corridor"),
    BOOK("Two 40ft of bagged cement"), BOOK("Holder A"));
  const BK_PART = await mkBooking("part", null, BOOK("One reefer of fish"), BOOK("Shipper"));
  const BK_BLANK = await mkBooking("blank", null, "   ", "   ");
  const BK_GONE = await mkBooking("gone", BOOK("Dar — Kigali corridor"),
    BOOK("Bales of cotton"), BOOK("Holder B"));
  const CALL_MAIN = await mkTicket(T_REF, BOOK("Charge disputed"), BOOK("Holder A"), holderA);
  const CALL_NOC = await mkTicket(T_REF2, BOOK("No company on it"), BOOK("Nobody"), null);
  const CALL_GONE = await mkTicket(T_REF3, BOOK("A closed call"), BOOK("Holder A"), holderA);
  const DP_MAIN = (await one(`insert into service_disputes (tenant_id, ref, ticket_id, ticket_ref,
      company_name, ground, claim, opened_by, company_tenant_id)
    values ($1, $2, $3, $4, $5, 'overcharge', $6, $7, $8) returning id`,
    [PLAT, D_REF, CALL_MAIN, T_REF, BOOK("Holder A"),
      "The office overcharged a month of storage and the money is still held against the file.",
      PEN, holderA])).id as string;
  const DP_GONE = (await one(`insert into service_disputes (tenant_id, ref, ticket_id, ticket_ref,
      company_name, ground, claim, opened_by)
    values ($1, $2, $3, $4, $5, 'lost_paperwork', $6, $7) returning id`,
    [PLAT, `DP-2025-${num(2)}`, CALL_NOC, T_REF2, BOOK("Holder B"),
      "An original bill was never returned and the clearing money is held over it.", PEN]))
    .id as string;
  /** Four jobs the office took off its own board. Each is closed the way the register closes it —
   *  `deleted_at`, not a DELETE — so the guard's other half (a paper cannot wait on a job nobody can
   *  open any more) is asked of a row that still exists. One statement per register, because a gate
   *  that built its own table names out of a variable would be a gate that could name any table. */
  await okDo("the gate closes the booking the way the register does",
    `update transport_bookings set deleted_at = now() where id = $1::uuid`, [BK_GONE.booking]);
  await okDo("…and the cargo file",
    `update cargo_shipments set deleted_at = now() where id = $1::uuid`, [CF_GONE]);
  await okDo("…and the call",
    `update support_tickets set deleted_at = now() where id = $1::uuid`, [CALL_GONE]);
  await okDo("…and the dispute",
    `update service_disputes set deleted_at = now() where id = $1::uuid`, [DP_GONE]);
  const hold = async (label: string, kind: string, subject: string, amount: number, cur: string,
    wallet: string | null, from: string | null, code: string, reason = PLAN,
    idem: string | null = null, actor = PEN) => call(label, RAISE_E,
    [PLAT, kind, subject, amount, cur, wallet, from, code, reason, DAY, actor,
      "compliance_officer", "127.0.0.1", "gate", idem]);
  const ESC_T = await acc("ESCROW-TZS", PLAT);
  const ESC_U = await acc("ESCROW-USD", PLAT);
  const tail8 = (id: string) => `BK-${id.slice(0, 8).toUpperCase()}`;
  const H_BK = await hold("the office parks 150 000 of holder A's balance against a booking",
    "booking", BK_MAIN.booking, 150000, "TZS", WAL_A, null, "terms_violation", PLAN,
    MEMO("hold the booking"));
  const bkNote = `${BOOK("Dar — Dodoma corridor")} · ${BOOK("Two 40ft of bagged cement")}`
    + ` · ${BOOK("Holder A")}`;
  check("…the paper is printed with an ESC- number in the year it was raised and already reads "
    + "`held`, because the row and the movement are one call and a half-raised hold is left nowhere",
    H_BK?.ok === true && /^ESC-[0-9]{4}-[0-9]{5,}$/.test(String(H_BK?.hold?.ref))
    && H_BK?.hold?.status === "held" && String(H_BK?.hold?.ref).startsWith("ESC-2026-")
    && !!H_BK?.hold?.held_at && String(H_BK?.hold?.approval_id ?? "") === ""
    && H_BK?.hold?.plan_agrees === true && Number(H_BK?.hold?.plan_total) === 0,
    { ref: H_BK?.hold?.ref, status: H_BK?.hold?.status, plan: H_BK?.hold?.plan_total });
  check("…and the job it waits on is written on it out of the booking register: `BK-` and the id tail "
    + "048 left it, all three of its labels joined with the separator 134 chose, and whose account "
    + "the booking was made on — none of which the desk typed",
    H_BK?.hold?.subject_kind === "booking"
    && String(H_BK?.hold?.subject_id) === BK_MAIN.booking
    && String(H_BK?.hold?.subject_ref) === tail8(BK_MAIN.booking)
    && String(H_BK?.hold?.subject_note) === bkNote
    && String(H_BK?.hold?.subject_tenant_id) === holderA,
    { ref: H_BK?.hold?.subject_ref, want: tail8(BK_MAIN.booking), note: H_BK?.hold?.subject_note });
  check("…the money left the line the holder's balance sits on and stands on the book's own escrow "
    + "line for that money, which the door derived from the currency rather than from a typed account",
    String(H_BK?.hold?.from?.code) === await codeOf(WAL_A_LINE)
    && H_BK?.hold?.into?.code === "ESCROW-TZS" && H_BK?.hold?.into?.kind === "liability"
    && H_BK?.hold?.currency === "TZS", { from: H_BK?.hold?.from?.code, into: H_BK?.hold?.into?.code });
  const bkLegs = (H_BK?.hold?.hold_posting?.legs ?? []) as Book[];
  const aLineCode = await codeOf(WAL_A_LINE);
  check("…the movement under it is the pair 133 checks: the holder's line debited with what was "
    + "parked and the escrow line credited with the same figure, each leg saying which job it is for",
    bkLegs.length === 2 && Number(H_BK?.hold?.hold_posting?.total) === 150000
    && bkLegs.some((l) => l.direction === "debit"
      && String(l.code) === aLineCode && Number(l.amount) === 150000
      && String(l.detail) === `Parked against ${tail8(BK_MAIN.booking)}`)
    && bkLegs.some((l) => l.direction === "credit" && l.code === "ESCROW-TZS"
      && Number(l.amount) === 150000
      && String(l.detail) === `Escrow ${H_BK?.hold?.ref} — terms_violation`),
    { legs: bkLegs, total: H_BK?.hold?.hold_posting?.total });
  check("…and the holder's balance moved by exactly the parked figure, on both the book's sum and the "
    + "cached total the line carries, so the office now owes 550 000 and holds 150 000 for somebody",
    Number(await walletBal(WAL_A!)) === 550000
    && Number((await accFig(WAL_A_LINE)).cached) === 550000
    && Number((await accFig(String(ESC_T.id))).cached) === 150000
    && Number((await accFig(String(ESC_T.id))).legs) === 1,
    { balance: await walletBal(WAL_A!), escrow: await accFig(String(ESC_T.id)) });
  const H_CF = await hold("…and 60 000 of the shipper's balance against a cargo file",
    "cargo_file", CF_MAIN, 60000, "TZS", WAL_S, null, "long_idle");
  check("…a cargo file brings its own number, so the hold prints the file number the office quotes "
    + "and the consignee with the description beside it",
    H_CF?.ok === true && String(H_CF?.hold?.subject_ref) === String((await row("cargo_shipments",
      CF_MAIN)).file_number)
    && String(H_CF?.hold?.subject_note) === `${BOOK("Consignee two")} · `
      + "Demurrage on a container that stayed past its free days."
    && String(H_CF?.hold?.subject_tenant_id) === holderA
    && Number(H_CF?.hold?.amount) === 60000,
    { ref: H_CF?.hold?.subject_ref, note: H_CF?.hold?.subject_note });
  const H_CALL = await hold("…and 25 000 more of holder A's money against the call that is being "
    + "argued about", "call", CALL_MAIN, 25000, "TZS", WAL_A, null, "complaint");
  check("…a call is held against the ticket's own ref, and the company the paper points at is the one "
    + "the ticket names rather than the office's",
    H_CALL?.ok === true && String(H_CALL?.hold?.subject_ref) === T_REF
    && String(H_CALL?.hold?.subject_note) === `${BOOK("Charge disputed")} · ${BOOK("Holder A")}`
    && String(H_CALL?.hold?.subject_tenant_id) === holderA,
    { ref: H_CALL?.hold?.subject_ref, note: H_CALL?.hold?.subject_note });
  const H_DP = await hold("…and 40 000 of holder B's balance against a dispute, which is the paper "
    + "131's service register writes when a call is upheld", "dispute", DP_MAIN, 40000, "TZS",
    WAL_B, null, "abuse");
  check("…a dispute prints its ground and its claim as the job's words, under the ref a caller is "
    + "given",
    H_DP?.ok === true && String(H_DP?.hold?.subject_ref) === D_REF
    && String(H_DP?.hold?.subject_note) === "overcharge · The office overcharged a month of storage "
      + "and the money is still held against the file."
    && String(H_DP?.hold?.subject_tenant_id) === holderA, { ref: H_DP?.hold?.subject_ref,
      note: H_DP?.hold?.subject_note });
  /** A call the service desk logged against no company has no `company_tenant_id` to copy, and the
   *  hold still stands: the money is the office's to park and the job is real, so the paper is raised
   *  with a null company rather than refused for want of one the register never had. */
  const H_NOC = await hold("…and a hold against a call that names no company is raised with the "
    + "company left off rather than refused", "call", CALL_NOC, 20000, "TZS", WAL_B, null, "other");
  check("…the ref is still the ticket's and the note still its subject and the name typed on it, with "
    + "nothing pointing at a book",
    H_NOC?.ok === true && String(H_NOC?.hold?.subject_ref) === T_REF2
    && String(H_NOC?.hold?.subject_note) === `${BOOK("No company on it")} · ${BOOK("Nobody")}`
    && String(H_NOC?.hold?.subject_tenant_id ?? "") === "", { tenant: H_NOC?.hold?.subject_tenant_id,
      note: H_NOC?.hold?.subject_note });
  const H_USD = await hold("…and 100 dollars of holder A's dollar balance against a second file, "
    + "because money that waits is still held one money to a line", "cargo_file", CF_USD, 100, "USD",
    WAL_AUSD, null, "payment_default");
  check("…the USD hold went into ESCROW-USD and out of the USD line, so the two monies the office is "
    + "holding never meet in one balance",
    H_USD?.ok === true && H_USD?.hold?.currency === "USD" && H_USD?.hold?.into?.code === "ESCROW-USD"
    && String(H_USD?.hold?.from?.code) === await codeOf(WAL_U_LINE)
    && Number((await accFig(String(ESC_U.id))).cached) === 100
    && Number(await walletBal(WAL_AUSD!)) === 400,
    { into: H_USD?.hold?.into?.code, usd: await accFig(String(ESC_U.id)) });
  /** The office fronting a hold: no payer wallet, so the door takes the money out of its own till and
   *  `refunded` later sends it back to that same line. `p_from` is the only figure of its kind a desk
   *  is allowed to name here. */
  const H_CASH = await hold("…and a hold the office fronts from its own till, with no payer wallet "
    + "named at all", "booking", BK_PART.booking, 30000, "TZS", null, "cash", "security");
  check("…the till was derived from the word the seat typed, the paper carries no payer, and the "
    + "booking's own note left the empty route out instead of printing a bare separator",
    H_CASH?.ok === true && H_CASH?.hold?.from?.code === "OPS-CASH"
    && String(H_CASH?.hold?.payer_wallet_id ?? "") === ""
    && String(H_CASH?.hold?.subject_note)
      === `${BOOK("One reefer of fish")} · ${BOOK("Shipper")}`
    && Number(await walletBal(WAL_S!)) === 190000,
    { from: H_CASH?.hold?.from?.code, note: H_CASH?.hold?.subject_note });
  const cashLegs = await legRows(String(H_CASH?.posting?.id));
  check("…and the leg that pays for it is the till's, so a hold the office fronts is money it has "
    + "moved and not money it invented",
    cashLegs.length === 2 && cashLegs.some((l) => l.side === "debit" && l.code === "OPS-CASH"
      && Number(l.amount) === 30000)
    && cashLegs.some((l) => l.side === "credit" && l.code === "ESCROW-TZS"), cashLegs);

  /** The five figures a desk types at this door are answered in the order the door asks them — the
   *  job, the figure, the money, the reason, then where the money comes from — and each answer carries
   *  back what was typed, because a seat told "the figure is wrong" with no number beside it has to
   *  guess which of its own keys to look at. Nothing from here to the board below moved money. */
  const noJob = await call("raise_money_escrow refuses a hold that names no job at all",
    RAISE_E, [PLAT, "booking", null, 5000, "TZS", WAL_A, null, "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null]);
  check("…with bad_subject, and the four words a job can be are in the sentence the desk is given",
    noJob?.ok === false && noJob?.error === "bad_subject"
    && /booking, a cargo file, a call or a dispute/.test(String(noJob?.message))
    && noJob?.subject_kind === "booking", noJob);
  /** The seventh defect this gate found in 134, fixed in the migration rather than asserted around
   *  here. The guard reads anything that is not a booking, a file or a call as a dispute, so before
   *  this was written a desk that typed an eighth kind word was told there was no *dispute* with that
   *  id — a sentence about a paper nobody mentioned, and a desk that goes looking for a dispute it
   *  never named is a desk that will not find its own mistake. The door answers the word now, the way
   *  it answers every other vocabulary it takes. */
  const wrongWord = await call("…and a hold raised against a kind the register has no word for",
    RAISE_E, [PLAT, "shipment", CF_MAIN, 5000, "TZS", WAL_A, null, "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null]);
  check("…is answered for the word the desk typed, not sent to the guard that reads an unknown kind "
    + "as a dispute", wrongWord?.ok === false && wrongWord?.error === "bad_subject"
    && wrongWord?.subject_kind === "shipment", wrongWord);
  for (const [amt, why] of [[0, "zero"], [-25000, "a negative figure"],
    [10000000001, "a figure above the ten billion the book carries"]] as [number, string][]) {
    const r = await refuses(`…and a hold raised for ${why}`, RAISE_E,
      [PLAT, "booking", BK_MAIN.booking, amt, "TZS", WAL_A, null, "other", PLAN, DAY, PEN,
        "compliance_officer", "127.0.0.1", "gate", null], "bad_amount");
    check(`…echoing the figure the desk typed (${amt}) back to it`, String(r?.amount) === String(amt),
      r);
  }
  await refuses("…and a hold in a money the office does not hold in escrow", RAISE_E,
    [PLAT, "booking", BK_MAIN.booking, 5000, "EUR", WAL_A, null, "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null], "bad_currency");
  const badCode = await refuses("…and a hold raised for a reason outside the seven words 131 already "
    + "bans a card with", RAISE_E,
    [PLAT, "booking", BK_MAIN.booking, 5000, "TZS", WAL_A, null, "overtime", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null], "bad_reason_code");
  check("…naming the word it did not recognise rather than listing the seven it would take",
    badCode?.reason_code === "overtime", badCode);
  await refuses("…and a hold whose reason is too short to be the sentence a second seat signs",
    RAISE_E, [PLAT, "booking", BK_MAIN.booking, 5000, "TZS", WAL_A, null, "other", "hold it",
      DAY, PEN, "compliance_officer", "127.0.0.1", "gate", null], "bad_reason");
  await refuses("…and one whose reason runs past the 600 characters the register gives it",
    RAISE_E, [PLAT, "booking", BK_MAIN.booking, 5000, "TZS", WAL_A, null, "other", "x".repeat(601),
      DAY, PEN, "compliance_officer", "127.0.0.1", "gate", null], "bad_reason");
  await refuses("a hold whose payer wallet is not in this book answers payer_not_found", RAISE_E,
    [PLAT, "booking", BK_MAIN.booking, 5000, "TZS", NO_BODY, null, "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null], "payer_not_found");
  const mm = await refuses("a TZS hold cannot be parked out of the dollar balance", RAISE_E,
    [PLAT, "booking", BK_MAIN.booking, 5000, "TZS", WAL_AUSD, null, "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null], "currency_mismatch");
  check("…and the sentence names whose balance it tried to use and both monies, so the desk can see "
    + "which of its own keys to change", mm?.holder === HOLDER_A_NAME
    && mm?.wallet_currency === "USD" && mm?.currency === "TZS", mm);
  /** The two questions 134 asks of a payer wallet that 133 never had to ask of an account: is this
   *  holder's own balance stopped, and is there enough of it. Both are answered before the paper is
   *  written — a hold raised over a stopped balance is money the office has taken and cannot give
   *  back, and a hold for more than the holder has is a paper promising money that is not there. */
  await call("the office stops the second holder's balance to try a hold over it", FREEZE_W,
    [PLAT, WAL_B, STOP, PEN, true, "compliance_officer", "127.0.0.1", "gate"]);
  const holdFrozen = await refuses("raise_money_escrow refuses to park money out of a stopped wallet",
    RAISE_E, [PLAT, "dispute", DP_MAIN, 5000, "TZS", WAL_B, null, "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null], "frozen");
  check("…naming whose balance is stopped and the sentence the stop was written with",
    holdFrozen?.holder === B_NAME && String(holdFrozen?.reason) === STOP, holdFrozen);
  check("…and the refusal wrote no paper: the dispute still carries only the hold raised over the "
    + "live balance", (await one(`select count(*)::int as n from money_escrow_holds
      where subject_kind = 'dispute' and subject_id = $1::uuid`, [DP_MAIN])).n === 1,
    (await one(`select count(*)::int as n from money_escrow_holds where subject_kind = 'dispute'
      and subject_id = $1::uuid`, [DP_MAIN])).n);
  await call("and the office opens the balance again", FREEZE_W,
    [PLAT, WAL_B, "", QUILL, false, "compliance_officer", "127.0.0.1", "gate"]);
  const WAL_C_LINE = String((await row("money_wallets", WAL_C!)).account_id);
  const shortHold = await refuses("a hold for more than the holder has answers short", RAISE_E,
    [PLAT, "cargo_file", CF_MAIN, 50000, "TZS", WAL_C, null, "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null], "short");
  check("…with the three figures a clerk needs in order to correct it: what the holder has, what was "
    + "asked for, and by how much the two differ", Number(shortHold?.balance) === 0
    && Number(shortHold?.amount) === 50000 && Number(shortHold?.short_by) === 50000
    && shortHold?.currency === "TZS" && String(shortHold?.holder) === HOLDER_C_NAME, shortHold);
  check("…and the empty balance is a line the office can read rather than a book with nothing in it",
    Number(await walletBal(WAL_C!)) === 0
    && String((await accFig(WAL_C_LINE)).status) === "open", await accFig(WAL_C_LINE));
  /** `gateway` is refused here and taken by `fund_money_wallet` above, and the difference is not an
   *  inconsistency: money the rail has reported and 135 has not yet reconciled is not money the office
   *  can promise to a second seat. The door says which stage will make it real. */
  const badFrom = await refuses("a hold the office fronts cannot come out of the gateway line",
    RAISE_E, [PLAT, "booking", BK_MAIN.booking, 5000, "TZS", null, "gateway", "other", PLAN, DAY,
      PEN, "compliance_officer", "127.0.0.1", "gate", null], "bad_from");
  check("…and the sentence names both the line and the stage that will reconcile it",
    /gateway/.test(String(badFrom?.message)) && /135/.test(String(badFrom?.message)), badFrom);
  await refuses("…and a fourth word for the office's own line is refused the same way", RAISE_E,
    [PLAT, "booking", BK_MAIN.booking, 5000, "TZS", null, "mpesa", "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null], "bad_from");

  // ---------------- 6b · one job, one live hold, and a line the book has stopped ----------------
  const H_BK_DUP = await refuses("a second hold against a job that already has money waiting on it "
    + "answers already_held", RAISE_E,
    [PLAT, "booking", BK_MAIN.booking, 90000, "TZS", WAL_A, null, "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null], "already_held");
  check("…and names the paper already there — its id, its number, its state and its figure — so the "
    + "desk reads one hold and knows which one to discharge",
    String(H_BK_DUP?.open_id) === String(H_BK?.hold?.id)
    && String(H_BK_DUP?.open_ref) === String(H_BK?.hold?.ref)
    && H_BK_DUP?.open_status === "held" && Number(H_BK_DUP?.open_amount) === 150000
    && H_BK_DUP?.open_currency === "TZS", H_BK_DUP);
  const onePerJob = async (kind: string, id: string) => (await one(
    `select count(*)::int as n from money_escrow_holds
      where subject_kind = $1 and subject_id = $2::uuid`, [kind, id])).n as number;
  check("…and no second paper was written, because the door answers the register's own unique index "
    + "rather than pre-checking for it", await onePerJob("booking", BK_MAIN.booking) === 1,
    await onePerJob("booking", BK_MAIN.booking));
  /** The index itself, asked of a hand rather than through the door: a desk holding the owner's pen
   *  can put a second live paper on one job only by breaking the constraint, and the constraint is
   *  what `already_held` is read out of. `status` is left at the register's own default, because a
   *  hand-written `held` row would answer the CHECK that a held paper needs a movement behind it
   *  before it ever reached the index. */
  await fails("a hand-written second live hold on one job breaks money_escrow_one_live_per_job",
    `insert into money_escrow_holds (tenant_id, ref, currency, amount, subject_kind, subject_id,
        from_account_id, into_account_id, reason_code, reason, raised_by)
      values ($1, 'ESC-2026-' || lpad(nextval('escrow_hold_number_seq')::text, 5, '0'), 'TZS',
        5000, 'booking', $2, $3, $4, 'other', $5, $6)`,
    [PLAT, BK_MAIN.booking, WAL_A_LINE, String(ESC_T.id), PLAN, PEN],
    "money_escrow_one_live_per_job", UNIQUE_VIOLATION);
  /** A replayed idempotency key at this door is not the case `fund_money_wallet` answers above. There
   *  the money is the movement and a retry gets it back; here the paper is new but the movement
   *  already stands under another hold, so the second paper would be a second claim on one sum. The
   *  door says so in its own voice and lets the whole call go back rather than answering with a paper
   *  whose money belongs to somebody else's number. The job it is aimed at carries no live paper of
   *  its own: `already_held` is answered before the row is written and the key is read only after it,
   *  so a job that already has a hold never lets the call reach the replay at all. */
  const CF_IDEM = await file("idem", BOOK("Consignee replay"),
    "A file the office tries to park money against twice under one key.");
  const HOLDS_BEFORE = (await one(`select count(*)::int as n from money_escrow_holds
    where tenant_id = $1::uuid`, [PLAT])).n;
  const POSTS_BEFORE = (await one(`select count(*)::int as n from money_postings
    where tenant_id = $1::uuid`, [PLAT])).n;
  await fails("raise_money_escrow refuses a second paper sent under the key that already parked the "
    + "money, rather than answering with a hold whose movement is another's", RAISE_E,
    [PLAT, "cargo_file", CF_IDEM, 15000, "TZS", WAL_B, null, "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", MEMO("hold the booking")],
    "already parked", DOOR_RAISE);
  check("…and the rollback of that one call leaves no half-written paper and no second movement",
    (await one(`select count(*)::int as n from money_escrow_holds where tenant_id = $1::uuid`,
      [PLAT])).n === HOLDS_BEFORE
    && (await one(`select count(*)::int as n from money_postings where tenant_id = $1::uuid`,
      [PLAT])).n === POSTS_BEFORE, { HOLDS_BEFORE, POSTS_BEFORE });
  /** The escrow line is a line in the book like any other, so 133's own freeze door reaches it. A book
   *  whose dollar escrow is stopped cannot take dollar money into escrow, and the door says the line
   *  is missing rather than writing a paper that points at a stopped account: the figure the office
   *  owes is the whole point of the line, and a frozen one is not the office's to owe it from. */
  const frzEsc = await call("the office freezes its own USD escrow line", FREEZE_ACC,
    [PLAT, String(ESC_U.id), "A compliance check on the dollar side of the book.", PEN, true]);
  check("…and 133's door answers with the line and its new state, which is the pair the desk reads "
    + "back to whoever telephones about it",
    frzEsc?.ok === true && frzEsc?.account?.status === "frozen"
    && frzEsc?.account?.code === "ESCROW-USD", frzEsc?.account);
  await fails("…and a dollar hold raised into that book is refused by the door's own sentence about "
    + "the missing line", RAISE_E,
    [PLAT, "cargo_file", CF_USD, 50, "USD", WAL_AUSD, null, "other", PLAN, DAY, PEN,
      "compliance_officer", "127.0.0.1", "gate", null],
    "no open ESCROW-USD line", DOOR_RAISE);
  const unfreezeEsc = await call("…so the office opens the line again, which is the only way a dollar "
    + "hold can be raised in this book", FREEZE_ACC, [PLAT, String(ESC_U.id), "", PEN, false]);
  check("…and the reopened line carries no reason, no stamp and no seat left on it",
    unfreezeEsc?.ok === true && unfreezeEsc?.account?.status === "open"
    && !unfreezeEsc?.account?.frozen_reason && !unfreezeEsc?.account?.frozen_at
    && !unfreezeEsc?.account?.frozen_by, unfreezeEsc?.account);
  const CF_USD2 = await file("usd two", BOOK("Consignee second dollar"),
    "A second clearing charge agreed in dollars.");
  const H_USD2 = await hold("and the dollar hold that was refused now stands, on a second file",
    "cargo_file", CF_USD2, 25, "USD", WAL_AUSD, null, "other");
  check("…into the same ESCROW-USD line, which is all the freeze had ever stopped",
    H_USD2?.ok === true && H_USD2?.hold?.into?.code === "ESCROW-USD"
    && Number((await accFig(String(ESC_U.id))).cached) === 125
    && Number(await walletBal(WAL_AUSD!)) === 375,
    { esc: await accFig(String(ESC_U.id)), bal: await walletBal(WAL_AUSD!) });

  // ---------------- 6c · the guard that reads the four registers ----------------
  /** Four jobs the office took off its board, and four ids none of the four registers ever held. Each
   *  is refused by the same half of the guard, in the words of the register it looked in, with the id
   *  it searched for printed back into the sentence — the difference between a correction a desk can
   *  make and a mystery it cannot. */
  const GONE: [string, string, string, string][] = [
    ["booking", String(BK_GONE.booking), "a booking the office closed", "there is no booking"],
    ["cargo_file", String(CF_GONE), "a cargo file the office closed", "there is no cargo file"],
    ["call", String(CALL_GONE), "a call the office closed", "there is no call"],
    ["dispute", String(DP_GONE), "a dispute the office closed", "there is no dispute"]
  ];
  for (const [kind, id, what, want] of GONE) {
    const e1 = await fails(`raise_money_escrow cannot park money against ${what}`, RAISE_E,
      [PLAT, kind, id, 5000, "TZS", WAL_A, null, "other", PLAN, DAY, PEN, "compliance_officer",
        "127.0.0.1", "gate", null], want, CHECK_VIOLATION);
    check("…and the sentence carries the id it looked for, which is the number the desk can go and "
      + "check on its own sheet", String(e1?.message).includes(id.slice(0, 8)), e1?.message);
    const e2 = await fails("…nor against an id none of the four registers has ever held, which is "
      + "named back to the desk rather than assumed", RAISE_E,
      [PLAT, kind, NO_BODY, 5000, "TZS", WAL_A, null, "other", PLAN, DAY, PEN, "compliance_officer",
        "127.0.0.1", "gate", null], want, CHECK_VIOLATION);
    check("…which is the uuid the desk typed, not the register's own",
      String(e2?.message).includes(NO_BODY), e2?.message);
  }
  /** The sixth defect this gate found in 134, and the reason the fix went into the migration instead
   *  of into the assertion below. `concat_ws` answers an all-blank row with an empty string rather
   *  than with NULL, so every note a job could not fill came out as `''` — and the guard's last test,
   *  `subject_note is null`, passed it. A hold with no words on it is exactly the paper a second seat
   *  is asked to sign, and `money_subjects.can_hold` had already told the desk that such a job cannot
   *  be held: the register said one thing and the door another. Both halves read the same rule now. */
  for (const [kind, id, what] of [
    ["booking", BK_BLANK.booking, "a booking whose route, cargo and company are all blank"],
    ["cargo_file", CF_BLANK, "a file with neither a consignee nor a cargo description"]
  ] as [string, string, string][]) {
    await fails(`the guard refuses a hold raised against ${what}, because the paper would print a `
      + "job it cannot name", RAISE_E,
      [PLAT, kind, id, 5000, "TZS", WAL_A, null, "other", PLAN, DAY, PEN, "compliance_officer",
        "127.0.0.1", "gate", null], "cannot name the job it waits on", CHECK_VIOLATION);
  }
  check("…which is the difference between a job that is silent and one that merely has little to "
    + "say: the booking above with no route still got its paper, and printed the two things it did "
    + "know", (await one(`select subject_note as n, subject_ref as r from money_escrow_holds
      where subject_kind = 'booking' and subject_id = $1::uuid`, [BK_PART.booking]))?.n
      === `${BOOK("One reefer of fish")} · ${BOOK("Shipper")}`,
    await onePerJob("booking", BK_PART.booking));
  /** A paper walked from one job to another is a signature spent on work nobody agreed to — 131's rule
   *  for a held card, and the reason the discharge plan is frozen along with it. Both halves of the
   *  pair are forged by hand: the id, which keeps the word and changes what it points at, and the
   *  word, which keeps the number and changes what it means. */
  await fails("a hand-written walk of a live hold onto a different job is refused by the guard",
    `update money_escrow_holds set subject_id = $2::uuid where id = $1::uuid`,
    [String(H_BK?.hold?.id), CF_MAIN], "raise a new hold for another job", CHECK_VIOLATION);
  await fails("…and so is a walk of the kind, which would keep the id and change what it points at",
    `update money_escrow_holds set subject_kind = 'cargo_file' where id = $1::uuid`,
    [String(H_BK?.hold?.id)], "raise a new hold for another job", CHECK_VIOLATION);
  await fails("a hold whose money is in the book cannot be deleted off it, only discharged",
    `delete from money_escrow_holds where id = $1::uuid`, [String(H_CALL?.hold?.id)],
    "never by deleting the paper", CHECK_VIOLATION);
  check("…so every paper is still on the board after the attempt, with the movement that parks the "
    + "money still the only way off it",
    (await one(`select count(*)::int as n from money_escrow_holds where tenant_id = $1::uuid`,
      [PLAT])).n === HOLDS_BEFORE + 1, { now: (await one(
      `select count(*)::int as n from money_escrow_holds where tenant_id = $1::uuid`,
      [PLAT])).n, HOLDS_BEFORE });

  // ---------------- 6d · the board and the paper, as the desk reads them ----------------
  const EB = await call("money_escrow_board reads the office's eight live papers", E_BOARD,
    [PLAT, null, null, null, 60, 0]);
  const ebRows = (EB?.rows ?? []) as Book[];
  check("…counted, newest first, and with the money the office is holding totalled by money beside "
    + "the rows rather than mixed into them",
    EB?.count === 8 && EB?.returned === 8 && ebRows.length === 8
    && Number(EB?.limit) === 60 && Number(EB?.offset) === 0
    && ebRows.every((r) => r.status === "held"),
    { count: EB?.count, returned: EB?.returned, limit: EB?.limit });
  const ebHeld = (EB?.held ?? []) as Book[];
  check("…and the heading says 325 000 TZS over six papers and 125 dollars over two, which is the "
    + "money that has actually moved: a `raised` paper would be counted in `awaiting` and not here",
    ebHeld.length === 2 && ebHeld.some((h) => h.currency === "TZS" && Number(h.held) === 325000
      && h.holds === 6 && Number(h.awaiting) === 0)
    && ebHeld.some((h) => h.currency === "USD" && Number(h.held) === 125 && h.holds === 2), ebHeld);
  check("…every row prints the job out of the paper rather than making the desk go and read a second "
    + "register: the kind, the derived number, its own words and the seat that raised it",
    ebRows.every((r) => !!r.subject_ref && !!r.subject_note && String(r.raised_by) === SEAT("Pen"))
    && ebRows.filter((r) => r.subject_kind === "booking").length === 2
    && ebRows.filter((r) => r.subject_kind === "cargo_file").length === 3
    && ebRows.filter((r) => r.subject_kind === "call").length === 2
    && ebRows.filter((r) => r.subject_kind === "dispute").length === 1,
    ebRows.map((r) => [r.subject_kind, r.subject_ref]));
  check("…and the company a paper points at is printed as a name where the register has one, and "
    + "left off where the call named nobody, so the desk is never shown an uuid for a company",
    ebRows.filter((r) => !!r.subject_name).every((r) => String(r.subject_name).startsWith("Moves"))
    && ebRows.filter((r) => r.subject_name === null).length === 1
    && ebRows.filter((r) => r.subject_name === null)[0].subject_ref === T_REF2,
    ebRows.map((r) => [r.subject_ref, r.subject_name]));
  const ebCall = ebRows.find((r) => String(r.id) === String(H_CALL?.hold?.id));
  check("…a row carries the printed number of the movement under it rather than its uuid, and no "
    + "plan and no signature until one is asked for",
    /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(ebCall?.hold_posting))
    && ebCall?.plan === null && ebCall?.approval === null && Number(ebCall?.refusals) === 0
    && String(ebCall?.discharge_posting ?? "") === "", ebCall);
  const ebUsd = await call("…filtered to the dollars the office is holding", E_BOARD,
    [PLAT, null, "usd", null, 60, 0]);
  check("…which is two papers, and a heading that counts only them, so a filter never leaves an "
    + "unfiltered total sitting above the rows",
    ebUsd?.count === 2 && ebUsd?.returned === 2 && ebUsd?.held?.length === 1
    && ebUsd?.held[0].currency === "USD" && Number(ebUsd?.held[0].held) === 125, ebUsd);
  const ebKind = await call("…and filtered to the calls", E_BOARD, [PLAT, null, null, "CALL", 60, 0]);
  check("…which the board reads case-folded, because a desk types a word rather than picks a code",
    ebKind?.count === 2 && ebKind?.rows?.every((r: Book) => r.subject_kind === "call"), ebKind);
  /** The eighth defect this gate found in 134, and it is a paging fault rather than a money fault, so
   *  it belongs to the desk rather than to the book: `now()` is the transaction's own timestamp, which
   *  means every paper raised in one call carries an identical `raised_at`. Each board re-sorted its
   *  rows for display by `raised_at, ref`, but cut its *page* on `raised_at` alone — and a page cut on
   *  a tie is free to show one row twice on page one and never on page two. All four boards now carry
   *  the same second key in both places, and eight papers raised in one transaction is the shape that
   *  proves it. */
  const pages = [] as string[][];
  for (const off of [0, 3, 6]) {
    const pg = await call(`…and paged three at a time from offset ${off}`, E_BOARD,
      [PLAT, "held", null, null, 3, off]);
    check(`page ${off / 3 + 1} answers ${off === 6 ? 2 : 3} of eight and still says eight, so a desk `
      + "knows how far it has to go", pg?.count === 8 && Number(pg?.returned) === (off === 6 ? 2 : 3)
      && Number(pg?.offset) === off && Number(pg?.limit) === 3, { c: pg?.count, r: pg?.returned });
    pages.push((pg?.rows ?? []).map((r: Book) => String(r.ref)));
  }
  const walked = pages.flat();
  check("…and the three pages walk every paper once: no hold appears twice and none is missed, which "
    + "is what a second sort key on the page buys",
    walked.length === 8 && new Set(walked).size === 8
    && sameFold(walked, (EB?.rows ?? []).map((r: Book) => String(r.ref))), pages);
  check("…in the order the board itself displays them, so a desk that reads page one and page two is "
    + "reading one list and not two that happen to overlap",
    walked.every((ref, i) => ref === String((EB?.rows ?? [])[i].ref)), walked);
  const ebOther = await call("a company's own book is answered an empty escrow board", E_BOARD,
    [holderA, null, null, null, 60, 0]);
  check("…in the door's own words rather than as a fault page, and with nothing behind the sentence",
    ebOther?.rows?.length === 0 && /office/i.test(String(ebOther?.error))
    && Number(ebOther?.count) === 0 && ebOther?.held?.length === 0, ebOther);
  const ED = await call("money_escrow_detail opens one paper in full", E_DETAIL,
    [PLAT, String(H_BK?.hold?.id)]);
  check("…with both lines the money moved between, the payer as the desk can read it, the plan it "
    + "has not yet been asked to sign, and the two seats that raised it and will discharge it",
    ED?.ref === H_BK?.hold?.ref && String(ED?.from?.code) === await codeOf(WAL_A_LINE)
    && ED?.into?.code === "ESCROW-TZS" && ED?.payer_wallet?.holder === HOLDER_A_NAME
    && Number(ED?.payer_wallet?.balance) === 525000 && ED?.payer_wallet?.status === "open"
    && String(ED?.payee_wallet ?? "") === "" && Number(ED?.plan_total) === 0
    && ED?.plan_agrees === true && String(ED?.subject_name) === HOLDER_A_NAME
    && String(ED?.raised_by_name) === SEAT("Pen")
    && String(ED?.discharged_by_name ?? "") === "" && String(ED?.approval ?? "") === "",
    { from: ED?.from?.code, bal: ED?.payer_wallet?.balance, subject: ED?.subject_name });
  check("…and the movement it was raised on is the same pair the door booked, read under the same "
    + "printed number, so the paper and the book are one story rather than two that happen to agree",
    ED?.hold_posting?.ref === H_BK?.hold?.hold_posting?.ref
    && ED?.hold_posting?.legs?.length === 2 && ED?.discharge_posting === null,
    { post: ED?.hold_posting?.ref, legs: ED?.hold_posting?.legs?.length });
  check("…the detail keeps no `tenant_id`, because a hold is the office's own paper and the only "
    + "company it prints is the one whose job the money waits on",
    ED?.tenant_id === undefined && ED?.subject_tenant_id === holderA, { tenant: ED?.tenant_id });
  const edGone = await call("money_escrow_detail answers a hold that is not in this book", E_DETAIL,
    [PLAT, NO_BODY]);
  check("…with the sentence a desk prints as a line rather than an empty object",
    edGone?.ok === undefined && String(edGone?.error) === "There is no hold in this book.", edGone);
  const edOther = await call("…and a hold that is in the book, asked of a company's own", E_DETAIL,
    [holderA, String(H_BK?.hold?.id)]);
  check("…answers the same sentence, because the paper is not in that register and a desk must not "
    + "learn from the answer that it exists somewhere else",
    String(edOther?.error) === "There is no hold in this book.", edOther);
  note("the eight papers above are the whole of what 134 parks: two bookings, three cargo files, two "
    + "calls and one dispute. The office owes 525 000, 640 000, 190 000 and 40 000 to four holders, "
    + "nothing to the fifth, and 375 dollars to the dollar balance; it holds 325 000 TZS and 125 "
    + "dollars against other people's jobs, and 30 000 of that came out of its own till.");
  const sq6 = await square();
  check("with eight holds booked, the book still answers that it balances with itself — every one of "
    + "134's movements is a pair 133 can add up",
    sq6?.square === true && Number(sq6?.unbalanced) === 0 && Number(sq6?.short_legged) === 0
    && Number(sq6?.figure_disagrees) === 0, sq6);
  const pay6 = await payable();
  check("…and the liabilities board the office reads its own money off now carries the sixth holder's "
    + "line as well: twelve lines, no drift, and nothing the book and its own cached column disagree "
    + "about",
    pay6?.square === true && Number(pay6?.accounts) === 12 && Number(pay6?.drift) === 0
    && Number(pay6?.disagrees) === 0,
    { accounts: pay6?.accounts, drift: pay6?.drift, disagrees: pay6?.disagrees });
  const escRows = (pay6?.rows ?? []).filter((r: Book) => String(r.account).startsWith("ESCROW"));
  check("…the two escrow lines print the figure the papers say is parked beside the figure the legs "
    + "add up to, and both agree — which is the reconciliation the office cannot fake, paper by paper",
    escRows.length === 2 && escRows.some((r) => r.account === "ESCROW-TZS"
      && Number(r.book) === 325000 && Number(r.papers) === 325000 && r.papers_n === 6
      && r.disagrees === false && Number(r.drift) === 0)
    && escRows.some((r) => r.account === "ESCROW-USD" && Number(r.book) === 125
      && Number(r.papers) === 125 && r.papers_n === 2 && r.disagrees === false), escRows);
  const held6 = (pay6?.held ?? []) as Book[];
  check("…and the money the office owes its holders has fallen by exactly what it is holding for "
    + "somebody else's jobs: 1 395 000 TZS over five balances and 375 dollars over one",
    held6.some((h) => h.currency === "TZS" && Number(h.held) === 1395000 && h.wallets === 5)
    && held6.some((h) => h.currency === "USD" && Number(h.held) === 375 && h.wallets === 1), held6);

  // ---------------- 7 · the plan, the signature it is asked for, and the legs it buys --------------
  phase("7 · a plan is three figures and a wallet, a second seat signs the bytes it was written "
    + "from, and the money leaves escrow in exactly the legs the plan named");
  /** The two doors that write a plan, as the desk calls them. `propose` is asked first of a paper that
   *  is already parked, because the plan is the only thing on this register a *second* person signs,
   *  so every one of its refusals has to arrive before any state moves. */
  const S_NAME = String((await row("money_wallets", WAL_S!)).holder_name);
  const HCF = String(H_CF?.hold?.id);
  const HCL = String(H_CALL?.hold?.id);
  const HBK = String(H_BK?.hold?.id);
  const HDP = String(H_DP?.hold?.id);
  const HNO = String(H_NOC?.hold?.id);
  const HCA = String(H_CASH?.hold?.id);
  const HU1 = String(H_USD?.hold?.id);
  const HU2 = String(H_USD2?.hold?.id);
  const SEAT_ROLE = "compliance_officer";
  const propose = (label: string, hold: string, kind: string, to: number, back: number, fee: number,
    payee: string | null, reason = PLAN, actor = PEN) => call(label, PROPOSE_E,
    [PLAT, hold, kind, to, back, fee, payee, reason, actor, SEAT_ROLE, "127.0.0.1", "gate"]);
  const refuse = (label: string, hold: string, note_: string, actor = QUILL) => call(label, REFUSE_E,
    [PLAT, hold, note_, actor, SEAT_ROLE, "127.0.0.1", "gate"]);
  /** The plan as the register kept it, read from the approval row rather than from the door's echo,
   *  because the payload is the bytes the hash was taken of and the guard re-reads it before money
   *  leaves — a figure that agrees with the desk but not with the signature is the defect. */
  const apRow = async (id: string) => (await one(`select action, target_kind, target_id, status,
        reason, proposed_by, decided_by, decided_note, decided_at, payload, payload_sha256,
        expires_at, applied_at, result
      from platform_approvals where id = $1::uuid`, [id])) as Book;
  const planN = async (hold: string) => (await one(
    `select count(*)::int as n from platform_approvals where action = 'money.escrow'
      and target_kind = 'escrow_hold' and target_id = $1`, [hold])).n as number;

  /** Twenty refusals, in the order the door asks them, and none of them writes anything. The seat
   *  question comes before the vocabulary, the vocabulary before the paper, the arithmetic before the
   *  payee — so a desk that gets `bad_kind` has not yet been told whether its hold is real, and a desk
   *  that gets `payee_currency` has typed three figures the register already accepted. */
  await refuses("propose_escrow_discharge refuses a hand that is not a platform seat", PROPOSE_E,
    [PLAT, HCF, "released", 60000, 0, 0, WAL_A, PLAN, COMPANY_USER, "finance_officer",
      "127.0.0.1", "gate"], "not_a_seat");
  const noSeat = await refuse("…and a seat the office has struck off the roster answers the same "
    + "words, because `approval_seat` asks for an active person and finds neither", HCF, REFUSE,
    SUSPENDED_SEAT);
  check("…from the propose door too, with the sentence that names who may ask",
    noSeat?.ok === false && noSeat?.error === "not_a_seat", noSeat);
  const badKind = await refuses("a plan whose kind is none of the three a plan can be", PROPOSE_E,
    [PLAT, HCF, "repaid", 30000, 30000, 0, WAL_A, PLAN, PEN, SEAT_ROLE, "127.0.0.1", "gate"],
    "bad_kind");
  check("…names the three words the desk is allowed to choose between, rather than the one it typed",
    /releases to the payee, refunds to the payer, or splits/.test(String(badKind?.message)), badKind);
  await refuses("…and a reason too short to be the sentence a second seat signs", PROPOSE_E,
    [PLAT, HCF, "released", 60000, 0, 0, WAL_A, "pay it", PEN, SEAT_ROLE, "127.0.0.1", "gate"],
    "bad_reason");
  await refuses("…or too long for the column the register keeps it in", PROPOSE_E,
    [PLAT, HCF, "released", 60000, 0, 0, WAL_A, "x".repeat(601), PEN, SEAT_ROLE, "127.0.0.1", "gate"],
    "bad_reason");
  await refuses("a plan asked of a paper this book does not have answers not_found", PROPOSE_E,
    [PLAT, NO_BODY, "released", 1000, 0, 0, WAL_A, PLAN, PEN, SEAT_ROLE, "127.0.0.1", "gate"],
    "not_found");
  /** A `raised` paper is the one state this register can hold without money behind it — the door never
   *  writes it, but the column and its CHECK allow it, and a plan asked over a paper that has parked
   *  nothing is the one conflict the desk cannot read off its own screen. */
  const CF_RAISE = await file("raised", BOOK("Consignee never parked"),
    "A paper the office wrote and never parked money on.");
  const RAISED = String((await one(`insert into money_escrow_holds (tenant_id, ref, currency, amount,
        subject_kind, subject_id, from_account_id, into_account_id, reason_code, reason, raised_by,
        status) values ($1, 'ESC-2026-' || lpad(nextval('escrow_hold_number_seq')::text, 5, '0'),
        'TZS', 5000, 'cargo_file', $2, $3, $4, 'other', $5, $6, 'raised') returning id`,
    [PLAT, CF_RAISE, WAL_A_LINE, String(ESC_T.id), PLAN, PEN])).id);
  const raisedPlan = await propose("…and a paper that never parked money cannot be planned for "
    + "discharge", RAISED, "released", 5000, 0, 0, WAL_A);
  check("…is answered with conflict and the state a hand left on the row, in the sentence about money "
    + "that is not there yet", raisedPlan?.ok === false && raisedPlan?.error === "conflict"
    && raisedPlan?.hold_status === "raised" && /Nothing is parked/.test(String(raisedPlan?.message)),
    raisedPlan);
  await okDo("…and a `raised` paper with no movement behind it is the only hold this register lets a "
    + "hand take off the board", `delete from money_escrow_holds where id = $1::uuid`, [RAISED]);
  const negPlan = await propose("a plan cannot put money in", HCF, "split", -1000, 61000, 0, WAL_A);
  check("…and the negative figure is answered before the sum is checked, so the desk is told which "
    + "of its own keys is wrong rather than that the three do not add up",
    negPlan?.ok === false && negPlan?.error === "negative_plan"
    && /below zero/.test(String(negPlan?.message)), negPlan);
  const noAdd = await propose("three figures that are not the whole of the money held are not a plan",
    HCF, "split", 30000, 20000, 5000, WAL_A);
  check("…answered with all four figures printed back as the register prints them, the held sum "
    + "beside the three the desk typed, and the paper's own number",
    noAdd?.ok === false && noAdd?.error === "does_not_add_up"
    && noAdd?.to_payee === "30000.00" && noAdd?.back_to_payer === "20000.00"
    && noAdd?.fee_amount === "5000.00" && noAdd?.held === "60000.00"
    && noAdd?.currency === "TZS" && noAdd?.ref === H_CF?.hold?.ref, noAdd);
  for (const [k, to, back, fee, err_, why] of [
    ["refunded", 1000, 59000, 0, "bad_refund", "keeps a unit back for the payee"],
    ["refunded", 0, 59000, 1000, "bad_refund", "lets the office take a cut of a refund"],
    ["released", 40000, 20000, 0, "bad_release", "sends money back to the payer as well"],
    ["released", 0, 0, 60000, "bad_release", "pays the payee nothing and keeps the whole figure"],
    ["split", 60000, 0, 0, "bad_split", "gives the payer no part of it"],
    ["split", 0, 60000, 0, "bad_split", "gives the payee no part of it"]
  ] as [string, number, number, number, string, string][]) {
    const r = await refuses(`a ${k} plan that ${why}`, PROPOSE_E,
      [PLAT, HCF, k, to, back, fee, k === "refunded" ? null : WAL_A, PLAN, PEN, SEAT_ROLE,
        "127.0.0.1", "gate"], err_);
    check(`…and repeats the shape it was asked for, naming the sides rather than the figure it did not `
      + `like (${to} / ${back} / ${fee} on a ${H_CF?.hold?.ref})`,
      new RegExp(`${k} plan`).test(String(r?.message))
        && /payee|payer|both sides/.test(String(r?.message))
        && String(r?.message ?? "").length > 40, r);
  }
  await refuses("a plan that releases money has to say to whom", PROPOSE_E,
    [PLAT, HCF, "released", 60000, 0, 0, null, PLAN, PEN, SEAT_ROLE, "127.0.0.1", "gate"],
    "no_payee");
  const named = await propose("…and a refunded plan that names one is answered for the naming", HCF,
    "refunded", 0, 60000, 0, WAL_A);
  check("…with the sentence that says where the money goes instead", named?.ok === false
    && named?.error === "payee_named" && /back to where it came from/.test(String(named?.message)),
    named);
  await refuses("…and a payee wallet this book does not have is answered by its own id", PROPOSE_E,
    [PLAT, HCF, "released", 60000, 0, 0, NO_BODY, PLAN, PEN, SEAT_ROLE, "127.0.0.1", "gate"],
    "payee_not_found");
  const payeeUsd = await propose("a TZS plan cannot be paid into the holder's dollar balance", HCF,
    "released", 60000, 0, 0, WAL_AUSD);
  check("…naming whose balance it is and both monies, so the desk can see which of its own keys to "
    + "change", payeeUsd?.ok === false && payeeUsd?.error === "payee_currency"
    && payeeUsd?.holder === HOLDER_A_NAME && payeeUsd?.wallet_currency === "USD"
    && payeeUsd?.currency === "TZS", payeeUsd);
  await call("the office stops the second holder's balance to try a plan that pays into it", FREEZE_W,
    [PLAT, WAL_B, STOP, QUILL, true, SEAT_ROLE, "127.0.0.1", "gate"]);
  const payeeFrz = await propose("…and a plan cannot be cut over a stopped payee", HCF, "released",
    60000, 0, 0, WAL_B);
  check("…with the words the stop was written with and whose balance it is", payeeFrz?.ok === false
    && payeeFrz?.error === "payee_frozen" && payeeFrz?.holder === B_NAME
    && String(payeeFrz?.reason) === STOP, payeeFrz);
  await call("…so the office opens the balance again", FREEZE_W,
    [PLAT, WAL_B, "", QUILL, false, SEAT_ROLE, "127.0.0.1", "gate"]);
  const sameWallet = await propose("a plan cannot release money back to the wallet it came from",
    HCF, "released", 60000, 0, 0, WAL_S);
  check("…because that is a refund, and the register has a word for it", sameWallet?.ok === false
    && sameWallet?.error === "payee_is_payer" && /refunded/.test(String(sameWallet?.message)),
    sameWallet);
  const cfHeld = await row("money_escrow_holds", HCF);
  check("none of the twenty refusals above wrote anything: the shipper's paper still reads `held`, "
    + "carries no kind, no figure, no wallet and no signature, and the register holds no approval "
    + "against it at all",
    cfHeld.status === "held" && cfHeld.discharge_kind === null && cfHeld.to_payee === null
    && cfHeld.payee_wallet_id === null && cfHeld.approval_id === null && cfHeld.refusals === 0
    && await planN(HCF) === 0, cfHeld);

  /** The plan the second seat is asked to sign. Fifteen thousand to the shipper who was paid late, ten
   *  thousand back to the holder who parked it, nothing kept — three figures the office does not get to
   *  change after the signature is on its way. */
  const P1 = await propose("the office plans to split the 25 000 held against the call", HCL,
    "split", 15000, 10000, 0, WAL_S);
  const A1 = String(P1?.approval_id);
  check("…and the answer is the signature itself: an uuid, the act, the paper it stands on, the three "
    + "figures, the wallet, a 64-digit hash and seven days",
    P1?.ok === true && /^[0-9a-f-]{36}$/.test(A1) && P1?.action === "money.escrow"
    && P1?.target_kind === "escrow_hold" && String(P1?.target_id) === HCL
    && P1?.ref === H_CALL?.hold?.ref && Number(P1?.amount) === 25000 && P1?.currency === "TZS"
    && P1?.discharge_kind === "split" && Number(P1?.to_payee) === 15000
    && Number(P1?.back_to_payer) === 10000 && Number(P1?.fee_amount) === 0
    && String(P1?.payee_wallet_id) === WAL_S && /^[0-9a-f]{64}$/.test(String(P1?.payload_sha256))
    && new Date(String(P1?.expires_at)).getTime() > Date.now() + 6 * 864e5
    && new Date(String(P1?.expires_at)).getTime() < Date.now() + 8 * 864e5, P1);
  const ap1 = await apRow(A1);
  check("…and the payload the hash was taken of carries the plan as the register prints it — the "
    + "figures as text, both holders by name, and the job's own number beside it",
    ap1.status === "pending" && ap1.action === "money.escrow" && ap1.target_id === HCL
    && String(ap1.proposed_by) === PEN && ap1.payload?.tenant_id === undefined
    && String(ap1.payload?.hold_id) === HCL && String(ap1.payload?.subject_id) === CALL_MAIN
    && ap1.payload?.subject_tenant_id === holderA && ap1.payload?.reason === H_CALL?.hold?.reason
    && ap1.payload?.amount === "25000.00" && ap1.payload?.to_payee === "15000.00"
    && ap1.payload?.back_to_payer === "10000.00" && ap1.payload?.fee_amount === "0.00"
    && ap1.payload?.discharge_kind === "split" && String(ap1.payload?.payee_wallet_id) === WAL_S
    && ap1.payload?.payee_holder === S_NAME && ap1.payload?.payer_holder === HOLDER_A_NAME
    && ap1.payload?.subject_ref === T_REF && ap1.payload?.subject_kind === "call"
    && ap1.payload?.ref === H_CALL?.hold?.ref && ap1.payload?.plan_note === PLAN
    && ap1.payload?.reason_code === "complaint", ap1);
  const p1Row = await row("money_escrow_holds", HCL);
  check("…and the paper now reads `pending_discharge` with the plan written on it and the signature "
    + "pointed at, which is the pair the board shows a second seat",
    p1Row.status === "pending_discharge" && p1Row.discharge_kind === "split"
    && Number(p1Row.to_payee) === 15000 && Number(p1Row.back_to_payer) === 10000
    && Number(p1Row.fee_amount) === 0 && String(p1Row.payee_wallet_id) === WAL_S
    && String(p1Row.approval_id) === A1 && p1Row.discharge_posting_id === null
    && p1Row.refusals === 0, p1Row);
  const pd1 = await call("the desk that raised the plan cannot ask twice", PROPOSE_E,
    [PLAT, HCL, "released", 25000, 0, 0, WAL_B, PLAN, PEN, SEAT_ROLE, "127.0.0.1", "gate"]);
  check("…and the answer names the signature already standing, with the state the register reads",
    pd1?.ok === false && pd1?.error === "already_open" && String(pd1?.approval_id) === A1
    && pd1?.approval_status === "pending" && /stands open on a signature/
      .test(String(pd1?.message)), pd1);
  /** The second half of the same rule, reached the only way a legal row can reach it: the register
   *  keeps one *open proposal per act per target* as a partial unique index, and the door's own
   *  pre-check only looks when the paper reads `pending_discharge`. A hand that walks the state back
   *  without touching the signature — which the plan guard allows, because the plan did not move — has
   *  to be answered by the index, and 134 catches it and prints `open_id` instead of letting a 23505
   *  reach the desk as a fault page. */
  await okDo("a hand can walk a planned paper back to `held` — the plan itself has not moved",
    `update money_escrow_holds set status = 'held' where id = $1::uuid`, [HCL]);
  const lap = await propose("…and the second ask for the same signature is answered by the register's "
    + "own one-open rule, not by the pre-check", HCL, "released", 25000, 0, 0, WAL_B);
  check("…which answers `already_open` with the id of the approval that is still waiting",
    lap?.ok === false && lap?.error === "already_open" && String(lap?.open_id) === A1
    && /waiting for a second seat/.test(String(lap?.message)), lap);
  await okDo("…so the paper is put back where the signature stands on it",
    `update money_escrow_holds set status = 'pending_discharge' where id = $1::uuid`, [HCL]);
  check("…and no third approval was written by either ask", await planN(HCL) === 1, await planN(HCL));

  /** The guard that keeps the plan under the signature. Four hand-writes, each a different figure of
   *  the three, the wallet and the kind — and the held sum itself, which is not the desk's to change
   *  either. These are the four ways an office could pay out something other than what a second seat
   *  agreed to, and every one of them is a sentence about the numbers that were signed. The kind is
   *  sent as a bare parameter so the server reads it as the column's own type; a hand that inlines it
   *  as a literal instead leaves `$2` as the only numbered parameter in the sentence, which is a
   *  parse fault, not a guard, and would prove nothing about the plan. */
  for (const [col, cast, val, why] of [
    ["to_payee", "::numeric", "9000", "the figure the payee was told about"],
    ["back_to_payer", "::numeric", "26000", "the figure the payer was told about"],
    ["fee_amount", "::numeric", "5000", "the cut the office said it would keep"],
    ["payee_wallet_id", "::uuid", WAL_A, "the wallet the money was promised to"],
    ["discharge_kind", "", "refunded", "which of the three shapes the signature was given for"]
  ] as [string, string, string, string][]) {
    await fails(`a hand cannot change ${why} once the signature is standing on it`,
      `update money_escrow_holds set ${col} = $1${cast} where id = $2::uuid`,
      [val, HCL], "the plan cannot move under it");
  }
  await fails("…nor change the sum that is parked, which the money in escrow already fixed",
    `update money_escrow_holds set amount = 25001 where id = $1::uuid`, [HCL],
    "the plan cannot move under it");
  check("…and the paper still carries exactly the plan the signature was asked over",
    ((await one(`select to_payee, back_to_payer, fee_amount, discharge_kind, payee_wallet_id, amount
      from money_escrow_holds where id = $1::uuid`, [HCL])) as Book).to_payee === "15000.00",
    await row("money_escrow_holds", HCL));
  /** The same guard's other two states, asked of a `held` paper so the discharge rule cannot answer
   *  first: the figure a hold was raised for, and the direction the state machine is allowed to run. */
  await fails("a hand cannot change the figure on a paper that is only holding money",
    `update money_escrow_holds set amount = 59999 where id = $1::uuid`, [HCF],
    "the figure is set by the money that is parked");
  await fails("…and money that is in escrow does not un-park itself back to `raised`",
    `update money_escrow_holds set status = 'raised' where id = $1::uuid`, [HCF],
    "does not un-park itself");

  /** The wallet guard, asked of a hand that skips the door. The two questions the propose door asks
   *  about a payee are table rules for anybody who writes the row directly, and the payer's side has
   *  three more that no desk ever sees: a wallet in another money, a wallet whose own line is not the
   *  line the paper names, and a wallet the book does not have. */
  for (const [what, sql, p, want] of [
    ["pay a TZS plan out of a dollar balance",
      `update money_escrow_holds set discharge_kind = 'released', to_payee = 60000,
          back_to_payer = 0, fee_amount = 0, payee_wallet_id = $1::uuid where id = $2::uuid`,
      [WAL_AUSD, HCF], "releases to a USD wallet and the money is TZS"],
    ["pay a plan back into the wallet it came from",
      `update money_escrow_holds set discharge_kind = 'released', to_payee = 60000,
          back_to_payer = 0, fee_amount = 0, payee_wallet_id = $1::uuid where id = $2::uuid`,
      [WAL_S, HCF], "would release money to the wallet it came from"],
    ["call a plan refunded while naming a payee",
      `update money_escrow_holds set discharge_kind = 'refunded', to_payee = 0,
          back_to_payer = 60000, fee_amount = 0, payee_wallet_id = $1::uuid where id = $2::uuid`,
      [WAL_A, HCF], "a refunded plan sends everything back to the payer"],
    ["take money out of a wallet in another money",
      `update money_escrow_holds set payer_wallet_id = $1::uuid where id = $2::uuid`,
      [WAL_AUSD, HCF], "is held for a USD wallet and the money is TZS"],
    ["take money out of a wallet whose line is not the line on the paper",
      `update money_escrow_holds set payer_wallet_id = $1::uuid where id = $2::uuid`,
      [WAL_B, HCF], "whose own line is not the one this paper names"],
    ["name a payer wallet the book does not have",
      `update money_escrow_holds set payer_wallet_id = $1::uuid where id = $2::uuid`,
      [NO_BODY, HCF], "names a payer wallet the office does not have"],
    ["name a payee wallet the book does not have",
      `update money_escrow_holds set discharge_kind = 'released', to_payee = 60000,
          back_to_payer = 0, fee_amount = 0, payee_wallet_id = $1::uuid where id = $2::uuid`,
      [NO_BODY, HCF], "names a payee wallet the office does not have"],
    ["park the money in a line that is not that money's escrow",
      `update money_escrow_holds set into_account_id = $1::uuid where id = $2::uuid`,
      [WAL_A_LINE, HCF], "money waits in ESCROW-TZS"],
    ["move money from a line onto the same line",
      `update money_escrow_holds set from_account_id = into_account_id where id = $1::uuid`,
      [HCF], "onto the same line"]
  ] as [string, string, any[], string][]) {
    await fails(`a hand cannot ${what}`, sql, p, want);
  }
  check("…and after nine forgeries the shipper's paper is still the plain hold the door wrote",
    ((await one(`select status, discharge_kind, payee_wallet_id, payer_wallet_id, amount,
        from_account_id, into_account_id from money_escrow_holds where id = $1::uuid`,
      [HCF])) as Book).discharge_kind === null, await row("money_escrow_holds", HCF));
  /** The one escrow rule 133 could not express: the money has two lines and the paper names both, so a
   *  hand that moves a *USD* paper's own lines is asked for the money the hold is held in. */
  await fails("…and a dollar paper cannot wait in the shilling escrow line",
    `update money_escrow_holds set into_account_id = $1::uuid where id = $2::uuid`,
    [String(ESC_T.id), HU1], "money waits in ESCROW-USD");

  /** Refusing the plan. The note is the sentence the *next* plan has to answer for, so it keeps the
   *  same 8-600 floor as the reason; a paper with no signature standing on it is not a thing the
   *  register can mark refused; and the signature itself is answered by `decide_approval` before the
   *  paper is stamped, which is where 134's own seat rule bites. */
  await refuses("refuse_escrow_discharge refuses a note too short to answer", REFUSE_E,
    [PLAT, HCL, "no", QUILL, SEAT_ROLE, "127.0.0.1", "gate"], "bad_note");
  await refuses("…or too long for the column it is kept in", REFUSE_E,
    [PLAT, HCL, "x".repeat(601), QUILL, SEAT_ROLE, "127.0.0.1", "gate"], "bad_note");
  await refuses("…and a paper this book does not have answers not_found", REFUSE_E,
    [PLAT, NO_BODY, REFUSE, QUILL, SEAT_ROLE, "127.0.0.1", "gate"], "not_found");
  const noOpen = await refuse("a plan the office never asked for cannot be refused", HCF, REFUSE);
  check("…because there is no signature to answer, and the door says which state the paper is in",
    noOpen?.ok === false && noOpen?.error === "nothing_open" && noOpen?.hold_status === "held"
    && /never asked/.test(String(noOpen?.message)), noOpen);
  const selfRef = await refuse("the seat that asked for the signature cannot refuse it either", HCL,
    REFUSE, PEN);
  check("…and the answer is 134's own: the signature was not answered, with 121's sentence carried "
    + "back inside the answer rather than flattened away",
    selfRef?.ok === false && selfRef?.error === "refused_the_signature_first"
    && selfRef?.approval_answer?.status === "self"
    && /cannot be the one that signs it/.test(String(selfRef?.approval_answer?.message)), selfRef);
  const cfBefore = await accFig(String(ESC_T.id));
  const balBefore = { a: await walletBal(WAL_A!), s: await walletBal(WAL_S!),
    b: await walletBal(WAL_B!), esc: Number(cfBefore.cached) };
  const refused = await refuse("…so a second seat refuses it, and the money stays parked", HCL, REFUSE);
  check("…answering with the paper, the refusal count and the signature it refused",
    refused?.ok === true && Number(refused?.refusals) === 1 && String(refused?.approval_id) === A1
    && refused?.hold?.status === "held" && Number(refused?.hold?.refusals) === 1, refused);
  const rRow = await row("money_escrow_holds", HCL);
  check("…the paper walked back to `held` with the refusal stamped on it — who, when, and in what "
    + "words — while the plan it was refused over stays legible beside it",
    rRow.status === "held" && Number(rRow.refusals) === 1 && String(rRow.refused_by) === QUILL
    && String(rRow.refused_note) === REFUSE && !!rRow.refused_at
    && rRow.discharge_kind === "split" && Number(rRow.to_payee) === 15000
    && String(rRow.approval_id) === A1, rRow);
  check("…and 121's register now reads the signature as rejected, which is why the paper can be "
    + "planned again at all", (await apRow(A1)).status === "rejected", await apRow(A1));
  const balAfter = { a: await walletBal(WAL_A!), s: await walletBal(WAL_S!),
    b: await walletBal(WAL_B!), esc: Number((await accFig(String(ESC_T.id))).cached) };
  check("…nothing moved: the escrow line still carries the same figure and all three balances are "
    + "exactly what they were before the plan was asked for",
    balAfter.esc === balBefore.esc && balAfter.a === balBefore.a && balAfter.s === balBefore.s
    && balAfter.b === balBefore.b, { balBefore, balAfter });
  await fails("a refusal count with nobody named as having refused it breaks the register's own CHECK",
    `update money_escrow_holds set refusals = 1 where id = $1::uuid`, [HCF], "", CHECK_VIOLATION);
  note("`refuse_escrow_discharge` also carries an `approval_missing` answer for a pending paper whose "
    + "signature row has gone. This gate cannot reach it from a legal row: the table's own CHECK ties "
    + "a pending paper to a non-null approval_id, and the foreign key will not let that row be "
    + "deleted while the paper points at it. It is a defensive answer to a register edited underneath "
    + "the desk, and the gate says so rather than forging the row it would need.");

  /** The plan asked again. A refused paper is a hold that has to be planned again, and the second plan
   *  is a different signature — the register keeps both, points the paper only at the live one, and
   *  leaves the count where the first refusal put it. */
  const P2 = await propose("and the same paper is planned again over what the agent actually charged",
    HCL, "released", 25000, 0, 0, WAL_B);
  const A2 = String(P2?.approval_id);
  check("…which is a new signature, not the refused one re-labelled", P2?.ok === true && A2 !== A1
    && P2?.discharge_kind === "released" && Number(P2?.to_payee) === 25000
    && String(P2?.payee_wallet_id) === WAL_B, P2);
  const p2Row = await row("money_escrow_holds", HCL);
  check("…the paper points at the live one only, still carries its one refusal, and the register now "
    + "holds two approvals against it — one rejected, one waiting",
    String(p2Row.approval_id) === A2 && p2Row.status === "pending_discharge"
    && Number(p2Row.refusals) === 1 && await planN(HCL) === 2, p2Row);
  check("…and the refused signature is still `rejected` in the register, because a plan asked twice is "
    + "two separate pieces of paper rather than one row edited until it fits",
    (await apRow(A1)).status === "rejected" && (await apRow(A2)).status === "pending",
    { a1: await apRow(A1), a2: await apRow(A2) });

  /** Money leaves escrow on a second seat's signature, or not at all. Four forgeries, each a different
   *  way a hand could try to empty escrow without the pair 134 asks for. The trigger order matters and
   *  is the register's own: `money_escrow_holds_two_seats` runs before `money_escrow_plan_kept` and
   *  before the wallet guard, because the trigger names sort that way — so a discharge that carries no
   *  signature is answered by the seat rule even when the same statement also breaks the plan rule.
   *  The fourth forgery has to be reached with a signature that has already been released and claimed:
   *  the seat rule asks about the register's state first, and only a spent approval gets as far as the
   *  question of whether the bytes still say what the row does. */
  const SIGN = "Signed against the receipt the clearing agent sent.";
  const aFake = (await one(`insert into platform_approvals (id, action, target_kind, target_id,
        payload, payload_sha256, reason, status, proposed_by, decided_by, decided_at, expires_at)
      values (gen_random_uuid(), 'money.payout', 'escrow_hold', $1::text, '{}',
        repeat('0', 64), 'A signature for a different kind of paper.', 'approved', $2, $3, now(),
        now() + interval '7 days') returning id`, [HCF, PEN, ASH])).id as string;
  await fails("escrow money cannot leave under a signature cut for some other act",
    `update money_escrow_holds set approval_id = $2::uuid, status = 'discharged',
        discharged_by = $3::uuid, discharged_at = now(), discharge_posting_id = $4::uuid
       where id = $1::uuid`, [HCF, aFake, ASH, String(H_BK?.posting?.id)],
    "cannot leave escrow without a second seat");
  await fails("…nor under a signature that was never asked for at all",
    `update money_escrow_holds set status = 'discharged', discharged_by = $2::uuid,
        discharged_at = now() where id = $1::uuid`, [HCF, ASH],
    "cannot leave escrow without a second seat");
  await fails("…nor under the signature a second seat refused",
    `update money_escrow_holds set status = 'discharged', discharged_by = $2::uuid,
        discharged_at = now() where id = $1::uuid`, [HCL, QUILL],
    "cannot leave escrow without a second seat");
  check("…which is the seat rule answering all three, and it answers before the paper's own figures "
    + "are looked at: a `pending_discharge` row whose approval is still waiting has no signature to "
    + "release it, whatever else is wrong with the statement",
    (await row("money_escrow_holds", HCL)).status === "pending_discharge"
    && (await row("money_escrow_holds", HCF)).status === "held", await row("money_escrow_holds", HCL));
  /** 121's order, run without 134's effect door in the middle: sign, then claim. The register ends "
   *  `applied` while the paper still waits, which is the honest shape of the pair — only the effect
   *  books money, so a signature spent without its effect is a burned signature, not a phantom payment. */
  await call("so the second plan on the call is signed by a seat that did not ask for it", DECIDE_SQL,
    [A2, "approve", SIGN, QUILL, "finance_officer", "127.0.0.1", "gate"]);
  const claimed = await call("…and claimed by the seat that signed it", CLAIM_SQL, [A2, QUILL]);
  check("…which leaves the signature spent on Approvals while the escrow paper has moved nothing",
    claimed?.status === "ok" && claimed?.action === "money.escrow"
    && (await row("money_escrow_holds", HCL)).status
    === "pending_discharge" && (await row("money_escrow_holds", HCL)).discharge_posting_id === null,
    { claimed, hold: await row("money_escrow_holds", HCL) });
  const ap2Signed = await apRow(A2);
  const hashAgrees = async (id: string) => (await one(`select (encode(extensions.digest(
      payload::text, 'sha256'), 'hex') = payload_sha256) as agrees from platform_approvals
      where id = $1::uuid`, [id])).agrees as boolean;
  check("…and the bytes the hash was taken of still agree with the signature as it was written",
    ap2Signed.status === "applied" && String(ap2Signed.decided_by) === QUILL
    && await hashAgrees(A2), { status: ap2Signed.status, agrees: await hashAgrees(A2) });
  await okDo("…and a hand *can* change those bytes: `platform_approvals` carries no trigger of its "
    + "own, which is precisely why 134 re-reads them before it lets money out",
    `update platform_approvals set payload = jsonb_set(payload, '{to_payee}', to_jsonb('1.00'::text))
       where id = $1::uuid`, [A2]);
  await fails("…caught before the money moves, in the words that say the plan the desk is "
    + "releasing is not the plan anybody signed",
    `update money_escrow_holds set status = 'discharged', discharged_by = $2::uuid,
        discharged_at = now() where id = $1::uuid`, [HCL, QUILL], "was signed for a different plan");
  const ap2 = await apRow(A2);
  check("…and the signature the desk is left with is the edited one: still `applied`, its hash still "
    + "naming the bytes it no longer carries, and its own paper untouched",
    ap2.status === "applied" && ap2.payload?.to_payee === "1.00"
    && ap2.payload_sha256 === ap2Signed.payload_sha256 && !(await hashAgrees(A2))
    && (await row("money_escrow_holds", HCL)).to_payee === "25000.00"
    && (await row("money_escrow_holds", HCL)).discharge_posting_id === null,
    { now: ap2.payload, hash: ap2.payload_sha256, was: ap2Signed.payload_sha256 });
  await okDo("…so the payload is put back exactly as the door wrote it, since a doctored signature is "
    + "not one the office can spend",
    `update platform_approvals set payload = $2::jsonb where id = $1::uuid`,
    [A2, ap2Signed.payload]);
  check("…and the hash agrees with the paper again", await hashAgrees(A2), await apRow(A2));
  await okDo("…and the hand-made signature for another act is taken off the register again",
    `delete from platform_approvals where id = $1::uuid`, [aFake]);
  check("…leaving the two real escrow signatures on the paper it was planned over, and nothing else "
    + "in the register that is not the office's own",
    await planN(HCL) === 2 && !(await one(`select count(*)::int as n from platform_approvals
      where id = $1::uuid`, [aFake])).n, await planN(HCL));

  /** The spend, walked. 121's order — decide, claim, apply, settle — with 134's own effect door in the
   *  middle. Every one of the seven discharges below is a movement the office has to be able to
   *  explain line by line, so the proof is the legs, not the answer. */
  const feeT = await acc("FEE-INCOME", PLAT);
  const feeU = await acc("FEE-INCOME-USD", PLAT);
  const legOf = (legs: Book[], side: string, code: string) =>
    legs.find((l) => l.side === side && String(l.code) === code);
  /** One discharge, and everything it is answerable for: the four figures, the movement it booked,
   *  every leg by line and direction, the balances it moved, and the state the paper is left in.
   *  `want` is the shape this plan was signed for, which decides how many legs the book must carry —
   *  `money_leg` drops a zero figure, so a refund is two lines and a split with a cut is four. */
  const legsAll = async (postingId: string) => (await oi(`select a.code, lower(e.direction) as side,
         e.amount, e.detail
      from money_entries e join money_accounts a on a.id = e.account_id
      where e.posting_id = $1::uuid order by a.code, lower(e.direction)`,
    [postingId])).rows as Book[];
  const discharge = async (what: string, approval: string, seat: string, holdId: string,
    ref: string, kind: string, to: number, back: number, fee: number, cur: string,
    escCode: string, lines: [string, number, string, string][]) => {
    const escId = String((await acc(escCode, PLAT)).id);
    const before = Number((await accFig(escId)).cached);
    const w = await walk(what, approval, seat, APPLY_E, SIGN);
    const e = w?.effect;
    check(`${what} — the effect door answered with the paper, the four figures and the movement`,
      e?.ok === true && e?.ref === ref && e?.discharge_kind === kind
      && Number(e?.to_payee) === to && Number(e?.back_to_payer) === back
      && Number(e?.fee_amount) === fee && e?.currency === cur
      && /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(e?.posting?.ref))
      && Number(e?.posting?.total) === to + back + fee, e);
    const post = (await one(`select id, ref, memo, source_kind, source_id, source_ref, currency,
        (posted_on = current_date) as today, raised_by, status from money_postings where id = $1::uuid`,
      [String(e?.posting?.id)])) as Book;
    check("…the movement is filed under the paper it discharges, quoted with its number, and written "
      + "with the sentence 134 builds out of the signature itself — the kind the plan was signed as "
      + "and the plan note, not the note the second seat typed",
      post.source_kind === "escrow" && String(post.source_id) === holdId
      && String(post.source_ref) === ref && post.currency === cur && post.status === "posted"
      && String(post.memo) === `Escrow ${ref} ${kind} — ${PLAN}`.slice(0, 200)
      && String(post.raised_by) === seat && post.today === true, post);
    const legs = await legsAll(String(post.id));
    check(`…and it carries exactly ${lines.length} legs: ${lines.map((l) => `${l[2]} ${l[1]} on `
      + `${l[0]}`).join(", ")}, with the escrow line debited by the whole figure and nothing dropped `
      + "or doubled",
      legs.length === lines.length
      && Number(legOf(legs, "debit", escCode)?.amount) === to + back + fee
      && lines.filter((l) => l[0] === escCode).length === 1
      && legs.filter((l) => String(l.code) === escCode).length === 1
      && lines.every(([code, amt, side]) => Number(legOf(legs, side, code)?.amount) === amt), legs);
    check("…each leg carrying the sentence the door wrote for it, so a line in the book says which "
      + "paper it belongs to without a desk retyping the plan",
      lines.every(([code, , side, detail]) => String(legOf(legs, side, code)?.detail) === detail),
      legs.map((l) => `${l.side} ${l.code}: ${l.detail}`));
    const h = await row("money_escrow_holds", holdId);
    check("…the paper now reads discharged, with the movement on it and the seat that spent the "
      + "signature named as the one that let the money out",
      h.status === "discharged" && String(h.discharge_posting_id) === String(post.id)
      && String(h.discharged_by) === seat && !!h.discharged_at
      && String(h.approval_id) === approval, h);
    check(`…and the escrow line came down by the whole figure on both the book's own sum and the `
      + "cached column the board prints",
      Number((await accFig(escId)).cached) === before - (to + back + fee),
      { before, after: await accFig(escId) });
    const ap = await apRow(approval);
    check("…the signature is spent, stamped with the seat that spent it, and carries the movement "
      + "it bought in its own `result`",
      ap.status === "applied" && String(ap.decided_by) === seat && !!ap.applied_at
      && String(ap.result?.via) === "verify-money-moves-sql", ap);
    return { e, post, legs };
  };

  const ESC = "ESCROW-TZS";
  const W_A = await codeOf(WAL_A_LINE);
  const W_B = await codeOf(WAL_B_LINE);
  const W_S = await codeOf(WAL_S_LINE);
  const W_U = await codeOf(WAL_U_LINE);
  /** The split with a cut: 90 000 to the shipper who was kept waiting, 40 000 back to the holder, 20
   *  000 the office keeps. Four lines, and the fourth only exists because the figure above zero was
   *  signed — `money_leg` drops a zero leg rather than booking a line for nothing. */
  const PA_BK = await propose("the office plans a split of the 150 000 held against the booking",
    HBK, "split", 90000, 40000, 20000, WAL_S, PLAN, QUILL);
  check("…asked of a second seat by the one who did not raise it, since the paper already carries a "
    + "pen from the desk that parked the money", PA_BK?.ok === true
    && (await apRow(String(PA_BK?.approval_id))).proposed_by === QUILL, PA_BK);
  /** The rule 134 asks that a card does not: the seat that signs may be neither the seat that
   *  released the signature nor the seat that parked the money in the first place. PEN raised this
   *  paper, so PEN cannot be the one who lets the money out — and because 121 will not let a proposal
   *  be signed by the hand that raised it, QUILL had to be the one to ask. */
  const wSelf = await walk("the seat that parked the money cannot be the seat that signs its "
    + "discharge", String(PA_BK?.approval_id), PEN, APPLY_E, SIGN, [], PEN,
    "cannot leave escrow without a second seat");
  check("…and the raise unwinds the whole signature, so nothing is half-spent: the plan still stands, "
    + "the approval is still pending and no movement was written",
    wSelf !== null && (await apRow(String(PA_BK?.approval_id))).status === "pending"
    && (await row("money_escrow_holds", HBK)).status === "pending_discharge"
    && (await row("money_escrow_holds", HBK)).discharge_posting_id === null, wSelf);
  const D_BK = await discharge("the split walks out on a third seat's signature",
    String(PA_BK?.approval_id), ASH, HBK, String(H_BK?.hold?.ref), "split", 90000, 40000, 20000,
    "TZS", ESC, [[ESC, 150000, "debit", `Escrow ${H_BK?.hold?.ref} discharged`],
      [W_S, 90000, "credit", `To ${S_NAME} from escrow ${H_BK?.hold?.ref}`],
      [W_A, 40000, "credit", `Back to the payer of ${H_BK?.hold?.ref}`],
      ["FEE-INCOME", 20000, "credit", `Office cut on ${H_BK?.hold?.ref}`]]);
  check("…the two holders' balances and the office's income moved by exactly their legs, on the "
    + "wallet's own sum and the line's cached column alike",
    Number(await walletBal(WAL_S!)) === 280000 && Number((await accFig(WAL_S_LINE)).cached) === 280000
    && Number(await walletBal(WAL_A!)) === 565000 && Number((await accFig(WAL_A_LINE)).cached) === 565000
    && Number((await accFig(String(feeT.id))).cached) === 20000,
    { s: await walletBal(WAL_S!), a: await walletBal(WAL_A!), fee: await accFig(String(feeT.id)) });
  check("…the four legs each carrying the sentence the door wrote for them, so a line in the book "
    + "says which paper it belongs to without a desk retyping the plan",
    D_BK.legs.every((l) => String(l.detail ?? "").length >= 3)
    && String(D_BK.e?.posting?.ref) === String(D_BK.post?.ref), D_BK.legs);
  /** A discharged paper is a finished piece of work: 134 answers an edit with "answered by a fresh
   *  movement", and the register's own delete guard answers an erasure with the same sentence it uses
   *  for a hold that has parked money. */
  await fails("a discharged paper cannot be edited — the money that left is answered by a new "
    + "movement, not by a rewrite",
    `update money_escrow_holds set reason = 'A different sentence for a finished paper.'
       where id = $1::uuid`, [HBK], "stays discharged");
  await fails("…nor deleted off the register, because the book carries a movement under it",
    `delete from money_escrow_holds where id = $1::uuid`, [HBK], "never by deleting the paper");
  const spentTwice = await refuses("a signature that has bought its movement cannot be spent a second time",
    APPLY_E, [String(PA_BK?.approval_id), ASH, SEAT_ROLE, "127.0.0.1"], "conflict");
  check("…and the second ask says which of the two it found already done and names its own paper, "
    + "rather than booking the money out twice", /already discharged/.test(String(spentTwice?.message))
    && spentTwice?.ref === H_BK?.hold?.ref, spentTwice);
  /** One signature buys one discharge. The register keeps it as a partial unique index rather than as
   *  a rule a door could forget: a second paper pointed at the approval that already emptied a hold
   *  would be a second movement sold as the first. */
  await fails("a hand cannot point a second paper at a signature that has already been spent",
    `update money_escrow_holds set approval_id = $2::uuid where id = $1::uuid`,
    [HCF, String(PA_BK?.approval_id)], "money_escrow_one_approval", "23505");
  check("…and the shipper's paper is still the unplanned hold it was, with nothing pointed at the "
    + "booking's spent signature",
    ((await one(`select approval_id, status from money_escrow_holds where id = $1::uuid`,
      [HCF])) as Book).approval_id === null, await row("money_escrow_holds", HCF));

  /** The seven-days trap. A signature is asked for on one day and spent on another, and between those
   *  two moments a desk can stop a wallet. 134 re-reads both sides before it books anything, because
   *  133's own leg guard would otherwise refuse the movement at commit — after the paper had already
   *  been stamped. Both refusals are answers, not raises, so the signature is still spendable once the
   *  office opens the balance back. */
  const PA_DP = await propose("the office plans to release 25 000 of the dispute's 40 000 and keep "
    + "15 000 as its own cut", HDP, "released", 25000, 0, 15000, WAL_A, PLAN, QUILL);
  await call("the office stops the payee's balance while the plan waits", FREEZE_W,
    [PLAT, WAL_A, STOP, QUILL, true, SEAT_ROLE, "127.0.0.1", "gate"]);
  const wFrz = await walk("a plan whose payee has been stopped cannot be spent",
    String(PA_DP?.approval_id), ASH, APPLY_E, SIGN, [], ASH);
  check("…and 134 re-reads the wallet before it books, naming whose balance was stopped and the "
    + "sentence the stop was written with",
    wFrz?.effect?.ok === false && wFrz?.effect?.error === "payee_frozen"
    && wFrz?.effect?.holder === HOLDER_A_NAME && String(wFrz?.effect?.reason) === STOP, wFrz?.effect);
  const dpFrz = await refuse("a plan with a released signature on it is not refused from the escrow "
    + "desk", HDP, REFUSE, INK);
  check("…because the signature is already spent on Approvals, and the door says which state it is "
    + "in rather than letting a desk mark a signed plan as refused",
    dpFrz?.ok === false && dpFrz?.error === "conflict" && dpFrz?.approval_status === "applied"
    && /not refused from here/.test(String(dpFrz?.message)), dpFrz);
  await call("…so the office opens the payee's balance again", FREEZE_W,
    [PLAT, WAL_A, "", QUILL, false, SEAT_ROLE, "127.0.0.1", "gate"]);
  await call("…and stops the payer's, to ask the same question of the other side", FREEZE_W,
    [PLAT, WAL_B, STOP, QUILL, true, SEAT_ROLE, "127.0.0.1", "gate"]);
  const wPay = await call("…which a released plan answers even though nothing in it goes back to the "
    + "payer, because the holder whose money was parked is still the one the office took it from",
    APPLY_E, [String(PA_DP?.approval_id), ASH, "finance_officer", "127.0.0.1"]);
  check("…with its own refusal, its own words and the sentence that tells the desk what to do next",
    wPay?.ok === false && wPay?.error === "payer_frozen" && /Re-plan the hold/.test(
      String(wPay?.message)), wPay);
  await call("…so the office opens that balance too", FREEZE_W,
    [PLAT, WAL_B, "", QUILL, false, SEAT_ROLE, "127.0.0.1", "gate"]);
  const D_DP = await discharge("and the release walks out with the office's cut",
    String(PA_DP?.approval_id), ASH, HDP, String(H_DP?.hold?.ref), "released", 25000, 0, 15000,
    "TZS", ESC, [[ESC, 40000, "debit", `Escrow ${H_DP?.hold?.ref} discharged`],
      [W_A, 25000, "credit", `To ${HOLDER_A_NAME} from escrow ${H_DP?.hold?.ref}`],
      ["FEE-INCOME", 15000, "credit", `Office cut on ${H_DP?.hold?.ref}`]]);
  check("…three legs, because a released plan sends nothing back to the payer and `money_leg` will "
    + "not book a line for zero", D_DP.legs.length === 3, D_DP.legs);
  check("…and the holder whose paper the money was parked against keeps exactly what the hold left "
    + "them with — the release went to the other side of the argument",
    Number(await walletBal(WAL_B!)) === 640000 && Number(await walletBal(WAL_A!)) === 590000
    && Number((await accFig(String(feeT.id))).cached) === 35000,
    { b: await walletBal(WAL_B!), a: await walletBal(WAL_A!), fee: await accFig(String(feeT.id)) });

  /** The call the office planned twice: its first signature was refused and its second — the release of
   *  the whole 25 000 to the second holder, asked by the desk that raised the money — is the one that
   *  stands. This is therefore the discharge of a paper that had already been said no to once, spent by
   *  a third seat that had refused nothing. */
  const D_CL = await discharge("the call's second plan is spent by the seat that signed it",
    A2, QUILL, HCL, String(H_CALL?.hold?.ref), "released", 25000, 0, 0,
    "TZS", ESC, [[ESC, 25000, "debit", `Escrow ${H_CALL?.hold?.ref} discharged`],
      [W_B, 25000, "credit", `To ${B_NAME} from escrow ${H_CALL?.hold?.ref}`]]);
  check("…two legs and no income line, because the office kept nothing of a release that named no fee",
    D_CL.legs.length === 2 && !D_CL.legs.some((l) => String(l.code).startsWith("FEE-INCOME"))
    && Number(await walletBal(WAL_B!)) === 665000, D_CL.legs);
  const cdDetail = await call("the discharged paper read back through the office's own detail",
    E_DETAIL, [PLAT, HCL]);
  /** One read of the paper, split into the four things a desk can be asked about it, because the
   *  detail is flat — `to_jsonb(h)` with the seven extra keys built beside it, which is how the same
   *  read is asserted on an undischarged hold above. Each line says what it expected and what the
   *  door answered, so a disagreement names the half it is about. */
  check("…prints the plan it kept: the paper reads discharged, the discharge is a release, and the "
    + "three sides of it are the whole figure the money was parked for",
    cdDetail?.status === "discharged" && cdDetail?.discharge_kind === "released"
    && Number(cdDetail?.to_payee) === 25000 && Number(cdDetail?.back_to_payer) === 0
    && Number(cdDetail?.fee_amount) === 0 && Number(cdDetail?.plan_total) === 25000
    && cdDetail?.plan_agrees === true,
    { want: { status: "discharged", discharge_kind: "released", to_payee: 25000, back_to_payer: 0,
        fee_amount: 0, plan_total: 25000, plan_agrees: true },
      got: { status: cdDetail?.status, discharge_kind: cdDetail?.discharge_kind,
        to_payee: cdDetail?.to_payee, back_to_payer: cdDetail?.back_to_payer,
        fee_amount: cdDetail?.fee_amount, plan_total: cdDetail?.plan_total,
        plan_agrees: cdDetail?.plan_agrees, amount: cdDetail?.amount } });
  check("…and the movement it bought: the payee's balance and the holder it belongs to, read as the "
    + "book stands when the paper is opened rather than as the hold remembers it",
    String(cdDetail?.payee_wallet?.id) === WAL_B && cdDetail?.payee_wallet?.holder === B_NAME
    && Number(cdDetail?.payee_wallet?.balance) === 665000,
    { want: { id: WAL_B, holder: B_NAME, balance: 665000 }, got: cdDetail?.payee_wallet });
  check("…with both movements printed beside it, the one that parked the money and the one that let "
    + "it out, each carrying the legs the door booked",
    String(cdDetail?.discharge_posting?.ref) === String(D_CL.post?.ref)
    && cdDetail?.discharge_posting?.legs?.length === 2
    && cdDetail?.hold_posting?.legs?.length === 2,
    { want: { discharge: D_CL.post?.ref, discharge_legs: 2, hold_legs: 2 },
      got: { discharge: cdDetail?.discharge_posting?.ref,
        discharge_legs: cdDetail?.discharge_posting?.legs?.length,
        hold: cdDetail?.hold_posting?.ref, hold_legs: cdDetail?.hold_posting?.legs?.length,
        hold_error: cdDetail?.hold_posting?.error } });
  check("…and the signature still standing under it, spent rather than merely given",
    String(cdDetail?.approval?.status) === "applied",
    { want: "applied", got: cdDetail?.approval?.status, approval: cdDetail?.approval });
  check("…and the detail keeps the refusal visible — who said no, when and in what words — beside the "
    + "seat that finally let the money out, so one read of the paper tells the whole exchange",
    String(cdDetail?.refused_by_name) === SEAT("Quill") && String(cdDetail?.refused_note) === REFUSE
    && !!cdDetail?.refused_at && Number(cdDetail?.refusals) === 1
    && String(cdDetail?.discharged_by_name) === SEAT("Quill")
    && String(cdDetail?.raised_by_name) === SEAT("Pen"), { refused: cdDetail?.refused_by_name,
      discharged: cdDetail?.discharged_by_name, refusals: cdDetail?.refusals });

  /** Two refunds, and the two ways a hold can have been paid for. The second holder's call goes back to
   *  the wallet it came from; the paper the office fronted from its own till goes back to that till.
   *  Neither names a payee, so each is a pair of lines and nothing else — and the second is the proof
   *  that a hold with no payer wallet is not stranded: `v_back` falls to `from_account_id`. */
  const PA_NO = await propose("the office plans to refund the 20 000 held against the call that names "
    + "no company", HNO, "refunded", 0, 20000, 0, null, PLAN, PEN);
  const D_NO = await discharge("and the refund goes back to the balance it was parked out of",
    String(PA_NO?.approval_id), ASH, HNO, String(H_NOC?.hold?.ref), "refunded", 0, 20000, 0,
    "TZS", ESC, [[ESC, 20000, "debit", `Escrow ${H_NOC?.hold?.ref} discharged`],
      [W_B, 20000, "credit", `Back to the payer of ${H_NOC?.hold?.ref}`]]);
  check("…two legs, because a refund cannot name a payee and `v_payee` is the empty record — the "
    + "credit that would have gone to it is dropped by the figure, not by a special case",
    D_NO.legs.length === 2 && Number(await walletBal(WAL_B!)) === 685000, D_NO.legs);
  const OPS = await acc("OPS-CASH", PLAT);
  const opsBefore = Number((await accFig(String(OPS.id))).cached);
  const PA_CA = await propose("…and the office plans to take its own 30 000 back out of escrow",
    HCA, "refunded", 0, 30000, 0, null, PLAN, QUILL);
  const D_CA = await discharge("the till's refund walks back to the till",
    String(PA_CA?.approval_id), ASH, HCA, String(H_CASH?.hold?.ref), "refunded", 0, 30000, 0,
    "TZS", ESC, [[ESC, 30000, "debit", `Escrow ${H_CASH?.hold?.ref} discharged`],
      ["OPS-CASH", 30000, "credit", `Back to the payer of ${H_CASH?.hold?.ref}`]]);
  check("…with the till's own line as the destination, derived from the paper rather than typed by a "
    + "desk, and the money the office fronted standing back where it started",
    D_CA.legs.length === 2 && Number((await accFig(String(OPS.id))).cached) === opsBefore + 30000,
    { legs: D_CA.legs, before: opsBefore, after: await accFig(String(OPS.id)) });

  /** The two dollar papers. 134 parks shillings and dollars on separate lines and never lets one paper
   *  cross them, so the dollar discharges are the ones that prove the office's income has two lines:
   *  `FEE-INCOME-USD` exists only because a cut signed in dollars cannot be booked into a TZS income
   *  line. Holder B needs a dollar balance to be paid into, since a release cannot go back to the
   *  wallet the money came from. */
  const WAL_BUSD = await openWallet("the second holder is owed dollars, so the office opens them a "
    + "dollar balance", holderB, "USD", "The dollar line the second holder keeps with us.");
  const WAL_BUSD_LINE = String((await row("money_wallets", WAL_BUSD!)).account_id);
  const W_BU = await codeOf(WAL_BUSD_LINE);
  const ESCU = "ESCROW-USD";
  const PA_U1 = await propose("the office plans to release 75 of the 100 dollars and keep 25 as its "
    + "dollar cut", HU1, "released", 75, 0, 25, WAL_BUSD, PLAN, QUILL);
  const D_U1 = await discharge("and the dollar release walks onto the dollar income line",
    String(PA_U1?.approval_id), ASH, HU1, String(H_USD?.hold?.ref), "released", 75, 0, 25,
    "USD", ESCU, [[ESCU, 100, "debit", `Escrow ${H_USD?.hold?.ref} discharged`],
      [W_BU, 75, "credit", `To ${B_NAME} from escrow ${H_USD?.hold?.ref}`],
      ["FEE-INCOME-USD", 25, "credit", `Office cut on ${H_USD?.hold?.ref}`]]);
  check("…and the office's dollar income is its own line, not a figure added to the shilling one: "
    + "25 dollars there, 35 000 shillings here",
    Number((await accFig(String(feeU.id))).cached) === 25
    && Number((await accFig(String(feeT.id))).cached) === 35000
    && Number(await walletBal(WAL_BUSD!)) === 75 && Number(await walletBal(WAL_AUSD!)) === 375,
    { usd: await accFig(String(feeU.id)), tzS: await accFig(String(feeT.id)) });
  const PA_U2 = await propose("…and the second dollar paper is released whole to the same balance",
    HU2, "released", 25, 0, 0, WAL_BUSD, PLAN, PEN);
  const D_U2 = await discharge("the last dollar leaves escrow with no fee beside it",
    String(PA_U2?.approval_id), ASH, HU2, String(H_USD2?.hold?.ref), "released", 25, 0, 0,
    "USD", ESCU, [[ESCU, 25, "debit", `Escrow ${H_USD2?.hold?.ref} discharged`],
      [W_BU, 25, "credit", `To ${B_NAME} from escrow ${H_USD2?.hold?.ref}`]]);
  check("…and the dollar escrow line is now empty on both readings, with nothing left on it that the "
    + "book cannot name a finished paper for",
    Number((await accFig(String(ESC_U.id))).cached) === 0
    && Number((await accFig(String(ESC_U.id))).legs) === 4
    && Number(await walletBal(WAL_BUSD!)) === 100 && Number(await walletBal(WAL_AUSD!)) === 375,
    { usd: await accFig(String(ESC_U.id)), busd: await walletBal(WAL_BUSD!) });

  /** Seven of the eight papers have now left escrow. The eighth is the one this gate deliberately
   *  leaves standing, because a board with nothing live on it proves the empty case and nothing else. */
  const left = (await oi(`select status, count(*)::int as n,
        coalesce(sum(amount), 0)::numeric(14,2) as money
      from money_escrow_holds where tenant_id = $1::uuid group by status`, [PLAT])).rows as Book[];
  check("seven papers have been discharged and one still waits, and the money that waits is the "
    + "shipper's 60 000 against the demurrage file — nothing else in the book is parked",
    left.some((r) => r.status === "discharged" && r.n === 7)
    && left.some((r) => r.status === "held" && r.n === 1 && Number(r.money) === 60000)
    && !left.some((r) => r.status === "pending_discharge") && !left.some((r) => r.status === "raised"),
    left);
  check("…and every discharged paper was discharged by a seat that is neither the one that raised it "
    + "nor the one that asked for the signature, which is the whole rule stated as a row count",
    (await one(`select count(*)::int as n from money_escrow_holds where tenant_id = $1::uuid
        and status = 'discharged' and (discharged_by = raised_by
          or discharged_by = (select a.proposed_by from platform_approvals a
                               where a.id = money_escrow_holds.approval_id))`, [PLAT])).n === 0,
    (await one(`select count(*)::int as n from money_escrow_holds where tenant_id = $1::uuid
      and status = 'discharged'`, [PLAT])).n);
  const sq7 = await square();
  check("with seven discharges booked, the book still answers that it balances with itself — the "
    + "escrow line is debited by exactly what the plans were signed for, in every money",
    sq7?.square === true && Number(sq7?.unbalanced) === 0 && Number(sq7?.short_legged) === 0
    && Number(sq7?.figure_disagrees) === 0, sq7);
  const pay7 = await payable();
  const esc7 = (pay7?.rows ?? []).filter((r: Book) => String(r.account).startsWith("ESCROW"));
  check("…and the liabilities board now reads 60 000 shillings parked on one paper against the "
    + "shilling escrow line and nothing on the dollar one, each figure agreeing with its own legs",
    esc7.length === 2 && esc7.some((r) => r.account === ESC && Number(r.book) === 60000
      && Number(r.papers) === 60000 && r.papers_n === 1 && r.disagrees === false)
    && esc7.some((r) => r.account === ESCU && Number(r.book) === 0 && Number(r.papers) === 0
      && r.papers_n === 0 && r.disagrees === false), esc7);
  check("…the board has grown by the one line the office opened — thirteen liability lines, no drift "
    + "and no disagreement anywhere",
    pay7?.square === true && Number(pay7?.accounts) === 13 && Number(pay7?.drift) === 0
    && Number(pay7?.disagrees) === 0, { accounts: pay7?.accounts, drift: pay7?.drift,
      disagrees: pay7?.disagrees });
  const held7 = (pay7?.held ?? []) as Book[];
  check("…and the money the office owes its holders has risen by exactly the seven figures that left "
    + "escrow and went back into balances: 1 595 000 shillings over five, 475 dollars over two",
    held7.some((h) => h.currency === "TZS" && Number(h.held) === 1595000 && h.wallets === 5)
    && held7.some((h) => h.currency === "USD" && Number(h.held) === 475 && h.wallets === 2), held7);
  note("phase 7 spent the whole of the escrow the office had parked except the shipper's 60 000: seven "
    + "signatures, seven movements, twenty-one legs — a split with a cut, a release with a cut, a "
    + "release refused and then agreed, two refunds (one to a holder's line, one back to the office's "
    + "own till) and two dollar papers that paid into a balance the gate had to open for the purpose. "
    + "Every one of them was signed by a seat that had neither raised the paper nor asked for the "
    + "signature, and the only way any of them could be spent twice was through a register row this "
    + "gate could edit but 134 re-reads.");

  // ---------------- 8 · who the office pays, and what a rail demands of them ----------------
  phase("8 · a payout is aimed at a company, a driver, a staff member or a name the desk types, and "
    + "the rail decides what the payee's line has to be");
  /** The two registers 134 reads a payee out of. A driver belongs to a transporter and a staff member
   *  to any company, so both are filed under holder A's book and the guard copies each one's own
   *  company onto the paper — which is the half of the pair this file found broken in 134 and fixed:
   *  the row's own CHECK used to insist that a payee with a company on it must be *a company*, so every
   *  payout to a person aborted on a constraint about a kind nobody had typed. */
  const DRIVER_NAME = BOOK("Driver One");
  const STAFF_NAME = BOOK("Staff One");
  const driver = (await one(`insert into drivers (tenant_id, full_name, status)
    values ($1, $2, 'available') returning id`, [holderA, DRIVER_NAME])).id as string;
  const driverGone = (await one(`insert into drivers (tenant_id, full_name, status, deleted_at)
    values ($1, $2, 'available', now()) returning id`, [holderA, BOOK("Driver Closed")]))
    .id as string;
  const staff = (await one(`insert into employees (tenant_id, full_name, employment_type, status)
    values ($1, $2, 'permanent', 'active') returning id`, [holderA, STAFF_NAME])).id as string;
  const staffGone = (await one(`insert into employees (tenant_id, full_name, employment_type, status,
      deleted_at) values ($1, $2, 'permanent', 'active', now()) returning id`,
    [holderA, BOOK("Staff Left")])).id as string;
  const payee = async (kind: string, search: string) => (await call(
    `money_payees looks for a ${kind} called ${search}`, PAYEES, [PLAT, kind, search, 25])) as Book;
  const findRow = (board: Book | null, id: string) =>
    ((board?.rows ?? []) as Book[]).find((r) => String(r.id) === id) ?? null;
  /** The read is the desk's only way of knowing what the door will accept, so each of its two flags is
   *  asserted against the door it mirrors rather than against the comment that describes it: `can_pay`
   *  against `raise_money_payout`, `can_wallet` against `open_money_wallet`. */
  const pComp = findRow(await payee("company", "Holder B"), holderB);
  check("the office finds the second holder as a company to pay, and the read calls it payable at the "
    + "same moment the door would accept it", !!pComp && pComp.can_pay === true
    && pComp.can_wallet === true && String(pComp.company_tenant_id) === holderB
    && pComp.archived === false && String(pComp.name) === BOOK("Holder B"), pComp);
  const pDrv = findRow(await payee("driver", DRIVER_NAME.slice(0, 30)), driver);
  const pStaff = findRow(await payee("staff", STAFF_NAME.slice(0, 30)), staff);
  check("…a driver and a staff member are both payable, neither is holdable, and the company printed "
    + "beside each is the book they are filed in rather than the office's",
    !!pDrv && !!pStaff && [pDrv, pStaff].every((r) => r.can_pay === true
      && r.can_wallet === false && String(r.company_tenant_id) === holderA
      && String(r.company) === BOOK("Holder A"))
    && pDrv.kind === "driver" && pStaff.kind === "staff", { drv: pDrv, staff: pStaff });
  const pGoneDrv = findRow(await payee("driver", "Driver Closed"), driverGone);
  const pGoneStaff = findRow(await payee("staff", "Staff Left"), staffGone);
  check("…a person the office has struck off its own register still reads payable and is marked "
    + "`deleted` in the detail the desk is shown, because a payout to somebody who has left is a thing "
    + "the office may still owe and must be able to say so",
    [pGoneDrv, pGoneStaff].every((r) => !!r && r.can_pay === true && r.archived === true
      && /deleted/.test(String(r.detail))), { drv: pGoneDrv, staff: pGoneStaff });
  const pGoneCo = findRow(await payee("company", "Gone"), gone);
  check("…and a closed company is offered as payable but never as a holder, which is exactly the pair "
    + "of doors this phase tests beneath: `open_money_wallet` refuses it, `raise_money_payout` does not",
    !!pGoneCo && pGoneCo.can_pay === true && pGoneCo.can_wallet === false
    && pGoneCo.archived === true, pGoneCo);
  /** The office's own name is read rather than typed: the point of the check is that the platform row
   *  is cut out of the picker, and a gate that guessed the word would be searching for nothing. */
  const PLAT_NAME = String((await one(`select name from tenants where id = $1::uuid`, [PLAT])).name);
  const pPLAT = findRow(await payee("company", PLAT_NAME.slice(0, 8)), PLAT);
  check("…the office's own row is not on the list at all, because `money_payees` cuts platform tenants "
    + "out rather than marking them unpayable — the one payee the guard refuses in words is a payee the "
    + "desk is never offered", pPLAT === null, { plat: PLAT, name: PLAT_NAME });
  const badKindWord = await call("a payee search asked for a kind the office does not pay is answered "
    + "rather than listed, with the sentence that names the three registers it reads",
    PAYEES, [PLAT, "person", "Move", 10]);
  check("…and no rows, because a one-word mistake is answered before the register is walked",
    badKindWord?.rows?.length === 0 && badKindWord?.count === 0 && badKindWord?.kind === "person"
    && /a company, a driver or a staff member/i.test(String(badKindWord?.error)), badKindWord);
  const emptyKind = await call("…and a kind left blank is not a refusal but the default, because the "
    + "desk's first picker is companies", PAYEES, [PLAT, "  ", "Holder", 10]);
  check("…which is how a form that has not been touched yet still shows a list",
    emptyKind?.kind === "company" && emptyKind?.error === undefined
    && (emptyKind?.rows ?? []).length > 0, emptyKind);
  const shortSearch = await call("…and a one-letter search is refused as a list of everybody",
    PAYEES, [PLAT, "company", "M", 10]);
  check("…from the subjects read too, which is the other picker on the same desk",
    /Two characters at least/.test(String(shortSearch?.error)), shortSearch);
  const subjCalls = await call("money_subjects prints the calls the office can park money against",
    SUBJECTS, [PLAT, "call", STAMP, 25]);
  check("…each with the ticket's own ref, the company it names and the two words the guard will join "
    + "into the hold's note, and every one of them holdable because a call always has a subject",
    ((subjCalls?.rows ?? []) as Book[]).some((r) => String(r.id) === CALL_MAIN
      && r.ref === T_REF && r.can_hold === true
      && String(r.what) === `${BOOK("Charge disputed")} · ${BOOK("Holder A")}`
      && String(r.company_tenant_id) === holderA), subjCalls?.rows);
  /** The `can_hold` flag is the mirror phase 6 deferred: the guard refuses a job that cannot name the
   *  work it waits on, and a picker that offered one would send the desk to a sentence about a row that
   *  exists. Each register's own emptiness rule is different, so all four kinds are asked. */
  const subjBooks = await call("money_subjects prints the bookings whose labels carry the gate's "
    + "stamp", SUBJECTS, [PLAT, "booking", STAMP, 50]);
  /** A booking whose three labels are all blank carries no word the stamp can find, so the read is
   *  asked for the `BK-` reference it prints for that row — which is also how a desk that already
   *  knows a booking's number reaches it. */
  const bkBlankBoard = await call("…and the booking with no labels at all is found by the reference "
    + "the read itself prints", SUBJECTS, [PLAT, "booking", tail8(BK_BLANK.booking), 50]);
  const bkBlank = findRow(bkBlankBoard, BK_BLANK.booking);
  const bkPart = findRow(subjBooks, BK_PART.booking);
  const bkMain = findRow(subjBooks, BK_MAIN.booking);
  check("…a booking with nothing to say about the job it is holding money for is printed as not "
    + "holdable, which is the same rule `escrow_names_its_subject` enforces in words",
    !!bkBlank && bkBlank.can_hold === false && String(bkBlank.what) === ""
    && bkBlank.ref === tail8(BK_BLANK.booking)
    && (bkBlankBoard?.rows ?? []).length === 1, bkBlank);
  check("…a booking that fills only two of the three labels is holdable and prints the empty one left "
    + "out of its note, exactly as the hold's own guard composes it",
    !!bkPart && bkPart.can_hold === true && String(bkPart.what)
      === `${BOOK("One reefer of fish")} · ${BOOK("Shipper")}`, bkPart);
  check("…and the full booking prints all three joined with the separator, under the `BK-` tail 134 "
    + "mints because 048 gave a booking no number of its own",
    !!bkMain && bkMain.can_hold === true && bkMain.ref === tail8(BK_MAIN.booking)
    && String(bkMain.what) === bkNote, bkMain);
  const subjFiles = await call("…the cargo files, where the pair is the consignee and the description",
    SUBJECTS, [PLAT, "cargo_file", STAMP, 50]);
  const cfBlank = findRow(subjFiles, CF_BLANK);
  check("…a file whose consignee is a space and whose description is null is the second shape the "
    + "guard refuses, and the read calls it unholdable before the desk can type it",
    !!cfBlank && cfBlank.can_hold === false && String(cfBlank.what) === "", cfBlank);
  const subjGone = await call("…and none of the four registers offers a job the office took off its "
    + "board", SUBJECTS, [PLAT, "dispute", STAMP, 50]);
  const subjCalls2 = await call("…the same question asked of the calls board", SUBJECTS,
    [PLAT, "call", STAMP, 50]);
  check("…which is the whole of what `escrow_names_its_subject` asks first: a deleted paper is not a "
    + "job, so a picker that listed one would be a picker that offers a refusal",
    ((subjGone?.rows ?? []) as Book[]).every((r) => String(r.id) !== DP_GONE)
    && ((subjCalls2?.rows ?? []) as Book[]).every((r) => String(r.id) !== CALL_GONE),
    { disputes: subjGone?.rows, calls: subjCalls2?.rows });
  /** The four kinds, through the door. Each is a `manual` cash payout so that nothing but the payee is
   *  being asked, and each answer is read back off the row rather than from the echo. */
  /** Every one of `raise_money_payout`'s 20 arguments is named rather than counted in place, because
   *  the door's shape — a figure sitting three slots from a sealed `bytea` — is the easiest thing in
   *  this file to get wrong and the hardest to see wrong in an output line. A key the call does not
   *  name is passed as null, which is what the door reads as "not typed". */
  const PAYOUT_ARGS = ["payee_kind", "payee_id", "payee_name", "rail_code", "payee_ref_encrypted",
    "payee_ref_tail", "payee_ref_hash", "amount", "fee_amount", "currency", "source_kind",
    "source_id", "source_ref", "purpose", "batch_id"] as const;
  const payoutArgs = (o: Book, seat: string) => [PLAT,
    ...PAYOUT_ARGS.map((k) => o[k] ?? null), seat, "finance_officer", "127.0.0.1", "gate"];
  const raisePayout = (label: string, o: Book, seat = PEN) =>
    call(label, RAISE_P, payoutArgs(o, seat));
  const raiseRefuses = (label: string, o: Book, code: string, seat = PEN) =>
    refuses(label, RAISE_P, payoutArgs(o, seat), code);
  const manual = (o: Book): Book => ({ amount: 20000, fee_amount: 0, currency: "TZS",
    source_kind: "manual", purpose: PURPOSE, rail_code: "cash", ...o });
  /** The row a payout door just wrote, read back. Asked only when the door actually wrote one: a
   *  refusal has no id, and a gate that crashed looking for the missing one would hide the answer it
   *  was meant to print. */
  const payRow = async (r: Book | null) => (r?.ok === true && r?.payout?.id
    ? await row("money_payouts", String(r.payout.id))
    : null) as Book | null;
  const PCO = await raisePayout("the office raises a payout to a company it has on the register",
    manual({ payee_kind: "company", payee_id: holderB }));
  check("…and the paper is printed with the company's own name and its own book, neither typed by the "
    + "seat that raised it", PCO?.ok === true
    && String(PCO?.payout?.payee_name) === BOOK("Holder B")
    && String(PCO?.payout?.payee_tenant_id) === holderB && PCO?.payout?.payee_kind === "company",
    { name: PCO?.payout?.payee_name, tenant: PCO?.payout?.payee_tenant_id });
  const PDR = await raisePayout("…and one to a driver, which is the shape 134's own row CHECK used to "
    + "refuse before this gate met it", manual({ payee_kind: "driver", payee_id: driver }));
  const PST = await raisePayout("…and one to a staff member, for the same reason",
    manual({ payee_kind: "staff", payee_id: staff }));
  const pdrRow = await payRow(PDR);
  const pstRow = await payRow(PST);
  check("…both stand, each carrying the person's own name from the register and the company that "
    + "employs them — a driver's book is not `payee_kind = 'company'` and never was",
    PDR?.ok === true && PST?.ok === true && String(pdrRow?.payee_name) === DRIVER_NAME
    && String(pdrRow?.payee_tenant_id) === holderA && String(pstRow?.payee_name) === STAFF_NAME
    && String(pstRow?.payee_tenant_id) === holderA && pdrRow?.payee_kind === "driver"
    && pstRow?.payee_kind === "staff", { drv: pdrRow, staff: pstRow });
  const PSTR = await raisePayout("…and one to a stranger the desk names itself, on the desk's own cash",
    manual({ payee_kind: "other", payee_name: "Shape Probe Stranger" }));
  const pstrRow = await payRow(PSTR);
  check("…which is the only payee with no book behind it, so the paper keeps no company and the guard "
    + "nulls it rather than leaving whatever was typed", PSTR?.ok === true
    && String(PSTR?.payout?.payee_name) === "Shape Probe Stranger"
    && pstrRow?.payee_tenant_id === null && pstrRow?.payee_kind === "other",
    { tenant: pstrRow?.payee_tenant_id, kind: pstrRow?.payee_kind });
  const pLeftCo = await raisePayout("…the closed company is payable through the door too, which is "
    + "what makes the read's `can_pay` true rather than a promise",
    manual({ payee_kind: "company", payee_id: gone, amount: 15000 }));
  check("…and 134 says nothing about it: the office may owe a company it has closed a refund, and the "
    + "paper is the place that fact is argued, not a door that hides it",
    pLeftCo?.ok === true && String(pLeftCo?.payout?.payee_tenant_id) === gone, pLeftCo);
  const typedId = await raiseRefuses("a stranger the desk also typed an id for is answered, not "
    + "written", manual({ payee_kind: "other", payee_id: holderB, payee_name: "Shape Probe Stranger",
      amount: 10000 }), "payee_not_named");
  check("…by the sentence that tells the desk which of its two choices to drop, because `other` is the "
    + "kind with no register to be from — the second half of the pair fixed alongside the CHECK above",
    /has no paper to point at/.test(String(typedId?.message)), typedId);
  await raiseRefuses("a payee kind outside the four is answered as the vocabulary it is not",
    manual({ payee_kind: "person", payee_name: "A Person", amount: 10000 }), "bad_payee_kind");
  await raiseRefuses("…and a company aimed at nothing is answered the same way a stranger aimed at a "
    + "register row is", manual({ payee_kind: "company", amount: 10000 }), "payee_not_named");
  await raiseRefuses("…a stranger named too briefly for a receipt to carry",
    manual({ payee_kind: "other", payee_name: "X", amount: 10000 }), "bad_payee_name");
  await raiseRefuses("…a figure of nothing, because a payout for zero is a note and not a movement",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), amount: 0 }), "bad_amount");
  await raiseRefuses("…and a cut bigger than the money it rides on",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), amount: 10000, fee_amount: 20000 }),
    "bad_fee");
  await raiseRefuses("…and a purpose too short for the second seat to sign against",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), purpose: "Pay it" }), "bad_purpose");
  /** Now the rails. Each of the three `needs` shapes is asked of both doors, and the account line is
   *  the same 11 digits every time so that only the rail's word can change the answer. */
  const PHONE = Buffer.from("0722" + num(12) + num(15));
  const ACCT = Buffer.from("TZ09" + num(18).repeat(2));
  /** A keyed hash the register will accept: the column and the door both ask for exactly 64 lowercase
   *  hex characters, and this file's own `HEX` is half of that — a run that used it as a payee line
   *  would be stopped by the hash rule and never reach the rail it was meant to test. */
  const HASH64 = HEX + HEX;
  const CASH_LABEL = String((await one(`select label from money_payout_rails where code = 'cash'`)).label);
  await raiseRefuses("a payout aimed at a rail the office does not pay on",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), rail_code: "ekenn", amount: 10000 }),
    "bad_rail");
  const onCash = await raiseRefuses("…the desk's own cash is answered when a number is typed beside "
    + "it, because a payout handed over at a counter has no account to read out",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), amount: 10000,
      payee_ref_encrypted: PHONE, payee_ref_tail: "1111", payee_ref_hash: HASH64 }), "line_on_cash_rail");
  check("…and the answer names the rail in the words a person reads rather than the code a form holds",
    onCash?.rail === CASH_LABEL && /handed over at the desk/.test(String(onCash?.message)), onCash);
  for (const rail of ["mpesa", "bank"]) {
    const lm = await raiseRefuses(`…and a ${rail} payout raised with no payee line at all`,
      manual({ payee_kind: "other", payee_name: BOOK("Stranger"), rail_code: rail, amount: 10000 }),
      "line_missing");
    check(`…with the shape the rail asked for printed in the answer (${rail} pays a number)`,
      lm?.needs === (rail === "bank" ? "account" : "phone"), lm);
  }
  await raiseRefuses("…a payee line whose hash is not 64 lowercase hex is refused as a line that "
    + "cannot be looked up again",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), rail_code: "mpesa", amount: 10000,
      payee_ref_encrypted: PHONE, payee_ref_tail: "1111", payee_ref_hash: "ZZ".repeat(32) }),
    "bad_hash");
  /** The two shapes a desk actually gets wrong: a hash cut to half the length the register asks for,
   *  and a hex string written in capitals. Both are refused before a line is sealed, because a hash
   *  nobody can look up again is a payee line the office can never prove is somebody's. */
  for (const [bad, why] of [
    [HEX, "half the 64 characters a keyed hash is"],
    [HASH64.toUpperCase(), "hex written in capitals"]
  ] as [string, string][]) {
    await raiseRefuses(`…and a hash that is ${why} answers the same way`,
      manual({ payee_kind: "other", payee_name: BOOK("Stranger"), rail_code: "mpesa", amount: 10000,
        payee_ref_encrypted: PHONE, payee_ref_tail: "1111", payee_ref_hash: bad }), "bad_hash");
  }
  const pm = await raisePayout("a mobile-money payout stands, with the whole line sealed and only its "
    + "tail and its keyed hash on the paper",
    manual({ payee_kind: "driver", payee_id: driver, rail_code: "mpesa", amount: 25000,
      fee_amount: 500, payee_ref_encrypted: PHONE, payee_ref_tail: "1111", payee_ref_hash: HASH64 }));
  const pmRow = await payRow(pm);
  check("…the desk is shown the tail and the hash and never the number, and the register holds the "
    + "number only as the ciphertext 134 was given",
    pm?.ok === true && String(pmRow?.payee_ref_tail) === "1111"
    && String(pmRow?.payee_ref_hash) === HASH64
    && Buffer.isBuffer(pmRow?.payee_ref_encrypted)
    && Buffer.compare(pmRow?.payee_ref_encrypted, PHONE) === 0
    && !("payee_ref_encrypted" in (pm?.payout ?? {})),
    { tail: pmRow?.payee_ref_tail, sealed: pm?.payout?.line_sealed,
      keys: Object.keys(pm?.payout ?? {}).filter((k) => /ref|encrypt/.test(k)) });
  const pb = await raisePayout("…and a bank payout is the same rule with the account's shape instead "
    + "of a phone's",
    manual({ payee_kind: "staff", payee_id: staff, rail_code: "bank", amount: 180000,
      payee_ref_encrypted: ACCT, payee_ref_tail: "0042", payee_ref_hash: HASH64 }));
  const pbRow = await payRow(pb);
  check("…which is why the tail column is 1 to 4 characters and the rail decides which of the two "
    + "patterns it has to match", pb?.ok === true
    && String(pbRow?.payee_ref_tail) === "0042" && pbRow?.rail_code === "bank", pbRow);
  /** The same five rules as the guard, met by a hand that skipped the desk. Each insert carries the
   *  three lines the door would have derived, so nothing but the named rule can refuse it. */
  const acct = async (cur: string, sk: string, rail: string, wallet: string | null = null) =>
    (await one(`select platform_auth.money_payout_accounts($1::uuid, $2, $3,
        (select family from money_payout_rails where code = $4), $5::uuid) as r`,
      [PLAT, cur, sk, rail, wallet])).r as Book;
  const INS_P = `insert into money_payouts (tenant_id, ref, batch_id, payee_kind, payee_id,
      payee_name, payee_tenant_id, rail_code, payee_ref_encrypted, payee_ref_tail, payee_ref_hash,
      amount, fee_amount, currency, source_kind, source_id, source_ref, purpose, status,
      fund_account_id, payable_account_id, cash_account_id, raised_by)
    values ($1::uuid, $2, $3::uuid, $4, $5::uuid, $6, $7::uuid, $8, $9::bytea, $10, $11,
      $12::numeric, $13::numeric, $14, $15, $16::uuid, $17, $18, $19, $20::uuid, $21::uuid,
      $22::uuid, $23::uuid) returning id, ref`;
  const nextRef = async (pre: string, seq: string) => String((await one(
    `select $1 || to_char(now(), 'YYYY') || '-' || lpad(nextval($2::regclass)::text, 5, '0') as r`,
    [`${pre}-`, seq])).r);
  /** A paper written by hand. The accounts come from `money_payout_accounts` itself — the gate is not
   *  free to point a payout at a line it invented, and a hand-insert that failed on the wrong rule
   *  would prove nothing. A caller that names all three lines skips the derivation: that is the only
   *  way to reach a *later* guard past one whose own helper raises (a wallet withdrawal against no
   *  wallet has `money_payout_accounts` refuse before the source guard can speak), and the accounts
   *  guard still reads them, so the payout is not free to lie about its lines either. */
  const handArgs = async (over: Book): Promise<any[]> => {
    const cur = String(over.currency ?? "TZS");
    const sk = String(over.source_kind ?? "manual");
    const rail = String(over.rail_code ?? "cash");
    const hand = over.fund_account_id && over.payable_account_id && over.cash_account_id;
    const a = hand
      ? { fund: over.fund_account_id, payable: over.payable_account_id, cash: over.cash_account_id }
      : await acct(cur, sk, rail,
          sk === "wallet_withdrawal" ? (over.source_id as string) ?? null : null);
    return [PLAT, over.ref ?? await nextRef("PAY", "payout_number_seq"),
      over.batch_id ?? null, over.payee_kind ?? "other", over.payee_id ?? null,
      over.payee_name ?? BOOK("Stranger"), over.payee_tenant_id ?? null, rail,
      over.payee_ref_encrypted ?? null, over.payee_ref_tail ?? null, over.payee_ref_hash ?? null,
      over.amount ?? 20000, over.fee_amount ?? 0, cur, sk, over.source_id ?? null,
      over.source_ref ?? null, over.purpose ?? PURPOSE, over.status ?? "raised",
      over.fund_account_id ?? a.fund, over.payable_account_id ?? a.payable,
      over.cash_account_id ?? a.cash, over.raised_by ?? PEN];
  };
  const handP = async (label: string, over: Book = {}, want = "", state = CHECK_VIOLATION) =>
    fails(label, INS_P, await handArgs(over), want, state);
  await handP("the guard refuses a hand that names a company the register does not have",
    { payee_kind: "company", payee_id: NO_BODY, payee_tenant_id: NO_BODY },
    "the office has no company");
  await handP("…or a driver, or a staff member it does not have",
    { payee_kind: "driver", payee_id: NO_BODY, payee_tenant_id: NO_BODY },
    "the office has no driver");
  await handP("…and the sentence is different for each of the three registers it reads",
    { payee_kind: "staff", payee_id: NO_BODY, payee_tenant_id: NO_BODY },
    "the office has no staff member");
  await handP("…and the office itself is refused by name, in the one sentence 134 writes about money "
    + "that does not leave", { payee_kind: "company", payee_id: PLAT, payee_tenant_id: PLAT,
      payee_name: "the office" }, "is the office itself");
  await handP("…and the rule is asked of the row, so a desk cannot file a cash payout with an account "
    + "number on it by hand either", { payee_ref_encrypted: PHONE, payee_ref_tail: "1111",
      payee_ref_hash: HASH64 }, "so this paper must carry no account line");
  await handP("…nor a mobile one without a number", { rail_code: "tigopesa" },
    "needs the payee's number written on it");
  await handP("…nor a bank one", { rail_code: "bank", payee_ref_encrypted: ACCT },
    "needs the payee's account written on it");
  await handP("a phone tail that is not four digits is refused as the tail of something else",
    { rail_code: "airtel", payee_ref_encrypted: PHONE, payee_ref_tail: "AB12",
      payee_ref_hash: HASH64 }, "which is not the tail of a phone number");
  await handP("…and an account tail too long to be a tail at all",
    { rail_code: "bank", payee_ref_encrypted: ACCT, payee_ref_tail: "12345", payee_ref_hash: HASH64 },
    "which is not the tail of an account number");
  /** The rail is a lookup, so a hand can invent one — and `money_payouts` carries no foreign key to
   *  `money_payout_rails` to catch it, which is exactly why the guard asks. */
  await handP("a rail the office has never seeded is refused before anything else about the paper is "
    + "read", { rail_code: "wire" }, "is not a rail the office pays on");
  /** A retired rail is asked last, because the rule only exists once the seed row says so. Nothing in
   *  134 gives the office a door for retiring one — the catalog is the file's own, seeded six and
   *  retired none — so the gate moves the seed row by hand inside the transaction it rolls back, and
   *  reads the answer from both halves of the pair: the board's count, then the guard's sentence. */
  await okDo("the gate retires a rail the way the office would have to, by hand on the seed row",
    `update money_payout_rails set retired = true where code = 'halopesa'`);
  const railsRetired = await call("…and the rails board is the only place the desk learns it",
    RAILS_SQL, [PLAT]);
  check("…six rails kept, five offered, and the retired one still printed with its own flag rather "
    + "than cut out — a payout paid on a rail last year has to be able to say what the rail was",
    railsRetired?.count === 6 && railsRetired?.offered === 5
    && (railsRetired?.rows ?? []).filter((r: Book) => r.retired).length === 1
    && (railsRetired?.rows ?? []).find((r: Book) => r.code === "halopesa")?.retired === true,
    { count: railsRetired?.count, offered: railsRetired?.offered });
  await handP("…a retired rail is refused on the paper rather than left off the board",
    { rail_code: "halopesa", payee_ref_encrypted: PHONE, payee_ref_tail: "1111",
      payee_ref_hash: HASH64 }, "was retired as a rail");
  const rr = await fails("…and the door does not pre-empt it: `raise_money_payout` checks that the "
    + "rail exists, not that it is still offered, so the desk is stopped by the guard", RAISE_P,
    payoutArgs(manual({ payee_kind: "other", payee_name: BOOK("Stranger"), rail_code: "halopesa",
      amount: 10000, payee_ref_encrypted: PHONE, payee_ref_tail: "1111", payee_ref_hash: HASH64 }), PEN),
    "was retired as a rail");
  check("…which arrives in the state the desk maps to a written refusal rather than a fault page, and "
    + "no paper is written", !!rr, rr?.message);
  const leftAfter = await one(`select count(*)::int as n from money_payouts
    where tenant_id = $1::uuid and rail_code = 'halopesa'`, [PLAT]);
  check("…and nothing is left in the register from the attempt, because the whole movement is one "
    + "statement the raise aborts", Number(leftAfter.n) === 0, leftAfter);
  await okDo("…and the gate puts the rail back exactly as 134 seeded it",
    `update money_payout_rails set retired = false where code = 'halopesa'`);
  const railsAfter = await call("money_rails counts what is offered and what is merely kept",
    RAILS_SQL, [PLAT]);
  check("…six rails, six offered once none is retired, each printing the shape its payee line has to "
    + "be so a desk learns it before typing the number",
    railsAfter?.count === 6 && railsAfter?.offered === 6
    && (railsAfter?.rows ?? []).length === 6
    && (railsAfter?.rows ?? []).every((r: Book) => ["phone", "account", "none"].includes(r.needs)
      && r.retired === false), railsAfter?.rows);
  check("…and the two families split six the way the file seeds them: four mobile rails pay a phone, "
    + "one pays an account, and exactly one — the desk's own cash — needs no line at all",
    (railsAfter?.rows ?? []).filter((r: Book) => r.family === "mobile_money").length === 4
    && (railsAfter?.rows ?? []).filter((r: Book) => r.needs === "phone").length === 4
    && (railsAfter?.rows ?? []).filter((r: Book) => r.needs === "none").length === 1
    && (railsAfter?.rows ?? []).find((r: Book) => r.needs === "none")?.code === "cash",
    (railsAfter?.rows ?? []).map((r: Book) => `${r.code}:${r.needs}`));

  // ---------------- 9 · the paper a payout stands on ----------------
  phase("9 · a payout says which paper it stands for — the office's own pen, a signed refund, a "
    + "payroll run, a holder's withdrawal or a cost — and that paper is read before the movement "
    + "is written");
  /** Four of the five source words point at a row in somebody else's register: 126's refund paper,
   *  072's payroll run, 134's own wallet, and a cost that has no table at all. `raise_money_payout`
   *  reads each one before it stamps a paper, and `payout_source_is_a_real_paper` reads them again
   *  after — the door so that a desk gets a sentence about the paper it named, the guard so that a
   *  hand which skipped the desk cannot file a payout against a run that was cancelled or a refund
   *  that was never signed. This phase walks a real signed refund through 121's order rather than
   *  stamping one onto the register by hand, because the released state 134 insists on is a state
   *  126's own trigger only lets a spent signature produce. */
  const PROPOSE_RF = `select platform_auth.propose_refund_release(
    $1::uuid, $2, $3::uuid, $4, $5, $6) as r`;
  const APPLY_RF = `select platform_auth.apply_refund_release($1::uuid, $2::uuid, $3, $4) as r`;
  let rfN = 0;
  const mkRefund = async (label: string, ticket: string, company: string | null, amount: number,
    cur: string) => (await one(`insert into service_refund_requests
      (tenant_id, ref, ticket_id, ticket_ref, company_tenant_id, company_name, amount, currency,
        pay_back, reason, raised_by)
      values ($1::uuid, $2, $3::uuid, 'CS-000000', $4::uuid, $5, $6::numeric, $7, 'bank', $8,
        $9::uuid) returning id, ref, ticket_ref, status`,
    [PLAT, `RF-2026-${num(4)}${++rfN}`, ticket, company,
      company ? BOOK(company === holderA ? "Holder A" : "Nobody") : BOOK("Nobody"),
      amount, cur, REASON, PEN])) as Book;
  /** Raised, asked, signed and spent — 126's own four steps, walked in 121's order by two different
   *  seats, because a refund the office has not signed is exactly the paper 134 refuses to pay. */
  const releaseRefund = async (label: string, id: string): Promise<Book> => {
    const p = await call(`${label} — the desk asks a second seat to sign the refund paper`,
      PROPOSE_RF, [id, REASON, PEN, "compliance_officer", "127.0.0.1", "gate"]);
    const w = await walk(`${label} — the second seat signs it and 126's own effect spends the paper`,
      String(p?.approval_id), QUILL, APPLY_RF, "The figure is agreed and the office owes it back.");
    const r = await row("service_refund_requests", id);
    check(`${label} — the paper reaches the only state 134 pays out of, on a signature the seat `
      + `that raised it did not sign`, r?.status === "released" && !!r?.released_at
      && String(r?.released_by) === QUILL && String(r?.released_by) !== String(r?.raised_by)
      && String(r?.approval_id) === String(p?.approval_id) && w?.settle?.status === "ok",
      { status: r?.status, released: r?.released_by, approval: p?.approval_id });
    return { ...r, approval: p?.approval_id };
  };
  const RF_A = await releaseRefund("the office signs holder A a refund of 120 000 on the call it took",
    (await mkRefund("a", CALL_MAIN, holderA, 120000, "TZS")).id as string);
  const RF_RAISED = await mkRefund("b", CALL_MAIN, holderA, 40000, "TZS");
  const RF_NOC = await releaseRefund("…and a second office signs a paper for a call whose company "
    + "has since come off the register",
    (await mkRefund("c", CALL_NOC, null, 60000, "TZS")).id as string);
  const RF_USD = await releaseRefund("…and a third signs a refund agreed in dollars",
    (await mkRefund("d", CALL_MAIN, holderA, 90, "USD")).id as string);
  const RUN = (await one(`insert into payroll_runs (tenant_id, period, currency, status, working_days,
      gross_total, deduction_total, adjustment_total, net_total, headcount, created_by)
      values ($1::uuid, '2026-09-01', 'TZS', 'draft', 22, 600000, 60000, 0, 540000, 3, $2::uuid)
      returning id, period, net_total, currency`, [PLAT, PEN])) as Book;
  const RUN_GONE = (await one(`insert into payroll_runs (tenant_id, period, currency, status,
      working_days, net_total, headcount, created_by, deleted_at)
      values ($1::uuid, '2026-08-01', 'TZS', 'draft', 21, 300000, 2, $2::uuid, now()) returning id`,
    [PLAT, PEN])).id as string;
  await raiseRefuses("a payout that says what it stands for in a word the register does not keep",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), source_kind: "invoice" }),
    "bad_source_kind");
  await raiseRefuses("…and a payout in a money the office does not move at all",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), currency: "KES" }), "bad_currency");
  const PRF = await raisePayout("a payout aimed at the signed refund carries its own paper: the "
    + "figure, the number and the company the signature was given to",
    manual({ payee_kind: "company", payee_id: holderA, source_kind: "refund", source_id: RF_A.id,
      amount: 120000 }));
  const prfRow = await payRow(PRF);
  check("…stamped against the book's refund line rather than the ordinary payable, and quoted with "
    + "the refund's own number taken off the paper — not typed by the seat that raised it",
    PRF?.ok === true && String(prfRow?.source_ref) === RF_A.ref && prfRow?.source_kind === "refund"
    && String(prfRow?.payable_account_id) === String((await acc("REFUND-DUE", PLAT)).id)
    && String(prfRow?.fund_account_id) === String(COST_OPS.id) && !!prfRow?.cash_account_id,
    { ref: prfRow?.source_ref, payable: await codeOf(String(prfRow?.payable_account_id)) });
  const prfPaper = (await call("…and the detail read prints the refund behind the paper, in the words "
    + "126 kept on it", P_DETAIL, [PLAT, String(PRF?.payout?.id)]))?.source_paper as Book | undefined;
  check("…which is how a desk answers \"what is this payout for\" without opening three registers",
    prfPaper?.ref === RF_A.ref && prfPaper?.status === "released"
    && Number(prfPaper?.amount) === 120000 && prfPaper?.currency === "TZS"
    && String(prfPaper?.company) === BOOK("Holder A") && prfPaper?.ticket_ref === T_REF, prfPaper);
  await raiseRefuses("a refund paper this book does not have is answered before the payee is read",
    manual({ payee_kind: "company", payee_id: holderA, source_kind: "refund", source_id: NO_BODY,
      amount: 1000 }), "refund_not_found");
  const noSign = await raiseRefuses("…and a paper the office raised but never signed is answered with "
    + "its own number and state, because signing a paper is not the same act as paying it",
    manual({ payee_kind: "company", payee_id: holderA, source_kind: "refund",
      source_id: RF_RAISED.id, amount: 40000 }), "refund_not_released");
  check("…printed on the answer so the desk can name which paper is short a signature",
    noSign?.refund_ref === RF_RAISED.ref && noSign?.refund_status === "raised", noSign);
  const fig = await raiseRefuses("a payout one unit away from what the signed paper promised",
    manual({ payee_kind: "company", payee_id: holderA, source_kind: "refund", source_id: RF_A.id,
      amount: 120001 }), "refund_figure");
  check("…answers with the figure the caller is owed, printed the way the signature printed it",
    Number(fig?.owed) === 120000 && fig?.currency === "TZS" && fig?.refund_ref === RF_A.ref, fig);
  await raiseRefuses("…and the same paper asked in the other money is the same refusal, because the "
    + "figure and the money are one sentence",
    manual({ payee_kind: "company", payee_id: holderA, source_kind: "refund", source_id: RF_A.id,
      amount: 120000, currency: "USD" }), "refund_figure");
  const goneCo = await raiseRefuses("a signed refund whose company has come off the register has "
    + "nobody to be paid",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), source_kind: "refund",
      source_id: RF_NOC.id, amount: 60000 }), "refund_company_gone");
  check("…and the desk is told which paper, not which person", /no longer on the register/
    .test(String(goneCo?.message)) && goneCo?.refund_ref === RF_NOC.ref, goneCo);
  await raiseRefuses("…a refund aimed at anybody other than the company it was signed for",
    manual({ payee_kind: "driver", payee_id: driver, source_kind: "refund", source_id: RF_A.id,
      amount: 120000 }), "refund_payee");
  const usdRef = await raisePayout("…and a dollar refund stands on the dollar refund line, which is "
    + "the only way 133's one-money rule lets it be booked",
    manual({ payee_kind: "company", payee_id: holderA, source_kind: "refund",
      source_id: RF_USD.id, amount: 90, currency: "USD" }));
  check("…three dollar lines, none of them borrowed from the TZS side of the chart, and the refund's "
    + "own payable line rather than the ordinary one", usdRef?.ok === true
    && usdRef?.payout?.payable?.code === "REFUND-DUE-USD"
    && usdRef?.payout?.cash?.code === "OPS-USD" && usdRef?.payout?.fund?.code === "COST-OPS-USD"
    && usdRef?.payout?.payable?.currency === "USD"
    && Number(usdRef?.payout?.amount) === 90 && usdRef?.payout?.source_ref === RF_USD.ref,
    { payable: usdRef?.payout?.payable?.code, cash: usdRef?.payout?.cash?.code,
      fund: usdRef?.payout?.fund?.code, ref: usdRef?.payout?.source_ref });
  /** The same four questions, asked of a hand that wrote the row. Each insert carries the three lines
   *  the door would have derived, so nothing but the named rule can refuse it. */
  await handP("the guard asks the refund paper the same four questions, so a hand that skipped the "
    + "desk meets the same sentence", { source_kind: "refund", source_id: NO_BODY,
      payee_kind: "company", payee_id: holderA, payee_tenant_id: holderA, amount: 1000 },
    "stands on a refund paper the office does not have");
  await handP("…a signature that was never spent does not owe anybody money",
    { source_kind: "refund", source_id: RF_RAISED.id, payee_kind: "company", payee_id: holderA,
      payee_tenant_id: holderA, amount: 40000 }, "only a released one owes money");
  await handP("…the figure is read off the paper rather than typed beside it",
    { source_kind: "refund", source_id: RF_A.id, payee_kind: "company", payee_id: holderA,
      payee_tenant_id: holderA, amount: 119000 }, "owed what the paper says");
  await handP("…and so is who the paper was signed for",
    { source_kind: "refund", source_id: RF_A.id, payee_kind: "company", payee_id: holderB,
      payee_tenant_id: holderB, payee_name: BOOK("Holder B"), amount: 120000 }, "is owed to");
  const runPay = await raisePayout("a payout for a payroll run quotes the period it pays",
    manual({ payee_kind: "staff", payee_id: staff, source_kind: "payroll", source_id: RUN.id,
      amount: 200000 }));
  check("…which is the figure a desk cannot mistype, because the run's own month is written on it",
    runPay?.ok === true && String(runPay?.payout?.source_ref) === "2026-09"
    && runPay?.payout?.source_kind === "payroll", runPay?.payout?.source_ref);
  await raiseRefuses("a run the office does not have", manual({ source_kind: "payroll",
    source_id: NO_BODY, payee_kind: "other", payee_name: BOOK("Stranger"), amount: 1000 }),
    "run_not_found");
  const runCur = await raiseRefuses("…and a run read in the wrong money answers with both figures, "
    + "because 072 lets a run be TZS and nothing else, so this is the only way the pair can disagree",
    manual({ source_kind: "payroll", source_id: RUN.id, payee_kind: "other",
      payee_name: BOOK("Stranger"), amount: 1000, currency: "USD" }), "run_currency");
  check("…the register's own constraint is what makes that answer the interesting one",
    runCur?.run_currency === "TZS" && runCur?.currency === "USD", runCur);
  const runFig = await raiseRefuses("…and a payout bigger than the run netted",
    manual({ source_kind: "payroll", source_id: RUN.id, payee_kind: "other",
      payee_name: BOOK("Stranger"), amount: 540001 }), "run_figure");
  check("…by the net figure the issue stamped on it", Number(runFig?.net_total) === 540000
    && Number(runFig?.amount) === 540001, runFig);
  await raiseRefuses("…a run the office cancelled is not behind the paper at all, in the door's words",
    manual({ source_kind: "payroll", source_id: RUN_GONE, payee_kind: "other",
      payee_name: BOOK("Stranger"), amount: 1000 }), "run_not_found");
  await handP("the guard reads the run the same way, and a cancelled one is a paper it will not "
    + "stand on", { source_kind: "payroll", source_id: RUN_GONE, amount: 1000 },
    "there is no payroll run");
  await handP("…in the other money", { source_kind: "payroll", source_id: RUN.id, currency: "USD",
    amount: 1000 }, "is a TZS run and this payout is in USD");
  await handP("…and over the net the run issued",
    { source_kind: "payroll", source_id: RUN.id, amount: 600000 }, "more than it issued");
  /** The withdrawal is the one source whose own line pays: the office is not spending its money but
   *  handing a holder their balance back, so the fund is that holder's `WLT-` line and the guard
   *  checks the pairing both ways. */
  /** Phases 5 to 8 have spent from this line already, and a withdrawal is the one source the balance
   *  is asked of before the paper is stamped — so the gate refills it rather than guess at what is
   *  left, and reads the figure back rather than assuming the top-up landed. */
  await fund("the office takes more money into the first holder's wallet before that holder asks for "
    + "some of it back", WAL_A!, 500000, "bank", MEMO("topped up for a withdrawal"),
    MEMO("fund A for phase 9"));
  const balA = await walletBal(WAL_A!);
  check("…and the top-up is in the balance the withdrawal is measured against, so the figure the "
    + "gate asserts is the figure the book holds", balA >= 61500, { balance: balA });
  const wd = await raisePayout("a holder takes 60 000 of their own balance out",
    manual({ payee_kind: "company", payee_id: holderA, source_kind: "wallet_withdrawal",
      source_id: WAL_A, amount: 60000, fee_amount: 1500 }));
  const wdRow = await payRow(wd);
  check("…and the money leaves the line the holder's balance sits on, not the office's expense line, "
    + "with the holder's own name as the quote",
    wd?.ok === true && String(wdRow?.fund_account_id) === WAL_A_LINE
    && await codeOf(String(wdRow?.payable_account_id)) === "PAYOUT-DUE"
    && String(wdRow?.source_ref) === BOOK("Holder A") && Number(wdRow?.amount) === 60000
    && Number(wdRow?.fee_amount) === 1500, { fund: await codeOf(String(wdRow?.fund_account_id)),
      ref: wdRow?.source_ref, balance: await walletBal(WAL_A!), before: balA });
  const wdPaper = (await call("…the detail prints the wallet it drains, with the balance still in it",
    P_DETAIL, [PLAT, String(wd?.payout?.id)]))?.source_paper as Book | undefined;
  check("…which is the sentence a holder reads when they ask why the withdrawal was refused",
    wdPaper?.holder === BOOK("Holder A") && wdPaper?.currency === "TZS"
    && wdPaper?.status === "open" && Number(wdPaper?.balance) === balA, wdPaper);
  await raiseRefuses("a withdrawal from a wallet this office does not hold",
    manual({ payee_kind: "company", payee_id: holderA, source_kind: "wallet_withdrawal",
      source_id: NO_BODY, amount: 1000 }), "wallet_not_found");
  await raiseRefuses("…a TZS wallet asked in dollars",
    manual({ payee_kind: "company", payee_id: holderA, source_kind: "wallet_withdrawal",
      source_id: WAL_A, amount: 1000, currency: "USD" }), "wallet_currency");
  const shortW = await raiseRefuses("…and a figure bigger than the balance, the office's cut counted "
    + "inside it",
    manual({ payee_kind: "company", payee_id: holderA, source_kind: "wallet_withdrawal",
      source_id: WAL_A, amount: balA, fee_amount: 2000 }), "short");
  check("…with the shortfall spelled out, because \"not enough\" is not a sentence a holder can act on",
    Number(shortW?.balance) === balA && Number(shortW?.needs) === balA + 2000
    && Number(shortW?.short_by) === 2000
    && /cut comes out of the same/.test(String(shortW?.message)), shortW);
  const frzW = await call("the office stops a wallet for a compliance check", FREEZE_W,
    [PLAT, WAL_S, STOP, PEN, true, "compliance_officer", "127.0.0.1", "gate"]);
  check("…and 134's own wallet door answers with the stopped balance", frzW?.ok === true
    && frzW?.wallet?.status === "frozen", frzW?.wallet);
  const fz = await raiseRefuses("a holder cannot take money out of a stopped wallet",
    manual({ payee_kind: "company", payee_id: shipper, source_kind: "wallet_withdrawal",
      source_id: WAL_S, amount: 1000 }), "wallet_frozen");
  check("…and the answer repeats the reason the office wrote when it stopped it",
    fz?.holder === BOOK("Shipper") && fz?.reason === STOP, fz);
  await call("…so the office opens the wallet again", FREEZE_W,
    [PLAT, WAL_S, "", PEN, false, "compliance_officer", "127.0.0.1", "gate"]);
  await handP("the guard reads the wallet behind a withdrawal too, and a hand that names none is "
    + "stopped on the paper", { source_kind: "wallet_withdrawal", source_id: NO_BODY,
      fund_account_id: WAL_B_LINE, payable_account_id: String(PAYABLE_DUE.id),
      cash_account_id: String(OPS_CASH.id), payee_kind: "company", payee_id: holderB,
      payee_tenant_id: holderB }, "withdraws from a wallet the office does not have");
  await handP("…a withdrawal pointed at the office's own expense line is the trick the pairing rule "
    + "exists for, and it is the honest-lines guard that catches it first",
    { source_kind: "wallet_withdrawal", source_id: WAL_A, fund_account_id: String(COST_OPS.id),
      payee_kind: "company", payee_id: holderA, payee_tenant_id: holderA },
    "drains the holder's own wallet line");
  await handP("…and the money is asked of the wallet as well as of the lines",
    { source_kind: "wallet_withdrawal", source_id: WAL_A, currency: "USD",
      fund_account_id: WAL_U_LINE, payee_kind: "company", payee_id: holderA,
      payee_tenant_id: holderA, amount: 10 },
    "is a TZS wallet and this withdrawal is in USD");
  /** The cost is the one source with no table behind it, so the quote is the whole of what the paper
   *  can say — which is why the guard asks for it and the door cannot leave it blank. */
  const pcost = await raisePayout("a cost payout names what it pays for in the desk's own words",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), source_kind: "cost",
      source_ref: "Yard receipt 4471, the container handler's invoice" }));
  check("…with nothing but its own rail behind the quote when the desk leaves it blank, which is why "
    + "the guard's rule is only ever met by a hand",
    pcost?.ok === true && String(pcost?.payout?.source_ref)
      === "Yard receipt 4471, the container handler's invoice", pcost?.payout?.source_ref);
  const pcostBlank = await raisePayout("a cost payout that types no quote still carries one, taken "
    + "from the rail it travels by",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), source_kind: "cost",
      source_ref: "   " }));
  check("…which is the coalesce's last arm: refund, run, holder, rail — and only then the blank",
    pcostBlank?.ok === true && String(pcostBlank?.payout?.source_ref) === CASH_LABEL,
    pcostBlank?.payout?.source_ref);
  await handP("…a cost with no quote at all is a paper that says what it pays for nowhere",
    { source_kind: "cost", source_ref: null }, "names what it pays for");
  /** The repair this gate was written against: a `source_ref` is 133's own 60 characters, and 134
   *  built it out of a company name 072 lets run to 120 without cutting it. Phase 5 opened and funded
   *  the wallet for that holder already, so the withdrawal here is asked of the same balance the gate
   *  has proved rather than a second one the wallet door would refuse for the same holder and money. */
  const clamp = await raisePayout("a withdrawal for the holder whose name fills the register's own "
    + "limit is booked, because the quote the door builds out of that name is cut to what the "
    + "movement can carry",
    manual({ payee_kind: "company", payee_id: longName, source_kind: "wallet_withdrawal",
      source_id: WAL_LONG, amount: 5000 }));
  check("…cut, and not refused: a payout the office owes cannot be stopped by the length of the "
    + "company it is owed to", clamp?.ok === true
    && String(clamp?.payout?.source_ref) === LONG_NAME.slice(0, 60)
    && String(clamp?.payout?.source_ref).length === 60,
    { ref: clamp?.payout?.source_ref, len: String(clamp?.payout?.source_ref).length,
      holder: LONG_NAME.length });
  const clampTyped = await raisePayout("…and a desk that pastes a waybill number twice over is "
    + "answered the same way, by the same clamp",
    manual({ payee_kind: "other", payee_name: BOOK("Stranger"), source_ref:
      `WAYBILL-${"TZ".repeat(45)}` }));
  check("…which is the half a seat can reach without a long-named company: the typed quote is cut "
    + "rather than refused", clampTyped?.ok === true
    && String(clampTyped?.payout?.source_ref).length === 60
    && String(clampTyped?.payout?.source_ref).startsWith("WAYBILL-TZTZ"),
    { ref: clampTyped?.payout?.source_ref, typed: 9 + 90 });

  // ---------------- 10 · the three lines a payout stands on ----------------
  phase("10 · a payout's fund, payable and cash lines are derived from the money, the paper and the "
    + "rail — and the guard reads all three back");
  /** `money_payout_accounts` is the only place 134 consults the chart for money that leaves, and
   *  `payout_accounts_are_honest` is the same rule written a second time below the door. That pair is
   *  the point of the phase: a seat is never offered a liability line to choose, so the derivation has
   *  to be one function's answer for one shape of paper — and a hand that skips the door still cannot
   *  put a payout on a line the chart did not name. Every refusal below is met with a hand that passes
   *  all three ids, because the guard is the one speaking, not the helper. */
  const PAYOUT_DUE = await acc("PAYOUT-DUE", PLAT);
  const OPS_USD = await acc("OPS-USD", PLAT);
  const REFUND_DUE = await acc("REFUND-DUE", PLAT);
  const PAYOUT_DUE_USD = await acc("PAYOUT-DUE-USD", PLAT);
  const REFUND_DUE_USD = await acc("REFUND-DUE-USD", PLAT);
  const COST_OPS_USD = await acc("COST-OPS-USD", PLAT);
  const FEE_INCOME_USD = await acc("FEE-INCOME-USD", PLAT);
  check("and the seven dollar lines 133 keeps are all in this book, or none of the derivation below "
    + "means anything", [OPS_USD, PAYOUT_DUE_USD, REFUND_DUE_USD, COST_OPS_USD, FEE_INCOME_USD]
    .every((a) => a?.id && a.currency === "USD" && a.status === "open"),
    [OPS_USD, PAYOUT_DUE_USD, REFUND_DUE_USD, COST_OPS_USD, FEE_INCOME_USD].map((a) => a?.code));
  /** The helper is asked directly, with the rail *family* it is handed, because that is the argument a
   *  door computes from `money_payout_rails` — and phase 10 needs to be able to say what the rule is
   *  for a family the office has never seeded. */
  const ACCT_F = `select platform_auth.money_payout_accounts($1::uuid, $2, $3, $4, $5::uuid) as r`;
  const codeById = async (id: string) => String((await one(
    `select code from money_accounts where id = $1::uuid`, [id])).code);
  const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    .test(String(s).toLowerCase());
  const DERIV: { cur: string; sk: string; rail: string; fund: string; payable: string; cash: string;
    wallet?: string; why: string }[] = [
    { cur: "TZS", sk: "manual", rail: "cash", fund: "COST-OPS", payable: "PAYOUT-DUE",
      cash: "OPS-CASH", why: "the office's own pen, handed over at the desk" },
    { cur: "TZS", sk: "manual", rail: "bank", fund: "COST-OPS", payable: "PAYOUT-DUE",
      cash: "OPS-BANK", why: "the same pen, but the money goes by transfer" },
    { cur: "TZS", sk: "manual", rail: "mpesa", fund: "COST-OPS", payable: "PAYOUT-DUE",
      cash: "OPS-BANK", why: "a mobile rail is not the till — the office's mobile money leaves the "
        + "bank line" },
    { cur: "TZS", sk: "refund", rail: "bank", fund: "COST-OPS", payable: "REFUND-DUE",
      cash: "OPS-BANK", why: "money owed back to a caller is accrued on its own payable line, so the "
        + "office can tell a refund from a payment" },
    { cur: "TZS", sk: "payroll", rail: "bank", fund: "COST-OPS", payable: "PAYOUT-DUE",
      cash: "OPS-BANK", why: "a salary run is an ordinary expense until the cash leaves" },
    { cur: "TZS", sk: "cost", rail: "cash", fund: "COST-OPS", payable: "PAYOUT-DUE",
      cash: "OPS-CASH", why: "a cost quoted on a paper is booked the same way as the office's own pen" },
    { cur: "USD", sk: "manual", rail: "cash", fund: "COST-OPS-USD", payable: "PAYOUT-DUE-USD",
      cash: "OPS-USD", why: "a dollar movement cannot touch a single TZS line, not even the till" },
    { cur: "USD", sk: "refund", rail: "bank", fund: "COST-OPS-USD", payable: "REFUND-DUE-USD",
      cash: "OPS-USD", why: "and a dollar refund has its own dollar payable line for the same reason" },
    { cur: "TZS", sk: "wallet_withdrawal", rail: "bank", fund: "", payable: "PAYOUT-DUE",
      cash: "OPS-BANK", wallet: WAL_A, why: "a withdrawal drains the holder's own liability line, "
        + "which is the one thing the chart cannot name in advance" },
    { cur: "USD", sk: "wallet_withdrawal", rail: "cash", fund: "", payable: "PAYOUT-DUE-USD",
      cash: "OPS-USD", wallet: WAL_AUSD, why: "and the holder's dollar wallet is a different line "
        + "with the same words" }
  ];
  for (const d of DERIV) {
    const derived = await acct(d.cur, d.sk, d.rail, d.wallet ?? null);
    const got = { fund: await codeById(derived.fund), payable: await codeById(derived.payable),
      cash: await codeById(derived.cash), fee: await codeById(derived.fee) };
    check(`the derivation for ${d.why} — ${d.cur} / ${d.sk} on ${d.rail} — is `
      + `${d.wallet ? "the holder's own wallet line" : d.fund}, ${d.payable} and ${d.cash}`,
      (d.wallet ? derived.fund === WAL_A_LINE || derived.fund === WAL_U_LINE
        : got.fund === d.fund) && got.payable === d.payable && got.cash === d.cash
      && got.fee === (d.cur === "USD" ? "FEE-INCOME-USD" : "FEE-INCOME")
      && [derived.fund, derived.payable, derived.cash].every((x) => isUuid(String(x))),
      { ...got, fundIsUuid: isUuid(String(derived.fund)) });
  }
  /** The helper answers with ids, never with codes, and the guard is the half that turns an id back
   *  into a name — so a door could not pass a code where an uuid belongs and a hand could not pass an
   *  uuid whose code disagrees with the paper. */
  check("…so what the door is handed is three uuids from this book, and the fee line is a fourth it "
    + "is never given", isUuid(String((await acct("TZS", "manual", "cash", null)).fee)),
    await acct("TZS", "manual", "cash", null));
  const famUnknown = await one(ACCT_F, [PLAT, "TZS", "manual", "carrier_pigeon", null]);
  check("…and the family is a word, not a lookup: a rail the office has never seeded still gets the "
    + "bank line, because the helper cannot read a rail that does not exist — the guard that stops a "
    + "paper on an invented rail is the one above it, already proved in phase 8",
    await codeById(famUnknown.r.cash) === "OPS-BANK", await codeById(famUnknown.r.cash));
  const famUSD = await one(ACCT_F, [PLAT, "USD", "manual", "cash", null]);
  check("…while for a dollar movement the family is irrelevant, because the office has one dollar "
    + "line money leaves by", await codeById(famUSD.r.cash) === "OPS-USD",
    await codeById(famUSD.r.cash));
  /** Two shapes make the helper refuse, and both arrive as a door's own `raise exception` rather than
   *  as an answer: a book with no chart at all, and a withdrawal whose wallet the register does not
   *  have. The second is the shape that would poison this gate if it were asked with a bare `one()` —
   *  the wallet is read with a LEFT JOIN, so a missing wallet and a wallet with no line are the same
   *  answer. */
  await fails("the helper refuses a book that has no chart, because a payout with no payable line is "
    + "a paper that owes nobody", ACCT_F, [holderA, "TZS", "manual", "cash", null],
    "needs its fund, payable and cash lines", DOOR_RAISE);
  await fails("…and it says which two lines it was looking for, so the office learns what to open "
    + "rather than that something is missing", ACCT_F, [holderA, "USD", "refund", "bank", null],
    "(payable would be REFUND-DUE-USD, cash OPS-USD)", DOOR_RAISE);
  await fails("…and a withdrawal aimed at no wallet at all is refused the same way, because the fund "
    + "of a withdrawal is not a line the chart can name in advance",
    ACCT_F, [PLAT, "TZS", "wallet_withdrawal", "bank", NO_BODY],
    "needs its fund, payable and cash lines", DOOR_RAISE);
  const wcurDoor = await raiseRefuses("…but a seat is stopped before the helper is asked: a dollar "
    + "withdrawal aimed at the holder's TZS wallet answers with the wallet's own money",
    manual({ payee_kind: "company", payee_id: holderA, currency: "USD", rail_code: "bank",
      payee_ref_encrypted: ACCT, payee_ref_tail: "0042", payee_ref_hash: HASH64,
      source_kind: "wallet_withdrawal", source_id: WAL_A, amount: 10 }), "wallet_currency");
  check("…which is the one place a withdrawal's money is asked of the wallet rather than of the "
    + "paper", wcurDoor?.ok === false && wcurDoor?.error === "wallet_currency", wcurDoor);
  /** The guard's own arms, each met by a hand that passes three ids so that nothing but the named
   *  rule can speak. Every one of them arrives in `23514`, which is what makes it a written refusal
   *  on the desk rather than a fault page. */
  await handP("a hand that puts a shilling payout on the dollar payable line is refused by the code "
    + "the chart gives that line", { fund_account_id: String(COST_OPS.id),
      payable_account_id: String(PAYOUT_DUE_USD.id), cash_account_id: String(OPS_CASH.id) },
    "and accrues to PAYOUT-DUE, not to PAYOUT-DUE-USD");
  const BANK_LABEL = String((await one(`select label from money_payout_rails where code = 'bank'`)).label);
  const cashErr = await handP("…and one that pays a transfer out of the till, because the rail decides "
    + "the cash line and the till is the desk's own drawer", { rail_code: "bank",
      payee_ref_encrypted: ACCT, payee_ref_tail: "0042", payee_ref_hash: HASH64,
      fund_account_id: String(COST_OPS.id), payable_account_id: String(PAYOUT_DUE.id),
      cash_account_id: String(OPS_CASH.id) }, "leaves through");
  check("…with the rail's own word for itself in the sentence, which is the sentence a clerk reads to "
    + "a payee on the telephone", BANK_LABEL.length > 3
    && String(cashErr?.message).includes(BANK_LABEL)
    && /leaves through OPS-BANK, not OPS-CASH/.test(String(cashErr?.message)), cashErr?.message);
  await handP("a payout funded out of an asset line is refused: money the office owns cannot be "
    + "spent twice by naming it as the source", { fund_account_id: String(GATE_WAIT.id),
      payable_account_id: String(PAYOUT_DUE.id), cash_account_id: String(OPS_CASH.id) },
    "and a payout drains a liability or books an expense");
  await handP("…and the same for the office's own income line, which is where its cut lands rather "
    + "than where its money comes from", { fund_account_id: String(FEE_INCOME.id),
      payable_account_id: String(PAYOUT_DUE.id), cash_account_id: String(OPS_CASH.id) },
    "is an income line");
  /** The cash line has to be the one the rail names, or the cash arm speaks first and the withdrawal
   *  is never asked about its fund. Both of those refusals are worth hearing, so the shape below is
   *  the one that leaves the till honest and the source wrong. */
  await handP("a withdrawal that drains the expense line instead of the holder's own wallet is "
    + "refused, because the office would be paying the holder out of money it never held",
    { source_kind: "wallet_withdrawal", source_id: WAL_A, payee_kind: "company",
      payee_id: holderA, payee_tenant_id: holderA, fund_account_id: String(COST_OPS.id),
      payable_account_id: String(PAYOUT_DUE.id), cash_account_id: String(OPS_CASH.id) },
    "a withdrawal drains the holder's own wallet line");
  await handP("…and the mirror of it: an ordinary payout may not be funded from a holder's wallet "
    + "line, which would hide office money inside somebody's balance",
    { fund_account_id: WAL_A_LINE, payable_account_id: String(PAYOUT_DUE.id),
      cash_account_id: String(OPS_CASH.id) },
    "one expense line for money the office pays out");
  /** The one-money arm cannot be reached by two lines whose codes are right, because in this chart a
   *  code carries its money in its own name — so the shape a hand has to build is a withdrawal whose
   *  wallet line is in the other money. The door stops that at the wallet; the guard is what stops a
   *  hand. */
  await handP("a dollar withdrawal pointed at the holder's shilling wallet is refused on its three "
    + "lines, because one movement cannot carry two moneys", { currency: "USD",
      source_kind: "wallet_withdrawal", source_id: WAL_A, payee_kind: "company",
      payee_id: holderA, payee_tenant_id: holderA, fund_account_id: WAL_A_LINE,
      payable_account_id: String(PAYOUT_DUE_USD.id), cash_account_id: String(OPS_USD.id) },
    "one money per movement");
  await handP("…and the sentence prints all three lines' moneys in order, because \"the money is "
    + "wrong\" is not a sentence an office can fix", { currency: "USD",
      source_kind: "wallet_withdrawal", source_id: WAL_A, payee_kind: "company",
      payee_id: holderA, payee_tenant_id: holderA, fund_account_id: WAL_A_LINE,
      payable_account_id: String(PAYOUT_DUE_USD.id), cash_account_id: String(OPS_USD.id) },
    "its three lines are TZS, USD and USD");
  /** The same three lines, honestly derived, are not refused: the guard is a copy of the door's rule
   *  and nothing more, so a shape no seat can be blamed for must pass. The holder's dollar balance is
   *  refilled first for the same reason it was before the shilling withdrawal in phase 9 — a balance
   *  is spent by every phase above this one, and a gate that guesses at it reads a `short`. */
  await fund("the office takes more money into the first holder's dollar wallet before asking whether "
    + "a dollar withdrawal is refused for the shape of its lines", WAL_AUSD!, 5000, "bank",
    MEMO("topped up for a dollar withdrawal"), MEMO("fund A dollars for phase 10"));
  const okUsdW = await raisePayout("…and a dollar withdrawal aimed at the holder's own dollar wallet "
    + "stands on three dollar lines the door picked",
    manual({ payee_kind: "company", payee_id: holderA, currency: "USD", rail_code: "cash",
      source_kind: "wallet_withdrawal", source_id: WAL_AUSD, amount: 40 }));
  check("…which is the arm's only job: to refuse the mismatch rather than the movement",
    okUsdW?.ok === true && String(okUsdW?.payout?.fund?.code) === MINT(holderA, "USD")
    && okUsdW?.payout?.payable?.code === "PAYOUT-DUE-USD"
    && okUsdW?.payout?.cash?.code === "OPS-USD", { fund: okUsdW?.payout?.fund?.code,
      payable: okUsdW?.payout?.payable?.code, cash: okUsdW?.payout?.cash?.code });
  /** Lines that cannot be the same line: the arm that forbids a movement crossing one line twice sits
   *  below two arms that pin each of the three codes to a set the others cannot reach, so no hand that
   *  gets that far can be holding a duplicate. The nearest shapes are refused one arm earlier. */
  await handP("the closest a hand gets to funding a payout from its own payable line is refused one "
    + "arm before the duplicate rule", { fund_account_id: String(PAYOUT_DUE.id),
      payable_account_id: String(PAYOUT_DUE.id), cash_account_id: String(OPS_CASH.id) },
    "one expense line for money the office pays out");
  await handP("…and pointing the cash line at the expense line, because the rail names the cash line "
    + "before anything is asked of it twice", { fund_account_id: String(COST_OPS.id),
      payable_account_id: String(PAYOUT_DUE.id), cash_account_id: String(COST_OPS.id) },
    "leaves through");
  await handP("…and making the payable line the till, which is the third of the three shapes and "
    + "still refused by a code rather than by a duplicate", { fund_account_id: String(COST_OPS.id),
      payable_account_id: String(OPS_CASH.id), cash_account_id: String(OPS_CASH.id) },
    "and accrues to PAYOUT-DUE, not to OPS-CASH");
  const uq = (await one(`select conname from pg_constraint where conrelid = 'money_accounts'::regclass
    and contype = 'u' and pg_get_constraintdef(oid) like '%code%'`)) as Book;
  check("…which is only unreachable because the chart cannot hold the same code twice in one book, "
    + "and that is 133's own constraint rather than anything 134 assumes",
    uq?.conname === "money_accounts_code_per_book", uq);
  note("134: `would move money through the same line twice` is a rule no hand can reach — the fund is "
    + "pinned to COST-OPS or a WLT line, the payable to a *-DUE line and the cash to an OPS line "
    + "before it is asked, and `(tenant_id, code)` is unique. It stays as the last arm because the "
    + "day a line is renamed is the day it becomes reachable.");
  /** A frozen line is the office's own stop, put on by 133's freeze door, and a payout that names a
   *  stopped line is refused in that stop's own words. Each of the three arms is opened and shut here
   *  so every phase below finds the chart exactly as it was left. */
  const STOP_LINE = MEMO("a line the gate stopped, for the gate's own reason");
  const TRIO = { rail_code: "cash", fund_account_id: String(COST_OPS.id),
    payable_account_id: String(PAYOUT_DUE.id), cash_account_id: String(OPS_CASH.id) };
  check("and the two payable lines the guard's sentences name are the two lines 133 seeded, so a "
    + "refusal and a booking can never point at different places",
    String((await acct("TZS", "refund", "bank")).payable) === String(REFUND_DUE.id)
    && String((await acct("TZS", "manual", "cash")).payable) === String(PAYOUT_DUE.id),
    { refund: await codeById(String((await acct("TZS", "refund", "bank")).payable)),
      payout: await codeById(String((await acct("TZS", "manual", "cash")).payable)) });
  /** Each arm is shut and opened again in the same turn, so the three phases after this one find the
   *  chart exactly as 134 seeded it. The paper each arm refuses is written once the stop comes off —
   *  the same three ids, the same rail, the same money — because a refusal that survived its own
   *  freeze would be a refusal of the movement rather than of the line. Those three papers are the
   *  only hand-written payouts in this book, and they carry `source_ref` so a later count can say so. */
  for (const [which, line, code] of [["fund", COST_OPS, "COST-OPS"],
    ["payable", PAYOUT_DUE, "PAYOUT-DUE"], ["cash", OPS_CASH, "OPS-CASH"]] as
    [string, Book, string][]) {
    const over = { ...TRIO, [`${which}_account_id`]: String(line.id),
      source_ref: "gate phase 10 frozen-line control" };
    const fr = await call(`the office stops its own ${which} line, ${code}`, FREEZE_ACC,
      [PLAT, String(line.id), STOP_LINE, PEN, true]);
    check("…and 133's door answers with the line in its new state, which is the pair a desk can read "
      + "back to whoever telephones about it",
      fr?.ok === true && fr?.account?.status === "frozen" && fr?.account?.code === code,
      fr?.account);
    const frz = await handP(`…and a payout whose ${which} line is stopped is refused by that line`,
      over, STOP_LINE);
    check("…in the words the office gave when it stopped it — the line's own label and the reason, "
      + "not a sentence about the movement",
      /is frozen/.test(String(frz?.message))
      && String(frz?.message).includes(String(line.label))
      && String(frz?.message).includes(STOP_LINE), frz?.message);
    const un = await call(`…and the office opens the ${which} line again`, FREEZE_ACC,
      [PLAT, String(line.id), "", PEN, false]);
    check("…with no reason, no stamp and no seat left on it",
      un?.ok === true && un?.account?.status === "open" && !un?.account?.frozen_reason
      && !un?.account?.frozen_at && !un?.account?.frozen_by, un?.account);
    const wrote = await okDo("…and the same paper, same three lines, is then written, because the "
      + "stop was the whole objection", INS_P, await handArgs(over));
    check("…which is what makes the arm a rule about a line's state rather than about a movement",
      (wrote?.[0] as Book)?.id != null, wrote?.[0]);
  }
  /** The fee line is not one of the three a payout stands on, so it has no arm of its own until the
   *  paper carries the office's cut. Three bodies of 134 speak the same rule — the helper prints the
   *  line, this guard refuses a paper that cannot land one, and the paid door re-derives it when the
   *  cash actually leaves — so a stopped fee line has to stop the paper at the first of the three. */
  const feeRef = await nextRef("PAY", "payout_number_seq");
  const frzFee = await call("the office stops its own fee income line", FREEZE_ACC,
    [PLAT, String(FEE_INCOME.id), STOP_LINE, PEN, true]);
  check("…and the stopped line is the income line a fee rides on",
    frzFee?.ok === true && frzFee?.account?.code === "FEE-INCOME"
    && frzFee?.account?.status === "frozen", frzFee?.account);
  const feeErr = await handP("so a payout that carries the office's cut is refused by the fee arm, "
    + "which sits below all three line arms and so is the first thing that can speak",
    { ...TRIO, fee_amount: 500, ref: feeRef, source_ref: "gate phase 10 stopped fee line" },
    "no open FEE-INCOME line in TZS");
  check("…and the sentence prints the ref, the figure and the money — the three things a desk needs "
    + "to tell which paper to fix", /carries a 500\.00 fee/.test(String(feeErr?.message))
    && String(feeErr?.message).includes(feeRef), feeErr?.message);
  await call("…so the office opens the fee line again", FREEZE_ACC,
    [PLAT, String(FEE_INCOME.id), "", PEN, false]);
  const feeWrote = await okDo("…and the same paper with the same 500.00 cut is written the moment it "
    + "is open", INS_P, await handArgs({ ...TRIO, fee_amount: 500,
        source_ref: "gate phase 10 fee control" }));
  check("…which is the third copy of the rule agreeing with the first two",
    (feeWrote?.[0] as Book)?.id != null, feeWrote?.[0]);
  const usdTrio = { rail_code: "cash", currency: "USD", fund_account_id: String(COST_OPS_USD.id),
    payable_account_id: String(PAYOUT_DUE_USD.id), cash_account_id: String(OPS_USD.id) };
  const feeUsdRef = await nextRef("PAY", "payout_number_seq");
  await call("the dollar side of the book has the same line and the same rule, so the office stops it",
    FREEZE_ACC, [PLAT, String(FEE_INCOME_USD.id), STOP_LINE, PEN, true]);
  const feeUsdErr = await handP("…and a dollar fee is refused by the dollar sentence, naming USD",
    { ...usdTrio, fee_amount: 500, ref: feeUsdRef, source_ref: "gate phase 10 stopped dollar fee" },
    "no open FEE-INCOME line in USD");
  check("…which is the only difference the money makes: the same figure, the same words, a different "
    + "book line", /carries a 500\.00 fee/.test(String(feeUsdErr?.message))
    && String(feeUsdErr?.message).includes(feeUsdRef), feeUsdErr?.message);
  await call("…and the office opens the dollar fee line again", FREEZE_ACC,
    [PLAT, String(FEE_INCOME_USD.id), "", PEN, false]);
  const feeUsdWrote = await okDo("…and the dollar paper is written too", INS_P,
    await handArgs({ ...usdTrio, fee_amount: 500, source_ref: "gate phase 10 dollar fee control" }));
  check("…on three dollar lines the guard found honest", (feeUsdWrote?.[0] as Book)?.id != null,
    feeUsdWrote?.[0]);
  const feeReaders = Object.entries(fileBody).filter(([, b]) => /->>\s*'fee'/.test(String(b)))
    .map(([k]) => k);
  check("and the `fee` line the helper prints is read by no door at all — a seat is never offered it, "
    + "so the only way a fee can land is the way the paid door re-derives it",
    feeReaders.length === 0, feeReaders);
  check("…while the helper does print it, and the paid door selects the identical line by code and "
    + "status rather than by id",
    /'fee',\s*\(select a\.id from money_accounts/.test(String(fileBody.money_payout_accounts))
    && /'FEE-INCOME'\s*\|\| case when v_row\.currency/.test(String(fileBody.mark_money_payout_paid)),
    { helper: /'fee',/.test(String(fileBody.money_payout_accounts)),
      paid: /'FEE-INCOME'/.test(String(fileBody.mark_money_payout_paid)) });
  note("134: the fee line is written three times over — `money_payout_accounts` prints it, "
    + "`payout_accounts_are_honest` refuses a paper that has nowhere to put it and "
    + "`mark_money_payout_paid` re-derives it at the moment the cash leaves. The first is dead code "
    + "for a payout (no door reads the key) and the third can only disagree with the second if a line "
    + "is renamed or frozen between the two moments, which the guard above makes expensive to do by "
    + "accident. Kept as three because each speaks in a different turn of the movement.");

  // ---------------- 11 · the batch a second seat signs as one figure ----------------
  phase("11 · a batch is opened in one money, signed as one figure, refused as one sentence and "
    + "closed only from its own spent signature");
  /** A batch is the office paying several people with one signature, so the two rules that hold it up
   *  are that the figure under a signature is the figure the seat read, and that the lines under it are
   *  the lines it was read from. `payout_batch_figures_are_kept` keeps the first on the paper and
   *  `payout_line_fits_its_batch` keeps the second on the lines. This phase meets both from both sides,
   *  including the three membership arms 134 shipped unable to fire at all — they were written as
   *  `new.batch_id <> old.batch_id`, which is NULL whenever either side is NULL, i.e. on every join and
   *  every leave there is. */
  const YEAR = String((await one(`select to_char(now(), 'YYYY') as y`)).y);
  const BREASON = MEMO("the batch is signed as one figure, not as three sentences");
  /** One door's own audit line, and the register's line for one paper. Both are read back rather than
   *  taken from the door's echo: the payload is the bytes the hash was taken of, and the audit is the
   *  only place the sentence a seat typed is kept after the row has moved on. */
  const audOf = async (entity: string, id: string, action: string) => (await one(
    `select actor_user_id, actor_role, entity_id, action, before, after from audit_logs
       where entity = $1 and entity_id = $2::uuid and action = $3 order by ts desc limit 1`,
    [entity, id, action])) as Book;
  const papN = async (batch: string) => (await one(
    `select count(*)::int as n,
            sum(case when status = 'pending' then 1 else 0 end)::int as waiting
       from platform_approvals where action = 'money.payout' and target_kind = 'payout_batch'
         and target_id = $1`, [batch])) as Book;
  const openB = (what: string, label: string, cur = "TZS", seat = PEN) =>
    call(what, OPEN_B, [PLAT, label, cur, seat, "finance_officer", "127.0.0.1", "gate"]);

  await refuses("open_money_payout_batch answers a name too short for a second seat to read", OPEN_B,
    [PLAT, "P&", "TZS", PEN, "finance_officer", "127.0.0.1", "gate"], "bad_label");
  const badCur = await refuses("…and a batch that is not one money at all", OPEN_B,
    [PLAT, MEMO("mixed batch"), "XEF", PEN, "finance_officer", "127.0.0.1", "gate"], "bad_currency");
  check("…with the sentence that says when the money is decided — a batch that could mix two currencies "
    + "could not be signed as one figure, and one that decided it later would be signed over a total "
    + "that was not yet a fact", /decided when it is opened/.test(String(badCur?.message)), badCur);

  const b1r = await openB("the office opens a batch to pay three people at once",
    MEMO("Batch one"));
  const BR1 = String(b1r?.batch?.id ?? "");
  const b1row = await row("money_payout_batches", BR1);
  check("…and the paper is a draft: nothing totalled, nothing asked of a second seat, nothing spent",
    b1r?.ok === true && b1row.status === "open" && Number(b1row.total_amount) === 0
    && Number(b1row.lines) === 0 && b1row.reason === null && b1row.approval_id === null
    && b1row.released_by === null && b1row.released_at === null && b1row.closed_by === null
    && String(b1row.raised_by) === PEN && b1row.currency === "TZS", b1row);
  check("…with the number 134 mints for it — `PBT-`, the year and five digits at least off the "
    + "office's own sequence — and no figure typed by the hand that opened it",
    new RegExp(`^PBT-${YEAR}-[0-9]{5,}$`).test(String(b1row.ref)), b1row.ref);
  check("…and the echo the desk is shown is the whole row less the book it stands in, because a "
    + "control door has no business printing a tenant id back at a browser",
    b1r?.batch?.tenant_id === undefined && Object.keys(b1r?.batch ?? {}).length > 12,
    Object.keys(b1r?.batch ?? {}));
  const oAud = await audOf("money_payout_batches", BR1, "payout_batch.opened");
  check("…with the opening written in the office's own audit register: before nothing, after the "
    + "number, the name and the money", String(oAud.actor_user_id) === PEN && oAud.before === null
    && String(oAud.after?.ref) === String(b1row.ref) && oAud.after?.status === "open"
    && String(oAud.after?.label) === String(b1row.label) && oAud.after?.currency === "TZS", oAud);

  const b2r = await openB("…and a second batch, opened with its money typed in lower case",
    MEMO("Batch two"), "tzs");
  const BR2 = String(b2r?.batch?.id ?? "");
  check("…which the door upper-cases before the row is written, because the register keeps its money "
    + "words in one shape and every later rule compares them",
    String((await row("money_payout_batches", BR2)).currency) === "TZS");

  /** Three lines raised under the draft, one per payee kind that needs a register plus the stranger the
   *  desk named itself, each on the rail that fits it and each carrying the office's cut. The figures
   *  are chosen so that the total and the fee total are different numbers — a batch signed for the wrong
   *  half of a line is the mistake a desk cannot see in its own column. */
  const PL1 = await raisePayout("the office puts the driver's run under it, on a mobile rail",
    manual({ payee_kind: "driver", payee_id: driver, rail_code: "mpesa", amount: 25000,
      fee_amount: 500, batch_id: BR1, payee_ref_encrypted: PHONE, payee_ref_tail: "1111",
      payee_ref_hash: HASH64 }));
  const PL2 = await raisePayout("…the staff member's salary on the bank rail",
    manual({ payee_kind: "staff", payee_id: staff, rail_code: "bank", amount: 18000,
      fee_amount: 500, batch_id: BR1, payee_ref_encrypted: ACCT, payee_ref_tail: "0042",
      payee_ref_hash: HASH64 }));
  const PL3 = await raisePayout("…and a name the desk typed for itself, handed over at the counter",
    manual({ payee_kind: "other", payee_name: "Shape Probe Stranger", amount: 47500,
      fee_amount: 500, batch_id: BR1 }));
  const pids = [PL1, PL2, PL3].map((r) => String(r?.payout?.id ?? ""));
  check("…three lines standing under one paper, each with the batch on it and each still waiting for "
    + "a signature of its own", [PL1, PL2, PL3].every((r) => r?.ok === true)
    && pids.every((s) => s.length > 30)
    && (await one(`select count(*)::int as n from money_payouts where batch_id = $1::uuid
        and status = 'raised'`, [BR1])).n === 3, pids);
  const lineRefs = (await one(`select array_agg(p.ref order by a.ord) as refs from money_payouts p
      join unnest(array[$1::uuid, $2::uuid, $3::uuid]) with ordinality as a(id, ord)
        on a.id = p.id`, pids)) as Book;
  const lRef = (n: number) => String(lineRefs.refs[n - 1]);

  const d0 = await call("the batch's own detail sums its lines and sets them beside the figure it was "
    + "signed for", B_DETAIL, [PLAT, BR1]) as Book;
  check("…which for an unsigned draft says the two do not agree: the column the seat will sign is "
    + "still zero while three lines stand under it waiting to be totalled",
    d0?.lines_now === 3 && Number(d0?.sum_now) === 92000 && Number(d0?.signed_sum) === 0
    && d0?.figures_agree === false && d0?.by_status?.raised === 3 && d0?.approval === null,
    { lines: d0?.lines_now, sum: d0?.sum_now, signed: d0?.signed_sum, agree: d0?.figures_agree });
  note("134: `money_payout_batch_detail` sums EVERY line under the batch whatever its state, so a "
    + "draft reads `figures_agree false` before anybody has done anything wrong. The flag is honest "
    + "about the paper and the money, but it is not a warning about the signed figure alone — see "
    + "below, where a refused batch reads the flag true while it owes nobody anything.");

  await raiseRefuses("a line aimed at a batch the office never minted is answered before its own "
    + "paper is written", manual({ payee_kind: "other", payee_name: BOOK("Stranger"),
      batch_id: NO_BODY, amount: 10000 }), "batch_not_found");
  const bCur = await raiseRefuses("…and a dollar line aimed at a shilling batch is answered with the "
    + "batch's own money", manual({ payee_kind: "other", payee_name: BOOK("Stranger"),
      batch_id: BR1, currency: "USD", amount: 10000 }), "batch_currency");
  check("…because a batch that could hold two moneys could not be signed as one total, and the desk "
    + "is told which of its two choices is the wrong one", bCur?.batch_currency === "TZS"
    && /one money/.test(String(bCur?.message)), bCur);

  await refuses("propose_money_payout_batch asks its seat question before it looks at the paper",
    PROPOSE_PB, [PLAT, BR1, BREASON, COMPANY_USER, "director", "127.0.0.1", "gate"], "not_a_seat");
  await refuses("…and its reason is the sentence the second seat signs, so it has a length",
    PROPOSE_PB, [PLAT, BR1, "sign it", PEN, SEAT_ROLE, "127.0.0.1", "gate"], "bad_reason");
  const longReason = await refuses("…and a reason past six hundred characters is answered rather than "
    + "quietly cut", PROPOSE_PB, [PLAT, BR1, "x".repeat(601), PEN, SEAT_ROLE, "127.0.0.1", "gate"],
    "bad_reason");
  check("…with the pair of numbers the door's own sentence gives, because a cut reason would be a "
    + "different paper than the one the seat read", /8-600 characters/.test(String(longReason?.message)),
    longReason);

  const prop1 = await call("a platform seat asks a second seat to sign the whole batch as one "
    + "sentence", PROPOSE_PB, [PLAT, BR1, BREASON, PEN, SEAT_ROLE, "127.0.0.1", "gate"]);
  const PAP1 = String(prop1?.approval_id ?? "");
  check("…and the door answers with the signature it wrote, the paper it stands for and the figure it "
    + "copied off the lines", prop1?.ok === true && isUuid(PAP1) && prop1?.action === "money.payout"
    && prop1?.target_kind === "payout_batch" && String(prop1?.target_id) === BR1
    && Number(prop1?.total_amount) === 92000 && prop1?.lines === 3 && prop1?.currency === "TZS"
    && /^[0-9a-f]{64}$/.test(String(prop1?.payload_sha256)), prop1);
  const b1sig = await row("money_payout_batches", BR1);
  check("…and the batch is no longer a draft: the total, the count, the sentence and the signature are "
    + "all facts on the paper itself", b1sig.status === "pending_signature"
    && Number(b1sig.total_amount) === 92000 && Number(b1sig.lines) === 3
    && String(b1sig.reason) === BREASON && String(b1sig.approval_id) === PAP1
    && b1sig.released_by === null, b1sig);
  const papRow = await apRow(PAP1);
  check("…and the register holds one line a second seat can read: who asked, in what words, and what "
    + "the office is asking to be signed", papRow.status === "pending"
    && String(papRow.proposed_by) === PEN && String(papRow.reason) === BREASON
    && papRow.action === "money.payout" && papRow.target_kind === "payout_batch"
    && String(papRow.target_id) === BR1 && papRow.decided_by === null, papRow);
  const pay = papRow.payload ?? {};
  check("…whose payload is the nine words a seat needs and nothing else — the paper's number and name, "
    + "its money, the total, the count, the office's whole cut, one line per payee and the seat that "
    + "raised it", same(Object.keys(pay), ["batch_id", "ref", "label", "currency", "total_amount",
      "lines", "fee_total", "pays", "raised_by_name"]) && pay.ref === b1sig.ref
    && pay.currency === "TZS" && pay.total_amount === "92000.00" && pay.fee_total === "1500.00"
    && pay.lines === 3 && pay.raised_by_name === SEAT("Pen")
    && String(pay.batch_id) === BR1, Object.keys(pay));
  const pays = (pay.pays ?? []) as Book[];
  check("…with one entry per line ordered by the payee's name rather than by the order the desk typed "
    + "them, so the paper a seat reads is the same paper whoever raised it", pays.length === 3
    && pays.map((p) => p.payee).join("|")
      === [DRIVER_NAME, STAFF_NAME, "Shape Probe Stranger"].join("|"),
    pays.map((p) => `${p.payee}:${p.amount}`));
  check("…each carrying its own number, its figure, the office's cut and the rail it leaves by — and "
    + "no payee id, no sealed line and no hash, because a signature has to name who is paid without "
    + "putting an account number into a register every desk reads",
    pays.every((p) => same(Object.keys(p), ["ref", "payee", "amount", "fee", "rail"]))
    && pays.map((p) => p.amount).join(",") === "25000.00,18000.00,47500.00"
    && pays.map((p) => p.fee).join(",") === "500.00,500.00,500.00"
    && pays.map((p) => p.rail).join(",") === "mpesa,bank,cash"
    && pays.map((p) => p.ref).join(",") === [lRef(1), lRef(2), lRef(3)].join(","), pays);
  check("…and the bytes the signature is taken of still agree with the hash the register carries",
    await hashAgrees(PAP1), await apRow(PAP1));
  const exp7 = await one(`select (extract(epoch from (expires_at - now())) between 6*86400
      and 7*86400 + 60) as week, (expires_at > proposed_at) as after
      from platform_approvals where id = $1::uuid`, [PAP1]) as Book;
  check("…which is set to lapse in the same seven days 121 gives every other paper in the register: a "
    + "batch that waits a month for a signature is a batch nobody in the office remembers raising",
    exp7.week === true && exp7.after === true, exp7);
  const pAud = await audOf("money_payout_batches", BR1, "payout_batch.proposed");
  check("…and the audit keeps both halves — the draft as it stood, its empty signature printed as a "
    + "null rather than dropped, and the signed paper with the seat's own name on it",
    String(pAud.before?.status) === "open" && Number(pAud.before?.total_amount) === 0
    && "approval_id" in (pAud.before ?? {}) && pAud.before?.approval_id === null
    && String(pAud.after?.approval_id) === PAP1 && pAud.after?.status === "pending_signature"
    && Number(pAud.after?.total_amount) === 92000 && String(pAud.after?.reason) === BREASON
    && String(pAud.after?.proposed_name) === SEAT("Pen"), pAud);
  const d1 = await call("…and the detail now prints the figure beside the lines it was cut from",
    B_DETAIL, [PLAT, BR1]) as Book;
  check("…which agree, with the signature itself attached so a desk can show a caller who was asked",
    d1?.figures_agree === true && Number(d1?.sum_now) === 92000 && Number(d1?.signed_sum) === 92000
    && String(d1?.approval?.id) === PAP1 && d1?.approval?.status === "pending"
    && String(d1?.approval?.proposed_by) === SEAT("Pen"), { agree: d1?.figures_agree,
      approval: d1?.approval });
  const askTwice = await refuses("asking the same batch for a second signature while the first is still "
    + "waiting is answered, not queued", PROPOSE_PB,
    [PLAT, BR1, BREASON, QUILL, SEAT_ROLE, "127.0.0.1", "gate"], "already_open");
  check("…and the answer names the open paper, which is the only way a desk can point the second seat "
    + "at the signature instead of writing a competing one",
    String(askTwice?.approval_id) === PAP1 && askTwice?.approval_status === "pending"
    && /already stands open/.test(String(askTwice?.message)), askTwice);
  check("…and the register still holds exactly one signature for the batch, still waiting",
    (await papN(BR1)).n === 1 && (await papN(BR1)).waiting === 1, await papN(BR1));
  await refuses("nothing is added to a batch that has asked, through the door either", RAISE_P,
    payoutArgs(manual({ payee_kind: "other", payee_name: BOOK("Stranger"), batch_id: BR1,
      amount: 10000 }), PEN), "batch_closed");

  /** The six figures a signed paper keeps. Each is a different way a hand could leave the second seat's
   *  answer standing on a different number than the one it gave, and each is refused in the batch's own
   *  words with the frozen figures printed back. */
  const FIG_HANDS: [string, string, any[]][] = [
    ["the total the second seat signed",
      `update money_payout_batches set total_amount = 92001 where id = $1::uuid`, [BR1]],
    ["the number of lines standing under it",
      `update money_payout_batches set lines = 4 where id = $1::uuid`, [BR1]],
    ["the name of the paper",
      `update money_payout_batches set label = $2 where id = $1::uuid`,
      [BR1, MEMO("renamed after the signature")]],
    ["the money it is made in",
      `update money_payout_batches set currency = 'USD' where id = $1::uuid`, [BR1]],
    ["the signature it stands on",
      `update money_payout_batches set approval_id = $2::uuid where id = $1::uuid`, [BR1, NO_BODY]],
    ["the sentence that was signed",
      `update money_payout_batches set reason = $2 where id = $1::uuid`,
      [BR1, MEMO("a different sentence, written after the seat answered")]]
  ];
  for (const [n, [what, sql, p]] of FIG_HANDS.entries()) {
    const e = await fails(`a hand that edits ${what} under a signature is stopped`, sql, p,
      "the signed total does not move");
    if (n === 0) check("…and the sentence prints the paper exactly as it was signed — pending_signature "
      + "carrying 3 line(s) for 92000.00 TZS — rather than as the hand would leave it, so the desk "
      + "reads back the figure the seat answered for",
      /is pending_signature carrying 3 line\(s\) for 92000\.00 TZS/
        .test(String(e?.message)) && String(e?.message).includes(String(b1sig.ref)), e?.message);
  }
  const noteOk = await okDo("…while the hand CAN still write the note the desk keeps for itself, which "
    + "is the column list's own answer: the guard freezes six words and nothing else",
    `update money_payout_batches set closed_note = $2 where id = $1::uuid returning closed_note`,
    [BR1, MEMO("a note that moves no figure")]);
  check("…which is a finding worth keeping in front of a desk: a batch that has never been closed can "
    + "carry a closed note, and no CHECK ties the two — the sentence the payees are given is the "
    + "batch's, not the closure's", String((noteOk?.[0] as Book)?.closed_note)
      === MEMO("a note that moves no figure"), noteOk?.[0]);

  /** The three membership arms, from both edges. These are the arms 134 shipped dead, and the reason "
   *  they were dead is that `<>` answers NULL rather than true whenever either side is NULL — which is
   *  every join and every leave there is. */
  const leaveErr = await fails("a hand cannot pull a line out of the batch it was raised under once "
    + "the batch has asked for a signature",
    `update money_payouts set batch_id = null where id = $1::uuid`, [pids[0]], "and stays in it");
  check("…and the sentence names the batch the line came FROM: 134 wrote it with the destination, so "
    + "the words a clerk read out said the paper the line was going to rather than the one it refused "
    + "to leave", String(leaveErr?.message).includes(lRef(1))
    && String(leaveErr?.message).includes(`${b1sig.ref} and stays in it`), leaveErr?.message);
  await fails("…nor moved across to a second batch: a line belongs where it was raised, whatever the "
    + "other paper's state", `update money_payouts set batch_id = $2::uuid where id = $1::uuid`,
    [pids[0], BR2], "and stays in it");
  const joinErr = await fails("…and a line from outside cannot be pushed into a batch that has "
    + "already asked — the release loop pays every line it finds under a spent signature, so a line "
    + "added after the answer would be money nobody signed",
    `update money_payouts set batch_id = $2::uuid where id = $1::uuid`,
    [String(PCO?.payout?.id), BR1], "nothing is added to a batch");
  check("…which is the joining edge of the same dead comparison, and the sentence names the batch it "
    + "was refused entry to and its state", String(joinErr?.message).includes(String(b1sig.ref))
    && /pending_signature/.test(String(joinErr?.message)), joinErr?.message);
  await handP("a paper written by hand straight under a signed batch is stopped at the same gate, "
    + "before anything is read about its lines or its rails",
    { batch_id: BR1, payee_kind: "other", payee_name: "Shape Probe Stranger" },
    "nothing is added to a batch");
  const mismatch = await handP("…and a dollar line written under a shilling batch is stopped by the "
    + "money rather than the state, because the money is asked first",
    { batch_id: BR1, currency: "USD", payee_kind: "other", payee_name: "Shape Probe Stranger" },
    "is a TZS batch");
  check("…printing both numbers in the order the sentence reads them, so a clerk can see which of the "
    + "two is the one to change",
    new RegExp(`is a TZS batch and PAY-[0-9]{4}-[0-9]{5,} is a USD line`).test(String(mismatch?.message))
    && String(mismatch?.message).includes(String(b1sig.ref)), mismatch?.message);
  await handP("…and a batch id the office has never minted is named as nothing the register has",
    { batch_id: NO_BODY }, "names a batch the office does not have");

  await refuses("decline_money_payout is asked of a seat before it is asked of a paper", DECLINE_P,
    [PLAT, pids[0], REFUSE, COMPANY_USER, "director", "127.0.0.1", "gate"], "not_a_seat");
  await refuses("…and with a sentence long enough to read out to the payee", DECLINE_P,
    [PLAT, pids[0], "nope", ASH, SEAT_ROLE, "127.0.0.1", "gate"], "bad_note");
  await refuses("the same two questions are asked of a whole batch", DECLINE_PB,
    [PLAT, BR1, REFUSE, COMPANY_USER, "director", "127.0.0.1", "gate"], "not_a_seat");
  await refuses("…whose note is the sentence every payee under it is given, so it has the same "
    + "length", DECLINE_PB, [PLAT, BR1, "nope", ASH, SEAT_ROLE, "127.0.0.1", "gate"], "bad_note");
  const susp = await refuses("…and a seat the office has struck off its roster cannot answer for it "
    + "either", DECLINE_PB, [PLAT, BR1, REFUSE, SUSPENDED_SEAT, SEAT_ROLE, "127.0.0.1", "gate"],
    "not_a_seat");
  check("…because 121's `approval_seat` asks for a live platform person, and it is asked before the "
    + "batch is looked at", /live platform seat/.test(String(susp?.message)), susp);
  const inB = await refuses("a single line inside a signed batch cannot be refused on its own: the "
    + "batch is one answer", DECLINE_P, [PLAT, pids[0], REFUSE, ASH, SEAT_ROLE, "127.0.0.1", "gate"],
    "in_a_signed_batch");
  check("…and the desk is told which paper holds it and where to take the refusal instead",
    String(inB?.batch_ref) === String(b1sig.ref)
    && /Refuse the batch/.test(String(inB?.message)), inB);
  /** All four approval doors answer `not_found` about a paper in somebody else's book. None of them
   *  asks the office question first — unlike the six write doors of phase 3, which raise — so the
   *  answer a CFA desk gets for a uuid it has no business holding is the same one it would get for a
   *  paper the office has deleted. */
  for (const [door, sql, head] of [
    ["propose_money_payout_batch", PROPOSE_PB, [BR1, BREASON, ASH]],
    ["decline_money_payout_batch", DECLINE_PB, [BR1, REFUSE, ASH]],
    ["propose_money_payout", PROPOSE_P, [pids[0], BREASON, ASH]],
    ["decline_money_payout", DECLINE_P, [pids[0], REFUSE, ASH]]
  ] as [string, string, any[]][]) {
    await refuses(`${door} asked about a paper in a book that is not the office's answers that there `
      + "is nothing there, with no trace of whose paper it was", sql,
      [holderA, ...head, SEAT_ROLE, "127.0.0.1", "gate"], "not_found");
  }

  const pstrId = String(PSTR?.payout?.id ?? "");
  const pProp = await call("a line that stands in no batch is signed on its own paper", PROPOSE_P,
    [PLAT, pstrId, BREASON, PEN, SEAT_ROLE, "127.0.0.1", "gate"]);
  const PSTRAP = String(pProp?.approval_id ?? "");
  check("…which is written against the payout rather than the batch, so the two shapes of signature "
    + "cannot be spent on each other", pProp?.ok === true && pProp?.target_kind === "payout"
    && String(pProp?.target_id) === pstrId && Number(pProp?.amount) === 20000
    && isUuid(PSTRAP), pProp);
  const selfNo = await refuses("the seat that raised a batch cannot be the one that refuses it: a "
    + "signature is a second seat's answer, not a repeat of the first seat's", DECLINE_PB,
    [PLAT, BR1, REFUSE, PEN, SEAT_ROLE, "127.0.0.1", "gate"], "refused_the_signature_first");
  check("…and 121's own word is carried inside the answer, so the desk can say who has to sign",
    selfNo?.approval_answer?.status === "self"
    && /Ask a second person/.test(String(selfNo?.approval_answer?.message)), selfNo);
  check("…nothing moved: the batch still stands on its open signature and all three lines are still "
    + "raised under it", (await row("money_payout_batches", BR1)).status === "pending_signature"
    && (await apRow(PAP1)).status === "pending"
    && (await one(`select count(*)::int as n from money_payouts where batch_id = $1::uuid
        and status = 'raised'`, [BR1])).n === 3, await papN(BR1));
  await refuses("…the same seat cannot refuse a single line it signed either, for the same reason",
    DECLINE_P, [PLAT, pstrId, REFUSE, PEN, SEAT_ROLE, "127.0.0.1", "gate"],
    "refused_the_signature_first");

  const no = await call("a second seat refuses the whole batch in one answer", DECLINE_PB,
    [PLAT, BR1, REFUSE, ASH, SEAT_ROLE, "127.0.0.1", "gate"]);
  check("…which stamps every line under it and hands the paper back to the board as a draft",
    no?.ok === true && no?.lines_declined === 3 && String(no?.approval_id) === PAP1
    && (await row("money_payout_batches", BR1)).status === "open", no);
  const after = await row("money_payout_batches", BR1);
  check("…keeping the signature it was refused under on the paper, and the figure it was refused with "
    + "— the guard forbids a signed batch's approval from moving, and a refusal is an answer about "
    + "that exact paper", String(after.approval_id) === PAP1
    && Number(after.total_amount) === 92000 && Number(after.lines) === 3
    && String(after.reason) === BREASON && after.status === "open", after);
  const decl = await one(`select count(*)::int as n from money_payouts where batch_id = $1::uuid
      and status = 'declined' and declined_by = $2::uuid and declined_note = $3`,
    [BR1, ASH, REFUSE]);
  check("…every one of them declined by the seat that answered, each carrying the sentence the desk "
    + "will read out to its payee", Number(decl.n) === 3, decl);
  const apNo = await apRow(PAP1);
  check("…and the signature is answered in 121's register as a rejection by that second seat — kept, "
    + "not deleted, and not left waiting for anybody", apNo.status === "rejected"
    && String(apNo.decided_by) === ASH && String(apNo.decided_note) === REFUSE
    && !!apNo.decided_at, apNo);
  const rAud = await audOf("money_payout_batches", BR1, "payout_batch.refused");
  check("…with one audit line for the batch and the count it stamped inside it, so the register says "
    + "how many people were turned away by this single answer",
    String(rAud.actor_user_id) === ASH && rAud.before?.status === "pending_signature"
    && Number(rAud.before?.total_amount) === 92000 && Number(rAud.after?.lines_declined) === 3
    && rAud.after?.status === "open" && String(rAud.after?.refused_name) === SEAT("Ash")
    && rAud.after?.payload_sha256 === apNo.payload_sha256, rAud);
  const d2 = await call("…and the refused batch's own detail sums the three lines it no longer owes",
    B_DETAIL, [PLAT, BR1]) as Book;
  check("…which is the other half of that `figures_agree` finding: three refused lines still add up to "
    + "the signed total, so a batch that owes nobody anything reads as agreeing",
    d2?.figures_agree === true && d2?.lines_now === 3 && d2?.by_status?.declined === 3
    && d2?.by_status?.raised === undefined && Number(d2?.sum_now) === 92000,
    { agree: d2?.figures_agree, by: d2?.by_status });
  await refuses("a batch back on the board as a draft cannot be refused a second time", DECLINE_PB,
    [PLAT, BR1, REFUSE, ASH, SEAT_ROLE, "127.0.0.1", "gate"], "conflict");
  const emptyAgain = await refuses("…and re-proposing it now asks for a signature over nothing, "
    + "because no line standing under it is still raised", PROPOSE_PB,
    [PLAT, BR1, BREASON, PEN, SEAT_ROLE, "127.0.0.1", "gate"], "empty_batch");
  check("…with the sentence that says what a batch needs before it can be signed, and the paper's own "
    + "number beside it", /A batch of nothing/.test(String(emptyAgain?.message))
    && String(emptyAgain?.ref) === String(after.ref), emptyAgain);
  check("…and the register still holds the one refused signature: a draft refused is a paper answered, "
    + "not a paper asked twice", (await papN(BR1)).n === 1 && (await papN(BR1)).waiting === 0,
    await papN(BR1));

  const pdrId = String(PDR?.payout?.id ?? "");
  const pstId = String(PST?.payout?.id ?? "");
  const joinA = await okDo("a line put under a batch that is a draft again stands — the same edge the "
    + "guard refused above, refused only while the paper is signed",
    `update money_payouts set batch_id = $2::uuid where id = $1::uuid returning id`,
    [pdrId, BR1]);
  check("…which is the guard's own answer for a draft, in the direction the office actually works",
    String((joinA?.[0] as Book)?.id) === pdrId, joinA?.[0]);
  await okDo("…and the staff line joins it the same way",
    `update money_payouts set batch_id = $2::uuid where id = $1::uuid`, [pstId, BR1]);
  const prop2 = await call("the batch is cut again, and signed for the two lines that stand raised "
    + "under it now", PROPOSE_PB, [PLAT, BR1, BREASON, PEN, SEAT_ROLE, "127.0.0.1", "gate"]);
  const PAP2 = String(prop2?.approval_id ?? "");
  check("…which is a NEW signature rather than the refused one rewritten: 121 keeps one row per answer "
    + "and the trail of a refused batch is two papers", prop2?.ok === true && isUuid(PAP2)
    && PAP2 !== PAP1 && Number(prop2?.total_amount) === 40000 && prop2?.lines === 2
    && (await papN(BR1)).n === 2 && (await papN(BR1)).waiting === 1, await papN(BR1));
  const b1again = await row("money_payout_batches", BR1);
  check("…written by the two statements the door needs: the batch first goes back to being a draft on "
    + "its own, because its own guard will not let a refused paper's figures move under a signature",
    b1again.status === "pending_signature" && String(b1again.approval_id) === PAP2
    && Number(b1again.total_amount) === 40000 && Number(b1again.lines) === 2
    && (await apRow(PAP1)).status === "rejected" && (await apRow(PAP2)).status === "pending", b1again);
  check("…and the figure it is signed for is the two lines rather than the five standing under it — "
    + "the refused ones stay as history, and the total is cut only from what is still raised",
    (await one(`select count(*)::int as n from money_payouts where batch_id = $1::uuid`, [BR1])).n === 5
    && Number(b1again.total_amount) === 40000
    && (await one(`select sum(amount + fee_amount)::numeric(14,2) as s from money_payouts
        where batch_id = $1::uuid`, [BR1])).s === "132000.00", b1again);
  const d3 = await call("…which is what the detail then reads back as a disagreement", B_DETAIL,
    [PLAT, BR1]) as Book;
  check("…and the desk is right to flag it and wrong to panic: the signed figure matches the lines that "
    + "were signed, and the sum beside it counts the payees who were already turned away",
    d3?.figures_agree === false && Number(d3?.sum_now) === 132000
    && Number(d3?.signed_sum) === 40000 && d3?.by_status?.declined === 3
    && d3?.by_status?.raised === 2, { by: d3?.by_status, sum: d3?.sum_now });
  note("134: a batch that has refused once and been cut again keeps its refused lines under itself, so "
    + "`money_payout_batch_detail` reports `figures_agree false` for a paper whose signed total is "
    + "exactly right. The flag is a comparison of the total column with every line in the register, not "
    + "with the lines the signature covered; a desk that treats it as an alarm needs the `by_status` "
    + "beside it, and the board's own `outstanding` is the column that answers the real question.");

  const noLine = await call("a single line signed on its own paper is refused by a second seat, and "
    + "the signature is answered with the same words", DECLINE_P,
    [PLAT, pstrId, REFUSE, ASH, SEAT_ROLE, "127.0.0.1", "gate"]);
  check("…which returns the row rather than a count — one answer turns one paper away", noLine?.ok
    === true && noLine?.payout?.status === "declined"
    && String((await row("money_payouts", pstrId)).declined_by) === ASH, noLine);
  check("…and 121's register holds that refusal as a rejection of the payout's own signature",
    (await apRow(PSTRAP)).status === "rejected"
    && String((await apRow(PSTRAP)).decided_by) === ASH, await apRow(PSTRAP));
  await refuses("…a payout that has answered is not refused twice", DECLINE_P,
    [PLAT, pstrId, REFUSE, ASH, SEAT_ROLE, "127.0.0.1", "gate"], "conflict");
  await refuses("…and neither is it signed again", PROPOSE_P,
    [PLAT, pstrId, BREASON, PEN, SEAT_ROLE, "127.0.0.1", "gate"], "conflict");
  const pDeclAud = await audOf("money_payouts", pstrId, "payout.declined");
  check("…with the line's own audit carrying both the paper it stood on and the seat that answered, so "
    + "a declined payout can be explained without opening the register",
    String(pDeclAud.actor_user_id) === ASH && pDeclAud.before?.status === "pending_signature"
    && String(pDeclAud.before?.approval_id) === PSTRAP && pDeclAud.after?.status === "declined"
    && String(pDeclAud.after?.declined_name) === SEAT("Ash"), pDeclAud);

  const pcoId = String(PCO?.payout?.id ?? "");
  await okDo("a company's line joins the second batch while it is still a draft",
    `update money_payouts set batch_id = $2::uuid where id = $1::uuid`, [pcoId, BR2]);
  /** The register's unique index is the half of the rule that survives two desks pressing the button in
   *  the same second, and the door's exception branch is the half that turns it into a sentence. To
   *  reach it the signature has to be open while the paper still reads as a draft — a state only a hand
   *  can leave behind, which is exactly the race the index was written for. */
  const aHand = (await one(`insert into platform_approvals (id, action, target_kind, target_id,
        payload, payload_sha256, reason, status, proposed_by, proposed_role, expires_at)
      values (gen_random_uuid(), 'money.payout', 'payout_batch', $1::text, '{}', repeat('0', 64),
        'A signature written by a hand, not by the door.', 'pending', $2, 'finance_officer',
        now() + interval '7 days') returning id`, [BR2, PEN])).id as string;
  const handDup = await refuses("a batch whose signature was written by a hand, while the paper itself "
    + "still reads as a draft, is not asked twice: the register's unique index answers first",
    PROPOSE_PB, [PLAT, BR2, BREASON, PEN, SEAT_ROLE, "127.0.0.1", "gate"], "already_open");
  check("…and the door's exception branch names the open paper it found, which is the only way a desk "
    + "can tell the seat waiting on it where to look", String(handDup?.open_id) === aHand
    && /already open and waiting/.test(String(handDup?.message)), handDup);
  const b2now = await row("money_payout_batches", BR2);
  check("…which leaves the batch exactly where it was — still a draft, no figure cut into it, no "
    + "signature on it — because the door never got past its own insert", b2now.status === "open"
    && Number(b2now.total_amount) === 0 && b2now.approval_id === null, b2now);
  await okDo("…and the hand-made signature is taken back off the register",
    `delete from platform_approvals where id = $1::uuid`, [aHand]);
  const cOpen = await refuses("close_money_payout_batch is only an answer about a batch that has spent "
    + "its signature", CLOSE_B, [PLAT, BR2, NOTE, ASH, SEAT_ROLE, "127.0.0.1", "gate"], "conflict");
  check("…which says so in the words that name the door's own order: closed from the signature, not "
    + "from the board", /not from the board/.test(String(cOpen?.message))
    && cOpen?.batch_status === "open" && String(cOpen?.ref) === String(b2now.ref), cOpen);
  await fails("…and a hand that tries to skip that order is stopped by the batch's own guard",
    `update money_payout_batches set status = 'closed', closed_by = $2::uuid, closed_at = now()
       where id = $1::uuid`, [BR2, ASH], "is still a draft");
  const delDraft = await fails("a draft that has lines under it is kept — and the guard's words say "
    + "the lines are the reason while blaming a signature that was never asked",
    `delete from money_payout_batches where id = $1::uuid`, [BR2], "holds 1 line(s)");
  check("…which is the sentence worth reading closely: `is open and holds 1 line(s)` is the count "
    + "speaking, not the state", /is open and holds 1 line\(s\)/.test(String(delDraft?.message)),
    delDraft?.message);
  await refuses("close_money_payout_batch asks for a sentence before it looks for the batch", CLOSE_B,
    [PLAT, NO_BODY, "no", ASH, SEAT_ROLE, "127.0.0.1", "gate"], "bad_note");
  await refuses("…and answers that there is nothing to close before it asks anything about a state",
    CLOSE_B, [PLAT, NO_BODY, NOTE, ASH, SEAT_ROLE, "127.0.0.1", "gate"], "not_found");

  /** A batch walked to `released` without burning a real signature: phase 12 spends the release door "
   *  for real, and the arms that need a spent or closed paper — propose's conflict, the frozen figures "
   *  under a spent signature, close's outstanding count and the delete guard's third state — are all "
   *  reached here instead. */
  const LONG_LABEL = MEMO("a name the desk typed at full length, because the office pays the corridor "
    + "runs of the quarter under this batch and one more clause than the column can hold");
  const b4r = await openB("a third paper is opened by a hand that is not a platform seat at all, with "
    + "a name longer than the column", LONG_LABEL, "tzs", COMPANY_USER);
  const BR4 = String(b4r?.batch?.id ?? "");
  const b4 = await row("money_payout_batches", BR4);
  check("…which 134 lets stand: `open_money_payout_batch` asks its book question, then its two "
    + "word-questions, and never asks who is holding the pen — so a company's own seat would mint a "
    + "draft in the office's book if the duty key ever let it reach the door",
    b4r?.ok === true && String(b4.raised_by) === COMPANY_USER && b4.status === "open", b4);
  check("…with the name cut to the eighty characters the column holds rather than refused, because a "
    + "batch is named by a person typing into a form", String(b4.label).length === 80
    && String(b4.label) === LONG_LABEL.trim().slice(0, 80), b4.label);
  const delEmpty = await okDo("…and a draft with nothing under it and no signature asked is the one "
    + "batch the office may still take off its own register",
    `delete from money_payout_batches where id = $1::uuid returning id`, [BR4]);
  check("…which the guard answers by letting it go, so a mis-typed batch is not a permanent row",
    String((delEmpty?.[0] as Book)?.id) === BR4
    && !(await one(`select count(*)::int as n from money_payout_batches where id = $1::uuid`,
      [BR4])).n, delEmpty);

  const b3r = await openB("a batch is opened to carry the closed company's line", MEMO("Batch three"));
  const BR3 = String(b3r?.batch?.id ?? "");
  const leftId = String(pLeftCo?.payout?.id ?? "");
  await okDo("…the line stands under it while the paper is a draft, which is the only window the "
    + "guard gives", `update money_payouts set batch_id = $2::uuid where id = $1::uuid`,
    [leftId, BR3]);
  const aRel = (await one(`insert into platform_approvals (id, action, target_kind, target_id,
        payload, payload_sha256, reason, status, proposed_by, proposed_role, decided_by, decided_role,
        decided_at, expires_at)
      values (gen_random_uuid(), 'money.payout', 'payout_batch', $1::text, '{}', repeat('0', 64),
        'A signature a hand wrote so that the spent-paper arms below can be reached.', 'approved', $2,
        'finance_officer', $3, 'finance_officer', now(), now() + interval '7 days') returning id`,
    [BR3, PEN, ASH])).id as string;
  const rel = await okDo("the gate then walks the paper to `released` by hand, because the only door "
    + "that releases one is the effect of a signature spent through 121 — and phase 12 walks that door "
    + "for real", `update money_payout_batches set status = 'released', reason = $2,
      total_amount = 15000, lines = 1, approval_id = $3::uuid, released_by = $4::uuid,
      released_at = now() where id = $1::uuid returning status, released_at is not null as stamped`,
    [BR3, BREASON, aRel, ASH]);
  check("…which the batch's own guards allow: nothing on the table forbids a hand from stamping a "
    + "batch released. The two-seat rule is written on the LINES, so a batch is only as spent as the "
    + "payouts under it — and 134 has no guard of its own on `money_payout_batches`'s state",
    (rel?.[0] as Book)?.status === "released" && (rel?.[0] as Book)?.stamped === true, rel?.[0]);
  const relRow = await row("money_payout_batches", BR3);
  check("…and the row's own CHECKs are what keep that hand honest: a released paper must name its "
    + "signature, the seat that spent it and the moment it was spent, and it cannot be a paper of "
    + "nothing", String(relRow.approval_id) === aRel && String(relRow.released_by) === ASH
    && !!relRow.released_at && Number(relRow.total_amount) === 15000 && Number(relRow.lines) === 1
    && String(relRow.reason) === BREASON, relRow);
  const spent = await refuses("a batch that has spent its signature is not asked for another one",
    PROPOSE_PB, [PLAT, BR3, BREASON, PEN, SEAT_ROLE, "127.0.0.1", "gate"], "conflict");
  check("…with the state printed beside it, because the desk has to be able to say what the paper is "
    + "waiting for instead", spent?.batch_status === "released"
    && /spent its signature/.test(String(spent?.message)), spent);
  const cOut = await refuses("…and it is not closed while a line under it still waits for the cash",
    CLOSE_B, [PLAT, BR3, NOTE, ASH, SEAT_ROLE, "127.0.0.1", "gate"], "lines_outstanding");
  check("…with the count of what is still owed printed in the answer, because the desk has to say how "
    + "many payees are still waiting", cOut?.outstanding === 1
    && /still owes an answer/.test(String(cOut?.message)), cOut);
  check("…which is a dead end the guards make between them: a batch released by a hand has lines no "
    + "door can answer — `decline_money_payout` refuses them for standing in a signed batch and "
    + "`mark_money_payout_paid` refuses them for not being released — so the paper can only be ended "
    + "by another hand", cOut?.ok === false
    && (await one(`select status from money_payouts where id = $1::uuid`, [leftId])).status === "raised",
    cOut);
  await fails("a released batch does not go back to being a draft: the paper spent a signature and so "
    + "did the seat that signed it", `update money_payout_batches set status = 'open'
      where id = $1::uuid`, [BR3], "does not go back to a draft");
  await fails("…nor does its figure move now that it is spent",
    `update money_payout_batches set total_amount = 1 where id = $1::uuid`, [BR3],
    "the signed total does not move");
  const pRel = await fails("…and a line under a released batch cannot be edited under it",
    `update money_payouts set amount = 16000 where id = $1::uuid`, [leftId],
    "cannot be edited under it");
  check("…in the pair of names the batch guard writes: the batch owns the signature and the line owns "
    + "the total it cannot move", String(pRel?.message).includes(String(relRow.ref))
    && String(pRel?.message).includes("PAY-"), pRel?.message);
  await fails("…nor pulled out of a spent batch", `update money_payouts set batch_id = null
    where id = $1::uuid`, [leftId], "and stays in it");
  /** The joining edge needs a line standing in no batch, and by now every line this gate raised is under
   *  a paper — `pcoId` joined BR2 several checks ago, so pushing it anywhere answers with the leaving
   *  arm. The gate therefore raises a draft of its own, refuses the join, and takes the draft back off
   *  the register: a raised line with no movement is deletable, which is the same arm 12c leans on. */
  const joiner = await raisePayout("a line raised outside every batch is the only one a spent paper can "
    + "be offered to", manual({ payee_kind: "other", payee_name: "Shape Probe Joiner" }));
  const joinerId = String(joiner?.payout?.id ?? "");
  await fails("…nor pushed into one: a line that stands in no batch cannot be made to answer for a "
    + "spent paper", `update money_payouts set batch_id = $2::uuid where id = $1::uuid`,
    [joinerId, BR3], "nothing is added to a batch");
  await okDo("…and the draft raised for that edge is taken back off the register, so the boards below "
    + "count the lines the gate means to count", `delete from money_payouts where id = $1::uuid`,
    [joinerId]);
  const handClose = await okDo("a hand can however close a released batch, which is the state the "
    + "desk's own door leaves a paper in once every line has answered",
    `update money_payout_batches set status = 'closed', closed_by = $2::uuid, closed_at = now(),
       closed_note = $3 where id = $1::uuid returning status`, [BR3, ASH, NOTE]);
  check("…and the paper reads closed, with the note the door would have written on it",
    (handClose?.[0] as Book)?.status === "closed", handClose?.[0]);
  await refuses("…and the door's answer for a batch that is already closed is not a second closing",
    CLOSE_B, [PLAT, BR3, NOTE, ASH, SEAT_ROLE, "127.0.0.1", "gate"], "already_closed");
  await fails("a closed batch that still holds a line is kept, and here the guard's own words speak "
    + "true", `delete from money_payout_batches where id = $1::uuid`, [BR3],
    "is closed and holds 1 line(s)");

  /** The last state a batch can be argued into is one no line backs. It costs a forged signature and a
   *  made-up figure, and it buys the two arms nothing else reaches: the close door's seat question, or "
   *  rather its absence, and a detail read that says the paper lies. */
  const b5r = await openB("a batch opened, released and closed by hands, with no line ever standing "
    + "under it", MEMO("Batch five"));
  const BR5 = String(b5r?.batch?.id ?? "");
  const aFake5 = (await one(`insert into platform_approvals (id, action, target_kind, target_id,
        payload, payload_sha256, reason, status, proposed_by, decided_by, decided_at, expires_at)
      values (gen_random_uuid(), 'money.payout', 'payout_batch', $1::text, '{}', repeat('0', 64),
        'A signature for a batch of nothing.', 'approved', $2, $3, now(),
        now() + interval '7 days') returning id`, [BR5, PEN, ASH])).id as string;
  await okDo("…which a hand can give a total and a line count of its own, because the figures are only "
    + "frozen once the paper has asked", `update money_payout_batches set status = 'released',
      reason = $2, total_amount = 1, lines = 1, approval_id = $3::uuid, released_by = $4::uuid,
      released_at = now() where id = $1::uuid`, [BR5, BREASON, aFake5, ASH]);
  const byStranger = await call("…and closed by the desk's own door under a seat that is not a "
    + "platform seat at all", CLOSE_B,
    [PLAT, BR5, NOTE, COMPANY_USER, "director", "127.0.0.1", "gate"]);
  check("…which the close door answers by closing it: it asks the book question and the note question "
    + "and nothing about who is holding the pen, so `closed_by` on a batch is the id the desk handed, "
    + "not a seat 134 checked", byStranger?.ok === true
    && String((await row("money_payout_batches", BR5)).closed_by) === COMPANY_USER, byStranger);
  const d5 = await call("…and the detail then prints the fiction it was signed for beside the empty "
    + "set of lines behind it", B_DETAIL, [PLAT, BR5]) as Book;
  check("…which is the read doing its job: nothing under the paper agrees with a batch of one line for "
    + "one unit, and no guard could have caught the hand that wrote it",
    d5?.figures_agree === false && d5?.lines_now === 0 && Number(d5?.sum_now) === 0
    && Number(d5?.signed_sum) === 1 && d5?.status === "closed", d5);
  check("…with the closure stamped by the director the door was handed and the board's own sentence",
    String(d5?.closed_by_name) === SEAT("Trader") && String(d5?.closed_note) === NOTE, d5);
  await okDo("…and the made-up paper is taken back off the register once it is closed? No — it is "
    + "kept, which is the guard's last word", `select 1 as kept`);
  /** Not a trigger but 134's own foreign key: a batch that names a signature cannot be left pointing at
   *  a register row that has gone, so the orphan this gate set out to make is the one state a hand is
   *  refused. The delete is kept as a refusal rather than dropped, because it is the only proof that a
   *  spent paper keeps the row it was spent on. */
  const delAp = await fails("…and the hand-made signature behind it cannot be taken off the register at "
    + "all, because the batch names it: `money_payout_batches.approval_id` is a foreign key",
    `delete from platform_approvals where id = $1::uuid`, [aFake5],
    "money_payout_batches_approval_id_fkey", "23503");
  check("…raised as the SQLSTATE the desk maps to a signature that is somebody else's business, not to a "
    + "check the row broke", !!delAp && delAp.code === "23503", delAp?.message);
  check("…which leaves the closed batch standing on a signature the register still holds, and is the "
    + "half of the pair no door had to write: the state on the paper cannot outrive the row it points at",
    String((await row("money_payout_batches", BR5)).approval_id) === aFake5
    && (await one(`select count(*)::int as n from platform_approvals where id = $1::uuid`,
      [aFake5])).n === 1, await row("money_payout_batches", BR5));
  await fails("…and the closed batch itself is kept whatever its lines, because the office paid a "
    + "signature for it", `delete from money_payout_batches where id = $1::uuid`, [BR5],
    "is closed and holds 0 line(s)");
  const delKept = await okDo("the line BR3 carried is however deletable: `payout_is_not_deleted` keeps "
    + "only a paper that has a posting behind it, and this batch spent no money through a door",
    `delete from money_payouts where id = $1::uuid returning ref`, [leftId]);
  check("…which is the half of the pair the gate's own teardown relies on — a raised line with no "
    + "movement is a draft, not a record", String((delKept?.[0] as Book)?.ref ?? "").startsWith("PAY-")
    && !(await one(`select count(*)::int as n from money_payouts where id = $1::uuid`, [leftId])).n,
    delKept);
  note("134: three of the batch doors ask nothing about the seat behind them — "
    + "`open_money_payout_batch`, `close_money_payout_batch` and a hand that writes the row directly "
    + "all stamp a `raised_by`/`closed_by` the schema never checks is a platform seat. Over HTTP each "
    + "is behind `control.money.pay`, so the guard is the duty key rather than the door; the two that "
    + "ask (`propose_money_payout_batch`, `decline_money_payout_batch`) are exactly the two that put a "
    + "signature in 121's register.");

  // ---------------- 12 · the signature a second seat spends ----------------
  phase("12 · money leaves the office only when a spent signature is read back out of 121's register "
    + "and re-compared with the bytes the row still holds");
  /** Everything above this line could only ever *ask* for a release. This is the door 121 calls, and it
   *  is the one body in 134 that turns a signature into a movement — so it is walked for real twice, once
   *  over a single payout and once over a batch, and every arm of its five refusals is met with a paper
   *  written by a hand. `payout_needs_two_seats` is the guard that stands behind the door: a hand that
   *  writes `released` directly is read back through the same register, so the arms below are not a
   *  rehearsal of what the door already refused, they are what a seat with SQL access would meet. */
  const PSIGN = "Signed against the driver's completed corridor run and its receipt.";
  const HAND_PAPER = "A signature this gate wrote by hand to reach the arm behind it.";
  const pmId = String(pm?.payout?.id ?? "");
  const pbId = String(pb?.payout?.id ?? "");
  const PM_REF = String(pmRow?.ref ?? "");
  const PB_REF = String(pbRow?.ref ?? "");
  const handAp = async (over: Book) => String((await one(`insert into platform_approvals (action,
        target_kind, target_id, payload, payload_sha256, reason, status, proposed_by, proposed_role,
        decided_by, decided_role, decided_at, applied_at, expires_at)
      values ($1, $2, $3, $4::jsonb, repeat('0', 64), $5, $6, $7, 'finance_officer', $8,
        'finance_officer', case when $6 = 'pending' then null else now() end,
        case when $6 = 'applied' then now() else null end, now() + interval '7 days')
      returning id`, [over.action, over.target_kind, String(over.target_id),
      JSON.stringify(over.payload ?? {}), over.reason ?? HAND_PAPER, over.status,
      over.proposed ?? PEN, over.decided ?? null])).id);

  await refuses("propose_money_payout refuses a pen that is not a platform seat", PROPOSE_P,
    [PLAT, pmId, PSIGN, COMPANY_USER, "director", "127.0.0.1", "gate"], "not_a_seat");
  const pShort = await refuses("…and a reason too short for a second seat to sign against", PROPOSE_P,
    [PLAT, pmId, "Pay it", PEN, SEAT_ROLE, "127.0.0.1", "gate"], "bad_reason");
  check("…in the words that carry the length, because the reason is not a note the desk keeps to "
    + "itself — it is the sentence that ends up inside the movement's own memo",
    /8-600 characters/.test(String(pShort?.message)), pShort);
  await refuses("…and one past the ceiling the register gives a signature", PROPOSE_P,
    [PLAT, pmId, "S".repeat(601), PEN, SEAT_ROLE, "127.0.0.1", "gate"], "bad_reason");
  await refuses("…a payout the book does not have is answered before anything is asked of the seat",
    PROPOSE_P, [PLAT, NO_BODY, PSIGN, PEN, SEAT_ROLE, "127.0.0.1", "gate"], "not_found");
  const pInBatch = await refuses("a line that stands in a batch is signed with it, never on its own "
    + "paper, because two signatures over one payout are two movements", PROPOSE_P,
    [PLAT, pcoId, PSIGN, PEN, SEAT_ROLE, "127.0.0.1", "gate"], "in_a_batch");
  check("…with the batch printed beside the answer, so the desk is sent to the paper that carries it "
    + "rather than told the line is un-signable", String(pInBatch?.batch_id) === BR2, pInBatch);
  const pFinished = await refuses("…and a payout that has already answered is not signed again",
    PROPOSE_P, [PLAT, pstrId, PSIGN, PEN, SEAT_ROLE, "127.0.0.1", "gate"], "conflict");
  check("…with the state the desk would otherwise have had to look up itself",
    pFinished?.payout_status === "declined" && /^PAY-/.test(String(pFinished?.ref))
    && /is finished/.test(String(pFinished?.message)), pFinished);

  const prop = await call("the office asks a second seat to sign one driver's payout", PROPOSE_P,
    [PLAT, pmId, PSIGN, PEN, SEAT_ROLE, "127.0.0.1", "gate"]);
  const PAPP = String(prop?.approval_id ?? "");
  check("…which answers with the eleven words a desk needs to show a signature without opening the "
    + "register: the paper, what it is aimed at, the payout's own number, both figures, the money, the "
    + "hash and the expiry", prop?.ok === true && prop?.action === "money.payout"
    && prop?.target_kind === "payout" && String(prop?.target_id) === pmId
    && String(prop?.ref) === PM_REF && prop?.payee === DRIVER_NAME
    && Number(prop?.amount) === 25000 && Number(prop?.fee_amount) === 500
    && prop?.currency === "TZS" && /^[0-9a-f]{64}$/.test(String(prop?.payload_sha256))
    && isUuid(PAPP), prop);
  const pmPaper = await apRow(PAPP);
  check("…121's register holds it as pending, proposed by the seat that raised the paper, aimed at the "
    + "payout's own uuid as text", pmPaper.status === "pending" && pmPaper.action === "money.payout"
    && pmPaper.target_kind === "payout" && pmPaper.target_id === pmId
    && String(pmPaper.proposed_by) === PEN && pmPaper.decided_by === null
    && String(pmPaper.reason) === PSIGN, pmPaper);
  const pPay = pmPaper.payload ?? {};
  check("…the payload is twenty keys — the payout as the row holds it, printed the way the book prints "
    + "a figure, with the rail's own words, the payee's tail and the keyed hash, and the total the "
    + "second seat is being asked to approve", pPay.ref === PM_REF && pPay.payee === DRIVER_NAME
    && pPay.payee_kind === "driver" && String(pPay.payee_id) === driver
    && String(pPay.payee_tenant_id) === holderA && pPay.rail_code === "mpesa"
    && pPay.rail_family === "mobile_money" && pPay.payee_ref_tail === "1111"
    && pPay.payee_ref_hash === HASH64 && pPay.amount === "25000.00"
    && pPay.fee_amount === "500.00" && pPay.total_out === "25500.00" && pPay.currency === "TZS"
    && pPay.source_kind === "manual" && pPay.source_id === null
    && pPay.source_ref === pmRow.source_ref
    && String(pPay.purpose) === PURPOSE && pPay.raised_by_name === SEAT("Pen")
    && Object.keys(pPay).length === 20, { keys: Object.keys(pPay).length, pPay });
  check("…and the quote a seat is asked to approve is the one the row carries rather than nothing: a "
    + "manual payout with no reference typed is filed under its rail's own words, because `source_ref` "
    + "is what a desk reads back to a payee and the door never leaves it empty",
    String(pPay.source_ref) === "M-Pesa (Vodacom)" && String(pmRow.source_ref) === pPay.source_ref,
    { payload: pPay.source_ref, row: pmRow.source_ref });
  check("…and the sealed number is nowhere in the bytes a seat is asked to sign: the payload carries "
    + "the tail and the keyed hash and never the phone, so the copy of a payout that leaves the office "
    + "in an approval trail cannot be read back into a subscriber",
    !("payee_ref_encrypted" in pPay) && !JSON.stringify(pPay).includes("0722"),
    Object.keys(pPay).filter((k) => /ref|encrypt/.test(k)));
  const pExp = (await one(`select (extract(epoch from (expires_at - created_at)) between
        6.99 * 86400 and 7.01 * 86400) as seven,
        (extract(epoch from (expires_at - now())) between 6 * 86400 and 7 * 86400) as ahead
      from platform_approvals where id = $1::uuid`, [PAPP])) as Book;
  check("…signed for seven days, which is the window 134 chose so that a batch of the quarter's payees "
    + "is still signable in the week it was raised and is not a standing authority",
    pExp.seven === true && pExp.ahead === true, pExp);
  check("…and the hash is the hash of those exact bytes", await hashAgrees(PAPP),
    await hashAgrees(PAPP));
  const pmNow = await row("money_payouts", pmId);
  check("…while the paper itself moves to `pending_signature` and names the signature it waits on, its "
    + "figures untouched — the frozen columns are the whole point of hashing a paper",
    pmNow.status === "pending_signature" && String(pmNow.approval_id) === PAPP
    && Number(pmNow.amount) === 25000 && Number(pmNow.fee_amount) === 500
    && pmNow.rail_code === "mpesa" && String(pmNow.payee_ref_hash) === HASH64
    && pmNow.accrual_posting_id === null && pmNow.paid_at === null, pmNow);
  const pPropAud = await audOf("money_payouts", pmId, "payout.proposed");
  check("…and the line's own audit keeps both the state before the ask and the sentence, the hash and "
    + "the expiry the seat was shown, so a signature can be reconstructed after the register has moved on",
    String(pPropAud.actor_user_id) === PEN && String(pPropAud.actor_role) === SEAT_ROLE
    && pPropAud.before?.status === "raised" && pPropAud.before?.approval_id === null
    && pPropAud.after?.reason === PSIGN
    && String(pPropAud.after?.payload_sha256) === String(pmPaper.payload_sha256)
    && String(pPropAud.after?.proposed_name) === SEAT("Pen")
    && pPropAud.after?.status === "pending_signature"
    && Number(pPropAud.after?.amount) === 25000, pPropAud);
  const pTwice = await refuses("a payout standing open on a live signature is not asked twice",
    PROPOSE_P, [PLAT, pmId, PSIGN, PEN, SEAT_ROLE, "127.0.0.1", "gate"], "already_open");
  check("…and the answer names the paper it found and the state it is in, which is the only way a desk "
    + "can say who still has to sign it", String(pTwice?.approval_id) === PAPP
    && pTwice?.approval_status === "pending"
    && /already stands open/.test(String(pTwice?.message)), pTwice);
  check("…which leaves the payout on the one paper it had and the register holding one signature for it",
    String((await row("money_payouts", pmId)).approval_id) === PAPP
    && (await one(`select count(*)::int as n from platform_approvals where action = 'money.payout'
        and target_kind = 'payout' and target_id = $1`, [pmId])).n === 1, await apRow(PAPP));

  /** The release door's own refusals, before any of them is spent for real. Four of the five are only
   *  reachable with a paper 121 would never have written, which is why the gate writes them: a desk that "
   *  hands the effect an uuid of the wrong shape is the case the door answers rather than raises. */
  await refuses("apply_payout_release answers for a signature the register does not hold", APPLY_R,
    [NO_BODY, QUILL, "finance_officer", "127.0.0.1"], "not_found");
  const aEscrow = await handAp({ action: "money.escrow", target_kind: "escrow_hold",
    target_id: pmId, status: "applied", decided: QUILL });
  const notPay1 = await refuses("…and refuses to release money for a signature that belongs to a hold",
    APPLY_R, [aEscrow, QUILL, "finance_officer", "127.0.0.1"], "not_a_payout");
  check("…before it asks who is holding the pen, because the action is the first thing the door reads",
    /not a payout/.test(String(notPay1?.message)), notPay1);
  const aWallet = await handAp({ action: "money.payout", target_kind: "wallet", target_id: pmId,
    status: "applied", decided: QUILL });
  const notPay2 = await refuses("…and for a payout signature aimed at a register the office does not "
    + "release from", APPLY_R, [aWallet, QUILL, "finance_officer", "127.0.0.1"], "not_a_payout");
  check("…by the second of the door's two sentences, which names both of the targets it knows",
    /aimed at a payout or a batch/.test(String(notPay2?.message)), notPay2);
  const aPending = await handAp({ action: "money.payout", target_kind: "payout",
    target_id: String(randomUUID()), status: "pending" });
  const notSpent = await refuses("…and for a signature nobody has spent yet", APPLY_R,
    [aPending, QUILL, "finance_officer", "127.0.0.1"], "conflict");
  check("…with the state printed, because `claim_approval` and the effect are two calls and a desk that "
    + "skips the first gets this answer rather than a movement",
    notSpent?.approval_status === "pending" && /not spent by this call/.test(String(notSpent?.message)),
    notSpent);
  const aOtherSeat = await handAp({ action: "money.payout", target_kind: "payout", target_id: pmId,
    status: "applied", decided: ASH });
  const wrongSeat = await refuses("…and for a seat that did not release the signature it is spending",
    APPLY_R, [aOtherSeat, QUILL, "finance_officer", "127.0.0.1"], "unauthorised");
  check("…which is the sentence that stops one desk spending another desk's approval — the door is "
    + "called by the effect runner with the seat that pressed `apply`",
    /Only the seat that released/.test(String(wrongSeat?.message)), wrongSeat);
  note("134: `apply_payout_release` takes no `p_tenant`. It reads the payout off the signature's own "
    + "target and books into `v_row.tenant_id`, so the book a release lands in is decided by 121's "
    + "register rather than by the session — which is right for a runner that has no tenant to hand, "
    + "and is why the route that calls it takes the uuid from the approval row and never from the "
    + "request body.");

  const relW = await walk("the second seat signs the driver's payout, spends its own signature and the "
    + "office books the accrual", PAPP, QUILL, APPLY_R, PSIGN);
  const relOne = relW?.effect;
  const relPost = relOne?.posting;
  check("…the effect answers with the paper it released, both figures it was signed for and the two "
    + "seats it knows about", relOne?.ok === true && relOne?.target_kind === "payout"
    && String(relOne?.payout_id) === pmId && String(relOne?.ref) === PM_REF
    && relOne?.payee === DRIVER_NAME && Number(relOne?.amount) === 25000
    && Number(relOne?.fee_amount) === 500 && relOne?.currency === "TZS"
    && relOne?.source_kind === "manual" && String(relOne?.raised_by) === PEN
    && String(relOne?.released_by) === QUILL && String(relOne?.approval_id) === PAPP, relOne);
  check("…and with the movement: 133's own posting detail, filed under the payout, quoted with its "
    + "number, raised by the seat that spent the signature and written with the memo the door builds "
    + "out of the signature's own reason", /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(relPost?.ref))
    && Number(relPost?.total) === 25500 && relPost?.currency === "TZS"
    && relPost?.source_kind === "payout" && String(relPost?.source_id) === pmId
    && String(relPost?.source_ref) === PM_REF && String(relPost?.raised_by) === QUILL
    && relPost?.status === "posted"
    && String(relPost?.memo) === `Payout ${PM_REF} released to ${DRIVER_NAME} — ${PSIGN}`.slice(0, 200),
    relPost);
  const relPDay = await one(`select (posted_on = current_date) as today, posted_on, source_kind,
      idempotency_key, reversed_by, tenant_id from money_postings where id = $1::uuid`,
    [String(relPost?.id)]) as Book;
  check("…filed on the day the signature was spent rather than the day the payout was raised, into the "
    + "office's own book, with no key of its own — the release is not an idempotent route but the "
    + "effect of a paper 121 already guards against spending twice, and the detail the desk is handed "
    + "strips both the book and the key so neither can be quoted back", relPDay.today === true
    && String(relPDay.source_kind) === "payout" && relPDay.idempotency_key === null
    && relPDay.reversed_by === null && String(relPDay.tenant_id) === PLAT
    && Object.keys(relPost ?? {}).filter((k) => k === "tenant_id"
      || k === "idempotency_key").length === 0, relPDay);
  const relLegs = await legsAll(String(relPost?.id));
  check("…two legs, because an accrual is the expense recognised and the obligation created — nothing "
    + "has left the till yet", relLegs.length === 2
    && Number(legOf(relLegs, "debit", "COST-OPS")?.amount) === 25500
    && Number(legOf(relLegs, "credit", "PAYOUT-DUE")?.amount) === 25500
    && relLegs.filter((l) => l.code === "OPS-BANK").length === 0, relLegs);
  check("…each carrying the sentence the door wrote for it, so the line in the book says who is owed "
    + "what without anybody opening the payout register",
    String(legOf(relLegs, "debit", "COST-OPS")?.detail) === `Payout to ${DRIVER_NAME} accrued`
    && String(legOf(relLegs, "credit", "PAYOUT-DUE")?.detail)
      === `${DRIVER_NAME} owed on ${PM_REF}`, relLegs.map((l) => `${l.side} ${l.code}: ${l.detail}`));
  const relPRow = await row("money_payouts", pmId);
  check("…the payout is `released`, stamped with the seat that spent the signature and the movement it "
    + "bought, and is still carrying the figures the paper was hashed over",
    relPRow.status === "released" && String(relPRow.released_by) === QUILL && !!relPRow.released_at
    && String(relPRow.accrual_posting_id) === String(relPost?.id)
    && Number(relPRow.amount) === 25000 && String(relPRow.approval_id) === PAPP
    && relPRow.paid_at === null && relPRow.payment_posting_id === null, relPRow);
  const relAud = await audOf("money_payouts", pmId, "payout.released");
  check("…with the audit written by the spending seat and the movement's number on it — the effect door "
    + "audits the release even though 121 already recorded the signature being spent",
    String(relAud.actor_user_id) === QUILL && relAud.before?.status === "pending_signature"
    && relAud.after?.status === "released" && String(relAud.after?.posting) === String(relPost?.ref)
    && String(relAud.after?.approval_id) === PAPP
    && String(relAud.after?.payload_sha256) === String(pmPaper.payload_sha256)
    && String(relAud.after?.purpose) === PURPOSE, relAud);
  check("…and 121's paper is left `applied` with the effect's answer settled onto it",
    (await apRow(PAPP)).status === "applied" && !!(await apRow(PAPP)).applied_at
    && String((await apRow(PAPP)).decided_by) === QUILL && relW?.settle?.status === "ok"
    && relW?.claim?.status === "ok", { claim: relW?.claim, settle: relW?.settle });
  await refuses("…and a seat that did not spend the signature is still refused after it has been spent, "
    + "in the order the door asks: the paper first, the seat second, the payout's own state third — so "
    + "an already-released payout answers for the wrong seat, not for itself",
    APPLY_R, [PAPP, ASH, "finance_officer", "127.0.0.1"], "unauthorised");
  const sq12 = await square();
  check("…and the book is still square, because the accrual is a balanced pair of legs on two lines of "
    + "one chart", sq12?.square === true, sq12);

  const relAgain = await refuses("a released payout is not accrued twice by the same signature",
    APPLY_R, [PAPP, QUILL, "finance_officer", "127.0.0.1"], "conflict");
  check("…in the words that say the signature already did its work, with the payout's number beside it",
    relAgain?.ref === PM_REF && /already accrued by its signature/.test(String(relAgain?.message)),
    relAgain);
  check("…and nothing moved the second time: still one movement under the paper",
    Number((await one(`select count(*)::int as n from money_postings
        where source_kind = 'payout' and source_id = $1::uuid`, [pmId])).n) === 1
    && String((await row("money_payouts", pmId)).accrual_posting_id) === String(relPost?.id));

  /** The arm the door cannot reach on its own: a signature spent, and the paper it was spent on moved "
   *  out of `pending_signature` in between. `claim_approval` burns the approval before the effect runs, "
   *  so this is not a hypothetical — it is what a desk that edits the payout between the two calls "
   *  leaves behind. */
  const pbProp = await call("the staff member's bank payout is asked for its own signature", PROPOSE_P,
    [PLAT, pbId, PSIGN, PEN, SEAT_ROLE, "127.0.0.1", "gate"]);
  const PBAP = String(pbProp?.approval_id ?? "");
  check("…which the door grants while the line is a draft, and takes it to `pending_signature`",
    pbProp?.ok === true && isUuid(PBAP) && Number(pbProp?.amount) === 180000
    && Number(pbProp?.fee_amount) === 0
    && String((await row("money_payouts", pbId)).approval_id) === PBAP, pbProp);
  const burned = await walk("a signature spent over a paper that stopped waiting in between", PBAP,
    QUILL, APPLY_R, PSIGN,
    [[`update money_payouts set status = 'raised' where id = $1::uuid`, [pbId]]]);
  check("…the effect answers with the payout's state rather than booking anything, because `released` "
    + "has to be the state the signature is spent on and nothing else",
    burned?.effect?.ok === false && burned?.effect?.error === "conflict"
    && burned?.effect?.payout_status === "raised"
    && /not waiting for that signature/.test(String(burned?.effect?.message))
    && String(burned?.effect?.ref) === PB_REF, burned?.effect);
  check("…and the signature is gone anyway: 121 was already `applied` before the door was called, so "
    + "the paper is left a draft standing on a spent approval — a state only the desk's own re-ask "
    + "can get out of", (await apRow(PBAP)).status === "applied"
    && String((await row("money_payouts", pbId)).status) === "raised"
    && String((await row("money_payouts", pbId)).approval_id) === PBAP
    && (await one(`select count(*)::int as n from money_postings where source_kind = 'payout'
        and source_id = $1::uuid`, [pbId])).n === 0, await row("money_payouts", pbId));
  const pbProp2 = await call("…so the desk asks again, and the door lets it: a spent paper is not an "
    + "open one, and the register's unique index only guards `pending`", PROPOSE_P,
    [PLAT, pbId, PSIGN, PEN, SEAT_ROLE, "127.0.0.1", "gate"]);
  const PBAP2 = String(pbProp2?.approval_id ?? "");
  check("…which is a second signature, not the burned one rewritten — the trail of a payout that was "
    + "signed and then moved is two papers", pbProp2?.ok === true && isUuid(PBAP2)
    && PBAP2 !== PBAP && String((await row("money_payouts", pbId)).approval_id) === PBAP2
    && (await one(`select count(*)::int as n from platform_approvals where action = 'money.payout'
        and target_kind = 'payout' and target_id = $1`, [pbId])).n === 2, await apRow(PBAP2));
  const burnedTrail = await one(`select count(*)::int as all,
      count(*) filter (where status = 'applied')::int as spent,
      count(*) filter (where status = 'pending')::int as waiting
    from platform_approvals where target_kind = 'payout' and target_id = $1`, [pbId]) as Book;
  check("…and the trail of a payout that was signed and then moved is two papers in two different "
    + "states: 121 never unwinds a signature that has been spent, so the burned one stays `applied` "
    + "beside the new one that is still waiting", burnedTrail.all === 2 && burnedTrail.spent === 1
    && burnedTrail.waiting === 1, burnedTrail);
  note("134: a burned signature is a dead end the door leaves open on purpose — the payout goes back to "
    + "being a draft, `pending_signature → raised` is the one state change the frozen guard permits, and "
    + "the office keeps both papers. The gate walks it because it is the only arm of "
    + "`apply_payout_release` that cannot be reached by a refusal: the row has to move *after* the claim.");

  // ---------------- 12b · the batch released as one figure ----------------
  const BR1_REF = String((await row("money_payout_batches", BR1)).ref);
  const PDR_REF = String((await row("money_payouts", pdrId)).ref);
  const PST_REF = String((await row("money_payouts", pstId)).ref);
  const relB = await walk("a whole batch is signed as one figure and released as two movements",
    PAP2, QUILL, APPLY_R, BREASON);
  const relBB = relB?.effect;
  check("…the batch's arm answers with the paper it spent, the figure the seat read and the count of "
    + "what it booked", relBB?.ok === true && relBB?.target_kind === "payout_batch"
    && String(relBB?.batch_id) === BR1 && String(relBB?.ref) === BR1_REF
    && Number(relBB?.total_amount) === 40000 && relBB?.lines === 2
    && relBB?.accrued === 2 && relBB?.currency === "TZS"
    && String(relBB?.raised_by) === PEN && String(relBB?.released_by) === QUILL
    && String(relBB?.approval_id) === PAP2, relBB);
  check("…and with a map of the movements by the line's own number, which is the only shape an answer "
    + "can have when one signature buys two postings — an object keyed by the payout's number, not a "
    + "list of pairs a desk would have to walk to find its own line",
    !Array.isArray(relBB?.postings)
    && /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(relBB?.postings?.[PDR_REF] ?? ""))
    && /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(relBB?.postings?.[PST_REF] ?? ""))
    && Object.keys(relBB?.postings ?? {}).sort().join(",") === [PDR_REF, PST_REF].sort().join(","),
    relBB?.postings);
  const bRow = await row("money_payout_batches", BR1);
  check("…the batch itself reads `released` with the seat that spent its signature on it, and its "
    + "figure is still the one the seat read", bRow.status === "released"
    && String(bRow.released_by) === QUILL && !!bRow.released_at
    && Number(bRow.total_amount) === 40000 && Number(bRow.lines) === 2
    && String(bRow.approval_id) === PAP2, bRow);
  for (const [id, ref, name, kind] of [[pdrId, PDR_REF, DRIVER_NAME, "driver"],
    [pstId, PST_REF, STAFF_NAME, "staff"]] as [string, string, string, string][]) {
    const line = await row("money_payouts", id);
    const lPost = await row("money_postings", String(line.accrual_posting_id));
    const lLegs = await legsAll(String(lPost.id));
    check(`…${name} as a ${kind}: the line under the batch is released by the same seat, on a movement `
      + "whose memo names the batch it was released inside rather than pretending to be a signature of "
      + "its own", line.status === "released" && String(line.released_by) === QUILL
      && line.approval_id === null && String(lPost.source_kind) === "payout"
      && String(lPost.source_id) === id && String(lPost.source_ref) === ref
      && String(lPost.memo) === `Payout ${ref} released in batch ${BR1_REF} to ${name}`.slice(0, 200)
      && Number(lPost.total) === 20000 && String(lPost.raised_by) === QUILL
      && lLegs.length === 2 && Number(legOf(lLegs, "debit", "COST-OPS")?.amount) === 20000
      && Number(legOf(lLegs, "credit", "PAYOUT-DUE")?.amount) === 20000
      && String(legOf(lLegs, "credit", "PAYOUT-DUE")?.detail) === `${name} owed on ${ref}`,
      { line: { status: line.status, approval: line.approval_id }, post: lPost, lLegs });
    const lAud = await audOf("money_payouts", id, "payout.released");
    check("…each line audited on its own, even though one signature bought both — a payee's question is "
      + "answered per paper, not per batch, and the line's own row carries the batch it was released "
      + "inside and the movement its signature bought", String(lAud?.actor_user_id) === QUILL
      && lAud?.before?.status === "raised" && lAud?.after?.status === "released"
      && String(lAud?.after?.batch) === BR1_REF
      && String(lAud?.after?.posting) === String(relBB?.postings?.[ref])
      && String(lAud?.after?.approval_id) === PAP2, lAud);
  }
  const bAud = await audOf("money_payout_batches", BR1, "payout_batch.released");
  check("…and the batch's own audit carries the count of what it accrued and the map of the movements, "
    + "so one row explains both lines to whoever asks a year later",
    String(bAud?.actor_user_id) === QUILL && bAud?.before?.status === "pending_signature"
    && bAud?.after?.accrued === 2 && Object.keys(bAud?.after?.postings ?? {}).length === 2
    && String(bAud?.after?.postings?.[PDR_REF]) === String(relBB?.postings?.[PDR_REF])
    && String(bAud?.after?.postings?.[PST_REF]) === String(relBB?.postings?.[PST_REF])
    && Number(bAud?.after?.total_amount) === 40000 && bAud?.after?.status === "released", bAud);
  check("…while the three lines that were turned away before the signature stay turned away: the "
    + "release loop walks only what is still raised, which is what the figure the seat signed counted",
    (await one(`select count(*)::int as d from money_payouts where batch_id = $1::uuid
      and status = 'declined'`, [BR1])).d === 3
    && (await one(`select count(*)::int as r from money_payouts where batch_id = $1::uuid
      and status = 'released'`, [BR1])).r === 2, await row("money_payout_batches", BR1));
  const bAgain = await refuses("a batch that has spent its signature is not spent twice", APPLY_R,
    [PAP2, QUILL, "finance_officer", "127.0.0.1"], "conflict");
  check("…with the batch's number in the answer and the words that say the paper is gone",
    bAgain?.ref === BR1_REF && /already spent/.test(String(bAgain?.message)), bAgain);
  const bGone = await handAp({ action: "money.payout", target_kind: "payout_batch",
    target_id: String(randomUUID()), status: "applied", decided: QUILL });
  await refuses("…and a signature aimed at a batch the office does not have is answered the same way a "
    + "payout aimed at nothing is", APPLY_R, [bGone, QUILL, "finance_officer", "127.0.0.1"],
    "not_found");
  const bOpenPaper = await handAp({ action: "money.payout", target_kind: "payout_batch",
    target_id: BR2, status: "applied", decided: QUILL });
  const bOpen = await refuses("…while a paper aimed at a batch that is still a draft is refused by the "
    + "batch's own state, not by the paper's", APPLY_R, [bOpenPaper, QUILL, "finance_officer",
    "127.0.0.1"], "conflict");
  check("…printed with the state, because the desk has to be told the batch was never signed even "
    + "though a signature is sitting on it", bOpen?.batch_status === "open"
    && /not waiting for that signature/.test(String(bOpen?.message)), bOpen);
  check("…which leaves BR2 exactly where it was — a draft, unsigned, its one company line still raised",
    String((await row("money_payout_batches", BR2)).status) === "open"
    && (await row("money_payouts", pcoId)).status === "raised", await apRow(bOpenPaper));
  const sq12b = await square();
  const dueNow = await one(`select count(*)::int as n,
      coalesce(sum(amount + fee_amount)::numeric(14,2), 0) as s from money_payouts
      where status = 'released'`);
  check("…and the book is square under three accruals, four payees owed a total the register itself "
    + "adds up to", sq12b?.square === true && dueNow.n === 3 && String(dueNow.s) === "65500.00",
    { square: sq12b, due: dueNow });
  note(`${proved} checks proved so far — the release door has been walked for real over one payout `
    + "and one batch, and every one of its five refusals met with a paper a hand wrote.");

  // ---------------- 12c · the same questions put to a hand ----------------
  phase("12c · the two-seat guard read from the other side: a seat that writes `released` itself is "
    + "asked exactly what the release door is asked, and answers with the same sentence");
  /** Everything 12c refuses is an `update` rather than a door call, because the guard it tests is a
   *  trigger and a trigger does not care who ran the statement. The phase was written to prove that a
   *  hand which satisfies every question the guard asks can still book nothing; the register answers
   *  that it cannot even write the state, because `money_payouts_check7` makes a movement the price of
   *  `released`. So what is proved now is the next question: what a hand *can* write once it books,
   *  and which facts no constraint asks it about. */
  const TWO = "cannot be released without a second seat's signature on this payout (approval_id)";
  const FROZEN = "are frozen";
  const handRel = (label: string, id: string, seat: string, approval: string | null, want: string) =>
    fails(label, `update money_payouts set status = 'released', released_by = $2::uuid,
        released_at = now(), approval_id = coalesce($3::uuid, approval_id)
      where id = $1::uuid`, [id, seat, approval], want);
  const pfWrote = await okDo("a payout raised by a hand rather than by the desk, so that every arm "
    + "below is reached without a door standing in the way", INS_P,
    await handArgs({ ...TRIO, amount: 30000, source_ref: "gate phase 12c hand paper" }));
  const pf = String((pfWrote?.[0] as Book)?.id ?? "");
  check("…and the row it writes is an ordinary draft on the same three lines the door would have "
    + "derived", isUuid(pf) && String((await row("money_payouts", pf)).status) === "raised"
    && Number((await row("money_payouts", pf)).amount) === 30000, await row("money_payouts", pf));
  await handRel("a hand that releases a payout with no paper and no batch is refused in the words "
    + "that say which of the two the office expects", pf, ASH, null,
    "a payout is signed on its own paper or on the batch it stands in");
  const noPaper = await fails("…and the guard's very first question — is there such a signature at "
    + "all — is answered by the guard, not by the column's foreign key: a BEFORE trigger sees the row "
    + "before the register is ever asked to hold the uuid it points at",
    `update money_payouts set status = 'released', released_by = $2::uuid, approval_id = $3::uuid
     where id = $1::uuid`, [pf, ASH, NO_BODY], TWO);
  check("…raised as the same 23514 every other refusal in this phase is raised as, in the sentence "
    + "that names the column rather than the paper it could not find",
    !!noPaper && noPaper.code === CHECK_VIOLATION && /approval_id/.test(String(noPaper?.message)),
    { code: noPaper?.code, message: noPaper?.message });
  const noPaperDraft = await fails("…while the foreign key does have a turn to speak, and speaks it on "
    + "a draft: `payout_needs_two_seats` returns any row that is neither `released` nor `paid` "
    + "unanswered, so a raised payout pointed at a signature the register does not hold is stopped by "
    + "the constraint rather than by the rule",
    `update money_payouts set approval_id = $2::uuid where id = $1::uuid`, [pf, NO_BODY],
    "money_payouts_approval_id_fkey", FOREIGN_KEY);
  check("…which is the pair the office has to keep straight: the rule answers about a signature and "
    + "the constraint answers about a column, and the draft is left exactly as it was, with nothing "
    + "pointing at nothing", !!noPaperDraft && noPaperDraft.code === FOREIGN_KEY
    && (await row("money_payouts", pf)).approval_id === null
    && (await row("money_payouts", pf)).status === "raised", await row("money_payouts", pf));

  const aNot = await handAp({ action: "money.payout", target_kind: "payout", target_id: String(NO_BODY),
    status: "approved", decided: ASH });
  await handRel("…a signature aimed at a different payout than the row carrying it is no signature "
    + "for this row", pf, ASH, aNot, TWO);
  const aSelf = await handAp({ action: "money.payout", target_kind: "payout", target_id: pf,
    status: "approved", proposed: ASH, decided: PEN });
  await handRel("…and one released by the very seat that raised the payout: two seats means two "
    + "people, not two signatures by the same hand", pf, PEN, aSelf, TWO);
  const aThird = await handAp({ action: "money.payout", target_kind: "payout", target_id: pf,
    status: "approved", decided: ASH });
  await handRel("…and one spent by a third seat rather than the seat that released it, which is the "
    + "arm that keeps a desk from spending another desk's approval by hand",
    pf, QUILL, aThird, TWO);
  const aPend = await handAp({ action: "money.payout", target_kind: "payout", target_id: pf,
    status: "pending" });
  await handRel("…while a paper nobody has decided is not a signature at all, whatever it points at",
    pf, ASH, aPend, TWO);
  const aFalse = await handAp({ action: "money.payout", target_kind: "payout", target_id: pf,
    status: "approved", decided: ASH, payload: { currency: "TZS", amount: "1.00", fee_amount: "0.00",
      rail_code: "cash", payee: BOOK("Someone Else"), payee_ref_hash: null, source_kind: "manual" } });
  await handRel("…but the row's uuid and a second seat's name are not enough: the guard reads the "
    + "bytes back and refuses a signature whose figure is not the figure being released",
    pf, ASH, aFalse, "was signed for a different payout than the one being released");
  const aTrue = await handAp({ action: "money.payout", target_kind: "payout", target_id: pf,
    status: "approved", decided: ASH, payload: { currency: "TZS", amount: "30000.00",
      fee_amount: "0.00", rail_code: "cash", payee: BOOK("Stranger"), payee_ref_hash: null,
      source_kind: "manual" } });
  const pfPaper = String((await row("money_payouts", pf)).ref);
  const handDay = String((await one(`select to_char(current_date, 'YYYY-MM-DD') as d`)).d);
  const pfUnbooked = await fails("…and when the bytes are the bytes the row holds the guard is "
    + "satisfied — it re-reads the register and does not ask who ran the statement — and the hand "
    + "still cannot write the state, because `released` carries a CHECK of its own that asks for the "
    + "movement the door would have booked",
    `update money_payouts set status = 'released', released_by = $2::uuid, released_at = now(),
       approval_id = $3::uuid where id = $1::uuid`, [pf, ASH, aTrue], "money_payouts_check7");
  check("…raised as 23514 by the register's own constraint rather than by a sentence 134 wrote, which "
    + "is what makes this arm unlike every refusal above it", !!pfUnbooked
    && pfUnbooked.code === CHECK_VIOLATION && !/134:/.test(String(pfUnbooked?.message)),
    pfUnbooked?.message);
  const pfRow = await row("money_payouts", pf);
  const sq12c = await square();
  const dueUnbooked = await one(`select count(*)::int as n from money_payouts
     where status = 'released' and accrual_posting_id is null`);
  check("…which closes the hole this phase was written to open: a signature is not the price of "
    + "`released`, a movement is — so the register holds no payable paper the book has never heard of, "
    + "and the draft is left exactly where the CHECK stopped the hand",
    pfRow.status === "raised" && pfRow.accrual_posting_id === null
    && pfRow.released_by === null && Number(pfRow.amount) === 30000
    && dueUnbooked.n === 0 && sq12c?.square === true,
    { row: { s: pfRow.status, a: pfRow.accrual_posting_id, r: pfRow.released_by },
      unbooked: dueUnbooked.n, square: sq12c?.square });

  /** The one release a hand *can* write: book the accrual first through 133's own door, then name it.
   *  Nothing between the two statements asks whether the legs carry the figure the paper does, so the "
   *  gate books this one 20 000 short and lets the liabilities read speak for it. */
  const dueLine = (p: Book) => p?.rows?.find((r: Book) => r.account === "PAYOUT-DUE");
  const gapBefore = await payable();
  const pfBook = await call("…so a hand that means to release goes and books the accrual itself, "
    + "honestly aimed at the paper through 133's own door and 20 000 short of the figure it carries",
    RECORD_P,
    [PLAT, handDay, MEMO("A hand books the accrual 134 would have written"), "TZS", "payout",
      pf, pfPaper, null, ASH, JSON.stringify([
        { account: String(COST_OPS.id), direction: "debit", amount: "10000.00",
          detail: MEMO("hand accrual") },
        { account: String(PAYOUT_DUE.id), direction: "credit", amount: "10000.00",
          detail: MEMO("hand payable") }])]);
  const pfPost = String(pfBook?.posting?.id ?? "");
  await okDo("…and with a movement to name, the update the CHECK stopped goes through: "
    + "the signature, the seat and the bytes are all the guard ever asks about, and the figure the "
    + "legs carry is not one of them",
    `update money_payouts set status = 'released', released_by = $2::uuid, released_at = now(),
       approval_id = $3::uuid, accrual_posting_id = $4::uuid where id = $1::uuid`,
    [pf, ASH, aTrue, pfPost]);
  const pfNow = await row("money_payouts", pf);
  const pfPostRow = await row("money_postings", pfPost);
  check("…the paper reads released under the seat that wrote the update, with the hand's own movement "
    + "filed against it by number and by paper — which is the shape the door would have left, and the "
    + "reason a guard on the state cannot be the answer",
    pfNow.status === "released" && String(pfNow.released_by) === ASH
    && String(pfNow.accrual_posting_id) === pfPost && Number(pfNow.amount) === 30000
    && String(pfPostRow.source_ref) === pfPaper && String(pfPostRow.source_kind) === "payout"
    && String(pfPostRow.raised_by) === ASH && Number(pfPostRow.total) === 10000,
    { row: { s: pfNow.status, a: pfNow.accrual_posting_id, r: pfNow.released_by,
      amt: pfNow.amount }, post: { t: pfPostRow.total, raised_by: pfPostRow.raised_by,
      k: pfPostRow.source_kind, r: pfPostRow.source_ref } });
  const gapAfter = await payable();
  const handDue0 = dueLine(gapBefore);
  const handDue1 = dueLine(gapAfter);
  check("…and this is the fact no constraint asks about: the payable line's legs carry 10 000 while "
    + "its papers carry the 30 000 a second seat signed, so `money_payable` opens a gap of exactly "
    + "the difference, `drift` stays at nothing because the cached columns follow the legs the hand "
    + "wrote, and the book balances because every leg has its pair",
    Number(handDue1?.papers) - Number(handDue1?.book) === 20000
    && Number(handDue0?.papers) - Number(handDue0?.book) === 0
    && handDue1?.disagrees === true && handDue0?.disagrees === false && Number(handDue1?.drift) === 0
    && gapAfter?.drift === 0 && (await square())?.square === true,
    { before: { book: handDue0?.book, papers: handDue0?.papers, disagrees: handDue0?.disagrees },
      after: { book: handDue1?.book, papers: handDue1?.papers, disagrees: handDue1?.disagrees,
        drift: handDue1?.drift, cached: handDue1?.cached } });
  const pfAud = await audOf("money_payouts", pf, "payout.released");
  check("…while the one witness the register cannot forge is the register of the office's own "
    + "decisions: a hand that writes the state writes no audit row for it, so the release has no "
    + "date, no seat and no role in the trail — which is the seam a desk has to read, not a guard",
    pfAud === undefined, pfAud);

  const BR2_REF = String((await row("money_payout_batches", BR2)).ref);
  await fails("a line standing inside a batch the office never signed cannot be released by pointing "
    + "at the batch's name", `update money_payouts set status = 'released', released_by = $2::uuid,
      released_at = now() where id = $1::uuid`, [pcoId, ASH],
    `on ${BR2_REF} (approval_id)`);
  const b6r = await openB("a second batch, opened only so that the batch's own two arms can be met",
    MEMO("Batch six"));
  const BR6 = String(b6r?.batch?.id ?? "");
  const l6w = await okDo("…with one line standing under it", INS_P, await handArgs({ ...TRIO,
    batch_id: BR6, amount: 33000, source_ref: "gate phase 12c forged batch paper" }));
  const L6 = String((l6w?.[0] as Book)?.id ?? "");
  const aForge = await handAp({ action: "money.payout", target_kind: "payout_batch", target_id: BR6,
    status: "approved", decided: ASH,
    payload: { currency: "TZS", total_amount: "99.00", lines: "4" } });
  await okDo("…and the batch carried to `released` under that paper while it is still a draft, which "
    + "its own guard permits because only a batch that has *asked* freezes its figures",
    `update money_payout_batches set status = 'released', approval_id = $2::uuid,
        released_by = $3::uuid, released_at = now(), total_amount = 33000, lines = 1, reason = $4
      where id = $1::uuid`, [BR6, aForge, ASH, BREASON]);
  await fails("…so the line's release meets the batch's payload arm, in the words that print what the "
    + "seat is said to have read: four lines for 99.00 is not the one line for 33 000 standing under "
    + "it", `update money_payouts set status = 'released', released_by = $2::uuid,
      released_at = now() where id = $1::uuid`, [L6, ASH],
    "was signed for a batch of 4 line(s) totalling 99.00 TZS");
  await okDo("…and the same conclusion a second time: 121 keeps no trigger on `payload`, so a hand "
    + "that can write the paper can also rewrite its bytes",
    `update platform_approvals set payload = $2::jsonb where id = $1::uuid`,
    [aForge, JSON.stringify({ currency: "TZS", total_amount: "33000.00", lines: "1" })]);
  const L6PAPER = String((await row("money_payouts", L6)).ref);
  const l6NoPost = await fails("…which is all the guard asks — the paper's figure now matches the "
    + "batch's, the seat that released it is the seat that spent it, and the line is releasable — and "
    + "the same CHECK stops a batch's line exactly as it stops a paper of one",
    `update money_payouts set status = 'released', released_by = $2::uuid, released_at = now()
       where id = $1::uuid`, [L6, ASH], "money_payouts_check7");
  check("…raised by the constraint rather than by the guard's sentence, which is the arm of a batch's "
    + "release no hand reaches by rewriting the paper", !!l6NoPost
    && l6NoPost.code === CHECK_VIOLATION && !/134:/.test(String(l6NoPost?.message)),
    l6NoPost?.message);
  const l6Book = await call("…so the hand books the batch line's accrual too, this one for the figure "
    + "the paper actually carries", RECORD_P,
    [PLAT, handDay, MEMO("A hand books a batch line's accrual"), "TZS", "payout", L6, L6PAPER,
      null, ASH, JSON.stringify([
        { account: String(COST_OPS.id), direction: "debit", amount: "33000.00",
          detail: MEMO("hand accrual of a batch line") },
        { account: String(PAYOUT_DUE.id), direction: "credit", amount: "33000.00",
          detail: MEMO("hand payable of a batch line") }])]);
  const l6Post = String(l6Book?.posting?.id ?? "");
  await okDo("…and the line under a batch the office never signed is released by a hand "
    + "that brought its own movement",
    `update money_payouts set status = 'released', released_by = $2::uuid, released_at = now(),
       accrual_posting_id = $3::uuid where id = $1::uuid`, [L6, ASH, l6Post]);
  const l6Row = await row("money_payouts", L6);
  check("…the batch was never signed by anybody and its line reads `released` all the same: the "
    + "guard asks the batch's paper what the seat read, and a hand that can write the paper can write "
    + "an answer the second seat never gave",
    l6Row.status === "released"
    && String(l6Row.accrual_posting_id) === l6Post && Number(l6Row.amount) === 33000
    && String(l6Row.batch_id) === BR6 && String(l6Row.released_by) === ASH, l6Row);
  check("…while the one witness the register does keep — the hash of the bytes a seat read — now "
    + "disagrees with the paper, and nothing in 134 asks it: `payout_needs_two_seats` compares the "
    + "seven keys it cares about one by one and never re-digests the payload",
      (await hashAgrees(aForge)) === false
      && String((await apRow(aForge)).payload.total_amount) === "33000.00",
      await apRow(aForge));
  note("134: what 12c proves is not the boundary the phase expected. `money_payouts_check7` makes a "
    + "movement the price of `released`, so a hand cannot leave the register holding a payable paper "
    + "the book never heard of; but the CHECK asks only that *a* posting is named, not that it is this "
    + "payout's accrual or that its legs carry the paper's figure — a hand that books 10 000 against a "
    + "30 000 paper passes every guard and opens a 20 000 gap that only `money_payable` prints. And "
    + "because 121 keeps no trigger on `payload`, a batch's line can be released under bytes the "
    + "second seat never read, with the hash left as the only witness and no door asked to re-digest "
    + "it. What a hand still cannot write is the audit row the door files for its own release. Kept as "
    + "findings rather than fixed: closing the figure gap needs a trigger that reads legs, which 133's "
    + "rule about who may book money makes expensive, and closing the bytes gap needs a guard on "
    + "`platform_approvals` itself, which is 121's table and 135's question.");

  const FROZEN_ARMS: [string, string, any][] = [
    ["amount", "$2::numeric", 26000], ["fee_amount", "$2::numeric", 900],
    ["currency", "$2", "USD"], ["rail_code", "$2", "airtel"],
    ["payee_kind", "$2", "company"], ["payee_id", "$2::uuid", PLAT],
    ["payee_ref_hash", "$2", "f".repeat(64)], ["payee_ref_encrypted", "$2::bytea", ACCT],
    ["source_kind", "$2", "cost"], ["source_id", "$2::uuid", NO_BODY],
    ["fund_account_id", "$2::uuid", OPS_CASH.id],
    ["payable_account_id", "$2::uuid", FEE_INCOME.id],
    ["cash_account_id", "$2::uuid", COST_OPS.id],
    ["approval_id", "$2::uuid", aNot], ["batch_id", "$2::uuid", BR2]
  ];
  for (const [col, cast, val] of FROZEN_ARMS) {
    const err = await fails(`a payout whose signature has been spent cannot have ${col} moved under `
      + "it — the whole rule in one sentence",
      `update money_payouts set ${col} = ${cast} where id = $1::uuid`, [pmId, val]);
    check("…printed with the payout's number, its state and the four things the seat signed, not the "
      + "column a hand happened to type", String(err?.message).includes(FROZEN)
      && /is released/.test(String(err?.message))
      && String(err?.message).includes(PM_REF), { col, message: err?.message });
  }
  await fails("…and `released` itself is the one state that may not go back: an accrual is answered by "
    + "its mirror, not by un-signing the paper", `update money_payouts set status = 'raised'
      where id = $1::uuid`, [pmId], "has been accrued by a spent signature");
  const answered = await row("money_payouts", pstrId);
  await fails("a payout the second seat turned away is just as finished as one it released: the state "
    + "it answers with is a fact about the book, not a draft waiting to be re-used",
    `update money_payouts set status = 'raised' where id = $1::uuid`, [pstrId],
    "is declined and stays declined");
  await fails("…and its figure is frozen from the same moment, whichever of the two states the guard "
    + "reads first", `update money_payouts set amount = 1 where id = $1::uuid`, [pstrId], FROZEN);
  check("…which leaves the declined paper exactly as the seat left it",
    answered.status === "declined" && Number(answered.amount) === Number((await row(
      "money_payouts", pstrId)).amount) && answered.accrual_posting_id === null, answered);
  note("134: `payout_frozen_after_signature` reads `old.status`, so the moment a payout reaches one of "
    + "the five signed states its whole shape is nailed — including the three account lines, which no "
    + "door re-derives afterwards. That is what makes `mark_money_payout_paid` free to re-derive only "
    + "the fee line: everything else it needs was fixed when the second seat signed.");

  // ---------------- 13 · the cash moment ----------------
  phase("13 · the accrual is answered by the cash that left, on the day the desk says it left, and a "
    + "rail that says no is answered by 133's mirror rather than by editing the paper");
  /** Three doors and one mirror. `mark_money_payout_paid` is the only place 134 turns an obligation "
   *  into money that has gone, and it is the only one that re-derives anything after the signature was "
   *  spent — the fee line — so its arms are met before it runs, and its legs are read afterwards rather "
   *  than taken from its own answer. `mark_money_payout_failed` books nothing of its own: it delegates "
   *  to 133's reversal, which is why a payout whose accrual has already been mirrored away is a state "
   *  this gate can reach and 134 cannot answer. */
  const PAYNOTE = MEMO("rail confirmation 8842 read off the message");
  const FAILWHY = MEMO("the subscriber's line refused the transfer");
  const CLOSENOTE = MEMO("every line answered, the receipts filed under the batch");
  const YDAY = String((await one(
    `select to_char(current_date - 1, 'YYYY-MM-DD') as d`)).d);
  const lineBal = async (code: string) => Number((await one(`select coalesce(sum(
        case when e.direction = 'credit' then e.amount else -e.amount end), 0)::numeric(14,2) as b
      from money_entries e join money_accounts a on a.id = e.account_id
     where a.tenant_id = $1::uuid and a.code = $2`, [PLAT, code])).b);
  /** A chart line as both halves of the book keep it: the legs, the cached column, and the count of "
   *  entries the triggers were supposed to advance with the money. */
  const lineMove = async (code: string) => {
    const id = String((await acc(code, PLAT)).id);
    const fig = await accFig(id);
    return { id, bal: await lineBal(code), cached: Number(fig.cached),
      legs: Number(fig.legs), status: String(fig.status) };
  };

  const payShort = await refuses("mark_money_payout_paid refuses a note that does not say how the "
    + "money went", PAID_P, [PLAT, pmId, "Paid", YDAY, PEN, "finance_officer", "127.0.0.1", "gate"],
    "bad_note");
  check("…with the length the seat has to type into, because the note is kept on the paper and cut "
    + "into the movement's own memo", /8-600 characters/.test(String(payShort?.message))
    && /Say how the money went/.test(String(payShort?.message)), payShort);
  await refuses("…and one longer than a receipt's sentence", PAID_P,
    [PLAT, pmId, "P".repeat(601), YDAY, PEN, "finance_officer", "127.0.0.1", "gate"], "bad_note");
  await refuses("…a payout the book does not have is answered before anything is asked of the seat",
    PAID_P, [PLAT, NO_BODY, PAYNOTE, YDAY, PEN, "finance_officer", "127.0.0.1", "gate"], "not_found");
  for (const [id, state, why] of [[pcoId, "raised", "a line nobody has signed yet"],
    [pbId, "pending_signature", "a line waiting on its second seat"],
    [pstrId, "declined", "a paper a second seat turned away"]] as [string, string, string][]) {
    const early = await refuses(`…and only a released payout is paid: ${why} has not tried to leave `
      + "the till", PAID_P, [PLAT, id, PAYNOTE, YDAY, PEN, "finance_officer", "127.0.0.1", "gate"],
      "conflict");
    check("…answered with the state the desk is looking at and the paper's own number, and with no "
      + "movement booked for a money that never left", early?.payout_status === state
      && String(early?.ref) === String((await row("money_payouts", id)).ref)
      && /after a second seat has released it/.test(String(early?.message)), early);
  }
  /** The door's own last arm: it re-derives the income line at the moment the cash leaves, so a fee "
   *  that was honest when the paper was signed can be unbookable by the time it is paid. 133's freeze "
   *  door is the only way to stop a line, and the gate stops and opens the one line this payout needs. */
  await call("the office stops its own fee income line, so that the arm behind a paid fee is reached "
    + "with the book in the state the desk would find it in", FREEZE_ACC,
    [PLAT, String(FEE_INCOME.id), STOP_LINE, PEN, true]);
  const noFee = await refuses("…and a payout carrying the office's cut cannot be paid into a book with "
    + "no open income line for it", PAID_P,
    [PLAT, pmId, PAYNOTE, YDAY, PEN, "finance_officer", "127.0.0.1", "gate"], "no_fee_line");
  check("…printed with the two figures the desk cannot place — the cut it meant to recognise and the "
    + "money it is in — rather than with the name of a missing account",
    Number(noFee?.fee_amount) === 500 && noFee?.currency === "TZS"
    && /no open income line for it/.test(String(noFee?.message)), noFee);
  const pmHeld = await row("money_payouts", pmId);
  check("…while the payout is untouched: the door refuses before it derives a single leg, so a stopped "
    + "income line costs the office a day and not a half-booked payment",
    pmHeld.status === "released" && pmHeld.payment_posting_id === null
    && String(pmHeld.accrual_posting_id) === String(relPost?.id), pmHeld);
  await call("…and the office opens the fee line again before anything is paid", FREEZE_ACC,
    [PLAT, String(FEE_INCOME.id), "", PEN, false]);

  const pmDue0 = await lineMove("PAYOUT-DUE");
  const pmBank0 = await lineMove("OPS-BANK");
  const pmFee0 = await lineMove("FEE-INCOME");
  const paid13 = await call("the driver's money has left on the mobile rail and the desk confirms it, "
    + "on the day the rail's message arrived rather than the day somebody got round to it", PAID_P,
    [PLAT, pmId, PAYNOTE, YDAY, PEN, "finance_officer", "127.0.0.1", "gate"]);
  const cashPost13 = paid13?.posting;
  check("…the answer is the movement and the paper it just paid, which is the pair a receipt is made "
    + "of", paid13?.ok === true && /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(cashPost13?.ref))
    && Number(cashPost13?.total) === 25500 && cashPost13?.currency === "TZS"
    && cashPost13?.source_kind === "payout" && String(cashPost13?.source_id) === pmId
    && String(cashPost13?.source_ref) === PM_REF && String(cashPost13?.raised_by) === PEN
    && String(paid13?.payout?.status) === "paid", paid13);
  const payMemoWrote = `Payout ${PM_REF} paid to ${DRIVER_NAME} — ${PAYNOTE}`;
  check("…filed with the memo the door builds out of the payout's number, the payee and the sentence "
    + "the desk typed, cut where a movement's memo stops",
    String(cashPost13?.memo) === payMemoWrote.slice(0, 200)
    && payMemoWrote.length < 200, cashPost13?.memo);
  const cashDay13 = await one(`select (posted_on = $2::date) as back,
        to_char(posted_on, 'YYYY-MM-DD') as day, status, idempotency_key, raised_by
      from money_postings where id = $1::uuid`, [String(cashPost13?.id), YDAY]) as Book;
  check("…on the day the desk was told rather than the day the door ran — the one argument 134 hands "
    + "to 133 as a date instead of deriving it, because a payment is evidenced by the rail's own "
    + "message and not by the office's clock", cashDay13.back === true && cashDay13.day === YDAY
    && cashDay13.status === "posted" && cashDay13.idempotency_key === null
    && String(cashDay13.raised_by) === PEN, cashDay13);
  const pmCashLegs = await legsAll(String(cashPost13?.id));
  check("…three legs, because the money that leaves is smaller than the obligation it answers by "
    + "exactly the cut the office keeps", pmCashLegs.length === 3
    && Number(legOf(pmCashLegs, "debit", "PAYOUT-DUE")?.amount) === 25500
    && Number(legOf(pmCashLegs, "credit", "OPS-BANK")?.amount) === 25000
    && Number(legOf(pmCashLegs, "credit", "FEE-INCOME")?.amount) === 500, pmCashLegs);
  check("…each with the sentence the door wrote for it: the whole obligation is answered, only the "
    + "money that travelled leaves the line the rail travels on, and the difference is income at the "
    + "moment it is kept",
    String(legOf(pmCashLegs, "debit", "PAYOUT-DUE")?.detail) === `${DRIVER_NAME} paid on ${PM_REF}`
    && String(legOf(pmCashLegs, "credit", "OPS-BANK")?.detail) === `Paid ${DRIVER_NAME} on mpesa`
    && String(legOf(pmCashLegs, "credit", "FEE-INCOME")?.detail) === `Office cut on ${PM_REF}`,
    pmCashLegs.map((l) => `${l.side} ${l.code}: ${l.detail}`));
  const pmDue1 = await lineMove("PAYOUT-DUE");
  const pmBank1 = await lineMove("OPS-BANK");
  const pmFee1 = await lineMove("FEE-INCOME");
  check("…and the three lines move by the three figures, each with its cached total advanced by the "
    + "same leg the door wrote — the payable gives up the whole obligation, the bank gives up only the "
    + "money that travelled, and the line the office keeps is a credit to an income line whose balance "
    + "is read the same way as an asset's: credits minus debits, so the till that loses the cash moves "
    + "down its own figure and the income that gains the cut moves up",
    pmDue1.bal === pmDue0.bal - 25500 && pmBank1.bal === pmBank0.bal + 25000
    && pmFee1.bal === pmFee0.bal + 500
    && [pmDue1, pmBank1, pmFee1].every((l) => l.cached === l.bal)
    && pmDue1.legs === pmDue0.legs + 1 && pmBank1.legs === pmBank0.legs + 1
    && pmFee1.legs === pmFee0.legs + 1,
    { due: [pmDue0, pmDue1], bank: [pmBank0, pmBank1], fee: [pmFee0, pmFee1] });
  const pmPaid = await row("money_payouts", pmId);
  check("…the paper keeps both movements: the accrual its signature bought and the cash that answered "
    + "it, with the seat and the moment the desk confirmed the rail beside its own note",
    pmPaid.status === "paid" && String(pmPaid.paid_by) === PEN && !!pmPaid.paid_at
    && String(pmPaid.paid_note) === PAYNOTE
    && String(pmPaid.accrual_posting_id) === String(relPost?.id)
    && String(pmPaid.payment_posting_id) === String(cashPost13?.id)
    && Number(pmPaid.amount) === 25000 && String(pmPaid.released_by) === QUILL, pmPaid);
  const payAud = await audOf("money_payouts", pmId, "payout.paid");
  check("…audited by the seat that confirmed the cash, with the state and the accrual the door had "
    + "read before it wrote anything", String(payAud.actor_user_id) === PEN
    && String(payAud.actor_role) === "finance_officer" && payAud.before?.status === "released"
    && String(payAud.before?.accrual) === String(relPost?.id), payAud);
  check("…and twelve keys after it, in the shape a year-old question is answered from: the paper, the "
    + "payee, both figures, the money, the rail, the tail, the note, the movement's own number, the "
    + "source the paper was raised from — carried into the audit as the rail's words rather than left "
    + "empty, because the door never lets a payout stand without them — and the state it reached", Object.keys(payAud.after ?? {}).length === 12
    && String(payAud.after?.ref) === PM_REF && payAud.after?.payee === DRIVER_NAME
    && Number(payAud.after?.amount) === 25000 && Number(payAud.after?.fee_amount) === 500
    && payAud.after?.currency === "TZS" && payAud.after?.rail === "mpesa"
    && String(payAud.after?.payee_ref_tail) === "1111" && String(payAud.after?.note) === PAYNOTE
    && String(payAud.after?.posting) === String(cashPost13?.ref)
    && payAud.after?.source_kind === "manual"
    && String(payAud.after?.source_ref) === "M-Pesa (Vodacom)" && payAud.after?.status === "paid",
    { keys: Object.keys(payAud.after ?? {}), after: payAud.after });
  const payTrail = JSON.stringify([payAud.before, payAud.after, pmCashLegs, cashPost13?.memo]);
  check("…which is the copy of a mobile-money payment that leaves the office in a trail: the tail of "
    + "the subscriber's number and never the number, so the audit of a payout paid by phone cannot be "
    + "read back into a SIM", payTrail.includes("1111") && !payTrail.includes("0722"),
    payTrail.slice(0, 200));
  const paidTwice = await refuses("a payout that has paid is not paid again — one confirmation "
    + "answers one movement", PAID_P,
    [PLAT, pmId, PAYNOTE, YDAY, PEN, "finance_officer", "127.0.0.1", "gate"], "conflict");
  check("…printed with `paid`, which is the state a desk that has not reloaded is about to type over",
    paidTwice?.payout_status === "paid" && String(paidTwice?.ref) === PM_REF, paidTwice);
  await refuses("…and neither can it be told it failed, because the rail did not say no", FAILED_P,
    [PLAT, pmId, FAILWHY, PEN, "finance_officer", "127.0.0.1", "gate"], "conflict");
  await fails("…while the guard behind the door answers a hand exactly as it answers the desk: an "
    + "answered movement is answered with a new paper, not by moving the state back",
    `update money_payouts set status = 'released' where id = $1::uuid`, [pmId], "and stays paid");
  await fails("…and a payout with a movement behind it cannot be taken off the register at all, "
    + "because the paper is the only thing that says which signature the money answered",
    `delete from money_payouts where id = $1::uuid`, [pmId], "has a movement behind it");
  const sq13 = await square();
  check("…and the book is square on the cash as it was on the accrual: three legs, two sides, the "
    + "same figure on each", sq13?.square === true, sq13);

  /** What 12c leaves behind is not an unbooked paper — `money_payouts_check7` stops that — but a paper "
   *  whose movement is the wrong size. Walked to its end here: the paid door pays the under-accrued "
   *  paper, debits the payable with the whole figure a second seat signed, and the 20 000 a hand left "
   *  behind follows the paper out of `released` into `paid` without any state transition closing it. "
   *  Every leg keeps its pair, so the only witness is the pair of columns `money_payable` prints. */
  const pfRef = String((await row("money_payouts", pf)).ref);
  const pfDue0 = dueLine(await payable());
  const paidPf = await call("…and the paper a hand released with an accrual 20 000 short of its own "
    + "figure is paid, with the date box left empty", PAID_P,
    [PLAT, pf, PAYNOTE, null, PEN, "finance_officer", "127.0.0.1", "gate"]);
  check("…which the paid door accepts: `mark_money_payout_paid` asks the payout one question — is it "
    + "released — and the `paid` write re-fires the two-seat guard, which the hand's own paper answers, "
    + "because the bytes it carries are the bytes the row holds. What neither the door nor the guard "
    + "asks is what figure the movement behind the paper carries",
    paidPf?.ok === true && Number(paidPf?.posting?.total) === 30000
    && String((await row("money_payouts", pf)).status) === "paid", paidPf);
  const pfLegs = await legsAll(String(paidPf?.posting?.id));
  check("…two legs, not three: `money_leg` drops a zero figure, so a payout with no cut has no income "
    + "line to recognise and the door never writes a leg for nothing", pfLegs.length === 2
    && pfLegs.filter((l) => l.code === "FEE-INCOME").length === 0
    && Number(legOf(pfLegs, "debit", "PAYOUT-DUE")?.amount) === 30000
    && Number(legOf(pfLegs, "credit", "OPS-CASH")?.amount) === 30000
    && String(legOf(pfLegs, "credit", "OPS-CASH")?.detail) === `Paid ${BOOK("Stranger")} on cash`
    && String(legOf(pfLegs, "debit", "PAYOUT-DUE")?.detail) === `${BOOK("Stranger")} paid on ${pfRef}`,
    pfLegs.map((l) => `${l.side} ${l.code}: ${l.detail}`));
  const pfToday = await one(`select (posted_on = current_date) as today from money_postings
      where id = $1::uuid`, [String(paidPf?.posting?.id)]) as Book;
  check("…and with the date box left empty the movement is dated the day the door ran, which is the "
    + "default a desk gets and the one column it should have to think about", pfToday.today === true,
    pfToday);
  const pfPay = await payable();
  const pfDueRow = dueLine(pfPay);
  check("…while the gap does not move when the paper is paid: the debit the door writes gives back the "
    + "whole 30 000 a second seat signed, so the payable line loses 30 000 of book and 30 000 of paper "
    + "at once and still stands 20 000 lighter than its own register. `drift` is nothing, because the "
    + "cached totals follow the legs rather than the papers, and 133's squareness is nothing, because "
    + "every leg has its pair — the two columns are the only witnesses the office has",
    Number(pfDue0?.papers) - Number(pfDue0?.book) === 20000
    && Number(pfDueRow?.papers) - Number(pfDueRow?.book) === 20000
    && Number(pfDue0?.papers) - Number(pfDueRow?.papers) === 30000
    && Number(pfDue0?.book) - Number(pfDueRow?.book) === 30000
    && pfDueRow?.disagrees === true && Number(pfDueRow?.drift) === 0 && pfPay?.drift === 0
    && pfPay?.square === false && (await square())?.square === true,
    { released: { book: pfDue0?.book, papers: pfDue0?.papers },
      paid: { book: pfDueRow?.book, papers: pfDueRow?.papers, all: pfPay } });
  /** The read a desk would have to write for itself, and the shape it has to take: a paper signed on "
   *  its own has one accrual carrying its figure, so the posting's `total` is a fact about that payout "
   *  — while a batch's lines share one posting whose total is the batch's, so joining them to it "
   *  prints a difference that is the read's fault and not the hand's. */
  const handRows = await one(`select count(*)::int as n from money_payouts
     where status in ('released','paid') and accrual_posting_id is null`) as Book;
  const wrongSized = await one(`select count(*)::int as n,
      coalesce(sum(abs(p.amount + p.fee_amount - m.total))::numeric(14,2), 0) as s
    from money_payouts p join money_postings m on m.id = p.accrual_posting_id
   where p.status in ('released','paid') and p.batch_id is null and m.source_kind = 'payout'
     and m.total <> p.amount + p.fee_amount`) as Book;
  check("…which is the question 134 cannot ask of a row and 135 has to be written for: no released or "
    + "paid paper stands with nothing behind it, because the CHECK prices the state with a movement — "
    + "so what a hand leaves is a paper whose movement is the wrong size, and only a query that joins "
    + "the payout to its own posting's total prints it, as exactly this row and 20 000 TZS",
    handRows.n === 0 && wrongSized.n === 1 && String(wrongSized.s) === "20000.00",
    { unbooked: handRows.n, mismatched: wrongSized });
  await fails("…and the paid paper is kept by the same rule as one that was accrued honestly: the "
    + "movement behind it is a fact the office may not delete, whatever figure it carries",
    `delete from money_payouts where id = $1::uuid`, [pf], "has a movement behind it");
  note("134: the hole this phase was written to open is narrower than the phase expected, and the part "
    + "that is left is worse in one way and better in another. `money_payouts_check7` makes a movement "
    + "the price of `released`, so a hand with SQL cannot put a payable on the board the book has never "
    + "heard of — the register holds no released paper with no posting behind it, at any moment, in any "
    + "state. But the CHECK asks only that *a* posting is named, not that it is this payout's accrual "
    + "or that its legs carry the paper's figure, so a hand that books 10 000 against a 30 000 paper "
    + "passes every guard, is paid by the desk's own door, and opens a difference that only "
    + "`money_payable` prints and `money_book_is_square` cannot see. Closing it needs an arm on the "
    + "payout's own row that reads the posting it is being told to name — its total against "
    + "`amount + fee_amount`, its status against `posted` — and refuses the state on the difference; "
    + "kept as a finding rather than written here, because 133's law is that a movement is booked by a "
    + "door that can explain it, and a guard that only reads postings asks for the same door to be "
    + "answered from both sides.");

  const failShort = await refuses("mark_money_payout_failed refuses a reason too short to start the "
    + "next paper from", FAILED_P, [PLAT, pstId, "No", PEN, "finance_officer", "127.0.0.1", "gate"],
    "bad_reason");
  check("…in the words that say what the sentence is for: it is the reason the next payout for the "
    + "same person begins with", /8-600 characters/.test(String(failShort?.message))
    && /next payout for the same person starts from/.test(String(failShort?.message)), failShort);
  await refuses("…and one longer than the register can carry", FAILED_P,
    [PLAT, pstId, "N".repeat(601), PEN, "finance_officer", "127.0.0.1", "gate"], "bad_reason");
  await refuses("…a payout the book does not have is answered before its accrual is looked at",
    FAILED_P, [PLAT, NO_BODY, FAILWHY, PEN, "finance_officer", "127.0.0.1", "gate"], "not_found");
  await refuses("…and a paper the second seat turned away has not tried to pay, so it cannot fail",
    FAILED_P, [PLAT, pstrId, FAILWHY, PEN, "finance_officer", "127.0.0.1", "gate"], "conflict");
  /** The forged batch's line, answered from the desk side. `money_payouts_check7` closed the route "
   *  this block was written for — a released payout whose accrual is `not_found` — so what is proved "
   *  now is the arm the delegation cannot see: the failed door asks the payout one question and the "
   *  answer it books is a mirror of whatever movement the row happens to name, whoever named it. */
  const l6AccRow = await row("money_postings", l6Post);
  const l6Due0 = await lineMove("PAYOUT-DUE");
  const l6Cost0 = await lineMove("COST-OPS");
  const failedL6 = await call("the desk is told the rail refused, and fails the batch's line — on a "
    + "batch nobody signed, under paper whose bytes a hand rewrote, with an accrual the gate booked "
    + "itself", FAILED_P, [PLAT, L6, FAILWHY, PEN, "finance_officer", "127.0.0.1", "gate"]);
  const l6Rev = failedL6?.reversal;
  check("…which the door grants, books nothing of its own and answers 133's mirror for the hand's "
    + "movement exactly as it answers one the release loop wrote: same figure, the original's number in "
    + "`source_id` and in `source_ref`, and the reason cut into the memo the way 133's column asks",
    failedL6?.ok === true && /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(l6Rev?.ref))
    && Number(l6Rev?.total) === 33000 && String(l6Rev?.source_kind) === "reversal"
    && String(l6Rev?.source_id) === l6Post && String(l6Rev?.source_ref) === String(l6AccRow.ref)
    && String(l6Rev?.memo) === "Reversal of " + String(l6AccRow.ref) + ": "
      + String(l6AccRow.memo).slice(0, 140)
    && String((await row("money_payouts", L6)).status) === "failed", failedL6);
  const l6Legs = await legsAll(String(l6Rev?.id));
  check("…two legs with the sides swapped and the hand's own number written into each, so the payable "
    + "gives back the 33 000 a hand credited to it and the expense is given back too — the office can "
    + "take a paper it never agreed to owe off the board, and the only witness that it was forged is "
    + "the hash that no longer matches",
    l6Legs.length === 2 && Number(legOf(l6Legs, "debit", "PAYOUT-DUE")?.amount) === 33000
    && Number(legOf(l6Legs, "credit", "COST-OPS")?.amount) === 33000
    && String(legOf(l6Legs, "debit", "PAYOUT-DUE")?.detail) === `mirror of ${l6AccRow.ref}`
    && String(legOf(l6Legs, "credit", "COST-OPS")?.detail) === `mirror of ${l6AccRow.ref}`, l6Legs);
  const l6Due1 = await lineMove("PAYOUT-DUE");
  const l6Cost1 = await lineMove("COST-OPS");
  check("…and the two lines move by the mirror as they moved by the original, each cached column "
    + "carried by the same trigger that would have carried a door's",
    l6Due1.bal === l6Due0.bal - 33000 && l6Cost1.bal === l6Cost0.bal + 33000
    && l6Due1.cached === l6Due1.bal && l6Cost1.cached === l6Cost1.bal
    && l6Due1.legs === l6Due0.legs + 1 && l6Cost1.legs === l6Cost0.legs + 1,
    { due: [l6Due0, l6Due1], cost: [l6Cost0, l6Cost1] });
  const l6Still = await row("money_payouts", L6);
  const l6AccNow = await row("money_postings", l6Post);
  check("…which leaves the line failed and still pointing at the movement it just answered, and the "
    + "hand's posting reversed with the desk's sentence on it — the register cannot tell the two "
    + "accruals apart, and 134 never asked",
    l6Still.status === "failed" && String(l6Still.failed_by) === PEN
    && String(l6Still.failure_reason) === FAILWHY && String(l6Still.accrual_posting_id) === l6Post
    && l6Still.payment_posting_id === null && String(l6AccNow.status) === "reversed"
    && String(l6AccNow.reversal_note) === `Payout ${L6PAPER} failed: ${FAILWHY}`
    && String(l6AccNow.reversed_by) === PEN && (await square())?.square === true,
    { payout: l6Still, accrual: { s: l6AccNow.status, n: l6AccNow.reversal_note } });

  const pstAccrual = String((await row("money_payouts", pstId)).accrual_posting_id);
  const pstAccRow = await row("money_postings", pstAccrual);
  const pstAccRef = String(pstAccRow.ref);
  const pstDue0 = await lineMove("PAYOUT-DUE");
  const pstCost0 = await lineMove("COST-OPS");
  const failedPst = await call("the staff member's rail refuses the transfer, and the office records "
    + "the answer instead of editing the paper a signature already spent", FAILED_P,
    [PLAT, pstId, FAILWHY, PEN, "finance_officer", "127.0.0.1", "gate"]);
  const failRev = failedPst?.reversal;
  check("…which books nothing of its own: the answer is 133's mirror and the payout it explains",
    failedPst?.ok === true && /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(failRev?.ref))
    && Number(failRev?.total) === 20000 && failRev?.source_kind === "reversal"
    && String(failRev?.source_id) === pstAccrual && String(failRev?.source_ref) === pstAccRef
    && String(failRev?.memo) === "Reversal of " + pstAccRef + ": "
      + String(pstAccRow.memo).slice(0, 140)
    && String(failedPst?.payout?.status) === "failed", failedPst);
  const failLegs = await legsAll(String(failRev?.id));
  check("…two mirrored legs with the sides swapped and the original's number written into each, so "
    + "the line in the book names the movement it undoes instead of describing the failure again",
    failLegs.length === 2 && Number(legOf(failLegs, "debit", "PAYOUT-DUE")?.amount) === 20000
    && Number(legOf(failLegs, "credit", "COST-OPS")?.amount) === 20000
    && String(legOf(failLegs, "debit", "PAYOUT-DUE")?.detail) === `mirror of ${pstAccRef}`
    && String(legOf(failLegs, "credit", "COST-OPS")?.detail) === `mirror of ${pstAccRef}`, failLegs);
  const pstAccNow = await row("money_postings", pstAccrual);
  check("…and the accrual it answers is left standing, reversed rather than corrected: its memo, its "
    + "figure and the seat that raised it are the same row they were, with only the two facts of the "
    + "undoing added", pstAccNow.status === "reversed"
    && String(pstAccNow.reversal_note) === `Payout ${PST_REF} failed: ${FAILWHY}`
    && String(pstAccNow.reversed_by) === PEN && !!pstAccNow.reversed_at
    && String(pstAccNow.memo) === String(pstAccRow.memo) && Number(pstAccNow.total) === 20000
    && String(pstAccNow.raised_by) === QUILL, pstAccNow);
  const pstFailed = await row("money_payouts", pstId);
  check("…the payout reads `failed` with the seat and the sentence on it, and keeps pointing at the "
    + "accrual it no longer owes — a failed payment does not un-sign a paper, it answers it",
    pstFailed.status === "failed" && String(pstFailed.failed_by) === PEN && !!pstFailed.failed_at
    && String(pstFailed.failure_reason) === FAILWHY
    && String(pstFailed.accrual_posting_id) === pstAccrual
    && pstFailed.payment_posting_id === null, pstFailed);
  const failAud = await audOf("money_payouts", pstId, "payout.failed");
  check("…ten keys on the audit line, with the reversal's number beside the accrual's: that pair is "
    + "what lets a desk say we owed it, tried, and the rail said no without opening the book",
    String(failAud.actor_user_id) === PEN && failAud.before?.status === "released"
    && String(failAud.before?.accrual) === pstAccrual
    && Object.keys(failAud.after ?? {}).length === 10
    && String(failAud.after?.ref) === PST_REF && failAud.after?.payee === STAFF_NAME
    && Number(failAud.after?.amount) === 20000 && Number(failAud.after?.fee_amount) === 0
    && failAud.after?.rail === "cash" && String(failAud.after?.reversal) === String(failRev?.ref)
    && String(failAud.after?.accrual) === pstAccrual && String(failAud.after?.reason) === FAILWHY
    && failAud.after?.status === "failed", { keys: Object.keys(failAud.after ?? {}),
      after: failAud.after });
  const pstDue1 = await lineMove("PAYOUT-DUE");
  const pstCost1 = await lineMove("COST-OPS");
  check("…and the obligation comes off the line it was raised on: the payable gives up the 20 000 "
    + "the office no longer owes and the expense is given back, which is the mirror doing exactly "
    + "what the original did in the other direction",
    pstDue1.bal === pstDue0.bal - 20000 && pstCost1.bal === pstCost0.bal + 20000
    && [pstDue1, pstCost1].every((l) => l.cached === l.bal)
    && pstDue1.legs === pstDue0.legs + 1 && pstCost1.legs === pstCost0.legs + 1,
    { due: [pstDue0, pstDue1], cost: [pstCost0, pstCost1] });
  const failAgain = await refuses("a payout that has failed is not failed a second time", FAILED_P,
    [PLAT, pstId, FAILWHY, PEN, "finance_officer", "127.0.0.1", "gate"], "conflict");
  check("…and the state printed is `failed`, which is the answer the desk already has rather than the "
    + "one it is about to lose", failAgain?.payout_status === "failed", failAgain);
  await fails("…with the mirror itself past any hand's undoing: 133 refuses a reversal of a reversal "
    + "in the words that say an undoing of an undoing is a fresh movement", REVERSE_P,
    [PLAT, String(failRev?.id), MEMO("reversing the reversal"), PEN], "is itself a reversal",
    DOOR_RAISE);
  await fails("…nor may a hand un-fail a payout the rail answered",
    `update money_payouts set status = 'released' where id = $1::uuid`, [pstId], "and stays failed");
  const sq13f = await square();
  check("…and the book is square after the mirror: an obligation raised and then answered is two "
    + "balanced movements, not an edit to one", sq13f?.square === true, sq13f);

  /** A batch is closed when every line under it has answered, which is the one question its board "
   *  exists to ask. The count the door refuses with is read from the same board first, so the gate "
   *  proves the desk and the door are looking at the same number. */
  const br1Board = await call("the batch's own board is asked what it still owes, with one line paid, "
    + "one failed and three turned away", B_BOARD, [PLAT, "released", "TZS", BR1_REF, 10, 0]);
  const br1Row = br1Board?.rows?.find((r: Book) => String(r.id) === BR1);
  check("…which counts the answers rather than the figure the seat signed: one line outstanding, and "
    + "nothing paid yet against the 40 000 that was signed", br1Row?.outstanding === 1
    && br1Row?.failed === 1 && br1Row?.declined === 3 && br1Row?.paid === 0
    && Number(br1Row?.paid_total) === 0 && Number(br1Row?.total_amount) === 40000
    && Number(br1Row?.lines) === 2 && String(br1Row?.approval) === "applied", br1Row);
  const closeEarly = await refuses("close_money_payout_batch refuses while a line under the batch "
    + "still owes an answer", CLOSE_B,
    [PLAT, BR1, CLOSENOTE, PEN, "finance_officer", "127.0.0.1", "gate"], "lines_outstanding");
  check("…with the count the board had just printed, so a desk that can see the row is never told "
    + "something different from what it read", Number(closeEarly?.outstanding) === 1
    && String(closeEarly?.ref) === BR1_REF && /still owes an answer/.test(String(closeEarly?.message)),
    closeEarly);
  const pdrDue0 = await lineMove("PAYOUT-DUE");
  const pdrCash0 = await lineMove("OPS-CASH");
  const payPdr = await call("…and the batch's last line is paid, by a different seat from the one "
    + "that signed it", PAID_P, [PLAT, pdrId, PAYNOTE, null, ASH, "finance_officer", "127.0.0.1",
    "gate"]);
  const pdrLegs = await legsAll(String(payPdr?.posting?.id));
  check("…two legs on the till the paper was raised for: a batch line carries no cut, and the whole "
    + "obligation it signed is answered in one debit", pdrLegs.length === 2
    && Number(legOf(pdrLegs, "debit", "PAYOUT-DUE")?.amount) === 20000
    && String(legOf(pdrLegs, "debit", "PAYOUT-DUE")?.detail) === `${DRIVER_NAME} paid on ${PDR_REF}`
    && String(legOf(pdrLegs, "credit", "OPS-CASH")?.detail) === `Paid ${DRIVER_NAME} on cash`
    && pdrLegs.filter((l) => l.code === "FEE-INCOME").length === 0, pdrLegs);
  const pdrPaid = await row("money_payouts", pdrId);
  check("…stamped with the seat that holds the receipt rather than the seat that spent the signature "
    + "— `paid_by` is a fact about the desk that confirmed the money left, and the batch's release "
    + "stays whoever walked it", String(pdrPaid.paid_by) === ASH && String(pdrPaid.released_by) === QUILL
    && pdrPaid.status === "paid", pdrPaid);
  const pdrDue1 = await lineMove("PAYOUT-DUE");
  const pdrCash1 = await lineMove("OPS-CASH");
  check("…while the two lines move as the paid door alone says they should — the payable gives up the "
    + "obligation and the till is credited, both read on the credit-positive scale this gate's own "
    + "`lineBal` keeps, so one falls and the other rises by the same figure",
    pdrDue1.bal === pdrDue0.bal - 20000 && pdrCash1.bal === pdrCash0.bal + 20000
    && pdrDue1.cached === pdrDue1.bal && pdrCash1.cached === pdrCash1.bal,
    { due: [pdrDue0, pdrDue1], cash: [pdrCash0, pdrCash1] });
  const closeBR1 = await call("…and with the last answer in, the office closes the batch on its own "
    + "spent signature", CLOSE_B,
    [PLAT, BR1, CLOSENOTE, PEN, "finance_officer", "127.0.0.1", "gate"]);
  const b1close = await row("money_payout_batches", BR1);
  check("…which books nothing: a close is the desk saying the paper is done, so the figures the "
    + "second seat signed are the figures the batch still carries", closeBR1?.ok === true
    && String(closeBR1?.batch?.status) === "closed" && b1close.status === "closed"
    && String(b1close.closed_by) === PEN && String(b1close.closed_note) === CLOSENOTE
    && !!b1close.closed_at && Number(b1close.total_amount) === 40000
    && Number(b1close.lines) === 2 && String(b1close.approval_id) === PAP2, b1close);
  check("…and the detail the door hands back answers the batch's own question in the columns it was "
    + "built for: one line paid, one failed, three turned away, and the signed figure beside the sum "
    + "of everything standing under it", closeBR1?.batch?.by_status?.paid === 1
    && closeBR1?.batch?.by_status?.failed === 1 && closeBR1?.batch?.by_status?.declined === 3
    && Number(closeBR1?.batch?.lines_now) === 5 && Number(closeBR1?.batch?.signed_sum) === 40000
    && Number(closeBR1?.batch?.sum_now) === 132000
    && closeBR1?.batch?.closed_by_name === SEAT("Pen"), closeBR1?.batch);
  const b1Aud = await audOf("money_payout_batches", BR1, "payout_batch.closed");
  check("…seven keys, and no movement's number among them, because there is nothing new to point at",
    String(b1Aud.actor_user_id) === PEN && b1Aud.before?.status === "released"
    && Object.keys(b1Aud.after ?? {}).length === 7 && String(b1Aud.after?.ref) === BR1_REF
    && Number(b1Aud.after?.total_amount) === 40000 && Number(b1Aud.after?.lines) === 2
    && b1Aud.after?.currency === "TZS" && String(b1Aud.after?.note) === CLOSENOTE
    && b1Aud.after?.status === "closed", { keys: Object.keys(b1Aud.after ?? {}), after: b1Aud.after });
  const alreadyShut = await refuses("a closed batch is not closed a second time", CLOSE_B,
    [PLAT, BR1, CLOSENOTE, PEN, "finance_officer", "127.0.0.1", "gate"], "already_closed");
  check("…answered with only the paper's number and no message at all, which is a state a desk shows "
    + "rather than an apology it makes", String(alreadyShut?.ref) === BR1_REF
    && alreadyShut?.message === undefined, alreadyShut);
  const frozenFig = await fails("a batch that has spent its signature keeps the figure it spent it on "
    + "for as long as it stands, closed or not",
    `update money_payout_batches set total_amount = 3000 where id = $1::uuid`, [BR1],
    "the signed total does not move");
  check("…and the refusal prints the whole paper out of the state, the count and the money — which is "
    + "the shape that lets a desk quote the signed batch back to whoever is asking about it",
    /is closed carrying 2 line\(s\) for 40000\.00 TZS/.test(String(frozenFig?.message))
    && String(frozenFig?.message).includes(BR1_REF), frozenFig?.message);
  const frozenWhy = await fails("…and the sentence the seat signed is in the same list, because a "
    + "reason rewritten under a live signature is a different paper with the same name",
    `update money_payout_batches set reason = $2 where id = $1::uuid`,
    [BR1, MEMO("a sentence nobody was asked to sign")], "the signed total does not move");
  check("…which is the one place the guard's words are worth reading closely: it quotes the total "
    + "that did not move, because one sentence covers six columns and names none of them",
    /carrying 2 line\(s\)/.test(String(frozenWhy?.message))
    && !/reason/i.test(String(frozenWhy?.message)), frozenWhy?.message);
  await fails("…and a batch that has spent a signature does not go back to being a draft, whichever "
    + "of the two spent states it is standing in",
    `update money_payout_batches set status = 'open' where id = $1::uuid`, [BR1],
    "does not go back to a draft");
  const b1Delete = await fails("…nor is it taken off the register with its lines still under it",
    `delete from money_payout_batches where id = $1::uuid`, [BR1],
    "a batch that has asked for a signature is");
  check("…with the count of everything that ever stood under it — five, of which two were signed, "
    + "one paid, one failed and three were turned away before the paper was — which is the guard "
    + "blaming a signature for a rule about lines", /holds 5 line\(s\)/.test(String(b1Delete?.message))
    && /is closed and holds/.test(String(b1Delete?.message)), b1Delete?.message);

  /** The pair 134 cannot answer, reached from the side the office does not use: a seat with the money "
   *  duty can reverse any movement, including the accrual a released payout stands on. 133 lets it, "
   *  the failed door then has nothing left to mirror, and the paid door carries on regardless. */
  const relBpb = await walk("the staff member's bank payout is signed on its second paper and "
    + "released for 180 000", PBAP2, ASH, APPLY_R, PSIGN);
  const pbAcc13 = relBpb?.effect?.posting;
  check("…which the door grants this time, and books the accrual the burned signature never bought",
    relBpb?.effect?.ok === true && String(relBpb?.effect?.payout_id) === pbId
    && String(relBpb?.effect?.approval_id) === PBAP2 && String(relBpb?.effect?.target_kind) === "payout"
    && Number(pbAcc13?.total) === 180000 && pbAcc13?.source_kind === "payout"
    && String((await row("money_payouts", pbId)).status) === "released"
    && String((await row("money_postings", String(pbAcc13?.id))).status) === "posted", relBpb?.effect);
  const pbByHand = await call("…and a seat that reads the book rather than the board reverses that "
    + "accrual with 133's own door, before anybody has tried the rail", REVERSE_P,
    [PLAT, String(pbAcc13?.id), MEMO("the desk changed the plan"), PEN]);
  check("…which 133 allows, because it is answering a movement and not a payout: the mirror is "
    + "posted and the accrual is marked reversed", pbByHand?.ok === true
    && String(pbByHand?.original_ref) === String(pbAcc13?.ref), pbByHand);
  const pbStuck = await refuses("…which is the dead end: the payout's own failure now has nothing "
    + "left to mirror, so the door answers instead of booking a second undoing", FAILED_P,
    [PLAT, pbId, FAILWHY, PEN, "finance_officer", "127.0.0.1", "gate"], "reversal_refused");
  check("…carrying `already_reversed` and the accrual's number inside its own answer, which is all "
    + "the desk is given for a payout it can no longer fail, pay or move",
    pbStuck?.answer?.error === "already_reversed" && String(pbStuck?.answer?.ref) === String(pbAcc13?.ref),
    pbStuck);
  const pbHeld13 = await row("money_payouts", pbId);
  check("…and the payout is left released and owed, pointing at a movement the book has already "
    + "answered — a state no door of 134's can reach and none of its guards refuses",
    pbHeld13.status === "released" && String(pbHeld13.accrual_posting_id) === String(pbAcc13?.id)
    && (await row("money_postings", String(pbAcc13?.id))).status === "reversed", pbHeld13);
  const pbDue0 = await lineMove("PAYOUT-DUE");
  const pbPaid13 = await call("…while the cash door still pays it, since the paid path re-reads the "
    + "signature and never the accrual", PAID_P,
    [PLAT, pbId, PAYNOTE, null, QUILL, "finance_officer", "127.0.0.1", "gate"]);
  const pbDue1 = await lineMove("PAYOUT-DUE");
  const pbPaidLegs = await legsAll(String(pbPaid13?.posting?.id));
  check("…which is the second half of the same finding: the 180 000 leaves the bank line as the "
    + "office's own money, and the payable line is debited for an obligation its mirror already gave "
    + "back — so the figure it prints turns negative while every leg still has its pair",
    pbPaid13?.ok === true && Number(pbPaid13?.posting?.total) === 180000 && pbPaidLegs.length === 2
    && pbDue1.bal === pbDue0.bal - 180000 && pbDue1.bal < 0 && pbDue1.cached === pbDue1.bal
    && pbDue1.status === "open" && (await square())?.square === true,
    { due: [pbDue0, pbDue1], legs: pbPaidLegs });
  note("134: two states this gate reached and cannot close, both of them left for 135. A payout may "
    + "be paid while the accrual behind it has been mirrored away, and a payout whose accrual a hand "
    + "reversed can never be marked failed — `reversal_refused` is the only answer left for it and the "
    + "paper stays `released`, owed, with a movement nobody owes behind it. Neither is reachable "
    + "through the desk's own doors in the order the desk uses them; both are reachable by a seat that "
    + "can call 133. `mark_money_payout_paid` re-reads the signature and the fee line and nothing "
    + "else, and 134 has no trigger that reads a posting's status from a payout's row — which is the "
    + "guard, or at least the read, that this stage should hand on.");

  /** The batch's honest story end to end: opened by a hand, carried by one company line, signed as "
   *  one figure, released, paid, and closed — the whole walk that 12b proved in refusals. */
  const PCO_REF = String((await row("money_payouts", pcoId)).ref);
  const propBR2 = await call("the second batch is signed as one figure over its one company line",
    PROPOSE_PB, [PLAT, BR2, BREASON, PEN, SEAT_ROLE, "127.0.0.1", "gate"]);
  const PB2AP = String(propBR2?.approval_id ?? "");
  check("…which counts only what is still raised under it, so the figure the seat is shown is the "
    + "figure the release will book", propBR2?.ok === true && isUuid(PB2AP)
    && Number(propBR2?.total_amount) === 20000 && propBR2?.lines === 1
    && String(propBR2?.target_id) === BR2 && String(propBR2?.ref) === BR2_REF
    && propBR2?.currency === "TZS" && await hashAgrees(PB2AP), propBR2);
  const br2Pap = await papN(BR2);
  check("…and the batch's trail is two papers: the one a hand wrote in 12b and spent on nothing, and "
    + "this one waiting for a second seat", br2Pap.n === 2 && br2Pap.waiting === 1, br2Pap);
  const relBR2 = await walk("…signed by a third seat and released as one movement for the line "
    + "inside it", PB2AP, ASH, APPLY_R, BREASON);
  const br2Post = relBR2?.effect?.postings?.[PCO_REF];
  check("…one signature, one movement, and the map printed by the line's own number rather than by "
    + "the batch's — and the batch named inside the effect, which is where 121's runner leaves what "
    + "its own door answered", relBR2?.effect?.ok === true && relBR2?.effect?.accrued === 1
    && String(relBR2?.effect?.target_kind) === "payout_batch"
    && String(relBR2?.effect?.batch_id) === BR2
    && /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(br2Post))
    && Object.keys(relBR2?.effect?.postings ?? {}).length === 1, relBR2?.effect);
  const pcoRel = await row("money_payouts", pcoId);
  check("…the company line is released by the seat that spent the batch's signature, carries no paper "
    + "of its own, and is booked with a memo that names the batch it travelled inside",
    pcoRel.status === "released" && String(pcoRel.released_by) === ASH && pcoRel.approval_id === null
    && String(pcoRel.batch_id) === BR2 && !!pcoRel.accrual_posting_id
    && String((await one(`select memo from money_postings where ref = $1`, [String(br2Post)])).memo)
      === `Payout ${PCO_REF} released in batch ${BR2_REF} to ${BOOK("Holder B")}`.slice(0, 200),
    { line: pcoRel, memo: String(br2Post) });
  const payPco = await call("…and paid out of the office's till, because the paper was raised on cash",
    PAID_P, [PLAT, pcoId, PAYNOTE, null, QUILL, "finance_officer", "127.0.0.1", "gate"]);
  const pcoLegs = await legsAll(String(payPco?.posting?.id));
  check("…a company is paid the same way a driver is: the register's own name on the leg, the till "
    + "the rail travels on, and no income line for a cut nobody charged", payPco?.ok === true
    && pcoLegs.length === 2 && Number(legOf(pcoLegs, "debit", "PAYOUT-DUE")?.amount) === 20000
    && String(legOf(pcoLegs, "debit", "PAYOUT-DUE")?.detail)
      === `${BOOK("Holder B")} paid on ${PCO_REF}`
    && String(legOf(pcoLegs, "credit", "OPS-CASH")?.detail) === `Paid ${BOOK("Holder B")} on cash`
    && String(payPco?.payout?.status) === "paid", pcoLegs);
  const closeBR2 = await call("…and the batch closes the moment its only line has answered", CLOSE_B,
    [PLAT, BR2, CLOSENOTE, PEN, "finance_officer", "127.0.0.1", "gate"]);
  const br2Board = await call("…which is what the board's `outstanding` column answers, and the only "
    + "figure on it that says can I close this yet", B_BOARD, [PLAT, "closed", "TZS", BR2_REF, 10, 0]);
  const br2Row = br2Board?.rows?.find((r: Book) => String(r.id) === BR2);
  check("…nothing owed, one line paid, and the money the seat signed the same figure as the money "
    + "that left — the one batch in this book whose two totals agree because nothing was turned away "
    + "under it", closeBR2?.ok === true && br2Row?.outstanding === 0 && br2Row?.paid === 1
    && Number(br2Row?.paid_total) === 20000 && Number(br2Row?.total_amount) === 20000
    && br2Row?.lines === 1 && String(br2Row?.approval) === "applied"
    && String(br2Row?.closed_by) === SEAT("Pen") && String(br2Row?.raised_by) === SEAT("Pen"), br2Row);
  const sq13z = await square();
  const paidAll = await one(`select count(*)::int as n,
      coalesce(sum(amount + fee_amount)::numeric(14,2), 0) as s,
      count(*) filter (where accrual_posting_id is null)::int as no_accrual,
      count(*) filter (where payment_posting_id is null)::int as no_cash
    from money_payouts where status = 'paid'`) as Book;
  const failedAll = await one(`select count(*)::int as n,
      count(*) filter (where (select p.status from money_postings p
                                where p.id = m.accrual_posting_id) = 'reversed')::int as mirrored
    from money_payouts m where m.status = 'failed'`) as Book;
  const stateArms = await one(`select count(*)::int as n from money_payouts
      where (status = 'released' and accrual_posting_id is null)
         or (status = 'paid' and (accrual_posting_id is null or payment_posting_id is null))
         or (status = 'failed' and (accrual_posting_id is null or failed_by is null))`) as Book;
  check("…which leaves the register with five papers that have answered with cash and two that "
    + "answered with a mirror, every one of them carrying both of the movements its state names — the "
    + "hand's papers included, because 134 charges for a movement before it grants a state — and a "
    + "query that asks every state at once finds no paper that fails its own columns",
    paidAll.n === 5 && paidAll.no_cash === 0 && paidAll.no_accrual === 0
    && failedAll.n === 2 && failedAll.mirrored === 2 && stateArms.n === 0
    && sq13z?.square === true, { paid: paidAll, failed: failedAll, arms: stateArms.n, square: sq13z });
  note("the office has paid five payees and answered two refusals, on the days its own desk said the "
    + "money left, and every one of those movements is a pair of legs a year-old question can be "
    + "answered from without opening the payout register. One of the two refusals belongs to a payout "
    + "the gate released by hand under paper nobody signed, and the book cannot tell it from the other.");

  // ---------------- 14 · the reads the desk prints ----------------
  phase("14 · the twelve reads: every figure taken from the register it names, the two books' answers "
    + "kept apart, and the payee's line in nobody's words");
  /** The desk's twelve reads are the only thing a seat sees, and a read is where a wrong figure does "
   *  its damage quietly: a door that pays wrongly is caught by a guard, a board that totals a page and
   *  calls it the register is caught by nobody. So every number below is recomputed from the register
   *  in the same statement's own words rather than quoted back from the read, and the two places where
   *  the read cannot be reconciled with the paper are named as findings instead of smoothed over. */
  /** A seat column that nobody wrote is `null` on the register and `null` on the read, so the name a
   *  hand would look up for it is no name at all — and `''::uuid` is a 22P02 that ends the run. */
  const uname = async (id: any) => String(id ?? "") === "" ? ""
    : String((await one(`select full_name as n from users
    where id = $1::uuid`, [String(id)])).n ?? "");
  const seatCols = ["raised_by", "released_by", "paid_by", "failed_by", "declined_by"] as const;

  const WAL_CEN = await one(`select count(*)::int as n,
      coalesce(sum((currency = 'TZS')::int), 0)::int as tzs,
      coalesce(sum((currency = 'USD')::int), 0)::int as usd,
      coalesce(sum((status = 'frozen')::int), 0)::int as frozen
    from money_wallets where tenant_id = $1::uuid`, [PLAT]) as Book;
  const wb = await call("money_wallet_board prints the office's whole wallet list", W_BOARD,
    [PLAT, null, null, null, 60, 0]);
  const wbRows = (wb?.rows ?? []) as Book[];
  const walOrder = (await oi(`select w.id from money_wallets w
    join money_accounts a on a.id = w.account_id
    where w.tenant_id = $1::uuid order by w.opened_at desc, w.holder_name, w.currency`,
    [PLAT])).rows.map((r: Book) => String(r.id));
  /** One row, six figures, and every one of them asked of the register it describes: the balance from
   *  the legs, `cached` from the line's own running totals, `drift` as their difference, `legs` from
   *  `money_entries`, `holds` from the live papers that name that wallet on either side and
   *  `withdrawals` from the payout register. A board that copied one of these from another would agree
   *  with itself and prove nothing. */
  const walBad = [] as string[];
  for (const r of wbRows) {
    const id = String(r.id);
    const line = String((await row("money_wallets", id, "account_id, opened_by")).account_id);
    const by = String((await row("money_wallets", id, "opened_by")).opened_by);
    const fig = await accFig(line);
    const holds = Number((await one(`select count(*)::int as n from money_escrow_holds
        where tenant_id = $1::uuid and (payer_wallet_id = $2::uuid or payee_wallet_id = $2::uuid)
          and status in ('held','pending_discharge')`, [PLAT, id])).n);
    const wds = Number((await one(`select count(*)::int as n from money_payouts
        where tenant_id = $1::uuid and source_kind = 'wallet_withdrawal' and source_id = $2::uuid`,
      [PLAT, id])).n);
    const legs = await walletBal(id);
    if (Number(r.balance) !== legs || Number(r.cached) !== Number(fig.cached)
      || Number(r.legs) !== Number(fig.legs)
      || Number(r.drift) !== Number(r.balance) - Number(r.cached)
      || Number(r.holds) !== holds || Number(r.withdrawals) !== wds
      || String(r.account) !== await codeOf(line) || String(r.opened_by) !== await uname(by)
      || String(r.owner_type) !== String((await row("tenants", String(r.owner_tenant_id), "type")).type))
      walBad.push(String(r.holder));
  }
  check("…one row per wallet the register holds, in the order the read promises and with all six of "
    + "its figures recomputed from the book, the holds and the payout register beside it — including "
    + "the seat that opened it, printed as a name rather than as an uuid",
    wb?.count === WAL_CEN.n && wb?.returned === wbRows.length && wbRows.length === WAL_CEN.n
    && wb?.limit === 60 && wb?.offset === 0 && walBad.length === 0
    && wbRows.map((r) => String(r.id)).join() === walOrder.join(), { bad: walBad,
      board: wb?.count, register: WAL_CEN.n });

  const wbUsd = await call("…asked for the dollars with lower case and spaces around them", W_BOARD,
    [PLAT, null, "  usd  ", null, 60, 0]);
  check("…which the read trims and upper-cases before it compares, because a desk types money the way "
    + "it says it", (wbUsd?.rows ?? []).every((r: Book) => r.currency === "USD")
    && wbUsd?.count === WAL_CEN.usd && (wbUsd?.held ?? []).length === 1
    && String(wbUsd?.held?.[0]?.currency) === "USD" && wbUsd?.limit === 60, wbUsd);

  const frzWal = await call("the office stops a third holder's wallet so that the board has a frozen "
    + "row to filter on", FREEZE_W, [PLAT, String(WAL_C), STOP, INK, true, "compliance_officer",
    "127.0.0.1", "gate"]);
  const frzReg = (await oi(`select id, note, frozen_reason from money_wallets
    where tenant_id = $1::uuid and status = 'frozen'`, [PLAT])).rows as Book[];
  const frzBy = new Map(frzReg.map((g) => [String(g.id), g]));
  const frozenIds = [...frzBy.keys()].sort();
  const wbFrozen = await call("…and the status filter answers the register rather than a state the "
    + "desk happens to remember", W_BOARD, [PLAT, "FROZEN", null, null, 60, 0]);
  const wbFrozenRows = (wbFrozen?.rows ?? []) as Book[];
  check("…every frozen wallet and only frozen wallets, each carrying the sentence the office wrote "
    + "when it stopped the line, taken off the register row beside it rather than off the state the "
    + "board was asked for",
    frzWal?.ok === true && wbFrozen?.count === frozenIds.length
    && wbFrozenRows.map((r) => String(r.id)).sort().join() === frozenIds.join()
    && wbFrozenRows.every((r) => { const g = frzBy.get(String(r.id));
      return r.status === "frozen" && !!r.frozen_reason
        && String(r.frozen_reason) === String(g?.frozen_reason)
        && String(r.note ?? "") === String(g?.note ?? ""); })
    && wbFrozenRows.some((r) => String(r.id) === String(WAL_C) && r.frozen_by === undefined
      && String(r.frozen_reason) === STOP),
    { frozen: frozenIds, board: wbFrozenRows.map((r) => [r.holder, r.status]) });
  await call("…so the office opens it again, and the board forgets it ever stopped", FREEZE_W,
    [PLAT, String(WAL_C), "", INK, false, "compliance_officer", "127.0.0.1", "gate"]);
  const wbOpen = await call("money_wallet_board after the unfreeze", W_BOARD,
    [PLAT, "open", null, null, 200, 0]);
  check("…which it does: the open filter finds the whole list again, because a freeze that left a "
    + "shadow row would be a holder told their money is still stopped",
    wbOpen?.count === WAL_CEN.n && Number((await one(`select count(*)::int as n from money_wallets
      where tenant_id = $1::uuid and status = 'frozen'`, [PLAT])).n) === WAL_CEN.frozen,
    { open: wbOpen?.count, all: WAL_CEN.n });

  const wbHolder = await call("…and the same board found by a word the holder's own name carries",
    W_BOARD, [PLAT, null, null, "Holder A", 60, 0]);
  const holderAName = String((await row("tenants", holderA, "name")).name);
  const twoLines = Number((await one(`select count(*)::int as n from money_wallets
    where tenant_id = $1::uuid and holder_name = $2`, [PLAT, holderAName])).n);
  check("…which is a search over the holder's name and the note the office wrote when it opened the "
    + "line — so one company's two monies are found by either word",
    wbHolder?.count === twoLines && twoLines === 2
    && (wbHolder?.rows ?? []).every((r: Book) => String(r.holder) === holderAName)
    && (wbHolder?.rows ?? []).map((r: Book) => r.currency).sort().join() === "TZS,USD",
    { found: wbHolder?.count, rows: wbHolder?.rows?.map((r: Book) => r.currency) });
  /** A second holder's note says the same first word as the shipper's, so the gate searches a word "
   *  only one note carries and compares the answer with the register's own count rather than with a "
   *  number it has decided in advance. */
  const NOTE_WORD = "advanced";
  const wbNote = await call("…and by the second word of the note instead of the name", W_BOARD,
    [PLAT, null, null, NOTE_WORD, 60, 0]);
  const noteHits = Number((await one(`select count(*)::int as n from money_wallets
    where tenant_id = $1::uuid and (holder_name ilike '%' || $2 || '%'
      or coalesce(note, '') ilike '%' || $2 || '%')`, [PLAT, NOTE_WORD])).n);
  check("…which is the search over the holder's name and the note the office wrote when it opened "
    + "the line, counted the same way the register counts it — because a desk that has lost a holder "
    + "remembers what the money was for",
    wbNote?.count === noteHits && noteHits === 1
    && String(wbNote?.rows?.[0]?.holder) === String((await row("tenants", shipper, "name")).name)
    && String(wbNote?.rows?.[0]?.note).includes(NOTE_WORD), { hits: noteHits,
      rows: wbNote?.rows?.map((r: Book) => r.holder) });

  /** The heading a desk quotes on the phone is grouped over every row the filters still name, not over
   *  the page it is printed above — so the page can be one wallet wide and the figure can still be the
   *  office's whole exposure. */
  const walHeldAll = (await oi(`select currency, count(*)::int as wallets,
      coalesce(sum((status = 'frozen')::int), 0)::int as frozen, coalesce(sum(
        platform_auth.money_wallet_balance(id)), 0)::numeric(14,2) as held
    from money_wallets where tenant_id = $1::uuid group by currency order by currency`,
    [PLAT])).rows as Book[];
  const wbPage = await call("…with the page cut to one row, the heading above it still adds up the "
    + "whole register", W_BOARD, [PLAT, null, null, null, 1, 0]);
  check("…because a desk that totals the twenty rows it can see reports a fraction of the money it "
    + "holds as the whole", (wbPage?.rows ?? []).length === 1
    && (wbPage?.held ?? []).length === walHeldAll.length
    && walHeldAll.every((g: Book) => {
      const h = (wbPage?.held ?? []).find((x: Book) => x.currency === g.currency) as Book;
      return !!h && Number(h.wallets) === Number(g.wallets) && Number(h.held) === Number(g.held)
        && Number(h.frozen) === Number(g.frozen);
    }), { heading: wbPage?.held, register: walHeldAll });
  const wbMin = await call("a board asked for no rows at all is clamped to one rather than refused",
    W_BOARD, [PLAT, null, null, null, 0, -7]);
  check("…which is the pair of `least` and `greatest` the read writes for a form that has not picked a "
    + "page size yet: limit one, offset zero, and the register still counted behind them",
    wbMin?.limit === 1 && wbMin?.offset === 0 && (wbMin?.rows ?? []).length === 1
    && wbMin?.count === WAL_CEN.n, wbMin);
  const wbMax = await call("…and a page size past the read's own ceiling is cut, not honoured",
    W_BOARD, [PLAT, null, null, null, 9999, 0]);
  check("…at two hundred rows, with `count` still the register's number so a desk can say there is "
    + "more to come", wbMax?.limit === 200 && (wbMax?.rows ?? []).length === WAL_CEN.n
    && wbMax?.count === WAL_CEN.n, { limit: wbMax?.limit, n: WAL_CEN.n });

  const walALegs = Number((await one(`select count(*)::int as n from money_entries
    where account_id = $1::uuid`, [WAL_A_LINE])).n);
  const wd1 = await call("money_wallet_detail opens the first holder's balance in full", W_DETAIL,
    [PLAT, String(WAL_A)]);
  const walARow = await row("money_wallets", String(WAL_A));
  check("…naming the holder as the register names them, the company as the tenants register names it, "
    + "the line the balance rides on as 133's own account row, and the figure as the legs compute it",
    wd1?.id === WAL_A && String(wd1?.holder) === String(walARow.holder_name)
    && String(wd1?.owner_name) === holderAName && wd1?.owner_type === "transporter"
    && wd1?.currency === "TZS" && wd1?.status === "open"
    && String(wd1?.account?.code) === await codeOf(WAL_A_LINE)
    && wd1?.account?.tenant_id === undefined && Number(wd1?.balance) === await walletBal(String(WAL_A))
    && String(wd1?.opened_by) === await uname(walARow.opened_by),
    { holder: wd1?.holder, account: wd1?.account?.code, bal: wd1?.balance });
  const walMHolds = (wd1?.movements ?? []) as Book[];
  check("…printing at most twelve movements on that line and exactly the twelve the panel can carry "
    + "once the balance has more to show, each with its own number, its day as text and the words the "
    + "movement was booked with",
    walMHolds.length === Math.min(12, walALegs) && walMHolds.length <= 12
    && walMHolds.every((m: Book) => /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(m.ref))
      && /^\d{4}-\d{2}-\d{2}$/.test(String(m.posted_on))
      && ["debit", "credit"].includes(String(m.direction))
      && (m.detail === null || String(m.detail).trim().length >= 3)),
    { shown: walMHolds.length, legs: walALegs, first: walMHolds[0] });
  const holdSides = new Map(((await oi(`select id, payer_wallet_id from money_escrow_holds
    where tenant_id = $1::uuid`, [PLAT])).rows as Book[]).map((h) => [String(h.id), h]));
  const walAHolds = (wd1?.holds ?? []) as Book[];
  check("…with the papers that move it on the same page: every hold it is a party to filed on the side "
    + "it stands on, and every withdrawal raised against it cut from the payout register",
    walAHolds.length <= 12 && walAHolds.length === Math.min(12, Number((await one(
      `select count(*)::int as n from money_escrow_holds where tenant_id = $1::uuid
        and (payer_wallet_id = $2::uuid or payee_wallet_id = $2::uuid)`,
      [PLAT, String(WAL_A)])).n))
    && walAHolds.every((h: Book) => String(h.side) === (String(holdSides.get(String(h.id))
      ?.payer_wallet_id) === String(WAL_A) ? "payer" : "payee"))
    && Number((wd1?.withdrawals ?? []).length) === Number((await one(
      `select count(*)::int as n from money_payouts where tenant_id = $1::uuid
        and source_kind = 'wallet_withdrawal' and source_id = $2::uuid`,
      [PLAT, String(WAL_A)])).n)
    && (wd1?.withdrawals ?? []).every((p: Book) => Number(p.fee) === 1500
      && ["raised", "pending_signature", "released", "paid", "failed", "declined"]
        .includes(String(p.status))),
    { holds: walAHolds.length, withdrawals: wd1?.withdrawals });
  const wdGone = await call("money_wallet_detail answers a wallet the office does not hold", W_DETAIL,
    [PLAT, NO_BODY]);
  check("…with the sentence a desk prints as a line rather than an empty object",
    wdGone?.error === "There is no wallet in this book." && wdGone?.id === undefined, wdGone);
  const wdOther = await call("…and the same sentence when the wallet exists but is asked out of that "
    + "company's own book", W_DETAIL, [holderA, String(WAL_A)]);
  check("…which is the pair the desk cannot tell apart and must not be able to, because a difference "
    + "between the two answers is a way to ask the register whether an id is somebody's",
    String(wdOther?.error) === "There is no wallet in this book.", wdOther);

  const P_CEN = await one(`select count(*)::int as n,
      coalesce(sum((status = 'paid')::int), 0)::int as paid,
      coalesce(sum((status = 'released')::int), 0)::int as released,
      coalesce(sum((payee_kind = 'driver')::int), 0)::int as driver,
      coalesce(sum((rail_code = 'bank')::int), 0)::int as bank,
      coalesce(sum((payee_ref_encrypted is not null)::int), 0)::int as sealed,
      coalesce(sum((currency = 'USD')::int), 0)::int as usd
    from money_payouts where tenant_id = $1::uuid`, [PLAT]) as Book;
  const pbAll = await call("money_payout_board prints the register of money that has left or is owed",
    P_BOARD, [PLAT, null, null, null, null, null, null, 200, 0]);
  const payOrder = (await oi(`select id from money_payouts where tenant_id = $1::uuid
    order by raised_at desc, ref desc`, [PLAT])).rows.map((r: Book) => String(r.id));
  const pbAllRows = (pbAll?.rows ?? []) as Book[];
  check("…in the order it promises and with the ref, the payee, the rail in the words a person reads, "
    + "the paper's own two movements and the state of the signature standing over it on every row",
    pbAll?.count === P_CEN.n && pbAll?.returned === pbAllRows.length
    && pbAllRows.map((r) => String(r.id)).join() === payOrder.join()
    && pbAllRows.every((r) => /^PAY-[0-9]{4}-[0-9]{5,}$/.test(String(r.ref))
      && !!r.payee_name && (r.accrual === null || /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(r.accrual)))
      && (r.payment === null || /^PST-[0-9]{4}-[0-9]{5,}$/.test(String(r.payment)))
      && String(r.rail_label) !== "" && String(r.rail_family) !== ""
      && ((r.batch === null) === (r.batch_id === null))),
    { n: pbAll?.count, register: P_CEN.n });
  const paidNoAccrual = Number((await one(`select count(*)::int as n from money_payouts
    where tenant_id = $1::uuid and status = 'paid' and accrual_posting_id is null`, [PLAT])).n);
  const paidIds = (await oi(`select id from money_payouts where tenant_id = $1::uuid
    and status = 'paid'`, [PLAT])).rows.map((r: Book) => String(r.id)).sort();
  const pbPaid = await call("…filtered to the papers that have answered with cash", P_BOARD,
    [PLAT, "paid", null, null, null, null, null, 60, 0]);
  const pbPaidRows = (pbPaid?.rows ?? []) as Book[];
  check("…every paid paper and only paid papers, each with the cash it left by printed as a movement "
    + "a receipt can quote and the hour the desk confirmed it — and with no row missing its accrual, "
    + "which is the board agreeing with the register's own CHECK rather than watching it: a paid paper "
    + "that names no movement cannot exist, so this column is not where a hand's under-sized one shows",
    pbPaid?.count === paidIds.length && pbPaidRows.map((r) => String(r.id)).sort().join()
      === paidIds.join() && pbPaidRows.every((r) => r.status === "paid" && !!r.payment
      && !!r.paid_at && Number(r.total) === Number(r.amount) + Number(r.fee))
    && pbPaidRows.filter((r) => r.accrual === null).length === paidNoAccrual
    && paidNoAccrual === 0,
    pbPaidRows.map((r) => [r.ref, r.accrual, r.payment]));
  const pbBank = await call("…by the rail the money travels by, and by the kind of payee", P_BOARD,
    [PLAT, null, null, null, "BANK", null, null, 60, 0]);
  const pbDriver = await call("…and the same board asked for the drivers", P_BOARD,
    [PLAT, null, null, " Driver ", null, null, null, 60, 0]);
  check("…where both filters are trimmed and folded before they are compared, so a form that sends "
    + "`BANK` or ` Driver ` finds the rows it meant",
    pbBank?.count === P_CEN.bank && pbDriver?.count === P_CEN.driver
    && (pbBank?.rows ?? []).every((r: Book) => r.rail === "bank")
    && (pbDriver?.rows ?? []).every((r: Book) => r.payee_kind === "driver"),
    { bank: pbBank?.count, driver: pbDriver?.count });
  const pbRef = await call("…and found by the number printed on the paper", P_BOARD,
    [PLAT, null, null, null, null, null, PM_REF, 60, 0]);
  const pbName = await call("…or by the payee's own name, which is what a caller gives the desk",
    P_BOARD, [PLAT, null, null, null, null, null, DRIVER_NAME, 60, 0]);
  check("…which is the pair of searches the read runs over the number, the payee, the purpose and the "
    + "quote the paper stands on", pbRef?.count === 1 && String(pbRef?.rows?.[0]?.id) === pmId
    && Number(pbName?.count) === Number((await one(`select count(*)::int as n from money_payouts
      where tenant_id = $1::uuid and payee_name = $2`, [PLAT, DRIVER_NAME])).n),
    { byRef: pbRef?.count, byName: pbName?.count });
  /** The sealed line is the register's reason for existing, so the board is read against the column it "
   *  stands for rather than against itself. */
  const sealedIds = (await oi(`select id from money_payouts where tenant_id = $1::uuid
    and payee_ref_encrypted is not null`, [PLAT])).rows.map((r: Book) => String(r.id)).sort();
  check("…and the board marks exactly the papers whose payee line is sealed, prints only the tail the "
    + "rail's own rule allows, and carries no hash and no ciphertext on a row that leaves the screen",
    pbAllRows.filter((r) => r.line_sealed === true).map((r) => String(r.id)).sort().join()
      === sealedIds.join() && pbAllRows.every((r) => !("payee_ref_hash" in r)
      && !("payee_ref_encrypted" in r) && (r.line_tail === null
        || String(r.line_tail).length <= 4)),
    { sealed: sealedIds.length, row_keys: Object.keys(pbAllRows[0] ?? {}).filter((k) => /ref|encrypt/) });
  const pbMin = await call("the payout board asked for no rows is clamped the same way", P_BOARD,
    [PLAT, null, null, null, null, null, null, 0, -9]);
  const pbMax = await call("…and asked for more rows than a read will ever send", P_BOARD,
    [PLAT, null, null, null, null, null, null, 9999, 0]);
  check("…limit one and offset zero at the bottom, two hundred at the top, and the register's own "
    + "count in both answers", pbMin?.limit === 1 && pbMin?.offset === 0
    && (pbMin?.rows ?? []).length === 1 && pbMax?.limit === 200 && pbMax?.count === P_CEN.n,
    { min: [pbMin?.limit, pbMin?.offset], max: pbMax?.limit });
  const paged = new Set<string>();
  for (let off = 0; off < P_CEN.n; off += 4) {
    const pg = await call(`…the register paged four at a time from offset ${off}`, P_BOARD,
      [PLAT, null, null, null, null, null, null, 4, off]);
    if ((pg?.rows ?? []).length === 0) break;
    (pg?.rows ?? []).forEach((r: Book) => paged.add(String(r.id)));
  }
  check("…which comes back the same register however it is cut — every paper exactly once — because "
    + "the page is cut before the rows are built and the two halves of the read use the same filters",
    paged.size === P_CEN.n && P_CEN.n >= 8, { seen: paged.size, n: P_CEN.n });
  /** The first of the two findings this gate cannot repair from a gate. */
  const dueAll = (await oi(`select currency,
      count(*) filter (where status = 'released')::int as released,
      count(*) filter (where status = 'pending_signature')::int as awaiting,
      coalesce(sum(amount + fee_amount) filter (where status = 'released'), 0)::numeric(14,2) as due,
      count(*) filter (where status = 'failed')::int as failed
    from money_payouts where tenant_id = $1::uuid group by currency order by currency`,
    [PLAT])).rows as Book[];
  check("…and the `due` heading beside those rows is the whole register's, in every money the office "
    + "has ever paid in, with nothing of the filter that cut the rows visible in it",
    (pbPaid?.due ?? []).length === dueAll.length && dueAll.every((g: Book) => {
      const d = (pbPaid?.due ?? []).find((x: Book) => x.currency === g.currency) as Book;
      return !!d && Number(d.due) === Number(g.due) && Number(d.released) === Number(g.released)
        && Number(d.awaiting) === Number(g.awaiting) && Number(d.failed) === Number(g.failed);
    }), { due: pbPaid?.due, register: dueAll });
  const br1Lines = Number((await one(`select count(*)::int as n from money_payouts
    where batch_id = $1::uuid`, [BR1])).n);
  const byBatchRef = await call("…while the batch filter is asked for a batch by the number printed "
    + "on it", P_BOARD, [PLAT, null, null, null, null, BR1_REF, null, 60, 0]);
  const byBatchId = await call("…and the same filter asked with the id behind that number", P_BOARD,
    [PLAT, null, null, null, null, BR1, null, 60, 0]);
  check("…which is the second: `p_batch` is typed `text` and matched against a uuid pattern, so a ref "
    + "is not an error but a filter that quietly does nothing — the desk is shown the whole register "
    + "and believes it is shown one batch",
    byBatchId?.count === br1Lines && (byBatchId?.rows ?? []).length === br1Lines
    && byBatchRef?.count === P_CEN.n && (byBatchRef?.rows ?? []).length === P_CEN.n,
    { byRef: byBatchRef?.count, byId: byBatchId?.count, lines: br1Lines });
  note("134: neither of those two is this gate's to close. The `due` block is honest for an unfiltered "
    + "board and misleading above a filtered one, and `p_batch` silently answers for the whole "
    + "register whenever a desk quotes a batch number at it — which is exactly what a seat reading a "
    + "printed paper does. 135's work: bind the heading to the filters the rows were cut with, and "
    + "resolve a `PBT-` ref to its id before it is compared, or refuse it in words.");

  const P_DETAIL_KEYS = ["id", "tenant_id", "ref", "batch_id", "payee_kind", "payee_id",
    "payee_name", "payee_tenant_id", "rail_code", "rail_label", "rail_family", "rail_needs",
    "payee_ref_tail", "payee_ref_hash", "line_sealed", "amount", "fee_amount", "total", "currency",
    "source_kind", "source_id", "source_ref", "purpose", "status", "fund", "payable", "cash",
    "accrual_posting", "payment_posting", "approval", "batch", "source_paper", "raised_by",
    "raised_at", "released_by", "released_at", "paid_by", "paid_at", "paid_note", "failed_by",
    "failed_at", "failure_reason", "declined_by", "declined_at", "declined_note", "created_at",
    "updated_at"];
  const pd = await call("money_payout_detail opens the driver's paid paper in full", P_DETAIL,
    [PLAT, pmId]);
  const pmCols = await row("money_payouts", pmId);
  const railM = await one(`select label, family, needs from money_payout_rails where code = 'mpesa'`) as Book;
  check("…printing exactly the forty-seven fields the desk's own module reads, in no order the gate "
    + "has to guess at, and nothing else", same(Object.keys(pd ?? {}), P_DETAIL_KEYS),
    { extra: Object.keys(pd ?? {}).filter((k) => !P_DETAIL_KEYS.includes(k)),
      missing: P_DETAIL_KEYS.filter((k) => !(k in (pd ?? {}))) });
  check("…with the rail answered in the three words a clerk chooses by — the label, the family, and "
    + "the shape the payee line had to be — and the payee's line kept as the tail and the hash only",
    pd?.rail_label === railM.label && pd?.rail_family === railM.family && pd?.rail_needs === "phone"
    && String(pd?.payee_ref_tail) === "1111" && String(pd?.payee_ref_hash) === HASH64
    && pd?.line_sealed === true && !("payee_ref_encrypted" in (pd ?? {}))
    && pd?.payee_name === DRIVER_NAME && String(pd?.payee_id) === driver, pd?.payee_name);
  /** The three lines are 133's own account row, which strips its own `tenant_id`. The payout row is "
   *  134's own field list, which does not. */
  for (const which of ["fund", "payable", "cash"] as const) {
    const want = await codeOf(String((pmCols as Book)[`${which}_account_id`] ?? ""));
    check(`…resolving the ${which} line by id into the book's own row for it, so the desk reads the `
      + "obligation, the fund and the cash as accounts rather than as three uuids",
      String(pd?.[which]?.code) === want && pd?.[which]?.tenant_id === undefined,
      { printed: pd?.[which]?.code, wanted: want });
  }
  const pmAccLegs = await legsAll(String(pmCols.accrual_posting_id));
  const pmCashLegs14 = await legsAll(String(pmCols.payment_posting_id));
  /** The register's own leg row calls the column `side` because this gate asked it with `lower(direction)
   *  as side`, while 133's posting detail prints the column under its own name. Same fact, two shapes,
   *  and the comparison below is the one that has to know that. */
  const legWords = (l: Book) => `${String(l.code).toLowerCase()}:${String(l.side ?? l.direction)
    .toLowerCase()}:${Number(l.amount)}`;
  check("…and the movements both sides of the paper, each as 133 prints it: the accrual the signature "
    + "bought and the cash the desk confirmed, with every leg its own register carries printed beside "
    + "them — line, side and figure, not a count the read invented",
    String(pd?.accrual_posting?.ref) === String(relPost?.ref) && pd?.accrual_posting?.status === "posted"
    && pd?.accrual_posting?.tenant_id === undefined
    && pd?.accrual_posting?.idempotency_key === undefined
    && (pd?.accrual_posting?.legs ?? []).length === pmAccLegs.length
    && sameFold((pd?.accrual_posting?.legs ?? []).map(legWords), pmAccLegs.map(legWords))
    && String(pd?.payment_posting?.ref) === String(cashPost13?.ref)
    && (pd?.payment_posting?.legs ?? []).length === pmCashLegs14.length
    && sameFold((pd?.payment_posting?.legs ?? []).map(legWords), pmCashLegs14.map(legWords))
    && pmCashLegs14.length > pmAccLegs.length
    && String(pd?.payment_posting?.raised_by_name) === SEAT("Pen"),
    { accrual: pmAccLegs.map(legWords), cash: pmCashLegs14.map(legWords) });
  const APPR_KEYS = ["id", "action", "status", "reason", "target_kind", "target_id", "proposed_by",
    "proposed_role", "proposed_at", "decided_by", "decided_role", "decided_note", "decided_at",
    "applied_at", "expires_at", "result"];
  check("…with the signature beside it as sixteen fields the second seat can be held to — who asked, "
    + "who signed, what they were told, when it expired and what the effect answered — and no payload, "
    + "which is the bytes the hash was taken of and nothing a desk reads",
    same(Object.keys(pd?.approval ?? {}), APPR_KEYS) && !("payload" in (pd?.approval ?? {}))
    && pd?.approval?.status === "applied" && String(pd?.approval?.id) === PAPP
    && pd?.approval?.reason === PSIGN && String(pd?.approval?.proposed_by) === SEAT("Pen")
    && String(pd?.approval?.decided_by) === SEAT("Quill") && pd?.approval?.applied_at !== null
    && pd?.approval?.result !== undefined, pd?.approval);
  const pmSeatBad = [] as string[];
  for (const c of seatCols) {
    if (String(pd?.[c] ?? "") !== await uname((pmCols as Book)[c])) pmSeatBad.push(c);
  }
  check("…and every seat the paper remembers printed as that seat's name, including the one that "
    + "confirmed the cash and the two that never touched it",
    pmSeatBad.length === 0 && pd?.paid_by === SEAT("Pen") && pd?.released_by === SEAT("Quill")
    && pd?.raised_by === SEAT("Pen") && pd?.declined_by === null && pd?.failed_by === null
    && pd?.paid_note === PAYNOTE && pd?.batch === null && pd?.source_paper === null
    && pd?.batch_id === null && pd?.source_id === null, pmSeatBad);
  check("…with one leak this gate records rather than repairs: the payout row carries its own "
    + "`tenant_id`, spelled out in 134's field list, while the account rows nested inside it have had "
    + "theirs taken off by 133's helper and the batch detail takes its own off in its own first line",
    String(pd?.tenant_id) === PLAT && pd?.fund?.tenant_id === undefined
    && pd?.accrual_posting?.tenant_id === undefined, { printed: pd?.tenant_id });
  const pdPst = await call("money_payout_detail opens the paper the rail answered no to", P_DETAIL,
    [PLAT, pstId]);
  const pstCols = await row("money_payouts", pstId);
  check("…which is the read that answers the question a caller actually asks after a refusal: the "
    + "accrual is still printed, marked reversed, with the mirror that answered it named and the "
    + "sentence the office wrote beside both — and no cash movement, because none left",
    pdPst?.status === "failed" && pdPst?.payment_posting === null
    && String(pdPst?.accrual_posting?.status) === "reversed"
    && String(pdPst?.accrual_posting?.reversal_note)
      === `Payout ${PST_REF} failed: ${FAILWHY}`
    && String(pdPst?.accrual_posting?.answered_by?.ref) === String(failRev?.ref)
    && (pdPst?.accrual_posting?.answers ?? []).length === 1
    && String(pdPst?.accrual_posting?.reversed_by_name) === SEAT("Pen")
    && pdPst?.failure_reason === FAILWHY && String(pdPst?.failed_by) === await uname(pstCols.failed_by),
    { reversal: pdPst?.accrual_posting?.reversal_note, by: pdPst?.accrual_posting?.reversed_by_name });
  const pdPf = await call("money_payout_detail opens the paper this gate released and paid by hand, "
    + "under a signature no seat ever read", P_DETAIL, [PLAT, pf]);
  check("…and every half of it prints as an ordinary paid paper: the accrual a hand booked stands with "
    + "its own number and its own poster, the cash the door wrote is on the row, and the approval is a "
    + "decided line with a second seat's name against it. What the page cannot say is what those bytes "
    + "were — `money_approval` prints names, states, reasons and a result, and never the payload the "
    + "hash was taken of — so the only figure on this whole read that can be set beside the paper's "
    + "30 000 is the accrual's own total, and it answers 10 000",
    pdPf?.status === "paid" && String(pdPf?.accrual_posting?.status) === "posted"
    && Number(pdPf?.accrual_posting?.total) === 10000
    && (pdPf?.accrual_posting?.legs ?? []).length === 2
    && String(pdPf?.accrual_posting?.source_ref) === String(pdPf?.ref)
    && String(pdPf?.accrual_posting?.raised_by_name) === SEAT("Ash")
    && Number(pdPf?.payment_posting?.total) === 30000 && Number(pdPf?.total) === 30000
    && String(pdPf?.approval?.decided_by) === SEAT("Ash")
    && pdPf?.approval?.payload === undefined
    && pdPf?.line_sealed === false && pdPf?.payee_ref_hash === null
    && String(pdPf?.payee_name) === BOOK("Stranger"),
    { accrual: [pdPf?.accrual_posting?.status, pdPf?.accrual_posting?.total], approval: pdPf?.approval });
  const pdPb = await call("money_payout_detail opens the paper whose accrual a hand reversed and the "
    + "desk paid anyway", P_DETAIL, [PLAT, pbId]);
  check("…and prints both halves of the finding: an accrual that no longer stands, the mirror that "
    + "gave the obligation back, and a cash movement on top of it — a desk reading this row has to "
    + "notice that the paper's own two movements cancel each other rather than pay",
    pdPb?.status === "paid" && String(pdPb?.accrual_posting?.status) === "reversed"
    && String(pdPb?.accrual_posting?.reversal_note) === MEMO("the desk changed the plan")
    && String(pdPb?.payment_posting?.status) === "posted" && (pdPb?.payment_posting?.legs ?? []).length === 2
    && Number(pdPb?.total) === 180000 && pdPb?.rail_code === "bank"
    && String(pdPb?.payee_ref_tail) === "0042", pdPb?.accrual_posting?.status);
  const pdGone = await call("money_payout_detail answers a paper the office does not have", P_DETAIL,
    [PLAT, NO_BODY]);
  check("…with its own sentence, and the same one when the paper is the office's but the book asked is "
    + "a company's", String(pdGone?.error) === "There is no payout in this book."
    && String((await call("…and asked of a company's own book", P_DETAIL,
      [holderA, pmId]))?.error) === "There is no payout in this book.", pdGone);

  const br1Cen = await one(`select count(*)::int as n,
      coalesce(sum(amount + fee_amount)::numeric(14,2), 0) as s,
      coalesce(max(total_amount), 0) as signed
    from money_payouts p join money_payout_batches b on b.id = p.batch_id
    where p.batch_id = $1::uuid`, [BR1]) as Book;
  const b1Detail = await call("money_payout_batch_detail opens the closed batch with its lines",
    B_DETAIL, [PLAT, BR1]);
  check("…which is the read that says whether the paper still describes the money: the figure the "
    + "seat signed, the figure the lines add to now, and the word `figures_agree` about the pair — "
    + "counted over every line including the ones that were turned away, and recomputed here from the "
    + "register rather than from what the gate remembers asking for",
    b1Detail?.tenant_id === undefined && Number(b1Detail?.signed_sum) === Number(br1Cen.signed)
    && Number(b1Detail?.sum_now) === Number(br1Cen.s)
    && b1Detail?.figures_agree === (Number(br1Cen.s) === Number(br1Cen.signed))
    && Number(b1Detail?.lines_now) === br1Lines && br1Lines === br1Cen.n
    && (b1Detail?.payouts ?? []).length === br1Cen.n
    && String(b1Detail?.closed_by_name) === SEAT("Pen")
    && String(b1Detail?.approval?.status) === "applied"
    && (b1Detail?.payouts ?? []).every((p: Book) => !("payee_ref_hash" in p)
      && !("payee_ref_encrypted" in p)), { keys: Object.keys(b1Detail ?? {}).length,
      agree: b1Detail?.figures_agree, signed: br1Cen.signed, now: br1Cen.s, lines: br1Cen.n });
  const bBoard = await call("the batches board is clamped by the same two lines of code", B_BOARD,
    [PLAT, null, null, null, 9999, -4]);
  const bCen = await one(`select count(*)::int as n from money_payout_batches
    where tenant_id = $1::uuid`, [PLAT]) as Book;
  check("…limit two hundred, offset zero, and the register's own count of batches behind it, with a "
    + "closed batch's `outstanding` answering zero at last",
    bBoard?.limit === 200 && bBoard?.offset === 0 && bBoard?.count === bCen.n
    && (bBoard?.rows ?? []).find((r: Book) => String(r.id) === BR1)?.outstanding === 0
    && (bBoard?.rows ?? []).find((r: Book) => String(r.id) === BR2)?.outstanding === 0,
    { n: bCen.n, rows: bBoard?.returned });
  const payZ = await payable();
  const payZRows = (payZ?.rows ?? []) as Book[];
  const payBad = [] as string[];
  for (const r of payZRows) {
    const line = await one(`select id, (credit_total - debit_total) as cached,
        entry_count as legs from money_accounts where tenant_id = $1::uuid and code = $2`,
      [PLAT, String(r.account)]) as Book;
    const fig = await accFig(String(line.id));
    const legs = Number((await one(`select coalesce(sum(case when direction = 'credit' then amount
        else -amount end), 0)::numeric(14,2) as b from money_entries
      where account_id = $1::uuid`, [String(line.id)])).b);
    if (Number(r.cached) !== Number(fig.cached) || Number(r.book) !== legs
      || String(r.kind) !== String((await row("money_accounts", String(line.id), "kind")).kind))
      payBad.push(String(r.account));
  }
  const payDue = payZRows.find((r) => String(r.account) === "PAYOUT-DUE") as Book;
  check("…and `money_payable` still prints the office's own liabilities as a pair of answers — the "
    + "book's figure and the papers' — rather than one number a desk has to trust: every line's `book` "
    + "is the legs of the account it names and its `cached` is that account's own running totals, so a "
    + "disagreement between the two columns is the row's fault and not the read's",
    payZRows.length > 0 && payZ?.accounts === payZRows.length && String(payZ?.bound) === PLAT
    && payZ?.square === false && Number(payZ?.drift) === 0 && payBad.length === 0
    && payZRows.every((r) => (r.disagrees === null || typeof r.disagrees === "boolean")
      && typeof r.papers_n === "number" && (r.papers === null) === (r.disagrees === null))
    && payZRows.filter((r) => r.disagrees === true).length === Number(payZ?.disagrees)
    && Number(payZ?.disagrees) > 0 && !!payDue && payDue.disagrees === true
    && Number(payDue.papers) === Number((await one(`select coalesce(sum(amount + fee_amount), 0)
      ::numeric(14,2) as s from money_payouts where tenant_id = $1::uuid
      and status = 'released' and payable_account_id = (select id from money_accounts
      where tenant_id = $1::uuid and code = 'PAYOUT-DUE')`, [PLAT])).s),
    { bad: payBad, disagrees: payZ?.disagrees, square: payZ?.square,
      payout_due: [payDue?.book, payDue?.cached, payDue?.papers] });

  const bk = await call("133's `money_book` reads the whole chart the wallet doors have grown",
    BOOK_SQL, [PLAT]);
  const bkAccts = (bk?.accounts ?? []) as Book[];
  const acctsCen = await one(`select count(*)::int as n from money_accounts
    where tenant_id = $1::uuid`, [PLAT]) as Book;
  const drifters = bkAccts.filter((a) => a.drift === true).map((a) => a.code);
  check("…one line for every account in the office's chart, each printed with its cached totals and "
    + "the same totals recomputed from the legs beside them — and after wallets, holds, accruals and "
    + "cash have all been booked, not one of them disagrees",
    bkAccts.length === acctsCen.n && drifters.length === 0
    && bkAccts.every((a) => String(a.cached?.debit) === String(a.recomputed?.debit)
      && String(a.cached?.credit) === String(a.recomputed?.credit)
      && String(a.balance) === String(a.recomputed_balance)), { n: acctsCen.n, drifters });
  const wltInBook = bkAccts.filter((a) => String(a.code).startsWith("WLT-"));
  const walALineCode = await codeOf(WAL_A_LINE);
  check("…and every holder's balance line 134 minted is on it, filed as a liability in the money it "
    + "holds with its balance on the credit side — a wallet the book's own read cannot see is money "
    + "with no ledger",
    wltInBook.length === WAL_CEN.n && wltInBook.every((a) => a.kind === "liability"
      && a.natural_side === "credit" && (a.currency === "TZS" || a.currency === "USD"))
    && Number((wltInBook.find((a) => String(a.code) === walALineCode)?.balance))
      === Number(await walletBal(String(WAL_A))),
    { lines: wltInBook.length, wallets: WAL_CEN.n });
  const bookCen = await one(`select
      (select count(*)::int from money_accounts where tenant_id = $1::uuid) as accounts,
      (select count(*)::int from money_postings where tenant_id = $1::uuid) as postings,
      coalesce((select sum((status = 'reversed')::int) from money_postings
                 where tenant_id = $1::uuid), 0)::int as reversed,
      coalesce((select sum((currency = 'TZS')::int) from money_postings
                 where tenant_id = $1::uuid), 0)::int as tzs,
      coalesce((select sum((currency = 'USD')::int) from money_postings
                 where tenant_id = $1::uuid), 0)::int as usd,
      (select count(*)::int from money_entries where tenant_id = $1::uuid) as legs,
      coalesce((select sum(amount) filter (where direction = 'debit') from money_entries
                 where tenant_id = $1::uuid), 0)::numeric(14,2) as dr,
      coalesce((select sum(amount) filter (where direction = 'credit') from money_entries
                 where tenant_id = $1::uuid), 0)::numeric(14,2) as cr`, [PLAT]) as Book;
  const t14 = bk?.totals ?? {};
  check("…with the census under it answered the same way it is asked: the chart counted, the book "
    + "counted, both monies counted apart, and the debit and credit sides of every leg in the office's "
    + "book added up and found equal",
    Number(t14.accounts) === bookCen.accounts && Number(t14.postings) === bookCen.postings
    && Number(t14.movements_reversed) === bookCen.reversed && Number(t14.tzs_postings) === bookCen.tzs
    && Number(t14.usd_postings) === bookCen.usd && Number(t14.legs) === bookCen.legs
    && Number(t14.debited) === Number(bookCen.dr) && Number(t14.credited) === Number(bookCen.cr)
    && t14.square === true && Number(t14.out_by) === 0
    && Number(t14.frozen_accounts) === Number((await one(`select coalesce(sum((status = 'frozen')::int),
      0)::int as n from money_accounts where tenant_id = $1::uuid`, [PLAT])).n),
    { totals: t14, register: bookCen });

  /** The whole of what this phase read, in one string. The house rule since 001 is that a payee's "
   *  number is stored encrypted and only its tail and its keyed hash are ever shown; the rule is only "
   *  worth having if no read can be talked into printing it. */
  const everything = [wb, wbUsd, wbFrozen, wbOpen, wbHolder, wbNote, wbPage, wbMin, wbMax, wd1,
    wdGone, wdOther, pbAll, pbPaid, pbBank, pbDriver, pbRef, pbName, pbMin, pbMax, byBatchRef,
    byBatchId, pd, pdPst, pdPf, pdPb, pdGone, b1Detail, bBoard, payZ, bk];
  const printed = JSON.stringify(everything);
  const numbers = [PHONE.toString("utf8"), ACCT.toString("utf8"),
    PHONE.toString("base64"), ACCT.toString("base64"),
    PHONE.toString("hex"), ACCT.toString("hex")];
  const leaks = numbers.filter((s) => printed.includes(s));
  /** The hash is the payout detail's own answer, so the sweep counts it against the reads that say "
   *  `line_sealed` rather than against a number this file remembers: any other read that printed it "
   *  would be a second door onto the same line. */
  const sealedPrints = [pd, pdPst, pdPf, pdPb].filter((x) => x?.line_sealed === true).length;
  const hashReads = everything.filter((x) => JSON.stringify(x).includes(HASH64)).length;
  check("…and across every read this gate has taken, the payee's number appears nowhere — not as the "
    + "digits a desk could read, not as the ciphertext in any of the three shapes a bytea arrives in — "
    + "while the keyed hash is printed by exactly the detail opens that mark the line sealed, and by "
    + "none of the boards, headings or other papers beside them",
    leaks.length === 0 && hashReads === sealedPrints && sealedPrints === 2
    && printed.includes("1111") && printed.includes("0042"),
    { leaks, hashReads, sealedPrints, sealed_in_register: P_CEN.sealed });
  check("…which is the pair the desk itself keeps: the route that serves this read drops the hash "
    + "before the answer leaves the server, and both payout filters accept nothing but an uuid, so a "
    + "seat cannot quote a batch number at the register or carry a payee's line out of it",
    /payee_ref_hash:\s*_dropped/.test(routeSrc)
    && (routeSrc.match(/batch: UUID\.optional\(\)/g) ?? []).length === 2
    && (routeSrc.match(/const UUID = z\.string\(\)\.uuid\(\)/g) ?? []).length === 1,
    { dropped: /_dropped/.test(routeSrc), uuid_batch: (routeSrc.match(/batch: UUID/g) ?? []).length });
  const sq14 = await square();
  check("and after forty-one reads taken off the register, the book still answers that it balances "
    + "with itself: a read cannot move money, and this is the check that says it did not",
    sq14?.square === true && sq14?.unbalanced === 0 && sq14?.short_legged === 0, sq14);
  note(`${proved} checks proved — the desk's reads each answer the register they name, the `
    + "office's exposure is totalled over the whole filtered set rather than over the page it is "
    + "printed above, and the two places where a read quietly disagrees with the paper beside it are "
    + "written down for 135 instead of asserted as correct.");

  // ---------------- 15 · the hands that answer the desk ----------------
  /** A second connection with the office's own credentials, standing outside the transaction that
   *  everything above was written inside. It is the only way to ask what the committed book holds
   *  while the run's own rows are still invisible, and phase 16 reads its verdict off the same socket. */
  const tidy = await connect(url);
  phase("15 · what the role that serves the desk may and may not do to the five registers");
  const AU = appUrl();
  let rt: pg.Client | null = null;
  if (!AU) {
    note("APP_DB_PASSWORD is not set, so app_runtime cannot be reached from here. Phase 1 read its "
      + "grants and its policies out of the catalog; what cannot be proved without the role's own "
      + "connection is what it actually answers when it puts a hand to a register.");
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
        has_schema_privilege('app_runtime', 'platform_auth', 'USAGE') as into_schema,
        r.rolbypassrls as bypasses, r.rolsuper as root
      from pg_roles r where r.rolname = current_user`)).rows?.[0] as Book;
    check("this really is the role the desk answers with, it may reach the schema the doors stand in, "
      + "and it holds no privilege that would let it step over a row filter — which is the whole "
      + "reason the office's own book has to be named on every statement",
      /^app_runtime/.test(String(who?.who)) && who?.into_schema === true
      && who?.bypasses === false && who?.root === false, who);
    const railsSeen = (await rq(`select code from money_payout_rails order by code`)).rows as Book[];
    check("the rails table answers before any book is named, because it is the one register 134 gives "
      + "a policy reading `using (true)` — the vocabulary a payout can be written in is nobody's "
      + "secret, and a desk has to be able to offer it to a company it has not identified yet",
      railsSeen.length === 6 && sameFold(railsSeen.map((r) => String(r.code)), RAILS), railsSeen);
    const unbound = (await rq(`select 'money_wallets' as t, count(*)::int as n from money_wallets
        union all select 'money_escrow_holds', count(*)::int from money_escrow_holds
        union all select 'money_payout_batches', count(*)::int from money_payout_batches
        union all select 'money_payouts', count(*)::int from money_payouts`)).rows as Book[];
    check("…and none of the other four answers a single row until a book is named for the session: "
      + "the grant says the role may read a register, the policy says it may read somebody's register",
      unbound.length === 4 && unbound.every((r) => Number(r.n) === 0), unbound);

    await rq(`select set_config('app.tenant_id', $1, false)`, [PLAT]);
    const seenW = Number((await rq(`select count(*)::int as n from money_wallets
      where tenant_id = $1::uuid`, [PLAT])).rows?.[0]?.n);
    const seenP = Number((await rq(`select count(*)::int as n from money_payouts
      where tenant_id = $1::uuid`, [PLAT])).rows?.[0]?.n);
    const liveW = Number((await tidy.query(`select count(*)::int as n from money_wallets
      where tenant_id = $1::uuid`, [PLAT])).rows[0].n);
    const liveP = Number((await tidy.query(`select count(*)::int as n from money_payouts
      where tenant_id = $1::uuid`, [PLAT])).rows[0].n);
    check("name the office's own book and the two registers answer with exactly the rows the office "
      + "has committed — every wallet and every payout this run opened is missing, because a second "
      + "connection cannot see inside a transaction that has not finished",
      seenW === liveW && seenP === liveP && WAL_CEN.n > seenW && P_CEN.n > seenP,
      { seen: [seenW, seenP], committed: [liveW, liveP], this_run: [WAL_CEN.n, P_CEN.n] });
    note("That sentence is the one limit of this design, stated rather than worked around: the "
      + "fixtures are minted inside the transaction so that nothing survives the rollback, and the "
      + "price is that the row filter can only ever be proved against committed rows. Phase 1 read "
      + "the policies themselves out of `pg_policy` for the half a second connection cannot reach.");

    const named = (await rq(`select set_config('app.tenant_id', $1, false) as ignored`,
      [holderA])).err === null;
    const companySeen = (await rq(`select (select count(*)::int from money_wallets) as wallets,
        (select count(*)::int from money_payouts) as payouts,
        (select count(*)::int from money_escrow_holds) as holds,
        (select count(*)::int from money_payout_batches) as batches,
        (select count(*)::int from money_payout_rails) as rails`)).rows?.[0] as Book;
    check("…and a session that names a company instead of the office reads nothing at all out of the "
      + "four registers that live in the office's chart, while still seeing the six rails — a company "
      + "is not owed the office's payout list, only the vocabulary it may be paid in",
      named && companySeen?.wallets === 0 && companySeen?.payouts === 0 && companySeen?.holds === 0
      && companySeen?.batches === 0 && companySeen?.rails === 6, companySeen);

    const writes: [string, string, any[]][] = [
      ["a wallet", "insert into money_wallets (tenant_id, owner_tenant_id, account_id, currency, "
        + "holder_name, opened_by) values ($1::uuid, $2::uuid, $3::uuid, 'TZS', "
        + "'A wallet the role may not open', $4::uuid)", [PLAT, holderA, NO_BODY, PEN]],
      ["a wallet's note", "update money_wallets set note = $2 where tenant_id = $1",
        [PLAT, "A note the role may not write"]],
      ["a wallet row", "delete from money_wallets where tenant_id = $1", [PLAT]],
      ["the wallet register", "truncate money_wallets", []],
      ["a hold", "insert into money_escrow_holds (tenant_id, ref, currency, amount, subject_kind, "
        + "subject_id, from_account_id, into_account_id, reason_code, reason, raised_by) values "
        + "($1::uuid, 'ESC-2099-90001', 'TZS', 5, 'dispute', $2::uuid, $3::uuid, $4::uuid, "
        + "'other', 'A hold the role may not open', $5::uuid)",
        [PLAT, NO_BODY, NO_BODY, NO_BODY, PEN]],
      ["a hold's reason", "update money_escrow_holds set reason = $2 where tenant_id = $1",
        [PLAT, "A reason the role may not write"]],
      ["a hold row", "delete from money_escrow_holds where tenant_id = $1", [PLAT]],
      ["the escrow register", "truncate money_escrow_holds", []],
      ["a batch", "insert into money_payout_batches (tenant_id, ref, label, currency, raised_by) "
        + "values ($1::uuid, 'PBT-2099-90001', 'A batch the role may not open', 'TZS', $2::uuid)",
        [PLAT, PEN]],
      ["a batch's label", "update money_payout_batches set label = $2 where tenant_id = $1",
        [PLAT, "A label the role may not write"]],
      ["a batch row", "delete from money_payout_batches where tenant_id = $1", [PLAT]],
      ["the batch register", "truncate money_payout_batches", []],
      ["a payout", "insert into money_payouts (tenant_id, ref, payee_kind, payee_name, rail_code, "
        + "amount, currency, source_kind, purpose, fund_account_id, payable_account_id, "
        + "cash_account_id, raised_by) values ($1::uuid, 'PAY-2099-90001', 'other', "
        + "'A payee nobody signed', 'cash', 5, 'TZS', 'manual', "
        + "'A line the role may not write', $2::uuid, $3::uuid, $4::uuid, $5::uuid)",
        [PLAT, NO_BODY, NO_BODY, NO_BODY, PEN]],
      ["a payout's status", "update money_payouts set status = 'paid' where tenant_id = $1", [PLAT]],
      ["a payout row", "delete from money_payouts where tenant_id = $1", [PLAT]],
      ["the payout register", "truncate money_payouts", []],
      ["a rail", "insert into money_payout_rails (code, label, family, needs, note, sort) "
        + "values ('rtprobe', 'A rail the role may not add', 'cash', 'none', "
        + "'A rail nobody signed a migration for', 99)", []],
      ["a rail's label", "update money_payout_rails set label = $1 where code = 'cash'",
        ["A label the role may not write"]],
      ["a rail row", "delete from money_payout_rails where code = 'cash'", []],
      ["the rails vocabulary", "truncate money_payout_rails", []]
    ];
    for (const [what, sql, p] of writes) {
      const { err } = await rq(sql, p);
      check(`the app role is refused ${what} — "${sql.replace(/\s+/g, " ").slice(0, 44)}…" — by its `
        + "own lack of a grant, not by a filter it could set around",
        !!err && err.code === NO_PRIVILEGE && /permission denied/.test(String(err.message)),
        err ? { code: err.code, message: err.message } : "the statement was accepted");
    }
    const burnt = await rq(`select nextval('${SEQUENCES[2]}') as n`);
    check("…and it cannot advance a number either, so a role that could name a payout ref in a "
      + "request could not make the register skip one",
      !!burnt.err && burnt.err.code === NO_PRIVILEGE,
      burnt.err ? { code: burnt.err.code, message: burnt.err.message } : burnt.rows);

    const privs = (await rq(`select c.relname as t,
        has_table_privilege('app_runtime', c.oid, 'SELECT') as s,
        has_table_privilege('app_runtime', c.oid, 'INSERT') as i,
        has_table_privilege('app_runtime', c.oid, 'UPDATE') as u,
        has_table_privilege('app_runtime', c.oid, 'DELETE') as d,
        has_table_privilege('app_runtime', c.oid, 'TRUNCATE') as t2
      from pg_class c where c.relname::text = any($1::text[]) order by 1`, [REGISTERS])).rows as Book[];
    check("the role's own answer about all five registers: read, and nothing else, on every one",
      privs.length === 5 && privs.every((r) => r.s === true && r.i === false && r.u === false
        && r.d === false && r.t2 === false), privs);

    const fnPrivs = (await rq(`select p.proname as name,
        has_function_privilege('app_runtime', p.oid, 'EXECUTE') as can
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = any($1::text[])`, [ALL_FNS])).rows as Book[];
    const canDo = (d: string) => fnPrivs.find((f) => f.name === d)?.can === true;
    check("the thirty doors are executable by the role that answers the desk, which is the only way a "
      + "route can reach these registers at all", DOORS.every(canDo),
      DOORS.filter((d) => !canDo(d)));
    check("…and the eighteen guards and eight helpers are executable by nobody: a trigger body that "
      + "answered a call would let a role that can name a column also decide whether the row is honest",
      INTERNAL.every((d) => !canDo(d)) && fnPrivs.length === 56,
      { internal: INTERNAL.filter((d) => canDo(d)), found: fnPrivs.length });
    for (const [name, sql, p] of [
      ["money_move_is_the_office", `select platform_auth.money_move_is_the_office($1::uuid) as r`,
        [PLAT]],
      ["money_figure", `select platform_auth.money_figure(5::numeric) as r`, []],
      ["money_wallet_holder_is_a_company",
        `select platform_auth.money_wallet_holder_is_a_company() as r`, []],
      ["payout_needs_two_seats", `select platform_auth.payout_needs_two_seats() as r`, []]
    ] as [string, string, any[]][]) {
      const { err } = await rq(sql, p);
      check(`…so calling ${name} directly is answered with a refusal rather than an answer`,
        !!err && err.code === NO_PRIVILEGE, err?.message ?? "the helper answered");
    }

    await rq(`select set_config('app.tenant_id', $1, false)`, [holderA]);
    const acrossBook = (await rq(`select platform_auth.money_rails($1::uuid) as r`, [PLAT]))
      .rows?.[0]?.r as Book;
    check("a definer is not bound by what the session names: asked for the office's rails while its "
      + "own session points at a company, the door answers with the six the office wrote and binds "
      + "the office's uuid into its own answer",
      (acrossBook?.rows ?? []).length === 6 && acrossBook?.count === 6
      && String(acrossBook?.bound) === PLAT, { rows: (acrossBook?.rows ?? []).length,
        bound: acrossBook?.bound });
    const foreignPayable = (await rq(PAYABLE, [PLAT])).rows?.[0]?.r as Book;
    const ownPayable = (await rq(PAYABLE, [holderA])).rows?.[0]?.r as Book;
    check("…and the same door keeps its own rule whatever the session says: the office's liabilities "
      + "come back as rows, a company's book is answered with the sentence that only the office "
      + "carries them — the seat check inside the door is the last thing between a company and the "
      + "office's ledger, because RLS does not second-guess a definer",
      !!foreignPayable?.rows && foreignPayable?.error === undefined
      && String(ownPayable?.error) === "Only the office's own book carries these lines."
      && (ownPayable?.rows ?? []).length === 0,
      { office: foreignPayable?.accounts, company: ownPayable });

    await rt.query("begin");
    const walked = await rq(OPEN_W, [PLAT, NO_BODY, "TZS",
      MEMO("a wallet the app role asked the door to open"), PEN, "finance_officer",
      "127.0.0.1", "gate"]);
    await rt.query("rollback").catch(() => undefined);
    check("the app role reaches a write door's body: `open_money_wallet` is refused with 134's own "
      + "sentence and not with `permission denied`, which is the pair that says EXECUTE was granted "
      + "and the privilege check was passed",
      !!walked.err && walked.err.code === DOOR_RAISE
      && /134: /.test(String(walked.err.message)) && !/permission denied/.test(String(walked.err.message)),
      walked.err ? { code: walked.err.code, message: walked.err.message } : walked.rows);
    note("…and the sentence it answers with is the door's own company check, which is the same "
      + "invisible-fixture fact proved above: the office's four seats were minted inside the other "
      + "transaction, so from here even `PEN` is nobody. Nothing was written, and the door rolled "
      + "back with the transaction that asked it.");
    const afterWalk = Number((await tidy.query(`select count(*)::int as n from money_wallets
      where tenant_id = $1::uuid`, [PLAT])).rows[0].n);
    check("…and the walk left the committed register exactly as it found it, which is the only reason "
      + "a gate may put a hand to a live door at all", afterWalk === liveW, { afterWalk, liveW });
    await rt.end().catch(() => undefined);
  }
  await tidy.end().catch(() => undefined);

  // ---------------- 16 · the rollback ----------------
  phase("16 · the run closes, and what it leaves behind");
  await owner.query("rollback");
  const tidied = await connect(url);
  const postRollback = (await tidied.query(`select
      (select count(*)::int from money_wallets) as wallets,
      (select count(*)::int from money_escrow_holds) as holds,
      (select count(*)::int from money_payout_batches) as batches,
      (select count(*)::int from money_payouts) as payouts,
      (select count(*)::int from money_postings) as postings,
      (select count(*)::int from money_entries) as legs,
      (select count(*)::int from money_accounts) as accounts,
      (select count(*)::int from platform_approvals) as approvals,
      (select count(*)::int from audit_logs) as audits,
      (select count(*)::int from tenants) as tenants,
      (select count(*)::int from users) as seats,
      (select count(*)::int from money_payout_rails) as rails`)).rows[0] as Record<string, number>;
  const keys = ["wallets", "holds", "batches", "payouts", "postings", "legs", "accounts",
    "approvals", "audits", "tenants", "seats"] as const;
  const moved = keys.filter((k) => postRollback[k] !== BASE[k]);
  check("every register, every movement, every leg, every paper, every audit row, every company and "
    + "every seat this run wrote is gone from the committed book — including the releases, payments "
    + "and reversals that had to be real to be proved",
    moved.length === 0, { base: BASE, postRollback, moved });
  check("…and the vocabulary the file seeded survived it, because 134 put the six rails in with "
    + "`on conflict do nothing` and a rollback never takes a committed row back",
    postRollback.rails === 6, postRollback.rails);
  note("…which is also the reason nothing here has to be deleted afterwards: the payee's line a "
    + "wallet needs is minted into the office's own chart, not into a fixture book, so a teardown "
    + "keyed on the gate's companies would walk straight past it. The count of the whole chart is the "
    + "check that says those lines went back with the transaction that opened them.");

  const seqNow = (await tidied.query(`select
      (select last_value from escrow_hold_number_seq) as escrow,
      (select last_value from payout_batch_number_seq) as batch,
      (select last_value from payout_number_seq) as payout,
      (select last_value from money_posting_number_seq) as posting`)).rows[0] as Record<string, string>;
  const ASKED: [string, string][] = [[SEQUENCES[0], "escrow"], [SEQUENCES[1], "batch"],
    [SEQUENCES[2], "payout"]];
  const advanced = ASKED.filter(([s, col]) => Number(seqNow[col]) > SEQ[s]);
  check("the three numbers a paper is minted from keep every figure they spent, and 133's movement "
    + "number is past the count of movements the committed book holds — a number is spent when it is "
    + "taken, not when the row survives",
    advanced.length === ASKED.length && Number(seqNow.posting) > BASE.postings,
    { before: SEQ, now: seqNow, advanced: advanced.map(([s]) => s), postings: BASE.postings });
  note("So none of the four numberings is ever dense. A desk that reconciled payouts by counting "
    + "their numbers would find a gap every time a signature was refused or a line was typed wrong, "
    + "which is why the boards count rows and never read a difference in the numbering as a missing "
    + "page — the same rule 133's gate wrote down for the book.");

  const leftovers = (await tidied.query(`select
      (select count(*)::int from tenants where name like 'Moves Gate %') as books,
      (select count(*)::int from users where email like '%134sql%') as seats,
      (select count(*)::int from money_accounts where code ilike '%134sql%'
         or tenant_id in (select id from tenants where name like 'Moves Gate %')) as lines,
      (select count(*)::int from money_wallets where holder_name like 'Moves Gate %') as wallets,
      (select count(*)::int from money_payouts where purpose like 'Moves Gate %'
                                                or payee_name like 'Moves Gate %') as payouts,
      (select count(*)::int from money_postings where memo like 'Moves Gate %') as postings,
      (select count(*)::int from money_escrow_holds where reason like 'Moves Gate %') as holds,
      (select count(*)::int from money_payout_batches where label like 'Moves Gate %') as batches,
      (select count(*)::int from platform_approvals where reason like 'Moves Gate %') as papers`
    )).rows[0] as Record<string, number>;
  check("not one row carrying this run's words survives: no fixture company, no seat, no liability "
    + "line, no wallet, payout, hold, batch, movement or signature dressed in a `Moves Gate` name",
    Object.values(leftovers).every((n) => n === 0), leftovers);
  const stillOne = Number((await tidied.query(
    `select count(*)::int as n from schema_migrations where name like '134%'`)).rows[0].n);
  check("134 is still recorded exactly once"
    + (APPLY ? ", and the DDL committed at phase 0 is now what the platform runs"
      : ", and this rehearsal added no record of its own"), stillOne === 1, stillOne);
  if (APPLY) {
    const recheck = (await tidied.query(`select p.proname as name, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1::text[])`, [ALL_FNS])).rows as Book[];
    const differs = recheck.filter((r) => fileBody[r.name] !== undefined
      && bodyOf(String(r.def)) !== fileBody[r.name]);
    check("…and the byte-for-byte read from phase 1 now passes against what the server holds, which "
      + "is the point of running with --apply: the three guards this stage edited are the bodies "
      + "below, tested as the file writes them", differs.length === 0 && recheck.length === 56,
      { differs: differs.map((d) => d.name), found: recheck.length });
  }
  const officeSquare = (await tidied.query(SQUARE_SQL, [PLAT])).rows[0]?.r as Book;
  check("…and the office's committed book still answers that it balances with itself, so the rollback "
    + "took the run's legs away without taking any of the book's own",
    officeSquare?.square === true && Number(officeSquare?.unbalanced) === 0
    && Number(officeSquare?.short_legged) === 0, officeSquare);
  await tidied.end().catch(() => undefined);
  note(`${proved} checks proved so far — the run leaves the office's book exactly as it found it and `
    + "takes nothing with it.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
