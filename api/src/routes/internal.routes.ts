import type { FastifyInstance, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { ApiError } from "../util/errors.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { runBookingTimers } from "../util/booking-timer.js";
import { runTenantPolicy } from "../util/tenant-policy.js";
import { runExpiryReminders } from "../util/expiry-reminders.js";

/**
 * Internal scheduler surface — never called by a browser.
 *
 * The booking timers (6h reminder, 12h auto-release) run on an in-process
 * interval in main.ts; this endpoint exists so an external cron can also
 * drive them on hosts that sleep. It is authenticated with a shared secret
 * (INTERNAL_TICK_SECRET) that lives only in the server environment — a
 * browser never sees it, and there is no user token involved. With the
 * secret unset the route refuses entirely rather than running unguarded.
 *
 * The comparison is in one place because it is the only thing standing between
 * an anonymous POST and a scheduled write, and a hand-rolled `===` on a secret
 * is a timing oracle that nobody notices until someone exploits it.
 */
async function assertInternalTick(req: FastifyRequest) {
  if (!env.INTERNAL_TICK_SECRET) {
    throw new ApiError("FORBIDDEN", "The internal tick is not configured.", 403);
  }
  await enforceRateLimit(`internal-tick:${req.ip}`, 30, 60);

  const given = req.headers["x-internal-secret"];
  const expected = env.INTERNAL_TICK_SECRET;
  const ok = typeof given === "string" && given.length === expected.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) throw new ApiError("FORBIDDEN", "Not allowed.", 403);
}

export async function internalRoutes(app: FastifyInstance, _opts: unknown) {
  app.post("/internal/booking-timers/tick", async (req) => {
    await assertInternalTick(req);
    return runBookingTimers();
  });

  // The idle clock: 45 days without a paid licence blocks a company, 90 closes it.
  // Same function the in-process interval calls, so a cron on a sleeping host cannot
  // apply a different rule than the app does.
  app.post("/internal/tenant-policy/tick", async (req) => {
    await assertInternalTick(req);
    return runTenantPolicy();
  });

  // The paper clock: a vehicle's insurance, a driver's licence or a company's own transport licence
  // inside 30, 14 or 7 days of running out. Same function the in-process interval calls, so a cron
  // on a sleeping host cannot warn on a different ladder than the app does.
  app.post("/internal/expiry-reminders/tick", async (req) => {
    await assertInternalTick(req);
    return runExpiryReminders();
  });
}
