-- 096 — no application function is callable by name from outside (task #215).
--
-- 073 revoked PUBLIC EXECUTE on `payroll_derive` and nothing else. A catalog probe
-- (follows the 051/079 shape, uses has_function_privilege + aclexplode grantee 0) found
-- 21 functions in `public` and `platform_auth` still handed to PUBLIC, among them three
-- of payroll's own gates. The list is not payroll's and never was: it is every stage that
-- wrote a trigger and stopped at the grant.
--
-- HOW EXPOSED THIS ACTUALLY IS — stated plainly, because the fix is worth less than a
-- scare. `anon` and `authenticated` hold no USAGE on either schema (051 took it), so
-- `select public.period_working_days(...)` as a browser role already died with
-- `42501 permission denied for schema public` before reaching the function. And 17 of the
-- 21 are trigger-shaped: a direct SELECT cannot call them whatever the ACL says. So this
-- is not a hole somebody can walk through today.
--
-- What it does mean, and why it is worth a migration:
--   * `app_runtime` inherits PUBLIC's rights, so a route bug can call a gate directly —
--     `select platform_auth.tenant_is_operational()` or `public.payroll_run_gate()` — and
--     read an answer the table's own guards were supposed to be the only source of.
--   * The leak regenerates. No migration ever granted EXECUTE to PUBLIC (grep the folder:
--     every `grant execute` in this schema history targets app_runtime); CREATE FUNCTION
--     hands it out at birth, so any stage that forgets the revoke reopens this exact hole.
--     073 pinned `payroll_derive` and 095 pinned the three gates it rewrites, which left
--     072's two run gates and its working-day divisor handing themselves to PUBLIC — the
--     module's own history is four stages, each fixing the functions it touched.
--   * The ACL is not sticky: a drop-and-recreate of a definer resets EXECUTE to PUBLIC.
--     So the durable half of this work is the gate in verify-privileges-sql.ts, not this
--     file. This file only gets the posture to a clean line.
--
-- One function was wrong in the other direction: `directory_listing_tenant_guard` is
-- owner-only, so `app_runtime` cannot execute it at all. Its trigger still fires — Postgres
-- checks EXECUTE when the trigger is created, not when it runs — which is why 061's writes
-- worked and why nobody noticed. A guard whose body the API role cannot call is a trap for
-- the next stage that wants it in a policy or a route, so it is pinned here like the rest.
--
-- Nothing is revoked from `service_role`: it is the operator key, 051 left its defaults
-- deliberately, and its functions are the Supabase ones, not these.

begin;

-- ---------------------------------------------------------------------------
-- THE SWEEP — revoke the birthright, then grant the one role that needs it
-- ---------------------------------------------------------------------------
-- Written out per function on purpose. A DO block over pg_proc would also catch whatever
-- appears between now and the run, but it would silently decide the posture for functions
-- nobody read; the assertion at the bottom of this file gets the completeness instead.

-- Payroll (072 created these three; 073 pinned only its own two).
revoke execute on function public.payroll_run_gate() from public, anon, authenticated;
revoke execute on function public.payroll_run_starts_draft() from public, anon, authenticated;
revoke execute on function public.period_working_days(p_period date) from public, anon, authenticated;

-- Attendance and leave (065).
revoke execute on function public.attendance_no_future() from public, anon, authenticated;
revoke execute on function public.attendance_stamp_lateness() from public, anon, authenticated;
revoke execute on function public.leave_no_overlap() from public, anon, authenticated;
revoke execute on function public.leave_stamp_working_days() from public, anon, authenticated;
revoke execute on function public.working_days_between(p_from date, p_to date) from public, anon, authenticated;

-- Tax returns (090) and debit notes (058-era).
revoke execute on function public.tax_return_gate() from public, anon, authenticated;
revoke execute on function public.tax_return_starts_draft() from public, anon, authenticated;
revoke execute on function public.debit_note_gate() from public, anon, authenticated;

-- The office flow gates (038, 056) and the two append-only guards (004, 042, 084).
revoke execute on function platform_auth.office_task_gate() from public, anon, authenticated;
revoke execute on function platform_auth.office_task_step_gate() from public, anon, authenticated;
revoke execute on function platform_auth.office_task_check_gate() from public, anon, authenticated;
revoke execute on function platform_auth.trainee_report_gate() from public, anon, authenticated;
revoke execute on function platform_auth.trainee_signoff_gate() from public, anon, authenticated;
revoke execute on function platform_auth.prevent_audit_mutation() from public, anon, authenticated;
revoke execute on function platform_auth.prevent_job_mutation() from public, anon, authenticated;

-- Two readers the routes call by name (080, 048).
revoke execute on function platform_auth.tenant_is_operational() from public, anon, authenticated;
revoke execute on function platform_auth.payment_transition_allowed(p_from text, p_to text) from public, anon, authenticated;

-- The timestamp helper behind 68 triggers.
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- The API role keeps every one of them: a trigger's own write path must stay open, and a
-- route that names a reader must not start 42501-ing.  One statement per function, because
-- GRANT does not take a list of functions.
grant execute on function public.payroll_run_gate() to app_runtime;
grant execute on function public.payroll_run_starts_draft() to app_runtime;
grant execute on function public.period_working_days(p_period date) to app_runtime;
grant execute on function public.attendance_no_future() to app_runtime;
grant execute on function public.attendance_stamp_lateness() to app_runtime;
grant execute on function public.leave_no_overlap() to app_runtime;
grant execute on function public.leave_stamp_working_days() to app_runtime;
grant execute on function public.working_days_between(p_from date, p_to date) to app_runtime;
grant execute on function public.tax_return_gate() to app_runtime;
grant execute on function public.tax_return_starts_draft() to app_runtime;
grant execute on function public.debit_note_gate() to app_runtime;
grant execute on function public.set_updated_at() to app_runtime;
grant execute on function public.directory_listing_tenant_guard() to app_runtime;
grant execute on function platform_auth.office_task_gate() to app_runtime;
grant execute on function platform_auth.office_task_step_gate() to app_runtime;
grant execute on function platform_auth.office_task_check_gate() to app_runtime;
grant execute on function platform_auth.trainee_report_gate() to app_runtime;
grant execute on function platform_auth.trainee_signoff_gate() to app_runtime;
grant execute on function platform_auth.prevent_audit_mutation() to app_runtime;
grant execute on function platform_auth.prevent_job_mutation() to app_runtime;
grant execute on function platform_auth.tenant_is_operational() to app_runtime;
grant execute on function platform_auth.payment_transition_allowed(p_from text, p_to text) to app_runtime;

-- ---------------------------------------------------------------------------
-- Stop handing the birthright out again.  This is the half that keeps 096 true
-- after the next migration; if Supabase's bootstrap owns the record and will not
-- let this run, the assertion below still catches every leak and 097 pins them.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke all on functions from public;
alter default privileges for role postgres in schema platform_auth
  revoke all on functions from public;

-- ---------------------------------------------------------------------------
-- Prove the sweep is complete, in both directions.
-- ---------------------------------------------------------------------------
do $$
declare
  v_leak text;
  v_unbound text;
begin
  select string_agg(x.fn, ', ' order by x.fn) into v_leak from (
    select n.nspname || '.' || p.proname || '(' ||
           coalesce(pg_get_function_identity_arguments(p.oid), '') || ')' as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'platform_auth')
       and p.prokind = 'f'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and (p.proacl is null
            or exists (select 1 from aclexplode(p.proacl) a
                        where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
  ) x;
  if v_leak is not null then
    raise exception '096 is incomplete — PUBLIC still holds EXECUTE on: %', v_leak
      using errcode = 'P0001';
  end if;

  -- Every function a trigger on an app table fires must be callable by the API role.
  select string_agg(distinct x.fn, ', ' order by x.fn) into v_unbound from (
    select p.proname as fn
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not t.tgisinternal
       and not has_function_privilege('app_runtime', p.oid, 'EXECUTE')
  ) x;
  if v_unbound is not null then
    raise exception 'app_runtime cannot execute a function its own triggers fire: %', v_unbound
      using errcode = 'P0001';
  end if;
end $$;

comment on function public.payroll_run_gate() is
  'Before-update gate on payroll_runs (072). Trigger function, and since 096 EXECUTE-able by the owner and app_runtime only — PUBLIC was never meant to call it and the 073 revoke covered only payroll_derive.';
comment on function public.directory_listing_tenant_guard() is
  'Trigger guard on directory_listings (061). 096 pinned it to app_runtime: until then it was owner-only, and only worked because Postgres checks EXECUTE when a trigger is created, not when it fires.';

commit;
