-- 007: control session lookup (short-lived challenge + full sessions)
begin;
create or replace function platform_auth.get_control_session(p_token_hash text)
returns jsonb language sql security definer set search_path = public as $$   select jsonb_build_object(
    'session_id', s.id, 'user_id', s.user_id, 'tenant_id', s.tenant_id,
    'email', u.email, 'full_name', u.full_name, 'totp_enabled', u.totp_enabled,
    'expires_at', s.expires_at,
    'roles', coalesce((
      select array_agg(r.key) from user_roles ur join roles r on r.id = ur.role_id
      where ur.user_id = s.user_id), '{}'))
  from sessions s join users u on u.id = s.user_id
  where s.refresh_token_hash = p_token_hash
    and s.revoked_at is null and s.expires_at > now()
  limit 1;
 $$;
grant execute on function platform_auth.get_control_session(text) to app_runtime;
commit;