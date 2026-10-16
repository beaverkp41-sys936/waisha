-- 051_default_privilege_lockdown: close the Supabase default-grant leak at its
-- source. The bootstrap sets DEFAULT PRIVILEGES so that every object created by
-- `postgres` in schema public inherits rights for the browser API roles:
--   tables     -> anon/authenticated/service_role = ALL
--   sequences  -> anon/authenticated             = rwU  (nextval is writable!)
--   functions  -> anon/authenticated             = X    (EXECUTE, incl. our
--              SECURITY DEFINER functions — the leak 049 had to patch by hand)
-- The API never connects as those roles (it uses app_runtime through the pooler)
-- and schema public USAGE is already revoked from them, so nothing in the
-- product depends on these rights. They are removed anyway so that a future
-- object cannot be reachable if PostgREST/browser exposure of schema public is
-- ever switched on. service_role keeps its defaults: it is the role behind the
-- Supabase dashboard's own API access and revoking it costs operator tooling.
begin;

-- ---------- 1. stop future inheritance ----------
alter default privileges for role postgres in schema public
  revoke all on tables   from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;

-- ---------- 2. revoke what already leaked ----------
-- Sequences: every one of the seven public sequences was inherited rwU, so
-- anon could burn invoice numbers (invoice_number_seq) and shift geo ids.
-- Enumerated from the catalog instead of hard-coded so re-running is a no-op
-- and any sequence created before this migration is covered.
do $$
declare r record;
begin
  for r in
    select c.oid::regclass as seq
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
      and exists (
        select 1 from aclexplode(c.relacl) a
        where a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid))
  loop
    execute format('revoke all on sequence %s from anon, authenticated', r.seq);
  end loop;
end $$;

-- Functions: same leak, applied to any SECURITY DEFINER or plain function in
-- public that still carries an anon/authenticated EXECUTE entry.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and exists (
        select 1 from aclexplode(p.proacl) a
        where a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid))
  loop
    execute format('revoke all on function %s from anon, authenticated', r.fn);
  end loop;
end $$;

-- Tables: already clean (041/049 shape), swept here for completeness.
do $$
declare r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and exists (
        select 1 from aclexplode(c.relacl) a
        where a.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid))
  loop
    execute format('revoke all on table %s from anon, authenticated', r.tbl);
  end loop;
end $$;

-- ---------- 3. SECURITY DEFINER functions must not inherit PUBLIC EXECUTE ----------
-- Every pre-auth helper in platform_auth was created by postgres, so Postgres
-- wrote the default "execute to PUBLIC" entry into its ACL the first time it
-- was granted. PUBLIC includes anon and authenticated, so those helpers —
-- complete_payment, claim_trial, consume_otp, lookup_*_login, rotate_refresh,
-- manual_activate and the rest — were callable by any role that inherits
-- PUBLIC, once schema access exists. app_runtime is granted explicitly below,
-- so the API surface is unchanged; the owner always keeps execute.
-- SECURITY INVOKER trigger functions (set_updated_at, prevent_audit_mutation,
-- prevent_job_mutation) are deliberately untouched: they run as the invoking
-- role and must stay executable by app_runtime.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'platform_auth') and p.prosecdef
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.fn);
    execute format('grant execute on function %s to app_runtime', r.fn);
  end loop;
end $$;

commit;
