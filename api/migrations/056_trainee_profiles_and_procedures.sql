-- 056: Office / Trainee architecture (masterprompt Part 3) — three things on top
-- of the 038 roster: the personnel profile fields a trainee intake form collects,
-- a procedural mapping engine that puts a step-by-step flow with a mandatory
-- checklist behind every office task, and the signed trainee completion report.
--
-- Deliberate calls:
--   * "Full legal name, strictly as registered on NIDA" reuses employees.full_name
--     rather than adding a second name column — every existing screen already
--     reads it, and one person should not have two names in one register. No NIDA
--     number is collected: the form needs the name, not the identifier, so the
--     module stays out of the national-ID PII business entirely.
--   * Age is derived from date_of_birth and never stored.
--   * The profile photo is a documents row (entity_type 'employee', kind
--     'avatar'), so the vault keeps its single upload path. The 1 MB cap the spec
--     asks for is enforced client-side in the form; the shared 8 MB server limit
--     is untouched so no other module's uploads change behaviour.
--   * A trainee's period is the 038 contract_start / contract_end pair — the same
--     dates the renewal alert already reads.
--   * Procedures are seeded global (tenant_id null: readable by everyone,
--     untouchable by the app role) and copyable into a tenant — the 052
--     charge_catalog shape, with the split read/insert/update policies it uses.
--   * A step's mandatory checklist is materialized into rows when a task takes a
--     procedure, the same way 042 copies stage templates into job_stages. The
--     template keeps text[] arrays; the instance keeps normalized rows, because
--     ticking is per item and needs its own stamp.
--   * Gating lives in triggers, not only in the routes: "checked off before a
--     task status can advance" is an invariant the data must hold even when a
--     route forgets.
begin;

-- ---------- 1. Personnel profile (additive on employees) ----------
alter table employees add column if not exists date_of_birth date;
alter table employees add column if not exists gender text;
alter table employees add column if not exists academic_status text;
alter table employees add column if not exists college text;
alter table employees add column if not exists qualifications text[] not null default '{}';
alter table employees add column if not exists emergency_contact_name text;
alter table employees add column if not exists emergency_relationship text;
-- Same shape as the stored phone: encrypted value plus its search hash.
alter table employees add column if not exists emergency_phone_encrypted bytea;
alter table employees add column if not exists emergency_phone_search text;

-- A CHECK cannot call current_date, so "not yet born" is the route's problem;
-- these only pin the vocabularies the form offers.
alter table employees add constraint employees_gender_check
  check (gender in ('male','female','other'));
alter table employees add constraint employees_academic_status_check
  check (academic_status in ('student','graduate'));

