import {
  AtSign, Briefcase, Camera, Globe, MessageCircle, Music2, Send, Users, Video,
  type LucideIcon
} from "lucide-react";
import { WeatherStrip } from "@/components/WeatherStrip";
import { FooterReserve } from "@/components/FooterReserve";

/* One composition for both footers: the marketing shell renders this from the
   server Footer, the portal scroll container from the client ShellFooter. Keeping
   it in one place is what makes the bar identical on every page of the system.

   Every word here comes from GET /content/footer, which is the same table the command
   center desk writes (/control/content, 100). A field the desk can edit but the bar does
   not read would be a worse lie than a hard-coded line, so the list below and the registry
   in api/src/content/fields.ts are the two ends of one contract.

   The brand line is not in that list. It used to open this bar; 105 moved it to the foot of
   the sign-in card, which is the one page every person sees before they see anything else. */

export type FooterLink = { label: string; href: string };
export type FooterSocial = { network: string; handle: string; href: string };

export type FooterContent = {
  supportEmail: string;
  phone: string;
  whatsapp: string;
  address: string;
  hours: string;
  copyright: string;
  links: FooterLink[];
  social: FooterSocial[];
};

/** What the bar shows when the API never answered — the words it shipped with. */
export const FOOTER_DEFAULT: FooterContent = {
  supportEmail: "support@tengoaegis.com",
  phone: "+255 717 601 440 / +255 754 000 440",
  whatsapp: "",
  address: "",
  hours: "",
  copyright: "",
  links: [],
  social: []
};

const text = (v: unknown) => (typeof v === "string" ? v : "");
const rows = <T extends object>(v: unknown): T[] =>
  (Array.isArray(v) ? v : []).filter((r) => r && typeof r === "object") as T[];

/** An empty block means "the page does not show this", so a missing field is not a crash and
 *  a partial payload from an older API is not either. */
export function normalizeFooter(j: any): FooterContent {
  if (!j || typeof j !== "object") return FOOTER_DEFAULT;
  return {
    supportEmail: text(j.supportEmail),
    phone: text(j.phone),
    whatsapp: text(j.whatsapp),
    address: text(j.address),
    hours: text(j.hours),
    copyright: text(j.copyright),
    links: rows<FooterLink>(j.links)
      .filter((l) => text(l.label) && text(l.href))
      .map((l) => ({ label: text(l.label), href: text(l.href) })),
    social: rows<FooterSocial>(j.social)
      .filter((s) => text(s.href))
      .map((s) => ({ network: text(s.network), handle: text(s.handle), href: text(s.href) }))
  };
}

/** The desk's network keys, each with the mark a caller recognises. An unknown network still
 *  gets a link — it just wears the globe, because a lost profile is worse than a plain one.
 *  lucide 1.x dropped the brand glyphs, so these are the neutral shape of each network rather
 *  than its logo; the handle beside the mark is what identifies it either way. */
const NETWORK_MARK: Record<string, LucideIcon> = {
  whatsapp: MessageCircle, instagram: Camera, facebook: Users, x: AtSign,
  linkedin: Briefcase, tiktok: Music2, youtube: Video, telegram: Send, website: Globe
};

/** wa.me wants the number and nothing else. The desk only accepts E.164, so a stored value
 *  that has since been edited by hand through the console gets no link rather than a wrong one. */
function waLink(e164: string): string | null {
  return /^\+[1-9]\d{7,14}$/.test(e164)
    ? `https://wa.me/${e164.replace(/\D/g, "")}` : null;
}

/* `weather` is switched off only by the command center's preview: the forecast belongs to the
   visitor's own device, and a desk that asked a weather service for a bar it is only imagining
   would be noise on every keystroke. */
export function FooterBar({ content, weather = true }:
  { content: FooterContent; weather?: boolean }) {
  const { supportEmail, phone, whatsapp, address, hours, copyright, links, social } = content;
  const chat = waLink(whatsapp);
  const words = [
    // The address is a mailto:, but it is read as a line of text first: the office asked
    // for it without the underline, which made it look like a link in the middle of a
    // sentence rather than the way to reach a person.
    supportEmail && <a key="e" className="footer-link"
      href={`mailto:${supportEmail}`}>{supportEmail}</a>,
    phone && <span key="p">mob. {phone}</span>,
    chat && <a key="w" className="footer-link underline" href={chat}>WhatsApp {whatsapp}</a>
  ].filter(Boolean);
  const hasSecondRow = links.length > 0 || social.length > 0 || !!address || !!hours;

  return (
    <footer className="app-footer w-full py-12 text-[13px] tracking-[0.04em] text-white">
      <div className="footer-line">
        <span className="footer-words">
          {words.map((w, i) => (
            <span key={i}>
              {i > 0 && <span aria-hidden> | </span>}
              {w}
            </span>
          ))}
        </span>
        {weather && <WeatherStrip />}
      </div>

      {hasSecondRow && (
        <div className="footer-line footer-after">
          {links.length > 0 && (
            <span className="footer-group">
              {links.map((l, i) => (
                <a key={`${l.href}-${i}`} className="footer-link underline" href={l.href}>
                  {l.label}
                </a>
              ))}
            </span>
          )}
          {social.length > 0 && (
            <span className="footer-group" aria-label="Social profiles">
              {social.map((s, i) => {
                const Mark = NETWORK_MARK[s.network] ?? Globe;
                return (
                  <a key={`${s.href}-${i}`} className="footer-link footer-social"
                    href={s.href}
                    title={s.handle ? `${s.network}: ${s.handle}` : s.network}>
                    <Mark aria-hidden width={14} height={14} strokeWidth={1.8} />
                    {s.handle && <span>{s.handle}</span>}
                  </a>
                );
              })}
            </span>
          )}
          {hours && <span className="footer-note">{hours}</span>}
          {address && <span className="footer-note footer-address">{address}</span>}
        </div>
      )}

      {copyright && <p className="footer-rights">{copyright}</p>}
      <FooterReserve />
    </footer>
  );
}
