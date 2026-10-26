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
const DIRECTORY_EXCLUSION = "control.directory.exclusion";
// 134's two signatures are raised against a paper that already carries the figures, so the seat that
// raises one is the seat that may put money somewhere or take it out.
const MONEY_PAY = "control.money.pay";
const MONEY_ESCROW = "control.money.escrow";
// 140's paper is raised by the door that reads the card's own figures, and the duty that signs a price
// into force is the only one asked to raise it.
const PRICING_PUBLISH = "control.pricing.publish";

/**
 * What can be signed, and what signing it does.
 *
 * A kind with no apply path here would be a signature that can never be spent, so the
 * registry is deliberately exhaustive: every entry names the effect its released signature
 * buys. Eight effects exist today because the platform has eight kinds of thing the rule
 * covers — a company's access, money going back out, a person's data leaving the
 * registers, a company held off the trading board, money leaving the office, money
 * leaving escrow, a price going live and a charge going live — and a ninth joins by naming
 * its own definer rather than by restating the transaction below.
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
  effect: "tenant_action" | "refund_release" | "data_erasure" | "directory_exclusion"
    | "payout_release" | "escrow_discharge" | "price_publish" | "addendum_publish";
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
  },
  // Raised from the Directory desk against one exclusion paper (131). The paper already carries
  // the subject, the reason and the window, and `propose_directory_exclusion` reads all three
  // out of the row and hashes them — so the second seat signs a dated hold on a named company,
  // never a sentence typed into a body beside a fresh id. A company is held off the board by at
  // most one live paper, so this signature is the only hand that can move the card.
  "directory.exclusion": {
    action: "directory.exclusion", label: "Hold a company, vehicle or driver off the board",
    proposeDuty: DIRECTORY_EXCLUSION, effect: "directory_exclusion", proposable: false
  },
  // Raised by 134's own payout doors — `propose_money_payout` and `propose_money_payout_batch` read
  // the payee, the rail, the figure, the fee and the payee line's keyed hash out of the paper and
  // hash what they read, so the second seat signs an instruction rather than a sentence typed beside
  // a fresh id. Spending it accrues the obligation; the cash is confirmed afterwards by its own door.
  "money.payout": {
    action: "money.payout", label: "Release a payout to a company, driver or staff member",
    proposeDuty: MONEY_PAY, effect: "payout_release", proposable: false
  },
  // Raised by `propose_escrow_discharge` against one hold. The plan is the signature: what the payee
  // takes, what goes back to the payer and what the office keeps have to add up to the money held
  // before a paper exists, so the desk is never asked to sign a plan that cannot be paid.
  "money.escrow": {
    action: "money.escrow", label: "Discharge a hold out of escrow",
    proposeDuty: MONEY_ESCROW, effect: "escrow_discharge", proposable: false
  },
  // Raised by 140's own publish door against one rate card. `propose_pricing_publish` reads the code,
  // the money, the window and every figure off the card's rows and hashes what it read, so the second
  // seat signs a price list rather than a sentence typed beside a fresh id. Spending it puts the card
  // in force and closes the version it supersedes; the withdrawal that stops a wrong price is
  // deliberately one-seat, and lives behind `withdraw_pricing_card` instead of here.
  "pricing.publish": {
    action: "pricing.publish", label: "Put a freight price list in force",
    proposeDuty: PRICING_PUBLISH, effect: "price_publish", proposable: false
  },
  // Raised by 141's `propose_pricing_addendum` against one surcharge or discount code. It is a second
  // action and not the same action on a second target because 121 keeps one open paper per
  // (action, target kind, target id) — a levy and the price list it stands on cannot share a slot.
  // The paper carries its own figure, its ceiling and its dates, so the second seat signs a number read
  // off the row; the duty is 140's `.publish`, because a seat that may not sign a rate has no business
  // signing a discount.
  "pricing.addendum": {
    action: "pricing.addendum", label: "Put a surcharge or discount code in force",
    proposeDuty: PRICING_PUBLISH, effect: "addendum_publish", proposable: false
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
 * The statements the register answers on, exported so 121's verify script runs the
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
/** Params: approval, actor, role, ip. 131's hold, which replays the window off the payload. */
export const EXCLUSION_APPLY_SQL =
  "select platform_auth.apply_directory_exclusion($1,$2,$3,$4) as r";
/** Params: approval, actor, role, ip. 134's accrual — one line, or every line under a batch. */
export const PAYOUT_APPLY_SQL =
  "select platform_auth.apply_payout_release($1,$2,$3,$4) as r";
