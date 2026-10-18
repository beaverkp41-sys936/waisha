-- 077: the Mtwara gazetteer row was seeded at -12.7856,40.1920, which is inside
-- Mozambique — Mtwara port city is -10.2667,40.1833. Every coastal corridor that
-- names it inherited the error, so a Dar es Salaam -> Mbamba Bay run traced over
-- 2 400 km of road that no truck drives. Corrected at the source here; 075 now
-- seeds it straight. Any stop already anchored to that town follows the fix.
begin;

update geo_places
   set lat = -10.2667, lng = 40.1833
 where name = 'Mtwara'
   and region_id = (select id from geo_regions where code = 'TZ-MTW')
   and (lat, lng) is distinct from (-10.2667, 40.1833);

-- A town-anchored stop keeps the town's coordinate, so re-read it from the
-- gazetteer instead of leaving the stale point on the map.
update route_stops rs
   set lat = p.lat, lng = p.lng
  from geo_places p
 where rs.place_id = p.id
   and rs.coord_source = 'town'
   and p.lat is not null and p.lng is not null
   and (rs.lat, rs.lng) is distinct from (p.lat, p.lng);

commit;
