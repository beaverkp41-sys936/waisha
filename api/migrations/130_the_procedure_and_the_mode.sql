-- 130: The procedure and the mode.
--
-- The office works from two printed code lists and the platform has so far kept neither of them as
-- data. A CPC is chosen from a page of EAC procedures and then typed into a free-text box, and the
-- movement a cargo file travels by is a word on the file with no number behind it, while the file
-- number's own first digit — 1 export, 4 import, 7 transhipment, 8 transit (034) — is the same
-- classification the CPC's first digit carries. Two lists that are really one list read twice.
--
-- So this file makes both of them tables, and binds them:
--
--   * `mode_of_transport`   — the six EAC transport modes, each one naming the transport document
--                             it travels on, which is exactly the vocabulary 111 already froze on
--                             the master sheet (`bill_kind`). The mode and the master stop being two
--                             answers to one question.
--   * `customs_procedure_code` — the six procedures the desk declares under, each bound to the
--                             movement its own first digit names.
--   * `cargo_shipments.mode_code / .cpc_code` — pointers, never copies, both nullable: a file
--                             opened before today keeps its old blank and gains the codes when the
--                             clerk next touches it.
--   * `cargo_procedure_matches_the_file()` — the guard that refuses an import procedure on an export
--                             file. A cargo file and the declaration inside it must say the same
--                             movement, and the number printed on the file is the thing a clerk
--                             reads aloud at the border.
--
-- Neither list belongs to a tenant. They are statutory words set by the community, the same for
-- every office on the platform, so they are readable by all and writable by none from the app role
-- — the shape 013's ports and 052's global charge catalog already use.
begin;

-- ============================================================
-- 1. the mode of transport
-- ============================================================

create table if not exists mode_of_transport (
  -- The published code is the whole argument for keeping this as a table: a clerk reads "mode 4"
  -- to the border and means Air Transport. The number is therefore the key, not a row id.
  code int primary key check (code between 1 and 6),
  key text not null unique check (key ~ '^[a-z][a-z_]{2,30}$'),
  label text not null,
  -- What the party who moves the goods is called on this mode's paper. One column so the form asks
  -- for "Shipping line" on a sea movement and "Airline" on an air one instead of making the clerk
  -- guess which of its boxes is which.
  carrier_word text,
  -- The transport document this mode travels on, in 111's own words. NULL for the two modes that
  -- ride on somebody else's paper: postal mail moves under a receipt and a multimodal movement
  -- carries a document per leg, so neither has one answer to give.
  bill_kind text check (bill_kind is null or bill_kind in (
    'bill_of_lading','sea_waybill','air_waybill','rail_waybill','road_waybill')),
  note text,
  sort int not null default 0
);

comment on table mode_of_transport is
  'The EAC modes of transport, keyed by their published code. Reference data: read by every
   tenant, written by none from the app role.';

-- POLICY + GRANT together (016 lesson). No write policy exists, so the vocabulary cannot be
-- rewritten from the app role even by a seat holding every cargo duty.
alter table mode_of_transport enable row level security;
create policy mode_of_transport_read on mode_of_transport for select to app_runtime using (true);
grant select on mode_of_transport to app_runtime;

insert into mode_of_transport (code, key, label, carrier_word, bill_kind, note, sort) values
  (1, 'maritime',  'Maritime (Sea)',      'Shipping line', 'bill_of_lading',
      'Carried by a vessel to a port or an inland depot.', 10),
  (2, 'rail',      'Rail Transport',      'Rail operator', 'rail_waybill',
      'Carried by rail, on the corridor the union runs its transit traffic over.', 20),
  (3, 'road',      'Road Transport',      'Road carrier',  'road_waybill',
      'Carried by truck, the leg every other mode hands its box to at one end or both.', 30),
  (4, 'air',       'Air Transport',       'Airline',       'air_waybill',
      'Carried by air.', 40),
  (5, 'mail',      'Mail (Postal)',       null,            null,
      'Carried as post, under a postal receipt rather than a transport document.', 50),
  (6, 'multimodal','Multimodal',          null,            null,
      'Two or more modes under one consignment; the paper belongs to the leg, not to the '
      'movement.', 60)
