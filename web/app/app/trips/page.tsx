"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Trip {
  id: string; reference: string | null; status: string;
  route_id: string; vessel_id: string | null; driver_id: string | null;
  planned_departure: string | null; planned_arrival: string | null;
  actual_departure: string | null; actual_arrival: string | null;
  distance_km: number | null; notes: string | null; created_at: string;
  route_name: string | null; origin_text: string | null; dest_text: string | null;
  vessel_name: string | null; driver_name: string | null;
  shipment_count: number; total_weight_kg: number; total_freight: number;
}
interface RouteRow {
  id: string; name: string; origin_text: string | null; dest_text: string | null;
  distance_km: number | null; expected_duration_hours: number | null;
}
interface Vessel { id: string; name: string; }
interface Driver { id: string; full_name: string; }

const STATUS_LABELS: Record<string, string> = {
  planned: "Planned", in_transit: "In transit", arrived: "Arrived",
  completed: "Completed", cancelled: "Cancelled"
};
const STATUS_COLORS: Record<string, string> = {
  planned: "var(--gold)", in_transit: "var(--brand)", arrived: "var(--gold-green)",
  completed: "var(--success)", cancelled: "var(--danger)"
};
// Client mirror of the server lifecycle — the API rejects anything else.
const NEXT_STATUS: Record<string, string[]> = {
  planned: ["in_transit", "cancelled"],
  in_transit: ["arrived", "cancelled"],
  arrived: ["completed", "cancelled"],
  completed: [], cancelled: []
};

interface TripForm {
  reference: string; routeId: string; vesselId: string; driverId: string;
  plannedDeparture: string; plannedArrival: string; notes: string;
}
const EMPTY: TripForm = {
  reference: "", routeId: "", vesselId: "", driverId: "",
  plannedDeparture: "", plannedArrival: "", notes: ""
};

