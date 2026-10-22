-- 125 — one inbox for every source the office actually hears from (task #340).
--
-- 101 put the calls in a register and 123 gave the desks hours, a promise and a queue number.
-- What the office still cannot do is treat a WhatsApp the same way it treats a phone call. The
-- spec's own line for this stage: "cross-source channel (chat/email/WhatsApp/call/web form),
-- full status machine with a reopen window, merge duplicates, tags, canned replies sw/en,
-- attachments, SLA breach alerts, auto-routing, bulk actions". Auto-routing and the clocks are
-- already facts of the schema since 123, and the bulk actions are the same statements run in a
-- loop by a route. The rest is here.
--
--   the sources        chat and web_form join the six channels; the routing rules accept the
--                      same list, so a rule can say "everything from the web form goes to
--                      Support" before the web form exists
--   the reopen         a desk may set a window in days; outside it the register refuses the
--                      reopen, because "we closed it in March" has to be answered by a
--                      supervisor and not by whoever has the mouse
--   the merge          a duplicate is folded into one live line and keeps its own evidence.
--                      A fold is one-way, and the folded line stops counting everywhere
--   the tags           short names on an incidence, so a queue can be read as "everything
--                      with port delay on it" without waiting for a full-text hit
--   the replies        canned answers in both languages the office works in, with a fixed set
--                      of placeholders that a second file in the API agrees with
--   the files          a photograph of a licence can sit on the incidence it is about
--   the breach         the clock existed; this adds the fact that somebody was told
--
-- Two things this migration does NOT do, stated rather than left to be discovered: it does not
-- open an anonymous public web form (an intake endpoint that writes to the platform's register
-- with no session behind it is its own stage, with its own limiter), and it does not connect
-- WhatsApp or chat ingestion. Widening the channel list is what makes the queue able to hold
-- those sources the day a gateway arrives; pretending the gateway exists would put a live
-- integration in a migration that was only asked to make room for one.
begin;

-- ============================================================
-- 1. every source, in one list
-- ============================================================

-- The register's own list. `chat` is a conversation inside the portal (a live thread, not the
-- asynchronous portal_message an office replies to a day later) and `web_form` is the intake
-- page the marketing site will one day post here. Both are named now so a channel value
-- arriving from either cannot be rejected by the table that is supposed to record it.
alter table support_tickets
  drop constraint if exists support_tickets_channel_check;
alter table support_tickets
  add constraint support_tickets_channel_check check (channel in (
    'phone_call','whatsapp','email','walk_in','portal_message','chat','web_form','other'));

-- The rule that reads the channel has to accept the same words or a web-form call routes to
-- nobody. Restated whole, the way 123 restated the events list.
alter table support_ticket_routes
  drop constraint if exists support_ticket_routes_channels_check;
alter table support_ticket_routes
  add constraint support_ticket_routes_channels_check check (
    channels <@ array['phone_call','whatsapp','email','walk_in','portal_message',
                      'chat','web_form','other']);

-- ============================================================
-- 2. the reopen window
-- ============================================================

alter table platform_departments
  -- Calendar days, not working days. A caller does not experience the desk's week: they
  -- experienced the day they were told it was finished. NULL is "this desk never said", and
  -- the register then allows a reopen whenever a clerk with the duty presses the button —
  -- inventing a 7-day default for six desks the office has never measured would be 123's
  -- invented-promise mistake all over again.
  add column if not exists reopen_days int
    check (reopen_days is null or reopen_days between 1 and 90);

alter table support_tickets
  -- How many times this incidence has come back. Kept by the trigger below rather than by the
  -- route that asked for the reopen, so a desk cannot end up with a count that only some of
  -- its reopens are in.
  add column if not exists reopen_count int not null default 0
    check (reopen_count between 0 and 99),
  add column if not exists last_reopened_at timestamptz;

-- The window, enforced where the state changes. Keyed on the transition out of a settled
-- status, because that and not the word "reopen" is what the act is: the statement that moves
-- a resolved incidence back to in_progress comes through here whether the clerk meant it as a
-- reopen, an un-resolve or a mistake. It also writes the count and re-makes the promise, so
-- both are true for every reopened line and not only for the ones the first route remembered.
create or replace function platform_auth.reopen_stays_inside_its_window()
returns trigger language plpgsql set search_path = public as $$ declare
  v_days int;
  v_name text;
  v_wait numeric;
  v_response int;
  v_resolve int;
  v_hours jsonb;
