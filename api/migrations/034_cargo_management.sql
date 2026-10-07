-- 034: Cargo Management — CFA shipments (cargo files), workflow tasks and
-- document linkage. File numbers follow the CFA convention:
--   X + COMPANY_CODE + SEQUENCE + YEAR   (e.g. 4WEM-005-2026)
--   prefixes 1=Export, 4=Import, 7=Transhipment, 8=Transit
--   sequence resets yearly and is unique per tenant/type/year.
begin;

-- The 3-letter company code every transporter/shipper chooses (Profile page).
alter table company_profiles add column if not exists company_code text;

create table if not exists cargo_shipments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  file_number text not null,
  seq int not null,
  file_year int not null,
  shipment_type text not null check (shipment_type in ('export','import','transhipment','transit')),
  hs_code text,
  declaration_mode text,
  cargo_description text,
  container_type text not null check (container_type in ('20ft','40ft','loose_cargo','car')),
  container_count int,
  container_numbers text[],
  cbm numeric(12,3),
  weight_tonnes numeric(12,3),
  consignee_name text not null,
  consignor_name text not null,
  shipping_line text,
  bill_number text,
  order_date date,
  document_receipt_date date,
  eta date,
  discharge_date date,
  carry_in_date date,
  terms_delivery text check (terms_delivery in ('CIF','CFR','EXW','FCA','CPT','CIP','DAP','DDP','FAS','FOB')),
  tansad_number text,
  rcn_number text,
  reference_number text,
  office_declaration text,
  border_point text,
  nominated_icd text,
  cabinet_position text,
  processing_cost numeric(14,2),
  payment_amount numeric(14,2),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid')),
  -- Workflow: pre-arrival -> arrival -> customs -> inspection -> release -> exit
  stage text not null default 'pre_arrival'
    check (stage in ('pre_arrival','arrival','customs','inspection','release','exit')),
  status text not null default 'open' check (status in ('open','on_hold','completed','cancelled')),
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index cargo_shipments_file_uq on cargo_shipments (tenant_id, file_number) where deleted_at is null;
create unique index cargo_shipments_seq_uq on cargo_shipments (tenant_id, shipment_type, file_year, seq) where deleted_at is null;
create index idx_cargo_shipments_tenant on cargo_shipments (tenant_id);
create index idx_cargo_shipments_stage on cargo_shipments (tenant_id, stage) where deleted_at is null;
create trigger trg_cargo_shipments_updated before update on cargo_shipments
  for each row execute function public.set_updated_at();

create table if not exists cargo_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  shipment_id uuid not null references cargo_shipments(id),
  title text not null,
  assigned_to uuid references users(id),
  due_date date,
  status text not null default 'pending' check (status in ('pending','done','cancelled')),
  done_at timestamptz,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_cargo_tasks_shipment on cargo_tasks (shipment_id, status);
create trigger trg_cargo_tasks_updated before update on cargo_tasks
  for each row execute function public.set_updated_at();

-- POLICY + GRANT together (016 lesson)
alter table cargo_shipments enable row level security;
create policy cargo_shipments_tenant on cargo_shipments for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on cargo_shipments to app_runtime;

alter table cargo_tasks enable row level security;
create policy cargo_tasks_tenant on cargo_tasks for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on cargo_tasks to app_runtime;

-- Shipments attach to the document vault; receipts/BL/packing list kinds added.
alter table documents drop constraint documents_entity_type_check;
alter table documents add constraint documents_entity_type_check
  check (entity_type in ('tenant','user','vessel','driver','trip','shipment'));
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check
  check (kind in ('logo','avatar','licence','insurance','inspection','road_licence',
                  'delivery_note','invoice','bill_of_lading','packing_list','other'));

-- Permission keys for the module.
insert into permissions (key, description)
values
  ('shipments.view', 'Cargo Shipments - View'),
  ('shipments.create', 'Cargo Shipments - Create'),
  ('shipments.edit', 'Cargo Shipments - Edit'),
  ('shipments.delete', 'Cargo Shipments - Delete'),
  ('shipments.export', 'Cargo Shipments - Export')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'shipments.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('shipments.view', 'shipments.export')
where r.key = 'auditor' and r.tenant_id is null
on conflict do nothing;

-- Cargo files belong to the CFA plan family.
update plans
set module_entitlements = '{"modules":["dashboard","profile","fleet","routes","trips","checkpoints","tracking","costs","garage","drivers","trainees","reports","invoices","documents","ledger","duty_calculator","shipments"]}'
where key = 'business';

commit;
