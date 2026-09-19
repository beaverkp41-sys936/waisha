-- WAISHA Foundation. Applied by scripts/migrate.ts as the project owner role.
begin;

create extension if not exists pgcrypto;   -- digest(), hmac()
-- PostGIS is enabled from the Supabase dashboard; not required by this migration.

create schema if not exists platform_auth authorization postgres;

-- ----------------------------
-- Shared trigger: updated_at
-- ----------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin
  new.updated_at := now();
  return new;
end $$;

-- ===========
-- TENANTS
-- ===========
create table if not exists tenants (
  id            uuid primary key default gen_random_uuid(), -- UUID v7 supplied by application
  type          text not null check (type in ('transporter','shipper')),
  name          text not null check (char_length(name) between 3 and 120),
  slug          text unique,
  -- TIN stored encrypted; lookup via keyed hash (field-level encryption, spec 12)
  tin_encrypted bytea,
  tin_search    text unique,                                -- hmac(tin, SEARCH_HASH_KEY)
  status        text not null default 'pending_verification'
                check (status in ('pending_verification','trial','active','grace','expired','suspended')),
  phone_encrypted bytea,
  phone_search  text unique,
  email         text,
  trial_started_at timestamptz,
  trial_ends_at    timestamptz,
  licence_expires_at timestamptz,
  plan_id       uuid,
  seats_licensed int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
create trigger trg_tenants_updated before update on tenants
  for each row execute function public.set_updated_at();
create unique index if not exists tenants_name_tin_uq on tenants (lower(name), tin_search);

-- ===========
-- USERS
-- ===========
create table if not exists users (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  user_type  text not null check (user_type in ('platform','director','staff','driver','trainee','shipper','customer_temp')),
  email      text unique,                       -- lowercased; unique platform-wide
  email_normalized_search text,                -- hmac for case-insensitive lookup
  phone_encrypted bytea,
  phone_search  text,
  nida_encrypted bytea,                        -- AES-256-GCM (spec 4.3, 12)
  nida_search text unique,
  password_hash text,                          -- Argon2id
  status     text not null default 'pending_verification'
             check (status in ('pending_verification','active','suspended','deactivated')),
  full_name  text,
  totp_secret_encrypted bytea,
  totp_enabled boolean not null default false,
  failed_login_count int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  language   text not null default 'en' check (language in ('en','sw')),
  timezone   text not null default 'Africa/Dar_es_Salaam',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  deleted_at timestamptz
);
create trigger trg_users_updated before update on users
  for each row execute function public.set_updated_at();
create index idx_users_tenant on users (tenant_id);
create index idx_users_status on users (status);
create index idx_users_email_search on users (email_normalized_search);

-- ===========
-- RBAC
-- ===========
create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),       -- null = platform built-in
  key text not null,
  name text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, key)
);
create table if not exists permissions (
  key text primary key,                        -- e.g. 'fleet.edit'
  description text not null
);
create table if not exists role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_key text not null references permissions(key) on delete cascade,
  primary key (role_id, permission_key)
);
create table if not exists user_roles (
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references roles(id),
  branch_id uuid,
  granted_at timestamptz not null default now(),
  granted_by uuid,
  expires_at timestamptz,                      -- temporary delegation (spec 6.12)
  primary key (user_id, role_id)
);
create index idx_user_roles_user on user_roles (user_id);
create index idx_role_permissions_role on role_permissions (role_id);

-- ===========
-- SESSIONS (rotating refresh, family reuse detection)
-- ===========
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  family_id uuid not null,
  family_expires_at timestamptz not null,      -- absolute 12h cap
  refresh_token_hash text not null unique,     -- sha256 of opaque token
  user_agent text,
  ip inet,
  created_at timestamptz not null default now(),
  last_refreshed_at timestamptz not null default now(),
  expires_at timestamptz not null,             -- 7d rolling, capped by family
  revoked_at timestamptz,
  revoked_reason text
);
create index idx_sessions_user on sessions (user_id);
create index idx_sessions_family on sessions (family_id);
create index idx_sessions_tenant on sessions (tenant_id);

-- ===========
-- OTP CODES
-- ===========
create table if not exists otp_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  purpose text not null check (purpose in ('signup','phone_change','email_change','director_transfer','login_2fa')),
  channel text not null default 'sms',
  destination_search text not null,            -- hmac of phone/email
  code_hash text not null,                     -- hmac(code, SEARCH_HASH_KEY)
  attempts int not null default 0,
  expires_at timestamptz not null,             -- 5 minutes
  resend_available_at timestamptz not null,    -- 60s cooldown
  locked_until timestamptz,                    -- 15 min after 5 bad attempts
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_otp_user_purpose on otp_codes (user_id, purpose, created_at desc);
create index idx_otp_tenant on otp_codes (tenant_id);

