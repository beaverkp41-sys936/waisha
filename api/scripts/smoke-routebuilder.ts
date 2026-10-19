/**
 * End-to-end smoke for the nationwide route builder (migration 075): the town
 * gazetteer, both corridor options for Dar es Salaam -> Mbamba Bay, a chain of
 * origin + VIA + destination stops with three coordinate tiers, the ordered
 * stop rows, the multi-waypoint road trace, and the guards that refuse a stop
 * with no coordinate or a chain in the wrong order. It also proves the degraded
 * path: a corridor the road network cannot answer still saves, and is stored as
 * the estimate it is. Tenant isolation is proven
 * through the API and, when the app role is available, against route_stops RLS.
 *
 * Runs against a booted API on port 4000. Hard-deletes every route it creates
 * through the owner connection, scoped to the fixture name.
 *
 * Run: npx tsx scripts/smoke-routebuilder.ts
 */
import "dotenv/config";
import pg from "pg";
import { SignJWT } from "jose";

const API = "http://localhost:4000/api/v1";
const key = new TextEncoder().encode(process.env.JWT_SECRET!);
const FIXTURE = "SMOKE BUILDER Dar - Mbamba Bay";

async function mint(sub: string, tid: string, roles: string[] = ["director"]) {
  return new SignJWT({ tid, sid: "00000000-0000-7000-8000-0000000000cc", typ: roles[0], roles })
    .setProtectedHeader({ alg: "HS256" }).setSubject(sub)
    .setIssuedAt().setExpirationTime("15m").sign(key);
}

async function call(path: string, token: string | null, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "ok   " : "FAIL "} ${label}${ok || detail === undefined ? "" : " — " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}
const code = (j: any) => j?.error?.code ?? j?.code ?? null;

async function sweep(owner: pg.Client, tid: string) {
  await owner.query("delete from routes where tenant_id = $1 and name like $2",
    [tid, "SMOKE BUILDER%"]);
}

