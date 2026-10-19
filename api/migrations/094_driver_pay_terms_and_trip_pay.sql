-- 094 — what a driver earns for a trip (task #173, part 1 of 2).
--
-- A trip knew what it *charged*: `trip_shipments.freight_charge` is what the customer pays
-- CFA. Nothing anywhere said what the person who drove it gets. `routes.rate_per_km`,
-- `rate_per_tonne` and `rate_per_trip` price the company's own freight — they are a quote
-- sheet, not a payslip, and using them as driver pay would silently put every margin
-- decision onto the driver. So a driver's pay is its own agreement, and a completed trip is
-- an earning that has to be written down somewhere.
--
--   `driver_pay_terms`  one row per driver: how they are paid and how much, and which
--                       payroll roster seat they are paid *into*.
--   `trip_pay_entries`  the register: one row per (trip, driver), priced at the moment the
--                       trip became completed, claiming into a payroll run when the run is
--                       issued and released again if that run is cancelled.
--
-- Five bases, because Tanzanian transport employs drivers any of these ways: a flat sum per
-- trip, per kilometre, per tonne actually carried, a percentage of the freight the trip
-- earned, and `salary_only` for a driver who is a salaried staff member and earns nothing
-- extra for driving. `rate` is a single column shared by all of them — per kilometre it is
-- shillings, per tonne shillings, per trip shillings, and on the percentage basis it is
-- hundredths of the freight. One money column instead of five nullable ones is what keeps a
-- reviewer able to read the row.
--
-- The `quantity`/`amount` pair is CHECKed against the basis, not just stored: a row that
-- says 412 km at 250 does not get to hold a figure that disagrees with 103 000. That is the
-- same brace 072 put on `payroll_lines.net_amount` — the arithmetic is asserted in the data,
-- so a route that forgets to recompute is caught by the database rather than by a quarter.
--
-- `earned_on` is the arrival date, not today's date, and that is what makes the register
-- payable: payroll claims entries by period, so a trip that arrived on 31 October and was
-- only completed on 3 November lands in October's money, and a late entry falls into the
-- next run that has not been issued yet instead of vanishing.
--
-- The register is append-only in the way that matters. There is no DELETE grant anywhere:
-- removing a trip's earning is not how a mistake is corrected, a corrected entry is. UPDATE
-- is allowed only while the row is unclaimed — `trip_pay_gate` refuses to touch a row that
-- an issued run has stamped, because that row is now inside a payslip somebody was handed.
-- A soft-deleted trip does not need its entries deleted to stop being paid: the claim
-- excludes them by joining the trip.
--
-- Accrual is a database trigger, not a step in the route. 075's trip status route is not the
-- only way a trip can become completed — a backfill, a control-desk repair, a future import
-- all can — and money that only appears when one particular caller remembered to ask for it
-- is not a register. The function never raises for a *missing* arrangement: a driver with no
-- terms, a trip with no driver, a salary-only driver and a leg with no distance each leave
-- their own honest trace (no row, or a zero row) for the gaps view to count, because failing
-- to price a trip must not stop the desk from marking it arrived.
--
-- Nothing here moves money. 095 carries these figures into `payroll_lines` and gives the run
-- the arithmetic that pays them; this half only writes down what was earned.

begin;

-- ============================================================
-- 1. the arrangement: how this driver is paid for driving
-- ============================================================

create table if not exists driver_pay_terms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  driver_id uuid not null references drivers(id),
  -- Which payroll seat the earnings are paid into. Nullable on purpose, and its nullness is
  -- a state the desk has to resolve, not a detail: the trip happened, the money was earned,
  -- and until a roster row is named there is nobody to put it on a payslip for. The office
  -- answers that from Office -> Employees.
  employee_id uuid references employees(id),
  basis text not null check (basis in
    ('per_trip','per_km','per_tonne','percent_of_freight','salary_only')),
  rate numeric(14,4) not null default 0 check (rate >= 0),
  currency text not null default 'TZS' check (currency = 'TZS'),
  note text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- A rate on `salary_only` is a number that is never used, and an unused number in a pay
  -- table is how a wrong rate gets read back later.
  check (basis = 'salary_only' or rate > 0)
);

-- One agreement per driver, one driver per roster seat: a driver paid through two seats would
-- be paid twice for the same leg.
create unique index driver_pay_terms_driver_uq on driver_pay_terms (driver_id)
  where deleted_at is null;
