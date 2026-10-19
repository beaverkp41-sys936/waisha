-- 091 — the southern end of the gazetteer was filed in the wrong region (task #174 follow-up).
--
-- The route builder offers a corridor only for the pair of *regions* the operator picked
-- (geo_corridors.origin_region_id / dest_region_id), and the anchors it loads resolve through
-- geo_places.region_id. Both facts were broken at one end of one corridor: 075 seeded Mbamba
-- Bay under TZ-MTW, 165 km east and 70 km north of where the town sits, and Mbinga 40 km north
-- of its true position. Mbamba Bay is in Mbinga District, Ruvuma Region, on Lake Nyasa.
--
-- What that cost a real booking:
--  * Dar es Salaam -> Ruvuma offered no corridor at all, because the two Mbamba Bay corridors
--    were registered against Mtwara. An operator heading to the lake had to type every anchor.
--  * Dar es Salaam -> Mtwara offered a corridor whose last anchor was a town in another region,
--    and the coordinates the trace used were the invented ones — so the drawn road left the
--    road network 200 km short of the destination it was naming.
--  * geo_places is read by the town picker as a per-region list, so "Mbamba Bay" appeared under
--    Mtwara and was missing from Ruvuma.
--
-- No geometry is invented here: the two positions are the published town coordinates, the same
-- kind of approximate centroid 075 documented for every other gazetteer row. A distance audit
-- over all 100 places (verify-geo-anchor.ts) now requires every anchor to sit within 350 km of
-- its own region centroid. That bound is wide on purpose — Lindi, Morogoro and Songwe are tall
-- regions, so Kisiju's 293 km is honest geography. Mbamba Bay's 648 km was not: no region in the
-- country is that tall.
--
-- Tenant data is untouched and needed no repair: the audit found zero route_stops rows pointing
-- at either place, so no saved route's stored coordinate changes under anyone.
--
-- A new file rather than an edit to 075, for 087's reason: 075 is recorded in schema_migrations
-- and will never run again, so an edit there would look right in the repository and do nothing
-- on the server.

begin;

-- Mbinga, Ruvuma: 10°56′28″S 35°0′0″E
update geo_places set lat = -10.941100, lng = 35.000000
 where name = 'Mbinga'
   and region_id = (select id from geo_regions where code = 'TZ-RUV');

-- Mbamba Bay, Ruvuma: 11°17′0″S 34°46′18″E — the town and its region, both wrong in 075.
-- Matched on (name, Mtwara) so the move happens once and re-running this file changes nothing.
update geo_places set lat = -11.283300, lng = 34.771700,
                      region_id = (select id from geo_regions where code = 'TZ-RUV')
 where name = 'Mbamba Bay'
   and region_id = (select id from geo_regions where code = 'TZ-MTW');

-- The two corridor anchors that point at it still name Mtwara as their region, and the web
-- builder matches an anchor to the operator's chosen region — so they move with the town.
update geo_corridor_stops s set region_id = p.region_id
 from geo_places p
 where s.place_id = p.id and p.name = 'Mbamba Bay'
   and s.region_id is distinct from p.region_id;

-- Register the two Mbamba Bay corridors against the region their far anchor is in, so the
-- Dar es Salaam -> Ruvuma pair offers them.
update geo_corridors c set dest_region_id = p.region_id
 from geo_places p
 where p.name = 'Mbamba Bay' and c.name like 'Dar es Salaam - Mbamba Bay%'
   and c.dest_region_id is distinct from p.region_id;

commit;
