-- 086 — the exit register, so churn stops being an unknown (spec: admin panel, task #155).
--
-- The advisory's own list of what this system cannot tell you said it plainly:
-- "subscriptions.status 'cancelled' has no writer anywhere in the API. A lapse is recorded
-- by the licence gate as expired or suspended, which is a different event — the register
-- can show lapsed companies, not companies that chose to leave."
--
-- That sentence was true, and the half of it that mattered is now fixed. Recon for this
-- file found something worse than a missing writer: nothing in the schema ever writes
-- 'expired' or 'grace' into subscriptions.status either, and the licence gate (008) does
-- not read that column at all — it compares tenants.licence_expires_at with now(). So a
-- company that stopped paying sits at status 'active' forever while its term date passes.
-- The 'cancelled', 'grace' and 'expired' buckets that 066 and 068 count for the overview
-- have therefore always read zero, and a churn figure drawn from them would have been a
-- copy of that zero.
--
-- So this file does two things, and keeps them visibly separate:
--
--   1. THE EXIT. `subscription_cancellations` is an append-only register of the moments a
--      person on the desk recorded that a customer is gone — with a reason code the desk
--      can count, the note that explains it later, and a full before-image of what the
--      company was paying, so a price-list change next year cannot rewrite this year's
--      loss. `platform_auth.cancel_subscription` is the only door: it flips the
--      subscription to 'cancelled', switches auto_renew off, and writes the register row
--      and the audit row in the same breath. It does not touch tenants.status,
--      tenants.licence_expires_at or sessions — an accepted exit ends the sale, it does
--      not confiscate the term already paid for. Shutting a company's access is a
--      different job with its own register (tenant_actions, 078) and its own duty, and
--      keeping the two apart is what lets the office say "we ended their subscription" and
--      "we locked their account" as two dated facts instead of one muddy act.
--      No notice is sent from here. The tenants desk carries the delivery receipt because
--      an act against a company has to be told to it; an exit recorded after the
--      conversation in the office is a bookkeeping act, and duplicating the mail machinery
--      would only make two registers claim to have told the same person.
--
--   2. THE READING. `platform_auth.churn_report(window)` answers the question the advisory
--      could not: who left, how much recurring money went with them, and what the rest of
--      the base looks like today. Exits come from the register. Lapse comes from the clock
--      — the same test 066's growth curve already uses (`licence_expires_at` in the past,
--      nothing behind it) — and it is reported as `out_of_term`, never as a status, because
--      the status column cannot support that claim. The two are labelled as different
--      events on the desk rather than added together into one "churn" number, which is how
--      a platform ends up quoting a churn rate nobody can reproduce.
--
-- Posture is 078's, deliberately: the register has RLS with no policies and no grant to
-- app_runtime, so the only way a row exists is that the door was walked through; both
-- functions are SECURITY DEFINER because they cross tenants; the write needs the new duty
-- control.subscriptions.manage and the read keeps control.subscriptions.view, so the seats
-- that watch the register are not the seats that can close it.

begin;

-- ============================================================
-- 1. the duty that records an exit
-- ============================================================
--
-- 'control.plans.manage' and 'control.payments.manage' (005) already belong to
-- super_admin and billing_admin: the two seats that sell a subscription are the two that
-- can end one. compliance_officer is deliberately not here — its hand on a company is
-- tenant_actions, and a cancellation is not a sanction. The analyst and support seats keep
-- the read 068 gave them, so they can see the exit without being able to enter one.

insert into permissions (key, description) values
  ('control.subscriptions.manage', 'Control - Record a customer exit on the churn register')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.subscriptions.manage'
  from roles r
 where r.tenant_id is null and r.key in ('super_admin', 'billing_admin')
on conflict do nothing;

-- ============================================================
-- 2. the register
-- ============================================================
--
-- A before-image, not a pointer. company_name, offering_name and monthly_equivalent are
-- copied at the moment of the exit because a rename, a re-priced bundle or a deleted plan
-- would otherwise rewrite history: a desk that lost 40k a month to three companies must be
-- able to say so in two years, when the price list has moved.
--
-- prior_status is checked against the statuses that can actually be exited. 'cancelled' is
-- absent because the door refuses a second exit before it ever reaches here.

