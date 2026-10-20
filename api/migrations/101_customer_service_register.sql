-- 101: the customer service register — every call written down, numbered, and handed to a
-- department that can be asked where it got to.
--
-- The office takes calls from companies: an onboarding that will not finish, a licence that
-- did not arrive, a trip that shows the wrong plate. Today none of it is in the system, so
-- the next call is a fresh start, nobody can say how long a problem has been sitting, and
-- "which department has this?" is a question asked out loud in a corridor. The user asked
-- for the register itself: an incidence number, who rang, what they said the problem is, an
-- allocation to the department that owns it, and the same list visible on that department's
-- panel.
--
-- Two tables, on the model 084 built for the org chart it hands work to:
--
--   support_tickets         one row per incidence, with a state machine that cannot be
--                           skipped and a reference that is unique platform-wide
--   support_ticket_events   the append-only register: every change, who made it, and the
--                           sentence explaining it, with the labels copied at write time
--
-- tenant_id is the platform tenant that owns the register, exactly as 084 uses it, and the
-- company the call is ABOUT is a separate nullable link (company_tenant_id) because half of
-- these callers are not registered companies yet — that is often the whole problem. Keeping
-- the register itself platform-owned is what lets the desk run on withTenant(platform) like
-- every other control desk. It is only safe because 099 just made a control session
-- impossible for a tenant seat: a platform-wide table with a read-all gate needs that
-- guarantee, and now it has one.
--
-- The reference is a global sequence, not a per-tenant count. The freight invoice number
-- (INV-0001, invoices.routes.ts) is per company and its unique index is the race guard; a
-- ticket number is quoted over the phone by someone in another office, so two companies
-- having a "ticket 7" is worse than useless. nextval is atomic, the year prefix is cosmetic,
-- and the unique index stands behind it anyway.
--
-- PII follows the standing rule (AGENTS.md, api/src/util/crypto.ts): the reporter's phone is
-- stored AES-GCM encrypted with an HMAC search hash beside it, and no list statement selects
-- the encrypted column at all. Only the detail read decrypts, and only for a seat that holds
-- the view duty. Names and email are plain, as they are on invoices and debit notes — they
-- are what the desk has to read to answer the phone.
begin;

-- ============================================================
-- 1. the sequence behind the reference
-- ============================================================
create sequence if not exists support_ticket_number_seq;
grant usage, select on sequence support_ticket_number_seq to app_runtime;

-- ============================================================
-- 2. the incidence
-- ============================================================
create table if not exists support_tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ts timestamptz not null default now(),
  -- CS-2026-00012. Quoted on the phone, typed into search, written in the register.
  -- The tail is `5,` and not `5`: lpad only pads, it never truncates, so a strict {5} would
  -- turn the 100,000th incidence into a CHECK violation and stop the register writing at all.
  ref text not null unique check (ref ~ '^CS-[0-9]{4}-[0-9]{5,}$'),
  -- Copied at write time for the same reason 084 copies seat_name: a register read two
  -- years later has to say who was on the line, not point at a row that has moved on.
  reporter_name text not null check (char_length(trim(reporter_name)) between 2 and 140),
  reporter_email text check (reporter_email is null or char_length(reporter_email) <= 254),
  reporter_phone_encrypted bytea,
  reporter_phone_search text,
  channel text not null default 'phone_call' check (channel in (
    'phone_call','whatsapp','email','walk_in','portal_message','other')),
  -- The company the call is about, when it is a company on the platform.
  company_tenant_id uuid references tenants(id) on delete set null,
  company_name text not null check (char_length(trim(company_name)) between 2 and 140),
  category text not null check (category in (
    'onboarding','account_access','licence_billing','cargo_clearing','transport_fleet',
    'marketplace_directory','system_error','complaint','other')),
  subject text not null check (char_length(trim(subject)) between 4 and 140),
  -- The problem as the caller told it. Ten characters is the floor because below that the
  -- sentence belongs in subject and the desk has nothing left to read.
  body text not null check (char_length(trim(body)) between 10 and 4000),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in (
    'open','allocated','in_progress','resolved','closed')),
  department_id uuid references platform_departments(id),
  allocated_by uuid references users(id),
  allocated_at timestamptz,
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  -- What was actually done. A resolve without this line is a status, not an answer.
  resolution text check (resolution is null or char_length(trim(resolution)) between 4 and 2000),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Closed, never deleted: a purged incidence is the one thing a support register cannot
  -- afford, because it is also the evidence for whatever was done about it.
  deleted_at timestamptz,
  deleted_by uuid references users(id),
  -- The machine, stated once here so no route has to remember it. A ticket only leaves
  -- 'open' by being handed to a department, and only claims to be finished when somebody
  -- has written down what they did.
  check (status = 'open' or department_id is not null),
  check (status not in ('resolved','closed')
         or (resolved_at is not null and char_length(trim(coalesce(resolution,''))) >= 4)),
  check (allocated_at is null or (department_id is not null and allocated_by is not null)),
  check (resolved_at is null or resolved_by is not null)
);

