-- 111: an import file gets one master document that names its three papers (task #187).
--
-- The user's ask: "Cargo: Import Master Document bundling invoice, packing list, BL/AWB".
--
-- The vault could already hold those papers and the clearing pipeline could already register
-- correspondence per stage (`job_documents`, 042), but neither said which three pieces of paper
-- *are* the file. A clerk answering the customs desk on the phone needs one cover sheet: the
-- commercial invoice's number, date, currency and value; the packing list's number, package count
-- and weights; the bill of lading or air waybill's number and kind — and the actual PDF behind
-- each of those three lines. Today that is three dropdowns in a paper list and a memory.
--
-- So this is not a second document register. `job_documents` records papers moving between parties
-- through a pipeline (issued/received, verified/rejected); `documents` holds bytes. This table
-- holds the *declaration*: one row per cargo file, with three pointers into the vault. It is the
-- sheet a clearing agent signs, which is why the figures freeze when it is signed and the papers
-- stay re-pointable — a bill that arrives a week after the declaration is filed against the same
-- master, while the value already told to customs is not quietly edited.
--
-- Both parent keys are composite for 093's reason: `(shipment_id, tenant_id)` and the three
-- `(document_id, tenant_id)` pairs cannot be satisfied by another company's rows, so a route that
-- forgets one `and tenant_id = $2` in a lookup is stopped by the catalog rather than writing a
-- master that joins this office's file to a stranger's paper. The two `id, tenant_id` unique
-- indexes add no information to their own tables; they exist so a child can point at the pair.
--
-- Money and weight are declared figures, not derived ones. Nothing here reads `cargo_shipments`'
-- `weight_tonnes`/`cbm`: those are what this office typed into the file, and the master's gross
-- and net are what the packing list says. Two numbers that disagree is the useful fact, so the
-- desk is allowed to show both and say which came from where.

begin;

-- The pairs the children may point at.
create unique index if not exists cargo_shipments_id_tenant_uq on cargo_shipments (id, tenant_id);
create unique index if not exists documents_id_tenant_uq on documents (id, tenant_id);

-- ============================================================
-- 1. the master document
-- ============================================================

create table if not exists cargo_import_masters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- One master per file. The file's own number (`4WEM-005-2026`) is its reference; a second
  -- sequence here would give one cargo file two names to quote.
  shipment_id uuid not null,
  foreign key (shipment_id, tenant_id) references cargo_shipments (id, tenant_id),

  -- The commercial invoice, as printed on it.
  invoice_number text,
  invoice_date date,
  invoice_currency text check (invoice_currency is null or invoice_currency ~ '^[A-Z]{3}$'),
  invoice_value numeric(16,2) check (invoice_value is null or invoice_value >= 0),

  -- The packing list: its number and the counts the paper carries.
  packing_list_number text,
  packages_count int check (packages_count is null or packages_count between 1 and 100000),
  package_type text,
  gross_weight_kg numeric(14,3) check (gross_weight_kg is null or gross_weight_kg >= 0),
  net_weight_kg numeric(14,3) check (net_weight_kg is null or net_weight_kg >= 0),

  -- The transport document. `bill_of_lading` and `air_waybill` are the two the ask names; the
  -- sea waybill and the overland/rail notes exist on the same corridor and a clerk should not
  -- have to call an RM note a bill of lading to record its number.
  bill_kind text check (bill_kind is null or bill_kind in (
    'bill_of_lading','sea_waybill','air_waybill','rail_waybill','road_waybill')),
  bill_number text,
  bill_date date,

  -- The three papers themselves. A pointer, never a copy: the bytes stay in the vault under the
  -- cargo file they belong to.
  invoice_document_id uuid,
  packing_document_id uuid,
  bill_document_id uuid,
  foreign key (invoice_document_id, tenant_id) references documents (id, tenant_id),
  foreign key (packing_document_id, tenant_id) references documents (id, tenant_id),
  foreign key (bill_document_id, tenant_id) references documents (id, tenant_id),

  notes text,

  -- The seat that signed the sheet, and when. A declaration to customs is worth nothing without
  -- both, so a signature cannot be recorded without its signer. The check runs one way only:
  -- `on delete set null` below means a seat that leaves the platform takes its name off the
  -- sheet, and the sheet must keep saying when it was signed rather than refuse the deletion.
  declared_by uuid references users(id) on delete set null,
  declared_at timestamptz,

  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  check (declared_by is null or declared_at is not null),
  -- A value with no invoice number behind it is a guess, and a guess on a signed sheet is the
  -- kind that gets a file held.
  check (invoice_value is null or (invoice_number is not null and invoice_currency is not null)),
  -- Net over gross is a typing mistake, never a light cargo.
  check (net_weight_kg is null or gross_weight_kg is null or net_weight_kg <= gross_weight_kg)
);

