-- 014: Ward level (Kata) - completes the hierarchy Mkoa -> Wilaya -> Kata
-- (ledger 14). Backs the cascading pickers and structured position reports.
begin;

create table if not exists geo_wards (
  id serial primary key,
  district_id int not null references geo_districts(id) on delete cascade,
  name text not null,
  unique (district_id, name)
);

create index idx_geo_wards_district on geo_wards (district_id);

grant select on geo_wards to app_runtime;
alter table geo_wards enable row level security;
create policy geo_wards_read on geo_wards for select to app_runtime using (true);

commit;