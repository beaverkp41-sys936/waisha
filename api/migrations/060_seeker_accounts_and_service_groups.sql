-- 060: Seeker accounts and service groups.
--
-- Two separate audiences land here.
--
-- (1) A SEEKER is a person looking for a transporter or a clearing & forwarding
-- agent. They sign up themselves with two names, a phone, an email and a
-- password, then verify by SMS or email code. Like the shipper precedent they
-- get their own one-person tenant, because users.tenant_id is NOT NULL — but
-- their tenant type is 'seeker', so they can never be mistaken for a company
-- and never appear in a directory of companies. This migration only builds the
-- account shell; the directory itself, its passes and its metering are 061.
--
-- (2) A SERVICE GROUP is the bundle a COMPANY buys: transport+CFA+office,
-- transport+office, or CFA+office. It is deliberately NOT a fourth row in
-- plans. plans is a price-and-seats ladder (starter/business/enterprise) that
-- claim_trial, get_licence and manual_activate address by hard-coded key, and
-- two routes validate z.enum(["starter","business","enterprise"]); putting the
-- bundles there would force those to change meaning on money-critical paths.
-- A bundle is an orthogonal fact about a subscription, so it rides next to the
-- plan as subscriptions.service_group_id.
--
-- The bundle column is named "services", not "modules": "modules" already means
-- something else here (plans.module_entitlements -> {"modules":[...]}, and the
-- modules array get_licence returns) — those are per-feature entitlement keys
-- like 'shipments'. Reusing the word for transport/cfa/office would make the
-- two vocabularies impossible to tell apart later.
--
-- Money follows the house convention for price ladders — numeric(12,2) with an
-- explicit currency column, exactly as plans does it. numeric is exact decimal,
-- never a float. Nothing here collects money: a seeker pass is recorded and
-- verified by an admin, and no payment provider is touched.

begin;

-- ============================
-- VOCABULARIES
-- ============================

-- 'seeker' joins the user types. The constraint is dropped and re-added whole
-- (the 005/040 idiom) because Postgres has no ALTER CONSTRAINT.
alter table users drop constraint users_user_type_check;
alter table users add constraint users_user_type_check
  check (user_type in ('platform','director','staff','driver','trainee','shipper','customer_temp','seeker'));

alter table tenants drop constraint tenants_type_check;
alter table tenants add constraint tenants_type_check
  check (type in ('transporter','shipper','platform','seeker'));

-- ============================
-- SERVICE GROUPS (platform-owned reference data, like plans)
-- ============================

