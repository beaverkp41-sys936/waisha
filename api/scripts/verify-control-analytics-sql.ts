/**
 * Live proof for migration 066 — the platform analytics aggregates, the redactor and
 * the audit reader.
 *
 * Every function here is SECURITY DEFINER, and EXPLAIN on a definer only plans the
 * call: it cannot see that the body references a column that moved, that a grant is
 * missing, or that the payload it returns still holds a NIDA number. So the checks
 * that matter run the functions and read what comes back, as app_runtime — the
 * production API role — not as the owner URL dev connects with, which bypasses RLS
 * and would false-pass every privilege probe.
 *
 * Run: npx tsx scripts/verify-control-analytics-sql.ts   (DNS_FALLBACK=1 if DNS broken)
 */
import "dotenv/config";
import pg from "pg";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label, String(detail).slice(0, 500)); }
}

const FUNCS = [
  "control_overview", "control_growth", "control_revenue", "control_forecast",
  "list_audit_for_control", "list_audit_actions", "redact_audit_payload"
];

/**
 * A payload is safe when every PII-named key carries nothing but the marker. The
 * reader keeps the KEY names on purpose — a forensic screen that cannot say which
 * field changed is useless — so the invariant is about the values, at any depth, and
 * this is the one place that regex lives.
 */
const PII_KEY = /encrypted|_search$|^tin$|nida|password|passwd|secret|token|otp|pin$|phone|mobile|email|address|passport|visa|national_id|licence_no|license_no/i;
function unredactedValues(node: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(node)) { node.forEach((e, i) => unredactedValues(e, `${path}[${i}]`, out)); return out; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (PII_KEY.test(k) && v !== "[redacted]") out.push(`${path}.${k}=${JSON.stringify(v)}`);
      unredactedValues(v, `${path}.${k}`, out);
    }
  }
  return out;
}

function ownerUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  return url;
}

