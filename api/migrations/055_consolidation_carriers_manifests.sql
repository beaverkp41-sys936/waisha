-- 055: Consolidator & Transport Management — a register of the units that
-- actually move a consolidated load (mainland truck and trailer, marine
-- vessel, air freight, rail), the consolidation manifest that groups
-- less-than-container-load parcels onto one of those units for one leg, and
-- the parcels themselves with their own tracking identity, consignor, net
-- weight, dimensions and transport-fee settlement.
--
-- Three deliberate calls:
--
-- 1. A carrier is NOT a fleet vessel. `vessels` (017) is the operator's own
--    maintained fleet — it drives the trial cap, status sync, fuel, incidents
--    and garage, and a consolidator routinely names a third party's truck or
--    an airline's hold. So `consolidation_carriers` is its own row and points
--    at `vessels` only when the unit happens to be one of ours. Its `unit_type`
--    vocabulary is `vessels.vessel_type` (017/018) plus the two air types, so
--    the two tables cannot drift apart.
--
-- 2. Nothing here moves money. A parcel carries the fee it owes and the amount
--    the clerk was told has arrived, plus the reference the payer typed. Paid
--    / partially paid / unpaid is derived from those two numbers and never
--    stored, exactly as `freight_invoices` does it (029), so a status can
--    never disagree with the money beneath it.
--
-- 3. Weight on board is stamped from the parcels, not typed. A manifest that
--    claims a tonnage its own pieces do not add up to is the difference between
--    a load plan and a fine, so the route sums the parcel net weights on every
--    write and the carrier's stated capacity is compared against that sum.
begin;

-- ---------- Carriers: the multi-modal unit doing the leg ----------
create table if not exists consolidation_carriers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- How the load physically moves.
  mode text not null check (mode in ('road','marine','air','rail')),
  -- The unit inside the mode. Mirrors vessels.vessel_type (017:14, 018:5-7)
  -- and adds the air types the fleet table has never needed.
  unit_type text not null check (unit_type in (
    'truck_head','trailer','tanker','flatbed','tipper','reefer','box_truck','van',
    'pickup','lowbed','barge','boat','cargo_ship','ferry','tank_barge','rail_wagon',
    'air_freighter','air_charter')),
  display_name text not null,
  -- Who is hauling it, when that is not this tenant.
  operator_name text,
  -- Plate / IMO / wagon / tail number, whichever the mode uses.
  registration text,
  -- Set when the unit is one of our own fleet assets. Nullable FK with no
  -- cascade, the house pattern (024:12, 033:10-11): losing a fleet row must
  -- never take a filed manifest with it.
  vessel_id uuid references vessels(id),
  make text,
  model text,
  year_manufactured int check (year_manufactured is null
    or (year_manufactured >= 1900 and year_manufactured <= 2100)),
  -- A trailer is stated in tonnes, air freight in kilos, a marine slot in TEUs
  -- and a cube load in cubic metres, so capacity carries its own unit rather
  -- than pretending one column fits all four modes.
  capacity_unit text not null default 'tonnes'
    check (capacity_unit in ('tonnes','kg','teu','m3')),
  capacity_max numeric(12,3) check (capacity_max is null or capacity_max >= 0),
  -- What the unit is equipped and permitted to carry. A subset check, not a
  -- join table: the six specialisations are a fixed product vocabulary
  -- (transport_requests.vehicle_types, 044:32-34, does the same).
  specialisations text[] not null default '{}'
    check (specialisations <@ array['general','dry_bulk','liquid_bulk',
                                    'refrigerated','hazardous','live_animals']),
  home_base text,
  is_active boolean not null default true,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index consolidation_carriers_tenant_reg_uq
  on consolidation_carriers (tenant_id, registration)
  where deleted_at is null and registration is not null;
create index idx_consolidation_carriers_tenant_mode
  on consolidation_carriers (tenant_id, mode, is_active) where deleted_at is null;

alter table consolidation_carriers enable row level security;
create policy consolidation_carriers_tenant on consolidation_carriers for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on consolidation_carriers to app_runtime;

create trigger trg_consolidation_carriers_updated before update on consolidation_carriers
  for each row execute function public.set_updated_at();

-- ---------- The manifest: one unit, one leg, many parcels ----------
create table if not exists consolidations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  manifest_number text not null,
  carrier_id uuid not null references consolidation_carriers(id),
  -- Cascading geography down to the ward on both ends: geo_regions (Mkoa) →
  -- geo_districts (Wilaya) → geo_wards (Kata). The *_text columns carry what
  -- the picker cannot express — berth, terminal, gate, plot.
  origin_region_id int references geo_regions(id),
  origin_district_id int references geo_districts(id),
  origin_ward_id int references geo_wards(id),
  origin_text text,
  dest_region_id int references geo_regions(id),
  dest_district_id int references geo_districts(id),
  dest_ward_id int references geo_wards(id),
  dest_text text,
  -- The corridor this leg runs on, when it matches a mapped route (that is
  -- where OSRM distance and duration come from).
  route_id uuid references routes(id),
  -- The CFA file being consolidated, when the manifest serves one.
  shipment_id uuid references cargo_shipments(id),
  bill_of_lading text,
  container_no text,
  seal_no text,
  container_type text check (container_type in ('20ft','40ft','loose_cargo','car')),
  departure_date date,
  arrival_date date,
  -- Stamped by the route from the parcel rows; never typed. Kilos, whatever
  -- unit the carrier states its capacity in, so the two are comparable.
  weight_on_board_kg numeric(14,3) not null default 0,
  cbm_total numeric(12,3) not null default 0,
  parcel_count int not null default 0,
  currency text not null default 'TZS',
  transport_fee_total numeric(14,2) not null default 0,
  amount_paid_total numeric(14,2) not null default 0,
  -- Base lifecycle only. Whether the leg has been billed or settled is read
  -- off the money, not stored beside it.
  status text not null default 'draft'
    check (status in ('draft','manifested','in_transit','delivered','cancelled')),
  routing_notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index consolidations_tenant_number_uq on consolidations (tenant_id, manifest_number)
  where deleted_at is null;
