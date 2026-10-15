"use client";
import { useCallback, useEffect, useState } from "react";
import { MapPinned } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { apiFetch } from "../api-client";

interface Region { id: number; name_en: string; name_sw: string; }
interface District { id: number; name_en: string; name_sw: string; }
interface Ward { id: number; name: string; }
interface Branch { id: string; kind: string; name: string; region_id: number | null;
  district_id: number | null; region_name: string | null; district_name: string | null;
  ward: string | null; contact_person: string | null; has_phone: boolean; }

const EMPTY_BRANCH = { kind: "branch", name: "", regionId: "", districtId: "", wardId: "", street: "", contactPerson: "", phone: "" };

export default function BranchesPage() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [wards, setWards] = useState<Ward[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_BRANCH);

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

  function startEdit(b: Branch) {
    setEditingId(b.id);
    setShowForm(true);
    setForm({
      kind: b.kind, name: b.name,
      regionId: b.region_id ? String(b.region_id) : "",
      districtId: b.district_id ? String(b.district_id) : "",
      wardId: "", street: "",
      contactPerson: b.contact_person ?? "", phone: ""
    });
    setError(null); setNotice(null);
    // load cascades for pre-selection
    (async () => {
      if (b.region_id) {
        const d = await apiFetch(`/geo/districts/${b.region_id}`);
        if (d.ok) setDistricts(await d.json());
      }
      if (b.district_id) {
        const w = await apiFetch(`/geo/wards/${b.district_id}`);
        if (w.ok) setWards(await w.json());
        // pre-select ward by NAME (stored name -> current ward id)
        setWards(prev => {
          const match = prev.find(x => x.name === b.ward);
          if (match) setTimeout(() => setForm(f => ({ ...f, wardId: String(match.id) })), 0);
          return prev;
        });
      }
    })();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditingId(null);
    setShowForm(false);
    setForm(EMPTY_BRANCH);
    setDistricts([]); setWards([]);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const payload = {
        kind: form.kind, name: form.name,
        regionId: form.regionId ? Number(form.regionId) : null,
        districtId: form.districtId ? Number(form.districtId) : null,
        wardId: form.wardId ? Number(form.wardId) : null,
        street: form.street || undefined,
        contactPerson: form.contactPerson || undefined,
        phone: form.phone || undefined
      };
      const res = editingId
        ? await apiFetch(`/branches/${editingId}`, { method: "PUT",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await apiFetch("/branches", { method: "POST",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "Failed"); return; }
      setNotice(editingId ? `Branch "${form.name}" updated.` : `Branch "${form.name}" saved.`);
      cancelEdit();
      loadBranches();
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    await apiFetch(`/branches/${id}`, { method: "DELETE" });
    if (editingId === id) cancelEdit();
    loadBranches();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="mx-auto max-w-[760px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Branches</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            HQ first, then sub-HQ and branches. Official Region → Council → Ward structure.
          </p>
        </div>
        <button type="button"
          onClick={() => { setShowForm(s => !s); if (!showForm) { setEditingId(null); setForm(EMPTY_BRANCH); setDistricts([]); setWards([]); } }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm && !editingId ? "Close form" : "+ Add branch"}
        </button>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {showForm && (
        <form onSubmit={submit} className="mb-32 space-y-12 rounded-card border bg-surface p-24"
          style={{ borderColor: editingId ? "var(--gold)" : "var(--line)" }}>
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
          <div className="flex gap-8">
            <button type="submit" disabled={busy} className="waisha-btn flex-1 rounded-input py-12 text-sm font-semibold disabled:opacity-60">
              {busy ? "Saving" : editingId ? "Update branch" : "Add branch"}
            </button>
            <button type="button" onClick={cancelEdit}
              className="rounded-input border px-16 py-12 text-sm font-semibold" style={{ borderColor: "var(--line)" }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Name</th><th className="p-12">Type</th>
              <th className="p-12">Region</th><th className="p-12">Council</th>
              <th className="p-12">Ward</th><th></th>
            </tr>
          </thead>
          <tbody>
            {branches.map((b, i) => (
              <tr key={b.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{b.name}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{b.kind}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{b.region_name ?? "—"}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{b.district_name ?? "—"}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{b.ward ?? "—"}</td>
                <td className="p-12 text-right whitespace-nowrap">
                  <button type="button" className="underline mr-16" style={{ color: "var(--brand)" }}
                    onClick={() => startEdit(b)}>Edit</button>
                  <button type="button" className="underline" style={{ color: "var(--danger)" }}
                    onClick={() => remove(b.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {branches.length === 0 && (
              <EmptyState colSpan={6} icon={MapPinned} title="No branches yet"
                hint="Add your HQ first — branches give trips, drivers and cargo a home base."
                action={{ label: "Add a branch", onClick: () => { setEditingId(null); setForm(EMPTY_BRANCH); setDistricts([]); setWards([]); setShowForm(true); } }} />
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}