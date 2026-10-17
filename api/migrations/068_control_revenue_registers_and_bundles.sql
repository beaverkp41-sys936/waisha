-- 068 — the money half of the admin panel (spec §8, task #104).
--
-- 066 made the platform's numbers computable and 067 made the seats readable, but
-- nothing here answered the two questions an office actually asks out loud: *which
-- companies are on what, and who has paid what when*. The overview answers them as
-- totals; a person on the desk has to be able to name the company.
--
-- Both registers are SECURITY DEFINER for the same reason 066's aggregates are: they
-- cross tenants, and a bare query under RLS returns nothing at all. They are also
-- capped and filtered inside the function rather than in the route, so a control
-- request cannot ask for the whole invoice table by forgetting a parameter.
--
-- Money keeps 066's two clocks, unchanged: a subscription is income when the office
-- has been paid (invoices.paid_at), a search pass when the office has verified the
-- reference (seeker_search_passes.verified_at). A ledger that disagreed with the P&L
-- would be worse than no ledger, so the ledger's own total column uses the same test
-- — money_at is not null — as the chart.

begin;

-- ============================================================
-- 1. A read key for the registers
-- ============================================================
--
-- 'control.payments.manage' (005) has always meant "move money's state", and the
-- office's own invoices ledger is read by people who must not do that: the analyst
-- measuring which bundle sells, the desk chasing a renewal, compliance checking a
-- refund was justified. Reading is now its own key. 'control.subscriptions.view'
-- carries both registers because they are the same question asked of the same rows.

insert into permissions (key, description) values
  ('control.subscriptions.view', 'Control - Read the customer register and the money ledger')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.subscriptions.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','billing_admin','platform_analyst','compliance_officer',
                 'customer_service_agent')
on conflict do nothing;

-- ============================================================
-- 2. THE CUSTOMER REGISTER — who is on what
-- ============================================================
--
-- One row per live subscription (the unique index in 005 makes it one per company),
-- with the money that company has already paid beside it. `offering` is the single
-- column the whole panel needed: what the office sold is the bundle when there is
-- one and the plan ladder when there is not, and a renewal desk that shows the two
-- separately makes the clerk decide which one is real.
--
-- matched / matched_mrr are window counts over the *filtered* set, computed before
-- the LIMIT, so the screen's "N companies · MRR X" line is the same SQL that drew
-- the rows and cannot drift from them.

