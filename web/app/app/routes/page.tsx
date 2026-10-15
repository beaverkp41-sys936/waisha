"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Route } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { apiFetch } from "../api-client";

const RouteMap = dynamic(() => import("./route-map"), {
  ssr: false,
  loading: () => <p className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>Loading map…</p>
});

interface Region { id: number; name_en: string; }
interface RegionCoords { id: number; code: string; name_en: string; lat: number; lng: number; }
interface District { id: number; name_en: string; }
interface Ward { id: number; name: string; }
interface BorderPost { id: number; name: string; country_a: string; country_b: string; }
interface Checkpoint { id: string; seq: number; kind: string; name: string; }
interface RouteRow {
  id: string; name: string; corridor: string | null;
  origin_text: string | null; dest_text: string | null;
  distance_km: number | null; rate_per_km: string | null; rate_per_tonne: string | null;
  rate_per_trip: string | null; border_post_name: string | null;
  checkpoint_count: number; is_active: boolean;
  origin_lat: number | null; origin_lng: number | null;
  dest_lat: number | null; dest_lng: number | null;
}
interface RouteForm {
  name: string; corridor: string;
  originRegionId: string; originDistrictId: string; originWardId: string; originText: string;
  destRegionId: string; destDistrictId: string; destWardId: string; destText: string;
  borderPostId: string; distanceKm: string; expectedDurationHours: string;
  roadClass: string; riskNotes: string; seasonalNotes: string;
  ratePerKm: string; ratePerTonne: string; ratePerTrip: string;
}
interface RouteDetail { id: string; name: string; checkpoints: Checkpoint[]; }
type Kind = "weighbridge" | "border" | "toll" | "fuel" | "rest" | "town";

const KIND_LABELS: Record<Kind, string> = {
  weighbridge: "Weighbridge", border: "Border", toll: "Toll",
  fuel: "Fuel station", rest: "Rest point", town: "Town"
};

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)) * 1.25);
}

const EMPTY_FORM: RouteForm = {
  name: "", corridor: "",
  originRegionId: "", originDistrictId: "", originWardId: "", originText: "",
  destRegionId: "", destDistrictId: "", destWardId: "", destText: "",
  borderPostId: "", distanceKm: "", expectedDurationHours: "",
  roadClass: "", riskNotes: "", seasonalNotes: "",
  ratePerKm: "", ratePerTonne: "", ratePerTrip: ""
};

