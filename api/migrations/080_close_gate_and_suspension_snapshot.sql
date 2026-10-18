-- 080 — a closed company is a gated company, and the gate costs nothing to consult.
--
-- 078 gave the desk the four acts and 079 shut the two doors 078 had left open to every
-- role. Reviewing the enforcement hook that 078 made necessary (tenant-state.ts, wired in
-- this same task) exposed two things worth fixing in the schema rather than around it.
--
-- 1. CLOSE WAS NOT GATED. The per-request gate asks `tenant_block_state(tid)` and a NULL
--    answer means "open for business". 078 wrote that answer for two different situations
--    it only intended to mean one: a company that is not suspended, and a company that is
--    no longer there at all — the function ended in `where t.id = p_tenant_id and
--    t.deleted_at is null`, so a closed (tombstoned) company had no row to read and looked
--    identical to a healthy one. Blocking is fine there, because a block revokes the
--    sessions and the same function then answers with the reason. A close revokes the
--    sessions too, so the staff of a closed company keep trading on the access tokens they
--    were issued, for up to fifteen minutes, through the one door that was supposed to
--    catch it. `close` now stamps `status = 'suspended'` alongside the tombstone — the
--    tombstone is what hides the company from every read, the status is what the gate
--    indexes on, and a company can be both — and the state function reports the closed
--    case as itself, with a `closed` flag so the sentence the person reads says
--    "closed", not "suspended by the office".
--    Reopening is not a thing this adds: `tenant_apply_action` reads the company with
--    `where deleted_at is null ... for update`, so once closed, no further action —
--    including unblock — can reach it. That is also why stamping 'suspended' on a
--    tombstone cannot produce a zombie row.
--
-- 2. THE GATE COST A QUERY PER REQUEST. `requireAuth` only verifies a signature; every
--    authenticated call would now have made a round trip to read one company's state, on
--    a pool where the round trip is the expensive part. The overwhelming majority of the
--    time the answer is "nobody is blocked": today the live set of suspended companies is
--    empty, and the desk keeps it that way. So the process reads the whole set once and
--    re-reads it on a short clock, through one definer. A request then asks a Map, not
--    Postgres. The single-company function stays for the login path, where the answer has
--    to be authoritative and current to the millisecond because it is the sentence the
--    blocked person is reading; the cache is only ever in front of the gate that closes
--    the token window, where a decision up to twenty seconds old is still a decision the
--    office already made.
--
-- Both existing functions keep their signatures, so `create or replace` is enough and the
-- ACLs survive — the mistake 079 had to clean up cannot repeat here.

begin;

-- ============================================================
-- 1. close suspends as well as tombstones
-- ============================================================