begin
  if old.status not in ('resolved','closed') then return new; end if;
  if new.status not in ('open','allocated','in_progress') then return new; end if;

  select d.reopen_days, d.name into v_days, v_name
    from platform_departments d where d.id = old.department_id;

  if v_days is not null then
    -- Measured from the settle, never from the read: a line resolved 40 days ago is 40 days
    -- old on the day the reopen is asked for, whichever clock the desk is on.
    v_wait := extract(epoch from (now() - old.resolved_at)) / 86400.0;
    if v_wait > v_days then
      -- The number is made into text here, not in the format string: plpgsql RAISE substitutes
      -- every % with the next argument and knows nothing about printf widths, so a "%.1f" in the
      -- sentence prints the value and then the literal ".1f" after it. The sentence is one line
      -- because the doors read only its first line.
      raise exception
        'support_tickets: % was settled % day(s) ago and % gives % day(s) to reopen it - log the new call as its own incidence and fold it onto this one instead',
        old.ref, round(v_wait, 1)::text, coalesce(v_name, 'the desk'), v_days
        using hint = 'Widen the desk''s reopen window on its Terms panel, or fold the new call onto this line.',
              errcode = '23514';
    end if;
  end if;

  new.reopen_count := old.reopen_count + 1;
  new.last_reopened_at := now();

  -- The promise is re-made from the minute work resumes, counted in the desk's own open hours
  -- exactly as the arrival was. A desk that reopens a line owes the caller a new answer;
  -- keeping a deadline that already passed would make every reopened line read as a breach
  -- the moment it moves, which is a number nobody can act on. A desk with no SLA set keeps
  -- "no clock" rather than being handed one here.
  select d.first_response_minutes, d.resolve_minutes, d.business_hours
    into v_response, v_resolve, v_hours
    from platform_departments d where d.id = new.department_id;
  if v_response is not null then
    new.response_due_at := platform_auth.work_minutes(now(), v_response, v_hours);
  end if;
  if v_resolve is not null then
    new.resolution_due_at := platform_auth.work_minutes(now(), v_resolve, v_hours);
  end if;
  return new;
end $$;

drop trigger if exists support_tickets_reopen_window on support_tickets;
create trigger support_tickets_reopen_window
  before update of status on support_tickets
  for each row execute function platform_auth.reopen_stays_inside_its_window();

-- ============================================================
-- 3. duplicates, folded into one live line
-- ============================================================

alter table support_tickets
  -- The line that stays. Not called `duplicate_of`: the register already says what happened in
  -- its events, and this column's job is to answer "where did this call go?" in one read.
  -- RESTRICT, not SET NULL: a folded line whose keeper had been hard-deleted would be evidence
  -- pointing at nothing, and the CHECK below would refuse the nulling anyway.
  add column if not exists merged_into_id uuid references support_tickets(id) on delete restrict,
  add column if not exists merged_at timestamptz,
  add column if not exists merged_by uuid references users(id) on delete set null;

-- 'merged' is a status rather than only a pointer, because every existing read of the queue —
-- the desk load, the SLA partial indexes, `department_open_tickets`, the KPI counts — already
-- filters on status. A pointer with no status would have to be excluded in eight places and
-- missed in the ninth; a sixth status is one place.
alter table support_tickets
  drop constraint if exists support_tickets_status_check;
alter table support_tickets
  add constraint support_tickets_status_check check (status in (
    'open','allocated','in_progress','resolved','closed','merged'));

-- A folded line needs no desk: the desk it was sitting with is the desk that folded it, and an
-- incidence never allocated can be a duplicate just as easily as one that was. 101 wrote this
-- rule as the first of four anonymous table CHECKs, so it is found by what it says and not by
-- the number it happened to get, and restated with a name the next migration can read.
--
-- The comparison strips spaces AND parentheses, because `pg_get_constraintdef()` wraps the
-- expression in a paren of its own: the text on this server is
-- `CHECK (((status = 'open'::text) OR (department_id IS NOT NULL)))` — three deep, not the two
-- an author writes by hand. A shape match that counts brackets silently matches nothing, which
-- is the worst kind of miss: the migration runs, prints no notice, and the old rule stays.
do $$ declare
  r record;
  v_shape constant text := 'checkstatus=''open''::textordepartment_idisnotnull';
