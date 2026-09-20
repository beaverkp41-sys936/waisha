-- 004: progressive (exponential) lockout support.
begin;
alter table users add column if not exists lockout_count int not null default 0;
commit;