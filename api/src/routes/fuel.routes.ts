import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const fuelSchema = z.object({
  vesselId: z.string().uuid().nullable().optional(),
  tripId: z.string().uuid().nullable().optional(),
  logDate: dateOnly.optional(),
  litres: z.number().positive().max(1_000_000),
  pricePerLitre: z.number().nonnegative().max(1_000_000).nullable().optional(),
  totalCost: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  odometerKm: z.number().int().nonnegative().nullable().optional(),
  station: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

export async function fuelRoutes(app: FastifyInstance, _opts: unknown) {

  app.get("/fuel-logs", { preHandler: [requireAuth, requirePermission("costs.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select f.id, f.vessel_id, f.trip_id, f.log_date, f.litres, f.price_per_litre,
                f.total_cost, f.odometer_km, f.station, f.notes, f.created_at,
                v.name as vessel_name, t.reference as trip_reference
         from fuel_logs f
         left join vessels v on v.id = f.vessel_id
         left join trips t on t.id = f.trip_id
         where f.tenant_id = $1 and f.deleted_at is null
         order by f.log_date desc, f.created_at desc
         limit 200`, [req.user.tid]));

      const totals = await withTenant(req.user.tid, (c) => c.query(
        `select coalesce(sum(litres), 0)::float8 as litres,
                coalesce(sum(coalesce(total_cost, litres * coalesce(price_per_litre, 0))), 0)::float8 as cost,
                count(*)::int as entries
         from fuel_logs where tenant_id = $1 and deleted_at is null`, [req.user.tid]));

      return { logs: rows, totals: totals.rows[0] };
    });

  app.post("/fuel-logs", { preHandler: [requireAuth, requirePermission("costs.create")] },
    async (req: any, reply) => {
      const body = fuelSchema.parse(req.body);
      const id = uuidv7();
      // Total defaults to litres x price when not stated explicitly.
      const total = body.totalCost ?? (body.litres * (body.pricePerLitre ?? 0));

      await withTenant(req.user.tid, async (c) => {
        await c.query(
          `insert into fuel_logs (id, tenant_id, vessel_id, trip_id, log_date, litres,
             price_per_litre, total_cost, odometer_km, station, notes, created_by, updated_by)
           values ($1,$2,$3,$4, coalesce($5, current_date), $6,$7,$8,$9,$10,$11,$12,$12)`,
          [id, req.user.tid, body.vesselId ?? null, body.tripId ?? null,
           body.logDate ?? null, body.litres, body.pricePerLitre ?? null,
           total || null, body.odometerKm ?? null, body.station ?? null,
           body.notes ?? null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "fuel_logs", entityId: id,
          action: "fuel.logged",
          after: { litres: body.litres, total: total || null, vesselId: body.vesselId ?? null }
        });
      });
      return reply.status(201).send({ id });
    });

  app.delete("/fuel-logs/:id", { preHandler: [requireAuth, requirePermission("costs.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update fuel_logs set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "fuel_logs", entityId: id,
            action: "fuel.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Fuel log not found", 404);
      return reply.send({ ok: true });
    });
}
