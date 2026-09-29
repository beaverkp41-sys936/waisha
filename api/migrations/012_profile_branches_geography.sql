-- 012: Company profile, branches, and Tanzania geography reference (spec 6.2, ledger 14)
begin;

-- ============================
-- GEOGRAPHY REFERENCE (ledger 14)
-- Tanzania administrative hierarchy: Region (Mkoa) -> District (Wilaya).
-- Districts include both council types (MC/TC/DC); wards/streets are free-text
-- + optional ward table later if needed. EN + SW names, extensible per country
-- (spec 14: pluggable per-country validators/data).
-- ============================
create table if not exists geo_regions (
  id serial primary key,
  country text not null default 'TZ',
  code text not null unique,          -- stable code e.g. 'TZ-DSM'
  name_en text not null,
  name_sw text not null,
  is_active boolean not null default true
);
create table if not exists geo_districts (
  id serial primary key,
  region_id int not null references geo_regions(id),
  name_en text not null,
  name_sw text not null,
  is_active boolean not null default true,
  unique (region_id, name_en)
);
create index idx_geo_districts_region on geo_districts (region_id);

grant select on geo_regions, geo_districts to app_runtime;
alter table geo_regions enable row level security;
alter table geo_districts enable row level security;
create policy geo_read on geo_regions for select to app_runtime using (true);
create policy geo_read2 on geo_districts for select to app_runtime using (true);

-- Seed: 26 regions of Tanzania (EN/SW; SW names as commonly written)
insert into geo_regions (code, name_en, name_sw) values
 ('TZ-ARU','Arusha','Arusha'),
 ('TZ-DAR','Dar es Salaam','Dar es Salaam'),
 ('TZ-DOD','Dodoma','Dodoma'),
 ('TZ-GEI','Geita','Geita'),
 ('TZ-IRI','Iringa','Iringa'),
 ('TZ-KAG','Kagera','Kagera'),
 ('TZ-KAT','Katavi','Katavi'),
 ('TZ-KIG','Kigoma','Kigoma'),
 ('TZ-KIL','Kilimanjaro','Kilimanjaro'),
 ('TZ-LIN','Lindi','Lindi'),
 ('TZ-MAN','Manyara','Manyara'),
 ('TZ-MAR','Mara','Mara'),
 ('TZ-MBE','Mbeya','Mbeya'),
 ('TZ-MOR','Morogoro','Morogoro'),
 ('TZ-MTW','Mtwara','Mtwara'),
 ('TZ-MWA','Mwanza','Mwanza'),
 ('TZ-NJI','Njombe','Njombe'),
 ('TZ-POA','Pwani','Pwani'),
 ('TZ-RUK','Rukwa','Rukwa'),
 ('TZ-RUV','Ruvuma','Ruvuma'),
 ('TZ-SHW','Shinyanga','Shinyanga'),
 ('TZ-SIM','Simiyu','Simiyu'),
 ('TZ-SIN','Singida','Singida'),
 ('TZ-SON','Songwe','Songwe'),
 ('TZ-TAB','Tabora','Tabora'),
 ('TZ-TAN','Tanga','Tanga')
on conflict (code) do nothing;

-- Districts: seeded per-region in a companion seed file (larger volume);
-- the app also accepts free-text district as fallback until seed completes.
-- (Seed script delivered in Step 2 - api/seeds/geo_tz_districts.sql)

-- ============================
-- COMPANY PROFILE (1:1 with transporter tenant)
-- ============================
create table if not exists company_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id),
  company_name text not null,
  tin_display text,
  brela_number text,
  vat_number text,
  transport_licence_no text,
  transport_licence_expiry date,
  year_established int,
  fleet_size_declared int,
  services_offered text,
  corridors_served text,
  description text,
  website text,
  logo_path text,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_company_profiles_updated before update on company_profiles
  for each row execute function public.set_updated_at();
alter table company_profiles enable row level security;
create policy company_profiles_tenant on company_profiles for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);

-- ============================
-- BRANCHES (HQ + sub-HQ + branches; spec 6.2)
-- ============================
create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('hq','sub_hq','branch')),
  name text not null,
  region_id int references geo_regions(id),
  district_id int references geo_districts(id),
  district_freetext text,           -- fallback while geography seeds complete
  ward text,
  street text,
  postal_address text,
  gps_lat numeric(9,6),
  gps_lng numeric(9,6),
  contact_person text,
  phone_encrypted bytea,
  phone_search text,
  email text,
  operating_hours text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_branches_tenant on branches (tenant_id);
create unique index branches_one_hq_uq on branches (tenant_id)
  where kind = 'hq' and deleted_at is null;
create trigger trg_branches_updated before update on branches
  for each row execute function public.set_updated_at();
alter table branches enable row level security;
create policy branches_tenant on branches for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);

commit;