create index support_tickets_queue on support_tickets (tenant_id, status, ts desc)
  where deleted_at is null;
-- The department's own panel: what is sitting with us and not finished.
create index support_tickets_department_open on support_tickets (department_id, ts desc)
  where deleted_at is null and status in ('allocated','in_progress');
create index support_tickets_company on support_tickets (company_tenant_id, ts desc)
  where deleted_at is null and company_tenant_id is not null;
-- "He rang last week about the same thing" is found by the hash, not by reading names.
create index support_tickets_phone_search on support_tickets (reporter_phone_search)
  where reporter_phone_search is not null;
create trigger trg_support_tickets_updated before update on support_tickets
  for each row execute function public.set_updated_at();

alter table support_tickets enable row level security;
create policy support_tickets_tenant on support_tickets for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- No DELETE grant: the tombstone is the only way out, matching 084's departments.
grant select, insert, update on support_tickets to app_runtime;
revoke all on support_tickets from public, anon, authenticated, service_role;

comment on column support_tickets.ref is
  'Platform-wide incidence number, from support_ticket_number_seq with the year prefix.';
comment on column support_tickets.company_tenant_id is
  'The company the call is about, when it is on the platform. The name is kept anyway.';
comment on column support_tickets.reporter_phone_encrypted is
  'AES-GCM of the callback number. Never selected by a list statement.';

-- ============================================================
-- 3. the register of everything done to it
-- ============================================================
create table if not exists support_ticket_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ts timestamptz not null default now(),
  ticket_id uuid not null references support_tickets(id),
  -- The reference copied in, so one line of the register makes sense without a join to a
  -- row that may have been renamed or closed since.
  ref text not null,
  actor_user_id uuid references users(id),
  actor_role text,
  ip text,
  request_id text,
  action text not null check (action in (
    'logged','allocated','reallocated','status_changed','priority_changed',
    'note_added','resolved','reopened','closed')),
  -- Labels as they were, not as they are now.
  from_label text,
  to_label text,
  department_from_id uuid,
  department_to_id uuid,
  reason text not null check (char_length(trim(reason)) between 4 and 300),
  detail jsonb not null default '{}'::jsonb
);
create index support_ticket_events_ticket on support_ticket_events (ticket_id, ts);
create index support_ticket_events_recent on support_ticket_events (tenant_id, ts desc);
create index support_ticket_events_actor on support_ticket_events (actor_user_id, ts desc);

alter table support_ticket_events enable row level security;
-- Two policies, not `for all`, exactly as 084's register: the door that writes a line is
-- not a door that edits one.
create policy support_ticket_events_select on support_ticket_events
  for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy support_ticket_events_insert on support_ticket_events
  for insert to app_runtime
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert on support_ticket_events to app_runtime;
revoke all on support_ticket_events from public, anon, authenticated, service_role;

-- The 043 guard, named for jobs and generic in its body: append-only holds even if a later
-- migration hands UPDATE or DELETE back by mistake.
do $$ begin
  create trigger support_ticket_events_no_mutation
    before update or delete on support_ticket_events
    for each row execute function platform_auth.prevent_job_mutation();
exception when others then null;  -- already exists
end $$;

-- ============================================================
-- 4. two duties
-- ============================================================
--
-- Reading the queue is a duty half the platform holds: whoever answers a call has to know
-- whether somebody already has. Writing one — logging it, pointing it at a department,
-- closing it — is the job, and stays with the seats that do it. This mirrors
-- control.departments.view / .manage (084) in shape and in who gets what.
insert into permissions (key, description) values
  ('control.tickets.view',
   'Control - Read the customer service register and the incidences on a desk'),
  ('control.tickets.manage',
   'Control - Log incidences, allocate them to a department and settle them')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.tickets.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','customer_service_agent','support_engineer',
                 'compliance_officer','platform_analyst')
on conflict do nothing;

-- support_engineer is in here as well as in the read duty: an engineer closes what they
-- fixed, but does not decide which department a call belongs to — that stays with the
-- agents whose job is the queue.
insert into role_permissions (role_id, permission_key)
select r.id, 'control.tickets.manage'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','customer_service_agent','support_engineer')
on conflict do nothing;

do $$
declare
  v_depts int;
  v_holders int;
begin
  select count(*)::int into v_depts from platform_departments
   where deleted_at is null;
  select count(distinct r.key)::int into v_holders from role_permissions rp
    join roles r on r.id = rp.role_id
   where rp.permission_key = 'control.tickets.view';
  raise notice '101: customer service register ready — % department(s) to hand work to, % role(s) can read it', v_depts, v_holders;
end $$;

commit;
