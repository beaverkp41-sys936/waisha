import { pool } from "../db/pool.js";
import { sendSms } from "../mail/mail.js";
import { ExpiryDeliveryReceipt, ExpiryNotice, sendExpiryNotice } from "../mail/expiry-notice.js";

/**
 * The paper clock (144).
 *
 * The rule lives in the database. `expiry_reminder_candidates` decides what is owed a warning,
 * `record_expiry_reminder` writes the ledger row and the sentence it carries, and
 * `expiry_reminder_receipt` is the only way a receipt gets onto that row. This module reads the list
 * and walks it. It has no date arithmetic, no rung ladder and no message text of its own, and that
 * is the design: the sweep and a person pressing "warn now" go through the same definer, so the
 * register row, the audit row and the words sent are identical whoever pulled the lever. The only
 * difference is `actor_kind`.
 *
 * Running it twice is safe, and running it from two replicas is safe. The rung ladder counts a rung
 * as warned once its notice has landed, and the write re-checks the ladder inside a row lock, so a
 * second pass finds nothing owed and answers `already_warned`; the unique index on
 * `(subject, kind, document, rung, date)` is the backstop if two passes race the lock. Nothing here
 * counts as sent what the other pass already sent.
 *
 * A warning is not an act against a company — it does not stop it trading — so it needs no second
 * signature (121 guards the hand that does). That is also why the clock can raise one on its own.
 *
 * A failed send never unwinds the row. The ledger keeps the warning with an empty receipt, the board
 * files it under `waiting`, and the rung stays pressable. That is the whole reason "warned" means
 * *landed* rather than *inserted*: while the mail domain is unverified, a ledger that treated a
 * rejected send as evidence would refuse to try again and would read as though the company had been
 * told when it had not.
 */

/** The widest rung, and the default number of papers one pass will work through. */
export const FIRST_RUNG = 30;
export const SWEEP_LIMIT = 50;

/** Params: page size. */
export const EXPIRY_CANDIDATES_SQL =
  "select platform_auth.expiry_reminder_candidates($1) as c";
/** Params: subject kind, subject id, document kind, rung, expiry date, actor kind, user, role, ip. */
export const EXPIRY_REMIND_SQL =
  "select platform_auth.record_expiry_reminder($1,$2,$3,$4,$5,$6,$7,$8,$9) as r";
/** Params: reminder id, receipt jsonb. */
export const EXPIRY_RECEIPT_SQL =
  "select platform_auth.expiry_reminder_receipt($1, $2::jsonb) as r";
/** Params: state, subject kind, page size, offset. */
export const EXPIRY_LEDGER_SQL =
  "select platform_auth.expiry_reminder_board($1,$2,$3,$4) as b";

export interface ExpiryCandidate {
  tenant_id: string;
  tenant_name: string;
  subject_kind: string;
  subject_id: string;
  subject_name: string;
  document_kind: string;
  threshold_days: number;
  expiry_date: string;
  days_left: number;
}

export interface RaiseInput {
  subjectKind: string;
  subjectId: string;
  documentKind: string;
  thresholdDays: number;
  /** The date the caller is warning about. Null means "whatever the paper carries now". */
  expiryDate?: string | null;
  actorKind: "system" | "control";
  actorUserId?: string | null;
  actorRole?: string | null;
  actorIp?: string | null;
}

export interface RaiseOutcome {
  /** The definer's own answer, refusals included, with `targets` taken out of it. */
  result: Record<string, unknown> | null;
  receipt: ExpiryDeliveryReceipt | null;
}

export interface ExpirySweepOutcome {
  as_of: string;
  due: number;
  raised: number;
  delivered: number;
  skipped: number;
  errors: string[];
}

/**
 * One paper, one rung, one notice.
 *
 * The refusal path returns the definer's answer untouched so the caller can map it; only an `ok`
 * row is sent, and the receipt goes straight back onto the ledger. `targets` is stripped from what
 * the caller gets: it carries a director's email and an encrypted phone, and a desk has no use for
 * either — the masked `to` list in the receipt is what the office reads.
 */
