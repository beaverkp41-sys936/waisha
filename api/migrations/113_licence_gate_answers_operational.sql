-- 113: the licence gate answers the question it is named after (spec 5.1, #129)
--
-- `platform_auth.tenant_is_operational()` has read `not exists (…operational…)` since 008,
-- so it returns true for a company that is NOT operational and false for one that is. The
-- single caller, GET /licence, publishes that value as `operational`, and both web reads
-- take it at face value: `gate.tsx` hides the countdown and prints "Trial ended — read-only"
-- on the first morning of a live 48-hour trial, while a company whose licence lapsed months
-- ago sees nothing at all, and `dashboard/page.tsx` never gets to call `trialRunning`.
--
-- Measured against the live catalog before this file was written: the two tenants holding a
-- future licence_expires_at answered false, and all three pending_verification tenants plus
-- the platform row answered true. Every row was backwards.
--
-- `active` with no recorded expiry is kept inside the operational set. Payment completion
-- (009) and manual activation (010/011/068) all write status and licence_expires_at in the
-- same statement, so an active row with a null date is one the office opened by hand — and
-- refusing it would lock out a seat that was just paid for, with no date on screen to tell
-- the person why. A recorded date in the past is a real lapse and stays outside.
--
-- The body is otherwise 008's, character for character: the three live states, the grace
-- window on an expired licence, and the current_setting lookup that scopes it to one tenant.
-- `create or replace` is deliberate — a drop-and-create would reset EXECUTE to PUBLIC and
-- undo 096's revoke (see the definer return-shape traps noted in 051).
begin;

create or replace function platform_auth.tenant_is_operational()
returns boolean language sql stable as $$
  select exists (
    select 1 from tenants t
    where t.id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and t.deleted_at is null
      and (
        -- trial running? operational
        (t.status = 'trial' and t.trial_ends_at > now())
        -- active licence? operational (an active row with no date was opened by hand)
        or (t.status = 'active' and (t.licence_expires_at is null or t.licence_expires_at > now()))
        -- grace window on expired licence? operational
        or (t.status = 'grace' and t.licence_expires_at + interval '3 days' > now())
      )
  )
 $$;

-- Grants survive the replace, but say them again: 096 revoked PUBLIC from this function
-- because a control desk that can ask "is this tenant live?" for any tenant id it can put
-- into app.tenant_id is reading a commercial fact it has no duty for.
grant execute on function platform_auth.tenant_is_operational() to app_runtime;
revoke execute on function platform_auth.tenant_is_operational()
  from public, anon, authenticated, service_role;

comment on function platform_auth.tenant_is_operational() is
  'True while the tenant in app.tenant_id holds a live trial, licence or grace window. '
  'Read by GET /licence and rendered as the trial banner; 008 shipped the test inverted.';

commit;
