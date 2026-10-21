import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { requireControl } from "./control.routes.js";
import { controlHolds, requireControlPermission } from "./control-analytics.routes.js";
import {
  DECIDE, VIEW, board, decisionBody, detail, kindOf, propose,
  proposalBody, reject, releaseAndApply
} from "../control/approvals.js";

/**
 * The approvals desk (121).
 *
 * A route file with no policy in it, on purpose. Whether a proposal is the same seat as
 * its decision, whether it has expired, whether the payload still matches the hash that
 * was signed, whether the company still exists to be banned — all four are answered inside
 * the definers, because that is the only place a request body cannot reach them. What is
 * here is the gate, the shape, and the rate limit.
 *
 * Two duties, and the split is the whole design. `control.approvals.view` reads the
 * register; `control.approvals.decide` signs it, and 121 seeded that key onto exactly the
 * roles that already hold `control.tenants.manage`, because the seat that can sign a ban
 * must be a seat that understands one. Raising a proposal costs the duty the act itself
 * would have cost, so a desk cannot queue up a ban it had no right to perform.
 *
 * Reading is gated on either key. A seat that can sign but not read would be asked to
 * approve a sentence it cannot see.
 */

async function requireAnyDuty(req: any, keys: string[]) {
  const held = await controlHolds(req, keys);
  if (!held.length) {
    throw new ApiError("FORBIDDEN", "Your platform role does not allow this.", 403);
  }
}

function idOf(params: any): string {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(params ?? {});
  if (!parsed.success) throw new ApiError("VALIDATION_FAILED", "That is not an approval id.", 400);
  return parsed.data.id;
}

export async function controlApprovalsRoutes(app: FastifyInstance, _opts: unknown) {

  // The board: newest first, per-status counts from the same call, one search box that
  // reads the reason, the company and the note the proposer wrote.
  app.get("/control/approvals", { preHandler: [requireControl] }, async (req: any) => {
    await requireAnyDuty(req, [VIEW, DECIDE]);
    await enforceRateLimit(`approvals-board:${req.control.user_id}`, 120, 60);
    return board(req.query);
  });

  // One proposal by its id, for a deep link and for the "why is this missing" question that
  // follows a signature nobody can find on the board. Reading it costs the same duty as
  // reading the board, because it returns the same sentence.
  app.get("/control/approvals/:id", { preHandler: [requireControl] }, async (req: any) => {
    await requireAnyDuty(req, [VIEW, DECIDE]);
    await enforceRateLimit(`approvals-detail:${req.control.user_id}`, 120, 60);
    return detail(idOf(req.params));
  });

  // Raise. Nothing is done to the company by this call, and the response says so: the
  // desk has to be able to tell a queued proposal from an applied one at a glance.
  app.post("/control/approvals", { preHandler: [requireControl] }, async (req: any) => {
    const body = z.object({ action: z.string().trim().min(3).max(80) })
      .merge(proposalBody).strict().parse(req.body);
    const kind = kindOf(body.action);
    await requireControlPermission(req, kind.proposeDuty);
    await enforceRateLimit(`approvals-propose:${req.control.user_id}`, 20, 3600);
    return propose(req, kind.action, body);
  });

  // Sign, and the effect follows inside the same transaction. This is the endpoint the
  // rule lives on: a seat cannot approve its own proposal, and a proposal that cannot be
  // applied does not get its signature spent.
  app.post("/control/approvals/:id/approve",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, DECIDE);
      await enforceRateLimit(`approvals-decide:${req.control.user_id}`, 20, 3600);
      const id = idOf(req.params);
      const body = decisionBody.parse(req.body);
      return releaseAndApply(req, id, body.note);
    });

  // Refuse. Same seat, same duty, same one-line sentence — and nothing happens.
  app.post("/control/approvals/:id/reject",
    { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, DECIDE);
      await enforceRateLimit(`approvals-decide:${req.control.user_id}`, 20, 3600);
      const id = idOf(req.params);
      const body = decisionBody.parse(req.body);
      return reject(req, id, body.note);
    });
}
