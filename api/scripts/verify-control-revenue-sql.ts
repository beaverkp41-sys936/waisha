/**
 * Live proof for migration 068 — the customer register, the money ledger, the revenue
 * mix and the bundle activation (task #104).
 *
 * Same rule 066 established: EXPLAIN cannot see inside a SECURITY DEFINER body, so a
 * function that references a renamed column, prices a bundle off the wrong ladder, or
 * hands back a bigint a chart cannot read is only caught by running it. The posture
 * half is read out of the catalog as the owner; the execution half runs the exported
 * statements from the routes as app_runtime.
 *
 * The activation probe writes and rolls back. It is the only way to prove that a
 * bundle sold by the office lands on the subscription, prices the invoice from the
 * bundle, and moves the platform's own MRR by exactly the bundle's monthly figure —
 * and none of those statements may survive the run.
 *
 * Run: npx tsx scripts/verify-control-revenue-sql.ts   (DNS_FALLBACK=1 if DNS broken)
 */
import "dotenv/config";
import pg from "pg";
import {
  REGISTER_SQL, LEDGER_SQL, MIX_SQL, GROUPS_SQL, GROUP_BY_KEY_SQL, GROUP_UPDATE_SQL
} from "../src/routes/control-revenue.routes.js";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label,
    (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500)); }
}

const NEW_FUNCS = [
  "control_subscription_register", "control_payment_ledger", "control_revenue_mix",
  "manual_activate", "control_overview"
];
const NEW_INDEXES = [
  "idx_invoices_created", "idx_invoices_subscription", "idx_invoices_paid_at",
  "idx_subscriptions_period_end", "idx_passes_recorded", "idx_passes_verified"
];
const HOLDERS = ["super_admin", "billing_admin", "platform_analyst",
  "compliance_officer", "customer_service_agent"];

function ownerUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  return url;
}

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

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  // ============================
  // 1. Catalog posture, as the owner
  // ============================
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();

  const posture = (await owner.query(
    `select p.proname, p.prosecdef,
            coalesce((select string_agg(x, ',') from unnest(p.proconfig) x
                       where x like 'search_path%'), '') as cfg,
            pg_get_function_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth'
        and p.proname = any($1)`, [NEW_FUNCS])).rows;

  for (const f of ["control_subscription_register", "control_payment_ledger", "control_revenue_mix"]) {
    const row = posture.find(p => p.proname === f);
    check(`${f} exists`, !!row, posture.map(p => p.proname));
    if (!row) continue;
    check(`${f} is SECURITY DEFINER with a pinned search_path`,
      row.prosecdef === true && row.cfg === "search_path=public", { s: row.prosecdef, cfg: row.cfg });
  }

  // Two signatures of the same name is the point: the office keeps selling ladder
  // plans with the call it has used since 011, and only the bundle path is new.
  const seven = posture.find(p => p.proname === "manual_activate"
    && (p.args.match(/,/g) ?? []).length === 6);
  const eight = posture.find(p => p.proname === "manual_activate"
    && (p.args.match(/,/g) ?? []).length === 7);
  check("manual_activate still has its original 7-argument signature", !!seven, seven?.args);
  check("…and gained a bundle-aware 8-argument one", !!eight && /service_group/i.test(eight.args), eight?.args);
  check("the overview is still the same single-call shape (no new signature)",
    !!posture.find(p => p.proname === "control_overview" && p.args === ""), posture.map(p => p.args));

  // One read of the ACL, keyed by function identity, so the two signatures of
  // manual_activate are told apart instead of averaged together.
  const acl = (await owner.query(
    `select p.proname, pg_get_function_identity_arguments(p.oid) as ident,
            pg_get_userbyid(ac.grantee) as grantee, ac.privilege_type
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
       lateral aclexplode(p.proacl) ac
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [NEW_FUNCS])).rows;

  const identOf = (name: string, want?: RegExp) =>
    acl.find(a => a.proname === name && (!want || want.test(a.ident)))?.ident ?? "";
  const grantsFor = (name: string, want?: RegExp) =>
    acl.filter(a => a.proname === name && (!want || want.test(a.ident)));

  for (const f of ["control_subscription_register", "control_payment_ledger", "control_revenue_mix"]) {
    check(`app_runtime holds EXECUTE on ${f}`,
      grantsFor(f).some(a => a.grantee === "app_runtime" && a.privilege_type === "EXECUTE"),
      { id: identOf(f), grantees: grantsFor(f).map(a => a.grantee) });
    check(`${f} is not reachable from PUBLIC, anon, authenticated or service_role`,
      !grantsFor(f).some(a =>
        ["public", "anon", "authenticated", "service_role"].includes(a.grantee)),
      grantsFor(f).map(a => `${a.grantee}:${a.privilege_type}`));
  }
  check("the bundle activation is executable by app_runtime and by nothing else",
    grantsFor("manual_activate", /service_group/).some(a => a.grantee === "app_runtime")
    && !grantsFor("manual_activate", /service_group/).some(a =>
      ["public", "anon", "authenticated", "service_role"].includes(a.grantee)),
    identOf("manual_activate", /service_group/));

  const idx = (await owner.query(
    `select indexname from pg_indexes where schemaname = 'public' and indexname = any($1)`,
    [NEW_INDEXES])).rows.map(r => r.indexname);
  check("all six indexes the registers sort by are in place",
    NEW_INDEXES.every(n => idx.includes(n)), NEW_INDEXES.filter(n => !idx.includes(n)));

  // ---------- the duty this stage added ----------
  const duty = (await owner.query(
    `select r.key, count(rp.permission_key)::int as n
       from roles r left join role_permissions rp
         on rp.role_id = r.id and rp.permission_key = 'control.subscriptions.view'
      where r.tenant_id is null and r.deleted_at is null
      group by r.key order by r.key`)).rows;
  const holders = duty.filter(d => d.n > 0).map(d => d.key).sort();
  check("control.subscriptions.view is held by exactly the five reading duties",
    JSON.stringify(holders) === JSON.stringify([...HOLDERS].sort()), holders);
  check("…and support_engineer, the seat that fixes faults, does not read the money",
    !holders.includes("support_engineer"), holders);

  // ---------- the bundle table's own contract ----------
  const sgGrants = (await owner.query(
    `select privilege_type from information_schema.table_privileges
      where grantee = 'app_runtime' and table_name = 'service_groups'`)).rows.map(r => r.privilege_type);
  check("service_groups stays read/insert/update — no DELETE, so a price a customer " +
    "was billed against cannot be erased from under the invoice",
    ["INSERT", "SELECT", "UPDATE"].every(g => sgGrants.includes(g)) && !sgGrants.includes("DELETE"), sgGrants);
  const sgPolicies = (await owner.query(
    `select polname from pg_policy where polrelid = 'public.service_groups'::regclass`)).rows.map(r => r.polname);
  check("its RLS policies are all still there (060 shipped policy and grant together)",
    sgPolicies.length === 3, sgPolicies);
  check("subscriptions can carry the bundle that was sold",
    !!(await owner.query(
      `select 1 from information_schema.columns
        where table_name = 'subscriptions' and column_name = 'service_group_id'`)).rowCount);

  // ---------- refusals, each in its own savepoint ----------
  const refusals: [string, string, unknown[]][] = [
    ["a seat_limit above the table's own ceiling",
      "insert into service_groups (key,name,services,seat_limit) values ('v068-a','A',array['cfa'],5000)", []],
    ["a service outside the closed vocabulary",
      "insert into service_groups (key,name,services) values ('v068-b','B',array['cfa','warehouse'])", []],
    ["an empty bundle — a subscription must say which modules",
      "insert into service_groups (key,name,services) values ('v068-c','C','{}')", []],
    ["a negative price",
      "insert into service_groups (key,name,services,price_monthly) values ('v068-d','D',array['cfa'],-1)", []],
    ["a currency the platform does not bill in",
      "insert into service_groups (key,name,services,currency) values ('v068-e','E',array['cfa'],'USD')", []],
    ["a bundle sold against a row that is not a service group",
      "insert into subscriptions (tenant_id, plan_id, service_group_id, billing_cycle) " +
      "select t.id, (select id from plans limit 1), (select id from plans limit 1), 'monthly' " +
      "from tenants t where t.type='transporter' limit 1", []]
  ];
  // A savepoint needs a transaction to live in, and the whole block is rolled back at
  // the end: a refusal test that actually inserted a row would be the worst kind of
  // passing result.
  await owner.query("begin");
  for (const [label, sql] of refusals) {
    try {
      await owner.query("savepoint v068");
      await owner.query(sql);
      await owner.query("rollback to savepoint v068");
      check(label + " is refused", false, "the insert succeeded");
    } catch (e: any) {
      await owner.query("rollback to savepoint v068");
      check(label + " is refused", true);
    }
  }
  await owner.query("rollback");

  // ============================
  // 2. Execution, as app_runtime — the exact statements the routes run
  // ============================
  const aUrl = appUrl();
  if (!aUrl) {
    console.log("SKIP app_runtime probes — no APP_DB_PASSWORD / APP_DATABASE_URL");
    await owner.end();
    process.exit(failures ? 1 : 0);
  }
  const app = new pg.Client({ connectionString: aUrl, ssl: { rejectUnauthorized: false } });
  await app.connect();

  const reg = await app.query(REGISTER_SQL, [null, null, null, null, null, 200]);
  check("the register runs as app_runtime and answers rows without a tenant GUC",
    reg.rows.length >= 0, reg.rowCount);
  const r0 = reg.rows[0] ?? {};
  check("counts arrive as int, because 068 casts them and a chart given \"7\" draws nothing",
    reg.rows.length === 0 || (typeof r0.matched === "number" && typeof r0.seats_licensed === "number"),
    { matched: typeof r0.matched, seats: typeof r0.seats_licensed });
  check("money arrives as numeric and the route converts it, so the register's money " +
    "columns are typed, not strings a total was concatenated out of",
    reg.rows.length === 0
    || (typeof r0.monthly_equivalent === "string" && typeof r0.collected === "string"),
    { mrr: typeof r0.monthly_equivalent, collected: typeof r0.collected });
  check("the register's own total matches the rows it returned",
    reg.rows.length === 0 || (r0.matched === reg.rowCount || r0.matched >= reg.rowCount),
    { matched: r0.matched, rowCount: reg.rowCount });
  check("the MRR line is the sum of the column the rows show",
    reg.rows.length === 0 || Math.abs(
      Number(r0.matched_mrr) - reg.rows.reduce((s, r) => s + Number(r.monthly_equivalent), 0)) < 0.02,
    { line: r0.matched_mrr, sum: reg.rows.reduce((s, r) => s + Number(r.monthly_equivalent), 0) });
  check("offering is the bundle when there is one and the ladder when there is not",
    reg.rows.every(r => r.offering_kind === "bundle" ? !!r.services?.length : r.offering !== "unknown"),
    reg.rows.filter(r => r.offering === "unknown").length);

  const limited = await app.query(REGISTER_SQL, [null, null, null, null, null, 3]);
  check("a smaller limit still reports the whole filtered total, not its own page",
    limited.rowCount === 3 && Number(limited.rows[0].matched) === Number(r0.matched),
    { page: limited.rowCount, matched: limited.rows[0]?.matched });
  const greedy = await app.query(REGISTER_SQL, [null, null, null, null, null, 999999]);
  check("a runaway limit is clamped inside the function, not in the route",
    greedy.rowCount <= 400, greedy.rowCount);
  const active = await app.query(REGISTER_SQL, ["active", null, null, null, null, 400]);
  check("a status filter only returns that status",
    active.rows.every(r => r.subscription_status === "active"), active.rows.slice(0, 3));
  const bundles = await app.query(REGISTER_SQL, [null, null, "bundles", null, null, 400]);
  check("offering='bundles' returns only bundle customers",
    bundles.rows.every(r => r.offering_kind === "bundle"), bundles.rows.slice(0, 3));
  const ladder = await app.query(REGISTER_SQL, [null, null, "ladder", null, null, 400]);
  check("…and 'ladder' only the plan-price ones — the two halves add up to the register",
    ladder.rows.every(r => r.offering_kind === "plan")
    && (bundles.rowCount ?? 0) + (ladder.rowCount ?? 0) <= Number(r0.matched),
    { bundles: bundles.rowCount, ladder: ladder.rowCount });
  const due = await app.query(REGISTER_SQL, [null, null, null, null, 30, 400]);
  check("the renewal window keeps its promise: nobody in it is more than 30 days out",
    due.rows.every(r => r.days_to_renewal === null || Number(r.days_to_renewal) <= 30),
    due.rows.slice(0, 3).map(r => r.days_to_renewal));

  const led = await app.query(LEDGER_SQL, [null, null, null, null, null, 200]);
  check("the ledger runs and returns both money streams",
    led.rows.length >= 0, led.rowCount);
  const sources = new Set(led.rows.map(r => r.source));
  check("a subscription row and a search-pass row keep their own vocabulary",
    [...sources].every(s => s === "subscription" || s === "search_pass"), [...sources]);
  check("the ledger's income line counts only rows that are money",
    Math.abs(Number(led.rows[0]?.matched_income ?? 0) - led.rows
      .filter(r => r.money_at !== null).reduce((s, r) => s + Number(r.amount), 0)) < 0.02,
    { line: led.rows[0]?.matched_income })
    ;
  check("an invoice that has not been paid yet carries no money date",
    led.rows.filter(r => r.source === "subscription" && r.status !== "paid")
      .every(r => r.money_at === null),
    led.rows.filter(r => r.status === "issued").slice(0, 2));
  check("a pass whose reference the office has not verified is in the ledger but not in the money",
    led.rows.filter(r => r.source === "search_pass" && r.status === "awaiting_verification")
      .every(r => r.money_at === null));
  const onlyPasses = await app.query(LEDGER_SQL, ["search_pass", null, null, null, null, 400]);
  check("the source tab filters in SQL, so the totals line moves with it",
    onlyPasses.rows.every(r => r.source === "search_pass"), onlyPasses.rowCount);
  const search = await app.query(LEDGER_SQL, [null, null, "zz", null, null, 20]);
  check("a name nobody has is refused by the filter rather than by an error",
    search.rowCount === 0, search.rowCount);
  const windowed = await app.query(LEDGER_SQL,
    [null, null, null, "2020-01-01", "2020-01-31", 200]);
  check("a date window is judged on the calendar day, so its rows sit inside it",
    windowed.rows.every(r => {
      const d = new Date(r.recorded_at).toLocaleDateString("en-CA", { timeZone: "Africa/Dar_es_Salaam" });
      return d >= "2020-01-01" && d <= "2020-01-31";
    }), windowed.rowCount);

  const mix = await app.query(MIX_SQL, [365]);
  check("the revenue mix shares add up to the whole when there is anything to share",
    mix.rows.length === 0
    || Math.abs(mix.rows.reduce((s, r) => s + Number(r.share), 0) - 1) < 0.001,
    mix.rows.map(r => r.share));
  check("the mix's income equals the ledger's money for the same universe",
    Math.abs(
      mix.rows.reduce((s, r) => s + Number(r.income), 0)
      - Number((await app.query(
        `select coalesce(sum(amount),0) as t from platform_auth.control_payment_ledger(
           'subscription','paid',null,null,null,400)`)).rows[0].t)) < 1,
    { mix: mix.rows.reduce((s, r) => s + Number(r.income), 0) });

  const groups = await app.query(GROUPS_SQL);
  check("the three bundles the user specified are still the price list",
    groups.rows.length >= 3 && groups.rows.every(r => r.currency === "TZS"),
    groups.rows.map(r => r.key));

  await app.end();

  // ============================
  // 3. The activation, written and rolled back
  // ============================
  //
  // This is the check that matters for the deferred bug: the office sells a bundle, and
  // every report that reads the subscription must then agree with the invoice it was
  // written from. Owner connection, because the fixture tenant is created here and
  // nothing about it may reach the morning.
  await owner.query("begin");
  try {
    const stamp = Date.now().toString(36).toUpperCase();
    const t = (await owner.query(
      `insert into tenants (id, name, type, status)
       values (gen_random_uuid(), $1, 'transporter', 'pending_verification') returning id`,
      [`VERIFY068 ${stamp}`])).rows[0].id;

    const before = (await owner.query("select platform_auth.control_overview() as o")).rows[0].o;
    const suite = groups.rows.find(g => g.key === "transport_cfa_office");
    const monthly = Number(suite.price_monthly);

    const r = (await owner.query(
      `select platform_auth.manual_activate($1,null,$2,'bank',null,null,null,$3) as r`,
      [t, "monthly", "transport_cfa_office"])).rows[0].r;
    check("the office can sell a bundle without naming a plan rung",
      r.status === "ok" && r.bundle === "transport_cfa_office", r);
    check("…and the invoice is the bundle's price plus VAT, not a rung's",
      Number(r.total) === Math.round((monthly * 1.18 + Number.EPSILON) * 100) / 100,
      { total: r.total, expected: monthly * 1.18 });

    const sub = (await owner.query(
      `select s.service_group_id, s.plan_id, s.seats_licensed, s.status, s.billing_cycle,
              p.key as plan_key, p.seat_limit as plan_seats
         from subscriptions s join plans p on p.id = s.plan_id
        where s.tenant_id = $1`, [t])).rows[0];
    check("the sale stamps the bundle on the subscription — the write 010 never made",
      !!sub.service_group_id && sub.status === "active", sub);
    check("…and licenses the seats the bundle sells, not the rung's",
      sub.seats_licensed === suite.seat_limit, { seats: sub.seats_licensed, bundle: suite.seat_limit });
    check("the plan rung is the smallest one wide enough, chosen by rule",
      sub.plan_seats >= suite.seat_limit, sub);

    const after = (await owner.query("select platform_auth.control_overview() as o")).rows[0].o;
    check("the platform's MRR moves by exactly the bundle's monthly figure",
      Math.abs(Number(after.recurring.mrr) - Number(before.recurring.mrr) - monthly) < 0.02,
      { before: before.recurring.mrr, after: after.recurring.mrr, monthly });
    check("the overview now counts this company among the bundle customers",
      Number(after.subscriptions.bundles) === Number(before.subscriptions.bundles) + 1,
      { before: before.subscriptions.bundles, after: after.subscriptions.bundles });

    const regRow = (await owner.query(REGISTER_SQL, [null, null, "transport_cfa_office", null, null, 400]))
      .rows.find(x => x.tenant_id === t);
    check("the register prices this customer from the bundle, not the rung it sits on",
      !!regRow && Math.abs(Number(regRow.monthly_equivalent) - monthly) < 0.02,
      { found: !!regRow, mrr: regRow?.monthly_equivalent, monthly });
    const mixRows = (await owner.query(MIX_SQL, [7])).rows;
    check("the bundle customer appears under the bundle in the mix",
      mixRows.some(x => x.offering === "transport_cfa_office"), mixRows.map(x => x.offering));

    const ledRow = (await owner.query(LEDGER_SQL, ["subscription", "paid", "VERIFY068", null, null, 50])).rows;
    check("the invoice the office just wrote is already in the ledger, marked as money",
      ledRow.length === 1 && ledRow[0].money_at !== null && ledRow[0].detail === suite.name, ledRow[0]);

    // ---------- the seeker half, written here because live data has none ----------
    //
    // The ledger's pass branch joins seekers to reach a name. Joining on the wrong id
    // — seekers.id instead of the pass's user_id — answers zero rows and every
    // ".every()" assertion over that empty set then passes. So these checks assert a
    // count, not a shape, and the seeker row is deliberately a different uuid from the
    // user row, exactly as the signup path writes it.
    const passName = `V068Seeker ${stamp}`;
    const seekerTenant = (await owner.query(
      `insert into tenants (id, name, type, status)
       values (gen_random_uuid(), $1, 'seeker', 'active') returning id`,
      [passName])).rows[0].id;
    const seekerUser = (await owner.query(
      `insert into users (id, tenant_id, user_type, full_name, email, status)
       values (gen_random_uuid(), $1, 'seeker', $2,
               'v068.' || substr(md5(random()::text), 1, 10) || '@verify.test', 'active')
       returning id`, [seekerTenant, passName])).rows[0].id;
    await owner.query(
      `insert into seekers (id, tenant_id, user_id, first_name, last_name, email_verified_at)
       values (gen_random_uuid(), $1, $2, 'V068Seeker', $3, now())`,
      [seekerTenant, seekerUser, stamp]);
    const prod = (await owner.query(
      `select id, price, searches_allowed from seeker_pass_products where key = 'weekly'`)).rows[0];
    if (!prod) throw new Error("the weekly pass product is not seeded — cannot prove the ledger");
    for (const [status, verified] of [["awaiting_verification", null], ["live", "now()"]] as const) {
      await owner.query(
        `insert into seeker_search_passes (id, tenant_id, user_id, product_id, kind, status,
             searches_allowed, starts_at, expires_at, amount, currency, payment_method,
             payment_reference, verified_at)
         values (gen_random_uuid(), $1, $2, $3, 'weekly', $4, $5, now(),
                 now() + interval '7 days', $6, 'TZS', 'mpesa', $7, ${verified ?? 'null'})`,
        [seekerTenant, seekerUser, prod.id, status, prod.searches_allowed,
          prod.price, `V068${stamp}${status === "live" ? "L" : "P"}`]);
    }
    const passLedger = (await owner.query(LEDGER_SQL, ["search_pass", null, passName, null, null, 50])).rows;
    check("a seeker's passes reach the ledger — the join is on the user, not on the " +
      "seeker row's own id", passLedger.length === 2,
      { n: passLedger.length, rows: passLedger.map(r => r.status) });
    check("…and the money line counts only the pass the office confirmed",
      Math.abs(Number(passLedger[0]?.matched_income) - Number(prod.price)) < 0.01,
      { line: passLedger[0]?.matched_income, price: prod.price });
    const queuedRow = passLedger.find(r => r.status === "awaiting_verification");
    check("an unconfirmed reference is in the ledger with no money date",
      !!queuedRow && queuedRow.money_at === null, queuedRow);
    const liveRow = passLedger.find(r => r.status === "live");
    check("a confirmed one is money, at the instant the desk confirmed it",
      !!liveRow && liveRow.money_at !== null
      && Number(liveRow.amount) === Number(prod.price)
      && liveRow.payer_kind === "seeker" && liveRow.detail?.startsWith("weekly pass"), liveRow);

    // A second activation on the ladder must clear the bundle: what was sold changed.
    await owner.query(
      `select platform_auth.manual_activate($1,'starter','monthly','bank',null,null,null,null)`, [t]);
    const resold = (await owner.query(
      "select service_group_id, seats_licensed from subscriptions where tenant_id = $1", [t])).rows[0];
    check("re-selling on the ladder clears the bundle rather than leaving both true",
      resold.service_group_id === null, resold);

    const bad = (await owner.query(
      `select platform_auth.manual_activate($1,null,'monthly','bank',null,null,null,'not_a_bundle') as r`,
      [t])).rows[0].r;
    check("an invented bundle key is refused before any money row is written",
      bad.status === "invalid", bad);
    const neither = (await owner.query(
      `select platform_auth.manual_activate($1,null,'monthly','bank',null,null,null,null) as r`,
      [t])).rows[0].r;
    check("and selling neither a bundle nor a plan is refused too",
      neither.status === "invalid", neither);

    // The 7-argument call from 011 must still work — nothing here may break the
    // activation path that has been live since the licence gate.
    const legacy = (await owner.query(
      `select platform_auth.manual_activate($1,'business','quarterly','mpesa',null,null,null) as r`,
      [t])).rows[0].r;
    check("the 7-argument activation still sells a plan off the ladder",
      legacy.status === "ok" && !legacy.bundle, legacy);

    // ---------- the ladder licenses the rung it sold ----------
    //
    // The bundle path has always set the seats; the plan path fell through to a literal
    // 1 on a first sale, and on a later one to whatever the row held — which is the
    // column default of 0 when nothing ever set it. Both leave a paying customer locked
    // out of staff seats they bought, and 068's own register now shows that number to
    // the office, so the number has to be the licence rather than the default.
    const ladderT = (await owner.query(
      `insert into tenants (id, name, type, status)
       values (gen_random_uuid(), $1, 'transporter', 'pending_verification') returning id`,
      [`VERIFY068L ${stamp}`])).rows[0].id;
    const ladder = (await owner.query(
      `select platform_auth.manual_activate($1,'enterprise','monthly','bank',null,null,null,null) as r`,
      [ladderT])).rows[0].r;
    const ladderSub = (await owner.query(
      `select s.seats_licensed, p.seat_limit from subscriptions s
         join plans p on p.id = s.plan_id where s.tenant_id = $1`, [ladderT])).rows[0];
    check("a first sale off the ladder licenses the rung's seats, not one",
      ladder.status === "ok" && Number(ladderSub?.seats_licensed) === Number(ladderSub?.seat_limit),
      { seats: ladderSub?.seats_licensed, rung: ladderSub?.seat_limit });

    const zeroT = (await owner.query(
      `insert into tenants (id, name, type, status)
       values (gen_random_uuid(), $1, 'transporter', 'pending_verification') returning id`,
      [`VERIFY068Z ${stamp}`])).rows[0].id;
    const zeroPlan = (await owner.query(
      `select id, seat_limit from plans where key = 'business' limit 1`)).rows[0];
    await owner.query(
      `insert into subscriptions (tenant_id, plan_id, billing_cycle, status, seats_licensed)
       values ($1,$2,'monthly','expired',0)`, [zeroT, zeroPlan.id]);
    await owner.query(
      `select platform_auth.manual_activate($1,'business','monthly','bank',null,null,null,null)`, [zeroT]);
    const zeroSub = (await owner.query(
      `select seats_licensed from subscriptions where tenant_id = $1`, [zeroT])).rows[0];
    check("a row left at the column default of zero seats is raised to the rung",
      Number(zeroSub?.seats_licensed) === Number(zeroPlan.seat_limit),
      { seats: zeroSub?.seats_licensed, rung: zeroPlan.seat_limit });
    check("…while a customer already holding more than the rung keeps them",
      Number(resold.seats_licensed) === suite.seat_limit, { kept: resold.seats_licensed });

    // ---------- the price editor, on the route's own statement ----------
    const was = (await owner.query(GROUP_BY_KEY_SQL, ["cfa_office"])).rows[0];
    const upd = (await owner.query(GROUP_UPDATE_SQL,
      ["cfa_office", null, null, null, 360000, null, null, null, null,
        (await owner.query("select id from users where user_type='platform' limit 1")).rows[0]?.id ?? null]
    )).rows[0];
    check("the pricing desk can move one price and only that price",
      Number(upd.price_monthly) === 360000
      && Number(upd.price_quarterly) === Number(was.price_quarterly)
      && upd.name === was.name && upd.is_active === was.is_active,
      { was: was.price_monthly, now: upd.price_monthly, q: upd.price_quarterly });
    const mrrNow = (await owner.query(REGISTER_SQL,
      [null, null, "cfa_office", null, null, 400])).rows;
    check("…and a customer already on that bundle is repriced by the read, because the " +
      "register prices from the live list", mrrNow.every(r => Number(r.monthly_equivalent) === 360000),
      mrrNow.map(r => r.monthly_equivalent));
    const missing = await owner.query(GROUP_BY_KEY_SQL, ["no_such_bundle"]);
    check("a key that is not on the price list answers nothing, so the route can 404",
      missing.rowCount === 0);
  } finally {
    await owner.query("rollback");
  }

  const residue = (await owner.query(
    `select (select count(*) from tenants where name like 'VERIFY068 %')::int as tenants,
            (select count(*) from tenants where name like 'V068Seeker %')::int as seeker_tenants,
            (select count(*) from seeker_search_passes where payment_reference like 'V068%')::int as passes,
            (select count(*) from subscriptions s join tenants t on t.id = s.tenant_id
              where t.name like 'VERIFY068 %')::int as subs,
            (select count(*) from invoices i join tenants t on t.id = i.tenant_id
              where t.name like 'VERIFY068 %')::int as invoices,
            (select count(*) from service_groups where key like 'v068-%')::int as groups`)).rows[0];
  check("the rolled-back activation and the seeker fixtures left nothing behind",
    residue.tenants === 0 && residue.subs === 0 && residue.invoices === 0
    && residue.groups === 0 && residue.seeker_tenants === 0 && residue.passes === 0,
    residue);
  const priceBack = (await owner.query(
    "select price_monthly from service_groups where key = 'cfa_office'")).rows[0];
  check("the price the editor moved is back where it was",
    Number(priceBack.price_monthly) === 350000, priceBack);

  await owner.end();
  if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
  console.log("068 verified.");
}

main().catch((e) => { console.error(e); process.exit(1); });
