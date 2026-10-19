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
 * Section 4 is the same argument for migration 086's exit register. A churn figure is the
 * kind of number that is easy to fabricate and hard to falsify: nothing writes
 * 'cancelled' into subscriptions.status (008's gate reads the licence clock instead), so a
 * rate derived from that column is a rate over a set that is always empty. Proving the
 * register means writing one exit and reading it back through every consumer — the 068
 * register, the platform overview, churn_report's own totals, the before-image after the
 * price list moved under it, and the came_back flag after the same company is re-sold.
 * Also inside one rolled-back transaction.
 *
 * Run: npx tsx scripts/verify-control-revenue-sql.ts   (DNS_FALLBACK=1 if DNS broken)
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  REGISTER_SQL, LEDGER_SQL, MIX_SQL, GROUPS_SQL, GROUP_BY_KEY_SQL, GROUP_UPDATE_SQL,
  CANCEL_SQL, CHURN_SQL, EXITS_SQL, EXIT_REASONS, churnAdvisory
} from "../src/routes/control-revenue.routes.js";
import { NOT_MEASURED } from "../src/routes/control-system.routes.js";

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

  // ---------- 086: the exit register, its door and its two readers ----------
  //
  // The register is the first control table whose rows are a *claim about the future* — a
  // lost month's revenue — so its posture is read here in the same words the desk will be
  // held to: one door, two readers, no table privileges for anyone who logs in.
  const EXIT_FUNCS = ["cancel_subscription", "churn_report", "control_subscription_exits"];
  const exitPosture = (await owner.query(
    `select p.proname, p.prosecdef, pg_get_function_identity_arguments(p.oid) as ident,
            coalesce((select string_agg(x, ',') from unnest(p.proconfig) x
                       where x like 'search_path%'), '') as cfg,
            format_type(p.prorettype, null) as ret,
            (select count(*)::int from unnest(p.proargnames)) as arg_count,
            coalesce(array_to_string(p.proargnames, ','), '') as arg_names
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [EXIT_FUNCS])).rows;
  const exitAcl = (await owner.query(
    `select p.proname, pg_get_userbyid(ac.grantee) as grantee, ac.privilege_type
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
       lateral aclexplode(p.proacl) ac
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [EXIT_FUNCS])).rows;

  for (const f of EXIT_FUNCS) {
    const row = exitPosture.find(p => p.proname === f);
    check(`086: ${f} exists in platform_auth`, !!row, exitPosture.map(p => p.proname));
    if (!row) continue;
    check(`086: ${f} is SECURITY DEFINER with a pinned search_path`,
      row.prosecdef === true && row.cfg === "search_path=public",
      { s: row.prosecdef, cfg: row.cfg });
    check(`086: app_runtime holds EXECUTE on ${f}`,
      exitAcl.some(a => a.proname === f && a.grantee === "app_runtime"
        && a.privilege_type === "EXECUTE"),
      exitAcl.filter(a => a.proname === f).map(a => a.grantee));
    check(`086: ${f} is not reachable from PUBLIC, anon, authenticated or service_role`,
      !exitAcl.some(a => a.proname === f
        && ["public", "anon", "authenticated", "service_role"].includes(a.grantee)),
      exitAcl.filter(a => a.proname === f).map(a => `${a.grantee}:${a.privilege_type}`));
  }
  const door = exitPosture.find(p => p.proname === "cancel_subscription");
  check("086: the door takes six named arguments and no more — the reason, the note and the " +
    "actor are all a request can supply, and nothing else",
    door?.arg_count === 6
    && door?.arg_names === "p_subscription_id,p_reason_code,p_note,p_actor_user_id,"
      + "p_actor_role,p_actor_ip", { n: door?.arg_count, names: door?.arg_names });
  check("086: the door answers jsonb, not a composite — a row of all-NULL columns is how a " +
    "062-style failure hides behind a 200", door?.ret === "jsonb", door?.ret);
  check("086: the two readers take the window and the company, and both answer jsonb",
    exitPosture.filter(p => p.proname !== "cancel_subscription").every(p => p.ret === "jsonb")
    && exitPosture.find(p => p.proname === "churn_report")?.arg_names === "p_window_days"
    && exitPosture.find(p => p.proname === "control_subscription_exits")?.arg_count === 2,
    exitPosture.map(p => `${p.arg_names}:${p.ret}`));

  const reg086 = (await owner.query(
    `select c.relrowsecurity,
            (select count(*)::int from pg_policy po where po.polrelid = c.oid) as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'subscription_cancellations'`)).rows[0];
  check("086: the register exists with RLS on and no policy, so a handler cannot write a " +
    "good churn month into it", !!reg086 && reg086.relrowsecurity === true
    && reg086.policies === 0, reg086);
  const tableGrants = (await owner.query(
    `select grantee, privilege_type from information_schema.table_privileges
      where table_name = 'subscription_cancellations'`)).rows;
  check("086/087: no role that can hold a session — or bypass row security, the way " +
    "service_role can — has a single privilege on the register; the door is the only way in",
    !tableGrants.some(g => ["public", "anon", "authenticated", "app_runtime", "service_role"]
      .includes(g.grantee)), tableGrants.map(g => `${g.grantee}:${g.privilege_type}`));

  const cons086 = (await owner.query(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'public.subscription_cancellations'::regclass`)).rows;
  const defOf = (like: string) => cons086.find(c => c.conname.includes(like))?.def ?? "";
  const quotedIn = (s: string) => (s.match(/'([^']*)'/g) ?? []).map(x => x.slice(1, -1));
  check("086: the reason vocabulary in the table is the same seven words the route's enum " +
    "sends and the door accepts — three lists, one fact",
    JSON.stringify(quotedIn(defOf("reason")).sort()) === JSON.stringify([...EXIT_REASONS].sort()),
    { table: quotedIn(defOf("reason")), route: EXIT_REASONS });
  check("086: the note is bounded in the schema, not in the UI — 8 characters is the " +
    "cheapest way to say \"left\" is not a reason",
    /char_length/i.test(defOf("note")) && /trim/i.test(defOf("note"))
    && />=\s*8\b/.test(defOf("note")) && /<=\s*600\b/.test(defOf("note")), defOf("note"));
  check("086: prior_status cannot be 'cancelled' — a second exit is refused before it " +
    "reaches the register, so the set of exitable statuses is exactly the six 068 can show",
    quotedIn(defOf("prior_status")).length === 6
    && !quotedIn(defOf("prior_status")).includes("cancelled"), defOf("prior_status"));
  check("086: an offering is either the bundle or the rung, never a third word",
    JSON.stringify(quotedIn(defOf("offering_kind")).sort()) === JSON.stringify(["bundle", "plan"]),
    defOf("offering_kind"));
  const cols086 = (await owner.query(
    `select column_name, data_type, numeric_precision, numeric_scale, column_default
       from information_schema.columns where table_name = 'subscription_cancellations'`)).rows;
  const col = (n: string) => cols086.find(c => c.column_name === n) ?? {};
  check("086: the lost rate and the collected figure are numeric with explicit scales, and " +
    "the currency has a default — money is never a float in this schema",
    col("monthly_equivalent").data_type === "numeric"
    && Number(col("monthly_equivalent").numeric_scale) === 4
    && col("collected").data_type === "numeric" && Number(col("collected").numeric_scale) === 2
    && (col("currency").column_default ?? "").includes("TZS"),
    { mrr: col("monthly_equivalent"), collected: col("collected"), cur: col("currency") });
  const idx086 = (await owner.query(
    `select indexname from pg_indexes where schemaname = 'public'
      and tablename = 'subscription_cancellations'`)).rows.map(r => r.indexname);
  check("086: the three indexes the desk sorts by are in place — newest first, per company, " +
    "per reason", ["subscription_cancellations_created", "subscription_cancellations_tenant",
    "subscription_cancellations_reason"].every(i => idx086.includes(i)), idx086);

  // The clamps live in the definer's own text, so they are read there. Their effect is
  // proved from app_runtime below — a body that merely mentions a bound would still pass
  // this and fail that.
  const bodies086 = (await owner.query(
    `select p.proname, p.prosrc as body from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [EXIT_FUNCS])).rows;
  const churnBody = bodies086.find(b => b.proname === "churn_report")?.body ?? "";
  check("086: the window clamp, the 40-row recent cap and the Dar es Salaam month axis are " +
    "written into the reader itself, so no caller can widen them",
    /greatest\(least\(coalesce\(p_window_days, 90\), 730\), 7\)/.test(churnBody)
    && /limit 40/.test(churnBody) && (churnBody.match(/Africa\/Dar_es_Salaam/g) ?? []).length >= 2,
    { clamp: /greatest\(least/.test(churnBody), cap: /limit 40/.test(churnBody),
      zones: (churnBody.match(/Africa\/Dar_es_Salaam/g) ?? []).length });
  check("086: the per-company history clamps its own limit and the door prices the exit with " +
    "the same bundle-first case the 068 register uses",
    /least\(coalesce\(p_limit, 20\), 50\)/
      .test(bodies086.find(b => b.proname === "control_subscription_exits")?.body ?? "")
    && /coalesce\(g\.price_monthly, p\.price_monthly, 0\)/
      .test(bodies086.find(b => b.proname === "cancel_subscription")?.body ?? ""),
    bodies086.map(b => b.proname));
  check("086: the door locks the subscription row before it prices it, so two clerks cannot " +
    "both record one exit and hand back two different figures",
    /for update/i.test(bodies086.find(b => b.proname === "cancel_subscription")?.body ?? ""));

  const manageHolders = (await owner.query(
    `select r.key from roles r join role_permissions rp on rp.role_id = r.id
      where rp.permission_key = 'control.subscriptions.manage'
        and r.tenant_id is null and r.deleted_at is null order by r.key`)).rows.map(r => r.key);
  check("086: only the two seats that sell a subscription may end one",
    JSON.stringify(manageHolders) === JSON.stringify(["billing_admin", "super_admin"]),
    manageHolders);
  check("086: the analyst and support seats that read the register cannot write it",
    !manageHolders.includes("platform_analyst") && !manageHolders.includes("compliance_officer")
    && !manageHolders.includes("support_engineer"), manageHolders);
  check("086: the churn card is off the advisory's list of unknowns, and the three that are " +
    "still not measured stay there",
    !NOT_MEASURED.some((u: any) => /churn|cancel/i.test(String(u.thing ?? "")))
    && NOT_MEASURED.length === 3, NOT_MEASURED.map((u: any) => u.thing));

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

  // ---------- 086, as app_runtime: the window the desk actually asks for ----------
  const churnR = await app.query(CHURN_SQL, [90]);
  const c: any = churnR.rows[0]?.r ?? {};
  check("086: churn_report runs as app_runtime with no tenant GUC and answers one object " +
    "carrying both halves", churnR.rowCount === 1 && c.window_days === 90
    && !!c.exits && !!c.today && Array.isArray(c.by_month),
    { n: churnR.rowCount, keys: Object.keys(c) });
  const clamp = async (days: number | null) =>
    Number((await app.query(CHURN_SQL, [days])).rows[0]?.r?.window_days);
  const w3 = await clamp(3);
  const wBig = await clamp(5000);
  const wNull = await clamp(null);
  check("086: the window is clamped inside the definer, not in the route — 3 days becomes a " +
    "week, 5000 stops at two years, and no argument means the 90 the desk defaults to",
    w3 === 7 && wBig === 730 && wNull === 90, { w3, wBig, wNull });

  const sumBy = (arr: any[], k: string) => (arr ?? []).reduce((s, x) => s + Number(x[k] ?? 0), 0);
  const companies = Number(c.exits?.companies ?? 0);
  check("086: one exit is the same exit in all three places it is counted — the headline, the " +
    "month bars and the reason table",
    companies === sumBy(c.by_month, "cancellations")
    && companies === sumBy(c.by_reason, "companies")
    && (c.recent ?? []).length === Math.min(companies, 40),
    { companies, months: c.by_month?.length, reasons: c.by_reason?.length,
      recent: (c.recent ?? []).length });
  check("086: the lost monthly rate is the same sum whichever way the table is grouped",
    Math.abs(Number(c.exits?.mrr_lost ?? 0) - sumBy(c.by_month, "mrr_lost")) < 0.02
    && Math.abs(Number(c.exits?.mrr_lost ?? 0) - sumBy(c.by_reason, "mrr_lost")) < 0.02,
    { headline: c.exits?.mrr_lost, by_month: sumBy(c.by_month, "mrr_lost"),
      by_reason: sumBy(c.by_reason, "mrr_lost") });
  check("086: every exit is either still gone or came back — the two buckets cannot both " +
    "claim it and neither can lose it",
    Number(c.exits?.still_cancelled ?? 0) + Number(c.exits?.came_back ?? 0) === companies,
    { still: c.exits?.still_cancelled, back: c.exits?.came_back, companies });
  const rate = c.exit_rate_pct === null || c.exit_rate_pct === undefined
    ? null : Number(c.exit_rate_pct);
  const base = Number(c.sold_before_window ?? 0);
  check("086: the rate is the exits over the companies that were already sold when the window " +
    "opened, and when there is no such base the figure is absent rather than 0%",
    base === 0 ? rate === null
      : rate !== null && Math.abs(rate - 100 * companies / base) < 0.06,
    { rate, base, companies });
  check("086: today's customer count is the 068 register's total plus the closed companies " +
    "the register does not show — one population, two screens, and the difference is named",
    Number(c.today?.customers ?? 0) - Number(c.today?.closed ?? 0) === Number(r0.matched ?? 0),
    { churn: c.today?.customers, closed: c.today?.closed, register: r0.matched });
  check("086: live and at-risk money together cannot exceed the register's own recurring " +
    "total, because both price off the same expression",
    Number(c.today?.mrr_live ?? 0) + Number(c.today?.mrr_at_risk ?? 0)
      <= Number(r0.matched_mrr ?? 0) + 0.01,
    { live: c.today?.mrr_live, at_risk: c.today?.mrr_at_risk, register: r0.matched_mrr });
  check("086: the three states the desk quotes are disjoint — live, past term, cancelled — and " +
    "never add up to more companies than exist",
    Number(c.today?.live ?? 0) + Number(c.today?.out_of_term ?? 0)
      + Number(c.today?.cancelled ?? 0) <= Number(c.today?.customers ?? 0),
    { live: c.today?.live, out: c.today?.out_of_term, cancelled: c.today?.cancelled,
      customers: c.today?.customers });
  check("086: every month on the axis is a first of the month in Dar es Salaam time, so the " +
    "bars line up with every other bucket in this panel",
    (c.by_month ?? []).every((m: any) => /^\d{4}-\d{2}-01$/.test(String(m.month))),
    (c.by_month ?? []).map((m: any) => m.month));

  const neverLeft = await app.query(EXITS_SQL, [randomUUID(), 20]);
  check("086: a company that has never left asks for its history and gets an empty list, not " +
    "an error and not a null the desk has to guard",
    neverLeft.rowCount === 1 && Array.isArray(neverLeft.rows[0].a)
    && neverLeft.rows[0].a.length === 0, neverLeft.rows[0]?.a);
  let directRead = "the select succeeded";
  try {
    await app.query("select count(*)::int as n from subscription_cancellations");
  } catch (e: any) { directRead = e.code ?? String(e.message).slice(0, 40); }
  check("086: app_runtime cannot read the register directly — the door is the only way in, " +
    "so no handler can write a good churn month", directRead === "42501", directRead);
  let directWrite = "the insert succeeded";
  try {
    await app.query("insert into subscription_cancellations (subscription_id, tenant_id, " +
      "company_name, company_type, reason_code, note) values " +
      "(gen_random_uuid(), gen_random_uuid(), 'x', 'transporter', 'other', 'an invented exit')");
  } catch (e: any) { directWrite = e.code ?? String(e.message).slice(0, 40); }
  check("086: and it cannot forge one either", directWrite === "42501", directWrite);

  const advisory = await churnAdvisory(90);
  check("086: the advisory reads the same definer the desk reads, so the two cannot quote " +
    "different figures for one window",
    Number(advisory.headline.exits) === companies
    && Math.abs(Number(advisory.headline.mrr_lost) - Number(c.exits?.mrr_lost ?? 0)) < 0.02
    && Number(advisory.headline.out_of_term) === Number(c.today?.out_of_term ?? 0),
    { adv: advisory.headline, sql: { companies, lost: c.exits?.mrr_lost,
      out: c.today?.out_of_term } });
  check("086: an empty register raises no exit line, and a register with exits raises exactly " +
    "one — a healthy month contributes nothing rather than a green tick",
    companies > 0 ? advisory.items.some((i: any) => i.item_id === "churn_recorded_exits")
      : !advisory.items.some((i: any) => i.item_id === "churn_recorded_exits"),
    advisory.items.map((i: any) => i.item_id));
  const outOfTerm = Number(c.today?.out_of_term ?? 0);
  check("086: the past-term line appears when and only when the clock has passed somebody, " +
    "and it quotes the rate at risk, not a fabricated churn percentage",
    outOfTerm > 0 ? advisory.items.some((i: any) => i.item_id === "churn_out_of_term")
      : !advisory.items.some((i: any) => i.item_id === "churn_out_of_term"),
    { outOfTerm, items: advisory.items.map((i: any) => i.item_id) });
  check("086: every churn line names the revenue area, the retention kind and the desk that " +
    "can act on it",
    advisory.items.every((i: any) => i.area === "Revenue" && i.kind === "retention"
      && !!i.title && /Customers desk/.test(String(i.action))),
    advisory.items.map((i: any) => [i.item_id, i.area, i.kind]));

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

  // ============================
  // 4. The exit, written and rolled back (migration 086, task #155)
  // ============================
  //
  // A churn figure is easy to fabricate and hard to falsify, so this section sells a
  // company, ends it, and reads that one act back through every consumer the office has:
  // the door's own receipt, the 068 register, the platform overview, churn_report's
  // headline / month bars / reason table / recent list, the per-company history and the
  // audit log. Then it re-sells the same company, because "left" and "came back" are two
  // sentences a single status column cannot hold.
  await owner.query("begin");
  try {
    const stamp = Date.now().toString(36).toUpperCase();
    const name = `VERIFY086 ${stamp}`;
    const actor = (await owner.query(
      "select id from users where user_type = 'platform' limit 1")).rows[0]?.id ?? null;
    const suite = groups.rows.find(g => g.key === "transport_cfa_office") ?? {};
    const monthly = Number(suite.price_monthly);
    const ladder = (await owner.query(
      `select id, seat_limit, price_monthly from plans where key = 'starter' limit 1`)).rows[0];

    const t = (await owner.query(
      `insert into tenants (id, name, type, status)
       values (gen_random_uuid(), $1, 'transporter', 'pending_verification') returning id`,
      [name])).rows[0].id;
    const sold = (await owner.query(
      `select platform_auth.manual_activate($1,null,$2,'bank',null,null,null,'transport_cfa_office') as r`,
      [t, "monthly"])).rows[0].r;
    const sub = (await owner.query(
      "select id, status, auto_renew, seats_licensed from subscriptions where tenant_id = $1",
      [t])).rows[0];
    check("086: the fixture is a paying bundle customer before it can be an exit",
      sold.status === "ok" && sub.status === "active" && Number(sub.seats_licensed) === Number(suite.seat_limit),
      { sold, sub });
    const paid = (await owner.query(
      `select coalesce(sum(amount_total),0)::numeric as total, count(*)::int as n from invoices
        where subscription_id = $1 and status = 'paid' and deleted_at is null`, [sub.id])).rows[0];
    check("086: the sale left one paid invoice behind, which is what the exit will freeze",
      Number(paid.n) === 1 && Number(paid.total) === Number(sold.total), paid);

    const base = (await owner.query(CHURN_SQL, [90])).rows[0]?.r ?? {};
    const tBefore = (await owner.query(
      `select status, deleted_at, licence_expires_at, trial_ends_at from tenants where id = $1`,
      [t])).rows[0];
    const ovBefore = (await owner.query(
      "select platform_auth.control_overview() as o")).rows[0].o;

    // ---------- the refusals, before anything is written ----------
    const badReason = (await owner.query(CANCEL_SQL,
      [sub.id, "not_a_reason", "A note long enough to satisfy the door.", actor,
        "super_admin", "203.0.113.7"])).rows[0].r;
    check("086: an invented reason is refused, not quietly stored as 'other'",
      badReason.status === "invalid", badReason);
    const shortNote = (await owner.query(CANCEL_SQL,
      [sub.id, "price", "left", actor, "super_admin", "203.0.113.7"])).rows[0].r;
    check("086: a one-word note is refused — the sentence that explains the exit later is " +
      "the reason, not the code", shortNote.status === "invalid", shortNote);
    const ghost = (await owner.query(CANCEL_SQL,
      [randomUUID(), "price", "A note long enough to satisfy the door.", actor,
        "super_admin", "203.0.113.7"])).rows[0].r;
    check("086: a subscription that is not on the register answers not_found, so the route " +
      "can 404 instead of inventing an exit", ghost.status === "not_found", ghost);
    const afterRefusals = (await owner.query(CHURN_SQL, [90])).rows[0]?.r ?? {};
    check("086: and none of the three wrote a row — a refusal must not be a fact",
      Number(afterRefusals.exits?.companies) === Number(base.exits?.companies ?? 0)
      && JSON.stringify(afterRefusals.today) === JSON.stringify(base.today),
      { before: base.exits, after: afterRefusals.exits });

    // ---------- the exit ----------
    const out = (await owner.query(CANCEL_SQL, [sub.id, "price",
      `Quoted ${stamp}: the suite is above what this company can bill its own clients.`,
      actor, "super_admin", "203.0.113.7"])).rows[0].r;
    check("086: the door records the exit and answers with the image it read under the lock, " +
      "not with an echo of the body", out.status === "ok" && !!out.cancel_id
      && out.tenant_id === t && out.subscription_id === sub.id, out);
    check("086: the rate it says the office lost is the bundle's monthly figure, priced the " +
      "way 068 prices — not the rung the bundle sits on",
      Number(out.monthly_equivalent) === monthly,
      { got: out.monthly_equivalent, bundle: monthly, invoice: sold.total });
    check("086: the seats it says were lost are the bundle's licence",
      Number(out.seats_licensed) === Number(suite.seat_limit), out.seats_licensed);
    check("086: prior_status is what the row said before the write, and the offering is " +
      "named in the same words the register uses",
      out.prior_status === "active" && out.offering === "transport_cfa_office"
      && out.billing_cycle === "monthly", out);
    check("086: collected is what had actually been paid — the invoice total with VAT, never " +
      "the monthly rate repeated", Number(out.collected) === Number(paid.total)
      && Number(out.paid_invoices) === 1 && Number(out.collected) !== monthly,
      { collected: out.collected, invoice: paid.total, monthly });

    const subNow = (await owner.query(
      "select status, auto_renew, updated_by from subscriptions where id = $1",
      [sub.id])).rows[0];
    check("086: the sale ends — cancelled, auto-renew off, and the person who wrote it named " +
      "on the row", subNow.status === "cancelled" && subNow.auto_renew === false
      && subNow.updated_by === actor, subNow);
    const tNow = (await owner.query(
      `select status, deleted_at, licence_expires_at, trial_ends_at from tenants where id = $1`,
      [t])).rows[0];
    check("086: …and the company is untouched. An exit is a billing act, not a sanction: " +
      "blocking and closing stay on the tenants register (078), on their own duty and clock",
      JSON.stringify(tNow) === JSON.stringify(tBefore), { before: tBefore, after: tNow });
    const second = (await owner.query(CANCEL_SQL, [sub.id, "price",
      `A second attempt, ${stamp}, long enough to pass the note floor.`, actor,
      "super_admin", "203.0.113.7"])).rows[0].r;
    check("086: a second exit on the same row is refused — the register cannot be padded by " +
      "a double click", second.status === "conflict", second);

    // ---------- the reading ----------
    const mid = (await owner.query(CHURN_SQL, [90])).rows[0]?.r ?? {};
    check("086: the headline moved by exactly one exit and exactly this bundle's rate",
      Number(mid.exits?.companies) === Number(base.exits?.companies ?? 0) + 1
      && Math.abs(Number(mid.exits?.mrr_lost) - Number(base.exits?.mrr_lost ?? 0) - monthly) < 0.02,
      { before: base.exits, after: mid.exits });
    check("086: the denominator ignored the fixture, because it was sold the same day — a " +
      "month of new sales cannot dilute the rate",
      Number(mid.sold_before_window) === Number(base.sold_before_window ?? 0),
      { before: base.sold_before_window, after: mid.sold_before_window });
    check("086: the reason the desk typed is the reason the table counts, and the newest " +
      "exit in the recent list is this one, note and role and all",
      (mid.by_reason ?? []).some((x: any) => x.reason_code === "price"
        && Number(x.companies) >= 1)
      && mid.recent?.[0]?.company_name === name && mid.recent?.[0]?.reason_code === "price"
      && mid.recent?.[0]?.actor_role === "super_admin"
      && String(mid.recent?.[0]?.note ?? "").includes(stamp)
      && mid.recent?.[0]?.came_back === false,
      { reasons: mid.by_reason, first: mid.recent?.[0] });
    // The fixture was already live when the baseline was taken, so the exit moves exactly
    // one bucket down and one up. out_of_term is the one that must not move: an exit is a
    // person's claim and past-term is the clock's, and adding them together would be the
    // unfalsifiable number this card used to refuse to quote.
    check("086: the exit moved one customer out of live and into cancelled, took that rate " +
      "out of the live money, and did not touch the past-term bucket",
      Number(mid.today?.customers) === Number(base.today?.customers ?? 0)
      && Number(mid.today?.live) === Number(base.today?.live ?? 0) - 1
      && Number(mid.today?.cancelled) === Number(base.today?.cancelled ?? 0) + 1
      && Number(mid.today?.out_of_term) === Number(base.today?.out_of_term ?? 0)
      && Math.abs(Number(mid.today?.mrr_live) - Number(base.today?.mrr_live ?? 0)
        + monthly) < 0.02,
      { base: base.today, mid: mid.today, monthly });
    const overview = (await owner.query(
      "select platform_auth.control_overview() as o")).rows[0].o;
    check("086: the platform's own overview agrees with the register — one more cancelled " +
      "subscription and one bundle's rate less of recurring money, off the column the door " +
      "wrote",
      Number(overview.subscriptions.cancelled) === Number(ovBefore.subscriptions.cancelled) + 1
      && Math.abs(Number(overview.recurring.mrr) - Number(ovBefore.recurring.mrr)
        + monthly) < 0.02,
      { cancelled: [ovBefore.subscriptions.cancelled, overview.subscriptions.cancelled],
        mrr: [ovBefore.recurring.mrr, overview.recurring.mrr] });

    // ---------- the price list moves under the exit ----------
    await owner.query(GROUP_UPDATE_SQL, ["transport_cfa_office", null, null, null, 360000,
      null, null, null, null, actor]);
    const repriced = (await owner.query(CHURN_SQL, [90])).rows[0]?.r ?? {};
    check("086: re-pricing the bundle does not rewrite what the office lost — the exit is a " +
      "before-image, not a pointer",
      Math.abs(Number(repriced.exits?.mrr_lost) - Number(mid.exits?.mrr_lost)) < 0.02
      && Number(repriced.recent?.[0]?.monthly_equivalent) === monthly,
      { lost: repriced.exits?.mrr_lost, at_exit: mid.exits?.mrr_lost, image: repriced.recent?.[0] });
    const hist = (await owner.query(EXITS_SQL, [t, 5])).rows[0].a;
    check("086: the per-company history shows the exit with the rate that was true then, " +
      "the code and the note the desk wrote", hist.length === 1
      && Number(hist[0].monthly_equivalent) === monthly && hist[0].reason_code === "price"
      && hist[0].actor_role === "super_admin" && String(hist[0].note).includes(stamp), hist);
    const clampedHist = (await owner.query(EXITS_SQL, [t, 999999])).rows[0].a;
    check("086: and a runaway limit on the history is clamped inside the definer",
      Array.isArray(clampedHist) && clampedHist.length <= 50, clampedHist.length);

    // ---------- came back ----------
    const resale = (await owner.query(
      `select platform_auth.manual_activate($1,'starter','monthly','bank',null,null,null,null) as r`,
      [t])).rows[0].r;
    const back = (await owner.query(CHURN_SQL, [90])).rows[0]?.r ?? {};
    check("086: re-selling the company does not delete the exit — the register is history, " +
      "not a status", resale.status === "ok"
      && Number(back.exits?.companies) === Number(mid.exits?.companies),
      { resale, exits: back.exits?.companies });
    check("086: …and the exit is now flagged as a customer that came back, which is exactly " +
      "why an exit cannot be read as a lost customer without asking",
      Number(back.exits?.came_back) === Number(base.exits?.came_back ?? 0) + 1
      && Number(back.exits?.still_cancelled) === Number(base.exits?.still_cancelled ?? 0)
      && back.recent?.[0]?.came_back === true,
      { came: back.exits?.came_back, still: back.exits?.still_cancelled,
        base: base.exits, first: back.recent?.[0] });
    check("086: what had been paid at the moment of the exit stayed frozen while the resale " +
      "added a second invoice",
      Math.abs(Number(back.exits?.paid_before_exit) - Number(base.exits?.paid_before_exit ?? 0)
        - Number(paid.total)) < 0.02,
      { before: base.exits?.paid_before_exit, after: back.exits?.paid_before_exit });
    const backToday = back.today ?? {};
    check("086: the cancelled bucket went back down and the live one came back up — the same " +
      "register, two different sentences, and the exit row still there",
      Number(backToday.cancelled) === Number(base.today?.cancelled ?? 0)
      && Number(backToday.live) === Number(base.today?.live ?? 0)
      // The resale moved the company off the bundle onto the ladder, so its live rate is now
      // the rung's price. Asserting the exact figure is what proves the register prices from
      // the live list on both halves of its own read.
      && Math.abs(Number(backToday.mrr_live) - Number(base.today?.mrr_live ?? 0)
        + monthly - Number(ladder.price_monthly)) < 0.02,
      { base: base.today, back: backToday, monthly, starter: ladder.price_monthly });

    const aud = (await owner.query(
      `select action, before, after from audit_logs where entity = 'subscriptions'
        and entity_id = $1 and action = 'subscription.cancelled'
        order by ts desc limit 1`, [sub.id])).rows[0];
    check("086: the exit is on the audit log with the rate it lost and the id it produced, " +
      "so the two records cannot drift apart", !!aud && aud.before?.status === "active"
      && aud.after?.reason_code === "price" && aud.after?.cancel_id === out.cancel_id
      && Number(aud.after?.monthly_equivalent) === monthly, aud);

    // ---------- the doors that must not open ----------
    const closedT = (await owner.query(
      `insert into tenants (id, name, type, status, deleted_at)
       values (gen_random_uuid(), $1, 'transporter', 'active', now()) returning id`,
      [`VERIFY086C ${stamp}`])).rows[0].id;
    await owner.query(`insert into subscriptions (tenant_id, plan_id, billing_cycle, status,
        seats_licensed) values ($1,$2,'monthly','active',1)`, [closedT, ladder.id]);
    const closedSub = (await owner.query(
      "select id from subscriptions where tenant_id = $1", [closedT])).rows[0].id;
    const closedRes = (await owner.query(CANCEL_SQL, [closedSub, "other",
      `A company the tenants desk already shut, ${stamp}.`,
      actor, "super_admin", null])).rows[0].r;
    check("086: a company the tenants desk already closed cannot be exited here too — the " +
      "two registers keep their own events", closedRes.status === "conflict", closedRes);
    const seekerT = (await owner.query(
      `insert into tenants (id, name, type, status)
       values (gen_random_uuid(), $1, 'seeker', 'active') returning id`,
      [`VERIFY086S ${stamp}`])).rows[0].id;
    await owner.query(`insert into subscriptions (tenant_id, plan_id, billing_cycle, status,
        seats_licensed) values ($1,$2,'monthly','active',1)`, [seekerT, ladder.id]);
    const seekerSub = (await owner.query(
      "select id from subscriptions where tenant_id = $1", [seekerT])).rows[0].id;
    const seekerRes = (await owner.query(CANCEL_SQL, [seekerSub, "other",
      `A seeker has no company subscription, ${stamp}.`,
      actor, "super_admin", null])).rows[0].r;
    check("086: and a seeker is refused as invalid, because the marketplace account is not a " +
      "customer the billing desk sold", seekerRes.status === "invalid", seekerRes);

    const residueIn = (await owner.query(
      `select (select count(*) from subscription_cancellations
                 where company_name like 'VERIFY086 %')::int as exits,
               (select count(*) from tenants where name like 'VERIFY086%')::int as tenants`)).rows[0];
    check("086: the fixture's own rows are visible inside the transaction, so a passing " +
      "assertion above cannot have been a passing assertion over an empty set",
      residueIn.exits >= 1 && residueIn.tenants === 3, residueIn);
  } finally {
    await owner.query("rollback");
  }

  const residue086 = (await owner.query(
    `select (select count(*) from tenants where name like 'VERIFY086%')::int as tenants,
            (select count(*) from subscriptions s join tenants t on t.id = s.tenant_id
              where t.name like 'VERIFY086%')::int as subs,
            (select count(*) from invoices i join tenants t on t.id = i.tenant_id
              where t.name like 'VERIFY086%')::int as invoices,
            (select count(*) from subscription_cancellations
              where company_name like 'VERIFY086%')::int as exits`)).rows[0];
  check("086: the rolled-back exit left nothing behind — no company, no subscription, no " +
    "invoice and above all no row on the churn register",
    residue086.tenants === 0 && residue086.subs === 0 && residue086.invoices === 0
    && residue086.exits === 0, residue086);
  const priceBack086 = (await owner.query(
    "select price_monthly from service_groups where key = 'transport_cfa_office'")).rows[0];
  check("086: and the bundle price the probe moved is back where the office left it",
    Number(priceBack086.price_monthly) === Number(groups.rows
      .find(g => g.key === "transport_cfa_office")?.price_monthly), priceBack086);
  const afterRollback = (await owner.query(CHURN_SQL, [90])).rows[0]?.r ?? {};
  check("086: the register reads the same after the rollback as the very first call did, " +
    "which is the only proof the probe was a probe and not a write",
    Number(afterRollback.exits?.companies ?? 0) === Number(c.exits?.companies ?? 0)
    && Math.abs(Number(afterRollback.exits?.mrr_lost ?? 0)
      - Number(c.exits?.mrr_lost ?? 0)) < 0.02
    && Number(afterRollback.sold_before_window) === Number(c.sold_before_window),
    { now: afterRollback.exits, app_runtime_said: c.exits });

  await owner.end();
  if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
  console.log("068 + 086 verified.");
}

main().catch((e) => { console.error(e); process.exit(1); });
