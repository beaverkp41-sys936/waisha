-- 132: The regime and the codes it prints.
--
-- 130 made the procedure codes a table and bound each one to the movement its own first digit names.
-- That was right for the four-digit EAC codes and wrong for the paper the desk actually reads from:
-- the classification block prints a movement as a REGIME and then names the codes under it in the
-- words the community set — IMPORT is 40 and 42, EXPORT is 10, TRANSIT is T1 and 80 for foreign goods
-- under customs control and T2 for internal transit through a third territory, TRANSHIPMENT is the 50
-- to 70 series or the general indicator TR. Three of those are letters, so 130's `code ~ '^[0-9]{4}$'`
-- refused them and its `left(code, 1) = case shipment_type …` had nothing to compare. A clerk holding
-- a T1 transit paper could only file it under a number it does not carry.
--
-- So the block's own shape is made data here:
--
--   * `customs_regime` — the four printed movements, each one carrying the office's words for what the
--                        regime does to the goods, the series of codes it is declared under, the
--                        pattern a code of that regime must fit, and the digit its file numbers start
--                        on. This is the layer 130's hardcoded CASE was reaching for: one row per
--                        movement instead of a case expression in two languages.
--   * `customs_procedure_code` keeps being the one list of declarable codes. Its shape CHECK is
--                        widened past four digits, a CHECK stops it holding a lowercase form of a
--                        code no paper prints, and its `shipment_type` is now a foreign key into the
--                        regime above it rather than a word standing on its own.
--   * `customs_code_fits_its_regime()` — the guard that applies the regime's own pattern, so a 40
--                        cannot be filed as a transit procedure and a T2 cannot be filed as an import
--                        one, whoever writes the row.
--   * `cargo_procedure_matches_the_file()` is rewritten to quote the regime's words when it refuses a
--                        code, because "its number begins 8" is no longer the whole reason a letter
--                        indicator does not belong on the file.
--
-- The ten codes the block names are seeded next to 130's six, and none of the six move: cargo files
-- already point at them, and a file's pointer is a code, not a copy of a description. Neither list
-- belongs to a tenant — they are statutory words set by the community, readable by all and writable
-- by none from the app role, the shape 013's ports, 052's charge catalog and 130's two lists use.
begin;

-- ============================================================
-- 1. the regime: what a movement does to the goods
-- ============================================================

create table if not exists customs_regime (
  -- The regime IS the movement the cargo file carries, so the four words are the join and not a
  -- translation table beside it. A file has a `shipment_type` before it has a code, and this is the
  -- row the classification block prints above the code list.
  shipment_type text primary key check (shipment_type in ('export','import','transhipment','transit')),
  label text not null,
  note text not null,
  -- The codes in the words the paper groups them in — "the 50 to 70 series, or the general indicator
  -- TR". The desk quotes this instead of holding a sixth copy of a sentence clerks read off a form.
  series_words text not null,
  -- The interlink, now data: the shape a code filed under this regime must have. A CHECK cannot read
  -- another row, so `customs_code_fits_its_regime()` applies this pattern on every write.
  code_pattern text not null,
  -- 034's digit. The file number and the regime are one fact read twice, so it lives here and 130's
  -- trigger keeps quoting it when it turns a code away from a file.
  file_prefix text not null check (length(file_prefix) = 1 and file_prefix between '0' and '9'),
  sort int not null default 0
);

comment on table customs_regime is
  'The four printed customs regimes — what a movement does to the goods, the codes it declares under '
  'and the digit its file numbers start on. Reference data: read by every tenant, written by none '
  'from the app role.';

-- POLICY + GRANT together (016 lesson). No write policy exists, so a regime cannot be reworded from
-- the app role even by a seat holding every cargo duty.
alter table customs_regime enable row level security;
drop policy if exists customs_regime_read on customs_regime;
create policy customs_regime_read on customs_regime for select to app_runtime using (true);
grant select on customs_regime to app_runtime;

