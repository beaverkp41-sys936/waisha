-- 064: the service group a company asks for when it signs up.
--
-- 060 seeded the three bundles the platform sells (transport+CFA+office,
-- transport+office, CFA+office) with a price ladder the control panel edits, but
-- nothing in the schema recorded which one a new company wanted. The signup form had
-- one company tab and no room to answer, so a clearing & forwarding company registered
-- as a hauler and the office learned what it had actually bought from a phone call.
--
-- This column is the REQUEST, not the sale. What was sold already lives in
-- subscriptions.service_group_id (060), written by the activation path with the money
-- next to it; a signup cannot assert that, because at signup the account is still
-- pending_verification and no subscription row exists yet. Keeping both is the point:
-- the admin panel can count what people asked for, compare it against what was
-- activated, and a wrong answer at the door never rewrites a billing history.
--
-- Nullable with no default, so every tenant that registered before this migration
-- stays "not answered" rather than being silently assigned the most expensive bundle.

alter table tenants
  add column if not exists service_group_id uuid references service_groups(id);

comment on column tenants.service_group_id is
  'Bundle chosen at sign-up (060). A request; what was sold is subscriptions.service_group_id.';

-- The admin panel groups companies by this column; without it every report is a scan.
create index if not exists idx_tenants_service_group
  on tenants (service_group_id) where service_group_id is not null;
