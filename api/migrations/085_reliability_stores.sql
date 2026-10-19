-- 085 — reliability measured instead of asserted (spec: admin panel, task #155).
--
-- The system advisory's own "WHAT THIS SYSTEM CANNOT TELL YOU YET" list said it plainly:
-- "there is no metrics endpoint and no request-timing store, so /api/v1/health answers
-- 'ok' for a process and nothing else. A route that is merely slow, and the gap between
-- two restarts, are both invisible." And about bloat: "pg_stat is read live and reset by
-- a restart, and nothing stores a history of it, so growth can be reported only as
-- today's snapshot, never as a trend."
--
-- 082 fixed the half of reliability that leaves a trace — a 500 is now a row. This file
-- fixes the half that never did: a request that succeeded slowly, a worker that was dead
-- for eleven minutes, and a table whose dead tuples doubled while nobody looked.
--
-- Four stores, one writer each, and no telemetry vendor:
--
--   service_boots       — one line per process start, so "how many times did this
--                         deployment restart" is a count rather than a memory.
--   service_heartbeats  — one line per instance per minute the loop was alive. Uptime is
--                         alive minutes over expected minutes, and a restart gap is a
--                         hole in this table, which is the only way a process can report
--                         its own absence.
--   request_timings     — one line per (minute, method, normalised route), folded by
--                         upsert like app_errors: count, total ms, worst ms, five latency
--                         bands and a server-error count. A busy route costs one row a
--                         minute, not one row a request, which is what makes the store
--                         survivable on a pooler.
--   pg_stat_snapshots   — the janitor's counters, copied out of pg_stat on demand, so
--                         dead tuples and table size become a series instead of a value
--                         that a restart wipes.
--
-- Percentiles are banded, and the bands are stored rather than the raw durations: p50 and
-- p95 are interpolated inside their band, the top band interpolates against the stored
-- max, and the desk says "approximate" in the same breath as the number. An approximate
-- p95 from a five-band histogram is honest; a precise-looking one invented from a mean
-- would not be.
--
-- Posture is 082's, deliberately: RLS enabled with NO policies and NO table grants, so a
-- handler cannot write a good day into the register. platform_auth owns every door,
-- including the writers. The metrics writer is called by a hook on the public surface, so
-- it clamps and drops rather than raising — a collector that can throw turns one slow
-- route into a failing one. Reads are gated by control.system.view (069), a manual
-- snapshot and retention by control.system.manage (005); nothing new is issued.
--
-- Retention is an action, not a timer, for the same reason as 082: dropping the record of
-- a slow week is a decision somebody should own. Every statement is written to re-run
-- cleanly, because the readers here are revised against the live store as the desk learns
-- what an empty register has to say.

begin;

-- ============================================================
-- 1. the stores
-- ============================================================

-- `<pid>@<hostname>`, so two dynos of one deployment are two lines and a rolling restart
-- is visible as a new instance rather than a mysterious gap.
create table if not exists service_boots (
  instance text not null,
  started_at timestamptz not null,
  node text,
  platform text,
  environment text,
  primary key (instance, started_at)
);
create index if not exists service_boots_started on service_boots (started_at desc);

-- A minute in which at least one worker of this deployment was running. Nothing more:
-- see the collector_note the reader returns with it.
create table if not exists service_heartbeats (
  bucket timestamptz not null,
  instance text not null,
  seen_at timestamptz not null,
  primary key (bucket, instance)
);
create index if not exists service_heartbeats_bucket on service_heartbeats (bucket desc);

create table if not exists request_timings (
  -- date_trunc('minute', now()) at write time — the key that folds a burst into one line.
  bucket timestamptz not null,
  method text not null,
  -- Normalised before it gets here: no query string, every id-shaped segment collapsed to
  -- :id. Same function 082's collector uses, so the error register and the latency table
  -- describe a route in the same words and can be read side by side.
  route text not null,
  requests int not null default 0,
  sum_ms bigint not null default 0,
  max_ms int not null default 0,
  -- Bands: <100, <300, <1000, <3000, >=3000 ms. Summed = requests.
  band_fast int not null default 0,
  band_ok int not null default 0,
  band_slow int not null default 0,
  band_bad int not null default 0,
  band_awful int not null default 0,
  -- Answers that came back 5xx. 082 says which bug; this says how often the route broke.
  server_errors int not null default 0,
  first_ts timestamptz not null default now(),
  last_ts timestamptz not null default now(),
  primary key (bucket, method, route)
);
create index if not exists request_timings_last on request_timings (last_ts desc);
create index if not exists request_timings_route on request_timings (route, bucket desc);

create table if not exists pg_stat_snapshots (
  captured_at timestamptz not null,
  relid oid not null,
  relname text not null,
  n_live_tup bigint not null default 0,
  n_dead_tup bigint not null default 0,
  table_bytes bigint not null default 0,
  index_bytes bigint not null default 0,
  seq_scan bigint not null default 0,
  idx_scan bigint not null default 0,
  last_vacuum timestamptz,
  last_autovacuum timestamptz,
  last_analyze timestamptz,
  last_autoanalyze timestamptz,
  primary key (captured_at, relid)
);
create index if not exists pg_stat_snapshots_rel on pg_stat_snapshots (relname, captured_at desc);
create index if not exists pg_stat_snapshots_time on pg_stat_snapshots (captured_at desc);

-- The first draft of this register stored a `last_modified`, which pg_stat_user_tables does
-- not actually expose on this server — and because the capture selects the columns by name,
-- one invented column meant the whole capture failed and stored nothing. The column is
-- dropped rather than kept NULL forever; this table is empty until the first real capture
-- anyway, so there is no reading here that loses history.
alter table pg_stat_snapshots drop column if exists last_modified;

alter table service_boots enable row level security;
alter table service_heartbeats enable row level security;
alter table request_timings enable row level security;
alter table pg_stat_snapshots enable row level security;
revoke all on service_boots, service_heartbeats, request_timings, pg_stat_snapshots
  from public, anon, authenticated, service_role, app_runtime;

-- ============================================================
-- 2. the writers
-- ============================================================
--
-- None of these may raise. They are called from a request hook and from an interval loop,
-- and an error escaping either one is a way to make the collector the outage it is
-- measuring.

create or replace function platform_auth.record_boot(
  p_instance text, p_node text, p_platform text, p_environment text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_instance is null or trim(p_instance) = '' then return; end if;
  insert into service_boots (instance, started_at, node, platform, environment)
  values (left(trim(p_instance), 80), now(), left(p_node, 30), left(p_platform, 40),
          left(p_environment, 20))
  on conflict (instance, started_at) do nothing;
exception when others then
  null;  -- a failed boot line must never become a failed boot
end $$;

create or replace function platform_auth.record_heartbeat(p_instance text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_instance is null or trim(p_instance) = '' then return; end if;
  insert into service_heartbeats (bucket, instance, seen_at)
  values (date_trunc('minute', now()), left(trim(p_instance), 80), now())
  on conflict (bucket, instance) do update set seen_at = excluded.seen_at;
exception when others then
  null;
end $$;

-- Everything is clamped here as well as in the hook: this is the last gate before a
-- public-surface write reaches the table, and a negative or absurd duration must not
-- become a mean that the office then acts on.
-- One call per flush, not per request. The collector is fed a JSON array already folded in
-- the process, because this database sits behind a pooler and a round trip on every
-- response would make the latency store the thing that makes the API slow. Numbers travel
-- as JSON, not as typed placeholders: an integer or numeric parameter bound as unknown is
-- a way to make the most-called collector on the public surface the one that raises.
create or replace function platform_auth.record_requests(p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$ declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_rows_in int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  v_rows_in := jsonb_array_length(p_rows);
  if v_rows_in = 0 then return 0; end if;

  insert into request_timings (bucket, method, route, requests, sum_ms, max_ms,
                               band_fast, band_ok, band_slow, band_bad, band_awful,
                               server_errors, first_ts, last_ts)
  select v_bucket, x.method, x.route, x.requests, x.sum_ms, x.max_ms,
         x.band_fast, x.band_ok, x.band_slow, x.band_bad, x.band_awful,
         x.server_errors, now(), now()
    from jsonb_to_recordset(p_rows) as x(
           method text, route text, requests int, sum_ms bigint, max_ms int,
           band_fast int, band_ok int, band_slow int, band_bad int, band_awful int,
           server_errors int)
   -- Everything below is clamped at the door, and a row that cannot be clamped is dropped
   -- rather than allowed to poison the flush of the rows beside it.
   where x.method is not null and x.route is not null and trim(x.route) <> ''
     and coalesce(x.requests, 0) > 0
     and coalesce(x.sum_ms, -1) >= 0
     and coalesce(x.max_ms, -1) >= 0
     and x.max_ms <= 600000
     and x.route not like '%?%'
     and x.route not like '%//%'
     and char_length(x.route) <= 300
     and x.method ~ '^[A-Z]{3,7}$'
   on conflict (bucket, method, route) do update
    set requests = request_timings.requests + excluded.requests,
        sum_ms = request_timings.sum_ms + excluded.sum_ms,
        -- The worst of the minute, not the last of the minute: a 4-second response is
        -- still the fact worth seeing after nine fast ones follow it.
        max_ms = greatest(request_timings.max_ms, excluded.max_ms),
        band_fast = request_timings.band_fast + excluded.band_fast,
        band_ok = request_timings.band_ok + excluded.band_ok,
        band_slow = request_timings.band_slow + excluded.band_slow,
        band_bad = request_timings.band_bad + excluded.band_bad,
        band_awful = request_timings.band_awful + excluded.band_awful,
        server_errors = request_timings.server_errors + excluded.server_errors,
        last_ts = now();
  get diagnostics v_rows_in = row_count;
  return v_rows_in;
exception when others then
  -- A failed flush is dropped counts, never a failed request.
  return -1;
end $$;

-- Copy the janitor's counters out of pg_stat while they still exist. Called by the desk
-- and by any external scheduler; a restart zeroes them, which is exactly why they have to
-- be stored rather than read.
create or replace function platform_auth.capture_pg_stat()
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_at timestamptz := now();
  v_rows int := 0;
begin
  begin
    insert into pg_stat_snapshots (captured_at, relid, relname, n_live_tup, n_dead_tup,
                                   table_bytes, index_bytes, seq_scan, idx_scan,
                                   last_vacuum, last_autovacuum, last_analyze,
                                   last_autoanalyze)
    select v_at, s.relid, c.relname,
           coalesce(s.n_live_tup, 0), coalesce(s.n_dead_tup, 0),
           coalesce(pg_table_size(c.oid), 0), coalesce(pg_indexes_size(c.oid), 0),
           coalesce(s.seq_scan, 0), coalesce(s.idx_scan, 0),
           s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze
      from pg_stat_user_tables s
      join pg_class c on c.oid = s.relid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public';
    get diagnostics v_rows = row_count;
  exception when others then
    -- The size functions depend on what the definer's owner may see. Saying so in the
    -- receipt is better than a captured_at with nothing behind it.
    return jsonb_build_object('status', 'failed', 'message', left(sqlerrm, 200));
  end;
  return jsonb_build_object('status', 'ok', 'captured_at', v_at, 'relations', v_rows);
end $$;

-- ============================================================
-- 3. the readers
-- ============================================================

-- Uptime, honestly bounded. `expected_minutes` starts at the first boot this register ever
-- saw, not at the start of the window: a deployment that shipped yesterday cannot be
-- blamed for the fortnight before it existed, and a percentage that quietly divides by a
-- period with no collector in it is the most misleading number on the screen.
create or replace function platform_auth.uptime_report(p_window_days int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_days int := greatest(least(coalesce(p_window_days, 7), 90), 1);
  v_from timestamptz := now() - make_interval(days => v_days);
  v_first_boot timestamptz;
  v_known_from timestamptz;
  v_floor timestamptz;
  v_expected numeric;
  v_alive int;
  v_result jsonb;
begin
  select min(b.started_at) into v_first_boot from service_boots b;

  -- Nothing has ever booted under this register, so nothing is being measured. The honest
  -- receipt is an empty report, not a 0%: the window would be the whole configured period
  -- while the collector existed for none of it, and the office would open the desk to find
  -- an outage that was only the deploy that had not happened yet.
  if v_first_boot is null then
    select count(*)::int into v_alive
      from (select distinct h.bucket from service_heartbeats h
             where h.bucket >= v_from and h.bucket <= now()) x;
    return jsonb_build_object(
      'window_days', v_days,
      'measured_from', null,
      'expected_minutes', 0,
      'alive_minutes', coalesce(v_alive, 0),
      'uptime_pct', null,
      'instances', 0,
      'boots', '[]'::jsonb,
      'boot_count', 0,
      'last_boot', null,
      'longest_gap_minutes', null,
      'gaps', '[]'::jsonb,
      'collector_note', 'No boot has been recorded since this register opened, so no '
        || 'percentage exists: the window contains no collector. The line appears at the '
        || 'first deploy that runs it.'
    );
  end if;

  v_known_from := greatest(v_from, coalesce(v_first_boot, v_from));
  v_floor := date_trunc('minute', v_known_from);

  select extract(epoch from (now() - v_floor)) / 60 into v_expected;
  select count(*)::int into v_alive
    from (select distinct h.bucket from service_heartbeats h
           where h.bucket >= v_floor and h.bucket <= now()) x;

  select jsonb_build_object(
    'window_days', v_days,
    'measured_from', v_floor,
    'expected_minutes', coalesce(round(v_expected)::int, 0),
    'alive_minutes', coalesce(v_alive, 0),
    'uptime_pct', case when coalesce(v_expected, 0) <= 0 then null
      else round(least(100.0, (coalesce(v_alive, 0) * 100.0) / v_expected), 2) end,
    'instances', coalesce((select count(distinct b.instance) from service_boots b
                            where b.started_at >= v_from), 0)::int,
    'boots', coalesce((select jsonb_agg(jsonb_build_object(
        'instance', x.instance, 'started_at', x.started_at, 'environment', x.environment,
        'node', x.node) order by x.started_at desc)
      from (select b.instance, b.started_at, b.environment, b.node
              from service_boots b order by b.started_at desc limit 10) x), '[]'::jsonb),
    'boot_count', coalesce((select count(*)::int from service_boots b
                             where b.started_at >= v_from), 0)::int,
    'last_boot', (select max(b.started_at) from service_boots b),
    'longest_gap_minutes', coalesce((select max(g.mins)::int from (
        select extract(epoch from (h.bucket - lag(h.bucket) over (order by h.bucket))) / 60
               as mins
          from (select distinct bucket from service_heartbeats
                 where bucket >= v_floor) h) g where g.mins > 5), 0),
    'gaps', coalesce((select jsonb_agg(jsonb_build_object(
        'before', y.bucket, 'after', y.nx, 'minutes', round(y.mins)::int)
        order by y.mins desc)
      -- The window needs one level, the filter and the cap another: a LIMIT written beside
      -- an aggregate applies to the single row the aggregate produces, which would silently
      -- return every gap instead of the ten worst.
      from (select x.bucket, x.nx, x.mins
              from (select h.bucket,
                           lead(h.bucket) over (order by h.bucket) as nx,
                           extract(epoch from (lead(h.bucket) over (order by h.bucket)
                                               - h.bucket)) / 60 as mins
                      from (select distinct bucket from service_heartbeats
                             where bucket >= v_floor) h) x
             where x.nx is not null and x.mins > 5
             order by x.mins desc limit 10) y), '[]'::jsonb),
    -- Read this with the percentage. A heartbeat proves a worker process was alive, not
    -- that a customer could reach it: there is no outside probe, and the panel does not
    -- claim one.
    'collector_note', 'Minutes in which a Waisha worker process reported itself alive. '
      || 'It is not a probe from outside: an outage that takes the app down before it can '
      || 'answer is a gap here only if the loop stopped too.'
  ) into v_result;
  return v_result;
end $$;

-- One line per route over the window. The bands make p50/p95 interpolable; they are
-- reported rounded to the band, because a banded estimate printed to ten decimals would
-- look like something the store never recorded.
create or replace function platform_auth.request_latency(p_window_days int, p_row_limit int)
returns table (
  method text, route text, requests bigint, mean_ms numeric, p50_ms numeric,
  p95_ms numeric, max_ms int, server_errors bigint, error_rate numeric,
  over_1s bigint, last_seen timestamptz
) language sql security definer set search_path = public as $$
  with agg as (
    select t.method, t.route,
           sum(t.requests)::bigint as requests,
           sum(t.sum_ms)::bigint as sum_ms,
           max(t.max_ms)::int as max_ms,
           sum(t.band_fast)::bigint as b1, sum(t.band_ok)::bigint as b2,
           sum(t.band_slow)::bigint as b3, sum(t.band_bad)::bigint as b4,
           sum(t.band_awful)::bigint as b5,
           sum(t.server_errors)::bigint as server_errors,
           max(t.last_ts) as last_seen
      from request_timings t
     where t.bucket >= now() - make_interval(days => greatest(coalesce(p_window_days, 7), 1))
     group by t.method, t.route
  ), c as (
    select a.*,
           a.b1 + a.b2 as c2,
           a.b1 + a.b2 + a.b3 as c3,
           a.b1 + a.b2 + a.b3 + a.b4 as c4
      from agg a
  )
  select c.method, c.route, c.requests,
         round(c.sum_ms::numeric / nullif(c.requests, 0), 1) as mean_ms,
         case
           when c.requests = 0 then null
           when c.b1 >= c.requests * 0.5 then round(c.requests * 0.5 / nullif(c.b1,0) * 100)
           when c.c2 >= c.requests * 0.5 then round(100 + (c.requests*0.5 - c.b1)
                                                   / nullif(c.b2,0) * 200)
           when c.c3 >= c.requests * 0.5 then round(300 + (c.requests*0.5 - c.c2)
                                                   / nullif(c.b3,0) * 700)
           when c.c4 >= c.requests * 0.5 then round(1000 + (c.requests*0.5 - c.c3)
                                                   / nullif(c.b4,0) * 2000)
           else round(3000 + (c.requests*0.5 - c.c4) / nullif(c.b5,0)
                      * greatest(c.max_ms - 3000, 0))
         end as p50_ms,
         case
           when c.requests = 0 then null
           when c.b1 >= c.requests * 0.95 then round(c.requests * 0.95 / nullif(c.b1,0) * 100)
           when c.c2 >= c.requests * 0.95 then round(100 + (c.requests*0.95 - c.b1)
                                                    / nullif(c.b2,0) * 200)
           when c.c3 >= c.requests * 0.95 then round(300 + (c.requests*0.95 - c.c2)
                                                    / nullif(c.b3,0) * 700)
           when c.c4 >= c.requests * 0.95 then round(1000 + (c.requests*0.95 - c.c3)
                                                    / nullif(c.b4,0) * 2000)
           else round(3000 + (c.requests*0.95 - c.c4) / nullif(c.b5,0)
                      * greatest(c.max_ms - 3000, 0))
         end as p95_ms,
         c.max_ms, c.server_errors,
         round(100.0 * c.server_errors / nullif(c.requests, 0), 2) as error_rate,
         (c.b3 + c.b4 + c.b5) as over_1s,
         c.last_seen
    from c
   -- Busiest first, then the routes with the heavy tail. Ordered on the stored bands
   -- rather than on the alias: an ORDER BY that names a RETURNS TABLE column is a name
   -- two things can claim, and a silently mis-parsed sort is worse than a plainer rule.
   order by c.requests desc, (c.b4 + c.b5) desc, c.max_ms desc
   limit greatest(least(coalesce(p_row_limit, 40), 200), 1);
$$;

-- The same day-by-day, so the desk can see whether the system got slower rather than
-- whether it is slow today.
create or replace function platform_auth.request_daily(p_window_days int)
returns table (
  day date, requests bigint, mean_ms numeric, over_1s bigint, server_errors bigint,
  routes int
) language sql security definer set search_path = public as $$
  select (t.bucket at time zone 'Africa/Dar_es_Salaam')::date as day,
         sum(t.requests)::bigint,
         round(sum(t.sum_ms)::numeric / nullif(sum(t.requests), 0), 1),
         sum(t.band_slow + t.band_bad + t.band_awful)::bigint,
         sum(t.server_errors)::bigint,
         count(distinct t.route)::int
    from request_timings t
   where t.bucket >= now() - make_interval(days => greatest(coalesce(p_window_days, 7), 1))
   group by 1 order by 1;
$$;

-- The whole-request picture across a set of routes: the advisory needs the platform p95,
-- and doing that arithmetic here keeps it identical to what the table prints.
create or replace function platform_auth.request_overall(p_window_days int)
returns jsonb language sql security definer set search_path = public as $$
  with agg as (
    select sum(band_fast) as b1, sum(band_ok) as b2, sum(band_slow) as b3,
           sum(band_bad) as b4, sum(band_awful) as b5,
           sum(requests) as requests, sum(sum_ms) as sum_ms, max(max_ms) as max_ms,
           sum(server_errors) as server_errors, count(distinct route) as routes
      from request_timings
     where bucket >= now() - make_interval(days => greatest(coalesce(p_window_days, 7), 1))
  )
  select jsonb_build_object(
    'window_days', greatest(coalesce(p_window_days, 7), 1),
    'requests', coalesce(agg.requests, 0),
    'routes', coalesce(agg.routes, 0)::int,
    'mean_ms', round(agg.sum_ms::numeric / nullif(agg.requests, 0), 1),
    'max_ms', agg.max_ms,
    'over_1s', coalesce(agg.b3 + agg.b4 + agg.b5, 0),
    'server_errors', coalesce(agg.server_errors, 0),
    'error_rate', round(100.0 * agg.server_errors / nullif(agg.requests, 0), 2),
    'p95_ms', case when coalesce(agg.requests, 0) = 0 then null
      when agg.b1 >= agg.requests * 0.95 then round(agg.requests * 0.95 / nullif(agg.b1,0) * 100)
      when agg.b1 + agg.b2 >= agg.requests * 0.95 then round(100 + (agg.requests*0.95 - agg.b1)
             / nullif(agg.b2,0) * 200)
      when agg.b1 + agg.b2 + agg.b3 >= agg.requests * 0.95 then round(300 + (agg.requests*0.95 - agg.b1 - agg.b2)
             / nullif(agg.b3,0) * 700)
      when agg.b1 + agg.b2 + agg.b3 + agg.b4 >= agg.requests * 0.95 then round(1000
             + (agg.requests*0.95 - agg.b1 - agg.b2 - agg.b3) / nullif(agg.b4,0) * 2000)
      else round(3000 + (agg.requests*0.95 - agg.b1 - agg.b2 - agg.b3 - agg.b4)
             / nullif(agg.b5,0) * greatest(agg.max_ms - 3000, 0)) end
  ) from agg;
$$;

-- Oldest versus newest snapshot per relation, so bloat is a direction and not a value.
-- A relation with one snapshot has no trend and says so with NULLs rather than a zero
-- growth that would read as "stable".
create or replace function platform_auth.bloat_trend(p_window_days int, p_row_limit int)
returns table (
  relname text, snapshots int, first_seen timestamptz, last_seen timestamptz,
  live_tuples bigint, dead_tuples bigint, dead_pct numeric,
  table_bytes bigint, index_bytes bigint,
  dead_growth bigint, table_growth_bytes bigint,
  seq_scans bigint, idx_scans bigint, scan_ratio numeric,
  last_vacuum timestamptz, last_autovacuum timestamptz,
  vacuum_stale_hours numeric
) language sql security definer set search_path = public as $$
  with windowed as (
    select s.*
      from pg_stat_snapshots s
     where s.captured_at >= now() - make_interval(days => greatest(coalesce(p_window_days, 30), 1))
  ), ranked as (
    select w.*,
           row_number() over (partition by w.relname order by w.captured_at asc)  as rn_first,
           row_number() over (partition by w.relname order by w.captured_at desc) as rn_last,
           count(*)    over (partition by w.relname)                             as snaps
      from windowed w
  ), ends as (
    select r.relname, r.snaps as snapshots,
           max(r.captured_at) filter (where r.rn_first = 1) as first_seen,
           max(r.captured_at) filter (where r.rn_last = 1)  as last_seen,
           max(r.n_live_tup)   filter (where r.rn_last = 1) as live_tuples,
           max(r.n_dead_tup)   filter (where r.rn_last = 1) as dead_tuples,
           max(r.n_dead_tup)   filter (where r.rn_first = 1) as dead_at_first,
           max(r.table_bytes)  filter (where r.rn_last = 1) as table_bytes,
           max(r.table_bytes)  filter (where r.rn_first = 1) as table_at_first,
           max(r.index_bytes)  filter (where r.rn_last = 1) as index_bytes,
           max(r.seq_scan)     filter (where r.rn_last = 1) as seq_scans,
           max(r.idx_scan)     filter (where r.rn_last = 1) as idx_scans,
           max(r.last_vacuum)    filter (where r.rn_last = 1) as last_vacuum,
           max(r.last_autovacuum) filter (where r.rn_last = 1) as last_autovacuum,
           max(r.captured_at)    filter (where r.rn_last = 1) as at_last
      from ranked r
     group by r.relname, r.snaps
  )
  select e.relname, e.snapshots::int,
         e.first_seen,
         e.last_seen,
         e.live_tuples, e.dead_tuples,
         round(100.0 * e.dead_tuples / nullif(e.live_tuples + e.dead_tuples, 0), 1),
         e.table_bytes, e.index_bytes,
         case when e.snapshots > 1 then e.dead_tuples - e.dead_at_first end,
         case when e.snapshots > 1 then e.table_bytes - e.table_at_first end,
         e.seq_scans, e.idx_scans,
         round(e.seq_scans::numeric / nullif(e.idx_scans, 0), 2),
         e.last_vacuum, e.last_autovacuum,
         round(extract(epoch from (e.at_last - greatest(e.last_vacuum, e.last_autovacuum)))
               / 3600, 1)
    from ends e
   order by e.dead_tuples desc, e.table_bytes desc nulls last
   limit greatest(least(coalesce(p_row_limit, 40), 200), 1);
$$;

-- How much history there actually is. Every trend on the desk is worth nothing until this
-- says more than one capture, and the panel says so instead of drawing a flat line.
create or replace function platform_auth.snapshot_meta()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'captures', count(distinct s.captured_at)::int,
    'relations', count(distinct s.relname)::int,
    'first_capture', min(s.captured_at),
    'last_capture', max(s.captured_at),
    'has_history', count(distinct s.captured_at) > 1
  ) from pg_stat_snapshots s;
$$;

-- ============================================================
-- 4. retention, explicitly
-- ============================================================

create or replace function platform_auth.prune_metrics(p_keep_days int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_cutoff timestamptz;
  v_timings int;
  v_stats int;
  v_beats int;
begin
  if p_keep_days is null or p_keep_days < 7 then
    -- One literal, not two joined with '+': plpgsql cannot pick an operator for two
    -- untyped string literals, so the refusal the whole guard exists to return would raise.
    return jsonb_build_object('status', 'invalid',
      'message', 'Retention keeps at least 7 days — a week is the shortest window in which a slow route is still recognisable as a pattern.');
  end if;
  v_cutoff := now() - make_interval(days => p_keep_days);

  delete from request_timings where bucket < v_cutoff;
  get diagnostics v_timings = row_count;
  delete from pg_stat_snapshots where captured_at < v_cutoff;
  get diagnostics v_stats = row_count;
  delete from service_heartbeats where bucket < v_cutoff;
  get diagnostics v_beats = row_count;
  -- A boot older than the window is still the reason a gap looks the way it does, and the
  -- table is one line per restart. Pruning it would make history unexplainable to save
  -- nothing.

  return jsonb_build_object('status', 'ok', 'cutoff', v_cutoff, 'keep_days', p_keep_days,
                            'request_lines', v_timings, 'snapshot_lines', v_stats,
                            'heartbeats', v_beats);
end $$;

-- ============================================================
-- 5. grants
-- ============================================================

grant execute on function
  platform_auth.record_boot(text, text, text, text),
  platform_auth.record_heartbeat(text),
  platform_auth.record_requests(jsonb),
  platform_auth.capture_pg_stat(),
  platform_auth.uptime_report(int),
  platform_auth.request_latency(int, int),
  platform_auth.request_daily(int),
  platform_auth.request_overall(int),
  platform_auth.bloat_trend(int, int),
  platform_auth.snapshot_meta(),
  platform_auth.prune_metrics(int)
to app_runtime;

-- The sweep every new definer needs (051, 060, 066, 068, 070, 079, 082): a fresh function
-- is executable by PUBLIC until told otherwise, and record_requests is called on the
-- public surface of the API — it must not be callable by a browser role.
revoke all on function
  platform_auth.record_boot(text, text, text, text),
  platform_auth.record_heartbeat(text),
  platform_auth.record_requests(jsonb),
  platform_auth.capture_pg_stat(),
  platform_auth.uptime_report(int),
  platform_auth.request_latency(int, int),
  platform_auth.request_daily(int),
  platform_auth.request_overall(int),
  platform_auth.bloat_trend(int, int),
  platform_auth.snapshot_meta(),
  platform_auth.prune_metrics(int)
from public, anon, authenticated, service_role;

-- Permissions: 005 seeded control.system.view and 069 built the machine-room duty on it.
-- Nothing new is issued — whoever reads the report reads reliability, and whoever can
-- manage the system takes a snapshot and prunes it.

commit;