drop function if exists platform_auth.control_subscription_register(text, text, text, text, int, int);
create or replace function platform_auth.control_subscription_register(
  p_status text default null,
  p_cycle text default null,
  p_offering text default null,
  p_search text default null,
  p_due_within int default null,
  p_limit int default 200
) returns table (
  tenant_id uuid, company_name text, company_type text, company_status text,
  subscription_id uuid, subscription_status text, billing_cycle text,
  seats_licensed int, auto_renew boolean,
  offering text, offering_name text, offering_kind text, services text[],
  monthly_equivalent numeric, collected numeric, invoices_paid int,
  period_start timestamptz, period_end timestamptz, days_to_renewal int,
  licence_expires_at timestamptz, grace_ends_at timestamptz, trial_ends_at timestamptz,
  signed_up_at timestamptz, matched int, matched_mrr numeric
) language sql stable security definer set search_path = public as $$
  select
    t.id, t.name, t.type, t.status,
    s.id, s.status, s.billing_cycle, s.seats_licensed, s.auto_renew,
    coalesce(g.key, p.key, 'unknown')                                  as offering,
    coalesce(g.name, p.name, 'No plan recorded')                       as offering_name,
    case when g.id is not null then 'bundle'
         when p.id is not null then 'plan' end                         as offering_kind,
    g.services,
    -- Monthly-equivalent so a quarterly and an annual customer sit on one axis.
    -- The bundle wins when the office sold one: subscriptions.plan_id is NOT NULL
    -- and always carries a rung, so a coalesce that tried the plan first priced
    -- every bundle customer off the ladder and quietly ignored the price the
    -- customer was actually invoiced.
    case s.billing_cycle
      when 'quarterly' then round(coalesce(g.price_quarterly, p.price_quarterly, 0) / 3, 2)
      when 'annual'    then round(coalesce(g.price_annual,    p.price_annual,    0) / 12, 2)
      else coalesce(g.price_monthly, p.price_monthly, 0)
    end,
    coalesce((select sum(i.amount_total) from invoices i
               where i.subscription_id = s.id and i.status = 'paid'
                 and i.deleted_at is null), 0),
    (select count(*)::int from invoices i
      where i.subscription_id = s.id and i.status = 'paid' and i.deleted_at is null),
    s.current_period_start, s.current_period_end,
    case when s.current_period_end is null then null
         else ceiling(extract(epoch from (s.current_period_end - now())) / 86400)::int end,
    t.licence_expires_at, s.grace_ends_at, s.trial_ends_at, t.created_at,
    count(*) over ()::int,
    coalesce(sum(case s.billing_cycle
      when 'quarterly' then round(coalesce(g.price_quarterly, p.price_quarterly, 0) / 3, 2)
      when 'annual'    then round(coalesce(g.price_annual,    p.price_annual,    0) / 12, 2)
      else coalesce(g.price_monthly, p.price_monthly, 0) end) over (), 0)
  from subscriptions s
  join tenants t on t.id = s.tenant_id and t.deleted_at is null
  left join plans p on p.id = s.plan_id
  left join service_groups g on g.id = s.service_group_id
  where s.deleted_at is null
    and t.type <> 'platform'
    and (p_status is null or s.status = p_status)
    and (p_cycle is null or s.billing_cycle = p_cycle)
    and (p_offering is null
         or (p_offering = 'bundles' and s.service_group_id is not null)
         or (p_offering = 'ladder'  and s.service_group_id is null)
         or coalesce(g.key, p.key) = p_offering)
    and (p_search is null or t.name ilike '%' || p_search || '%')
    and (p_due_within is null
         or (s.current_period_end is not null
             and s.current_period_end <= now() + make_interval(days => p_due_within)))
  order by s.current_period_end asc nulls last, t.name
  limit greatest(least(coalesce(p_limit, 200), 400), 1);
$$;

-- ============================================================
-- 3. THE MONEY LEDGER — what was paid, and when it became money
-- ============================================================
--
-- The two streams keep their own rows and their own vocabulary rather than being
-- forced into one status column, because 'issued' and 'awaiting_verification' are
-- different sentences about different people. What they share is the clock: money_at
-- is when the record turned into income under 066's rule, and it is null for every
-- row that is not money yet — an invoice still issued, a reference still queued.
--
-- No payer contact details: the ledger answers "who paid", and a name and a company
-- answer that. Phone numbers and emails belong to the tenant's own record, not to a
-- table the whole desk scrolls.

