import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { sniffFileType } from "../util/upload.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { SHIPMENT_VISIBLE_SQL, INVOICE_VISIBLE_SQL } from "../util/shipper-visibility.js";
import {
  storageConfigured, putObject, signObject, StorageUnavailableError
} from "../storage/supabase.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];
const DOC_MIMES = [...IMAGE_MIMES, "application/pdf"];
const MAX_BYTES = 8 * 1024 * 1024; // 8MB per file

const EFFECTIVE_STATUS_SQL = `case
  when i.status = 'cancelled' then 'cancelled'
  when i.status = 'draft' then 'draft'
  when i.amount_paid >= i.total and i.total > 0 then 'paid'
  when i.amount_paid > 0 then 'partial'
  when i.due_date is not null and i.due_date < current_date then 'overdue'
  else 'sent'
end`;

function sanitizeFileName(name: string): string {
  const base = (name || "file").split(/[\\/]/).pop() ?? "file";
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return clean || "file";
}

/** The caller's active portal account, or a 403 that explains itself. */
async function requireAccount(c: any, tid: string, uid: string) {
  const acc = await c.query(
    `select sa.id, sa.client_id, c.name as client_name, u.full_name
     from shipper_accounts sa
     join clients c on c.id = sa.client_id and c.deleted_at is null
     join users u on u.id = sa.user_id
     where sa.tenant_id = $1 and sa.user_id = $2
       and sa.status = 'active' and sa.deleted_at is null`,
    [tid, uid]);
  if (!acc.rowCount) {
    throw new ApiError("FORBIDDEN",
      "No transporter has granted you portal access yet. Please contact your agent.", 403);
  }
  return acc.rows[0];
}

