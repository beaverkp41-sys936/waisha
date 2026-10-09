import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import {
  storageConfigured,
  putObject,
  getObject,
  deleteObject,
  signObject,
  StorageUnavailableError
} from "../storage/supabase.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const ENTITY_KINDS = ["tenant", "user", "vessel", "driver", "trip", "shipment"] as const;
const DOC_KINDS = ["logo", "avatar", "licence", "insurance", "inspection", "road_licence", "delivery_note", "invoice", "bill_of_lading", "packing_list", "other"] as const;
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
const DOC_MIMES = [...IMAGE_MIMES, "application/pdf"];
const MAX_BYTES = 8 * 1024 * 1024; // 8MB per file

// Entities that must exist and belong to the tenant before a file attaches.
const ENTITY_TABLES: Record<string, string> = {
  user: "users", vessel: "vessels", driver: "drivers", trip: "trips", shipment: "cargo_shipments"
};

function sanitizeFileName(name: string): string {
  const base = (name || "file").split(/[\\/]/).pop() ?? "file";
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return clean || "file";
}

export async function documentsRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Upload ----------
  app.post("/documents", { preHandler: [requireAuth, requirePermission("documents.create")] }, async (req: any, reply) => {
    if (!storageConfigured()) {
      throw new ApiError("STORAGE_UNAVAILABLE",
        "Uploads are not configured yet — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", 503);
    }
    await enforceRateLimit(`upload:uid:${req.user.sub}`, 30, 3600);

    const data = await req.file();
    if (!data) throw new ApiError("VALIDATION_FAILED", "Attach a file to upload.", 400, [{ field: "file" }]);

    const fields = data.fields as Record<string, any>;
    const body = z.object({
      entityType: z.enum(ENTITY_KINDS),
      entityId: z.string().uuid().optional(),
      kind: z.enum(DOC_KINDS)
    }).parse({
      entityType: fields.entityType?.value,
      entityId: fields.entityId?.value || undefined,
      kind: fields.kind?.value
    });

    const bytes = await data.toBuffer();
    if (bytes.length === 0) throw new ApiError("VALIDATION_FAILED", "The file is empty.", 400);
    if (bytes.length > MAX_BYTES) {
      throw new ApiError("VALIDATION_FAILED", "Files are limited to 8 MB.", 400, [{ field: "file" }]);
    }
    const mime = (data.mimetype || "").toLowerCase();
    if (!DOC_MIMES.includes(mime)) {
      throw new ApiError("VALIDATION_FAILED", "Only JPEG, PNG, WebP or PDF files are accepted.", 400, [{ field: "file" }]);
    }
    if ((body.kind === "logo" || body.kind === "avatar") && !IMAGE_MIMES.includes(mime)) {
      throw new ApiError("VALIDATION_FAILED", "Logos and avatars must be JPEG, PNG or WebP images.", 400, [{ field: "file" }]);
    }

    // Tenant files attach to the caller's own tenant; everything else must
    // exist inside the tenant (deleted rows included in the guard below).
    const entityId = body.entityType === "tenant" ? req.user.tid : body.entityId;
    if (!entityId) throw new ApiError("VALIDATION_FAILED", "entityId is required.", 400, [{ field: "entityId" }]);
    if (body.entityType === "tenant" && entityId !== req.user.tid) {
      throw new ApiError("FORBIDDEN", "You can only attach files to your own organisation.", 403);
    }

    const id = uuidv7();
    const fileName = sanitizeFileName(data.filename);
    const storagePath = `${req.user.tid}/${body.entityType}/${entityId}/${id}-${fileName}`;

    try {
      await putObject(storagePath, bytes, mime);
    } catch (e) {
      if (e instanceof StorageUnavailableError) throw e;
      req.log.error(e, "storage upload failed");
      throw new ApiError("INTERNAL", "The file could not be stored. Try again.", 502);
    }

    await withTenant(req.user.tid, async (c) => {
      if (body.entityType !== "tenant") {
        const own = await c.query(
          `select id from ${ENTITY_TABLES[body.entityType]} where id = $1 and tenant_id = $2 and deleted_at is null`,
          [entityId, req.user.tid]);
        if (!own.rowCount) throw new ApiError("NOT_FOUND", "This record does not exist.", 404);
      }

      // A tenant carries one logo, a member one avatar — replace the old one.
      if (body.kind === "logo" || body.kind === "avatar") {
        await c.query(
          `update documents set deleted_at = now()
           where tenant_id = $1 and entity_type = $2 and entity_id = $3 and kind = $4 and deleted_at is null`,
          [req.user.tid, body.entityType, entityId, body.kind]);
      }

      await c.query(
        `insert into documents (id, tenant_id, entity_type, entity_id, kind,
           file_name, mime_type, size_bytes, storage_path, uploaded_by, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10)`,
        [id, req.user.tid, body.entityType, entityId, body.kind,
         fileName, mime, bytes.length, storagePath, req.user.sub]);
      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "documents", entityId: id,
        action: "document.uploaded",
        after: { entityType: body.entityType, entityId, kind: body.kind, fileName, sizeBytes: bytes.length }
      });
    });

    return reply.status(201).send({ id, fileName, mimeType: mime, sizeBytes: bytes.length });
  });

  // ---------- Vault: every document across entities, with labels ----------
  app.get("/documents/vault", { preHandler: [requireAuth] }, async (req: any) => {
    const q = z.object({
      entityType: z.enum(ENTITY_KINDS).optional(),
      kind: z.enum(DOC_KINDS).optional()
    }).parse(req.query);

    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select d.id, d.entity_type, d.entity_id, d.kind, d.file_name, d.mime_type,
              d.size_bytes, d.created_at,
              case d.entity_type
                when 'tenant' then (select name from tenants t where t.id = d.entity_id)
                when 'user' then (select full_name from users u where u.id = d.entity_id)
                when 'vessel' then (select name from vessels v where v.id = d.entity_id)
                when 'driver' then (select full_name from drivers dr where dr.id = d.entity_id)
                when 'trip' then (select coalesce(reference, 'Trip') from trips tr where tr.id = d.entity_id)
                when 'shipment' then (select file_number from cargo_shipments cs where cs.id = d.entity_id)
              end as entity_label
       from documents d
       where d.tenant_id = $1 and d.deleted_at is null
         and ($2::text is null or d.entity_type = $2)
         and ($3::text is null or d.kind = $3)
       order by d.created_at desc
       limit 300`,
      [req.user.tid, q.entityType ?? null, q.kind ?? null]));
    return rows;
  });

  // ---------- List for an entity ----------
  app.get("/documents", { preHandler: [requireAuth] }, async (req: any) => {
    const q = z.object({
      entityType: z.enum(ENTITY_KINDS),
      entityId: z.string().uuid().optional(),
      kind: z.enum(DOC_KINDS).optional()
    }).parse(req.query);

    const entityId = q.entityType === "tenant" ? req.user.tid : q.entityId;
    if (!entityId) throw new ApiError("VALIDATION_FAILED", "entityId is required.", 400);

    const { rows } = await withTenant(req.user.tid, (c) => c.query(
      `select id, entity_type, entity_id, kind, file_name, mime_type, size_bytes, created_at
       from documents
       where tenant_id = $1 and entity_type = $2 and entity_id = $3 and deleted_at is null
         and ($4::text is null or kind = $4)
       order by created_at desc`,
      [req.user.tid, q.entityType, entityId, q.kind ?? null]));
    return rows;
  });

  // ---------- Tenant logo (convenience for the letterhead) ----------
  app.get("/documents/tenant-logo/url", { preHandler: [requireAuth] }, async (req: any) => {
    const row = await withTenant(req.user.tid, (c) => c.query(
      `select id, storage_path from documents
       where tenant_id = $1 and entity_type = 'tenant' and entity_id = $1
         and kind = 'logo' and deleted_at is null
       order by created_at desc limit 1`,
      [req.user.tid]));
    if (!row.rowCount) throw new ApiError("NOT_FOUND", "No logo uploaded yet.", 404);
    try {
      return { id: row.rows[0].id, url: await signObject(row.rows[0].storage_path, 3600) };
    } catch (e) {
      req.log.error(e, "storage sign failed (tenant logo)");
      throw new ApiError("INTERNAL", "Could not open the file.", 502);
    }
  });

  // ---------- Signed URL (for <img> tags; Bearer headers don't work there) ----------
  app.get("/documents/:id/url", { preHandler: [requireAuth] }, async (req: any) => {
    const { id } = req.params as { id: string };
    const row = await withTenant(req.user.tid, (c) => c.query(
      `select storage_path from documents where id = $1 and tenant_id = $2 and deleted_at is null`,
      [id, req.user.tid]));
    if (!row.rowCount) throw new ApiError("NOT_FOUND", "Document not found", 404);
    try {
      return { url: await signObject(row.rows[0].storage_path, 3600) };
    } catch (e) {
      req.log.error(e, "storage sign failed");
      throw new ApiError("INTERNAL", "Could not open the file.", 502);
    }
  });

  // ---------- Content stream (direct download through the API) ----------
  app.get("/documents/:id/content", { preHandler: [requireAuth] }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const row = await withTenant(req.user.tid, (c) => c.query(
      `select file_name, mime_type, storage_path from documents where id = $1 and tenant_id = $2 and deleted_at is null`,
      [id, req.user.tid]));
    if (!row.rowCount) throw new ApiError("NOT_FOUND", "Document not found", 404);
    try {
      const { bytes, contentType } = await getObject(row.rows[0].storage_path);
      return reply.header("Content-Type", contentType ?? row.rows[0].mime_type)
        .header("Content-Disposition", `inline; filename="${sanitizeFileName(row.rows[0].file_name)}"`)
        .send(bytes);
    } catch (e) {
      req.log.error(e, "storage download failed");
      throw new ApiError("INTERNAL", "Could not read the file.", 502);
    }
  });

  // ---------- Remove ----------
  app.delete("/documents/:id", { preHandler: [requireAuth, requirePermission("documents.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select storage_path from documents where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Document not found", 404);
        const res = await c.query(
          `update documents set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "documents", entityId: id,
            action: "document.deleted"
          });
        }
        return prev.rows[0].storage_path;
      });
      await deleteObject(r).catch(() => { /* best effort */ });
      return reply.send({ ok: true });
    });
}