create table if not exists subscription_cancellations (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  tenant_id uuid not null references tenants(id),
  company_name text not null,
  company_type text not null,
  -- What was sold, as the office sold it: the bundle when there is one, the rung when the
  -- company was sold off the ladder. Same vocabulary as 068's register, so the two screens
  -- can name the same customer's offering with the same string.
  offering text,
  offering_name text,
  offering_kind text check (offering_kind is null
                            or offering_kind in ('bundle', 'plan')),
  billing_cycle text,
  seats_licensed int,
  auto_renew_at_exit boolean,
  -- The rate this exit removes, and the currency it was quoted in. Never a float.
  monthly_equivalent numeric(14,4),
  currency text not null default 'TZS',
  -- What the office had actually been paid by the moment it lost them — the difference
  -- between a customer who left after three years and one who left after a trial.
  collected numeric(14,2),
  paid_invoices int,
  prior_status text not null
    check (prior_status in ('pending','trial','active','grace','expired','suspended')),
  period_end timestamptz,
  licence_expires_at timestamptz,
  signed_up_at timestamptz,
  -- Why, as a code the desk can count and as the sentence that explains the count.
  reason_code text not null
    check (reason_code in ('company_decision','price','went_dormant','service_failure',
                           'terms_violation','payment_default','other')),
  note text not null check (char_length(trim(note)) between 8 and 600),
  actor_user_id uuid references users(id),
  actor_role text,
  actor_ip text,
  created_at timestamptz not null default now()
);
create index subscription_cancellations_created on subscription_cancellations (created_at desc);
create index subscription_cancellations_tenant on subscription_cancellations (tenant_id, created_at desc);
create index subscription_cancellations_reason on subscription_cancellations (reason_code, created_at desc);

alter table subscription_cancellations enable row level security;
-- No policy and no grant: the register is reachable only through the two functions below,
-- so a handler cannot write a good churn month into it.
revoke all on subscription_cancellations
  from public, anon, authenticated, app_runtime;

-- ============================================================
-- 3. the door
-- ============================================================
--
-- One statement, one lock, and the image read under that lock, so two clerks at the desk
-- cannot both record the same exit and produce two different figures for it.

