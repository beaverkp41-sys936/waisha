import { z } from "zod";
import { linkAddress } from "../security/url.js";

/**
 * The platform's own words, in one list.
 *
 * content_blocks (001) is a key/locale/value table that has been readable by the runtime
 * role since the first migration and — until 100 — unwritable by it. The two sides of the
 * command center read this file rather than each keeping their own copy of which keys mean
 * something: GET /content/footer has to know that `footer.support_email` is the field the
 * page calls `supportEmail`, and the control desk has to render an input for exactly the
 * keys that a renderer will actually read. When those two lists are written in two places,
 * the failure is a footer that silently keeps showing last year's phone number while the
 * desk says it was changed.
 *
 * Every key here is seeded (seed.sql for the original six, 100 for the footer's new ones,
 * 105 for the brand line's move out of the footer), so the desk never invents a row and
 * never edits a block nothing reads. `feature_flags` is deliberately not in here: it is
 * seeded and unread — a switch on this desk would move nothing, which is worse than not
 * offering it.
 */

export const LOCALES = ["en", "sw"] as const;
export type Locale = (typeof LOCALES)[number];

export type FieldKind = "text" | "multiline" | "email" | "phone" | "e164" | "links" | "social";

export interface ContentField {
  key: string;
  /** Which part of the site the desk shows this under. */
  group: "footer" | "signin";
  /** The name the public payload sends it as, so the client keeps its own vocabulary. */
  wire: string;
  label: string;
  kind: FieldKind;
  max: number;
  hint: string;
}

export const CONTENT_FIELDS: ContentField[] = [
  {
    key: "footer.support_email", group: "footer", wire: "supportEmail", label: "Support email",
    kind: "email", max: 254,
    hint: "Shown as text and used as the mailto: address."
  },
  {
    key: "footer.phone", group: "footer", wire: "phone", label: "Phone line(s)",
    kind: "phone", max: 120,
    hint: "Typed the way it should be read out, e.g. +255 717 601 440 / +255 754 000 440."
  },
  {
    key: "footer.whatsapp", group: "footer", wire: "whatsapp", label: "WhatsApp number",
    kind: "e164", max: 20,
    hint: "One number in international format. It becomes the click-to-chat link."
  },
  {
    key: "footer.address", group: "footer", wire: "address", label: "Office address",
    kind: "multiline", max: 300,
    hint: "Street and city, as a caller would write it on an envelope. Leave empty to hide."
  },
  {
    key: "footer.hours", group: "footer", wire: "hours", label: "Answering hours",
    kind: "text", max: 140,
    hint: "When somebody actually picks up, e.g. Mon–Fri 08:00–17:00, Sat 09:00–13:00."
  },
  {
    key: "footer.copyright", group: "footer", wire: "copyright", label: "Legal line",
    kind: "text", max: 200,
    hint: "Under the bar. Year numbers go stale, so it is written by a person and edited here."
  },
  {
    key: "footer.links", group: "footer", wire: "links", label: "Footer links",
    kind: "links", max: 8,
    hint: "A label and an address for each. Only https, http, mailto and tel addresses are kept."
  },
  {
    key: "footer.social", group: "footer", wire: "social", label: "Social profiles",
    kind: "social", max: 8,
    hint: "Network, handle and page address. Empty list hides the row."
  },
  {
    key: "login.subtitle", group: "signin", wire: "loginSubtitle", label: "Sign-in subtitle",
    kind: "text", max: 120,
    hint: "The line under WAISHA on the sign-in card."
  },
  {
    key: "signup.success.title", group: "signin", wire: "signupSuccessTitle",
    label: "Sign-up done — heading", kind: "text", max: 120,
    hint: "Said once, on the panel that appears after an account is created."
  },
  {
    key: "signup.success.body", group: "signin", wire: "signupSuccessBody",
    label: "Sign-up done — sentence", kind: "multiline", max: 400,
    hint: "What happens next, in the caller's own language where the browser asks for Swahili."
  },
  {
    key: "login.brand", group: "signin", wire: "loginBrand", label: "Brand line",
    kind: "text", max: 120,
    hint: "Whose product this is, said once at the foot of the sign-in card — e.g. "
      + "\"powered by T ENGO AEGIS\". The sign-in card is the front door of the whole "
      + "platform, so this is where the mark belongs; the footer carries contact details "
      + "and answering hours, not advertising."
  }
];

export const FIELD_BY_KEY: ReadonlyMap<string, ContentField> =
  new Map(CONTENT_FIELDS.map((f) => [f.key, f]));

/** The locale that gets a value sent to it; anything else is refused rather than guessed at. */
export const localeSchema = z.enum(LOCALES);

const NETWORKS = ["whatsapp", "instagram", "facebook", "x", "linkedin",
  "tiktok", "youtube", "telegram", "website"] as const;

/**
 * The two structured fields are stored as JSON text in the same `value` column that holds a
 * sentence, so they are validated as data on the way in and parsed defensively on the way
 * out — a row edited by hand through the console must not be able to throw inside a public
 * page render.
 */
export const linksSchema = z.array(z.object({
  label: z.string().trim().min(1).max(40),
  href: linkAddress(300)
}).strict()).max(8);

export const socialSchema = z.array(z.object({
  network: z.enum(NETWORKS),
  handle: z.string().trim().min(1).max(60),
  href: linkAddress(300)
}).strict()).max(8);

export type FooterLink = z.infer<typeof linksSchema>[number];
export type SocialLink = z.infer<typeof socialSchema>[number];

/** One field's input rule, given the registry entry. Blank is always allowed: an empty
 *  block means "the page does not show this", which is how a line is removed without
 *  deleting the row (100 keeps DELETE away from the runtime role on purpose). */
export function valueSchema(f: ContentField) {
  if (f.kind === "links") return linksSchema.nullable();
  if (f.kind === "social") return socialSchema.nullable();
  if (f.kind === "email") {
    return z.string().trim().max(f.max)
      .pipe(z.union([z.literal(""), z.string().email()])).nullable();
  }
  if (f.kind === "e164") {
    return z.string().trim().max(f.max)
      .pipe(z.union([z.literal(""), z.string().regex(/^\+[1-9]\d{7,14}$/)])).nullable();
  }
  const base = f.kind === "multiline"
    ? z.string().trim().max(f.max)
    : z.string().trim().max(f.max).refine((v) => !/[\r\n]/.test(v),
      "This line is shown in one row — no line breaks.");
  return base.nullable();
}

/** How a stored value is shown on the desk: JSON fields come back as data, not as a string. */
export function decode(f: ContentField, raw: string): unknown {
  if (f.kind === "links" || f.kind === "social") {
    try {
      const parsed = JSON.parse(raw);
      const list = f.kind === "links" ? linksSchema.safeParse(parsed)
        : socialSchema.safeParse(parsed);
      return list.success ? list.data : [];
    } catch {
      return [];
    }
  }
  return raw;
}

/** And how it goes back into the column. */
export function encode(f: ContentField, value: unknown): string {
  if (f.kind === "links" || f.kind === "social") {
    const list = Array.isArray(value) ? value : [];
    return list.length ? JSON.stringify(list) : "";
  }
  return typeof value === "string" ? value : "";
}