on conflict (code) do nothing;

-- ============================================================
-- 2. the customs procedure code
-- ============================================================

create table if not exists customs_procedure_code (
  code text primary key check (code ~ '^[0-9]{4}$'),
  shipment_type text not null check (shipment_type in ('export','import','transhipment','transit')),
  label text not null,
  note text,
  sort int not null default 0,
  -- The interlink, declared once on the vocabulary row itself rather than left to the app: the
  -- first digit of a CPC names the movement, and that movement is the prefix of the file number
  -- the office quotes for the cargo file (034). An 8xxx procedure cannot belong to a 4xxxx file.
  -- A cargo file cannot carry a code that contradicts its own type until this row does, which is
  -- why the pair is asserted in both directions by the gate at the bottom of this file.
  check (left(code, 1) = case shipment_type
    when 'export'       then '1'
    when 'import'       then '4'
    when 'transhipment' then '7'
    when 'transit'      then '8'
    end)
);

comment on table customs_procedure_code is
  'The EAC/CMA customs procedure codes an office declares under, keyed by the code and bound to the '
  'movement its first digit names. Reference data, read by every tenant.';

alter table customs_procedure_code enable row level security;
create policy customs_procedure_code_read on customs_procedure_code
  for select to app_runtime using (true);
grant select on customs_procedure_code to app_runtime;

-- The six the desk works from. `label` is the EAC wording, so the paper, the register and the
-- declaration answer with the same name.
insert into customs_procedure_code (code, shipment_type, label, note, sort) values
  ('1000', 'export',       'Permanent Export',
      'Goods leaving the union for good. The export declaration is filed under this code.', 10),
  ('4000', 'import',       'Direct Import for Home Consumption',
      'Duty and the statutory taxes are paid at declaration and the goods stay in the country.', 20),
  ('4200', 'import',       'Import under Duty Remission or Tax Exemption',
      'Goods enter for home consumption under a remission or exemption the office holds; the paper '
      'that grants it is a document on the file.', 30),
  ('7000', 'transhipment', 'Pure Transhipment',
      'The cargo does not enter the country: it is moved off the arriving paper onto a departing '
      'one under bond.', 40),
  ('8000', 'transit',      'International Transit Movement',
      'Goods cross the country under bond to another partner state. The taxes are held, not paid.', 50),
  ('8200', 'transit',      'Inland Container Depot / Bonded Warehouse',
      'The box sits at an ICD or in a bonded store under the transit paper that carried it in.', 60)
on conflict (code) do nothing;

-- ============================================================
-- 3. the two pointers on the cargo file
-- ============================================================

alter table cargo_shipments
  add column if not exists mode_code int references mode_of_transport(code),
  add column if not exists cpc_code  text references customs_procedure_code(code);

-- Both are filters the register is asked for: "everything bonded in at the ICD", "every sea
-- movement". Partial, because most older files carry neither and the register should not index a
-- column that is mostly NULL.
create index if not exists idx_cargo_shipments_cpc
  on cargo_shipments (tenant_id, cpc_code) where deleted_at is null and cpc_code is not null;
create index if not exists idx_cargo_shipments_mode
  on cargo_shipments (tenant_id, mode_code) where deleted_at is null and mode_code is not null;

-- ============================================================
-- 4. the guard: a file and its procedure must name the same movement
-- ============================================================

create or replace function public.cargo_procedure_matches_the_file()
returns trigger language plpgsql set search_path = public as $$
declare
  v_type  text;
  v_label text;
