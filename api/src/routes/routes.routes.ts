import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PoolClient } from "pg";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { writeAudit } from "../audit/audit.js";
import { requirePermission } from "../security/permissions.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const stopSchema = z.object({
  kind: z.enum(["origin", "via", "dest"]),
  regionId: z.number().int().positive().nullish(),
  districtId: z.number().int().positive().nullish(),
  wardId: z.number().int().positive().nullish(),
  placeId: z.number().int().positive().nullish(),
  place: z.string().trim().max(120).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish()
});

const routeSchema = z.object({
  name: z.string().trim().min(2).max(120),
  corridor: z.string().max(120).optional(),
  originRegionId: z.number().int().positive().nullable().optional(),
  originDistrictId: z.number().int().positive().nullable().optional(),
  originWardId: z.number().int().positive().nullable().optional(),
  originText: z.string().max(120).optional(),
  destRegionId: z.number().int().positive().nullable().optional(),
  destDistrictId: z.number().int().positive().nullable().optional(),
  destWardId: z.number().int().positive().nullable().optional(),
  destText: z.string().max(120).optional(),
  borderPostId: z.number().int().positive().nullable().optional(),
  distanceKm: z.number().int().min(0).max(50000).optional(),
  expectedDurationHours: z.number().int().min(0).max(2000).optional(),
  roadClass: z.string().max(40).optional(),
  riskNotes: z.string().max(1000).optional(),
  seasonalNotes: z.string().max(1000).optional(),
  ratePerKm: z.number().nonnegative().optional(),
  ratePerTonne: z.number().nonnegative().optional(),
  ratePerTrip: z.number().nonnegative().optional(),
  fuelSurchargePct: z.number().min(0).max(100).optional(),
  // The builder's source of truth: origin, then every VIA, then destination.
  stops: z.array(stopSchema).min(2).max(30).optional(),
  geometry: z.array(z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]))
    .min(2).max(6000).optional(),
  routeSource: z.enum(["osrm", "estimate"]).optional()
});
type StopIn = z.infer<typeof stopSchema>;

interface ResolvedStop {
  seq: number; kind: StopIn["kind"];
  regionId: number | null; districtId: number | null; wardId: number | null;
  placeId: number | null; place: string | null;
  lat: number | null; lng: number | null;
  coordSource: "pin" | "town" | "region_centroid" | null;
  label: string;
}

const idsOf = (xs: (number | null | undefined)[]) =>
  [...new Set(xs.filter((x): x is number => typeof x === "number" && x > 0))];
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Turn the builder's stops into stored stops. A stop's coordinate is resolved
 * here, on the server, in one order and no other: the transporter's own pin,
 * then the gazetteer town they picked, then the region seat. That order is what
 * makes "ward/village precision" honest - the row records which of the three it
 * was (`coord_source`), so a region-centroid anchor is never read as a survey.
 */
