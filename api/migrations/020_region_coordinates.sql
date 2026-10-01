-- 020: Region centroid coordinates - enables haversine distance + map markers
begin;
alter table geo_regions add column if not exists lat numeric(9,6);
alter table geo_regions add column if not exists lng numeric(9,6);

-- Approximate regional centroids (city/town seats) - operator-verified, editable
update geo_regions set lat=-6.1630, lng=35.7516 where code='TZ-DOD';
update geo_regions set lat=-3.3869, lng=36.6830 where code='TZ-ARU';
update geo_regions set lat=-6.7924, lng=39.2083 where code='TZ-DAR';
update geo_regions set lat=-2.5164, lng=32.9175 where code='TZ-GEI';
update geo_regions set lat=-7.7750, lng=35.6900 where code='TZ-IRI';
update geo_regions set lat=-1.9499, lng=31.5855 where code='TZ-KAG';
update geo_regions set lat=-6.9767, lng=31.4180 where code='TZ-KAT';
update geo_regions set lat=-4.8764, lng=29.6264 where code='TZ-KIG';
update geo_regions set lat=-3.0674, lng=37.3556 where code='TZ-KIL';
update geo_regions set lat=-10.0250, lng=39.7000 where code='TZ-LIN';
update geo_regions set lat=-4.2160, lng=35.8000 where code='TZ-MAN';
update geo_regions set lat=-1.5000, lng=34.1500 where code='TZ-MAR';
update geo_regions set lat=-8.9097, lng=33.4607 where code='TZ-MBE';
update geo_regions set lat=-6.8210, lng=37.6613 where code='TZ-MOR';
update geo_regions set lat=-10.2667, lng=40.4000 where code='TZ-MTW';
update geo_regions set lat=-2.5164, lng=32.9022 where code='TZ-MWA';
update geo_regions set lat=-9.3333, lng=34.7500 where code='TZ-NJI';
update geo_regions set lat=-6.8000, lng=38.7000 where code='TZ-POA';
update geo_regions set lat=-8.0146, lng=31.7447 where code='TZ-RUK';
update geo_regions set lat=-10.6833, lng=34.7500 where code='TZ-RUV';
update geo_regions set lat=-3.6667, lng=33.4167 where code='TZ-SHW';
update geo_regions set lat=-2.8333, lng=34.0000 where code='TZ-SIM';
update geo_regions set lat=-6.3000, lng=34.7500 where code='TZ-SIN';
update geo_regions set lat=-7.8333, lng=33.0000 where code='TZ-SON';
update geo_regions set lat=-5.0167, lng=32.8000 where code='TZ-TAB';
update geo_regions set lat=-5.0667, lng=38.7500 where code='TZ-TAN';
update geo_regions set lat=-5.1500, lng=39.7833 where code='TZ-PKN';
update geo_regions set lat=-5.3167, lng=39.7500 where code='TZ-PKS';
update geo_regions set lat=-4.9000, lng=39.3000 where code='TZ-UKN';
update geo_regions set lat=-6.1630, lng=39.1979 where code='TZ-UKS';
update geo_regions set lat=-6.1833, lng=39.3000 where code='TZ-UMM';

commit;