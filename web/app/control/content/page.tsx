"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";
import {
  FooterBar, normalizeFooter, type FooterContent, type FooterLink, type FooterSocial
} from "@/components/FooterBar";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/*
 * The command center (100; task #244) — the platform's own words, rewritten without a deploy.
 *
 * The desk is generated from the API's registry, not written out here: GET /control/content
 * answers with one entry per block a renderer actually reads, including its label, its rule and
 * the hint that says where it appears. That is the whole point of the registry living in
 * api/src/content/fields.ts — a desk that offers a field nothing reads lets an operator change
 * something and watch nothing happen, which is worse than not offering it. `feature_flags` is
 * seeded and deliberately absent for exactly that reason.
 *
 * Both locales are edited side by side because they are one row each in the same table: a desk
 * that showed only English would leave a Swahili speaker reading last year's sentence with
 * nobody able to see why. A blank line is not an error — it means "the page does not show
 * this", which is how a sentence is retired without deleting the row the seed file is the only
 * other copy of.
 *
 * Every box is a controlled input, including the row editors: `defaultValue` would keep its own
 * text when a row above it is removed or the draft is thrown away, and the desk would then be
 * showing words its own state does not hold.
 */

type FieldKind = "text" | "multiline" | "email" | "phone" | "e164" | "links" | "social";
type Cell = string | FooterLink[] | FooterSocial[];

type DeskField = {
  key: string; wire: string; label: string; kind: FieldKind; max: number; hint: string;
  values: Record<string, unknown>;
  edited: Record<string, { at: string | null; by: string | null }>;
};
type DeskGroup = { group: string; label: string; fields: DeskField[] };
type Desk = { can_manage: boolean; locales: string[]; groups: DeskGroup[] };
type Draft = Record<string, Record<string, Cell>>;

const LOCALE_LABEL: Record<string, string> = { en: "English", sw: "Kiswahili" };
const NETWORKS = ["whatsapp", "instagram", "facebook", "x", "linkedin",
  "tiktok", "youtube", "telegram", "website"];
/** The three schemes a clicked address may carry (api/src/security/url.ts). Judged here so an
 *  operator is told before pressing publish, not after — the API stays the authority, and a
 *  value that slips through this looser check is refused there. */
const CLICKABLE = /^(https?|mailto|tel):/i;
const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

const isList = (k: FieldKind) => k === "links" || k === "social";
const asText = (c: Cell | undefined) => (typeof c === "string" ? c : "");
const asRows = (c: Cell | undefined): any[] => (Array.isArray(c) ? c : []);
/** Two cells are the same line when their text or their JSON agrees. */
const canon = (kind: FieldKind, c: Cell | undefined) =>
  isList(kind) ? JSON.stringify(asRows(c)) : asText(c);
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : null;

function seedOf(d: Desk): Draft {
  const out: Draft = {};
  for (const g of d.groups) for (const f of g.fields) {
    out[f.key] = {};
    for (const l of d.locales) out[f.key][l] = (f.values[l] ?? (isList(f.kind) ? [] : "")) as Cell;
  }
  return out;
}

/** Tell Next that the footer it rendered on the server is no longer the current one.
 *  Best-effort on purpose: the desk's own preview, the sign-in card and the portal bar all
 *  re-read per visitor already, so a failed call costs a marketing page wearing yesterday's
 *  bar for one cache window — never a lost write, which the desk reports on its own. */
function revalidateFooter() {
  return fetch("/api/content/footer/revalidate", { method: "POST" }).catch(() => {});
}

/** The API's rules, run before the request so a bad address is pointed at the box it was typed
 *  into instead of arriving as one 400 that names a field out of twelve. */
