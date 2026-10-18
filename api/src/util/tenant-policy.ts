import { pool } from "../db/pool.js";
import { sendSms } from "../mail/mail.js";
import { forgetSuspensions } from "../security/tenant-state.js";
import type { AppliedAction, TenantAction } from "../mail/tenant-notice.js";
import { sendTenantNotice } from "../mail/tenant-notice.js";

/**
 * The idle clock, enforced.
 *
 * The office's rule, as given: a company that has gone a month and a half without a paid
 * licence is blocked, and at three months its account is closed. 078 put both halves of
 * that into the database — `tenant_policy_candidates` decides who qualifies and
 * `tenant_apply_action` performs the act — so this module only reads the list and walks
 * it. It deliberately has no `update tenants` of its own: the sweep and a human on the
 * control desk go through the same definer, which means the register row, the audit row,
 * the session revoke and the notice list are identical whoever pulled the lever. The only
 * difference is `actor_kind`, and that is the point — the desk can always tell the timer
 * from a person.
 *
 * Running it twice is safe. `tenant_apply_action` takes a row lock and re-reads the state
 * inside it, so a second pass finds the company already suspended and answers `conflict`,
 * or already tombstoned and answers `not_found`; both are counted as skipped, neither
 * writes. That is what makes two API replicas on Render safe without a lock table.
 *
 * The notice is sent after the act, never before. A company is told it was blocked, in
 * the same message that says why — but it is told after the door is shut, because a
 * warning that arrives first is a chance to be ignored. The delivery receipt goes back
 * onto the register row, so "we told you" is provable later.
 */

export const BLOCK_AFTER_DAYS = 45;
export const CLOSE_AFTER_DAYS = 90;

/** Params: block window, close window. */
export const CANDIDATES_SQL = "select platform_auth.tenant_policy_candidates($1, $2) as c";
/** Params: tenant, action, reason, note, actor kind, actor user, actor role, ip. */
export const APPLY_SQL =
  "select platform_auth.tenant_apply_action($1,$2,$3,$4,$5,$6,$7,$8) as r";
/** Params: action id, receipt jsonb. */
export const RECEIPT_SQL = "select platform_auth.tenant_action_receipt($1, $2::jsonb) as r";

interface Candidate {
  tenant_id: string;
  name: string;
  action: TenantAction;
  days_idle: number;
  lapsed_at: string | null;
}

export interface PolicyOutcome {
  blocked: number;
  closed: number;
  notices_sent: number;
  skipped: number;
  errors: string[];
}

/**
 * The sentence the company receives. It is written by the timer, so it says what the
 * timer knows: how long the licence has been down, and the one thing that ends it.
 */
export function idleNote(action: TenantAction, daysIdle: number): string {
  return action === "close"
    ? `No paid licence has been recorded for this company for ${daysIdle} days, past the ` +
      `three-month window WAISHA allows a lapsed account to stay open. The account is now ` +
      `closed and its seats cannot sign in. Records are retained for the statutory period ` +
      `- write to support@tengoaegis.com for anything you need from them.`
    : `No paid licence has been recorded for this company for ${daysIdle} days, past the ` +
      `six-week grace WAISHA allows. Access is suspended until the licence is renewed or ` +
      `the office records an override. Renew from the licence screen, or write to ` +
      `support@tengoaegis.com if the payment has already been made.`;
}

async function applyIdleAction(tenantId: string, action: TenantAction, note: string) {
  const { rows } = await pool.query(APPLY_SQL, [
    // reason_code long_idle is the timer's own: a person blocking for the same lapse
    // picks the reason themselves, and the register keeps those apart.
    tenantId, action, "long_idle", note, "system", null, "system", null
  ]);
  return (rows[0]?.r as (AppliedAction & { status: string }) | null) ?? null;
}

/**
 * One pass over the idle list. Returns what it did; never throws on a single company,
 * because one bad row must not stop the rest of the register from being written.
 */
export async function runTenantPolicy(
  blockAfterDays: number = BLOCK_AFTER_DAYS,
  closeAfterDays: number = CLOSE_AFTER_DAYS
): Promise<PolicyOutcome> {
  const out: PolicyOutcome = {
    blocked: 0, closed: 0, notices_sent: 0, skipped: 0, errors: []
  };
  // A window pair the wrong way round would close companies before it ever warned them.
  // The sweep is called with an operator-supplied pair by the internal tick, so the
  // shape is checked rather than assumed.
  if (!(blockAfterDays > 0) || !(closeAfterDays > blockAfterDays)) {
    out.errors.push(`invalid windows: block=${blockAfterDays} close=${closeAfterDays}`);
    return out;
  }

  const { rows } = await pool.query(CANDIDATES_SQL, [blockAfterDays, closeAfterDays]);
  const candidates: Candidate[] = (rows[0]?.c as Candidate[]) ?? [];

  for (const c of candidates) {
    try {
      const applied = await applyIdleAction(c.tenant_id, c.action, idleNote(c.action, c.days_idle));
      if (!applied || applied.status !== "ok") {
        // conflict / not_found: a person on the desk already acted, or another replica
        // won the row lock. The register is the authority, so this pass stands down.
        out.skipped++;
        continue;
      }
      // The sweep just took a company out of service (or restored one); this process must
      // stop serving it on the next request rather than on the next TTL boundary.
      forgetSuspensions();
      const receipt = await sendTenantNotice(applied, sendSms);
      await pool.query(RECEIPT_SQL, [applied.action_id, JSON.stringify(receipt)]);
      if (c.action === "close") out.closed++; else out.blocked++;
      if (receipt.sms.sent + receipt.email.sent > 0) out.notices_sent++;
      for (const e of receipt.errors) out.errors.push(`${c.name}: ${e}`);
    } catch (e) {
      // The act is already committed by its own statement, so a failure here is a
      // failure to notify — recorded, and the next pass will not retry it because the
      // company is no longer a candidate. The desk sees the empty receipt and resends.
      out.errors.push(`${c.name} ${c.action}: ${String(e).slice(0, 160)}`);
    }
  }

  return out;
}

const TICK_MS = 15 * 60_000;

/** Start the in-process clock. unref'd so it never holds the process open. */
export function startTenantPolicyLoop(
  log: { info: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void }
): void {
  const tick = async () => {
    try {
      const out = await runTenantPolicy();
      // Silent while every company is current, which is the normal state; a pass that
      // did something is a pass somebody in the office needs to see in the log.
      if (out.blocked || out.closed || out.skipped || out.errors.length) log.info(out, "tenant policy sweep fired");
    } catch (e) {
      log.warn({ err: String(e) }, "tenant policy sweep failed");
    }
  };
  const t = setInterval(tick, TICK_MS);
  t.unref();
  void tick();
}
