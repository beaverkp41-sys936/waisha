-- 078 — a licence that follows the plan, and the desk's hand on a company (task #127).
--
-- Two separate complaints, one root shape: the platform sells a rung and then fails to
-- deliver what that rung is, in either direction.
--
-- 1. THE SEATS. WEMA LTD was sold Enterprise — plan_id moved, an invoice was written,
--    the licence runs to 2029 — and it is still licensed 1 seat, so the director's own
--    account holds the only one and every invite answers "Your licence covers 1 users".
--    The number did not come from Enterprise. `manual_activate` (068) wrote
--        seats_licensed = coalesce(v_group.seat_limit, nullif(seats_licensed, 0), v_plan.seat_limit)
--    and the middle term wins whenever the company already has a number: it was written
--    to protect staff a company has already bought from being locked out mid-term, which
--    is right, and it also protects the legacy 1 that 010/011 stamped into every row
--    (`insert ... seats_licensed ... 1`), which is not a licence at all. So a ladder move
--    up never moved the seats, and NIKWELI LIMITED on Starter is the same story.
--    The rule is now `greatest(what you hold, what you just paid for)`: never cut a
--    company back, never leave it under what it bought. A bundle still sets the seats it
--    sells, unchanged.
--    The existing rows are repaired in the same direction only — up, and only for a paid
--    rung with no bundle behind it. `seats_licensed = 0` is left alone even though it
--    means unmetered: it is more generous than the rung, and taking it away without a
--    sale would lock out people who were invited under it.
--
-- 2. THE HAND. Nothing in the codebase could suspend, close, or even tell a company it
--    was in trouble: `update tenants set status = 'suspended'` appears nowhere, the
--    'suspended' value in 001's CHECK has never been written by anything, and the only
--    tenant-level mutation the control panel has is the sale. So there is no register of
--    what the platform did to a company and no reason recorded against it.
--    This file adds `tenant_actions` — an append-only register (block / unblock / close /
--    notice, each with a reason code, the note the company is sent, who acted, and the
--    delivery receipt) — and the doors that write it. The notice goes out as SMS and
--    email to the company's directors, because an action nobody tells you about is not a
--    warning, it is a surprise.
--    The idle policy the office asked for is enforced on the same register: 45 days
--    without a paid licence blocks the company, 90 days closes it. Both thresholds are
--    measured from the last moment the licence was live, and an unblock recorded by a
--    person is an override that resets the clock — the desk decides, not the timer.
--    "Permanent delete" is a tombstone (`deleted_at`) plus revoked sessions, the same
--    shape every other record in this system takes. Invoices, audit rows and cargo files
--    stay: a company that violated its terms is precisely the company whose papers must
--    survive it.
--
-- Posture: no new permission key (005 already seeds `control.tenants.manage`, and nothing
-- in the code has ever checked it — this file makes it the gate). Reads and writes on the
-- register go through SECURITY DEFINER functions in platform_auth; the table itself gets
-- RLS with no policies and no grants to app_runtime, so the register cannot be reached
-- from a handler at all.

begin;

-- ============================================================
-- 1. manual_activate — the rung you are sold is the licence you get
-- ============================================================
--
-- Re-declared whole: create or replace cannot edit one expression of a plpgsql body.
-- Everything below is 068 verbatim except the `seats_licensed` line and its comment.