function problems(f: DeskField, cell: Cell): string[] {
  const out: string[] = [];
  if (isList(f.kind)) {
    const rows = asRows(cell);
    if (rows.length > f.max) out.push(`Only ${f.max} of these fit on the bar.`);
    rows.forEach((r, i) => {
      const what = f.kind === "links" ? `Link ${i + 1}` : `Profile ${i + 1}`;
      if (f.kind === "links" && !asText(r.label).trim()) out.push(`${what} has no word to label it.`);
      if (f.kind === "social" && !NETWORKS.includes(r.network)) out.push(`${what} names no network.`);
      const href = asText(r.href).trim();
      if (!href) out.push(`${what} has no address.`);
      else if (!CLICKABLE.test(href))
        out.push(`${what}: “${href.slice(0, 24)}” — a clicked address must start https://, http://, mailto: or tel:`);
      else if (href.length > 300) out.push(`${what}'s address is longer than 300 characters.`);
    });
    return out;
  }
  const v = asText(cell);
  if (v.length > f.max) out.push(`This line holds ${f.max} characters; it is carrying ${v.length}.`);
  if (f.kind !== "multiline" && /[\r\n]/.test(v)) out.push("This line is shown in one row — no line breaks.");
  if (f.kind === "email" && v && !EMAIL.test(v)) out.push("That is not an email address.");
  if (f.kind === "e164" && v && !E164.test(v)) out.push("One number in international format, e.g. +255717601440.");
  return out;
}

