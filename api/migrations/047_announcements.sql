-- 047_announcements.sql
-- Platform announcement ticker: notices posted from the control panel and shown
-- to every signed-in user (app shell, shipper portal, control). Global table,
-- no tenant_id — the content is platform-wide, not tenant data. Deactivation
-- replaces deletion (active=false), so there is no DELETE grant.

create table system_announcements (
  id         uuid primary key default gen_random_uuid(),
  message    text not null check (char_length(message) between 4 and 400),
  kind       text not null default 'info'
             check (kind in ('info','update','upgrade','maintenance','warning')),
  active     boolean not null default true,
  starts_at  timestamptz,
  ends_at    timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index system_announcements_live_idx
  on system_announcements (created_at desc)
  where active;

create trigger system_announcements_updated_at before update on system_announcements
  for each row execute function public.set_updated_at();

alter table system_announcements enable row level security;

grant select, insert, update on system_announcements to app_runtime;

create policy system_announcements_read on system_announcements
  for select to app_runtime using (true);
create policy system_announcements_insert on system_announcements
  for insert to app_runtime with check (true);
create policy system_announcements_update on system_announcements
  for update to app_runtime using (true) with check (true);

-- Latent production fix: PUT /control/plans/:key updates plans, but 005 granted
-- only SELECT — production (app_runtime) would fail 42501. Dev runs as the
-- owner role, which masks this.
grant update on plans to app_runtime;
