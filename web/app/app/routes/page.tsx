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

type StopKind = "origin" | "via" | "dest";
interface Region { id: number; name_en: string; }
interface RegionCoords { id: number; code: string; name_en: string; lat: number; lng: number; }
interface District { id: number; name_en: string; }
interface Ward { id: number; name: string; }
interface BorderPost { id: number; name: string; country_a: string; country_b: string; }
interface Place { id: number; name: string; kind: string; lat: number; lng: number; region_id: number; region_name: string; }
interface CorridorStop {
  seq: number; regionId: number; placeId: number | null; label: string;
  lat: number | null; lng: number | null;
}
interface Corridor {
  id: number; name: string; kind: string; notes: string | null;
  reverse: boolean; stops: CorridorStop[];
}
interface TraceRoute { distanceKm: number; durationHours: number; geometry: [number, number][]; }
interface Coord { lat: number; lng: number; source: "pin" | "town" | "region_centroid"; }

/** One row of the chain. Its role is its position: first = origin, last = destination. */
interface StopRow {
  key: string;
  regionId: string; districtId: string; wardId: string;
  placeId: string; town: string; place: string;
  pin: { lat: number; lng: number } | null;
}

interface ApiStop {
  seq: number; kind: string; region_id: number | null; district_id: number | null;
  ward_id: number | null; place_id: number | null; place: string | null;
  lat: number | null; lng: number | null; coord_source: string | null;
  region_name: string | null; district_name: string | null; ward_name: string | null;
  place_name: string | null;
}
interface Checkpoint { id: string; seq: number; kind: string; name: string; }
interface RouteRow {
  id: string; name: string; corridor: string | null;
  origin_text: string | null; dest_text: string | null;
  distance_km: number | null; rate_per_km: string | null;
  border_post_name: string | null; checkpoint_count: number;
  stop_count: number; stop_chain: string | null; route_source: string | null;
}
interface RouteDetail {
  id: string; name: string; checkpoints: Checkpoint[]; stops: ApiStop[];
  geometry: [number, number][] | null; route_source: string | null;
}
interface RouteForm {
  name: string; corridor: string; borderPostId: string;
  distanceKm: string; expectedDurationHours: string; roadClass: string;
  riskNotes: string; seasonalNotes: string;
  ratePerKm: string; ratePerTonne: string; ratePerTrip: string;
}

const KIND_LABELS: Record<StopKind, string> = { origin: "Origin", via: "Via", dest: "Destination" };
const SOURCE_LABELS: Record<Coord["source"], string> = {
  pin: "Pinned on map", town: "Gazetteer town", region_centroid: "Region centre (approx.)"
};
const CP_KINDS = ["weighbridge", "border", "toll", "fuel", "rest", "town"] as const;
const CP_LABELS: Record<string, string> = {
  weighbridge: "Weighbridge", border: "Border", toll: "Toll",
  fuel: "Fuel station", rest: "Rest point", town: "Town"
};

