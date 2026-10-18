import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isProd } from "../env.js";
import { verifyAccessToken } from "../security/jwt.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { recordError } from "../security/error-record.js";

/**
 * The browser's side of the error register (082).
 *
 * "All errors must be collected" has two halves. The API can only see the failures that
 * reach it, so a component that throws during render, an unhandled promise, or a fetch
 * that never completed are invisible until somebody reports them from the page they
 * broke. This is the door they come through.
 *
 * It is deliberately the weakest-trusted route in the API and the least able to do harm:
 *  - no authentication, because the page that crashes is often the sign-in page;
 *  - no tenant, no actor, ever. A caller names a failure that happened to it; it does not
 *    get to say whose error history to write into. Attribution here is the IP and the
 *    user-agent the server observed, and nothing else the client asserts;
 *  - the payload is schema-bound and size-capped, the collector scrubs contact-shaped text
 *    before it hashes or stores, and the route cannot read or change anything but its own
 *    insert.
 *
 * The response is 202 with a count and never an error detail: an intake that answers 500
 * when a client reports a 500 is a loop waiting to happen, so a refused item is dropped
 * quietly and the caller is told nothing went wrong.
 */

const SOURCES = ["boundary", "window", "rejection", "fetch"] as const;

const itemSchema = z.object({
  message: z.string().min(1).max(500),
  // The JS error name (TypeError, ChunkLoadError) or our own code for a failed fetch.
  code: z.string().max(60).optional(),
  source: z.enum(SOURCES).optional(),
  // The page the user was on, not the API path — normalisePath still collapses any ids.
  path: z.string().max(300).optional(),
  status: z.number().int().min(100).max(599).optional(),
  detail: z.string().max(4000).optional(),
  // The x-request-id of the failed call, when there was one. This is the join back to the
  // server row for the same event, and the caller already has it.
  requestId: z.string().max(64).optional()
}).strict();

const intakeSchema = z.object({
  // A batch, because a page that fails on load fails five times at once and the client
  // deduplicates per session before sending.
  errors: z.array(itemSchema).min(1).max(5)
}).strict();

export async function errorIntakeRoutes(app: FastifyInstance, _opts: unknown) {

  app.post("/client-errors", async (req: any, reply) => {
    // Tighter than the global 600/min IP cap: this door is open to the internet and a
    // script that posts here has no reason to be answered at all.
    await enforceRateLimit(`clienterr:ip:${req.ip}`, 30, 60);

    const parsed = intakeSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(202).send({ recorded: 0 });

    const items = parsed.data.errors.filter(
      (item) => (item.message ?? "").trim().replace(/[\u0000-\u001f\s]/g, "").length > 0);
    if (!items.length) return reply.status(202).send({ recorded: 0 });

    await Promise.all(items.map((item) => recordError({
      kind: "client",
      message: item.message,
      code: item.code ?? item.source ?? null,
      status: item.status ?? null,
      method: "CLIENT",
      path: item.path ?? null,
      route: item.source ? `client:${item.source}` : null,
      detail: item.detail ?? null,
      requestId: item.requestId ?? null,
      ip: req.ip,
      userAgent: req.headers["user-agent"] ?? null
    })));

    return reply.status(202).send({ recorded: items.length });
  });

  /**
   * A route that fails on purpose, so the collector can be proved over HTTP instead of by
   * reading it: the smoke asks for a 500, follows the `x-request-id` the caller was handed,
   * and reads the line back out of the register. Nothing else in the API fails in a way a
   * test can rely on — and a test that conjures its own 500 by calling the collector does not
   * prove the error handler is the one that caught it.
   *
   * It is registered only when NODE_ENV is not production (the same rule mail.ts applies to
   * the real sender), so on Render this path answers 404 and there is nothing to attack. It
   * writes exactly one row and reads nothing. A bearer token is honoured if it verifies, which
   * is what puts a company and a seat on the line; without one the line is anonymous, as every
   * browser-reported failure is.
   */
  if (!isProd) {
    app.post("/dev/error-probe", async (req: any) => {
      const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      if (auth) req.user = await verifyAccessToken(auth) ?? undefined;
      const q = (req.query ?? {}) as { kind?: string; stamp?: string };
      const stamp = String(q.stamp ?? "dev").slice(0, 20);
      const kind = String(q.kind ?? "plain").slice(0, 12);

      const err: any = new Error(
        `probe failure ${kind} for ada@alpha.co.tz on +255712345678 seat ${req.user?.sub ?? "anon"}`);
      err.code = `PROBE_${stamp}`;
      if (kind === "pg") {
        // The shape a real engine error carries: a code pg passes through, and a stack whose
        // frames are the thing a reader needs and a caller must never see.
        err.stack = `error: relation "no_such_table" does not exist\n`
          + `    at Connection.parseE (node_modules/pg/lib/connection.js:604:11)\n`
          + `    at Object.<anonymous> (src/routes/dev.ts:12:9)`;
      }
      req.log.warn({ probe: kind }, "deliberate probe failure");
      throw err;
    });
  }
}
