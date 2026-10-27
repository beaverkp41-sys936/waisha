/**
 * The cut the office takes out of somebody else's money, over HTTP — smoke for #420b (migration 142 and
 * `control-pricing-commission.routes.ts`).
 *
 * `verify-pricing-commission-sql.ts` proved the register: 130 checks, every ladder rung, the resolver's
 * arithmetic, the two-seat publish, the pointer at 133's book, the guards with no door in between. This
 * file is not a shorter version of that probe. It grades the six things that only exist once a desk can
 * reach the register:
 *
 *  - that all 18 doors are really mounted, and that the three duties 140 minted cover them the way 142
 *    claims: a reader cannot open a cut, the pen that types figures is not thereby allowed to ask anyone
 *    to sign them, and the seat that says a cut has been carried also has to hold 133's pen;
 *  - that the two halves of a refusal stay distinguishable. Five decimals on a percent, a `EUR` money, a
 *    flat with no money and a `2026-02-30` are 142's own route rules with a `field` annotation;
 *    `percent_too_wide`, `days_are_taken` and `carrier_does_not_carry_the_cut` are the register's sentences
 *    with nothing rewritten; a `142: ` prefix from a table guard must never reach the desk;
 *  - that the status the route chose is the status the desk gets: `no_rate` and `no_such_posting` as 404
 *    because a row the clerk named is not in this book, `paper_is_out`, `already_assessed`,
 *    `carrier_is_other_money` and `kept` as 409 because the row the clerk is staring at is the obstacle,
 *    `asked_other_book` and the vocabulary refusals as 400;
 *  - that 121's effect runs over HTTP in the register's own order. This is the one thing the SQL gate
 *    cannot prove from a route file: `POST /control/approvals/:id/approve` by a second seat decides,
 *    claims, applies and settles in one transaction and the agreement is `published` on the row;
 *  - that a pointer at 133's book is answered out of the book. Three real postings are raised through
 *    `POST /control/money/postings` and the register reads its figure out of the leg each time, so the
 *    refusals name both halves and the acceptance writes no money;
 *  - that every accepted write is audited exactly once by the door that made it and that no read writes
 *    anything, and that two office books are two worlds on every one of the doors.
 *
 * WHAT THIS RUN DELIBERATELY DOES NOT DO.
 *
 *  1. It never reaches a door's `not_a_seat` or `not_the_office` refusal, because HTTP cannot hand one:
 *     `get_control_session` (099) returns nothing for a company session, so a clerk's press is a 401 on
 *     `requireControl` and never becomes the door's sentence, and every book a control seat can sign into
 *     is a platform book. Both refusals are the gate's, and they are proved there.
 *  2. It carries a cut with a posting only. The payout arm — raised, released, paid, its fee leg — is
 *     134's own state machine, which needs a second two-seat signature of its own; the gate walks all
 *     four of its states (`payout_has_not_moved`, `fee_is_not_booked_yet`, the fee mismatch and the carry)
 *     and this run proves the pointer that shares the door: the ghost id, the money crossing, the short
 *     leg and the movement that carries exactly the figure.
 *  3. It does not re-prove the ladder arithmetic. One agreement is put live, on the office's own standing
 *     rung, because that is the rung a publish reaches with no company and no plan pinned to a kept row.
 *     Negotiated-beats-plan-beats-standing, the floor lift, the clamp and the day a ladder has no paper
 *     for are the gate's phase 3.
 *
 * WHAT THIS RUN LEAVES BEHIND, ON PURPOSE.
 *
 * Unlike 140's and 141's runs, this one spends a signature, and the register's own keep-guards make the
 * consequence permanent: `pricing_commission_rate_is_kept` refuses the delete of an agreement that ever
 * carried a paper or ever lived, `pricing_commission_readings_are_kept` refuses the delete of every
 * reading, `pricing_commission_history_is_kept` refuses the delete of every memory line, and
 * `pricing_commission_assessments.rate_id` pins the agreement to the reading. So the run does not fight
 * the guards. The office book, the three seats whose names appear in the kept rows, the published
 * agreement, the refused one, the version that was cloned forward over a live cut and then answered back
 * to a draft, its readings, its memory and the postings that carried them stay. Everything
 * the guards do not pin is swept. The census is therefore a growth assertion — exactly this many rows, all
 * of them attributable to this run's own uuids — and the office book and its three seats carry fixed names
 * so that a re-run grows the register without growing the tenant list.
 *
 * SAFETY: every book is this run's own synthetic tenant and every seat a synthetic platform user; the
 * agreements, readings, papers, invoices, accounts and postings are all named or keyed for the sweep. Audit
 * lines and the sequence numbers they spent stay behind: `prevent_audit_mutation()` refuses the owner too,
 * and a sequence is not a row. No real company, no real price list and no real cut is touched.
 *
 * Run: SMOKE_API_BASE=http://localhost:4100/api/v1 npx tsx scripts/smoke-pricing-commission.ts
 *      (the dev API; :4000 on this box belongs to another project)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sha256 } from "../src/util/crypto.js";

const API = process.env.SMOKE_API_BASE ?? "http://localhost:4000/api/v1";

const STAMP = Date.now().toString().slice(-8);
const MARK = `prc${STAMP}`;
/** The office book and the three seats whose names end up inside a kept row are fixed, so a second run
 *  grows the cut register rather than the tenant table. Everything a run can delete carries this stamp. */
const OFFICE_NAME = "PR Commission Office";
const OTHER_NAME = `PR Commission Other ${STAMP}`;
const EMAIL_KEEP = "smoke.prc.";
const EMAIL_SWEEP = `smoke.prc.%@waisha.test`;
const BOOK_SWEEP = "PR Commission %";
/** The owner socket, handed out so a probe that dies mid-run can close it and actually exit. */
let held: pg.Client | null = null;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function note(label: string) { console.log(`note ${label}`); }
function phase(name: string) { console.log(`\n--- ${name} ---`); }

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
  return { status: res.status, json, text };
}

const code = (r: { json: any }) => r.json?.error?.code ?? null;
/** Three writers answer one call: the route's zod shape (a sentence plus a `field`), a 142 door (a sentence
 *  plus its own figures in `details[0]`) and a table guard (a `raise` with `142: ` on the front, which the
 *  route cuts off). Joined, so a check on "the register's own words" cannot pass on a guard's paraphrase. */
const words = (r: { json: any }) => [String(r.json?.error?.message ?? ""),
  ...(Array.isArray(r.json?.error?.details)
    ? r.json.error.details.map((d: any) => typeof d === "object" && d !== null
      ? [String(d.field ?? ""), String(d.message ?? ""),
        ...Object.entries(d).filter(([k, v]) => !["field", "message"].includes(k)
          && ["string", "number", "boolean"].includes(typeof v))
        .map(([k, v]) => `${k}:${v}`)].filter(Boolean).join(" ")
      : String(d)) : [])].join(" | ");

/** `open` and `propose` hand back the detail door's whole envelope hung on `rate`, so the agreement is the
 *  envelope's own `rate` — one level deeper than the read doors put it. `edit` hands the detail itself.
 *  The desk normalises this; a check that read one path flat would fail against a door that answered
 *  perfectly. */
