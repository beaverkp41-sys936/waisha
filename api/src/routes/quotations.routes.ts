import type { FastifyInstance } from "fastify";
import { z } from "zod";
import QRCode from "qrcode";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { encryptField, searchHash, decryptField } from "../util/crypto.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { enforceRateLimit } from "../security/ratelimit.js";
import { writeAudit } from "../audit/audit.js";
import { getObject, storageConfigured } from "../storage/supabase.js";
import { extractTextLines } from "../billing/pdf.js";
import { parseReference } from "../billing/reference.js";
import type { ReferenceExtraction } from "../billing/reference.js";
import { reconcile } from "../billing/reconcile.js";
import type { CatalogRow } from "../billing/reconcile.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);
const SECTIONS = ["statutory", "port", "transport"] as const;
const BASES = ["cif", "fob", "duty_paid_value", "per_unit", "per_container", "per_day", "flat"] as const;
const TAXES = ["vat", "excise", "none"] as const;

/** Money to 2 decimals — every amount passes through here. */
const money = (n: number) => Math.round(n * 100) / 100;

const itemSchema = z.object({
  section: z.enum(SECTIONS),
  catalogCode: z.string().trim().max(40).nullable().optional(),
  description: z.string().trim().min(2).max(300),
  basis: z.enum(BASES).default("flat"),
  quantity: z.number().positive().max(1_000_000).default(1),
  unit: z.string().trim().max(30).nullable().optional(),
  unitPrice: z.number().nonnegative().max(1_000_000_000),
  taxKind: z.enum(TAXES).default("none"),
  taxRate: z.number().min(0).max(100).default(0),
  sourceDocumentId: z.string().uuid().nullable().optional(),
  verified: z.boolean().default(false),
  notes: z.string().trim().max(300).nullable().optional()
});

const quotationSchema = z.object({
  kind: z.enum(["quotation", "proforma"]).default("proforma"),
  customerName: z.string().trim().min(2).max(160),
  customerPhone: e164.nullable().optional(),
  customerEmail: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  customerTin: z.string().trim().max(20).nullable().optional(),
  customerAddress: z.string().trim().max(300).nullable().optional(),
  shipmentId: z.string().uuid().nullable().optional(),
  vesselName: z.string().trim().max(120).nullable().optional(),
  voyage: z.string().trim().max(60).nullable().optional(),
  blNumber: z.string().trim().max(60).nullable().optional(),
  tradeType: z.string().trim().max(40).nullable().optional(),
  issueDate: dateOnly.optional(),
  validUntil: dateOnly.nullable().optional(),
  currency: z.string().trim().min(3).max(8).default("TZS"),
  exchangeRate: z.number().positive().max(1_000_000).nullable().optional(),
  vatRate: z.number().min(0).max(100).default(18),
  paymentInstructions: z.string().trim().max(600).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  items: z.array(itemSchema).min(1).max(120)
});

const statusSchema = z.object({
  status: z.enum(["issued", "accepted", "declined", "cancelled", "draft"])
});

const referenceSchema = z.object({
  role: z.enum(["primary", "secondary"]),
  documentId: z.string().uuid()
});

type ComputedItem = z.infer<typeof itemSchema> & {
  amount: number; taxAmount: number; total: number;
};

/**
 * Totals are always recomputed here — the sheet the clerk edits is free-form,
 * the numbers that get stored are not. Section blocks carry their line totals
 * (charge plus that line's tax) so the three printed blocks add up to the
 * document total without a hidden adjustment.
 */
function computeQuotation(items: z.infer<typeof itemSchema>[]) {
  const lines: ComputedItem[] = items.map((it) => {
    const amount = money(Number(it.quantity) * it.unitPrice);
    const taxAmount = it.taxKind === "none" ? 0 : money((amount * it.taxRate) / 100);
    return { ...it, amount, taxAmount, total: money(amount + taxAmount) };
  });
  const sectionTotal = (s: (typeof SECTIONS)[number]) =>
    money(lines.filter((l) => l.section === s).reduce((a, l) => a + l.total, 0));
  const subtotal = money(lines.reduce((a, l) => a + l.amount, 0));
  const vatAmount = money(lines.filter((l) => l.taxKind === "vat")
    .reduce((a, l) => a + l.taxAmount, 0));
  const total = money(lines.reduce((a, l) => a + l.total, 0));
  return {
    lines, subtotal, vatAmount, total,
    statutoryTotal: sectionTotal("statutory"),
    portTotal: sectionTotal("port"),
    transportTotal: sectionTotal("transport")
  };
}