export default function ControlContentPage() {
  const [me, setMe] = useState<any>(null);
  const [desk, setDesk] = useState<Desk | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState("");
  const [locale, setLocale] = useState("en");

  const load = useCallback(async () => {
    const res = await fetch(`${API}/api/v1/control/content`, { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    if (!res.ok) { setError("The copy service did not answer."); setLoading(false); return; }
    const j = await res.json();
    const next: Desk = { can_manage: !!j.can_manage, locales: j.locales ?? ["en"], groups: j.groups ?? [] };
    setDesk(next);
    setDraft(seedOf(next));
    setError(null); setLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      load();
    })();
  }, [load]);

  const canManage = !!desk?.can_manage;
  const locales = desk?.locales ?? ["en"];

  const changed = useMemo(() => {
    if (!desk) return [];
    const out: { field: DeskField; locale: string; cell: Cell }[] = [];
    for (const g of desk.groups) for (const f of g.fields) {
      for (const l of desk.locales) {
        const next = draft[f.key]?.[l] ?? (isList(f.kind) ? [] : "");
        if (canon(f.kind, next) !== canon(f.kind, f.values[l] as Cell)) {
          out.push({ field: f, locale: l, cell: next });
        }
      }
    }
    return out;
  }, [desk, draft]);

  const blocked = useMemo(() => {
    const seen = new Set<string>();
    for (const c of changed) for (const p of problems(c.field, c.cell)) seen.add(`${c.field.label} · ${p}`);
    return [...seen];
  }, [changed]);

  const cellOf = (f: DeskField, l: string): Cell => draft[f.key]?.[l] ?? (isList(f.kind) ? [] : "");
  const setCell = (key: string, l: string, cell: Cell) => {
    setDraft(d => ({ ...d, [key]: { ...(d[key] ?? {}), [l]: cell } }));
    setArmed(false); setNotice(null); setSaveError(null);
  };

  /** One PUT for whatever is handed to it: the whole staged set, or a single line of it.
   *  The server judges each key by its own rule and refuses the request before writing
   *  anything if one value does not fit — so while a half-typed footer link is sitting on the
   *  desk, the answering hours can still be published on their own instead of waiting for the
   *  link to be finished. That is what `publish(changed)` could not do. */
  async function publish(targets: { field: DeskField; locale: string; cell: Cell }[], label: string) {
    if (!targets.length || busy) return;
    setBusy(true); setSaveError(null);
    try {
      const values: Record<string, Record<string, unknown>> = {};
      for (const c of targets) (values[c.field.key] ??= {})[c.locale] = c.cell;
      const res = await fetch(`${API}/api/v1/control/content`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify({ values, note: note.trim() })
      });
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hints = (j?.error?.details ?? []).map((d: any) =>
          `${d.field ? `${d.field}: ` : ""}${d.message ?? ""}`).filter(Boolean).slice(0, 4);
        setSaveError([j?.error?.message ?? "The desk refused the save.", ...hints].join(" — "));
        return;
      }
      const next: Desk = {
        can_manage: !!j.can_manage,
        locales: j.locales ?? desk?.locales ?? ["en"],
        groups: j.groups ?? []
      };
      setDesk(next); setNote(""); setArmed(false);
      // Only the lines this save published are re-seeded from the read-back. Seeding the whole
      // desk would throw away every other line the clerk is still typing — publishing the
      // answering hours must not cost them half a paragraph of the sign-up body.
      setDraft(d => {
        const merged = { ...d };
        for (const c of targets) {
          const f = next.groups.flatMap((g) => g.fields).find((x) => x.key === c.field.key);
          merged[c.field.key] = {
            ...(merged[c.field.key] ?? {}),
            [c.locale]: (f?.values[c.locale] ?? (isList(c.field.kind) ? [] : "")) as Cell
          };
        }
        return merged;
      });
      const lines: string[] = j.lines ?? [];
      if (!j.changed) {
        // Not a failure: the desk and the register already agree, so nothing moved and the
        // audit trail stays clean. Saying "published" here would be a lie about a write.
        setNotice(`${label} already says exactly that — nothing was written.`);
        return;
      }
      void revalidateFooter();
      setNotice(`${label} published${lines.length ? `: ${lines.join(", ")}` : ""}. `
        + "The bar a caller reads now carries it — the desk's own preview, the sign-in card, "
        + "the portal bar and the cached marketing footer were all told to re-read.");
    } finally { setBusy(false); }
  }

  async function save() {
    if (!changed.length || blocked.length || note.trim().length < 4) return;
    if (!armed) { setArmed(true); return; }   // this changes what every public page says
    await publish(changed, `${changed.length} line(s)`);
  }

  /** A line the clerk can act on where it is written, rather than only from the staged panel.
   *  `cell` is what to store — an empty cell is the desk's own word for "retire this line". */
  const publishOne = (f: DeskField, l: string, cell: Cell) =>
    publish([{ field: f, locale: l, cell }], `${f.label} (${LOCALE_LABEL[l] ?? l})`);

  const revertOne = (f: DeskField, l: string) => {
    setDraft(d => ({ ...d, [f.key]: { ...(d[f.key] ?? {}), [l]: (f.values[l] ?? (isList(f.kind) ? [] : "")) as Cell } }));
    setArmed(false); setNotice(null); setSaveError(null);
  };

  // The bar as it would read with what is typed now, in the locale being previewed.
  const footerDraft = useMemo<FooterContent>(() => {
    const raw: Record<string, unknown> = {};
    for (const g of desk?.groups ?? []) {
      if (g.group !== "footer") continue;
      for (const f of g.fields) raw[f.wire] = cellOf(f, locale);
    }
    return normalizeFooter(raw);
  }, [desk, draft, locale]);

  const signinDraft = useMemo(() => {
    const g = desk?.groups.find((x) => x.group === "signin");
    const line = (name: string, fallback: string) => {
      const f = g?.fields.find((x) => x.wire === name);
      if (!f) return fallback;
      return asText(cellOf(f, locale)).trim() || fallback;
    };
    return {
      loginSubtitle: line("loginSubtitle", "Sign in to WAISHA"),
      signupSuccessTitle: line("signupSuccessTitle", "Account successfully created"),
      signupSuccessBody: line("signupSuccessBody", "Sign in with your TIN and email to reach your workspace.")
    };
  }, [desk, draft, locale]);

  if (forbidden) {
    return (
      <div className="control-shell page-shell flex-1">
        <header className="flex flex-wrap items-center justify-between px-24 py-12"
          style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <ControlNav />
        </header>
        <main className="mx-auto max-w-[900px] px-16 py-32">
          <div className="rounded-card border p-24" style={{ borderColor: "var(--line)" }}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>These words are not yours to read</h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ") || "no platform duty"}.
              Reading the platform's copy needs the duty <code>control.view</code>; rewriting it
              needs <code> control.content.manage</code>.
            </p>
            <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const groupOf = (name: string) => desk?.groups.find((g) => g.group === name);
  const footerGroup = groupOf("footer");
  const signinGroup = groupOf("signin");

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Command center · {canManage ? "writing the platform's copy" : "read-only"}
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1240px] px-16 py-32">
        <div className="flex flex-wrap items-end justify-between gap-16">
          <div className="min-w-0">
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>The platform&apos;s own words</h1>
            <p className="mt-8 max-w-[760px] text-sm" style={{ color: "var(--ink-soft)" }}>
              The footer a caller reads out loud, the support address, the answering hours, the line
              under WAISHA on the sign-in card — all of it is stored copy, and this desk writes it.
              No deploy, and no field that a page does not read: the list below is the registry the
              renderers use, key for key.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-10">
            <div role="group" aria-label="Preview language" className="flex rounded-input border"
              style={{ borderColor: "var(--line)" }}>
              {locales.map((l) => (
                <button key={l} type="button" onClick={() => setLocale(l)} aria-pressed={l === locale}
                  className="rounded-input px-14 py-6 text-xs font-semibold"
                  style={{
                    background: l === locale ? "var(--adm-accent-soft)" : "transparent",
                    color: l === locale ? "var(--adm-accent)" : "var(--ink-soft)"
                  }}>
                  {LOCALE_LABEL[l] ?? l}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => load()}
              className="rounded-input border px-14 py-6 text-xs font-semibold"
              style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
              Re-read the copy
            </button>
          </div>
        </div>

        {loading && <p className="mt-16 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the copy…</p>}

        {/* ---------- the bar, as it reads with what is typed now ---------- */}
        {!loading && (
          <section className="mt-24">
            <div className="flex flex-wrap items-end justify-between gap-12">
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                What a caller sees, with what you have typed
              </h2>
              <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {LOCALE_LABEL[locale] ?? locale} · the weather forecast is left out of a preview
              </p>
            </div>
            <div className="footer-preview mt-12 overflow-hidden rounded-card border"
              style={{ borderColor: "var(--line)" }}>
              <FooterBar content={footerDraft} weather={false} />
            </div>
            <div className="mt-16 grid gap-16"
              style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(320px, 100%), 1fr))" }}>
              <div className="rounded-card border p-16"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: "var(--gold)" }}>
                  {signinDraft.loginSubtitle}
                </p>
                <p className="mt-10 text-sm font-semibold" style={{ color: "var(--ink)" }}>
                  {signinDraft.signupSuccessTitle}
                </p>
                <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{signinDraft.signupSuccessBody}</p>
                <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  How the sign-in card would word itself. The card carries no mark — &quot;powered
                  by&quot; is the bar&apos;s line above, said once. A seeker&apos;s &quot;search account
                  verified&quot; sentence is not here because it answers a different door, and the
                  registry has no key for it.
                </p>
              </div>
              <div className="flex flex-col justify-center gap-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>Where these words land</p>
                <span><Link href="/" className="underline" style={{ color: "var(--adm-accent)" }}>The public site</Link> — the bar under the marketing pages, mark first.</span>
                <span><Link href="/login" className="underline" style={{ color: "var(--adm-accent)" }}>The sign-in card</Link> — the subtitle and the sentence after an account is made.</span>
                <span><Link href="/app/dashboard" className="underline" style={{ color: "var(--adm-accent)" }}>The portal</Link> — the same bar, drawn inside the shell.</span>
              </div>
            </div>
          </section>
        )}

        {/* ---------- what is staged, and what stops it ---------- */}
        {canManage && !loading && (
          <section className="mt-24 rounded-card border p-18"
            style={{
              borderColor: changed.length ? "var(--adm-accent)" : "var(--line)",
              background: "var(--surface)"
            }}>
            <div className="flex flex-wrap items-end justify-between gap-14">
              <div className="min-w-[260px] flex-1">
                <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                  {changed.length
                    ? `${changed.length} line(s) waiting to be published`
                    : "Nothing waiting — what is on disk is what is typed here."}
                </p>
                {!!changed.length && (
                  <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {changed.map(c => `${c.field.label} (${LOCALE_LABEL[c.locale] ?? c.locale})`).join(" · ")}
                  </p>
                )}
                <label className="mt-12 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Why — one sentence, and it goes on the audit trail beside the new words
                  <input value={note}
                    onChange={(e) => { setNote(e.target.value); setArmed(false); }}
                    placeholder="The office answers on Saturdays now, so the bar must say so."
                    className="mt-4 w-full max-w-[560px] rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                </label>
              </div>
              <div className="flex flex-col items-end gap-8">
                <button type="button"
                  disabled={busy || !changed.length || blocked.length > 0 || note.trim().length < 4}
                  onClick={save} aria-live="polite"
                  className="rounded-input px-18 py-8 text-xs font-semibold"
                  style={armed
                    ? { background: "var(--adm-accent)", color: "#05262a", border: "1px solid var(--adm-accent)" }
                    : { background: "transparent", color: "var(--adm-accent)", border: "1px solid var(--adm-accent)" }}>
                  {armed ? `Tap again to publish ${changed.length} line(s)`
                    : busy ? "Publishing…" : `Publish ${changed.length || ""} change(s)`.replace("  ", " ")}
                </button>
                {!!changed.length && (
                  <button type="button" disabled={busy}
                    onClick={() => { if (desk) { setDraft(seedOf(desk)); setArmed(false); setNotice(null); } }}
                    className="rounded-input border px-14 py-5 text-[11px] font-semibold"
                    style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    Throw away my typing
                  </button>
                )}
              </div>
            </div>

            {(blocked.length > 0 || saveError) && (
              <ul role="alert" className="mt-14 space-y-4">
                {[...blocked, ...(saveError ? [saveError] : [])].map((p, i) => (
                  <li key={i} className="rounded-input px-12 py-8 text-xs"
                    style={{
                      background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                      borderLeft: "4px solid var(--danger)", color: "var(--ink)"
                    }}>
                    {p}
                  </li>
                ))}
              </ul>
            )}
            {changed.length > 0 && !blocked.length && note.trim().length < 4 && (
              <p className="mt-12 text-[11px]" style={{ color: "var(--warning)" }}>
                Publish stays shut until the reason box says something. This copy goes on every page
                of the system, and &quot;who changed the phone number, and when&quot; is asked eventually.
              </p>
            )}
          </section>
        )}

        {error && (
          <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="mt-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--success) 8%, transparent)", borderLeft: "4px solid var(--success)" }}>
            {notice}
          </div>
        )}
        {!canManage && !loading && (
          <p className="mt-16 text-[11px]" style={{ color: "var(--warning)" }}>
            Your seat can read this desk but not write it — <code>control.content.manage</code> is a
            separate duty, given on the staff desk.
          </p>
        )}

        {/* ---------- the registry ---------- */}
        {!loading && footerGroup && (
          <FieldGroup title="The footer" locales={locales} draft={draft}
            canManage={canManage} busy={busy} canWrite={note.trim().length >= 4}
            onPublish={publishOne} onRevert={revertOne}
            blurb="Everything the bar at the bottom of every page says, in both languages. A line
              left empty is a line the bar stops showing — that is how a sentence is retired, and it
              is not an error."
            group={footerGroup} onChange={setCell} />
        )}
        {!loading && signinGroup && (
          <FieldGroup title="Sign-in and sign-up" locales={locales} draft={draft}
            canManage={canManage} busy={busy} canWrite={note.trim().length >= 4}
            onPublish={publishOne} onRevert={revertOne}
            blurb="The card a person stands in front of before they have an account. Every word of
              it is read from this table, so this desk is the only place to change them — the page
              keeps its own wording only while the service cannot be reached."
            group={signinGroup} onChange={setCell} />
        )}

        <p className="mt-28 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          A feature switch is not offered here because nothing on the site reads the flags that are
          seeded — a switch that moves nothing is worse than no switch. Every write lands
          on <Link href="/control/forensics" className="underline" style={{ color: "var(--adm-accent)" }}>Forensics</Link>
          {" "}as <code>control.content.updated</code>, with the old value beside the new one.
        </p>
      </main>
    </div>
  );
}

