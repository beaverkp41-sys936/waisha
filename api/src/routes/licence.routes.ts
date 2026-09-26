import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { searchHash } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

export async function licenceRoutes(app: FastifyInstance, _opts: unknown) {

  // Snapshot the caller sees after every login (drives the gate + banner)
  app.get("/licence", { preHandler: [requireAuth] }, async (req: any) => {
    const r = await pool.query("select platform_auth.get_licence($1) as l", [req.user.tid]);
    const l = r.rows[0]?.l ?? {};
    const operational = await pool.query(
      "select platform_auth.tenant_is_operational() as ok");
    return { ...l, operational: operational.rows[0].ok };
  });

  // Start the 48-hour trial (spec 5.3) — one per TIN, per phone, enforced server-side
  app.post("/licence/trial", { preHandler: [requireAuth] }, async (req: any, reply) => {
    await enforceRateLimit(`trial:uid:${req.user.sub}`, 5, 3600);

    // The caller's TIN/phone searches come from their own tenant row — never from input
    const t = await withTenant(req.user.tid, (c) => c.query(
      "select tin_search, phone_search from tenants where id=$1 and deleted_at is null",
      [req.user.tid]));
    if (!t.rowCount) throw new ApiError("NOT_FOUND", "Tenant not found", 404);
    const { tin_search, phone_search } = t.rows[0];

    const r = await pool.query(
      "select platform_auth.claim_trial($1,$2,$3,$4) as r",
      [req.user.tid, tin_search, phone_search, 2]);
    const res = r.rows[0].r;

    if (res.status === "ok") {
      await withTenant(req.user.tenantCtx?.tenant_id ?? req.user.tid, async (c) => {
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "subscriptions",
          action: "licence.trial.started", after: { trial_ends_at: res.trial_ends_at }
        });
      });
      return reply.send(res);
    }
    if (res.status === "already_used") throw new ApiError("CONFLICT", res.message, 409);
    if (res.status === "conflict") throw new ApiError("CONFLICT", res.message, 409);
    throw new ApiError("VALIDATION_FAILED", res.message ?? "Trial unavailable", 400);
  });

  // Payment intent — placeholder until AzamPay lands in Part 2D.
  app.post("/licence/pay", { preHandler: [requireAuth] }, async (req: any, reply) => {
    await enforceRateLimit(`pay:uid:${req.user.sub}`, 5, 3600);
    z.object({
      planKey: z.enum(["starter", "business", "enterprise"]),
      billingCycle: z.enum(["monthly", "quarterly", "annual"]),
      seats: z.number().int().min(1).max(10000),
      payerPhone: z.string().regex(/^\+[1-9]\d{7,14}$/)
    }).parse(req.body);
    throw new ApiError("NOT_IMPLEMENTED", "Card and mobile-money payments arrive with the payment step. The 48-hour trial is available now.", 501);
  });
}