/** Params: approval, actor, role, ip. 134's discharge, which replays the three figures off the payload. */
export const ESCROW_APPLY_SQL =
  "select platform_auth.apply_escrow_discharge($1,$2,$3,$4) as r";
/** Params: approval, actor, role, ip. 140's publish, which re-hashes the card before it goes live. */
export const PUBLISH_APPLY_SQL =
  "select platform_auth.apply_pricing_publish($1,$2,$3,$4) as r";
/** Params: approval, actor, role, ip. 141's publish of a charge, which re-hashes the addendum paper. */
export const ADDENDUM_APPLY_SQL =
  "select platform_auth.apply_pricing_addendum($1,$2,$3,$4) as r";
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
 * The effects share the order and nothing else after it. A refund paper, an erasure, an exclusion,
 * 134's two money effects, 140's price publish and 141's charge publish are each finished inside the
 * transaction — the row itself is the receipt, and there is no caller to email about a signature — so
 * the notice, its cached gate clearing and its delivery receipt all stay on the ban branch, where 078
 * put them for the reason that still holds: a mail provider that is down must never leave a company
 * two people agreed to shut still trading.
 */
type Spent =
  | { kind: ApprovalKind; tenant: AppliedAction; refund?: undefined; erasure?: undefined;
      exclusion?: undefined; payout?: undefined; escrow?: undefined; publish?: undefined;
      addendum?: undefined }
  | { kind: ApprovalKind; tenant?: undefined; refund: Record<string, unknown>; erasure?: undefined;
      exclusion?: undefined; payout?: undefined; escrow?: undefined; publish?: undefined;
      addendum?: undefined }
  | { kind: ApprovalKind; tenant?: undefined; refund?: undefined;
      erasure: Record<string, unknown>; exclusion?: undefined; payout?: undefined;
      escrow?: undefined; publish?: undefined; addendum?: undefined }
  | { kind: ApprovalKind; tenant?: undefined; refund?: undefined; erasure?: undefined;
      exclusion: Record<string, unknown>; payout?: undefined; escrow?: undefined
      publish?: undefined; addendum?: undefined }
  | { kind: ApprovalKind; tenant?: undefined; refund?: undefined; erasure?: undefined;
      exclusion?: undefined; payout: Record<string, any>; escrow?: undefined; publish?: undefined;
      addendum?: undefined }
  | { kind: ApprovalKind; tenant?: undefined; refund?: undefined; erasure?: undefined;
      exclusion?: undefined; payout?: undefined; escrow: Record<string, any>; publish?: undefined;
      addendum?: undefined }
  | { kind: ApprovalKind; tenant?: undefined; refund?: undefined; erasure?: undefined;
      exclusion?: undefined; payout?: undefined; escrow?: undefined; publish: Record<string, any>;
      addendum?: undefined }
  | { kind: ApprovalKind; tenant?: undefined; refund?: undefined; erasure?: undefined;
      exclusion?: undefined; payout?: undefined; escrow?: undefined; publish?: undefined;
      addendum: Record<string, any> };

/**
 * 134's and 140's apply doors answer in their own shape — `ok:false` plus an `error` word and a
 * sentence — rather than in the `status` words 121's deciders use. Both refusals mean the paper moved
 * under the signature, so the claim is rolled back with them and the desk hears why.
 */
