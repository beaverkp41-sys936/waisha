import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { VEHICLE_TYPES } from "../util/transport.js";
import { boardSummary, getBoardCard, listBoard } from "../util/board.js";
import { emitBoard, openBoardChannel, type BoardEvent } from "../util/board-bus.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const actorRole = (req: any): string | null => req.user?.roles?.[0] ?? null;

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

/** The book body is closed: a contact name and a channel, nothing else. */
const bookSchema = z.object({
  contactName: z.string().trim().min(2).max(120),
  contactChannel: z.string().trim().min(5).max(160)
}).strict();

/**
 * Onboarding readiness (spec, Part 2: "onboarding with company profile and
 * verification (licence, contact)"). Required to book: a company name and a
 * transport licence that is on file and not expired. The profile extras are
 * recommended — they shape the card the publisher reviews, but they do not
 * block. This same list feeds GET /board/readiness and the 409 on booking.
 */
async function companyReadiness(c: any, tenantId: string) {
  const p = (await c.query(
    `select company_name, description, services_offered, corridors_served,
            transport_licence_no, transport_licence_expiry
       from company_profiles where tenant_id = $1`, [tenantId])).rows[0] ?? null;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const hasName = !!p?.company_name?.trim();
  const licNo = !!p?.transport_licence_no?.trim();
  const licExp: number | null = p?.transport_licence_expiry
    ? new Date(p.transport_licence_expiry).getTime() : null;
  const licValid = licExp !== null && licExp >= startOfToday.getTime();
  const items = [
    {
      key: "company_name", label: "Company name on the profile",
      done: hasName, required: true,
      detail: hasName ? "On file."
        : "Transporters see this name on the load they are holding for you.",
      href: "/app/profile"
    },
    {
      key: "licence_no", label: "Transport licence number",
      done: licNo, required: true,
      detail: licNo ? "On file."
        : "Publishers check the licence of the company holding their load.",
      href: "/app/profile"
    },
    {
      key: "licence_expiry", label: "Licence not expired",
      done: licValid, required: true,
      detail: licValid
        ? `Valid until ${new Date(licExp!).toLocaleDateString()}.`
        : p?.transport_licence_expiry
          ? `Expired ${new Date(licExp!).toLocaleDateString()} — renew, then update the profile.`
          : "Add the licence expiry date from the licence itself.",
      href: "/app/profile"
    },
    {
      key: "description", label: "About your company",
      done: !!p?.description?.trim(), required: false,
      detail: p?.description?.trim() ? "On file."
        : "A short line about who you are, shown to publishers you book with.",
      href: "/app/profile"
    },
    {
      key: "services", label: "Services offered",
      done: !!p?.services_offered?.trim(), required: false,
      detail: p?.services_offered?.trim() ? "On file."
        : "Tell publishers what you haul — haulage, clearing, and so on.",
      href: "/app/profile"
    },
    {
      key: "corridors", label: "Corridors served",
      done: !!p?.corridors_served?.trim(), required: false,
      detail: p?.corridors_served?.trim() ? "On file."
        : "The routes you run — Dar to Arusha, and so on.",
      href: "/app/profile"
    }
  ];
  return { ready: items.every((i) => !i.required || i.done), items };
}

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

  // ---------- Can this company book? The onboarding checklist ----------
  app.get("/board/readiness", { preHandler: [requireAuth, requirePermission("board.view")] },
    async (req: any) => withTenant(req.user.tid, (c) => companyReadiness(c, req.user.tid)));

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

  // ---------- Book: the load leaves the board and a timer starts ----------
  // The transition itself is transport_book_request (migration 048): a guarded
  // UPDATE that makes two simultaneous books resolve to exactly one winner.
  app.post("/board/:id/book",
    { preHandler: [requireAuth, requirePermission("board.book")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = bookSchema.parse(req.body);
      const out = await withTenant(req.user.tid, async (c) => {
        // Onboarding gate: booking is what a licence is for. Same checklist
        // as GET /board/readiness, refused with the missing pieces named.
        const readiness = await companyReadiness(c, req.user.tid);
        if (!readiness.ready) {
          throw new ApiError("CONFLICT",
            "Your company is not ready to book loads yet — finish these profile items first.",
            409,
            readiness.items.filter((i) => i.required && !i.done)
              .map((i) => ({ field: i.key, message: i.label })));
        }
        const r = (await c.query(
          `select transport_book_request($1,$2,$3,$4,$5) as r`,
          [id, req.user.tid, req.user.sub, body.contactName, body.contactChannel])).rows[0].r;
        if (r.ok) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, actorRole: actorRole(req),
            ip: req.ip, requestId: req.requestId,
            entity: "transport_bookings", entityId: r.bookingId,
            action: "board.booked",
            after: { requestId: id, status: "temp_booked", company: r.company }
          });
        }
        return r;
      });

      if (!out.ok) {
        if (out.reason === "missing") {
          throw new ApiError("NOT_FOUND", "That load is no longer on the board.", 404);
        }
        if (out.reason === "own_request") {
          throw new ApiError("CONFLICT", "This is your own load — you cannot book it.", 409);
        }
        if (out.reason === "contact") {
          throw new ApiError("VALIDATION", "A contact name and a way to reach you are required.", 400);
        }
        if (out.reason === "not_allowed") {
          throw new ApiError("FORBIDDEN", "Your role does not allow this action.", 403);
        }
        // not_open: either somebody won the race, or the load was withdrawn
        // between the card render and this click. Both read as a lost race.
        if (out.status === "temp_booked" || out.status === "confirmed") {
          throw new ApiError("CONFLICT",
            "Another company booked this load moments before you. " +
            "It is held while the publishing company confirms.", 409);
        }
        throw new ApiError("CONFLICT", "That load is no longer on the board.", 409);
      }

      // Every other watcher loses the card at once. Id only — the board never
      // learns who booked, or why it vanished.
      emitBoard({ type: "request.withdrawn", id, at: new Date().toISOString() });
      // `at` lets the client start the 12h hold countdown without a round trip;
      // /my-bookings stays the authoritative source for the exact stamp.
      return reply.code(201).send({
        ok: true, bookingId: out.bookingId, company: out.company,
        at: new Date().toISOString()
      });
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
