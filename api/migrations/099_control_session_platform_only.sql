-- 099: a control seat is the only thing that may open a control session.
--
-- get_control_session (007) answers to any row of sessions whose refresh_token_hash
-- matches, and the token hash is the only credential it looks at. That is the same lookup
-- the portal uses: a director, staff, driver, trainee, shipper or customer seat that
-- signed in through /api/v1/auth/login holds a sessions row with a hash the portal cookie
-- carries, and nothing about that row says "not a control desk". So a tenant seat's own
-- token, replayed against /api/v1/control/*, passed requireControl and became req.control.
-- Signing in is not the only way to obtain such a row: the refresh path mints them
-- continuously, so the population of candidate hashes is every live session in the
-- platform, not a handful of control logins.
--
-- What that costs today, measured rather than assumed: nothing walks straight into data.
-- All 64 control routes either check a duty key through controlCan or a licence role, and
-- a tenant role holds no control.* key, so a tenant seat gets 403 at every desk and the
-- two ungated endpoints (/control/auth/permissions, /control/auth/me) only echo that
-- seat's own roles back to it. The bug is the claim, not the harm: requireControl says
-- "control sign-in required" while what it verifies is "somebody is signed in somewhere".
-- Every desk is therefore carrying a second lock that the first one was supposed to make
-- unnecessary, and the next control route someone forgets to gate ships open.
--
-- The fix is the audience marker the login page already proves: lookup_platform_login
-- (006) only ever returns a user whose user_type = 'platform', so a control session row
-- can only have been born from a platform seat. Restating that condition in the reader
-- closes the door without touching the portal path at all.
--
-- Shape notes: create or replace (not drop + create) keeps the EXECUTE grant that 079 and
-- 096 placed, because drop + create would hand the function back to PUBLIC; the grant is
-- repeated anyway so a fresh database that only ever saw this file still works. Nothing
-- in this platform closes a platform seat (only shipper accounts set users.deleted_at), so
-- the one added predicate is the whole of the change, and it leaves the documented
-- behaviour of control-staff untouched: a suspended seat still authenticates on its old
-- token until REVOKE_SEAT_SESSIONS_SQL runs.
begin;

create or replace function platform_auth.get_control_session(p_token_hash text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'session_id', s.id, 'user_id', s.user_id, 'tenant_id', s.tenant_id,
    'email', u.email, 'full_name', u.full_name, 'totp_enabled', u.totp_enabled,
    'expires_at', s.expires_at,
    'roles', coalesce((
      select array_agg(r.key) from user_roles ur join roles r on r.id = ur.role_id
      where ur.user_id = s.user_id), '{}'))
  from sessions s
  join users u on u.id = s.user_id
  where s.refresh_token_hash = p_token_hash
    and s.revoked_at is null
    and s.expires_at > now()
    and u.user_type = 'platform'
    and u.deleted_at is null
  limit 1;
$$;

grant execute on function platform_auth.get_control_session(text) to app_runtime;

-- Say what the sweep found, so the next reader can tell whether this was ever needed.
do $$
declare
  v_live   int;
  v_foreign int;
begin
  select count(*)::int into v_live from sessions s
    join users u on u.id = s.user_id
   where s.revoked_at is null and s.expires_at > now();
  select count(*)::int into v_foreign from sessions s
    join users u on u.id = s.user_id
   where s.revoked_at is null and s.expires_at > now()
     and u.user_type <> 'platform';
  raise notice '099: control sessions are now platform-only — % live session(s), of which % belong(s) to a tenant seat that can no longer open a control desk', v_live, v_foreign;
end $$;

commit;