drop function if exists platform_auth.control_payment_ledger(text, text, text, date, date, int);
create or replace function platform_auth.control_payment_ledger(
  p_source text default null,
  p_status text default null,
  p_search text default null,
  p_from date default null,
  p_to date default null,
  p_limit int default 200
) returns table (
  source text, payment_id uuid, reference text,
  payer_name text, payer_kind text, detail text,
  channel text, amount numeric, vat numeric, currency text, status text,
  recorded_at timestamptz, money_at timestamptz,
  period_start date, period_end date, note text,
  matched int, matched_income numeric
) language sql stable security definer set search_path = public as $$
  with rows as (
    select
      'subscription'::text as source,
      i.id,
      i.number as reference,
      t.name as payer_name,
      t.type as payer_kind,
      coalesce(g.name, p.name, 'Subscription') as detail,
      (select pp.provider from payments pp
        where pp.invoice_id = i.id and pp.status = 'approved'
        order by pp.completed_at desc nulls last limit 1) as channel,
      i.amount_total as amount,
      i.vat_amount as vat,
      i.currency,
      i.status,
      i.created_at as recorded_at,
      -- 066's clock, word for word: a paid invoice is income at paid_at, and nothing
      -- else is. Reading paid_at alone would let a voided or refunded invoice that
      -- kept its paid_at count as money here while 066's P&L refused it.
      case when i.status = 'paid' then i.paid_at end as money_at,
      i.period_start, i.period_end,
      null::text as note
    from invoices i
    join tenants t on t.id = i.tenant_id and t.deleted_at is null
    left join subscriptions s on s.id = i.subscription_id
    left join plans p on p.id = s.plan_id
    left join service_groups g on g.id = s.service_group_id
    where i.deleted_at is null

    union all

    select
      'search_pass'::text,
      sp.id,
      sp.payment_reference,
      coalesce(trim(sn.first_name || ' ' || sn.last_name), 'a seeker'),
      'seeker',
      sp.kind || ' pass · ' || sp.searches_allowed::text || ' searches',
      sp.payment_method,
      sp.amount,
      0::numeric,
      sp.currency,
      sp.status,
      sp.created_at,
      case when sp.status in ('live','expired') then sp.verified_at end,
      sp.starts_at::date, sp.expires_at::date,
      sp.verification_note
    from seeker_search_passes sp
    -- seekers.id is its own uuid; the pass carries the *user* id. Joining on the wrong
    -- one of the two silently returned no seeker rows at all, which is how a whole
    -- money stream disappears without an error. seekers_user_uq keeps this 1:1.
    join seekers sn on sn.user_id = sp.user_id and sn.deleted_at is null
    where sp.deleted_at is null
  )
  select r.source, r.id, r.reference, r.payer_name, r.payer_kind, r.detail,
         r.channel, r.amount, r.vat, r.currency, r.status,
         r.recorded_at, r.money_at, r.period_start, r.period_end, r.note,
         count(*) over ()::int,
         coalesce(sum(r.amount) filter (where r.money_at is not null) over (), 0)
  from rows r
  where (p_source is null or r.source = p_source)
    and (p_status is null or r.status = p_status)
    and (p_search is null or r.payer_name ilike '%' || p_search || '%'
                       or coalesce(r.reference, '') ilike '%' || p_search || '%')
    -- The window is judged on the platform's own wall clock, not the server's:
    -- "October's money" means October in Dar es Salaam, and on a UTC box a payment
    -- at 01:30 local belongs to the previous day.
    and (p_from is null or (r.recorded_at at time zone 'Africa/Dar_es_Salaam')::date >= p_from)
    and (p_to is null or (r.recorded_at at time zone 'Africa/Dar_es_Salaam')::date <= p_to)
  order by r.recorded_at desc
  limit greatest(least(coalesce(p_limit, 200), 400), 1);
$$;

-- ============================================================
-- 4. WHAT IS SELLING — income by offering
-- ============================================================
--
-- The P&L says how much came in; this says from which bundle or rung, over a window
-- the desk chooses. Free passes are excluded by the money clock, not by a WHERE on
-- kind: a free pass has no reference to verify, so it never turns into income and
-- cannot appear here even though it is a real row in the ledger.

drop function if exists platform_auth.control_revenue_mix(int);
create or replace function platform_auth.control_revenue_mix(p_days int default 90)
returns table (
  offering text, offering_name text, offering_kind text,
  customers int, invoices_paid int, income numeric, share numeric
) language sql stable security definer set search_path = public as $$
  with paid as (
    select coalesce(g.key, p.key, 'unknown') as offering,
           coalesce(g.name, p.name, 'No plan recorded') as offering_name,
           case when s.service_group_id is not null then 'bundle' else 'plan' end as offering_kind,
           i.tenant_id, i.amount_total
    from invoices i
    left join subscriptions s on s.id = i.subscription_id
    left join plans p on p.id = s.plan_id
    left join service_groups g on g.id = s.service_group_id
    where i.deleted_at is null and i.status = 'paid' and i.paid_at is not null
      and i.paid_at >= now() - make_interval(days => greatest(least(coalesce(p_days, 90), 730), 7))
  )
  select offering, max(offering_name), max(offering_kind),
         count(distinct tenant_id)::int, count(*)::int,
         sum(amount_total),
         round((sum(amount_total) / nullif(sum(sum(amount_total)) over (), 0))::numeric, 4)
  from paid
  group by offering
  order by sum(amount_total) desc;
$$;