begin
  for r in
    select c.conname,
           translate(lower(pg_get_constraintdef(c.oid)), ' ()', '') as shape
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'support_tickets' and c.contype = 'c'
  loop
    if r.shape = v_shape then
      execute format('alter table support_tickets drop constraint %I', r.conname);
      raise notice '125: dropped 101''s desk requirement (%)', r.conname;
    end if;
  end loop;
end $$;
alter table support_tickets
  drop constraint if exists support_tickets_needs_a_desk_once_it_moved;
alter table support_tickets
  add constraint support_tickets_needs_a_desk_once_it_moved check (
    status in ('open','merged') or department_id is not null);

-- Loud rather than lucky: if the old rule were still on the table, folding an unallocated
-- duplicate would fail on a constraint nobody would think to look for. Both halves are checked
-- — the old shape is gone, and the named restatement is what replaced it — because a drop loop
-- that matches nothing and an add that never ran look identical from the outside.
do $$ declare
  v_left int;
  v_named int;
begin
  select count(*)::int into v_left
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where t.relname = 'support_tickets' and c.contype = 'c'
     and translate(lower(pg_get_constraintdef(c.oid)), ' ()', '')
         = 'checkstatus=''open''::textordepartment_idisnotnull';
  select count(*)::int into v_named from pg_constraint c
    join pg_class t on t.oid = c.conrelid
   where t.relname = 'support_tickets' and c.conname = 'support_tickets_needs_a_desk_once_it_moved';
  if v_left > 0 or v_named = 0 then
    raise exception
      '125: support_tickets carries % anonymous "open needs a desk" CHECK(s) and % named restatement(s) — a folded line with no desk would be refused'
      , v_left, v_named
      using errcode = 'P0001';
  end if;
end $$;

alter table support_tickets
  drop constraint if exists support_tickets_fold_is_whole;
alter table support_tickets
  add constraint support_tickets_fold_is_whole check (
    -- The status and the pointer are the same fact stated twice, so they cannot disagree: a
    -- line that says it is folded points at the line it went into, and a line that points at
    -- another is not on the boards.
    (status = 'merged') = (merged_into_id is not null)
    -- and the two words that say who did it and when arrive together or not at all.
    and (merged_at is null or (merged_by is not null and merged_into_id is not null)));

create index if not exists support_tickets_folded_into
  on support_tickets (merged_into_id) where merged_into_id is not null;

-- The fold itself. Every refusal here is a call that would otherwise be quietly lost: folded
-- into a line that is itself folded (so the number the caller was given points at nothing
-- readable), into itself, into a retired line, or across a tenant boundary.
create or replace function platform_auth.merge_keeps_one_line_per_call()
returns trigger language plpgsql set search_path = public as $$ declare
  v_target_ref text;
  v_target_status text;
  v_target_tenant uuid;
  v_target_deleted timestamptz;
  v_target_into uuid;
  v_from_ref text;
  v_from_into uuid;
