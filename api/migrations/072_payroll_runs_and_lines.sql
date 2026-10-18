-- 072 — the payroll run (Office Stage B, task #113).
--
-- The office already knows who is on the roster (038), who turned up (065) and who was
-- away on approved leave (065). What it cannot do today is turn those three facts into
-- the one document a back office has to produce every month, so the figure is worked out
-- in a spreadsheet and typed back into the system afterwards — which is the moment the
-- number stops being traceable to anything.
--
-- This migration makes the run a DERIVED document. Nobody types a payslip figure: the
-- line is built by one SELECT over the roster, the attendance register and the approved
-- leave, from the salary that stood on the employee row at build time, and the run's
-- three totals foot from its own lines. The consolidator rule (055) applied to money —
-- weight on board was never typed, and neither is net pay.
--
-- ============================
-- WHAT MAY COST A DAY, AND WHAT MAY NOT
-- ============================
--
-- A day is deducted for exactly two reasons, because those are the only two the office
-- has actually decided on:
--
--   1. unpaid leave that has been APPROVED — `leave_requests` with
--      `leave_kind = 'unpaid'` and `status = 'approved'`, counted in working days;
--   2. an absence somebody recorded — `employee_attendance.day_status = 'absent'`.
--
-- Everything else is shown and costs nothing. `half_day`, `late`, `holiday` and
-- `on_leave` are statuses, not decisions to take money; and a working day with NO row
-- at all is an unrecorded day, not an absent one — the difference is the whole reason
-- `unrecorded_days` is a column. A clerk forgetting to clock four people in must not
-- become four days lost from their pay, and the register says so on the payslip instead
-- of hiding it. An office that wants those days charged marks them `absent` first, which
-- is the auditable act.
--
-- ============================
-- STATUTORY DEDUCTIONS ARE NOT COMPUTED HERE
-- ============================
--
-- PAYE bands, NSSF/social-security percentages and levy rates are set by law and change.
-- This system has no access to them and must not guess: a wrong bracket is a penalty the
-- company pays, and a rate frozen in a migration goes silently out of date. 052 seeded
-- only the three duty rates it could cite (VAT 18 %, RDL 2 %, CPF IDF 0.6 %) and invented
-- nothing; the same rule applies here, so a line carries one manual `adjustment_amount`
-- with its own label and reason — entered by the person who is responsible for the
-- figure, stored to the cent, and visible in the audit trail beside whoever entered it.
-- The system does the attendance maths, which it can actually see, and leaves the law to
-- the office.
--
-- ============================
-- MONEY IS RECORDED, NEVER COLLECTED
-- ============================
--
-- No provider, no API call, no credentials, no card or mobile-money PIN in any column.
-- What a run stores about payment is a free-text reference a person typed after the fact
-- and a date. Amounts are `numeric(14,2)` with an explicit currency, never floats, and
-- every CHECK that guards them is declared in the table so a route that forgets one is
-- refused by the database rather than by a reviewer.
--
-- ============================
-- APPEND-ONLY ONCE ISSUED
-- ============================
--
-- A draft is a working document: lines are rebuilt, people are added and removed, the
-- period is corrected. An issued run is the record that people were paid, so its lines
-- are frozen by trigger, its period is frozen, and the only way out is `cancelled` with
-- a named person, a timestamp and a reason — never back to draft, never edited. There is
-- no DELETE on `payroll_runs` at all: a run that should not exist is cancelled and stays
-- in the register, because a deleted payroll run is precisely what an auditor asks about.
-- `payroll_lines` does carry DELETE, gated by the same trigger to drafts, and it is the
-- only hard delete in the module — dropping one person from a run that has not been
-- issued yet is a correction, not a loss of record.
--
-- ============================
-- WHO MAY RUN PAYROLL
-- ============================
--
-- `payroll.view` / `payroll.run` / `payroll.issue` go to the director and to
-- `finance_officer`. `auditor` gets the view and nothing else. Deliberately NOT
-- `hr_officer`, even though 065 gave that seat the roster, the register and the leave
-- queue: the person who approves whose leave is requested should not also be the person
-- who turns attendance into money. That is a segregation-of-duties choice, not an
-- oversight, and it is written here so nobody "helpfully" adds it later.

begin;

-- ---------------------------------------------------------------------------
-- One run per company per month. `period` is the first day of the month, which
-- is how 038's evaluations already key a period, so the two align on a date
-- rather than on a name like "October".
-- ---------------------------------------------------------------------------
create table if not exists payroll_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  period date not null check (date_trunc('month', period) = period),
  currency text not null default 'TZS' check (currency = 'TZS'),
  status text not null default 'draft'
    check (status in ('draft','issued','cancelled')),
  -- Mon–Fri days in the month, stamped at build. The divisor for every pro-rata
  -- in the run: it is stored so a rebuild in December pays out the same October
  -- figure it paid in November, and so two lines built weeks apart cannot
  -- disagree about what a day was worth.
  working_days int not null check (working_days between 15 and 27),
  gross_total numeric(14,2) not null default 0 check (gross_total >= 0),
  deduction_total numeric(14,2) not null default 0 check (deduction_total >= 0),
  adjustment_total numeric(14,2) not null default 0,
  net_total numeric(14,2) not null default 0 check (net_total >= 0),
  headcount int not null default 0 check (headcount >= 0),
  -- Typed after the fact by whoever actually moved the money. A reference string,
  -- nothing more — see the money rule above.
  payment_reference text,
  paid_on date,
  note text,
  issued_by uuid, issued_at timestamptz,
  cancelled_by uuid, cancelled_at timestamptz, cancel_reason text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index payroll_runs_period_uq on payroll_runs (tenant_id, period)
  where deleted_at is null;
create index payroll_runs_status_idx on payroll_runs (tenant_id, status, period desc)
  where deleted_at is null;

create trigger trg_payroll_runs_updated before update on payroll_runs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- One line per person per run. Everything here is either copied from the roster
-- at build time or derived; nothing is a total of anything else in the same row
-- except net_amount, which the CHECK below forces to agree.
-- ---------------------------------------------------------------------------
create table if not exists payroll_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  run_id uuid not null references payroll_runs(id) on delete cascade,
  employee_id uuid not null references employees(id),
  -- Copied, never joined: an edit to the roster after issue must not rewrite a
  -- payslip that has already been handed over.
  employee_name text not null,
  job_title text,
  department text,
  monthly_salary numeric(14,2) not null check (monthly_salary >= 0),
  currency text not null default 'TZS' check (currency = 'TZS'),
  working_days int not null check (working_days between 15 and 27),

  -- The two things that can cost a day, and the two things that cannot.
  unpaid_leave_days int not null default 0 check (unpaid_leave_days >= 0),
  absence_days int not null default 0 check (absence_days >= 0),
  unrecorded_days int not null default 0 check (unrecorded_days >= 0),
  half_days int not null default 0 check (half_days >= 0),
  late_minutes int not null default 0 check (late_minutes >= 0),
  -- Held on the row so the arithmetic is inspectable without re-reading the
  -- register, and so a reviewer can see a negative pro-rata before it ships.
  days_paid int not null check (days_paid >= 0),

  base_amount numeric(14,2) not null check (base_amount >= 0),
  deduction_amount numeric(14,2) not null default 0 check (deduction_amount >= 0),
  -- The manual block. Labelled so the figure is never a mystery on the slip.
  adjustment_amount numeric(14,2) not null default 0,
  adjustment_label text,
  net_amount numeric(14,2) not null check (net_amount >= 0),

  -- The dates that were charged, so a disputed line can be settled by looking
  -- rather than by arguing from a status count.
  detail jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The row must add up. Re-checked on every write by trigger because a CHECK
  -- alone would pass a route that recomputes base and forgets deduction.
  check (net_amount = round(base_amount + adjustment_amount, 2))
);

