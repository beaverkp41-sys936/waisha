import { sendMail, DeliveryContext, SendReceipt } from "./mail.js";
import { maskEmail, maskPhone, phoneOf } from "./tenant-notice.js";
import type { NoticeTarget } from "./tenant-notice.js";

/**
 * What a company is told about a paper that is about to run out (144).
 *
 * The words are not written here. `record_expiry_reminder` composes the notice and stores it in the
 * ledger before this function is reached, and the sentence sent is the sentence the register kept —
 * so a desk press and the clock cannot tell a company two different things about one date, and no
 * caller can put words into the office's mouth by passing them in.
 *
 * Both channels are attempted for every target, as 078's notice does, because a company that hears
 * from WAISHA on either of them was told. What happened on each is written back onto the ledger row
 * as its receipt, and the register's own rule (`expiry_notice_landed`) decides from that receipt
 * whether the rung counts as warned. A send that failed therefore does not close the rung: the next
 * pass is allowed to try again, which is the only honest behaviour while the mail domain is still
 * unverified.
 *
 * The per-attempt trail is not duplicated here. Every message, including a rejection, already gets a
 * line in `message_deliveries` under purpose `expiry_reminder`; the ledger keeps the one summary that
 * decides a rule.
 *
 * Contact details never enter the receipt. Masks only, in the same shapes 078's notice uses, so the
 * two registers of what was sent read alike on the same desk.
 */

const SUPPORT_EMAIL = "support@tengoaegis.com";
const SUPPORT_PHONE = "+255 717 601 440";

/** The ledger row as `record_expiry_reminder` hands it back, with the notice it wrote. */
export interface ExpiryNotice {
  reminder_id: string;
  tenant_id: string;
  tenant_name: string;
  subject_kind: string;
  subject_name: string;
  document_kind: string;
  threshold_days: number;
  expiry_date: string;
  days_left: number;
  notice: string;
  targets: NoticeTarget[];
}

export interface ExpiryDeliveryReceipt {
  notice: string;
  recipients: number;
  sms: { sent: number; failed: number };
  email: { sent: number; failed: number };
  to: { sms?: string; email?: string }[];
  errors: string[];
  sent_at: string;
}

const esc = (v: unknown) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function expirySubject(n: ExpiryNotice): string {
  return `WAISHA ${n.threshold_days}-day warning — ${n.tenant_name}`;
}

/** The SMS stays short enough to be read in a notification, and is the register's sentence, not a
 *  summary of it: a shortened second message is a second thing to be wrong. */
export function expirySmsText(n: ExpiryNotice): string {
  const raw = `${n.notice} WAISHA office ${SUPPORT_PHONE}`;
  return raw.length > 300 ? `${raw.slice(0, 297)}…` : raw;
}

function bodyText(n: ExpiryNotice): string {
  return [
    expirySubject(n),
    n.notice,
    `If the paper has already been renewed, record its new expiry date in WAISHA so the warning stops.`,
    `Reply to ${SUPPORT_EMAIL} or call ${SUPPORT_PHONE} to talk to the office.`
  ].join("\n\n");
}

function bodyHtml(n: ExpiryNotice): string {
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:18px;margin:0 0 16px">${esc(expirySubject(n))}</h1>
<p style="font-size:15px;margin:0 0 12px">${esc(n.notice)}</p>
<p style="font-size:14px;margin:0 0 12px">If the paper has already been renewed, record its new expiry date in WAISHA so the warning stops.</p>
<p style="font-size:13px;color:#5a6b7a">Reply to ${SUPPORT_EMAIL} or call ${esc(SUPPORT_PHONE)} to talk to the office.</p>
</div>`;
}

/**
 * Sends on both channels and returns the receipt for the ledger. Never throws: every failure is a
 * line in the receipt the desk can read, and a notice that did not arrive must still leave a row
 * that says so.
 */
export async function sendExpiryNotice(n: ExpiryNotice,
  sendSmsImpl: (e164: string, message: string, ctx?: DeliveryContext) => Promise<SendReceipt>):
  Promise<ExpiryDeliveryReceipt> {
  const message = expirySmsText(n);
  const mail = { subject: expirySubject(n), text: bodyText(n), html: bodyHtml(n) };
  const receipt: Omit<ExpiryDeliveryReceipt, "sent_at"> = {
    notice: n.notice, recipients: (n.targets ?? []).length,
    sms: { sent: 0, failed: 0 }, email: { sent: 0, failed: 0 }, to: [], errors: []
  };
  const ctx = { purpose: "expiry_reminder" as const, tenantId: n.tenant_id };

  for (const t of n.targets ?? []) {
    const entry: { sms?: string; email?: string } = {};
    const phone = phoneOf(t);
    if (phone) {
      entry.sms = maskPhone(phone);
      const r = await sendSmsImpl(phone, message, ctx);
      if (r.delivered) receipt.sms.sent++;
      else {
        receipt.sms.failed++;
        if (r.error) receipt.errors.push(`sms ${r.error.slice(0, 120)}`);
      }
    } else {
      receipt.sms.failed++;
    }
    if (t.email) {
      entry.email = maskEmail(t.email);
      const r = await sendMail({ ...mail, to: t.email }, ctx);
      if (r.delivered) receipt.email.sent++;
      else {
        receipt.email.failed++;
        if (r.error) receipt.errors.push(`email ${r.error.slice(0, 120)}`);
      }
    } else {
      receipt.email.failed++;
    }
    receipt.to.push(entry);
  }

  return { ...receipt, sent_at: new Date().toISOString() };
}
