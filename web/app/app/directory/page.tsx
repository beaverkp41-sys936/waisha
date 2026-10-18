"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck, Building2, CalendarClock, Eye, Globe, MapPin, MousePointerClick,
  ShieldAlert, Truck
} from "lucide-react";
import { apiFetch } from "../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? x.reason ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

type Listing = {
  id: string; serves: string[]; company_name: string; headline: string | null;
  description: string | null; services_offered: string | null; corridors_served: string | null;
  home_base: string | null; website: string | null; fleet_size_declared: number | null;
  year_established: number | null; licence_valid_to: string | null; contact_name: string;
  contact_channel: string; status: "draft" | "live" | "suspended";
  suspension_reason: string | null; is_verified: boolean;
  published_at: string | null; updated_at: string;
};

type Payload = {
  listing: Listing | null;
  regions: { region_id: number; name_en: string }[];
  stats: {
    listed: boolean; card_opens?: number; last_open_at?: string | null;
    is_verified?: boolean; published_at?: string | null;
  } | null;
  suggestions: {
    company_name?: string | null; description?: string | null;
    services_offered?: string | null; corridors_served?: string | null;
    website?: string | null; fleet_size_declared?: number | null;
    year_established?: number | null; licence_valid_to?: string | null;
  } | null;
  canManage: boolean;
};

type GeoRegion = { id: number; code: string; name_en: string };

/** The body the 061 editor writes. Blank optional fields are omitted, never "" —
 *  the column CHECKs demand a length once a value exists. */
type Form = {
  serves: string[]; companyName: string; headline: string; description: string;
  servicesOffered: string; corridorsServed: string; homeBase: string; website: string;
  fleetSizeDeclared: string; yearEstablished: string; contactName: string;
  contactChannel: string; regionIds: number[];
};

const EMPTY: Form = {
  serves: ["transporter"], companyName: "", headline: "", description: "",
  servicesOffered: "", corridorsServed: "", homeBase: "", website: "",
  fleetSizeDeclared: "", yearEstablished: "", contactName: "", contactChannel: "",
  regionIds: []
};

const LABEL = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const INPUT = "waisha-input w-full rounded-input border px-12 py-8 text-sm";
const INPUT_STYLE = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" };
const CARD = "rounded-card border bg-surface p-24";
const CARD_STYLE = { borderColor: "var(--line)" };

/** The same three states the seeker's card is given, derived from the copied date
 *  rather than a flag frozen at publish time. */
function licenceState(iso: string | null | undefined): { label: string; tone: string } {
  if (!iso) return { label: "Not declared", tone: "var(--ink-soft)" };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expiry = new Date(iso.slice(0, 10) + "T00:00:00");
  if (Number.isNaN(expiry.getTime())) return { label: "Not declared", tone: "var(--ink-soft)" };
  const days = Math.round((expiry.getTime() - today.getTime()) / 86400000);
  if (days < 0) return { label: `Licence lapsed ${-days} d ago`, tone: "var(--danger)" };
  if (days < 60) return { label: `Licence expires in ${days} d`, tone: "var(--warning)" };
  return { label: `Licence valid to ${expiry.toLocaleDateString("en-GB")}`, tone: "var(--success)" };
}

function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

function Field(props: {
  label: string; hint?: string; value: string; onValue: (v: string) => void;
  disabled?: boolean; [key: string]: any;
}) {
  const { label, hint, value, onValue, disabled, ...rest } = props;
  return (
    <label className="block">
      <span className={LABEL} style={{ color: "var(--ink-soft)" }}>{label}</span>
      <input disabled={disabled} value={value} onChange={e => onValue(e.target.value)}
        className={INPUT} style={INPUT_STYLE} {...rest} />
      {hint && <span className="mt-4 block text-[11px] leading-relaxed"
        style={{ color: "var(--ink-soft)" }}>{hint}</span>}
    </label>
  );
}

