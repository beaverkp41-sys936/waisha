-- 016: grants for profile/branches tables (012 created policies but missed grants)
begin;
grant select, insert, update on company_profiles to app_runtime;
grant select, insert, update on branches to app_runtime;
commit;