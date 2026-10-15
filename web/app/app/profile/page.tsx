"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Building2, CalendarClock, Check, CircleDashed, ExternalLink, FileText, Globe,
  IdCard, MapPin, Phone, Plane, Route, ShieldCheck, Ship, Truck, Users, Wallet
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { apiFetch } from "../api-client";
import { ProgressRing } from "@/components/ProgressRing";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LABEL_CLS = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const INPUT_CLS = "waisha-input w-full rounded-input border px-12 py-8 text-sm";
const INPUT_STYLE = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" };
const READ_STYLE = { ...INPUT_STYLE, opacity: 0.7, cursor: "not-allowed" };

/** The seven fields the dashboard meter tracks — one source of truth here too. */
const PROFILE_FIELDS: { key: string; label: string }[] = [
  { key: "company_name", label: "Company name" },
  { key: "brela_number", label: "BRELA registration number" },
  { key: "transport_licence_no", label: "Transport licence number" },
  { key: "transport_licence_expiry", label: "Licence expiry date" },
  { key: "services_offered", label: "Services offered" },
  { key: "corridors_served", label: "Corridors served" },
  { key: "description", label: "Company description" }
];

const TABS = [
  { key: "overview", label: "Overview", icon: Building2 },
  { key: "documents", label: "Documents", icon: FileText },
  { key: "fleet", label: "Fleet & coverage", icon: Truck },
  { key: "contacts", label: "Contacts", icon: Users }
] as const;

type TabKey = (typeof TABS)[number]["key"];

/** Road / sea / air — the three modes a shipper reads a transporter by. */
function serviceIcon(service: string): LucideIcon {
  const t = service.toLowerCase();
  if (/(air|flight|aircraft)/.test(t)) return Plane;
  if (/(ship|vessel|lake|maritime|sea|boat|ferry|barge)/.test(t)) return Ship;
  return Truck;
}

function list(value: string | null | undefined): string[] {
  return (value ?? "").split(/[,\n;·|]+/).map(s => s.trim()).filter(Boolean);
}

function Note({ text }: { text: string }) {
  return <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{text}</p>;
}

function BlockTitle({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <p className="pv-title"><Icon aria-hidden />{children}</p>
  );
}

/** Module-level so the element type stays stable and a keystroke never remounts it. */
function Field(props: {
  label: string; value: any; onValue: (v: string) => void; editing: boolean;
  [key: string]: any;
}) {
  const { label, value, onValue, editing, ...rest } = props;
  return (
    <label className="block">
      <span className={LABEL_CLS} style={{ color: "var(--ink-soft)" }}>{label}</span>
      <input disabled={!editing} value={value ?? ""} onChange={e => onValue(e.target.value)}
        className={INPUT_CLS} style={editing ? INPUT_STYLE : READ_STYLE} {...rest} />
    </label>
  );
}

function Chips({ items, icon, empty }: { items: string[]; icon?: LucideIcon; empty: string }) {
  if (items.length === 0) return <Note text={empty} />;
  return (
    <div>
      {items.map(s => {
        const Icon = icon ?? serviceIcon(s);
        return <span key={s} className="chip"><Icon aria-hidden />{s}</span>;
      })}
    </div>
  );
}

