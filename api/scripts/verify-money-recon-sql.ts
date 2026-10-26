/**
 * 135, 136, 137, 138 and 139, proved in the database.
 *
 * The HTTP smoke (`smoke-money-recon.ts`) already walks the two desks over the routes a seat uses. It
 * cannot prove three things, and they are the three things this stage is actually for:
 *
 *  1. A count that AGREES writes no row. Over HTTP, an empty findings list looks exactly like a check
 *     that was never asked, so the smoke can only read the report a run hands it. Here a clean book is
 *     planted, counted, and the register is read to see that the absence is the answer rather than the
 *     absence of a question — and the same questions are then re-asked over a book that was broken by
 *     hand, to show each sentence is reachable.
 *  2. The rules kept BELOW the doors. The freeze on a run's own account, the two-seat rule, the
 *     "a signed count is never erased" guard and the attempt ledger's no-edit rule are table triggers
 *     and CHECKs. Every refusal an HTTP seat can provoke is also provokable by hand, and the ones that
 *     matter most — an update that would silently move a figure a second seat already signed for — have
 *     no route that reaches them, because the door that could write them refuses first.
 *  3. A statement is arithmetic over legs that must exist. Over the wire the ledger desk can only
 *     export a line somebody has already put money through; here the legs are planted at chosen days,
 *     so `opening`, `moved`, `closing`, the running figure on every row, the side a movement is
 *     printed on and `drift.agrees` can each be pinned to a number instead to a claim.
 *
 * 136's own reason for existing is proved at phase 13: a delivery is re-driven through the retry door,
 * the licence lands, and the count raised afterwards does not call that delivery one the office never
 * acted on — because `payment_webhooks` is insert-only for everybody (005's rule for a table an
 * internet stranger can reach), so the delivery keeps `processed_at IS NULL` for the rest of its life
 * and the charge is the only thing that can say what happened to it.
 *
 * 137 was written by what this gate found on the way to that proof. The gate plants a SECOND platform
 * book, and 135's attempt ledger keys a press per delivery while its door numbers presses per desk, so
 * the second desk's press completed the charge and then could not record that it had. Phase 12 and
 * phase 13 now prove the repaired contract instead of the seam: the board, the one-delivery read and
 * the door count the same pile the same way, and two books may each press a delivery five times.
 *
 * 138 and 139 were both found at the desk rather than in this file. A USD gateway count over a day that
 * holds TZS charges summed their figures into `net_difference` and printed them in dollars — so phase 5
 * now plants ONE pile and asks it twice, in the money the charge is in and in the money it is not, and
 * replays 136's door inside a savepoint to show the wrong sum was really what the old body answered.
 * And 135's payload scrub folded a key name for dashes but not for case, so a rail that writes
 * `cardNumber` had its card number back outside the deny-list; phase 11 runs the same payload through
 * 135's body and through 139's, on the same socket, and prints what each one kept.
 *
 * Nothing here commits. Every fixture — the two synthetic office books, the seats, the deliveries, the
 * charges, the temporary switch that turns a rail on for the two rails questions — is written inside
 * one transaction that is rolled back at the end, so the office's real ledger, the real delivery pile
 * and the gateway register are exactly as this file found them. The one thing a rollback cannot undo is
 * `recon_run_number_seq`: the numbers a run spends stay spent, which is proved rather than assumed.
 *
 * Run: npx tsx scripts/verify-money-recon-sql.ts          (rehearses 135–139, rolls it all back)
 *      npx tsx scripts/verify-money-recon-sql.ts --apply  (all five files' DDL re-applied to dev)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const FILE = "migrations/135_the_office_counts_itself_and_the_gateway_answers.sql";
const FIX = "migrations/136_a_count_does_not_call_a_landed_delivery_one_it_never_acted_on.sql";
const KEY = "migrations/137_an_attempt_is_numbered_by_the_desk_that_made_it.sql";
const SIX = "migrations/138_a_count_keeps_another_moneys_figure_out_of_its_sum.sql";
const FOLD = "migrations/139_a_rail_s_own_spelling_of_a_hidden_word_is_still_a_hidden_word.sql";
const MONEY_ROUTE = "src/routes/control-money.routes.ts";
const GATE_ROUTE = "src/routes/control-gateway.routes.ts";
/** The desk's list of duties a seat may be handed is written here, so phase 14 can prove the two new
 *  keys reach a tab rather than only a door (`control-nav-allowlist`: a held duty nobody probes is a
 *  tab that never appears, which is how 067's `control.staff.view` behaved for three roles). */
const ANALYTICS_ROUTE = "src/routes/control-analytics.routes.ts";
const GATEWAY_DESK = "../web/app/control/gateway/webhooks.tsx";
const GATEWAY_PAGE = "../web/app/control/gateway/page.tsx";
const RECON_DESK = "../web/app/control/money/recon.tsx";
const RECON_PAGE = "../web/app/control/money/page.tsx";
const APPLY = process.argv.includes("--apply");

const HEX = randomUUID().replace(/-/g, "");
const STAMP = `136sql${HEX.slice(0, 6)}`;
/** The fake rail. `mpesa` is used as the provider word rather than a made-up one because the delivery
 *  detail reads its `rail` block out of 114's register by `provider_key`, and a door that answers a
 *  rail that does not exist cannot be told from one that forgot to look. */
const RAIL = "mpesa";
const CODE = (who: string) => `GATE-${who}-${STAMP.slice(-6).toUpperCase()}`;
const BOOK = (who: string) => `Recon Gate ${who} ${STAMP}`;
const EMAIL = (who: string) => `recon.${who}.${STAMP}@waisha.test`;
const DAY_AGO = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const TODAY = DAY_AGO(0);
const OPEN_DAY = DAY_AGO(20);
const IN_DAY = DAY_AGO(2);
const REASON = "The desk raised this count twice by accident and is throwing the draft away.";
const NOTE = "Read by a second seat: the exceptions are the three the office already knows about.";

/** The words the desk can type, read out of the migration rather than typed a second time here: a
 *  CHECK's list and the door's `not in (...)` list are two spellings of one rule, and the gate that
 *  compares them to a literal in this file would agree with the literal instead. */
const REGISTERS = ["money_reconciliation_runs", "money_reconciliation_findings",
  "gateway_webhook_attempts"];
const GUARDS = ["recon_run_keeps_its_account", "recon_run_is_kept_once_signed",
  "recon_findings_are_kept", "webhook_attempt_is_kept"];
const READS = ["money_recon_board", "money_recon_detail", "money_statement",
  "gateway_webhook_board", "gateway_webhook_detail", "scrub_gateway_payload"];
const WRITES = ["run_money_reconciliation", "sign_money_reconciliation_run",
  "delete_money_reconciliation_run", "retry_gateway_webhook"];
const ALL_FNS = [...GUARDS, ...WRITES, ...READS];

let failures = 0;
let proved = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) proved++; else failures++;
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok ? "" : " — "
    + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`);
}
function note(msg: string) { console.log(`!!   ${msg}`); }
function phase(t: string) { console.log(`\n--- ${t}`); }
/** Order-insensitive equality: a CHECK's alternation is a set, and `pg_get_constraintdef` prints the
 *  words in the order it likes, not the order the migration was typed in. */
const same = (a: string[], b: string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && y.every((w, i) => x[i] === w);
};
const sameFold = (a: string[], b: string[]) =>
  same(a.map((w) => w.toLowerCase()), b.map((w) => w.toLowerCase()));
/** The quoted words of a CHECK, as the deparser prints them — lower-cased on the way in, because the
 *  deparser writes `IS NOT NULL`, `Btrim` and `ARRAY` in its own case while the needles are the words
 *  the migration was typed in. */
function quoted(def: string): string[] {
  return [...def.matchAll(/'([a-z_0-9]+)'(?:::text)?/g)].map((m) => m[1]);
}
function wordsFor(cons: { conname: string; def: string }[], name: string): string[] {
  const hit = cons.find((c) => c.conname === name);
  return hit ? quoted(hit.def) : [];
}
/** A word list written inside a migration, read the way the gate reads the catalog's. */
function wordsInList(src: string, start: string): string[] {
  const a = src.indexOf(start);
  if (a < 0) return [];
  const rest = src.slice(a + start.length);
  const close = rest.indexOf(")");
  if (close < 0) return [];
  return [...rest.slice(0, close).matchAll(/'([a-z_0-9]+)'/gi)].map((m) => m[1].toLowerCase());
}
/** A desk's zod enum. Case is folded: `["TZS","USD"]` on the desk is the pair the book keeps. */
function zodEnum(src: string, name: string): string[] {
  const m = src.match(new RegExp(`const ${name}[^=]+=\\s*z\\.enum\\(\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/["']([a-z_0-9]+)["']/gi)].map((x) => x[1].toLowerCase()) : [];
}
/** A CHECK's deparse with its own brackets, spacing and `::text` casts taken out. `pg_get_constraintdef`
 *  re-parenthesises every operand and casts every literal, so a migration that wrote
 *  `attempt between 1 and 5` comes back as `((attempt >= 1) and (attempt <= 5))` and a needle copied
 *  from the file cannot match it. Both sides of the comparison go through this shape, so the rule being
 *  asserted is still the one the file states. */
const deparse = (s: string) => s.toLowerCase().replace(/::[a-z_0-9]+(\([0-9,]+\))?/g, "")
  .replace(/[()\s]+/g, "");
/** Whether a deparsed CHECK carries the rule, ignoring how the deparser chose to bracket it. */
const has = (def: string, rule: string) => deparse(def).includes(deparse(rule));
/** A whole statement between two needles, both included. Used to lift one privilege statement out of
 *  a migration so the rehearsal runs the file's own grant rather than a paraphrase of it. */
function stmtBetween(src: string, start: string, stop: string): string {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`statement not found: ${start.slice(0, 48)}`);
  const b = src.indexOf(stop, a);
  if (b < 0) throw new Error(`statement does not end with: ${stop.slice(0, 48)}`);
  return src.slice(a, b + stop.length);
}
/** One `create or replace function … $$;` block at a time. `language sql` readers end at `$$;` rather
 *  than at `end $$;` — 135 has one of them — so a scanner that looked for one terminator alone would
 *  swallow the next function into the previous one. */
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
/** The text between a function's dollar quotes, whitespace collapsed — the shape both the file and
 *  `pg_get_functiondef` agree on, so a body can be compared to the body the platform is running. */
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
/** The questions the count is allowed to ask, read out of the door's own `v_names` lines: one entry
 *  per switch, in the order the door appends them. The gate's assertions about a run's `checks` column
 *  and its `examined.questions` are built from this, so a question added to the file changes what this
 *  run expects instead of quietly failing against a number typed here. */
function questions(src: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const re = /if v_(\w+)\s+then v_names := v_names \|\| array\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out[m[1]] = [...m[2].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]);
  }
  return out;
}
/** The three parts a door body cuts into: everything before the exceptions, the exceptions themselves
 *  as one `select … union all select …`, and everything after. 136 replaces this door, so the gate
 *  compares the two files by these parts rather than by a line count that a re-wrapped comment moves. */
const EXCEPTIONS = "insert into money_reconciliation_findings";
const AFTER = "get diagnostics";
const headOf = (s: string) => s.slice(0, s.indexOf(EXCEPTIONS));
const piecesOf = (s: string) =>
  s.slice(s.indexOf(EXCEPTIONS), s.indexOf(AFTER)).split("union all");
const tailOf = (s: string) => s.slice(s.indexOf(AFTER));
/** Which question a piece of that `union all` asks — the first `select '<name>'` inside it. Bodies are
 *  read through `bodyOf`, which collapses them onto one line, so the block's own comment stands between
 *  the piece and its word and the needle cannot be anchored. Block 14 splits into two pieces (the list
 *  and its `many` overflow), which is why there are twenty of them and not nineteen. */
const pieceName = (p: string) => /select '([a-z_0-9]+)'/.exec(p)?.[1] ?? "?";

const RUN_SQL = `select platform_auth.run_money_reconciliation($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9) as r`;
const SIGN_SQL = `select platform_auth.sign_money_reconciliation_run($1,$2,$3,$4,$5,$6,$7) as r`;
const DISCARD_SQL = `select platform_auth.delete_money_reconciliation_run($1,$2,$3,$4,$5,$6,$7) as r`;
const BOARD_SQL = `select platform_auth.money_recon_board($1,$2,$3,$4,$5,$6,$7) as r`;
const DETAIL_SQL = `select platform_auth.money_recon_detail($1,$2) as r`;
const STMT_SQL = `select platform_auth.money_statement($1,$2,$3::date,$4::date,$5,$6) as r`;
const SCRUB_SQL = `select platform_auth.scrub_gateway_payload($1::jsonb) as r`;
const GH_BOARD_SQL = `select platform_auth.gateway_webhook_board($1,$2,$3,$4,$5,$6) as r`;
const GH_DETAIL_SQL = `select platform_auth.gateway_webhook_detail($1,$2) as r`;
const RETRY_SQL = `select platform_auth.retry_gateway_webhook($1,$2,$3,$4,$5,$6) as r`;
const OPEN_SQL = `select platform_auth.open_money_account($1,$2,$3,$4,$5,$6,$7) as r`;

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  /** Every lift in this file is cut from a migration by a needle that spans lines, and git hands a
   *  Windows checkout back with CRLF terminators — which silently breaks a `\n` in the middle of a
   *  needle while leaving `functionDdl`'s end-of-body markers intact. Normalising at the read is the
   *  one place that can do it once, and it keeps the proofs about the text independent of how the
   *  working tree happens to have been checked out. */
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const src = read(FILE);
  const fix = read(FIX);
  const key = read(KEY);
  const six = read(SIX);
  const fold = read(FOLD);
  const moneyRoute = read(MONEY_ROUTE);
  const gateRoute = read(GATE_ROUTE);
  const analytics = read(ANALYTICS_ROUTE);
  const gatewayDesk = read(GATEWAY_DESK);
  const gatewayPage = read(GATEWAY_PAGE);
  const reconDesk = read(RECON_DESK);
  const reconPage = read(RECON_PAGE);

  // ---------------- 0 · all five files, executed ----------------
  phase("0 · 135's bodies, 136's and 138's replacements, 137's repair and 139's fold re-execute "
    + "against the live catalog");
  const ddl = functionDdl(src);
  const fixDdl = functionDdl(fix);
  const keyDdl = functionDdl(key);
  const sixDdl = functionDdl(six);
  const foldDdl = functionDdl(fold);
  /** 137 moves two things besides the read: the attempt key itself, and the comment that says whose
   *  press a number is. Both are lifted whole — the constraint block because the tail self-check reads
   *  the catalog it writes, and a rehearsal that replayed only the function would be rehearsing half
   *  of the file the gate is standing in for. */
  const keyCons = stmtBetween(key, "do $$ declare\nbegin", "end $$;");
  const keyComment = stmtBetween(key, "comment on constraint", "already completed.';");
  const keyCheck = stmtBetween(key, "do $$ declare\n  v_shape", "end $$;");
  const selfCheck = stmtBetween(fix, "do $$ declare", "end $$;");
  /** 138 and 139 each replace one body, re-sweep its grants and end by reading their own work out of
   *  `pg_proc`. All three parts are lifted, in the order the files write them, because a rehearsal that
   *  replayed only the body would be rehearsing the promise and not the proof of it. */
  const sixPriv = [
    stmtBetween(six, "grant execute on function\n  platform_auth.run_money_reconciliation",
      "to app_runtime;"),
    stmtBetween(six, "revoke all on function\n  platform_auth.run_money_reconciliation",
      "from public, anon, authenticated, service_role;")
  ];
  const sixCheck = stmtBetween(six, "do $$ declare\n  v_shape", "end $$;");
  const foldPriv = [stmtBetween(fold,
    "revoke all on function platform_auth.scrub_gateway_payload(jsonb)",
    "from public, anon, authenticated, app_runtime, service_role;")];
  const foldCheck = stmtBetween(fold, "do $$ declare\n  v_shape", "end $$;");
  const priv = [
    stmtBetween(src, "revoke all on function\n  platform_auth.recon_run_keeps_its_account()",
      "from public, anon, authenticated, app_runtime, service_role;"),
    stmtBetween(src, "grant execute on function", "to app_runtime;"),
    stmtBetween(src, "revoke all on function\n  platform_auth.run_money_reconciliation",
      "from public, anon, authenticated, service_role;"),
    stmtBetween(src, "revoke all on sequence recon_run_number_seq",
      "from public, anon, authenticated, app_runtime, service_role;")
  ];
  const keyPriv = [
    stmtBetween(key, "grant execute on function platform_auth.gateway_webhook_detail",
      "to app_runtime;"),
    stmtBetween(key, "revoke all on function platform_auth.gateway_webhook_detail",
      "from public, anon, authenticated, service_role;")
  ];
  const replayed = [...ddl, ...fixDdl, keyCons, keyComment, ...keyDdl, ...keyPriv,
    ...priv, selfCheck, keyCheck, ...sixDdl, ...sixPriv, sixCheck, ...foldDdl, ...foldPriv,
    foldCheck].join("\n");
  check("all five files open and close their own transaction, and this gate replays neither half of "
    + "that pair", /^begin;$/m.test(src) && /^commit;$/m.test(src) && /^begin;$/m.test(fix)
    && /^commit;$/m.test(fix) && /^begin;$/m.test(key) && /^commit;$/m.test(key)
    && /^begin;$/m.test(six) && /^commit;$/m.test(six) && /^begin;$/m.test(fold)
    && /^commit;$/m.test(fold) && !/^(begin|commit);$/m.test(replayed),
    (replayed.match(/^(begin|commit);$/gm) ?? []));
  check(`135 declares ${ALL_FNS.length} functions and this gate cut every one of them out of the `
    + "file on its own", ddl.length === ALL_FNS.length
    && (src.match(/^create or replace function platform_auth\./gm) ?? []).length === ALL_FNS.length
    && ALL_FNS.every((f) => ddl.some((d) => d.startsWith(
      `create or replace function platform_auth.${f}(`))), ddl.map((d) => d.slice(38, 62)));
  check("136 declares exactly one function — the door whose body it replaces — and nothing else moves",
    fixDdl.length === 1 && fixDdl[0].includes("run_money_reconciliation(")
    && (fix.match(/^create or replace function platform_auth\./gm) ?? []).length === 1
    && !/^(create table|create index|create trigger|alter table|create policy)/m.test(fix),
    { blocks: fixDdl.length, other: (fix.match(/^(create|alter)\s+\w+/gm) ?? []) });
  check("137 declares exactly one function — the delivery read whose two questions it repairs — and "
    + "the only table it touches is the attempt ledger, once to drop 135's key and once to add its own",
    keyDdl.length === 1 && keyDdl[0].includes("gateway_webhook_detail(")
    && (key.match(/^create or replace function platform_auth\./gm) ?? []).length === 1
    && (key.match(/^\s+alter table gateway_webhook_attempts$/gm) ?? []).length === 2
    && (key.match(/^\s+(drop|add) constraint /gm) ?? []).length === 2
    && !/^(create table|create index|create trigger|create policy|drop table|drop index)/m.test(key),
    { blocks: keyDdl.length, alters: (key.match(/alter table \w+/g) ?? []),
      constraints: (key.match(/(drop|add) constraint \w+/g) ?? []) });
  check("138 declares exactly one function — the count door whose sum it repairs — and moves nothing "
    + "else: the money crossed into the report inside the door's own two SELECTs, so no register, "
    + "trigger, guard or table is part of this file",
    sixDdl.length === 1 && sixDdl[0].includes("run_money_reconciliation(")
    && (six.match(/^create or replace function platform_auth\./gm) ?? []).length === 1
    && !/^(create table|create index|create trigger|alter table|create policy|drop table)/m.test(six),
    { blocks: sixDdl.length, other: (six.match(/^(create|alter|drop)\s+\w+/gm) ?? []) });
  check("139 declares exactly one function — the scrub — and its whole change is inside that body: "
    + "the deny-list and the fold, with the same two privilege lines 135 wrote for it",
    foldDdl.length === 1 && foldDdl[0].includes("scrub_gateway_payload(")
    && (fold.match(/^create or replace function platform_auth\./gm) ?? []).length === 1
    && !/^(create table|create index|create trigger|alter table|create policy|drop table)/m.test(fold)
    && (fold.match(/^revoke all on function/gm) ?? []).length === 1
    && !/^grant execute on function platform_auth\.scrub/m.test(fold),
    { blocks: foldDdl.length, revokes: (fold.match(/^revoke all on function/gm) ?? []).length,
      other: (fold.match(/^(create|alter|drop|grant)\s+\w+/gm) ?? []) });
  /** 138's own promise is that it changed three clauses and lifted the rest. The proof is the same
   *  shape as 136's and 137's: write the three clauses back the way they were and the two bodies must
   *  agree byte for byte. A paraphrased or re-wrapped door would pass a line count and fail this. */
  const sixLift = (() => {
    const a = bodyOf(fixDdl[0]);
    const b = bodyOf(sixDdl[0]);
    if (!a || !b) return null;
    const undone: Array<[string, string]> = [
      ["and pay.currency = v_cur and w.created_at::date between v_from and v_to",
       "and w.created_at::date between v_from and v_to"],
      ["and coalesce(pay.currency, v_cur) = v_cur and w.created_at::date between v_from and v_to",
       "and w.created_at::date between v_from and v_to"],
      [", 'webhook_not_landed and webhook_retries_spent were asked of USD charges only: the money ' "
       + "|| 'on both of them is read off the charge, and a TZS figure added to a USD difference is a ' "
       + "|| 'translation, not a count'", ""]];
    let back = b;
    const found: number[] = [];
    for (const [now, then] of undone) {
      found.push(back.split(now).length - 1);
      back = back.split(now).join(then);
    }
    return { found, agrees: back === a, len: { six: b.length, fix: a.length },
      said: b.includes("'webhook_not_landed and webhook_retries_spent were asked of USD charges only")
        && a.includes("'the rails were not asked about money: 005 takes TZS only")
        && b.includes("'the rails were not asked about money: 005 takes TZS only") };
  })();
  check("…and 138 lifted 136's door whole rather than rewriting it from memory: undo the two currency "
    + "binds and the one skip sentence and what is left is 136's body byte for byte — 136's guard on "
    + "both blocks included", !!sixLift && sixLift.agrees
    && sixLift.found.every((n) => n === 1) && sixLift.said,
    sixLift ? { found: sixLift.found, agrees: sixLift.agrees, len: sixLift.len,
      said: sixLift.said } : "no body");
  /** 139's promise is narrower still: the scrub is the same loop, and only the fold and the list are
   *  new. So the two bodies are cut at the three regions the file names — the list, the declaration of
   *  the folded name, the test — and everything outside them must agree word for word. */
  const foldLift = (() => {
    const a = bodyOf(ddl.find((d) => d.includes("scrub_gateway_payload(")) ?? "");
    const b = bodyOf(foldDdl[0]);
    if (!a || !b) return null;
    const LIST = /array\[.*?\]; v_out/;
    const NORM = /v_val jsonb;( v_norm text;)? begin/;
    const TEST = /(?:v_norm := lower\(regexp_replace.*?\)|if lower\(replace\(v_key.*?\)) then/;
    const cut = (s: string, re: RegExp) => {
      const m = s.match(re);
      return { rest: s.replace(re, "«CUT»"), region: m ? m[0] : "",
        hits: (s.match(new RegExp(re.source, "g")) ?? []).length };
    };
    const la = cut(a, LIST), lb = cut(b, LIST);
    const na = cut(la.rest, NORM), nb = cut(lb.rest, NORM);
    const ta = cut(na.rest, TEST), tb = cut(nb.rest, TEST);
    const words = (s: string) => (s.match(/'[a-z_0-9]+'/g) ?? []).map((w) => w.slice(1, -1));
    const wa = words(la.region), wb = words(lb.region);
    return { agrees: ta.rest === tb.rest, hits: [la.hits, lb.hits, na.hits, nb.hits, ta.hits, tb.hits],
      lists: { then: wa.length, now: wb.length }, dups: wb.length - new Set(wb).size,
      kept: wa.every((w) => wb.includes(w)), added: wb.filter((w) => !wa.includes(w)),
      flat: wb.filter((w) => !w.includes("_")), test: tb.region };
  })();
  check("…and 139 lifted 135's scrub whole: cut the two bodies at the deny-list, at the folded name's "
    + "declaration and at the test that reads it, and every other word of the loop — the walk, the "
    + "arrays, the non-object answer — is the same text",
    !!foldLift && foldLift.agrees && foldLift.hits.every((n) => n === 1),
    foldLift ? { agrees: foldLift.agrees, hits: foldLift.hits } : "no body");
  check("…and the list grew by the spellings that were always one word: 135's 34 names are all still "
    + "there, each written once, and the 9 names 139 added are exactly the ones the dash fold cannot "
    + "produce — which is the second test's whole job",
    !!foldLift && foldLift.lists.then === 34 && foldLift.lists.now === 43 && foldLift.dups === 0
    && foldLift.kept && same(foldLift.added, ["mobilenumber", "accountnumber", "accno", "cardnumber",
      "idnumber", "nationalid", "credentialsencrypted", "webhooksecret", "payerphone"])
    && foldLift.added.every((w) => !w.includes("_")),
    foldLift ? { lists: foldLift.lists, dups: foldLift.dups, kept: foldLift.kept,
      added: foldLift.added } : "no body");
  check("…while 139's test is the pair the fold needs: the folded name tested as it stands AND the "
    + "same name with its underscores taken out, because `card-number`, `card_number`, `cardNumber` "
    + "and `cardnumber` are four spellings of one hidden word",
    !!foldLift && foldLift.test.includes(
      "v_norm = any (v_hidden) or replace(v_norm, '_', '') = any (v_hidden)")
    && foldLift.test.includes("lower(regexp_replace(replace(v_key, '-', '_'), "
      + "'([a-z0-9])([A-Z])', '\\1_\\2', 'g'))"), foldLift?.test);
  /** The four lines 137 says it changed, proved by undoing them: rewrite 137's read back to 135's
   *  wording clause by clause, and the only way the result can equal 135's body is if nothing else in
   *  those eighty-odd lines was touched. A paraphrased lift — same meaning, different text — fails this. */
  const readLift = (() => {
    const a = bodyOf(ddl.find((d) => d.includes("gateway_webhook_detail(")) ?? "");
    const b = bodyOf(keyDdl[0] ?? "");
    if (!a || !b) return null;
    const undone: Array<[string, string]> = [
      ["(select count(*)::int from gateway_webhook_attempts a where a.webhook_id = v_w.id "
        + "and a.tenant_id = p_tenant) < 5",
       "(select count(*)::int from gateway_webhook_attempts a where a.webhook_id = v_w.id) < 5"],
      ["(select count(*)::int from gateway_webhook_attempts a where a.webhook_id = v_w.id "
        + "and a.tenant_id = p_tenant) >= 5",
       "(select count(*)::int from gateway_webhook_attempts a where a.webhook_id = v_w.id) >= 5"],
      ["and coalesce(v_w.payload ->> 'reference', '') <> ''",
       "and coalesce(v_w.payload ? 'reference', false)"],
      ["elsif coalesce(v_w.payload ->> 'reference', '') = '' then",
       "elsif not coalesce(v_w.payload ? 'reference', false) then"]];
    let back = b;
    const found: number[] = [];
    for (const [now, then] of undone) {
      found.push(back.split(now).length - 1);
      back = back.split(now).join(then);
    }
    return { found, agrees: back === a, remains: (back.match(/tenant_id = p_tenant/g) ?? []).length };
  })();
  check("…and 137 lifted 135's read whole rather than rewriting it from memory: undo those four "
    + "clauses in its body and what is left is 135's body byte for byte — the attempt list's own "
    + "`tenant_id` binding included",
    !!readLift && readLift.agrees && readLift.found.every((n) => n === 1)
    && readLift.remains === 1,
    readLift ? { found: readLift.found, agrees: readLift.agrees, remains: readLift.remains }
      : "no body");
  const runBody = (() => {
    const a = bodyOf(ddl.find((d) => d.includes("run_money_reconciliation(")) ?? "");
    const b = bodyOf(fixDdl[0]);
    if (!a || !b || a.indexOf(EXCEPTIONS) < 0 || b.indexOf(EXCEPTIONS) < 0) return null;
    // The nineteen questions are one `select … union all select …`, so the pieces line up index for
    // index between the two files and a changed question shows as a changed piece. Block 14 splits
    // into two pieces — the list and its `many` overflow — which is why there are twenty of them.
    const [pa, pb] = [piecesOf(a), piecesOf(b)];
    const differs = pa.map((x, i) => (x === pb[i] ? -1 : i)).filter((i) => i >= 0);
    return { head: headOf(a) === headOf(b), tail: tailOf(a) === tailOf(b), pa, pb, differs };
  })();
  check("136 lifted 135's door whole rather than rewriting it from memory: everything before the "
    + "exceptions and everything after them is byte-for-byte the same text, and the questions "
    + "themselves agree except in two places",
    !!runBody && runBody.head && runBody.tail && runBody.pa.length === runBody.pb.length
    && runBody.pa.length === 20 && runBody.differs.length === 2,
    runBody ? { pieces: runBody.pa.length, differs: runBody.differs,
      head: runBody.head, tail: runBody.tail } : "no body");
  check("…and the two places are exactly the two this file was written to fix — `webhook_not_landed` "
    + "and `webhook_retries_spent` — so nothing else about the count changed on the way", (() => {
      if (!runBody) return false;
      const changed = runBody.differs.map((i) => pieceName(runBody.pa[i]));
      return same(changed, ["webhook_not_landed", "webhook_retries_spent"]);
    })(), runBody?.differs.map((i) => [i, pieceName(runBody.pa[i])]));
  check("…while every other question of 135 still exists in 136 with the same name and the same "
    + "figure pair, which is the part of the promise the two lines above cannot make",
    !!runBody && runBody.pa.every((p, i) => runBody.differs.includes(i)
      || p.replace(/\s+/g, " ") === runBody.pb[i].replace(/\s+/g, " ")));
  check("135's index lines are not replayable, which is why this gate reads them from the catalog "
    + "instead: they are written without `if not exists`, so a second run of the file would fail on "
    + "them and a gate that replayed them would report that as drift",
    (src.match(/^create index/gm) ?? []).length === 6
    && (src.match(/^create (?:unique )?index if not exists/gm) ?? []).length === 0,
    (src.match(/^create.*index.*$/gm) ?? []).map((l) => l.slice(0, 46)));

  // One socket for the whole run, from the rehearsal to the last census: the pooler in front of this
  // database answers a second simultaneous connection with `econnrefused`, and the committed census
  // only needs to be taken outside a transaction — which it is, before `begin` and again after the
  // rollback in phase 15.
  const runner = await connect(url);
  const recorded = (await runner.query(
    `select name from schema_migrations where name like '135%' or name like '136%'
       or name like '137%' or name like '138%' or name like '139%' order by 1`))
    .rows.map((r: any) => r.name);
  check("all five files are already recorded, which is why an edited one needs this file rather "
    + "than `pnpm migrate`", recorded.length === 5, recorded);
  let err: any = null;
  await runner.query("begin");
  try {
    for (const block of ddl) await runner.query(block);
    for (const block of fixDdl) await runner.query(block);
    await runner.query(keyCons);
    await runner.query(keyComment);
    for (const block of keyDdl) await runner.query(block);
    for (const p of keyPriv) await runner.query(p);
    for (const p of priv) await runner.query(p);
    await runner.query(selfCheck);
    await runner.query(keyCheck);
    for (const block of sixDdl) await runner.query(block);
    for (const p of sixPriv) await runner.query(p);
    await runner.query(sixCheck);
    for (const block of foldDdl) await runner.query(block);
    for (const p of foldPriv) await runner.query(p);
    await runner.query(foldCheck);
  } catch (e) { err = e; }
  if (!err && APPLY) await runner.query("commit"); else await runner.query("rollback");
  check(`the ${ddl.length} bodies of 135, the one body of 136, the key and the comment of 137, its `
    + `one body, the ${priv.length + keyPriv.length} privilege statements, 138's body with its own `
    + "grant and sweep, and 139's body with the revoke 135 wrote for it"
    + `${APPLY ? " and are committed" : " — all run together and are rolled back"}`, !err, err?.message);
  check("…and 136's own self-check passes against the catalog this rehearsal left, so the file's "
    + "written account of what it replaced is verified by the platform rather than by this gate",
    !err, err?.message);
  check("…and so does 137's, which reads the attempt key out of `pg_constraint` and the read's body "
    + "out of `pg_proc` — the two things that file exists to change", !err, err?.message);
  check("…and 138's, which counts its own binds and reads the skip sentence out of the body it wrote "
    + "— so the file that says the count asks a charge its money is checked by the door itself",
    !err, err?.message);
  check("…and 139's, which calls the scrub it just wrote on eight camelCase keys and demands four "
    + "words back: a fold that stopped working would fail its own file before this gate reached "
    + "phase 11", !err, err?.message);
  check("…while `create or replace` left every door's grant list alone — a drop-and-create would "
    + "have reset EXECUTE to PUBLIC", !err, err?.message);
  if (err) {
    await runner.end().catch(() => undefined);
    console.log(`\nNone of these files runs as written. Nothing below this line is proved.`);
    console.log(String(err?.message ?? err));
    process.exitCode = 1;
    return;
  }

  // …and the same socket carries on into the phases. The pooler refuses a second simultaneous
  // connection rather than queueing it, so a gate that opened one per section would fail at the second
  // section on a database it can reach perfectly well. `run()` takes both of its clients as this one:
  // its committed census is read before `begin` and again after the rollback, which is the only place
  // it needed a socket outside the transaction.
  try {
    await run(runner, runner, { src, fix, key, six, fold, moneyRoute, gateRoute, ddl, fixDdl, keyDdl,
      sixDdl, foldDdl, analytics, gatewayDesk, gatewayPage, reconDesk, reconPage });
  } finally {
    await runner.end().catch(() => undefined);
  }
}

