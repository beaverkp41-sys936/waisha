-- 095 — trip pay reaches the payslip (task #173, part 2 of 2).
--
-- 094 wrote down what a completed trip earned. This carries that figure into the only place
-- a driver is actually paid: the payroll line.
--
-- The rule 072/073 established is that a payroll line is *derived*, and hand-written money on
-- a line is the exception with a label on it. Trip pay belongs to the derived half — it comes
-- from the trip register and the driver's own terms, and the office cannot type it — so it is
-- stamped by the same trigger that stamps base, deduction and net, from the same single body of
-- arithmetic the preview reads. There is deliberately no route that writes `trip_pay_amount`.
--
-- 073's reason for putting the maths in a function was that a preview and a built line must not
-- disagree, and this stage is exactly the case that argument was for: the preview has to show
-- trip pay or the desk is surprised at build time. So the derivation grows a sixth input and
-- every reader passes it. The old five-argument `payroll_derive` is dropped rather than left
-- standing beside the new one — two functions where a five-argument call could mean either is
-- how an omitted trip pay silently disappears from a net figure — and there is no default on
-- the new argument, so a caller that forgets it fails loudly instead of paying a driver as if
-- they had not driven.
--
-- `net_amount = round(base_amount + trip_pay_amount + adjustment_amount, 2)` replaces 072's
-- check. Every stored row already satisfies it, because `trip_pay_amount` defaults to 0 and
-- 0 + x = x, so the constraint is replaced rather than back-filled; and `payroll_run_roll_up`
-- now foots `gross_total` as salary *plus* trip pay, which keeps the run's own identity
-- `net_total = gross_total + adjustment_total` true. A trip bonus hidden in a column the
-- summary never adds would be the first thing an auditor catches and the last thing the office
-- wants to explain.
--
-- Claiming is what makes this safe to run twice a month, and it is the reason the entry keeps
-- `paid_run_id` rather than a flag:
--
--   a line's trip pay is every unclaimed earning of that person dated up to the end of the
--   run's month — so a leg that arrived on 31 October and was only completed on 4 November
--   is paid with November's salary instead of being lost, and
--   issuing a run first re-prices its own lines (so the document that goes out carries every
--   earning registered since it was built), then stamps those entries with the run, and
--   cancelling a run releases them again, and
--   after either stamp, the tenant's *other* draft runs are re-derived, because an earning
--   that October just took cannot also be paid by November. Two drafts claiming one trip is
--   the way a driver gets paid twice for the same leg, and the second cheque is the one nobody
--   notices.
--
-- 094's gate refused to change a claimed row at all. That is still true of the figures, but
-- claim and release are themselves writes to `paid_run_id`, so the gate now distinguishes a
-- stamp — every other column bit-identical — from an edit. A row whose number moves while it
-- is being claimed is exactly the bug that would pay two people for one trip, and it is refused.
--
-- Nothing here talks to a bank and nothing moves money: the run still ends in a
-- `payment_reference` typed by whoever actually made the transfer.

begin;

-- ============================================================
-- 1. the columns
-- ============================================================

alter table payroll_lines
  add column if not exists trip_pay_amount numeric(14,2) not null default 0
    check (trip_pay_amount >= 0);

alter table payroll_runs
  add column if not exists trip_pay_total numeric(14,2) not null default 0
    check (trip_pay_total >= 0);

-- 072's check, grown by the new term. A line that adds up to itself is what lets the trigger
-- stamp four money columns from one function call and still be provable.
alter table payroll_lines drop constraint if exists payroll_lines_check;
alter table payroll_lines
  add constraint payroll_lines_check
  check (net_amount = round(base_amount + trip_pay_amount + adjustment_amount, 2));

comment on column payroll_lines.trip_pay_amount is
  'What this person''s completed trips earned up to the end of the run''s month, unclaimed ones only. Stamped by the line trigger from trip_pay_claim, never typed.';
comment on column payroll_runs.trip_pay_total is
  'Sum of the lines'' trip pay. Carried inside gross_total, so the run still foots as gross + adjustments = net.';

-- ============================================================
-- 2. the claim: which earnings belong to this line
-- ============================================================
--
-- One function for the trigger and for the payslip read, so the figure on the slip is the
-- figure that was stamped and the trips underneath it are the ones that made it.
--
-- Deliberately no lower bound. `earned_on < period end` with `paid_run_id is null` is what
-- makes an overdue earning self-healing: it is paid in the next run that has not been issued,
-- and the entries list on the payslip shows its date, so a trip paid two months late is
-- visible rather than quietly averaged away.
--
-- A trip whose row has been removed stops being payable through the join, which is why the
-- register does not need a DELETE.
--
-- Money leaves as text. A numeric(14,2) that travels through JSON arrives as a float, and a
-- payslip that prints 127250.00000000001 is not a rounding bug but a presentation one.

create or replace function public.trip_pay_claim(
  p_run_id uuid,
  p_employee_id uuid,
  p_period date
) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'total', coalesce(sum(e.amount), 0)::numeric(14,2)::text,
    'count', count(*)::int,
    'entries', coalesce(
      jsonb_agg(jsonb_build_object(
        'entry_id', e.id,
        'trip_id', e.trip_id,
        'reference', t.reference,
        'driver_id', e.driver_id,
        'basis', e.basis,
        'rate', e.rate::text,
        'quantity', e.quantity::text,
        'amount', e.amount::text,
        'earned_on', to_char(e.earned_on, 'YYYY-MM-DD'),
        'paid_run_id', e.paid_run_id
      ) order by e.earned_on, t.reference, e.id),
      '[]'::jsonb)
  )
  from trip_pay_entries e
  join trips t on t.id = e.trip_id
  where e.employee_id = p_employee_id
    and t.deleted_at is null
    and e.earned_on < (p_period::date + interval '1 month')
    -- An entry already stamped by some other run is not this run's money, whoever is asking.
    -- With no run (a preview) that reads as "unclaimed only".
    and (e.paid_run_id is null
         or (p_run_id is not null and e.paid_run_id = p_run_id));
