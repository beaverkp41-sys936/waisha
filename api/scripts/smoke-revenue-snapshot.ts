/**
 * The count the office keeps of the money in, over HTTP — smoke for #421b (migration 143 and
 * `control-revenue-count.routes.ts`).
 *
 * `verify-revenue-snapshot-sql.ts` proved the register: 130 checks on the arithmetic, the four cuts, the
 * period maths, the guards, the empty reading, the re-take that remembers. This file is not a shorter
 * version of that probe. It grades the six things that only exist once a desk can reach the register:
 *
 *  - that all 13 doors are really mounted, and that the three duties 143 minted cover them the way the
 *    migration claims: a reader cannot count a day, the seat that counts days cannot promise a figure, and
 *    the seat that promises a figure cannot count the day it will be measured by;
 *  - that the two halves of a refusal stay distinguishable. `EUR`, `quarter`, a `0` figure, an inverted
 *    window and a `2026-02-30` are 143's own route rules with a `field` beside them; `name_the_money`,
 *    `day_is_in_the_future`, `window_reaches_tomorrow` and `target_exists` are the register's sentences with
 *    nothing rewritten; a `143: ` prefix from a table guard must never reach the desk;
 *  - that the status the route chose is the status the desk gets: `not_found` as 404 because the row the
 *    clerk named is not in this book, `target_exists`, `already_withdrawn`, `stop_is_recorded`,
 *    `already_counted_against` and `counted_a_day_that_moved` as 409 because the row the clerk is staring at
 *    is the obstacle, and the day-range refusals as 400 because the clerk can answer them by choosing
 *    another day;
 *  - that the figures on the screen are 133's own book read back through the door. Every movement here is
 *    posted through `POST /control/money/postings`, one of them is reversed through 133's own door, and the
 *    reading that lands on that day names the reversed movement instead of quietly dropping it;
 *  - that the sweep is the half a desk can actually trust: a day the book moved income in and nobody read
 *    is reported as a gap, then counted, then reported as closed — and the day the register re-reads under a
 *    new movement keeps the figure it replaced in `previous`;
 *  - that every accepted write is audited exactly once by the door that made it, that no read writes
 *    anything, that the numbering sequences are spent exactly by the rows that landed plus the presses that
 *    died on a unique index, and that two office books are two worlds on every one of the doors.
 *
 * WHAT THIS RUN DELIBERATELY DOES NOT DO.
 *
 *  1. It never reaches a door's `not_a_seat` or `no_book` refusal, because HTTP cannot hand one:
 *     `get_control_session` (099) returns nothing for a company session, so a clerk's press is a 401 on
 *     `requireControl` and never becomes the door's sentence, and every book a control seat can sign into is
 *     a live platform book. Both refusals are the gate's, and they are proved there.
 *  2. It cannot reach the door rules the route answers first. `EUR` never becomes the door's
 *     `name_the_money` on a read, a `quarter` never becomes its `bad_period`, a window wider than 92 days
 *     never becomes its `window_too_wide`, a limit of 0 never becomes its clamp, an inverted window never
 *     becomes its `bad_window` and a `2026-02-30` never reaches a door at all. Each of those is graded here
 *     as the route's own sentence with its `field`, and the door's half is the gate's. Naming the money is
 *     still reachable on `POST /book/take`, so `name_the_money` is proved on the door's side as well.
 *  3. It does not re-prove the arithmetic. One reading per day per money, the four cuts summing to it, the
 *     contra day printed as a negative figure and the period maths are the gate's phases 3 to 8. This run
 *     reads the figures the door returns and compares them with the book it posted, which is a different
 *     question: whether the desk is handed the register's answer at all.
 *  4. It leaves the table guards alone on purpose. `revenue_snapshot_is_kept`, the two header-immutability
 *     guards and `revenue_target_is_kept` answer a direct UPDATE or DELETE, and the only route that could
 *     issue one is a door that has already refused. The single guard press this run can reach is the
 *     one-live-promise-per-period index, and it is reached by racing two seats for the same period instead
 *     of pretending a desk can write a row.
 *
 * WHAT THIS RUN LEAVES BEHIND, ON PURPOSE.
 *
 * 133 refuses the delete of a movement ("posting % is deleted by nobody") and 143 refuses the delete of any
 * reading of a day that moved money, and both pin the seat that wrote the row. So this run does not fight
 * the guards: its office books, its writer seats, its accounts, its movements, its readings and the two
 * promises that were stood up and stopped stay. Everything a run can delete — the readers, the pure
 * company, the minted duty profile, the zero reading it threw away and the promise it discarded — is swept.
 * Because each run mints its OWN office book, every figure below is an absolute count inside a book that
 * did not exist when the run started, which is a stronger claim than the growth assertion 142's reused book
 * had to settle for.
 *
 * SAFETY: every book is this run's own synthetic tenant and every seat a synthetic platform user; accounts,
 * movements, readings and promises are all minted through the doors or named for the sweep. Audit lines and
 * the sequence numbers they spent stay: `prevent_audit_mutation()` refuses the owner too, and a sequence is
 * not a row. No real company, no real price list and no real ledger is touched.
 *
 * Run: SMOKE_API_BASE=http://localhost:4100/api/v1 npx tsx scripts/smoke-revenue-snapshot.ts
 *      (the dev API; :4000 on this box belongs to another project)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sha256 } from "../src/util/crypto.js";

const API = process.env.SMOKE_API_BASE ?? "http://localhost:4000/api/v1";

const STAMP = Date.now().toString().slice(-8);
const MARK = `rsv${STAMP}`;
/** Every run mints its own books, so the register's own totals inside them are absolutes rather than a
 *  difference between two crashed runs. The sweep still matches by name, because a run that died mid-flight
 *  leaves its books standing and a second run does not know their uuids. */
const OFFICE_NAME = `RSV Count Office ${STAMP}`;
const OTHER_NAME = `RSV Count Other ${STAMP}`;
const COMPANY_NAME = `RSV Count Company ${STAMP}`;
const BOOK_SWEEP = "RSV Count %";
const EMAIL_ALL = `smoke.rsv.${STAMP}.%@waisha.test`;
const emailFor = (who: string) => `smoke.rsv.${STAMP}.${who}@waisha.test`;
/** The one sentence both `bad_reason` and the route's `SENTENCE` refuse, kept as a constant so a check on
 *  "whose words arrived" cannot pass on a paraphrase of it. */
const ROUTE_23505 = "That book already holds a live target for that period, or a reading of that day in "
  + "that money taken at the same moment as this one.";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function note(label: string) { console.log(`note ${label}`); }
function phase(name: string) { console.log(`\n--- ${name} ---`); }

/** Every reply is scanned on the way past: no `143: ` from a table guard may reach a desk, and every
 *  refusal a run collects is listed at the end so an unreachable code can be told from an untested one. */
const leak: string[] = [];
const refusals: string[] = [];
/** The states the register itself reported, counted as they arrive. The audit census at the end is compared
 *  against this rather than against a hand-written number, which is what lets a raced press answer either
 *  way without the run lying about the register. */
const AUD = { taken: 0, retaken: 0, rechecked: 0, discarded: 0, swept: 0, set: 0, stopped: 0, thrown: 0 };
const ghost = { snapshots: 0, targets: 0 };
/** The owner socket, hoisted so the `catch` below can close it. A `let` declared after `main()` and written
 *  inside it is in TDZ the moment `main()` runs, so a probe that died early would print a second error
 *  about `held` instead of the one it was dying of. */
let held: pg.Client | null = null;

