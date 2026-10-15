-- 040: Shipper portal — external client access to their own cargo files.
-- A director creates a shipper account for a client record: a user of type
-- 'shipper' living in the transporter's tenant, granted the global
-- 'shipper_portal' role. The account is scoped to the client; files are
-- visible when the client's name matches the file's consignee or consignor
-- (case-insensitive) or when a director has shared the file explicitly.
-- The portal itself is read-oriented tracking plus invoice visibility and
-- document downloads; shippers may also upload their own source documents.
begin;

create table if not exists shipper_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  client_id uuid not null references clients(id),
  user_id uuid not null references users(id),
  status text not null default 'active' check (status in ('active','suspended')),
  invited_by uuid references users(id),
  invited_at timestamptz not null default now(),
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index shipper_accounts_user_uq on shipper_accounts (tenant_id, user_id)
  where deleted_at is null;
create index idx_shipper_accounts_tenant on shipper_accounts (tenant_id) where deleted_at is null;
create trigger trg_shipper_accounts_updated before update on shipper_accounts
  for each row execute function public.set_updated_at();

create table if not exists shipper_file_shares (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  shipper_account_id uuid not null references shipper_accounts(id),
  shipment_id uuid not null references cargo_shipments(id),
  shared_by uuid references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index shipper_file_shares_uq on shipper_file_shares (tenant_id, shipper_account_id, shipment_id)
  where deleted_at is null;
create index idx_shipper_file_shares_shipment on shipper_file_shares (tenant_id, shipment_id)
  where deleted_at is null;
create index idx_shipper_file_shares_account on shipper_file_shares (shipper_account_id)
  where deleted_at is null;

-- POLICY + GRANT together (016 lesson)
alter table shipper_accounts enable row level security;
create policy shipper_accounts_tenant on shipper_accounts for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on shipper_accounts to app_runtime;

alter table shipper_file_shares enable row level security;
create policy shipper_file_shares_tenant on shipper_file_shares for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on shipper_file_shares to app_runtime;

-- Documents vault: shippers attach their own source documents under a
-- distinct kind so staff can tell uploads apart in the vault.
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check
  check (kind in ('logo','avatar','licence','insurance','inspection','road_licence',
                  'delivery_note','invoice','bill_of_lading','packing_list','contract',
                  'other','attachment','receipt','shipper_upload'));

-- Permission keys for the module.
insert into permissions (key, description)
values
  ('shipper_accounts.view', 'Shipper Access - View portal accounts'),
  ('shipper_accounts.create', 'Shipper Access - Create portal accounts'),
  ('shipper_accounts.edit', 'Shipper Access - Edit, suspend, share files'),
  ('shipper_accounts.delete', 'Shipper Access - Remove portal accounts'),
  ('portal.view', 'Shipper Portal - View own files, invoices and documents'),
  ('portal.upload', 'Shipper Portal - Upload documents to own files')
on conflict do nothing;

-- Global role granted to director-created shipper users; the seeded
-- marketplace 'shipper' role deliberately gets nothing here.
insert into roles (tenant_id, key, name, is_system)
values (null, 'shipper_portal', 'Shipper Portal Access', true)
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('portal.view', 'portal.upload')
where r.key = 'shipper_portal' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'shipper_accounts.%' or p.key like 'portal.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('shipper_accounts.view', 'portal.view')
where r.key = 'auditor' and r.tenant_id is null
on conflict do nothing;

commit;
