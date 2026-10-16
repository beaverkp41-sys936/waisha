/**
 * Step 8 — privilege-posture guard (spec security A/E, RULE 0).
 *
 * Two halves:
 *   1. catalog audit as the owner (MIGRATE_DATABASE_URL) — the shapes the API
 *      must never depend on: browser API roles (anon/authenticated) holding any
 *      right in the app's schemas, default privileges that would hand rights to
 *      every NEW object, SECURITY DEFINER functions reachable without a search
 *      path, PUBLIC-executable definer functions, tables published to realtime,
 *      and the append-only contract on audit_logs.
 *   2. live probes as app_runtime (the production API role) — deny-by-default
 *      RLS with no tenant GUC, and UPDATE/DELETE on audit_logs must be refused.
 *
 * Dev DATABASE_URL is usually the owner role, which bypasses RLS and would
 * false-positive every probe, so the app-role URL is rebuilt from .env parts
 * exactly as verify-isolation.ts does.
 * Run: npx tsx scripts/verify-privileges-sql.ts   (DNS_FALLBACK=1 if DNS broken)
 */
import "dotenv/config";
import pg from "pg";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label, detail.slice(0, 600)); }
}

const APP_SCHEMAS = ["public", "platform_auth"];
const BROWSER_ROLES = ["anon", "authenticated", "authenticator"];

function ownerUrl(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  return url;
}

