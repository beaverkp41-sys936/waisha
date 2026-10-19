/**
 * The road router behind the route builder.
 *
 * Every corridor the planner offers is traced on the public OSRM demo server —
 * the only routing this app pays for. That server is shared with the whole world,
 * so it is sometimes simply not listening: on 2026-10-15 and 10-16 it shed every
 * attempt a transporter made for his Dar es Salaam corridors, and the builder told
 * him road routing was unavailable while his route sat there with no line and no
 * record of what its distance was based on. So this module owns two things the
 * caller should not have to remember:
 *
 *  1. a second attempt, made lighter (a simplified polyline, the main road only),
 *     because a loaded router is more likely to answer a smaller question;
 *  2. the difference between "this router is not answering" and "this chain has no
 *     road" — the second is not worth asking twice, and the operator deserves to
 *     know which one happened.
 */

export interface RoadTrace {
  distanceKm: number;
  durationHours: number;
  geometry: [number, number][];
}

/** Two of these back the old single 15 s budget, and the builder keeps saving
 *  while the trace runs, so nobody waits on a router that has stopped answering. */
export const ATTEMPT_TIMEOUT_MS = 8000;

const OSRM = "https://router.project-osrm.org/route/v1/driving";

/** OSRM says so itself when a chain cannot be driven at all — no point asking again. */
const REJECTED = new Set(["NoRoute", "NoSegment", "InvalidInput"]);

/** The chain is [lat, lng]; the router wants lng,lat on the URL. */
function coordsOf(chain: [number, number][]) {
  return chain.map(([lat, lng]) => `${lng},${lat}`).join(";");
}

class RoutingRejected extends Error { }

/** The reason a router is not an answer, kept short so it can be logged. */
function describeFailure(e: unknown, timeoutMs: number): string {
  if (e instanceof Error && e.name === "AbortError") return `timed out after ${timeoutMs}ms`;
  if (e instanceof Error && e.message) return e.message;
  return "no answer";
}

async function attempt(
  url: string, fetchImpl: typeof fetch, timeoutMs: number
): Promise<RoadTrace[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    // The body is read either way: OSRM puts its `code` on 400s too, and that is
    // the only way to tell a dead router from an undriveable chain.
    let json: any = null;
    try { json = await res.json(); } catch { /* an HTML error page */ }
    if (!res.ok) {
      if (REJECTED.has(json?.code)) throw new RoutingRejected(json.code);
      throw new Error(`router answered ${res.status}`);
    }
    // OSRM v1 answers under `routes`; reading `route` yields nothing and every
    // caller silently falls back to a straight line.
    return (json?.routes ?? [])
      .map((r: any) => ({
        distanceKm: Math.round((r?.distance ?? 0) / 1000),
        durationHours: Math.round((r?.duration ?? 0) / 3600),
        geometry: ((r?.geometry?.coordinates ?? []) as [number, number][])
          .map(([lng, lat]) => [lat, lng] as [number, number])
      }))
      .filter((t: RoadTrace) => t.geometry.length >= 2 && t.distanceKm > 0);
  } finally {
    clearTimeout(timer);
  }
}

export class RoutingUnavailable extends Error {
  constructor(readonly cause: string) {
    super(`Road routing did not answer: ${cause}`);
  }
}

/**
 * Trace the whole chain origin -> via* -> destination. Returns the main road first
 * and any alternatives the router offered; throws RoutingUnavailable when the
 * router gave no answer at all, which is the caller's cue to fall back to an
 * estimate and say so.
 */
export async function traceRoad(
  chain: [number, number][],
  alternatives: number,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<RoadTrace[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const coords = coordsOf(chain);

  let first = "";
  try {
    const routes = await attempt(
      `${OSRM}/${coords}?overview=full&geometries=geojson` +
      (alternatives ? `&alternatives=${alternatives}` : ""),
      fetchImpl, timeoutMs);
    if (routes.length) return routes;
    first = "answered with no drawable road";
  } catch (e) {
    if (e instanceof RoutingRejected) throw new RoutingUnavailable(String(e.message));
    first = describeFailure(e, timeoutMs);
  }

  const light = `${OSRM}/${coords}?overview=simplified&geometries=geojson`;
  try {
    const routes = await attempt(light, fetchImpl, timeoutMs);
    if (routes.length) return routes;
    throw new RoutingUnavailable(`${first}, and the lighter retry gave no road`);
  } catch (e) {
    if (e instanceof RoutingUnavailable) throw e;
    if (e instanceof RoutingRejected) throw new RoutingUnavailable(String(e.message));
    throw new RoutingUnavailable(`${first}, retry ${describeFailure(e, timeoutMs)}`);
  }
}