begin
  if new.merged_into_id is not distinct from old.merged_into_id then return new; end if;

  if new.merged_into_id is null then
    raise exception
      'support_tickets: % is folded into another incidence; unfolding is not an act this register has',
      old.ref using hint = 'Open a fresh incidence instead — the fold is the record of why.',
            errcode = '23514';
  end if;

  if new.merged_into_id = old.id then
    raise exception 'support_tickets: % cannot be folded into itself', old.ref
      using errcode = '23514';
  end if;

  select t.ref, t.status, t.tenant_id, t.deleted_at, t.merged_into_id
    into v_target_ref, v_target_status, v_target_tenant, v_target_deleted, v_target_into
    from support_tickets t where t.id = new.merged_into_id;
  if v_target_ref is null then
    raise exception 'support_tickets: % cannot be folded into an incidence that is not on the register',
      old.ref using errcode = '23503';
  end if;
  if v_target_deleted is not null then
    raise exception 'support_tickets: % cannot be folded into the retired incidence %',
      old.ref, v_target_ref using errcode = '23514';
  end if;
  if v_target_into is not null then
    raise exception
      'support_tickets: % cannot be folded into %, which is itself folded into another line',
      old.ref, v_target_ref
      using hint = 'Fold duplicates into the line that is still on the boards.',
            errcode = '23514';
  end if;
  if v_target_tenant <> old.tenant_id then
    raise exception 'support_tickets: % belongs to another organisation than %',
      old.ref, v_target_ref using errcode = '42501';
  end if;

  -- A fold is one-way, with exactly one exception: the line this one was already folded into
  -- has itself been folded onward, and the duplicates follow their keeper's keeper. Anything
  -- else that moves a set pointer is somebody un-doing a decision the register wrote down.
  if old.merged_into_id is not null then
    select t.ref, t.merged_into_id into v_from_ref, v_from_into
      from support_tickets t where t.id = old.merged_into_id;
    if new.merged_into_id is distinct from v_from_into then
      raise exception
        'support_tickets: % is already folded into %; a fold is only followed onward, never moved',
        old.ref, coalesce(v_from_ref, 'a line no longer on the register')
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.status <> 'merged' then
    raise exception 'support_tickets: % can only be folded by becoming merged', old.ref
      using errcode = '23514';
  end if;
  if new.merged_at is null or new.merged_by is null then
    raise exception 'support_tickets: the fold of % needs the seat that made it and the minute it was made',
      old.ref using errcode = '23514';
  end if;
  if old.deleted_at is not null then
    raise exception 'support_tickets: % is already retired; it cannot be folded as well', old.ref
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists support_tickets_merge_guard on support_tickets;
create trigger support_tickets_merge_guard
  before update of merged_into_id, status, merged_at, merged_by on support_tickets
  for each row execute function platform_auth.merge_keeps_one_line_per_call();

-- A caller may be given the number of a line that is later folded, so the duplicates under it
-- must not be left pointing at a closed door. Runs after the fold because it re-points rows of
-- the table it fires on; the guard above recognises exactly this change and allows it, and
-- refuses every other one. Recursion stops at the first step, since a folded line can never be
-- a target (the guard says so), so a duplicate has no duplicates of its own.
create or replace function platform_auth.merge_follows_its_keeper()
returns trigger language plpgsql set search_path = public as $$ begin
  if new.merged_into_id is null or new.merged_into_id = old.merged_into_id then
    return null;
  end if;
  update support_tickets
     set merged_into_id = new.merged_into_id
   where merged_into_id = new.id and status = 'merged' and deleted_at is null;
  return null;
end $$;

drop trigger if exists support_tickets_merge_cascade on support_tickets;
create trigger support_tickets_merge_cascade
  after update of merged_into_id on support_tickets
  for each row execute function platform_auth.merge_follows_its_keeper();

-- ============================================================
-- 4. tags
-- ============================================================

create table if not exists support_ticket_tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- Lowercase in the CHECK, not by convention: two tags that differ only in case are two tags
  -- that a desk will spend an afternoon working out are the same one.
  name text not null check (name ~ '^[a-z0-9][a-z0-9 ._+-]{1,27}$'),
  -- A hex colour rather than a word, so the queue renders the same chip everywhere and a tag
  -- cannot be written in a colour the theme has no name for.
  colour text check (colour is null or colour ~ '^#[0-9a-fA-F]{6}$'),
  note text check (note is null or char_length(trim(note)) <= 160),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users(id),
  updated_by uuid references users(id),
  deleted_at timestamptz,
  deleted_by uuid references users(id)
);
create unique index if not exists support_ticket_tags_name_live
  on support_ticket_tags (tenant_id, name) where deleted_at is null;
drop trigger if exists trg_support_ticket_tags_updated on support_ticket_tags;
create trigger trg_support_ticket_tags_updated before update on support_ticket_tags
  for each row execute function public.set_updated_at();

