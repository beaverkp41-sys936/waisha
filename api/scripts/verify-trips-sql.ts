/**
 * SQL validation for trips.routes.ts — plans every statement against the live
 * schema without executing writes (EXPLAIN only). Catches column/join typos.
 * Run: npx tsx scripts/verify-trips-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_ID = "11111111-1111-7111-8111-111111111111";

const listSql = `
  select t.id, t.reference, t.status, t.route_id, t.vessel_id, t.driver_id,
         t.planned_departure, t.planned_arrival, t.actual_departure,
         t.actual_arrival, t.distance_km, t.notes, t.created_at,
         r.name as route_name, r.origin_text, r.dest_text,
         v.name as vessel_name, d.full_name as driver_name,
         (select count(*)::int from trip_shipments s
           where s.trip_id = t.id and s.deleted_at is null) as shipment_count,
         (select coalesce(sum(s.weight_kg), 0)::float8 from trip_shipments s
           where s.trip_id = t.id and s.deleted_at is null) as total_weight_kg,
         (select coalesce(sum(s.freight_charge), 0)::float8 from trip_shipments s
           where s.trip_id = t.id and s.deleted_at is null) as total_freight
  from trips t
  left join routes r on r.id = t.route_id
  left join vessels v on v.id = t.vessel_id
  left join drivers d on d.id = t.driver_id
  where t.tenant_id = $1 and t.deleted_at is null
  order by t.created_at desc`;

const detailSql = `
  select t.*, r.name as route_name, r.origin_text, r.dest_text,
         r.expected_duration_hours,
         rog.name_en as origin_region, rog.lat as origin_lat, rog.lng as origin_lng,
         rdg.name_en as dest_region, rdg.lat as dest_lat, rdg.lng as dest_lng,
         v.name as vessel_name, v.capacity_tonnes,
         d.full_name as driver_name
  from trips t
  join routes r on r.id = t.route_id
  left join geo_regions rog on rog.id = r.origin_region_id
  left join geo_regions rdg on rdg.id = r.dest_region_id
  left join vessels v on v.id = t.vessel_id
  left join drivers d on d.id = t.driver_id
  where t.id = $1 and t.tenant_id = $2 and t.deleted_at is null`;

const conflictSql = `
  select coalesce(reference, id::text) as label from trips
  where tenant_id = $1 and vessel_id = $2 and status in ('planned','in_transit')
    and deleted_at is null and id <> $3
  limit 1`;

const inserts: [string, string, unknown[]][] = [
  ["trips insert", `insert into trips (id, tenant_id, reference, route_id, vessel_id, driver_id,
     planned_departure, planned_arrival, distance_km, notes, created_by, updated_by)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
    [FAKE_ID, FAKE_TENANT, null, FAKE_ID, null, null, null, null, null, null, FAKE_ID]],
  ["trip_shipments insert", `insert into trip_shipments (id, tenant_id, trip_id, customer_name,
     customer_phone_encrypted, customer_phone_search, goods_description,
     package_count, weight_kg, freight_charge, notes, created_by, updated_by)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [FAKE_ID, FAKE_TENANT, FAKE_ID, "x", null, null, null, null, null, null, null, FAKE_ID]],
  ["trip_checkpoint_logs insert", `insert into trip_checkpoint_logs
     (id, tenant_id, trip_id, route_checkpoint_id, label, kind, note, logged_by)
   values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [FAKE_ID, FAKE_TENANT, FAKE_ID, null, "x", "custom", null, FAKE_ID]]
];

const updates: [string, string, unknown[]][] = [
  ["trip status update", `update trips set status = $2, actual_departure = now(),
     actual_arrival = now(), updated_by = $3, updated_at = now()
   where id = $1 and tenant_id = $4 and deleted_at is null`,
    [FAKE_ID, "in_transit", FAKE_ID, FAKE_TENANT]],
  ["trip soft delete", `update trips set deleted_at = now(), updated_by = $2
   where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_ID, FAKE_ID, FAKE_TENANT]],
  ["trip_shipments update", `update trip_shipments set customer_name = $4,
     updated_by = $2, updated_at = now()
   where id = $1 and tenant_id = $3 and deleted_at is null`,
    [FAKE_ID, FAKE_ID, FAKE_TENANT, "x"]],
  ["trip_shipments soft delete", `update trip_shipments set deleted_at = now(), updated_by = $2
   where id = $1 and trip_id = $3 and tenant_id = $4 and deleted_at is null`,
    [FAKE_ID, FAKE_ID, FAKE_ID, FAKE_TENANT]]
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 1 });

  let failed = 0;
  async function check(label: string, sql: string, params: unknown[]) {
    try {
      await pool.query("explain " + sql, params);
      console.log("ok   ", label);
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  const tid = await pool.query("select id from tenants limit 1");
  const realTenant = tid.rows[0]?.id ?? FAKE_TENANT;
  console.log("using tenant:", realTenant);

  await check("trips list", listSql, [realTenant]);
  await check("trip detail", detailSql, [FAKE_ID, realTenant]);
  await check("resource conflict", conflictSql, [realTenant, FAKE_ID, FAKE_ID]);
  await check("route checkpoints", "select id, seq, kind, name from route_checkpoints where route_id = $1 and tenant_id = $2 order by seq", [FAKE_ID, realTenant]);
  for (const [l, s, p] of inserts) await check(l, s, p);
  for (const [l, s, p] of updates) await check(l, s, p);
  await check("ward columns", "select r.origin_ward_id, r.dest_ward_id from routes r limit 1", []);

  await pool.end();
  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log("all trip SQL valid");
}

main().catch((e) => { console.error(e); process.exit(1); });