async function main() {
  const owner = new pg.Client({
    connectionString: process.env.MIGRATE_DATABASE_URL, ssl: { rejectUnauthorized: false }
  });
  await owner.connect();

  const who = await owner.query(
    `select u.id as user_id, u.tenant_id from users u
     where u.user_type = 'director' and u.status = 'active' and u.deleted_at is null
       and exists (select 1 from company_profiles cp where cp.tenant_id = u.tenant_id)
     order by u.created_at limit 1`);
  if (!who.rowCount) throw new Error("No active director with a company profile found");
  const { user_id, tenant_id } = who.rows[0];
  console.log(`route-builder tenant ${tenant_id} as director ${user_id}`);

  const geo = await owner.query(
    `select id, code, name_en, lat, lng from geo_regions
      where lower(name_en) like 'dar%' or lower(name_en) like 'mtwara%' or lower(name_en) like 'lindi%'
      order by name_en`);
  const region = (pick: string) => geo.rows.find(r => r.name_en.toLowerCase().includes(pick));
  const dar = region("dar"), mtwara = region("mtwara"), lindi = region("lindi");
  if (!dar || !mtwara || !lindi) throw new Error("Regions missing from geo_regions");

  const gaz = await owner.query(
    `select count(*)::int as n, count(*) filter (where kind = 'port')::int as ports,
            count(*) filter (where name = 'Mbamba Bay')::int as mbamba
       from geo_places`);
  check("the gazetteer is seeded with the southern towns",
    gaz.rows[0].n > 60 && gaz.rows[0].mbamba === 1, gaz.rows[0]);

  await sweep(owner, tenant_id);
  const token = await mint(user_id, tenant_id);
  const strangerToken = await mint(user_id, "00000000-0000-7000-8000-000000000000");

  // A ward in Dar, for the ward-level columns the builder still records.
  const district = await owner.query(
    "select id, name_en from geo_districts where region_id = $1 order by id limit 1", [dar.id]);
  const ward = district.rowCount
    ? await owner.query("select id, name from geo_wards where district_id = $1 order by id limit 1",
        [district.rows[0].id])
    : null;

  const towns = await owner.query(
    `select id, name, region_id, lat, lng from geo_places
      where name = any(array['Mbamba Bay','Kilwa','Lindi','Mtwara','Makambako']) order by name`);
  const town = (n: string) => towns.rows.find(r => r.name === n);

  try {
    // ---------- Gazetteer search through the API ----------
    const search = await call("/geo/places?q=Mbamb", token);
    check("the gazetteer answers a partial town search",
      search.status === 200 && search.json.some((p: any) => p.name === "Mbamba Bay"
        && p.region_id === mtwara.id),
      [search.status, search.json?.slice?.(0, 3)]);
    const byRegion = await call(`/geo/places?regionId=${mtwara.id}&limit=60`, token);
    check("a region lists its own towns",
      byRegion.status === 200 && byRegion.json.length > 0
        && byRegion.json.every((p: any) => p.region_id === mtwara.id),
      byRegion.json?.length);

    // ---------- Corridor options: the user's exact example ----------
    const corridors = await call(
      `/geo/corridors?originRegionId=${dar.id}&destRegionId=${mtwara.id}`, token);
    const names: string[] = (corridors.json ?? []).map((c: any) => c.name);
    check("Dar -> Mbamba Bay offers two different corridors",
      corridors.status === 200 && corridors.json.length >= 2, names);
    const coastal = (corridors.json ?? []).find((c: any) => /coastal/i.test(c.name));
    const inland = (corridors.json ?? []).find((c: any) => /inland|highland/i.test(c.name));
    const chainOf = (c: any) => (c?.stops ?? []).map((s: any) => s.label).join(" > ");
    const coastalChain = chainOf(coastal);
    check("one option runs the coast through Lindi and Mtwara and ends at the port",
      /lindi/i.test(coastalChain) && /mtwara/i.test(coastalChain) && /Mbamba Bay/i.test(coastalChain),
      coastalChain);
    check("the other runs inland through Morogoro, Iringa and Njombe",
      /iringa/i.test(chainOf(inland)) && /makambako|njombe/i.test(chainOf(inland)), chainOf(inland));
    const backwards = await call(
      `/geo/corridors?originRegionId=${mtwara.id}&destRegionId=${dar.id}`, token);
    const backChain = chainOf((backwards.json ?? []).find((c: any) => c.id === coastal?.id));
    check("the same corridor reads back-to-front when the trip is reversed",
      backwards.status === 200 && !!backChain && backChain === chainOf(coastal).split(" > ").reverse().join(" > "),
      backChain);

    // ---------- Build a chain: origin with a pin, two VIA towns, a town destination ----------
    const pin = { lat: -6.8253, lng: 39.2145 };
    const stops = [
      { kind: "origin", regionId: dar.id, districtId: district.rows[0]?.id ?? null,
        wardId: ward?.rows[0]?.id ?? null, place: "Vingunguti, Msimoz P.O. Box 12" ,
        lat: pin.lat, lng: pin.lng },
      { kind: "via", regionId: lindi.id, placeId: town("Kilwa")?.id ?? null, place: "Kivinikoniko storages" },
      { kind: "via", regionId: mtwara.id, placeId: town("Mtwara")?.id ?? null },
      { kind: "dest", regionId: mtwara.id, placeId: town("Mbamba Bay")?.id ?? null,
        place: "Mbamba Bay lakeside depot" }
    ];
    const made = await call("/routes", token, post({
      name: FIXTURE, corridor: "Southern Coastal (smoke)",
      distanceKm: 1290, expectedDurationHours: 22, roadClass: "A108/T1 mix",
      ratePerKm: 1800, stops
    }));
    check("the chain is accepted", made.status === 201 && !!made.json?.id, [made.status, made.json]);
    const id: string = made.json?.id;

    const detail = await call(`/routes/${id}`, token);
    const st: any[] = detail.json?.stops ?? [];
    check("every stop is stored in order with its kind",
      st.length === 4 && st[0].kind === "origin" && st[1].kind === "via"
        && st[2].kind === "via" && st[3].kind === "dest"
        && st.map(s => s.seq).join() === "1,2,3,4",
      st.map(s => [s.seq, s.kind, s.place_name ?? s.place]));
    check("the pin tier is recorded against the origin and the towns against the rest",
      st[0]?.coord_source === "pin" && st[1]?.coord_source === "town"
        && st[2]?.coord_source === "town" && st[3]?.coord_source === "town",
      st.map(s => s.coord_source));
    check("the origin keeps the exact pinned coordinate, not a region centre",
      Math.abs(Number(st[0]?.lat) - pin.lat) < 1e-5 && Math.abs(Number(st[0]?.lng) - pin.lng) < 1e-5,
      [st[0]?.lat, st[0]?.lng]);
    check("the destination resolves to Mbamba Bay on the map",
      Number(st[3]?.lat) < -10 && Number(st[3]?.lng) > 34, [st[3]?.lat, st[3]?.lng]);
    check("the ward and village text survive on the origin",
      st[0]?.ward_id === ward?.rows[0]?.id && String(st[0]?.place).startsWith("Vingunguti"),
      [st[0]?.ward_id, st[0]?.place]);
    check("a stop keeps its own village words and the town it sits in",
      st[1]?.place === "Kivinikoniko storages" && st[1]?.place_name === "Kilwa",
      [st[1]?.place, st[1]?.place_name]);
    check("the flat destination text carries the village and the town together",
      detail.json?.dest_text === "Mbamba Bay lakeside depot, Mbamba Bay", detail.json?.dest_text);
    check("the flat origin/destination columns follow the first and last stop",
      detail.json?.origin_region_id === dar.id && detail.json?.dest_region_id === mtwara.id
        && Number(detail.json?.origin_lat) === Number(st[0].lat)
        && Number(detail.json?.dest_lat) === Number(st[3].lat),
      [detail.json?.origin_text, detail.json?.dest_text]);

    const list = await call("/routes", token);
    const row = (list.json ?? []).find((r: any) => r.id === id);
    check("the register shows the chain and its length",
      row?.stop_count === 4 && /Mbamba Bay/.test(row?.stop_chain ?? "") && /Vingunguti/.test(row?.stop_chain ?? ""),
      [row?.stop_count, row?.stop_chain]);

    // ---------- Region-centroid tier, when only a region is given ----------
    const centroidStop = await call("/routes", token, post({
      name: FIXTURE + " centroid", corridor: "x",
      stops: [
        { kind: "origin", regionId: dar.id },
        { kind: "dest", regionId: mtwara.id, placeId: town("Mtwara")?.id ?? null }
      ]
    }));
    const centDetail = centroidStop.json?.id
      ? await call(`/routes/${centroidStop.json.id}`, token) : { json: { stops: [] } };
    check("a region-only stop resolves to the region centre and says so",
      centroidStop.status === 201 && (centDetail.json?.stops ?? [])[0]?.coord_source === "region_centroid",
      [centroidStop.status, code(centroidStop.json), (centDetail.json?.stops ?? [])[0]?.coord_source]);

    // ---------- Guards ----------
    const noCoord = await call("/routes", token, post({
      name: FIXTURE + " no-coord",
      stops: [{ kind: "origin", place: "a bush somewhere" }, { kind: "dest", regionId: mtwara.id }]
    }));
    check("a stop with no town and no pin is refused, not guessed",
      noCoord.status === 400 && code(noCoord.json) === "STOP_UNRESOLVED",
      [noCoord.status, code(noCoord.json)]);
    const badOrder = await call("/routes", token, post({
      name: FIXTURE + " order",
      stops: [{ kind: "via", regionId: dar.id }, { kind: "origin", regionId: mtwara.id }]
    }));
    check("a chain that does not start at an origin is refused",
      badOrder.status === 400 && code(badOrder.json) === "STOPS_INVALID",
      [badOrder.status, code(badOrder.json)]);
    const wrongWard = await call("/routes", token, post({
      name: FIXTURE + " ward",
      stops: [
        { kind: "origin", regionId: mtwara.id, wardId: ward?.rows[0]?.id ?? 1 },
        { kind: "dest", regionId: dar.id }
      ]
    }));
    check("a ward that is not in the chosen region is refused",
      wrongWard.status === 400 && code(wrongWard.json) === "STOP_WARD_MISMATCH",
      [wrongWard.status, code(wrongWard.json)]);
    const fakeTown = await call("/routes", token, post({
      name: FIXTURE + " fake",
      stops: [{ kind: "origin", placeId: 999999 }, { kind: "dest", regionId: dar.id }]
    }));
    check("a town id that is not in the gazetteer is refused",
      fakeTown.status === 400 && code(fakeTown.json) === "STOP_PLACE_UNKNOWN",
      [fakeTown.status, code(fakeTown.json)]);
    const wildPin = await call("/routes", token, post({
      name: FIXTURE + " wild pin",
      stops: [
        { kind: "origin", lat: -65.4063, lng: 37.59521 },
        { kind: "dest", regionId: mtwara.id, placeId: town("Mbamba Bay")?.id ?? null }
      ]
    }));
    check("a pin dropped off the mapped world is refused, not routed",
      wildPin.status === 400 && code(wildPin.json) === "STOP_PIN_OUT_OF_RANGE",
      [wildPin.status, code(wildPin.json)]);
    const wrongRegionTown = await call("/routes", token, post({
      name: FIXTURE + " town region",
      stops: [
        { kind: "origin", regionId: dar.id, placeId: town("Mtwara")?.id ?? null },
        { kind: "dest", regionId: mtwara.id }
      ]
    }));
    check("a town that lives in another region is refused",
      wrongRegionTown.status === 400 && code(wrongRegionTown.json) === "STOP_PLACE_MISMATCH",
      [wrongRegionTown.status, code(wrongRegionTown.json)]);

    // ---------- Edit the chain: VIA stops are replaced, not appended ----------
    const edited = await call(`/routes/${id}`, token, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: FIXTURE, corridor: "Inland highlands (smoke)", distanceKm: 1450,
        stops: [stops[0],
          // Makambako is in Njombe, not Mtwara — the town decides the region here.
          { kind: "via", placeId: town("Makambako")?.id ?? null },
          stops[3]]
      })
    });
    const afterEdit = await call(`/routes/${id}`, token);
    check("an edit rewrites the chain instead of stacking a second one",
      edited.status === 200 && (afterEdit.json?.stops ?? []).length === 3
        && (afterEdit.json?.stops ?? []).map((s: any) => s.kind).join() === "origin,via,dest",
      [edited.status, (afterEdit.json?.stops ?? []).map((s: any) => [s.kind, s.place_name])]);

    // ---------- Multi-waypoint trace ----------
    const chainPts = [pin, town("Kilwa"), town("Mtwara"), town("Mbamba Bay")]
      .filter((p: any): p is { lat: number; lng: number } => !!p && p.lat != null);
    const wps = chainPts.map(p => `${p.lat},${p.lng}`).join(";");
    const traced = await call(`/geo/road-route?wps=${encodeURIComponent(wps)}&alternatives=2`, token);
    check("the router traces the whole chain, not just the ends",
      traced.status === 200 && traced.json?.distanceKm > 400
        && Array.isArray(traced.json?.geometry) && traced.json.geometry.length > 20,
      [traced.status, code(traced.json), traced.json?.distanceKm, traced.json?.geometry?.length]);
    check("the trace is a road line of [lat,lng] pairs",
      Math.abs(traced.json?.geometry?.[0]?.[0]) < 90 && Math.abs(traced.json?.geometry?.[0]?.[1]) < 180,
      traced.json?.geometry?.[0]);
    const again = await call(`/geo/road-route?wps=${encodeURIComponent(wps)}&alternatives=2`, token);
    check("the same chain is served from cache", again.json?.cached === true, again.json?.cached);
    const straight = await call(
      `/geo/road-route?oLat=${pin.lat}&oLng=${pin.lng}&dLat=${town("Mbamba Bay")?.lat}&dLng=${town("Mbamba Bay")?.lng}`,
      token);
    check("a two-point request still works for older callers",
      straight.status === 200 && straight.json?.distanceKm > 400,
      [straight.status, straight.json?.distanceKm]);
    const badWps = await call("/geo/road-route?wps=not-a-chain", token);
    check("a malformed waypoint list is refused before the router is called",
      badWps.status === 400 && code(badWps.json) === "WAYPOINTS_INVALID",
      [badWps.status, code(badWps.json)]);

    // A chosen corridor line is stored with the route.
    const stored = await call(`/routes/${id}`, token, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: FIXTURE, corridor: "Inland highlands (smoke)", distanceKm: traced.json.distanceKm,
        routeSource: "osrm", geometry: traced.json.geometry,
        stops: afterEdit.json.stops.map((s: any) => ({
          kind: s.kind, regionId: s.region_id, districtId: s.district_id, wardId: s.ward_id,
          placeId: s.place_id, place: s.place,
          lat: s.coord_source === "pin" ? s.lat : null,
          lng: s.coord_source === "pin" ? s.lng : null
        }))
      })
    });
    const withLine = await call(`/routes/${id}`, token);
    check("the traced line is kept on the route for the register to redraw",
      stored.status === 200 && Array.isArray(withLine.json?.geometry)
        && withLine.json.geometry.length > 20 && withLine.json?.route_source === "osrm",
      [stored.status, withLine.json?.route_source, withLine.json?.geometry?.length]);

    // ---------- Saving while the router cannot answer ----------
    // Two pins in open water off the coast have no road to snap to, so the router
    // can only refuse. That is the same answer the builder gets when the shared
    // demo router sheds a big corridor, and the transporter must still be able to
    // save the route he planned.
    const sea = { from: { lat: -6.2, lng: 41.6 }, to: { lat: -6.9, lng: 42.2 } };
    const seaWps = `${sea.from.lat},${sea.from.lng};${sea.to.lat},${sea.to.lng}`;
    const noRoad = await call(`/geo/road-route?wps=${encodeURIComponent(seaWps)}`, token);
    check("a chain the road network does not reach is refused, never invented",
      noRoad.status === 502 && code(noRoad.json) === "ROUTING_UNAVAILABLE",
      [noRoad.status, code(noRoad.json)]);

    const est = await call("/routes", token, post({
      name: `${FIXTURE} estimate only`, distanceKm: 120, expectedDurationHours: 4,
      routeSource: "estimate",
      stops: [
        { kind: "origin", lat: sea.from.lat, lng: sea.from.lng, place: "Off the coast" },
        { kind: "dest", lat: sea.to.lat, lng: sea.to.lng, place: "Further out" }
      ]
    }));
    const estId = est.json?.id as string | undefined;
    const estBack = estId ? await call(`/routes/${estId}`, token) : { status: 0, json: null as any };
    check("with no road to trace the route still saves",
      est.status === 201 && estBack.status === 200,
      [est.status, code(estId ? estBack.json : est.json)]);
    check("and the row says the distance is an estimate rather than nothing",
      estBack.json?.route_source === "estimate" && estBack.json?.geometry == null
        && estBack.json?.routed_at == null,
      [estBack.json?.route_source, estBack.json?.routed_at]);
    const listed = (await call("/routes", token).then(r => r.json ?? []) as any[])
      .find(r => r.id === estId);
    check("the register shows which basis each route was planned on",
      listed?.route_source === "estimate", listed?.route_source);
    check("and the traced corridor is still shown as traced beside it",
      (await call("/routes", token).then(r => r.json ?? []) as any[])
        .find(r => r.id === id)?.route_source === "osrm");

    // ---------- Isolation ----------
    const strangerRead = await call(`/routes/${id}`, strangerToken);
    check("another tenant cannot open the chain", strangerRead.status === 404, strangerRead.status);
    const strangerEdit = await call(`/routes/${id}`, strangerToken, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "hijack", stops })
    });
    check("another tenant cannot rewrite the chain", strangerEdit.status === 404, strangerEdit.status);

    const appUrl = process.env.ISOLATION_DATABASE_URL || process.env.DATABASE_URL;
    if (appUrl) {
      const app = new pg.Client({ connectionString: appUrl, ssl: { rejectUnauthorized: false } });
      await app.connect();
      try {
        const asRole = await app.query("select current_user as r");
        if (asRole.rows[0].r === "app_runtime") {
          await app.query(`select set_config('app.tenant_id', $1, true)`, [tenant_id]);
          const mine = await app.query("select count(*)::int as n from route_stops where route_id = $1", [id]);
          await app.query(`select set_config('app.tenant_id', $1, true)`,
            ["00000000-0000-7000-8000-000000000000"]);
          const foreign = await app.query("select count(*)::int as n from route_stops where route_id = $1", [id]);
          check("route_stops RLS shows the chain only to its own tenant",
            mine.rows[0].n === 3 && foreign.rows[0].n === 0, [mine.rows[0].n, foreign.rows[0].n]);
        } else {
          console.log(`skip  route_stops RLS probe — connected as ${asRole.rows[0].r}, not app_runtime`);
        }
      } finally { await app.end(); }
    }

    const unauth = await call("/geo/places?q=Mbamb", null);
    check("the gazetteer is not public", unauth.status === 401, unauth.status);
  } finally {
    await sweep(owner, tenant_id);
    await owner.query("delete from routes where tenant_id = $1 and name like $2",
      [tenant_id, "SMOKE BUILDER%"]);
    const residue = await owner.query(
      `select (select count(*) from routes where tenant_id = $1 and name like $2)::int as routes,
              (select count(*) from route_stops rs
                where rs.tenant_id = $1
                  and not exists (select 1 from routes r where r.id = rs.route_id))::int orphans`,
      [tenant_id, "SMOKE BUILDER%"]);
    console.log(`residue: ${JSON.stringify(residue.rows[0])}`);
    await owner.end();
  }

  console.log(failures ? `\n${failures} FAILURES` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
