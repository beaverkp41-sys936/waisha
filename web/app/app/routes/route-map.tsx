"use client";
import { MapContainer, TileLayer, Marker, Polyline, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";

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