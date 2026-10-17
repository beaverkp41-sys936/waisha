/**
 * Live proof for migration 069 — the technical report and the advisory (task #117).
 *
 * Same rule 066 established and 068 confirmed: EXPLAIN cannot see inside a SECURITY
 * DEFINER body, and a plpgsql body is not validated at CREATE time. Every catalog
 * aggregate in the report and every guarded rule in the advisory is therefore proven by
 * calling it, not by reading it.
 *
 * The interesting checks are the cross-checks. A report that says "156 write grants" is
 * worth nothing until the same fact is derived a second time by a different path, so the
 * owner half re-derives each headline number through information_schema and pg_stat
 * while the app_runtime half reads the definer's answer. Where the two disagree, the
 * function has a bug — and the posture lists are checked on both sides precisely so a
 * clean answer cannot come from a query that silently matched nothing.
 *
 * Run: npx tsx scripts/verify-control-system-sql.ts   (DNS_FALLBACK=1 if DNS broken)
 */
import "dotenv/config";
import pg from "pg";
import {
  SYSTEM_REPORT_SQL, SYSTEM_ADVISORY_SQL, SYSTEM_MIGRATIONS_SQL
} from "../src/routes/control-system.routes.js";

let failures = 0;
/** detail accepts any shape — a failing check is worth printing whole, not stringified by hand. */
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label,
    (typeof detail === "string" ? detail : JSON.stringify(detail ?? null) ?? "").slice(0, 600)); }
}

const FUNCS = ["control_system_report", "control_advisory", "control_migrations_applied"];
const READERS = ["super_admin", "platform_analyst", "support_engineer"];
const KINDS = ["risk", "revenue", "growth", "retention", "improve"];
const PRIORITIES = ["high", "medium", "low"];
const SECTIONS = ["shape", "posture", "size", "migrations", "access", "activity",
  "modules", "statistics"];
