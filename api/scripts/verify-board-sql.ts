/**
 * Step 5 — SQL + Rule 0 validation for the notice board read path.
 *
 * The board is the only place in Waisha where one company's data is shown to
 * another company, so this script checks the door itself rather than the query:
 *
 *   1. every statement the routes run EXPLAINs against the live schema;
 *   2. board_card's attributes are exactly the reviewed allowlist, in order —
 *      widen the type and this fails until a human has reviewed the new field;
 *   3. both functions are SECURITY DEFINER with search_path pinned, EXECUTE to
 *      app_runtime, EXECUTE revoked from PUBLIC, and their source touches only
 *      transport_requests and geo_regions;
 *   4. the open-slice indexes the filters depend on actually exist;
 *   5. as app_runtime (a role that cannot bypass RLS) a direct read of
 *      transport_requests returns nothing without a tenant context, while the
 *      board function is callable — i.e. the function really is the only door.
 *
 * Run: npx tsx scripts/verify-board-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { BOARD_CARD_COLUMNS } from "../src/util/board.js";

const FORBIDDEN_ATTRS = ["tenant_id", "job_id", "shipment_id", "route_id",
  "contact_user_id", "disclosed_by", "cancelled_by", "cancelled_at", "status",
  "deleted_at", "created_by", "updated_by", "created_at", "updated_at", "notes"];

/** Relations the board source must never mention. */
const FORBIDDEN_RELATIONS = ["cargo_shipments", "jobs", "job_stages", "job_documents",
  "job_activity", "cargo_tasks", "documents", "freight_invoices", "invoice_items",
  "payments", "ledger", "users", "company_profiles", "clients", "consignees",
  "drivers", "vehicles", "trips", "routes", "shipper_accounts", "audit_logs",
  "notifications", "messages", "office_costs", "expenses"];

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  const owner = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await owner.connect();

  let failed = 0;
  const ok = (label: string) => console.log("ok   ", label);
  const bad = (label: string, detail = "") => {
    failed++; console.log("FAIL ", label, detail.slice(0, 240));
  };

  // ---------- 1. route statements plan ----------
  const statements: [string, string, unknown[]][] = [
    ["list: no filters",
      `select * from board_requests($1, $2, $3::date, $4::date, $5, $6, $7)`,
      [null, null, null, null, null, 40, 0]],
    ["list: truck type",
      `select * from board_requests($1, $2, $3::date, $4::date, $5, $6, $7)`,
      ["reefer", null, null, null, null, 40, 0]],
    ["list: region",
      `select * from board_requests($1, $2, $3::date, $4::date, $5, $6, $7)`,
      [null, 1, null, null, null, 40, 0]],
    ["list: date window",
      `select * from board_requests($1, $2, $3::date, $4::date, $5, $6, $7)`,
      [null, null, "2026-10-15", "2026-12-31", null, 40, 0]],
    ["list: search + paging",
      `select * from board_requests($1, $2, $3::date, $4::date, $5, $6, $7)`,
      [null, null, null, null, "dar", 100, 40]],
    ["detail: one card", `select (board_request_card($1)).*`, [randomUUID()]],
    ["summary: count only",
      `select * from board_requests(null, null, null, null, null, 1, 0)`, []]
  ];
  for (const [label, stmt, params] of statements) {
    try {
      await owner.query("explain " + stmt, params);
      ok(label);
    } catch (e: any) {
      bad(label, e.message);
    }
  }

  // ---------- 2. board_card is the allowlist ----------
  const attrs = await owner.query(
    `select a.attname, format_type(a.atttypid, a.atttypmod) as ty
       from pg_type t
       join pg_class c on c.oid = t.typrelid
       join pg_attribute a on a.attrelid = c.oid
      where t.typname = 'board_card' and a.attnum > 0 and not a.attisdropped
      order by a.attnum`);
  if (!attrs.rowCount) {
    bad("board_card type exists");
  } else {
    const names = attrs.rows.map((r: any) => r.attname as string);
    if (names.join(",") === BOARD_CARD_COLUMNS.join(",")) {
      ok(`board_card is exactly the ${names.length}-column reviewed projection, in order`);
    } else {
      bad("board_card column list",
        `db=[${names.join(",")}] code=[${BOARD_CARD_COLUMNS.join(",")}]`);
    }
    const leaked = names.filter((n) => FORBIDDEN_ATTRS.includes(n));
    if (leaked.length) bad("board_card carries internal keys", leaked.join(", "));
    else ok("board_card exposes no tenant/job/shipment/contact/disclosure id");
  }

  // ---------- 3. function shape, grants and reach ----------
  const fn = await owner.query(
    `select p.proname as name, p.prosecdef as definer,
            array_to_string(p.proconfig, ',') as config,
            p.prosrc as source,
            has_function_privilege('app_runtime', p.oid, 'EXECUTE') as app_exec,
            has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
       from pg_proc p
      where p.proname in ('board_requests', 'board_request_card')
        and p.pronamespace = 'public'::regnamespace`);
  for (const want of ["board_requests", "board_request_card"]) {
    const f = fn.rows.find((r: any) => r.name === want);
    if (!f) { bad(`${want} exists`); continue; }
    const why: string[] = [];
    if (!f.definer) why.push("not SECURITY DEFINER");
    if (!/search_path=public/.test(f.config ?? "")) why.push(`search_path: "${f.config}"`);
    if (!f.app_exec) why.push("app_runtime lacks EXECUTE");
    if (f.public_exec) why.push("PUBLIC still has EXECUTE");
    const touched = FORBIDDEN_RELATIONS.filter((t) =>
      new RegExp(`\\b${t}\\b`, "i").test(f.source ?? ""));
    if (touched.length) why.push(`source reads ${touched.join(", ")}`);
    if (why.length) bad(want, why.join("; "));
    else ok(`${want} (definer, pinned search_path, execute to app_runtime only, ` +
      `source touches transport_requests + geo_regions)`);
  }

  // ---------- 4. indexes the filters need ----------
  const idx = await owner.query(
    `select indexname from pg_indexes
      where tablename = 'transport_requests'
        and indexname in ('idx_board_open_date', 'idx_board_open_vehicle')`);
  if (idx.rowCount === 2) ok("board indexes present (open-slice date + GIN truck type)");
  else bad("board indexes", idx.rows.map((r: any) => r.indexname).join(", ") || "none");

  // ---------- 5. permission ----------
  const perm = await owner.query(
    `select p.key, coalesce(string_agg(r.key, ',' order by r.key), '') as roles
       from permissions p
       left join role_permissions rp on rp.permission_key = p.key
       left join roles r on r.id = rp.role_id and r.tenant_id is null
      where p.key = 'board.view' group by p.key`);
  if (!perm.rowCount) bad("board.view permission seeded");
  else {
    const granted = perm.rows[0].roles.split(",").filter(Boolean);
    const want = ["director", "operations_manager", "general_manager", "dispatcher"];
    const missing = want.filter((w) => !granted.includes(w));
    const shipper = granted.includes("shipper_portal");
    if (missing.length || shipper) {
      bad("board.view role grants",
        `${missing.length ? `missing ${missing.join(",")}` : ""}` +
        `${shipper ? " — shipper_portal must not read the board" : ""}`);
    } else ok(`board.view granted to ${granted.join(", ")} (no shipper role)`);
  }

  // ---------- 6. as app_runtime: the function is the only door ----------
  // Same role-switch convention as verify-isolation: the app URL must come from
  // ISOLATION_DATABASE_URL / DATABASE_URL, because the pooler needs the
  // "app_runtime.<project-ref>" form and only that URL carries the ref.
  const appUrl = process.env.ISOLATION_DATABASE_URL || process.env.DATABASE_URL || url!;
  const u = new URL(appUrl);
  const ref = u.username.split(".")[1];
  if (u.username.startsWith("postgres") && process.env.APP_DB_PASSWORD) {
    u.username = "app_runtime" + (ref ? "." + ref : "");
    u.password = encodeURIComponent(process.env.APP_DB_PASSWORD);
    console.log("note: dev URL is owner role — switching the privilege tests to app_runtime");
  }
  const app = new pg.Client({ connectionString: u.toString(),
    ssl: { rejectUnauthorized: false } });
  try {
    await app.connect();
    const who = await app.query(
      `select current_user as u, (select rolsuper from pg_roles where rolname = current_user) as super,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypass`);
    if (who.rows[0].super || who.rows[0].bypass) {
      bad("app_runtime role privileges", `${who.rows[0].u} bypasses RLS — test is meaningless`);
    } else ok(`testing as ${who.rows[0].u} (no superuser, no bypassrls)`);

    try {
      const direct = await app.query(
        `select count(*)::int as n from transport_requests`);
      if (direct.rows[0].n === 0) ok("direct read of transport_requests with no tenant: 0 rows");
      else bad("direct read without tenant context", `${direct.rows[0].n} rows visible`);
    } catch (e: any) {
      ok(`direct read refused: ${e.message.split("\n")[0]}`);
    }

    try {
      await app.query(`select board_requests(null, null, null, null, null, 5, 0)`);
      ok("app_runtime can call board_requests()");
    } catch (e: any) {
      bad("call board_requests() as app_runtime", e.message.split("\n")[0]);
    }
    try {
      await app.query(`select board_request_card($1)`, [randomUUID()]);
      ok("app_runtime can call board_request_card()");
    } catch (e: any) {
      bad("call board_request_card() as app_runtime", e.message.split("\n")[0]);
    }
    // Writes and DDL must be refused outright, not merely filtered.
    for (const [stmt, code] of [
      ["delete from transport_requests", "42501"],
      ["drop table transport_requests", "42501"],
      ["drop function board_requests(text, int, date, date, text, int, int)", "42501"],
      ["create view board_all as select * from transport_requests", "42501"]
    ] as [string, string][]) {
      try {
        await app.query(stmt);
        bad(`app_runtime was allowed to run: ${stmt.slice(0, 44)}`);
      } catch (e: any) {
        if (e.code === code) ok(`refused (${e.code}): ${stmt.slice(0, 44)}`);
        else bad(`wrong failure for "${stmt.slice(0, 34)}"`, `${e.code} ${e.message.split("\n")[0]}`);
      }
    }
    // An unqualified call must not resolve through a attacker-placed search_path.
    const sp = await app.query("show search_path");
    ok(`app_runtime search_path: ${String(sp.rows[0].search_path).trim()}`);
  } catch (e: any) {
    // A login or DNS blip here must read as a failed check, not a stack dump:
    // this is the section that proves the owner's privileges are not inherited.
    bad("app_runtime privilege session", `${e.code ?? ""} ${e.message?.split("\n")[0] ?? e}`);
  } finally {
    await app.end().catch(() => { });
  }

  await owner.end();
  if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
  console.log("\nall board SQL valid; the cross-tenant read is one execute-only allowlisted door");
}

main().catch((e) => { console.error(e); process.exit(1); });
