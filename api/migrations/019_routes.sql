-- 019: Routes + route checkpoints (spec 6.4, ledger 14)
begin;

create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  corridor text,
  origin_region_id int references geo_regions(id),
  origin_district_id int references geo_districts(id),
  origin_text text,
  dest_region_id int references geo_regions(id),
  dest_district_id int references geo_districts(id),
  dest_text text,
  border_post_id int references geo_border_posts(id),
  distance_km int,
  expected_duration_hours int,
  road_class text,
  risk_notes text,
  seasonal_notes text,
  rate_per_km numeric(12,2),
  rate_per_tonne numeric(12,2),
  rate_per_trip numeric(12,2),
  fuel_surcharge_pct numeric(5,2) default 0,
  is_active boolean not null default true,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_routes_tenant on routes (tenant_id);
create trigger trg_routes_updated before update on routes
  for each row execute function public.set_updated_at();

-- Ordered checkpoints along the route (weighbridge/border/toll/fuel/rest/town)
create table if not exists route_checkpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  route_id uuid not null references routes(id) on delete cascade,
  seq int not null,
  kind text not null check (kind in ('weighbridge','border','toll','fuel','rest','town')),
  name text not null,
  created_at timestamptz not null default now(),
  unique (route_id, seq)
);
create index idx_route_checkpoints_route on route_checkpoints (route_id, seq);

-- POLICY + GRANT together (the rule)
alter table routes enable row level security;
create policy routes_tenant on routes for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on routes to app_runtime;

alter table route_checkpoints enable row level security;
create policy route_checkpoints_tenant on route_checkpoints for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on route_checkpoints to app_runtime;

-- Border posts readable for the route picker (already granted in 013, reaffirmed)
grant select on geo_border_posts to app_runtime;

commit;