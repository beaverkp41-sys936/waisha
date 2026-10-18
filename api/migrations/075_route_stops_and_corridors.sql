-- 075: Nationwide route builder - town gazetteer, main-corridor options and
-- ordered per-route stops (origin / via* / destination).
--
-- Why a gazetteer: geo_regions carries lat/lng (020) but the 201 councils and
-- 4,771 wards carry none, so every ward-level origin could only ever be traced
-- from its region centroid. geo_places anchors the towns, junctions, ports and
-- border posts a transporter actually names, so a stop resolves to a town
-- instead of a region. Coordinates are approximate town centroids and are
-- operator-editable reference data - the same convention as 020 - and OSRM
-- snaps each anchor onto the real road network. No third-party geocoder is
-- called: the gazetteer is the coordinate source.
begin;

-- ============================
-- TOWN / JUNCTION GAZETTEER (reference data, ledger 14)
-- ============================
create table if not exists geo_places (
  id serial primary key,
  country text not null default 'TZ',
  region_id int not null references geo_regions(id),
  name text not null,
  kind text not null check (kind in ('city','town','junction','port','border')),
  lat numeric(9,6) not null,
  lng numeric(9,6) not null,
  unique (region_id, name)
);
create index idx_geo_places_name on geo_places (name);

grant select on geo_places to app_runtime;
alter table geo_places enable row level security;
create policy geo_places_read on geo_places for select to app_runtime using (true);

