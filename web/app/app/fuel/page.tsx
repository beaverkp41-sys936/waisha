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

interface FuelLog {
  id: string; vessel_id: string | null; trip_id: string | null;
  log_date: string; litres: string; price_per_litre: string | null;
  total_cost: string | null; odometer_km: number | null;
  station: string | null; notes: string | null;
  vessel_name: string | null; trip_reference: string | null;
}
interface Vessel { id: string; name: string; }

const EMPTY = { vesselId: "", logDate: "", litres: "", pricePerLitre: "", totalCost: "", odometerKm: "", station: "", notes: "" };

export default function FuelPage() {
  const [logs, setLogs] = useState<FuelLog[]>([]);
  const [totals, setTotals] = useState<{ litres: number; cost: number; entries: number } | null>(null);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const f = await apiFetch("/fuel-logs");
    if (f.ok) { const j = await f.json(); setLogs(j.logs ?? []); setTotals(j.totals ?? null); }
    const v = await apiFetch("/vessels");
    if (v.ok) { const j = await v.json(); setVessels(j.vessels ?? j); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch("/fuel-logs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vesselId: form.vesselId || null,
          logDate: form.logDate || undefined,
          litres: Number(form.litres),
          pricePerLitre: form.pricePerLitre ? Number(form.pricePerLitre) : null,
          totalCost: form.totalCost ? Number(form.totalCost) : null,
          odometerKm: form.odometerKm ? Number(form.odometerKm) : null,
          station: form.station || null,
          notes: form.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to log fuel.")); return; }
      setNotice("Fuel logged.");
      setForm(EMPTY);
      load();
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/fuel-logs/${id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed to delete."));
    load();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Fuel tracking</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Every fill-up, per vessel, with running totals.
      </p>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {totals && (
        <section className="mt-24 grid grid-cols-3 gap-16">
          <div className={card} style={cardStyle}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Total litres</p>
            <p className="mt-8 text-xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{totals.litres.toLocaleString()}</p>
          </div>
          <div className={card} style={cardStyle}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Total spend (TZS)</p>
            <p className="mt-8 text-xl font-bold tabular-nums" style={{ color: "var(--danger)" }}>{totals.cost.toLocaleString()}</p>
          </div>
          <div className={card} style={cardStyle}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Fill-ups</p>
            <p className="mt-8 text-xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{totals.entries}</p>
          </div>
        </section>
      )}

      <form onSubmit={submit} className="mt-24 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
        <div className="grid grid-cols-2 gap-12">
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Vessel</span>
            <select value={form.vesselId} onChange={e => setForm(f => ({ ...f, vesselId: e.target.value }))}
              className={inputCls} style={inputStyle}>
              <option value="">Unassigned</option>
              {vessels.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Date</span>
            <input type="date" value={form.logDate} onChange={e => setForm(f => ({ ...f, logDate: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Litres *</span>
            <input type="number" required min={0.01} step="0.01" value={form.litres}
              onChange={e => setForm(f => ({ ...f, litres: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Price per litre (TZS)</span>
            <input type="number" min={0} step="0.01" value={form.pricePerLitre}
              onChange={e => setForm(f => ({ ...f, pricePerLitre: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Total cost (TZS) — auto from litres x price</span>
            <input type="number" min={0} step="0.01" value={form.totalCost}
              onChange={e => setForm(f => ({ ...f, totalCost: e.target.value }))}
              placeholder={form.litres && form.pricePerLitre ? String(Number(form.litres) * Number(form.pricePerLitre)) : ""}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Odometer (km)</span>
            <input type="number" min={0} value={form.odometerKm}
              onChange={e => setForm(f => ({ ...f, odometerKm: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Station</span>
            <input value={form.station} onChange={e => setForm(f => ({ ...f, station: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
            <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
        </div>
        <button type="submit" disabled={busy}
          className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
          {busy ? "Saving…" : "Log fuel"}
        </button>
      </form>

      <div className="mt-24 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Date</th><th className="p-12">Vessel</th>
              <th className="p-12 text-right">Litres</th><th className="p-12 text-right">Cost</th>
              <th className="p-12">Odometer</th><th className="p-12">Station</th><th></th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l, i) => (
              <tr key={l.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {new Date(l.log_date).toLocaleDateString()}
                </td>
                <td className="p-12" style={{ color: "var(--ink)" }}>
                  {l.vessel_name ?? "—"}
                  {l.trip_reference && <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>Trip {l.trip_reference}</span>}
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{Number(l.litres).toLocaleString()}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {l.total_cost ? Number(l.total_cost).toLocaleString() : "—"}
                </td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{l.odometer_km ? l.odometer_km.toLocaleString() : "—"}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{l.station ?? "—"}</td>
                <td className="p-12 text-right">
                  <button type="button" className="underline" style={{ color: "var(--danger)" }} onClick={() => remove(l.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>No fuel logged yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
