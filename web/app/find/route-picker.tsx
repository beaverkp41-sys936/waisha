"use client";

/**
 * A seeker's route, chosen the way a transporter plans one: region → council → ward at each
 * end, then the road between them.
 *
 * What the search reads is the region pair plus — when that pair sits on one of WAISHA's
 * published corridors — every region the corridor crosses (120). A council or a ward below
 * the region is RECORDED, not matched: listings are tagged at mkoa level, so telling a
 * seeker that Kigamboni narrowed the list would be a promise the database cannot keep, and
 * the log on the history page would repeat the lie.
 *
 * The map is the same component the transporter's builder uses, and it inherits the
 * honesty of that page: an end is pinned at its region centre and labelled as an
 * approximation, because wards carry no coordinates at all, and when the road router does
 * not answer the line drawn between the pins is a straight one, said out loud.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { seekerFetch } from "./api-client";

const RouteMap = dynamic(() => import("../app/routes/route-map"), {
  ssr: false,
  loading: () => <p className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>Drawing the map…</p>
});

/** The five fields that leave the browser. The three names ride along for the labels and
 *  are stripped by routeBody() — the API schema is strict and would answer 400. */
export type RoutePayload = {
  originRegionId: number; destRegionId: number;
  originText: string | null; destText: string | null; corridorId: number | null;
};
export type RoutePick = RoutePayload & {
  originRegion: string; destRegion: string; corridor: string | null;
};

export function routeBody(p: RoutePick): RoutePayload {
  return {
    originRegionId: p.originRegionId, destRegionId: p.destRegionId,
    originText: p.originText, destText: p.destText, corridorId: p.corridorId
  };
}

type GeoRegion = { id: number; name_en: string };
type RegionCoord = { id: number; lat: number; lng: number };
type District = { id: number; name_en: string };
type Ward = { id: number; name: string };
type BoardRow = {
  corridor_id: number; corridor: string; kind: string; notes: string | null;
  origin_region_id: number; origin_region: string;
  dest_region_id: number; dest_region: string;
  region_ids: number[]; region_names: string[]; towns: string[]; companies: number;
};
type PairCorridor = {
  id: number; name: string; kind: string; notes: string | null; reverse: boolean;
  stops: { seq: number; regionId: number; placeId: number | null; label: string;
    lat: number | null; lng: number | null }[];
};
type Trace = { distanceKm: number; durationHours: number; geometry: [number, number][] };
type End = { regionId: string; districtId: string; wardId: string };

const BLANK: End = { regionId: "", districtId: "", wardId: "" };

