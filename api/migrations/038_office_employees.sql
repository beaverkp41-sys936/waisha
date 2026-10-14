-- 038: Office / Employees Management — the HR side of the back office. The
-- staff roster (skills, employment type, contract dates, optional supervisor
-- for interns), daily office task assignments linked to cargo files with
-- priorities and deadlines, and monthly performance evaluations across the
-- four graded dimensions. Feeds the task leaderboard, contract renewal alerts
-- and the calendar; contract scans live in the documents vault.
begin;

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  full_name text not null,
  phone_encrypted bytea,
  phone_search text,
  job_title text,
  department text,
  skills text[] not null default '{}',
  employment_type text not null default 'permanent'
    check (employment_type in ('permanent','fixed_term','intern')),
  status text not null default 'active' check (status in ('active','inactive','left')),
  hired_date date,
  contract_start date,
  contract_end date,
  -- Interns carry the staff member who supervises them.
  supervisor_id uuid references employees(id),
  -- Set when an intern is taken on as staff, so the trainees register keeps
  -- the history after employment_type moves to permanent/fixed_term.
  intern_absorbed boolean not null default false,
  monthly_salary numeric(14,2),
  -- Optional link to a portal account, for employees who sign in.
  user_id uuid references users(id),
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_employees_tenant on employees (tenant_id);
create index idx_employees_status on employees (tenant_id, status) where deleted_at is null;
create index idx_employees_contract_end on employees (tenant_id, contract_end)
  where deleted_at is null and contract_end is not null;
create trigger trg_employees_updated before update on employees
  for each row execute function public.set_updated_at();

create table if not exists office_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  employee_id uuid not null references employees(id),
  -- Assignments are usually about a cargo file; general chores leave it null.
  shipment_id uuid references cargo_shipments(id),
  title text not null,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  due_date date,
  status text not null default 'pending'
    check (status in ('pending','in_progress','done','cancelled')),
  done_at timestamptz,
  -- Whether the task was completed by its deadline; drives punctuality grades.
  on_time boolean,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_office_tasks_employee on office_tasks (tenant_id, employee_id, status);
create index idx_office_tasks_due on office_tasks (tenant_id, status, due_date);
create trigger trg_office_tasks_updated before update on office_tasks
  for each row execute function public.set_updated_at();

create table if not exists employee_evaluations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  employee_id uuid not null references employees(id),
  -- First day of the evaluated month; one evaluation per employee per month.
  period date not null,
  task_completion smallint not null check (task_completion between 1 and 5),
  punctuality smallint not null check (punctuality between 1 and 5),
  client_satisfaction smallint not null check (client_satisfaction between 1 and 5),
  collaboration smallint not null check (collaboration between 1 and 5),
  notes text,
  evaluated_by uuid,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index employee_evaluations_period_uq on employee_evaluations (tenant_id, employee_id, period)
  where deleted_at is null;
create index idx_employee_evaluations_employee on employee_evaluations (tenant_id, employee_id, period desc);
create trigger trg_employee_evaluations_updated before update on employee_evaluations
  for each row execute function public.set_updated_at();

-- POLICY + GRANT together (016 lesson)
alter table employees enable row level security;
create policy employees_tenant on employees for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on employees to app_runtime;

alter table office_tasks enable row level security;
create policy office_tasks_tenant on office_tasks for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on office_tasks to app_runtime;

alter table employee_evaluations enable row level security;
create policy employee_evaluations_tenant on employee_evaluations for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on employee_evaluations to app_runtime;

-- Documents vault: contract scans attach under entity_type 'employee'.
alter table documents drop constraint documents_entity_type_check;
alter table documents add constraint documents_entity_type_check
  check (entity_type in ('tenant','user','vessel','driver','trip','shipment','message','licence','employee'));
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check
  check (kind in ('logo','avatar','licence','insurance','inspection','road_licence',
                  'delivery_note','invoice','bill_of_lading','packing_list','contract','other','attachment'));

-- Permission keys for the module.
insert into permissions (key, description)
values
  ('employees.view', 'Employees - View roster'),
  ('employees.create', 'Employees - Add employees'),
  ('employees.edit', 'Employees - Edit employees'),
  ('employees.delete', 'Employees - Remove employees'),
  ('office_tasks.view', 'Office Tasks - View assignments'),
  ('office_tasks.create', 'Office Tasks - Assign tasks'),
  ('office_tasks.edit', 'Office Tasks - Update task status'),
  ('office_tasks.delete', 'Office Tasks - Delete tasks'),
  ('evaluations.view', 'Evaluations - View evaluations'),
  ('evaluations.create', 'Evaluations - Record evaluations'),
  ('evaluations.edit', 'Evaluations - Edit evaluations'),
  ('evaluations.delete', 'Evaluations - Delete evaluations')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'employees.%' or p.key like 'office_tasks.%' or p.key like 'evaluations.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('employees.view', 'office_tasks.view', 'evaluations.view')
where r.key = 'auditor' and r.tenant_id is null
on conflict do nothing;

commit;