export async function raiseExpiryReminder(input: RaiseInput): Promise<RaiseOutcome> {
  const { rows } = await pool.query(EXPIRY_REMIND_SQL, [
    input.subjectKind, input.subjectId, input.documentKind, input.thresholdDays,
    input.expiryDate ?? null, input.actorKind, input.actorUserId ?? null,
    input.actorRole ?? null, input.actorIp ?? null
  ]);
  const r = (rows[0]?.r ?? null) as Record<string, unknown> | null;
  if (!r || r.status !== "ok") return { result: r, receipt: null };

  const notice = r as unknown as ExpiryNotice;
  const { targets, ...answer } = r;
  let receipt: ExpiryDeliveryReceipt;
  try {
    receipt = await sendExpiryNotice(notice, sendSms);
  } catch (e) {
    // The row is already committed, so this is a notice the register says was raised and never
    // answered for. Leaving the receipt empty is the honest state — the board shows `waiting` and
    // the rung stays pressable — and the sweep carries on with the next paper.
    return { result: answer, receipt: null };
  }
  await pool.query(EXPIRY_RECEIPT_SQL, [notice.reminder_id, JSON.stringify(receipt)]);
  return { result: answer, receipt };
}

/**
 * One pass over what is owed a warning today. Never throws on a single paper: one row the send
 * cannot handle must not stop the rest of the register from being written.
 */
export async function runExpiryReminders(limit: number = SWEEP_LIMIT): Promise<ExpirySweepOutcome> {
  const out: ExpirySweepOutcome = {
    as_of: "", due: 0, raised: 0, delivered: 0, skipped: 0, errors: []
  };
  const size = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : SWEEP_LIMIT;
  const { rows } = await pool.query(EXPIRY_CANDIDATES_SQL, [size]);
  const board = rows[0]?.c as { due: number; as_of: string; rows: ExpiryCandidate[] } | undefined;
  out.as_of = board?.as_of ?? "";
  out.due = board?.due ?? 0;

  for (const c of board?.rows ?? []) {
    try {
      const raised = await raiseExpiryReminder({
        subjectKind: c.subject_kind, subjectId: c.subject_id, documentKind: c.document_kind,
        // The rung is taken from the list rather than recomputed here, so the sweep sends the rung
        // the ladder picked; if the register moved in between, the definer answers `due_rung` and
        // this pass stands down rather than warning out of order.
        thresholdDays: c.threshold_days, expiryDate: c.expiry_date,
        actorKind: "system", actorRole: "system"
      });
      const r = raised.result;
      if (!r || r.status !== "ok") {
        out.skipped++;
        continue;
      }
      out.raised++;
      const rec = raised.receipt;
      if (rec && rec.sms.sent + rec.email.sent > 0) out.delivered++;
      for (const e of rec?.errors ?? []) {
        out.errors.push(`${c.tenant_name} ${c.subject_name} ${c.document_kind}: ${e}`.slice(0, 200));
      }
    } catch (e) {
      out.errors.push(`${c.tenant_name} ${c.subject_name} ${c.document_kind}: ${String(e).slice(0, 160)}`);
    }
  }

  return out;
}

const TICK_MS = 6 * 60 * 60_000;

/**
 * Start the in-process paper clock. A rung is a day-scale thing, so six hours is often enough to
 * catch a date at the first tick of a day and rarely enough to be no cost at all. unref'd so it
 * never holds the process open.
 */
export function startExpiryReminderLoop(
  log: { info: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void }
): void {
  const tick = async () => {
    try {
      const out = await runExpiryReminders();
      // Silent while every paper is current, which is most days: nothing is owed and nothing was
      // sent. A pass that worked is a pass the office needs to see in the log.
      if (out.raised || out.skipped || out.errors.length) log.info(out, "expiry reminder sweep fired");
    } catch (e) {
      log.warn({ err: String(e) }, "expiry reminder sweep failed");
    }
  };
  const t = setInterval(tick, TICK_MS);
  t.unref();
  void tick();
}