insert into geo_places (region_id, name, kind, lat, lng)
select r.id, v.name, v.kind, v.lat, v.lng
from (values
 -- Dar es Salaam
 ('TZ-DAR','Dar es Salaam','city',-6.8235,39.2695),
 ('TZ-DAR','Ubungo','junction',-6.7833,39.2167),
 ('TZ-DAR','Tegeta','town',-6.7500,39.2167),
 ('TZ-DAR','Kigamboni','town',-6.8747,39.2723),
 ('TZ-DAR','Mbezi Beach','town',-6.7333,39.2333),
 -- Pwani
 ('TZ-POA','Kibaha','junction',-6.7833,38.9667),
 ('TZ-POA','Chalinze','junction',-6.4333,38.5167),
 ('TZ-POA','Mlandizi','town',-6.6500,38.8167),
 ('TZ-POA','Bagamoyo','town',-6.4353,38.9047),
 ('TZ-POA','Vikindu','town',-7.0000,39.1667),
 ('TZ-POA','Mkuranga','town',-7.0950,39.1047),
 ('TZ-POA','Mafia','port',-7.9000,39.7167),
 -- Lindi (the whole coastal A18 south of Dar)
 ('TZ-LIN','Kisiju','junction',-7.4167,39.3500),
 ('TZ-LIN','Kilwa Kivinje','port',-8.5500,39.5667),
 ('TZ-LIN','Kilwa','town',-8.9597,39.5067),
 ('TZ-LIN','Mahonda','town',-9.4833,39.7333),
 ('TZ-LIN','Lindi','town',-10.0003,39.7002),
 ('TZ-LIN','Matiri','town',-10.0833,39.1667),
 ('TZ-LIN','Nachingwea','junction',-10.3500,38.7667),
 ('TZ-LIN','Ruangwa','town',-11.2500,38.7667),
 ('TZ-LIN','Liwale','town',-8.6333,38.0500),
 -- Mtwara
 ('TZ-MTW','Mtwara','port',-10.2667,40.1833),
 ('TZ-MTW','Nanyamba','town',-11.2833,39.9167),
 ('TZ-MTW','Newala','town',-11.0500,39.2833),
 ('TZ-MTW','Masasi','junction',-10.9833,38.8333),
 ('TZ-MTW','Tandahimba','town',-11.1500,38.9333),
 -- Ruvuma (the Lake Nyasa end of the southern network)
 ('TZ-RUV','Tunduru','town',-11.1833,36.3500),
 ('TZ-RUV','Songea','city',-10.6833,35.6500),
 ('TZ-RUV','Namtumbo','town',-10.0333,34.7000),
 ('TZ-RUV','Mbinga','town',-10.5500,35.2667),
 ('TZ-MTW','Mbamba Bay','port',-10.6500,34.4833),
 -- Morogoro
 ('TZ-MOR','Morogoro','city',-6.8210,37.6613),
 ('TZ-MOR','Ujani','junction',-7.3833,37.5333),
 ('TZ-MOR','Kidatu','junction',-7.0833,37.6333),
 ('TZ-MOR','Kilosa','town',-7.5167,36.9667),
 ('TZ-MOR','Mwanheda','junction',-7.1333,36.6500),
 ('TZ-MOR','Berege','town',-6.9333,36.2167),
 ('TZ-MOR','Malinyi','town',-7.7500,37.1333),
 ('TZ-MOR','Mlimba','town',-8.5667,36.8333),
 ('TZ-MOR','Ifakara','town',-8.3333,36.6833),
 -- Dodoma
 ('TZ-DOD','Dodoma','city',-6.1630,35.7516),
 ('TZ-DOD','Mpwapwa','town',-6.8500,36.0500),
 ('TZ-DOD','Bahi','town',-6.2000,35.6667),
 ('TZ-DOD','Chamwino','town',-6.0167,35.3500),
 ('TZ-DOD','Kondoa','town',-5.0333,35.7833),
 -- Manyara
 ('TZ-MAN','Babati','town',-4.2167,35.7500),
 ('TZ-MAN','Manyara','junction',-3.5833,35.8000),
 ('TZ-MAN','Mto wa Mbu','town',-3.3667,35.8333),
 -- Arusha / Kilimanjaro
 ('TZ-ARU','Arusha','city',-3.3869,36.6830),
 ('TZ-ARU','Monduli','town',-3.4333,36.3667),
 ('TZ-ARU','Namanga','border',-2.5667,36.8500),
 ('TZ-KIL','Moshi','city',-3.3333,37.3333),
 ('TZ-KIL','Same','town',-4.1333,37.7667),
 ('TZ-KIL','Horohoro','border',-3.1167,37.8500),
 -- Tanga
 ('TZ-TAN','Tanga','port',-5.0689,39.1047),
 ('TZ-TAN','Muheza','town',-5.3833,38.7667),
 ('TZ-TAN','Pangani','town',-5.7667,38.5667),
 ('TZ-TAN','Korogwe','junction',-5.4667,37.6500),
 ('TZ-TAN','Handeni','town',-5.2833,37.6667),
 -- Iringa / Njombe
 ('TZ-IRI','Mafinga','town',-7.2333,35.7333),
 ('TZ-IRI','Iringa','city',-7.7750,35.6900),
 ('TZ-IRI','Kilolo','town',-8.7000,35.9167),
 ('TZ-IRI','Mahanje','junction',-8.6667,35.3333),
 ('TZ-NJI','Makambako','junction',-8.9500,34.6667),
 ('TZ-NJI','Njombe','town',-9.3333,34.7667),
 -- Mbeya / Songwe
 ('TZ-MBE','Chimala','town',-9.1000,34.2500),
 ('TZ-MBE','Mbeya','city',-8.9097,33.4607),
 ('TZ-MBE','Kyela','town',-9.7667,33.8333),
 ('TZ-MBE','Rungwe','town',-9.8667,33.6667),
 ('TZ-SON','Watesa','town',-9.3833,32.9833),
 ('TZ-SON','Tunduma','border',-9.2833,32.7667),
 ('TZ-SON','Songwe','border',-10.0000,33.3333),
 -- Lake zone
 ('TZ-TAB','Tabora','city',-5.0167,32.8000),
 ('TZ-TAB','Igunga','town',-4.3833,33.7167),
 ('TZ-TAB','Nzega','town',-4.6667,33.3333),
 ('TZ-TAB','Kaliua','town',-5.1667,31.8000),
 ('TZ-SHW','Shinyanga','city',-3.6667,33.4333),
 ('TZ-SHW','Kahama','town',-3.8333,32.6000),
 ('TZ-SIM','Bariadi','town',-2.7667,33.9833),
 ('TZ-SIM','Isebania','border',-2.4167,34.1500),
 ('TZ-MWA','Mwanza','port',-2.5167,32.9000),
 ('TZ-MWA','Magu','town',-2.2833,33.0667),
 ('TZ-MAR','Musoma','port',-1.6667,33.7500),
 ('TZ-MAR','Tarime','town',-1.9500,34.4167),
 ('TZ-KAG','Bukoba','port',-1.3333,31.8000),
 ('TZ-KAG','Mutukula','border',-2.2833,31.9167),
 ('TZ-KAG','Rusumo','border',-2.4167,30.5667),
 ('TZ-KIG','Kasulu','town',-4.3333,29.7667),
 ('TZ-KIG','Uvinza','town',-5.1833,30.1167),
 ('TZ-KIG','Kigoma','port',-4.8764,29.6264),
 ('TZ-KAT','Mpanda','town',-6.3667,31.4333),
 ('TZ-GEI','Geita','town',-2.8667,32.2500),
 ('TZ-SIN','Singida','town',-4.8087,34.7833),
 ('TZ-SIN','Manyoni','town',-5.8833,35.1667),
 ('TZ-RUK','Sumbawanga','town',-7.9667,31.6333),
 -- Zanzibar and Pemba
 ('TZ-UMM','Zanzibar (Stone Town)','port',-6.1659,39.1989),
 ('TZ-UKS','Kizimkazi','town',-6.4000,39.1333),
 ('TZ-PKN','Wete','town',-5.0233,39.7333),
 ('TZ-PKS','Chake Chake','town',-5.2500,39.7667),
 ('TZ-PKS','Mkoani','port',-5.6833,39.6667)
) as v(region_code, name, kind, lat, lng)
join geo_regions r on r.code = v.region_code
on conflict (region_id, name) do nothing;