create table if not exists support_ticket_taggings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  ticket_id uuid not null references support_tickets(id),
  tag_id uuid not null references support_ticket_tags(id),
  applied_by uuid references users(id),
  applied_at timestamptz not null default now(),
  -- Retired, not deleted: "who had this tagged port delay, and when did they take it off" is
  -- the question a tag answers when something went wrong, and 101's rule that a purged
  -- incidence is the one thing a support register cannot afford applies to its labels too.
  deleted_at timestamptz,
  deleted_by uuid references users(id)
);
create unique index if not exists support_ticket_taggings_live
  on support_ticket_taggings (ticket_id, tag_id) where deleted_at is null;
create index if not exists support_ticket_taggings_by_tag
  on support_ticket_taggings (tag_id, applied_at desc) where deleted_at is null;

-- A tag line has to name a live incidence and a live tag in the same tenant, or the queue
-- filter would show a chip that opens nothing. The route could check; the next route that
-- writes a tagging would not, which is the reason this is a trigger.
create or replace function platform_auth.tagging_names_a_live_pair()
returns trigger language plpgsql set search_path = public as $$ declare
  v_ticket_status text;
  v_ticket_tenant uuid;
  v_ticket_deleted timestamptz;
  v_tag_tenant uuid;
  v_tag_deleted timestamptz;
begin
  if new.deleted_at is not null then return new; end if;

  select t.status, t.tenant_id, t.deleted_at
    into v_ticket_status, v_ticket_tenant, v_ticket_deleted
    from support_tickets t where t.id = new.ticket_id;
  if v_ticket_tenant is null then
    raise exception 'support_ticket_taggings: no incidence % on the register', new.ticket_id
      using errcode = '23503';
  end if;
  if v_ticket_deleted is not null then
    raise exception 'support_ticket_taggings: % is retired and cannot be tagged', new.ticket_id
      using errcode = '23514';
  end if;
  if v_ticket_status = 'merged' then
    raise exception 'support_ticket_taggings: % is folded into another line; tag the keeper',
      new.ticket_id using errcode = '23514';
  end if;

  select g.tenant_id, g.deleted_at into v_tag_tenant, v_tag_deleted
    from support_ticket_tags g where g.id = new.tag_id;
  if v_tag_tenant is null then
    raise exception 'support_ticket_taggings: no tag %', new.tag_id using errcode = '23503';
  end if;
  if v_tag_deleted is not null then
    raise exception 'support_ticket_taggings: that tag is retired and cannot be applied'
      using errcode = '23514';
  end if;
  if v_ticket_tenant <> new.tenant_id or v_tag_tenant <> new.tenant_id then
    raise exception 'support_ticket_taggings: a tagging cannot cross a tenant'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists support_ticket_taggings_live_pair on support_ticket_taggings;
create trigger support_ticket_taggings_live_pair
  before insert or update of ticket_id, tag_id, tenant_id, deleted_at on support_ticket_taggings
  for each row execute function platform_auth.tagging_names_a_live_pair();

alter table support_ticket_tags enable row level security;
drop policy if exists support_ticket_tags_tenant on support_ticket_tags;
create policy support_ticket_tags_tenant on support_ticket_tags for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on support_ticket_tags to app_runtime;
revoke all on support_ticket_tags from public, anon, authenticated, service_role;

alter table support_ticket_taggings enable row level security;
drop policy if exists support_ticket_taggings_tenant on support_ticket_taggings;
create policy support_ticket_taggings_tenant on support_ticket_taggings for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on support_ticket_taggings to app_runtime;
revoke all on support_ticket_taggings from public, anon, authenticated, service_role;

-- ============================================================
-- 5. canned replies, in both working languages
-- ============================================================

create table if not exists support_canned_replies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  -- Typed, not picked from a list, because the clerk who is mid-call searches by the words
  -- they would say: `otp_not_arriving` is the thing they are looking for.
  slug text not null check (slug ~ '^[a-z0-9_]{3,30}$'),
  title text not null check (char_length(trim(title)) between 3 and 80),
  body_en text not null check (char_length(trim(body_en)) between 4 and 1200),
  -- Swahili is optional per reply, not per desk: some answers only exist in English (a customs
  -- form is a customs form), and forcing a machine-translation into the column would put words
  -- in the office's mouth that the office never chose.
  body_sw text check (body_sw is null or char_length(trim(body_sw)) between 4 and 1200),
  category text check (category is null or category in (
    'onboarding','account_access','licence_billing','cargo_clearing','transport_fleet',
    'marketplace_directory','system_error','complaint','other')),
  is_active boolean not null default true,
  note text check (note is null or char_length(trim(note)) <= 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references users(id),
  updated_by uuid references users(id),
  deleted_at timestamptz,
  deleted_by uuid references users(id)
);
create unique index if not exists support_canned_replies_slug_live
  on support_canned_replies (tenant_id, slug) where deleted_at is null;
