-- 025: Staff management — allow the portal to replace a member's role set.
-- user_roles is a pure assignment junction (no business history lives in it:
-- changes are audited), so DELETE is granted for it despite the blanket
-- soft-delete-only rule for entity tables.
begin;

grant delete on user_roles to app_runtime;

commit;
