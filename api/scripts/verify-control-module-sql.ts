/**
 * Live proof for migration 088 — the allocation of package income across the three offices
 * (task #155, revenue-per-module half).
 *
 * Why this one has to be arithmetic rather than a description. The advisory card said income
 * "can be attributed to a package but never split across transport, CFA and office", and the
 * answer built a split out of how much work each office recorded. A split like that is
 * exactly the kind of number that looks authoritative and is quietly wrong: a share that does
 * not add up to the company's money, a cent that vanishes into rounding, an office paid for
 * work its package never included, a company dropped so that the six lines no longer sum to
 * the invoices. None of that is visible from a row that looks plausible. So every expected
 * figure below is a hand-computed literal — 5/3/3 units over a 1,000,000.01 invoice is
 * 454,545.45 / 272,727.28 / 272,727.28 because someone did that division on purpose — and the
 * run compares the function against it, not against itself. When the two disagreed, the
 * figures were re-derived from the definition in 088 and the hand-work was corrected: a trip
 * and the invoice billed on it are two pieces of transport work.
 *
 * Sections: 1 the posture, read out of the catalog. 2 the live corpus reconciles against a
 * plain sum of the invoices and passes. 3 a nine-company fixture, inside one transaction that
 * is rolled back, whose every figure was computed by hand. 4 the same two readers run as
 * app_runtime, with the engine proven unreachable from it. 5 nothing survived the run.
 *
 * Run: npx tsx scripts/verify-control-module-sql.ts   (DNS_FALLBACK=1 if DNS broken)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else {
    failures++;
    console.log("FAIL ", label, JSON.stringify(detail).slice(0, 700));
  }
}

const ownerUrl = () => {
  const u = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!u) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  return u;
};
/** app_runtime URL: dev hands us the owner URL, so rebuild it (066's shape). */
function appUrl(): string | null {
  const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  const u = new URL(url);
  if (u.username.startsWith("app_runtime")) return url;
  if (!process.env.APP_DB_PASSWORD) return null;
  const ref = u.username.split(".")[1];
  u.username = "app_runtime" + (ref ? "." + ref : "");
  u.password = encodeURIComponent(process.env.APP_DB_PASSWORD);
  return u.toString();
}

/** Money is compared in whole cents: no float equality, no tolerance for a lost cent. */
const cents = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
const N = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const sumOf = (rows: any[], field: string) =>
  rows.reduce((s, r) => s + cents(r[field] ?? 0)!, 0);

const READERS = ["control_module_allocation", "control_module_allocation_tenants"];
const ALL_FNS = [...READERS, "module_allocation_base"];
const ORDER = "transport,cfa,office,plan_ladder,directory_search,unattributed";

/** The nine companies, in the order the engine must print them at 90 days. */
const COMPANY_ORDER = ["A", "F", "H", "C", "D", "B", "G", "E", "I"];