-- ===========
-- PASSWORD RESETS (single-use, 30 min, revokes sessions)
-- ===========
create table if not exists password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  tenant_id uuid not null references tenants(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index idx_pwr_user on password_resets (user_id);

-- ===========
-- AUDIT LOG — append-only, partitioned by month (spec 1, 9)
-- ===========
create table if not exists audit_logs (
  id uuid not null default gen_random_uuid(),
  ts timestamptz not null default now(),
  tenant_id uuid,
  actor_user_id uuid,
  actor_role text,
  ip text,
  user_agent text,
  request_id text,
  entity text not null,
  entity_id uuid,
  action text not null,
  before jsonb,
  after jsonb
) partition by range (ts);
create table if not exists audit_logs_default partition of audit_logs default;
create index idx_audit_ts on audit_logs (ts);
create index idx_audit_tenant_ts on audit_logs (tenant_id, ts);
create index idx_audit_entity on audit_logs (entity, entity_id);

create or replace function platform_auth.prevent_audit_mutation() returns trigger
language plpgsql as $$ begin
  raise exception 'audit_logs is append-only';
end $$;
do $$ begin
  create trigger audit_no_mutation before update or delete on audit_logs
    for each row execute function platform_auth.prevent_audit_mutation();
exception when others then null; -- already exists
end $$;

-- ===========
-- SETTINGS, CONTENT, FLAGS
-- ===========
create table if not exists settings (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('global','tenant')),
  tenant_id uuid references tenants(id),
  key text not null,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  unique (scope, tenant_id, key)
);
create table if not exists content_blocks (
  key text not null,
  locale text not null check (locale in ('en','sw')),
  value text not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (key, locale)
);
create table if not exists feature_flags (
  key text primary key,
  enabled boolean not null default false,
  description text not null default '',
  payload jsonb not null default '{}'::jsonb
);

-- ===========
-- RATE LIMITS (fixed-window counters, atomic via function)
-- ===========
create table if not exists rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (bucket, window_start)
);

create or replace function platform_auth.hit_rate_limit(p_bucket text, p_limit int, p_window interval)
returns boolean language plpgsql security definer set search_path = public as $$ declare
  v_epoch bigint := extract(epoch from p_window)::bigint;
  v_start timestamptz := to_timestamp(floor(extract(epoch from now()) / v_epoch) * v_epoch);
  v_count int;
begin
  insert into rate_limits (bucket, window_start, count)
  values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set count = rate_limits.count + 1
  returning count into v_count;
  return v_count <= p_limit;
end $$;

-- =====================================
-- SECURITY DEFINER functions (pre-auth paths)
-- These are the ONLY way app_runtime touches rows before a tenant context exists.
-- =====================================
create or replace function platform_auth.lookup_transporter_login(p_tin_search text, p_email_search text)
returns jsonb language sql security definer set search_path = public as $$   select jsonb_build_object(
    'user_id', u.id, 'tenant_id', t.id, 'tenant_status', t.status,
    'user_status', u.status, 'password_hash', u.password_hash,
    'locked_until', u.locked_until, 'failed_login_count', u.failed_login_count,
    'roles', coalesce((
      select array_agg(r.key) from user_roles ur
      join roles r on r.id = ur.role_id where ur.user_id = u.id
    ), '{}')
  )
  from users u join tenants t on t.id = u.tenant_id
  where t.tin_search = p_tin_search
    and u.email_normalized_search = p_email_search
    and u.user_type in ('director','staff')
    and u.deleted_at is null and t.deleted_at is null
  limit 1;
 $$;

create or replace function platform_auth.lookup_shipper_login(p_email_search text, p_phone_search text)
returns jsonb language sql security definer set search_path = public as $$   select jsonb_build_object(
    'user_id', u.id, 'tenant_id', t.id, 'tenant_status', t.status,
    'user_status', u.status, 'password_hash', u.password_hash,
    'locked_until', u.locked_until, 'failed_login_count', u.failed_login_count,
    'roles', coalesce((
      select array_agg(r.key) from user_roles ur
      join roles r on r.id = ur.role_id where ur.user_id = u.id
    ), '{}')
  )
  from users u join tenants t on t.id = u.tenant_id
  where u.user_type = 'shipper' and u.deleted_at is null and t.deleted_at is null
    and (u.email_normalized_search = p_email_search
         or (p_phone_search is not null and u.phone_search = p_phone_search))
  limit 1;
 $$;

create or replace function platform_auth.lookup_customer_login(
  p_company_search text, p_tin_search text, p_username text)
returns jsonb language sql security definer set search_path = public as $$   select jsonb_build_object(
    'user_id', u.id, 'tenant_id', t.id, 'user_status', u.status,
    'password_hash', u.password_hash, 'locked_until', u.locked_until,
    'failed_login_count', u.failed_login_count, 'roles', '{"customer_temp"}'::text[]
  )
  from users u join tenants t on t.id = u.tenant_id
  where u.user_type = 'customer_temp'
    and lower(t.name) = p_company_search
    and t.tin_search = p_tin_search
    and u.email_normalized_search = p_username
    and u.deleted_at is null
  limit 1;
 $$;

