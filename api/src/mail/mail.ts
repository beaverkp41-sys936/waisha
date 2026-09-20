import { env, isProd } from "../env.js";

export interface Mail { to: string; subject: string; html: string; text: string; }

/** Resend via plain REST — the provider is a dumb pipe; Super Admin owns templates. */
export async function sendMail(mail: Mail): Promise<void> {
  if (!env.RESEND_API_KEY || !isProd) {
    console.log(`[mail:console] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text })
  });
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
}

/** SMS console transport for development. Production aggregator adapter ships in Phase 2. */
export async function sendSms(e164: string, message: string): Promise<void> {
  console.log(`[sms:console] to=${e164} message="${message}"`);
}