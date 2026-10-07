"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Incident {
  id: string; vessel_id: string | null; driver_id: string | null; trip_id: string | null;
  incident_date: string; type: string; severity: string; location: string | null;
  description: string; status: string; resolution_notes: string | null;
  vessel_name: string | null; driver_name: string | null; trip_reference: string | null;
}
interface Vessel { id: string; name: string; }
interface Driver { id: string; full_name: string; }

const TYPE_LABELS: Record<string, string> = {
  accident: "Accident", breakdown: "Breakdown", theft: "Theft",
  injury: "Injury", other: "Other"
};
const SEVERITY_COLORS: Record<string, string> = {
  minor: "var(--gold)", major: "var(--warning)", critical: "var(--danger)"
};
const STATUS_COLORS: Record<string, string> = {
  open: "var(--danger)", investigating: "var(--gold)", resolved: "var(--success)"
};

const EMPTY = {
  vesselId: "", driverId: "", incidentDate: "", type: "other", severity: "minor",
  location: "", description: "", status: "", resolutionNotes: ""
};

export default function IncidentsPage() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await apiFetch("/incidents");
    if (r.ok) { const j = await r.json(); setIncidents(j.incidents ?? []); setOpenCount(j.openCount ?? 0); }
    const v = await apiFetch("/vessels");
    if (v.ok) { const j = await v.json(); setVessels(j.vessels ?? j); }
    const d = await apiFetch("/drivers");
    if (d.ok) setDrivers(await d.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const editing = editingId !== null;
      const res = await apiFetch(editing ? `/incidents/${editingId}` : "/incidents", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? {
          vesselId: form.vesselId || null,
          driverId: form.driverId || null,
          incidentDate: form.incidentDate || undefined,
          type: form.type,
          severity: form.severity,
          location: form.location || null,
          description: form.description,
          status: form.status || undefined,
          resolutionNotes: form.resolutionNotes || null
        } : {
          vesselId: form.vesselId || null,
          driverId: form.driverId || null,
          incidentDate: form.incidentDate || undefined,
          type: form.type,
          severity: form.severity,
          location: form.location || null,
          description: form.description
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save.")); return; }
      setNotice(editing ? "Incident updated." : "Incident reported.");
      setForm(EMPTY); setEditingId(null); setShowForm(false);
      load();
    } finally { setBusy(false); }
  }

  function startEdit(it: Incident) {
    setEditingId(it.id);
    setForm({
      vesselId: it.vessel_id ?? "", driverId: it.driver_id ?? "",
      incidentDate: it.incident_date ? it.incident_date.slice(0, 10) : "",
      type: it.type, severity: it.severity, location: it.location ?? "",
      description: it.description, status: it.status, resolutionNotes: it.resolution_notes ?? ""
    });
    setError(null); setNotice(null); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/incidents/${id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed to delete."));
    load();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Incidents</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Accidents, breakdowns and other events, tracked to resolution.
            {openCount > 0 && <span style={{ color: "var(--danger)" }}> {openCount} open.</span>}
          </p>
        </div>
        <button type="button" onClick={() => { setForm(EMPTY); setEditingId(null); setShowForm(s => !s); }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ Report incident"}
        </button>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {showForm && (
        <form onSubmit={submit} className="mb-32 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Vessel</span>
              <select value={form.vesselId} onChange={e => setForm(f => ({ ...f, vesselId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">None</option>
                {vessels.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Driver</span>
              <select value={form.driverId} onChange={e => setForm(f => ({ ...f, driverId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">None</option>
                {drivers.map(d => <option key={d.id} value={d.id}>{d.full_name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Date</span>
              <input type="date" value={form.incidentDate}
                onChange={e => setForm(f => ({ ...f, incidentDate: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Type</span>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                className={inputCls} style={inputStyle}>
                {Object.entries(TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Severity</span>
              <select value={form.severity} onChange={e => setForm(f => ({ ...f, severity: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="minor">Minor</option>
                <option value="major">Major</option>
                <option value="critical">Critical</option>
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Location</span>
              <input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                placeholder="e.g. Chalinze junction" className={inputCls} style={inputStyle} />
            </label>
            {editingId !== null && (
              <>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Status</span>
                  <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                    className={inputCls} style={inputStyle}>
                    <option value="open">Open</option>
                    <option value="investigating">Investigating</option>
                    <option value="resolved">Resolved</option>
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Resolution notes</span>
                  <input value={form.resolutionNotes}
                    onChange={e => setForm(f => ({ ...f, resolutionNotes: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
              </>
            )}
            <label className="block col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>What happened *</span>
              <textarea rows={3} required minLength={5} value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>
          <button type="submit" disabled={busy}
            className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving…" : (editingId ? "Save changes" : "Report incident")}
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-card border bg-surface" style={cardStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Date</th><th className="p-12">Type</th>
              <th className="p-12">Severity</th><th className="p-12">Involved</th>
              <th className="p-12">Description</th><th className="p-12">Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {incidents.map((it, i) => (
              <tr key={it.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {new Date(it.incident_date).toLocaleDateString()}
                </td>
                <td className="p-12" style={{ color: "var(--ink)" }}>{TYPE_LABELS[it.type] ?? it.type}</td>
                <td className="p-12">
                  <span className="px-8 py-4 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${SEVERITY_COLORS[it.severity] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                    {it.severity}
                  </span>
                </td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                  {it.vessel_name ?? it.driver_name ?? "—"}
                  {it.trip_reference && <span className="block text-xs">Trip {it.trip_reference}</span>}
                </td>
                <td className="p-12 max-w-[240px] truncate" style={{ color: "var(--ink)" }} title={it.description}>
                  {it.description}
                  {it.resolution_notes && (
                    <span className="block text-xs" style={{ color: "var(--success)" }}>{it.resolution_notes}</span>
                  )}
                </td>
                <td className="p-12">
                  <span className="px-8 py-4 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${STATUS_COLORS[it.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                    {it.status}
                  </span>
                </td>
                <td className="p-12 text-right whitespace-nowrap">
                  <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                    onClick={() => startEdit(it)}>Edit</button>
                  <button type="button" className="underline" style={{ color: "var(--danger)" }}
                    onClick={() => remove(it.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {incidents.length === 0 && (
              <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No incidents recorded — that is the goal.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
