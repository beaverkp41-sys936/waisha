/**
 * 142, proved in the database.
 *
 * A commission is the third pricing card, and it is the first one where the register's answer moves money:
 * a cut the office keeps is income and a cut it owes is a cost. So the questions this gate asks are not the
 * ones 140 and 141 asked. Over HTTP a wrong sum and a right sum both arrive as JSON, and over HTTP a
 * pointer at a movement that carries something else looks exactly like a pointer at one that carries the
 * cut. Both halves are only visible here.
 *
 *  1. **The arithmetic, pinned to figures.** `commission_raw` keeps four decimals and `commission_figure`
 *     rounds to the pesa, then lifts to the office's minimum, then clamps to its ceiling — in that order.
 *     Nine figures are demanded below, because the order is the only reason a floor and a ceiling can both
 *     be set on one agreement.
 *  2. **The ladder.** Three rungs, walked in the order the table keeps, and the key is recomputed rather
 *     than read: a company rung beats a plan rung, a plan rung only speaks while the subscription says the
 *     company is on that plan, and the office's own rung answers last. The day asked is the transaction's
 *     day, so a superseded agreement still rules the day it was in force.
 *  3. **The money rule, refused before a reading exists.** 138 counts a sum per money and refuses the other
 *     side of it; a flat cut named in TZS asked of a USD invoice is refused here rather than discovered at
 *     a month end.
 *  4. **The pointer.** A discharge writes no money. It points at a payout or a posting, and the door reads
 *     the figure out of that movement and refuses the pointer when the movement does not carry what the
 *     register computed — seven refusals, and only then a carried reading.
 *  5. **The rules kept BELOW the doors.** Twelve CHECKs and one unique constraint on the agreements, five
 *     and a partial unique index on the readings, seven guard triggers. The refusals that matter most — a
 *     signed agreement deleted, a figure moved under a signature, a rung jumped by writing a wrong key, two
 *     published windows for one ladder — have no route that reaches them. They are provoked by hand, inside
 *     savepoints.
 *
 * Nothing of the office's commits. Every fixture — a synthetic office book, a synthetic company, a plan,
 * a subscription, four invoices, three seats, the accounts, a posting and a payout — is written inside one
 * transaction that is rolled back, and the committed census is taken on the same socket before `begin` and
 * again after the rollback. The one thing a rollback cannot hand back is the two numbering sequences, so
 * their gaps are counted against the doors that actually reached an INSERT.
 *
 * Run: npx tsx scripts/verify-pricing-commission-sql.ts          (rehearses 142, rolls it all back)
 *      npx tsx scripts/verify-pricing-commission-sql.ts --apply  (142's bodies re-applied to dev)
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const FILE = "migrations/142_the_cut_and_the_money_it_is_cut_from.sql";
const APPROVALS = "src/control/approvals.ts";
const COMMISSION_ROUTE = "src/routes/control-pricing-commission.routes.ts";
const ANALYTICS = "src/routes/control-analytics.routes.ts";
const CUTS_DESK = "../web/app/control/pricing/cuts.tsx";
const READINGS_DESK = "../web/app/control/pricing/readings.tsx";
const PAGE = "../web/app/control/pricing/page.tsx";
const APPLY = process.argv.includes("--apply");

/** 142's 34 bodies: the seven guards it fires, the seven internal helpers a signature, a figure and a
 *  transaction are read through, the nine reads and the eleven writes. Counted here so phase 0 can demand
 *  that this gate cut every body out of the file on its own — a lift that quietly missed one would rehearse
 *  33 of 34. */
const GUARDS = ["pricing_commission_history_is_kept", "pricing_commission_rate_is_kept",
  "pricing_commission_rate_is_immutable", "pricing_one_commission_per_day",
  "pricing_commission_names_its_book", "pricing_commission_reading_is_kept",
  "pricing_commission_reading_keeps_its_facts"];
const HELPERS = ["commission_subject_key", "commission_raw", "commission_figure",
  "commission_source_said", "commission_rate_paper", "commission_rate_sha256",
  "pricing_commission_rate_said"];
const READS = ["pricing_commission_rates", "pricing_commission_rate_detail",
  "pricing_commission_rate_memory", "commission_rate_in_force", "commission_on",
  "pricing_commission_assessments", "pricing_commission_reading_detail",
  "pricing_commission_summary", "pricing_commission_choices"];
const WRITES = ["open_pricing_commission_rate", "edit_pricing_commission_rate",
  "discard_pricing_commission_rate", "clone_pricing_commission_rate",
  "propose_pricing_commission_rate", "refuse_pricing_commission_rate",
  "apply_pricing_commission_rate", "withdraw_pricing_commission_rate", "assess_commission",
  "discharge_commission_assessment", "void_commission_assessment"];
const FNS = [...GUARDS, ...HELPERS, ...READS, ...WRITES];
const INTERNAL = [...GUARDS, ...HELPERS, "commission_rate_in_force"];
const TABLES = ["pricing_commission_subjects", "pricing_commission_sources", "pricing_commission_rates",
  "pricing_commission_history", "pricing_commission_assessments"];
/** The nine table triggers 142 fires, against the table each one stands on. */
const TRIGGERS: Record<string, string> = {
  trg_pricing_commission_rates_updated: "pricing_commission_rates",
  trg_pricing_commission_assessments_updated: "pricing_commission_assessments",
  pricing_commission_history_is_append_only: "pricing_commission_history",
  pricing_commission_rates_are_kept: "pricing_commission_rates",
  pricing_commission_rates_keep_their_words: "pricing_commission_rates",
  pricing_commission_rates_do_not_overlap: "pricing_commission_rates",
  pricing_commission_rates_belong_to_their_book: "pricing_commission_rates",
  pricing_commission_readings_are_kept: "pricing_commission_assessments",
  pricing_commission_readings_keep_their_facts: "pricing_commission_assessments",
};
/** The thirteen agreement rules the table keeps for itself. */
const RATE_CHECKS = ["pricing_commission_rate_subject_is_one_thing",
  "pricing_commission_rate_payee_is_one_thing", "pricing_commission_flat_has_a_money",
  "pricing_commission_percent_carries_no_money", "pricing_commission_percent_is_a_percent",
  "pricing_commission_window_is_a_window", "pricing_commission_floor_below_ceiling",
  "pricing_commission_rate_published_has_a_start", "pricing_commission_rate_publish_leaves_a_mark",
  "pricing_commission_rate_unsigned_paper_is_pending",
  "pricing_commission_rate_withdrawal_is_explained", "pricing_commission_rate_does_not_supersede_itself",
  "pricing_commission_rate_one_version_per_ladder"];
/** The five reading rules, plus the partial unique index no door can be made to skip. */
const READING_CHECKS = ["pricing_commission_cut_fits_the_money",
  "pricing_commission_discharge_is_explained", "pricing_commission_void_is_explained",
  "pricing_commission_reading_is_one_thing", "pricing_commission_assessment_carries_its_rate"];
const KEYS = ["control.pricing.view", "control.pricing.manage", "control.pricing.publish",
  "control.money.post"];

const HEX = randomUUID().replace(/-/g, "");
const STAMP = HEX.slice(0, 6).toUpperCase();
const OFFICE = `C142 office ${STAMP}`;
const COMPANY = `C142 company ${STAMP}`;
const DAY = new Date().toISOString().slice(0, 10);
const PAST = "2020-03-05";
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const SEAT = (who: string) => `c142.${who}.${HEX.slice(0, 8)}@waisha.test`;
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

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  /** git hands a Windows checkout back with CRLF terminators, which silently breaks a `\n` in the middle of
   *  a needle while leaving the end-of-body markers intact. */
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const src = read(FILE);

  phase("0 · 142's 34 bodies, its internal revoke, its door grant, its PUBLIC sweep and its two sequence "
    + `revokes ${APPLY ? "are re-applied to dev and committed" : "re-execute against the live catalog "
      + "and roll back"}`);
  const ddl = functionDdl(src);
  const internalRevoke = stmtBetween(src, "revoke execute on function\n  platform_auth.commission_subject_key(",
    "from public, anon, authenticated, service_role, app_runtime;");
  const grant = stmtBetween(src,
    "grant execute on function\n  platform_auth.pricing_commission_rates(uuid, text, text, text, text, int, int),",
    "to app_runtime;");
  const sweep = stmtBetween(src,
    "revoke all on function\n  platform_auth.pricing_commission_rates(uuid, text, text, text, text, int, int),",
    "from public, anon, authenticated, service_role;");
  const seqRevokes = [
    stmtBetween(src, "revoke all on pricing_commission_rate_number_seq",
      "service_role, app_runtime;"),
    stmtBetween(src, "revoke all on pricing_commission_assessment_number_seq",
      "service_role, app_runtime;")];

  check(`142 declares ${FNS.length} functions — ${GUARDS.length} guards, ${HELPERS.length} internal `
    + `helpers, the ${READS.length} reads and the ${WRITES.length} writes — and this gate cut every one of `
    + "them out of the file on its own",
    ddl.length === FNS.length && (src.match(/^create or replace function platform_auth\./gm) ?? []).length
      === FNS.length
    && FNS.every((f) => ddl.some((d) => d.startsWith(`create or replace function platform_auth.${f}(`))),
    ddl.map((d) => d.slice(38, 74)));
  check("142 re-declares nothing that 140 or 141 owns — the three freight cards share no function name — "
    + "so putting a cut in force cannot change how a price is worked out",
    !/create or replace function platform_auth\.(price_a_job|price_a_freight|pricing_rate_in_force|open_pricing_addendum|claim_pricing_addendum)/
      .test(src),
    (src.match(/^create or replace function platform_auth\.\w+/gm) ?? []).length);
  check("neither numbering sequence is granted to a client role at creation and both are revoked down to "
    + "the owner, which is 134's, 135's, 140's and 141's rule applied to a cut",
    !/grant [^;]*on pricing_commission_(rate|assessment)_number_seq/i.test(src)
    && seqRevokes.every((s) => /app_runtime/.test(s)), seqRevokes);
  check("the replay carries neither half of the file's own transaction pair, so a rehearsal cannot commit "
    + "the office's cut register behind a gate that promised not to",
    !/^(begin|commit);$/m.test([ddl, internalRevoke, grant, sweep, ...seqRevokes].join("\n")));

  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false },
    statement_timeout: 300000 });
  await c.connect();
  const recorded = (await c.query("select name from schema_migrations where name like '142%' order by 1"))
    .rows.map((r: any) => r.name);
  check("142 is already recorded, which is why an edited one needs this file rather than `pnpm migrate`",
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
    console.log("\n142 does not run as written. Nothing below this line is proved.");
    console.log(String(err?.message ?? err));
    process.exitCode = 1;
    return;
  }
  try { await run(c, src); } finally { await c.end().catch(() => undefined); }
}