create or replace function platform_auth.cancel_subscription(
  p_subscription_id uuid,
  p_reason_code text,
  p_note text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_image jsonb;
  v_reason text;
  v_note text;
  v_cancel_id uuid;
begin  v_reason := coalesce(p_reason_code, 'other');
  if v_reason not in ('company_decision','price','went_dormant','service_failure',
                      'terms_violation','payment_default','other') then
    return jsonb_build_object('status','invalid','message','Unknown reason');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('status','invalid',
      'message','The note must be 8-600 characters: it is the sentence that explains this exit later.');
  end if;

  -- The whole before-image in one read, priced exactly the way 068's register prices it —
  -- bundle first, because subscriptions.plan_id is NOT NULL and always carries a rung even
  -- when the office sold a package. The lock is taken on its own statement first: a
  -- SELECT list of expressions cannot be combined with FOR UPDATE in one statement, and
  -- two clerks must not both price the same exit.
  perform 1 from subscriptions s
    where s.id = p_subscription_id and s.deleted_at is null
    for update;
  if not found then
    return jsonb_build_object('status','not_found');
  end if;

  select jsonb_build_object(
    'subscription_id', s.id,
    'subscription_status', s.status,
    'tenant_id', s.tenant_id,
    'billing_cycle', s.billing_cycle,
    'seats_licensed', s.seats_licensed,
    'auto_renew', s.auto_renew,
    'period_end', s.current_period_end,
    'company_name', t.name,
    'company_type', t.type,
    'tenant_status', t.status,
    'tenant_closed', t.deleted_at is not null,
    'signed_up_at', t.created_at,
    'licence_expires_at', t.licence_expires_at,
    'offering', coalesce(g.key, p.key, 'unknown'),
    'offering_name', coalesce(g.name, p.name, 'No plan recorded'),
    'offering_kind', case when g.id is not null then 'bundle'
                          when p.id is not null then 'plan' end,
    'monthly_equivalent', case s.billing_cycle
      when 'quarterly' then round(coalesce(g.price_quarterly, p.price_quarterly, 0) / 3, 2)
      when 'annual'    then round(coalesce(g.price_annual,    p.price_annual,    0) / 12, 2)
      else coalesce(g.price_monthly, p.price_monthly, 0) end,
    'collected', coalesce((select sum(i.amount_total) from invoices i
                            where i.subscription_id = s.id and i.status = 'paid'
                              and i.deleted_at is null), 0),
    'paid_invoices', (select count(*)::int from invoices i
                       where i.subscription_id = s.id and i.status = 'paid'
                         and i.deleted_at is null)
  ) into v_image
    from subscriptions s
    join tenants t on t.id = s.tenant_id
    left join plans p on p.id = s.plan_id
    left join service_groups g on g.id = s.service_group_id
   where s.id = p_subscription_id
     and s.deleted_at is null;

  if v_image is null then
    return jsonb_build_object('status','not_found');
  end if;
  if v_image->>'subscription_status' = 'cancelled' then
    return jsonb_build_object('status','conflict',
      'message','This subscription is already recorded as an exit.');
  end if;
  if coalesce((v_image->>'tenant_closed')::boolean, false) then
    return jsonb_build_object('status','conflict',
      'message','The company is already closed; its exit is on the tenants register.');
  end if;
  if v_image->>'company_type' in ('platform','seeker') then
    return jsonb_build_object('status','invalid',
      'message','Only a company subscription can be exited here.');
  end if;

  -- The sale ends; the term the company paid for does not get taken back, and no session
  -- is revoked. Both are the tenants desk's job (078), on its own duty and its own clock.
  update subscriptions
     set status = 'cancelled', auto_renew = false, updated_by = p_actor_user_id
   where id = p_subscription_id;

  insert into subscription_cancellations (
      id, subscription_id, tenant_id, company_name, company_type,
      offering, offering_name, offering_kind, billing_cycle, seats_licensed,
      auto_renew_at_exit, monthly_equivalent, currency, collected, paid_invoices,
      prior_status, period_end, licence_expires_at, signed_up_at,
      reason_code, note, actor_user_id, actor_role, actor_ip)
  values (gen_random_uuid(), p_subscription_id,
      (v_image->>'tenant_id')::uuid, v_image->>'company_name', v_image->>'company_type',
      v_image->>'offering', v_image->>'offering_name', v_image->>'offering_kind',
      v_image->>'billing_cycle', (v_image->>'seats_licensed')::int,
      (v_image->>'auto_renew')::boolean, (v_image->>'monthly_equivalent')::numeric, 'TZS',
      (v_image->>'collected')::numeric, (v_image->>'paid_invoices')::int,
      v_image->>'subscription_status', (v_image->>'period_end')::timestamptz,
      (v_image->>'licence_expires_at')::timestamptz, (v_image->>'signed_up_at')::timestamptz,
      v_reason, v_note, p_actor_user_id, p_actor_role, p_actor_ip)
  returning id into v_cancel_id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), (v_image->>'tenant_id')::uuid, p_actor_user_id, p_actor_role,
      p_actor_ip, 'subscriptions', p_subscription_id, 'subscription.cancelled',
      jsonb_build_object('status', v_image->>'subscription_status',
        'auto_renew', (v_image->>'auto_renew')::boolean,
        'monthly_equivalent', (v_image->>'monthly_equivalent')::numeric),
      jsonb_build_object('status', 'cancelled', 'reason_code', v_reason, 'note', v_note,
        'offering', v_image->>'offering', 'seats_licensed', (v_image->>'seats_licensed')::int,
        'monthly_equivalent', (v_image->>'monthly_equivalent')::numeric,
        'collected', (v_image->>'collected')::numeric,
        'licence_expires_at', v_image->>'licence_expires_at',
        'cancel_id', v_cancel_id));

  return jsonb_build_object('status','ok',
    'cancel_id', v_cancel_id,
    'subscription_id', p_subscription_id,
    'tenant_id', (v_image->>'tenant_id')::uuid,
    'company_name', v_image->>'company_name',
    'prior_status', v_image->>'subscription_status',
    'offering', v_image->>'offering', 'offering_name', v_image->>'offering_name',
    'billing_cycle', v_image->>'billing_cycle',
    'seats_licensed', (v_image->>'seats_licensed')::int,
    'monthly_equivalent', (v_image->>'monthly_equivalent')::numeric,
    'collected', (v_image->>'collected')::numeric,
    'paid_invoices', (v_image->>'paid_invoices')::int,
    'licence_expires_at', v_image->>'licence_expires_at',
    'reason_code', v_reason, 'note', v_note);
end $$;