async function resolveStops(c: PoolClient, stops: StopIn[]): Promise<ResolvedStop[]> {
  const viasMisplaced =
    stops[0]?.kind !== "origin" ||
    stops[stops.length - 1]?.kind !== "dest" ||
    stops.slice(1, -1).some(s => s.kind !== "via") ||
    stops.filter(s => s.kind === "origin").length !== 1 ||
    stops.filter(s => s.kind === "dest").length !== 1;
  if (viasMisplaced) {
    throw new ApiError("STOPS_INVALID",
      "A route needs one origin first, one destination last, and VIA stops between them.", 400);
  }

  const places = new Map<number, { name: string; lat: number; lng: number; regionId: number }>();
  const pRows = await c.query(
    `select id, name, region_id, lat, lng from geo_places where id = any($1::int[])`,
    [idsOf(stops.map(s => s.placeId))]);
  for (const x of pRows.rows) {
    places.set(Number(x.id), {
      name: x.name, lat: Number(x.lat), lng: Number(x.lng), regionId: Number(x.region_id)
    });
  }

  const regions = new Map<number, { name: string; lat: number | null; lng: number | null }>();
  const rRows = await c.query(
    `select id, name_en, lat, lng from geo_regions where id = any($1::int[])`,
    [idsOf(stops.map(s => s.regionId))]);
  for (const x of rRows.rows) {
    regions.set(Number(x.id), { name: x.name_en, lat: num(x.lat), lng: num(x.lng) });
  }

  const districts = new Map<number, number>();
  const dRows = await c.query(
    `select id, region_id from geo_districts where id = any($1::int[])`,
    [idsOf(stops.map(s => s.districtId))]);
  for (const x of dRows.rows) districts.set(Number(x.id), Number(x.region_id));

  const wards = new Map<number, { districtId: number; regionId: number }>();
  const wRows = await c.query(
    `select w.id, w.district_id, d.region_id from geo_wards w
       join geo_districts d on d.id = w.district_id
      where w.id = any($1::int[])`,
    [idsOf(stops.map(s => s.wardId))]);
  for (const x of wRows.rows) {
    wards.set(Number(x.id), { districtId: Number(x.district_id), regionId: Number(x.region_id) });
  }

  return stops.map((s, i) => {
    const at = `Stop ${i + 1}`;
    if (s.placeId && !places.has(s.placeId)) {
      throw new ApiError("STOP_PLACE_UNKNOWN", `${at}: that town is not in the reference gazetteer.`, 400);
    }
    const place = s.placeId ? places.get(s.placeId)! : null;
    if (s.regionId && place && place.regionId !== s.regionId) {
      throw new ApiError("STOP_PLACE_MISMATCH",
        `${at}: ${place.name} is not in the selected region.`, 400);
    }
    const regionId = place?.regionId ?? s.regionId ?? null;
    const region = regionId ? regions.get(regionId) : undefined;
    if (s.regionId && !region) {
      throw new ApiError("STOP_REGION_UNKNOWN", `${at}: unknown region.`, 400);
    }
    if (s.districtId) {
      const owner = districts.get(s.districtId);
      if (owner === undefined) throw new ApiError("STOP_DISTRICT_UNKNOWN", `${at}: unknown council.`, 400);
      if (regionId && owner !== regionId) {
        throw new ApiError("STOP_DISTRICT_MISMATCH", `${at}: that council is not in the selected region.`, 400);
      }
    }
    let districtId = s.districtId ?? null;
    if (s.wardId) {
      const w = wards.get(s.wardId);
      if (w === undefined) throw new ApiError("STOP_WARD_UNKNOWN", `${at}: unknown ward.`, 400);
      if (districtId && w.districtId !== districtId) {
        throw new ApiError("STOP_WARD_MISMATCH", `${at}: that ward is not in the selected council.`, 400);
      }
      // The ward's own place in the hierarchy outranks a blank parent picker: a
      // Kata picked under the wrong Mkoa used to save silently and mis-anchor the route.
      if (regionId && w.regionId !== regionId) {
        throw new ApiError("STOP_WARD_MISMATCH", `${at}: that ward is not in the selected region.`, 400);
      }
      districtId = districtId ?? w.districtId;
    }
    if ((s.lat == null) !== (s.lng == null)) {
      throw new ApiError("STOP_PIN_INCOMPLETE", `${at}: a pin needs both latitude and longitude.`, 400);
    }
    // A pin is the transporter's own word on where a stop is, so it is believed —
    // but only within the neighbourhood this planner serves. The southern African
    // box still covers every corridor to Nairobi, Lusaka, Kigali or Dar; it is what
    // stops a stray map click from becoming a 11 000 km "national" route.
    if (s.lat != null && s.lng != null && (s.lat < -20 || s.lat > 5 || s.lng < 25 || s.lng > 45)) {
      throw new ApiError("STOP_PIN_OUT_OF_RANGE",
        `${at}: that pin is not a point this planner can route — drop it inside Tanzania or a neighbouring country.`, 400);
    }

    let lat: number | null = null, lng: number | null = null;
    let coordSource: ResolvedStop["coordSource"] = null;
    if (s.lat != null && s.lng != null) {
      lat = s.lat; lng = s.lng; coordSource = "pin";
    } else if (place) {
      lat = place.lat; lng = place.lng; coordSource = "town";
    } else if (region?.lat != null && region?.lng != null) {
      lat = region.lat; lng = region.lng; coordSource = "region_centroid";
    } else {
      throw new ApiError("STOP_UNRESOLVED",
        `${at}: pick a town from the gazetteer, or drop a pin on the map — a ward alone has no coordinate.`, 400);
    }

    return {
      seq: i + 1, kind: s.kind,
      regionId, districtId, wardId: s.wardId ?? null,
      placeId: s.placeId ?? null, place: s.place ?? null,
      lat, lng, coordSource,
      label: s.place && place && s.place !== place.name
        ? `${s.place}, ${place.name}`
        : (s.place || place?.name || region?.name || `Stop ${i + 1}`)
    };
  });
}

