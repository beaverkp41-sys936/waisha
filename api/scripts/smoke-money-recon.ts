/**
 * The count the office makes of itself, and the deliveries it never acted on — smoke for #344l–#344n
 * (migration 135, `control-money.routes.ts`'s recon + statement doors, `control-gateway.routes.ts`'s
 * delivery board and retry, and the two desks that read them).
 *
 * `verify-money-recon-sql.ts` proves the register itself: the keep triggers, the two-seat rule that
 * actually lands, the statement's arithmetic over a window that has legs in it, and every door's
 * refusal inside a transaction that is rolled back. Only HTTP can prove the five things this stage
 * added on top of that:
 *
 *  - that the count is a fourth duty and not a fourth spelling of the pen: a billing administrator who
 *    opens accounts is refused the report, a compliance officer who signs for a count is refused the
 *    pen, an auditor who cannot count still gets a statement, because a book its accountant cannot read
 *    is a dashboard;
 *  - that `control.gateway.retry` is not `control.gateway.manage`: a support seat re-drives a delivery
 *    it could never switch off, and an analyst reads the register without pressing anything;
 *  - that a press which the door refuses still writes a ledger row, and a press that spent the ceiling
 *    writes neither a row nor an audit line — which is the difference between an append-only register
 *    and a button;
 *  - that the words the desk shows are the door's own: the `135:` taken off nothing (these doors do not
 *    raise, they answer), and a route guard's sentence distinguished from a door's by the field
 *    annotation only the route can add;
 *  - that a payload read is not a PII read: the reference the desk needs survives the scrub and a
 *    payer's phone does not, in either direction.
 *
 * WHAT THIS RUN DELIBERATELY DOES NOT DO.
 *
 *  1. It never signs a count. A reviewed run is kept (`recon_run_is_kept_once_signed`) and its
 *     findings are kept with it, and `money_reconciliation_runs.tenant_id` references `tenants` with no
 *     cascade — so a single successful signature would make this run's fixture book permanently
 *     undeletable and break the teardown of every smoke that sweeps by name after it. The signature
 *     that lands is proved in the SQL gate, inside a transaction that rolls back. Everything here is
 *     the refusals, which is also the only half a seat can be blamed for.
 *  2. It never posts a movement (133's rule, unchanged: legs are append-only and a committed leg is
 *     permanent in every book including this one), so the statement is proved over an empty window and
 *     the arithmetic of a window with legs belongs to the gate too.
 *
 * SAFETY: every row this run writes outside the money registers is its own — synthetic platform
 * tenants found by name prefix, deliveries found by their `WSH-<marker>` reference, one charge minted
 * here rather than a real company's. The office's real book, the delivery register's total count and
 * the run register's total count are snapshotted at the start and re-measured at the end. Audit lines
 * are left behind on purpose: `prevent_audit_mutation()` refuses the owner too, and a count that was
 * thrown away should still be findable in the office's history.
 *
 * Run: npx tsx scripts/smoke-money-recon.ts   (API on :4000, or `WAISHA_API_BASE` to point it
 *      somewhere else when that port is taken by another project)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { sha256 } from "../src/util/crypto.js";

const API = process.env.WAISHA_API_BASE ?? "http://localhost:4000/api/v1";

const STAMP = Date.now().toString().slice(-8);
const MARK = `rc${STAMP}`;
const TENANT_SWEEP = "RC Smoke %";
const EMAIL_SWEEP = `smoke.rc.%@waisha.test`;
/** Not one of 114's registry keys, so every delivery this run files is a delivery whose rail has no
 *  row in the register — the shape a desk sees the morning after a gateway is cleared. */
const RAIL = "smoke";
const REF = (n: string) => `WSH-${MARK}-${n}`;
/** Today and the week behind it, in the shape the papers carry them (090's lesson: a `date` column
 *  read back through JSON lands a day early east of Greenwich, so the desk sends and expects text). */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const WEEK_AGO = iso(new Date(Date.now() - 7 * 864e5));
const LAST_MONTH = iso(new Date(Date.now() - 40 * 864e5));

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
    ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
function note(s: string) { console.log(`     · ${s}`); }
function phase(name: string) { console.log(`\n--- ${name} ---`); }

async function call(path: string, opts: {
  ck?: string; method?: string; body?: any; raw?: boolean;
} = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    headers: {
      ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(opts.ck ? { Cookie: opts.ck } : {})
    }
  });
  const text = await res.text();
  if (opts.raw) {
    return { status: res.status, text, bytes: Buffer.from(text, "latin1"),
      type: res.headers.get("content-type") ?? "", disposition: res.headers.get(
        "content-disposition") ?? "", cache: res.headers.get("cache-control") ?? "",
      json: null as any };
  }
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text, type: "", disposition: "", cache: "", bytes: null as any };
}

const code = (r: { json: any }) => r.json?.error?.code ?? null;
/** A door's sentence lands in `error.message`; a zod refusal lands one level down in `details` with a
 *  generic top line. Both are joined so a check on the words cannot pass for the wrong reason. */
const words = (r: { json: any }) => [String(r.json?.error?.message ?? ""),
  ...(Array.isArray(r.json?.error?.details)
    ? r.json.error.details.map((d: any) => `${d.field ?? ""} ${d.message ?? ""}`) : [])].join(" | ");
/** A press that *happened* answers 200, and 135's door puts its sentence in the top-level `message`;
 *  only a refusal reaches the browser inside `error`. Both shapes are the same words about the same
 *  act, so a check that wants the seat's sentence asks for either. */