-- Re-declared whole: create or replace cannot edit one expression of a plpgsql body.
-- Everything below is 078 verbatim except the close branch, its v_new, and the comments.
create or replace function platform_auth.tenant_apply_action(
  p_tenant_id uuid,
  p_action text,
  p_reason_code text,
  p_note text,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_ip text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_t tenants%rowtype;
  v_prior text;
  v_new text;
  v_reason text;
  v_note text;
  v_kind text;
  v_seats int;
  v_revoked int := 0;
  v_action_id uuid;
  v_targets jsonb;
begin
  if p_action not in ('block','unblock','close','notice') then
    return jsonb_build_object('status','invalid','message','Unknown action');
  end if;
  v_reason := coalesce(p_reason_code, 'other');
  if v_reason not in ('terms_violation','long_idle','payment_default','abuse',
                      'complaint','security','other') then
    return jsonb_build_object('status','invalid','message','Unknown reason');
  end if;
  v_note := trim(coalesce(p_note, ''));
  if char_length(v_note) < 8 or char_length(v_note) > 600 then
    return jsonb_build_object('status','invalid',
      'message','The note must be 8-600 characters: it is the sentence the company is sent.');
  end if;
  v_kind := coalesce(p_actor_kind, 'control');
  if v_kind not in ('control','system') then
    return jsonb_build_object('status','invalid','message','Unknown actor');
  end if;

  select * into v_t from tenants
   where id = p_tenant_id and deleted_at is null
   for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_t.type in ('platform','seeker') then
    return jsonb_build_object('status','invalid',
      'message','Only a company account can be acted on here.');
  end if;

  select s.seats_licensed into v_seats from subscriptions s
   where s.tenant_id = v_t.id and s.deleted_at is null limit 1;

  v_new := v_t.status;
  if p_action = 'block' then
    if v_t.status = 'suspended' then
      return jsonb_build_object('status','conflict','message','This company is already blocked.');
    end if;
    v_new := 'suspended';
  elsif p_action = 'unblock' then
    if v_t.status <> 'suspended' then
      return jsonb_build_object('status','conflict','message','This company is not blocked.');
    end if;
    -- Back to where it was found, not to 'active': a licence that lapsed while the
    -- company sat blocked must not come back as a paid licence.
    select a.prior_status into v_prior from tenant_actions a
     where a.tenant_id = v_t.id and a.action = 'block'
     order by a.created_at desc limit 1;
    v_new := coalesce(v_prior, 'active');
  elsif p_action = 'close' then
    -- 078 left the status as found and let the tombstone be the state. It is, for every
    -- read that filters deleted_at — but the gate that closes the access-token window
    -- indexes on status, so a closed company looked open. Both are now set: the
    -- tombstone hides the papers, the status stops the serving.
    v_new := 'suspended';
  end if;

  if p_action in ('block','unblock') then
    update tenants set status = v_new, updated_at = now(), updated_by = p_actor_user_id
     where id = v_t.id;
  elsif p_action = 'close' then
    update tenants set status = 'suspended', deleted_at = now(),
      updated_at = now(), updated_by = p_actor_user_id
     where id = v_t.id;
  end if;

  if p_action in ('block','close') then
    -- The access token lives 15 minutes, so revoking the refresh sessions is what makes
    -- the block hold; tenant_block_state below closes the window in between.
    update sessions set revoked_at = now(),
           revoked_reason = case p_action when 'block' then 'tenant_blocked' else 'tenant_closed' end
     where tenant_id = v_t.id and revoked_at is null;
    get diagnostics v_revoked = row_count;
  end if;

  insert into tenant_actions (id, tenant_id, action, reason_code, note, prior_status, new_status,
      seats_licensed, actor_kind, actor_user_id, actor_role, actor_ip, delivery)
  values (gen_random_uuid(), v_t.id, p_action, v_reason, v_note, v_t.status, v_new, v_seats,
      v_kind, p_actor_user_id, p_actor_role, p_actor_ip, '{}'::jsonb)
  returning id into v_action_id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), v_t.id, p_actor_user_id, p_actor_role, p_actor_ip,
      'tenants', v_t.id, 'tenant.' || p_action,
      jsonb_build_object('status', v_t.status, 'seats_licensed', v_seats),
      jsonb_build_object('reason_code', v_reason, 'note', v_note, 'actor_kind', v_kind,
        'new_status', v_new, 'closed', p_action = 'close', 'sessions_revoked', v_revoked,
        'action_id', v_action_id));

  -- Who is told. The directors of the company, and if a company has no live director
  -- left, the contact the company itself was registered with.
  select coalesce(jsonb_agg(json_build_object(
           'name', x.full_name, 'email', x.email, 'phone', x.phone)), '[]'::jsonb)
    into v_targets
    from (select u.full_name, u.email, encode(u.phone_encrypted, 'hex') as phone
            from users u
           where u.tenant_id = v_t.id and u.user_type = 'director'
             and u.deleted_at is null and u.status = 'active'
           order by u.created_at limit 6) x;
  if v_targets = '[]'::jsonb and (v_t.email is not null or v_t.phone_encrypted is not null) then
    v_targets := jsonb_build_array(json_build_object(
      'name', v_t.name, 'email', v_t.email, 'phone', encode(v_t.phone_encrypted, 'hex')));
  end if;

  return jsonb_build_object('status','ok', 'action_id', v_action_id, 'action', p_action,
    'tenant_id', v_t.id, 'tenant_name', v_t.name,
    'prior_status', v_t.status, 'status', v_new, 'closed', p_action = 'close',
    'seats_licensed', v_seats, 'sessions_revoked', v_revoked,
    'reason_code', v_reason, 'note', v_note, 'targets', v_targets);
