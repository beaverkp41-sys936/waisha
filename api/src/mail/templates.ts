import type { Mail } from "./mail.js";

/**
 * The three messages WAISHA sends on its own initiative: a verification code, a password
 * reset link and a staff invite.
 *
 * They live here rather than inline in the routes for one reason — a code that arrives as
 * an unstyled line of text in a bodyless email reads as phishing, and the person who typed
 * their company name into a sign-up form is exactly who that confuses. Each one says who it
 * is from, what it is for, when it stops working, and what to do if nobody asked for it.
 *
 * The `text` part is never a throwaway: it is what a screen reader on a feature phone hears,
 * and what the console transport prints on a development machine.
 */

/** Every builder escapes the same way, and the rule is worth stating once: a value that came
 *  from a form is data, and goes through this before it reaches an attribute or a tag. */
const esc = (v: unknown) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function shell(title: string, bodyHtml: string): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:28px 24px;color:#0f1c26">
<p style="margin:0 0 20px;font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#4d6472">Waisha</p>
<h1 style="font-size:19px;line-height:1.35;margin:0 0 14px">${esc(title)}</h1>
${bodyHtml}
<p style="font-size:13px;line-height:1.5;color:#5a6b7a;margin:26px 0 0">
This was sent to the address on your WAISHA account. If you did not ask for it, you do not need to
do anything — nobody can verify an account with a message they did not receive.</p>
</div>`;
}

function codeBlock(code: string): string {
  return `<p style="margin:22px 0 6px"><span style="display:inline-block;font-family:ui-monospace,SFMono-Regular,monospace;`
    + `font-size:28px;letter-spacing:.22em;font-weight:700;padding:14px 20px;border-radius:10px;`
    + `background:#f1f5f8;color:#0f1c26">${esc(code)}</span></p>`;
}

/** A link shown as text as well as an anchor: most mail clients hide one of the two, and a
 *  reset that cannot be opened is a support call. */
function linkBlock(url: string): string {
  return `<p style="margin:22px 0 10px"><a href="${esc(url)}" style="display:inline-block;`
    + `background:#0f766e;color:#fff;text-decoration:none;font-size:15px;font-weight:600;`
    + `padding:12px 20px;border-radius:8px">Open the link</a></p>`
    + `<p style="font-size:12px;word-break:break-all;color:#5a6b7a;margin:0">${esc(url)}</p>`;
}

export function otpEmail(to: string, code: string, ttlMinutes: number): Mail {
  return {
    to,
    subject: `Your WAISHA verification code`,
    text: `Your WAISHA verification code is ${code}. It expires in ${ttlMinutes} minutes. `
      + `If you did not ask for a WAISHA account, ignore this email.`,
    html: shell("Verify your WAISHA account",
      `<p style="font-size:15px;line-height:1.55;margin:0">Enter this six-digit code on the sign-up `
      + `screen. It expires in <b>${ttlMinutes} minutes</b> and works once.</p>`
      + codeBlock(code))
  };
}

export function resetEmail(to: string, url: string, ttlMinutes: number): Mail {
  return {
    to,
    subject: "Reset your WAISHA password",
    text: `Open this link to choose a new WAISHA password. It expires in ${ttlMinutes} minutes `
      + `and works once: ${url}`,
    html: shell("Choose a new password",
      `<p style="font-size:15px;line-height:1.55;margin:0">This link lets you set a new password for `
      + `your WAISHA account. It expires in <b>${ttlMinutes} minutes</b> and works once.</p>`
      + linkBlock(url))
  };
}

export function inviteEmail(to: string, o: {
  fullName: string; tenantName: string; url: string; days: number;
}): Mail {
  return {
    to,
    subject: `You are invited to the WAISHA portal for ${o.tenantName}`,
    text: `${o.fullName}, you have been invited to the WAISHA portal for ${o.tenantName}. `
      + `Accept within ${o.days} days: ${o.url} — then sign in with the company TIN and this email.`,
    html: shell(`You are joining ${o.tenantName} on WAISHA`,
      `<p style="font-size:15px;line-height:1.55;margin:0">Hello ${esc(o.fullName)}, a director has `
      + `opened you a seat in the <b>${esc(o.tenantName)}</b> WAISHA portal. Choose a password to `
      + `accept. The link expires in <b>${o.days} days</b> and works once.</p>`
      + linkBlock(o.url)
      + `<p style="font-size:14px;line-height:1.55;margin:18px 0 0">After choosing a password, sign in `
      + `with the company TIN and this email address.</p>`)
  };
}
