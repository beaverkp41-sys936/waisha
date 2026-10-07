-- 031: Financial ledger — supplier expenses (accounts payable). Revenue side
-- derives from freight_invoices; this table is the cost side. Name follows the
-- freight_* convention (005 owns generic billing tables).
begin;

create table if not exists freight_expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  supplier_name text not null,
  description text,
  category text not null default 'other'
    check (category in ('fuel','maintenance','salaries','rent','office','border','toll','loading','other')),
  amount numeric(14,2) not null,
  amount_paid numeric(14,2) not null default 0,
  currency text not null default 'TZS',
  expense_date date not null default current_date,
  due_date date,
  -- Base lifecycle; paid/partial/overdue derive from money and dates.
  status text not null default 'recorded' check (status in ('recorded','cancelled')),
  related_trip_id uuid references trips(id),
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_freight_expenses_tenant on freight_expenses (tenant_id);
create index idx_freight_expenses_supplier on freight_expenses (tenant_id, supplier_name) where deleted_at is null;
create trigger trg_freight_expenses_updated before update on freight_expenses
  for each row execute function public.set_updated_at();

alter table freight_expenses enable row level security;
create policy freight_expenses_tenant on freight_expenses for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on freight_expenses to app_runtime;

commit;
