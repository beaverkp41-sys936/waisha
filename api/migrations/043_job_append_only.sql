-- 043: append-only guards for the job evidence tables.
-- 042 already withholds UPDATE/DELETE from app_runtime on job_activity and
-- job_handovers; this makes immutability hold even if a later migration hands
-- the app role those privileges by mistake. The migration/owner role (the one
-- that bypasses RLS) may still purge, which is what test cleanup relies on.
begin;

create or replace function platform_auth.prevent_job_mutation() returns trigger
language plpgsql as $$ begin
  if exists (select 1 from pg_roles where rolname = current_user
              and (rolsuper or rolbypassrls)) then
    return coalesce(new, old);
  end if;
  raise exception '% is append-only', tg_table_name;
end $$;

do $$ begin
  create trigger job_activity_no_mutation
    before update or delete on job_activity
    for each row execute function platform_auth.prevent_job_mutation();
exception when others then null; -- already exists
end $$;

do $$ begin
  create trigger job_handovers_no_mutation
    before update or delete on job_handovers
    for each row execute function platform_auth.prevent_job_mutation();
exception when others then null;
end $$;

commit;
