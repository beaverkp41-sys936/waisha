-- 042: Internal job pipeline (spec Part 1) — additive on top of cargo_shipments.
-- A cargo file is the job; this migration adds the 10-stage checklist around it
-- without touching cargo_shipments.stage (the legacy 6-value column keeps
-- working for existing screens). Templates are global (tenant_id is null) and
-- seeded per shipment type; opening a job copies its template into job_stages.
-- job_documents carry direction/from/to/date/status and gate stage completion;
-- job_activity is the append-only feed behind the timeline view; jobs holds the
-- stage-9 transport decision (archive vs live, consent) and the free-day clock
-- that drives deadline alerts.
begin;

-- ---------- Job header ----------
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  shipment_id uuid not null references cargo_shipments(id),
  record_kind text not null default 'live' check (record_kind in ('live','archive')),
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  transport_needed boolean,
  transport_consent text not null default 'not_asked'
    check (transport_consent in ('not_asked','granted','declined','deferred')),
  free_days integer check (free_days is null or (free_days >= 0 and free_days <= 365)),
  free_days_start date,
  closed_at timestamptz,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index jobs_shipment_uq on jobs (tenant_id, shipment_id) where deleted_at is null;
create index idx_jobs_tenant_status on jobs (tenant_id, status) where deleted_at is null;
create trigger trg_jobs_updated before update on jobs
  for each row execute function public.set_updated_at();

-- ---------- Stage / task templates (global) ----------
create table if not exists job_stage_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),
  shipment_type text not null check (shipment_type in ('export','import','transhipment','transit')),
  stage_key text not null,
  name text not null,
  position smallint not null check (position between 1 and 10),
  required_documents text[] not null default '{}',
  default_tasks text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- Global rows have tenant_id null, so the unique key is built on the coalesce.
create unique index job_stage_templates_uq on job_stage_templates
  (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), shipment_type, stage_key)
  where deleted_at is null;
create index idx_job_stage_templates_lookup on job_stage_templates (shipment_type, position)
  where deleted_at is null;
create trigger trg_job_stage_templates_updated before update on job_stage_templates
  for each row execute function public.set_updated_at();

-- ---------- Stage instances ----------
create table if not exists job_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  job_id uuid not null references jobs(id),
  shipment_id uuid not null references cargo_shipments(id),
  stage_key text not null,
  name text not null,
  position smallint not null check (position between 1 and 10),
  status text not null default 'not_started'
    check (status in ('not_started','in_progress','blocked','done')),
  blocked_reason text,
  required_documents text[] not null default '{}',
  started_at timestamptz,
  completed_at timestamptz,
  completed_by uuid,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index job_stages_uq on job_stages (job_id, stage_key) where deleted_at is null;
create index idx_job_stages_job on job_stages (job_id, position) where deleted_at is null;
create index idx_job_stages_tenant_status on job_stages (tenant_id, status) where deleted_at is null;
create trigger trg_job_stages_updated before update on job_stages
  for each row execute function public.set_updated_at();

-- Stage status integrity that the routes cannot be trusted to keep:
-- blocked always carries a reason, done carries a completion stamp, and no
-- other status may keep a stale reason.
alter table job_stages add constraint job_stages_blocked_reason
  check (status <> 'blocked' or (blocked_reason is not null and length(trim(blocked_reason)) > 0));
alter table job_stages add constraint job_stages_done_stamp
  check (status <> 'done' or completed_at is not null);

-- ---------- Document register ----------
create table if not exists job_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  job_id uuid not null references jobs(id),
  shipment_id uuid not null references cargo_shipments(id),
  stage_key text,
  title text not null,
  kind text not null,
  direction text not null default 'received' check (direction in ('issued','received')),
  from_party text,
  to_party text,
  doc_date date,
  document_id uuid references documents(id),
  status text not null default 'pending'
    check (status in ('pending','received','verified','rejected')),
  verified_by uuid,
  verified_at timestamptz,
  rejection_reason text,
  notes text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_job_documents_job on job_documents (job_id, stage_key) where deleted_at is null;
create index idx_job_documents_shipment on job_documents (tenant_id, shipment_id, kind)
  where deleted_at is null;
create trigger trg_job_documents_updated before update on job_documents
  for each row execute function public.set_updated_at();

-- A verified row needs its verifier; a rejected row needs the reason.
alter table job_documents add constraint job_documents_verify_stamp
  check (status not in ('verified','rejected') or verified_at is not null);
alter table job_documents add constraint job_documents_reject_reason
  check (status <> 'rejected' or (rejection_reason is not null and length(trim(rejection_reason)) > 0));

