"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { apiFetch } from "../../api-client";

const RouteMap = dynamic(() => import("../../routes/route-map"), {
  ssr: false,
  loading: () => <p className="pane-note p-16 text-sm">Loading map…</p>
});

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Shipment {
  id: string; customer_name: string; goods_description: string | null;
  package_count: number | null; weight_kg: string | null;
  freight_charge: string | null; notes: string | null; created_at: string;
}
interface CheckpointLog {
  id: string; route_checkpoint_id: string | null; label: string;
  kind: string | null; note: string | null; logged_at: string;
}
interface TripDetail {
  id: string; reference: string | null; status: string;
  route_id: string; vessel_id: string | null; driver_id: string | null;
  planned_departure: string | null; planned_arrival: string | null;
  actual_departure: string | null; actual_arrival: string | null;
  distance_km: number | null; notes: string | null;
  route_name: string | null; origin_text: string | null; dest_text: string | null;
  expected_duration_hours: number | null;
  origin_region: string | null; origin_lat: string | null; origin_lng: string | null;
  dest_region: string | null; dest_lat: string | null; dest_lng: string | null;
  vessel_name: string | null; capacity_tonnes: string | null;
  driver_name: string | null;
  checkpoints: { id: string; seq: number; kind: string; name: string }[];
  shipments: Shipment[];
  logs: CheckpointLog[];
}

const STATUS_LABELS: Record<string, string> = {
  planned: "Planned", in_transit: "In transit", arrived: "Arrived",
  completed: "Completed", cancelled: "Cancelled"
};
const STATUS_COLORS: Record<string, string> = {
  planned: "#c9a84c", in_transit: "#7fb2d8", arrived: "#b8cc5e",
  completed: "#5fce93", cancelled: "#ff9d94"
};
const ACTION_LABELS: Record<string, string> = {
  in_transit: "Depart", arrived: "Mark arrived",
  completed: "Complete trip", cancelled: "Cancel trip"
};
const NEXT_STATUS: Record<string, string[]> = {
  planned: ["in_transit", "cancelled"],
  in_transit: ["arrived", "cancelled"],
  arrived: ["completed", "cancelled"],
  completed: [], cancelled: []
};
const KIND_LABELS: Record<string, string> = {
  weighbridge: "Weighbridge", border: "Border", toll: "Toll",
  fuel: "Fuel station", rest: "Rest point", town: "Town", custom: "Custom"
};

interface ShipmentForm {
  customerName: string; customerPhone: string; goodsDescription: string;
  packageCount: string; weightKg: string; freightCharge: string; notes: string;
}
const EMPTY_SHIPMENT: ShipmentForm = {
  customerName: "", customerPhone: "", goodsDescription: "",
  packageCount: "", weightKg: "", freightCharge: "", notes: ""
};