-- In the order the block prints them. Each `note` says what happens to the goods and to the money,
-- because that is the question a new clerk is actually asking when they pick a movement.
insert into customs_regime
  (shipment_type, label, note, series_words, code_pattern, file_prefix, sort) values
  ('import', 'Import',
      'Goods are entered into the country and stay there: the office presents the declaration, pays '
      'the duty and the statutory taxes and takes the release.',
      'codes 40 and 42',
      '^4[0-9]{1,3}$', '4', 10),
  ('export', 'Export',
      'Goods leave the country for good under an outbound declaration; nothing is owed here and the '
      'paper the movement travels on is the one the departing carrier signs.',
      'code 10',
      '^1[0-9]{1,3}$', '1', 20),
  ('transit', 'Transit',
      'Goods cross the country under customs control and are discharged at another office. The taxes '
      'are held against the transit paper, not paid here.',
      'codes T1 and 80 for foreign goods under customs control, and T2 for the internal transit of '
      'community goods through a third territory',
      '^(8[0-9]{1,3}|T[12])$', '8', 30),
  ('transhipment', 'Transhipment',
      'Cargo is temporarily offloaded from the arriving vessel or vehicle onto a departing one inside '
      'a customs-controlled port zone. It does not enter the country, so no duty is owed on it.',
      'the 50 to 70 series, or the general indicator TR',
      '^([5-7][0-9]{1,3}|TR)$', '7', 40)
on conflict (shipment_type) do nothing;

-- ============================================================
-- 2. the procedure list stops being four digits long
-- ============================================================

-- 130's two CHECKs are dropped by the shape of their definition rather than by a guessed name: an
-- unnamed table-level CHECK on the same column as a column CHECK is numbered by Postgres, and the
-- number is not something this file should have to remember. Both shapes are matched on the whole
-- quoted literal, because the depicter writes `left` as "left" and reflows a CASE onto its own
-- lines — 130's own lesson about pg_get_constraintdef, applied here. The four-digit literal is
-- quoted end to end so the CHECK added below, which contains four digits inside a wider alternation,
-- cannot be mistaken for it.
do $$
declare
  v_rec record;
begin
  for v_rec in
    select conname from pg_constraint
     where conrelid = 'public.customs_procedure_code'::regclass and contype = 'c'
       and (pg_get_constraintdef(oid) like '%''^[0-9]{4}$''::text%'
            or pg_get_constraintdef(oid) like '%CASE shipment_type%')
  loop
    execute 'alter table public.customs_procedure_code drop constraint ' || quote_ident(v_rec.conname);
  end loop;
end $$;

-- The code is the whole argument for this file, so its shape is the first thing a row must answer
-- for. Each constraint is dropped before it is added, so a re-run of this file lands the same schema
-- rather than failing on a name that is already there.
alter table customs_procedure_code
  drop constraint if exists cpc_code_shape,
  drop constraint if exists cpc_code_is_printed,
  drop constraint if exists cpc_regime,
  -- The three shapes a printed code can take: a regime's own two-digit code, a four-digit EAC
  -- declaration code, or a letter indicator. Three digits is not on any of the papers.
  add constraint cpc_code_shape check (code ~ '^([0-9]{2}|[0-9]{4}|T[12R])$'),
  -- The primary key is matched exactly, so a row filed as "t1" would be a code no clerk can ever
  -- reach. The community prints indicators in capitals; the list holds them that way.
  add constraint cpc_code_is_printed check (code = upper(code)),
  -- A movement that has no regime row cannot have codes: the block would have no header to print
  -- over its list. This is the half the case expression used to carry.
  add constraint cpc_regime foreign key (shipment_type) references customs_regime(shipment_type);

-- ============================================================
-- 3. the guard on the list itself
-- ============================================================

create or replace function public.customs_code_fits_its_regime()
returns trigger language plpgsql set search_path = public as $$
declare
  v_regime text;
  v_series text;
  v_pattern text;
begin
  select r.label, r.series_words, r.code_pattern into v_regime, v_series, v_pattern
    from customs_regime r where r.shipment_type = new.shipment_type;
  if v_regime is null then
    -- The foreign key gets here first for a movement that is not a regime; this half exists so the
    -- message a clerk reads is never a bare constraint name.
    raise exception 'There is no % regime, so no code can be filed under it.', new.shipment_type
      using errcode = '23514';
  end if;

  if new.code !~ v_pattern then
    raise exception 'CPC % cannot be a % procedure. The block prints % under %.',
      new.code, new.shipment_type, v_regime, v_series
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_customs_code_fits_its_regime on customs_procedure_code;
create trigger trg_customs_code_fits_its_regime
  before insert or update of code, shipment_type on customs_procedure_code
  for each row execute function public.customs_code_fits_its_regime();

