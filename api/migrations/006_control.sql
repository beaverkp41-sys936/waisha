-- 006: Control panel foundations - recovery codes + staff lookup (spec 8)
begin;

-- Single-use recovery codes for platform staff (hashed, never stored plain)
create table if not exists recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_recovery_codes_user on recovery_codes (user_id);

-- Pre-auth staff lookup: platform users by email (security definer, narrow)
create or replace function platform_auth.lookup_platform_login(p_email_search text)
returns jsonb language sql security definer set search_path = public as $$   select jsonb_build_object(
    'user_id', u.id, 'tenant_id', u.tenant_id, 'status', u.status,
    'password_hash', u.password_hash, 'totp_enabled', u.totp_enabled,
    'locked_until', u.locked_until, 'failed_login_count', u.failed_login_count,
    'full_name', u.full_name,
    'roles', coalesce((
      select array_agg(r.key) from user_roles ur join roles r on r.id = ur.role_id
      where ur.user_id = u.id), '{}')
  )
  from users u
  where u.user_type = 'platform'
    and u.email_normalized_search = p_email_search
    and u.deleted_at is null
  limit 1;
 $$;

grant execute on function platform_auth.lookup_platform_login(text) to app_runtime;
grant select, insert, update on recovery_codes to app_runtime;
alter table recovery_codes enable row level security;
create policy recovery_codes_tenant on recovery_codes for all to app_runtime
  using (exists (
    select 1 from users u
    where u.id = recovery_codes.user_id
      and u.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid));

commit;