const said = (r: { json: any }) => String(r.json?.message ?? "") || words(r);
/** Only the route's own guards add a `field`; a door's refusal carries `reason` or nothing. */
const routed = (r: { json: any }) =>
  Array.isArray(r.json?.error?.details) && r.json.error.details.some((d: any) => d.field);

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);
  const one = async (sql: string, params: any[] = []) => (await oi(sql, params)).rows[0];
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

  const PLAT = (await oi(
    `select id from tenants where type = 'platform' and deleted_at is null
      and name not like $1 order by created_at limit 1`, [TENANT_SWEEP])).rows[0]?.id;
  if (!PLAT) throw new Error("no platform tenant to hold the office's book");
  const BASE = await one(`select
      (select count(*)::int from money_accounts where tenant_id = $1) as accounts,
      (select count(*)::int from money_postings where tenant_id = $1) as postings,
      (select count(*)::int from money_entries) as legs_all,
      (select count(*)::int from payment_webhooks where provider <> $2) as deliveries,
      (select count(*)::int from gateway_webhook_attempts) as attempts,
      (select count(*)::int from money_reconciliation_runs) as runs,
      (select count(*)::int from money_reconciliation_findings) as findings`, [PLAT, RAIL]);
  console.log(`office book: ${BASE.accounts} chart lines, ${BASE.postings} movements; the platform `
    + `holds ${BASE.deliveries} deliveries, ${BASE.attempts} attempts, ${BASE.runs} counts `
    + `(${BASE.findings} findings) and ${BASE.legs_all} legs in total`);

  // ---------------- the duties this run grades ----------------
  const WANT = ["super_admin", "billing_admin", "finance_officer", "compliance_officer",
    "auditor", "platform_analyst", "support_engineer"];
  const roleRows = (await oi(
    `select id, key from roles where tenant_id is null and key = any($1)`, [WANT])).rows;
  const rid = (k: string) => roleRows.find((r: any) => r.key === k)?.id;
  const missing = WANT.filter((k) => !rid(k));
  if (missing.length) throw new Error(`global roles missing: ${missing.join(", ")}`);

  // 133's three keys, 134's three and 135's two are the claim every 403 below rests on. A grant that
  // never landed would make a refusal pass for the wrong reason, so the fixture reads its own ground.
  const grants = await one(`select
      (select array_agg(rp.permission_key order by rp.permission_key)
         from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = $1) as admin,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'billing_admin' and rp.permission_key = 'control.money.post') as bill_post,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'billing_admin' and rp.permission_key = 'control.money.recon') as bill_recon,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'finance_officer' and rp.permission_key = 'control.money.recon') as pen_recon,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'finance_officer' and rp.permission_key = 'control.money.freeze') as pen_ice,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'compliance_officer' and rp.permission_key = 'control.money.recon') as ice_recon,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'compliance_officer' and rp.permission_key = 'control.money.post') as ice_post,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'auditor' and rp.permission_key = 'control.money.view') as audit_view,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'auditor' and rp.permission_key = 'control.money.recon') as audit_recon,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'platform_analyst' and rp.permission_key = 'control.gateway.view') as read_gate,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'platform_analyst' and rp.permission_key = 'control.gateway.retry') as read_retry,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'support_engineer' and rp.permission_key = 'control.gateway.retry') as sup_retry,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'support_engineer' and rp.permission_key = 'control.gateway.manage') as sup_manage,
      (select count(*)::int from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'support_engineer' and rp.permission_key like 'control.money.%') as sup_money`,
    ["super_admin"]);
  const bad: string[] = [];
  for (const k of ["control.money.view", "control.money.post", "control.money.freeze",
    "control.money.recon", "control.gateway.view", "control.gateway.manage",
    "control.gateway.retry"]) {
    if (!(grants.admin as string[]).includes(k)) bad.push(`super_admin lacks ${k}`);
  }
  if (Number(grants.bill_post) !== 1) bad.push("billing_admin lacks the pen");
  if (Number(grants.bill_recon) !== 0) bad.push("billing_admin holds the count");
  if (Number(grants.pen_recon) !== 1) bad.push("finance_officer lacks the count");
  if (Number(grants.pen_ice) !== 0) bad.push("finance_officer holds the freeze");
  if (Number(grants.ice_recon) !== 1) bad.push("compliance_officer lacks the count");
  if (Number(grants.ice_post) !== 0) bad.push("compliance_officer holds the pen");
  if (Number(grants.audit_view) !== 1) bad.push("auditor lacks the read");
  if (Number(grants.audit_recon) !== 0) bad.push("auditor holds the count");
  if (Number(grants.read_gate) !== 1) bad.push("platform_analyst lacks the delivery register");
  if (Number(grants.read_retry) !== 0) bad.push("platform_analyst holds the retry");
  if (Number(grants.sup_retry) !== 1) bad.push("support_engineer lacks the retry");
  if (Number(grants.sup_manage) !== 0) bad.push("support_engineer holds manage");
  if (Number(grants.sup_money) !== 0) bad.push("support_engineer holds a money duty");
  if (bad.length) throw new Error(`the duties on these roles are not what this run grades — `
    + bad.join("; ") + ` — ${JSON.stringify(grants)}`);
  console.log("133/134/135's duties read back exactly as the two desks are graded");

  // ---------------- fixtures ----------------
  const TP = randomUUID();   // the book this run signs in at
  const TX = randomUUID();   // a second book, to be kept out of
  const uOwner = randomUUID(); // super_admin: everything below
  const uBill = randomUUID();  // billing_admin: the pen, not the count
  const uPen = randomUUID();   // finance_officer: the pen and the count
  const uIce = randomUUID();   // compliance_officer: the count, not the pen
  const uAudit = randomUUID(); // auditor: a read, and a statement
  const uRead = randomUUID();  // platform_analyst: the register, no button
  const uSup = randomUUID();   // support_engineer: retry, no manage, no money
  const uBoss = randomUUID();  // a company seat, which is not a control seat at all
  const TC = randomUUID();     // a cargo company, for the door that is not a control seat

  const tok = (who: string) => `${MARK}-${who}`;
  const ck = (who: string) => `waisha_control=${tok(who)}`;
  const seats = [
    [uOwner, "owner", "super_admin", "Miriam Keeper", TP],
    [uBill, "bill", "billing_admin", "Bahati Ledger", TP],
    [uPen, "pen", "finance_officer", "Faraji Pen", TP],
    [uIce, "ice", "compliance_officer", "Neema Freeze", TP],
    [uAudit, "audit", "auditor", "Asha Audit", TP],
    [uRead, "read", "platform_analyst", "Daudi Analyst", TP],
    [uSup, "sup", "support_engineer", "Salim Rails", TP]
  ] as const;

  // The sweep runs before anything is planted, not after: it finds this run's own rubbish by the name
  // prefixes below, so a fixture written first is deleted by its own run's housekeeping and every
  // cookie in the phases that follow hashes to a session row that no longer exists.
  const MY_IDS: string[] = [];
  const W_IDS: string[] = [];

  const START = Date.now();
  const sweep = async () => {
    const tids = (await oi(`select id from tenants where name like $1`, [TENANT_SWEEP]))
      .rows.map((r: any) => r.id);
    const byEmail = (await oi(`select tenant_id from users where email like $1`, [EMAIL_SWEEP]))
      .rows.map((r: any) => r.tenant_id);
    const all = [...new Set([...tids, ...byEmail].filter(Boolean))];
    const uids = all.length
      ? (await oi(`select id from users where tenant_id = any($1::uuid[])`, [all]))
        .rows.map((r: any) => r.id)
      : [];
    // A signed count would stop this — the run's own rule, and the reason phase 6 never signs.
    const kept = await one(`select count(*)::int as n from money_reconciliation_runs
      where tenant_id = any($1::uuid[]) and status <> 'open'`, [all.length ? all : [TP, TX]]);
    if (Number(kept.n) > 0) {
      console.log(`FAIL  teardown: ${kept.n} reviewed count(s) in a fixture book — they cannot be `
        + `deleted, so this run's own rule was broken somewhere`);
      failures++;
    }
    await oi(`delete from gateway_webhook_attempts where tenant_id = any($1::uuid[])`,
      [all.length ? all : [TP]]);
    await oi(`delete from money_reconciliation_findings where tenant_id = any($1::uuid[])`,
      [all.length ? all : [TP]]);
    await oi(`delete from money_reconciliation_runs where tenant_id = any($1::uuid[])`,
      [all.length ? all : [TP]]);
    // The delivery register has no tenant column: the marker in the reference is what names this run's
    // rows, and the attempts go with them by cascade. But the sweep finds tenants by the shared
    // `RC Smoke %` name, so a crashed earlier run's charges and invoices still point at its book — and
    // `invoices_tenant_id_fkey` has no cascade. Deleting them by this run's own marker leaves them, and
    // the tenant delete below throws. So both go by tenant membership, and the marker stays as a backstop.
    await oi(`delete from payment_webhooks where provider = $1
        or payload ->> 'reference' like $2 or replay_nonce like $3`,
      [RAIL, `WSH-${MARK}%`, `${MARK}%`]);
    await oi(`delete from payments where tenant_id = any($1::uuid[]) or intent_reference like $2`,
      [all.length ? all : [TC], `WSH-${MARK}%`]);
    await oi(`delete from invoices where tenant_id = any($1::uuid[]) or number like $2`,
      [all.length ? all : [TC], `INV-${MARK}%`]);
    await oi(`delete from money_accounts where tenant_id = any($1::uuid[])`,
      [all.length ? all : [TP, TX]]);
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`,
      [all.length ? all : [TP, TX, TC]]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [all]);
    // `bucket` is text and the seats are uuids, so the array is compared as text: a `= any($1::uuid[])`
    // here is an operator that does not exist, and a teardown that throws on its last line leaves every
    // row above it deleted and this run's rubbish half-gone.
    await oi(`delete from rate_limits
        where right(bucket, 36) = any($1::text[])
           or bucket like 'money-recon%' or bucket like 'money-statement%'
           or bucket like 'money-account%' or bucket like 'gateway:webhook%'`,
      [uids]);
  };
  await sweep();

  await oi(`insert into tenants (id, type, name, status, trial_ends_at) values
      ($1,'platform',$2,'active', now() + interval '30 days'),
      ($3,'platform',$4,'active', now() + interval '30 days'),
      ($5,'transporter',$6,'trial', now() + interval '3 days')`,
    [TP, `RC Smoke Book ${STAMP}`, TX, `RC Smoke Other ${STAMP}`,
      TC, `RC Smoke Cargo Ltd ${STAMP}`]);

  // Each seat's session is hashed from the token its own cookie carries, so `ck(who)` opens the door
  // for `who` and for nobody else.
  for (const [id, who, roleKey, name, tenant] of seats) {
    await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
          last_login_at, created_at)
        values ($1,$2,'platform',$3,$4,'active',true, now() - interval '2 hours',
          now() - interval '200 days')`,
      [id, tenant, name, `smoke.rc.${name.toLowerCase().replace(/\W+/g, ".")}.${STAMP}@waisha.test`]);
    await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [id, rid(roleKey)]);
    await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
          refresh_token_hash, user_agent, ip, expires_at)
        values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-recon','127.0.0.1',
          now() + interval '2 hours')`,
      [randomUUID(), id, tenant, randomUUID(), sha256(tok(who))]);
  }
  await oi(`insert into users (id, tenant_id, user_type, full_name, email, status, totp_enabled,
        last_login_at, created_at)
      values ($1,$2,'staff',$3,$4,'active',false, now() - interval '2 hours',
        now() - interval '200 days')`,
    [uBoss, TC, "Beatrice Boss", `smoke.rc.boss.${STAMP}@waisha.test`]);
  await oi(`insert into user_roles (user_id, role_id) values ($1,$2)`, [uBoss, rid("auditor")]);
  await oi(`insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
        refresh_token_hash, user_agent, ip, expires_at)
      values ($1,$2,$3,$4, now() + interval '2 hours', $5,'smoke-recon','127.0.0.1',
        now() + interval '2 hours')`,
    [randomUUID(), uBoss, TC, randomUUID(), sha256(tok("boss"))]);

  // One line on the chart the seats will not be able to delete by accident: opened through the door,
  // in the book the run signs in at, and never given a leg.
  const opened = await call("/control/money/accounts", {
    ck: ck("owner"), method: "POST",
    body: { code: "RC-CASH", label: "Recon smoke counter cash", kind: "asset", currency: "TZS",
      note: "The fixture line the statement is drawn of" }
  });
  const CASH = opened.json?.id;
  if (opened.status !== 200 || !CASH) throw new Error(`cannot open the fixture account — `
    + `${opened.status} ${JSON.stringify(opened.json)}`);
  // A line in the other book, which must not be readable from this one.
  await oi(`insert into money_accounts (tenant_id, code, label, kind, currency)
    values ($1,'RC-OTHER','Another book line','asset','TZS')`, [TX]);
  const OTHER_ACCOUNT = (await one(`select id from money_accounts
    where tenant_id = $1 and code = 'RC-OTHER'`, [TX])).id;
  // A count raised in the other book, by nobody at this desk. The reference has to be a real one:
  // 135's own CHECK keeps `^REC-YYYY-NNNNN$`, and a hand-planted row that breaks it is the gate's
  // problem, not this fixture's.
  const FOREIGN_RUN = randomUUID();
  const FOREIGN_REF = `REC-${TODAY.slice(0, 4)}-${STAMP.slice(-5)}`;
  await oi(`insert into money_reconciliation_runs (id, tenant_id, ref, scope, currency, from_day,
        to_day, examined, checks, findings, net_difference, raised_by)
      values ($1,$2,$3,'book','TZS', now()::date - 7, now()::date, '{}'::jsonb, 3, 0, 0, $4)`,
    [FOREIGN_RUN, TX, FOREIGN_REF, uOwner]);
  MY_IDS.push(FOREIGN_RUN);

  const delivery = async (name: string, body: {
    verified?: boolean; event?: string; payload?: any; processed?: boolean; error?: string;
  } = {}) => {
    const id = randomUUID();
    W_IDS.push(id);
    await oi(`insert into payment_webhooks (id, provider, event_type, signature_valid, replay_nonce,
          payload, processed_at, processing_error, created_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8, ${body.processed === false ? "now() - interval '3 hours'"
          : "now() - interval '2 hours'"})`,
      [id, RAIL, body.event ?? "approved", body.verified !== false, `${MARK}-${name}`,
        JSON.stringify(body.payload ?? {}),
        body.processed ? new Date() : null, body.error ?? null]);
    return id;
  };
  const charge = async (n: string, status: string, amount: string) => {
    const inv = randomUUID();
    await oi(`insert into invoices (id, tenant_id, number, billing_cycle, seats, amount_subtotal,
          vat_rate, vat_amount, amount_total, currency, status, period_start, period_end)
        values ($1,$2,$3,'monthly',5,$4,0.18,$5,$6,'TZS','issued',
          date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month'
          - interval '1 day')::date)`,
      [inv, TC, `INV-${MARK}-${n}`, amount,
        (Number(amount) * 0.18).toFixed(2), (Number(amount) * 1.18).toFixed(2)]);
    await oi(`insert into payments (id, tenant_id, invoice_id, provider, intent_reference, amount,
          currency, status, idempotency_key, requested_at, completed_at)
        values ($1,$2,$3,'mpesa',$4,$5,'TZS',$6,$7, now() - interval '2 hours',
          ${status === "pending" ? "null" : "now() - interval '1 hour'"})`,
      [randomUUID(), TC, inv, REF(n), amount, status, `idem-${MARK}-${n}`]);
    return { invoice: inv };
  };

  try {
    // ---------------- 1 · the door ----------------
    phase("1 · the door");
    check("an anonymous request never reads the count",
      (await call("/control/money/recon")).status === 401);
    check("a cookie with no session row behind it is refused",
      (await call("/control/money/recon", { ck: `${MARK}-nobody` })).status === 401);
    const asCompany = await call("/control/money/recon", { ck: ck("boss") });
    check("099: a company seat cannot open the office's desk at all",
      asCompany.status === 401, asCompany.json);
    check("…and cannot re-drive a delivery either",
      (await call("/control/gateway/webhooks", { ck: ck("boss") })).status === 401);

    // ---------------- 2 · the count is a fourth duty ----------------
    phase("2 · counting is not writing, and neither is reading a statement");
    const board = (who: string, qs = "") => call(`/control/money/recon${qs}`, { ck: ck(who) });
    const readOk = await Promise.all(["owner", "pen", "ice"].map((w) => board(w)));
    check("the three seats 135 named all open the board",
      readOk.every((r) => r.status === 200), readOk.map((r) => [r.status, words(r)]));

    const billBoard = await board("bill");
    // The guard's sentence is deliberately the same for every missing duty — a desk that could read
    // which key it lacked could map the office's duty table by probing it — so the key is not asserted
    // here. What makes this 403 the count and not the seat is the pair below it: the same cookie that
    // is refused the report opens a line on the chart, and the fixture read its own ground from
    // `role_permissions` before it signed in.
    check("a billing administrator who holds the pen is refused the count",
      billBoard.status === 403 && /platform role does not allow/i.test(words(billBoard))
      && !routed(billBoard),
      { status: billBoard.status, message: words(billBoard) });
    const billOpens = await call("/control/money/accounts", {
      ck: ck("bill"), method: "POST",
      body: { code: "RC-BILL", label: "The pen opens a line", kind: "asset", currency: "TZS" }
    });
    check("…and that 403 is the count, not the seat: the same cookie opens a line on the chart",
      billOpens.status === 200, billOpens.json);
    if (billOpens.json?.id) MY_IDS.push(billOpens.json.id);

    const auditBoard = await board("audit");
    check("an auditor reads the book but cannot count it",
      auditBoard.status === 403, { status: auditBoard.status, message: words(auditBoard) });
    const auditStatement = await call(
      `/control/money/accounts/${CASH}/statement?from=${WEEK_AGO}&to=${TODAY}`, { ck: ck("audit") });
    check("…and a statement is a read, so the auditor is handed one",
      auditStatement.status === 200 && auditStatement.json?.code === "RC-CASH",
      { status: auditStatement.status, message: words(auditStatement) });

    const supBoard = await board("sup");
    check("a support seat holds no money duty at all",
      supBoard.status === 403 && /platform role does not allow/i.test(words(supBoard)),
      { status: supBoard.status, message: words(supBoard) });
    const supRails = await call("/control/gateway/webhooks", { ck: ck("sup") });
    check("…and reads the delivery register, which is a different desk",
      supRails.status === 200, { status: supRails.status, message: words(supRails) });
    const iceOpens = await call("/control/money/accounts", {
      ck: ck("ice"), method: "POST",
      body: { code: "RC-NOPE", label: "The freezer cannot open a line", kind: "asset",
        currency: "TZS" }
    });
    check("the seat that signs for a count cannot write in the book",
      iceOpens.status === 403, iceOpens.json);

    // ---------------- 3 · a book that has never counted itself ----------------
    phase("3 · the board before the first count");
    const b0 = await board("owner");
    check("an empty count register answers as a page, not a silence",
      b0.status === 200 && b0.json?.rows?.length === 0 && b0.json?.count === 0
      && b0.json?.returned === 0 && b0.json?.limit === 60 && b0.json?.offset === 0
      && b0.json?.heading?.length === 0, b0.json);
    check("a count raised in another book is not in this one, and is answered as a 404",
      (await call(`/control/money/recon/${FOREIGN_RUN}`, { ck: ck("owner") })).status === 404);
    const hunt = await board("owner", `?search=${encodeURIComponent(MARK)}`);
    check("…and the other book's number does not leak into this board's search either",
      hunt.status === 200 && hunt.json?.count === 0, hunt.json);
    const notUuid = await call("/control/money/recon/not-a-count", { ck: ck("owner") });
    check("a number that is not a uuid is refused by the desk, in the desk's own words",
      notUuid.status === 400 && /that is not count/i.test(words(notUuid)) && routed(notUuid) === false,
      { status: notUuid.status, message: words(notUuid) });

    // ---------------- 4 · raising a count, and the window it is asked of ----------------
    phase("4 · the window");
    const runAs = (who: string, body: any) =>
      call("/control/money/recon/run", { ck: ck(who), method: "POST", body });
    const back = await runAs("pen", { scope: "book", currency: "TZS", from: TODAY, to: WEEK_AGO });
    check("a window that runs backwards is refused with the door's own sentence",
      back.status === 400 && /window runs backwards/i.test(words(back)) && !routed(back),
      { status: back.status, message: words(back), routed: routed(back) });
    const future = await runAs("pen", { scope: "book", currency: "TZS", from: WEEK_AGO,
      to: iso(new Date(Date.now() + 864e5)) });
    check("…and so is a window that ends on a day that has not happened",
      future.status === 400 && /to count up to yet/i.test(words(future)), words(future));
    const fakeDay = await runAs("pen", { scope: "book", currency: "TZS", from: "2026-02-30",
      to: TODAY });
    check("a day that only looks like one is refused before the door is reached",
      fakeDay.status === 400 && /on a calendar/i.test(words(fakeDay)) && routed(fakeDay),
      words(fakeDay));
    for (const [label, body] of [
      ["a scope the run cannot be filed under", { scope: "widget", from: WEEK_AGO, to: TODAY }],
      ["a money this book has not got", { scope: "book", currency: "EUR", from: WEEK_AGO,
        to: TODAY }],
      ["a window with no days in it", { scope: "book" }],
      ["a day typed the wrong shape", { scope: "book", from: "30/04/2026", to: TODAY }],
      ["a word the door has no branch for", { scope: "book", from: WEEK_AGO, to: TODAY, note: "x" }]
    ] as [string, any][]) {
      const r = await runAs("pen", body);
      check(`${label} is refused by the desk's enum, not the door`, r.status === 400,
        { status: r.status, message: words(r) });
    }
    check("…and none of the eleven wrote a count",
      (await one(`select count(*)::int as n from money_reconciliation_runs
        where tenant_id = any($1::uuid[])`, [[TP, TX]])).n === 1);

    // ---------------- 5 · a count, read three ways ----------------
    phase("5 · the count says what it looked at");
    const raised = await runAs("pen", { scope: "book", currency: "TZS", from: WEEK_AGO, to: TODAY });
    const R1 = raised.json;
    check("a count of the book lands", raised.status === 200 && R1?.ref, raised.json);
    if (R1?.id) MY_IDS.push(R1.id);
    check("…and it is numbered the way the paper is numbered",
      /^REC-\d{4}-\d{5}$/.test(String(R1?.ref ?? "")), R1?.ref);
    check("…draft, unsigned, and the desk is told it may still sign it",
      R1?.status === "open" && R1?.can_sign === true && R1?.reviewed_by === null
      && R1?.reviewed_at === null && R1?.review_note === null,
      { status: R1?.status, can_sign: R1?.can_sign, reviewed_by: R1?.reviewed_by });
    check("…raised by the seat that asked for it, by name",
      R1?.raised_by === "Faraji Pen" && R1?.scope === "book" && R1?.currency === "TZS"
      && R1?.from_day === WEEK_AGO && R1?.to_day === TODAY,
      { raised_by: R1?.raised_by, from: R1?.from_day, to: R1?.to_day });
    check("the three book questions are the ones it asked",
      R1?.checks === 3 && ["book_sums_to_zero", "posting_square", "account_totals"]
        .every((q) => (R1?.examined?.questions ?? []).includes(q)),
      { checks: R1?.checks, questions: R1?.examined?.questions });
    check("an empty book reports zero exceptions and names the population it found empty",
      R1?.findings === 0 && Array.isArray(R1?.exceptions) && R1.exceptions.length === 0
      && R1?.examined?.postings === 0 && R1?.examined?.legs === 0
      && num(R1?.net_difference) === 0,
      { findings: R1?.findings, examined: R1?.examined });
    check("…and the basis of the window is printed on the paper, not worked out by the desk",
      /whole register|window bounds/i.test(String(R1?.examined?.basis ?? "")), R1?.examined?.basis);

    const b1 = await board("owner");
    check("the board now carries the count, with the heading figures the whole window has",
      b1.json?.count === 1 && b1.json?.rows?.[0]?.ref === R1?.ref
      && Array.isArray(b1.json?.rows?.[0]?.worst) && b1.json.rows[0].worst.length === 0,
      { count: b1.json?.count, row: b1.json?.rows?.[0] });
    const hz = (b1.json?.heading ?? []).find((x: any) => x.currency === "TZS");
    check("…per money, because a TZS difference added to a USD one is the same crime in a report",
      hz && hz.runs === 1 && hz.open === 1 && hz.reviewed === 0 && hz.findings === 0
      && num(hz.net_difference) === 0, b1.json?.heading);
    check("a scope the office never filed a count under answers an empty pile",
      (await one(`select 1`), (await board("owner", "?scope=wallet")).json?.count === 0));
    check("…while `all` is the desk's word for do-not-filter and still shows the run",
      (await board("owner", "?scope=all")).json?.count === 1);
    check("status, currency and a search of the raiser's name all find the same row",
      (await board("owner", "?status=open")).json?.count === 1
      && (await board("owner", "?status=reviewed")).json?.count === 0
      && (await board("owner", "?currency=TZS")).json?.count === 1
      && (await board("owner", "?search=Faraji")).json?.count === 1
      && (await board("owner", "?search=Zzfq")).json?.count === 0);
    const badLimit = await board("owner", "?limit=900");
    check("a page wider than the door will print is refused",
      badLimit.status === 400, { status: badLimit.status, message: words(badLimit) });

    // ---------------- 6 · the two seats, from the side that refuses ----------------
    phase("6 · a count is signed by a seat that did not write it");
    const self = await call(`/control/money/recon/${R1.id}/sign`, {
      ck: ck("pen"), method: "POST", body: { note: "I read every figure on this paper myself." }
    });
    check("the seat that raised the count is refused its own signature",
      self.status === 409 && code(self) === "CONFLICT" && /did not write it/i.test(words(self)),
      { status: self.status, message: words(self) });
    check("…and the refusal travels as the door's word, so the desk can branch on the fact",
      self.json?.error?.details?.[0]?.reason === "same_seat", self.json?.error?.details);
    const shortNote = await call(`/control/money/recon/${R1.id}/sign`, {
      ck: ck("ice"), method: "POST", body: { note: "checked" }
    });
    check("a note too short to be a finding is refused before the door is reached",
      shortNote.status === 400, shortNote.json);
    const noDuty = await call(`/control/money/recon/${R1.id}/sign`, {
      ck: ck("bill"), method: "POST", body: { note: "A second pair of eyes on the same figures." }
    });
    check("a seat with the pen but not the count cannot sign either",
      noDuty.status === 403, noDuty.json);
    const noRun = await call(`/control/money/recon/${randomUUID()}/sign`, {
      ck: ck("ice"), method: "POST", body: { note: "A second pair of eyes on the same figures." }
    });
    check("a count this book does not hold is answered with the paper's own numbering",
      noRun.status === 404 && /REC-YYYY-NNNNN|no count with that number/i.test(words(noRun)),
      words(noRun));
    const stillOpen = await one(`select status, reviewed_by from money_reconciliation_runs
      where id = $1`, [R1.id]);
    check("…and every refusal left the draft a draft, with no name on it",
      stillOpen?.status === "open" && stillOpen?.reviewed_by === null, stillOpen);
    const signedAudit = await one(`select count(*)::int as n from audit_logs
      where tenant_id = $1 and action = 'recon.signed'`, [TP]);
    check("a refusal that made no paper filed no audit line either",
      Number(signedAudit.n) === 0, signedAudit);

    // ---------------- 7 · the deliveries the office never acted on ----------------
    phase("7 · the register of what the rails pushed");
    await charge("OPEN", "pending", "250000.00");
    await charge("PAID", "approved", "120000.00");
    const W_STUCK = await delivery("stuck", {
      payload: { reference: REF("OPEN"), outcome: "approved", event: "approved" }
    });
    const W_UNVERIFIED = await delivery("unverified", {
      verified: false, payload: { reference: REF("OPEN"), outcome: "approved" }
    });
    const W_NOREF = await delivery("noref", { payload: { outcome: "approved" } });
    const W_GHOST = await delivery("ghost", {
      payload: { reference: REF("GHOST"), outcome: "approved" }
    });
    const W_UNPARSED = await delivery("unparsed", {
      event: "unparsed", payload: { raw: "reference=???&sig=deadbeef" }
    });
    const W_LANDED = await delivery("landed", {
      processed: true, payload: { reference: REF("PAID"), outcome: "approved" }
    });
    const W_PII = await delivery("pii", {
      payload: {
        reference: REF("PII"), outcome: "approved", phone: "+255721000111",
        account_number: "0123456789", nida: "19841225J330", webhook_secret: "scrub-me",
        payer_phone: "+255721000111", note: "the reference the desk has to be able to quote",
        card: { card_number: "4111111111111111", expiry: "12/30", holder: "A Trader" }
      }
    });
    await charge("PII", "pending", "99000.00");
    // The pile the ceiling belongs to: five attempts filed by hand, so the sixth press is a refusal.
    const W_SPENT = await delivery("spent", {
      payload: { reference: REF("PII"), outcome: "approved" },
      error: "the completion raised the first time"
    });
    for (let a = 1; a <= 5; a++) {
      await oi(`insert into gateway_webhook_attempts (tenant_id, webhook_id, attempt, outcome,
            intent_reference, payment_status, message, answer, acted_by, acted_role, ip, user_agent)
          values ($1,$2,$3,'failed',$4,'pending',$5,'{}'::jsonb,$6,'support_engineer','127.0.0.1',
            'smoke-recon')`,
        [TP, W_SPENT, a, REF("PII"),
          `Attempt ${a} of the office's own re-drive of this delivery failed the same way.`
          + ` Filed by the fixture, not by a seat.`, uSup]);
    }
    note(`deliveries filed: stuck ${W_STUCK.slice(0, 8)} · unverified · no reference · ghost · `
      + `unparsed · landed · pii · spent(5 attempts)`);

    const gb = await call("/control/gateway/webhooks?limit=200", { ck: ck("sup") });
    check("the delivery register opens for a seat with the view duty",
      gb.status === 200 && Array.isArray(gb.json?.rows), { status: gb.status, json: gb.json });
    const mine = (gb.json?.rows ?? []).filter((r: any) => r.provider === RAIL);
    check("every delivery this run filed is on the board, newest first",
      mine.length === W_IDS.length, { onBoard: mine.length, filed: W_IDS.length });
    const byId = (id: string) => mine.find((r: any) => r.id === id);
    check("…and each row says whether the body could be read at all",
      byId(W_STUCK)?.readable === true && byId(W_UNPARSED)?.readable === false
      && byId(W_NOREF)?.readable === false,
      { stuck: byId(W_STUCK)?.readable, unparsed: byId(W_UNPARSED)?.readable });
    check("…the pile it belongs to is a flag on the row, not a colour on a dashboard",
      byId(W_STUCK)?.verified === true && byId(W_STUCK)?.processed_at === null
      && byId(W_UNVERIFIED)?.verified === false && byId(W_LANDED)?.processed_at !== null,
      { stuck: byId(W_STUCK), landed: byId(W_LANDED)?.processed_at });
    check("…and a delivery whose reference belongs to a real charge carries the charge",
      byId(W_STUCK)?.charge?.reference === REF("OPEN")
      && byId(W_STUCK)?.charge?.status === "pending"
      && byId(W_STUCK)?.charge?.tenant === `RC Smoke Cargo Ltd ${STAMP}`
      && byId(W_GHOST)?.charge === null,
      { charge: byId(W_STUCK)?.charge, ghost: byId(W_GHOST)?.charge });
    check("…five attempts spent is a number on the row, with the last one beside it",
      byId(W_SPENT)?.attempts === 5 && byId(W_SPENT)?.can_retry === false
      && byId(W_SPENT)?.last_attempt?.attempt === 5
      && byId(W_SPENT)?.last_attempt?.outcome === "failed",
      { attempts: byId(W_SPENT)?.attempts, last: byId(W_SPENT)?.last_attempt });
    const gh = (gb.json?.heading ?? []).find((x: any) => x.provider === RAIL);
    // `stuck` is a fact about the delivery row — signed, and no `processed_at` — not about the charge
    // 136 taught the count to ask. So six of the eight deliveries this run filed are on it, including
    // the ghost, the one with no reference and the one whose body could not be read.
    check("the heading counts this rail's own piles, and the chips cannot disagree with them",
      gh && gh.deliveries === W_IDS.length && gh.unverified === 1 && gh.landed === 1
      && gh.stuck === 6 && gh.orphan === 3 && gh.spent === 1 && gh.attempts === 5,
      gh);
    const stuck = await call("/control/gateway/webhooks?state=stuck", { ck: ck("sup") });
    check("one word asks for one pile",
      (stuck.json?.rows ?? []).filter((r: any) => r.provider === RAIL).length === 6,
      stuck.json?.rows?.filter((r: any) => r.provider === RAIL).map((r: any) => r.id));
    check("…and a pile the door has no word for is refused by the desk's enum",
      (await call("/control/gateway/webhooks?state=widget", { ck: ck("sup") })).status === 400);
    check("a seat with no gateway duty at all is refused the register",
      (await call("/control/gateway/webhooks", { ck: ck("pen") })).status === 403);

    // ---------------- 8 · one delivery whole, and what may be read out of it ----------------
    phase("8 · the payload a seat is shown");
    const dPii = await call(`/control/gateway/webhooks/${W_PII}`, { ck: ck("sup") });
    check("the delivery reads back with its scrubbed body",
      dPii.status === 200 && dPii.json?.charge?.reference === REF("PII"), dPii.json);
    const shown = JSON.stringify(dPii.json ?? {});
    check("the reference the desk needs to say which charge is stuck survives the scrub",
      dPii.json?.payload?.reference === REF("PII")
      && dPii.json?.payload?.note === "the reference the desk has to be able to quote",
      dPii.json?.payload);
    check("…and a payer's phone, account, NIDA and rail secret do not reach the browser at all",
      ["+255721000111", "0123456789", "19841225J330", "scrub-me", "4111111111111111", "12/30"]
        .every((leak) => !shown.includes(leak)),
      ["+255721000111", "0123456789", "19841225J330", "scrub-me", "4111111111111111", "12/30"]
        .filter((l) => shown.includes(l)));
    check("…not even as a key, and not from the charge block either",
      !("phone" in (dPii.json?.payload ?? {})) && !("account_number" in (dPii.json?.payload ?? {}))
      && !("nida" in (dPii.json?.payload ?? {}))
      && Object.keys(dPii.json?.charge ?? {}).every((k) => !/phone|encrypted/.test(k)),
      { keys: Object.keys(dPii.json?.payload ?? {}), charge: Object.keys(dPii.json?.charge ?? {}) });
    check("…but the desk is still told what the rail sent, by key",
      (dPii.json?.payload_keys ?? []).includes("reference")
      && (dPii.json?.payload_keys ?? []).includes("webhook_secret"),
      dPii.json?.payload_keys);
    const dUnparsed = await call(`/control/gateway/webhooks/${W_UNPARSED}`, { ck: ck("sup") });
    check("a body the platform could not read is named as one, and says why nothing can be re-driven",
      dUnparsed.json?.event === "unparsed" && dUnparsed.json?.can_retry === false
      && /names no charge/i.test(String(dUnparsed.json?.why_not ?? "")),
      { can_retry: dUnparsed.json?.can_retry, why_not: dUnparsed.json?.why_not });
    const dSpent = await call(`/control/gateway/webhooks/${W_SPENT}`, { ck: ck("sup") });
    check("the ceiling is the door's answer, stated as a fact about the pile",
      dSpent.json?.can_retry === false && dSpent.json?.attempts?.length === 5
      && /Five attempts is the ceiling/i.test(String(dSpent.json?.why_not ?? ""))
      && dSpent.json?.attempts?.[4]?.attempt === 5,
      { why_not: dSpent.json?.why_not, attempts: dSpent.json?.attempts?.length });
    const dLanded = await call(`/control/gateway/webhooks/${W_LANDED}`, { ck: ck("sup") });
    check("a delivery the office already acted on says so, in the ledger's words",
      dLanded.json?.can_retry === false && /already acted on this delivery/i
        .test(String(dLanded.json?.why_not ?? "")), dLanded.json?.why_not);
    const dStuck = await call(`/control/gateway/webhooks/${W_STUCK}`, { ck: ck("sup") });
    check("a verified delivery nobody answered for is the one thing that may be re-driven",
      dStuck.json?.can_retry === true && dStuck.json?.why_not === null
      && dStuck.json?.rail === null && dStuck.json?.attempts?.length === 0,
      { can_retry: dStuck.json?.can_retry, rail: dStuck.json?.rail });
    check("…and the register is honest that this rail has no row: the rail block is empty, not invented",
      "rail" in (dStuck.json ?? {}), Object.keys(dStuck.json ?? {}));
    const noRail = await call("/control/gateway/webhooks?provider=smoke", { ck: ck("read") });
    check("an analyst with the view duty and no button reads the same board",
      noRail.status === 200 && (noRail.json?.rows ?? []).length > 0, noRail.json);
    check("a delivery that never arrived is answered as not found, not as an empty page",
      (await call(`/control/gateway/webhooks/${randomUUID()}`, { ck: ck("sup") })).status === 404);

    // ---------------- 9 · re-driving a delivery ----------------
    phase("9 · the retry, and the ledger it writes");
    const press = (id: string, who = "sup") =>
      call(`/control/gateway/webhooks/${id}/retry`, { ck: ck(who), method: "POST" });
    const attCount = async (id: string) => Number((await one(
      `select count(*)::int as n from gateway_webhook_attempts where webhook_id = $1`, [id])).n);
    const auditCount = async (id: string) => Number((await one(
      `select count(*)::int as n from audit_logs where tenant_id = $1 and entity = 'payment_webhooks'
         and entity_id = $2 and action in ('gateway.webhook.retried','gateway.webhook.refused')`,
      [TP, id])).n);

    const refused = await press(W_UNVERIFIED);
    check("a delivery nobody signed is not an instruction: the press is refused",
      refused.status === 409 && refused.json?.error?.details?.[0]?.reason === "not_verified"
      && /did not match|never accepted/i.test(words(refused)),
      { status: refused.status, message: words(refused) });
    check("…but the attempt is still written, because a refused press is the fact 135 exists to count",
      (await attCount(W_UNVERIFIED)) === 1 && (await auditCount(W_UNVERIFIED)) === 1);
    const refRead = await one(`select outcome, payment_status, intent_reference, acted_by, message
      from gateway_webhook_attempts where webhook_id = $1`, [W_UNVERIFIED]);
    check("…filed as a refusal, with no charge closed and the seat's own name on it",
      refRead?.outcome === "refused" && refRead?.payment_status === null
      && /unverified_signature|never verified/i.test(String(refRead?.message ?? "")),
      { outcome: refRead?.outcome, message: String(refRead?.message ?? "").slice(0, 120) });

    const noRef = await press(W_NOREF);
    check("a delivery that names no charge cannot be completed for anything",
      noRef.status === 409 && /no reference|names no charge/i.test(words(noRef)), words(noRef));
    const unparsed = await press(W_UNPARSED);
    check("…and the refusal says the rarer thing too: a body the platform never read at all",
      unparsed.status === 409 && /could not read at all/i.test(words(unparsed)), words(unparsed));

    const ghost = await press(W_GHOST);
    check("a real delivery whose reference belongs to no charge is an attempt that failed",
      ghost.status === 200 && ghost.json?.status === "attempted"
      && ghost.json?.outcome === "failed" && ghost.json?.answer?.status === "not_found",
      { status: ghost.status, json: ghost.json });
    check("…answered at 200, because the press happened and the ledger is the answer",
      /not ours|belongs to no charge|nothing to close/i.test(said(ghost)), said(ghost));
    check("…and the attempt row carries the reference even though no charge does",
      (await attCount(W_GHOST)) === 1 && (await one(
        `select payment_status from gateway_webhook_attempts where webhook_id = $1`, [W_GHOST]))
        ?.payment_status === null);

    const land = await press(W_STUCK);
    check("a verified delivery against a charge still open lands on the first press",
      land.status === 200 && land.json?.outcome === "succeeded" && land.json?.attempt === 1
      && land.json?.answer?.status === "ok", { status: land.status, json: land.json });
    const payRow = await one(`select p.status, p.completed_at is not null as done, p.invoice_id,
        t.status as tenant_status, t.licence_expires_at is not null as licensed,
        i.status as invoice_status
      from payments p join tenants t on t.id = p.tenant_id join invoices i on i.id = p.invoice_id
      where p.intent_reference = $1`, [REF("OPEN")]);
    check("…and the licence landed with it: the charge, the invoice and the company all moved",
      payRow?.status === "approved" && payRow?.done === true
      && payRow?.invoice_status === "paid" && payRow?.tenant_status === "active"
      && payRow?.licensed === true, payRow);
    check("…and the message names the day the licence now runs to",
      /licence runs to \d{4}-\d{2}-\d{2}/.test(String(land.json?.message ?? "")),
      String(land.json?.message ?? "").slice(0, 200));
    // 135 files the landing on the *company's* row, the way the webhook route does: the charge belongs
    // to the cargo tenant, so a read bound to the office's book would find nothing and say the licence
    // landed unrecorded.
    const landing = await one(`select count(*)::int as n from audit_logs
      where tenant_id = $1 and entity = 'payments' and action = 'payment.approved.retry'`, [TC]);
    check("the landing of a licence is audited on the company's own row, once, naming the desk",
      Number(landing.n) === 1 && (await one(`select after ->> 'via' as via from audit_logs
        where tenant_id = $1 and entity = 'payments' and action = 'payment.approved.retry'`,
      [TC]))?.via === "desk retry", landing);
    check("…and the delivery's own ledger row says the same thing the door answered",
      land.json?.delivery?.attempts?.length === 1 && (await attCount(W_STUCK)) === 1
      && land.json?.delivery?.can_retry === true,
      { attempts: land.json?.delivery?.attempts?.length, can: land.json?.delivery?.can_retry });

    const twice = await press(W_STUCK);
    check("a second press is answered `already_final`, not refused — an idempotent door tells the truth",
      twice.status === 200 && twice.json?.outcome === "already_final" && twice.json?.attempt === 2
      && /already approved before this attempt/i.test(said(twice)),
      { outcome: twice.json?.outcome, message: said(twice) });
    check("…and the charge did not move again",
      (await one(`select completed_at from payments where intent_reference = $1`,
        [REF("OPEN")])).completed_at instanceof Date);
    for (const _ of Array.from({ length: 3 })) await press(W_STUCK, "owner");
    const spent = await press(W_STUCK, "owner");
    check("the sixth press spends the ceiling and is refused",
      spent.status === 409 && spent.json?.error?.details?.[0]?.reason === "attempts_spent"
      && /talk to|its own register/i.test(words(spent)), { status: spent.status, message: words(spent) });
    check("…and a ceiling refused writes no row and no audit line, because the ceiling is a rule",
      (await attCount(W_STUCK)) === 5 && (await auditCount(W_STUCK)) === 5,
      { attempts: await attCount(W_STUCK), audit: await auditCount(W_STUCK) });
    const afterCeiling = await one(`select count(*)::int as n from money_entries`);
    check("…and none of it wrote money: the book holds exactly what it held before",
      Number(afterCeiling.n) === BASE.legs_all, afterCeiling);

    const landed = await press(W_LANDED);
    check("a press on a delivery the office already acted on is answered, not blocked",
      landed.status === 200 && landed.json?.outcome === "already_final",
      { status: landed.status, outcome: landed.json?.outcome });
    note("135's retry door guards the signature, the reference and the ceiling; `can_retry` is the "
      + "door's answer about the BUTTON, and a press against a landed delivery is harmless because "
      + "009 is idempotent. Pinned here so the desk's comment cannot drift into promising more.");
    const noRetry = await press(W_PII, "pen");
    check("a seat without the retry duty is refused by the guard, in the guard's generic words",
      noRetry.status === 403 && /platform role does not allow/i.test(words(noRetry)),
      { status: noRetry.status, message: words(noRetry) });
    check("…and nothing was attempted: the ledger still says what it said",
      (await attCount(W_PII)) === 0, await attCount(W_PII));
    const analystPress = await press(W_PII, "read");
    check("an analyst who reads the register cannot press the button",
      analystPress.status === 403, analystPress.json);
    check("…and the register read still answers for the same seat",
      (await call("/control/gateway/webhooks/00000000-0000-0000-0000-000000000000",
        { ck: ck("read") })).status === 404);

    const gb2 = await call("/control/gateway/webhooks?state=retried&limit=200", { ck: ck("sup") });
    const retried = (gb2.json?.rows ?? []).filter((r: any) => r.provider === RAIL);
    // Every press this run made wrote a ledger row — a refused press is the very fact 135 exists to
    // count — so the pile is all eight deliveries except W_PII, whose two presses died at the 403
    // guard before a row could be written. W_STUCK and W_SPENT each sit at the ceiling of 5.
    check("the `retried` pile is every delivery carrying an attempt, with the count beside it",
      retried.length === 7 && retried.every((r: any) => r.attempts > 0)
      && retried.find((r: any) => r.id === W_STUCK)?.attempts === 5
      && retried.find((r: any) => r.id === W_SPENT)?.attempts === 5
      && !retried.some((r: any) => r.id === W_PII),
      retried.map((r: any) => [r.id.slice(0, 8), r.attempts]));
    const spentHead = (await call("/control/gateway/webhooks?state=orphan&limit=200",
      { ck: ck("sup") })).json;
    check("the orphan pile holds the ghost, the delivery with no reference and the unreadable body",
      (spentHead?.rows ?? []).filter((r: any) => r.provider === RAIL).length === 3,
      spentHead?.rows?.filter((r: any) => r.provider === RAIL).map((r: any) => r.event));

    // ---------------- 10 · a count that reads the rails ----------------
    phase("10 · the count asks the rails the same questions");
    const gateRun = await runAs("ice", { scope: "gateway", currency: "TZS", from: WEEK_AGO,
      to: TODAY });
    const G1 = gateRun.json;
    if (G1?.id) MY_IDS.push(G1.id);
    check("a compliance officer with no pen raises the count",
      gateRun.status === 200 && G1?.scope === "gateway", { status: gateRun.status, json: G1 });
    check("…and the rails' four questions are on the paper",
      ["webhook_unverified", "webhook_not_landed", "webhook_orphan", "webhook_retries_spent"]
        .every((q) => (G1?.examined?.questions ?? []).includes(q)), G1?.examined?.questions);
    const find = (c: string, ref: string) => (G1?.exceptions ?? [])
      .find((e: any) => e.check === c && String(e.subject_ref ?? "") === ref);
    check("a verified delivery whose charge is still open is the exception, with both figures",
      !!find("webhook_not_landed", REF("PII"))
      && find("webhook_not_landed", REF("PII"))?.verdict === "missing_book"
      && num(find("webhook_not_landed", REF("PII"))?.paper_figure) === 99000
      && find("webhook_not_landed", REF("PII"))?.detail?.payment_status === "pending",
      (G1?.exceptions ?? []).filter((e: any) => e.check === "webhook_not_landed")
        .map((e: any) => [e.subject_ref, e.detail?.payment_status]));
    check("…and 136: the stuck delivery the desk re-drove and landed is not reported as never acted on",
      !find("webhook_not_landed", REF("OPEN")), (G1?.exceptions ?? [])
        .filter((e: any) => e.check === "webhook_not_landed").map((e: any) => e.subject_ref));
    check("an unverified delivery is named as a refusal, with its reference on the line",
      !!find("webhook_unverified", REF("OPEN")), (G1?.exceptions ?? [])
      .filter((e: any) => e.check === "webhook_unverified").map((e: any) => e.subject_ref));
    check("a delivery with no reference is orphaned under the rail's own name",
      !!find("webhook_orphan", `${RAIL} no reference`) || !!find("webhook_orphan", ""),
      (G1?.exceptions ?? []).filter((e: any) => e.check === "webhook_orphan")
        .map((e: any) => e.subject_ref));
    check("a delivery whose reference belongs to nothing is orphaned under the reference",
      !!find("webhook_orphan", REF("GHOST")), REF("GHOST"));
    check("and a delivery that spent five attempts is stale, named by its reference",
      !!find("webhook_retries_spent", REF("PII")), (G1?.exceptions ?? [])
      .filter((e: any) => e.check === "webhook_retries_spent").map((e: any) => e.subject_ref));
    check("…with the count and the last press in the sentence a clerk reads",
      /5 times/.test(String(find("webhook_retries_spent", REF("PII"))?.detail?.why ?? "")),
      String(find("webhook_retries_spent", REF("PII"))?.detail?.why ?? "").slice(0, 160));
    check("the run's own exception count is the number of lines it wrote, and the net is summed",
      G1?.findings === (G1?.exceptions ?? []).length
      && num(G1?.net_difference) === (G1?.exceptions ?? [])
        .reduce((s: number, e: any) => s + (num(e.difference) ?? 0), 0),
      { findings: G1?.findings, lines: (G1?.exceptions ?? []).length, net: G1?.net_difference });
    check("…grouped by question, so the signing seat reads the summary before the list",
      (G1?.by_check ?? []).some((b: any) => b.check === "webhook_orphan" && b.exceptions >= 1)
      && (G1?.by_check ?? []).every((b: any) => b.check && typeof b.exceptions === "number"),
      G1?.by_check);
    const usd = await runAs("ice", { scope: "all", currency: "USD", from: WEEK_AGO, to: TODAY });
    check("a count in the other money says out loud that the rails were not asked about it",
      usd.status === 200 && (usd.json?.examined?.skipped ?? [])
        .some((s: string) => /TZS only/.test(s)), usd.json?.examined?.skipped);
    if (usd.json?.id) MY_IDS.push(usd.json.id);

    const bSearch = await board("owner", `?search=${encodeURIComponent(REF("OPEN"))}`);
    check("a board search finds a count by the reference one of its exceptions names",
      (bSearch.json?.rows ?? []).some((r: any) => r.id === G1.id), bSearch.json?.count);
    const oneRun = await call(`/control/money/recon/${G1.id}`, { ck: ck("owner") });
    check("the detail carries every exception, unpaginated, because a signature needs the whole list",
      oneRun.status === 200 && oneRun.json?.exceptions?.length === G1.findings
      && oneRun.json?.examined?.deliveries === G1?.examined?.deliveries,
      { inDetail: oneRun.json?.exceptions?.length, inRun: G1?.findings });

    // ---------------- 11 · throwing away a draft ----------------
    phase("11 · a draft is a rehearsal");
    const shortReason = await call(`/control/money/recon/${G1.id}/discard`, {
      ck: ck("ice"), method: "POST", body: { reason: "oops" }
    });
    check("a count cannot be thrown away without a sentence",
      shortReason.status === 400, shortReason.json);
    const wrongSeat = await call(`/control/money/recon/${G1.id}/discard`, {
      ck: ck("bill"), method: "POST", body: { reason: "The rails were not ours to count today." }
    });
    check("…or by a seat that never had the count", wrongSeat.status === 403, wrongSeat.json);
    const discarded = await call(`/control/money/recon/${G1.id}/discard`, {
      ck: ck("ice"), method: "POST",
      body: { reason: "Raised against a window the office had already re-driven by hand; the "
        + "exceptions are this afternoon's, not the month's." }
    });
    check("an open count is thrown away, and the paper's own account comes back with it",
      discarded.status === 200 && discarded.json?.status === "discarded"
      && discarded.json?.ref === G1.ref && discarded.json?.discarded?.findings === G1.findings,
      discarded.json);
    const gone = await one(`select
        (select count(*) from money_reconciliation_runs where id = $1) as run,
        (select count(*) from money_reconciliation_findings where run_id = $1) as lines,
        (select count(*) from money_reconciliation_findings f
           left join money_reconciliation_runs r on r.id = f.run_id
          where r.id is null) as orphans`, [G1.id]);
    check("the count goes, its exceptions go with it, and no finding is left without a run",
      Number(gone.run) === 0 && Number(gone.lines) === 0 && Number(gone.orphans) === 0, gone);
    const kept = await one(`select before, after ->> 'reason' as reason,
        (after ->> 'findings_removed')::int as removed, action
      from audit_logs where tenant_id = $1 and entity = 'money_reconciliation_runs'
        and action = 'recon.discarded' order by id desc limit 1`, [TP]);
    check("the office still knows the count happened, by whom, and what they said about it",
      kept?.before?.ref === G1.ref && /already re-driven by hand/.test(String(kept?.reason ?? ""))
      && Number(kept?.removed) === G1.findings, kept);
    const again = await call(`/control/money/recon/${G1.id}/discard`, {
      ck: ck("ice"), method: "POST", body: { reason: "Throwing the same draft away twice." }
    });
    check("a count that is already gone is answered as gone",
      again.status === 404 && /already thrown away/i.test(words(again)), words(again));

    const R2 = await runAs("pen", { scope: "book", currency: "TZS", from: WEEK_AGO, to: TODAY });
    if (R2.json?.id) MY_IDS.push(R2.json.id);
    check("the numbering gap the discarded count left is kept: the next number is higher",
      Number(String(R2.json?.ref ?? "").slice(-5)) > Number(String(G1.ref).slice(-5)),
      { discarded: G1.ref, next: R2.json?.ref });

    // ---------------- 12 · one line of the book, on screen and on paper ----------------
    phase("12 · the statement of one line");
    const st = await call(`/control/money/accounts/${CASH}/statement?from=${WEEK_AGO}&to=${TODAY}`,
      { ck: ck("owner") });
    check("a statement of an empty window still prints its own heading",
      st.status === 200 && st.json?.code === "RC-CASH" && st.json?.kind === "asset"
      && st.json?.natural_side === "debit" && num(st.json?.opening) === 0
      && num(st.json?.closing) === 0 && num(st.json?.moved) === 0 && st.json?.legs === 0
      && st.json?.rows?.length === 0, st.json);
    check("the closing is the opening plus what the window moved, stated on the paper",
      /opening is every leg before/.test(String(st.json?.basis ?? ""))
      && String(st.json?.basis ?? "").includes("RC-CASH"), st.json?.basis);
    check("the cached figure and the statement's are printed beside each other as `drift`",
      st.json?.drift?.agrees === true && num(st.json?.drift?.cached_balance) === 0
      && st.json?.drift?.legs_cached === 0, st.json?.drift);
    const stOld = await call(
      `/control/money/accounts/${CASH}/statement?from=${LAST_MONTH}&to=${WEEK_AGO}`,
      { ck: ck("owner") });
    check("a window that does not close today is not evidence of drift, so `agrees` is null",
      stOld.status === 200 && stOld.json?.drift?.agrees === null
      && stOld.json?.drift?.window_ends_today === false, stOld.json?.drift);
    const stBack = await call(`/control/money/accounts/${CASH}/statement?from=${TODAY}&to=${WEEK_AGO}`,
      { ck: ck("owner") });
    check("a backwards window is stopped by the desk, which names the field it typed wrong",
      stBack.status === 400 && routed(stBack) && /runs backwards/i.test(words(stBack)),
      { status: stBack.status, message: words(stBack) });
    const stFuture = await call(`/control/money/accounts/${CASH}/statement?from=${WEEK_AGO}&to=${
      iso(new Date(Date.now() + 864e5))}`, { ck: ck("owner") });
    check("…while a day that has not happened is the door's own refusal",
      stFuture.status === 400 && /close a statement on yet/i.test(words(stFuture)) && !routed(stFuture),
      words(stFuture));
    check("a line in another book is not in this one, and is answered as a 404",
      (await call(`/control/money/accounts/${OTHER_ACCOUNT}/statement?from=${WEEK_AGO}&to=${TODAY}`,
        { ck: ck("owner") })).status === 404);
    check("…and so is a uuid this book has never heard of",
      (await call(`/control/money/accounts/${randomUUID()}/statement?from=${WEEK_AGO}&to=${TODAY}`,
        { ck: ck("owner") })).status === 404);
    check("a page wider than the door clamps is refused",
      (await call(`/control/money/accounts/${CASH}/statement?from=${WEEK_AGO}&to=${TODAY}&limit=900`,
        { ck: ck("owner") })).status === 400);
    check("a seat with no money duty cannot ask for a statement at all",
      (await call(`/control/money/accounts/${CASH}/statement?from=${WEEK_AGO}&to=${TODAY}`,
        { ck: ck("sup") })).status === 403);
    // Opening a chart line files an audit row on `money_accounts`, so the register already carries two
    // by the time a statement is read; what a statement read must add is nothing. So the proof is the
    // count held still across one more screen read, not a zero that was never true.
    const stOpen = await one(`select count(*)::int as n from audit_logs
      where tenant_id = $1 and entity = 'money_accounts'`, [TP]);
    await call(`/control/money/accounts/${CASH}/statement?from=${WEEK_AGO}&to=${TODAY}`,
      { ck: ck("owner") });
    const stAudit = await one(`select count(*)::int as n from audit_logs
      where tenant_id = $1 and entity = 'money_accounts'`, [TP]);
    check("reading a statement on screen files no audit row: the door has nothing to answer for",
      Number(stAudit.n) === Number(stOpen.n), { before: stOpen.n, after: stAudit.n });

    for (const [ext, mime, needle] of [
      ["csv", "text/csv", "line,day,ref"],
      ["xlsx", "spreadsheetml", "PK"],
      ["pdf", "application/pdf", "%PDF"]
    ] as [string, string, string][]) {
      const f = await call(`/control/money/accounts/${CASH}/statement.${ext}?from=${WEEK_AGO}&to=${TODAY}`,
        { ck: ck("audit"), raw: true });
      check(`the statement leaves the office as a ${ext.toUpperCase()}`,
        f.status === 200 && String(f.type).includes(mime) && f.bytes?.length > 0
        && f.bytes?.subarray(0, needle.length).toString("latin1") === needle
        || (ext === "csv" && f.text.includes(needle)),
        { status: f.status, type: f.type, head: f.bytes?.subarray(0, 12).toString("latin1") });
      check(`…named for the line it was drawn of, and never cached`,
        new RegExp(`^attachment; filename="statement-of-rc-cash-\\d{4}-\\d{2}-\\d{2}\\.${ext}"$`)
          .test(f.disposition ?? "")
        && /no-store/i.test(f.cache ?? ""), { disposition: f.disposition, cache: f.cache });
      const row = await one(`select action, after from audit_logs
        where tenant_id = $1 and entity = 'money_accounts' and action = $2
        order by id desc limit 1`, [TP, `control.money.statement_${ext}`]);
      check(`…and the act of printing it is a fact only this desk knows, so this desk files it`,
        row?.action === `control.money.statement_${ext}` && row?.after?.code === "RC-CASH"
        && row?.after?.rows === 0 && Number(row?.after?.bytes) > 0, row);
      check(`…in the auditor's own name, because a statement an accountant is handed is theirs`,
        (await one(`select actor_role from audit_logs where tenant_id = $1 and action = $2
          order by id desc limit 1`, [TP, `control.money.statement_${ext}`]))?.actor_role
        === "auditor");
    }
    const refusedFile = await call(`/control/money/accounts/${CASH}/statement.csv?from=${WEEK_AGO}&to=${TODAY}`,
      { ck: ck("sup"), raw: true });
    check("a seat with no money duty is refused the file before a byte is built",
      refusedFile.status === 403, { status: refusedFile.status });
    check("…and no audit row was filed for a print that never happened",
      Number((await one(`select count(*)::int as n from audit_logs where tenant_id = $1
        and actor_user_id = $2 and action like 'control.money.statement_%'`,
      [TP, uSup])).n) === 0);

    // ---------------- 13 · nothing here touched the office's own book ----------------
    phase("13 · the office's own book");
    const after = await one(`select
        (select count(*)::int from money_accounts where tenant_id = $1) as accounts,
        (select count(*)::int from money_postings where tenant_id = $1) as postings,
        (select count(*)::int from money_entries) as legs_all,
        (select count(*)::int from money_reconciliation_runs where tenant_id = $1) as runs,
        (select count(*)::int from gateway_webhook_attempts where tenant_id = $1) as attempts,
        (select count(*)::int from payment_webhooks where provider <> $2) as real_deliveries`,
      [PLAT, RAIL]);
    check("135 reconciles the book and never edits it: the office's own figures are what they were",
      after?.accounts === BASE.accounts && after?.postings === BASE.postings
      && after?.legs_all === BASE.legs_all, after);
    check("…and no count or attempt was ever filed against the real office's book",
      Number(after?.runs) === 0 && Number(after?.attempts) === 0, after);
    check("…and the deliveries that were already here were not rewritten by any of it",
      Number(after?.real_deliveries) === BASE.deliveries,
      { now: after?.real_deliveries, before: BASE.deliveries });

    failures += await teardown(oi, one, { BASE, TP, TX, TC, MARK, RAIL, W_IDS, MY_IDS, num });
  } catch (e) {
    console.log(`FAIL  the run itself raised: ${(e as Error)?.message ?? e}`);
    console.log((e as Error)?.stack ?? "");
    failures++;
    try { failures += await teardown(oi, one, { BASE, TP, TX, TC, MARK, RAIL, W_IDS, MY_IDS, num }); }
    catch { console.log("      teardown also failed after the raise — the sweep above is the fix"); }
  } finally {
    await owner.end().catch(() => undefined);
  }

  console.log(`\n${failures ? `FAILURES: ${failures}` : "all checks passed"} `
    + `(${((Date.now() - START) / 1000).toFixed(1)}s)`);
  process.exit(failures ? 1 : 0);
}