-- ============================
-- MAIN CORRIDOR OPTIONS (operator-curated anchor chains)
-- A corridor is a suggestion, not a road: the map still traces the actual
-- tarmac between these anchors. It exists so that a pair like Dar es Salaam /
-- Mbamba Bay offers the coastal Lindi-Mtwara run *and* the inland
-- Morogoro-Iringa-Makambako-Njombe run instead of only whichever one the
-- router happens to return.
-- ============================
create table if not exists geo_corridors (
  id serial primary key,
  name text not null unique,
  kind text not null default 'main' check (kind in ('main','feeder')),
  origin_region_id int not null references geo_regions(id),
  dest_region_id int not null references geo_regions(id),
  notes text
);
create index idx_geo_corridors_od on geo_corridors (origin_region_id, dest_region_id);

create table if not exists geo_corridor_stops (
  id serial primary key,
  corridor_id int not null references geo_corridors(id) on delete cascade,
  seq int not null,
  region_id int not null references geo_regions(id),
  place_id int references geo_places(id),
  label text,
  unique (corridor_id, seq)
);

grant select on geo_corridors, geo_corridor_stops to app_runtime;
alter table geo_corridors enable row level security;
alter table geo_corridor_stops enable row level security;
create policy geo_corridors_read on geo_corridors for select to app_runtime using (true);
create policy geo_corridor_stops_read on geo_corridor_stops for select to app_runtime using (true);

