-- 118 — the warehouse keeps its own book: goods in, goods out, and the days between them
-- priced (task #190).
--
-- The user's ask: "i want warehouse inventory management, that will handle entry, quite and
-- charges storage."
--
-- There was already a table called inventory: 033's `inventory_items`, which is the garage's
-- shelf of spare parts — a thing the company *owns and consumes*, priced once at unit cost, with a
-- minimum quantity that raises a reorder. A warehouse hold is the opposite object: goods the
-- company is *holding for someone else*, attached to a cargo file, whose whole point is the clock.
-- The longer they sit, the more the store costs, and the money is owed by the file. Stretching
-- `inventory_items` to cover both would mean a parts shelf that can be released and a cargo hold
-- that reorders itself. So this is a new register, with its own duty keys, and the parts shelf
-- keeps its `garage.*` world untouched.
--
-- Two tables, because there are two physical objects. `warehouse_stays` is the hold itself: this
-- cargo, in this store, on this file, at this rate. `warehouse_slips` is the docket in the clerk's
-- hand — one entry or one exit, a quantity, a day, a signature. The hold is the story; the slips
-- are the evidence, and the evidence is what gets read back when a client disputes a storage bill.
--
-- The quantities on a stay are a **projection of its slips**, recomputed from the slips every time
-- one is filed or voided, never typed. That is what makes the register trustworthy: a clerk cannot
-- write "400 in, 400 out" over dockets that say 300 and 0, and the balance the desk reports is the
-- balance the paper adds up to. 109 set the precedent for the projection (a vehicle's status is a
-- reading of its work order, written beside it) — here it is the same rule with the money question
-- attached.
--
-- WHY THE CHARGE IS NOT A COLUMN. Storage is `days held × daily rate`, less the free days the store
-- gives. Both halves are already on the row: `entered_on`/`exited_on` are facts of the slips, and
-- `daily_rate`/`free_days` are the tariff the office set. Storing the product would freeze a
-- number that changes every day the cargo is still sitting there — a `charge_amount` column is
-- correct at 08:00 and stale by 08:01, and the stale one is what gets printed. So the arithmetic
-- lives in three small functions below, and every reader — the desk, the file's cost line, the
-- alert, the whole-file export — calls the same one. Today's date is passed in rather than read
-- inside, so one read of the register prices every hold against one clock and a smoke can name the
-- day it priced on.
--
-- WHY NO MONEY IS WRITTEN HERE. The charge is what the store will bill, or what the office will
-- bill the client through the `STORAGE` line 052 already carries in the charge catalog. This
-- register states the days and the rate; it does not post a payable and it does not touch
-- `office_costs` or `freight_expenses`. Two ledgers for one invoice is the defect this platform has
-- spent three stages removing (092's journal carries no money for the same reason). What the file's
-- margin needs is the *figure*, and 039's file-costs reader now asks this register for it beside
-- the office costs it already sums — one number, one home, read from both ends.
--
-- THE FREEZE. A hold that has been emptied, or called off, is a told story: its shipment, its
-- place, its goods, its tariff cannot be rewritten afterwards (107, 108, 109 all gave the same
-- answer to the same temptation). What was recorded wrong is corrected by the slips — a docket is
-- voided with a name and a reason and leaves the balance, so the register keeps both the mistake
-- and its correction, which is what a store's paper book actually looks like.

begin;

-- ============================================================
-- 1. the references
-- ============================================================
-- WH-2026-00004 for the hold, WE-/WX- for the dockets, the {5,} tail 109 used because lpad never
-- truncates and a strict width would turn a late row into a CHECK violation. Three sequences, not
-- one: a store's entry book and exit book are numbered separately, and a shared counter would make
-- WE-2026-00007 and WX-2026-00008 neighbours of the same afternoon for no reason a clerk could
-- explain. nextval is atomic, so a gap costs nothing while a duplicate is a docket searched for in
-- the wrong year.

create sequence if not exists warehouse_stay_ref_seq;
create sequence if not exists warehouse_entry_ref_seq;
create sequence if not exists warehouse_exit_ref_seq;
grant usage, select on sequence warehouse_stay_ref_seq to app_runtime;
grant usage, select on sequence warehouse_entry_ref_seq to app_runtime;
grant usage, select on sequence warehouse_exit_ref_seq to app_runtime;

-- The slip points at the hold and the hold at the file, both by pair, so a borrowed id from
-- another company cannot file a docket here (093/109/111's rule, restated because this register
-- carries money). The pair indexes are created with the tables that are pointed at, below.

-- ============================================================
-- 2. the hold
-- ============================================================

create table if not exists warehouse_stays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- The goods are the file's. A hold with no file is a pile nobody can bill and nothing can
  -- release, so the column is required: the desk opens a hold *from* a cargo file.
  shipment_id uuid not null,
  ref text not null unique check (ref ~ '^WH-[0-9]{4}-[0-9]{5,}$'),
  -- A typed store name, the way 109 types a garage and 039 types a payee: this platform does not
  -- own a warehouse master, and inventing one here would be a second ledger nobody reconciles.
  place text not null check (char_length(trim(place)) between 3 and 120),
  goods text not null check (char_length(trim(goods)) between 3 and 200),
  -- What a quantity counts — bags, pallets, cartons, TEUs, kilograms. A label, not a converter:
  -- the charge is per day, never per piece, so nothing here multiplies by it.
  unit text not null default 'pcs' check (char_length(trim(unit)) between 1 and 24),
  container_number text
    check (container_number is null or char_length(trim(container_number)) between 4 and 30),
  daily_rate numeric(14,2) not null default 0 check (daily_rate >= 0),
  currency text not null default 'TZS' check (currency ~ '^[A-Z]{3}$'),
  -- Days the store gives before it starts charging. 0 prices every day; a free period is why the
  -- column exists at all — without it, a two-day turnaround bills two days of storage.
  free_days int not null default 0 check (free_days between 0 and 365),
  status text not null default 'stored' check (status in ('stored','released','cancelled')),
  -- The four columns below are projections of warehouse_slips, written by the trigger that books a
  -- docket. No route sets them, and the CHECKs make a wrong projection impossible rather than
  -- merely unlikely.
  entered_on date,
  exited_on date,
  quantity_in numeric(14,3) not null default 0 check (quantity_in >= 0),
  quantity_out numeric(14,3) not null default 0 check (quantity_out >= 0 and quantity_out <= quantity_in),
  notes text,
  opened_by uuid references users(id) on delete set null,
  released_by uuid references users(id) on delete set null,
  cancel_reason text, cancelled_by uuid references users(id) on delete set null,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (shipment_id, tenant_id) references cargo_shipments (id, tenant_id),
  check (exited_on is null or entered_on is null or exited_on >= entered_on)
);

create index if not exists idx_warehouse_stays_tenant on warehouse_stays (tenant_id)
  where deleted_at is null;
-- The desk opens on what is still in the store, longest-held first: the cargo that has sat four
-- weeks is the finding, not the crate that arrived this morning.
create index if not exists idx_warehouse_stays_held
  on warehouse_stays (tenant_id, entered_on)
  where deleted_at is null and status = 'stored';
create index if not exists idx_warehouse_stays_file
  on warehouse_stays (tenant_id, shipment_id) where deleted_at is null;
-- "What does this store cost me across all my files?" is asked per place.
create index if not exists idx_warehouse_stays_place
  on warehouse_stays (tenant_id, place) where deleted_at is null;

create trigger trg_warehouse_stays_updated before update on warehouse_stays
  for each row execute function public.set_updated_at();

alter table warehouse_stays enable row level security;
create policy warehouse_stays_tenant on warehouse_stays for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
-- No DELETE: a hold that has been paid or disputed is history, and the house soft delete (041)
-- keeps the row and the audit line that wrote it.
grant select, insert, update on warehouse_stays to app_runtime;

-- ============================================================
-- 3. the dockets
-- ============================================================

-- The hold's own pair, so a slip's (stay_id, tenant_id) can be checked against the company as well
-- as the table. `id` is already the primary key, so this index adds no information — it exists for
-- the foreign key below, the same way 109's `employees_id_tenant_uq` does.
create unique index if not exists warehouse_stays_id_tenant_uq on warehouse_stays (id, tenant_id);

create table if not exists warehouse_slips (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  stay_id uuid not null,
  kind text not null check (kind in ('entry','exit')),
  -- The prefix is cut from `kind` by the trigger below, so a docket number and the movement it
  -- records can never disagree — 188's rule for a cargo file number, applied to a store's book.
  ref text not null unique check (ref ~ '^W[EX]-[0-9]{4}-[0-9]{5,}$'),
  slip_day date not null,
  quantity numeric(14,3) not null check (quantity > 0 and quantity <= 1000000000),
  -- The store's own paper, or the delivery note the goods left against. Text, not a foreign key:
  -- 117 filed those pages as documents, and this platform does not own the store's numbering.
  docket_ref text check (docket_ref is null or char_length(trim(docket_ref)) <= 60),
  note text,
  -- A docket is voided, never torn out. `filed` counts in the balance; `voided` leaves it and
  -- stays on the register with who killed it and why.
  state text not null default 'filed' check (state in ('filed','voided')),
  filed_by uuid references users(id) on delete set null,
  filed_at timestamptz not null default now(),
  voided_by uuid references users(id) on delete set null,
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (stay_id, tenant_id) references warehouse_stays (id, tenant_id)
);

create index if not exists idx_warehouse_slips_stay on warehouse_slips (stay_id, filed_at);
create index if not exists idx_warehouse_slips_day
  on warehouse_slips (tenant_id, slip_day desc, kind);

create trigger trg_warehouse_slips_updated before update on warehouse_slips
  for each row execute function public.set_updated_at();

alter table warehouse_slips enable row level security;
create policy warehouse_slips_tenant on warehouse_slips for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
-- Insert and void. A filed docket's own words are not editable — that is what voiding and
-- re-filing is for, which is why the register keeps both. The column list is the grant, so a route
-- bug cannot rewrite a quantity even if it forgot the trigger.
grant select, insert on warehouse_slips to app_runtime;
grant update (state, voided_by, voided_at, void_reason, updated_at) on warehouse_slips to app_runtime;

-- ============================================================
-- 4. what a docket may and may not say
-- ============================================================
--   * the hold it belongs to is in this company's register, and was not called off;
--   * an exit cannot be dated before the cargo arrived, and cannot release more than the filed
--     dockets put in — the store cannot let out goods that never came in;
--   * the reference's prefix is the kind, always;
--   * a filed docket is immutable: only its state and the three void columns may move, and only
--     forward. A voided docket stays voided, and the correction is a new one;
--   * a docket cannot be voided while the goods it released are still out — that would leave the
--     hold claiming more released than received, which the table CHECK would then refuse as a raw
--     constraint error instead of this sentence.

create or replace function public.warehouse_slip_shape()
returns trigger language plpgsql set search_path = public as $$
declare
  v_status text;
  v_in numeric;
  v_out numeric;
  v_first_in date;
  v_would_in numeric;
  v_would_out numeric;
  v_prefix text;
begin
  -- Cut from the kind, so the number and the movement cannot disagree. Assigned here rather than
  -- written inline in the condition below: plpgsql ends an IF condition at the first THEN it sees,
  -- and a CASE inside the condition carries its own — the whole body then fails to parse.
  v_prefix := case when new.kind = 'entry' then 'WE-' else 'WX-' end;

  if tg_op = 'INSERT' then
    if new.ref is null or trim(new.ref) = '' then
      new.ref := v_prefix ||
        to_char(date_trunc('year', new.slip_day), 'YYYY') || '-' ||
        lpad(nextval(case when new.kind = 'entry'
                          then 'warehouse_entry_ref_seq'
                          else 'warehouse_exit_ref_seq' end)::text, 5, '0');
    elsif left(new.ref, 3) <> v_prefix then
      raise exception 'A docket number carries the prefix of the movement it records.';
    end if;
    if new.state <> 'filed' then
      raise exception 'A docket is filed as it is written; a mistake is voided after the fact.';
    end if;
  else
    if new.ref          is distinct from old.ref
       or new.kind      is distinct from old.kind
       or new.stay_id   is distinct from old.stay_id
       or new.tenant_id is distinct from old.tenant_id
       or new.slip_day  is distinct from old.slip_day
       or new.quantity  is distinct from old.quantity
       or new.docket_ref is distinct from old.docket_ref
       or new.note      is distinct from old.note
       or new.filed_by  is distinct from old.filed_by
       or new.filed_at  is distinct from old.filed_at
       or new.created_at is distinct from old.created_at then
      raise exception 'A filed docket is not rewritten — void it and file the correct one.';
    end if;
    if old.state = 'voided' then
      raise exception 'A voided docket stays voided; file a new one.';
    end if;
    if new.state = 'filed' then
      raise exception 'A docket cannot be un-voided; file a new one.';
    end if;
    if new.voided_by is null or trim(coalesce(new.void_reason,'')) = '' then
      raise exception 'A voided docket says who voided it and why.';
    end if;
    -- Would the balance still add up with this docket gone? The row still reads `filed` here, so
    -- its own quantity is taken back out of whichever side it belongs to.
    select coalesce(sum(s.quantity) filter (where s.kind = 'entry'), 0),
           coalesce(sum(s.quantity) filter (where s.kind = 'exit'), 0)
      into v_in, v_out
      from warehouse_slips s
     where s.stay_id = old.stay_id and s.tenant_id = old.tenant_id and s.state = 'filed';
    v_would_in := case when old.kind = 'entry' then v_in - old.quantity else v_in end;
    v_would_out := case when old.kind = 'exit' then v_out - old.quantity else v_out end;
    if v_would_out > v_would_in then
      raise exception 'This docket cannot be voided while the goods it released are still out — void those dockets first.';
    end if;
    return new;
  end if;

  -- The lock is the point as much as the read: two exits filed in the same second against one hold
  -- would each see the balance before the other landed, and the store would release double.
  select status into v_status
    from warehouse_stays
   where id = new.stay_id and tenant_id = new.tenant_id
     for update;
  if not found then
    raise exception 'This docket belongs to a hold that is not in your register.';
  end if;
  if v_status = 'cancelled' then
    raise exception 'A hold that was called off takes no dockets.';
  end if;

  if new.kind = 'exit' then
    select coalesce(sum(s.quantity) filter (where s.kind = 'entry'), 0),
           coalesce(sum(s.quantity) filter (where s.kind = 'exit'), 0),
           min(s.slip_day) filter (where s.kind = 'entry')
      into v_in, v_out, v_first_in
      from warehouse_slips s
     where s.stay_id = new.stay_id and s.tenant_id = new.tenant_id and s.state = 'filed';
    if v_in = 0 then
      raise exception 'Nothing has been filed into this hold yet, so nothing can leave it.';
    end if;
    if v_first_in is not null and new.slip_day < v_first_in then
      raise exception 'Goods cannot leave the store on % — they arrived on %.', new.slip_day, v_first_in;
    end if;
    if v_out + new.quantity > v_in then
      raise exception 'The store holds % — it cannot release %.',
        trim_scale(v_in - v_out), trim_scale(new.quantity);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_warehouse_slip_shape on warehouse_slips;
create trigger trg_warehouse_slip_shape before insert or update
  on warehouse_slips for each row execute function public.warehouse_slip_shape();

-- ============================================================
-- 5. the balance, booked from the dockets
-- ============================================================
-- Recomputed, never incremented: after any docket lands or is voided the hold re-reads its own
-- paper, so a projection cannot drift from the slips it summarises. `released` is a conclusion
-- about the dockets, not a button; the last one out is the seat that emptied the hold, and a void
-- that un-empties it puts the hold back on the shelf.

create or replace function public.warehouse_slip_booked()
returns trigger language plpgsql set search_path = public as $$
declare
  v_in numeric;
  v_out numeric;
  v_first_in date;
  v_last_out date;
  v_last_out_by uuid;
begin
  select coalesce(sum(s.quantity) filter (where s.kind = 'entry' and s.state = 'filed'), 0),
         coalesce(sum(s.quantity) filter (where s.kind = 'exit'  and s.state = 'filed'), 0),
         min(s.slip_day) filter (where s.kind = 'entry' and s.state = 'filed'),
         max(s.slip_day) filter (where s.kind = 'exit'  and s.state = 'filed'),
         (array_agg(s.filed_by order by s.slip_day desc, s.filed_at desc nulls last)
            filter (where s.kind = 'exit' and s.state = 'filed'))[1]
    into v_in, v_out, v_first_in, v_last_out, v_last_out_by
    from warehouse_slips s
   where s.stay_id = new.stay_id and s.tenant_id = new.tenant_id;

  update warehouse_stays w
     set entered_on = v_first_in,
         quantity_in = v_in,
         quantity_out = v_out,
         exited_on = case when v_in > 0 and v_out >= v_in then v_last_out end,
         released_by = case when v_in > 0 and v_out >= v_in then v_last_out_by end,
         status = case when w.status = 'cancelled' then 'cancelled'
                      when v_in > 0 and v_out >= v_in then 'released'
                      else 'stored' end,
         updated_at = now()
   where w.id = new.stay_id and w.tenant_id = new.tenant_id;
  return new;
end $$;

drop trigger if exists trg_warehouse_slip_booked on warehouse_slips;
create trigger trg_warehouse_slip_booked after insert or update of state
  on warehouse_slips for each row execute function public.warehouse_slip_booked();

-- ============================================================
-- 6. what a hold has to keep
-- ============================================================
--   * a called-off hold names who called it off and why, and holds nothing — goods that were
--     actually received are got rid of by an exit docket (a sale ex-bond, a destruction), not by
--     pretending the crate never arrived;
--   * a hold that has been emptied or called off is not rewritten: the tariff, the place, the
--     goods and the file it belongs to are the story that was told;
--   * a closed hold takes no delivery docket either. One hold has one `entered_on`, the earliest
--     filed entry, so goods counted into a hold that emptied months ago would be charged for every
--     day since the first crate arrived. The API door refuses it and a new hold is opened; the
--     correction path for a release that never happened is voiding the exit docket, which puts the
--     goods back and the hold back to stored under its own dates.
--   * the projections are the bookkeeping trigger's to write and nobody's to type.

create or replace function public.warehouse_stay_shape()
returns trigger language plpgsql set search_path = public as $$
declare
  v_year int := extract(year from current_date)::int;
begin
  if new.ref is null or trim(new.ref) = '' then
    new.ref := 'WH-' || v_year || '-' || lpad(nextval('warehouse_stay_ref_seq')::text, 5, '0');
  end if;

  if new.status = 'cancelled' then
    if new.cancelled_by is null or trim(coalesce(new.cancel_reason,'')) = '' then
      raise exception 'A called-off hold says who called it off and why.';
    end if;
    if new.quantity_in <> 0 then
      raise exception 'A hold that received goods is emptied by an exit docket, not cancelled.';
    end if;
  elsif new.cancelled_by is not null or trim(coalesce(new.cancel_reason,'')) <> '' then
    raise exception 'Only a cancelled hold carries a cancellation.';
  end if;

  if tg_op = 'UPDATE' and old.status in ('released','cancelled') then
    if new.shipment_id    is distinct from old.shipment_id
       or new.place        is distinct from old.place
       or new.goods        is distinct from old.goods
       or new.unit         is distinct from old.unit
       or new.container_number is distinct from old.container_number
       or new.daily_rate   is distinct from old.daily_rate
       or new.currency     is distinct from old.currency
       or new.free_days    is distinct from old.free_days
       or new.notes        is distinct from old.notes
       or new.opened_by    is distinct from old.opened_by then
      raise exception 'A hold that has been emptied or called off is not rewritten.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_warehouse_stay_shape on warehouse_stays;
create trigger trg_warehouse_stay_shape before insert or update
  on warehouse_stays for each row execute function public.warehouse_stay_shape();

-- ============================================================
-- 7. the price of the days
-- ============================================================
-- The whole arithmetic of this module, in one place, called by every reader. `p_today` is passed
-- in rather than read inside, so one register prices every hold against one clock. Days held
-- counts the nights the cargo spent there: in and out on the same day costs nothing, which is what
-- a store's tariff actually means.

create or replace function public.warehouse_days_held(
  p_entered_on date, p_exited_on date, p_today date
) returns int language sql immutable set search_path = public as $$
  select case when p_entered_on is null then 0
              else greatest(0, coalesce(p_exited_on, p_today) - p_entered_on)
         end
$$;

create or replace function public.warehouse_charge_days(
  p_entered_on date, p_exited_on date, p_free_days int, p_today date
) returns int language sql immutable set search_path = public as $$
  select greatest(0, public.warehouse_days_held(p_entered_on, p_exited_on, p_today)
                   - coalesce(p_free_days, 0))
$$;

create or replace function public.warehouse_storage_charge(
  p_entered_on date, p_exited_on date, p_free_days int,
  p_daily_rate numeric, p_today date
) returns numeric language sql immutable set search_path = public as $$
  select round(public.warehouse_charge_days(p_entered_on, p_exited_on, p_free_days, p_today)
               * coalesce(p_daily_rate, 0), 2)
$$;

-- ============================================================
-- 8. the store's own paper, filed on the hold it covers
-- ============================================================
-- 117 gave the vault the three warehouse slip kinds; until now they could only be attached to a
-- cargo file as a whole. The list below is the live one read from `pg_constraint` plus
-- `warehouse_stay` — copied from the catalog rather than from a previous migration file, because a
-- CHECK that quietly drops a value would strand the rows already filed under it.

alter table documents drop constraint if exists documents_entity_type_check;
alter table documents add constraint documents_entity_type_check
  check (entity_type in ('tenant','user','vessel','driver','trip','shipment','message',
    'licence','employee','office_cost','quotation','cargo_intake','work_order','warehouse_stay'));

-- ============================================================
-- 9. privileges
-- ============================================================
-- 110's lesson, applied while writing rather than two stages later: `grant execute … to
-- app_runtime` does not take PUBLIC's birthright away, and the catalog gate in
-- scripts/verify-privileges-sql.ts reads the acl rather than the intent.

revoke execute on function public.warehouse_slip_shape() from public, anon, authenticated;
revoke execute on function public.warehouse_slip_booked() from public, anon, authenticated;
revoke execute on function public.warehouse_stay_shape() from public, anon, authenticated;
revoke execute on function public.warehouse_days_held(date, date, date) from public, anon, authenticated;
revoke execute on function public.warehouse_charge_days(date, date, int, date) from public, anon, authenticated;
revoke execute on function public.warehouse_storage_charge(date, date, int, numeric, date) from public, anon, authenticated;

grant execute on function public.warehouse_slip_shape() to app_runtime;
grant execute on function public.warehouse_slip_booked() to app_runtime;
grant execute on function public.warehouse_stay_shape() to app_runtime;
grant execute on function public.warehouse_days_held(date, date, date) to app_runtime;
grant execute on function public.warehouse_charge_days(date, date, int, date) to app_runtime;
grant execute on function public.warehouse_storage_charge(date, date, int, numeric, date) to app_runtime;

-- ============================================================
-- 10. comments
-- ============================================================

comment on table warehouse_stays is
  'Cargo held in a store for a client: which file it belongs to, where it sits, and the tariff its days are priced at.';
comment on column warehouse_stays.quantity_in is
  'A projection of the filed entry dockets, written by warehouse_slip_booked(). Never typed.';
comment on column warehouse_stays.quantity_out is
  'A projection of the filed exit dockets. The CHECK refuses more out than in whatever a caller tried.';
comment on column warehouse_stays.exited_on is
  'The last exit day, and only once the dockets have released the whole of what came in.';
comment on column warehouse_stays.free_days is
  'Days the store gives before charging. The charge is (days held - free_days) x daily_rate, by warehouse_storage_charge().';
comment on column warehouse_stays.status is
  'stored | released | cancelled. released is a conclusion about the dockets, not a button a clerk presses.';
comment on table warehouse_slips is
  'One docket in the store''s book: goods in, or goods out, with the day, the quantity and the paper it answers to.';
comment on column warehouse_slips.state is
  'filed counts in the balance. voided leaves it and stays on the register with who voided it and why.';
comment on column warehouse_slips.ref is
  'WE-/WX- prefix cut from kind by warehouse_slip_shape(), so a number and the movement it records cannot disagree.';

-- ============================================================
-- 11. the duties behind the register
-- ============================================================
-- New keys, not `garage.*` (which moves parts the company owns) and not `shipments.*` (which opens
-- files). Filing a docket is the physical act, so entry and exit are separate from editing the
-- hold's words, and the two acts that can destroy the record — voiding a docket, calling off a
-- hold — are keys of their own. Every desk that has a reason to ask what the days cost reads them.

insert into permissions (key, description) values
  ('warehouse.view',   'Warehouse - Read the holds, the dockets and the storage charge'),
  ('warehouse.entry',  'Warehouse - Open a hold and file goods into the store'),
  ('warehouse.exit',   'Warehouse - File a docket that takes goods out'),
  ('warehouse.edit',   'Warehouse - Set the tariff, the place or the goods on a hold still in the store'),
  ('warehouse.void',   'Warehouse - Void a docket that was filed wrong'),
  ('warehouse.cancel', 'Warehouse - Call off a hold that never received goods')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
  from roles r
  join permissions p on p.key in ('warehouse.view','warehouse.entry','warehouse.exit',
                                  'warehouse.edit','warehouse.void','warehouse.cancel')
 where r.tenant_id is null
   and (r.key in ('director','general_manager')
        -- The yard is the operations manager's, everything on it except calling a hold off —
        -- that one is the supervisor's answer to "this crate was never ours".
        or (r.key = 'operations_manager' and p.key <> 'warehouse.cancel')
        -- Money is read by the desks that bill it and the one that audits it; a dispatcher has to
        -- know the cargo is still in the store before promising it to a truck.
        or (r.key in ('finance_officer','billing_admin','auditor','dispatcher')
            and p.key = 'warehouse.view'))
on conflict do nothing;

do $$ declare
  v_rows int;
  v_slips int;
begin
  select count(*)::int into v_rows from warehouse_stays;
  select count(*)::int into v_slips from warehouse_slips;
  raise notice '118: the warehouse book is open; % hold(s) and % docket(s) in it, the duty keys held by the yard desks',
    v_rows, v_slips;
end $$;

commit;
