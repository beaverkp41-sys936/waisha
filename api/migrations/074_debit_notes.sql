-- 074 — Debit notes for the CFA desk (follows the freight invoice shape of 029).
--
-- A debit note is the paper a clearing agent raises when charges arrive after the
-- invoice was written: demurrage that ran past the free days, a re-worked entry,
-- handling nobody quoted. It is a billing document, not a payment — nothing here
-- receives money. It mirrors `freight_invoices` deliberately: same customer
-- fields with the same PII treatment, same `numeric(14,2)` money, same flat
-- VAT arithmetic computed by the route, DN-#### numbering per tenant.
--
-- Two doors are closed by trigger rather than by handler, because 072's lesson
-- is that a guard which lives only in one handler is a guard the next handler
-- forgets:
--   * a note is born a draft and nothing else;
--   * an issued note is a record — it can only be cancelled, by a person, with
--     a reason (the same rule an issued payroll run answers to);
--   * a cancelled note is also a record — nothing edits it afterwards;
--   * only a draft can be hard-deleted. Taking any other note off the register is a
--     tombstone (`deleted_at`), the same escape hatch 072 gives a cancelled run, so
--     the row survives for the auditors even when the desk stops showing it.
--
-- No new permission keys: a debit note sits on the same finance desk as the
-- invoices, so the routes answer to `invoices.view/create/edit/delete` and the
-- existing role matrix carries it.
--
-- `related_invoice_id` points at the bill the debit belongs to when there is
-- one; it is optional and SET NULL on the invoice's deletion, because a debit
-- note about demurrage often predates any invoice at all.

begin;

create table if not exists debit_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  debit_note_number text not null,
  customer_name text not null,
  customer_phone_encrypted bytea,
  customer_phone_search text,
  customer_email text,
  customer_tin text,
  customer_address text,
  reason text not null,
  reference text,
  related_invoice_id uuid references freight_invoices(id) on delete set null,
  issue_date date not null default current_date,
  currency text not null default 'TZS',
  vat_rate numeric(5,2) not null default 18,
  subtotal numeric(14,2) not null default 0,
  vat_amount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  status text not null default 'draft' check (status in ('draft','issued','cancelled')),
  issued_by uuid, issued_at timestamptz,
  cancelled_by uuid, cancelled_at timestamptz, cancel_reason text,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index debit_notes_tenant_number_uq on debit_notes (tenant_id, debit_note_number)
  where deleted_at is null;
create index idx_debit_notes_tenant on debit_notes (tenant_id);
create index idx_debit_notes_tenant_status on debit_notes (tenant_id, status) where deleted_at is null;
create trigger trg_debit_notes_updated before update on debit_notes
  for each row execute function public.set_updated_at();

create table if not exists debit_note_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  debit_note_id uuid not null references debit_notes(id) on delete cascade,
  seq int not null,
  description text not null,
  quantity numeric(12,2) not null default 1,
  unit text,
  unit_price numeric(14,2) not null default 0,
  amount numeric(14,2) not null default 0
);
create index idx_debit_note_items_note on debit_note_items (debit_note_id, seq);

-- The lifecycle guard. Column freezes for an issued note are the absence of an
-- allowed branch: no update to an issued row passes except the named cancel.
create or replace function public.debit_note_gate()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'A debit note is born a draft. Issue it from the desk once it is checked.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception '% is a record of what was charged. Only a draft can be deleted.', old.debit_note_number
        using errcode = 'P0001';
    end if;
    return old;
  end if;

  -- A tombstone is not an edit. Any note can be taken off the register this way,
  -- issued or cancelled included, because the row itself keeps every figure.
  if new.deleted_at is not null then
    return new;
  end if;

  if old.status = 'cancelled' then
    raise exception 'A cancelled note is a record. Raise a fresh one.'
      using errcode = 'P0001';
  end if;

  if old.status = 'issued' then
    if new.status = 'cancelled'
       and new.cancelled_by is not null
       and new.cancel_reason is not null and btrim(new.cancel_reason) <> '' then
      return new;
    end if;
    raise exception '% has been issued, so it is frozen. Cancel it with a reason and raise a fresh note.', old.debit_note_number
      using errcode = 'P0001';
  end if;

  return new;
end $$;
create trigger trg_debit_note_gate before insert or update or delete on debit_notes
  for each row execute function public.debit_note_gate();

-- POLICY + GRANT together (016 lesson)
alter table debit_notes enable row level security;
create policy debit_notes_tenant on debit_notes for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on debit_notes to app_runtime;

alter table debit_note_items enable row level security;
create policy debit_note_items_tenant on debit_note_items for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on debit_note_items to app_runtime;

commit;