begin
  -- Absent means "not yet classified", which is the state every file opened before today is in.
  -- The rule is about a code that is there, not about one that is missing.
  if new.cpc_code is null then return new; end if;

  select c.shipment_type, c.label into v_type, v_label
    from customs_procedure_code c where c.code = new.cpc_code;
  if v_type is null then
    -- The foreign key gets here first for a code that does not exist; this half exists so the
    -- message a clerk reads is never a bare constraint name.
    raise exception 'CPC % is not a procedure the office declares under.', new.cpc_code
      using errcode = '23514';
  end if;

  if v_type <> new.shipment_type then
    raise exception 'CPC % (%) is a procedure for %. This file''s movement is % and its number '
      'begins %, so the code does not belong on it.',
      new.cpc_code, v_label, v_type, new.shipment_type,
      case new.shipment_type when 'export' then '1' when 'import' then '4'
        when 'transhipment' then '7' else '8' end
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_cargo_procedure_matches_the_file on cargo_shipments;
create trigger trg_cargo_procedure_matches_the_file
  before insert or update of cpc_code, shipment_type on cargo_shipments
  for each row execute function public.cargo_procedure_matches_the_file();

-- A trigger must not be callable as a function (096's lesson).
revoke execute on function public.cargo_procedure_matches_the_file()
  from public, anon, authenticated;
grant execute on function public.cargo_procedure_matches_the_file() to app_runtime;

-- ============================================================
-- 5. gate
-- ============================================================

do $$
declare
  v_modes   int;
  v_codes   int;
  v_types   int;
  v_leaks   int;
  v_bad     int;
  v_before  int;
  v_after   int;
  v_office  uuid;
  v_slipped boolean;
  v_111     text;
begin
  -- 1. the lists are complete and shaped as the papers say.
  select count(*)::int into v_modes from mode_of_transport;
  if v_modes <> 6 then
    raise exception '130: mode_of_transport holds % row(s), not the six published EAC modes',
      v_modes;
  end if;
  select count(*)::int into v_leaks from mode_of_transport m
    left join (values (1),(2),(3),(4),(5),(6)) c(code) using (code)
   where c.code is null;
  if v_leaks > 0 then
    raise exception '130: a mode is filed under a code outside 1-6';
  end if;

  select count(*)::int into v_codes from customs_procedure_code;
  if v_codes <> 6 then
    raise exception '130: customs_procedure_code holds % row(s), not the six the desk declares '
      'under', v_codes;
  end if;
  -- Every movement the platform keeps a file for must be declarable, or the CPC block on the form
  -- is empty for that type and the clerk has nothing to pick.
  select count(*)::int into v_types
    from (values ('export'),('import'),('transhipment'),('transit')) t(s)
   where exists (select 1 from customs_procedure_code c where c.shipment_type = t.s);
  if v_types <> 4 then
    raise exception '130: % of the four movements has no procedure code to declare under',
      4 - v_types;
  end if;

  -- 2. the interlink is the one the file number uses. Stated here from 034's own comment rather
  -- than read back from the table, so a row that agrees with a wrong table still fails.
  select count(*)::int into v_leaks from customs_procedure_code c
   where left(c.code, 1) <> case c.shipment_type
     when 'export' then '1' when 'import' then '4'
     when 'transhipment' then '7' when 'transit' then '8' end;
  if v_leaks > 0 then
    raise exception '130: % procedure(s) whose first digit contradicts the movement they are filed '
      'under', v_leaks;
  end if;
  -- A CHECK can be dropped by a hand at the database. The pairing that matters is then carried by
  -- nothing, so its existence is asserted, not assumed — matched on the words it must contain,
  -- because pg_get_constraintdef rewrites an expression into its own shape.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'customs_procedure_code'::regclass and contype = 'c'
                    and pg_get_constraintdef(oid) like '%left%'
                    and pg_get_constraintdef(oid) like '%shipment_type%') then
    raise exception '130: the CPC table lost the CHECK that binds a code to its movement';
  end if;

  -- 3. the mode's paper is one of 111's words, read from 111 rather than restated.
  select pg_get_constraintdef(oid) into v_111 from pg_constraint
   where conrelid = 'cargo_import_masters'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%bill_kind%';
  if v_111 is null then
    raise exception '130: 111''s bill_kind CHECK is gone — the master sheet no longer says what a '
      'transport document is';
  end if;
  -- pg_get_constraintdef wraps the whole expression in its own parentheses, so both sides are
  -- matched word by word instead of string by string.
  select count(*)::int into v_leaks from mode_of_transport m
   where m.bill_kind is not null
     and v_111 not like '%''' || m.bill_kind || '''%';
  if v_leaks > 0 then
    raise exception '130: % mode(s) name a transport document 111 will not accept on a master '
      'sheet', v_leaks;
  end if;
  if (select count(*)::int from mode_of_transport where bill_kind is not null) < 4 then
    raise exception '130: fewer than four modes name the document they travel on — the master '
      'sheet has nothing to be told by';
  end if;

  -- 4. the pointers, their types and their foreign keys.
  select count(*)::int into v_leaks
    from (values ('mode_code','integer'),('cpc_code','text')) c(col, udt)
    left join information_schema.columns k
      on k.table_schema = 'public' and k.table_name = 'cargo_shipments'
     and k.column_name = c.col
   where k.column_name is null or k.data_type <> c.udt;
  if v_leaks > 0 then
    raise exception '130: % of the two new columns on the cargo file is missing or typed wrong '
      '(mode_code integer, cpc_code text)', v_leaks;
  end if;
  select count(*)::int into v_leaks from pg_constraint
   where conrelid = 'cargo_shipments'::regclass and contype = 'f'
     and confrelid in ('mode_of_transport'::regclass, 'customs_procedure_code'::regclass);
  if v_leaks <> 2 then
    raise exception '130: % foreign key(s) from the cargo file to the two lists (both are needed, '
      'or a typo becomes a code the register will never show)', v_leaks;
  end if;

  -- 5. who may reach the doors.
  if not has_function_privilege('app_runtime', 'public.cargo_procedure_matches_the_file()',
                                'EXECUTE') then
    raise exception '130: the guard cannot run as the app role — it would fire only for the '
      'migrator and never for a clerk';
  end if;
  if has_function_privilege('public', 'public.cargo_procedure_matches_the_file()', 'EXECUTE')
     or has_function_privilege('anon', 'public.cargo_procedure_matches_the_file()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.cargo_procedure_matches_the_file()',
                               'EXECUTE') then
    raise exception '130: the guard is callable as a function by a web role — 096''s lesson';
  end if;
  if (select count(*)::int from pg_trigger
       where tgrelid = 'cargo_shipments'::regclass
         and tgname = 'trg_cargo_procedure_matches_the_file' and not tgisinternal) <> 1 then
    raise exception '130: the guard is not attached to the cargo file';
  end if;

  select count(*)::int into v_leaks from (values
    ('mode_of_transport'), ('customs_procedure_code')) t(tbl)
   where not has_table_privilege('app_runtime', t.tbl, 'SELECT')
      or has_table_privilege('app_runtime', t.tbl, 'INSERT')
      or has_table_privilege('app_runtime', t.tbl, 'UPDATE')
      or has_table_privilege('app_runtime', t.tbl, 'DELETE')
      or not (select relrowsecurity from pg_class where oid = t.tbl::regclass);
  if v_leaks > 0 then
    raise exception '130: % reference table(s) are writable by the app role or closed to it or '
      'ship with RLS off — statutory words are not a tenant''s to edit', v_leaks;
  end if;

  -- 6. the pairing, run live. plpgsql parses each statement the first time it reaches it, so the
  -- column list, both foreign keys and the trigger are all proven here rather than assumed from
  -- the text above. A tenant is needed for the row; without one this probe would prove nothing.
  select count(*)::int into v_before from cargo_shipments;
  select t.id into v_office from tenants t
   where coalesce(t.type, '') not in ('platform', 'seeker') and t.deleted_at is null
   order by t.created_at limit 1;
  if v_office is null then
    raise notice '130: no live office tenant exists, so the pairing was checked by its CHECK and '
      'its trigger definition only';
  else
    -- 6a. a correct pairing must be accepted: an import file on a sea movement under 4000.
    v_slipped := false;
    begin
      insert into cargo_shipments (tenant_id, file_number, seq, file_year, shipment_type,
          container_type, consignee_name, consignor_name, mode_code, cpc_code)
      values (v_office, '130GATE-000-2125', 990, 2125, 'import', '20ft',
          'the gate', 'the gate', 1, '4000');
      v_slipped := true;
      raise exception 'rollback the probe' using errcode = 'P0001';
    exception
      when raise_exception then
        if not v_slipped then
          raise exception '130: the pairing probe raised inside itself — %', sqlerrm;
        end if;
      when check_violation then
        raise exception '130: a sea/import file declaring under 4000 was refused — %', sqlerrm;
      when foreign_key_violation then
        raise exception '130: the cargo file cannot point at mode 1 or CPC 4000, both of which '
          'this file just seeded — %', sqlerrm;
    end;
    if (select count(*)::int from cargo_shipments
         where tenant_id = v_office and file_number = '130GATE-000-2125') <> 0 then
      raise exception '130: the good-pairing probe left its row behind';
    end if;

    -- 6b. the same code on an export file must be turned away, in the clerk's own words.
    v_bad := 0;
    begin
      insert into cargo_shipments (tenant_id, file_number, seq, file_year, shipment_type,
          container_type, consignee_name, consignor_name, mode_code, cpc_code)
      values (v_office, '130GATE-001-2125', 991, 2125, 'export', '20ft',
          'the gate', 'the gate', 4, '4000');
      v_bad := 1;
      raise exception 'rollback the probe' using errcode = 'P0001';
    exception
      when raise_exception then
        if v_bad = 1 then
          raise exception '130: the guard accepted a 4xxx procedure on an export file';
        end if;
        if sqlerrm not like '130:%' then
          raise exception '130: the mismatch probe raised inside itself — %', sqlerrm;
        end if;
      when check_violation then
        if sqlerrm not like 'CPC 4000%begins 1%' then
          raise exception '130: the guard turns a mismatched procedure away without naming the '
            'movement and the file number''s first digit — %', sqlerrm;
        end if;
    end;
    if (select count(*)::int from cargo_shipments
         where tenant_id = v_office and file_number = '130GATE-001-2125') <> 0 then
      raise exception '130: the refused pairing was written before it was refused';
    end if;

    -- A code from neither list is the foreign key's to refuse, and it must refuse it.
    v_bad := 0;
    begin
      insert into cargo_shipments (tenant_id, file_number, seq, file_year, shipment_type,
          container_type, consignee_name, consignor_name, mode_code, cpc_code)
      values (v_office, '130GATE-002-2125', 992, 2125, 'import', '20ft',
          'the gate', 'the gate', 9, '9999');
      v_bad := 1;
      raise exception 'rollback the probe' using errcode = 'P0001';
    exception
      when raise_exception then
        if v_bad = 1 then
          raise exception '130: the cargo file accepted a mode outside 1-6 and a CPC that is in '
            'no list';
        end if;
      when foreign_key_violation then null;
      when check_violation then null;
    end;
  end if;

  -- 7. nothing above was kept.
  select count(*)::int into v_after from cargo_shipments;
  if v_after <> v_before then
    raise exception '130: the gate left % cargo row(s) behind', v_after - v_before;
  end if;

  raise notice '130: the procedure and the mode are live — % mode(s) naming the document they '
    'travel on, % procedure(s) bound to the movement their first digit names, and a cargo file '
    'that cannot carry a % of the two', v_modes, v_codes, 'code from another movement';
end $$;

commit;
