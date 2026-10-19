/**
 * Live proof for #172 — the three registers migration 092 opened (assignment register,
 * position ledger, per-plate logbook) and the tenant pairing 093 added to them.
 *
 * The rule this platform has learned the hard way (066, 082, 085): a grant list read out of the
 * catalog is a *claim* until something tries to write through it. Everything that makes 092
 * worth having is a claim of that kind — "the ledger cannot be edited", "one driver per vehicle
 * while the row is open", "a position cannot be in the future", "a handover pairs two halves of
 * one company". So the posture half is read out of the catalog as the owner, and the execution
 * half writes real rows and reads them back.
 *
 * Both write halves roll back. These are live tables the portal writes into, and a verification
 * run has no business leaving a probe truck in someone's fleet or a fake fix on someone's map.
 * That is also why the counts are compared against stamps and markers rather than against zero:
 * an API beside this script can open a handover at any moment.
 *
 * Run: DNS_FALLBACK=1 npx tsx scripts/verify-fleet-ops-sql.ts
 */
import "dotenv/config";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  CORRIDOR_BOX, inCorridorBox, insertPosition, mirrorScalarAssignment, recordTripLegPosition
} from "../src/operations/fleet.js";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label,
    (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500)); }
}

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

const TABLES = ["vessel_assignments", "vessel_positions", "vessel_log_entries"];

/** The pooler occasionally answers the first app_runtime handshake with 28P01 when the owner
 *  connection has been busy, and a gate that stops for that reason teaches nobody anything. */
async function connectRuntime(url: string): Promise<pg.Client> {
  let last: any = null;
  for (let i = 0; i < 3; i++) {
    const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      return client;
    } catch (e) {
      last = e;
      await client.end().catch(() => { });
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw last;
}

/** Constraint and index definitions come back with type casts, capitals and parentheses no
 *  human wrote. Stripping the casts and the case is what lets a test say what the migration
 *  said, in the same words. Single quotes are kept: they mark the literals worth naming. */
const norm = (s: unknown) =>
  String(s).replace(/::[a-z_0-9]+(\([^)]*\))?/gi, "").replace(/\s+/g, " ").trim().toLowerCase();
const n = (v: any) => (v === null || v === undefined ? NaN : Number(v));

/** The elements of a `check (col = any (array['a','b',…]))` definition. */
function enumValues(def: string): string[] {
  const m = def.match(/array\[([^\]]*)\]/);
  if (!m) return [];
  return m[1].split(",").map((x) => x.trim().replace(/^'|'$/g, "")).filter(Boolean);
}

/** One stamp per run so a probe line can never be mistaken for a dispatcher's real truck. */
const STAMP = "92v" + Date.now().toString(36);
const MARK = `092 verify ${STAMP}`;

/** Coordinates inside the corridor the platform plans, and one pair outside it. */
const DAR = { lat: -6.800000, lng: 39.283333 };
const KIGALI = { lat: -1.953258, lng: 30.062677 };
const OUTSIDE = { lat: -30.5, lng: 35.0 };