-- ---------- Handover (client collects the cargo) ----------
create table if not exists job_handovers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  job_id uuid not null references jobs(id),
  shipment_id uuid not null references cargo_shipments(id),
  received_by_name text not null,
  received_by_id_number text,
  method text not null check (method in ('signature','photo')),
  document_id uuid references documents(id),
  notes text,
  happened_at timestamptz not null default now(),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index idx_job_handovers_job on job_handovers (job_id, happened_at desc);

-- ---------- Activity feed (append-only) ----------
create table if not exists job_activity (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  job_id uuid references jobs(id),
  shipment_id uuid references cargo_shipments(id),
  stage_id uuid references job_stages(id),
  actor_user_id uuid,
  actor_role text,
  action text not null,
  summary text not null,
  entity text,
  entity_id uuid,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index idx_job_activity_job on job_activity (job_id, created_at desc);
create index idx_job_activity_tenant on job_activity (tenant_id, created_at desc);

-- ---------- Task linkage (additive column on the existing task table) ----------
-- cargo_tasks already stores assignee / due date / notes, so the checklist
-- reuses it; stage_id groups generated and manual tasks under a pipeline stage.
alter table cargo_tasks add column if not exists stage_id uuid references job_stages(id);
create index if not exists idx_cargo_tasks_stage on cargo_tasks (stage_id) where stage_id is not null;

-- ---------- Document kinds used by the pipeline ----------
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check
  check (kind in ('logo','avatar','licence','insurance','inspection','road_licence',
                  'delivery_note','invoice','bill_of_lading','packing_list','contract',
                  'other','attachment','receipt','shipper_upload',
                  'arrival_notice','delivery_order','declaration','assessment',
                  'release_note','permit','pod','handover'));

-- ---------- RLS + grants (POLICY + GRANT together, 016 lesson) ----------
alter table jobs enable row level security;
create policy jobs_tenant on jobs for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on jobs to app_runtime;

-- Global templates are readable by every tenant; only a migration writes them,
-- so the app role gets SELECT and nothing else.
alter table job_stage_templates enable row level security;
create policy job_stage_templates_read on job_stage_templates for select to app_runtime
  using (tenant_id is null or tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select on job_stage_templates to app_runtime;

alter table job_stages enable row level security;
create policy job_stages_tenant on job_stages for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on job_stages to app_runtime;

alter table job_documents enable row level security;
create policy job_documents_tenant on job_documents for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update on job_documents to app_runtime;

alter table job_handovers enable row level security;
create policy job_handovers_tenant on job_handovers for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert on job_handovers to app_runtime;

-- Feed rows are immutable for the app role: no update, no delete.
alter table job_activity enable row level security;
create policy job_activity_tenant on job_activity for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert on job_activity to app_runtime;

-- cargo_tasks: the added column needs no new grant (select/insert/update only).

-- ---------- Permissions ----------
insert into permissions (key, description)
values
  ('jobs.view', 'Job pipeline - View checklist, timeline, board and dashboards'),
  ('jobs.create', 'Job pipeline - Open a job and generate its checklist'),
  ('jobs.manage', 'Job pipeline - Stage status, checklist tasks and documents'),
  ('jobs.verify', 'Job pipeline - Verify or reject job documents'),
  ('jobs.assign', 'Job pipeline - Assign tasks to other staff'),
  ('jobs.decide', 'Job pipeline - Stage 9 transport decision and handover'),
  ('jobs.close', 'Job pipeline - Close and archive a job')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'jobs.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('jobs.view','jobs.create','jobs.manage','jobs.verify','jobs.assign','jobs.decide')
where r.key in ('operations_manager','general_manager') and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('jobs.view','jobs.manage','jobs.assign')
where r.key in ('customer_service','customer_service_agent','dispatcher') and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key = 'jobs.view'
where r.key in ('compliance_officer','finance_officer','billing_admin','auditor','trainee','support_engineer')
  and r.tenant_id is null
on conflict do nothing;

-- ---------- Seeds: 10 stages x 4 shipment types ----------
insert into job_stage_templates (shipment_type, stage_key, name, position, required_documents, default_tasks)
values
-- import (sea / air arrivals handled by the CFA)
('import','job_opening','Job opening',1,'{}',
  array['Create file and assign a handler','Confirm client mandate and instructions']),
('import','pre_arrival_docs','Pre-arrival documents',2,
  array['bill_of_lading','packing_list','invoice'],
  array['Collect BL, commercial invoice and packing list','Match container numbers against the BL']),
('import','shipment_tracking','Shipment tracking (ETA, arrival notice, delivery order)',3,
  array['arrival_notice','delivery_order'],
  array['Track vessel / flight ETA','Request arrival notice and delivery order']),
('import','declaration_prep','Declaration preparation',4,array['declaration'],
  array['Prepare declaration data and HS codes','Validate CIF valuation and duty computation']),
('import','customs_submission','Customs submission and assessment',5,array['assessment'],
  array['Submit declaration to customs','Follow up the assessment result']),
('import','payment','Payment of duties and levies',6,array['receipt'],
  array['Confirm duty and levy amounts','Record the payment reference']),
('import','inspection','Inspection / verification',7,array['inspection'],
  array['Book and attend inspection','Log the inspection outcome']),
('import','release','Release',8,array['release_note'],
  array['Obtain the release note','Confirm cargo availability at the ICD']),
('import','transport_decision','Transport decision',9,'{}',
  array['Ask the client: collect or transport','Record the decision']),
('import','closing_billing','Closing and billing',10,'{}',
  array['Issue the client invoice','Close and archive the file']),
-- export
('export','job_opening','Job opening',1,'{}',
  array['Create file and assign a handler','Confirm exporter mandate']),
('export','pre_arrival_docs','Pre-departure documents',2,
  array['invoice','packing_list'],
  array['Collect invoice and packing list','Confirm shipping line cut-off dates']),
('export','shipment_tracking','Outbound tracking',3,array['delivery_order'],
  array['Book slot and gate pass','Track loading and sailing']),
('export','declaration_prep','Declaration preparation',4,array['declaration'],
  array['Prepare export declaration','Verify destination and HS codes']),
('export','customs_submission','Customs submission and assessment',5,array['assessment'],
  array['Submit declaration to customs','Follow up the assessment result']),
('export','payment','Payment of duties and levies',6,array['receipt'],
  array['Confirm export levies','Record the payment reference']),
('export','inspection','Inspection / verification',7,array['inspection'],
  array['Attend export inspection','Log the inspection outcome']),
('export','release','Release',8,array['release_note'],
  array['Obtain release and loading confirmation','Collect the bill of lading']),
('export','transport_decision','Transport decision',9,'{}',
  array['Ask the client: deliver or collect for transport','Record the decision']),
('export','closing_billing','Closing and billing',10,'{}',
  array['Issue the client invoice','Close and archive the file']),
-- transhipment
('transhipment','job_opening','Job opening',1,'{}',
  array['Create file and assign a handler','Confirm transhipment mandate']),
('transhipment','pre_arrival_docs','Pre-arrival documents',2,
  array['bill_of_lading','packing_list'],
  array['Collect in-transit BL and manifest','Verify second-leg booking']),
('transhipment','shipment_tracking','Vessel-to-vessel tracking',3,array['arrival_notice'],
  array['Track inbound and outbound ETAs','Request arrival notice']),
('transhipment','declaration_prep','Declaration preparation',4,array['declaration'],
  array['Prepare transit / transhipment declaration','Verify bond coverage']),
('transhipment','customs_submission','Customs submission and assessment',5,array['assessment'],
  array['Submit declaration to customs','Follow up the assessment result']),
('transhipment','payment','Bond and levy payment',6,array['receipt'],
  array['Confirm bond and levy amounts','Record the payment reference']),
('transhipment','inspection','Inspection / verification',7,array['inspection'],
  array['Attend transfer inspection','Log the inspection outcome']),
('transhipment','release','Release',8,array['release_note'],
  array['Obtain release for transfer','Confirm cargo hand-off to the second leg']),
('transhipment','transport_decision','Transport decision',9,'{}',
  array['Confirm movement between berths','Record the decision']),
('transhipment','closing_billing','Closing and billing',10,'{}',
  array['Issue the client invoice','Close and archive the file']),
-- transit
('transit','job_opening','Job opening',1,'{}',
  array['Create file and assign a handler','Confirm transit mandate and route']),
('transit','pre_arrival_docs','Pre-arrival documents',2,
  array['bill_of_lading','packing_list','invoice'],
  array['Collect BL, invoice and packing list','Verify destination and border point']),
('transit','shipment_tracking','Shipment tracking (ETA, arrival notice, delivery order)',3,
  array['arrival_notice','delivery_order'],
  array['Track vessel ETA at the port of entry','Request arrival notice and delivery order']),
('transit','declaration_prep','Declaration preparation',4,array['declaration'],
  array['Prepare transit declaration (T1 / RPT)','Verify bonded weights']),
('transit','customs_submission','Customs submission and assessment',5,array['assessment'],
  array['Submit at entry and exit posts','Follow up the assessment result']),
('transit','payment','Bond and levy payment',6,array['receipt','permit'],
  array['Confirm bond and permit fees','Record the payment reference']),
('transit','inspection','Inspection / verification',7,array['inspection'],
  array['Attend seal verification','Log the inspection outcome']),
('transit','release','Release',8,array['release_note','permit'],
  array['Obtain release and transit permit','Confirm exit schedule']),
('transit','transport_decision','Transport decision',9,'{}',
  array['Confirm bonded transport arrangement','Record the decision']),
('transit','closing_billing','Closing and billing',10,'{}',
  array['Confirm exit clearance','Issue the client invoice'])
on conflict do nothing;

commit;
