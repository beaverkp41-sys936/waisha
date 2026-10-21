-- 121 — nothing that takes something away may be signed by one hand (task #338).
--
-- The office's rule for the control panel, in its own words: "Money, prices, bans and
-- permission changes need a two-person approval." Migrations 001-120 have no such thing.
-- A block, a close, a price change or a duty edit is written the moment one seat presses
-- the button — and the seat that presses it is the only witness the platform keeps. On a
-- platform with one person in it that reads as normal. The day there are three, it is the
-- shape of every insider incident that follows: "who shut that company, and when did they
-- decide?" answered by one name and one timestamp.
--
-- This is the register that makes the rule a fact of the schema rather than a line in a
-- policy nobody reads:
--
--   platform_approvals   a proposed act, its whole payload, the SHA-256 of that payload,
--                        the seat that raised it, and the seat that released or refused it.
--
-- Three things make it worth a migration instead of a convention in a route:
--
-- 1. `decided_by <> proposed_by` is a CHECK. One person cannot satisfy it by logging in
--    twice — the two seats are two user ids, and the second one is the row's own column.
-- 2. A released signature cannot be spent twice. `claim_approval` moves the row
--    `approved -> applied` in one `update … where status = 'approved' returning …`, so two
--    concurrent applies race for one row and exactly one gets it.
-- 3. The effect itself is gated in the database. `tenant_actions` gains `approval_id` and a
--    BEFORE INSERT trigger that refuses a control-actor `block` or `close` with no released
--    signature behind it. That is the only kind of enforcement that also holds against the
--    next route somebody writes in a hurry: the register row cannot be born at all.
--
-- What needs two seats, and what does not. Taking a company's access away (block, close) is
-- the act that hurts the business on the other end of the notice, and it is what the rule
-- names — so it needs a signature. Restoring access (unblock) and sending words without
-- touching state (notice) are one-seat acts: a desk that cannot reopen a company until a
-- second person appears is a desk that keeps companies shut out of bureaucracy. The idle
-- clock (`actor_kind = 'system'`) stays automatic for the same reason — a timer has no
-- second hand, and 078's sweep is the reason a lapsed licence actually stops trading.
--
-- Posture: the register belongs to the platform, not to a company, and it is reachable only
-- through definers in `platform_auth` — the same no-policy, no-grant shape 078 gave
-- `tenant_actions`. The payload is stored whole because the decider must read exactly what
-- will happen, and hashed because #347 will put these rows into a signed evidence bundle:
-- payload, so no caller can hand a handler one payload and a hash of another. The hash is
-- taken by `extensions.digest()`: pgcrypto does not live in `public`, and these definers
-- pin their search path, so the only honest way to reach it is by name.
--
-- `tenant_apply_action` gains a ninth argument, and Postgres matches functions by name and
-- input types, so a `create or replace` would have left the 8-arg body alive next to the new
-- one — an unguarded door with a good name on it. The old signature is dropped and the
-- grants restated, as 081 had to do for the same reason.

begin;

-- ============================================================
-- 1. the register
-- ============================================================

create table if not exists platform_approvals (
  id uuid primary key default gen_random_uuid(),
  -- The act, named the way a route will dispatch on it: `tenant.block`, `tenant.close`, and
  -- later `money.payout`, `pricing.publish`, `staff.duty_edit`. A dotted name rather than an
  -- enum on purpose: a new kind must be addable by a later migration without rewriting a
  -- type that existing rows depend on.
  action text not null check (action ~ '^[a-z][a-z0-9_]{1,39}\.[a-z][a-z0-9_]{1,39}$'),
  target_kind text not null check (target_kind ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- Stored as text because a target is not always a uuid-shaped row (a rate card is, a
  -- permission set is not). The definer writes the canonical form of what it validated.
  target_id text not null check (char_length(target_id) between 1 and 120),
  -- Everything the effect needs, so the apply is a replay of what was signed and not a
  -- second decision made by the code that runs it.
  payload jsonb not null default '{}'::jsonb,
  -- Taken in SQL from the bytes that were stored (pgcrypto is installed; 121's verify
  -- asserts digest() actually resolves). Nothing a caller passes can be its own witness.
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  -- Why the office is doing this, in a sentence the second seat can defend out loud. The
  -- floor is the same 8 characters 078 put on a block note: "violation" is not a reason.
  reason text not null check (char_length(trim(reason)) between 8 and 600),
  status text not null default 'pending'
    check (status in ('pending','approved','applied','rejected','lapsed')),

  proposed_by uuid not null references users(id),
  proposed_role text,
  proposed_ip text,
  proposed_ua text,
  proposed_at timestamptz not null default now(),

  decided_by uuid references users(id),
  decided_role text,
  decided_note text,
  decided_ip text,
  decided_ua text,
  decided_at timestamptz,

  applied_at timestamptz,
  -- Whatever the effect answered with (its register row id, its counts), so the desk can
  -- show a signature and the thing it bought in one read.
  result jsonb not null default '{}'::jsonb,
  -- A proposal a second seat never sees must not sit open forever: it would freeze the
  -- target (one open proposal per action+target) and read as a pending decision years
  -- later to whoever finds it.
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),

  -- The rule, in three lines.
  --
  -- Two seats means two user ids. Not two sessions, not two browser tabs: `proposed_by`
  -- and `decided_by` are columns of one row, so a CHECK is all it takes and no route can
  -- talk its way past it.
  check (decided_by is null or decided_by <> proposed_by),
  -- A decision without a decision time is a row somebody edited by hand.
  check (decided_by is null or decided_at is not null),
  check (status in ('pending','lapsed') or decided_by is not null),
  -- Only a spent signature may claim it was applied.
  check (applied_at is null or status = 'applied'),
  check (expires_at > proposed_at)
);

-- The board reads one status newest-first; a target's history is asked by whoever opens the
-- company; and this one is the load-bearing index — one act against one target may be open
-- at a time, and a unique index is the only version of that rule that survives two desks
-- pressing the button in the same second.
create index approvals_status_created on platform_approvals (status, created_at desc);
create index approvals_target on platform_approvals (target_kind, target_id, created_at desc);
create index approvals_proposed_by on platform_approvals (proposed_by, created_at desc);
create unique index approvals_one_open
  on platform_approvals (action, target_kind, target_id) where status = 'pending';

alter table platform_approvals enable row level security;
-- Deliberately no policy and no grant: like 078's register, this table is reachable only
-- through the definers below. A handler that could insert a decided row directly would make
-- the whole migration a decoration.
revoke all on platform_approvals from public, anon, authenticated, app_runtime;

-- ============================================================
-- 2. the doors
-- ============================================================

-- Both seats must be people the platform still lets in. The predicate is 099's for a
-- control session (`user_type = 'platform'`, not deleted), reused here so a signature
-- cannot be bought by a seat that has already been struck off the roster.
create or replace function platform_auth.approval_seat(p_user_id uuid)
returns text language sql security definer set search_path = public as $$
  select coalesce(nullif(trim(u.full_name), ''), split_part(u.email, '@', 1))
    from users u
   where u.id = p_user_id
     and u.user_type = 'platform'
     and u.deleted_at is null
     and u.status = 'active'
   limit 1;
$$;

-- Raise a proposal. Nothing happens to the target; this only writes the sentence the second
-- seat is asked to sign.
create or replace function platform_auth.propose_approval(
  p_action text,
  p_target_kind text,
  p_target_id text,
  p_payload jsonb,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_ip text,
  p_actor_ua text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_name text;
  v_kind text;
  v_act text;
  v_reason text;
  v_payload jsonb;
  v_tid uuid;
  v_note text;
  v_rcode text;
  v_t tenants%rowtype;
  v_id uuid;
  v_open uuid;
  v_sha text;
  v_expiry timestamptz;
begin
  v_name := platform_auth.approval_seat(p_actor_user_id);
  if v_name is null then
    return jsonb_build_object('status','invalid','message','Only a live platform seat can raise an approval.');
  end if;
  v_act := lower(trim(coalesce(p_action, '')));
  v_kind := lower(trim(coalesce(p_target_kind, '')));
  v_reason := trim(coalesce(p_reason, ''));
  if char_length(v_reason) < 8 or char_length(v_reason) > 600 then
    return jsonb_build_object('status','invalid',
      'message','The reason must be 8-600 characters: it is the sentence the second seat signs.');
  end if;
  v_payload := coalesce(p_payload, '{}'::jsonb);
  if jsonb_typeof(v_payload) <> 'object' then
    return jsonb_build_object('status','invalid','message','The payload must be an object.');
  end if;

  -- Every kind that can be applied has to be validated here, because an unapplyable
  -- proposal is a signature that can never be spent. The two bans are the whole set today;
  -- money, prices and duties join this case in their own stages.
  if v_act in ('tenant.block','tenant.close') then
    if v_kind <> 'tenant' then
      return jsonb_build_object('status','invalid','message','A ban is raised against a tenant.');
    end if;
    begin
      v_tid := nullif(trim(coalesce(p_target_id, '')), '')::uuid;
    exception when invalid_text_representation then
      return jsonb_build_object('status','invalid','message','The company id is not a valid id.');
    end;
    if v_tid is null or v_tid::text <> (v_payload ->> 'tenant_id') then
      return jsonb_build_object('status','invalid',
        'message','The proposal and its payload must name the same company.');
    end if;
    v_rcode := coalesce(v_payload ->> 'reason_code', '');
    if v_rcode not in ('terms_violation','long_idle','payment_default','abuse',
                       'complaint','security','other') then
      return jsonb_build_object('status','invalid','message','Unknown reason code for the company.');
    end if;
    v_note := trim(coalesce(v_payload ->> 'note', ''));
    if char_length(v_note) < 8 or char_length(v_note) > 600 then
      return jsonb_build_object('status','invalid',
        'message','The note must be 8-600 characters: it is the sentence the company is sent.');
    end if;

    select * into v_t from tenants
     where id = v_tid and deleted_at is null
     for update;
    if not found then return jsonb_build_object('status','not_found'); end if;
    if v_t.type in ('platform','seeker') then
      return jsonb_build_object('status','invalid',
        'message','Only a company account can be acted on here.');
    end if;
    -- The precondition 078 would have refused at apply time is refused here instead, so a
    -- desk never collects a signature for an act that could not land.
    if v_act = 'tenant.block' and v_t.status = 'suspended' then
      return jsonb_build_object('status','conflict','message','This company is already blocked.');
    end if;
  else
    return jsonb_build_object('status','invalid','message','Unknown action');
  end if;

  -- Canonical bytes, canonical hash: both are written from the same expression, so the hash
  -- in the row is provably the hash of what the row holds.
  --
  -- `extensions.` is not a slip — Supabase installs pgcrypto in its own schema, and a
  -- definer that pins `search_path = public` (Rule 0) therefore cannot see a bare
  -- `digest()`. Qualifying the call keeps the pin intact; widening the search path to
  -- reach it would trade a locked door for one that is only usually locked.
  v_payload := jsonb_build_object('tenant_id', v_tid, 'reason_code', v_rcode, 'note', v_note);
  v_sha := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');
  v_expiry := now() + interval '7 days';

  -- The nested block exists only to turn a two-desks-at-once unique_violation into the same
  -- answer as a deliberate second proposal, naming the proposal that already stands.
  begin
    insert into platform_approvals (id, action, target_kind, target_id, payload, payload_sha256,
        reason, status, proposed_by, proposed_role, proposed_ip, proposed_ua, expires_at)
    values (gen_random_uuid(), v_act, v_kind, v_tid::text, v_payload, v_sha, v_reason,
        'pending', p_actor_user_id, p_actor_role, p_actor_ip, left(coalesce(p_actor_ua, ''), 300),
        v_expiry)
    returning id into v_id;
  exception when unique_violation then
    select a.id into v_open from platform_approvals a
     where a.action = v_act and a.target_kind = v_kind and a.target_id = v_tid::text
       and a.status = 'pending'
     order by a.created_at desc limit 1;
    return jsonb_build_object('status','conflict',
      'message','A proposal to do this to this company is already open and waiting for a second seat.',
      'open_id', v_open);
  end;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent,
      entity, entity_id, action, before, after)
  values (gen_random_uuid(), v_tid, p_actor_user_id, p_actor_role, p_actor_ip,
      left(coalesce(p_actor_ua, ''), 300),
      'platform_approvals', v_id, 'approval.proposed',
      null,
      jsonb_build_object('action', v_act, 'target_kind', v_kind, 'target_id', v_tid::text,
        'target_name', v_t.name, 'reason', v_reason, 'payload_sha256', v_sha,
        'status', 'pending', 'expires_at', v_expiry));

  return jsonb_build_object('status','ok', 'approval_id', v_id, 'action', v_act,
    'target_kind', v_kind, 'target_id', v_tid::text, 'target_name', v_t.name,
    'payload_sha256', v_sha, 'approval_status', 'pending', 'expires_at', v_expiry);
end $$;

-- Release or refuse a proposal. The decider's duty is checked by the route; *who* they are
-- and *that they are not the proposer* is checked here, because that is the rule.
create or replace function platform_auth.decide_approval(
  p_id uuid,
  p_decision text,
  p_note text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_ip text,
  p_actor_ua text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_name text;
  v_a platform_approvals%rowtype;
  v_note text;
  v_dec text;
  v_target text;
begin
  v_name := platform_auth.approval_seat(p_actor_user_id);
  if v_name is null then
    return jsonb_build_object('status','invalid','message','Only a live platform seat can decide an approval.');
  end if;
  v_dec := lower(trim(coalesce(p_decision, '')));
  if v_dec not in ('approve','reject') then
    return jsonb_build_object('status','invalid','message','Unknown decision');
  end if;
  v_note := trim(coalesce(p_note, ''));
  -- Shorter than a proposer's reason on purpose: "yes, blocked" is a sentence a second seat
  -- can honestly type, and it is still a sentence.
  if char_length(v_note) < 4 or char_length(v_note) > 400 then
    return jsonb_build_object('status','invalid',
      'message','The second seat has to write a line: 4-400 characters.');
  end if;

  select * into v_a from platform_approvals where id = p_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_a.status = 'pending' and v_a.expires_at <= now() then
    update platform_approvals set status = 'lapsed' where id = v_a.id;
    return jsonb_build_object('status','lapsed',
      'message','This proposal expired before anyone signed it.');
  end if;
  if v_a.status <> 'pending' then
    return jsonb_build_object('status','conflict', 'approval_status', v_a.status,
      'message','This proposal has already been decided.');
  end if;
  if v_a.proposed_by = p_actor_user_id then
    return jsonb_build_object('status','self',
      'message','The seat that raised a proposal cannot be the one that signs it. Ask a second person.');
  end if;

  update platform_approvals
     set status = case v_dec when 'approve' then 'approved' else 'rejected' end,
         decided_by = p_actor_user_id, decided_role = p_actor_role, decided_note = v_note,
         decided_ip = p_actor_ip,
         decided_ua = left(coalesce(p_actor_ua, ''), 300), decided_at = now()
   where id = v_a.id;

  -- Compared through `::text` rather than a cast of the input: the row's target is the
  -- proposer's business, not this lookup's, and a seq scan of tenants once per decision is
  -- not the thing to optimise here.
  v_target := v_a.target_id;
  if v_a.target_kind = 'tenant' then
    select t.name into v_target from tenants t where t.id::text = v_a.target_id;
    -- `into` with no rows leaves NULL, not the previous value: a company that has since
    -- been tombstoned must still be named on the signature that banned it.
    if v_target is null then v_target := v_a.target_id; end if;
  end if;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, user_agent,
      entity, entity_id, action, before, after)
  values (gen_random_uuid(),
      case when v_a.target_kind = 'tenant' then v_a.target_id::uuid else null end,
      p_actor_user_id, p_actor_role, p_actor_ip, left(coalesce(p_actor_ua, ''), 300),
      'platform_approvals', v_a.id, 'approval.' || v_dec,
      jsonb_build_object('status', v_a.status, 'proposed_by', v_a.proposed_by),
      jsonb_build_object('status', case v_dec when 'approve' then 'approved' else 'rejected' end,
        'action', v_a.action, 'target_kind', v_a.target_kind, 'target_id', v_a.target_id,
        'target_name', v_target, 'reason', v_a.reason, 'payload_sha256', v_a.payload_sha256,
        'note', v_note, 'decided_by', p_actor_user_id, 'decided_name', v_name));

  return jsonb_build_object('status','ok', 'approval_id', v_a.id, 'action', v_a.action,
    'target_kind', v_a.target_kind, 'target_id', v_a.target_id, 'payload', v_a.payload,
    'payload_sha256', v_a.payload_sha256, 'reason', v_a.reason,
    'approval_status', case v_dec when 'approve' then 'approved' else 'rejected' end,
    'proposed_by', v_a.proposed_by, 'decided_name', v_name);
end $$;

-- Spend a released signature. Exactly one caller can win this update, and only the seat
-- that signed may spend it — a signature is not a token to be passed around the office.
create or replace function platform_auth.claim_approval(p_id uuid, p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_a platform_approvals%rowtype;
begin
  select * into v_a from platform_approvals where id = p_id for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if v_a.status <> 'approved' then
    return jsonb_build_object('status','conflict', 'approval_status', v_a.status);
  end if;
  if v_a.decided_by is distinct from p_actor_user_id then
    return jsonb_build_object('status','unauthorised',
      'message','Only the seat that released a signature may spend it.');
  end if;

  update platform_approvals set status = 'applied', applied_at = now()
   where id = v_a.id and status = 'approved'
   returning action, target_kind, target_id, payload into v_a.action, v_a.target_kind,
     v_a.target_id, v_a.payload;
  if not found then
    return jsonb_build_object('status','conflict','approval_status','pending');
  end if;

  return jsonb_build_object('status','ok', 'action', v_a.action, 'target_kind', v_a.target_kind,
    'target_id', v_a.target_id, 'payload', v_a.payload);
end $$;

-- Record what the effect answered with, on the signature that bought it.
create or replace function platform_auth.settle_approval(p_id uuid, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_id uuid;
begin
  update platform_approvals
     set result = coalesce(p_result, '{}'::jsonb)
   where id = p_id and status = 'applied'
   returning id into v_id;
  if v_id is null then return jsonb_build_object('status','not_found'); end if;
  return jsonb_build_object('status','ok');
end $$;

-- The board: one call for the rows, the per-status counts and the self-heal. A pending
-- proposal whose window has passed is lapsed at the moment somebody looks at it, which is
-- why there is no sweeper to schedule and nothing to miss while the API was down (084's
-- reasoning for expiring covers by reading them, reused).
create or replace function platform_auth.approvals_board(
  p_status text,
  p_action text,
  p_search text,
  p_limit int,
  p_offset int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_rows jsonb;
  v_counts jsonb;
begin
  update platform_approvals set status = 'lapsed'
   where status = 'pending' and expires_at <= now();

  select coalesce(jsonb_agg(json_build_object(
      'id', a.id, 'action', a.action, 'target_kind', a.target_kind, 'target_id', a.target_id,
      'target_name', a.target_name, 'reason', a.reason, 'approval_status', a.status,
      'payload', a.payload, 'payload_sha256', a.payload_sha256,
      'proposed_name', a.proposed_name, 'proposed_role', a.proposed_role,
      'proposed_at', a.proposed_at,
      'decided_name', a.decided_name, 'decided_role', a.decided_role,
      'decided_note', a.decided_note, 'decided_at', a.decided_at,
      'applied_at', a.applied_at, 'result', a.result, 'expires_at', a.expires_at)
      order by a.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select q.*,
             coalesce(t.name, q.target_id) as target_name,
             pu.full_name as proposed_name,
             du.full_name as decided_name
        from (
          select a.id, a.action, a.target_kind, a.target_id, a.reason, a.status, a.payload,
                 a.payload_sha256, a.proposed_role, a.proposed_at, a.decided_role,
                 a.decided_note, a.decided_at, a.applied_at, a.result, a.expires_at,
                 a.created_at, a.proposed_by, a.decided_by
            from platform_approvals a
           where (p_status is null or p_status = 'all' or a.status = p_status)
             and (p_action is null or a.action = p_action)
             and (p_search is null or btrim(p_search) = ''
                  or a.reason ilike '%' || btrim(p_search) || '%'
                  or a.target_id ilike '%' || btrim(p_search) || '%'
                  or a.payload ->> 'note' ilike '%' || btrim(p_search) || '%'
                  or exists (select 1 from tenants tt
                              where tt.id::text = a.target_id
                                and tt.name ilike '%' || btrim(p_search) || '%'))
           order by a.created_at desc
           limit least(greatest(coalesce(p_limit, 30), 1), 100)
          offset greatest(coalesce(p_offset, 0), 0)) q
        left join tenants t on q.target_kind = 'tenant' and t.id::text = q.target_id
        left join users pu on pu.id = q.proposed_by
        left join users du on du.id = q.decided_by
    ) a;

  select jsonb_build_object(
           'pending',  count(*) filter (where status = 'pending'),
           'approved', count(*) filter (where status = 'approved'),
           'applied',  count(*) filter (where status = 'applied'),
           'rejected', count(*) filter (where status = 'rejected'),
           'lapsed',   count(*) filter (where status = 'lapsed'),
           'total',    count(*))
    into v_counts
    from platform_approvals
   where (p_action is null or action = p_action);

  return jsonb_build_object('rows', v_rows, 'counts', v_counts);
end $$;

-- One row, for a deep link and for the "why is this missing" question that follows a
-- signature nobody can find on the board.
create or replace function platform_auth.approval_detail(p_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce((
    select jsonb_build_object(
      'id', a.id, 'action', a.action, 'target_kind', a.target_kind, 'target_id', a.target_id,
      'target_name', coalesce(t.name, a.target_id), 'reason', a.reason,
      'approval_status', a.status, 'payload', a.payload, 'payload_sha256', a.payload_sha256,
      'proposed_by', a.proposed_by, 'proposed_name', pu.full_name, 'proposed_role', a.proposed_role,
      'proposed_at', a.proposed_at,
      'decided_by', a.decided_by, 'decided_name', du.full_name, 'decided_role', a.decided_role,
      'decided_note', a.decided_note, 'decided_at', a.decided_at,
      'applied_at', a.applied_at, 'result', a.result, 'expires_at', a.expires_at)
    from platform_approvals a
    left join tenants t on a.target_kind = 'tenant' and t.id::text = a.target_id
    left join users pu on pu.id = a.proposed_by
    left join users du on du.id = a.decided_by
    where a.id = p_id),
    jsonb_build_object('status','not_found'));
$$;

-- How many acts are waiting for a second seat: the number a desk should not be able to
-- ignore, and the one a later command-centre advisory line can read without a board query.
create or replace function platform_auth.count_open_approvals()
returns int language sql security definer set search_path = public as $$
  select count(*)::int from platform_approvals
   where status = 'pending' and expires_at > now();
$$;

-- ============================================================
-- 3. the ban cannot be written without a signature
-- ============================================================

alter table tenant_actions
  add column if not exists approval_id uuid references platform_approvals(id);

create index if not exists tenant_actions_approval
  on tenant_actions (approval_id) where approval_id is not null;

-- The enforcement lives here rather than in a route, so that the next handler somebody
-- writes for a ban cannot ship without it. A control-actor block or close with no released
-- signature is refused at the moment the register row is born — in SQL, and whatever the
-- caller's transaction looks like.
create or replace function platform_auth.action_needs_two_seats()
returns trigger language plpgsql as $$ declare
  v_signed int;
begin
  -- The timer has no second hand, and restoring access is not an act that hurts anybody.
  if new.actor_kind <> 'control' or new.action not in ('block','close') then
    return new;
  end if;
  if new.approval_id is not null then
    select count(*) into v_signed from platform_approvals a
     where a.id = new.approval_id
       and a.status in ('approved','applied')
       and a.action = 'tenant.' || new.action
       and a.target_kind = 'tenant'
       and a.target_id = new.tenant_id::text;
  else
    v_signed := 0;
  end if;
  if v_signed = 0 then
    raise exception
      'tenant_actions: a % of a company needs a released two-person signature (approval_id)',
      new.action using errcode = '23514';
  end if;
  return new;
end $$;

create trigger tenant_actions_two_seats
  before insert on tenant_actions
  for each row execute function platform_auth.action_needs_two_seats();

-- 110's lesson: a trigger function is created by the owner and fired as the inserting
-- role, so it needs no grant to anybody who can also call it as a function. It stays
-- owner-only.
revoke all on function platform_auth.action_needs_two_seats()
  from public, anon, authenticated, app_runtime;
revoke all on function platform_auth.approval_seat(uuid)
  from public, anon, authenticated, app_runtime;

-- ============================================================
-- 4. the register read gains the two names
-- ============================================================

-- Same signature, same return type, so create or replace keeps the ACL 079 pinned. The
-- desk has to show which two people a block stands on, or `approval_id` is a column
-- somebody has to believe.
create or replace function platform_auth.control_tenant_actions(p_tenant_id uuid, p_limit int)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(json_build_object(
           'id', a.id, 'action', a.action, 'reason_code', a.reason_code, 'note', a.note,
           'prior_status', a.prior_status, 'new_status', a.new_status,
           'seats_licensed', a.seats_licensed, 'actor_kind', a.actor_kind,
           'actor_role', a.actor_role, 'delivery', a.delivery, 'created_at', a.created_at,
           'approval_id', a.approval_id,
           'raised_by', pu.full_name, 'signed_by', du.full_name,
           'signed_at', ap.decided_at)
         order by a.created_at desc), '[]'::jsonb)
  from (select * from tenant_actions
         where tenant_id = p_tenant_id
         order by created_at desc limit least(coalesce(p_limit, 20), 50)) a
  left join platform_approvals ap on ap.id = a.approval_id
  left join users pu on pu.id = ap.proposed_by
  left join users du on du.id = ap.decided_by;
$$;

-- ============================================================
-- 5. the act takes the signature it stands on
-- ============================================================

-- Postgres chooses between overloads by input types, so an extra argument is a second
-- function unless the first one goes. Without the drop, `tenant_apply_action` with eight
-- arguments would stay callable — and the nine-argument door would be the only one with a
-- lock on it.
drop function if exists platform_auth.tenant_apply_action(
  uuid, text, text, text, text, uuid, text, text);

-- Body restated from 081 with two changes and nothing else: the ninth argument, and the
-- column it lands in. A plpgsql body cannot be patched in place.
create or replace function platform_auth.tenant_apply_action(
  p_tenant_id uuid,
  p_action text,
  p_reason_code text,
  p_note text,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_actor_role text,
  p_actor_ip text,
  p_approval_id uuid)
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
      seats_licensed, actor_kind, actor_user_id, actor_role, actor_ip, approval_id, delivery)
  values (gen_random_uuid(), v_t.id, p_action, v_reason, v_note, v_t.status, v_new, v_seats,
      v_kind, p_actor_user_id, p_actor_role, p_actor_ip, p_approval_id, '{}'::jsonb)
  returning id into v_action_id;

  insert into audit_logs (id, tenant_id, actor_user_id, actor_role, ip, entity, entity_id,
      action, before, after)
  values (gen_random_uuid(), v_t.id, p_actor_user_id, p_actor_role, p_actor_ip,
      'tenants', v_t.id, 'tenant.' || p_action,
      jsonb_build_object('status', v_t.status, 'seats_licensed', v_seats),
      jsonb_build_object('reason_code', v_reason, 'note', v_note, 'actor_kind', v_kind,
        'new_status', v_new, 'closed', p_action = 'close', 'sessions_revoked', v_revoked,
        'action_id', v_action_id, 'approval_id', p_approval_id));

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
    'reason_code', v_reason, 'note', v_note, 'approval_id', p_approval_id,
    'targets', v_targets);
end $$;

-- ============================================================
-- 6. two duties, and the ban keeps its own
-- ============================================================
--
-- Reading the register is a duty the analyst and the support seat need — an unanswered
-- proposal is work sitting in the office. Releasing one is the authority to do the harm,
-- so it goes to exactly the seats that already hold the right to shut a company: whoever
-- can block can second-sign a block, and nobody else can. Seeded from the role_permissions
-- rows themselves rather than from a list of role keys, so the two duties cannot drift
-- apart when a later stage hands `control.tenants.manage` to a new desk.

insert into permissions (key, description) values
  ('control.approvals.view',
   'Control - Read the two-person approval register and its payloads'),
  ('control.approvals.decide',
   'Control - Release or refuse a proposal to ban a company')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.approvals.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','compliance_officer','platform_analyst','support_engineer')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select rp.role_id, 'control.approvals.decide'
  from role_permissions rp
 where rp.permission_key = 'control.tenants.manage'
on conflict do nothing;

-- ============================================================
-- 7. the doors are the only way in
-- ============================================================

grant execute on function
  platform_auth.propose_approval(text, text, text, jsonb, text, uuid, text, text, text),
  platform_auth.decide_approval(uuid, text, text, uuid, text, text, text),
  platform_auth.claim_approval(uuid, uuid),
  platform_auth.settle_approval(uuid, jsonb),
  platform_auth.approvals_board(text, text, text, int, int),
  platform_auth.approval_detail(uuid),
  platform_auth.count_open_approvals(),
  platform_auth.tenant_apply_action(uuid, text, text, text, text, uuid, text, text, uuid)
to app_runtime;

revoke all on function
  platform_auth.propose_approval(text, text, text, jsonb, text, uuid, text, text, text),
  platform_auth.decide_approval(uuid, text, text, uuid, text, text, text),
  platform_auth.claim_approval(uuid, uuid),
  platform_auth.settle_approval(uuid, jsonb),
  platform_auth.approvals_board(text, text, text, int, int),
  platform_auth.approval_detail(uuid),
  platform_auth.count_open_approvals(),
  platform_auth.tenant_apply_action(uuid, text, text, text, text, uuid, text, text, uuid)
from public, anon, authenticated, service_role;

-- ============================================================
-- 8. say what the register looks like on the way in
-- ============================================================

do $$ declare
  v_open int;
  v_bans int;
begin
  select count(*)::int into v_open from platform_approvals where status = 'pending';
  select count(*)::int into v_bans from tenant_actions a
    join tenants t on t.id = a.tenant_id
   where a.action in ('block','close') and a.actor_kind = 'control'
     and a.approval_id is null and t.deleted_at is null;
  raise notice '121: two-person signature live — % proposal(s) open, % earlier control ban(s) on a '
    'company that is still trading were written before this rule existed and stay as they are',
    v_open, v_bans;
end $$;

commit;
