import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { runBookingTimers } from "../util/booking-timer.js";

/**
 * Internal scheduler surface — never called by a browser.
 *
 * The booking timers (6h reminder, 12h auto-release) run on an in-process
 * interval in main.ts; this endpoint exists so an external cron can also
 * drive them on hosts that sleep. It is authenticated with a shared secret
 * (INTERNAL_TICK_SECRET) that lives only in the server environment — a
 * browser never sees it, and there is no user token involved. With the
 * secret unset the route refuses entirely rather than running unguarded.
 */
export async function internalRoutes(app: FastifyInstance, _opts: unknown) {
  app.post("/internal/booking-timers/tick", async (req) => {
    if (!env.INTERNAL_TICK_SECRET) {
      throw new ApiError("FORBIDDEN", "The internal tick is not configured.", 403);
    }
    await enforceRateLimit(`internal-tick:${req.ip}`, 30, 60);

    const given = req.headers["x-internal-secret"];
    const expected = env.INTERNAL_TICK_SECRET;
    const ok = typeof given === "string" && given.length === expected.length &&
      timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    if (!ok) throw new ApiError("FORBIDDEN", "Not allowed.", 403);

    return runBookingTimers();
  });
}
