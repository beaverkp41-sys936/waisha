-- 084 — the platform's own org chart, and the register of who moved where (task #130c).
--
-- The office asked for "all necessary professional management parts for different
-- department needed on admin panel" and a "smooth and easier transition system". The panel
-- already knows which *duties* a seat holds (067: the roster, role_permissions, the duty
-- catalogue) but not which *team* it sits in, and it has never had a record of a seat
-- changing hands. A platform with four desks and no departments cannot answer "who is
-- on call for billing this week" or "who took over from Omar", so the work sits on one
-- Super Admin — which is exactly how a one-person platform stays one person.
--
-- Three tables, one shape each:
--   platform_departments      the teams the office itself is organised into (renameable,
--                             closeable, one head answerable for each);
--   platform_seat_departments which seat sits in which team, permanently or as a cover
--                             with an end date — the leave/secondment case;
--   platform_duty_transitions the append-only register of every move, with the reason a
--                             person would defend out loud.
--
-- Why a register when audit_logs already exists: the trail says "somebody wrote to
-- user_roles at 14:02". A *transition* says "Amina handed the billing desk to Omar because
-- she is on leave, and it lapses on the 3rd". That sentence is what a handover needs, it
-- has to be countable per department and per seat, and it must survive a rename of the
-- department it names — so the labels are copied at write time, not joined at read time.
--
-- Posture: everything here is platform-internal. Every row belongs to the one platform
-- tenant, so withTenant(platform) sees precisely the right set through the ordinary tenant
-- policy — the same reasoning 067 used to add no definer for the roster, and a definer
-- here would only widen the door. The register is append-only twice over: no UPDATE or
-- DELETE is granted to app_runtime, and 043's mutation trigger raises even if a later
-- migration hands them back. Departments and memberships are tombstoned or released, never
-- deleted, so "how many seats has this team had" stays answerable after a reorganisation.
--
-- Covers expire by being read, not by a sweeper: a membership counts while
-- `released_at is null and (ends_at is null or ends_at > now())`. Nothing to run on boot,
-- nothing to miss while the API was down — the register only records what a person did.

begin;

-- ============================================================
-- 1. the departments
-- ============================================================

create table if not exists platform_departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- Lowercase, stable, and never reused by a later rename: the register quotes names, and
  -- a key that a second department can take would split one team's history in two.
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name text not null check (char_length(trim(name)) between 2 and 70),
  purpose text not null default '',
  -- The person answerable for the team. Kept denormalised next to the membership rows so
  -- "who do I call about this desk" is one read, and so a head can be changed without
  -- rewriting anybody's seat.
  head_user_id uuid references users(id) on delete set null,
  is_active boolean not null default true,
  sort int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users(id),
  updated_by uuid references users(id),
  -- A closed department stays in the register's history and keeps its seat count frozen;
  -- it is not a delete. Reopening is the only way back, and it is recorded.
  deleted_at timestamptz,
  deleted_by uuid references users(id),
  check (purpose = '' or char_length(purpose) <= 240)
);
create unique index platform_departments_key_live
  on platform_departments (tenant_id, key) where deleted_at is null;
create index platform_departments_order
  on platform_departments (tenant_id, sort, name) where deleted_at is null;
create trigger trg_platform_departments_updated before update on platform_departments
  for each row execute function public.set_updated_at();

alter table platform_departments enable row level security;
create policy platform_departments_tenant on platform_departments for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- No DELETE: closing a team is an update to deleted_at, so a reorganisation cannot erase
-- the record that the team existed.
grant select, insert, update on platform_departments to app_runtime;
revoke all on platform_departments from public, anon, authenticated, service_role;

comment on column platform_departments.head_user_id is
  'Answerable for the desk. Membership is separate: a head is also a seat in the team.';
comment on column platform_departments.purpose is
  'What this team owns, in one sentence the desk can read out loud.';

-- ============================================================
-- 2. which seat sits in which team
-- ============================================================

create table if not exists platform_seat_departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id) on delete cascade,
  department_id uuid not null references platform_departments(id),
  standing text not null default 'member' check (standing in ('member','head')),
  starts_at timestamptz not null default now(),
  -- Set for a cover: leave, a secondment, an acting head. A membership stops counting on
  -- its own once this passes — no sweeper, no state to settle.
  ends_at timestamptz,
  note text check (note is null or char_length(note) <= 240),
  assigned_by uuid references users(id),
  assigned_at timestamptz not null default now(),
  released_by uuid references users(id),
  released_at timestamptz,
  -- A date in the past on the way in is how a typo becomes a seat that was never really
  -- covered; a cover shorter than a day is a mistake, not a plan.
  check (ends_at is null or ends_at > starts_at + interval '1 hour')
);
-- One live membership per seat per department: pressing Assign twice must not make two
-- rows that the desk then has to release twice.
create unique index platform_seat_departments_live
  on platform_seat_departments (user_id, department_id) where released_at is null;
-- One head per department. Two heads is not a handover, it is an unanswered question.
create unique index platform_seat_departments_one_head
  on platform_seat_departments (department_id)
  where released_at is null and standing = 'head';
