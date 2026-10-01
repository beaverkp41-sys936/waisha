"use client";
import { MapContainer, TileLayer, Marker, Polyline, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";

export interface MapPoint { lat: number; lng: number; name: string; }

export default function RouteMap({ a, b, center }: {
  a: MapPoint; b: MapPoint; center: [number, number];
}) {
  return (
    <MapContainer center={center} zoom={6} style={{ height: "100%", width: "100%" }}>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors" />
      <Marker position={[a.lat, a.lng]}><Popup>Origin: {a.name}</Popup></Marker>
      <Marker position={[b.lat, b.lng]}><Popup>Destination: {b.name}</Popup></Marker>
      <Polyline positions={[[a.lat, a.lng], [b.lat, b.lng]]}
        pathOptions={{ color: "#2E6F95", weight: 2, dashArray: "6 8" }} />
    </MapContainer>
  );
}