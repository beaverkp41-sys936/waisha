-- 073 — the payroll arithmetic, in one place (follows 072, task #113).
--
-- 072 put the pro-rata inside `payroll_line_gate()`, which is right for a line that
-- is being written. It is wrong for the screen the office needs first: "what would
-- this month cost if I built it now". A preview cannot borrow the trigger, because
-- a preview has no run to attach lines to — `payroll_runs_period_uq` allows one run
-- per company per month, so a month that is already built cannot hold a throwaway
-- row, and 072 grants no DELETE on the run anyway (that is the append-only rule,
-- not an oversight).
--
-- So a preview would have to re-type the arithmetic in a route. That is the exact
-- way two numbers come to disagree: the preview showing one figure and the payslip
-- another, with nothing to catch it, because both would be "correct" against their
-- own copy. Instead the derivation is a function, the trigger calls it, and the
-- preview SELECT calls it — one body of maths, two readers, and the smoke asserts
-- that a preview line and the built line for the same month are identical.
--
-- No new tables, no new grants on tables, no new permissions. Nothing here changes
-- what a stored line says; it changes where the answer is computed.

begin;

-- ---------------------------------------------------------------------------
-- THE PRO-RATA
-- ---------------------------------------------------------------------------
-- Days charged are capped at the month's own working days: an approved unpaid
-- leave that spans two months carries its whole `working_days` into each rebuild,
-- and an uncapped subtraction would turn a 30-day October into a negative pay.
-- `net_amount` is rounded from the ROUNDED base, not from the raw pro-rata, so it
-- keeps agreeing with `payroll_lines`' own check
-- (net_amount = round(base_amount + adjustment_amount, 2)) to the cent.
create or replace function public.payroll_derive(
  p_salary numeric,
  p_working_days int,
  p_unpaid_leave_days int,
  p_absence_days int,
  p_adjustment numeric
) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'days_paid',        b.days,
    'base_amount',      b.base,
    'deduction_amount', round(p_salary * (p_working_days - b.days)
                              / nullif(p_working_days, 0), 2),
    'net_amount',       round(b.base + coalesce(p_adjustment, 0), 2)
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

comment on function public.payroll_derive(numeric, int, int, int, numeric) is
  'The whole payroll pro-rata: days paid, base, deduction and net from the salary, the divisor and the two chargeable day counts. Called by the line trigger on every write and by the preview read — there is no second copy.';

-- The trigger now reads the same function instead of holding the maths itself.
-- Every guard above this line in 072 is unchanged: the issued-run freeze, the
-- derived-column freeze, and the refusal to take anybody below zero.
create or replace function public.payroll_line_gate()
returns trigger language plpgsql set search_path = public as $$
declare
  v_status text;
  v_run uuid;
  v_derived jsonb;
begin
  v_run := case when tg_op = 'DELETE' then old.run_id else new.run_id end;
  select status into v_status from payroll_runs where id = v_run;

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

  -- On an update, the inputs the office may not argue with after the fact: what
  -- the contract said, and what the register counted. A correction to either is
  -- a rebuild, not a patch. The money columns are deliberately NOT listed — an
  -- adjustment is edited on a draft line, and the derivation below re-runs over
  -- it either way. (On an insert there is no old row to compare, so every
  -- column is free; the divisor is frozen from then on.)
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

  -- The row is derived, so it must derive to itself. Recomputed here rather than
  -- trusted from the caller: this is the last place the arithmetic can be checked
  -- before it becomes a payslip, and it is what makes the net_amount CHECK a belt
  -- rather than the only brace.
  v_derived := public.payroll_derive(new.monthly_salary, new.working_days,
                                     new.unpaid_leave_days, new.absence_days,
                                     new.adjustment_amount);
  new.days_paid        := (v_derived ->> 'days_paid')::int;
  new.base_amount      := (v_derived ->> 'base_amount')::numeric(14,2);
  new.deduction_amount := (v_derived ->> 'deduction_amount')::numeric(14,2);
  new.net_amount       := (v_derived ->> 'net_amount')::numeric(14,2);
  if new.net_amount < 0 then
    raise exception 'That would take % below zero, which is not a deduction — it is a debt. Record it as an adjustment with a reason.', new.employee_name
      using errcode = 'P0001';
  end if;
  return new;
end $$;

-- 072's comment described the capped subtraction loosely; the cap is the part
-- that stops a two-month leave producing a negative pay.
comment on column payroll_lines.days_paid is
  'working_days - least(working_days, unpaid_leave_days + absence_days), floored at 0. Stamped by trigger from payroll_derive, never typed.';

-- ---------------------------------------------------------------------------
-- Grants: security invoker, so the preview SELECT still reads only the tenant's
-- own roster through RLS. The function sees no tenant id and stores nothing.
-- ---------------------------------------------------------------------------
grant execute on function public.payroll_derive(numeric, int, int, int, numeric) to app_runtime;
revoke all on function public.payroll_derive(numeric, int, int, int, numeric)
  from public, anon, authenticated, service_role;

commit;
