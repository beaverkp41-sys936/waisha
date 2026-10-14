-- 039: Office Management — what running the office costs. A daily cost
-- register (allowances to staff, meals and refreshments, utilities, rent,
-- transport, supplies, communication) where every entry stays pending until
-- a director approves or rejects it; entries can be attributed to an employee
-- or a cargo file, so file costs against revenue read straight off the
-- register; and per-month category budgets that drive the budget-versus-spend
-- reports and overrun alerts. Receipt scans live in the documents vault.
begin;

create table if not exists office_costs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  cost_date date not null,
  category text not null
    check (category in ('allowance','meals','utilities','rent','transport','supplies','communication','other')),
  description text not null,
  amount numeric(14,2) not null check (amount >= 0),
  -- Who was paid: a member of staff, a landlord, a vendor.
  payee text,
  -- Allowances are usually to an employee; file costs point at a cargo file.
  employee_id uuid references employees(id),
  shipment_id uuid references cargo_shipments(id),
  payment_method text not null default 'cash'
    check (payment_method in ('cash','mobile_money','bank','cheque')),
  receipt_no text,
  -- Every entry starts pending; only office_costs.approve holders decide it,
  -- and editing an entry sends it back for approval.
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  approved_by uuid references users(id),
  approved_at timestamptz,
  review_note text,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_office_costs_date on office_costs (tenant_id, cost_date desc) where deleted_at is null;
create index idx_office_costs_status on office_costs (tenant_id, status, cost_date) where deleted_at is null;
create index idx_office_costs_category on office_costs (tenant_id, category, cost_date) where deleted_at is null;
create index idx_office_costs_shipment on office_costs (tenant_id, shipment_id)
  where deleted_at is null and shipment_id is not null;
create index idx_office_costs_employee on office_costs (tenant_id, employee_id)
  where deleted_at is null and employee_id is not null;
create trigger trg_office_costs_updated before update on office_costs
  for each row execute function public.set_updated_at();

create table if not exists office_budgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- First day of the budgeted month; one budget per category per month.
  period date not null,
  category text not null
    check (category in ('allowance','meals','utilities','rent','transport','supplies','communication','other')),
  amount numeric(14,2) not null check (amount >= 0),
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index office_budgets_period_uq on office_budgets (tenant_id, period, category)
  where deleted_at is null;
create index idx_office_budgets_period on office_budgets (tenant_id, period desc) where deleted_at is null;
create trigger trg_office_budgets_updated before update on office_budgets
  for each row execute function public.set_updated_at();

-- POLICY + GRANT together (016 lesson)
alter table office_costs enable row level security;
create policy office_costs_tenant on office_costs for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on office_costs to app_runtime;

alter table office_budgets enable row level security;
create policy office_budgets_tenant on office_budgets for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on office_budgets to app_runtime;

-- Documents vault: receipt scans attach under entity_type 'office_cost'.
alter table documents drop constraint documents_entity_type_check;
alter table documents add constraint documents_entity_type_check
  check (entity_type in ('tenant','user','vessel','driver','trip','shipment','message','licence','employee','office_cost'));
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check
  check (kind in ('logo','avatar','licence','insurance','inspection','road_licence',
                  'delivery_note','invoice','bill_of_lading','packing_list','contract',
                  'other','attachment','receipt'));

-- Permission keys for the module.
insert into permissions (key, description)
values
  ('office_costs.view', 'Office Costs - View the cost register'),
  ('office_costs.create', 'Office Costs - Record costs'),
  ('office_costs.edit', 'Office Costs - Edit costs'),
  ('office_costs.delete', 'Office Costs - Delete costs'),
  ('office_costs.approve', 'Office Costs - Approve or reject costs'),
  ('office_budgets.view', 'Office Budgets - View monthly budgets'),
  ('office_budgets.manage', 'Office Budgets - Set monthly budgets')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'office_costs.%' or p.key like 'office_budgets.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('office_costs.view', 'office_budgets.view')
where r.key = 'auditor' and r.tenant_id is null
on conflict do nothing;

commit;
