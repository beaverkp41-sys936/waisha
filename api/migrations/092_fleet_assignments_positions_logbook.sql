-- 092 — the three questions a fleet could not answer (task #172).
--
-- A transporter's fleet screen knew what a truck *is*: plate, type, capacity, when its
-- papers lapse. It could not answer the three questions a fleet manager actually opens it
-- for.
--
--   "Who has this truck?"   — `drivers.assigned_vessel_id` is a scalar. Assigning a new
--                             driver overwrote the old name with no date, no odometer at
--                             handover and no record of who did it, so a damaged windscreen
--                             or a missing 200 litres could never be placed with a person.
--   "Where is it?"          — nothing. Not one column, route or page anywhere in the
--                             platform stored a vehicle's position, although the seed has
--                             carried a whole `tracking.*` duty module since 005 with
--                             nothing behind it.
--   "What has happened to it?" — fuel went in `fuel_logs`, damage in `incidents`, papers in
--                             `documents`, each its own screen. No plate had one journal.
--
-- So: `vessel_assignments` is the register the scalar should have been, and the scalar stays
-- as its projection (the drivers page and the trip double-booking guard already read it, and
-- rewriting both in the same stage would be a refactor hiding inside a feature).
-- `vessel_positions` is the ledger, and `vessel_log_entries` is the per-plate journal.
--
-- What "live" honestly means here, stated in the data so no screen can overclaim it: there
-- is no telematics feed, no GPS unit and no driver app. A position is a *report* — this
-- browser's own location, a dispatcher's word for where a truck is, or the platform's own
-- trip legs, which know a route's origin and destination coordinates from 075 and can say
-- the vehicle was at one when it departed and at the other when it arrived. Every row
-- carries its `source` and its `recorded_at`, so a reader always knows how old the claim is
-- and who made it. A dashboard that showed a three-day-old fix as "current position" would
-- send someone looking for a truck in the wrong town.
--
-- The position ledger is insert-and-read only: `grant select, insert`, no UPDATE, no
-- DELETE, not even soft. A wrong fix stays in the record and a correction is a new row,
-- because a table that describes where a vehicle was is evidence, and evidence that can be
-- quietly rewritten by the application role is not evidence. The logbook and the assignment
-- register keep the house soft-delete pattern (041).
--
-- Money deliberately does not live in the logbook. A per-plate journal that also holds cost
-- figures would collide with #185's work orders and with `fuel_logs` / `freight_expenses`,
-- and three places to look for one number is the failure this platform has been fixing all
-- the way through. A note may say "tyre burst near Kidatu"; the litres, the shillings and
-- the garage belong to their own registers.
--
-- The two active-assignment unique indexes are the whole point of the register — a truck in
-- two hands at once is how fuel and damage stop being traceable — so they are enforced by
-- the database, not by the route that remembers to check. The backfill below skips legacy
-- pairs that share a vehicle rather than inventing a winner, and says how many it skipped:
-- those drivers keep their scalar, and the first person to touch either seat resolves it
-- with the rule in front of them instead of a migration guessing.

begin;

-- ============================================================
-- 1. the assignment register
-- ============================================================

create table if not exists vessel_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  vessel_id uuid not null references vessels(id),
  driver_id uuid not null references drivers(id),
  status text not null default 'active' check (status in ('active','ended')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- Odometer at handover, in both directions: the difference is what this driver drove,
  -- which is the number a fuel or damage conversation starts from.
  start_odometer_km int,
  end_odometer_km int,
  notes text,
  assigned_by uuid,
  ended_by uuid,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- One way to be active: open. An `ended` row without an end time, or an active row with
  -- one, would make the history a matter of which column a reader trusted.
  check ((status = 'active') = (ended_at is null))
);

-- One driver per vehicle, one vehicle per driver, while the row is open.
create unique index vessel_assignments_active_vessel_uq
  on vessel_assignments (tenant_id, vessel_id)
  where status = 'active' and deleted_at is null;
create unique index vessel_assignments_active_driver_uq
  on vessel_assignments (tenant_id, driver_id)
  where status = 'active' and deleted_at is null;
create index idx_vessel_assignments_tenant on vessel_assignments (tenant_id)
  where deleted_at is null;
create index idx_vessel_assignments_vessel on vessel_assignments (vessel_id, started_at desc);
create index idx_vessel_assignments_driver on vessel_assignments (driver_id, started_at desc);
create trigger trg_vessel_assignments_updated before update on vessel_assignments
  for each row execute function public.set_updated_at();

alter table vessel_assignments enable row level security;
create policy vessel_assignments_tenant on vessel_assignments for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update on vessel_assignments to app_runtime;

-- ============================================================
-- 2. the position ledger
-- ============================================================

create table if not exists vessel_positions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  vessel_id uuid not null references vessels(id),
  trip_id uuid references trips(id),
  driver_id uuid references drivers(id),
  lat numeric(9,6) not null check (lat between -90 and 90),
  lng numeric(9,6) not null check (lng between -180 and 180),
  -- Who said so, and how. `device` is the reporting browser's own fix; `manual` is someone
  -- else's word for where the truck is; the two trip sources are generated by the platform
  -- from the route's traced anchors when a leg departs or arrives.
  source text not null check (source in ('device','manual','trip_departure','trip_arrival')),
  accuracy_m int check (accuracy_m is null or accuracy_m >= 0),
  odometer_km int check (odometer_km is null or odometer_km >= 0),
  note text,
  -- A report can describe the past ("he phoned from Malade at 06:00"), and that is the
  -- difference between a trail and a guess. How far back is believed is the route's rule;
  -- the column only refuses to be in the future, because a position that has not happened
  -- yet would sort itself to the top of every "where is it now" read.
  recorded_at timestamptz not null default now() check (recorded_at <= now() + interval '10 min'),
  recorded_by uuid
);

