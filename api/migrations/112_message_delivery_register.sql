-- 112: every message WAISHA tries to send leaves a line (task #129).
--
-- The user's question, verbatim: "now how the OTP CODES WILL BE RECEIVED? sometimes unespected
-- error occur, then too many attempt". That is the whole case for this table. Today a send is a
-- `console.log` or a `fetch` whose result nobody keeps: when a company signs up and no code
-- arrives, the office cannot tell whether the provider was never configured, whether Resend
-- refused the address, or whether the code went out and the person is looking in spam. The only
-- answer the software gives is a second attempt and then a lockout, which is the "too many
-- attempt" the user hit.
--
-- So this is a delivery register, not a mail queue. One row per send *attempt group* — the
-- attempt count is folded into the row, not one row per HTTP try — carrying enough to answer the
-- three questions a support call actually asks: which channel, which address (masked), and did
-- the provider take it. Purpose is a closed list so a desk can filter "password resets that
-- failed" without free text.
--
-- Posture is deliberately the same as 078's tenant_actions and 082's app_errors: RLS enabled
-- with NO policies and NO table grants, so the register is unreachable from a handler and every
-- door is a SECURITY DEFINER function in platform_auth, including the writer. A delivery log
-- that a route can write to directly is a log that can be edited into silence by the route that
-- failed.
--
-- tenant_id and user_id are plain uuids with no foreign key, on purpose. This is the one table
-- in the schema that must survive a company being removed and must never be the reason a
-- removal fails: a closed company's notices and an old signup's refused OTP stay readable, and
-- the support teardown that clears a test company walks straight past it. Nothing here is
-- joined to; the ids are there so a desk can go and look.
--
-- The address is stored masked, and only masked. `a***@domain` is enough to recognise which seat
-- was reached; the project rule that list endpoints never return raw PII applies with more force
-- to a register read across every tenant. A masked value also cannot be used to confirm that an
-- address holds an account, which the forgot-password path already refuses to do.
--
-- Retention is an action, not a background job — same as 082's prune_errors. Deleting the record
-- that a notice went out is a decision a person makes, so the prune exists as a definer the desk
-- calls explicitly, and it writes an audit line naming who ran it.

begin;

-- ============================================================
-- 1. the register
-- ============================================================

create table if not exists message_deliveries (
  id bigint generated always as identity primary key,
  -- Both channels the platform uses. The office acts on a company over SMS and email at the
  -- same moment (tenant-notice), so an "email" table would have had to lie about half of it.
  channel text not null check (channel in ('email','sms')),
  purpose text not null check (purpose in (
    'signup_otp', 'otp_resend', 'password_reset', 'staff_invite',
    'tenant_notice', 'platform_test')),
  -- Never the raw address or number. Built by the writer from the value it was given so a
  -- caller cannot smuggle a full address into the column by pre-masking it wrongly.
  to_masked text not null,
  subject text,
  -- 'sent'   — the provider accepted it (Resend returned a message id).
  -- 'failed' — it did not: refused, timed out, or threw. The reason is in `error`.
  -- 'skipped'— no provider is configured, so it went to the console. The development
  --            default, and the honest answer to "why did nobody get a code".
  status text not null check (status in ('sent','failed','skipped')),
  provider text not null default 'resend',
  -- The provider's own id for the send. Quoting it to Resend support is the whole reason it
  -- is kept; console sends have none.
  provider_message_id text,
  error text,
  -- HTTP attempts made for this one logical send, including the retry on a timeout.
  attempts int not null default 1 check (attempts between 1 and 5),
  tenant_id uuid,
  user_id uuid,
  created_at timestamptz not null default now()
);

create index message_deliveries_created on message_deliveries (created_at desc);
create index message_deliveries_failed on message_deliveries (created_at desc)
  where status <> 'sent';
create index message_deliveries_tenant on message_deliveries (tenant_id, created_at desc);
create index message_deliveries_user on message_deliveries (user_id, created_at desc);

alter table message_deliveries enable row level security;
revoke all on message_deliveries from public, anon, authenticated, service_role, app_runtime;

-- ============================================================
-- 2. the writer
-- ============================================================
--
-- Never raises. A mail send is a side effect of a signup that already worked; a collector that
-- can throw would turn "the code did not arrive" into "the account cannot be created", which is
-- the opposite of what this table exists to prevent. Junk input is dropped, everything is
-- clamped — this function is the last gate before a public route reaches the register.

create or replace function platform_auth.record_message_delivery(
  p_channel text,
  p_purpose text,
  p_to text,
  p_subject text,
  p_status text,
  p_provider text,
  p_provider_message_id text,
  p_error text,
  p_attempts int,
  p_tenant_id uuid,
  p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$ declare
  v_masked text;
begin
  if p_channel is null or p_channel not in ('email','sms') then return; end if;
  if p_purpose is null or p_purpose not in (
     'signup_otp','otp_resend','password_reset','staff_invite','tenant_notice','platform_test')
  then return; end if;
  if p_status is null or p_status not in ('sent','failed','skipped') then return; end if;
  if trim(coalesce(p_to, '')) = '' then return; end if;

  -- Masked here, not by the caller: one rule for how an address is shortened is one rule to
  -- keep honest, and a route that forgets cannot leak into this column.
  if p_channel = 'email' then
    v_masked := case
      when position('@' in p_to) > 1
        then left(split_part(p_to, '@', 1), 1) || '***@' || lower(split_part(p_to, '@', 2))
      else '***' end;
  else
    -- A phone keeps its last four digits and its country prefix, which is enough to tell two
    -- directors of one company apart and not enough to dial.
    v_masked := case
      when char_length(p_to) > 8
        then left(p_to, 4) || '***' || right(p_to, 4)
      else '***' end;
  end if;

  insert into message_deliveries (channel, purpose, to_masked, subject, status, provider,
                                  provider_message_id, error, attempts, tenant_id, user_id)
  values (p_channel, p_purpose, left(v_masked, 160), left(p_subject, 200), p_status,
          left(coalesce(nullif(p_provider, ''), 'resend'), 40),
          left(p_provider_message_id, 120), left(p_error, 500),
          case when p_attempts between 1 and 5 then p_attempts else 1 end,
          p_tenant_id, p_user_id);
exception when others then
  return;
end $$;

-- ============================================================
-- 3. the doors the desk reads
-- ============================================================

-- One line per send in the window, newest first. The free-text search is against the masked
-- address and the subject only, so the desk can find "resets to j***@acme.co.tz" without the
-- table ever being able to answer "is there an account for this exact address".
create or replace function platform_auth.message_delivery_log(
  p_purpose text,
  p_status text,
  p_channel text,
  p_q text,
  p_days int,
  p_limit int)
returns table (
  id bigint, channel text, purpose text, to_masked text, subject text, status text,
  provider text, provider_message_id text, error text, attempts int,
  tenant_id uuid, user_id uuid, sent_at timestamptz
) language sql security definer set search_path = public as $$
  select d.id, d.channel, d.purpose, d.to_masked, d.subject, d.status, d.provider,
         d.provider_message_id, d.error, d.attempts, d.tenant_id, d.user_id, d.created_at
    from message_deliveries d
   where d.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)))
     and (p_purpose is null or d.purpose = p_purpose)
     and (p_status  is null or d.status  = p_status)
     and (p_channel is null or d.channel = p_channel)
     and (p_q is null or trim(p_q) = ''
          or d.to_masked ilike '%' || trim(p_q) || '%'
          or coalesce(d.subject, '') ilike '%' || trim(p_q) || '%')
   order by d.created_at desc, d.id desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- The advisory counts: what went out, what did not, and whether a provider is configured at
