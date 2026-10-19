import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";
import { pool } from "../db/pool.js";
import { normalisePath } from "./error-record.js";

/**
 * The reliability collector (085).
 *
 * 082 made a failure a row. This makes the three things that never left a trace into rows:
 * a worker that was alive, a route that was slow, and a response that took four seconds and
 * still returned 200. Nothing outside the process knows about those, so the process has to
 * keep the book itself.
 *
 * Three rules hold it together, and all three exist because the collector is bolted onto
 * the hot path of every request in the system:
 *
 *  1. It never blocks and never throws. Every write is fire-and-forget with a catch, and
 *     the definer swallows its own failures too — a metrics collector that can break a
 *     request is how a monitoring feature becomes the outage it is watching.
 *  2. It never writes per request. Durations are folded into an in-process table of
 *     (method, route) cells and flushed on a timer, because this database sits behind a
 *     pooler and an extra round trip on every response would make the latency store the
 *     thing that makes the API slow. A flush costs one statement per five seconds.
 *  3. It never invents a bucket. The minute stamp is the database's own `now()`, taken at
 *     flush, so the latency series shares a clock with app_errors and the heartbeat series.
 *     The cost is that a request can be attributed to the minute its flush landed in — one
 *     minute at most, which is noise for a p95 and would be a lie if two clocks disagreed.
 */

/** Exported so the verify script executes the identical string, not a re-typing. */
export const RECORD_REQUESTS_SQL = "select platform_auth.record_requests($1::jsonb)";
export const RECORD_BOOT_SQL = "select platform_auth.record_boot($1,$2,$3,$4)";
export const RECORD_HEARTBEAT_SQL = "select platform_auth.record_heartbeat($1)";

/** `<pid>@<host>` — two dynos of one deployment are two instances, and a rolling restart
 *  shows up as a new one instead of a hole in the middle of the old one's series. */
export const INSTANCE_ID = `${process.pid}@${(hostname() || "waisha").slice(0, 40)}`;

const START_KEY = Symbol("reliabilityStart");

type Cell = {
  requests: number;
  sumMs: number;
  maxMs: number;
  /** <100, <300, <1000, <3000, >=3000 — the bands the readers interpolate percentiles from. */
  bands: [number, number, number, number, number];
  serverErrors: number;
};

let buffer = new Map<string, Cell>();

/** A route-keyed map fed by an unvalidated URL is a way to run out of memory on a crawler
 *  that asks for a million different ids. The path is already normalised; this is the
 *  backstop, and when it trips the flush happens early rather than the data being kept. */
const MAX_CELLS = 400;
const FLUSH_EVERY_MS = 5_000;
const BEAT_EVERY_MS = 60_000;

function bandOf(ms: number): number {
  if (ms < 100) return 0;
  if (ms < 300) return 1;
  if (ms < 1000) return 2;
  if (ms < 3000) return 3;
  return 4;
}

/** Folded in memory; the clamping that matters (a negative or absurd duration) is done by
 *  the definer, so this only has to keep the numbers it hands over sane in shape. */
export function foldRequest(method: string, route: string, ms: number, status: number) {
  const key = `${method} ${route}`;
  if (buffer.size > MAX_CELLS && !buffer.has(key)) return false;
  const clamped = Math.max(0, Math.min(Math.round(ms), 600000));
  const cell = buffer.get(key);
  if (cell) {
    cell.requests += 1;
    cell.sumMs += clamped;
    if (clamped > cell.maxMs) cell.maxMs = clamped;
    cell.bands[bandOf(clamped)] += 1;
    if (status >= 500) cell.serverErrors += 1;
    return true;
  }
  const bands: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  bands[bandOf(clamped)] = 1;
  buffer.set(key, {
    requests: 1, sumMs: clamped, maxMs: clamped, bands,
    serverErrors: status >= 500 ? 1 : 0
  });
  return true;
}

/**
 * Drain and write. The swap is synchronous so nothing in flight is lost or counted twice:
 * a request that finishes during a flush simply lands in the new map.
 */
export async function flushRequestTimings(): Promise<number> {
  if (buffer.size === 0) return 0;
  const drained = buffer;
  buffer = new Map();
  const rows = [...drained.entries()].map(([key, c]) => {
    const sp = key.indexOf(" ");
    return {
      method: key.slice(0, sp),
      route: key.slice(sp + 1),
      requests: c.requests,
      sum_ms: c.sumMs,
      max_ms: c.maxMs,
      band_fast: c.bands[0], band_ok: c.bands[1], band_slow: c.bands[2],
      band_bad: c.bands[3], band_awful: c.bands[4],
      server_errors: c.serverErrors
    };
  });
  await pool.query(RECORD_REQUESTS_SQL, [JSON.stringify(rows)]);
  return rows.length;
}

/** A streaming reply never "finishes" in the sense the store means: the elapsed time of a
 *  board socket is how long somebody kept a tab open, not how long the API took. */
function isStream(reply: any): boolean {
  const ct = String(reply.getHeader?.("content-type") ?? "");
  return ct.includes("text/event-stream") || ct.includes("websocket");
}

export function registerReliability(app: FastifyInstance) {
  // Registered before the routes so every request is timed, including one that fails
  // validation or never reaches a handler — a refused request still cost the server
  // something, and that is the number an operator wants when a flood is happening.
  app.addHook("onRequest", async (req: any) => {
    req[START_KEY] = performance.now();
  });

  app.addHook("onResponse", async (req: any, reply: any) => {
    try {
      if (isStream(reply)) return;
      const started = req[START_KEY];
      if (typeof started !== "number") return;
      foldRequest(req.method, normalisePath(req.url), performance.now() - started,
        reply.statusCode);
    } catch {
      // Timing a request must never become a way to fail one.
    }
  });
}

/**
 * Boot line, first heartbeat, then the two loops. Called once from main after the port is
 * open: a process that never reached `listen` never appears here, which is the correct
 * answer — this register describes the thing that was serving.
 */
export function startReliabilityLoops(log: any) {
  const beat = () => {
    pool.query(RECORD_HEARTBEAT_SQL, [INSTANCE_ID])
      .catch((e) => log?.warn({ code: e?.code }, "heartbeat lost"));
  };
  const flush = () => {
    flushRequestTimings()
      .catch((e) => log?.warn({ code: e?.code }, "timing flush lost"));
  };

  pool.query(RECORD_BOOT_SQL,
    [INSTANCE_ID, process.version, `${process.platform}/${process.arch}`, env.NODE_ENV])
    .then(beat)
    .catch((e) => log?.warn({ code: e?.code }, "boot record lost"));

  const beats = setInterval(beat, BEAT_EVERY_MS);
  const flushes = setInterval(flush, FLUSH_EVERY_MS);
  beats.unref();
  flushes.unref();
  return { beat, flush, instance: INSTANCE_ID };
}
