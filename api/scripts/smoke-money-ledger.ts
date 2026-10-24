/**
 * The office's book over HTTP — smoke for #344c/#344d (migration 133, control-money.routes.ts,
 * the /control/money desk).
 *
 * verify-money-ledger-sql.ts proves the register itself: the append-only triggers, the COMMIT-time
 * balance rule, the doors' refusals, and a balanced movement posted through a live door by the app
 * role inside a transaction it rolls back. Only HTTP can prove the four things this stage added:
 *
 *  - that the three duties 133 hands out are actually three at the desk — a finance officer who can
 *    post is refused the freeze, a compliance officer who can freeze is refused the pen;
 *  - that a movement the book refuses never reaches the register at all, and that the words the book
 *    raised are the words the clerk reads (the `133:` taken off the front, nothing else rewritten);
 *  - that the route's own guards fire before the door is reached — no `Idempotency-Key`, a figure
 *    with a comma, a day that does not exist — because those are the ones the register cannot teach;
 *  - that a book cannot see another book: every door is handed the caller's tenant, and a foreign
 *    account or a foreign leg is answered as a refusal, not as a row.
 *
 * WHAT THIS RUN DELIBERATELY DOES NOT DO: it never lets a movement commit. `money_entries` refuses
 * UPDATE and DELETE and `money_postings` refuses DELETE, so a committed leg is permanent in every
 * book, in this one included — the gate's own teardown rule ("a book with a committed leg in it can
 * never be tidied") is the reason the accepted-posting path is proved there, in a transaction that is
 * rolled back, and not here. Everything below either writes a row this run can delete (an account with
 * no legs under it) or is refused before a row exists.
 *
 * SAFETY: both books are this run's own synthetic platform tenants, found by name prefix at teardown,
 * and the office's real book is snapshotted and re-measured at the end — its ten chart lines and its
 * zero movements must be exactly what this run found. Audit lines are left behind on purpose:
 * `prevent_audit_mutation()` refuses the owner too.
 *
 * Run: npx tsx scripts/smoke-money-ledger.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";

const STAMP = Date.now().toString().slice(-8);
const MARK = `ml${STAMP}`;
const TENANT_SWEEP = "ML Smoke %";
const EMAIL_SWEEP = `smoke.ml.%@waisha.test`;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
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
/** A door's or a guard's sentence lands in `error.message`; a zod refusal lands one level down in
 *  `details` and its top line is the generic "Request validation failed", which every 400 in the
 *  desk shares. Both are joined, so a check on the words cannot pass for the wrong reason. */
