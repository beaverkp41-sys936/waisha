-- 066: the numbers the platform is asked for, and the audit trail behind them.
--
-- Everything a tenant owns is behind RLS by tenant, which is correct and also means
-- the control panel can see nothing: no client count, no revenue, no growth curve.
-- The only cross-tenant readers so far are three list functions (010/060/061) that
-- answer "which company is this?" — none of them aggregates. This file adds the
-- aggregate side, plus the first SELECT path over audit_logs (the trail has been
-- written since 001 and never once read back).
--
-- Two rules carried from the rest of the schema: money is numeric + an explicit
-- currency, never a float; and a definer that reads across tenants is EXECUTE-only
-- to app_runtime, revoked from every browser role, with the payload it returns
-- stripped of PII before it leaves the database.
begin;

-- ============================================================
-- 1. WHAT THE PLATFORM SPENDS
-- ============================================================
--
-- A profit line needs a cost line. Nothing in the schema recorded what WAISHA pays
-- out — hosting, staff, marketing — so every "revenue" chart the admin panel could
-- draw would be a gross figure wearing a net figure's clothes. One row per category
-- per month: the unique key is the point, because a corrected figure must replace
-- the old one rather than sit next to it and double-count.
--
-- Global reference data like plans and service_groups (using(true)), so the control
-- routes read and edit it and no tenant route ever queries it. No DELETE: a month
-- that has been reported on keeps its numbers, and the correction is audited.

create table if not exists platform_costs (
  id uuid primary key default gen_random_uuid(),
  period date not null check (period = date_trunc('month', period)::date),
  category text not null check (category in
    ('infrastructure','salaries','marketing','licences','support','other')),
  amount numeric(14,2) not null check (amount >= 0),
  currency text not null default 'TZS' check (currency = 'TZS'),
  note text check (note is null or char_length(trim(note)) <= 280),
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_costs_month_category_uq unique (period, category)
);
create index if not exists idx_platform_costs_period on platform_costs (period desc);

drop trigger if exists trg_platform_costs_updated on platform_costs;
create trigger trg_platform_costs_updated before update on platform_costs
  for each row execute function public.set_updated_at();

alter table platform_costs enable row level security;
grant select, insert, update on platform_costs to app_runtime;
drop policy if exists platform_costs_read on platform_costs;
drop policy if exists platform_costs_insert on platform_costs;
drop policy if exists platform_costs_update on platform_costs;
create policy platform_costs_read on platform_costs
  for select to app_runtime using (true);
create policy platform_costs_insert on platform_costs
  for insert to app_runtime with check (true);
create policy platform_costs_update on platform_costs
  for update to app_runtime using (true) with check (true);

-- ============================================================
-- 2. THE AUDIT PAYLOAD, SAFE TO HAND TO A BROWSER
-- ============================================================
--
-- before/after are row snapshots, so they hold exactly the columns the change
-- touched — including tin_encrypted, nida_search, phone, email. The forensic screen
-- needs the payloads to show what changed; it must never be the thing that leaks a
-- national ID. One redactor, applied inside the reader, so no route has to remember
-- to run it.

create or replace function platform_auth.redact_audit_payload(p jsonb, p_depth int default 0)
returns jsonb language plpgsql immutable security definer set search_path = public as $$ declare
  k text; v jsonb; out jsonb := '{}'::jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' or p_depth > 3 then
    return '{}'::jsonb;
  end if;
  for k, v in select key, value from jsonb_each(p) loop
    if k ~* '(encrypted|_search$|^tin$|nida|password|passwd|secret|token|otp|pin$|phone|mobile|email|address|passport|visa|national_id|licence_no|license_no)' then
      out := jsonb_set(out, array[k], '"[redacted]"'::jsonb, true);
    elsif jsonb_typeof(v) = 'object' then
      out := jsonb_set(out, array[k], platform_auth.redact_audit_payload(v, p_depth + 1), true);
    elsif jsonb_typeof(v) = 'array' then
      -- Line-item arrays (an invoice with its items) carry the same columns.
      out := jsonb_set(out, array[k], coalesce((
        select jsonb_agg(case when jsonb_typeof(e) = 'object'
                                then platform_auth.redact_audit_payload(e, p_depth + 1)
                                else e end)
        from jsonb_array_elements(v) e), '[]'::jsonb), true);
    else
      out := jsonb_set(out, array[k], v, true);
    end if;
  end loop;
  return out;
end $$;

