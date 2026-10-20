-- 102: the customer service desk has to be able to name the company on the other end of
-- the line, and a company row belongs to somebody else's tenant.
--
-- 101 put `company_tenant_id` on support_tickets: an incidence is about a company, and the
-- office wants to see every call that company has ever made. The desk picks the company out
-- of the platform's own list, which means the write path has to check that the uuid it was
-- handed really is a live company — a forged or stale id would otherwise either link a call
-- to nothing or land the insert on a foreign key violation and answer 500.
--
-- That check reads one row of `tenants` by id, and `tenants_self` (001:405) lets
-- app_runtime see exactly one tenant: the one in `app.tenant_id`, which for a control desk
-- is the platform's own row. So it is a definer, on the same rail as
-- `list_tenants_for_control` (010/060/078) and `tenant_block_state` (080) — with the same
-- narrow shape: one id in, the four columns the register needs out, no PII, nothing writable.
--
-- Measured on the live database before writing this: the API's role currently holds
-- BYPASSRLS, so a bare query would work today. It is not written that way, because the
-- guarantee being relied on would be a property of one grant on one role rather than of the
-- policy, and 067/079/096 exist precisely because that kind of dependency moves.
begin;

create or replace function platform_auth.support_company_lookup(p_tenant_id uuid)
returns table (tenant_id uuid, name text, tenant_type text, status text)
language sql security definer set search_path = public as $$
  select t.id, t.name, t.type, t.status
    from tenants t
   where t.id = p_tenant_id
     and t.deleted_at is null
     -- A call is logged about a company, not about the platform itself or a job seeker,
     -- and 010's list keeps the same two out for the same reason.
     and t.type not in ('platform','seeker');
$$;

comment on function platform_auth.support_company_lookup(uuid) is
  'One live company by id, for the customer service register. Execute by app_runtime only.';

revoke all on function platform_auth.support_company_lookup(uuid)
  from public, anon, authenticated, service_role;
grant execute on function platform_auth.support_company_lookup(uuid) to app_runtime;

do $$
declare
  v_companies int;
begin
  select count(*)::int into v_companies from tenants
   where deleted_at is null and type not in ('platform','seeker');
  raise notice '102: support_company_lookup ready — % company/transporter record(s) resolvable', v_companies;
end $$;

commit;
