import type { Mail } from "./mail.js";

/**
 * The notice that says a desk's own promise has run out (125; the board is 123's clock).
 *
 * This goes to a desk head inside the platform, not to a caller — which is why it can name the
 * company, the caller's subject line and the incidence number in plain words. Nothing here is
 * sent to the customer, and the register still records only a masked address, because the
 * delivery line outlives the request that made it.
 *
 * Kiswahili is chosen by the head's own `language` on their seat, the same way a caller's
 * language picks the half of a canned reply. Two copies of the sentence are written here on
 * purpose: a notice that mixes languages mid-line is the one thing that makes a desk head
 * discount the whole email as a machine's work.
 */

export interface BreachLine {
  id: string;
  ref: string;
  dept_ref: string | null;
  subject: string;
  priority: string;
  channel: string;
  company_name: string | null;
  first_response_at: string | null;
  resolution_due_at: string | null;
}

export interface BreachDesk {
  id: string;
  name: string;
  /** The earliest deadline any of these calls owed. Said in words, because "oldest" without a
   *  date is the sentence a desk argues with. */
  worst_overdue_since: string | null;
}

export interface BreachHead {
  full_name: string;
  email: string;
  language: string | null;
}

const esc = (v: unknown) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A deadline read the way the desk reads its own board: minute precision, no timezone suffix
 *  to squint at. The provider renders this for a human scanning a list, not for a parser. */
const stamp = (v: unknown) => v
  ? String(v).slice(0, 16).replace("T", " ") + " UTC"
  : "no date";

const said = (l: BreachLine) => l.dept_ref ?? l.ref;

function headline(sw: boolean, n: number, desk: string): string {
  return sw
    ? `Ombi ${n} za wateja zimevuka muda ulioahidiwa na ${desk}`
    : `${n} customer ${n === 1 ? "call is" : "calls are"} past the time ${desk} promised to answer`;
}

export function breachSubject(head: BreachHead, desk: BreachDesk, lines: BreachLine[]): string {
  const sw = head.language === "sw";
  return `${sw ? "Muda umevuka" : "SLA breach"} — ${desk.name}: ${lines.length} `
    + `${sw ? "zimechelewa" : "past their date"} (oldest ${stamp(desk.worst_overdue_since)})`;
}

export function breachMail(head: BreachHead, desk: BreachDesk, lines: BreachLine[]): Mail {
  const sw = head.language === "sw";
  const n = lines.length;

  const text = [
    sw ? `Habari ${head.full_name},` : `Hello ${head.full_name},`,
    "",
    sw
      ? `Wewe ni desk head wa ${desk.name}. Ombi zifuatazo za wateja zimevuka muda ulioahidiwa `
        + `katika panel ya departments.`
      : `You are the desk head for ${desk.name}, and these calls are now past the deadline `
        + `your own desk set in the departments panel.`,
    "",
    headline(sw, n, desk.name),
    "",
    ...lines.map(l => `  • ${said(l)}  ${l.subject}`
      + `  (${l.priority}, ${l.channel}${l.company_name ? `, ${l.company_name}` : ""})`
      + `  owed by ${stamp(l.resolution_due_at ?? l.first_response_at)}`),
    "",
    sw
      ? "Anza kwa zile ambazo bado hazijajibiwa — kila jibu linaandikwa kwenye register."
      : "Start with the ones nobody has answered yet — every answer is written into the register.",
    "",
    sw
      ? "— Waish Transit, register ya wateja. Tafadhali usijibu barua hii."
      : "— Waish Transit, customer service register. Please do not reply to this email.",
    "",
    `Oldest overdue since: ${stamp(desk.worst_overdue_since)}`
  ].join("\n");

  const html = `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0f1c26">
<h1 style="font-size:18px;line-height:1.35;margin:0 0 12px">${esc(headline(sw, n, desk.name))}</h1>
<p style="font-size:15px;margin:0 0 16px">${sw
    ? `Habari ${esc(head.full_name)}, wewe ni desk head wa <b>${esc(desk.name)}</b>. Ombi zifuatazo zimevuka muda ulioahidiwa.`
    : `Hello ${esc(head.full_name)}, you are the desk head for <b>${esc(desk.name)}</b>, and these calls are past the deadline that desk set for itself.`}</p>
<table role="presentation" style="border-collapse:collapse;width:100%;font-size:14px">
<thead><tr style="text-align:left;color:#5a6b7a">
<th style="padding:6px 8px;border-bottom:1px solid #d7e0e6">${sw ? "Namba" : "Number"}</th>
<th style="padding:6px 8px;border-bottom:1px solid #d7e0e6">${sw ? "Jambo" : "Subject"}</th>
<th style="padding:6px 8px;border-bottom:1px solid #d7e0e6">${sw ? "Hali" : "Rating"}</th>
<th style="padding:6px 8px;border-bottom:1px solid #d7e0e6">${sw ? "Mwisho" : "Was due"}</th>
</tr></thead>
<tbody>${lines.map(l => `<tr>
<td style="padding:7px 8px;border-bottom:1px solid #eef2f5;white-space:nowrap"><b>${esc(said(l))}</b></td>
<td style="padding:7px 8px;border-bottom:1px solid #eef2f5">${esc(l.subject.slice(0, 120))}
${l.company_name ? `<br><span style="color:#5a6b7a;font-size:12px">${esc(l.company_name)}</span>` : ""}</td>
<td style="padding:7px 8px;border-bottom:1px solid #eef2f5;white-space:nowrap">${esc(l.priority)}
<br><span style="color:#5a6b7a;font-size:12px">${esc(l.channel)}</span></td>
<td style="padding:7px 8px;border-bottom:1px solid #eef2f5;white-space:nowrap">${esc(stamp(l.resolution_due_at ?? l.first_response_at))}</td>
</tr>`).join("")}</tbody></table>
<p style="font-size:14px;margin:18px 0 6px">${sw
    ? "Anza kwa zile ambazo bado hazijajibiwa — ombi lisilojibiwa ndilo ambalo mteja bado anangoja."
    : "Start with the calls nobody has answered yet — an unanswered call is the one a customer is still waiting on."}</p>
<p style="font-size:12px;color:#5a6b7a;margin:14px 0 0">${sw
    ? `— Waish Transit, register ya wateja. Tafadhali usijibu barua hii. Mwisho uliopita ulianza ${esc(stamp(desk.worst_overdue_since))}.`
    : `— Waish Transit, customer service register. Please do not reply to this email. Oldest overdue since ${esc(stamp(desk.worst_overdue_since))}.`}</p>
</div>`;

  return { to: head.email, subject: breachSubject(head, desk, lines), html, text };
}
