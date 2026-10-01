"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

export default function ProfilePage() {
  const [form, setForm] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isNew, setIsNew] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch("/profile");
        if (res.ok) {
          const data = await res.json();
          setForm(data);
          setIsNew(data.isNew === true);
        } else setError("Could not load profile.");
      } catch (e: any) {
        if (e.message !== "session ended") setError(e.message);
      }
    })();
  }, []);

  function set(k: string, v: any) { setForm((f: any) => ({ ...f, [k]: v })); }

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
            : undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Save failed")); return; }
      setIsNew(false);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      if (e.message !== "session ended") setError(e.message);
    } finally { setBusy(false); }
  }

  if (!form) return <p className="p-32 text-sm" style={{ color: "var(--ink-soft)" }}>Loading profile</p>;

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const F = (k: string) => form[k] ?? "";

  return (
    <div className="mx-auto max-w-[760px] px-16 py-32">
      <h1 className="mb-8 text-xl font-bold" style={{ color: "var(--ink)" }}>Company profile</h1>
      <p className="mb-24 text-sm" style={{ color: "var(--ink-soft)" }}>
        This is what shippers and the platform see about your company.
      </p>
      {error && <div role="alert" className="mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {saved && <div role="status" className="mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>Profile saved.</div>}

      <form onSubmit={save} className="space-y-12 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Company name *</span>
          <input required value={F("company_name")} onChange={e => set("company_name", e.target.value)}
            className={inputCls} style={inputStyle} />
        </label>
        <div className="grid grid-cols-2 gap-12">
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>BRELA number</span>
            <input value={F("brela_number")} onChange={e => set("brela_number", e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>VAT number</span>
            <input value={F("vat_number")} onChange={e => set("vat_number", e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Transport licence no.</span>
            <input value={F("transport_licence_no")} onChange={e => set("transport_licence_no", e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Transport licence expiry</span>
            <input type="date" value={F("transport_licence_expiry")?.slice(0, 10) ?? ""} onChange={e => set("transport_licence_expiry", e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Year established</span>
            <input type="number" min={1900} max={2100} value={F("year_established")} onChange={e => set("year_established", e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Fleet size (declared)</span>
            <input type="number" min={0} value={F("fleet_size_declared")} onChange={e => set("fleet_size_declared", e.target.value)} className={inputCls} style={inputStyle} />
          </label>
        </div>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Services offered</span>
          <input value={F("services_offered")} onChange={e => set("services_offered", e.target.value)}
            placeholder="e.g. General cargo, Refrigerated, Fuel tanker" className={inputCls} style={inputStyle} />
        </label>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Corridors served</span>
          <input value={F("corridors_served")} onChange={e => set("corridors_served", e.target.value)}
            placeholder="e.g. Dar es Salaam - Kigali, Central Corridor" className={inputCls} style={inputStyle} />
        </label>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Description</span>
          <textarea rows={4} value={F("description")} onChange={e => set("description", e.target.value)} className={inputCls} style={inputStyle} />
        </label>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Website</span>
          <input value={F("website")} onChange={e => set("website", e.target.value)} placeholder="wema.com" className={inputCls} style={inputStyle} />
        </label>
        <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
          {busy ? "Saving" : saved ? "Saved" : isNew ? "Save profile" : "Update profile"}
        </button>
      </form>
    </div>
  );
}