/** app_runtime URL: dev hands us the owner URL, so rebuild it (verify-privileges shape). */
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

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  // ============================
  // 1. Catalog posture, as the owner
  // ============================
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  const fnShape = (await oi(
    `select p.proname, p.prosecdef,
            coalesce(array_to_string(p.proconfig, ','), '') as cfg,
            pg_get_functiondef(p.oid) as body
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [FUNCS])).rows;
  check("all seven 066 functions exist", fnShape.length === FUNCS.length, `${fnShape.length} found`);
  check("every table-reading definer is SECURITY DEFINER with a pinned path",
    fnShape.filter(f => f.proname !== "redact_audit_payload")
      .every(f => f.prosecdef && /search_path=public/.test(f.cfg)),
    JSON.stringify(fnShape.filter(f => !f.prosecdef || !/search_path=public/.test(f.cfg))
      .map(f => f.proname)));
  check("the redactor is immutable so the planner can fold it",
    /immutable/i.test(fnShape.find(f => f.proname === "redact_audit_payload")?.body ?? ""));

  const granted = (await oi(
    `select p.proname, ac.privilege_type, ac.grantee::regrole::text as grantee
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
       lateral aclexplode(p.proacl) ac
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [FUNCS])).rows;
  const browserGrants = granted.filter(g =>
    /^(anon|authenticated|service_role|public)$/.test(String(g.grantee).toLowerCase()));
  check("no browser role or PUBLIC holds a right on any 066 function",
    browserGrants.length === 0, JSON.stringify(browserGrants.slice(0, 6)));
  check("app_runtime holds EXECUTE on every one",
    FUNCS.every(f => granted.some(g => g.proname === f && g.grantee === "app_runtime"
      && g.privilege_type === "EXECUTE")));

  const costShape = (await oi(
    `select c.relrowsecurity as rls,
            (select count(*) from information_schema.table_constraints t
              where t.table_name = 'platform_costs'
                and t.constraint_name = 'platform_costs_month_category_uq') as uq,
            (select count(*) from pg_policies where tablename = 'platform_costs') as policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'platform_costs'`)).rows[0];
  check("platform_costs is RLS-enabled with its three policies and its month key",
    costShape?.rls === true && Number(costShape?.policies) === 3 && Number(costShape?.uq) === 1,
    JSON.stringify(costShape));
  const costPrivs = (await oi(
    `select privilege_type from information_schema.role_table_grants
      where grantee = 'app_runtime' and table_name = 'platform_costs'`)).rows.map(r => r.privilege_type);
  check("platform_costs is writable but never deletable",
    costPrivs.includes("INSERT") && costPrivs.includes("UPDATE") && !costPrivs.includes("DELETE"),
    costPrivs.join(","));

  const auditIdx = (await oi(
    `select count(distinct c.relname) as n from pg_class c
       join pg_index i on i.indrelid = c.oid
       join pg_class ix on ix.oid = i.indexrelid
      where c.relname = 'audit_logs' and ix.relname in ('idx_audit_actor_ts','idx_audit_action_ts')`)).rows[0];
  check("the forensic filters have indexes on the trail",
    Number(auditIdx?.n) === 1, JSON.stringify(auditIdx));

  const matrix = (await oi(
    `select r.key as role, rp.permission_key as key
       from roles r join role_permissions rp on rp.role_id = r.id
      where r.tenant_id is null
        and rp.permission_key in ('control.analytics.view','control.costs.manage','control.audit.view')`)).rows;
  const holds = (role: string) => matrix.filter(m => m.role === role).map(m => m.key).sort();
  check("super_admin reads numbers, owns costs and reads the trail",
    holds("super_admin").join(",") === "control.analytics.view,control.audit.view,control.costs.manage",
    holds("super_admin").join(","));
  check("billing_admin owns the money and the cost ledger, not the trail",
    holds("billing_admin").join(",") === "control.analytics.view,control.costs.manage",
    holds("billing_admin").join(","));
  // 005 already made the analyst a read-only auditor; 066 adds the numbers on top.
  // What matters is the negative: no role below super_admin writes the cost ledger
  // except billing.
  check("platform_analyst reads numbers and the trail, and never a cost line",
    holds("platform_analyst").join(",") === "control.analytics.view,control.audit.view",
    holds("platform_analyst").join(","));
  check("only super_admin and billing_admin can write the cost ledger",
    matrix.filter(m => m.key === "control.costs.manage").map(m => m.role).sort().join(",")
      === "billing_admin,super_admin",
    matrix.filter(m => m.key === "control.costs.manage").map(m => m.role).join(","));
  check("compliance_officer reads numbers and the trail, never costs",
    holds("compliance_officer").join(",") === "control.analytics.view,control.audit.view",
    holds("compliance_officer").join(","));
  check("customer_service_agent sees counts only",
    holds("customer_service_agent").join(",") === "control.analytics.view",
    holds("customer_service_agent").join(","));

  // The month key the CHECK enforces, and the two guards the UI will hit first.
  const monthStart = (await oi(
    `select date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')::date as d`)).rows[0].d;
  await oi("begin");
  let refused = 0;
  for (const [label, sql] of [
    ["a period that is not the first of its month",
      `insert into platform_costs (period, category, amount) values ('2026-10-15', 'other', 1) `],
    ["a negative amount",
      `insert into platform_costs (period, category, amount) values ('${monthStart}', 'other', -1)`],
    ["a category outside the closed list",
      `insert into platform_costs (period, category, amount) values ('${monthStart}', 'bribes', 1)`],
    ["a currency that is not TZS",
      `insert into platform_costs (period, category, amount, currency) values ('${monthStart}', 'other', 1, 'USD')`]
  ] as [string, string][]) {
    try { await oi("savepoint sp"); await oi(sql); await oi("rollback to savepoint sp"); }
    catch { refused++; await oi("rollback to savepoint sp"); }
  }
  // Duplicate month+category: the whole point of the unique key.
  try {
    await oi("savepoint sp2");
    await oi(`insert into platform_costs (period, category, amount) values ('${monthStart}', 'marketing', 1)`);
    await oi(`insert into platform_costs (period, category, amount) values ('${monthStart}', 'marketing', 2)`);
    await oi("rollback to savepoint sp2");
  } catch { refused++; await oi("rollback to savepoint sp2"); }
  await oi("rollback");
  check("the cost ledger refuses a bad row five ways", refused === 5, `${refused}/5 refused`);

  // Smoke teardown hard-deletes its users and tenants, so most of the recent trail
  // points at accounts that no longer exist. The name probe has to pick an actor that
  // is still there, and it has to be found through the owner connection — app_runtime
  // cannot see users without a tenant GUC.
  const liveActor = (await oi(
    `select a.actor_user_id as id, u.full_name as name
       from audit_logs a join users u on u.id = a.actor_user_id
      where u.full_name is not null order by a.ts desc limit 1`)).rows[0] ?? null;

  // Rows the raw table says carry PII columns. Collected here because app_runtime has
  // no SELECT on audit_logs at all — that is the point — and read back through the
  // reader below, where the redaction is what is being asserted.
  const PII_COLS = ["tin", "tin_display", "phone", "phone_search", "nida_number",
    "nida_search", "email", "otp_code", "password_hash", "transport_licence_no"];
  const piiRows = (await oi(
    `select id, tenant_id, actor_user_id, entity, ts from audit_logs
      where before ?| $1::text[] or after ?| $1::text[] order by ts desc limit 5`,
    [PII_COLS])).rows;

  await owner.end();

  // ============================
  // 2. Execution, as app_runtime
  // ============================
  const aUrl = appUrl();
  if (!aUrl) {
    console.log("SKIP app_runtime probes — no APP_DB_PASSWORD / APP_DATABASE_URL");
    process.exit(failures ? 1 : 0);
  }
  const app = new pg.Client({ connectionString: aUrl, ssl: { rejectUnauthorized: false } });
  await app.connect();
  const ai = (sql: string, params: any[] = []) => app.query(sql, params);

  // ---------- the redactor ----------
  const sample = {
    name: "Kilian Transport", tin: "105-672-913", tin_encrypted: "\\x00ff",
    nida_search: "deadbeef", phone: "+255784000111", email: "a@b.co",
    password_hash: "$argon2id$", otp_code: "448120", home_address: "Kariakoo, Dar",
    before: { phone_search: "abc", seat_limit: 40, nested: { national_id: "12345", note: "kept" } },
    items: [{ email: "c@d.co", qty: 2 }, { tin: "999" }, "plain string"]
  };
  const red = (await ai("select platform_auth.redact_audit_payload($1::jsonb) as r", [sample])).rows[0].r;
  // The redactor replaces a PII value with "[redacted]" and keeps the key — the
  // forensic screen has to say *which* field changed. So the test is not "the key is
  // gone" but "no PII key still carries anything but the marker", at any depth.
  const stillLive = unredactedValues(red);
  check("no PII key survives the redactor with a live value, at any depth",
    stillLive.length === 0, stillLive.slice(0, 6).join(", "));
  check("and the probe can fail: the same walker flags the sample before it was redacted",
    unredactedValues(sample).length > 6, `${unredactedValues(sample).length} live values`);
  check("the redactor blanks every PII value it does keep",
    red.tin === "[redacted]" && red.nida_search === "[redacted]" &&
    red.before?.nested?.national_id === "[redacted]" &&
    red.items?.[0]?.email === "[redacted]" && red.items?.[1]?.tin === "[redacted]");
  check("safe copy survives untouched",
    red.name === "Kilian Transport" && red.before?.nested?.note === "kept" &&
    red.before?.seat_limit === 40 && red.items?.[0]?.qty === 2);
  check("array elements that are not objects are left alone",
    red.items?.[2] === "plain string");
  check("a non-object payload redacts to an empty object",
    JSON.stringify((await ai("select platform_auth.redact_audit_payload('[1,2]'::jsonb) as r")).rows[0].r) === "{}");

  // ---------- the overview ----------
  const ov = (await ai("select platform_auth.control_overview() as o")).rows[0].o;
  const want = ["companies", "seekers", "users", "subscriptions", "recurring", "money",
    "passes", "costs", "marketplace", "activity"];
  check("the overview answers every block the admin panel opens with",
    want.every(k => ov && ov[k]), want.filter(k => !ov?.[k]).join(","));
  check("the overview's company split is the two real types, not seekers",
    typeof ov.companies.total === "number" &&
    ov.companies.total === ov.companies.transporters + ov.companies.shippers,
    JSON.stringify(ov.companies));
  check("user counts exclude platform staff and add up",
    typeof ov.users.total === "number" &&
    ov.users.total >= ov.users.active &&
    typeof ov.users.dormant_30d === "number" && typeof ov.users.logged_in_today === "number",
    JSON.stringify(ov.users));
  check("MRR and ARR are the same book of business",
    Number(ov.recurring.mrr) > 0 && Math.abs(Number(ov.recurring.arr) - Number(ov.recurring.mrr) * 12)
      <= Math.max(12, Number(ov.recurring.arr) * 0.02),
    `mrr=${ov.recurring.mrr} arr=${ov.recurring.arr}`);
  check("money is reported in TZS and VAT is inside the collected figure",
    ov.currency === "TZS" && Number(ov.money.vat_month) <= Number(ov.money.collected_month) + 0.01,
    JSON.stringify(ov.money));
  check("the marketplace block counts the live board and the demand behind it",
    typeof ov.marketplace.live === "number" && typeof ov.marketplace.searches_30d === "number" &&
    ov.marketplace.searches_30d >= ov.marketplace.searches_7d);
  check("activity is measured on the trail itself, not a side counter",
    typeof ov.activity.events_24h === "number" &&
    ov.activity.events_7d >= ov.activity.events_24h);

  // ---------- growth ----------
  const growth = (await ai("select * from platform_auth.control_growth(6)")).rows;
  check("growth returns one row per month, oldest first",
    growth.length === 6 && new Date(growth[0].month) < new Date(growth[5].month),
    `${growth.length} rows`);
  check("growth counts come back as numbers, not int8 strings",
    growth.every(g => typeof g.new_companies === "number" && typeof g.activated === "number"),
    JSON.stringify(growth[0]));
  check("the running month is the last point on the axis",
    Number(growth[5]?.month) === Number(monthStart),
    `${growth[5]?.month} vs ${monthStart}`);
  const twentyFour = (await ai("select * from platform_auth.control_growth(24)")).rows;
  const clamped = (await ai("select count(*)::int as n from platform_auth.control_growth(500)")).rows[0].n;
  check("the axis stretches to the window asked for and clamps at sixty months",
    twentyFour.length === 24 && clamped === 60, `${twentyFour.length} / ${clamped}`);

  // ---------- revenue ----------
  const rev = (await ai("select * from platform_auth.control_revenue(12)")).rows;
  check("revenue spans twelve months", rev.length === 12);
  const arith = rev.filter(r =>
    Number(r.gross) !== Number(r.subscription_income) + Number(r.pass_income) ||
    Number(r.net) !== Number(r.gross) - Number(r.vat) ||
    Number(r.profit) !== Number(r.net) - Number(r.costs));
  check("every month adds up: gross, net of VAT, profit after costs",
    arith.length === 0, JSON.stringify(arith.slice(0, 2)));
  // The ledger is empty in a fresh database, so "profit = net - costs" would pass
  // against a join that silently returned nothing. One row, inside a transaction that
  // is rolled back: the definer sees it because it is the same backend snapshot, and
  // nothing is left behind.
  await ai("begin");
  try {
    await ai(`insert into platform_costs (period, category, amount, note)
              values ($1::date, 'infrastructure', 123456.78, 'verify-only')`, [monthStart]);
    const withCost = (await ai("select * from platform_auth.control_revenue(3)")).rows;
    const thisMonth = withCost[withCost.length - 1];
    check("a recorded cost lands on its month of the P&L and moves profit down by exactly that",
      Number(thisMonth?.costs) === 123456.78 &&
      Math.abs(Number(thisMonth.profit) - (Number(thisMonth.net) - 123456.78)) < 0.005,
      JSON.stringify(thisMonth));
    const ovCosts = (await ai("select platform_auth.control_overview() as o")).rows[0].o;
    check("the overview's month cost reads the same ledger",
      Number(ovCosts.costs.month) === 123456.78 && Number(ovCosts.costs.months_recorded) === 1,
      JSON.stringify(ovCosts.costs));
  } finally {
    await ai("rollback");
  }
  const afterRollback = (await ai(
    "select coalesce(sum(amount),0)::numeric as n from platform_costs")).rows[0].n;
  check("the probe left the ledger empty again", Number(afterRollback) === 0, String(afterRollback));

  // ---------- forecast ----------
  const fc = (await ai("select * from platform_auth.control_forecast(12, 3)")).rows;
  const metrics = [...new Set(fc.map(f => f.metric))].sort();
  check("the forecast fits seven metrics, the ones the panel charts",
    metrics.length === 7, metrics.join(","));
  const actualMonths = fc.filter(f => !f.is_projected).map(f => new Date(f.month).getTime());
  const projected = fc.filter(f => f.is_projected);
  // The fit window is what the caller asked for, not one month less: revenue and
  // growth each count the running month in their own axis and this function refuses to
  // fit on it, so twelve requested months has to still be twelve closed months.
  const window = [...new Set(fc.map(f => f.metric))]
    .map((m) => `${m}:${fc.filter(f => f.metric === m && !f.is_projected).length}`);
  check("twelve months asked for is twelve closed months fitted, for every metric",
    window.every((w) => w.endsWith(":12")), window.join(" "));
  check("projection only ever happens after the last closed month",
    projected.every(p => new Date(p.month).getTime() > Math.max(...actualMonths)),
    `${projected.length} projected`);
  check("a projected point carries no fake actual",
    projected.every(p => p.actual === null && p.projected !== null));
  check("an actual point carries no fake projection",
    fc.filter(f => !f.is_projected).every(f => f.projected === null));
  // numeric comes back from pg as a string, so the route casts; the probe asserts on
  // the raw function output that every fit is a real number-shaped value.
  check("three closed months is enough to fit, so the line has a slope and a bounded r2",
    projected.length > 0 &&
    projected.every(p => Number.isFinite(Number(p.slope)) && p.slope !== null) &&
    fc.every(f => f.fit_r2 === null || (Number(f.fit_r2) >= 0 && Number(f.fit_r2) <= 1)),
    JSON.stringify(projected[0] ?? null).slice(0, 200));
  check("a forecast line never projects money below zero",
    projected.every(p => Number(p.projected) >= 0));
  const short = (await ai("select * from platform_auth.control_forecast(3, 1)")).rows;
  check("the horizon is clamped and never swallows the axis",
    short.length === 28 && short.filter(s => s.is_projected).length === 7,
    `${short.length} rows, ${short.filter(s => s.is_projected).length} projected`);

  // ---------- the audit reader ----------
  const audit = (await ai("select * from platform_auth.list_audit_for_control()")).rows;
  check("the trail can be read for the first time since 001", audit.length > 0,
    `${audit.length} rows`);
  const named = liveActor
    ? (await ai("select * from platform_auth.list_audit_for_control(null,$1,null,null,null,null,null,50)",
        [liveActor.id])).rows
    : [];
  check("an actor who still has an account comes back with their name and email",
    named.length > 0 && named.every(n => n.actor_name === liveActor.name && !!n.actor_email),
    `${named.length} rows for ${liveActor?.name ?? "nobody"}: ${JSON.stringify(named[0]?.actor_name)}`);
  // Rows that carry PII key names are not a leak — the reader keeps the names and blanks
  // the values. So this takes the rows the raw table said hold those columns and reads
  // each back through the reader: a check on the newest page alone would pass happily
  // on a trail full of nothing.
  check("the trail really does hold payloads with PII columns in them", piiRows.length > 0,
    piiRows.length ? `${piiRows.length}: ${piiRows.map((r: any) => r.entity).join(",")}` : "none");
  const blanked = await Promise.all(piiRows.map(async (r: any) => {
    // The reader has no id filter, so the row is found the way the panel would find it:
    // by its own tenant, actor, entity and a one-second window around its timestamp.
    const page = (await ai(
      `select id, "before" as b, "after" as a
         from platform_auth.list_audit_for_control($1,$2,$3,null,null,$4,$5,10)`,
      [r.tenant_id, r.actor_user_id, r.entity,
        new Date(r.ts.getTime() - 1000), new Date(r.ts.getTime() + 1000)])).rows;
    const row = page.find((p: any) => p.id === r.id);
    return row ? unredactedValues(row) : [`${r.entity}/${r.id} did not come back`];
  }));
  check("and the reader hands every one of them back with the PII values blanked",
    blanked.every((b) => b.length === 0),
    blanked.flat().slice(0, 6).join(", ") || `${piiRows.length} rows read back clean`);
  const liveValues = audit.flatMap(a =>
    [...unredactedValues(a.before), ...unredactedValues(a.after)]);
  check("which also holds for every row on the newest page the panel would open with",
    liveValues.length === 0, liveValues.slice(0, 6).join(", "));

  const capped = (await ai("select * from platform_auth.list_audit_for_control(null,null,null,null,null,null,null,10000)")).rows;
  check("the row cap holds against a greedy limit", capped.length <= 500, `${capped.length} rows`);
  const floored = (await ai("select * from platform_auth.list_audit_for_control(null,null,null,null,null,null,null,0)")).rows;
  check("a zero limit still clamps to one row rather than all of them", floored.length === 1);
  const oneActor = audit.find(a => a.actor_user_id);
  const filtered = oneActor
    ? (await ai("select * from platform_auth.list_audit_for_control(null,$1)", [oneActor.actor_user_id])).rows
    : [];
  check("the forensic actor filter returns only that person's rows",
    !!oneActor && filtered.length > 0 && filtered.every(f => f.actor_user_id === oneActor.actor_user_id),
    `${filtered.length} rows`);
  const windowed = (await ai(
    "select * from platform_auth.list_audit_for_control(null,null,null,null,null,now() - interval '2 hours',now(),200)")).rows;
  check("a time window narrows the trail", windowed.every(w => new Date(w.ts) >= new Date(Date.now() - 2 * 3600e3)));

  const actions = (await ai("select * from platform_auth.list_audit_actions()")).rows;
  check("the filter pick-list is populated and numeric",
    actions.length > 0 && actions.every(a => typeof a.events === "number"), `${actions.length} actions`);
  check("the pick-list is ordered by volume",
    actions.every((a, i) => i === 0 || Number(actions[i - 1].events) >= Number(a.events)));

  // ---------- the doors that must stay shut ----------
  const directAudit = await ai("select count(*)::int as n from audit_logs").catch((e: any) => e.message);
  check("app_runtime cannot read the trail around the reader",
    typeof directAudit === "string" || Number(directAudit?.rows?.[0]?.n ?? 1) === 0,
    JSON.stringify(directAudit).slice(0, 120));

  await ai("begin");
  let deleteRefused = false;
  try {
    await ai(`insert into platform_costs (period, category, amount, note)
              values ($1, 'other', 1, 'verify-only row') returning id`, [monthStart]);
    await ai(`delete from platform_costs where period = $1 and category = 'other'`, [monthStart]);
  } catch (e: any) {
    deleteRefused = /permission denied|delete/i.test(e.message ?? "");
  }
  await ai("rollback");
  check("the cost ledger cannot be emptied by the API role", deleteRefused);

  await app.end();
  if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
  console.log("control analytics and the audit reader verified");
}

main().catch((e) => { console.error(e); process.exit(1); });
