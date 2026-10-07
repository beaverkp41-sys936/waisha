-- 033: Transporter operations batch — fuel logs, spare-parts inventory,
-- incident management and client (customer tracking) records.
-- Fuel gates under the seeded costs.* module, inventory under garage.*,
-- clients under customers.*; incidents gets its own permission keys.
begin;

create table if not exists fuel_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  vessel_id uuid references vessels(id),
  trip_id uuid references trips(id),
  log_date date not null default current_date,
  litres numeric(10,2) not null,
  price_per_litre numeric(12,2),
  total_cost numeric(14,2),
  odometer_km int,
  station text,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_fuel_logs_tenant on fuel_logs (tenant_id);
create index idx_fuel_logs_vessel on fuel_logs (vessel_id) where deleted_at is null;
create trigger trg_fuel_logs_updated before update on fuel_logs
  for each row execute function public.set_updated_at();

create table if not exists inventory_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  part_number text,
  category text,
  quantity numeric(12,2) not null default 0,
  min_quantity numeric(12,2) not null default 0,
  unit_cost numeric(14,2),
  location text,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index inventory_tenant_part_uq on inventory_items (tenant_id, part_number)
  where part_number is not null and deleted_at is null;
create index idx_inventory_tenant on inventory_items (tenant_id);
create trigger trg_inventory_items_updated before update on inventory_items
  for each row execute function public.set_updated_at();

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  vessel_id uuid references vessels(id),
  driver_id uuid references drivers(id),
  trip_id uuid references trips(id),
  incident_date date not null default current_date,
  type text not null default 'other' check (type in ('accident','breakdown','theft','injury','other')),
  severity text not null default 'minor' check (severity in ('minor','major','critical')),
  location text,
  description text not null,
  status text not null default 'open' check (status in ('open','investigating','resolved')),
  resolution_notes text,
  reported_by uuid,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_incidents_tenant on incidents (tenant_id);
create index idx_incidents_tenant_status on incidents (tenant_id, status) where deleted_at is null;
create trigger trg_incidents_updated before update on incidents
  for each row execute function public.set_updated_at();

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  tin text,
  email text,
  phone_encrypted bytea,
  phone_search text,
  address text,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_clients_tenant on clients (tenant_id);
create trigger trg_clients_updated before update on clients
  for each row execute function public.set_updated_at();

-- POLICY + GRANT together (016 lesson)
alter table fuel_logs enable row level security;
create policy fuel_logs_tenant on fuel_logs for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on fuel_logs to app_runtime;

alter table inventory_items enable row level security;
create policy inventory_items_tenant on inventory_items for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on inventory_items to app_runtime;

alter table incidents enable row level security;
create policy incidents_tenant on incidents for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on incidents to app_runtime;

alter table clients enable row level security;
create policy clients_tenant on clients for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on clients to app_runtime;

-- Incidents permission keys (extend the seeded matrix; director = all).
insert into permissions (key, description)
values
  ('incidents.view', 'Incidents - View'),
  ('incidents.create', 'Incidents - Create'),
  ('incidents.edit', 'Incidents - Edit'),
  ('incidents.delete', 'Incidents - Delete'),
  ('incidents.export', 'Incidents - Export')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'incidents.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

commit;
