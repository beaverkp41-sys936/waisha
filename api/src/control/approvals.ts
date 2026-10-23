import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, withTx } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { sendSms } from "../mail/mail.js";
import type { AppliedAction } from "../mail/tenant-notice.js";
import { sendTenantNotice } from "../mail/tenant-notice.js";
import { APPLY_SQL, RECEIPT_SQL } from "../util/tenant-policy.js";
import { forgetSuspensions } from "../security/tenant-state.js";

/**
 * The two-person register (121).
 *
 * The office's rule for the panel is that money, prices, bans and duty changes need a
 * second seat. A convention in four route files is how that rule dies: the fifth route
 * forgets, and nobody notices until a company was blocked by one person who wrote the
 * reason themselves. So the rule lives in the database — `platform_approvals` refuses a
 * proposer and a decider in the same seat, one open proposal per action per target, and
 * `tenant_actions_two_seats` refuses to let a control-actor ban be written without a
 * released signature behind it. This module is the thin end: it names the kinds that can
 * be proposed, calls the definers in the right order, and turns their statuses into HTTP.
 *
 * The order is the security property, so it is one transaction:
 *
 *   BEGIN → decide_approval(approve) → claim_approval → tenant_apply_action(…, approval)
 *         → settle_approval → COMMIT
 *
 * Decide and spend together means a signature that was released but could not be used
 * never exists: if the effect answers `conflict` — somebody unblocked the company in the
 * meantime — the whole thing rolls back and the proposal is still pending for a second
 * opinion. Claim before apply means exactly one caller can win, so two desks pressing the
 * same signature at once produce one ban, not two. Only the seat that signed may spend it:
 * a signature is not a token to be handed around the office.
 *
 * The notice stays outside the transaction, after the commit — 078's rule, kept intact.
 * A mail provider that is down must never leave a company that two people agreed to shut
 * still trading, so the door closes first and the receipt is written onto the register
 * row afterwards.
 */

export const VIEW = "control.approvals.view";
export const DECIDE = "control.approvals.decide";
/** Raising a proposal costs the duty the act itself would have cost. */
const TENANTS_MANAGE = "control.tenants.manage";
const REFUND_MANAGE = "control.payments.manage";
const CUSTOMERS_ERASE = "control.customers.erase";

/**
 * What can be signed, and what signing it does.
 *
 * A kind with no apply path here would be a signature that can never be spent, so the
 * registry is deliberately exhaustive: every entry names the effect its released signature
 * buys. Three effects exist today because the platform has three kinds of thing the rule
 * covers — a company's access, money going back out, and a person's data leaving the
 * registers — and a fourth joins by naming its own definer rather than by restating the
 * transaction below.
 *
 * `proposable` is the one field the desk cannot ignore. A refund paper's payload is the
 * figure and the call it belongs to, and those are read out of the row by
 * `propose_refund_release` so that the bytes the second seat signs are provably the paper.
 * The generic raise endpoint takes a body, so it is not allowed to raise that one.
 */
export interface ApprovalKind {
  action: string;
  label: string;
  /** Which duty the proposing seat must hold. */
  proposeDuty: string;
  /** What a released signature is spent on. */
  effect: "tenant_action" | "refund_release" | "data_erasure";
  /** The `tenant_actions` verb a ban releases into. */
  tenantAction?: "block" | "close";
  /** Whether this desk may raise it at all. */
  proposable: boolean;
}

export const KINDS: Record<string, ApprovalKind> = {
  "tenant.block": {
    action: "tenant.block", label: "Block a company's access",
    proposeDuty: TENANTS_MANAGE, effect: "tenant_action",
    tenantAction: "block", proposable: true
  },
  "tenant.close": {
    action: "tenant.close", label: "Close a company account",
    proposeDuty: TENANTS_MANAGE, effect: "tenant_action",
    tenantAction: "close", proposable: true
  },
  // Raised from the Service desk against one refund paper (126). It appears on this board
  // like any other signature, because the register it lives in is the same one and the seat
  // that signs it is asked to read the same sentence.
  "service.refund": {
    action: "service.refund", label: "Release a refund to a caller",
    proposeDuty: REFUND_MANAGE, effect: "refund_release", proposable: false
  },
  // Raised from the Customers desk against one erasure paper (129): `propose_data_erasure`
  // reads the account, its closed date and the category list out of the row and hashes what
  // it read. The mask is the whole of the effect — a personal data erasure is not a state a
  // caller is emailed about, so the notice stays on the ban branch with the mail provider.
  "customer.erase": {
    action: "customer.erase", label: "Erase an account's personal data",
    proposeDuty: CUSTOMERS_ERASE, effect: "data_erasure", proposable: false
  }
};