/** app_runtime URL: dev hands us the owner URL, so rebuild it from APP_DB_PASSWORD. */
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
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();
  const oi = (sql: string, params: any[] = []) => owner.query(sql, params);

  // ---------- 1. catalog audit ----------
  const roleShape = (await oi(
    `select rolname, rolsuper, rolbypassrls, rolcanlogin from pg_roles
     where rolname in ('app_runtime','anon','authenticated','authenticator','service_role','postgres')`)).rows;
  const byName = Object.fromEntries(roleShape.map((r: any) => [r.rolname, r]));
  check("app_runtime exists, can login, is not superuser and does not bypass RLS",
    !!byName.app_runtime && !byName.app_runtime.rolsuper && !byName.app_runtime.rolbypassrls && byName.app_runtime.rolcanlogin,
    JSON.stringify(byName.app_runtime ?? {}));
  for (const r of ["anon", "authenticated"]) {
    check(`${r} cannot log in directly`, !!byName[r] && !byName[r].rolcanlogin, JSON.stringify(byName[r] ?? {}));
  }

  const browserIn = (col: string) => `${col} in (select oid from pg_roles where rolname = any($2::text[]))`;
  const leaked: any[] = (await oi(
    `select 'table' as kind, c.oid::regclass::text as obj, a.grantee::regrole::text as grantee,
            string_agg(distinct a.privilege_type, ',' order by a.privilege_type) as privs
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join lateral aclexplode(c.relacl) a
     where n.nspname = any($1::text[]) and c.relkind in ('r','p','S','v','m','f')
       and ${browserIn("a.grantee")}
     group by 1,2,3
     union all
     select 'function', p.oid::regprocedure::text, a.grantee::regrole::text,
            string_agg(distinct a.privilege_type, ',' order by a.privilege_type)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join lateral aclexplode(p.proacl) a
     where n.nspname = any($1::text[]) and ${browserIn("a.grantee")}
     group by 1,2,3`, [APP_SCHEMAS, BROWSER_ROLES])).rows;
  check("no browser API role holds a right on any app table, sequence, view or function",
    leaked.length === 0, leaked.map((l: any) => `${l.obj}:${l.grantee}:${l.privs}`).join(" | "));

  // A null proacl means the default EXECUTE-to-PUBLIC applies, so it counts too.
  const publicRights: any[] = (await oi(
    `select p.oid::regprocedure::text as fn
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any($1::text[]) and p.prosecdef
       and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))`,
    [APP_SCHEMAS])).rows;
  check("no SECURITY DEFINER function is executable by PUBLIC", publicRights.length === 0,
    publicRights.map((r: any) => r.fn).join(", "));

  const defLeak: any[] = (await oi(
    `select pg_get_userbyid(d.defaclrole) as for_role,
            coalesce(nullif(d.defaclnamespace,0)::regnamespace::text,'(whole database)') as ns,
            case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences'
              when 'f' then 'functions' else d.defaclobjtype end as kind
     from pg_default_acl d
     where pg_get_userbyid(d.defaclrole) = 'postgres'
       and coalesce(nullif(d.defaclnamespace,0)::regnamespace::text,'(whole database)') = any($1::text[])
       and exists (select 1 from aclexplode(d.defaclacl) a where ${browserIn("a.grantee")})`,
    [APP_SCHEMAS, BROWSER_ROLES])).rows;
  check("default privileges grant nothing to browser roles in the app schemas",
    defLeak.length === 0, defLeak.map((d: any) => `${d.for_role}/${d.ns}/${d.kind}`).join(", "));

  // supabase_admin still carries browser-role defaults for schema public and it
  // is not revoke-able from here (42501: must be owner of role supabase_admin).
  // That is only inert while every app object is owned by postgres, which is the
  // invariant asserted next — if it ever breaks, the defaults above must be
  // applied for that owner too.
  const foreignOwners: any[] = (await oi(
    `select 'relation' as kind, c.oid::regclass::text as obj, pg_get_userbyid(c.relowner) as owner
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1::text[]) and c.relkind in ('r','p','S','v','m','f')
       and pg_get_userbyid(c.relowner) <> 'postgres'
     union all
     select 'function', p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any($1::text[]) and pg_get_userbyid(p.proowner) <> 'postgres'`,
    [APP_SCHEMAS])).rows;
  check("every app-schema object is owned by postgres (the locked-down default role)",
    foreignOwners.length === 0, foreignOwners.map((f: any) => `${f.obj}:${f.owner}`).join(", "));

  const schemaUsage: any[] = (await oi(
    `select n.nspname, a.grantee::regrole::text as grantee
     from pg_namespace n cross join lateral aclexplode(n.nspacl) a
     where n.nspname = any($1::text[]) and ${browserIn("a.grantee")}
       and a.privilege_type in ('USAGE','CREATE')`, [APP_SCHEMAS, BROWSER_ROLES])).rows;
  check("browser roles have no USAGE/CREATE on the app schemas", schemaUsage.length === 0,
    JSON.stringify(schemaUsage));

  const badDefiner: any[] = (await oi(
    `select p.oid::regprocedure::text as fn
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any($1::text[]) and p.prosecdef
       and not (coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%')`,
    [APP_SCHEMAS])).rows;
  check("every SECURITY DEFINER function pins search_path", badDefiner.length === 0,
    badDefiner.map((r: any) => r.fn).join(", "));

  const published: any[] = (await oi(
    `select pt.pubname, pt.schemaname, pt.tablename from pg_publication_tables pt
     where pt.schemaname = any($1::text[])`, [APP_SCHEMAS])).rows;
  check("no app table is published to a logical replication/realtime publication",
    published.length === 0, published.map((p: any) => `${p.pubname}.${p.schemaname}.${p.tablename}`).join(", "));

  const rlsOff: any[] = (await oi(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity = false
       and exists (select 1 from information_schema.columns k
                   where k.table_schema='public' and k.table_name = c.relname and k.column_name = 'tenant_id')
       -- the audit partition child is unreachable by app_runtime (proved below)
       and c.relname <> 'audit_logs_default'`)).rows;
  check("RLS is enabled on every tenant table app_runtime can reach", rlsOff.length === 0,
    rlsOff.map((r: any) => r.relname).join(", "));

  const auditAcl = (await oi(
    `select relacl::text[] as acl from pg_class where relname = 'audit_logs'`)).rows[0]?.acl ?? [];
  const appEntry = String(auditAcl.find((a: string) => a.startsWith("app_runtime=")) ?? "");
  check("audit_logs: app_runtime holds INSERT+SELECT only (append-only)",
    appEntry === "app_runtime=ar/postgres", appEntry || JSON.stringify(auditAcl));
  const partAcl = (await oi(`select relacl::text[] as acl from pg_class where relname = 'audit_logs_default'`)).rows[0]?.acl ?? [];
  check("audit_logs_default partition is not granted to app_runtime or browser roles",
    !String(partAcl).includes("app_runtime") && !/anon|authenticated/.test(String(partAcl)),
    JSON.stringify(partAcl));

  await owner.end();

  // ---------- 2. live probes as app_runtime ----------
  const url = appUrl();
  if (!url) {
    console.log("SKIP app_runtime probes — set APP_DB_PASSWORD (or APP_DATABASE_URL) to run them");
  } else {
    const app = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await app.connect();
    const who = (await app.query(
      `select current_user as u, rolsuper, rolbypassrls from pg_roles where rolname = current_user`)).rows[0];
    check("probing as a non-bypassing role", !!who && !who.rolsuper && !who.rolbypassrls, JSON.stringify(who ?? {}));

    await app.query("select set_config('app.tenant_id', '', false)");
    const noCtx = await app.query("select count(*)::int as n from cargo_shipments").catch((e: any) => ({ err: e.message }));
    check("RLS denies every tenant row when no tenant context is set",
      (noCtx as any).rows?.[0]?.n === 0, JSON.stringify(noCtx).slice(0, 160));

    const forg = await app.query(`select set_config('app.tenant_id', '22222222-2222-4222-8222-222222222222', false)`);
    const fcount = await app.query("select count(*)::int as n from freight_invoices");
    check("a forged tenant id reads zero rows rather than erroring or leaking",
      !!forg.rowCount && fcount.rows[0].n === 0, JSON.stringify(fcount.rows[0]));

    const upd = await app.query("update audit_logs set action = 'tampered' where false").catch((e: any) => e);
    check("audit_logs rejects UPDATE as app_runtime", upd instanceof Error && (upd as any).code === "42501",
      upd instanceof Error ? String((upd as any).message).slice(0, 80) : "update allowed");
    const del = await app.query("delete from audit_logs where false").catch((e: any) => e);
    check("audit_logs rejects DELETE as app_runtime", del instanceof Error && (del as any).code === "42501",
      del instanceof Error ? String((del as any).message).slice(0, 80) : "delete allowed");

    // Catalog-side proof that the sequence lockdown cost the API nothing:
    // nextval needs more than SELECT, and burning an invoice number from a
    // read-only guard would be its own defect.
    const seqPriv = await app.query(
      `select has_sequence_privilege('app_runtime'::regrole, 'invoice_number_seq'::regclass, 'USAGE') as usage_ok`
    ).catch((e: any) => e);
    check("positive control: app_runtime keeps the rights nextval needs on invoice_number_seq",
      !(seqPriv instanceof Error) && (seqPriv as any).rows?.[0]?.usage_ok === true,
      seqPriv instanceof Error ? seqPriv.message.slice(0, 80) : JSON.stringify((seqPriv as any).rows[0]));

    // 051 revoked PUBLIC EXECUTE from every SECURITY DEFINER helper and
    // re-granted it to app_runtime — prove the API role kept its door. Read-only
    // helpers only: hit_rate_limit would write a rate_limits row that app_runtime
    // cannot clean up again (delete is deliberately not granted).
    const login = await app.query(
      `select platform_auth.lookup_transporter_login('no-such-hash', 'no-such-hash') as r`
    ).catch((e: any) => e);
    check("positive control: app_runtime can still call platform_auth.lookup_transporter_login",
      !(login instanceof Error) && login.rows?.[0]?.r === null,
      login instanceof Error ? login.message.slice(0, 80) : JSON.stringify(login.rows[0]));
    const lic = await app.query(
      `select platform_auth.get_licence('00000000-0000-4000-8000-000000000000') as l`
    ).catch((e: any) => e);
    check("positive control: app_runtime can still call platform_auth.get_licence",
      !(lic instanceof Error) && !!lic.rows?.length,
      lic instanceof Error ? lic.message.slice(0, 80) : "");

    await app.end();
  }

  console.log(failures ? `\n${failures} PRIVILEGE FINDINGS` : "\nprivilege posture clean");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
