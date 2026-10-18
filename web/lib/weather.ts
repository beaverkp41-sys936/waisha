"use client";

/* Weather comes from Open-Meteo, a public non-commercial forecast service that
   needs no key and asks for no account. This module deliberately knows nothing
   about the person reading it: the request carries no cookie, no token, no
   tenant and no referrer, and a location is only ever sent after the person
   hands it over — rounded to ~1 km first, so a street address never leaves the
   device. Nothing here is stored on the server or used by any decision in the
   app; it is a number on a footer, and that is the whole contract. */

export interface Weather {
  tempC: number;
  humidity: number;
  windKph: number;
  fetchedAt: number;
}

export interface Place {
  lat: number;
  lng: number;
  label: string;
}

export const DAR_ES_SALAAM: Place = { lat: -6.79, lng: 39.21, label: "Dar es Salaam" };

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const TTL = 15 * 60_000;
const STORAGE_KEY = "waisha.weather.place";

const cache = new Map<string, Weather>();
const inflight = new Map<string, Promise<Weather>>();

/** Two decimals is about a kilometre — enough for a forecast, not enough to find a person. */
function keyOf(p: Place) {
  return `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
}

export function readSavedPlace(): Place | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<Place>;
    const lat = Number(j.lat), lng = Number(j.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -20 || lat > 5 || lng < 25 || lng > 45) return null;
    return { lat, lng, label: typeof j.label === "string" && j.label ? j.label.slice(0, 40) : "Your area" };
  } catch {
    return null;
  }
}

export function savePlace(p: Place) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* private mode — this refresh only */ }
}

export function forgetPlace() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to forget */ }
}

export async function fetchWeather(place: Place): Promise<Weather> {
  const key = keyOf(place);
  const fresh = cache.get(key);
  if (fresh && Date.now() - fresh.fetchedAt < TTL) return fresh;

  const running = inflight.get(key);
  if (running) return running;

  const url = `${ENDPOINT}?latitude=${encodeURIComponent(key.split(",")[0])}`
    + `&longitude=${encodeURIComponent(key.split(",")[1])}`
    + `&current=temperature_2m,relative_humidity_2m,wind_speed_10m`
    + `&wind_speed_unit=kmh&timezone=auto`;

  const call = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "default"
      });
      if (!res.ok) throw new Error(`forecast ${res.status}`);
      const j = await res.json();
      const c = j?.current ?? {};
      const tempC = Number(c.temperature_2m);
      const humidity = Number(c.relative_humidity_2m);
      const windKph = Number(c.wind_speed_10m);
      if (![tempC, humidity, windKph].every(Number.isFinite)) throw new Error("forecast unreadable");
      const w: Weather = { tempC, humidity, windKph, fetchedAt: Date.now() };
      cache.set(key, w);
      return w;
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  })();

  inflight.set(key, call);
  return call;
}

/** The browser will not name a place without another network call, and a name
 *  from the map service is a second hand on the same location — so the label
 *  stays the person's own words. */
export function askDeviceLocation(): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) { reject(new Error("no-geolocation")); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        lat: Number(pos.coords.latitude.toFixed(2)),
        lng: Number(pos.coords.longitude.toFixed(2)),
        label: "Your area"
      }),
      err => reject(err),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600_000 }
    );
  });
}