$$;

comment on function public.trip_pay_claim(uuid, uuid, date) is
  'The unclaimed earnings one person has up to the end of a run''s month: the total the line is stamped with and the trips that make it.';

-- ============================================================
-- 3. the derivation, with trip pay in it
-- ============================================================

-- Drop, do not replace: the five-argument body is a different function as far as Postgres is
-- concerned, and leaving it standing would let a call that omits trip pay resolve to it.
drop function if exists public.payroll_derive(numeric, int, int, int, numeric);

create or replace function public.payroll_derive(
  p_salary numeric,
  p_working_days int,
  p_unpaid_leave_days int,
  p_absence_days int,
  p_adjustment numeric,
  p_trip_pay numeric
) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'days_paid',        b.days,
    'base_amount',      b.base,
    'deduction_amount', round(p_salary * (p_working_days - b.days)
                              / nullif(p_working_days, 0), 2),
    -- Normalised here rather than trusted from the caller: the CHECK on the row compares
    -- against the stored 2dp column, so this is the one place that decides the cent.
    'trip_pay_amount',  round(coalesce(p_trip_pay, 0), 2),
    'net_amount',       round(b.base + round(coalesce(p_trip_pay, 0), 2)
                              + coalesce(p_adjustment, 0), 2)
  )
  from (
    select d.days,
           round(p_salary * d.days / nullif(p_working_days, 0), 2) as base
      from (values (greatest(0, p_working_days
                    - least(p_working_days,
                            coalesce(p_unpaid_leave_days, 0)
                          + coalesce(p_absence_days, 0))))
           ) d(days)
  ) b;
$$;

comment on function public.payroll_derive(numeric, int, int, int, numeric, numeric) is
  'The whole payroll arithmetic: days paid, base, deduction, trip pay and net. Called by the line trigger on every write and by the preview read — there is no second copy, and there is no default on the sixth argument so a caller that forgets trip pay fails rather than underpaying.';

