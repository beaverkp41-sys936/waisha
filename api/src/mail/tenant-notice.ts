import { decryptField } from "../util/crypto.js";
import { sendMail } from "./mail.js";

/**
 * What a company is told when the office acts on it.
 *
 * The register (078) records the decision; this is the part the decision has to be
 * legitimate: the company gets the action and the reason, on the way it already hears
 * from WAISHA — SMS to its directors and email alongside it. Both channels are attempted
 * for every action, and what happened on each is written back to the register as the
 * receipt, because "we told you" has to be provable later.
 *
 * A failed send never unwinds the action: a company that must be blocked stays blocked
 * when the mail provider is down, and the desk can see the notice did not go out and
 * send it again.
 *
 * The receipt is masked. Contact details are not stored in it — counts and enough of each
 * address to recognise which seat was reached.
 */

const SUPPORT_EMAIL = "support@tengoaegis.com";
const SUPPORT_PHONE = "+255 717 601 440";

export type TenantAction = "block" | "unblock" | "close" | "notice";

export interface NoticeTarget {
  name?: string | null;
  email?: string | null;
  /** AES-GCM blob as hex, straight from users.phone_encrypted. */
  phone?: string | null;
}

export interface AppliedAction {
  action_id: string;
  action: TenantAction;
  tenant_id: string;
  tenant_name: string;
  prior_status: string;
  /** 'ok' — the definer's own flag. The company's state is `new_status`, never this. */
  status: string;
  new_status: string;
  seats_licensed: number | null;
  sessions_revoked?: number;
  reason_code: string;
  note: string;
  targets: NoticeTarget[];
}

const REASONS: Record<string, string> = {
  terms_violation: "a breach of the WAISHA terms",
  long_idle: "no paid licence for an extended period",
  payment_default: "an unpaid subscription",
  abuse: "misuse of the platform",
  complaint: "a complaint against this company",
  security: "a security concern",
  other: "a decision by the WAISHA office"
};

/** What the person reads first, on every channel. */
function headline(a: AppliedAction): string {
  const why = REASONS[a.reason_code] ?? a.reason_code;
  switch (a.action) {
    case "block": return `${a.tenant_name}: WAISHA access is suspended — ${why}.`;
    case "unblock": return `${a.tenant_name}: WAISHA access is restored.`;
    case "close": return `${a.tenant_name}: the WAISHA account has been closed — ${why}.`;
    default: return `${a.tenant_name}: notice from the WAISHA office — ${why}.`;
  }
}

function subjectOf(a: AppliedAction): string {
  const label: Record<TenantAction, string> = {
    block: "WAISHA access suspended",
    unblock: "WAISHA access restored",
    close: "WAISHA account closed",
    notice: "Notice from the WAISHA office"
  };
  return `${label[a.action]} — ${a.tenant_name}`;
}

function bodyText(a: AppliedAction): string {
  const extra = a.action === "block"
    ? "Your data stays in WAISHA and your staff cannot sign in while the company is suspended."
    : a.action === "close"
      ? "Records are kept for the statutory period; the company can no longer sign in."
      : "";
  return [
    headline(a),
    a.note,
    extra,
    `Reply to ${SUPPORT_EMAIL} or call ${SUPPORT_PHONE} to talk to the office.`
  ].filter(Boolean).join("\n\n");
}

const esc = (v: unknown) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function bodyHtml(a: AppliedAction): string {
  const lines = a.note.split(/\r?\n/).map(l => `<p>${esc(l)}</p>`).join("");
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:18px;margin:0 0 16px">${esc(subjectOf(a))}</h1>
<p style="font-size:15px;margin:0 0 12px">${esc(headline(a))}</p>${lines}
<p style="font-size:13px;color:#5a6b7a">Reply to ${SUPPORT_EMAIL} or call ${esc(SUPPORT_PHONE)} to talk to the office.</p>
</div>`;
}

/** The SMS stays short enough to be read in a notification: the act, the reason, the note. */
function smsText(a: AppliedAction): string {
  const raw = `${headline(a)} ${a.note} WAISHA office ${SUPPORT_PHONE}`;
  return raw.length > 300 ? `${raw.slice(0, 297)}…` : raw;
}

const phoneOf = (t: NoticeTarget): string | null => {
  if (!t.phone) return null;
  try {
    const plain = decryptField(Buffer.from(t.phone, "hex"));
    return /^\+?\d{9,15}$/.test(plain.replace(/[\s-]/g, "")) ? plain : null;
  } catch {
    // A blob this path cannot open is a broken stored value, not a reason to fail the
    // whole notice; the receipt records the miss and the email still goes.
    return null;
  }
};

const maskPhone = (p: string) =>
  p.length > 6 ? `${p.slice(0, 3)} ${"*".repeat(Math.min(7, p.length - 6))} ${p.slice(-3)}` : "***";

const maskEmail = (e: string) => {
  const at = e.indexOf("@");
  return at > 0 ? `${e[0]}***${e.slice(at)}` : "***";
};

export interface DeliveryReceipt {
  subject: string;
  recipients: number;
  sms: { sent: number; failed: number };
  email: { sent: number; failed: number };
  to: { sms?: string; email?: string }[];
  errors: string[];
  sent_at: string;
}

/**
 * Sends on both channels and returns the receipt for the register. Never throws: every
 * failure is a line in the receipt the desk can read.
 */
export async function sendTenantNotice(a: AppliedAction, sendSmsImpl: (e164: string, message: string) => Promise<void>):
  Promise<DeliveryReceipt> {
  const message = smsText(a);
  const mail = { to: "", subject: subjectOf(a), text: bodyText(a), html: bodyHtml(a) };
  const receipt: Omit<DeliveryReceipt, "sent_at"> = {
    subject: subjectOf(a), recipients: a.targets.length,
    sms: { sent: 0, failed: 0 }, email: { sent: 0, failed: 0 }, to: [], errors: []
  };

  for (const t of a.targets) {
    const entry: { sms?: string; email?: string } = {};
    const phone = phoneOf(t);
    if (phone) {
      entry.sms = maskPhone(phone);
      try {
        await sendSmsImpl(phone, message);
        receipt.sms.sent++;
      } catch (e) {
        receipt.sms.failed++;
        receipt.errors.push(`sms ${String(e).slice(0, 120)}`);
      }
    } else {
      receipt.sms.failed++;
    }
    if (t.email) {
      entry.email = maskEmail(t.email);
      try {
        await sendMail({ ...mail, to: t.email });
        receipt.email.sent++;
      } catch (e) {
        receipt.email.failed++;
        receipt.errors.push(`email ${String(e).slice(0, 120)}`);
      }
    } else {
      receipt.email.failed++;
    }
    receipt.to.push(entry);
  }

  return { ...receipt, sent_at: new Date().toISOString() };
}
