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

const incidentSchema = z.object({
  vesselId: z.string().uuid().nullable().optional(),
  driverId: z.string().uuid().nullable().optional(),
  tripId: z.string().uuid().nullable().optional(),
  incidentDate: dateOnly.optional(),
  type: z.enum(["accident", "breakdown", "theft", "injury", "other"]).optional(),
  severity: z.enum(["minor", "major", "critical"]).optional(),
  location: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().min(5).max(2000)
});

const updateSchema = incidentSchema.partial().extend({
  status: z.enum(["open", "investigating", "resolved"]).optional(),
  resolutionNotes: z.string().trim().max(1000).nullable().optional()
});

export async function incidentsRoutes(app: FastifyInstance, _opts: unknown) {

  app.get("/incidents", { preHandler: [requireAuth, requirePermission("incidents.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select i.id, i.vessel_id, i.driver_id, i.trip_id, i.incident_date, i.type,
                i.severity, i.location, i.description, i.status, i.resolution_notes,
                i.created_at,
                v.name as vessel_name, d.full_name as driver_name, t.reference as trip_reference
         from incidents i
         left join vessels v on v.id = i.vessel_id
         left join drivers d on d.id = i.driver_id
         left join trips t on t.id = i.trip_id
         where i.tenant_id = $1 and i.deleted_at is null
         order by (i.status <> 'resolved') desc, i.incident_date desc
         limit 200`, [req.user.tid]));

      const open = rows.filter((r: any) => r.status !== "resolved").length;
      return { incidents: rows, openCount: open, total: rows.length };
    });

  app.post("/incidents", { preHandler: [requireAuth, requirePermission("incidents.create")] },
    async (req: any, reply) => {
      const body = incidentSchema.parse(req.body);
      const id = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        await c.query(
          `insert into incidents (id, tenant_id, vessel_id, driver_id, trip_id,
             incident_date, type, severity, location, description, reported_by, created_by, updated_by)
           values ($1,$2,$3,$4,$5, coalesce($6, current_date), $7,$8,$9,$10,$11,$12,$12)`,
          [id, req.user.tid, body.vesselId ?? null, body.driverId ?? null,
           body.tripId ?? null, body.incidentDate ?? null, body.type ?? "other",
           body.severity ?? "minor", body.location ?? null, body.description,
           req.user.sub, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "incidents", entityId: id,
          action: "incident.reported",
          after: { type: body.type ?? "other", severity: body.severity ?? "minor",
                   vesselId: body.vesselId ?? null }
        });
      });
      return reply.status(201).send({ id });
    });

  // ---------- Update (presence-based; resolving records the resolution) ----------
  app.put("/incidents/:id", { preHandler: [requireAuth, requirePermission("incidents.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = updateSchema.parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select status, severity, type from incidents where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Incident not found", 404);

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid]; // $1 id, $2 updated_by, $3 tenant_id
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("vesselId" in body) set("vessel_id", body.vesselId ?? null);
        if ("driverId" in body) set("driver_id", body.driverId ?? null);
        if ("tripId" in body) set("trip_id", body.tripId ?? null);
        if ("incidentDate" in body && body.incidentDate) set("incident_date", body.incidentDate);
        if ("type" in body) set("type", body.type ?? "other");
        if ("severity" in body) set("severity", body.severity ?? "minor");
        if ("location" in body) set("location", body.location ?? null);
        if ("description" in body) set("description", body.description);
        if ("status" in body) set("status", body.status ?? "open");
        if ("resolutionNotes" in body) set("resolution_notes", body.resolutionNotes ?? null);

        if (sets.length) {
          await c.query(
            `update incidents set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
             where id = $1 and tenant_id = $3 and deleted_at is null`,
            params);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "incidents", entityId: id,
          action: "incident.updated",
          before: { status: prev.rows[0].status },
          after: { status: body.status ?? prev.rows[0].status }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/incidents/:id", { preHandler: [requireAuth, requirePermission("incidents.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update incidents set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "incidents", entityId: id,
            action: "incident.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Incident not found", 404);
      return reply.send({ ok: true });
    });
}