create unique index payroll_lines_employee_uq on payroll_lines (run_id, employee_id);
create index payroll_lines_run_idx on payroll_lines (run_id);
create index payroll_lines_employee_hist_idx on payroll_lines (tenant_id, employee_id);

create trigger trg_payroll_lines_updated before update on payroll_lines
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- WORKING DAYS IN A PERIOD
-- ---------------------------------------------------------------------------
-- Same Monday–Friday definition 065 counted leave against, so the divisor in the
-- pro-rata and the counter in a leave balance cannot drift apart. IMMUTABLE: the
-- answer depends on nothing but the date.
create or replace function public.period_working_days(p_period date)
returns int language sql immutable set search_path = public as $$
  select count(*)::int
    from generate_series(
           date_trunc('month', p_period)::timestamp,
           (date_trunc('month', p_period) + interval '1 month - 1 day')::timestamp,
           interval '1 day') d
   where extract(isodow from d) between 1 and 5;
$$;
comment on function public.period_working_days(date) is
  'Monday–Friday days in the month containing p_period. The same vocabulary 065 counts leave in.';

-- ---------------------------------------------------------------------------
-- THE RUN CANNOT BE UN-RUN
-- ---------------------------------------------------------------------------
-- One gate for every mutation of a run row, rather than a rule per route: the
-- 061 trigger lesson is that a guard which lives only in one handler is a guard
-- the next handler forgets.
create or replace function public.payroll_run_gate()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.deleted_at is not null then
    return new;
  end if;

  if tg_op = 'UPDATE' and old.status = 'issued' then
    if new.status = 'cancelled' then
      -- Cancelling is a decision with a name on it, not a cleanup.
      if new.cancelled_by is null or new.cancel_reason is null
         or btrim(new.cancel_reason) = '' then
        raise exception 'An issued run is cancelled by a person, with a reason.'
          using errcode = 'P0001';
      end if;
      return new;
    end if;
    -- Everything below is compared against the stored row, so an issued run is
    -- frozen whatever route or role tries to move it.
    if new.status <> 'issued' then
      raise exception 'An issued payroll run cannot be reopened. Cancel it and build a new one.'
        using errcode = 'P0001';
    end if;
    if new.period <> old.period or new.working_days <> old.working_days then
      raise exception 'An issued payroll run cannot be re-based on another period.'
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.status = 'issued' then
    if old.status = 'cancelled' then
      raise exception 'A cancelled payroll run cannot be issued. Build a new one.'
        using errcode = 'P0001';
    end if;
    if (select count(*) from payroll_lines where run_id = new.id) = 0 then
      raise exception 'There is nobody in this run to issue.'
        using errcode = 'P0001';
    end if;
    new.issued_at := now();
  end if;

  return new;
