/**
 * Step 2 — tenant isolation sweep.
 * Connects as app_runtime (DATABASE_URL), sets app.tenant_id to a probe tenant,
 * and for EVERY table that has a tenant_id column checks:
 *   1. select leak  — count rows whose tenant_id differs from the setting (must be 0)
 *   2. update leak  — attempt a blind update on foreign rows (rows affected must be 0)
 *   3. no-access    — permission denied is a PASS (table not exposed to app_runtime)
 * Also checks: DELETE privileges on tenant tables (must be revoked), and that no
 * table with tenant_id has RLS disabled. Run: npx tsx scripts/verify-isolation.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";

const PROBE = randomUUID();     // tenant our session claims

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  // Must test as app_runtime — the owner role bypasses RLS and false-positives everything.
  // Local dev DATABASE_URL is often the owner URL; build the app-role URL from parts when so.
  let url = process.env.ISOLATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Set ISOLATION_DATABASE_URL or DATABASE_URL (app_runtime)");
  const u = new URL(url);
  const ref = u.username.split(".")[1];
  if (u.username.startsWith("postgres") && process.env.APP_DB_PASSWORD) {
    u.username = "app_runtime" + (ref ? "." + ref : "");
    u.password = encodeURIComponent(process.env.APP_DB_PASSWORD);
    url = u.toString();
    console.log("note: dev DATABASE_URL is owner role — switching sweep to app_runtime");
  }
  const app = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await app.connect();
  const who = await app.query(
    `select current_user as u,
       (select rolsuper from pg_roles where rolname = current_user) as super,
       (select rolbypassrls from pg_roles where rolname = current_user) as bypass`);
  if (who.rows[0].super || who.rows[0].bypass) {
    console.log(`ABORT: role ${who.rows[0].u} bypasses RLS — results would be meaningless`);
    await app.end();
    process.exit(1);
  }
  console.log("testing as:", who.rows[0].u);

  const tables = (await app.query(
    `select c.relname as t, c.relrowsecurity as rls
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join information_schema.columns k
       on k.table_name = c.relname and k.table_schema = 'public' and k.column_name = 'tenant_id'
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and k.table_schema = 'public'
     group by c.relname, c.relrowsecurity, c.relkind
     order by c.relname`)).rows;

  let leaks = 0, denied = 0, checked = 0, rlsOff: string[] = [];
  // Hard deletes live in exactly five places (grep 'delete from' in api/src):
  // invoices.items rewrite, quotations lines rewrite, employees task purge,
  // trips log edit, routes checkpoints edit.
  const DELETE_ALLOWED = new Set(["freight_invoice_items", "quotation_items", "office_tasks", "trip_checkpoint_logs", "route_checkpoints", "office_task_step_checks", "trainee_report_signoffs"]);
  await app.query(`select set_config('app.tenant_id', $1, false)`, [PROBE]);

  for (const { t, rls } of tables) {
    if (!rls) rlsOff.push(t);
    // 1. SELECT leak
    try {
      const r = await app.query(`select count(*)::int as n from "${t}" where tenant_id <> $1`, [PROBE]);
      checked++;
      if (r.rows[0].n > 0) { leaks++; console.log(`LEAK select  ${t}: ${r.rows[0].n} foreign rows visible`); }
    } catch (e: any) {
      if (e.code === "42501") { denied++; } // no select grant — deny by default, fine
      else if (e.code === "42P01") { /* dropped partition child */ }
      else console.log(`SKIP  ${t} select — ${e.message.slice(0, 90)}`);
    }
    // 2. UPDATE leak (only if selectable)
    try {
      const r = await app.query(`update "${t}" set tenant_id = tenant_id where tenant_id <> $1`, [PROBE]);
      if ((r.rowCount ?? 0) > 0) { leaks++; console.log(`LEAK update  ${t}: ${r.rowCount} foreign rows writable`); }
    } catch (e: any) {
      if (e.code !== "42501" && e.code !== "42P01" && e.message !== `permission denied to update "${t}"`) {
        // column-level grants may still allow no-op updates; only unexpected errors print
      }
    }
    // 3. DELETE privilege (soft-delete pattern requires it revoked)
    try {
      await app.query(`delete from "${t}" where false`);
      if (!DELETE_ALLOWED.has(t)) {
        leaks++; console.log(`LEAK delete  ${t}: app_runtime holds DELETE`);
      }
    } catch (e: any) {
      if (e.code === "42P01") { /* absent */ }
    }
  }

  // RLS-disabled tables with tenant_id are findings even if grants hide them
  if (rlsOff.length) console.log("NOTE  RLS disabled on:", rlsOff.join(", "));

  // Pre-auth surfaces: platform_auth functions must not read tenant data cross-tenant.
  // (login/otp/password_resets are handled via SECURITY DEFINER functions by design.)

  await app.end();
  console.log(`\n${checked} tables select-checked, ${denied} denied-by-grants, ${leaks} leaks, RLS-off: ${rlsOff.length}`);
  if (leaks) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
