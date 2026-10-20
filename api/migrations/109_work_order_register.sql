-- 109: a workshop visit is a work order, with a bill and a named mechanic on it (task #185).
--
-- The user's ask: "vehicle service/repair work orders with garage or in-house and mechanic".
--
-- The fleet could already say a truck was `in_garage` — a scalar on `vessels.status` written by
-- `PUT /vessels/:id/status` — and 092 gave every plate a journal. Neither answer the questions a
-- workshop actually has to answer. "In garage" does not say *which* garage, who is holding the
-- spanner, what the job is, what it cost, or when the truck comes back; and the journal
-- deliberately holds no money, because a per-plate diary that also carries shillings would be a
-- second place to look for one number (092's header names this register as the one that owns
-- it). So a workshop visit becomes a row with a state, a place, a person and three figures, and
-- the vehicle's status stays what it always was: a projection of the work order, written beside
-- it and audited with it, never the other way round.
--
-- Why `place` is a pair rather than "is there a garage?" — an in-house job has a mechanic and no
-- supplier, an outside job has a garage and maybe a driver walking it in. One column, two CHECKs
-- and one trigger say which half is mandatory, so the register cannot hold a bill addressed to
-- nobody. There is no garage/vendor table anywhere in the schema (033 put spare parts in
-- `inventory_items` and 031 put supplier bills in `freight_expenses.supplier_name`, free text),
-- so the garage is typed the way a payee is typed in the office costs desk: a name the office
-- chose, not a row another module owns. Inventing a supplier master here would be a second
-- ledger nobody reconciles.
--
-- The mechanic *is* a row: `employees` already carries job_title, department and status, and a
-- workshop is a department like any other. The composite key added below makes the pointer mean
-- "one of this company's staff", which a plain foreign key cannot say — 093 built the same pair
-- for the fleet registers for the same reason, and a borrowed mechanic id would otherwise file a
-- bill against another company's employee.
--
-- Money is three columns rather than one because the garage quotes that way (parts, labour,
-- "other": towing, a hire truck, a call-out) and the fleet manager's question is which of the
-- three is running away. `freight_expenses` stays the payables ledger: a work order is the job,
-- not the payment, and nothing here writes a payment. A seat that pays the garage bills the
-- ledger, exactly as it does for fuel.
--
-- The odometer is the honest end of the visit. `odometer_in_km` is what the truck rolled in with
-- and `odometer_out_km` what it rolled out with, and a `returned` row must carry the second —
-- that number is what a fuel conversation, an assignment handover (092) and a service interval
-- all start from. The route that closes an order pushes it into `vessels.odometer_km` with the
-- same guarded `and odometer_km < $n` bump the logbook uses, so a late-typed old reading can
-- never walk the truck backwards.

begin;

-- ============================================================
-- 1. the reference
-- ============================================================
-- WO-2026-00012, quoted on the phone to the garage, written on the job card, typed into search.
-- A global sequence like the incidence number in 101: nextval is atomic, and a gap in one
-- company's register costs nothing while a duplicate number between two of them is a wrong truck
-- being looked for in the wrong town. The tail is {5,} because lpad never truncates — a strict
-- {5} would turn the hundred-thousandth order into a CHECK violation and stop the register.

create sequence if not exists work_order_number_seq;
grant usage, select on sequence work_order_number_seq to app_runtime;

-- The mechanic pointer needs a pair to point at. `id` is already the primary key, so this index
-- adds no information to `employees` — it exists so a child row can be checked against the
-- company as well as the table.
create unique index if not exists employees_id_tenant_uq on employees (id, tenant_id);

-- ============================================================
-- 2. the work order
-- ============================================================

create table if not exists work_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  vessel_id uuid not null,
  ref text not null unique check (ref ~ '^WO-[0-9]{4}-[0-9]{5,}$'),
  -- The day the clerk wrote the card, stated by the caller rather than defaulted by the server:
  -- a workshop diary that records the day the database clock happened to be on would mis-date
  -- a job typed in the morning about a truck that broke down on Friday.
  raised_on date not null,
  title text not null check (char_length(trim(title)) between 3 and 140),
  detail text,
  -- The job's own kind, kept separate from `vessel_log_entries.kind` on purpose: that journal
  -- says something happened to the plate, this says what the workshop was asked to do, and a
  -- breakdown (033's incident) that turns into a repair is two rows that agree with each other.
  kind text not null default 'service' check (kind in (
    'service','repair','tyre','electrical','bodywork','inspection','accident','other')),
  place text not null check (place in ('in_house','outside_garage')),
  garage_name text,
  garage_reference text,
  mechanic_employee_id uuid,
  status text not null default 'raised' check (status in (
    'raised','in_workshop','awaiting_parts','returned','cancelled')),
  odometer_in_km int check (odometer_in_km is null or odometer_in_km >= 0),
  odometer_out_km int check (odometer_out_km is null or odometer_out_km >= 0),
  parts_cost numeric(14,2) not null default 0 check (parts_cost >= 0),
  labour_cost numeric(14,2) not null default 0 check (labour_cost >= 0),
  other_cost numeric(14,2) not null default 0 check (other_cost >= 0),
  currency text not null default 'TZS' check (currency ~ '^[A-Z]{3}$'),
  -- The garage's own bill number, when there is one. A text column, not a foreign key: this
  -- platform does not own the supplier's ledger.
  invoice_ref text,
  opened_at timestamptz, opened_by uuid references users(id) on delete set null,
  returned_at timestamptz, returned_by uuid references users(id) on delete set null,
  cancel_reason text, cancelled_by uuid references users(id) on delete set null,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- Both halves of the pair belong to one company (093's rule, for the same reason).
  foreign key (vessel_id, tenant_id) references vessels (id, tenant_id),
  foreign key (mechanic_employee_id, tenant_id) references employees (id, tenant_id),
  -- A visit that ended before it began is a typing mistake, not a short job.
  check (odometer_out_km is null or odometer_in_km is null or odometer_out_km >= odometer_in_km)
);

create index if not exists idx_work_orders_tenant on work_orders (tenant_id)
  where deleted_at is null;
-- The desk opens on what is still in the workshop, oldest card first, so a truck forgotten two
-- weeks ago cannot hide under one raised this morning.
create index if not exists idx_work_orders_open
  on work_orders (tenant_id, raised_on)
  where deleted_at is null and status in ('raised','in_workshop','awaiting_parts');
create index if not exists idx_work_orders_vessel
  on work_orders (vessel_id, raised_on desc);
-- "What does this garage cost us?" is asked per supplier, and it is asked across years.
create index if not exists idx_work_orders_garage
  on work_orders (tenant_id, garage_name)
  where deleted_at is null and garage_name is not null;

create trigger trg_work_orders_updated before update on work_orders
  for each row execute function public.set_updated_at();

alter table work_orders enable row level security;
create policy work_orders_tenant on work_orders for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
-- Select, insert, update. No DELETE: a closed job is history, and the house soft-delete pattern
-- (041) keeps the row and the audit line that wrote it.
grant select, insert, update on work_orders to app_runtime;

-- ============================================================
-- 3. the shape a work order has to keep
-- ============================================================
--
-- Every rule here is a statement the register makes about itself, so it is on the row rather
-- than in whichever route remembered it:
--
--   * the place decides who must be named — a garage or a mechanic, never neither;
--   * a state past `raised` says when it happened and who said so, and a `returned` row must
--     carry the odometer out, because that reading is the whole reason to close the card;
--   * a cancelled job carries no cost: a bill on a job that never happened is money with no
--     story, and the honest act is to raise a new order for the work that was actually done;
--   * a closed row (returned or cancelled) is not rewritten. Only the soft delete and the
--     columns that record it may move afterwards, so a figure that was signed off once stays
--     the figure that was signed off. A wrong number is corrected by a new order, which is the
--     same rule 107 gave a day's photograph and 108 gave a decided request's route.

create or replace function public.work_order_shape()
returns trigger language plpgsql set search_path = public as $$
declare
  closed boolean;
begin
  if new.place = 'outside_garage'
     and (new.garage_name is null or trim(new.garage_name) = '') then
    raise exception 'A job sent outside names the garage that has the vehicle.';
  end if;
  if new.place = 'in_house' and new.mechanic_employee_id is null then
    raise exception 'An in-house job names the mechanic who did it.';
  end if;
  -- An in-house card with a garage's job number on it is two stories about the same visit; the
  -- parts a workshop buys from a shop belong in `other_cost` and the note, not in a supplier's
  -- reference field that the register would then report as the supplier.
  if new.place = 'in_house' and new.garage_reference is not null
     and trim(new.garage_reference) <> '' then
    raise exception 'A garage job number belongs to a job sent to a garage.';
  end if;

  if new.status in ('in_workshop','awaiting_parts','returned')
     and (new.opened_at is null or new.opened_by is null) then
    raise exception 'A vehicle in the workshop has a date and a seat that put it there.';
  end if;
  if new.status = 'returned'
     and (new.returned_at is null or new.returned_by is null
          or new.odometer_out_km is null) then
    raise exception 'A returned vehicle is closed by a seat, a time and the odometer it came back with.';
  end if;
  if new.status = 'cancelled'
     and (new.cancelled_by is null or trim(coalesce(new.cancel_reason,'')) = '') then
    raise exception 'A cancelled work order says who called it off and why.';
  end if;
  if new.status = 'cancelled'
     and (new.parts_cost <> 0 or new.labour_cost <> 0 or new.other_cost <> 0) then
    raise exception 'A cancelled job carries no bill — raise an order for the work that was done.';
  end if;
  if new.status in ('raised','in_workshop','awaiting_parts')
     and (new.returned_at is not null or new.cancelled_by is not null) then
    raise exception 'A work order that is still open cannot hold a closing stamp.';
  end if;

  -- The closed row is the statement. Everything about it stays, and the only later edit is
  -- burying it, which the route does with `work_orders.close` and an audit line.
  closed := tg_op = 'UPDATE' and old.status in ('returned','cancelled');
  if closed and (   new.vessel_id         is distinct from old.vessel_id
                 or new.raised_on         is distinct from old.raised_on
                 or new.title             is distinct from old.title
                 or new.detail            is distinct from old.detail
                 or new.kind              is distinct from old.kind
                 or new.place             is distinct from old.place
                 or new.garage_name       is distinct from old.garage_name
                 or new.garage_reference  is distinct from old.garage_reference
                 or new.mechanic_employee_id is distinct from old.mechanic_employee_id
                 or new.status            is distinct from old.status
                 or new.odometer_in_km    is distinct from old.odometer_in_km
                 or new.odometer_out_km   is distinct from old.odometer_out_km
                 or new.parts_cost        is distinct from old.parts_cost
                 or new.labour_cost       is distinct from old.labour_cost
                 or new.other_cost        is distinct from old.other_cost
                 or new.currency          is distinct from old.currency
                 or new.invoice_ref       is distinct from old.invoice_ref
                 or new.opened_at         is distinct from old.opened_at
                 or new.opened_by         is distinct from old.opened_by
                 or new.returned_at       is distinct from old.returned_at
                 or new.returned_by       is distinct from old.returned_by
                 or new.cancel_reason     is distinct from old.cancel_reason
                 or new.cancelled_by      is distinct from old.cancelled_by
                 or new.created_by        is distinct from old.created_by) then
    raise exception 'A closed work order is not rewritten; a mistake is corrected by a new order.';
  end if;
  return new;
end $$;

drop trigger if exists trg_work_order_shape on work_orders;
create trigger trg_work_order_shape before insert or update
  on work_orders for each row execute function public.work_order_shape();

grant execute on function public.work_order_shape() to app_runtime;

-- ============================================================
-- 4. the garage's bill, filed with the job it bills
-- ============================================================
--
-- 097 extended this same CHECK for the intake drafts. The invoice a garage hands back is part of
-- the order, not part of the vehicle's papers: it belongs to one visit, one bill and one set of
-- figures, and the dossier that shows a truck's workshop history has to be able to show the
-- paper behind the numbers. The list below is the live one plus `work_order`, copied from
-- `pg_constraint` rather than from a previous migration file, because a CHECK that quietly drops
-- a value would strand the rows already filed under it.

alter table documents drop constraint if exists documents_entity_type_check;
alter table documents add constraint documents_entity_type_check
  check (entity_type in ('tenant','user','vessel','driver','trip','shipment','message',
    'licence','employee','office_cost','quotation','cargo_intake','work_order'));

-- ============================================================
-- 5. comments
-- ============================================================

comment on table work_orders is
  'One workshop visit: what was asked for, who is doing it, what it cost, and the odometer at both ends.';
comment on column work_orders.place is
  'in_house (mechanic_employee_id is mandatory) | outside_garage (garage_name is mandatory).';
comment on column work_orders.mechanic_employee_id is
  'This company''s staff member doing the job, paired to the tenant by work_orders_mechanic_employee_id_tenant_id_fkey.';
comment on column work_orders.garage_name is
  'A typed supplier name, the way office_costs.payee works. There is no vendor master on this platform.';
comment on column work_orders.odometer_out_km is
  'Mandatory on a returned row; the route pushes it into vessels.odometer_km with a guarded bump.';
comment on column work_orders.status is
  'raised | in_workshop | awaiting_parts | returned | cancelled. The vehicle''s own status is a projection of this, written beside it.';

-- ============================================================
-- 6. the duties behind the register
-- ============================================================
--
-- New keys rather than the `garage.*` set that 033 seeded for spare parts: a seat that can move
-- a stock item should not, by that fact alone, be able to sign off a workshop bill and put a
-- truck back on the road. `close` is the terminal act on its own so a desk can let a foreman
-- edit an open card without letting them end one.

insert into permissions (key, description) values
  ('work_orders.view',   'Workshop - Read the work order register'),
  ('work_orders.create', 'Workshop - Raise a work order'),
  ('work_orders.edit',   'Workshop - Edit a card that is still open'),
  ('work_orders.close',  'Workshop - Return a vehicle or cancel a card')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
  from roles r
  join permissions p on p.key in ('work_orders.view','work_orders.create',
                                  'work_orders.edit','work_orders.close')
 where r.tenant_id is null
   and (r.key in ('director','general_manager','operations_manager','fleet_manager',
                  'workshop_manager')
        -- Money is read by the desks that pay it, and a dispatcher needs to know a truck is
        -- held before promising it to a load.
        or (r.key in ('auditor','finance_officer','billing_admin','dispatcher')
            and p.key = 'work_orders.view'))
on conflict do nothing;

do $$ declare
  v_rows int;
begin
  select count(*)::int into v_rows from work_orders;
  raise notice '109: the work order register is open; % card(s) in it, the duty keys held by the workshop desks', v_rows;
end $$;

commit;
