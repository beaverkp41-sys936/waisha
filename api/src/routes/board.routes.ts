import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError } from "../util/errors.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { VEHICLE_TYPES } from "../util/transport.js";
import { boardSummary, getBoardCard, listBoard } from "../util/board.js";
import { openBoardChannel, type BoardEvent } from "../util/board-bus.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Closed query shape: an unknown filter is a rejection, not a silent ignore. */
const boardQuery = z.object({
  vehicle: z.enum(VEHICLE_TYPES).optional(),
  regionId: z.coerce.number().int().positive().max(100000).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  search: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10000).optional()
}).strict().refine(
  (f) => !f.from || !f.to || f.from <= f.to,
  { message: "The date range is reversed.", path: ["from"] }
);

const HEARTBEAT_MS = 25_000;

/** One SSE frame. The event name is the type, so clients can addEventListener. */
function frame(e: BoardEvent) {
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

export async function boardRoutes(app: FastifyInstance, _opts: unknown) {
  // ---------- The board: every open request, from every company ----------
  app.get("/board", { preHandler: [requireAuth, requirePermission("board.view")] },
    async (req: any) => {
      const q = boardQuery.parse(req.query);
      const { rows, total } = await listBoard(q);
      return { rows, total, limit: q.limit ?? 40, offset: q.offset ?? 0 };
    });

  app.get("/board/count", { preHandler: [requireAuth, requirePermission("board.view")] },
    async () => boardSummary());

  // ---------- One card, open requests only ----------
  app.get("/board/:id", { preHandler: [requireAuth, requirePermission("board.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const card = await getBoardCard(id);
      if (!card) {
        // A booked or withdrawn request is not a private row: it is simply gone
        // from the board, so this is 404 and says nothing about why.
        throw new ApiError("NOT_FOUND", "That load is no longer on the board.", 404);
      }
      return card;
    });

  // ---------- Realtime: new loads appear without a refresh ----------
  // Consumed with fetch + ReadableStream (not EventSource) so the access token
  // stays in a header and never lands in a URL, a proxy log or history.
  app.get("/board/stream", { preHandler: [requireAuth, requirePermission("board.view")] },
    async (req: any, reply) => {
      // Reconnects are the cost here, so the stream gets its own tighter bucket
      // on top of the global per-ip cap.
      await enforceRateLimit(`board-stream:${req.ip}`, 20, 60);

      let res: import("node:http").ServerResponse | null = null;
      const send = (e: BoardEvent) => { if (res) res.write(frame(e)); };
      const release = openBoardChannel(req.user.tid as string, send);
      if (!release) {
        throw new ApiError("UNAVAILABLE",
          "The live board is at capacity. It will retry in a few seconds.", 503);
      }

      reply.hijack();
      res = reply.raw;
      // hijack() leaves the Fastify reply pipeline, so the CORS headers the
      // cors plugin already decided on must be written onto the raw socket.
      const sseHeaders: Record<string, string> = {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      };
      for (const [k, v] of Object.entries(reply.getHeaders())) {
        if (/^access-control-/i.test(k) && v !== undefined) sseHeaders[k] = String(v);
      }
      res.writeHead(200, sseHeaders);
      res.write("retry: 5000\n\n");

      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(beat);
        release();
      };
      const beat = setInterval(() => {
        if (res!.writableEnded || res!.destroyed) return cleanup();
        try {
          // A comment frame keeps proxies and browsers from calling it idle.
          res!.write(`: ping ${Date.now()}\n\n`);
        } catch {
          cleanup();
        }
      }, HEARTBEAT_MS);
      beat.unref();

      req.raw.on("close", cleanup);
      res.on("error", cleanup);

      try {
        const s = await boardSummary();
        send({ type: "ready", open: s.open, newest: s.newest, at: new Date().toISOString() });
      } catch {
        cleanup();
        res.end();
      }
    });
}