create index idx_vessel_positions_vessel on vessel_positions (vessel_id, recorded_at desc);
create index idx_vessel_positions_tenant on vessel_positions (tenant_id, recorded_at desc);
create index idx_vessel_positions_trip on vessel_positions (trip_id) where trip_id is not null;

alter table vessel_positions enable row level security;
create policy vessel_positions_tenant on vessel_positions for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
-- Deliberately not update, not delete: see the header. The ledger is written and read.
grant select, insert on vessel_positions to app_runtime;

-- ============================================================
-- 3. the per-plate logbook
-- ============================================================

create table if not exists vessel_log_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  vessel_id uuid not null references vessels(id),
  entry_date date not null default current_date,
  kind text not null check (kind in
    ('note','odometer','service','inspection','paperwork','movement','damage')),
  -- A short line, because this is what a register is scanned for. The detail is below it.
  title text not null check (char_length(trim(title)) > 0),
  detail text,
  odometer_km int check (odometer_km is null or odometer_km >= 0),
  -- Whoever physically did the work, as written: a mechanic at a garage is not a platform
  -- user, and inventing a users row for one would be a false join.
  actor_name text,
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- An `odometer` entry that carries no reading is a note with a misleading label: the
  -- reading is the reason the row exists.
  check (kind <> 'odometer' or odometer_km is not null)
);

create index idx_vessel_log_entries_vessel on vessel_log_entries (vessel_id, entry_date desc)
  where deleted_at is null;
create index idx_vessel_log_entries_tenant on vessel_log_entries (tenant_id)
  where deleted_at is null;
create trigger trg_vessel_log_entries_updated before update on vessel_log_entries
  for each row execute function public.set_updated_at();

alter table vessel_log_entries enable row level security;
create policy vessel_log_entries_tenant on vessel_log_entries for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update on vessel_log_entries to app_runtime;

-- ============================================================
-- 4. backfill the register from the scalar it replaces
-- ============================================================
--
-- Only pairs that are unambiguous: the driver and the vessel both still live, in the same
-- company, and no other driver claims the same vehicle. An `on conflict do nothing` here
-- would silently drop the second driver of a shared truck into a row that never landed, so
-- the shared case is excluded by the predicate and counted instead.

insert into vessel_assignments
  (tenant_id, vessel_id, driver_id, status, started_at, assigned_by, created_by)
select d.tenant_id, d.assigned_vessel_id, d.id, 'active', d.updated_at, d.updated_by, d.updated_by
  from drivers d
 where d.deleted_at is null
   and d.assigned_vessel_id is not null
   and exists (select 1 from vessels v
                where v.id = d.assigned_vessel_id and v.tenant_id = d.tenant_id
                  and v.deleted_at is null)
   and (select count(*) from drivers o
          where o.assigned_vessel_id = d.assigned_vessel_id
            and o.deleted_at is null) = 1
on conflict do nothing;

do $$ declare
  v_open int;
  v_shared int;
begin
  select count(*)::int into v_open
    from vessel_assignments where status = 'active' and deleted_at is null;
  select count(distinct o.assigned_vessel_id)::int into v_shared
    from drivers o
   where o.deleted_at is null and o.assigned_vessel_id is not null
     and (select count(*) from drivers p
            where p.assigned_vessel_id = o.assigned_vessel_id
              and p.deleted_at is null) > 1;
  -- One literal: RAISE takes a format string, and a plpgsql `||` continuation here is a
  -- syntax error, not a concatenation.
  raise notice '092: the register holds % open assignment(s) after backfilling drivers.assigned_vessel_id; % vehicle(s) were claimed by more than one driver and left to the first person who touches them',
    coalesce(v_open, 0), coalesce(v_shared, 0);
end $$;

-- ============================================================
-- 5. the duties that hold the tracking module
-- ============================================================
--
-- 005 seeded `tracking.*` and nothing ever consumed it. This is that something. The keys
-- are re-issued idempotently in case a database was seeded before the module row existed,
-- and `tracking.edit` / `tracking.delete` are deliberately NOT granted: the ledger this
-- module reads cannot be edited or deleted by anyone, from any seat.

insert into permissions (key, description) values
  ('tracking.view',   'Live Tracking - View'),
  ('tracking.create', 'Live Tracking - Create')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, p.key
  from roles r
  join permissions p on p.key in ('tracking.view','tracking.create')
 where r.tenant_id is null
   and (r.key in ('director','general_manager','operations_manager','fleet_manager',
                  'dispatcher','auditor')
        -- The driver seat reports where the truck is and nothing else.
        or (r.key = 'driver' and p.key = 'tracking.create'))
on conflict do nothing;

commit;
