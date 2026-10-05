-- 024: Transport operations — trips, trip shipments (consignments), checkpoint logs.
-- A trip moves one vessel + driver along a route; shipments are the cargo on it;
-- checkpoint logs record weighbridge/border/toll stops passed en route.
begin;

create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  reference text,
  route_id uuid not null references routes(id),
  vessel_id uuid references vessels(id),
  driver_id uuid references drivers(id),
  status text not null default 'planned'
    check (status in ('planned','in_transit','arrived','completed','cancelled')),
  planned_departure timestamptz,
  planned_arrival timestamptz,
  actual_departure timestamptz,
  actual_arrival timestamptz,
  distance_km int,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trips_tenant_reference_uq on trips (tenant_id, reference)
  where reference is not null and deleted_at is null;
create index idx_trips_tenant on trips (tenant_id);
create index idx_trips_tenant_status on trips (tenant_id, status) where deleted_at is null;
create index idx_trips_vessel on trips (vessel_id) where deleted_at is null;
create index idx_trips_driver on trips (driver_id) where deleted_at is null;
create trigger trg_trips_updated before update on trips
  for each row execute function public.set_updated_at();

create table if not exists trip_shipments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  trip_id uuid not null references trips(id),
  customer_name text not null,
  customer_phone_encrypted bytea,
  customer_phone_search text,
  goods_description text,
  package_count int,
  weight_kg numeric(12,2),
  freight_charge numeric(12,2),
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_trip_shipments_tenant on trip_shipments (tenant_id);
create index idx_trip_shipments_trip on trip_shipments (trip_id) where deleted_at is null;
create trigger trg_trip_shipments_updated before update on trip_shipments
  for each row execute function public.set_updated_at();

create table if not exists trip_checkpoint_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  trip_id uuid not null references trips(id),
  route_checkpoint_id uuid references route_checkpoints(id),
  label text not null,
  kind text check (kind in ('weighbridge','border','toll','fuel','rest','town','custom')),
  note text,
  logged_at timestamptz not null default now(),
  logged_by uuid
);
create index idx_trip_checkpoint_logs_trip on trip_checkpoint_logs (trip_id, logged_at);

-- POLICY + GRANT together (016 lesson)
alter table trips enable row level security;
create policy trips_tenant on trips for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on trips to app_runtime;

alter table trip_shipments enable row level security;
create policy trip_shipments_tenant on trip_shipments for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on trip_shipments to app_runtime;

alter table trip_checkpoint_logs enable row level security;
create policy trip_checkpoint_logs_tenant on trip_checkpoint_logs for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on trip_checkpoint_logs to app_runtime;

commit;
