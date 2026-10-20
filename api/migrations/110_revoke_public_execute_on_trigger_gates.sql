-- 110 — the four trigger functions 107–109 created are not callable by name (task #185).
--
-- 096 revoked PUBLIC EXECUTE from every app function then alive and pinned the posture with
-- `alter default privileges … revoke all on functions from public`. The revoke half holds. The
-- default half does not, and this run measured it rather than believed it: a function created
-- inside a rolled-back transaction, as `postgres`, in `public`, on this database arrives with
--
--   { "=X/postgres", "postgres=X/postgres", "service_role=X/postgres" }
--
-- even though `pg_default_acl` for (postgres, public, 'f') reads
--
--   { "postgres=X/postgres", "service_role=X/postgres" } — no PUBLIC.
--
-- So the birthright is still handed out at CREATE and the only durable guard is the catalog gate
-- in scripts/verify-privileges-sql.ts, which is exactly what 096's own header predicted ("the
-- durable half of this work is the gate … not this file"). That gate is what caught this: it ran
-- over a database that had just gained four PUBLIC-executable functions and said so, in a stage
-- whose own smoke had gone green.
--
-- WHAT IS ACTUALLY AT STAKE — said plainly, as in 096. `anon` and `authenticated` hold no USAGE
-- on either schema (051 took it), so no browser call reaches these by name; and all four are
-- trigger-shaped, so a direct SELECT could not do useful work with them anyway. The exposure is
-- `app_runtime`: it inherits PUBLIC's rights, so a route bug can `select public.leave_decision_shape()`
-- and read an answer the row's own guards were meant to be the only source of. Four functions,
-- three stages, one line each that nobody remembered — 107, 108 and 109 all wrote
-- `grant execute … to app_runtime` and stopped there.
--
-- Nothing here changes a trigger's own behaviour: EXECUTE for a trigger body is checked when the
-- trigger is created (096 recorded that), the grants below keep `app_runtime` able to fire them,
-- and the assertion at the bottom re-runs 096's completeness question so this file cannot be
-- half-done in silence.

begin;

-- Attendance proof (107), the leave route and its decision gate (108), the work order shape (109).
revoke execute on function public.attendance_proof_shape() from public, anon, authenticated;
revoke execute on function public.employee_leave_approver_seat() from public, anon, authenticated;
revoke execute on function public.leave_decision_shape() from public, anon, authenticated;
revoke execute on function public.work_order_shape() from public, anon, authenticated;

-- The API role keeps all four: these bodies run as the calling role inside the trigger, and a
-- grant here is the difference between a guard that fires and a 42501 on a legitimate write.
grant execute on function public.attendance_proof_shape() to app_runtime;
grant execute on function public.employee_leave_approver_seat() to app_runtime;
grant execute on function public.leave_decision_shape() to app_runtime;
grant execute on function public.work_order_shape() to app_runtime;

-- 096's statement, repeated because it is cheap and because the next Supabase bootstrap may put
-- PUBLIC back into the default list. It is not the fix — the gate is.
alter default privileges for role postgres in schema public
  revoke all on functions from public;
alter default privileges for role postgres in schema platform_auth
  revoke all on functions from public;

-- ---------------------------------------------------------------------------
-- Prove it, both directions, in the shape 096 used.
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
    raise exception '110 is incomplete — PUBLIC still holds EXECUTE on: %', v_leak
      using errcode = 'P0001';
  end if;

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

comment on function public.attendance_proof_shape() is
  'Before-insert/update gate on employee_attendance (107). Trigger function; since 110 EXECUTE-able by the owner, service_role and app_runtime only. 107 granted app_runtime and left PUBLIC the birthright.';
comment on function public.employee_leave_approver_seat() is
  'Resolves the seat a leave request is routed to (108). Trigger-adjacent guard; pinned by 110 for the same reason as the rest.';
comment on function public.leave_decision_shape() is
  'Freezes the route a decided leave request carries (108). Trigger function, pinned by 110.';
comment on function public.work_order_shape() is
  'The shape a work order must keep (109): who is named, what a closed row may not lose, and that a called-off job carries no cost. Trigger function, pinned by 110.';

commit;