async function connect(url: string) {
  const c = new pg.Client({
    connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 300000
  });
  await c.connect();
  return c;
}

async function run(owner: pg.Client, tidy: pg.Client, ctx: Record<string, any>) {
  const src = ctx.src as string;
  const fix = ctx.fix as string;
  const key = ctx.key as string;
  const six = ctx.six as string;
  const fold = ctx.fold as string;
  /** The bodies this file replays inside savepoints, so that "the old door answered wrong" can be a
   *  fact read off the catalog rather than a sentence typed beside a number. `ddl` is 135's set —
   *  phase 11 needs its un-folded scrub out of it — and `fixDdl` is 136's single door, which phase 5
   *  puts back for one count to show the sum it wrote. */
  const ddl = ctx.ddl as string[];
  const fixDdl = ctx.fixDdl as string[];
  const foldDdl = ctx.foldDdl as string[];
  const moneyRoute = ctx.moneyRoute as string;
  const gateRoute = ctx.gateRoute as string;
  const analytics = ctx.analytics as string;
  const gatewayDesk = ctx.gatewayDesk as string;
  const gatewayPage = ctx.gatewayPage as string;
  const reconDesk = ctx.reconDesk as string;
  const reconPage = ctx.reconPage as string;
  /** The registry as the files write it — 138 changes two figures and one sentence, not one `v_names`
   *  line, so the questions still come from 136's door. Everything below that talks about a run's
   *  `checks` or its `examined.questions` is built from `Q`, so the gate follows the migration instead
   *  of a number typed into this file. */
  const Q = questions(fix);
  const Q135 = questions(src);
  const allNames = [...new Set(Object.values(Q).flat())];

  // The committed state, taken before this run's transaction exists and read again after the rollback:
  // the office's registers are proved unchanged rather than assumed empty, which matters the day a real
  // seat raises a real count on dev.
  const census = async (c: pg.Client) => Object.fromEntries((await c.query(
    `select 'runs' as k, count(*)::int as n from money_reconciliation_runs
     union all select 'findings', count(*)::int from money_reconciliation_findings
     union all select 'attempts', count(*)::int from gateway_webhook_attempts
     union all select 'deliveries', count(*)::int from payment_webhooks
     union all select 'charges', count(*)::int from payments
     union all select 'invoices', count(*)::int from invoices
     union all select 'postings', count(*)::int from money_postings
     union all select 'legs', count(*)::int from money_entries
     union all select 'accounts', count(*)::int from money_accounts
     union all select 'audits', count(*)::int from audit_logs
     union all select 'tenants', count(*)::int from tenants
     union all select 'seats', count(*)::int from users
     union all select 'rails_on', count(*)::int from payment_gateways where enabled
     union all select 'run_seq', last_value::int from recon_run_number_seq
     union all select 'post_seq', last_value::int from money_posting_number_seq`))
    .rows.map((r: any) => [r.k, r.n])) as Record<string, number>;
  const BASE = await census(tidy);

  // ---------------- the two books and the seats ----------------
  // The office is proved by `money_move_is_the_office`, which asks only whether the tenant is a
  // `platform` row. So the gate's office is a synthetic platform tenant, written inside this
  // transaction: nothing here can reach the real book, and nothing here has to be deleted afterwards.
  const OF = randomUUID(), OB = randomUUID(), OC = randomUUID(), CO = randomUUID();
  const PEN = randomUUID(), QUILL = randomUUID(), ERASER = randomUUID();
  const BRUSH = randomUUID(), CLERK = randomUUID(), BOSS = randomUUID();
  await owner.query("begin");
  /** The last statement the socket was asked to run. A raised trigger aborts a whole section and the
   *  database's message names only the column, so a failure inside a twelve-statement section would
   *  otherwise be unsolvable from the log; this makes the aborting line printable. */
  let lastSql = "";
  const where = (sql: string) => { lastSql = sql.replace(/\s+/g, " ").slice(0, 220); };
  const oi = (sql: string, p: any[] = []) => { where(sql); return owner.query(sql, p); };
  const one = async (sql: string, p: any[] = []) => (await oi(sql, p)).rows[0];
  let sp = 0;
  /** Every statement of every phase is wrapped in a savepoint. A raised trigger aborts the whole
   *  transaction, and every query after that would answer "current transaction is aborted" instead of
   *  the question it was asked — the trap 133's gate fell into first and 135's refuses are full of. */
  const guarded = async (sql: string, p: any[] = []) => {
    const name = `s${++sp}`;
    await oi(`savepoint ${name}`);
    try {
      const rows = (await oi(sql, p)).rows;
      await oi(`release savepoint ${name}`);
      where(sql);
      return { rows, err: null as any };
    } catch (e: any) {
      await oi(`rollback to savepoint ${name}`);
      where(sql);
      return { rows: null as any, err: e };
    }
  };
  const fails = async (label: string, sql: string, p: any[] = [], want = "") => {
    const { err } = await guarded(sql, p);
    check(label, !!err, err ? "" : "expected a refusal, and the statement succeeded");
    if (err && want) {
      const named = /^[a-z0-9_]+$/.test(want);
      const hit = named ? (err.constraint === want || String(err.message).includes(want))
        : String(err.message).includes(want);
      check(`…by ${want}`, hit, { constraint: err.constraint, message: err.message });
    }
    return err;
  };
  const okDo = async (label: string, sql: string, p: any[] = []) => {
    const { err, rows } = await guarded(sql, p);
    if (err) check(`${label} — it raised`, false, `${err.message} ⟵ ${lastSql}`);
    return rows as Record<string, any>[];
  };
  /** A definer answers with a jsonb value, so its refusal is read rather than caught. A door that
   *  raises instead of answering is a different fault and is labelled as one. */
  const call = async (label: string, sql: string, p: any[] = []) => {
    const { err, rows } = await guarded(sql, p);
    if (err) {
      check(`${label} — the door raised instead of answering`, false,
        `${err.message} ⟵ ${lastSql}`);
      return null as Record<string, any> | null;
    }
    return (rows?.[0]?.r ?? null) as Record<string, any> | null;
  };

  await okDo("the gate's own office book exists", `insert into tenants
    (id, type, name, status, trial_ends_at) values
      ($1,'platform',$2,'active', now() + interval '30 days'),
      ($3,'platform',$4,'active', now() + interval '30 days'),
      ($5,'platform',$6,'active', now() + interval '30 days'),
      ($7,'transporter',$8,'trial', now() + interval '3 days')`,
    [OF, BOOK("Office"), OB, BOOK("Broken"), OC, BOOK("Other"), CO, BOOK("Cargo Ltd")]);
  await okDo("and the seats that sign its counts belong to it", `insert into users
      (id, tenant_id, user_type, full_name, email, status) values
      ($1,$2,'platform','Recon Pen',$3,'active'),
      ($4,$5,'platform','Recon Quill',$6,'active'),
      ($7,$8,'platform','Recon Eraser',$9,'active'),
      ($10,$11,'platform','Recon Brush',$12,'active'),
      ($13,$14,'director','Recon Clerk',$15,'active'),
      ($16,$17,'staff','Recon Boss',$18,'active')`,
    [PEN, OF, EMAIL("pen"), QUILL, OF, EMAIL("quill"), ERASER, OF, EMAIL("eraser"),
      BRUSH, OB, EMAIL("brush"), CLERK, OC, EMAIL("clerk"), BOSS, CO, EMAIL("boss")]);

  /** The chart, opened through 133's own door rather than inserted: a gate that wrote accounts by hand
   *  would be proving its own INSERT and not the register the office keeps. */
  const open = async (book: string, actor: string, code: string, label: string, kind: string,
    currency = "TZS") => {
    const r = await call(`open ${code}`, OPEN_SQL, [book, code, label, kind, currency, null, actor]);
    return (r?.id ? r : null) as Record<string, any> | null;
  };
  const ACC: Record<string, Record<string, any>> = {};
  for (const [k, code, label, kind, cur] of [
    ["BANK", "OPS-BANK", "Office bank (TZS)", "asset", "TZS"],
    ["COST", "OPS-COST", "Office costs (TZS)", "expense", "TZS"],
    ["DUE", "OPS-DUE", "Office payable (TZS)", "liability", "TZS"],
    ["HEAD", "WALLET-TZS", "Wallets (TZS)", "asset", "TZS"],
    ["ESC", "ESCROW-TZS", "Escrow (TZS)", "liability", "TZS"],
    ["GATE", "GATE-WAIT", "Gateway money waiting (TZS)", "asset", "TZS"],
    ["BANK2", "GATE-BROKEN", "Broken bank (TZS)", "asset", "TZS"]
  ] as [string, string, string, string, string][]) {
    const row = await open(k === "BANK2" ? OB : OF, k === "BANK2" ? BRUSH : PEN, code, label, kind, cur);
    if (row) ACC[k] = row; else check(`the office's chart has ${code}`, false);
  }
  /** A movement written by hand, because the gate needs legs on chosen days and needs one that is
   *  deliberately wrong. 133's own triggers still fire: a leg that names another book, a currency
   *  that changes, or a frozen account is refused here exactly as it is at the desk. A leg names a
   *  chart key from `ACC` or the id of a line a door minted later — a holder's `WLT-…` code is cut by
   *  134 from the company's own id, so this gate cannot know it in advance and must not invent one. */
  let nPost = 0;
  const plant = async (label: string, book: string, actor: string, day: string,
    legs: [string, string, string][], o: Record<string, any> = {}) => {
    nPost++;
    const id = randomUUID();
    const debits = legs.filter((l) => l[1] === "debit")
      .reduce((a, l) => a + Number(l[2]), 0);
    const rows = await okDo(label, `insert into money_postings
        (id, tenant_id, ref, posted_on, memo, currency, source_kind, total, raised_by)
        values ($1,$2,$3,$4::date,$5,$6,$7,$8,$9) returning id`,
      [id, book, `PST-${new Date().getFullYear()}-${900000 + nPost}`, day,
        o.memo ?? `Recon Gate ${STAMP} movement ${nPost}`, o.currency ?? "TZS",
        o.kind ?? "manual", Number(o.total ?? debits).toFixed(2), actor]);
    if (!rows.length) return null;
    for (const [account, direction, amount] of legs) {
      await okDo(`…and its ${direction} of ${amount}`, `insert into money_entries
          (id, posting_id, tenant_id, account_id, direction, amount, detail)
        values ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), id, book, ACC[account]?.id ?? account, direction, amount,
          o.detail ?? null]);
    }
    return id;
  };

  // ---------------- 1 · the registers ----------------
  phase("1 · the three registers, as the catalog actually keeps them");
  const cons = (await oi(`select conrelid::regclass::text as tbl, conname, contype,
      lower(pg_get_constraintdef(oid)) as def
    from pg_constraint where conrelid = any($1::regclass[]) order by 1,2`, [REGISTERS]))
    .rows as { tbl: string; conname: string; contype: string; def: string }[];
  const cols = (await oi(`select table_name as tbl, column_name as col, data_type as type,
      coalesce(numeric_precision,0) as prec, coalesce(numeric_scale,0) as scale,
      is_nullable as nul, is_generated as gen, generation_expression as expr
    from information_schema.columns where table_name = any($1) order by 1,2`, [REGISTERS]))
    .rows as Record<string, any>[];
  const idxRows = (await oi(`select tablename as tbl, indexname as name, lower(indexdef) as def
    from pg_indexes where tablename = any($1) order by 1,2`, [REGISTERS])).rows as
    Record<string, any>[];
  const trigRows = (await oi(`select tgname as name, tgrelid::regclass::text as tbl,
      lower(regexp_replace(pg_get_triggerdef(oid), '\\s+', ' ', 'g')) as def
    from pg_trigger where tgrelid = any($1::regclass[]) and not tgisinternal order by 1`,
    [REGISTERS])).rows as Record<string, any>[];
  const fkRows = cons.filter((c) => c.contype === "f");
  const checkRows = cons.filter((c) => c.contype === "c");
  const words = (tbl: string, needle: string) =>
    quoted(checkRows.find((c) => c.tbl === tbl && c.def.includes(needle))?.def ?? "");
  const tableGrants = (await oi(`select c.relname as register,
      case when a.grantee = 0 then 'PUBLIC' else gr.rolname end as who,
      array_agg(distinct a.privilege_type order by a.privilege_type) as what
    from pg_class c cross join aclexplode(c.relacl) a
    left join pg_roles gr on gr.oid = a.grantee
    where c.relname = any($1) group by 1,2 order by 1,2`, [REGISTERS])).rows as
    Record<string, any>[];
  const polRows = (await oi(`select tablename as tbl, policyname as name, cmd,
      lower(roles::text) as for_, regexp_replace(qual, '\\s+', ' ', 'g') as using_
    from pg_policies where tablename = any($1) order by 1,2`, [REGISTERS])).rows as
    Record<string, any>[];
  const rls = (await oi(`select relname as tbl, relrowsecurity as on, relforcerowsecurity as force
    from pg_class where relname = any($1)`, [REGISTERS])).rows as Record<string, any>[];

  check("the three registers exist with the columns 135 names: 19 on the run, 14 on the finding, "
    + "14 on an attempt, and no extra one a later migration quietly added",
    cols.filter((c) => c.tbl === "money_reconciliation_runs").length === 19
    && cols.filter((c) => c.tbl === "money_reconciliation_findings").length === 14
    && cols.filter((c) => c.tbl === "gateway_webhook_attempts").length === 14,
    { runs: cols.filter((c) => c.tbl === "money_reconciliation_runs").length,
      findings: cols.filter((c) => c.tbl === "money_reconciliation_findings").length,
      attempts: cols.filter((c) => c.tbl === "gateway_webhook_attempts").length });
  const dCol = cols.find((c) => c.tbl === "money_reconciliation_findings" && c.col === "difference");
  check("a finding's difference is GENERATED by the table and not typed by the door, so a report "
    + "whose figures disagree with their own difference cannot be written at all",
    dCol?.gen === "ALWAYS" && /book_figure/.test(String(dCol?.expr))
    && /-/.test(String(dCol?.expr)) && /paper_figure/.test(String(dCol?.expr)), dCol);
  check("…and the run's two money columns are numeric(14,2) like 133's book, not float, because a "
    + "difference is quoted to a customer and a float is not a figure anyone can sign",
    ["book_figure", "paper_figure", "difference"].every((k) => {
      const c = cols.find((x) => x.tbl === "money_reconciliation_findings" && x.col === k);
      return c?.type === "numeric" && c?.prec === 14 && c?.scale === 2;
    }) && ["net_difference"].every((k) => {
      const c = cols.find((x) => x.tbl === "money_reconciliation_runs" && x.col === k);
      return c?.type === "numeric" && c?.prec === 14 && c?.scale === 2;
    }), cols.filter((c) => /figure|difference/.test(c.col)).map((c) => [c.col, c.type, c.prec, c.scale]));
  const defers = fkRows.filter((c) => c.def.includes("deferrable"));
  check("a finding's run id is a DEFERRABLE INITIALLY DEFERRED key — the door counts the exceptions "
    + "into the findings before the run row exists, which is the only way the run's own figures can "
    + "be frozen absolutely rather than edited by a second statement",
    defers.some((c) => c.tbl === "money_reconciliation_findings"
      && c.def.includes("references money_reconciliation_runs")
      && c.def.includes("deferrable") && c.def.includes("initially deferred")),
    defers.map((c) => [c.tbl, c.def.slice(0, 120)]));
  check("…and the same pair of promises 135 makes about deletions is kept by the catalog: a run's "
    + "findings cascade with it and a delivery's attempts cascade with it, because the cascade is "
    + "the one sanctioned way either register loses a row",
    fkRows.filter((c) => c.def.includes("on delete cascade")).length === 2
    && fkRows.some((c) => c.def.includes("money_reconciliation_runs") && c.def.includes("on delete cascade"))
    && fkRows.some((c) => c.def.includes("payment_webhooks") && c.def.includes("on delete cascade")),
    fkRows.map((c) => [c.tbl, c.def.slice(0, 90)]));
  check("the run's number is minted into a shape a person can quote and no two rows can share: "
    + "`REC-YYYY-NNNNN` with the unique index behind it",
    checkRows.some((c) => c.tbl === "money_reconciliation_runs"
      && c.def.includes("rec-[0-9]{4}-[0-9]{5,}"))
    && idxRows.some((i) => i.tbl === "money_reconciliation_runs"
      && i.def.includes("unique") && i.def.includes("ref")),
    checkRows.filter((c) => c.def.includes("rec-")).map((c) => c.def));
  /** 137 repaired the second half of this pair. 135 keyed the ledger `(webhook_id, attempt)` while its
   *  own door numbered a press over `webhook_id AND tenant_id`, so a second office asking the same
   *  delivery completed the charge and then could not write the row that says it did. The key is read
   *  from the catalog rather than from either file, because the two of them disagree on purpose — and
   *  so is its comment, which is the only place the ledger states whose press a number is. */
  const attemptKey = cons.find((c) => c.tbl === "gateway_webhook_attempts" && c.contype === "u");
  const keySaid = (await oi(`select d.description as said from pg_constraint c
      join pg_description d on d.objoid = c.oid and d.classoid = 'pg_constraint'::regclass
     where c.conname = 'gateway_webhook_attempt_numbered_per_desk'`))
    .rows as { said: string }[];
  check("a finding's line is unique per run, and an attempt's number unique per desk — two "
    + "`row_number()`s written to the same paper would otherwise be one report with two figures "
    + "about the same thing",
    cons.some((c) => c.conname === "money_recon_finding_line_per_run" && c.contype === "u")
    && attemptKey?.conname === "gateway_webhook_attempt_numbered_per_desk"
    && /webhook_id, ?tenant_id, ?attempt/.test(attemptKey?.def ?? "")
    && !cons.some((c) => c.conname === "gateway_webhook_attempt_numbered_per_delivery")
    && /names the book that made the press/i.test(String(keySaid[0]?.said ?? "")),
    { key: attemptKey?.conname, def: attemptKey?.def, said: String(keySaid[0]?.said ?? "").slice(0, 140),
      unique: cons.filter((c) => c.contype === "u").map((c) => c.conname) });
  const scopeWords = words("money_reconciliation_runs", "'book'");
  check(`the seven scopes the register will hold (${scopeWords.join(", ")}) are one list and not `
    + "four: the table's CHECK, the door's own refusal, 135's switch and the desk's picker agree "
    + "word for word",
    same(scopeWords, ["book", "wallet", "escrow", "payout", "refund", "gateway", "all"])
    && same(wordsInList(src, "if v_scope not in ("), scopeWords)
    && same(Object.keys(Q), ["book", "wallet", "escrow", "pay", "ref", "gate", "rails"])
    && same(zodEnum(moneyRoute, "SCOPE"), scopeWords),
    { table: scopeWords, door: wordsInList(src, "if v_scope not in ("),
      desk: zodEnum(moneyRoute, "SCOPE"), switch_: Object.keys(Q) });
  check("…and the two monies the run can be asked in are the two 133's book keeps, the two the door "
    + "takes and the two the desk can type",
    same(words("money_reconciliation_runs", "'tzs'"), ["tzs", "usd"])
    && same(wordsInList(src, "if v_cur not in ("), ["tzs", "usd"])
    && sameFold(zodEnum(moneyRoute, "currency"), ["tzs", "usd"]),
    { table: words("money_reconciliation_runs", "'tzs'"),
      door: wordsInList(src, "if v_cur not in ("), desk: zodEnum(moneyRoute, "currency") });
  const kindWords = words("money_reconciliation_findings", "'gateway_line'");
  check("the twelve kinds of paper a finding can be about are the twelve 135 lists, and the shape "
    + "of a question's name is checked rather than an allowlist of nineteen words — a new question "
    + "must not need a migration of the findings table",
    kindWords.length === 12 && kindWords.includes("gateway_line")
    && kindWords.includes("many") && kindWords.includes("refund_paper")
    && checkRows.some((c) => c.def.includes("^[a-z][a-z0-9_]{2,39}$")),
    { kinds: kindWords, regex: checkRows.filter((c) => /\^\[a-z\]/.test(c.def)).length });
  const moneyStatus = [...moneyRoute.matchAll(/status:\s*z\.enum\(\[([^\]]*)\]/g)]
    .map((m) => [...m[1].matchAll(/["']([a-z_0-9]+)["']/gi)].map((x: any) => x[1].toLowerCase()))
    .find((w: string[]) => w.includes("reviewed")) ?? [];
  check("the five verdicts, the four answers an attempt can carry and the two states a run moves "
    + "through are each one list across the table and the desk that offers them",
    same(words("money_reconciliation_findings", "'differs'"),
      ["differs", "missing_book", "missing_paper", "refused", "stale"])
    && same(words("gateway_webhook_attempts", "'succeeded'"),
      ["succeeded", "already_final", "refused", "failed"])
    && same(words("money_reconciliation_runs", "'open'"), ["open", "reviewed"])
    && sameFold(moneyStatus, ["all", "open", "reviewed"])
    && (src.match(/status <> 'open'/g) ?? []).length === 3,
    { verdicts: words("money_reconciliation_findings", "'differs'"),
      outcomes: words("gateway_webhook_attempts", "'succeeded'"),
      states: words("money_reconciliation_runs", "'open'"), desk: moneyStatus });
  // The deparser expands `between a and b` into the pair of comparisons and writes `trim(x)` as
  // `trim(both from x)`, so these needles are the catalog's words for the file's rules rather than the
  // file's own — which is the point of reading the register instead of the migration here.
  check("an attempt's number is 1 to 5 as a CHECK and not as a hint, and its answer is a jsonb "
    + "object with a sentence beside it: the ceiling is the table's, so a sixth row is refused by "
    + "the register even if a door forgot",
    checkRows.some((c) => c.tbl === "gateway_webhook_attempts"
      && has(c.def, "attempt >= 1") && has(c.def, "attempt <= 5"))
    && checkRows.some((c) => c.tbl === "gateway_webhook_attempts"
      && has(c.def, "jsonb_typeof(answer) = 'object'"))
    && checkRows.some((c) => c.tbl === "gateway_webhook_attempts"
      && has(c.def, "char_length(trim(both from message)) >= 8")
      && has(c.def, "char_length(trim(both from message)) <= 600")),
    checkRows.filter((c) => c.tbl === "gateway_webhook_attempts").map((c) => c.def.slice(0, 90)));
  check("the paired rules are kept by the table rather than by the door: a reviewed run cannot "
    + "exist without a second seat's name, note and time, a signature is a pair of columns that "
    + "are both null or both set, and a run that found nothing has nothing to net off",
    checkRows.some((c) => c.tbl === "money_reconciliation_runs"
      && has(c.def, "status <> 'reviewed'"))
    && checkRows.some((c) => c.tbl === "money_reconciliation_runs"
      && has(c.def, "reviewed_by is null = reviewed_at is null"))
    && checkRows.some((c) => c.tbl === "money_reconciliation_runs"
      && has(c.def, "findings > 0 or net_difference = 0"))
    && checkRows.some((c) => c.tbl === "money_reconciliation_runs"
      && has(c.def, "from_day <= to_day"))
    && checkRows.some((c) => c.tbl === "money_reconciliation_runs"
      && has(c.def, "jsonb_typeof(examined) = 'object'")),
    checkRows.filter((c) => c.tbl === "money_reconciliation_runs").map((c) => c.def.slice(0, 80)));
  check("every window is kept in order by the register itself, so a count asked of days that have "
    + "not happened or that run backwards is refused even by a seat with a direct connection",
    checkRows.some((c) => c.def.includes("from_day <= to_day"))
    && cols.filter((c) => c.tbl === "money_reconciliation_runs"
      && ["from_day", "to_day"].includes(c.col)).every((c) => c.nul === "NO"),
    cols.filter((c) => /_day$/.test(c.col)));
  const owners = (await oi(`select c.relname as register, r.rolname as owner
    from pg_class c join pg_roles r on r.oid = c.relowner where c.relname = any($1)`,
    [REGISTERS])).rows as Record<string, any>[];
  const writesOf = (t: string) => tableGrants
    .filter((g) => g.register === t && g.who !== owners.find((o) => o.register === t)?.owner)
    .filter((g) => g.what.some((p: string) => /INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER/.test(p)))
    .map((g) => [g.who, g.what]);
  check("all three are append-only to the app role: SELECT and nothing else, and no client role at "
    + "all. The doors are the only write, which is what makes the audit row beside every one of them "
    + "unavoidable",
    REGISTERS.every((t) => {
      const mine = tableGrants.filter((g) => g.register === t);
      return mine.some((g) => g.who === "app_runtime" && same(g.what, ["SELECT"]))
        && !mine.some((g) => ["PUBLIC", "anon", "authenticated", "service_role"].includes(g.who))
        && writesOf(t).length === 0;
    }), { owners, writes: REGISTERS.map((t) => [t, writesOf(t)]), tableGrants });
  check("…with row-level security on and one policy per register, for SELECT only, bound to the "
    + "tenant the session names — the run's own book, not whichever uuid a caller typed",
    rls.length === 3 && rls.every((r) => r.on) && polRows.length === 3
    && polRows.every((p) => p.cmd === "SELECT" && p.for_.includes("app_runtime"))
    && polRows.every((p) => has(String(p.using_),
      "tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid")),
    { rls, polRows: polRows.map((p) => [p.tbl, p.cmd, p.using_]) });
  const seqAcl = (await oi(`select r.rolname as owner, c.relacl::text as acl
    from pg_class c join pg_roles r on r.oid = c.relowner
    where c.relname = 'recon_run_number_seq'`)).rows[0] as Record<string, any>;
  const seqHolders = (await oi(`select grantee, string_agg(privilege_type, ',' order by privilege_type) as p
    from information_schema.role_usage_grants where object_name = 'recon_run_number_seq'
    group by 1 order by 1`)).rows as Record<string, any>[];
  check("the sequence a run's number is minted from is held by the doors alone: no client role and "
    + "not even the app role may burn a REC reference the office never raised. The only holder is "
    + "the owner, whose definer bodies call the `nextval` — 135 revokes the five client roles by "
    + "name, and the catalog is where that either happened or did not",
    seqHolders.length === 1 && seqHolders[0].grantee === seqAcl.owner
    && !seqHolders.some((g) => ["PUBLIC", "anon", "authenticated", "app_runtime", "service_role"]
      .includes(String(g.grantee)))
    && /postgres=rwU/.test(String(seqAcl.acl))
    && (src.match(/revoke all on sequence recon_run_number_seq[\s\S]*?from ([^;]+);/)?.[1] ?? "")
      .split(",").map((w) => w.trim()).length === 5,
    { seqAcl, seqHolders, revoke: src.match(/revoke all on sequence[\s\S]{0,140}/)?.[0] });
  check("…and the four guard triggers exist as the catalog keeps them, on the tables 135 says, at "
    + "the moments it says: the run is guarded before update and before delete, a finding before "
    + "either, and an attempt BEFORE UPDATE ONLY — the missing delete guard is the one that lets "
    + "the cascade from the delivery do the only sanctioned erasure in this design",
    trigRows.length === 5
    && trigRows.some((t) => t.name === "money_recon_runs_keep_their_account"
      && t.def.includes("before update on public.money_reconciliation_runs"))
    && trigRows.some((t) => t.name === "money_recon_runs_are_kept"
      && t.def.includes("before delete on public.money_reconciliation_runs"))
    && trigRows.some((t) => t.name === "money_recon_findings_are_kept"
      && t.def.includes("before delete or update on public.money_reconciliation_findings"))
    && trigRows.some((t) => t.name === "gateway_webhook_attempts_are_kept"
      && t.def.includes("before update on public.gateway_webhook_attempts")
      && !t.def.includes("delete")),
    trigRows.map((t) => [t.name, t.def.slice(0, 70)]));
  check("…which is the fifth trigger: 135's own `set_updated_at` on the run, so a signed count "
    + "carries the moment it was signed and a board can be ordered by it",
    trigRows.some((t) => t.name === "trg_money_recon_runs_updated"
      && t.def.includes("before update on public.money_reconciliation_runs")
      && t.def.includes("set_updated_at()")), trigRows.map((t) => t.def.slice(-46)));

  // ---------------- 2 · the doors ----------------
  phase("2 · the fourteen bodies, and who is allowed to knock");
  const proc = (await oi(`select p.proname as name, count(*) over (partition by p.proname) as arities,
      p.prosecdef as definer, l.lanname as lang, p.provolatile as vol,
      r.rolname as owner, array_to_string(p.proconfig, ',') as cfg,
      pg_get_function_arguments(p.oid) as args,
      regexp_replace(pg_get_functiondef(p.oid), '\\s+', ' ', 'g') as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join pg_roles r on r.oid = p.proowner
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'platform_auth' and p.proname = any($1::text[])`, [ALL_FNS]))
    .rows as Record<string, any>[];
  const fnGrants = (await oi(`select p.proname as name,
      case when a.grantee = 0 then 'PUBLIC' else gr.rolname end as who,
      array_agg(distinct a.privilege_type order by a.privilege_type) as what
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join aclexplode(p.proacl) a left join pg_roles gr on gr.oid = a.grantee
    where n.nspname = 'platform_auth' and p.proname = any($1::text[]) group by 1,2`,
    [ALL_FNS])).rows as Record<string, any>[];
  check(`all ${ALL_FNS.length} bodies are in the catalog and exactly one signature each: a `
    + "`create or replace` with a different argument list would have left the old door standing "
    + "with its own grants",
    proc.length === ALL_FNS.length && ALL_FNS.every((f) => {
      const mine = proc.filter((p) => p.name === f);
      return mine.length === 1 && Number(mine[0].arities) === 1;
    }), { got: proc.length, want: ALL_FNS.length,
      missing: ALL_FNS.filter((f) => !proc.some((p) => p.name === f)),
      extra: proc.filter((p) => !ALL_FNS.includes(p.name)).map((p) => p.name) });
  check("the nine doors are SECURITY DEFINER with a pinned search path, and so is the one guard that "
    + "has to read a second table — a finding's own run, to see whether a seat signed it — while the "
    + "three guards that only look at the row firing them and the scrub that touches no table at all "
    + "run as their caller, which is the smallest set of definer bodies this design needs",
    [...WRITES, ...READS].every((f) => proc.find((p) => p.name === f)?.definer === true
      || f === "scrub_gateway_payload")
    && proc.find((p) => p.name === "recon_findings_are_kept")?.definer === true
    && ["recon_run_keeps_its_account", "recon_run_is_kept_once_signed", "webhook_attempt_is_kept",
      "scrub_gateway_payload"].every((f) => proc.find((p) => p.name === f)?.definer === false)
    && proc.every((p) => /search_path=public/.test(String(p.cfg))),
    proc.map((p) => [p.name, p.definer, p.cfg]));
  check("…and the doors speak the two languages 135 wrote: nine plpgsql, the one count read that "
    + "is a single SELECT in `language sql`, the scrub immutable because it touches no table at all",
    proc.filter((p) => p.lang === "plpgsql").length === 13
    && proc.find((p) => p.name === "money_recon_detail")?.lang === "sql"
    && proc.find((p) => p.name === "money_recon_detail")?.vol === "s"
    && proc.find((p) => p.name === "scrub_gateway_payload")?.vol === "i",
    proc.map((p) => [p.name, p.lang, p.vol]));
  const LEAKY = ["PUBLIC", "anon", "authenticated", "service_role"];
  // The nine bodies a seat may knock on, and the five the platform calls for it: a guard fires from its
  // own table and the scrub is read from inside a definer door, so neither needs an outside EXECUTE.
  const DOORS = [...WRITES, ...READS.filter((r) => r !== "scrub_gateway_payload")];
  const INTERNAL = [...GUARDS, "scrub_gateway_payload"];
  const granted = [...stmtBetween(src, "grant execute on function", "to app_runtime;")
      .matchAll(/platform_auth\.([a-z_]+)\(/g)].map((m) => m[1]);
  check("the nine doors are EXECUTE to the app role alone and the five internal bodies are EXECUTE "
    + "to nobody outside the platform: the list 135's grant statement wrote, the list the catalog "
    + "holds and the list this gate reads off the desk's own route file are one list, and no "
    + "PUBLIC, anon, authenticated or service role sits on any of the fourteen",
    same(granted, DOORS)
    && DOORS.every((f) => {
      const mine = fnGrants.filter((g) => g.name === f);
      return mine.some((g) => g.who === "app_runtime" && same(g.what, ["EXECUTE"]))
        && !mine.some((g) => LEAKY.includes(g.who));
    })
    && INTERNAL.every((f) => !fnGrants.some((g) => g.name === f && g.who === "app_runtime"))
    && ALL_FNS.every((f) => !fnGrants.some((g) => g.name === f
      && (LEAKY.includes(g.who) || !same(g.what, ["EXECUTE"])))),
    { granted, doors: DOORS,
      leaky: fnGrants.filter((g) => LEAKY.includes(g.who)).map((g) => [g.name, g.who]),
      internal: fnGrants.filter((g) => INTERNAL.includes(g.name)).map((g) => [g.name, g.who]) });
  const live = fileBodies(src), liveFix = fileBodies(fix), liveKey = fileBodies(key);
  const liveSix = fileBodies(six), liveFold = fileBodies(fold);
  // Each of the four later files replaces one body, so for that function the text the platform must be
  // running is the newest file's; 135's text is the fallback for the twelve functions nobody touched.
  // Read in this order, a file that was applied to dev but never written here shows as a drift, and so
  // does one that was written here but never applied — which is what the line below is for.
  const onDisk = (name: string) =>
    liveFold[name] ?? liveSix[name] ?? liveKey[name] ?? liveFix[name] ?? live[name];
  const drifts = proc.filter((p) => onDisk(p.name) !== bodyOf(p.def));
  check("every body the platform is running is the one the newest of the five files wrote it — "
    + "whitespace aside, read out of `pg_get_functiondef`, so an edit that never reached dev cannot "
    + "pass this gate",
    drifts.length === 0, drifts.map((d) => [d.name, d.def.slice(0, 60),
      (onDisk(d.name) ?? "").slice(0, 60)]));
  check("…which is also the proof that 136 itself is live: the running count door carries 136's own "
    + "join of a delivery to the charge it names, and that clause is in neither of 135's two "
    + "questions — so the body dev holds is the fix, not the file it fixed",
    (() => {
      const running = bodyOf(proc.find((p) => p.name === "run_money_reconciliation")?.def ?? "");
      const needle = "as wanted";
      return running.includes(needle) && !live["run_money_reconciliation"].includes(needle)
        && liveFix["run_money_reconciliation"].includes(needle);
    })());
  check("…and 137 is live by the same test: the delivery read the platform runs counts its ceiling "
    + "over the asking desk and asks the reference for its text, and neither clause is in 135's "
    + "body — while the key-existence question that 135 asked is gone from it entirely",
    (() => {
      const running = bodyOf(proc.find((p) => p.name === "gateway_webhook_detail")?.def ?? "");
      const perDesk = "a.webhook_id = v_w.id and a.tenant_id = p_tenant) >= 5";
      const asText = "elsif coalesce(v_w.payload ->> 'reference', '') = '' then";
      return running.includes(perDesk) && running.includes(asText)
        && !live["gateway_webhook_detail"].includes(perDesk)
        && !live["gateway_webhook_detail"].includes(asText)
        && !running.includes("payload ? 'reference'");
    })());
  check("…and 138 is live by the same test: the count the platform runs asks the charge which money it "
    + "is in on both of the figure-bearing delivery questions, and neither bind clause exists in 136's "
    + "body — so the sum a seat reads is the repaired one, not the file that repaired a different lie",
    (() => {
      const running = bodyOf(proc.find((p) => p.name === "run_money_reconciliation")?.def ?? "");
      const bind = "and pay.currency = v_cur and w.created_at::date between v_from and v_to";
      const nullBind = "and coalesce(pay.currency, v_cur) = v_cur and w.created_at::date "
        + "between v_from and v_to";
      return running.includes(bind) && running.includes(nullBind)
        && !liveFix["run_money_reconciliation"].includes(bind)
        && !liveFix["run_money_reconciliation"].includes(nullBind)
        && running.includes("were asked of USD charges only");
    })());
  check("…and 139 is live by the same test: the scrub the platform runs splits a key name at its case "
    + "boundary before comparing it, and 135's body never heard of `regexp_replace` — which is why a "
    + "rail that writes `cardNumber` used to have it back outside the list",
    (() => {
      const running = bodyOf(proc.find((p) => p.name === "scrub_gateway_payload")?.def ?? "");
      const fold = "v_norm := lower(regexp_replace(replace(v_key, '-', '_'), "
        + "'([a-z0-9])([A-Z])', '\\1_\\2', 'g'))";
      return running.includes(fold) && !live["scrub_gateway_payload"].includes(fold)
        && running.includes("replace(v_norm, '_', '') = any (v_hidden)");
    })());

  // ---------------- 3 · raising a count ----------------
  phase("3 · the run door: the five ways it says no, then a count that says what it looked at");
  /** Sections that must not leak into the rest of the run. Both wrap themselves in a savepoint, so an
   *  unexpected refusal aborts the section rather than the transaction — and the temporary switch that
   *  turns a rail on is put away by the second of them. */
  const keep = async (fn: () => Promise<void>) => {
    const name = `k${++sp}`;
    await oi(`savepoint ${name}`);
    let raised: any = null, at = "";
    try {
      await fn();
      await oi(`release savepoint ${name}`);
    } catch (e: any) { raised = e; at = lastSql; }
    if (raised) {
      await oi(`rollback to savepoint ${name}`);
      check("a section that was meant to be kept raised instead", false,
        `${raised?.message} ⟵ ${at}`);
    }
  };
  const undo = async (label: string, fn: () => Promise<void>) => {
    const name = `u${++sp}`;
    await oi(`savepoint ${name}`);
    let raised: any = null, at = "";
    try { await fn(); }
    catch (e: any) { raised = e; at = lastSql; }
    await oi(`rollback to savepoint ${name}`);
    if (raised) check(`${label} raised inside its own section`, false,
      `${raised?.message} ⟵ ${at}`);
  };
  const refusal = async (label: string, want: string, sql: string, p: any[]) => {
    const r = await call(`${label} is refused`, sql, p);
    check(`${label} answers ${want}`, r?.ok === false && r?.error === want, r);
    return r as Record<string, any> | null;
  };
  const fnd = async (runId: string) => (await oi(`select line, check_name, subject_kind, subject_id,
      subject_ref, book_figure, paper_figure, difference, verdict, detail
    from money_reconciliation_findings where run_id = $1 order by line`, [runId])).rows as
    Record<string, any>[];
  const runRow = async (runId: string) => one(`select ref, status, checks, findings, net_difference,
      examined, scope, currency, from_day, to_day, raised_by, reviewed_by
    from money_reconciliation_runs where id = $1`, [runId]);
  /** Every accepted count spends a number from `recon_run_number_seq`, and a savepoint rolled back
   *  does not give it back. Counted here so the reference minted can be predicted from the value the
   *  sequence held before the run, and so phase 15 can prove the gap the rollback left. */
  let spent = 0;
  const counted = async (label: string, scope: string, cur: string, from: string, to: string,
    book = OF, actor = PEN) => {
    const r = await call(label, RUN_SQL, [book, scope, cur, from, to, actor, "finance_officer",
      "10.0.0.1", STAMP]);
    if (r?.ok === true) spent++;
    return r as Record<string, any> | null;
  };

  const OD = randomUUID();
  await okDo("a fifth book that was erased is planted", `insert into tenants
    (id, type, name, status, trial_ends_at) values ($1,'platform',$2,'active', now())`,
    [OD, BOOK("Erased")]);
  await okDo("…and closed the way 133's own door closes a company", `update tenants set deleted_at = now()
    where id = $1`, [OD]);
  const silentBefore = await one(`select (select count(*)::int from money_reconciliation_runs) as runs,
    (select count(*)::int from money_reconciliation_findings) as findings,
    (select count(*)::int from audit_logs where action = 'recon.raised') as raised`);
  await refusal("a count asked of a company's own book", "not_the_office", RUN_SQL,
    [CO, "all", "TZS", OPEN_DAY, TODAY, CLERK, "director", "10.0.0.1", STAMP]);
  await refusal("a count asked of a book that has been erased", "not_the_office", RUN_SQL,
    [OD, "all", "TZS", OPEN_DAY, TODAY, PEN, "finance_officer", "10.0.0.1", STAMP]);
  const wrongScope = await refusal("a count of a half nobody named", "bad_scope", RUN_SQL,
    [OF, "ledger", "TZS", OPEN_DAY, TODAY, PEN, "finance_officer", "10.0.0.1", STAMP]);
  check("…and it hands the word back, so a seat is told which one it typed rather than which list "
    + "exists", wrongScope?.scope === "ledger", wrongScope);
  const wrongCur = await refusal("a count in a money the book does not keep", "bad_currency", RUN_SQL,
    [OF, "book", "EUR", OPEN_DAY, TODAY, PEN, "finance_officer", "10.0.0.1", STAMP]);
  check("…and the money asked for is the money named back", wrongCur?.currency === "EUR", wrongCur);
  await refusal("a count with no window at all", "bad_days", RUN_SQL,
    [OF, "book", "TZS", null, null, PEN, "finance_officer", "10.0.0.1", STAMP]);
  const back = await refusal("a count whose window runs backwards", "bad_days", RUN_SQL,
    [OF, "book", "TZS", TODAY, OPEN_DAY, PEN, "finance_officer", "10.0.0.1", STAMP]);
  check("…and both days are printed in the answer, because the sentence alone cannot show which one "
    + "the seat typed wrong", back?.from_day === TODAY && back?.to_day === OPEN_DAY, back);
  const ahead = await refusal("a count up to a day that has not happened", "bad_days", RUN_SQL,
    [OF, "book", "TZS", TODAY, DAY_AGO(-3), PEN, "finance_officer", "10.0.0.1", STAMP]);
  check("…and the future day is named in the figure rather than in a claim", ahead?.to_day
    === DAY_AGO(-3), ahead);
  const silent = await one(`select (select count(*)::int from money_reconciliation_runs) as runs,
    (select count(*)::int from money_reconciliation_findings) as findings,
    (select count(*)::int from audit_logs where action = 'recon.raised') as raised`);
  check("six refusals wrote nothing: no run, no finding, and no audit row either — a door that "
    + "audited its own refusals would let a seat bury a pile of them in the register",
    silent.runs === silentBefore.runs && silent.findings === silentBefore.findings
    && silent.raised === silentBefore.raised, { silentBefore, silent });

  const clean = await counted("the office counts its own book", " Book ", "tzs", OPEN_DAY, TODAY);
  check("…and the same word in a different case, or with the spaces a form leaves in it, is the "
    + "scope the door takes: the door normalises rather than the desk", (() => {
      const r = clean;
      return !!r && r.run?.scope === "book" && r.run?.currency === "TZS";
    })(), clean?.run);
  const cleanId = clean?.run?.id as string;
  check("the count is raised as an open draft, in the office's own book, named by the seat that "
    + "asked for it", !!cleanId && !!clean && clean.run.status === "open"
    && clean.run.raised_by === "Recon Pen" && clean.run.findings === 0
    && Number(clean.run.net_difference) === 0, clean?.run);
  const refSuffix = (clean?.run?.ref ?? "").split("-").pop();
  check("the reference is the sequence's next value in the shape the register checks — REC-YYYY-"
    + "NNNNN, minted by the door and not typed by a seat",
    clean?.run?.ref === `REC-${new Date().getFullYear()}-${String(BASE.run_seq + spent).padStart(5, "0")}`
    && /^REC-[0-9]{4}-[0-9]{5,}$/.test(String(clean?.run?.ref))
    && Number(refSuffix) === BASE.run_seq + spent, { ref: clean?.run?.ref,
      expected: `REC-${new Date().getFullYear()}-${String(BASE.run_seq + spent).padStart(5, "0")}`,
      seq: BASE.run_seq, spent });
  check("a count that agrees writes no row, and the run's own account is what says so: `examined` "
    + "names every question it asked and the populations it asked them of, so an empty list is "
    + "evidence rather than a claim", (() => {
      const ex = clean?.run?.examined ?? {};
      return (ex.questions ?? []).length > 0
        && same(ex.questions, Q.book) && ex.postings !== undefined && ex.legs !== undefined
        && ex.accounts !== undefined && ex.wallets === undefined && ex.deliveries === undefined
        && ex.skipped === undefined && /whole register/.test(String(ex.basis));
    })(), clean?.run?.examined);
  const cleanRow = cleanId ? await runRow(cleanId) : null;
  check("…and the register holds exactly that: the run's figures are the door's figures, and the "
    + "findings table holds not one row for it", (() => {
      const r = cleanRow;
      return !!r && r.findings === 0 && r.checks === Q.book.length
        && Number(r.net_difference) === 0 && r.status === "open" && r.reviewed_by === null;
    })(), cleanRow);
  check("…and not one exception was written for the book it just counted, which is the sentence "
    + "the HTTP smoke cannot tell apart from a check that never ran",
    cleanId ? (await fnd(cleanId)).length === 0 : false, cleanId && await fnd(cleanId));
  const raisedAudit = await one(`select actor_role, entity, entity_id, after as a from audit_logs
    where action = 'recon.raised' and entity_id = $1`, [cleanId]);
  check("one audit row stands beside the count, on the office's own entity and with the seat's role "
    + "beside it — the door writes the paper and the fact together, so neither can be filed alone",
    raisedAudit?.entity === "money_reconciliation_runs" && !!cleanId
    && String(raisedAudit?.entity_id) === String(cleanId)
    && raisedAudit?.actor_role === "finance_officer"
    && Number(raisedAudit?.a?.questions) === Q.book.length
    && Number(raisedAudit?.a?.findings) === 0, raisedAudit);

  // ---------------- 4 · the scope decides the questions ----------------
  phase("4 · which questions a scope is allowed to ask, and what it says when it must skip some");
  /** `examined`'s keys, read out of the door: every one is written as `case when v_<flag> then …`, so
   *  the gate's expectation of what a scope reveals comes from the file rather than from a list here. */
  const examKeys = [...fix.matchAll(/'([a-z_]+)', case when v_(\w+) then/g)]
    .map((m) => ({ key: m[1], flag: m[2] }));
  check("the twelve populations the run can report on are all read from the door's own `case when`, "
    + "and each is switched by one of the seven flags the scope sets", (() => {
      const flags = new Set(["book", "wallet", "escrow", "pay", "ref", "gate", "rails"]);
      return examKeys.length === 12 && examKeys.every((e) => flags.has(e.flag))
        && same([...new Set(examKeys.map((e) => e.key))], examKeys.map((e) => e.key));
    })(), examKeys);
  const flagOn = (f: string, scope: string, cur: string, rail: boolean) => {
    const in_ = (k: string) => scope === "all" || scope === k;
    switch (f) {
      case "book": return in_("book");
      case "wallet": return in_("wallet");
      case "escrow": return in_("escrow");
      case "pay": return in_("payout");
      case "ref": return in_("refund");
      case "gate": return in_("gateway");
      case "rails": return in_("gateway") && cur === "TZS" && rail;
      default: return false;
    }
  };
  const expectNames = (scope: string, cur: string, rail: boolean) =>
    Object.entries(Q).filter(([f]) => flagOn(f, scope, cur, rail)).flatMap(([, n]) => n).sort();
  const expectKeys = (scope: string, cur: string, rail: boolean, skipped: boolean) => {
    const on = ["questions", "basis", ...examKeys
      .filter((e) => flagOn(e.flag, scope, cur, rail)).map((e) => e.key)];
    return [...new Set(skipped ? [...on, "skipped"] : on)].sort();
  };

  // A day the office's own pile is quiet on: nothing arrived on it, nothing stands open on it and no
  // money was confirmed on it. Every assertion about an ABSENCE below is made over this day, because
  // a count over a window that happens to hold a real stuck charge cannot prove that a check which
  // agrees writes nothing.
  const quiet = await one(`select to_char(c.d, 'YYYY-MM-DD') as day
      from (select generate_series(current_date - 25, current_date - 1, interval '1 day') as d) c
     where not exists (select 1 from payment_webhooks w where w.created_at::date = c.d::date)
       and not exists (select 1 from payments p where p.requested_at::date = c.d::date)
     order by c.d desc limit 1`);
  const D = quiet?.day ?? TODAY;
  check("the run found a quiet day to count on — a day with no delivery, no charge and therefore no "
    + "answer to any of the rails' questions", !!quiet?.day && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(D),
    { D, found: !!quiet?.day });
  note(`quiet day for the absence proofs: ${D}`);

  for (const scope of ["book", "wallet", "escrow", "payout", "refund", "gateway", "all"]) {
    const r = await counted(`the office counts its ${scope}`, scope, "TZS", D, D);
    const id = r?.run?.id as string;
    const want = expectNames(scope, "TZS", false);
    const rows = id ? await fnd(id) : [];
    check(`${scope}: the door asks ${want.length} question(s) and writes them into the run's own `
      + "account — the count of checks is the list of questions, not a figure typed beside it",
      r?.ok === true && r?.run?.checks === want.length
      && same(r?.run?.examined?.questions ?? [], want)
      && Number(r?.run?.checks) === (r?.run?.examined?.questions ?? []).length,
      { checks: r?.run?.checks, asked: r?.run?.examined?.questions, want });
    check(`…and every exception it wrote was written by a question it was allowed to ask`,
      rows.every((f) => want.includes(f.check_name)), rows.map((f) => f.check_name));
    check(`…and the populations it printed are exactly the ones that scope switches on`, (() => {
      const ex = r?.run?.examined ?? {};
      const skipped = Array.isArray(ex.skipped) && ex.skipped.length > 0;
      return same(Object.keys(ex).sort(), expectKeys(scope, "TZS", false, skipped));
    })(), Object.keys(r?.run?.examined ?? {}));
    if (["book", "wallet", "escrow", "payout", "gateway"].includes(scope)) {
      check(`…and a ${scope} count of a book that is in order writes not one row: ${
        scope === "gateway"
          ? "the four delivery questions are bounded by the window and this day has no arrivals on it"
          : "these questions are bound to this office's own tenants, and the book has no legs yet"
      } — so zero here is a proved absence, not a count that forgot to ask`,
        rows.length === 0 && r?.run?.findings === 0 && Number(r?.run?.net_difference) === 0,
        rows.map((f) => [f.check_name, f.subject_ref]));
    } else {
      note(`${scope}: its questions are asked of the platform's whole pile (135 binds no tenant to `
        + `block 12 and bounds the delivery questions by day only), so ${rows.length} exception(s) `
        + `came from the office's real papers — named: ${
          [...new Set(rows.map((f) => f.check_name))].join(", ") || "none"}`);
    }
    if (scope === "gateway" || scope === "all") {
      check(`…and because no rail is switched on at this desk, the two rails' questions are refused `
        + "out loud rather than reported as drift — the pending charges are the sandbox's answer",
        (r?.run?.examined?.skipped ?? []).some((s: string) => /no rail is switched on/.test(s))
        && !(r?.run?.examined?.questions ?? []).includes("payment_stale")
        && !(r?.run?.examined?.questions ?? []).includes("gateway_line_total")
        && r?.run?.examined?.payments === undefined,
        { skipped: r?.run?.examined?.skipped, q: r?.run?.examined?.questions });
    }
  }
  const usd = await counted("the office counts the gateway in USD", "gateway", "USD", D, D);
  check("a USD count of the gateway asks the four delivery questions and neither of the rails': "
    + "005 takes TZS only, and the sentence saying so is written into the run",
      usd?.ok === true && usd?.run?.checks === Q.gate.length
      && same(usd?.run?.examined?.questions ?? [], [...Q.gate].sort())
      && (usd?.run?.examined?.skipped ?? []).some((s: string) =>
        /005 takes TZS only/.test(s) && /no USD gateway line/.test(s)),
      { checks: usd?.run?.checks, skipped: usd?.run?.examined?.skipped });
  check("…and 138 adds a second sentence to the same list: the two figure-bearing delivery questions "
    + "are still asked of a USD run, but only of USD charges — and because the money is the reason, "
    + "the switch sentence the TZS run writes is not written here. A count that holds a figure back "
    + "has to say that it did",
      (usd?.run?.examined?.skipped ?? []).filter((s: string) =>
        /were asked of USD charges only/.test(s) && /translation, not a count/.test(s)).length === 1
      && (usd?.run?.examined?.skipped ?? []).length === 2
      && (usd?.run?.examined?.skipped ?? []).every((s: string) =>
        !/no rail is switched on/.test(s))
      && usd?.run?.examined?.payments === undefined,
      usd?.run?.examined?.skipped);
  const blank = await counted("the office counts with nothing typed at all",
    null as any, null as any, D, D);
  check("a seat that names no scope and no money is counted over everything in TZS — the door's own "
    + "`coalesce` defaults, so no null ever reaches the register's scope column",
      blank?.ok === true && blank?.run?.scope === "all" && blank?.run?.currency === "TZS"
      && Number(blank?.run?.checks) === expectNames("all", "TZS", false).length,
      { scope: blank?.run?.scope, cur: blank?.run?.currency, checks: blank?.run?.checks });
  await refusal("a count whose scope word is empty rather than absent", "bad_scope", RUN_SQL,
    [OF, "", "TZS", D, D, PEN, "finance_officer", "10.0.0.1", STAMP]);
  note("the empty string is refused rather than defaulted: `coalesce` answers a null, and a form that "
    + "sends \"\" is a form that did not decide. The desk's zod turns an absent field into a null, "
    + "which is why the route works and the bare word does not.");

  // The two rails' questions, with a rail switched on for the length of the section only.
  const CONF = `select coalesce(sum(p.amount), 0)::numeric(14,2) as confirmed, count(*)::int as papers
    from payments p where p.status in ('approved','refunded') and p.currency = 'TZS'
      and p.requested_at::date between $1::date and $2::date`;
  await undo("the temporary rail switch", async () => {
    await okDo("the fake rail is switched on at the desk",
      "update payment_gateways set enabled = true where provider_key = $1", [RAIL]);
    const live = await one("select count(*)::int as n from platform_auth.active_payment_gateway()");
    check("…and 135's own reader sees one live rail", live?.n === 1, live);
    const onDay = await one("select count(*)::int as n from payment_webhooks where created_at::date = $1::date", [D]);
    const confDay = await one(CONF, [D, D]);
    check("the quiet day is quiet in the strongest sense: no arrival, no charge, so the gateway "
      + "line and the rails' money both answer zero", onDay?.n === 0
      && Number(confDay?.confirmed) === 0 && confDay?.papers === 0, { onDay, confDay });
    const r1 = await counted("the office counts the gateway with a rail live", "gateway", "TZS", D, D);
    const want6 = expectNames("gateway", "TZS", true);
    const f1 = r1?.run?.id ? await fnd(r1.run.id) : [];
    check("with the rail on, the same scope asks six questions instead of four, prints the payments "
      + "population, and says nothing about skipping", (() => {
        const ex = r1?.run?.examined ?? {};
        return r1?.run?.checks === 6 && same(ex.questions ?? [], want6) && ex.skipped === undefined
          && ex.payments !== undefined && Number(ex.payments) === 0;
      })(), r1?.run?.examined);
    check("…and with nothing on the day to answer, both rails' questions agree — `gateway_line_total` "
      + "finds the line at zero and the rails at zero, so it writes no row", (() => {
        const names = f1.map((f) => f.check_name);
        return f1.length === 0 && !names.includes("gateway_line_total")
          && !names.includes("payment_stale");
      })(), f1.map((f) => [f.check_name, f.subject_ref, f.book_figure, f.paper_figure]));
    const CHARGE = randomUUID();
    await okDo("a charge the office is holding open is planted on the quiet day",
      `insert into payments (id, tenant_id, provider, intent_reference, amount, currency, status,
         idempotency_key, requested_at)
       values ($1,$2,$3,$4,$5,'TZS','pending',$6, $7::timestamptz)`,
      [CHARGE, CO, RAIL, `${STAMP}-STALE`, "150000.00", `idem-${STAMP}-stale`,
        `${D}T09:00:00`]);
    const r2 = await counted("the office counts the gateway again", "gateway", "TZS", D, D);
    const f2 = r2?.run?.id ? await fnd(r2.run.id) : [];
    const stale = f2.find((f) => f.check_name === "payment_stale");
    check("a charge left pending past the ten minutes the customer was promised is named by id and "
      + "figure: `payment_stale` puts the book at zero and the paper at the money still owed",
      !!stale && stale.subject_kind === "payment" && String(stale.subject_id) === CHARGE
      && stale.subject_ref === `${STAMP}-STALE`
      && Number(stale.paper_figure) === 150000 && Number(stale.book_figure) === 0
      && Number(stale.difference) === -150000 && stale.verdict === "stale"
      && stale.detail.provider === RAIL && /stood pending/.test(stale.detail.why)
      && /past the ten minutes the customer was promised/.test(stale.detail.why)
      && stale.detail.tenant === (await one("select name from tenants where id = $1", [CO]))?.name,
      stale);
    const leg = await plant("the gateway line is given a figure by hand", OF, PEN, D,
      [["GATE", "debit", "250000.00"], ["BANK", "credit", "250000.00"]],
      { memo: `Recon Gate ${STAMP} a receipt nobody booked`, kind: "fee" });
    const r3 = await counted("the office counts the gateway a third time", "gateway", "TZS", D, D);
    const f3 = r3?.run?.id ? await fnd(r3.run.id) : [];
    const line = f3.find((f) => f.check_name === "gateway_line_total");
    check("and the gateway line against the rails' money is the one exception the office cannot "
      + "answer by fixing a row: the line holds the money and the rails confirmed none of it",
      !!line && !!leg && line.subject_kind === "gateway_line" && line.subject_ref === "GATE-WAIT"
      && Number(line.book_figure) === 250000 && Number(line.paper_figure) === 0
      && Number(line.difference) === 250000 && line.verdict === "differs"
      && /never been told about a licence payment/.test(line.detail.why)
      && line.detail.live_rail === RAIL, { line, leg });
    check("…and the other exception on the same paper is the stale charge, so one run reads both "
      + "halves of the rails' money", f3.length === 2 && f3.map((f) => f.check_name).sort()
      .join(",") === "gateway_line_total,payment_stale", f3.map((f) => f.check_name));
    const after = await one("select count(*)::int as n from payment_gateways where enabled");
    check("…and 135's switch is a single rail: one row enabled is all the desk can hold",
      after?.n === 1, after);
  });
  const stillOff = await one("select count(*)::int as n from payment_gateways where enabled");
  const gateBack = await one(`select coalesce(sum(case when e.direction = 'debit' then e.amount
      else -e.amount end), 0)::numeric(14,2) as net
    from money_entries e join money_accounts a on a.id = e.account_id
   where a.code = 'GATE-WAIT' and a.tenant_id = $1`, [OF]);
  check("the section put its own work away: no rail is switched on again, and the gateway line "
    + "holds nothing — the office's register is the one this file found",
    stillOff?.n === 0 && Number(gateBack?.net) === 0, { stillOff, gateBack });

  // ---------------- 5 · the two questions 136 rewrote ----------------
  phase("5 · the delivery questions, over one paper shape at a time on the quiet day");
  /** A delivery as 005's intake route wrote it. `event` is the word the rail named and `outcome` the
   *  word the route parsed into the payload, because 136's question is asked of that pair — so each
   *  half has to be plantable on its own to be proved on its own. */
  const R = (s: string) => `${STAMP}-${s}`;
  let nWire = 0, nCharge = 0, nDrive = 0;
  const send = async (tag: string, o: { ref?: string; event?: string; outcome?: string;
    noRef?: boolean; valid?: boolean; done?: boolean; error?: string; at?: string;
    nonce?: string } = {}) => {
    nWire++;
    const payload: Record<string, any> = o.noRef ? { provider: RAIL }
      : { provider: RAIL, reference: o.ref ?? "" };
    if (o.outcome) payload.outcome = o.outcome;
    const rows = await okDo(`a delivery ${tag} is planted`, `insert into payment_webhooks
        (id, provider, event_type, signature_valid, replay_nonce, payload, processed_at,
         processing_error, created_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8,$9::timestamptz) returning id`,
      [randomUUID(), RAIL, o.event ?? "approved", o.valid !== false,
        o.nonce ?? `${STAMP}-w${nWire}`, JSON.stringify(payload),
        o.done ? `${D}T12:00:00` : null, o.error ?? null, `${D}T${o.at ?? "10:00"}:00`]);
    return rows.length ? { id: rows[0].id, ref: o.ref ?? "" } : null;
  };
  /** The charge the delivery names, in whichever state the shape needs. It belongs to a company rather
   *  than to the office, exactly as a rail's charge does: 136's two questions join the delivery pile
   *  to the charge pile and bind neither to `p_tenant`. `cur` is the reason 138 exists — the register
   *  takes both moneys, the rails only ever push TZS, and a shape that cannot plant a USD charge
   *  cannot show which way the count went wrong. */
  const charge = async (tag: string, ref: string, status: string, amount = "150000.00",
    cur = "TZS") => {
    nCharge++;
    const rows = await okDo(`a ${cur} charge ${tag} is planted`, `insert into payments
        (id, tenant_id, provider, intent_reference, amount, currency, status, idempotency_key,
         requested_at, completed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz) returning id`,
      [randomUUID(), CO, RAIL, ref, amount, cur, status, `idem-${STAMP}-c${nCharge}`,
        `${D}T09:30:00`, status === "pending" ? null : `${D}T10:30:00`]);
    return rows.length ? rows[0].id : null;
  };
  /** The attempt ledger, filled by hand. 135's own retry door is the honest writer, but it stops at
   *  five presses only after five real completions behind it, and the count asks only how many rows a
   *  delivery carries — so rows are what the shape needs. They are dated on the quiet day so the run's
   *  own `attempts` population counts them too. */
  const drove = async (tag: string, webhook: string, times = 5) => {
    for (let i = 1; i <= times; i++) {
      nDrive++;
      await okDo(`…and drive ${i} of ${tag} is written`, `insert into gateway_webhook_attempts
          (id, tenant_id, webhook_id, attempt, outcome, intent_reference, payment_status,
           message, answer, acted_by, acted_role, ip, created_at)
         values ($1,$2,$3,$4,'failed',$5,'pending',$6,'{}'::jsonb,$7,'finance_officer','10.0.0.9',
           $8::timestamptz)`,
        [randomUUID(), OF, webhook, i, tag,
          `Recon Gate ${STAMP} the desk re-drove this delivery and the rail did not answer`,
          PEN, `${D}T10:0${i}:00`]);
    }
  };
  /** One shape of papers, one count over the quiet day, then the savepoint is rolled back so the next
   *  shape's day holds only its own rows. Every shape is asked the same four questions, so a shape
   *  that produces no exception is a proved absence rather than a question that was skipped — which is
   *  the distinction the whole of 136 was written to make. `cur` asks the same papers in the other
   *  money, and then the sentence the run owes the seat is a different one: with no rail switched on,
   *  a TZS count explains itself by the switch and a USD count by the money. */
  const shape = async (label: string, plant: () => Promise<any>, want: string[],
    assert?: (rows: Record<string, any>[], r: any, h: any) => void, cur = "TZS") => {
    let out: Record<string, any> = {};
    const w0 = nWire, d0 = nDrive;
    const skipSaid = cur === "TZS" ? /no rail is switched on/ : /were asked of USD charges only/;
    /** What an empty list means depends on which file the shape is asking about: a TZS shape that
     *  raises nothing is 136's claim about an answered delivery, and a USD shape that raises nothing is
     *  138's claim about another money's figure. Both are proved by the same four questions having been
     *  asked, which is the part above them. */
    const nothing = cur === "TZS"
      ? " — which is 136's claim: a delivery the office has acted on is not reported as one it ignored"
      : " — which is 138's claim: a charge written in the other money is not a figure in this run's sum";
    await undo(`the "${label}" papers, counted in ${cur}`, async () => {
      const h = await plant();
      const r = await counted(`the office counts the gateway over ${label} in ${cur}`,
        "gateway", cur, D, D);
      const rows = r?.run?.id ? await fnd(r.run.id) : [];
      const ex = r?.run?.examined ?? {};
      check(`${label}: the four delivery questions are asked of ${nWire - w0} delivery(ies) and `
        + `${nDrive - d0} attempt(s) and ${want.length} exception(s) come back${want.length
          ? `: ${[...new Set(want)].join(", ")}` : nothing}`,
        r?.ok === true && r?.run?.checks === Q.gate.length
        && same(ex.questions ?? [], [...Q.gate].sort())
        && same(rows.map((f) => f.check_name), want) && r?.run?.findings === want.length
        && ex.deliveries === nWire - w0 && ex.attempts === nDrive - d0
        && ex.payments === undefined && !ex.wallets
        && (ex.skipped ?? []).some((s: string) => skipSaid.test(s))
        && Number(r?.run?.net_difference) === rows.reduce((a, f) => a + Number(f.difference), 0),
        { got: rows.map((f) => [f.line, f.check_name, f.subject_ref]), want,
          checks: r?.run?.checks, findings: r?.run?.findings, ex,
          net: r?.run?.net_difference });
      if (assert) assert(rows, r, h);
      out = { rows, r, h };
    });
    return out;
  };

  const s1 = await shape("a stuck delivery whose charge is still open", async () => {
    const ref = R("LAND1");
    const w = await send("the stuck one", { ref, event: "approved", outcome: "approved" });
    await charge("the open one", ref, "pending");
    return { w, ref };
  }, ["webhook_not_landed"], (rows, r, h) => {
    const f = rows[0] ?? {};
    check("…and it is the charge that says so: the delivery is a fact on the day, the book holds "
      + "nothing behind it and the paper still holds the money, so the exception's figure is the "
      + "whole charge",
      f.subject_kind === "webhook" && String(f.subject_id) === String(h.w?.id)
      && f.subject_ref === h.ref && Number(f.book_figure) === 0
      && Number(f.paper_figure) === 150000 && Number(f.difference) === -150000
      && f.verdict === "missing_book" && Number(r?.run?.net_difference) === -150000
      && f.detail?.outcome_wanted === "approved" && f.detail?.payment_status === "pending"
      && f.detail?.provider === RAIL && f.detail?.event === "approved"
      && Number(f.detail?.attempts) === 0 && f.detail?.error === null, f);
    check("…and the sentence is the whole account in the door's own words: the delivery's moment, "
      + "that no reason was recorded for it, and the charge's reference, state and figure read off "
      + "the row rather than typed beside it",
      /A verified delivery reached the platform on [0-9-]{10} [0-9]{2}:[0-9]{2}/.test(f.detail?.why)
      && String(f.detail?.why).includes("and its answer is not on the charge it names and no reason "
        + "was recorded — the write of the outcome itself failed.")
      && String(f.detail?.why).includes(`${h.ref} is pending for 150000.00 TZS`)
      && /so the money the rail says arrived has never settled into the book\.$/.test(f.detail?.why),
      f.detail?.why);
  });
  check("…which is the exception 135 raised for every unanswered delivery: the row it names is the "
    + "one thing that can still say whether the office acted on it",
    s1.rows?.length === 1 && s1.rows[0].check_name === "webhook_not_landed", s1.rows);

  const s2 = await shape("the same delivery over a charge that already says approved", async () => {
    const ref = R("LAND2");
    const w = await send("the landed one", { ref, event: "approved", outcome: "approved" });
    await charge("the closed one", ref, "approved");
    return { w, ref };
  }, [], (rows, r) => {
    check("…and the delivery is still counted as a population the run looked at, so the empty list "
      + "is the answer and not an unasked question — 135 raised `webhook_not_landed` here, because a "
      + "delivery keeps `processed_at` null for its whole life and only the charge had ever changed",
      Number(r?.run?.examined?.deliveries) === 1 && rows.length === 0
      && r?.run?.findings === 0 && Number(r?.run?.net_difference) === 0,
      { ex: r?.run?.examined, rows });
  });
  note("the last two shapes are 136's whole reason for existing: the same delivery, the same null "
    + "`processed_at`, and a report that calls it acted on only when the charge says so.");

  await shape("a delivery that asked for failed over a charge the office approved", async () => {
    const ref = R("DISAGREE");
    const w = await send("the disagreeing one", { ref, event: "failed" });
    await charge("the approved one", ref, "approved");
    return { w, ref };
  }, ["webhook_not_landed"], (rows) => {
    const f = rows[0] ?? {};
    check("…and the worse finding gets its own sentence rather than the false one: the rail and the "
      + "register hold opposite words about one charge, so the report says which two they are",
      f.verdict === "missing_book" && f.detail?.outcome_wanted === "failed"
      && f.detail?.payment_status === "approved"
      && String(f.detail?.why).includes("while the delivery asked for failed.")
      && String(f.detail?.why).includes("The rail and the office's own register disagree about "
        + "this charge, and one of them is wrong.")
      && /has never settled into the book\./.test(String(f.detail?.why)) === false, f.detail);
  });

  await shape("the word the rail named winning over the word in the payload", async () => {
    const ref = R("PRIORITY");
    const w = await send("the two-worded one", { ref, event: "approved", outcome: "failed" });
    await charge("the open one", ref, "pending");
    return { w, ref };
  }, ["webhook_not_landed"], (rows) => {
    check("…and a final word on the delivery itself is the answer, whatever the payload also "
      + "carried: the door reads `event_type` first because that is the column the intake route "
      + "verified, and the payload's word is only the fallback",
      rows[0]?.detail?.outcome_wanted === "approved"
      && /never settled into the book\.$/.test(String(rows[0]?.detail?.why))
      && !String(rows[0]?.detail?.why).includes("asked for failed"), rows[0]?.detail);
  });

  await shape("a rail that names no final state, so the payload answers", async () => {
    const ref = R("FALLBACK");
    const w = await send("the unnamed one", { ref, event: "received", outcome: "approved" });
    await charge("the closed one", ref, "approved");
    return { w, ref };
  }, [], (rows, r) => {
    check("…and the fallback reads the payload: 005's intake writes `event_type = event ?? outcome`, "
      + "so a rail that never named a final state still lands its word here and the charge agrees "
      + "with it", Number(r?.run?.examined?.deliveries) === 1 && rows.length === 0, rows);
  });

  await shape("a delivery whose reference belongs to no charge", async () => {
    const ref = R("ORPHAN");
    const w = await send("the orphan", { ref, event: "approved" });
    return { w, ref };
  }, ["webhook_orphan"], (rows, r, h) => {
    const f = rows[0] ?? {};
    check("…and only the orphan line is raised, because 136's join onto the charge is inner on "
      + "purpose: a delivery that names nothing is one finding a seat can act on, not two",
      f.subject_kind === "webhook" && String(f.subject_id) === String(h?.w?.id)
      && f.subject_ref === h?.ref && Number(f.book_figure) === 0
      && Number(f.paper_figure) === 0 && Number(f.difference) === 0
      && f.verdict === "missing_paper" && f.detail?.payload_ref === h?.ref
      && String(f.detail?.why).includes(`names ${h?.ref}, which is not a charge this platform `
        + "has ever raised. A rail does not invent a reference it never pushed."), f);
    check("…and an orphan costs the book nothing: the run holds one exception and a net difference "
      + "of zero, which is the pair the register's own CHECK lets stand",
      r?.run?.findings === 1 && Number(r?.run?.net_difference) === 0,
      { findings: r?.run?.findings, net: r?.run?.net_difference });
  });

  await shape("a delivery that carries no reference at all", async () => {
    const w = await send("the blank one", { noRef: true, event: "approved" });
    return { w };
  }, ["webhook_orphan"], (rows) => {
    const f = rows[0] ?? {};
    check("…and the row is named by its rail rather than by a reference that is not there, because "
      + "a seat reading the board has to be told which rail pushed a blank",
      f.subject_ref === `${RAIL} no reference` && f.detail?.payload_ref === ""
      && f.verdict === "missing_paper"
      && /carries no reference at all, so there is nothing here for a seat to re-drive\./.test(
        String(f.detail?.why)), f);
  });

  const s8 = await shape("five drives and the charge still open", async () => {
    const ref = R("SPENT1");
    const w = await send("the driven one", { ref, event: "approved", outcome: "approved" });
    await charge("the open one", ref, "pending");
    await drove(ref, w.id);
    return { w, ref };
  }, ["webhook_not_landed", "webhook_retries_spent"], (rows, r, h) => {
    const [a, b] = rows;
    check("…and the two questions are asked of one delivery without cancelling each other: the first "
      + "says the money never settled, the second says the desk cannot try again",
      a?.check_name === "webhook_not_landed" && Number(a?.detail?.attempts) === 5
      && b?.check_name === "webhook_retries_spent" && b?.line === 2
      && String(b?.subject_id) === String(h?.w?.id) && b?.subject_ref === h?.ref
      && b?.verdict === "stale" && Number(b?.paper_figure) === 150000
      && Number(b?.difference) === -150000 && Number(r?.run?.net_difference) === -300000,
      rows.map((f) => [f.line, f.check_name, f.difference]));
    check("…and the spent ceiling is stated with its own evidence — five presses, the fifth's moment, "
      + "the charge's word and the reference — so the next seat does not press the button again",
      b?.detail?.attempts === 5 && b?.detail?.payment_status === "pending"
      && b?.detail?.outcome_wanted === "approved" && b?.detail?.provider === RAIL
      && String(b?.detail?.last_attempt_at).startsWith(D)
      && String(b?.detail?.why).startsWith(`This delivery has been re-driven 5 times, last on `
        + `${D} 10:05, and the charge ${h?.ref} is still pending.`)
      && String(b?.detail?.why).includes("Five attempts is the ceiling, so the next answer has to "
        + "come from the rail, not from the desk."), b?.detail);
  });

  await shape("five drives and the licence landed", async () => {
    const ref = R("SPENT2");
    const w = await send("the answered one", { ref, event: "approved", outcome: "approved" });
    await charge("the closed one", ref, "approved");
    await drove(ref, w.id);
    return { w, ref };
  }, [], (rows, r) => {
    check("…and five presses that ended with the money confirmed are not an exception at all: a "
      + "line about them would carry money the office already has into the run's net difference as "
      + "though it were still missing", Number(r?.run?.examined?.attempts) === 5
      && rows.length === 0 && Number(r?.run?.net_difference) === 0,
      { attempts: r?.run?.examined?.attempts, rows });
  });

  await shape("a delivery the platform already answered", async () => {
    const ref = R("PROCESSED");
    const w = await send("the processed one", { ref, event: "approved", done: true });
    await charge("the open one", ref, "pending");
    await drove(ref, w.id);
    return { w, ref };
  }, [], (rows, r) => {
    check("…and `processed_at` set is the door's own excuse for both questions: this is the shape a "
      + "re-driven delivery that recorded its answer leaves behind, and neither line is raised over "
      + "it even though the charge is still open",
      Number(r?.run?.examined?.deliveries) === 1 && rows.length === 0, rows);
  });

  await shape("a delivery signed with a key that is not the rail's", async () => {
    const ref = R("UNVERIFIED");
    const w = await send("the refused one", { ref, event: "approved", valid: false,
      nonce: `${STAMP}-knock` });
    await charge("the open one", ref, "pending");
    return { w, ref };
  }, ["webhook_unverified"], (rows) => {
    const f = rows[0] ?? {};
    check("…and an unverified delivery is kept as a fact about the rail, not as money: it answers no "
      + "question about a charge, because nothing it said was ever trusted",
      f.subject_kind === "webhook" && f.subject_ref === R("UNVERIFIED")
      && Number(f.book_figure) === 0 && Number(f.paper_figure) === 0
      && f.verdict === "refused" && f.detail?.nonce === `${STAMP}-knock`
      && f.detail?.provider === RAIL && f.detail?.event === "approved"
      && /was signed with a key that is not this rail's, so nothing was completed from it/.test(
        String(f.detail?.why))
      && String(f.detail?.why).includes("It is approved and it is kept here because a pile of them "
        + "is somebody knocking."), f);
  });

  await shape("twenty-six of them from one rail in a day", async () => {
    const refs: string[] = [];
    for (let i = 1; i <= 26; i++) {
      const ref = R(`KNOCK${i}`);
      refs.push(ref);
      await send(`the ${i}th knock`, { ref, event: "received", valid: false, at: `10:${String(i - 1).padStart(2, "0")}` });
    }
    return { refs };
  }, Array(26).fill("webhook_unverified"), (rows, r, h) => {
    const list = rows.filter((f) => f.subject_kind === "webhook");
    const many = rows.find((f) => f.subject_kind === "many");
    check("…and a page of them is listed while the rest are counted rather than dropped: 25 rows on "
      + "the report and one line saying how many more there were",
      list.length === 25 && !!many && many.subject_id === null
      && many.subject_ref === RAIL && many.verdict === "refused"
      && Number(many.detail?.exceptions) === 26 && rows.length === 26
      && r?.run?.findings === 26, { list: list.length, many });
    check("…and the one left off the list is the earliest, because the door ranks by arrival and "
      + "keeps the newest twenty-five — a pile that stopped growing would otherwise be shown as the "
      + "pile that is still growing",
      same(list.map((f) => f.subject_ref), h?.refs?.slice(1) ?? [])
      && /26 unverified deliveries from mpesa in these days/.test(String(many?.detail?.why))
      && /The newest 25 are listed and these 1 more are not\./.test(String(many?.detail?.why)),
      { missing: (h?.refs ?? []).filter((x: string) => !list.some((f) => f.subject_ref === x)) });
  });

  await shape("five drives on a delivery that names no charge", async () => {
    const ref = R("SPENT3");
    const w = await send("the driven orphan", { ref, event: "approved" });
    await drove(ref, w.id);
    return { w, ref };
  }, ["webhook_orphan", "webhook_retries_spent"], (rows) => {
    const b = rows.find((f) => f.check_name === "webhook_retries_spent") ?? {};
    check("…and the spent ceiling keeps its left join, because an orphan that has run out of presses "
      + "is exactly the delivery a seat must take to the rail: the charge is named as missing rather "
      + "than as zero",
      b.verdict === "stale" && Number(b.paper_figure) === 0
      && b.detail?.payment_status === null && Number(b.detail?.attempts) === 5
      && String(b.detail?.why).includes(`and the charge it names is still not ours to find.`)
      && rows.some((f) => f.check_name === "webhook_orphan")
      && !rows.some((f) => f.check_name === "webhook_not_landed"),
      rows.map((f) => [f.check_name, f.paper_figure]));
  });

  await shape("a delivery that recorded why its own write failed", async () => {
    const ref = R("REASON");
    const err = "the rails' answer could not be read as money";
    const w = await send("the explained one", { ref, event: "approved", error: err });
    await charge("the open one", ref, "pending");
    return { w, ref, err };
  }, ["webhook_not_landed"], (rows, r, h) => {
    const f = rows[0] ?? {};
    check("…and a recorded reason is quoted into the sentence instead of the claim that none was: a "
      + "seat reading the report is told what the intake actually caught",
      f.detail?.error === h?.err && /no reason was recorded/.test(String(f.detail?.why)) === false
      && String(f.detail?.why).includes(`charge it names: ${h?.err}. ${h?.ref} is pending for`),
      { why: f.detail?.why, error: f.detail?.error });
  });

  /** One pile, counted in both moneys. This shape is the defect a seat found at the desk: a USD
   *  gateway count over a delivery that names a TZS charge still open, and the run reported the TZS
   *  charge's figure as a USD difference. So the pile is counted twice through 138's door — once in
   *  each money — and then 136's body is put back on the shelf inside this same savepoint and the pile
   *  counted a third time. The wrong sum has to be reproducible on the catalog, not quoted from a
   *  discarded run: 138's claim is that a bind on the charge's own money is what was missing, and the
   *  only proof of that is the same papers answering differently before and after it. */
  let cross: Record<string, any> = {};
  await undo("one pile counted in two moneys", async () => {
    const ref = R("CROSS1");
    await send("the crossed one", { ref, event: "approved", outcome: "approved" });
    await charge("the TZS one", ref, "pending", "180000.00", "TZS");
    const tz = await counted("the office counts the crossed pile in the rails' own money",
      "gateway", "TZS", D, D);
    const us = await counted("…and the same pile again, counted in the other money",
      "gateway", "USD", D, D);
    const tzRows = tz?.run?.id ? await fnd(tz.run.id) : [];
    const usRows = us?.run?.id ? await fnd(us.run.id) : [];
    check("the TZS count still raises it, because 138 binds the charge's money rather than excluding "
      + "the shape: one exception, the whole charge, named in the money the charge is written in",
      tz?.ok === true && same(tzRows.map((f) => f.check_name), ["webhook_not_landed"])
      && Number(tzRows[0]?.paper_figure) === 180000
      && Number(tzRows[0]?.difference) === -180000
      && String(tzRows[0]?.detail?.why).includes(`${ref} is pending for 180000.00 TZS`)
      && Number(tz?.run?.net_difference) === -180000 && tz?.run?.currency === "TZS",
      { rows: tzRows.map((f) => [f.check_name, f.paper_figure, f.difference]),
        net: tz?.run?.net_difference });
    check("…and the USD count of the very same papers asks its four questions, looks at the same "
      + "single delivery and brings nothing back: the charge is not in its money, so there is no "
      + "figure here for it to borrow",
      us?.ok === true && us?.run?.checks === Q.gate.length
      && same(us?.run?.examined?.questions ?? [], [...Q.gate].sort())
      && usRows.length === 0 && us?.run?.findings === 0
      && Number(us?.run?.net_difference) === 0 && us?.run?.currency === "USD"
      && Number(us?.run?.examined?.deliveries) === 1
      && us?.run?.examined?.payments === undefined
      && (us?.run?.examined?.skipped ?? []).some((s: string) =>
        /were asked of USD charges only/.test(s)),
      { rows: usRows, ex: us?.run?.examined, net: us?.run?.net_difference });
    await okDo("136's door is put back on the shelf for one count", fixDdl[0]);
    const old = await counted("…and the same pile counted through the door that let the figure in",
      "gateway", "USD", D, D);
    const oldRows = old?.run?.id ? await fnd(old.run.id) : [];
    check("…and 136's body really did answer with the borrowed money — a USD run, a line carrying "
      + "180000.00 read off a TZS charge, and a net difference filed as USD that is not: this is the "
      + "run the desk discarded, raised again inside a savepoint so the number is proved rather than "
      + "remembered",
      old?.ok === true && same(oldRows.map((f) => f.check_name), ["webhook_not_landed"])
      && old?.run?.currency === "USD" && Number(oldRows[0]?.paper_figure) === 180000
      && Number(oldRows[0]?.difference) === -180000
      && Number(old?.run?.net_difference) === -180000
      && String(oldRows[0]?.detail?.why).includes("180000.00 TZS")
      && (old?.run?.examined?.skipped ?? []).every((s: string) =>
        !/were asked of USD charges only/.test(s)),
      { rows: oldRows.map((f) => [f.check_name, f.paper_figure, f.difference]),
        net: old?.run?.net_difference, cur: old?.run?.currency, ex: old?.run?.examined });
    cross = { tz, us, old };
  });
  /** Asked outside the savepoint, because the point is that the replay is gone: a body put back on the
   *  shelf for one count is a catalog change, and the only honest test of it is what the catalog holds
   *  after the rollback. The pile itself went back with the savepoint, so the proof is read off
   *  `pg_get_functiondef` rather than from a fourth count. */
  const doorBack = await one(`select regexp_replace(pg_get_functiondef(
      'platform_auth.run_money_reconciliation(uuid,text,text,date,date,uuid,text,text,text)'
      ::regprocedure), '\\s+', ' ', 'g') as body`);
  check("…and the savepoint took 136's body back with it: the door the platform runs again binds the "
    + "charge's money in both of the delivery questions, so nothing this section proved is left "
    + "sitting in the catalog for the phases after it",
    doorBack?.body?.includes("and pay.currency = v_cur")
    && doorBack?.body?.includes("and coalesce(pay.currency, v_cur) = v_cur")
    && doorBack?.body?.includes("were asked of USD charges only"),
    (doorBack?.body ?? "").slice(0, 120));
  note(`the crossed pile is ${cross?.us?.run?.ref}: counted in USD it holds `
    + `${cross?.us?.run?.findings ?? "?"} exception(s) and a net of `
    + `${cross?.us?.run?.net_difference}; through 136's body, the same papers on the same day held `
    + `${cross?.old?.run?.findings ?? "?"} and a net of ${cross?.old?.run?.net_difference}.`);

  await shape("a USD charge the rails never answered, counted in its own money", async () => {
    const ref = R("USDLAND");
    const w = await send("the USD one", { ref, event: "approved", outcome: "approved" });
    await charge("the USD open one", ref, "pending", "250.00", "USD");
    return { w, ref };
  }, ["webhook_not_landed"], (rows, r, h) => {
    const f = rows[0] ?? {};
    check("…and a charge that IS in the run's money is still raised, with the same figure and the "
      + "same sentence: the bind excludes another money's rows, not the question",
      Number(f.paper_figure) === 250 && Number(f.difference) === -250
      && Number(r?.run?.net_difference) === -250 && f.verdict === "missing_book"
      && String(f.detail?.why).includes(`${h?.ref} is pending for 250.00 USD`), f);
  }, "USD");

  await shape("five drives over a TZS charge, counted in the other money", async () => {
    const ref = R("USDSPENT");
    const w = await send("the driven USD-counted one", { ref, event: "approved",
      outcome: "approved" });
    await charge("the TZS open one", ref, "pending", "150000.00", "TZS");
    await drove(ref, w.id);
    return { w, ref };
  }, [], (rows, r) => {
    check("…and the ceiling question keeps its five presses in view without carrying their charge's "
      + "TZS figure into a USD sum: five attempts counted, nothing raised, the difference zero",
      Number(r?.run?.examined?.attempts) === 5 && rows.length === 0
      && r?.run?.findings === 0 && Number(r?.run?.net_difference) === 0,
      { ex: r?.run?.examined, rows });
  }, "USD");

  await shape("five drives on a delivery that names no charge, counted in the other money",
    async () => {
      const ref = R("USDORPHAN");
      const w = await send("the driven USD-counted orphan", { ref, event: "approved" });
      await drove(ref, w.id);
      return { w, ref };
    }, ["webhook_orphan", "webhook_retries_spent"], (rows, r) => {
      const b = rows.find((f) => f.check_name === "webhook_retries_spent") ?? {};
      check("…and a charge that is absent is not read as another money's charge: the guard coalesces "
        + "the missing row onto the run's own money rather than dropping the line, so the seat whose "
        + "five presses are spent still gets told",
        b.verdict === "stale" && Number(b.paper_figure) === 0
        && b.detail?.payment_status === null && Number(b.detail?.attempts) === 5
        && Number(r?.run?.net_difference) === 0,
        rows.map((f) => [f.check_name, f.paper_figure, f.verdict]));
    }, "USD");

  await shape("the two money-free questions, counted in the other money", async () => {
    const ref = R("USDFREE");
    await send("the refused USD-counted one", { ref, event: "approved", valid: false,
      nonce: `${STAMP}-usdfree` });
    await send("the blank USD-counted one", { noRef: true, event: "approved" });
    return { ref };
  }, ["webhook_unverified", "webhook_orphan"], (rows) => {
    check("…and neither of them is bound by money, because neither reads a figure: a signature that "
      + "did not verify and a delivery that names no charge are facts about the rail in either "
      + "currency", same(rows.map((f) => f.check_name), ["webhook_unverified", "webhook_orphan"])
      && rows.every((f) => Number(f.paper_figure) === 0 && Number(f.book_figure) === 0),
      rows.map((f) => [f.check_name, f.paper_figure]));
  }, "USD");

  const left5 = await one(`select (select count(*)::int from payment_webhooks
        where created_at::date = $1::date) as wires,
      (select count(*)::int from gateway_webhook_attempts
        where created_at::date = $1::date) as drives,
      (select count(*)::int from payments where requested_at::date = $1::date) as charges`, [D]);
  check("phase 5 put every paper it planted away again: the quiet day is quiet, so the phases after "
    + "it count the same empties this one started from",
    left5?.wires === 0 && left5?.drives === 0 && left5?.charges === 0, left5);

  // ---------------- 6 · the book's own sentences ----------------
  phase("6 · the book, the wallet lines, the escrow line and the payable line, in order and broken");
  /** Why this phase has to exist. 133 keeps its balance rule as a DEFERRED constraint trigger, so an
   *  unbalanced movement is refused at commit and no book the doors wrote can ever show `posting_square`
   *  or `book_sums_to_zero` — and if every movement balances, the whole book nets to nothing. The two
   *  questions are therefore reachable only below that trigger: a restore, a hand-write in a session, or
   *  a later migration that drops it. A gate that never planted them would be reading a clean book it had
   *  only ever seen through the doors, which is the opposite of what a report is for. So the shapes are
   *  planted, counted, read and rolled back — inside a transaction that never commits. */
  note("the two book questions are planted below 133's deferred balance trigger, which would refuse "
    + "them at commit; this transaction never commits, so the sentences are reachable and the shapes "
    + "are rolled back after being read.");
  const refOf = async (id: string) => (await one("select ref from money_postings where id = $1", [id]))
    ?.ref as string;
  /** The office's own chart has six lines. Every `accounts` population asserted below is built from
   *  this number rather than typed, because the gate opened those six itself. */
  const OF_LINES = Object.keys(ACC).filter((k) => k !== "BANK2").length;
  const legNames = (rows: Record<string, any>[]) => rows.map((f) => f.check_name).sort().join(",");
  /** A finding by the paper it is about. The door orders a run's lines by question, so a phase that
   *  wants one of three movements has to look it up rather than count down from the top. */
  const by = (rows: Record<string, any>[], ref: any) =>
    rows.find((f) => f.subject_ref === ref) ?? {};

  await undo("the book that is in order", async () => {
    const id = await plant("a movement with both sides is booked", OF, PEN, D,
      [["BANK", "debit", "500000.00"], ["DUE", "credit", "500000.00"]]);
    const r = await counted("the office counts its own book", "book", "TZS", D, D);
    const rows = r?.run?.id ? await fnd(r.run.id) : [];
    check("a book whose every movement has two sides, whose headers match their legs and whose lines "
      + "match their triggers writes nothing — and the run prints the three populations it just "
      + "proved: one movement, two legs, the whole chart",
      r?.ok === true && rows.length === 0 && !!id
      && r?.run?.findings === 0 && r?.run?.checks === Q.book.length
      && Number(r?.run?.net_difference) === 0
      && r?.run?.examined?.postings === 1 && r?.run?.examined?.legs === 2
      && r?.run?.examined?.accounts === OF_LINES && !r?.run?.examined?.wallets
      && same(r?.run?.examined?.questions ?? [], Q.book), { rows, ex: r?.run?.examined });
  });

  const SQUARE = "book_sums_to_zero,posting_square";
  await undo("two half-written movements on two different days", async () => {
    const inside = await plant("a movement with only its debit, on the day", OF, PEN, D,
      [["BANK", "debit", "100000.00"]]);
    const outside = await plant("a movement with only its debit, three weeks back", OF, PEN, OPEN_DAY,
      [["BANK", "debit", "250000.00"]]);
    const inRef = inside ? await refOf(inside) : "";
    const outRef = outside ? await refOf(outside) : "";
    const tight = await counted("the office counts the day", "book", "TZS", D, D);
    const tRows = tight?.run?.id ? await fnd(tight.run.id) : [];
    check("one window of one day names one of them: `posting_square` is bounded by the days asked "
      + "about, so a movement outside the window is not this count's business",
      legNames(tRows) === SQUARE && tRows.length === 2 && tRows[0]?.check_name === "book_sums_to_zero"
      && tRows[1]?.check_name === "posting_square" && tRows[1].subject_ref === inRef
      && tRows[1].subject_kind === "posting" && String(tRows[1].subject_id) === String(inside)
      && String(tRows[1].detail?.why).startsWith(
        `${inRef} of ${D} says it moved 100000.00 and carries 1 leg(s): 100000.00 out, 0.00 in. `
        + "A movement needs both sides, so this one is half-written.")
      && !tRows.some((f) => f.subject_ref === outRef), tRows);
    check("…while the sum of the whole book is not bounded at all: 350000.00 is unaccounted for on "
      + "the day's count too, and the sentence says two legs while the window population printed "
      + "beside it says one. A register check is a whole fact about the book, not a fact about the "
      + "days a seat happened to ask about",
      Number(tRows[0]?.book_figure) === 350000 && Number(tRows[0]?.paper_figure) === 0
      && Number(tRows[0]?.difference) === 350000 && tRows[0]?.subject_kind === "book"
      && tRows[0]?.subject_id === null && tRows[0]?.subject_ref === null
      && tRows[0]?.verdict === "differs" && tRows[0]?.detail?.legs === 2
      && tight?.run?.examined?.legs === 1 && tight?.run?.examined?.postings === 1
      && /The TZS book carries 350000\.00 debited against 0\.00 credited over 2 leg\(s\)/.test(
        String(tRows[0]?.detail?.why))
      && /350000\.00 is unaccounted for\./.test(String(tRows[0]?.detail?.why)), tRows[0]);
    check("…and the two figures the register check prints are the two sides themselves rather than "
      + "their difference, so a seat reads which way the book is wrong and not only by how much",
      Number(tight?.run?.net_difference) === 350000 && tRows.every((f) =>
        Number(f.difference) === Number(f.book_figure) - Number(f.paper_figure)),
      { net: tight?.run?.net_difference, rows: tRows.map((f) => [f.book_figure, f.paper_figure,
        f.difference]) });
    const wide = await counted("the office counts the three weeks", "book", "TZS", OPEN_DAY, D);
    const wRows = wide?.run?.id ? await fnd(wide.run.id) : [];
    check("…widen the window to the day that movement was posted: both are named, the count of "
      + "exceptions moves with it and the window population now agrees with the sentence. The window "
      + "is a bound the door applies, not a filter the desk can forget",
      wRows.length === 3 && legNames(wRows) === "book_sums_to_zero,posting_square,posting_square"
      && same(wRows.filter((f) => f.check_name === "posting_square").map((f) => f.subject_ref),
        [inRef, outRef])
      && wide?.run?.examined?.postings === 2 && wide?.run?.examined?.legs === 2
      && wide?.run?.findings === 3, wRows.map((f) => f.subject_ref));
  });

  await undo("another company's half-written movement", async () => {
    const id = await plant("a half movement in the broken book", OB, BRUSH, D,
      [["BANK2", "debit", "100000.00"]]);
    if (!id) return;
    const ref = await refOf(id);
    const mine = await counted("the office counts its own book again", "book", "TZS", D, D);
    const mRows = mine?.run?.id ? await fnd(mine.run.id) : [];
    check("a movement broken in a different book does not appear in the office's count at all: the "
      + "two questions that read the book are bound to `p_tenant`, so a broken company's ledger "
      + "cannot be made this report's business — or hidden by it",
      mRows.length === 0 && mine?.run?.findings === 0
      && mine?.run?.examined?.postings === 0 && mine?.run?.examined?.legs === 0
      && mine?.run?.examined?.accounts === OF_LINES, { rows: mRows, ex: mine?.run?.examined });
    const wider = await counted("…and the office is asked over the three weeks that hold it",
      "book", "TZS", OPEN_DAY, D);
    const wRows = wider?.run?.id ? await fnd(wider.run.id) : [];
    check("…which is the half of that promise the day-window cannot make: the window here is wide "
      + "enough to have caught the other company's movement, and the count still comes back with "
      + "nothing, because the tenant predicate is on the leg's join and on the header alike rather "
      + "than only on the days",
      wRows.length === 0 && wider?.run?.findings === 0
      && wider?.run?.examined?.postings === 0, wRows.map((f) => f.subject_ref));
    const theirs = await counted("and the broken book is counted in its own name", "book", "TZS",
      D, D, OB, BRUSH);
    const tRows = theirs?.run?.id ? await fnd(theirs.run.id) : [];
    check("…while the same papers are found the moment the count is asked of the book they belong "
      + "to: the door's tenant is a switch, not a label, and the count is one chart line because "
      + "that is all the broken book has",
      legNames(tRows) === SQUARE && tRows[1]?.subject_ref === ref
      && Number(tRows[0]?.book_figure) === 100000 && Number(tRows[0]?.paper_figure) === 0
      && theirs?.run?.examined?.accounts === 1
      && Number(theirs?.run?.net_difference) === 100000, tRows);
  });

  await undo("each of the three accusations about one movement", async () => {
    const oneSide = await plant("a movement whose both legs are debits", OF, PEN, D,
      [["BANK", "debit", "200000.00"], ["COST", "debit", "100000.00"]]);
    const lying = await plant("a movement whose header overstates its own legs", OF, PEN, D,
      [["BANK", "debit", "300000.00"], ["DUE", "credit", "300000.00"]], { total: "999999.00" });
    const half = await plant("a movement with one side only", OF, PEN, D,
      [["DUE", "credit", "50000.00"]], { total: "50000.00" });
    const refs = { oneSide: oneSide && await refOf(oneSide), lying: lying && await refOf(lying),
      half: half && await refOf(half) };
    const r = await counted("the office counts a book of three broken movements", "book", "TZS", D, D);
    const rows = r?.run?.id ? await fnd(r.run.id) : [];
    const why = (ref: any) => String(by(rows, ref).detail?.why);
    check("three movements, three different accusations, one question: the door does not report a "
      + "movement as unbalanced but says which half of the picture is missing — and the book's own "
      + "sum rides above them, because 600000.00 left and 350000.00 arrived",
      rows.length === 4 && legNames(rows) === "book_sums_to_zero,posting_square,posting_square,"
      + "posting_square" && rows[0]?.check_name === "book_sums_to_zero"
      && Number(rows[0]?.book_figure) === 600000 && Number(rows[0]?.paper_figure) === 350000
      && rows[0]?.detail?.legs === 5
      && /carries 600000\.00 debited against 350000\.00 credited over 5 leg\(s\)/.test(
        String(rows[0]?.detail?.why))
      && /250000\.00 is unaccounted for\./.test(String(rows[0]?.detail?.why)),
      rows.map((f) => [f.check_name, f.book_figure, f.paper_figure]));
    check("…the two legs on one side are named as one side, with both figures and the leg count "
      + "carried in the sentence rather than only in the columns — and this is the case where the two "
      + "printed figures AGREE, because the header was copied from the debits: the accusation lives in "
      + "the sides, not in the pair, which is why the sentence is the finding and not the difference",
      /Every leg is on one side\./.test(why(refs.oneSide))
      && /300000\.00 out, 0\.00 in\./.test(why(refs.oneSide))
      && by(rows, refs.oneSide).detail?.legs === 2 && by(rows, refs.oneSide).detail?.credits === 0
      && Number(by(rows, refs.oneSide).book_figure) === 300000
      && Number(by(rows, refs.oneSide).paper_figure) === 300000
      && Number(by(rows, refs.oneSide).difference) === 0, by(rows, refs.oneSide));
    check("…a header that overstates its own legs is the fourth case, and the only one of the three "
      + "whose difference is a figure a seat can quote: the movement is not half-written, its number is",
      /The header's figure is not its own debits\./.test(why(refs.lying))
      && Number(by(rows, refs.lying).book_figure) === 999999
      && Number(by(rows, refs.lying).paper_figure) === 300000
      && Number(by(rows, refs.lying).difference) === 699999
      && by(rows, refs.lying).detail?.credits === 300000
      && by(rows, refs.lying).detail?.legs === 2, by(rows, refs.lying));
    check("…and a credit standing alone is the half-written movement again, printed with its memo, "
      + "its source and the day so a seat can find the paper it was typed on: 133 refuses a header of "
      + "zero, so this one says it moved 50000.00 while the sentence shows 0.00 out against 50000.00 "
      + "in — the figure on the header was copied from debits there are none of, and only the sides "
      + "say so",
      /A movement needs both sides, so this one is half-written\./.test(why(refs.half))
      && /says it moved 50000\.00 and carries 1 leg\(s\): 0\.00 out, 50000\.00 in/
        .test(why(refs.half))
      && by(rows, refs.half).detail?.legs === 1 && by(rows, refs.half).detail?.currency === "TZS"
      && by(rows, refs.half).detail?.source_kind === "manual" && !!by(rows, refs.half).detail?.memo
      && Number(by(rows, refs.half).book_figure) === 50000
      && Number(by(rows, refs.half).paper_figure) === 0
      && Number(by(rows, refs.half).difference) === 50000, by(rows, refs.half));
    check("…while the run's own net is the sum of the four differences and not the count of the four "
      + "accusations: 999999.00 is what the two columns say is missing, which is exactly the figure a "
      + "second seat is being asked to sign",
      Number(r?.run?.net_difference) === 999999 && Number(r?.run?.findings) === rows.length
      && rows.reduce((a, f) => a + Number(f.difference), 0) === 999999,
      { net: r?.run?.net_difference, diffs: rows.map((f) => f.difference) });
  });

  await undo("a line that stopped agreeing with its own legs", async () => {
    await plant("a movement that balances", OF, PEN, D,
      [["BANK", "debit", "500000.00"], ["DUE", "credit", "500000.00"]]);
    const clean = await counted("the office counts it once", "book", "TZS", D, D);
    const before = (clean?.run?.id ? await fnd(clean.run.id) : []).length;
    await okDo("and the cached figure on one line is moved by hand",
      `update money_accounts set debit_total = debit_total + 1000000 where id = $1`, [ACC.BANK?.id]);
    const r = await counted("the office counts the same book twice", "book", "TZS", D, D);
    const rows = r?.run?.id ? await fnd(r.run.id) : [];
    check("the same legs, the same window, one figure moved on the line itself: the third sentence "
      + "is the only one that reads the cache against the legs, so it fires where the other two stay "
      + "silent", before === 0 && rows.length === 1 && rows[0].check_name === "account_totals"
      && rows[0].subject_kind === "account" && rows[0].subject_ref === "OPS-BANK"
      && Number(rows[0].book_figure) === 1500000 && Number(rows[0].paper_figure) === 500000
      && Number(rows[0].difference) === 1000000 && rows[0].verdict === "differs", { before, rows });
    check("…and it prints the pair the trigger keeps against the pair the legs add up — cached and "
      + "recomputed, credit and count as well as debit, because all three are kept together. The "
      + "columns carry only the debits: without the sentence, a seat would be told the line is short "
      + "by 1000000.00 and would not know that the count and the credit side were untouched",
      /OPS-BANK \(Office bank \(TZS\)\) says 1500000\.00 debited and 0\.00 credited over 1 leg\(s\)/
        .test(String(rows[0]?.detail?.why))
      && /its own legs add up to 500000\.00 and 0\.00 over 1\./.test(String(rows[0]?.detail?.why))
      && String(rows[0]?.detail?.why).includes("The figures the register prints are kept by a "
        + "trigger, and this line has stopped agreeing with them.")
      && rows[0]?.detail?.label === "Office bank (TZS)" && rows[0]?.detail?.kind === "asset"
      && Number(rows[0]?.detail?.count_cached) === 1 && Number(rows[0]?.detail?.count_legs) === 1
      && Number(rows[0]?.detail?.credit_cached) === 0 && Number(rows[0]?.detail?.credit_legs) === 0,
      rows[0]?.detail);
  });

  const WALLET_SQL = `select platform_auth.open_money_wallet($1,$2,$3,$4,$5,$6,$7,$8) as r`;
  await undo("a holder's line paid below nothing", async () => {
    const opened = await call("a wallet is opened for the company through 134's own door", WALLET_SQL,
      [OF, CO, "TZS", `Recon Gate ${STAMP} a holder the office owes`, PEN, "finance_officer",
        "10.0.0.1", STAMP]);
    const w = opened?.wallet ?? null;
    if (!w?.account?.id) {
      check("134's wallet door answers with the holder's line under `wallet`", false, opened);
      return;
    }
    const code = String(w.account.code);
    const holder = String(w.holder);
    const clean = await counted("the office counts what it holds", "wallet", "TZS", D, D);
    const cRows = clean?.run?.id ? await fnd(clean.run.id) : [];
    check("an empty wallet line is a line in order: the three wallet questions are asked of it and "
      + "none of them finds anything, and the run prints one wallet behind one line — a `WLT-…` code "
      + "the door cut from the company's own id, which is why this gate could not have typed it",
      clean?.ok === true && cRows.length === 0 && clean?.run?.checks === Q.wallet.length
      && clean?.run?.examined?.wallets === 1 && clean?.run?.examined?.wallet_lines === 1
      && /^WLT-[0-9A-F]{8}-TZS$/.test(code) && w.account.kind === "liability"
      && holder === (await one("select name from tenants where id = $1", [CO]))?.name
      && !clean?.run?.examined?.accounts && !clean?.run?.examined?.postings, { clean: clean?.run, w });
    const over = await plant("money is paid out of the holder's line with nothing behind it",
      OF, PEN, D, [[w.account.id, "debit", "300000.00"]]);
    const r = await counted("the office counts what it holds again", "wallet", "TZS", D, D);
    const rows = r?.run?.id ? await fnd(r.run.id) : [];
    check("a holder's line paid below nothing is the office claiming a payment it cannot make: the "
      + "book figure is the negative net of the legs, the paper side is zero because no register "
      + "figure contradicts it, and the other two wallet questions stay silent — the line does have a "
      + "wallet behind it and the heading is clean",
      !!over && rows.length === 1 && rows[0].check_name === "wallet_overdrawn"
      && rows[0].subject_kind === "wallet" && String(rows[0].subject_id) === String(w.id)
      && rows[0].subject_ref === code && Number(rows[0].book_figure) === -300000
      && Number(rows[0].paper_figure) === 0 && Number(rows[0].difference) === -300000
      && rows[0].verdict === "differs" && Number(r?.run?.net_difference) === -300000, { rows, w });
    check("…and the sentence names the holder out of the register rather than out of a join, which "
      + "is why 134 copies the name onto the row: a wallet whose holder is only a foreign key cannot "
      + "be read by a seat three weeks after the company was renamed",
      rows[0]?.detail?.holder === holder && rows[0]?.detail?.account === code
      && rows[0]?.detail?.wallet_status === "open"
      && String(rows[0]?.detail?.why).startsWith(
        `The TZS line held for ${holder} (${code}) is 300000.00 overdrawn: `)
      && /more has left it than the book has ever been told came in/.test(String(rows[0]?.detail?.why))
      && String(rows[0]?.detail?.why).includes("A payment out of a wallet is a claim this office "
        + "cannot make."), rows[0]?.detail);
  });

  await undo("a wallet line the register does not know", async () => {
    const LABEL = "A holder nobody registers (TZS)";
    const orphan = await open(OF, PEN, "WLT-ORPHAN-TZS", LABEL, "liability");
    const r = await counted("the office counts what it holds", "wallet", "TZS", D, D);
    const rows = r?.run?.id ? await fnd(r.run.id) : [];
    check("a line minted in the book's wallet shape and never pointed at by the register is money "
      + "standing for somebody the office cannot name — with nothing on it, so both figures are zero "
      + "and the exception is still real: the verdict is `missing_paper`, because the book agrees with "
      + "itself and it is the register that has no row",
      !!orphan?.id && rows.length === 1 && rows[0].check_name === "wallet_line_orphan"
      && rows[0].subject_kind === "account" && String(rows[0].subject_id) === String(orphan?.id)
      && rows[0].subject_ref === "WLT-ORPHAN-TZS" && Number(rows[0].book_figure) === 0
      && Number(rows[0].paper_figure) === 0 && Number(rows[0].difference) === 0
      && rows[0].verdict === "missing_paper" && rows[0].detail?.label === LABEL
      && typeof rows[0].detail?.opened_at === "string", { rows, orphan });
    check("…and the run prints one wallet line against no wallet, which is the only pair of figures "
      + "that lets a seat see the gap without reading the chart: the exception names a line, the "
      + "population says how many lines were looked at, and the two together say one is unclaimed",
      r?.run?.examined?.wallets === 0 && r?.run?.examined?.wallet_lines === 1
      && String(rows[0]?.detail?.why).includes("WLT-ORPHAN-TZS is a wallet line in the book — "
        + "0.00 held — and no row in the wallet register names it.")
      && /Money is standing in the office for somebody the office cannot name\./.test(
        String(rows[0]?.detail?.why)), { ex: r?.run?.examined, why: rows[0]?.detail?.why });
  });

  await undo("money booked on the heading instead of on a holder", async () => {
    await plant("a leg landed on the wallet heading", OF, PEN, D,
      [["HEAD", "debit", "200000.00"], ["COST", "credit", "200000.00"]]);
    const r = await counted("the office counts what it holds", "wallet", "TZS", D, D);
    const rows = r?.run?.id ? await fnd(r.run.id) : [];
    check("the heading is a heading: a leg on `WALLET-TZS` means money booked twice or booked "
      + "nowhere, and the question reports both sides of the heading rather than a net figure that "
      + "would hide which way it went wrong",
      rows.length === 1 && rows[0].check_name === "wallet_heading"
      && rows[0].subject_kind === "account" && String(rows[0].subject_id) === String(ACC.HEAD?.id)
      && rows[0].subject_ref === "WALLET-TZS" && Number(rows[0].book_figure) === 200000
      && Number(rows[0].paper_figure) === 0 && Number(rows[0].difference) === 200000
      && rows[0].verdict === "differs" && rows[0].detail?.label === "Wallets (TZS)"
      && String(rows[0]?.detail?.why).startsWith("WALLET-TZS is the heading the TZS wallet lines "
        + "sit under, and it carries 1 leg(s) of its own: 200000.00 debited, 0.00 credited.")
      && String(rows[0]?.detail?.why).includes("A holder's money lives on its own WLT- line, so "
        + "this is money booked twice or booked nowhere."), rows);
  });

  await undo("money waiting in escrow with no paper behind it", async () => {
    await plant("money is parked in escrow", OF, PEN, D,
      [["COST", "debit", "400000.00"], ["ESC", "credit", "400000.00"]]);
    const r = await counted("the office counts what it waits on", "escrow", "TZS", D, D);
    const rows = r?.run?.id ? await fnd(r.run.id) : [];
    check("the escrow line holds money and the hold register holds nothing: the two cannot "
      + "legitimately differ, because money leaves escrow only on a plan whose figures are the whole "
      + "hold",
      r?.ok === true && r?.run?.checks === Q.escrow.length && rows.length === 1
      && rows[0].check_name === "escrow_line_total" && rows[0].subject_kind === "account"
      && String(rows[0].subject_id) === String(ACC.ESC?.id) && rows[0].subject_ref === "ESCROW-TZS"
      && Number(rows[0].book_figure) === 400000 && Number(rows[0].paper_figure) === 0
      && Number(rows[0].difference) === 400000 && rows[0].verdict === "differs"
      && rows[0]?.detail?.papers === 0
      && String(rows[0]?.detail?.why).startsWith("ESCROW-TZS holds 400000.00 and the 0 hold "
        + "paper(s) in `held` or `pending_discharge` add up to 0.00.")
      && String(rows[0]?.detail?.why).includes("Money leaves escrow only on a signed plan whose "
        + "figures are the whole hold, so the two cannot legitimately differ."), { rows, esc: ACC.ESC });
    check("…and the second escrow question is honestly silent here: it reads hold papers against "
      + "movements, and this book has no papers to read — `examined.holds` is the population that "
      + "says so", r?.run?.examined?.holds === 0
      && !rows.some((f) => f.check_name === "escrow_paper_postings"), r?.run?.examined);
  });

  await undo("an obligation the office has taken and never paid", async () => {
    const due = await open(OF, PEN, "PAYOUT-DUE", "Payouts owed (TZS)", "liability");
    if (!due?.id) return;
    await plant("an obligation is accrued", OF, PEN, D,
      [["COST", "debit", "300000.00"], [due.id, "credit", "300000.00"]]);
    const r = await counted("the office counts what it owes", "payout", "TZS", D, D);
    const rows = r?.run?.id ? await fnd(r.run.id) : [];
    check("the payable line owes money and no signed paper stands on it: 134 accrues on a signature "
      + "and answers on the cash or its mirror, so a line with a figure and no papers is the middle "
      + "of a movement that stopped",
      r?.ok === true && r?.run?.checks === Q.pay.length && rows.length === 1
      && rows[0].check_name === "payable_line_total"
      && String(rows[0].subject_id) === String(due?.id) && rows[0].subject_ref === "PAYOUT-DUE"
      && Number(rows[0].book_figure) === 300000 && Number(rows[0].paper_figure) === 0
      && Number(rows[0].difference) === 300000 && rows[0].verdict === "differs"
      && rows[0]?.detail?.papers === 0 && rows[0]?.detail?.label === "Payouts owed (TZS)"
      && String(rows[0]?.detail?.why).startsWith("PAYOUT-DUE owes 300000.00 and the 0 payout "
        + "paper(s) standing on it in `released` come to 0.00 including their charges.")
      && String(rows[0]?.detail?.why).includes("A signed paper accrues once and is answered once, "
        + "either by the cash leaving or by its mirror."), rows);
    check("…and the two payout-paper questions are reported as asked of nothing: the run prints the "
      + "payout and batch populations beside the question, so a clean answer here is a proved "
      + "absence rather than a reader that gave up",
      r?.run?.examined?.payouts === 0 && r?.run?.examined?.batches === 0
      && !rows.some((f) => f.check_name === "batch_totals"), r?.run?.examined);
  });

  note("five of the nineteen questions are left to 134's own gate and smoke — `escrow_paper_"
    + "postings`, `payout_paper_postings`, `batch_totals`, `refund_paper_unpaid` and "
    + "`refund_payout_paper`. Each needs a real hold, payout or refund paper minted through 134's "
    + "doors with a subject row behind it and a second seat's signature in front of it; hand-inserted "
    + "shapes would prove this gate's INSERT rather than the door, which is the same reason the chart "
    + "above is opened through 133.");

  // ---------------- 7 · the guards, worked by hand ----------------
  phase("7 · the rules below the doors: what a seat with a direct connection still cannot do");
  /** These are the four guards' own refusals, provoked without a door and without the HTTP desk. They
   *  are the half of 135 the smoke cannot reach at all: every route that could write a run's figures
   *  asks the door first, and the door answers before the table is ever asked. So the rules are tried
   *  here as raw statements, by a role that holds no grant on the register and would hold it if the
   *  design ever needed one. */
  note("nothing below is a door: every statement is written by this file, and a refusal is the "
    + "register's own rather than a body this gate borrowed. The run kept alive here is signed by hand "
    + "at the second half of the phase exactly as the desk signs it at phase 8, so the two proofs are "
    + "the same fact seen from the two sides of the table.");
  const attChk = (needle: string) => checkRows.find((c) => c.tbl === "gateway_webhook_attempts"
    && has(c.def, needle))?.conname ?? "";
  let gId = "", gRef = "", gRows: Record<string, any>[] = [];
  await keep(async () => {
    const broken = await plant("a movement that leans entirely on one side", OF, PEN, D,
      [["BANK", "debit", "700000.00"], ["COST", "debit", "300000.00"]]);
    const r = await counted("the office counts the book that leans", "book", "TZS", D, D);
    gId = String(r?.run?.id ?? "");
    gRef = String(r?.run?.ref ?? "");
    gRows = gId ? await fnd(gId) : [];
    check("a run with exceptions in it exists, so the guards below have a real report to defend: "
      + "two findings, one figure each, and a net the two columns agree on",
      !!broken && r?.ok === true && gRows.length === 2 && r?.run?.findings === 2
      && Number(r?.run?.net_difference) === 1000000 && r?.run?.status === "open",
      { gRef, rows: gRows.map((f) => [f.line, f.check_name, f.difference]) });

    const FROZEN: [string, string][] = [
      ["ref", `'REC-${new Date().getFullYear()}-00001'`], ["scope", "'all'"], ["currency", "'USD'"],
      ["from_day", "to_day - 7"], ["to_day", "to_day + 7"], ["checks", "checks + 1"],
      ["findings", "findings + 1"], ["examined", `examined || '{"gate":1}'::jsonb`],
      ["net_difference", "net_difference + 1"], ["raised_by", `'${QUILL}'::uuid`],
      ["raised_at", "raised_at + interval '1 second'"]];
    const moved: string[] = [];
    const words: string[] = [];
    for (const [col, expr] of FROZEN) {
      const { err } = await guarded(`update money_reconciliation_runs set ${col} = ${expr} `
        + "where id = $1", [gId]);
      if (!err) moved.push(col);
      if (err) words.push(String(err.message).split(":")[1] ?? "");
    }
    check(`all ${FROZEN.length} columns a run's account is made of refuse an update by hand, and all `
      + `${FROZEN.length} answer with the one sentence — "counted % from % to % and says so in the words `
      + `it was written in". Nothing was let through: ${moved.length ? `moved ${moved.join(", ")}`
        : "not one"}`,
      moved.length === 0 && words.every((w) => /says so in the words it was written in/.test(w))
      && words.every((w) => /raise a new run to count it differently/i.test(w)),
      { moved, words: words.slice(0, 3) });
    check("…which is the freeze doing the work rather than the grant list: this file holds no grant on "
      + "the register at all and is writing as its owner, so the only thing standing between a seat and "
      + "a rewritten figure is the trigger — and 135's whole argument is that a signed count's figures "
      + "cannot be edited after the second seat read them, because then the signature would be a "
      + "signature of different words",
      gRows.length === 2 && (await runRow(gId))?.findings === 2
      && Number((await runRow(gId))?.net_difference) === 1000000, await runRow(gId));

    const signed = await okDo("and the same run is signed off by hand, review columns only",
      `update money_reconciliation_runs set status = 'reviewed', reviewed_by = $2,
              reviewed_at = now(), review_note = $3 where id = $1 returning id`,
      [gId, QUILL, NOTE]);
    const after = await runRow(gId);
    check("the freeze is about the account and not about the state machine: an update that moves only "
      + "the three review columns goes through while the run is open, which is the door's own act "
      + "written by another hand — and the figures come back untouched beside it",
      signed.length === 1 && after?.status === "reviewed" && after?.reviewed_by === QUILL
      && after?.findings === 2 && Number(after?.net_difference) === 1000000
      && after?.checks === Q.book.length, after);
    const again = await fails("a signed run refuses an update that changes nothing but its own note",
      `update money_reconciliation_runs set review_note = $2 where id = $1`,
      [gId, "A different sentence entirely, long enough to be a note."], "does not move again");
    check("…and the second branch names the seat that signed rather than the word `reviewed`, because "
      + "the person a later clerk has to ask is a person and not a status — and the guard reads the "
      + "name out of the register, which is why 135 copies nothing onto the row",
      /is signed off by Recon Quill and does not move again/.test(String(again?.message)), again);
    await fails("a signed count cannot be erased",
      "delete from money_reconciliation_runs where id = $1", [gId],
      "A count a seat has signed for is never erased");
    await fails("…and not one of its findings can be rewritten",
      "update money_reconciliation_findings set book_figure = 1 where run_id = $1", [gId],
      "is what the count saw");
    await fails("…nor cut out of the report",
      "delete from money_reconciliation_findings where run_id = $1", [gId],
      "and its findings go with it nowhere");
    check("the report is still whole after four attempts on it: two findings, the same two figures, "
      + "and the run still says two — a guard that fired but let the row through would read exactly "
      + "like a guard that never fired",
      (await fnd(gId)).length === 2 && (await runRow(gId))?.findings === 2, await fnd(gId));
    await fails("a finding's difference cannot even be typed on the way in, because the table derives "
      + "it: a report whose arithmetic disagreed with its own two sides would be unreadable by the "
      + "person asked to sign it",
      `insert into money_reconciliation_findings (run_id, tenant_id, line, check_name, subject_kind,
           book_figure, paper_figure, difference, verdict, detail)
         values ($1,$2,$3,'gate_wash','book',1,0,999,'differs','{"why":"a sentence of its own."}')`,
      [gId, OF, 99], 'non-DEFAULT value into column "difference"');

    const draft = await counted("a second count is raised as a draft", "book", "TZS", D, D);
    const dId = String(draft?.run?.id ?? "");
    const dRows = dId ? await fnd(dId) : [];
    const dFirst = await one(`select id from money_reconciliation_findings
      where run_id = $1 order by line limit 1`, [dId]);
    const gone = await okDo("and one of its findings is deleted by hand while the run is open",
      "delete from money_reconciliation_findings where id = $1 returning id", [dFirst?.id]);
    check("a draft is a draft: the finding guard permits a delete while its run is still open, which "
      + "is what makes the cascade from the run the sanctioned removal rather than a loophole — and "
      + "the run's own figure stays at two, because the account was frozen the moment it was written "
      + "and no hand is allowed to make it agree with what is left",
      gone.length === 1 && dRows.length === 2 && draft?.run?.status === "open"
      && (await fnd(dId)).length === 1 && (await runRow(dId))?.findings === 2,
      { rows: dRows.length, left: (await fnd(dId)).length, run: await runRow(dId) });
    const dropped = await okDo("…and the draft itself is thrown away by hand",
      "delete from money_reconciliation_runs where id = $1 returning id", [dId]);
    const left = await one("select count(*)::int as n from money_reconciliation_findings where run_id = $1",
      [dId]);
    check("the open run deletes, and its remaining finding goes with it by the cascade: one statement "
      + "and the whole draft is gone, which is the only way 135's registers lose a row except the "
      + "discard door",
      dropped.length === 1 && left?.n === 0 && !await one("select 1 from money_reconciliation_runs "
        + "where id = $1", [dId]), left);
    const keptOn = await one(`select count(*)::int as findings from money_reconciliation_findings
      where run_id = $1`, [gId]);
    check("…and the cascade took only the draft: the signed run still holds both its exceptions, so "
      + "throwing a count away cannot be used to thin a report a seat already answered for",
      keptOn?.findings === 2, keptOn);
  });

  // ---------------- 8 · the second seat ----------------
  phase("8 · the second seat: five refusals in order, one signature, and the paper beside it");
  await keep(async () => {
    const run = await counted("the office counts its own book for a second seat to read",
      "book", "TZS", D, D);
    const id = String(run?.run?.id ?? "");
    const ref = String(run?.run?.ref ?? "");
    const found = Number(run?.run?.findings ?? -1);
    /** Signature paper is written about one run, so every count below is about THIS run. The earlier
     *  phases signed and discarded their own runs inside the same transaction, so a whole-register
     *  tally would be a number about this gate rather than about the door. */
    const papers = async (runId: string, action = "recon.signed") =>
      (await one("select count(*)::int as n from audit_logs where action = $1 and entity_id = $2",
        [action, runId]))?.n ?? 0;
    const ghost = randomUUID();
    const first = await refusal("a signature asked of a count that is not in this book at all",
      "not_found", SIGN_SQL, [OF, ghost, NOTE, PEN, "finance_officer", "10.0.0.1", STAMP]);
    check("…and it answers `not_found` even though the seat typing it is the one that raises counts "
      + "and the note is a proper sentence: the run is looked for before already_signed, the note and "
      + "the two-seat rule are asked, because a desk cannot be told which of its four mistakes it "
      + "made about a paper that does not exist", first?.error === "not_found"
      && /no count with that number/.test(String(first?.message)), first);
    const foreign = await counted("a broken book raises a count of its own", "book", "TZS", D, D,
      OB, BRUSH);
    const fId = String(foreign?.run?.id ?? "");
    await refusal("and the office is asked to sign the broken book's count", "not_found", SIGN_SQL,
      [OF, fId, NOTE, QUILL, "finance_officer", "10.0.0.1", STAMP]);
    await refusal("a company's own book is not the office's report", "not_the_office", SIGN_SQL,
      [CO, id, NOTE, CLERK, "director", "10.0.0.1", STAMP]);
    const noNote = await refusal("a count signed on no sentence at all", "bad_note", SIGN_SQL,
      [OF, id, "ok", QUILL, "finance_officer", "10.0.0.1", STAMP]);
    const nine = await counted("a second count is raised for the shortest note the rule allows",
      "book", "TZS", D, D);
    const nineId = String(nine?.run?.id ?? "");
    const short = await call("…and a nine-character note is taken on it, because the rule is eight "
      + "characters rather than a sentence", SIGN_SQL, [OF, nineId, "Nine word", QUILL,
      "finance_officer", "10.0.0.1", STAMP]);
    check("the note is counted in characters, not in words or in good intentions: `ok` is refused and "
      + "nine characters is accepted, and the door's refusal names the exception count the note has "
      + "to answer — which is the seam between a rule the register can hold and a rule a desk would "
      + "have to re-invent",
      /8-600 characters/.test(String(noNote?.message))
      && String(noNote?.message).includes(`is not an answer to the ${found} exception(s)`)
      && short?.ok === true && short?.run?.review_note === "Nine word"
      && short?.run?.status === "reviewed" && short?.run?.can_sign === false,
      { noNote, short: short && [short.ok, short?.run?.review_note, short?.run?.status] });
    await refusal("the seat that raised the count is refused its own signature", "same_seat", SIGN_SQL,
      [OF, id, NOTE, PEN, "finance_officer", "10.0.0.1", STAMP]);
    check("four refusals on this count wrote no signature paper at all, and the accepted count is "
      + "still open: a door that audited its own refusals lets a seat bury a pile of attempts inside "
      + "the register", await papers(id) === 0 && await papers(id, "recon.discarded") === 0
      && (await runRow(id))?.status === "open", { papers: await papers(id), run: await runRow(id) });
    const long = "A note written at the desk that runs past the column on purpose, ".repeat(14);
    const sign = await call("and a second seat signs for it", SIGN_SQL,
      [OF, id, long, QUILL, "compliance_officer", "10.0.0.2", STAMP]);
    const row = await runRow(id);
    check("the signature lands: reviewed, in the office's own book, with the raiser's seat and the "
      + "signer's seat both on the row and the figures the door wrote still the figures the register "
      + "holds", sign?.ok === true && row?.status === "reviewed" && row?.reviewed_by === QUILL
      && row?.raised_by === PEN && row?.findings === found && found > 0
      && row?.checks === Q.book.length, { sign, row, found });
    const kept = await one(`select char_length(review_note) as n, review_note from
      money_reconciliation_runs where id = $1`, [id]);
    check("…and a note longer than the column is cut to 600 by the door rather than refused: the "
      + "sentence a seat chose to write is never the reason a signature fails, and the register's own "
      + "8-600 CHECK is what the clamp is answering",
      kept?.n === 600 && String(kept?.review_note).startsWith("A note written at the desk"), kept);
    const detail = await call("the count is read back whole", DETAIL_SQL, [OF, id]);
    check("the read answers the signing seat with the pair of names rather than two uuids, and takes "
      + "the button away: `can_sign` is false on a run that is signed, so the desk cannot offer a "
      + "second signature the door would refuse",
      detail?.status === "reviewed" && detail?.reviewed_by === "Recon Quill"
      && detail?.raised_by === "Recon Pen" && detail?.can_sign === false
      && Number(detail?.review_note?.length) === 600, detail && Object.keys(detail));
    const twice = await refusal("a third seat cannot answer for a count already answered for",
      "already_signed", SIGN_SQL, [OF, id, NOTE, ERASER, "finance_officer", "10.0.0.1", STAMP]);
    check("…and the refusal says who signed it and when, out of the row rather than out of a hint: a "
      + "seat told only `already_signed` has to find the paper, and the paper is what they are being "
      + "asked not to sign twice",
      twice?.ref === ref && new RegExp("signed off on [0-9]{4}-[0-9]{2}-[0-9]{2} "
        + "[0-9]{2}:[0-9]{2} by Recon Quill").test(String(twice?.message))
      && /does not get a second signature/.test(String(twice?.message)), twice);
    const paper = await one(`select actor_role, entity, before as b, after as a from audit_logs
      where action = 'recon.signed' and entity_id = $1`, [id]);
    check("one audit row stands for the signature and it carries the reading inside it: both names, "
      + "the scope, the money, the count of exceptions and the net the run was signed on — so the "
      + "paper says what was signed even if the run's own columns are later read by a different tool",
      paper?.entity === "money_reconciliation_runs" && paper?.actor_role === "compliance_officer"
      && paper?.a?.reviewed_by === "Recon Quill" && paper?.a?.raised_by === "Recon Pen"
      && paper?.a?.status === "reviewed" && Number(paper?.a?.findings) === found
      && paper?.a?.scope === "book" && paper?.a?.currency === "TZS"
      && paper?.a?.net_difference === Number(row?.net_difference)
      && String(paper?.a?.review_note).length === 600
      && paper?.b?.ref === ref && paper?.b?.status === "open" && paper?.b?.reviewed_by === null,
      paper);
    check("and one row of paper stands for one signature: this count was refused four times and "
      + "signed once, and the count raised for the nine-character note has exactly the same one row "
      + "— so the register of signatures cannot be padded with attempts",
      await papers(id) === 1 && await papers(nineId) === 1
      && await papers(id, "recon.discarded") === 0,
      { id, nine: await papers(nineId), signed: await papers(id) });
    await fails("a hand update of the signed run's note is the guard's, not the door's, business — "
      + "and the register answers it anyway",
      "update money_reconciliation_runs set review_note = $2 where id = $1",
      [id, "An edited sentence, long enough to be worth reading."], "does not move again");
    const discarded = await refusal("a signed count cannot be thrown away either", "signed_and_kept",
      DISCARD_SQL, [OF, id, REASON, ERASER, "finance_officer", "10.0.0.1", STAMP]);
    check("…which is the third refusal this phase proves about one row: the door will not re-sign it, "
      + "the door will not discard it, and the table would not edit it — three bodies, one rule, and "
      + "the sentence that tells a seat to raise a newer run instead",
      discarded?.ref === ref && /is signed off, so it is kept/.test(String(discarded?.message))
      && /Raise a newer run and say what changed between the two\./.test(String(discarded?.message)),
      discarded);
  });

  // ---------------- 9 · the discard ----------------
  phase("9 · the discard: the count goes, its account stays, and the numbering keeps the gap");
  await keep(async () => {
    const run = await counted("the office counts twice over and gets a draft to throw away",
      "book", "TZS", D, D);
    const id = String(run?.run?.id ?? "");
    const ref = String(run?.run?.ref ?? "");
    await refusal("a draft in a company's book is not the office's to discard", "not_the_office",
      DISCARD_SQL, [CO, id, REASON, CLERK, "director", "10.0.0.1", STAMP]);
    await refusal("a draft that is not there is not discarded", "not_found", DISCARD_SQL,
      [OF, randomUUID(), REASON, ERASER, "finance_officer", "10.0.0.1", STAMP]);
    await refusal("a draft thrown away without a sentence", "bad_reason", DISCARD_SQL,
      [OF, id, "oops", ERASER, "finance_officer", "10.0.0.1", STAMP]);
    const before = await fnd(id);
    const gone = await call("and the seat that raised the draft throws it away itself", DISCARD_SQL,
      [OF, id, REASON, PEN, "finance_officer", "10.0.0.1", STAMP]);
    const after = await one(`select (select count(*)::int from money_reconciliation_runs
        where id = $1) as runs,
        (select count(*)::int from money_reconciliation_findings where run_id = $1) as findings`,
      [id]);
    check("a draft is the raiser's own: no second seat is needed to throw it away, and the run and "
      + "both its findings are gone in one statement — the raiser is named as the actor and the "
      + "answer carries the whole account of what was removed",
      gone?.ok === true && before.length === 2 && after?.runs === 0 && after?.findings === 0
      && gone?.discarded?.ref === ref && Number(gone?.discarded?.findings) === 2
      && gone?.discarded?.raised_by === "Recon Pen" && gone?.discarded?.scope === "book"
      && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(gone?.discarded?.from_day)),
      { gone, before: before.length, after });
    const paper = await one(`select actor_role, entity, before as b, after as a from audit_logs
      where action = 'recon.discarded' and entity_id = $1`, [id]);
    check("the audit row survives the row it was written beside, with the discarded account in its "
      + "`before` and the reason plus the count of findings removed in its `after`: the register loses "
      + "the count and the office keeps the fact that a count was made and thrown away, which is the "
      + "difference between a discarded draft and a drift that disappeared",
      paper?.entity === "money_reconciliation_runs" && paper?.actor_role === "finance_officer"
      && paper?.b?.ref === ref && Number(paper?.b?.findings) === 2
      && Number(paper?.b?.checks) === Q.book.length && paper?.b?.raised_by === "Recon Pen"
      && paper?.a?.reason === REASON && Number(paper?.a?.findings_removed) === 2, paper);
    const next = await counted("and the office counts again", "book", "TZS", D, D);
    const nextRef = String(next?.run?.ref ?? "");
    check("the numbering does not close over the gap: the discarded reference is never handed to "
      + "another count, and the next one is the sequence's next value rather than the freed slot — "
      + "which is why the discard's sentence is the only thing that will explain the skip a month "
      + "from now",
      next?.ok === true && nextRef !== ref && nextRef > ref
      && nextRef === `REC-${new Date().getFullYear()}-${String(BASE.run_seq + spent).padStart(5, "0")}`,
      { ref, nextRef, spent, seq: BASE.run_seq });
    const ghost = await call("…and a discard asked of the number that is gone", DISCARD_SQL,
      [OF, id, REASON, ERASER, "finance_officer", "10.0.0.1", STAMP]);
    check("…answers with the sentence that covers both meanings: there is no count with that number "
      + "in this book — or it was already thrown away",
      ghost?.ok === false && ghost?.error === "not_found"
      && /or it was already thrown away/.test(String(ghost?.message)), ghost);
    const twice = await one(`select count(*)::int as n from audit_logs
      where action = 'recon.discarded' and entity_id = $1`, [id]);
    check("and a refusal to discard what is already gone writes no second paper: one discard, one "
      + "audit row, so the register of discarded counts cannot be padded with attempts",
      twice?.n === 1, twice);
  });

  // ---------------- 10 · the statement of one line ----------------
  phase("10 · the statement: an opening, a window, and a running figure that does not restart at "
    + "the top of page two");
  /** A statement is arithmetic over days, and the only way to prove arithmetic over days is to choose
   *  them. The line is opened through 133's own door — a gate that inserted into `money_accounts`
   *  would be proving its own INSERT rather than the chart the desk draws a statement from — and every
   *  leg is planted, because the four figures a clerk signs a statement on (opening, debited, credited,
   *  closing) have to be known before the read can be checked against them. Nothing here is kept: a
   *  synthetic line left on the office's chart would be exactly the drift the count above is looking
   *  for. */
  await undo("the statement's own chart line", async () => {
    const ST = await open(OF, PEN, `OPS-STMTCV${STAMP.slice(-4)}`, "Statement line (TZS)", "asset");
    const LB = await open(OF, PEN, `OPS-LIABCV${STAMP.slice(-4)}`, "Statement payable (TZS)",
      "liability");
    const stCode = String(ST?.code ?? ""), lbCode = String(LB?.code ?? "");
    const stId = String(ST?.id ?? ""), lbId = String(LB?.id ?? "");
    if (ST) ACC.ST = ST;
    if (LB) ACC.LB = LB;
    const far = DAY_AGO(40), before = DAY_AGO(45), gap = DAY_AGO(10);
    check("the two lines the statement is drawn of are open on the office's own chart, one growing by "
      + "a debit and one by a credit, so the natural side is proved rather than asserted",
      !!ST && !!LB && ST?.kind === "asset" && LB?.kind === "liability"
      && ST?.status === "open" && Number(ST?.debit_total) === 0
      && Number(ST?.entry_count) === 0, { ST, LB });
    await plant("money reaches the line before the window opens", OF, PEN, far,
      [["ST", "debit", "500000.00"], ["BANK", "credit", "500000.00"]]);
    await plant("the window's first movement grows it", OF, PEN, DAY_AGO(6),
      [["ST", "debit", "200000.00"], ["COST", "credit", "200000.00"]]);
    await plant("the second takes part of that back", OF, PEN, DAY_AGO(3),
      [["ST", "credit", "50000.00"], ["COST", "debit", "50000.00"]]);
    await plant("…and the third owes it to the payable line", OF, PEN, DAY_AGO(1),
      [["ST", "debit", "100000.00"], ["LB", "credit", "100000.00"]]);

    const w = (limit: any, offset: any, from = OPEN_DAY, to = TODAY) =>
      call(`the statement of ${stCode} from ${from} to ${to}`, STMT_SQL,
        [OF, stId, from, to, limit, offset]);
    const full = await w(200, 0);
    const num = (x: any) => Number(x);
    check("the four figures an accountant asks for come out of the days they were planted on: every "
      + "leg before the window is the opening, the window's own debits and credits are counted whole, "
      + "and the closing is the opening plus what the window moved",
      full && !full.error && num(full?.opening) === 500000 && num(full?.debited) === 300000
      && num(full?.credited) === 50000 && num(full?.moved) === 250000
      && num(full?.closing) === 750000 && full?.legs === 3 && full?.returned === 3
      && full?.code === stCode && full?.natural_side === "debit"
      && full?.from_day === OPEN_DAY && full?.to_day === TODAY, {
      head: full && [full.opening, full.debited, full.credited, full.moved, full.closing, full.legs],
      err: full?.error });
    check("…and each line carries the day, the direction, the figure the account moved by and the "
      + "running balance after it, with the other side of the movement named by its code rather than "
      + "by a uuid: this is the paper a clerk reads across a desk",
      full?.rows?.length === 3 && full?.rows?.[0]?.line === 1
      && full?.rows?.[0]?.day === DAY_AGO(6) && full?.rows?.[0]?.direction === "debit"
      && num(full?.rows?.[0]?.amount) === 200000 && num(full?.rows?.[0]?.moved) === 200000
      && num(full?.rows?.[0]?.running) === 700000 && full?.rows?.[0]?.other_side === "OPS-COST"
      && full?.rows?.[0]?.posting_status === "posted" && !!full?.rows?.[0]?.ref
      && full?.rows?.[1]?.day === DAY_AGO(3) && num(full?.rows?.[1]?.moved) === -50000
      && num(full?.rows?.[1]?.running) === 650000 && full?.rows?.[1]?.direction === "credit"
      && full?.rows?.[2]?.day === DAY_AGO(1) && num(full?.rows?.[2]?.running) === 750000
      && full?.rows?.[2]?.other_side === lbCode, full?.rows);
    check("the closing figure equals the account's own live balance when the window ends today, and "
      + "the door says so as a boolean rather than leaving the clerk to subtract: the cached totals "
      + "are the book read from inside and the statement is the same book read from outside, so the "
      + "pair agreeing is the fact the paper exists to state",
      full?.drift?.window_ends_today === true && num(full?.drift?.cached_balance) === 750000
      && num(full?.drift?.statement_balance) === 750000 && full?.drift?.agrees === true
      && full?.drift?.legs_cached === 4 && full?.drift?.legs_all_time === 4, full?.drift);
    check("…and the basis sentence carries the window's first day and the line's own code, because a "
      + "statement that cannot say what it counted is a number with a logo on it",
      String(full?.basis).includes(OPEN_DAY) && String(full?.basis).includes(stCode)
      && /opening is every leg before/.test(String(full?.basis)), full?.basis);

    const page1 = await w(2, 0);
    const page2 = await w(2, 2);
    check("the page is cut but the totals and the running figure are not: a page of two lines still "
      + "says three legs and the window's whole 300 000 debited, because a balance that restarts at "
      + "the top of page two is not a balance",
      page1?.returned === 2 && page1?.legs === 3 && num(page1?.debited) === 300000
      && page1?.rows?.[1]?.line === 2 && page2?.returned === 1
      && page2?.rows?.[0]?.line === 3 && num(page2?.rows?.[0]?.running) === 750000
      && page2?.offset === 2 && page2?.limit === 2, { p1: page1?.rows?.map((r: any) => [r.line,
        r.running]), p2: page2?.rows?.map((r: any) => [r.line, r.running]) });
    const big = await w(9000, 0);
    const minus = await w(-1, -5);
    const typed = await w(null, null);
    check("the ceiling is the door's, not the desk's: nine thousand lines becomes five hundred, minus "
      + "one becomes one, no number at all becomes the two hundred the door was written with, and a "
      + "negative offset becomes the first page rather than a slice off the end",
      big?.limit === 500 && big?.returned === 3
      && minus?.limit === 1 && minus?.offset === 0 && minus?.returned === 1
      && typed?.limit === 200 && typed?.offset === 0 && typed?.rows?.length === 3,
      [big, minus, typed].map((c) => c && [c.limit, c.offset, c.returned]));
    const empty = await w(200, 0, before, DAY_AGO(41));
    const nothing = await w(200, 0, DAY_AGO(39), DAY_AGO(38));
    const old = await w(200, 0, OPEN_DAY, DAY_AGO(5));
    const born = await w(200, 0, before, gap);
    check("a window with no movement in it is still a statement: the opening is the figure the line "
      + "carried into it and the closing is the same figure, with no rows and no error — which is the "
      + "difference between an empty month and a desk that could not read one",
      nothing?.legs === 0 && nothing?.returned === 0 && Array.isArray(nothing?.rows)
      && !nothing?.error && num(nothing?.opening) === 500000 && num(nothing?.closing) === 500000
      && num(nothing?.moved) === 0, nothing);
    check("…and a window opened before the line's first leg opens on zero rather than reaching back "
      + "for a figure the account never had: the opening is every leg strictly before the first day, "
      + "and nothing is invented to fill an empty past",
      empty?.legs === 0 && num(empty?.opening) === 0 && num(empty?.closing) === 0
      && empty?.drift?.window_ends_today === false && empty?.drift?.agrees === null
      && num(empty?.drift?.statement_balance) === 0
      && num(empty?.drift?.cached_balance) === 750000, empty);
    check("…and the leg that opened the line is printed with the day it was posted, the direction it "
      + "moved and the paper on its other side, so a statement over an account's whole life starts at "
      + "zero and lands on the figure the register holds",
      born?.legs === 1 && num(born?.opening) === 0 && num(born?.moved) === 500000
      && num(born?.closing) === 500000 && born?.rows?.[0]?.day === far
      && born?.rows?.[0]?.other_side === "OPS-BANK" && born?.rows?.[0]?.line === 1, born);
    check("…and a window that closes last week is not asked to agree with today's register: `agrees` "
      + "is null rather than false while the cached 750 000 sits beside the 700 000 that is honest for "
      + "its own date, because a statement of March is not evidence that April has drifted — the claim "
      + "is about a day, and the door declines to make it when the day is not there",
      old?.legs === 1 && num(old?.opening) === 500000 && num(old?.debited) === 200000
      && num(old?.credited) === 0 && num(old?.closing) === 700000
      && old?.drift?.agrees === null && old?.drift?.window_ends_today === false
      && num(old?.drift?.cached_balance) === 750000 && num(old?.drift?.statement_balance) === 700000
      && old?.rows?.[0]?.day === DAY_AGO(6), old && [old.opening, old.closing, old.legs, old.drift]);

    const liab = await call(`the same money read of the payable line`, STMT_SQL,
      [OF, lbId, OPEN_DAY, TODAY, 200, 0]);
    check("the side a movement is printed on follows the account's kind and never a choice made here: "
      + "the identical leg is +100 000 on the payable line, where a credit is the natural side, and "
      + "the other side of the paper names the asset line it moved",
      liab?.natural_side === "credit" && liab?.kind === "liability" && num(liab?.opening) === 0
      && num(liab?.credited) === 100000 && num(liab?.debited) === 0
      && num(liab?.moved) === 100000 && num(liab?.closing) === 100000 && liab?.legs === 1
      && num(liab?.rows?.[0]?.moved) === 100000 && liab?.rows?.[0]?.direction === "credit"
      && liab?.rows?.[0]?.other_side === stCode && liab?.drift?.agrees === true, liab && [
        liab?.natural_side, liab?.moved, liab?.rows?.[0]?.other_side, liab?.drift]);

    await okDo("…and the register's own cache is pushed off the legs, the way 133's drift is really "
      + "caused", `update money_accounts set debit_total = debit_total + 100000 where id = $1
        returning id`, [stId]);
    const drift = await w(200, 0);
    check("…which is the second half of the same sentence: with the window closing today the door "
      + "does say false, 850 000 against 750 000, printed beside both figures so a seat can see which "
      + "of the two has moved — the cached total and the recomputed one are the two numbers the "
      + "statement exists to compare",
      drift?.drift?.agrees === false && drift?.drift?.window_ends_today === true
      && num(drift?.drift?.cached_balance) === 850000 && num(drift?.drift?.statement_balance) === 750000
      && num(drift?.closing) === 750000 && drift?.drift?.legs_cached === 4
      && drift?.drift?.legs_all_time === 4, drift?.drift);

    const refuse: [string, string, string, string | null, string | null, RegExp][] = [
      ["a statement of a company's own book", CO, stId, OPEN_DAY, TODAY, /drawn of the office/i],
      ["a statement asked of no days at all", OF, stId, null, null, /which days it covers/],
      ["a statement whose window runs backwards", OF, stId, TODAY, OPEN_DAY,
        /window runs backwards/],
      ["a statement closed on a day that has not happened yet", OF, stId, OPEN_DAY, DAY_AGO(-1),
        /to close a statement on yet/],
      ["a statement of a line this book does not have", OF, randomUUID(), OPEN_DAY, TODAY,
        /no line with that id/],
      ["…and a statement of another book's line, typed with that line's own id", OF,
        String(ACC.BANK2?.id ?? ""), OPEN_DAY, TODAY, /company's own book is not the office/i]];
    for (let i = 0; i < refuse.length; i++) {
      const [label, book, acct, from, to, needle] = refuse[i];
      const r = await call(label, STMT_SQL, [book, acct, from, to, 200, 0]);
      check(`…which is the ${i + 1} of the six ways a statement is refused — with a sentence a clerk `
        + `can act on and an empty paper rather than a stack: ${label}`,
        !!r?.error && needle.test(String(r?.error)) && r?.legs === 0
        && Array.isArray(r?.rows) && r?.rows.length === 0, r);
    }
  });

  // ---------------- 11 · the payload scrub ----------------
  phase("11 · the payload scrub: the words it hides, the shape it keeps, and the one shape it "
    + "cannot reach");
  /** The list is read out of the body the platform is running rather than typed into this gate: a word
   *  added to 135 is proved by the next line the moment the file is, and a word taken out of it stops
   *  being claimed as hidden. The words this file expects are a subset test for exactly that reason. */
  const fnDef = await one(`select pg_get_functiondef(
      'platform_auth.scrub_gateway_payload(jsonb)'::regprocedure) as d,
      (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'platform_auth' and p.proname = 'scrub_gateway_payload') as vol`);
  const HIDE = ((/v_hidden text\[\] := array\[([\s\S]*?)\]/.exec(fnDef?.d ?? "")?.[1] ?? "")
    .match(/'[^']*'/g) ?? []).map((w) => w.slice(1, -1));
  const EXPECTED = ["phone", "phonenumber", "phone_number", "msisdn", "mobile", "mobile_number",
    "mobilenumber", "tel", "telephone", "account", "accountno", "account_number", "accountnumber",
    "acc_no", "accno", "pan", "card", "cardno", "card_number", "cardnumber", "cvv", "cvc", "expiry",
    "pin", "otp", "email", "mail", "nida", "id_number", "idnumber", "national_id", "nationalid",
    "secret", "password", "token", "authorization", "signature", "credentials_encrypted",
    "credentialsencrypted", "webhook_secret", "webhooksecret", "payer_phone", "payerphone"];
  check(`the scrub the platform is running hides ${HIDE.length} words, each named once, and none of `
    + "the " + EXPECTED.length + " this gate knows about has quietly left the list: a phone in seven "
    + "spellings, an account in four, a card in four, the NIDA number under two names, and the three "
    + "column-shaped words a gateway desk could otherwise read out of its own register — with the "
    + "one-word spelling of each beside it, because 139 folds a name before comparing it and the fold "
    + "is a second chance to hit the list, not a way into it",
    HIDE.length >= EXPECTED.length && new Set(HIDE).size === HIDE.length
    && EXPECTED.every((w) => HIDE.includes(w)) && fnDef?.vol === "i",
    { n: HIDE.length, missing: EXPECTED.filter((w) => !HIDE.includes(w)),
      extra: HIDE.filter((w) => !EXPECTED.includes(w)), vol: fnDef?.vol });
  const everyWord = await one(`select coalesce(jsonb_agg(x.w) filter (where x.kept), '[]'::jsonb)
      as still, count(*)::int as asked
    from (select t.w, jsonb_exists(platform_auth.scrub_gateway_payload(
              jsonb_build_object(t.w, '0712345678')), t.w) as kept
          from unnest($1::text[]) t(w)) x`, [HIDE]);
  check("…and every one of them is gone when it is asked for on its own, in a single statement over "
    + "the list the catalog holds: no word is hidden by an accident of the loop and none by a name "
    + "that only almost matches", everyWord?.asked === HIDE.length
    && Array.isArray(everyWord?.still) && everyWord.still.length === 0, everyWord);
  const scrub = async (label: string, payload: any) => await call(label, SCRUB_SQL,
    [payload === null || payload === undefined ? null : JSON.stringify(payload)]);
  const KEPT = { reference: "WSH-0751234567", outcome: "approved", event: "payment.captured",
    amount: 250000, charge_id: "ch_9", note: "nothing of the payer's own" };
  const kept = await scrub("the six words a desk needs are asked to survive",
    { ...KEPT, phone: "0712345678", nida: "12345678", cvv: "123", email: "a@b.c",
      webhook_secret: "sq-lkjlkhjlk", payer_phone: "0781234567" });
  check("…and the six that are not a payer's own detail come back whole, values and all, in the same "
    + "breath: the scrub is a deny-list, not a filter that decides what looks personal",
    Object.keys(KEPT).every((k) => String(kept?.[k]) === String(KEPT[k]))
    && Object.keys(kept ?? {}).length === Object.keys(KEPT).length, kept);
  const folded = await scrub("the same word written the way a rail writes it",
    { "phone-number": "071", "PhoneNumber": "072", "account-number": "123", "accountNumber": "124",
      "CARD-NUMBER": "4111", webhookSecret: "sq", PHONE: "073", Nida: "9", "Cvv": "1",
      reference: "WSH-0751234567" });
  check("…and a dash is folded both ways, so the word arrives at the list whether the rail writes it "
    + "as two words or one, and the case a hand types is folded with it: nine spellings of five "
    + "hidden words are gone and the one safe key is kept",
    Object.keys(folded ?? {}).length === 1 && folded?.reference === "WSH-0751234567", folded);
  /** The half this file cannot get from the live catalog alone. 139's own self-check calls the scrub it
   *  just wrote and demands the camelCase eight back hidden, which proves the body on disk; but the
   *  claim at the desk was about the body that was running before it — that `cardNumber` came out of a
   *  gateway read whole. So 135's un-folded body is replayed inside a savepoint, the same payload is
   *  handed to it on the same socket, and the leak is raised. Then 139's body goes back and the same
   *  call hides them, which is the difference between two files stated as one observation. */
  const CAMEL = { cardNumber: "4111111111111111", payerPhone: "+255712345678",
    accountNumber: "0123456789", mobileNumber: "+255781234567", idNumber: "12345678",
    nationalId: "9901011234567", webhookSecret: "sq-abcdef", credentialsEncrypted: "eyJhbGci",
    reference: "WSH-0751234567", outcome: "approved", event: "payment.captured" };
  const SAFE = ["event", "outcome", "reference"];
  const UNSAFE = Object.keys(CAMEL).filter((k) => !SAFE.includes(k));
  await undo("the scrub asked in 135's spelling", async () => {
    const unfolded = ddl.find((d) => d.includes("scrub_gateway_payload(")) ?? "";
    await okDo("135's un-folded scrub is put back on the shelf for one call", unfolded);
    const leak = await scrub("the camelCase eight handed to the body 139 replaced", CAMEL);
    check("…and 135's body kept every one of them: its fold turns `cardNumber` into `cardnumber` and "
      + "`cardnumber` was never on the list, so a rail's own spelling of a hidden word walked out of a "
      + "gateway read whole — the leak the desk reported, raised here rather than remembered",
      !unfolded.includes("v_norm") && Object.keys(leak ?? {}).length === 11
      && UNSAFE.every((k) => leak?.[k] === CAMEL[k]) && SAFE.every((k) => leak?.[k] === CAMEL[k]),
      { kept: Object.keys(leak ?? {}).sort(), leak });
    const leakDeep = await scrub("…and the same eight one level down, inside a payer object",
      { reference: "WSH-0751234567", meta: { payer: { payerPhone: "+255712345678",
        nationalId: "9901011234567", kind: "NIDA-id" } } });
    check("…and the miss is the name test, not the walk: 135 reached the nested payer and scrubbed "
      + "nothing there, because both words were spelled in the rail's case",
      leakDeep?.meta?.payer?.payerPhone === "+255712345678"
      && leakDeep?.meta?.payer?.nationalId === "9901011234567", leakDeep);
    await okDo("139's folded scrub is put back", foldDdl[0]);
    const hid = await scrub("the same eight handed to the body the platform runs, on the same socket",
      CAMEL);
    check("…and the identical call against 139's body comes back with the three keys the desk needs "
      + "and nothing else — the eight are gone while their values were never examined, which is the "
      + "whole of what 139 changed",
      Object.keys(hid ?? {}).length === 3 && SAFE.every((k) => hid?.[k] === CAMEL[k]), hid);
    const hidDeep = await scrub("…and the same nested payer handed to 139's body",
      { reference: "WSH-0751234567", meta: { payer: { payerPhone: "+255712345678",
        nationalId: "9901011234567", kind: "NIDA-id" } } });
    check("…and the fold reaches the nested walk on the same pass: the two words are hidden, their "
      + "untouched sibling is kept, and no value of either is left anywhere in the answer",
      hidDeep?.meta?.payer?.payerPhone === undefined
      && hidDeep?.meta?.payer?.nationalId === undefined
      && hidDeep?.meta?.payer?.kind === "NIDA-id"
      && !JSON.stringify(hidDeep ?? "").includes("255712345678"), hidDeep);
  });
  const afterFold = await scrub("the scrub the run is left holding still folds",
    { cardNumber: "4111111111111111", reference: "WSH-0751234567" });
  check("…and the savepoint took 135's body away with it: the next call is 139's answer again, so no "
    + "phase after this one is reading a scrub the platform does not run",
    Object.keys(afterFold ?? {}).length === 1 && afterFold?.reference === "WSH-0751234567", afterFold);
  const deep = await scrub("the word buried three levels down",
    { reference: "WSH-1", meta: { payer: { id: 7, phone: "0712345678", doc: { nida: "4",
        kind: "NIDA-id" } }, keep: "yes" }, lines: [{ bank: "NMB", card_number: "4111111111111111" },
      { msisdn: "078", line: 2 }, 5, "plain"] });
  check("…and the scrub goes down after it: the phone three levels in is gone with its sibling kept, "
    + "the object inside an array is scrubbed on the same rule, the array keeps its length and its "
    + "order and its scalars untouched, and the top-level reference survives the walk",
    deep?.meta?.payer?.phone === undefined && deep?.meta?.payer?.doc?.kind === "NIDA-id"
    && deep?.meta?.keep === "yes" && Array.isArray(deep?.lines) && deep.lines.length === 4
    && deep.lines[0]?.card_number === undefined && deep.lines[0]?.bank === "NMB"
    && deep.lines[1]?.msisdn === undefined && deep.lines[1]?.line === 2
    && deep.lines[2] === 5 && deep.lines[3] === "plain" && deep?.reference === "WSH-1", deep);
  check("…while no value of a hidden word survives anywhere in the answer, however the shape is "
    + "nested — the phone number itself is what a read must not carry, not only its key",
    !JSON.stringify(deep ?? "").includes("0712345678")
    && !JSON.stringify(kept ?? "").includes("0712345678"), { deep, kept });
  const shapes: [string, any, (r: any) => boolean][] = [
    ["nothing at all is asked", null, (r: any) => !!r && Object.keys(r).length === 0],
    ["an empty body", {}, (r: any) => !!r && Object.keys(r).length === 0],
    ["a body that is one word", "hello", (r: any) => r === "hello"],
    ["a body that is a number", 12, (r: any) => r === 12]];
  for (let i = 0; i < shapes.length; i++) {
    const [label, payload, test] = shapes[i];
    const r = await scrub(`the scrub handed ${label}`, payload);
    check(`…which is the ${i + 1} of the four shapes a payload can be, and a non-object is handed `
      + `back as it came rather than answered with an error: ${label}`, test(r), { payload, r });
  }
  const bare = await scrub("the scrub handed a bare array of events",
    [{ phone: "0712345678" }, { reference: "WSH-2" }]);
  check("…and the one shape it cannot reach is printed rather than hidden: an object at the top level "
    + "is walked, an array at the top level is handed back whole — the recursion only starts inside "
    + "an object — so a rail that posted a bare list of events would keep its phones",
    Array.isArray(bare) && bare.length === 2 && bare[0]?.phone === "0712345678", bare);
  note("…which is honest rather than fatal: 005's intake route always stores an object and the two "
    + "doors that read a payload call the scrub on `payment_webhooks.payload`, which is `jsonb not "
    + "null` and written by that route. The rule 135's comment claims — \"a later rail that posts a "
    + "raw body cannot turn a gateway read into a PII read\" — is true of the four shaped keys today "
    + "and false of a bare array tomorrow. Recorded here so the day the intake accepts a list is the "
    + "day this line is read.");
  const byName = await scrub("a phone number sitting under a name nobody hid",
    { payer_msisdn_backup: "0712345678", reference: "WSH-3", tel_no: "0787654321" });
  check("…because it hides by the NAME of a key, not by the look of its value: a number that is "
    + "plainly a phone survives under a name that is not on the list, so the list is what has to grow "
    + "when a rail renames a field", Object.keys(byName ?? {}).length === 3
    && byName?.payer_msisdn_backup === "0712345678", byName);

  // ---------------- 12 · the delivery board ----------------
  phase("12 · the delivery board: the six piles, the number beside them, and the two places where "
    + "the board and the one-delivery read stop agreeing");
  /** `payment_webhooks` has no tenant column to hide behind, so the only filter that can name this
   *  section's own rows is the reference a delivery carries. Every row planted below spells the gate's
   *  stamp into that reference or its event word, and every question is asked with the stamp as the
   *  search — a board asked without it would count the office's real pile, which is a different number
   *  on every run of this file. */
  await keep(async () => {
    const T = R("BRD");
    const board = (label: string, prov: any, state: any, search: any, limit: any, offset: any,
      book = OF) => call(label, GH_BOARD_SQL, [book, prov, state, search, limit, offset]);
    const det = (label: string, id: any, book = OF) => call(label, GH_DETAIL_SQL, [book, id]);
    const ids = (b: any) => (b?.rows ?? []).map((x: any) => String(x.id));
    const row = (b: any, id: any) => (b?.rows ?? []).find((x: any) => String(x.id) === String(id));
    const droveFor = async (book: string, tag: string, webhook: string, times: number) => {
      for (let i = 1; i <= times; i++) await okDo(`…and drive ${i} of ${tag} from another desk`,
        `insert into gateway_webhook_attempts (id, tenant_id, webhook_id, attempt, outcome,
           intent_reference, payment_status, message, answer, acted_by, acted_role, ip)
         values ($1,$2,$3,$4,'succeeded',$5,'approved',$6,'{}'::jsonb,$7,'support_engineer',
           '10.0.0.8')`,
        [randomUUID(), book, webhook, i, tag,
          `Recon Gate ${STAMP} another office's desk re-drove this delivery and it landed`, QUILL]);
    };
    const bill = async (number: string, amount: string) => {
      const inv = randomUUID();
      await okDo(`…and the invoice ${number} the charge belongs to`, `insert into invoices
          (id, tenant_id, number, billing_cycle, seats, amount_subtotal, vat_rate, vat_amount,
           amount_total, currency, status, period_start, period_end)
         values ($1,$2,$3,'monthly',5,$4,0.18,$5,$6,'TZS','issued',$7::date,$8::date)
         returning id`, [inv, CO, number, amount, (Number(amount) * 0.18).toFixed(2),
        (Number(amount) * 1.18).toFixed(2), OPEN_DAY, TODAY]);
      return inv;
    };
    const rawSend = async (tag: string, payload: any, at = "14:00") => {
      const rows = await okDo(`a delivery ${tag} is planted with a body of its own`,
        `insert into payment_webhooks (id, provider, event_type, signature_valid, replay_nonce,
           payload, created_at)
         values ($1,$2,'approved',true,$3,$4::jsonb,$5::timestamptz) returning id`,
        [randomUUID(), RAIL, `${STAMP}-raw-${tag}`, JSON.stringify(payload), `${D}T${at}:00`]);
      return rows.length ? rows[0].id : null;
    };
    const refA = `${T}-STUCK`, refB = `${T}-LANDED`, refD = `${T}-GHOST`, refE = `${T}-SPENT`;
    const refG = `${T}-OTHER`;
    const A = await send("the board's stuck one", { ref: refA, event: "approved",
      outcome: "approved", at: "06:00" });
    await charge("the board's open one", refA, "pending", "250000.00");
    const B = await send("the board's landed one", { ref: refB, event: "approved",
      outcome: "approved", done: true, error: `${T}-WHY`, at: "07:00" });
    const BCH = await charge("the board's closed one", refB, "approved", "250000.00");
    const BINV = await bill(`${T}-INV`, "250000.00");
    if (BCH && BINV) await okDo("…and the closed charge points at its invoice",
      `update payments set invoice_id = $1 where id = $2 returning id`, [BINV, BCH]);
    const C = await send("the board's unsigned one", { ref: `${T}-UNVER`, event: "approved",
      valid: false, at: "08:00" });
    const GHO = await send("the board's ghost", { ref: refD, event: "approved", at: "09:00" });
    const E = await send("the board's spent one", { ref: refE, event: "approved",
      outcome: "approved", at: "10:00" });
    await charge("the board's spent charge", refE, "pending", "90000.00");
    /** No reference key at all — so the only column the stamp can sit in is the event word. Planted
     *  as `approved` it would be invisible to every question below, which all search by the stamp. */
    const F = await send("the board's unreadable one", { noRef: true, event: `${T}-NOREF`,
      at: "11:00" });
    const G = await send("the board's other desk", { ref: refG, event: "approved", at: "12:00" });
    await charge("the board's other charge", refG, "pending", "1000.00");
    const H = await send("the board's blank reference", { ref: "", event: `${T}-BLANK`,
      at: "13:00" });
    if (E) await drove(refE, E.id, 5);
    if (G) await droveFor(OB, refG, G.id, 5);

    const newestFirst = [H, G, F, E, GHO, C, B, A].filter(Boolean).map((x: any) => String(x.id));
    /** A pile, written as the members rather than the order: the board answers newest arrival first,
     *  so every expected list below is put in that order by the same helper rather than typed twice
     *  and got wrong on one of the six. */
    const inPile = (...list: any[]) => newestFirst.filter((id) => list
      .some((x: any) => x && String(x.id) === id));
    const out = await board("the whole pile the gate planted", null, "all", T, null, null);
    const eight = newestFirst;
    check("eight deliveries, eight rows, newest first — and the count is the pile rather than the "
      + "page, so a seat that asks for two hundred still hears how big the pile really is",
      out?.count === 8 && out?.returned === 8 && out?.error === undefined
      && String(out?.rows?.map?.((x: any) => String(x.id))?.join(",")) === eight.join(","),
      { count: out?.count, returned: out?.returned, got: ids(out), want: eight });
    const want: [string, any[]][] = [
      ["stuck", inPile(A, GHO, E, F, G, H)], ["unverified", inPile(C)], ["landed", inPile(B)],
      ["retried", inPile(E)], ["orphan", inPile(GHO, F, H)],
      ["all", inPile(A, B, C, GHO, E, F, G, H)]];
    for (const [state, list] of want) {
      const b = await board(`the ${state} pile`, null, state, T, null, null);
      const mine = list as string[];
      check(`…and the word "${state}" answers with exactly the deliveries that are in it${state
        === "stuck" ? " — six of them, because a verified delivery the office never acted on is "
          + "stuck whether or not it names a charge" : state === "orphan"
          ? " — and three of those six are ALSO orphan, so the piles are questions rather than a "
          + "partition: one delivery can be two of the office's problems at once" : state
          === "retried" ? " — only the one THIS desk drove, because the attempts lateral is bound to "
          + "the tenant it was asked of" : ""}`,
        b?.count === mine.length && b?.returned === mine.length
        && same(ids(b), mine), { state, count: b?.count, got: ids(b), want: mine });
    }
    const head = out?.heading ?? [];
    check("…and the heading totals the same eight by rail: six stuck, one unverified, one landed, "
      + "three orphan, five attempts and one delivery that has spent its ceiling — the chips on the "
      + "desk and the numbers beside them are read off one predicate",
      Array.isArray(head) && head.length === 1 && head[0]?.provider === RAIL
      && head[0]?.deliveries === 8 && head[0]?.stuck === 6 && head[0]?.unverified === 1
      && head[0]?.landed === 1 && head[0]?.retried === 1 && head[0]?.orphan === 3
      && head[0]?.attempts === 5 && head[0]?.spent === 1, head);
    const stuckHead = await board("the heading of the stuck pile alone", null, "stuck", T, null, null);
    check("…and when a seat is standing in one pile the heading is the shape of THAT pile, not of "
      + "everything: six deliveries of the six, three orphans among them, the landed and unverified "
      + "rows gone from the totals",
      stuckHead?.heading?.[0]?.deliveries === 6 && stuckHead?.heading?.[0]?.stuck === 6
      && stuckHead?.heading?.[0]?.orphan === 3 && stuckHead?.heading?.[0]?.landed === 0
      && stuckHead?.heading?.[0]?.unverified === 0 && stuckHead?.heading?.[0]?.retried === 1
      && stuckHead?.heading?.[0]?.attempts === 5 && stuckHead?.heading?.[0]?.spent === 1,
      stuckHead?.heading);
    const small = await board("the pile asked two rows at a time", null, "all", T, 3, null);
    check("…and a page of three still reports eight: the cut is the page and the count is the pile, "
      + "so a seat never reads a full window as an empty office",
      small?.returned === 3 && small?.count === 8 && small?.limit === 3
      && small?.heading?.[0]?.deliveries === 8 && same(ids(small), eight.slice(0, 3)),
      { returned: small?.returned, count: small?.count, got: ids(small) });
    const next = await board("the second page of three", null, "all", T, 3, 3);
    check("…while the next page carries on down the same newest-first line rather than restarting it",
      next?.returned === 3 && next?.offset === 3 && same(ids(next), eight.slice(3, 6)),
      { got: ids(next), want: eight.slice(3, 6) });
    const clamps = [await board("a window of nine thousand rows", null, "all", T, 9000, null),
      await board("a window of no rows", null, "all", T, 0, -5),
      await board("a window nobody sized", null, "all", T, null, null)];
    check("…and the window is clamped rather than argued with: nine thousand becomes two hundred, "
      + "zero or a negative becomes one, a negative offset becomes the first row, and no number at "
      + "all becomes the sixty the desk was designed for",
      clamps[0]?.limit === 200 && clamps[1]?.limit === 1 && clamps[1]?.offset === 0
      && clamps[2]?.limit === 60 && clamps[2]?.offset === 0,
      clamps.map((c: any) => [c?.limit, c?.offset]));
    const searches: [string, string[], string][] = [[refA, inPile(A),
      "the reference the rail pushed, which is the only number a company's desk and the office's "
      + "both know"], [`${T}-BLANK`, inPile(H),
      "the event word — which is how a delivery carrying no reference at all is still findable by "
      + "a seat that knows when it arrived"], [`${T}-WHY`, inPile(B),
      "the reason the office wrote when the write failed, the one sentence that tells a seat which "
      + "deliveries to read first"], ["Recon Gate Cargo", inPile(A, B, E, G),
      "through the charge to the company it belongs to, which is a name the delivery row does not "
      + "carry at all"]];
    for (const [term, mine, why] of searches) {
      const b = await board(`the desk typed ${term}`, null, "all", term, null, null);
      check(`…and the search box reaches ${why}`,
        b?.count === mine.length && same(ids(b), mine), { term, got: ids(b), want: mine });
    }
    const provs = [await board("the rail typed in the case a hand uses", "MPESA", "all", T, null,
      null), await board("a rail that sent nothing at all", "airtel", "all", T, null, null)];
    check("…and the rail the seat names is folded to lower case before it is asked, so `MPESA` finds "
      + "the same eight; a rail that never sent is answered with an empty pile and an empty heading "
      + "rather than an error about a name this office has no register for",
      provs[0]?.count === 8 && provs[0]?.error === undefined && provs[1]?.count === 0
      && provs[1]?.returned === 0 && provs[1]?.rows?.length === 0
      && provs[1]?.heading?.length === 0, { mpesa: provs[0]?.count, airtel: provs[1] });
    const wordTests = [await board("the pile word left blank", null, "", T, null, null),
      await board("the pile word with spaces and capitals", null, "  ALL  ", T, null, null),
      await board("the pile word never given", null, null, T, null, null)];
    check("…and `all`, an empty word and no word at all are the same question, with the case and the "
      + "spaces a form leaves in it folded first", wordTests.every((b: any) => b?.count === 8
      && b?.error === undefined), wordTests.map((b: any) => [b?.count, b?.error]));
    const notMine = await board("the board asked by a company's own desk", null, "all", T, null,
      null, CO);
    check("a company asking the rails' board is turned away with the sentence that says the rails "
      + "answer to the office, and it is turned away with an empty pile rather than an exception — "
      + "and its own limit and offset are still echoed, so a desk that shows a number never has one "
      + "to invent", notMine?.error === "The rails answer to the platform office, and this session "
      + "is not that desk." && notMine?.rows?.length === 0 && notMine?.count === 0
      && notMine?.heading?.length === 0 && notMine?.returned === 0 && notMine?.limit === 60
      && notMine?.offset === 0, notMine);
    const badState = await board("a pile word the board does not have", null, "pending", T, null,
      null);
    check("…and a word that is not one of the six is refused by naming the six, because a seat that "
      + "typed \"pending\" meant one of them and has to be told which",
      badState?.error === "Choose the pile: stuck, unverified, landed, retried, orphan, or all of it "
      + "at once." && badState?.count === 0 && badState?.rows?.length === 0
      && badState?.heading?.length === 0, badState);

    const ra = row(out, A?.id) ?? {};
    check("a stuck row carries everything a seat needs before it presses anything: the rail, the "
      + "event, that the signature matched, the reference and the outcome word the intake parsed, "
      + "when it arrived, that nothing processed it, no attempts yet, and the charge it names with "
      + "the company that owns it — still open for 250000",
      ra?.provider === RAIL && ra?.event === "approved" && ra?.verified === true
      && ra?.reference === refA && ra?.outcome_wanted === "approved" && ra?.readable === true
      && ra?.processed_at === null && ra?.attempts === 0 && ra?.last_attempt === null
      && ra?.can_retry === true && Number(ra?.charge?.amount) === 250000
      && ra?.charge?.status === "pending" && ra?.charge?.rail === RAIL
      && ra?.charge?.completed_at === null && ra?.charge?.invoice === null
      && String(ra?.charge?.tenant ?? "").includes("Cargo") && !!ra?.nonce, ra);
    const rb = row(out, B?.id) ?? {};
    check("…and the landed one says so with the office's own paper beside it: processed, not "
      + "re-driveable, the invoice number read through the charge, and the reason the write failed "
      + "still on the row", rb?.processed_at !== null && rb?.can_retry === false
      && rb?.charge?.status === "approved" && rb?.charge?.invoice === `${T}-INV`
      && rb?.processing_error === `${T}-WHY` && Number(rb?.charge?.amount) === 250000, rb);
    const rd = row(out, GHO?.id) ?? {};
    check("…and the ghost: a verified delivery naming a reference no charge has ever carried is in "
      + "the stuck pile and the orphan pile at once, still answerable to a re-drive — which is the "
      + "honest shape of the question, since the only way to learn the reference is not ours is to "
      + "ask the completion",
      rd?.charge === null && rd?.can_retry === true && rd?.reference === refD
      && rd?.readable === true, rd);
    const re = row(out, E?.id) ?? {};
    check("…and the spent one: five attempts of THIS desk's own, the last of them quoted with the "
      + "seat's name rather than their id, and no button — the ceiling is the board's answer as well "
      + "as the door's", re?.attempts === 5 && re?.can_retry === false
      && re?.last_attempt?.attempt === 5 && re?.last_attempt?.outcome === "failed"
      && re?.last_attempt?.acted_by === "Recon Pen"
      && String(re?.last_attempt?.message ?? "").includes(STAMP), re);
    const rf = row(out, F?.id) ?? {};
    check("…and the unreadable one: a body with no reference key at all is not something a seat can "
      + "be asked to re-drive, so `readable` says the body has no reference while `can_retry` says "
      + "the button must not appear", rf?.readable === false && rf?.reference === null
      && rf?.can_retry === false && rf?.charge === null, rf);
    const rh = row(out, H?.id) ?? {};
    check("…and the blank one is where the board starts to disagree with itself: `readable` asks "
      + "whether the key is THERE, `can_retry` asks whether the text is not empty, so a delivery "
      + "whose reference is an empty string is called readable and then refused the button — the "
      + "row is honest about the reference either way, because it prints the text or null",
      rh?.readable === true && rh?.reference === null && rh?.can_retry === false
      && rh?.event === `${T}-BLANK`, rh);
    const rg = row(out, G?.id) ?? {};
    check("…and another office's five attempts are not this office's five: the lateral is bound to "
      + "the tenant the board was asked of, so this desk sees no attempts and an open button on the "
      + "same delivery another desk has already spent", rg?.attempts === 0
      && rg?.can_retry === true && rg?.last_attempt === null, rg);

    const dA = await det("the whole of the stuck delivery", A?.id);
    check("one delivery read whole answers the same pile row and adds the body, the rail's own "
      + "register and an empty attempt list: no `why_not`, because there is nothing to explain",
      dA?.id === String(A?.id) && dA?.can_retry === true && dA?.why_not === null
      && dA?.attempts?.length === 0 && dA?.payload?.reference === refA
      && dA?.payload?.outcome === "approved" && same(dA?.payload_keys ?? [],
        ["outcome", "provider", "reference"])
      && dA?.charge?.tenant_type === "transporter" && dA?.rail?.provider_key === RAIL
      && Object.keys(dA?.rail ?? {}).every((k) => !/credential/.test(k) || k === "credential_hint"),
      dA);
    const dC = await det("the whole of the unsigned delivery", C?.id);
    check("…and the unsigned one is refused its button in a sentence a seat can act on: the "
      + "signature is the problem, so the fix is on the rail's side of the wire, not the charge's",
      dC?.can_retry === false && dC?.verified === false
      && dC?.why_not === "The platform could not verify this delivery, so it is not an instruction. "
      + "Nothing is re-driven against a signature that did not match.", dC);
    const dB = await det("the whole of the landed delivery", B?.id);
    check("…and the landed one says the office already answered it, in the fewest words the answer "
      + "can have: the ledger beside it is the whole story", dB?.can_retry === false
      && dB?.why_not === "The office already acted on this delivery — the ledger beside it is the "
      + "whole story.", dB);
    const dE = await det("the whole of the spent delivery", E?.id);
    check("…and the spent one lists all five attempts in the order they were made, each with the "
      + "seat, the role and what the definer answered, and refuses a sixth with the ceiling in its "
      + "words rather than a number", dE?.attempts?.length === 5
      && same((dE?.attempts ?? []).map((a: any) => String(a.attempt)), ["1", "2", "3", "4", "5"])
      && dE?.attempts?.[4]?.outcome === "failed" && dE?.attempts?.[0]?.acted_role
      === "finance_officer" && dE?.can_retry === false
      && dE?.why_not === "Five attempts is the ceiling and this delivery has spent it. The next "
      + "answer has to come from the rail, not from this desk.",
      { att: dE?.attempts?.length, why: dE?.why_not, can: dE?.can_retry });
    const dG = await det("the delivery another desk already spent", G?.id);
    check("…while the same delivery read by THIS desk answers exactly what its own board said: the "
      + "attempts it lists are bound to the tenant and come back empty, and the ceiling behind "
      + "`can_retry` is counted over the same pile, so a desk that renders the board and then opens "
      + "the detail sees one answer, not two", dG?.attempts?.length === 0
      && dG?.can_retry === true && dG?.why_not === null, dG);
    note("…which is the first of the three divergences this gate found in 135, and the first 137 "
      + "closed: the "
      + "board's `can_retry` counted attempts with `tenant_id = p_tenant` and the one-delivery read "
      + "counted them with only `webhook_id`. A desk that renders the board's flag and then reads the "
      + "detail showed a button its own read refused with a sentence about attempts it did not list. "
      + "The ceiling is per desk on purpose — 135's own header says a retry cannot bill or extend "
      + "anything twice, because 009's completion is idempotent, so five is about a seat's time and a "
      + "rail's support ticket, not about money.");
    const dH = await det("the delivery whose reference is an empty string", H?.id);
    check("…and the blank one is now refused by the read in the same words the door uses: the read "
      + "tests the reference's TEXT, so an empty string that the key-existence test once waved "
      + "through closes the button and names the charge that is missing",
      dH?.can_retry === false && dH?.why_not === "This payload names no charge, so there is nothing "
      + "here to re-drive. The reference a rail pushes is what the completion is asked for."
      && dH?.payload?.reference === "" && dH?.payload_keys?.includes("reference"), dH);
    note("…the second divergence, also 137's: `payload ? 'reference'` is a test of a key's existence "
      + "and `coalesce(payload->>'reference','') <> ''` is a test of its text. 135 used the first in "
      + "the read's `can_retry` and the second in the board's `can_retry`, in the charge join and in "
      + "the door, so a rail that posts `reference: \"\"` was handed an enabled button by the read and "
      + "refused by the door. The board's `readable` still asks the existence question, and that one "
      + "is a different question — \"can a seat read this body at all\", not \"may this be re-driven\" "
      + "— which the web desk already draws as its parse half alone.");
    const noId = await det("a delivery id that never arrived", randomUUID());
    check("a delivery read by an id the platform has never seen answers in words rather than an "
      + "empty object, because a seat holding a clipboard needs to know which of the two it lost",
      noId?.error === "No delivery reached the platform with that id."
      && noId?.id === undefined && noId?.payload === undefined, noId);
    const notDesk = await det("a company reading the rails", A?.id, CO);
    check("…and a company cannot ask for one of the platform's deliveries at all — the sentence is "
      + "the board's own, with the desk rather than the session named",
      notDesk?.error === "The rails answer to the platform office, and this is not that desk."
      && notDesk?.id === undefined, notDesk);
    const LID = await rawSend("the delivery whose body carries a phone", {
      reference: `${T}-LEAK`, outcome: "approved", phone: "0751234567", nida: "199001014321",
      payer_phone: "0781239999", card_number: "4111111111111111",
      meta: { cvv: "123", kind: "receipt" } });
    const leakBoard = await board("the desk typed a reference, not a phone", null, "all",
      `${T}-LEAK`, null, null);
    check("…and the pile stays countable while the body is being proved: nothing here names a "
      + "delivery by the payer's own number, so the row a seat finds is found by the reference alone",
      leakBoard?.count === 1 && leakBoard?.rows?.[0]?.reference === `${T}-LEAK`
      && !JSON.stringify(leakBoard ?? "").includes("0751234567"), leakBoard);
    const dL = await det("the delivery whose body carries a phone", LID);
    check("the payload a seat is shown is the scrubbed one: four of the seven keys the rail pushed "
      + "are gone, the value of none of them is anywhere in the answer, and the two the office needs "
      + "to do its job — the reference and the outcome — are exactly what is left standing, with the "
      + "harmless `meta` walking in beside them",
      same(Object.keys(dL?.payload ?? {}).sort(), ["meta", "outcome", "reference"])
      && dL?.payload?.reference === `${T}-LEAK` && dL?.payload?.outcome === "approved"
      && dL?.payload?.meta?.kind === "receipt" && dL?.payload?.meta?.cvv === undefined
      && !JSON.stringify(dL?.payload ?? "").includes("0751234567")
      && !JSON.stringify(dL ?? "").includes("4111111111111111"), dL);
    check("…while `payload_keys` is read off the RAW body, so the names the delivery carried are "
      + "still listed even though every value behind them is gone: a seat can see what was hidden, "
      + "which is the difference between a scrub and a silent lie — and the nested `cvv` is not in "
      + "the list, because the list is the top level of the body",
      same(dL?.payload_keys ?? [], ["card_number", "meta", "nida", "outcome", "payer_phone",
        "phone", "reference"]), dL?.payload_keys);
    const dL2 = await det("the same delivery read by another office's desk", LID, OB);
    check("…and a second platform book may read the same delivery, because the rails answer to the "
      + "platform rather than to one office: it gets the body, the scrubbed, and its own empty "
      + "attempt list — which is 135's promise that a gateway read is never a PII read, whatever "
      + "desk asks", dL2?.id === String(LID) && dL2?.attempts?.length === 0
      && dL2?.payload?.phone === undefined, dL2);
  });

  // ---------------- 13 · the press, worked end to end ----------------
  phase("13 · the retry door: the licence that lands, the ledger that records it, and the count "
    + "that afterwards says nothing");
  /** Everything this section does moves money — a completion that approves a charge, marks an invoice
   *  paid and runs a licence out to a dated day — so it lives in one savepoint that is rolled back at
   *  the end. That is also why it can be run at all: 009's completion writes the office's real table,
   *  and the only guarantee keeping a rehearsal from billing a real company is the `rollback`. */
  await undo("the retry desk", async () => {
    const T = R("RTY");
    const press = (label: string, webhook: any, book = OF, actor = PEN, role = "support_engineer") =>
      call(label, RETRY_SQL, [book, webhook, actor, role, "10.0.0.7", "Recon Gate 135 desk"]);
    const attOf = async (webhook: any, book = OF) => (await oi(
      `select attempt, outcome, tenant_id, intent_reference, payment_status, message, answer,
              acted_by, acted_role, ip, user_agent
         from gateway_webhook_attempts where webhook_id = $1 and tenant_id = $2 order by attempt`,
      [webhook, book])).rows as Record<string, any>[];
    const auOf = async (action: string, book: string) => (await oi(
      `select entity, entity_id, actor_user_id, actor_role, ip, user_agent, after
         from audit_logs where action = $1 and tenant_id = $2 order by ts`,
      [action, book])).rows as Record<string, any>[];
    /** The whole picture a landed completion is supposed to have painted, in one read: the charge, the
     *  bill behind it, the subscription the licence runs out on, and the book's own expiry day. */
    const paper = async (pay: any) => one(`select p.status, p.completed_at, p.provider_txn_id,
        p.invoice_id, i.status as invoice_status, i.paid_at, s.status as sub_status,
        s.current_period_start, s.current_period_end, t.status as tenant_status,
        t.licence_expires_at, to_char(t.licence_expires_at, 'YYYY-MM-DD') as licence_day
      from payments p
      left join invoices i on i.id = p.invoice_id
      left join subscriptions s on s.tenant_id = p.tenant_id and s.deleted_at is null
      join tenants t on t.id = p.tenant_id where p.id = $1`, [pay]);
    const bill = async (number: string, amount: string) => {
      const inv = randomUUID();
      const rows = await okDo(`…and the invoice ${number} the charge belongs to`, `insert into invoices
          (id, tenant_id, number, billing_cycle, seats, amount_subtotal, vat_rate, vat_amount,
           amount_total, currency, status, period_start, period_end)
         values ($1,$2,$3,'monthly',5,$4,0.18,$5,$6,'TZS','issued',$7::date,$7::date)
         returning id`,
        [inv, CO, number, amount, (Number(amount) * 0.18).toFixed(2),
          (Number(amount) * 1.18).toFixed(2), D]);
      return rows.length ? rows[0].id : null;
    };
    /** A delivery whose body is whatever the section needs it to be, including the two shapes `send()`
     *  cannot make: a body with no reference key at all, and an event word of zero length. */
    let nRaw = 0;
    const raw = async (tag: string, o: { event?: string; payload?: any; valid?: boolean;
      at?: string } = {}) => {
      nRaw++;
      const rows = await okDo(`a delivery ${tag} is planted with a body of its own`,
        `insert into payment_webhooks (id, provider, event_type, signature_valid, replay_nonce,
           payload, created_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz) returning id`,
        [randomUUID(), RAIL, o.event ?? "approved", o.valid !== false, `${STAMP}-rty${nRaw}`,
          JSON.stringify(o.payload ?? {}), `${D}T${o.at ?? "10:00"}:00`]);
      return rows.length ? rows[0].id : null;
    };
    const droveAt = async (book: string, tag: string, webhook: string, times: number) => {
      for (let i = 1; i <= times; i++) await okDo(`…and drive ${i} of ${tag} from another desk`,
        `insert into gateway_webhook_attempts (id, tenant_id, webhook_id, attempt, outcome,
           intent_reference, payment_status, message, answer, acted_by, acted_role, ip)
         values ($1,$2,$3,$4,'succeeded',$5,'approved',$6,'{}'::jsonb,$7,'support_engineer',
           '10.0.0.8')`,
        [randomUUID(), book, webhook, i, tag,
          `Recon Gate ${STAMP} another office's desk re-drove this delivery and it landed`, QUILL]);
    };
    const notLanded = (rows: Record<string, any>[]) =>
      rows.filter((f) => f.check_name === "webhook_not_landed").map((f) => String(f.subject_ref));

    // ~~~~~ the one press that proves the whole stage ~~~~~
    const refA = `${T}-LAND`;
    const INV = await bill(`${T}-INV`, "250000.00");
    const PAY = await charge("the charge the office is waiting on", refA, "pending", "250000.00");
    if (PAY && INV) await okDo("…and the charge points at its invoice",
      `update payments set invoice_id = $1 where id = $2 returning id`, [INV, PAY]);
    await okDo("…and the company's own subscription, so the licence has a row to run out",
      `insert into subscriptions (id, tenant_id, plan_id, billing_cycle, status, seats_licensed)
       values ($1,$2,(select id from plans where key = 'starter'),'monthly','trial',5)`,
      [randomUUID(), CO]);
    const A = await send("the delivery nobody acted on", { ref: refA, event: "approved",
      outcome: "approved", at: "09:00" });

    const pre = await counted("the office counts the gateway before the press", "gateway", "TZS", D, D);
    const preRows = pre?.run?.id ? await fnd(pre.run.id) : [];
    const fA = preRows.find((f) => f.check_name === "webhook_not_landed"
      && String(f.subject_ref) === refA) ?? {};
    check("before a seat touches it the delivery is 135's exception whole: the book holds nothing, "
      + "the paper holds the charge, and the difference is the money the rail says arrived",
      fA.subject_kind === "webhook" && String(fA.subject_id) === String(A?.id)
      && Number(fA.book_figure) === 0 && Number(fA.paper_figure) === 250000
      && Number(fA.difference) === -250000 && fA.verdict === "missing_book"
      && fA.detail?.payment_status === "pending" && fA.detail?.outcome_wanted === "approved"
      && Number(fA.detail?.attempts) === 0 && fA.detail?.event === "approved"
      && fA.detail?.provider === RAIL && fA.detail?.error === null
      && String(fA.detail?.why).includes(refA + " is pending for 250000.00 TZS")
      && String(fA.detail?.why).includes("so the money the rail says arrived has never settled"), fA);

    const p1 = await press("a desk re-drives the delivery", A?.id);
    const after = await paper(PAY);
    const day1 = String(after?.licence_day ?? "");
    check("…and the press is a fact rather than a hope: the door answers its own attempt number, the "
      + "word for what the completion said, and the whole delivery read back in the same breath",
      p1?.ok === true && p1?.attempt === 1 && p1?.outcome === "succeeded"
      && p1?.answer?.status === "ok" && p1?.answer?.payment_status === "approved"
      && p1?.answer?.licence_expires_at !== undefined
      && p1?.delivery?.id === String(A?.id) && p1?.delivery?.verified === true
      && p1?.delivery?.processed_at === null && p1?.delivery?.attempts?.length === 1
      && p1?.delivery?.charge?.status === "approved", p1);
    check("…and the completion is 009's whole effect, not a copy of it: the charge closed, the bill "
      + "paid, the subscription switched on and the company's licence run out to a dated day",
      after?.status === "approved" && after?.completed_at !== null
      && after?.invoice_status === "paid" && after?.paid_at !== null
      && after?.sub_status === "active" && after?.current_period_end !== null
      && after?.tenant_status === "active" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day1)
      && String(after?.current_period_end) === String(after?.licence_expires_at), after);
    check("…while the sentence a seat reads carries the three things only this press can name: the "
      + "reference, the company whose licence moved, and the day it moves to",
      String(p1?.message).includes(refA) && String(p1?.message).includes("is now approved")
      && String(p1?.message).includes(BOOK("Cargo Ltd"))
      && String(p1?.message).includes(`licence runs to ${day1}`), p1?.message);
    check("…and the rail's own transaction id is left alone, because a desk that re-drives an answer "
      + "does not invent a new one: the door passes null and 009's coalesce keeps the row as it was",
      after?.provider_txn_id === null, after?.provider_txn_id);

    const attA = await attOf(A?.id);
    check("the ledger holds exactly one row for the press, and every figure on it is the one the door "
      + "was holding when it wrote: the office's own book as the tenant, the reference, the state the "
      + "charge reached, and the seat, role, address and client that asked",
      attA.length === 1 && String(attA[0].tenant_id) === OF && attA[0].attempt === 1
      && attA[0].outcome === "succeeded" && attA[0].intent_reference === refA
      && attA[0].payment_status === "approved" && String(attA[0].acted_by) === PEN
      && attA[0].acted_role === "support_engineer" && attA[0].ip === "10.0.0.7"
      && attA[0].user_agent === "Recon Gate 135 desk" && attA[0].answer?.status === "ok"
      && attA[0].message === p1?.message, attA);

    const retriedA = await auOf("gateway.webhook.retried", OF);
    const approvedA = await auOf("payment.approved.retry", CO);
    const approvedOnOffice = await auOf("payment.approved.retry", OF);
    check("…and the two audits are written on the two books they are about: the office's own paper "
      + "trail for the press, and the company's for the licence that landed on it",
      retriedA.length === 1 && String(retriedA[0].entity) === "payment_webhooks"
      && String(retriedA[0].entity_id) === String(A?.id) && String(retriedA[0].actor_user_id) === PEN
      && retriedA[0].after?.attempt === 1 && retriedA[0].after?.outcome === "succeeded"
      && retriedA[0].after?.reference === refA && retriedA[0].after?.payment_status === "approved"
      && approvedA.length === 1 && approvedA[0].entity === "payments"
      && String(approvedA[0].entity_id) === String(PAY) && approvedA[0].after?.via === "desk retry"
      && approvedA[0].after?.reference === refA
      && String(approvedA[0].after?.webhook) === String(A?.id)
      && String(approvedA[0].actor_user_id) === PEN
      && approvedA[0].actor_role === "support_engineer" && approvedOnOffice.length === 0,
      { retried: retriedA, approved: approvedA, onOffice: approvedOnOffice });

    // ~~~~~ 136's own proof, in the only form it can take ~~~~~
    const rowA = await one(`select processed_at, signature_valid, event_type, payload
      from payment_webhooks where id = $1`, [A?.id]);
    check("the delivery itself did not move: a seat's press appends paper beside it and never "
      + "rewrites what the rail sent, so it keeps `processed_at IS NULL` for the rest of its life",
      rowA?.processed_at === null && rowA?.signature_valid === true && rowA?.event_type === "approved",
      rowA);
    const post = await counted("the office counts the gateway again, after the press", "gateway",
      "TZS", D, D);
    const postRows = post?.run?.id ? await fnd(post.run.id) : [];
    check("…and the count raised afterwards does NOT call that delivery one the office ignored: the "
      + "exception has gone, because the charge now says what the delivery asked for — which is 136's "
      + "whole reason for existing and the one thing no HTTP seat can show",
      !notLanded(postRows).includes(refA)
      && !postRows.some((f) => String(f.subject_ref) === refA), notLanded(postRows));
    check("…while every other unanswered delivery is still reported, so the absence above is one row "
      + "answered rather than the question switched off: the two counts differ by exactly this "
      + "reference and by nothing else",
      same(notLanded(postRows), notLanded(preRows).filter((x) => x !== refA)),
      { before: notLanded(preRows), after: notLanded(postRows) });

    const gb = await call("the board after the press", GH_BOARD_SQL, [OF, null, "stuck", refA, null,
      null]);
    const gB = await call("…and the same delivery looked for in the landed pile", GH_BOARD_SQL,
      [OF, null, "landed", refA, null, null]);
    const gR = await call("…and in the re-driven pile", GH_BOARD_SQL, [OF, null, "retried", refA,
      null, null]);
    check("…and the board still lists it as stuck and still offers the button, with the two attempts "
      + "beside it and the re-driven pile holding it too: a desk that reads only the piles would say "
      + "the office never answered a delivery it has answered twice",
      gb?.count === 1 && gb?.rows?.[0]?.can_retry === true && gb?.rows?.[0]?.attempts === 1
      && gB?.count === 0 && gR?.count === 1, { stuck: gb?.count, landed: gB?.count,
      retried: gR?.count, row: gb?.rows?.[0] });
    note("…which is why 136 binds the count to the CHARGE and not to the board. `processed_at` is the "
      + "only mark of an answered delivery the schema has, 005 keeps that table insert-only for "
      + "everybody because an internet stranger can reach it, and a retry is deliberately not allowed "
      + "to rewrite what the rail sent. So a re-driven delivery is permanently `stuck` to the board "
      + "and permanently answered to the book, and the pile is a work list, not a reconciliation.");

    // ~~~~~ the second press: an idempotent door says so instead of moving money twice ~~~~~
    const stamp1 = await one(`select to_char(p.completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as pay,
        to_char(i.paid_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as inv,
        to_char(t.licence_expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as lic
      from payments p join invoices i on i.id = p.invoice_id join tenants t on t.id = p.tenant_id
     where p.id = $1`, [PAY]);
    const p2 = await press("the same delivery re-driven from another seat", A?.id, OF, QUILL);
    const stamp2 = await one(`select to_char(p.completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as pay,
        to_char(i.paid_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as inv,
        to_char(t.licence_expires_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') as lic
      from payments p join invoices i on i.id = p.invoice_id join tenants t on t.id = p.tenant_id
     where p.id = $1`, [PAY]);
    check("…and a second press by a second seat cannot bill anybody again: the door runs the same "
      + "definer, takes 009's `already_final` as the honest answer it is, and reports it as its own "
      + "word rather than as a failure",
      p2?.ok === true && p2?.attempt === 2 && p2?.outcome === "already_final"
      && p2?.answer?.status === "already_final"
      && String(p2?.message).includes("was already approved before this attempt, so nothing moved"), p2);
    check("…to the second, on all three timestamps: nothing was re-run, so nothing was re-stamped",
      String(stamp2?.pay) === String(stamp1?.pay) && String(stamp2?.inv) === String(stamp1?.inv)
      && String(stamp2?.lic) === String(stamp1?.lic), { stamp1, stamp2 });
    const att2 = await attOf(A?.id);
    check("…while the ledger keeps both claims: two rows, numbered one apart, the second answering "
      + "`approved` because that is the state the charge is in — a later seat reading the pile sees "
      + "the press, not only the money",
      att2.length === 2 && att2[1].attempt === 2 && att2[1].outcome === "already_final"
      && att2[1].payment_status === "approved" && String(att2[1].acted_by) === QUILL, att2);
    const retried2 = await auOf("gateway.webhook.retried", OF);
    const approved2 = await auOf("payment.approved.retry", CO);
    check("…and only the office's own audit moves: the press is paper, so it is written twice, while "
      + "a licence that did not land a second time is written once",
      retried2.length === 2 && approved2.length === 1
      && retried2[1].after?.attempt === 2 && retried2[1].after?.outcome === "already_final",
      { retried: retried2.length, approved: approved2.length });

    // ~~~~~ the refusals that still spend paper ~~~~~
    const refU = `${T}-UNVER`;
    const PAYU = await charge("the charge behind an unsigned delivery", refU, "pending", "90000.00");
    const U = await send("a delivery whose signature never matched", { ref: refU, event: "approved",
      outcome: "approved", valid: false, at: "09:10" });
    const pU = await press("a desk re-drives an unsigned delivery", U?.id);
    const attU = await attOf(U?.id);
    const auU = await auOf("gateway.webhook.refused", OF);
    const payU = await one(`select status, completed_at from payments where id = $1`, [PAYU]);
    check("an unsigned delivery is refused in words a seat can act on, and the fix named is the "
      + "rail's secret rather than the charge — while the charge is left exactly as it was",
      pU?.ok === false && pU?.error === "not_verified" && pU?.attempt === 1
      && String(pU?.message).includes("signature did not match")
      && String(pU?.message).includes("check the webhook secret on " + RAIL)
      && payU?.status === "pending" && payU?.completed_at === null, { ans: pU, payU });
    check("…and the refusal is still an attempt: one row in the ledger outcome `refused`, carrying the "
      + "reason rather than a completion answer, and one refused audit on the office's book. The two "
      + "sentences are deliberately not the same one: the ledger keeps the record of the act — who "
      + "asked, for what, and that nothing left the building — while the answer is the instruction the "
      + "seat reads, and only it names the rail's secret",
      attU.length === 1 && attU[0].attempt === 1 && attU[0].outcome === "refused"
      && attU[0].intent_reference === null && attU[0].payment_status === null
      && attU[0].answer?.reason === "unverified_signature" && attU[0].answer?.event === "approved"
      && String(attU[0].message).includes("role support_engineer")
      && String(attU[0].message).includes("never verified its signature")
      && String(attU[0].message).includes("nothing was sent anywhere")
      && attU[0].message !== pU?.message && auU.length === 1
      && auU[0].after?.why === "signature was never valid"
      && String(auU[0].entity_id) === String(U?.id),
      { ledger: attU[0]?.message, answer: pU?.message, au: auU.length,
        why: auU[0]?.after?.why, ent: String(auU[0]?.entity_id), want: String(U?.id) });

    const refS = `${T}-SPEND`;
    const UG = await send("an unsigned delivery that has already spent its five",
      { ref: refS, event: "approved", outcome: "approved", valid: false, at: "09:15" });
    if (UG) await drove(refS, UG.id, 5);
    const before = await attOf(UG?.id, OF);
    const pS = await press("a desk re-drives an unsigned delivery that has spent its five", UG?.id);
    check("the ceiling is checked before the signature, and a spent delivery writes nothing even when "
      + "it is also unsigned: the seat hears the number it spent rather than a fault it could not fix",
      pS?.ok === false && pS?.error === "attempts_spent" && pS?.attempts === 5
      && String(pS?.message).includes("already been re-driven 5 times")
      && String(pS?.message).includes("talk to " + RAIL)
      && (await attOf(UG?.id, OF)).length === before.length, { ans: pS, rows: before.length });

    const refN = `${T}-NOREF`;
    const leaky = await raw("a body that names no charge and carries a phone",
      { payload: { provider: RAIL, outcome: "approved", phone: "0751234567",
        nida: "199001014321" }, at: "09:20" });
    const pN = await press("a desk re-drives a body that names no charge", leaky);
    const attN = await attOf(leaky);
    const auN = (await auOf("gateway.webhook.refused", OF)).filter((r) =>
      String(r.entity_id) === String(leaky));
    check("a delivery with no reference is refused before anything is asked of the completion, in the "
      + "plain words of a body that simply does not name a charge",
      pN?.ok === false && pN?.error === "no_reference" && pN?.attempt === 1
      && String(pN?.message).includes("This delivery carries no reference")
      && String(pN?.message).includes("so there is nothing to re-drive."), pN);
    check("…and what the ledger keeps of that body is the scrubbed one: the reason and the event are "
      + "there for the next seat, the payer's number and the NIDA are not, and the refusal is audited "
      + "with the office's own words for why",
      attN.length === 1 && attN[0].outcome === "refused"
      && attN[0].answer?.reason === "no_reference"
      && Object.keys(attN[0].answer?.payload ?? {}).every((k) => k !== "phone" && k !== "nida")
      && attN[0].answer?.payload?.outcome === "approved"
      && !JSON.stringify(attN).includes("0751234567") && !JSON.stringify(attN).includes("199001014321")
      && auN.length === 1 && auN[0].after?.why === "the payload names no charge",
      { att: attN, au: auN });

    const unparsed = await raw("a body the platform could not read at all",
      { event: "unparsed", payload: { raw: "MPESA|abc" }, at: "09:25" });
    const pP = await press("a desk re-drives a body the platform could not parse", unparsed);
    check("…and when the rail posted something the platform never parsed, the seat is told so instead "
      + "of being told it forgot a reference: the same refusal, with the honest sentence attached",
      pP?.ok === false && pP?.error === "no_reference"
      && String(pP?.message).includes("the rail posted a body the platform could not read at all")
      && String(pP?.message).includes("The event the rail sent is all this row knows."), pP?.message);

    // ~~~~~ the words the definer answers with ~~~~~
    const refG = `${T}-GHOST`;
    const GH = await send("a delivery naming a reference nobody carries", { ref: refG,
      event: "approved", outcome: "approved", at: "09:30" });
    const pG = await press("a desk re-drives a delivery whose reference is not ours", GH?.id);
    const attG = await attOf(GH?.id);
    check("a reference that is not the platform's is answered as a failure, not as an error: the "
      + "delivery is real, the charge is not, and the sentence says which of the two the office has lost",
      pG?.ok === true && pG?.attempt === 1 && pG?.outcome === "failed"
      && pG?.answer?.status === "not_found" && String(pG?.message).includes("The delivery is real; "
        + "the reference is not ours"), pG);
    check("…and the ledger row for it holds no payment state, because there was no charge to hold one "
      + "on: the reference is kept, the state is null, and nothing about a licence was written",
      attG.length === 1 && attG[0].outcome === "failed" && attG[0].intent_reference === refG
      && attG[0].payment_status === null
      && (await auOf("payment.approved.retry", CO)).length === 1, attG);

    const refI = `${T}-ODDEV`;
    const PAYI = await charge("the charge behind an odd event word", refI, "pending", "120000.00");
    const I = await send("a delivery whose event is a word a charge cannot be closed with",
      { ref: refI, event: "refunded", at: "09:35" });
    const pI = await press("a desk re-drives a delivery asking for a fifth outcome", I?.id);
    const payI = await one(`select status from payments where id = $1`, [PAYI]);
    check("a rail's odd event word is refused rather than guessed at: 009 answers `invalid_status`, "
      + "this door has a word for it called `refused`, and the charge is untouched",
      pI?.ok === true && pI?.outcome === "refused" && pI?.answer?.status === "invalid_status"
      && String(pI?.message).includes("asked for refunded")
      && String(pI?.message).includes("not one of the four outcomes a charge can be closed with")
      && payI?.status === "pending", { ans: pI, payI });

    const refF = `${T}-FALLBK`;
    const PAYF = await charge("the charge the parsed word is asked to close", refF, "pending",
      "120000.00");
    const F = await send("a delivery whose odd event hides a real outcome", { ref: refF,
      event: "refunded", outcome: "approved", at: "09:40" });
    const pF = await press("a desk re-drives the delivery whose outcome the route had parsed", F?.id);
    const payF = await one(`select status from payments where id = $1`, [PAYF]);
    check("…while the parsed outcome wins over the event word: the rail's own name for the delivery "
      + "is not one of the four, but the intake route had already worked out what it asked for, and "
      + "that is what the completion is told",
      pF?.ok === true && pF?.outcome === "succeeded" && pF?.answer?.status === "ok"
      && payF?.status === "approved", { ans: pF, payF });
    note("…and the fifth branch of 009's answer list, `invalid_transition`, cannot be provoked through "
      + "this door at all: 005's state machine allows pending to every word the retry can hand it, and "
      + "a charge that is not pending is answered `already_final` before the machine is consulted. The "
      + "door's sentence for it is written and unreachable, which is worth knowing on the day somebody "
      + "adds a state to 005 and finds this branch still says nothing about it.");

    // ~~~~~ the raised path, without touching the schema ~~~~~
    const refX = `${T}-RAISED`;
    const PAYX = await charge("the charge behind a delivery with no event word", refX, "pending",
      "75000.00");
    const X = await raw("a delivery whose event word is empty", { event: "",
      payload: { provider: RAIL, reference: refX }, at: "09:45" });
    const pX = await press("a desk re-drives a delivery with no event word at all", X);
    const attX = await attOf(X);
    const payX = await one(`select status, completed_at from payments where id = $1`, [PAYX]);
    check("a delivery with neither an event word nor a parsed outcome is the one shape that reaches "
      + "the completion with nothing to say, and the door survives it: 009's own `not in (...)` guard "
      + "cannot fire on a NULL, the state machine cannot either, and the NOT NULL on the charge's "
      + "status is what answers — caught, recorded and reported",
      pX?.ok === true && pX?.outcome === "failed" && pX?.answer?.status === "raised"
      && pX?.answer?.sqlstate === "23502"
      && String(pX?.message).startsWith("Re-driving the completion failed the same way it failed the "
        + "first time: ") && String(pX?.message).includes("status")
      && String(pX?.message).includes("not-null"), { ans: pX, att: attX });
    check("…and nothing was left half-written: the exception is caught inside the door's own block, "
      + "which takes the charge, the bill and the licence back with it, so the office is told the "
      + "failure landed and sees a pending charge behind the sentence",
      payX?.status === "pending" && payX?.completed_at === null && attX.length === 1
      && attX[0].outcome === "failed" && attX[0].payment_status === "pending"
      && attX[0].answer?.status === "raised", { payX, att: attX });
    note("…which is also a defect report on 009 rather than on 135: `if p_new_status not in (...)` is "
      + "NULL for a NULL argument, so the guard that reads like a validation is skipped by the very "
      + "value it should refuse, and the table's NOT NULL is what catches it. The retry door is safe "
      + "only because it wraps the call in its own exception block. Every other caller of "
      + "`complete_payment` gets the raise and no ledger row at all.");

    // ~~~~~ who may press, and what the ceiling is really counted over ~~~~~
    await refusal("a company's desk asks for a rail's delivery to be re-driven", "not_the_office",
      RETRY_SQL, [CO, A?.id, BOSS, "director", "10.0.0.7", "Recon Gate 135 desk"]);
    check("…and it writes nothing while it says no: the two refusals that come before the numbering "
      + "are the two that cost the office nothing, so a stranger hammering the endpoint cannot fill "
      + "the ledger", (await attOf(A?.id)).length === 2
      && (await auOf("gateway.webhook.refused", CO)).length === 0,
      { att: (await attOf(A?.id)).length });
    const missing = await press("a desk re-drives a delivery id the platform has never seen",
      randomUUID());
    check("…while a delivery that never arrived is answered in words and also writes no row — the "
      + "door cannot number an attempt against a row it has not found",
      missing?.ok === false && missing?.error === "not_found"
      && String(missing?.message).includes("The board lists what arrived"), missing);

    const refO = `${T}-OTHER`;
    const PAYO = await charge("the charge another office has not touched", refO, "pending",
      "310000.00");
    const O = await send("a delivery five of whose attempts belong to another desk", { ref: refO,
      event: "approved", outcome: "approved", at: "09:50" });
    if (O) await droveAt(OB, refO, O.id, 5);
    const obBoard = await call("the board asked by the desk that has spent its five", GH_BOARD_SQL,
      [OB, null, "stuck", refO, null, null]);
    const ofBoard = await call("the same delivery on the board of a desk that has spent none",
      GH_BOARD_SQL, [OF, null, "stuck", refO, null, null]);
    const ofDet = await call("…and read whole by that desk", GH_DETAIL_SQL, [OF, O?.id]);
    check("the ceiling is one question and both reads answer it the same way: one office's five "
      + "attempts is a spent button in that office's board and its own read, and an open one in "
      + "another office's board and its own read, on the same row of the same table",
      obBoard?.rows?.[0]?.attempts === 5 && obBoard?.rows?.[0]?.can_retry === false
      && ofBoard?.rows?.[0]?.attempts === 0 && ofBoard?.rows?.[0]?.can_retry === true
      && ofDet?.attempts?.length === 0 && ofDet?.can_retry === true
      && ofDet?.why_not === null,
      { ob: obBoard?.rows?.[0], of: ofBoard?.rows?.[0],
        det: { can: ofDet?.can_retry, why: ofDet?.why_not, att: ofDet?.attempts?.length } });
    const oO = await press("a second desk re-drives a delivery a first desk has spent its five on",
      O?.id, OF, PEN, "support_engineer");
    const oAtt = await attOf(O?.id, OF);
    const oAu = await auOf("gateway.webhook.retried", OF);
    const oPay = (await one(`select status from payments where id = $1`, [PAYO]))?.status;
    const oHit = oAu.some((a) => String(a.after?.reference ?? "") === refO
      && a.after?.attempt === 1);
    check("…and the door agrees with both of them and finishes the job it started: the count it "
      + "checks is this desk's, the number it writes is this desk's, and the row that says it landed "
      + "is allowed to exist beside the other office's five",
      oO?.ok === true && oO?.attempt === 1 && oO?.outcome === "succeeded"
      && oAtt.length === 1 && oAtt[0].attempt === 1 && oAtt[0].outcome === "succeeded"
      && oPay === "approved" && oHit,
      { press: [oO?.ok, oO?.attempt, oO?.outcome], row: [oAtt.length, oAtt[0]?.attempt,
        oAtt[0]?.outcome], pay: oPay, hit: oHit, aud: oAu.map((a) => [a.after?.attempt,
          String(a.after?.reference ?? "").slice(-9)]) });
    const pC = await press("a third office's desk re-drives the same delivery", O?.id, OC, CLERK,
      "compliance_officer");
    check("…and a third book gets its own number one, and the honest answer its own door gives a "
      + "charge a second desk already closed — seven rows on one delivery, in three numbered piles, "
      + "which is the shape 135's ledger forbade",
      pC?.ok === true && pC?.attempt === 1 && pC?.outcome === "already_final"
      && pC?.answer?.status === "already_final" && (await attOf(O?.id, OC)).length === 1
      && (await attOf(O?.id, OB)).length === 5 && (await attOf(O?.id, OF)).length === 1
      && (await one(`select count(*)::int as n from gateway_webhook_attempts
        where webhook_id = $1`, [O?.id]))?.n === 7
      && (await one(`select status from payments where id = $1`, [PAYO]))?.status === "approved",
      { ans: pC, ob: (await attOf(O?.id, OB)).length, of: (await attOf(O?.id, OF)).length,
        oc: (await attOf(O?.id, OC)).length });
    note("…which is the seam 135 left and 137 closed. `gateway_webhook_attempts` was UNIQUE "
      + "(webhook_id, attempt) while the door numbered attempts over `webhook_id AND tenant_id`, so "
      + "the second platform desk reached 009's completion, landed the licence, and then could not "
      + "write the row that said it had — the raise escaped a door that wraps only the completion, so "
      + "the whole statement came undone and the office kept no audit of a press it had actually "
      + "made. This gate planted a second platform book and felt it; the migration that renamed the "
      + "key is proved above by the same seven rows the old one could not hold.");

    // ~~~~~ the door has no test for a delivery the rail already answered ~~~~~
    const refP = `${T}-PROCD`;
    const PAYP = await charge("the charge left open behind an answered delivery", refP, "pending",
      "420000.00");
    const P = await send("a delivery the platform already processed, whose write moved no charge",
      { ref: refP, event: "approved", outcome: "approved", done: true, at: "09:55" });
    const pP2 = await press("a desk re-drives a delivery the board calls landed", P?.id);
    const pb = await call("…and the pile it belongs to", GH_BOARD_SQL, [OF, null, "landed", refP,
      null, null]);
    const pd = await call("…and its one-delivery read", GH_DETAIL_SQL, [OF, P?.id]);
    check("a delivery the platform processed is refused its button by both reads and yet re-driven by "
      + "the door, because 135 tests the signature, the ceiling and the reference and never the "
      + "processed mark: the completion lands a charge the intake route itself failed to close",
      pP2?.ok === true && pP2?.attempt === 1 && pP2?.outcome === "succeeded"
      && (await one(`select status from payments where id = $1`, [PAYP]))?.status === "approved"
      && pb?.rows?.[0]?.can_retry === false && pd?.can_retry === false
      && String(pd?.why_not).startsWith("The office already acted on this delivery"),
      { ans: pP2, board: pb?.rows?.[0]?.can_retry, det: pd?.can_retry });
    note("…and that is the divergence 137 left standing, deliberately, and the only one of the three "
      + "this gate found that can cost money: "
      + "`processed_at IS NOT NULL` means the platform tried to act, not that it succeeded, and 009's "
      + "idempotence is what makes a re-drive of it safe rather than merely allowed. The door's own "
      + "header says the ceiling is about a person's time and not about money, and here it is true — "
      + "a second completion of an answered delivery cannot activate a licence twice. What it does "
      + "prove is that `processed` is not `acted`, which is the same sentence 136 was written for.");
  });

  // ---------------- 14 · the duties and the two desks' words ----------------
  phase("14 · the two new duties, the seats that hold them, and whether the doors and the desks "
    + "still speak one vocabulary");
  /** 135's own words for a duty, read out of the file rather than retyped here: the description a
   *  seat sees on the roles desk is the sentence the migration wrote, and a gate that compared it to a
   *  literal in this file would agree with the literal the day the sentence changed. */
  const KEYS = ["control.money.recon", "control.gateway.retry"];
  const dutyLiteral = (key: string) => {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const blocks = [...src.matchAll(/insert into permissions \(key, description\) values\n([\s\S]*?)\non conflict do nothing;/g)];
    for (const b of blocks) {
      const hit = new RegExp(`\\('${esc}',\\s*\\n?\\s*'((?:[^']|'')*)'`).exec(b[1]);
      if (hit) return hit[1].replace(/''/g, "'");
    }
    return "";
  };
  const duties = (await oi(`select key, description from permissions where key = any($1::text[])`,
    [KEYS])).rows as Record<string, any>[];
  const holders = (await oi(`select p.key as duty, r.key as role
      from role_permissions rp join roles r on r.id = rp.role_id
      join permissions p on p.key = rp.permission_key
     where p.key = any($1::text[]) and r.tenant_id is null order by 1,2`, [KEYS]))
    .rows as Record<string, any>[];
  /** Every duty the platform seeds, in the same shape: a separation of two keys is only proved by
   *  naming the roles on both sides of it. */
  const allHolders = (await oi(`select p.key as duty, r.key as role
      from role_permissions rp join roles r on r.id = rp.role_id
      join permissions p on p.key = rp.permission_key
     where p.key = any($1::text[]) and r.tenant_id is null`,
    [["control.money.recon", "control.money.post", "control.money.view", "control.gateway.retry",
      "control.gateway.manage", "control.gateway.view"]])).rows as Record<string, any>[];
  const holds = (duty: string) => allHolders.filter((h) => h.duty === duty).map((h) => h.role);

  check("135's two duties are in the catalog with the sentences 135 wrote, apostrophes and all: a "
    + "seat reading the roles desk is reading the migration's own reason for the key, which is the "
    + "only defence against a duty whose name has outlived its purpose",
    duties.length === 2 && KEYS.every((k) => {
      const want = dutyLiteral(k);
      const got = String(duties.find((d) => d.key === k)?.description ?? "");
      return want.length > 40 && got === want;
    }), KEYS.map((k) => [k, dutyLiteral(k), String(duties.find((d) => d.key === k)?.description ?? "")]));
  check("…while the count is held by exactly the three seats that settle and adjudicate, and the "
    + "re-drive by exactly the two that answer a rail and answer for the platform — read as the "
    + "catalog's rows and compared to the lists 135's own insert-select wrote",
    same(holders.filter((h) => h.duty === "control.money.recon").map((h) => h.role),
      wordsInList(src, "select r.id, 'control.money.recon'"))
    && same(holders.filter((h) => h.duty === "control.money.recon").map((h) => h.role),
      ["super_admin", "finance_officer", "compliance_officer"])
    && same(holders.filter((h) => h.duty === "control.gateway.retry").map((h) => h.role),
      wordsInList(src, "select r.id, 'control.gateway.retry'"))
    && same(holders.filter((h) => h.duty === "control.gateway.retry").map((h) => h.role),
      ["super_admin", "support_engineer"]),
    holders);
  check("…and neither new duty is a courtesy extended to an old one: the seat that can post money "
    + "cannot order a count of it, and the seat that can re-drive a delivery cannot switch a rail off "
    + "for every company on the platform — the two sets differ in both directions, which is what "
    + "135's comments claim and what a seat's own role row is the only witness of",
    !holds("control.money.post").includes("compliance_officer")
    && !holds("control.money.recon").includes("billing_admin")
    && !holds("control.gateway.manage").includes("support_engineer")
    && holds("control.gateway.retry").includes("support_engineer")
    && holds("control.money.recon").includes("finance_officer"),
    { post: holds("control.money.post"), recon: holds("control.money.recon"),
      manage: holds("control.gateway.manage"), retry: holds("control.gateway.retry") });
  const seeded = [...src.matchAll(/select r\.id, '([a-z._]+)'/g)].map((m) => m[1]);
  check("…and the reading duty is unchanged: 135 seeds role rows for exactly its two new keys and "
    + "names no other duty in a `select r.id, …`, so the ledger's own `control.money.view` still "
    + "belongs to the six seats 133 chose it for — the analyst and the auditor are among them and "
    + "cannot order a count of the book they read, which is the separation the sentence above 135's "
    + "own insert claims",
    same(seeded, KEYS) && (src.match(/insert into role_permissions/g) ?? []).length === 2
    && ["platform_analyst", "auditor"].every((r) => holds("control.money.view").includes(r))
    && ["platform_analyst", "auditor"].every((r) => !holds("control.money.recon").includes(r))
    && holds("control.gateway.view").includes("support_engineer"),
    { seeded, view: holds("control.money.view"), recon: holds("control.money.recon") });

  const door = (name: string) => bodyOf(proc.find((p) => p.name === name)?.def ?? "");
  const boardDef = door("gateway_webhook_board");
  const retryDef = door("retry_gateway_webhook");
  const runDef = door("run_money_reconciliation");
  const routeConst = (text: string, name: string) =>
    new RegExp(`const ${name} = "([a-z._]+)"`).exec(text)?.[1] ?? "";
  check("the two desks' keys are the migration's keys, read out of each route file and asked of the "
    + "catalog: a guard holding a string nobody seeded is a door that never opens, and the mistake "
    + "made once in this schema's life was a duty named in TypeScript only",
    routeConst(moneyRoute, "RECON") === "control.money.recon"
    && routeConst(gateRoute, "RETRY") === "control.gateway.retry"
    && routeConst(reconPage, "RECON") === "control.money.recon"
    && routeConst(gatewayPage, "RETRY") === "control.gateway.retry"
    && KEYS.every((k) => duties.some((d) => d.key === k)),
    { RECON: routeConst(moneyRoute, "RECON"), RETRY: routeConst(gateRoute, "RETRY"),
      page: [routeConst(reconPage, "RECON"), routeConst(gatewayPage, "RETRY")] });

  const reconPaths = [...moneyRoute.matchAll(/app\.(get|post|delete)\("([^"]*)"/g)]
    .map((m) => m[2]).filter((p) => p.startsWith("/control/money/recon"));
  const guardedRecon = (path: string) => {
    const a = moneyRoute.indexOf(`"${path}"`);
    return a < 0 ? "" : moneyRoute.slice(a, a + 400);
  };
  check("every one of the five recon paths is guarded by the count's own duty and by nothing looser: "
    + "the board, the run, the detail, the signature and the discard are one duty in the migration and "
    + "five doors on the wire, and a route that forgot to knock is a route a company's seat could read",
    reconPaths.length === 5 && same(reconPaths, ["/control/money/recon", "/control/money/recon/run",
      "/control/money/recon/:id", "/control/money/recon/:id/sign",
      "/control/money/recon/:id/discard"])
    && reconPaths.every((p) => guardedRecon(p).includes("requireControlPermission(req, RECON)")),
    reconPaths);
  /** The statement is printed for one account, and its three paper files are one builder's argument —
   *  so the guard of a `.csv` is not written beside its path and has to be read off the builder. */
  const STMT = "/control/money/accounts/:id/statement";
  const stmtBlock = moneyRoute.slice(moneyRoute.indexOf(`"${STMT}"`));
  check("…while the statement and its three files keep the book's own read key rather than the "
    + "count's, because 135's comment says so and the route file has to agree: a desk that can only "
    + "read the ledger is still owed a line of it, the seat who cannot order a count can still print "
    + "the page an auditor asks for, and a print files an audit row of its own",
    moneyRoute.includes(`"${STMT}"`)
    && stmtBlock.slice(0, 400).includes("requireControlPermission(req, VIEW)")
    && !stmtBlock.slice(0, 400).includes("requireControlPermission(req, RECON)")
    && ["csv", "xlsx", "pdf"].every((e) => moneyRoute.includes(`statement.${e}"`))
    && moneyRoute.slice(moneyRoute.indexOf("const statementFile"),
      moneyRoute.indexOf("const statementFile") + 400)
      .includes("requireControlPermission(req, VIEW)")
    && moneyRoute.includes("control.money.statement_"),
    stmtBlock.slice(0, 300));
  const gPaths = [...gateRoute.matchAll(/app\.(get|post)\("([^"]*)"/g)].map((m) => m[2]);
  const gateGuarded = (path: string, key: string) => {
    const a = gateRoute.indexOf(`"${path}"`);
    return a < 0 ? false : gateRoute.slice(a, a + 400).includes(`requireControlPermission(req, ${key})`);
  };
  check("and on the rails desk the three paths split the way 135 split them: the pile and the one "
    + "delivery read answer to `view`, the press answers to `retry`, and no path answers to both",
    gateGuarded("/control/gateway/webhooks", "VIEW") && gateGuarded("/control/gateway/webhooks/:id",
      "VIEW") && gateGuarded("/control/gateway/webhooks/:id/retry", "RETRY")
    && !gateGuarded("/control/gateway/webhooks/:id/retry", "MANAGE")
    && !gateGuarded("/control/gateway/webhooks", "RETRY"),
    gPaths);
  check("…and the press is bounded twice over: a rate limit on the seat, because the ceiling is on "
    + "the delivery and one bored desk could otherwise count its way to five in a second, and the "
    + "office's own book passed as the tenant rather than a uuid from the query string",
    /enforceRateLimit\(`gateway:webhook-retry:\$\{req\.control\.user_id\}`, 20, 3600\)/
      .test(gateRoute)
    && gateRoute.includes("readDoor(WEBHOOK_RETRY_SQL, [req.control.tenant_id, id,\n      "
      + "req.control.user_id"),
    gateRoute.slice(gateRoute.indexOf("webhooks/:id/retry"), gateRoute.indexOf("webhooks/:id/retry") + 620));

  /** One desk's option list, cut out of the block that declares it. Matching every `["x", "y"]` pair
   *  in the file would fold in the status picker and the verdict words beside it, and a check that
   *  passed on that would say a pile existed that no chip prints. */
  const blockOf = (text: string, name: string) =>
    new RegExp(`const ${name}: \\[string, string\\]\\[\\] = \\[([\\s\\S]*?)\\];`).exec(text)?.[1] ?? "";
  const state = zodEnum(gateRoute, "STATE");
  /** The board names the words it accepts inside its own refusal sentence. That sentence has no
   *  apostrophes for `quoted` to cut on, so it is split at its commas — and its tail, `or all of it at
   *  once`, is the sixth word, which is why it is asserted rather than dropped. */
  const pileParts = (/Choose the pile: ([^']*)\./.exec(boardDef)?.[1] ?? "")
    .split(",").map((w) => w.trim()).filter(Boolean);
  const pileWords = pileParts.slice(0, -1);
  const caseWords = [...new Set([...boardDef.matchAll(/v_state = '([a-z]+)'/g)].map((m) => m[1]))]
    .filter((w) => w !== "all");
  const webPiles = [...new Set([...blockOf(gatewayDesk, "PILES")
    .matchAll(/\["([a-z]+)", "[^"]+"\]/g)].map((m) => m[1]))];
  check("the six words a seat may choose a pile with are one list in four places: the zod gate on the "
    + "route, the sentence the board answers with when it is typed wrong, the CASE branches the board "
    + "filters on, and the chips the desk prints — a fifth place would be a pile that cannot be asked "
    + "for, and a fourth is exactly how a desk comes to render a filter its door returns nothing for",
    same(state, ["all", "stuck", "unverified", "landed", "retried", "orphan"])
    && same(pileWords, ["stuck", "unverified", "landed", "retried", "orphan"])
    && pileParts[pileParts.length - 1] === "or all of it at once"
    && same(caseWords, pileWords) && same(webPiles, state) && blockOf(gatewayDesk, "PILES").length > 40,
    { zod: state, sentence: pileParts, cases: caseWords, chips: webPiles });
  const routeRefusals = [...gateRoute.matchAll(/^  ([a-z_]+): \["[A-Z_]+", (\d+)\],?$/gm)]
    .map((m) => m[1]);
  const doorErrors = [...new Set([...retryDef.matchAll(/'error', '([a-z_]+)'/g)].map((m) => m[1]))];
  check("the five words the retry door can refuse with are the five the route knows how to price: "
    + "read off the body the platform is running, so an error word added to the door and not to the "
    + "desk shows up here rather than as a 400 on a seat's correct question",
    same(routeRefusals, doorErrors) && routeRefusals.length === 5
    && same(doorErrors, ["attempts_spent", "no_reference", "not_found", "not_the_office",
      "not_verified"]),
    { route: routeRefusals, door: doorErrors });
  check("…and each is priced by what stopped it, not by how loud the door was: a stranger at the "
    + "desk is forbidden, a delivery that never arrived is missing, and the three facts about the "
    + "delivery itself — spent, unsigned, nameless — are all conflicts the seat could only learn by "
    + "pressing",
    /not_the_office: \["FORBIDDEN", 403\]/.test(gateRoute)
    && /not_found: \["NOT_FOUND", 404\]/.test(gateRoute)
    && ["attempts_spent", "not_verified", "no_reference"]
      .every((k) => new RegExp(`${k}: \\["CONFLICT", 409\\]`).test(gateRoute)),
    gateRoute.slice(gateRoute.indexOf("RETRY_REFUSALS"), gateRoute.indexOf("RETRY_REFUSALS") + 420));
  const scopeDoor = quoted(/v_scope not in \(([^)]*)\)/.exec(runDef)?.[1] ?? "");
  const webScopes = [...new Set([...blockOf(reconDesk, "SCOPES")
    .matchAll(/\["([a-z]+)", "[^"]+"\]/g)].map((m) => m[1]))];
  check("the seven things a seat may ask to be counted are the same seven words in the door, the "
    + "route's gate and the desk's picker — and `gateway`, the scope 136 rewrote two questions of, is "
    + "one of them, which is how a seat reaches the proof of phase 13 from the screen at all",
    same(scopeDoor, ["book", "wallet", "escrow", "payout", "refund", "gateway", "all"])
    && same(zodEnum(moneyRoute, "SCOPE"), scopeDoor) && same(webScopes, scopeDoor)
    && Q.gate.length > 0,
    { door: scopeDoor, zod: zodEnum(moneyRoute, "SCOPE"), web: webScopes });
  check("…and both desks name the duty a seat is missing in their own words rather than hiding the "
    + "tab: the retry key is spelled out on the pile and the count key on the report, so a seat who "
    + "cannot see a button is told which sentence to take to a role holder",
    gatewayDesk.includes("control.gateway.retry") && reconDesk.includes("control.money.recon")
    && analytics.includes('"control.money.recon"') && analytics.includes('"control.gateway.retry"'),
    { retry: gatewayDesk.includes("control.gateway.retry"),
      recon: reconDesk.includes("control.money.recon"),
      probe: [analytics.includes('"control.money.recon"'),
        analytics.includes('"control.gateway.retry"')] });
  check("…and the probe that hands a desk its list of duties carries both new keys, because 067's "
    + "`control.staff.view` taught this schema that a duty nobody probes is a tab that never appears: "
    + "a held key absent from that array is invisible even to the seat whose role row says it",
    /"control\.gateway\.view", "control\.gateway\.manage",/.test(analytics)
    && /\n\s*"control\.gateway\.retry",/.test(analytics)
    && /"control\.money\.reveal", "control\.money\.recon"\]/.test(analytics),
    analytics.slice(analytics.indexOf("control.gateway.view"), analytics.indexOf("control.gateway.view") + 260));
  check("neither desk keeps a second opinion about the ceiling: the pile reads the door's own "
    + "`can_retry` and `why_not` and never re-derives the number, which is the only reason the "
    + "divergences this gate found — the two 137 closed and the one above it left standing — are "
    + "reportable rather than invisible on the screen",
    /can_retry/.test(gatewayDesk) && /why_not/.test(gatewayDesk)
    && !/attempts\s*[<>]=?\s*5/.test(gatewayDesk) && !/retryKey\s*===/.test(gatewayDesk),
    (gatewayDesk.match(/[^\n]*(can_retry|why_not|attempts\s*[<>][=]?5)[^\n]*/g) ?? []).slice(0, 6));

  // ---------------- 15 · put the office back ----------------
  phase("15 · the rollback, and the office this file found again");
  await owner.query("rollback");
  const left = await census(tidy);
  const moved = Object.keys(BASE).filter((k) => k !== "run_seq" && BASE[k] !== left[k]);
  check(`the transaction rolls back and nothing of the office's is left standing: ${Object.keys(BASE).length - 2} `
    + "registers, ledgers and seat lists hold exactly the counts this file found them holding, "
    + "including the deliveries, the charges, the invoices and the audits phases 5 to 13 wrote by hand "
    + "and through the doors",
    moved.length === 0, moved.map((k) => [k, BASE[k], left[k]]));
  check("…and the rails are the sharpest of those: no gateway is switched on that was off, and the "
    + "one temporary switch phase 4 made is gone with the rest of it, which is the difference between "
    + "a rehearsal and a change to how the platform takes money",
    left.rails_on === BASE.rails_on, { before: BASE.rails_on, after: left.rails_on });
  check("…while the count numbers stay spent, because a sequence is the one thing in Postgres a "
    + `rollback does not hand back: ${spent} accepted count(s) spent ${spent} number(s) between the `
    + "two readings of the same committed sequence",
    left.run_seq === BASE.run_seq + spent && spent > 0,
    { base: BASE.run_seq, now: left.run_seq, spent });
  check("…and the movements' numbering did not move at all, because every leg this gate needed was "
    + "planted by hand on its own `PST-…` reference and no door that mints a posting number was ever "
    + "asked to: the office's register is the one this file opened",
    left.post_seq === BASE.post_seq, { base: BASE.post_seq, now: left.post_seq });
  note(`${proved} checks proved, ${failures} failed — the office's book, pile and register are as `
    + "this file found them, and the two synthetic books, their seats and their papers never "
    + "existed outside the transaction.");
  if (failures > 0) process.exitCode = 1;
}

// `process.exit()` would drop the lines still sitting in the socket on Windows, and the one line that
// matters — the statement this gate died on — is always the last one written.
main().catch((e) => { console.error(`\nGATE ABORTED: ${e?.message ?? e}`); process.exitCode = 1; });