-- The file side already knows its own id; this is the one the desk reads by.
create unique index if not exists cargo_import_masters_file_uq
  on cargo_import_masters (tenant_id, shipment_id) where deleted_at is null;
-- "Which of my import files has no signed master?" is the register's headline question, and the
-- list query left joins on the file while the count needs the unsigned half.
create index if not exists idx_cargo_import_masters_unsigned
  on cargo_import_masters (tenant_id)
  where deleted_at is null and declared_at is null;

create trigger trg_cargo_import_masters_updated before update on cargo_import_masters
  for each row execute function public.set_updated_at();

alter table cargo_import_masters enable row level security;
create policy cargo_import_masters_tenant on cargo_import_masters for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
-- No DELETE: a signed declaration is kept. The house soft-delete pattern (041) sets `deleted_at`
-- from the route that buries a cargo file, and the audit line stays with it.
grant select, insert, update on cargo_import_masters to app_runtime;

-- ============================================================
-- 2. the shape a master must keep
-- ============================================================
--
-- Three rules the route cannot be trusted to remember, because every one of them is a way for a
-- signed sheet to stop meaning what it says: the paper named must be a paper on THIS file; a
-- sheet may be signed only when it is complete; and a signed sheet's figures are not edited.

create or replace function public.cargo_import_master_shape()
returns trigger language plpgsql set search_path = public as $$
declare
  paper record;
  v_found int;
  missing text;
