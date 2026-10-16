/**
 * SQL validation for consolidation.routes.ts — plans every statement the module
 * emits against the live schema (EXPLAIN only, nothing executes), then checks
 * the shape migration 055 promised: RLS on all three tables, grants that make
 * them reachable but never let a hard delete through, the indexes the list
 * screens and the parcel gate rely on, the money and weight precisions, the
 * cargo-lane vocabulary the parcel check compares against, the seeded
 * permission matrix, and that no Supabase default role can see any of it.
 * Run: npx tsx scripts/verify-consolidation-sql.ts
 */
import "dotenv/config";
import pg from "pg";

const FAKE_TENANT = "00000000-0000-7000-8000-000000000000";
const FAKE_USER = "11111111-1111-7111-8111-111111111111";
const FAKE_CARRIER = "22222222-2222-7222-8222-222222222222";
const FAKE_MANIFEST = "33333333-3333-7333-8333-333333333333";
const FAKE_PARCEL = "44444444-4444-7444-8444-444444444444";
const FAKE_VESSEL = "55555555-5555-7555-8555-555555555555";
const FAKE_ROUTE = "66666666-6666-7666-8666-666666666666";
const FAKE_SHIPMENT = "77777777-7777-7777-8777-777777777777";

const CARRIER_SELECT = `
  select cc.id, cc.mode, cc.unit_type, cc.display_name, cc.operator_name, cc.registration,
         cc.vessel_id, cc.make, cc.model, cc.year_manufactured, cc.capacity_unit,
         cc.capacity_max, cc.specialisations, cc.home_base, cc.is_active, cc.notes,
         cc.created_at, cc.updated_at,
         (select count(*)::int from consolidations m
           where m.carrier_id = cc.id and m.deleted_at is null
             and m.status <> 'cancelled') as live_manifests
  from consolidation_carriers cc`;

const MANIFEST_SELECT = `
  select m.id, m.manifest_number, m.status, m.carrier_id,
         m.origin_region_id, m.origin_district_id, m.origin_ward_id, m.origin_text,
         m.dest_region_id, m.dest_district_id, m.dest_ward_id, m.dest_text,
         m.route_id, m.shipment_id, m.bill_of_lading, m.container_no, m.seal_no,
         m.container_type, m.departure_date::text as departure_date,
         m.arrival_date::text as arrival_date,
         m.weight_on_board_kg, m.cbm_total, m.parcel_count, m.currency,
         m.transport_fee_total, m.amount_paid_total, m.routing_notes,
         m.created_at, m.updated_at,
         (m.transport_fee_total - m.amount_paid_total)::float8 as balance_due,
         cc.display_name as carrier_name, cc.mode as carrier_mode, cc.unit_type,
         cc.capacity_unit, cc.capacity_max, cc.specialisations, cc.operator_name,
         cc.registration,
         cs.file_number, cs.cargo_description
  from consolidations m
  join consolidation_carriers cc on cc.id = m.carrier_id
  left join cargo_shipments cs on cs.id = m.shipment_id`;

const PARCEL_SELECT = `
  select p.id, p.seq, p.tracking_number, p.consignor_name, p.consignor_email,
         p.consignor_address, p.consignor_phone_encrypted, p.consignor_phone_search,
         p.goods_description, p.package_count, p.package_kind,
         p.marks_numbers, p.net_weight_kg, p.length_m, p.width_m, p.height_m, p.cbm,
         p.specialisation, p.transport_fee, p.amount_paid, p.currency,
         p.payment_reference, p.paid_at::text as paid_at, p.notes,
         case
           when p.transport_fee > 0 and p.amount_paid >= p.transport_fee then 'paid'
           when p.amount_paid > 0 then 'partial'
           else 'unpaid'
         end as payment_status,
         (p.transport_fee - p.amount_paid)::float8 as balance_due
  from consolidation_parcels p`;

