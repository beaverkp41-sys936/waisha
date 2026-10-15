"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useDeferredValue } from "react";
import dynamic from "next/dynamic";
import { apiFetch, apiStream } from "../api-client";

const RouteMap = dynamic(() => import("../routes/route-map"), {
  ssr: false,
  loading: () => <p className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>Loading map…</p>
});

interface Card {
  id: string;
  cargoLabel: string;
  containerType: string | null;
  containerCount: number | null;
  weightTonnes: number | null;
  cbm: number | null;
  vehicleTypes: string[];
  routeLabel: string | null;
  distanceKm: number | null;
  expectedDurationHours: number | null;
  pickupText: string;
  destText: string;
  viaLabel: string | null;
  requiredDate: string;
  pickupRegionId: number | null;
  pickupRegionName: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  destRegionId: number | null;
  destRegionName: string | null;
  destLat: number | null;
  destLng: number | null;
  contactName: string;
  contactChannel: string;
  publicNote: string | null;
  companyName: string;
  companyDescription: string | null;
  companyServices: string | null;
  companyCorridors: string | null;
  companyWebsite: string | null;
  fleetSizeDeclared: number | null;
  yearEstablished: number | null;
  disclosedAt: string;
}

const VEHICLE_LABELS: Record<string, string> = {
  truck_head: "Truck head", trailer: "Trailer", tanker: "Tanker", flatbed: "Flatbed",
  tipper: "Tipper", reefer: "Reefer", box_truck: "Box truck", van: "Van",
  pickup: "Pickup", lowbed: "Lowbed"
};

const PAGE = 20;
const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

