begin;

-- ============================================================
-- 081: the one key that made every successful action look like a refusal
-- ============================================================
--
-- tenant_apply_action returns one jsonb object, and 078 wrote two keys called
-- 'status' into it: the flag the handler branches on ('ok') and the tenant's new
-- status (v_new). jsonb_build_object keeps the LAST value for a duplicate key, so
-- the flag was always overwritten. Every successful act therefore reached the
-- handler already committed -- company suspended, sessions revoked, register row
-- and audit row written -- and answered 400 "The action was refused."
--
-- That is not a cosmetic miss. The handler's order is act, then invalidate the
-- in-process suspension cache, then notify, then write the receipt. A 400 thrown
-- at the status check abandoned the middle two: the company was blocked but its
-- seats kept the cached answer until the TTL, and the register row was left with
-- an empty delivery, so there was no proof the company was ever told. The sweep
-- counted every one of these as skipped=1, so the idle clock looked inert while it
-- was quietly emptying the platform of trading companies.
--
-- Fixed by renaming the second key to 'new_status', which is what the audit row in
-- this same function already calls it. The success flag stays the only 'status'.
--
-- The body is otherwise 080's, byte for byte: a plpgsql body cannot be patched in
-- place, so it is re-declared whole, and the return type did not change, so
-- create or replace keeps the execute ACL 079 established. Nothing else is touched.

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
    'prior_status', v_t.status, 'new_status', v_new, 'closed', p_action = 'close',
    'seats_licensed', v_seats, 'sessions_revoked', v_revoked,
    'reason_code', v_reason, 'note', v_note, 'targets', v_targets);
end $$;

grant execute on function
  platform_auth.tenant_apply_action(uuid, text, text, text, text, uuid, text, text)
to app_runtime;
revoke all on function
  platform_auth.tenant_apply_action(uuid, text, text, text, text, uuid, text, text)
from public, anon, authenticated, service_role;

commit;
