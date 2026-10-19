"use client";
import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet derives the default icon URLs from where it thinks its assets live,
// which bundlers break — the markers then 404 against the app origin.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl;

export type StopKind = "origin" | "via" | "dest" | "pin" | "truck" | "truck_old";
export interface MapPoint {
  lat: number; lng: number; name: string; kind: StopKind;
  /** Second line in the popup — the age of a position, the plate, anything short. Never
   *  rendered into the marker icon itself, which is built from a fixed palette. */
  detail?: string;
}
export interface MapLine { positions: [number, number][]; kind: "road" | "alt" | "guess"; }

const STYLES: Record<StopKind, { label: string; color: string }> = {
  origin: { label: "A", color: "#2E6F95" },
  dest: { label: "B", color: "#1F7A5C" },
  via: { label: "", color: "#6B7C8A" },
  pin: { label: "+", color: "#C98A2B" },
  // A vehicle that reported itself recently, and one whose report has gone stale. The stale
  // marker is deliberately still drawn: a fleet map that hides the unlocated trucks is a map
  // that hides exactly the ones a dispatcher most needs to ask about.
  truck: { label: "", color: "#1F7A5C" },
  truck_old: { label: "", color: "#8A96A2" }
};

// Fixed markup per kind. Nothing tenant-authored reaches this string — a driver's note is
// only ever rendered as React text in the popup, so it cannot close the span and paint.
const TRUCK_GLYPH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="#fff" '
  + 'aria-hidden="true"><path d="M1 4h11a2 2 0 0 1 2 2v9H1V4zm14 4h3.2a1 1 0 0 1 .9.55L21.8 12'
  + 'v3h-4.8V8zM5.5 19.5a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm11.5 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>';

function stopIcon(kind: StopKind, seq: number) {
  const s = STYLES[kind];
  if (kind === "truck" || kind === "truck_old") {
    return L.divIcon({
      className: "",
      html: `<span style="display:flex;align-items:center;justify-content:center;`
        + `width:26px;height:22px;border-radius:6px;background:${s.color};`
        + `border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.4)">${TRUCK_GLYPH}</span>`,
      iconSize: [26, 22], iconAnchor: [13, 11], popupAnchor: [0, -12]
    });
  }
  const text = kind === "via" ? String(seq) : s.label;
  return L.divIcon({
    className: "",
    html: `<span style="display:flex;align-items:center;justify-content:center;`
      + `width:24px;height:24px;border-radius:50%;background:${s.color};color:#fff;`
      + `font:700 12px/1 ui-sans-serif,system-ui,sans-serif;border:2px solid #fff;`
      + `box-shadow:0 1px 5px rgba(0,0,0,.4)">${text}</span>`,
    iconSize: [24, 24], iconAnchor: [12, 12], popupAnchor: [0, -12]
  });
}

const LINE_STYLE: Record<MapLine["kind"], L.PathOptions> = {
  road: { color: "#2E6F95", weight: 5, opacity: 0.95 },
  alt: { color: "#7C8B99", weight: 3, opacity: 0.75, dashArray: "1 8" },
  guess: { color: "#C98A2B", weight: 2, opacity: 0.85, dashArray: "6 8" }
};

function PinCatcher({ onPin }: { onPin: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onPin(e.latlng.lat, e.latlng.lng) });
  return null;
}

/** react-leaflet keeps the view from the first render, so a builder that adds
 *  stops has to move the map itself or a long corridor runs off-screen. */
function Recenter({ signature, bounds }: {
  signature: string; bounds: [[number, number], [number, number]];
}) {
  const map = useMap();
  useEffect(() => {
    // A single stop is a degenerate box, and fitBounds answers it at street level — which
    // claims a precision a town name or a ±5 km report never had. Cap the follow-in.
    const span = Math.abs(bounds[1][0] - bounds[0][0]) + Math.abs(bounds[1][1] - bounds[0][1]);
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: span < 0.4 ? 11 : undefined });
    // Only on a real shape change — never on pan/zoom, or the user cannot move.
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function RouteMap({ points, lines, center, zoom, onPin, onPick }: {
  points: MapPoint[];
  lines?: MapLine[];
  center?: [number, number];
  zoom?: number;
  onPin?: (lat: number, lng: number) => void;
  /** When set, every popup carries one button that calls this with the point's index. */
  onPick?: (index: number) => void;
}) {
  const first = points[0];
  const mid: [number, number] = center
    ?? (first ? [first.lat, first.lng] : [-6.36, 34.88]);
  const signature = points.map(p => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(";");
  const bounds = (() => {
    if (points.length === 0) return [[-6.36, 34.88], [-6.36, 34.88]] as [[number, number], [number, number]];
    const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
    return [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]] as
      [[number, number], [number, number]];
  })();
  let viaSeq = 0;

  return (
    <MapContainer center={mid} zoom={zoom ?? 6} style={{ height: "100%", width: "100%" }}
      scrollWheelZoom={false}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors" />
      {onPin && <PinCatcher onPin={onPin} />}
      {points.length > 0 && <Recenter signature={signature} bounds={bounds} />}
      {(lines ?? []).map((l, i) => (
        <Polyline key={`l${i}`} positions={l.positions} pathOptions={LINE_STYLE[l.kind]} />
      ))}
      {points.map((p, i) => (
        <Marker key={`p${i}-${p.kind}`} position={[p.lat, p.lng]}
          icon={stopIcon(p.kind, p.kind === "via" ? ++viaSeq : 0)}>
          <Popup>
            <span style={{ display: "block", fontWeight: 700 }}>{p.name}</span>
            {p.detail && <span style={{ display: "block", marginTop: 2 }}>{p.detail}</span>}
            {onPick && (
              <button type="button" style={{ marginTop: 6, fontWeight: 700, cursor: "pointer" }}
                onClick={() => onPick(i)}>Open file</button>
            )}
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
