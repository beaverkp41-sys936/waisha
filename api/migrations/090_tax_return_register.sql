begin;

-- ============================================================
-- 090: the tax return register
-- ============================================================
--
-- "On finance, i want more professional and advanced dashboards for finance, like
-- taxes and all, also in tanzania, TRA. include also filing."
--
-- Filing is the sentence this migration has to answer honestly. WAISHA does not
-- talk to TRA and cannot: no official channel has been granted, and a system that
-- pushes a return into a government account is a different product with different
-- obligations. What it can do is what an accountant does *before* they open iTTiS
-- -- work the figures out of the company's own paper, put them into the shape a
-- return asks for, and keep a record of what was filed, when, and under which
-- reference. That record is this table. Nothing in it can move money.
--
-- Two kinds of figure live here and the difference is the whole design, which is
-- what the `basis` column is for:
--
--   computed   footed from `freight_invoices` and their items, which the system
--              holds line by line -- section, tax kind, tax rate, tax amount.
--              The VAT return and the statutory-charges return are this kind, and
--              nobody types their totals: the API recomputes them from the
--              records on every save.
--   declared   typed by the preparer, because the system holds no purchase
--              invoices. `freight_expenses` (031) carries a supplier, a category
--              and a gross amount -- no tax split, no supplier TIN -- so an input
--              VAT credit read out of that table would be an invented number.
--              The withheld-VAT return is declared, and a declared return has to
--              carry the sentence saying where its figures came from.
--
-- `net_payable` is not a number anybody can type at all: the CHECK below forces it
-- to equal tax_charged - input_tax - credits_declared in exact numerics, so a
-- return that does not foot cannot be saved. A negative figure is legal -- that is
-- a refund claim, not an error.
--
-- The column names are deliberately not "output_vat" and "input_vat". One table
-- carries three return kinds and "VAT" in a column name would be a lie on the
-- other two: `tax_charged` is the VAT charged on supplies, the VAT a customer
-- withheld, or the statutory charges collected on imports, and `base_amount` is
-- whatever that charge was computed on. `statutory_collected` stays a separate
-- memo figure because RDL and CPF/IDF are collected on behalf of somebody else
-- and are never a credit against VAT.
--
-- The `detail` snapshot is why this exists as a table rather than a query. A filed
-- return is a piece of paper, and the invoices underneath it keep moving -- a late
-- payment changes an outstanding figure, a correction re-rates a line. So the
-- schedule the return was footed from is copied in when it is prepared and the row
-- is frozen when it is filed: `tax_return_gate` refuses UPDATE and DELETE on a
-- filed return for everybody including the director, and a mistake is corrected
-- the way it is corrected on paper -- a new return that names the one it
-- supersedes. Same absolute-trust pattern as the 072 payroll gates and the 057
-- signed-report immutability.
--
-- The partial unique index is what makes that usable: at most one *live* (not yet
-- filed) return per company, kind and period, so a desk cannot accumulate four
-- half-built drafts for October, while the filed history keeps every version it
-- actually submitted.
--
-- `rates_version` records which published `duty_rates` version the figures were
-- read against, because the rates in force are a versioned public register and a
-- return prepared against last year's Finance Act edition has to be able to say so.
--
-- Money rule, restated: every figure is `numeric(14,2)` in an explicit currency,
-- the currency is a CHECKed constant, and nothing here is a float.

create table if not exists tax_returns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),

  -- What is being returned. Kept small and real: the periodic VAT return, the
  -- VAT withheld from this company's supplies by a customer who is a withholding
  -- agent, and the statutory charges (RDL, CPF/IDF) collected on imports and
  -- passed on. Income tax is not here because the system holds no
  -- income-and-expenditure records to build one from, and a return invented out
  -- of an invoice list would be a claim about profit the records do not support.
  kind text not null check (kind in ('vat', 'withholding_vat', 'statutory_charges')),
  basis text not null default 'computed' check (basis in ('computed', 'declared')),
  period_start date not null,
  period_end date not null,
  currency text not null default 'TZS' check (currency = 'TZS'),

  status text not null default 'draft' check (status in ('draft', 'prepared', 'filed')),

  -- --- the figures ------------------------------------------------------------
  -- Consideration the return's own tax was charged on.
  base_amount numeric(14,2) not null default 0,
  -- Supplies carrying no charge, split the two ways a return asks for.
  zero_rated_base numeric(14,2) not null default 0,
  exempt_base numeric(14,2) not null default 0,
  -- VAT charged, VAT withheld, or statutory charges collected.
  tax_charged numeric(14,2) not null default 0,
  -- Input credit and any other credit being claimed. Declared unless the office
  -- holds the paper, which the system cannot check.
  input_tax numeric(14,2) not null default 0,
  credits_declared numeric(14,2) not null default 0,
  -- Derived, and CHECKed so a hand-typed total cannot disagree with its parts.
  net_payable numeric(14,2) not null default 0,
  -- Statutory charges billed on the same paper (RDL, CPF/IDF). A memo on a VAT
  -- return, never a credit against it.
  statutory_collected numeric(14,2) not null default 0,
  invoices_count int not null default 0 check (invoices_count >= 0),
  -- Where a declared figure came from. Required when the basis is declared.
  input_basis text,

  -- The schedule copied in at prepare time: the per-invoice lines the figures
  -- were footed from, the section splits, and the rates in force.
  detail jsonb not null default '{}'::jsonb,
  rates_version text,

  note text,
  prepared_by uuid, prepared_at timestamptz,
  -- What the office wrote down after it actually filed: the submission number the
  -- portal gave back, and the date. A reference string, nothing more.
  filing_reference text, filed_by uuid, filed_at timestamptz,
  supersedes_id uuid references tax_returns(id),
  constraint tax_returns_does_not_supersede_itself
    check (supersedes_id is null or supersedes_id <> id),

  -- Only the withheld-VAT return may be declared: it is the one the records cannot
  -- foot. A computed return whose figures were typed is a return that lies.
  constraint tax_returns_declared_only_for_withholding
    check (basis <> 'declared' or kind = 'withholding_vat'),
  constraint tax_returns_declared_needs_basis
    check (basis <> 'declared' or (input_basis is not null and length(trim(input_basis)) > 0)),
  constraint tax_returns_net_foots
    check (net_payable = tax_charged - input_tax - credits_declared),
  constraint tax_returns_period_ordered
    check (period_end >= period_start),

  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index tax_returns_live_uq on tax_returns (tenant_id, kind, period_start, period_end)
  where deleted_at is null and status <> 'filed';
