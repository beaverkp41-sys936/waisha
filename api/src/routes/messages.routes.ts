import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission, checkPermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { deleteObject } from "../storage/supabase.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const postSchema = z.object({
  shipmentId: z.string().uuid().nullable().optional(),
  // Empty body is allowed when the message carries only files.
  body: z.string().trim().max(4000).default("")
});

/**
 * The unread watermark upsert, shared by viewing and posting: both mean the
 * caller has seen everything up to now in that conversation.
 */
const READ_GENERAL = `insert into message_reads (tenant_id, user_id, shipment_id, last_read_at)
  values ($1,$2,null,now())
  on conflict (tenant_id, user_id) where shipment_id is null
  do update set last_read_at = now()`;
const READ_SHIPMENT = `insert into message_reads (tenant_id, user_id, shipment_id, last_read_at)
  values ($1,$2,$3,now())
  on conflict (tenant_id, user_id, shipment_id) where shipment_id is not null
  do update set last_read_at = now()`;

export async function messagesRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Threads: the general channel + every cargo file ----------
  app.get("/messages/threads", { preHandler: [requireAuth, requirePermission("messages.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const general = await c.query(
          `select
             (select jsonb_build_object('body', m.body, 'senderName', u.full_name, 'createdAt', m.created_at)
              from messages m left join users u on u.id = m.created_by
              where m.tenant_id = $1 and m.shipment_id is null and m.deleted_at is null
              order by m.created_at desc limit 1) as last_message,
             (select count(*)::int from messages x
              where x.tenant_id = $1 and x.shipment_id is null and x.deleted_at is null
                and x.created_at > coalesce(
                  (select r.last_read_at from message_reads r
                   where r.tenant_id = $1 and r.user_id = $2 and r.shipment_id is null),
                  'epoch'::timestamptz)) as unread`,
          [req.user.tid, req.user.sub]);

        // One row per cargo file; files with conversation sort by recency,
        // silent files follow, newest first.
        const files = await c.query(
          `select s.id as shipment_id, s.file_number, s.consignee_name, s.status, s.stage,
                  lm.last_message,
                  coalesce(un.cnt, 0)::int as unread
           from cargo_shipments s
           left join lateral (
             select jsonb_build_object('body', m.body, 'senderName', u.full_name, 'createdAt', m.created_at) as last_message,
                    m.created_at as sort_at
             from messages m left join users u on u.id = m.created_by
             where m.tenant_id = s.tenant_id and m.shipment_id = s.id and m.deleted_at is null
             order by m.created_at desc limit 1
           ) lm on true
           left join lateral (
             select count(*)::int as cnt from messages m
             where m.tenant_id = s.tenant_id and m.shipment_id = s.id and m.deleted_at is null
               and m.created_at > coalesce(
                 (select r.last_read_at from message_reads r
                  where r.tenant_id = s.tenant_id and r.user_id = $2 and r.shipment_id = s.id),
                 'epoch'::timestamptz)
           ) un on true
           where s.tenant_id = $1 and s.deleted_at is null
           order by lm.sort_at desc nulls last, s.created_at desc
           limit 200`,
          [req.user.tid, req.user.sub]);

        const g = general.rows[0];
        return {
          threads: [
            { scope: "general", title: "Team channel",
              lastMessage: g.last_message ?? null, unread: g.unread },
            ...files.rows.map((r: any) => ({
              scope: "shipment", shipmentId: r.shipment_id, fileNumber: r.file_number,
              consigneeName: r.consignee_name, status: r.status, stage: r.stage,
              lastMessage: r.last_message ?? null, unread: r.unread
            }))
          ]
        };
      });
    });

  // ---------- One conversation (no shipmentId = general channel) ----------
  app.get("/messages", { preHandler: [requireAuth, requirePermission("messages.view")] },
    async (req: any) => {
      const q = z.object({ shipmentId: z.string().uuid().optional() }).parse(req.query);

      return withTenant(req.user.tid, async (c) => {
        let shipment = null;
        if (q.shipmentId) {
          const s = await c.query(
            `select id, file_number, consignee_name, status, stage from cargo_shipments
             where id = $1 and tenant_id = $2 and deleted_at is null`,
            [q.shipmentId, req.user.tid]);
          if (!s.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
          const r = s.rows[0];
          shipment = { id: r.id, fileNumber: r.file_number, consigneeName: r.consignee_name,
                       status: r.status, stage: r.stage };
        }

        const rows = await c.query(
          `select m.id, m.body, m.created_at, m.created_by, u.full_name as sender_name,
                  (select jsonb_agg(jsonb_build_object('id', d.id, 'fileName', d.file_name,
                     'mimeType', d.mime_type, 'sizeBytes', d.size_bytes) order by d.created_at)
                   from documents d
                   where d.tenant_id = m.tenant_id and d.entity_type = 'message'
                     and d.entity_id = m.id and d.deleted_at is null) as attachments
           from messages m left join users u on u.id = m.created_by
           where m.tenant_id = $1 and m.deleted_at is null
             and (($2::uuid is null and m.shipment_id is null) or m.shipment_id = $2)
           order by m.created_at desc
           limit 300`,
          [req.user.tid, q.shipmentId ?? null]);

        // Opening a conversation clears its unread watermark.
        if (q.shipmentId) {
          await c.query(READ_SHIPMENT, [req.user.tid, req.user.sub, q.shipmentId]);
        } else {
          await c.query(READ_GENERAL, [req.user.tid, req.user.sub]);
        }

        const messages = rows.rows.reverse().map((r: any) => ({
          id: r.id, body: r.body, senderId: r.created_by, senderName: r.sender_name,
          createdAt: r.created_at, attachments: r.attachments ?? []
        }));

        return { scope: q.shipmentId ? "shipment" : "general", shipment, messages };
      });
    });

  // ---------- Post ----------
  app.post("/messages", { preHandler: [requireAuth, requirePermission("messages.send")] },
    async (req: any, reply) => {
      await enforceRateLimit(`message:uid:${req.user.sub}`, 120, 3600);
      const body = postSchema.parse(req.body);
      const id = uuidv7();

      await withTenant(req.user.tid, async (c) => {
        if (body.shipmentId) {
          const own = await c.query(
            "select id from cargo_shipments where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.shipmentId, req.user.tid]);
          if (!own.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
        }

        await c.query(
          `insert into messages (id, tenant_id, shipment_id, body, created_by)
           values ($1,$2,$3,$4,$5)`,
          [id, req.user.tid, body.shipmentId ?? null, body.body, req.user.sub]);

        // Posting is reading — the sender's own message never counts unread.
        if (body.shipmentId) {
          await c.query(READ_SHIPMENT, [req.user.tid, req.user.sub, body.shipmentId]);
        } else {
          await c.query(READ_GENERAL, [req.user.tid, req.user.sub]);
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "messages", entityId: id,
          action: "message.sent",
          after: { shipmentId: body.shipmentId ?? null, chars: body.body.length }
        });
      });

      return reply.status(201).send({ id });
    });

  // ---------- Delete (own messages; messages.delete moderates any) ----------
  app.delete("/messages/:id", { preHandler: [requireAuth, requirePermission("messages.send")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };

      const paths = await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select created_by, shipment_id, deleted_at from messages where id = $1 and tenant_id = $2",
          [id, req.user.tid]);
        if (!prev.rowCount || prev.rows[0].deleted_at) {
          throw new ApiError("NOT_FOUND", "Message not found", 404);
        }
        const isOwn = prev.rows[0].created_by === req.user.sub;
        if (!isOwn && !(await checkPermission(c, req.user.sub, "messages.delete"))) {
          throw new ApiError("FORBIDDEN", "You can only delete your own messages.", 403);
        }

        await c.query(
          "update messages set deleted_at = now() where id = $1 and tenant_id = $2 and deleted_at is null",
          [id, req.user.tid]);

        // Attachments leave with the message.
        const docs = await c.query(
          `update documents set deleted_at = now()
           where tenant_id = $1 and entity_type = 'message' and entity_id = $2 and deleted_at is null
           returning storage_path`,
          [req.user.tid, id]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "messages", entityId: id,
          action: "message.deleted",
          after: { shipmentId: prev.rows[0].shipment_id, attachments: docs.rowCount }
        });
        return docs.rows.map((r: any) => r.storage_path);
      });

      for (const p of paths) await deleteObject(p).catch(() => { /* best effort */ });
      return reply.send({ ok: true });
    });
}