function dayLabel(d: string): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const want = new Date(d + "T00:00:00");
  const days = Math.round((want.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return "Needed today";
  if (days === 1) return "Needed tomorrow";
  if (days < 0) return `Overdue by ${-days} day${-days === 1 ? "" : "s"}`;
  return `Needed in ${days} days`;
}

/** Mirrors the server filter so a pushed card lands in the same list. */
function matches(c: Card, f: Filters): boolean {
  if (f.vehicle && !c.vehicleTypes.includes(f.vehicle)) return false;
  if (f.regionId) {
    const r = Number(f.regionId);
    if (c.pickupRegionId !== r && c.destRegionId !== r) return false;
  }
  if (f.from && c.requiredDate < f.from) return false;
  if (f.to && c.requiredDate > f.to) return false;
  if (f.search) {
    const s = f.search.toLowerCase();
    const hay = [c.cargoLabel, c.pickupText, c.destText, c.viaLabel ?? "", c.companyName]
      .join(" ").toLowerCase();
    if (!hay.includes(s)) return false;
  }
  return true;
}

/** The board's own order: soonest date first, newest disclosure behind it. */
function byDate(a: Card, b: Card) {
  return a.requiredDate.localeCompare(b.requiredDate) ||
    b.disclosedAt.localeCompare(a.disclosedAt);
}

interface Filters { vehicle: string; regionId: string; from: string; to: string; search: string }
const EMPTY: Filters = { vehicle: "", regionId: "", from: "", to: "", search: "" };

export default function BoardPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [regions, setRegions] = useState<{ id: number; name_en: string }[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(0);
  const [conn, setConn] = useState<"connecting" | "live" | "offline">("connecting");
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<Record<string, [number, number][]>>({});
  const [noRoute, setNoRoute] = useState<Set<string>>(new Set());

  const rawQuery = useMemo(() => {
    const q = new URLSearchParams();
    if (filters.vehicle) q.set("vehicle", filters.vehicle);
    if (filters.regionId) q.set("regionId", filters.regionId);
    if (filters.from) q.set("from", filters.from);
    if (filters.to) q.set("to", filters.to);
    if (filters.search.trim()) q.set("search", filters.search.trim());
    q.set("limit", String(PAGE));
    q.set("offset", String(page * PAGE));
    return q.toString();
  }, [filters, page]);
  // Typing in the search box must not fire one request per keystroke.
  const query = useDeferredValue(rawQuery);

  // silent keeps the cards on screen while the server re-reads the same query.
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError(null);
    try {
      const res = await apiFetch(`/board?${query}`);
      if (res.status === 403) { setDenied(true); return; }
      if (!res.ok) { setError("The board could not be loaded. Try again."); return; }
      const j = await res.json();
      setCards(j.rows ?? []); setTotal(j.total ?? 0); setDenied(false);
    } catch (e: any) {
      if (e.message !== "session ended") setError("The board could not be loaded. Try again.");
    } finally { if (!silent) setLoading(false); }
  }, [query]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    (async () => {
      const g = await apiFetch("/geo/regions");
      if (g.ok) setRegions(await g.json());
    })();
  }, []);

  // ---- the live channel: one socket for the whole page, reconnect on drop ----
  const filtersRef = useRef(filters);
  const cardsRef = useRef<Card[]>([]);
  const loadRef = useRef(load);
  const resynced = useRef(false);
  useEffect(() => { filtersRef.current = filters; }, [filters]);
  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    let settle: number | null = null;
    const controller = new AbortController();

    const markFresh = (id: string) => {
      setFresh(prev => new Set(prev).add(id));
      window.setTimeout(() => setFresh(prev => {
        const n = new Set(prev); n.delete(id); return n;
      }), 6000);
    };
    // A live event only ever shows the page it lands on: the row count and the
    // page boundaries belong to the server, so let a burst settle, then re-read.
    const scheduleResync = () => {
      if (settle) window.clearTimeout(settle);
      settle = window.setTimeout(async () => {
        await loadRef.current(true);
        try {
          const r = await apiFetch("/board/count");
          if (r.ok) setOpen((await r.json()).open);
        } catch { /* the next event will ask again */ }
      }, 2500);
    };

    async function connect() {
      if (stopped || controller.signal.aborted) return;
      setConn("connecting");
      let refused = false;
      try {
        const res = await apiStream("/board/stream", (name, data) => {
          if (name === "ready") {
            setOpen(data.open);
            setConn("live");
            // The socket is back: re-read, so a load published while we were
            // away is on the board again rather than missing until a refresh.
            if (resynced.current) loadRef.current();
            resynced.current = true;
          }
          else if (name === "request.published") {
            if (cardsRef.current.some(c => c.id === data.card.id) ||
              !matches(data.card, filtersRef.current)) return;
            setOpen(n => (n === null ? null : n + 1));
            setCards(prev => [...prev, data.card].sort(byDate));
            setTotal(t => t + 1);
            markFresh(data.card.id);
            scheduleResync();
          } else if (name === "request.withdrawn") {
            const wasHere = cardsRef.current.some(c => c.id === data.id);
            setOpen(n => (n === null ? null : Math.max(0, n - 1)));
            setCards(prev => prev.filter(c => c.id !== data.id));
            if (wasHere) setTotal(t => Math.max(0, t - 1));
            scheduleResync();
          }
        }, controller.signal);
        // A closed socket is normal here; only a refusal stops the retry.
        refused = res.status === 401 || res.status === 403;
        if (refused) setConn("offline");
      } catch { /* aborted or session ended */ }
      if (stopped || controller.signal.aborted || refused) return;
      setConn("offline");
      timer = window.setTimeout(connect, 5000);
    }

    connect();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      if (settle) window.clearTimeout(settle);
      controller.abort();
    };
  }, []);

  function setFilter(key: keyof Filters, value: string) {
    setFilters(f => ({ ...f, [key]: value }));
    setPage(0);
  }

  const active = filters.vehicle || filters.regionId || filters.from || filters.to ||
    filters.search.trim();

  async function toggleMap(c: Card) {
    const next = expanded === c.id ? null : c.id;
    setExpanded(next);
    if (!next || geometry[c.id] || c.pickupLat === null || c.destLat === null) return;
    const mark = (id: string, on: boolean) => setNoRoute(s => {
      const n = new Set(s);
      if (on) n.add(id); else n.delete(id);
      return n;
    });
    mark(c.id, false);
    try {
      const res = await apiFetch(`/geo/road-route?oLat=${c.pickupLat}&oLng=${c.pickupLng}` +
        `&dLat=${c.destLat}&dLng=${c.destLng}`);
      const j = res.ok ? await res.json() : null;
      if (Array.isArray(j?.geometry) && j.geometry.length > 1) {
        setGeometry(g => ({ ...g, [c.id]: j.geometry }));
      } else mark(c.id, true);
    } catch { mark(c.id, true); }
  }

  return (
    <div className="mx-auto max-w-[1100px] px-16 py-32">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Notice board</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Loads companies are offering right now. Every card is what the clearing agent
            chose to publish — nothing else about their file is visible to you.
          </p>
        </div>
        <div className="flex items-center gap-8 text-[11px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: conn === "live" ? "var(--success)" : "var(--ink-soft)" }}>
          <span aria-hidden className="inline-block h-8 w-8 rounded-full"
            style={{ background: conn === "live" ? "var(--success)" : "var(--line)" }} />
          {conn === "live" ? "Live" : conn === "connecting" ? "Connecting…" : "Reconnecting…"}
          {open !== null && <span style={{ color: "var(--ink-soft)" }}>· {open} open</span>}
        </div>
      </div>

      <div className="mt-24 grid grid-cols-2 gap-12 rounded-card border bg-surface p-16 md:grid-cols-5"
        style={{ borderColor: "var(--line)" }}>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Truck type</span>
          <select value={filters.vehicle} onChange={e => setFilter("vehicle", e.target.value)}
            className={inputCls} style={inputStyle}>
            <option value="">Any</option>
            {Object.entries(VEHICLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Region</span>
          <select value={filters.regionId} onChange={e => setFilter("regionId", e.target.value)}
            className={inputCls} style={inputStyle}>
            <option value="">Anywhere</option>
            {regions.map(r => <option key={r.id} value={r.id}>{r.name_en}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Needed from</span>
          <input type="date" value={filters.from} onChange={e => setFilter("from", e.target.value)}
            className={inputCls} style={inputStyle} />
        </label>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Needed to</span>
          <input type="date" value={filters.to} onChange={e => setFilter("to", e.target.value)}
            className={inputCls} style={inputStyle} />
        </label>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Search</span>
          <input value={filters.search} placeholder="cargo, town, company"
            onChange={e => setFilter("search", e.target.value)}
            className={inputCls} style={inputStyle} />
        </label>
      </div>

      {active && (
        <div className="mt-12 flex items-center gap-12 text-xs" style={{ color: "var(--ink-soft)" }}>
          <span>Filtered — the live feed respects these filters.</span>
          <button type="button" className="waisha-btn rounded-input px-12 py-6 text-xs font-semibold"
            onClick={() => { setFilters(EMPTY); setPage(0); }}>Clear filters</button>
        </div>
      )}

      {denied && (
        <div role="status" className="mt-24 px-16 py-12 text-sm"
          style={{ background: "color-mix(in srgb, var(--gold) 14%, transparent)", borderLeft: "4px solid var(--gold)" }}>
          Your role does not include board access. Ask a director to give it to you.
        </div>
      )}
      {error && (
        <div role="alert" className="mt-24 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error}
        </div>
      )}

      <div className="mt-24 flex items-center justify-between text-xs" style={{ color: "var(--ink-soft)" }}>
        <span>{loading ? "Loading…" : `${cards.length} of ${total} load${total === 1 ? "" : "s"}`}</span>
        <span>{new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
      </div>

      <div className="mt-12 grid gap-16 lg:grid-cols-2">
        {cards.map(c => (
          <article key={c.id} className="rounded-card border bg-surface p-20"
            style={{
              borderColor: fresh.has(c.id) ? "var(--gold)" : "var(--line)",
              boxShadow: fresh.has(c.id) ? "0 0 0 3px color-mix(in srgb, var(--gold) 25%, transparent)" : "none",
              transition: "border-color .3s, box-shadow .3s"
            }}>
            <div className="flex items-start justify-between gap-12">
              <div>
                <h2 className="text-[15px] font-bold leading-snug" style={{ color: "var(--ink)" }}>
                  {c.cargoLabel}
                </h2>
                <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {c.pickupText}
                  {" → "}
                  {c.destText}
                  {c.viaLabel ? ` via ${c.viaLabel}` : ""}
                </p>
              </div>
              <span className="shrink-0 rounded-input px-10 py-4 text-[11px] font-bold uppercase tracking-[0.1em]"
                style={{ background: "color-mix(in srgb, var(--brand) 10%, transparent)", color: "var(--brand)" }}>
                {dayLabel(c.requiredDate)}
              </span>
            </div>

            <div className="mt-12 flex flex-wrap gap-8">
              {c.vehicleTypes.map(v => (
                <span key={v} className="rounded-input px-8 py-2 text-[11px] font-semibold"
                  style={{ background: "var(--milk)", border: "1px solid var(--line)", color: "var(--ink-soft)" }}>
                  {VEHICLE_LABELS[v] ?? v}
                </span>
              ))}
            </div>

            <dl className="mt-16 grid grid-cols-2 gap-x-16 gap-y-8 text-xs sm:grid-cols-4">
              {[
                ["Pickup", c.pickupRegionName ?? c.pickupText],
                ["Destination", c.destRegionName ?? c.destText],
                ["Distance", c.distanceKm === null ? "—" : `${c.distanceKm} km`],
                ["Duration", c.expectedDurationHours === null ? "—" : `${c.expectedDurationHours} h`],
                ["Weight", c.weightTonnes === null ? "—" : `${c.weightTonnes} t`],
                ["Volume", c.cbm === null ? "—" : `${c.cbm} m³`],
                ["Containers", c.containerCount === null ? "—"
                  : `${c.containerCount} × ${c.containerType ?? "unit"}`],
                ["Published", new Date(c.disclosedAt).toLocaleDateString("en-GB",
                  { day: "numeric", month: "short" })]
              ].map(([k, v]) => (
                <div key={k as string}>
                  <dt className="text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{k}</dt>
                  <dd className="mt-2 text-[13px] font-semibold" style={{ color: "var(--ink)" }}>{v}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-16 rounded-card p-16"
              style={{ background: "var(--milk)", border: "1px solid var(--line)" }}>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: "var(--ink-soft)" }}>
                Offered by
              </p>
              <p className="mt-4 text-sm font-bold" style={{ color: "var(--ink)" }}>{c.companyName}</p>
              {c.companyDescription && (
                <p className="mt-6 text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  {c.companyDescription}
                </p>
              )}
              <div className="mt-8 flex flex-wrap gap-x-16 gap-y-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {c.companyServices && <span>{c.companyServices}</span>}
                {c.companyCorridors && <span>{c.companyCorridors}</span>}
                {c.fleetSizeDeclared !== null && <span>Fleet: {c.fleetSizeDeclared} vehicles</span>}
                {c.yearEstablished !== null && <span>Since {c.yearEstablished}</span>}
              </div>
              {c.companyWebsite && (
                <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>{c.companyWebsite}</p>
              )}
            </div>

            {c.publicNote && (
              <p className="mt-12 text-xs italic" style={{ color: "var(--ink-soft)" }}>{c.publicNote}</p>
            )}

            <div className="mt-16 flex flex-wrap items-center justify-between gap-12">
              <div className="text-xs">
                <span className="block font-semibold" style={{ color: "var(--ink)" }}>{c.contactName}</span>
                <span style={{ color: "var(--ink-soft)" }}>{c.contactChannel}</span>
              </div>
              <div className="flex gap-8">
                {c.pickupLat !== null && c.destLat !== null && (
                  <button type="button" onClick={() => toggleMap(c)}
                    className="rounded-input border px-12 py-6 text-xs font-semibold"
                    style={{ borderColor: "var(--line)", color: "var(--brand)" }}>
                    {expanded === c.id ? "Hide route" : "Show route"}
                  </button>
                )}
                <button type="button" disabled title="Bookings open with the next release"
                  className="rounded-input px-12 py-6 text-xs font-semibold"
                  style={{ background: "var(--milk)", border: "1px solid var(--line)", color: "var(--ink-soft)" }}>
                  Book — coming soon
                </button>
              </div>
            </div>

            {expanded === c.id && c.pickupLat !== null && c.destLat !== null && (
              <div className="mt-16 overflow-hidden rounded-card" style={{ height: 280, border: "1px solid var(--line)" }}>
                <RouteMap
                  a={{ lat: c.pickupLat, lng: c.pickupLng!, name: c.pickupText }}
                  b={{ lat: c.destLat, lng: c.destLng!, name: c.destText }}
                  center={[(c.pickupLat + c.destLat) / 2, (c.pickupLng! + c.destLng!) / 2]}
                  positions={geometry[c.id]}
                />
              </div>
            )}
            {expanded === c.id && c.pickupLat !== null && c.destLat !== null && !geometry[c.id] && (
              <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {noRoute.has(c.id)
                  ? "The road route could not be fetched, so the dashed line is straight distance."
                  : "Dashed line is straight distance — the road route is still loading."}
              </p>
            )}
          </article>
        ))}
      </div>

      {!loading && cards.length === 0 && !denied && (
        <p className="mt-24 text-sm" style={{ color: "var(--ink-soft)" }}>
          {active ? "No load matches these filters right now." :
            "The board is empty. New offers from any company appear here the moment they are published."}
        </p>
      )}

      {cards.length < total && (
        <button type="button" onClick={() => setPage(p => p + 1)}
          className="mt-24 rounded-input border px-16 py-8 text-xs font-semibold"
          style={{ borderColor: "var(--line)", color: "var(--brand)" }}>
          Load {Math.min(PAGE, total - cards.length)} more
        </button>
      )}
    </div>
  );
}