create index idx_consolidations_tenant_status on consolidations (tenant_id, status, created_at desc)
  where deleted_at is null;
create index idx_consolidations_carrier on consolidations (carrier_id) where deleted_at is null;
create index idx_consolidations_shipment on consolidations (shipment_id) where deleted_at is null;

alter table consolidations enable row level security;
create policy consolidations_tenant on consolidations for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on consolidations to app_runtime;

create trigger trg_consolidations_updated before update on consolidations
  for each row execute function public.set_updated_at();

-- ---------- LCL parcels: one row per piece riding the leg ----------
-- tenant_id is carried redundantly rather than reached through the manifest so
-- the policy above stays single-table, the same reason quotation_items (052:203)
-- and trip_shipments (024:44) do it.
create table if not exists consolidation_parcels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  manifest_id uuid not null references consolidations(id),
  seq int not null,
  -- Minted by the route as <manifest number>-<seq>, so the number printed on
  -- the piece and the number in the app are the same string.
  tracking_number text not null,
  consignor_name text not null,
  -- Phone is PII and goes through encryptField/searchHash (api/src/util/crypto.ts);
  -- the list endpoints never return the ciphertext.
  consignor_phone_encrypted bytea,
  consignor_phone_search text,
  consignor_email text,
  consignor_address text,
  goods_description text not null,
  package_count int not null default 1 check (package_count >= 1),
  package_kind text,
  marks_numbers text,
  -- What the piece weighs and the space it takes, as measured — the manifest
  -- totals are the sum of these, not a separate claim.
  net_weight_kg numeric(12,3) not null default 0 check (net_weight_kg >= 0),
  length_m numeric(6,2) check (length_m is null or length_m >= 0),
  width_m numeric(6,2) check (width_m is null or width_m >= 0),
  height_m numeric(6,2) check (height_m is null or height_m >= 0),
  cbm numeric(12,3) not null default 0 check (cbm >= 0),
  -- Which specialisation lane this piece sits in, when it is not general. The
  -- route checks it is a member of the carrier's list before it lets the
  -- parcel on board: a DG drum cannot be added to a plain box trailer.
  specialisation text check (specialisation in ('general','dry_bulk','liquid_bulk',
                                                'refrigerated','hazardous','live_animals')),
  transport_fee numeric(14,2) not null default 0 check (transport_fee >= 0),
  amount_paid numeric(14,2) not null default 0 check (amount_paid >= 0),
  currency text not null default 'TZS',
  -- The reference the payer wrote on the slip. There is no gateway, no stored
  -- instrument and nothing here that could move funds.
  payment_reference text,
  paid_at date,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index consolidation_parcels_manifest_seq_uq on consolidation_parcels (manifest_id, seq)
  where deleted_at is null;
create unique index consolidation_parcels_tenant_tracking_uq
  on consolidation_parcels (tenant_id, tracking_number) where deleted_at is null;
create index idx_consolidation_parcels_manifest on consolidation_parcels (manifest_id)
  where deleted_at is null;
create index idx_consolidation_parcels_phone_search on consolidation_parcels (consignor_phone_search);

alter table consolidation_parcels enable row level security;
create policy consolidation_parcels_tenant on consolidation_parcels for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- No DELETE: a parcel that was on a filed manifest is soft-deleted, so the
-- paper record of what was on board survives. Same posture as 054 took for the
-- billing tables.
grant select, insert, update on consolidation_parcels to app_runtime;

create trigger trg_consolidation_parcels_updated before update on consolidation_parcels
  for each row execute function public.set_updated_at();

-- ---------- The vault can hold a manifest's papers ----------
alter table documents drop constraint documents_entity_type_check;
alter table documents add constraint documents_entity_type_check
  check (entity_type in ('tenant','user','vessel','driver','trip','shipment','message',
                         'licence','employee','office_cost','quotation','consolidation'));

-- ---------- Permission keys ----------
-- `consolidation` is not in the seed.sql module cross-join, so these keys and
-- their role matrix exist only here.
insert into permissions (key, description)
values
  ('consolidation.view', 'Consolidation - View carriers, manifests and parcels'),
  ('consolidation.create', 'Consolidation - Register a carrier or open a manifest'),
  ('consolidation.edit', 'Consolidation - Edit carriers, routing and parcel lines'),
  ('consolidation.delete', 'Consolidation - Close out or delete a manifest'),
  ('consolidation.settle', 'Consolidation - Record transport-fee payments against a parcel'),
  ('consolidation.export', 'Consolidation - Print or export the manifest')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'consolidation.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

-- Read and print, never write.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('consolidation.view', 'consolidation.export')
where r.key in ('auditor', 'general_manager') and r.tenant_id is null
on conflict do nothing;

-- The desk that builds the load.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('consolidation.view', 'consolidation.create',
  'consolidation.edit', 'consolidation.export')
where r.key in ('operations_manager', 'dispatcher') and r.tenant_id is null
on conflict do nothing;

-- Money in against a parcel is a finance act, not a dispatch act.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('consolidation.view', 'consolidation.settle', 'consolidation.export')
where r.key in ('finance_officer', 'billing_admin') and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key = 'consolidation.view'
where r.key in ('trainee', 'customer_service', 'support_engineer') and r.tenant_id is null
on conflict do nothing;

commit;
