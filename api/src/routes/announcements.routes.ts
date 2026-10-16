import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { requireControl, hasLicenceRole } from "./control.routes.js";

const KINDS = ["info", "update", "upgrade", "maintenance", "warning"] as const;
const isoDate = z.string().datetime({ offset: true });

export async function announcementsRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Public: live announcements for the header ticker ----------
  // Unauthenticated on purpose: the bar must render for every user of every
  // surface (app shell, shipper portal, control) before any tenant context
  // exists. Only id/message/kind/created_at leave the server.
  app.get("/announcements", async () => {
    const { rows } = await pool.query(
      `select id, message, kind, created_at from system_announcements
       where active
         and (starts_at is null or starts_at <= now())
         and (ends_at is null or ends_at >= now())
       order by created_at desc
       limit 20`);
    return rows;
  });

  // ---------- Control: manage announcements (super_admin / billing_admin) ----------
  app.get("/control/announcements", { preHandler: [requireControl] }, async (req: any) => {
    if (!hasLicenceRole(req.control.roles ?? [])) throw new ApiError("FORBIDDEN", "Not permitted", 403);
    const { rows } = await pool.query(
      `select id, message, kind, active, starts_at, ends_at, created_at, updated_at
       from system_announcements order by created_at desc`);
    return rows;
  });

  app.post("/control/announcements", { preHandler: [requireControl] }, async (req: any, reply) => {
    if (!hasLicenceRole(req.control.roles ?? [])) throw new ApiError("FORBIDDEN", "Not permitted", 403);
    await enforceRateLimit(`announcements:uid:${req.control.user_id}`, 60, 3600);
    const body = z.object({
      message: z.string().trim().min(4).max(400),
      kind: z.enum(KINDS).default("info"),
      startsAt: isoDate.nullish(),
      endsAt: isoDate.nullish()
    }).strict().parse(req.body);

    const startsAt = body.startsAt ?? null;
    const endsAt = body.endsAt ?? null;
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      throw new ApiError("VALIDATION_FAILED", "End time must be after start time.", 400,
        [{ field: "endsAt" }]);
    }

    const ins = await pool.query(
      `insert into system_announcements (message, kind, starts_at, ends_at, created_by)
       values ($1,$2,$3,$4,$5)
       returning id, message, kind, active, starts_at, ends_at, created_at, updated_at`,
      [body.message, body.kind, startsAt, endsAt, req.control.user_id]);

    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      requestId: req.requestId, entity: "system_announcements",
      entityId: ins.rows[0].id, action: "control.announcement.created"
    }));
    return reply.code(201).send(ins.rows[0]);
  });

  app.put("/control/announcements/:id", { preHandler: [requireControl] }, async (req: any) => {
    if (!hasLicenceRole(req.control.roles ?? [])) throw new ApiError("FORBIDDEN", "Not permitted", 403);
    const id = z.string().uuid().parse((req.params as any).id);
    const body = z.object({
      message: z.string().trim().min(4).max(400).optional(),
      kind: z.enum(KINDS).optional(),
      active: z.boolean().optional(),
      startsAt: isoDate.nullable().optional(),
      endsAt: isoDate.nullable().optional()
    }).strict().parse(req.body);

    // Presence-based (like drivers PUT): absent key keeps, explicit null clears.
    const touchStarts = body.startsAt !== undefined;
    const touchEnds = body.endsAt !== undefined;
    if (touchStarts && touchEnds && body.startsAt && body.endsAt
      && new Date(body.endsAt) <= new Date(body.startsAt)) {
      throw new ApiError("VALIDATION_FAILED", "End time must be after start time.", 400,
        [{ field: "endsAt" }]);
    }

    const updated = await pool.query(
      `update system_announcements set
         message = coalesce($2, message),
         kind = coalesce($3, kind),
         active = coalesce($4, active),
         starts_at = case when $5 then $6::timestamptz else starts_at end,
         ends_at = case when $7 then $8::timestamptz else ends_at end
       where id = $1
       returning id, message, kind, active, starts_at, ends_at, created_at, updated_at`,
      [id, body.message ?? null, body.kind ?? null, body.active ?? null,
       touchStarts, touchStarts ? body.startsAt : null,
       touchEnds, touchEnds ? body.endsAt : null]);
    if (!updated.rowCount) throw new ApiError("NOT_FOUND", "Announcement not found", 404);

    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      requestId: req.requestId, entity: "system_announcements",
      entityId: id, action: "control.announcement.updated"
    }));
    return updated.rows[0];
  });
}