end $$;

create trigger trg_payroll_run_gate before update on payroll_runs
  for each row execute function public.payroll_run_gate();

-- A run is created as a draft and nothing else: issuing is an UPDATE, so a route
-- cannot open a document already stamped as paid.
create or replace function public.payroll_run_starts_draft()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status <> 'draft' then
    raise exception 'A payroll run starts as a draft.'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger trg_payroll_run_starts_draft before insert on payroll_runs
  for each row execute function public.payroll_run_starts_draft();

-- ---------------------------------------------------------------------------
-- LINES ARE FROZEN WHEN THE RUN IS ISSUED
-- ---------------------------------------------------------------------------
create or replace function public.payroll_line_gate()
returns trigger language plpgsql set search_path = public as $$
declare
  v_status text;
  v_run uuid;
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
  -- adjustment is edited on a draft line, and the arithmetic below re-runs over
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
  -- before it becomes a payslip, and it is what makes the net_amount CHECK below
  -- a belt rather than the only brace.
  --
  -- Charged days are capped at the month's own working days. A line can arrive
  -- with more leave days than days in the month — an approved unpaid leave that
  -- spans two months carries its whole `working_days` into each rebuild — and an
  -- uncapped subtraction would turn a 30-day October into a negative pay.
  new.days_paid := greatest(0, new.working_days
                            - least(new.working_days,
                                    new.unpaid_leave_days + new.absence_days));
  new.base_amount := round(new.monthly_salary * new.days_paid
                           / nullif(new.working_days, 0), 2);
  new.deduction_amount := round(new.monthly_salary
                                * (new.working_days - new.days_paid)
                                / nullif(new.working_days, 0), 2);
  new.net_amount := round(new.base_amount + new.adjustment_amount, 2);
  if new.net_amount < 0 then
    raise exception 'That would take % below zero, which is not a deduction — it is a debt. Record it as an adjustment with a reason.', new.employee_name
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger trg_payroll_line_gate before insert or update or delete on payroll_lines
  for each row execute function public.payroll_line_gate();