begin
  -- A pointer must land on a live document of this tenant that is filed on this cargo file. The
  -- composite foreign keys already prove the tenant; this proves the file, which no foreign key
  -- can say (the vault is generic: entity_type/entity_id, not a column per parent).
  for paper in
    select * from (values
      ('invoice_document_id',  new.invoice_document_id,  'The commercial invoice'),
      ('packing_document_id',  new.packing_document_id,  'The packing list'),
      ('bill_document_id',     new.bill_document_id,     'The bill of lading or air waybill')
    ) as t(col, doc_id, label)
  loop
    if paper.doc_id is null then continue; end if;
    select count(*)::int into v_found from documents d
      where d.id = paper.doc_id and d.tenant_id = new.tenant_id
        and d.deleted_at is null
        and d.entity_type = 'shipment' and d.entity_id = new.shipment_id;
    if v_found = 0 then
      raise exception '% named on this master is not a paper on this cargo file.', paper.label
        using errcode = '23514';
    end if;
  end loop;

  if tg_op = 'INSERT' and new.declared_at is not null then
    missing := cargo_import_master_gaps(new.shipment_id, new.invoice_number, new.invoice_date,
      new.invoice_currency, new.invoice_value, new.packing_list_number, new.packages_count,
      new.gross_weight_kg, new.bill_kind, new.bill_number, new.bill_date,
      new.invoice_document_id, new.packing_document_id, new.bill_document_id);
    if missing is not null then
      raise exception 'A master cannot be signed without %.', missing using errcode = '23514';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Un-signing is not a correction, it is an erasure. If the sheet was signed it stays signed.
    if old.declared_at is not null and new.declared_at is distinct from old.declared_at then
      raise exception 'A signed master is not unsigned; a wrong declaration is answered by a new file.';
    end if;

    -- The figures a signed sheet carried are the statement customs has. Papers may still be
    -- pointed at — a bill that arrives late is filed against the same declaration — and the
    -- clerk's own note may grow. Everything else on a signed row is frozen, `shipment_id`
    -- included: a master does not move to another file.
    if old.declared_at is not null and (
         new.shipment_id          is distinct from old.shipment_id
      or new.invoice_number        is distinct from old.invoice_number
      or new.invoice_date          is distinct from old.invoice_date
      or new.invoice_currency      is distinct from old.invoice_currency
      or new.invoice_value         is distinct from old.invoice_value
      or new.packing_list_number   is distinct from old.packing_list_number
      or new.packages_count        is distinct from old.packages_count
      or new.package_type          is distinct from old.package_type
      or new.gross_weight_kg       is distinct from old.gross_weight_kg
      or new.net_weight_kg         is distinct from old.net_weight_kg
      or new.bill_kind             is distinct from old.bill_kind
      or new.bill_number           is distinct from old.bill_number
      or new.bill_date             is distinct from old.bill_date
      or new.created_by            is distinct from old.created_by
      or new.created_at            is distinct from old.created_at) then
      raise exception 'A signed master''s figures are not rewritten; the papers may still be filed and the note added to.';
    end if;

    -- A signature belongs to the seat that made it. The one change the freeze tolerates is the
    -- one the database makes itself when that seat is deleted from the platform: the name goes,
    -- the timestamp above keeps the promise. Nobody may move a signature to another seat.
    if old.declared_at is not null and new.declared_by is not null
       and new.declared_by is distinct from old.declared_by then
      raise exception 'A signed master is not re-signed to another seat.';
    end if;

    -- Signing an existing row goes through the same completeness gate as an insert, so a route
    -- cannot set declared_at with half a sheet behind it.
    if new.declared_at is not null and old.declared_at is null then
      missing := cargo_import_master_gaps(new.shipment_id, new.invoice_number, new.invoice_date,
        new.invoice_currency, new.invoice_value, new.packing_list_number, new.packages_count,
        new.gross_weight_kg, new.bill_kind, new.bill_number, new.bill_date,
        new.invoice_document_id, new.packing_document_id, new.bill_document_id);
      if missing is not null then
        raise exception 'A master cannot be signed without %.', missing using errcode = '23514';
      end if;
    end if;
  end if;

  return new;
end $$;

/**
 * What a signature still lacks, phrased for a clerk rather than for a log.
 *
 * A separate function because the same sentence has to be answerable twice — the trigger refuses
 * a write that tries to sneak a signature in, and the route asks the same question first so it
 * can return "the packing list number and the invoice paper are missing" instead of a 400 with a
 * database message in it. One list of requirements, one place it is written down.
 */
create or replace function public.cargo_import_master_gaps(
  p_shipment_id uuid, p_invoice_number text, p_invoice_date date, p_invoice_currency text,
  p_invoice_value numeric, p_packing_list_number text, p_packages_count int,
  p_gross_weight_kg numeric, p_bill_kind text, p_bill_number text, p_bill_date date,
  p_invoice_document_id uuid, p_packing_document_id uuid, p_bill_document_id uuid
) returns text language sql stable set search_path = public as $$
  select nullif(trim(leading ', ' from (
    case when p_shipment_id is null then ', the cargo file' else '' end
    || case when trim(coalesce(p_invoice_number,'')) = '' then ', the invoice number' else '' end
    || case when p_invoice_date is null then ', the invoice date' else '' end
    || case when p_invoice_currency is null then ', the invoice currency' else '' end
    || case when p_invoice_value is null then ', the invoice value' else '' end
    || case when trim(coalesce(p_packing_list_number,'')) = '' then ', the packing list number' else '' end
    || case when p_packages_count is null then ', the package count' else '' end
    || case when p_gross_weight_kg is null then ', the gross weight' else '' end
    || case when p_bill_kind is null then ', the kind of transport document' else '' end
    || case when trim(coalesce(p_bill_number,'')) = '' then ', the bill or air waybill number' else '' end
    || case when p_bill_date is null then ', the bill or air waybill date' else '' end
    || case when p_invoice_document_id is null then ', the invoice paper' else '' end
    || case when p_packing_document_id is null then ', the packing list paper' else '' end
    || case when p_bill_document_id is null then ', the bill or air waybill paper' else '' end
  )), '')::text;
