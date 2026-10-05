-- 026: Data foundations for shipper-facing fleet details and staff profiles.
begin;

-- Physical properties shippers need for load planning (alongside capacity).
alter table vessels add column if not exists gross_weight_kg numeric(10,2);
alter table vessels add column if not exists length_m numeric(6,2);
alter table vessels add column if not exists width_m numeric(6,2);
alter table vessels add column if not exists height_m numeric(6,2);

-- Staff rank / job title on member profiles.
alter table users add column if not exists job_title text;

commit;