create index tax_returns_period_idx on tax_returns (tenant_id, kind, period_start desc)
  where deleted_at is null;

create trigger trg_tax_returns_updated before update on tax_returns
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- A draft is born a draft, and a filed return is the paper it was filed on.
-- ---------------------------------------------------------------------------
create or replace function public.tax_return_starts_draft()
returns trigger language plpgsql as $$
begin
  if new.status is null or new.status = '' then new.status := 'draft'; end if;
  if new.status <> 'draft' then
    raise exception 'A return starts as a draft and is prepared from its figures'
      using errcode = '22023';
  end if;
  return new;
end $$;

create trigger trg_tax_return_starts_draft before insert on tax_returns
  for each row execute function public.tax_return_starts_draft();

create or replace function public.tax_return_gate()
returns trigger language plpgsql as $$
declare target record;
begin
  -- 1. A period cannot cover days that have not arrived yet. Proven on the way in
  --    as well as on the way out: a draft for next month is refused when it is
  --    created, not at the moment somebody tries to file it.
  if new.period_end > current_date then
    raise exception 'A return cannot cover a period that has not finished'
      using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;

  -- 2. Absolute: nothing touches a filed return. Not the director, not the person
  --    who filed it. A correction is a new return that supersedes this one.
  if old.status = 'filed' then
    raise exception 'A filed return is kept as filed — raise a return that supersedes it'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  -- 3. One direction only: draft -> prepared -> filed. An unfiled preparation
  --    goes back to draft by editing its figures, which is the point of a draft.
  if new.status = 'filed' then
    if old.status <> 'prepared' then
      raise exception 'A return is filed only after its figures have been prepared'
        using errcode = 'P0001';
    end if;
    if new.filing_reference is null or length(trim(new.filing_reference)) = 0 then
      raise exception 'Filing needs the reference the submission gave back'
        using errcode = 'P0001';
    end if;
    if new.filed_at is null then
      raise exception 'Filing needs the date it was filed' using errcode = 'P0001';
    end if;
    if new.supersedes_id is not null then
      -- period_end is in this list because the comparison below reads it: a record
      -- variable only carries the columns its SELECT took, and leaving it out made
      -- every legitimate correction fail to file.
      select kind, period_start, period_end, status into target
        from tax_returns where id = new.supersedes_id;
      if not found or target.status <> 'filed' then
        raise exception 'A superseding return can only replace one that was filed'
          using errcode = 'P0001';
      end if;
      if new.kind <> target.kind or new.period_start <> target.period_start
         or new.period_end <> target.period_end then
        raise exception 'A superseding return must cover the same kind and period it replaces'
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  return new;
end $$;

create trigger trg_tax_return_gate before insert or update or delete on tax_returns
  for each row execute function public.tax_return_gate();

comment on table tax_returns is
  'A tax return prepared from this company''s own records. Computed figures are footed from the invoices, declared figures are typed and labelled as declared, and a filed row is immutable.';
comment on column tax_returns.basis is
  'computed = footed by the API from freight_invoices; declared = typed by the preparer because the system holds no purchase invoices.';
comment on column tax_returns.input_tax is
  'Input credit claimed. Never derived: WAISHA records no supplier tax invoices.';
comment on column tax_returns.detail is
  'The invoice schedule the figures were footed from, copied in at prepare time so a filed return cannot be re-footed by later edits.';
comment on column tax_returns.filing_reference is
  'The submission reference an accountant typed after filing. No channel to TRA exists and none is claimed.';

-- ---------------------------------------------------------------------------
-- POLICY + GRANT together (016 lesson). No DELETE privilege: withdrawing a
-- return that should not have happened soft-deletes it, and the gate has already
-- refused that on anything filed.
-- ---------------------------------------------------------------------------
alter table tax_returns enable row level security;
create policy tax_returns_tenant on tax_returns for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on tax_returns to app_runtime;

-- ---------------------------------------------------------------------------
-- Duty keys. Prepared is not filed: the person who assembles the figures is not
-- necessarily the person who submits them, and the register records both names.
--
-- `finance.view` exists because the dashboard door could not ride on
-- `invoices.view`: that key is held by the director and the auditor only, so a
-- finance officer -- the seat this module was built for -- would have opened the
-- page to an empty list. The aggregate money view of the company is its own duty.
-- ---------------------------------------------------------------------------
insert into permissions (key, description)
values
  ('finance.view','Finance - Read the money dashboard: receivables, payables, cash and the tax position beside them'),
  ('tax.view',    'Tax - View the computed tax position and the return register'),
  ('tax.prepare', 'Tax - Build and prepare a return from the records'),
  ('tax.file',    'Tax - File a prepared return, and supersede a filed one')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('finance.view', 'tax.view')
where r.key in ('auditor', 'general_manager', 'finance_officer') and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('finance.view', 'tax.view', 'tax.prepare', 'tax.file')
where r.key in ('director', 'finance_officer') and r.tenant_id is null
on conflict do nothing;

commit;
