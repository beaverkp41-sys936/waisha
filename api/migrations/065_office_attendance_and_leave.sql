-- 065: the daily loop of the office — attendance and leave, plus the HR seat.
--
-- The office already holds the roster, the tasks, the grades, the costs and the
-- trainees, but nothing in it answers the two questions a back office is asked
-- every single day: "who is in today" and "is so-and-so away next week". 056
-- put it plainly in a column comment — *nothing in the system clocks a trainee
-- in, so attendance is stated rather than computed*. Stating it is what people
-- do in a notebook today. This is the table that replaces the notebook.
--
-- The second thing this migration fixes is older than any of it. `hr_officer`
-- has been an assignable seat since the role catalogue, and it holds ZERO
-- permissions, which is fail-closed but means the person sitting in it can do
-- nothing: every leave request, correction and roster edit routes through the
-- director, who is usually the one person in a Tanzanian haulier who is on the
-- road. Granting that matrix is the difference between an office module the
-- staff use and one the boss uses alone.
--
-- Money rule honoured throughout: none. A salary figure is not touched here,
-- unpaid leave is a status not a deduction, and payroll is its own stage.

begin;

-- ---------------------------------------------------------------------------
-- One row per company: the working day the attendance clock is judged against.
-- ---------------------------------------------------------------------------
create table if not exists office_settings (
  tenant_id uuid primary key references tenants(id),
  work_start time not null default '08:00',
  work_end time not null default '17:00',
  -- Arriving inside the grace is not late. Every office has one, and a system
  -- that calls a 08:03 arrival "late" gets switched off within a week.
  late_grace_minutes int not null default 15
    check (late_grace_minutes between 0 and 120),
  -- Working days of annual leave granted per calendar year. 28 is the Tanzanian
  -- statutory minimum (ESA 2004 s.68); a company may set more, never negative.
  annual_leave_days int not null default 28
    check (annual_leave_days between 0 and 60),
  -- The wall clock lateness is judged on. Render runs its servers in UTC, so an
  -- offset-free comparison of clock_in against work_start would call the whole
  -- country three hours late; the day is read in the company's own zone instead.
  timezone text not null default 'Africa/Dar_es_Salaam',
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_office_settings_updated before update on office_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Attendance: one line per person per day, stamped by that person or by the desk.
-- ---------------------------------------------------------------------------
create table if not exists employee_attendance (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  employee_id uuid not null references employees(id),
  work_date date not null,
  clock_in timestamptz,
  -- Deliberately nullable in both directions: a day can be recorded as absent
  -- or as a holiday with no clock at all, and a half-finished line is normal at
  -- midday. Hours worked are derived on read, never stored, so a correction to
  -- either stamp cannot leave a stale total behind.
  clock_out timestamptz,
  day_status text not null default 'present'
    check (day_status in ('present','late','half_day','absent','on_leave','holiday')),
  minutes_late int check (minutes_late is null or (minutes_late >= 0 and minutes_late <= 1439)),
  note text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index employee_attendance_day_uq
  on employee_attendance (tenant_id, employee_id, work_date) where deleted_at is null;
create index idx_attendance_day on employee_attendance (tenant_id, work_date)
  where deleted_at is null;
create index idx_attendance_employee on employee_attendance (tenant_id, employee_id, work_date desc)
  where deleted_at is null;
create trigger trg_attendance_updated before update on employee_attendance
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Leave: a request, a decision, and the days it costs.
-- ---------------------------------------------------------------------------
create table if not exists leave_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  employee_id uuid not null references employees(id),
  leave_kind text not null
    check (leave_kind in ('annual','sick','bereavement','maternity','paternity','unpaid','other')),
  starts_on date not null,
  ends_on date not null,
  -- Weekdays only, counted by trigger. Public holidays are not modelled — with
  -- no holiday table in the platform, a guessed list would silently over-credit
  -- or under-credit somebody's balance, so the count says "working days" and
  -- means Monday to Friday.
  working_days int not null default 0 check (working_days between 0 and 260),
  reason text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','cancelled')),
  decided_by uuid, decided_at timestamptz, decision_note text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (ends_on >= starts_on)
);
create index idx_leave_employee on leave_requests (tenant_id, employee_id, starts_on desc)
  where deleted_at is null;
create index idx_leave_pending on leave_requests (tenant_id, status, starts_on)
  where deleted_at is null and status = 'pending';
create trigger trg_leave_updated before update on leave_requests
  for each row execute function public.set_updated_at();

-- Weekdays between two dates, inclusive. IMMUTABLE because the answer depends
-- on nothing but the two dates.
create or replace function public.working_days_between(p_from date, p_to date)
returns int language sql immutable set search_path = public as $$
  select count(*)::int
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') d
   where extract(isodow from d) between 1 and 5;
$$;
comment on function public.working_days_between(date, date) is
  'Monday–Friday days between two dates, both ends counted.';

-- Counted on write, so the balance maths never disagrees with the row.
create or replace function public.leave_stamp_working_days()
returns trigger language plpgsql set search_path = public as $$
begin
  new.working_days := public.working_days_between(new.starts_on, new.ends_on);
  return new;
end $$;
create trigger trg_leave_working_days before insert or update of starts_on, ends_on
  on leave_requests for each row execute function public.leave_stamp_working_days();

-- One person cannot be away twice. A pending request clashes too, because the
-- alternative is two requests the desk then has to reconcile by hand.
create or replace function public.leave_no_overlap()
returns trigger language plpgsql set search_path = public as $$
declare
  v_clash int;
begin
  if new.deleted_at is not null then return new; end if;
  if new.status not in ('pending','approved') then return new; end if;
  if tg_op = 'UPDATE'
     and old.starts_on = new.starts_on and old.ends_on = new.ends_on
     and old.employee_id = new.employee_id and old.status = new.status
  then
    return new;
  end if;

  select count(*) into v_clash
    from leave_requests x
   where x.tenant_id = new.tenant_id
     and x.employee_id = new.employee_id
     and x.id is distinct from new.id
     and x.deleted_at is null
     and x.status in ('pending','approved')
     and x.starts_on <= new.ends_on
     and x.ends_on >= new.starts_on;

  if v_clash > 0 then
    raise exception 'That person already has a leave request covering those dates.';
  end if;
  return new;
end $$;
create trigger trg_leave_no_overlap before insert or update
  on leave_requests for each row execute function public.leave_no_overlap();

-- A day is stamped late by the clock, not by the opinion of whoever typed it,
-- and the judgement is made against the working start as it stood that day.
create or replace function public.attendance_stamp_lateness()
returns trigger language plpgsql set search_path = public as $$
declare
  v_start time;
  v_grace int;
  v_zone text;
begin
  if new.deleted_at is not null then return new; end if;
  if new.clock_in is null then return new; end if;
  if tg_op = 'UPDATE' and old.clock_in = new.clock_in and old.work_date = new.work_date
  then
    return new;
  end if;

  select s.work_start, s.late_grace_minutes, s.timezone
    into v_start, v_grace, v_zone
    from office_settings s where s.tenant_id = new.tenant_id;
  if v_start is null then
    v_start := '08:00';
    v_grace := 15;
    v_zone := 'Africa/Dar_es_Salaam';
  end if;

  -- timezone(zone, timestamptz) gives the wall clock over there, which is the
  -- only clock a work_start of 08:00 can possibly mean.
  new.minutes_late := greatest(0,
    floor(extract(epoch from ((timezone(v_zone, new.clock_in))::time - v_start)) / 60)::int
      - coalesce(v_grace, 15));
  if new.minutes_late > 0 and new.day_status = 'present' then
    new.day_status := 'late';
  end if;
  return new;
end $$;
create trigger trg_attendance_lateness before insert or update of clock_in, work_date
  on employee_attendance for each row execute function public.attendance_stamp_lateness();

-- You cannot record a day that has not happened. The guard reads the day as the
-- company's own wall clock sees it, not the server's: Render runs in UTC and
-- Tanzania sits three hours ahead of it, so between midnight and 03:00 local the
-- UTC date is still yesterday and a genuine clock-in would be refused as a day
-- that "has not arrived yet".
create or replace function public.attendance_no_future()
returns trigger language plpgsql set search_path = public as $$
declare
  v_zone text;
  v_today date;
begin
  if new.deleted_at is not null then return new; end if;
  select s.timezone into v_zone from office_settings s where s.tenant_id = new.tenant_id;
  v_today := (timezone(coalesce(v_zone, 'Africa/Dar_es_Salaam'), now()))::date;
  if new.work_date > v_today then
    raise exception 'Nobody can be clocked in for a day that has not arrived yet.';
  end if;
  return new;
end $$;
create trigger trg_attendance_no_future before insert or update of work_date
  on employee_attendance for each row execute function public.attendance_no_future();

-- ---------------------------------------------------------------------------
-- POLICY + GRANT together (016 lesson). No DELETE on any of the three: a wrong
-- attendance line is corrected, a leave request is cancelled — both stay on
-- record, which is the point of keeping them at all.
-- ---------------------------------------------------------------------------
alter table office_settings enable row level security;
create policy office_settings_tenant on office_settings for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on office_settings to app_runtime;

alter table employee_attendance enable row level security;
create policy employee_attendance_tenant on employee_attendance for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on employee_attendance to app_runtime;

alter table leave_requests enable row level security;
create policy leave_requests_tenant on leave_requests for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on leave_requests to app_runtime;

grant execute on function public.working_days_between(date, date) to app_runtime;

comment on column employee_attendance.minutes_late is
  'Stamped by the trigger against office_settings.work_start at the moment of the clock-in; never recomputed afterwards.';
comment on column leave_requests.working_days is
  'Monday–Friday days, stamped on write. Public holidays are not modelled.';

-- ---------------------------------------------------------------------------
-- Permission keys, then the two matrices that matter.
-- ---------------------------------------------------------------------------
insert into permissions (key, description)
values
  ('attendance.view', 'Attendance - View the register'),
  ('attendance.clock', 'Attendance - Clock in and out'),
  ('attendance.edit', 'Attendance - Correct any day'),
  ('leave.view', 'Leave - View requests and balances'),
  ('leave.request', 'Leave - Request time off'),
  ('leave.decide', 'Leave - Approve or refuse a request'),
  ('office_settings.manage', 'Office - Set the working day and leave entitlement')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'attendance.%' or p.key like 'leave.%' or p.key = 'office_settings.manage'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('attendance.view', 'leave.view')
where r.key = 'auditor' and r.tenant_id is null
on conflict do nothing;

-- The seat that has been empty of function until now. An HR officer runs the
-- people side of the office: the roster, the assignments, the grades, the daily
-- register and the leave queue. Not the money, and not the delete keys — a
-- person who leaves the company takes that with the director.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in (
  'employees.view', 'employees.create', 'employees.edit',
  'office_tasks.view', 'office_tasks.create', 'office_tasks.edit',
  'evaluations.view', 'evaluations.create',
  'attendance.view', 'attendance.clock', 'attendance.edit',
  'leave.view', 'leave.request', 'leave.decide',
  'office_settings.manage'
)
where r.key = 'hr_officer' and r.tenant_id is null
on conflict do nothing;

-- Everyone else who signs in at a desk can clock themselves in and ask for leave.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('attendance.clock', 'leave.request', 'leave.view', 'attendance.view')
where r.key in ('general_manager', 'operations_manager', 'finance_officer', 'dispatcher',
                'checkpoint_clerk', 'workshop_manager', 'customer_service', 'fleet_manager')
  and r.tenant_id is null
on conflict do nothing;

commit;
