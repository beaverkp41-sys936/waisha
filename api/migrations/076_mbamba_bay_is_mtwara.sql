-- 076: Mbamba Bay sits on Lake Nyasa in Mtwara Region (Nanyuka district), not in
-- Ruvuma. 075 anchored it to the wrong Mkoa, which left the two Dar es Salaam ->
-- Mbamba Bay corridors pointing at Ruvuma and ending inland at Mbinga — so the
-- pair the transporter actually asked about offered nothing. Corrected here for
-- databases that already ran 075; 075 itself now seeds it straight.
begin;

update geo_places
   set region_id = (select id from geo_regions where code = 'TZ-MTW')
 where name = 'Mbamba Bay'
   and region_id <> (select id from geo_regions where code = 'TZ-MTW');

update geo_corridors
   set dest_region_id = (select id from geo_regions where code = 'TZ-MTW'),
       notes = replace(notes, 'then inland via Masasi to Mbinga.',
                       'then inland via Masasi and Mbinga to Mbamba Bay.')
 where name ilike 'Dar es Salaam - Mbamba Bay%';

-- Both chains must actually finish at the port they are named for.
insert into geo_corridor_stops (corridor_id, seq, region_id, place_id, label)
select c.id, coalesce(x.last_seq, 0) + 1, p.region_id, p.id, 'Mbamba Bay port'
  from geo_corridors c
  join geo_places p on p.name = 'Mbamba Bay'
  left join lateral (
    select max(s.seq) as last_seq from geo_corridor_stops s where s.corridor_id = c.id
  ) x on true
 where c.name ilike 'Dar es Salaam - Mbamba Bay%'
   and not exists (select 1 from geo_corridor_stops s
                    where s.corridor_id = c.id and s.place_id = p.id);

-- A stop that names a town follows the town's own region.
update route_stops rs
   set region_id = p.region_id
  from geo_places p
 where rs.place_id = p.id
   and rs.region_id is distinct from p.region_id;

commit;