function fmtNum(v: string | number | null, unit = ""): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toLocaleString()}${unit}` : "—";
}
function fmtDateTime(v: string | null): string {
  return v ? new Date(v).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
}

export default function TripDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showShipForm, setShowShipForm] = useState(false);
  const [editingShipId, setEditingShipId] = useState<string | null>(null);
  const [ship, setShip] = useState<ShipmentForm>(EMPTY_SHIPMENT);

  const [logCheckpointId, setLogCheckpointId] = useState("");
  const [logLabel, setLogLabel] = useState("");
  const [logNote, setLogNote] = useState("");

  const load = useCallback(async () => {
    const res = await apiFetch(`/trips/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Trip not found.")); return; }
    setTrip(j);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function transition(status: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/trips/${id}/status`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setError(errorText(j, "Failed to update the trip."));
      else setNotice(`Trip marked ${STATUS_LABELS[status]?.toLowerCase() ?? status}.`);
      await load();
    } finally { setBusy(false); }
  }

  async function submitShipment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const editing = editingShipId !== null;
      const res = await apiFetch(editing ? `/trips/${id}/shipments/${editingShipId}` : `/trips/${id}/shipments`, {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: ship.customerName,
          // blank keeps the stored (encrypted) phone — the API never returns it
          customerPhone: ship.customerPhone || undefined,
          goodsDescription: ship.goodsDescription || null,
          packageCount: ship.packageCount === "" ? null : Number(ship.packageCount),
          weightKg: ship.weightKg === "" ? null : Number(ship.weightKg),
          freightCharge: ship.freightCharge === "" ? null : Number(ship.freightCharge),
          notes: ship.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the shipment.")); return; }
      setNotice(editing ? "Shipment updated." : "Shipment added.");
      setShip(EMPTY_SHIPMENT); setEditingShipId(null); setShowShipForm(false);
      await load();
    } finally { setBusy(false); }
  }

  function startEditShipment(s: Shipment) {
    setEditingShipId(s.id);
    setShip({
      customerName: s.customer_name ?? "", customerPhone: "",
      goodsDescription: s.goods_description ?? "",
      packageCount: s.package_count === null ? "" : String(s.package_count),
      weightKg: s.weight_kg ?? "", freightCharge: s.freight_charge ?? "",
      notes: s.notes ?? ""
    });
    setShowShipForm(true);
    setError(null); setNotice(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function removeShipment(sid: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/trips/${id}/shipments/${sid}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed to remove the shipment."));
    await load();
  }

  async function addLog(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/trips/${id}/checkpoint-logs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkpointId: logCheckpointId || null,
          label: logCheckpointId ? undefined : (logLabel || undefined),
          note: logNote || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to record the checkpoint.")); return; }
      setNotice("Checkpoint recorded.");
      setLogCheckpointId(""); setLogLabel(""); setLogNote("");
      await load();
    } finally { setBusy(false); }
  }

  async function removeLog(logId: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/trips/${id}/checkpoint-logs/${logId}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed to remove the log entry."));
    await load();
  }

  const editable = trip ? !["completed", "cancelled"].includes(trip.status) : false;
  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  if (error && !trip) {
    return (
      <div className="mx-auto max-w-[900px] px-16 py-32">
        <div role="alert" className="pane-note px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error} <Link href="/app/trips" className="underline">Back to trips</Link>
        </div>
      </div>
    );
  }
  if (!trip) {
    return <div className="pane-note mx-auto max-w-[900px] px-16 py-32 text-sm">Loading trip…</div>;
  }

  const hasCoords = trip.origin_lat != null && trip.origin_lng != null && trip.dest_lat != null && trip.dest_lng != null;

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <Link href="/app/trips" className="pane-note text-xs underline">← All trips</Link>
      <div className="mt-12 flex flex-wrap items-center justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
            {trip.reference ?? "Trip"} — {trip.route_name ?? ""}
          </h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            {trip.origin_text ?? trip.origin_region ?? "?"} → {trip.dest_text ?? trip.dest_region ?? "?"}
            {trip.distance_km ? ` · ${fmtNum(trip.distance_km, " km")}` : ""}
          </p>
        </div>
        <span className="badge-plain px-8 py-4 text-[10px] font-bold uppercase"
          style={{ borderLeft: `4px solid ${STATUS_COLORS[trip.status] ?? "rgba(255,255,255,0.6)"}` }}>
          {STATUS_LABELS[trip.status] ?? trip.status}
        </span>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {/* Lifecycle actions */}
      {(NEXT_STATUS[trip.status] ?? []).length > 0 && (
        <div className="mt-16 flex flex-wrap gap-12">
          {(NEXT_STATUS[trip.status] ?? []).map(s => (
            s === "cancelled" ? (
              <button key={s} type="button" disabled={busy}
                onClick={() => transition(s)}
                className="on-photo-btn px-16 py-8 text-xs font-semibold disabled:opacity-50"
                style={{ color: "#ff9d94" }}>
                {ACTION_LABELS[s]}
              </button>
            ) : (
              <button key={s} type="button" disabled={busy}
                onClick={() => transition(s)}
                className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
                {ACTION_LABELS[s]}
              </button>
            )
          ))}
        </div>
      )}

      {/* Summary */}
      <section className={`${card} mt-24`} style={cardStyle}>
        <div className="grid grid-cols-2 gap-12 text-sm">
          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Vessel</p>
            <p style={{ color: "var(--ink)" }}>
              {trip.vessel_name ?? "Unassigned"}
              {trip.capacity_tonnes ? <span style={{ color: "var(--ink-soft)" }}> · {fmtNum(trip.capacity_tonnes, " t")}</span> : null}
            </p>
          </div>
          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Driver</p>
            <p style={{ color: "var(--ink)" }}>{trip.driver_name ?? "Unassigned"}</p>
          </div>
          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Planned</p>
            <p className="tabular-nums" style={{ color: "var(--ink)" }}>
              {fmtDateTime(trip.planned_departure)} → {fmtDateTime(trip.planned_arrival)}
            </p>
          </div>
          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Actual</p>
            <p className="tabular-nums" style={{ color: "var(--ink)" }}>
              {trip.actual_departure ? `Departed ${fmtDateTime(trip.actual_departure)}` : "Not departed"}
              {trip.actual_arrival ? ` · Arrived ${fmtDateTime(trip.actual_arrival)}` : ""}
            </p>
          </div>
          {trip.notes && (
            <div className="col-span-2">
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</p>
              <p style={{ color: "var(--ink)" }}>{trip.notes}</p>
            </div>
          )}
        </div>
      </section>

      {hasCoords && (
        <div className="mt-24 overflow-hidden rounded-card border" style={cardStyle}>
          <div className="h-[280px]">
            <RouteMap
              points={[
                { lat: Number(trip.origin_lat), lng: Number(trip.origin_lng), name: trip.origin_text ?? trip.origin_region ?? "Origin", kind: "origin" },
                { lat: Number(trip.dest_lat), lng: Number(trip.dest_lng), name: trip.dest_text ?? trip.dest_region ?? "Destination", kind: "dest" }
              ]}
              lines={[{
                positions: [[Number(trip.origin_lat), Number(trip.origin_lng)], [Number(trip.dest_lat), Number(trip.dest_lng)]],
                kind: "guess"
              }]}
              center={[(Number(trip.origin_lat) + Number(trip.dest_lat)) / 2, (Number(trip.origin_lng) + Number(trip.dest_lng)) / 2]}
            />
          </div>
        </div>
      )}

      {/* Cargo */}
      <section className="mt-24">
        <div className="flex items-center justify-between">
          <h2 className="pane-note text-sm font-bold uppercase tracking-[0.14em]">
            Cargo ({trip.shipments.length})
          </h2>
          {editable && (
            <button type="button"
              onClick={() => { setShip(EMPTY_SHIPMENT); setEditingShipId(null); setShowShipForm(s => !s); }}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
              {showShipForm ? "Close form" : "+ Add shipment"}
            </button>
          )}
        </div>

        {showShipForm && editable && (
          <form onSubmit={submitShipment} className="mt-16 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
            <div className="grid grid-cols-2 gap-12">
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Customer *</span>
                <input required value={ship.customerName}
                  onChange={e => setShip(f => ({ ...f, customerName: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                  Customer phone{editingShipId ? " — blank keeps current" : ""}
                </span>
                <input value={ship.customerPhone}
                  onChange={e => setShip(f => ({ ...f, customerPhone: e.target.value }))}
                  placeholder="+255712345678" className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Goods</span>
                <input value={ship.goodsDescription}
                  onChange={e => setShip(f => ({ ...f, goodsDescription: e.target.value }))}
                  placeholder="e.g. Cement, 50kg bags" className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Packages</span>
                <input type="number" min={0} step={1} value={ship.packageCount}
                  onChange={e => setShip(f => ({ ...f, packageCount: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Weight (kg)</span>
                <input type="number" min={0} step="0.01" value={ship.weightKg}
                  onChange={e => setShip(f => ({ ...f, weightKg: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Freight charge (TZS)</span>
                <input type="number" min={0} step="0.01" value={ship.freightCharge}
                  onChange={e => setShip(f => ({ ...f, freightCharge: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
              <label className="block col-span-2">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
                <input value={ship.notes}
                  onChange={e => setShip(f => ({ ...f, notes: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
            </div>
            <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
              {busy ? "Saving…" : (editingShipId ? "Save changes" : "Add shipment")}
            </button>
          </form>
        )}

        <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Customer</th><th className="p-12">Goods</th>
                <th className="p-12">Packages</th><th className="p-12">Weight</th>
                <th className="p-12">Freight</th><th></th>
              </tr>
            </thead>
            <tbody>
              {trip.shipments.map((s, i) => (
                <tr key={s.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{s.customer_name}</td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>{s.goods_description ?? "—"}</td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmtNum(s.package_count)}</td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmtNum(s.weight_kg, " kg")}</td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>
                    {s.freight_charge ? `TZS ${Number(s.freight_charge).toLocaleString()}` : "—"}
                  </td>
                  <td className="p-12 text-right whitespace-nowrap">
                    {editable && (
                      <>
                        <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                          onClick={() => startEditShipment(s)}>Edit</button>
                        <button type="button" className="underline" style={{ color: "var(--danger)" }}
                          onClick={() => removeShipment(s.id)}>Remove</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {trip.shipments.length === 0 && (
                <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                  No cargo on this trip yet.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Checkpoint ledger */}
      <section className="mt-24">
        <h2 className="pane-note text-sm font-bold uppercase tracking-[0.14em]">
          Checkpoint log
        </h2>

        {editable && (
          <form onSubmit={addLog} className="mt-16 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
            <div className="grid grid-cols-3 gap-12">
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Checkpoint</span>
                <select value={logCheckpointId}
                  onChange={e => setLogCheckpointId(e.target.value)}
                  className={inputCls} style={inputStyle}>
                  <option value="">Custom…</option>
                  {trip.checkpoints.map(cp => (
                    <option key={cp.id} value={cp.id}>{cp.name}</option>
                  ))}
                </select>
              </label>
              {logCheckpointId ? (
                <div className="col-span-2 flex items-end pb-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  Recording against the selected route checkpoint.
                </div>
              ) : (
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Label *</span>
                  <input required value={logLabel}
                    onChange={e => setLogLabel(e.target.value)}
                    placeholder="e.g. Missing weighbridge stop" className={inputCls} style={inputStyle} />
                </label>
              )}
            </div>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note</span>
              <input value={logNote}
                onChange={e => setLogNote(e.target.value)}
                className={inputCls} style={inputStyle} />
            </label>
            <button type="submit" disabled={busy}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
              {busy ? "Recording…" : "Record checkpoint"}
            </button>
          </form>
        )}

        <div className="mt-16 space-y-8">
          {trip.logs.map((l, i) => (
            <div key={l.id} className="flex items-start justify-between rounded-input border bg-surface px-16 py-12" style={cardStyle}>
              <div className="text-sm">
                <p style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{l.label}</span>
                  <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {KIND_LABELS[l.kind ?? "custom"] ?? l.kind} · {fmtDateTime(l.logged_at)}
                  </span>
                </p>
                {l.note && <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{l.note}</p>}
              </div>
              {editable && (
                <button type="button" className="underline text-xs" style={{ color: "var(--danger)" }}
                  onClick={() => removeLog(l.id)}>Remove</button>
              )}
            </div>
          ))}
          {trip.logs.length === 0 && (
            <p className="pane-note text-sm">
              No checkpoints recorded yet{trip.checkpoints.length > 0 ? ` — ${trip.checkpoints.length} on the route` : ""}.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