$$;

drop trigger if exists trg_cargo_import_master_shape on cargo_import_masters;
create trigger trg_cargo_import_master_shape before insert or update
  on cargo_import_masters for each row execute function public.cargo_import_master_shape();

-- 110's lesson, applied here rather than in a later sweep: a function created by a migration
-- arrives with EXECUTE for PUBLIC even when the default-privileges rule says otherwise, and
-- `app_runtime` inherits that birthright. These two are trigger-shaped, but the completeness
-- reader is a plain function that answers a question the guards were meant to be the only
-- source of, so both are pinned at the same time as they are granted.
grant execute on function public.cargo_import_master_shape() to app_runtime;
grant execute on function public.cargo_import_master_gaps(uuid, text, date, text, numeric, text,
  int, numeric, text, text, date, uuid, uuid, uuid) to app_runtime;
revoke execute on function public.cargo_import_master_shape() from public, anon, authenticated;
revoke execute on function public.cargo_import_master_gaps(uuid, text, date, text, numeric, text,
  int, numeric, text, text, date, uuid, uuid, uuid) from public, anon, authenticated;

comment on table cargo_import_masters is
  'One signed cover sheet per cargo file: the commercial invoice, the packing list and the bill of lading or air waybill, each with the number printed on it and the paper filed behind it.';
comment on column cargo_import_masters.declared_at is
  'When a seat holding shipments.declare signed the sheet. Nothing except the three paper pointers and the note may change after this is set.';
comment on column cargo_import_masters.gross_weight_kg is
  'What the packing list says, not what the cargo file says. The two are allowed to disagree and the desk says so.';

-- ============================================================
-- 3. the duty
-- ============================================================
--
-- Reading and editing the master stay on the file's own keys. Signing it is a duty of its own,
-- because the sheet is what this office tells customs the goods are worth, and it is given to
-- exactly the seats that may already edit the file. `auditor` holds view and export only, so it
-- reads a master and bundles it; it never signs one.

insert into permissions (key, description) values
  ('shipments.declare', 'Cargo - Sign a file''s master document (invoice, packing list, bill or air waybill)')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'shipments.declare'
  from roles r
 where r.tenant_id is null
   and r.key <> 'auditor'
   and exists (
     select 1 from roles c
       join role_permissions cp on cp.role_id = c.id
      where c.tenant_id is null and c.key = r.key
        and cp.permission_key = 'shipments.edit'
   )
on conflict do nothing;

-- ============================================================
-- 4. prove the register opened
-- ============================================================

do $$ declare
  v_rows int;
  v_leak text;
begin
  select count(*)::int into v_rows from cargo_import_masters;
  -- 110's shape, proven rather than invented: a null proacl is the default ACL, in which PUBLIC
  -- holds EXECUTE, so a new function with no acl is the leak this is looking for.
  select string_agg(x.fn, ', ') into v_leak from (
    select p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('cargo_import_master_shape', 'cargo_import_master_gaps')
       and (p.proacl is null
            or exists (select 1 from aclexplode(p.proacl) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  ) x;
  if v_leak is not null then
    raise exception '111 left PUBLIC EXECUTE on: %', v_leak using errcode = 'P0001';
  end if;
  raise notice '111: the master document register is open; % sheet(s) in it, shipments.declare held by the desks that edit files', v_rows;
end $$;

commit;
