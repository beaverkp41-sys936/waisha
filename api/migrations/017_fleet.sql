-- 017: Fleet - vessels (spec 6.3)
begin;

create table if not exists vessels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  branch_id uuid references branches(id),
  name text not null,
  vessel_type text not null check (vessel_type in
    ('truck_head','trailer','tanker','flatbed','tipper','reefer','box_truck','van','pickup','lowbed','barge','boat','rail_wagon')),
  plate_number text not null,
  chassis_vin text,
  engine_number text,
  make text, model text, year_manufactured int,
  capacity_tonnes numeric(8,2),
  capacity_m3 numeric(8,2),
  capacity_teu int,
  fuel_type text not null default 'diesel'
    check (fuel_type in ('diesel','petrol','cng','lng','electric','hydrogen','hybrid')),
  odometer_km int not null default 0,
  insurance_policy text,
  insurance_expiry date,
  inspection_expiry date,
  road_licence_expiry date,
  status text not null default 'standby'
    check (status in ('on_route','standby','booked','in_garage','out_of_service')),
  status_reason text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index vessels_tenant_plate_uq on vessels (tenant_id, plate_number)
  where deleted_at is null;
create index idx_vessels_tenant on vessels (tenant_id);
create index idx_vessels_status on vessels (status);
create trigger trg_vessels_updated before update on vessels
  for each row execute function public.set_updated_at();

-- POLICY + GRANT together (the rule)
alter table vessels enable row level security;
create policy vessels_tenant on vessels for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on vessels to app_runtime;

commit;