insert into geo_corridors (name, kind, origin_region_id, dest_region_id, notes)
select v.name, v.kind, o.id, d.id, v.notes
from (values
 ('Dar es Salaam - Mbamba Bay, southern coastal', 'main', 'TZ-DAR', 'TZ-MTW',
  'A18 coast road through Kilwa, Lindi and Mtwara, then inland via Masasi and Mbinga to Mbamba Bay.'),
 ('Dar es Salaam - Mbamba Bay, inland highlands', 'main', 'TZ-DAR', 'TZ-MTW',
  'Morogoro, Iringa, Makambako, Njombe and Songea - the inland alternative to the coast road.'),
 ('Dar es Salaam - Mbeya, via Iringa and Makambako', 'main', 'TZ-DAR', 'TZ-MBE',
  'Trunk road through Morogoro, Iringa and the Makambako junction.'),
 ('Dar es Salaam - Tunduma (Zambia), via Mbeya', 'main', 'TZ-DAR', 'TZ-SON',
  'The Zambezi road: Morogoro, Iringa, Makambako, Mbeya, Watesa.'),
 ('Dar es Salaam - Arusha / Namanga (Kenya), via Dodoma', 'main', 'TZ-DAR', 'TZ-ARU',
  'Northern gateway through Morogoro, Dodoma, Babati and Manyara.'),
 ('Dar es Salaam - Arusha, via Tanga and Korogwe', 'main', 'TZ-DAR', 'TZ-ARU',
  'Coastal-northern alternative through Tanga and the Korogwe junction.'),
 ('Dar es Salaam - Mwanza, via Dodoma and Babati', 'main', 'TZ-DAR', 'TZ-MWA',
  'Lake Victoria route through Dodoma, Babati and Magu.'),
 ('Dar es Salaam - Kigoma, via Dodoma and Tabora', 'main', 'TZ-DAR', 'TZ-KIG',
  'Western lake and rail route through Dodoma, Singida and Tabora.'),
 ('Dodoma - Mbeya, via Manyoni and Singida', 'main', 'TZ-DOD', 'TZ-MBE',
  'The cross-country centre road, avoiding the Dar es Salaam bottleneck.'),
 ('Mwanza - Kigoma, via Shinyanga', 'feeder', 'TZ-MWA', 'TZ-KIG',
  'Lake-port link through Shinyanga and Uvinza.')
) as v(name, kind, ocode, dcode, notes)
join geo_regions o on o.code = v.ocode
join geo_regions d on d.code = v.dcode
on conflict (name) do nothing;

