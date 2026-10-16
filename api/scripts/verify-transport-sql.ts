/**
 * Step 4 — SQL + Rule 0 validation for transport.routes.ts + util/transport.ts.
 *
 * Two jobs. First, EXPLAIN every statement the module runs against the live
 * schema so no query ships broken. Second, prove the publish surface is an
 * allowlist: transport_requests may only carry the columns listed below, so a
 * later migration that adds a column without reviewing it here fails this
 * check, and no client-identity, money or customs-number field can be stored
 * where the notice board would read it.
 * Run: npx tsx scripts/verify-transport-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const T = "00000000-0000-7000-8000-000000000000";  // tenant
const U = "11111111-1111-7111-8111-111111111111";  // actor
const J = "22222222-2222-7222-8222-222222222222";  // job
const S = "33333333-3333-7333-8333-333333333333";  // shipment
const R = "99999999-9999-7999-8999-999999999999";  // transport request
const RT = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"; // route
const B = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";  // booking

const sql: [string, string, unknown[]][] = [
  // ---- util/transport.ts ----
  ["buildPreview: job + shipment source",
    `select j.id, j.shipment_id, j.status, j.record_kind, j.transport_needed, j.transport_consent,
            s.file_number, s.shipment_type, s.cargo_description, s.container_type,
            s.container_count, s.weight_tonnes, s.cbm, s.consignee_name, s.consignor_name,
            s.nominated_icd, s.border_point, s.carry_in_date::text as carry_in_date,
            s.eta::text as eta
       from jobs j
       join cargo_shipments s on s.id = j.shipment_id and s.tenant_id = j.tenant_id
      where j.id = $1 and j.tenant_id = $2 and j.deleted_at is null and s.deleted_at is null`,
    [J, T]],
  ["buildPreview: company card",
    `select company_name, description, services_offered, corridors_served, website,
            fleet_size_declared, year_established
       from company_profiles where tenant_id = $1`, [T]],
  ["buildPreview: acting user as contact",
    `select id, full_name, email from users
      where id = $1 and tenant_id = $2 and deleted_at is null`, [U, T]],
  ["buildPreview: own routes for the picker",
    `select r.id,
            coalesce(r.name, concat_ws(' - ', ro.name_en, rd.name_en)) as label,
            r.distance_km, r.expected_duration_hours, r.dest_region_id
       from routes r
       left join geo_regions ro on ro.id = r.origin_region_id
       left join geo_regions rd on rd.id = r.dest_region_id
      where r.tenant_id = $1 and r.deleted_at is null and r.is_active
      order by label limit 200`, [T]],
  ["buildPreview: region names",
    `select id, name_en as name from geo_regions where is_active and country = 'TZ'
      order by name_en`],
  ["buildPreview: staff picker",
    `select id, full_name, email from users
      where tenant_id = $1 and deleted_at is null and status = 'active'
        and user_type in ('director','staff')
      order by full_name limit 200`, [T]],
  ["copyRoute: server-side route copy",
    `select r.id,
            coalesce(r.name, concat_ws(' - ', ro.name_en, rd.name_en)) as route_label,
            r.distance_km, r.expected_duration_hours, r.dest_region_id
       from routes r
       left join geo_regions ro on ro.id = r.origin_region_id
       left join geo_regions rd on rd.id = r.dest_region_id
      where r.id = $1 and r.tenant_id = $2 and r.deleted_at is null`, [RT, T]],

  // ---- routes: guards before a publish ----
  ["loadJob (consent gate)",
    `select j.id, j.tenant_id, j.shipment_id, j.record_kind, j.status, j.transport_needed,
            j.transport_consent, j.free_days, j.free_days_start::text as free_days_start,
            j.closed_at, j.notes, j.created_at, j.updated_at,
            s.file_number, s.shipment_type, s.status as shipment_status,
            s.eta, s.discharge_date, s.consignee_name, s.consignor_name
       from jobs j
       join cargo_shipments s on s.id = j.shipment_id
      where j.id = $1 and j.tenant_id = $2 and j.deleted_at is null
        and s.deleted_at is null`, [J, T]],
  ["publish: profile present",
    `select company_name, description, services_offered, corridors_served, website,
            fleet_size_declared, year_established
       from company_profiles where tenant_id = $1`, [T]],
  ["publish: contact is own staff",
    `select 1 from users where id = $1 and tenant_id = $2
       and deleted_at is null and status = 'active' limit 1`, [U, T]],

  // ---- publish ----
  // No `status` column: migration 048 made 'open' the only way in (the default).
  ["publish: insert request",
    `insert into transport_requests (id, tenant_id, job_id, shipment_id,
       cargo_label, container_type, container_count, weight_tonnes, cbm, vehicle_types,
       route_id, route_label, distance_km, expected_duration_hours,
       pickup_text, pickup_region_id, dest_text, dest_region_id, via_label, required_date,
       contact_user_id, contact_name, contact_channel, public_note,
       company_name, company_description, company_services, company_corridors,
       company_website, fleet_size_declared, year_established,
       disclosed_by, disclosed_at, created_by, updated_by)
     values ($1,$2,$3,$4,
       'Steel coils',$5,6,24.5,18::numeric,$6::text[],
       $7,'Dar - Iringa',610,14,
       'ICD Tema',$8,'Iringa',$9,'Mlimba','2026-10-20'::date,
       $10,'Amani Salum','amani@example.com','Tail-lift needed',
       'Waisha Logistics Ltd','Description','F bulk','TZ-KE',
       'waisha.example',12,2019,
       $10,now(),$10,$10)`,
    [R, T, J, S, "40ft", ["truck_head", "trailer"], RT, 1, 2, U]],
  ["publish: activity row",
    `insert into job_activity (id, tenant_id, job_id, shipment_id, stage_id, actor_user_id,
       actor_role, action, summary, entity, entity_id, meta)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [U, T, J, S, null, U, "director", "transport.published", "Published", "transport_requests", R, "{}"]],

  // ---- list / detail / cancel ----
  ["list: own requests",
    `select t.id, t.status, t.cargo_label, t.pickup_text, t.dest_text, t.via_label,
            t.distance_km, t.expected_duration_hours, t.vehicle_types, t.container_type,
            t.container_count, t.weight_tonnes, t.cbm, t.required_date::text as required_date,
            t.contact_name, t.contact_channel, t.company_name, t.route_label, t.disclosed_at,
            t.booked_company_name, t.booked_contact_name, t.booked_contact_channel,
            t.temp_booked_at, t.reminder_sent_at, t.released_at, t.confirmed_at,
            t.job_id, t.shipment_id, s.file_number, s.shipment_type,
            j.status as job_status, j.transport_consent
       from transport_requests t
       join jobs j on j.id = t.job_id and j.tenant_id = t.tenant_id
       join cargo_shipments s on s.id = t.shipment_id and s.tenant_id = t.tenant_id
      where t.tenant_id = $1 and t.deleted_at is null
        and ($2::text is null or t.status = $2)
        and ($4::uuid is null or t.job_id = $4)
        and ($3::text is null or t.cargo_label ilike $3 or t.pickup_text ilike $3
             or t.dest_text ilike $3 or s.file_number ilike $3)
      order by (t.status = 'open') desc, t.required_date, t.created_at desc
      limit 300`, [T, "open", "%steel%", J]],
  ["detail: own request",
    `select t.*, t.required_date::text as required_date, t.disclosed_at,
            s.file_number, s.shipment_type, j.status as job_status,
            j.transport_consent, j.transport_needed
       from transport_requests t
       join jobs j on j.id = t.job_id and j.tenant_id = t.tenant_id
       join cargo_shipments s on s.id = t.shipment_id and s.tenant_id = t.tenant_id
      where t.id = $1 and t.tenant_id = $2 and t.deleted_at is null`, [R, T]],
  ["cancel: fetch own",
    `select id, job_id, shipment_id, status, pickup_text, dest_text
       from transport_requests
      where id = $1 and tenant_id = $2 and deleted_at is null`, [R, T]],
  ["cancel: call state machine",
    `select transport_withdraw_request($1,$2,$3) as r`, [R, T, U]],

  // ---- booking transitions (all via SECURITY DEFINER functions) ----
  ["confirm: call state machine",
    `select transport_confirm_booking($1,$2,$3) as r`, [R, T, U]],
  ["reject: call state machine",
    `select transport_reject_booking($1,$2,$3,$4) as r`, [R, T, U, null]],
  ["cancel-booking: call state machine",
    `select transport_cancel_booking($1,$2,$3,$4) as r`, [R, T, U, "The client changed the plan"]],
  ["release: resolve own booking",
    `select request_id from transport_bookings
      where id = $1 and tenant_id = $2 and deleted_at is null`, [B, T]],
  ["release: call state machine",
    `select transport_release_booking($1,$2,$3,$4) as r`, [R, T, U, null]],
  ["my-bookings: list",
    `select id, status, cargo_label, container_type, container_count, weight_tonnes, cbm,
            vehicle_types, route_label, distance_km, expected_duration_hours,
            pickup_text, dest_text, via_label, required_date::text as required_date,
            company_name, contact_name, contact_channel,
            temp_booked_at, reminder_sent_at, confirmed_at, ended_at, ended_reason,
            created_at
       from transport_bookings
      where tenant_id = $1 and deleted_at is null
      order by created_at desc limit 200`, [T]]
];

/** Every column the board may ever read. Anything else fails this script. */
const ALLOWED_COLUMNS = new Set([
  "id", "tenant_id", "job_id", "shipment_id", "status",
  "cargo_label", "container_type", "container_count", "weight_tonnes", "cbm", "vehicle_types",
  "route_id", "route_label", "distance_km", "expected_duration_hours",
  "pickup_text", "pickup_region_id", "dest_text", "dest_region_id", "via_label", "required_date",
  "contact_user_id", "contact_name", "contact_channel", "public_note",
  "company_name", "company_description", "company_services", "company_corridors",
  "company_website", "fleet_size_declared", "year_established",
  "disclosed_by", "disclosed_at", "cancelled_by", "cancelled_at",
  // Booking summary (migration 048): the booker's company and the server clocks.
  // Never client identity beyond the contact the booker chose to give.
  "booked_by_tenant_id", "booked_by", "booked_company_name", "booked_contact_name",
  "booked_contact_channel", "temp_booked_at", "reminder_sent_at", "released_at", "confirmed_at",
  "created_by", "updated_by", "created_at", "updated_at", "deleted_at"
]);

