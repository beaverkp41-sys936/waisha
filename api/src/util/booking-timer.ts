import { pool } from "../db/pool.js";
import { getBoardCard } from "./board.js";
import { emitBoard } from "./board-bus.js";

/**
 * The 6h reminder and the 12h auto-release, server-side and authoritative.
 *
 * The state itself lives in the database: the two functions below stamp the
 * transitions under their own predicates (`reminder_sent_at is null`,
 * `status = 'temp_booked'`) and take row locks, so running the tick twice —
 * or from two API replicas at once — cannot double-fire. This module only
 * triggers that work: an in-process interval on boot, plus the
 * POST /internal/booking-timers/tick endpoint for an external cron.
 *
 * Releasing a hold puts the load back on the notice board, so each released
 * request is re-read through the same allowlisted door a poller uses and
 * pushed to watchers. That push is process-local (same caveat as board-bus):
 * clients that miss it recover on their next re-read, because the database
 * is the truth, not the event.
 */
export async function runBookingTimers(): Promise<{ reminded: number; released: number }> {
  const rem = await pool.query(`select transport_booking_reminders() as n`);
  const rel = await pool.query(`select transport_booking_releases() as ids`);
  const ids: string[] = rel.rows[0]?.ids ?? [];

  const at = new Date().toISOString();
  for (const id of ids) {
    const card = await getBoardCard(id);
    if (card) emitBoard({ type: "request.published", card, at });
  }

  return { reminded: Number(rem.rows[0]?.n ?? 0), released: ids.length };
}

const TICK_MS = 60_000;

/** Start the in-process tick. unref'd so it never holds the process open. */
export function startBookingTimerLoop(
  log: { info: (o: unknown, msg?: string) => void; warn: (o: unknown, msg?: string) => void }
): void {
  const tick = async () => {
    try {
      const out = await runBookingTimers();
      if (out.reminded || out.released) log.info(out, "booking timers fired");
    } catch (e) {
      // A failed tick changes nothing (the functions are atomic); the next
      // tick retries, so this is a warning, not a crash.
      log.warn({ err: String(e) }, "booking timer tick failed");
    }
  };
  const t = setInterval(tick, TICK_MS);
  t.unref();
  void tick();
}
