-- 087 — close the door Supabase left open on the churn register (task #155).
--
-- 086's own verify gate read the register's ACL out of the catalog and found a grant the
-- migration never made: `service_role` holds INSERT, SELECT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES and TRIGGER on `subscription_cancellations`. That is the database's default
-- privilege for a new table in `public`, and 086's revoke block listed `public, anon,
-- authenticated, app_runtime` — the list 078 used — but not `service_role`, which 085 had
-- learned to include.
--
-- Why it matters here and not everywhere: `service_role` is a BYPASSRLS role, so the row
-- security that is supposed to be the backstop for a table with no policies does not apply
-- to it at all. The register's whole design is that no handler can write a good churn month
-- into it — a reason-coded exit is a claim about money the office has lost, and a claim an
-- API key can overwrite is not a claim. RLS-without-policies stopped every role that can
-- hold a session; this stops the one it could not.
--
-- Nothing in this repository connects as `service_role`. The key behind it is configured for
-- Storage only (api/src/storage/supabase.ts), which does not read these tables, so revoking
-- its table privileges cannot break a running path.
--
-- Scope, and why it stops there: the same default grant exists on 103 public tables, so the
-- honest statement is that this is a catalog-wide posture question, not a 086 bug. This file
-- repairs the register this stage shipped, and the sweep of the other 102 is recorded as its
-- own hardening item rather than smuggled into a churn stage — revoking a login-capable
-- role's privileges across the whole schema on a production database is a change that should
-- be listed table by table before it is made, not after.
--
-- A new file rather than an edit to 086, for 079's reason: 086 is already recorded in
-- schema_migrations and will never run again, so an edit there would look right in the
-- repository and do nothing on the server.

begin;

-- Idempotent restatement of the grant 086 made, so this file is correct on a database that
-- ran 086 and on one that ran a patched copy of it.
grant execute on function
  platform_auth.cancel_subscription(uuid, text, text, uuid, text, text),
  platform_auth.churn_report(int),
  platform_auth.control_subscription_exits(uuid, int)
to app_runtime;

revoke all on subscription_cancellations
  from public, anon, authenticated, service_role, app_runtime;

revoke all on function
  platform_auth.cancel_subscription(uuid, text, text, uuid, text, text),
  platform_auth.churn_report(int),
  platform_auth.control_subscription_exits(uuid, int)
from public, anon, authenticated, service_role;

commit;