export default function RoutesPage() {
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [regionCoords, setRegionCoords] = useState<RegionCoords[]>([]);
  const [borderPosts, setBorderPosts] = useState<BorderPost[]>([]);
  const [originDistricts, setOriginDistricts] = useState<District[]>([]);
  const [destDistricts, setDestDistricts] = useState<District[]>([]);
  const [originWards, setOriginWards] = useState<Ward[]>([]);
  const [destWards, setDestWards] = useState<Ward[]>([]);
  const [routeGeometry, setRouteGeometry] = useState<[number, number][] | null>(null);
  const [osrmStatus, setOsrmStatus] = useState<"idle" | "loading" | "road" | "failed">("idle");
  const [osrmAttempt, setOsrmAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RouteDetail | null>(null);
  const [cp, setCp] = useState({ kind: "weighbridge" as Kind, name: "" });
  const [form, setForm] = useState<RouteForm>(EMPTY_FORM);

  const load = useCallback(async () => {
    const res = await apiFetch("/routes");
    if (res.ok) setRoutes(await res.json());
  }, []);

  useEffect(() => {
    (async () => {
      const g = await apiFetch("/geo/regions");
      if (g.ok) setRegions(await g.json());
      const b = await apiFetch("/geo/border-posts");
      if (b.ok) setBorderPosts(await b.json());
      const rc = await apiFetch("/geo/region-coords");
      if (rc.ok) setRegionCoords(await rc.json());
      load();
    })();
  }, [load]);

  async function pickRegion(side: "origin" | "dest", v: string) {
    if (side === "origin") {
      setForm(f => ({ ...f, originRegionId: v, originDistrictId: "", originWardId: "" }));
      setOriginDistricts([]); setOriginWards([]);
    } else {
      setForm(f => ({ ...f, destRegionId: v, destDistrictId: "", destWardId: "" }));
      setDestDistricts([]); setDestWards([]);
    }
    setRouteGeometry(null);
    setOsrmStatus("idle");
    if (v) {
      const d = await apiFetch(`/geo/districts/${v}`);
      if (side === "origin") { if (d.ok) setOriginDistricts(await d.json()); }
      else { if (d.ok) setDestDistricts(await d.json()); }
    }
  }

  async function pickOriginDistrict(v: string) {
    setForm(f => ({ ...f, originDistrictId: v, originWardId: "" }));
    setOriginWards([]);
    if (v) { const w = await apiFetch(`/geo/wards/${v}`); if (w.ok) setOriginWards(await w.json()); }
  }
  async function pickDestDistrict(v: string) {
    setForm(f => ({ ...f, destDistrictId: v, destWardId: "" }));
    setDestWards([]);
    if (v) { const w = await apiFetch(`/geo/wards/${v}`); if (w.ok) setDestWards(await w.json()); }
  }

  // Haversine: instant estimate when both regions are picked...
  useEffect(() => {
    if (!form.originRegionId || !form.destRegionId) { setRouteGeometry(null); setOsrmStatus("idle"); return; }
    const a = regionCoords.find(r => r.id === Number(form.originRegionId));
    const b = regionCoords.find(r => r.id === Number(form.destRegionId));
    if (!a || !b) { setRouteGeometry(null); return; }
    const aLat = Number(a.lat), aLng = Number(a.lng);
    const bLat = Number(b.lat), bLng = Number(b.lng);
    if ([aLat, aLng, bLat, bLng].some(Number.isNaN)) { setRouteGeometry(null); return; }
    setForm(f => ({ ...f, distanceKm: String(haversineKm(aLat, aLng, bLat, bLng)) }));
  }, [form.originRegionId, form.destRegionId, regionCoords]);

  // OSRM via our API proxy: real road path + exact km, cached server-side.
  // Falls back to the haversine estimate on failure (visible with Retry).
  useEffect(() => {
    if (!form.originRegionId || !form.destRegionId) { setRouteGeometry(null); setOsrmStatus("idle"); return; }
    const a = regionCoords.find(r => r.id === Number(form.originRegionId));
    const b = regionCoords.find(r => r.id === Number(form.destRegionId));
    if (!a || !b) { setRouteGeometry(null); setOsrmStatus("idle"); return; }
    const aLat = Number(a.lat), aLng = Number(a.lng);
    const bLat = Number(b.lat), bLng = Number(b.lng);
    if ([aLat, aLng, bLat, bLng].some(Number.isNaN)) { setRouteGeometry(null); setOsrmStatus("idle"); return; }

    let cancelled = false;
    setOsrmStatus("loading");
    (async () => {
      try {
        const res = await apiFetch(`/geo/road-route?oLat=${aLat}&oLng=${aLng}&dLat=${bLat}&dLng=${bLng}`);
        if (cancelled) return;
        if (!res.ok) { setOsrmStatus("failed"); return; }
        const j = await res.json();
        setRouteGeometry(j.geometry?.length > 1 ? j.geometry : null);
        setOsrmStatus("road");
        if (j.distanceKm > 0) setForm(f => ({
          ...f,
          distanceKm: String(j.distanceKm),
          expectedDurationHours: f.expectedDurationHours || String(j.durationHours)
        }));
      } catch (e: any) {
        if (!cancelled && e.message !== "session ended") setOsrmStatus("failed");
      }
    })();
    return () => { cancelled = true; };
  }, [form.originRegionId, form.destRegionId, regionCoords, osrmAttempt]);

  function resetForm() {
    setForm(EMPTY_FORM);
    setOriginDistricts([]); setDestDistricts([]);
    setOriginWards([]); setDestWards([]);
    setRouteGeometry(null);
    setOsrmStatus("idle");
    setEditingId(null);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const payload = {
        name: form.name, corridor: form.corridor || undefined,
        originRegionId: form.originRegionId ? Number(form.originRegionId) : null,
        originDistrictId: form.originDistrictId ? Number(form.originDistrictId) : null,
        originWardId: form.originWardId ? Number(form.originWardId) : null,
        originText: form.originText || undefined,
        destRegionId: form.destRegionId ? Number(form.destRegionId) : null,
        destDistrictId: form.destDistrictId ? Number(form.destDistrictId) : null,
        destWardId: form.destWardId ? Number(form.destWardId) : null,
        destText: form.destText || undefined,
        borderPostId: form.borderPostId ? Number(form.borderPostId) : null,
        distanceKm: form.distanceKm ? Number(form.distanceKm) : undefined,
        expectedDurationHours: form.expectedDurationHours ? Number(form.expectedDurationHours) : undefined,
        roadClass: form.roadClass || undefined,
        riskNotes: form.riskNotes || undefined,
        seasonalNotes: form.seasonalNotes || undefined,
        ratePerKm: form.ratePerKm ? Number(form.ratePerKm) : undefined,
        ratePerTonne: form.ratePerTonne ? Number(form.ratePerTonne) : undefined,
        ratePerTrip: form.ratePerTrip ? Number(form.ratePerTrip) : undefined
      };
      const res = editingId
        ? await apiFetch(`/routes/${editingId}`, { method: "PUT",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await apiFetch("/routes", { method: "POST",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed")); return; }
      setNotice(`Route "${form.name}" ${editingId ? "updated" : "created"}.`);
      resetForm(); setShowForm(false);
      load();
    } finally { setBusy(false); }
  }

  async function openDetail(r: { id: string; name: string }) {
    const res = await apiFetch(`/routes/${r.id}`);
    if (res.ok) {
      const j = await res.json();
      setDetail({ id: r.id, name: r.name, checkpoints: j.checkpoints ?? [] });
    }
  }

  async function removeRoute(id: string) {
    await apiFetch(`/routes/${id}`, { method: "DELETE" });
    if (detail?.id === id) setDetail(null);
    load();
  }

  async function addCheckpoint() {
    if (!detail || !cp.name.trim()) return;
    const res = await apiFetch(`/routes/${detail.id}/checkpoints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: cp.kind, name: cp.name.trim() })
    });
    if (res.ok) { setCp({ kind: cp.kind, name: "" }); openDetail({ ...detail }); }
  }

  async function removeCheckpoint(cpId: string) {
    if (!detail) return;
    await apiFetch(`/routes/${detail.id}/checkpoints/${cpId}`, { method: "DELETE" });
    openDetail(detail);
  }

  // Map coordinates — coerce pg numeric strings to numbers, guard against NaN
  const formMarkers = useMemo(() => {
    const a = regionCoords.find(r => r.id === Number(form.originRegionId));
    const b = regionCoords.find(r => r.id === Number(form.destRegionId));
    if (!a || !b) return null;
    const aLat = Number(a.lat), aLng = Number(a.lng);
    const bLat = Number(b.lat), bLng = Number(b.lng);
    if (Number.isNaN(aLat) || Number.isNaN(aLng) || Number.isNaN(bLat) || Number.isNaN(bLng)) return null;
    return { a: { ...a, lat: aLat, lng: aLng }, b: { ...b, lat: bLat, lng: bLng },
      center: [(aLat + bLat) / 2, (aLng + bLng) / 2] as [number, number] };
  }, [form.originRegionId, form.destRegionId, regionCoords]);

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Routes</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Corridors your fleet runs — with checkpoints, border posts and rates.
          </p>
        </div>
        <button type="button" onClick={() => { setShowForm(s => !s); if (!showForm) resetForm(); }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ New route"}
        </button>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {showForm && (
        <form onSubmit={submit} className="mt-24 space-y-12 rounded-card border bg-surface p-24" style={{ borderColor: editingId ? "var(--gold)" : "var(--line)" }}>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Route name *</span>
              <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Dar es Salaam - Kigali" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Corridor</span>
              <input value={form.corridor} onChange={e => setForm(f => ({ ...f, corridor: e.target.value }))}
                placeholder="e.g. Central Corridor" className={inputCls} style={inputStyle} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Origin region</span>
              <select value={form.originRegionId} onChange={e => pickRegion("origin", e.target.value)} className={inputCls} style={inputStyle}>
                <option value="">Select</option>
                {regions.map(r => <option key={r.id} value={r.id}>{r.name_en}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Origin council</span>
              <select value={form.originDistrictId} onChange={e => pickOriginDistrict(e.target.value)}
                disabled={!form.originRegionId} className={inputCls} style={{ ...inputStyle, opacity: form.originRegionId ? 1 : 0.5 }}>
                <option value="">{form.originRegionId ? "Select" : "Pick region"}</option>
                {originDistricts.map(d => <option key={d.id} value={d.id}>{d.name_en}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Origin ward (Kata)</span>
              <select value={form.originWardId} onChange={e => setForm(f => ({ ...f, originWardId: e.target.value }))}
                disabled={!form.originDistrictId} className={inputCls} style={{ ...inputStyle, opacity: form.originDistrictId ? 1 : 0.5 }}>
                <option value="">{form.originDistrictId ? "Select" : "Pick council"}</option>
                {originWards.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Origin (free text / town)</span>
              <input value={form.originText} onChange={e => setForm(f => ({ ...f, originText: e.target.value }))}
                placeholder="e.g. Dar es Salaam Port" className={inputCls} style={inputStyle} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Destination region</span>
              <select value={form.destRegionId} onChange={e => pickRegion("dest", e.target.value)} className={inputCls} style={inputStyle}>
                <option value="">Select</option>
                {regions.map(r => <option key={r.id} value={r.id}>{r.name_en}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Destination council</span>
              <select value={form.destDistrictId} onChange={e => pickDestDistrict(e.target.value)}
                disabled={!form.destRegionId} className={inputCls} style={{ ...inputStyle, opacity: form.destRegionId ? 1 : 0.5 }}>
                <option value="">{form.destRegionId ? "Select" : "Pick region"}</option>
                {destDistricts.map(d => <option key={d.id} value={d.id}>{d.name_en}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Destination ward (Kata)</span>
              <select value={form.destWardId} onChange={e => setForm(f => ({ ...f, destWardId: e.target.value }))}
                disabled={!form.destDistrictId} className={inputCls} style={{ ...inputStyle, opacity: form.destDistrictId ? 1 : 0.5 }}>
                <option value="">{form.destDistrictId ? "Select" : "Pick council"}</option>
                {destWards.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Destination (free text / town)</span>
              <input value={form.destText} onChange={e => setForm(f => ({ ...f, destText: e.target.value }))}
                placeholder="e.g. Kigali" className={inputCls} style={inputStyle} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Border post (if cross-border)</span>
              <select value={form.borderPostId} onChange={e => setForm(f => ({ ...f, borderPostId: e.target.value }))} className={inputCls} style={inputStyle}>
                <option value="">None / domestic</option>
                {borderPosts.map(b => <option key={b.id} value={b.id}>{b.name} ({b.country_a}-{b.country_b})</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Distance (km) {form.distanceKm && <span style={{ color: "var(--brand)" }}>— {routeGeometry ? "road distance (OSRM)" : "estimate"}, editable</span>}
              </span>
              <input type="number" min={0} value={form.distanceKm} onChange={e => setForm(f => ({ ...f, distanceKm: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Expected duration (hours)</span>
              <input type="number" min={0} value={form.expectedDurationHours} onChange={e => setForm(f => ({ ...f, expectedDurationHours: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Road class</span>
              <input value={form.roadClass} onChange={e => setForm(f => ({ ...f, roadClass: e.target.value }))}
                placeholder="e.g. Tarmac trunk" className={inputCls} style={inputStyle} />
            </label>
          </div>

          {formMarkers && (
            <div className="rounded-card overflow-hidden" style={{ height: 320, border: "1px solid var(--line)" }}>
              <RouteMap
                a={{ lat: formMarkers.a.lat, lng: formMarkers.a.lng, name: formMarkers.a.name_en }}
                b={{ lat: formMarkers.b.lat, lng: formMarkers.b.lng, name: formMarkers.b.name_en }}
                center={formMarkers.center}
                positions={routeGeometry ?? undefined}
              />
            </div>
          )}
          {formMarkers && (
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
              {osrmStatus === "loading" && "Loading real road routing…"}
              {osrmStatus === "road" && "Solid line: the actual road route (OSRM)."}
              {osrmStatus === "failed" && (
                <>Road routing unavailable right now — showing the straight-line estimate ({form.distanceKm} km).{" "}
                  <button type="button" className="underline" style={{ color: "var(--brand)" }}
                    onClick={() => setOsrmAttempt(a => a + 1)}>Retry</button>
                </>
              )}
              {osrmStatus === "idle" && "Pick origin and destination to calculate the route."}
            </p>
          )}

          <div className="grid grid-cols-3 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Rate per km (TZS)</span>
              <input type="number" step="0.01" min={0} value={form.ratePerKm} onChange={e => setForm(f => ({ ...f, ratePerKm: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Rate per tonne (TZS)</span>
              <input type="number" step="0.01" min={0} value={form.ratePerTonne} onChange={e => setForm(f => ({ ...f, ratePerTonne: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Rate per trip (TZS)</span>
              <input type="number" step="0.01" min={0} value={form.ratePerTrip} onChange={e => setForm(f => ({ ...f, ratePerTrip: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Risk notes</span>
              <input value={form.riskNotes} onChange={e => setForm(f => ({ ...f, riskNotes: e.target.value }))}
                placeholder="e.g. Livestock crossings near Longido" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Seasonal notes</span>
              <input value={form.seasonalNotes} onChange={e => setForm(f => ({ ...f, seasonalNotes: e.target.value }))}
                placeholder="e.g. Passable year-round; care in rains Mar-May" className={inputCls} style={inputStyle} />
            </label>
          </div>
          <div className="flex gap-8">
            <button type="submit" disabled={busy} className="waisha-btn flex-1 rounded-input py-12 text-sm font-semibold disabled:opacity-60">
              {busy ? "Saving" : editingId ? "Update route" : "Create route"}
            </button>
            <button type="button" onClick={() => { resetForm(); setShowForm(false); }}
              className="rounded-input border px-16 py-12 text-sm font-semibold" style={{ borderColor: "var(--line)" }}>Cancel</button>
          </div>
        </form>
      )}

      <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Route</th><th className="p-12">Corridor</th>
              <th className="p-12">Distance</th><th className="p-12">Border</th>
              <th className="p-12">Checkpoints</th><th className="p-12">Rate/km</th><th></th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r, i) => (
              <tr key={r.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{r.name}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{r.corridor ?? "—"}</td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{r.distance_km ? `${r.distance_km.toLocaleString()} km` : "—"}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{r.border_post_name ?? "—"}</td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{r.checkpoint_count}</td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{r.rate_per_km ? `${Number(r.rate_per_km).toLocaleString()}` : "—"}</td>
                <td className="p-12 text-right whitespace-nowrap">
                  <button type="button" className="underline mr-16" style={{ color: "var(--brand)" }} onClick={() => openDetail(r)}>Checkpoints</button>
                  <button type="button" className="underline mr-16" style={{ color: "var(--brand)" }}
                    onClick={async () => {
                      setEditingId(r.id); setShowForm(true);
                      setError(null); setNotice(null);
                      const res = await apiFetch(`/routes/${r.id}`);
                      if (res.ok) {
                        const j = await res.json();
                        setForm(f => ({ ...f,
                          name: j.name, corridor: j.corridor ?? "",
                          originRegionId: j.origin_region_id ? String(j.origin_region_id) : "",
                          originDistrictId: j.origin_district_id ? String(j.origin_district_id) : "",
                          originWardId: j.origin_ward_id ? String(j.origin_ward_id) : "",
                          originText: j.origin_text ?? "",
                          destRegionId: j.dest_region_id ? String(j.dest_region_id) : "",
                          destDistrictId: j.dest_district_id ? String(j.dest_district_id) : "",
                          destWardId: j.dest_ward_id ? String(j.dest_ward_id) : "",
                          destText: j.dest_text ?? "",
                          borderPostId: j.border_post_id ? String(j.border_post_id) : "",
                          distanceKm: j.distance_km ? String(j.distance_km) : "",
                          expectedDurationHours: j.expected_duration_hours ? String(j.expected_duration_hours) : "",
                          roadClass: j.road_class ?? "", riskNotes: j.risk_notes ?? "",
                          seasonalNotes: j.seasonal_notes ?? "",
                          ratePerKm: j.rate_per_km ? String(j.rate_per_km) : "",
                          ratePerTonne: j.rate_per_tonne ? String(j.rate_per_tonne) : "",
                          ratePerTrip: j.rate_per_trip ? String(j.rate_per_trip) : ""
                        }));
                        if (j.origin_region_id) { const d = await apiFetch(`/geo/districts/${j.origin_region_id}`); if (d.ok) setOriginDistricts(await d.json()); }
                        if (j.origin_district_id) { const w = await apiFetch(`/geo/wards/${j.origin_district_id}`); if (w.ok) setOriginWards(await w.json()); }
                        if (j.dest_region_id) { const d = await apiFetch(`/geo/districts/${j.dest_region_id}`); if (d.ok) setDestDistricts(await d.json()); }
                        if (j.dest_district_id) { const w = await apiFetch(`/geo/wards/${j.dest_district_id}`); if (w.ok) setDestWards(await w.json()); }
                      }
                      window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button>
                  <button type="button" className="underline" style={{ color: "var(--danger)" }} onClick={() => removeRoute(r.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {routes.length === 0 && (
              <EmptyState colSpan={7} icon={Route} title="No routes yet"
                hint="Map the corridors you run — ward to port, lake to road — so shippers can find you."
                action={{ label: "Create a route", onClick: () => { resetForm(); setShowForm(true); } }} />
            )}
          </tbody>
        </table>
      </div>

      {detail && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-16"
          style={{ background: "rgba(5,18,26,0.6)" }}>
          <div className="w-full max-w-[460px] rounded-modal bg-surface p-24" style={{ border: "1px solid var(--line)" }}>
            <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>Checkpoints — {detail.name}</h2>
            <p className="mt-4 mb-16 text-xs" style={{ color: "var(--ink-soft)" }}>
              Ordered stops along the route. Weighbridges report here during trips.
            </p>
            <div className="mb-16">
              {detail.checkpoints.length === 0 && (
                <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No checkpoints yet — add the first stop below.</p>
              )}
              {detail.checkpoints.map(cp => (
                <div key={cp.id} className="flex items-center gap-12 border-t py-8" style={{ borderColor: "var(--line)" }}>
                  <span className="text-xs font-bold tabular-nums" style={{ color: "var(--brand)" }}>{cp.seq}.</span>
                  <span className="text-[10px] font-bold uppercase tracking-[0.1em] px-8 py-2"
                    style={{ borderLeft: `4px solid ${cp.kind === "weighbridge" ? "var(--warning)" : cp.kind === "border" ? "var(--danger)" : "var(--brand)"}`,
                      color: "var(--ink-soft)" }}>{KIND_LABELS[cp.kind as Kind] ?? cp.kind}</span>
                  <span className="flex-1 text-sm" style={{ color: "var(--ink)" }}>{cp.name}</span>
                  <button type="button" className="underline text-xs" style={{ color: "var(--danger)" }}
                    onClick={() => removeCheckpoint(cp.id)}>Remove</button>
                </div>
              ))}
            </div>
            <div className="space-y-8 border-t pt-16" style={{ borderColor: "var(--line)" }}>
              <div className="grid grid-cols-2 gap-8">
                <select value={cp.kind} onChange={e => setCp(c => ({ ...c, kind: e.target.value as Kind }))}
                  className={inputCls} style={inputStyle}>
                  {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
                <input value={cp.name} onChange={e => setCp(c => ({ ...c, name: e.target.value }))}
                  placeholder="e.g. Nyegezi Weighbridge" className={inputCls} style={inputStyle} />
              </div>
              <button type="button" onClick={addCheckpoint}
                className="waisha-btn w-full rounded-input py-8 text-xs font-semibold">Add checkpoint</button>
            </div>
            <button type="button" onClick={() => setDetail(null)}
              className="mt-16 w-full rounded-input border py-8 text-xs font-semibold" style={{ borderColor: "var(--line)" }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}