-- ============================================================
-- 4. the line trigger now stamps trip pay too
-- ============================================================

create or replace function public.payroll_line_gate()
returns trigger language plpgsql set search_path = public as $$
declare
  v_status text;
  v_period date;
  v_run uuid;
  v_claim jsonb;
  v_derived jsonb;
begin
  v_run := case when tg_op = 'DELETE' then old.run_id else new.run_id end;
  select status, period into v_status, v_period from payroll_runs where id = v_run;

  if v_status is null then
    raise exception 'Payroll lines belong to a run that does not exist.'
      using errcode = 'P0001';
  end if;
  if v_status = 'issued' then
    raise exception 'That run has been issued, so its lines cannot change. Cancel the run and build a new one.'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  -- Unchanged from 073: the inputs the office may not argue with after the fact.
  -- `trip_pay_amount` is deliberately not on this list for the same reason the other money
  -- columns are not — it is re-derived below on every write, so a self-update that exists to
  -- force a re-read is legal and an edit that types a figure is silently discarded.
  if tg_op = 'UPDATE' and (
       new.monthly_salary   <> old.monthly_salary
    or new.employee_id      <> old.employee_id
    or new.run_id           <> old.run_id
    or new.working_days     <> old.working_days
    or new.unpaid_leave_days <> old.unpaid_leave_days
    or new.absence_days     <> old.absence_days
    or new.unrecorded_days  <> old.unrecorded_days
    or new.half_days        <> old.half_days
    or new.late_minutes     <> old.late_minutes) then
    raise exception '% is derived from the roster and the register — rebuild the run to change it.', new.employee_name
      using errcode = 'P0001';
  end if;

  v_claim := public.trip_pay_claim(v_run, new.employee_id, v_period);

  v_derived := public.payroll_derive(new.monthly_salary, new.working_days,
                                     new.unpaid_leave_days, new.absence_days,
                                     new.adjustment_amount,
                                     (v_claim ->> 'total')::numeric);
  new.days_paid        := (v_derived ->> 'days_paid')::int;
  new.base_amount      := (v_derived ->> 'base_amount')::numeric(14,2);
  new.deduction_amount := (v_derived ->> 'deduction_amount')::numeric(14,2);
  new.trip_pay_amount  := (v_derived ->> 'trip_pay_amount')::numeric(14,2);
  new.net_amount       := (v_derived ->> 'net_amount')::numeric(14,2);

  -- The trips behind the figure ride on the line, next to the dates that were charged, so a
  -- disputed payslip is settled by looking at the row rather than by re-running a query.
  new.detail := new.detail
    - 'trip_pay'
    - 'trip_pay_count'
    - 'trip_pay_total'
    || jsonb_build_object(
         'trip_pay',        coalesce(v_claim -> 'entries', '[]'::jsonb),
         'trip_pay_count',  (v_claim ->> 'count')::int,
         'trip_pay_total',  (v_claim ->> 'total')::numeric(14,2)::text);

  if new.net_amount < 0 then
    raise exception 'That would take % below zero, which is not a deduction — it is a debt. Record it as an adjustment with a reason.', new.employee_name
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ============================================================
-- 5. the run foots its own trip pay
-- ============================================================

create or replace function public.payroll_run_roll_up()
returns trigger language plpgsql set search_path = public as $$
declare
  v_run uuid;
