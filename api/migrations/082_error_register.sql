-- 082 — the register that catches what the system gets wrong (task #130, "all errors must be collected").
--
-- The panel could already say a great deal about money, seats and duties, and nothing at
-- all about reliability. `control-system.routes.ts` said so out loud in its own
-- NOT_MEASURED list: "The API has no metrics endpoint, no request-timing store and no
-- error collector." So a 500 on a screen nobody opens until a customer does was written
-- to the process log and lost with the next dyno restart — the operator learned about it
-- when the customer did, if at all.
--
-- This file is the collector. Two kinds, one register:
--   server  — every response the API's own error handler answered with 5xx. The message,
--             the stack, the route, the normalised path, the request id the caller was
--             given, and the tenant/seat the request was carrying when it broke.
--   client  — what the browser reports about itself: a render crash caught by the error
--             boundary, an unhandled rejection, a window error, and any fetch that came
--             back 5xx. These arrive over a PUBLIC endpoint, so they are schema-bound,
--             size-capped, scrubbed of contact-shaped strings, and they never carry a
--             tenant or an actor — a caller cannot write itself into somebody else's
--             error history, and an anonymous visitor's crash still gets recorded.
--
-- The shape is a rollup, not an event log: one row per (fingerprint, minute). A route
-- that fails four thousand times in a minute is one row with repeats = 3999, which is
-- what makes the register survivable — a storm costs a row, not a table. The fingerprint
-- is a hash of kind + code + status + route + the message with its digits and quotes
-- stripped, so the same bug at 09:00 and 14:00 is one line, and two different bugs in one
-- route are two.
--
-- Posture, deliberately the same as 078's tenant_actions: RLS enabled with NO policies and
-- NO table grants, so the register is unreachable from a handler. Every door is a
-- SECURITY DEFINER function in platform_auth, including the writer — the point is that a
-- bug in a route cannot be edited into silence by the same route. Reads are gated by
-- control.system.view, triage and retention by control.system.manage, and both are audited
-- by the handler that calls them.
--
-- Retention is an action, not a background job. Deleting evidence of a failure is a
-- decision a person makes, so prune_errors is granted to no DML path: it exists as a
-- definer that the desk calls explicitly, keeps the last N days, and writes an audit row
-- saying who did it.

begin;

-- ============================================================
-- 1. the register
-- ============================================================

create table if not exists app_errors (
  id bigint generated always as identity primary key,
  -- date_trunc('minute', now()) at write time. Part of the key, not a display field:
  -- it is what ON CONFLICT folds a storm into one line.
  bucket timestamptz not null,
  fingerprint text not null,
  kind text not null check (kind in ('server','client')),
  -- Our error code (INTERNAL, …) for a server row; the JS error name for a client row.
  code text,
  -- The status the caller was answered with. Client rows carry the status of the fetch
  -- that failed, which is often a different number to the one the user saw.
  status int check (status is null or (status >= 100 and status <= 599)),
  method text,
  -- Normalised before it gets here: no query string, every id-shaped segment replaced by
  -- :id, so the path column groups instead of exploding into one line per order number.
  path text,
  -- Fastify's routeKey when the request reached a route (null for a framing refusal).
  route text,
  message text not null,
  -- Stack for a server row, component trace for a client row. Never rendered raw.
  detail text,
  request_id text,
  -- Server-observed attribution only. See the header: no caller supplies these.
  tenant_id uuid,
  actor_user_id uuid,
  ip text,
  user_agent text,
  environment text,
  first_ts timestamptz not null default now(),
  last_ts timestamptz not null default now(),
  -- Extra occurrences folded into this row. Total failures = rows + sum(repeats).
  repeats int not null default 0,
  unique (fingerprint, bucket)
);
create index app_errors_last_ts on app_errors (last_ts desc);
create index app_errors_kind_last_ts on app_errors (kind, last_ts desc);
create index app_errors_fingerprint on app_errors (fingerprint, last_ts desc);

-- Triage lives beside the register, never inside it. A row in app_errors is a fact about
-- a response that happened; a note here is a person's judgement about it. Keeping them
-- apart is what lets the register stay writable by exactly one function.
create table if not exists app_error_notes (
  fingerprint text primary key,
  state text not null default 'open'
    check (state in ('open','triaged','resolved','ignored')),
  note text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  check (note is null or char_length(note) <= 600)
);

alter table app_errors enable row level security;
alter table app_error_notes enable row level security;
revoke all on app_errors, app_error_notes from public, anon, authenticated, service_role, app_runtime;

-- ============================================================
-- 2. the writer
-- ============================================================
--
-- Never raises. A collector that can throw is a way to turn one broken route into every
-- broken route, so junk input is dropped and everything is clamped here as well as in the
-- handler — this function is the last gate before a public endpoint reaches the table.

create or replace function platform_auth.record_error(
  p_kind text,
  p_fingerprint text,
  p_code text,
  p_status int,
  p_method text,
  p_path text,
  p_route text,
  p_message text,
  p_detail text,
  p_request_id text,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_ip text,
  p_user_agent text,
  p_environment text)
returns void language plpgsql security definer set search_path = public as $$ declare
  v_bucket timestamptz := date_trunc('minute', now());
begin
  if p_kind is null or p_kind not in ('server','client') then return; end if;
  if p_fingerprint is null or char_length(p_fingerprint) < 8 then return; end if;
  if trim(coalesce(p_message, '')) = '' then return; end if;

  insert into app_errors (bucket, fingerprint, kind, code, status, method, path, route,
                          message, detail, request_id, tenant_id, actor_user_id, ip,
                          user_agent, environment, first_ts, last_ts)
  values (v_bucket, left(p_fingerprint, 64), p_kind, left(p_code, 60),
          case when p_status >= 100 and p_status <= 599 then p_status end,
          left(p_method, 8), left(p_path, 300), left(p_route, 120),
          left(p_message, 500), left(p_detail, 4000), left(p_request_id, 64),
          p_tenant_id, p_actor_user_id, left(p_ip, 60), left(p_user_agent, 200),
          left(p_environment, 20), now(), now())
  on conflict (fingerprint, bucket) do update
    set repeats = app_errors.repeats + 1,
        last_ts = now(),
        -- The freshest context wins on the merged line, because this is the row the desk
        -- opens: a request id from a minute ago is more useful than one from an hour ago,
        -- and the stack of the FIRST occurrence is the one that predates any retry.
        request_id = coalesce(excluded.request_id, app_errors.request_id),
        tenant_id = coalesce(excluded.tenant_id, app_errors.tenant_id),
        actor_user_id = coalesce(excluded.actor_user_id, app_errors.actor_user_id),
        ip = coalesce(excluded.ip, app_errors.ip),
        detail = coalesce(app_errors.detail, excluded.detail);
end $$;

-- ============================================================
-- 3. the doors the desk reads
-- ============================================================

-- One line per bug in the window, with its judgement attached.
create or replace function platform_auth.error_register(
  p_kind text,
  p_state text,
  p_q text,
  p_days int,
  p_limit int)
returns table (
  fingerprint text, kind text, code text, status int, path text, route text,
  message text, occurrences int, lines int, first_seen timestamptz,
  last_seen timestamptz, tenants int, request_id text, state text, triage_note text
) language sql security definer set search_path = public as $$
  with agg as (
    select e.fingerprint,
           max(e.kind) as kind,
           max(e.code) as code,
           max(e.status) as status,
           max(e.path) as path,
           max(e.route) as route,
           max(e.message) as message,
           sum(1 + e.repeats)::int as occurrences,
           count(*)::int as lines,
           min(e.first_ts) as first_seen,
           max(e.last_ts) as last_seen,
           count(distinct e.tenant_id)::int as tenants
      from app_errors e
     where e.last_ts >= now() - make_interval(days => greatest(coalesce(p_days, 7), 1))
       and (p_kind is null or e.kind = p_kind)
       and (p_q is null
            or e.message ilike '%' || p_q || '%'
            or coalesce(e.path, '') ilike '%' || p_q || '%'
            or coalesce(e.code, '') ilike '%' || p_q || '%'
            or coalesce(e.route, '') ilike '%' || p_q || '%')
     group by e.fingerprint
  )
  select a.fingerprint, a.kind, a.code, a.status, a.path, a.route, a.message,
         a.occurrences, a.lines, a.first_seen, a.last_seen, a.tenants,
         r.request_id, coalesce(n.state, 'open'), n.note
    from agg a
    cross join lateral (
      select e2.request_id from app_errors e2
       where e2.fingerprint = a.fingerprint
       order by e2.last_ts desc limit 1) r
    left join app_error_notes n on n.fingerprint = a.fingerprint
   where (p_state is null
          or (p_state = 'untouched' and n.fingerprint is null)
          or (p_state <> 'untouched' and n.state = p_state))
   order by a.last_seen desc
   limit greatest(least(coalesce(p_limit, 100), 300), 1);
$$;

-- The individual minutes behind one line, newest first, with the people involved named —
-- a stack trace without "which company, which seat" is only half the story.
create or replace function platform_auth.error_occurrences(
  p_fingerprint text,
  p_limit int)
returns table (
  bucket timestamptz, kind text, code text, status int, method text, path text,
  route text, message text, detail text, request_id text, repeats int,
  tenant_id uuid, tenant_name text, actor_user_id uuid, actor_name text,
  ip text, user_agent text, environment text
) language sql security definer set search_path = public as $$
  select e.bucket, e.kind, e.code, e.status, e.method, e.path, e.route, e.message,
         e.detail, e.request_id, e.repeats,
         e.tenant_id, t.name,
         e.actor_user_id, coalesce(u.full_name, u.email),
         e.ip, e.user_agent, e.environment
    from app_errors e
    left join tenants t on t.id = e.tenant_id
    left join users u on u.id = e.actor_user_id
   where e.fingerprint = p_fingerprint
   order by e.last_ts desc
   limit greatest(least(coalesce(p_limit, 20), 100), 1);
$$;

-- The numbers the top of the desk and the system advisory both quote, so neither of them
-- does arithmetic the other one could disagree with.
create or replace function platform_auth.error_summary(p_days int)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'window_days', greatest(coalesce(p_days, 7), 1),
    'lines', count(*)::int,
    'occurrences', coalesce(sum(1 + repeats), 0)::int,
    'server_lines', count(*) filter (where kind = 'server')::int,
    'server_occurrences', coalesce(sum(1 + repeats) filter (where kind = 'server'), 0)::int,
    'client_lines', count(*) filter (where kind = 'client')::int,
    'client_occurrences', coalesce(sum(1 + repeats) filter (where kind = 'client'), 0)::int,
    'in_last_24h', coalesce(sum(1 + repeats) filter (where last_ts >= now() - interval '24 hours'), 0)::int,
    'in_prior_24h', coalesce(sum(1 + repeats) filter (
        where last_ts >= now() - interval '48 hours' and last_ts < now() - interval '24 hours'), 0)::int,
    'server_in_last_24h', coalesce(sum(1 + repeats) filter (
        where kind = 'server' and last_ts >= now() - interval '24 hours'), 0)::int,
    'tenants', count(distinct tenant_id)::int,
    'open', (select count(*)::int from app_error_notes where state = 'open')::int,
    'triaged', (select count(*)::int from app_error_notes where state = 'triaged')::int,
    'resolved', (select count(*)::int from app_error_notes where state = 'resolved')::int,
    'ignored', (select count(*)::int from app_error_notes where state = 'ignored')::int,
    'untouched', (select count(distinct e.fingerprint)::int from app_errors e
                   where not exists (select 1 from app_error_notes n
                                      where n.fingerprint = e.fingerprint))::int
  )
  from app_errors
  where last_ts >= now() - make_interval(days => greatest(coalesce(p_days, 7), 1));