export default function ProfilePage() {
  const [form, setForm] = useState<any>(null);
  const [original, setOriginal] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isNew, setIsNew] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [branches, setBranches] = useState<any[]>([]);
  const [vessels, setVessels] = useState<any[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);
  const [licence, setLicence] = useState<any>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const [preview, setPreview] = useState(false);

  const loadLogo = useCallback(async () => {
    const res = await apiFetch("/documents/tenant-logo/url");
    if (res.ok) { const j = await res.json(); setLogoUrl(j.url); }
    else setLogoUrl(null);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch("/profile");
        if (res.ok) {
          const data = await res.json();
          setForm(data);
          setOriginal(data);
          setIsNew(data.isNew === true);
        } else setError("Could not load profile.");
        const [b, v, r, l] = await Promise.all([
          apiFetch("/branches"), apiFetch("/vessels"),
          apiFetch("/routes"), apiFetch("/licence")
        ]);
        if (b.ok) setBranches(await b.json());
        if (v.ok) { const j = await v.json(); setVessels(j.vessels ?? []); }
        if (r.ok) setRoutes(await r.json());
        if (l.ok) setLicence(await l.json());
      } catch (e: any) {
        if (e.message !== "session ended") setError(e.message);
      }
    })();
    loadLogo();
  }, [loadLogo]);

  async function uploadLogo(file: File) {
    setError(null); setLogoBusy(true);
    try {
      if (file.size > MAX_LOGO_BYTES) { setError("Logo must be 2 MB or smaller."); return; }
      const fd = new FormData();
      fd.append("entityType", "tenant");
      fd.append("kind", "logo");
      fd.append("file", file);
      const res = await apiFetch("/documents", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Logo upload failed")); return; }
      setSaved(false);
      await loadLogo();
    } finally { setLogoBusy(false); }
  }

  function set(k: string, v: any) { setForm((f: any) => ({ ...f, [k]: v })); }
  const F = (k: string) => form?.[k] ?? "";

  function beginEdit() { setEditing(true); setConfirming(false); setError(null); setPreview(false); }
  function cancelEdit() { if (original) setForm(original); setEditing(false); setConfirming(false); setError(null); }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      const res = await apiFetch("/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: form.company_name,
          brelaNumber: form.brela_number || undefined,
          vatNumber: form.vat_number || undefined,
          transportLicenceNo: form.transport_licence_no || undefined,
          transportLicenceExpiry: form.transport_licence_expiry
            ? String(form.transport_licence_expiry).slice(0, 10)
            : undefined,
          yearEstablished: form.year_established ? Number(form.year_established) : undefined,
          fleetSizeDeclared: form.fleet_size_declared ? Number(form.fleet_size_declared) : undefined,
          servicesOffered: form.services_offered || undefined,
          corridorsServed: form.corridors_served || undefined,
          description: form.description || undefined,
          website: form.website
            ? (form.website.startsWith("http://") || form.website.startsWith("https://")
                ? form.website
                : `https://${form.website}`)
            : undefined,
          payBankName: form.pay_bank_name || null,
          payBankAccount: form.pay_bank_account || null,
          payAccountName: form.pay_account_name || null,
          payMobileMoney: form.pay_mobile_money || null,
          companyCode: form.company_code || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Save failed")); return; }
      setIsNew(false);
      setOriginal(form);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
      setEditing(false); setConfirming(false);
    } catch (e: any) {
      if (e.message !== "session ended") setError(e.message);
    } finally { setBusy(false); }
  }

  // Skeleton mirrors the final layout — the page shell appears instantly
  if (!form) return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="animate-pulse rounded-modal" style={{ height: 208, background: "var(--milk-deep)" }} />
      <div className="mt-24 grid gap-16 lg:grid-cols-[minmax(0,65fr)_minmax(0,35fr)]">
        {[1, 2, 3, 4, 5, 6].map(n => (
          <div key={n} className="animate-pulse rounded-input" style={{ height: 44, background: "var(--milk-deep)" }} />
        ))}
      </div>
    </div>
  );

  const filled = PROFILE_FIELDS.filter(f => form[f.key]).length;
  const completion = Math.round((filled / PROFILE_FIELDS.length) * 100);
  const missing = PROFILE_FIELDS.filter(f => !form[f.key]);

  const hq = branches.find((b: any) => b.kind === "hq") ?? branches[0] ?? null;
  const city = hq ? (hq.ward || hq.district_name || hq.region_name) : null;
  const memberSince = form.created_at ? new Date(form.created_at).getFullYear() : null;
  const licenceExpiry = form.transport_licence_expiry ? String(form.transport_licence_expiry).slice(0, 10) : "";
  const licenceLapsed = licenceExpiry ? new Date(licenceExpiry).getTime() < Date.now() : false;
  const status = licence?.tenant_status;
  const services = list(form.services_offered);
  const corridors = list(form.corridors_served);
  const byType = vessels.reduce((m: Record<string, number>, v: any) => {
    const k = v.vessel_type || "other";
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

  const address = hq
    ? [hq.street, hq.ward, hq.district_name, hq.region_name, hq.postal_address].filter(Boolean).join(", ")
    : "";

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <header className="profile-head">
        <div className="profile-cover">
          <div className="min-w-0">
            <h1 className="profile-name">{form.company_name || "Your company profile"}</h1>
            <p className="app-sub">
              {isNew ? "Not published yet — this is the card shippers and the platform read about you."
                     : "This is what shippers and the platform see about your company."}
            </p>
            <div className="profile-meta">
              {status === "active" && (
                <span className="badge badge-verified"><ShieldCheck aria-hidden />Verified</span>
              )}
              {status === "trial" && (
                <span className="badge badge-trial"><ShieldCheck aria-hidden />Trial</span>
              )}
              <span className="badge badge-plain">
                <IdCard aria-hidden />
                {form.transport_licence_no
                  ? `Licence ${form.transport_licence_no}${licenceExpiry ? ` · ${licenceLapsed ? "lapsed" : "until"} ${licenceExpiry}` : ""}`
                  : "No transport licence on file"}
              </span>
              <span className="badge badge-plain">
                <MapPin aria-hidden />{city ? `${city}, Tanzania` : "Tanzania"}
              </span>
              {memberSince && (
                <span className="badge badge-plain">
                  <CalendarClock aria-hidden />Member since {memberSince}
                </span>
              )}
            </div>
          </div>
          <div className="profile-actions no-print">
            {!editing && (
              <button type="button" onClick={beginEdit}
                className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                Edit profile
              </button>
            )}
            <button type="button" onClick={() => setPreview(p => !p)} className="on-photo-btn">
              {preview ? "Back to profile" : "Preview as shipper"}
            </button>
          </div>
        </div>

        <span className="profile-avatar">
          {logoUrl ? <img src={logoUrl} alt="Company logo" /> : <Building2 aria-hidden strokeWidth={1.6} />}
        </span>

        <div className="profile-body">
          <div className="tabs" role="tablist" aria-label="Company profile sections">
            {TABS.map(t => (
              <button key={t.key} type="button" role="tab" id={`tab-${t.key}`}
                aria-selected={tab === t.key} aria-controls={`panel-${t.key}`}
                onClick={() => { setTab(t.key); setPreview(false); }}
                className="tab">
                <t.icon aria-hidden />{t.label}
              </button>
            ))}
          </div>

          {error && <div role="alert" className="mt-20 px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
          {saved && <div role="status" className="mt-20 px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>Profile saved.</div>}

          {preview ? (
            <section className="mt-20 rounded-card border p-20"
              style={{ borderColor: "var(--gold)", background: "rgba(201, 168, 76, 0.08)" }}>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                What a shipper sees
              </p>
              <div className="mt-12 flex flex-wrap items-center gap-8">
                <Globe aria-hidden style={{ width: 15, height: 15, color: "var(--gold)" }} />
                <p className="text-base font-bold" style={{ color: "var(--ink)" }}>
                  {form.company_name || "—"}
                </p>
                {status === "active" && (
                  <span className="badge badge-verified"><ShieldCheck aria-hidden />Verified</span>
                )}
              </div>
              {form.description
                ? <p className="mt-10 text-sm leading-relaxed" style={{ color: "var(--ink)" }}>{form.description}</p>
                : <div className="mt-10"><Note text="No description yet — shippers see an empty card." /></div>}
              <div className="mt-14">
                <Chips items={services} empty="No services listed." />
              </div>
              <dl className="kv mt-14">
                <dt>Corridors</dt><dd>{form.corridors_served || "—"}</dd>
                <dt>Fleet</dt>
                <dd>{form.fleet_size_declared ? `${form.fleet_size_declared} vessels declared` : "—"}</dd>
                <dt>Licence</dt><dd>{form.transport_licence_no || "—"}</dd>
                <dt>Website</dt><dd>{form.website || "—"}</dd>
                <dt>Based in</dt><dd>{city ? `${city}, Tanzania` : "Tanzania"}</dd>
              </dl>
              <p className="mt-14 text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                Shippers never see your clients, prices, duties, documents or staff beyond the named contact.
              </p>
            </section>
          ) : (
            <form onSubmit={save} className="mt-20">
              <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
                {tab === "overview" && (
                  <div className="pv-grid">
                    <div>
                      <div className="pv-block">
                        <BlockTitle icon={Building2}>About</BlockTitle>
                        <Field label="Company name *" editing={editing} required
                          value={F("company_name")} onValue={v => set("company_name", v)} />
                        <label className="mt-12 block">
                          <span className={LABEL_CLS} style={{ color: "var(--ink-soft)" }}>Description</span>
                          <textarea rows={4} disabled={!editing} value={F("description")}
                            onChange={e => set("description", e.target.value)}
                            placeholder="What you move, where, and why shippers trust you"
                            className={INPUT_CLS} style={editing ? INPUT_STYLE : READ_STYLE} />
                        </label>
                      </div>

                      <div className="pv-block">
                        <BlockTitle icon={Truck}>Services offered</BlockTitle>
                        <Field label="Services" editing={editing}
                          placeholder="e.g. General cargo, Refrigerated, Fuel tanker"
                          value={F("services_offered")} onValue={v => set("services_offered", v)} />
                        <div className="mt-12">
                          <Chips items={services} empty="Nothing listed yet — road, sea and air chips appear as you type." />
                        </div>
                      </div>

                      <div className="pv-block">
                        <BlockTitle icon={Route}>Routes covered</BlockTitle>
                        <Field label="Corridors" editing={editing}
                          placeholder="e.g. Dar es Salaam - Kigali, Central Corridor"
                          value={F("corridors_served")} onValue={v => set("corridors_served", v)} />
                        <div className="mt-12">
                          <Chips items={corridors} icon={MapPin} empty="No corridors listed yet." />
                        </div>
                        {routes.length > 0 && (
                          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                            {routes.length} route{routes.length === 1 ? "" : "s"} mapped in{" "}
                            <Link href="/app/routes" className="underline">Routes</Link>.
                          </p>
                        )}
                      </div>

                      <div className="pv-block">
                        <BlockTitle icon={Globe}>Website</BlockTitle>
                        <Field label="Website" editing={editing} placeholder="wema.com"
                          value={F("website")} onValue={v => set("website", v)} />
                      </div>
                    </div>

                    <div>
                      <div className="pv-block">
                        <BlockTitle icon={Check}>Profile completeness</BlockTitle>
                        <div className="flex items-center gap-16">
                          <ProgressRing value={completion} />
                          <p className="text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                            {missing.length === 0
                              ? "Every field shippers look for is on file."
                              : `${missing.length} field${missing.length === 1 ? "" : "s"} still missing.`}
                          </p>
                        </div>
                        {missing.length > 0 && (
                          <ul className="mt-14 space-y-8">
                            {missing.map(f => (
                              <li key={f.key} className="flex items-start gap-8 text-xs"
                                style={{ color: "var(--ink-soft)" }}>
                                <CircleDashed aria-hidden style={{ width: 14, height: 14, marginTop: 2, flex: "0 0 auto" }} />
                                {f.label}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="pv-block">
                        <BlockTitle icon={IdCard}>Registration</BlockTitle>
                        <div className="space-y-12">
                          <Field label="BRELA number" editing={editing}
                            value={F("brela_number")} onValue={v => set("brela_number", v)} />
                          <Field label="VAT number" editing={editing}
                            value={F("vat_number")} onValue={v => set("vat_number", v)} />
                          <Field label="Transport licence no." editing={editing}
                            value={F("transport_licence_no")} onValue={v => set("transport_licence_no", v)} />
                          <label className="block">
                            <span className={LABEL_CLS} style={{ color: "var(--ink-soft)" }}>
                              Transport licence expiry
                            </span>
                            <input type="date" disabled={!editing} value={licenceExpiry}
                              onChange={e => set("transport_licence_expiry", e.target.value)}
                              className={INPUT_CLS} style={editing ? INPUT_STYLE : READ_STYLE} />
                          </label>
                          <Field label="Year established" editing={editing} type="number" min={1900} max={2100}
                            value={F("year_established")} onValue={v => set("year_established", v)} />
                          <Field label="Company code (3 letters, for cargo file numbers)" editing={editing}
                            maxLength={3} placeholder="e.g. LTL"
                            value={F("company_code")}
                            onValue={v => set("company_code", v.toUpperCase().replace(/[^A-Z]/g, ""))} />
                        </div>
                      </div>

                      <div className="pv-block">
                        <BlockTitle icon={MapPin}>Contact details</BlockTitle>
                        {hq ? (
                          <dl className="kv">
                            <dt>Named contact</dt><dd>{hq.contact_person || "—"}</dd>
                            <dt>Email</dt><dd>{hq.email || "—"}</dd>
                            <dt>Phone</dt><dd>{hq.has_phone ? "On file" : "—"}</dd>
                            <dt>Hours</dt><dd>{hq.operating_hours || "—"}</dd>
                            <dt>Address</dt><dd>{address || "—"}</dd>
                          </dl>
                        ) : (
                          <div className="space-y-8">
                            <Note text="No branch on file yet — shippers read your HQ as your contact." />
                            <Link href="/app/branches" className="text-xs underline" style={{ color: "var(--brand)" }}>
                              Add a branch
                            </Link>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {tab === "documents" && (
                  <div className="pv-grid">
                    <div>
                      <div className="pv-block">
                        <BlockTitle icon={FileText}>Company logo</BlockTitle>
                        <div className="flex items-center gap-16">
                          <span className="profile-avatar profile-avatar--static">
                            {logoUrl
                              ? <img src={logoUrl} alt="Company logo" />
                              : <Building2 aria-hidden strokeWidth={1.6} />}
                          </span>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                              {logoUrl ? "Logo on file" : "No logo yet"}
                            </p>
                            <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                              JPEG, PNG or WebP, 2 MB or smaller. Appears on your invoices, your documents and the
                              shipper preview.
                            </p>
                            <input type="file" accept="image/jpeg,image/png,image/webp" disabled={logoBusy}
                              className="mt-8 text-xs"
                              onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ""; }} />
                            {logoBusy && <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>Uploading…</p>}
                            {!logoBusy && logoUrl && (
                              <p className="mt-4 text-xs" style={{ color: "var(--success)" }}>Preview updated.</p>
                            )}
                          </div>
                        </div>
                        <Link href="/app/documents" className="mt-16 inline-flex items-center gap-6 text-xs underline"
                          style={{ color: "var(--brand)" }}>
                          Open the document vault
                          <ExternalLink aria-hidden style={{ width: 13, height: 13 }} />
                        </Link>
                      </div>
                    </div>

                    <div>
                      <div className="pv-block">
                        <BlockTitle icon={Wallet}>Where to pay</BlockTitle>
                        <p className="mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                          Bank and mobile-money details printed on all your invoices. Leave blank if unused.
                        </p>
                        <div className="space-y-12">
                          <Field label="Bank name" editing={editing} placeholder="e.g. CRDB Bank"
                            value={F("pay_bank_name")} onValue={v => set("pay_bank_name", v)} />
                          <Field label="Account number" editing={editing}
                            value={F("pay_bank_account")} onValue={v => set("pay_bank_account", v)} />
                          <Field label="Account name" editing={editing}
                            value={F("pay_account_name")} onValue={v => set("pay_account_name", v)} />
                          <Field label="Mobile money" editing={editing} placeholder="e.g. M-Pesa +255712345678"
                            value={F("pay_mobile_money")} onValue={v => set("pay_mobile_money", v)} />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {tab === "fleet" && (
                  <div className="pv-grid">
                    <div>
                      <div className="pv-block">
                        <BlockTitle icon={Truck}>Registered fleet</BlockTitle>
                        {vessels.length === 0 ? (
                          <div className="space-y-8">
                            <Note text="No vessel registered yet — your declared fleet size is just a number until you add one." />
                            <Link href="/app/fleet" className="text-xs underline" style={{ color: "var(--brand)" }}>
                              Register a vessel
                            </Link>
                          </div>
                        ) : (
                          <ul className="space-y-8">
                            {vessels.slice(0, 8).map((v: any) => (
                              <li key={v.id} className="flex items-center justify-between gap-12 text-sm">
                                <span style={{ color: "var(--ink)" }}>
                                  {v.name}{v.plate_number ? ` · ${v.plate_number}` : ""}
                                </span>
                                <span className="chip" style={{ margin: 0 }}>
                                  {v.vessel_type === "ship" || v.vessel_type === "boat"
                                    ? <Ship aria-hidden /> : <Truck aria-hidden />}
                                  {v.vessel_type || "vessel"}
                                </span>
                              </li>
                            ))}
                            {vessels.length > 8 && (
                              <li className="text-xs" style={{ color: "var(--ink-soft)" }}>
                                +{vessels.length - 8} more in{" "}
                                <Link href="/app/fleet" className="underline">Fleet</Link>
                              </li>
                            )}
                          </ul>
                        )}
                      </div>

                      <div className="pv-block">
                        <BlockTitle icon={Route}>Coverage on the map</BlockTitle>
                        {routes.length === 0 ? (
                          <div className="space-y-8">
                            <Note text="No route mapped yet." />
                            <Link href="/app/routes" className="text-xs underline" style={{ color: "var(--brand)" }}>
                              Create a route
                            </Link>
                          </div>
                        ) : (
                          <ul className="space-y-8">
                            {routes.slice(0, 8).map((r: any) => (
                              <li key={r.id} className="text-sm">
                                <span style={{ color: "var(--ink)" }}>{r.name}</span>
                                <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                                  {[r.origin_text || r.origin_ward_name, r.dest_text || r.dest_ward_name]
                                    .filter(Boolean).join(" → ") || r.corridor || ""}
                                  {r.distance_km ? ` · ${r.distance_km} km` : ""}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>

                    <div>
                      <div className="pv-block">
                        <BlockTitle icon={Building2}>Fleet summary</BlockTitle>
                        <dl className="kv">
                          <dt>Declared</dt>
                          <dd>{form.fleet_size_declared ? `${form.fleet_size_declared} vessels` : "not declared"}</dd>
                          <dt>On file</dt><dd>{vessels.length}</dd>
                          {Object.entries(byType).map(([k, n]) => (
                            <div key={k} className="contents">
                              <dt>{k}</dt><dd>{n}</dd>
                            </div>
                          ))}
                        </dl>
                        <div className="mt-12">
                          <Field label="Fleet size (declared)" editing={editing} type="number" min={0}
                            value={F("fleet_size_declared")} onValue={v => set("fleet_size_declared", v)} />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {tab === "contacts" && (
                  <div className="pv-grid">
                    <div>
                      <BlockTitle icon={Users}>Branches</BlockTitle>
                      {branches.length === 0 ? (
                        <div className="space-y-8">
                          <Note text="No branch on file — add your HQ so shippers and staff have an address." />
                          <Link href="/app/branches" className="text-xs underline" style={{ color: "var(--brand)" }}>
                            Add a branch
                          </Link>
                        </div>
                      ) : (
                        <ul className="space-y-16">
                          {branches.map((b: any) => (
                            <li key={b.id} className="rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
                              <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                                {b.name}
                                <span className="ml-8 text-[10px] font-bold uppercase tracking-[0.14em]"
                                  style={{ color: "var(--gold)" }}>
                                  {b.kind === "hq" ? "HQ" : b.kind === "sub_hq" ? "Sub-HQ" : "Branch"}
                                </span>
                              </p>
                              <dl className="kv mt-10">
                                <dt>Contact</dt><dd>{b.contact_person || "—"}</dd>
                                <dt>Email</dt><dd>{b.email || "—"}</dd>
                                <dt>Phone</dt><dd>{b.has_phone ? "On file" : "—"}</dd>
                                <dt>Hours</dt><dd>{b.operating_hours || "—"}</dd>
                              </dl>
                            </li>
                          ))}
                        </ul>
                      )}
                      <Link href="/app/branches"
                        className="mt-16 inline-flex items-center gap-6 text-xs underline"
                        style={{ color: "var(--brand)" }}>
                        Manage branches
                        <ExternalLink aria-hidden style={{ width: 13, height: 13 }} />
                      </Link>
                    </div>

                    <div>
                      <BlockTitle icon={Phone}>Reach the company</BlockTitle>
                      <dl className="kv">
                        <dt>HQ phone</dt><dd>{hq?.has_phone ? "On file — hidden for privacy" : "—"}</dd>
                        <dt>HQ email</dt><dd>{hq?.email || "—"}</dd>
                        <dt>Website</dt><dd>{form.website || "—"}</dd>
                        <dt>Country</dt><dd>Tanzania</dd>
                      </dl>
                      <p className="mt-12 text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                        Phone numbers stay encrypted on the platform and are never listed in full here.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {editing && (
                <div className="mt-20 space-y-12 border-t pt-16" style={{ borderColor: "var(--line)" }}>
                  {confirming && (
                    <div role="status" className="rounded-input px-12 py-8 text-sm"
                      style={{ background: "color-mix(in srgb, var(--gold) 15%, transparent)", borderLeft: "4px solid var(--gold)" }}>
                      Review your changes above, then confirm. This updates what shippers and the platform see.
                    </div>
                  )}
                  <div className="flex gap-8">
                    <button type="submit" disabled={busy}
                      className="waisha-btn flex-1 rounded-input py-12 text-sm font-semibold disabled:opacity-60">
                      {busy ? "Saving" : confirming ? "Confirm update" : "Review changes"}
                    </button>
                    <button type="button" onClick={cancelEdit}
                      className="rounded-input border px-16 py-12 text-sm font-semibold"
                      style={{ borderColor: "var(--line)" }}>
                      {confirming ? "Discard" : "Cancel"}
                    </button>
                  </div>
                </div>
              )}
            </form>
          )}
        </div>
      </header>
    </div>
  );
}