function Area(props: {
  label: string; hint?: string; rows: number; value: string;
  onValue: (v: string) => void; disabled?: boolean; max: number;
}) {
  const left = props.max - (props.value?.length ?? 0);
  return (
    <label className="block">
      <span className={LABEL} style={{ color: "var(--ink-soft)" }}>{props.label}</span>
      <textarea rows={props.rows} maxLength={props.max} disabled={props.disabled}
        value={props.value} onChange={e => props.onValue(e.target.value)}
        className={INPUT} style={INPUT_STYLE} />
      <span className="mt-4 flex items-baseline justify-between gap-8">
        {props.hint
          ? <span className="text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>{props.hint}</span>
          : <span />}
        <span className="text-[10px] tabular-nums"
          style={{ color: left < 60 ? "var(--warning)" : "var(--ink-soft)" }}>{left} left</span>
      </span>
    </label>
  );
}

export default function CompanyDirectoryPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [geo, setGeo] = useState<GeoRegion[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [armed, setArmed] = useState<"" | "publish" | "withdraw">("");
  const [preview, setPreview] = useState(false);

  const load = useCallback(async () => {
    try {
      const [l, g] = await Promise.all([apiFetch("/directory/listing"), apiFetch("/geo/regions")]);
      if (!l.ok) { setError(errorText(await l.json(), "The directory did not answer.")); return; }
      const payload: Payload = await l.json();
      setData(payload);
      if (g.ok) setGeo(await g.json());

      const s = payload.suggestions ?? {};
      const x = payload.listing;
      setForm(x ? {
        serves: x.serves, companyName: x.company_name, headline: x.headline ?? "",
        description: x.description ?? "", servicesOffered: x.services_offered ?? "",
        corridorsServed: x.corridors_served ?? "", homeBase: x.home_base ?? "",
        website: x.website ?? "", fleetSizeDeclared: String(x.fleet_size_declared ?? ""),
        yearEstablished: String(x.year_established ?? ""), contactName: x.contact_name,
        contactChannel: x.contact_channel,
        regionIds: payload.regions.map(r => r.region_id)
      } : {
        ...EMPTY,
        companyName: s.company_name ?? "", description: s.description ?? "",
        servicesOffered: s.services_offered ?? "", corridorsServed: s.corridors_served ?? "",
        website: s.website ?? "", fleetSizeDeclared: String(s.fleet_size_declared ?? ""),
        yearEstablished: String(s.year_established ?? "")
      });
    } catch (e: any) {
      if (e.message !== "session ended") setError(e.message);
    } finally { setReady(true); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (k: keyof Form, v: any) => {
    setForm(f => ({ ...f, [k]: v }));
    setNotice(null); setArmed("");
  };
  const toggleServe = (kind: string) => set("serves",
    form.serves.includes(kind)
      ? form.serves.filter(k => k !== kind)
      : [...form.serves, kind].slice(0, 2));
  const toggleRegion = (id: number) => set("regionIds",
    form.regionIds.includes(id)
      ? form.regionIds.filter(r => r !== id)
      : form.regionIds.length >= 31 ? form.regionIds : [...form.regionIds, id]);

  const listing = data?.listing ?? null;
  const status = listing?.status ?? "draft";
  const canManage = data?.canManage ?? false;
  const licence = useMemo(() => licenceState(
    listing?.licence_valid_to ?? data?.suggestions?.licence_valid_to), [listing, data]);
  const regionNames = useMemo(() => {
    const byId = new Map(geo.map(g => [g.id, g.name_en]));
    return form.regionIds.map(id => byId.get(id) ?? `#${id}`);
  }, [form.regionIds, geo]);

  async function send(path: string, init: RequestInit, onOk: (j: any) => void, words: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(path, init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(json, words)); return; }
      onOk(json);
      await load();
    } finally { setBusy(false); setArmed(""); }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const blank = (v: string) => (v.trim() ? v.trim() : undefined);
    return send("/directory/listing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serves: form.serves, companyName: form.companyName.trim(),
        headline: blank(form.headline), description: blank(form.description),
        servicesOffered: blank(form.servicesOffered),
        corridorsServed: blank(form.corridorsServed), homeBase: blank(form.homeBase),
        website: blank(form.website),
        fleetSizeDeclared: form.fleetSizeDeclared ? Number(form.fleetSizeDeclared) : undefined,
        yearEstablished: form.yearEstablished ? Number(form.yearEstablished) : undefined,
        contactName: form.contactName.trim(), contactChannel: form.contactChannel.trim(),
        regionIds: form.regionIds
      })
    }, () => setNotice("Saved. The board still shows what was published until you publish again."),
      "Could not save the listing.");
  }

  const publish = () => send("/directory/listing/publish", { method: "POST" },
    () => setNotice("You are on the board. Seekers searching this week can find you."),
    "Could not publish the listing.");
  const withdraw = () => send("/directory/listing/withdraw", { method: "POST" },
    () => setNotice("Withdrawn. Your listing is hidden and nothing about it was deleted."),
    "Could not withdraw the listing.");

  const arm = (what: "publish" | "withdraw") => {
    if (armed === what) { what === "publish" ? publish() : withdraw(); return; }
    setArmed(what);
    setError(null);
    setNotice(null);
  };

  const dirty = useMemo(() => {
    if (!listing) return form.companyName !== "" || form.serves.length > 1;
    return form.companyName !== listing.company_name
      || form.headline !== (listing.headline ?? "")
      || form.description !== (listing.description ?? "")
      || form.servicesOffered !== (listing.services_offered ?? "")
      || form.corridorsServed !== (listing.corridors_served ?? "")
      || form.homeBase !== (listing.home_base ?? "")
      || form.website !== (listing.website ?? "")
      || form.fleetSizeDeclared !== String(listing.fleet_size_declared ?? "")
      || form.yearEstablished !== String(listing.year_established ?? "")
      || form.contactName !== listing.contact_name
      || form.contactChannel !== listing.contact_channel
      || form.serves.join() !== listing.serves.join()
      || form.regionIds.join() !== (data?.regions ?? []).map(r => r.region_id).join();
  }, [form, listing, data]);

  const ro = !canManage || busy;

  return (
    <div className="mx-auto max-w-[1040px] px-16 py-32">
      <div className="flex flex-wrap items-start justify-between gap-16">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Company directory</h1>
          <p className="mt-8 max-w-[620px] text-sm leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            The card a transporter or clearing agent finds when looking for someone to move or clear
            their cargo. This is a published <b style={{ color: "var(--ink)" }}>copy</b> — your licence
            number, clients, prices and documents never leave this account.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-8">
          {status === "live" && (
            <span className="badge badge-verified"><BadgeCheck aria-hidden />On the board</span>
          )}
          {status === "draft" && (
            <span className="badge badge-plain"><Building2 aria-hidden />Not published</span>
          )}
          {status === "suspended" && (
            <span className="badge badge-plain" style={{ borderColor: "var(--danger)" }}>
              <ShieldAlert aria-hidden />Suspended
            </span>
          )}
          {listing?.is_verified && (
            <span className="badge badge-trial"><BadgeCheck aria-hidden />WAISHA verified</span>
          )}
          {ready && (
            <button type="button" onClick={() => setPreview(p => !p)}
              className={"on-photo-btn" + (preview ? " is-on" : "")}>
              <Eye aria-hidden />{preview ? "Back to the form" : "Preview as a seeker"}
            </button>
          )}
        </div>
      </div>

      {error && <div role="alert" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {status === "suspended" && listing?.suspension_reason && (
        <div className="mt-16 rounded-card border p-16 text-sm"
          style={{ borderColor: "var(--danger)", background: "color-mix(in srgb, var(--danger) 6%, var(--surface))", color: "var(--ink)" }}>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--danger)" }}>
            Why WAISHA suspended this listing
          </p>
          <p className="mt-6 leading-relaxed">{listing.suspension_reason}</p>
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            You can keep editing while suspended, but only the office can put a listing back on the board.
          </p>
        </div>
      )}

      {!ready ? (
        <p className="pane-note mt-32 text-sm">Loading the directory…</p>
      ) : preview ? (
        <section className={`${CARD} mt-24`} style={{
          borderColor: "var(--gold)",
          background: "color-mix(in srgb, var(--gold) 12%, var(--surface))"
        }}>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            Exactly what a seeker sees on the search results and the card
          </p>
          <div className="mt-12 flex flex-wrap items-center gap-8">
            <p className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              {form.companyName || "Your company name"}
            </p>
            {form.serves.includes("transporter") && <span className="chip"><Truck aria-hidden />Transport</span>}
            {form.serves.includes("cfa") && <span className="chip"><Globe aria-hidden />Clearing</span>}
            {listing?.is_verified && <span className="badge badge-verified"><BadgeCheck aria-hidden />Verified</span>}
          </div>
          {form.headline && (
            <p className="mt-10 text-sm font-semibold" style={{ color: "var(--ink)" }}>{form.headline}</p>
          )}
          <p className="mt-10 text-sm leading-relaxed" style={{ color: "var(--ink)" }}>
            {form.description || "No description yet — a seeker scrolling the board sees an empty card and moves on."}
          </p>
          <dl className="kv mt-16">
            <dt>Services</dt><dd>{form.servicesOffered || "—"}</dd>
            <dt>Corridors</dt><dd>{form.corridorsServed || "—"}</dd>
            <dt>Regions</dt><dd>{regionNames.length ? regionNames.join(", ") : "—"}</dd>
            <dt>Based in</dt><dd>{form.homeBase || "—"}</dd>
            <dt>Fleet</dt><dd>{form.fleetSizeDeclared ? `${form.fleetSizeDeclared} declared` : "—"}</dd>
            <dt>Established</dt><dd>{form.yearEstablished || "—"}</dd>
            <dt>Licence</dt><dd style={{ color: licence.tone }}>{licence.label}</dd>
            <dt>Contact</dt><dd>{form.contactName || "—"} · {form.contactChannel || "—"}</dd>
            {form.website && <><dt>Website</dt><dd>{form.website}</dd></>}
          </dl>
          <p className="mt-14 text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            A seeker reaches you through the one channel above and nothing else. Your staff list, sealed
            phone numbers, NIDA and BRELA numbers, client names, invoices and documents stay private.
          </p>
        </section>
      ) : (
        <form onSubmit={save} className="pv-grid mt-24 rounded-card border bg-surface p-24"
          style={CARD_STYLE}>
          <div>
            <div className="pv-block">
              <p className="pv-title"><Globe aria-hidden />What seekers are looking for</p>
              <div className="flex flex-wrap gap-12">
                {[
                  { key: "transporter", label: "We carry freight", icon: Truck },
                  { key: "cfa", label: "We clear it through customs", icon: Globe }
                ].map(o => {
                  const on = form.serves.includes(o.key);
                  return (
                    <button key={o.key} type="button" disabled={ro} onClick={() => toggleServe(o.key)}
                      aria-pressed={on}
                      className="flex items-center gap-8 rounded-input border px-12 py-8 text-xs font-semibold"
                      style={{
                        borderColor: on ? "var(--gold)" : "var(--line)",
                        background: on ? "color-mix(in srgb, var(--gold) 16%, var(--milk))" : "var(--milk)",
                        color: "var(--ink)"
                      }}>
                      <o.icon aria-hidden style={{ width: 14, height: 14 }} />{o.label}
                    </button>
                  );
                })}
              </div>
              {!form.serves.length && (
                <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>
                  Pick at least one — a listing that serves nothing cannot be published.
                </p>
              )}
              <p className="mt-8 text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                Declared here, not derived from your account type: a company that both carries and clears
                appears in both searches.
              </p>
            </div>

            <div className="pv-block">
              <p className="pv-title"><Building2 aria-hidden />The card</p>
              <Field label="Company name as it appears *" disabled={ro} required maxLength={200}
                value={form.companyName} onValue={v => set("companyName", v)} />
              <div className="mt-12">
                <Field label="Headline" disabled={ro} maxLength={140}
                  placeholder="One line a seeker reads before the description"
                  hint="6–140 characters. What you are best at, said plainly."
                  value={form.headline} onValue={v => set("headline", v)} />
              </div>
              <div className="mt-12">
                <Area label="About the company" disabled={ro} rows={5} max={1200}
                  hint="What you move or clear, where, and why clients trust you."
                  value={form.description} onValue={v => set("description", v)} />
              </div>
              <div className="mt-12 grid gap-12 sm:grid-cols-2">
                <Field label="Services" disabled={ro} maxLength={200}
                  placeholder="General cargo, Refrigerated, Bonded warehousing"
                  value={form.servicesOffered} onValue={v => set("servicesOffered", v)} />
                <Field label="Corridors" disabled={ro} maxLength={200}
                  placeholder="Dar es Salaam – Kigali, Central Corridor"
                  value={form.corridorsServed} onValue={v => set("corridorsServed", v)} />
              </div>
              <div className="mt-12 grid gap-12 sm:grid-cols-3">
                <Field label="Home base" disabled={ro} maxLength={200} placeholder="Dar es Salaam"
                  value={form.homeBase} onValue={v => set("homeBase", v)} />
                <Field label="Website" disabled={ro} maxLength={300} placeholder="https://"
                  value={form.website} onValue={v => set("website", v)} />
                <Field label="Established" disabled={ro} type="number" min={1900} max={2100}
                  value={form.yearEstablished} onValue={v => set("yearEstablished", v)} />
              </div>
              <div className="mt-12">
                <Field label="Fleet size you declare" disabled={ro} type="number" min={0} max={20000}
                  hint="A number you choose to say out loud. WAISHA never counts your trucks for you."
                  value={form.fleetSizeDeclared} onValue={v => set("fleetSizeDeclared", v)} />
              </div>
            </div>

            <div className="pv-block">
              <p className="pv-title"><MapPin aria-hidden />Regions you work in</p>
              <div className="flex flex-wrap gap-8">
                {geo.map(g => {
                  const on = form.regionIds.includes(g.id);
                  return (
                    <button key={g.id} type="button" disabled={ro} aria-pressed={on}
                      onClick={() => toggleRegion(g.id)}
                      className="rounded-input border px-10 py-6 text-[11px] font-semibold"
                      style={{
                        borderColor: on ? "var(--gold)" : "var(--line)",
                        background: on ? "color-mix(in srgb, var(--gold) 16%, var(--milk))" : "var(--milk)",
                        color: "var(--ink)"
                      }}>
                      {g.name_en}
                    </button>
                  );
                })}
              </div>
              <p className="mt-10 text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                {form.regionIds.length} of {geo.length} selected — a seeker filtering by region only finds
                you if you pick it.
              </p>
            </div>

            <div className="pv-block">
              <p className="pv-title"><MousePointerClick aria-hidden />The one contact seekers get</p>
              <div className="grid gap-12 sm:grid-cols-2">
                <Field label="Contact name *" disabled={ro} required maxLength={120}
                  value={form.contactName} onValue={v => set("contactName", v)} />
                <Field label="Channel *" disabled={ro} required maxLength={160}
                  placeholder="+255 7xx xxx xxx, or a desk email"
                  value={form.contactChannel} onValue={v => set("contactChannel", v)} />
              </div>
              <p className="mt-8 text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                Type the line you want the public to use. It is published exactly as written and is never
                copied from a staff member&apos;s sealed phone number.
              </p>
            </div>
          </div>

          <div>
            <div className="pv-block">
              <p className="pv-title">Board state</p>
              <p className="mt-8 text-sm font-bold" style={{ color: "var(--ink)" }}>
                {status === "live" ? "Published" : status === "suspended" ? "Suspended by WAISHA" : "Draft"}
              </p>
              <dl className="kv mt-12">
                <dt>Published</dt><dd>{listing?.published_at ? new Date(listing.published_at).toLocaleDateString("en-GB") : "never"}</dd>
                <dt>Last saved</dt><dd>{listing?.updated_at ? ago(listing.updated_at) : "never"}</dd>
                <dt>Licence</dt><dd style={{ color: licence.tone }}>{licence.label}</dd>
              </dl>
              <p className="mt-10 text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                The date is copied from your profile on every save, so a renewal reaches the board without
                you retyping it. The licence number itself is never published.
              </p>

              {!canManage && (
                <p className="mt-14 text-[11px] leading-relaxed" style={{ color: "var(--warning)" }}>
                  Your role can read the listing but not change it — only a director can publish on the
                  company&apos;s behalf.
                </p>
              )}

              {canManage && (
                <>
                  <button type="submit" disabled={busy || !form.companyName.trim()}
                    className="waisha-btn mt-14 w-full rounded-input px-16 py-8 text-xs font-semibold">
                    {dirty ? "Save changes" : "Saved"}
                  </button>
                  {status !== "live" ? (
                    <button type="button" disabled={busy || !listing || !form.serves.length}
                      onClick={() => arm("publish")}
                      className="mt-10 w-full rounded-input border px-16 py-8 text-xs font-semibold"
                      style={{
                        borderColor: armed === "publish" ? "var(--success)" : "var(--line)",
                        background: armed === "publish"
                          ? "color-mix(in srgb, var(--success) 14%, transparent)" : "transparent",
                        color: "var(--ink)"
                      }}>
                      {armed === "publish" ? "Tap again to go live" : "Publish to the board"}
                    </button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => arm("withdraw")}
                      className="mt-10 w-full rounded-input border px-16 py-8 text-xs font-semibold"
                      style={{
                        borderColor: armed === "withdraw" ? "var(--danger)" : "var(--line)",
                        background: armed === "withdraw"
                          ? "color-mix(in srgb, var(--danger) 10%, transparent)" : "transparent",
                        color: "var(--ink)"
                      }}>
                      {armed === "withdraw" ? "Tap again to hide the card" : "Withdraw from the board"}
                    </button>
                  )}
                  {!listing && (
                    <p className="mt-8 text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                      Save first — publishing opens whatever is saved, not whatever is typed here.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="pv-block">
              <p className="pv-title">Demand for your card</p>
              <p className="mt-8 text-3xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                {data?.stats?.listed ? data.stats.card_opens ?? 0 : 0}
              </p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                times seekers opened it
              </p>
              <dl className="kv mt-12">
                <dt>Last opened</dt><dd>{ago(data?.stats?.last_open_at)}</dd>
                <dt>Verified</dt><dd>{listing?.is_verified ? "Yes — checked by WAISHA" : "Not yet"}</dd>
              </dl>
              <p className="mt-10 text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                Only your own card&apos;s opens are counted here. Who searched, what they typed and what
                else they looked at stays theirs — the platform does not hand out a lead list.
              </p>
            </div>

            <div className="pv-block">
              <p className="pv-title">Before you publish</p>
              <ul className="mt-10 space-y-8 text-xs leading-relaxed" style={{ color: "var(--ink)" }}>
                {[
                  "Anything written here is public to every company on WAISHA.",
                  "A suspended listing stays out of the board until the office reviews it.",
                  "Withdrawing hides the card and keeps its moderation history — nothing is deleted.",
                  "Seekers pay one search to reach you; the count above is that many genuine looks."
                ].map(line => (
                  <li key={line} className="flex gap-8">
                    <span aria-hidden className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full"
                      style={{ background: "var(--gold)" }} />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-12 flex items-center gap-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                <CalendarClock aria-hidden style={{ width: 12, height: 12 }} />
                Your own profile, clients and invoices are at Profile and the CFO hub — this page publishes none of them.
              </p>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