$$;

-- ============================================================
-- 4. the doors the desk writes
-- ============================================================

-- Triage is the only mutation the register allows, and it is a judgement on a fingerprint,
-- never an edit of a fact: no parameter here can change a message, a time or a count.
create or replace function platform_auth.mark_error(
  p_fingerprint text,
  p_state text,
  p_note text,
  p_actor uuid)
returns table (fingerprint text, state text, note text, updated_at timestamptz)
language sql security definer set search_path = public as $$
  -- Guarded by an inline check that can only ever be TRUE, so an unknown state, an
  -- over-long note or a fingerprint the register has never seen leaves the upsert
  -- unexecuted and the SELECT empty. A `where false` inside a plpgsql `return query`
  -- would not have worked at all: the outer SELECT's FROM decides the row count, and
  -- the old body therefore answered with one row of four NULLs on every refusal.
  with guard as (
    select (p_state in ('open','triaged','resolved','ignored')
            and coalesce(char_length(nullif(trim(coalesce(p_note, '')), '')), 0) <= 600
            and exists (select 1 from app_errors e where e.fingerprint = p_fingerprint)
           ) as ok
  ), written as (
    insert into app_error_notes (fingerprint, state, note, updated_by, updated_at)
    select p_fingerprint, p_state, nullif(trim(coalesce(p_note, '')), ''), p_actor, now()
      from guard where guard.ok
    on conflict (fingerprint) do update
      -- A blank note means "change the state only"; it must not wipe what an earlier
      -- seat wrote. The note itself is still replaceable, because triage is a judgement
      -- that is allowed to change. No column here can touch a message, a count or a time.
      set state = excluded.state,
          note = coalesce(excluded.note, app_error_notes.note),
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
    returning *
  )
  select n.fingerprint, n.state, n.note, n.updated_at
    from app_error_notes n, guard
   where n.fingerprint = p_fingerprint and guard.ok;
