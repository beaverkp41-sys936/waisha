-- 008: Licence gate + trial engine (spec 5.1, 5.3, 5.4)
begin;

-- One trial per TIN, per phone, per platform (5.3) — checked across ALL tenants,
-- so it must bypass RLS: security definer, narrow inputs, no user-controlled SQL.
create or replace function platform_auth.claim_trial(
  p_tenant_id uuid, p_tin_search text, p_phone_search text, p_days int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_existing uuid;
  v_ends timestamptz;
begin
  if p_days is null or p_days <> 2 then
    return jsonb_build_object('status','invalid','message','Trial length must be 2 days (48 hours)');
  end if;

  -- Cross-tenant trial claims by same TIN or phone
  select s.id into v_existing
  from subscriptions s join tenants t on t.id = s.tenant_id
  where s.trial_started_at is not null
    and (t.tin_search = p_tin_search or t.phone_search = p_phone_search)
  limit 1;
  if v_existing is not null then
    return jsonb_build_object('status','already_used','message','A trial has already been used for this company, TIN or phone number.');
  end if;

  -- Tenant must not already hold a live subscription
  select id into v_existing from subscriptions
   where tenant_id = p_tenant_id and deleted_at is null limit 1;
  if v_existing is not null then
    return jsonb_build_object('status','conflict','message','A subscription already exists for this account.');
  end if;

  v_ends := now() + make_interval(hours => p_days * 24);

  insert into subscriptions (tenant_id, plan_id, billing_cycle, status, seats_licensed,
                             trial_started_at, trial_ends_at, current_period_start, current_period_end)
  select p_tenant_id, id, 'monthly', 'trial', 0, now(), v_ends, now(), v_ends
  from plans where key = 'business' limit 1;

  -- The 48h trial runs on the Business plan with full edit access (5.3)
  update tenants set status = 'trial', trial_started_at = now(), trial_ends_at = v_ends
   where id = p_tenant_id;

  return jsonb_build_object('status','ok','trial_ends_at', v_ends);
end $$;

grant execute on function platform_auth.claim_trial(uuid, text, text, int) to app_runtime;

-- Read-only when expired: RLS backstop. Once a tenant's trial/licence lapses
-- beyond grace, INSERT/UPDATE/DELETE on tenant data is refused at the policy
-- layer — no client or server code can bypass it. SELECT stays allowed.
create or replace function platform_auth.tenant_is_operational()
returns boolean language sql stable as $$   select not exists (
    select 1 from tenants t
    where t.id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and t.deleted_at is null
      and (
        -- trial running? operational
        (t.status = 'trial' and t.trial_ends_at > now())
        -- active licence? operational
        or (t.status = 'active' and t.licence_expires_at > now())
        -- grace window on expired licence? operational
        or (t.status = 'grace' and t.licence_expires_at + interval '3 days' > now())
      )
  )
 $$;
grant execute on function platform_auth.tenant_is_operational() to app_runtime;

-- Trial-usage check (how much time is left / status snapshot for UI)
create or replace function platform_auth.get_licence(p_tenant_id uuid)
returns jsonb language sql security definer set search_path = public as $$   select jsonb_build_object(
    'tenant_status', t.status,
    'trial_started_at', t.trial_started_at,
    'trial_ends_at', t.trial_ends_at,
    'licence_expires_at', t.licence_expires_at,
    'plan', (select p.name from subscriptions s join plans p on p.id = s.plan_id
             where s.tenant_id = t.id and s.deleted_at is null limit 1),
    'plan_key', (select p.key from subscriptions s join plans p on p.id = s.plan_id
             where s.tenant_id = t.id and s.deleted_at is null limit 1),
    'seats_licensed', (select s.seats_licensed from subscriptions s
             where s.tenant_id = t.id and s.deleted_at is null limit 1),
    'subscription_status', (select s.status from subscriptions s
             where s.tenant_id = t.id and s.deleted_at is null limit 1)
  )
  from tenants t where t.id = p_tenant_id and t.deleted_at is null;
 $$;
grant execute on function platform_auth.get_licence(uuid) to app_runtime;

commit;