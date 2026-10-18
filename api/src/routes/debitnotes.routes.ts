import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, searchHash, decryptField } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

const itemSchema = z.object({
  description: z.string().trim().min(2).max(300),
  quantity: z.number().positive().max(1_000_000),
  unit: z.string().trim().max(30).nullable().optional(),
  unitPrice: z.number().nonnegative().max(1_000_000_000)
});

const debitNoteCreateSchema = z.object({
  customerName: z.string().trim().min(2).max(160),
  customerPhone: e164.nullable().optional(),
  customerEmail: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  customerTin: z.string().trim().max(20).nullable().optional(),
  customerAddress: z.string().trim().max(300).nullable().optional(),
  /** Why the money is being debited — the sentence that defends the note. */
  reason: z.string().trim().min(4).max(600),
  reference: z.string().trim().max(120).nullable().optional(),
  relatedInvoiceId: z.string().uuid().nullable().optional(),
  issueDate: dateOnly.optional(),
  currency: z.string().trim().min(3).max(8).optional(),
  vatRate: z.number().min(0).max(100).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  items: z.array(itemSchema).min(1).max(60)
});

/** Money to 2 decimals — every amount passes through here, as on the invoices. */
const money = (n: number) => Math.round(n * 100) / 100;

/**
 * A `date` column arrives from pg as a Date built at local midnight, so the UTC
 * JSON form is the day before whenever the server sits east of Greenwich. The desk
 * needs the plain day the clerk chose, so send it as text and let the browser
 * re-read it at noon — the one shape that cannot shift by a day in either direction.
 */