-- ============================================================
-- 5. A bundle has to name at least one service
-- ============================================================
--
-- 060's CHECK read `array_length(services, 1) between 1 and 3`, and an empty array
-- makes array_length return NULL — which a CHECK treats as satisfied. So the table
-- accepted a bundle with no services at all, exactly the row the whole column exists
-- to make impossible: the panel asks "does this customer have CFA?" of it. Found by
-- 068's own refusal probe before anything was built on top of it. Three-way tightening
-- of a constraint, and the three bundles 060 seeded already satisfy it.
--
-- The <@ half is kept verbatim so the closed vocabulary is still enforced in the same
-- statement, and duplicates are still refused where the array is built — the pricing
-- desk edits names and prices, never this column.

alter table service_groups drop constraint if exists service_groups_services_check;
alter table service_groups add constraint service_groups_services_check
  check (services <@ array['transport','cfa','office']
         and coalesce(array_length(services, 1), 0) between 1 and 3);

-- ============================================================
-- 6. SELLING A BUNDLE — the stamp manual_activate never made
-- ============================================================
--
-- 064 put the bundle the applicant asked for on tenants.service_group_id and said,
-- in as many words, that what was *sold* belongs on subscriptions.service_group_id —
-- written by the activation path. That path was manual_activate (010/011), and it
-- never wrote it, so every customer the office activated on a bundle was priced by
-- the ladder in 066's MRR and looked like a different company in the reports than in
-- the invoice.
--
-- This is a second signature, not a replacement: the 7-argument function keeps
-- behaving exactly as 011 left it, so any caller that has never heard of bundles is
-- unaffected. When a bundle is given, the bundle's own ladder prices the invoice, the
-- bundle's seat_limit becomes the licence, and plan_id — which 005 made NOT NULL and
-- which the licence gate still reads for modules — is set to the smallest rung that
-- covers those seats. That is a rule rather than a second dropdown, so the desk
-- cannot sell a 50-seat suite on a starter plan by forgetting to change the other one.

