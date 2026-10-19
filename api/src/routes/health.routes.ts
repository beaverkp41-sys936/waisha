import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";
import { pool } from "../db/pool.js";
import { HEALTH_ALIAS, HEALTH_LIVENESS, HEALTH_READINESS } from "../security/audience.js";

/**
 * The health surface.
 *
 * `/api/v1/health` has answered since the first deploy, but the deploy platform asks the
 * root: `GET /health` reached the server, found no route, and the question "is this service
 * up" came back as a 404 — which reads exactly the same as a dead service. These are the
 * routes that path was pointing at.
 *
 * Liveness and readiness are answered apart, because a platform does different things with
 * them. A process whose database is briefly unreachable is not a process that needs
 * restarting, and one that gets restarted turns a network blip into a short outage for every
 * company on it — so `/health` answers 200 for as long as it is serving and says in the body
 * what it could not reach. `/health/ready` is the one that answers 503: it belongs in front
 * of a balancer or an alert, where "send nothing here" is the right reaction to a dead
 * dependency.
 *
 * The probe is bounded and shared. It costs one `select 1`, is allowed 1.5 seconds to be
 * answered, and the answer is reused for 3 seconds, because a status page polling every
 * second against a pool of ten connections must never become the thing that exhausts the
 * pool it is reporting on. A query that outlives its deadline is not cancelled — the
 * connection stays checked out until the driver settles — but it never makes this answer
 * wait, which is all a health route is for.
 */

/**
 * The deadline has to cover a COLD connection, not a query. pg drops an idle client after ten
 * seconds, so the platform's next poll opens a fresh TLS session to the pooler: measured here
 * at 225 ms warm and 1,775 ms cold, on a first run of the smoke suite that caught this route
 * reporting a healthy database as unreachable and answering 503 under a deadline of 1.5s.
 * Reporting a fault that does not exist is worse than being slow to notice one that does, so
 * the window sits above the worst cold handshake and below the timeout a probe is given.
 */
const PROBE_TIMEOUT_MS = 4000;
const PROBE_TTL_MS = 3000;
const WARN_EVERY_MS = 60_000;

export type Probe = {
  ok: boolean;
  latencyMs: number | null;
  reason: string | null;
  at: number;
};

/**
 * The only failure words this answer is allowed to say. A driver `message` is not one of
 * them: it can carry the pooler's host and port, and anyone who can reach this route can
 * read it. The key is a pg or Node constant, and an unmapped one folds to `unreachable`
 * rather than becoming a way to echo the database at a stranger.
 */
const REASONS: Record<string, string> = {
  PROBE_TIMEOUT: "timed_out",
  ETIMEDOUT: "timed_out",
  ECONNREFUSED: "connection_refused",
  ECONNRESET: "connection_reset",
  ENOTFOUND: "host_not_found",
  EAI_AGAIN: "lookup_failed",
  ENETUNREACH: "network_unreachable",
  EHOSTUNREACH: "host_unreachable",
  "08000": "connection_broken",
  "08001": "unable_to_connect",
  "08004": "rejected_by_server",
  "08006": "connection_failure",
  "57P01": "shutting_down",
  "57P02": "crash_shutdown",
  "57P03": "refused_during_startup",
  "53300": "too_many_connections",
  "53400": "configuration_limit_reached",
  "58P00": "backend_error",
  "28000": "not_authorised",
  "28P01": "not_authorised",
  "3D000": "database_missing"
};

export function reasonFor(code: unknown): string {
  return (typeof code === "string" && REASONS[code]) || "unreachable";
}

/** The one database round trip this surface makes. Never rejects: an unanswered database is
 *  an answer, not an exception to render as a 500 from the route that reports 500s. */
export async function probeDatabase(timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(
      Object.assign(new Error("health probe deadline"), { code: "PROBE_TIMEOUT" })
    ), timeoutMs);
  });
  try {
    await Promise.race([pool.query("select 1"), deadline]);
    return { ok: true, latencyMs: Math.round(performance.now() - started), reason: null, at: Date.now() };
  } catch (e: any) {
    return { ok: false, latencyMs: null, reason: reasonFor(e?.code), at: Date.now() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One probe per TTL window, shared by everyone who asks inside it. `runs` is the number of
 * real probes made, and the answer carries it, so "twenty polls, one trip" is something a
 * suite can read rather than something this comment claims.
 */
export class ProbeCache {
  runs = 0;
  private last: Probe | null = null;
  private inFlight: Promise<Probe> | null = null;

  constructor(
    private readonly source: () => Promise<Probe> = probeDatabase,
    private readonly ttlMs = PROBE_TTL_MS
  ) {}

  check(): Promise<Probe> {
    const now = Date.now();
    if (this.last && now - this.last.at < this.ttlMs) return Promise.resolve(this.last);
    if (!this.inFlight) {
      this.inFlight = (async () => {
        this.runs += 1;
        const p = await this.source();
        this.last = p;
        this.inFlight = null;
        return p;
      })();
    }
    return this.inFlight;
  }
}

export function healthBody(probe: Probe, runs: number) {
  return {
    status: probe.ok ? "ok" : "degraded",
    service: "waisha-api",
    environment: env.NODE_ENV,
    ...(env.RENDER_GIT_COMMIT ? { commit: env.RENDER_GIT_COMMIT.slice(0, 40) } : {}),
    time: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    checks: {
      database: {
        status: probe.ok ? "up" : "down",
        latency_ms: probe.latencyMs,
        age_seconds: Math.max(0, Math.round((Date.now() - probe.at) / 1000)),
        ...(probe.reason ? { reason: probe.reason } : {}),
        pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
        probes: runs
      }
    }
  };
}

export async function healthRoutes(
  app: FastifyInstance,
  opts: { probe?: () => Promise<Probe> } = {}
) {
  const cache = new ProbeCache(opts.probe ?? probeDatabase);
  let lastWarnedAt = 0;

  const answer = async (req: FastifyRequest, reply: FastifyReply, isReadiness: boolean) => {
    const probe = await cache.check();
    if (probe.ok) return healthBody(probe, cache.runs);
    // An outage once a minute in the log rather than once per poll: the body already answers
    // the caller, and this is the record that the process noticed.
    const now = Date.now();
    if (now - lastWarnedAt > WARN_EVERY_MS) {
      lastWarnedAt = now;
      req.log.warn({ reason: probe.reason }, "health: database unreachable");
    }
    if (isReadiness) return reply.code(503).send({ ...healthBody(probe, cache.runs), status: "unavailable" });
    return healthBody(probe, cache.runs);
  };

  app.get(HEALTH_LIVENESS, (req, reply) => answer(req, reply, false));
  app.get(HEALTH_READINESS, (req, reply) => answer(req, reply, true));
  // The prefix the portal client and every smoke suite already knock on, now answering the
  // same real question instead of a hardcoded string.
  app.get(HEALTH_ALIAS, (req, reply) => answer(req, reply, false));
}