async function main() {
  if (process.env.DNS_FALLBACK) await import("./util/dns-fallback.js");
  const owner = new pg.Client({ connectionString: ownerUrl(), ssl: { rejectUnauthorized: false } });
  await owner.connect();
  const asClient = owner as any;

  // ================================================================
  console.log("\n--- 1 · the three registers as the catalog actually describes them ---");

  const shape = await owner.query(
    `select c.relname, c.relrowsecurity,
            (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
            has_table_privilege('app_runtime', c.oid, 'select') as s,
            has_table_privilege('app_runtime', c.oid, 'insert') as i,
            has_table_privilege('app_runtime', c.oid, 'update') as u,
            has_table_privilege('app_runtime', c.oid, 'delete') as d,
            has_table_privilege('app_runtime', c.oid, 'truncate') as t
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1) and c.relkind = 'r'
      order by c.relname`, [TABLES]);
  const priv = (name: string) => shape.rows.find((r) => r.relname === name) as any;
  check("all three registers exist", shape.rows.length === 3, shape.rows.map((r) => r.relname));
  for (const t of shape.rows) {
    check(`${t.relname}: row security on and exactly one policy`,
      t.relrowsecurity === true && Number(t.policies) === 1, t);
    check(`…and no delete and no truncate for the application role — 041's house rule still holds`,
      t.s === true && t.i === true && t.d === false && t.t === false, t);
  }

  // Supabase's default privileges hand every new public table to service_role, and that role does
  // carry BYPASSRLS — so the honest claim is not "nobody but app_runtime can touch these tables"
  // but "no role a browser can present can, and the platform key is held exactly as tightly (and
  // loosely) as it is on drivers and vessels, and no API code ever connects with it".
  const grants = await owner.query(
    `select table_name as tbl, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
       from information_schema.table_privileges
      where table_schema = 'public' and grantee in ('public','anon','authenticated','service_role')
        and table_name = any($1) group by 1,2 order by 1,2`,
    [[...TABLES, "drivers", "vessels"]]);
  check("no grant to public, anon or authenticated — the roles a request could ever arrive as",
    !grants.rows.some((r) => r.grantee !== "service_role"),
    grants.rows.filter((r) => r.grantee !== "service_role"));
  const svc = (t: string) => grants.rows.find((r) => r.tbl === t && r.grantee === "service_role")?.privs;
  check("…and the platform's service_role hold is the same one every other tenant table carries",
    TABLES.every((t) => svc(t) === svc("drivers") && svc(t) === svc("vessels")),
    { registers: TABLES.map((t) => svc(t)), drivers: svc("drivers"), vessels: svc("vessels") });
  // The asymmetry 092's header makes the whole argument about, read out of the catalog.
  check("the position ledger is insert-and-read only: no UPDATE for the application role either",
    priv("vessel_positions")?.u === false
    && priv("vessel_assignments")?.u === true && priv("vessel_log_entries")?.u === true,
    { positions: priv("vessel_positions"), assignments: priv("vessel_assignments") });

  const pols = await owner.query(
    `select tablename, policyname, cmd, roles, qual, with_check
       from pg_policies where tablename = any($1) order by tablename`, [TABLES]);
  // What the catalog actually stores for 092's policy, cast and all:
  //   (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
  const TENANT_EXPR =
    /tenant_id = \(nullif\(current_setting\('app\.tenant_id', true\), ''\)\)/;
  check("every register is scoped to the tenant in both directions — read and write",
    TABLES.every((t) => {
      const p = pols.rows.find((r) => r.tablename === t) as any;
      if (!p) return false;
      return p.cmd === "ALL" && p.roles === "{app_runtime}" && TENANT_EXPR.test(norm(p.qual))
        && norm(p.qual) === norm(p.with_check);
    }), pols.rows.map((r) => ({ t: r.tablename, cmd: r.cmd, roles: r.roles, qual: norm(r.qual) })));

  const idx = await owner.query(
    `select tablename, indexname, indexdef from pg_indexes where schemaname = 'public'
       and tablename = any($1) order by tablename, indexname`, [TABLES]);
  const defsOf = (t: string) => idx.rows.filter((r) => r.tablename === t)
    .map((r) => norm(r.indexdef));
  const uniquesOf = (t: string) =>
    defsOf(t).filter((d) => d.includes("unique") && !d.includes("_pkey"));
  const aDefs = defsOf("vessel_assignments");
  check("the register's two open-row guards are partial uniques on (tenant, vehicle) and (tenant, driver)",
    aDefs.some((d) => d.includes("unique") && /\(tenant_id, vessel_id\)/.test(d)
      && /status = 'active'/.test(d) && /deleted_at is null/.test(d))
    && aDefs.some((d) => d.includes("unique") && /\(tenant_id, driver_id\)/.test(d)
      && /status = 'active'/.test(d) && /deleted_at is null/.test(d)), aDefs);
  check("…and every guard on the register is partial, so a closed or retired row frees the key",
    uniquesOf("vessel_assignments").length === 2
    && uniquesOf("vessel_assignments").every((d) => / where /.test(d)),
    uniquesOf("vessel_assignments"));
  check("the ledger is indexed for the only two reads it has, and holds no unique key at all",
    defsOf("vessel_positions").some((d) => /\(vessel_id, recorded_at desc\)/.test(d))
    && defsOf("vessel_positions").some((d) => /\(tenant_id, recorded_at desc\)/.test(d))
    && defsOf("vessel_positions").some((d) => /\(trip_id\)/.test(d) && /trip_id is not null/.test(d))
    && uniquesOf("vessel_positions").length === 0, defsOf("vessel_positions"));
  check("the logbook is indexed per plate by date, and only over live lines",
    defsOf("vessel_log_entries").some((d) => /\(vessel_id, entry_date desc\)/.test(d)
      && /deleted_at is null/.test(d))
    && defsOf("vessel_log_entries").some((d) => /\(tenant_id\)/.test(d)
      && /deleted_at is null/.test(d)), defsOf("vessel_log_entries"));

  const cons = await owner.query(
    `select rel.relname as tbl, con.conname, con.contype, pg_get_constraintdef(con.oid) as def
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace ns on ns.oid = rel.relnamespace
      where ns.nspname = 'public' and rel.relname = any($1) order by 1, 4`, [TABLES]);
  const list = (tbl: string, type: string) =>
    cons.rows.filter((r) => r.tbl === tbl && r.contype === type).map((r) => norm(r.def));
  const chk = (tbl: string, re: RegExp) => list(tbl, "c").some((d) => re.test(d));
  const findDef = (tbl: string, re: RegExp) => list(tbl, "c").find((d) => re.test(d)) ?? "";

  check("the register cannot be half-closed: active is exactly the same fact as ended_at is null",
    chk("vessel_assignments", /\(\(status = 'active'\) = \(ended_at is null\)\)/),
    list("vessel_assignments", "c"));
  check("the ledger bounds the planet on both axes",
    /\(lat >= \('-90'\)\) and \(lat <= \(90\)\)/.test(findDef("vessel_positions", /\blat\b/))
    && /\(lng >= \('-180'\)\) and \(lng <= \(180\)\)/.test(findDef("vessel_positions", /\blng\b/)),
    list("vessel_positions", "c"));
  check("…refuses a negative accuracy or reading…",
    chk("vessel_positions", /accuracy_m is null\) or \(accuracy_m >= 0/)
    && chk("vessel_positions", /odometer_km is null\) or \(odometer_km >= 0/),
    list("vessel_positions", "c"));
  check("…and refuses a report in the future, with the ten-minute tolerance the route also uses",
    /recorded_at <= \(now\(\) \+ '00:10:00'\)/.test(
      findDef("vessel_positions", /recorded_at <= /)),
    findDef("vessel_positions", /recorded_at/));
  const sourceDef = findDef("vessel_positions", /source = any/);
  check("a position has to name one of exactly four ways it can be known",
    ["device", "manual", "trip_departure", "trip_arrival"].join() === enumValues(sourceDef).join(),
    sourceDef);
  const kindDef = findDef("vessel_log_entries", /kind = any/);
  check("the logbook knows exactly seven kinds of line",
    ["note", "odometer", "service", "inspection", "paperwork", "movement", "damage"].join()
    === enumValues(kindDef).join(), kindDef);
  check("a journal line cannot be titled with whitespace alone",
    chk("vessel_log_entries", /char_length\(trim\(both from title\)\) > 0/),
    list("vessel_log_entries", "c"));
  check("an odometer entry without a reading is refused by the database, not only by the route",
    chk("vessel_log_entries", /\(kind <> 'odometer'\) or \(odometer_km is not null\)/),
    list("vessel_log_entries", "c"));

  // 093's whole point: a handover is a pair, and both halves have to be the same company's.
  const fkeys = TABLES.flatMap((t) => list(t, "f"));
  check("every register is bound to its company on both halves — vehicle, driver, trip",
    fkeys.some((d) => /foreign key \(vessel_id, tenant_id\) references vessels\(id, tenant_id\)/.test(d))
    && fkeys.some((d) => /foreign key \(driver_id, tenant_id\) references drivers\(id, tenant_id\)/.test(d))
    && fkeys.some((d) => /foreign key \(trip_id, tenant_id\) references trips\(id, tenant_id\)/.test(d))
    && ["vessel_assignments", "vessel_positions", "vessel_log_entries"]
      .every((t) => list(t, "f").some((d) => /references vessels\(id, tenant_id\)/.test(d))), fkeys);
  const parentIdx = await owner.query(
    `select tablename, indexdef from pg_indexes where schemaname = 'public'
       and tablename in ('drivers','vessels','trips')`);
  check("…which needed a (id, tenant_id) unique key on each parent, and nothing else on them moved",
    ["drivers", "vessels", "trips"].every((t) =>
      parentIdx.rows.filter((r) => r.tablename === t)
        .map((r) => norm(r.indexdef))
        .some((d) => d.includes("unique index") && /\(id, tenant_id\)/.test(d))),
    parentIdx.rows.filter((r) => /\(id, tenant_id\)/.test(norm(r.indexdef)))
      .map((r) => r.tablename));

  // Money deliberately does not live in the logbook (092's header, and #185's reason for
  // existing). A column list is the only way to prove the absence.
  const logCols = await owner.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'vessel_log_entries' order by ordinal_position`);
  const moneyish = logCols.rows.map((r) => r.column_name)
    .filter((c) => /cost|amount|price|shilling|litre|total|charge|fee/.test(c));
  check("the logbook holds no money column at all, so a cost figure has exactly one home",
    moneyish.length === 0, { moneyish, cols: logCols.rows.map((r) => r.column_name) });
  const posCols = await owner.query(
    `select column_name, numeric_precision, numeric_scale from information_schema.columns
      where table_schema = 'public' and table_name = 'vessel_positions'
        and column_name in ('lat','lng')`);
  check("a stored fix is carried to six decimals, which is the honest resolution of a phone GPS",
    posCols.rows.length === 2
    && posCols.rows.every((r) => Number(r.numeric_precision) === 9 && Number(r.numeric_scale) === 6),
    posCols.rows);

  // ================================================================
  console.log("\n--- 2 · the duties that hold the tracking module ---");

  const duty = await owner.query(
    `select p.key, coalesce(string_agg(r.key, ',' order by r.key), '(no role)') as roles
       from permissions p
       left join role_permissions rp on rp.permission_key = p.key
       left join roles r on r.id = rp.role_id and r.tenant_id is null
      where p.key like 'tracking.%'
      group by p.key order by p.key`);
  const held = (key: string) => String((duty.rows.find((r) => r.key === key)?.roles) ?? "").split(",");
  check("tracking.view and tracking.create exist and reach every seat that runs a fleet",
    ["director", "general_manager", "operations_manager", "fleet_manager", "dispatcher", "auditor"]
      .every((role) => held("tracking.view").includes(role) && held("tracking.create").includes(role)),
    duty.rows);
  check("a driver reports where the truck is and cannot read the fleet's whole trail",
    held("tracking.create").includes("driver") && !held("tracking.view").includes("driver"),
    duty.rows.filter((r) => /^tracking\.(view|create)$/.test(r.key)));
  // 002's matrix seeded tracking.edit/delete/approve/export long before this module had any data
  // behind it, and a director still holds them. That is harmless for exactly one reason, proved
  // twice above and once in section 5: the ledger has no edit or delete path for anyone.
  check("the older edit/delete duties are still seeded, and the grant — not the seat — is what stops them",
    duty.rows.some((r) => r.key === "tracking.delete") && priv("vessel_positions")?.u === false
    && priv("vessel_positions")?.d === false,
    duty.rows.filter((r) => /delete|edit/.test(r.key)));

  const seats = await owner.query(
    `with h as (
       select ur.user_id,
              bool_or(rp.permission_key = 'fleet.edit') as fe,
              bool_or(rp.permission_key = 'tracking.view') as tv,
              bool_or(rp.permission_key = 'tracking.create') as tc
         from user_roles ur join role_permissions rp on rp.role_id = ur.role_id
        group by 1)
     select count(*) filter (where fe and not tv) as blind_editors,
            count(*) filter (where tv and not tc) as read_only_trackers,
            count(*) as seats from h`);
  check("no live seat can edit the fleet yet be unable to see the map it just changed",
    n(seats.rows[0].blind_editors) === 0, seats.rows[0]);
  console.log("note  seats that can see the trail but not file one:",
    seats.rows[0].read_only_trackers, "of", seats.rows[0].seats,
    "— by 092's design, a viewer watches and a dispatcher reports.");

  // ================================================================
  console.log("\n--- 3 · the backfill, measured against the scalar it was meant to copy ---");

  const back = await owner.query(
    `with want as (
       select d.id as driver_id, d.assigned_vessel_id as vessel_id
         from drivers d join vessels v on v.id = d.assigned_vessel_id
          and v.tenant_id = d.tenant_id and v.deleted_at is null
        where d.deleted_at is null and d.assigned_vessel_id is not null
          and (select count(*) from drivers o
                where o.assigned_vessel_id = d.assigned_vessel_id and o.deleted_at is null) = 1),
       shared as (
       select count(distinct d.assigned_vessel_id)::int as n from drivers d
        where d.deleted_at is null and d.assigned_vessel_id is not null
          and (select count(*) from drivers o
                where o.assigned_vessel_id = d.assigned_vessel_id and o.deleted_at is null) > 1)
     select (select count(*)::int from want) as pairs,
            (select count(*)::int from (
               select 1 from want w where not exists (
                 select 1 from vessel_assignments a
                  where a.driver_id = w.driver_id and a.vessel_id = w.vessel_id
                    and a.status = 'active' and a.deleted_at is null)) m) as missing,
            (select n from shared) as shared_vehicles,
            (select count(*)::int from drivers
              where deleted_at is null and assigned_vessel_id is not null) as scalar_drivers,
            (select count(*)::int from vessel_assignments
              where status = 'active' and deleted_at is null) as open_rows,
            (select count(*)::int from vessel_assignments) as all_rows`);
  const b = back.rows[0];
  check("every unambiguous scalar pair is in the register — nothing was quietly dropped",
    n(b.missing) === 0 && n(b.open_rows) >= n(b.pairs), b);
  check("…and every claimed vehicle is either copied or counted as shared, never given an invented winner",
    n(b.pairs) + n(b.shared_vehicles) <= n(b.scalar_drivers), b);
  const integrity = await owner.query(
    `select (select count(*)::int from vessel_assignments a
              left join vessels v on v.id = a.vessel_id and v.tenant_id = a.tenant_id
              left join drivers d on d.id = a.driver_id and d.tenant_id = a.tenant_id
             where a.deleted_at is null and (v.id is null or d.id is null)) as cross_or_orphan,
            (select count(*)::int from (
               select vessel_id from vessel_assignments
                where status = 'active' and deleted_at is null
                group by 1 having count(*) > 1) x) as doubled_vehicles,
            (select count(*)::int from (
               select driver_id from vessel_assignments
                where status = 'active' and deleted_at is null
                group by 1 having count(*) > 1) y) as doubled_drivers,
            (select count(*)::int from vessel_assignments
              where (status = 'active') <> (ended_at is null)) as half_closed,
            (select count(*)::int from vessel_assignments a
              join drivers d on d.id = a.driver_id
             where a.status = 'active' and a.deleted_at is null
               and d.assigned_vessel_id is distinct from a.vessel_id) as scalar_disagrees`);
  check("the register that exists is consistent: no orphan, no truck in two hands, no half-closed row",
    n(integrity.rows[0].cross_or_orphan) === 0 && n(integrity.rows[0].doubled_vehicles) === 0
    && n(integrity.rows[0].doubled_drivers) === 0 && n(integrity.rows[0].half_closed) === 0,
    integrity.rows[0]);
  check("…and the driver's own file agrees with the register for every open handover",
    n(integrity.rows[0].scalar_disagrees) === 0, integrity.rows[0].scalar_disagrees);
  console.log("note  backfill:", JSON.stringify(b), "— an empty register is the honest result when",
    "no driver carried a vehicle before 092, which is this database's state.");

  // ================================================================
  console.log("\n--- 4 · the writers, on lines that roll back ---");

  const baseline = await owner.query(
    `select (select count(*)::int from vessel_assignments) as a,
            (select count(*)::int from vessel_positions) as p,
            (select count(*)::int from vessel_log_entries) as l`);

  await owner.query("begin");
  let sp = 0;
  /** Run one statement under a savepoint and undo it, whether it succeeded or threw. */
  async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: T | null; err: any }> {
    const name = `sp${++sp}`;
    await owner.query(`savepoint ${name}`);
    try {
      return { ok: await fn(), err: null };
    } catch (e) {
      return { ok: null, err: e };
    } finally {
      await owner.query(`rollback to savepoint ${name}`);
    }
  }
  async function refused(label: string, sql: string, params: any[] = [], re: RegExp = /./) {
    const r = await attempt(() => owner.query(sql, params));
    const msg = r.err ? `${r.err.code ?? ""} ${r.err.message ?? ""}` : "(the write was accepted)";
    check(label, !!r.err && re.test(msg), msg);
    return r.err;
  }

  try {
    const tenants = await owner.query(
      `select id from tenants where deleted_at is null order by created_at limit 2`);
    const A = tenants.rows[0]?.id as string;
    const B = tenants.rows[1]?.id as string;
    if (!A || !B) throw new Error("Need two tenants to prove the registers are tenant-bound");

    const one = async (sql: string, params: any[]): Promise<string> =>
      (await owner.query(sql, params)).rows[0].id as string;
    const mkVessel = (plate: string, odo: number, tid = A) => one(
      `insert into vessels (tenant_id, name, vessel_type, plate_number, odometer_km)
        values ($1,$2,'truck_head',$3,$4) returning id`, [tid, `${MARK} truck`, plate, odo]);
    const mkDriver = (name: string, tid = A) => one(
      `insert into drivers (tenant_id, full_name, status) values ($1,$2,'available') returning id`,
      [tid, `${MARK} ${name}`]);
    const mkRoute = (o: { lat: number, lng: number } | null,
      d: { lat: number, lng: number } | null, tid = A) => one(
      `insert into routes (tenant_id, name, origin_lat, origin_lng, dest_lat, dest_lng)
        values ($1,$2,$3,$4,$5,$6) returning id`,
      [tid, `${MARK} corridor`, o?.lat ?? null, o?.lng ?? null, d?.lat ?? null, d?.lng ?? null]);

    // Each probe gets a vehicle and a driver that no earlier probe has left open, so a refusal is
    // always the guard being tested and never a truck already busy for an unrelated reason.
    const VA = await mkVessel(`TP${STAMP}A`, 1000);
    const VA2 = await mkVessel(`TP${STAMP}B`, 2000);
    const VX = await mkVessel(`TP${STAMP}X`, 3000);
    const VB = await mkVessel(`TP${STAMP}C`, 500, B);
    const VY = await mkVessel(`TP${STAMP}Y`, 700, B);
    const DA1 = await mkDriver("one");
    const DA2 = await mkDriver("two");
    const DA3 = await mkDriver("four");
    const DB1 = await mkDriver("three", B);
    const DB2 = await mkDriver("five", B);
    const VM = await mkVessel(`TP${STAMP}M`, 12_345);
    const VM2 = await mkVessel(`TP${STAMP}N`, 54_321);
    const DM1 = await mkDriver("mirror-one");
    const DM2 = await mkDriver("mirror-two");

    // ----------------------------------------------------------------
    console.log("\n--- 4a · one truck, one pair of hands ---");

    const assignSql = `insert into vessel_assignments (id, tenant_id, vessel_id, driver_id, status,
                        start_odometer_km, notes, assigned_by, created_by)
                        values ($1,$2,$3,$4,'active',$5,$6,$7,$7)`;
    const first = randomUUID();
    await owner.query(assignSql, [first, A, VA, DA1, 1000, MARK, null]);
    check("an open handover stores who, what, at which reading and when",
      (await owner.query(
        `select status, started_at, end_odometer_km, start_odometer_km
           from vessel_assignments where id = $1`, [first])).rows[0]?.start_odometer_km === 1000);

    const onVehicle = await refused("a second driver cannot be handed a truck that is already held",
      assignSql, [randomUUID(), A, VA, DA2, null, MARK, null], /23505/);
    check("…and the database names the open-row guard that stopped it, not a foreign key",
      /active_vessel_uq/.test(String(onVehicle?.message ?? "")), onVehicle?.message);
    await refused("one driver cannot hold two trucks at once",
      assignSql, [randomUUID(), A, VA2, DA1, null, MARK, null], /23505.*active_driver_uq/);
    await refused("status active with an ended_at is refused",
      `insert into vessel_assignments (tenant_id, vessel_id, driver_id, status, ended_at, notes)
        values ($1,$2,$3,'active', now(), $4)`, [A, VX, DA3, MARK], /23514/);
    await refused("status ended without an ended_at is refused",
      `insert into vessel_assignments (tenant_id, vessel_id, driver_id, status, ended_at, notes)
        values ($1,$2,$3,'ended', null, $4)`, [A, VX, DA3, MARK], /23514/);
    const mixedDriver = await refused(
      "a handover cannot pair this company's truck with another company's driver",
      assignSql, [randomUUID(), A, VX, DB1, null, MARK, null], /23503/);
    check("…and the guard that says so is the pairing to `drivers`, not the row's own tenant_id",
      /driver_tenant_fkey/.test(String(mixedDriver?.message ?? "")), mixedDriver?.message);
    await refused("…nor another company's truck with this company's driver",
      assignSql, [randomUUID(), A, VB, DA3, null, MARK, null], /23503.*vessel_tenant_fkey/);

    const closed = await owner.query(
      `update vessel_assignments set status = 'ended', ended_at = now() where id = $1
         returning end_odometer_km is null as no_return`, [first]);
    check("closing a handover is an update, and the return reading stays optional",
      closed.rowCount === 1 && closed.rows[0].no_return === true);
    const reOpen = await owner.query(assignSql, [randomUUID(), A, VA, DA2, null, MARK, null]);
    check("once it is closed, the same truck can be handed over again to the next driver",
      reOpen.rowCount === 1);
    await refused("…while a second driver cannot pile onto the new open row",
      assignSql, [randomUUID(), A, VA, DA3, null, MARK, null], /23505.*active_vessel_uq/);
    const retired = await owner.query(
      `insert into vessel_assignments (tenant_id, vessel_id, driver_id, status, notes, deleted_at)
        values ($1,$2,$3,'active',$4, now()) returning id`, [A, VA2, DA1, MARK]);
    check("a soft-deleted open row does not occupy the guard — the predicate is partial, not cosmetic",
      retired.rowCount === 1 && (await owner.query(assignSql,
        [randomUUID(), A, VA2, DA1, null, MARK, null])).rowCount === 1);
    await refused("…but the moment two live rows claim the same pair, the guard falls back on it",
      assignSql, [randomUUID(), A, VA2, DA1, null, MARK, null], /23505/);
    await refused("a handover cannot be filed against a company that does not exist",
      assignSql, [randomUUID(), randomUUID(), VX, DB2, null, MARK, null], /23503/);

    // ----------------------------------------------------------------
    console.log("\n--- 4b · the driver's file and the register, kept in step (#208) ---");

    const mirror = (driverId: string, vesselId: string | null, prev: string | null, tid = A) =>
      mirrorScalarAssignment(asClient, {
        tenantId: tid, driverId, vesselId, previousVesselId: prev, actorId: randomUUID()
      });

    const opened = await mirror(DM1, VM, null);
    const openedRow = (await owner.query(
      `select status, notes from vessel_assignments where id = $1`, [opened.openedId])).rows[0] ?? {};
    check("moving a driver onto a truck from their own file opens the same register row",
      !!opened.openedId && opened.endedId === null && openedRow.status === "active", opened);
    check("…and says where the row came from, so a register line is not mistaken for a desk handover",
      /driver's file/.test(String(openedRow.notes ?? "")), openedRow.notes);
    const noop = await mirror(DM1, VM, VM);
    check("writing the same vehicle again changes nothing — a save is not a handover",
      noop.openedId === null && noop.endedId === null
      && n((await owner.query(
        `select count(*)::int as n from vessel_assignments where driver_id = $1`, [DM1]))
        .rows[0].n) === 1, noop);
    const moved = await mirror(DM1, VM2, VM);
    const dm1Rows = await owner.query(
      `select id, status, ended_at from vessel_assignments where driver_id = $1`, [DM1]);
    const endedRow = dm1Rows.rows.find((r: any) => r.id === moved.endedId);
    const activeRow = dm1Rows.rows.find((r: any) => r.id === moved.openedId);
    check("handing the driver a second truck closes the first row and opens one, without deleting",
      moved.endedId === opened.openedId && !!moved.openedId && moved.openedId !== opened.openedId
      && dm1Rows.rows.length === 2 && endedRow?.status === "ended" && !!endedRow?.ended_at
      && activeRow?.status === "active" && activeRow?.ended_at === null, dm1Rows.rows);
    await mirror(DM2, VM, null);
    const blocked = await attempt(() => mirror(DM1, VM, VM2));
    check("a truck already in another driver's hands is refused from the driver's file too",
      !!blocked.err && blocked.err.code === "ASSIGNMENT_VESSEL_TAKEN"
      && /already in the hands of/.test(String(blocked.err.message)),
      blocked.err?.code ?? "(accepted)");
    const stillOpen = await owner.query(
      `select count(*)::int as n from vessel_assignments
        where driver_id = $1 and status = 'active' and deleted_at is null`, [DM1]);
    check("…and the refusal leaves the driver's existing handover exactly where it was",
      n(stillOpen.rows[0].n) === 1, stillOpen.rows[0]);
    const offTruck = await mirror(DM1, null, VM2);
    const offRow = (await owner.query(
      `select status, ended_at, end_odometer_km from vessel_assignments where id = $1`,
      [offTruck.endedId])).rows[0] ?? {};
    check("taking the driver off every vehicle closes the open row rather than deleting it",
      !!offTruck.endedId && offTruck.openedId === null && offRow.status === "ended"
      && !!offRow.ended_at && offRow.end_odometer_km === null, offTruck);
    const foreignDriver = await attempt(() => mirror(DB1, VM, null));
    check("a driver from another company cannot be written into this register at all",
      !!foreignDriver.err && foreignDriver.err.code === "NOT_FOUND",
      foreignDriver.err?.code ?? "(accepted)");
    const foreignVessel = await attempt(() => mirror(DM2, VB, null));
    const dm2Still = await owner.query(
      `select count(*)::int as n from vessel_assignments
        where driver_id = $1 and status = 'active' and deleted_at is null and vessel_id = $2`,
      [DM2, VM]);
    check("…and neither can a vehicle this company does not own, which leaves its holder untouched",
      !!foreignVessel.err && foreignVessel.err.code === "NOT_FOUND"
      && n(dm2Still.rows[0].n) === 1,
      { code: foreignVessel.err?.code ?? "(accepted)", dm2Still: dm2Still.rows[0] });

    // ----------------------------------------------------------------
    console.log("\n--- 4c · the position ledger ---");

    const pid = await insertPosition(asClient, {
      tenantId: A, vesselId: VA, lat: DAR.lat, lng: DAR.lng, source: "device",
      accuracyM: 12, odometerKm: 1040, note: `${MARK} now`, recordedBy: null
    });
    const nowRow = (await owner.query(
      `select lat::text as lat, lng::text as lng, source, accuracy_m, trip_id, driver_id,
              extract(epoch from (now() - recorded_at))::int as age
         from vessel_positions where id = $1`, [pid])).rows[0];
    check("a report with no time of its own is stamped with the database's clock",
      !!nowRow && n(nowRow.age) < 5 && nowRow.trip_id === null && nowRow.driver_id === null, nowRow);
    check("…and the coordinate is stored exactly to the six decimals the column promises",
      nowRow?.lat === "-6.800000" && nowRow?.lng === "39.283333" && nowRow?.accuracy_m === 12, nowRow);

    const backDated = await insertPosition(asClient, {
      tenantId: A, vesselId: VA, lat: KIGALI.lat, lng: KIGALI.lng, source: "manual",
      note: `${MARK} older`, recordedAt: new Date(Date.now() - 3 * 86400_000).toISOString()
    });
    const trail = await owner.query(
      `select id, source, extract(epoch from (now() - recorded_at))::int as age
         from vessel_positions where vessel_id = $1 order by recorded_at desc limit 60`, [VA]);
    check("a word for where a truck was three days ago is kept as its own line, not an overwrite",
      trail.rows.length === 2 && trail.rows[0].id === pid && trail.rows[1].id === backDated
      && n(trail.rows[1].age) > 3 * 86400 - 60, trail.rows);
    check("…and the newest-first read the dossier uses puts the older report second",
      n(trail.rows[0].age) + 60 < n(trail.rows[1].age), trail.rows);

    await refused("a latitude off the planet is refused by the column",
      `insert into vessel_positions (tenant_id, vessel_id, lat, lng, source)
        values ($1,$2,91,39,'manual')`, [A, VA], /23514/);
    await refused("…and so is a longitude, in the direction a dispatcher would actually get wrong",
      `insert into vessel_positions (tenant_id, vessel_id, lat, lng, source)
        values ($1,$2,-6,181,'manual')`, [A, VA], /23514/);
    await refused("a report cannot describe a position that has not happened yet",
      `insert into vessel_positions (tenant_id, vessel_id, lat, lng, source, recorded_at)
        values ($1,$2,-6,39,'manual', now() + interval '2 hours')`, [A, VA], /23514/);
    await refused("the ledger refuses a source nobody has wired up, such as a bare 'gps'",
      `insert into vessel_positions (tenant_id, vessel_id, lat, lng, source)
        values ($1,$2,-6,39,'gps')`, [A, VA], /23514/);
    await refused("a negative accuracy or reading is refused rather than averaged in later",
      `insert into vessel_positions (tenant_id, vessel_id, lat, lng, source, accuracy_m)
        values ($1,$2,-6,39,'device',-5)`, [A, VA], /23514/);
    await refused("a fix cannot be filed against another company's plate",
      `insert into vessel_positions (tenant_id, vessel_id, lat, lng, source)
        values ($1,$2,-6,39,'manual')`, [A, VB], /23503/);

    // The corridor box is the route's rule, not the column's: the column bounds the planet so a
    // report about a truck in Nairobi is never refused for geometry, while the desk refuses a pin
    // outside the region the planner can route to. Both layers, stated where they live.
    const outside = await attempt(() => insertPosition(asClient, {
      tenantId: A, vesselId: VA, lat: OUTSIDE.lat, lng: OUTSIDE.lng, source: "manual",
      note: `${MARK} outside the corridor`
    }));
    check("the database accepts a coordinate the route will refuse, and the split is deliberate",
      !outside.err && !!outside.ok, outside.err?.message ?? "");
    check("…so the corridor guard is the one that has to hold, and it holds on all four edges",
      inCorridorBox(DAR.lat, DAR.lng) && inCorridorBox(CORRIDOR_BOX.minLat, CORRIDOR_BOX.minLng)
      && inCorridorBox(CORRIDOR_BOX.maxLat, CORRIDOR_BOX.maxLng)
      && !inCorridorBox(CORRIDOR_BOX.minLat - 0.0001, DAR.lng)
      && !inCorridorBox(DAR.lat, CORRIDOR_BOX.minLng - 0.0001)
      && !inCorridorBox(OUTSIDE.lat, OUTSIDE.lng), CORRIDOR_BOX);

    const posOf = async (vessel: string) => n((await owner.query(
      `select count(*)::int as n from vessel_positions where vessel_id = $1`, [vessel]))
      .rows[0].n);
    const fullRoute = await mkRoute(DAR, KIGALI);
    const tripId = await one(
      `insert into trips (tenant_id, route_id, status, reference)
        values ($1,$2,'in_transit',$3) returning id`, [A, fullRoute, `${MARK} leg`]);
    const legDep = await recordTripLegPosition(asClient, {
      tenantId: A, tripId, vesselId: VA, routeId: fullRoute,
      driverId: DA1, reference: "T-1", source: "trip_departure", actorId: randomUUID()
    });
    const dep = (await owner.query(
      `select lat::text as lat, lng::text as lng, source, note, driver_id, odometer_km, trip_id
         from vessel_positions where vessel_id = $1 and source = 'trip_departure'`, [VA])).rows[0];
    check("a leg that departs files the route's own origin, with the trip and the reading behind it",
      legDep === true && dep?.lat === "-6.800000" && dep?.lng === "39.283333"
      && /T-1 departed/.test(String(dep?.note ?? "")) && n(dep?.odometer_km) === 1000
      && dep?.driver_id === DA1 && dep?.trip_id === tripId, dep);
    const arrivalRoute = await mkRoute(DAR, KIGALI);
    const legArr = await recordTripLegPosition(asClient, {
      tenantId: A, tripId, vesselId: VA2, routeId: arrivalRoute,
      driverId: null, reference: "T-2", source: "trip_arrival", actorId: randomUUID()
    });
    const arr = (await owner.query(
      `select lat::text as lat, lng::text as lng, source from vessel_positions
        where vessel_id = $1 and source = 'trip_arrival'`, [VA2])).rows[0];
    check("…and the arrival files the destination instead, from the same route row",
      legArr === true && arr?.lat === "-1.953258" && arr?.lng === "30.062677", arr);
    const blankRoute = await mkRoute(null, KIGALI);
    const before = await posOf(VA);
    const noOrigin = await recordTripLegPosition(asClient, {
      tenantId: A, tripId, vesselId: VA, routeId: blankRoute,
      driverId: null, reference: "T-3", source: "trip_departure", actorId: randomUUID()
    });
    check("a route with no traced origin answers false and files nothing — no invented centroid",
      noOrigin === false && (await posOf(VA)) === before, { noOrigin, before });
    const after = await recordTripLegPosition(asClient, {
      tenantId: A, tripId, vesselId: VA, routeId: blankRoute,
      driverId: null, reference: "T-3", source: "trip_arrival", actorId: randomUUID()
    });
    check("…while the same route can still place the truck at the end it does know",
      after === true && (await posOf(VA)) === before + 1, { after });
    const foreign = await recordTripLegPosition(asClient, {
      tenantId: B, tripId, vesselId: VB, routeId: fullRoute,
      driverId: null, reference: "T-4", source: "trip_departure", actorId: randomUUID()
    });
    check("a route from another company cannot place this company's truck, on either side of it",
      foreign === false && (await posOf(VB)) === 0, { foreign });

    // ----------------------------------------------------------------
    console.log("\n--- 4d · the per-plate logbook ---");

    const logSql = `insert into vessel_log_entries (id, tenant_id, vessel_id, entry_date, kind, title,
                        detail, odometer_km, actor_name, created_by, updated_by)
                        values ($1,$2,$3, coalesce($4::date, current_date), $5,$6,$7,$8,$9,$10,$10)`;
    const lid = randomUUID();
    await owner.query(logSql, [lid, A, VA, null, "note",
      "Windscreen chipped near Kidatu", null, null, null, null]);
    const logged = (await owner.query(
      `select entry_date, to_char(entry_date,'YYYY-MM-DD') as day, kind, deleted_at,
              to_char(current_date,'YYYY-MM-DD') as db_today
         from vessel_log_entries where id = $1`, [lid])).rows[0];
    check("an entry with no date of its own is dated today and comes back as the string the desk sends",
      !!logged && logged.day === logged.db_today && typeof logged.day === "string"
      && logged.deleted_at === null && logged.kind === "note", logged);
    const pastLid = randomUUID();
    await owner.query(logSql, [pastLid, A, VA, "2026-01-05", "damage",
      "Tyre burst near Kidatu", null, null, "J. Mrema", null]);
    check("…and a back-dated line keeps the day it was written for, not the day it was typed",
      (await owner.query(
        `select to_char(entry_date,'YYYY-MM-DD') as day, actor_name from vessel_log_entries
          where id = $1`, [pastLid])).rows[0]?.day === "2026-01-05");

    await refused("an odometer entry with no reading is refused by the database",
      logSql, [randomUUID(), A, VA, null, "odometer", "Fuel station reading",
        null, null, null, null], /23514/);
    check("…while the same line with a reading is the fact the register exists to hold",
      (await owner.query(logSql, [randomUUID(), A, VA, null, "odometer",
        "Fuel station reading", null, 1120, null, null])).rowCount === 1);
    await refused("a negative reading is refused rather than folded into a trend",
      logSql, [randomUUID(), A, VA, null, "odometer", "Backwards", null, -5, null, null], /23514/);
    await refused("a logbook kind the platform has not defined is refused",
      logSql, [randomUUID(), A, VA, null, "invoice", "Tyre bill", null, null, null, null], /23514/);
    await refused("a blank title cannot be stored — the register is scanned by its first column",
      logSql, [randomUUID(), A, VA, null, "note", "   ", null, null, null, null], /23514/);
    await refused("a journal line cannot be filed against another company's plate",
      logSql, [randomUUID(), A, VB, null, "note", "Borrowed truck", null, null, null, null],
      /23503/);

    // The trap the dossier's to_char reads are written to dodge. pg hands a DATE back as local
    // midnight, so in a process east of Greenwich its own UTC string is the day before.
    const dateProbe = await owner.query(
      `select date '2026-10-19' as raw, to_char(date '2026-10-19','YYYY-MM-DD') as day`);
    const rawDate = dateProbe.rows[0].raw as Date;
    const isoDay = rawDate.toISOString().slice(0, 10);
    const east = rawDate.getTimezoneOffset() < 0;
    check("a raw DATE column really can be one day off, which is why every date leaves as a to_char string",
      dateProbe.rows[0].day === "2026-10-19"
      && (east ? isoDay === "2026-10-18" : isoDay === "2026-10-19"),
      { raw: rawDate.toISOString(), printed: dateProbe.rows[0].day, isoDay,
        offset: rawDate.getTimezoneOffset() });

    await owner.query("rollback");
  } catch (e) {
    await owner.query("rollback").catch(() => { });
    check("the write probes rolled back cleanly", false, String(e).slice(0, 500));
  }

  const residue = await owner.query(
    `select (select count(*)::int from vessel_assignments) as a,
            (select count(*)::int from vessel_positions) as p,
            (select count(*)::int from vessel_log_entries) as l,
            (select count(*)::int from vessel_assignments where notes like '%92 verify %') as marked_a,
            (select count(*)::int from vessel_positions where note like '%92 verify %') as marked_p,
            (select count(*)::int from vessel_log_entries where title like '%92 verify %') as marked_l,
            (select count(*)::int from vessels where name like '%092 verify%') as probe_vessels,
            (select count(*)::int from drivers where full_name like '%092 verify%') as probe_drivers,
            (select count(*)::int from routes where name like '%092 verify%') as probe_routes,
            (select count(*)::int from trips where reference like '%092 verify%') as probe_trips`);
  check("the transaction left nothing behind in any of the three registers",
    n(residue.rows[0].a) === n(baseline.rows[0].a)
    && n(residue.rows[0].p) === n(baseline.rows[0].p)
    && n(residue.rows[0].l) === n(baseline.rows[0].l),
    { residue: residue.rows[0], baseline: baseline.rows[0] });
  check("…and no probe truck, driver, corridor, leg or marked line survived anywhere",
    Object.entries(residue.rows[0]).slice(3).every(([, v]) => n(v) === 0), residue.rows[0]);

  // ================================================================
  console.log("\n--- 5 · the same tables under the role the API actually runs as ---");

  const app = appUrl();
  if (!app) {
    console.log("skip  app_runtime probe (no APP_DB_PASSWORD / APP_DATABASE_URL)");
  } else {
    const runtime = await connectRuntime(app);
    const asRt = runtime as any;
    let rsp = 0;
    /** Same trick as the owner half: a refused write must not poison the block it is proved in. */
    async function rtProbe(sql: string, params: any[] = []) {
      const name = `rp${++rsp}`;
      await runtime.query(`savepoint ${name}`);
      try {
        const r = await runtime.query(sql, params);
        await runtime.query(`rollback to savepoint ${name}`);
        return { rows: r.rows ?? [], err: null as string | null };
      } catch (e: any) {
        await runtime.query(`rollback to savepoint ${name}`);
        return { rows: null, err: String(e.message) as string | null };
      }
    }
    const tenants = await owner.query(
      `select id from tenants where deleted_at is null order by created_at limit 2`);
    const A = tenants.rows[0].id, B = tenants.rows[1].id;

    // Nothing here commits either. It has to build its own truck and driver, because the role can
    // only write inside a claimed tenant — which is itself the first proof.
    await runtime.query("begin");
    try {
      const naked = await runtime.query(
        `select (select count(*)::int from vessel_assignments) as a,
                (select count(*)::int from vessel_positions) as p,
                (select count(*)::int from vessel_log_entries) as l`);
      check("with no tenant claimed, the application role sees nothing in any of the three registers",
        n(naked.rows[0].a) === 0 && n(naked.rows[0].p) === 0 && n(naked.rows[0].l) === 0,
        naked.rows[0]);

      await runtime.query(`select set_config('app.tenant_id', $1, true)`, [A]);
      const rv = (await runtime.query(
        `insert into vessels (tenant_id, name, vessel_type, plate_number, odometer_km)
          values ($1,$2,'truck_head',$3,100) returning id`,
        [A, `${MARK} runtime truck`, `RT${STAMP}`])).rows[0].id;
      const rd = (await runtime.query(
        `insert into drivers (tenant_id, full_name) values ($1,$2) returning id`,
        [A, `${MARK} runtime driver`])).rows[0].id;

      const mirrored = await mirrorScalarAssignment(asRt, {
        tenantId: A, driverId: rd, vesselId: rv, previousVesselId: null, actorId: randomUUID()
      });
      check("app_runtime can open a handover and read it back inside its own tenant",
        !!mirrored.openedId && n((await runtime.query(
          `select count(*)::int as n from vessel_assignments where driver_id = $1`, [rd]))
          .rows[0].n) === 1, mirrored);

      await runtime.query(`select set_config('app.tenant_id', $1, true)`, [B]);
      const other = await runtime.query(
        `select (select count(*)::int from vessel_assignments) as a,
                (select count(*)::int from vessels) as v,
                (select count(*)::int from vessel_positions) as p`);
      check("…and the same role, one statement later, cannot see the tenant it just wrote",
        n(other.rows[0].a) === 0 && n(other.rows[0].v) === 0 && n(other.rows[0].p) === 0,
        other.rows[0]);
      const forged = await rtProbe(
        `insert into vessel_assignments (tenant_id, vessel_id, driver_id, status, notes)
          values ($1,$2,$3,'active',$4)`, [A, rv, rd, MARK]);
      check("a row written for another tenant under this GUC is refused by the policy, not a WHERE",
        !!forged.err && /row-level security/.test(forged.err), forged.err ?? "(accepted)");

      // The pairing is checked by the catalog now, so even with the wall stepped over to A the
      // mixed row cannot land: here B claims its own tenant and reaches for A's truck.
      const mixed = await rtProbe(
        `insert into vessel_positions (tenant_id, vessel_id, lat, lng, source)
          values ($1,$2,-6,39,'manual')`, [B, rv]);
      check("…and a report naming another company's vehicle is refused before the policy is even asked",
        !!mixed.err && /violates foreign key constraint "vessel_positions_vessel_tenant_fkey"/.test(mixed.err),
        mixed.err ?? "(accepted)");
      await runtime.query(`select set_config('app.tenant_id', $1, true)`, [A]);

      await insertPosition(asRt, {
        tenantId: A, vesselId: rv, lat: DAR.lat, lng: DAR.lng, source: "device", note: MARK
      });
      const upd = await rtProbe(
        `update vessel_positions set note = 'corrected' where vessel_id = $1`, [rv]);
      const del = await rtProbe(`delete from vessel_positions where vessel_id = $1`, [rv]);
      check("the ledger cannot be rewritten or emptied by the application role — even its own row",
        /permission denied/.test(String(upd.err)) && /permission denied/.test(String(del.err)),
        { upd: upd.err ?? "(accepted)", del: del.err ?? "(accepted)" });
      const correction = await insertPosition(asRt, {
        tenantId: A, vesselId: rv, lat: KIGALI.lat, lng: KIGALI.lng, source: "manual",
        note: `${MARK} correction`
      });
      check("…so a correction is a second line beside the wrong one, and both stay",
        !!correction && n((await runtime.query(
          `select count(*)::int as n from vessel_positions where vessel_id = $1`, [rv]))
          .rows[0].n) === 2);

      await runtime.query(
        `insert into vessel_log_entries (tenant_id, vessel_id, kind, title)
          values ($1,$2,'note',$3)`, [A, rv, `${MARK} filed`]);
      const hard = await rtProbe(`delete from vessel_log_entries where vessel_id = $1`, [rv]);
      check("the logbook cannot be hard-deleted either, so a wrong line is retired by the route",
        /permission denied/.test(String(hard.err)), hard.err ?? "(accepted)");
      const soft = await runtime.query(
        `update vessel_log_entries set deleted_at = now() where vessel_id = $1`, [rv]);
      check("…while the soft-delete the routes rely on is allowed, and hides the line from the read",
        soft.rowCount === 1 && n((await runtime.query(
          `select count(*)::int as n from vessel_log_entries
            where vessel_id = $1 and deleted_at is null`, [rv])).rows[0].n) === 0);

      await runtime.query("rollback");
    } catch (e) {
      await runtime.query("rollback").catch(() => { });
      check("the app_runtime probes rolled back cleanly", false, String(e).slice(0, 500));
    }

    const left = await owner.query(
      `select (select count(*)::int from vessel_assignments where notes like '%92 verify %') as a,
              (select count(*)::int from vessel_positions where note like '%92 verify %') as p,
              (select count(*)::int from vessel_log_entries where title like '%92 verify %') as l,
              (select count(*)::int from vessels where name like '%092 verify%') as v,
              (select count(*)::int from drivers where full_name like '%092 verify%') as d`);
    check("nothing the application role wrote is still on the database",
      Object.values(left.rows[0]).every((v) => n(v) === 0), left.rows[0]);
    await runtime.end();
  }

  await owner.end();
  console.log(`\n${failures ? "FAILURES: " + failures : "092 and 093 verified."}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