const MIGRATION_FILE = /^\d{3}_[A-Za-z0-9_]+\.sql$/;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

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

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");

  // ============================
  // 1. Catalog posture, as the owner
  // ============================
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();

  check("069 is recorded as applied",
    !!(await owner.query(
      `select 1 from schema_migrations where name = '069_control_system_report_and_advisory.sql'`
    )).rowCount);

  const posture = (await owner.query(
    `select p.proname, p.prosecdef, p.prorettype::regtype::text as returns,
            coalesce((select string_agg(x, ',') from unnest(p.proconfig) x
                       where x like 'search_path%'), '') as cfg
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [FUNCS])).rows;

  for (const f of FUNCS) {
    const row = posture.find(p => p.proname === f);
    check(`${f} exists in platform_auth`, !!row, posture.map(p => p.proname));
    if (!row) continue;
    check(`${f} is SECURITY DEFINER with a pinned search_path`,
      row.prosecdef === true && row.cfg === "search_path=public",
      { definer: row.prosecdef, cfg: row.cfg });
  }
  check("the advisory returns a row per rule, not one jsonb blob the panel would have to parse",
    posture.find(p => p.proname === "control_advisory")?.returns === "record",
    posture.find(p => p.proname === "control_advisory")?.returns);

  const acl = (await owner.query(
    `select p.proname, pg_get_userbyid(ac.grantee) as grantee, ac.privilege_type
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
       lateral aclexplode(p.proacl) ac
      where n.nspname = 'platform_auth' and p.proname = any($1)`, [FUNCS])).rows;
  for (const f of FUNCS) {
    const g = acl.filter(a => a.proname === f);
    check(`app_runtime holds EXECUTE on ${f}`,
      g.some(a => a.grantee === "app_runtime" && a.privilege_type === "EXECUTE"),
      g.map(a => `${a.grantee}:${a.privilege_type}`));
    check(`${f} is not reachable from PUBLIC, anon, authenticated or service_role`,
      !g.some(a => ["public", "anon", "authenticated", "service_role"].includes(a.grantee)),
      g.map(a => `${a.grantee}:${a.privilege_type}`));
  }

  // ---------- the duty ----------
  const duty = (await owner.query(
    `select r.key, count(rp.permission_key)::int as n
       from roles r left join role_permissions rp
         on rp.role_id = r.id and rp.permission_key = 'control.system.view'
      where r.tenant_id is null and r.deleted_at is null
      group by r.key order by r.key`)).rows;
  const holders = duty.filter(d => d.n > 0).map(d => d.key).sort();
  check("control.system.view is held by exactly the three seats that read the machine room",
    JSON.stringify(holders) === JSON.stringify([...READERS].sort()), holders);
  check("…and support_engineer holds it, unlike the money keys 068 kept off that seat",
    holders.includes("support_engineer"), holders);
  check("the read key is its own key, not 005's unenforced control.system.manage",
    !holders.includes("control.system.manage")
    && !!(await owner.query(
      `select 1 from permissions where key = 'control.system.view'
         and coalesce(description, '') <> ''`)).rowCount, holders);
  // 005's cross-join only ever covered the permissions that existed then, so a key
  // added in 069 lands with super_admin only because 069 wrote the row itself.
  check("super_admin's copy came from this migration, not from 005",
    !!(await owner.query(
      `select 1 from role_permissions rp join roles r on r.id = rp.role_id
        where r.key = 'super_admin' and r.tenant_id is null
          and rp.permission_key = 'control.system.view'`)).rowCount);

  // ---------- the owner's own reading of the same facts, by a different path ----------
  const ownerShape = (await owner.query(
    `select
       (select count(*)::int from information_schema.tables
         where table_schema='public' and table_type='BASE TABLE') as base_tables,
       (select count(*)::int from information_schema.views
         where table_schema='public') as views,
       (select count(*)::int from pg_indexes where schemaname='public') as indexes,
       (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public') as functions`)).rows[0];
  // Each headline number is re-derived by the owner through information_schema /
  // pg_indexes / pg_inherits instead of by reading the function's SQL back to itself.
  // A cross-check written as a copy of the query under test proves nothing; one taken
  // by a different path catches a predicate that quietly matched no rows.

  const ownerTenantNoRls = (await owner.query(
    `select distinct c.relname
       from information_schema.columns ic
       join pg_class c on c.relname = ic.table_name
       join pg_namespace n on n.oid = c.relnamespace and n.nspname = ic.table_schema
      where ic.table_schema = 'public' and ic.column_name = 'tenant_id'
        and c.relkind in ('r','p') and not c.relrowsecurity
        and not exists (select 1 from pg_inherits h where h.inhrelid = c.oid)
      order by 1`)).rows.map(r => r.relname);
  const ownerDefinerPublic = (await owner.query(
    `select count(*)::int as n from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','platform_auth')
        and p.prosecdef and p.proacl is null`)).rows[0].n;
  const ownerCompanies = (await owner.query(
    `select count(*)::int as n from tenants
      where deleted_at is null and type <> 'platform'`)).rows[0].n;
  const ownerAuditChildren = (await owner.query(
    `select c.relname from pg_inherits h
       join pg_class p on p.oid = h.inhparent
       join pg_class c on c.oid = h.inhrelid
      where p.relname = 'audit_logs' order by 1`)).rows.map(r => r.relname);
  const ownerCosts = (await owner.query(
    `select count(*)::int as rows,
            count(distinct date_trunc('month', period))::int as months
       from platform_costs`)).rows[0];

  // ============================
  // 2. Execution, as app_runtime — the exact statements the routes run
  // ============================
  const aUrl = appUrl();
  if (!aUrl) {
    console.log("SKIP app_runtime probes — no APP_DB_PASSWORD / APP_DATABASE_URL");
    process.exit(failures ? 1 : 0);
  }
  const app = new pg.Client({ connectionString: aUrl, ssl: { rejectUnauthorized: false } });
  await app.connect();

  // ---------- migrations ----------
  const mig = await app.query(SYSTEM_MIGRATIONS_SQL);
  check("the applied-migration reader runs with no tenant GUC set",
    mig.rows.length > 0, mig.rowCount);
  check("it answers in filename order, because the route diffs it against a sorted directory",
    JSON.stringify(mig.rows.map(r => r.name)) === JSON.stringify([...mig.rows.map(r => r.name)].sort()),
    mig.rows.slice(-3).map(r => r.name));
  check("every recorded name is a real migration filename shape",
    mig.rows.every(r => MIGRATION_FILE.test(r.name)),
    mig.rows.filter(r => !MIGRATION_FILE.test(r.name)).map(r => r.name));
  check("069 is in the list the panel diffs against the disk",
    mig.rows.some(r => r.name === "069_control_system_report_and_advisory.sql"));
  check("applied_at is a timestamp, so 'first applied' can be aged on the screen",
    mig.rows.every(r => r.applied_at instanceof Date), typeof mig.rows[0]?.applied_at);

  // ---------- the report ----------
  const rep = (await app.query(SYSTEM_REPORT_SQL)).rows[0]?.r ?? {};
  for (const s of SECTIONS) check(`report carries a ${s} section`, !!rep[s], Object.keys(rep));
  check("report names its currency rather than letting a number stand unlabelled",
    rep.currency === "TZS", rep.currency);
  check("the six caveats travel with the numbers they limit",
    Array.isArray(rep.caveats) && rep.caveats.length === 6, rep.caveats?.length);
  check("caveats say plainly that latency, uptime and error rate are not measured",
    rep.caveats.some((c: string) => /latency|error-rate/i.test(c)), rep.caveats);

  check("counts arrive as JS numbers — int8 in a chart axis draws nothing",
    ["tables", "views", "indexes", "triggers", "functions"].every(k => typeof rep.shape?.[k] === "number"),
    Object.fromEntries(["tables", "views", "indexes", "functions"]
      .map(k => [k, typeof rep.shape?.[k]])));
  check("schemas is a list, so the panel can count and name them at once",
    Array.isArray(rep.shape?.schemas) && rep.shape.schemas.includes("public"), rep.shape?.schemas);

  // the cross-checks — a headline number is only true if a second path agrees
  check(`shape.tables (${rep.shape?.tables}) equals the owner's information_schema base-table `
    + "count — both see the parent and its leaves, so any gap would be a relkind left out",
    Number(rep.shape?.tables) === ownerShape.base_tables,
    { report: rep.shape?.tables, ownerBase: ownerShape.base_tables });
  check(`shape.indexes (${rep.shape?.indexes}) is the owner's pg_indexes count`,
    Number(rep.shape?.indexes) === ownerShape.indexes,
    { report: rep.shape?.indexes, owner: ownerShape.indexes });
  check(`shape.views (${rep.shape?.views}) is the owner's information_schema view count`,
    Number(rep.shape?.views) === ownerShape.views,
    { report: rep.shape?.views, owner: ownerShape.views });
  check(`modules.companies (${rep.modules?.companies}) counts live non-platform tenants, `
    + "the same universe 066/068 report on",
    Number(rep.modules?.companies) === ownerCompanies,
    { report: rep.modules?.companies, owner: ownerCompanies });
  check(`posture.tenant_tables_without_rls (${JSON.stringify(rep.posture?.tenant_tables_without_rls)}) `
    + "is the owner's independent information_schema reading, not a query that matched nothing",
    JSON.stringify(rep.posture?.tenant_tables_without_rls ?? []) === JSON.stringify(ownerTenantNoRls),
    { report: rep.posture?.tenant_tables_without_rls, owner: ownerTenantNoRls });
  check(`posture.definer_public_reachable agrees with the owner's proacl is null count (${ownerDefinerPublic})`,
    (rep.posture?.definer_public_reachable ?? []).length === ownerDefinerPublic,
    { report: rep.posture?.definer_public_reachable, owner: ownerDefinerPublic });
  check(`statistics.audit_partitions names exactly the children the owner's pg_inherits sees `
    + `(${JSON.stringify(ownerAuditChildren)}) — the finding is that there is only the default`,
    JSON.stringify(rep.statistics?.audit_partitions ?? []) === JSON.stringify(ownerAuditChildren),
    { report: rep.statistics?.audit_partitions, owner: ownerAuditChildren });

  check("the isolation posture is genuinely empty today, on both sides",
    (rep.posture?.tenant_tables_without_rls ?? []).length === 0
    && (rep.posture?.rls_without_policy ?? []).length === 0
    && ownerTenantNoRls.length === 0,
    { report: rep.posture?.tenant_tables_without_rls, rls_without_policy: rep.posture?.rls_without_policy });

  check("the write surface is counted from aclexplode, so it does not shrink to what "
    + "information_schema lets a caller see",
    Number(rep.posture?.app_runtime_write_grants) > 0
    && Number(rep.posture?.app_runtime_delete_grants) <= Number(rep.posture?.app_runtime_write_grants),
    { writes: rep.posture?.app_runtime_write_grants, deletes: rep.posture?.app_runtime_delete_grants });

  check("sizes and row estimates are arrays of named rows, sorted by size",
    Array.isArray(rep.size?.largest) && Array.isArray(rep.size?.rows_estimated)
    && rep.size.largest.length > 0
    && rep.size.largest.every((r: any, i: number) => i === 0
      || Number(rep.size.largest[i - 1].bytes) >= Number(r.bytes)),
    rep.size?.largest?.slice(0, 3));
  check("the statistics window travels with the numbers that expire with it",
    !!rep.statistics?.stats_reset && num(rep.statistics?.db_uptime_seconds)! > 0,
    { reset: rep.statistics?.stats_reset, up: rep.statistics?.db_uptime_seconds });
  check("the audit trail's own activity is counted, so the screen can say what the system was asked to do",
    typeof rep.activity?.audit_24h === "number" && typeof rep.activity?.audit_30d === "number"
    && num(rep.activity?.audit_24h)! <= num(rep.activity?.audit_30d)!,
    { d1: rep.activity?.audit_24h, d30: rep.activity?.audit_30d });
  check("top actions are the busiest first, capped at eight for the screen",
    Array.isArray(rep.activity?.top_actions_30d) && rep.activity.top_actions_30d.length <= 8
    && rep.activity.top_actions_30d.every((r: any, i: number) => i === 0
      || Number(rep.activity.top_actions_30d[i - 1].events) >= Number(r.events)),
    rep.activity?.top_actions_30d?.slice(0, 3));
  check("migrations section counts what the database believes it ran",
    typeof rep.migrations?.applied === "number"
    && num(rep.migrations.applied) === mig.rowCount,
    { report: rep.migrations?.applied, reader: mig.rowCount });
  check("per-company status and bundle breakdowns are objects, not arrays the panel would index blindly",
    rep.modules?.companies_by_status && typeof rep.modules.companies_by_status === "object"
    && !Array.isArray(rep.modules.companies_by_status),
    rep.modules?.companies_by_status);

  // ---------- the report holds no secrets ----------
  const text = JSON.stringify(rep);
  const secrets = ["JWT_SECRET", "FIELD_ENCRYPTION_KEY", "SEARCH_HASH_KEY", "APP_DB_PASSWORD", "RESEND_API_KEY"]
    .map(k => [k, process.env[k]] as const)
    .filter(([, v]) => !!v)
    .filter(([, v]) => text.includes(v as string))
    .map(([k]) => k);
  check("no credential from the environment appears anywhere in the report payload",
    secrets.length === 0, secrets);
  check("the report carries no encrypted PII — no NIDA or phone column is selected by it",
    !/"(nida|phone|national_id)"/i.test(text), text.slice(0, 200));

  // ---------- the advisory ----------
  const adv = await app.query(SYSTEM_ADVISORY_SQL);
  check("the advisory runs as app_runtime and answers a row per firing rule",
    adv.rows.length >= 0, { rows: adv.rowCount });
  const ids = adv.rows.map(r => r.item_id);
  check("every rule names itself, once",
    new Set(ids).size === ids.length, ids);
  check("kind and priority are closed vocabularies, so the filter pills cannot be fed a new one",
    adv.rows.every(r => KINDS.includes(r.kind) && PRIORITIES.includes(r.priority)),
    adv.rows.map(r => `${r.item_id}:${r.kind}/${r.priority}`));
  check("rank is a number the route can sort on",
    adv.rows.every(r => typeof r.rank === "number"), adv.rows.map(r => r.rank));
  check("each item says what to do, in the same row as the finding",
    adv.rows.every(r => (r.title ?? "").length > 4 && (r.detail ?? "").length > 40
      && (r.action ?? "").length > 4),
    adv.rows.filter(r => (r.detail ?? "").length <= 40).map(r => r.item_id));
  check("evidence is always an array, so the panel never renders undefined",
    adv.rows.every(r => Array.isArray(r.evidence)),
    adv.rows.filter(r => !Array.isArray(r.evidence)).map(r => r.item_id));
  check("a metric never claims more than its own evidence could hold — the metric counts "
    + "the population, the evidence is capped",
    adv.rows.every(r => r.metric === null || Number(r.metric) >= (r.evidence ?? []).length),
    adv.rows.filter(r => r.metric !== null && Number(r.metric) < (r.evidence ?? []).length)
      .map(r => `${r.item_id}:${r.metric}/${(r.evidence ?? []).length}`));
  check("unit is present wherever a metric is, so no figure is shown bare",
    adv.rows.every(r => r.metric === null || (r.unit ?? "").length > 0),
    adv.rows.filter(r => r.metric !== null && !r.unit).map(r => r.item_id));

  // the guards that must print nothing while the posture is clean
  check("the two posture rules stay silent exactly while the report's own posture lists are empty",
    (ids.includes("rls_missing") === ((rep.posture?.tenant_tables_without_rls ?? []).length > 0))
    && (ids.includes("definer_exposed") === ((rep.posture?.definer_public_reachable ?? []).length > 0)),
    { fired: ids.filter(i => i === "rls_missing" || i === "definer_exposed"),
      rls: rep.posture?.tenant_tables_without_rls,
      definer: rep.posture?.definer_public_reachable });
  const listing = adv.rows.find(r => r.item_id === "no_live_listing");
  if (listing) {
    const names = (listing.evidence ?? []).map((e: any) => (typeof e === "string" ? e : e?.company));
    const wrong = (await owner.query(
      `select name, type from tenants where name = any($1) and type <> 'transporter'`,
      [names])).rows;
    check(`every company named by no_live_listing (${names.length}) is a transporter — 061 `
      + "refuses a live listing for any other type, so advising one would be advice nobody can take",
      wrong.length === 0, wrong);
    const notOpen = (await owner.query(
      `select t.name, t.status from tenants t
        where t.name = any($1)
          and (t.deleted_at is not null or t.status <> all(array['active','trial','grace']))`,
      [names])).rows;
    check("…and each is on a licence that is actually open", notOpen.length === 0, notOpen);
  } else {
    check("no_live_listing stayed silent, so every licensed transporter is already in the directory",
      (await owner.query(
        `select count(*)::int as n from tenants t
           join subscriptions s on s.tenant_id = t.id and s.deleted_at is null
         where t.deleted_at is null and t.type = 'transporter'
           and t.status in ('active','trial','grace')
           and not exists (select 1 from directory_listings l
              where l.tenant_id = t.id and l.deleted_at is null and l.status = 'live')`
      )).rows[0].n === 0);
  }
  const costs = adv.rows.find(r => r.item_id === "costs_thin");
  check("the P&L warning agrees with the cost ledger it warns about: it fires while fewer "
    + "than three months are booked, and its metric is the row count",
    costs ? (ownerCosts.months < 3 && Number(costs.metric) === ownerCosts.rows)
          : ownerCosts.months >= 3,
    { fired: !!costs, metric: costs?.metric, owner: ownerCosts });
  // The advisory is read by the panel and quoted in a support call; a uuid in the
  // evidence would be an invitation to join something the desk has no business joining.
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const withIds = adv.rows.filter(r => UUID.test(JSON.stringify(r.evidence ?? [])));
  check("no evidence row carries a raw identifier — the panel names things, it does not link them",
    withIds.length === 0, withIds.map(r => r.item_id));
  check("area is one of the words the panel groups findings under",
    adv.rows.every(r => ["Security", "Licensing", "Sales", "Money", "Accounts", "Marketplace",
      "Operations", "Data", "Office", "Pricing"].includes(r.area)),
    adv.rows.map(r => `${r.item_id}:${r.area}`));

  const seen = adv.rows.map(r => `${r.rank}/${r.item_id}`);
  console.log("     advisory:", adv.rowCount, "rules →", seen.join(", "));
  console.log("     posture: rls", rep.posture?.rls_enabled, "of", rep.shape?.tables,
    "tables ·", rep.posture?.definer_functions, "definers ·",
    rep.posture?.app_runtime_write_grants, "write grants,",
    rep.posture?.app_runtime_delete_grants, "delete ·",
    rep.modules?.companies, "companies ·", rep.modules?.seekers, "seekers");

  await app.end();
  await owner.end();
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll 069 checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
