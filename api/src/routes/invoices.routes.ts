import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
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
  unitPrice: z.number().nonnegative().max(1_000_000_000)
});

const invoiceCreateSchema = z.object({
  customerName: z.string().trim().min(2).max(160),
  customerPhone: e164.nullable().optional(),
  customerEmail: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  customerTin: z.string().trim().max(20).nullable().optional(),
  customerAddress: z.string().trim().max(300).nullable().optional(),
  issueDate: dateOnly.optional(),
  dueDate: dateOnly.nullable().optional(),
  paymentTerms: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  vatRate: z.number().min(0).max(100).optional(),
  relatedTripId: z.string().uuid().nullable().optional(),
  items: z.array(itemSchema).min(1).max(50)
});

const statusSchema = z.object({
  status: z.enum(["sent", "cancelled"])
});

const paymentSchema = z.object({
  amount: z.number().positive().max(1_000_000_000),
  method: z.enum(["cash", "bank", "mobile_money", "cheque", "other"]).default("cash"),
  reference: z.string().trim().max(60).nullable().optional(),
  paidAt: dateOnly.optional(),
  notes: z.string().trim().max(300).nullable().optional()
});

/** Money to 2 decimals — every amount passes through here. */
const money = (n: number) => Math.round(n * 100) / 100;

/** Derived status: money and dates decide paid/partial/overdue. */
const EFFECTIVE_STATUS_SQL = `case
  when i.status = 'cancelled' then 'cancelled'
  when i.status = 'draft' then 'draft'
  when i.amount_paid >= i.total and i.total > 0 then 'paid'
  when i.amount_paid > 0 then 'partial'
  when i.due_date is not null and i.due_date < current_date then 'overdue'
  else 'sent'
end`;

function computeTotals(items: { quantity: number; unitPrice: number }[], vatRate: number) {
  const lines = items.map(it => money(it.quantity * it.unitPrice));
  const subtotal = money(lines.reduce((a, b) => a + b, 0));
  const vatAmount = money((subtotal * vatRate) / 100);
  return { lines, subtotal, vatAmount, total: money(subtotal + vatAmount) };
}

