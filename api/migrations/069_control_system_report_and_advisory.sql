-- 069 — the technical report and the advisory (spec: admin panel, task #117).
--
-- The panel has spent three stages learning what the business is worth. This one asks
-- the other question in the room: *what is the system itself doing* — what is its
-- shape, where is it weak, and what should the office do next about it.
--
-- Both halves are SECURITY DEFINER for the standing reason: the report crosses every
-- tenant and reads the catalog, and a bare query under RLS returns nothing.
--
-- The design rule here is stricter than in the earlier migrations, because an
-- advisory that guesses is worse than no advisory. A rule is a query with a guard: if
-- the guard is false the rule contributes no row at all, so a healthy system gets a
-- short list rather than a flattering one, and silence means "nothing was found", not
-- "nothing was asked". Anything the schema cannot honestly support — funnel rates,
-- latency, error rates, revenue per feature — is named in `caveats` as *not measured*
-- instead of being invented as a number.
--
-- Posture: three new readers, no writes, no new tables, one new duty key.

begin;

-- ============================================================
-- 1. A duty for the machine room
-- ============================================================
--
-- 'control.system.manage' (005) has been in the matrix since the beginning and has
-- never been enforced by a route. This is a *read* key, deliberately not the manage
-- one. It goes to three seats: super_admin, because 005 granted it every permission
-- by cross-joining the permissions that existed *then*, so a key added in 069 is not
-- automatically anyone's; platform_analyst, which already reads every other
-- aggregate; and support_engineer, the seat that fixes faults — 067 gave it the
-- roster and 068 pointedly kept it off the money, and this key carries no money
-- either.

insert into permissions (key, description) values
  ('control.system.view', 'Control - Read the technical system report and the advisory')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.system.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','platform_analyst','support_engineer')
on conflict do nothing;

-- ============================================================
-- 2. What has actually been applied to this database
-- ============================================================
--
-- schema_migrations is the runner's own bookkeeping: migrate.ts creates it lazily,
-- keys on the bare filename and stores no checksum, so it is the only place real
-- schema state lives. It has no tenant_id, which is why it reaches the route through
-- a definer instead of a pool query.
--
-- The route compares this against the files on disk. That comparison — applied
-- versus present — is the single most useful sentence the whole migration can produce
-- about a deployment: it is how a forgotten migration is found before it is felt.

drop function if exists platform_auth.control_migrations_applied();
create or replace function platform_auth.control_migrations_applied()
returns table (name text, applied_at timestamptz)
language sql
stable security definer set search_path = public as $$
  select m.name, m.applied_at from schema_migrations m order by m.name;
$$;

-- ============================================================
-- 3. THE TECHNICAL REPORT
-- ============================================================
--
-- One call, one screenful of facts. Every value is read from the catalog or counted
-- from the tables; nothing is eyeballed and nothing is rounded into a nicer shape.
-- Where a number is only as current as the statistics collector — sizes, row
-- estimates, scan counts — the report ships the reset time beside it and says so in
-- `caveats`, rather than letting the reader discover it after a decision.
--
-- Two catalog notes that took a live query to settle: `relkind = 'p'` is a
-- partitioned *parent* and 'r' a plain table or a leaf partition, so a table count
-- that ignores 'p' silently drops audit_logs; and information_schema.table_privileges
-- only shows grants the current user is party to, so an app_runtime write-surface
-- count read from there would under-report and look reassuring. aclexplode on
-- pg_class.relacl sees everything the owner granted.

drop function if exists platform_auth.control_system_report();
create or replace function platform_auth.control_system_report()
returns jsonb
language plpgsql
stable security definer set search_path = public as $$
declare
  v_shape      jsonb;
  v_posture    jsonb;
  v_size       jsonb;
  v_migrations jsonb;
  v_access     jsonb;
  v_activity   jsonb;
  v_modules    jsonb;
  v_stats      jsonb;
begin

  ------------------------------------------------------------------
  -- shape of the schema
  ------------------------------------------------------------------
  select jsonb_build_object(
    'postgres',                current_setting('server_version'),
    'database',                current_database(),
    'tables',                  (select count(*)::int from pg_class c
                                  join pg_namespace n on n.oid = c.relnamespace
                                 where n.nspname = 'public' and c.relkind in ('r','p')),
    'partitioned_parents',     (select count(*)::int from pg_class c
                                  join pg_namespace n on n.oid = c.relnamespace
                                 where n.nspname = 'public' and c.relkind = 'p'),
    'views',                   (select count(*)::int from pg_class c
                                  join pg_namespace n on n.oid = c.relnamespace
                                 where n.nspname = 'public' and c.relkind = 'v'),
    'indexes',                 (select count(*)::int from pg_index i
                                  join pg_class c on c.oid = i.indexrelid
                                  join pg_namespace n on n.oid = c.relnamespace
                                 where n.nspname = 'public'),
    'triggers',                (select count(*)::int from pg_trigger t
                                  join pg_class c on c.oid = t.tgrelid
                                  join pg_namespace n on n.oid = c.relnamespace
                                 where n.nspname = 'public' and not t.tgisinternal),
    'functions',               (select count(*)::int from pg_proc p
                                  join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname in ('public','platform_auth')),
    'functions_platform_auth', (select count(*)::int from pg_proc p
                                  join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'platform_auth'),
    'schemas',                 (select coalesce(array_agg(n.nspname order by n.nspname), '{}'::text[])
                                  from pg_namespace n
                                 where n.nspname !~ '^pg_'
                                   and n.nspname <> 'information_schema')
  ) into v_shape;

  ------------------------------------------------------------------
  -- security posture, read the way the verify scripts read it
  ------------------------------------------------------------------
  -- `tenant_tables_without_rls` is the honest version of "are we sealed". A table
  -- that carries a tenant_id and has no row-level security is a hole; the many global
  -- reference tables that have no tenant column at all — geo_regions, plans,
  -- permissions, service_groups — are not, and listing them would fire on every
  -- deploy until the reader learned to ignore the flag.
  --
  -- Partition children are excluded because RLS is a property of the parent: enabling
  -- it on audit_logs (001) leaves relrowsecurity false on audit_logs_default, and a
  -- check that read a leaf as an unprotected table would report a hole that the parent
  -- already closes. pg_attribute is used rather than information_schema.columns
  -- because the definer's view of that catalogue is privilege-filtered.
  select jsonb_build_object(
    'rls_enabled',          (select count(*)::int from pg_class c
                               join pg_namespace n on n.oid = c.relnamespace
                              where n.nspname = 'public' and c.relkind in ('r','p')
                                and c.relrowsecurity),
    'tenant_tables_without_rls', coalesce((select array_agg(x.relname order by x.relname)
                               from (
                                 select c.relname
                                   from pg_class c
                                   join pg_namespace n on n.oid = c.relnamespace
                                   join pg_attribute a
                                     on a.attrelid = c.oid and a.attname = 'tenant_id'
                                    and a.attnum > 0 and not a.attisdropped
                                  where n.nspname = 'public' and c.relkind in ('r','p')
                                    and not c.relrowsecurity
                                    and not exists (select 1 from pg_inherits h
                                                     where h.inhrelid = c.oid)
                                  group by c.relname) x), '{}'::text[]),
    'rls_without_policy',   coalesce((select array_agg(c.relname order by c.relname)
                               from pg_class c
                               join pg_namespace n on n.oid = c.relnamespace
                              where n.nspname = 'public' and c.relkind in ('r','p')
                                and c.relrowsecurity
                                and not exists (select 1 from pg_policy po
                                                 where po.polrelid = c.oid)), '{}'::text[]),
    'policies',             (select count(*)::int from pg_policy po
                               join pg_class c on c.oid = po.polrelid
                               join pg_namespace n on n.oid = c.relnamespace
                              where n.nspname = 'public'),
    'definer_functions',    (select count(*)::int from pg_proc p
                               join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname in ('public','platform_auth') and p.prosecdef),
    -- proacl is null means the function never had its privileges stated, so it still
    -- carries the default grant — which is EXECUTE for PUBLIC. This is the exact class
    -- of hole 051 was written to close.
    'definer_public_reachable', coalesce((select array_agg(
                                 n.nspname || '.' || p.proname
                                 order by n.nspname || '.' || p.proname)
                               from pg_proc p
                               join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname in ('public','platform_auth')
                                and p.prosecdef and p.proacl is null), '{}'::text[]),
    'definer_without_search_path', coalesce((select array_agg(
                                 n.nspname || '.' || p.proname
                                 order by n.nspname || '.' || p.proname)
                               from pg_proc p
                               join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname in ('public','platform_auth')
                                and p.prosecdef
                                and not exists (select 1 from unnest(p.proconfig) x
                                                 where x like 'search_path%')), '{}'::text[]),
    'app_runtime_write_grants', (select count(*)::int
                               from pg_class c
                               join pg_namespace n on n.oid = c.relnamespace
                              cross join lateral aclexplode(c.relacl) a
                              where n.nspname = 'public' and c.relkind in ('r','p')
                                and a.grantee = 'app_runtime'::regrole
                                and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')),
    'app_runtime_delete_grants', (select count(*)::int
                               from pg_class c
                               join pg_namespace n on n.oid = c.relnamespace
                              cross join lateral aclexplode(c.relacl) a
                              where n.nspname = 'public' and c.relkind in ('r','p')
                                and a.grantee = 'app_runtime'::regrole
                                and a.privilege_type = 'DELETE')
  ) into v_posture;

  ------------------------------------------------------------------
  -- how big, and where the bulk sits
  ------------------------------------------------------------------
  -- Bytes are returned as numbers because the web formats them; Postgres would hand
  -- int8 back as a JSON string and a size bar given "4194304" draws nothing.
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database())::numeric,
    'largest', coalesce((select jsonb_agg(jsonb_build_object(
                     'table', x.relname, 'bytes', x.bytes, 'indexes', x.n_idx) order by x.bytes desc)
                   from (
                     select c.relname,
                            pg_total_relation_size(c.oid)::numeric as bytes,
                            (select count(*)::int from pg_index i where i.indrelid = c.oid) as n_idx
                       from pg_class c
                       join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relkind in ('r','p')
                        and c.relname <> 'schema_migrations'
                      order by pg_total_relation_size(c.oid) desc
                      limit 10) x), '[]'::jsonb),
    'rows_estimated', coalesce((select jsonb_agg(jsonb_build_object(
                     'table', y.relname, 'rows', round(greatest(y.reltuples, 0))) order by y.reltuples desc)
                   from (
                     select c.relname, c.reltuples::numeric
                       from pg_class c
                       join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public' and c.relkind in ('r','p')
                        and c.relname <> 'schema_migrations'
                      order by c.reltuples desc
                      limit 10) y), '[]'::jsonb)
  ) into v_size;

  ------------------------------------------------------------------
  -- migrations
  ------------------------------------------------------------------
  select jsonb_build_object(
    'applied',          (select count(*)::int from schema_migrations),
    'last_name',        (select m.name from schema_migrations m order by m.name desc limit 1),
    'last_applied_at',  (select max(m.applied_at) from schema_migrations m),
    'first_applied_at', (select min(m.applied_at) from schema_migrations m)
  ) into v_migrations;

  ------------------------------------------------------------------
  -- auth pressure and live access
  ------------------------------------------------------------------
  -- A locked account is a support call that has not arrived yet and an open control
  -- session is a door that is currently open. Both are cheap and both are facts.
  select jsonb_build_object(
    'sessions_live',         (select count(*)::int from sessions
                                where revoked_at is null and expires_at > now()),
    'sessions_expiring_24h', (select count(*)::int from sessions
                                where revoked_at is null and expires_at > now()
                                  and expires_at < now() + interval '24 hours'),
    'accounts_locked',       (select count(*)::int from users
                                where deleted_at is null and locked_until is not null
                                  and locked_until > now()),
    'accounts_with_failures',(select count(*)::int from users
                                where deleted_at is null and failed_login_count > 0),
    'rate_buckets_24h',      (select count(*)::int from rate_limits
                                where window_start > now() - interval '24 hours'),
    'rate_hits_24h',         coalesce((select sum(r.count)::numeric from rate_limits r
                                where r.window_start > now() - interval '24 hours'), 0)
  ) into v_access;

  ------------------------------------------------------------------
  -- what the system has been asked to do
  ------------------------------------------------------------------
  -- Same refusal pattern as 066's overview, so the two screens can never disagree
  -- about what counts as a refusal.
  select jsonb_build_object(
    'audit_24h',        (select count(*)::int from audit_logs
                           where ts > now() - interval '24 hours'),
    'audit_30d',        (select count(*)::int from audit_logs
                           where ts > now() - interval '30 days'),
    'audit_actors_30d', (select count(distinct a.actor_user_id)::int from audit_logs a
                           where a.ts > now() - interval '30 days'),
    'refusals_24h',     (select count(*)::int from audit_logs
                           where ts > now() - interval '24 hours'
                             and action ~* '(failed|lockout|denied|refused|revoked)'),
    'top_actions_30d',  coalesce((select jsonb_agg(jsonb_build_object(
                           'action', x.action, 'events', x.n) order by x.n desc)
                       from (
                         select a.action, count(*)::int as n from audit_logs a
                          where a.ts > now() - interval '30 days'
                         group by a.action order by count(*) desc limit 8) x), '[]'::jsonb),
    'last_event_at',    (select max(a.ts) from audit_logs a)
  ) into v_activity;

  ------------------------------------------------------------------
  -- the modules, counted
  ------------------------------------------------------------------
  -- Platform seats are kept out of the company headcount on purpose: a control seat
  -- is not a customer's staff member, and 066/068 have filtered it this way since the
  -- first aggregate.
  select jsonb_build_object(
    'companies',            (select count(*)::int from tenants
                               where deleted_at is null and type <> 'platform'),
    'companies_by_status',  coalesce((select jsonb_object_agg(x.status, x.n)
                       from (select t.status, count(*)::int as n from tenants t
                              where t.deleted_at is null and t.type <> 'platform'
                              group by t.status) x), '{}'::jsonb),
    'companies_by_type',    coalesce((select jsonb_object_agg(x.type, x.n)
                       from (select t.type, count(*)::int as n from tenants t
                              where t.deleted_at is null and t.type <> 'platform'
                              group by t.type) x), '{}'::jsonb),
    'users_company',        (select count(*)::int from users
                               where deleted_at is null and user_type <> 'platform'),
    'users_platform',       (select count(*)::int from users
                               where deleted_at is null and user_type = 'platform'),
    'seekers',              (select count(*)::int from seekers
                               where deleted_at is null),
    'seekers_email_verified', (select count(*)::int from seekers
                               where deleted_at is null and email_verified_at is not null),
    'subscriptions',        coalesce((select jsonb_object_agg(x.status, x.n)
                       from (select s.status, count(*)::int as n from subscriptions s
                              where s.deleted_at is null group by s.status) x), '{}'::jsonb),
    'seats_licensed',       coalesce((select sum(s.seats_licensed)::numeric from subscriptions s
                               where s.deleted_at is null
                                 and s.status in ('active','trial','grace')), 0),
    'invoices',             coalesce((select jsonb_object_agg(x.status, x.n)
                       from (select i.status, count(*)::int as n from invoices i
                              where i.deleted_at is null group by i.status) x), '{}'::jsonb),
    'passes',               coalesce((select jsonb_object_agg(x.status, x.n)
                       from (select p.status, count(*)::int as n
                                from seeker_search_passes p
                               where p.deleted_at is null group by p.status) x), '{}'::jsonb),
    'searches_30d',         (select count(*)::int from seeker_searches
                               where created_at > now() - interval '30 days'),
    'listings',             coalesce((select jsonb_object_agg(x.status, x.n)
                       from (select l.status, count(*)::int as n from directory_listings l
                              where l.deleted_at is null group by l.status) x), '{}'::jsonb),
    'documents',            (select count(*)::int from documents
                               where deleted_at is null),
    'document_bytes',       coalesce((select sum(d.size_bytes)::numeric from documents d
                               where d.deleted_at is null), 0),
    'jobs_open',            (select count(*)::int from jobs
                               where record_kind = 'live' and status = 'open'),
    'job_stages_blocked',   (select count(*)::int from job_stages
                               where status = 'blocked'),
    'office_employees',     (select count(*)::int from employees
                               where deleted_at is null and status = 'active'),
    'office_tasks_open',    (select count(*)::int from office_tasks
                               where status in ('pending','in_progress')),
    'attendance_30d',       (select count(*)::int from employee_attendance
                               where work_date >= (now() at time zone 'Africa/Dar_es_Salaam')::date - 30),
    'transport_requests_open', (select count(*)::int from transport_requests
                               where deleted_at is null and status = 'open'),
    'transport_bookings_live', (select count(*)::int from transport_bookings
                               where deleted_at is null
                                 and status in ('temp_booked','confirmed'))
  ) into v_modules;

  ------------------------------------------------------------------
  -- statistics, and the janitor's gaps
  ------------------------------------------------------------------
  -- Everything here is only as current as the collector, so stats_reset travels with
  -- it. `audit_partitions` is the finding nobody has written down yet: 001 declared
  -- audit_logs range-partitioned by month over ts and created only the default child,
  -- so every row whatever its timestamp lands in one table, no partition is ever cut
  -- and the pruning the declaration promises never happens.
  select jsonb_build_object(
    'stats_reset',       (select d.stats_reset from pg_stat_database d
                            where d.datname = current_database()),
    'db_uptime_seconds', (select extract(epoch from now() - pg_postmaster_start_time())::numeric),
    'seq_scan_tables',   coalesce((select jsonb_agg(jsonb_build_object(
                           'table', x.relname, 'seq_scans', x.seq_scan) order by x.seq_scan desc)
                       from (
                         select s.relname, s.seq_scan::numeric
                           from pg_stat_user_tables s
                           join pg_class c on c.oid = s.relid
                           join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'public'
                            and s.seq_scan > 1000 and s.seq_scan > 10 * s.idx_scan
                          order by s.seq_scan desc limit 8) x), '[]'::jsonb),
    'indexes_never_scanned', (select count(*)::int
                       from pg_stat_user_indexes ui
                       join pg_class c on c.oid = ui.relid
                       join pg_namespace n on n.oid = c.relnamespace
                       join pg_index i on i.indexrelid = ui.indexrelid
                      where n.nspname = 'public' and ui.idx_scan = 0 and not i.indisunique),
    'tables_without_indexes', coalesce((select array_agg(x.relname order by x.relname)
                       from (
                         select c.relname
                           from pg_class c
                           join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname = 'public' and c.relkind = 'r'
                            and c.relname <> 'schema_migrations'
                            and not exists (select 1 from pg_index i where i.indrelid = c.oid)
                          limit 20) x), '{}'::text[]),
    'audit_partitions',  coalesce((select array_agg(c.relname order by c.relname)
                       from pg_inherits h
                       join pg_class p on p.oid = h.inhparent
                       join pg_class c on c.oid = h.inhrelid
                      where p.relname = 'audit_logs'), '{}'::text[]),
    'dead_tuples_total', coalesce((select sum(s.n_dead_tup)::numeric
                       from pg_stat_user_tables s
                       join pg_class c on c.oid = s.relid
                       join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public'), 0),
    'last_autovacuum',   (select max(s.last_autovacuum)
                       from pg_stat_user_tables s
                       join pg_class c on c.oid = s.relid
                       join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'public')
  ) into v_stats;

  return jsonb_build_object(
    'generated_at', now(),
    'currency', 'TZS',
    'shape', v_shape,
    'posture', v_posture,
    'size', v_size,
    'migrations', v_migrations,
    'access', v_access,
    'activity', v_activity,
    'modules', v_modules,
    'statistics', v_stats,
    'caveats', jsonb_build_array(
      'Rows marked estimated come from pg_class.reltuples, which is refreshed by ANALYZE '
        || 'or autovacuum, not by the insert.',
      'Scan counts, dead tuples and index usage are measured since the statistics reset '
        || 'time shown beside them, and a server restart zeroes them.',
      'Document bytes are the sizes uploaders declared. The bucket lives in Supabase '
        || 'storage and its true size is not readable from Postgres, so this is not the '
        || 'storage bill.',
      'The API keeps no latency, error-rate or request-timing store. /api/v1/health only '
        || 'proves a process is answering, so this report cannot state uptime, slowness '
        || 'or failure rate.',
      'There are no funnel events — no page views, no signup source, no invitations — so '
        || 'adoption is inferred from rows that exist, not from a journey anyone walked.',
      'Nothing prunes, partitions or archives audit_logs. This reader is the only '
        || 'maintenance the trail has.'
      )
    );
end;
$$;

-- ============================================================
-- 4. THE ADVISORY
-- ============================================================
--
-- Each rule below is `return query select … where exists (…)`: the guard is what
-- keeps an honest list short. rank is the sort key the panel uses (lower is more
-- urgent) and is returned rather than applied, because plpgsql appends one rule at a
-- time and cannot order across them. kind is the sort of attention needed — revenue,
-- growth, retention, improvement or risk.

drop function if exists platform_auth.control_advisory();
create or replace function platform_auth.control_advisory()
returns table (
  item_id text, rank int, kind text, priority text, area text,
  title text, detail text, metric numeric, unit text,
  action text, evidence jsonb)
language plpgsql
stable security definer set search_path = public as $$
begin

  ------------------------------------------------------------------
  -- posture findings that should print nothing
  ------------------------------------------------------------------
  -- A tenant-bearing table without RLS, or a definer function still reachable from
  -- PUBLIC, is exactly the class of hole 041/051/066 were written to close, and the
  -- suites assert they are shut. This is the same assertion left running in daylight,
  -- so the day a new table is written without a policy it shows up here before it
  -- shows up in somebody else's query.
  return query
    with holes as (
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
         and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped
       where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity
         and not exists (select 1 from pg_inherits h where h.inhrelid = c.oid)
       group by c.relname
    )
    select 'rls_missing'::text, 0, 'risk'::text, 'high'::text, 'Security'::text,
      'Tables that hold a tenant column but do not enable row-level security'::text,
      'Every table with a tenant_id is expected to enforce RLS; that is the whole '
        || 'isolation story of this product and step 2 of the spec proved it end to end. '
        || 'A new table written without one is the only way a leak can arrive quietly.'::text,
      (select count(*)::numeric from holes),
      'tables'::text,
      'Enable RLS, add the tenant policy, then re-run verify-isolation.ts.'::text,
      coalesce((select jsonb_agg(to_jsonb(h.relname) order by h.relname) from holes h), '[]'::jsonb)
   where exists (select 1 from holes);

  return query
    with exposed as (
      select n.nspname || '.' || p.proname as fn
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public','platform_auth')
         and p.prosecdef and p.proacl is null
    )
    select 'definer_exposed'::text, 0, 'risk'::text, 'high'::text, 'Security'::text,
      'SECURITY DEFINER functions still reachable from PUBLIC'::text,
      'A definer function nobody revoked walks in with the owner''s rights, and 051 '
        || 'exists because default privileges handed exactly that to the browser roles. '
        || 'Anything named here was added without the revoke line that every 066/068 '
        || 'reader carries.'::text,
      (select count(*)::numeric from exposed),
      'functions'::text,
      'Revoke from public, anon, authenticated and service_role; grant execute to app_runtime.'::text,
      coalesce((select jsonb_agg(to_jsonb(e.fn) order by e.fn) from exposed e), '[]'::jsonb)
   where exists (select 1 from exposed);

  ------------------------------------------------------------------
  -- a licence that is exceeded is a support incident in progress
  ------------------------------------------------------------------
  -- Live staff against licensed seats. The gate refuses the next person they add, so
  -- on these accounts the block is already happening somewhere and has not reached
  -- this desk. Never let a paying company discover the ceiling by being locked out.
  return query
    with held as (
      select t.id as tenant_id, t.name, s.seats_licensed::numeric as seats,
             (select count(*)::numeric from users u
               where u.tenant_id = t.id and u.deleted_at is null
                 and u.user_type <> 'platform') as people
        from subscriptions s
        join tenants t on t.id = s.tenant_id
       where s.deleted_at is null and t.deleted_at is null
         and t.type <> 'platform' and s.status in ('active','grace')
    ), beyond as (select * from held where people > seats)
    select 'seats_exceeded'::text, 1, 'risk'::text, 'high'::text, 'Licensing'::text,
      'Companies with more staff than licensed seats'::text,
      'These companies hold more live staff than their licence allows. The gate refuses '
        || 'the next person they add, so the lockout has probably already started and no '
        || 'one has told this desk. Raise the licence, or the invoice — not the ceiling '
        || 'on their people.'::text,
      (select count(*)::numeric from beyond),
      'companies'::text,
      'True up the licence and the invoice for these accounts this week.'::text,
      coalesce((select jsonb_agg(jsonb_build_object('company', b.name, 'seats', b.seats,
        'people', b.people) order by b.people - b.seats desc)
        from (select * from beyond order by people - seats desc limit 8) b), '[]'::jsonb)
   where exists (select 1 from beyond);

  ------------------------------------------------------------------
  -- the trial window closes whether or not anyone acts
  ------------------------------------------------------------------
  return query
    with soon as (
      select t.name, s.trial_ends_at::date as ends_on,
             (s.trial_ends_at::date - now()::date)::numeric as days_left
        from subscriptions s
        join tenants t on t.id = s.tenant_id
       where s.deleted_at is null and t.deleted_at is null
         and s.status = 'trial' and s.trial_ends_at is not null
         and s.trial_ends_at > now()
         and s.trial_ends_at <= now() + interval '14 days'
    )
    select 'trial_closing'::text, 2, 'revenue'::text, 'high'::text, 'Sales'::text,
      'Trials that end inside a fortnight'::text,
      'A trial that reaches its date with no decision taken converts at whatever the '
        || 'default is, and the default was not chosen by anyone. Fourteen days is long '
        || 'enough for a conversation and short enough that the company still remembers '
        || 'why it signed up.'::text,
      (select count(*)::numeric from soon),
      'trials'::text,
      'Contact each of these before its end date; activate it or record why not.'::text,
      coalesce((select jsonb_agg(jsonb_build_object('company', s.name, 'ends_on', s.ends_on,
        'days_left', s.days_left) order by s.days_left)
        from (select * from soon order by days_left limit 8) s), '[]'::jsonb)
   where exists (select 1 from soon);

  ------------------------------------------------------------------
  -- renewals with nothing paid behind them
  ------------------------------------------------------------------
  -- "Nothing paid for this period" is measured the same way the ledger measures
  -- income — invoices.paid_at inside the current period, status paid — so a renewal
  -- flagged here is a renewal the money screen agrees about.
  return query
    with due as (
      select t.name, s.current_period_end::date as ends_on,
             (s.current_period_end::date - now()::date)::numeric as days_to_renewal,
             s.billing_cycle, s.seats_licensed::numeric as seats
        from subscriptions s
        join tenants t on t.id = s.tenant_id
       where s.deleted_at is null and t.deleted_at is null
         and s.status = 'active' and s.auto_renew
         and s.current_period_end > now()
         and s.current_period_end <= now() + interval '30 days'
         and not exists (select 1 from invoices i
            where i.subscription_id = s.id and i.deleted_at is null
              and i.status = 'paid' and i.paid_at >= s.current_period_start)
    )
    select 'renewal_unpaid'::text, 3, 'revenue'::text, 'high'::text, 'Money'::text,
      'Companies due to renew inside thirty days with nothing paid for this period'::text,
      'The licence gate will do this for us if we do not: grace, then expired. An office '
        || 'that discovers its own lapse does not come back cheerfully, and the renewal '
        || 'it skipped is the one it was billed for.'::text,
      (select count(*)::numeric from due),
      'companies'::text,
      'Invoice or chase payment for each of these before the period closes.'::text,
      coalesce((select jsonb_agg(jsonb_build_object('company', d.name, 'ends_on', d.ends_on,
        'days_to_renewal', d.days_to_renewal, 'cycle', d.billing_cycle)
        order by d.days_to_renewal)
        from (select * from due order by days_to_renewal limit 10) d), '[]'::jsonb)
   where exists (select 1 from due);

  ------------------------------------------------------------------
  -- seats sold and not used: churn that has not announced itself
  ------------------------------------------------------------------
  return query
    with held as (
      select t.name, s.seats_licensed::numeric as seats,
             (select count(*)::numeric from users u
               where u.tenant_id = t.id and u.deleted_at is null
                 and u.user_type <> 'platform') as people,
             greatest(s.seats_licensed - (select count(*) from users u
               where u.tenant_id = t.id and u.deleted_at is null
                 and u.user_type <> 'platform'), 0)::numeric as idle
        from subscriptions s
        join tenants t on t.id = s.tenant_id
       where s.deleted_at is null and t.deleted_at is null
         and t.type <> 'platform' and s.status in ('active','grace')
         and s.seats_licensed >= 5
    ), thin as (select * from held where people <= floor(seats / 2))
    select 'seats_idle'::text, 4, 'retention'::text, 'medium'::text, 'Licensing'::text,
      'Companies paying for seats they do not fill'::text,
      'A customer billed for seats it never uses is not saving that money for us — it is '
        || 'shopping. Either someone walks the account and puts people into the system, or '
        || 'the office right-sizes it before the renewal and keeps the customer. Silence '
        || 'until the cancellation nobody was warned about is the worst of the three.'::text,
      (select coalesce(sum(idle), 0)::numeric from thin),
      'idle seats'::text,
      'Walk each of these accounts before its next renewal: fill the seats or right-size them.'::text,
      coalesce((select jsonb_agg(jsonb_build_object('company', x.name, 'seats', x.seats,
        'people', x.people, 'idle', x.idle) order by x.idle desc)
        from (select * from thin order by idle desc limit 8) x), '[]'::jsonb)
   where exists (select 1 from thin);

  ------------------------------------------------------------------
  -- one-person companies: the cheapest expansion in the register
  ------------------------------------------------------------------
  -- Exactly one live user is a licence bought for a person rather than an office. It
  -- needs no telemetry to be true, and every module since 038 assumes more hands.
  return query
    with one as (
      select t.name, s.seats_licensed::numeric as seats, s.status
        from subscriptions s
        join tenants t on t.id = s.tenant_id
       where s.deleted_at is null and t.deleted_at is null
         and t.type <> 'platform'
         and s.status in ('active','trial','grace')
         and (select count(*) from users u
               where u.tenant_id = t.id and u.deleted_at is null
                 and u.user_type <> 'platform') = 1
    )
    select 'single_seat_company'::text, 5, 'growth'::text, 'medium'::text, 'Accounts'::text,
      'Companies running the whole system through one person'::text,
      'These companies have exactly one live user, so nothing in the product is reachable '
        || 'by a second person until one is added and adoption is capped by a hiring '
        || 'decision the office has never been invited to make. Attendance, jobs and the '
        || 'office modules all assume more than one pair of hands.'::text,
      (select count(*)::numeric from one),
      'companies'::text,
      'Offer a guided second-seat setup. It is the cheapest growth on this list.'::text,
      coalesce((select jsonb_agg(jsonb_build_object('company', o.name, 'seats', o.seats)
        order by o.name) from (select * from one order by name limit 10) o), '[]'::jsonb)
   where exists (select 1 from one);

  ------------------------------------------------------------------
  -- seeker money standing at the door
  ------------------------------------------------------------------
  -- A pass in awaiting_verification is income the office has been promised and has not
  -- yet let through; 061 makes the seeker record a reference and a person confirm it,
  -- so the only thing between that row and a live week of searching is somebody at
  -- this desk.
  return query
    with stuck as (
      select sp.id, sp.kind, sp.amount::numeric as amount, sp.created_at,
             round(extract(epoch from now() - sp.created_at) / 3600) as waiting_hours,
             coalesce(nullif(trim(sn.first_name || ' ' || sn.last_name), ''), 'a seeker') as seeker
        from seeker_search_passes sp
        left join seekers sn on sn.user_id = sp.user_id
       where sp.deleted_at is null
         and sp.status = 'awaiting_verification'
         and sp.created_at < now() - interval '24 hours'
    )
    select 'pass_queue'::text, 6, 'revenue'::text, 'high'::text, 'Marketplace'::text,
      'Search passes that have waited a day to be verified'::text,
      'Every row here is a seeker who asked to search and is still standing at the door. '
        || 'Nothing else in the marketplace grows while it waits, and a seeker who waits a '
        || 'day for one search does not come back to ask twice.'::text,
      (select coalesce(sum(s.amount), 0)::numeric from stuck s),
      'TZS pending'::text,
      'Work the confirmation queue at the start of every working day.'::text,
      coalesce((select jsonb_agg(jsonb_build_object('seeker', s.seeker, 'kind', s.kind,
        'amount', s.amount, 'waiting_hours', s.waiting_hours) order by s.created_at)
        from (select * from stuck order by created_at limit 8) s), '[]'::jsonb)
   where exists (select 1 from stuck);

  ------------------------------------------------------------------
  -- demand the directory cannot answer
  ------------------------------------------------------------------
  -- seeker_searches stores `found` per region, so a region where seekers look and
  -- listings do not exist is not a hunch about supply — it is a named gap with a count
  -- beside it. This is the most direct answer the schema can give to "how do we gain
  -- new customers": they are already looking, in a specific place.
  return query
    with want as (
      select q.region_id, q.region, q.searches, q.no_result,
             (select count(*)::int from directory_listings l
               join directory_listing_regions lr on lr.listing_id = l.id
              where l.status = 'live' and l.deleted_at is null
                and lr.region_id = q.region_id) as live_listings
        from (
          select ss.filter_region_id as region_id, g.name_en as region,
                 count(*)::int as searches,
                 count(*) filter (where ss.found = 0)::int as no_result
            from seeker_searches ss
            join geo_regions g on g.id = ss.filter_region_id
           where ss.filter_region_id is not null
             and ss.created_at > now() - interval '90 days'
           group by ss.filter_region_id, g.name_en
          having count(*) >= 3
        ) q
    ), gaps as (select * from want where live_listings < 3)
    select 'region_underserved'::text, 7, 'growth'::text, 'high'::text, 'Marketplace'::text,
      'Regions seekers search in that the directory cannot answer'::text,
      'People are already looking in these regions and the register comes back thin or '
        || 'empty. A transporter signed up into a region with proven searches is the first '
        || 'customer in this system who was looking before we asked — recruit there before '
        || 'spending on anywhere else.'::text,
      (select coalesce(sum(g.no_result), 0)::numeric from gaps g),
      'searches with nothing found'::text,
      'Recruit listings into these regions and use the demand counts as the pitch.'::text,
      coalesce((select jsonb_agg(jsonb_build_object('region', g.region, 'searches', g.searches,
        'no_result', g.no_result, 'live_listings', g.live_listings)
        order by g.no_result desc, g.searches desc)
        from (select * from gaps order by no_result desc limit 8) g), '[]'::jsonb)
   where exists (select 1 from gaps);

  ------------------------------------------------------------------
  -- paying companies the marketplace cannot see
  ------------------------------------------------------------------
  -- Only a transporter tenant can hold a live listing: the guard in 061 refuses 'live'
  -- for any other type. So this rule is deliberately restricted to transporter
  -- tenants — telling a shipper to publish a listing it can never be approved for is
  -- the kind of advice that makes a panel untrustworthy.
  return query
    with invisible as (
      select t.name
        from tenants t
        join subscriptions s on s.tenant_id = t.id and s.deleted_at is null
       where t.deleted_at is null and t.type = 'transporter'
         and t.status in ('active','trial','grace')
         and not exists (select 1 from directory_listings l
            where l.tenant_id = t.id and l.deleted_at is null and l.status = 'live')
    )
    select 'no_live_listing'::text, 8, 'growth'::text, 'medium'::text, 'Marketplace'::text,
      'Transporter companies on a live licence with nothing in the directory'::text,
      'The directory is the only part of this product that brings in people the office did '
        || 'not recruit. A live company with no listing feeds nothing into that flywheel, '
        || 'and the listing is largely a profile the customer has already written — it '
        || 'needs a nudge, not a campaign.'::text,
      (select count(*)::numeric from invisible),
      'companies'::text,
      'Ask each of these to publish; the marketplace search is why a seeker arrives.'::text,
      coalesce((select jsonb_agg(to_jsonb(i.name) order by i.name)
        from (select * from invisible order by name limit 10) i), '[]'::jsonb)
   where exists (select 1 from invisible);

  ------------------------------------------------------------------
  -- verified seekers who never searched
  ------------------------------------------------------------------
  return query
    with silent as (
      select count(*)::int as n
        from seekers sn
       where sn.deleted_at is null and sn.email_verified_at is not null
         and not exists (select 1 from seeker_searches ss where ss.user_id = sn.user_id)
    )
    select 'seeker_unused'::text, 9, 'growth'::text, 'medium'::text, 'Marketplace'::text,
      'Verified seekers who have never run a search'::text,
      'They confirmed the email and stopped. Signup asks two names, a phone and an '
        || 'industry — nothing that captures what they meant to find — so the gap between '
        || 'verifying and searching is a gap in what the product said it was for, not a '
        || 'lack of intent.'::text,
      (select s.n::numeric from silent s),
      'seekers'::text,
      'Put one obvious first search in front of a seeker the moment the email confirms.'::text,
      jsonb_build_array()
   where (select n from silent) > 0;

  ------------------------------------------------------------------
  -- dormancy
  ------------------------------------------------------------------
  return query
    with cold as (
      select t.name,
             (select max(u.last_login_at) from users u
               where u.tenant_id = t.id and u.deleted_at is null
                 and u.user_type <> 'platform') as last_seen
        from tenants t
        join subscriptions s on s.tenant_id = t.id and s.deleted_at is null
       where t.deleted_at is null and t.type <> 'platform'
         and s.status in ('active','trial','grace')
    ), dark as (
      select * from cold where last_seen is null or last_seen < now() - interval '30 days'
    )
    select 'dormant_company'::text, 10, 'retention'::text, 'high'::text, 'Accounts'::text,
      'Companies on a live licence where nobody has signed in for thirty days'::text,
      'A licence that is paid and unused renews once, and then does not renew at all. '
        || 'Nobody here has been refused anything — the account has simply stopped being '
        || 'used, which is still the moment a call helps.'::text,
      (select count(*)::numeric from dark),
      'companies'::text,
      'Reach these accounts before the renewal rather than after the lapse.'::text,
      coalesce((select jsonb_agg(jsonb_build_object('company', d.name,
        'last_login', d.last_seen) order by d.last_seen nulls first)
        from (select * from dark order by last_seen nulls first limit 10) d), '[]'::jsonb)
   where exists (select 1 from dark);

  ------------------------------------------------------------------
  -- the queues the office is sitting on
  ------------------------------------------------------------------
  -- The blocked reason is typed by the person who raised it, so the list below is the
  -- office describing its own bottlenecks in its own words. Where one reason repeats,
  -- it is a process, not a file.
  return query
    with blocked as (
      select js.blocked_reason as reason, count(*)::int as n
        from job_stages js
       where js.status = 'blocked' and coalesce(js.blocked_reason, '') <> ''
       group by js.blocked_reason
       order by count(*) desc
       limit 6
    )
    select 'blocked_stages'::text, 11, 'improve'::text, 'medium'::text, 'Operations'::text,
      'Cargo file stages sitting in blocked'::text,
      'These are cross-tenant, so no individual dashboard shows them together. A reason '
        || 'that appears on half a dozen files is a step that is broken for everyone, not '
        || 'a file that is behind.'::text,
      (select coalesce(sum(b.n), 0)::numeric from blocked b),
      'stages'::text,
      'Read the repeated reasons as one problem and fix the step, not the stage.'::text,
      coalesce((select jsonb_agg(jsonb_build_object('reason', b.reason, 'files', b.n)
        order by b.n desc) from blocked b), '[]'::jsonb)
   where exists (select 1 from blocked);

  -- The audit trail is partitioned by month in name only: 001 created the parent and
  -- the default child and nothing since has cut another. That is not a bug today — it
  -- is the reason the forensic reader will be slow one day, and no index added later
  -- can fix a partition that does not exist.
  return query
    with parts as (
      select count(*)::int as n
        from pg_inherits h
        join pg_class p on p.oid = h.inhparent
       where p.relname = 'audit_logs'
    ), filled as (
      -- The size of the trail is read as an estimate on purpose: this rule is about a
      -- table that only grows, and a count(*) here would make the panel that warns
      -- about the cost of the trail pay that cost on every open.
      select coalesce(sum(greatest(c.reltuples, 0)), 0)::numeric as n
        from pg_inherits h
        join pg_class p on p.oid = h.inhparent
        join pg_class c on c.oid = h.inhrelid
       where p.relname = 'audit_logs'
    )
    select 'audit_unpartitioned'::text, 12, 'risk'::text, 'medium'::text, 'Data'::text,
      'The audit trail is partitioned by month in name only'::text,
      'audit_logs is range-partitioned on ts but holds only its default child, so every '
        || 'event lands in one table and partition pruning does nothing. The trail is '
        || 'append-only by trigger and has no archive job, so it grows without a ceiling.'::text,
      (select f.n from filled f),
      'rows in the trail, estimated'::text,
      'Cut monthly partitions, or an archive table, before the trail is the slowest screen in the panel.'::text,
      coalesce((select jsonb_agg(to_jsonb(c.relname) order by c.relname)
         from pg_inherits h
         join pg_class p on p.oid = h.inhparent
         join pg_class c on c.oid = h.inhrelid
        where p.relname = 'audit_logs'), '[]'::jsonb)
   where (select n from parts) <= 1;

  return query
    with stale as (
      select count(*)::int as n, coalesce(max(extract(epoch from now() - l.created_at) / 86400), 0)::numeric
             as oldest_days
        from leave_requests l
       where l.deleted_at is null and l.status = 'pending'
         and l.created_at < now() - interval '7 days'
    )
    select 'leave_pending'::text, 20, 'improve'::text, 'low'::text, 'Office'::text,
      'Leave requests nobody has decided'::text,
      'A pending request is an employee who does not know whether they are away. Payroll '
        || '(#113) will read approved unpaid leave and unrecorded absences, so an '
        || 'undecided request is also a figure that has not settled.'::text,
      (select s.n::numeric from stale s),
      'requests over a week old'::text,
      'Clear the leave queue before the payroll run.'::text,
      jsonb_build_array()
   where (select n from stale) > 0;

  return query
    with late as (
      select count(*)::int as n
        from office_tasks o
       where o.status in ('pending','in_progress')
         and o.due_date is not null and o.due_date < now()::date
    )
    select 'tasks_overdue'::text, 21, 'improve'::text, 'low'::text, 'Office'::text,
      'Office assignments past their due date'::text,
      'Overdue work is the cheapest item on this list to fix and the easiest to ignore, '
        || 'because nothing breaks. The punctuality grade in 038 is computed from the same '
        || 'column, so this backlog is already pulling someone''s evaluation down.'::text,
      (select l.n::numeric from late l),
      'tasks'::text,
      'Re-plan or close them; a stale due date is worse than none.'::text,
      jsonb_build_array()
   where (select n from late) > 0;

  ------------------------------------------------------------------
  -- two things the panel is asked to show that it cannot
  ------------------------------------------------------------------
  -- Not speculation: both come straight from columns that exist. Profit on the
  -- revenue screen is income minus platform_costs, and platform_costs has no DELETE
  -- and no importer — a month with no rows is a month reporting a profit that is
  -- really an absence of bookkeeping.
  return query
    select 'costs_thin'::text, 14, 'improve'::text, 'medium'::text, 'Money'::text,
      'The P&L is only as good as the cost ledger behind it'::text,
      'Profit on the revenue screen is income minus platform_costs. The ledger cannot be '
        || 'deleted from and nothing writes to it automatically, so a month with no rows '
        || 'shows a profit that is really an absence of bookkeeping — and the forecast then '
        || 'fits a slope to it.'::text,
      (select count(*)::numeric from platform_costs),
      'cost rows'::text,
      'Record infrastructure, salaries, marketing and support for every month the panel is asked to report.'::text,
      coalesce((select jsonb_agg(jsonb_build_object('month', to_char(p.period, 'FMMonth YYYY'),
        'categories', p.n) order by p.period desc)
        from (select date_trunc('month', pc.period) as period, count(*)::int as n
                from platform_costs pc group by 1) p), '[]'::jsonb)
   where (select count(distinct date_trunc('month', pc.period)) from platform_costs pc) < 3;

  return query
    select 'no_price_history'::text, 15, 'improve'::text, 'low'::text, 'Pricing'::text,
      'Nothing remembers what a price used to be'::text,
      '068 made the bundle prices editable, so the register now computes monthly '
        || 'equivalent from whatever the price is today. Each invoice keeps its own amount, '
        || 'which is why the ledger stays honest — but "did the December change cost us '
        || 'anyone" has no answer, because no table holds the old figure.'::text,
      (select count(*)::numeric from service_groups g where g.is_active),
      'live bundles'::text,
      'If pricing starts moving, write a price-history row in the same transaction as the update.'::text,
      jsonb_build_array();

  return;
end;
$$;

-- ============================================================
-- 5. Grants
-- ============================================================
--
-- Execute for the runtime role and revoked from every role a browser can be, for all
-- three readers. 068 skipped control_overview in its revoke because 066 had already
-- revoked it and a re-create keeps the old ACL; nothing here is already revoked, so
-- every function gets both lines.

grant execute on function platform_auth.control_system_report() to app_runtime;
grant execute on function platform_auth.control_advisory() to app_runtime;
grant execute on function platform_auth.control_migrations_applied() to app_runtime;

revoke all on function platform_auth.control_system_report()
  from public, anon, authenticated, service_role;
revoke all on function platform_auth.control_advisory()
  from public, anon, authenticated, service_role;
revoke all on function platform_auth.control_migrations_applied()
  from public, anon, authenticated, service_role;

commit;
