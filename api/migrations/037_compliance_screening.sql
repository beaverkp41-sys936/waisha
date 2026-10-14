-- 037: Compliance & Screening — CFA client watchlist screening and the
-- regulatory licence register (TRA, BRELA, TPA and other authorities).
--
-- Three tables:
--   screening_entries   the watchlist itself (parties flagged by TRA, courts,
--                       police or the office) with active/lifted status.
--   screening_checks    an immutable log of screening runs: which cargo file
--                       or client was checked, against which matches, by whom.
--                       Auditors want the paper trail; nothing updates here.
--   regulatory_licences the company's own licences with expiry dates that feed
--                       renewal alerts and the calendar.
begin;

create table if not exists screening_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  party_name text not null,
  tin text,
  reason text not null,
  source text not null default 'internal'
    check (source in ('tra','customs','court','police','internal','other')),
  severity text not null default 'high' check (severity in ('high','medium','low')),
  status text not null default 'active' check (status in ('active','lifted')),
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_screening_entries_tenant on screening_entries (tenant_id);
create index idx_screening_entries_active on screening_entries (tenant_id, severity)
  where deleted_at is null and status = 'active';
create trigger trg_screening_entries_updated before update on screening_entries
  for each row execute function public.set_updated_at();

create table if not exists screening_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subject_type text not null check (subject_type in ('shipment','client')),
  subject_id uuid not null,
  -- Display label snapshot: the file number or client name at check time.
  subject_label text not null,
  result text not null check (result in ('clear','hit')),
  -- Matched watchlist entries at check time: [{id, name, severity, field}].
  matches jsonb not null default '[]'::jsonb,
  checked_by uuid not null,
  checked_at timestamptz not null default now()
);
create index idx_screening_checks_tenant on screening_checks (tenant_id, checked_at desc);

create table if not exists regulatory_licences (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  authority text not null default 'tra'
    check (authority in ('tra','brela','tpa','other')),
  title text not null,
  licence_number text,
  issued_date date,
  expiry_date date not null,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_regulatory_licences_tenant on regulatory_licences (tenant_id);
create index idx_regulatory_licences_expiry on regulatory_licences (tenant_id, expiry_date)
  where deleted_at is null;
create trigger trg_regulatory_licences_updated before update on regulatory_licences
  for each row execute function public.set_updated_at();

-- POLICY + GRANT together (016 lesson)
alter table screening_entries enable row level security;
create policy screening_entries_tenant on screening_entries for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on screening_entries to app_runtime;

alter table screening_checks enable row level security;
create policy screening_checks_tenant on screening_checks for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- The log is append-only: no update/delete grants.
grant select, insert on screening_checks to app_runtime;

alter table regulatory_licences enable row level security;
create policy regulatory_licences_tenant on regulatory_licences for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on regulatory_licences to app_runtime;

-- Documents vault: licence scans attach under entity_type 'licence'.
alter table documents drop constraint documents_entity_type_check;
alter table documents add constraint documents_entity_type_check
  check (entity_type in ('tenant','user','vessel','driver','trip','shipment','message','licence'));

-- Permission keys for the module.
insert into permissions (key, description)
values
  ('screening.view', 'Compliance Screening - View'),
  ('screening.create', 'Compliance Screening - Run checks'),
  ('screening.edit', 'Compliance Screening - Edit watchlist'),
  ('screening.delete', 'Compliance Screening - Delete watchlist entries'),
  ('licences.view', 'Regulatory Licences - View'),
  ('licences.create', 'Regulatory Licences - Create'),
  ('licences.edit', 'Regulatory Licences - Edit'),
  ('licences.delete', 'Regulatory Licences - Delete')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'screening.%' or p.key like 'licences.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('screening.view', 'licences.view')
where r.key = 'auditor' and r.tenant_id is null
on conflict do nothing;

commit;
