import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { requireControl } from "./control.routes.js";
import { requireControlPermission } from "./control-analytics.routes.js";
import { sendSms } from "../mail/mail.js";
import type { AppliedAction, TenantAction } from "../mail/tenant-notice.js";
import { sendTenantNotice } from "../mail/tenant-notice.js";
import {
  BLOCK_AFTER_DAYS, CLOSE_AFTER_DAYS, CANDIDATES_SQL, runTenantPolicy
} from "../util/tenant-policy.js";
import { forgetSuspensions } from "../security/tenant-state.js";

/**
 * The desk's hand on a company (task #127).
 *
 * Four acts, one register. Block suspends the company and revokes its sessions; unblock
 * restores it to the status it was found in; notice tells it something without touching
 * its state; close tombstones it. All four go through `platform_auth.tenant_apply_action`,
 * which is the only door that writes `tenant_actions` — so the handler here cannot
 * invent a reason, skip the audit row, or forget the notice, and a company's record of why
 * it was blocked is not something a request body can overtype.
 *
 * The gate is `control.tenants.manage`, the key 005 seeded and nothing ever checked. It is
 * deliberately not `hasLicenceRole`: selling a company a plan and shutting one down are
 * different jobs, and billing_admin keeps the first without getting the second.
 *
 * Nothing in this file decides policy. The reason code and the note come from the person
 * at the desk; the length limits below exist only so a mistake is answered with a 400
 * rather than with the definer's string, which would reach the browser as a 500-shaped
 * surprise. The definer validates them again, and that copy is the one that holds.
 */

const MANAGE = "control.tenants.manage";

/** Params: tenant, action, reason, note, actor kind, actor user, actor role, ip. */
const APPLY_SQL =
  "select platform_auth.tenant_apply_action($1,$2,$3,$4,$5,$6,$7,$8) as r";
/** Params: action id, receipt. */
const RECEIPT_SQL = "select platform_auth.tenant_action_receipt($1, $2::jsonb) as r";
/** Params: tenant, limit. Exported so the verify script reads the same statement. */
export const HISTORY_SQL = "select platform_auth.control_tenant_actions($1, $2) as a";

const actionBody = z.object({
  reasonCode: z.enum([
    "terms_violation", "long_idle", "payment_default", "abuse", "complaint", "security", "other"
  ]),
  // The note is the sentence the company reads, so it has a floor as well as a ceiling:
  // "violation" is not a reason, and an 8-character minimum is the cheapest way to say
  // that in a schema instead of in a policy document nobody reads.
  note: z.string().trim().min(8).max(600)
}).strict();

/** invalid from the definer is a bad body; conflict and not_found are real states. */
function fail(res: { status?: string; message?: string }, tenantId: string) {
  switch (res.status) {
    case "conflict":
      throw new ApiError("CONFLICT", res.message ?? "That action does not apply right now.", 409);
    case "not_found":
      throw new ApiError("NOT_FOUND", `No company account ${tenantId}.`, 404);
    default:
      throw new ApiError("VALIDATION_FAILED", res.message ?? "The action was refused.", 400);
  }
}

/**
 * Act, then tell, then record that the telling happened.
 *
 * The order matters and is not negotiable: the block commits first so a mail provider
 * that is down cannot leave a company that must be shut still trading. `sendTenantNotice`
 * never throws, so the only way this route returns without a receipt on the register is
 * if the send itself was impossible — and the desk sees an empty `delivery` and resends.
 */
async function applyAndNotify(
  req: any, tenantId: string, action: TenantAction, reasonCode: string, note: string
) {
  const { rows } = await pool.query(APPLY_SQL, [
    tenantId, action, reasonCode, note, "control",
    req.control.user_id, (req.control.roles ?? [])[0] ?? null, req.ip
  ]);
  const res = rows[0]?.r as (AppliedAction & { status: string }) | undefined;
  if (!res) throw new ApiError("UPSTREAM_ERROR", "The action could not be recorded.", 502);
  if (res.status !== "ok") fail(res, tenantId);
  forgetSuspensions();

  const receipt = await sendTenantNotice(res, sendSms);
  await pool.query(RECEIPT_SQL, [res.action_id, JSON.stringify(receipt)]);
  // `targets` is the definer's working copy: plaintext director emails and the stored
  // phone blobs. The desk does not need it — `delivery.to` carries the masked version of
  // the same list — and a contact a handler echoes back is a contact nobody can recall.
  const echoed = { ...res } as Record<string, unknown>;
  delete echoed.targets;
  return { ...echoed, delivery: receipt };
}

export async function controlTenantsRoutes(app: FastifyInstance, _opts: unknown) {

  // The register for one company, newest first, receipts included.
  app.get("/control/tenants/:id/actions", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    const { id } = req.params as { id: string };
    const limit = Math.min(Math.max(Number((req.query as any)?.limit ?? 20) || 20, 1), 50);
    const { rows } = await pool.query(HISTORY_SQL, [id, limit]);
    return { tenant_id: id, actions: rows[0]?.a ?? [] };
  });

  // Who the idle clock is about to act on, and how long they have. A preview only:
  // the sweep re-reads the same definer, so what the desk sees here is what the next
  // pass will do, not a copy of the rule that can drift from it.
  app.get("/control/tenants/policy/idle", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    const { rows } = await pool.query(CANDIDATES_SQL, [BLOCK_AFTER_DAYS, CLOSE_AFTER_DAYS]);
    return {
      block_after_days: BLOCK_AFTER_DAYS,
      close_after_days: CLOSE_AFTER_DAYS,
      candidates: rows[0]?.c ?? []
    };
  });

  // Run the idle clock now, rather than waiting for the interval. Same function, same
  // register, same notices — this only removes the wait, and is rate limited because a
  // desk operator pressing it twelve times would otherwise send twelve sweeps.
  app.post("/control/tenants/policy/sweep", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`tenant-sweep:${req.control.user_id}`, 6, 3600);
    return runTenantPolicy();
  });

  for (const action of ["block", "unblock", "close", "notice"] as const) {
    app.post(`/control/tenants/:id/${action}`, { preHandler: [requireControl] }, async (req: any) => {
      await requireControlPermission(req, MANAGE);
      await enforceRateLimit(`tenant-action:${req.control.user_id}`, 20, 3600);
      const { id } = req.params as { id: string };
      const body = actionBody.parse(req.body);
      return applyAndNotify(req, id, action, body.reasonCode, body.note);
    });
  }
}