begin
  v_run := case when tg_op = 'DELETE' then old.run_id else new.run_id end;
  update payroll_runs r set
    -- Gross is what the person is paid before adjustments: the days they were on the payroll
    -- for, plus the legs they drove. Trip pay is not a side total the summary forgets.
    gross_total = coalesce((select sum(base_amount + trip_pay_amount) from payroll_lines
                            where run_id = v_run), 0),
    deduction_total = coalesce((select sum(deduction_amount) from payroll_lines
                             where run_id = v_run), 0),
    adjustment_total = coalesce((select sum(adjustment_amount) from payroll_lines
                             where run_id = v_run), 0),
    trip_pay_total = coalesce((select sum(trip_pay_amount) from payroll_lines
                            where run_id = v_run), 0),
    net_total = coalesce((select sum(net_amount) from payroll_lines
                          where run_id = v_run), 0),
    headcount = (select count(*)::int from payroll_lines where run_id = v_run)
  where r.id = v_run and r.status = 'draft';
  return null;
end $$;

-- ============================================================
-- 6. claim on issue, release on cancel
-- ============================================================
--
-- Called by the run route in the same transaction as the status change, so a run cannot be
-- issued while its earnings stay unclaimed, or cancelled while they stay stamped.

create or replace function public.trip_pay_settle(
  p_run_id uuid,
  p_claim boolean,
  p_actor_id uuid default null
) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_run record;
  v_lines int := 0;
  v_stamped int := 0;
  v_refreshed jsonb := '{}'::jsonb;
  v_other record;
  v_n int;
begin
  select tenant_id, period, period::text as label, status
    into v_run from payroll_runs
   where id = p_run_id and deleted_at is null;
  if not found then
    raise exception 'Payroll run not found.' using errcode = 'P0001';
  end if;

  if p_claim then
    if v_run.status <> 'draft' then
      raise exception 'Only a draft run claims trip pay. This one is %.', v_run.status
        using errcode = 'P0001';
    end if;
    -- Re-price the draft before it becomes a document: a leg completed since the build is
    -- inside the month and the driver is owed it. The assigned value is discarded by the
    -- trigger, which recomputes it from the register — this is the re-derivation, not a write.
    update payroll_lines set trip_pay_amount = trip_pay_amount
      where run_id = p_run_id;
    get diagnostics v_lines = row_count;

    update trip_pay_entries e
       set paid_run_id = p_run_id, updated_by = p_actor_id
      where e.employee_id in (select l.employee_id from payroll_lines l where l.run_id = p_run_id)
        and e.paid_run_id is null
        and e.earned_on < (v_run.period + interval '1 month')
        and exists (select 1 from trips t where t.id = e.trip_id and t.deleted_at is null);
    get diagnostics v_stamped = row_count;
  else
    update trip_pay_entries e
       set paid_run_id = null, updated_by = p_actor_id
      where e.paid_run_id = p_run_id;
    get diagnostics v_stamped = row_count;
  end if;

  -- Every other draft of this company now reads a register that has changed under it. One
  -- statement per run is enough: the line trigger re-derives and the roll-up re-foots.
  for v_other in
    select id from payroll_runs
     where tenant_id = v_run.tenant_id and status = 'draft' and id <> p_run_id
       and deleted_at is null
  loop
    update payroll_lines set trip_pay_amount = trip_pay_amount where run_id = v_other.id;
    get diagnostics v_n = row_count;
    v_refreshed := v_refreshed
      || jsonb_build_object(v_other.id::text, v_n);
  end loop;

  return jsonb_build_object('run_id', p_run_id, 'period', v_run.label,
                            'claimed', p_claim, 'lines', v_lines,
                            'entries', v_stamped, 'drafts_refreshed', v_refreshed);
end $$;

comment on function public.trip_pay_settle(uuid, boolean, uuid) is
  'Claims a draft''s earnings into a run when it is issued, releases them when that run is cancelled, and re-derives the tenant''s other drafts so no earning is paid twice.';

-- ============================================================
-- 7. the gate learns the difference between a stamp and an edit
-- ============================================================