create unique index driver_pay_terms_employee_uq on driver_pay_terms (tenant_id, employee_id)
  where employee_id is not null and deleted_at is null;
create index idx_driver_pay_terms_tenant on driver_pay_terms (tenant_id)
  where deleted_at is null;
create trigger trg_driver_pay_terms_updated before update on driver_pay_terms
  for each row execute function public.set_updated_at();

alter table driver_pay_terms enable row level security;
create policy driver_pay_terms_tenant on driver_pay_terms for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update on driver_pay_terms to app_runtime;

-- ============================================================
-- 2. the register: what a completed trip earned
-- ============================================================

create table if not exists trip_pay_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  trip_id uuid not null references trips(id),
  -- Held even though `trips.driver_id` already does: a trip's driver can be corrected on the
  -- row while the earning must stay attributed to the person who actually drove it.
  driver_id uuid not null references drivers(id),
  -- Copied from the terms at accrual, not joined at read. The roster link is allowed to be
  -- fixed later -- that is what the re-stamp in the API does to an *unclaimed* row -- and a
  -- row inside an issued run must keep saying what it said when it was paid.
  employee_id uuid references employees(id),
  basis text not null check (basis in
    ('per_trip','per_km','per_tonne','percent_of_freight')),
  rate numeric(14,4) not null check (rate >= 0),
  -- What was counted: 1 trip, the kilometres, the tonnes, or -- on the percentage basis --
  -- the freight the trip charged, which is what the rate is a percentage *of*.
  quantity numeric(14,3) not null default 0 check (quantity >= 0),
  amount numeric(14,2) not null default 0 check (amount >= 0),
  currency text not null default 'TZS' check (currency = 'TZS'),
  earned_on date not null,
  -- Stamped when a run is issued, cleared if that run is cancelled. This is the whole
  -- difference between "earned" and "still waiting to be paid".
  paid_run_id uuid references payroll_runs(id),
  note text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The basis decides what `quantity` means, so it also decides the arithmetic. Both forms
  -- are asserted; a row cannot disagree with its own label.
  check ((basis = 'percent_of_freight') or amount = round(quantity * rate, 2)),
  check ((basis <> 'percent_of_freight') or amount = round(quantity * rate / 100, 2))
);

create unique index trip_pay_entries_trip_driver_uq
  on trip_pay_entries (tenant_id, trip_id, driver_id);
create index idx_trip_pay_entries_claim on trip_pay_entries (tenant_id, employee_id, earned_on)
  where paid_run_id is null;
create index idx_trip_pay_entries_run on trip_pay_entries (paid_run_id)
  where paid_run_id is not null;
create trigger trg_trip_pay_entries_updated before update on trip_pay_entries
  for each row execute function public.set_updated_at();

alter table trip_pay_entries enable row level security;
create policy trip_pay_entries_tenant on trip_pay_entries for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
-- Select, insert, update -- and no delete, from any role the application runs as. See header.
grant select, insert, update on trip_pay_entries to app_runtime;

-- ---------------------------------------------------------------------------
-- The gate: unclaimed rows may be re-priced by the accrual function; a row a
-- run has claimed is a fact about money somebody has already been paid.
-- ---------------------------------------------------------------------------
create or replace function public.trip_pay_gate()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'A trip-pay entry is not deleted. Correct it while it is unclaimed, or cancel the run that claimed it.'
      using errcode = 'P0001';
  end if;
  if old.paid_run_id is not null then
    raise exception 'That earning is already inside run % and cannot change. Cancel the run to reopen it.',
      (select coalesce(to_char(period,'Mon YYYY'), '???') from payroll_runs where id = old.paid_run_id)
      using errcode = 'P0001';
  end if;
  -- An entry can leave a claim only through the run, so clearing the stamp here would be a
  -- way to un-pay a driver without cancelling anything.
  if new.paid_run_id is distinct from old.paid_run_id and new.paid_run_id is not null then
    raise exception 'Trip pay is claimed by issuing a payroll run, not by editing an entry.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger trg_trip_pay_gate before update or delete on trip_pay_entries
  for each row execute function public.trip_pay_gate();

comment on function public.trip_pay_gate() is
  'Refuses DELETE on the register outright and refuses any change to a row an issued run has claimed.';

-- ============================================================
-- 3. the accrual
-- ============================================================
--
-- One body, three readers: the completion trigger, the backfill in this migration, and the
-- desk's re-price button. Calling it again on a trip that already has an unclaimed row
-- re-prices it from the trip and the terms in front of it, so the function is safe to retry
-- and never needs a "did I already do this" flag.

