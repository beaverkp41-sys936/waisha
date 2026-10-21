"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  Truck, MapPin, ClipboardList, FileText, X, KeyRound, Route as RouteIcon,
  Fuel, AlertTriangle, UserPlus, Gauge, Wrench
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { WorkshopDesk } from "@/components/WorkshopDesk";
import { apiFetch, seatPermissions } from "../api-client";
import { kindLabel } from "../doc-kinds";
import type { MapPoint } from "../routes/route-map";

const RouteMap = dynamic(() => import("../routes/route-map"), {
  ssr: false,
  loading: () => <p className="pane-note p-16 text-sm">Loading map…</p>
});

interface Vessel {
  id: string; name: string; vessel_type: string; plate_number: string;
  make: string | null; model: string | null; year_manufactured: number | null;
  capacity_tonnes: string | null; fuel_type: string; odometer_km: number;
  status: string; status_reason: string | null; branch_name: string | null; document_status: string;
  imo_number: string | null; home_port: string | null; water_body: string | null;
  gross_weight_kg: string | null; length_m: string | null;
  width_m: string | null; height_m: string | null;
  active_trip_reference: string | null;
  current_driver_id: string | null; current_driver_name: string | null;
  insurance_policy: string | null; insurance_expiry: string | null;
  insurance_expiry_day: string | null; inspection_expiry_day: string | null;
  road_licence_expiry_day: string | null;
  [k: string]: unknown;
}
interface Branch { id: string; name: string; }
interface DriverRow {
  id: string; full_name: string; status: string; licence_status: string;
  assigned_vessel_id: string | null; vessel_name: string | null;
}
interface FleetRow {
  id: string; name: string; plate_number: string; vessel_type: string; status: string;
  odometer_km: number; driver_name: string | null; trip_reference: string | null;
  lat?: string | number | null; lng?: string | number | null; source?: string | null;
  note?: string | null; recorded_at?: string | null; age_seconds?: number | null;
  stale?: boolean;
}
interface Position {
  id: string; lat: string; lng: string; source: string; accuracy_m: number | null;
  odometer_km: number | null; note: string | null; recorded_at: string;
  trip_id: string | null; trip_reference: string | null; age_seconds: number;
}
interface Handover {
  id: string; status: string; started_at: string; ended_at: string | null;
  start_odometer_km: number | null; end_odometer_km: number | null;
  notes: string | null; driver_name: string; driver_id: string;
}
interface LogEntry {
  id: string; entry_date: string; kind: string; title: string; detail: string | null;
  odometer_km: number | null; actor_name: string | null; created_at: string;
}
interface Dossier {
  vessel: Vessel;
  assignment: { current: Handover | null; history: Handover[] };
  position: { latest: Position | null; trail: Position[]; staleAfterSeconds: number } | null;
  logbook: LogEntry[];
  fuel: { logs: any[]; totals: { entries: number; litres: string; cost: string } };
  incidents: any[];
  documents: { id: string; kind: string; file_name: string; mime_type: string; size_bytes: number; created_at: string }[];
  trips: {
    id: string; reference: string; status: string; route_name: string | null;
    driver_name: string | null; distance_km: number | null;
    actual_departure: string | null; planned_departure: string | null;
  }[];
}
interface Perms {
  edit: boolean; create: boolean; retire: boolean;
  trackSee: boolean; trackPost: boolean; seeDocs: boolean; work: boolean;
}

const TYPES: Record<string, string> = {
  truck_head: "Truck Head", trailer: "Trailer", tanker: "Tanker",
  flatbed: "Flatbed", tipper: "Tipper", reefer: "Reefer Truck",
  box_truck: "Box Truck", van: "Van", pickup: "Pickup", lowbed: "Low-bed",
  barge: "Barge", boat: "Boat", rail_wagon: "Rail Wagon",
  cargo_ship: "Cargo Ship", ferry: "Ferry", tank_barge: "Tank Barge"
};
const WATER_TYPES = ["barge", "boat", "cargo_ship", "ferry", "tank_barge"];
const STATUS_COLORS: Record<string, string> = {
  on_route: "var(--success)", standby: "var(--brand)", booked: "var(--gold)",
  in_garage: "var(--warning)", out_of_service: "var(--danger)"
};
const STATUS_LABELS: Record<string, string> = {
  on_route: "On route", standby: "Standby", booked: "Booked",
  in_garage: "In garage", out_of_service: "Out of service"
};
const NEEDS_REASON = ["in_garage", "out_of_service"];
const FUELS: Record<string, string> = {
  diesel: "Diesel", petrol: "Petrol", cng: "CNG", lng: "LNG",
  electric: "Electric", hydrogen: "Hydrogen", hybrid: "Hybrid"
};
const WATER_BODIES: Record<string, string> = {
  lake_victoria: "Lake Victoria", lake_tanganyika: "Lake Tanganyika",
  lake_nyasa: "Lake Nyasa", indian_ocean: "Indian Ocean", river: "River"
};
const LOG_KINDS: Record<string, string> = {
  note: "Note", odometer: "Odometer", service: "Service", inspection: "Inspection",
  paperwork: "Paperwork", movement: "Movement", damage: "Damage"
};
const SOURCE_LABELS: Record<string, string> = {
  device: "Device fix", manual: "Reported by hand",
  trip_departure: "Trip departed", trip_arrival: "Trip arrived"
};

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

/** A pg DATE arrives either as "YYYY-MM-DD" or as a UTC instant that drifted a day. The
 *  plain-day fields the API now sends are parsed at local midnight, so no reading shifts
 *  again in the browser. */