const gate = (perm: string) => [`gate: ${perm}`, `select 1 from user_roles ur
     join role_permissions rp on rp.role_id = ur.role_id
     where ur.user_id = $1 and rp.permission_key = $2
       and (ur.expires_at is null or ur.expires_at > now()) limit 1`,
  [FAKE_USER, perm]] as [string, string, unknown[]];

const statements: [string, string, unknown[]][] = [
  gate("consolidation.view"), gate("consolidation.create"), gate("consolidation.edit"),
  gate("consolidation.delete"), gate("consolidation.settle"), gate("consolidation.export"),

  // ---------- Carriers ----------
  ["carriers: list filtered by mode and availability", `
     ${CARRIER_SELECT} where cc.tenant_id = $1 and cc.deleted_at is null and cc.mode = $2
       and cc.is_active = $3
     order by cc.display_name`,
    [FAKE_TENANT, "road", true]],

  ["carriers: vessel link guard", `select id from vessels
     where id = $1 and tenant_id = $2 and deleted_at is null`, [FAKE_VESSEL, FAKE_TENANT]],

  ["carriers: register", `insert into consolidation_carriers (id, tenant_id, mode, unit_type, display_name,
       operator_name, registration, vessel_id, make, model, year_manufactured,
       capacity_unit, capacity_max, specialisations, home_base, is_active, notes,
       created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
    [FAKE_CARRIER, FAKE_TENANT, "road", "trailer", "T149-BKA 22ft Flatbed",
     " Kilian Freightlines ", "T149BKA", null, "Isuzu", "FRR", 2016, "tonnes", 32,
     ["general", "dry_bulk", "hazardous"], "T1 Gate, Dar es Salaam", true, null, FAKE_USER]],

  ["carriers: edit prev fetch", `${CARRIER_SELECT} where cc.id = $1 and cc.tenant_id = $2
     and cc.deleted_at is null`, [FAKE_CARRIER, FAKE_TENANT]],

  ["carriers: a lane still carrying cargo cannot be dropped", `
     select p.tracking_number from consolidation_parcels p
     join consolidations m on m.id = p.manifest_id
     where m.carrier_id = $1 and p.tenant_id = $2 and m.tenant_id = $2
       and m.deleted_at is null and p.deleted_at is null
       and m.status <> 'cancelled' and p.specialisation <> 'general'
       and not (p.specialisation = any($3::text[]))
     limit 3`, [FAKE_CARRIER, FAKE_TENANT, ["general"]]],

  ["carriers: edit", `update consolidation_carriers set capacity_max = $4, specialisations = $5,
       is_active = $6, updated_by = $1, updated_at = now()
     where id = $2 and tenant_id = $3`,
    [FAKE_USER, FAKE_CARRIER, FAKE_TENANT, 30,
     ["general", "dry_bulk"], false]],

  ["carriers: retirement guard counts open legs", `
     select cc.display_name, cc.registration,
            (select count(*)::int from consolidations m
              where m.carrier_id = cc.id and m.deleted_at is null
                and m.status <> 'cancelled') as live
     from consolidation_carriers cc
     where cc.id = $1 and cc.tenant_id = $2 and cc.deleted_at is null`,
    [FAKE_CARRIER, FAKE_TENANT]],

  ["carriers: retire", `update consolidation_carriers set deleted_at = now(), updated_by = $2,
       updated_at = now() where id = $1 and tenant_id = $3`,
    [FAKE_CARRIER, FAKE_USER, FAKE_TENANT]],

  // ---------- Manifests ----------
  ["manifests: list with search across paper and carrier", `
     ${MANIFEST_SELECT} where m.deleted_at is null and m.tenant_id = $1
       and m.status = $2
       and (lower(m.manifest_number) like $3 or lower(m.bill_of_lading) like $3
            or lower(m.container_no) like $3 or lower(cc.display_name) like $3)
     order by m.created_at desc limit 200`,
    [FAKE_TENANT, "in_transit", "%t149bka%"]],

  ["manifests: kpis", `select count(*)::int as manifests,
          coalesce(sum(m.transport_fee_total), 0)::float8 as billed,
          coalesce(sum(m.amount_paid_total), 0)::float8 as collected,
          coalesce(sum(m.transport_fee_total - m.amount_paid_total)
                   filter (where m.status <> 'cancelled'), 0)::float8 as outstanding,
          count(*) filter (where m.status = 'in_transit')::int as in_transit
     from consolidations m where m.tenant_id = $1 and m.deleted_at is null`,
    [FAKE_TENANT]],

  ["manifests: number sequence", `select coalesce(max(nullif(regexp_replace(manifest_number, '\\D', '', 'g'), '')::bigint), 0) + 1 as next
     from consolidations where tenant_id = $1 and deleted_at is null`, [FAKE_TENANT]],

  ["manifests: a ward must sit in the picked district", `select district_id from geo_wards where id = $1`, [145]],
  ["manifests: a district must sit in the picked region", `select region_id from geo_districts where id = $1`, [12]],
  ["manifests: label the ward", `select name from geo_wards where id = $1`, [145]],
  ["manifests: label the council", `select name_en from geo_districts where id = $1`, [12]],
  ["manifests: label the region", `select name_en from geo_regions where id = $1`, [1]],

  ["manifests: the carrier must be one of ours and on duty", `
     select id, display_name from consolidation_carriers
     where id = $1 and tenant_id = $2 and deleted_at is null and is_active`,
    [FAKE_CARRIER, FAKE_TENANT]],

  ["manifests: route guard", `select id from routes where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_ROUTE, FAKE_TENANT]],
  ["manifests: cargo file guard", `select id from cargo_shipments
     where id = $1 and tenant_id = $2 and deleted_at is null`, [FAKE_SHIPMENT, FAKE_TENANT]],

  ["manifests: open a leg", `insert into consolidations (id, tenant_id, manifest_number, carrier_id,
       origin_region_id, origin_district_id, origin_ward_id, origin_text,
       dest_region_id, dest_district_id, dest_ward_id, dest_text,
       route_id, shipment_id, bill_of_lading, container_no, seal_no, container_type,
       departure_date, arrival_date, currency, routing_notes, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23)`,
    [FAKE_MANIFEST, FAKE_TENANT, "CSL-0001", FAKE_CARRIER,
     1, 12, 145, "Berth 4, T1 Container Terminal", 5, 44, 210, "Plot 27, Kisuluilui",
     FAKE_ROUTE, FAKE_SHIPMENT, "TZDL261709619", "MSKU7742013", "SN4481902", "40ft",
     "2026-10-17", "2026-10-19", "TZS", "Avoid the Weightmo bridge — declared at 32t.", FAKE_USER]],

  ["manifests: detail head", `${MANIFEST_SELECT} where m.id = $1 and m.tenant_id = $2
     and m.deleted_at is null`, [FAKE_MANIFEST, FAKE_TENANT]],
  ["manifests: detail parcels", `${PARCEL_SELECT} where p.manifest_id = $1 and p.tenant_id = $2
     and p.deleted_at is null order by p.seq`, [FAKE_MANIFEST, FAKE_TENANT]],
  ["manifests: detail carrier", `${CARRIER_SELECT} where cc.id = $1 and cc.tenant_id = $2`,
    [FAKE_CARRIER, FAKE_TENANT]],
  ["manifests: detail route", `select id, name, corridor, distance_km, expected_duration_hours
     from routes where id = $1 and tenant_id = $2`, [FAKE_ROUTE, FAKE_TENANT]],

  ["manifests: swapping the unit cannot strand cargo", `
     select p.tracking_number, p.specialisation from consolidation_parcels p
     where p.manifest_id = $1 and p.tenant_id = $2 and p.deleted_at is null
       and p.specialisation is not null and p.specialisation <> 'general'
       and not (p.specialisation = any($3::text[]))
     order by p.seq limit 3`, [FAKE_MANIFEST, FAKE_TENANT, ["general", "refrigerated"]]],

  ["manifests: edit", `update consolidations set carrier_id = $4, departure_date = $5,
       arrival_date = $6, origin_ward_id = $7, origin_text = $8, dest_text = $9,
       updated_by = $1, updated_at = now()
     where id = $2 and tenant_id = $3`,
    [FAKE_USER, FAKE_MANIFEST, FAKE_TENANT, FAKE_CARRIER, "2026-10-18", "2026-10-20",
     146, "Berth 6", "Buguruni, plot 27"]],

  ["manifests: status head", `select status, parcel_count, manifest_number from consolidations
     where id = $1 and tenant_id = $2 and deleted_at is null`, [FAKE_MANIFEST, FAKE_TENANT]],
  ["manifests: move the leg", `update consolidations set status = $3, updated_by = $4, updated_at = now()
     where id = $1 and tenant_id = $2`, [FAKE_MANIFEST, FAKE_TENANT, "manifested", FAKE_USER]],

  ["manifests: a settled leg cannot be deleted", `
     select status, manifest_number, amount_paid_total::float8 as paid from consolidations
     where id = $1 and tenant_id = $2 and deleted_at is null`, [FAKE_MANIFEST, FAKE_TENANT]],
  ["manifests: delete", `update consolidations set deleted_at = now(), updated_by = $2,
     updated_at = now() where id = $1 and tenant_id = $3`,
    [FAKE_MANIFEST, FAKE_USER, FAKE_TENANT]],
  ["manifests: delete takes its parcels with it", `update consolidation_parcels set deleted_at = now(),
       updated_at = now() where manifest_id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_MANIFEST, FAKE_TENANT]],

  // ---------- Parcels ----------
  ["parcels: gate reads the leg and its carrier's lanes", `
     select m.manifest_number, m.status, cc.specialisations
     from consolidations m
     join consolidation_carriers cc on cc.id = m.carrier_id
     where m.id = $1 and m.tenant_id = $2 and m.deleted_at is null`,
    [FAKE_MANIFEST, FAKE_TENANT]],

  ["parcels: the sequence never reissues a printed tracking number", `
     select coalesce(max(seq), 0) + 1 as next from consolidation_parcels
     where manifest_id = $1 and tenant_id = $2`, [FAKE_MANIFEST, FAKE_TENANT]],

  ["parcels: add a piece", `insert into consolidation_parcels (id, tenant_id, manifest_id, seq, tracking_number,
       consignor_name, consignor_phone_encrypted, consignor_phone_search, consignor_email,
       consignor_address, goods_description, package_count, package_kind, marks_numbers,
       net_weight_kg, length_m, width_m, height_m, cbm, specialisation, transport_fee,
       currency, notes, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
       (select currency from consolidations where id = $3),$22,$23,$23)`,
    [FAKE_PARCEL, FAKE_TENANT, FAKE_MANIFEST, 1, "CSL-0001-001", "Juma Mkwawa",
     Buffer.from("cipher"), "hash", "juma@consignor.test", "P O Box 88, Mwanza",
     "80 bags of cement", 80, "bag", "KIL-01", 3996.5, 1.2, 0.6, 0.15, 0.108, "general",
     280000, "Stuffed at the T1 CFS", FAKE_USER]],

  ["parcels: fetch one line of this leg", `
     select p.*, m.manifest_number, m.status as manifest_status
     from consolidation_parcels p
     join consolidations m on m.id = p.manifest_id
     where p.id = $1 and p.manifest_id = $2 and p.tenant_id = $3
       and p.deleted_at is null and m.deleted_at is null`,
    [FAKE_PARCEL, FAKE_MANIFEST, FAKE_TENANT]],

  ["parcels: edit a line, with the phone and the recomputed cube", `
     update consolidation_parcels set goods_description = $4, net_weight_kg = $5,
       length_m = $6, consignor_phone_encrypted = $7, consignor_phone_search = $8, cbm = $9,
       updated_by = $1, updated_at = now()
     where id = $2 and tenant_id = $3 and manifest_id = $10`,
    [FAKE_USER, FAKE_PARCEL, FAKE_TENANT, "80 bags of cement, 2 torn", 3998,
     1.25, Buffer.from("cipher"), "hash2", 0.113, FAKE_MANIFEST]],

  ["parcels: the leg totals are the sum of its pieces", `
     select coalesce(sum(net_weight_kg), 0)::float8 as kg,
            coalesce(sum(cbm), 0)::float8 as cbm,
            count(*)::int as pieces,
            coalesce(sum(transport_fee), 0)::float8 as fees,
            coalesce(sum(amount_paid), 0)::float8 as paid
     from consolidation_parcels
     where manifest_id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_MANIFEST, FAKE_TENANT]],

  ["parcels: the totals are stamped back on the manifest", `
     update consolidations set weight_on_board_kg = $3, cbm_total = $4, parcel_count = $5,
            transport_fee_total = $6, amount_paid_total = $7, updated_at = now()
     where id = $1 and tenant_id = $2 and deleted_at is null`,
    [FAKE_MANIFEST, FAKE_TENANT, 3998, 0.113, 1, 280000, 0]],

  ["parcels: settle a piece", `update consolidation_parcels set amount_paid = $3, payment_reference = $4,
       paid_at = coalesce($5, paid_at, current_date), updated_by = $6, updated_at = now()
     where id = $1 and tenant_id = $2 and manifest_id = $7`,
    [FAKE_PARCEL, FAKE_TENANT, 150000, "CRDB DEP 88214", "2026-10-18", FAKE_USER, FAKE_MANIFEST]],

  ["parcels: a settled piece cannot come off the leg", `update consolidation_parcels set deleted_at = now(),
       updated_by = $3, updated_at = now()
     where id = $1 and tenant_id = $2 and manifest_id = $4`,
    [FAKE_PARCEL, FAKE_TENANT, FAKE_USER, FAKE_MANIFEST]],

  // Statements the vault needs to be able to hold a manifest's papers.
  ["vault: a manifest paper is stamped consolidation", `
     select id, file_name, mime_type, storage_path, entity_type, entity_id
     from documents
     where id = $1 and tenant_id = $2 and entity_type = 'consolidation' and entity_id = $3
       and deleted_at is null`,
    ["99999999-9999-7999-8999-999999999999", FAKE_TENANT, FAKE_MANIFEST]]
];

