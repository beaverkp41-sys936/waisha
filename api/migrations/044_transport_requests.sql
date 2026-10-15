-- 044: Transport requests (spec Part 2, step 1 "PUBLISH").
--
-- RULE 0 boundary. A transport request is a COPY of an allowlisted field set,
-- taken once with the client's consent and approved field by field by the CFA.
-- The notice board (step 5) reads from this table alone — it must never join
-- live into cargo_shipments, invoices, job_documents or any other tenant
-- business table, which is why every publishable detail is denormalised here
-- as text and numbers rather than referenced by id. Client identity, file
-- numbers, HS codes, declaration/TANAD/RCN numbers, container numbers, costs,
-- payment values, margins and internal notes have no column on this table at
-- all, so they cannot leak through a future query.
--
-- Status covers the whole Part 2 lifecycle so steps 5 and 6 need no ALTER:
-- only 'open' and 'cancelled' are written by this step.
begin;

create table if not exists transport_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  job_id uuid not null references jobs(id),
  shipment_id uuid not null references cargo_shipments(id),
  status text not null default 'open'
    check (status in ('open','temp_booked','confirmed','cancelled')),

  -- ---- cargo details (physical only) ----
  cargo_label text not null check (length(trim(cargo_label)) between 2 and 300),
  container_type text
    check (container_type is null or container_type in ('20ft','40ft','loose_cargo','car')),
  container_count int check (container_count is null or container_count between 1 and 500),
  weight_tonnes numeric(12,3) check (weight_tonnes is null or weight_tonnes between 0 and 100000),
  cbm numeric(12,3) check (cbm is null or cbm between 0 and 100000),
  vehicle_types text[] not null default '{}'
    check (vehicle_types <@ array['truck_head','trailer','tanker','flatbed','tipper',
                                 'reefer','box_truck','van','pickup','lowbed']),

  -- ---- route copy (labels, never a live join) ----
  route_id uuid references routes(id),
  route_label text,
  distance_km int check (distance_km is null or distance_km between 0 and 20000),
  expected_duration_hours int
    check (expected_duration_hours is null or expected_duration_hours between 0 and 500),
  pickup_text text not null check (length(trim(pickup_text)) between 2 and 200),
  pickup_region_id int references geo_regions(id),
  dest_text text not null check (length(trim(dest_text)) between 2 and 200),
  dest_region_id int references geo_regions(id),
  via_label text,
  required_date date not null,

  -- ---- one named contact, chosen and typed for disclosure ----
  contact_user_id uuid references users(id),
  contact_name text not null check (length(trim(contact_name)) between 2 and 120),
  contact_channel text not null check (length(trim(contact_channel)) between 5 and 160),
  public_note text check (public_note is null or length(public_note) <= 600),

  -- ---- CFA company card, copied at publish time ----
  company_name text not null check (length(trim(company_name)) between 2 and 200),
  company_description text,
  company_services text,
  company_corridors text,
  company_website text,
  fleet_size_declared int,
  year_established int,

  -- ---- disclosure record ----
  disclosed_by uuid,
  disclosed_at timestamptz not null default now(),
  cancelled_by uuid,
  cancelled_at timestamptz,

  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- One live request per job; a cancelled one frees the slot so a job can be
-- re-advertised after a declined or stale booking.
create unique index transport_requests_one_live_job_uq
  on transport_requests (tenant_id, job_id)
  where status in ('open','temp_booked','confirmed') and deleted_at is null;
create index idx_transport_requests_tenant_status
  on transport_requests (tenant_id, status, required_date) where deleted_at is null;
create index idx_transport_requests_shipment on transport_requests (shipment_id);
create trigger trg_transport_requests_updated before update on transport_requests
  for each row execute function public.set_updated_at();

-- POLICY + GRANT together (016 lesson). No DELETE for the app role: a request
-- that was offered to other companies is history, so it is cancelled, not removed.
alter table transport_requests enable row level security;
create policy transport_requests_tenant on transport_requests for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on transport_requests to app_runtime;

-- ---------- Permissions ----------
insert into permissions (key, description)
values
  ('transport.view', 'Transport requests - View and preview'),
  ('transport.publish', 'Transport requests - Publish an approved copy to the board'),
  ('transport.cancel', 'Transport requests - Cancel an open request')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'transport.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('transport.view','transport.publish','transport.cancel')
where r.key in ('operations_manager','general_manager') and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key = 'transport.view'
where r.key in ('customer_service','customer_service_agent','dispatcher','compliance_officer',
                'finance_officer','billing_admin','auditor','trainee','support_engineer')
  and r.tenant_id is null
on conflict do nothing;

commit;
