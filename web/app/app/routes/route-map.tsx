"use client";
import { MapContainer, TileLayer, Marker, Polyline, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet derives the default icon URLs from where it thinks its assets live,
// which bundlers break — the markers then 404 against the app origin.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png"
});

export interface MapPoint { lat: number; lng: number; name: string; }

export default function RouteMap({ a, b, center, positions }: {
  a: MapPoint; b: MapPoint; center: [number, number];
  positions?: [number, number][];
}) {
  const line: [number, number][] = positions ?? [[a.lat, a.lng], [b.lat, b.lng]];
  const solid = !!positions;
  return (
    <MapContainer center={center} zoom={6} style={{ height: "100%", width: "100%" }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors" />
      <Marker position={[a.lat, a.lng]}><Popup>Origin: {a.name}</Popup></Marker>
      <Marker position={[b.lat, b.lng]}><Popup>Destination: {b.name}</Popup></Marker>
      <Polyline positions={line}
        pathOptions={{ color: "#2E6F95", weight: solid ? 4 : 2, dashArray: solid ? undefined : "6 8" }} />
    </MapContainer>
  );
}