const QUOTATION_SELECT = `
  select q.id, q.quotation_number, q.kind, q.status, q.customer_name, q.customer_email,
         q.customer_tin, q.customer_address, q.shipment_id, q.vessel_name, q.voyage,
         q.bl_number, q.trade_type, q.currency, q.exchange_rate, q.vat_rate,
         q.issue_date::text as issue_date, q.valid_until::text as valid_until,
         q.statutory_total, q.port_total, q.transport_total, q.subtotal, q.vat_amount,
         q.total, q.payment_instructions, q.notes, q.converted_invoice_id,
         q.created_at, q.updated_at
  from quotations q`;

/** The detail read, written out once so no query call interpolates at runtime. */
const QUOTATION_DETAIL_SQL = `${QUOTATION_SELECT}
  where q.id = $1 and q.tenant_id = $2 and q.deleted_at is null`;

/** Catalog codes the tenant has re-rated win over the platform defaults. */
const CATALOG_SQL = `
  select distinct on (c.code) c.id, c.code, c.label, c.section, c.basis, c.default_rate,
         c.rate_type, c.eac_exempt, c.sort, c.notes, c.tenant_id is not null as is_tenant_own
  from charge_catalog c
  where c.deleted_at is null and c.is_active
    and (c.tenant_id is null or c.tenant_id = $1)
  order by c.code, c.tenant_id nulls last`;

const SECTION_RANK: Record<string, number> = { statutory: 0, port: 1, transport: 2 };

async function loadCatalog(c: any, tid: string): Promise<CatalogRow[]> {
  const { rows } = await c.query(CATALOG_SQL, [tid]);
  return rows.map((r: any) => ({
    code: r.code, label: r.label, section: r.section, basis: r.basis,
    default_rate: r.default_rate === null ? null : Number(r.default_rate),
    rate_type: r.rate_type, eac_exempt: r.eac_exempt, sort: r.sort
  }));
}

/**
 * A line's provenance has to point at a reference file actually attached to
 * this document — otherwise the sheet claims a source it cannot show.
 */
async function assertReferenceSources(c: any, tid: string, quotationId: string,
  items: { sourceDocumentId?: string | null }[]) {
  const ids = [...new Set(items.map((i) => i.sourceDocumentId).filter(Boolean))] as string[];
  if (!ids.length) return;
  const attached = await c.query(
    `select id from billing_documents
     where tenant_id = $1 and quotation_id = $2 and id = any($3::uuid[]) and deleted_at is null`,
    [tid, quotationId, ids]);
  if (attached.rowCount !== ids.length) {
    throw new ApiError("VALIDATION_FAILED",
      "A line names a reference file that is not attached to this document.", 400, [{ field: "items" }]);
  }
}

/** Same where-to-pay defaults the invoice module already stamps. */
function composePaymentInstructions(pay: {
  pay_bank_name: string | null; pay_bank_account: string | null;
  pay_account_name: string | null; pay_mobile_money: string | null;
} | null): string | null {
  const lines: string[] = [];
  if (pay?.pay_bank_name) {
    lines.push(`Bank: ${pay.pay_bank_name}`);
    if (pay.pay_bank_account) lines.push(`Account no: ${pay.pay_bank_account}`);
    if (pay.pay_account_name) lines.push(`Account name: ${pay.pay_account_name}`);
  }
  if (pay?.pay_mobile_money) lines.push(`Mobile money: ${pay.pay_mobile_money}`);
  return lines.length ? lines.join("\n") : null;
}