export async function invoicesRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Register + KPIs ----------
  app.get("/invoices", { preHandler: [requireAuth, requirePermission("invoices.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select i.id, i.invoice_number, i.customer_name, i.customer_email, i.customer_tin,
                i.issue_date, i.due_date, i.currency, i.vat_rate, i.subtotal,
                i.vat_amount, i.total, i.amount_paid, i.status, i.notes, i.created_at,
                ${EFFECTIVE_STATUS_SQL} as effective_status
         from freight_invoices i
         where i.tenant_id = $1 and i.deleted_at is null
         order by i.created_at desc`, [req.user.tid]));

      const k = await withTenant(req.user.tid, (c) => c.query(
        `select
           coalesce(sum(total), 0)::float8 as invoiced,
           coalesce(sum(amount_paid), 0)::float8 as received,
           coalesce(sum(case when status <> 'cancelled' then total - amount_paid else 0 end), 0)::float8 as outstanding,
           count(*) filter (where status <> 'cancelled'
             and amount_paid < total
             and due_date is not null and due_date < current_date)::int as overdue
         from freight_invoices where tenant_id = $1 and deleted_at is null`, [req.user.tid]));

      return { invoices: rows, kpis: k.rows[0] };
    });

  // ---------- Create (with items; totals computed server-side) ----------
  app.post("/invoices", { preHandler: [requireAuth, requirePermission("invoices.create")] },
    async (req: any, reply) => {
      const body = invoiceCreateSchema.parse(req.body);
      const vatRate = body.vatRate ?? 18;
      const { lines, subtotal, vatAmount, total } = computeTotals(body.items, vatRate);
      const id = uuidv7();

      try {
        await withTenant(req.user.tid, async (c) => {
          const seq = await c.query(
            `select coalesce(max(nullif(regexp_replace(invoice_number, '\\D', '', 'g'), '')::bigint), 0) + 1 as next
             from freight_invoices where tenant_id = $1 and deleted_at is null`,
            [req.user.tid]);
          const invoiceNumber = `INV-${String(seq.rows[0].next).padStart(4, "0")}`;

          await c.query(
            `insert into freight_invoices (id, tenant_id, invoice_number, customer_name,
               customer_phone_encrypted, customer_phone_search, customer_email,
               customer_tin, customer_address, issue_date, due_date, payment_terms,
               vat_rate, subtotal, vat_amount, total, related_trip_id, notes,
               status, created_by, updated_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               coalesce($10, current_date), $11, $12, $13, $14, $15, $16, $17, $18,
               'draft', $19, $19)`,
            [id, req.user.tid, invoiceNumber, body.customerName,
             body.customerPhone ? encryptField(body.customerPhone) : null,
             body.customerPhone ? searchHash(body.customerPhone) : null,
             body.customerEmail ?? null, body.customerTin ?? null,
             body.customerAddress ?? null, body.issueDate ?? null,
             body.dueDate ?? null, body.paymentTerms ?? null,
             vatRate, subtotal, vatAmount, total,
             body.relatedTripId ?? null, body.notes ?? null, req.user.sub]);

          for (let n = 0; n < body.items.length; n++) {
            await c.query(
              `insert into freight_invoice_items (id, tenant_id, invoice_id, seq, description, quantity, unit_price, amount)
               values ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [uuidv7(), req.user.tid, id, n + 1, body.items[n].description,
               body.items[n].quantity, body.items[n].unitPrice, lines[n]]);
          }

          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "freight_invoices", entityId: id,
            action: "invoice.created",
            after: { invoiceNumber, customer: body.customerName, total }
          });

          return invoiceNumber;
        });
      } catch (e: any) {
        if (e.code === "23505") {
          throw new ApiError("CONFLICT", "Invoice number collision — try again.", 409);
        }
        throw e;
      }
      return reply.status(201).send({ id });
    });

  // ---------- Detail (invoice + items + payments + letterhead) ----------
  app.get("/invoices/:id", { preHandler: [requireAuth, requirePermission("invoices.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const inv = await c.query(
          `select i.*, ${EFFECTIVE_STATUS_SQL} as effective_status
           from freight_invoices i
           where i.id = $1 and i.tenant_id = $2 and i.deleted_at is null`,
          [id, req.user.tid]);
        if (!inv.rowCount) throw new ApiError("NOT_FOUND", "Invoice not found", 404);

        const [items, payments, letterhead] = await Promise.all([
          c.query(
            `select id, seq, description, quantity, unit_price, amount
             from freight_invoice_items where invoice_id = $1 and tenant_id = $2 order by seq`,
            [id, req.user.tid]),
          c.query(
            `select id, amount, method, reference, paid_at, notes, created_at
             from freight_invoice_payments where invoice_id = $1 and tenant_id = $2 order by paid_at, created_at`,
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

        const row = inv.rows[0];
        const phone = row.customer_phone_encrypted
          ? decryptField(row.customer_phone_encrypted)
          : null;

        return {
          ...row,
          customer_phone: phone,
          customer_phone_encrypted: undefined,
          customer_phone_search: undefined,
          items: items.rows,
          payments: payments.rows,
          letterhead: letterhead.rows[0] ?? null
        };
      });
    });

  // ---------- Edit (draft only; items replaced whole) ----------
  app.put("/invoices/:id", { preHandler: [requireAuth, requirePermission("invoices.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = invoiceCreateSchema.partial().parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select status, amount_paid, vat_rate from freight_invoices where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Invoice not found", 404);
        if (prev.rows[0].status !== "draft") {
          throw new ApiError("CONFLICT", "Only draft invoices can be edited. Cancel it and issue a new one.", 409);
        }

        const vatRate = body.vatRate ?? Number(prev.rows[0].vat_rate);
        let totals: ReturnType<typeof computeTotals> | null = null;
        if (body.items) {
          totals = computeTotals(body.items, vatRate);
          await c.query("delete from freight_invoice_items where invoice_id = $1 and tenant_id = $2",
            [id, req.user.tid]);
          for (let n = 0; n < body.items.length; n++) {
            await c.query(
              `insert into freight_invoice_items (id, tenant_id, invoice_id, seq, description, quantity, unit_price, amount)
               values ($1,$2,$3,$4,$5,$6,$7,$8)`,
              [uuidv7(), req.user.tid, id, n + 1, body.items[n].description,
               body.items[n].quantity, body.items[n].unitPrice, totals.lines[n]]);
          }
        }

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid]; // $1 id, $2 updated_by, $3 tenant_id
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("customerName" in body) set("customer_name", body.customerName!);
        if ("customerEmail" in body) set("customer_email", body.customerEmail ?? null);
        if ("customerTin" in body) set("customer_tin", body.customerTin ?? null);
        if ("customerAddress" in body) set("customer_address", body.customerAddress ?? null);
        if ("issueDate" in body && body.issueDate) set("issue_date", body.issueDate);
        if ("dueDate" in body) set("due_date", body.dueDate ?? null);
        if ("paymentTerms" in body) set("payment_terms", body.paymentTerms ?? null);
        if ("notes" in body) set("notes", body.notes ?? null);
        if ("vatRate" in body || body.items) set("vat_rate", vatRate);
        if (totals) {
          set("subtotal", totals.subtotal);
          set("vat_amount", totals.vatAmount);
          set("total", totals.total);
        }

        if (sets.length) {
          await c.query(
            `update freight_invoices set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
             where id = $1 and tenant_id = $3 and deleted_at is null`,
            params);
        }

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "freight_invoices", entityId: id,
          action: "invoice.updated",
          after: { customer: body.customerName ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Status (issue / cancel) ----------
  app.put("/invoices/:id/status", { preHandler: [requireAuth, requirePermission("invoices.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = statusSchema.parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select status, amount_paid, invoice_number from freight_invoices where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Invoice not found", 404);
        const from = prev.rows[0].status;
        if (from === body.status) return; // caller sees { ok: true }

        if (from === "cancelled" || from === "paid") {
          throw new ApiError("CONFLICT", "A cancelled invoice cannot change status.", 409);
        }
        if (body.status === "cancelled" && Number(prev.rows[0].amount_paid) > 0) {
          throw new ApiError("CONFLICT", "An invoice with recorded payments cannot be cancelled.", 409);
        }

        await c.query(
          `update freight_invoices set status = $2, updated_by = $3, updated_at = now()
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, body.status, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "freight_invoices", entityId: id,
          action: "invoice.status_changed",
          before: { status: from }, after: { status: body.status }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Record payment ----------
  app.post("/invoices/:id/payments", { preHandler: [requireAuth, requirePermission("invoices.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = paymentSchema.parse(req.body);

      const pid = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select status, total, amount_paid, invoice_number from freight_invoices where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Invoice not found", 404);
        if (prev.rows[0].status === "cancelled") {
          throw new ApiError("CONFLICT", "Payments cannot be recorded on a cancelled invoice.", 409);
        }
        const already = Number(prev.rows[0].amount_paid);
        const balance = money(Number(prev.rows[0].total) - already);
        if (money(already + body.amount) > money(Number(prev.rows[0].total)) + 0.001) {
          throw new ApiError("CONFLICT",
            `This payment exceeds the outstanding balance of ${balance.toLocaleString()} TZS.`, 409);
        }

        await c.query(
          `insert into freight_invoice_payments (id, tenant_id, invoice_id, amount, method, reference, paid_at, notes, recorded_by)
           values ($1,$2,$3,$4,$5,$6, coalesce($7, current_date), $8, $9)`,
          [pid, req.user.tid, id, body.amount, body.method,
           body.reference ?? null, body.paidAt ?? null, body.notes ?? null, req.user.sub]);
        await c.query(
          `update freight_invoices set amount_paid = amount_paid + $2, updated_by = $3, updated_at = now()
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, body.amount, req.user.sub]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "freight_invoice_payments", entityId: pid,
          action: "payment.recorded",
          after: { invoiceId: id, amount: body.amount, method: body.method,
                   reference: body.reference ?? null, balanceAfter: money(balance - body.amount) }
        });
      });
      return reply.status(201).send({ id: pid });
    });

  // ---------- Delete (drafts and unpaid invoices only) ----------
  app.delete("/invoices/:id", { preHandler: [requireAuth, requirePermission("invoices.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select status, amount_paid from freight_invoices where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Invoice not found", 404);
        if (Number(prev.rows[0].amount_paid) > 0) {
          throw new ApiError("CONFLICT", "An invoice with recorded payments cannot be deleted.", 409);
        }
        const res = await c.query(
          `update freight_invoices set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "freight_invoices", entityId: id,
            action: "invoice.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Invoice not found", 404);
      return reply.send({ ok: true });
    });
}