insert into geo_corridor_stops (corridor_id, seq, region_id, place_id, label)
select c.id, v.seq, r.id, p.id, v.label
from (values
 -- coastal Dar -> Mbamba Bay
 ('Dar es Salaam - Mbamba Bay, southern coastal', 1, 'TZ-POA', 'Kibaha', 'Kibaha'),
 ('Dar es Salaam - Mbamba Bay, southern coastal', 2, 'TZ-LIN', 'Kisiju', 'Kisiju'),
 ('Dar es Salaam - Mbamba Bay, southern coastal', 3, 'TZ-LIN', 'Kilwa', 'Kilwa'),
 ('Dar es Salaam - Mbamba Bay, southern coastal', 4, 'TZ-LIN', 'Lindi', 'Lindi'),
 ('Dar es Salaam - Mbamba Bay, southern coastal', 5, 'TZ-LIN', 'Nachingwea', 'Nachingwea'),
 ('Dar es Salaam - Mbamba Bay, southern coastal', 6, 'TZ-MTW', 'Mtwara', 'Mtwara port'),
 ('Dar es Salaam - Mbamba Bay, southern coastal', 7, 'TZ-MTW', 'Masasi', 'Masasi'),
 ('Dar es Salaam - Mbamba Bay, southern coastal', 8, 'TZ-RUV', 'Mbinga', 'Mbinga'),
 ('Dar es Salaam - Mbamba Bay, southern coastal', 9, 'TZ-MTW', 'Mbamba Bay', 'Mbamba Bay port'),
 -- inland Dar -> Mbamba Bay
 ('Dar es Salaam - Mbamba Bay, inland highlands', 1, 'TZ-MOR', 'Morogoro', 'Morogoro'),
 ('Dar es Salaam - Mbamba Bay, inland highlands', 2, 'TZ-IRI', 'Iringa', 'Iringa'),
 ('Dar es Salaam - Mbamba Bay, inland highlands', 3, 'TZ-NJI', 'Makambako', 'Makambako junction'),
 ('Dar es Salaam - Mbamba Bay, inland highlands', 4, 'TZ-NJI', 'Njombe', 'Njombe'),
 ('Dar es Salaam - Mbamba Bay, inland highlands', 5, 'TZ-RUV', 'Songea', 'Songea'),
 ('Dar es Salaam - Mbamba Bay, inland highlands', 6, 'TZ-RUV', 'Mbinga', 'Mbinga'),
 ('Dar es Salaam - Mbamba Bay, inland highlands', 7, 'TZ-MTW', 'Mbamba Bay', 'Mbamba Bay port'),
 -- Dar -> Mbeya
 ('Dar es Salaam - Mbeya, via Iringa and Makambako', 1, 'TZ-MOR', 'Morogoro', 'Morogoro'),
 ('Dar es Salaam - Mbeya, via Iringa and Makambako', 2, 'TZ-IRI', 'Iringa', 'Iringa'),
 ('Dar es Salaam - Mbeya, via Iringa and Makambako', 3, 'TZ-NJI', 'Makambako', 'Makambako junction'),
 ('Dar es Salaam - Mbeya, via Iringa and Makambako', 4, 'TZ-NJI', 'Njombe', 'Njombe'),
 -- Dar -> Tunduma
 ('Dar es Salaam - Tunduma (Zambia), via Mbeya', 1, 'TZ-MOR', 'Morogoro', 'Morogoro'),
 ('Dar es Salaam - Tunduma (Zambia), via Mbeya', 2, 'TZ-IRI', 'Iringa', 'Iringa'),
 ('Dar es Salaam - Tunduma (Zambia), via Mbeya', 3, 'TZ-NJI', 'Makambako', 'Makambako junction'),
 ('Dar es Salaam - Tunduma (Zambia), via Mbeya', 4, 'TZ-MBE', 'Mbeya', 'Mbeya'),
 ('Dar es Salaam - Tunduma (Zambia), via Mbeya', 5, 'TZ-SON', 'Watesa', 'Watesa'),
 -- Dar -> Arusha via Dodoma
 ('Dar es Salaam - Arusha / Namanga (Kenya), via Dodoma', 1, 'TZ-MOR', 'Morogoro', 'Morogoro'),
 ('Dar es Salaam - Arusha / Namanga (Kenya), via Dodoma', 2, 'TZ-DOD', 'Dodoma', 'Dodoma'),
 ('Dar es Salaam - Arusha / Namanga (Kenya), via Dodoma', 3, 'TZ-MAN', 'Babati', 'Babati'),
 ('Dar es Salaam - Arusha / Namanga (Kenya), via Dodoma', 4, 'TZ-MAN', 'Manyara', 'Manyara hot springs'),
 ('Dar es Salaam - Arusha / Namanga (Kenya), via Dodoma', 5, 'TZ-ARU', 'Arusha', 'Arusha'),
 -- Dar -> Arusha via Tanga
 ('Dar es Salaam - Arusha, via Tanga and Korogwe', 1, 'TZ-POA', 'Chalinze', 'Chalinze'),
 ('Dar es Salaam - Arusha, via Tanga and Korogwe', 2, 'TZ-TAN', 'Tanga', 'Tanga'),
 ('Dar es Salaam - Arusha, via Tanga and Korogwe', 3, 'TZ-TAN', 'Korogwe', 'Korogwe junction'),
 ('Dar es Salaam - Arusha, via Tanga and Korogwe', 4, 'TZ-ARU', 'Monduli', 'Monduli'),
 -- Dar -> Mwanza
 ('Dar es Salaam - Mwanza, via Dodoma and Babati', 1, 'TZ-MOR', 'Morogoro', 'Morogoro'),
 ('Dar es Salaam - Mwanza, via Dodoma and Babati', 2, 'TZ-DOD', 'Dodoma', 'Dodoma'),
 ('Dar es Salaam - Mwanza, via Dodoma and Babati', 3, 'TZ-MAN', 'Babati', 'Babati'),
 ('Dar es Salaam - Mwanza, via Dodoma and Babati', 4, 'TZ-MWA', 'Magu', 'Magu'),
 -- Dar -> Kigoma
 ('Dar es Salaam - Kigoma, via Dodoma and Tabora', 1, 'TZ-DOD', 'Dodoma', 'Dodoma'),
 ('Dar es Salaam - Kigoma, via Dodoma and Tabora', 2, 'TZ-SIN', 'Manyoni', 'Manyoni'),
 ('Dar es Salaam - Kigoma, via Dodoma and Tabora', 3, 'TZ-SIN', 'Singida', 'Singida'),
 ('Dar es Salaam - Kigoma, via Dodoma and Tabora', 4, 'TZ-TAB', 'Tabora', 'Tabora'),
 ('Dar es Salaam - Kigoma, via Dodoma and Tabora', 5, 'TZ-KIG', 'Uvinza', 'Uvinza'),
 -- Dodoma -> Mbeya
 ('Dodoma - Mbeya, via Manyoni and Singida', 1, 'TZ-SIN', 'Manyoni', 'Manyoni'),
 ('Dodoma - Mbeya, via Manyoni and Singida', 2, 'TZ-SIN', 'Singida', 'Singida'),
 ('Dodoma - Mbeya, via Manyoni and Singida', 3, 'TZ-MBE', 'Chimala', 'Chimala'),
 -- Mwanza -> Kigoma
 ('Mwanza - Kigoma, via Shinyanga', 1, 'TZ-SHW', 'Shinyanga', 'Shinyanga'),
 ('Mwanza - Kigoma, via Shinyanga', 2, 'TZ-KIG', 'Uvinza', 'Uvinza')
) as v(cname, seq, rcode, pname, label)
join geo_corridors c on c.name = v.cname
join geo_regions r on r.code = v.rcode
left join geo_places p on p.name = v.pname and p.region_id = r.id
on conflict (corridor_id, seq) do nothing;

