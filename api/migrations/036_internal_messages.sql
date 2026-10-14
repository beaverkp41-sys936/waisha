-- 036: Internal Messages — one conversation per cargo file plus a tenant-wide
-- general team channel. A message with shipment_id null belongs to the general
-- channel; otherwise it belongs to that cargo file's conversation. Read state
-- is a per-user watermark per conversation (same null-shipment_id convention):
-- everything newer than last_read_at is unread. Message files ride the
-- documents vault under entity_type 'message'.
begin;

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  shipment_id uuid references cargo_shipments(id),
  -- body may be empty when the message carries only files (uploaded next step)
  body text not null default '' check (char_length(body) <= 4000),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_messages_tenant on messages (tenant_id);
create index idx_messages_general on messages (tenant_id, created_at)
  where shipment_id is null and deleted_at is null;
create index idx_messages_shipment on messages (tenant_id, shipment_id, created_at)
  where shipment_id is not null and deleted_at is null;
create trigger trg_messages_updated before update on messages
  for each row execute function public.set_updated_at();

-- Per-user read watermark; one row per user per conversation.
create table if not exists message_reads (
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  shipment_id uuid references cargo_shipments(id),
  last_read_at timestamptz not null default now()
);
create unique index message_reads_general_uq on message_reads (tenant_id, user_id)
  where shipment_id is null;
create unique index message_reads_shipment_uq on message_reads (tenant_id, user_id, shipment_id)
  where shipment_id is not null;

-- POLICY + GRANT together (016 lesson)
alter table messages enable row level security;
create policy messages_tenant on messages for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on messages to app_runtime;

alter table message_reads enable row level security;
create policy message_reads_tenant on message_reads for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update on message_reads to app_runtime;

-- Message attachments attach to the document vault like every other file.
alter table documents drop constraint documents_entity_type_check;
alter table documents add constraint documents_entity_type_check
  check (entity_type in ('tenant','user','vessel','driver','trip','shipment','message'));
alter table documents drop constraint documents_kind_check;
alter table documents add constraint documents_kind_check
  check (kind in ('logo','avatar','licence','insurance','inspection','road_licence',
                  'delivery_note','invoice','bill_of_lading','packing_list','other','attachment'));

-- Permission keys for the module.
insert into permissions (key, description)
values
  ('messages.view', 'Internal Messages - View'),
  ('messages.send', 'Internal Messages - Send'),
  ('messages.delete', 'Internal Messages - Delete')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key like 'messages.%'
where r.key = 'director' and r.tenant_id is null
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key = 'messages.view'
where r.key = 'auditor' and r.tenant_id is null
on conflict do nothing;

commit;
