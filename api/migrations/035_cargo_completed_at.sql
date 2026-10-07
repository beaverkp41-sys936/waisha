-- 035: Analytics foundations — stamp when a cargo file is completed so the
-- processing-time histogram measures real file lifetimes.
begin;

alter table cargo_shipments add column if not exists completed_at timestamptz;

commit;