/** pg sends numeric columns as strings, and a NaN coordinate draws a marker at the edge of
 *  the world instead of nowhere. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function endText(e: End, districts: District[], wards: Ward[]): string | null {
  const d = e.districtId ? districts.find(x => String(x.id) === e.districtId)?.name_en : null;
  const w = e.wardId ? wards.find(x => String(x.id) === e.wardId)?.name : null;
  const joined = [d, w].filter(Boolean).join(" — ");
  // 120 is both the schema limit and the column CHECK; truncating here is kinder than the
  // 400 the seeker would otherwise get back for a long ward name under a long council name.
  return joined ? joined.slice(0, 120) : null;
}

export default function RoutePicker({ regions, onPick }: {
  regions: GeoRegion[];
  onPick: (p: RoutePick | null) => void;
}) {
  const [coords, setCoords] = useState<Record<string, RegionCoord>>({});
  const [origin, setOrigin] = useState<End>(BLANK);
  const [dest, setDest] = useState<End>(BLANK);
  const [districtsByRegion, setDistrictsByRegion] = useState<Record<string, District[]>>({});
  const [wardsByDistrict, setWardsByDistrict] = useState<Record<string, Ward[]>>({});
  const [pair, setPair] = useState<PairCorridor[]>([]);
  const [corridorId, setCorridorId] = useState<number | null>(null);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [boardFailed, setBoardFailed] = useState(false);
  const [showBoard, setShowBoard] = useState(false);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [alts, setAlts] = useState<Trace[]>([]);
  const [traceStatus, setTraceStatus] = useState<"idle" | "loading" | "road" | "failed">("idle");

  const nameOf = (id: number) => regions.find(r => Number(r.id) === id)?.name_en ?? `Region ${id}`;

  useEffect(() => {
    let cancelled = false;
    seekerFetch("/geo/region-coords")
      .then(async res => (res.ok ? res.json() : []))
      .then(rows => {
        if (cancelled || !Array.isArray(rows)) return;
        const m: Record<string, RegionCoord> = {};
        for (const r of rows) {
          const lat = num(r.lat), lng = num(r.lng);
          if (lat !== null && lng !== null) m[String(r.id)] = { id: Number(r.id), lat, lng };
        }
        setCoords(m);
      })
      .catch(() => { });
    return () => { cancelled = true; };
  }, []);

  // The board is WAISHA's own corridor list, aggregate counts only, and it costs no search
  // credit — so it is read when the seeker opens it, not on every page load.
  useEffect(() => {
    if (!showBoard || board.length > 0 || boardFailed) return;
    let cancelled = false;
    seekerFetch("/directory/corridors")
      .then(async res => {
        if (!res.ok) throw new Error("board");
        return res.json();
      })
      .then(rows => { if (!cancelled && Array.isArray(rows)) setBoard(rows); })
      .catch(() => { if (!cancelled) setBoardFailed(true); });
    return () => { cancelled = true; };
  }, [showBoard, board.length, boardFailed]);

  const odKey = origin.regionId && dest.regionId && origin.regionId !== dest.regionId
    ? `${origin.regionId}:${dest.regionId}` : "";

  // Corridor options for the pair the seeker just chose, in the direction they chose it.
  useEffect(() => {
    if (!odKey) { setPair([]); setCorridorId(null); return; }
    const [o, d] = odKey.split(":");
    let cancelled = false;
    seekerFetch(`/geo/corridors?originRegionId=${o}&destRegionId=${d}`)
      .then(async res => (res.ok ? res.json() : []))
      .then((rows: PairCorridor[]) => {
        if (cancelled || !Array.isArray(rows)) return;
        setPair(rows);
        // One road published for this pair is the road; more than one (the coast and the
        // highlands, say) is a choice, so the first is offered and the chips let it be
        // refused. No chain is invented for the pair.
        setCorridorId(rows[0]?.id ?? null);
      })
      .catch(() => { if (!cancelled) { setPair([]); setCorridorId(null); } });
    return () => { cancelled = true; };
  }, [odKey]);

  const adopted = pair.find(c => c.id === corridorId) ?? null;

  const pick: RoutePick | null = useMemo(() => {
    const o = Number(origin.regionId), d = Number(dest.regionId);
    if (!o || !d || o === d) return null;
    return {
      originRegionId: o, destRegionId: d,
      originText: endText(origin, districtsByRegion[origin.regionId] ?? [],
        wardsByDistrict[origin.districtId] ?? []),
      destText: endText(dest, districtsByRegion[dest.regionId] ?? [],
        wardsByDistrict[dest.districtId] ?? []),
      corridorId: adopted?.id ?? null,
      originRegion: nameOf(o), destRegion: nameOf(d), corridor: adopted?.name ?? null
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, dest, regions, adopted, districtsByRegion, wardsByDistrict]);

  const report = useRef(onPick);
  report.current = onPick;
  const signature = pick ? JSON.stringify(pick) : "";
  useEffect(() => { report.current(pick); }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const chain = useMemo(() => {
    if (!pick) return [] as { lat: number; lng: number; name: string; kind: "origin" | "via" | "dest"; detail?: string }[];
    const o = coords[String(pick.originRegionId)], d = coords[String(pick.destRegionId)];
    if (!o || !d) return [];
    const via = (adopted?.stops ?? [])
      .filter(s => s.lat !== null && s.lng !== null &&
        Number(s.regionId) !== pick.originRegionId && Number(s.regionId) !== pick.destRegionId)
      .map(s => ({ lat: s.lat as number, lng: s.lng as number, name: s.label, kind: "via" as const,
                   detail: "On the corridor" }));
    return [
      { lat: o.lat, lng: o.lng, name: pick.originRegion, kind: "origin" as const,
        detail: `${pick.originText ? pick.originText + " · " : ""}Region centre (approx.)` },
      ...via,
      { lat: d.lat, lng: d.lng, name: pick.destRegion, kind: "dest" as const,
        detail: `${pick.destText ? pick.destText + " · " : ""}Region centre (approx.)` }
    ];
  }, [pick, adopted, coords]);

  const chainKey = chain.map(p => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(";");

  useEffect(() => {
    if (chain.length < 2) { setTrace(null); setAlts([]); setTraceStatus("idle"); return; }
    let cancelled = false;
    setTraceStatus("loading");
    const timer = setTimeout(async () => {
      try {
        const wps = chain.map(p => `${p.lat},${p.lng}`).join(";");
        const res = await seekerFetch(`/geo/road-route?wps=${encodeURIComponent(wps)}&alternatives=2`);
        if (!res.ok) throw new Error("routing failed");
        const j = await res.json();
        const main: Trace = {
          distanceKm: Number(j.distanceKm), durationHours: Number(j.durationHours),
          geometry: (j.geometry ?? []) as [number, number][]
        };
        if (main.geometry.length < 2 || !(main.distanceKm > 0)) throw new Error("routing empty");
        const alt: Trace[] = (j.alternatives ?? [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((a: any) => ({ distanceKm: Number(a.distanceKm), durationHours: Number(a.durationHours),
                              geometry: (a.geometry ?? []) as [number, number][] }))
          .filter((a: Trace) => a.geometry.length >= 2 && a.distanceKm > 0);
        if (cancelled) return;
        setTrace(main); setAlts(alt); setTraceStatus("road");
      } catch {
        if (cancelled) return;
        setTrace(null); setAlts([]); setTraceStatus("failed");
      }
    }, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [chainKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pickRegion(side: "origin" | "dest", v: string) {
    const next = { regionId: v, districtId: "", wardId: "" };
    if (side === "origin") setOrigin(next); else setDest(next);
    if (v && !districtsByRegion[v]) {
      const res = await seekerFetch(`/geo/districts/${v}`);
      if (res.ok) {
        const rows = await res.json();
        setDistrictsByRegion(prev => ({ ...prev, [v]: rows }));
      }
    }
  }

  async function pickDistrict(side: "origin" | "dest", v: string) {
    if (side === "origin") setOrigin(p => ({ ...p, districtId: v, wardId: "" }));
    else setDest(p => ({ ...p, districtId: v, wardId: "" }));
    if (v && !wardsByDistrict[v]) {
      const res = await seekerFetch(`/geo/wards/${v}`);
      if (res.ok) {
        const rows = await res.json();
        setWardsByDistrict(prev => ({ ...prev, [v]: rows }));
      }
    }
  }

  function pickWard(side: "origin" | "dest", v: string) {
    if (side === "origin") setOrigin(p => ({ ...p, wardId: v }));
    else setDest(p => ({ ...p, wardId: v }));
  }

  function swap() {
    setOrigin(dest); setDest(origin);
    setCorridorId(null);
  }

  function applyBoard(row: BoardRow) {
    setOrigin({ regionId: String(row.origin_region_id), districtId: "", wardId: "" });
    setDest({ regionId: String(row.dest_region_id), districtId: "", wardId: "" });
  }

  const endBlock = (side: "origin" | "dest", e: End, title: string) => {
    const districts = districtsByRegion[e.regionId] ?? [];
    const wards = wardsByDistrict[e.districtId] ?? [];
    const inputCls = "rounded-input border px-12 py-8 text-sm";
    const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
    return (
      <div className="min-w-[220px] flex-1">
        <p className="mb-8 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
          {title}
        </p>
        <select value={e.regionId} onChange={ev => void pickRegion(side, ev.target.value)}
          aria-label={`${title} region`} className={inputCls} style={inputStyle}>
          <option value="">Region (Mkoa)</option>
          {regions.map(r => <option key={r.id} value={r.id}>{r.name_en}</option>)}
        </select>
        <div className="mt-8 grid grid-cols-2 gap-8">
          <select value={e.districtId} disabled={!e.regionId}
            onChange={ev => void pickDistrict(side, ev.target.value)}
            aria-label={`${title} council`} className={inputCls}
            style={{ ...inputStyle, opacity: e.regionId ? 1 : 0.5 }}>
            <option value="">{e.regionId ? "Council (Wilaya)" : "Pick region"}</option>
            {districts.map(d => <option key={d.id} value={d.id}>{d.name_en}</option>)}
          </select>
          <select value={e.wardId} disabled={!e.districtId}
            onChange={ev => pickWard(side, ev.target.value)}
            aria-label={`${title} ward`} className={inputCls}
            style={{ ...inputStyle, opacity: e.districtId ? 1 : 0.5 }}>
            <option value="">{e.districtId ? "Ward (Kata)" : "Pick council"}</option>
            {wards.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
      </div>
    );
  };

  const chip = (on: boolean) =>
    `on-photo-btn rounded-input px-12 py-8 text-xs font-semibold${on ? " is-on" : ""}`;
  const lineStyle = { borderColor: "var(--line)" };

  return (
    <div className="mt-20 border-t pt-20" style={lineStyle}>
      <div className="flex flex-wrap items-baseline justify-between gap-12">
        <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
          Or search a route
        </h2>
        <button type="button" onClick={() => setShowBoard(v => !v)}
          aria-expanded={showBoard} className={chip(showBoard)}>
          {showBoard ? "Hide all corridors" : "All WAISHA corridors"}
        </button>
      </div>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Pick where the cargo is collected and where it must go, each one region → council →
        ward, the way a transporter plans it. Companies are tagged at region level, so the
        search runs on the two regions — and on the whole road between them when WAISHA
        publishes one.
      </p>

      <div className="mt-16 flex flex-wrap items-end gap-12">
        {endBlock("origin", origin, "From")}
        <button type="button" onClick={swap} disabled={!origin.regionId && !dest.regionId}
          aria-label="Swap the two ends"
          className="on-photo-btn rounded-input px-12 py-8 text-xs font-semibold disabled:opacity-40">
          ⇄ Swap
        </button>
        {endBlock("dest", dest, "To")}
      </div>

      {pick && (
        <div className="mt-16 flex flex-wrap items-center gap-8">
          <span className="mr-4 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            The road
          </span>
          {pair.length === 0 ? (
            <span className="text-xs" style={{ color: "var(--warning)" }}>
              No published corridor between {pick.originRegion} and {pick.destRegion} — this
              one is searched as its two ends.
            </span>
          ) : (
            <>
              {pair.map(c => (
                <button key={c.id} type="button" aria-pressed={c.id === corridorId}
                  onClick={() => setCorridorId(c.id)} className={chip(c.id === corridorId)}>
                  {c.name}
                </button>
              ))}
              <button type="button" aria-pressed={corridorId === null}
                onClick={() => setCorridorId(null)} className={chip(corridorId === null)}>
                Only the two ends
              </button>
            </>
          )}
        </div>
      )}

      {pick && chain.length === 0 && (
        <p className="mt-12 text-sm" style={{ color: "var(--warning)" }}>
          {nameOf(pick.originRegionId)} and {nameOf(pick.destRegionId)} have no centre on the
          map, so this route cannot be drawn — the search still runs on the two regions.
        </p>
      )}

      {pick && chain.length >= 2 && (
        <div className="mt-16 rounded-card border p-8" style={lineStyle}>
          <div className="h-[300px] w-full overflow-hidden rounded-input">
            <RouteMap points={chain} lines={[
              ...(trace ? [{ positions: trace.geometry, kind: "road" as const }] : []),
              ...(!trace && chain.length >= 2
                ? [{ positions: chain.map(p => [p.lat, p.lng] as [number, number]), kind: "guess" as const }]
                : []),
              ...(alts.map(a => ({ positions: a.geometry, kind: "alt" as const })))
            ]} />
          </div>
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            {traceStatus === "loading" ? "Reading the road between these points…"
              : trace ? <>About <strong>{Math.round(trace.distanceKm)} km</strong> of road,
                  roughly <strong>{trace.durationHours.toFixed(1)} h</strong> driving
                  {" · "}ends pinned at their region centre (approx.)
                  {alts.length ? ` · ${alts.length} other way also drawn` : ""}.</>
              : <>The road router did not answer, so this line is straight, not the road.
                  {" · "}ends pinned at their region centre (approx.)</>}
            {" · "}tap a pin to read it.
          </p>
        </div>
      )}

      {/* Every main corridor WAISHA publishes, best-connected first, each one a way to fill
          the two ends above without scrolling through 31 regions twice. */}
      {showBoard && (
        <div className="mt-16">
          {boardFailed ? (
            <p className="text-sm" style={{ color: "var(--danger)" }}>
              The corridor list did not load. The two pickers above still work.
            </p>
          ) : board.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Reading the corridors…</p>
          ) : (
            <ul className="grid gap-8">
              {board.map(b => (
                <li key={b.corridor_id}>
                  <button type="button" onClick={() => applyBoard(b)}
                    className="w-full rounded-input border px-12 py-8 text-left transition-colors hover:border-[var(--gold)]"
                    style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
                    <span className="flex flex-wrap items-baseline gap-8">
                      <strong className="text-sm" style={{ color: "var(--ink)" }}>{b.corridor}</strong>
                      {b.kind === "main" && (
                        <span className="text-[10px] font-bold uppercase tracking-[0.12em]"
                          style={{ color: "var(--gold-green)" }}>Main</span>
                      )}
                      <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                        {b.origin_region} → {b.dest_region}
                      </span>
                      <span className="ml-auto text-xs" style={{ color: "var(--ink)" }}>
                        {Number(b.companies)} compan{Number(b.companies) === 1 ? "y" : "ies"}
                      </span>
                    </span>
                    <span className="mt-4 block text-xs" style={{ color: "var(--ink-soft)" }}>
                      {(b.towns ?? []).slice(0, 6).join(" · ")}
                      {(b.towns ?? []).length > 6 ? " · …" : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            Tap a corridor to put its two ends in the pickers. The company count is what lives
            on the road now, not what a search for it will return.
          </p>
        </div>
      )}
    </div>
  );
}