-- ---------- 2. Procedure library ----------
create table if not exists task_procedures (
  id uuid primary key default gen_random_uuid(),
  -- Null = a system default shipped by the migration and readable by all.
  tenant_id uuid references tenants(id),
  name text not null,
  description text,
  scope text not null default 'office' check (scope in ('office','cargo')),
  is_active boolean not null default true,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index task_procedures_global_uq on task_procedures (lower(name))
  where deleted_at is null and tenant_id is null;
create unique index task_procedures_tenant_uq on task_procedures (tenant_id, lower(name))
  where deleted_at is null and tenant_id is not null;
create index idx_task_procedures_scope on task_procedures (scope, is_active)
  where deleted_at is null;

create table if not exists task_procedure_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  procedure_id uuid not null references task_procedures(id),
  seq smallint not null,
  name text not null,
  instructions text,
  -- The milestones that must be ticked, and the paperwork among them. Both are
  -- vocabulary the instance turns into checkable rows.
  checklist text[] not null default '{}',
  required_documents text[] not null default '{}',
  -- Marks the end of the flow: Initiation/Start is seq 1, this is Final Sign-off.
  is_final boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index task_procedure_steps_uq on task_procedure_steps (procedure_id, seq)
  where deleted_at is null;
create index idx_task_procedure_steps_lookup on task_procedure_steps (procedure_id, seq)
  where deleted_at is null;
alter table task_procedure_steps add constraint task_procedure_steps_seq_range
  check (seq between 1 and 25);

-- ---------- 3. Task -> procedure, and the per-task instances ----------
-- office_tasks is hard-delete and carries no deleted_at (038), so the instance
-- rows ride along with the task instead of soft-dying beside it.
alter table office_tasks add column if not exists procedure_id uuid references task_procedures(id);
create index if not exists idx_office_tasks_procedure on office_tasks (procedure_id)
  where procedure_id is not null;

create table if not exists office_task_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  office_task_id uuid not null references office_tasks(id) on delete cascade,
  seq smallint not null,
  name text not null,
  instructions text,
  is_final boolean not null default false,
  status text not null default 'not_started'
    check (status in ('not_started','in_progress','blocked','done')),
  blocked_reason text,
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index office_task_steps_uq on office_task_steps (office_task_id, seq);
create index idx_office_task_steps_task on office_task_steps (office_task_id, seq);
create index idx_office_task_steps_tenant_status on office_task_steps (tenant_id, status);
alter table office_task_steps add constraint office_task_steps_seq_range
  check (seq between 1 and 25);
alter table office_task_steps add constraint office_task_steps_blocked_reason
  check (status <> 'blocked' or (blocked_reason is not null and length(trim(blocked_reason)) > 0));
alter table office_task_steps add constraint office_task_steps_done_stamp
  check (status <> 'done' or completed_at is not null);

create table if not exists office_task_step_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  step_id uuid not null references office_task_steps(id) on delete cascade,
  seq smallint not null,
  label text not null,
  -- A document milestone: the paperwork the spec names (slips, declarations,
  -- proforma invoices, physical attachments). doc_kind speaks the vault's own
  -- vocabulary, which is why no documents widening is needed here.
  requires_document boolean not null default false,
  doc_kind text,
  ticked_at timestamptz,
  ticked_by uuid,
  evidence text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index office_task_step_checks_uq on office_task_step_checks (step_id, seq);
create index idx_office_task_step_checks_step on office_task_step_checks (step_id, ticked_at);
alter table office_task_step_checks add constraint office_task_step_checks_tick_stamp
  check (ticked_at is null or ticked_by is not null);

-- ---------- 4. Trainee completion report ----------
create table if not exists trainee_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  employee_id uuid not null references employees(id),
  period_start date not null,
  period_end date not null,
  -- draft while the sign-off block is still filling up, complete once it is full.
  status text not null default 'draft' check (status in ('draft','complete')),
  -- Stamped at generation so the paper does not rewrite itself while the
  -- underlying tasks keep moving — the report is a document, not a view.
  tasks_total int not null default 0,
  tasks_done int not null default 0,
  tasks_on_time int not null default 0,
  grade_task_completion smallint,
  grade_punctuality smallint,
  grade_client_satisfaction smallint,
  grade_collaboration smallint,
  task_overview text,
  -- Nothing in the system clocks a trainee in, so attendance is stated rather
  -- than computed. Deriving it from a door reader would be pretending.
  attendance_note text,
  supervisor_remarks text,
  generated_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index trainee_reports_period_uq on trainee_reports
  (tenant_id, employee_id, period_start, period_end) where deleted_at is null;
create index idx_trainee_reports_employee on trainee_reports (tenant_id, employee_id, period_start desc)
  where deleted_at is null;
alter table trainee_reports add constraint trainee_reports_period_order
  check (period_end > period_start);
-- NULL satisfies a CHECK, so one ranged constraint grades all four dimensions
-- and still lets an unsigned report carry none of them.
alter table trainee_reports add constraint trainee_reports_grade_range
  check (grade_task_completion between 1 and 5
     and grade_punctuality between 1 and 5
     and grade_client_satisfaction between 1 and 5
     and grade_collaboration between 1 and 5);

create table if not exists trainee_report_signoffs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  report_id uuid not null references trainee_reports(id) on delete cascade,
  role text not null check (role in ('hod','hr_manager','direct_supervisor')),
  signatory_name text not null,
  signatory_title text,
  -- Set when the signer has a portal account; a wet signature leaves it null.
  signed_by uuid references users(id),
  note text,
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index trainee_report_signoffs_uq on trainee_report_signoffs (report_id, role);

-- ---------- 5. Gates ----------
-- Steps: born closed-off, closed only by the checklist, and only in order.
create or replace function platform_auth.office_task_step_gate() returns trigger
language plpgsql as $$
declare
  v_open int;
  v_earlier int;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'not_started' then
      raise exception 'a procedural step is created not_started and closed through its own endpoint';
    end if;
    return new;
  end if;

  if new.status = old.status then
    return new;
  end if;

  if new.status in ('in_progress','done') then
    select count(*) into v_earlier from public.office_task_steps s
      where s.office_task_id = new.office_task_id and s.seq < new.seq and s.status <> 'done';
    if new.status = 'done' and v_earlier > 0 then
      raise exception 'step % cannot close while % earlier step(s) are still open', new.seq, v_earlier;
    end if;
  end if;

  if new.status = 'done' then
    select count(*) into v_open from public.office_task_step_checks c
      where c.step_id = new.id and c.ticked_at is null;
    if v_open > 0 then
      raise exception 'step % still has % unchecked item(s) on its checklist', new.seq, v_open;
    end if;
    if new.completed_at is null then
      new.completed_at := now();
    end if;
  end if;

  if new.status = 'in_progress' and new.started_at is null then
    new.started_at := now();
  end if;
  if new.status = 'not_started' then
    new.started_at := null;
    new.completed_at := null;
    new.completed_by := null;
    new.blocked_reason := null;
  end if;
  return new;
end $$;

-- Checks: a closed step does not quietly reopen itself under an item.
create or replace function platform_auth.office_task_check_gate() returns trigger
language plpgsql as $$
declare
  v_status text;
begin
  if old.ticked_at is null or new.ticked_at is not null then
    return new;
  end if;
  select s.status into v_status from public.office_task_steps s where s.id = new.step_id;
  if v_status = 'done' then
    raise exception 'this step is closed; reopen it before unchecking its items';
  end if;
  return new;
end $$;

-- Tasks: the flow indicator ends at Final Sign-off, so status cannot outrun it.
create or replace function platform_auth.office_task_gate() returns trigger
language plpgsql as $$
declare
  v_open int;
begin
  if tg_op = 'UPDATE' and new.status = 'done' and old.status <> 'done' then
    select count(*) into v_open from public.office_task_steps s
      where s.office_task_id = new.id and s.status <> 'done';
    if v_open > 0 then
      raise exception 'task still has % open procedural step(s); Final Sign-off closes the flow', v_open;
    end if;
  end if;
  return new;
end $$;

-- Reports: three signatures, remarks written, period closed.
create or replace function platform_auth.trainee_report_gate() returns trigger
language plpgsql as $$
declare
  v_signed int;
begin
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'a completion report is generated as a draft and signed afterwards';
  end if;
  if new.status <> 'complete' then
    return new;
  end if;
  select count(*) into v_signed from public.trainee_report_signoffs s where s.report_id = new.id;
  if v_signed < 3 then
    raise exception 'the report needs all three sign-offs — HOD, HR Manager and Direct Supervisor; % present', v_signed;
  end if;
  if new.supervisor_remarks is null or length(trim(new.supervisor_remarks)) = 0 then
    raise exception 'a report is signed off only after the supervisor remarks are written';
  end if;
  if new.period_end > current_date then
    raise exception 'the training period is still open';
  end if;
  if new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end $$;

-- A closed, signed report is paper: no edits, no erased signatures.
create or replace function platform_auth.trainee_signoff_gate() returns trigger
language plpgsql as $$
declare
  v_report uuid;
  v_status text;
begin
  v_report := case when tg_op = 'DELETE' then old.report_id else new.report_id end;
  select r.status into v_status from public.trainee_reports r where r.id = v_report;
  if v_status = 'complete' then
    raise exception '% is immutable once the report is signed off', tg_table_name;
  end if;
  return coalesce(new, old);
end $$;

create trigger trg_office_task_steps_gate before insert or update on office_task_steps
  for each row execute function platform_auth.office_task_step_gate();
create trigger trg_office_task_step_checks_gate before update on office_task_step_checks
  for each row execute function platform_auth.office_task_check_gate();
create trigger trg_office_tasks_gate before update on office_tasks
  for each row execute function platform_auth.office_task_gate();
create trigger trg_trainee_reports_gate before insert or update on trainee_reports
  for each row execute function platform_auth.trainee_report_gate();
create trigger trg_trainee_report_signoffs_gate before update or delete on trainee_report_signoffs
  for each row execute function platform_auth.trainee_signoff_gate();

-- ---------- RLS + grants (POLICY + GRANT together, 016 lesson) ----------
-- Global procedures read like the 052 catalog: every write policy demands a
-- tenant match, which NULL can never satisfy, so the shipped defaults are
-- untouchable from the app role.
alter table task_procedures enable row level security;
create policy task_procedures_read on task_procedures for select to app_runtime
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy task_procedures_insert on task_procedures for insert to app_runtime
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy task_procedures_update on task_procedures for update to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on task_procedures to app_runtime;

alter table task_procedure_steps enable row level security;
create policy task_procedure_steps_read on task_procedure_steps for select to app_runtime
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy task_procedure_steps_insert on task_procedure_steps for insert to app_runtime
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy task_procedure_steps_update on task_procedure_steps for update to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on task_procedure_steps to app_runtime;

alter table office_task_steps enable row level security;
create policy office_task_steps_tenant on office_task_steps for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on office_task_steps to app_runtime;

alter table office_task_step_checks enable row level security;
create policy office_task_step_checks_tenant on office_task_step_checks for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on office_task_step_checks to app_runtime;

alter table trainee_reports enable row level security;
create policy trainee_reports_tenant on trainee_reports for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on trainee_reports to app_runtime;

-- A mis-signed block can be pulled while the report is still draft; the trigger
-- above is what makes the closed one unscratchable.
alter table trainee_report_signoffs enable row level security;
create policy trainee_report_signoffs_tenant on trainee_report_signoffs for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, delete on trainee_report_signoffs to app_runtime;

create trigger trg_task_procedures_updated before update on task_procedures
  for each row execute function public.set_updated_at();
create trigger trg_task_procedure_steps_updated before update on task_procedure_steps
  for each row execute function public.set_updated_at();
create trigger trg_office_task_steps_updated before update on office_task_steps
  for each row execute function public.set_updated_at();
create trigger trg_office_task_step_checks_updated before update on office_task_step_checks
  for each row execute function public.set_updated_at();
create trigger trg_trainee_reports_updated before update on trainee_reports
  for each row execute function public.set_updated_at();

-- ---------- Seeds: three default procedures ----------
insert into task_procedures (name, description, scope)
values
  ('Standard administrative task',
   'The default five-step flow: Initiation to Final Sign-off.', 'office'),
  ('Import clearing file',
   'Document intake through release, for a task that carries a cargo file.', 'cargo'),
  ('Trainee induction and completion',
   'Onboarding a trainee up to the signed completion report.', 'office')
on conflict do nothing;

insert into task_procedure_steps
  (tenant_id, procedure_id, seq, name, instructions, checklist, required_documents, is_final)
select null::uuid, p.id, s.seq, s.name, s.instructions, s.checklist, s.required_documents, s.is_final
from task_procedures p
cross join (values
  (1, 'Initiation', 'Record who asked, what is needed and by when.',
      array['Request captured','Assignee named','Deadline agreed'], '{}'::text[], false),
  (2, 'Preparation', 'Gather everything the work needs before starting.',
      array['Background read','Stakeholders notified'], '{}'::text[], false),
  (3, 'Execution', 'Do the work and keep the output where the file can find it.',
      array['Work completed','Output saved to the register'], '{}'::text[], false),
  (4, 'Verification', 'Check the output against the request, not against the effort.',
      array['Checked against the request','Corrections applied'], '{}'::text[], false),
  (5, 'Final Sign-off', 'The approving hand closes the flow.',
      array['Supervisor approved','Task closed in the register'], '{}'::text[], true)
) as s(seq, name, instructions, checklist, required_documents, is_final)
where p.tenant_id is null and p.deleted_at is null
  and p.name = 'Standard administrative task'
  and not exists (select 1 from task_procedure_steps x where x.procedure_id = p.id)
on conflict do nothing;

insert into task_procedure_steps
  (tenant_id, procedure_id, seq, name, instructions, checklist, required_documents, is_final)
select null::uuid, p.id, s.seq, s.name, s.instructions, s.checklist, s.required_documents, s.is_final
from task_procedures p
cross join (values
  (1, 'Initiation', 'Open the file on the mandate, not on a phone call.',
      array['Client instructed','Handler assigned'], array['contract']::text[], false),
  (2, 'Document intake', 'Collect the paperwork the declaration is built from.',
      array['Values reconciled','Container marks matched'],
      array['invoice','packing_list','bill_of_lading'], false),
  (3, 'Declaration and assessment', 'Lodge the declaration and follow the assessment.',
      array['Declaration lodged','Assessment checked against the invoice'],
      array['declaration','assessment'], false),
  (4, 'Duties and levies', 'The bill is settled by the client or the house; record the reference.',
      array['Amounts confirmed','Payment reference recorded'], array['receipt']::text[], false),
  (5, 'Inspection and release', 'Attend the inspection and collect the release.',
      array['Inspection cleared','Release confirmed at the ICD'],
      array['inspection','release_note'], false),
  (6, 'Delivery and handover', 'Move the cargo and hand it over against a signature.',
      array['Delivery booked','Cargo handed over'], array['delivery_note','pod']::text[], false),
  (7, 'Final Sign-off', 'Close the file and issue the account.',
      array['Client invoice issued','File archived'], '{}'::text[], true)
) as s(seq, name, instructions, checklist, required_documents, is_final)
where p.tenant_id is null and p.deleted_at is null
  and p.name = 'Import clearing file'
  and not exists (select 1 from task_procedure_steps x where x.procedure_id = p.id)
on conflict do nothing;

insert into task_procedure_steps
  (tenant_id, procedure_id, seq, name, instructions, checklist, required_documents, is_final)
select null::uuid, p.id, s.seq, s.name, s.instructions, s.checklist, s.required_documents, s.is_final
from task_procedures p
cross join (values
  (1, 'Initiation', 'Register the trainee exactly as NIDA has them.',
      array['Legal name as on NIDA','Department assigned','Profile photo uploaded'],
      '{}'::text[], false),
  (2, 'Placement', 'Give the trainee a supervisor and a first set of tasks.',
      array['Direct supervisor named','Tasks assigned with procedures'], '{}'::text[], false),
  (3, 'Mid-term review', 'Grade early, so the last period is not a surprise.',
      array['Evaluation recorded','Gaps discussed with the trainee'], '{}'::text[], false),
  (4, 'Completion report', 'Generate the report from the task record and grade the four dimensions.',
      array['Tasks reviewed','Attendance stated','Competency grades entered'],
      array['contract']::text[], false),
  (5, 'Final Sign-off', 'Three hands on one page.',
      array['Direct Supervisor signed','HOD signed','HR Manager signed'], '{}'::text[], true)
) as s(seq, name, instructions, checklist, required_documents, is_final)
where p.tenant_id is null and p.deleted_at is null
  and p.name = 'Trainee induction and completion'
  and not exists (select 1 from task_procedure_steps x where x.procedure_id = p.id)
on conflict do nothing;

-- ---------- Permissions ----------
insert into permissions (key, description)
values
  ('procedures.view', 'Procedures - View the workflow library and task steps'),
  ('procedures.create', 'Procedures - Author a procedure or copy a default'),
  ('procedures.edit', 'Procedures - Edit steps, checklists and ticks'),
  ('procedures.delete', 'Procedures - Retire a procedure'),
  ('trainee_reports.view', 'Trainee reports - View completion reports'),
  ('trainee_reports.create', 'Trainee reports - Generate a completion report'),
  ('trainee_reports.edit', 'Trainee reports - Write remarks and grades'),
  ('trainee_reports.sign', 'Trainee reports - Sign off and close a report')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'procedures.%' or p.key like 'trainee_reports.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

-- Read the flow, never rewrite it.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('procedures.view', 'trainee_reports.view')
where r.key in ('auditor', 'general_manager') and r.tenant_id is null
on conflict do nothing;

-- The desk that runs trainees writes the report and owns the three signatures.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('trainee_reports.view', 'trainee_reports.create', 'trainee_reports.edit',
                                 'trainee_reports.sign', 'procedures.view', 'procedures.create')
where r.key in ('operations_manager', 'customer_service') and r.tenant_id is null
on conflict do nothing;

-- A trainee sees the flow behind their own tasks and the report about them.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('procedures.view', 'trainee_reports.view')
where r.key = 'trainee' and r.tenant_id is null
on conflict do nothing;

commit;
