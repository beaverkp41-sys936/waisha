"use client";
import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet derives the default icon URLs from where it thinks its assets live,
// which bundlers break — the markers then 404 against the app origin.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl;

export type StopKind = "origin" | "via" | "dest" | "pin";
export interface MapPoint { lat: number; lng: number; name: string; kind: StopKind; }
export interface MapLine { positions: [number, number][]; kind: "road" | "alt" | "guess"; }

const STYLES: Record<StopKind, { label: string; color: string }> = {
  origin: { label: "A", color: "#2E6F95" },
  dest: { label: "B", color: "#1F7A5C" },
  via: { label: "", color: "#6B7C8A" },
  pin: { label: "+", color: "#C98A2B" }
};

function stopIcon(kind: StopKind, seq: number) {
  const s = STYLES[kind];
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
    map.fitBounds(bounds, { padding: [30, 30] });
    // Only on a real shape change — never on pan/zoom, or the user cannot move.
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function RouteMap({ points, lines, center, zoom, onPin }: {
  points: MapPoint[];
  lines?: MapLine[];
  center?: [number, number];
  zoom?: number;
  onPin?: (lat: number, lng: number) => void;
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
          <Popup>{p.name}</Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