drop function if exists platform_auth.manual_activate(uuid, text, text, text, text, numeric, uuid, text);
create or replace function platform_auth.manual_activate(
  p_tenant_id uuid,
  p_plan_key text,
  p_billing_cycle text,
  p_provider text,
  p_provider_txn_id text,
  p_amount_override numeric,
  p_actor uuid,
  p_service_group_key text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_plan plans%rowtype;
  v_group service_groups%rowtype;
  v_total numeric;
  v_subtotal numeric;
  v_vat numeric;
  v_seats int;
  v_period_end timestamptz;
  v_subscription_id uuid;
  v_invoice_id uuid;
  v_number text;
  v_reference text;
  v_extending boolean;
  v_prev_expiry timestamptz;
begin
  if p_billing_cycle not in ('monthly','quarterly','annual') then
    return jsonb_build_object('status','invalid','message','Invalid billing cycle');
  end if;
  if p_provider not in ('azampesa','mpesa','tigopesa','airtel','halopesa','bank') then
    return jsonb_build_object('status','invalid','message','Invalid payment channel');
  end if;
  if p_service_group_key is not null then
    select * into v_group from service_groups
     where key = p_service_group_key and is_active = true limit 1;
    if not found then
      return jsonb_build_object('status','invalid','message','WAISHA package unavailable');
    end if;
  end if;
  if p_service_group_key is null and p_plan_key is null then
    return jsonb_build_object('status','invalid','message','Choose a package or a plan');
  end if;

  if p_plan_key is not null then
    select * into v_plan from plans where key = p_plan_key and is_active = true limit 1;
    if not found then return jsonb_build_object('status','invalid','message','Plan unavailable'); end if;
  else
    -- The bundle carries the price; the rung only has to be wide enough for the
    -- seats, because seats_licensed is what the licence gate actually reads.
    select * into v_plan from plans
     where is_active = true and seat_limit >= v_group.seat_limit
     order by seat_limit asc limit 1;
    if not found then
      select * into v_plan from plans where is_active = true
       order by seat_limit desc limit 1;
    end if;
    if v_plan.id is null then
      return jsonb_build_object('status','invalid','message','No plan available to license');
    end if;
  end if;

  select licence_expires_at into v_prev_expiry from tenants
   where id = p_tenant_id and deleted_at is null and type <> 'seeker';
  if not found then return jsonb_build_object('status','not_found'); end if;

  v_extending := v_prev_expiry is not null and v_prev_expiry > now();
  v_period_end := (case when v_extending then v_prev_expiry else now() end)
                  + make_interval(months => case p_billing_cycle
                      when 'quarterly' then 3 when 'annual' then 12 else 1 end);

  v_subtotal := case p_billing_cycle
    when 'quarterly' then coalesce(v_group.price_quarterly, v_plan.price_quarterly)
    when 'annual'    then coalesce(v_group.price_annual,    v_plan.price_annual)
    else                  coalesce(v_group.price_monthly,   v_plan.price_monthly) end;
  if p_amount_override is not null and p_amount_override > 0 then
    v_total := round(p_amount_override, 2);
    v_subtotal := round(v_total / (1 + v_plan.vat_rate), 2);
  else
    v_total := round(v_subtotal * (1 + v_plan.vat_rate), 2);
  end if;
  v_vat := round(v_total - v_subtotal, 2);

  -- A ladder re-activation keeps the seats already licensed, exactly as 011 left
  -- them: cutting a company back to the rung's seat_limit mid-term would lock out
  -- staff the office has already sold. A zero is not a licence, though — it is what
  -- a row looks like when nothing ever set it, and holding a company at zero seats
  -- on a paid rung locks out every member of staff it has bought. A bundle sets the
  -- seats it sells either way.
  update subscriptions set plan_id = v_plan.id, billing_cycle = p_billing_cycle,
      status = 'active',
      seats_licensed = coalesce(v_group.seat_limit, nullif(seats_licensed, 0), v_plan.seat_limit),
      service_group_id = v_group.id,
      current_period_start = now(), current_period_end = v_period_end
   where tenant_id = p_tenant_id and deleted_at is null
   returning id into v_subscription_id;
  if v_subscription_id is null then
    -- A first sale licenses the rung the customer was just invoiced for. One seat on
    -- an Enterprise sale is not a conservative default, it is a broken licence.
    insert into subscriptions (tenant_id, plan_id, service_group_id, billing_cycle, status,
      seats_licensed, current_period_start, current_period_end)
    values (p_tenant_id, v_plan.id, v_group.id, p_billing_cycle, 'active',
      coalesce(v_group.seat_limit, v_plan.seat_limit, 1), now(), v_period_end)
    returning id into v_subscription_id;
  end if;

  -- Read the licence back rather than guess it, so the invoice states the seats the
  -- company actually holds after this sale.
  select s.seats_licensed into v_seats from subscriptions s where s.id = v_subscription_id;

  v_number := 'INV-' || to_char(now(), 'YYYY') || '-' ||
              lpad(nextval('invoice_number_seq')::text, 6, '0');
  v_reference := 'MAN-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 12));

  insert into invoices (tenant_id, subscription_id, number, billing_cycle, seats,
    amount_subtotal, vat_rate, vat_amount, amount_total, status, period_start, period_end,
    paid_at)
  values (p_tenant_id, v_subscription_id, v_number, p_billing_cycle, v_seats,
    v_subtotal, v_plan.vat_rate, v_vat, v_total, 'paid',
    current_date, v_period_end::date, now())
  returning id into v_invoice_id;

  insert into payments (tenant_id, invoice_id, provider, provider_txn_id,
    intent_reference, amount, currency, status, idempotency_key, completed_at)
  values (p_tenant_id, v_invoice_id, p_provider, p_provider_txn_id,
    v_reference, v_total, 'TZS', 'approved',
    gen_random_uuid()::text, now());

  update tenants set status = 'active', licence_expires_at = v_period_end
   where id = p_tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity, entity_id, action, after)
  values (p_tenant_id, p_actor, 'tenants', p_tenant_id, 'licence.manually_activated',
    jsonb_build_object(
      'mode', case when v_extending then 'extend' else 'activate' end,
      'bundle', v_group.key, 'plan', v_plan.key, 'cycle', p_billing_cycle,
      'seats', v_seats,
      'provider', p_provider, 'provider_txn_id', p_provider_txn_id,
      'reference', v_reference,
      'subtotal', v_subtotal, 'vat', v_vat, 'total', v_total,
      'previous_expiry', v_prev_expiry, 'new_expiry', v_period_end,
      'invoice', v_number));

  return jsonb_build_object('status','ok',
    'mode', case when v_extending then 'extend' else 'activate' end,
    'bundle', v_group.key, 'plan', v_plan.key, 'seats', v_seats,
    'invoice_number', v_number, 'reference', v_reference, 'total', v_total,
    'licence_expires_at', v_period_end);