/** Named so a reviewer sees why each one is absent, not just that it is. */
const MUST_NOT_EXIST = [
  "consignee_name", "consignor_name", "customer_name", "file_number", "seq", "file_year",
  "hs_code", "declaration_mode", "office_declaration", "tansad_number", "rcn_number",
  "bill_number", "reference_number", "container_numbers", "cabinet_position", "shipping_line",
  "terms_delivery", "order_date", "document_receipt_date", "eta", "discharge_date",
  "carry_in_date", "processing_cost", "payment_amount", "payment_status", "notes",
  "storage_path", "document_id", "phone_encrypted", "nida_number", "tin_display"
];

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL or DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 1,
    ssl: { rejectUnauthorized: false } });

  let failed = 0;
  for (const [label, stmt, params] of sql) {
    try {
      await pool.query("explain " + stmt, params);
      console.log("ok   ", label);
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  console.log("\n--- rule 0: transport_requests column allowlist ---");
  const cols = await pool.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'transport_requests'`);
  const names = cols.rows.map((r: any) => r.column_name as string);
  const extras = names.filter((n) => !ALLOWED_COLUMNS.has(n));
  const missing = [...ALLOWED_COLUMNS].filter((n) => !names.includes(n));
  const banned = names.filter((n) => MUST_NOT_EXIST.includes(n));
  if (extras.length) {
    failed++;
    console.log("FAIL  unexpected columns (review before the board reads them):", extras.join(", "));
  }
  if (missing.length) {
    failed++;
    console.log("FAIL  expected columns absent:", missing.join(", "));
  }
  if (banned.length) {
    failed++;
    console.log("FAIL  private columns present:", banned.join(", "));
  }
  if (!extras.length && !missing.length && !banned.length) {
    console.log(`ok    ${names.length} columns, exactly the approved publish set`);
  }

  console.log("\n--- security shape ---");
  const shape = await pool.query(
    `select c.relname as t, c.relrowsecurity as rls,
            (select count(*) from pg_policies p
              where p.tablename = c.relname and p.schemaname = 'public') as policies,
            (select string_agg(distinct privilege_type, ',' order by privilege_type)
               from information_schema.table_privileges
              where table_name = c.relname and grantee = 'app_runtime') as app_grants,
            (select count(*) from pg_indexes i
              where i.tablename = c.relname and i.indexname = 'transport_requests_one_live_job_uq') as live_uq
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'transport_requests'`);
  const r = shape.rows[0];
  if (!r) {
    console.log("FAIL  transport_requests missing");
    failed++;
  } else {
    const want: string[] = [];
    if (!r.rls) want.push("RLS off");
    if (Number(r.policies) === 0) want.push("no tenant policy");
    // After 048 the only table-level privilege left is SELECT: INSERT is
    // column-level (no `status`) and UPDATE is gone — transitions live in the
    // SECURITY DEFINER functions. table_privileges cannot see column grants,
    // so the shape is asserted with has_*_privilege below.
    const grants: string[] = (r.app_grants ?? "").split(",").filter(Boolean);
    const expected = ["SELECT"];
    if (grants.slice().sort().join(",") !== expected.join(","))
      want.push(`table grants are "${r.app_grants ?? "none"}", want ${expected.join("/")} only`);
    if (Number(r.live_uq) !== 1) want.push("one-live-request-per-job index missing");
    if (want.length) { failed++; console.log("FAIL  transport_requests -", want.join("; ")); }
    else console.log(`ok    transport_requests (rls=${r.rls} policies=${r.policies} grants=${r.app_grants})`);
  }

  const priv = (await pool.query(
    `select has_table_privilege('app_runtime','public.transport_requests','UPDATE') as req_update,
            has_column_privilege('app_runtime','public.transport_requests','status','INSERT') as ins_status,
            has_column_privilege('app_runtime','public.transport_requests','cargo_label','INSERT') as ins_label,
            has_table_privilege('app_runtime','public.transport_bookings','SELECT') as book_select,
            has_table_privilege('app_runtime','public.transport_bookings','INSERT') as book_insert,
            has_table_privilege('app_runtime','public.transport_bookings','UPDATE') as book_update`)).rows[0];
  const shapeProblems: string[] = [];
  if (priv.req_update) shapeProblems.push("app_runtime can UPDATE transport_requests directly");
  if (priv.ins_status) shapeProblems.push("app_runtime can INSERT transport_requests.status - clients must not set the state");
  if (!priv.ins_label) shapeProblems.push("app_runtime cannot INSERT transport_requests.cargo_label - publish is broken");
  if (!priv.book_select) shapeProblems.push("app_runtime cannot SELECT transport_bookings");
  if (priv.book_insert) shapeProblems.push("app_runtime can INSERT transport_bookings - writes must go through the functions");
  if (priv.book_update) shapeProblems.push("app_runtime can UPDATE transport_bookings - writes must go through the functions");
  if (shapeProblems.length) {
    failed++;
    for (const p of shapeProblems) console.log("FAIL ", p);
  } else {
    console.log("ok    column-level grants: INSERT without status, no UPDATE, bookings read-only");
  }

  await pool.end();
  if (failed) { console.log(`\n${failed} FAILED`); process.exit(1); }
  console.log("\nall transport SQL valid and the publish surface is an allowlist");
}

main().catch((e) => { console.error(e); process.exit(1); });