export function kindOf(action: string): ApprovalKind {
  const k = KINDS[action];
  if (!k) {
    throw new ApiError("VALIDATION_FAILED",
      `Nothing here can be proposed as "${action}".`, 400);
  }
  return k;
}

/**
 * The six statements the register answers on, exported so 121's verify script runs the
 * same strings a handler runs rather than a copy of them.
 */
/** Params: action, target kind, target id, payload, reason, actor, role, ip, ua. */
export const PROPOSE_SQL =
  "select platform_auth.propose_approval($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) as r";
/** Params: id, decision, note, actor, role, ip, ua. */
export const DECIDE_SQL = "select platform_auth.decide_approval($1,$2,$3,$4,$5,$6,$7) as r";
/** Params: id, actor. */
export const CLAIM_SQL = "select platform_auth.claim_approval($1,$2) as r";
/** Params: id, result jsonb. */
export const SETTLE_SQL = "select platform_auth.settle_approval($1,$2::jsonb) as r";
/** Params: approval, actor, role, ip. 126's refund effect, read out of the paper's own row. */
export const REFUND_APPLY_SQL =
  "select platform_auth.apply_refund_release($1,$2,$3,$4) as r";
/** Params: approval, actor, role, ip. 129's mask, which re-reads the categories off the payload. */
export const ERASE_APPLY_SQL =
  "select platform_auth.apply_data_erasure($1,$2,$3,$4) as r";
/** Params: status, action, search, limit, offset. */
export const BOARD_SQL = "select platform_auth.approvals_board($1,$2,$3,$4,$5) as b";
/** Params: id. */
export const DETAIL_SQL = "select platform_auth.approval_detail($1) as d";

export const REASON_CODES = [
  "terms_violation", "long_idle", "payment_default", "abuse", "complaint", "security", "other"
] as const;

export const proposalBody = z.object({
  targetId: z.string().uuid(),
  reasonCode: z.enum(REASON_CODES),
  // Two sentences, because two people read them. `note` is what the company is told;
  // `reason` is what the second seat is asked to sign, and it is the one that has to
  // survive being quoted back a month later in a dispute.
  note: z.string().trim().min(8).max(600),
  reason: z.string().trim().min(8).max(600)
}).strict();
export type ProposalInput = z.infer<typeof proposalBody>;

export const decisionBody = z.object({
  // Four characters, not eight: "yes, block it" is an honest signature line and the
  // substance is already in the proposal the seat is reading.
  note: z.string().trim().min(4).max(400)
}).strict();
export type DecisionInput = z.infer<typeof decisionBody>;

/** The definer's `ua` column is a device fingerprint, so it is the header, capped there. */
function ua(req: any): string {
  return String(req.headers?.["user-agent"] ?? "").slice(0, 300);
}

function actor(req: any) {
  return {
    id: req.control.user_id as string,
    role: ((req.control.roles ?? [])[0] ?? null) as string | null,
    ip: req.ip as string
  };
}

async function run(client: PoolClient | typeof pool, sql: string, params: unknown[]) {
  const { rows } = await client.query(sql, params as any[]);
  return rows[0] as Record<string, any>;
}

/**
 * The definer's refusals are real states, not exceptions to dress up as 500s.
 *
 * `self` is the two-person rule answering a seat that tried to sign its own work, and it
 * gets its own code so the desk can say "ask a second person" instead of "forbidden".
 */
function refusal(r: any, id: string): never {
  const message = typeof r?.message === "string" ? r.message : null;
  switch (r?.status) {
    case "conflict":
      throw new ApiError("APPROVAL_OPEN", message ?? "That proposal is already settled.", 409);
    case "not_found":
      throw new ApiError("NOT_FOUND", `No approval ${id}.`, 404);
    case "self":
      throw new ApiError("SELF_APPROVAL",
        message ?? "The seat that raised a proposal cannot sign it.", 403);
    case "lapsed":
      throw new ApiError("APPROVAL_LAPSED",
        message ?? "This proposal expired before anyone signed it.", 410);
    case "unauthorised":
      throw new ApiError("FORBIDDEN", message ?? "That signature is not yours to spend.", 403);
    default:
      throw new ApiError("VALIDATION_FAILED", message ?? "The proposal was refused.", 400);
  }
}

/**
 * `targets` is the definer's working copy: plaintext director emails and stored phone
 * blobs. Nothing that answers a desk may echo it — `delivery.to` carries the masked list.
 */
function stripTargets(row: Record<string, unknown>) {
  const echoed = { ...row };
  delete echoed.targets;
  return echoed;
}

