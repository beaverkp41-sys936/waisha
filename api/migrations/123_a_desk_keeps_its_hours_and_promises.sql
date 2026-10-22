-- 123 — a desk keeps its hours, and the promise it makes inside them (task #339).
--
-- 084 gave the platform an org chart and 101 gave it a register of calls. Put together, they
-- still cannot answer the three questions an office actually asks: *who takes this call, what
-- did we promise about when it gets answered, and is the desk that holds it drowning?* Today
-- the answer to the first is whoever picked up the phone, to the second that there is no
-- second, and to the third that nobody can see. The office's own spec named the missing parts:
-- working hours, SLA first-response and resolution, an escalation path, routing rules, an
-- atomic per-department ticket number, an archive guard, and a detail page with the numbers on
-- it. This migration puts the four load-bearing ones in the schema; the desk and the routes
-- are the rest of the stage.
--
-- What is a fact of the database after this, and what stays a route's decision:
--
--   the hours          a desk's working week, in Dar es Salaam wall-clock, readable by any
--                      surface that reads the desk — not a string in a page footer
--   the promise        response_due_at / resolution_due_at, computed from the desk's SLA by
--                      counting *working* minutes, so a Friday-evening call does not owe an
--                      answer at 03:00
--   the queue number   next_ticket_number(dept) mints BILL-4 once and only once, from a
--                      counter on the desk row under a row lock, with a unique index behind it
--   the escalation     a desk names the desk above it, and the chain cannot loop
--   the archive        a desk with work still on it cannot be filed away — in SQL, so the next
--                      route somebody writes cannot close one either
--
-- The ceiling (`max_open_tickets`) is deliberately NOT a database rule. A hard trigger would
-- refuse the one act that must always be allowed — an escalation into a busy desk, because a
-- ticket that cannot move is a ticket nobody is answering. It is enforced where a human choice
-- is being made, and an escalation names the fact that it went over.
--
-- The two clock functions read no table at all, so they are SECURITY INVOKER with a pinned
-- search path (084's reasoning: a definer here only opens a wider door). `next_ticket_number`
-- and `department_open_tickets` are definers: the first writes the counter no caller may
-- steer, the second has to count rows that belong to the register rather than to whatever
-- `app.tenant_id` the closing desk happens to have set — a guard that can be starved by a
-- session variable is not a guard.
begin;

-- ============================================================
-- 1. what the desk promises, and when it is open to hear about it
-- ============================================================

alter table platform_departments
  -- A desk with no SLA makes no promise, and the register says "no clock set" rather than
  -- inventing one. NULL is the honest default: the office has not decided these numbers for
  -- the six desks it already has, and a migration that picks 4 hours for Billing is a
  -- promise the platform is making on somebody else's behalf.
  add column if not exists first_response_minutes int
    check (first_response_minutes is null
           or (first_response_minutes between 5 and 4320)),
  add column if not exists resolve_minutes int
    check (resolve_minutes is null or (resolve_minutes between 15 and 20160)),
  -- Dar es Salaam wall-clock, one window per weekday, an absent or null day is closed:
  -- {"mon":{"open":"08:00","close":"17:30"},"sat":{"open":"09:00","close":"13:00"},"sun":null}
  -- The default is the office's own published week — Mon–Fri 08:00–17:30, Saturday
  -- 09:00–13:00, Sunday closed — because a column with no default would put every desk's
  -- clock at "never open" the moment an SLA is set, which is a worse lie than a starting
  -- point the desk can edit.
  add column if not exists business_hours jsonb not null default
    ('{"mon":{"open":"08:00","close":"17:30"},"tue":{"open":"08:00","close":"17:30"},'
     || '"wed":{"open":"08:00","close":"17:30"},"thu":{"open":"08:00","close":"17:30"},'
     || '"fri":{"open":"08:00","close":"17:30"},"sat":{"open":"09:00","close":"13:00"},'
     || '"sun":null}')::jsonb
    check (jsonb_typeof(business_hours) = 'object'),
  -- The desk above this one. Kept on the department rather than in a rules table because a
  -- chain is one value per desk and the whole point is that it is readable in one row.
  add column if not exists escalation_department_id uuid
    references platform_departments(id) on delete set null,
  -- The backpressure figure, not a duty grant: above it the register stops handing this desk
  -- new work and the desk says so. The spec called this "per-department permission limits";
  -- what a department may *do* is still role_permissions, and a column on a desk that looked
  -- like it could be a permission would be read as one.
  add column if not exists max_open_tickets int
    check (max_open_tickets is null or (max_open_tickets between 1 and 500)),
  -- The counter behind the desk's own queue number. On the row, not in a sequence, because
  -- the row is what the lock has to fall on: `for update` here serialises two clerks asking
  -- Billing for a number in the same millisecond, and the unique index catches anything the
  -- lock somehow missed.
  add column if not exists ticket_seq bigint not null default 0
    check (ticket_seq >= 0);

-- A desk that escalates to itself is a ticket that never lands. Two columns of one row are
-- comparable in a CHECK, so the one-desk loop is settled here; the two-desk ping-pong that
-- needs a second row to see is the trigger below. Split from the ALTER above so a re-run of
-- this file in a scratch database cannot fail on a constraint that already exists.
alter table platform_departments
  drop constraint if exists platform_departments_not_own_escalation;
alter table platform_departments
  add constraint platform_departments_not_own_escalation
    check (escalation_department_id is null or escalation_department_id <> id);

create index if not exists platform_departments_escalation
  on platform_departments (escalation_department_id)
  where escalation_department_id is not null;

-- The shape of the week is checked in a trigger rather than a CHECK because the test needs a
-- loop: every key must be a weekday, every window a real pair of times in order, and a
-- garbage window must not be able to reach the clock functions. plpgsql in a CHECK would not
-- be immutable, and a trigger body has no such rule.
create or replace function platform_auth.department_hours_are_readable()
returns trigger language plpgsql set search_path = public as $$ declare
  v_key text;
  v_day jsonb;
  v_open text;
  v_close text;
  v_keys text[];
begin
  if jsonb_typeof(new.business_hours) <> 'object' then
    raise exception 'platform_departments: business_hours must be an object keyed by weekday'
      using errcode = '22023';
  end if;
  -- array_agg over jsonb_object_keys is set-returning in a select: the only legal way to get
  -- the key list out of a jsonb value inside plpgsql.
  select coalesce(array_agg(k), '{}'::text[]) into v_keys
    from jsonb_object_keys(new.business_hours) as k;
  v_keys := v_keys - array['mon','tue','wed','thu','fri','sat','sun'];
  if array_length(v_keys, 1) > 0 then
    raise exception 'platform_departments: business_hours has day(s) nobody recognises: %',
      array_to_string(v_keys, ', ')
      using hint = 'Use mon, tue, wed, thu, fri, sat, sun; omit a day or set it to null if the desk is shut.',
             errcode = '22023';
  end if;
  for v_key in select unnest(array['mon','tue','wed','thu','fri','sat','sun']) loop
    v_day := new.business_hours -> v_key;
    if v_day is null or jsonb_typeof(v_day) = 'null' then continue; end if;  -- closed day
    if jsonb_typeof(v_day) <> 'object' then
      raise exception 'platform_departments: % must be an object with open and close', v_key
        using errcode = '22023';
    end if;
    v_open := v_day ->> 'open';
    v_close := v_day ->> 'close';
    if v_open is null or v_close is null
       or v_open !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or v_close !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'platform_departments: % is not a pair of HH:MM times', v_key
        using errcode = '22023';
    end if;
    if v_open::time >= v_close::time then
      raise exception 'platform_departments: % closes before or at the minute it opens', v_key
        using errcode = '22023';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists platform_departments_hours_shape on platform_departments;
create trigger platform_departments_hours_shape
  before insert or update of business_hours on platform_departments
  for each row execute function platform_auth.department_hours_are_readable();

-- The escalation chain cannot loop. Checked by walking it upward from the desk being written,
-- with a step budget so a pre-existing loop in stored data cannot hang the write that
-- discovers it — the loop is the error either way, and a stuck transaction is not.
create or replace function platform_auth.escalation_path_does_not_loop()
returns trigger language plpgsql set search_path = public as $$ declare
  v_next uuid;
  v_steps int := 0;
begin
  if new.escalation_department_id is null then return new; end if;
  v_next := new.escalation_department_id;
  while v_next is not null loop
    if v_next = new.id then
      raise exception
        'platform_departments: the escalation path from % comes back to itself', new.key
        using hint = 'Escalation has to end somewhere. Point the last desk at no desk.',
              errcode = '23514';
    end if;
    select e.escalation_department_id into v_next
      from platform_departments e where e.id = v_next;
    v_steps := v_steps + 1;
    if v_steps > 24 then
      raise exception 'platform_departments: the escalation chain above % is longer than 24 desks',
        new.key using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists platform_departments_escalation_acyclic on platform_departments;
create trigger platform_departments_escalation_acyclic
  before insert or update of escalation_department_id on platform_departments
  for each row execute function platform_auth.escalation_path_does_not_loop();

-- ============================================================
-- 2. the clock that counts only the minutes a desk is open
-- ============================================================

-- Adds p_minutes of *working* minutes to p_from. A closed day, a missing day and an
-- unparseable window all mean the same thing: no minutes pass today. Bounded to 400 days so a
-- desk that shuts for a year gets a NULL due rather than a loop nobody escapes — the caller
-- says "no date can be promised", which is what happened.
--
-- `at time zone` is used twice, in opposite directions, and the order matters: timestamptz →
-- named zone yields a wall-clock timestamp, and wall-clock timestamp → named zone yields the
-- instant back. Tanzania has no daylight saving, so the round trip is exact all year.
create or replace function platform_auth.work_minutes(
  p_from timestamptz, p_minutes int, p_hours jsonb)
returns timestamptz language plpgsql stable set search_path = public as $$ declare
  v_at timestamptz;
  v_local timestamp;
  v_day text;
  v_win jsonb;
  v_open time;
  v_close time;
  v_left numeric;
  v_avail numeric;
  v_i int;
begin
  if p_minutes is null or p_minutes <= 0 then return p_from; end if;
  if p_from is null then return null; end if;
  v_at := p_from;
  v_left := p_minutes;

  for v_i in 1 .. 400 loop
    v_local := v_at at time zone 'Africa/Dar_es_Salaam';
    v_day := case (extract(isodow from v_local))::int
               when 1 then 'mon' when 2 then 'tue' when 3 then 'wed' when 4 then 'thu'
               when 5 then 'fri' when 6 then 'sat' else 'sun' end;
    v_win := nullif(p_hours -> v_day, 'null'::jsonb);
    v_open := null;
    v_close := null;
    if v_win is not null and jsonb_typeof(v_win) = 'object' then
      begin
        v_open := (v_win ->> 'open')::time;
        v_close := (v_win ->> 'close')::time;
      exception when others then
        v_open := null;
        v_close := null;
      end;
    end if;
    if v_open is null or v_close is null or v_close <= v_open then
      v_at := (date_trunc('day', v_local) + interval '1 day')
              at time zone 'Africa/Dar_es_Salaam';
    else
      if v_local::time < v_open then
        v_at := (date_trunc('day', v_local) + v_open)
                at time zone 'Africa/Dar_es_Salaam';
        v_local := v_at at time zone 'Africa/Dar_es_Salaam';
      end if;
      v_avail := extract(epoch from (v_close - v_local::time)) / 60.0;
      if v_avail <= 0 then
        v_at := (date_trunc('day', v_local) + interval '1 day')
                at time zone 'Africa/Dar_es_Salaam';
      elsif v_left <= v_avail then
        -- Whole seconds, not `numeric * interval`: the operator only takes a double
        -- precision on the versions this runs on, and a promise is never finer than a second.
        return (v_local + make_interval(secs => round(v_left * 60)::double precision))
               at time zone 'Africa/Dar_es_Salaam';
      else
        v_left := v_left - v_avail;
        v_at := (date_trunc('day', v_local) + v_close)
                at time zone 'Africa/Dar_es_Salaam';
      end if;
    end if;
  end loop;
  return null;
end $$;

-- Whether an instant falls inside the desk's week. The register uses it to say "logged out of
-- hours: the clock starts when they open", which is the sentence that keeps an after-hours
-- call from reading as a breach the desk never agreed to.
--
-- The weekday is named here the same way work_minutes names it — from the ISO day number of
-- the *local* wall clock, not of the instant — because a window read against UTC would call
-- 02:00 in Dar es Salaam a Sunday evening and open the desk three hours early.
create or replace function platform_auth.inside_hours(p_at timestamptz, p_hours jsonb)
returns boolean language sql stable set search_path = public as $$
  with wall as (
    select p_at at time zone 'Africa/Dar_es_Salaam' as l
  ), today as (
    select w.l,
           case (extract(isodow from w.l))::int
             when 1 then 'mon' when 2 then 'tue' when 3 then 'wed' when 4 then 'thu'
             when 5 then 'fri' when 6 then 'sat' else 'sun' end as day
      from wall w
  ), win as (
    select t.l, nullif(p_hours -> t.day, 'null'::jsonb) as w from today t
  )
  select case when p_at is null or p_hours is null then false else coalesce((
    select (v.w ->> 'open')::time <= v.l::time and v.l::time < (v.w ->> 'close')::time
      from win v
     where jsonb_typeof(v.w) = 'object'
       -- The trigger keeps every stored window parseable; the guard here is what stops one
       -- hand-edited row from turning a desk's own page into a 22P02.
       and (v.w ->> 'open') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       and (v.w ->> 'close') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ), false) end;
$$;

-- ============================================================
-- 3. the desk's own queue number
-- ============================================================

alter table support_tickets
  -- Minted once, by the desk that first took the work, and it does not change on a
  -- re-allocation: the caller was told "BILLING-4", and a register that renames a number the
  -- customer is quoting is a register that cannot be asked about that call again. So the
  -- number carries the desk that issued it (`numbered_by`) rather than the desk currently
  -- holding the work — a moved call keeps its queue number, and the queue it came from keeps
  -- the count of what it issued.
  add column if not exists dept_number int,
  add column if not exists numbered_by uuid references platform_departments(id)
    on delete set null,
  -- The readable form, copied whole at write time the way 101 copies the reporter's name:
  -- a register read after a desk is renamed has to say the number the caller was given, not
  -- point at a key that has moved on.
  add column if not exists dept_ref text
    check (dept_ref is null or dept_ref ~ '^[A-Z][A-Z0-9_]{1,39}-[0-9]{1,7}$'),
  -- What the caller spoke, because the two languages the office answers in are not inferable
  -- from a name and routing on language is one of the rules the spec asked for.
  add column if not exists language text not null default 'en'
    check (language in ('en','sw')),
  add column if not exists response_due_at timestamptz,
  add column if not exists resolution_due_at timestamptz,
  -- Stamped by the first act that puts a human on the call, and never by a machine: an
  -- automatic receipt is not an answer, and letting it green the clock is how a desk reports
  -- a 100% first-response rate while nobody has read the ticket.
  add column if not exists first_response_at timestamptz,
  add column if not exists escalated_from_id uuid references platform_departments(id)
    on delete set null,
  add column if not exists escalated_at timestamptz,
  add column if not exists after_hours boolean not null default false;

-- Three columns, one fact. A desk ref without the counter behind it, or a counter nobody
-- wrote the readable form for, is a number that cannot be defended on the phone.
alter table support_tickets
  drop constraint if exists support_tickets_number_is_whole;
alter table support_tickets
  add constraint support_tickets_number_is_whole check (
    (dept_number is null and dept_ref is null and numbered_by is null)
    or (dept_number is not null and dept_ref is not null and numbered_by is not null));
-- The readable form has to end with the counter it came from. The rest of the tie — which
-- desk's key is the prefix, and that it is the desk in `numbered_by` — cannot be a CHECK: a
-- constraint may not contain a subquery, so it would have to re-read the department row. It is
-- instead the mint's own job: `next_ticket_number` builds key, number and ref from one row it
-- holds a lock on, so the three cannot be written to disagree.
alter table support_tickets
  drop constraint if exists support_tickets_number_matches_its_ref;
alter table support_tickets
  add constraint support_tickets_number_matches_its_ref check (
    dept_ref is null or dept_ref like '%-' || dept_number::text);

-- Two indexes, both deliberately not partial on deleted_at: a retired "BILLING-7" must never
-- be handed to a new call three months later, whichever desk it was logged against and
-- whether or not the incidence is still on the boards. The second is the caller-facing
-- guarantee — the number that is quoted over the phone cannot exist twice anywhere on the
-- platform, which is 101's argument for the global CS- ref applied to the desk's own queue.
create unique index if not exists support_tickets_desk_number
  on support_tickets (numbered_by, dept_number) where dept_number is not null;
create unique index if not exists support_tickets_desk_ref
  on support_tickets (dept_ref) where dept_ref is not null;
create index if not exists support_tickets_sla
  on support_tickets (department_id, resolution_due_at)
  where deleted_at is null and status in ('open','allocated','in_progress');

-- The mint. One function, not a read and a write in the route, because the row lock is the
-- whole point: two clerks asking the same desk for a number in the same instant take it one
-- at a time, and the counter they both read is one apart.
--
-- The skip loop exists for one case: a desk closed and its key later taken by a new desk
-- (084's unique key index is partial on deleted_at, so that is allowed) would otherwise
-- re-issue BILLING-1 while the retired desk's BILLING-1 still sits in the register. The
-- counter moves past it and leaves a hole, which is the honest shape — a hole says "this
-- number was given to somebody else", a duplicate would say nothing at all.
create or replace function platform_auth.next_ticket_number(p_department_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_key text;
  v_name text;
  v_seq bigint;
  v_found uuid;
  v_ref text;
  v_guard int := 0;
begin
  -- Lock first, read the key inside the lock: a rename that lands between the two would
  -- otherwise mint a number under one key and write the ref of the other.
  select d.id, upper(d.key), d.name into v_found, v_key, v_name
    from platform_departments d
   where d.id = p_department_id and d.deleted_at is null
     for update of d;
  if not found then
    return jsonb_build_object('status','unavailable',
      'message','That desk is not open, so it cannot give a call its number.');
  end if;

  loop
    update platform_departments set ticket_seq = ticket_seq + 1
      where id = p_department_id
      returning ticket_seq into v_seq;
    v_ref := v_key || '-' || v_seq::text;
    exit when not exists (select 1 from support_tickets where dept_ref = v_ref);
    v_guard := v_guard + 1;
    if v_guard > 200 then
      -- Two hundred taken numbers under one key means the register is being read wrongly,
      -- not that the desk is busy. Say so rather than minting a third.
      raise exception
        'platform_departments: more than 200 queue numbers under % are already in the register',
        v_key using errcode = '23505';
    end if;
  end loop;

  return jsonb_build_object('status','ok', 'department_id', p_department_id,
    'department_key', v_key, 'department_name', v_name,
    'number', v_seq::int, 'ref', v_ref);
end $$;


-- ============================================================
-- 4. who takes the call
-- ============================================================

create table if not exists support_ticket_routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- Named because two rules that both say "cargo, urgent" are not one rule, and the desk has
  -- to be able to ask which one fired.
  name text not null check (char_length(trim(name)) between 3 and 70),
  department_id uuid not null references platform_departments(id),
  -- Every list is a set of accepted values, and EMPTY means "this predicate does not narrow
  -- anything". At least one list must narrow, or the rule is a catch-all that silently
  -- swallows the queue — which is exactly the thing a desk writes by accident at 17:55.
  channels text[] not null default '{}'::text[],
  categories text[] not null default '{}'::text[],
  priorities text[] not null default '{}'::text[],
  languages text[] not null default '{}'::text[],
  -- The region of the linked company's head office (branches.kind = 'hq'). A call from a
  -- company with no branch on file matches a region rule the same way a mismatch does: not
  -- at all, rather than as "any region", so a rule cannot quietly widen itself.
  region_ids int[] not null default '{}'::int[],
  check (array_length(channels, 1) is not null or array_length(categories, 1) is not null
         or array_length(priorities, 1) is not null or array_length(languages, 1) is not null
         or array_length(region_ids, 1) is not null),
  -- Spelled out rather than left to the route because a rule with 'phonecall' in it never
  -- fires and is invisible until somebody notices a queue that never routes.
  check (channels <@ array['phone_call','whatsapp','email','walk_in','portal_message','other']),
  check (categories <@ array['onboarding','account_access','licence_billing','cargo_clearing',
                             'transport_fleet','marketplace_directory','system_error',
                             'complaint','other']),
  check (priorities <@ array['low','normal','high','urgent']),
  check (languages <@ array['en','sw']),
  -- Lowest number wins; ties are broken by name so the same rule fires twice in a row.
  precedence int not null default 100 check (precedence between 1 and 999),
  is_active boolean not null default true,
  note text check (note is null or char_length(note) <= 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users(id),
  updated_by uuid references users(id),
  deleted_at timestamptz,
  deleted_by uuid references users(id)
);
create unique index if not exists support_ticket_routes_name_live
  on support_ticket_routes (tenant_id, name) where deleted_at is null;
create index if not exists support_ticket_routes_order
  on support_ticket_routes (tenant_id, precedence, name) where deleted_at is null;
drop trigger if exists trg_support_ticket_routes_updated on support_ticket_routes;
create trigger trg_support_ticket_routes_updated before update on support_ticket_routes
  for each row execute function public.set_updated_at();

alter table support_ticket_routes enable row level security;
create policy support_ticket_routes_tenant on support_ticket_routes for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on support_ticket_routes to app_runtime;
revoke all on support_ticket_routes from public, anon, authenticated, service_role;

comment on column support_ticket_routes.precedence is
  'Match order, lowest first. A ticket is routed by the first rule that fits, not by every rule that does.';

-- The match. Every empty list is a pass, every full list a containment test, and the desk has
-- to be a desk the register is allowed to hand work to: open, and not the one the caller is
-- leaving. Returns the winning rule with the desk it names, or no_rule — never a guess.
create or replace function platform_auth.route_ticket(
  p_tenant_id uuid, p_channel text, p_category text, p_priority text,
  p_language text, p_region_id int)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce((
    select jsonb_build_object('status','rule', 'rule_id', r.id, 'rule_name', r.name,
             'precedence', r.precedence, 'matched_by', jsonb_build_object(
               'channels', r.channels, 'categories', r.categories, 'priorities', r.priorities,
               'languages', r.languages, 'regions', r.region_ids),
             'department_id', d.id, 'department_key', upper(d.key), 'department_name', d.name,
             'max_open_tickets', d.max_open_tickets,
             'open_tickets', (select count(*)::int from support_tickets t
                               where t.department_id = d.id and t.deleted_at is null
                                 and t.status in ('open','allocated','in_progress')))
      from support_ticket_routes r
      join platform_departments d on d.id = r.department_id
                                  and d.tenant_id = r.tenant_id
                                  and d.deleted_at is null
     where r.tenant_id = p_tenant_id and r.deleted_at is null and r.is_active
       and (array_length(r.channels, 1) is null
            or p_channel = any(r.channels))
       and (array_length(r.categories, 1) is null
            or p_category = any(r.categories))
       and (array_length(r.priorities, 1) is null
            or p_priority = any(r.priorities))
       and (array_length(r.languages, 1) is null
            or p_language = any(r.languages))
       and (array_length(r.region_ids, 1) is null
            or (p_region_id is not null and p_region_id = any(r.region_ids)))
     order by r.precedence, r.name limit 1),
    jsonb_build_object('status','no_rule'));
$$;

-- ============================================================
-- 5. a desk with work on it cannot be filed away
-- ============================================================

create or replace function platform_auth.department_open_tickets(p_department_id uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from support_tickets
   where department_id = p_department_id and deleted_at is null
     and status in ('open','allocated','in_progress');
$$;

create or replace function platform_auth.desk_holds_no_open_tickets()
returns trigger language plpgsql set search_path = public as $$ declare
  v_open int;
begin
  -- Only the act of filing away is policed; renaming a desk that holds 40 calls is not a
  -- reorganisation anybody should be stopped from doing.
  if new.deleted_at is null or old.deleted_at is not null then return new; end if;
  v_open := platform_auth.department_open_tickets(new.id);
  if v_open > 0 then
    raise exception
      'platform_departments: % still holds % open incidence(s). Move them to another desk first.',
      new.name, v_open using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists platform_departments_archive_guard on platform_departments;
create trigger platform_departments_archive_guard
  before update of deleted_at on platform_departments
  for each row execute function platform_auth.desk_holds_no_open_tickets();

-- ============================================================
-- 6. two acts the register had no word for
-- ============================================================

-- 'routed' is the rule doing it, 'escalated' is the desk above doing it. Both are distinct
-- from 'allocated', which is a person moving a call by hand, and the register that cannot
-- tell them apart cannot answer "why did this land on us?".
alter table support_ticket_events
  drop constraint if exists support_ticket_events_action_check;
alter table support_ticket_events
  add constraint support_ticket_events_action_check check (action in (
    'logged','allocated','reallocated','routed','escalated','status_changed',
    'priority_changed','note_added','resolved','reopened','closed','withdrawn'));

-- ============================================================
-- 7. grants: the doors app_runtime may use, and nothing else
-- ============================================================

-- The clock functions, the number minter, the matcher and the counter are the doors. A new
-- function defaults to EXECUTE for PUBLIC, so the revoke is taken on the way in — 079, 096
-- and 110 are each the same lesson learned once. `department_open_tickets` is granted to
-- app_runtime because the archive guard reaches it through a trigger body that runs with the
-- firing seat's rights; if the seat cannot call it, the guard fails open on every close.
grant execute on function
  platform_auth.next_ticket_number(uuid),
  platform_auth.route_ticket(uuid, text, text, text, text, int),
  platform_auth.department_open_tickets(uuid),
  platform_auth.work_minutes(timestamptz, int, jsonb),
  platform_auth.inside_hours(timestamptz, jsonb)
to app_runtime;

revoke all on function
  platform_auth.next_ticket_number(uuid),
  platform_auth.route_ticket(uuid, text, text, text, text, int),
  platform_auth.department_open_tickets(uuid),
  platform_auth.work_minutes(timestamptz, int, jsonb),
  platform_auth.inside_hours(timestamptz, jsonb)
from public, anon, authenticated, service_role;

-- A trigger body is fired, never called: the owner alone holds it, as 121 did its register
-- guard. These sit in platform_auth because that is where every other definer in this schema
-- lives — inventing a second schema would put the guards somewhere the audit scripts do not
-- look.
revoke all on function
  platform_auth.department_hours_are_readable(),
  platform_auth.escalation_path_does_not_loop(),
  platform_auth.desk_holds_no_open_tickets()
from public, anon, authenticated, service_role, app_runtime;

-- ============================================================
-- 8. the state this leaves the platform in
-- ============================================================

do $$ declare
  v_depts int;
  v_clocked int;
  v_rules int;
begin
  select count(*)::int into v_depts from platform_departments where deleted_at is null;
  select count(*)::int into v_clocked from platform_departments
   where deleted_at is null and (first_response_minutes is not null
                                 or resolve_minutes is not null);
  select count(*)::int into v_rules from support_ticket_routes where deleted_at is null;
  raise notice '123: desks keep hours — % department(s), % with a clock set, % routing rule(s); '
    'no promise is invented for a desk the office has not given one',
    v_depts, v_clocked, v_rules;
end $$;

commit;
