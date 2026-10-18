-- 071 — the forensic actor register (admin panel, task #119).
--
-- 066 shipped the trail and its filters, and the desk was built on the assumption that
-- a person opening it already knows what they are looking for. Nobody does. The first
-- question a forensic read is asked backwards: not "what happened?" but "who touched
-- this, and how much of the system did they reach?" — then one of those people, then
-- their rows. 066's reader cannot answer that: it groups nothing, and its only actor
-- filter is a uuid the operator would have to already possess.
--
-- So this is ONE aggregate over the same table, and the same redaction rules still
-- apply because nothing here reads a payload. The columns are counts and clocks:
-- events, distinct actions, distinct entities, distinct source addresses, how many
-- tenants that actor's rows name, and first/last seen. `ips` and `tenants_touched` are
-- the two worth arguing about. An address count is a person on hotel wifi or a person
-- behind one corporate NAT, and the desk is not a court — it says "look at this", never
-- "this is a fraud". Tenants touched is the one that matters on a platform desk,
-- because a control seat legitimately crossing tenants is normal and a tenant seat
-- doing it is not; the register shows both numbers and leaves the reading to the human.
--
-- Deliberately NOT here: no risk score, no "anomalous" flag, no session reconstruction.
-- audit_logs has no session column, so a timeline of one login would be invented, and
-- 069 already reports the things the schema cannot answer rather than dressing up a
-- guess as a measurement.
--
-- Money rule honoured throughout: none. This reads a log; it moves nothing.

begin;

-- ============================================================
-- 1. THE REGISTER
-- ============================================================
--
-- Grouped by the actor, not by actor-and-tenant: the point of the screen is one row per
-- person. The tenant shown is the actor's own (users.tenant_id), while `tenants_touched`
-- counts the tenants named on their rows, so a support seat that administers three
-- companies reads as one person with three tenants touched rather than three people.
--
-- actor_user_id is nullable by design — 066's step-8 work writes an attempt against an
-- unknown identity with no tenant and no actor. Those rows are not a person, so they are
-- left out of a register of people; they stay reachable through the trail itself.
--
-- A soft-deleted account stays in the register. Someone who worked and was then removed
-- did the work, and a forensic screen that hides them is worse than one that shows them
-- with their status on the row.

drop function if exists platform_auth.list_audit_actors_for_control(uuid, timestamptz, timestamptz, int);
create or replace function platform_auth.list_audit_actors_for_control(
  p_tenant_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 100
) returns table (
  actor_user_id uuid, actor_name text, actor_email text, actor_type text,
  account_status text, tenant_id uuid, tenant_name text,
  events int, distinct_actions int, distinct_entities int,
  distinct_ips int, tenants_touched int,
  first_seen timestamptz, last_seen timestamptz
) language sql stable security definer set search_path = public as $$
  select a.actor_user_id,
         u.full_name, lower(u.email), u.user_type, u.status,
         u.tenant_id, t.name,
         count(*)::int,
         count(distinct a.action)::int,
         count(distinct a.entity)::int,
         count(distinct nullif(a.ip, ''))::int,
         count(distinct a.tenant_id)::int,
         min(a.ts), max(a.ts)
  from audit_logs a
  join users u on u.id = a.actor_user_id
  left join tenants t on t.id = u.tenant_id
  where a.actor_user_id is not null
    and (p_tenant_id is null or u.tenant_id = p_tenant_id)
    and (p_from is null or a.ts >= p_from)
    and (p_to is null or a.ts <= p_to)
  group by a.actor_user_id, u.full_name, u.email, u.user_type, u.status,
           u.tenant_id, t.name
  order by max(a.ts) desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- ============================================================
-- 2. GRANTS
-- ============================================================
--
-- The 051 sweep, per function: a new definer belongs to PUBLIC until told otherwise,
-- and 069's advisory hunts any that still do. Execute-only, to app_runtime and nobody
-- else — the route is the only caller, and anon must not be able to enumerate who has
-- been signing in.

grant execute on function
  platform_auth.list_audit_actors_for_control(uuid, timestamptz, timestamptz, int)
to app_runtime;

revoke all on function
  platform_auth.list_audit_actors_for_control(uuid, timestamptz, timestamptz, int)
  from public, anon, authenticated, service_role;

commit;