function dayText(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  const d = new Date(v as Date);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function computeTotals(items: { quantity: number; unitPrice: number }[], vatRate: number) {
  const lines = items.map(it => money(it.quantity * it.unitPrice));
  const subtotal = money(lines.reduce((a, b) => a + b, 0));
  const vatAmount = money((subtotal * vatRate) / 100);
  return { lines, subtotal, vatAmount, total: money(subtotal + vatAmount) };
}

export async function debitNotesRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Register + KPIs ----------
  app.get("/debit-notes", { preHandler: [requireAuth, requirePermission("invoices.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select n.id, n.debit_note_number, n.customer_name, n.customer_tin,
                n.reason, n.reference, n.related_invoice_id, i.invoice_number as against_invoice_number,
                n.issue_date, n.currency, n.subtotal, n.vat_amount, n.total,
                n.status, n.created_at
           from debit_notes n
           left join freight_invoices i on i.id = n.related_invoice_id
          where n.tenant_id = $1 and n.deleted_at is null
          order by n.created_at desc`, [req.user.tid]));

      const k = await withTenant(req.user.tid, (c) => c.query(
        `select
           coalesce(sum(total), 0)::float8 as debited,
           coalesce(sum(case when status = 'issued' then total else 0 end), 0)::float8 as issued_total,
           count(*) filter (where status = 'draft')::int as drafts,
           count(*) filter (where status = 'cancelled')::int as cancelled
         from debit_notes where tenant_id = $1 and deleted_at is null`, [req.user.tid]));

      return { notes: rows.map((r: any) => ({ ...r, issue_date: dayText(r.issue_date) })), kpis: k.rows[0] };
    });

  // ---------- Create (draft; totals computed server-side) ----------
  app.post("/debit-notes", { preHandler: [requireAuth, requirePermission("invoices.create")] },
    async (req: any, reply) => {
      const body = debitNoteCreateSchema.parse(req.body);
      const vatRate = body.vatRate ?? 18;
      const currency = body.currency ?? "TZS";
      const { lines, subtotal, vatAmount, total } = computeTotals(body.items, vatRate);
      const id = uuidv7();

      try {
        await withTenant(req.user.tid, async (c) => {
          if (body.relatedInvoiceId) {
            const inv = await c.query(
              `select id from freight_invoices where id = $1 and tenant_id = $2 and deleted_at is null`,
              [body.relatedInvoiceId, req.user.tid]);
            if (!inv.rowCount) throw new ApiError("NOT_FOUND", "That invoice does not exist.", 404);
          }

          const seq = await c.query(
            `select coalesce(max(nullif(regexp_replace(debit_note_number, '\\D', '', 'g'), '')::bigint), 0) + 1 as next
             from debit_notes where tenant_id = $1 and deleted_at is null`,
            [req.user.tid]);
          const number = `DN-${String(seq.rows[0].next).padStart(4, "0")}`;

          await c.query(
            `insert into debit_notes (id, tenant_id, debit_note_number, customer_name,
               customer_phone_encrypted, customer_phone_search, customer_email,
               customer_tin, customer_address, reason, reference, related_invoice_id,
               issue_date, currency, vat_rate, subtotal, vat_amount, total,
               notes, status, created_by, updated_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               coalesce($13, current_date), $14, $15, $16, $17, $18,
               $19, 'draft', $20, $20)`,
            [id, req.user.tid, number, body.customerName,
             body.customerPhone ? encryptField(body.customerPhone) : null,
             body.customerPhone ? searchHash(body.customerPhone) : null,
             body.customerEmail ?? null, body.customerTin ?? null,
             body.customerAddress ?? null, body.reason, body.reference ?? null,
             body.relatedInvoiceId ?? null, body.issueDate ?? null,
             currency, vatRate, subtotal, vatAmount, total,
             body.notes ?? null, req.user.sub]);

          for (let n = 0; n < body.items.length; n++) {
            await c.query(
              `insert into debit_note_items (id, tenant_id, debit_note_id, seq, description, quantity, unit, unit_price, amount)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [uuidv7(), req.user.tid, id, n + 1, body.items[n].description,
               body.items[n].quantity, body.items[n].unit ?? null,
               body.items[n].unitPrice, lines[n]]);
          }

          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "debit_notes", entityId: id,
            action: "debitnote.created",
            after: { number, customer: body.customerName, reason: body.reason,
                     currency, total, lines: body.items.length }
          });
        });
      } catch (e: any) {
        if (e instanceof ApiError) throw e;
        if (e.code === "23505") {
          throw new ApiError("CONFLICT", "Debit note number collision — try again.", 409);
        }
        if (e.code === "23514" || e.code === "P0001") {
          throw new ApiError("CONFLICT", String(e.message ?? "").replace(/^relation .*? failed: /, ""), 409);
        }
        throw e;
      }
      return reply.status(201).send({ id });
    });

  // ---------- Detail (items + letterhead) ----------
  app.get("/debit-notes/:id", { preHandler: [requireAuth, requirePermission("invoices.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        // A cancellation has to name the person who signed it, the same way a
        // payroll run does — the sheet is a record, so the who/why travels on it.
        const note = await c.query(
          `select n.*, i.invoice_number as against_invoice_number,
                  ui.full_name as issued_by_name, uc.full_name as cancelled_by_name
             from debit_notes n
             left join freight_invoices i on i.id = n.related_invoice_id
             left join users ui on ui.id = n.issued_by
             left join users uc on uc.id = n.cancelled_by
            where n.id = $1 and n.tenant_id = $2 and n.deleted_at is null`,
          [id, req.user.tid]);
        if (!note.rowCount) throw new ApiError("NOT_FOUND", "Debit note not found", 404);

        const [items, letterhead] = await Promise.all([
          c.query(
            `select id, seq, description, quantity, unit, unit_price, amount
             from debit_note_items where debit_note_id = $1 and tenant_id = $2 order by seq`,
            [id, req.user.tid]),
          c.query(
            `select cp.company_name, cp.tin_display, cp.brela_number, cp.vat_number, cp.website,
                    b.postal_address, b.street, b.email as branch_email,
                    (select d.id from documents d
                      where d.tenant_id = $1 and d.entity_type = 'tenant'
                        and d.kind = 'logo' and d.deleted_at is null
                      order by d.created_at desc limit 1) as logo_document_id
             from company_profiles cp
             left join branches b on b.tenant_id = cp.tenant_id and b.kind = 'hq' and b.deleted_at is null
             where cp.tenant_id = $1`,
            [req.user.tid])
        ]);

        const row = note.rows[0];
        const phone = row.customer_phone_encrypted
          ? decryptField(row.customer_phone_encrypted)
          : null;

        return {
          ...row,
          issue_date: dayText(row.issue_date),
          customer_phone: phone,
          customer_phone_encrypted: undefined,
          customer_phone_search: undefined,
          items: items.rows,
          letterhead: letterhead.rows[0] ?? null
        };
      });
    });

  // ---------- Edit (draft only; items replaced whole) ----------
  app.put("/debit-notes/:id", { preHandler: [requireAuth, requirePermission("invoices.edit")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = debitNoteCreateSchema.partial().parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select id, status, vat_rate, customer_name, customer_email, customer_tin,
                  customer_address, customer_phone_encrypted, reason, reference,
                  related_invoice_id, issue_date::text as issue_date, currency, notes
             from debit_notes where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Debit note not found", 404);
        if (prev.rows[0].status !== "draft") {
          throw new ApiError("CONFLICT", "Only draft notes can be edited. Cancel it and raise a fresh one.", 409);
        }
        const row = prev.rows[0];

        const vatRate = body.vatRate ?? Number(row.vat_rate);
        if (body.items) {
          const { lines, subtotal, vatAmount, total } = computeTotals(body.items, vatRate);
          await c.query("delete from debit_note_items where debit_note_id = $1 and tenant_id = $2",
            [id, req.user.tid]);
          for (let n = 0; n < body.items.length; n++) {
            await c.query(
              `insert into debit_note_items (id, tenant_id, debit_note_id, seq, description, quantity, unit, unit_price, amount)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [uuidv7(), req.user.tid, id, n + 1, body.items[n].description,
               body.items[n].quantity, body.items[n].unit ?? null,
               body.items[n].unitPrice, lines[n]]);
          }
          await c.query(
            `update debit_notes set subtotal = $2, vat_amount = $3, total = $4, vat_rate = $5
             where id = $1 and tenant_id = $6`,
            [id, subtotal, vatAmount, total, vatRate, req.user.tid]);
        }

        // Absent key keeps the stored value, resolved from the row read in the
        // same tenant scope, so the statement below is static and the scanner
        // can prove it — the shape the leave PUT was corrected to.
        const name = "customerName" in body ? body.customerName! : row.customer_name;
        const email = "customerEmail" in body ? body.customerEmail ?? null : row.customer_email;
        const tin = "customerTin" in body ? body.customerTin ?? null : row.customer_tin;
        const address = "customerAddress" in body ? body.customerAddress ?? null : row.customer_address;
        const phone = "customerPhone" in body ? body.customerPhone ?? null
          : row.customer_phone_encrypted ? decryptField(row.customer_phone_encrypted) : null;
        const reason = "reason" in body ? body.reason! : row.reason;
        const reference = "reference" in body ? body.reference ?? null : row.reference;
        const relatedInvoice = "relatedInvoiceId" in body ? body.relatedInvoiceId ?? null : row.related_invoice_id;
        const issueDate = "issueDate" in body && body.issueDate ? body.issueDate : row.issue_date;
        const currency = "currency" in body ? body.currency! : row.currency;
        const notes = "notes" in body ? body.notes ?? null : row.notes;
        if (body.relatedInvoiceId) {
          const inv = await c.query(
            `select id from freight_invoices where id = $1 and tenant_id = $2 and deleted_at is null`,
            [body.relatedInvoiceId, req.user.tid]);
          if (!inv.rowCount) throw new ApiError("NOT_FOUND", "That invoice does not exist.", 404);
        }

        await c.query(
          `update debit_notes
              set customer_name = $4, customer_email = $5, customer_tin = $6,
                  customer_address = $7, customer_phone_encrypted = $8,
                  customer_phone_search = $9, reason = $10, reference = $11,
                  related_invoice_id = $12, issue_date = $13, currency = $14,
                  vat_rate = $15, notes = $16, updated_by = $2
            where id = $1 and tenant_id = $3`,
          [id, req.user.sub, req.user.tid, name, email, tin, address,
           phone ? encryptField(phone) : null, phone ? searchHash(phone) : null,
           reason, reference, relatedInvoice, issueDate, currency, vatRate, notes]);

        const saved = await c.query(
          `select id, debit_note_number, status, subtotal, vat_amount, total from debit_notes
           where id = $1 and tenant_id = $2`, [id, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "debit_notes", entityId: id,
          action: "debitnote.updated",
          after: saved.rows[0] ? { total: saved.rows[0].total, status: saved.rows[0].status } : null
        });
        return saved.rows[0];
      });
      return { ok: true };
    });

  // ---------- Issue (draft -> issued; frozen from here) ----------
  app.post("/debit-notes/:id/issue", { preHandler: [requireAuth, requirePermission("invoices.edit")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select status, total, currency, customer_name from debit_notes
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Debit note not found", 404);
        if (prev.rows[0].status !== "draft") {
          throw new ApiError("CONFLICT", "Only a draft can be issued.", 409);
        }
        await c.query(
          `update debit_notes set status = 'issued', issued_by = $2, issued_at = now()
           where id = $1 and tenant_id = $3`,
          [id, req.user.sub, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "debit_notes", entityId: id,
          action: "debitnote.issued",
          after: { customer: prev.rows[0].customer_name, currency: prev.rows[0].currency,
                   total: prev.rows[0].total }
        });
      });
      return { ok: true };
    });

  // ---------- Cancel (draft or issued -> cancelled, with a name on it) ----------
  app.post("/debit-notes/:id/cancel", { preHandler: [requireAuth, requirePermission("invoices.edit")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = z.object({
        reason: z.string().trim().min(4).max(600)
      }).parse(req.body ?? {});
      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select status, debit_note_number from debit_notes
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Debit note not found", 404);
        if (prev.rows[0].status === "cancelled") {
          throw new ApiError("CONFLICT", "That note is already cancelled.", 409);
        }
        await c.query(
          `update debit_notes set status = 'cancelled', cancelled_by = $2,
                  cancelled_at = now(), cancel_reason = $4
           where id = $1 and tenant_id = $3`,
          [id, req.user.sub, req.user.tid, body.reason]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "debit_notes", entityId: id,
          action: "debitnote.cancelled",
          after: { number: prev.rows[0].debit_note_number, reason: body.reason }
        });
      });
      return { ok: true };
    });

  // ---------- Delete (draft only; the gate refuses everything else) ----------
  app.delete("/debit-notes/:id", { preHandler: [requireAuth, requirePermission("invoices.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select status, debit_note_number from debit_notes where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Debit note not found", 404);
        if (prev.rows[0].status !== "draft") {
          throw new ApiError("CONFLICT", "Only a draft can be deleted — an issued or cancelled note is a record.", 409);
        }
        const res = await c.query(
          `delete from debit_notes where id = $1 and tenant_id = $2`,
          [id, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "debit_notes", entityId: id,
            action: "debitnote.deleted",
            after: { number: prev.rows[0].debit_note_number, status: prev.rows[0].status }
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Debit note not found", 404);
      return reply.send({ ok: true });
    });
}