const words = (r: { json: any }) => [String(r.json?.error?.message ?? ""),
  ...(Array.isArray(r.json?.error?.details)
    ? r.json.error.details.map((d: any) => `${d.field ?? ""} ${d.message ?? ""}`) : [])].join(" | ");

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const one = async (sql: string, params: any[] = []) =>
    (await oi(sql, params)).rows[0];

  // The office's own book, and what it holds before this run touches anything.
  const PLAT = (await oi(
    `select id from tenants where type = 'platform' and deleted_at is null
      and name not like $1 order by created_at limit 1`, [TENANT_SWEEP])).rows[0]?.id;
  if (!PLAT) throw new Error("no platform tenant to hold the office's book");
  const BASE = await one(`select
      (select count(*)::int from money_accounts where tenant_id = $1) as accounts,
      (select count(*)::int from money_postings where tenant_id = $1) as postings,
      (select count(*)::int from money_entries) as legs_all,
      (select count(*)::int from money_postings) as books_all`, [PLAT]);
  console.log(`office book found: ${BASE.accounts} chart lines, ${BASE.postings} movements, `
    + `the schema holds ${BASE.legs_all} legs in total`);

  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "finance_officer", "compliance_officer", "platform_analyst", "director"]]
  )).rows;
  const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
  const missing = ["super_admin", "finance_officer", "compliance_officer", "platform_analyst",
    "director"].filter((k) => !rid(k));
  if (missing.length) throw new Error(`global roles missing: ${missing.join(", ")}`);
  // 133's grants are the claim being tested; if a grant never landed, every 403 below would pass for
  // the wrong reason. So the fixture checks its own ground first.
  const grants = await one(`select
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'finance_officer' and rp.permission_key in
          ('control.money.view','control.money.post','control.money.freeze')) as pen,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'compliance_officer' and rp.permission_key in
          ('control.money.view','control.money.post','control.money.freeze')) as ice,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'platform_analyst' and rp.permission_key like 'control.money.%') as read`);
  if (Number(grants.pen) !== 2 || Number(grants.ice) !== 2 || Number(grants.read) !== 1) {
    throw new Error(`133's money duties are not on the roles this run grades — ${JSON.stringify(grants)}`);
  }

  // ---------------- fixtures ----------------
  const TP = randomUUID();   // the book this run signs in at
  const TX = randomUUID();   // a second book, to be kept out of
  const uOwner = randomUUID(); // super_admin: view + post + freeze
  const uPen = randomUUID();   // finance_officer: post, no freeze
  const uIce = randomUUID();   // compliance_officer: freeze, no post
  const uRead = randomUUID();  // platform_analyst: read only
  const uDir = randomUUID();   // director: no money duty at all
  const uBoss = randomUUID();  // a company seat, which is not a control seat at all

  const tok = (who: string) => `${MARK}-${who}`;
  const ck = (who: string) => `waisha_control=${tok(who)}`;

  const books = async () => one(`select
      (select count(*)::int from money_postings where tenant_id = any($1::uuid[])) as postings,
      (select count(*)::int from money_entries where tenant_id = any($1::uuid[])) as legs,
      (select count(*)::int from money_accounts where tenant_id = any($1::uuid[])) as accounts`,
    [[TP, TX]]);

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    // Legs first, then the header, then the chart, then the seats. The two money tables refuse the
    // deletes that would make a teardown easy, which is the point of the run's shape above: nothing
    // here ever commits a movement, so nothing here has to.
    await oi(`delete from money_entries where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from money_postings where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from money_accounts where tenant_id = any($1::uuid[])`, [all]);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
    await oi(`delete from rate_limits where bucket like 'money%'`);
  };

  const START = Date.now();
  await sweep();

  await oi(`insert into tenants (id, type, name, status, trial_ends_at) values
      ($1,'platform',$2,'active', now() + interval '30 days'),
      ($3,'platform',$4,'active', now() + interval '30 days'),
      ($5,'transporter',$6,'trial', now() + interval '3 days')`,
    [TP, `ML Smoke Book ${STAMP}`, TX, `ML Smoke Other ${STAMP}`,
      randomUUID() /* the company, unused by the desk */, `ML Smoke Cargo Ltd ${STAMP}`]);
  const TC = (await oi(`select id from tenants where name like $1`, [`ML Smoke Cargo Ltd ${STAMP}`]))
    .rows[0].id;

  const seat = (id: string, tenant: string, type: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,$3,$4,$5,'active',$6, now() - interval '2 hours', now() - interval '200 days')`,
      [id, tenant, type, name, `smoke.ml.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`,
        type === "platform"]);
  await seat(uOwner, TP, "platform", "Miriam Keeper");
  await seat(uPen, TP, "platform", "Faraji Pen");
  await seat(uIce, TP, "platform", "Neema Freeze");
  await seat(uRead, TP, "platform", "Asha Reader");
  await seat(uDir, TP, "platform", "Daudi Director");
  await seat(uBoss, TC, "staff", "Beatrice Boss");

  await oi(`insert into user_roles (user_id, role_id)
        values ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10),($11,$12)`,
    [uOwner, rid("super_admin"), uPen, rid("finance_officer"), uIce, rid("compliance_officer"),
      uRead, rid("platform_analyst"), uDir, rid("director"), uBoss, rid("director")]);

  const openSession = (uid: string, tenant: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-money',$6,
          now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
  for (const [uid, tenant, who] of [
    [uOwner, TP, "owner"], [uPen, TP, "pen"], [uIce, TP, "ice"], [uRead, TP, "read"],
    [uDir, TP, "dir"], [uBoss, TC, "boss"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  try {
    // ---------------- 1 · the door ----------------
    phase("1 · the door");
    check("an anonymous request never reads the book",
      (await call("/control/money/book")).status === 401);
    check("a cookie with no session row behind it is refused",
      (await call("/control/money/book", { ck: `${MARK}-nobody` })).status === 401);
    const asCompany = await call("/control/money/book", { ck: ck("boss") });
    check("099: a company seat cannot open the office's desk at all",
      asCompany.status === 401, asCompany.json);

    // ---------------- 2 · the chart as the desk finds it ----------------
    phase("2 · an empty book, read three ways");
    const asOwner = { ck: ck("owner") };
    const b0 = await call("/control/money/book", asOwner);
    check("a platform seat with the duty reads its own book", b0.status === 200, b0.json);
    check("the chart of a book nobody has opened is empty, and the desk is told so as a list",
      Array.isArray(b0.json?.accounts) && b0.json.accounts.length === 0, b0.json?.accounts);
    check("…and the counters name every figure the desk prints, all of them zero",
      ["accounts", "frozen_accounts", "postings", "movements_reversed", "tzs_postings",
        "usd_postings", "legs", "debited", "credited", "out_by", "square"]
        .every((k) => k in (b0.json?.totals ?? {}))
        && b0.json?.totals?.postings === 0 && b0.json?.totals?.square === true, b0.json?.totals);
    const sq0 = await call("/control/money/square", asOwner);
    check("the book answers the question the desk must not work out for itself",
      sq0.status === 200 && sq0.json?.square === true && sq0.json?.postings === 0
      && sq0.json?.unbalanced === 0 && Array.isArray(sq0.json?.refs), sq0.json);
    const rg0 = await call("/control/money/register", asOwner);
    check("…and the register of a book with nothing in it is an empty page, not a silence",
      rg0.status === 200 && rg0.json?.rows?.length === 0 && rg0.json?.count === 0
      && rg0.json?.returned === 0 && rg0.json?.limit === 60 && rg0.json?.offset === 0, rg0.json);

    // ---------------- 3 · the three duties ----------------
    phase("3 · reading, writing and stopping are three duties");
    const readAsPen = await call("/control/money/book", { ck: ck("pen") });
    const readAsIce = await call("/control/money/book", { ck: ck("ice") });
    const readAsReader = await call("/control/money/book", { ck: ck("read") });
    check("the pen, the freeze and the read all open the book",
      readAsPen.status === 200 && readAsIce.status === 200 && readAsReader.status === 200,
      [readAsPen.status, readAsIce.status, readAsReader.status]);
    const noKey = await call("/control/money/book", { ck: ck("dir") });
    check("a platform seat with none of the three is refused", noKey.status === 403, noKey.json);
    check("…and the refusal is a duty, not a mystery",
      /control\.money\.view/.test(words(noKey)) || code(noKey) === "FORBIDDEN", words(noKey));

    const openAsReader = await call("/control/money/accounts", {
      ck: ck("read"), method: "POST",
      body: { code: "SMK-NO", label: "Reader cannot", kind: "asset", currency: "TZS" }
    });
    const openAsIce = await call("/control/money/accounts", {
      ck: ck("ice"), method: "POST",
      body: { code: "SMK-NO", label: "Freezer cannot", kind: "asset", currency: "TZS" }
    });
    check("reading the book does not let you write in it, and freezing does not either",
      openAsReader.status === 403 && openAsIce.status === 403,
      [openAsReader.status, openAsIce.status]);

    // ---------------- 4 · opening a line on the chart ----------------
    phase("4 · open an account");
    const badCode = await call("/control/money/accounts", {
      ck: ck("owner"), method: "POST",
      body: { code: "bad code", label: "A space in a code", kind: "asset", currency: "TZS" }
    });
    check("a code with a space in it is refused before the door is reached",
      badCode.status === 400 && /letters, digits, dashes/i.test(words(badCode)), words(badCode));
    const badKind = await call("/control/money/accounts", {
      ck: ck("owner"), method: "POST",
      body: { code: "SMK-KIND", label: "A kind the book has not got", kind: "widget", currency: "TZS" }
    });
    check("an account kind the register cannot hold is refused by the desk's own enum",
      badKind.status === 400, badKind.json);
    const badMoney = await call("/control/money/accounts", {
      ck: ck("owner"), method: "POST",
      body: { code: "SMK-EUR", label: "A money this book has not got", kind: "asset", currency: "EUR" }
    });
    check("…and so is a money that is not TZS or USD", badMoney.status === 400, badMoney.json);
    const shortNote = await call("/control/money/accounts", {
      ck: ck("owner"), method: "POST",
      body: { code: "SMK-NOTE", label: "A note too short to read", kind: "asset",
        currency: "TZS", note: "abc" }
    });
    check("a note that is neither absent nor a sentence is refused",
      shortNote.status === 400, shortNote.json);
    check("…and none of the four reached the book", (await books()).accounts === 0, await books());

    const opened = await call("/control/money/accounts", {
      ck: ck("owner"), method: "POST",
      body: { code: `smk-cash`, label: "Smoke counter cash", kind: "asset", currency: "TZS",
        note: "The desk's own fixture line for the office's cash" }
    });
    check("an account opens", opened.status === 200 && opened.json?.code === "SMK-CASH", opened.json);
    check("…and the code is stored upper-case, because it is quoted across a counter",
      opened.json?.code === "SMK-CASH" && opened.json?.status === "open"
      && opened.json?.entry_count === 0 && opened.json?.tenant_id === undefined,
      { keys: Object.keys(opened.json ?? {}) });
    const CASH = opened.json?.id;

    const second = await call("/control/money/accounts", {
      ck: ck("owner"), method: "POST",
      body: { code: "SMK-FEE", label: "Smoke fee income", kind: "income", currency: "TZS" }
    });
    const FEE = second.json?.id;
    const usd = await call("/control/money/accounts", {
      ck: ck("owner"), method: "POST",
      body: { code: "SMK-USD", label: "Smoke dollar account", kind: "asset", currency: "USD" }
    });
    const USD = usd.json?.id;
    check("a second and a third line open beside it, one of them in the other money",
      second.status === 200 && usd.status === 200 && usd.json?.currency === "USD",
      [second.status, usd.status]);

    const dupe = await call("/control/money/accounts", {
      ck: ck("owner"), method: "POST",
      body: { code: "SMK-CASH", label: "The same money twice", kind: "asset", currency: "TZS" }
    });
    check("the same code twice is a conflict, in the book's own words",
      dupe.status === 409 && /already has an account called SMK-CASH/i.test(words(dupe)),
      { status: dupe.status, message: words(dupe) });
    check("…and no second row exists under it",
      (await one(`select count(*)::int as n from money_accounts
        where tenant_id = $1 and code = 'SMK-CASH'`, [TP])).n === 1);

    // The desk's own reader, and the one that binds the book.
    const rowRead = await call(`/control/money/accounts/${CASH}`, asOwner);
    check("the account read carries the register's figures, not a zero of its own",
      rowRead.status === 200 && rowRead.json?.code === "SMK-CASH"
      && ["debit_total", "credit_total", "entry_count", "last_posted_at", "frozen_reason"]
        .every((k) => k in (rowRead.json ?? {})) && !("tenant_id" in (rowRead.json ?? {})),
      { keys: Object.keys(rowRead.json ?? {}) });

    // A second book, opened by hand, that this seat must not be able to see.
    await oi(`insert into money_accounts (tenant_id, code, label, kind, currency)
      values ($1,'SMK-OTHER','Another book line','asset','TZS')`, [TX]);
    const OTHER = (await one(`select id from money_accounts where tenant_id = $1 and code = 'SMK-OTHER'`,
      [TX])).id;
    const foreign = await call(`/control/money/accounts/${OTHER}`, asOwner);
    check("an account in the other book is not in this one, and is answered as a 404",
      foreign.status === 404, { status: foreign.status, json: foreign.json });

    // ---------------- 5 · freezing and lifting ----------------
    phase("5 · freeze, and the sentence it needs");
    const freezeAsPen = await call(`/control/money/accounts/${CASH}/freeze`, {
      ck: ck("pen"), method: "POST", body: { reason: "The pen is not allowed to stop a line" }
    });
    check("a finance officer who may post may not freeze", freezeAsPen.status === 403, freezeAsPen.json);
    const noReason = await call(`/control/money/accounts/${CASH}/freeze`, {
      ck: ck("ice"), method: "POST", body: {}
    });
    check("a freeze with no reason is refused — it is the stop that has to be readable",
      noReason.status === 400, noReason.json);
    const shortReason = await call(`/control/money/accounts/${CASH}/freeze`, {
      ck: ck("ice"), method: "POST", body: { reason: "audit" }
    });
    check("…and so is a reason too short for a later seat to act on",
      shortReason.status === 400, shortReason.json);
    check("none of the three changed the row",
      (await one(`select status from money_accounts where id = $1`, [CASH])).status === "open");

    const frozen = await call(`/control/money/accounts/${CASH}/freeze`, {
      ck: ck("ice"), method: "POST",
      body: { reason: "Held while the smoke checks the door's own words" }
    });
    const frozeRow = await one(`select status, frozen_reason, frozen_by::text as by from money_accounts
      where id = $1`, [CASH]);
    check("a compliance officer freezes the line, with the sentence on it",
      frozen.status === 200 && frozen.json?.account?.status === "frozen"
      && frozeRow?.status === "frozen"
      && frozeRow?.frozen_reason === "Held while the smoke checks the door's own words"
      && frozeRow?.by === uIce, { status: frozen.status, row: frozeRow });
    check("…and the desk's read of the account says frozen too",
      (await call(`/control/money/accounts/${CASH}`, asOwner)).json?.status === "frozen");
    const twice = await call(`/control/money/accounts/${CASH}/freeze`, {
      ck: ck("ice"), method: "POST", body: { reason: "Frozen a second time for the same reason" }
    });
    check("freezing it again names the reason that is already there instead of overwriting it",
      twice.status === 409 && /frozen/i.test(words(twice))
      && /Held while the smoke checks/.test(words(twice)), words(twice));

    const blocked = await call("/control/money/postings", {
      ck: ck("owner"), method: "POST",
      headers: { "Idempotency-Key": `${MARK}-frozen` },
      body: {
        posted_on: "2026-10-24", memo: "Money through a stopped line", currency: "TZS",
        source_kind: "manual",
        legs: [{ account: FEE, direction: "credit", amount: "500.00" },
          { account: CASH, direction: "debit", amount: "500.00" }]
      }
    });
    check("a frozen account takes no leg in either direction, and says why it stopped",
      blocked.status === 400 && /is frozen/i.test(words(blocked))
      && /Held while the smoke checks/.test(words(blocked)), words(blocked));

    const lifted = await call(`/control/money/accounts/${CASH}/unfreeze`, {
      ck: ck("ice"), method: "POST", body: { reason: "The smoke proved the stop, so it is lifted" }
    });
    const liftRow = await one(`select status, frozen_reason, frozen_by from money_accounts where id = $1`,
      [CASH]);
    check("…and the same duty lifts it, clearing the reason the book keeps",
      lifted.status === 200 && lifted.json?.account?.status === "open"
      && liftRow?.status === "open" && liftRow?.frozen_reason === null
      && liftRow?.frozen_by === null, { status: lifted.status, row: liftRow });
    const liftAudit = await one(`select after::text as a from audit_logs
      where tenant_id = $1 and action = 'control.money.account_unfreeze'
      order by ts desc limit 1`, [TP]);
    check("the words that lifted it survive where the office's history lives, since the row cannot hold both",
      /The smoke proved the stop/.test(liftAudit?.a ?? ""), liftAudit?.a);
    const openTwice = await call(`/control/money/accounts/${CASH}/unfreeze`, {
      ck: ck("ice"), method: "POST", body: {}
    });
    check("lifting a line that was never stopped is a conflict, not a silent no-op",
      openTwice.status === 409 && /is open/i.test(words(openTwice)), words(openTwice));
    const freezeAsOwnerMissing = await call(`/control/money/accounts/${randomUUID()}/freeze`, {
      ck: ck("ice"), method: "POST", body: { reason: "An account that is not in this book" }
    });
    check("freezing a row the book does not hold is a 404 before a reason is asked for",
      freezeAsOwnerMissing.status === 404, freezeAsOwnerMissing.json);

    // ---------------- 6 · the writes that must never arrive ----------------
    phase("6 · a movement the book refuses leaves no trace");
    const noKeyPost = await call("/control/money/postings", {
      ck: ck("owner"), method: "POST",
      body: {
        posted_on: "2026-10-24", memo: "A movement sent with no key at all", currency: "TZS",
        source_kind: "manual",
        legs: [{ account: CASH, direction: "credit", amount: "100.00" },
          { account: FEE, direction: "debit", amount: "100.00" }]
      }
    });
    check("a posting with no Idempotency-Key is refused, because a retry would book it twice",
      noKeyPost.status === 400 && /Idempotency-Key/.test(words(noKeyPost)), words(noKeyPost));
    const tinyKey = await call("/control/money/postings", {
      ck: ck("owner"), method: "POST", headers: { "Idempotency-Key": "short" },
      body: {
        posted_on: "2026-10-24", memo: "A key too short to be a key", currency: "TZS",
        source_kind: "manual",
        legs: [{ account: CASH, direction: "credit", amount: "100.00" },
          { account: FEE, direction: "debit", amount: "100.00" }]
      }
    });
    check("…and so is one too short to be quoted back six months later",
      tinyKey.status === 400 && /8 to 140/.test(words(tinyKey)), words(tinyKey));

    const post = (over: Record<string, any>, key = `${MARK}-p`) => call("/control/money/postings", {
      ck: ck("owner"), method: "POST", headers: { "Idempotency-Key": key },
      body: {
        posted_on: "2026-10-24", memo: "A movement that should not be posted", currency: "TZS",
        source_kind: "manual",
        legs: [{ account: CASH, direction: "credit", amount: "100.00" },
          { account: FEE, direction: "debit", amount: "100.00" }],
        ...over
      }
    });

    const oneLeg = await post({ legs: [{ account: CASH, direction: "credit", amount: "100.00" }] },
      `${MARK}-oneleg`);
    check("one leg is refused by the desk before the door is asked",
      oneLeg.status === 400, oneLeg.json);
    const oneSide = await post({
      legs: [{ account: CASH, direction: "credit", amount: "100.00" },
        { account: FEE, direction: "credit", amount: "100.00" }]
    }, `${MARK}-oneside`);
    check("two legs all on one side are refused by the book, in its own sentence",
      oneSide.status === 400 && /all on one side/i.test(words(oneSide))
      && !/^133:/.test(words(oneSide)), words(oneSide));
    const unbalanced = await post({
      legs: [{ account: CASH, direction: "credit", amount: "1500.00" },
        { account: FEE, direction: "debit", amount: "1490.00" }]
    }, `${MARK}-unbal`);
    check("an unbalanced movement names both totals and the difference, exactly as the register raised it",
      unbalanced.status === 400 && /1490\.00 debited against 1500\.00 credited/i.test(words(unbalanced))
      && /out by 10\.00/.test(words(unbalanced))
      && /does not balance is not posted/i.test(words(unbalanced))
      && !/^133:/.test(words(unbalanced)), words(unbalanced));
    const comma = await post({
      legs: [{ account: CASH, direction: "credit", amount: "1,000.00" },
        { account: FEE, direction: "debit", amount: "1000.00" }]
    }, `${MARK}-comma`);
    check("a figure with a thousand separator in it is refused by the desk's own shape",
      comma.status === 400, comma.json);
    const threePlaces = await post({
      legs: [{ account: CASH, direction: "credit", amount: "1.005" },
        { account: FEE, direction: "debit", amount: "1.00" }]
    }, `${MARK}-milli`);
    check("…and so is a third decimal, which the book cannot hold",
      threePlaces.status === 400, threePlaces.json);
    const nothing = await post({
      legs: [{ account: CASH, direction: "credit", amount: "0" },
        { account: FEE, direction: "debit", amount: "0.00" }]
    }, `${MARK}-zero`);
    check("a leg that moves nothing is refused by the book, not by the desk",
      nothing.status === 400 && /moves 0/i.test(words(nothing)), words(nothing));
    const mixed = await post({
      legs: [{ account: USD, direction: "credit", amount: "100.00" },
        { account: FEE, direction: "debit", amount: "100.00" }]
    }, `${MARK}-mixed`);
    check("one movement cannot cross two monies, and the refusal says what to do instead",
      mixed.status === 400 && /is a USD account and this posting is in TZS/i.test(words(mixed))
      && /two postings with an exchange line/i.test(words(mixed)), words(mixed));
    const foreignLeg = await post({
      legs: [{ account: OTHER, direction: "credit", amount: "100.00" },
        { account: FEE, direction: "debit", amount: "100.00" }]
    }, `${MARK}-foreign`);
    check("a leg cannot move money through another book's account",
      foreignLeg.status === 400 && /is not in that book/i.test(words(foreignLeg)), words(foreignLeg));
    const fakeKind = await post({ source_kind: "gift" }, `${MARK}-gift`);
    check("a source kind the book does not recognise is refused by the desk's enum",
      fakeKind.status === 400, fakeKind.json);
    const noDay = await post({ posted_on: "24/10/2026" }, `${MARK}-noday`);
    check("a day that is not the papers' shape is refused", noDay.status === 400, noDay.json);
    const phantomDay = await post({ posted_on: "2026-02-30" }, `${MARK}-february`);
    check("…and so is a shape that is a valid string and not a valid day, which would otherwise "
      + "reach Postgres and come back as a server fault",
      phantomDay.status === 400 && /no day 2026-02-30 on a calendar/i.test(words(phantomDay)),
      { status: phantomDay.status, message: words(phantomDay) });
    const shortMemo = await post({ memo: "late" }, `${MARK}-memo`);
    check("a memo too short to explain the money is refused", shortMemo.status === 400, shortMemo.json);
    const extraField = await post({ widget: "unknown" }, `${MARK}-extra`);
    check("a field the desk has no column for is refused rather than quietly dropped",
      extraField.status === 400, extraField.json);

    const after = await books();
    check("not one of those fourteen attempts put a movement or a leg in either book",
      after.postings === 0 && after.legs === 0, after);
    // Counted as a whole rather than as "zero rows matching one exact entity": a query that matched
    // nothing because the action name was wrong would print the same clean number as the truth. Five
    // account lines had landed by now — three opens, one freeze, one lift — and no posting line.
    const postAudit = await one(`select
        count(*) filter (where action like 'control.money.%')::int as money_lines,
        count(*) filter (where action like 'control.money.posting_%')::int as posting_lines,
        count(*) filter (where entity = 'money_postings')::int as posting_entity
       from audit_logs where tenant_id = $1`, [TP]);
    check("…and none of them wrote an audit line either, so the history says nothing happened, "
      + "which is the truth",
      postAudit?.posting_lines === 0 && postAudit?.posting_entity === 0
      && postAudit?.money_lines === 5, postAudit);

    const postAsReader = await call("/control/money/postings", {
      ck: ck("read"), method: "POST", headers: { "Idempotency-Key": `${MARK}-read` },
      body: {
        posted_on: "2026-10-24", memo: "A reader trying to write", currency: "TZS",
        source_kind: "manual",
        legs: [{ account: CASH, direction: "credit", amount: "10.00" },
          { account: FEE, direction: "debit", amount: "10.00" }]
      }
    });
    check("the read does not open the pen", postAsReader.status === 403, postAsReader.json);

    // ---------------- 7 · the register's own guards ----------------
    phase("7 · the reads answer a typo as a typo");
    const badStatus = await call("/control/money/register?status=nonsense", asOwner);
    check("a status word the register cannot filter on is refused, not answered with an empty page",
      badStatus.status === 400, { status: badStatus.status, json: badStatus.json });
    const badMoneyQuery = await call("/control/money/register?currency=EUR", asOwner);
    check("…and so is a money the book does not keep", badMoneyQuery.status === 400, badMoneyQuery.status);
    const badAccount = await call("/control/money/register?account=12345", asOwner);
    check("…and so is an account that is not a uuid", badAccount.status === 400, badAccount.status);
    const bigPage = await call("/control/money/register?limit=5000", asOwner);
    check("a page of five thousand movements is refused rather than run",
      bigPage.status === 400, bigPage.status);
    const emptySearch = await call("/control/money/register?search=", asOwner);
    check("an empty search is refused instead of pretending to be a filter",
      emptySearch.status === 400, emptySearch.status);
    const unknownQuery = await call("/control/money/register?widget=1", asOwner);
    check("…and so is a query string the desk has no meaning for",
      unknownQuery.status === 400, unknownQuery.status);

    const ghostPosting = await call(`/control/money/postings/${randomUUID()}`, asOwner);
    check("a movement nobody wrote is a 404, not an empty object",
      ghostPosting.status === 404, ghostPosting.status);
    const ghostAccount = await call(`/control/money/accounts/${randomUUID()}`, asOwner);
    check("…and so is an account nobody opened", ghostAccount.status === 404, ghostAccount.status);
    const badUuid = await call("/control/money/postings/not-a-uuid", asOwner);
    check("a reference that is not a uuid is refused before a query is made of it",
      badUuid.status === 400 && /not .*movement/i.test(words(badUuid)), words(badUuid));

    // ---------------- 8 · what the desk is allowed to see ----------------
    phase("8 · the desk's three duties are in the permissions probe");
    const probe = await call("/control/auth/permissions", asOwner);
    const keys: string[] = probe.json?.permissions ?? [];
    check("the probe carries the money duties, or a seat that holds one never sees the tab",
      ["control.money.view", "control.money.post", "control.money.freeze"].every((k) => keys.includes(k)),
      keys.filter((k) => k.startsWith("control.money")));
    const probeIce = await call("/control/auth/permissions", { ck: ck("ice") });
    check("…and it reports them per seat, so the desk can say which panel it will not open",
      (probeIce.json?.permissions ?? []).includes("control.money.freeze")
      && !(probeIce.json?.permissions ?? []).includes("control.money.post"),
      (probeIce.json?.permissions ?? []).filter((k: string) => k.startsWith("control.money")));

    const bookNow = await call("/control/money/book", asOwner);
    const chart = bookNow.json?.accounts ?? [];
    check("the chart the desk reads carries both sets of figures and the drift flag on every line",
      chart.length === 3 && chart.every((a: any) => "cached" in a && "recomputed" in a
        && "drift" in a && "balance" in a && "natural_side" in a && a.drift === false),
      chart.map((a: any) => [a.code, a.cached, a.recomputed, a.drift]));
    check("…and a zero book squares, because an empty register is not a broken one",
      bookNow.json?.totals?.square === true && bookNow.json?.totals?.accounts === 3
      && bookNow.json?.totals?.legs === 0, bookNow.json?.totals);
    check("…with the income line printed on the side its kind puts it",
      chart.find((a: any) => a.code === "SMK-FEE")?.natural_side === "credit"
      && chart.find((a: any) => a.code === "SMK-CASH")?.natural_side === "debit",
      chart.map((a: any) => [a.code, a.kind, a.natural_side]));

    // ---------------- 9 · the audit trail of the writes that did happen ----------------
    phase("9 · the writes that landed are named in the history");
    const acts = (await oi(`select action, count(*)::int as n from audit_logs
      where tenant_id = $1 group by action`, [TP])).rows;
    const have: Record<string, number> = Object.fromEntries(acts.map((a: any) => [a.action, a.n]));
    check("every account this run opened carries its own line", have["control.money.account_open"] === 3,
      have);
    check("…and so do the freeze and the lift", have["control.money.account_freeze"] === 1
      && have["control.money.account_unfreeze"] === 1, have);
    const whoAudit = await one(`select actor_user_id::text as who from audit_logs
      where tenant_id = $1 and action = 'control.money.account_freeze'
      order by ts desc limit 1`, [TP]);
    check("the freeze is signed by the seat that held the duty, not by the seat that owns the desk",
      whoAudit?.who === uIce, whoAudit);
    const leaked = await one(`select count(*)::int as n from audit_logs where tenant_id = $1
      and action like 'control.money.%'
      and (coalesce(before, '{}'::jsonb)::text || coalesce(after, '{}'::jsonb)::text)
        ~* 'idempotenc'`, [TP]);
    check("no money audit line carries an idempotency key, which belongs to the request and not to the book",
      leaked?.n === 0, leaked);
  } finally {
    // The chart this run opened has no legs under it, so it can go; the office's book never had a
    // leg added by this run, so nothing in it has to.
    await sweep();
    const clean = await books();
    const NOW = await one(`select
        (select count(*)::int from money_accounts where tenant_id = $1) as accounts,
        (select count(*)::int from money_postings where tenant_id = $1) as postings`, [PLAT]);
    check("this run's two books, their three chart lines, their seats and their sessions are gone",
      clean.accounts === 0 && clean.legs === 0 && clean.postings === 0
      && (await one(`select count(*)::int as n from tenants where name like $1`, [TENANT_SWEEP])).n === 0,
      { clean, tenants: (await one(`select count(*)::int as n from tenants where name like $1`,
        [TENANT_SWEEP])).n });
    check("…leftovers are counted by book and by name prefix, never by the shape of a code: 133's "
      + "own office chart holds GATE-WAIT, so a sweep written as `code ilike 'gate-%'` would have "
      + "deleted a line of the platform's book",
      (await one(`select count(*)::int as n from money_accounts where code like 'SMK-%'`)).n === 0);
    check("the office's own book is exactly what this run found — ten chart lines and no movement",
      NOW.accounts === BASE.accounts && NOW.postings === BASE.postings
      && (await one("select count(*)::int as n from money_entries")).n === BASE.legs_all, NOW);
    check("…and the whole schema holds no leg at all, which is the only teardown a ledger allows",
      (await one("select count(*)::int as n from money_postings")).n === BASE.books_all, BASE);
    await oi(`delete from rate_limits where bucket like 'money%'`);
    await owner.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "all checks passed"} — marker ${MARK} `
    + `(${Math.round((Date.now() - START) / 1000)}s)`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