end $$;

-- ============================================================
-- 2. the state, including the closed one
-- ============================================================

create or replace function platform_auth.tenant_block_state(p_tenant_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select case
    -- Only a company that is neither suspended nor gone is open. 078's clause read
    -- `status <> 'suspended'` with a `deleted_at is null` filter, which answered NULL for
    -- a closed company as well as for a healthy one.
    when t.status <> 'suspended' and t.deleted_at is null then null
    else jsonb_build_object(
      'reason_code', coalesce(b.reason_code, 'other'),
      -- A tombstone this register never wrote (a company removed by some other path) has
      -- no note of its own and must not borrow the wording of a block nobody announced.
      'note', coalesce(b.note,
        case when t.deleted_at is not null
             then 'This company''s WAISHA account has been closed.'
             else 'Blocked by the WAISHA office.' end),
      'since', b.created_at,
      'by', coalesce(b.actor_kind, 'control'),
      'closed', t.deleted_at is not null)
    end
  from tenants t
  left join lateral (
    -- Newest of the two acts that take a company out of service, not just the block: a
    -- company closed after being blocked reads as closed, with the close's own reason.
    select a.reason_code, a.note, a.created_at, a.actor_kind
      from tenant_actions a
     where a.tenant_id = t.id and a.action in ('block','close')
     order by a.created_at desc limit 1) b on true
  where t.id = p_tenant_id;
$$;

-- ============================================================
-- 3. the whole set, in one read
-- ============================================================

-- Every company currently out of service, with the reason the desk would show. Small by
-- design: the desk blocks deliberately and the clock blocks only after six weeks.
-- app_runtime cannot select across tenants from `tenants` (RLS), which is why this has to
-- be a definer at all rather than a query in the hook.
create or replace function platform_auth.tenant_suspensions()
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'tenant_id', y.id, 'state', platform_auth.tenant_block_state(y.id))), '[]'::jsonb)
  from (
    select t.id from tenants t
     where t.status = 'suspended' or t.deleted_at is not null
  ) y;
$$;

-- ============================================================
-- 4. a company already closed by an earlier build is suspended too
-- ============================================================
--
-- 078's close left the status alone. Rows written that way are gated by this file's state
-- function anyway (`deleted_at is not null` answers it), so nothing is unprotected; this
-- only makes the column say what the company's state actually is, so the desk list and
-- the gate cannot disagree about a company the desk already closed.
with gone as (
  select t.id, t.status as was
    from tenants t
   where t.deleted_at is not null and t.status <> 'suspended'
), fixed as (
  update tenants t set status = 'suspended', updated_at = now()
    from gone g
   where t.id = g.id
  returning t.id
)
insert into audit_logs (id, tenant_id, actor_role, entity, entity_id, action, before, after)
select gen_random_uuid(), g.id, 'system', 'tenants', g.id, 'licence.close_state_repaired',
       jsonb_build_object('status', g.was),
       jsonb_build_object('status', 'suspended', 'why',
                          '080: a closed company is also a suspended one')
  from gone g join fixed f on f.id = g.id;

-- ============================================================
-- 5. grants
-- ============================================================

grant execute on function platform_auth.tenant_suspensions() to app_runtime;

-- The sweep 060, 066, 068, 070 and 078 each had to run: a new function belongs to PUBLIC
-- until told otherwise. The two re-declared functions are not listed here because
-- create or replace carried their 078/079 ACLs over untouched.
revoke all on function platform_auth.tenant_suspensions()
from public, anon, authenticated, service_role;

commit;