create or replace function public.trip_pay_accrue(
  p_trip_id uuid,
  p_actor_id uuid default null
) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_trip   record;
  v_terms  record;
  v_cur    record;
  v_ship   record;
  v_qty    numeric(14,3);
  v_amount numeric(14,2);
  v_out    jsonb;
begin
  select t.tenant_id, t.driver_id, t.status, t.distance_km, t.reference,
         t.actual_arrival,
         coalesce(t.actual_arrival::date, current_date) as earned_on
    into v_trip
    from trips t
   where t.id = p_trip_id and t.deleted_at is null;
  if not found then
    return jsonb_build_object('status','skipped','reason','no_trip','trip_id',p_trip_id);
  end if;
  if v_trip.status <> 'completed' then
    return jsonb_build_object('status','skipped','reason','not_completed','trip_id',p_trip_id);
  end if;

  v_out := jsonb_build_object('trip_id', p_trip_id, 'reference', v_trip.reference,
                              'driver_id', v_trip.driver_id,
                              'earned_on', v_trip.earned_on);

  -- A leg nobody is named on cannot be paid. It is not a defect in the register; it is a
  -- trip that needs its driver, and the gaps view counts it so the desk sees it ran.
  if v_trip.driver_id is null then
    return v_out || jsonb_build_object('status','skipped','reason','no_driver');
  end if;

  select * into v_terms from driver_pay_terms
    where driver_id = v_trip.driver_id and deleted_at is null;
  if not found then
    return v_out || jsonb_build_object('status','skipped','reason','no_terms');
  end if;
  if v_terms.basis = 'salary_only' then
    return v_out || jsonb_build_object('status','skipped','reason','salary_only');
  end if;

  select coalesce(sum(s.weight_kg), 0) as kg,
         coalesce(sum(s.freight_charge), 0) as freight
    into v_ship
    from trip_shipments s
   where s.trip_id = p_trip_id and s.deleted_at is null;

  -- The kilometres are the trip's own snapshot (075 copies them from the route when it is
  -- planned); the tonnes and the freight are what the cargo on the trip actually says.
  v_qty := case v_terms.basis
             when 'per_trip'           then 1
             when 'per_km'             then coalesce(v_trip.distance_km, 0)
             when 'per_tonne'          then round(coalesce(v_ship.kg, 0) / 1000, 3)
             when 'percent_of_freight' then coalesce(v_ship.freight, 0)
           end;
  v_qty := round(coalesce(v_qty, 0), 3);
  v_amount := case when v_terms.basis = 'percent_of_freight'
                   then round(v_qty * v_terms.rate / 100, 2)
                   else round(v_qty * v_terms.rate, 2) end;

  select * into v_cur from trip_pay_entries
    where tenant_id = v_trip.tenant_id and trip_id = p_trip_id
      and driver_id = v_trip.driver_id;
  if found and v_cur.paid_run_id is not null then
    -- Already inside a run. The number that was paid stands, whatever the terms say now.
    return v_out || jsonb_build_object('status','claimed','entry_id', v_cur.id,
                                      'amount', v_cur.amount,
                                      'paid_run_id', v_cur.paid_run_id);
  end if;

  if found then
    update trip_pay_entries
       set employee_id = v_terms.employee_id, basis = v_terms.basis, rate = v_terms.rate,
           quantity = v_qty, amount = v_amount, earned_on = v_trip.earned_on,
           updated_by = p_actor_id
     where id = v_cur.id;
    return v_out || jsonb_build_object('status','repriced','entry_id', v_cur.id,
                                      'basis', v_terms.basis, 'rate', v_terms.rate,
                                      'quantity', v_qty, 'amount', v_amount,
                                      'employee_linked', v_terms.employee_id is not null);
  end if;

  insert into trip_pay_entries
    (tenant_id, trip_id, driver_id, employee_id, basis, rate, quantity, amount,
     currency, earned_on, created_by, updated_by)
  values
    (v_trip.tenant_id, p_trip_id, v_trip.driver_id, v_terms.employee_id, v_terms.basis,
     v_terms.rate, v_qty, v_amount, v_terms.currency, v_trip.earned_on,
     p_actor_id, p_actor_id);

  -- Zero is a real answer here, so it is kept as a row rather than skipped: a per-kilometre
  -- driver on a trip whose route was never given a distance earned 0, and the register says
  -- so instead of leaving the desk to wonder whether the trip was priced at all.
  return v_out || jsonb_build_object('status','accrued','basis', v_terms.basis,
                                     'rate', v_terms.rate, 'quantity', v_qty,
                                     'amount', v_amount,
                                     'employee_linked', v_terms.employee_id is not null);
