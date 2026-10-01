-- 018: Marine vessels - cargo_ship, ferry, tank_barge + marine fields (spec 6.3, 14)
begin;

alter table vessels drop constraint vessels_vessel_type_check;
alter table vessels add constraint vessels_vessel_type_check check (vessel_type in
  ('truck_head','trailer','tanker','flatbed','tipper','reefer','box_truck','van','pickup',
   'lowbed','barge','boat','rail_wagon','cargo_ship','ferry','tank_barge'));

alter table vessels add column if not exists imo_number text;
alter table vessels add column if not exists home_port text;
alter table vessels add column if not exists water_body text
  check (water_body in ('lake_victoria','lake_tanganyika','lake_nyasa','indian_ocean','river'));

commit;