end $$;

-- ============================================================
-- 6. MRR reads the bundle, the same way the invoice did
-- ============================================================
--
-- 066's overview priced every subscription from the ladder first and the bundle
-- second, which was right while nothing stamped service_group_id and is wrong from
-- this file on: a customer invoiced 600,000 on the Complete Logistics Suite would
-- still have been counted at the Enterprise price. The whole function is re-declared
-- because create or replace cannot edit one field of a jsonb literal.

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
        'bundles', count(*) filter (where sub.service_group_id is not null
          and sub.status in ('active','trial','grace')),
        'seats_licensed', coalesce(sum(sub.seats_licensed) filter (
          where sub.status in ('active','trial','grace')), 0))
      from subscriptions sub where sub.deleted_at is null),

    -- Monthly-equivalent, so a quarterly and an annual customer sit on the same
    -- axis. The bundle is read first: it is what the office invoiced.
    'recurring', (select jsonb_build_object(
        'mrr', coalesce(sum(case sub.billing_cycle
              when 'quarterly' then coalesce(g.price_quarterly, p.price_quarterly) / 3
              when 'annual'     then coalesce(g.price_annual,    p.price_annual) / 12
              else coalesce(g.price_monthly, p.price_monthly) end), 0),
        'arr', coalesce(sum(case sub.billing_cycle
              when 'quarterly' then coalesce(g.price_quarterly, p.price_quarterly) * 4
              when 'annual'     then coalesce(g.price_annual,    p.price_annual)
              else coalesce(g.price_monthly, p.price_monthly) * 12 end), 0))
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
-- 7. Indexes the two registers need to stay index scans
-- ============================================================
--
-- Both registers sort by a date that has never had an index: the ledger by
-- created_at on invoices (005 indexed tenant and status only) and every "who is due"
-- question by subscription period end. On today's row counts either is a sequential
-- scan that gets slower in silence.

create index if not exists idx_invoices_created
  on invoices (created_at desc, id) where deleted_at is null;
create index if not exists idx_invoices_subscription
  on invoices (subscription_id) where subscription_id is not null and deleted_at is null;
create index if not exists idx_invoices_paid_at
  on invoices (paid_at desc) where status = 'paid' and paid_at is not null and deleted_at is null;
create index if not exists idx_subscriptions_period_end
  on subscriptions (current_period_end) where deleted_at is null;
create index if not exists idx_passes_recorded
  on seeker_search_passes (created_at desc) where deleted_at is null;
create index if not exists idx_passes_verified
  on seeker_search_passes (verified_at desc) where verified_at is not null and deleted_at is null;

-- ============================================================
-- 8. GRANTS
-- ============================================================

grant execute on function
  platform_auth.control_subscription_register(text, text, text, text, int, int),
  platform_auth.control_payment_ledger(text, text, text, date, date, int),
  platform_auth.control_revenue_mix(int),
  platform_auth.manual_activate(uuid, text, text, text, text, numeric, uuid, text),
  platform_auth.control_overview()
to app_runtime;

-- Same sweep 060 and 066 had to run: a new function belongs to PUBLIC until told
-- otherwise, and 051's lockdown predates every function in this file.
revoke all on function
  platform_auth.control_subscription_register(text, text, text, text, int, int),
  platform_auth.control_payment_ledger(text, text, text, date, date, int),
  platform_auth.control_revenue_mix(int),
  platform_auth.manual_activate(uuid, text, text, text, text, numeric, uuid, text)
from public, anon, authenticated, service_role;

commit;
