/**
 * Wallets, holds and payouts over HTTP — smoke for #344h/#344i (migration 134,
 * control-money-moves.routes.ts, the wallets/escrow/payouts panels of /control/money).
 *
 * verify-money-moves-sql.ts proves the registers: the guards under the doors, the two-seat rule, the
 * legs each door composes, and what a hand can still write when it bypasses the doors. It runs inside
 * one transaction that is rolled back, so it cannot prove the four things only HTTP can:
 *
 *  - that 134's three new duties are really three at the desk — the pen that raises a payout cannot
 *    stop a wallet, the seat that stops a wallet cannot read a payee's number, and the billing admin
 *    who may sign a payout away has no standing to open the line it travels on;
 *  - that the route's guards fire before a door is reached, and that a door's own answer keeps its
 *    sentence: `134:` off the front, nothing else rewritten, and the absent rows answered as 404
 *    rather than as a validation failure;
 *  - that a payee line leaves the desk in three pieces and never as one — the board carries a tail and
 *    a boolean, the detail carries no hash, the CSV has no column for the number, and the one route
 *    that opens it writes an audit row that names the paper and not the digits;
 *  - that two office books are two worlds: a second platform tenant's wallet and payout are not in
 *    this book's boards, details, exports or reveals.
 *
 * WHAT THIS RUN DELIBERATELY DOES NOT DO: it never lets a movement commit. `money_postings` refuses
 * DELETE and `money_entries` refuses UPDATE and DELETE, so one accepted fund, hold, release or
 * payment would be permanent — the gate books those in a transaction it rolls back, and this run
 * proves the accepted-write paths of 133's ledger smoke instead. Every door here is reached only as a
 * refusal, an accepted write that books nothing (a wallet, a payout paper, a batch, a signature), or a
 * read. At the end the whole schema must hold exactly the movements this run found when it started.
 *
 * SAFETY: both books and all five companies are this run's own synthetic tenants, found by name prefix
 * at teardown; the office's real book is snapshotted and re-measured. Audit lines stay behind on
 * purpose — `prevent_audit_mutation()` refuses the owner too. No real company is touched: WEMA LTD is
 * never a payee, a holder or a seat.
 *
 * Run: npx tsx scripts/smoke-money-moves.ts   (API on :4000)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { decryptField, searchHash, sha256 } from "../src/util/crypto.js";

const API = "http://localhost:4000/api/v1";

const STAMP = Date.now().toString().slice(-8);
const MARK = `mm${STAMP}`;
const TENANT_SWEEP = "MM Smoke %";
const EMAIL_SWEEP = `smoke.mm.%@waisha.test`;
const CODE_SWEEP = "MM Smoke%";

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
/** A door's or a guard's sentence lands in `error.message`; a zod refusal lands one level down in
 *  `details` as `{field, message}`; and 134's own doors land the *figures* they name in the same
 *  detail object under their own keys (`amount`, `fee`, `wallet_currency`, `holder`). All three are
 *  joined, so a check that says "the refusal prints both figures" cannot pass on the sentence alone
 *  and a check on the sentence cannot pass on a stray number. */
const words = (r: { json: any }) => [String(r.json?.error?.message ?? ""),
  ...(Array.isArray(r.json?.error?.details)
    ? r.json.error.details.map((d: any) => typeof d === "object" && d !== null
      ? [String(d.field ?? ""), String(d.message ?? ""),
        ...Object.entries(d).filter(([k, v]) => !["field", "message"].includes(k)
          && ["string", "number", "boolean"].includes(typeof v))
        .map(([k, v]) => `${k}:${v}`)].filter(Boolean).join(" ")
      : String(d)) : [])].join(" | ");