/** Delete everything this run wrote, prove the register is back to its own numbers, and leave the
 *  audit lines behind — they are the office's history, and `prevent_audit_mutation()` refuses the
 *  owner too. Returns the number of new failures found on the way out. */
async function teardown(oi: any, one: any, ctx: any): Promise<number> {
  let broken = 0;
  const say = (label: string, ok: boolean, detail?: unknown) => {
    console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined
      ? "" : " — " + JSON.stringify(detail)}`);
    if (!ok) broken++;
  };
  phase("teardown");
  try {
    await oi(`delete from gateway_webhook_attempts where tenant_id in
        (select id from tenants where name like $1)`, ["RC Smoke %"]);
    await oi(`delete from payment_webhooks where provider = $1
        or payload ->> 'reference' like $2 or replay_nonce like $3`,
      [ctx.RAIL, `WSH-${ctx.MARK}%`, `${ctx.MARK}%`]);
    await oi(`delete from money_reconciliation_findings where tenant_id in
        (select id from tenants where name like $1)`, ["RC Smoke %"]);
    await oi(`delete from money_reconciliation_runs where tenant_id in
        (select id from tenants where name like $1)`, ["RC Smoke %"]);
    await oi(`delete from payments where tenant_id in (select id from tenants where name like $1)
        or intent_reference like $2`, ["RC Smoke %", `WSH-${ctx.MARK}%`]);
    await oi(`delete from invoices where tenant_id in (select id from tenants where name like $1)
        or number like $2`, ["RC Smoke %", `INV-${ctx.MARK}%`]);
    await oi(`delete from money_accounts where tenant_id in
        (select id from tenants where name like $1)`, ["RC Smoke %"]);
    const tids = (await oi(`select id from tenants where name like $1`, ["RC Smoke %"]))
      .rows.map((r: any) => r.id);
    const uids = tids.length
      ? (await oi(`select id from users where tenant_id = any($1::uuid[])`, [tids]))
        .rows.map((r: any) => r.id) : [];
    if (uids.length) {
      await oi(`delete from user_roles where user_id = any($1::uuid[])`, [uids]);
      await oi(`delete from sessions where user_id = any($1::uuid[])`, [uids]);
    }
    await oi(`delete from users where tenant_id = any($1::uuid[])`, [tids]);
    await oi(`delete from tenants where id = any($1::uuid[])`, [tids]);
    await oi(`delete from rate_limits
        where right(bucket, 36) = any($1::text[])
           or bucket like 'money-recon%' or bucket like 'money-statement%'
           or bucket like 'money-account%' or bucket like 'gateway:webhook%'`, [uids]);
  } catch (e) {
    say("the sweep ran clean", false, String((e as Error)?.message ?? e));
  }
  const rest = await one(`select
      (select count(*)::int from tenants where name like 'RC Smoke %') as books,
      (select count(*)::int from users where email like 'smoke.rc.%@waisha.test') as seats,
      (select count(*)::int from payment_webhooks where provider <> $2) as deliveries,
      (select count(*)::int from gateway_webhook_attempts) as attempts,
      (select count(*)::int from money_reconciliation_runs) as runs,
      (select count(*)::int from money_reconciliation_findings) as findings,
      (select count(*)::int from money_entries) as legs,
      (select count(*)::int from payments where intent_reference like $1) as charges`,
    [`WSH-${ctx.MARK}%`, ctx.RAIL]);
  say("no fixture book, seat or charge is left behind",
    Number(rest.books) === 0 && Number(rest.seats) === 0 && Number(rest.charges) === 0, rest);
  say("the delivery register is back to exactly the deliveries it held",
    Number(rest.deliveries) === ctx.BASE.deliveries,
    { now: rest.deliveries, before: ctx.BASE.deliveries });
  say("…and so are the retry ledger, the count register and the book's legs",
    Number(rest.attempts) === ctx.BASE.attempts && Number(rest.runs) === ctx.BASE.runs
    && Number(rest.findings) === ctx.BASE.findings && Number(rest.legs) === ctx.BASE.legs_all, rest);
  return broken;
}

main().catch((e) => { console.error(e); process.exit(1); });