export default function TripsPage() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripLimit, setTripLimit] = useState<number | null>(null);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TripForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const t = await apiFetch("/trips");
    if (t.ok) { const j = await t.json(); setTrips(j.trips ?? []); setTripLimit(j.tripLimit ?? null); }
    const r = await apiFetch("/routes");
    if (r.ok) setRoutes(await r.json());
    const v = await apiFetch("/vessels");
    if (v.ok) { const j = await v.json(); setVessels(j.vessels ?? j); }
    const d = await apiFetch("/drivers");
    if (d.ok) setDrivers(await d.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  // Choosing a route shows its distance; picking a departure prefills the
  // planned arrival from the route's expected duration (still editable).
  function onDepartureChange(value: string) {
    setForm(f => {
      const next = { ...f, plannedDeparture: value };
      if (value && f.routeId && !f.plannedArrival) {
        const r = routes.find(x => x.id === f.routeId);
        if (r?.expected_duration_hours) {
          const arr = new Date(value);
          arr.setHours(arr.getHours() + r.expected_duration_hours);
          const pad = (n: number) => String(n).padStart(2, "0");
          next.plannedArrival =
            `${arr.getFullYear()}-${pad(arr.getMonth() + 1)}-${pad(arr.getDate())}T${pad(arr.getHours())}:${pad(arr.getMinutes())}`;
        }
      }
      return next;
    });
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    const editing = editingId !== null;
    try {
      const res = await apiFetch(editing ? `/trips/${editingId}` : "/trips", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routeId: form.routeId,
          reference: form.reference || null,
          vesselId: form.vesselId || null,
          driverId: form.driverId || null,
          plannedDeparture: form.plannedDeparture || null,
          plannedArrival: form.plannedArrival || null,
          notes: form.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the trip.")); return; }
      setNotice(editing ? "Trip updated." : "Trip planned.");
      setForm(EMPTY); setEditingId(null); setShowForm(false);
      load();
    } finally { setBusy(false); }
  }

  function startEdit(t: Trip) {
    setEditingId(t.id);
    setForm({
      reference: t.reference ?? "",
      routeId: t.route_id ?? "",
      vesselId: t.vessel_id ?? "",
      driverId: t.driver_id ?? "",
      plannedDeparture: t.planned_departure ? t.planned_departure.slice(0, 16) : "",
      plannedArrival: t.planned_arrival ? t.planned_arrival.slice(0, 16) : "",
      notes: t.notes ?? ""
    });
    setError(null); setNotice(null); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function changeStatus(id: string, status: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/trips/${id}/status`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed to update the trip."));
    else setNotice(`Trip marked ${STATUS_LABELS[status]?.toLowerCase() ?? status}.`);
    load();
  }

  async function remove(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/trips/${id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed to remove the trip."));
    load();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Trips</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Plan journeys, run them through checkpoints, carry cargo.{tripLimit !== null ? ` ${trips.length} of ${tripLimit} (trial).` : ""}
          </p>
        </div>
        <button type="button" onClick={() => { setForm(EMPTY); setEditingId(null); setShowForm(s => !s); }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ Plan trip"}
        </button>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {showForm && (
        <form onSubmit={submit} className="mb-32 space-y-12 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Route *</span>
              <select required value={form.routeId} onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">Select</option>
                {routes.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name}{r.distance_km ? ` — ${r.distance_km} km` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Reference (optional)</span>
              <input value={form.reference} onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                placeholder="e.g. DSM-MWN-042" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Vessel</span>
              <select value={form.vesselId} onChange={e => setForm(f => ({ ...f, vesselId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">Unassigned</option>
                {vessels.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Driver</span>
              <select value={form.driverId} onChange={e => setForm(f => ({ ...f, driverId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">Unassigned</option>
                {drivers.map(d => <option key={d.id} value={d.id}>{d.full_name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Planned departure</span>
              <input type="datetime-local" value={form.plannedDeparture}
                onChange={e => onDepartureChange(e.target.value)}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Planned arrival</span>
              <input type="datetime-local" value={form.plannedArrival}
                onChange={e => setForm(f => ({ ...f, plannedArrival: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            A vessel or driver can only hold one active trip. Cargo is added on the trip page after planning.
          </p>
          <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
            {busy ? "Saving…" : (editingId ? "Save changes" : "Plan trip")}
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Trip</th><th className="p-12">Route</th>
              <th className="p-12">Vessel / driver</th><th className="p-12">Departure</th>
              <th className="p-12">Cargo</th><th className="p-12">Freight</th>
              <th className="p-12">Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {trips.map((t, i) => (
              <tr key={t.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                  <Link href={`/app/trips/${t.id}`} className="underline">{t.reference ?? t.id.slice(0, 8).toUpperCase()}</Link>
                </td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                  {t.route_name ?? "—"}
                  {t.distance_km ? <span className="block text-xs tabular-nums">{t.distance_km} km</span> : null}
                </td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                  {t.vessel_name ?? "—"}
                  <span className="block text-xs">{t.driver_name ?? "no driver"}</span>
                </td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {t.actual_departure
                    ? new Date(t.actual_departure).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
                    : t.planned_departure
                      ? new Date(t.planned_departure).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
                      : "—"}
                </td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {t.shipment_count} load{t.shipment_count === 1 ? "" : "s"}
                  {t.total_weight_kg ? <span className="block text-xs">{t.total_weight_kg.toLocaleString()} kg</span> : null}
                </td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>
                  {t.total_freight ? `TZS ${t.total_freight.toLocaleString()}` : "—"}
                </td>
                <td className="p-12">
                  <span className="px-8 py-4 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${STATUS_COLORS[t.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                    {STATUS_LABELS[t.status] ?? t.status}
                  </span>
                </td>
                <td className="p-12 text-right whitespace-nowrap">
                  {(NEXT_STATUS[t.status] ?? []).length > 0 && (
                    <select defaultValue="" aria-label="Advance trip status"
                      className="mr-12 rounded-input border px-8 py-4 text-xs"
                      style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}
                      onChange={e => { if (e.target.value) changeStatus(t.id, e.target.value); e.target.value = ""; }}>
                      <option value="">Advance…</option>
                      {(NEXT_STATUS[t.status] ?? []).map(s => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  )}
                  <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                    onClick={() => startEdit(t)}>Edit</button>
                  <button type="button" className="underline disabled:opacity-40" style={{ color: "var(--danger)" }}
                    disabled={t.status === "in_transit"}
                    onClick={() => remove(t.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {trips.length === 0 && (
              <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No trips yet — plan one above.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
