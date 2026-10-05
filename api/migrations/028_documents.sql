-- 028: Document vault foundations — one table for every uploaded file
-- (tenant logo, staff avatars, driver and vessel papers, trip documents).
-- Bytes live in Supabase Storage under a tenant-scoped path; this table is
-- the access-controlled index. The bucket is private: downloads proxy
-- through the API so tenant rules decide who sees what.
begin;

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  entity_type text not null check (entity_type in ('tenant','user','vessel','driver','trip')),
  entity_id uuid not null,
  kind text not null check (kind in ('logo','avatar','licence','insurance','inspection','road_licence','delivery_note','other')),
  file_name text not null,
  mime_type text not null,
  size_bytes int not null,
  storage_path text not null,
  uploaded_by uuid,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index idx_documents_tenant on documents (tenant_id);
create index idx_documents_entity on documents (tenant_id, entity_type, entity_id) where deleted_at is null;
create trigger trg_documents_updated before update on documents
  for each row execute function public.set_updated_at();

-- POLICY + GRANT together (016 lesson)
alter table documents enable row level security;
create policy documents_tenant on documents for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on documents to app_runtime;

commit;