async function main() {
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();
  const stamp = Date.now().toString().slice(-6);

  const ids: Record<string, string> = {};
  /** Letter order — the order the tenant insert binds its parameters in. */
  const FIX = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
  for (const k of [...FIX, ...COMPANY_ORDER, "SK1", "SK2", "SK3", "PLAT", "G1", "G2",
    "SA", "SB", "SC", "SD", "SF1", "SF2", "SG", "SH", "SI", "EMP"]) ids[k] = randomUUID();
  const t = (k: string) => ids[k];
  const COMPANY_IDS = FIX.map(t);
  const TENANT_IDS = [...COMPANY_IDS, ids.SK1, ids.SK2, ids.SK3, ids.PLAT];

  const linesOf = async (days: number) => (await owner.query(
    `select module, module_label, basis, customers, units, income, share, usage_income,
            even_income, platform_income, window_days, currency
       from platform_auth.control_module_allocation($1)`, [days])).rows as any[];
  const invoiceTotal = async (days: number) => String((await owner.query(
    `select coalesce(sum(i.amount_total), 0) as v
       from invoices i join tenants tc on tc.id = i.tenant_id
      where i.deleted_at is null and i.status = 'paid' and i.paid_at is not null
        and tc.deleted_at is null and tc.type <> 'platform'
        and i.paid_at >= now() - make_interval(days => $1)`, [days])).rows[0].v);
  const passTotal = async (days: number) => String((await owner.query(
    `select coalesce(sum(amount), 0) as v from seeker_search_passes
      where deleted_at is null and status in ('live','expired') and verified_at is not null
        and verified_at >= now() - make_interval(days => $1)`, [days])).rows[0].v);

  // ------------------------------------------------------------------ 1. posture
  const fns = (await owner.query(
    `select p.proname, p.prosecdef, p.provolatile, array_to_string(p.proconfig, ',') as cfg,
            pg_get_userbyid(p.proowner) as fnowner,
            (select string_agg(distinct r.rolname || ':' || a.privilege_type, ' ')
               from aclexplode(p.proacl) a left join pg_roles r on r.oid = a.grantee
              where a.privilege_type = 'EXECUTE') as executors
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [ALL_FNS])).rows as any[];
  const fn = (name: string) => fns.find(f => f.proname === name);

  for (const name of ALL_FNS) {
    const f = fn(name);
    check(`088: platform_auth.${name} exists`, !!f, fns.map(x => x.proname));
    if (!f) continue;
    check(`088: ${name} is SECURITY DEFINER with a pinned search_path`,
      f.prosecdef === true && f.cfg === "search_path=public", f);
    check(`088: ${name} is STABLE — it writes nothing, so a desk can call it inside a ` +
      `transaction without touching the register`, f.provolatile === "s", f.provolatile);
  }
  const priorOwner = (await owner.query(
    `select pg_get_userbyid(p.proowner) as o from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'platform_auth' and p.proname = 'control_revenue_mix'`)).rows[0]?.o;
  check("088: all three belong to the same owner as the 068 desk readers, so they see " +
    "through the same RLS wall and no wider one",
    ALL_FNS.every(nm => fn(nm)?.fnowner === priorOwner),
    { priorOwner, owners: ALL_FNS.map(nm => fn(nm)?.fnowner) });

  for (const name of READERS) {
    const ex = fn(name)?.executors ?? "";
    check(`088: app_runtime holds EXECUTE on ${name} — that is the desk's door`,
      ex.includes("app_runtime:EXECUTE"), ex);
    check(`088: PUBLIC, anon, authenticated and service_role hold nothing on ${name}`,
      !/\b(public|anon|authenticated|service_role):EXECUTE/.test(ex), ex);
  }
  const baseFn = fn("module_allocation_base");
  const baseEx = (baseFn?.executors ?? "").trim();
  check("088: the engine is executable by its owner and by nobody else — not app_runtime, " +
    "not PUBLIC, not service_role. It has no limit, so a caller that reached it could dump " +
    "every company's income and workload in one query",
    baseEx.split(" ").filter(Boolean).every(x => x.split(":")[0] === baseFn?.fnowner)
    && !baseEx.includes("app_runtime") && !baseEx.includes("service_role"),
    { executors: baseEx, owner: baseFn?.fnowner });

  check("088 adds no table: an allocation recomputed later from the same data is the same " +
    "allocation, and storing it would only let the register disagree with the invoices",
    (await owner.query(`select tablename from pg_tables where schemaname='public'
      and tablename like '%allocation%'`)).rowCount === 0);

  // ------------------------------------------------- 2. the live corpus reconciles
  const before = await linesOf(90);
  {
    check(`live: exactly six lines, printed in the order the desk shows them`,
      before.length === 6 && before.map(r => r.module).join(",") === ORDER,
      before.map(r => r.module));
    check("live: every line names its own basis, so an allocation can never be read as a " +
      "measurement", before.every(r => typeof r.basis === "string" && r.basis.length > 12),
      before.map(r => r.basis));
    const want = cents(await invoiceTotal(90))! + cents(await passTotal(90))!;
    check("live: the six lines sum to every paid invoice plus every confirmed pass in the " +
      "window — nothing is lost and nothing is counted twice", sumOf(before, "income") === want,
      { lines: sumOf(before, "income"), invoices: cents(await invoiceTotal(90)),
        passes: cents(await passTotal(90)) });
    check("live: platform_income is the same figure on every line, so a share is a share of " +
      "the money the window really holds",
      new Set(before.map(r => String(r.platform_income))).size === 1
      && cents(before[0].platform_income) === want, before.map(r => r.platform_income));
    check("live: the six shares add up to one whole, to a ten-thousandth",
      Math.abs(before.reduce((a, r) => a + Number(r.share ?? 0), 0) - 1) <= 0.0005,
      before.reduce((a, r) => a + Number(r.share ?? 0), 0));
    check("live: currency is named on every line — no bare number reaches a chart",
      before.every(r => r.currency === "TZS"), before.map(r => r.currency));
  }

  // --------------------------------------------- 3. the fixture, computed by hand
  const realCompanies = Number((await owner.query(
    `select count(distinct i.tenant_id) as n from invoices i
       join tenants tc on tc.id = i.tenant_id
      where i.deleted_at is null and i.status = 'paid' and i.paid_at is not null
        and tc.deleted_at is null and tc.type <> 'platform'
        and i.paid_at >= now() - interval '90 days'`)).rows[0].n);
  // Read outside the transaction: this is the money a second connection must still see
  // while the fixture is uncommitted.
  const invoiceTotalBefore = await invoiceTotal(90);
  await owner.query("begin");
  try {
    const oi = (sql: string, p: unknown[] = []) => owner.query(sql, p as any[]);

    await oi(`insert into tenants (id, name, type, status) values
        ($1,'V088 Busy Freight','transporter','active'),
        ($2,'V088 Idle Bundle','transporter','active'),
        ($3,'V088 Wrong Office','transporter','active'),
        ($4,'V088 Ladder Only','transporter','active'),
        ($5,'V088 Bare Invoice','transporter','active'),
        ($6,'V088 Changed Bundle','transporter','active'),
        ($7,'V088 Half Deleted','transporter','active'),
        ($8,'V088 Window Probe','transporter','active'),
        ($9,'V088 Late Invoice','transporter','active'),
        ($10,'V088 Seeker One','seeker','active'),
        ($11,'V088 Seeker Two','seeker','active'),
        ($12,'V088 Seeker Three','seeker','active'),
        ($13,'V088 Platform Seat','platform','active')`, TENANT_IDS);

    // Two bundles: everything, and clearing-plus-office with no transport in it.
    await oi(`insert into service_groups (id, key, name, services) values
        ($1,'v088all','V088 Complete',array['transport','cfa','office']),
        ($2,'v088cfo','V088 Clearing & Office',array['cfa','office'])`, [ids.G1, ids.G2]);

    const starter = (await owner.query(`select id from plans where key = 'starter'`)).rows[0]?.id;
    const weekly = (await owner.query(
      `select id, searches_allowed from seeker_pass_products where key = 'weekly'`)).rows[0];
    check("the reference rows the fixture needs exist — a plan rung and a weekly pass product",
      !!starter && !!weekly, { starter, weekly });

    const sub = (id: string, tenant: string, group: string | null) =>
      oi(`insert into subscriptions (id, tenant_id, plan_id, service_group_id, billing_cycle,
             status, seats_licensed) values ($1,$2,$3,$4,'monthly','active',4)`,
        [id, tenant, starter, group]);
    await sub(ids.SA, t("A"), ids.G1);
    await sub(ids.SB, t("B"), ids.G1);
    await sub(ids.SC, t("C"), ids.G2);
    await sub(ids.SD, t("D"), null);
    await sub(ids.SF1, t("F"), ids.G1);
    // A company may hold one live subscription — subscriptions_tenant_live_uq — so a package
    // change is a retirement and a replacement, the same way the desk does it.
    await oi(`update subscriptions set deleted_at = now() where id = $1`, [ids.SF1]);
    await sub(ids.SF2, t("F"), ids.G2);
    await sub(ids.SG, t("G"), ids.G1);
    await sub(ids.SH, t("H"), ids.G1);
    await sub(ids.SI, t("I"), ids.G1);

    // The money. paid_at is what the window measures, so every one is placed on purpose.
    const inv = (tenant: string, tag: string, total: string, subId: string | null,
      paidAt: string, status = "'paid'", deleted = "null") =>
      oi(`insert into invoices (id, tenant_id, subscription_id, number, billing_cycle, seats,
             amount_subtotal, vat_rate, vat_amount, amount_total, currency, status,
             period_start, period_end, issued_at, paid_at, deleted_at)
              values (gen_random_uuid(),$1,$2,$3,'monthly',4,$4,0,0,$4,'TZS',${status},
                      (now() - interval '30 days')::date, now()::date,
                      now() - interval '30 days', ${paidAt}, ${deleted})`,
        [tenant, subId, `V088-${stamp}-${tag}`, total]);
    await inv(t("A"), "A", "1000000.01", ids.SA, "now() - interval '5 days'");
    await inv(t("B"), "B", "100.00", ids.SB, "now() - interval '5 days'");
    await inv(t("C"), "C", "500.00", ids.SC, "now() - interval '5 days'");
    await inv(t("D"), "D", "250.00", ids.SD, "now() - interval '5 days'");
    await inv(t("E"), "E", "60.00", null, "now() - interval '5 days'");
    await inv(t("F"), "F1", "1000.00", ids.SF1, "now() - interval '40 days'");
    await inv(t("F"), "F2", "3000.00", ids.SF2, "now() - interval '2 days'");
    await inv(t("G"), "G1", "88.88", ids.SG, "now() - interval '5 days'");
    await inv(t("H"), "H", "800.01", ids.SH, "now() - interval '3 days'");
    await inv(t("I"), "I", "40.00", ids.SI, "now() - interval '20 days'");
    await inv(t("PLAT"), "PLAT", "999.99", null, "now() - interval '4 days'");
    // Not money, each for a different reason.
    await inv(t("G"), "G2", "77.77", ids.SG, "now() - interval '5 days'", "'paid'", "now()");
    await inv(t("A"), "ADRAFT", "9999.00", ids.SA, "null", "'issued'");
    await inv(t("A"), "AFAR", "55.55", ids.SA, "now() - interval '400 days'");
    await oi(`update subscriptions set deleted_at = now() where id = $1`, [ids.SG]);

    // The work, each row's created_at set by hand so a window is a window.
    // A live trip reference is unique per company (trips_tenant_reference_uq), so each one
    // is numbered rather than repeated.
    let tripSeq = 0;
    const newTrip = async (tenant: string, ago: string, deleted = "null") => {
      const r = (await oi(
        `insert into routes (id, tenant_id, name, route_source)
              values (gen_random_uuid(),$1,'V088 corridor','estimate') returning id`,
        [tenant])).rows[0].id;
      return (await oi(
        `insert into trips (id, tenant_id, reference, route_id, status, created_at, deleted_at)
         values (gen_random_uuid(),$1,$2,$3,'completed',${ago},${deleted}) returning id`,
        [tenant, `V088T${stamp}-${++tripSeq}`, r])).rows[0].id;
    };
    // A live file number is unique per company and type (cargo_shipments_seq_uq), so each
    // company's files are numbered in turn.
    const fileSeq: Record<string, number> = {};
    const file = (tenant: string, ago: string, deleted = "null") => oi(
      `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year, shipment_type,
         container_type, consignee_name, consignor_name, status, created_at, deleted_at)
       values (gen_random_uuid(),$1,$2,$3,2026,'import','40ft','V088 consignee',
               'V088 consignor','open',${ago},${deleted})`,
      [tenant, `V088CS/${stamp}/${Math.random().toString(36).slice(2, 8)}`,
        (fileSeq[tenant] = (fileSeq[tenant] ?? 0) + 1)]);
    const fInvoice = (tenant: string, tag: string, tripId: string | null, ago: string,
      deleted = "null") => oi(
        `insert into freight_invoices (id, tenant_id, invoice_number, customer_name, status,
           related_trip_id, created_at, deleted_at)
         values (gen_random_uuid(),$1,$2,'V088 customer','sent',$3,${ago},${deleted})`,
        [tenant, `V088FI-${stamp}-${tag}`, tripId]);
    const task = (tenant: string, ago: string) => oi(
      `insert into office_tasks (id, tenant_id, employee_id, title, created_at)
       values (gen_random_uuid(),$1,$2,'V088 task',${ago})`, [tenant, ids.EMP]);

    // A: three live trips and a fourth to bill on, one deleted trip, one trip outside every
    // window, one trip-linked invoice (transport), two files and one unlinked invoice (cfa),
    // two tasks and one issued run (office), plus a draft run and a deleted invoice that must
    // not count.
    for (let i = 0; i < 3; i++) await newTrip(t("A"), "now() - interval '4 days'");
    await newTrip(t("A"), "now() - interval '300 days'");
    await newTrip(t("A"), "now() - interval '4 days'", "now()");
    const tripForInvoice = await newTrip(t("A"), "now() - interval '4 days'");
    for (let i = 0; i < 2; i++) await file(t("A"), "now() - interval '4 days'");
    await fInvoice(t("A"), "TRIP", tripForInvoice, "now() - interval '4 days'");
    await fInvoice(t("A"), "UNLINKED", null, "now() - interval '4 days'");
    await fInvoice(t("A"), "DELETED", tripForInvoice, "now() - interval '4 days'", "now()");
    await oi(`insert into employees (id, tenant_id, full_name, job_title, status)
              values ($1,$2,'V088 Clerk','Clerk','active')`, [ids.EMP, t("A")]);
    await task(t("A"), "now() - interval '4 days'");
    await task(t("A"), "now() - interval '4 days'");
    // An issued run is reached the way the office reaches one: a draft insert, a line, then
    // the update. The insert trigger refuses any other status, and issuing stamps issued_at
    // itself, so the run lands inside the smallest window the gate measures.
    const runIssued = (await oi(
      `insert into payroll_runs (id, tenant_id, period, working_days, status)
       values (gen_random_uuid(),$1, date_trunc('month', now())::date, 22,'draft')
       returning id`, [t("A")])).rows[0].id;
    await oi(`insert into payroll_lines (id, tenant_id, run_id, employee_id, employee_name,
               job_title, monthly_salary, working_days)
             values (gen_random_uuid(),$1,$2,$3,'V088 Clerk','Clerk',500000.00,22)`,
      [t("A"), runIssued, ids.EMP]);
    await oi(`update payroll_runs set status = 'issued' where id = $1`, [runIssued]);
    // A draft run is not work the office line may claim. A period is always the first of a
    // month (payroll_runs_period_check), so the second run is last month's.
    await oi(`insert into payroll_runs (id, tenant_id, period, working_days, status)
              values (gen_random_uuid(),$1, (date_trunc('month', now()) - interval '1 month')::date,
                      22,'draft')`, [t("A")]);

    for (let i = 0; i < 5; i++) await newTrip(t("C"), "now() - interval '4 days'");
    for (let i = 0; i < 7; i++) await newTrip(t("D"), "now() - interval '4 days'");
    for (let i = 0; i < 2; i++) await file(t("F"), "now() - interval '4 days'");
    // F bought clearing-and-office but ran a trip anyway: the trip is work the desk can see,
    // and it is not work the transport line may claim.
    await newTrip(t("F"), "now() - interval '4 days'");
    // H: one trip and two files inside 30 days; six files and a task only inside 120.
    await newTrip(t("H"), "now() - interval '3 days'");
    await file(t("H"), "now() - interval '3 days'");
    await file(t("H"), "now() - interval '3 days'");
    for (let i = 0; i < 6; i++) await file(t("H"), "now() - interval '100 days'");
    await task(t("H"), "now() - interval '100 days'");

    // Passes: only a confirmed one inside the window is money.
    // One seeker profile per company (seekers_tenant_uq), so SK1 and SK2 each hold a profile
    // but two passes, which is what a returning customer looks like.
    const passes: [string, string, string | null, string][] = [
      [ids.SK1, "live", "now() - interval '2 days'", "35000.00"],
      [ids.SK2, "expired", "now() - interval '3 days'", "10000.00"],
      [ids.SK1, "awaiting_verification", null, "5000.00"],
      [ids.SK3, "live", "now() - interval '200 days'", "7000.00"],
      [ids.SK2, "rejected", "now() - interval '1 day'", "9000.00"]
    ];
    const profiled = new Set<string>();
    for (const [tenant, status, verified, amount] of passes) {
      const uid = randomUUID();
      await oi(`insert into users (id, tenant_id, user_type, full_name, email, status)
                values ($1,$2,'seeker','V088 Seeker',
                        'v088.' || substr(md5(random()::text),1,10) || '@verify.test','active')`,
        [uid, tenant]);
      if (!profiled.has(tenant)) {
        profiled.add(tenant);
        await oi(`insert into seekers (id, tenant_id, user_id, first_name, last_name,
                   email_verified_at) values (gen_random_uuid(),$1,$2,'V088',$3, now())`,
          [tenant, uid, stamp]);
      }
      await oi(`insert into seeker_search_passes (id, tenant_id, user_id, product_id, kind,
                 status, searches_allowed, starts_at, expires_at, amount, currency,
                 payment_method, payment_reference, verified_at)
               values (gen_random_uuid(),$1,$2,$3,'weekly',$4,$5, now(),
                       now() + interval '7 days',$6,'TZS','mpesa',
                       'V088' || substr(md5(random()::text),1,8), ${verified ?? "null"})`,
        [tenant, uid, weekly.id, status, weekly.searches_allowed, amount]);
    }

    // ---------------- every company's figures, hand-computed
    const base = (await owner.query(
      `select * from platform_auth.module_allocation_base(90)`)).rows as any[];
    const baseAt = async (days: number) => (await owner.query(
      `select * from platform_auth.module_allocation_base($1)`, [days])).rows as any[];
    const at = (set: any[], key: string) => set.find(r => String(r.tenant_id) === t(key));
    const row = (key: string) => at(base, key);
    const b14 = await baseAt(14);
    const b30 = await baseAt(30);
    const b120 = await baseAt(120);

    check("A: 1,000,000.01 over units 5/3/3 is 454,545.45 / 272,727.28 / 272,727.28 — the " +
      "raw rounding is one cent over the invoice, and the busiest office gives it back, in " +
      "the open",
      row("A")?.basis === "usage" && cents(row("A")?.transport_income) === 45454545
      && cents(row("A")?.cfa_income) === 27272728 && cents(row("A")?.office_income) === 27272728,
      row("A"));
    check("A: its shares are 0.4545 / 0.2727 / 0.2727 and its units are 5 transport, 3 cfa, " +
      "3 office — four live trips plus the invoice billed on one of them, while a deleted " +
      "trip, a deleted invoice, a draft run and a 300-day-old trip are all excluded",
      N(row("A")?.transport_share) === 0.4545 && N(row("A")?.cfa_share) === 0.2727
      && N(row("A")?.office_share) === 0.2727
      && [row("A")?.transport_units, row("A")?.cfa_units, row("A")?.office_units].join("/") === "5/3/3",
      row("A"));
    check("A: exactly one paid invoice in the window — a draft and a 400-day-old one are not " +
      "money", row("A")?.invoices_paid === 1 && cents(row("A")?.income) === 100000001, row("A"));

    check("B: a bundle company that recorded nothing is split evenly and labelled 'even', so " +
      "100.00 becomes 33.34 / 33.33 / 33.33 with the cent on transport",
      row("B")?.basis === "even" && cents(row("B")?.transport_income) === 3334
      && cents(row("B")?.cfa_income) === 3333 && cents(row("B")?.office_income) === 3333
      && row("B")?.transport_units === 0, row("B"));

    check("C: a clearing-and-office package whose whole window is transport earns transport " +
      "nothing — a real 0.00, not a null and not a share",
      row("C")?.basis === "even" && cents(row("C")?.transport_income) === 0
      && cents(row("C")?.cfa_income) === 25000 && cents(row("C")?.office_income) === 25000
      && N(row("C")?.transport_share) === 0, row("C"));
    check("C: and its five trips are still printed, so the desk can say 'busy somewhere the " +
      "package does not go' rather than hide it", row("C")?.transport_units === 5, row("C"));

    check("D: a plan ladder rung is never split — nulls, not three zeroes — even though it " +
      "recorded seven trips",
      row("D")?.basis === "not split" && row("D")?.transport_income === null
      && row("D")?.cfa_income === null && row("D")?.office_income === null
      && row("D")?.transport_share === null && row("D")?.offering === "starter"
      && row("D")?.services === null && row("D")?.transport_units === 7, row("D"));

    check("E: a paid invoice with no subscription behind it is 'no subscription' and says so " +
      "in its own name",
      row("E")?.basis === "no subscription"
      && row("E")?.offering_name === "No subscription behind the invoice"
      && cents(row("E")?.income) === 6000 && row("E")?.transport_income === null, row("E"));

    check("F: 1,000.00 under the retired all-three and 3,000.00 under the live clearing-and-" +
      "office are allocated by the newest list — the whole 4,000.00 lands on clearing",
      row("F")?.basis === "usage" && cents(row("F")?.income) === 400000
      && (row("F")?.services ?? []).join(",") === "cfa,office" && row("F")?.offering === "v088cfo"
      && cents(row("F")?.cfa_income) === 400000 && cents(row("F")?.transport_income) === 0
      && cents(row("F")?.office_income) === 0, row("F"));
    check("F: its one trip is printed as work, but transport bought none of it — the office " +
      "line that did not sell the work does not count it either",
      row("F")?.transport_units === 1, row("F"));
    check("F: narrow the window to 14 days and the older invoice stops being money at all — " +
      "3,000.00, still all clearing",
      cents(at(b14, "F")?.income) === 300000 && cents(at(b14, "F")?.cfa_income) === 300000,
      at(b14, "F"));

    check("G: the soft-deleted invoice is gone and the live one behind a deleted subscription " +
      "is not a bundle — 88.88, as 'no subscription'",
      row("G")?.basis === "no subscription" && cents(row("G")?.income) === 8888
      && row("G")?.invoices_paid === 1, row("G"));

    check("H: at 90 days the window holds 1 trip and 2 files, so 800.01 is 266.67 / 533.34 / " +
      "0.00",
      row("H")?.basis === "usage" && cents(row("H")?.transport_income) === 26667
      && cents(row("H")?.cfa_income) === 53334 && cents(row("H")?.office_income) === 0, row("H"));
    check("H: widen to 120 days and the same invoice splits 80.00 / 640.01 / 80.00 — the " +
      "weights come from inside the window, and the office gets a turn",
      [at(b120, "H")?.transport_income, at(b120, "H")?.cfa_income,
        at(b120, "H")?.office_income].map(cents).join("/") === "8000/64001/8000", at(b120, "H"));
    check("H: at both windows the three figures still add up to 800.01, and 1,000.00 at 30 " +
      "days is the same 266.67 / 533.34 / 0.00 as at 90",
      sumOf([at(b120, "H")], "transport_income") + sumOf([at(b120, "H")], "cfa_income")
        + sumOf([at(b120, "H")], "office_income") === 80001
      && cents(at(b30, "H")?.transport_income) === 26667, { w120: at(b120, "H") });

    check("I: an invoice paid 20 days ago is absent from a 14-day window — no row, so no " +
      "phantom line", !at(b14, "I") && !!row("I"), { at14: at(b14, "I") });
    check("I: and at 30 days it is there, idle, 13.34 / 13.33 / 13.33",
      at(b30, "I")?.basis === "even"
      && [at(b30, "I")?.transport_income, at(b30, "I")?.cfa_income, at(b30, "I")?.office_income]
        .map(cents).join("/") === "1334/1333/1333", at(b30, "I"));

    check("the platform's own tenant is never a customer — its paid invoice appears nowhere",
      !base.some(r => String(r.tenant_id) === ids.PLAT) && !at(b14, "PLAT"), null);

    const gotOrder = base
      .filter(r => COMPANY_IDS.includes(String(r.tenant_id)))
      .map(r => COMPANY_ORDER.find(k => t(k) === String(r.tenant_id)));
    check("the engine prints the richest company first — the order a desk reads is the order " +
      "of the money", gotOrder.join(",") === COMPANY_ORDER.join(","),
      { gotOrder, want: COMPANY_ORDER, incomes: base
        .filter(r => COMPANY_IDS.includes(String(r.tenant_id)))
        .map(r => `${COMPANY_ORDER.find(k => t(k) === String(r.tenant_id))}=${r.income}`) });

    const bad = base.filter(r => {
      if (r.transport_income === null) return r.basis === "usage" || r.basis === "even";
      if (cents(r.transport_income)! + cents(r.cfa_income)! + cents(r.office_income)!
          !== cents(r.income)) return true;
      if (cents(r.income) === 0) return r.transport_share !== null;
      return Math.abs([r.transport_share, r.cfa_share, r.office_share]
        .reduce<number>((a, x) => a + Number(x), 0) - 1) > 0.0003;
    });
    check("for every company in the whole corpus, not just the fixture: the three shares are " +
      "never null on a split row, they add up to the company's income to the cent, and their " +
      "percentages add up to one whole", bad.length === 0, bad.slice(0, 3));

    // ---------------- the six lines, as a delta over the live corpus
    const after = await linesOf(90);
    const want: Record<string, [number, number, number, number, number]> = {
      //                 income   customers units usage      even
      // transport's 6 units are A's 5 (four live trips plus the invoice billed on one of
      // them) and H's 1 — F ran a trip inside a package that never sold transport, and the
      // line refuses it.
      transport: [45485880, 4, 6, 45481212, 4668],
      cfa: [27755728, 6, 7, 27726062, 29666],
      office: [27302394, 4, 3, 27272728, 29666],
      plan_ladder: [25000, 1, 0, 0, 0],
      directory_search: [4500000, 2, 0, 0, 0],
      unattributed: [14888, 2, 0, 0, 0]
    };
    for (const [module, [income, customers, units, usage, even]] of Object.entries(want)) {
      const b = before.find(r => r.module === module)!;
      const a = after.find(r => r.module === module)!;
      check(`line ${module}: +${(income / 100).toFixed(2)} TZS, +${customers} customers, ` +
        `+${units} units, of which ${(usage / 100).toFixed(2)} by usage and ` +
        `${(even / 100).toFixed(2)} by the even fall-back`,
        cents(a.income)! - cents(b.income)! === income
        && a.customers - b.customers === customers && a.units - b.units === units
        && cents(a.usage_income)! - cents(b.usage_income)! === usage
        && cents(a.even_income)! - cents(b.even_income)! === even, { before: b, after: a });
    }
    check("the six lines' total delta is the fixture's own money: 1,005,838.90 of invoices " +
      "plus 45,000.00 of confirmed passes, no more and no less",
      sumOf(after, "income") - sumOf(before, "income") === 105083890,
      { delta: sumOf(after, "income") - sumOf(before, "income") });
    check("the three office lines are the only ones that claim units of work — a ladder rung, " +
      "a search pass and an unplaced invoice never invent any",
      after.filter(r => !["transport", "cfa", "office"].includes(r.module))
        .every(r => r.units === 0), after.map(r => [r.module, r.units]));
    check("usage_income plus even_income is the whole of an office line, so the desk can " +
      "always say how much of a column is evidence and how much is a fall-back",
      ["transport", "cfa", "office"].every(m => {
        const r = after.find(x => x.module === m)!;
        return cents(r.usage_income)! + cents(r.even_income)! === cents(r.income)!;
      }), after.filter(r => ["transport", "cfa", "office"].includes(r.module))
        .map(r => [r.module, r.usage_income, r.even_income, r.income]));

    // ---------------- the readers the desk calls, and their limits
    for (const [label, days, wantDays] of [["negative", -5, 7], ["absurd", 5000, 730],
      ["missing", null as any, 90]] as [string, number, number][]) {
      const l = await linesOf(days);
      check(`a ${label} window is clamped, not computed: ${days} answers ${wantDays} days`,
        l[0].window_days === wantDays && l.length === 6, l[0]?.window_days);
    }
    const page = (await owner.query(
      `select * from platform_auth.control_module_allocation_tenants(90, 1)`)).rows as any[];
    check("the per-company reader limits its rows but not its totals — matched and " +
      "matched_income describe the whole window, so a paged table cannot masquerade as a sum",
      page.length === 1 && page[0].matched === COMPANY_IDS.length + realCompanies
      && cents(page[0].matched_income) === cents(await invoiceTotal(90)),
      { page: page[0], realCompanies, fixture: COMPANY_IDS.length });
    check("…and the reader's invoice total is the whole corpus's invoice money: the passes " +
      "belong to the summary's own line, so total money = invoices + passes",
      cents(page[0].matched_income) + cents(await passTotal(90)) === sumOf(after, "income"),
      { matched: page[0].matched_income, passes: await passTotal(90),
        lines: sumOf(after, "income") });
    const wide = (await owner.query(
      `select * from platform_auth.control_module_allocation_tenants(90, 5000)`)).rows as any[];
    const narrow = (await owner.query(
      `select * from platform_auth.control_module_allocation_tenants(90, 0)`)).rows;
    check("a requested 5,000 rows is refused down to 400 and a 0 is raised to 1 — the desk " +
      "cannot ask for the register in one gulp",
      wide.length === page[0].matched && wide.length <= 400 && narrow.length === 1,
      { wide: wide.length, narrow: narrow.length, matched: page[0].matched });
    check("the reader's rows are the engine's rows, figure for figure — the desk adds a page, " +
      "not a second arithmetic",
      COMPANY_ORDER.every(k => {
        const r = wide.find(x => String(x.tenant_id) === t(k));
        const e = row(k);
        return !!r && !!e && [r.income, r.transport_income, r.cfa_income, r.office_income,
          r.basis, r.transport_units, r.cfa_units, r.office_units].join("|")
          === [e.income, e.transport_income, e.cfa_income, e.office_income,
            e.basis, e.transport_units, e.cfa_units, e.office_units].join("|");
      }), wide.filter(x => COMPANY_IDS.includes(String(x.tenant_id))).length);

    // ---------------- as app_runtime
    const aUrl = appUrl();
    if (aUrl) {
      const app = new pg.Client({ connectionString: aUrl, ssl: { rejectUnauthorized: false } });
      await app.connect();
      const appLines = (await app.query(
        `select module, income, customers, units, basis, platform_income, window_days, currency
           from platform_auth.control_module_allocation(90)`)).rows as any[];
      check("app_runtime runs the summary and gets the same six lines, in the same order",
        appLines.length === 6 && appLines.map(r => r.module).join(",") === ORDER,
        appLines.map(r => r.module));
      check("…and its money is the live corpus's to the cent, not the fixture's: one " +
        "arithmetic, two callers, and nothing uncommitted crosses the wall",
        sumOf(appLines, "income") === sumOf(before, "income"),
        { app: appLines.map(r => r.income), live: before.map(r => r.income),
          fixture: after.map(r => r.income) });
      const appPage = (await app.query(
        `select tenant_id, company_name, basis, income, matched, matched_income from ` +
        `platform_auth.control_module_allocation_tenants(90, 300)`)).rows as any[];
      check("app_runtime runs the per-company reader too, and its own totals describe the " +
        "corpus it can actually see", appPage.length > 0
        && appPage[0].matched === realCompanies
        && cents(appPage[0].matched_income) === cents(invoiceTotalBefore),
        { rows: appPage.length, matched: appPage[0]?.matched, realCompanies,
          matched_income: appPage[0]?.matched_income, invoiceTotalBefore });
      check("…and it reads none of the fixture's company names — the proof rolled back, so a " +
        "second connection owes a live database nothing",
        !appPage.some(r => String(r.company_name).startsWith("V088")),
        appPage.filter(r => String(r.company_name).startsWith("V088")).map(r => r.company_name));
      let denied = "";
      try { await app.query(`select * from platform_auth.module_allocation_base(90)`); }
      catch (e: any) { denied = `${e.code} ${e.message}`; }
      check("app_runtime is refused the engine — permission denied, not an empty set",
        denied.startsWith("42501"), denied);
      await app.end();
    } else console.log("SKIP app_runtime probes — no APP_DB_PASSWORD / APP_DATABASE_URL");
  } finally {
    await owner.query("rollback");
  }

  // ------------------------------------------------------- 5. nothing survived
  {
    const residue = (await owner.query(
      `select (select count(*) from tenants where id = any($1::uuid[]))::int as tenants,
              (select count(*) from users where tenant_id = any($1::uuid[]))::int as users,
              (select count(*) from seekers where tenant_id = any($1::uuid[]))::int as seekers,
              (select count(*) from subscriptions where tenant_id = any($1::uuid[]))::int as subs,
              (select count(*) from invoices where tenant_id = any($1::uuid[]))::int as invoices,
              (select count(*) from routes where tenant_id = any($1::uuid[]))::int as routes,
              (select count(*) from trips where tenant_id = any($1::uuid[]))::int as trips,
              (select count(*) from cargo_shipments where tenant_id = any($1::uuid[]))::int as files,
              (select count(*) from freight_invoices where tenant_id = any($1::uuid[]))::int as fi,
              (select count(*) from office_tasks where tenant_id = any($1::uuid[]))::int as tasks,
              (select count(*) from payroll_runs where tenant_id = any($1::uuid[]))::int as runs,
              (select count(*) from payroll_lines where tenant_id = any($1::uuid[]))::int as lines,
              (select count(*) from employees where tenant_id = any($1::uuid[]))::int as staff,
              (select count(*) from seeker_search_passes where tenant_id = any($1::uuid[]))::int as passes,
              (select count(*) from service_groups where key like 'v088%')::int as groups`,
      [TENANT_IDS])).rows[0] as any;
    check("every fixture row is gone — the proof ran inside a transaction and rolled back, so " +
      "a live database is safe to prove arithmetic on",
      Object.values(residue).every(v => v === 0), residue);

    const again = await linesOf(90);
    check("and the allocation reads exactly what it read before the fixture: a recomputed " +
      "number leaves no trace anywhere",
      again.map(r => `${r.module}:${r.income}:${r.customers}:${r.units}`).join("|") ===
        before.map(r => `${r.module}:${r.income}:${r.customers}:${r.units}`).join("|"),
      { again: again.map(r => [r.income, r.customers, r.units]),
        before: before.map(r => [r.income, r.customers, r.units]) });
    check("…which is still every paid invoice plus every confirmed pass in the window",
      sumOf(again, "income") === cents(await invoiceTotal(90))! + cents(await passTotal(90))!,
      { lines: sumOf(again, "income"),
        invoices: cents(await invoiceTotal(90)), passes: cents(await passTotal(90)) });
  }

  await owner.end();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
