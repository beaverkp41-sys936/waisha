-- 002: fixes found during step-by-step review.
begin;

-- Platform roles have tenant_id NULL; a plain UNIQUE (tenant_id, key) cannot
-- deduplicate NULLs, so re-running the seed would create duplicate roles.
create unique index if not exists roles_platform_key_uq
  on roles (key) where tenant_id is null;

-- Corrected refresh rotation: the API generates the new token and passes its
-- hash in. (The earlier version generated a token the API could never read.)
create or replace function platform_auth.rotate_refresh(p_old_hash text, p_new_hash text, p_user_agent text, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare s sessions; v_new_id uuid;
begin
  select * into s from sessions where refresh_token_hash = p_old_hash for update;
  if not found then return jsonb_build_object('status','unknown'); end if;
  if s.revoked_at is not null then
    update sessions set revoked_at = now(), revoked_reason = 'family_reuse'
     where family_id = s.family_id and revoked_at is null;
    return jsonb_build_object('status','reuse');
  end if;
  if s.expires_at < now() or s.family_expires_at < now() then
    return jsonb_build_object('status','expired');
  end if;
  if s.last_refreshed_at < now() - interval '30 minutes' then
    update sessions set revoked_at = now(), revoked_reason = 'idle_timeout' where family_id = s.family_id;
    return jsonb_build_object('status','idle');
  end if;
  update sessions set revoked_at = now(), revoked_reason = 'rotated' where id = s.id;
  insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
                        refresh_token_hash, user_agent, ip, expires_at)
  values (gen_random_uuid(), s.user_id, s.tenant_id, s.family_id, s.family_expires_at,
          p_new_hash, coalesce(p_user_agent, s.user_agent), coalesce(p_ip, s.ip),
          least(now() + interval '7 days', s.family_expires_at))
  returning id into v_new_id;
  return jsonb_build_object('status','ok','session_id', v_new_id,
    'user_id', s.user_id, 'tenant_id', s.tenant_id);
end $$;

commit;