$$;

-- Retention, explicitly. The register only ever grows by one line per bug per minute,
-- which is survivable until it is not; the answer is an operator deciding that failures
-- older than N days are spent, not a timer quietly deleting evidence at 03:00.
create or replace function platform_auth.prune_errors(p_keep_days int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_cutoff timestamptz;
  v_deleted int;
begin
  if p_keep_days is null or p_keep_days < 7 then
    return jsonb_build_object('status', 'invalid',
      'message', 'Retention keeps at least 7 days — a week of failures is the minimum worth having.');
  end if;
  v_cutoff := now() - make_interval(days => p_keep_days);

  delete from app_errors where last_ts < v_cutoff;
  get diagnostics v_deleted = row_count;
  -- A fingerprint whose every line has gone is a bug nobody can see any more, so its
  -- judgement goes with it. Notes are tiny; keeping orphans would only make the counts
  -- on the desk disagree with the register underneath them.
  delete from app_error_notes n
   where not exists (select 1 from app_errors e where e.fingerprint = n.fingerprint);

  return jsonb_build_object('status', 'ok', 'deleted', v_deleted,
                            'cutoff', v_cutoff, 'keep_days', p_keep_days);
end $$;

-- ============================================================
-- 5. grants
-- ============================================================

grant execute on function
  platform_auth.record_error(text, text, text, int, text, text, text, text, text, text, uuid, uuid, text, text, text),
  platform_auth.error_register(text, text, text, int, int),
  platform_auth.error_occurrences(text, int),
  platform_auth.error_summary(int),
  platform_auth.mark_error(text, text, text, uuid),
  platform_auth.prune_errors(int)
to app_runtime;

-- The sweep every new definer needs (051, 060, 066, 068, 070, 079): a fresh function is
-- executable by PUBLIC until told otherwise, and record_error writes to a register that
-- must not be open to a browser role.
revoke all on function
  platform_auth.record_error(text, text, text, int, text, text, text, text, text, text, uuid, uuid, text, text, text),
  platform_auth.error_register(text, text, text, int, int),
  platform_auth.error_occurrences(text, int),
  platform_auth.error_summary(int),
  platform_auth.mark_error(text, text, text, uuid),
  platform_auth.prune_errors(int)
from public, anon, authenticated, service_role;

-- Permissions: 005 seeded control.system.view and control.system.manage for exactly this
-- kind of desk. Nothing new is issued — the register is read by whoever can read the
-- system report, and triaged by whoever can act on it.

commit;