-- ============================================================
-- 3. THE OVERVIEW
-- ============================================================
--
-- One call for the landing screen. Everything is a count or a sum over a whole
-- table, so it is deliberately coarse: 30-day windows, month-to-date money, and no
-- per-tenant rows (that is what list_tenants_for_control is for).
--
-- "Active vs non-active users" is answered two ways on purpose: status says what the
-- account is, last_seen says whether anyone actually signed in. A company with forty
-- 'active' accounts and no login in a month is not forty users.

create or replace function platform_auth.control_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$ declare
  r jsonb;
begin
  select jsonb_build_object(
    'generated_at', now(),
    'currency', 'TZS',

    'companies', (select jsonb_build_object(
        'total', count(*) filter (where t.type in ('transporter','shipper')),
        'transporters', count(*) filter (where t.type = 'transporter'),
        'shippers', count(*) filter (where t.type = 'shipper'),
        'pending_verification', count(*) filter (where t.status = 'pending_verification'),
        'active', count(*) filter (where t.status = 'active'),
        'trial', count(*) filter (where t.status = 'trial'),
        'grace', count(*) filter (where t.status = 'grace'),
        'expired', count(*) filter (where t.status = 'expired'),
        'suspended', count(*) filter (where t.status = 'suspended'),
        'licence_expiring_30d', count(*) filter (where t.licence_expires_at between now()
          and now() + interval '30 days'))
      from tenants t where t.deleted_at is null and t.type <> 'platform'),

    'seekers', (select jsonb_build_object(
        'total', count(*),
        'email_verified', count(*) filter (where s.email_verified_at is not null),
        'phone_verified', count(*) filter (where s.phone_verified_at is not null),
        'unverified', count(*) filter (where s.email_verified_at is null
                                        and s.phone_verified_at is null))
      from seekers s where s.deleted_at is null),

    'users', (select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where u.status = 'active'),
        'suspended', count(*) filter (where u.status = 'suspended'),
        'deactivated', count(*) filter (where u.status = 'deactivated'),
        'pending_verification', count(*) filter (where u.status = 'pending_verification'),
        'locked', count(*) filter (where u.locked_until > now()),
        'seen_30d', count(*) filter (where u.last_login_at >= now() - interval '30 days'),
        'dormant_30d', count(*) filter (where u.status = 'active'
          and (u.last_login_at is null or u.last_login_at < now() - interval '30 days')),
        'logged_in_today', count(*) filter (where u.last_login_at::date =
          (now() at time zone 'Africa/Dar_es_Salaam')::date))
      from users u where u.deleted_at is null and u.user_type <> 'platform'),

    'subscriptions', (select jsonb_build_object(
        'total', count(*),
        'active', count(*) filter (where sub.status = 'active'),
        'trial', count(*) filter (where sub.status = 'trial'),
        'grace', count(*) filter (where sub.status = 'grace'),
        'expired', count(*) filter (where sub.status = 'expired'),
        'suspended', count(*) filter (where sub.status = 'suspended'),
        'cancelled', count(*) filter (where sub.status = 'cancelled'),
        'pending', count(*) filter (where sub.status = 'pending'),
        'seats_licensed', coalesce(sum(sub.seats_licensed) filter (
          where sub.status in ('active','trial','grace')), 0))
      from subscriptions sub where sub.deleted_at is null),

    -- Monthly-equivalent, so a quarterly and an annual customer sit on the same
    -- axis. Falls back to the bundle's own ladder when a subscription was sold
    -- against a service group rather than a starter/business/enterprise plan.
    'recurring', (select jsonb_build_object(
        'mrr', coalesce(sum(case sub.billing_cycle
              when 'quarterly' then coalesce(p.price_quarterly, g.price_quarterly) / 3
              when 'annual'     then coalesce(p.price_annual,     g.price_annual)     / 12
              else coalesce(p.price_monthly, g.price_monthly) end), 0),
        'arr', coalesce(sum(case sub.billing_cycle
              when 'quarterly' then coalesce(p.price_quarterly, g.price_quarterly) * 4
              when 'annual'     then coalesce(p.price_annual,    g.price_annual)
              else coalesce(p.price_monthly, g.price_monthly) * 12 end), 0))
      from subscriptions sub
      left join plans p on p.id = sub.plan_id
      left join service_groups g on g.id = sub.service_group_id
      where sub.deleted_at is null and sub.status in ('active','trial','grace')),

    'money', (select jsonb_build_object(
        'collected_30d', coalesce(sum(i.amount_total) filter (
            where i.paid_at >= now() - interval '30 days'), 0),
        'collected_month', coalesce(sum(i.amount_total) filter (
            where date_trunc('month', i.paid_at at time zone 'Africa/Dar_es_Salaam')
                = date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')), 0),
        'vat_month', coalesce(sum(i.vat_amount) filter (
            where date_trunc('month', i.paid_at at time zone 'Africa/Dar_es_Salaam')
                = date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')), 0),
        -- Lifetime count, not a month's — the monthly ones are paid_invoices in
        -- control_revenue. Named so the two cannot be read as the same number.
        'invoices_paid_all_time', count(*) filter (where i.status = 'paid'),
        'outstanding', coalesce(sum(i.amount_total) filter (where i.status = 'issued'), 0),
        'overdue', coalesce(sum(i.amount_total) filter (
            where i.status = 'issued' and i.due_at is not null and i.due_at < now()), 0))
      from invoices i where i.deleted_at is null),

    'passes', (select jsonb_build_object(
        'confirmed_30d', coalesce(sum(sp.amount) filter (
            where sp.status in ('live','expired')
              and sp.created_at >= now() - interval '30 days'), 0),
        'awaiting_verification', count(*) filter (where sp.status = 'awaiting_verification'),
        'rejected', count(*) filter (where sp.status = 'rejected'),
        'live_now', count(*) filter (where sp.status = 'live'
                                      and sp.expires_at > now()))
      from seeker_search_passes sp where sp.deleted_at is null),

    'costs', (select jsonb_build_object(
        'month', coalesce(sum(c.amount) filter (where c.period =
            date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')::date), 0),
        'quarter', coalesce(sum(c.amount) filter (where c.period >=
            (date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')
              - interval '2 months')::date), 0),
        'months_recorded', count(distinct c.period))
      from platform_costs c),

    'marketplace', (select jsonb_build_object(
        'live', count(*) filter (where d.status = 'live'),
        'verified', count(*) filter (where d.status = 'live' and d.is_verified),
        'draft', count(*) filter (where d.status = 'draft'),
        'suspended', count(*) filter (where d.status = 'suspended'),
        'searches_30d', (select count(*) from seeker_searches ss
                          where ss.created_at >= now() - interval '30 days'),
        'searches_7d', (select count(*) from seeker_searches ss
                         where ss.created_at >= now() - interval '7 days'))
      from directory_listings d where d.deleted_at is null),

    'activity', (select jsonb_build_object(
        'events_24h', count(*),
        'events_7d', count(*) filter (where a.ts >= now() - interval '7 days'),
        'actors_24h', count(distinct a.actor_user_id),
        'refusals_24h', count(*) filter (where a.action ~* '(failed|lockout|denied|refused|revoked)'),
        'signups_7d', (select count(*) from tenants t2
                        where t2.deleted_at is null and t2.type <> 'platform'
                          and t2.created_at >= now() - interval '7 days'))
      from audit_logs a where a.ts >= now() - interval '24 hours')
  ) into r;
  return r;
end $$;

-- ============================================================
-- 4. GROWTH — how fast the customer base is actually moving
-- ============================================================

-- create or replace cannot change a function's return type, so the signatures that
-- differ from the first pass of this file are dropped first. This keeps the file
-- re-runnable on a database that already ran an earlier draft of it.
drop function if exists platform_auth.control_growth(int);
create or replace function platform_auth.control_growth(p_months int default 12)
returns table (
  -- int, not bigint: node-pg hands an int8 back as a string, and a chart library
  -- given "7" draws nothing. No tenant count in this schema reaches 2^31.
  month date, new_companies int, new_seekers int, new_users int,
  activated int, lapsed int, searches int
) language sql stable security definer set search_path = public as $$
  with axis as (
    select generate_series(
      date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')::date
        - make_interval(months => greatest(least(p_months, 60), 1) - 1),
      date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')::date,
      interval '1 month')::date as month
  ),
  money as (
    -- An activation is a subscription invoice the office has been paid for. Search
    -- passes are money too, but they are not a customer arriving, and mixing them
    -- in here would make the growth curve a copy of the revenue curve.
    select date_trunc('month', i.paid_at at time zone 'Africa/Dar_es_Salaam')::date as month,
           count(*)::int as activated
    from invoices i
    where i.status = 'paid' and i.paid_at is not null group by 1
  )
  select a.month,
    (select count(*)::int from tenants t where t.deleted_at is null and t.type = 'transporter'
       and date_trunc('month', t.created_at at time zone 'Africa/Dar_es_Salaam')::date = a.month),
    (select count(*)::int from seekers s where s.deleted_at is null
       and date_trunc('month', s.created_at at time zone 'Africa/Dar_es_Salaam')::date = a.month),
    (select count(*)::int from users u where u.deleted_at is null and u.user_type <> 'platform'
       and date_trunc('month', u.created_at at time zone 'Africa/Dar_es_Salaam')::date = a.month),
    coalesce(m.activated, 0),
    -- A lapse is a licence that ran out that month with nothing behind it: the
    -- count of companies whose only expiry fell here and who are not active today.
    (select count(*)::int from tenants t where t.deleted_at is null and t.type <> 'platform'
       and t.licence_expires_at is not null
       and date_trunc('month', t.licence_expires_at at time zone 'Africa/Dar_es_Salaam')::date = a.month
       and t.status <> 'active'),
    (select count(*)::int from seeker_searches ss
       where date_trunc('month', ss.created_at at time zone 'Africa/Dar_es_Salaam')::date = a.month)
  from axis a left join money m on m.month = a.month
  order by a.month;
$$;

-- ============================================================
-- 5. REVENUE AND PROFIT, month by month
-- ============================================================
--
-- Two income streams with two different clocks: a subscription is paid when the
-- office confirms it (invoices.paid_at), a search pass when the office verifies the
-- reference (seeker_search_passes.verified_at). Both are attributed to the month the
-- money landed, and VAT is taken out before the profit line, because the platform
-- owes that part to TRA and it is not income.

drop function if exists platform_auth.control_revenue(int);
create or replace function platform_auth.control_revenue(p_months int default 12)
returns table (
  month date, subscription_income numeric, pass_income numeric,
  gross numeric, vat numeric, net numeric, costs numeric, profit numeric,
  paid_invoices int, paid_passes int
) language sql stable security definer set search_path = public as $$
  with axis as (
    select generate_series(
      date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')::date
        - make_interval(months => greatest(least(p_months, 60), 1) - 1),
      date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')::date,
      interval '1 month')::date as month
  ),
  sub as (
    select date_trunc('month', i.paid_at at time zone 'Africa/Dar_es_Salaam')::date as month,
           sum(i.amount_total) as gross, sum(i.vat_amount) as vat, count(*)::int as n
    from invoices i where i.status = 'paid' and i.paid_at is not null group by 1
  ),
  pass as (
    select date_trunc('month', sp.verified_at at time zone 'Africa/Dar_es_Salaam')::date as month,
           sum(sp.amount) as gross, count(*)::int as n
    from seeker_search_passes sp
    where sp.status in ('live','expired') and sp.verified_at is not null group by 1
  ),
  cost as (
    -- period is already the first of its month (the table's CHECK), so no time zone
    -- is involved: a cost belongs to the month it was recorded against.
    select date_trunc('month', period)::date as month, sum(amount) as costs
    from platform_costs group by 1
  )
  select a.month,
    coalesce(s.gross, 0), coalesce(p.gross, 0),
    coalesce(s.gross, 0) + coalesce(p.gross, 0),
    coalesce(s.vat, 0),
    coalesce(s.gross, 0) + coalesce(p.gross, 0) - coalesce(s.vat, 0),
    coalesce(c.costs, 0),
    coalesce(s.gross, 0) + coalesce(p.gross, 0) - coalesce(s.vat, 0) - coalesce(c.costs, 0),
    coalesce(s.n, 0), coalesce(p.n, 0)
  from axis a
  left join sub s on s.month = a.month
  left join pass p on p.month = a.month
  left join cost c on c.month = a.month
  order by a.month;
$$;

-- ============================================================
-- 6. THE FORECAST
-- ============================================================
--
-- Least squares over the months that are already closed — the running month is
-- a partial observation and including it drags every line down and makes the chart
-- lie. Projects p_horizon months past the last actual.
--
-- fit_r2 is corr()² and is null until there are three points to fit, because a
-- straight line through two points always fits perfectly and a "99% confidence"
-- badge on a two-month history is not information.

create or replace function platform_auth.control_forecast(
  p_months int default 12, p_horizon int default 6)
returns table (
  metric text, month date, actual numeric, projected numeric,
  is_projected boolean, slope numeric, fit_r2 numeric
) language sql stable security definer set search_path = public as $$
  with closed as (
    select date_trunc('month', now() at time zone 'Africa/Dar_es_Salaam')::date
             - interval '1 month' as last_month
  ),
  axis as (
    select generate_series(
      c.last_month - make_interval(months => greatest(least(p_months, 60), 3) - 1),
      c.last_month, interval '1 month')::date as month
    from closed c
  ),
  series as (
    -- One month longer than the axis, because both sub-functions count the running
    -- month in their window and this function refuses to fit on it. Asking for twelve
    -- months of history therefore means twelve CLOSED months, not eleven closed and
    -- one discarded — and a caller that reads `months` back in its own response
    -- would otherwise be shown a different window than it requested.
    select r.month, r.subscription_income, r.pass_income, r.net, r.costs, r.profit,
           g.new_companies::numeric as new_companies,
           g.new_seekers::numeric as new_seekers
    from platform_auth.control_revenue(greatest(least(p_months, 60), 3) + 1) r
    join platform_auth.control_growth(greatest(least(p_months, 60), 3) + 1) g using (month)
    where r.month in (select month from axis)
  ),
  long as (
    select m.metric, s.month, case m.metric
      when 'subscription_income' then s.subscription_income
      when 'pass_income'         then s.pass_income
      when 'net_income'          then s.net
      when 'costs'               then s.costs
      when 'profit'              then s.profit
      when 'new_companies'       then s.new_companies
      else s.new_seekers end as value
    from series s
    cross join (values ('subscription_income'),('pass_income'),('net_income'),
                       ('costs'),('profit'),('new_companies'),('new_seekers')) m(metric)
  ),
  numbered as (
    select metric, month, value,
           row_number() over (partition by metric order by month) as x
    from long
  ),
  fits as (
    select metric,
           regr_slope(value, x::float) as slope,
           regr_intercept(value, x::float) as intercept,
           count(*) as points,
           -- corr() returns double precision and round(x, n) only exists for numeric,
           -- so the fit is cast on the way out. The same reason the projection below
           -- casts: a regression in Postgres is float, money is not.
           case when count(*) >= 3
                then round(power(corr(value, x::float), 2)::numeric, 4) end as fit_r2,
           max(month) as last_month,
           (array_agg(value order by x desc))[1] as last_value
    from numbered group by metric
  ),
  projected as (
    select f.metric, gs.month::date as month,
           -- The line is anchored on the last actual rather than on its own
           -- intercept: a fit that missed the final point still continues from
           -- where the business actually stands, and the step count is obvious.
           -- The month divisor is a float, so the whole expression is cast back to
           -- numeric before it is rounded and compared with 0.
           greatest(round((f.last_value
             + f.slope * extract(epoch from (gs.month - f.last_month))
               / (86400 * 30.4375))::numeric, 2), 0) as projected,
           f.slope, f.fit_r2
    from fits f
    -- Lateral because the horizon starts from this metric's own last month, and
    -- the column must be named: generate_series emits "generate_series", not
    -- "month", and a cross join gives its function item no column aliases.
    cross join lateral generate_series(
      f.last_month + interval '1 month',
      f.last_month + make_interval(months => greatest(least(p_horizon, 24), 1)),
      interval '1 month') as gs(month)
    where f.points >= 3 and f.slope is not null
  )
  select n.metric, n.month, n.value, null::numeric, false,
         round(f.slope::numeric, 2), f.fit_r2
  from numbered n join fits f using (metric)
  union all
  select p.metric, p.month, null, p.projected, true,
         round(p.slope::numeric, 2), p.fit_r2
  from projected p
  order by 1, 2;
$$;

-- ============================================================
-- 7. THE AUDIT READER
-- ============================================================
--
-- The trail has been append-only since 001 and has never had a SELECT path. This is
-- the one door: filters on every axis the forensic screen needs, a hard row cap, and
-- payloads through the redactor. The actor's own identity is returned in full — a
-- control panel that cannot say who acted is not a forensic tool — but nothing else
-- about that person (their phone, their NIDA) is reachable from here.

-- The three existing indexes cover ts, tenant and entity. "Everything this person
-- did" — the first question a forensic screen is asked — had no index at all, and
-- on a partitioned log that is a scan of every month to return fifty rows.
create index if not exists idx_audit_actor_ts on audit_logs (actor_user_id, ts desc);
create index if not exists idx_audit_action_ts on audit_logs (action, ts desc);

create or replace function platform_auth.list_audit_for_control(
  p_tenant_id uuid default null,
  p_actor_user_id uuid default null,
  p_entity text default null,
  p_action text default null,
  p_q text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 100
) returns table (
  id uuid, ts timestamptz, tenant_id uuid, tenant_name text,
  actor_user_id uuid, actor_name text, actor_email text, actor_role text,
  ip text, entity text, entity_id uuid, action text,
  before jsonb, after jsonb
) language sql stable security definer set search_path = public as $$
  select a.id, a.ts, a.tenant_id, t.name,
         a.actor_user_id, u.full_name, lower(u.email), a.actor_role,
         a.ip, a.entity, a.entity_id, a.action,
         platform_auth.redact_audit_payload(a.before),
         platform_auth.redact_audit_payload(a.after)
  from audit_logs a
  left join tenants t on t.id = a.tenant_id
  left join users u on u.id = a.actor_user_id
  where (p_tenant_id is null or a.tenant_id = p_tenant_id)
    and (p_actor_user_id is null or a.actor_user_id = p_actor_user_id)
    and (p_entity is null or a.entity = p_entity)
    and (p_action is null or a.action ilike p_action || '%')
    and (p_q is null or a.action ilike '%' || p_q || '%'
                    or a.entity ilike '%' || p_q || '%'
                    or coalesce(t.name,'') ilike '%' || p_q || '%'
                    or coalesce(u.full_name,'') ilike '%' || p_q || '%')
    and (p_from is null or a.ts >= p_from)
    and (p_to is null or a.ts <= p_to)
  order by a.ts desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- Distinct values for the filter pick-lists, so the UI never offers a free-text
-- guess at an action name.
drop function if exists platform_auth.list_audit_actions(timestamptz);
create or replace function platform_auth.list_audit_actions(p_from timestamptz default null)
returns table (action text, events int, last_seen timestamptz)
language sql stable security definer set search_path = public as $$
  select a.action, count(*)::int, max(a.ts)
  from audit_logs a
  where (p_from is null or a.ts >= p_from)
  group by a.action order by count(*) desc
  limit 300;
$$;

-- ============================================================
-- 8. PERMISSIONS
-- ============================================================

insert into permissions (key, description) values
  ('control.analytics.view', 'Control - Read platform analytics and forecasts'),
  ('control.costs.manage', 'Control - Record the platform''s own monthly costs')
on conflict do nothing;

-- Duties, not a blanket. The analyst reads the numbers and nothing else; billing
-- owns the money and the cost ledger; compliance owns the audit trail; customer
-- service sees the counts because they answer "how many of my users…" but not the
-- money or the trail.
insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join permissions p on p.key in ('control.analytics.view','control.costs.manage','control.audit.view')
where r.key = 'super_admin' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join permissions p on p.key in ('control.analytics.view','control.costs.manage')
where r.key = 'billing_admin' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join permissions p on p.key = 'control.analytics.view'
where r.key = 'platform_analyst' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join permissions p on p.key in ('control.analytics.view','control.audit.view')
where r.key = 'compliance_officer' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
join permissions p on p.key = 'control.analytics.view'
where r.key = 'customer_service_agent' and r.tenant_id is null
on conflict do nothing;

-- ============================================================
-- 9. GRANTS
-- ============================================================

grant execute on function
  platform_auth.control_overview(),
  platform_auth.control_growth(int),
  platform_auth.control_revenue(int),
  platform_auth.control_forecast(int, int),
  platform_auth.list_audit_for_control(uuid, uuid, text, text, text, timestamptz, timestamptz, int),
  platform_auth.list_audit_actions(timestamptz),
  platform_auth.redact_audit_payload(jsonb, int)
to app_runtime;

-- Postgres hands EXECUTE on a new function to PUBLIC; the schema USAGE revoke in 001
-- is what normally keeps them unreachable, and 051's sweep predates every function in
-- this file. Same revoke list as 060.
revoke all on function
  platform_auth.control_overview(),
  platform_auth.control_growth(int),
  platform_auth.control_revenue(int),
  platform_auth.control_forecast(int, int),
  platform_auth.list_audit_for_control(uuid, uuid, text, text, text, timestamptz, timestamptz, int),
  platform_auth.list_audit_actions(timestamptz),
  platform_auth.redact_audit_payload(jsonb, int)
from public, anon, authenticated, service_role;

commit;
