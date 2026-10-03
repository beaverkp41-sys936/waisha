-- 022: Drivers and crew (spec 6.10)
begin;

create table if not exists drivers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  branch_id uuid references branches(id),
  full_name text not null,
  nida_encrypted bytea,
  nida_search text,
  phone_encrypted bytea,
  phone_search text,
  date_of_birth date,
  blood_group text check (blood_group in ('A+','A-','B+','B-','AB+','AB-','O+','O-') or blood_group is null),
  licence_class text,
  licence_number text,
  licence_expiry date,
  defensive_driving_cert boolean not null default false,
  dangerous_goods_cert boolean not null default false,
  assigned_vessel_id uuid references vessels(id),
  status text not null default 'available'
    check (status in ('available','on_trip','on_leave','suspended')),
  address text,
  next_of_kin text,
  next_of_kin_phone_encrypted bytea,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index drivers_tenant_nida_uq on drivers (tenant_id, nida_search)
  where nida_search is not null and deleted_at is null;
create index idx_drivers_tenant on drivers (tenant_id);
create index idx_drivers_status on drivers (status);
create trigger trg_drivers_updated before update on drivers
  for each row execute function public.set_updated_at();

alter table drivers enable row level security;
create policy drivers_tenant on drivers for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on drivers to app_runtime;

commit;