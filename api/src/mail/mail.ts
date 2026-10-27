import { env } from "../env.js";
import { pool } from "../db/pool.js";

export interface Mail { to: string; subject: string; html: string; text: string; }

/** Why a message went out. Mirrors the CHECK list on message_deliveries (112, widened by 125
 *  and 144) and the guard inside platform_auth.record_message_delivery — a value outside it is
 *  dropped by the writer, so a typo here loses evidence silently. */
export type DeliveryPurpose =
  | "signup_otp" | "otp_resend" | "password_reset" | "staff_invite"
  | "tenant_notice" | "platform_test" | "sla_breach" | "expiry_reminder";

/** Where the register should attribute a line. Both are optional: a send that happens
 *  before a company exists, or one the office runs against an address it does not hold,
 *  still has to be recorded. */
export interface DeliveryContext {
  purpose: DeliveryPurpose;
  tenantId?: string | null;
  userId?: string | null;
}

export type DeliveryStatus = "sent" | "failed" | "skipped";

/** What one logical send cost and what came back. Returned, not thrown: see sendMail. */
export interface SendReceipt {
  channel: "email" | "sms";
  status: DeliveryStatus;
  delivered: boolean;
  attempts: number;
  providerMessageId: string | null;
  error: string | null;
}

// Resend answers in well under a second; a call that takes longer than this is a hung
// socket, not a slow provider, and the caller is a person waiting on a sign-up screen.
const MAIL_TIMEOUT_MS = 12000;
const MAIL_RETRY_MS = 500;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The same mask the register writes (112), applied to the console lines too: a recipient
 *  address in a log file is PII that outlives the request, and the log is the one place
 *  nobody promised to encrypt. */
function maskDest(to: string): string {
  const at = to.indexOf("@");
  if (at > 0) return `${to.slice(0, 1)}***@${to.slice(at + 1)}`;
  return to.length > 8 ? `${to.slice(0, 4)}***${to.slice(-4)}` : "***";
}

interface Attempt { ok: boolean; id: string | null; error: string; retryable: boolean; }

async function attemptSend(mail: Mail): Promise<Attempt> {
  let res: Response;
  try {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text
      }),
      signal: AbortSignal.timeout(MAIL_TIMEOUT_MS)
    });
  } catch (e) {
    // A timeout, a DNS failure or a dropped socket says nothing about the message, so it
    // says nothing about whether to retry — and a second try on a transient network fault
    // is the difference between a code arriving and a person locked out.
    return { ok: false, id: null, error: `network: ${String(e).slice(0, 200)}`, retryable: true };
  }

  // Read the body even on success: the id is the only thing that lets the office follow a
  // "it never arrived" call up with Resend support.
  const body = await res.text().catch(() => "");
  let id: string | null = null;
  try { id = body ? (JSON.parse(body)?.id ?? null) : null; } catch { /* a non-JSON error page */ }

  if (res.ok) return { ok: true, id, error: "", retryable: false };
  // 429 and 5xx are the provider being busy or unhappy with us; 4xx on an address will
  // still be a bad address on the second try, so only the first class gets one.
  const retryable = res.status === 429 || res.status >= 500;
  return { ok: false, id, error: `resend ${res.status}: ${body.slice(0, 240)}`, retryable };
}

/**
 * Write the line into the register, and never let that write disturb the caller.
 *
 * The table has no grants (112), so this goes through the definer. A database that is
 * unreachable at the moment of a send is not a reason to tell a person their sign-up
 * failed — the send already happened, and the register missing one line is strictly
 * better than an account that cannot be created.
 */
async function record(channel: "email" | "sms", to: string, subject: string | null,
                     r: SendReceipt, ctx: DeliveryContext | undefined): Promise<void> {
  try {
    await pool.query(
      `select platform_auth.record_message_delivery(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [channel, ctx?.purpose ?? "platform_test", to, subject, r.status, "resend",
       r.providerMessageId, r.error, r.attempts, ctx?.tenantId ?? null, ctx?.userId ?? null]);
  } catch (e) {
    console.warn(`[mail] delivery not recorded: ${String(e).slice(0, 160)}`);
  }
}

/**
 * Send one email and record what happened. Never throws.
 *
 * The gate used to be `!env.RESEND_API_KEY || !isProd`, which meant a correct key changed
 * nothing until a deploy: every code and every reset link on this machine went to stdout
 * and to nobody else, and a sign-up that looked fine in the browser left a pending
 * account with no way to finish. A key present is the operator's instruction to send.
 *
 * A failed send is a receipt, not an exception. A sign-up has already written its tenant,
 * its seat and its OTP by the time this runs; throwing here answered a person who had
 * successfully registered with a 500, and their retry then hit "this email is already
 * registered" — the "unexpected error, then too many attempt" the office reported. The
 * caller decides what to say, and the register holds the reason either way.
 */
export async function sendMail(mail: Mail, ctx?: DeliveryContext): Promise<SendReceipt> {
  if (!env.RESEND_API_KEY) {
    console.log(`[mail:console] to=${maskDest(mail.to)} subject="${mail.subject}"\n${mail.text}`);
    const r: SendReceipt = {
      channel: "email", status: "skipped", delivered: false, attempts: 0,
      providerMessageId: null,
      error: "RESEND_API_KEY is not set — the message went to the server log, not to anyone"
    };
    await record("email", mail.to, mail.subject, r, ctx);
    return r;
  }

  let a = await attemptSend(mail);
  let attempts = 1;
  if (!a.ok && a.retryable) {
    await sleep(MAIL_RETRY_MS);
    attempts = 2;
    a = await attemptSend(mail);
  }

  const r: SendReceipt = {
    channel: "email",
    status: a.ok ? "sent" : "failed",
    delivered: a.ok,
    attempts,
    providerMessageId: a.id,
    error: a.ok ? null : a.error
  };
  await record("email", mail.to, mail.subject, r, ctx);
  if (!a.ok) console.warn(`[mail] send failed to=${maskDest(mail.to)} ${a.error}`);
  return r;
}

/**
 * SMS is not wired to an aggregator yet (Phase 2), so this is a console transport in every
 * environment — including production. It records that fact rather than staying silent,
 * because "we texted you" is only true if somebody can prove it went.
 */
export async function sendSms(e164: string, message: string, ctx?: DeliveryContext):
  Promise<SendReceipt> {
  console.log(`[sms:console] to=${maskDest(e164)} message="${message}"`);
  const r: SendReceipt = {
    channel: "sms", status: "skipped", delivered: false, attempts: 0,
    providerMessageId: null,
    error: "no SMS aggregator is configured — the message was logged, not delivered"
  };
  await record("sms", e164, message.slice(0, 120), r, ctx);
  return r;
}

/** Whether a real send is possible at all. The control desk says this out loud rather than
 *  letting a company sit in pending_verification while the office believes it was notified. */
export function mailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY);
}