type Book = Record<string, any>;

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const one = async (sql: string, params: any[] = []) => (await oi(sql, params)).rows[0];
  /** A read-back of a row this run was told it had written. An empty id here means a door refused the
   *  write and an earlier `check` above already printed the FAIL — binding `''` to a uuid parameter
   *  would come back as Postgres' own 22P02, which reads as a database fault and hides the refusal
   *  that caused it. So the run says which table it lost and stops, rather than limping on through
   *  the phases that depend on that row. */
  const row = async (t: string, id: string): Promise<Book> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) {
      throw new Error(`no ${t} row to read back: the door never returned an id (${JSON.stringify(id)}). `
        + "An earlier check in this phase FAILed — read the line above it.");
    }
    return (await one(`select * from ${t} where id = $1::uuid`, [id])) as Book;
  };

  // The office's real book, and what it holds before this run touches anything.
  const PLAT = (await oi(
    `select id from tenants where type = 'platform' and deleted_at is null
      and name not like $1 order by created_at limit 1`, [TENANT_SWEEP])).rows[0]?.id;
  if (!PLAT) throw new Error("no platform tenant to hold the office's book");
  const BASE = await one(`select
      (select count(*)::int from money_accounts where tenant_id = $1) as chart,
      (select count(*)::int from money_postings) as postings,
      (select count(*)::int from money_entries) as legs,
      (select count(*)::int from money_wallets) as wallets_all,
      (select count(*)::int from money_escrow_holds) as holds_all,
      (select count(*)::int from money_payouts) as payouts_all`, [PLAT]);
  const CHART = (await oi(`select code, label, kind, currency from money_accounts
    where tenant_id = $1 order by code`, [PLAT])).rows;
  console.log(`office book found: ${BASE.chart} chart lines, the schema holds ${BASE.postings} `
    + `movements and ${BASE.legs} legs, ${BASE.payouts_all} payout papers`);

  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`,
    [["super_admin", "finance_officer", "compliance_officer", "billing_admin", "platform_analyst",
      "director"]]
  )).rows;
  const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
  const missing = ["super_admin", "finance_officer", "compliance_officer", "billing_admin",
    "platform_analyst", "director"].filter((k) => !rid(k));
  if (missing.length) throw new Error(`global roles missing: ${missing.join(", ")}`);
  // 134's grants are the claim being tested. If a grant never landed, every 403 below would pass for
  // the wrong reason, so the fixture checks its own ground first.
  const grants = await one(`select
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'finance_officer' and rp.permission_key in
          ('control.money.view','control.money.post','control.money.freeze','control.money.pay',
           'control.money.escrow','control.money.reveal')) as pen,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'compliance_officer' and rp.permission_key in
          ('control.money.view','control.money.freeze','control.money.escrow')) as ice,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'billing_admin' and rp.permission_key in
          ('control.money.view','control.money.post','control.money.pay')) as bill,
      (select count(*) from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'platform_analyst' and rp.permission_key like 'control.money.%') as read`);
  if (Number(grants.pen) !== 5 || Number(grants.ice) !== 3 || Number(grants.bill) !== 3
      || Number(grants.read) !== 1) {
    throw new Error(`134's money duties are not on the roles this run grades — ${JSON.stringify(grants)}`);
  }

  // ---------------- fixtures ----------------
  const TP = randomUUID();   // the office this run signs in at
  const TX = randomUUID();   // a second office book, to be kept out of
  const TC = randomUUID();   // a transporter: a wallet holder and a payee
  const TH = randomUUID();   // a second transporter: another holder
  const TS = randomUUID();   // a shipper: a holder that is not a transporter
  const TG = randomUUID();   // a transporter that has been closed
  const uOwner = randomUUID(); // super_admin: everything
  const uPen = randomUUID();   // finance_officer: pay + escrow + reveal, no freeze
  const uIce = randomUUID();   // compliance_officer: escrow only
  const uBill = randomUUID();  // billing_admin: pay, no escrow, no reveal
  const uRead = randomUUID();  // platform_analyst: read only
  const uDir = randomUUID();   // director: no money duty at all
  const uEst = randomUUID();   // a seat in the other office book
  const uBoss = randomUUID();  // a company seat, which is not a control seat at all

  const tok = (who: string) => `${MARK}-${who}`;
  const ck = (who: string) => `waisha_control=${tok(who)}`;

  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    if (!all.length) return;
    const uids = (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
      .rows.map((r: any) => r.id);
    // The order is the register's own: a payout points at a signature and a batch, a batch is kept
    // while it holds lines, and a wallet's liability line is only deletable while it has no legs —
    // which is why nothing in this run is allowed to book one.
    await oi(`delete from money_payouts where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from money_payout_batches where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from money_escrow_holds where tenant_id = any($1::uuid[])`, [all]);
    await oi(`delete from platform_approvals where action like 'money.%'
              and proposed_by = any($1::uuid[])`, [uids.length ? uids : ["00000000-0000-0000-0000-000000000000"]]);
    await oi(`delete from money_wallets where tenant_id = any($1::uuid[])`, [all]);
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
      ($5,'transporter',$6,'active', now() + interval '30 days'),
      ($7,'transporter',$8,'active', now() + interval '30 days'),
      ($9,'shipper',$10,'active', now() + interval '30 days'),
      ($11,'transporter',$12,'active', now() + interval '30 days')`,
    [TP, `MM Smoke Book ${STAMP}`, TX, `MM Smoke Other ${STAMP}`,
      TC, `MM Smoke Cargo Ltd ${STAMP}`, TH, `MM Smoke Haulage ${STAMP}`,
      TS, `MM Smoke Shipper ${STAMP}`, TG, `MM Smoke Gone ${STAMP}`]);
  await oi(`update tenants set deleted_at = now() where id = $1`, [TG]);

  const seat = (id: string, tenant: string, type: string, name: string) =>
    oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,$3,$4,$5,'active',$6, now() - interval '2 hours', now() - interval '200 days')`,
      [id, tenant, type, name, `smoke.mm.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`,
        type === "platform"]);
  await seat(uOwner, TP, "platform", "Miriam Keeper");
  await seat(uPen, TP, "platform", "Faraji Pen");
  await seat(uIce, TP, "platform", "Neema Freeze");
  await seat(uBill, TP, "platform", "Baraka Bill");
  await seat(uRead, TP, "platform", "Asha Reader");
  await seat(uDir, TP, "platform", "Daudi Director");
  await seat(uEst, TX, "platform", "Esther Other");
  await seat(uBoss, TC, "staff", "Beatrice Boss");

  await oi(`insert into user_roles (user_id, role_id) values
        ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10),($11,$12),($13,$14),($15,$16)`,
    [uOwner, rid("super_admin"), uPen, rid("finance_officer"), uIce, rid("compliance_officer"),
      uBill, rid("billing_admin"), uRead, rid("platform_analyst"), uDir, rid("director"),
      uEst, rid("super_admin"), uBoss, rid("director")]);

  const openSession = (uid: string, tenant: string, who: string) =>
    oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-money-moves',$6,
          now() + interval '2 hours')`,
      [randomUUID(), uid, tenant, randomUUID(), sha256(tok(who)), "127.0.0.1"]);
  for (const [uid, tenant, who] of [
    [uOwner, TP, "owner"], [uPen, TP, "pen"], [uIce, TP, "ice"], [uBill, TP, "bill"],
    [uRead, TP, "read"], [uDir, TP, "dir"], [uEst, TX, "est"], [uBoss, TC, "boss"]
  ] as [string, string, string][]) await openSession(uid, tenant, who);

  // Both books need a chart of their own before either can owe anything, and 133's own door is what
  // opens one — never a hand-insert into `money_accounts`. This matters more for the book the run
  // signs in at than for the other one: 134's payout door derives the three lines a paper moves
  // between (COST-OPS, PAYOUT-DUE, OPS-BANK) out of the caller's own chart and refuses a raise that
  // cannot find them, so a fixture book with no chart answers every payout with "this book does not
  // have all three" — which is 134 refusing correctly and the smoke proving nothing.
  for (const [book, actor, suffix] of [[TP, uOwner, ""], [TX, uEst, " (other book)"]] as
    [string, string, string][]) {
    for (const c of CHART.filter((c: any) => c.kind !== "equity")) {
      await oi(`select platform_auth.open_money_account($1,$2,$3,$4,$5,$6,$7)`,
        [book, c.code, `${c.label}${suffix}`, c.kind, c.currency,
          "Opened by the moves smoke so this office book can hold money and owe it out.", actor]);
    }
  }

  const asOwner = { ck: ck("owner") };
  const asPen = { ck: ck("pen") };
  const asIce = { ck: ck("ice") };
  const asBill = { ck: ck("bill") };
  const asRead = { ck: ck("read") };
  const asEst = { ck: ck("est") };

  const MEMO = (s: string) => `${MARK} — ${s}`;
  const PURPOSE = MEMO("The smoke pays the transporter for the corridor run it carried");
  const boards = async () => one(`select
      (select count(*)::int from money_postings where tenant_id = any($1::uuid[])) as postings,
      (select count(*)::int from money_entries where tenant_id = any($1::uuid[])) as legs,
      (select count(*)::int from money_wallets where tenant_id = any($1::uuid[])) as wallets,
      (select count(*)::int from money_escrow_holds where tenant_id = any($1::uuid[])) as holds,
      (select count(*)::int from money_payouts where tenant_id = any($1::uuid[])) as payouts,
      (select count(*)::int from money_payout_batches where tenant_id = any($1::uuid[])) as batches`,
    [[TP, TX]]);
  const audOf = async (entity: string, id: string, action: string): Promise<Book> =>
    (await one(`select actor_user_id::text as actor_user_id, before, after from audit_logs
        where entity = $1 and entity_id = $2::uuid and action = $3
        order by ts desc limit 1`, [entity, id, action])) as Book;

  try {
    // ---------------- 1 · the door ----------------
    phase("1 · the door");
    check("an anonymous request never opens the register",
      (await call("/control/money/wallets")).status === 401);
    check("a cookie with no session row behind it is refused",
      (await call("/control/money/wallets", { ck: `${MARK}-nobody` })).status === 401);
    const asCompany = await call("/control/money/wallets", { ck: ck("boss") });
    check("099: a company seat cannot open the office's desk at all",
      asCompany.status === 401, asCompany.json);

    // ---------------- 2 · the rails ----------------
    phase("2 · the rails the office pays on");
    const rails = await call("/control/money/rails", asPen);
    const rr = (rails.json?.rows ?? []) as Book[];
    check("the rails are read out of the register, with what each one asks for",
      rails.status === 200 && rr.length >= 6 && rr.every((r) => r.code && r.label && r.needs
        && r.family && "retired" in r && "paid" in r), { status: rails.status, n: rr.length });
    const mpesa = rr.find((r) => r.code === "mpesa");
    const cash = rr.find((r) => r.code === "cash");
    check("…and the two shapes a payout can fail on are named by the rail, not by this desk",
      mpesa?.needs === "phone" && cash?.needs === "none" && cash?.family === "cash",
      [mpesa, cash]);
    check("…with nothing paid yet, so no rail carries a figure the desk could mistake for a balance",
      rr.every((r) => Number(r.paid) === 0), rr.map((r) => [r.code, r.paid]));

    // ---------------- 3 · the four duties ----------------
    phase("3 · read, pay, hold and open a number are four duties");
    const reads = await Promise.all([
      call("/control/money/wallets", asPen), call("/control/money/wallets", asIce),
      call("/control/money/wallets", asBill), call("/control/money/wallets", asRead)]);
    check("the pen, the freeze, the billing desk and the analyst all read the wallets",
      reads.every((r) => r.status === 200), reads.map((r) => r.status));
    const noKeyDir = await call("/control/money/wallets", { ck: ck("dir") });
    check("a platform seat with none of the four is refused", noKeyDir.status === 403, noKeyDir.json);
    check("…and the refusal is a duty, not a mystery",
      /control\.money\.view/.test(words(noKeyDir)) || code(noKeyDir) === "FORBIDDEN", words(noKeyDir));

    const open = { method: "POST", body: { owner_tenant: TC, currency: "TZS" } };
    const openIce = await call("/control/money/wallets", { ...open, ck: ck("ice") });
    const openRead = await call("/control/money/wallets", { ...open, ck: ck("read") });
    const openDir = await call("/control/money/wallets", { ...open, ck: ck("dir") });
    check("opening a wallet is the pen's, not the freeze's and not the read's",
      openIce.status === 403 && openRead.status === 403 && openDir.status === 403,
      [openIce.status, openRead.status, openDir.status]);
    const frzBody = { method: "POST", body: { reason: MEMO("A wallet stopped to prove who may stop it") } };
    const frzAsBill = await call("/control/money/wallets/probe/freeze",
      { ...frzBody, ck: ck("bill") });
    check("…and stopping a wallet costs the adjudicator's duty, which the billing seat that opens and "
      + "settles a balance does not hold", frzAsBill.status === 403,
      { status: frzAsBill.status, json: frzAsBill.json });

    const probe = await call("/control/auth/permissions", asOwner);
    const keys: string[] = probe.json?.permissions ?? [];
    check("the permissions probe carries 134's three new duties, or a seat that holds one never sees "
      + "the panel",
      ["control.money.view", "control.money.post", "control.money.freeze", "control.money.pay",
        "control.money.escrow", "control.money.reveal"].every((k) => keys.includes(k)),
      keys.filter((k) => k.startsWith("control.money")));
    const probeBill = await call("/control/auth/permissions", asBill);
    const billKeys: string[] = probeBill.json?.permissions ?? [];
    check("…and reports them per seat, so the desk can say which button it will not press",
      billKeys.includes("control.money.pay") && !billKeys.includes("control.money.escrow")
      && !billKeys.includes("control.money.reveal") && !billKeys.includes("control.money.freeze"),
      billKeys.filter((k) => k.startsWith("control.money")));

    // ---------------- 4 · opening a wallet ----------------
    phase("4 · a holder's balance");
    const noOwner = await call("/control/money/wallets", {
      ck: ck("pen"), method: "POST", body: { currency: "TZS" } });
    check("a wallet with no holder is refused by the desk's own shape", noOwner.status === 400, noOwner.json);
    const badOwner = await call("/control/money/wallets", {
      ck: ck("pen"), method: "POST", body: { owner_tenant: "not-a-uuid" } });
    check("…and so is a holder that is not a row anywhere", badOwner.status === 400, badOwner.json);
    const badMoney = await call("/control/money/wallets", {
      ck: ck("pen"), method: "POST", body: { owner_tenant: TC, currency: "EUR" } });
    check("…and so is a money this book does not keep", badMoney.status === 400, badMoney.json);
    const shortNote = await call("/control/money/wallets", {
      ck: ck("pen"), method: "POST",
      body: { owner_tenant: TC, currency: "TZS", note: "gift" } });
    check("a note that is neither absent nor a sentence is refused", shortNote.status === 400,
      shortNote.json);
    const officeWallet = await call("/control/money/wallets", {
      ck: ck("pen"), method: "POST", body: { owner_tenant: PLAT, currency: "TZS" } });
    check("the office cannot hold money for itself, in the door's own words",
      officeWallet.status === 400 && /is the office itself|not one/i.test(words(officeWallet)),
      words(officeWallet));
    const goneWallet = await call("/control/money/wallets", {
      ck: ck("pen"), method: "POST", body: { owner_tenant: TG, currency: "TZS" } });
    check("…and a company that has been closed is refused a balance to hold",
      goneWallet.status === 400 && /was closed|not one/i.test(words(goneWallet)), words(goneWallet));
    check("none of the six opened a wallet", (await boards()).wallets === 0, await boards());

    const w1 = await call("/control/money/wallets", {
      ck: ck("pen"), method: "POST",
      body: { owner_tenant: TC, currency: "TZS", note: MEMO("Funds the smoke is holding for a run") } });
    const WAL1 = String(w1.json?.wallet?.id ?? "");
    check("a transporter's wallet opens, with the holder's name read off the register",
      w1.status === 200 && w1.json?.ok === true && w1.json?.wallet?.holder === `MM Smoke Cargo Ltd ${STAMP}`
      && w1.json?.wallet?.status === "open", { status: w1.status, wallet: w1.json?.wallet });
    check("…and an empty wallet is a line with no legs, so the balance the door prints is zero and "
      + "nothing was booked", Number(w1.json?.wallet?.balance) === 0
      && (w1.json?.wallet?.movements ?? []).length === 0 && (await boards()).postings === 0,
      await boards());
    const w1Row = await row("money_wallets", WAL1);
    const w1Acc = await row("money_accounts", String(w1Row.account_id));
    check("the liability line is minted from the holder and the money, never typed at the desk",
      w1Row.tenant_id === TP && w1Row.owner_tenant_id === TC && w1Acc.code.startsWith("WLT-")
      && w1Acc.code.endsWith("-TZS") && w1Acc.kind === "liability" && w1Acc.currency === "TZS"
      && w1Acc.tenant_id === TP, { wallet: w1Row, account: { c: w1Acc.code, k: w1Acc.kind } });
    const w1Aud = await audOf("money_wallets", WAL1, "wallet.opened");
    check("the opening is in the register with the seat that opened it and the code it minted",
      String(w1Aud?.actor_user_id) === uPen && w1Aud?.after?.holder === w1Row.holder_name
      && String(w1Aud?.after?.account) === w1Acc.code && w1Aud?.before === null, w1Aud?.after);

    const again = await call("/control/money/wallets", {
      ck: ck("pen"), method: "POST", body: { owner_tenant: TC, currency: "TZS" } });
    check("a second wallet for one holder in one money is a conflict that names the holder",
      again.status === 409 && /already holds a TZS wallet/i.test(words(again))
      && /MM Smoke Cargo Ltd/.test(words(again)), words(again));
    check("…and it left nothing behind, because the door raises before the line is minted",
      (await boards()).wallets === 1 && (await one(`select count(*)::int as n from money_accounts
        where tenant_id = $1 and code like 'WLT-%'`, [TP])).n === 1, await boards());
    const wOpenAud = await one(`select count(*)::int as n from audit_logs where tenant_id = $1
      and action = 'wallet.opened'`, [TP]);
    check("…nor an audit line: the history says one wallet was opened, which is the truth",
      Number(wOpenAud?.n) === 1, wOpenAud);

    const w2 = await call("/control/money/wallets", {
      ck: ck("pen"), method: "POST", body: { owner_tenant: TC, currency: "USD" } });
    const w3 = await call("/control/money/wallets", {
      ck: ck("owner"), method: "POST", body: { owner_tenant: TH, currency: "TZS" } });
    const w4 = await call("/control/money/wallets", {
      ck: ck("bill"), method: "POST", body: { owner_tenant: TS, currency: "TZS" } });
    check("a second money for the same holder is a second balance, and a shipper holds money too",
      w2.status === 200 && w3.status === 200 && w4.status === 200
      && w2.json?.wallet?.currency === "USD" && w4.json?.wallet?.holder === `MM Smoke Shipper ${STAMP}`,
      [w2.status, w3.status, w4.status]);
    check("…and the billing seat may open a balance, because opening is the pen's duty and not the "
      + "adjudicator's", w4.status === 200 && (await boards()).wallets === 4, await boards());
    const WAL3 = String(w3.json?.wallet?.id ?? "");

    // ---------------- 5 · the wallet reads ----------------
    phase("5 · what a wallet read answers, and what it must not");
    const d1 = await call(`/control/money/wallets/${WAL1}`, asRead);
    check("a wallet read carries the balance recomputed from the legs, the line under it and the three "
      + "registers that touch it",
      d1.status === 200 && d1.json?.id === WAL1 && Number(d1.json?.balance) === 0
      && d1.json?.account?.code === w1Acc.code && Array.isArray(d1.json?.movements)
      && Array.isArray(d1.json?.holds) && Array.isArray(d1.json?.withdrawals),
      { keys: Object.keys(d1.json ?? {}) });
    check("…and the seats it names are names, not uuids, because a clerk reads this out loud",
      d1.json?.opened_by === "Faraji Pen" && d1.json?.frozen_by === null
      && d1.json?.owner_name === `MM Smoke Cargo Ltd ${STAMP}` && d1.json?.owner_type === "transporter",
      { opened_by: d1.json?.opened_by, owner: d1.json?.owner_name });
    check("…and no `tenant_id` is printed at all, since the book it belongs to is the caller's own",
      !("tenant_id" in (d1.json ?? {})), Object.keys(d1.json ?? {}));
    const ghostWallet = await call(`/control/money/wallets/${randomUUID()}`, asRead);
    check("a wallet nobody opened is a 404 with the door's own sentence",
      ghostWallet.status === 404 && /no wallet in this book/i.test(words(ghostWallet)),
      { status: ghostWallet.status, message: words(ghostWallet) });
    const badWalletId = await call("/control/money/wallets/not-a-uuid", asRead);
    check("a reference that is not a uuid is refused before a query is made of it",
      badWalletId.status === 400 && /not .*wallet/i.test(words(badWalletId)), words(badWalletId));

    // a wallet in the other office's book, and the one rule that does cross the boundary
    const xw = await call("/control/money/wallets", {
      ck: ck("est"), method: "POST", body: { owner_tenant: TS, currency: "USD" } });
    const XW = String(xw.json?.wallet?.id ?? "");
    check("the second office book opens a balance of its own, for a money neither book has held for "
      + "that holder",
      xw.status === 200 && XW !== "" && XW !== WAL1 && xw.json?.wallet?.currency === "USD"
      && xw.json?.wallet?.holder === `MM Smoke Shipper ${STAMP}`,
      { status: xw.status, id: XW });
    const xwAgain = await call("/control/money/wallets", {
      ck: ck("est"), method: "POST", body: { owner_tenant: TH, currency: "TZS" } });
    check("…and one holder's balance in one money is one line across the office's books, not one per "
      + "book: the other book is answered as a conflict naming who already holds it",
      xwAgain.status === 409 && /already holds a TZS wallet/i.test(words(xwAgain))
      && /MM Smoke Haulage/.test(words(xwAgain)) && (await boards()).wallets === 5,
      words(xwAgain));
    const crossWallet = await call(`/control/money/wallets/${XW}`, asPen);
    check("…which this book cannot read: another office's wallet is a 404 here, not a row",
      crossWallet.status === 404, { status: crossWallet.status, json: crossWallet.json });
    const wBoard = await call("/control/money/wallets?status=all", asPen);
    const wX = await call("/control/money/wallets?status=all", asEst);
    check("…and neither board shows the other's balance",
      (wBoard.json?.rows ?? []).every((r: Book) => String(r.id) !== XW)
      && (wX.json?.rows ?? []).every((r: Book) => ![WAL1, WAL3].includes(String(r.id)))
      && (wX.json?.rows ?? []).length === 1,
      { tp: (wBoard.json?.rows ?? []).length, tx: (wX.json?.rows ?? []).map((r: Book) => r.id) });

    const badStatus = await call("/control/money/wallets?status=nonsense", asRead);
    check("a status word the board cannot filter on is refused, not answered with an empty page",
      badStatus.status === 400, badStatus.status);
    const badMoneyQuery = await call("/control/money/wallets?currency=EUR", asRead);
    check("…and so is a money the book does not keep", badMoneyQuery.status === 400, badMoneyQuery.status);
    const emptySearch = await call("/control/money/wallets?search=", asRead);
    check("an empty search is refused instead of pretending to be a filter",
      emptySearch.status === 400, emptySearch.status);
    const bigPage = await call("/control/money/wallets?limit=5000", asRead);
    check("a page of five thousand wallets is refused rather than run", bigPage.status === 400, bigPage.status);
    const unknownQuery = await call("/control/money/wallets?widget=1", asRead);
    check("…and so is a query string the desk has no meaning for",
      unknownQuery.status === 400, unknownQuery.status);

    // ---------------- 6 · stop and restart a balance ----------------
    phase("6 · stopping a holder's money");
    const frzPath = `/control/money/wallets/${WAL1}/freeze`;
    const frzNoReason = await call(frzPath, { ck: ck("ice"), method: "POST", body: {} });
    check("a freeze with no reason is refused — it is the stop that has to be readable",
      frzNoReason.status === 400, frzNoReason.json);
    const frzShort = await call(frzPath, { ck: ck("ice"), method: "POST", body: { reason: "audit" } });
    check("…and so is a reason too short for a holder to be told", frzShort.status === 400, frzShort.json);
    check("…and the wallet is still open",
      (await row("money_wallets", WAL1)).status === "open");
    const frzByBill = await call(frzPath, {
      ck: ck("bill"), method: "POST", body: { reason: MEMO("Stopped by the billing desk to see who may") } });
    check("the seat that may open a wallet may not stop one — the freeze is the adjudicator's duty, "
      + "one level up from the pen that pays", frzByBill.status === 403, frzByBill.json);

    const WHY = MEMO("Held while the smoke proves who may stop a balance");
    const frz = await call(frzPath, { ck: ck("ice"), method: "POST", body: { reason: WHY } });
    const frzRow = await row("money_wallets", WAL1);
    const frzAcc = await row("money_accounts", String(frzRow.account_id));
    check("the adjudicating seat stops it, and the book line under it is stopped in the same call",
      frz.status === 200 && frz.json?.wallet?.status === "frozen" && frzRow.status === "frozen"
      && frzRow.frozen_reason === WHY && String(frzRow.frozen_by) === uIce && !!frzRow.frozen_at
      && frzAcc.status === "frozen", { wallet: { s: frzRow.status }, acc: { s: frzAcc.status } });
    check("…which is the coupling the desk cannot do for itself: 133's leg guard is the thing that "
      + "actually refuses a movement, so a wallet stopped without its line would still take money",
      /Wallet stopped:/.test(String(frzAcc.frozen_reason ?? "")), frzAcc.frozen_reason);
    const frzAgain = await call(frzPath, { ck: ck("ice"), method: "POST", body: { reason: WHY } });
    check("stopping it twice names the holder and the reason that is already there, as a conflict",
      frzAgain.status === 409 && code(frzAgain) === "CONFLICT"
      && /MM Smoke Cargo Ltd/.test(words(frzAgain))
      && /who may stop a balance/.test(words(frzAgain)), words(frzAgain));
    const frozenFund = await call(`/control/money/wallets/${WAL1}/fund`, {
      ck: ck("pen"), method: "POST", headers: { "Idempotency-Key": `${MARK}-fzf` },
      body: { amount: "500000", from: "bank", memo: MEMO("Money into a stopped balance") } });
    check("a stopped balance takes no money, and the refusal carries the sentence the holder was told",
      frozenFund.status === 400 && /This wallet is frozen/i.test(words(frozenFund))
      && /who may stop a balance/.test(words(frozenFund)) && (await boards()).postings === 0,
      words(frozenFund));
    const frozenEscrow = await call("/control/money/escrow", {
      ck: ck("ice"), method: "POST", headers: { "Idempotency-Key": `${MARK}-fze` },
      body: { subject_kind: "call", subject_id: randomUUID(), amount: "50000", currency: "TZS",
        payer_wallet: WAL1, reason_code: "complaint", reason: MEMO("A call whose money is parked") } });
    check("…and neither can a hold be parked against it",
      frozenEscrow.status === 400 && /stopped wallet/i.test(words(frozenEscrow)), words(frozenEscrow));
    const frzGhost = await call(`/control/money/wallets/${randomUUID()}/freeze`, {
      ck: ck("ice"), method: "POST", body: { reason: WHY } });
    check("stopping a balance the book does not hold is a 404 before the reason is asked for",
      frzGhost.status === 404, { status: frzGhost.status, json: frzGhost.json });

    const lift = await call(`/control/money/wallets/${WAL1}/unfreeze`, {
      ck: ck("ice"), method: "POST", body: { reason: MEMO("The smoke proved the stop, so it is lifted") } });
    const liftRow = await row("money_wallets", WAL1);
    const liftAcc = await row("money_accounts", String(liftRow.account_id));
    check("the same duty starts it again, clearing the reason from the wallet and from the line",
      lift.status === 200 && lift.json?.wallet?.status === "open" && liftRow.status === "open"
      && liftRow.frozen_reason === null && liftRow.frozen_by === null
      && liftAcc.status === "open" && liftAcc.frozen_reason === null,
      { wallet: liftRow.status, acc: liftAcc.status });
    const liftAgain = await call(`/control/money/wallets/${WAL1}/unfreeze`, {
      ck: ck("ice"), method: "POST", body: {} });
    check("starting a balance that was never stopped is a conflict, not a silent no-op, and it says "
      + "whose balance the desk is asking about",
      liftAgain.status === 409 && code(liftAgain) === "CONFLICT"
      && /MM Smoke Cargo Ltd/.test(words(liftAgain)), words(liftAgain));
    const frzAud = await audOf("money_wallets", WAL1, "wallet.frozen");
    const lifAud = await audOf("money_wallets", WAL1, "wallet.unfrozen");
    check("both halves of the stop are in the register, signed by the seat that held the duty and "
      + "with the balance the door read",
      String(frzAud?.actor_user_id) === uIce && String(lifAud?.actor_user_id) === uIce
      && Number(frzAud?.after?.balance) === 0 && frzAud?.after?.account === w1Acc.code
      && frzAud?.before?.status === "open" && lifAud?.before?.status === "frozen",
      { frozen: frzAud?.after, unfrozen: lifAud?.before });

    // ---------------- 7 · the money that must not arrive ----------------
    phase("7 · every way in that this run refuses");
    const fund = (over: Record<string, any>, key = `${MARK}-f`, who = "pen",
      wallet = WAL1) => call(`/control/money/wallets/${wallet}/fund`, {
        ck: ck(who), method: "POST", headers: { "Idempotency-Key": key },
        body: { amount: "500000", from: "bank", memo: MEMO("Money that will not be booked"), ...over }
      });
    const noKey = await call(`/control/money/wallets/${WAL1}/fund`, {
      ck: ck("pen"), method: "POST",
      body: { amount: "500000", from: "bank", memo: MEMO("A funding sent with no key at all") } });
    check("a funding with no Idempotency-Key is refused, because a retry would book it twice",
      noKey.status === 400 && /Idempotency-Key/.test(words(noKey)), words(noKey));
    const tinyKey = await fund({}, "tiny", "pen");
    check("…and so is a key too short to be quoted back six months later",
      tinyKey.status === 400 && /8 to 140/.test(words(tinyKey)), words(tinyKey));
    const fundAsRead = await fund({}, `${MARK}-rd`, "read");
    check("the read does not open the pen", fundAsRead.status === 403, fundAsRead.json);
    const comma = await fund({ amount: "1,000.00" }, `${MARK}-cm`);
    check("a figure with a thousand separator in it is refused by the desk's own shape",
      comma.status === 400 && /no separators/i.test(words(comma)), words(comma));
    const threePlaces = await fund({ amount: "1.005" }, `${MARK}-mil`);
    check("…and so is a third decimal, which the book cannot hold",
      threePlaces.status === 400, threePlaces.json);
    const zero = await fund({ amount: "0" }, `${MARK}-zero`);
    check("a funding of nothing is refused by the door, in its own sentence",
      zero.status === 400 && /above zero/i.test(words(zero)), words(zero));
    const badFrom = await fund({ from: "mpesa" }, `${MARK}-from`);
    check("a line the desk has no word for is refused before the inflow is asked",
      badFrom.status === 400, badFrom.json);
    const phantomDay = await fund({ posted_on: "2026-02-30" }, `${MARK}-feb`);
    check("a shape that is a valid string and not a valid day is refused here rather than reaching "
      + "Postgres and coming back as a server fault",
      phantomDay.status === 400 && /no day 2026-02-30 on a calendar/i.test(words(phantomDay)),
      words(phantomDay));
    const ghostFund = await fund({}, `${MARK}-gh`, "pen", randomUUID());
    check("money cannot be put into a wallet this book does not hold, and that is a 404",
      ghostFund.status === 404, { status: ghostFund.status, json: ghostFund.json });
    const xFund = await fund({}, `${MARK}-xf`, "pen", XW);
    check("…nor into the other office's wallet, which is the same refusal for the same reason",
      xFund.status === 404, { status: xFund.status });
    const usdGateway = await fund({ amount: "500", from: "gateway" }, `${MARK}-gw`, "pen",
      String(w2.json?.wallet?.id ?? ""));
    check("the gateway cannot fund a USD balance, because the office has no USD gateway line to take "
      + "it from — 135's reconciliation is where that money will land",
      usdGateway.status === 400 && /no USD gateway line/i.test(words(usdGateway)), words(usdGateway));
    const badMemo = await fund({ memo: "late" }, `${MARK}-memo`);
    check("a memo too short to explain where the money came from is refused",
      badMemo.status === 400, badMemo.json);

    const move = (over: Record<string, any>, key = `${MARK}-m`, who = "pen") =>
      call("/control/money/wallets/move", {
        ck: ck(who), method: "POST", headers: { "Idempotency-Key": key },
        body: { from_wallet: WAL1, to_wallet: WAL3, amount: "10000",
          memo: MEMO("One holder paying another, refused"), ...over }
      });
    const selfPay = await move({ to_wallet: WAL1 }, `${MARK}-self`);
    check("a wallet cannot pay itself — a movement with nothing in it is refused before the door",
      selfPay.status === 400 && /cannot pay itself/i.test(words(selfPay)), words(selfPay));
    const noKeyMove = await call("/control/money/wallets/move", {
      ck: ck("pen"), method: "POST",
      body: { from_wallet: WAL1, to_wallet: WAL3, amount: "10000", memo: MEMO("A transfer with no key") } });
    check("a balance transfer with no Idempotency-Key is refused too",
      noKeyMove.status === 400 && /Idempotency-Key/.test(words(noKeyMove)), words(noKeyMove));
    const fromGhost = await move({ from_wallet: randomUUID() }, `${MARK}-fg`);
    check("a transfer out of a wallet the book does not hold is a 404 naming which side was missing",
      fromGhost.status === 404, { status: fromGhost.status, json: fromGhost.json });
    const toGhost = await move({ to_wallet: randomUUID() }, `${MARK}-tg`);
    check("…and so is one into it", toGhost.status === 404, { status: toGhost.status });
    const crossMove = await move({ to_wallet: XW }, `${MARK}-xm`);
    check("a transfer into the other office's wallet is refused the same way, not answered as a "
      + "balance that would have been wrong",
      crossMove.status === 404, { status: crossMove.status });

    const esc = (over: Record<string, any>, key = `${MARK}-e`, who = "ice") =>
      call("/control/money/escrow", {
        ck: ck(who), method: "POST", headers: { "Idempotency-Key": key },
        body: { subject_kind: "call", subject_id: randomUUID(), amount: "25000", currency: "TZS",
          payer_wallet: WAL3, reason_code: "complaint",
          reason: MEMO("A call whose money the office is holding back"), ...over }
      });
    const escAsBill = await esc({}, `${MARK}-e-bill`, "bill");
    const escAsRead = await esc({}, `${MARK}-e-read`, "read");
    check("parking money is the adjudicator's duty, refused to the billing desk that pays and the "
      + "analyst who reads the book",
      escAsBill.status === 403 && escAsRead.status === 403, [escAsBill.status, escAsRead.status]);
    const escNoSource = await call("/control/money/escrow", {
      ck: ck("ice"), method: "POST", headers: { "Idempotency-Key": `${MARK}-e-no` },
      body: { subject_kind: "call", subject_id: randomUUID(), amount: "25000", currency: "TZS",
        reason_code: "complaint", reason: MEMO("A hold that names no line at all") } });
    check("a hold that says neither whose wallet nor which office line is refused by the desk",
      escNoSource.status === 400 && /where the money came from/i.test(words(escNoSource)),
      words(escNoSource));
    const escNoKey = await call("/control/money/escrow", {
      ck: ck("ice"), method: "POST",
      body: { subject_kind: "call", subject_id: randomUUID(), amount: "25000", currency: "TZS",
        payer_wallet: WAL3, reason_code: "complaint", reason: MEMO("A hold sent with no key") } });
    check("…and so is one sent without a key, which is the only way an office parks the same money "
      + "twice", escNoKey.status === 400 && /Idempotency-Key/.test(words(escNoKey)), words(escNoKey));
    const escBadReason = await esc({ reason_code: "because" }, `${MARK}-e-br`);
    check("a reason the seven are not is refused by the desk's own list",
      escBadReason.status === 400, escBadReason.json);
    const escPayerGhost = await esc({ payer_wallet: randomUUID() }, `${MARK}-e-pg`);
    check("a hold cannot be raised against a wallet this book does not hold",
      escPayerGhost.status === 404, { status: escPayerGhost.status, json: escPayerGhost.json });
    const escOtherMoney = await esc({ currency: "USD" }, `${MARK}-e-us`);
    check("a USD hold against a TZS balance is refused with both figures named, before any money moves",
      escOtherMoney.status === 400 && /different money/i.test(words(escOtherMoney))
      && /TZS/.test(words(escOtherMoney)), words(escOtherMoney));
    const planGhost = await call(`/control/money/escrow/${randomUUID()}/plan`, {
      ck: ck("ice"), method: "POST",
      body: { kind: "split", to_payee: "10", back_to_payer: "10", fee_amount: "0",
        payee_wallet: WAL3, reason: MEMO("A plan on a hold that is not there") } });
    check("a plan on a hold the book does not have is a 404, and the arithmetic was never asked",
      planGhost.status === 404, { status: planGhost.status, json: planGhost.json });
    const planNoWallet = await call(`/control/money/escrow/${randomUUID()}/plan`, {
      ck: ck("ice"), method: "POST", body: { kind: "released", reason: MEMO("Money out with no holder "
        + "to take it") } });
    check("a plan that takes money out of escrow toward no holder is refused by the desk first",
      planNoWallet.status === 400 && /holder's wallet/i.test(words(planNoWallet)), words(planNoWallet));
    const planRefundPayee = await call(`/control/money/escrow/${randomUUID()}/plan`, {
      ck: ck("ice"), method: "POST",
      body: { kind: "refunded", payee_wallet: WAL3, reason: MEMO("A refund that names a payee") } });
    check("…and a refund that names one instead of the payer is refused in the same breath",
      planRefundPayee.status === 400 && /cannot name a payee/i.test(words(planRefundPayee)),
      words(planRefundPayee));
    const refuseGhost = await call(`/control/money/escrow/${randomUUID()}/refuse`, {
      ck: ck("ice"), method: "POST", body: { note: MEMO("Refusing a plan that was never proposed") } });
    check("refusing a plan on no hold is a 404", refuseGhost.status === 404, refuseGhost.status);
    const boardOfHolds = await call("/control/money/escrow?status=all", asIce);
    check("the escrow board of a book with no holds is an empty page, with the counters the desk prints",
      boardOfHolds.status === 200 && (boardOfHolds.json?.rows ?? []).length === 0
      && boardOfHolds.json?.count === 0, boardOfHolds.json);
    const raisedFilter = await call("/control/money/escrow?status=raised", asIce);
    check("…and the desk refuses to filter on a state a hold never survives, because the words a "
      + "clerk types are the board's problem",
      raisedFilter.status === 400 && /look at .held/i.test(words(raisedFilter)), words(raisedFilter));
    const holdAfter = await boards();
    check("not one of those attempts parked a franc: no hold, no movement, no leg in either book",
      holdAfter.holds === 0 && holdAfter.postings === 0 && holdAfter.legs === 0, holdAfter);

    // ---------------- 8 · the payout paper ----------------
    phase("8 · raising a payout, and the line it travels on");
    const raise = (over: Record<string, any>, who = "pen") => call("/control/money/payouts", {
      ck: ck(who), method: "POST",
      body: { payee_kind: "company", payee_id: TC, rail: "mpesa", payee_line: "0712345678",
        amount: "500000", currency: "TZS", source_kind: "manual", purpose: PURPOSE, ...over }
    });
    const otherNoName = await raise({ payee_kind: "other", payee_id: undefined });
    check("a payee the registers do not know has to be named by the desk that pays them",
      otherNoName.status === 400 && /has to be named/i.test(words(otherNoName)), words(otherNoName));
    const otherWithId = await raise({ payee_kind: "other", payee_name: "Mama Ntilie Supplies",
      payee_id: TC });
    check("…and a typed name cannot carry an id, which would point at a row the paper ignores",
      otherWithId.status === 400 && /cannot carry an id/i.test(words(otherWithId)), words(otherWithId));
    const companyNoId = await raise({ payee_id: undefined, payee_name: "Some Company" });
    check("a company payee has to be a row, not a name the desk liked",
      companyNoId.status === 400 && /already has a paper/i.test(words(companyNoId)), words(companyNoId));
    const companyTyped = await raise({ payee_name: "Some Company" });
    check("…and the register's name wins, so the desk cannot retype who the money went to",
      companyTyped.status === 400 && /read off the company/i.test(words(companyTyped)),
      words(companyTyped));
    const badRail = await raise({ rail: "dollar" });
    check("a rail the office does not pay on is answered with the rails it does offer",
      badRail.status === 400 && /does not pay on a rail/i.test(words(badRail)), words(badRail));
    const cashWithLine = await raise({ rail: "cash", payee_line: "0712345678" });
    check("a cash payout that carries an account line is refused, because the number would be read "
      + "out to the wrong person",
      cashWithLine.status === 400 && /hands the money over at the desk/i.test(words(cashWithLine)),
      words(cashWithLine));
    const noLine = await raise({ payee_line: undefined });
    check("a mobile-money payout with no number is refused before the paper exists",
      noLine.status === 400 && /the paper has to carry it/i.test(words(noLine)), words(noLine));
    const shortLine = await raise({ payee_line: "0712345" });
    check("a line that is not a Tanzanian number is refused, with the shapes the rails pay printed",
      shortLine.status === 400 && /Tanzanian number/i.test(words(shortLine)), words(shortLine));
    const foreignLine = await raise({ payee_line: "+254712345678" });
    check("…and so is a valid foreign number, which no rail here pays",
      foreignLine.status === 400 && /Tanzanian number/i.test(words(foreignLine)), words(foreignLine));
    const zeroEight = await raise({ payee_line: "0812345678" });
    check("…and an 08 number is refused too, by a sentence that does not offer the shape it just "
      + "refused: the rails pay the 6 and 7 series, and a guard whose promise is wider than its rule "
      + "teaches a desk to type a line nobody can pay",
      zeroEight.status === 400 && /Tanzanian number/i.test(words(zeroEight))
      && !/08…/.test(String(zeroEight.json?.error?.message ?? "")), words(zeroEight));
    const refundNoId = await raise({ source_kind: "refund" });
    check("a refund payout has to name the paper it stands on",
      refundNoId.status === 400 && /that paper's id has to be on this one/i.test(words(refundNoId)),
      words(refundNoId));
    const refundGhost = await raise({ source_kind: "refund", source_id: randomUUID() });
    check("…and a refund the service register does not have is a 404, not a validation failure",
      refundGhost.status === 404 && /no refund paper behind/i.test(words(refundGhost)),
      { status: refundGhost.status, message: words(refundGhost) });
    const costNoRef = await raise({ source_kind: "cost" });
    check("a cost payout has to say which cost it settles",
      costNoRef.status === 400 && /says which cost it settles/i.test(words(costNoRef)), words(costNoRef));
    const feeTooBig = await raise({ amount: "1000", fee_amount: "1500" });
    check("the office's cut cannot be bigger than the money it rides on, and the refusal prints both",
      feeTooBig.status === 400 && /cannot be below zero or bigger/i.test(words(feeTooBig))
      && /1000/.test(words(feeTooBig)), words(feeTooBig));
    const ghostCompany = await raise({ payee_id: randomUUID() });
    check("a company this book has never had is refused by the guard rather than by a foreign key",
      ghostCompany.status === 400 && /the office has no company/i.test(words(ghostCompany)),
      words(ghostCompany));
    const raiseAsRead = await raise({ rail: "cash", payee_line: undefined }, "read");
    check("the analyst who reads the book cannot write a payout into it",
      raiseAsRead.status === 403, raiseAsRead.json);
    check("none of those sixteen raised a paper", (await boards()).payouts === 0, await boards());

    const p1 = await raise({ fee_amount: "10000", purpose: PURPOSE });
    const P1 = String(p1.json?.payout?.id ?? "");
    check("a payout opens on the register's name, the tail of the line and the three lines it will move "
      + "between",
      p1.status === 200 && p1.json?.payout?.status === "raised"
      && p1.json?.payout?.payee_name === `MM Smoke Cargo Ltd ${STAMP}`
      && p1.json?.payout?.payee_kind === "company" && p1.json?.payout?.line_sealed === true
      && /^PAY-\d{4}-\d{5}$/.test(String(p1.json?.payout?.ref))
      && Number(p1.json?.payout?.total) === 510000, { status: p1.status, p: p1.json?.payout });
    const p1Row = await row("money_payouts", P1);
    check("…the tail is the last four digits and nothing else of the number is in the read",
      p1Row.payee_ref_tail === "5678" && p1.json?.payout?.payee_ref_tail === "5678"
      && !("payee_ref_encrypted" in (p1.json?.payout ?? {})),
      { tail: p1Row.payee_ref_tail, keys: Object.keys(p1.json?.payout ?? {}) });
    check("…and the bytes behind it are not this desk's plaintext: the stored line opens back to the "
      + "canonical number, so a phone typed four ways is provably one line",
      decryptField(p1Row.payee_ref_encrypted as Buffer) === "+255712345678"
      && p1Row.payee_ref_hash === searchHash("+255712345678"),
      { dec: decryptField(p1Row.payee_ref_encrypted as Buffer) });
    check("…with the office's own liability line chosen by the money and the source rather than typed",
      (await row("money_accounts", String(p1Row.payable_account_id))).code === "PAYOUT-DUE"
      && (await row("money_accounts", String(p1Row.fund_account_id))).code === "COST-OPS"
      && (await row("money_accounts", String(p1Row.cash_account_id))).code === "OPS-BANK"
      && p1Row.status === "raised" && p1Row.accrual_posting_id === null
      && p1Row.approval_id === null, { payable: p1Row.payable_account_id });
    const p1Aud = await audOf("money_payouts", P1, "payout.raised");
    check("the paper is audited with the tail and the hash but never the number, so a register leak "
      + "is not a phone-book leak",
      String(p1Aud?.actor_user_id) === uPen && p1Aud?.after?.payee_ref_tail === "5678"
      && /^[0-9a-f]{64}$/.test(String(p1Aud?.after?.payee_ref_hash ?? ""))
      && !/255712345678/.test(JSON.stringify(p1Aud?.after ?? {})),
      { keys: Object.keys(p1Aud?.after ?? {}) });

    const p1same = await raise({ payee_line: "+255 712 345 678", purpose: MEMO("The same line typed "
      + "off a printed sheet, with the spaces a clerk keeps") });
    const P1S = String(p1same.json?.payout?.id ?? "");
    check("the same number typed with spaces and a country code is the same line, proved without "
      + "anybody opening it",
      p1same.status === 200 && (await row("money_payouts", P1S)).payee_ref_hash === p1Row.payee_ref_hash
      && (await row("money_payouts", P1S)).payee_ref_tail === "5678",
      { same: (await row("money_payouts", P1S)).payee_ref_hash });
    const pBank = await raise({ rail: "bank", payee_line: "DS/0123/4",
      purpose: MEMO("A bank payout whose line is a teller's shorthand") });
    const PB = String(pBank.json?.payout?.id ?? "");
    check("a bank line is kept as the bank printed it, slashes and spaces taken out",
      pBank.status === 200 && decryptField((await row("money_payouts", PB)).payee_ref_encrypted as Buffer)
        === "DS01234" && (await row("money_payouts", PB)).payee_ref_tail === "1234",
      { tail: (await row("money_payouts", PB)).payee_ref_tail });
    const pCash = await raise({ rail: "cash", payee_line: undefined,
      purpose: MEMO("Cash handed over at the office desk, signed and receipted") });
    const PC = String(pCash.json?.payout?.id ?? "");
    check("a cash payout carries no line at all, and the read says so rather than printing an empty "
      + "tail",
      pCash.status === 200 && (await row("money_payouts", PC)).payee_ref_encrypted === null
      && (await row("money_payouts", PC)).payee_ref_hash === null
      && pCash.json?.payout?.line_sealed === false, { sealed: pCash.json?.payout?.line_sealed });
    const pOther = await raise({ payee_kind: "other", payee_id: undefined,
      payee_name: "=Equity (Testing) Ltd", rail: "cash", payee_line: undefined,
      purpose: "=SUM(A1:A9)+cmd" });
    const PO = String(pOther.json?.payout?.id ?? "");
    check("a payee the registers have no row for is kept exactly as the desk named them",
      pOther.status === 200 && (await row("money_payouts", PO)).payee_name === "=Equity (Testing) Ltd"
      && pOther.json?.payout?.payee_tenant_id === null, { name: pOther.json?.payout?.payee_name });

    const detail = await call(`/control/money/payouts/${P1}`, asRead);
    check("the payout detail the second seat reads carries the paper, the three lines and the "
      + "signature state — and no hash, which this desk strips",
      detail.status === 200 && detail.json?.ref === p1Row.ref && Number(detail.json?.total) === 510000
      && detail.json?.fund?.code === "COST-OPS" && detail.json?.approval === null
      && detail.json?.accrual_posting === null
      && !("payee_ref_hash" in (detail.json ?? {}))
      && !("payee_ref_encrypted" in (detail.json ?? {})),
      { keys: Object.keys(detail.json ?? {}).filter((k) => k.startsWith("payee")) });
    const crossPayout = await call(`/control/money/payouts/${P1}`, asEst);
    check("the other office book cannot read this payout, and is answered as a 404 rather than a "
      + "permission problem", crossPayout.status === 404, { status: crossPayout.status });
    check("…and the same is true of its id in a filter: the board answers with rows of this book only",
      (await call(`/control/money/payouts?batch=${P1}`, asPen)).json?.rows?.length === 0);

    // ---------------- 9 · the signature this desk cannot give itself ----------------
    phase("9 · asking a second seat, and refusing the paper");
    const REASON = MEMO("The corridor run is delivered and the receipt is on the file");
    const propAsRead = await call(`/control/money/payouts/${P1}/propose`, {
      ck: ck("read"), method: "POST", body: { reason: REASON } });
    check("asking for a signature is the pen's duty, not the reader's",
      propAsRead.status === 403, propAsRead.json);
    const propNoReason = await call(`/control/money/payouts/${P1}/propose`, {
      ck: ck("pen"), method: "POST", body: {} });
    check("a signature asked for with no sentence is refused by the desk's own shape",
      propNoReason.status === 400, propNoReason.json);
    const propGhost = await call(`/control/money/payouts/${randomUUID()}/propose`, {
      ck: ck("pen"), method: "POST", body: { reason: REASON } });
    check("a signature on a paper this book does not hold is a 404",
      propGhost.status === 404, { status: propGhost.status, json: propGhost.json });

    const prop = await call(`/control/money/payouts/${P1}/propose`, {
      ck: ck("pen"), method: "POST", body: { reason: REASON } });
    const AP1 = String(prop.json?.approval_id ?? "");
    check("the paper goes to 121's register with the figures read out of the row, and a hash of the "
      + "bytes the second seat is being asked to sign",
      prop.status === 200 && prop.json?.ok === true && prop.json?.action === "money.payout"
      && prop.json?.target_kind === "payout" && String(prop.json?.target_id) === P1
      && /^[0-9a-f]{64}$/.test(String(prop.json?.payload_sha256 ?? ""))
      && prop.json?.payout?.status === "pending_signature", { status: prop.status, j: prop.json });
    const ap1 = await row("platform_approvals", AP1);
    check("…the signature is a row in 121's own table, pending, with a seven-day expiry and the "
      + "payee's number in it only as a hash",
      ap1.action === "money.payout" && ap1.status === "pending" && String(ap1.proposed_by) === uPen
      && String(ap1.decided_by) === "null" && !!ap1.expires_at
      && ap1.payload_sha256 === prop.json?.payload_sha256
      && !/255712345678/.test(JSON.stringify(ap1.payload ?? {}))
      && ap1.payload.payee_ref_hash === p1Row.payee_ref_hash,
      { keys: Object.keys(ap1.payload ?? {}), decided: ap1.decided_by });
    const pRow1 = await row("money_payouts", P1);
    check("…and the paper now names the signature it waits on, which is the arm of the two-seat rule "
      + "the desk can see", String(pRow1.approval_id) === AP1
      && pRow1.status === "pending_signature", { s: pRow1.status });
    const propAgain = await call(`/control/money/payouts/${P1}/propose`, {
      ck: ck("pen"), method: "POST", body: { reason: REASON } });
    check("the same paper cannot be put up twice: the desk is told a signature is already open",
      propAgain.status === 409 && /already stands open|already open/i.test(words(propAgain)),
      words(propAgain));
    const declineSelf = await call(`/control/money/payouts/${P1}/decline`, {
      ck: ck("pen"), method: "POST", body: { note: MEMO("The seat that asked is not the seat that says "
        + "no") } });
    check("the seat that asked for a signature cannot answer it, and 121's own words come back inside "
      + "the refusal",
      declineSelf.status === 409 && /Ask a second person/i.test(words(declineSelf))
      && declineSelf.json?.error?.details?.[0]?.approval_answer?.status === "self",
      { status: declineSelf.status, message: words(declineSelf) });
    const payBeforeRelease = await call(`/control/money/payouts/${P1}/paid`, {
      ck: ck("pen"), method: "POST",
      body: { note: MEMO("Confirming cash on a paper nobody has signed") } });
    check("the paid door refuses a paper that has not been released, so no movement is booked and the "
      + "desk cannot skip the second seat by typing the note",
      payBeforeRelease.status === 409 && /after a second seat has released it/i.test(words(payBeforeRelease)),
      words(payBeforeRelease));
    const failBeforeRelease = await call(`/control/money/payouts/${P1}/failed`, {
      ck: ck("pen"), method: "POST",
      body: { reason: MEMO("The rail said no to a paper nobody signed") } });
    check("…and so does the failed door, which is the only honest answer since nothing was accrued",
      failBeforeRelease.status === 409 && /Only a released payout can fail/i.test(words(failBeforeRelease)),
      words(failBeforeRelease));
    const payGhost = await call(`/control/money/payouts/${randomUUID()}/paid`, {
      ck: ck("pen"), method: "POST", body: { note: MEMO("Paying a paper that is not in the book") } });
    check("paying a payout this book does not hold is a 404", payGhost.status === 404, payGhost.status);
    const payShort = await call(`/control/money/payouts/${P1}/paid`, {
      ck: ck("pen"), method: "POST", body: { note: "paid" } });
    check("a note too short to be the receipt is refused before the door is asked",
      payShort.status === 400, payShort.json);
    const failGhost = await call(`/control/money/payouts/${randomUUID()}/failed`, {
      ck: ck("pen"), method: "POST", body: { reason: MEMO("Failing a paper that is not in the book") } });
    check("…and so is failing one", failGhost.status === 404, failGhost.status);
    check("none of those booked a movement", (await boards()).postings === 0, await boards());

    const decline = await call(`/control/money/payouts/${P1}/decline`, {
      ck: ck("bill"), method: "POST",
      body: { note: MEMO("A second seat says no: the receipt on file is not legible") } });
    check("a different seat with the same duty answers the signature and stamps the paper",
      decline.status === 200 && decline.json?.payout?.status === "declined"
      && decline.json?.payout?.declined_at !== undefined, { status: decline.status });
    const pRow2 = await row("money_payouts", P1);
    const ap1after = await row("platform_approvals", AP1);
    check("…the signature is kept as a rejection rather than deleted, so the register still says who "
      + "was asked",
      pRow2.status === "declined" && String(pRow2.declined_by) === uBill
      && ap1after.status === "rejected" && String(ap1after.decided_by) === uBill
      && !!ap1after.decided_at, { payout: pRow2.status, approval: ap1after.status });
    const declAud = await audOf("money_payouts", P1, "payout.declined");
    check("…and the refusal is audited with the sentence the payee will be given",
      String(declAud?.actor_user_id) === uBill && declAud?.before?.status === "pending_signature"
      && /not legible/.test(JSON.stringify(declAud?.after ?? {})), declAud?.after);
    const propFinished = await call(`/control/money/payouts/${P1}/propose`, {
      ck: ck("pen"), method: "POST", body: { reason: REASON } });
    check("a finished paper cannot be put up again for a second try",
      propFinished.status === 409 && /is finished/i.test(words(propFinished)), words(propFinished));
    const declineAgain = await call(`/control/money/payouts/${P1}/decline`, {
      ck: ck("bill"), method: "POST", body: { note: REASON } });
    check("…and it cannot be refused twice either",
      declineAgain.status === 409 && /has answered/i.test(words(declineAgain)), words(declineAgain));

    const draftDecline = await call(`/control/money/payouts/${P1S}/decline`, {
      ck: ck("pen"), method: "POST",
      body: { note: MEMO("The desk kills its own draft before anybody was asked") } });
    check("a draft with no signature on it is a paper the desk may still put down, because no second "
      + "seat was ever waiting",
      draftDecline.status === 200 && (await row("money_payouts", P1S)).status === "declined"
      && (await row("money_payouts", P1S)).approval_id === null, { status: draftDecline.status });

    // ---------------- 10 · the batches ----------------
    phase("10 · several people paid at once");
    const badLabel = await call("/control/money/batches", {
      ck: ck("pen"), method: "POST", body: { label: "ab", currency: "TZS" } });
    check("a batch with no readable name is refused", badLabel.status === 400, badLabel.json);
    const batchAsIce = await call("/control/money/batches", {
      ck: ck("ice"), method: "POST", body: { label: MEMO("A batch the freeze tries to open"),
        currency: "TZS" } });
    check("opening a batch is the pen's, not the adjudicator's",
      batchAsIce.status === 403, batchAsIce.json);
    const b1 = await call("/control/money/batches", {
      ck: ck("pen"), method: "POST", body: { label: MEMO("Driver allowances, October"),
        currency: "TZS" } });
    const B1 = String(b1.json?.batch?.id ?? "");
    check("a batch opens as a draft with a total of nothing and a number the second seat can read",
      b1.status === 200 && /^PBT-\d{4}-\d{5}$/.test(String(b1.json?.batch?.ref ?? ""))
      && b1.json?.batch?.status === "open" && Number(b1.json?.batch?.total_amount) === 0
      && Number(b1.json?.batch?.lines) === 0, { status: b1.status, b: b1.json?.batch });
    const closeEmpty = await call(`/control/money/batches/${B1}/close`, {
      ck: ck("pen"), method: "POST", body: { note: MEMO("Closing a batch that never carried a line") } });
    check("a draft batch cannot be closed from the board, empty or not — the signature closes it",
      closeEmpty.status === 409 && /closed from its spent signature/i.test(words(closeEmpty)),
      words(closeEmpty));
    const propEmpty = await call(`/control/money/batches/${B1}/propose`, {
      ck: ck("pen"), method: "POST", body: { reason: REASON } });
    check("…and an empty batch is not a thing a second seat can be asked to sign — the door calls it a "
      + "batch of nothing and carries its own number, and the route answers a conflict rather than a "
      + "validation failure, because what is missing is rows the desk cannot see",
      propEmpty.status === 409 && code(propEmpty) === "CONFLICT"
      && /batch of nothing/i.test(words(propEmpty)) && /PBT-\d{4}-\d{5}/.test(words(propEmpty)),
      { status: propEmpty.status, code: code(propEmpty), words: words(propEmpty) });

    const inBatch = await raise({ batch_id: B1, amount: "120000", fee_amount: "0",
      purpose: MEMO("A driver's allowance standing inside the October batch") });
    const BB1 = String(inBatch.json?.payout?.id ?? "");
    check("a line joins an open batch, and the batch's money decides which lines may",
      inBatch.status === 200 && String((await row("money_payouts", BB1)).batch_id) === B1,
      { status: inBatch.status });
    const usdIntoTzs = await raise({ batch_id: B1, currency: "USD", amount: "50",
      purpose: MEMO("A dollar line inside a shilling batch") });
    check("a second money inside one batch is refused before the paper is written",
      usdIntoTzs.status === 400 && /one money/i.test(words(usdIntoTzs)), words(usdIntoTzs));
    const ghostBatch = await raise({ batch_id: randomUUID() });
    check("a line aimed at a batch this book does not hold is a 404",
      ghostBatch.status === 404, { status: ghostBatch.status, json: ghostBatch.json });
    const soloFromBatch = await call(`/control/money/payouts/${BB1}/propose`, {
      ck: ck("pen"), method: "POST", body: { reason: REASON } });
    check("a line inside a batch cannot be signed on its own, which is how a batch stays one sentence",
      soloFromBatch.status === 409 && /signed with it, not on its own paper/i.test(words(soloFromBatch)),
      words(soloFromBatch));

    const b2 = await call("/control/money/batches", {
      ck: ck("pen"), method: "POST", body: { label: MEMO("One line, signed, refused"), currency: "TZS" } });
    const B2 = String(b2.json?.batch?.id ?? "");
    const inBatch2 = await raise({ batch_id: B2, amount: "75000",
      purpose: MEMO("The single line of the second smoke batch") });
    const BB2 = String(inBatch2.json?.payout?.id ?? "");
    const propB = await call(`/control/money/batches/${B2}/propose`, {
      ck: ck("pen"), method: "POST", body: { reason: REASON } });
    check("a batch signs the total copied off its lines at that moment, not a figure the desk typed",
      propB.status === 200 && propB.json?.ok === true
      && Number((await row("money_payout_batches", B2)).total_amount) === 75000
      && Number((await row("money_payout_batches", B2)).lines) === 1
      && (await row("money_payout_batches", B2)).status === "pending_signature",
      { total: (await row("money_payout_batches", B2)).total_amount });
    const lateLine = await raise({ batch_id: B2, amount: "1000",
      purpose: MEMO("A line added after the signature was asked for") });
    check("nothing joins a batch that has already asked for a signature — the signed total would stop "
      + "meaning the paper",
      lateLine.status === 409 && /asked for or spent a signature/i.test(words(lateLine)),
      words(lateLine));
    const lineDecline = await call(`/control/money/payouts/${BB2}/decline`, {
      ck: ck("bill"), method: "POST", body: { note: MEMO("Refusing one line of a signed batch") } });
    check("and one line of it cannot be refused on its own either",
      lineDecline.status === 409 && /Refuse the batch/i.test(words(lineDecline)), words(lineDecline));
    const declineB = await call(`/control/money/batches/${B2}/decline`, {
      ck: ck("bill"), method: "POST",
      body: { note: MEMO("A second seat says no to the whole batch") } });
    const b2Row = await row("money_payout_batches", B2);
    check("one no answers the signature and stamps every line under it, and the paper goes back to the "
      + "board as a draft",
      declineB.status === 200 && b2Row.status === "open" && String(b2Row.approval_id) !== "null"
      && (await row("money_payouts", BB2)).status === "declined"
      && (await one(`select count(*)::int as n from money_payouts where batch_id = $1::uuid
          and status = 'declined'`, [B2])).n === 1, { status: b2Row.status });
    const b2Aud = await audOf("money_payout_batches", B2, "payout_batch.refused");
    check("…and the batch's audit line says how many people were turned away by that one answer",
      String(b2Aud?.actor_user_id) === uBill && Number(b2Aud?.after?.lines_declined) === 1
      && b2Aud?.after?.status === "open", b2Aud?.after);

    // ---------------- 11 · the two books, and the counters ----------------
    phase("11 · the payable heading, and a second office book");
    const txRaise = await call("/control/money/payouts", {
      ck: ck("est"), method: "POST",
      body: { payee_kind: "company", payee_id: TC, rail: "mpesa", payee_line: "0765432198",
        amount: "90000", currency: "TZS", source_kind: "manual",
        purpose: MEMO("The other office pays the same transporter, in its own book") } });
    const XT = String(txRaise.json?.payout?.id ?? "");
    const txRow = txRaise.status === 200 ? await row("money_payouts", XT) : null;
    check("the second office raises its own paper, because 134's doors ask which book the caller is in",
      txRaise.status === 200 && txRaise.json?.payout?.status === "raised"
      && txRow?.tenant_id === TX
      // Its own line, sealed the same way: a number typed in local form reaches the register as +255
      // and only its tail leaves it, in a book this office cannot see.
      && txRow?.payee_ref_tail === "2198"
      && decryptField(txRow?.payee_ref_encrypted as Buffer) === "+255765432198",
      { status: txRaise.status, words: words(txRaise) });
    const crossDetail = await call(`/control/money/payouts/${XT}`, asPen);
    check("…which this office cannot read, cannot list and cannot reveal",
      crossDetail.status === 404
      && (await call("/control/money/payouts?status=all&limit=200", asPen))
        .json?.rows?.every((r: Book) => String(r.id) !== XT)
      && (await call(`/control/money/payouts/${XT}/line`, { ck: ck("pen") })).status === 404,
      { detail: crossDetail.status, words: words(crossDetail) });
    const xPay = await call("/control/money/payable", asEst);
    const tPay = await call("/control/money/payable", asOwner);
    check("each book's payable read counts its own papers, and the two headings disagree on purpose",
      xPay.status === 200 && tPay.status === 200
      && (xPay.json?.rows ?? []).every((r: Book) => Number(r.papers ?? 0) === 0)
      && (tPay.json?.rows ?? []).every((r: Book) => Number(r.papers ?? 0) === 0)
      && xPay.json?.square === true && tPay.json?.square === true,
      { tx: xPay.json?.accounts, tp: tPay.json?.accounts });
    check("…with nothing released anywhere, no book has a payable figure the papers could disagree "
      + "with, which is the honest starting point of this desk",
      (tPay.json?.rows ?? []).every((r: Book) => (r.disagrees === false || r.disagrees === null)
        && Number(r.drift) === 0),
      (tPay.json?.rows ?? []).map((r: Book) => [r.label, r.book, r.cached, r.drift, r.papers]));
    const onlyWallets = (tPay.json?.rows ?? []).filter((r: Book) => r.what === "a holder's balance");
    check("…and a holder's balance is printed as money the office owes with no paper behind it",
      onlyWallets.length >= 4 && onlyWallets.every((r: Book) => r.papers === null
        && Number(r.book) === 0), onlyWallets.map((r: Book) => [r.label, r.book, r.papers]));

    const paidFilter = await call("/control/money/payouts?status=paid", asPen);
    const allFilter = await call("/control/money/payouts?status=all&limit=200", asPen);
    check("the board filters the rows it hands the screen",
      paidFilter.status === 200 && (paidFilter.json?.rows ?? []).length === 0
      && paidFilter.json?.count === 0, paidFilter.json);
    check("…while the `due` heading beside them ignores every filter on the page: the same read prints "
      + "an empty paid list and the whole book's outstanding money, which is what the desk reads as a "
      + "total rather than as a page",
      (allFilter.json?.due ?? []).length > 0
      && JSON.stringify(paidFilter.json?.due) === JSON.stringify(allFilter.json?.due),
      { due: paidFilter.json?.due, n: allFilter.json?.count });
    const railFilter = await call("/control/money/payouts?rail=cash", asPen);
    check("…and a rail filter is answered by the rails' own codes, cash papers only here — the two "
      + "this book raised on the till, not the four on the phone rail or the other book's",
      (railFilter.json?.rows ?? []).length === 2
      && (railFilter.json?.rows ?? []).every((r: Book) => r.rail === "cash"),
      (railFilter.json?.rows ?? []).map((r: Book) => r.rail));
    const badBatchFilter = await call("/control/money/payouts?batch=not-a-uuid", asPen);
    check("a batch filter that is not a uuid is refused by the desk rather than answered as no rows, "
      + "which is what the definer itself would have said",
      badBatchFilter.status === 400, { status: badBatchFilter.status });
    const searchTail = await call(`/control/money/payouts?search=${encodeURIComponent("corridor run")}`, asPen);
    check("a search reads the ref, the payee, the purpose and the quote, so a desk finds a paper by "
      + "what it typed on it",
      searchTail.status === 200 && (searchTail.json?.rows ?? []).length >= 1
      && (searchTail.json?.rows ?? []).every((r: Book) =>
        /corridor run/i.test(`${r.purpose} ${r.source_ref} ${r.ref} ${r.payee_name}`)),
      (searchTail.json?.rows ?? []).map((r: Book) => r.ref));
    const boardNames = await call(`/control/money/payouts?status=all&limit=200`, asPen);
    check("no board row carries the number, the encrypted bytes or a hash of the line",
      (boardNames.json?.rows ?? []).every((r: Book) => !("payee_ref_hash" in r)
        && !("payee_ref_encrypted" in r) && "line_tail" in r),
      Object.keys((boardNames.json?.rows ?? [])[0] ?? {}));

    // ---------------- 12 · the register as one file ----------------
    phase("12 · the export a clerk takes to the bank");
    const csvRes = await fetch(`${API}/control/money/payouts.csv?status=all`,
      { headers: { Cookie: ck("read") } });
    const csvText = await csvRes.text();
    const lines = csvText.split("\r\n");
    check("the read duty alone exports the register, as a file with a name a desk can save",
      csvRes.status === 200 && /text\/csv/.test(String(csvRes.headers.get("content-type")))
      && /attachment; filename="payouts-\d{4}-\d{2}-\d{2}\.csv"/
        .test(String(csvRes.headers.get("content-disposition"))),
      { status: csvRes.status, cd: csvRes.headers.get("content-disposition") });
    const head = lines[0].split(",");
    check("…and the header has no column that could carry a payee's number, only its tail",
      !head.some((h) => /payee_line|encrypted|hash/i.test(h)) && head.includes("line_tail")
      && head.includes("payee_name") && head.includes("total") && head.includes("approval"), head);
    check("…with every paper of this book on it and none of the other's",
      lines.length === (boardNames.json?.count ?? 0) + 1
      && csvText.includes(p1Row.ref) && !csvText.includes(String(
        (await row("money_payouts", XT)).ref)), { lines: lines.length, count: boardNames.json?.count });
    const csv403 = await fetch(`${API}/control/money/payouts.csv`, { headers: { Cookie: ck("dir") } });
    check("a seat with no money duty gets a refusal, not a file", csv403.status === 403, csv403.status);
    const guardRow = lines.find((l) => l.includes("=Equity (Testing) Ltd"));
    check("a purpose typed by a clerk that starts with an operator leaves the office quoted, so the "
      + "sheet cannot execute itself in a spreadsheet",
      !!guardRow && guardRow.includes("\"'=SUM(A1:A9)+cmd\""), guardRow);
    const tailCol = head.indexOf("line_tail");
    check("…and the tail column is the only piece of the line that survives the trip",
      String(lines[1].split(",")[tailCol] ?? "").includes("5678")
      || !/255712345678/.test(csvText), { tailCol });
    check("no cell of the whole file carries the stored number",
      !/255712345678|\+255712345678/.test(csvText));

    // ---------------- 13 · the one door that opens a number ----------------
    phase("13 · opening a payee's line, and the register of who asked");
    const linePath = `/control/money/payouts/${P1S}/line`;
    for (const who of ["ice", "bill", "read", "dir"]) {
      const refused = await call(linePath, { ck: ck(who) });
      check(`a seat holding every other money duty still cannot read ${who}`,
        refused.status === 403, { who, status: refused.status, json: refused.json });
    }
    const reveal = await call(linePath, asPen);
    check("the pen, which raised the paper, opens the line it stored — and only the line it needs",
      reveal.status === 200 && reveal.json?.line === "+255712345678"
      && reveal.json?.ref === (await row("money_payouts", P1S)).ref
      && reveal.json?.needs === "phone" && reveal.json?.line_tail === "5678"
      && reveal.json?.payee_tenant_id === TC && !("payee_ref_hash" in (reveal.json ?? {})),
      { keys: Object.keys(reveal.json ?? {}) });
    const revAud = await audOf("money_payouts", P1S, "control.money.payee_line_revealed");
    check("…the reveal is written before the value is returned, naming the paper, the payee and the "
      + "tail but never the digits",
      String(revAud?.actor_user_id) === uPen && revAud?.after?.ref === (await row("money_payouts", P1S)).ref
      && revAud?.before === null && revAud?.after?.line_tail === "5678"
      && !/255712345678/.test(JSON.stringify(revAud ?? {})), { after: revAud?.after });
    const revealBank = await call(`/control/money/payouts/${PB}/line`, asOwner);
    check("…and a bank line opens as the bank printed it, because the desk has to read it out to a "
      + "teller",
      revealBank.status === 200 && revealBank.json?.line === "DS01234"
      && revealBank.json?.rail_label === "Bank transfer", revealBank.json);
    const revealCash = await call(`/control/money/payouts/${PC}/line`, asPen);
    check("a cash payout has no line to open, and the refusal says which rail it was paid on rather "
      + "than printing an empty string",
      revealCash.status === 404 && /handed over at the desk/i.test(words(revealCash)),
      words(revealCash));
    const revealOther = await call(`/control/money/payouts/${XT}/line`, asPen);
    check("a payout in the other office's book is not in this one, so no number leaves",
      revealOther.status === 404 && /not in the office's book/i.test(words(revealOther)),
      words(revealOther));
    const revealBad = await call("/control/money/payouts/not-a-uuid/line", asPen);
    check("…and a reference that is not a uuid is refused before the register is asked",
      revealBad.status === 400, revealBad.status);

    // ---------------- 14 · the subjects and the pickers ----------------
    phase("14 · the registers a desk picks from instead of typing");
    const payees = await call(`/control/money/payees?kind=company&search=${encodeURIComponent("MM Smoke")}`, asRead);
    check("the payee picker answers the company the payout guard will accept, with the money rules on "
      + "each row",
      payees.status === 200 && (payees.json?.rows ?? []).length === 4
      && (payees.json?.rows ?? []).every((r: Book) => r.can_pay === true && r.kind === "company"
        && r.company_tenant_id === r.id), (payees.json?.rows ?? []).map((r: Book) => r.name));
    const goneRow = (payees.json?.rows ?? []).find((r: Book) => r.id === TG);
    check("…a closed company is on the list, marked so, and the wallet door would refuse it — the "
      + "picker tells the desk rather than hiding the row",
      goneRow?.archived === true && goneRow?.can_wallet === false, goneRow);
    const shipRow = (payees.json?.rows ?? []).find((r: Book) => r.id === TS);
    check("…while a shipper can be paid and can hold a balance, and the picker knows both",
      shipRow?.can_wallet === true && shipRow?.detail?.includes("shipper"), shipRow);
    check("…and the answer carries no phone, no NIDA and no account line, so `reveal` stays the only "
      + "way a number leaves",
      (payees.json?.rows ?? []).every((r: Book) => !/phone|nida|account_line|payee_ref/.test(
        Object.keys(r).join(","))), Object.keys((payees.json?.rows ?? [])[0] ?? {}));
    const payeeOther = await call("/control/money/payees?kind=other", asRead);
    check("a picker for `other` is refused by the desk, because a door cannot list people who do not "
      + "exist in a register", payeeOther.status === 400, payeeOther.status);
    const payeeShort = await call("/control/money/payees?kind=company&search=a", asRead);
    check("a one-letter name search is refused before it becomes a list of everybody",
      payeeShort.status === 400, payeeShort.status);
    const payeeBig = await call("/control/money/payees?kind=company&limit=500", asRead);
    check("…and so is a page of five hundred payees", payeeBig.status === 400, payeeBig.status);
    const subjects = await call("/control/money/subjects?kind=call", asRead);
    check("the subject picker answers the four registers a hold can wait on, and none of the figures",
      subjects.status === 200 && Array.isArray(subjects.json?.rows)
      && (subjects.json?.rows ?? []).every((r: Book) => !("amount" in r)),
      { keys: Object.keys((subjects.json?.rows ?? [])[0] ?? {}), n: (subjects.json?.rows ?? []).length });
    const subjKind = await call("/control/money/subjects?kind=widget", asRead);
    check("a subject kind that is none of the four is refused by the desk's own list",
      subjKind.status === 400, subjKind.status);

    // ---------------- 15 · the counters of a book nobody has funded ----------------
    phase("15 · what the boards say when nothing has moved");
    const batchBoard = await call("/control/money/batches?status=all", asRead);
    check("the batch board lists both drafts, including the one that spent a signature and came back",
      batchBoard.status === 200 && (batchBoard.json?.rows ?? []).length === 2
      && (batchBoard.json?.rows ?? []).every((r: Book) => r.status === "open"),
      (batchBoard.json?.rows ?? []).map((r: Book) => [r.ref, r.status]));
    const bDetail = await call(`/control/money/batches/${B2}`, asRead);
    check("a batch read carries its own lines and the signature it was refused under, so a desk can "
      + "see why the total was frozen",
      bDetail.status === 200 && String(bDetail.json?.id) === B2
      && (bDetail.json?.payouts ?? []).length === 1
      && bDetail.json?.approval?.status === "rejected"
      && bDetail.json?.approval?.decided_by === "Baraka Bill"
      && bDetail.json?.approval?.payload === undefined, { j: bDetail.json?.approval });
    const bGhost = await call(`/control/money/batches/${randomUUID()}`, asRead);
    check("a batch nobody opened is a 404 with the door's sentence",
      bGhost.status === 404 && /no batch in this book/i.test(words(bGhost)), words(bGhost));
    const closeSigned = await call(`/control/money/batches/${B2}/close`, {
      ck: ck("pen"), method: "POST", body: { note: MEMO("Closing a batch that is a draft again") } });
    check("…and a batch that spent a signature and was refused does not close from the board either",
      closeSigned.status === 409 && /still a draft|spent signature/i.test(words(closeSigned)),
      words(closeSigned));
    const stat = await call("/control/money/payable", asRead);
    check("the payable read finds nothing out of line: every liability line it counts agrees between "
      + "its legs and its cached totals, no released paper disagrees with the book, and the money the "
      + "office is holding for holders is zero, because this run was never allowed to park anything",
      (stat.json?.rows ?? []).length > 0 && Number(stat.json?.accounts) === (stat.json?.rows ?? []).length
      && stat.json?.square === true && Number(stat.json?.disagrees) === 0 && Number(stat.json?.drift) === 0
      && (stat.json?.held ?? []).every((h: Book) => Number(h.held) === 0) && stat.json?.bound === TP,
      { accounts: stat.json?.accounts, square: stat.json?.square, held: stat.json?.held });
    const railBoard = await call("/control/money/rails", asRead);
    const counts = (railBoard.json?.rows ?? []).find((r: Book) => r.code === "mpesa");
    check("the rails carry the counts of the papers that were actually raised, which is the desk's "
      + "only clue about which line the office uses",
      Number(counts?.paid ?? 0) >= 4, { mpesa: counts?.paid, all: (railBoard.json?.rows ?? [])
        .map((r: Book) => [r.code, r.paid]) });

    const after = await boards();
    check("the whole run wrote wallets, papers and a batch — and not one movement or leg",
      after.wallets === 5 && after.payouts === 8 && after.batches === 2 && after.holds === 0
      && after.postings === 0 && after.legs === 0, after);
    const moneyAudit = await one(`select
        count(*) filter (where action like 'wallet.%')::int as wallet_lines,
        count(*) filter (where action like 'payout%')::int as payout_lines,
        count(*) filter (where action = 'control.money.payee_line_revealed')::int as reveal_lines,
        count(*) filter (where action like 'escrow.%')::int as hold_lines,
        count(*) filter (where entity = 'money_postings')::int as posting_lines
        from audit_logs where tenant_id = any($1::uuid[])`, [[TP, TX]]);
    check("…and the register of the office's decisions says exactly that, with no hold and no movement "
      + "in it",
      Number(moneyAudit?.hold_lines) === 0 && Number(moneyAudit?.posting_lines) === 0
      && Number(moneyAudit?.wallet_lines) >= 6 && Number(moneyAudit?.reveal_lines) === 2,
      moneyAudit);
    const leaked = await one(`select count(*)::int as n from audit_logs where tenant_id = any($1::uuid[])
        and (coalesce(before, '{}'::jsonb)::text || coalesce(after, '{}'::jsonb)::text)
          ~* 'idempotenc'`, [[TP, TX]]);
    check("no money audit line carries an idempotency key, which belongs to the request and not to "
      + "the book", leaked?.n === 0, leaked);
  } finally {
    await sweep();
    const clean = await boards();
    const NOW = await one(`select
        (select count(*)::int from money_accounts where tenant_id = $1) as chart,
        (select count(*)::int from money_postings where tenant_id = $1) as postings`, [PLAT]);
    check("this run's two books, their wallets, their chart lines, their papers and their seats are gone",
      clean.wallets === 0 && clean.payouts === 0 && clean.batches === 0 && clean.holds === 0
      && clean.postings === 0 && clean.legs === 0
      && (await one(`select count(*)::int as n from tenants where name like $1`, [TENANT_SWEEP])).n === 0,
      { clean });
    check("…and the sweep is bounded by tenant and by name prefix, never by a code: 134's own office "
      + "chart holds PAYOUT-DUE and WLT lines of its own, and a sweep written as `code like 'WLT-%'` "
      + "would have deleted the platform's book",
      (await one(`select count(*)::int as n from money_accounts
        where code like $1 or label like $2`, [CODE_SWEEP, `${MARK}%`])).n === 0);
    check("the office's own book is exactly what this run found — its chart and its movements",
      NOW.chart === BASE.chart && NOW.postings === BASE.postings, NOW);
    check("…and the whole schema holds no new movement, which is the only teardown a book that "
      + "refuses DELETE allows",
      (await one("select count(*)::int as n from money_postings")).n === BASE.postings
      && (await one("select count(*)::int as n from money_entries")).n === BASE.legs, BASE);
    check("…with the payout register left holding only the papers it held before this run",
      (await one("select count(*)::int as n from money_payouts")).n === BASE.payouts_all
      && (await one("select count(*)::int as n from money_wallets")).n === BASE.wallets_all
      && (await one("select count(*)::int as n from money_escrow_holds")).n === BASE.holds_all);
    const apLeft = await one(`select count(*)::int as n from platform_approvals
      where action in ('money.payout','money.escrow') and proposed_by = any($1::uuid[])`,
      [[uOwner, uPen, uIce, uBill, uRead, uDir, uEst, uBoss]]);
    check("…and the signatures this run asked for went with it, since a pending signature that outlives "
      + "its paper is a question nobody can answer", apLeft?.n === 0, apLeft);
    await oi(`delete from rate_limits where bucket like 'money%'`);
    await owner.end();
  }

  console.log(`\n${failures ? "FAILURES: " + failures : "all checks passed"} — marker ${MARK} `
    + `(${Math.round((Date.now() - START) / 1000)}s)`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