-- ============================================================
-- 4. the reading
-- ============================================================
--
-- Three different sentences, never added together:
--
--   exits        — a person recorded this customer leaving (the register, this window).
--   out_of_term  — the licence clock has passed them and nothing was recorded (today's
--                  eq, judged on the date the way 066's growth curve judges a lapse).
--   blocked / closed — the company was shut by the desk (078), not a customer decision.
--
-- The denominator for the rate is the number of subscriptions that were already open when
-- the window started, so a month of new sales cannot dilute it. Months are truncated in
-- Dar es Salaam time, as every other bucket in this panel does — on a UTC server a bare
-- date_trunc moves the axis one month to the left.
--
-- avg_tenure_days is round(), not a percentile: two exits do not have a median worth
-- quoting, and a desk reading "average 210 days" knows what it is looking at.

create or replace function platform_auth.churn_report(p_window_days int default 90)
returns jsonb language sql stable security definer set search_path = public as $$
with bounds as (
  select greatest(least(coalesce(p_window_days, 90), 730), 7) as days
), clock as (
  select b.days, now() - make_interval(days => b.days) as since from bounds b
), eq as (
  select s.id, s.status, s.seats_licensed,
         (s.status in ('active','trial','grace'))              as live_status,
         greatest(t.licence_expires_at, s.current_period_end)  as term_end,
         t.status as tenant_status,
         t.deleted_at is not null                              as tenant_closed,
         case s.billing_cycle
           when 'quarterly' then round(coalesce(g.price_quarterly, p.price_quarterly, 0) / 3, 2)
           when 'annual'    then round(coalesce(g.price_annual,    p.price_annual,    0) / 12, 2)
           else coalesce(g.price_monthly, p.price_monthly, 0)
         end as monthly_equivalent
    from subscriptions s
    join tenants t on t.id = s.tenant_id
    left join plans p on p.id = s.plan_id
    left join service_groups g on g.id = s.service_group_id
   where s.deleted_at is null
     -- Same population as 068's register, so the two screens cannot disagree about who a
     -- customer is. Seekers hold no subscription row anyway.
     and t.type <> 'platform'
), exits as (
  select c.*, s.status as current_status,
         extract(epoch from (c.created_at - coalesce(c.signed_up_at, c.created_at))) / 86400
           as tenure_days
    from subscription_cancellations c
    join subscriptions s on s.id = c.subscription_id
    cross join clock k
   where c.created_at >= k.since
), axis as (
  select generate_series(
           date_trunc('month', k.since at time zone 'Africa/Dar_es_Salaam')::date,
           date_trunc('month', now()  at time zone 'Africa/Dar_es_Salaam')::date,
           interval '1 month')::date as month
  from clock k
), base as (
  select count(*)::int as sold_before_window
    from subscriptions s
    join tenants t on t.id = s.tenant_id
   where s.deleted_at is null and t.type <> 'platform'
     and s.created_at < (select since from clock)
)
select jsonb_build_object(
  'window_days', k.days,
  'since', k.since,
  'sold_before_window', coalesce(bs.sold_before_window, 0),
  'exits', (select jsonb_build_object(
      'companies', count(*)::int,
      'mrr_lost', coalesce(sum(monthly_equivalent), 0),
      'seats_lost', coalesce(sum(seats_licensed), 0)::int,
      'paid_before_exit', coalesce(sum(collected), 0),
      'avg_tenure_days', round(avg(tenure_days), 0)::int,
      'still_cancelled', count(*) filter (where current_status = 'cancelled')::int,
      'came_back', count(*) filter
        (where current_status in ('pending','trial','active','grace'))::int,
      'currency', 'TZS')
    from exits),
  'exit_rate_pct', round(100.0 * (select count(*) from exits)
    / nullif(coalesce(bs.sold_before_window, 0), 0), 1),
  'by_reason', coalesce((
    select jsonb_agg(json_build_object(
             'reason_code', r.reason_code,
             'companies', r.companies,
             'mrr_lost', r.mrr_lost)
           order by r.mrr_lost desc, r.reason_code)
      from (select reason_code, count(*)::int as companies,
                   coalesce(sum(monthly_equivalent), 0) as mrr_lost
              from exits group by reason_code) r), '[]'::jsonb),
  'by_month', coalesce((
    select jsonb_agg(json_build_object(
             'month', a.month,
             'cancellations', coalesce(x.canc, 0)::int,
             'mrr_lost', coalesce(x.lost, 0),
             'out_of_term', coalesce(o.lapsed, 0)::int)
           order by a.month)
      from axis a
      left join (select date_trunc('month', created_at at time zone 'Africa/Dar_es_Salaam')::date
                       as month, count(*)::int as canc,
                       coalesce(sum(monthly_equivalent), 0) as lost
                   from exits group by 1) x on x.month = a.month
      left join (select date_trunc('month', term_end at time zone 'Africa/Dar_es_Salaam')::date
                       as month, count(*)::int as lapsed
                   from eq
                  where live_status and term_end is not null and term_end <= now()
                    and not tenant_closed
                  group by 1) o on o.month = a.month), '[]'::jsonb),
  'today', (select jsonb_build_object(
      'customers', count(*)::int,
      'live', count(*) filter (where live_status and term_end > now()
                               and tenant_status <> 'suspended' and not tenant_closed)::int,
      'out_of_term', count(*) filter (where live_status
                                      and (term_end is null or term_end <= now())
                                      and not tenant_closed)::int,
      'cancelled', count(*) filter (where status = 'cancelled')::int,
      'blocked', count(*) filter (where tenant_status = 'suspended')::int,
      'closed', count(*) filter (where tenant_closed)::int,
      'mrr_live', coalesce(sum(monthly_equivalent) filter (where live_status and term_end > now()
                               and tenant_status <> 'suspended' and not tenant_closed), 0),
      'mrr_at_risk', coalesce(sum(monthly_equivalent) filter (where live_status
                               and (term_end is null or term_end <= now())
                               and not tenant_closed), 0),
      'seats_live', coalesce(sum(seats_licensed) filter (where live_status and term_end > now()
                               and not tenant_closed), 0)::int,
      'currency', 'TZS')
    from eq),
  'recent', coalesce((
    select jsonb_agg(json_build_object(
             'id', r.id, 'company_name', r.company_name, 'company_type', r.company_type,
             'offering', r.offering, 'offering_name', r.offering_name,
             'offering_kind', r.offering_kind, 'billing_cycle', r.billing_cycle,
             'seats_licensed', r.seats_licensed, 'auto_renew_at_exit', r.auto_renew_at_exit,
             'monthly_equivalent', r.monthly_equivalent, 'currency', r.currency,
             'collected', r.collected, 'paid_invoices', r.paid_invoices,
             'prior_status', r.prior_status, 'period_end', r.period_end,
             'licence_expires_at', r.licence_expires_at, 'signed_up_at', r.signed_up_at,
             'reason_code', r.reason_code, 'note', r.note, 'actor_role', r.actor_role,
             'cancelled_at', r.created_at, 'came_back', r.current_status <> 'cancelled')
           order by r.created_at desc)
      from (select * from exits order by created_at desc limit 40) r), '[]'::jsonb)
  )
from clock k cross join base bs;
$$;

-- The desk's own history for one company: every exit ever recorded against it, newest
-- first. A renewal conversation that starts "you left us in March" needs the reason the
-- office wrote, not a guess from a status.
create or replace function platform_auth.control_subscription_exits(p_tenant_id uuid, p_limit int)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(json_build_object(
           'id', x.id, 'subscription_id', x.subscription_id,
           'offering', x.offering, 'offering_name', x.offering_name,
           'billing_cycle', x.billing_cycle, 'seats_licensed', x.seats_licensed,
           'monthly_equivalent', x.monthly_equivalent, 'currency', x.currency,
           'collected', x.collected, 'prior_status', x.prior_status,
           'reason_code', x.reason_code, 'note', x.note,
           'actor_role', x.actor_role, 'cancelled_at', x.created_at)
         order by x.created_at desc), '[]'::jsonb)
  from (select * from subscription_cancellations
         where tenant_id = p_tenant_id
         order by created_at desc limit least(coalesce(p_limit, 20), 50)) x;
$$;

-- ============================================================
-- 5. grants
-- ============================================================

grant execute on function
  platform_auth.cancel_subscription(uuid, text, text, uuid, text, text),
  platform_auth.churn_report(int),
  platform_auth.control_subscription_exits(uuid, int)
to app_runtime;

-- The sweep every new definer needs (051, 060, 066, 068, 070, 079, 082, 085): a fresh
-- function belongs to PUBLIC until told otherwise, and this one closes a customer.
revoke all on function
  platform_auth.cancel_subscription(uuid, text, text, uuid, text, text),
  platform_auth.churn_report(int),
  platform_auth.control_subscription_exits(uuid, int)
from public, anon, authenticated, service_role;

commit;