create index if not exists support_canned_replies_category
  on support_canned_replies (tenant_id, category) where deleted_at is null;
drop trigger if exists trg_support_canned_replies_updated on support_canned_replies;
create trigger trg_support_canned_replies_updated before update on support_canned_replies
  for each row execute function public.set_updated_at();

-- Every placeholder the office can fill has to be one the renderer knows.
-- api/src/inbox/replies.ts holds the same list and the function that substitutes; this trigger
-- is what stops a desk writing {plate} into a body that would then reach a caller with
-- "{plate}" still in it. Braces are removed only when they name a known token, so anything
-- left over is either an invented token or an unbalanced brace.
create or replace function platform_auth.canned_reply_tokens_are_known()
returns trigger language plpgsql set search_path = public as $$ declare
  v_body text;
  v_rest text;
begin
  foreach v_body in array array[new.body_en, new.body_sw] loop
    v_rest := coalesce(v_body, '');
    if v_rest = '' then continue; end if;
    v_rest := regexp_replace(v_rest,
      '\{(name|ref|company|department|agent|subject)\}', '', 'g');
    if v_rest ~ '[{}]' then
      raise exception
        'support_canned_replies: a body uses a placeholder this register does not know'
        using hint = 'Only {name}, {ref}, {company}, {department}, {agent} and {subject} are filled in.',
              errcode = '22023';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists support_canned_replies_tokens on support_canned_replies;
create trigger support_canned_replies_tokens
  before insert or update of body_en, body_sw on support_canned_replies
  for each row execute function platform_auth.canned_reply_tokens_are_known();

alter table support_canned_replies enable row level security;
drop policy if exists support_canned_replies_tenant on support_canned_replies;
create policy support_canned_replies_tenant on support_canned_replies for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on support_canned_replies to app_runtime;
revoke all on support_canned_replies from public, anon, authenticated, service_role;

-- Four answers the office gives every week, in both languages, into the platform tenant that
-- owns the register — and only where the slug is not already taken, so a desk that has edited
-- "otp_not_arriving" into its own words is not walked over by a re-run.
insert into support_canned_replies (tenant_id, slug, title, body_en, body_sw, category)
select t.id, r.slug, r.title, r.body_en, r.body_sw, r.category
  from (select id from tenants where type = 'platform' and deleted_at is null) t
 cross join (values
   ('otp_not_arriving', 'A code that did not arrive',
    'Hello {name}, the code for {company} is sent by email and can take a minute to land. '
    || 'Open the spam folder first, then ask for it again from the same page. If nothing has '
    || 'arrived after ten minutes, reply here and {department} will keep {ref} open until you '
    || 'have the code.',
    'Habari {name}, msimbo wa {company} tumetuma kwa barua pepe; unaweza kuchukua dakika kufika. '
    || 'Kwanza angalia folda ya spam, kisha ulize msimbo tena kutoka ukurasa ule ule. Ukibaki '
    || 'bila msimbo baada ya dakika kumi, jibu hapa na {department} itaweka {ref} wazi hadi upate '
    || 'msimbo.',
    'account_access'),
   ('licence_paid_waiting', 'Paid, licence not yet on file',
    'Hello {name}, thank you for the payment for {company}. The licence is issued by '
    '{department} once the payment is confirmed, which is normally the same working day. We '
    'will answer on {ref} the moment the document is on your profile.',
    'Habari {name}, asante kwa malipo ya {company}. Leseni hutolewa na {department} baada ya '
    'malipo kuthibitishwa, ambayo mara nyingi hufika siku moja ya kazi. Tutakujulisha kwenye '
    '{ref} hati itakapoweka kwenye profile yako.',
    'licence_billing'),
   ('cargo_paper_missing', 'A file waiting on one paper',
    'Hello {name}, the file {ref} for {company} is waiting on one document before it can move: '
    'the delivery order, the assessment or the release note. {department} will name the exact '
    'paper and the office holding it.',
    'Habari {name}, faili {ref} ya {company} inasubiri hati moja kabla ya kusogea: delivery '
    'order, assessment au release note. {department} atataja hati mahususi na ofisi inayoishikilia.',
    'cargo_clearing'),
   ('trip_position_stale', 'A trip that stopped moving',
    'Hello {name}, the position of {company}''s trip is read from the driver''s phone. When it '
    'stops moving for more than an hour, {department} calls the driver before the tracker is '
    'believed, and answers on {ref} with the last point we could confirm.',
    'Habari {name}, mahali gari la {company} lipo husomwa kutoka simu ya dereva. Tukisimama kwa '
    'zaidi ya saa moja, {department} atapiga dereva simu kabla ya kumwamini, tutajibu kwenye '
    '{ref} kwa nukta ya mwisho ambayo tumethibitisha.',
    'transport_fleet')
 ) as r(slug, title, body_en, body_sw, category)
 where not exists (
   select 1 from support_canned_replies e
    where e.tenant_id = t.id and e.slug = r.slug);