drop function if exists platform_auth.manual_activate(uuid, text, text, text, text, numeric, uuid, text);
create or replace function platform_auth.manual_activate(
  p_tenant_id uuid,
  p_plan_key text,
  p_billing_cycle text,
  p_provider text,
  p_provider_txn_id text,
  p_amount_override numeric,
  p_actor uuid,
  p_service_group_key text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_plan plans%rowtype;
  v_group service_groups%rowtype;
  v_total numeric;
  v_subtotal numeric;
  v_vat numeric;
  v_seats int;
  v_period_end timestamptz;
  v_subscription_id uuid;
  v_invoice_id uuid;
  v_number text;
  v_reference text;
  v_extending boolean;
  v_prev_expiry timestamptz;
begin
  if p_billing_cycle not in ('monthly','quarterly','annual') then
    return jsonb_build_object('status','invalid','message','Invalid billing cycle');
  end if;
  if p_provider not in ('azampesa','mpesa','tigopesa','airtel','halopesa','bank') then
    return jsonb_build_object('status','invalid','message','Invalid payment channel');
  end if;
  if p_service_group_key is not null then
    select * into v_group from service_groups
     where key = p_service_group_key and is_active = true limit 1;
    if not found then
      return jsonb_build_object('status','invalid','message','WAISHA package unavailable');
    end if;
  end if;
  if p_service_group_key is null and p_plan_key is null then
    return jsonb_build_object('status','invalid','message','Choose a package or a plan');
  end if;

  if p_plan_key is not null then
    select * into v_plan from plans where key = p_plan_key and is_active = true limit 1;
    if not found then return jsonb_build_object('status','invalid','message','Plan unavailable'); end if;
  else
    -- The bundle carries the price; the rung only has to be wide enough for the
    -- seats, because seats_licensed is what the licence gate actually reads.
    select * into v_plan from plans
     where is_active = true and seat_limit >= v_group.seat_limit
     order by seat_limit asc limit 1;
    if not found then
      select * into v_plan from plans where is_active = true
       order by seat_limit desc limit 1;
    end if;
    if v_plan.id is null then
      return jsonb_build_object('status','invalid','message','No plan available to license');
    end if;
  end if;

  select licence_expires_at into v_prev_expiry from tenants
   where id = p_tenant_id and deleted_at is null and type <> 'seeker';
  if not found then return jsonb_build_object('status','not_found'); end if;

  v_extending := v_prev_expiry is not null and v_prev_expiry > now();
  v_period_end := (case when v_extending then v_prev_expiry else now() end)
                  + make_interval(months => case p_billing_cycle
                      when 'quarterly' then 3 when 'annual' then 12 else 1 end);

  v_subtotal := case p_billing_cycle
    when 'quarterly' then coalesce(v_group.price_quarterly, v_plan.price_quarterly)
    when 'annual'    then coalesce(v_group.price_annual,    v_plan.price_annual)
    else                  coalesce(v_group.price_monthly,   v_plan.price_monthly) end;
  if p_amount_override is not null and p_amount_override > 0 then
    v_total := round(p_amount_override, 2);
    v_subtotal := round(v_total / (1 + v_plan.vat_rate), 2);
  else
    v_total := round(v_subtotal * (1 + v_plan.vat_rate), 2);
  end if;
  v_vat := round(v_total - v_subtotal, 2);

  -- A ladder re-activation never cuts the seats a company already holds: taking a
  -- company back to the rung's seat_limit mid-term would lock out staff the office has
  -- already sold. But it no longer *keeps* a smaller number than the rung it just sold
  -- either (#127): the old `nullif(seats_licensed, 0)` let the legacy 1 stamped by
  -- 010/011 outrank Enterprise's 100 forever. greatest() reads both ways — what the
  -- company holds and what it just paid for — and licenses the larger of the two.
  -- A bundle still sets the seats it sells.
  update subscriptions set plan_id = v_plan.id, billing_cycle = p_billing_cycle,
      status = 'active',
      seats_licensed = coalesce(v_group.seat_limit,
                                greatest(nullif(seats_licensed, 0), v_plan.seat_limit)),
      service_group_id = v_group.id,
      current_period_start = now(), current_period_end = v_period_end
   where tenant_id = p_tenant_id and deleted_at is null
   returning id into v_subscription_id;
  if v_subscription_id is null then
    -- A first sale licenses the rung the customer was just invoiced for. One seat on
    -- an Enterprise sale is not a conservative default, it is a broken licence.
    insert into subscriptions (tenant_id, plan_id, service_group_id, billing_cycle, status,
      seats_licensed, current_period_start, current_period_end)
    values (p_tenant_id, v_plan.id, v_group.id, p_billing_cycle, 'active',
      coalesce(v_group.seat_limit, v_plan.seat_limit, 1), now(), v_period_end)
    returning id into v_subscription_id;
  end if;

  -- Read the licence back rather than guess it, so the invoice states the seats the
  -- company actually holds after this sale.
  select s.seats_licensed into v_seats from subscriptions s where s.id = v_subscription_id;

  v_number := 'INV-' || to_char(now(), 'YYYY') || '-' ||
              lpad(nextval('invoice_number_seq')::text, 6, '0');
  v_reference := 'MAN-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 12));

  insert into invoices (tenant_id, subscription_id, number, billing_cycle, seats,
    amount_subtotal, vat_rate, vat_amount, amount_total, status, period_start, period_end,
    paid_at)
  values (p_tenant_id, v_subscription_id, v_number, p_billing_cycle, v_seats,
    v_subtotal, v_plan.vat_rate, v_vat, v_total, 'paid',
    current_date, v_period_end::date, now())
  returning id into v_invoice_id;

  insert into payments (tenant_id, invoice_id, provider, provider_txn_id,
    intent_reference, amount, currency, status, idempotency_key, completed_at)
  values (p_tenant_id, v_invoice_id, p_provider, p_provider_txn_id,
    v_reference, v_total, 'TZS', 'approved',
    gen_random_uuid()::text, now());

  update tenants set status = 'active', licence_expires_at = v_period_end
   where id = p_tenant_id;

  insert into audit_logs (tenant_id, actor_user_id, entity, entity_id, action, after)
  values (p_tenant_id, p_actor, 'tenants', p_tenant_id, 'licence.manually_activated',
    jsonb_build_object(
      'mode', case when v_extending then 'extend' else 'activate' end,
      'bundle', v_group.key, 'plan', v_plan.key, 'cycle', p_billing_cycle,
      'seats', v_seats,
      'provider', p_provider, 'provider_txn_id', p_provider_txn_id,
      'reference', v_reference,
      'subtotal', v_subtotal, 'vat', v_vat, 'total', v_total,
      'previous_expiry', v_prev_expiry, 'new_expiry', v_period_end,
      'invoice', v_number));

  return jsonb_build_object('status','ok',
    'mode', case when v_extending then 'extend' else 'activate' end,
    'bundle', v_group.key, 'plan', v_plan.key, 'seats', v_seats,
    'invoice_number', v_number, 'reference', v_reference, 'total', v_total,
    'licence_expires_at', v_period_end);
end $$;

-- ============================================================
-- 2. the companies already stuck under the rung they bought
-- ============================================================
--
-- Up only, and audited, so the desk can see that the platform moved a licence without
-- anybody buying it. A bundle row is skipped: those seats were sold on purpose.

with stuck as (
  select s.id as subscription_id, s.tenant_id, s.seats_licensed as was, p.seat_limit as becomes
    from subscriptions s
    join plans p on p.id = s.plan_id
    join tenants t on t.id = s.tenant_id and t.deleted_at is null
   where s.deleted_at is null
     and s.status in ('active','grace')
     and s.service_group_id is null
     and s.seats_licensed > 0
     and s.seats_licensed < p.seat_limit
), fixed as (
  update subscriptions s
     set seats_licensed = k.becomes, updated_at = now()
    from stuck k
   where s.id = k.subscription_id
  returning s.id
)
insert into audit_logs (id, tenant_id, actor_role, entity, entity_id, action, before, after)
select gen_random_uuid(), k.tenant_id, 'system', 'tenants', k.tenant_id,
       'licence.seats_repaired',
       jsonb_build_object('seats_licensed', k.was),
       jsonb_build_object('seats_licensed', k.becomes, 'why',
                          '078: a paid rung licenses at least its own seats')
  from stuck k
  join fixed f on f.id = k.subscription_id;

-- ============================================================
-- 3. the register
-- ============================================================

create table if not exists tenant_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  action text not null
    check (action in ('block','unblock','close','notice')),
  -- Why, as a code the desk can count on, and as the sentence the company is sent.
  -- The code is what turns the next twelve of these into a pattern; the note is what
  -- makes this one defensible to the person reading the SMS.
  reason_code text not null default 'other'
    check (reason_code in ('terms_violation','long_idle','payment_default','abuse',
                           'complaint','security','other')),
  note text not null check (char_length(trim(note)) between 8 and 600),
  -- The status as found, so an unblock can put the company back where it was rather
  -- than guessing 'active' for a licence that lapsed while it was blocked.
  prior_status text,
  new_status text,
  seats_licensed int,
  actor_kind text not null default 'control' check (actor_kind in ('control','system')),
  actor_user_id uuid references users(id),
  actor_role text,
  actor_ip text,
  -- Filled once, by tenant_action_receipt, from the send that actually happened.
  -- Masked contacts and counts only — the register is read by whoever opens the desk.
  delivery jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index tenant_actions_tenant_created on tenant_actions (tenant_id, created_at desc);
create index tenant_actions_unblock on tenant_actions (tenant_id, created_at desc)
  where action = 'unblock';
create index tenant_actions_block on tenant_actions (tenant_id, created_at desc)
  where action = 'block';

alter table tenant_actions enable row level security;
-- Deliberately no policy and no table grant: the register is reachable only through the
-- definer functions in section 4. Nothing a handler writes can be a company's record of
-- why it was blocked.
revoke all on tenant_actions from public, anon, authenticated, app_runtime;

-- ============================================================
-- 4. the doors
-- ============================================================

-- One statement path for a human on the desk and for the idle sweep, so the register,
-- the audit row, the session revoke and the notice list are the same in both cases.
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
    null;   -- the tombstone is the state; the status is left as found for the record
  end if;

  if p_action in ('block','unblock') then
    update tenants set status = v_new, updated_at = now(), updated_by = p_actor_user_id
     where id = v_t.id;
  elsif p_action = 'close' then
    update tenants set deleted_at = now(), updated_at = now(), updated_by = p_actor_user_id
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

-- The receipt is written once, against a row whose delivery is still empty. A recorded
-- notice cannot be rewritten afterwards, which is the only thing that makes an
-- append-only register worth having.
create or replace function platform_auth.tenant_action_receipt(
  p_action_id uuid, p_delivery jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_rows int;
begin
  if jsonb_typeof(p_delivery) <> 'object' then
    return jsonb_build_object('status','invalid');
  end if;
  update tenant_actions set delivery = p_delivery
   where id = p_action_id and delivery = '{}'::jsonb;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('status', case when v_rows = 1 then 'ok' else 'noop' end);
end $$;

-- The idle policy, as a question rather than a mutation: who needs an action, given the
-- two windows the office set (1.5 months to block, 3 months to close).
create or replace function platform_auth.tenant_policy_candidates(
  p_block_days int, p_close_days int)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(json_build_object(
           'tenant_id', y.id, 'name', y.name, 'action', y.action,
           'days_idle', y.days_idle, 'lapsed_at', y.lapsed_at)
         order by y.days_idle desc), '[]'::jsonb)
  from (
    select t.id, t.name, y0.lapsed_at,
           floor(extract(epoch from (now() - y0.lapsed_at)) / 86400)::int as days_idle,
           case
             when extract(epoch from (now() - y0.lapsed_at)) / 86400 >= p_close_days then 'close'
             when extract(epoch from (now() - y0.lapsed_at)) / 86400 >= p_block_days
                  and t.status <> 'suspended' then 'block'
           end as action
    from tenants t
    left join subscriptions s on s.tenant_id = t.id and s.deleted_at is null
    cross join lateral (
      select coalesce(greatest(t.licence_expires_at, s.current_period_end),
                      t.licence_expires_at, s.current_period_end,
                      t.trial_ends_at, t.created_at) as lapsed_at) y0
    where t.deleted_at is null
      and t.type in ('transporter','shipper')
      -- A company that never finished verifying has not gone idle, it never arrived;
      -- onboarding owns those, and nothing here should delete them on a clock.
      and t.status <> 'pending_verification'
      -- A person who unblocked this company decided it stays open. The clock is then
      -- measured from that decision, not from a lapse the desk has already waived.
      and not exists (
        select 1 from tenant_actions a
         where a.tenant_id = t.id and a.action = 'unblock'
           and a.created_at > y0.lapsed_at)
  ) y
  where y.action is not null;
$$;

-- The desk's history for one company, newest first, receipt included.
create or replace function platform_auth.control_tenant_actions(p_tenant_id uuid, p_limit int)
returns jsonb language sql security definer set search_path = public as $$
  select coalesce(jsonb_agg(json_build_object(
           'id', a.id, 'action', a.action, 'reason_code', a.reason_code, 'note', a.note,
           'prior_status', a.prior_status, 'new_status', a.new_status,
           'seats_licensed', a.seats_licensed, 'actor_kind', a.actor_kind,
           'actor_role', a.actor_role, 'delivery', a.delivery, 'created_at', a.created_at)
         order by a.created_at desc), '[]'::jsonb)
  from (select * from tenant_actions
         where tenant_id = p_tenant_id
         order by created_at desc limit least(coalesce(p_limit, 20), 50)) a;
$$;

-- The live state of a block, asked by the login path and by the per-request gate.
-- NULL means the company is open for business.
create or replace function platform_auth.tenant_block_state(p_tenant_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select case
    when t.status <> 'suspended' then null
    else jsonb_build_object(
      'reason_code', coalesce(b.reason_code, 'other'),
      'note', coalesce(b.note, 'Blocked by the WAISHA office.'),
      'since', b.created_at, 'by', coalesce(b.actor_kind, 'control'))
    end
  from tenants t
  left join lateral (
    select a.reason_code, a.note, a.created_at, a.actor_kind
      from tenant_actions a
     where a.tenant_id = t.id and a.action = 'block'
     order by a.created_at desc limit 1) b on true
  where t.id = p_tenant_id and t.deleted_at is null;
$$;

-- ============================================================
-- 5. the desk list, with the seats and the block visible
-- ============================================================
--
-- The column list only grows (control.routes.ts reads `select *`), so nothing else has
-- to change. plan_seats next to seats_licensed is what makes the bug in section 1
-- readable by eye instead of by a probe, and members is the number the desk is about to
-- refuse to raise.
-- A wider OUT record cannot be put over an existing function, so the old one goes first.
drop function if exists platform_auth.list_tenants_for_control(text);
create or replace function platform_auth.list_tenants_for_control(p_search text)
returns table (
  tenant_id uuid, name text, tenant_type text, status text,
  trial_ends_at timestamptz, licence_expires_at timestamptz,
  subscription_status text, plan_name text, plan_key text, plan_seats int,
  seats_licensed int, members int, blocked_reason text, blocked_note text,
  blocked_since timestamptz, created_at timestamptz
) language sql security definer set search_path = public as $$
  select t.id, t.name, t.type, t.status,
         t.trial_ends_at, t.licence_expires_at,
         s.status, p.name, p.key, p.seat_limit,
         s.seats_licensed,
         (select count(*)::int from users u
           where u.tenant_id = t.id and u.deleted_at is null
             and u.user_type in ('director','staff')),
         case when t.status = 'suspended' then b.reason_code end,
         case when t.status = 'suspended' then b.note end,
         case when t.status = 'suspended' then b.created_at end,
         t.created_at
  from tenants t
  left join subscriptions s on s.tenant_id = t.id and s.deleted_at is null
  left join plans p on p.id = s.plan_id
  left join lateral (
    select a.reason_code, a.note, a.created_at from tenant_actions a
     where a.tenant_id = t.id and a.action = 'block'
     order by a.created_at desc limit 1) b on true
  where t.deleted_at is null
    and t.type not in ('platform','seeker')
    and (p_search is null or t.name ilike '%' || p_search || '%')
  order by t.created_at desc
  limit 200;
$$;

-- ============================================================
-- 6. permissions: the key 005 seeded and nothing ever checked
-- ============================================================
--
-- super_admin already holds control.tenants.manage (005's cross join). It is granted to
-- compliance_officer as well, with the floor read that lets the role reach the screen at
-- all: blocking a company for a terms violation is that seat's job, and it is not the
-- billing seat's — billing_admin keeps the sale door and does not get this one.
insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r
cross join (select 'control.tenants.manage'::text as key
           union select 'control.view') p
where r.tenant_id is null and r.key = 'compliance_officer'
on conflict do nothing;

-- ============================================================
-- 7. grants
-- ============================================================

grant execute on function
  platform_auth.manual_activate(uuid, text, text, text, text, numeric, uuid, text),
  platform_auth.tenant_apply_action(uuid, text, text, text, text, uuid, text, text),
  platform_auth.tenant_action_receipt(uuid, jsonb),
  platform_auth.tenant_policy_candidates(int, int),
  platform_auth.control_tenant_actions(uuid, int),
  platform_auth.tenant_block_state(uuid),
  platform_auth.list_tenants_for_control(text)
to app_runtime;

-- Same sweep 060, 066, 068 and 070 had to run: a new function belongs to PUBLIC until
-- told otherwise.
revoke all on function
  platform_auth.tenant_apply_action(uuid, text, text, text, text, uuid, text, text),
  platform_auth.tenant_action_receipt(uuid, jsonb),
  platform_auth.tenant_policy_candidates(int, int),
  platform_auth.control_tenant_actions(uuid, int),
  platform_auth.tenant_block_state(uuid)
from public, anon, authenticated, service_role;

commit;