create table if not exists service_groups (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  -- The bundle, checked against a closed vocabulary rather than free text,
  -- because the whole point of the column is to answer "does this customer have
  -- CFA?" with one unambiguous test. Repeats inside the array are refused where
  -- the array is built — a CHECK cannot hold a subquery and an expression
  -- calling a helper just for this would make the table depend on that function.
  services text[] not null
    check (services <@ array['transport','cfa','office']
           and array_length(services, 1) between 1 and 3),
  seat_limit int not null default 25 check (seat_limit between 1 and 1000),
  price_monthly numeric(12,2) not null default 0 check (price_monthly >= 0),
  price_quarterly numeric(12,2) not null default 0 check (price_quarterly >= 0),
  price_annual numeric(12,2) not null default 0 check (price_annual >= 0),
  currency text not null default 'TZS' check (currency = 'TZS'),
  sort int not null default 0,
  is_active boolean not null default true,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_service_groups_active on service_groups (sort) where is_active;

create trigger trg_service_groups_updated before update on service_groups
  for each row execute function public.set_updated_at();

-- POLICY + GRANT together (016 lesson), on the 047 shape for a platform-owned
-- global table: no tenant_id, so the predicate is true and the control
-- surface's own cookie + hasLicenceRole check is the gate.
alter table service_groups enable row level security;
grant select, insert, update on service_groups to app_runtime;
create policy service_groups_read on service_groups
  for select to app_runtime using (true);
create policy service_groups_insert on service_groups
  for insert to app_runtime with check (true);
create policy service_groups_update on service_groups
  for update to app_runtime using (true) with check (true);

-- The three bundles the user specified, priced on the same ladder plans already
-- uses (quarterly = 3 months at 95%, annual = 10 months). Suggested prices, not
-- committed ones — the control panel edits them, which is why they are rows.
insert into service_groups
  (key, name, description, services, seat_limit,
   price_monthly, price_quarterly, price_annual, sort)
values
  ('transport_cfa_office','Complete Logistics Suite',
   'Freight transport, clearing and forwarding, and the office and staff module together — one subscription for the whole operation.',
   array['transport','cfa','office'], 50,
   600000.00, 1710000.00, 6000000.00, 1),
  ('transport_office','Transport & Office',
   'Fleet, drivers, trips and routes with the office and staff module. Clearing and forwarding files are not included.',
   array['transport','office'], 30,
   400000.00, 1140000.00, 4000000.00, 2),
  ('cfa_office','Clearing & Office',
   'Cargo files, proforma and billing, consolidator manifests with the office and staff module. No own-fleet dispatch.',
   array['cfa','office'], 25,
   350000.00, 997500.00, 3500000.00, 3)
on conflict (key) do nothing;

-- A subscription carries the bundle it sold. Nullable on purpose: every row
-- written before this migration — and every trial claimed through
-- platform_auth.claim_trial, which knows nothing about bundles — keeps working
-- on the plan ladder alone.
alter table subscriptions
  add column if not exists service_group_id uuid references service_groups(id);
create index if not exists idx_subscriptions_service_group
  on subscriptions (service_group_id) where service_group_id is not null;

-- ============================
-- SEEKER ACCOUNTS
-- ============================

-- One row per seeker user: the facts a company tenant has no place for.
-- first_name / last_name are stored apart even though users.full_name carries
-- the joined string (the shipper precedent). Splitting them here is what lets a
-- welcome email and an admin roster address the person by one name without
-- substring-parsing a string that may hold a middle name or a title.
create table if not exists seekers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  first_name text not null check (char_length(trim(first_name)) between 1 and 60),
  last_name text not null check (char_length(trim(last_name)) between 1 and 60),
  -- What they came looking for. Empty means "not answered yet" — never a silent
  -- default of both, which would inflate every demand statistic.
  looking_for text[] not null default '{}'::text[]
    check (looking_for <@ array['transporter','cfa']),
  industry text,
  country text not null default 'Tanzania',
  -- Which channel actually cleared the signup code. Both may end up stamped:
  -- one is mandatory at signup, the other when the person confirms that too.
  phone_verified_at timestamptz,
  email_verified_at timestamptz,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index seekers_user_uq on seekers (user_id) where deleted_at is null;
create unique index seekers_tenant_uq on seekers (tenant_id) where deleted_at is null;
create index idx_seekers_tenant on seekers (tenant_id) where deleted_at is null;

alter table seekers enable row level security;
create policy seekers_tenant on seekers for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- No DELETE: soft delete only (041 least-privilege posture).
grant select, insert, update on seekers to app_runtime;

create trigger trg_seekers_updated before update on seekers
  for each row execute function public.set_updated_at();

-- ============================
-- PERMISSIONS AND ROLE
-- ============================

insert into permissions (key, description)
values
  ('seeker_profile.view', 'Seeker Account - View own profile and verification state'),
  ('seeker_profile.edit', 'Seeker Account - Edit own profile, names and what they are looking for')
on conflict do nothing;

insert into roles (tenant_id, key, name, is_system)
values (null, 'seeker', 'Seeker (Directory Access)', true)
on conflict do nothing;

-- Only the self-profile keys are granted now. The directory, reveal and pass
-- keys arrive with 061 and are granted to this role there — the same split 040
-- used for shipper_portal, so a role is never granted for a table that does not
-- exist yet.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'seeker_profile.%'
where r.key = 'seeker' and r.tenant_id is null
on conflict do nothing;

-- ============================
-- PRE-AUTH HELPERS (003 pattern: narrow, purpose-built, definer)
-- ============================

-- Sign-up duplicate check for seekers. Both probes run against users, not
-- tenants: a seeker must not be able to take an email or a phone a transporter
-- or a shipper already holds, and those are user-level facts.
create or replace function platform_auth.check_seeker_duplicates(
  p_email text, p_phone_search text)
returns text language sql security definer set search_path = public as $$
  select 'email' from users where email = p_email
  union all
  select 'phone' from users where phone_search = p_phone_search and deleted_at is null
  limit 1;
$$;

-- Seeker login by email or phone, mirroring lookup_shipper_login exactly so the
-- auth route reuses the same status / lockout handling.
create or replace function platform_auth.lookup_seeker_login(
  p_email_search text, p_phone_search text)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'user_id', u.id, 'tenant_id', t.id, 'tenant_status', t.status,
    'user_status', u.status, 'password_hash', u.password_hash,
    'locked_until', u.locked_until, 'failed_login_count', u.failed_login_count,
    'roles', coalesce((
      select array_agg(r.key) from user_roles ur
      join roles r on r.id = ur.role_id where ur.user_id = u.id
    ), '{}')
  )
  from users u join tenants t on t.id = u.tenant_id
  where u.user_type = 'seeker' and u.deleted_at is null and t.deleted_at is null
    and (u.email_normalized_search = p_email_search
         or (p_phone_search is not null and u.phone_search = p_phone_search))
  limit 1;
