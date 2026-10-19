/**
 * Live proof for #174's follow-up — the southern gazetteer anchors and the corridor
 * filings that depend on them (migration 091).
 *
 * A route builder has one honest claim: a named town resolves to where that town is.
 * Nothing in a type system or a schema can check that, so this script checks it against
 * geography — every gazetteer row must sit within 350 km of its own region centroid. The
 * bound is deliberately wide: Lindi, Morogoro and Songwe are tall regions, which puts
 * Kisiju a legitimate 293 km from its centroid. Mbamba Bay sat 648 km away, and no region
 * in the country is that tall — that is a wrong region, not a wide one.
 *
 * The second half is the join the builder actually runs. `/geo/corridors` answers
 * `coalesce(p.lat, r.lat)` and the web matches an anchor to the operator's chosen region,
 * so an anchor whose region differs from its town's region silently offers a centroid
 * hundreds of km from the destination the corridor is naming. That invariant is asserted
 * across every corridor, not just the two this migration touched.
 *
 * Run: npx tsx scripts/verify-geo-anchor.ts
 */
import "dotenv/config";
import pg from "pg";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  if (ok) console.log("ok   ", label);
  else { failures++; console.log("FAIL ", label,
    (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500)); }
}

const haversineKm = (aLat: number, aLng: number, bLat: number, bLng: number) => {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
};

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await owner.connect();
  const q = (sql: string, params: any[] = []) => owner.query(sql, params);

  const regions = await q(`select code, name_en, lat::float as lat, lng::float as lng from geo_regions`);
  const centroid = new Map(regions.rows.map(r => [r.code, r]));

  // ---------- the two corrected anchors ----------
  for (const [name, lat, lng, region] of [
    ["Mbinga", -10.9411, 35.0000, "TZ-RUV"],
    ["Mbamba Bay", -11.2833, 34.7717, "TZ-RUV"]
  ] as const) {
    const r = await q(
      `select p.name, p.lat::float as lat, p.lng::float as lng, g.code as region_code
         from geo_places p join geo_regions g on g.id = p.region_id
        where p.name = $1`, [name]);
    check(`${name}: exactly one gazetteer row`, r.rowCount === 1, r.rows);
    if (r.rowCount !== 1) continue;
    const x = r.rows[0];
    check(`${name} is filed under ${region}`, x.region_code === region, x.region_code);
    check(`${name} carries its published position`,
      Math.abs(x.lat - lat) < 0.01 && Math.abs(x.lng - lng) < 0.01, { lat: x.lat, lng: x.lng });
    const c = centroid.get(region) as any;
    check(`${name} is near its own region's centroid, not just near the numbers in this file`,
      haversineKm(x.lat, x.lng, c.lat, c.lng) < 200,
      `${Math.round(haversineKm(x.lat, x.lng, c.lat, c.lng))} km from ${region}`);
  }

  // ---------- the invariant that caught it ----------
  const drift = await q(
    `select p.name, p.lat::float as lat, p.lng::float as lng, g.name_en,
            g.lat::float as rlat, g.lng::float as rlng
       from geo_places p join geo_regions g on g.id = p.region_id
      where g.lat is not null`);
  const off = drift.rows.filter(x => haversineKm(x.lat, x.lng, x.rlat, x.rlng) > 350);
  check(`every gazetteer anchor sits within 350 km of its own region centroid (${drift.rows.length} checked)`,
    off.length === 0,
    off.map(x => `${x.name} in ${x.name_en} ${Math.round(haversineKm(x.lat, x.lng, x.rlat, x.rlng))} km`));

  // ---------- the join /geo/corridors runs ----------
  const anchors = await q(
    `select c.name as corridor, s.seq, s.label, s.region_id, p.name as place, p.region_id as place_region
       from geo_corridor_stops s
       join geo_corridors c on c.id = s.corridor_id
       join geo_places p on p.id = s.place_id
      where s.region_id is distinct from p.region_id`);
  check("no corridor anchor names a region other than its town's region", anchors.rowCount === 0,
    anchors.rows.map(x => `${x.corridor} #${x.seq} ${x.place}: anchor ${x.region_id} vs town ${x.place_region}`));

  const unresolved = await q(
    `select c.name, s.seq, s.label from geo_corridor_stops s
       join geo_corridors c on c.id = s.corridor_id
       join geo_regions r on r.id = s.region_id
      where s.place_id is null and r.lat is null`);
  check("every anchor resolves to a coordinate (town or region centroid)", unresolved.rowCount === 0,
    unresolved.rows);

  // ---------- the two Mbamba Bay corridors are now offered to the right pair ----------
  const corr = await q(
    `select c.name,
            (select g.code from geo_regions g where g.id = c.origin_region_id) as ocode,
            (select g.code from geo_regions g where g.id = c.dest_region_id) as dcode,
            (select p.name from geo_corridor_stops s
               join geo_places p on p.id = s.place_id
              where s.corridor_id = c.id order by s.seq desc limit 1) as last_town
       from geo_corridors c where c.name like 'Dar es Salaam - Mbamba Bay%' order by c.id`);
  check("both Mbamba Bay corridors exist", corr.rowCount === 2, corr.rowCount);
  for (const x of corr.rows) {
    check(`"${x.name}" runs TZ-DAR -> TZ-RUV`, x.ocode === "TZ-DAR" && x.dcode === "TZ-RUV",
      { ocode: x.ocode, dcode: x.dcode });
    check(`"${x.name}" ends at Mbamba Bay, not at a region centroid`,
      x.last_town === "Mbamba Bay", x.last_town);
  }

  // ---------- the pair the operator picks is the pair that must answer ----------
  const pair = await q(
    `select count(*)::int as n from geo_corridors c
       join geo_regions o on o.id = c.origin_region_id
       join geo_regions d on d.id = c.dest_region_id
      where (o.code = 'TZ-DAR' and d.code = 'TZ-RUV') or (o.code = 'TZ-RUV' and d.code = 'TZ-DAR')`);
  check("Dar es Salaam <-> Ruvuma offers both corridors in either direction",
    pair.rows[0].n === 2, pair.rows[0]);

  // ---------- nobody's saved route was silently moved ----------
  const touched = await q(
    `select count(*)::int as n from route_stops s
       join geo_places p on p.id = s.place_id
      where p.name in ('Mbamba Bay','Mbinga')`);
  check("no tenant route stop points at either corrected town (so no saved route moved)",
    touched.rows[0].n === 0, touched.rows[0]);

  await owner.end();
  console.log(failures === 0 ? "\ngeographic anchors clean" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
