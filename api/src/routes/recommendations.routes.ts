import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const AREAS = ["transport", "cfa", "office", "marketplace", "billing",
  "documents", "account", "support", "other"] as const;

const submitSchema = z.object({
  area: z.enum(AREAS).default("other"),
  title: z.string().trim().min(4).max(140),
  body: z.string().trim().min(15).max(4000)
}).strict();

/**
 * The recommendation inbox (070) — one handler pair mounted twice.
 *
 * Both halves run inside the AUTHOR's tenant, which is why neither needs a SECURITY
 * DEFINER: the table's own policy already lets a company write and read its rows, and
 * 067's rule is not to open a wider door than the one RLS holds shut. The desk that
 * reads across tenants is a different route file (control-recommendations) and does use
 * the definers — crossing is the only thing that earns a definer here.
 *
 * The second and third mount points are the other two audiences. A seeker is an account
 * with no office to phone and no director to corner, so it is the one that most needs this
 * box; a shipper's complaint currently reaches the platform by telephone and is then
 * remembered by whoever answered it. Both surfaces (`/api/v1/seeker/`, `/api/v1/portal/`)
 * are already open prefixes for portal-only tokens, and both own a tenant row, so nothing
 * about either write is special — same handler, same table, same RLS policy.
 */
export async function recommendationRoutes(app: FastifyInstance, _opts: unknown) {

  async function listMine(req: any) {
    return withTenant(req.user.tid, async (c) => {
      const { rows } = await c.query(
        `select id, area, title, body, status, priority, reply, replied_at,
                decided_at, created_at
           from recommendations
          where tenant_id = $1 and author_user_id = $2 and deleted_at is null
          order by created_at desc
          limit 100`,
        [req.user.tid, req.user.sub]);
      return rows;
    });
  }

  async function submit(req: any, reply: any) {
    await enforceRateLimit(`recommendations:uid:${req.user.sub}`, 8, 3600);
    const body = submitSchema.parse(req.body);
    const ins = await withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        `insert into recommendations
           (tenant_id, author_user_id, area, title, body, created_by)
         values ($1,$2,$3,$4,$5,$2)
         returning id, area, title, body, status, priority, reply, created_at`,
        [req.user.tid, req.user.sub, body.area, body.title, body.body]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "recommendations", entityId: r.rows[0].id,
        action: "recommendation.submitted",
        after: { area: body.area, title: body.title }
      });
      return r.rows[0];
    });
    return reply.code(201).send(ins);
  }

  /**
   * Withdrawal, not deletion. The table has no DELETE grant on purpose: a note that was
   * sent and then taken back still belongs in "how many did we receive", and an author
   * yanking a card after the desk had already answered it would erase the answer too.
   * So only an unread `new` card can be pulled, and the row stays.
   */
  async function withdraw(req: any) {
    const id = z.string().uuid().parse((req.params as any).id);
    return withTenant(req.user.tid, async (c) => {
      const upd = await c.query(
        `update recommendations
            set deleted_at = now(), updated_by = $3
          where id = $1 and tenant_id = $2 and author_user_id = $3
            and deleted_at is null and status = 'new'
            and decided_by is null and reply is null
          returning id`,
        [id, req.user.tid, req.user.sub]);
      if (!upd.rowCount) {
        throw new ApiError("CONFLICT",
          "Only a recommendation nobody has read yet can be withdrawn.", 409);
      }
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "recommendations", entityId: id,
        action: "recommendation.withdrawn"
      });
      return { id, withdrawn: true };
    });
  }

  // One handler set, three doors. A loop rather than nine registrations because the
  // three audiences must not be allowed to drift apart: a seeker's note and a
  // director's note have to land in the same register or the desk is not one inbox.
  for (const surface of ["", "/seeker", "/portal"]) {
    app.get(`${surface}/recommendations`,
      { preHandler: [requireAuth, requirePermission("recommendations.view")] },
      async (req: any) => listMine(req));

    app.post(`${surface}/recommendations`,
      { preHandler: [requireAuth, requirePermission("recommendations.write")] },
      async (req: any, reply) => submit(req, reply));

    app.post(`${surface}/recommendations/:id/withdraw`,
      { preHandler: [requireAuth, requirePermission("recommendations.write")] },
      async (req: any) => withdraw(req));
  }
}