const shapeChecks: [string, string, (rows: any[]) => boolean][] = [
  ["all three tables enforce RLS", `
     select relname, relrowsecurity from pg_class
     where relname in ('consolidation_carriers','consolidations','consolidation_parcels')`,
    (r) => r.length === 3 && r.every((x: any) => x.relrowsecurity === true)],

  ["each has a single-tenant policy on every write", `
     select tablename, cmd, roles, qual, with_check from pg_policies
     where tablename in ('consolidation_carriers','consolidations','consolidation_parcels')`,
    (r) => r.length === 3 && r.every((x: any) => x.cmd === "ALL" && x.roles === "{app_runtime}"
      && /tenant_id = \(?nullif\(current_setting\('app\.tenant_id'/i.test(x.qual)
      && /tenant_id = \(?nullif\(current_setting\('app\.tenant_id'/i.test(x.with_check))],

  ["app_runtime can read all three", `
     select distinct table_name from information_schema.role_table_grants
     where grantee = 'app_runtime' and privilege_type = 'SELECT'
       and table_name in ('consolidation_carriers','consolidations','consolidation_parcels')`,
    (r) => r.length === 3],

  ["app_runtime can never hard-delete consolidation paper", `
     select table_name, privilege_type from information_schema.role_table_grants
     where grantee = 'app_runtime' and privilege_type = 'DELETE'
       and table_name in ('consolidation_carriers','consolidations','consolidation_parcels')`,
    (r) => r.length === 0],

  ["carriers and manifests are insert/update only", `
     select table_name, string_agg(privilege_type, ',' order by privilege_type) as privs
     from information_schema.role_table_grants
     where grantee = 'app_runtime'
       and table_name in ('consolidation_carriers','consolidations')
     group by table_name`,
    (r) => r.length === 2 && r.every((x: any) => x.privs === "INSERT,SELECT,UPDATE")],

  ["the indexes the screens and the gates need exist", `
     select indexname from pg_indexes
     where indexname in ('consolidation_carriers_tenant_reg_uq',
       'idx_consolidation_carriers_tenant_mode','consolidations_tenant_number_uq',
       'idx_consolidations_tenant_status','idx_consolidations_carrier',
       'idx_consolidations_shipment','consolidation_parcels_manifest_seq_uq',
       'consolidation_parcels_tenant_tracking_uq','idx_consolidation_parcels_manifest',
       'idx_consolidation_parcels_phone_search')`,
    (r) => r.length === 10],

  ["a removed parcel frees its sequence slot but a live one never shares it", `
     select indexdef from pg_indexes
     where indexname in ('consolidation_parcels_manifest_seq_uq',
       'consolidation_parcels_tenant_tracking_uq','consolidations_tenant_number_uq')`,
    (r) => r.length === 3 && r.every((x: any) => /deleted_at is null/i.test(x.indexdef))],

  ["the tracking unique is per tenant", `
     select indexdef from pg_indexes where indexname = 'consolidation_parcels_tenant_tracking_uq'`,
    (r) => /\(tenant_id, tracking_number\)/.test(String(r[0]?.indexdef))],

  ["one line per position on a leg", `
     select indexdef from pg_indexes where indexname = 'consolidation_parcels_manifest_seq_uq'`,
    (r) => /\(manifest_id, seq\)/.test(String(r[0]?.indexdef))],

  ["a leg always rides a carrier", `
     select is_nullable from information_schema.columns
     where table_name = 'consolidations' and column_name = 'carrier_id'`,
    (r) => r[0]?.is_nullable === "NO"],

  ["the ward columns are the int geography keys", `
     select column_name, data_type from information_schema.columns
     where table_name = 'consolidations'
       and column_name in ('origin_region_id','origin_district_id','origin_ward_id',
                           'dest_region_id','dest_district_id','dest_ward_id')`,
    (r) => r.length === 6 && r.every((x: any) => x.data_type === "integer")],

  ["the consignor phone is sealed and searchable, never plain", `
     select column_name, data_type from information_schema.columns
     where table_name = 'consolidation_parcels'
       and column_name in ('consignor_phone_encrypted','consignor_phone_search')`,
    (r) => r.length === 2
      && r.some((x: any) => x.column_name === "consignor_phone_encrypted" && x.data_type === "bytea")
      && r.some((x: any) => x.column_name === "consignor_phone_search" && x.data_type === "text")],

  ["no plaintext consignor phone column exists", `
     select column_name from information_schema.columns
     where table_name = 'consolidation_parcels' and column_name = 'consignor_phone'`,
    (r) => r.length === 0],

  ["money is 2dp, weight 3dp, capacity and cube their own", `
     select table_name || '.' || column_name as col, numeric_precision, numeric_scale
     from information_schema.columns
     where (table_name, column_name) in (
       ('consolidations','transport_fee_total'), ('consolidations','amount_paid_total'),
       ('consolidations','weight_on_board_kg'), ('consolidation_parcels','transport_fee'),
       ('consolidation_parcels','amount_paid'), ('consolidation_parcels','net_weight_kg'),
       ('consolidation_parcels','length_m'), ('consolidation_carriers','capacity_max'))`,
    (r) => r.length === 8
      && r.filter((x: any) => x.numeric_precision === 14 && x.numeric_scale === 2).length === 4
      && r.filter((x: any) => x.numeric_precision === 14 && x.numeric_scale === 3).length === 1
      && r.filter((x: any) => x.numeric_precision === 12 && x.numeric_scale === 3).length === 2
      && r.filter((x: any) => x.numeric_precision === 6 && x.numeric_scale === 2).length === 1],

  ["cargo weight and freight cannot go negative", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'consolidation_parcels'::regclass
       and (pg_get_constraintdef(oid) ilike '%net_weight_kg >=%'
            or pg_get_constraintdef(oid) ilike '%transport_fee >=%'
            or pg_get_constraintdef(oid) ilike '%amount_paid >=%'
            or pg_get_constraintdef(oid) ilike '%package_count%')`,
    (r) => r.length === 4],

  // Postgres renders a CHECK over a value list as `col = ANY (ARRAY[…])`, so
  // these are read by their automatic constraint names, not by pattern guessing.
  ["the four modes of carrying a load", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conname = 'consolidation_carriers_mode_check'`,
    (r) => ["road", "marine", "air", "rail"].every((v) => String(r[0]?.def).includes(`'${v}'::text`))],

  ["the carrier unit vocabulary matches the fleet plus air", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conname = 'consolidation_carriers_unit_type_check'`,
    (r) => ["truck_head", "trailer", "tanker", "flatbed", "tipper", "reefer",
      "box_truck", "van", "pickup", "lowbed", "barge", "boat", "cargo_ship", "ferry",
      "tank_barge", "rail_wagon", "air_freighter", "air_charter"]
      .every((v) => String(r[0]?.def).includes(`'${v}'::text`))],

  ["the fleet vocabulary is a subset, so the two cannot drift", `
     select conname, pg_get_constraintdef(oid) as def from pg_constraint
     where conname in ('vessels_vessel_type_check','consolidation_carriers_unit_type_check')`,
    (r) => {
      const fleet = String(r.find((x: any) => x.conname === "vessels_vessel_type_check")?.def ?? "");
      const carrier = String(r.find((x: any) => x.conname === "consolidation_carriers_unit_type_check")?.def ?? "");
      if (!fleet || !carrier) return false;
      return (fleet.match(/'[a-z_]+(?='::text)/g) ?? []).every((v) => carrier.includes(v));
    }],

  ["cargo lanes are the six the app offers", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conname = 'consolidation_parcels_specialisation_check'`,
    (r) => ["general", "dry_bulk", "liquid_bulk", "refrigerated", "hazardous", "live_animals"]
      .every((v) => String(r[0]?.def).includes(`'${v}'::text`))],

  ["capacity carries its own unit, so modes do not fake one number", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conname = 'consolidation_carriers_capacity_unit_check'`,
    (r) => ["tonnes", "kg", "teu", "m3"].every((v) => String(r[0]?.def).includes(`'${v}'::text`))],

  ["the container slots a leg can declare", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conname = 'consolidations_container_type_check'`,
    (r) => ["20ft", "40ft", "loose_cargo", "car"]
      .every((v) => String(r[0]?.def).includes(`'${v}'::text`))],

  ["a carrier's lanes are checked against the same six", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'consolidation_carriers'::regclass
       and pg_get_constraintdef(oid) ilike '%specialisations <@%'`,
    (r) => ["general", "dry_bulk", "liquid_bulk", "refrigerated", "hazardous", "live_animals"]
      .every((v) => String(r[0]?.def).includes(`'${v}'`))],

  ["the leg lifecycle is the five the routes move through", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conname = 'consolidations_status_check'`,
    (r) => ["draft", "manifested", "in_transit", "delivered", "cancelled"]
      .every((v) => String(r[0]?.def).includes(`'${v}'`))],

  ["paid and unpaid are never stored, only derived", `
     select column_name from information_schema.columns
     where table_name in ('consolidations','consolidation_parcels')
       and (column_name ilike '%payment_status%' or column_name ilike '%balance%')`,
    (r) => r.length === 0],

  ["weight on board defaults to nothing, so a fresh leg cannot claim a tonnage", `
     select column_default from information_schema.columns
     where table_name = 'consolidations' and column_name = 'weight_on_board_kg'`,
    (r) => String(r[0]?.column_default).startsWith("0")],

  ["the vault accepts a consolidation's papers", `
     select pg_get_constraintdef(oid) as def from pg_constraint
     where conname = 'documents_entity_type_check'`,
    (r) => String(r[0]?.def).includes("'consolidation'")],

  ["the six consolidation permissions exist", `
     select count(*)::int as n from permissions where key like 'consolidation.%'`,
    (r) => r[0]?.n === 6],

  ["the director holds all six", `
     select count(*)::int as n from role_permissions rp
     join roles r on r.id = rp.role_id
     where r.key = 'director' and r.tenant_id is null and rp.permission_key like 'consolidation.%'`,
    (r) => r[0]?.n === 6],

  ["read-only desks can only look and print", `
     select r.key, count(*)::int as n,
            count(*) filter (where rp.permission_key not in
              ('consolidation.view','consolidation.export'))::int as writes
     from role_permissions rp join roles r on r.id = rp.role_id
     where r.key in ('auditor','general_manager') and r.tenant_id is null
       and rp.permission_key like 'consolidation.%'
     group by r.key`,
    (r) => r.length === 2 && r.every((x: any) => x.n === 2 && x.writes === 0)],

  ["the dispatch desk builds legs but never touches money", `
     select count(*) filter (where permission_key = 'consolidation.settle')::int as settles,
            count(*)::int as n
     from role_permissions rp join roles r on r.id = rp.role_id
     where r.key in ('operations_manager','dispatcher') and r.tenant_id is null
       and rp.permission_key like 'consolidation.%'`,
    (r) => r[0]?.n === 8 && r[0]?.settles === 0],

  ["finance settles, and cannot rewrite the load", `
     select count(*) filter (where permission_key = 'consolidation.settle')::int as settles,
            count(*) filter (where permission_key in ('consolidation.edit','consolidation.create',
              'consolidation.delete'))::int as edits
     from role_permissions rp join roles r on r.id = rp.role_id
     where r.key in ('finance_officer','billing_admin') and r.tenant_id is null
       and rp.permission_key like 'consolidation.%'`,
    (r) => r[0]?.settles === 2 && r[0]?.edits === 0],

  ["everyone else sees the register and nothing more", `
     select count(*) filter (where permission_key <> 'consolidation.view')::int as extra,
            count(*)::int as n
     from role_permissions rp join roles r on r.id = rp.role_id
     where r.key in ('trainee','customer_service','support_engineer') and r.tenant_id is null
       and rp.permission_key like 'consolidation.%'`,
    (r) => r[0]?.n === 3 && r[0]?.extra === 0],

  // 051 stopped the inheritance that handed anon/authenticated every new object
  // and left service_role alone on purpose (it backs the Supabase dashboard's own
  // API access). This asserts the leak actually stayed shut for 055's tables.
  ["no browser-reachable Supabase role can touch the new tables", `
     select table_name, grantee from information_schema.role_table_grants
     where grantee in ('anon','authenticated')
       and table_name in ('consolidation_carriers','consolidations','consolidation_parcels')`,
    (r) => r.length === 0],

  ["the vault role for a manifest is not widened beyond the app", `
     select grantee from information_schema.role_table_grants
     where table_name = 'documents' and grantee not in ('app_runtime','postgres','service_role')`,
    (r) => r.length === 0],

  ["triggers stamp updated_at on all three", `
     select tgrelid::regclass::text as tbl, count(*)::int as n from pg_trigger
     where tgname in ('trg_consolidation_carriers_updated','trg_consolidations_updated',
                      'trg_consolidation_parcels_updated')
       and not tgisinternal
     group by tbl`,
    (r) => r.length === 3]
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  let failed = 0;

  for (const [label, sql, params] of statements) {
    try {
      await pool.query("explain " + sql, params);
      console.log("ok   ", label);
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  for (const [label, sql, ok] of shapeChecks) {
    try {
      const { rows } = await pool.query(sql);
      const pass = ok(rows);
      console.log(pass ? "ok   " : "FAIL ", label, pass ? "" : `-> ${JSON.stringify(rows).slice(0, 240)}`);
      if (!pass) failed++;
    } catch (e: any) {
      failed++;
      console.log("FAIL ", label, "-", e.message);
    }
  }

  await pool.end();
  if (failed) { console.log(`${failed} FAILED`); process.exit(1); }
  console.log(`consolidation SQL and 055 shape valid (${statements.length} statements, ${shapeChecks.length} shape checks)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
