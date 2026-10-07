-- 029: Invoices & Billing — customer freight invoices in the shipping/logistics
-- format, with line items, recorded payments and derived Paid/Partial/Overdue
-- status. Named freight_* because migration 005 already owns `invoices` and
-- `payments` for platform subscription billing. Also seeds the invoices.*
-- permission keys the module enforces.
begin;

create table if not exists freight_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  invoice_number text not null,
  customer_name text not null,
  customer_phone_encrypted bytea,
  customer_phone_search text,
  customer_email text,
  customer_tin text,
  customer_address text,
  issue_date date not null default current_date,
  due_date date,
  payment_terms text,
  currency text not null default 'TZS',
  vat_rate numeric(5,2) not null default 18,
  subtotal numeric(14,2) not null default 0,
  vat_amount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  amount_paid numeric(14,2) not null default 0,
  -- Base lifecycle only; paid/partial/overdue are derived from money and dates.
  status text not null default 'draft' check (status in ('draft','sent','cancelled')),
  related_trip_id uuid references trips(id),
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index freight_invoices_tenant_number_uq on freight_invoices (tenant_id, invoice_number)
  where deleted_at is null;
create index idx_freight_invoices_tenant on freight_invoices (tenant_id);
create index idx_freight_invoices_tenant_status on freight_invoices (tenant_id, status) where deleted_at is null;
create trigger trg_freight_invoices_updated before update on freight_invoices
  for each row execute function public.set_updated_at();

create table if not exists freight_invoice_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  invoice_id uuid not null references freight_invoices(id),
  seq int not null,
  description text not null,
  quantity numeric(12,2) not null default 1,
  unit_price numeric(14,2) not null default 0,
  amount numeric(14,2) not null default 0
);
create index idx_freight_invoice_items_invoice on freight_invoice_items (invoice_id, seq);

create table if not exists freight_invoice_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  invoice_id uuid not null references freight_invoices(id),
  amount numeric(14,2) not null,
  method text not null default 'cash' check (method in ('cash','bank','mobile_money','cheque','other')),
  reference text,
  paid_at date not null default current_date,
  notes text,
  recorded_by uuid,
  created_at timestamptz not null default now()
);
create index idx_freight_invoice_payments_invoice on freight_invoice_payments (invoice_id, paid_at);

-- POLICY + GRANT together (016 lesson)
alter table freight_invoices enable row level security;
create policy freight_invoices_tenant on freight_invoices for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on freight_invoices to app_runtime;

alter table freight_invoice_items enable row level security;
create policy freight_invoice_items_tenant on freight_invoice_items for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on freight_invoice_items to app_runtime;

alter table freight_invoice_payments enable row level security;
create policy freight_invoice_payments_tenant on freight_invoice_payments for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on freight_invoice_payments to app_runtime;

-- Permission keys for the module (extend the seeded matrix).
insert into permissions (key, description)
values
  ('invoices.view', 'Invoices - View'),
  ('invoices.create', 'Invoices - Create'),
  ('invoices.edit', 'Invoices - Edit'),
  ('invoices.delete', 'Invoices - Delete'),
  ('invoices.export', 'Invoices - Export')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join (values
  ('invoices.view'), ('invoices.create'), ('invoices.edit'),
  ('invoices.delete'), ('invoices.export')
) as m(key) on true
join permissions p on p.key = m.key
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join (values ('invoices.view'), ('invoices.export')) as m(key) on true
join permissions p on p.key = m.key
where r.key = 'auditor' and r.tenant_id is null
on conflict do nothing;

commit;