-- ============================================================
-- 6. a photograph of the licence belongs on the incidence about it
-- ============================================================

-- One new entity kind on the platform's own file table. The control route writes these itself;
-- documents.routes.ts keeps its ENTITY_KINDS list closed, because a tenant seat must not be
-- able to attach a file to the platform's register. 028's idx_documents_entity already covers
-- (tenant_id, entity_type, entity_id) for live rows, so the list read needs no new index.
alter table documents
  drop constraint if exists documents_entity_type_check;
alter table documents
  add constraint documents_entity_type_check check (entity_type in (
    'tenant','user','vessel','driver','trip','shipment','message','licence','employee',
    'office_cost','quotation','cargo_intake','work_order','warehouse_stay','support_ticket'));

-- ============================================================
-- 7. a breach that somebody was told about
-- ============================================================

alter table support_tickets
  -- The clock and its deadlines are 123's; what was missing is the fact that a human was
  -- notified. Kept on the incidence rather than in a separate alerts table because the alert is
  -- about this one line, and a desk that has already raised it must not raise it twice a day.
  -- Re-alerting after twelve hours is allowed by the route, which is a decision about people,
  -- not a fact about rows.
  add column if not exists breach_alerted_at timestamptz,
  add column if not exists breach_alerted_by uuid references users(id) on delete set null;

alter table support_tickets
  drop constraint if exists support_tickets_breach_alert_is_whole;
alter table support_tickets
  add constraint support_tickets_breach_alert_is_whole check (
    (breach_alerted_at is null) = (breach_alerted_by is null));

create index if not exists support_tickets_breach_board
  on support_tickets (resolution_due_at)
  where deleted_at is null and status in ('open','allocated','in_progress')
    and resolution_due_at is not null;

-- The notice itself leaves through 112's delivery register, whose purpose column is a closed
-- list — so a breach alert would have been filed under somebody else's purpose ('tenant_notice'
-- is the obvious lie, and the desk reading the register afterwards would believe it). One new
-- purpose, restated in both places that hold the list: the table CHECK and the writer's own
-- guard, which 112 wrote as a second copy on purpose so a caller cannot slip an unknown purpose
-- past it. They must agree, and verify-inbox-sql.ts asserts exactly that.
alter table message_deliveries
  drop constraint if exists message_deliveries_purpose_check;
alter table message_deliveries
  add constraint message_deliveries_purpose_check check (purpose in (
    'signup_otp', 'otp_resend', 'password_reset', 'staff_invite',
    'tenant_notice', 'platform_test', 'sla_breach'));

