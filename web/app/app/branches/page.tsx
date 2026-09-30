"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api-client";

interface Region { id: number; name_en: string; name_sw: string; }
interface District { id: number; name_en: string; name_sw: string; }
interface Ward { id: number; name: string; }
interface Branch { id: string; kind: string; name: string; region_name: string | null;
  district_name: string | null; }

export default function BranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [wards, setWards] = useState<Ward[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ kind: "branch", name: "", regionId: "", districtId: "", wardId: "", street: "", contactPerson: "", phone: "" });

  const loadBranches = useCallback(async () => {
    const res = await apiFetch("/branches");
    if (res.ok) setBranches(await res.json());
  }, []);

  useEffect(() => {
    (async () => {
      const g = await apiFetch("/geo/regions");
      if (g.ok) setRegions(await g.json());
      loadBranches();
    })();
  }, [loadBranches]);

  async function pickRegion(v: string) {
    setForm(f => ({ ...f, regionId: v, districtId: "", wardId: "" }));
    setWards([]);
    if (v) { const d = await apiFetch(`/geo/districts/${v}`); if (d.ok) setDistricts(await d.json()); }
    else setDistricts([]);
  }
  async function pickDistrict(v: string) {
    setForm(f => ({ ...f, districtId: v, wardId: "" }));
    if (v) { const w = await apiFetch(`/geo/wards/${v}`); if (w.ok) setWards(await w.json()); }
    else setWards([]);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch("/branches", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: form.kind, name: form.name,
          regionId: form.regionId ? Number(form.regionId) : null,
          districtId: form.districtId ? Number(form.districtId) : null,
          wardId: form.wardId ? Number(form.wardId) : null,
          street: form.street || undefined,
          contactPerson: form.contactPerson || undefined,
          phone: form.phone || undefined
        }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "Failed"); return; }
      setNotice(`Branch "${form.name}" saved.`);
      setForm(f => ({ ...f, name: "", wardId: "", street: "", contactPerson: "", phone: "" }));
      loadBranches();
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    await apiFetch(`/branches/${id}`, { method: "DELETE" });
    loadBranches();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="mx-auto max-w-[760px] px-16 py-32">
      <h1 className="mb-8 text-xl font-bold" style={{ color: "var(--ink)" }}>Branches</h1>
      <p className="mb-24 text-sm" style={{ color: "var(--ink-soft)" }}>
        HQ first, then sub-HQ and branches. Locations use the official Region → Council → Ward structure.
      </p>
      {error && <div role="alert" className="mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      <form onSubmit={submit} className="mb-32 space-y-12 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
        <div className="grid grid-cols-2 gap-12">
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Type</span>
            <select value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value }))} className={inputCls} style={inputStyle}>
              <option value="hq">Headquarters</option>
              <option value="sub_hq">Sub-HQ</option>
              <option value="branch">Branch</option>
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Name *</span>
            <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Dar es Salaam Head Office" className={inputCls} style={inputStyle} />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-12">
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Region (Mkoa)</span>
            <select value={form.regionId} onChange={e => pickRegion(e.target.value)} className={inputCls} style={inputStyle}>
              <option value="">Select</option>
              {regions.map(r => <option key={r.id} value={r.id}>{r.name_en}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Council</span>
            <select value={form.districtId} onChange={e => pickDistrict(e.target.value)} disabled={!form.regionId}
              className={inputCls} style={{ ...inputStyle, opacity: form.regionId ? 1 : 0.5 }}>
              <option value="">{form.regionId ? "Select" : "Pick region first"}</option>
              {districts.map(d => <option key={d.id} value={d.id}>{d.name_en}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Ward (Kata)</span>
            <select value={form.wardId} onChange={e => setForm(f => ({ ...f, wardId: e.target.value }))} disabled={!form.districtId}
              className={inputCls} style={{ ...inputStyle, opacity: form.districtId ? 1 : 0.5 }}>
              <option value="">{form.districtId ? "Select" : "Pick council first"}</option>
              {wards.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-12">
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Street / Mtaa</span>
            <input value={form.street} onChange={e => setForm(f => ({ ...f, street: e.target.value }))} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Contact person</span>
            <input value={form.contactPerson} onChange={e => setForm(f => ({ ...f, contactPerson: e.target.value }))} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Phone</span>
            <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+255712345678" className={inputCls} style={inputStyle} />
          </label>
        </div>
        <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
          {busy ? "Saving" : "Add branch"}
        </button>
      </form>

      <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Name</th><th className="p-12">Type</th>
              <th className="p-12">Region</th><th className="p-12">Council</th><th></th>
            </tr>
          </thead>
          <tbody>
            {branches.map((b, i) => (
              <tr key={b.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{b.name}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{b.kind}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{b.region_name ?? "—"}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{b.district_name ?? "—"}</td>
                <td className="p-12 text-right">
                  <button type="button" className="underline" style={{ color: "var(--danger)" }} onClick={() => remove(b.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {branches.length === 0 && (
              <tr><td colSpan={5} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>No branches yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}