-- ============================
-- PER-ROUTE STOPS (tenant data)
-- seq 1 is the origin and the highest seq the destination; every number in
-- between is a VIA stop in the order the truck passes it. A stop is what the
-- transporter filled in - region, council, ward, a gazetteer town, and the
-- village or street as they write it - plus the coordinate the trace used and
-- where that coordinate came from, so a coarse pin is never mistaken for a
-- surveyed one.
-- ============================
create table if not exists route_stops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  route_id uuid not null references routes(id) on delete cascade,
  seq int not null,
  kind text not null check (kind in ('origin','via','dest')),
  region_id int references geo_regions(id),
  district_id int references geo_districts(id),
  ward_id int references geo_wards(id),
  place_id int references geo_places(id),
  place text,
  lat numeric(9,6),
  lng numeric(9,6),
  coord_source text check (coord_source in ('pin','town','region_centroid')),
  created_at timestamptz not null default now(),
  unique (route_id, seq),
  check ((lat is null) = (lng is null))
);
create index idx_route_stops_route on route_stops (route_id, seq);

alter table route_stops enable row level security;
create policy route_stops_tenant on route_stops for all to app_runtime
  using (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid);
grant select, insert, update, delete on route_stops to app_runtime;

-- The traced anchors and the traced line stay on the route so the register and
-- the trip can show the same path the builder drew. Geometry is the OSRM (or
-- estimated) polyline as [[lat,lng],...]; origin/dest coordinates let a saved
-- route map to its town instead of its region centroid.
alter table routes add column if not exists origin_lat numeric(9,6);
alter table routes add column if not exists origin_lng numeric(9,6);
alter table routes add column if not exists dest_lat numeric(9,6);
alter table routes add column if not exists dest_lng numeric(9,6);
alter table routes add column if not exists geometry jsonb;
alter table routes add column if not exists routed_at timestamptz;
alter table routes add column if not exists route_source text
  check (route_source in ('osrm','estimate'));

commit;