async function storeStops(c: PoolClient, routeId: string, tid: string, stops: ResolvedStop[]) {
  await c.query("delete from route_stops where route_id = $1 and tenant_id = $2", [routeId, tid]);
  for (const s of stops) {
    await c.query(
      `insert into route_stops (id, tenant_id, route_id, seq, kind,
         region_id, district_id, ward_id, place_id, place, lat, lng, coord_source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [uuidv7(), tid, routeId, s.seq, s.kind, s.regionId, s.districtId, s.wardId,
       s.placeId, s.place, s.lat, s.lng, s.coordSource]);
  }
}

/** A full-detail polyline across a country is thousands of points; the map needs
 *  hundreds. Keep the shape, cap the weight so one route row stays readable. */
function thinGeometry(points: [number, number][] | undefined, max = 1200): [number, number][] | null {
  if (!points || points.length < 2) return null;
  if (points.length <= max) return points;
  const step = points.length / max;
  const out: [number, number][] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

/** Road routing cache: key = the whole waypoint chain (~1 km rounding), because
 *  the same pair through a different set of VIA anchors is a different road. */
const roadCache = new Map<string, RoadTrace & { alternatives: RoadTrace[] }>();
interface RoadTrace { distanceKm: number; durationHours: number; geometry: [number, number][] }

/** "lat,lng;lat,lng;..." — strict, so nothing built from user text reaches the router URL. */
function parseWaypoints(raw: string): [number, number][] | null {
  const out: [number, number][] = [];
  for (const part of raw.split(";")) {
    const m = /^\s*(-?\d{1,3}(?:\.\d{1,6})?)\s*,\s*(-?\d{1,4}(?:\.\d{1,6})?)\s*$/.exec(part);
    if (!m) return null;
    const lat = Number(m[1]), lng = Number(m[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    out.push([lat, lng]);
  }
  return out.length >= 2 && out.length <= 15 ? out : null;
}

export async function routesRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Border posts picker (EAC reference data) ----------
  app.get("/geo/border-posts", { preHandler: [requireAuth] }, async () => {
    const { rows } = await pool.query(
      "select id, country_a, country_b, name, kind from geo_border_posts order by name");
    return rows;
  });

  // ---------- Region coordinates (distance calc + map) ----------
  app.get("/geo/region-coords", { preHandler: [requireAuth] }, async () => {
    const { rows } = await pool.query(
      "select id, code, name_en, lat, lng from geo_regions where lat is not null and lng is not null");
    return rows;
  });

  // ---------- Town gazetteer (the ward level has no coordinates) ----------
  app.get("/geo/places", { preHandler: [requireAuth] }, async (req: any) => {
    const q = z.object({
      q: z.string().trim().min(1).max(60).optional(),
      regionId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(60).default(20)
    }).parse(req.query);
    const { rows } = await pool.query(
      `select p.id, p.name, p.kind, p.lat, p.lng, p.region_id, r.name_en as region_name
       from geo_places p join geo_regions r on r.id = p.region_id
       where ($1::text is null or p.name ilike $2)
         and ($3::int is null or p.region_id = $3)
       order by (p.kind = 'city') desc, p.name
       limit $4`,
      [q.q ?? null, `%${q.q ?? ""}%`, q.regionId ?? null, q.limit]);
    return rows;
  });

  // ---------- Main-corridor options for an origin/destination pair ----------
  // Matched in either direction: a transporter plans Mbamba Bay -> Dar as often
  // as the reverse, and the chain is the same road read backwards.
  app.get("/geo/corridors", { preHandler: [requireAuth] }, async (req: any) => {
    const q = z.object({
      originRegionId: z.coerce.number().int().positive(),
      destRegionId: z.coerce.number().int().positive()
    }).parse(req.query);
    if (q.originRegionId === q.destRegionId) return [];

    const { rows } = await pool.query(
      `select c.id, c.name, c.kind, c.notes,
              (c.origin_region_id = $1) as forwards,
              s.seq, s.region_id, s.place_id, s.label,
              r.name_en as region_name, p.name as place_name,
              coalesce(p.lat, r.lat) as lat, coalesce(p.lng, r.lng) as lng
       from geo_corridors c
       join geo_corridor_stops s on s.corridor_id = c.id
       join geo_regions r on r.id = s.region_id
       left join geo_places p on p.id = s.place_id
       where (c.origin_region_id = $1 and c.dest_region_id = $2)
          or (c.origin_region_id = $2 and c.dest_region_id = $1)
       order by c.id, s.seq`,
      [q.originRegionId, q.destRegionId]);

    const byId = new Map<number, {
      id: number; name: string; kind: string; notes: string | null;
      reverse: boolean; stops: {
        seq: number; regionId: number | null; placeId: number | null; label: string;
        lat: number | null; lng: number | null;
      }[]
    }>();
    for (const x of rows) {
      let c = byId.get(Number(x.id));
      if (!c) {
        c = {
          id: Number(x.id), name: x.name, kind: x.kind, notes: x.notes ?? null,
          reverse: !x.forwards, stops: []
        };
        byId.set(Number(x.id), c);
      }
      c.stops.push({
        seq: Number(x.seq), regionId: Number(x.region_id), placeId: x.place_id ? Number(x.place_id) : null,
        label: x.label || x.place_name || x.region_name,
        lat: num(x.lat), lng: num(x.lng)
      });
    }
    // A reversed corridor is driven back-to-front; renumber so the builder can
    // drop the chain straight into the VIA list.
    for (const c of byId.values()) {
      if (!c.reverse) continue;
      c.stops = c.stops.slice().reverse().map((s, i) => ({ ...s, seq: i + 1 }));
    }
    return [...byId.values()];
  });

  // ---------- Road routing proxy (OSRM + cache; falls back client-side) ----------
  // Multi-waypoint: `wps` is the whole chain origin -> via* -> destination. The
  // old two-point params still work, and the payload shape is unchanged, so
  // every caller written before the builder keeps reading distance/geometry.
  app.get("/geo/road-route", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const parsed = z.object({
      wps: z.string().max(1500).optional(),
      oLat: z.coerce.number().min(-90).max(90).optional(),
      oLng: z.coerce.number().min(-180).max(180).optional(),
      dLat: z.coerce.number().min(-90).max(90).optional(),
      dLng: z.coerce.number().min(-180).max(180).optional(),
      alternatives: z.coerce.number().int().min(0).max(3).default(0)
    }).parse(req.query);

    const wps = parsed.wps ? parseWaypoints(parsed.wps) : null;
    if (parsed.wps && !wps) {
      return reply.status(400).send({
        error: { code: "WAYPOINTS_INVALID", message: "Waypoints must be 2-15 pairs of lat,lng." }
      });
    }
    const chain: [number, number][] = wps ??
      (parsed.oLat != null && parsed.oLng != null && parsed.dLat != null && parsed.dLng != null
        ? [[parsed.oLat, parsed.oLng], [parsed.dLat, parsed.dLng]]
        : []);
    if (chain.length < 2) {
      return reply.status(400).send({
        error: { code: "WAYPOINTS_INVALID", message: "Give an origin and a destination." }
      });
    }

    const key = `${chain.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(";")}|${parsed.alternatives}`;
    const hit = roadCache.get(key);
    if (hit) return reply.send({ ...hit, cached: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const coords = chain.map(p => `${p[1]},${p[0]}`).join(";");
      const url = `https://router.project-osrm.org/route/v1/driving/${coords}`
        + `?overview=full&geometries=geojson${parsed.alternatives ? `&alternatives=${parsed.alternatives}` : ""}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`osrm ${res.status}`);
      const j: any = await res.json();
      // OSRM v1 answers under `routes`; reading `route` yields nothing and every
      // caller silently falls back to a straight line.
      const traced: (RoadTrace & { geometry: [number, number][] })[] = (j.routes ?? [])
        .map((r: any) => ({
          distanceKm: Math.round((r?.distance ?? 0) / 1000),
          durationHours: Math.round((r?.duration ?? 0) / 3600),
          geometry: ((r?.geometry?.coordinates ?? []) as [number, number][])
            .map((c: [number, number]) => [c[1], c[0]] as [number, number])
        }))
        .filter((r: RoadTrace) => r.geometry.length >= 2 && r.distanceKm > 0);
      if (!traced.length) throw new Error("osrm empty");
      const payload = {
        ...traced[0], geometry: thinGeometry(traced[0].geometry) ?? traced[0].geometry,
        alternatives: traced.slice(1).map(a => ({ ...a, geometry: thinGeometry(a.geometry) ?? a.geometry }))
      };
      if (roadCache.size > 400) roadCache.clear();
      roadCache.set(key, payload);
      return reply.send(payload);
    } catch (e: any) {
      req.log.warn({ err: e?.message ?? e }, "road routing unavailable");
      return reply.status(502).send({
        error: { code: "ROUTING_UNAVAILABLE", message: "Road routing is temporarily unavailable." }
      });
    } finally {
      clearTimeout(timer);
    }
  });

  // ---------- List routes ----------
  app.get("/routes", { preHandler: [requireAuth] }, async (req: any) => {
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select r.id, r.name, r.corridor, r.origin_text, r.dest_text,
              r.origin_region_id, r.dest_region_id,
              r.distance_km, r.expected_duration_hours, r.road_class,
              r.rate_per_km, r.rate_per_tonne, r.rate_per_trip,
              r.is_active, r.created_at, r.route_source, r.routed_at,
              bp.name as border_post_name,
              coalesce(r.origin_lat, ro.lat) as origin_lat,
              coalesce(r.origin_lng, ro.lng) as origin_lng,
              coalesce(r.dest_lat, rd.lat) as dest_lat,
              coalesce(r.dest_lng, rd.lng) as dest_lng,
              ow.name as origin_ward_name, dw.name as dest_ward_name,
              (select count(*)::int from route_checkpoints rc
                where rc.route_id = r.id) as checkpoint_count,
              (select count(*)::int from route_stops rs
                where rs.route_id = r.id) as stop_count,
              (select string_agg(
                  case when nullif(rs.place, '') is not null and p.name is not null
                          and rs.place <> p.name
                       then rs.place || ', ' || p.name
                       else coalesce(nullif(rs.place, ''), p.name, g.name_en, '?') end,
                  ' > ' order by rs.seq)
                from route_stops rs
                left join geo_places p on p.id = rs.place_id
                left join geo_regions g on g.id = rs.region_id
                where rs.route_id = r.id) as stop_chain
       from routes r
       left join geo_border_posts bp on bp.id = r.border_post_id
       left join geo_regions ro on ro.id = r.origin_region_id
       left join geo_regions rd on rd.id = r.dest_region_id
       left join geo_wards ow on ow.id = r.origin_ward_id
       left join geo_wards dw on dw.id = r.dest_ward_id
       where r.tenant_id = $1 and r.deleted_at is null
       order by r.created_at desc`, [req.user.tid]));
    return rows;
  });

  // ---------- Route detail (stops, traced line, ordered checkpoints) ----------
  app.get("/routes/:id", { preHandler: [requireAuth] }, async (req: any) => {
    const { id } = req.params as { id: string };
    const found = await withTenant(req.user.tid, async (c) => {
      const route = await c.query(
        "select * from routes where id=$1 and tenant_id=$2 and deleted_at is null",
        [id, req.user.tid]);
      if (!route.rowCount) return { route, checkpoints: null, stops: null };
      const ck = await c.query(
        "select id, seq, kind, name from route_checkpoints where route_id=$1 order by seq", [id]);
      const st = await c.query(
        `select s.seq, s.kind, s.region_id, s.district_id, s.ward_id, s.place_id, s.place,
                s.lat, s.lng, s.coord_source,
                g.name_en as region_name, d.name_en as district_name,
                w.name as ward_name, p.name as place_name
         from route_stops s
         left join geo_regions g on g.id = s.region_id
         left join geo_districts d on d.id = s.district_id
         left join geo_wards w on w.id = s.ward_id
         left join geo_places p on p.id = s.place_id
         where s.route_id = $1 and s.tenant_id = $2
         order by s.seq`, [id, req.user.tid]);
      return { route, checkpoints: ck, stops: st };
    });
    if (!found.route.rowCount) throw new ApiError("NOT_FOUND", "Route not found", 404);
    return {
      ...found.route.rows[0],
      checkpoints: found.checkpoints?.rows ?? [],
      stops: (found.stops?.rows ?? []).map((s: any) => ({ ...s, lat: num(s.lat), lng: num(s.lng) }))
    };
  });

  // ---------- Create ----------
  app.post("/routes", { preHandler: [requireAuth, requirePermission("routes.create")] }, async (req: any, reply) => {
    const body = routeSchema.parse(req.body);
    const id = uuidv7();
    await withTenant(req.user.tid, async (c) => {
      const stops = body.stops ? await resolveStops(c, body.stops) : null;
      const head = stops?.[0], tail = stops ? stops[stops.length - 1] : null;
      const geo = thinGeometry(body.geometry);
      await c.query(
        `insert into routes (id, tenant_id, name, corridor,
           origin_region_id, origin_district_id, origin_ward_id, origin_text,
           dest_region_id, dest_district_id, dest_ward_id, dest_text,
           border_post_id, distance_km, expected_duration_hours, road_class,
           risk_notes, seasonal_notes, rate_per_km, rate_per_tonne, rate_per_trip,
           fuel_surcharge_pct, origin_lat, origin_lng, dest_lat, dest_lng,
           geometry, routed_at, route_source, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$30)`,
        [id, req.user.tid, body.name, body.corridor ?? null,
         head?.regionId ?? body.originRegionId ?? null,
         head?.districtId ?? body.originDistrictId ?? null,
         head?.wardId ?? body.originWardId ?? null,
         head?.label ?? body.originText ?? null,
         tail?.regionId ?? body.destRegionId ?? null,
         tail?.districtId ?? body.destDistrictId ?? null,
         tail?.wardId ?? body.destWardId ?? null,
         tail?.label ?? body.destText ?? null,
         body.borderPostId ?? null, body.distanceKm ?? null,
         body.expectedDurationHours ?? null, body.roadClass ?? null,
         body.riskNotes ?? null, body.seasonalNotes ?? null,
         body.ratePerKm ?? null, body.ratePerTonne ?? null, body.ratePerTrip ?? null,
         body.fuelSurchargePct ?? null,
         head?.lat ?? null, head?.lng ?? null, tail?.lat ?? null, tail?.lng ?? null,
         geo ? JSON.stringify(geo) : null, geo ? new Date() : null,
         geo ? body.routeSource ?? "osrm" : null,
         req.user.sub]);
      if (stops) await storeStops(c, id, req.user.tid, stops);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "routes", entityId: id,
        action: "route.created",
        after: {
          name: body.name, distanceKm: body.distanceKm ?? null,
          stops: stops?.length ?? 0, routeSource: body.routeSource ?? null
        }
      });
    });
    return reply.status(201).send({ id });
  });

  // ---------- Update ----------
  app.put("/routes/:id", { preHandler: [requireAuth, requirePermission("routes.edit")] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = routeSchema.parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      const stops = body.stops ? await resolveStops(c, body.stops) : null;
      const head = stops?.[0], tail = stops ? stops[stops.length - 1] : null;
      const geo = thinGeometry(body.geometry);
      const res = await c.query(
        `update routes set name=$2, corridor=$3,
           origin_region_id=$4, origin_district_id=$5, origin_ward_id=$6, origin_text=$7,
           dest_region_id=$8, dest_district_id=$9, dest_ward_id=$10, dest_text=$11,
           border_post_id=$12, distance_km=$13, expected_duration_hours=$14,
           road_class=$15, risk_notes=$16, seasonal_notes=$17,
           rate_per_km=$18, rate_per_tonne=$19, rate_per_trip=$20,
           fuel_surcharge_pct=$21, origin_lat=$22, origin_lng=$23, dest_lat=$24, dest_lng=$25,
           geometry=$26, routed_at=$27, route_source=$28, updated_by=$29, updated_at=now()
         where id=$1 and tenant_id=$30 and deleted_at is null
         returning id`,
        [id, body.name, body.corridor ?? null,
         head?.regionId ?? body.originRegionId ?? null,
         head?.districtId ?? body.originDistrictId ?? null,
         head?.wardId ?? body.originWardId ?? null,
         head?.label ?? body.originText ?? null,
         tail?.regionId ?? body.destRegionId ?? null,
         tail?.districtId ?? body.destDistrictId ?? null,
         tail?.wardId ?? body.destWardId ?? null,
         tail?.label ?? body.destText ?? null,
         body.borderPostId ?? null, body.distanceKm ?? null,
         body.expectedDurationHours ?? null, body.roadClass ?? null,
         body.riskNotes ?? null, body.seasonalNotes ?? null,
         body.ratePerKm ?? null, body.ratePerTonne ?? null, body.ratePerTrip ?? null,
         body.fuelSurchargePct ?? null,
         head?.lat ?? null, head?.lng ?? null, tail?.lat ?? null, tail?.lng ?? null,
         geo ? JSON.stringify(geo) : null, geo ? new Date() : null,
         geo ? body.routeSource ?? "osrm" : null,
         req.user.sub, req.user.tid]);
      if (res.rowCount) {
        if (stops) await storeStops(c, id, req.user.tid, stops);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "routes", entityId: id,
          action: "route.updated",
          after: {
            name: body.name, distanceKm: body.distanceKm ?? null,
            stops: stops?.length ?? 0, routeSource: body.routeSource ?? null
          }
        });
      }
      return res;
    });
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Route not found", 404);
    return reply.send({ ok: true });
  });

  // ---------- Delete ----------
  app.delete("/routes/:id", { preHandler: [requireAuth, requirePermission("routes.delete")] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const r = await withTenant(req.user.tid, async (c) => {
      const res = await c.query(
        `update routes set deleted_at = now(), updated_by = $2
         where id = $1 and tenant_id = $3 and deleted_at is null`,
        [id, req.user.sub, req.user.tid]);
      if (res.rowCount) {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "routes", entityId: id,
          action: "route.deleted"
        });
      }
      return res;
    });
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Route not found", 404);
    return reply.send({ ok: true });
  });

  // ---------- Checkpoints: add (seq auto = next) ----------
  app.post("/routes/:id/checkpoints", { preHandler: [requireAuth, requirePermission("checkpoints.create")] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      kind: z.enum(["weighbridge","border","toll","fuel","rest","town"]),
      name: z.string().trim().min(2).max(120)
    }).parse(req.body);

    const own = await withTenant(req.user.tid, (c) => c.query(
      "select id from routes where id=$1 and tenant_id=$2 and deleted_at is null",
      [id, req.user.tid]));
    if (!own.rowCount) throw new ApiError("NOT_FOUND", "Route not found", 404);

    const cpId = uuidv7();
    await withTenant(req.user.tid, async (c) => {
      const seq = await c.query(
        `select coalesce(max(seq), 0) + 1 as next from route_checkpoints where route_id = $1`,
        [id]);
      await c.query(
        `insert into route_checkpoints (id, tenant_id, route_id, seq, kind, name)
         values ($1,$2,$3,$4,$5,$6)`,
        [cpId, req.user.tid, id, seq.rows[0].next, body.kind, body.name]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "route_checkpoints", entityId: cpId,
        action: "checkpoint.added",
        after: { routeId: id, kind: body.kind, name: body.name, seq: seq.rows[0].next }
      });
    });
    return reply.status(201).send({ id: cpId });
  });

  // ---------- Checkpoints: remove (renumbers the rest) ----------
  app.delete("/routes/:id/checkpoints/:cpId", { preHandler: [requireAuth, requirePermission("checkpoints.delete")] }, async (req: any, reply) => {
    const { id, cpId } = req.params as { id: string; cpId: string };
    await withTenant(req.user.tid, async (c) => {
      const del = await c.query(
        `delete from route_checkpoints where id=$1 and route_id=$2 and tenant_id=$3`,
        [cpId, id, req.user.tid]);
      if (del.rowCount) {
        const rest = await c.query(
          "select id from route_checkpoints where route_id=$1 order by seq", [id]);
        for (let i = 0; i < rest.rows.length; i++) {
          await c.query("update route_checkpoints set seq=$2 where id=$1",
            [rest.rows[i].id, i + 1]);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "route_checkpoints", entityId: cpId,
          action: "checkpoint.removed", after: { routeId: id }
        });
      }
      return del;
    });
    return reply.send({ ok: true });
  });
}
