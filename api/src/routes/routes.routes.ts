import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const routeSchema = z.object({
  name: z.string().trim().min(2).max(120),
  corridor: z.string().max(120).optional(),
  originRegionId: z.number().int().positive().nullable().optional(),
  originDistrictId: z.number().int().positive().nullable().optional(),
  originText: z.string().max(120).optional(),
  destRegionId: z.number().int().positive().nullable().optional(),
  destDistrictId: z.number().int().positive().nullable().optional(),
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
  fuelSurchargePct: z.number().min(0).max(100).optional()
});

export async function routesRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Border posts picker (from the EAC reference data) ----------
  app.get("/geo/border-posts", { preHandler: [requireAuth] }, async () => {
    const { rows } = await pool.query(
      "select id, country_a, country_b, name, kind from geo_border_posts order by name");
    return rows;
  });

  // ---------- Region coordinates (for distance calc + map) ----------
  app.get("/geo/region-coords", { preHandler: [requireAuth] }, async () => {
    const { rows } = await pool.query(
      "select id, code, name_en, lat, lng from geo_regions where lat is not null and lng is not null");
    return rows;
  });

  // ---------- List routes ----------
  app.get("/routes", { preHandler: [requireAuth] }, async (req: any) => {
    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select r.id, r.name, r.corridor, r.origin_text, r.dest_text,
              r.origin_region_id, r.dest_region_id,
              r.distance_km, r.expected_duration_hours, r.road_class,
              r.rate_per_km, r.rate_per_tonne, r.rate_per_trip,
              r.is_active, r.created_at,
              bp.name as border_post_name,
              ro.lat as origin_lat, ro.lng as origin_lng,
              rd.lat as dest_lat, rd.lng as dest_lng,
              (select count(*)::int from route_checkpoints rc
                where rc.route_id = r.id) as checkpoint_count
       from routes r
       left join geo_border_posts bp on bp.id = r.border_post_id
       left join geo_regions ro on ro.id = r.origin_region_id
       left join geo_regions rd on rd.id = r.dest_region_id
       where r.tenant_id = $1 and r.deleted_at is null
       order by r.created_at desc`, [req.user.tid]));
    return rows;
  });

  // ---------- Route detail (with ordered checkpoints) ----------
  app.get("/routes/:id", { preHandler: [requireAuth] }, async (req: any) => {
    const { id } = req.params as { id: string };
    const r = await withTenant(req.user.tid, (c) => c.query(
      "select * from routes where id=$1 and tenant_id=$2 and deleted_at is null",
      [id, req.user.tid]));
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Route not found", 404);
    const cps = await withTenant(req.user.tid, (c) => c.query(
      "select id, seq, kind, name from route_checkpoints where route_id=$1 order by seq",
      [id]));
    return { ...r.rows[0], checkpoints: cps.rows };
  });

  // ---------- Create ----------
  app.post("/routes", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const body = routeSchema.parse(req.body);
    const id = uuidv7();
    await withTenant(req.user.tid, async (c) => {
      await c.query(
        `insert into routes (id, tenant_id, name, corridor,
           origin_region_id, origin_district_id, origin_text,
           dest_region_id, dest_district_id, dest_text,
           border_post_id, distance_km, expected_duration_hours, road_class,
           risk_notes, seasonal_notes, rate_per_km, rate_per_tonne, rate_per_trip,
           fuel_surcharge_pct, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)`,
        [id, req.user.tid, body.name, body.corridor ?? null,
         body.originRegionId ?? null, body.originDistrictId ?? null, body.originText ?? null,
         body.destRegionId ?? null, body.destDistrictId ?? null, body.destText ?? null,
         body.borderPostId ?? null, body.distanceKm ?? null,
         body.expectedDurationHours ?? null, body.roadClass ?? null,
         body.riskNotes ?? null, body.seasonalNotes ?? null,
         body.ratePerKm ?? null, body.ratePerTonne ?? null, body.ratePerTrip ?? null,
         body.fuelSurchargePct ?? null, req.user.sub]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "routes", entityId: id,
        action: "route.created",
        after: { name: body.name, distanceKm: body.distanceKm ?? null }
      });
    });
    return reply.status(201).send({ id });
  });

  // ---------- Update ----------
  app.put("/routes/:id", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = routeSchema.parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      const res = await c.query(
        `update routes set name=$2, corridor=$3,
           origin_region_id=$4, origin_district_id=$5, origin_text=$6,
           dest_region_id=$7, dest_district_id=$8, dest_text=$9,
           border_post_id=$10, distance_km=$11, expected_duration_hours=$12,
           road_class=$13, risk_notes=$14, seasonal_notes=$15,
           rate_per_km=$16, rate_per_tonne=$17, rate_per_trip=$18,
           fuel_surcharge_pct=$19, updated_by=$20, updated_at=now()
         where id=$1 and tenant_id=$20 and deleted_at is null
         returning id`,
        [id, body.name, body.corridor ?? null,
         body.originRegionId ?? null, body.originDistrictId ?? null, body.originText ?? null,
         body.destRegionId ?? null, body.destDistrictId ?? null, body.destText ?? null,
         body.borderPostId ?? null, body.distanceKm ?? null,
         body.expectedDurationHours ?? null, body.roadClass ?? null,
         body.riskNotes ?? null, body.seasonalNotes ?? null,
         body.ratePerKm ?? null, body.ratePerTonne ?? null, body.ratePerTrip ?? null,
         body.fuelSurchargePct ?? null, req.user.sub]);
      if (res.rowCount) {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "routes", entityId: id,
          action: "route.updated", after: { name: body.name }
        });
      }
      return res;
    });
    if (!r.rowCount) throw new ApiError("NOT_FOUND", "Route not found", 404);
    return reply.send({ ok: true });
  });

  // ---------- Delete ----------
  app.delete("/routes/:id", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const r = await withTenant(req.user.tid, async (c) => {
      const res = await c.query(
        `update routes set deleted_at = now(), updated_by = $2
         where id = $1 and tenant_id = $2 and deleted_at is null`,
        [id, req.user.sub]);
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
  app.post("/routes/:id/checkpoints", { preHandler: [requireAuth] }, async (req: any, reply) => {
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
  app.delete("/routes/:id/checkpoints/:cpId", { preHandler: [requireAuth] }, async (req: any, reply) => {
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