import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { ApiError } from "../util/errors.js";
import { INSTANCE_ID } from "../security/reliability.js";
import { requireControl } from "./control.routes.js";
import { controlCan, requireControlPermission } from "./control-analytics.routes.js";

/**
 * The reliability desk (085).
 *
 * Uptime, latency and bloat are the three halves of reliability that never left a trace,
 * and every number on this screen is cross-tenant and catalog-reading, so all of it comes
 * out of a definer. A bare pool query here would answer with nothing and the desk would
 * read "no slow routes, no gaps, no dead tuples" — the most reassuring empty result the
 * panel could produce.
 *
 * Two honesty rules the payload has to carry, because the store cannot say them:
 *
 *  - a percentile is banded. The table keeps five buckets, not raw durations, so p50 and p95
 *    are interpolated inside their band. The response marks them `approximate: true` rather
 *    than letting a rounded number look like a measurement;
 *  - a series shorter than its window is not a trend. `snapshot_meta` says how many captures
 *    exist and `uptime_report` says where the clock started, so the desk can refuse to draw
 *    a line through a period it never observed instead of implying a flat week.
 *
 * Reading is control.system.view (069); taking a snapshot and pruning history are
 * control.system.manage, both audited — a manual capture is a write, and retention deletes
 * evidence.
 */

const VIEW = "control.system.view";
const MANAGE = "control.system.manage";

/** Exported so the verify script executes the identical string, not a re-typing. */
export const UPTIME_SQL = "select platform_auth.uptime_report($1::int) as r";
export const LATENCY_SQL = "select * from platform_auth.request_latency($1::int, $2::int)";
export const LATENCY_DAILY_SQL = "select * from platform_auth.request_daily($1::int)";
export const LATENCY_OVERALL_SQL = "select platform_auth.request_overall($1::int) as r";
export const BLOAT_SQL = "select * from platform_auth.bloat_trend($1::int, $2::int)";
export const SNAPSHOT_META_SQL = "select platform_auth.snapshot_meta() as r";
export const SNAPSHOT_CAPTURE_SQL = "select platform_auth.capture_pg_stat() as r";
export const METRICS_PRUNE_SQL = "select platform_auth.prune_metrics($1::int) as r";

const DAYS = z.coerce.number().int().min(1).max(90).default(7);
const BLOAT_DAYS = z.coerce.number().int().min(1).max(365).default(30);
const LIMIT = z.coerce.number().int().min(1).max(200).default(40);

/** pg hands bigint and numeric back as strings to keep them exact; the desk wants numbers. */
function nums(row: Record<string, any>, keys: string[]): Record<string, any> {
  for (const k of keys) {
    if (row[k] !== null && row[k] !== undefined) row[k] = Number(row[k]);
  }
  return row;
}

const LATENCY_KEYS = ["requests", "mean_ms", "p50_ms", "p95_ms", "max_ms",
  "server_errors", "error_rate", "over_1s"];
const BLOAT_KEYS = ["snapshots", "live_tuples", "dead_tuples", "dead_pct", "table_bytes",
  "index_bytes", "dead_growth", "table_growth_bytes", "seq_scans", "idx_scans",
  "scan_ratio", "vacuum_stale_hours"];

/**
 * pg returns a `date` as a Date at local midnight, so serialising it straight to JSON
 * shifts the label onto the day before on any machine east of Greenwich — the daily chart
 * would say Tuesday for Wednesday's traffic and no test would fail. The day is read back
 * from the same local fields the driver filled. Exported so the verify script asserts on
 * the helper the payload is built with, not on a copy of it.
 */