function dayDiff(day: string | null | undefined): number | null {
  if (!day) return null;
  const plain = String(day).slice(0, 10);
  const d = new Date(`${plain}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}
function ago(seconds: number): string {
  if (seconds < 90) return "under a minute ago";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 40) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
function stamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso)
    : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
const num = (v: unknown) => (v == null ? null : Number(v));

const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const tiny = { color: "var(--ink-soft)" };

// ============================================================
// One plate: the dossier
// ============================================================

function PlateDossier({ vesselId, label, perms, drivers, onChanged, onClose }: {
  vesselId: string; label: string; perms: Perms; drivers: DriverRow[];
  onChanged: () => void; onClose: () => void;
}) {
  const [d, setD] = useState<Dossier | null>(null);
  const [tab, setTab] = useState<"held" | "where" | "logbook" | "shop" | "papers" | "work">("held");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pinArmed, setPinArmed] = useState(false);
  const [armedEntry, setArmedEntry] = useState<string | null>(null);

  const [assign, setAssign] = useState({ driverId: "", startOdometerKm: "", notes: "" });
  const [end, setEnd] = useState({ endOdometerKm: "", notes: "" });
  const [pos, setPos] = useState({
    lat: "", lng: "", accuracy: "", odometerKm: "", note: "", when: "", source: "manual"
  });
  const [log, setLog] = useState({
    kind: "note", title: "", detail: "", entryDate: "", odometerKm: "", actorName: ""
  });

  // The dossier is opened by identity: a slow read for the plate before this one must not
  // paint over the plate now showing.
  const reqId = useRef(vesselId);
  reqId.current = vesselId;
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const mine = vesselId;
    const res = await apiFetch(`/vessels/${mine}/dossier`);
    if (!res.ok) {
      if (reqId.current === mine) setErr(errorText(await res.json().catch(() => ({})), "Could not open this plate."));
      return;
    }
    const j = await res.json();
    if (reqId.current !== mine) return;
    setD(j);
    setErr(null);
  }, [vesselId]);

  useEffect(() => { setD(null); setErr(null); setMsg(null); load(); }, [load]);

  async function send(path: string, body: unknown): Promise<string | null> {
    setBusy(true);
    try {
      const res = await apiFetch(path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) return errorText(await res.json().catch(() => ({})), "Failed.");
      await load(); onChanged();
      return null;
    } finally { setBusy(false); }
  }

  async function drop(path: string): Promise<void> {
    setBusy(true);
    try {
      const res = await apiFetch(path, { method: "DELETE" });
      if (!res.ok) { setErr(errorText(await res.json().catch(() => ({})), "Failed.")); return; }
      setMsg("Entry retired."); await load(); onChanged();
    } finally { setBusy(false); }
  }

  // Two taps, not a native dialog: a browser pass driven over this page cannot answer
  // window.confirm, and an in-page arm/act is the branded shape the reports desk uses.
  function askDrop(id: string, path: string) {
    if (armTimer.current) clearTimeout(armTimer.current);
    if (armedEntry !== id) {
      setArmedEntry(id);
      armTimer.current = setTimeout(() => setArmedEntry(null), 6000);
      return;
    }
    setArmedEntry(null);
    void drop(path);
  }

  function useDevice() {
    if (!("geolocation" in navigator)) { setErr("This browser will not report a location."); return; }
    setBusy(true); setErr(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPos(x => ({
          ...x, source: "device",
          lat: p.coords.latitude.toFixed(5), lng: p.coords.longitude.toFixed(5),
          accuracy: String(Math.round(p.coords.accuracy))
        }));
        setBusy(false);
      },
      (e) => { setErr(`The device would not say where it is (${e.message}).`); setBusy(false); },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  }

  const freshAfter = d?.position?.staleAfterSeconds ?? 21600;

  // Newest first. The newest dot takes the fresh colour only while it is still fresh — a
  // trail that paints a three-day-old report as live is the map lying about the truck.
  const trail: MapPoint[] = useMemo(() => (d?.position?.trail ?? [])
    .filter(p => num(p.lat) != null && num(p.lng) != null)
    .map((p, i) => ({
      lat: Number(p.lat), lng: Number(p.lng),
      kind: (i === 0 && p.age_seconds <= freshAfter ? "truck" : "truck_old") as MapPoint["kind"],
      name: SOURCE_LABELS[p.source] ?? p.source,
      detail: `${ago(p.age_seconds)}${p.note ? ` — ${p.note}` : ""}`
    })), [d, freshAfter]);

  const latestStale = !!d?.position?.latest && d.position.latest.age_seconds > freshAfter;

  function done(m: string) { setMsg(m); setErr(null); }

  const TABS = [
    { key: "held" as const, label: "Who holds it", icon: UserPlus, show: true },
    { key: "where" as const, label: "Where it is", icon: MapPin, show: !!d?.position || !!perms.trackSee },
    { key: "logbook" as const, label: "Logbook", icon: ClipboardList, show: true },
    { key: "shop" as const, label: "Workshop", icon: Wrench, show: perms.work },
    { key: "papers" as const, label: "Papers", icon: KeyRound, show: true },
    { key: "work" as const, label: "Trips, fuel, incidents", icon: RouteIcon, show: true }
  ];

  return (
    <section className="mb-32 rounded-card border bg-surface p-24"
      style={{ borderColor: "var(--gold)" }} aria-label={`File for ${label}`}>
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div>
          <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>
            {d?.vessel.name ?? label}
          </h2>
          <p className="mt-4 text-xs" style={tiny}>
            {d ? `${TYPES[d.vessel.vessel_type] ?? d.vessel.vessel_type} · ${d.vessel.plate_number} · `
              + `${(d.vessel.odometer_km ?? 0).toLocaleString()} km · held by `
              + (d.assignment.current ? d.assignment.current.driver_name : "nobody right now")
              + ` · ${STATUS_LABELS[d.vessel.status] ?? d.vessel.status}`
              // A plate off the road says why — the desk asked for the reason when it wrote it.
              + (d.vessel.status_reason ? `: ${d.vessel.status_reason}` : "")
              : "Loading this plate…"}
          </p>
        </div>
        <button type="button" onClick={onClose}
          className="flex items-center gap-6 rounded-input border px-12 py-6 text-xs font-semibold"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
          <X aria-hidden style={{ width: 14, height: 14 }} />Close file
        </button>
      </div>

      <div className="tabs mt-16" role="tablist" aria-label="Vessel file sections">
        {TABS.filter(t => t.show).map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
            onClick={() => { setTab(t.key); setErr(null); setMsg(null); }}
            className="tab"><t.icon aria-hidden />{t.label}</button>
        ))}
      </div>

      {err && <div role="alert" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{err}</div>}
      {msg && <div role="status" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{msg}</div>}

      {!d && <p className="pane-note mt-16 p-12 text-sm">Loading every register for this plate…</p>}

      {d && tab === "held" && (
        <div className="mt-20 space-y-20">
          <div>
            <p className="pv-title"><UserPlus aria-hidden />Current handover</p>
            {d.assignment.current ? (
              <div className="rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
                <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                  {d.assignment.current.driver_name}
                </p>
                <p className="mt-6 text-xs" style={tiny}>
                  Since {stamp(d.assignment.current.started_at)}
                  {d.assignment.current.start_odometer_km != null
                    ? ` · handed over at ${Number(d.assignment.current.start_odometer_km).toLocaleString()} km` : ""}
                  {d.assignment.current.notes ? ` · ${d.assignment.current.notes}` : ""}
                </p>
                {perms.edit && (
                  <div className="mt-14 grid gap-10 sm:grid-cols-3">
                    <label className="block">
                      <span className={labelCls} style={tiny}>Return reading (km)</span>
                      <input type="number" min={0} value={end.endOdometerKm}
                        onChange={e => setEnd(x => ({ ...x, endOdometerKm: e.target.value }))}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className={labelCls} style={tiny}>Condition on return</span>
                      <input value={end.notes} onChange={e => setEnd(x => ({ ...x, notes: e.target.value }))}
                        placeholder="e.g. back from Dar, windscreen chipped" className={inputCls} style={inputStyle} />
                    </label>
                    <button type="button" disabled={busy}
                      className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-60 sm:col-span-3"
                      onClick={async () => {
                        const bad = await send(`/vessels/${vesselId}/assignments/${d.assignment.current!.id}/end`, {
                          endOdometerKm: end.endOdometerKm === "" ? null : Number(end.endOdometerKm),
                          notes: end.notes || null
                        });
                        if (bad) { setErr(bad); return; }
                        setEnd({ endOdometerKm: "", notes: "" });
                        done("Handover closed. The register keeps it as history.");
                      }}>End handover</button>
                  </div>
                )}
              </div>
            ) : <p className="pane-note text-sm">Nobody holds this vehicle right now.</p>}
          </div>

          {perms.edit && !d.assignment.current && (
            <div>
              <p className="pv-title">Hand it over</p>
              <div className="grid gap-10 sm:grid-cols-3">
                <label className="block">
                  <span className={labelCls} style={tiny}>Driver</span>
                  <select value={assign.driverId} onChange={e => setAssign(x => ({ ...x, driverId: e.target.value }))}
                    className={inputCls} style={inputStyle}>
                    <option value="">Select a driver</option>
                    {drivers.map(dr => (
                      <option key={dr.id} value={dr.id} disabled={dr.status === "suspended"}>
                        {dr.full_name}{dr.status === "suspended" ? " (suspended)" : ""}
                        {dr.vessel_name ? ` — holds ${dr.vessel_name}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>Odometer at handover</span>
                  <input type="number" min={0} placeholder={String(d.vessel.odometer_km ?? 0)}
                    value={assign.startOdometerKm}
                    onChange={e => setAssign(x => ({ ...x, startOdometerKm: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>Notes</span>
                  <input value={assign.notes} onChange={e => setAssign(x => ({ ...x, notes: e.target.value }))}
                    placeholder="e.g. keys + spare at front desk" className={inputCls} style={inputStyle} />
                </label>
                <button type="button" disabled={busy || !assign.driverId}
                  className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-60 sm:col-span-3"
                  onClick={async () => {
                    const bad = await send(`/vessels/${vesselId}/assignments`, {
                      driverId: assign.driverId,
                      startOdometerKm: assign.startOdometerKm === "" ? null : Number(assign.startOdometerKm),
                      notes: assign.notes || null
                    });
                    if (bad) { setErr(bad); return; }
                    setAssign({ driverId: "", startOdometerKm: "", notes: "" });
                    done("Handed over. The vehicle now has a name against it.");
                  }}>Assign driver</button>
              </div>
              <p className="pane-note mt-10 text-xs">
                One driver per vehicle and one vehicle per driver. The register refuses a
                handover that breaks either, and an odometer reading below the one already on
                the plate.
              </p>
            </div>
          )}

          <div>
            <p className="pv-title">Handover register</p>
            {d.assignment.history.length === 0 && <p className="pane-note text-sm">No handover on record for this plate.</p>}
            {d.assignment.history.length > 0 && (
              <div className="overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--line)", ...tiny }}>
                      <th className="p-10">Driver</th><th className="p-10">From</th>
                      <th className="p-10">To</th><th className="p-10">Readings</th>
                      <th className="p-10">Distance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.assignment.history.map(h => (
                      <tr key={h.id} className="border-b last:border-0" style={{ borderColor: "var(--line)" }}>
                        <td className="p-10 font-semibold" style={{ color: "var(--ink)" }}>
                          {h.driver_name}
                          {h.status === "active" && (
                            <span className="ml-8 text-[10px] font-bold uppercase" style={{ color: "var(--success)" }}>holding</span>
                          )}
                        </td>
                        <td className="p-10" style={tiny}>{stamp(h.started_at)}</td>
                        <td className="p-10" style={tiny}>{h.ended_at ? stamp(h.ended_at) : "—"}</td>
                        <td className="p-10 tabular-nums" style={tiny}>
                          {h.start_odometer_km != null ? Number(h.start_odometer_km).toLocaleString() : "?"}
                          {" → "}
                          {h.end_odometer_km != null ? Number(h.end_odometer_km).toLocaleString() : "?"}
                        </td>
                        <td className="p-10 tabular-nums" style={tiny}>
                          {h.end_odometer_km != null && h.start_odometer_km != null
                            ? `${(Number(h.end_odometer_km) - Number(h.start_odometer_km)).toLocaleString()} km` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {d && tab === "where" && (
        <div className="mt-20 space-y-20">
          {!d.position ? (
            <p className="pane-note text-sm">
              This seat does not hold the tracking duty, so the position ledger is not part of
              the file it can open.
            </p>
          ) : (
            <>
              <div>
                <p className="pv-title"><MapPin aria-hidden />Last reported</p>
                {d.position.latest ? (
                  <p className="text-sm" style={{ color: "var(--ink)" }}>
                    {latestStale ? "Last seen " : ""}
                    {SOURCE_LABELS[d.position.latest.source] ?? d.position.latest.source}
                    {" "}{ago(d.position.latest.age_seconds)}
                    {d.position.latest.note ? ` — ${d.position.latest.note}` : ""}
                    {d.position.latest.trip_reference ? ` (trip ${d.position.latest.trip_reference})` : ""}
                  </p>
                ) : <p className="pane-note text-sm">Nobody has ever reported where this vehicle is.</p>}
                {latestStale && (
                  <p role="status" className="mt-8 px-12 py-6 text-xs"
                    style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
                    Older than {Math.round(freshAfter / 3600)} hours — this is history, not a live position.
                  </p>
                )}
              </div>

              {(trail.length > 0 || perms.trackPost) && (
                <div className="rounded-card border overflow-hidden" style={{ borderColor: "var(--line)" }}>
                  <div className="h-[300px] w-full">
                    <RouteMap points={trail} center={trail.length ? [trail[0].lat, trail[0].lng] : undefined}
                      zoom={trail.length === 1 ? 9 : 6}
                      onPin={pinArmed && perms.trackPost ? (lat, lng) => {
                        if (lat < -20 || lat > 5 || lng < 25 || lng > 45) {
                          setErr("That point is outside the corridors this platform plans, so it cannot be filed as a position.");
                          return;
                        }
                        setPos(x => ({ ...x, lat: lat.toFixed(5), lng: lng.toFixed(5) }));
                        setPinArmed(false); setErr(null);
                      } : undefined} />
                  </div>
                  {trail.length > 0 && (
                    <p className="pane-note p-10 text-[11px]">
                      Every dot is a report, in order — a word from a driver, a device fix filed
                      at a desk, or the leg a trip recorded by itself. Nothing here comes from a
                      tracker fitted to the vehicle, because there is not one.
                    </p>
                  )}
                  {trail.length === 0 && (
                    <p className="pane-note p-10 text-[11px]">
                      No report on file for this plate yet. Arm “Pin on map” below, or use the
                      coordinates, and the first dot appears here.
                    </p>
                  )}
                </div>
              )}

              {perms.trackPost && (
                <div>
                  <p className="pv-title">Report a position</p>
                  <div className="grid gap-10 sm:grid-cols-3">
                    <label className="block">
                      <span className={labelCls} style={tiny}>Latitude</span>
                      <input type="number" step="0.00001" value={pos.lat}
                        onChange={e => setPos(x => ({ ...x, lat: e.target.value, source: "manual" }))}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={tiny}>Longitude</span>
                      <input type="number" step="0.00001" value={pos.lng}
                        onChange={e => setPos(x => ({ ...x, lng: e.target.value, source: "manual" }))}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={tiny}>Reported at (blank = now)</span>
                      <input type="datetime-local" value={pos.when}
                        onChange={e => setPos(x => ({ ...x, when: e.target.value }))}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={tiny}>Odometer (optional)</span>
                      <input type="number" min={0} value={pos.odometerKm}
                        onChange={e => setPos(x => ({ ...x, odometerKm: e.target.value }))}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className={labelCls} style={tiny}>What is known — town, call, condition</span>
                      <input value={pos.note} onChange={e => setPos(x => ({ ...x, note: e.target.value }))}
                        placeholder="e.g. phoned from Malade gate, queueing to cross" className={inputCls} style={inputStyle} />
                    </label>
                    <div className="flex flex-wrap gap-10 sm:col-span-3">
                      <button type="button" onClick={useDevice} disabled={busy}
                        className="rounded-input border px-14 py-8 text-xs font-semibold disabled:opacity-60"
                        style={{ borderColor: "var(--brand)", color: "var(--brand)" }}>
                        Use my device location
                      </button>
                      <button type="button" onClick={() => { setPinArmed(a => !a); setMsg(null); }}
                        className="rounded-input border px-14 py-8 text-xs font-semibold"
                        style={{ borderColor: "var(--gold)", color: "var(--gold)" }}>
                        {pinArmed ? "Click the map above" : "Pin on map"}
                      </button>
                      <button type="button" disabled={busy || pos.lat === "" || pos.lng === ""}
                        className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-60"
                        onClick={async () => {
                          const bad = await send(`/vessels/${vesselId}/positions`, {
                            lat: Number(pos.lat), lng: Number(pos.lng), source: pos.source,
                            accuracyM: pos.accuracy === "" ? null : Number(pos.accuracy),
                            odometerKm: pos.odometerKm === "" ? null : Number(pos.odometerKm),
                            note: pos.note || null,
                            recordedAt: pos.when ? new Date(pos.when).toISOString() : null
                          });
                          if (bad) { setErr(bad); return; }
                          setPos({ lat: "", lng: "", accuracy: "", odometerKm: "", note: "", when: "", source: "manual" });
                          done("Position filed. The ledger keeps every report, including this one.");
                        }}>File position</button>
                    </div>
                  </div>
                  <p className="pane-note mt-10 text-xs">
                    “Device fix” is where the browser reporting it stands — use it beside the
                    vehicle. Where a driver says he is, file it as reported by hand and say so
                    in the note. A report is never overwritten: correcting one is a new row.
                  </p>
                </div>
              )}

              <div>
                <p className="pv-title">The trail</p>
                {d.position.trail.length === 0 && <p className="pane-note text-sm">No reports yet.</p>}
                {d.position.trail.map((p, i) => (
                  <div key={p.id} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                    style={{ borderColor: "var(--line)" }}>
                    <span className="font-semibold" style={{ color: "var(--ink)" }}>
                      {SOURCE_LABELS[p.source] ?? p.source}
                    </span>
                    <span style={tiny}>{stamp(p.recorded_at)} · {ago(p.age_seconds)}</span>
                    <span className="tabular-nums" style={tiny}>
                      {Number(p.lat).toFixed(4)}, {Number(p.lng).toFixed(4)}
                    </span>
                    {p.odometer_km != null && <span className="tabular-nums" style={tiny}>{Number(p.odometer_km).toLocaleString()} km</span>}
                    {p.accuracy_m != null && <span style={tiny}>±{p.accuracy_m} m</span>}
                    {p.age_seconds > freshAfter && (
                      <span className="text-[10px] font-bold uppercase" style={{ color: "var(--warning)" }}>stale</span>
                    )}
                    {p.note && <span style={{ color: "var(--ink)" }}>{p.note}</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {d && tab === "logbook" && (
        <div className="mt-20 space-y-20">
          {perms.create && (
            <div>
              <p className="pv-title"><ClipboardList aria-hidden />Write in the book</p>
              <div className="grid gap-10 sm:grid-cols-3">
                <label className="block">
                  <span className={labelCls} style={tiny}>Kind</span>
                  <select value={log.kind} onChange={e => setLog(x => ({ ...x, kind: e.target.value }))}
                    className={inputCls} style={inputStyle}>
                    {Object.entries(LOG_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
                <label className="block sm:col-span-2">
                  <span className={labelCls} style={tiny}>What happened *</span>
                  <input value={log.title} onChange={e => setLog(x => ({ ...x, title: e.target.value }))}
                    placeholder="e.g. Front brake shoes replaced at Uwanja" className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>Date</span>
                  <input type="date" value={log.entryDate}
                    onChange={e => setLog(x => ({ ...x, entryDate: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>
                    Odometer{log.kind === "odometer" ? " *" : " (optional)"}
                  </span>
                  <input type="number" min={0} value={log.odometerKm}
                    onChange={e => setLog(x => ({ ...x, odometerKm: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={tiny}>Who did it / said it</span>
                  <input value={log.actorName} onChange={e => setLog(x => ({ ...x, actorName: e.target.value }))}
                    placeholder="e.g. J. Mushi" className={inputCls} style={inputStyle} />
                </label>
                <label className="block sm:col-span-3">
                  <span className={labelCls} style={tiny}>Detail</span>
                  <textarea rows={2} value={log.detail}
                    onChange={e => setLog(x => ({ ...x, detail: e.target.value }))}
                    className={inputCls} style={inputStyle} />
                </label>
                <button type="button" disabled={busy || log.title.trim().length < 2
                  || (log.kind === "odometer" && log.odometerKm === "")}
                  className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-60 sm:col-span-3"
                  onClick={async () => {
                    const bad = await send(`/vessels/${vesselId}/logbook`, {
                      kind: log.kind, title: log.title.trim(),
                      detail: log.detail || null, entryDate: log.entryDate || undefined,
                      odometerKm: log.odometerKm === "" ? null : Number(log.odometerKm),
                      actorName: log.actorName || null
                    });
                    if (bad) { setErr(bad); return; }
                    setLog({ kind: "note", title: "", detail: "", entryDate: "", odometerKm: "", actorName: "" });
                    done("Filed in the logbook.");
                  }}>File entry</button>
              </div>
              <p className="pane-note mt-10 text-xs">
                Money does not belong in a logbook — fuel and repair costs keep their own
                registers. A reading above the one on the plate moves the plate, so the odometer
                is only ever written once.
              </p>
            </div>
          )}

          <div>
            <p className="pv-title">Entries</p>
            {d.logbook.length === 0 && <p className="pane-note text-sm">Nothing has been written against this plate yet.</p>}
            {d.logbook.map(e => (
              <div key={e.id} className="flex flex-wrap items-baseline gap-8 border-b py-10 text-xs last:border-0"
                style={{ borderColor: "var(--line)" }}>
                <span className="px-8 py-4 text-[10px] font-bold uppercase"
                  style={{ borderLeft: "4px solid var(--navy)", color: "var(--ink)" }}>
                  {LOG_KINDS[e.kind] ?? e.kind}
                </span>
                <span style={tiny}>{e.entry_date}</span>
                <span className="font-semibold" style={{ color: "var(--ink)" }}>{e.title}</span>
                {e.odometer_km != null && (
                  <span className="flex items-center gap-4 tabular-nums" style={tiny}>
                    <Gauge aria-hidden style={{ width: 13, height: 13 }} />
                    {Number(e.odometer_km).toLocaleString()} km
                  </span>
                )}
                {e.actor_name && <span style={tiny}>{e.actor_name}</span>}
                {e.detail && <span className="basis-full" style={{ color: "var(--ink)" }}>{e.detail}</span>}
                {perms.retire && (
                  <button type="button" className="ml-auto rounded-input border px-8 py-4 text-[11px] font-semibold"
                    style={{
                      borderColor: armedEntry === e.id ? "var(--danger)" : "transparent",
                      color: "var(--danger)"
                    }}
                    onClick={() => askDrop(e.id, `/vessels/${vesselId}/logbook/${e.id}`)}>
                    {armedEntry === e.id ? "Tap again to retire" : "Retire"}
                  </button>
                )}
                {armedEntry === e.id && (
                  <span className="basis-full text-right text-[10px]" style={tiny}>
                    The line stays in the register as retired — append a correcting entry instead if it was wrong.
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {d && tab === "papers" && (
        <div className="mt-20 space-y-20">
          <div>
            <p className="pv-title"><KeyRound aria-hidden />Dates on record</p>
            <dl className="kv">
              <dt>Insurance</dt>
              <dd>
                <PaperCell day={d.vessel.insurance_expiry_day} extra={d.vessel.insurance_policy
                  ? `policy ${d.vessel.insurance_policy}` : null} />
              </dd>
              <dt>Inspection</dt><dd><PaperCell day={d.vessel.inspection_expiry_day} /></dd>
              <dt>Road licence</dt><dd><PaperCell day={d.vessel.road_licence_expiry_day} /></dd>
            </dl>
            <p className="pane-note mt-10 text-xs">
              Edit these dates on the vessel form — a paper renewed is a date changed, and the
              register of what was done about it belongs in the logbook.
            </p>
          </div>
          <div>
            <p className="pv-title"><FileText aria-hidden />Files</p>
            {d.documents.length === 0 && <p className="pane-note text-sm">No document is filed against this plate.</p>}
            {d.documents.map(doc => (
              <div key={doc.id} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                style={{ borderColor: "var(--line)" }}>
                <span className="font-semibold" style={{ color: "var(--ink)" }}>{doc.file_name}</span>
                <span style={tiny}>{kindLabel(doc.kind)}</span>
                <span style={tiny}>{(doc.size_bytes / 1024).toFixed(0)} kB · {stamp(doc.created_at)}</span>
                {perms.seeDocs && (
                  <button type="button" className="underline" style={{ color: "var(--brand)" }}
                    onClick={async () => {
                      const res = await apiFetch(`/documents/${doc.id}/url`);
                      const j = await res.json().catch(() => ({}));
                      if (!res.ok || !j?.url) { setErr(errorText(j, "Could not open the file.")); return; }
                      window.open(j.url, "_blank", "noopener,noreferrer");
                    }}>Open</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Not gated on `d`: the register is its own read, and a plate whose dossier failed to
          load still has work orders the desk can open. */}
      {tab === "shop" && (
        <div className="mt-20">
          <WorkshopDesk vesselId={vesselId} plateLabel={label} onChanged={load} />
        </div>
      )}

      {d && tab === "work" && (
        <div className="mt-20 space-y-20">
          <div>
            <p className="pv-title"><RouteIcon aria-hidden />Trips</p>
            {d.trips.length === 0 && <p className="pane-note text-sm">No trip has run on this plate.</p>}
            {d.trips.map(t => (
              <div key={t.id} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                style={{ borderColor: "var(--line)" }}>
                <span className="font-semibold" style={{ color: "var(--ink)" }}>{t.reference}</span>
                <span style={tiny}>{t.route_name ?? "—"}</span>
                <span style={tiny}>{t.driver_name ?? "no driver"}</span>
                {t.distance_km != null && <span className="tabular-nums" style={tiny}>{t.distance_km} km</span>}
                <span className="uppercase" style={{ color: STATUS_COLORS[t.status] ?? "var(--ink-soft)" }}>{t.status}</span>
                <span style={tiny}>{stamp(t.actual_departure ?? t.planned_departure)}</span>
              </div>
            ))}
          </div>
          <div>
            <p className="pv-title"><Fuel aria-hidden />Fuel</p>
            <p className="text-xs" style={tiny}>
              {d.fuel.totals.entries} logs · {Number(d.fuel.totals.litres).toLocaleString()} litres
              · {Number(d.fuel.totals.cost).toLocaleString()} TZS recorded
            </p>
            {d.fuel.logs.slice(0, 10).map(f => (
              <div key={f.id} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                style={{ borderColor: "var(--line)" }}>
                <span style={tiny}>{f.log_date}</span>
                <span className="tabular-nums font-semibold" style={{ color: "var(--ink)" }}>
                  {Number(f.litres).toLocaleString()} L
                </span>
                {f.station && <span style={tiny}>{f.station}</span>}
                {f.odometer_km != null && (
                  <span className="tabular-nums" style={tiny}>{Number(f.odometer_km).toLocaleString()} km</span>
                )}
                {f.total_cost != null && (
                  <span className="tabular-nums" style={tiny}>{Number(f.total_cost).toLocaleString()} TZS</span>
                )}
              </div>
            ))}
          </div>
          <div>
            <p className="pv-title"><AlertTriangle aria-hidden />Incidents</p>
            {d.incidents.length === 0 && <p className="pane-note text-sm">No incident on record for this plate.</p>}
            {d.incidents.map(ic => (
              <div key={ic.id} className="flex flex-wrap items-baseline gap-8 border-b py-8 text-xs last:border-0"
                style={{ borderColor: "var(--line)" }}>
                <span style={tiny}>{ic.incident_date}</span>
                <span className="font-semibold uppercase" style={{ color: "var(--ink)" }}>{ic.type}</span>
                <span className="uppercase"
                  style={{ color: ic.severity === "critical" ? "var(--danger)" : ic.severity === "major" ? "var(--warning)" : "var(--ink-soft)" }}>
                  {ic.severity}
                </span>
                {ic.location && <span style={tiny}>{ic.location}</span>}
                <span className="basis-full" style={{ color: "var(--ink)" }}>{ic.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function PaperCell({ day, extra }: { day: string | null | undefined; extra?: string | null }) {
  if (!day) return <span style={{ color: "var(--danger)", fontWeight: 700 }}>Not on record</span>;
  const diff = dayDiff(day);
  const tone = diff == null ? "ok" : diff < 0 ? "bad" : diff <= 30 ? "warn" : "ok";
  const color = tone === "bad" ? "var(--danger)" : tone === "warn" ? "var(--warning)" : "var(--ink)";
  const words = diff == null ? "" : diff < 0 ? ` · lapsed ${Math.abs(diff)} days ago`
    : diff === 0 ? " · lapses today" : ` · ${diff} days left`;
  return (
    <span style={{ color }}>
      {String(day).slice(0, 10)}{words}
      {extra && <span className="block text-[11px]" style={tiny}>{extra}</span>}
    </span>
  );
}

// ============================================================
// The fleet page
// ============================================================

export default function FleetPage() {
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [fleetRows, setFleetRows] = useState<FleetRow[]>([]);
  const [located, setLocated] = useState(false);
  const [staleAfter, setStaleAfter] = useState(21600);
  const [perms, setPerms] = useState<Perms>({
    edit: false, create: false, retire: false,
    trackSee: false, trackPost: false, seeDocs: false, work: false
  });
  const [fleetLimit, setFleetLimit] = useState<number | null>(null);
  const [fleetUsed, setFleetUsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [armedRemove, setArmedRemove] = useState<string | null>(null);
  const [pending, setPending] = useState<{ vessel: Vessel; status: string } | null>(null);
  const [reason, setReason] = useState("");
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [form, setForm] = useState<Record<string, any>>({
    name: "", vesselType: "truck_head", plateNumber: "", make: "", model: "",
    yearManufactured: "", capacityTonnes: "", fuelType: "diesel",
    grossWeightKg: "", lengthM: "", widthM: "", heightM: "",
    branchId: "", insuranceExpiry: "", inspectionExpiry: "", roadLicenceExpiry: "",
    imoNumber: "", homePort: "", waterBody: ""
  });

  const load = useCallback(async () => {
    const res = await apiFetch("/vessels");
    if (res.ok) {
      const j = await res.json();
      setVessels(j.vessels);
      setFleetLimit(j.fleetLimit);
      setFleetUsed(j.fleetUsed);
    }
    const b = await apiFetch("/branches");
    if (b.ok) setBranches(await b.json());
    const t = await apiFetch("/tracking/fleet");
    if (t.ok) {
      const j = await t.json();
      setLocated(!!j.located);
      setStaleAfter(j.staleAfterSeconds ?? 21600);
      setFleetRows(j.vessels);
    }
    // The assignee picker labels who holds what, so it is re-read with the fleet rows.
    // A once-at-mount snapshot goes on naming a driver who has already handed the plate back.
    const dr = await apiFetch("/drivers");
    if (dr.ok) setDrivers(await dr.json());
  }, []);

  useEffect(() => {
    load();
    seatPermissions().then(keys => setPerms({
      edit: keys.has("fleet.edit"), create: keys.has("fleet.create"),
      retire: keys.has("fleet.delete"), trackSee: keys.has("tracking.view"),
      trackPost: keys.has("tracking.create"), seeDocs: keys.has("documents.view"),
      // The workshop tab is a duty of its own: a desk that may open a plate's file has no
      // business seeing what the vehicle costs to keep unless it holds the register's key.
      work: keys.has("work_orders.view")
    }));
  }, [load]);

  const isWater = WATER_TYPES.includes(form.vesselType);
  const trialBlocked = fleetLimit !== null && fleetUsed >= fleetLimit;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      // Presence-based PUT: an empty field clears the stored value.
      const payload = {
        name: form.name, vesselType: form.vesselType, plateNumber: form.plateNumber,
        make: form.make || null, model: form.model || null,
        yearManufactured: form.yearManufactured ? Number(form.yearManufactured) : null,
        capacityTonnes: form.capacityTonnes ? Number(form.capacityTonnes) : null,
        grossWeightKg: form.grossWeightKg ? Number(form.grossWeightKg) : null,
        lengthM: form.lengthM ? Number(form.lengthM) : null,
        widthM: form.widthM ? Number(form.widthM) : null,
        heightM: form.heightM ? Number(form.heightM) : null,
        fuelType: form.fuelType,
        branchId: form.branchId || null,
        insuranceExpiry: form.insuranceExpiry || null,
        inspectionExpiry: form.inspectionExpiry || null,
        roadLicenceExpiry: form.roadLicenceExpiry || null,
        imoNumber: isWater ? (form.imoNumber || null) : null,
        homePort: isWater ? (form.homePort || null) : null,
        waterBody: isWater ? (form.waterBody || null) : null
      };
      const res = await apiFetch(editingId ? `/vessels/${editingId}` : "/vessels", {
        method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed")); return; }
      setNotice(editingId ? `Vessel "${form.name}" updated.` : `Vessel "${form.name}" registered.`);
      setShowForm(false);
      setEditingId(null);
      setForm(f => ({ ...f, name: "", plateNumber: "", make: "", model: "", yearManufactured: "", capacityTonnes: "" }));
      load();
    } finally { setBusy(false); }
  }

  function startEdit(v: Vessel) {
    setEditingId(v.id);
    setForm(f => ({
      ...f,
      name: v.name ?? "", vesselType: v.vessel_type ?? "truck_head",
      plateNumber: v.plate_number ?? "", make: v.make ?? "", model: v.model ?? "",
      yearManufactured: v.year_manufactured ? String(v.year_manufactured) : "",
      capacityTonnes: v.capacity_tonnes ?? "",
      grossWeightKg: v.gross_weight_kg ?? "", lengthM: v.length_m ?? "",
      widthM: v.width_m ?? "", heightM: v.height_m ?? "",
      insuranceExpiry: v.insurance_expiry_day ?? "",
      inspectionExpiry: v.inspection_expiry_day ?? "",
      roadLicenceExpiry: v.road_licence_expiry_day ?? "",
      branchId: (v.branch_id as string) ?? "",
      imoNumber: v.imo_number ?? "", homePort: v.home_port ?? "", waterBody: v.water_body ?? ""
    }));
    setError(null); setNotice(null); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function changeStatus(v: Vessel, status: string) {
    setError(null); setNotice(null);
    // A garage or out-of-service word needs a reason, so it is asked for in the page
    // rather than in a native prompt the desk cannot answer.
    if (NEEDS_REASON.includes(status)) { setPending({ vessel: v, status }); setReason(""); return; }
    void writeStatus(v, status);
  }

  async function writeStatus(v: Vessel, status: string, why?: string) {
    setError(null); setNotice(null);
    // The dedicated route: PUT /vessels/:id has no status branch, and writing the field
    // there used to land an audit row while the status stayed exactly where it was.
    const res = await apiFetch(`/vessels/${v.id}/status`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, statusReason: why?.trim() || undefined })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Failed to change the status.")); return; }
    setPending(null);
    setNotice(`${v.name} marked ${STATUS_LABELS[status] ?? status}.`);
    load();
  }

  async function remove(v: Vessel) {
    setError(null);
    const res = await apiFetch(`/vessels/${v.id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Failed to remove.")); return; }
    if (openId === v.id) setOpenId(null);
    setNotice(`${v.name} removed from the fleet.`);
    load();
  }

  // Same two-tap shape as the logbook line: the first tap arms, the second removes.
  function askRemove(v: Vessel) {
    if (armTimer.current) clearTimeout(armTimer.current);
    if (armedRemove !== v.id) {
      setArmedRemove(v.id);
      armTimer.current = setTimeout(() => setArmedRemove(null), 6000);
      return;
    }
    setArmedRemove(null);
    void remove(v);
  }

  const byId = useMemo(() => {
    const m = new Map<string, FleetRow>();
    fleetRows.forEach(r => m.set(r.id, r));
    return m;
  }, [fleetRows]);

  const mapPoints = useMemo<MapPoint[]>(() => fleetRows
    .filter(r => num(r.lat) != null && num(r.lng) != null)
    .map(r => ({
      lat: Number(r.lat), lng: Number(r.lng),
      kind: (r.stale ? "truck_old" : "truck") as MapPoint["kind"],
      name: `${r.name} · ${r.plate_number}`,
      detail: [r.driver_name ? `held by ${r.driver_name}` : "nobody holds it",
        r.age_seconds != null ? ago(r.age_seconds) : "",
        SOURCE_LABELS[r.source ?? ""] ?? ""].filter(Boolean).join(" · ")
    })), [fleetRows]);
  const mapOrder = useMemo(
    () => fleetRows.filter(r => num(r.lat) != null && num(r.lng) != null).map(r => r.id),
    [fleetRows]);

  const counts = useMemo(() => {
    const fresh = fleetRows.filter(r => r.age_seconds != null && !r.stale).length;
    const stale = fleetRows.filter(r => r.age_seconds != null && r.stale).length;
    return {
      total: vessels.length,
      held: vessels.filter(v => v.current_driver_id).length,
      fresh, stale,
      silent: fleetRows.filter(r => r.age_seconds == null).length,
      onRoute: vessels.filter(v => v.status === "on_route").length,
      garage: vessels.filter(v => v.status === "in_garage" || v.status === "out_of_service").length,
      papersBad: vessels.filter(v => v.document_status === "expired").length,
      papersWarn: vessels.filter(v => v.document_status === "expiring").length
    };
  }, [vessels, fleetRows]);

  function openFile(id: string) {
    setOpenId(cur => (cur === id ? null : id));
    setError(null);
  }
  useEffect(() => {
    if (!openId) return;
    const el = document.getElementById(`dossier-${openId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [openId]);

  const openVessel = openId ? vessels.find(v => v.id === openId) : undefined;

  return (
    <div className="mx-auto max-w-[1080px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Fleet</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Vessels and marine units — road, lake and sea. Who holds each one, where it was last
            reported, and everything written against its plate.
          </p>
        </div>
        {perms.create && (
          <button type="button" onClick={() => { setEditingId(null); setShowForm(s => !s); }}
            className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
            {showForm ? "Close form" : "+ Add vessel"}
          </button>
        )}
      </div>

      <div className="mt-20 grid grid-cols-2 gap-10 sm:grid-cols-4">
        <Stat label="Vehicles" value={counts.total} note={counts.garage ? `${counts.garage} in garage or off` : "all available"} />
        <Stat label="Held by a driver" value={counts.held} note={`${counts.total - counts.held} nobody holds`} />
        <Stat label="On route" value={counts.onRoute}
          note={located ? (counts.silent ? `${counts.silent} never reported` : "every one has reported") : undefined} />
        <Stat label="Papers" value={counts.papersBad + counts.papersWarn}
          tone={counts.papersBad ? "bad" : counts.papersWarn ? "warn" : "ok"}
          note={counts.papersBad ? `${counts.papersBad} lapsed, ${counts.papersWarn} lapsing soon`
            : counts.papersWarn ? `${counts.papersWarn} lapsing within 30 days` : "all in date"} />
      </div>

      {fleetLimit !== null && (
        <div role="status" className="mt-16 mb-16 px-16 py-8 text-sm font-semibold"
          style={{ background: "var(--warning)", color: "var(--on-solid)" }}>
          Trial fleet: {fleetUsed} of {fleetLimit} vessels used — Activate a licence for unlimited fleet.
        </div>
      )}
      {trialBlocked && showForm && (
        <div role="alert" className="mb-16 px-16 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 10%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          Trial fleet limit reached ({fleetLimit} vessels). Activate a licence to add more.
        </div>
      )}

      {error && <div role="alert" className="mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {showForm && (
        <form onSubmit={submit} className="mb-32 space-y-12 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Vessel type</span>
              <select value={form.vesselType} onChange={e => setForm(f => ({ ...f, vesselType: e.target.value }))}
                className={inputCls} style={inputStyle}>
                {Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Name / Call sign *</span>
              <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Nyegezi Express" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                {isWater ? "Registration / IMO number *" : "Plate number *"}
              </span>
              <input required value={form.plateNumber} onChange={e => setForm(f => ({ ...f, plateNumber: e.target.value }))}
                placeholder={isWater ? "e.g. MV-2024-001" : "e.g. T 123 ABC"} className={inputCls} style={inputStyle} />
            </label>
            {isWater && (<>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>IMO number</span>
                <input value={form.imoNumber} onChange={e => setForm(f => ({ ...f, imoNumber: e.target.value }))} className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Home port</span>
                <input value={form.homePort} onChange={e => setForm(f => ({ ...f, homePort: e.target.value }))}
                  placeholder="e.g. Mwanza North Port" className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Water body</span>
                <select value={form.waterBody} onChange={e => setForm(f => ({ ...f, waterBody: e.target.value }))} className={inputCls} style={inputStyle}>
                  <option value="">Select</option>
                  {Object.entries(WATER_BODIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
            </>)}
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Make</span>
              <input value={form.make} onChange={e => setForm(f => ({ ...f, make: e.target.value }))}
                placeholder={isWater ? "e.g. Karimjee shipyard" : "e.g. Isuzu"} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Model</span>
              <input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Year</span>
              <input type="number" min={1950} max={2100} value={form.yearManufactured}
                onChange={e => setForm(f => ({ ...f, yearManufactured: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Capacity (tonnes)</span>
              <input type="number" step="0.01" min={0} value={form.capacityTonnes}
                onChange={e => setForm(f => ({ ...f, capacityTonnes: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Gross weight (kg)</span>
              <input type="number" step="0.01" min={0} value={form.grossWeightKg}
                onChange={e => setForm(f => ({ ...f, grossWeightKg: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Length (m)</span>
              <input type="number" step="0.01" min={0} value={form.lengthM}
                onChange={e => setForm(f => ({ ...f, lengthM: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Width (m)</span>
              <input type="number" step="0.01" min={0} value={form.widthM}
                onChange={e => setForm(f => ({ ...f, widthM: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Height (m)</span>
              <input type="number" step="0.01" min={0} value={form.heightM}
                onChange={e => setForm(f => ({ ...f, heightM: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Fuel</span>
              <select value={form.fuelType} onChange={e => setForm(f => ({ ...f, fuelType: e.target.value }))} className={inputCls} style={inputStyle}>
                {Object.entries(FUELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Home branch</span>
              <select value={form.branchId} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))} className={inputCls} style={inputStyle}>
                <option value="">Select</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Insurance expiry</span>
              <input type="date" value={form.insuranceExpiry} onChange={e => setForm(f => ({ ...f, insuranceExpiry: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Inspection expiry</span>
              <input type="date" value={form.inspectionExpiry} onChange={e => setForm(f => ({ ...f, inspectionExpiry: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Road licence expiry</span>
              <input type="date" value={form.roadLicenceExpiry} onChange={e => setForm(f => ({ ...f, roadLicenceExpiry: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
          </div>
          <button type="submit" disabled={trialBlocked || busy}
            className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving" : (editingId ? "Save changes" : "Register vessel")}
          </button>
        </form>
      )}

      {perms.trackSee && (
        <div className="mb-24 rounded-card border bg-surface p-20" style={{ borderColor: "var(--line)" }}>
          <div className="flex flex-wrap items-center justify-between gap-10">
            <p className="pv-title mb-0"><MapPin aria-hidden />Where the fleet is</p>
            <button type="button" onClick={() => { load(); setNotice(null); }}
              className="rounded-input border px-12 py-6 text-[11px] font-semibold"
              style={{ borderColor: "var(--brand)", color: "var(--brand)" }}>Refresh reports</button>
          </div>
          {mapPoints.length > 0 ? (
            <>
              <div className="mt-14 h-[340px] w-full overflow-hidden rounded-input border"
                style={{ borderColor: "var(--line)" }}>
                <RouteMap points={mapPoints} onPick={(i) => openFile(mapOrder[i])} />
              </div>
              <p className="pane-note mt-10 text-[11px]">
                {counts.fresh} reported within {Math.round(staleAfter / 3600)} hours,
                {" "}{counts.stale} older than that and drawn grey,
                {" "}{counts.silent} with no report ever filed — those show in the list below,
                not on the map, because there is nothing honest to place. Click a marker to open
                the plate.
              </p>
            </>
          ) : (
            <p className="pane-note mt-12 text-sm">
              Nothing on this fleet has a position on record yet. Open a plate and file one —
              a report from a driver counts, and a trip records its own ends once the route has
              coordinates.
            </p>
          )}
        </div>
      )}

      {openId && openVessel && (
        <div id={`dossier-${openId}`}>
          <PlateDossier vesselId={openId} label={`${openVessel.name} · ${openVessel.plate_number}`}
            perms={perms} drivers={drivers} onChanged={load} onClose={() => setOpenId(null)} />
        </div>
      )}

      <div className="overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Name</th><th className="p-12">Type</th>
              <th className="p-12">Reg/Plate</th><th className="p-12">Held by</th>
              <th className="p-12">Capacity</th><th className="p-12">Status</th>
              {perms.trackSee && <th className="p-12">Last reported</th>}
              <th className="p-12">Docs</th><th className="p-12 text-right">File</th>
            </tr>
          </thead>
          <tbody>
            {vessels.map((v, i) => {
              const r = byId.get(v.id);
              return (
                <tr key={v.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{v.name}</td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>{TYPES[v.vessel_type] ?? v.vessel_type}</td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{v.plate_number}</td>
                  <td className="p-12" style={{ color: v.current_driver_name ? "var(--ink)" : "var(--ink-soft)" }}>
                    {v.current_driver_name ?? "—"}
                    <span className="block text-[10px] tabular-nums" style={tiny}>
                      {(v.odometer_km ?? 0).toLocaleString()} km
                    </span>
                  </td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                    {v.capacity_tonnes ? `${Number(v.capacity_tonnes).toLocaleString()} t` : "—"}
                    {(v.length_m || v.width_m || v.height_m) && (
                      <span className="block text-xs">
                        {[v.length_m, v.width_m, v.height_m].filter(Boolean).map(n => Number(n)).join(" × ")} m
                      </span>
                    )}
                    {v.gross_weight_kg && <span className="block text-xs">{Number(v.gross_weight_kg).toLocaleString()} kg GVW</span>}
                  </td>
                  <td className="p-12">
                    <span className="px-8 py-4 text-[10px] font-bold uppercase"
                      style={{ borderLeft: `4px solid ${STATUS_COLORS[v.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                      {STATUS_LABELS[v.status] ?? v.status}
                    </span>
                    {v.status_reason && (
                      <span className="mt-4 block text-[10px]" style={tiny}>
                        {v.status_reason}
                      </span>
                    )}
                    {v.active_trip_reference && (
                      <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        Trip {v.active_trip_reference}
                      </span>
                    )}
                  </td>
                  {perms.trackSee && (
                    <td className="p-12 text-xs" style={tiny}>
                      {r?.age_seconds != null ? (
                        <>
                          <span style={{ color: r.stale ? "var(--warning)" : "var(--success)" }}>
                            {ago(r.age_seconds)}
                          </span>
                          <span className="block">{SOURCE_LABELS[r.source ?? ""] ?? r.source}</span>
                        </>
                      ) : <span>No report</span>}
                    </td>
                  )}
                  <td className="p-12">
                    {v.document_status === "expired" && (
                      <span className="px-8 py-4 text-[10px] font-bold uppercase"
                        style={{ borderLeft: "4px solid var(--danger)", color: "var(--danger)" }}>
                        Lapsed
                      </span>
                    )}
                    {v.document_status === "expiring" && (
                      <span className="px-8 py-4 text-[10px] font-bold uppercase"
                        style={{ borderLeft: "4px solid var(--warning)", color: "var(--warning)" }}>
                        Expiring
                      </span>
                    )}
                    {v.document_status === "ok" && <span style={{ color: "var(--ink-soft)" }}>OK</span>}
                  </td>
                  <td className="p-12 text-right whitespace-nowrap">
                    <button type="button" className="mr-12 rounded-input border px-10 py-4 text-[11px] font-semibold"
                      style={{
                        borderColor: openId === v.id ? "var(--gold)" : "var(--line)",
                        color: openId === v.id ? "var(--gold)" : "var(--ink)"
                      }}
                      onClick={() => openFile(v.id)}>
                      <Truck aria-hidden style={{ display: "inline", width: 13, height: 13, marginRight: 5 }} />
                      {openId === v.id ? "In file" : "Open file"}
                    </button>
                    {perms.edit && (
                      <select defaultValue="" aria-label={`Status for ${v.name}`}
                        onChange={e => { if (e.target.value) changeStatus(v, e.target.value); e.target.value = ""; }}
                        className="rounded-input border px-8 py-4 text-xs mr-8"
                        style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                        <option value="">Set status…</option>
                        {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    )}
                    {perms.edit && (
                      <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                        onClick={() => startEdit(v)}>Edit</button>
                    )}
                    {perms.retire && (
                      <>
                        <button type="button" className="rounded-input border px-8 py-4 text-[11px] font-semibold"
                          style={{
                            borderColor: armedRemove === v.id ? "var(--danger)" : "transparent",
                            color: "var(--danger)"
                          }}
                          onClick={() => askRemove(v)}>
                          {armedRemove === v.id ? "Tap again to remove" : "Remove"}
                        </button>
                        {armedRemove === v.id && (
                          <span className="mt-6 block text-[10px] font-normal whitespace-normal" style={tiny}>
                            It stays in the register as deleted; its trips, fuel logs and handovers are kept.
                          </span>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {vessels.length === 0 && (
              <EmptyState colSpan={perms.trackSee ? 9 : 8} icon={Truck} title="No vessels yet"
                hint="Register your first truck, trailer or ship — everything you move is tied to a vessel."
                action={perms.create
                  ? { label: "Add a vessel", onClick: () => { setEditingId(null); setShowForm(true); } } : undefined} />
            )}
          </tbody>
        </table>
      </div>

      {pending && (
        <div className="mt-16 rounded-card border p-16" style={{ borderColor: "var(--gold)", background: "var(--surface)" }}>
          <label className="block">
            <span className={labelCls} style={tiny}>
              Reason for marking {pending.vessel.name} {STATUS_LABELS[pending.status] ?? pending.status} *
            </span>
            <input value={reason} maxLength={200} autoFocus
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Gearbox rebuild booked at the garage" className={inputCls} style={inputStyle} />
          </label>
          <div className="mt-12 flex flex-wrap items-center gap-12">
            <button type="button" disabled={busy}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-60"
              onClick={() => writeStatus(pending.vessel, pending.status, reason)}>
              Mark it {STATUS_LABELS[pending.status] ?? pending.status}
            </button>
            <button type="button" className="underline" style={{ color: "var(--ink-soft)" }}
              onClick={() => setPending(null)}>Cancel</button>
          </div>
          <p className="pane-note mt-10 text-xs">
            The why is asked for because the plate leaves the road on it — the reason is stored
            beside the status and carried into the audit line.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, note, tone }: {
  label: string; value: number; note?: string; tone?: "ok" | "warn" | "bad";
}) {
  const color = tone === "bad" ? "var(--danger)" : tone === "warn" ? "var(--warning)" : "var(--ink)";
  return (
    <div className="rounded-card border bg-surface p-14" style={{ borderColor: "var(--line)" }}>
      <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={tiny}>{label}</p>
      <p className="mt-6 text-xl font-extrabold tabular-nums" style={{ color }}>{value}</p>
      {note && <p className="mt-4 text-[11px]" style={tiny}>{note}</p>}
    </div>
  );
}
