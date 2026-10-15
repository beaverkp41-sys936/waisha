import type { BoardCard } from "./board.js";

/**
 * In-process fan-out for the notice board.
 *
 * The payload of a published event is a BoardCard — the same allowlisted shape
 * the REST board returns — so a live update cannot carry anything a poller
 * could not already see. A withdrawn event carries only the id.
 *
 * Deliberately bounded: one browser tab holds one socket open for as long as it
 * is open, so an unbounded registry is a slow-memory leak and an easy
 * denial of service. Caps are per tenant and global; the route answers 503 when
 * its tenant is full and the client retries with backoff.
 *
 * Single-instance note: events travel in process memory, so on more than one
 * API replica a subscriber only sees publishes handled by its own replica. The
 * board is still correct (every connect or reconnect re-reads the database) —
 * only the instant update degrades. Moving this to Postgres LISTEN/NOTIFY or a
 * managed push channel is the upgrade path if replicas are ever added.
 */
export type BoardEvent =
  | { type: "ready"; open: number; newest: string | null; at: string }
  | { type: "request.published"; card: BoardCard; at: string }
  | { type: "request.withdrawn"; id: string; at: string }
  | { type: "heartbeat"; at: string };

type Sink = (e: BoardEvent) => void;

const MAX_TOTAL = 120;
const MAX_PER_TENANT = 8;

const channels = new Map<string, { tid: string; send: Sink }>();
let seq = 0;

/** Attach a subscriber. Returns null when the caps are reached. */
export function openBoardChannel(tid: string, send: Sink): (() => void) | null {
  if (channels.size >= MAX_TOTAL) return null;
  let mine = 0;
  for (const c of channels.values()) if (c.tid === tid) mine++;
  if (mine >= MAX_PER_TENANT) return null;

  const key = `${tid}:${++seq}`;
  channels.set(key, { tid, send });
  return () => { channels.delete(key); };
}

export function emitBoard(event: BoardEvent) {
  for (const [key, c] of channels) {
    try {
      c.send(event);
    } catch {
      // A dead socket must not abort the publish that produced this event.
      channels.delete(key);
    }
  }
}

/** Test/diagnostic only: how many sockets are open, globally and for one tenant. */
export function boardChannelCount(tid?: string) {
  if (!tid) return channels.size;
  let n = 0;
  for (const c of channels.values()) if (c.tid === tid) n++;
  return n;
}