const EMPTY_FORM: RouteForm = {
  name: "", corridor: "", borderPostId: "", distanceKm: "", expectedDurationHours: "",
  roadClass: "", riskNotes: "", seasonalNotes: "",
  ratePerKm: "", ratePerTonne: "", ratePerTrip: ""
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

function uid() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}
function nOr(v: string): number | null {
  return v ? Number(v) : null;
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function blankStop(): StopRow {
  return { key: uid(), regionId: "", districtId: "", wardId: "", placeId: "", town: "", place: "", pin: null };
}
function startStops(): StopRow[] {
  return [blankStop(), blankStop()];
}
function kindAt(i: number, len: number): StopKind {
  return i === 0 ? "origin" : i === len - 1 ? "dest" : "via";
}
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
/** Road is never straight — 1.25 is the correction factor this app has always used. */
function estimateKm(chain: Coord[]): number {
  let sum = 0;
  for (let i = 1; i < chain.length; i++) {
    sum += haversineKm(chain[i - 1].lat, chain[i - 1].lng, chain[i].lat, chain[i].lng);
  }
  return Math.round(sum * 1.25);
}
function resolveStop(
  s: StopRow,
  towns: Record<string, Place>,
  centroids: Map<number, { lat: number; lng: number }>
): Coord | null {
  if (s.pin && Number.isFinite(s.pin.lat) && Number.isFinite(s.pin.lng)) {
    return { lat: s.pin.lat, lng: s.pin.lng, source: "pin" };
  }
  const t = s.placeId ? towns[s.placeId] : null;
  if (t) {
    const lat = num(t.lat), lng = num(t.lng);
    if (lat !== null && lng !== null) return { lat, lng, source: "town" };
  }
  const r = s.regionId ? centroids.get(Number(s.regionId)) : null;
  if (r) return { lat: r.lat, lng: r.lng, source: "region_centroid" };
  return null;
}

export default function RoutesPage() {
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [regions, setRegions] = useState<Region[]>([]);
  const [regionCoords, setRegionCoords] = useState<RegionCoords[]>([]);
  const [borderPosts, setBorderPosts] = useState<BorderPost[]>([]);
  const [districtsByRegion, setDistrictsByRegion] = useState<Record<string, District[]>>({});
  const [wardsByDistrict, setWardsByDistrict] = useState<Record<string, Ward[]>>({});
  const [towns, setTowns] = useState<Record<string, Place>>({});
  const [hits, setHits] = useState<Record<string, Place[]>>({});
  const [stops, setStops] = useState<StopRow[]>(startStops);
  const [form, setForm] = useState<RouteForm>(EMPTY_FORM);
  const [corridors, setCorridors] = useState<Corridor[]>([]);
  const [trace, setTrace] = useState<{ main: TraceRoute; alts: TraceRoute[] } | null>(null);
  const [chosen, setChosen] = useState(0);
  const [traceStatus, setTraceStatus] = useState<"idle" | "loading" | "road" | "failed">("idle");
  const [traceAttempt, setTraceAttempt] = useState(0);
  const [pinTarget, setPinTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RouteDetail | null>(null);
  const [cp, setCp] = useState({ kind: "weighbridge" as typeof CP_KINDS[number], name: "" });
  // Deleting a corridor takes its stops, checkpoints and trace with it, so the
  // button arms on the first tap and only fires on the second.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch("/routes");
    if (res.ok) setRoutes(await res.json());
    setLoaded(true);
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

  const centroids = useMemo(() => {
    const m = new Map<number, { lat: number; lng: number }>();
    for (const r of regionCoords) {
      const lat = num(r.lat), lng = num(r.lng);
      if (lat !== null && lng !== null) m.set(Number(r.id), { lat, lng });
    }
    return m;
  }, [regionCoords]);

  const labelOf = useCallback((s: StopRow) =>
    s.place.trim() || (s.placeId ? towns[s.placeId]?.name : "") ||
    (s.regionId ? regions.find(r => r.id === Number(s.regionId))?.name_en : "") || "",
    [towns, regions]);

  const resolved = useMemo(
    () => stops.map(s => resolveStop(s, towns, centroids)),
    [stops, towns, centroids]);

  const chainKey = useMemo(
    () => resolved.map(c => (c ? `${c.lat.toFixed(4)},${c.lng.toFixed(4)}` : "-")).join(";"),
    [resolved]);

  const odKey = useMemo(() => {
    const a = stops[0]?.regionId, b = stops[stops.length - 1]?.regionId;
    return a && b && a !== b ? `${a}:${b}` : "";
  }, [stops]);

  // Main-corridor options for the origin/destination pair — the operator keeps
  // these, so a pair like Dar -> Mbamba Bay offers both the coast and the highlands.
  useEffect(() => {
    if (!odKey) { setCorridors([]); return; }
    const [o, d] = odKey.split(":");
    let cancelled = false;
    (async () => {
      const res = await apiFetch(`/geo/corridors?originRegionId=${o}&destRegionId=${d}`);
      if (cancelled) return;
      if (!res.ok) { setCorridors([]); return; }
      const j = await res.json();
      setCorridors(j);
      setTowns(prev => {
        const next = { ...prev };
        for (const c of j as Corridor[]) {
          for (const s of c.stops) {
            if (s.placeId && s.lat !== null && s.lng !== null && !next[s.placeId]) {
              next[s.placeId] = {
                id: s.placeId, name: s.label, kind: "town",
                lat: s.lat, lng: s.lng, region_id: s.regionId, region_name: s.label
              };
            }
          }
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [odKey]);

  // Traced road path for the whole chain (origin -> every VIA -> destination).
  // Falls back to the straight-line estimate when routing is down.
  useEffect(() => {
    const chain = resolved.filter((c): c is Coord => c !== null);
    if (chain.length < 2) {
      setTrace(null); setTraceStatus("idle");
      return;
    }
    let cancelled = false;
    setTraceStatus("loading");
    const timer = setTimeout(async () => {
      try {
        const wps = chain.map(c => `${c.lat},${c.lng}`).join(";");
        const res = await apiFetch(`/geo/road-route?wps=${encodeURIComponent(wps)}&alternatives=2`);
        if (cancelled) return;
        if (!res.ok) throw new Error("routing failed");
        const j = await res.json();
        const main: TraceRoute = {
          distanceKm: Number(j.distanceKm), durationHours: Number(j.durationHours),
          geometry: (j.geometry ?? []) as [number, number][]
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const alts: TraceRoute[] = (j.alternatives ?? []).map((a: any) => ({
          distanceKm: Number(a.distanceKm), durationHours: Number(a.durationHours),
          geometry: (a.geometry ?? []) as [number, number][]
        })).filter((a: TraceRoute) => a.geometry.length >= 2 && a.distanceKm > 0);
        if (main.geometry.length < 2 || !(main.distanceKm > 0)) throw new Error("routing empty");
        setTrace({ main, alts });
        setChosen(0);
        setTraceStatus("road");
        setForm(f => ({
          ...f,
          distanceKm: String(main.distanceKm),
          expectedDurationHours: f.expectedDurationHours || String(main.durationHours)
        }));
      } catch {
        if (cancelled) return;
        setTrace(null);
        setTraceStatus("failed");
        setForm(f => ({ ...f, distanceKm: String(estimateKm(chain)) }));
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
    // chainKey changes only when a coordinate really moves, so the estimate is
    // re-run for the stops it is given, not for every keystroke in a text box.
  }, [chainKey, traceAttempt]); // eslint-disable-next-line react-hooks/exhaustive-deps

  function setStop(key: string, patch: Partial<StopRow>) {
    setStops(prev => prev.map(s => (s.key === key ? { ...s, ...patch } : s)));
  }

  async function pickRegion(key: string, v: string) {
    setStop(key, { regionId: v, districtId: "", wardId: "", placeId: "", town: "" });
    setHits(h => ({ ...h, [key]: [] }));
    if (v && !districtsByRegion[v]) {
      const d = await apiFetch(`/geo/districts/${v}`);
      if (d.ok) { const rows = await d.json(); setDistrictsByRegion(prev => ({ ...prev, [v]: rows })); }
    }
  }
  async function pickDistrict(key: string, v: string) {
    setStop(key, { districtId: v, wardId: "" });
    if (v && !wardsByDistrict[v]) {
      const w = await apiFetch(`/geo/wards/${v}`);
      if (w.ok) { const rows = await w.json(); setWardsByDistrict(prev => ({ ...prev, [v]: rows })); }
    }
  }

  function searchTowns(key: string, text: string) {
    setStop(key, { town: text, placeId: "" });
    setHits(h => ({ ...h, [key]: [] }));
    if (text.trim().length < 2) return;
    const k = text.trim();
    setTimeout(async () => {
      const res = await apiFetch(`/geo/places?q=${encodeURIComponent(k)}&limit=12`);
      if (!res.ok) return;
      const j = await res.json();
      setTowns(prev => {
        const next = { ...prev };
        for (const p of j as Place[]) next[p.id] = p;
        return next;
      });
      setHits(h => ({ ...h, [key]: j }));
    }, 350);
  }
  function pickTown(key: string, p: Place) {
    setTowns(prev => ({ ...prev, [p.id]: p }));
    setStop(key, { placeId: String(p.id), town: p.name, regionId: String(p.region_id) });
    setHits(h => ({ ...h, [key]: [] }));
  }

  function addViaAfter(key: string) {
    setStops(prev => {
      const i = prev.findIndex(s => s.key === key);
      if (i < 0) return prev;
      const next = prev.slice();
      next.splice(i + 1, 0, blankStop());
      return next;
    });
  }
  function removeStop(key: string) {
    setStops(prev => (prev.length <= 2 ? prev : prev.filter(s => s.key !== key)));
    setHits(h => ({ ...h, [key]: [] }));
  }
  function moveStop(key: string, dir: -1 | 1) {
    setStops(prev => {
      const i = prev.findIndex(s => s.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  function applyCorridor(c: Corridor) {
    const a = c.stops;
    const head = stops[0], tail = stops[stops.length - 1];
    const idxOfTown = (placeId: string) => a.findIndex(s => s.placeId && String(s.placeId) === placeId);
    const idxsIn = (regionId: string) => regionId
      ? a.map((s, i) => (String(s.regionId) === regionId && s.placeId ? i : -1)).filter(i => i >= 0)
      : [];
    // An end that carries only a region has no coordinate of its own, so it traces from the
    // region centroid — for a corridor that ends at Mbamba Bay, 200 km short of the town the
    // corridor is named for. Such an end adopts the corridor's edge town instead: the origin
    // the first in its region, the destination the last. An end the operator already pinned or
    // picked a town for is theirs, never rewritten; the chain is trimmed to the span between
    // the two ends so it cannot pass the origin on its way to the destination.
    const openHead = !head.placeId && !head.pin, openTail = !tail.placeId && !tail.pin;
    const headTowns = idxsIn(head.regionId), tailTowns = idxsIn(tail.regionId);
    const ownHead = head.placeId ? idxOfTown(head.placeId) : -1;
    const ownTail = tail.placeId ? idxOfTown(tail.placeId) : -1;
    let from = ownHead >= 0 ? ownHead
      : !headTowns.length ? 0
      : openHead ? headTowns[0] : headTowns[headTowns.length - 1];
    let to = ownTail >= 0 ? ownTail
      : !tailTowns.length ? a.length - 1
      : openTail ? tailTowns[tailTowns.length - 1] : tailTowns[0];
    if (from > to) { from = 0; to = a.length - 1; }
    const headAnchor = openHead && from === headTowns[0] ? a[from] : null;
    const tailAnchor = openTail && to === tailTowns[tailTowns.length - 1] && to !== from ? a[to] : null;
    const taken = new Set((headAnchor ? [from] : []).concat(tailAnchor ? [to] : []));
    // An end the operator already chose is not also a VIA: loading a second corridor whose
    // chain runs through the town the destination already holds would double it.
    const ownEnds = new Set([head.placeId, tail.placeId].filter(Boolean));
    const mid: StopRow[] = a.slice(from, to + 1)
      .filter((s, i) => !taken.has(from + i) && (!s.placeId || !ownEnds.has(String(s.placeId))))
      .map(s => ({
        ...blankStop(),
        regionId: String(s.regionId),
        placeId: s.placeId ? String(s.placeId) : "",
        town: s.placeId ? s.label : ""
      }));
    const adopt = (row: StopRow, anchor: CorridorStop | null): StopRow =>
      anchor ? { ...row, placeId: String(anchor.placeId), town: anchor.label } : row;
    setStops([adopt(head, headAnchor), ...mid, adopt(tail, tailAnchor)]);
    const named = [headAnchor && `origin ${headAnchor.label}`, tailAnchor && `destination ${tailAnchor.label}`]
      .filter(Boolean);
    setNotice(named.length
      ? `Corridor "${c.name}" loaded — ${c.stops.length} anchors, your ${named.join(" and ")} taken from it. Adjust either end to your own ward or village.`
      : `Corridor "${c.name}" loaded — ${c.stops.length} anchors between your two ends. Adjust them to your own ward or village.`);
    setForm(f => ({ ...f, corridor: f.corridor || c.name }));
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setStops(startStops());
    setHits({});
    setTrace(null);
    setChosen(0);
    setTraceStatus("idle");
    setPinTarget(null);
    setEditingId(null);
  }

  function stopPayload(s: StopRow, i: number) {
    return {
      kind: kindAt(i, stops.length),
      regionId: nOr(s.regionId), districtId: nOr(s.districtId), wardId: nOr(s.wardId),
      placeId: nOr(s.placeId),
      place: s.place.trim() || null,
      lat: s.pin ? s.pin.lat : null,
      lng: s.pin ? s.pin.lng : null
    };
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null); setNotice(null);

    const unplaced = resolved.findIndex(c => c === null);
    if (unplaced >= 0) {
      setError(`${KIND_LABELS[kindAt(unplaced, stops.length)]} (stop ${unplaced + 1}) has no coordinate — `
        + "pick a town from the gazetteer, or drop a pin on the map. A ward alone has no coordinate.");
      return;
    }
    setBusy(true);
    try {
      const line = trace ? (chosen === 0 ? trace.main.geometry : trace.alts[chosen - 1]?.geometry ?? trace.main.geometry) : null;
      const payload = {
        name: form.name, corridor: form.corridor || undefined,
        borderPostId: form.borderPostId ? Number(form.borderPostId) : null,
        distanceKm: form.distanceKm ? Number(form.distanceKm) : undefined,
        expectedDurationHours: form.expectedDurationHours ? Number(form.expectedDurationHours) : undefined,
        roadClass: form.roadClass || undefined,
        riskNotes: form.riskNotes || undefined,
        seasonalNotes: form.seasonalNotes || undefined,
        ratePerKm: form.ratePerKm ? Number(form.ratePerKm) : undefined,
        ratePerTonne: form.ratePerTonne ? Number(form.ratePerTonne) : undefined,
        ratePerTrip: form.ratePerTrip ? Number(form.ratePerTrip) : undefined,
        stops: stops.map(stopPayload),
        geometry: line && line.length >= 2 ? line : undefined,
        routeSource: traceStatus === "road" ? "osrm" : "estimate"
      };
      const res = editingId
        ? await apiFetch(`/routes/${editingId}`, {
            method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
          })
        : await apiFetch("/routes", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
          });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed")); return; }
      setNotice(`Route "${form.name}" ${editingId ? "updated" : "created"}.`);
      resetForm(); setShowForm(false);
      load();
    } finally { setBusy(false); }
  }

  async function editRoute(r: { id: string }) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/routes/${r.id}`);
    if (!res.ok) { setError("That route could not be opened. Refresh the register and try again."); return; }
    const j = await res.json();

    let rows: StopRow[];
    const st: ApiStop[] = j.stops ?? [];
    if (st.length >= 2) {
      setTowns(prev => {
        const next = { ...prev };
        for (const s of st) {
          if (s.place_id && s.coord_source !== "pin" && num(s.lat) !== null && num(s.lng) !== null) {
            next[s.place_id] = {
              id: s.place_id, name: s.place_name || s.place || "", kind: "town",
              lat: Number(s.lat), lng: Number(s.lng),
              region_id: s.region_id ?? 0, region_name: s.region_name || ""
            };
          }
        }
        return next;
      });
      rows = st.map(s => ({
        key: uid(),
        regionId: s.region_id ? String(s.region_id) : "",
        districtId: s.district_id ? String(s.district_id) : "",
        wardId: s.ward_id ? String(s.ward_id) : "",
        placeId: s.place_id ? String(s.place_id) : "",
        town: s.place_id ? (s.place_name || "") : "",
        place: s.place || "",
        pin: s.coord_source === "pin" && num(s.lat) !== null && num(s.lng) !== null
          ? { lat: Number(s.lat), lng: Number(s.lng) } : null
      }));
    } else {
      // Legacy route saved before the builder — rebuild the two ends from the flat columns.
      rows = [
        { ...blankStop(), regionId: j.origin_region_id ? String(j.origin_region_id) : "",
          districtId: j.origin_district_id ? String(j.origin_district_id) : "",
          wardId: j.origin_ward_id ? String(j.origin_ward_id) : "", place: j.origin_text || "" },
        { ...blankStop(), regionId: j.dest_region_id ? String(j.dest_region_id) : "",
          districtId: j.dest_district_id ? String(j.dest_district_id) : "",
          wardId: j.dest_ward_id ? String(j.dest_ward_id) : "", place: j.dest_text || "" }
      ];
    }
    for (const row of rows) {
      if (!row.regionId || districtsByRegion[row.regionId]) continue;
      const d = await apiFetch(`/geo/districts/${row.regionId}`);
      if (d.ok) {
        const rows = await d.json();
        const rk = row.regionId;
        setDistrictsByRegion(prev => ({ ...prev, [rk]: rows }));
      }
    }
    setStops(rows);
    setForm({
      name: j.name ?? "", corridor: j.corridor ?? "",
      borderPostId: j.border_post_id ? String(j.border_post_id) : "",
      distanceKm: j.distance_km != null ? String(j.distance_km) : "",
      expectedDurationHours: j.expected_duration_hours != null ? String(j.expected_duration_hours) : "",
      roadClass: j.road_class ?? "", riskNotes: j.risk_notes ?? "", seasonalNotes: j.seasonal_notes ?? "",
      ratePerKm: j.rate_per_km != null ? String(j.rate_per_km) : "",
      ratePerTonne: j.rate_per_tonne != null ? String(j.rate_per_tonne) : "",
      ratePerTrip: j.rate_per_trip != null ? String(j.rate_per_trip) : ""
    });
    const geo = Array.isArray(j.geometry) ? j.geometry as [number, number][] : null;
    if (geo && geo.length >= 2) {
      setTrace({ main: { distanceKm: Number(j.distance_km) || 0, durationHours: Number(j.expected_duration_hours) || 0, geometry: geo }, alts: [] });
      setChosen(0);
      setTraceStatus(j.route_source === "osrm" ? "road" : "idle");
    } else {
      setTrace(null); setTraceStatus("idle");
    }
    setChosen(0);
    setEditingId(r.id);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function openDetail(r: { id: string; name: string }) {
    const res = await apiFetch(`/routes/${r.id}`);
    if (!res.ok) { setError("That route could not be opened."); return; }
    const j = await res.json();
    setDetail({
      id: r.id, name: r.name, checkpoints: j.checkpoints ?? [], stops: j.stops ?? [],
      geometry: Array.isArray(j.geometry) ? j.geometry : null,
      route_source: j.route_source ?? null
    });
  }

  async function removeRoute(r: { id: string; name: string }) {
    if (armedDelete !== r.id) { setArmedDelete(r.id); return; }
    setArmedDelete(null);
    setNotice(null);
    const res = await apiFetch(`/routes/${r.id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, `Route "${r.name}" could not be deleted.`)); return; }
    setError(null);
    if (detail?.id === r.id) setDetail(null);
    setNotice(`Route "${r.name}" deleted.`);
    load();
  }

  async function addCheckpoint() {
    if (!detail || !cp.name.trim()) return;
    const res = await apiFetch(`/routes/${detail.id}/checkpoints`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: cp.kind, name: cp.name.trim() })
    });
    if (res.ok) {
      setCp(c => ({ ...c, name: "" }));
      openDetail({ id: detail.id, name: detail.name });
    }
  }
  async function removeCheckpoint(cpId: string) {
    if (!detail) return;
    await apiFetch(`/routes/${detail.id}/checkpoints/${cpId}`, { method: "DELETE" });
    openDetail({ id: detail.id, name: detail.name });
  }

  const mapPoints = useMemo<MapPointLike[]>(() => {
    const out: MapPointLike[] = [];
    stops.forEach((s, i) => {
      const c = resolved[i];
      if (!c) return;
      out.push({ lat: c.lat, lng: c.lng, name: labelOf(s) || KIND_LABELS[kindAt(i, stops.length)], kind: kindAt(i, stops.length) });
    });
    if (pinTarget) {
      const t = stops.find(s => s.key === pinTarget);
      const c = t ? resolved[stops.indexOf(t)] : null;
      if (c && c.source !== "pin") out.push({ lat: c.lat, lng: c.lng, name: "Map centre — click to pin", kind: "pin" });
    }
    return out;
  }, [stops, resolved, pinTarget, labelOf]);

  const mapLines = useMemo<MapLineLike[]>(() => {
    if (trace) {
      const all = [trace.main, ...trace.alts];
      return all.map((r, i) => ({ positions: r.geometry, kind: i === chosen ? "road" : "alt" }));
    }
    const chain = resolved.filter((c): c is Coord => c !== null)
      .map(c => [c.lat, c.lng] as [number, number]);
    return chain.length >= 2 ? [{ positions: chain, kind: "guess" }] : [];
  }, [trace, chosen, resolved]);

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  const traceRoutes = trace ? [trace.main, ...trace.alts] : [];

  return (
    <div className="mx-auto max-w-[1000px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Routes</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Plan any corridor nationwide: origin → VIA stops → destination, traced on real roads.
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
        <form onSubmit={submit} className="mt-24 space-y-16 rounded-card border bg-surface p-24"
          style={{ borderColor: editingId ? "var(--gold)" : "var(--line)" }}>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Route name *</span>
              <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Dar es Salaam - Mbamba Bay" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Corridor</span>
              <input value={form.corridor} onChange={e => setForm(f => ({ ...f, corridor: e.target.value }))}
                placeholder="e.g. Southern Coastal" className={inputCls} style={inputStyle} />
            </label>
          </div>

          <div>
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Chain — origin, VIA stops, destination</span>
            <div className="space-y-12">
              {stops.map((s, i) => {
                const kind = kindAt(i, stops.length);
                const c = resolved[i];
                const list = hits[s.key] ?? [];
                return (
                  <div key={s.key} className="rounded-card border p-16"
                    style={{ borderColor: c ? "var(--line)" : "var(--warning)" }}>
                    <div className="mb-12 flex items-center justify-between">
                      <span className="text-xs font-bold uppercase tracking-[0.14em]"
                        style={{ color: kind === "via" ? "var(--ink-soft)" : kind === "origin" ? "var(--brand)" : "var(--success)" }}>
                        {kind === "origin" ? "A · Origin" : kind === "dest" ? "B · Destination" : `VIA ${i}`}
                      </span>
                      <div className="flex items-center gap-8">
                        {c && (
                          <span className="rounded-input px-8 py-2 text-[10px] font-semibold"
                            style={{ background: "color-mix(in srgb, var(--brand) 12%, transparent)", color: "var(--brand)" }}>
                            {SOURCE_LABELS[c.source]}
                          </span>
                        )}
                        <button type="button" onClick={() => moveStop(s.key, -1)} disabled={i === 0}
                          className="rounded-input border px-8 py-2 text-[10px]"
                          style={{ borderColor: "var(--line)", opacity: i === 0 ? 0.35 : 1 }}>↑</button>
                        <button type="button" onClick={() => moveStop(s.key, 1)} disabled={i === stops.length - 1}
                          className="rounded-input border px-8 py-2 text-[10px]"
                          style={{ borderColor: "var(--line)", opacity: i === stops.length - 1 ? 0.35 : 1 }}>↓</button>
                        <button type="button" onClick={() => addViaAfter(s.key)}
                          className="rounded-input border px-8 py-2 text-[10px] font-semibold"
                          style={{ borderColor: "var(--brand)", color: "var(--brand)" }}>+ VIA after</button>
                        {stops.length > 2 && (
                          <button type="button" onClick={() => removeStop(s.key)}
                            className="rounded-input border px-8 py-2 text-[10px]"
                            style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>Remove</button>
                        )}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-12">
                      <label className="block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Region (Mkoa)</span>
                        <select value={s.regionId} onChange={e => pickRegion(s.key, e.target.value)} className={inputCls} style={inputStyle}>
                          <option value="">Select</option>
                          {regions.map(r => <option key={r.id} value={r.id}>{r.name_en}</option>)}
                        </select>
                      </label>
                      <label className="block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Council (Wilaya)</span>
                        <select value={s.districtId} disabled={!s.regionId}
                          onChange={e => pickDistrict(s.key, e.target.value)}
                          className={inputCls} style={{ ...inputStyle, opacity: s.regionId ? 1 : 0.5 }}>
                          <option value="">{s.regionId ? "Select" : "Pick region"}</option>
                          {s.districtId && !(districtsByRegion[s.regionId] ?? []).some(d => String(d.id) === s.districtId) && (
                            <option value={s.districtId}>Saved council</option>
                          )}
                          {(districtsByRegion[s.regionId] ?? []).map(d => <option key={d.id} value={d.id}>{d.name_en}</option>)}
                        </select>
                      </label>
                      <label className="block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Ward (Kata)</span>
                        <select value={s.wardId} disabled={!s.districtId}
                          onChange={e => setStop(s.key, { wardId: e.target.value })}
                          className={inputCls} style={{ ...inputStyle, opacity: s.districtId ? 1 : 0.5 }}>
                          <option value="">{s.districtId ? "Select" : "Pick council"}</option>
                          {s.wardId && !(wardsByDistrict[s.districtId] ?? []).some(w => String(w.id) === s.wardId) && (
                            <option value={s.wardId}>Saved ward</option>
                          )}
                          {(wardsByDistrict[s.districtId] ?? []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </select>
                      </label>
                      <label className="block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Town / trading centre</span>
                        <input value={s.town} onChange={e => searchTowns(s.key, e.target.value)}
                          placeholder="start typing, e.g. Kilwa" className={inputCls} style={inputStyle} />
                        {list.length > 0 && (
                          <ul className="mt-4 max-h-[180px] overflow-auto rounded-input border" style={{ borderColor: "var(--line)" }}>
                            {list.map(p => (
                              <li key={p.id}>
                                <button type="button" onClick={() => pickTown(s.key, p)}
                                  className="block w-full px-12 py-6 text-left text-xs hover:bg-[var(--milk-deep)]">
                                  <span className="font-semibold" style={{ color: "var(--ink)" }}>{p.name}</span>
                                  <span style={{ color: "var(--ink-soft)" }}> — {p.region_name} · {p.kind}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </label>
                      <label className="block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Village / street (your words)</span>
                        <input value={s.place} onChange={e => setStop(s.key, { place: e.target.value })}
                          placeholder="e.g. Mabatini, Vingunguti" className={inputCls} style={inputStyle} />
                      </label>
                      <div className="flex items-end gap-8">
                        <button type="button" onClick={() => setPinTarget(t => (t === s.key ? null : s.key))}
                          className="waisha-btn rounded-input px-12 py-8 text-xs font-semibold"
                          style={pinTarget === s.key ? { background: "var(--gold)", color: "#241a06" } : undefined}>
                          {pinTarget === s.key ? "Now click the map…" : s.pin ? "Re-pin" : "Pin on map"}
                        </button>
                        {s.pin && (
                          <button type="button" onClick={() => setStop(s.key, { pin: null })}
                            className="rounded-input border px-10 py-8 text-[11px]"
                            style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>Clear pin</button>
                        )}
                      </div>
                    </div>
                    {!c && (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>
                        No coordinate yet — pick a town from the gazetteer or drop a pin. A ward alone has no coordinate.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {corridors.length > 0 && (
            <div className="rounded-card border p-16" style={{ borderColor: "var(--gold)" }}>
              <span className={labelCls} style={{ color: "var(--gold)" }}>Main corridors for this pair</span>
              <div className="space-y-8">
                {corridors.map(c => (
                  <div key={c.id} className="flex flex-wrap items-center justify-between gap-8">
                    <div>
                      <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                        {c.name}
                        <span className="ml-8 rounded-input px-8 py-1 text-[10px] font-semibold"
                          style={{ background: "color-mix(in srgb, var(--ink-soft) 14%, transparent)", color: "var(--ink-soft)" }}>
                          {c.kind}
                        </span>
                      </p>
                      <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        {c.stops.map(s => s.label).join(" → ")}
                      </p>
                    </div>
                    <button type="button" onClick={() => applyCorridor(c)}
                      className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                      style={{ borderColor: "var(--gold)", color: "var(--gold)" }}>
                      Use this corridor
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Border post (if cross-border)</span>
              <select value={form.borderPostId} onChange={e => setForm(f => ({ ...f, borderPostId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">None / domestic</option>
                {borderPosts.map(b => <option key={b.id} value={b.id}>{b.name} ({b.country_a}-{b.country_b})</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Distance (km)
                {form.distanceKm && (
                  <span style={{ color: "var(--brand)" }}>
                    {" "}{traceStatus === "road" ? "— road distance" : traceStatus === "failed" ? "— estimate" : ""}, editable
                  </span>
                )}
              </span>
              <input type="number" min={0} value={form.distanceKm}
                onChange={e => setForm(f => ({ ...f, distanceKm: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Expected hours</span>
              <input type="number" min={0} value={form.expectedDurationHours}
                onChange={e => setForm(f => ({ ...f, expectedDurationHours: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Road class</span>
              <input value={form.roadClass} onChange={e => setForm(f => ({ ...f, roadClass: e.target.value }))}
                placeholder="e.g. T1 tar" className={inputCls} style={inputStyle} />
            </label>
          </div>

          <div className="rounded-card border p-8" style={{ borderColor: "var(--line)" }}>
            <div className="h-[380px] w-full overflow-hidden rounded-input">
              <RouteMap points={mapPoints} lines={mapLines}
                onPin={pinTarget ? (lat, lng) => {
                  if (lat < -20 || lat > 5 || lng < 25 || lng > 45) {
                    setNotice("That point is off the map this planner routes — pan back to Tanzania and pin again.");
                    return;
                  }
                  setStop(pinTarget, { pin: { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) } });
                  setNotice(null);
                  setPinTarget(null);
                } : undefined} />
            </div>
            <div className="mt-8 flex flex-wrap items-center justify-between gap-8">
              <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {traceStatus === "loading" && "Tracing the road through your chain…"}
                {traceStatus === "road" && `Road trace: ${traceRoutes[chosen]?.distanceKm ?? ""} km over ${traceRoutes.length} option${traceRoutes.length === 1 ? "" : "s"}.`}
                {traceStatus === "failed" && "The road router did not answer — the distance shown is a straight-line estimate. The route still saves; re-trace it when the router answers."}
                {traceStatus === "idle" && (mapPoints.length >= 2
                  ? "Pick towns or pins, then the trace follows the road."
                  : "Click “Pin on map” then the map to place an exact point.")}
              </p>
              {traceStatus === "failed" && (
                <button type="button" onClick={() => setTraceAttempt(a => a + 1)}
                  className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                  style={{ borderColor: "var(--brand)", color: "var(--brand)" }}>Re-trace</button>
              )}
            </div>
          </div>

          {traceRoutes.length > 1 && (
            <div className="rounded-card border p-16" style={{ borderColor: "var(--brand)" }}>
              <span className={labelCls} style={{ color: "var(--brand)" }}>Traced options — keep the one you actually run</span>
              <div className="space-y-8">
                {traceRoutes.map((r, i) => (
                  <label key={i} className="flex cursor-pointer items-center justify-between gap-12 text-sm"
                    style={{ color: i === chosen ? "var(--ink)" : "var(--ink-soft)" }}>
                    <span className="flex items-center gap-8">
                      <input type="radio" name="trace" checked={i === chosen}
                        onChange={() => {
                          setChosen(i);
                          setForm(f => ({ ...f, distanceKm: String(r.distanceKm) }));
                        }} />
                      Option {String.fromCharCode(65 + i)}
                    </span>
                    <span>{r.distanceKm} km · about {r.durationHours} h</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Rate per km</span>
              <input type="number" min={0} step="0.01" value={form.ratePerKm}
                onChange={e => setForm(f => ({ ...f, ratePerKm: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Rate per tonne</span>
              <input type="number" min={0} step="0.01" value={form.ratePerTonne}
                onChange={e => setForm(f => ({ ...f, ratePerTonne: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Rate per trip</span>
              <input type="number" min={0} step="0.01" value={form.ratePerTrip}
                onChange={e => setForm(f => ({ ...f, ratePerTrip: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Risk notes</span>
              <textarea rows={2} value={form.riskNotes}
                onChange={e => setForm(f => ({ ...f, riskNotes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Seasonal notes</span>
              <textarea rows={2} value={form.seasonalNotes}
                onChange={e => setForm(f => ({ ...f, seasonalNotes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>

          <div className="flex gap-12">
            <button type="submit" className="waisha-btn rounded-input px-20 py-10 text-sm font-semibold" disabled={busy}>
              {busy ? "Saving…" : editingId ? "Save changes" : "Create route"}
            </button>
            <button type="button" onClick={() => { resetForm(); setShowForm(false); }}
              className="rounded-input border px-16 py-10 text-sm"
              style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>Cancel</button>
          </div>
        </form>
      )}

      <div className="mt-32 overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ background: "var(--milk-deep)", color: "var(--ink-soft)" }}>
              <th className="px-12 py-8 text-[11px] font-semibold uppercase tracking-[0.14em]">Route</th>
              <th className="px-12 py-8 text-[11px] font-semibold uppercase tracking-[0.14em]">Stops</th>
              <th className="px-12 py-8 text-[11px] font-semibold uppercase tracking-[0.14em]">Distance</th>
              <th className="px-12 py-8 text-[11px] font-semibold uppercase tracking-[0.14em]">Border</th>
              <th className="px-12 py-8 text-[11px] font-semibold uppercase tracking-[0.14em]">Rate/km</th>
              <th className="px-12 py-8"></th>
            </tr>
          </thead>
          <tbody>
            {!loaded && (
              <tr><td colSpan={6} className="px-12 py-16 text-center" style={{ color: "var(--ink-soft)" }}>Loading routes…</td></tr>
            )}
            {loaded && routes.length === 0 && (
              <EmptyState colSpan={6} icon={Route} title="No routes yet"
                hint="Plan a corridor: origin, the VIA towns you actually pass, then the destination."
                action={{ label: "Create one", onClick: () => { setShowForm(true); resetForm(); } }} />
            )}
            {routes.map(r => (
              <tr key={r.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                <td className="px-12 py-10">
                  <p className="font-semibold" style={{ color: "var(--ink)" }}>{r.name}</p>
                  <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {r.stop_chain || [r.origin_text, r.dest_text].filter(Boolean).join(" → ")}
                  </p>
                  {r.corridor && <p className="text-[11px]" style={{ color: "var(--gold)" }}>{r.corridor}</p>}
                </td>
                <td className="px-12 py-10" style={{ color: "var(--ink-soft)" }}>
                  {r.stop_count > 0 ? `${r.stop_count} stops · ${r.checkpoint_count} checks` : `${r.checkpoint_count} checks`}
                </td>
                <td className="px-12 py-10" style={{ color: "var(--ink)" }}>
                  {r.distance_km != null ? `${r.distance_km} km` : "—"}
                  <span className="ml-8 rounded-input px-6 py-1 text-[10px] font-semibold"
                    style={{ background: "color-mix(in srgb, var(--brand) 12%, transparent)", color: "var(--brand)" }}>
                    {r.route_source === "osrm" ? "traced" : r.route_source === "estimate" ? "estimated" : "no trace"}
                  </span>
                </td>
                <td className="px-12 py-10" style={{ color: "var(--ink-soft)" }}>{r.border_post_name ?? "—"}</td>
                <td className="px-12 py-10" style={{ color: "var(--ink)" }}>{r.rate_per_km ? TZS(r.rate_per_km) : "—"}</td>
                <td className="px-12 py-10 text-right whitespace-nowrap">
                  <button type="button" onClick={() => openDetail(r)}
                    className="rounded-input border px-10 py-4 text-[11px]"
                    style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Open</button>{" "}
                  <button type="button" onClick={() => editRoute(r)}
                    className="rounded-input border px-10 py-4 text-[11px]"
                    style={{ borderColor: "var(--brand)", color: "var(--brand)" }}>Edit</button>{" "}
                  <button type="button" onClick={() => removeRoute(r)}
                    className="rounded-input border px-10 py-4 text-[11px]"
                    style={armedDelete === r.id
                      ? { borderColor: "var(--danger)", background: "var(--danger)", color: "var(--milk)", fontWeight: 600 }
                      : { borderColor: "var(--danger)", color: "var(--danger)" }}>
                    {armedDelete === r.id ? "Tap again to delete" : "Delete"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <div role="dialog" aria-modal="true" aria-label={detail.name}
          className="fixed inset-0 z-50 flex items-center justify-center p-16"
          style={{ background: "rgba(8,14,20,.55)" }} onClick={() => setDetail(null)}>
          <div className="max-h-[86vh] w-full max-w-[720px] overflow-auto rounded-modal border bg-surface p-24"
            style={{ borderColor: "var(--line)" }} onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>{detail.name}</h2>
                <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {detail.route_source === "osrm" ? "Traced on the road network" : "Straight-line estimate"}
                </p>
              </div>
              <button type="button" onClick={() => setDetail(null)}
                className="rounded-input border px-10 py-4 text-[11px]"
                style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>Close</button>
            </div>

            {detail.stops.length > 0 ? (
              <ol className="mt-16 space-y-6">
                {detail.stops.map(s => (
                  <li key={s.seq} className="flex flex-wrap items-center gap-8 text-sm">
                    <span className="rounded-input px-8 py-1 text-[10px] font-bold uppercase"
                      style={{ background: "color-mix(in srgb, var(--brand) 12%, transparent)", color: "var(--brand)" }}>
                      {s.kind}
                    </span>
                    <span className="font-semibold" style={{ color: "var(--ink)" }}>
                      {s.place || s.place_name || s.region_name || "—"}
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      {[s.district_name, s.ward_name, s.region_name].filter(Boolean).join(" / ")}
                      {s.lat != null && s.lng != null ? ` · ${s.lat}, ${s.lng}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                Saved before the chain builder — edit it to add VIA stops.
              </p>
            )}

            {(detail.geometry && detail.geometry.length > 1) && (
              <div className="mt-16 h-[260px] w-full overflow-hidden rounded-input border" style={{ borderColor: "var(--line)" }}>
                <RouteMap points={[]} lines={[{ positions: detail.geometry, kind: "road" }]} />
              </div>
            )}

            <div className="mt-24">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Checkpoints</span>
              {detail.checkpoints.length === 0 && (
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>None yet — weighbridges, borders, tolls.</p>
              )}
              <ul className="space-y-6">
                {detail.checkpoints.map(k => (
                  <li key={k.id} className="flex items-center justify-between text-sm">
                    <span style={{ color: "var(--ink)" }}>
                      <span className="mr-8 text-[11px] font-bold" style={{ color: "var(--gold)" }}>{k.seq}</span>
                      {CP_LABELS[k.kind] ?? k.kind} — {k.name}
                    </span>
                    <button type="button" onClick={() => removeCheckpoint(k.id)}
                      className="rounded-input border px-8 py-2 text-[10px]"
                      style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>Remove</button>
                  </li>
                ))}
              </ul>
              <div className="mt-12 flex gap-8">
                <select value={cp.kind} onChange={e => setCp(c => ({ ...c, kind: e.target.value as typeof CP_KINDS[number] }))}
                  className={inputCls} style={{ ...inputStyle, width: 160 }}>
                  {CP_KINDS.map(k => <option key={k} value={k}>{CP_LABELS[k]}</option>)}
                </select>
                <input value={cp.name} onChange={e => setCp(c => ({ ...c, name: e.target.value }))}
                  placeholder="name" className={inputCls} style={inputStyle} />
                <button type="button" onClick={addCheckpoint}
                  className="waisha-btn rounded-input px-14 py-8 text-xs font-semibold">Add</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface MapPointLike { lat: number; lng: number; name: string; kind: StopKind | "pin"; }
interface MapLineLike { positions: [number, number][]; kind: "road" | "alt" | "guess"; }

function TZS(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-TZ") : v;
}
