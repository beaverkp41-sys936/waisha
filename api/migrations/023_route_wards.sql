-- 023: Route ward columns. 021 was shipped empty, but routes.routes.ts
-- already joins and writes origin_ward_id / dest_ward_id — add them here.
begin;

alter table routes add column if not exists origin_ward_id int references geo_wards(id);
alter table routes add column if not exists dest_ward_id int references geo_wards(id);

commit;
