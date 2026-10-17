-- 067 — who works at the platform desk (spec §8, task #103).
--
-- No tables and no definer functions are added here. Everything the roster needs —
-- platform users, their role assignments, their live sessions, their own audit trail
-- and their picture — already lives inside the one 'platform' tenant, so a control
-- request that opens withTenant(platform) sees exactly its own community through the
-- policies that exist today. Wrapping those reads in SECURITY DEFINER would have
-- opened a wider door than the one RLS already holds shut, not a narrower one.
--
-- What was missing is the duty split. 'control.staff.manage' was seeded in 005 and
-- then never enforced by any route, so the only way to read the roster was to be
-- allowed to change it. The seats whose work is reading it — compliance checking who
-- did what, the analyst measuring workload, support unlocking an account — now get a
-- read key of their own, and editing stays with super_admin.

insert into permissions (key, description) values
  ('control.staff.view', 'Control - Read the platform staff roster and duty profiles')
on conflict do nothing;

-- super_admin already holds this through 005's cross join of every control key; the
-- row is written out anyway so the permission matrix reads as a matrix.
insert into role_permissions (role_id, permission_key)
select r.id, 'control.staff.view'
  from roles r
 where r.tenant_id is null
   and r.key in ('super_admin','compliance_officer','platform_analyst','support_engineer')
on conflict do nothing;

-- The roster page reads one person's trail per row, which is the shape 066's
-- (actor_user_id, ts desc) index serves; this one adds the tenant half of the filter
-- so the per-seat counts stay an index scan as the platform's own trail grows.
create index if not exists idx_audit_tenant_actor_ts
  on audit_logs (tenant_id, actor_user_id, ts desc);

-- Avatars are looked up by the person they belong to, for every seat on one page.
create index if not exists idx_documents_user_avatar
  on documents (tenant_id, entity_type, entity_id, kind)
 where deleted_at is null and kind = 'avatar';