async function call(path: string, opts: {
  ck?: string; method?: string; body?: any; headers?: Record<string, string>;
} = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    headers: {
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.ck ? { Cookie: opts.ck } : {}),
      ...(opts.headers ?? {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (text.includes("143:")) leak.push(`${opts.method ?? "GET"} ${path} ${res.status}`);
  if (res.status >= 400) refusals.push(`${res.status} ${json?.error?.code ?? "?"} — ${words({ json })}`);
  return { status: res.status, json, text };
}

const code = (r: { json: any }) => r.json?.error?.code ?? null;
/** The door's whole answer, joined: the code picks the status, the sentence is the half a clerk needs, and
 *  the figures the door puts beside it (`asked`, `days`, `retryIn`, `ref`) are the half that says what to
 *  press next. A check on "the register's own words" must not pass on the route's paraphrase of them. */
const words = (r: { json: any }) => [String(r.json?.error?.message ?? ""),
  ...(Array.isArray(r.json?.error?.details)
    ? r.json.error.details.map((d: any) => typeof d === "object" && d !== null
      ? [String(d.field ?? ""), String(d.message ?? ""),
        ...Object.entries(d).filter(([k, v]) => !["field", "message"].includes(k)
          && ["string", "number", "boolean"].includes(typeof v))
        .map(([k, v]) => `${k}:${v}`)].filter(Boolean).join(" ")
      : String(d)) : [])].join(" | ");

/** A refusal, graded as three facts: the status the route chose, the code the door answered with, and the
 *  sentence that survived the trip. */
function refused(label: string, r: { status: number; json: any }, status: number, ...needles: string[]) {
  const w = words(r);
  const miss = needles.filter((n) => !w.includes(n));
  check(label, r.status === status && miss.length === 0,
    { status: r.status, code: code(r), wanted: needles, missing: miss, words: w.slice(0, 320) });
  return w;
}
const ok = (r: { status: number }) => r.status === 200;
const tally = (list: any[]) => { for (const s of list ?? []) {
  if (s?.state === "taken") AUD.taken++;
  else if (s?.state === "retaken") AUD.retaken++;
  else if (s?.state === "unchanged") AUD.rechecked++;
} };

async function main() {
  const up = await fetch(`${API}/control/auth/permissions`).catch(() => null);
  if (!up) throw new Error(`the api is not answering on ${API} — start it before this run`);
  note(`api answers on ${API}`);

  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  held = owner;
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const one = async (sql: string, params: any[] = []) => (await oi(sql, params)).rows[0];
  const many = async (sql: string, params: any[] = []) => (await oi(sql, params)).rows;
  const row = async (t: string, id: string): Promise<any> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) {
      throw new Error(`no ${t} row to read back: the door never returned an id (${JSON.stringify(id)}). `
        + "An earlier check in this phase FAILed — read the line above it.");
    }
    return (await one(`select * from ${t} where id = $1::uuid`, [id]));
  };
  /** `pg` hands a bare `date` back as a Date at local midnight and this box runs at UTC+3, so the reading's
   *  own printing is asked of the database rather than converted in the probe. */
  const snapRow = (id: string) => one(`select tenant_id, ref, currency, income::text as income,
      credit_total::text as credit_total, debit_total::text as debit_total, postings, entries,
      reversed_postings, revisions, previous, note, taken_by, taken_at,
      to_char(snapshot_day,'YYYY-MM-DD') as day,
      to_char(first_taken_at,'YYYY-MM-DD') as first_day,
      platform_auth.revenue_cut_sum(by_account) = income as accounts_balance,
      platform_auth.revenue_cut_sum(by_source)  = income as sources_balance,
      platform_auth.revenue_cut_sum(by_desk)    = income as desks_balance,
      platform_auth.revenue_cut_sum(by_route)   = income as roads_balance,
      jsonb_array_length(by_account) as account_buckets,
      jsonb_array_length(by_route) as road_buckets
      from revenue_snapshots where id = $1::uuid`, [id]);
  const targetRow = (id: string) => one(`select tenant_id, ref, currency, period_kind, amount::text as amount,
      status, note, raised_by, withdrawn_by, withdrawn_reason,
      to_char(period_start,'YYYY-MM-DD') as period_start
      from revenue_targets where id = $1::uuid`, [id]);

  // The days the book is planted on are the database's own, and they are all inside one whole month: a
  // fixture ladder pinned to `current_date - 5` walks into the month before on the 3rd of a month and every
  // "this month earned X" check then fails on a calendar rather than on the register.
  const D = await one(`select
      to_char(date_trunc('month', current_date) - interval '1 month' + interval '3 days', 'YYYY-MM-DD') as d1,
      to_char(date_trunc('month', current_date) - interval '1 month' + interval '4 days', 'YYYY-MM-DD') as d2,
      to_char(date_trunc('month', current_date) - interval '1 month' + interval '5 days', 'YYYY-MM-DD') as d3,
      to_char(date_trunc('month', current_date) - interval '1 month' + interval '6 days', 'YYYY-MM-DD') as d4,
      to_char(date_trunc('month', current_date) - interval '1 month' + interval '7 days', 'YYYY-MM-DD') as d5,
      to_char(date_trunc('month', current_date) - interval '1 month', 'YYYY-MM-01') as month_start,
      to_char(date_trunc('month', current_date), 'YYYY-MM-DD') as this_month,
      to_char(current_date, 'YYYY-MM-DD') as today,
      to_char(current_date + 1, 'YYYY-MM-DD') as tomorrow,
      to_char(current_date - 1, 'YYYY-MM-DD') as yday,
      to_char(current_date - 130, 'YYYY-MM-DD') as q130,
      to_char(current_date - 800, 'YYYY-MM-DD') as too_far,
      to_char(current_date + 20, 'YYYY-MM-DD') as soon_day,
      to_char(current_date + 400, 'YYYY-MM-DD') as far_month,
      to_char(current_date + 800, 'YYYY-MM-DD') as out_reach,
      to_char(current_date, 'YYYY') || '-02-30' as fake_day`);
  void D.d5;

  // A limiter window is aligned to the epoch, so a press that spent budget in an earlier run of this same
  // suite is still counted in the current hour. The sweep door allows six presses an hour on one seat and
  // this run grades the seventh as a 429, which only means anything on an emptied bucket.
  const preClean = async () => {
    const books = (await oi(`select id from tenants where name like $1`, [BOOK_SWEEP]))
      .rows.map((x: any) => String(x.id));
    const seats = (await oi(`select id from users where email like $1`, [EMAIL_ALL]))
      .rows.map((x: any) => String(x.id));
    const pens = (await oi(`select id from roles where key like 'p143_%'`)).rows.map((x: any) => String(x.id));
    // A reading of an empty day is the one row 143 lets a desk throw away, and a live target whose period
    // holds no reading is the one promise it lets them discard — so an earlier run's litter of those goes
    // first, because it is what pins a seat and a book.
    const empties = (await oi(`select id from revenue_snapshots where tenant_id = any($1::uuid[])
      and postings = 0`, [books.length ? books : [randomUUID()]])).rows.map((x: any) => String(x.id));
    if (empties.length) await oi(`delete from revenue_snapshots where id = any($1::uuid[])`, [empties]);
    const looseTargets = (await oi(`select t.id from revenue_targets t where t.tenant_id = any($1::uuid[])
      and t.status = 'live' and t.withdrawn_at is null and not exists (select 1 from revenue_snapshots s
        where s.tenant_id = t.tenant_id and s.currency = t.currency and s.snapshot_day >= t.period_start
        and s.snapshot_day < platform_auth.revenue_period_end(t.period_kind, t.period_start))`,
      [books.length ? books : [randomUUID()]])).rows.map((x: any) => String(x.id));
    if (looseTargets.length) {
      await oi(`delete from revenue_targets where id = any($1::uuid[])`, [looseTargets]);
    }
    if (seats.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [seats]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [seats]);
    }
    if (pens.length) {
      await oi(`delete from role_permissions where role_id = any($1::uuid[])`, [pens]);
      await oi(`delete from roles where id = any($1::uuid[])`, [pens]);
    }
    await oi(`delete from rate_limits where bucket ~ '^revenue-'`);
    let heldBack = 0;
    for (const s of seats) await oi(`delete from users where id = $1`, [s]).catch(() => { heldBack++; });
    for (const b of books) await oi(`delete from tenants where id = $1`, [b]).catch(() => { heldBack++; });
    note(`earlier runs' litter cleared: ${empties.length} empty readings, ${looseTargets.length} loose `
      + `promises, ${seats.length} seats, ${pens.length} duty profiles, ${books.length} books, `
      + `${heldBack} rows a guard kept`);
  };
  await preClean();

  const START = await one(`select
      (select count(*) from revenue_snapshots) as readings,
      (select count(*) from revenue_targets) as promises,
      (select count(*) from tenants where name like $1) as books,
      (select count(*) from users where email like $2) as seats`, [BOOK_SWEEP, EMAIL_ALL]);
  note(`register found: ${START.readings} readings and ${START.promises} promises filed across the whole `
    + `platform, ${START.books} smoke books and ${START.seats} smoke seats already standing`);
  const SEQ0 = await one(`select
      (select last_value from revenue_snapshot_number_seq) as readings,
      (select last_value from revenue_target_number_seq) as promises`);
  const T0 = Date.now();

  // ---------------- 0. the duties this desk is built on ----------------
  phase("the duties 143 hangs its doors on, as the migration seeded them and as the nav probe lists them");
  const roleRows = await many(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "billing_admin", "finance_officer", "platform_analyst", "auditor", "director"]]);
  const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
  const missing = ["super_admin", "billing_admin", "finance_officer", "platform_analyst", "auditor",
    "director"].filter((k) => !rid(k));
  if (missing.length) throw new Error(`global roles missing: ${missing.join(", ")}`);

  const grants = await one(`select
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'super_admin' and rp.permission_key like 'control.revenue.%') as own,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'billing_admin' and rp.permission_key like 'control.revenue.%') as bill,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'finance_officer' and rp.permission_key like 'control.revenue.%') as pen,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'platform_analyst' and rp.permission_key like 'control.revenue.%') as analyst,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'auditor' and rp.permission_key like 'control.revenue.%') as audit,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'director' and rp.permission_key like 'control.revenue.%') as dir,
      (select count(distinct rp.role_id) from role_permissions rp
        where rp.permission_key = 'control.revenue.view') as holders_view,
      (select count(distinct rp.role_id) from role_permissions rp
        where rp.permission_key = 'control.revenue.count') as holders_count,
      (select count(distinct rp.role_id) from role_permissions rp
        where rp.permission_key = 'control.revenue.target') as holders_target,
      (select count(*) from role_permissions rp
        where rp.permission_key = 'control.revenue.count' and rp.role_id in
        (select role_id from role_permissions where permission_key = 'control.revenue.target')) as both`);
  check("143 mints exactly three duties and seeds them the way 135's reason asks: five roles read the "
    + "count, two may count a day and two may promise a figure, and the two write duties are held by "
    + "different seats — the census in 143's own section 15 refuses to finish if they turn out to be one set",
    Number(grants.holders_view) === 5 && Number(grants.holders_count) === 2
    && Number(grants.holders_target) === 2 && Number(grants.both) === 1
    && Number(grants.own) === 3 && Number(grants.bill) === 2 && Number(grants.pen) === 2
    && Number(grants.analyst) === 1 && Number(grants.audit) === 1 && Number(grants.dir) === 0, grants);

  const keys = ["control.revenue.view", "control.revenue.count", "control.revenue.target",
    "control.money.post", "control.money.view"];
  const probeKeys = await one(`select count(*)::int as n from permissions where key = any($1)`, [keys]);
  check("every duty key this desk and the ledger doors branch on is a real permission row, so a seat that "
    + "holds one is not told it does not — 140's allowlist trap", probeKeys.n === keys.length, probeKeys);

  // ---------------- 1. the books, the seats, the money to count ----------------
  phase("fixtures: two office books, one company, nine seats, six accounts and ten movements");
  const mkTenant = async (type: string, name: string) => (await one(
    `insert into tenants (id, type, name, status, trial_ends_at)
      values ($1,$2,$3,'active', now() + interval '30 days') returning id`,
    [randomUUID(), type, name])).id;
  const mkSeat = async (id: string, tenant: string, name: string, email: string) => (await one(
    `insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled, last_login_at,
        created_at)
      values ($1,$2,'platform',$3,$4,'active',true, now() - interval '2 hours',
        now() - interval '200 days') returning id`, [id, tenant, name, email])).id;

  const TP = await mkTenant("platform", OFFICE_NAME);     // the office that keeps this count
  const TX = await mkTenant("platform", OTHER_NAME);      // a second book, kept out of TP's rows
  const CO1 = await mkTenant("transporter", COMPANY_NAME); // a company book whose clerk is not a seat

  const uPen = randomUUID();     // super_admin: reads, counts and promises
  const uCount = randomUUID();   // finance_officer: counts days, promises nothing
  const uBill = randomUUID();    // billing_admin: promises figures, counts nothing
  const uAn = randomUUID();      // platform_analyst: reads only
  const uAud = randomUUID();     // auditor: reads only
  const uDir = randomUUID();     // director: no revenue duty at all
  const uMan = randomUUID();     // the minted count-without-promise seat
  const uEst = randomUUID();     // a super_admin in the other book
  const uClerk = randomUUID();   // a clerk in a company book
  await mkSeat(uPen, TP, "Counting Pen", emailFor("pen"));
  await mkSeat(uCount, TP, "Number Officer", emailFor("count"));
  await mkSeat(uBill, TP, "Promising Bill", emailFor("bill"));
  await mkSeat(uAn, TP, "Asha Analyst", emailFor("analyst"));
  await mkSeat(uAud, TP, "Daudi Audit", emailFor("auditor"));
  await mkSeat(uDir, TP, "Fatma Director", emailFor("director"));
  await mkSeat(uMan, TP, "Mano Sweep", emailFor("sweeper"));
  await mkSeat(uEst, TX, "Esther Other", emailFor("other"));
  await mkSeat(uClerk, CO1, "Not A Seat", emailFor("clerk"));
  await oi(`update users set user_type = 'staff' where id = $1`, [uClerk]);

  // No global role holds `count` without `target`, so the split 143 argues for cannot be graded with the
  // seeded roles alone. The run mints its own duty profile and deletes it again.
  const ROLE_COUNT_ONLY = randomUUID();
  await oi(`insert into roles (id, tenant_id, key, name, is_system)
      values ($1, null, $2, 'P143 counts but never promises', false)`,
    [ROLE_COUNT_ONLY, `p143_count_${STAMP}`]);
  await oi(`insert into role_permissions (role_id, permission_key)
      select $1, key from permissions where key in ('control.revenue.view','control.revenue.count')`,
    [ROLE_COUNT_ONLY]);

  await oi(`insert into user_roles (user_id, role_id) values
      ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10),($11,$12),($13,$14),($15,$16),($17,$18)`,
    [uPen, rid("super_admin"), uCount, rid("finance_officer"), uBill, rid("billing_admin"),
      uAn, rid("platform_analyst"), uAud, rid("auditor"), uDir, rid("director"),
      uMan, ROLE_COUNT_ONLY, uEst, rid("super_admin"), uClerk, rid("director")]);

  const tok = (who: string) => `${MARK}-${who}`;
  const ck = (who: string) => `waisha_control=${tok(who)}`;
  for (const [uid, tenant, who] of [
    [uPen, TP, "pen"], [uCount, TP, "count"], [uBill, TP, "bill"], [uAn, TP, "analyst"],
    [uAud, TP, "auditor"], [uDir, TP, "director"], [uMan, TP, "sweeper"], [uEst, TX, "other"],
    [uClerk, CO1, "clerk"]
  ] as [string, string, string][]) {
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
        refresh_token_hash, user_agent, ip, expires_at)
      values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-revenue-snapshot',$6,
        now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
  }
  const asPen = { ck: ck("pen") }, asCount = { ck: ck("count") }, asBill = { ck: ck("bill") };
  const asAn = { ck: ck("analyst") }, asAud = { ck: ck("auditor") }, asDir = { ck: ck("director") };
  const asMan = { ck: ck("sweeper") }, asEst = { ck: ck("other") }, asClerk = { ck: ck("clerk") };

  // The chart 133 opens, and the road the movements name. Every movement below is posted through 133's own
  // door, so the register is read over money a desk actually wrote rather than rows this probe invented.
  const acc = async (o: { ck: any, code: string, label: string, kind: string, currency?: string }) => {
    const r = await call("/control/money/accounts", { ...o.ck, body: { code: o.code, label: o.label,
      kind: o.kind, currency: o.currency } });
    if (!ok(r)) throw new Error(`account ${o.code} refused: ${r.status} ${words(r)}`);
    return String(r.json.id);
  };
  let postN = 0;
  const post = async (o: { ck?: any, day: string, figure: string, credit: string, debit: string,
    kind: string, currency?: string, sourceId?: string, memo?: string }) => {
    postN++;
    const r = await call("/control/money/postings", {
      ...(o.ck ?? asPen),
      headers: { "Idempotency-Key": `${MARK}-post-${postN}` },
      body: {
        posted_on: o.day, currency: o.currency ?? "TZS", source_kind: o.kind,
        memo: o.memo ?? `Count smoke movement ${postN} on ${o.day}`,
        source_id: o.sourceId ?? null,
        legs: [{ account: o.credit, direction: "credit", amount: o.figure, detail: "the income side" },
          { account: o.debit, direction: "debit", amount: o.figure, detail: "the side it landed on" }]
      }
    });
    if (!ok(r)) throw new Error(`movement ${postN} refused: ${r.status} ${words(r)}`);
    return String(r.json.posting.id);
  };

  const incFee = await acc({ ck: asPen, code: "R143-FEE", label: "Platform fee income (TZS)",
    kind: "income" });
  const incTransit = await acc({ ck: asPen, code: "R143-TRANSIT", label: "Transit levy income (TZS)",
    kind: "income" });
  const cash = await acc({ ck: asPen, code: "R143-CASH", label: "Till the office pays from (TZS)",
    kind: "asset" });
  const spend = await acc({ ck: asPen, code: "R143-COST", label: "Platform costs (TZS)", kind: "expense" });
  const incUsd = await acc({ ck: asPen, code: "R143-FEE-USD", label: "Platform fee income (USD)",
    kind: "income", currency: "USD" });
  const cashUsd = await acc({ ck: asPen, code: "R143-CASH-USD", label: "Dollar till (USD)",
    kind: "asset", currency: "USD" });
  const txInc = await acc({ ck: asEst, code: "R143-TX-FEE", label: "Other office fee income (TZS)",
    kind: "income" });
  const txCash = await acc({ ck: asEst, code: "R143-TX-CASH", label: "Other office till (TZS)",
    kind: "asset" });

  const ROAD = `Baga Point Road ${STAMP}`;
  const routeId = (await one(`insert into routes (tenant_id, name) values ($1,$2) returning id`,
    [TP, ROAD])).id;
  const trip = (await one(`insert into trips (tenant_id, route_id) values ($1,$2) returning id`,
    [TP, routeId])).id;
  /** A movement whose paper is a bare uuid that names no trip, no request and no consolidation. An invoice
   *  genuinely carries no road at all, so the door files that money under `no road named` instead of
   *  dropping it — and the road the office earned on still has to be named. */
  const noRoad = randomUUID();

  await post({ day: D.d1, figure: "100000", credit: incFee, debit: cash, kind: "fee", sourceId: trip });
  await post({ day: D.d1, figure: "40000", credit: incTransit, debit: cash, kind: "invoice",
    sourceId: noRoad });
  await post({ day: D.d1, figure: "500", credit: incUsd, debit: cashUsd, kind: "fee", currency: "USD",
    sourceId: noRoad });
  await post({ day: D.d2, figure: "60000", credit: incTransit, debit: cash, kind: "invoice",
    sourceId: trip });
  /** A day with a movement and no income in it: costs against the till. The reading of this day is a zero,
   *  and `postings` counts 0 rather than 1 — a day that reads as twelve movements reads as twelve earnings
   *  to whoever is holding the screen. */
  await post({ day: D.d3, figure: "9000", credit: cash, debit: spend, kind: "cost" });
  await post({ day: D.d4, figure: "20000", credit: incFee, debit: cash, kind: "fee", sourceId: trip });
  /** A movement the office later undid. 133's own door writes the mirror on *today*, so this plants one
   *  income leg on d4 and a contra leg on the current month, and the register has to say both out loud
   *  rather than let a clerk call d4 clean on the strength of paper that has changed under it. */
  const undoable = await post({ day: D.d4, figure: "8000", credit: incFee, debit: cash, kind: "manual",
    sourceId: trip });
  const rev = await call(`/control/money/postings/${undoable}/reverse`, { ...asPen,
    body: { reason: "The office took the fee twice, so the second one goes back." } });
  check("133's own door reverses the movement the register is about to count, and answers the mirror it "
    + "wrote on today rather than the day it undid", ok(rev) && !!rev.json?.reversal?.id,
    { status: rev.status, words: words(rev) });
  await post({ ck: asEst, day: D.d1, figure: "777000", credit: txInc, debit: txCash, kind: "fee" });
  const accN = await one(`select count(*)::int as n from money_accounts a
    where a.tenant_id = any($1::uuid[]) and a.code like 'R143-%'`, [[TP, TX, CO1]]);
  check("two books with eight platform seats (one of them a director with no duty), one company clerk, "
    + "eight accounts, a road, a trip and eight movements are planted through the ledger's own doors, "
    + "plus the reversal 133's own door wrote: "
    + `postN = ${postN}, accN = ${accN.n}`, postN === 8 && accN.n === 8 && !!TP && !!TX && !!CO1);

  // ---------------- 2. the reads, before a day has been counted ----------------
  phase("the register before the office has read anything");
  const state0 = await call("/control/revenue/book/state?days=120", asPen);
  check("GET /book/state is mounted and answers the currency pair, the window and today", ok(state0)
    && state0.json.ok === true && state0.json.days === 120 && !!state0.json.today
    && Array.isArray(state0.json.currencies) && state0.json.currencies.length === 2,
    { status: state0.status, json: state0.json });
  const cur0 = (j: any, c: string) => (j.currencies ?? []).find((x: any) => x.currency === c) ?? {};
  check("…and it reports the days the book moved income and nobody read as gaps rather than as days with "
    + "nothing in them: TZS has four (the fee day, the levy day, the fee day two and today's mirror), USD "
    + "has one, and the cost-only day in between is not a gap because the register never reads a day that "
    + "earned nothing", cur0(state0.json, "TZS").uncounted_count === 4
    && cur0(state0.json, "TZS").snapshots === 0 && cur0(state0.json, "TZS").next_day === D.d1
    && cur0(state0.json, "USD").uncounted_count === 1 && cur0(state0.json, "USD").next_day === D.d1,
    { tz: cur0(state0.json, "TZS"), usd: cur0(state0.json, "USD"), legs: D });
  const book0 = await call("/control/revenue/book?currency=TZS", asPen);
  check("GET /book answers an empty register with a zero window rather than a missing figure — a desk that "
    + "read `undefined` would print a month that never happened", ok(book0)
    && book0.json.counted_days === 0 && Number(book0.json.window_income) === 0
    && book0.json.rows.length === 0 && book0.json.currency === "TZS",
    { status: book0.status, json: book0.json });
  const cut0 = await call(`/control/revenue/cut/account?currency=TZS&from=${D.d1}&to=${D.d4}`, asPen);
  check("GET /cut/account answers zero buckets over a window with no readings in it, and no note where no "
    + "note is owed", ok(cut0) && Number(cut0.json.income) === 0 && cut0.json.buckets === 0
    && cut0.json.omitted === 0 && cut0.json.note === null, { status: cut0.status, json: cut0.json });
  const win0 = await call(`/control/revenue/window?kind=month&from=${D.d1}&to=${D.d4}&currency=TZS`, asPen);
  check("GET /window still prints the month the office earned in when nothing has been counted: the period "
    + "is there, its actual is zero, and it is honestly marked incomplete over the three September days "
    + "the book moved income and nobody read rather than printed as an empty month. The cost-only day is "
    + "not in the gap list, and today's contra is outside the month", ok(win0)
    && win0.json.periods === 1 && win0.json.kind === "month"
    && Number(win0.json.actual) === 0
    && win0.json.rows[0].uncounted_count === 3 && win0.json.rows[0].complete === false
    && win0.json.rows[0].uncounted_days.slice().sort().join(",") === [D.d1, D.d2, D.d4].sort().join(",")
    && win0.json.rows[0].target === null && win0.json.rows[0].attainment === null,
    { status: win0.status, row: win0.json.rows?.[0] });
  const targets0 = await call("/control/revenue/targets?currency=TZS", asPen);
  check("GET /targets answers no promises at all, counted and uncounted alike", ok(targets0)
    && targets0.json.count === 0 && targets0.json.rows.length === 0, { json: targets0.json });
  const ghostId = randomUUID();
  const missRead = await call(`/control/revenue/book/${ghostId}`, asPen);
  refused("GET /book/:id on a uuid that is not in this book answers the door's own 404 sentence — not a "
    + "paraphrase, and not a 200 with an empty object", missRead, 404,
    "There is no count of the book with that number in this book.");
  const missTarget = await call(`/control/revenue/targets/${ghostId}`, asPen);
  refused("…and the same for a promise: 404 with the register's words", missTarget, 404,
    "There is no target in this book with that number.");
  const badId = await call("/control/revenue/book/not-a-uuid", asPen);
  refused("A uuid the route cannot read is refused by the route before a door is opened, with the field "
    + "the desk has to correct", badId, 400, "That is not a reading.");

  // ---------------- 3. the duty matrix ----------------
  phase("three duties, nine seats, and the 403 that says which door a seat is standing at");
  const anTake = await call("/control/revenue/book/take", { ...asAn, body: { day: D.d1 } });
  refused("a platform_analyst that holds only the read duty is refused the count door with the guard's own "
    + "403 words", anTake, 403, "Your platform role does not allow this.");
  const anRead = await call("/control/revenue/book?currency=TZS", asAn);
  check("…and the same seat reads the register with the same cookie, so the 403 above is the duty and not a "
    + "broken session", ok(anRead) && anRead.json.counted_days === 0, { status: anRead.status });
  const billTake = await call("/control/revenue/book/take", { ...asBill, body: { day: D.d1 } });
  refused("the seat that may promise a figure may not count the day it will be measured against: 135's "
    + "reason, applied to the count", billTake, 403, "Your platform role does not allow this.");
  const countSet = await call("/control/revenue/targets", { ...asCount,
    body: { kind: "month", day: D.d1, amount: "900000" } });
  refused("…and the seat that may count a day may not set the ambition: the two write duties are held by "
    + "different roles on purpose", countSet, 403, "Your platform role does not allow this.");
  const manSet = await call("/control/revenue/targets", { ...asMan,
    body: { kind: "month", day: D.d1, amount: "900000" } });
  refused("a seat minted with view+count and no target is refused the promise door too, which is the proof "
    + "the 403 above is per-duty rather than per-role-family", manSet, 403,
    "Your platform role does not allow this.");
  const dirRead = await call("/control/revenue/book/state", asDir);
  refused("a director holding none of the three is refused even the read", dirRead, 403,
    "Your platform role does not allow this.");
  const clerkRead = await call("/control/revenue/book", asClerk);
  refused("a company clerk never reaches the door at all: 099's session guard answers first, so the door's "
    + "own `not_a_seat` sentence is unreachable over HTTP and stays the gate's", clerkRead, 401,
    "Control sign-in required");
  const noCookie = await call("/control/revenue/book");
  check("…and no cookie at all is the same 401 rather than a 500 from a route that assumed a seat",
    noCookie.status === 401 && code(noCookie) === "TOKEN_EXPIRED", { status: noCookie.status });
  note("reachable refusals graded so far: the guard's 403, 099's 401, and the door's 404. Not reachable "
    + "from a desk: the doors' `not_a_seat` (a company session never reaches a door) and `no_book` (every "
    + "book a control seat signs into is a live platform book). Both are proved in the SQL gate.");

  // ---------------- 4. counting a day ----------------
  phase("take a day: the two monies, the honest zero, the union, and the one erase");
  const take1 = await call("/control/revenue/book/take", { ...asPen, body: { day: D.d1,
    note: "The first count of the month's opening week." } });
  tally(take1.json?.snapshots);
  check("POST /book/take on a day that moved money in two monies answers both readings in one press "
    + "without being told which monies to read, and names each figure the register computed", ok(take1)
    && take1.json.read === 2 && take1.json.changed === 2 && take1.json.day === D.d1
    && take1.json.snapshots.length === 2
    && take1.json.snapshots.every((s: any) => s.state === "taken")
    && Number(take1.json.snapshots.find((s: any) => s.currency === "TZS").income) === 140000
    && Number(take1.json.snapshots.find((s: any) => s.currency === "USD").income) === 500
    && /is counted/.test(String(take1.json.message)), { status: take1.status, json: take1.json });
  const tzRef = take1.json?.snapshots?.find((s: any) => s.currency === "TZS")?.ref;
  const usdId = take1.json?.snapshots?.find((s: any) => s.currency === "USD")?.snapshot?.id;
  const tzId = take1.json?.snapshots?.find((s: any) => s.currency === "TZS")?.snapshot?.id;
  check("…and each reading carries the register's own reference, in the shape the column CHECKs for, so a "
    + "desk can quote it in a sentence", /^RSV-\d{4}-\d{5,}$/.test(String(tzRef))
    && /^[0-9a-f-]{36}$/i.test(String(tzId)), { tzRef, tzId });
  const tzRow = await snapRow(String(tzId));
  check("the row the door wrote is 133's book read back, not the press's own figures: income 140,000 over "
        + "credits 140,000 and no debits, two movements and two income legs, one revision, no note of the "
        + "money it was not asked for, and the seat that pressed it",
    tzRow.income === "140000.00" && tzRow.credit_total === "140000.00"
    && tzRow.debit_total === "0.00" && tzRow.postings === 2 && tzRow.entries === 2
    && tzRow.reversed_postings === 0 && tzRow.revisions === 1 && tzRow.previous === null
    && String(tzRow.taken_by) === uPen && tzRow.note === "The first count of the month's opening week."
    && tzRow.currency === "TZS" && tzRow.day === D.d1 && String(tzRow.tenant_id) === TP, tzRow);
  check("…and all four cuts balance to the figure on the row, which is the table's own CHECK restated as a "
    + "read of the row rather than as a rule", tzRow.accounts_balance && tzRow.sources_balance
    && tzRow.desks_balance && tzRow.roads_balance
    && tzRow.account_buckets === 2 && tzRow.road_buckets === 2, tzRow);
  const takeDetail = await call(`/control/revenue/book/${tzId}`, asAud);
  check("GET /book/:id hands an auditor the same reading with its cuts and its seat printed by name, not as "
    + "a uuid to be remembered", ok(takeDetail) && takeDetail.json.ref === tzRef
    && takeDetail.json.taken_by_name === "Counting Pen" && takeDetail.json.retaken === false
    && takeDetail.json.by_route.length === 2 && Number(takeDetail.json.income) === 140000
    && String(takeDetail.json.day) === D.d1
    && String(takeDetail.json.month_start) === D.month_start && !!String(takeDetail.json.week_start)
    && takeDetail.json.targets.length === 0, { status: takeDetail.status, json: takeDetail.json });
  const takeRoute = (takeDetail.json.by_route ?? []).map((b: any) => `${b.key}:${Number(b.total)}`).sort();
  check("…and the road cut names the road the trip was on and files the invoice that carries no road under "
    + "`no road named` instead of dropping its money", takeRoute.length === 2
    && takeRoute.includes(`${ROAD}:100000`) && takeRoute.includes("no road named:40000"), takeRoute);

  const take1Again = await call("/control/revenue/book/take", { ...asPen, body: { day: D.d1 } });
  tally(take1Again.json?.snapshots);
  const rowAfterRecheck = await row("revenue_snapshots", String(tzId));
  check("counting the same day twice while nothing has moved is reported as `unchanged` rather than "
    + "silently rewritten: the reading keeps its minute and its seat, `revisions` stays 1, and the press "
    + "still writes an audit line saying the office looked",
    ok(take1Again) && take1Again.json.read === 2 && take1Again.json.changed === 0
    && take1Again.json.snapshots.every((s: any) => s.state === "unchanged")
    && /already said what the book says/.test(String(take1Again.json.message))
    && rowAfterRecheck.revisions === 1 && String(rowAfterRecheck.id) === String(tzId)
    && String(rowAfterRecheck.taken_at) === String(tzRow.taken_at),
    { json: take1Again.json, row: { r: rowAfterRecheck.revisions, t: rowAfterRecheck.taken_at } });

  const zero = await call("/control/revenue/book/take", { ...asCount, body: { day: D.d3,
    currency: "TZS", note: "The office counted the cost day and found no income in it." } });
  tally(zero.json?.snapshots);
  const zeroId = zero.json?.snapshots?.[0]?.snapshot?.id;
  const zeroRow = zeroId ? await snapRow(String(zeroId)) : {};
  check("naming the money on a day the book moved costs but no income writes an honest zero — income 0.00 "
    + "over zero movements, and every cut empty, which is the CHECK that stops a row saying zero while "
    + "carrying figures", ok(zero) && zero.json.changed === 1 && zero.json.read === 1
    && zero.json.snapshots[0].state === "taken" && Number(zero.json.snapshots[0].income) === 0
    && zeroRow.income === "0.00" && zeroRow.postings === 0 && zeroRow.entries === 0
    && zeroRow.account_buckets === 0 && zeroRow.road_buckets === 0 && zeroRow.accounts_balance
    && String(zeroRow.taken_by) === uCount, { status: zero.status, json: zero.json, row: zeroRow });
  const zeroUnion = await call("/control/revenue/book/take", { ...asCount, body: { day: D.d3 } });
  tally(zeroUnion.json?.snapshots);
  check("…and a press that names no money still finds that zero, because the door builds its money list "
    + "from the day's legs *union* its existing readings: a sweep pointed at a zero day re-checks it rather "
    + "than refusing to know which money to read", ok(zeroUnion) && zeroUnion.json.read === 1
    && zeroUnion.json.changed === 0 && zeroUnion.json.snapshots[0].state === "unchanged"
    && zeroUnion.json.snapshots[0].currency === "TZS", { json: zeroUnion.json });
  const noLegs = await call("/control/revenue/book/take", { ...asPen, body: { day: D.yday } });
  refused("a fresh day with nothing in it is still refused until the money is named — a zero has to be a "
    + "zero in a money, or the row means nothing", noLegs, 400,
    "Name TZS or USD if the office wants a zero recorded", `day:${D.yday}`);
  const future = await call("/control/revenue/book/take", { ...asPen, body: { day: D.tomorrow } });
  refused("and a day that has not happened is refused as an estimate rather than counted as a reading",
    future, 400, "has not happened", `asked:${D.tomorrow}`);
  const tooOld = await call("/control/revenue/book/take", { ...asPen, body: { day: D.too_far } });
  refused("…and two years back is out of a desk's reach even though the book may be older", tooOld, 400,
    "more than two years back");
  const shortNote = await call("/control/revenue/book/take", { ...asPen, body: { day: D.d1,
    note: "recount" } });
  refused("a note that explains nothing is refused by the route with the field beside it, so the door's own "
    + "`bad_note` half is unreachable from a desk and stays the gate's", shortNote, 400,
    "note", "at least 8 character");
  const fakeMoney = await call("/control/revenue/book/take", { ...asPen,
    body: { day: D.d1, currency: "EUR" } });
  check("a third money is refused before a door opens, so the register never has to explain that it counts "
    + "two — and the answer is the route's enum, not `name_the_money`", fakeMoney.status === 400
    && code(fakeMoney) === "VALIDATION_FAILED" && !words(fakeMoney).includes("The book holds two monies"),
    { status: fakeMoney.status, words: words(fakeMoney) });

  const dropShort = await call(`/control/revenue/book/${zeroId}/discard`, { ...asCount,
    body: { reason: "short" } });
  refused("throwing a count away needs a sentence a later seat can read, and the route names the field",
    dropShort, 400, "reason", "at least 8 character");
  const dropReal = await call(`/control/revenue/book/${zeroId}/discard`, { ...asCount,
    body: { reason: "The office took this zero by mistake and the day has nothing to read." } });
  AUD.discarded++;
  const dropRow = await one(`select count(*)::int as n from revenue_snapshots where id = $1`, [zeroId]);
  check("POST /book/:id/discard is the one erase in the register, and it takes away only a day that held "
    + "nothing: the row is gone and the press is audited with the reading in front of it", ok(dropReal)
    && dropReal.json.discarded === zero.json.snapshots[0].ref && dropRow.n === 0,
    { status: dropReal.status, json: dropReal.json, dropRow });
  const afterDrop = await call(`/control/revenue/book/${zeroId}`, asPen);
  refused("…and reading it back afterwards is the same 404 as any other absent row, not a zero", afterDrop,
    404, "There is no count of the book with that number in this book.");
  const dropPaid = await call(`/control/revenue/book/${tzId}/discard`, { ...asPen,
    body: { reason: "Trying to throw away a day that actually earned money." } });
  refused("a day that moved money cannot be thrown away at all: the door answers in the same words the "
    + "trigger would, names the movements under the reading, and points at the press that is legal — "
    + "re-taking the count", dropPaid, 409, "movement(s) on", "re-taking the count",
    "the reading is what the office said about that day");
  const stillThere = await row("revenue_snapshots", String(tzId));
  check("…and the refused erase left the reading standing, which is the only way a refusal is worth "
    + "grading", String(stillThere.id) === String(tzId) && stillThere.income === "140000.00", stillThere);

  // ---------------- 5. the sweep ----------------
  phase("the sweep: count a window, re-check it under a new movement, and report the days with nothing to read");
  const sweepA = await call("/control/revenue/book/sweep", { ...asPen,
    body: { from: D.d1, to: D.d4 } });
  AUD.swept++; tally(sweepA.json?.readings);
  check("POST /book/sweep over a window the office half-read counts the two days the book moved income in "
    + "and re-checked the day it had already read, in one press — and says the cost-only day was passed "
    + "over rather than written as a zero", ok(sweepA) && sweepA.json.days_read === 3
    && sweepA.json.new === 2 && sweepA.json.retaken === 0 && sweepA.json.unchanged === 2
    && sweepA.json.passed_over === 1 && !sweepA.json.refused
    && sweepA.json.readings.length === 4 && sweepA.json.passed_over_days_capped === false
    && String(sweepA.json.passed_over_days[0]).startsWith(D.d3), { status: sweepA.status, json: sweepA.json });
  const d4Row = await one(`select id, income::text as income, postings, entries, reversed_postings,
      revisions, ref from revenue_snapshots
      where tenant_id = $1 and snapshot_day = $2 and currency = 'TZS'`, [TP, D.d4]);
  check("…and the day the office had undone a movement on keeps it in the count it was earned in: 28,000 "
    + "earned across two movements, one of them reversed, printed as a fact about the reading rather than "
    + "quietly netted out of the window", Number(d4Row.income) === 28000 && d4Row.postings === 2
    && d4Row.entries === 2 && d4Row.reversed_postings === 1, d4Row);

  await post({ day: D.d1, figure: "30000", credit: incFee, debit: cash, kind: "fee", sourceId: trip,
    memo: "A late fee the office found on the opening day after it had counted it." });
  const sweepB = await call("/control/revenue/book/sweep", { ...asPen,
    body: { from: D.d1, to: D.d4 } });
  AUD.swept++; tally(sweepB.json?.readings);
  check("counting the same window again after a movement arrives on a day already read re-takes that day "
    + "and reports nothing else as changed: the register does not pretend a month it re-read was never read",
    ok(sweepB) && sweepB.json.days_read === 3 && sweepB.json.new === 0
    && sweepB.json.retaken === 1 && sweepB.json.unchanged === 3
    && sweepB.json.readings.find((r: any) => r.state === "retaken").day === D.d1
    && Number(sweepB.json.readings.find((r: any) => r.state === "retaken").income) === 170000,
    { status: sweepB.status, json: sweepB.json });
  const retaken = await snapRow(String(tzId));
  check("…and the re-take is an amendment, not a rewrite: the row keeps its first moment, `revisions` says "
    + "two, and `previous` carries the 140,000 the office first reported, so a month that moved can say "
    + "what it used to be", retaken.income === "170000.00" && retaken.postings === 3
    && retaken.entries === 3 && retaken.revisions === 2 && Number(retaken.previous?.income) === 140000
    && retaken.previous?.postings === 2 && String(retaken.previous?.taken_by_name) === "Counting Pen"
    && retaken.day === D.d1, { income: retaken.income,
    previous: retaken.previous, revisions: retaken.revisions });
  const retakenDetail = await call(`/control/revenue/book/${tzId}`, asAn);
  check("…and the desk's own read of that day says it was re-taken, with the replaced figures inside the "
    + "same answer", ok(retakenDetail) && retakenDetail.json.retaken === true
    && retakenDetail.json.revisions === 2
    && Number(retakenDetail.json.previous.income) === 140000,
    { json: retakenDetail.json && { r: retakenDetail.json.retaken, p: retakenDetail.json.previous } });

  await post({ day: D.d3, figure: "15000", credit: incTransit, debit: cash, kind: "payment",
    sourceId: noRoad, memo: "A transit levy booked against the day the office had counted as a zero." });
  const sweepC = await call("/control/revenue/book/sweep", { ...asPen,
    body: { from: D.d1, to: D.d4 } });
  AUD.swept++; tally(sweepC.json?.readings);
  check("the day that had nothing to read and then earned something is picked up as a new count on the next "
    + "sweep, with nothing else moving and no day passed over any more", ok(sweepC)
    && sweepC.json.days_read === 4 && sweepC.json.new === 1 && sweepC.json.retaken === 0
    && sweepC.json.unchanged === 4 && sweepC.json.passed_over === 0
    && sweepC.json.passed_over_days.length === 0
    && sweepC.json.readings.find((r: any) => r.state === "taken").day === D.d3,
    { status: sweepC.status, json: sweepC.json });
  const state3 = await call("/control/revenue/book/state?days=120", asPen);
  const tz3 = cur0(state3.json, "TZS");
  check("the September gap the register was built to report is closed — four readings, the day the office "
    + "re-counted carrying two of the five revisions the state adds up, and the window's figure the sum the "
    + "readings say it is — while the one day still asking to be read is today, whose income leg is 133's "
    + "own mirror of the movement the office undid", ok(state3) && tz3.uncounted_count === 1
    && tz3.uncounted_days[0] === D.today && tz3.next_day === D.today && tz3.snapshots === 4
    && tz3.first_day === D.d1 && tz3.last_day === D.d4
    && Number(tz3.income_in_window) === 273000 && Number(tz3.revisions) === 5
    && tz3.today_counted === false && tz3.yesterday_counted === false, { tz: tz3 });
  const usd3 = cur0(state3.json, "USD");
  check("…and the dollar keeps its own state, counted on its own day, because the register never adds the "
    + "two together", usd3.snapshots === 1 && usd3.uncounted_count === 0
    && Number(usd3.income_in_window) === 500, usd3);

  const sweepTomorrow = await call("/control/revenue/book/sweep", { ...asPen,
    body: { from: D.d1, to: D.tomorrow } });
  refused("a sweep that reaches tomorrow is refused: an open day has no count, and a window that ends "
    + "there would be reported as one", sweepTomorrow, 400,
    "A sweep stops at today", `asked:${D.tomorrow}`);
  const sweepOld = await call("/control/revenue/book/sweep", { ...asPen,
    body: { from: D.too_far, to: D.too_far } });
  refused("…and a window further back than two years is refused rather than run against the whole book",
    sweepOld, 400, "further back than two years");
  const sweepWide = await call("/control/revenue/book/sweep", { ...asPen,
    body: { from: D.q130, to: D.today } });
  refused("a window wider than a quarter is stopped by the route before the door is opened, because the "
    + "connection is the thing being protected — which makes the door's own `window_too_wide` unreachable "
    + "over HTTP and the gate's to prove", sweepWide, 400,
    "A sweep reads at most 92 days at a time on this connection");
  const sweepInverted = await call("/control/revenue/book/sweep", { ...asMan,
    body: { from: D.d4, to: D.d1 } });
  refused("…and an inverted window is refused with the field the desk typed, not the door's `bad_window`",
    sweepInverted, 400, "to", "The last day cannot come before the first day.");
  const sweepFakeDay = await call("/control/revenue/book/sweep", { ...asMan,
    body: { from: D.fake_day, to: D.fake_day } });
  refused("a shape-only date that no calendar carries is refused here rather than reaching Postgres as an "
    + "unreadable 22007", sweepFakeDay, 400, `There is no day ${D.fake_day} on a calendar.`,
    "The day has to exist, not just look like one.");
  const sweepRate = await call("/control/revenue/book/sweep", { ...asPen,
    body: { from: D.yday, to: D.yday } });
  const retryIn = (sweepRate.json?.error?.details ?? [{}])[0]?.retryIn;
  check("the seventh sweep press in an hour on one seat is refused by the limiter, not by the register: "
    + "6 an hour on the door that walks a whole quarter of the book on one connection, and the answer says "
    + "when the office can press again", sweepRate.status === 429 && code(sweepRate) === "RATE_LIMITED"
    && Number(retryIn) > 0 && /try again in about/.test(String(sweepRate.json?.error?.message ?? "")),
    { status: sweepRate.status, code: code(sweepRate), retryIn, words: words(sweepRate) });
  const sweepByMan = await call("/control/revenue/book/sweep", { ...asMan,
    body: { from: D.yday, to: D.yday } });
  check("…and the bucket is per seat: another countable seat can order the same sweep the moment the first "
    + "one is throttled, so one busy desk cannot shut the office out of its own register", ok(sweepByMan)
    && sweepByMan.json.days_read === 0 && sweepByMan.json.passed_over === 1,
    { status: sweepByMan.status, json: sweepByMan.json });
  AUD.swept++; tally(sweepByMan.json?.readings);
  void sweepRate;
  note("the empty sweep above reads the day before yesterday, which holds no income leg and no reading, so "
    + "it passes over exactly one day and writes a reading of nothing.");

  // ---------------- 6. the promises ----------------
  phase("the figure the office means to earn: set it, derive its period, stop it, throw away a slip");
  const setMonth = await call("/control/revenue/targets", { ...asBill, body: { kind: "month",
    day: D.d1, amount: "800000", currency: "TZS", note: "What the office meant to earn that month." } });
  AUD.set++;
  const monthTarget = setMonth.json?.target?.id;
  check("POST /targets answers the period it wrote rather than the day that was typed: a month promised on "
    + "the fourth of a month is a promise for the month that starts on the first, and the register says so "
    + "in the same breath", ok(setMonth) && /^RTG-\d{4}-\d{5,}$/.test(String(setMonth.json.wrote))
    && setMonth.json.derived === true && setMonth.json.period_start === D.month_start
    && setMonth.json.kind === undefined && /that month starts on/.test(String(setMonth.json.message))
    && setMonth.json.target.status === "live" && setMonth.json.target.raised_by_name === "Promising Bill",
    { status: setMonth.status, json: setMonth.json });
  const monthRow = await targetRow(String(monthTarget));
  check("…and the row is filed under the derived period with the figure in whole units and two decimals, "
    + "raised by the seat that pressed and not by the seat that reads it",
    monthRow.period_start === D.month_start && monthRow.period_kind === "month"
    && monthRow.amount === "800000.00" && monthRow.status === "live"
    && String(monthRow.raised_by) === uBill && String(monthRow.tenant_id) === TP, monthRow);
  const dupMonth = await call("/control/revenue/targets", { ...asPen, body: { kind: "month",
    day: D.d4, amount: "850000", currency: "TZS" } });
  refused("a second promise for the same month is refused with the figure it would have replaced and the "
    + "act that actually changes one: withdraw it, then set the new figure as its own target", dupMonth,
    409, "A promise is changed by withdrawing it", "already promises 800000.00 TZS");
  const setThisMonth = await call("/control/revenue/targets", { ...asPen, body: { kind: "month",
    day: D.today, amount: "1200000", currency: "TZS",
    note: "The month the office is still inside." } });
  AUD.set++;
  const thisMonthTarget = setThisMonth.json?.target?.id;
  const winOpen = await call(`/control/revenue/window?kind=month&from=${D.month_start}&currency=TZS`, asAn);
  const openRow = (winOpen.json.rows ?? []).find((r: any) => r.period_start === D.today.slice(0, 8) + "01")
    ?? (winOpen.json.rows ?? []).find((r: any) => r.target);
  check("a month the office has promised and not yet counted is still printed, with its ambition beside a "
    + "zero actual and an honest `complete: false` — the fold does not hide a period for want of readings",
    ok(winOpen) && openRow && Number(openRow.actual) === 0 && Number(openRow.target?.amount) === 1200000
    && openRow.complete === false && openRow.days_counted === 0, { json: winOpen.json.rows });
  const countedRow = (winOpen.json.rows ?? []).find((r: any) => r.period_start === D.month_start);
  check("…and the month that has been counted carries its ambition, its gap and its attainment as the "
    + "register's own arithmetic: 273,000 earned against 800,000 promised is 34.1% and a gap of 527,000, "
    + "with every leg day accounted for", countedRow && Number(countedRow.actual) === 273000
    && Number(countedRow.gap) === 527000 && Number(countedRow.attainment) === 34.1
    && countedRow.days_counted === 4 && countedRow.snapshots === 4
    && countedRow.uncounted_count === 0 && countedRow.complete === true
    && countedRow.reversed_postings === 1 && countedRow.target?.ref === setMonth.json.wrote
    && countedRow.target?.raised_by_name === "Promising Bill", { row: countedRow });
  const detailMonth = await call(`/control/revenue/targets/${monthTarget}`, asAn);
  check("GET /targets/:id answers the promise with what the register has said against it, the days left in "
    + "the period and whether the period is over — the four figures a renewal conversation quotes",
    ok(detailMonth) && detailMonth.json.counted_days === 4 && Number(detailMonth.json.actual) === 273000
    && Number(detailMonth.json.gap) === 527000 && Number(detailMonth.json.attainment) === 34.1
    && detailMonth.json.in_the_past === true && detailMonth.json.days_left === 0
    && detailMonth.json.label && detailMonth.json.period_end
    && detailMonth.json.period_end === D.this_month,
    { json: detailMonth.json });
  const throwCounted = await call(`/control/revenue/targets/${monthTarget}/discard`, { ...asBill,
    body: { reason: "Trying to erase a promise the office was already measured against." } });
  refused("a promise some day was counted against cannot be thrown away at all — the register says how many "
    + "days it was stood up for and which act is left", throwCounted, 409,
    "have been counted while", "Withdraw it instead");
  const stillCounted = await row("revenue_targets", String(monthTarget));
  check("…and it stays live, un-marked, because a refusal that half-wrote the row would be worse than the "
    + "erase", stillCounted.status === "live" && stillCounted.withdrawn_at === null
    && stillCounted.withdrawn_reason === null, stillCounted);

  const stop = await call(`/control/revenue/targets/${thisMonthTarget}/withdraw`, { ...asPen,
    body: { reason: "The office re-planned the month and no longer means to earn 1,200,000." } });
  AUD.stopped++;
  const stoppedRow = await row("revenue_targets", String(thisMonthTarget));
  check("stopping a promise keeps its row, its figure and the sentence that stopped it: a month that fell "
    + "short still says what it was measured against", ok(stop) && stop.json.stopped
    && /stopped/.test(String(stop.json.message)) && stoppedRow.status === "withdrawn"
    && String(stoppedRow.withdrawn_by) === uPen && !!stoppedRow.withdrawn_reason
    && stoppedRow.amount === "1200000.00" && stoppedRow.withdrawn_at !== null,
    { status: stop.status, json: stop.json, row: stoppedRow });
  const stopDetail = await call(`/control/revenue/targets/${thisMonthTarget}`, asAn);
  check("…and the read names the seat that stopped it and the reason, so the register does not need an "
    + "oracle to say who changed the plan", ok(stopDetail) && stopDetail.json.status === "withdrawn"
    && stopDetail.json.withdrawn_by_name === "Counting Pen" && !!stopDetail.json.withdrawn_reason
    && !!stopDetail.json.withdrawn_at, { json: stopDetail.json });
  const stopAgain = await call(`/control/revenue/targets/${thisMonthTarget}/withdraw`, { ...asPen,
    body: { reason: "Asking the same seat to stop the same promise a second time." } });
  refused("…and stopping it twice is a conflict the desk can read, not a second stamp on a stopped row",
    stopAgain, 409, "already stopped");
  const throwStopped = await call(`/control/revenue/targets/${thisMonthTarget}/discard`, { ...asBill,
    body: { reason: "Trying to erase a promise that was stopped rather than never stood up." } });
  refused("a stopped promise is the record that somebody decided it, so it cannot be thrown away either — "
    + "the two halves of the erase rule are two refusals, not one", throwStopped, 409, "was stopped on");

  const far = await call("/control/revenue/targets", { ...asPen, body: { kind: "month",
    day: D.far_month, amount: "100", currency: "USD",
    note: "A promise the office will throw away before it is ever counted against." } });
  AUD.set++;
  const farId = far.json?.target?.id;
  check("a promise in the other money, for a month fourteen months away, is written as its own row — the "
    + "register keeps two monies and never adds them, and a future period with no readings is still a "
    + "promise", ok(far) && far.json.wrote && far.json.period_start === D.far_month.slice(0, 7) + "-01"
    && far.json.target.currency === "USD" && far.json.target.counted_days === 0
    && Number(far.json.target.actual) === 0, { status: far.status, json: far.json });
  const throwFar = await call(`/control/revenue/targets/${farId}/discard`, { ...asPen,
    body: { reason: "A slip: the office never meant to promise that month a figure." } });
  AUD.thrown++;
  const farGone = await one(`select count(*)::int as n from revenue_targets where id = $1`, [farId]);
  const afterThrow = await call(`/control/revenue/targets/${farId}`, asPen);
  check("the erase of a promise nobody was ever measured against is the register's second and last "
    + "deletion: the row goes, and the desk is told that nothing it has reported changes", ok(throwFar)
    && throwFar.json.discarded === far.json.wrote && farGone.n === 0 && afterThrow.status === 404,
    { status: throwFar.status, json: throwFar.json, farGone, after: afterThrow.status });
  const ghostStop = await call(`/control/revenue/targets/${ghostId}/withdraw`, { ...asPen,
    body: { reason: "Stopping a promise that is not in this book at all." } });
  refused("a promise that does not exist in this book is a 404 on the write door too, not a silent success",
    ghostStop, 404, "There is no target in this book with that number.");

  const bigFigure = await call("/control/revenue/targets", { ...asPen, body: { kind: "day",
    day: D.today, amount: "99999999999", currency: "TZS" } });
  refused("a figure that does not fit the column is refused by the door in the words it was written with, "
    + "and carries the number the desk asked for beside it, because the route's money shape lets twelve "
    + "digits through on purpose", bigFigure, 400, "larger than the register carries",
    "asked:99999999999");
  const outReach = await call("/control/revenue/targets", { ...asPen, body: { kind: "month",
    day: D.out_reach, amount: "1000", currency: "TZS" } });
  refused("and a period two years out is beyond what a desk may promise against, in the door's own words "
    + "with the period it derived beside them", outReach, 400,
    "is more than two years from today", `start:${D.out_reach.slice(0, 7)}-01`);
  const zeroAmount = await call("/control/revenue/targets", { ...asPen, body: { kind: "month",
    day: D.d1, amount: "0", currency: "TZS" } });
  refused("a target of nothing is refused as not an ambition, with the field the desk has to fill",
    zeroAmount, 400, "A target of nothing is not an ambition", "amount");
  const badKind = await call("/control/revenue/targets", { ...asPen, body: { kind: "quarter",
    day: D.d1, amount: "5000", currency: "TZS" } });
  refused("a quarter is not a period the register folds promises at, and the route says which three are",
    badKind, 400, "kind", "month");
  const oddFigure = await call("/control/revenue/targets", { ...asPen, body: { kind: "month",
    day: D.d1, amount: "1.234", currency: "TZS" } });
  refused("three decimals on a money column is refused before a door opens, so the register never carries a "
    + "figure it cannot print", oddFigure, 400, "amount", "two decimals");
  const shortReason = await call(`/control/revenue/targets/${monthTarget}/discard`, { ...asBill,
    body: { reason: "oops" } });
  refused("and every erase and every stop on this desk needs the sentence first, named by the route",
    shortReason, 400, "reason", "at least 8 character");
  note("unreachable over HTTP and left to the gate: the door's `bad_period` and `name_the_money` on a "
    + "read, its `bad_window`/`window_too_wide` on a sweep, its `bad_note` and its `no_day`, and the two "
    + "`no_book` halves — every one of them sits behind a route rule that answers first.");

  // ---------------- 7. two seats, one period ----------------
  phase("the one-live-promise-per-period index, met by racing two seats instead of writing a row");
  const raced = await Promise.all([
    call("/control/revenue/targets", { ...asPen, headers: { "Idempotency-Key": `${MARK}-race-a` },
      body: { kind: "day", day: D.soon_day, amount: "400000", currency: "TZS",
        note: "A promise two seats pressed at the same moment." } }),
    call("/control/revenue/targets", { ...asPen, headers: { "Idempotency-Key": `${MARK}-race-b` },
      body: { kind: "day", day: D.soon_day, amount: "410000", currency: "TZS",
        note: "The same promise, pressed by the same seat twice at once." } })
  ]);
  const won = raced.filter(ok), lost = raced.filter((r) => !ok(r));
  for (const r of won) AUD.set++;
  for (const r of lost) if (words(r).includes(ROUTE_23505)) ghost.targets++;
  const racedRows = await one(`select count(*)::int as n, coalesce(sum((amount)::numeric),0)::text as total
      from revenue_targets where tenant_id = $1 and currency = 'TZS' and period_kind = 'day'
      and period_start = $2`, [TP, D.soon_day]);
  check("two presses for one period leave exactly one live promise, and the second press is answered with a "
    + "conflict — either the door's own `target_exists` sentence or the route's words for the unique index "
    + "the register leans on — never a second figure the office did not agree", racedRows.n === 1
    && won.length === 1 && lost.length === 1 && racedRows.total !== "0",
    { rows: racedRows, answers: raced.map((r) => ({ status: r.status, code: code(r) })) });
  note(`the race answered ${won[0]?.status} and ${lost[0]?.status} (${code(lost[0])}); a press that died on `
    + "the unique index spent a reference number, and the sequence census below counts it.");

  await post({ day: D.today, figure: "12000", credit: incFee, debit: cash, kind: "fee", sourceId: trip,
    memo: "Money the office earned today, before two seats tried to count it at once." });
  const racedTake = await Promise.all([
    call("/control/revenue/book/take", { ...asPen, body: { day: D.today } }),
    call("/control/revenue/book/take", { ...asCount, body: { day: D.today } })
  ]);
  for (const r of racedTake) if (ok(r)) tally(r.json?.snapshots);
  for (const r of racedTake) if (!ok(r) && words(r).includes(ROUTE_23505)) ghost.snapshots++;
  const todayRows = await many(`select id, ref, income::text as income, postings, reversed_postings,
      taken_by from revenue_snapshots where tenant_id = $1 and snapshot_day = $2 and currency = 'TZS'`,
    [TP, D.today]);
  check("two seats that count the same fresh day in the same second leave one reading of it — the register "
    + "keeps one reading per day per money, and the loser is refused rather than doubling the office's "
    + "month", racedTake.filter(ok).length >= 1 && todayRows.length === 1
    && racedTake.every((r) => r.status === 200 || r.status === 409),
    { rows: todayRows, answers: racedTake.map((r) => ({ status: r.status, code: code(r) })) });
  check("…and the single reading of today carries the mirror 133 wrote when the office undid a movement, "
    + "so the month is 12,000 earned less the 8,000 taken back and says so — while the count of movements "
    + "that were undone stays on the day they were earned, which is the d4 reading graded in the sweep phase",
    todayRows.length === 1 && Number(todayRows[0].income) === 4000
    && todayRows[0].postings === 2 && todayRows[0].reversed_postings === 0, { today: todayRows[0] });
  const stateEnd = await call("/control/revenue/book/state?days=120", asCount);
  check("…and after that the office's own state read has no gap in either money: every day the book moved "
    + "income in has been counted, including the day the reversal landed on", ok(stateEnd)
    && cur0(stateEnd.json, "TZS").uncounted_count === 0
    && cur0(stateEnd.json, "USD").uncounted_count === 0
    && cur0(stateEnd.json, "TZS").snapshots === 5
    && Number(cur0(stateEnd.json, "TZS").revisions) === 6
    && cur0(stateEnd.json, "TZS").today_counted === true
    && Number(cur0(stateEnd.json, "TZS").income_in_window) === 277000,
    { tz: cur0(stateEnd.json, "TZS") });

  // ---------------- 8. the register, the fold and the four cuts ----------------
  phase("what the desk is handed: the register page, the folded window and the four cuts of one figure");
  const list = await call(`/control/revenue/book?currency=TZS&limit=3&offset=0`, asAn);
  check("GET /book pages the register newest day first and carries the whole filtered window's count and "
    + "figure beside the three rows it printed, so a clerk cannot add the column by hand and get a sum the "
    + "register never said", ok(list) && list.json.counted_days === 5 && list.json.rows.length === 3
    && Number(list.json.window_income) === 277000 && list.json.limit === 3 && list.json.offset === 0
    && list.json.rows.every((r: any, i: number, all: any[]) => i === 0
      || String(r.day) <= String(all[i - 1].day))
    && list.json.rows[0].ref && list.json.rows[0].taken_by_name,
    { status: list.status, json: list.json });
  const page2 = await call(`/control/revenue/book?currency=TZS&limit=3&offset=3`, asAn);
  const overlap = (list.json.rows ?? []).filter((a: any) => (page2.json.rows ?? [])
    .some((b: any) => b.id === a.id));
  check("…and the next page is the next rows rather than the same ones: counted_days and the window figure "
    + "stay the whole window's on both pages, because they describe the filter and not the page",
    ok(page2) && page2.json.counted_days === 5 && Number(page2.json.window_income) === 277000
    && page2.json.rows.length === 2 && overlap.length === 0, { page2: page2.json.rows });
  const usdList = await call("/control/revenue/book?currency=USD", asAn);
  check("the dollar register is one row and five hundred units, and no figure from the shilling book "
    + "appears anywhere in its answer — 138's defect, restated as a read", ok(usdList)
    && usdList.json.counted_days === 1 && Number(usdList.json.window_income) === 500
    && !JSON.stringify(usdList.json).includes("273000")
    && !JSON.stringify(usdList.json).includes("170000"), { json: usdList.json });
  const badLimit = await call("/control/revenue/book?limit=0", asAn);
  refused("a page size the register cannot honour is refused with the field, rather than silently clamped "
    + "into an answer the desk reads as complete", badLimit, 400, "limit", "greater than or equal to 1");
  const badWindow = await call(`/control/revenue/book?from=${D.d4}&to=${D.d1}`, asAn);
  refused("an inverted window on a read is refused by the route before the door's `bad_window` is ever "
    + "asked", badWindow, 400, "to", "The last day cannot come before the first day.");

  const cutAccount = await call(`/control/revenue/cut/account?currency=TZS&from=${D.d1}&to=${D.d4}`, asAn);
  check("GET /cut/account folds the readings that already carry the buckets — two income accounts, "
    + "158,000 in fees and 115,000 in transit levies, and the shares are shares of the 273,000 the desk is "
    + "also told it earned", ok(cutAccount) && cutAccount.json.buckets === 2
    && Number(cutAccount.json.income) === 273000 && cutAccount.json.omitted === 0
    && Number(cutAccount.json.rows[0].total) === 158000 && Number(cutAccount.json.rows[0].share) === 57.9
    && cutAccount.json.rows[0].readings === 2
    && cutAccount.json.rows[1].readings === 3 && cutAccount.json.note === null
    && Number(cutAccount.json.rows[1].total) === 115000, { json: cutAccount.json });
  const cutOne = await call(`/control/revenue/cut/account?currency=TZS&from=${D.d1}&to=${D.d4}&limit=1`, asAn);
  check("…and asking for one bucket changes what is printed and not what is claimed: `income` stays the "
    + "window's figure and `omitted` says a bucket is off the page, because a share of a truncated sum is a "
    + "lie about the month", ok(cutOne) && cutOne.json.rows.length === 1 && cutOne.json.buckets === 2
    && cutOne.json.omitted === 1 && Number(cutOne.json.income) === 273000, { json: cutOne.json });
  const cutSource = await call(`/control/revenue/cut/source?currency=TZS&from=${D.d1}&to=${D.d4}`, asAn);
  const srcs = (cutSource.json.rows ?? []).map((b: any) => `${b.key}:${b.total}`).sort();
  check("GET /cut/source cuts by the kind of paper the money came in on, which is a different question from "
    + "which account held it: fee, invoice, payment and the desk-typed movement the office later undid land "
    + "on two accounts, and the undone one is still printed under the day it was earned", ok(cutSource)
    && cutSource.json.buckets === 4 && Number(cutSource.json.income) === 273000
    && srcs.includes("fee:150000") && srcs.includes("invoice:100000")
    && srcs.includes("payment:15000") && srcs.includes("manual:8000"), { srcs, json: cutSource.json });
  const cutRoute = await call(`/control/revenue/cut/route?currency=TZS&from=${D.d1}&to=${D.d4}`, asAn);
  const roads = (cutRoute.json.rows ?? []).map((b: any) => `${b.key}:${Number(b.total)}`).sort();
  check("GET /cut/route names the road the trip was on and files what no road can be found for under a "
    + "labelled bucket rather than dropping it — and carries the note that explains why most of a young "
    + "book lands there", ok(cutRoute) && cutRoute.json.buckets === 2
    && roads.includes(`${ROAD}:218000`) && roads.includes("no road named:55000")
    && /no road named/.test(String(cutRoute.json.note)), { roads, json: cutRoute.json });
  const cutDesk = await call(`/control/revenue/cut/desk?currency=TZS&from=${D.d1}&to=${D.d4}`, asAn);
  check("GET /cut/desk files every movement raised by a seat that stood in no department under one named "
    + "bucket, and the sums still equal the window: a cut that cannot resolve a bucket is named, never "
    + "silently left out of the figure", ok(cutDesk) && cutDesk.json.buckets === 1
    && cutDesk.json.rows[0].key === "no desk named"
    && cutDesk.json.rows[0].label === "No desk named" && Number(cutDesk.json.income) === 273000
    && Number(cutDesk.json.rows[0].total) === 273000 && /no desk named/
    .test(String(cutDesk.json.note)), { json: cutDesk.json });
  const sumBuckets = async (cut: string) => (await one(`select
      coalesce(sum((b ->> 'total')::numeric), 0)::text as total from revenue_snapshots s,
      jsonb_array_elements(s.${"by_" + cut}) b
      where s.tenant_id = $1 and s.currency = 'TZS'
      and s.snapshot_day between $2 and $3`, [TP, D.d1, D.d4]));
  for (const cut of ["account", "source", "desk", "route"]) {
    const b = await sumBuckets(cut);
    check(`the ${cut} cut the desk is handed adds up to the book's own ${b.total} over the window, so no `
      + "cut of the register is a second arithmetic path that can drift from the day it was drawn from",
      Number(b.total) === 273000, b);
  }
  const cutBad = await call("/control/revenue/cut/quarter?currency=TZS", asAn);
  refused("a fifth cut is refused by the route with the four the register keeps named", cutBad, 400,
    "The four cuts the register keeps are account, source, desk and route.");

  const winWeek = await call(`/control/revenue/window?kind=week&from=${D.d1}&to=${D.d4}&currency=TZS`, asAn);
  const weekActual = Number(winWeek.json.actual);
  check("the same book folded by week is two weeks of readings, and the fold's own total agrees with the "
    + "month's: a window is a way of grouping, not a second sum", ok(winWeek)
    && (winWeek.json.periods === 1 || winWeek.json.periods === 2) && weekActual === 273000
    && winWeek.json.from_day && winWeek.json.to_day
    && winWeek.json.rows.every((r: any) => r.currency === "TZS" && r.period_start && r.label),
    { json: { periods: winWeek.json.periods, actual: winWeek.json.actual } });
  const winDay = await call(`/control/revenue/window?kind=day&from=${D.d2}&to=${D.d4}&currency=TZS`, asAn);
  check("folded by day the window prints a row per day rather than per month, keeps the target off the days "
    + "no promise covers, and still refuses to call a day the book never moved income in a gap", ok(winDay)
    && winDay.json.periods === 3 && winDay.json.rows.length === 3
    && winDay.json.rows[0].period_start === D.d4 && Number(winDay.json.rows[0].actual) === 28000
    && winDay.json.rows[1].period_start === D.d3 && Number(winDay.json.rows[1].actual) === 15000
    && winDay.json.rows[1].complete === true && winDay.json.rows[1].target === null
    && winDay.json.rows[2].period_start === D.d2 && Number(winDay.json.actual) === 103000,
    { json: { periods: winDay.json.periods, rows: winDay.json.rows?.slice(0, 3) } });
  // A window measured from the fixture days to today would be 55–60 day-periods wide depending on the
  // calendar, so the wide fold is asked for by name: 400 days is over the sixty-period cap on any date.
  const winWide = await call(`/control/revenue/window?kind=day&from=${D.d1}&to=${D.far_month}`
    + "&currency=TZS", asAn);
  refused("a day fold wider than sixty periods is refused with the limit in its own words, because the "
    + "window is a read a desk polls and a fold of four hundred days answers after the clerk has moved on",
    winWide, 400, "periods wide", "prints at most 60");
  const winFuture = await call(`/control/revenue/window?kind=month&from=${D.out_reach}&currency=TZS`, asAn);
  refused("a fold whose periods are all in the future answers the door's own `bad_window` rather than an "
    + "empty table, because a window that prints nothing is read as a month that earned nothing", winFuture,
    400, "the first day cannot be in the future of the last one");
  check("…and the code the door answered with is the one the route maps to a 400, not a 404 or a 409",
    code(winFuture) === "VALIDATION_FAILED", { code: code(winFuture), words: words(winFuture) });

  // ---------------- 9. two books are two worlds ----------------
  phase("a second office book, counted on its own, says nothing about the first");
  const estState = await call("/control/revenue/book/state?days=120", asEst);
  check("a super_admin in the other office reads its own state: one uncounted TZS day and nothing at all in "
    + "the dollar, which is the first book's shape only in passing", ok(estState)
    && cur0(estState.json, "TZS").uncounted_count === 1
    && cur0(estState.json, "TZS").next_day === D.d1 && cur0(estState.json, "USD").uncounted_count === 0,
    { tz: cur0(estState.json, "TZS"), usd: cur0(estState.json, "USD") });
  const estTake = await call("/control/revenue/book/take", { ...asEst, body: { day: D.d1 } });
  tally(estTake.json?.snapshots);
  check("…and counting it answers 777,000 across one movement: the other book's own money, from the other "
    + "book's own legs, with the seat that pressed it named", ok(estTake)
    && estTake.json.read === 1 && Number(estTake.json.snapshots[0].income) === 777000
    && estTake.json.snapshots[0].snapshot.taken_by_name === "Esther Other",
    { status: estTake.status, json: estTake.json });
  const estId = estTake.json?.snapshots?.[0]?.snapshot?.id;
  const cross = await call(`/control/revenue/book/${estId}`, asPen);
  refused("a reading from another office's book is a 404 in this one, on the door that takes no tenant "
    + "argument from the caller at all", cross, 404,
    "There is no count of the book with that number in this book.");
  const crossList = await call("/control/revenue/book?currency=TZS", asPen);
  const crossWin = await call(`/control/revenue/window?kind=month&from=${D.d1}&to=${D.d4}&currency=TZS`, asPen);
  check("…and the other book's 777,000 appears nowhere in this register, its fold or its cuts: the isolation "
    + "here is the tenant bound in every statement, not a filter a screen forgot",
    !JSON.stringify(crossList.json).includes("777000")
    && !JSON.stringify(crossWin.json).includes("777000")
    && Number(crossList.json.window_income) === 277000
    && Number(crossWin.json.actual) === 273000,
    { list: crossList.json.window_income, win: crossWin.json.actual });
  const crossTargets = await call("/control/revenue/targets?currency=TZS&withdrawn=true", asEst);
  check("…and neither promise is visible from the other book either, because a target is filed under the "
    + "office that agreed it", ok(crossTargets) && crossTargets.json.count === 0, crossTargets.json);
  const estDup = await call("/control/revenue/targets", { ...asEst, body: { kind: "month",
    day: D.d1, amount: "800000", currency: "TZS",
    note: "The same figure, promised by a different office." } });
  AUD.set++;
  check("…and two offices may promise the identical figure for the identical month without either being "
    + "told it already exists: the one-promise rule is per book, which is what makes it a rule about an "
    + "office rather than a global lock", ok(estDup) && estDup.json.wrote !== setMonth.json.wrote,
    { status: estDup.status, json: estDup.json });

  // ---------------- 10. the promises, read as a list ----------------
  phase("the promises the office has made, live and stopped");
  const liveTargets = await call("/control/revenue/targets?currency=TZS", asAn);
  const allTargets = await call("/control/revenue/targets?currency=TZS&withdrawn=true", asAn);
  const liveMonth = (liveTargets.json.rows ?? [])
    .find((r: any) => r.ref === setMonth.json.wrote) ?? {};
  check("GET /targets lists every promise that stands — the month the office agreed and the day that "
    + "survived the race — each with what the register has said against it, and hides the stopped one until "
    + "it is asked for: \"we promised 1,200,000 and stopped meaning it\" is a different fact from the one a "
    + "live target carries", ok(liveTargets) && liveTargets.json.count === 2
    && liveTargets.json.rows.every((r: any) => r.status === "live")
    && liveMonth.status === "live" && Number(liveMonth.actual) === 273000
    && Number(liveMonth.amount) === 800000 && liveMonth.raised_by_name === "Promising Bill"
    && allTargets.json.count === 3 && allTargets.json.rows.every((r: any) => r.status === "live"
      || r.status === "withdrawn") && allTargets.json.rows.filter((r: any) => r.status === "withdrawn")
      .every((r: any) => !!r.withdrawn_reason && !!r.withdrawn_by_name),
    { live: liveTargets.json.count, all: allTargets.json });
  const weekTargets = await call(`/control/revenue/targets?currency=TZS&kind=week&from=${D.d1}&to=${D.d4}`, asAn);
  check("…and filtering the promises by a period the office never promised against answers an empty list "
    + "with a count of zero rather than the whole register", ok(weekTargets) && weekTargets.json.count === 0
    && weekTargets.json.rows.length === 0, weekTargets.json);
  void manSet;

  // ---------------- 11. the audit the doors wrote ----------------
  phase("the register's own audit: one line per act, and none for a look");
  const audit = await one(`select
      count(*) filter (where action = 'revenue_snapshot_taken') as taken,
      count(*) filter (where action = 'revenue_snapshot_retaken') as retaken,
      count(*) filter (where action = 'revenue_snapshot_rechecked') as rechecked,
      count(*) filter (where action = 'revenue_snapshot_discarded') as discarded,
      count(*) filter (where action = 'revenue_days_counted') as swept,
      count(*) filter (where action = 'revenue_target_set') as set,
      count(*) filter (where action = 'revenue_target_withdrawn') as stopped,
      count(*) filter (where action = 'revenue_target_discarded') as thrown,
      count(*) filter (where tenant_id = $1) as in_office,
      count(*) filter (where action like 'revenue_%' and actor_role is null) as no_role,
      count(*) filter (where action like 'revenue_%' and ip is null) as no_ip
      from audit_logs where entity in ('revenue_snapshots','revenue_targets')
      and ts > to_timestamp($2/1000.0)`, [TP, T0]);
  const want = { taken: AUD.taken, retaken: AUD.retaken, rechecked: AUD.rechecked,
    discarded: AUD.discarded, swept: AUD.swept, set: AUD.set, stopped: AUD.stopped, thrown: AUD.thrown };
  const got = { taken: Number(audit.taken), retaken: Number(audit.retaken),
    rechecked: Number(audit.rechecked), discarded: Number(audit.discarded), swept: Number(audit.swept),
    set: Number(audit.set), stopped: Number(audit.stopped), thrown: Number(audit.thrown) };
  check("every act the register accepted is audited exactly once, by the door that made it, and the count "
    + "is what the doors themselves said they did: one line per reading per money per press — including "
    + "the two reads that changed nothing — plus one line per sweep, per erase and per promise write",
    Object.keys(want).every((k) => want[k as keyof typeof want] === got[k as keyof typeof got]),
    { wanted: want, got });
  check("…and this route file writes none of its own: the register's audit rows carry the role and the "
    + "address the seat pressed from, and there is no doubled line anywhere", Number(audit.no_role) === 0
    && Number(audit.no_ip) === 0 && Number(audit.in_office) > 0, audit);
  const takenLine = await one(`select action, entity, entity_id, before, after, actor_user_id
      from audit_logs where entity = 'revenue_snapshots' and action = 'revenue_snapshot_retaken'
      and entity_id = $2::uuid and ts > to_timestamp($1/1000.0)`, [T0, tzId]);
  check("the re-take's line carries the figures it replaced in `before` and the figures it wrote in `after`, "
    + "pinned to the reading it amended, so the register can be read as a history rather than only as a "
    + "total — 140,000 over two movements became 170,000 over three, under the same reference", takenLine
    && String(takenLine.entity_id) === String(tzId)
    && Number(takenLine.before?.income) === 140000 && Number(takenLine.before?.postings) === 2
    && Number(takenLine.before?.revisions) === 1 && !!takenLine.before?.taken_at
    && String(takenLine.after?.income) === "170000.00"
    && Number(takenLine.after?.postings) === 3 && Number(takenLine.after?.entries) === 3
    && takenLine.after?.ref === tzRef && takenLine.after?.state === "retaken"
    && takenLine.after?.currency === "TZS" && !!takenLine.after?.seat
    && String(takenLine.actor_user_id) === uPen, { line: takenLine });
  const retakeLines = await one(`select count(*)::int as n from audit_logs
      where action = 'revenue_snapshot_retaken' and ts > to_timestamp($1/1000.0)`, [T0]);
  check("…and this run re-took exactly one day, so exactly one line says so: an audit that wrote a re-take "
    + "for a press that changed nothing, or two for one amendment, is a history that cannot be totalled",
    Number(retakeLines.n) === AUD.retaken, { n: retakeLines.n, tally: AUD.retaken });
  const sweepLine = await one(`select after from audit_logs where action = 'revenue_days_counted'
      and after ->> 'from_day' = $2 and (after ->> 'days_read')::int = 4
      and ts > to_timestamp($1/1000.0)`, [T0, D.d1]);
  check("the sweep's line names the window and its own figures rather than the reading it ended on, so an "
    + "auditor can tell an ordered count from a pressed one without opening the register",
    sweepLine?.after?.from_day === D.d1 && sweepLine?.after?.to_day === D.d4
    && Number(sweepLine?.after?.days_read) === 4 && Number(sweepLine?.after?.new) === 1
    && Number(sweepLine?.after?.retaken) === 0 && Number(sweepLine?.after?.passed_over) === 0
    && String(sweepLine?.after?.seat).length > 3, sweepLine);
  const readsBefore = Number((await one(`select count(*)::int as n from audit_logs
    where entity in ('revenue_snapshots','revenue_targets') and ts > to_timestamp($1/1000.0)`, [T0])).n);
  for (const p of ["/control/revenue/book/state", "/control/revenue/book?currency=TZS",
    "/control/revenue/book?currency=USD&limit=2", `/control/revenue/cut/desk?currency=TZS`,
    `/control/revenue/cut/route?currency=USD&from=${D.d1}&to=${D.d4}`,
    `/control/revenue/window?kind=week&from=${D.d1}&currency=TZS`,
    "/control/revenue/targets?currency=USD", `/control/revenue/targets/${monthTarget}`,
    `/control/revenue/book/${tzId}`, "/control/revenue/book/state?days=1"]) {
    const r = await call(p, asAn);
    if (!ok(r)) check(`the read ${p} answered 200 on a reader's cookie`, false, { status: r.status });
  }
  const readsAfter = Number((await one(`select count(*)::int as n from audit_logs
    where entity in ('revenue_snapshots','revenue_targets') and ts > to_timestamp($1/1000.0)`, [T0])).n);
  check("ten reads across all seven read doors write nothing at all: a register that audited a look would "
    + "fill the office's history with page views", readsBefore === readsAfter,
    { readsBefore, readsAfter });

  const buckets = await one(`select count(*)::int as n,
      count(*) filter (where bucket like 'revenue-sweep%')::int as sweeps,
      count(*) filter (where bucket like 'revenue-take%')::int as takes,
      count(*) filter (where bucket like 'revenue-target-set%')::int as targets
      from rate_limits where bucket like 'revenue-%'`, );
  check("the desk's own limiters fired on every door that needs one: a read polled all day, a take pressed "
    + "a dozen times and a sweep that walks a quarter of the book are three different budgets, kept per "
    + "seat", buckets.n >= 8 && buckets.sweeps >= 1 && buckets.takes >= 1 && buckets.targets >= 1, buckets);
  const noLeak = leak.length === 0;
  check("no sentence from a 143 table guard reached a desk in any reply this run — every refusal a clerk "
    + "can read is either the route's own words or the register's, and never `143: ` with a rule attached",
    noLeak, { leak });
  check("…and the two numbers a clerk needs never printed as `undefined` or `null` in a refusal the route "
    + "carried: the door's `asked` and the limiter's `retryIn` both arrived as figures",
    refusals.some((w) => /retryIn:\d+/.test(w)) && refusals.some((w) => /asked:20\d\d-\d\d-\d\d/.test(w)),
    { sample: refusals.slice(0, 3) });
  note(`refusals this run collected (${refusals.length}): ${refusals.slice(0, 2).join(" || ")}`);

  // ---------------- 12. the numbers the register issued ----------------
  phase("the reference numbers spent, accounted for by name");
  const SEQ1 = await one(`select
      (select last_value from revenue_snapshot_number_seq) as readings,
      (select last_value from revenue_target_number_seq) as promises`);
  const issuedReadings = AUD.taken + ghost.snapshots;
  const issuedTargets = AUD.set + ghost.targets;
  check("every reference the register issued is accounted for: one per reading that landed — including the "
    + "zero that was counted and then thrown away, whose number is not coming back — plus the presses that "
    + "died copying a period onto a row that never landed. Nothing else on this desk spends a number, which "
    + "is what makes the line hold on a second run of the same book",
    Number(SEQ1.readings) - Number(SEQ0.readings) === issuedReadings
    && Number(SEQ1.promises) - Number(SEQ0.promises) === issuedTargets,
    { before: SEQ0, after: SEQ1, issued: { readings: issuedReadings, targets: issuedTargets },
      ghost, audit: got });

  // ---------------- 13. teardown, and what the guards keep ----------------
  phase("teardown, and the census two books of counted money leave behind");
  const books = [TP, TX, CO1];
  const uids = [uPen, uCount, uBill, uAn, uAud, uDir, uMan, uEst, uClerk];
  // A reading of a day that moved money and a movement itself are both kept by design, so the sweep stops
  // where the guards start: the empty rows that are still standing go, the promises nobody was measured
  // against go, the readers and the company go, and the books that hold counted money stay.
  await oi(`delete from revenue_snapshots where tenant_id = any($1::uuid[]) and postings = 0`, [books]);
  await oi(`delete from revenue_targets t where t.tenant_id = any($1::uuid[]) and t.status = 'live'
    and t.withdrawn_at is null and not exists (select 1 from revenue_snapshots s
      where s.tenant_id = t.tenant_id and s.currency = t.currency
      and s.snapshot_day >= t.period_start
      and s.snapshot_day < platform_auth.revenue_period_end(t.period_kind, t.period_start))`, [books]);
  await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
  await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
  await oi(`delete from role_permissions where role_id = $1`, [ROLE_COUNT_ONLY]);
  await oi(`delete from roles where id = $1`, [ROLE_COUNT_ONLY]);
  await oi(`delete from rate_limits where bucket like 'revenue-%'
    or (bucket ~ '^money-' and split_part(bucket, ':', 2) = any($1::text[]))`, [uids]);
  const deletable = [uAn, uAud, uDir, uMan, uClerk];
  let heldBack = 0;
  for (const u of uids) {
    await oi(`delete from users where id = $1`, [u]).catch(() => { heldBack++; });
  }
  await oi(`delete from routes where id = $1`, [routeId]).catch(() => { heldBack++; });
  await oi(`delete from trips where id = $1`, [trip]).catch(() => { heldBack++; });
  for (const b of [CO1, TX, TP]) await oi(`delete from tenants where id = $1`, [b]).catch(() => { heldBack++; });
  const END = await one(`select
      (select count(*) from revenue_snapshots) as readings,
      (select count(*) from revenue_targets) as promises,
      (select count(*) from tenants where name like $1) as books,
      (select count(*) from users where email like $2) as seats`, [BOOK_SWEEP, EMAIL_ALL]);
  note(`this run left ${Number(END.readings) - Number(START.readings)} readings and `
    + `${Number(END.promises) - Number(START.promises)} promises on the register, in `
    + `${Number(END.books) - Number(START.books)} books with ${Number(END.seats) - Number(START.seats)} `
    + "seats standing");
  check("the rows that stayed are exactly the ones the guards name, stated as growth over the register this "
    + "run started from so that a second run of the same suite grades the same facts: seven readings — six in "
    + "the office that counted them, five shilling days and the dollar one, plus the other book's single "
    + "movement — three promises that were each counted against or stopped, two books and the three seats "
    + "the register can still name. The counter's seat goes too, because the only reading it wrote was the "
    + "zero it threw away",
    Number(END.readings) - Number(START.readings) === AUD.taken - AUD.discarded
    && Number(END.promises) - Number(START.promises) === 3
    && Number(END.books) - Number(START.books) === 2
    && Number(END.seats) - Number(START.seats) === 3,
    { end: END, start: START, taken: AUD.taken, discarded: AUD.discarded });
  const left = await one(`select
      (select count(*) from revenue_snapshots where tenant_id = $1) as office_readings,
      (select count(*) from revenue_snapshots where tenant_id = $1 and postings = 0) as office_empties,
      (select count(*) from revenue_snapshots where postings = 0 and tenant_id <> $1) as strays,
      (select count(*) from revenue_targets where tenant_id = $1) as office_promises,
      (select count(*) from revenue_targets where tenant_id = $1 and status = 'live') as live,
      (select count(*) from revenue_targets where withdrawn_at is not null) as stopped_rows,
      (select count(*) from roles where key like 'p143_%') as fixture_roles,
      (select count(*) from rate_limits where bucket like 'revenue-%') as buckets,
      (select count(*) from sessions where user_id = any($2::uuid[])) as seats_signed_in,
      (select count(*) from users where email = any($3)) as readers_left,
      (select count(*) from tenants where name = $4) as company_left`,
      [TP, deletable, deletable.map(emailFor), COMPANY_NAME]);
  check("everything the guards do not pin is gone: the minted duty profile, every limiter bucket this desk "
    + "spent, the sessions, the four seats that only ever looked, and the company book that counted nothing",
    Number(left.fixture_roles) === 0 && Number(left.buckets) === 0
    && Number(left.seats_signed_in) === 0 && Number(left.readers_left) === 0
    && Number(left.company_left) === 0 && Number(left.office_empties) === 0
    && Number(left.strays) === 0, left);
  check("…and the two promises that remain are the two the register says it keeps: one the office was "
    + "counted against while it stood, one somebody stopped", Number(left.office_promises) === 2
    && Number(left.live) === 1 && Number(left.stopped_rows) >= 1, left);
  check("…and no reading was deleted by force: the office's own rows are still its six readings — five "
    + "shilling days its book moved money in and the dollar day it also earned on — which is the keep-guard "
    + "working rather than the sweep failing",
    Number(left.office_readings) === 6, left);
  const heldSeats = await one(`select
      count(*) filter (where id = $1) as pen, count(*) filter (where id = $2) as counter,
      count(*) filter (where id = $3) as biller, count(*) filter (where id = $4) as other
      from users where id = any($5::uuid[])`,
    [uPen, uCount, uBill, uEst, [uPen, uCount, uBill, uEst]]);
  note(`seats the register pinned by name and so could not be deleted: pen=${heldSeats.pen} `
    + `counter=${heldSeats.counter} biller=${heldSeats.biller} other=${heldSeats.other} `
    + `(${heldBack} rows a guard or a foreign key kept in total)`);

  const orphans = await one(`select
      (select count(*) from revenue_snapshots s where not exists
        (select 1 from tenants t where t.id = s.tenant_id)) as headless_books,
      (select count(*) from revenue_snapshots s where not exists
        (select 1 from users u where u.id = s.taken_by)) as seatless,
      (select count(*) from revenue_targets t where not exists
        (select 1 from tenants x where x.id = t.tenant_id)) as loose_promises,
      (select count(*) from revenue_snapshots s where s.income <> s.credit_total - s.debit_total
        or platform_auth.revenue_cut_sum(s.by_account) <> s.income
        or platform_auth.revenue_cut_sum(s.by_source) <> s.income
        or platform_auth.revenue_cut_sum(s.by_desk) <> s.income
        or platform_auth.revenue_cut_sum(s.by_route) <> s.income) as unbalanced,
      (select count(*) from revenue_snapshots s where s.postings = 0 and (s.income <> 0
        or jsonb_array_length(s.by_account) <> 0)) as fake_zeros,
      (select count(*) from revenue_snapshots s where s.revisions > 1 and s.previous is null) as amnesia`);
  check("nothing kept is inconsistent now that the sweep has run: every reading stands on a book and a "
    + "seat the register can still name, every figure is still the difference of its two piles, every cut "
    + "still sums to it, every zero is still empty and every re-take still remembers",
    Number(orphans.headless_books) === 0 && Number(orphans.seatless) === 0
    && Number(orphans.loose_promises) === 0 && Number(orphans.unbalanced) === 0
    && Number(orphans.fake_zeros) === 0 && Number(orphans.amnesia) === 0, orphans);

  await owner.end();
  console.log(`\n${failures ? `SMOKE FAILED (${failures})` : "SMOKE CLEAN"} in `
    + `${((Date.now() - T0) / 1000).toFixed(1)}s`);
  if (failures) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error("probe died:", e);
  // A dead probe must actually exit: an open owner socket keeps the node process alive behind a
  // half-printed stack, and a run that never ends looks like a run still going.
  await held?.end().catch(() => undefined);
  process.exitCode = 1;
});
