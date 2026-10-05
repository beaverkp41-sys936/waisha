-- 027: Workspace area gating. Business picks up the CFA module family
-- (invoices, documents, ledger, duty calculator); enterprise already carries
-- '*' so office management and the rest resolve there. get_licence now
-- exposes the plan's module list so the portal can gate areas for real.
begin;

update plans set module_entitlements =
  '{"modules":["dashboard","profile","fleet","routes","trips","checkpoints","tracking","costs","garage","drivers","trainees","reports","invoices","documents","ledger","duty_calculator"]}'
where key = 'business';

create or replace function platform_auth.get_licence(p_tenant_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
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
             where s.tenant_id = t.id and s.deleted_at is null limit 1),
    'modules', coalesce((select p.module_entitlements->'modules'
             from subscriptions s join plans p on p.id = s.plan_id
             where s.tenant_id = t.id and s.deleted_at is null limit 1), '[]'::jsonb)
  )
  from tenants t where t.id = p_tenant_id and t.deleted_at is null;
$$;
grant execute on function platform_auth.get_licence(uuid) to app_runtime;

commit;