create or replace function public.trip_pay_gate()
returns trigger language plpgsql set search_path = public as $$
declare
  v_stamp_only boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'A trip-pay entry is not deleted. Correct it while it is unclaimed, or cancel the run that claimed it.'
      using errcode = 'P0001';
  end if;

  -- A claim, or its release: only `paid_run_id` (and who did it) moves. Anything else riding
  -- along on the same write is an edit wearing a stamp, and it is refused.
  v_stamp_only := new.employee_id is not distinct from old.employee_id
              and new.trip_id = old.trip_id
              and new.driver_id = old.driver_id
              and new.basis = old.basis
              and new.rate = old.rate
              and new.quantity = old.quantity
              and new.amount = old.amount
              and new.currency = old.currency
              and new.earned_on = old.earned_on
              and new.note is not distinct from old.note;

  -- A stamp may be put on an unclaimed row or taken off it. A row one run has claimed moving
  -- to a *different* run is not a stamp — it is the same month's money inside two documents,
  -- and the only sanctioned way to move it is to cancel the run that holds it.
  if v_stamp_only
     and (old.paid_run_id is null or new.paid_run_id is null
          or new.paid_run_id = old.paid_run_id) then
    return new;
  end if;

  if old.paid_run_id is not null then
    raise exception 'That earning is already inside run % and cannot change. Cancel the run to reopen it.',
      (select coalesce(to_char(period,'Mon YYYY'), '???') from payroll_runs where id = old.paid_run_id)
      using errcode = 'P0001';
  end if;
  if new.paid_run_id is not null then
    raise exception 'Trip pay is claimed by issuing a payroll run, not by editing an entry.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ============================================================
-- 8. grants
-- ============================================================
--
-- Same rule as 073's derivation and 094's accrual: security invoker, so every read inside the
-- function goes through RLS for the tenant the transaction is bound to, and EXECUTE belongs to
-- the application role alone. A freshly created function inherits EXECUTE to PUBLIC, so it is
-- revoked in the migration that makes it, not in a later clean-up.

grant execute on function public.trip_pay_claim(uuid, uuid, date) to app_runtime;
revoke all on function public.trip_pay_claim(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.trip_pay_settle(uuid, boolean, uuid) to app_runtime;
revoke all on function public.trip_pay_settle(uuid, boolean, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.payroll_derive(numeric, int, int, int, numeric, numeric) to app_runtime;
revoke all on function public.payroll_derive(numeric, int, int, int, numeric, numeric)
  from public, anon, authenticated, service_role;

-- The three gates this migration re-creates inherited PUBLIC again on the way in, and 073 left
-- them that way. A trigger does not need EXECUTE to fire — the executor calls it — so taking
-- the grant away costs the module nothing and stops any role reading a body it may only ever
-- be called by a write.
grant execute on function public.payroll_line_gate() to app_runtime;
revoke all on function public.payroll_line_gate()
  from public, anon, authenticated, service_role;
grant execute on function public.payroll_run_roll_up() to app_runtime;
revoke all on function public.payroll_run_roll_up()
  from public, anon, authenticated, service_role;
grant execute on function public.trip_pay_gate() to app_runtime;
revoke all on function public.trip_pay_gate()
  from public, anon, authenticated, service_role;

-- ============================================================
-- 9. what the stored lines say now
-- ============================================================
--
-- No line is rewritten by this migration: the new column defaults to 0 and the new CHECK is the
-- old one plus a zero. The next write to a draft line — a rebuild, an adjustment — re-derives it
-- with trip pay in it, which is the intended route for a figure that only the trigger may own.

do $$ declare
  v_runs int;
  v_issued int;
  v_entries int;
  v_unlinked int;
begin
  select count(*)::int, coalesce(sum((status = 'issued')::int), 0)::int
    into v_runs, v_issued from payroll_runs where deleted_at is null;
  select count(*)::int into v_entries from trip_pay_entries;
  select count(*)::int into v_unlinked from trip_pay_entries
    where employee_id is null and paid_run_id is null;
  raise notice '095: % payroll run(s) (% issued) and % trip-pay entr(y/ies), of which % have no roster link yet and cannot be claimed',
    v_runs, v_issued, v_entries, v_unlinked;
end $$;

commit;
