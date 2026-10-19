import { describe, expect, it } from "vitest";
import { RoutingUnavailable, traceRoad } from "../src/util/road-router.js";

/** The builder's own chain: Dar es Salaam -> Morogoro -> Iringa -> Mbeya. */
const CHAIN: [number, number][] = [[-6.8, 39.28], [-6.82, 37.66], [-7.98, 35.7], [-8.89, 33.45]];

const road = (km: number, hours: number, pts: [number, number][] = [[39.28, -6.8], [33.45, -8.89]]) => ({
  distance: km * 1000, duration: hours * 3600, geometry: { coordinates: pts }
});

const ok = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const http = (status: number, body: unknown) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

/** Records every URL the module asks for, so a retry can be proved, not assumed. */
function recorder(pick: (n: number, url: string) => unknown) {
  const urls: string[] = [];
  const fn = async (url: unknown) => {
    urls.push(String(url));
    const r = pick(urls.length, String(url));
    return r instanceof Error ? Promise.reject(r) : r;
  };
  return { fetchImpl: fn as unknown as typeof fetch, urls };
}

describe("the road router the builder asks", () => {
  it("sends the chain as lng,lat and answers in lat,lng", async () => {
    const r = recorder(() => ok({ code: "Ok", routes: [road(509, 10)] }));
    const traced = await traceRoad(CHAIN, 0, { fetchImpl: r.fetchImpl });
    expect(r.urls[0]).toContain("39.28,-6.8;37.66,-6.82;35.7,-7.98;33.45,-8.89");
    expect(traced[0]).toEqual({
      distanceKm: 509, durationHours: 10, geometry: [[-6.8, 39.28], [-8.89, 33.45]]
    });
  });

  it("asks for the detailed line and every alternative the caller wanted", async () => {
    const r = recorder(() => ok({ code: "Ok", routes: [road(509, 10)] }));
    await traceRoad(CHAIN, 2, { fetchImpl: r.fetchImpl });
    expect(r.urls[0]).toContain("overview=full");
    expect(r.urls[0]).toContain("&alternatives=2");
    expect(r.urls).toHaveLength(1);
  });

  it("keeps the distance the road measured, not the polyline", async () => {
    const r = recorder(() => ok({ code: "Ok", routes: [road(1171.5, 15.4)] }));
    const [t] = await traceRoad(CHAIN, 0, { fetchImpl: r.fetchImpl });
    expect(t.distanceKm).toBe(1172);
    expect(t.durationHours).toBe(15);
  });

  it("hands back every road the router offered, main one first", async () => {
    const r = recorder(() => ok({
      code: "Ok", routes: [road(509, 10), road(531, 11), { distance: 0, geometry: { coordinates: [] } }]
    }));
    const traced = await traceRoad(CHAIN, 2, { fetchImpl: r.fetchImpl });
    expect(traced.map(t => t.distanceKm)).toEqual([509, 531]);
  });
});

describe("when the shared router does not answer", () => {
  it("asks once more, lighter, and takes the second answer", async () => {
    const r = recorder((n) => n === 1 ? http(500, { code: "Error" }) : ok({ code: "Ok", routes: [road(509, 10)] }));
    const traced = await traceRoad(CHAIN, 2, { fetchImpl: r.fetchImpl });
    expect(traced[0].distanceKm).toBe(509);
    expect(r.urls).toHaveLength(2);
    expect(r.urls[1]).toContain("overview=simplified");
    expect(r.urls[1]).not.toContain("alternatives");
  });

  it("treats an answer with nothing drawable as no answer", async () => {
    const r = recorder((n) => n === 1
      ? ok({ code: "Ok", routes: [{ distance: 509000, duration: 36000, geometry: { coordinates: [[39.28, -6.8]] } }] })
      : ok({ code: "Ok", routes: [road(509, 10)] }));
    const traced = await traceRoad(CHAIN, 0, { fetchImpl: r.fetchImpl });
    expect(traced[0].geometry.length).toBe(2);
    expect(r.urls[1]).toContain("overview=simplified");
  });

  it("asks again when the first attempt ran out of time", async () => {
    const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const r = recorder((n) => n === 1 ? aborted : ok({ code: "Ok", routes: [road(509, 10)] }));
    const traced = await traceRoad(CHAIN, 0, { fetchImpl: r.fetchImpl });
    expect(traced[0].distanceKm).toBe(509);
    expect(r.urls).toHaveLength(2);
  });

  it("does not ask twice about a chain with no road on it", async () => {
    const r = recorder(() => http(400, { code: "NoRoute", message: "No route between the points." }));
    await expect(traceRoad(CHAIN, 2, { fetchImpl: r.fetchImpl })).rejects.toBeInstanceOf(RoutingUnavailable);
    expect(r.urls).toHaveLength(1);
  });

  it("gives up naming both attempts, so the operator can tell the two apart", async () => {
    const r = recorder(() => http(502, { code: "Bad Gateway" }));
    const e = await traceRoad(CHAIN, 2, { fetchImpl: r.fetchImpl })
      .then(() => null).catch((x: RoutingUnavailable) => x);
    expect(e).toBeInstanceOf(RoutingUnavailable);
    expect(e?.cause).toContain("router answered 502");
    expect(r.urls).toHaveLength(2);
  });
});