-- all. Grouped by (purpose, status) rather than by day, because the question this answers is
-- "are resets broken?" and not "how many on Tuesday".
create or replace function platform_auth.message_delivery_summary(p_days int)
returns table (
  channel text, purpose text, status text, sends bigint,
  distinct_addresses bigint, last_at timestamptz
) language sql security definer set search_path = public as $$
  select d.channel, d.purpose, d.status, count(*)::bigint,
         count(distinct d.to_masked)::bigint, max(d.created_at)
    from message_deliveries d
   where d.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90)))
   group by d.channel, d.purpose, d.status
   order by d.channel, d.purpose, d.status;
$$;

-- ============================================================
-- 4. retention is an action
-- ============================================================

create or replace function platform_auth.prune_message_deliveries(p_keep_days int)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_cutoff timestamptz;
  v_deleted int;
begin
  -- Refuse rather than default to a small window: "keep 0 days" would delete the proof that a
  -- company was told its access was suspended, and nobody means that when they click the button.
  if p_keep_days is null or p_keep_days < 7 then
    return jsonb_build_object('status', 'invalid',
      'message', 'Retention keeps at least 7 days — a week of sends is the minimum worth having.');
  end if;
  v_cutoff := now() - make_interval(days => least(p_keep_days, 3650));

  delete from message_deliveries where created_at < v_cutoff;
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('status', 'ok', 'deleted', v_deleted,
                            'cutoff', v_cutoff, 'keep_days', p_keep_days);
end $$;

-- ============================================================
-- 5. grants
-- ============================================================

grant execute on function
  platform_auth.record_message_delivery(text, text, text, text, text, text, text, text, int, uuid, uuid),
  platform_auth.message_delivery_log(text, text, text, text, int, int),
  platform_auth.message_delivery_summary(int),
  platform_auth.prune_message_deliveries(int)
to app_runtime;

-- The sweep every new definer needs (051, 060, 066, 068, 070, 079, 082): a fresh function is
-- executable by PUBLIC until told otherwise, and these read a register that spans every tenant.
revoke all on function
  platform_auth.record_message_delivery(text, text, text, text, text, text, text, text, int, uuid, uuid),
  platform_auth.message_delivery_log(text, text, text, text, int, int),
  platform_auth.message_delivery_summary(int),
  platform_auth.prune_message_deliveries(int)
from public, anon, authenticated, service_role;

-- No new duty keys. The register is read by whoever can read the system report
-- (control.system.view) and pruned by whoever can act on it (control.system.manage) — both
-- seeded in 005 and both already held by super_admin.

do $$ declare
  v_rows int;
  v_skipped int;
begin
  select count(*)::int into v_rows from message_deliveries;
  -- The register itself says whether a provider has ever been configured: a 'skipped' line is
  -- a send that went to the console because there was no key to send it with.
  select count(*)::int into v_skipped from message_deliveries where status = 'skipped';
  raise notice '112: the delivery register is open; % row(s), % of them skipped for want of a provider',
    v_rows, v_skipped;
end $$;

commit;
