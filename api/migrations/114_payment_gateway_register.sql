-- 114: the payment gateway register — the desk where the platform turns a money rail on (#283)
--
-- Until now a gateway was an environment variable. `getProvider()` read `PAYMENT_PROVIDER` and
-- built an AzamPay client from three more env keys, which meant that switching on M-Pesa needed
-- someone with shell access to edit `api/.env` and restart the API — for a decision that is not a
-- deployment decision at all, but a commercial one the office makes when a contract is signed.
-- The user's ask is the plain version of that: "I can enter the credential in admin panel, then
-- activate it and the system work."
--
-- So this table is the source of truth and `.env` becomes the fallback it should have been:
-- `PAYMENT_PROVIDER` still answers when the register is empty, so nothing that works today
-- changes on deploy, and a platform that has never opened the desk keeps running on mock.
--
-- **One active rail, not a list of them.** `payments.provider` records which network a customer's
-- number belongs to (`detectProvider`, amounts.ts) — that is a label on a row, not a routing
-- decision, and there is no code today that can push to four networks at once. Enabling a second
-- rail therefore turns the first off, and the partial unique index below is what makes that a
-- fact of the schema rather than a promise made by whichever route remembered to check.
--
-- **`adapter` is the honesty column.** A rail with `adapter = 'none'` has nowhere to send its
-- credentials: the M-Pesa, Airtel, Tigo Pesa and Halo rails are seeded here because the office
-- will be asked for them, but `set_payment_gateway_enabled` refuses to activate one until the
-- HTTP adapter exists in `src/payments/`. Without that column, a desk that accepts credentials
-- for four rails and silently keeps using mock is worse than a desk with one real rail — it
-- tells the person who signed the contract that the money path is open when it is not.
--
-- **Secrets never leave the database in plaintext and never sit in it as text.** The two
-- credential columns are `bytea` holding `encryptField()`'s AES-256-GCM blob (iv|tag|ct), the
-- same shape NIDA numbers and driver phones already use, so the key that unlocks them is
-- `FIELD_ENCRYPTION_KEY` and not a column someone can `select`. What the list reader gets instead
-- is `credential_hint` — a few masked characters the API computed at save time — which is enough
-- to tell two saved keys apart and not enough to use one.
--
-- **No tenant_id, because this is not a tenant's thing.** The platform decides which rail every
-- company is charged through. RLS is still switched on and every grant revoked, including from
-- `app_runtime`: the API connects as a BYPASSRLS role (see the note in 082), so a revoke is the
-- only statement here that actually restricts anything, and the doors are the definer functions
-- below — each of which decides for itself what it hands out.
begin;

-- ============================================================
-- 1. the register
-- ============================================================

create table if not exists payment_gateways (
  provider_key text primary key check (provider_key ~ '^[a-z0-9_]{2,32}$'),
  label text not null,
  -- Which piece of code can actually drive this rail. 'none' means the credentials are filed
  -- but nothing will send them; activation refuses such a row.
  adapter text not null default 'none' check (adapter in ('none','azampay')),
  base_url text,
  environment text not null default 'sandbox' check (environment in ('sandbox','live')),
  credentials_encrypted bytea,
  webhook_secret_encrypted bytea,
  -- Masked by the API on write. Safe to show a room full of staff; useless to anyone else.
  credential_hint text,
  config jsonb not null default '{}'::jsonb,
  enabled boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  -- The last thing the desk learned by trying: {at, ok, detail}. A check that was never run and
  -- a check that failed look different on screen, and the difference is the whole point.
  last_check jsonb,
  constraint payment_gateways_url_shape check (
    base_url is null or (base_url ~ '^https://' and base_url !~ '\\s' and char_length(base_url) <= 200)
  )
);

-- At most one rail is live at a time. Every row this index covers has `enabled` = true by the
-- predicate, so uniqueness is on the constant: a second activate has somewhere to fail.
create unique index payment_gateways_single_active on payment_gateways (enabled) where enabled;

alter table payment_gateways enable row level security;
revoke all on payment_gateways from public, anon, authenticated, service_role, app_runtime;

comment on column payment_gateways.credentials_encrypted is
  'AES-256-GCM blob (iv|tag|ct) of the rail''s JSON credentials. Decrypted only in the API''s own memory, never returned by a list function.';
comment on column payment_gateways.webhook_secret_encrypted is
  'The shared secret an inbound provider call is HMAC-verified against. Same blob shape as credentials_encrypted.';
comment on column payment_gateways.adapter is
  '''none'' = credentials filed, no code to use them. Activation is refused for such a row.';

-- ============================================================
-- 2. the rails, seeded
-- ============================================================
--
-- Keys are exactly the words `detectProvider()` already returns, so a payment row that says
-- 'mpesa' and a register row that says 'mpesa' are the same thing. `on conflict do nothing`
-- everywhere: this file runs on every deploy, and a rail the office switched on must never be
-- switched back off by a re-run.

insert into payment_gateways (provider_key, label, adapter) values
  ('mpesa',     'Vodacom M-Pesa',            'none'),
  ('airtel',    'Airtel Money',              'none'),
  ('tigopesa',  'Tigo Pesa (ExaTelecoms)',   'none'),
  ('halopesa',  'Asante Halo Pesa',          'none'),
  ('azampesa',  'AzamPay / Azam Pesa',       'azampay')
on conflict (provider_key) do nothing;

-- ============================================================
-- 3. readers
-- ============================================================

-- Everything the desk shows, and nothing it must not show.
create or replace function platform_auth.list_payment_gateways()
returns table (
  provider_key text, label text, adapter text, base_url text, environment text,
  enabled boolean, has_credentials boolean, has_webhook_secret boolean,
  credential_hint text, config jsonb, updated_at timestamptz, last_check jsonb)
language sql stable security definer set search_path = public as $$
  select g.provider_key, g.label, g.adapter, g.base_url, g.environment,
         g.enabled,
         g.credentials_encrypted is not null,
         g.webhook_secret_encrypted is not null,
         g.credential_hint, g.config, g.updated_at, g.last_check
    from payment_gateways g
   order by g.enabled desc, g.provider_key
 $$;

-- The one row the money path drives. Returns the encrypted blobs because the only caller is the
-- API, which holds the key; no route hands this result to a browser.
create or replace function platform_auth.active_payment_gateway()
returns table (provider_key text, adapter text, base_url text, environment text,
               credentials bytea, webhook_secret bytea, config jsonb)
language sql stable security definer set search_path = public as $$
  select g.provider_key, g.adapter, g.base_url, g.environment,
         g.credentials_encrypted, g.webhook_secret_encrypted, g.config
    from payment_gateways g
   where g.enabled
   limit 1
 $$;

-- The same shape for a rail named by the caller, whether or not it is live. The desk needs this
-- to try credentials before it switches anything on — "activate it and then find out it was
-- typed wrong" is not a way to discover a typo about somebody's money.
create or replace function platform_auth.payment_gateway_secrets(p_key text)
returns table (provider_key text, adapter text, base_url text, environment text,
               credentials bytea, webhook_secret bytea, config jsonb)
language sql stable security definer set search_path = public as $$
  select g.provider_key, g.adapter, g.base_url, g.environment,
         g.credentials_encrypted, g.webhook_secret_encrypted, g.config
    from payment_gateways g
   where g.provider_key = p_key
 $$;

-- ============================================================
-- 4. writers
-- ============================================================
--
-- Presence-based, like the drivers PUT: a null credential column means "leave what is saved
-- saved". The desk re-saves a form whose secret field is deliberately blank — the operator is
-- changing the base URL, not the key — and a writer that read blank as empty would silently
-- unlock a working gateway.

create or replace function platform_auth.upsert_payment_gateway(
  p_key text,
  p_label text,
  p_base_url text,
  p_credentials bytea,
  p_webhook_secret bytea,
  p_hint text,
  p_config jsonb,
  p_environment text,
  p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_adapter text;
begin
  if p_key is null or p_key !~ '^[a-z0-9_]{2,32}$' then
    return jsonb_build_object('status', 'error', 'code', 'BAD_KEY');
  end if;
  if p_environment is not null and p_environment not in ('sandbox','live') then
    return jsonb_build_object('status', 'error', 'code', 'BAD_ENVIRONMENT');
  end if;
  -- https, no spaces, sane length: the same shape the column check enforces, said here first so
  -- the answer is a code and not a 500 with a constraint name in it.
  if p_base_url is not null
     and (p_base_url !~ '^https://' or p_base_url ~ '\s' or char_length(p_base_url) > 200) then
    return jsonb_build_object('status', 'error', 'code', 'BAD_BASE_URL');
  end if;
  if p_hint is not null and char_length(p_hint) > 40 then
    return jsonb_build_object('status', 'error', 'code', 'BAD_HINT');
  end if;

  select adapter into v_adapter from payment_gateways where provider_key = p_key;
  if v_adapter is null then
    -- A rail nobody seeded. It has no adapter by definition, so it may be filed but never run.
    insert into payment_gateways (provider_key, label, adapter)
      values (p_key, coalesce(nullif(trim(p_label), ''), initcap(p_key)), 'none')
      on conflict (provider_key) do nothing;
    v_adapter := 'none';
  end if;

  update payment_gateways set
    label      = coalesce(nullif(trim(p_label), ''), label),
    base_url   = coalesce(p_base_url, base_url),
    environment = coalesce(p_environment, environment),
    -- A caller that sends bytes replaces them; one that sends nothing keeps what is there.
    credentials_encrypted    = coalesce(p_credentials, credentials_encrypted),
    webhook_secret_encrypted = coalesce(p_webhook_secret, webhook_secret_encrypted),
    credential_hint = coalesce(p_hint, credential_hint),
    config     = coalesce(p_config, config),
    updated_by = p_actor,
    updated_at = now()
   where provider_key = p_key;

  return jsonb_build_object('status', 'ok', 'provider_key', p_key, 'adapter', v_adapter);
end $$;

-- The switch itself. Note what it refuses: a rail with no code behind it, and a rail with no
-- credentials to send. Both would look identical to the operator until a customer tried to pay.
create or replace function platform_auth.set_payment_gateway_enabled(
  p_key text, p_enabled boolean, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ declare
  v_row record;
  v_was text;
begin
  if p_key is null or p_enabled is null then
    return jsonb_build_object('status', 'error', 'code', 'BAD_INPUT');
  end if;
  select * into v_row from payment_gateways where provider_key = p_key;
  if not found then return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND'); end if;

  if p_enabled then
    if v_row.adapter = 'none' then
      return jsonb_build_object('status', 'error', 'code', 'NO_ADAPTER',
        'provider_key', p_key, 'label', v_row.label);
    end if;
    if v_row.credentials_encrypted is null then
      return jsonb_build_object('status', 'error', 'code', 'NO_CREDENTIALS',
        'provider_key', p_key, 'label', v_row.label);
    end if;
    if v_row.base_url is null then
      return jsonb_build_object('status', 'error', 'code', 'NO_BASE_URL',
        'provider_key', p_key, 'label', v_row.label);
    end if;
    select provider_key into v_was from payment_gateways where enabled;
    update payment_gateways set enabled = false, updated_by = p_actor, updated_at = now()
      where enabled and provider_key <> p_key;
  end if;

  -- The switch, with the schema's own backstop translated. `payment_gateways_single_active`
  -- refuses a second live rail no matter which caller forgot to ask, and a 500 carrying a
  -- constraint name is a bad way to tell a desk that another rail is already on.
  begin
    update payment_gateways set enabled = p_enabled, updated_by = p_actor, updated_at = now()
      where provider_key = p_key;
  exception when unique_violation then
    if p_enabled then
      return jsonb_build_object('status', 'error', 'code', 'ALREADY_LIVE', 'provider_key', p_key);
    end if;
    raise;
  end;

  return jsonb_build_object('status', 'ok', 'provider_key', p_key, 'enabled', p_enabled,
                            'deactivated', nullif(v_was, ''));
end $$;

-- The result of trying the rail, kept on the row so the desk can say "last checked, and what it
-- said" instead of only "configured".
create or replace function platform_auth.record_gateway_check(
  p_key text, p_check jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$ begin
  if p_key is null or p_check is null or jsonb_typeof(p_check) <> 'object' then
    return jsonb_build_object('status', 'error', 'code', 'BAD_INPUT');
  end if;
  update payment_gateways
     set last_check = jsonb_build_object(
         'at', now(),
         -- Cast guarded rather than bare: `::boolean` on whatever a caller put in "ok" would
         -- raise, and a failed check that cannot be recorded is a failed check nobody sees.
         'ok', coalesce(case when p_check->>'ok' in ('true','false')
                             then (p_check->>'ok')::boolean end, false),
         'detail', left(coalesce(p_check->>'detail', ''), 300))
   where provider_key = p_key;
  if not found then return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('status', 'ok');
end $$;

-- Wipe a rail back to filed-and-empty. The row stays — the five rails are the rails Tanzania
-- has, and a desk that can lose them permanently is a desk that needs a migration to get them
-- back. What goes is every secret and the switch.
create or replace function platform_auth.clear_payment_gateway(p_key text, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$ begin
  if p_key is null then return jsonb_build_object('status', 'error', 'code', 'BAD_INPUT'); end if;
  update payment_gateways
     set credentials_encrypted = null, webhook_secret_encrypted = null, credential_hint = null,
         base_url = null, config = '{}'::jsonb, enabled = false,
         updated_by = p_actor, updated_at = now()
   where provider_key = p_key;
  if not found then return jsonb_build_object('status', 'error', 'code', 'NOT_FOUND'); end if;
  return jsonb_build_object('status', 'ok', 'provider_key', p_key);
end $$;

-- ============================================================
-- 5. grants
-- ============================================================

grant execute on function
  platform_auth.list_payment_gateways(),
  platform_auth.active_payment_gateway(),
  platform_auth.payment_gateway_secrets(text),
  platform_auth.upsert_payment_gateway(text, text, text, bytea, bytea, text, jsonb, text, uuid),
  platform_auth.set_payment_gateway_enabled(text, boolean, uuid),
  platform_auth.record_gateway_check(text, jsonb),
  platform_auth.clear_payment_gateway(text, uuid)
to app_runtime;

-- The sweep every new definer needs (051, 060, 066, 068, 070, 079, 082, 112): a fresh function is
-- executable by PUBLIC until told otherwise, and these read and write the credentials that move
-- real money.
revoke all on function
  platform_auth.list_payment_gateways(),
  platform_auth.active_payment_gateway(),
  platform_auth.payment_gateway_secrets(text),
  platform_auth.upsert_payment_gateway(text, text, text, bytea, bytea, text, jsonb, text, uuid),
  platform_auth.set_payment_gateway_enabled(text, boolean, uuid),
  platform_auth.record_gateway_check(text, jsonb),
  platform_auth.clear_payment_gateway(text, uuid)
from public, anon, authenticated, service_role;

-- ============================================================
-- 6. the two duties
-- ============================================================
--
-- Reading the register is wider than writing it. A support seat that cannot see which rail is
-- live cannot answer "my customer paid and nothing happened", but nobody but the platform owner
-- should decide which company's money flows through which network — so `.manage` is deliberately
-- super_admin alone, which is also the only seat that can read the pasted credentials back off a
-- form the operator filled in.

insert into permissions (key, description) values
  ('control.gateway.view',
   'Control - Read which payment rails are filed, checked and live'),
  ('control.gateway.manage',
   'Control - Enter gateway credentials, activate a rail and clear one')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.gateway.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','support_engineer','platform_analyst')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'control.gateway.manage'
  from roles r
 where r.tenant_id is null and r.key = 'super_admin'
on conflict do nothing;

do $$ declare
  v_rails int;
  v_live text;
begin
  select count(*)::int into v_rails from payment_gateways;
  select coalesce(string_agg(provider_key, ', '), 'none — the API answers from PAYMENT_PROVIDER')
    into v_live from payment_gateways where enabled;
  raise notice '114: gateway register open — % rail(s), live rail: %', v_rails, v_live;
end $$;

commit;