end $$;

comment on function public.trip_pay_accrue(uuid, uuid) is
  'Prices one completed trip against its driver''s terms and writes the register row. Idempotent while the row is unclaimed; never raises for a missing arrangement.';

create or replace function public.trip_pay_on_trip_completion()
returns trigger language plpgsql set search_path = public as $$
begin
  perform public.trip_pay_accrue(new.id);
  return null;
end $$;

create trigger trg_trips_pay_on_complete after update on trips
  for each row when (new.status = 'completed' and old.status is distinct from 'completed')
  execute function public.trip_pay_on_trip_completion();

-- ============================================================
-- 4. grants on the two functions
-- ============================================================
--
-- Security invoker, like 073's derivation: the accrual reads the trip, its shipments and the
-- terms through RLS, so a caller inside a tenant can only ever price that tenant's own legs.
-- New functions inherit EXECUTE to PUBLIC from Postgres unless told otherwise, so revoke it
-- here rather than in a later clean-up migration.

grant execute on function public.trip_pay_accrue(uuid, uuid) to app_runtime;
revoke all on function public.trip_pay_accrue(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.trip_pay_on_trip_completion() to app_runtime;
revoke all on function public.trip_pay_on_trip_completion()
  from public, anon, authenticated, service_role;
grant execute on function public.trip_pay_gate() to app_runtime;
revoke all on function public.trip_pay_gate()
  from public, anon, authenticated, service_role;

-- ============================================================
-- 5. price the trips that already happened
-- ============================================================
--
-- Completed legs exist in every company that has ever run one, and a register that starts
-- empty next to a payroll that pays salaries would look like driving is free. This runs the
-- same function the trigger uses, so a backfilled row is not a different kind of row.

do $$ declare
  v_row record;
  v_res jsonb;
  v_accrued int := 0;
  v_repriced int := 0;
  v_no_terms int := 0;
  v_no_driver int := 0;
  v_salary_only int := 0;
  v_claimed int := 0;
  v_other int := 0;
begin
  for v_row in select id from trips
                where status = 'completed' and deleted_at is null
                order by coalesce(actual_arrival, created_at)
  loop
    v_res := public.trip_pay_accrue(v_row.id);
    case v_res ->> 'status'
      when 'accrued'   then v_accrued := v_accrued + 1;
      when 'repriced'  then v_repriced := v_repriced + 1;
      when 'claimed'   then v_claimed := v_claimed + 1;
      else
        case v_res ->> 'reason'
          when 'no_terms'    then v_no_terms := v_no_terms + 1;
          when 'no_driver'   then v_no_driver := v_no_driver + 1;
          when 'salary_only' then v_salary_only := v_salary_only + 1;
          else v_other := v_other + 1;
        end case;
    end case;
  end loop;
  raise notice '094: % trip(s) priced and % re-priced from the register; % leg(s) completed by a driver with no pay terms, % by a salary-only driver, % with no driver named, % already inside a run, % other',
    v_accrued, v_repriced, v_no_terms, v_salary_only, v_no_driver, v_claimed, v_other;
end $$;

-- ============================================================
-- 6. the duties
-- ============================================================
--
-- Reading an arrangement and setting one are different, and the split follows 072's: money
-- terms belong to the seats that carry payroll, and hr_officer -- who builds the roster and
-- deliberately cannot see payroll -- is not one of them. `fleet_manager` and the operations
-- seats may read them, because a fleet manager who cannot see what a driver is paid per
-- tonne cannot explain a fuel or route argument to anybody.

insert into permissions (key, description) values
  ('driver_pay.view',  'Driver Pay - View a driver''s terms and what their trips have earned'),
  ('driver_pay.edit',  'Driver Pay - Set terms, link a driver to the payroll roster and re-price unclaimed earnings')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
  from roles r
  join permissions p on p.key = 'driver_pay.view'
 where r.tenant_id is null
   and r.key in ('director','general_manager','operations_manager','fleet_manager',
                 'finance_officer','auditor')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
  from roles r
  join permissions p on p.key = 'driver_pay.edit'
 where r.tenant_id is null
   and r.key in ('director','finance_officer')
on conflict do nothing;

commit;
