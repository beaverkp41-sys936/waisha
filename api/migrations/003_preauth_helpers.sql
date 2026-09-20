-- 003: pre-auth helpers. Before login there is no tenant context, so RLS
-- filters every row from app_runtime. These security definer functions are
-- the ONLY path for pre-auth lookups — each is narrow and purpose-built.
begin;

-- Sign-up duplicate check: returns 'tin', 'email' or NULL.
create or replace function platform_auth.check_signup_duplicates(p_tin_search text, p_email text)
returns text language sql security definer set search_path = public as $$   select 'tin' from tenants where tin_search = p_tin_search
  union all
  select 'email' from users where email = p_email
  limit 1;
 $$;

create or replace function platform_auth.check_shipper_duplicates(p_email text, p_nida_search text)
returns text language sql security definer set search_path = public as $$   select 'email' from users where email = p_email
  union all
  select 'nida' from users where nida_search = p_nida_search
  limit 1;
 $$;

-- OTP verify / resend: fetch a pending user without tenant context.
create or replace function platform_auth.get_user_for_otp(p_user_id uuid)
returns jsonb language sql security definer set search_path = public as $$   select jsonb_build_object(
    'id', u.id, 'tenant_id', u.tenant_id, 'status', u.status,
    'user_type', u.user_type, 'phone_search', u.phone_search,
    'phone_encrypted', u.phone_encrypted)
  from users u where u.id = p_user_id and u.deleted_at is null
  limit 1;
 $$;

create or replace function platform_auth.last_otp_created_at(p_user_id uuid, p_purpose text)
returns timestamptz language sql security definer set search_path = public as $$   select max(created_at) from otp_codes where user_id = p_user_id and purpose = p_purpose;
 $$;

-- Forgot password: returns NULL when the email is unknown (caller responds neutrally).
create or replace function platform_auth.lookup_active_user_by_email(p_email_search text)
returns jsonb language sql security definer set search_path = public as $$   select jsonb_build_object('id', u.id, 'tenant_id', u.tenant_id)
  from users u
  where u.email_normalized_search = p_email_search
    and u.status = 'active' and u.deleted_at is null
  limit 1;
 $$;

-- Logout: revoke by token hash without tenant context.
create or replace function platform_auth.revoke_session_by_hash(p_token_hash text)
returns void language sql security definer set search_path = public as $$   update sessions set revoked_at = now(), revoked_reason = 'logout'
  where refresh_token_hash = p_token_hash and revoked_at is null;
 $$;

-- Reset password: consume the token atomically — single use, 30-minute expiry.
create or replace function platform_auth.consume_reset_token(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare r password_resets;
begin
  select * into r from password_resets
   where token_hash = p_token_hash and used_at is null and expires_at > now()
   limit 1 for update;
  if not found then return jsonb_build_object('status','invalid'); end if;
  update password_resets set used_at = now() where id = r.id;
  return jsonb_build_object('status','ok','user_id', r.user_id, 'tenant_id', r.tenant_id);
end $$;

grant execute on function
  platform_auth.check_signup_duplicates(text, text),
  platform_auth.check_shipper_duplicates(text, text),
  platform_auth.get_user_for_otp(uuid),
  platform_auth.last_otp_created_at(uuid, text),
  platform_auth.lookup_active_user_by_email(text),
  platform_auth.revoke_session_by_hash(text),
  platform_auth.consume_reset_token(text)
to app_runtime;

commit;