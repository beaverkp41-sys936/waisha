-- 106: a session can name the seat that opened it.
--
-- Support work on this platform is currently a guessing game. A customer rings about a
-- company's own desk, and the only way to see what that person sees is to read the tenant's
-- rows from the control desks — which show tables, not the page. So the platform needs a
-- view that IS the tenant's view. That request is, by design, a request to cross the tenant
-- wall, and the wall is the one thing this database is built on: every statement the API
-- runs binds its own tenant, and `withTenant` is a convenience, not a guard (the runtime
-- role has BYPASSRLS). So the answer cannot be "widen the admin's token". It has to be a
-- real session belonging to a real person inside the tenant, plus a mark that says somebody
-- else is sitting in it.
--
-- `actor_user_id` is that mark. NULL is every ordinary seat — the column is not written and
-- nothing about today's behaviour changes. A non-NULL value means: this session's subject is
-- `user_id`, and the person driving it is `actor_user_id`. The API turns the pair into an
-- `act` claim, and a claim nobody can forge (it is minted only by the control route this
-- migration makes possible, and `readAccessClaims` requires it to be a UUID) is what the
-- read-only guard and the banner hang on.
--
-- The column has to exist before the API uses it, and it has to survive the machinery that
-- touches sessions, or the mark leaks:
--
--  - `platform_auth.rotate_refresh` (045) inserts its replacement row with an explicit
--    column list. A support session that refreshed would come back WITHOUT its actor — the
--    borrowed seat would silently become the tenant's own, write-capable, banner-free. The
--    rotation path therefore refuses support rows outright. That is the honest shape anyway:
--    a support visit is bounded by design, and "renew" is not something a visitor inside
--    somebody else's company should get for free. It is also why the row is minted without a
--    usable refresh token — the hash stored is of a value handed to nobody.
--  - The FK cascades from `users`: delete the platform seat that opened a support view and
--    the borrowed sessions go with it. Losing a support session is never a loss.
--
-- The CHECK is not bookkeeping. `actor_user_id = user_id` would be a support row that is
-- also a normal row — the exact shape a bug produces when a route copies the subject into
-- the actor. It is refused at the boundary rather than discovered in an audit.
begin;

alter table sessions add column actor_user_id uuid
  references users(id) on delete cascade;

alter table sessions add constraint sessions_actor_is_not_subject
  check (actor_user_id is null or actor_user_id <> user_id);

-- Only ever searched for two reasons: "what did this platform seat borrow?" and "is this
-- session borrowed?" — both of which skip the 99% of rows where the column is NULL.
create index idx_sessions_actor on sessions (actor_user_id, created_at)
  where actor_user_id is not null;

create or replace function platform_auth.rotate_refresh(
  p_old_hash text, p_new_hash text, p_user_agent text, p_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s sessions; v_new_id uuid; v_ip inet;
begin
  select * into s from sessions where refresh_token_hash = p_old_hash for update;
  if not found then return jsonb_build_object('status','unknown'); end if;
  -- 106: a borrowed seat never renews itself. Replaced below rather than carried, because
  -- the insert lists its columns and would drop the actor without noticing.
  if s.actor_user_id is not null then
    return jsonb_build_object('status','support');
  end if;
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

  -- Keep the address the client presented, but never let a proxy chain or a
  -- malformed header abort a refresh: fall back to the stored one.
  begin
    v_ip := trim(split_part(coalesce(p_ip, ''), ',', 1))::inet;
  exception when others then
    v_ip := null;
  end;

  update sessions set revoked_at = now(), revoked_reason = 'rotated' where id = s.id;
  insert into sessions (id, user_id, tenant_id, family_id, family_expires_at,
                        refresh_token_hash, user_agent, ip, expires_at)
  values (gen_random_uuid(), s.user_id, s.tenant_id, s.family_id, s.family_expires_at,
          p_new_hash, coalesce(p_user_agent, s.user_agent), coalesce(v_ip, s.ip),
          least(now() + interval '7 days', s.family_expires_at))
  returning id into v_new_id;
  return jsonb_build_object('status','ok','session_id', v_new_id,
    'user_id', s.user_id, 'tenant_id', s.tenant_id);
end $$;

-- create or replace keeps the grants 096 and 045 placed, but say them again so a database
-- that only ever saw this file is still a database where refresh works for nobody's tenant.
revoke all on function platform_auth.rotate_refresh(text, text, text, text) from public;
grant execute on function platform_auth.rotate_refresh(text, text, text, text) to app_runtime;

do $$
declare
  v_borrowed int;
  v_has_col  boolean;
begin
  select count(*)::int into v_borrowed from sessions where actor_user_id is not null;
  select exists (
    select 1 from information_schema.columns
     where table_name = 'sessions' and column_name = 'actor_user_id') into v_has_col;
  if not v_has_col then
    raise exception '106: sessions.actor_user_id did not land';
  end if;
  raise notice '106: sessions can now be borrowed — % row(s) already name an actor, and a borrowed seat no longer rotates', v_borrowed;
end $$;

commit;