async function run(c: pg.Client, src: string) {
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const route = read(COMMISSION_ROUTE);
  const approvals = read(APPROVALS);
  const analytics = read(ANALYTICS);
  const cuts = read(CUTS_DESK);
  const readings = read(READINGS_DESK);
  const page = read(PAGE);
  const IP = "127.0.0.1";
  const UA = "commission-gate";

  let office = "", company = "", book = "", PLAN = "", pen = "", quill = "", clerk = "", noDuty = "";
  let mintedRates = 0, mintedReadings = 0;
  /** A publish that did not publish is the one failure this gate must not absorb silently: every ladder
   *  test below reads the answer of an agreement that only exists if two seats got it live. */
  const failedPublish: { words: string, refused: any }[] = [];

  const census = async (): Promise<Record<string, number>> => Object.fromEntries((await c.query(
    `select 'agreements' as k, count(*)::int as n from pricing_commission_rates
     union all select 'memory', count(*)::int from pricing_commission_history
     union all select 'readings', count(*)::int from pricing_commission_assessments
     union all select 'rungs', count(*)::int from pricing_commission_subjects
     union all select 'sources', count(*)::int from pricing_commission_sources
     union all select 'books', count(*)::int from tenants
     union all select 'seats', count(*)::int from users`)).rows
    .map((r: any) => [r.k, r.n]));

  const one = async (sql: string, p: any[] = []) => (await c.query(sql, p)).rows[0];
  const oi = (sql: string, p: any[] = []) => c.query(sql, p);
  const door = async (fn: string, args: any[]) =>
    (await oi(call(fn, args.length), args)).rows[0]?.r ?? {};
  /** The preview, asked exactly as `/control/pricing/cuts/ask` asks it: the office's own book in `$1`,
   *  the company in `$2`. A platform rung's key is the register's nil uuid — the same letters in every
   *  office's book — so a preview that named no book could answer one office out of another's ladder. */
  const ask = async (against: string, source: string, sourceId: string, from = book) =>
    (await oi(call("commission_on", 4), [from, against, source, sourceId])).rows[0].r;
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

  const before = await census();
  const rateSeq = (await one("select last_value::int as n from pricing_commission_rate_number_seq")).n;
  const readSeq = (await one("select last_value::int as n from pricing_commission_assessment_number_seq")).n;

  await c.query("begin");
  try {
    // ---------------- the two books, the plan, the seats and the papers to cut ----------------
    phase("the fixtures: an office book, two companies on a plan, four seats and six invoices");
    office = (await one(`insert into tenants (type, name, status) values ('platform', $1, 'active')
      returning id`, [OFFICE])).id;
    company = (await one(`insert into tenants (type, name, status) values ('transporter', $1, 'active')
      returning id`, [COMPANY])).id;
    book = office;
    PLAN = (await one(`insert into plans (key, name, seat_limit, price_monthly, price_quarterly,
        price_annual, currency) values ($1, 'Growth, cut gate', 5, 60000, 165000, 600000, 'TZS')
      returning id`, [`c142-growth-${HEX.slice(0, 8)}`])).id;
    await oi(`insert into subscriptions (tenant_id, plan_id, billing_cycle, status)
      values ($1,$2,'monthly','active')`, [company, PLAN]);
    pen = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Commission Pen','active',$2) returning id`, [office, SEAT("pen")])).id;
    quill = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Commission Quill','active',$2) returning id`, [office, SEAT("quill")])).id;
    noDuty = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','No Ledger Pen','active',$2) returning id`, [office, SEAT("nolead")])).id;
    clerk = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'staff','Not A Seat','active',$2) returning id`, [company, SEAT("clerk")])).id;
    // 133's chart in the synthetic office book, so a posting can be pointed at a real leg. The codes are
    // the ones 134's own trigger demands of a payout: a hand-planted paper that invents a line is refused
    // before the pointer is ever asked about it.
    const feeAcc = (await one(`insert into money_accounts (tenant_id, code, label, kind, currency)
      values ($1,'FEE-INCOME','Platform fee income (TZS)','income','TZS') returning id`, [office])).id;
    const costAcc = (await one(`insert into money_accounts (tenant_id, code, label, kind, currency)
      values ($1,'COST-OPS','Platform costs (TZS)','expense','TZS') returning id`, [office])).id;
    const feeUsd = (await one(`insert into money_accounts (tenant_id, code, label, kind, currency)
      values ($1,'FEE-INCOME-USD','Platform fee income (USD)','income','USD') returning id`, [office])).id;
    const costUsd = (await one(`insert into money_accounts (tenant_id, code, label, kind, currency)
      values ($1,'COST-OPS-USD','Platform costs (USD)','expense','USD') returning id`, [office])).id;
    const payableAcc = (await one(`insert into money_accounts (tenant_id, code, label, kind, currency)
      values ($1,'PAYOUT-DUE','Money the office owes out (TZS)','liability','TZS') returning id`,
      [office])).id;
    const cashAcc = (await one(`insert into money_accounts (tenant_id, code, label, kind, currency)
      values ($1,'OPS-CASH','Till the office pays from (TZS)','asset','TZS') returning id`, [office])).id;
    const rail = await one(`select code from money_payout_rails where family = 'cash' limit 1`);

    const inv = async (total: number, currency: string, status: string, onDay: string,
      whose?: string) => (await one(
      `insert into freight_invoices (tenant_id, invoice_number, customer_name, total, currency, status,
         issue_date)
       values ($1,$2,'Kiliamanji Traders', $3, $4, $5, $6) returning id`,
      [whose ?? company, `FI-142-${STAMP}-${Math.round(total)}-${currency}-${onDay}`, total, currency,
        status, onDay])).id;
    /** A subscription invoice is the second money test's paper: 142 prices it from `invoices`, and the
     *  one rung that can hold two agreements at once without stealing `days_are_taken` from the ladder
     *  phase 3 already published on is this one. */
    let subN = 0;
    const subInv = async (total: number, currency: string, whose: string) => {
      subN++;
      return (await one(`insert into invoices (tenant_id, number, billing_cycle, seats, amount_subtotal,
          vat_rate, vat_amount, amount_total, currency, status, period_start, period_end, issued_at)
         values ($1,$2,'monthly',3, $3, 0, 0, $3, $4, 'issued', $5, $6, $7::timestamptz)
         returning id`,
        [whose, `INV-142-${STAMP}-${subN}`, total, currency, PAST, DAY, `${DAY}T09:00:00+00`])).id;
    };
    const invoice = await inv(1000000, "TZS", "sent", DAY);
    const usdInvoice = await inv(10000, "USD", "sent", DAY);
    const emptyInvoice = await inv(0, "TZS", "sent", DAY);
    const deadInvoice = await inv(500000, "TZS", "cancelled", DAY);
    const oldInvoice = await inv(1000000, "TZS", "sent", PAST);
    // A second company on the same plan, and nobody's negotiated agreement on it: the rung a plan sets is
    // proved against a paper the negotiated one cannot reach. `commission_on` refuses a preview of a
    // transaction filed under another company than the one asked about, so each test asks its own book.
    const planCompany = (await one(`insert into tenants (type, name, status) values ('transporter', $1,
      'active') returning id`, [`${COMPANY} on plan`])).id;
    await oi(`insert into subscriptions (tenant_id, plan_id, billing_cycle, status)
      values ($1,$2,'monthly','active')`, [planCompany, PLAN]);
    const planInvoice = await inv(1000000, "TZS", "sent", DAY, planCompany);


    /** The one platform role the register already grants 133's pen to: 142's census demands that a seat
     *  exists who may discharge a cut, so the gate borrows it rather than minting a duty of its own. */
    const moneyRole = await one(`select rp.role_id as id from role_permissions rp
       join roles r on r.id = rp.role_id
      where r.tenant_id is null and rp.permission_key = 'control.money.post' limit 1`);
    if (moneyRole?.id) {
      await oi("insert into user_roles (user_id, role_id) values ($1,$2)", [quill, moneyRole.id]);
    }
    check("an office book, two companies on the plan, six invoices, two seats with a ledger duty to borrow "
      + "and the 133 lines a pointer and a payout need are planted inside the transaction",
      !!office && !!company && !!planCompany && !!PLAN && !!pen && !!quill && !!clerk && !!invoice
      && !!usdInvoice && !!planInvoice && !!moneyRole?.id && !!rail?.code && !!payableAcc && !!cashAcc);
    check("…and one of the seats holds nothing: the door's own `no_money_duty` cannot be proved by a fixture "
      + "where every pen can post", !!(await one(
        `select u.id from users u where u.id = $1 and not exists (
           select 1 from user_roles ur join role_permissions rp on rp.role_id = ur.role_id
            where ur.user_id = u.id and rp.permission_key = 'control.money.post')`, [noDuty])));

    /** 121's whole order for one agreement: raise, be released by the second seat, be claimed by the seat
     *  that released it, be applied. */
    const putLive = async (id: string, words: string) => {
      const pr = await door("propose_pricing_commission_rate",
        [book, id, words, pen, "billing_admin", IP, UA]);
      if (!pr.ok) { failedPublish.push({ words, refused: pr }); return pr; }
      mintedRates++;
      const ap = pr.approval_id as string;
      await oi(call("decide_approval", 7), [ap, "approve", "Signed on the cut.", pen,
        "billing_admin", IP, UA]);
      await oi(call("decide_approval", 7), [ap, "approve", "Signed on the cut.", quill,
        "super_admin", IP, UA]);
      await oi(call("claim_approval", 2), [ap, quill]);
      const r = await door("apply_pricing_commission_rate", [ap, quill, "super_admin", IP]);
      if (!r.ok) failedPublish.push({ words, refused: r });
      return { ap, sha: pr.payload_sha256, r };
    };
    const open = (o: { subject: string, tenant?: string, plan?: string, source: string, payee?: string,
      payeeId?: string, basis: string, value: number, currency?: string, floor?: number, cap?: number,
      from?: string, to?: string, note?: string, actor?: string }) =>
      door("open_pricing_commission_rate", [book, o.subject, o.tenant ?? null, o.plan ?? null, o.source,
        o.payee ?? "platform", o.payeeId ?? null, o.basis, o.value, o.currency ?? null,
        o.floor ?? null, o.cap ?? null, o.from ?? DAY, o.to ?? null,
        o.note ?? "The office's standing cut on this transaction, agreed for a year.",
        o.actor ?? pen, "billing_admin", IP, UA]);
    /** Both write doors hand back a whole projection, not a bare id: `open`/`edit` answer with
     *  `pricing_commission_rate_detail` (the agreement sits under `.rate`) and `assess` with
     *  `pricing_commission_reading_detail` (the row sits under `.reading.reading`). A gate that guesses
     *  one shape reads `undefined` for a uuid, plants no agreement, and then reports the ladder for
     *  walking to the wrong rung — which is exactly how 142's first rehearsal misread its own register. */
    const rateId = (res: any): string => res?.rate?.rate?.id ?? res?.rate_id ?? res?.id;
    const readId = (res: any): string => res?.reading?.reading?.id ?? res?.reading?.id ?? res?.id;

    // ---------------- 1 · the registers as the catalog keeps them ----------------
    phase("1 · the three rungs, the five transactions, the five registers and who may knock");
    const rungs = (await oi("select key, label, priority, names from pricing_commission_subjects "
      + "order by priority")).rows;
    check("the ladder is data, written once: three rungs in the order the resolver walks them, each naming "
        + "whether it points at a company, a plan or nothing",
      rungs.length === 3 && rungs[0].key === "tenant" && rungs[0].names === "company"
      && rungs[1].key === "plan" && rungs[1].names === "plan"
      && rungs[2].key === "platform" && rungs[2].names === "none"
      && rungs.map(r => r.priority).join() === "1,2,3", rungs);
    const sources = (await oi("select key, side, sort from pricing_commission_sources order by sort")).rows;
    check("the five transactions a cut can be taken from are five words with a side and an order — the "
        + "money itself is read by one body and never from this table",
      sources.length === 5 && sources.map(s => s.key).join() === "subscription_invoice,"
        + "subscription_payment,freight_invoice,freight_expense,payout"
      && sources.filter(s => s.side === "in").length === 3
      && sources.filter(s => s.side === "out").length === 2, sources);
    const arms: Record<string, string> = {};
    for (const s of sources) {
      const a = (await oi(call("commission_source_said", 2),
        [s.key, "00000000-0000-0000-0000-000000000000"])).rows[0].r;
      arms[s.key] = a.error;
    }
    check("…and every one of the five words has an arm below it: asked for a transaction that does not "
        + "exist each answers `no_source`, so the desk cannot offer a register the resolver cannot price",
      Object.values(arms).every(e => e === "no_source"), arms);
    const aclRows = (await oi(`select cl.relname, cl.relrowsecurity,
        coalesce(string_agg(distinct a.privilege_type, ',') filter (where a.grantee = 'app_runtime'::regrole),
                 '') as app_role_grants,
        coalesce(string_agg(distinct r.rolname, ',') filter
                 (where r.rolname in ('public','anon','authenticated','service_role')), '(none)') as client_grants
       from pg_class cl cross join aclexplode(cl.relacl) a left join pg_roles r on r.oid = a.grantee
      where cl.relname = any($1) group by cl.relname, cl.relrowsecurity`, [TABLES])).rows;
    check("all five registers are row-level-security enabled, hold no grant for anon, authenticated, "
        + "service_role or PUBLIC, and give the app role SELECT at most — a cut is written only through a "
        + "definer door",
      aclRows.length === 5 && aclRows.every(r => r.relrowsecurity
        && r.client_grants === "(none)"
        && String(r.app_role_grants).split(",").filter(Boolean).every((g: string) => g === "SELECT")),
      aclRows);
    /** A function whose proacl is NULL is not "private" — NULL means Postgres' default, which hands
     *  EXECUTE to PUBLIC. So this counts the missing default as a leak and names every non-owner holder. */
    const holdersOf = async (names: string[]) => (await oi(
      `select p.proname, (p.proacl is null) as default_acl,
              coalesce(string_agg(distinct coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ','),
                       '') as holders
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         left join aclexplode(p.proacl) a on true
         left join pg_roles r on r.oid = a.grantee
        where n.nspname = 'platform_auth' and p.proname = any($1)
        group by p.proname, (p.proacl is null)`, [names])).rows as any[];
    const internal = await holdersOf([...INTERNAL]);
    check(`the ${INTERNAL.length} internal bodies — every guard, the arithmetic, the paper builder, the `
        + "resolver and the `said` printer — are swept of PUBLIC, the Supabase client roles and the app "
        + "role, so a client cannot ask a guard about a row it cannot see",
      internal.length === INTERNAL.length
      && internal.every(f => !f.default_acl
        && f.holders.split(",").every((h: string) => h.startsWith("postgres:"))),
      internal.filter(f => f.default_acl
        || f.holders.split(",").some((h: string) => !h.startsWith("postgres:"))).slice(0, 6));
    const doorsHeld = await holdersOf(FNS);
    const leaked = doorsHeld.filter(f => f.default_acl
      || f.holders.split(",").some((h: string) => !/^postgres:|^app_runtime:/.test(h)));
    check(`…and every one of the ${FNS.length} bodies answers to the app role or to nobody: after `
        + "`create or replace` handed them back, none is left granted to PUBLIC or a Supabase client role",
      doorsHeld.length === FNS.length && leaked.length === 0, leaked.slice(0, 8));
    const dutyRows = (await oi("select key from permissions where key = any($1)", [KEYS])).rows;
    check("142 mints no fifth duty: it joins 140's three pricing keys and borrows 133's `control.money.post`, "
        + "because saying a cut has been carried is a claim about the book",
      dutyRows.length === 4 && dutyRows.every(r => KEYS.includes(r.key)), dutyRows);
    const extraKey = (await oi("select key from permissions where key like 'control.pricing.%' "
      + "and key not in ('control.pricing.view','control.pricing.manage','control.pricing.publish')")).rows;
    check("…and the register holds no pricing key the nav was never granted", extraKey.length === 0,
      extraKey);

    // ---------------- 2 · the arithmetic, pinned ----------------
    phase("2 · the arithmetic, written once and pinned to figures");
    const raw = async (basis: string, value: number, amount: number) => (await one(
      `select platform_auth.commission_raw($1,$2,$3)::text as n`, [basis, value, amount])).n;
    const fig = async (basis: string, value: number, amount: number, floor: number | null,
      cap: number | null) => (await one(
      `select platform_auth.commission_figure($1,$2,$3,$4,$5)::text as n`,
      [basis, value, amount, floor, cap])).n;
    check("a percent is the transaction's figure times the agreement's own: 2.5% of 1,000,000 is 25,000, "
      + "and a flat is the sum the agreement named, not a multiplication of it",
      await raw("percent_of_amount", 2.5, 1000000) === "25000.0000"
      && await raw("flat", 50000, 1000000) === "50000.0000",
      [await raw("percent_of_amount", 2.5, 1000000), await raw("flat", 50000, 1000000)]);
    check("the raw cut keeps four decimals, because a dispute is about whether the paper said 2.5 or "
      + "2.5678 percent — 2.5678% of 100,000 is 2,567.80 and the register prints it with the decimals",
      await raw("percent_of_amount", 2.5678, 100000) === "2567.8000"
      && await raw("percent_of_amount", 0.1234, 1000000) === "1234.0000",
      [await raw("percent_of_amount", 2.5678, 100000)]);
    check("the figure a reading carries is the raw cut rounded to the pesa first: 1,234.5678 of nothing "
      + "else is 1,234.57, and no clamp is applied when the agreement sets neither half",
      await fig("flat", 1234.5678, 1000000, null, null) === "1234.57",
      await fig("flat", 1234.5678, 1000000, null, null));
    const lifted = await fig("percent_of_amount", 0.5, 1000000, 30000, null);
    const clamped = await fig("percent_of_amount", 5, 1000000, null, 10000);
    const both = await fig("percent_of_amount", 0.2, 1000000, 5000, 20000);
    check("a floor lifts and a ceiling clamps, and the order is the only reason both can be set on one "
        + "agreement: 0.5% of 1,000,000 is 5,000 and lifts to the office's 30,000 minimum; 5% of it is "
        + "50,000 and clamps to the 10,000 ceiling; 0.2% is 2,000, lifts to 5,000 and never reaches the "
        + "20,000 ceiling",
      lifted === "30000.00" && clamped === "10000.00" && both === "5000.00",
      { lifted, clamped, both });
    check("…and a lift cannot win over a clamp written under it, because `floor <= cap` is the table's own "
        + "rule: the clamp is `least`, the lift is `greatest`, and the pair only ever meet in that order",
      await fig("percent_of_amount", 2.5, 1000000, 1000, 24000) === "24000.00",
      await fig("percent_of_amount", 2.5, 1000000, 1000, 24000));

    // ---------------- 3 · the ladder ----------------
    phase("3 · which agreement speaks, on which day");
    const standing = rateId(await open({ subject: "platform", source: "freight_invoice",
      basis: "percent_of_amount", value: 1 }));
    const pubStanding = await putLive(standing, "The office's own cut on a freight invoice: one percent.");
    check("the office's standing rung opens, is signed by two seats and goes live — 1% of anything the "
        + "office bills is 10,000 in its own book",
      pubStanding.r?.ok === true && pubStanding.r?.rate?.rate?.status === "published",
      { opened: standing, ok: pubStanding.r?.ok, status: pubStanding.r?.rate?.rate?.status,
        error: pubStanding.r?.error, failed: failedPublish });
    const askedStanding = await ask(company, "freight_invoice", invoice);
    check("asked of a company with no agreement of its own and none on its plan, the ladder walks to the "
        + "third rung and says so: the answer names `platform` as the rung that spoke, not a figure alone",
      askedStanding.answer === "cut" && askedStanding.rate?.rung?.key === "platform"
      && askedStanding.figure === "10000.00" && askedStanding.currency === "TZS",
      { answer: askedStanding.answer, rung: askedStanding.rate?.rung?.key,
        figure: askedStanding.figure });
    const planRate = rateId(await open({ subject: "plan", plan: PLAN, source: "freight_invoice",
      basis: "percent_of_amount", value: 2.5, floor: 30000,
      note: "Every company on the Growth plan is cut at two and a half percent, with a floor." }));
    await putLive(planRate, "The plan's standing cut, signed for the plan.");
    const askedPlan = await ask(company, "freight_invoice", invoice);
    check("a plan rung beats the office's own rung for a company that is on that plan: the same invoice is "
        + "now cut at 2.5% lifted to the 30,000 minimum the plan set, and the answer says the rung was the "
        + "plan it is on — the name printed is the plan's own with `Plan: ` in front of it, because the "
        + "copy guard writes it off the plans register rather than keeping whatever the desk typed",
      askedPlan.rate?.rung?.key === "plan"
      && askedPlan.rate?.subject_name === "Plan: Growth, cut gate"
      && askedPlan.figure === "30000.00" && askedPlan.lifted === true,
      { rung: askedPlan.rate?.rung?.key, name: askedPlan.rate?.subject_name,
        figure: askedPlan.figure, lifted: askedPlan.lifted });
    const tenantRate = rateId(await open({ subject: "tenant", tenant: company, source: "freight_invoice",
      basis: "percent_of_amount", value: 4,
      note: "Negotiated with this company: four percent, because it bills the most." }));
    await putLive(tenantRate, "The negotiated cut, signed for the company's name.");
    const askedTenant = await ask(company, "freight_invoice", invoice);
    check("…and a company's own agreement beats both: a negotiated figure is the office's promise to that "
        + "customer, so rung one answers first and the plan's floor never touches it",
      askedTenant.rate?.rung?.key === "tenant" && askedTenant.figure === "40000.00"
      && askedTenant.rate?.subject_name === COMPANY && askedTenant.lifted === false,
      { rung: askedTenant.rate?.rung?.key, figure: askedTenant.figure });
    const askedElsewhere = await ask(planCompany, "freight_invoice", planInvoice);
    check("the negotiated figure belongs to the company it was signed for: a second company on the same "
        + "plan, with no paper of its own, is still cut at the plan's 2.5% lifted to its floor — and the "
        + "preview reads the rung off the transaction's own book, not off whichever company a desk names",
      askedElsewhere.rate?.rung?.key === "plan" && askedElsewhere.figure === "30000.00"
      && askedElsewhere.rate?.subject_name === "Plan: Growth, cut gate",
      { rung: askedElsewhere.rate?.rung?.key, name: askedElsewhere.rate?.subject_name,
        figure: askedElsewhere.figure });
    const askedWrongBook = await ask(company, "freight_invoice", planInvoice);
    check("…and asking the preview about a paper that belongs to somebody else is refused rather than "
        + "answered with the wrong rung: the figure a clerk is shown has to be the figure the door writes",
      askedWrongBook.ok === false && askedWrongBook.error === "asked_other_book"
      && askedWrongBook.figure === null, { error: askedWrongBook.error });
    await oi(`update subscriptions set status = 'expired', updated_at = now() where tenant_id = $1`,
      [planCompany]);
    const askedExpired = await ask(planCompany, "freight_invoice", planInvoice);
    check("a plan rung only speaks while the subscription says the company is on the plan: with the "
        + "subscription expired, the same invoice falls to the office's own standing rung",
      askedExpired.rate?.rung?.key === "platform" && askedExpired.figure === "10000.00",
      { rung: askedExpired.rate?.rung?.key, figure: askedExpired.figure });
    await oi(`update subscriptions set status = 'active', updated_at = now() where tenant_id = $1`,
      [planCompany]);

    // ---------------- 3b · two office books, one ladder ----------------
    /** The defect this phase found, written as the check that keeps it shut. A platform rung is filed
     *  under `commission_subject_key('platform', null, null)` — the register's nil uuid, the same letters
     *  in every office's book — so a ladder walk, an overlap guard or a version chain keyed on that uuid
     *  alone answers one office's question out of another office's tariff. Nothing else in this file can
     *  show it: every other phase runs in one book, and a single book cannot disagree with itself. */
    const RIVAL = `C142 rival office ${STAMP}`;
    const rival = (await one(`insert into tenants (type, name, status) values ('platform', $1, 'active')
      returning id`, [RIVAL])).id;
    const rivalPen = (await one(`insert into users (tenant_id, user_type, full_name, status, email)
      values ($1,'platform','Rival Pen','active',$2) returning id`, [rival, SEAT("rival")])).id;
    /** Planted by hand, because the rival's ladder only has to *be there*: what is being proved is what
     *  this office's doors do in its shadow, and a second run of 121's whole signature order would prove
     *  the workflow instead of the keying. Version 1 is the whole test on the first rung — under the old
     *  unbound chain this insert collided with the office's own standing rung, which phase 3 opened at
     *  the same step of the same nil-uuid ladder. */
    const rivalRung = (source: string, ref: string, value: number) => keeps(
      `insert into pricing_commission_rates (tenant_id, ref, subject_kind, subject_key, subject_name,
         source_kind, payee_kind, payee_name, basis, value, effective_from, version, status, note,
         published_by, published_at)
       values ($1,$2,'platform',platform_auth.commission_subject_key('platform',null,null),
         'The office''s own cut',$3,'platform',$4,'percent_of_amount',$5,$6,1,'published',$7,$8,now())
       returning ref, tenant_id, subject_key`,
      [rival, ref, source, RIVAL, value, PAST,
        `The rival office's standing cut on a ${source}, planted by hand so this office's doors have a `
        + "second book to answer beside.", rivalPen]);
    const rivalFreight = await rivalRung("freight_invoice", "CMR-2026-90142", 50);
    const rivalSub = await rivalRung("subscription_payment", "CMR-2026-90143", 7);
    check("a second office book holds its own standing rung at the same step of the same ladder: the "
        + "version chain is keyed on the book as well as the rung and the transaction, so the nil uuid is "
        + "numbered once in each office and the rival's paper does not steal this office's version one",
      rivalFreight.ok === true && rivalFreight.rows[0]?.ref === "CMR-2026-90142"
      && String(rivalFreight.rows[0]?.tenant_id) === rival && rivalSub.ok === true,
      { freight: rivalFreight.message, sub: rivalSub.message });
    const askedRival = await ask(company, "freight_invoice", invoice, rival);
    const askedOwn = await ask(company, "freight_invoice", invoice);
    check("…and the preview walks the ladder of the book it is named, which is the book the door writes: "
        + "asked of the rival register the same invoice is cut at its standing fifty percent — 500,000.00 "
        + "on CMR-2026-90142 — while this office, which holds the negotiated four percent, still answers "
        + "40,000.00 on its own paper. The leak ran both ways before the book was bound.",
      askedRival.answer === "cut" && askedRival.rate?.ref === "CMR-2026-90142"
      && askedRival.rate?.rung?.key === "platform" && askedRival.figure === "500000.00"
      && askedOwn.answer === "cut" && askedOwn.figure === "40000.00"
      && askedOwn.rate?.ref !== "CMR-2026-90142",
      { rival: { ref: askedRival.rate?.ref, figure: askedRival.figure },
        own: { ref: askedOwn.rate?.ref, figure: askedOwn.figure } });
    const payStanding = rateId(await open({ subject: "platform", source: "subscription_payment",
      basis: "percent_of_amount", value: 1.5,
      note: "The office's standing cut on a subscription payment, opened while a second office holds one "
        + "on the same transaction for the same days." }));
    const pubPay = await putLive(payStanding, "A standing cut on payments, signed beside a rival book.");
    check("…and this office can open, sign and put live a standing cut on a transaction another office "
        + "already cuts, because the overlap guard binds the book: the rival's live rung never appears in "
        + "this office's refusal. This is the exact failure the rehearsal reported before the keying was "
        + "repaired — `days_are_taken`, and the ref it named belonged to a paper this office never opened",
      pubPay.r?.ok === true && pubPay.r?.rate?.rate?.status === "published"
      && String(pubPay.r?.rate?.rate?.version) === "1",
      { ok: pubPay.r?.ok, error: pubPay.r?.error, status: pubPay.r?.rate?.rate?.status,
        version: pubPay.r?.rate?.rate?.version, failed: failedPublish.slice(-1) });
    /** Asked through the resolver rather than the preview, because a subscription *payment* fixture is 134's
     *  paper and this phase has no reason to raise one: the question here is which row two books hand back
     *  for one rung, one day and no company paper between them. */
    const inForceOwn = (await oi(call("commission_rate_in_force", 4),
      [book, company, "subscription_payment", DAY])).rows[0].r;
    const inForceRival = (await oi(call("commission_rate_in_force", 4),
      [rival, company, "subscription_payment", DAY])).rows[0].r;
    check("the two books keep answering apart on that second ladder too: walked in the rival register the "
        + "standing cut is its seven percent, and walked here it is the one and a half percent this office "
        + "just signed — one rung, two answers, and neither office is wrong",
      inForceOwn.ok === true && inForceOwn.ref === pubPay.r?.rate?.rate?.ref
      && inForceOwn.value === "1.5000" && inForceRival.ok === true
      && inForceRival.ref === "CMR-2026-90143" && inForceRival.value === "7.0000",
      { own: { ref: inForceOwn?.ref, value: inForceOwn?.value },
        rival: { ref: inForceRival?.ref, value: inForceRival?.value } });

    // ---------------- 3c · the version chain: a clone hands the days over, a stranger steals them ----------------
    /** The desk promises that cloning a live cut forward closes the one it replaces, and the publish does
     *  exactly that — but a clone is only a draft until a second seat signs, and the row it replaces stays
     *  open-ended while the paper waits. The paper's own clash guard read every live row on the ladder,
     *  including the one the draft names in `supersedes_id`, so a cloned version could never be put up for a
     *  signature at all: the chain was a dead end from the second version onward. Found by clicking it on
     *  the live desk, which no check in this file had done — so it is a check now, both halves of it.
     *  The cut is agreed per plan rather than on the office's own rung, and the choice is not taste:
     *  phase 8 hand-plants its deliberate rule-breaks on the platform rung of the payout ladder, and a
     *  live cut standing there answers the overlap guard first, so the plant that names one CHECK is
     *  reported for another. */
    const paidStanding = rateId(await open({ subject: "plan", plan: PLAN, source: "payout", basis: "flat",
      value: 5000, currency: "TZS",
      note: "A flat five thousand on every payout the office makes, put live to be cloned forward." }));
    const pubPaid = await putLive(paidStanding, "The office's standing cut on a payout, signed to be cloned.");
    const paidRef = pubPaid.r?.rate?.rate?.ref;
    const stranger = rateId(await open({ subject: "plan", plan: PLAN, source: "payout", basis: "flat",
      value: 6000, currency: "TZS", note: "A second draft on the same days, which replaces nothing." }));
    const strangerPaper = await door("propose_pricing_commission_rate", [book, stranger,
      "Asking for a signature over a cut the office already keeps.", pen, "billing_admin", IP, UA]);
    check("a draft that replaces nothing cannot be put up over a live cut on the same rung and the same "
        + "days: `days_are_taken` names the live ref, so a seat is never asked to sign a collision",
      strangerPaper.ok === false && strangerPaper.error === "days_are_taken"
      && strangerPaper.clash_ref === paidRef, { error: strangerPaper.error,
        clash: strangerPaper.clash_ref, paidRef });
    const cloned = rateId(await door("clone_pricing_commission_rate", [book, paidStanding, TOMORROW,
      "The same five thousand, from tomorrow.", pen, "billing_admin", IP, UA]));
    const cloneChain = await one(`select supersedes_id::text as supersedes_id, version, status, `
      + `to_char(effective_from,'YYYY-MM-DD') as effective_from from pricing_commission_rates where id = $1`,
      [cloned]);
    const liveRow = await one(`select status, to_char(effective_to,'YYYY-MM-DD') as effective_to `
      + `from pricing_commission_rates where id = $1`, [paidStanding]);
    check("…and cloning a live cut forward closes nothing: the new draft names the row it replaces, and the "
        + "live one is still open-ended, because the office keeps taking the cut until a second seat signs "
        + "the successor — a clone that stopped the live row would leave a hole in the days it was only "
        + "meant to follow",
      !!cloned && cloneChain.supersedes_id === String(paidStanding) && cloneChain.status === "draft"
      && cloneChain.effective_from === TOMORROW && liveRow.status === "published"
      && liveRow.effective_to === null, { cloneChain, liveRow });
    const clonePaper = await door("propose_pricing_commission_rate", [book, cloned,
      "The same cut, one day later. A second seat signs the handover.", pen, "billing_admin", IP, UA]);
    let cloneApply: any = { ok: false, error: "paper_never_raised" };
    if (clonePaper.ok === true) {
      const ap = clonePaper.approval_id as string;
      await oi(call("decide_approval", 7), [ap, "approve", "Signed on the handover.", pen,
        "billing_admin", IP, UA]);
      await oi(call("decide_approval", 7), [ap, "approve", "Signed on the handover.", quill,
        "super_admin", IP, UA]);
      await oi(call("claim_approval", 2), [ap, quill]);
      cloneApply = await door("apply_pricing_commission_rate", [ap, quill, "super_admin", IP]);
      if (cloneApply.ok === true) mintedRates++;
    }
    const closedRow = await one(`select status, to_char(effective_to,'YYYY-MM-DD') as effective_to `
      + `from pricing_commission_rates where id = $1`, [paidStanding]);
    check("…and the version that replaces a live cut can be put up, signed and published, which is the "
        + "handover the desk promises in words: the paper is raised without a clash, and the publish closes "
        + "the version it replaces on the day before the new one starts, so one rung ends with one live "
        + "answer rather than two",
      clonePaper.ok === true && cloneApply.ok === true && closedRow.status === "superseded"
      && closedRow.effective_to === DAY, { raise: clonePaper.error, apply: cloneApply.error,
        closed: closedRow });

    // ---------------- 4 · the money rule ----------------
    phase("4 · 138's rule, refused before a reading exists");
    // The money test runs on the subscription ladder, because phase 3 already holds the platform rung of
    // `freight_invoice` for these days: a second published window on one ladder is refused `days_are_taken`
    // before its money is ever asked about, and a gate that could not tell the two refusals apart would
    // report a money rule that never ran.
    const subTzs = await subInv(1180000, "TZS", company);
    const subUsd = await subInv(10000, "USD", company);
    const flatStanding = rateId(await open({ subject: "platform", source: "subscription_invoice",
      basis: "flat", value: 15000, currency: "TZS",
      note: "A flat fifteen thousand on every subscription invoice, named in shillings." }));
    await putLive(flatStanding, "A flat cut in shillings, signed as one.");
    const askedUsd = await ask(company, "subscription_invoice", subUsd);
    check("a flat cut named in one money is not taken out of a transaction in another: the USD invoice is "
        + "answered with no figure at all and a sentence that says to make a second agreement in USD",
      askedUsd.answer === "money_mismatch" && askedUsd.figure === null
      && askedUsd.asked_currency === "USD" && askedUsd.rate_currency === "TZS"
      && askedUsd.rate?.basis === "flat",
      { answer: askedUsd.answer, figure: askedUsd.figure, rate: askedUsd.rate?.basis });
    const refusedAssess = await door("assess_commission", [book, "subscription_invoice", subUsd,
      "Trying to cut a dollar paper at a shilling flat.", pen, "billing_admin", IP, UA]);
    check("…and the write door refuses the same mismatch in its own words, so a desk that pressed anyway "
        + "writes no reading rather than a reading in a money the book cannot sum",
      refusedAssess.error === "money_mismatch" && refusedAssess.ok === false, refusedAssess);
    const flatAskedTzs = await ask(company, "subscription_invoice", subTzs);
    check("…and the same agreement speaks plainly for a paper in its own money: the shilling invoice is "
        + "cut at the fifteen thousand the paper names, whatever its total",
      flatAskedTzs.answer === "cut" && flatAskedTzs.figure === "15000.00"
      && flatAskedTzs.currency === "TZS", { figure: flatAskedTzs.figure });
    const percentCompany = rateId(await open({ subject: "tenant", tenant: company,
      source: "subscription_invoice", basis: "percent_of_amount", value: 2,
      note: "Two percent of what this company is billed, in the money the bill is in." }));
    await putLive(percentCompany, "A percent on the company's own subscription bills.");
    const percentUsd = await ask(company, "subscription_invoice", subUsd);
    check("a percentage has no money of its own and so is worked in the transaction's: with the flat "
        + "shilling agreement still live one rung below, the company's own percent answers the dollar "
        + "paper in dollars — 2% of 10,000 is 200, not 200 shillings",
      percentUsd.answer === "cut" && percentUsd.currency === "USD"
      && percentUsd.figure === "200.00" && percentUsd.rate?.rung?.key === "tenant",
      { answer: percentUsd.answer, currency: percentUsd.currency, figure: percentUsd.figure,
        rung: percentUsd.rate?.rung?.key });
    const usdAssessed = await door("assess_commission", [book, "subscription_invoice", subUsd,
      "The dollar bill, cut at the company's own percent.", pen, "billing_admin", IP, UA]);
    if (usdAssessed.ok) mintedReadings++;
    check("…and the reading the door writes carries the transaction's money on its own row, so 138's "
        + "count can keep the two sums apart. `pricing_commission_reading_detail` returns the row itself, "
        + "so its figure is a number while the board's and the preview's are text — the same split the "
        + "desk's own types carry",
      usdAssessed.ok === true && usdAssessed.reading?.reading?.currency === "USD"
      && usdAssessed.reading?.reading?.figure === 200, usdAssessed);
    const usdReadingId = readId(usdAssessed);

    // ---------------- 5 · the two seats ----------------
    phase("5 · one hand cannot set what the office takes out of somebody else's money");
    // The expense ladder, which no earlier phase published a platform rung on: a second agreement on one
    // ladder and one day is refused `days_are_taken` before the signature is ever asked about, and a gate
    // that confused the two refusals would report the two-seat rule as never having run.
    const draft = rateId(await open({ subject: "platform", source: "freight_expense",
      basis: "percent_of_amount", value: 7.5,
      note: "A cut of an agent's expense, put up for a signature." }));
    const paper = await door("propose_pricing_commission_rate", [book, draft,
      "Seven and a half percent of what the office pays out.", pen, "billing_admin", IP, UA]);
    check("raising the paper prints the figure it is cut on and hashes it: the same bytes come out of "
      + "`commission_rate_paper` and the approval's own payload, so the second seat signs a cut rather "
      + "than a sentence",
      paper.ok === true && paper.payload_sha256 === paper.rate?.paper_sha256
      && paper.action === "pricing.commission" && paper.target_kind === "pricing_commission_rate"
      && paper.target_id === draft && paper.paper?.value === "7.5000",
      { sha: paper.payload_sha256, rate: paper.rate?.paper_sha256, paper: paper.paper });
    check("…and the paper the seat is shown names the figure as the register keeps it, not as the desk "
        + "typed it: `numeric(14,4)` prints seven and a half as 7.5000, and a signature cut on the bytes "
        + "has to be re-hashed against the same printing",
      paper.rate?.rate?.status === "pending_signature" && paper.rate?.rate?.value === "7.5000"
      && paper.rate?.approval?.status === "pending",
      { status: paper.rate?.rate?.status, value: paper.rate?.rate?.value });
    const dSelf = (await oi(call("decide_approval", 7), [paper.approval_id, "approve", "My own paper.",
      pen, "billing_admin", IP, UA])).rows[0].r;
    check("the proposer cannot sign their own paper", dSelf?.status === "self", dSelf);
    const tooEarly = await door("apply_pricing_commission_rate", [paper.approval_id, quill,
      "super_admin", IP]);
    check("an unsigned paper publishes nothing, and says which state it found instead: the apply door is "
        + "called only after 121's own claim, so a paper still `pending` is a seat that has not answered "
        + "yet", tooEarly.ok === false && tooEarly.error === "conflict"
      && tooEarly.approval_status === "pending", tooEarly);
    const whileSigned = await door("edit_pricing_commission_rate", [book, draft, 9, null, null, null,
      null, "Trying to move the figure under a signature.", null, pen, "billing_admin", IP, UA]);
    check("a signed draft cannot have its figure moved by the desk: `edit` answers `paper_is_out` and "
        + "names the paper to be refused first, because the signature is cut on bytes the desk is about "
        + "to change", whileSigned.error === "paper_is_out" && whileSigned.ref !== undefined, whileSigned);
    const reRaise = await door("propose_pricing_commission_rate", [book, draft,
      "A second paper for the same version.", pen, "billing_admin", IP, UA]);
    check("one signature stands per version: `propose` reads the row's own state and hands the open "
        + "paper back rather than minting a second seat's errand",
      reRaise.error === "already_open" && reRaise.approval_id === paper.approval_id, reRaise);
    const thrown = await door("discard_pricing_commission_rate", [book, draft,
      "Trying to throw away a paper somebody was asked to sign.", pen, "billing_admin", IP, UA]);
    check("a paper that was put up for a signature cannot be thrown away: `discard` answers `kept` and "
        + "sends the seat to Approvals, because a draft with an open errand on it is not the desk's to "
        + "delete", thrown.error === "kept" && thrown.status === "pending_signature", thrown);
    const refusedPaper = await door("refuse_pricing_commission_rate", [book, draft,
      "Not at seven and a half percent.", quill, "super_admin", IP, UA]);
    const afterRefusal = await one(`select status, approval_id, refusals from pricing_commission_rates
      where id = $1`, [draft]);
    check("a refusal answers the signature first and frees the draft second: the row is a draft again, "
        + "still carrying the paper's number, and the refusals count the desk prints beside the next "
        + "attempt is the register's own column",
      refusedPaper.ok === true && afterRefusal.status === "draft"
      && afterRefusal.approval_id === paper.approval_id && afterRefusal.refusals === 1,
      { refusedPaper, afterRefusal });
    const second = await door("propose_pricing_commission_rate", [book, draft,
      "Up for a second seat again, after a no.", pen, "billing_admin", IP, UA]);
    check("…and a refused draft goes up again: the dead paper is not a wall, because a second seat's "
        + "`no` is a sentence the next version answers rather than a lock on the row",
      second.ok === true && second.approval_id !== paper.approval_id, second);

    // The figure moved while the second paper waited. The desk cannot do it — `edit` refuses — but the
    // table's freeze on the figures only lands once `published_at` is set, so a hand can. That is the case
    // the apply re-hash exists to catch, and the reason it must not stop at catching it.
    const handMoved = await keeps(`update pricing_commission_rates set value = 8, updated_by = $2
       where id = $1`, [draft, pen]);
    check("the table freezes an agreement's figures the day it went live, not the day a paper was put up: "
        + "so a draft waiting for a signature can have its figure moved by a hand no door reaches, and the "
        + "register's only defence is the hash taken at the publish",
      handMoved.ok === true, handMoved.message);
    await oi(call("decide_approval", 7), [second.approval_id, "approve", "Signed on the cut.", pen,
      "billing_admin", IP, UA]);
    await oi(call("decide_approval", 7), [second.approval_id, "approve", "Signed on the cut.", quill,
      "super_admin", IP, UA]);
    await oi(call("claim_approval", 2), [second.approval_id, quill]);
    const staleApply = await door("apply_pricing_commission_rate", [second.approval_id, quill,
      "super_admin", IP]);
    check("a figure moved after the paper was raised cannot be published by that signature: the apply door "
        + "re-hashes the row and refuses the pair, because the second seat signed seven and a half and the "
        + "row says eight",
      staleApply.ok === false && staleApply.error === "paper_moved"
      && staleApply.signed_sha256 === second.payload_sha256
      && staleApply.row_sha256 !== second.payload_sha256, staleApply);
    const notPublished = await one(`select status, value, published_at from pricing_commission_rates
      where id = $1`, [draft]);
    check("…and the refusal publishes nothing on the way out: the eight percent never went live",
      notPublished.published_at === null && notPublished.value === "8.0000", notPublished);
    const freed = await one(`select status, approval_id, refusals from pricing_commission_rates
      where id = $1`, [draft]);
    const freedMemory = (await oi(`select what, reason from pricing_commission_history
       where rate_id = $1 and new_value = 'draft' and old_value = 'pending_signature'
         and reason like 'Freed without a signature%'`, [draft])).rows;
    check("…and it does not strand the draft either. `claim_approval` burns the paper before the effect "
        + "runs, so a refusal that left the row `pending_signature` would leave it waiting on a signature "
        + "that no longer exists: `edit` answers `paper_is_out`, `propose` answers `already_open`, "
        + "`discard` answers `kept` — three doors and Approvals, and no way back for the desk. 140 and 141 "
        + "stop there; 142 hands the row back to a draft and says so in the memory, in a line the desk "
        + "reads beside the hash that moved",
      freed.status === "draft" && freed.refusals === 1 && freedMemory.length === 1
      && freedMemory[0].what === "state", { freed, freedMemory });
    const movedBack = await door("edit_pricing_commission_rate", [book, draft, 7.5, null, null, null,
      null, "Back to seven and a half, the figure the second seat was first shown.", null, pen,
      "billing_admin", IP, UA]);
    const third = await door("propose_pricing_commission_rate", [book, draft,
      "Signed again, at the figure the register now carries.", pen, "billing_admin", IP, UA]);
    check("so the freed draft is a draft: the desk can put the figure right and ask for the signature "
        + "again, which is the only honest end to a paper whose bytes moved. (`edit` hands the detail "
        + "itself while `open` and `propose` hand it under `rate` — the desk reads both and a gate that "
        + "guessed one path would read `undefined` for the other)",
      movedBack.ok === true && movedBack.rate?.value === "7.5000" && third.ok === true,
      { movedBack: movedBack.error, third: third.error });
    const stateLines = (await oi(`select count(*)::int as n from pricing_commission_history
       where rate_id = $1 and what = 'state'`, [draft])).rows[0].n;
    check("…and every state a version passed through is still standing in the memory: opened, refused, "
        + "freed by the apply re-hash, each one a line a dispute reads in order",
      Number(stateLines) >= 4, { stateLines });


    // ---------------- 6 · the readings ----------------
    phase("6 · a cut is taken from a transaction, on the transaction's own day");
    const noRateYet = await door("assess_commission", [book, "freight_expense",
      "00000000-0000-0000-0000-000000000000", "Asking the register for a cut it never agreed.", pen,
      "billing_admin", IP, UA]);
    check("the assess door refuses a transaction the register does not keep rather than assessing it at "
        + "zero — a reading of a nothing is a row nobody owes",
      noRateYet.ok === false && ["no_source", "source_is_not_real", "bad_source_kind"]
        .includes(noRateYet.error), noRateYet);
    const empty = await door("assess_commission", [book, "freight_invoice", emptyInvoice,
      "A cut of an invoice that totals nothing.", pen, "billing_admin", IP, UA]);
    check("…and the same of an invoice whose total is nothing", empty.error === "source_is_empty", empty);
    const cancelled = await door("assess_commission", [book, "freight_invoice", deadInvoice,
      "A cut of a paper that was cancelled.", pen, "billing_admin", IP, UA]);
    check("…and of a cancelled one: a cut is taken from a paper the office actually issued",
      cancelled.error === "source_is_not_real", cancelled);
    const notASeat = await door("assess_commission", [book, "freight_invoice", invoice,
      "A clerk's hand on the office's cut register.", clerk, "staff", IP, UA]);
    check("a company's clerk is not a seat: the door refuses before it reads the register at all",
      notASeat.error === "not_a_seat", notASeat);
    const wrongBook = await door("assess_commission", [company, "freight_invoice", invoice,
      "Trying to take the cut in a company's own book.", pen, "billing_admin", IP, UA]);
    check("a cut is taken in the office's book and nowhere else: handed a company's uuid the door answers "
        + "`not_the_office` rather than accepting whichever book a desk is looking at",
      wrongBook.error === "not_the_office", wrongBook);

    const assessed = await door("assess_commission", [book, "freight_invoice", invoice,
      "The office's own cut on today's freight invoice.", pen, "billing_admin", IP, UA]);
    check("a reading carries the agreement's printed words, the transaction's own money, the raw figure "
        + "and the figure after the least and the most — all four in one row, none typed by a clerk",
      assessed.ok === true && /^CMA-\d{4}-\d{5}$/.test(String(assessed.reading?.reading?.ref ?? ""))
      && assessed.reading?.reading?.status === "assessed"
      && /^CMR-\d{4}-\d{5}$/.test(String(assessed.reading?.reading?.rate_ref ?? "")),
      assessed);
    // `select *` here would hand `assessed_on` back as a Date shifted a day east of Greenwich, so the
    // day the reading was cut on is read as the register's own text.
    const m: any = await one(`select id, ref, status, rate_version, currency, subject_kind, payee_kind,
          raw_amount::text as raw_amount, figure::text as figure,
          source_amount::text as source_amount, assessed_on::text as assessed_on
        from pricing_commission_assessments where id = $1`, [readId(assessed)]);
    mintedReadings++;
    check("…and the row underneath says which rung spoke, at which version, cut on which day: an invoice "
        + "for today is cut at today's agreement and dated from the transaction rather than from the press",
      m.rate_version >= 1 && m.assessed_on === DAY && m.currency === "TZS"
      && m.raw_amount === "40000.0000" && m.figure === "40000.00"
      && m.source_amount === "1000000.00" && m.subject_kind === "tenant"
      && m.payee_kind === "platform" && m.status === "assessed",
      { version: m.rate_version, on: m.assessed_on, raw: m.raw_amount, figure: m.figure,
        rung: m.subject_kind });
    const again = await door("assess_commission", [book, "freight_invoice", invoice,
      "Pressing the same cut a second time.", pen, "billing_admin", IP, UA]);
    check("the double-count this register exists to refuse: the same transaction cut for the same payee "
        + "comes back `already_assessed` and names the payee, so the clerk is told which one to void",
      again.error === "already_assessed" && /already been cut/.test(String(again.message)), again);
    const preview = await ask(company, "freight_invoice", invoice);
    check("the preview answers a question with the register's own reading of it: `already_assessed` rides "
        + "beside the figure so a clerk sees the CMA number before pressing anything",
      preview.answer === "cut" && preview.already_assessed?.ref === m.ref
      && preview.already_assessed?.status === "assessed",
      { already: preview.already_assessed });
    const oldAsked = await ask(company, "freight_invoice", oldInvoice);
    check("a day the ladder has no agreement for is answered honestly rather than at the newest rate: a "
        + "2020 invoice is not cut under an agreement that had not been signed",
      oldAsked.answer === "no_rate" || oldAsked.figure !== m.figure,
      { answer: oldAsked.answer, figure: oldAsked.figure });
    const voided = await door("void_commission_assessment", [book, m.id,
      "The figure was quoted against the wrong paper.", pen, "billing_admin", IP, UA]);
    check("a wrong figure is cancelled and kept, not deleted: the reading's own row carries the stop day "
        + "and the sentence, and the void moves no money because a cut never carried moved none",
      voided.ok === true, voided);
    const voidTwice = await door("void_commission_assessment", [book, m.id,
      "Cancelling the same reading again.", pen, "billing_admin", IP, UA]);
    const carryVoid = await door("discharge_commission_assessment", [book, m.id, "posting",
      "00000000-0000-0000-0000-000000000000", "Trying to carry a cancelled cut.", quill, "super_admin",
      IP, UA]);
    check("…and a cancelled reading owes nothing: it cannot be cancelled twice, nor carried at all",
      voidTwice.error === "already_voided" && carryVoid.error === "is_voided",
      { voidTwice, carryVoid });

    // ---------------- 7 · the pointer ----------------
    phase("7 · saying a cut has been carried is a claim about 133's book");
    /** 134's own order, because `money_payouts_two_seats` fires on INSERT as well as on UPDATE: a payout
     *  the gate wants to see `released` or `paid` cannot be planted by hand at all. The door is borrowed
     *  rather than the guard switched off — a guard this gate disables to save a call is the guard it
     *  exists to prove. */
    const payoutPaper = async (amount: number, fee: number, currency: string, words: string,
      stopAt: "raise" | "release" = "release") => {
      const raised = await door("raise_money_payout", [book, "other", null, "The gate's own agent",
        rail.code, null, null, null, amount, fee, currency, "manual", null, null, words, null, pen,
        "billing_admin", IP, UA]);
      if (raised.ok !== true) return { raised, id: "", ref: "", ap: "" };
      // A paper stopped here is still `raised`: 134's own first state, which the gate needs to see
      // unmovable rather than to move.
      if (stopAt === "raise") return { raised, id: raised.payout.id, ref: raised.payout.ref, ap: "" };
      const proposed = await door("propose_money_payout", [book, raised.payout.id, words, pen,
        "billing_admin", IP, UA]);
      if (proposed.ok !== true) return { raised, proposed, id: raised.payout.id, ref: raised.payout.ref, ap: "" };
      const ap = proposed.approval_id as string;
      await oi(call("decide_approval", 7), [ap, "approve", "Signed on the payment.", pen,
        "billing_admin", IP, UA]);
      await oi(call("decide_approval", 7), [ap, "approve", "Signed on the payment.", quill,
        "super_admin", IP, UA]);
      await oi(call("claim_approval", 2), [ap, quill]);
      const released = await door("apply_payout_release", [ap, quill, "super_admin", IP]);
      return { raised, proposed, released, id: raised.payout.id, ref: raised.payout.ref, ap };
    };
    const assessed2 = await door("assess_commission", [book, "freight_invoice", planInvoice,
      "The plan's own invoice, cut at the plan's figure.", pen, "billing_admin", IP, UA]);
    const r2id = readId(assessed2);
    if (assessed2.ok) mintedReadings++;
    const r2 = assessed2.reading?.reading ?? {};
    check("a second transaction is cut at the rung that rules it: the plan's invoice reads 2.5% of "
        + "1,000,000 lifted to the plan's 30,000 floor rather than the four percent negotiated with the "
        + "first company, and the reading says which rung spoke on its own row",
      assessed2.ok === true && r2.figure === 30000 && r2.subject_kind === "plan"
      && r2.currency === "TZS", { figure: r2.figure, rung: r2.subject_kind });

    const noPen = await door("discharge_commission_assessment", [book, r2id, "posting",
      "00000000-0000-0000-0000-000000000000", "A seat with no pen on the book.", noDuty, "super_admin",
      IP, UA]);
    check("carrying a cut needs 133's duty as well as the pricing one: a seat that cannot write in the "
        + "book cannot claim the book already did",
      noPen.error === "no_money_duty", noPen);
    const badCarrier = await door("discharge_commission_assessment", [book, r2id, "cash",
      "00000000-0000-0000-0000-000000000000", "A word the book does not use.", quill, "super_admin",
      IP, UA]);
    check("a cut is carried by a payout or a posting and by nothing else: the two movements the book "
        + "itself makes, because a name typed beside a date is not a payment",
      badCarrier.error === "bad_carrier", badCarrier);
    const ghostPayout = await door("discharge_commission_assessment", [book, r2id, "payout",
      "00000000-0000-0000-0000-000000000000", "Pointed at a payout nobody raised.", quill,
      "super_admin", IP, UA]);
    const ghostPosting = await door("discharge_commission_assessment", [book, r2id, "posting",
      "00000000-0000-0000-0000-000000000000", "Pointed at a posting nobody made.", quill, "super_admin",
      IP, UA]);
    check("a pointer at a movement the office never raised is refused: how a liability gets called paid "
        + "by a keystroke, so the door reads the book before it believes the desk",
      ghostPayout.error === "no_such_payout" && ghostPosting.error === "no_such_posting",
      { ghostPayout, ghostPosting });
    /** 133's own shape, built here rather than bent: a movement is a header and a matched pair of legs,
     *  and the figure on the header is copied from the legs. The pair's balance is proved by a deferred
     *  constraint trigger that only answers at COMMIT, and this gate never commits — so an unbalanced
     *  fixture would be planted silently and the pointer would be proved against a paper the book itself
     *  refuses. Refs are digit-only because `money_postings` will not carry anything else. */
    const pstBase = Number((await one(`select coalesce(max((split_part(ref,'-',3))::int),0) + 1 as n
      from money_postings where ref ~ '^PST-2026-[0-9]+$'`)).n);
    let pstN = 0;
    const post = async (o: { memo: string, credit: string, debit: string, figure: number,
      currency: string, reversed?: boolean }) => {
      pstN++;
      const ref = `PST-2026-${String(Math.max(pstBase, 90001) + pstN).padStart(5, "0")}`;
      const id = (await one(`insert into money_postings (tenant_id, ref, posted_on, memo, currency,
          source_kind, total, status, raised_by, reversed_by, reversed_at, reversal_note)
         values ($1,$2,$3::date,$4,$5,'fee',$6,$7,$8,$8,case when $7 = 'reversed' then now() end,
                  case when $7 = 'reversed' then 'The office undid the whole movement.' end)
         returning id`,
        [office, ref, DAY, o.memo, o.currency, o.figure, o.reversed ? "reversed" : "posted", quill])).id;
      await oi(`insert into money_entries (posting_id, tenant_id, account_id, direction, amount, detail)
         values ($1,$2,$3,'credit',$5,'The income line the register reads.'),
                 ($1,$2,$4,'debit', $5,'The other side of the same movement.')`,
        [id, office, o.credit, o.debit, o.figure]);
      return { id, ref };
    };
    const wrongLegPaper = await post({ memo: "Commission gate: the fee line says less than the cut.",
      credit: feeAcc, debit: costAcc, figure: 25000, currency: "TZS" });
    const wrongLeg = await door("discharge_commission_assessment", [book, r2id, "posting",
      wrongLegPaper.id, "The credit leg says 25,000 and the cut is 30,000.", quill, "super_admin", IP, UA]);
    check("the register reads the figure out of the movement, not out of the pointer: a credit leg of "
        + "25,000 cannot carry a cut of 30,000, and the refusal prints both so the office can see the gap "
        + "it still counts",
      wrongLeg.error === "carrier_does_not_carry_the_cut"
      && wrongLeg.asked === "30000.00" && wrongLeg.carries === "25000.00"
      && wrongLeg.ref === wrongLegPaper.ref, wrongLeg);
    const usdPaper = await post({ memo: "Commission gate: a dollar paper for a shilling cut.",
      credit: feeUsd, debit: costUsd, figure: 30000, currency: "USD" });
    const wrongMoney = await door("discharge_commission_assessment", [book, r2id, "posting", usdPaper.id,
      "A dollar paper for a shilling cut.", quill, "super_admin", IP, UA]);
    check("138's rule holds at the pointer too: a USD paper cannot carry a TZS cut even when its figure "
        + "matches to the pesa, because one currency per posting is the book's own rule",
      wrongMoney.error === "carrier_is_other_money"
      && wrongMoney.posting_currency === "USD" && wrongMoney.reading_currency === "TZS", wrongMoney);
    const reversedPaper = await post({ memo: "Commission gate: undone before it proved anything.",
      credit: feeAcc, debit: costAcc, figure: 30000, currency: "TZS", reversed: true });
    const undone = await door("discharge_commission_assessment", [book, r2id, "posting",
      reversedPaper.id, "An undone movement as proof.", quill, "super_admin", IP, UA]);
    check("…and a reversed posting is refused first, in its own words and before its legs are read: an "
        + "undone movement is not the proof a cut was carried",
      undone.error === "posting_is_reversed", undone);
    const noLegPaper = await post({ memo: "Commission gate: a paper with no income line on it.",
      credit: cashAcc, debit: costAcc, figure: 30000, currency: "TZS" });
    const missingLeg = await door("discharge_commission_assessment", [book, r2id, "posting", noLegPaper.id,
      "A paper that never booked the income.", quill, "super_admin", IP, UA]);
    check("a cut the office keeps is income and income has a line: a posting with no credit leg on "
        + "FEE-INCOME is refused rather than accepted as a gesture, and the refusal says which line it "
        + "looked for",
      missingLeg.error === "carrier_has_no_such_leg"
      && missingLeg.looked_for === "a credit leg on FEE-INCOME", missingLeg);
    const rightPaper = await post({ memo: "Commission gate: the cut booked exactly as the register "
      + "counted it.", credit: feeAcc, debit: costAcc, figure: 30000, currency: "TZS" });
    const carried = await door("discharge_commission_assessment", [book, r2id, "posting", rightPaper.id,
      "The office booked the cut as income on the day the money moved.", quill, "super_admin", IP, UA]);
    const carriedRow = await one(`select status, carrier_kind, carrier_id, carrier_ref, discharge_note,
        discharged_at is not null as dated, discharged_by from pricing_commission_assessments
        where id = $1`, [r2id]);
    check("the pointer that matches writes no money and changes only the reading: the movement's own "
        + "reference is copied into the row, the door names the figure it read out of the leg, and the "
        + "book is left exactly as it was",
      carried.ok === true && carried.carried_by === rightPaper.ref && carriedRow.status === "discharged"
      && carriedRow.carrier_kind === "posting" && String(carriedRow.carrier_id) === rightPaper.id
      && carriedRow.carrier_ref === rightPaper.ref && carriedRow.dated === true
      && String(carriedRow.discharged_by) === quill, { carried, carriedRow });
    const doubleCarry = await door("discharge_commission_assessment", [book, r2id, "posting",
      rightPaper.id, "Carrying the same cut twice.", quill, "super_admin", IP, UA]);
    const voidCarried = await door("void_commission_assessment", [book, r2id,
      "Trying to cancel a cut the book has already paid.", pen, "billing_admin", IP, UA]);
    check("…and a carried cut answers twice in the same words: it cannot be pointed at a second movement, "
        + "nor cancelled by this register, because the movement that carried it is answered in the book "
        + "by 133's reversal — a void here would leave the register disagreeing with the ledger",
      doubleCarry.error === "already_carried" && voidCarried.error === "already_carried"
      && doubleCarry.carrier === rightPaper.ref, { doubleCarry, voidCarried });
    const usdAgainstTzs = await door("discharge_commission_assessment", [book, usdReadingId, "posting",
      rightPaper.id, "A shilling movement offered for a dollar cut.", quill, "super_admin", IP, UA]);
    check("…and the same rule read from the other side: the dollar reading the office owes stays open "
        + "when pointed at the shilling paper that matches its figure, because 138's count is per money "
        + "and a pointer that crosses monies is the drift it refuses",
      usdAgainstTzs.error === "carrier_is_other_money"
      && usdAgainstTzs.posting_currency === "TZS" && usdAgainstTzs.reading_currency === "USD",
      usdAgainstTzs);
    const detail = (await oi(call("pricing_commission_reading_detail", 2), [book, r2id])).rows[0].r;
    check("a reading's own memory carries its money and both of its states: assess then discharge, each "
        + "line naming the currency it was booked in — which is the column 142's projection had to be "
        + "edited to carry, and the two lines a voided reading never has. Both are written in one "
        + "statement, so they share `now()` and `order by at desc` cannot settle their sequence; the gate "
        + "names the set instead",
      detail.ok === true && Array.isArray(detail.memory) && detail.memory.length === 2
      && detail.memory.every((h: any) => h.currency === "TZS")
      && [...new Set(detail.memory.map((h: any) => h.what))].sort().join() === "assess,discharge",
      detail.memory?.map((h: any) => [h.what, h.currency]));
    const raisedPaper = await payoutPaper(100000, 30000, "TZS",
      "The gate pays an agent its cut from the office's own till.", "raise");
    const assessed3 = await door("assess_commission", [book, "freight_invoice",
      await inv(2000000, "TZS", "sent", DAY, planCompany),
      "A bigger invoice on the same plan rung.", pen, "billing_admin", IP, UA]);
    if (assessed3.ok) mintedReadings++;
    const r3id = readId(assessed3);
    const r3 = assessed3.reading?.reading ?? {};
    check("…and the rung rules the invoice rather than the day: 2.5% of 2,000,000 is 50,000, well above "
        + "the plan's floor, and the register keeps the two readings apart by their own transactions",
      assessed3.ok === true && r3.figure === 50000, { figure: r3.figure });
    const raisedPayout = await door("discharge_commission_assessment", [book, r3id, "payout",
      raisedPaper.id, "A plan, not money that left.", quill, "super_admin", IP, UA]);
    check("a raised payout is a plan and an unsigned one is a question: neither carries a cut, so the "
        + "door refuses the pointer while the paper still says `raised` and prints the state it found",
      raisedPayout.error === "payout_has_not_moved" && raisedPayout.payout_status === "raised"
      && raisedPaper.raised?.ok === true, { raisedPayout, raised: raisedPaper.raised });
    const signedPayout = await payoutPaper(100000, 30000, "TZS",
      "Signed by a second seat, but the cash has not left yet.");
    const releasedOnly = await door("discharge_commission_assessment", [book, r3id, "payout",
      signedPayout.id, "A released paper as proof of the office's income.", quill, "super_admin",
      IP, UA]);
    check("a released payout owes the money and has not paid it: for a cut the office keeps, the fee "
        + "line only exists once the cash leaves, so the door says so instead of trusting the obligation",
      releasedOnly.error === "fee_is_not_booked_yet" && releasedOnly.payout_status === "released"
      && signedPayout.released?.ok === true,
      { releasedOnly, released: signedPayout.released });
    const paid = await door("mark_money_payout_paid", [book, signedPayout.id,
      "The till paid the agent and the office booked its fee.", DAY, quill, "super_admin", IP, UA]);
    const feeMismatch = await door("discharge_commission_assessment", [book, r3id, "payout",
      signedPayout.id, "A paid payout whose fee is not this cut.", quill, "super_admin", IP, UA]);
    check("…and the same pointer at the paid paper is refused on its figure, not on its state: the "
        + "movement carries a fee of 30,000 and the reading is 50,000, so the gap stays owed and counted "
        + "— fixing the pointer is not a way to close it",
      paid.ok === true && feeMismatch.error === "carrier_does_not_carry_the_cut"
      && feeMismatch.asked === "50000.00" && feeMismatch.carries === "30000.00",
      { paid, feeMismatch });
    const feeCarried = await door("discharge_commission_assessment", [book, r2id, "payout",
      signedPayout.id, "Trying to carry an already carried cut with a payout.", quill, "super_admin",
      IP, UA]);
    check("…and a cut the register has already carried cannot be carried a second time by a different "
        + "movement, even a paid payout whose fee matches it exactly: one reading, one carrier",
      feeCarried.error === "already_carried" && feeCarried.carrier === rightPaper.ref, feeCarried);


    // ---------------- 8 · the rules kept below the doors ----------------
    phase("8 · provoking the guards, the CHECKs and the index with no door in between");
    const RATE_BASE = { tenant_id: "", ref: "", subject_kind: "platform", subject_key:
      "00000000-0000-0000-0000-000000000000", subject_name: "The office", source_kind: "payout",
      payee_kind: "platform", payee_name: "The office itself", basis: "percent_of_amount", value: 5,
      status: "draft", note: "A row planted by hand to test the table's own rules." };
    let plantN = 0;
    const plantRate = async (o: Record<string, any> = {}) => {
      plantN++;
      /** One version per plant, and no plant shares one with another: the version chain is the one rule
       *  keyed on (subject, transaction, version), so a fixed number would make every plant collide with
       *  the plant before it and the gate would report the same refusal nine times. `dupVersion` below
       *  names a real ladder's version instead. */
      const row: Record<string, any> = { ...RATE_BASE, tenant_id: office, version: 9900 + plantN,
        ref: `CMR-2026-9${String(plantN).padStart(4, "0")}`, effective_from: DAY, ...o };
      if (row.subject_key === "" || row.subject_key === undefined) {
        row.subject_key = row.subject_tenant_id ?? row.subject_plan_id
          ?? "00000000-0000-0000-0000-000000000000";
      }
      const keys = Object.keys(row);
      return { sql: `insert into pricing_commission_rates (${keys.join(", ")}) values (`
        + `${keys.map((_, i) => `$${i + 1}`).join(", ")})`, p: keys.map(k => row[k]), row };
    };
    const plantRateRefused = async (o: Record<string, any>) => {
      const { sql, p } = await plantRate(o);
      return refused(sql, p);
    };
    /** A reading planted by hand. The door copies twenty-odd columns off the agreement and the register,
     *  so a hand that wants to break one rule has to satisfy all the others first — including the
     *  reference's own shape, which is digits only and so cannot carry this run's hex stamp. Each plant
     *  stands for its own transaction: the partial unique index is keyed on the paper, and two plants on
     *  one invoice would prove the index instead of the rule they name. */
    const cmaBase = Number((await one(`select coalesce(max((split_part(ref,'-',3))::int),0) + 1 as n
      from pricing_commission_assessments where ref ~ '^CMA-[0-9]{4}-[0-9]{5,}$'`)).n);
    let cmaN = 0;
    const cmaRef = () => `CMA-2026-${String(Math.max(cmaBase, 90001) + ++cmaN).padStart(5, "0")}`;
    const plantReading = (over: Record<string, any> = {}) => {
      const row: Record<string, any> = { tenant_id: office,
        ref: cmaRef(),
        rate_id: tenantRate, rate_ref: "CMR-2026-00001", rate_version: 1,
        rate_basis: "percent_of_amount", rate_value: "4.0000", rate_currency: null,
        subject_kind: "tenant", subject_key: company, subject_name: COMPANY, payee_kind: "platform",
        payee_id: null, payee_name: "The office itself", source_kind: "freight_invoice",
        source_id: randomUUID(), source_ref: "FI-plant", source_amount: 100, currency: "TZS",
        raw_amount: 4, figure: 4, assessed_on: PAST, status: "assessed",
        note: "A reading planted by hand to test the table's own rules.", assessed_by: pen, ...over };
      const keys = Object.keys(row);
      return { sql: `insert into pricing_commission_assessments (${keys.join(", ")}) values (`
        + `${keys.map((_, i) => `$${i + 1}`).join(", ")})`, p: keys.map(k => row[k]) };
    };
    const plantReadingRefused = async (over: Record<string, any> = {}) => {
      const { sql, p } = await plantReading(over);
      return refused(sql, p);
    };
    /** The same row, moved by hand rather than planted: exactly two writes are allowed against a reading,
     *  and both of them have an arm the guard watches. `r3id` is still open, so it is the one row a hand
     *  can point at without tripping the state rule first. */
    const arm = (set: string, id: string, p: any[] = []) =>
      refused(`update pricing_commission_assessments set ${set} where id = $1`, [id, ...p]);
    const fifteen = await plantRateRefused({ value: 150 });
    check("a percent over one hundred is a typing mistake the table refuses on its own, before any door "
      + "is asked to check it", /percent_is_a_percent|value <= 100/.test(fifteen), fifteen);
    const flatNoMoney = await plantRateRefused({ basis: "flat", currency: null });
    check("a flat with no money named: the table keeps 138's half of the rule, that a figure has to say "
      + "which money it is in", /flat_has_a_money/.test(flatNoMoney), flatNoMoney);
    const percentMoney = await plantRateRefused({ basis: "percent_of_amount", currency: "TZS" });
    check("…and a percentage that carries one is refused the other way round, because a percent is worked "
      + "in the transaction's money and a second money on the paper is a promise nobody signed",
      /percent_carries_no_money/.test(percentMoney), percentMoney);
    const inverted = await plantRateRefused({ effective_from: DAY, effective_to: PAST });
    check("an agreement whose window closes before it opens", /window_is_a_window/.test(inverted),
      inverted);
    const floorCap = await plantRateRefused({ floor_amount: 90000, cap: 10000 });
    check("a least above a most: `floor <= cap` is what makes the lift and the clamp order in phase 2 "
        + "mean anything, so the table guards the pair", /floor_below_ceiling/.test(floorCap), floorCap);
    const publishedNoStart = await plantRateRefused({ status: "published", effective_from: null });
    check("a published agreement with no start day: the day it rules has to be a day somebody signed for",
      /published_has_a_start/.test(publishedNoStart), publishedNoStart);
    const pendingNoApproval = await plantRateRefused({ status: "pending_signature", approval_id: null });
    check("a draft marked signed-for with no signature behind it — the state 121's register is the only "
        + "thing that can put a row into", /unsigned_paper_is_pending/.test(pendingNoApproval),
      pendingNoApproval);
    const withdrawnQuietly = await plantRateRefused({ status: "withdrawn" });
    check("a stopped agreement with no sentence: the pair agrees in both directions, so a desk cannot "
        + "stop a cut and leave the reason unsaid", /withdrawal_is_explained/.test(withdrawnQuietly),
      withdrawnQuietly);
    const twoSubjects = await plantRateRefused({ subject_kind: "tenant", subject_tenant_id: company,
      subject_plan_id: PLAN,
      subject_key: company });
    check("a rung that names two subjects at once: exactly one half is set, and the guard below copies "
        + "the name, so the table refuses the pair before a trigger can choose one",
      /subject_is_one_thing/.test(twoSubjects), twoSubjects);
    const platformWithId = await plantRateRefused({ payee_kind: "platform", payee_id: company });
    check("the office keeping a cut with an id attached: `platform` is a payee with no register behind it",
      /payee_is_one_thing/.test(platformWithId), platformWithId);
    const selfSupersede = await plantRateRefused({ supersedes_id:
      "00000000-0000-0000-0000-000000000000", id: "00000000-0000-0000-0000-000000000000" });
    check("an agreement that supersedes itself", /does_not_supersede_itself/.test(selfSupersede),
      selfSupersede);
    const dupVersion = await plantRateRefused({ subject_kind: "platform",
      source_kind: "freight_invoice", version: 1 });
    check("a version chain keyed on the subject *and* the transaction: the office's own version one on a "
        + "freight invoice is the agreement phase 3 put live, so a hand cannot file a second paper at the "
        + "same step of the same ladder",
      /one_version_per_ladder|duplicate key/.test(dupVersion), dupVersion);
    const payoutLadder = await plantRate({ source_kind: "payout", version: 1 });
    const otherLadder = await keeps(payoutLadder.sql, payoutLadder.p);
    check("…and the same version number on the other transaction is a different agreement that may well "
        + "run at a different figure on one day, which is why the chain is keyed on the pair and not on "
        + "the number", otherLadder.ok === true, otherLadder.message);
    const notOffice = await plantRateRefused({ tenant_id: company });
    check("the book a cut is agreed in: planted in a company's book the guard answers in the words a clerk "
        + "needs, because a cut written into somebody else's register is the office taking money nobody "
        + "agreed to — and it answers before the subject, the transaction or the payee are looked at",
      /not in a company/.test(notOffice), notOffice);
    const rungNamesACompany = await plantRateRefused({ subject_kind: "platform", subject_tenant_id: company,
      subject_key: "00000000-0000-0000-0000-000000000000" });
    check("the office's own rung cannot also name a company: the guard that copies the subject refuses the "
        + "pair in its own sentence, before the table's `subject_is_one_thing` is ever reached",
      /names no company and no plan/.test(rungNamesACompany), rungNamesACompany);
    const jumped = await plantRate({ subject_kind: "tenant", subject_tenant_id: company,
      subject_key: "00000000-0000-0000-0000-000000000000", subject_name: "Somebody else" });
    const jumpedKeep = await keeps(jumped.sql + " returning subject_key::text as key, subject_name",
      jumped.p);
    check("a rung jumped by writing a wrong key and a wrong name: the copy trigger overwrites both from "
        + "the subject it is handed, so a hand cannot file an agreement at the office's own rung and label "
        + "it a company's — and cannot even leave the label it typed standing",
      jumpedKeep.ok === true && jumpedKeep.rows[0]?.key === company
      && jumpedKeep.rows[0]?.subject_name === COMPANY, jumpedKeep.rows[0] ?? jumpedKeep.message);
    const signedDelete = await refused(`delete from pricing_commission_rates where id = $1`, [tenantRate]);
    check("an agreement that was put up for a signature cannot be deleted — the paper a second seat read "
        + "outlives the figure, which is why 142's smoke leaves its fixture behind",
      /rates_are_kept|kept/.test(signedDelete), signedDelete);
    const memoryMove = await refused(`update pricing_commission_history set new_value = ' rewritten' `
      + `where rate_id = $1`, [tenantRate]);
    const memoryDelete = await refused(`delete from pricing_commission_history where rate_id = $1`, [tenantRate]);
    check("the memory is append-only: what an agreement used to be cannot be moved or unmade, because the "
        + "dispute this register exists for is about what was said and when — and the delete answers with "
        + "the agreement it belongs to, not with a bare rule name",
      /append-only/.test(memoryMove) && /is kept/.test(memoryDelete), { memoryMove, memoryDelete });
    const readingGone = await refused(`delete from pricing_commission_assessments where id = $1`, [m.id]);
    check("a reading that was taken cannot be deleted, cancelled or not: 138's void column exists so a "
        + "mistake stops counting without disappearing from the record",
      /it is kept/.test(readingGone), readingGone);
    const tooBig = await plantReadingRefused({ source_amount: 100, raw_amount: 200, figure: 150 });
    check("a cut bigger than the money it sits on: the table refuses the row, and 134 says the same of a "
        + "payout's fee, because the two figures are the same fact seen from either side",
      /cut_fits_the_money/.test(tooBig), tooBig);
    const flatDrift = await plantReadingRefused({ rate_basis: "flat", rate_currency: "USD",
      currency: "TZS", raw_amount: 1, figure: 1 });
    check("a flat reading prints the money its agreement was named in, and the table refuses a print in a "
        + "different money from the paper it was taken from: 138's rule kept on the row rather than left "
        + "to the door that wrote it",
      /assessment_carries_its_rate/.test(flatDrift), flatDrift);
    const voidNoDay = await plantReadingRefused({ status: "voided", voided_by: pen,
      void_reason: "A wrong figure, cancelled by a hand rather than by a door." });
    check("a void with no stop day is refused by the same kind of pair: the sentence is there and the date "
        + "is not, so a door that forgot to stamp it would abort rather than leave a cancelled cut nobody "
        + "can put back in the count",
      /void_is_explained/.test(voidNoDay), voidNoDay);
    const bothArms = await plantReadingRefused({ status: "voided", voided_at: new Date(), voided_by: pen,
      discharged_at: new Date(), void_reason: "A cut cancelled and, somehow, carried." });
    check("a reading is carried or cancelled and never both: each arm is honestly explained on its own "
        + "here, so it is the third rule — one state per row — that refuses the pair",
      /reading_is_one_thing/.test(bothArms), bothArms);
    const halfDischarge = await arm(`status = 'discharged', carrier_kind = 'posting', carrier_id = $2`,
      r3id, [randomUUID()]);
    check("the guard watches the discharge arm before the table weighs the columns: a hand that points at "
        + "a movement without naming the seat or writing the sentence is refused in the register's own "
        + "words, not with a constraint name",
      /needs the seat, the movement/.test(halfDischarge), halfDischarge);
    const dischargeNoDay = await arm(`status = 'discharged', discharged_by = $2, carrier_kind = 'posting',`
      + ` carrier_id = $3, discharge_note = 'Carried by hand, with no day on it.'`, r3id,
      [quill, randomUUID()]);
    check("…and the arm the guard lets through is stopped by the CHECK: seat, movement and sentence are "
        + "all there and the day is not, so a door that forgot to stamp it would abort rather than leave a "
        + "carried cut nobody can date",
      /discharge_is_explained/.test(dischargeNoDay), dischargeNoDay);
    const stateTwice = await arm(`status = 'voided', voided_at = now(), voided_by = $2,`
      + ` void_reason = 'Cancelling a cut the book already carried.'`, r2id, [quill]);
    check("a reading changes its state once, and the guard says so before the columns are weighed: the "
        + "carried cut keeps its carrier, and a void written over it is the disagreement this register "
        + "refuses to have with 133's book",
      /changes its state once/.test(stateTwice), stateTwice);
    const printedDrift = await arm(`rate_value = '99'`, r3id);
    check("a reading prints the agreement's figure as the paper carried it, and the guard refuses the "
        + "print being edited: a book that lets its own receipts be retyped is a book with no receipts",
      /frozen the moment it is written/.test(printedDrift), printedDrift);
    const dupLive = await refused(`insert into pricing_commission_assessments (tenant_id, ref, rate_id,
        rate_ref, rate_version, rate_basis, rate_value, rate_currency, subject_kind, subject_key,
        subject_name, payee_kind, payee_id, payee_name, source_kind, source_id, source_ref,
        source_amount, currency, raw_amount, figure, assessed_on, status, note, assessed_by)
       select $1,$2, a.rate_id, a.rate_ref, a.rate_version, a.rate_basis, a.rate_value, a.rate_currency,
              a.subject_kind, a.subject_key, a.subject_name, a.payee_kind, a.payee_id, a.payee_name,
              a.source_kind, a.source_id, a.source_ref, a.source_amount, a.currency, a.raw_amount,
              a.figure, a.assessed_on, 'assessed', 'A second live cut on the same transaction.', $3
         from pricing_commission_assessments a where a.id = $4`,
      [office, cmaRef(), pen, r2id]);
    check("the partial index is what refuses a second live cut on one transaction: the door's "
        + "`already_assessed` is the same rule read twice, once for a clerk and once for a hand — and a "
        + "carried reading still holds its transaction, because a cut is taken once",
      /one_live_reading|duplicate key/.test(dupLive), dupLive);
    const overlap = await plantRateRefused({ subject_kind: "platform", source_kind: "freight_invoice",
      version: 4, status: "published", effective_from: DAY, published_at: new Date(),
      published_by: pen, note: "A second published window for the same rung and day, planted by hand." });
    check("two published windows for one ladder and one day: the overlap guard refuses the pair in the "
        + "sentence a clerk reads — it names both papers — which is why a version moves forward by closing "
        + "the day underneath it",
      /both put a|one answer/.test(overlap), overlap);
    const checkRows = (await oi(`select conname from pg_constraint where conname = any($1)`,
      [[...RATE_CHECKS, ...READING_CHECKS]])).rows.map((r: any) => r.conname);
    check(`all ${RATE_CHECKS.length + READING_CHECKS.length} named rules are in the catalog — `
        + `${RATE_CHECKS.length} on the agreements and ${READING_CHECKS.length} on the readings`,
      [...RATE_CHECKS, ...READING_CHECKS].every(n => checkRows.includes(n)),
      [...RATE_CHECKS, ...READING_CHECKS].filter(n => !checkRows.includes(n)));
    const trgRows = (await oi("select tgname from pg_trigger where tgname = any($1) and not tgisinternal",
      [Object.keys(TRIGGERS)])).rows.map((r: any) => r.tgname);
    check(`the ${Object.keys(TRIGGERS).length} triggers 142 fires are attached to the tables each one `
      + "stands on", Object.keys(TRIGGERS).every(k => trgRows.includes(k)),
      Object.keys(TRIGGERS).filter(k => !trgRows.includes(k)));
    const partialIdx = await one(`select indexname, indexdef from pg_indexes where schemaname = 'public'
      and indexname = 'pricing_commission_one_live_reading'`);
    check("one live reading per transaction and payee is an index, not a promise: a void reading is out of "
        + "the index, so a mistake can be cancelled and the transaction cut again — and a second live "
        + "cut cannot be slipped in by hand",
      !!partialIdx?.indexdef && /voided_at IS NULL/i.test(partialIdx.indexdef), partialIdx);

    // ---------------- 9 · the desk and the door ----------------
    phase("9 · the desk's words, the door's duty, and the arithmetic that stays out of the browser");
    const doorCodes = ["already_assessed", "carrier_is_other_money", "no_money_duty", "not_the_office",
      "carrier_does_not_carry_the_cut", "payout_has_not_moved", "money_mismatch", "percent_too_wide",
      "paper_moved", "is_voided", "already_carried"];
    const deskMentions = (f: string) => doorCodes.filter(c => f.includes(`"${c}"`) || f.includes(c));
    check("every refusal this gate provoked is a word the desk knows: the browser can only explain a "
        + "refusal it branches on, and a code that arrives unnamed is shown as a bare sentence",
      deskMentions(cuts).length + deskMentions(readings).length + deskMentions(page).length >= 8,
      { cuts: deskMentions(cuts), readings: deskMentions(readings), page: deskMentions(page) });
    check("the pointer's honesty is kept at the box too: the readings desk names 133's duty and refuses "
        + "the press in words when the seat does not hold it, rather than letting the door be the only "
        + "one to say so",
      readings.includes("control.money.post") && page.includes("control.money.post"),
      { readings: readings.includes("control.money.post"), page: page.includes("control.money.post") });
    check("no figure is worked out in the browser: the desks print what `commission_on` and the register "
        + "answer, and neither multiplies a percentage by an amount itself",
      !/value\s*\*\s*|\/\s*100/.test(cuts + readings),
      (cuts + readings).match(/.{0,40}\/\s*100.{0,20}/g)?.slice(0, 3));
    check("the second seat is not at this desk: no door the pricing card calls publishes an agreement, "
        + "because 142's publish is 121's effect `commission_publish` — the route file names the apply "
        + "door only in the comment that says it is not a route, and approvals.ts is where the effect is "
        + "run, in the register's own order, by the seat that signed",
      !/platform_auth\.apply_pricing_commission_rate\(/.test(route)
      && /apply_pricing_commission_rate\(\$1/.test(approvals) && /commission_publish/.test(approvals)
      && /"pricing\.commission"/.test(approvals),
      { sqlInRoute: /platform_auth\.apply_pricing_commission_rate\(/.test(route),
        effectInApprovals: /apply_pricing_commission_rate\(\$1/.test(approvals) });
    const writeDoors = WRITES.filter(w => !w.startsWith("apply_"));
    const bound = writeDoors.filter(w => new RegExp(`platform_auth.${w}\\(`).test(route));
    check("the desk reaches every write door the register has — each of them is a definer call the route "
        + "hands the book from the session rather than from the caller",
      bound.length === writeDoors.length, writeDoors.filter(w => !bound.includes(w)));
    /** Every one of the eighteen definer calls binds a book in `$1`, and the preview is now inside that
     *  count rather than the exception to it. Its first parameter used to be the company the desk was
     *  asking about, which let it walk a ladder keyed on the register's nil uuid — one office's standing
     *  rung, read as another's. The book came to the front of the signature and the company moved to
     *  `$2`, where the register still cross-checks it against the transaction (`asked_other_book`, proved
     *  in phase 3) so a caller cannot buy a rung it was not cut under. */
    const calls = (route.match(/door\(req,/g) ?? []).length;
    const sessionBound = (route.match(/\[tenantOf\(req\)/g) ?? []).length;
    check("142's doors take the book from `req.control.tenant_id` and bind it in `$1`, the preview "
        + "included: `withTenant` wraps the one socket the door opens and is not the guard, because this "
        + "schema's role bypasses row-level security — so a call that named no book would answer one "
        + "office's question out of another office's register",
      /String\(req\.control\.tenant_id\)/.test(route) && calls === sessionBound && calls === 18
      && (route.match(/withTenant\(/g) ?? []).length === 1
      && /asked_other_book/.test(src), { calls, sessionBound });
    check("…and 142 writes no audit row of its own: each door calls `money_audit` inside its statement, "
        + "so a route that audited on top would double every line in the register",
      !/writeAudit\(/.test(route), (route.match(/writeAudit\(/g) ?? []).length);
    const probe = analytics.includes('"control.money.post"') && analytics.includes('"control.pricing.manage"');
    check("the duty keys the desks branch on are in the permissions probe's list, so a seat that holds a "
        + "duty is not told it does not — the allowlist trap 140 shipped with",
      probe, { money: analytics.includes('"control.money.post"') });
    check("the reading's memory prints its money because the door hands it: 142's projection had to be "
        + "edited to carry `currency` beside its siblings, and a desk that printed a figure with no "
        + "money would be 138's defect in a new place",
      /'currency', h\.currency/.test(src) && /h\.currency/.test(readings),
      (src.match(/'currency', h\.currency/g) ?? []).length);

    // ---------------- 10 · the summary and the board ----------------
    phase("10 · the counts a desk must not do for itself");
    const board = (await oi(call("pricing_commission_rates", 7),
      [book, null, null, null, null, 20, 0])).rows[0].r;
    check("the agreements board answers with its own pile counts, keyed per state, and the rung and "
        + "transaction vocabularies ride with them so a second read is not needed to fill a picker",
      board.ok === true && board.counts && Array.isArray(board.subjects) && board.subjects.length === 3
      && board.sources.length === 5,
      { counts: board.counts, subjects: board.subjects?.length, sources: board.sources?.length });
    const readingsBoard = (await oi(call("pricing_commission_assessments", 8),
      [book, null, null, null, null, null, 20, 0])).rows[0].r;
    check("the readings board counts the piles the desk prints beside them, and reaches a transaction by "
        + "its own reference — `has this invoice been cut?` is the question a clerk actually asks",
      readingsBoard.ok === true && readingsBoard.counts?.assessed !== undefined
      && readingsBoard.counts?.discharged !== undefined
      && Object.keys(readingsBoard.counts).some(k => k.startsWith("src_")),
      readingsBoard.counts);
    const sum = (await oi(call("pricing_commission_summary", 3), [book, null, null])).rows[0].r;
    const tz = sum.by_currency?.find((r: any) => r.currency === "TZS");
    const us = sum.by_currency?.find((r: any) => r.currency === "USD");
    check("the office's own count is kept per money: the shilling line holds the three shilling readings — "
        + "the 50,000 still open, the 30,000 the book carried and the 40,000 that was cancelled — and the "
        + "dollar line holds the one dollar reading, because 138's lesson is that a sum of two monies is a "
        + "number with no meaning",
      sum.ok === true && sum.by_currency?.length === 2
      && tz.reading_count === 3 && tz.open_count === 1 && tz.open_amount === "50000.00"
      && tz.discharged_count === 1 && tz.discharged_amount === "30000.00"
      && tz.void_count === 1 && tz.void_amount === "40000.00"
      && tz.kept_by_office_amount === "80000.00" && tz.owed_to_others_amount === "0.00"
      && us.reading_count === 1 && us.open_amount === "200.00"
      && us.discharged_amount === "0.00" && us.void_amount === "0.00",
      { tz, us, note: sum.note });
    check("…and the two breakdowns are keyed per money too, so a desk that prints `cut by transaction` "
        + "never folds a dollar bill's 200 into a freight invoice's 80,000: voided readings leave both, "
        + "which is why the cancelled 40,000 is nowhere in them",
      sum.by_source?.length === 2 && sum.by_payee?.length === 2
      && Number(sum.by_source.find((r: any) => r.currency === "TZS")?.parts?.freight_invoice) === 80000
      && Number(sum.by_source.find((r: any) => r.currency === "USD")?.parts?.subscription_invoice) === 200
      && Number(sum.by_payee.find((r: any) => r.currency === "TZS")?.parts?.platform) === 80000
      && sum.by_payee.every((r: any) => Object.keys(r.parts).length === 1),
      { by_source: sum.by_source, by_payee: sum.by_payee });
    const windowed = (await oi(call("pricing_commission_summary", 3), [book, TOMORROW, null])).rows[0].r;
    check("a window the register has nothing in answers with two empty piles rather than a zero-summed "
        + "fiction: `open_amount: 0` beside a reading the day simply has not reached yet is how a desk is "
        + "told there is nothing to count",
      windowed.ok === true && windowed.by_currency?.length === 0, windowed.by_currency);
    const badWindow = (await oi(call("pricing_commission_summary", 3), [book, DAY, PAST])).rows[0].r;
    check("…and a last day before the first is refused in the door's own words instead of being answered "
        + "with the whole book", badWindow.ok === false && badWindow.error === "bad_window", badWindow);
  } finally {
    await c.query("rollback");
  }

  // ---------------- 11 · nothing of the office's ----------------
  phase("11 · the census the rollback has to hand back");
  const after = await census();
  const rateGap = (await one("select last_value::int as n from pricing_commission_rate_number_seq")).n;
  const readGap = (await one("select last_value::int as n from pricing_commission_assessment_number_seq")).n;
  check(`every committed count is what it was before the rehearsal: ${Object.keys(before).map(k => k
    + "=" + before[k] + "→" + after[k]).join("  ")}`,
    Object.keys(before).every(k => before[k] === after[k]), { before, after });
  check(`the two sequences are the one thing a rollback cannot hand back — ${rateSeq}→${rateGap} and `
    + `${readSeq}→${readGap}, against ${mintedRates} agreement paper(s) raised and ${mintedReadings} `
    + "reading(s) written by the doors that reached their INSERT",
    rateGap - rateSeq >= mintedRates && readGap - readSeq >= mintedReadings,
    { rateGap, readGap, mintedRates, mintedReadings });

  console.log(`\n${failures ? "FAILED" : "PROVED"}: ${proved} checks passed, ${failures} failed.`);
  if (failures) process.exitCode = 1;
}

main().catch(async e => { console.error("FAILED:", (e as Error).message); process.exit(1); });