function FieldGroup({ title, blurb, group, locales, draft, canManage, busy, canWrite,
  onPublish, onRevert, onChange }: {
  title: string; blurb: string; group: DeskGroup; locales: string[]; draft: Draft;
  canManage: boolean; busy: boolean; canWrite: boolean;
  onPublish: (f: DeskField, l: string, cell: Cell) => void;
  onRevert: (f: DeskField, l: string) => void;
  onChange: (key: string, locale: string, cell: Cell) => void;
}) {
  return (
    <section className="mt-28">
      <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>{title}</h2>
      <p className="mt-6 max-w-[820px] text-xs" style={{ color: "var(--ink-soft)" }}>{blurb}</p>
      <div className="mt-16 grid gap-16"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(440px, 100%), 1fr))" }}>
        {group.fields.map((f) => (
          <FieldCard key={f.key} f={f} locales={locales} draft={draft}
            canManage={canManage} busy={busy} canWrite={canWrite}
            onPublish={onPublish} onRevert={onRevert} onChange={onChange} />
        ))}
      </div>
    </section>
  );
}

/** One registry entry, both locales side by side, each with its own rule, its own act
 *  buttons and its own last-written caption — &quot;who changed the phone number&quot; is
 *  answered on the line, and so is the change itself. */
function FieldCard({ f, locales, draft, canManage, busy, canWrite, onPublish, onRevert, onChange }: {
  f: DeskField; locales: string[]; draft: Draft; canManage: boolean;
  busy: boolean; canWrite: boolean;
  onPublish: (f: DeskField, l: string, cell: Cell) => void;
  onRevert: (f: DeskField, l: string) => void;
  onChange: (key: string, locale: string, cell: Cell) => void;
}) {
  const dirty = locales.filter((l) =>
    canon(f.kind, draft[f.key]?.[l]) !== canon(f.kind, f.values[l] as Cell));
  return (
    <article className="rounded-card border p-18"
      style={{
        borderColor: dirty.length ? "var(--adm-accent)" : "var(--line)",
        background: "var(--surface)"
      }}>
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div className="min-w-0">
          <h3 className="text-base font-bold" style={{ color: "var(--ink)" }}>{f.label}</h3>
          <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>{f.hint}</p>
          <p className="mt-8 text-[10px]" style={{ color: "var(--adm-accent)" }}>
            <code>{f.key}</code> → <span style={{ color: "var(--ink-soft)" }}><code>{f.wire}</code></span>
            {" · "}{f.kind}
            {" · "}{isList(f.kind) ? `up to ${f.max} rows` : `${f.max} characters`}
          </p>
        </div>
        {!!dirty.length && (
          <span className="shrink-0 rounded-full px-10 py-4 text-[10px] font-bold uppercase"
            style={{ background: "color-mix(in srgb, var(--adm-accent) 18%, transparent)", color: "var(--adm-accent)" }}>
            {dirty.length} unsaved
          </span>
        )}
      </div>

      <div className="mt-14 grid gap-16" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        {locales.map((l) => {
          const cell = draft[f.key]?.[l] ?? (isList(f.kind) ? [] : "");
          const bad = problems(f, cell);
          const edit = f.edited[l];
          const written = when(edit?.at ?? null);
          const isDirty = dirty.includes(l);
          const stored = isList(f.kind)
            ? asRows(f.values[l] as Cell).length > 0
            : asText(f.values[l] as Cell).trim() !== "";
          const typed = isList(f.kind)
            ? asRows(cell).length > 0
            : asText(cell).trim() !== "";
          return (
            <div key={l} className="rounded-input border p-12" style={{ borderColor: "var(--line)" }}>
              <div className="flex flex-wrap items-center justify-between gap-6">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em]"
                  style={{ color: "var(--adm-accent)" }}>{LOCALE_LABEL[l] ?? l}</p>
                <p className="text-[10px]" style={{ color: "var(--ink-soft)" }} title={written ?? "never written"}>
                  {edit?.by ? `last by ${edit.by}` : "last by the seed"}
                  {" · "}{written ?? "never written"}
                </p>
              </div>
              <Editor f={f} locale={l} cell={cell} canManage={canManage} onChange={onChange} />
              <p className="mt-6 text-[10px]" style={{ color: bad.length ? "var(--danger)" : "var(--ink-soft)" }}>
                {isList(f.kind)
                  ? `${asRows(cell).length} of ${f.max} rows · empty means the bar shows none`
                  : `${asText(cell).length} of ${f.max} characters · empty means the page hides this`}
              </p>
              {bad.length > 0 && (
                <ul className="mt-8 space-y-3">
                  {bad.map((p, i) => (
                    <li key={i} className="text-[11px]" style={{ color: "var(--danger)" }}>{p}</li>
                  ))}
                </ul>
              )}

              {/* The line acts where it is written. One PUT carries only this key and this
                  language, so a half-typed link elsewhere on the desk cannot hold it back —
                  and the audit reason the whole-desk publish demands is demanded here too,
                  through the button's disabled state. */}
              {canManage && (isDirty || stored) && (
                <div className="mt-10 flex flex-wrap items-center gap-8">
                  {isDirty && (
                    <button type="button" disabled={busy || bad.length > 0 || !canWrite}
                      onClick={() => onPublish(f, l, cell)}
                      aria-label={`Publish ${f.label} in ${LOCALE_LABEL[l] ?? l}`}
                      title={bad.length ? "This line has a problem to fix first"
                        : !canWrite ? "Say why in the reason box above first"
                          : "Write just this line, now"}
                      className="min-h-[34px] rounded-input px-12 py-5 text-[11px] font-semibold"
                      style={{
                        background: "var(--adm-accent)", color: "#05262a",
                        border: "1px solid var(--adm-accent)", opacity: busy || bad.length || !canWrite ? 0.45 : 1
                      }}>
                      {busy ? "Publishing…" : "Update"}
                    </button>
                  )}
                  {isDirty && (
                    <button type="button" disabled={busy} onClick={() => onRevert(f, l)}
                      aria-label={`Discard my typing in ${f.label}, ${LOCALE_LABEL[l] ?? l}`}
                      title="Put back what is on the bar now, without writing anything"
                      className="min-h-[34px] rounded-input border px-12 py-5 text-[11px] font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      Revert
                    </button>
                  )}
                  {stored && typed && (
                    <button type="button" disabled={busy || !canWrite}
                      onClick={() => onPublish(f, l, isList(f.kind) ? [] : "")}
                      aria-label={`Retire ${f.label} in ${LOCALE_LABEL[l] ?? l}`}
                      title={canWrite
                        ? "Publish this line empty — the bar stops showing it. The row stays, so it can be said again."
                        : "Say why in the reason box above first"}
                      className="min-h-[34px] rounded-input border px-12 py-5 text-[11px] font-semibold"
                      style={{
                        borderColor: "var(--danger)", color: "var(--danger)",
                        opacity: busy || !canWrite ? 0.45 : 1
                      }}>
                      Retire
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </article>
  );
}

/** The input for one locale of one field. `max` means characters on a text block and rows on a
 *  list block, which is why the two list kinds get a repeater instead of a box. */
function Editor({ f, locale, cell, canManage, onChange }: {
  f: DeskField; locale: string; cell: Cell; canManage: boolean;
  onChange: (key: string, locale: string, cell: Cell) => void;
}) {
  const box = "mt-8 w-full rounded-input border px-10 py-6 text-sm";
  const style = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" };
  const put = (v: Cell) => onChange(f.key, locale, v);

  if (f.kind === "multiline") {
    return (
      <textarea rows={3} value={asText(cell)} readOnly={!canManage} maxLength={f.max}
        onChange={(e) => put(e.target.value)} placeholder="(empty — the page hides this line)"
        className={box} style={style} />
    );
  }

  if (isList(f.kind)) {
    const rows = asRows(cell);
    const patch = (i: number, next: Record<string, unknown>) =>
      put(rows.map((r, k) => (k === i ? { ...r, ...next } : r)) as Cell);
    const drop = (i: number) => put(rows.filter((_, k) => k !== i) as Cell);
    const add = () => put([...rows, f.kind === "links"
      ? { label: "", href: "" } : { network: "whatsapp", handle: "", href: "" }] as Cell);
    return (
      <div className="mt-8">
        {rows.map((r, i) => (
          <div key={`${locale}-${i}`} className="mb-8 rounded-input border p-8"
            style={{ borderColor: "var(--line)" }}>
            <div className="flex items-center gap-6">
              <span className="text-[10px] font-bold tabular-nums" style={{ color: "var(--ink-soft)" }}>{i + 1}</span>
              {f.kind === "social" && (
                <select value={r.network ?? ""} disabled={!canManage}
                  onChange={(e) => patch(i, { network: e.target.value })}
                  className="rounded-input border px-8 py-4 text-[11px]" style={style}>
                  {NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              )}
              <input value={f.kind === "links" ? (r.label ?? "") : (r.handle ?? "")}
                readOnly={!canManage} maxLength={f.kind === "links" ? 40 : 60}
                onChange={(e) => patch(i, f.kind === "links" ? { label: e.target.value } : { handle: e.target.value })}
                placeholder={f.kind === "links" ? "Words on the bar" : "@handle"}
                aria-label={`${f.label} ${LOCALE_LABEL[locale] ?? locale} row ${i + 1} ${f.kind === "links" ? "label" : "handle"}`}
                className="min-w-0 flex-1 rounded-input border px-8 py-4 text-[11px]" style={style} />
              {canManage && (
                <button type="button" onClick={() => drop(i)} title="Take this row off the bar"
                  className="rounded-input border px-8 py-4 text-[10px] font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--danger)" }}>Remove</button>
              )}
            </div>
            <input value={r.href ?? ""} readOnly={!canManage} maxLength={300}
              onChange={(e) => patch(i, { href: e.target.value })}
              placeholder="https://example.co.tz · mailto:… · tel:+255…"
              aria-label={`${f.label} ${LOCALE_LABEL[locale] ?? locale} row ${i + 1} address`}
              className="mt-6 w-full rounded-input border px-8 py-4 text-[11px]" style={style} />
            {f.kind === "social" && (
              <p className="mt-6 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                The handle is shown next to the mark; the address is what the mark opens.
              </p>
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <p className="mb-8 mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            No rows — the bar shows none of these.
          </p>
        )}
        {canManage && (
          <button type="button" onClick={add} disabled={rows.length >= f.max}
            className="min-h-[36px] rounded-input border px-10 py-4 text-[11px] font-semibold"
            style={{
              borderColor: "var(--line)", color: "var(--adm-accent)",
              opacity: rows.length >= f.max ? 0.5 : 1
            }}>
            {f.kind === "links" ? "Add a link" : "Add a profile"} ({rows.length}/{f.max})
          </button>
        )}
      </div>
    );
  }

  return (
    <input type={f.kind === "email" ? "email" : "text"} value={asText(cell)}
      readOnly={!canManage} maxLength={f.max} onChange={(e) => put(e.target.value)}
      placeholder={f.kind === "e164" ? "+255717601440" : "(empty — the page hides this line)"}
      aria-label={`${f.label} — ${LOCALE_LABEL[locale] ?? locale}`}
      className={box} style={style} />
  );
}