$$;

-- Resend by EMAIL needs the address, which the 003 version never returned. The
-- signature is unchanged, so 003's execute grant survives the replace.
create or replace function platform_auth.get_user_for_otp(p_user_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'id', u.id, 'tenant_id', u.tenant_id, 'status', u.status,
    'user_type', u.user_type, 'phone_search', u.phone_search,
    'phone_encrypted', u.phone_encrypted,
    'email', u.email,
    'channel', (select o.channel from otp_codes o
                 where o.user_id = u.id and o.purpose = 'signup'
                 order by o.created_at desc limit 1))
  from users u where u.id = p_user_id and u.deleted_at is null
  limit 1;
$$;

-- Stamp which channel cleared the account. A definer function rather than a
-- plain update because seekers is RLS-scoped to its own tenant and the
-- verification route holds only a user id at that point.
create or replace function platform_auth.mark_seeker_verified(
  p_user_id uuid, p_channel text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r seekers%rowtype;
begin
  select * into r from seekers where user_id = p_user_id and deleted_at is null limit 1;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if p_channel = 'sms' then
    update seekers set phone_verified_at = now() where id = r.id;
  elsif p_channel = 'email' then
    update seekers set email_verified_at = now() where id = r.id;
  else
    return jsonb_build_object('status','invalid');
  end if;
  return jsonb_build_object('status','ok','seeker_id', r.id);
end $$;

-- A seeker has no company to activate. The Control list is the door through
-- which manual_activate sells a starter/business/enterprise subscription, so
-- excluding them here is what keeps that door from offering a company plan to a
-- person looking for one. Same returned columns as 010 — only the WHERE moves —
-- so control.routes.ts keeps reading the record unchanged.
create or replace function platform_auth.list_tenants_for_control(p_search text)
returns table (
  tenant_id uuid, name text, tenant_type text, status text,
  trial_ends_at timestamptz, licence_expires_at timestamptz,
  subscription_status text, plan_name text, seats_licensed int,
  created_at timestamptz
) language sql security definer set search_path = public as $$
  select t.id, t.name, t.type, t.status,
         t.trial_ends_at, t.licence_expires_at,
         s.status, p.name, s.seats_licensed, t.created_at
  from tenants t
  left join subscriptions s on s.tenant_id = t.id and s.deleted_at is null
  left join plans p on p.id = s.plan_id
  where t.deleted_at is null
    and t.type not in ('platform','seeker')
    and (p_search is null or t.name ilike '%' || p_search || '%')
  order by t.created_at desc
  limit 200;
$$;

-- app_runtime still edits the plans ladder from the control panel. 047 added the
-- missing UPDATE *grant* but not the matching UPDATE *policy*, so as
-- app_runtime the statement passed the privilege check, RLS then filtered every
-- row out, and the route answered ok while the price stayed where it was. Dev
-- hides this because DATABASE_URL connects as the owner role, which bypasses RLS.
drop policy if exists plans_update on plans;
create policy plans_update on plans
  for update to app_runtime using (true) with check (true);

grant execute on function
  platform_auth.check_seeker_duplicates(text, text),
  platform_auth.lookup_seeker_login(text, text),
  platform_auth.mark_seeker_verified(uuid, text),
  platform_auth.list_tenants_for_control(text)
to app_runtime;
-- get_user_for_otp(uuid) was already granted by 003; the replace keeps it.

-- Postgres hands EXECUTE on every new function to PUBLIC unless told otherwise,
-- and 051's sweep ran before this file, so it could not have covered them. The
-- schema itself is locked (001 revoked USAGE on platform_auth from
-- public/anon/authenticated), which is the only reason these would have been
-- unreachable — but "unreachable because a different object denies it" is not a
-- posture to leave a browser role sitting on top of. Same revoke list 051 uses.
revoke all on function
  platform_auth.check_seeker_duplicates(text, text),
  platform_auth.lookup_seeker_login(text, text),
  platform_auth.mark_seeker_verified(uuid, text),
  platform_auth.get_user_for_otp(uuid)
from public, anon, authenticated, service_role;

commit;
