-- 079 — close the two doors 078 accidentally left open (task #127).
--
-- 078 had to re-declare two existing functions, and re-declaring a function in Postgres
-- means dropping it first when its row shape changes: `manual_activate` grew a
-- `p_service_group_key`, and `list_tenants_for_control` grew nine OUT columns, and a
-- wider OUT record cannot be laid over an existing one — "Row type defined by OUT
-- parameters is different ... Use DROP FUNCTION first".
--
-- A `create or replace` keeps the ACL it already had. A drop-and-create does not: the new
-- function comes back owned but granted to PUBLIC, because PUBLIC EXECUTE is the default
-- every object gets until told otherwise. 078's revoke block at the bottom listed the
-- five functions it created new and missed these two, so both became callable by any role
-- in the database — including `anon` and `authenticated`, the two roles a browser-side
-- client can reach through PostgREST. `list_tenants_for_control` is a SECURITY DEFINER
-- that returns every company's name, plan, seat count, licence expiry and block reason;
-- left open, that is a cross-tenant read of the whole customer base with no session and no
-- permission check.
--
-- This is a new file rather than an edit to 078 because 078 is already recorded in
-- schema_migrations and will never run again. An edit there would look correct in the
-- repository and do nothing on the server — the worst kind of fix.
--
-- Deliberately not swept: the catalog holds nine other PUBLIC-executable functions in
-- platform_auth (`office_task_gate`, `office_task_check_gate`, `office_task_step_gate`,
-- `trainee_report_gate`, `trainee_signoff_gate`, `payment_transition_allowed`,
-- `prevent_audit_mutation`, `prevent_job_mutation`, `tenant_is_operational`). They are not
-- SECURITY DEFINER, they take no tenant identity, and none of them returns a row — they
-- answer a yes/no about a value already in the statement that calls them, from inside a
-- trigger or a check. Revoking them would be a change with no leak behind it and a
-- production trigger path in front of it. This file names what broke and stops there.
--
-- Verified against the live catalog before writing: exactly `list_tenants_for_control(text)`,
-- `manual_activate(uuid,text,text,text,text,numeric,uuid,text)` and the stale 7-argument
-- `manual_activate` overload were the three definers in this schema reachable by PUBLIC
-- besides the nine above. The 7-argument overload is not PUBLIC-executable and 070's
-- verify suite asserts its existence, so it is left alone.

begin;

-- Idempotent restatement of the grant 078 already made, so this file is correct on a
-- database that ran 078 and on one that ran a patched copy of it.
grant execute on function
  platform_auth.manual_activate(uuid, text, text, text, text, numeric, uuid, text),
  platform_auth.list_tenants_for_control(text)
to app_runtime;

revoke all on function
  platform_auth.manual_activate(uuid, text, text, text, text, numeric, uuid, text),
  platform_auth.list_tenants_for_control(text)
from public, anon, authenticated, service_role;

commit;