export async function quotationsRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Charge catalog ----------
  app.get("/charge-catalog", { preHandler: [requireAuth, requirePermission("charge_catalog.view")] },
    async (req: any) => {
      const { rows } = await withTenant(req.user.tid, (c) => c.query(CATALOG_SQL, [req.user.tid]));
      return rows
        .map((r: any) => ({
          id: r.id, code: r.code, label: r.label, section: r.section, basis: r.basis,
          defaultRate: r.default_rate === null ? null : Number(r.default_rate),
          rateType: r.rate_type, eacExempt: r.eac_exempt, sort: r.sort,
          notes: r.notes, tenantOwn: Boolean(r.is_tenant_own)
        }))
        .sort((a: any, b: any) =>
          (SECTION_RANK[a.section] - SECTION_RANK[b.section]) || (a.sort - b.sort) || a.code.localeCompare(b.code));
    });

  // A tenant may add its own code or re-rate one it copied; the platform rows
  // are never writable from the app role (RLS makes that impossible).
  app.post("/charge-catalog", { preHandler: [requireAuth, requirePermission("charge_catalog.manage")] },
    async (req: any, reply) => {
      const body = z.object({
        code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_.-]{2,40}$/),
        label: z.string().trim().min(2).max(160),
        section: z.enum(SECTIONS),
        basis: z.enum(BASES).default("flat"),
        defaultRate: z.number().min(0).max(1_000_000_000).nullable().optional(),
        rateType: z.enum(["percent", "amount"]).nullable().optional(),
        eacExempt: z.boolean().default(false),
        sort: z.number().int().min(0).max(9999).default(500),
        notes: z.string().trim().max(300).nullable().optional()
      }).parse(req.body);

      const id = uuidv7();
      try {
        await withTenant(req.user.tid, async (c) => {
          await c.query(
            `insert into charge_catalog (id, tenant_id, code, label, section, basis, default_rate,
               rate_type, eac_exempt, sort, notes, created_by, updated_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
            [id, req.user.tid, body.code, body.label, body.section, body.basis,
             body.defaultRate ?? null, body.rateType ?? null, body.eacExempt,
             body.sort, body.notes ?? null, req.user.sub]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "charge_catalog", entityId: id,
            action: "charge_catalog.created",
            after: { code: body.code, label: body.label, section: body.section }
          });
        });
      } catch (e: any) {
        if (e.code === "23505") {
          throw new ApiError("CONFLICT", `The code ${body.code} already exists.`, 409);
        }
        throw e;
      }
      return reply.status(201).send({ id });
    });

  app.put("/charge-catalog/:id", { preHandler: [requireAuth, requirePermission("charge_catalog.manage")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({
        label: z.string().trim().min(2).max(160).optional(),
        section: z.enum(SECTIONS).optional(),
        basis: z.enum(BASES).optional(),
        defaultRate: z.number().min(0).max(1_000_000_000).nullable().optional(),
        rateType: z.enum(["percent", "amount"]).nullable().optional(),
        eacExempt: z.boolean().optional(),
        sort: z.number().int().min(0).max(9999).optional(),
        isActive: z.boolean().optional(),
        notes: z.string().trim().max(300).nullable().optional()
      }).parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const own = await c.query(
          `select code, label, tenant_id from charge_catalog
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!own.rowCount) {
          throw new ApiError("NOT_FOUND",
            "Only your own charge codes can be changed. Copy the standard one first.", 404);
        }
        const sets: string[] = ["updated_by = $2", "updated_at = now()"];
        const params: unknown[] = [id, req.user.sub, req.user.tid];
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("label" in body) set("label", body.label);
        if ("section" in body) set("section", body.section);
        if ("basis" in body) set("basis", body.basis);
        if ("defaultRate" in body) set("default_rate", body.defaultRate ?? null);
        if ("rateType" in body) set("rate_type", body.rateType ?? null);
        if ("eacExempt" in body) set("eac_exempt", body.eacExempt);
        if ("sort" in body) set("sort", body.sort);
        if ("isActive" in body) set("is_active", body.isActive);
        if ("notes" in body) set("notes", body.notes ?? null);
        await c.query(
          `update charge_catalog set ${sets.join(", ")}
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          params);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "charge_catalog", entityId: id,
          action: "charge_catalog.updated",
          before: { label: own.rows[0].label }, after: { label: body.label ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/charge-catalog/:id", { preHandler: [requireAuth, requirePermission("charge_catalog.manage")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      await withTenant(req.user.tid, async (c) => {
        const r = await c.query(
          `update charge_catalog set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null
           returning code`,
          [id, req.user.sub, req.user.tid]);
        if (!r.rowCount) {
          throw new ApiError("NOT_FOUND", "Only your own charge codes can be removed.", 404);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "charge_catalog", entityId: id,
          action: "charge_catalog.deleted", before: { code: r.rows[0].code }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Quotation list + KPIs ----------
  app.get("/quotations", { preHandler: [requireAuth, requirePermission("quotations.view")] },
    async (req: any) => {
      const q = z.object({
        status: z.enum(["draft", "issued", "accepted", "declined", "converted", "cancelled"]).optional(),
        kind: z.enum(["quotation", "proforma"]).optional(),
        q: z.string().trim().max(80).optional()
      }).parse(req.query);

      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `${QUOTATION_SELECT}
         where q.tenant_id = $1 and q.deleted_at is null
           and ($2::text is null or q.status = $2)
           and ($3::text is null or q.kind = $3)
           and ($4::text is null or q.customer_name ilike $4 or q.quotation_number ilike $4
                or q.bl_number ilike $4 or q.vessel_name ilike $4)
         order by q.created_at desc
         limit 300`,
        [req.user.tid, q.status ?? null, q.kind ?? null,
         q.q ? `%${q.q}%` : null]));

      const k = await withTenant(req.user.tid, (c) => c.query(
        `select count(*) filter (where status = 'draft')::int as drafts,
                count(*) filter (where status = 'issued')::int as awaiting,
                count(*) filter (where status = 'accepted')::int as accepted,
                coalesce(sum(total) filter (where status in ('issued','accepted')), 0)::float8 as open_value,
                count(*) filter (where valid_until is not null and valid_until < current_date
                  and status = 'issued')::int as lapsed
         from quotations where tenant_id = $1 and deleted_at is null`, [req.user.tid]));

      return { quotations: rows, kpis: k.rows[0] };
    });

  // ---------- Create ----------
  app.post("/quotations", { preHandler: [requireAuth, requirePermission("quotations.create")] },
    async (req: any, reply) => {
      const body = quotationSchema.parse(req.body);
      const t = computeQuotation(body.items);
      const id = uuidv7();

      try {
        await withTenant(req.user.tid, async (c) => {
          const prefix = body.kind === "quotation" ? "QT" : "PF";
          const seq = await c.query(
            `select coalesce(max(nullif(regexp_replace(quotation_number, '\\D', '', 'g'), '')::bigint), 0) + 1 as next
             from quotations where tenant_id = $1 and kind = $2 and deleted_at is null`,
            [req.user.tid, body.kind]);
          const number = `${prefix}-${String(seq.rows[0].next).padStart(4, "0")}`;

          let instructions = body.paymentInstructions ?? null;
          if (instructions === null) {
            const pay = await c.query(
              `select pay_bank_name, pay_bank_account, pay_account_name, pay_mobile_money
               from company_profiles where tenant_id = $1`, [req.user.tid]);
            instructions = composePaymentInstructions(pay.rows[0] ?? null);
          }

          if (body.shipmentId) {
            const ship = await c.query(
              `select id from cargo_shipments where id = $1 and tenant_id = $2 and deleted_at is null`,
              [body.shipmentId, req.user.tid]);
            if (!ship.rowCount) throw new ApiError("NOT_FOUND", "That cargo file does not exist.", 404);
          }

          await c.query(
            `insert into quotations (id, tenant_id, quotation_number, kind, status, customer_name,
               customer_phone_encrypted, customer_phone_search, customer_email, customer_tin,
               customer_address, shipment_id, vessel_name, voyage, bl_number, trade_type,
               currency, exchange_rate, vat_rate, issue_date, valid_until,
               statutory_total, port_total, transport_total, subtotal, vat_amount, total,
               payment_instructions, notes, created_by, updated_by)
             values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               $16,$17,$18, coalesce($19, current_date), $20,
               $21,$22,$23,$24,$25,$26,$27,$28,$29,$29)`,
            [id, req.user.tid, number, body.kind, body.customerName,
             body.customerPhone ? encryptField(body.customerPhone) : null,
             body.customerPhone ? searchHash(body.customerPhone) : null,
             body.customerEmail ?? null, body.customerTin ?? null,
             body.customerAddress ?? null, body.shipmentId ?? null,
             body.vesselName ?? null, body.voyage ?? null, body.blNumber ?? null,
             body.tradeType ?? null, body.currency, body.exchangeRate ?? null,
             body.vatRate, body.issueDate ?? null, body.validUntil ?? null,
             t.statutoryTotal, t.portTotal, t.transportTotal, t.subtotal, t.vatAmount, t.total,
             instructions, body.notes ?? null, req.user.sub]);

          await assertReferenceSources(c, req.user.tid, id, t.lines);
          for (let n = 0; n < t.lines.length; n++) {
            const l = t.lines[n];
            await c.query(
              `insert into quotation_items (id, tenant_id, quotation_id, seq, section, catalog_code,
                 description, basis, quantity, unit, unit_price, amount, tax_kind, tax_rate,
                 tax_amount, total, source_document_id, verified, notes)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
              [uuidv7(), req.user.tid, id, n + 1, l.section, l.catalogCode ?? null,
               l.description, l.basis, l.quantity, l.unit ?? null, l.unitPrice, l.amount,
               l.taxKind, l.taxRate, l.taxAmount, l.total,
               l.sourceDocumentId ?? null, l.verified, l.notes ?? null]);
          }

          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "quotations", entityId: id,
            action: "quotation.created",
            after: { number, kind: body.kind, customer: body.customerName,
                     currency: body.currency, total: t.total, lines: t.lines.length }
          });
        });
      } catch (e: any) {
        if (e.code === "23505") {
          throw new ApiError("CONFLICT", "Quotation number collision — try again.", 409);
        }
        throw e;
      }
      return reply.status(201).send({ id });
    });

  // ---------- Detail (lines + reference files + letterhead) ----------
  app.get("/quotations/:id", { preHandler: [requireAuth, requirePermission("quotations.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const head = await c.query(QUOTATION_DETAIL_SQL, [id, req.user.tid]);
        if (!head.rowCount) throw new ApiError("NOT_FOUND", "Quotation not found", 404);
        const row = head.rows[0];

        const [items, refs, letterhead] = await Promise.all([
          c.query(
            `select qi.id, qi.seq, qi.section, qi.catalog_code, qi.description, qi.basis,
                    qi.quantity, qi.unit, qi.unit_price, qi.amount, qi.tax_kind, qi.tax_rate,
                    qi.tax_amount, qi.total, qi.source_document_id, qi.verified, qi.notes,
                    bd.role as source_role, d.file_name as source_file
             from quotation_items qi
             left join billing_documents bd on bd.id = qi.source_document_id and bd.deleted_at is null
             left join documents d on d.id = bd.document_id and d.deleted_at is null
             where qi.quotation_id = $1 and qi.tenant_id = $2
             order by qi.seq`,
            [id, req.user.tid]),
          c.query(
            `select b.id, b.role, b.document_id, b.extract_status, b.extracted, b.extract_notes,
                    b.created_at, d.file_name, d.mime_type, d.size_bytes
             from billing_documents b
             join documents d on d.id = b.document_id and d.deleted_at is null
             where b.quotation_id = $1 and b.tenant_id = $2 and b.deleted_at is null
             order by b.role, b.created_at desc`,
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

        // The list select never carries the encrypted phone; only the owner-
        // visible detail reads it, and the search hash is never returned.
        const pii = await c.query(
          `select customer_phone_encrypted from quotations where id = $1 and tenant_id = $2`,
          [id, req.user.tid]);
        const phone = pii.rows[0]?.customer_phone_encrypted
          ? decryptField(pii.rows[0].customer_phone_encrypted)
          : null;

        const qrPayload = [
          `WAISHA-${row.kind === "quotation" ? "QUOTE" : "PROFORMA"}:${row.quotation_number}`,
          `AMT:${row.currency} ${Number(row.total).toFixed(2)}`,
          row.valid_until ? `VALID:${String(row.valid_until).slice(0, 10)}` : null,
          letterhead.rows[0]?.tin_display ? `TIN:${letterhead.rows[0].tin_display}` : null
        ].filter(Boolean).join("|");
        const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 240, margin: 1 });

        return {
          ...row,
          customer_phone: phone,
          items: items.rows,
          reference_files: refs.rows.map((r: any) => ({
            id: r.id, role: r.role, documentId: r.document_id, fileName: r.file_name,
            mimeType: r.mime_type, sizeBytes: r.size_bytes, extractStatus: r.extract_status,
            extraction: r.extracted ?? null, extractNotes: r.extract_notes, createdAt: r.created_at
          })),
          letterhead: letterhead.rows[0] ?? null,
          qr_data_url: qrDataUrl
        };
      });
    });

  // ---------- Edit (draft only; lines replaced whole) ----------
  app.put("/quotations/:id", { preHandler: [requireAuth, requirePermission("quotations.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = quotationSchema.partial().parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select status, vat_rate, kind, quotation_number from quotations
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Quotation not found", 404);
        if (prev.rows[0].status !== "draft") {
          throw new ApiError("CONFLICT",
            "Only a draft can be edited. Cancel it and raise a new document.", 409);
        }
        if (body.kind && body.kind !== prev.rows[0].kind) {
          throw new ApiError("VALIDATION_FAILED",
            "A quotation stays a quotation and a proforma stays a proforma.", 400, [{ field: "kind" }]);
        }

        const sets: string[] = ["updated_by = $2", "updated_at = now()"];
        const params: unknown[] = [id, req.user.sub, req.user.tid];
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };

        if ("customerName" in body) set("customer_name", body.customerName);
        if ("customerEmail" in body) set("customer_email", body.customerEmail ?? null);
        if ("customerTin" in body) set("customer_tin", body.customerTin ?? null);
        if ("customerAddress" in body) set("customer_address", body.customerAddress ?? null);
        if ("vesselName" in body) set("vessel_name", body.vesselName ?? null);
        if ("voyage" in body) set("voyage", body.voyage ?? null);
        if ("blNumber" in body) set("bl_number", body.blNumber ?? null);
        if ("tradeType" in body) set("trade_type", body.tradeType ?? null);
        if ("issueDate" in body && body.issueDate) set("issue_date", body.issueDate);
        if ("validUntil" in body) set("valid_until", body.validUntil ?? null);
        if ("currency" in body) set("currency", body.currency);
        if ("exchangeRate" in body) set("exchange_rate", body.exchangeRate ?? null);
        if ("paymentInstructions" in body) set("payment_instructions", body.paymentInstructions ?? null);
        if ("notes" in body) set("notes", body.notes ?? null);

        if ("shipmentId" in body) {
          if (body.shipmentId) {
            const ship = await c.query(
              `select id from cargo_shipments where id = $1 and tenant_id = $2 and deleted_at is null`,
              [body.shipmentId, req.user.tid]);
            if (!ship.rowCount) throw new ApiError("NOT_FOUND", "That cargo file does not exist.", 404);
          }
          set("shipment_id", body.shipmentId ?? null);
        }
        if ("customerPhone" in body) {
          set("customer_phone_encrypted", body.customerPhone ? encryptField(body.customerPhone) : null);
          set("customer_phone_search", body.customerPhone ? searchHash(body.customerPhone) : null);
        }

        if (body.items) {
          const t = computeQuotation(body.items);
          await assertReferenceSources(c, req.user.tid, id, t.lines);
          await c.query("delete from quotation_items where quotation_id = $1 and tenant_id = $2",
            [id, req.user.tid]);
          for (let n = 0; n < t.lines.length; n++) {
            const l = t.lines[n];
            await c.query(
              `insert into quotation_items (id, tenant_id, quotation_id, seq, section, catalog_code,
                 description, basis, quantity, unit, unit_price, amount, tax_kind, tax_rate,
                 tax_amount, total, source_document_id, verified, notes)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
              [uuidv7(), req.user.tid, id, n + 1, l.section, l.catalogCode ?? null,
               l.description, l.basis, l.quantity, l.unit ?? null, l.unitPrice, l.amount,
               l.taxKind, l.taxRate, l.taxAmount, l.total,
               l.sourceDocumentId ?? null, l.verified, l.notes ?? null]);
          }
          set("statutory_total", t.statutoryTotal);
          set("port_total", t.portTotal);
          set("transport_total", t.transportTotal);
          set("subtotal", t.subtotal);
          set("vat_amount", t.vatAmount);
          set("total", t.total);
          set("vat_rate", body.vatRate ?? Number(prev.rows[0].vat_rate));
        } else if ("vatRate" in body) {
          set("vat_rate", body.vatRate);
        }

        await c.query(
          `update quotations set ${sets.join(", ")}
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          params);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "quotations", entityId: id,
          action: "quotation.updated",
          after: { number: prev.rows[0].quotation_number,
                   lines: body.items ? body.items.length : null }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Status ----------
  app.put("/quotations/:id/status", { preHandler: [requireAuth, requirePermission("quotations.issue")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = statusSchema.parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select status, converted_invoice_id, quotation_number from quotations
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Quotation not found", 404);
        const from = prev.rows[0].status as string;
        if (from === body.status) return;
        if (from === "converted") {
          throw new ApiError("CONFLICT", "A converted document keeps its status.", 409);
        }
        if (from === "cancelled" && body.status !== "draft") {
          throw new ApiError("CONFLICT", "A cancelled document cannot be revived.", 409);
        }
        // Once the client has accepted it, going back to draft is a business
        // event, not a typo fix — that needs a fresh document.
        if (from === "accepted" && body.status === "draft") {
          throw new ApiError("CONFLICT",
            "An accepted document cannot go back to draft. Raise a new one.", 409);
        }
        await c.query(
          `update quotations set status = $4, updated_by = $2, updated_at = now()
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid, body.status]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "quotations", entityId: id,
          action: "quotation.status_changed",
          before: { status: from, number: prev.rows[0].quotation_number },
          after: { status: body.status }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Convert into an invoice ----------
  app.post("/quotations/:id/convert", {
    preHandler: [requireAuth, requirePermission("quotations.convert"), requirePermission("invoices.create")]
  }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const invoiceId = uuidv7();

    await withTenant(req.user.tid, async (c) => {
      const q = await c.query(
        `select kind, status, customer_name, customer_phone_encrypted, customer_phone_search,
                customer_email, customer_tin, customer_address, shipment_id, currency,
                vat_rate, statutory_total, port_total, transport_total, subtotal, vat_amount,
                total, payment_instructions, notes
         from quotations where id = $1 and tenant_id = $2 and deleted_at is null`,
        [id, req.user.tid]);
      if (!q.rowCount) throw new ApiError("NOT_FOUND", "Quotation not found", 404);
      const row = q.rows[0];
      if (!["issued", "accepted"].includes(row.status)) {
        throw new ApiError("CONFLICT",
          "Issue the document first — only an issued or accepted one can be billed.", 409);
      }

      const items = await c.query(
        `select section, catalog_code, description, basis, quantity, unit, unit_price,
                amount, tax_kind, tax_rate, tax_amount, total, notes
         from quotation_items where quotation_id = $1 and tenant_id = $2 order by seq`,
        [id, req.user.tid]);
      if (!items.rowCount) throw new ApiError("CONFLICT", "Nothing to bill — the document has no lines.", 409);

      const seq = await c.query(
        `select coalesce(max(nullif(regexp_replace(invoice_number, '\\D', '', 'g'), '')::bigint), 0) + 1 as next
         from freight_invoices where tenant_id = $1 and deleted_at is null`,
        [req.user.tid]);
      const invoiceNumber = `INV-${String(seq.rows[0].next).padStart(4, "0")}`;

      await c.query(
        `insert into freight_invoices (id, tenant_id, invoice_number, customer_name,
           customer_phone_encrypted, customer_phone_search, customer_email, customer_tin,
           customer_address, issue_date, due_date, currency, vat_rate, subtotal, vat_amount,
           total, statutory_total, port_total, transport_total, related_trip_id,
           payment_instructions, notes, source_quotation_id, status, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, current_date, null, $10,$11,$12,$13,$14,
           $15,$16,$17,null,$18,$19,$20,'draft',$21,$21)`,
        [invoiceId, req.user.tid, invoiceNumber, row.customer_name,
         row.customer_phone_encrypted, row.customer_phone_search, row.customer_email,
         row.customer_tin, row.customer_address, row.currency, row.vat_rate,
         row.subtotal, row.vat_amount, row.total, row.statutory_total, row.port_total,
         row.transport_total, row.payment_instructions, row.notes, id, req.user.sub]);

      for (let n = 0; n < items.rowCount!; n++) {
        const l = items.rows[n];
        await c.query(
          `insert into freight_invoice_items (id, tenant_id, invoice_id, seq, description,
             quantity, unit, unit_price, amount, section, catalog_code, basis,
             tax_kind, tax_rate, tax_amount)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [uuidv7(), req.user.tid, invoiceId, n + 1, l.description, l.quantity, l.unit,
           l.unit_price, l.amount, l.section, l.catalog_code, l.basis,
           l.tax_kind, l.tax_rate, l.tax_amount]);
      }

      await c.query(
        `update quotations set status = 'converted', converted_invoice_id = $2,
               updated_by = $3, updated_at = now()
         where id = $1 and tenant_id = $4 and deleted_at is null`,
        [id, invoiceId, req.user.sub, req.user.tid]);

      await writeAudit(c, {
        tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
        requestId: req.requestId, entity: "freight_invoices", entityId: invoiceId,
        action: "invoice.converted_from_quotation",
        after: { invoiceNumber, quotationId: id, total: Number(row.total),
                 lines: items.rowCount }
      });
    });
    return reply.status(201).send({ id: invoiceId });
  });

  // ---------- Delete ----------
  app.delete("/quotations/:id", { preHandler: [requireAuth, requirePermission("quotations.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      await withTenant(req.user.tid, async (c) => {
        const r = await c.query(
          `update quotations set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null
           returning quotation_number, status`,
          [id, req.user.sub, req.user.tid]);
        if (!r.rowCount) throw new ApiError("NOT_FOUND", "Quotation not found", 404);
        if (r.rows[0].status === "converted") {
          throw new ApiError("CONFLICT", "A document that already billed cannot be removed.", 409);
        }
        await c.query(
          `update documents set deleted_at = now()
           where tenant_id = $1 and entity_type = 'quotation' and entity_id = $2 and deleted_at is null`,
          [req.user.tid, id]);
        await c.query(
          `update billing_documents set deleted_at = now(), updated_by = $2
           where quotation_id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "quotations", entityId: id,
          action: "quotation.deleted", before: { number: r.rows[0].quotation_number }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Reference files: attach, read, cross-verify ----------
  // The bytes already live in the tenant's own vault; this reads their text
  // layer with pdfjs in-process and stores what it found as JSON.
  app.post("/quotations/:id/reference-files",
    { preHandler: [requireAuth, requirePermission("billing_documents.upload")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = referenceSchema.parse(req.body);
      await enforceRateLimit(`reference:uid:${req.user.sub}`, 12, 3600);

      const rowId = uuidv7();
      const result = await withTenant(req.user.tid, async (c) => {
        const q = await c.query(
          `select id, status from quotations where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!q.rowCount) throw new ApiError("NOT_FOUND", "Quotation not found", 404);
        if (q.rows[0].status !== "draft") {
          throw new ApiError("CONFLICT", "Reference files attach to a draft only.", 409);
        }
        const doc = await c.query(
          `select id, file_name, mime_type, storage_path, entity_type, entity_id
           from documents
           where id = $1 and tenant_id = $2 and entity_type = 'quotation' and entity_id = $3
             and deleted_at is null`,
          [body.documentId, req.user.tid, id]);
        if (!doc.rowCount) {
          throw new ApiError("NOT_FOUND",
            "Upload the file against this quotation first.", 404);
        }
        const taken = await c.query(
          `select id from billing_documents
           where quotation_id = $1 and tenant_id = $2 and role = $3 and deleted_at is null`,
          [id, req.user.tid, body.role]);
        if (taken.rowCount) {
          throw new ApiError("CONFLICT",
            `The ${body.role} reference slot is already filled. Remove it first.`, 409);
        }

        let status = "manual";
        let extracted: unknown = null;
        let notes = "No text layer — the figures have to be typed in.";
        if (doc.rows[0].mime_type === "application/pdf" && storageConfigured()) {
          try {
            const { bytes } = await getObject(doc.rows[0].storage_path);
            const text = await extractTextLines(bytes);
            const ex = parseReference(text.lines);
            extracted = {
              header: ex.header,
              lines: ex.lines,
              unparsed: ex.unparsed.slice(0, 120),
              notes: text.truncated
                ? `${ex.notes} Only the first pages were read.`
                : ex.notes
            } satisfies ReferenceExtraction;
            status = ex.lines.length ? "extracted" : "manual";
            notes = ex.notes;
          } catch (e: any) {
            status = "failed";
            notes = "The text layer could not be read from this file.";
            req.log.warn({ err: e, documentId: body.documentId }, "reference extraction failed");
          }
        } else if (doc.rows[0].mime_type === "application/pdf") {
          status = "failed";
          notes = "Storage is not configured, so the file could not be read.";
        }

        await c.query(
          `insert into billing_documents (id, tenant_id, quotation_id, role, document_id,
             extract_status, extracted, extract_notes, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
          [rowId, req.user.tid, id, body.role, body.documentId, status,
           extracted ? JSON.stringify(extracted) : null, notes, req.user.sub]);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "billing_documents", entityId: rowId,
          action: "reference_file.attached",
          after: { role: body.role, fileName: doc.rows[0].file_name, extractStatus: status }
        });
        return { extraction: extracted, extractStatus: status, notes };
      });

      return reply.status(201).send({ id: rowId, ...result });
    });

  app.delete("/quotations/:id/reference-files/:refId",
    { preHandler: [requireAuth, requirePermission("billing_documents.upload")] },
    async (req: any, reply) => {
      const { id, refId } = req.params as { id: string; refId: string };
      await withTenant(req.user.tid, async (c) => {
        const r = await c.query(
          `update billing_documents set deleted_at = now(), updated_by = $3
           where id = $1 and quotation_id = $2 and tenant_id = $4 and deleted_at is null
           returning role`,
          [refId, id, req.user.sub, req.user.tid]);
        if (!r.rowCount) throw new ApiError("NOT_FOUND", "That reference file is not attached here.", 404);
        await c.query(
          `update quotation_items set source_document_id = null, verified = false
           where source_document_id = $1 and tenant_id = $2`,
          [refId, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "billing_documents", entityId: refId,
          action: "reference_file.detached", before: { role: r.rows[0].role }
        });
      });
      return reply.send({ ok: true });
    });

  // Propose the bill from what was read. Nothing is written: the clerk sees the
  // proposal, edits it inline, and saves it through the normal draft update.
  app.post("/quotations/:id/suggest-lines",
    { preHandler: [requireAuth, requirePermission("quotations.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const q = await c.query(
          `select id from quotations where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!q.rowCount) throw new ApiError("NOT_FOUND", "Quotation not found", 404);

        const refs = await c.query(
          `select role, extract_status, extracted from billing_documents
           where quotation_id = $1 and tenant_id = $2 and deleted_at is null
           order by created_at desc`,
          [id, req.user.tid]);
        const asExtraction = (r: any): ReferenceExtraction | null =>
          r?.extracted ? (typeof r.extracted === "string" ? JSON.parse(r.extracted) : r.extracted) : null;
        const primary = asExtraction(refs.rows.find((r: any) => r.role === "primary"));
        const secondary = asExtraction(refs.rows.find((r: any) => r.role === "secondary"));
        if (!primary && !secondary) {
          throw new ApiError("VALIDATION_FAILED",
            "Attach a reference file and read it before asking for a proposal.", 400,
            [{ field: "referenceFiles" }]);
        }

        const catalog = await loadCatalog(c, req.user.tid);
        const out = reconcile(primary, secondary, catalog);
        return {
          lines: out.lines, unknown: out.unknown, checks: out.checks,
          read: { primary: Boolean(primary), secondary: Boolean(secondary) }
        };
      });
    });
}