/**
 * Raise a proposal. Nothing happens to the company: this writes the sentence and the hash
 * of the payload that would carry it out, so the second seat signs exactly these bytes.
 */
export async function propose(req: any, action: string, body: ProposalInput) {
  const kind = kindOf(action);
  if (!kind.proposable) {
    throw new ApiError("VALIDATION_FAILED",
      `${kind.label} is raised from the paper it is about, not from this desk — the figure a ` +
      "second seat signs has to be read out of the row, not typed into a body.", 400);
  }
  const a = actor(req);
  const r = await run(pool, PROPOSE_SQL, [
    kind.action, "tenant", body.targetId,
    // The definer rebuilds this canonically and hashes what it rebuilt, so a payload
    // reordered by a different client still produces the same signature target.
    JSON.stringify({ tenant_id: body.targetId, reason_code: body.reasonCode, note: body.note }),
    body.reason, a.id, a.role, a.ip, ua(req)
  ]).then((x) => x.r);
  if (!r) throw new ApiError("UPSTREAM_ERROR", "The proposal could not be recorded.", 502);
  if (r.status !== "ok") refusal(r, "proposal");
  return r as Record<string, unknown>;
}

/**
 * Sign a proposal and refuse it. One call either way, because the sentence the decider
 * types is the same in both cases and a desk that has to pick the right endpoint to say
 * "no" is a desk that will accidentally say "yes".
 */
async function decide(req: any, id: string, decision: "approve" | "reject", note: string) {
  const a = actor(req);
  const r = await run(pool, DECIDE_SQL, [id, decision, note, a.id, a.role, a.ip, ua(req)])
    .then((x) => x.r);
  if (!r) throw new ApiError("UPSTREAM_ERROR", "The decision could not be recorded.", 502);
  if (r.status !== "ok") refusal(r, id);
  return r as Record<string, unknown>;
}

export async function reject(req: any, id: string, note: string) {
  return decide(req, id, "reject", note);
}

/**
 * Release the signature and spend it in the same transaction, then tell the company.
 *
 * The `actor_kind` written to the register is `control` and the actor is the seat that
 * signed, because they are the one who pressed the button; `approval_id` is what names the
 * proposer beside them. The trigger reads that pair and lets the row through only if a
 * real, matching, second-seat proposal stands behind it.
 *
 * The effects share the order and nothing else after it. A refund paper and an erasure are both
 * finished inside the transaction — the row itself is the receipt, and there is no caller to email
 * about a signature — so the notice, its cached gate clearing and its delivery receipt all stay on
 * the ban branch, where 078 put them for the reason that still holds: a mail provider that is down
 * must never leave a company two people agreed to shut still trading.
 */
type Spent =
  | { kind: ApprovalKind; tenant: AppliedAction; refund?: undefined; erasure?: undefined }
  | { kind: ApprovalKind; tenant?: undefined; refund: Record<string, unknown>; erasure?: undefined }
  | { kind: ApprovalKind; tenant?: undefined; refund?: undefined; erasure: Record<string, unknown> };