function moneyRefusal(eff: any, nothing: string): ApiError {
  if (eff?.error === "not_found") {
    return new ApiError("NOT_FOUND",
      eff?.message ?? `There is no paper behind this signature. ${nothing}.`, 404);
  }
  return new ApiError("CONFLICT",
    eff?.message ?? `The paper changed under this signature. ${nothing}.`, 409);
}

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

      if (kind.effect === "directory_exclusion") {
        const res = await run(c, EXCLUSION_APPLY_SQL, [id, a.id, a.role, a.ip]);
        const eff = res.r as (Record<string, any> | undefined);
        if (!eff) throw new ApiError("UPSTREAM_ERROR", "The hold could not be recorded.", 502);
        // The definer replays the window off the approval's own payload and refuses the paper if
        // it no longer matches, so a hold that started under a signature is provably the hold the
        // second seat read. Any "no" here rolls the claim back with it: an unspent signature must
        // not be recorded as one that suspended a card.
        if (eff.status !== "ok") {
          throw new ApiError(eff.status === "not_found" ? "NOT_FOUND" : "CONFLICT",
            eff.message ?? "The paper changed under this signature. Nothing was held.",
            eff.status === "not_found" ? 404 : 409);
        }
        await run(c, SETTLE_SQL, [id, JSON.stringify({
          exclusion_id: eff.exclusion_id, ref: eff.ref, subject_kind: eff.subject_kind,
          subject_name: eff.subject_name, company_name: eff.company_name,
          company_tenant_id: eff.company_tenant_id, listing_id: eff.listing_id,
          days: eff.days, starts_at: eff.starts_at, ends_at: eff.ends_at,
          exclusion_status: eff.exclusion_status, activated_by: eff.activated_by
        })]);
        return { kind, exclusion: eff };
      }

      if (kind.effect === "payout_release") {
        const res = await run(c, PAYOUT_APPLY_SQL, [id, a.id, a.role, a.ip]);
        const eff = res.r as (Record<string, any> | undefined);
        if (!eff) throw new ApiError("UPSTREAM_ERROR", "The payout could not be recorded.", 502);
        // The door re-reads the payee, the rail, the figure, the fee and the payee line's hash against
        // the payload this signature was cut on, so an accrual that lands is provably the instruction
        // the second seat read. A batch is one call: the batch is stamped released before its lines,
        // because each line's own guard asks the batch what state its signature is in.
        if (eff.ok !== true) throw moneyRefusal(eff, "Nothing was accrued");
        await run(c, SETTLE_SQL, [id, JSON.stringify({
          target_kind: eff.target_kind, ref: eff.ref,
          payout_id: eff.payout_id ?? null, batch_id: eff.batch_id ?? null,
          payee: eff.payee ?? null, amount: eff.amount ?? eff.total_amount ?? null,
          fee_amount: eff.fee_amount ?? null, currency: eff.currency,
          lines: eff.lines ?? null, accrued: eff.accrued ?? null,
          posting: eff.posting?.ref ?? null, released_by: eff.released_by
        })]);
        return { kind, payout: eff };
      }

      if (kind.effect === "escrow_discharge") {
        const res = await run(c, ESCROW_APPLY_SQL, [id, a.id, a.role, a.ip]);
        const eff = res.r as (Record<string, any> | undefined);
        if (!eff) throw new ApiError("UPSTREAM_ERROR", "The discharge could not be recorded.", 502);
        // Money only leaves escrow on the plan that was signed: the payee's wallet is re-read (a desk
        // can stop a wallet inside the seven days) and the three figures are compared against the
        // payload before a leg is cut. Any "no" rolls the claim back with it.
        if (eff.ok !== true) throw moneyRefusal(eff, "Nothing left escrow");
        await run(c, SETTLE_SQL, [id, JSON.stringify({
          hold_id: eff.hold_id, ref: eff.ref, subject_kind: eff.subject_kind,
          subject_ref: eff.subject_ref, amount: eff.amount, currency: eff.currency,
          discharge_kind: eff.discharge_kind, to_payee: eff.to_payee,
          back_to_payer: eff.back_to_payer, fee_amount: eff.fee_amount,
          payee_wallet_id: eff.payee_wallet_id ?? null,
          posting: eff.posting?.ref ?? null, discharged_by: eff.discharged_by
        })]);
        return { kind, escrow: eff };
      }

      if (kind.effect === "price_publish") {
        const res = await run(c, PUBLISH_APPLY_SQL, [id, a.id, a.role, a.ip]);
        const eff = res.r as (Record<string, any> | undefined);
        if (!eff) throw new ApiError("UPSTREAM_ERROR", "The price could not be published.", 502);
        // The door rebuilds the card's paper and compares it to the hash this signature was cut on, so
        // a price that goes live is provably the set of figures the second seat read. It also closes
        // the version it supersedes in the same statement, because two prices in force for one code is
        // the answer no resolver on this panel should have to give. Any "no" rolls the claim back.
        if (eff.ok !== true) throw moneyRefusal(eff, "Nothing was published");
        await run(c, SETTLE_SQL, [id, JSON.stringify({
          card_id: eff.card_id, ref: eff.ref, code: eff.code, version: eff.version,
          currency: eff.currency, effective_from: eff.effective_from,
          superseded_versions: eff.superseded_versions, published_by: eff.published_by
        })]);
        // `card` is the whole detail — every line, the version ladder and the memory rows. The desk
        // that signed asks for it by itself a moment later; the register receipt keeps the figures
        // the signature bought.
        const { card: _detail, ...receipt } = eff;
        return { kind, publish: receipt };
      }

      if (kind.effect === "addendum_publish") {
        const res = await run(c, ADDENDUM_APPLY_SQL, [id, a.id, a.role, a.ip]);
        const eff = res.r as (Record<string, any> | undefined);
        if (!eff) throw new ApiError("UPSTREAM_ERROR", "The charge could not be published.", 502);
        // The door rebuilds the charge's paper and compares it to the hash this signature was cut on, so
        // a levy or a discount that goes live is provably the figure and the window the second seat read.
        // It refuses a code whose places ran out while its paper waited, because a signature spent on a
        // discount nobody can be given is a signature that changed nothing. Any "no" rolls the claim back.
        if (eff.ok !== true) throw moneyRefusal(eff, "Nothing was published");
        await run(c, SETTLE_SQL, [id, JSON.stringify({
          addendum_id: eff.addendum_id, ref: eff.ref, code: eff.code, kind: eff.kind,
          version: eff.version, basis: eff.basis, value: eff.value, currency: eff.currency,
          max_uses: eff.max_uses, uses_taken: eff.uses_taken,
          effective_from: eff.effective_from, superseded_versions: eff.superseded_versions,
          published_by: eff.published_by
        })]);
        // `addendum` is the whole detail — the scope it stands on, the version ladder and the memory
        // rows. The desk that signed asks for it by itself a moment later; the register receipt keeps
        // the figure the signature bought.
        const { addendum: _detail, ...receipt } = eff;
        return { kind, addendum: receipt };
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
  // A held card is its own announcement: the company's listing editor reads back
  // `status = 'suspended'` with the paper's note as the reason, and the seeker simply stops
  // being shown it. There is no director email for a signature on a trading board, so the
  // register row is the answer here too.
  if (spent.kind.effect === "directory_exclusion") {
    return { ...spent.exclusion, approval_id: id };
  }
  // A payout that has been accrued is not a payout that has been paid: the desk confirms the cash
  // separately through 134's own door, and the register row already carries the posting ref, the
  // payee and the figure the second seat signed. There is no email to a payee about a signature.
  if (spent.kind.effect === "payout_release") {
    return { ...spent.payout, approval_id: id };
  }
  if (spent.kind.effect === "escrow_discharge") {
    return { ...spent.escrow, approval_id: id };
  }
  // A price that went live is its own announcement: the board reads the card back as `published`, the
  // version it replaced carries the day it closed, and 140's memory rows already name the seat that
  // signed. There is no director to email about a tariff, so the register row is the answer here too.
  if (spent.kind.effect === "price_publish") {
    return { ...spent.publish, approval_id: id };
  }
  // A charge that went live is a line on a quote, not a letter to a director: the register desk reads
  // the addendum back as `published`, the version it replaced carries the day it closed, and 141's own
  // memory rows name the seat that signed. So the register row is the answer here too.
  if (spent.kind.effect === "addendum_publish") {
    return { ...spent.addendum, approval_id: id };
  }

  const applied = spent.tenant!;
  forgetSuspensions();
  const receipt = await sendTenantNotice(applied, sendSms);
  await pool.query(RECEIPT_SQL, [applied.action_id, JSON.stringify(receipt)]);
  return { ...stripTargets(applied as unknown as Record<string, unknown>),
    delivery: receipt, approval_id: id };
}