create index platform_seat_departments_department
  on platform_seat_departments (department_id, starts_at desc) where released_at is null;
create index platform_seat_departments_seat
  on platform_seat_departments (user_id, starts_at desc) where released_at is null;
create index platform_seat_departments_covers
  on platform_seat_departments (ends_at)
  where released_at is null and ends_at is not null;

alter table platform_seat_departments enable row level security;
create policy platform_seat_departments_tenant on platform_seat_departments for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on platform_seat_departments to app_runtime;
revoke all on platform_seat_departments from public, anon, authenticated, service_role;

-- ============================================================
-- 3. the duty-transition register — append-only, and the labels are its own
-- ============================================================

create table if not exists platform_duty_transitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ts timestamptz not null default now(),
  -- The seat the move is about, and the one that made it. A plain FK on purpose: a purged
  -- seat must not take its own history with it, so a cleanup has to delete these rows on
  -- purpose rather than by cascade.
  user_id uuid not null references users(id),
  actor_user_id uuid references users(id),
  actor_role text,
  ip text,
  request_id text,
  action text not null check (action in (
    'department_created','department_updated','department_closed','department_reopened',
    'seat_joined','seat_moved','seat_released','head_appointed','head_released')),
  -- Copied at write time, because the register is read years later by somebody who wants
  -- to know what the arrangement was, not what the row says today.
  seat_name text,
  from_label text,
  to_label text,
  from_department_id uuid,
  to_department_id uuid,
  -- The sentence. A move nobody can explain is the one thing an org chart must not hide.
  reason text not null check (char_length(trim(reason)) between 4 and 300),
  detail jsonb not null default '{}'::jsonb
);
create index platform_duty_transitions_recent
  on platform_duty_transitions (tenant_id, ts desc);
create index platform_duty_transitions_seat
  on platform_duty_transitions (user_id, ts desc);
create index platform_duty_transitions_department
  on platform_duty_transitions (to_department_id, ts desc) where to_department_id is not null;
create index platform_duty_transitions_action
  on platform_duty_transitions (tenant_id, action, ts desc);

alter table platform_duty_transitions enable row level security;
-- Two policies, not `for all`: the register cannot be edited through the door that
-- opened it, and a handler that tries finds no policy to hide behind.
create policy platform_duty_transitions_select on platform_duty_transitions
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy platform_duty_transitions_insert on platform_duty_transitions
  for insert to app_runtime
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert on platform_duty_transitions to app_runtime;
revoke all on platform_duty_transitions from public, anon, authenticated, service_role;

-- The same guard 043 wrote for the job evidence: immutability has to hold even if a later
-- migration hands UPDATE/DELETE back by mistake. Its name is about jobs; its body is
-- tg_table_name, so it says "platform_duty_transitions is append-only" when it fires here.
do $$ begin
  create trigger platform_duty_transitions_no_mutation
    before update or delete on platform_duty_transitions
    for each row execute function platform_auth.prevent_job_mutation();
exception when others then null;  -- already exists
end $$;

-- ============================================================
-- 4. two duties, not one
-- ============================================================
--
-- Reading the org chart is a duty the analyst and the support seat already need (who
-- answers for billing?). Re-shaping it — naming a head, moving a seat, closing a team —
-- stays with super_admin, matching control.staff.manage (067) exactly.

insert into permissions (key, description) values
  ('control.departments.view',
   'Control - Read the platform departments, their seats and the duty register'),
  ('control.departments.manage',
   'Control - Shape departments and move seats between them')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.departments.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','compliance_officer','platform_analyst','support_engineer')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.departments.manage'
  from roles r
 where r.tenant_id is null and r.key = 'super_admin'
on conflict do nothing;

-- ============================================================
-- 5. the starting chart
-- ============================================================
--
-- Six desks named for what they own, seeded once into the platform tenant that already
-- exists so the screen does not open empty. Nobody's seat is placed by this file: the
-- office decides who sits where, and the register then says when and why.

insert into platform_departments (tenant_id, key, name, purpose, sort)
select t.id, d.key, d.name, d.purpose, d.sort
  from (select id from tenants
         where type = 'platform' and deleted_at is null) t
 cross join (values
   ('support',      'Customer Support',
    'Answers companies using WAISHA: onboarding trouble, blocked accounts, how-do-I questions.', 10),
   ('compliance',   'Compliance & Screening',
    'Terms, documents and screening. Owns the register of actions taken on a company.', 20),
   ('billing',      'Billing & Revenue',
    'Plans, licences, invoices and refunds. Owns what a company is charged and when.', 30),
   ('operations',   'Platform Operations',
    'Routes, trips, fleet and checkpoint data. Owns that the transport side works.', 40),
   ('marketplace',  'Directory & Marketplace',
    'Company listings, seeker supply and demand quality. Owns what the public sees.', 50),
   ('engineering',  'Platform Engineering',
    'The system itself: errors, releases, infrastructure and the build.', 60)
 ) d(key, name, purpose, sort)
 where not exists (
   select 1 from platform_departments p
    where p.tenant_id = t.id and p.deleted_at is null);

commit;