export async function portalRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Overview ----------
  app.get("/portal/overview", { preHandler: [requireAuth, requirePermission("portal.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const account = await requireAccount(c, req.user.tid, req.user.sub);

        const counts = await c.query(
          `select count(*)::int as total,
                  count(*) filter (where cs.status = 'open')::int as open,
                  count(*) filter (where cs.status = 'on_hold')::int as on_hold,
                  count(*) filter (where cs.stage = 'customs')::int as in_customs,
                  count(*) filter (where cs.eta is not null and cs.eta between current_date and current_date + 7)::int as arriving_soon,
                  count(*) filter (where cs.status = 'completed')::int as completed
           from cargo_shipments cs
           where cs.tenant_id = $1 and cs.deleted_at is null and ${SHIPMENT_VISIBLE_SQL}`,
          [req.user.tid, req.user.sub]);

        const outstanding = await c.query(
          `select count(*)::int as count,
                  coalesce(sum(i.total - i.amount_paid), 0)::float8 as amount
           from freight_invoices i
           where i.tenant_id = $1 and i.deleted_at is null and i.status <> 'cancelled'
             and i.amount_paid < i.total and ${INVOICE_VISIBLE_SQL}`,
          [req.user.tid, req.user.sub]);

        const recentFiles = await c.query(
          `select cs.id, cs.file_number, cs.shipment_type, cs.stage, cs.status,
                  cs.eta::text as eta, (cs.eta - current_date)::int as eta_days,
                  cs.payment_status, cs.updated_at
           from cargo_shipments cs
           where cs.tenant_id = $1 and cs.deleted_at is null and ${SHIPMENT_VISIBLE_SQL}
           order by cs.updated_at desc
           limit 5`, [req.user.tid, req.user.sub]);

        const recentDocuments = await c.query(
          `select d.id, d.kind, d.file_name, d.size_bytes, d.created_at, cs.file_number
           from documents d
           join cargo_shipments cs on cs.id = d.entity_id
           where d.tenant_id = $1 and d.entity_type = 'shipment' and d.deleted_at is null
             and ${SHIPMENT_VISIBLE_SQL}
           order by d.created_at desc
           limit 5`, [req.user.tid, req.user.sub]);

        return {
          client: { id: account.client_id, name: account.client_name, fullName: account.full_name },
          counts: counts.rows[0],
          outstanding: outstanding.rows[0],
          recentFiles: recentFiles.rows,
          recentDocuments: recentDocuments.rows
        };
      });
    });

  // ---------- Files ----------
  app.get("/portal/files", { preHandler: [requireAuth, requirePermission("portal.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select cs.id, cs.file_number, cs.shipment_type, cs.stage, cs.status,
                cs.eta::text as eta, (cs.eta - current_date)::int as eta_days,
                cs.shipping_line, cs.bill_number, cs.container_type, cs.container_count,
                cs.consignee_name, cs.consignor_name,
                cs.payment_amount::float8 as payment_amount, cs.payment_status,
                cs.updated_at
         from cargo_shipments cs
         where cs.tenant_id = $1 and cs.deleted_at is null and ${SHIPMENT_VISIBLE_SQL}
         order by case cs.status when 'open' then 0 when 'on_hold' then 1 else 2 end,
                  cs.eta asc nulls last, cs.updated_at desc
         limit 200`, [req.user.tid, req.user.sub]));
      return rows;
    });

  app.get("/portal/files/:id", { preHandler: [requireAuth, requirePermission("portal.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        await requireAccount(c, req.user.tid, req.user.sub);
        // Client-facing column list: internal fields (processing cost, notes,
        // customs workpoint notes) deliberately stay out of the portal.
        const file = await c.query(
          `select cs.id, cs.file_number, cs.shipment_type, cs.stage, cs.status,
                  cs.hs_code, cs.cargo_description,
                  cs.container_type, cs.container_count, cs.container_numbers,
                  cs.cbm::float8 as cbm, cs.weight_tonnes::float8 as weight_tonnes,
                  cs.consignee_name, cs.consignor_name, cs.shipping_line, cs.bill_number,
                  cs.order_date::text as order_date,
                  cs.document_receipt_date::text as document_receipt_date,
                  cs.eta::text as eta, cs.discharge_date::text as discharge_date,
                  cs.carry_in_date::text as carry_in_date,
                  cs.terms_delivery, cs.tansad_number, cs.rcn_number, cs.reference_number,
                  cs.payment_amount::float8 as payment_amount, cs.payment_status,
                  cs.completed_at, cs.created_at, cs.updated_at
           from cargo_shipments cs
           where cs.id = $3 and cs.tenant_id = $1 and cs.deleted_at is null
             and ${SHIPMENT_VISIBLE_SQL}`,
          [req.user.tid, req.user.sub, id]);
        if (!file.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);

        const docs = await c.query(
          `select id, kind, file_name, mime_type, size_bytes, created_at
           from documents
           where tenant_id = $1 and entity_type = 'shipment' and entity_id = $2
             and deleted_at is null
           order by created_at desc`, [req.user.tid, id]);

        return { file: file.rows[0], documents: docs.rows };
      });
    });

  // ---------- Invoices ----------
  app.get("/portal/invoices", { preHandler: [requireAuth, requirePermission("portal.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        await requireAccount(c, req.user.tid, req.user.sub);
        const rows = await c.query(
          `select i.id, i.invoice_number, i.issue_date::text as issue_date,
                  i.due_date::text as due_date, i.currency, i.vat_rate,
                  i.subtotal::float8 as subtotal, i.vat_amount::float8 as vat_amount,
                  i.total::float8 as total, i.amount_paid::float8 as amount_paid,
                  ${EFFECTIVE_STATUS_SQL} as effective_status, i.created_at
           from freight_invoices i
           where i.tenant_id = $1 and i.deleted_at is null and ${INVOICE_VISIBLE_SQL}
           order by i.created_at desc
           limit 200`, [req.user.tid, req.user.sub]);
        return rows.rows;
      });
    });

  app.get("/portal/invoices/:id", { preHandler: [requireAuth, requirePermission("portal.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        await requireAccount(c, req.user.tid, req.user.sub);
        const inv = await c.query(
          `select i.id, i.invoice_number, i.issue_date::text as issue_date,
                  i.due_date::text as due_date, i.currency, i.vat_rate,
                  i.subtotal::float8 as subtotal, i.vat_amount::float8 as vat_amount,
                  i.total::float8 as total, i.amount_paid::float8 as amount_paid,
                  i.payment_terms, i.payment_instructions, i.notes,
                  ${EFFECTIVE_STATUS_SQL} as effective_status, i.created_at
           from freight_invoices i
           where i.id = $3 and i.tenant_id = $1 and i.deleted_at is null and ${INVOICE_VISIBLE_SQL}`,
          [req.user.tid, req.user.sub, id]);
        if (!inv.rowCount) throw new ApiError("NOT_FOUND", "Invoice not found", 404);

        const items = await c.query(
          `select seq, description, quantity, unit, unit_price::float8 as unit_price, amount::float8 as amount
           from freight_invoice_items where invoice_id = $1 order by seq`, [id]);
        const payments = await c.query(
          `select amount::float8 as amount, method, reference, paid_at::text as paid_at
           from freight_invoice_payments where invoice_id = $1 order by paid_at desc`, [id]);

        return { invoice: inv.rows[0], items: items.rows, payments: payments.rows };
      });
    });

  // ---------- Documents ----------
  app.get("/portal/documents", { preHandler: [requireAuth, requirePermission("portal.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select d.id, d.kind, d.file_name, d.mime_type, d.size_bytes, d.created_at,
                cs.file_number, d.uploaded_by
         from documents d
         join cargo_shipments cs on cs.id = d.entity_id
         where d.tenant_id = $1 and d.entity_type = 'shipment' and d.deleted_at is null
           and ${SHIPMENT_VISIBLE_SQL}
         order by d.created_at desc
         limit 200`, [req.user.tid, req.user.sub]));
      return rows;
    });

  app.post("/portal/documents", { preHandler: [requireAuth, requirePermission("portal.upload")] },
    async (req: any, reply) => {
      if (!storageConfigured()) {
        throw new ApiError("STORAGE_UNAVAILABLE",
          "Uploads are not configured yet — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", 503);
      }
      await enforceRateLimit(`upload:uid:${req.user.sub}`, 30, 3600);

      const data = await req.file();
      if (!data) throw new ApiError("VALIDATION_FAILED", "Attach a file to upload.", 400, [{ field: "file" }]);
      const fields = data.fields as Record<string, any>;
      const { shipmentId } = z.object({ shipmentId: z.string().uuid() })
        .parse({ shipmentId: fields.shipmentId?.value });

      const bytes = await data.toBuffer();
      if (bytes.length === 0) throw new ApiError("VALIDATION_FAILED", "The file is empty.", 400);
      if (bytes.length > MAX_BYTES) {
        throw new ApiError("VALIDATION_FAILED", "Files are limited to 8 MB.", 400, [{ field: "file" }]);
      }
      const mime = (data.mimetype || "").toLowerCase();
      if (!DOC_MIMES.includes(mime)) {
        throw new ApiError("VALIDATION_FAILED", "Only JPEG, PNG, WebP or PDF files are accepted.", 400, [{ field: "file" }]);
      }
      const sniffed = sniffFileType(bytes);
      if (!sniffed || sniffed !== mime) {
        throw new ApiError("VALIDATION_FAILED", "The file content does not match its declared type.", 400, [{ field: "file" }]);
      }

      const id = uuidv7();
      const fileName = sanitizeFileName(data.filename);
      const storagePath = `${req.user.tid}/shipment/${shipmentId}/${id}-${fileName}`;

      try {
        await putObject(storagePath, bytes, mime);
      } catch (e) {
        if (e instanceof StorageUnavailableError) throw e;
        req.log.error(e, "storage upload failed");
        throw new ApiError("INTERNAL", "The file could not be stored. Try again.", 502);
      }

      await withTenant(req.user.tid, async (c) => {
        await requireAccount(c, req.user.tid, req.user.sub);
        const own = await c.query(
          `select cs.id from cargo_shipments cs
           where cs.id = $3 and cs.tenant_id = $1 and cs.deleted_at is null
             and ${SHIPMENT_VISIBLE_SQL}`,
          [req.user.tid, req.user.sub, shipmentId]);
        if (!own.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);

        await c.query(
          `insert into documents (id, tenant_id, entity_type, entity_id, kind,
             file_name, mime_type, size_bytes, storage_path, uploaded_by, created_by, updated_by)
           values ($1,$2,'shipment',$3,'shipper_upload',$4,$5,$6,$7,$8,$8,$8)`,
          [id, req.user.tid, shipmentId, fileName, mime, bytes.length, storagePath, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "documents", entityId: id,
          action: "portal.document.uploaded",
          after: { shipmentId, fileName, sizeBytes: bytes.length }
        });
      });

      return reply.status(201).send({ id, fileName, mimeType: mime, sizeBytes: bytes.length });
    });

  // ---------- Signed URL (only for documents on visible files) ----------
  app.get("/portal/documents/:id/url", { preHandler: [requireAuth, requirePermission("portal.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const row = await c.query(
          `select d.id, d.storage_path, d.entity_id
           from documents d
           where d.id = $2 and d.tenant_id = $1 and d.deleted_at is null
             and d.entity_type = 'shipment'`,
          [req.user.tid, id]);
        if (!row.rowCount) throw new ApiError("NOT_FOUND", "Document not found", 404);

        const visible = await c.query(
          `select cs.id from cargo_shipments cs
           where cs.id = $3 and cs.tenant_id = $1 and cs.deleted_at is null
             and ${SHIPMENT_VISIBLE_SQL}`,
          [req.user.tid, req.user.sub, row.rows[0].entity_id]);
        if (!visible.rowCount) throw new ApiError("NOT_FOUND", "Document not found", 404);

        try {
          return { url: await signObject(row.rows[0].storage_path, 3600) };
        } catch (e) {
          req.log.error(e, "storage sign failed (portal)");
          throw new ApiError("INTERNAL", "Could not open the file.", 502);
        }
      });
    });
}