create or replace function platform_auth.record_message_delivery(
  p_channel text,
  p_purpose text,
  p_to text,
  p_subject text,
  p_status text,
  p_provider text,
  p_provider_message_id text,
  p_error text,
  p_attempts int,
  p_tenant_id uuid,
  p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$ declare
  v_masked text;
begin
  if p_channel is null or p_channel not in ('email','sms') then return; end if;
  if p_purpose is null or p_purpose not in (
     'signup_otp','otp_resend','password_reset','staff_invite','tenant_notice','platform_test',
     'sla_breach')
  then return; end if;
  if p_status is null or p_status not in ('sent','failed','skipped') then return; end if;
  if trim(coalesce(p_to, '')) = '' then return; end if;

  -- Masked here, not by the caller: one rule for how an address is shortened is one rule to
  -- keep honest, and a route that forgets cannot leak into this column.
  if p_channel = 'email' then
    v_masked := case
      when position('@' in p_to) > 1
        then left(split_part(p_to, '@', 1), 1) || '***@' || lower(split_part(p_to, '@', 2))
      else '***' end;
  else
    -- A phone keeps its last four digits and its country prefix, which is enough to tell two
    -- directors of one company apart and not enough to dial.
    v_masked := case
      when char_length(p_to) > 8
        then left(p_to, 4) || '***' || right(p_to, 4)
      else '***' end;
  end if;

  insert into message_deliveries (channel, purpose, to_masked, subject, status, provider,
                                  provider_message_id, error, attempts, tenant_id, user_id)
  values (p_channel, p_purpose, left(v_masked, 160), left(p_subject, 200), p_status,
          left(coalesce(nullif(p_provider, ''), 'resend'), 40),
          left(p_provider_message_id, 120), left(p_error, 500),
          case when p_attempts between 1 and 5 then p_attempts else 1 end,
          p_tenant_id, p_user_id);
exception when others then
  return;
end $$;

-- ============================================================
-- 8. the acts the register had no word for
-- ============================================================

-- 'merged' is the fold, 'tagged'/'untagged' the label put on and taken off, 'file_attached'/
-- 'file_dropped' the paper, and 'alerted' the desk head who was told the clock ran out.
alter table support_ticket_events
  drop constraint if exists support_ticket_events_action_check;
alter table support_ticket_events
  add constraint support_ticket_events_action_check check (action in (
    'logged','allocated','reallocated','routed','escalated','status_changed',
    'priority_changed','note_added','resolved','reopened','closed','withdrawn',
    'merged','tagged','untagged','file_attached','file_dropped','alerted'));

-- ============================================================
-- 9. grants
-- ============================================================

-- A trigger body is fired, never called: the owner alone holds these, as in 121 and 123.
revoke all on function
  platform_auth.reopen_stays_inside_its_window(),
  platform_auth.merge_keeps_one_line_per_call(),
  platform_auth.merge_follows_its_keeper(),
  platform_auth.tagging_names_a_live_pair(),
  platform_auth.canned_reply_tokens_are_known()
from public, anon, authenticated, service_role, app_runtime;

-- `create or replace` keeps the ACL a function already had, but the door the breach alert walks
-- out of is restated rather than assumed (079, 096 and 110 are each the same lesson).
grant execute on function
  platform_auth.record_message_delivery(text, text, text, text, text, text, text, text, int, uuid, uuid)
to app_runtime;
revoke all on function
  platform_auth.record_message_delivery(text, text, text, text, text, text, text, text, int, uuid, uuid)
from public, anon, authenticated, service_role;

-- No new duty keys. Everything this stage adds is done from the register a seat can already
-- read and write: `control.tickets.view` sees the tags, the folds, the files and the breach
-- board; `control.tickets.manage` folds, tags, files and alerts. A seventh key for "bulk"
-- would be a duty that means "the same act, twice", which is not a duty.

-- ============================================================
-- 10. the state this leaves the platform in
-- ============================================================

do $$ declare
  v_replies int;
  v_tags int;
  v_windowed int;
  v_folded int;
begin
  select count(*)::int into v_replies from support_canned_replies where deleted_at is null;
  select count(*)::int into v_tags from support_ticket_tags where deleted_at is null;
  select count(*)::int into v_windowed from platform_departments
   where deleted_at is null and reopen_days is not null;
  select count(*)::int into v_folded from support_tickets where status = 'merged';
  raise notice '125: one inbox for every source — 8 channels, % canned reply(s), % tag(s), '
    '% folded line(s); % desk(s) has said how long it lets a call reopen, the rest say nothing',
    v_replies, v_tags, v_folded, v_windowed;
end $$;

commit;
