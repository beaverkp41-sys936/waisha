"use client";
import { useEffect, useRef, useState } from "react";
import { Droplets, MapPin, Navigation, Thermometer, Wind } from "lucide-react";
import {
  DAR_ES_SALAAM, askDeviceLocation, fetchWeather, forgetPlace, readSavedPlace, savePlace
} from "@/lib/weather";
import type { Place, Weather } from "@/lib/weather";

const REFRESH = 15 * 60_000;

/* Sits at the far right of the footer. It reads a public forecast for whatever
   coordinates the person already agreed to share — nothing on the platform is
   consulted, and nothing here is ever sent back. */
export function WeatherStrip() {
  const [place, setPlace] = useState<Place>(DAR_ES_SALAAM);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "off">("loading");
  const [locating, setLocating] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const saved = readSavedPlace();
    if (saved) setPlace(saved);
  }, []);

  useEffect(() => {
    const my = ++seq.current;
    setState("loading");
    fetchWeather(place)
      .then(w => { if (seq.current === my) { setWeather(w); setState("ok"); } })
      .catch(() => { if (seq.current === my) setState("off"); });
    const timer = setInterval(() => {
      fetchWeather(place)
        .then(w => { if (seq.current === my) { setWeather(w); setState("ok"); } })
        .catch(() => { if (seq.current === my) setState("off"); });
    }, REFRESH);
    return () => clearInterval(timer);
  }, [place]);

  async function locate() {
    setLocating(true); setNote(null);
    try {
      const p = await askDeviceLocation();
      savePlace(p); setPlace(p);
    } catch (e: any) {
      forgetPlace(); setPlace(DAR_ES_SALAAM);
      setNote(e?.code === 1
        ? "Location not shared — showing Dar es Salaam."
        : "No fix from the device — showing Dar es Salaam.");
    } finally {
      setLocating(false);
    }
  }

  function reset() {
    forgetPlace(); setPlace(DAR_ES_SALAAM); setNote(null);
  }

  const v = (n: number | undefined) => (n == null ? "—" : Math.round(n));
  const shown = state === "ok" && weather ? weather : null;
  const at = shown ? new Date(shown.fetchedAt) : null;
  const stamp = at
    ? `${at.getDate()}/${at.getMonth() + 1} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
    : null;

  return (
    <span className="weather-strip inline-flex flex-wrap items-center justify-end gap-14 text-right">
      <span className="inline-flex items-center gap-6" title={`Open-Meteo forecast for ${place.label}${stamp ? `, read at ${stamp}` : ""}`}>
        <Thermometer size={15} aria-hidden />
        <span className="tabular-nums font-semibold">{v(shown?.tempC)}&deg;C</span>
        <Droplets size={15} aria-hidden />
        <span className="tabular-nums font-semibold">{v(shown?.humidity)}%</span>
        <Wind size={15} aria-hidden />
        <span className="tabular-nums font-semibold">{v(shown?.windKph)} km/h</span>
      </span>

      <span className="inline-flex items-center gap-6">
        {note && <span className="weather-note text-[11px]">{note}</span>}
        <button
          type="button"
          onClick={place.label === DAR_ES_SALAAM.label ? locate : reset}
          title={place.label === DAR_ES_SALAAM.label
            ? "Use this device's location for the forecast"
            : "Stop using this device's location"}
          className="weather-locate inline-flex items-center gap-5 rounded-full px-9 py-3 text-[11px]"
          disabled={locating}
        >
          {place.label === DAR_ES_SALAAM.label ? <MapPin size={13} aria-hidden /> : <Navigation size={13} aria-hidden />}
          <span>{locating ? "Locating…" : place.label}</span>
        </button>
      </span>
    </span>
  );
}
