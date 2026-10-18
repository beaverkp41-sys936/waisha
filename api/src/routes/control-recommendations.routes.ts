import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";

/**
 * The admin side of the recommendation inbox (070).
 *
 * This is where a definer is owed: the register is one list across every company, and a
 * bare pool.query has no app.tenant_id, so RLS would answer with zero rows and the desk
 * would read "nobody has said anything" on a busy system — the exact failure 066 built
 * the cross-tenant readers to avoid. The decision writer crosses in the other direction:
 * a control seat updating a row that belongs to somebody else's company.
 *
 * Neither takes a tenant argument. The caller names a recommendation by id, and the row's
 * own tenant is whatever the register said it was, so there is no parameter here that
 * could point an update at a company the seat never saw.
 */

const VIEW = "control.recommendations.view";
const MANAGE = "control.recommendations.manage";

/** Exported so the verify script executes the identical string, not a re-typing. */
export const RECOMMENDATION_REGISTER_SQL =
  "select * from platform_auth.control_recommendation_register($1,$2,$3,$4,$5)";
export const RECOMMENDATION_DECISION_SQL =
  "select id, status, priority, reply from platform_auth.record_recommendation_decision($1,$2,$3,$4,$5)";

const STATUSES = ["new", "reviewing", "planned", "built", "declined"] as const;
const AREAS = ["transport", "cfa", "office", "marketplace", "billing",
  "documents", "account", "support", "other"] as const;
const PRIORITIES = ["high", "medium", "low"] as const;

const decisionSchema = z.object({
  status: z.enum(STATUSES),
  // Absent keeps the desk's previous judgement; a status change is not the moment to
  // quietly demote something somebody already labelled urgent.
  priority: z.enum(PRIORITIES).optional(),
  // Explicit null clears: the desk is allowed to change its mind about an answer, and a
  // sentence that was retracted must not keep a name and a timestamp attached to it.
  reply: z.string().trim().min(5).max(2000).nullish()
}).strict();

export async function controlRecommendationRoutes(app: FastifyInstance, _opts: unknown) {

  app.get("/control/recommendations", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`recommendations:uid:${req.control.user_id}`, 120, 60);

    const q = z.object({
      status: z.enum(STATUSES).optional(),
      area: z.enum(AREAS).optional(),
      priority: z.enum(PRIORITIES).optional(),
      q: z.string().trim().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional()
    }).strict().parse(req.query);

    const { rows } = await pool.query(RECOMMENDATION_REGISTER_SQL,
      [q.status ?? null, q.area ?? null, q.priority ?? null, q.q ?? null, q.limit ?? 200]);
    return rows;
  });

  app.post("/control/recommendations/:id/decision",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, MANAGE);
      await enforceRateLimit(`recommendations:uid:${req.control.user_id}`, 60, 60);

      const id = z.string().uuid().parse((req.params as any).id);
      const body = decisionSchema.parse(req.body);

      const { rows } = await pool.query(RECOMMENDATION_DECISION_SQL,
        [id, body.status, body.priority ?? null, body.reply ?? null, req.control.user_id]);
      const row = rows[0];

      await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
        tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
        requestId: req.requestId, entity: "recommendations", entityId: id,
        action: "control.recommendation.decided",
        after: { status: row.status, priority: row.priority, answered: row.reply !== null }
      }));
      return row;
    });
}