const STATUSES = ["pending", "approved", "applied", "rejected", "lapsed"] as const;

/**
 * A payout paper's payload carries the keyed hash of the payee's account number, because 134's
 * apply door re-reads the line and compares it to prove the signature still describes the money.
 * That hash is only safe as long as nobody can test a candidate number against it, and this board
 * is read by a duty that has no right to the number at all: `control.approvals.view` is granted to
 * seats that cannot spend the audited, twelve-an-hour reveal. So the board would be the one door
 * that hands out a linkability token for free. The payout detail route already drops the key; a
 * proposal copy of the same paper has to drop it too.
 *
 * The row is a copy and the register keeps its bytes — the signature's own sha256 was cut over the
 * payload including the hash, and nothing here is allowed to change what was signed.
 */
function withoutPayeeHash<T>(row: T): T {
  const r = row as Record<string, any>;
  const p = r?.payload;
  if (!p || typeof p !== "object" || !("payee_ref_hash" in p)) return row;
  const { payee_ref_hash: _dropped, ...payload } = p;
  return { ...r, payload } as T;
}

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
  const b = (r.b ?? { rows: [], counts: {} }) as Record<string, any>;
  return { ...b, rows: (b.rows ?? []).map(withoutPayeeHash) };
}

export async function detail(id: string) {
  const r = await run(pool, DETAIL_SQL, [id]);
  if (!r.d || r.d.status === "not_found") {
    throw new ApiError("NOT_FOUND", `No approval ${id}.`, 404);
  }
  return withoutPayeeHash(r.d as Record<string, unknown>);
}
