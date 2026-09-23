-- 005: Billing and licensing foundations (spec 5.4, 9)
begin;

-- Platform staff need a home tenant: widen the tenant type check.
alter table tenants drop constraint tenants_type_check;
alter table tenants add constraint tenants_type_check
  check (type in ('transporter','shipper','platform'));

-- =========
-- PLANS (global reference data — owned by Super Admin, read by all)
-- =========
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  seat_limit int not null,
  price_monthly numeric(12,2) not null,
  price_quarterly numeric(12,2) not null,
  price_annual numeric(12,2) not null,
  currency text not null default 'TZS',
  vat_rate numeric(5,4) not null default 0.18,
  module_entitlements jsonb not null default '{}'::jsonb,
  feature_flags jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_plans_updated before update on plans
  for each row execute function public.set_updated_at();

-- =========
-- SUBSCRIPTIONS (one active per tenant)
-- =========
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  plan_id uuid not null references plans(id),
  billing_cycle text not null check (billing_cycle in ('monthly','quarterly','annual')),
  status text not null default 'pending'
    check (status in ('pending','trial','active','grace','expired','suspended','cancelled')),
  seats_licensed int not null default 0,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  auto_renew boolean not null default true,
  grace_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, deleted_at timestamptz
);
create unique index subscriptions_tenant_live_uq on subscriptions (tenant_id)
  where deleted_at is null;
create index idx_subscriptions_status on subscriptions (status);
create trigger trg_subscriptions_updated before update on subscriptions
  for each row execute function public.set_updated_at();

-- =========
-- INVOICES
-- =========
create sequence if not exists invoice_number_seq;

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subscription_id uuid references subscriptions(id),
  number text not null unique,
  billing_cycle text not null check (billing_cycle in ('monthly','quarterly','annual')),
  seats int not null,
  amount_subtotal numeric(12,2) not null,
  vat_rate numeric(5,4) not null,
  vat_amount numeric(12,2) not null,
  amount_total numeric(12,2) not null,
  currency text not null default 'TZS',
  status text not null default 'issued'
    check (status in ('draft','issued','paid','void','refunded')),
  period_start date not null,
  period_end date not null,
  issued_at timestamptz not null default now(),
  due_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, deleted_at timestamptz
);
create index idx_invoices_tenant on invoices (tenant_id);
create index idx_invoices_status on invoices (status);
create trigger trg_invoices_updated before update on invoices
  for each row execute function public.set_updated_at();

-- =========
-- PAYMENTS (the ledger; state machine enforced via helper + audited transitions)
-- =========
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  invoice_id uuid references invoices(id),
  provider text not null check (provider in ('azampesa','mpesa','tigopesa','airtel','halopesa','bank')),
  provider_txn_id text,
  intent_reference text not null unique,      -- returned to the client for the countdown/polling
  payer_phone_encrypted bytea,
  amount numeric(12,2) not null,
  currency text not null default 'TZS',
  status text not null default 'pending'
    check (status in ('pending','approved','failed','timed_out','cancelled','refunded')),
  idempotency_key text not null unique,
  raw_request jsonb,
  raw_response jsonb,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid
);
create index idx_payments_tenant on payments (tenant_id);
create index idx_payments_status on payments (status);
create trigger trg_payments_updated before update on payments
  for each row execute function public.set_updated_at();

-- Allowed transitions (spec 5.2: state machine only) — used by the API before every update.
create or replace function platform_auth.payment_transition_allowed(p_from text, p_to text)
returns boolean language sql immutable as $$   select (p_from, p_to) in (values
    ('pending','approved'), ('pending','failed'), ('pending','timed_out'), ('pending','cancelled'),
    ('approved','refunded'))
 $$;

-- =========
-- PAYMENT WEBHOOKS (append-only delivery + replay ledger)
-- =========
create table if not exists payment_webhooks (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_type text not null,
  signature_valid boolean not null default false,
  replay_nonce text unique,                   -- replay protection store (spec 12)
  payload jsonb not null,
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz not null default now()
);
create index idx_webhooks_provider on payment_webhooks (provider, created_at);

-- =========
-- PLATFORM TENANT + STAFF ROLES + CONTROL PERMISSIONS
-- =========
insert into tenants (id, type, name, status)
values ('00000000-0000-4000-8000-000000000000','platform','T ENGO AEGIS (Platform)','active')
on conflict (id) do nothing;

insert into roles (tenant_id, key, name, is_system) values
 (null,'super_admin','Super Admin',true),
 (null,'billing_admin','Billing Administrator',true),
 (null,'customer_service_agent','Customer Service Agent',true),
 (null,'compliance_officer','Compliance Officer',true),
 (null,'support_engineer','Support Engineer',true),
 (null,'platform_analyst','Read-only Analyst',true)
on conflict do nothing;

insert into permissions (key, description) values
 ('control.view','View the control panel'),
 ('control.tenants.manage','Manage tenants'),
 ('control.licences.manage','Manage licences and trials'),
 ('control.payments.manage','Manage payments and refunds'),
 ('control.plans.manage','Edit plans and pricing'),
 ('control.content.manage','Edit platform content and templates'),
 ('control.staff.manage','Manage platform staff'),
 ('control.system.manage','System settings and flags'),
 ('control.audit.view','Read the audit log'),
 ('control.impersonate','Impersonate tenant users')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r cross join permissions p
where r.key = 'super_admin'
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r join permissions p
  on p.key in ('control.view','control.plans.manage','control.payments.manage','control.licences.manage')
where r.key = 'billing_admin'
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key from roles r join permissions p
  on p.key in ('control.view','control.audit.view')
where r.key = 'platform_analyst'
on conflict do nothing;

-- =========
-- STARTER PLANS (placeholders — editable later in Control > Plans)
-- Quarterly = 3 x monthly less 5%; Annual = 10 x monthly (two months free).
-- =========
insert into plans (key, name, seat_limit, price_monthly, price_quarterly, price_annual, module_entitlements, feature_flags) values
 ('starter','Starter',5,150000.00,427500.00,1500000.00,
  '{"modules":["dashboard","profile","fleet","trips","checkpoints"]}',
  '{"marketplace":false}'),
 ('business','Business',25,350000.00,997500.00,3500000.00,
  '{"modules":["dashboard","profile","fleet","routes","trips","checkpoints","tracking","costs","garage","drivers","trainees","reports"]}',
  '{"marketplace":true}'),
 ('enterprise','Enterprise',100,800000.00,2280000.00,8000000.00,
  '{"modules":["*"]}',
  '{"marketplace":true,"api":true,"sso":true}')
on conflict (key) do nothing;

-- =========
-- GRANTS + RLS
-- =========
grant select on plans to app_runtime;
grant select, insert, update on subscriptions, invoices, payments to app_runtime;
grant insert, select on payment_webhooks to app_runtime;
grant execute on function platform_auth.payment_transition_allowed(text, text) to app_runtime;
grant usage, select on sequence invoice_number_seq to app_runtime;

alter table plans            enable row level security;
alter table subscriptions    enable row level security;
alter table invoices         enable row level security;
alter table payments         enable row level security;
alter table payment_webhooks enable row level security;

create policy plans_read on plans for select to app_runtime using (true);

create policy subscriptions_tenant on subscriptions for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
create policy invoices_tenant on invoices for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
create policy payments_tenant on payments for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);

create policy webhooks_insert on payment_webhooks for insert to app_runtime with check (true);
create policy webhooks_select on payment_webhooks for select to app_runtime using (true);

commit;