const agreeOf = (j: any) => j?.rate?.rate ?? j?.rate ?? null;
const readIdOf = (j: any) => j?.reading?.reading?.id ?? j?.reading?.id ?? j?.id ?? null;

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
  const row = async (t: string, id: string): Promise<any> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) {
      throw new Error(`no ${t} row to read back: the door never returned an id (${JSON.stringify(id)}). `
        + "An earlier check in this phase FAILed — read the line above it.");
    }
    return (await one(`select * from ${t} where id = $1::uuid`, [id]));
  };
  /** `pg` hands a bare `date` back as a Date at local midnight and this box runs at UTC+3, so the papers'
   *  own printing is asked of the database rather than converted in the probe. */
  const rateRow = (id: string) => one(`select tenant_id, ref, subject_kind, subject_key, subject_name,
      subject_tenant_id, subject_plan_id, source_kind, payee_kind, payee_id, payee_name, basis,
      value::text as value, currency, floor_amount::text as floor_amount, cap::text as cap,
      effective_from, effective_to, version, supersedes_id, status, approval_id, refusals, note,
      published_by, published_note, withdrawn_by, withdrawn_reason, created_by, updated_by,
      to_char(effective_from,'YYYY-MM-DD') as from_day,
      to_char(effective_to,'YYYY-MM-DD') as to_day,
      to_char(published_at,'YYYY-MM-DD') as published_day,
      to_char(withdrawn_at,'YYYY-MM-DD') as withdrawn_day
      from pricing_commission_rates where id = $1::uuid`, [id]);
  const readingRow = (id: string) => one(`select tenant_id, ref, rate_id, source_kind, source_id,
      source_ref, source_amount::text as source_amount, currency, raw_amount::text as raw_amount,
      figure::text as figure, status, carrier_kind, carrier_id, carrier_ref, discharge_note,
      void_reason, note, assessed_by, discharged_by, voided_by,
      to_char(assessed_on,'YYYY-MM-DD') as assessed_day,
      to_char(discharged_at,'YYYY-MM-DD') as carried_day,
      to_char(voided_at,'YYYY-MM-DD') as voided_day
      from pricing_commission_assessments where id = $1::uuid`, [id]);
  /** The version the register is about to hand out on one rung, inside this office's own book. 142 takes
   *  it as `coalesce(max(version),0)+1` over (tenant_id, subject_key, source_kind), and an agreement that
   *  ever lived is kept — so the rung this run opens is not the first the ladder has seen, and no version
   *  in this probe can be written as a literal. Asked before the write, never after.
   *
   *  The book is in the predicate because a platform rung's `subject_key` is the same nil uuid in every
   *  office book: counted across all of them, this pre-read would guess the number a *second* office's
   *  agreements push the ladder on, and the door — which counts only its own book, which is the whole
   *  point of the re-key — would answer a lower version and look broken. */
  const rungVersion = async (subjectKey: string, sourceKind: string) => Number((await one(
    `select coalesce(max(version), 0) + 1 as next from pricing_commission_rates
       where tenant_id = $1::uuid and subject_key = $2::uuid and source_kind = $3`,
    [TP, subjectKey, sourceKind])).next);
  /** Where the agreement-numbering sequence stands. Read *around* a press rather than assumed at the end,
   *  because 142 checks a named company's existence in `pricing_commission_names_its_book` — the one place
   *  it copies identities onto the row — and a BEFORE INSERT trigger answers after the tuple, and so after
   *  `nextval`, has been built. A gap in the numbering is a fact about which door answered, not a leak. */
  const seqRates = async () => Number((await one(
    "select last_value::text as v from pricing_commission_rate_number_seq")).v);

  // A run that died mid-flight leaves its stamped fixtures standing, and the next run cannot reuse a taken
  // plan key, a limiter window already spent, or a seat whose role row is already there. So this clears by
  // this suite's own name patterns — never by a uuid from an earlier run, which this run does not know —
  // and it stops exactly where the guards start: an agreement that ever lived or ever carried a paper, its
  // readings and memory lines, and 133's accounts and postings all stay behind on purpose. It runs before
  // the census and before the duty check below, because a duty profile an earlier run minted is not
  // evidence about the roles 140 seeded.
  const KEEP_SEATS = [`${EMAIL_KEEP}own@waisha.test`, `${EMAIL_KEEP}bill@waisha.test`,
    `${EMAIL_KEEP}sign@waisha.test`];
  const preClean = async () => {
    const office = (await one(`select id from tenants where name = $1`, [OFFICE_NAME]))?.id
      ?? randomUUID();
    const books = [office,
      ...(await oi(`select id from tenants where name like $1 and name <> $2`, [BOOK_SWEEP, OFFICE_NAME]))
        .rows.map((x: any) => String(x.id))];
    const seats = (await oi(`select id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((x: any) => String(x.id));
    const pinned = (await oi(`select id from users where email = any($1)`, [KEEP_SEATS]))
      .rows.map((x: any) => String(x.id));
    const pens = (await oi(`select id from roles where key like 'p142_pen_%'`))
      .rows.map((x: any) => String(x.id));
    // A draft that never lived and never carried a paper is the one agreement the register lets a desk throw
    // away, so an earlier run's drafts go first: they are what pins a plan key and a seat.
    const drafts = (await oi(`select id from pricing_commission_rates where tenant_id = any($1::uuid[])
        and published_at is null and approval_id is null and status = 'draft'`, [books]))
      .rows.map((x: any) => String(x.id));
    if (drafts.length) {
      await oi(`delete from pricing_commission_history where rate_id = any($1::uuid[])`, [drafts]);
      await oi(`delete from pricing_commission_rates where id = any($1::uuid[])`, [drafts]);
    }
    if (seats.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [seats]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [seats]);
    }
    if (pens.length) {
      await oi(`delete from role_permissions where role_id = any($1::uuid[])`, [pens]);
      await oi(`delete from roles where id = any($1::uuid[])`, [pens]);
    }
    // 121's register carries no book on it, so a paper belongs to an earlier run only through the seat that
    // raised it and the row it names. A paper whose agreement is gone is litter; one that still points is a
    // proof somebody was asked to sign, and it stays.
    await oi(`delete from platform_approvals where action = 'pricing.commission'
      and proposed_by = any($1::uuid[]) and not exists
      (select 1 from pricing_commission_rates r where r.id::text = target_id)`,
      [seats.length ? seats : [randomUUID()]]);
    // An assessment keeps its source only as a uuid and a sentence — there is no foreign key — so a cut
    // already taken still names an invoice this run is allowed to delete.
    await oi(`delete from freight_invoices where invoice_number like 'PRC-142-%'`);
    await oi(`delete from subscriptions where tenant_id = any($1::uuid[])`, [books]);
    let heldBack = 0;
    for (const s of seats.filter((id: string) => !pinned.includes(id))) {
      await oi(`delete from users where id = $1`, [s]).catch(() => { heldBack++; });
    }
    for (const b of books.slice(1)) {
      await oi(`delete from tenants where id = $1`, [b]).catch(() => { heldBack++; });
    }
    await oi(`delete from plans where key like 'c142-growth-%'`).catch(() => { heldBack++; });
    await oi(`delete from rate_limits where bucket ~ '^(cut|readings-board|pricing)'`);
    note(`earlier runs' litter cleared: ${drafts.length} drafts, ${seats.length - pinned.length} seats, `
      + `${pens.length} duty profiles, ${books.length - 1} books, ${heldBack} rows a guard kept`);
  };
  await preClean();

  // The schema's own totals before anything is written, read after the litter is gone so the growth at the
  // end is this run's and not a difference between two crashed runs. Unlike 140's and 141's runs these
  // totals do not come back: the register keeps what a signature touched.
  const START = await one(`select
      (select count(*) from pricing_commission_rates) as rates,
      (select count(*) from pricing_commission_history) as memory,
      (select count(*) from pricing_commission_assessments) as readings,
      (select count(*) from platform_approvals where action = 'pricing.commission') as papers,
      (select count(*) from tenants where name like $1) as books,
      (select count(*) from users where email like $2) as seats`, [BOOK_SWEEP, EMAIL_SWEEP]);
  note(`cut register found: ${START.rates} agreements, ${START.memory} memory rows, ${START.readings} `
    + `readings, ${START.papers} papers, ${START.books} smoke books and ${START.seats} smoke seats `
    + "already filed");
  const SEQ0 = await one(`select
      (select last_value from pricing_commission_rate_number_seq) as rates,
      (select last_value from pricing_commission_assessment_number_seq) as readings`);

  // ---------------- 0. the duties this card is built on ----------------
  phase("the duties 142 hangs its doors on, as 140 seeded them and as the nav probe lists them");
  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "billing_admin", "finance_officer", "platform_analyst", "auditor", "director"]]
  )).rows;
  const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
  const missing = ["super_admin", "billing_admin", "finance_officer", "platform_analyst", "auditor",
    "director"].filter((k) => !rid(k));
  if (missing.length) throw new Error(`global roles missing: ${missing.join(", ")}`);

  const grants = await one(`select
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'super_admin' and rp.permission_key like 'control.pricing.%') as own,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'billing_admin' and rp.permission_key like 'control.pricing.%') as bill,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'finance_officer' and rp.permission_key like 'control.pricing.%') as read,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'director' and rp.permission_key like 'control.pricing.%') as dir,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'super_admin' and rp.permission_key = 'control.money.post') as pen,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'billing_admin' and rp.permission_key = 'control.money.post') as billpen,
      (select count(*) from role_permissions where permission_key = 'control.pricing.publish')
        as publish_key,
      (select count(*) from role_permissions m join roles r on r.id = m.role_id
        where r.tenant_id is null and m.permission_key = 'control.pricing.manage'
        and not exists (select 1 from role_permissions p
          where p.role_id = m.role_id and p.permission_key = 'control.pricing.publish')) as unsplit`);
  check("142 opens no fourth pricing duty: the three 140 minted are the three its doors take, and the two "
    + "global roles that hold manage both hold publish as well — which is why this run mints a pen-only "
    + "duty, because no real role can answer the 403 this split is graded on",
    Number(grants.own) === 3 && Number(grants.bill) === 3 && Number(grants.read) === 1
    && Number(grants.dir) === 0 && Number(grants.publish_key) === 2
    && Number(grants.unsplit) === 0, grants);
  check("…and the money duty a pointer needs is 133's own key, held by super_admin and billing_admin and "
    + "by nobody who only reads prices",
    Number(grants.pen) === 1 && Number(grants.billpen) === 1, grants);

  const keys = ["control.pricing.view", "control.pricing.manage", "control.pricing.publish",
    "control.money.post", "control.approvals.decide", "control.approvals.view"];
  const probeKeys = await one(`select count(*)::int as n from permissions where key = any($1)`, [keys]);
  check("every duty key the pricing card branches on is a real permission row, so a seat that holds one "
    + "is not told it does not — 140's allowlist trap", probeKeys.n === keys.length, probeKeys);

  // ---------------- 1. the books, the seats, the papers to cut ----------------
  phase("fixtures: one office book reused, one company on a plan, four invoices and eight seats");
  const mkTenant = async (type: string, name: string) => {
    const found = await one(`select id from tenants where name = $1`, [name]);
    if (found?.id) return String(found.id);
    return (await one(`insert into tenants (id, type, name, status, trial_ends_at)
      values ($1,$2,$3,'active', now() + interval '30 days') returning id`,
      [randomUUID(), type, name])).id;
  };
  const mkSeat = async (id: string, tenant: string, name: string, email: string) => {
    const found = await one(`select id from users where email = $1`, [email]);
    if (found?.id) return String(found.id);
    return (await one(`insert into users (id, tenant_id, user_type, full_name, email, status,
        totp_enabled, last_login_at, created_at)
      values ($1,$2,'platform',$3,$4,'active',true, now() - interval '2 hours',
        now() - interval '200 days') returning id`,
      [id, tenant, name, email])).id;
  };

  const TP = await mkTenant("platform", OFFICE_NAME);   // the office that agrees a cut
  const TX = await mkTenant("platform", OTHER_NAME);    // a second office book, kept out of TP's rows
  const CO1 = await mkTenant("transporter", `PR Commission Company ${STAMP}`);
  const CO2 = await mkTenant("transporter", `PR Commission Second ${STAMP}`);

  let PLAN = (await one(`select id from plans where key = $1`, [`c142-growth-${STAMP}`]))?.id;
  if (!PLAN) {
    PLAN = (await one(`insert into plans (key, name, seat_limit, price_monthly, price_quarterly,
        price_annual, currency) values ($1,'Growth, cut smoke',5,60000,165000,600000,'TZS')
        returning id`, [`c142-growth-${STAMP}`])).id;
  }
  await oi(`insert into subscriptions (tenant_id, plan_id, billing_cycle, status)
    values ($1,$2,'monthly','active') on conflict do nothing`, [CO1, PLAN]);
  await oi(`insert into subscriptions (tenant_id, plan_id, billing_cycle, status)
    values ($1,$2,'monthly','active') on conflict do nothing`, [CO2, PLAN]);

  // The three seats whose names end up in a kept row are fixed, so a re-run reuses them; the rest of the
  // eight carry this run's stamp and are deleted by the sweep.
  const uOwn = await mkSeat(randomUUID(), TP, "Commission Owner", `${EMAIL_KEEP}own@waisha.test`);
  const uBill = await mkSeat(randomUUID(), TP, "Commission Bill", `${EMAIL_KEEP}bill@waisha.test`);
  const uSign = await mkSeat(randomUUID(), TP, "Commission Signer", `${EMAIL_KEEP}sign@waisha.test`);
  const uRead = randomUUID();   // finance_officer: reads prices only
  const uAn = randomUUID();     // platform_analyst: reads prices and the approvals board
  const uAud = randomUUID();    // auditor: reads prices only
  const uDir = randomUUID();    // director: no pricing duty at all
  const uMan = randomUUID();    // the minted manage-without-publish seat
  const uEst = randomUUID();    // a super_admin in the other book
  const uClerk = randomUUID();  // a clerk in a company book, who is not a control seat at all
  for (const [id, tenant, name] of [[uRead, TP, "Neema Number"], [uAn, TP, "Asha Analyst"],
    [uAud, TP, "Daudi Audit"], [uDir, TP, "Fatma Director"], [uMan, TP, "Mano Draft"],
    [uEst, TX, "Esther Other"]] as [string, string, string][]) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
        last_login_at, created_at)
      values ($1,$2,'platform',$3,$4,'active',true, now() - interval '2 hours',
        now() - interval '200 days')`,
      [id, tenant, name, `smoke.prc.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`]);
  }
  await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled)
      values ($1,$2,'staff','Not A Seat',$3,'active',false)`,
    [uClerk, CO1, `smoke.prc.clerk.${STAMP}@waisha.test`]);

  // No existing global role is manage-without-publish, so every 403 that grades the publish duty would
  // pass for the wrong reason under super_admin. The run mints its own duty profile and deletes it again.
  const ROLE_MANAGE_ONLY = randomUUID();
  await oi(`insert into roles (id, tenant_id, key, name, is_system)
      values ($1, null, $2, 'P142 pen only', false)`,
    [ROLE_MANAGE_ONLY, `p142_pen_${STAMP}`]);
  await oi(`insert into role_permissions (role_id, permission_key)
      select $1, key from permissions where key in ('control.pricing.view','control.pricing.manage')`,
    [ROLE_MANAGE_ONLY]);

  await oi(`insert into user_roles (user_id, role_id) values
      ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10),($11,$12),($13,$14),($15,$16),($17,$18)`,
    [uOwn, rid("super_admin"), uBill, rid("billing_admin"), uSign, rid("super_admin"),
      uRead, rid("finance_officer"), uAn, rid("platform_analyst"), uAud, rid("auditor"),
      uDir, rid("director"), uEst, rid("super_admin"), uMan, ROLE_MANAGE_ONLY]);

  const tok = (who: string) => `${MARK}-${who}`;
  const ck = (who: string) => `waisha_control=${tok(who)}`;
  const openSession = async (uid: string, tenant: string, who: string) => {
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
        refresh_token_hash, user_agent, ip, expires_at)
      values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-pricing-commission',$6,
        now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
    // The same cookie has to be mintable twice across runs, so the pinned seats' old sessions go first.
    void who;
  };
  for (const [uid, tenant, who] of [
    [uOwn, TP, "own"], [uBill, TP, "bill"], [uSign, TP, "sign"], [uRead, TP, "read"],
    [uAn, TP, "an"], [uAud, TP, "aud"], [uDir, TP, "dir"], [uMan, TP, "man"],
    [uEst, TX, "est"], [uClerk, CO1, "clerk"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  const asOwn = { ck: ck("own") };
  const asBill = { ck: ck("bill") };
  const asSign = { ck: ck("sign") };
  const asRead = { ck: ck("read") };
  const asAn = { ck: ck("an") };
  const asAud = { ck: ck("aud") };
  const asDir = { ck: ck("dir") };
  const asMan = { ck: ck("man") };
  const asEst = { ck: ck("est") };
  const asClerk = { ck: ck("clerk") };

  const TODAY = new Date().toISOString().slice(0, 10);
  const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  /** The office's own rung has no company and no plan to be filed under, so the register spells the one
   *  place the nil lives (`platform_auth.commission_subject_key`) and files it there. A desk that read
   *  the column as a word would be reading a name the row never carried. */
  const NIL = "00000000-0000-0000-0000-000000000000";

  // The papers a cut is taken against. `invoices` and `freight_invoices` are 142's two money-shaped
  // registers, and a fresh one per run is what makes the double-count refusal a real refusal.
  let invN = 0;
  const freight = async (total: string, currency: string, status: string, whose: string) => {
    invN++;
    return (await one(`insert into freight_invoices (tenant_id, invoice_number, customer_name, total,
        currency, status, issue_date)
      values ($1,$2,'Kiliamanji Traders', $3, $4, $5, $6) returning id`,
      [whose, `PRC-142-${STAMP}-${invN}`, total, currency, status, TODAY])).id;
  };
  const invoiceTZS = await freight("1000000", "TZS", "sent", CO1);
  const invoiceUSD = await freight("10000", "USD", "sent", CO1);
  const invoiceEmpty = await freight("0", "TZS", "sent", CO1);
  const invoiceDead = await freight("500000", "TZS", "cancelled", CO1);
  const invoiceSecond = await freight("2000000", "TZS", "sent", CO2);

  const sweep = async () => {
    // The register's own order, backwards, and it stops exactly where the guards start. A draft that never
    // carried a paper and never went live is thrown away, and its memory lines go first: `rate_id` has no
    // cascade, and 142 lets a history row out only while the agreement under it is still an unsigned draft.
    // Everything else is kept on purpose. A reading cannot be deleted at all — `pricing_commission_readings_are_kept`
    // raises on every DELETE, because a wrong figure is answered by a void and a new reading — and a raw
    // update that un-pointed a paper from its agreement would fake the one thing this register exists to
    // keep. So this run leaves its signature, its readings and 133's movements standing, and every absolute
    // count below is read off SQL for this book rather than hard-coded.
    const books = [...new Set([TP, TX, CO1, CO2])];
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [books]))
      .rows.map((x: any) => x.id);
    const pinned = await one(`select
        array_agg(distinct x) as ids from (
          select created_by as x from pricing_commission_rates where tenant_id = any($1::uuid[])
          union select updated_by from pricing_commission_rates where tenant_id = any($1::uuid[])
          union select published_by from pricing_commission_rates where tenant_id = any($1::uuid[])
          union select withdrawn_by from pricing_commission_rates where tenant_id = any($1::uuid[])
          union select assessed_by from pricing_commission_assessments where tenant_id = any($1::uuid[])
          union select discharged_by from pricing_commission_assessments where tenant_id = any($1::uuid[])
          union select voided_by from pricing_commission_assessments where tenant_id = any($1::uuid[])
          union select actor_user_id from pricing_commission_history where tenant_id = any($1::uuid[])
          union select raised_by from money_postings where tenant_id = any($1::uuid[])
          union select frozen_by from money_accounts where tenant_id = any($1::uuid[])
        ) s where x is not null`, [books]);
    // 121's register carries no book on it, so a paper belongs to this run only through the row it names.
    const paperSeats = (await oi(`select proposed_by as pr, decided_by as dc from platform_approvals
        where action = 'pricing.commission' and target_id in
          (select id::text from pricing_commission_rates where tenant_id = any($1::uuid[]))`,
      [books])).rows.flatMap((x: any) => [x.pr, x.dc].filter(Boolean).map(String));
    const keep = new Set<string>([...(pinned?.ids ?? []).map(String), ...paperSeats]);
    const drafts = (await oi(`select id from pricing_commission_rates where tenant_id = any($1::uuid[])
        and published_at is null and approval_id is null and status = 'draft'`, [books]))
      .rows.map((x: any) => String(x.id));
    if (drafts.length) {
      await oi(`delete from pricing_commission_history where rate_id = any($1::uuid[])`, [drafts]);
      await oi(`delete from pricing_commission_rates where id = any($1::uuid[])`, [drafts]);
    }
    // A paper whose agreement is gone is this run's own litter; one whose agreement still stands is the
    // register's proof that somebody was asked to sign, and it stays.
    await oi(`delete from platform_approvals a where a.action = 'pricing.commission'
      and a.proposed_by = any($1::uuid[]) and not exists
      (select 1 from pricing_commission_rates r where r.id::text = a.target_id)`,
      [uids.length ? uids : [randomUUID()]]);
    await oi(`delete from freight_invoices where tenant_id = any($1::uuid[])`, [[CO1, CO2]]);
    await oi(`delete from subscriptions where tenant_id = any($1::uuid[])`, [[CO1, CO2]]);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from roles where id = $1`, [ROLE_MANAGE_ONLY]);
    const deletable = uids.filter((u: string) => !keep.has(u) && ![uOwn, uBill, uSign].includes(u));
    for (const u of deletable) await oi(`delete from users where id = $1`, [u]).catch(() => undefined);
    for (const t of [TX, CO1, CO2]) {
      await oi(`delete from tenants where id = $1`, [t]).catch(() => undefined);
    }
    await oi(`delete from plans where id = $1`, [PLAN]).catch(() => undefined);
    await oi(`delete from rate_limits where bucket ~ '^(cut|readings-board|pricing)'`);
  };

  // The sweep runs once, at teardown: called here it would delete the fixtures it was just given, and an
  // earlier run's residue is already gone — `preClean` took it by name before any of this was written.
  const T0 = Date.now();

  const openCut = (who: string, body: any) => call("/control/pricing/cuts", {
    ck: ck(who), method: "POST",
    body: {
      subject_kind: "platform", source_kind: "freight_invoice", basis: "percent_of_amount",
      value: "7.5", effective_from: TODAY,
      note: `${MARK} · The office's own standing cut on a freight invoice, agreed for a year.`,
      ...body
    }
  });

  // ---------------- 2. the doors are shut ----------------
  phase("142's eighteen doors take the pricing desk's three duties, and 133's pen for the pointer");
  let r = await call("/control/pricing/cuts");
  check("a cut board with no session is 401, not an empty board", r.status === 401,
    { s: r.status, w: words(r) });

  const READS: [string, string][] = [
    ["/control/pricing/cuts", "GET"], ["/control/pricing/cuts/choices?kind=company", "GET"],
    ["/control/pricing/readings", "GET"], ["/control/pricing/summary", "GET"]
  ];
  for (const [path] of READS) {
    r = await call(path);
    check(`${path.split("?")[0]} is shut to an anonymous desk`, r.status === 401, { s: r.status });
  }
  const WRITES: [string, any][] = [
    ["/control/pricing/cuts", { subject_kind: "platform", source_kind: "freight_invoice",
      basis: "percent_of_amount", value: "1", note: "An anonymous opening of a cut." }],
    ["/control/pricing/readings", { source_kind: "freight_invoice", source_id: invoiceTZS }],
    ["/control/pricing/cuts/00000000-0000-0000-0000-000000000000/discard",
      { reason: "An anonymous discard of a draft." }],
    ["/control/pricing/cuts/00000000-0000-0000-0000-000000000000/publish",
      { reason: "An anonymous request for a signature." }],
    ["/control/pricing/readings/00000000-0000-0000-0000-000000000000/void",
      { reason: "An anonymous cancellation of a cut." }]
  ];
  for (const [path, body] of WRITES) {
    r = await call(path, { method: "POST", body });
    check(`${path.split("/pricing/")[1]} refuses to write without a seat`, r.status === 401,
      { s: r.status });
  }
  r = await call("/control/pricing/cuts", asClerk);
  check("a company's clerk never reaches the cut desk at all: 099's session guard answers before the "
    + "register is named, which is why the door's own `not_a_seat` is not reachable over HTTP",
    r.status === 401, { s: r.status, w: words(r) });

  for (const [path, method, body] of [
    ["/control/pricing/cuts", "GET", undefined], ["/control/pricing/readings", "GET", undefined],
    ["/control/pricing/summary", "GET", undefined],
    ["/control/pricing/cuts", "POST", { subject_kind: "platform", source_kind: "freight_invoice",
      basis: "percent_of_amount", value: "1", note: "A director opening a cut." }],
    ["/control/pricing/readings", "POST", { source_kind: "freight_invoice", source_id: invoiceTZS }]
  ] as [string, string, any][]) {
    r = await call(path, { ck: ck("dir"), method, body });
    check(`a seat holding no pricing duty is refused ${method} ${path}`, r.status === 403,
      { s: r.status, w: words(r) });
  }

  for (const [path, method, body] of [
    ["/control/pricing/cuts", "POST", { subject_kind: "platform", source_kind: "freight_invoice",
      basis: "percent_of_amount", value: "1", note: "A reader opening a cut." }],
    ["/control/pricing/readings", "POST", { source_kind: "freight_invoice", source_id: invoiceTZS }],
    ["/control/pricing/readings/00000000-0000-0000-0000-000000000000/void", "POST",
      { reason: "A reader cancelling a cut that is not theirs to cancel." }],
    ["/control/pricing/cuts/00000000-0000-0000-0000-000000000000/withdraw", "POST",
      { effective_to: TOMORROW, reason: "A reader stopping an agreement." }],
    ["/control/pricing/cuts/00000000-0000-0000-0000-000000000000/discard", "POST",
      { reason: "A reader throwing a draft away." }],
    ["/control/pricing/cuts/00000000-0000-0000-0000-000000000000/clone", "POST",
      { effective_from: TOMORROW }],
    ["/control/pricing/cuts/00000000-0000-0000-0000-000000000000", "PATCH",
      { value: "3" }]
  ] as [string, string, any][]) {
    for (const who of ["read", "an", "aud"]) {
      r = await call(path, { ck: ck(who), method, body });
      if (r.status !== 403) break;
    }
    check(`a seat with the read and not the pen is refused the ${method} on `
      + `${path.replace("/control/pricing", "")} by all three readers`, r.status === 403,
      { s: r.status, w: words(r) });
  }
  for (const who of ["read", "an", "aud"]) {
    r = await call(`/control/pricing/cuts?limit=5`, { ck: ck(who) });
    if (r.status !== 200) break;
  }
  check("…and the same three seats are handed the board: reading a cut is a duty of its own, and they "
    + "hold it", r.status === 200 && Array.isArray(r.json?.rows), { s: r.status });

  // ---------------- 3. the shape of a figure, before the register is asked ----------------
  phase("what the shapes refuse, and what only the register could refuse");
  r = await openCut("own", { value: "7.55555" });
  check("five decimals on a percent is 142's own rule with the field named: a cut is `numeric(14,4)` and "
    + "a desk that rounds silently changes the sum", r.status === 400 && /value/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await openCut("own", { basis: "flat", value: "30000", currency: "EUR" as any });
  check("a money outside 133's pair is refused by the shape, so the register is never asked to keep a "
    + "cut it cannot sum", r.status === 400 && /currency/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCut("own", { basis: "flat", value: "30000", currency: undefined });
  check("a flat cut with no money named is refused beside the field that is empty, not after a row "
    + "exists with nothing to sum", r.status === 400 && /flat cut has to be named/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await openCut("own", { basis: "percent_of_amount", value: "7.5", currency: "TZS" });
  check("a percentage that carries a money is refused the other way round: a percent is worked in the "
    + "transaction's own money", r.status === 400 && /carries none/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await openCut("own", { subject_kind: "tenant", subject_tenant: undefined });
  check("a cut agreed with a company has to say which company, and the desk is told before a draft "
    + "files under nobody", r.status === 400 && /subject_tenant/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await openCut("own", { subject_kind: "platform", subject_tenant: CO1 });
  check("the office's own standing cut names no company: the pair is refused here so the register's "
    + "`two_subjects` never has to write a row first", r.status === 400 && /names no company/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await openCut("own", { subject_kind: "company" });
  check("a rung spelled the way a clerk speaks it is refused by the register rather than by the shape: "
    + "`company` is not one of the three words the ladder walks, and the door answers with the words it "
    + "does keep and the one it was asked — no `142:` prefix reaches the desk",
    r.status === 400 && code(r) === "VALIDATION_FAILED"
    && /the words the ladder walks: tenant, plan, platform/i.test(words(r))
    && /asked:company/.test(words(r)) && /142:/.test(words(r)) === false,
    { s: r.status, c: code(r), w: words(r) });

  r = await openCut("own", { source_kind: "invoice" });
  check("a transaction 142 does not keep is answered by the register in its own words, naming the five "
    + "it does", r.status === 400 && /freight_invoice|five|transaction/i.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  r = await openCut("own", { effective_from: "2026-02-30" });
  check("a shape-only date is caught before Postgres answers a 22007 nobody can read",
    r.status === 400 && /There is no day 2026-02-30/.test(words(r)), { s: r.status, w: words(r) });

  r = await openCut("own", { value: "140" });
  check("a cut over 100 per cent is the register's refusal, and it says what 140 would take: the "
    + "transaction and the difference", r.status === 400 && code(r) === "VALIDATION_FAILED"
    && /is not a percentage/.test(words(r)) && /asked:140/.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/cuts/${randomUUID()}`, asOwn);
  check("an agreement id that is a real uuid but is not this book's is a 404, not a typing error: the "
    + "register's own sentence names the paper to quote, so the desk looks for it instead of retyping it",
    r.status === 404 && code(r) === "NOT_FOUND" && /no commission agreement/i.test(words(r))
    && /CMR/.test(words(r)), { s: r.status, c: code(r), w: words(r) });
  r = await call(`/control/pricing/cuts/not-a-uuid`, asOwn);
  check("…and a malformed one is a 400 that says which id it is talking about",
    r.status === 400 && /agreement/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts?limit=500`, asOwn);
  check("a page of 500 agreements is refused by the shape: the board's cap is 200 and a desk that asks "
    + "for the book asks for the board", r.status === 400, { s: r.status });

  r = await call(`/control/pricing/cuts?status=published%20or%201=1`, asOwn);
  check("a filter word with a space in it is refused rather than read as a word the register knows",
    r.status === 400, { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts?status=PUBLISHED`, asOwn);
  check("a desk that spells a state in capitals is answered, because the register lower-cases its own "
    + "filter words before it checks them", r.status === 200, { s: r.status });

  r = await call(`/control/pricing/cuts/choices?kind=vehicles`, asOwn);
  check("a list the register does not keep is refused in the door's own words, naming the ten it does — "
    + "there is no list of words inside the route file to fall back on",
    r.status === 400 && /company|plan|driver/i.test(words(r)), { s: r.status, c: code(r), w: words(r) });

  // ---------------- 4. opening, editing and reading a draft ----------------
  phase("a draft is opened in the office's book and read back out of it");
  r = await openCut("read", {});
  check("opening a cut is the pen, not the read", r.status === 403, { s: r.status, w: words(r) });

  const rungA = await rungVersion(NIL, "freight_invoice");
  r = await openCut("own", { value: "7.5", note: `${MARK} · The office's own standing cut on a freight `
    + "invoice, agreed for a year." });
  const rateA = agreeOf(r.json)?.id;
  check("the office's standing cut on a freight invoice opens as a draft, and the door hands the whole "
    + "agreement back rather than a bare id — on the rung number the ladder was actually sitting on",
    r.status === 200 && String(agreeOf(r.json)?.status) === "draft"
    && Number(agreeOf(r.json)?.version) === rungA && agreeOf(r.json)?.ref?.startsWith("CMR-"),
    { s: r.status, v: agreeOf(r.json)?.version, want: rungA });

  const dbA = await rateRow(String(rateA));
  check("the row is the office's, on the rung the register calls `platform`, and the name on it is the "
    + "one the guard copied — not the one a desk typed. A rung with no company and no plan to file under "
    + "is filed under the nil the register spells itself",
    String(dbA.tenant_id) === TP && dbA.subject_kind === "platform" && String(dbA.subject_key) === NIL
    && dbA.subject_name === "The office's own cut" && dbA.subject_tenant_id === null
    && dbA.source_kind === "freight_invoice" && dbA.payee_kind === "platform",
    { t: dbA.subject_kind, k: dbA.subject_key, n: dbA.subject_name, p: dbA.payee_kind });
  check("…and the figure is kept as the register prints it, in the money a percentage has none of",
    dbA.basis === "percent_of_amount" && dbA.value === "7.5000" && dbA.currency === null
    && String(dbA.created_by) === uOwn && dbA.from_day === TODAY,
    { v: dbA.value, c: dbA.currency, f: dbA.from_day });

  r = await openCut("own", { subject_kind: "tenant", subject_tenant: CO1, value: "2",
    note: `${MARK} · A cut negotiated with this company alone, and the reason the plan's rung never `
      + "reaches it." });
  const rateB = agreeOf(r.json)?.id;
  const dbB = await row("pricing_commission_rates", String(rateB));
  check("a negotiated cut copies the company's own name and key onto the row, so the register can be "
    + "read by a desk that never looked at the tenant table",
    r.status === 200 && dbB.subject_kind === "tenant" && String(dbB.subject_tenant_id) === CO1
    && dbB.subject_name === `PR Commission Company ${STAMP}` && dbB.value === "2.0000",
    { s: r.status, k: dbB.subject_key, n: dbB.subject_name });

  r = await openCut("own", { subject_kind: "plan", subject_plan: PLAN, source_kind: "subscription_invoice",
    value: "2.5", floor: "30000",
    note: `${MARK} · A cut every company on this plan inherits, with a floor.` });
  const rateC = agreeOf(r.json)?.id;
  const dbC = await rateRow(String(rateC));
  check("a plan rung names the plan — under the rung, so a board that lists a company's cuts and the "
    + "plan's cuts side by side cannot show two rows with the same words — and keeps its floor as a "
    + "figure in the office's money",
    r.status === 200 && dbC.subject_kind === "plan" && String(dbC.subject_plan_id) === PLAN
    && dbC.subject_name === "Plan: Growth, cut smoke" && dbC.source_kind === "subscription_invoice"
    && dbC.floor_amount === "30000.00", { s: r.status, n: dbC.subject_name, f: dbC.floor_amount });

  const beforeGhost = await seqRates();
  r = await openCut("own", { subject_kind: "tenant", subject_tenant: randomUUID(), value: "3",
    note: "A cut agreed with a company the register does not have." });
  const ghostSpend = (await seqRates()) - beforeGhost;
  check("a negotiated cut against an id that is not a company is refused before a row exists: the "
    + "agreement would be filed under nobody, and the register's own words — not a 404 that blames the "
    + "door — are what the desk hears",
    r.status === 400 && code(r) === "VALIDATION_FAILED" && /no company .{0,60} to agree a cut with/i
    .test(words(r)), { s: r.status, c: code(r), w: words(r) });
  check("…and it is refused while the row is being formed, not before it: the company's name is copied "
    + "onto the agreement by `pricing_commission_names_its_book`, the one place 142 checks every identity, "
    + "and a BEFORE INSERT trigger answers after the tuple — and with it the reference number — is built. "
    + "So this is the run's one gap in the numbering, and the census at the end ties it back",
    ghostSpend === 1, { spent: ghostSpend });

  r = await call(`/control/pricing/cuts/${rateC}`, { ck: ck("own"), method: "PATCH", body: {} });
  check("an empty patch is refused: a no-op that audits itself is a register full of edits nobody made",
    r.status === 400 && /which part changes/i.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateC}`, { ck: ck("own"), method: "PATCH",
    body: { value: "4", floor: "30000", clear: ["floor_amount"] } });
  check("a floor is either given a figure or emptied, and the door says so before the register is asked",
    r.status === 400 && /either given a figure or cleared/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateC}`, { ck: ck("bill"), method: "PATCH",
    body: { value: "3.25" } });
  check("a patch that names one figure keeps the rest of the paper: the rung, the transaction, the "
    + "basis and the ceiling are what the row already held",
    r.status === 200 && agreeOf(r.json)?.value === "3.2500" && agreeOf(r.json)?.basis === "percent_of_amount"
    && agreeOf(r.json)?.source_kind === "subscription_invoice" && agreeOf(r.json)?.floor_amount === "30000.00",
    { s: r.status, a: agreeOf(r.json) });

  r = await call(`/control/pricing/cuts/${rateC}`, { ck: ck("own"), method: "PATCH",
    body: { clear: ["floor_amount", "effective_to"] } });
  check("clearing a column is a write the desk can make without throwing the draft away",
    r.status === 200 && agreeOf(r.json)?.floor_amount === null, { s: r.status, f: agreeOf(r.json)?.floor_amount });

  r = await call(`/control/pricing/cuts/${rateC}`, { ck: ck("own"), method: "PATCH",
    body: { basis: "flat" } });
  check("the basis is not a field a desk edits: the shape refuses the key, because a percentage and a "
    + "flat sum are two promises and a signature cannot be made to cover both",
    r.status === 400 && /basis/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateC}`, { ck: ck("own"), method: "PATCH",
    body: { subject_tenant: CO2 } });
  check("…and neither is the subject: a desk cannot move a cut from one company to another after the "
    + "fact and leave a signed paper pointing at somebody else",
    r.status === 400 && /subject_tenant/.test(words(r)), { s: r.status, w: words(r) });

  const dbC2 = await rateRow(String(rateC));
  check("the edit is on the row and the seat that made it is the one the register wrote",
    dbC2.value === "3.2500" && dbC2.floor_amount === null && String(dbC2.updated_by) === uOwn,
    { v: dbC2.value, f: dbC2.floor_amount, u: String(dbC2.updated_by) });

  r = await call(`/control/pricing/cuts/${rateA}`, asAn);
  check("the detail prints the agreement under `rate` with the rung's own words inside it, and the hash a "
    + "second seat would sign, while the paper is still nothing",
    r.status === 200 && r.json?.rate?.id === rateA
    && /7.5%/.test(String(agreeOf(r.json)?.said ?? "")) && /^[0-9a-f]{64}$/.test(String(r.json?.paper_sha256))
    && r.json?.approval === null && r.json?.memory?.length === 1 && r.json?.readings?.length === 0,
    { s: r.status, said: agreeOf(r.json)?.said, sha: r.json?.paper_sha256, ap: r.json?.approval,
      mem: r.json?.memory });

  r = await call(`/control/pricing/cuts/${rateA}/history`, asRead);
  check("opening a draft is itself a decision the register remembers: one line, `state`, nothing into "
    + "`draft` — a signature has not been spent yet, but the figure's author has",
    r.status === 200 && r.json?.total === 1 && r.json?.rows?.[0]?.what === "state"
    && r.json?.rows?.[0]?.new_value === "draft" && r.json?.rows?.[0]?.old_value === null,
    { s: r.status, t: r.json?.total, rows: r.json?.rows?.map((x: any) => `${x.what}:${x.new_value}`) });

  const boardCounts = await one(`select
      count(*) filter (where status = 'draft')::int as draft,
      count(*) filter (where status = 'published')::int as published,
      count(*) filter (where status = 'pending_signature')::int as pending_signature,
      count(*) filter (where status = 'withdrawn')::int as withdrawn,
      count(*)::int as all FROM pricing_commission_rates WHERE tenant_id = $1`, [TP]);
  r = await call(`/control/pricing/cuts?limit=50&search=${MARK}`, asOwn);
  check("the board answers with its own pile counts keyed per state — the book's whole piles, not the "
    + "page's — and the rung and transaction vocabularies ride with them so a second read is not needed "
    + "to fill a picker",
    r.status === 200 && r.json?.total === 3 && r.json?.counts?.draft === boardCounts.draft
    && r.json?.subjects?.length === 3 && r.json?.sources?.length === 5
    && r.json?.rows?.find((x: any) => x.id === rateA)?.subject_name === "The office's own cut",
    { s: r.status, t: r.json?.total, c: r.json?.counts, sql: boardCounts,
      sub: r.json?.subjects?.length, src: r.json?.sources?.length });

  r = await call(`/control/pricing/cuts?subject=platform&source=freight_invoice&search=${MARK}`, asOwn);
  check("the board filters by rung and by transaction from the same call, and the counts stay the "
    + "book's rather than the page's",
    r.status === 200 && r.json?.total === 1 && r.json?.counts?.draft === boardCounts.draft
    && r.json?.rows?.[0]?.id === rateA, { s: r.status, t: r.json?.total, c: r.json?.counts });

  // ---------------- 5. the preview, which invents nothing ----------------
  phase("the preview answers a question with the register's own reading of it");
  r = await call(`/control/pricing/cuts/ask?source=freight_invoice&source_id=${invoiceTZS}`, asRead);
  check("with no agreement in force the preview answers honestly rather than at zero: `no_rate` with a "
    + "figure of nothing and the three rungs it walked, printed inside the resolver's own refusal",
    r.status === 200 && r.json?.answer === "no_rate" && r.json?.figure === null
    && r.json?.rate?.error === "no_rate" && Array.isArray(r.json?.rate?.ladder)
    && r.json?.rate?.ladder?.length === 3 && r.json?.source?.ref?.startsWith("PRC-142-"),
    { s: r.status, a: r.json?.answer, f: r.json?.figure, l: r.json?.rate?.ladder });

  r = await call(`/control/pricing/cuts/ask?company=${CO2}&source=freight_invoice&source_id=${invoiceTZS}`,
    asOwn);
  check("asking the preview about a paper that belongs to somebody else is refused rather than answered "
    + "with the wrong rung — and 142 sends it as a 400, because the desk asked the wrong question",
    r.status === 400 && code(r) === "VALIDATION_FAILED" && /another company/.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/cuts/ask?source=freight_invoice&source_id=${randomUUID()}`, asOwn);
  check("a transaction the register does not keep is a 404: a reading of a nothing is a row nobody owes",
    r.status === 404 && code(r) === "NOT_FOUND" && /no freight invoice/i.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/cuts/ask?source=subscription_invoice&source_id=${invoiceTZS}`, asOwn);
  check("…and a uuid that is real but is not the transaction named is refused as the wrong paper, not "
    + "answered with the freight figure", r.status === 404 && /no subscription invoice/i.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  // ---------------- 6. the pen that is not the signature ----------------
  phase("publishing is a duty of its own, and the desk that has the pen does not have it");
  r = await call(`/control/pricing/cuts/${rateA}/publish`, { ck: ck("man"), method: "POST",
    body: { reason: "A manage-only seat asking for a signature." } });
  check("putting an agreement up for a signature is the publish duty, not the manage duty — the split "
    + "no existing global role tests, so this run minted one to prove it",
    r.status === 403, { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateA}/refuse`, { ck: ck("man"), method: "POST",
    body: { note: "A manage-only seat answering a paper." } });
  check("…and refusing a paper is the same duty, so a pen cannot undo somebody else's errand",
    r.status === 403, { s: r.status, w: words(r) });

  r = await call(`/control/pricing/readings/${randomUUID()}/discharge`, { ck: ck("man"), method: "POST",
    body: { carrier_kind: "posting", carrier_id: randomUUID(), note: "A pen with no ledger duty." } });
  check("saying a cut has been carried needs 133's duty as well as the pricing one: the hand that may "
    + "claim the book already moved is the hand that may move it", r.status === 403,
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateA}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "Seven and a half per cent on every freight invoice the office touches. Put it in force." } });
  const paperA = String(r.json?.approval_id ?? "");
  check("the draft is put up as 142's own effect, on the agreement's own kind, and the paper is cut on "
    + "the bytes the register holds", r.status === 200 && r.json?.action === "pricing.commission"
    && r.json?.target_kind === "pricing_commission_rate" && String(r.json?.target_id) === rateA
    && /^[0-9a-f]{64}$/.test(String(r.json?.payload_sha256)),
    { s: r.status, a: r.json?.action, t: r.json?.target_kind, sha: r.json?.payload_sha256 });

  const detailA = agreeOf(r.json);
  check("…and the door hands the agreement back as its envelope's own `rate`, one level deeper than the "
    + "read doors put it: the desk reads both, and a gate that guessed one path read `undefined`",
    String(detailA?.id) === rateA && detailA?.status === "pending_signature"
    && detailA?.ref === dbA.ref, { s: r.status, d: detailA });

  const dbPaperA = await row("platform_approvals", paperA);
  check("121's register holds the paper: pending, raised by the seat that typed the reason, cut on the "
    + "same hash the detail door prints",
    dbPaperA.action === "pricing.commission" && dbPaperA.status === "pending"
    && String(dbPaperA.proposed_by) === uBill && String(dbPaperA.payload_sha256) === r.json?.payload_sha256
    && String(dbPaperA.payload?.value) === "7.5000",
    { a: dbPaperA.status, p: String(dbPaperA.proposed_by), v: dbPaperA.payload });

  r = await call(`/control/pricing/cuts/${rateA}`, asRead);
  check("the paper the seat is shown names the figure as the register keeps it: `numeric(14,4)` prints "
    + "seven and a half as 7.5000, and the bytes the second seat is asked to sign are the same bytes "
    + "121 cut the paper on — 121's register has no number of its own, so the desk quotes the paper by "
    + "its id",
    r.status === 200 && String(r.json?.paper?.value) === "7.5000"
    && String(r.json?.approval?.status) === "pending"
    && String(r.json?.approval?.id) === paperA
    && String(r.json?.approval?.action) === "pricing.commission"
    && String(r.json?.approval?.proposed_by) === "Commission Bill"
    && String(r.json?.paper_sha256) === String(r.json?.approval?.payload_sha256),
    { s: r.status, paper: r.json?.paper, ap: r.json?.approval, sha: r.json?.paper_sha256 });

  r = await call(`/control/pricing/cuts/${rateA}`, { ck: ck("own"), method: "PATCH", body: { value: "8" } });
  check("a signed draft cannot have its figure moved by the desk: the signature is cut on the bytes the "
    + "patch is about to change, and the refusal names the paper to be refused first",
    r.status === 409 && code(r) === "CONFLICT" && /waiting for a second seat/.test(words(r))
    && words(r).includes(String(dbA.ref)), { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/cuts/${rateA}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "Asking a second seat to sign a paper that is already out." } });
  check("one signature stands per version: a second raise hands the open paper back rather than minting "
    + "another seat's errand", r.status === 409 && /already waiting for a second seat/.test(words(r))
    && words(r).includes(paperA), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateA}/discard`, { ck: ck("own"), method: "POST",
    body: { reason: "Throwing away a draft that somebody was asked to sign." } });
  check("a paper that was put up for a signature cannot be thrown away: the draft is not the desk's to "
    + "delete while a second seat is reading it", r.status === 409 && code(r) === "CONFLICT"
    && /kept|Approvals/.test(words(r)), { s: r.status, c: code(r), w: words(r) });

  // A second paper, raised and refused, so both halves of the signature are met over HTTP.
  r = await call(`/control/pricing/cuts/${rateB}/publish`, { ck: ck("own"), method: "POST",
    body: { reason: "Two per cent, negotiated, and the office would rather sign it than assume it." } });
  const paperB = String(r.json?.approval_id ?? "");
  check("a second draft goes up on its own paper, raised by the other seat",
    r.status === 200 && /^[0-9a-f]{8}-/.test(paperB), { s: r.status });

  r = await call(`/control/pricing/cuts/${rateB}/refuse`, { ck: ck("own"), method: "POST",
    body: { note: "Answering a paper I raised myself." } });
  check("the seat that raised a paper cannot be the seat that answers it: 121's check, arriving through "
    + "142's door as `refused_the_signature_first` and nothing changed — the register's own sentence, not "
    + "a paraphrase of the rule",
    r.status === 409 && /was not answered/.test(words(r))
    && /cannot be the one that signs it/i.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  const dbB1 = await rateRow(String(rateB));
  check("…and the refusal that failed left the row exactly where it was: still waiting, still holding "
    + "its paper, refusals unmoved", dbB1.status === "pending_signature"
    && String(dbB1.approval_id) === paperB && Number(dbB1.refusals) === 0,
    { s: dbB1.status, a: String(dbB1.approval_id), r: dbB1.refusals });

  // The same seat holds the signature duty, so this is the two-person rule with nothing else in the way:
  // 121 checks the paper's state before it checks who is asking, and a pending paper reaches the check
  // that matters.
  r = await call(`/control/approvals/${paperB}/approve`, { ck: ck("own"), method: "POST",
    body: { note: "Signing the paper I raised myself." } });
  check("the seat that raised a paper cannot sign it either: 121 answers `self` and the approvals door "
    + "gives it its own code rather than dressing it as a duty refusal",
    r.status === 403 && code(r) === "SELF_APPROVAL"
    && /cannot be the one that signs it/i.test(words(r)), { s: r.status, c: code(r), w: words(r) });

  const dbB1b = await rateRow(String(rateB));
  const dbPaperB1 = await row("platform_approvals", paperB);
  check("…and a signature refused for its own author spends nothing: the draft still waits, the paper is "
    + "still open, and no seat has been recorded against it",
    dbB1b.status === "pending_signature" && String(dbB1b.approval_id) === paperB
    && dbPaperB1.status === "pending" && dbPaperB1.decided_by === null
    && dbPaperB1.applied_at === null,
    { s: dbB1b.status, p: dbPaperB1.status, d: String(dbPaperB1.decided_by) });

  r = await call(`/control/pricing/cuts/${rateB}/refuse`, { ck: ck("bill"), method: "POST",
    body: { note: "Two per cent on a negotiated paper is not what the office promised this company." } });
  check("a refusal answers the signature first and frees the draft second, in one call, and hands back "
    + "the count the desk prints beside the next attempt",
    r.status === 200 && Number(r.json?.refusals) === 1 && agreeOf(r.json)?.status === "draft",
    { s: r.status, ref: r.json?.refusals, st: agreeOf(r.json)?.status });

  const dbB2 = await rateRow(String(rateB));
  const dbPaperB = await row("platform_approvals", paperB);
  check("the row is a draft again and still carries the paper's number, and the paper itself is "
    + "rejected on the register with the words the second seat typed",
    dbB2.status === "draft" && String(dbB2.approval_id) === paperB && Number(dbB2.refusals) === 1
    && dbPaperB.status === "rejected" && String(dbPaperB.decided_by) === uBill,
    { s: dbB2.status, r: dbB2.refusals, p: dbPaperB.status });

  r = await call(`/control/pricing/cuts/${rateB}/refuse`, { ck: ck("bill"), method: "POST",
    body: { note: "Refusing a paper that is not standing." } });
  check("a draft with no signature standing on it cannot be refused: the answer names the state it "
    + "found instead of pretending a second no was recorded",
    r.status === 409 && /No signature is standing/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateB}/history`, asRead);
  const bLines = (r.json?.rows ?? []).map((x: any) => `${x.what}:${x.old_value ?? ""}->${x.new_value}`);
  check("every state the version passed through is still standing in the memory, newest first: refused "
    + "back to a draft, put up for a signature, opened as a draft — three lines a dispute reads from the "
    + "end it stopped at",
    r.status === 200 && r.json?.total === 3 && bLines.join(" ")
      .includes("state:pending_signature->draft state:draft->pending_signature state:->draft"),
    { s: r.status, t: r.json?.total, rows: bLines });

  const stateLines = (r.json?.rows ?? []).map((x: any) =>
    `${x.what}:${x.old_value ?? ""}->${x.new_value}`);
  check("…and the memory keeps the money a draft never named: a percentage's line carries no currency, "
    + "because a percent is worked in the transaction's own",
    r.json?.total === 3 && stateLines.filter((s: string) => /->draft$/.test(s)).length === 2
    && stateLines.filter((s: string) => s === "state:draft->pending_signature").length === 1
    && (r.json?.rows ?? []).every((x: any) => x.currency === null),
    { t: r.json?.total, lines: stateLines, cur: (r.json?.rows ?? []).map((x: any) => x.currency) });

  r = await call(`/control/pricing/cuts/${rateB}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "A refused draft goes up again: the second seat's no is answered by a new figure." } });
  check("a refused draft is not a wall: the dead paper is not a lock on the row, and the register says "
    + "so by letting the next version be put up", r.status === 200
    && /^[0-9a-f]{8}-/.test(String(r.json?.approval_id ?? "")), { s: r.status, w: words(r) });
  const paperB2 = String(r.json?.approval_id ?? "");

  // ---------------- 7. the two seats, over HTTP ----------------
  phase("the second seat signs on Approvals, and the effect runs in the register's own order");
  r = await call(`/control/approvals/${paperA}/approve`, { ck: ck("bill"), method: "POST",
    body: { note: "A pricing seat with no signature duty trying to spend one." } });
  check("a seat that can raise a cut's paper but cannot sign the register is refused at the approvals "
    + "door: the two halves of the rule are two duties, and 142 does not fold them",
    r.status === 403 && code(r) === "FORBIDDEN", { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/approvals/${paperA}/approve`, { ck: ck("sign"), method: "POST",
    body: { note: "The office's standing cut, signed." } });
  check("one approve by a second seat publishes: 121's own order — decide, claim, apply, settle — runs "
    + "inside one transaction, and the receipt is the register's, not a paraphrase",
    r.status === 200 && String(r.json?.ref) === dbA.ref && r.json?.value === "7.5000"
    && r.json?.subject_kind === "platform" && String(r.json?.approval_id) === paperA
    && String(r.json?.published_by) === uSign && r.json?.source_kind === "freight_invoice",
    { s: r.status, j: r.json });

  const dbA2 = await rateRow(String(rateA));
  const dbPaperA2 = await row("platform_approvals", paperA);
  check("the agreement is live on its own row: published, dated, signed for by the seat that spent the "
    + "signature, and still naming the paper it was spent on",
    dbA2.status === "published" && dbA2.published_day === TODAY && String(dbA2.published_by) === uSign
    && String(dbA2.approval_id) === paperA, { s: dbA2.status, p: dbA2.published_day, b: dbA2.published_by });
  // 121's register has no "claimed by" column: a paper that ran says so by the stamp its effect left —
  // `applied_at` and the `result` the effect answered with. Inventing a column would have been the easy
  // way to make this line pass, and the easy way proves nothing.
  check("…and the paper is spent rather than merely answered: 121 settled it, applied it and kept the "
    + "receipt the effect handed back, all in the one transaction the seat's call ran in",
    dbPaperA2.status === "applied" && String(dbPaperA2.decided_by) === uSign
    && dbPaperA2.applied_at !== null && Object.keys(dbPaperA2.result ?? {}).length > 0
    && String(dbPaperA2.result?.ref ?? "") === dbA.ref,
    { s: dbPaperA2.status, d: String(dbPaperA2.decided_by), a: String(dbPaperA2.applied_at),
      r: dbPaperA2.result });

  r = await call(`/control/pricing/cuts/${rateA}`, asAn);
  check("the detail now prints the signature it carries: the paper, the hash, the seat that signed and "
    + "the day it rules from",
    r.status === 200 && r.json?.rate?.status === "published"
    && String(r.json?.approval?.status) === "applied"
    && String(r.json?.approval?.decided_by ?? "").length > 0
    && /^[0-9a-f]{64}$/.test(String(r.json?.paper_sha256))
    && String(r.json?.paper_sha256) === String(dbPaperA2.payload_sha256),
    { s: r.status, ap: r.json?.approval, sha: r.json?.paper_sha256 });

  r = await call(`/control/pricing/cuts/${rateA}`, { ck: ck("own"), method: "PATCH", body: { value: "9" } });
  check("a figure that has been a live cut cannot be moved: a rate a company was billed under is ended "
    + "by a new version, never edited under them", r.status === 409 && code(r) === "CONFLICT"
    && /frozen|clone/i.test(words(r)), { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/cuts/${rateA}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "Putting an agreement that already lived up for a signature again." } });
  check("an agreement that was signed is not signed twice, and the answer tells the desk what to do "
    + "instead: clone it forward", r.status === 409 && /Clone it forward/i.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateB}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "Asking a second seat to sign a paper that is already out again." } });
  check("…and the second raise of the same draft is answered with the paper that is already waiting",
    r.status === 409 && words(r).includes(paperB2), { s: r.status, w: words(r) });

  // The run's own second no, so the register is left with no paper standing open and both halves of the
  // signature have been met over HTTP twice.
  r = await call(`/control/pricing/cuts/${rateB}/refuse`, { ck: ck("own"), method: "POST",
    body: { note: "Two per cent again is still not what this company was promised. The office keeps the "
      + "draft and waits for a figure worth signing." } });
  check("a refusal is answered by a second refusal: the seat that raised this paper is the other one, so "
    + "the answer is legitimate, the count goes to two and the draft is free again",
    r.status === 200 && Number(r.json?.refusals) === 2 && agreeOf(r.json)?.status === "draft",
    { s: r.status, ref: r.json?.refusals, st: agreeOf(r.json)?.status });

  const dbB3 = await rateRow(String(rateB));
  const dbPaperB2 = await row("platform_approvals", paperB2);
  check("…and the row keeps both answers: refusals 2, still a draft, still naming the paper that was "
    + "answered, while the dead paper itself is rejected on the register rather than deleted",
    dbB3.status === "draft" && Number(dbB3.refusals) === 2 && String(dbB3.approval_id) === paperB2
    && dbPaperB2.status === "rejected" && String(dbPaperB2.decided_by) === uOwn,
    { s: dbB3.status, r: dbB3.refusals, p: dbPaperB2.status });

  // ---------------- 8. a cut is taken from a transaction ----------------
  phase("the register takes the cut out of the transaction's own money and day");
  r = await call(`/control/pricing/cuts/ask?source=freight_invoice&source_id=${invoiceTZS}`, asRead);
  check("the preview now answers with the rung that spoke, the paper it spoke under and the figure "
    + "after the least and the most — and the agreement's own money. The raw figure and the rounded one "
    + "are the same here, because a 7.5% of a round shilling total needs no rounding, no floor and no "
    + "ceiling to lift it",
    r.status === 200 && r.json?.answer === "cut" && r.json?.figure === "75000.00"
    && Number(r.json?.raw) === 75000 && r.json?.currency === "TZS"
    && String(r.json?.rate?.ref) === dbA.ref && r.json?.already_assessed == null
    && r.json?.rounded === false && r.json?.lifted === false && r.json?.clamped === false
    && r.json?.asked_on === TODAY, { s: r.status, a: r.json?.answer, f: r.json?.figure,
      raw: r.json?.raw, rd: r.json?.rounded, lf: r.json?.lifted, cl: r.json?.clamped,
      rate: r.json?.rate?.ref, on: r.json?.asked_on });

  r = await call("/control/pricing/readings", { ck: ck("read"), method: "POST",
    body: { source_kind: "freight_invoice", source_id: invoiceTZS } });
  check("taking a cut is the pen, not the read", r.status === 403, { s: r.status, w: words(r) });

  r = await call("/control/pricing/readings", { ck: ck("own"), method: "POST",
    body: { source_kind: "freight_invoice", source_id: invoiceEmpty } });
  check("an invoice whose total is nothing has nothing to cut, and the register says so rather than "
    + "keeping a row nobody owes", r.status === 409 && /totals nothing/i.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  r = await call("/control/pricing/readings", { ck: ck("own"), method: "POST",
    body: { source_kind: "freight_invoice", source_id: invoiceDead } });
  check("…and a cancelled one is refused in its own words: a cut is taken from a paper the office "
    + "actually issued", r.status === 404 && code(r) === "NOT_FOUND"
    && /was cancelled/.test(words(r)), { s: r.status, c: code(r), w: words(r) });

  r = await call("/control/pricing/readings", { ck: ck("own"), method: "POST",
    body: { source_kind: "freight_invoice", source_id: invoiceTZS },
    headers: {} } as any);
  const readingTZS = readIdOf(r.json);
  check("a cut is taken in the office's book, and the reading carries the agreement's printed words, "
    + "the transaction's own money, the raw figure and the figure after the least and the most — all "
    + "four in one row, none typed by a clerk. The door hands the row itself, so the figures arrive as "
    + "numbers rather than as a board's printings",
    r.status === 200 && Number(r.json?.reading?.reading?.figure) === 75000
    && r.json?.reading?.reading?.currency === "TZS"
    && Number(r.json?.reading?.reading?.raw_amount) === 75000
    && Number(r.json?.reading?.reading?.source_amount) === 1000000
    && r.json?.reading?.reading?.ref?.startsWith("CMA-"),
    { s: r.status, x: r.json?.reading?.reading });

  const dbR1 = await readingRow(String(readingTZS));
  check("…and the row underneath says which rung spoke, in the office's book, cut on the transaction's "
    + "day rather than on the press", String(dbR1.tenant_id) === TP
    && String(dbR1.rate_id) === rateA && dbR1.assessed_day === TODAY && dbR1.status === "assessed"
    && dbR1.source_ref?.startsWith("PRC-142-") && String(dbR1.assessed_by) === uOwn,
    { t: String(dbR1.tenant_id), r: dbR1.rate_id, d: dbR1.assessed_day });

  r = await call("/control/pricing/readings", { ck: ck("own"), method: "POST",
    body: { source_kind: "freight_invoice", source_id: invoiceTZS } });
  check("the double-count this register exists to refuse: the same transaction cut for the same payee "
    + "comes back `already_assessed` and names the payee, so the clerk is told which one to void — and "
    + "the payee it names is the one the agreement's own rung carries, not a word the desk typed",
    r.status === 409 && code(r) === "CONFLICT" && /already been cut for/.test(words(r))
    && words(r).includes(OFFICE_NAME), { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/cuts/ask?source=freight_invoice&source_id=${invoiceTZS}`, asRead);
  check("the preview carries the reading the register already has, so a clerk sees the CMA number "
    + "before pressing anything", r.status === 200 && r.json?.already_assessed?.ref === dbR1.ref
    && r.json?.already_assessed?.status === "assessed",
    { s: r.status, a: r.json?.already_assessed });

  r = await call("/control/pricing/readings", { ck: ck("own"), method: "POST",
    body: { source_kind: "freight_invoice", source_id: invoiceUSD } });
  const readingUSD = readIdOf(r.json);
  check("a percentage has no money of its own and so is worked in the transaction's: the same 7.5% "
    + "answers a dollar paper in dollars — 750, not 75 000",
    r.status === 200 && Number(r.json?.reading?.reading?.figure) === 750
    && r.json?.reading?.reading?.currency === "USD",
    { s: r.status, f: r.json?.reading?.reading?.figure, c: r.json?.reading?.reading?.currency });

  r = await call("/control/pricing/readings", { ck: ck("own"), method: "POST",
    body: { source_kind: "freight_invoice", source_id: invoiceSecond } });
  const readingCO2 = readIdOf(r.json);
  check("…and the rung rules the paper rather than the company: a second company's invoice, with no "
    + "agreement of its own, is cut at the office's standing 7.5% — 150 000 on 2 000 000",
    r.status === 200 && Number(r.json?.reading?.reading?.figure) === 150000
    && r.json?.reading?.reading?.subject_name === "The office's own cut",
    { s: r.status, f: r.json?.reading?.reading?.figure, n: r.json?.reading?.reading?.subject_name });

  r = await call(`/control/pricing/readings/${readingUSD}`, asOwn);
  check("one reading reads back with the agreement it was cut under and no carrier yet, and its "
    + "figures arrive as numbers because the door hands the row itself",
    r.status === 200 && r.json?.reading?.status === "assessed"
    && typeof r.json?.reading?.figure === "number" && Number(r.json?.reading?.figure) === 750
    && String(r.json?.rate?.id) === rateA && r.json?.carrier === null
    && r.json?.source_now?.ref?.startsWith("PRC-142-"),
    { s: r.status, x: r.json?.reading, c: r.json?.carrier });

  r = await call(`/control/pricing/readings/${readingUSD}/void`, { ck: ck("own"), method: "POST",
    body: { reason: "A dollar reading taken to prove the count keeps the two monies apart; cancelled." } });
  check("a wrong figure is cancelled and kept, not deleted: the door answers with the reading's own CMA "
    + "number and the figure it stopped counting, and no movement is written because a cut that never "
    + "carried moved none",
    r.status === 200 && r.json?.ok === true && /^CMA-/.test(String(r.json?.voided))
    && String(r.json?.figure) === "750.00", { s: r.status, j: r.json });
  const dbVoid = await readingRow(String(readingUSD));
  check("…and the row says voided, with the day and the reason typed beside it, and the answer named "
    + "that row's own number",
    dbVoid.status === "voided" && dbVoid.voided_day === TODAY
    && /cancelled/.test(String(dbVoid.void_reason)) && String(dbVoid.voided_by) === uOwn
    && String(r.json?.voided) === String(dbVoid.ref),
    { s: dbVoid.status, d: dbVoid.voided_day, v: r.json?.voided, ref: dbVoid.ref });

  r = await call(`/control/pricing/readings/${readingUSD}/void`, { ck: ck("own"), method: "POST",
    body: { reason: "Cancelling the same reading a second time." } });
  check("a cancelled reading owes nothing: it cannot be cancelled twice, and the refusal prints the day "
    + "and the seat that already answered it", r.status === 409 && /already cancelled/.test(words(r)),
    { s: r.status, w: words(r) });

  r = await call(`/control/pricing/readings/${readingUSD}/discharge`, { ck: ck("own"), method: "POST",
    body: { carrier_kind: "posting", carrier_id: randomUUID(), note: "Pointing a cancelled cut at a "
      + "movement that does not exist." } });
  check("…nor can it be carried: a voided reading is not carried by anything, and the door refuses on "
    + "its state before it reads a movement", r.status === 409 && /cancelled|voided/i.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  // ---------------- 9. the pointer at 133's book ----------------
  phase("saying a cut has been carried is a claim about the book, so the book is read first");
  const accounts: Record<string, string> = {};
  for (const [codeName, label, kind, cur] of [
    ["FEE-INCOME", "Platform fee income (TZS)", "income", "TZS"],
    ["COST-OPS", "Platform costs (TZS)", "expense", "TZS"],
    ["CASH-OPS", "Till the office pays from (TZS)", "asset", "TZS"],
    // 133's own rule bites the probe here: a posting is one currency, so a dollar fee line needs a
    // dollar till beside it. Without this line the USD paper this suite wants was never raisable, and
    // the pointer test would have been answering a 400 about a uuid rather than the book's rule.
    ["CASH-OPS-USD", "Till the office pays from (USD)", "asset", "USD"],
    ["FEE-INCOME-USD", "Platform fee income (USD)", "income", "USD"]
  ] as [string, string, string, string][]) {
    const found = await one(`select id from money_accounts where tenant_id = $1 and code = $2`,
      [TP, codeName]);
    if (found?.id) { accounts[codeName] = String(found.id); continue; }
    const a = await call("/control/money/accounts", { ck: ck("own"), method: "POST",
      body: { code: codeName, label, kind, currency: cur, note: "The office's own chart, opened by the "
        + "commission smoke so a cut has a line to be pointed at." } });
    accounts[codeName] = String(a.json?.account?.id ?? a.json?.id ?? "");
  }
  check("the office's chart is there — over the money desk's own door, because a cut that the office "
    + "keeps is income and income has a line",
    Object.values(accounts).every((v) => /^[0-9a-f-]{36}$/.test(v)), accounts);

  let postN = 0;
  const post = async (memo: string, legs: any[], currency = "TZS") => {
    postN++;
    const res = await call("/control/money/postings", { ck: ck("own"), method: "POST",
      headers: { "Idempotency-Key": `${MARK}-post-${postN}` },
      body: { posted_on: TODAY, memo, currency, source_kind: "fee", source_ref: `PRC-142-${STAMP}-${postN}`,
        legs } });
    return res;
  };

  r = await post(`A commission smoke movement with no fee line at all.`, [
    { account: accounts["CASH-OPS"], direction: "debit", amount: "75000.00" },
    { account: accounts["COST-OPS"], direction: "credit", amount: "75000.00" }]);
  const postNoLeg = r.json?.posting?.id ?? r.json?.id;
  check("a posting is raised through 133's own door under an idempotency key, so the pointer has a real "
    + "movement to be wrong about", r.status === 200, { s: r.status, w: words(r) });

  r = await call(`/control/pricing/readings/${readingTZS}/discharge`, { ck: ck("man"), method: "POST",
    body: { carrier_kind: "posting", carrier_id: String(postNoLeg),
      note: "A pricing pen with no ledger duty pointing at a real movement." } });
  check("carrying a cut needs 133's duty as well as the pricing one, at the door that has both halves "
    + "of the paper in front of it", r.status === 403, { s: r.status, w: words(r) });

  r = await call(`/control/pricing/readings/${readingTZS}/discharge`, { ck: ck("own"), method: "POST",
    body: { carrier_kind: "transfer", carrier_id: String(postNoLeg),
      note: "Carried by a movement the book does not make." } });
  check("a cut is carried by a payout or a posting and by nothing else: the shape refuses the word before "
    + "the register is even asked, because a name typed beside a date is not a payment — and the door "
    + "answers with the two words it does keep",
    r.status === 400 && code(r) === "VALIDATION_FAILED" && /carrier_kind/.test(words(r))
    && /'payout' \| 'posting'/.test(words(r)), { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/readings/${readingTZS}/discharge`, { ck: ck("own"), method: "POST",
    body: { carrier_kind: "posting", carrier_id: randomUUID(),
      note: "Pointed at a posting the office never raised." } });
  check("a pointer at a movement the office never raised is refused as a 404: how a liability gets "
    + "called paid by a keystroke, so the door reads the book before it believes the desk",
    r.status === 404 && code(r) === "NOT_FOUND" && /no posting/i.test(words(r)),
    { s: r.status, c: code(r) });

  r = await call(`/control/pricing/readings/${readingTZS}/discharge`, { ck: ck("own"), method: "POST",
    body: { carrier_kind: "posting", carrier_id: String(postNoLeg),
      note: "A movement with a cost line and no income line." } });
  check("a cut the office keeps is income, and a posting with no credit leg on the fee line is refused "
    + "rather than accepted as a gesture — the refusal says which line it looked for",
    r.status === 409 && /no leg on FEE-INCOME/.test(words(r))
    && /looked_for:a credit leg on FEE-INCOME/.test(words(r)), { s: r.status, c: code(r), w: words(r) });

  r = await post("A commission smoke movement that books half the cut.", [
    { account: accounts["CASH-OPS"], direction: "debit", amount: "50000.00" },
    { account: accounts["FEE-INCOME"], direction: "credit", amount: "50000.00" }]);
  const postShort = r.json?.posting?.id ?? r.json?.id;
  r = await call(`/control/pricing/readings/${readingTZS}/discharge`, { ck: ck("own"), method: "POST",
    body: { carrier_kind: "posting", carrier_id: String(postShort),
      note: "A movement that carries fifty thousand of a seventy-five thousand cut." } });
  check("the register reads the figure out of the movement, not out of the pointer: a fee line of "
    + "50 000 cannot carry a cut of 75 000, and the refusal prints both so the office can see the gap "
    + "it still counts", r.status === 409 && /asked:75000.00/.test(words(r))
    && /carries:50000.00/.test(words(r)), { s: r.status, c: code(r), w: words(r) });

  r = await post("A commission smoke movement in the wrong money.", [
    { account: accounts["FEE-INCOME-USD"], direction: "credit", amount: "750.00" },
    { account: accounts["CASH-OPS-USD"], direction: "debit", amount: "750.00" }], "USD");
  const postUSD = r.json?.posting?.id ?? r.json?.id;
  check("…and the dollar movement is a real one: 133 books it in its own money, so the pointer that is "
    + "about to be refused has something behind it to be wrong about",
    r.status === 200 && /^[0-9a-f]{8}-/.test(String(postUSD)), { s: r.status, w: words(r) });
  r = await call(`/control/pricing/readings/${readingCO2}/discharge`, { ck: ck("own"), method: "POST",
    body: { carrier_kind: "posting", carrier_id: String(postUSD),
      note: "A dollar paper pointed at a shilling cut." } });
  check("138's rule holds at the pointer too: a USD paper cannot carry a TZS cut even when its figure "
    + "is a different number entirely, because one currency per posting is the book's own rule",
    r.status === 409 && /is a USD paper and/.test(words(r)), { s: r.status, c: code(r), w: words(r) });

  r = await post("The commission smoke movement that books the cut exactly.", [
    { account: accounts["CASH-OPS"], direction: "debit", amount: "75000.00" },
    { account: accounts["FEE-INCOME"], direction: "credit", amount: "75000.00" }]);
  const postRight = r.json?.posting?.id ?? r.json?.id;
  const bookBefore = await one(`select
      (select count(*) from money_entries where tenant_id = $1) as lines,
      (select count(*) from money_postings where tenant_id = $1) as papers`, [TP]);
  r = await call(`/control/pricing/readings/${readingTZS}/discharge`, { ck: ck("own"), method: "POST",
    body: { carrier_kind: "posting", carrier_id: String(postRight),
      note: "Carried by the office's own fee posting for the same seventy-five thousand." } });
  check("the pointer that matches writes no money and changes only the reading: the movement's own "
    + "reference is copied into the row and the door names the figure it read out of the leg",
    r.status === 200 && /^PST-\d{4}-\d{5}$/.test(String(r.json?.carried_by))
    && r.json?.ok !== false && String(r.json?.ref) === dbR1.ref
    && r.json?.carrier_kind === "posting" && String(r.json?.carrier_id) === String(postRight)
    && /carried by/.test(String(r.json?.message)), { s: r.status, j: r.json });

  const dbCarried = await readingRow(String(readingTZS));
  const bookAfter = await one(`select
      (select count(*) from money_entries where tenant_id = $1) as lines,
      (select count(*) from money_postings where tenant_id = $1) as papers`, [TP]);
  check("…and the book is left exactly as it was: one reading moved, no leg written, the carrier's own "
    + "number copied out of 133 rather than typed beside it",
    dbCarried.status === "discharged" && String(dbCarried.carrier_id) === String(postRight)
    && /^PST-\d{4}-\d{5}$/.test(String(dbCarried.carrier_ref))
    && String(dbCarried.carried_day) === TODAY
    && bookBefore.lines === bookAfter.lines && bookBefore.papers === bookAfter.papers,
    { s: dbCarried.status, c: dbCarried.carrier_ref, before: bookBefore, after: bookAfter });

  r = await call(`/control/pricing/readings/${readingTZS}/discharge`, { ck: ck("own"), method: "POST",
    body: { carrier_kind: "posting", carrier_id: String(postRight),
      note: "Trying to carry the same cut twice." } });
  check("a carried cut answers twice in the same words: it cannot be pointed at a movement a second "
    + "time, and the refusal names the carrier it already has",
    r.status === 409 && /already carried by/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/readings/${readingTZS}/void`, { ck: ck("own"), method: "POST",
    body: { reason: "Cancelling a cut the book has already carried." } });
  check("nor is it cancelled by this register, because the movement that carried it is answered in the "
    + "book by 133's reversal — a void here would leave the register disagreeing with the ledger",
    r.status === 409 && /was carried by|The money moved/i.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/readings/${readingTZS}`, asRead);
  check("the reading's memory carries its money and both of its states, newest first: discharged then "
    + "assessed, each line naming the currency it was booked in",
    r.status === 200 && r.json?.memory?.length === 2
    && r.json?.memory?.every((x: any) => x.currency === "TZS")
    && String(r.json?.memory?.map((x: any) => x.what).join(",")) === "discharge,assess",
    { s: r.status, m: r.json?.memory?.map((x: any) => `${x.what}:${x.currency}`) });

  // ---------------- 10. a version that cannot go live ----------------
  phase("one rung, one day, one paper — and the desk that would sign two");
  r = await openCut("own", { value: "9", note: `${MARK} · A second standing cut on the same transaction `
    + "for the same days, which the ladder cannot answer twice." });
  const rateD = agreeOf(r.json)?.id;
  check("a second draft on a rung that is already live opens — the register refuses at the paper, not "
    + "at the typing, because a clerk has to be allowed to prepare a correction",
    r.status === 200 && String(agreeOf(r.json)?.status) === "draft", { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateD}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "Putting a second standing cut up for a signature." } });
  check("a paper whose days are already held by a live agreement on the same rung is refused before a "
    + "seat is asked to waste a signature on it, and the answer names both papers and what to do",
    r.status === 409 && /both put a freight_invoice cut on/.test(words(r))
    && words(r).includes(dbA.ref) && /Clone/.test(words(r)), { s: r.status, c: code(r), w: words(r) });

  const dbGoneD = await rateRow(String(rateD));
  r = await call(`/control/pricing/cuts/${rateD}/discard`, { ck: ck("own"), method: "POST",
    body: { reason: "A draft that the ladder already has no room for." } });
  check("a draft nobody was asked to sign is throwaway, and the answer prints the paper it threw away "
    + "and the reason the desk typed — nothing was signed and nothing was charged",
    r.status === 200 && r.json?.ok === true && String(r.json?.discarded) === String(dbGoneD?.ref)
    && /no room for/.test(String(r.json?.reason)), { s: r.status, j: r.json, ref: dbGoneD?.ref });
  const goneD = await one(`select count(*)::int as n from pricing_commission_rates where id = $1`, [rateD]);
  check("the row is really gone: a discard of an unsigned draft is a delete, not a status",
    goneD.n === 0, goneD);

  r = await call(`/control/pricing/cuts/${rateA}/clone`, { ck: ck("own"), method: "POST",
    body: { effective_from: TOMORROW, note: "The same standing cut, carried forward to a new day." } });
  const rateE = agreeOf(r.json)?.id;
  const dbE = await rateRow(String(rateE));
  check("a live agreement is moved forward by cloning rather than by editing: the new version copies "
    + "the figure, keeps the rung and names the paper it replaces — one rung above the version it "
    + "supersedes, whatever number that was",
    r.status === 200 && Number(dbE.version) === rungA + 1 && String(dbE.supersedes_id) === rateA
    && dbE.value === "7.5000" && String(dbE.subject_key) === NIL && dbE.status === "draft"
    && dbE.from_day === TOMORROW, { s: r.status, v: dbE.version, want: rungA + 1,
      sup: String(dbE.supersedes_id) });

  /** The desk's next click after cloning was the one the register refused. A live cut runs open-ended
   *  until a second seat signs its successor — that is what `clone` promises and what `apply` honours —
   *  so the paper's own clash guard met the very row the draft names in `supersedes_id` and answered
   *  `days_are_taken`. Every version after the first was therefore un-signable, and this file never saw
   *  it: it cloned a version and threw the clone away without ever asking a seat to sign it. A stranger
   *  on the same days is still refused (`rateD` above); a version that replaces the live cut is not. */
  r = await call(`/control/pricing/cuts/${rateA}/clone`, { ck: ck("own"), method: "POST",
    body: { effective_from: TOMORROW, note: `${MARK} · The standing cut carried forward, and put up for `
      + "a signature while the version underneath it is still live." } });
  const rateF = agreeOf(r.json)?.id;
  const dbF = await rateRow(String(rateF));
  check("a second version cloned forward is a draft beside the first: one rung holds one live answer and "
      + "any number of papers waiting to replace it, and the new version counts itself after the last",
    r.status === 200 && Number(dbF.version) === rungA + 2 && String(dbF.supersedes_id) === rateA
    && dbF.status === "draft", { s: r.status, v: dbF.version, want: rungA + 2, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateF}/publish`, { ck: ck("bill"), method: "POST",
    body: { reason: "The cut below this one keeps ruling until a second seat signs the handover, so it "
      + "is still open-ended. Put the successor up over it." } });
  const paperF = String(r.json?.approval_id ?? "");
  check("…and the version that replaces a live agreement can be put up for a signature over it: the clash "
      + "guard reads `supersedes_id` as the row this draft stands for, not as a rival holding the same "
      + "days. The answer before was `days_are_taken` naming the live ref, which is the refusal that made "
      + "the whole version chain a dead end",
    r.status === 200 && /^[0-9a-f]{8}-/.test(paperF)
    && agreeOf(r.json)?.status === "pending_signature", { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/cuts/${rateF}/refuse`, { ck: ck("own"), method: "POST",
    body: { note: "Answered, not signed: the office is not ready to hand this cut over yet." } });
  check("…and the handover is answerable back to a draft, leaving the live cut ruling and the successor "
      + "marked by a paper nobody signed rather than left waiting on one",
    r.status === 200 && Number(r.json?.refusals) === 1 && agreeOf(r.json)?.status === "draft",
    { s: r.status, j: r.json });

  r = await call(`/control/pricing/cuts/${rateA}/withdraw`, { ck: ck("own"), method: "POST",
    body: { effective_to: TOMORROW, reason: "The office stops taking this cut from tomorrow, under the "
      + "version cloned forward." } });
  check("one seat stops an agreement without a second signature: it stops the office asking for a cut "
    + "tomorrow and does not unmake the days it was quoted under",
    r.status === 200 && r.json?.stopped === dbA.ref, { s: r.status, j: r.json });

  const dbA3 = await rateRow(String(rateA));
  const dbR1b = await readingRow(String(readingTZS));
  check("…and the readings taken under it stay: a stopped agreement is not an agreement that never "
    + "ruled, and the cut the book already carried is still carried",
    dbA3.status === "withdrawn" && dbA3.withdrawn_day === TODAY && String(dbA3.withdrawn_by) === uOwn
    && /stops taking this cut/i.test(String(dbA3.withdrawn_reason)) && dbR1b.status === "discharged"
    && dbR1b.source_ref === dbR1.source_ref,
    { s: dbA3.status, d: dbA3.withdrawn_day, r: dbR1b.status });

  r = await call(`/control/pricing/cuts/${rateA}/withdraw`, { ck: ck("own"), method: "POST",
    body: { effective_to: TOMORROW, reason: "Stopping an agreement that has already stopped." } });
  check("an agreement that has stopped is not stopped twice, and the answer names the state it found and "
    + "what a desk does instead at each of the three",
    r.status === 409 && code(r) === "CONFLICT" && /is withdrawn\. A draft is thrown away/.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/cuts/${rateE}/withdraw`, { ck: ck("own"), method: "POST",
    body: { effective_to: TODAY, reason: "Stopping a draft that never went live." } });
  check("…and a draft cannot be stopped at all: a draft is thrown away, and the register says so",
    r.status === 409 && /A draft is thrown away/.test(words(r)), { s: r.status, w: words(r) });

  r = await call(`/control/pricing/cuts/${rateE}/discard`, { ck: ck("own"), method: "POST",
    body: { reason: "The cloned version is not needed until the day underneath it closes." } });
  check("the clone is a draft and is disposable, so a version prepared for nothing is not a row the "
    + "office is stuck with", r.status === 200, { s: r.status, w: words(r) });

  // ---------------- 11. the counts a desk must not do for itself ----------------
  phase("the boards, the count and the summaries the register keeps");
  const piles = await one(`select
      count(*) filter (where status = 'published')::int as published,
      count(*) filter (where status = 'withdrawn')::int as withdrawn,
      count(*) filter (where status = 'draft')::int as draft
    from pricing_commission_rates where tenant_id = $1`, [TP]);
  r = await call(`/control/pricing/cuts?status=withdrawn&search=${MARK}`, asOwn);
  check("the agreements board counts the piles the desk prints beside them — the book's own piles, which "
    + "SQL answers the same way — and a stopped agreement is still shown with its rung and its number",
    r.status === 200 && r.json?.total === 1 && r.json?.counts?.withdrawn === piles.withdrawn
    && r.json?.rows?.[0]?.subject_name === "The office's own cut" && r.json?.rows?.[0]?.ref === dbA.ref,
    { s: r.status, t: r.json?.total, c: r.json?.counts, sql: piles });

  r = await call(`/control/pricing/cuts?search=${dbA.ref}`, asAn);
  check("…and the search box reaches a paper by its own number, which is the question a desk actually "
    + "has when a figure looks wrong", r.status === 200 && r.json?.total === 1
    && r.json?.rows?.[0]?.id === rateA, { s: r.status, t: r.json?.total });

  const readings = await one(`select
      count(*) filter (where status = 'assessed')::int as assessed,
      count(*) filter (where status = 'discharged')::int as discharged,
      count(*) filter (where status = 'voided')::int as voided,
      count(*)::int as all from pricing_commission_assessments where tenant_id = $1`, [TP]);
  r = await call(`/control/pricing/readings?source=freight_invoice&search=PRC-142-${STAMP}`, asRead);
  check("the readings board counts the piles the desk prints beside them, and reaches a transaction by "
    + "its own reference — has this invoice been cut?",
    r.status === 200 && r.json?.total === 3 && r.json?.counts?.assessed === readings.assessed
    && r.json?.counts?.discharged === readings.discharged && r.json?.counts?.voided === readings.voided,
    { s: r.status, t: r.json?.total, c: r.json?.counts, sql: readings });

  r = await call(`/control/pricing/readings?search=${dbR1.source_ref}`, asRead);
  check("…and one invoice's own reference answers with the readings taken against it, not with the "
    + "book", r.status === 200 && r.json?.total === 1
    && r.json?.rows?.[0]?.ref === dbR1.ref, { s: r.status, t: r.json?.total });

  r = await call(`/control/pricing/summary`, asOwn);
  const tzs = (r.json?.by_currency ?? []).find((x: any) => x.currency === "TZS");
  const usd = (r.json?.by_currency ?? []).find((x: any) => x.currency === "USD");
  const money = await one(`select
      coalesce(sum(m.figure) filter (where m.status = 'assessed'), 0)::numeric(14,2)::text as tz_open,
      count(*) filter (where m.currency = 'TZS')::int as tz_readings,
      count(*) filter (where m.currency = 'TZS' and m.status = 'assessed')::int as tz_open_n,
      coalesce(sum(m.figure) filter (where m.currency = 'USD' and m.status = 'voided'),
        0)::numeric(14,2)::text as usd_void,
      count(*) filter (where m.currency = 'USD' and m.status = 'assessed')::int as usd_open_n
    from pricing_commission_assessments m where m.tenant_id = $1`, [TP]);
  check("the office's own count is kept per money: the shilling line's open pile is the book's own sum "
    + "and the dollar line has nothing open, because its only reading was cancelled — 138's lesson that a "
    + "sum of two monies is a number with no meaning",
    r.status === 200 && String(tzs?.open_amount) === money.tz_open
    && Number(tzs?.open_count) === money.tz_open_n && Number(tzs?.reading_count) === money.tz_readings
    && Number(usd?.open_count) === 0 && Number(usd?.open_amount) === 0
    && String(usd?.void_amount) === money.usd_void && money.usd_open_n === 0,
    { s: r.status, tz: tzs, usd, sql: money });

  r = await call(`/control/pricing/summary`, asOwn);
  check("…and the breakdown by transaction is keyed per money too, so a desk that prints `cut by "
    + "transaction` never folds a dollar bill's 750 into a freight invoice's 75 000",
    (r.json?.by_source ?? []).every((x: any) => x.currency && x.parts)
    && (r.json?.by_source ?? []).length >= 1 && (r.json?.by_payee ?? []).length >= 1
    && (r.json?.by_payee ?? []).every((x: any) => x.currency),
    { src: r.json?.by_source, pay: r.json?.by_payee });

  r = await call(`/control/pricing/summary?from=2030-01-01&to=2030-12-31`, asOwn);
  check("a window the register has nothing in answers with three empty piles rather than a zero-summed "
    + "fiction: the count says nothing, and so does the money",
    r.status === 200 && (r.json?.by_currency ?? []).length === 0
    && (r.json?.by_source ?? []).length === 0 && (r.json?.by_payee ?? []).length === 0
    && r.json?.from === "2030-01-01" && /never together/.test(String(r.json?.note)),
    { s: r.status, j: r.json });

  r = await call(`/control/pricing/summary?from=2026-06-01&to=2026-01-01`, asOwn);
  check("a last day before the first is refused in the door's own words instead of being answered with "
    + "the whole book", r.status === 400 && /before|window/i.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/cuts/choices?kind=company&search=Commission`, asOwn);
  check("the picker answers with the companies the register can price, in the office's own words, and "
    + "with the fields a desk needs to name the row it is about to sign",
    r.status === 200 && Array.isArray(r.json?.rows) && r.json?.kind === "company",
    { s: r.status, j: r.json });

  r = await call(`/control/pricing/cuts/choices?kind=freight_invoice&search=PRC-142`, asOwn);
  check("…and a transaction picker lists real papers with their own figures, because a cut is a share "
    + "of them and an id pasted off another desk is how an agreement gets filed under somebody else",
    r.status === 200 && r.json?.rows?.some((x: any) => String(x.ref).startsWith("PRC-142-"))
    && r.json?.rows?.every((x: any) => x.amount !== undefined), { s: r.status, j: r.json?.rows });

  // ---------------- 12. two office books are two worlds ----------------
  phase("the API role is BYPASSRLS, so the book bound into the first parameter is the only guard");
  r = await call(`/control/pricing/cuts/${rateA}`, asEst);
  check("a second office's seat reading this book's agreement is a 404, not the agreement: 142's doors "
    + "take the book from the session and bind it in $1, and `withTenant` is not the guard",
    r.status === 404 && code(r) === "NOT_FOUND", { s: r.status, c: code(r), w: words(r) });

  r = await call(`/control/pricing/cuts/${rateA}/history`, asEst);
  check("…and its memory is not readable either: an agreement's history is the dispute between the two "
    + "seats that signed it", r.status === 404, { s: r.status });

  for (const [what, method, body] of [
    ["publish", "POST", { reason: "A seat in another book asking for a signature." }],
    ["refuse", "POST", { note: "A seat in another book answering a paper." }],
    ["discard", "POST", { reason: "A seat in another book throwing a draft away." }],
    ["withdraw", "POST", { effective_to: TOMORROW, reason: "A seat in another book stopping a cut." }],
    ["clone", "POST", { effective_from: TOMORROW, note: "A seat in another book cloning forward." }]
  ] as [string, string, any][]) {
    r = await call(`/control/pricing/cuts/${rateA}/${what}`, { ck: ck("est"), method, body });
    check(`its seat cannot ${what} this book's live agreement — 404 on the row, and nothing written`,
      r.status === 404, { door: what, s: r.status, w: words(r) });
  }

  r = await call(`/control/pricing/cuts/${rateA}`, { ck: ck("est"), method: "PATCH",
    body: { value: "1" } });
  check("…nor move a figure under it", r.status === 404, { s: r.status, w: words(r) });

  r = await call(`/control/pricing/readings/${readingTZS}/discharge`, { ck: ck("est"), method: "POST",
    body: { carrier_kind: "posting", carrier_id: String(postRight),
      note: "A seat in another book claiming this book's cut was carried." } });
  check("a cut in one book is not carried by a seat in another, even one that holds every duty: the "
    + "movement it would point at is not in its book either", r.status === 404,
    { s: r.status, c: code(r), w: words(r) });

  r = await call("/control/pricing/cuts?limit=50", asEst);
  check("its own board is empty, and an empty board is a different answer from a refused one: the "
    + "office that has never agreed a cut is told so rather than shown another office's",
    r.status === 200 && r.json?.total === 0 && r.json?.counts?.draft === undefined,
    { s: r.status, t: r.json?.total, c: r.json?.counts });

  r = await call(`/control/pricing/cuts/ask?source=freight_invoice&source_id=${invoiceTZS}`, asEst);
  const ownAnswer = await call(`/control/pricing/cuts/ask?source=freight_invoice&source_id=${invoiceTZS}`,
    asOwn);
  check("…and the preview is 142's one deliberate book-less door: the ladder is keyed off the paper's own "
    + "company, its plan, or the office's nil, and the resolver takes no tenant at all — so a second "
    + "office asking about this invoice gets the identical answer, not a refusal and not its own figure",
    r.status === 200 && r.json?.answer === ownAnswer.json?.answer
    && String(r.json?.message ?? "") === String(ownAnswer.json?.message ?? "")
    && r.json?.answer === "no_rate" && r.json?.figure === null
    && r.json?.rate?.error === "no_rate", { s: r.status, a: r.json?.answer, own: ownAnswer.json?.answer,
      f: r.json?.figure });

  r = await call("/control/pricing/readings", { ck: ck("est"), method: "POST",
    body: { source_kind: "freight_invoice", source_id: invoiceTZS } });
  check("…and the same press from the other office is refused for the same honest reason the office's own "
    + "press would be now: no rung is in force on the day the paper was cut, so nothing is read and "
    + "nothing is filed — 142's `not_the_office` only guards a book that is not a platform one",
    r.status === 404 && code(r) === "NOT_FOUND" && /no agreement puts a cut on/i.test(words(r)),
    { s: r.status, c: code(r), w: words(r) });

  const txReads = await one(`select count(*)::int as n from pricing_commission_assessments
    where tenant_id = $1`, [TX]);
  check("…and the second office's book holds no reading of this run's invoice: it is the ladder that "
    + "answered, not a row written under a book that never agreed the cut",
    txReads.n === 0, txReads);

  // ---------------- 13. what the reads write, and what a write leaves ----------------
  phase("the register records decisions, not glances");
  const AUDITS = `select count(*)::int as n from audit_logs
    where action like 'pricing.commission%' and ts > to_timestamp($1/1000.0)`;
  const before = await one(AUDITS, [T0]);
  for (const p of ["/control/pricing/cuts", "/control/pricing/cuts?status=published",
    `/control/pricing/cuts/${rateA}`, `/control/pricing/cuts/${rateA}/history`,
    "/control/pricing/readings", `/control/pricing/readings/${readingTZS}`,
    "/control/pricing/summary", "/control/pricing/cuts/choices?kind=company",
    `/control/pricing/cuts/ask?source=freight_invoice&source_id=${invoiceTZS}`]) {
    await call(p, asRead);
  }
  const after = await one(AUDITS, [T0]);
  check("nine reads write no audit line: the register records decisions, not glances",
    before.n === after.n, { before: before.n, after: after.n });

  const census = await one(`select
      (select count(*) from audit_logs where action = 'pricing.commission_opened'
        and ts > to_timestamp($1/1000.0)) as opened,
      (select count(*) from audit_logs where action = 'pricing.commission_edited'
        and ts > to_timestamp($1/1000.0)) as edited,
      (select count(*) from audit_logs where action = 'pricing.commission_publish_proposed'
        and ts > to_timestamp($1/1000.0)) as proposed,
      (select count(*) from audit_logs where action = 'pricing.commission_publish_refused'
        and ts > to_timestamp($1/1000.0)) as refused,
      (select count(*) from audit_logs where action = 'pricing.commission_published'
        and ts > to_timestamp($1/1000.0)) as published,
      (select count(*) from audit_logs where action = 'pricing.commission_assessed'
        and ts > to_timestamp($1/1000.0)) as assessed,
      (select count(*) from audit_logs where action = 'pricing.commission_discharged'
        and ts > to_timestamp($1/1000.0)) as carried,
      (select count(*) from audit_logs where action = 'pricing.commission_voided'
        and ts > to_timestamp($1/1000.0)) as voided,
      (select count(*) from audit_logs where action = 'pricing.commission_withdrawn'
        and ts > to_timestamp($1/1000.0)) as stopped,
      (select count(*) from audit_logs where action = 'pricing.commission_cloned'
        and ts > to_timestamp($1/1000.0)) as cloned,
      (select count(*) from audit_logs where action = 'pricing.commission_discarded'
        and ts > to_timestamp($1/1000.0)) as discarded`, [T0]);
  // Counted from the run's own presses: four drafts opened (rateA/B/C, plus a second standing cut that
  // could not go live), two edits of the plan rung, four papers raised (rateA, rateB, rateB again after
  // the first no, and the version cloned forward over a live cut), three refusals — the two nos on rateB
  // and the handover answered back to a draft — one signature applied, three readings taken, one carried,
  // one cancelled, one agreement stopped, two clones (one thrown away, one put up for a signature) and
  // two drafts discarded.
  const wants = { opened: 4, edited: 2, proposed: 4, refused: 3, published: 1, assessed: 3,
    carried: 1, voided: 1, stopped: 1, cloned: 2, discarded: 2 };
  check("every accepted write this run made left exactly one line and none of them doubled — the door "
    + "writes its own audit and a route that audited on top would double the register",
    Object.entries(wants).every(([k, n]) => Number((census as any)[k]) === n), census);

  /** Both reads are scoped to the agreement they are about, not to whichever refusal happened last.
   *  `rateF`'s handover is answered after these two lines, so a bare `order by ts` would print the
   *  successor's sentence under a check that claims to be about the double no. */
  const refusedAudit = await one(`select after ->> 'note' as note, after ->> 'refusals' as refusals,
      after ->> 'seat' as seat, after ->> 'proposed_by' as proposed_by, after ->> 'ref' as ref,
      before ->> 'paper_sha256' as sha
      from audit_logs where action = 'pricing.commission_publish_refused'
      and ts > to_timestamp($1/1000.0) and after ->> 'ref' = $2 order by ts asc limit 1`,
    [T0, dbB.ref]);
  check("…and the refusal's line keeps the sentence the second seat typed, the count it left, both "
    + "seats by name and the bytes the paper was cut on",
    /not what the office promised/.test(String(refusedAudit.note)) && refusedAudit.refusals === "1"
    && refusedAudit.seat === "Commission Bill" && refusedAudit.proposed_by === "Commission Owner"
    && refusedAudit.ref === dbB.ref && /^[0-9a-f]{64}$/.test(String(refusedAudit.sha)), refusedAudit);

  const refusedAgain = await one(`select after ->> 'note' as note, after ->> 'refusals' as refusals,
      after ->> 'seat' as seat, after ->> 'proposed_by' as proposed_by, after ->> 'ref' as ref
      from audit_logs where action = 'pricing.commission_publish_refused'
      and ts > to_timestamp($1/1000.0) and after ->> 'ref' = $2 order by ts desc limit 1`,
    [T0, dbB.ref]);
  check("…and the second no on the same agreement is its own line, not an overwrite of the first: the "
    + "count climbs to two, the seats swap ends, and the register keeps both sentences",
    refusedAgain.refusals === "2" && refusedAgain.seat === "Commission Owner"
    && refusedAgain.proposed_by === "Commission Bill" && refusedAgain.ref === dbB.ref
    && /still not what this company/i.test(String(refusedAgain.note)), refusedAgain);

  const carriedAudit = await one(`select after ->> 'booked_leg' as leg, after ->> 'carrier_ref' as carrier,
      after ->> 'movement_total' as total, after ->> 'figure' as figure, after ->> 'currency' as currency
      from audit_logs where action = 'pricing.commission_discharged' and ts > to_timestamp($1/1000.0)
      limit 1`, [T0]);
  check("the pointer's own line prints the figure the register read out of the leg beside the reading's "
    + "figure and the movement's total, so an auditor never has to open 133 to see the pair agree",
    carriedAudit.leg === "75000.00" && carriedAudit.figure === "75000.00"
    && carriedAudit.currency === "TZS" && String(carriedAudit.total) === "75000.00"
    && String(carriedAudit.carrier).length > 3, carriedAudit);

  // `rate_limits` is 001's fixed-window table: a bucket's instant is `window_start`, and the
  // window is aligned to the epoch, so the run's own start millisecond is the only floor a
  // count of "limiters this desk fired" can honestly use.
  const buckets = await one(`select count(*)::int as n,
      count(*) filter (where bucket like 'readings-board%')::int as readings_board
    from rate_limits where bucket ~ '^(cuts-|cut-|readings-board)'
    and window_start > to_timestamp($1/1000.0)`, [T0]);
  check("the desk's own limiters fired: a board, a preview and a press all count against a bucket the "
    + "register can see — and the readings board keeps its own bucket, because a desk that polls one "
    + "board must not be throttled by the other", buckets.n >= 5 && buckets.readings_board >= 1,
    buckets);

  // ---------------- 14. teardown, and the rows this run is not allowed to take back ----------------
  phase("teardown, and the census a signature leaves behind");
  await sweep();
  const END = await one(`select
      (select count(*) from pricing_commission_rates) as rates,
      (select count(*) from pricing_commission_history) as memory,
      (select count(*) from pricing_commission_assessments) as readings,
      (select count(*) from platform_approvals where action = 'pricing.commission') as papers,
      (select count(*) from tenants where name like $1) as books,
      (select count(*) from users where email like $2) as seats,
      (select count(*) from pricing_commission_rates where note like $3) as mine,
      (select count(*) from pricing_commission_assessments where source_ref like $4) as myreads
      `, [BOOK_SWEEP, EMAIL_SWEEP, `${MARK}%`, `PRC-142-${STAMP}-%`]);
  note(`this run left ${Number(END.rates) - Number(START.rates)} agreements, `
    + `${Number(END.memory) - Number(START.memory)} memory rows, `
    + `${Number(END.readings) - Number(START.readings)} readings, `
    + `${Number(END.papers) - Number(START.papers)} papers, `
    + `${Number(END.books) - Number(START.books)} books and `
    + `${Number(END.seats) - Number(START.seats)} seats behind it`);
  check("the kept rows are exactly the ones this run signed for: three agreements (the one that lived and "
    + "was stopped, the one a second seat said no to twice, and the version cloned forward over the live "
    + "one), three readings and the four papers that name them — every one of them found again by this "
    + "run's own mark, which is what makes the growth attributable rather than assumed",
    Number(END.myreads) === 3 && Number(END.mine) === 3
    && Number(END.rates) - Number(START.rates) === Number(END.mine)
    && Number(END.readings) - Number(START.readings) === Number(END.myreads)
    && Number(END.papers) - Number(START.papers) === 4,
    { start: START, end: END });

  const left = await one(`select
      (select count(*) from pricing_commission_rates r where r.tenant_id = $1
        and r.status = 'draft' and r.published_at is null and r.approval_id is null) as mine_draft,
      (select count(*) from pricing_commission_rates r where r.tenant_id = $1
        and r.status = 'pending_signature') as waiting,
      (select count(*) from platform_approvals a where a.action = 'pricing.commission'
        and a.status = 'pending') as papers_open,
      (select count(*) from roles where key = $2) as fixture_role,
      (select count(*) from plans where key = $3) as fixture_plan,
      (select count(*) from freight_invoices where invoice_number like $4) as papers_cut,
      (select count(*) from rate_limits where bucket ~ '^(cut|readings-board|pricing)') as buckets,
      (select count(*) from tenants where name = $5) as other_books,
      (select count(*) from tenants where name = 'PR Commission Office') as office,
      (select count(*) from roles where key like 'p142_pen_%') as prior_roles,
      (select count(*) from plans where key like 'c142-growth-%') as prior_plans,
      (select count(*) from tenants where name like 'PR Commission Other %') as prior_books,
      (select count(*) from freight_invoices where invoice_number like 'PRC-142-%') as prior_invoices`,
      [TP, `p142_pen_${STAMP}`, `c142-growth-${STAMP}`, `PRC-142-${STAMP}-%`, OTHER_NAME]);
  note(`fixtures left by an earlier run that died mid-flight: ${left.prior_roles} duty, `
    + `${left.prior_plans} plans, ${left.prior_books} books, ${left.prior_invoices} invoices`);
  check("everything the guards do not pin is gone: the manage-only duty, the plan, the companies, the "
    + "invoices, the second office's rows and every limiter bucket",
    Number(left.fixture_role) === 0 && Number(left.fixture_plan) === 0
    && Number(left.papers_cut) === 0 && Number(left.buckets) === 0
    && Number(left.other_books) === 0, left);
  check("…and no draft of this run's is left standing, because a draft is the one thing the register "
    + "lets a desk throw away", Number(left.mine_draft) === 0 && Number(left.waiting) === 0
    && Number(left.papers_open) === 0, left);
  check("…and the office book the published agreement lives in is still there, which is the guard "
    + "working rather than the sweep failing", Number(left.office) === 1, left);

  const orphans = await one(`select
      (select count(*) from pricing_commission_rates r where r.approval_id is not null
        and not exists (select 1 from platform_approvals a where a.id = r.approval_id)) as pointing,
      (select count(*) from platform_approvals a where a.action = 'pricing.commission'
        and a.target_kind = 'pricing_commission_rate'
        and not exists (select 1 from pricing_commission_rates r where r.id::text = a.target_id)) as papers,
      (select count(*) from pricing_commission_assessments m where not exists
        (select 1 from pricing_commission_rates r where r.id = m.rate_id)) as loose,
      (select count(*) from pricing_commission_assessments m where m.status = 'discharged'
        and not exists (select 1 from money_postings p where p.id = m.carrier_id)) as carried_by_nothing,
      (select count(*) from pricing_commission_history h where not exists
        (select 1 from pricing_commission_rates r where r.id = h.rate_id)) as headless`);
  check("nothing kept points at a row this run deleted: an agreement still names its paper, a paper "
    + "still names an agreement, a reading still names the version it was cut under, a carried cut "
    + "still names the movement that carried it and a memory line still names what it remembers",
    Number(orphans.pointing) === 0 && Number(orphans.papers) === 0 && Number(orphans.loose) === 0
    && Number(orphans.carried_by_nothing) === 0 && Number(orphans.headless) === 0, orphans);

  const SEQ1 = await one(`select
      (select last_value from pricing_commission_rate_number_seq) as rates,
      (select last_value from pricing_commission_assessment_number_seq) as readings`);
  const issued = { rates: Number(census.opened) + Number(census.cloned) + ghostSpend,
    readings: Number(census.assessed) };
  check("every number the register issued is accounted for by name: one per agreement opened or cloned — "
    + "five of them, though only two survived the sweep — the one number the refusal spent while it was "
    + "copying a company's name onto a row that never landed, and one per reading taken. Every other "
    + "refusal in this run answers before the row is built, which is what makes the line hold on a second "
    + "run of the same book",
    Number(SEQ1.rates) - Number(SEQ0.rates) === issued.rates
    && Number(SEQ1.readings) - Number(SEQ0.readings) === issued.readings,
    { before: SEQ0, after: SEQ1, issued, kept: { rates: END.mine, readings: END.myreads } });

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