export function dayKey(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The lines this stage can now raise on the advisory. Each is a fact about the window with
 * a guard, so a healthy week contributes nothing rather than a green tick.
 */
export async function reliabilityAdvisory(days = 7) {
  const items: Array<Record<string, unknown>> = [];
  const [overall, uptime] = await Promise.all([
    pool.query(LATENCY_OVERALL_SQL, [days]),
    pool.query(UPTIME_SQL, [days])
  ]);
  const o = overall.rows[0]?.r ?? {};
  const u = uptime.rows[0]?.r ?? {};
  const meta = (await pool.query(SNAPSHOT_META_SQL)).rows[0]?.r ?? {};

  const requests = Number(o.requests ?? 0);
  const p95 = o.p95_ms === null || o.p95_ms === undefined ? null : Number(o.p95_ms);

  if (requests === 0) {
    items.push({
      item_id: "latency_no_samples", rank: 14, kind: "improve", priority: "low",
      area: "Reliability",
      title: "Nothing has been timed yet in this window",
      detail: "The timing store began with 085, so the first week after that deploy is the "
        + "first week there is anything to say about a slow route. `/api/v1/health` and a "
        + "few desk visits are enough to start it; a screen that shows no percentiles is "
        + "not a screen that shows a healthy system.",
      metric: 0, unit: "requests timed",
      action: "Use the panel normally for a day, then read Reliability again.",
      evidence: []
    });
  } else if (p95 !== null && p95 >= 1000) {
    items.push({
      item_id: "latency_p95_high", rank: 3,
      priority: p95 >= 3000 ? "high" : "medium", kind: "improve",
      area: "Reliability",
      title: `Nine in twenty requests took ${Math.round(p95)} ms or more`,
      detail: "Percentiles are interpolated from five stored bands, so treat the number as "
        + "a magnitude and the table on the Reliability desk as the answer to which route. "
        + "The pooler is in the path of every query this system makes, so the usual first "
        + "suspect is one statement doing a sequential scan, not the network.",
      metric: Math.round(p95), unit: "ms p95",
      action: "Open Reliability, sort by the slowest routes, and check the top one against "
        + "the bloat list below it.",
      evidence: []
    });
  }

  const errorRate = o.error_rate === null || o.error_rate === undefined
    ? 0 : Number(o.error_rate);
  if (requests >= 100 && errorRate >= 1) {
    items.push({
      item_id: "latency_error_rate", rank: 1,
      priority: errorRate >= 5 ? "high" : "medium", kind: "risk",
      area: "Reliability",
      title: `${errorRate}% of timed requests were answered with a server error`,
      detail: "The 5xx count in the timing store is the same set of responses 082's register "
        + "caught, so the error desk already holds their stacks and request ids. This line "
        + "is here because a percentage is the part the register cannot show: how much of "
        + "the traffic a bug is touching.",
      metric: Math.round(Number(o.server_errors ?? 0)), unit: "server errors",
      action: "Open Errors, triage what is understood, and raise the rest.",
      evidence: []
    });
  }

  const expected = Number(u.expected_minutes ?? 0);
  if (expected === 0 && Number(u.instances ?? 0) === 0) {
    // The state immediately after the deploy that opens the register: there is no
    // percentage, and saying "0%" would be an outage that never happened.
    items.push({
      item_id: "uptime_no_collector", rank: 14, kind: "improve", priority: "low",
      area: "Operations",
      title: "No worker has recorded a boot since the reliability register opened",
      detail: "Uptime is measured from the first boot line, so a register with none has "
        + "no window at all — the desk prints nothing rather than the 0% that an empty "
        + "divide would give. The line appears the moment a process reaches the port with "
        + "this code in it.",
      metric: Number(u.alive_minutes ?? 0), unit: "minutes heard alive",
      action: "Deploy or restart the API, then read Reliability again in an hour.",
      evidence: []
    });
  } else if (expected >= 120 && u.uptime_pct !== null && Number(u.uptime_pct) < 99) {
    items.push({
      item_id: "uptime_gap", rank: 2,
      priority: Number(u.uptime_pct) < 95 ? "high" : "medium", kind: "risk",
      area: "Operations",
      title: `A worker reported itself alive ${u.uptime_pct}% of the last ${u.window_days ?? days} days`,
      detail: "A gap here is a minute in which no process of this deployment sent a "
        + "heartbeat — a restart, a sleeping dyno, or a boot that never reached the port. "
        + "It is not a probe from outside: an outage that kills the app before it can answer "
        + "shows up only if the loop stopped with it.",
      metric: Number(u.longest_gap_minutes ?? 0), unit: "minutes of longest gap",
      action: "Read the gap list on the Reliability desk against the deploy history.",
      evidence: []
    });
  }

  if (!meta.has_history) {
    items.push({
      item_id: "bloat_no_history", rank: 9, kind: "improve", priority: "low",
      area: "Database",
      title: meta.captures === 0
        ? "No pg_stat history has been captured yet"
        : "Bloat trend needs a second capture",
      detail: "Growth is only knowable between two snapshots. The first capture gives today's "
        + "figures; a second one, taken hours later or scheduled from outside, turns them "
        + "into a direction. Until then the desk prints the current dead-tuple count and "
        + "says it has no trend, which is the honest version of a flat line.",
      metric: Number(meta.captures ?? 0), unit: "captures stored",
      action: "Take a snapshot on the Reliability desk, then take another one tomorrow.",
      evidence: []
    });
  }

  return { items, overall: o, uptime: u, snapshot: meta };
}

export async function controlReliabilityRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- the desk ----------
  app.get("/control/system/reliability", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, VIEW);
    await enforceRateLimit(`reliability:uid:${req.control.user_id}`, 60, 60);

    const q = z.object({
      days: DAYS,
      bloat_days: BLOAT_DAYS,
      limit: LIMIT
    }).strict().parse(req.query ?? {});

    const [uptime, routes, daily, overall, bloat, meta] = await Promise.all([
      pool.query(UPTIME_SQL, [q.days]),
      pool.query(LATENCY_SQL, [q.days, q.limit]),
      pool.query(LATENCY_DAILY_SQL, [q.days]),
      pool.query(LATENCY_OVERALL_SQL, [q.days]),
      pool.query(BLOAT_SQL, [q.bloat_days, q.limit]),
      pool.query(SNAPSHOT_META_SQL)
    ]);

    return {
      window_days: q.days,
      bloat_window_days: q.bloat_days,
      collector: {
        instance: INSTANCE_ID,
        // The screen is generated by whichever worker answered it; naming it keeps "whose
        // heartbeat is missing" answerable when two dynos disagree.
        answered_by: INSTANCE_ID
      },
      uptime: uptime.rows[0]?.r ?? {},
      latency: {
        overall: overall.rows[0]?.r ?? {},
        // Banded interpolation, stated rather than hidden.
        approximate: true,
        band_edges_ms: [100, 300, 1000, 3000],
        routes: routes.rows.map(r => nums(r, LATENCY_KEYS)),
        daily: daily.rows.map(r => ({
          ...nums(r, ["requests", "mean_ms", "over_1s", "server_errors", "routes"]),
          day: dayKey(r.day)
        }))
      },
      bloat: {
        meta: meta.rows[0]?.r ?? {},
        relations: bloat.rows.map(r => nums(r, BLOAT_KEYS))
      },
      can_manage: await controlCan(req, MANAGE)
    };
  });

  // ---------- take the janitor's numbers out of pg_stat ----------
  app.post("/control/system/reliability/snapshot", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    // Ten an hour: a snapshot is a catalog read over every table, and a desk that polls it
    // turns a reliability feature into load.
    await enforceRateLimit(`reliability-snapshot:uid:${req.control.user_id}`, 10, 3600);

    const { rows } = await pool.query(SNAPSHOT_CAPTURE_SQL);
    const result = rows[0]?.r ?? {};
    if (result.status !== "ok") {
      throw new ApiError("INTERNAL",
        result.message ?? "The database statistics could not be captured.", 500);
    }

    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      entity: "pg_stat_snapshots", entityId: null, action: "control.reliability.snapshot",
      after: { relations: result.relations, captured_at: result.captured_at }
    }));
    return { relations: Number(result.relations ?? 0), captured_at: result.captured_at };
  });

  // ---------- retention: an operator decision, not a background job ----------
  app.post("/control/system/reliability/retention", { preHandler: [requireControl] }, async (req: any) => {
    await requireControlPermission(req, MANAGE);
    await enforceRateLimit(`reliability-prune:uid:${req.control.user_id}`, 5, 3600);

    const body = z.object({ keepDays: z.number().int().min(7).max(3650) }).strict().parse(req.body);
    const { rows } = await pool.query(METRICS_PRUNE_SQL, [body.keepDays]);
    const result = rows[0]?.r ?? {};
    if (result.status !== "ok") {
      throw new ApiError("CONFLICT", result.message ?? "Retention was refused.", 400);
    }

    await withTenant(req.control.tenant_id, (c) => writeAudit(c, {
      tenantId: req.control.tenant_id, actorUserId: req.control.user_id, ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
      entity: "request_timings", entityId: null, action: "control.reliability.retention",
      after: {
        keep_days: body.keepDays, request_lines: result.request_lines,
        snapshot_lines: result.snapshot_lines, heartbeats: result.heartbeats,
        cutoff: result.cutoff
      }
    }));
    return {
      keep_days: body.keepDays,
      request_lines: Number(result.request_lines ?? 0),
      snapshot_lines: Number(result.snapshot_lines ?? 0),
      heartbeats: Number(result.heartbeats ?? 0),
      cutoff: result.cutoff ? new Date(result.cutoff).toISOString() : null
    };
  });
}
