begin;

-- ============================================================
-- 089: the two doors that let the office and the cargo floor ignore each other
-- ============================================================
--
-- The link has existed since 038: office_tasks.shipment_id is a job in the back
-- office that names a cargo file, and GET /office-tasks already returned that
-- file's number. What was missing was not a table. It was the read that starts
-- at the file, and the grants that let a working seat use either end of it.
--
-- The grants are the part that made the feature unreal. Read out of the live
-- matrix before this migration: shipments.% was held by director and auditor
-- only, office_tasks.% by director, auditor and hr_officer only, and messages.*
-- by the same three. Every other tenant role -- operations_manager,
-- general_manager, customer_service, dispatcher, the seats that actually work a
-- file -- held jobs.* and nothing else. So the CFA desk could open the job
-- pipeline for a file but not the file itself, and the office desk could not
-- see the file its own job was about. Concretely: /app/office/employees fetches
-- /cargo to fill its cargo-file picker, that call answered 403 for an HR seat,
-- and the page swallows non-ok responses, so the picker silently offered only
-- "No cargo file" with no reason on screen. Two teams were told they were
-- connected by a link neither of them could open.
--
-- This migration opens the doors that the request needs and no further:
--
--   shipments.view          the office seats and the file desks follow a file
--   office_tasks.view/create the desks that work files can see and hand out jobs
--   messages.view/send      the per-file conversation is the "reach" channel
--
-- Deliberately withheld. office_tasks.edit stays with the office: the CFA hands
-- a job over, it does not close it. employees.* stays away from the file desks
-- entirely -- the roster carries salary, date of birth and emergency contacts --
-- and the new /office-assignees read below is what they get instead: a name, a
-- job title, a department and how much is already on that person's plate.
-- shipments.create/edit/delete, employees.delete and every money key are
-- untouched. Director and auditor keep what they had.
--
-- The index is the other half. Every read this stage adds starts from
-- shipment_id, and office_tasks only carried (tenant_id, employee_id, status)
-- and (tenant_id, status, due_date). The table is small today, which is exactly
-- when an index is cheap and a seq scan is invisible; the file-keyed read is
-- meant to run on every cargo page, so it gets its own access path now rather
-- than after the first company with four thousand assignments.
--
-- No new table and no new column, on purpose. office_tasks.shipment_id already
-- says "this person, this file, this job", with the priority, deadline, flow
-- steps and punctuality grade attached. A parallel cargo-office request table
-- would have created a second answer to a question the database already
-- answers, and the two would have drifted.

create index if not exists idx_office_tasks_shipment
  on office_tasks (tenant_id, shipment_id)
  where shipment_id is not null;

-- The file side and the office side can each see the other's page of the work.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('shipments.view', 'messages.view', 'messages.send')
where r.tenant_id is null
  and r.key in ('general_manager', 'operations_manager', 'customer_service', 'dispatcher', 'hr_officer')
on conflict do nothing;

-- Handing a job to the back office is an act of the desk that owns the file.
insert into role_permissions (role_id, permission_key)
select r.id, p.key
from roles r
join permissions p on p.key in ('office_tasks.view', 'office_tasks.create')
where r.tenant_id is null
  and r.key in ('general_manager', 'operations_manager', 'customer_service')
on conflict do nothing;

commit;