export async function releaseAndApply(req: any, id: string, note: string) {
  const a = actor(req);
  const decision = [id, "approve", note, a.id, a.role, a.ip, ua(req)];
  let spent: Spent;
  try {
    spent = await withTx(async (c): Promise<Spent> => {
      const d = await run(c, DECIDE_SQL, decision);
      if (!d.r) throw new ApiError("UPSTREAM_ERROR", "The decision could not be recorded.", 502);
      if (d.r.status !== "ok") refusal(d.r, id);

      const cl = await run(c, CLAIM_SQL, [id, a.id]);
      if (cl.r?.status !== "ok") {
        throw new ApiError("APPROVAL_SPENT",
          "That signature had already been used. Nothing was changed.", 409);
      }

      const kind = kindOf(cl.r.action);

      if (kind.effect === "refund_release") {
        const res = await run(c, REFUND_APPLY_SQL, [id, a.id, a.role, a.ip]);
        const eff = res.r as (Record<string, any> | undefined);
        if (!eff) throw new ApiError("UPSTREAM_ERROR", "The refund could not be recorded.", 502);
        // Same rule as the ban: the paper did not move, so the signature must not have been
        // spent by the attempt that failed to move it.
        if (eff.status !== "ok") {
          throw new ApiError(eff.status === "not_found" ? "NOT_FOUND" : "CONFLICT",
            eff.message ?? "The paper changed under this signature. Nothing was released.",
            eff.status === "not_found" ? 404 : 409);
        }
        await run(c, SETTLE_SQL, [id, JSON.stringify({
          request_id: eff.request_id, ref: eff.ref, amount: eff.amount,
          currency: eff.currency, pay_back: eff.pay_back,
          request_status: eff.request_status, released_by: eff.released_by
        })]);
        return { kind, refund: eff };
      }

      if (kind.effect === "data_erasure") {
        const res = await run(c, ERASE_APPLY_SQL, [id, a.id, a.role, a.ip]);
        const eff = res.r as (Record<string, any> | undefined);
        if (!eff) throw new ApiError("UPSTREAM_ERROR", "The erasure could not be recorded.", 502);
        // The mask re-reads the payload hash, the account's closed date and the paper's own state
        // before it touches a column. Any "no" from it rolls the whole thing back: a signature that
        // erased nothing must not be recorded as one that did.
        if (eff.status !== "ok") {
          throw new ApiError(eff.status === "not_found" ? "NOT_FOUND" : "CONFLICT",
            eff.message ?? "The paper changed under this signature. Nothing was erased.",
            eff.status === "not_found" ? 404 : 409);
        }
        await run(c, SETTLE_SQL, [id, JSON.stringify({
          request_id: eff.request_id, ref: eff.ref, company_tenant_id: eff.company_tenant_id,
          categories: eff.categories, reached: eff.reached, kept: eff.kept,
          request_status: eff.request_status, erased_by: eff.erased_by
        })]);
        return { kind, erasure: eff };
      }

      const payload = cl.r.payload as { tenant_id: string; reason_code: string; note: string };
      const res = await run(c, APPLY_SQL, [
        payload.tenant_id, kind.tenantAction!, payload.reason_code, payload.note,
        "control", a.id, a.role, a.ip, id
      ]);
      const eff = res.r as (AppliedAction & { status: string }) | undefined;
      if (!eff) throw new ApiError("UPSTREAM_ERROR", "The action could not be recorded.", 502);
      // Throwing here is the point of the transaction: the company's state did not change,
      // so the signature must not have been consumed by the attempt.
      if (eff.status !== "ok") {
        throw new ApiError(eff.status === "not_found" ? "NOT_FOUND" : "CONFLICT",
          `The company's state changed under this proposal: ${eff.status}. Nothing was applied.`,
          eff.status === "not_found" ? 404 : 409);
      }

      await run(c, SETTLE_SQL, [id, JSON.stringify({
        action_id: eff.action_id, new_status: eff.new_status,
        sessions_revoked: eff.sessions_revoked ?? null
      })]);
      return { kind, tenant: eff as AppliedAction };
    });
  } catch (e) {
    // The definer marks an expired proposal lapsed as it refuses it, and the rollback above
    // takes that mark away with everything else — so the desk has been told the window
    // passed while the register still says `pending`. That is not only untidy: the partial
    // unique index lets one open proposal per act per target, so an expired row that is
    // still pending keeps the slot, and the next seat is answered "already open" for a
    // signature nobody can give. Re-ask the decision outside the transaction, where the
    // mark is on its own statement and sticks.
    if ((e as ApiError)?.code === "APPROVAL_LAPSED") {
      await run(pool, DECIDE_SQL, decision).catch(() => null);
    }
    throw e;
  }

  if (spent.kind.effect === "refund_release") {
    return { ...spent.refund, approval_id: id };
  }
  // The subject of an erasure is not emailed that their data is gone — the register row is the
  // answer, and the desk that raised the paper reads it back from there.
  if (spent.kind.effect === "data_erasure") {
    return { ...spent.erasure, approval_id: id };
  }

  const applied = spent.tenant!;
  forgetSuspensions();
  const receipt = await sendTenantNotice(applied, sendSms);
  await pool.query(RECEIPT_SQL, [applied.action_id, JSON.stringify(receipt)]);
  return { ...stripTargets(applied as unknown as Record<string, unknown>),
    delivery: receipt, approval_id: id };
}

const STATUSES = ["pending", "approved", "applied", "rejected", "lapsed"] as const;

export async function board(query: any) {
  const q = z.object({
    status: z.enum(STATUSES).optional(),
    action: z.string().trim().max(80).optional(),
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    offset: z.coerce.number().int().min(0).max(100000).default(0)
  }).parse(query ?? {});
  const r = await run(pool, BOARD_SQL,
    [q.status ?? null, q.action ?? null, q.q || null, q.limit, q.offset]);
  return (r.b ?? { rows: [], counts: {} }) as Record<string, unknown>;
}

export async function detail(id: string) {
  const r = await run(pool, DETAIL_SQL, [id]);
  if (!r.d || r.d.status === "not_found") {
    throw new ApiError("NOT_FOUND", `No approval ${id}.`, 404);
  }
  return r.d as Record<string, unknown>;
}
