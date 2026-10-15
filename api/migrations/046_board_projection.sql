-- 046: Notice board read path (spec Part 2, step 1 "appears on the notice board").
--
-- RULE 0 boundary, enforced in the database. Step 4 gave every tenant an
-- INSERT/SELECT/UPDATE policy scoped to its own rows, so a transporter has no
-- relation-level right to read another company's transport_requests. The board
-- is the one place that must read across tenants, so it goes through a
-- SECURITY DEFINER function whose result type is a fixed composite:
--
--   * app_runtime gets EXECUTE only -- never SELECT -- so "read the board" is
--     the only cross-tenant capability it has at all;
--   * the columns a caller can receive are the columns of board_card, declared
--     here. Adding a column to transport_requests (a later wave, or the booking
--     fields of step 6) publishes nothing until board_card itself is widened,
--     which is a visible migration;
--   * only status = 'open' and deleted_at is null rows exist in the result, so
--     a booked, confirmed or withdrawn request cannot be listed;
--   * the only join is to geo_regions, which is global reference data with a
--     "using (true)" policy -- no cargo file, job, invoice, document or user
--     table is reachable from here.
--
-- tenant_id, job_id, shipment_id, route_id, contact_user_id, disclosed_by and
-- the lifecycle stamps are deliberately NOT in board_card: a card can identify
-- the load it offers without handing out another company's keys.
begin;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'board_card') then
    execute $ty$
create type board_card as (
  id uuid,

  -- cargo details (physical only)
  cargo_label text,
  container_type text,
  container_count int,
  weight_tonnes numeric,
  cbm numeric,
  vehicle_types text[],

  -- route copy + the map geometry the card is drawn from
  route_label text,
  distance_km int,
  expected_duration_hours int,
  pickup_text text,
  dest_text text,
  via_label text,
  required_date text,
  pickup_region_id int,
  pickup_region_name text,
  pickup_lat numeric,
  pickup_lng numeric,
  dest_region_id int,
  dest_region_name text,
  dest_lat numeric,
  dest_lng numeric,

  -- what the CFA chose to disclose
  contact_name text,
  contact_channel text,
  public_note text,

  -- the CFA's professional card, copied at publish time
  company_name text,
  company_description text,
  company_services text,
  company_corridors text,
  company_website text,
  fleet_size_declared int,
  year_established int,

  disclosed_at timestamptz,
  total int
);$ty$;
  end if;
end $$;

-- ---------- The board list: filters applied server-side, paging bounded ----------
create or replace function board_requests(
  p_vehicle text,
  p_region_id int,
  p_from date,
  p_to date,
  p_search text,
  p_limit int,
  p_offset int
) returns setof board_card
language plpgsql stable security definer set search_path = public as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 40), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  return query
    with found as (
      select t.id, t.cargo_label, t.container_type, t.container_count,
             t.weight_tonnes, t.cbm, t.vehicle_types,
             t.route_label, t.distance_km, t.expected_duration_hours,
             t.pickup_text, t.dest_text, t.via_label,
             t.required_date::text as required_date,
             t.pickup_region_id, pr.name_en as pickup_region_name,
             pr.lat as pickup_lat, pr.lng as pickup_lng,
             t.dest_region_id, dr.name_en as dest_region_name,
             dr.lat as dest_lat, dr.lng as dest_lng,
             t.contact_name, t.contact_channel, t.public_note,
             t.company_name, t.company_description, t.company_services,
             t.company_corridors, t.company_website, t.fleet_size_declared,
             t.year_established, t.disclosed_at,
             count(*) over ()::int as total
        from transport_requests t
        left join geo_regions pr on pr.id = t.pickup_region_id
        left join geo_regions dr on dr.id = t.dest_region_id
       where t.status = 'open' and t.deleted_at is null
         and (p_vehicle is null or t.vehicle_types @> array[p_vehicle]::text[])
         and (p_region_id is null or t.pickup_region_id = p_region_id
              or t.dest_region_id = p_region_id)
         and (p_from is null or t.required_date >= p_from)
         and (p_to is null or t.required_date <= p_to)
         and (p_search is null
              or t.cargo_label ilike '%' || p_search || '%'
              or t.pickup_text ilike '%' || p_search || '%'
              or t.dest_text ilike '%' || p_search || '%'
              or t.via_label ilike '%' || p_search || '%'
              or t.company_name ilike '%' || p_search || '%')
       order by t.required_date, t.disclosed_at desc, t.id
    )
    select f.* from found f limit v_limit offset v_offset;
end $$;

-- ---------- One card, by id. 'open' or nothing. ----------
create or replace function board_request_card(p_id uuid) returns board_card
language sql stable security definer set search_path = public as $$
  select t.id, t.cargo_label, t.container_type, t.container_count,
         t.weight_tonnes, t.cbm, t.vehicle_types,
         t.route_label, t.distance_km, t.expected_duration_hours,
         t.pickup_text, t.dest_text, t.via_label,
         t.required_date::text as required_date,
         t.pickup_region_id, pr.name_en as pickup_region_name,
         pr.lat as pickup_lat, pr.lng as pickup_lng,
         t.dest_region_id, dr.name_en as dest_region_name,
         dr.lat as dest_lat, dr.lng as dest_lng,
         t.contact_name, t.contact_channel, t.public_note,
         t.company_name, t.company_description, t.company_services,
         t.company_corridors, t.company_website, t.fleet_size_declared,
         t.year_established, t.disclosed_at,
         1 as total
    from transport_requests t
    left join geo_regions pr on pr.id = t.pickup_region_id
    left join geo_regions dr on dr.id = t.dest_region_id
   where t.id = p_id and t.status = 'open' and t.deleted_at is null
$$;

revoke all on function board_requests(text, int, date, date, text, int, int) from public;
revoke all on function board_request_card(uuid) from public;
grant execute on function board_requests(text, int, date, date, text, int, int) to app_runtime;
grant execute on function board_request_card(uuid) to app_runtime;
comment on function board_requests(text, int, date, date, text, int, int) is
  'RULE 0: the only cross-tenant read in the app. Returns board_card columns only.';

-- Board filters run on the open slice; GIN keeps a truck-type filter an index scan.
create index if not exists idx_board_open_date
  on transport_requests (required_date, disclosed_at desc)
  where status = 'open' and deleted_at is null;
create index if not exists idx_board_open_vehicle
  on transport_requests using gin (vehicle_types)
  where status = 'open' and deleted_at is null;

-- ---------- Permissions ----------
insert into permissions (key, description)
values ('board.view', 'Notice board - Browse transport requests from other companies')
on conflict do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, 'board.view'
from roles r
where r.key in ('director', 'operations_manager', 'general_manager', 'dispatcher')
  and r.tenant_id is null
on conflict do nothing;

commit;