-- A trigger must not be callable as a function (096's lesson).
revoke execute on function public.customs_code_fits_its_regime()
  from public, anon, authenticated;
grant execute on function public.customs_code_fits_its_regime() to app_runtime;

-- ============================================================
-- 4. the codes the block prints
-- ============================================================

-- Seeded after the guard, so a row that contradicts its own regime stops this file rather than
-- reaching a desk. 130's six are left exactly where they are: a cargo file points at a code, and a
-- code that has been quoted at a border cannot be withdrawn from under the file that carries it.
insert into customs_procedure_code (code, shipment_type, label, note, sort) values
  ('10', 'export',       'Permanent Outbound Dispatch',
      'The block''s export code: goods leaving the country for good under one outbound declaration.',
      11),
  ('40', 'import',       'Permanent / Definitive Entry',
      'Goods entered for home consumption and allowed to stay. Duty and the statutory taxes are paid '
      'at entry and the office takes the release.', 21),
  ('42', 'import',       'Home Consumption and Domestic Dispatch Together',
      'The goods are entered for home consumption and moved on to a destination inside the country on '
      'the same paper, so clearing and dispatching are one act and not two files.', 31),
  ('80', 'transit',      'Foreign Goods Under Customs Control',
      'The numbered form of the movement the transit paper carries as T1: non-community goods crossing '
      'the country under bond, taxes held and not paid.', 51),
  ('T1', 'transit',      'Community Transit Paper (T1)',
      'Foreign or non-community goods moving under customs control. The office reads the indicator on '
      'the transit paper rather than a number, and 80 is the same movement on the block.', 52),
  ('T2', 'transit',      'Internal Transit Paper (T2)',
      'Community or national goods that leave and cross a third territory before arriving back: the '
      'movement is internal, so the goods keep the status they started with.', 53),
  ('50', 'transhipment', 'Transhipment, the 50 to 70 Series',
      'Cargo taken temporarily off the arriving vessel or vehicle and onto a departing one inside a '
      'customs-controlled port zone; no duty is owed because the goods do not enter the country. Code '
      '50 of the series.', 41),
  ('60', 'transhipment', 'Transhipment, the 50 to 70 Series',
      'The same movement as 50 and 70: cargo moved between two papers inside the zone under bond. '
      'Code 60 of the series.', 42),
  ('70', 'transhipment', 'Transhipment, the 50 to 70 Series',
      'The same movement as 50 and 60, filed when the paper carries 70. A code from the series is '
      'chosen over TR whenever the paper states one.', 43),
  ('TR', 'transhipment', 'Transhipment — General Indicator TR',
      'The single answer the block offers when the paper carries no number from the series: the '
      'movement is a transhipment and the leg has not been coded yet.', 44)
on conflict (code) do nothing;

-- ============================================================
-- 5. the file's own guard, rewritten to quote the regime
-- ============================================================

create or replace function public.cargo_procedure_matches_the_file()
returns trigger language plpgsql set search_path = public as $$
declare
  v_type   text;
  v_label  text;
  v_series text;
  v_prefix text;
begin
  -- Absent means "not yet classified", which is the state every file opened before 130 is in.
  -- The rule is about a code that is there, not about one that is missing.
  if new.cpc_code is null then return new; end if;

  select c.shipment_type, c.label, r.series_words into v_type, v_label, v_series
    from customs_procedure_code c
    join customs_regime r on r.shipment_type = c.shipment_type
   where c.code = new.cpc_code;
  if v_type is null then
    -- Reached only when the code is not in the list at all, since the foreign key and the regime
    -- CHECK both answer before a trigger on this file can be blamed for them.
    raise exception 'CPC % is not a procedure the office declares under.', new.cpc_code
      using errcode = '23514';
  end if;

  if v_type <> new.shipment_type then
    -- The digit is read from the file's own regime row, so the sentence a clerk is refused by and the
    -- number stamped on his file have one author. 132's gate proves each of the four movements the
    -- cargo table allows holds a regime, which is what makes this lookup safe to trust.
    select r.file_prefix into v_prefix from customs_regime r
     where r.shipment_type = new.shipment_type;
    raise exception 'CPC % (%) is a procedure for %. The block prints that movement as %. This '
      'file''s movement is % and its number begins %, so the code does not belong on it.',
      new.cpc_code, v_label, v_type, v_series, new.shipment_type, v_prefix
      using errcode = '23514';
  end if;
  return new;
end $$;

-- ============================================================
-- 6. gate
-- ============================================================

do $$
declare
  v_regimes  int;
  v_codes    int;
  v_leaks    int;
  v_tries    int;
  v_before   int;
  v_after    int;
  v_office   uuid;
  v_rec      record;
  v_slipped  boolean;
  v_034      text;
  v_gone     int;
begin
  -- 1. the block has exactly the four movements 034 keeps a file for, read from 034 rather than
  -- restated. A fifth movement added to the cargo file without a regime here would print a block
  -- with no header and no codes.
  select count(*)::int into v_regimes from customs_regime;
  if v_regimes <> 4 then
    raise exception '132: customs_regime holds % row(s), not the four printed regimes', v_regimes;
  end if;
  select pg_get_constraintdef(oid) into v_034 from pg_constraint
   where conrelid = 'cargo_shipments'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%shipment_type%';
  if v_034 is null then
    raise exception '132: 034''s shipment_type CHECK is gone — the cargo file no longer says what a '
      'movement is';
  end if;
  select count(*)::int into v_leaks from customs_regime r
   where v_034 not like '%''' || r.shipment_type || '''%';
  if v_leaks > 0 then
    raise exception '132: % regime(s) name a movement the cargo file will not carry — the two lists '
      'are one list read twice', v_leaks;
  end if;
  select count(*)::int into v_leaks from (values ('export'),('import'),('transhipment'),('transit'))
    t(s) where not exists (select 1 from customs_regime r where r.shipment_type = t.s);
  if v_leaks > 0 then
    raise exception '132: % of the four movements has no regime row, so the classification block has '
      'nothing to print over its codes', v_leaks;
  end if;

  -- 2. the digits are 034's, stated here from its own comment (1=Export, 4=Import, 7=Transhipment,
  -- 8=Transit) so a table that agrees with a wrong seed still fails.
  select count(*)::int into v_leaks from customs_regime r
   where r.file_prefix <> case r.shipment_type
     when 'export' then '1' when 'import' then '4'
     when 'transhipment' then '7' when 'transit' then '8' end;
  if v_leaks > 0 then
    raise exception '132: % regime(s) whose file number does not start on the digit the CFA '
      'convention gives that movement', v_leaks;
  end if;
  -- Every pattern must be anchored at both ends, or a regime would answer for a code that merely
  -- contains its shape. That a pattern compiles at all is proven by section 3, which runs it.
  select count(*)::int into v_leaks from customs_regime r
   where r.code_pattern not like '^%' or r.code_pattern not like '%$'
      or length(r.series_words) < 6 or length(r.note) < 40;
  if v_leaks > 0 then
    raise exception '132: % regime(s) carry an unanchored code pattern or a note too short to be a '
      'sentence the desk can print', v_leaks;
  end if;

  -- 3. the code list: 130's six plus the ten the block prints, and every one of them fits the regime
  -- it is filed under. Asserted here as a query, not assumed from the trigger below, because the six
  -- rows were seeded before that trigger existed.
  select count(*)::int into v_codes from customs_procedure_code;
  if v_codes <> 16 then
    raise exception '132: customs_procedure_code holds % row(s), not 130''s six plus the ten the '
      'block prints', v_codes;
  end if;
  select count(*)::int into v_leaks from customs_procedure_code c
    join customs_regime r on r.shipment_type = c.shipment_type
   where c.code !~ r.code_pattern;
  if v_leaks > 0 then
    raise exception '132: % procedure(s) carry a shape their own regime does not print', v_leaks;
  end if;
  -- A code may fit exactly one regime, or the list would offer the same number under two movements
  -- and the desk's answer would depend on which tab it was read from.
  select count(*)::int into v_leaks from (
    select p.code from customs_procedure_code p
      join customs_regime r on p.code ~ r.code_pattern
     group by p.code having count(*) > 1) x;
  if v_leaks > 0 then
    raise exception '132: % code(s) fit more than one regime, so the movement is not decided by the '
      'code alone', v_leaks;
  end if;
  -- The ten this file exists for, each under the movement the block names it in.
  select count(*)::int into v_leaks from (values
      ('10','export'), ('40','import'), ('42','import'), ('80','transit'), ('T1','transit'),
      ('T2','transit'), ('50','transhipment'), ('60','transhipment'), ('70','transhipment'),
      ('TR','transhipment')) b(code, movement)
   where not exists (select 1 from customs_procedure_code c
                      where c.code = b.code and c.shipment_type = b.movement);
  if v_leaks > 0 then
    raise exception '132: % of the ten codes the block prints are missing or filed under the wrong '
      'movement', v_leaks;
  end if;
  -- 130's six are still reachable: a cargo file points at a code, so withdrawing one would strand
  -- every file that quotes it at the border.
  select count(*)::int into v_leaks from (values
      ('1000','export'), ('4000','import'), ('4200','import'), ('7000','transhipment'),
      ('8000','transit'), ('8200','transit')) k(code, movement)
   where not exists (select 1 from customs_procedure_code c
                      where c.code = k.code and c.shipment_type = k.movement);
  if v_leaks > 0 then
    raise exception '132: % of 130''s six four-digit codes is gone, and every file that quotes it '
      'now points at nothing', v_leaks;
  end if;
  -- Every regime must have codes to declare under, including the letter ones.
  select count(*)::int into v_leaks from customs_regime r
   where (select count(*)::int from customs_procedure_code c
           where c.shipment_type = r.shipment_type) < 2;
  if v_leaks > 0 then
    raise exception '132: % regime(s) offer fewer than two codes, so the desk has one answer and no '
      'choice', v_leaks;
  end if;

  -- 4. the constraints the widening left behind, and the two that had to go. A CHECK can be dropped
  -- by a hand at the database, so each is asserted to exist, or not to, rather than assumed.
  if not exists (select 1 from pg_constraint
                  where conname = 'cpc_code_shape'
                    and pg_get_constraintdef(oid) like '%T[12R]%') then
    raise exception '132: the widened code CHECK is gone — a bare word would become a declarable code';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cpc_code_is_printed') then
    raise exception '132: the printed-form CHECK is gone, so a list row could hide behind a lowercase '
      'code no clerk can pick';
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'cpc_regime' and contype = 'f'
                    and confrelid = 'customs_regime'::regclass) then
    raise exception '132: the procedure list is no longer bound to the regimes, so a movement can be '
      'invented without a block to print it on';
  end if;
  select count(*)::int into v_gone from pg_constraint
   where conrelid = 'customs_procedure_code'::regclass and contype = 'c'
     and (pg_get_constraintdef(oid) like '%''^[0-9]{4}$''::text%'
          or pg_get_constraintdef(oid) like '%CASE shipment_type%');
  if v_gone > 0 then
    raise exception '132: % of 130''s four-digit CHECKs survived the widening, and a T1 still cannot '
      'be filed under it', v_gone;
  end if;

  -- 5. who may reach the doors.
  if not has_function_privilege('app_runtime', 'public.customs_code_fits_its_regime()', 'EXECUTE') then
    raise exception '132: the vocabulary guard cannot run as the app role — it would fire only for '
      'the migrator and never for a desk that writes the list';
  end if;
  if not has_function_privilege('app_runtime', 'public.cargo_procedure_matches_the_file()', 'EXECUTE') then
    raise exception '132: the file guard lost its execute grant, so a clerk''s write is unchecked';
  end if;
  if has_function_privilege('public', 'public.customs_code_fits_its_regime()', 'EXECUTE')
     or has_function_privilege('anon', 'public.customs_code_fits_its_regime()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.customs_code_fits_its_regime()', 'EXECUTE')
     or has_function_privilege('public', 'public.cargo_procedure_matches_the_file()', 'EXECUTE')
     or has_function_privilege('anon', 'public.cargo_procedure_matches_the_file()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.cargo_procedure_matches_the_file()',
                               'EXECUTE') then
    raise exception '132: a guard is callable as a function by a web role — 096''s lesson';
  end if;
  if (select count(*)::int from pg_trigger
       where tgrelid = 'customs_procedure_code'::regclass
         and tgname = 'trg_customs_code_fits_its_regime' and not tgisinternal) <> 1 then
    raise exception '132: the vocabulary guard is not attached to the code list';
  end if;
  if (select count(*)::int from pg_trigger
       where tgrelid = 'cargo_shipments'::regclass
         and tgname = 'trg_cargo_procedure_matches_the_file' and not tgisinternal) <> 1 then
    raise exception '132: the file guard is no longer attached to the cargo file';
  end if;
  if (select count(*)::int from pg_proc where proname = 'cargo_procedure_matches_the_file'
        and pg_get_functiondef(oid) like '%customs_regime%') <> 1 then
    raise exception '132: the file guard no longer reads the regimes, so it cannot quote the block '
      'when it turns a code away';
  end if;
  -- 130 kept the four digits twice: once in the table and once in the guard's own case expression.
  -- The guard is now the table's reader, so a private copy in its body is a drift waiting to happen.
  if (select count(*)::int from pg_proc where proname = 'cargo_procedure_matches_the_file'
        and pg_get_functiondef(oid) like '%CASE%') > 0 then
    raise exception '132: the file guard keeps its own copy of the four digits again — the digit a '
      'clerk is told must be the digit the file number was cut from';
  end if;

  if (select count(*)::int from (values ('customs_regime')) t(tbl)
       where not has_table_privilege('app_runtime', t.tbl, 'SELECT')
          or has_table_privilege('app_runtime', t.tbl, 'INSERT')
          or has_table_privilege('app_runtime', t.tbl, 'UPDATE')
          or has_table_privilege('app_runtime', t.tbl, 'DELETE')
          or not (select relrowsecurity from pg_class where oid = t.tbl::regclass)) > 0 then
    raise exception '132: the regime list is writable by the app role, closed to it, or ships with '
      'RLS off — statutory words are not a tenant''s to edit';
  end if;

  -- 6. the guards, run live. plpgsql parses each statement the first time it reaches it, so the
  -- patterns, the FK and both triggers are all proven here rather than assumed from the text above.
  select count(*)::int into v_before from cargo_shipments;
  select t.id into v_office from tenants t
   where coalesce(t.type, '') not in ('platform', 'seeker') and t.deleted_at is null
   order by t.created_at limit 1;

  -- 6a. the list's own guard. 45 fits the widened shape CHECK and is not in the list, so the only
  -- thing that can refuse it here is the regime's pattern — which is what this probe is for.
  v_slipped := false;
  begin
    insert into customs_procedure_code (code, shipment_type, label, sort)
      values ('45', 'transit', 'A code in the wrong regime', 900);
    v_slipped := true;
    raise exception 'rollback the probe' using errcode = 'P0001';
  exception
    when raise_exception then
      if v_slipped then
        raise exception '132: the code list accepted 45 as a transit procedure — the regime pattern '
          'is decorative';
      end if;
      if sqlerrm not like '132:%' then
        raise exception '132: the vocabulary probe raised inside itself — %', sqlerrm;
      end if;
    when check_violation then
      if sqlerrm not like 'CPC 45 cannot be a transit procedure%The block prints Transit under%' then
        raise exception '132: the list refused 45 as transit without naming the regime it belongs to '
          '— %', sqlerrm;
      end if;
  end;
  if (select count(*)::int from customs_procedure_code where code = '45') <> 0 then
    raise exception '132: the vocabulary probe left its row behind';
  end if;

  if v_office is null then
    raise notice '132: no live office tenant exists, so the file''s guards were checked by their '
      'definitions only';
  else
    -- 6b. every shape the block prints must be acceptable on a file of its own regime: a numbered
    -- import code, a letter transit indicator, the transhipment general indicator, a member of the
    -- 50 to 70 series. Each is written and rolled back in its own block, so one caught error cannot
    -- poison the next probe — and the count below proves the loop ran rather than skipped.
    v_tries := 0;
    for v_rec in
      select g.movement, g.code, g.n from (values
          ('import', '40', 1), ('import', '42', 2), ('transit', 'T1', 3), ('transit', '80', 4),
          ('transit', 'T2', 5), ('transhipment', 'TR', 6), ('transhipment', '60', 7),
          ('export', '10', 8)) g(movement, code, n)
    loop
      v_tries := v_tries + 1;
      v_slipped := false;
      begin
        insert into cargo_shipments (tenant_id, file_number, seq, file_year, shipment_type,
            container_type, consignee_name, consignor_name, cpc_code)
        values (v_office, '132GATE-' || v_rec.code || '-2126', 1900 + v_rec.n, 2126,
            v_rec.movement, '20ft', 'the gate', 'the gate', v_rec.code);
        v_slipped := true;
        raise exception 'rollback the probe' using errcode = 'P0001';
      exception
        when raise_exception then
          if not v_slipped then
            raise exception '132: the CPC % probe raised inside itself — %', v_rec.code, sqlerrm;
          end if;
        when check_violation then
          raise exception '132: a % file declaring under CPC % was refused — %',
            v_rec.movement, v_rec.code, sqlerrm;
        when foreign_key_violation then
          raise exception '132: the cargo file cannot point at CPC %, which this file just seeded — %',
            v_rec.code, sqlerrm;
      end;
    end loop;
    if v_tries <> 8 then
      raise exception '132: only % of the eight good pairings were run, so the block''s shapes are '
        'unproven', v_tries;
    end if;
    if (select count(*)::int from cargo_shipments
         where tenant_id = v_office and file_number like '132GATE-%-2126') <> 0 then
      raise exception '132: the good-pairing probes left rows behind';
    end if;

    -- 6c. a code from another regime must be turned away in the block's own words, whether the code
    -- is a number or an indicator, and whether the file it was aimed at starts on the same digit.
    v_tries := 0;
    for v_rec in
      select g.movement, g.code, g.digits, g.n from (values
          ('export', '40', 'begins 1', 1), ('transhipment', 'T1', 'begins 7', 2),
          ('transit', '50', 'begins 8', 3), ('import', 'TR', 'begins 4', 4))
        g(movement, code, digits, n)
    loop
      v_tries := v_tries + 1;
      v_slipped := false;
      begin
        insert into cargo_shipments (tenant_id, file_number, seq, file_year, shipment_type,
            container_type, consignee_name, consignor_name, cpc_code)
        values (v_office, '132BAD-' || v_rec.code || '-2126', 1950 + v_rec.n, 2126,
            v_rec.movement, '20ft', 'the gate', 'the gate', v_rec.code);
        v_slipped := true;
        raise exception 'rollback the probe' using errcode = 'P0001';
      exception
        when raise_exception then
          if v_slipped then
            raise exception '132: the guard accepted CPC % on a % file', v_rec.code, v_rec.movement;
          end if;
          if sqlerrm not like '132:%' then
            raise exception '132: the mismatch probe for % raised inside itself — %',
              v_rec.code, sqlerrm;
          end if;
        when check_violation then
          if sqlerrm not like 'CPC ' || v_rec.code || ' (%) is a procedure for%'
             or sqlerrm not like '%. This file''s movement is ' || v_rec.movement ||
                ' and its number ' || v_rec.digits || ', so the code does not belong on it.%' then
            raise exception '132: the guard turned CPC % off a % file without naming the code it is, '
              'the movement it belongs to and the digit this file starts on — %',
              v_rec.code, v_rec.movement, sqlerrm;
          end if;
      end;
    end loop;
    if v_tries <> 4 then
      raise exception '132: only % of the four refusals were run', v_tries;
    end if;
    if (select count(*)::int from cargo_shipments
         where tenant_id = v_office and file_number like '132BAD-%-2126') <> 0 then
      raise exception '132: the mismatch probes left rows behind';
    end if;
  end if;

  -- 7. nothing above was kept.
  select count(*)::int into v_after from cargo_shipments;
  if v_after <> v_before then
    raise exception '132: the gate left % cargo row(s) behind', v_after - v_before;
  end if;
  select count(*)::int into v_after from customs_procedure_code;
  if v_after <> v_codes then
    raise exception '132: the gate left % code row(s) behind', v_after - v_codes;
  end if;

  raise notice '132: the regime and its codes are live — % regime(s) printing the series they declare '
    'under, % procedure(s) of which % now carry a letter indicator, and a cargo file that cannot '
    'carry a code from another regime whatever shape it is in', v_regimes, v_codes,
    (select count(*)::int from customs_procedure_code where code !~ '^[0-9]+$');
end $$;

commit;
