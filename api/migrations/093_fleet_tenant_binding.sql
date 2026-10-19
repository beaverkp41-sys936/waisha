-- 093 — bind the three fleet registers to one company each (task #172 follow-up).
--
-- 092 gave every row a `tenant_id` and a policy that scopes reads and writes to it, which is
-- how the whole platform has worked since 002. It is not enough for these three tables, and
-- the reason is the shape of what they record: a handover is a *pair* — this vehicle, this
-- driver — and a ledger row is a vehicle at a place. Each half of the pair can be bound to the
-- company; nothing in the catalog said the two halves belong to the *same* company. So a route
-- that forgot one `and tenant_id = $2` in a lookup would write a valid-looking row joining
-- another company's truck to this company's driver, and RLS would let it through, because the
-- row's own tenant_id is honest about the half it knows.
--
-- Both doors that write these rows do bind the tenant today (fleet.routes checks the vessel and
-- the driver; the driver-profile mirror in operations/fleet.ts checks both), and the register
-- has been live since 092 with zero rows in it. That is exactly the moment to make the pairing
-- a constraint rather than a convention: 092 argued that "one driver per vehicle" belongs in the
-- database because a route that forgets is a truck in two hands. Same argument, same table.
--
-- The composite key needs a unique index on the parent side first. `(id, tenant_id)` on a table
-- whose `id` is already the primary key cannot add information — it only gives the child a pair
-- to point at, so the pair can be checked.

begin;

create unique index if not exists drivers_id_tenant_uq on drivers (id, tenant_id);
create unique index if not exists vessels_id_tenant_uq on vessels (id, tenant_id);
create unique index if not exists trips_id_tenant_uq on trips (id, tenant_id);

-- The register: a handover pairs a vehicle and a driver from the same company, once.
alter table vessel_assignments
  add constraint vessel_assignments_vessel_tenant_fkey
  foreign key (vessel_id, tenant_id) references vessels (id, tenant_id);
alter table vessel_assignments
  add constraint vessel_assignments_driver_tenant_fkey
  foreign key (driver_id, tenant_id) references drivers (id, tenant_id);

-- The ledger: a report is one of this company's vehicles, optionally carried by one of its
-- drivers, on one of its trips. A null trip or driver stays unenforced, as it must.
alter table vessel_positions
  add constraint vessel_positions_vessel_tenant_fkey
  foreign key (vessel_id, tenant_id) references vessels (id, tenant_id);
alter table vessel_positions
  add constraint vessel_positions_driver_tenant_fkey
  foreign key (driver_id, tenant_id) references drivers (id, tenant_id);
alter table vessel_positions
  add constraint vessel_positions_trip_tenant_fkey
  foreign key (trip_id, tenant_id) references trips (id, tenant_id);

-- The logbook: a journal line belongs to this company's plate.
alter table vessel_log_entries
  add constraint vessel_log_entries_vessel_tenant_fkey
  foreign key (vessel_id, tenant_id) references vessels (id, tenant_id);

do $$ declare
  v_rows int;
begin
  select count(*)::int into v_rows from vessel_assignments;
  -- One literal: RAISE takes a format string, and a plpgsql `||` continuation here is a
  -- syntax error, not a concatenation (092 learned this the same way).
  raise notice '093: the three fleet registers are now paired to one company each; the assignment register holds % row(s)', v_rows;
end $$;

commit;