-- ---------------------------------------------------------------------------
-- THE RUN FOOTS FROM ITS LINES
-- ---------------------------------------------------------------------------
-- After the line moves, so it sums what actually landed. Touches only the total
-- columns, which the gates above leave open in a draft.
create or replace function public.payroll_run_roll_up()
returns trigger language plpgsql set search_path = public as $$
declare
  v_run uuid;
begin
  v_run := case when tg_op = 'DELETE' then old.run_id else new.run_id end;
  update payroll_runs r set
    gross_total = coalesce((select sum(base_amount) from payroll_lines
                             where run_id = v_run), 0),
    deduction_total = coalesce((select sum(deduction_amount) from payroll_lines
                             where run_id = v_run), 0),
    adjustment_total = coalesce((select sum(adjustment_amount) from payroll_lines
                             where run_id = v_run), 0),
    net_total = coalesce((select sum(net_amount) from payroll_lines
                             where run_id = v_run), 0),
    headcount = (select count(*)::int from payroll_lines where run_id = v_run)
  where r.id = v_run and r.status = 'draft';
  return null;
end $$;

create trigger trg_payroll_run_roll_up after insert or update or delete on payroll_lines
  for each row execute function public.payroll_run_roll_up();

-- ---------------------------------------------------------------------------
-- POLICY + GRANT together (016 lesson). No DELETE on the run: a payroll that
-- should not have happened is cancelled, and stays in the register.
-- ---------------------------------------------------------------------------
alter table payroll_runs enable row level security;
create policy payroll_runs_tenant on payroll_runs for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on payroll_runs to app_runtime;

alter table payroll_lines enable row level security;
create policy payroll_lines_tenant on payroll_lines for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on payroll_lines to app_runtime;

grant execute on function public.period_working_days(date) to app_runtime;

-- ---------------------------------------------------------------------------
-- Permission keys and the matrix. See the segregation note in the header for why
-- hr_officer is absent.
-- ---------------------------------------------------------------------------
insert into permissions (key, description)
values
  ('payroll.view',  'Payroll - View runs, lines and payslips'),
  ('payroll.run',   'Payroll - Build and edit a draft run'),
  ('payroll.issue', 'Payroll - Issue a run, and cancel one')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('payroll.view', 'payroll.run', 'payroll.issue')
where r.key in ('director', 'finance_officer') and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key = 'payroll.view'
where r.key = 'auditor' and r.tenant_id is null
on conflict do nothing;

comment on table payroll_runs is
  'One derived payroll document per company per month. Totals foot from payroll_lines and are never typed.';
comment on column payroll_runs.working_days is
  'Mon–Fri days in the period, stamped at build so a later rebuild pays the same figure.';
comment on column payroll_runs.payment_reference is
  'A reference a person typed after paying. No provider, no credentials, nothing collected.';
comment on column payroll_lines.monthly_salary is
  'Copied from employees at build time. Editing the roster never rewrites an issued payslip.';
comment on column payroll_lines.unrecorded_days is
  'Working days with no attendance row at all. Shown on the slip, charged nothing — an unclocked day is a missing record, not an absence.';
comment on column payroll_lines.days_paid is
  'working_days - unpaid_leave_days - absence_days, floored at 0. Stamped by trigger, never typed.';
comment on column payroll_lines.adjustment_amount is
  'The manual block — statutory deductions included. Nothing here computes PAYE or social security; a rate guessed in a migration goes silently wrong.';

commit;