-- Atomically consume an OTP: expiry, attempt counting, 5-strike 15-min lockout.
create or replace function platform_auth.consume_otp(p_user_id uuid, p_purpose text, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare o otp_codes; v_attempts int;
begin
  select * into o from otp_codes
   where user_id = p_user_id and purpose = p_purpose and consumed_at is null
   order by created_at desc limit 1 for update;
  if not found then return jsonb_build_object('status','none'); end if;
  if o.locked_until is not null and o.locked_until > now() then
    return jsonb_build_object('status','locked','until',o.locked_until);
  end if;
  if o.expires_at < now() then return jsonb_build_object('status','expired'); end if;
  if o.code_hash <> p_code_hash then
    update otp_codes set attempts = attempts + 1 where id = o.id returning attempts into v_attempts;
    if v_attempts >= 5 then
      update otp_codes set locked_until = now() + interval '15 minutes' where id = o.id;
      return jsonb_build_object('status','locked','until', now() + interval '15 minutes');
    end if;
    return jsonb_build_object('status','invalid','attempts_left', 5 - v_attempts);
  end if;
  update otp_codes set consumed_at = now() where id = o.id;
  return jsonb_build_object('status','ok');
end $$;

-- Rotate a refresh token; detect reuse of any already-rotated/revoked token and
-- revoke the whole family (spec 4.4).
create or replace function platform_auth.rotate_refresh(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$ declare s sessions; v_new sessions;
begin
  select * into s from sessions where refresh_token_hash = p_token_hash for update;
  if not found then return jsonb_build_object('status','unknown'); end if;
  if s.revoked_at is not null then
    update sessions set revoked_at = now(), revoked_reason = 'family_reuse'
     where family_id = s.family_id and revoked_at is null;
    return jsonb_build_object('status','reuse');
  end if;
  if s.expires_at < now() then return jsonb_build_object('status','expired'); end if;
  if s.family_expires_at < now() then
    update sessions set revoked_at = now(), revoked_reason = 'absolute_timeout' where family_id = s.family_id;
    return jsonb_build_object('status','expired');
  end if;
  if s.last_refreshed_at < now() - interval '30 minutes' then
    update sessions set revoked_at = now(), revoked_reason = 'idle_timeout' where family_id = s.family_id;
    return jsonb_build_object('status','idle');
  end if;
  update sessions set revoked_at = now(), revoked_reason = 'rotated' where id = s.id;
  insert into sessions (user_id, tenant_id, family_id, family_expires_at,
                        refresh_token_hash, user_agent, ip, expires_at)
  values (s.user_id, s.tenant_id, s.family_id, s.family_expires_at,
          encode(gen_random_uuid()::text::bytea,'hex') || md5(random()::text),
          s.user_agent, s.ip,
          least(now() + interval '7 days', s.family_expires_at))
  returning * into v_new;
  return jsonb_build_object('status','ok','session', to_jsonb(v_new));
end $$;

-- =====================================
-- Restricted runtime role + Row-Level Security
-- =====================================
do $$ begin
  if not exists (select from pg_roles where rolname = 'app_runtime') then
    create role app_runtime login password 'placeholder-change-me';
  end if;
end $$;

revoke all on schema public from public;
revoke all on schema public from anon, authenticated;   -- lock Supabase PostgREST surface out
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

grant usage on schema public to app_runtime;
grant select, insert, update on tenants, users, roles, role_permissions, user_roles,
  sessions, otp_codes, password_resets, settings, rate_limits to app_runtime;
grant select on permissions, content_blocks, feature_flags to app_runtime;
grant insert, select on audit_logs to app_runtime;
revoke delete on all tables in schema public from app_runtime;   -- soft delete only

alter table tenants            enable row level security;
alter table users              enable row level security;
alter table roles              enable row level security;
alter table user_roles         enable row level security;
alter table sessions           enable row level security;
alter table otp_codes          enable row level security;
alter table password_resets    enable row level security;
alter table audit_logs         enable row level security;
alter table settings           enable row level security;

-- tenant_id comes from `set_config('app.tenant_id', ..., true)` inside each transaction.
create policy tenants_self on tenants for all to app_runtime
  using (id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (id = nullif(current_setting('app.tenant_id', true),'')::uuid);
create policy users_tenant on users for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
create policy roles_tenant on roles for all to app_runtime
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
create policy user_roles_tenant on user_roles for all to app_runtime
  using (exists (select 1 from users u where u.id = user_roles.user_id
          and u.tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid));
create policy sessions_tenant on sessions for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
create policy otp_tenant on otp_codes for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
create policy pwr_tenant on password_resets for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
create policy audit_insert_scoped on audit_logs for insert to app_runtime
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
create policy audit_select_scoped on audit_logs for select to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
create policy settings_scoped on settings for all to app_runtime
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);

grant execute on function platform_auth.lookup_transporter_login(text,text),
  platform_auth.lookup_shipper_login(text,text),
  platform_auth.lookup_customer_login(text,text,text),
  platform_auth.consume_otp(uuid,text,text),
  platform_auth.rotate_refresh(text),
  platform_auth.hit_rate_limit(text,int,interval) to app_runtime;
revoke all on schema platform_auth from public, anon, authenticated, app_runtime;
grant usage on schema platform_auth to app_runtime;

commit;