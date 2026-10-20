import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
import { verifyAccessToken } from "../security/jwt.js";
import { requirePermission } from "../security/permissions.js";
import { writeAudit } from "../audit/audit.js";
import { openJob, assertAssignable } from "../util/jobs.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PREFIX: Record<string, string> = { export: "1", import: "4", transhipment: "7", transit: "8" };
const LOOSE_TYPES = ["loose_cargo", "car"];

const containerFields = z.object({
  containerType: z.enum(["20ft", "40ft", "loose_cargo", "car"]),
  containerCount: z.number().int().positive().max(200).nullable().optional(),
  containerNumbers: z.array(z.string().trim().min(2).max(30)).max(200).nullable().optional()
});

const shipmentBase = containerFields.merge(z.object({
  shipmentType: z.enum(["export", "import", "transhipment", "transit"]),
  hsCode: z.string().trim().max(30).nullable().optional(),
  declarationMode: z.string().trim().max(60).nullable().optional(),
  cargoDescription: z.string().trim().max(500).nullable().optional(),
  cbm: z.number().nonnegative().max(1_000_000).nullable().optional(),
  weightTonnes: z.number().nonnegative().max(1_000_000).nullable().optional(),
  consigneeName: z.string().trim().min(2).max(160),
  consignorName: z.string().trim().min(2).max(160),
  shippingLine: z.string().trim().max(120).nullable().optional(),
  billNumber: z.string().trim().max(60).nullable().optional(),
  orderDate: dateOnly.nullable().optional(),
  documentReceiptDate: dateOnly.nullable().optional(),
  eta: dateOnly.nullable().optional(),
  dischargeDate: dateOnly.nullable().optional(),
  carryInDate: dateOnly.nullable().optional(),
  termsDelivery: z.enum(["CIF", "CFR", "EXW", "FCA", "CPT", "CIP", "DAP", "DDP", "FAS", "FOB"]).nullable().optional(),
  tansadNumber: z.string().trim().max(60).nullable().optional(),
  rcnNumber: z.string().trim().max(60).nullable().optional(),
  referenceNumber: z.string().trim().max(60).nullable().optional(),
  officeDeclaration: z.string().trim().max(120).nullable().optional(),
  borderPoint: z.string().trim().max(120).nullable().optional(),
  nominatedIcd: z.string().trim().max(120).nullable().optional(),
  cabinetPosition: z.string().trim().max(60).nullable().optional(),
  processingCost: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  paymentAmount: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  paymentStatus: z.enum(["unpaid", "partial", "paid"]).optional(),
  notes: z.string().trim().max(1000).nullable().optional()
}));

// Strict container rules on create: Loose Cargo / Car carry no containers,
// everything else needs a count and exactly that many container numbers.
const shipmentSchema = shipmentBase.superRefine((v, ctx) => {
  if (LOOSE_TYPES.includes(v.containerType)) return;
  if (!v.containerCount || v.containerCount < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["containerCount"], message: "Container count must be at least 1" });
  }
  const nums = v.containerNumbers ?? [];
  if (nums.length !== (v.containerCount ?? 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["containerNumbers"],
      message: `Enter exactly ${v.containerCount ?? 0} container number${(v.containerCount ?? 0) === 1 ? "" : "s"}`
    });
  }
});

const stageSchema = z.object({
  stage: z.enum(["pre_arrival", "arrival", "customs", "inspection", "release", "exit"])
});

const statusSchema = z.object({
  status: z.enum(["open", "on_hold", "completed", "cancelled"])
});

const taskSchema = z.object({
  title: z.string().trim().min(2).max(200),
  assignedTo: z.string().uuid().nullable().optional(),
  dueDate: dateOnly.nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

const STAGES = ["pre_arrival", "arrival", "customs", "inspection", "release", "exit"];

/** Next sequential file number for a tenant/type/year, from the company code. */
async function nextFileNumber(
  c: any, tid: string, shipmentType: string
): Promise<{ fileNumber: string; seq: number; year: number }> {
  const profile = await c.query(
    "select company_code from company_profiles where tenant_id = $1", [tid]);
  const code = profile.rows[0]?.company_code;
  if (!code) {
    throw new ApiError("VALIDATION_FAILED",
      "Choose your 3-letter company code on the Profile page before opening files.", 400,
      [{ field: "companyCode" }]);
  }
  const year = new Date().getFullYear();
  const seqRow = await c.query(
    `select coalesce(max(seq), 0) + 1 as next from cargo_shipments
     where tenant_id = $1 and shipment_type = $2 and file_year = $3 and deleted_at is null`,
    [tid, shipmentType, year]);
  const seq = seqRow.rows[0].next;
  return {
    fileNumber: `${PREFIX[shipmentType]}${code}-${String(seq).padStart(3, "0")}-${year}`,
    seq, year
  };
}

export async function cargoRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Analytics (pie / line / histogram / progress / P&L) ----------
  app.get("/cargo/analytics", { preHandler: [requireAuth, requirePermission("shipments.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const byType = await c.query(
          `select shipment_type, count(*)::int as count from cargo_shipments
           where tenant_id = $1 and deleted_at is null and status <> 'cancelled'
           group by shipment_type`, [req.user.tid]);

        const monthly = await c.query(
          `select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*)::int as count
           from cargo_shipments
           where tenant_id = $1 and deleted_at is null and status <> 'cancelled'
             and created_at >= (now() - interval '11 months')
           group by 1`, [req.user.tid]);

        const byStage = await c.query(
          `select stage, count(*)::int as count from cargo_shipments
           where tenant_id = $1 and deleted_at is null and status = 'open'
           group by stage`, [req.user.tid]);

        // Processing time: created -> completed, for files completed in the last year.
        const processing = await c.query(
          `select extract(day from completed_at - created_at)::int as days
           from cargo_shipments
           where tenant_id = $1 and deleted_at is null and status = 'completed'
             and completed_at is not null
             and completed_at >= (now() - interval '12 months')`, [req.user.tid]);
        const buckets = [
          { label: "0-3 days", min: 0, max: 3 },
          { label: "4-7 days", min: 4, max: 7 },
          { label: "8-14 days", min: 8, max: 14 },
          { label: "15-30 days", min: 15, max: 30 },
          { label: "30+ days", min: 31, max: 100000 }
        ].map(b => ({
          label: b.label,
          count: processing.rows.filter((r: any) => r.days >= b.min && r.days <= b.max).length
        }));

        const revenue = await c.query(
          `select to_char(date_trunc('month', issue_date), 'YYYY-MM') as month,
                  coalesce(sum(total), 0)::float8 as value
           from freight_invoices
           where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled')
             and issue_date >= (current_date - interval '11 months')
           group by 1`, [req.user.tid]);

        const pnl = await c.query(
          `select (select coalesce(sum(total), 0)::float8 from freight_invoices
                    where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled')) as revenue,
                  (select coalesce(sum(amount_paid), 0)::float8 from freight_invoices
                    where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled')) as received,
                  (select coalesce(sum(amount_paid), 0)::float8 from freight_expenses
                    where tenant_id = $1 and deleted_at is null and status <> 'cancelled') as paid`,
          [req.user.tid]);

        const p = pnl.rows[0];
        const revMap = new Map(revenue.rows.map((r: any) => [r.month, Number(r.value)]));
        const shipMap = new Map(monthly.rows.map((r: any) => [r.month, Number(r.count)]));
        const months: { month: string; shipments: number; revenue: number }[] = [];
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          months.push({ month: key, shipments: shipMap.get(key) ?? 0, revenue: revMap.get(key) ?? 0 });
        }

        return {
          byType: byType.rows,
          months,
          byStage: byStage.rows,
          processingBuckets: buckets,
          pnl: {
            revenue: Number(p.revenue),
            received: Number(p.received),
            paid: Number(p.paid),
            net: Math.round((Number(p.received) - Number(p.paid)) * 100) / 100
          }
        };
      });
    });

  // ---------- Register ----------
  app.get("/cargo", { preHandler: [requireAuth, requirePermission("shipments.view")] },
    async (req: any) => {
      const q = z.object({
        stage: z.enum(["pre_arrival", "arrival", "customs", "inspection", "release", "exit"]).optional(),
        shipmentType: z.enum(["export", "import", "transhipment", "transit"]).optional(),
        search: z.string().trim().max(60).optional()
      }).parse(req.query);

      const term = q.search ? `%${q.search}%` : null;
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select s.id, s.file_number, s.shipment_type, s.hs_code, s.container_type,
                s.container_count, s.consignee_name, s.consignor_name, s.eta,
                s.payment_status, s.payment_amount, s.processing_cost, s.stage, s.status,
                s.weight_tonnes, s.created_at,
                (select count(*) filter (where k.status = 'pending')::int from cargo_tasks k
                  where k.shipment_id = s.id) as open_tasks,
                -- The 111 sheet in one word, so a desk can see which files have a declaration and
                -- which only have papers loose in the vault. The live unique index keeps this a
                -- scalar: one master per file, never a subquery that returns two rows mid-list.
                (select case when m.declared_at is null then 'draft' else 'signed' end
                   from cargo_import_masters m
                  where m.shipment_id = s.id and m.tenant_id = $1 and m.deleted_at is null) as master_state
         from cargo_shipments s
         where s.tenant_id = $1 and s.deleted_at is null
           and ($2::text is null or s.stage = $2)
           and ($3::text is null or s.shipment_type = $3)
           and ($4::text is null or s.file_number ilike $4
                or s.consignee_name ilike $4 or s.consignor_name ilike $4
                or s.reference_number ilike $4 or s.bill_number ilike $4)
         order by s.created_at desc
         limit 200`,
        [req.user.tid, q.stage ?? null, q.shipmentType ?? null, term]));
      return rows;
    });

  // ---------- Create (file number generated server-side) ----------
  app.post("/cargo", { preHandler: [requireAuth, requirePermission("shipments.create")] },
    async (req: any, reply) => {
      const body = shipmentSchema.parse(req.body);
      const id = uuidv7();

      let fileNumber = "";
      try {
        await withTenant(req.user.tid, async (c) => {
          const { fileNumber: fn, seq, year } = await nextFileNumber(c, req.user.tid, body.shipmentType);
          fileNumber = fn;
          const loose = LOOSE_TYPES.includes(body.containerType);

          await c.query(
            `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year,
               shipment_type, hs_code, declaration_mode, cargo_description,
               container_type, container_count, container_numbers, cbm, weight_tonnes,
               consignee_name, consignor_name, shipping_line, bill_number,
               order_date, document_receipt_date, eta, discharge_date, carry_in_date,
               terms_delivery, tansad_number, rcn_number, reference_number,
               office_declaration, border_point, nominated_icd, cabinet_position,
               processing_cost, payment_amount, payment_status, notes,
               status, created_by, updated_by)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,
               'open',$36,$36)`,
            [id, req.user.tid, fn, seq, year,
             body.shipmentType, body.hsCode ?? null, body.declarationMode ?? null,
             body.cargoDescription ?? null,
             body.containerType, loose ? null : body.containerCount,
             loose ? null : body.containerNumbers ?? null,
             body.cbm ?? null, body.weightTonnes ?? null,
             body.consigneeName, body.consignorName, body.shippingLine ?? null,
             body.billNumber ?? null,
             body.orderDate ?? null, body.documentReceiptDate ?? null,
             body.eta ?? null, body.dischargeDate ?? null, body.carryInDate ?? null,
             body.termsDelivery ?? null, body.tansadNumber ?? null,
             body.rcnNumber ?? null, body.referenceNumber ?? null,
             body.officeDeclaration ?? null, body.borderPoint ?? null,
             body.nominatedIcd ?? null, body.cabinetPosition ?? null,
             body.processingCost ?? null, body.paymentAmount ?? null,
             body.paymentStatus ?? "unpaid", body.notes ?? null, req.user.sub]);

          await openJob(c, req.user.tid, id, req.user.sub);

          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "cargo_shipments", entityId: id,
            action: "shipment.created",
            after: { fileNumber, type: body.shipmentType, consignee: body.consigneeName }
          });
        });
      } catch (e: any) {
        if (e.code === "23505") {
          throw new ApiError("CONFLICT", "File number collision — save again to take the next number.", 409);
        }
        throw e;
      }
      return reply.status(201).send({ id, fileNumber });
    });

  // ---------- Detail ----------
  app.get("/cargo/:id", { preHandler: [requireAuth, requirePermission("shipments.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const s = await c.query(
          `select * from cargo_shipments where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!s.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);

        const [tasks, docs, staff] = await Promise.all([
          c.query(
            `select k.id, k.title, k.assigned_to, k.due_date, k.status, k.done_at, k.notes,
                    u.full_name as assignee_name
             from cargo_tasks k left join users u on u.id = k.assigned_to
             where k.shipment_id = $1 and k.tenant_id = $2
             order by (k.status = 'pending') desc, k.due_date nulls last, k.created_at`,
            [id, req.user.tid]),
          c.query(
            `select id, kind, file_name, mime_type, size_bytes, created_at from documents
             where entity_type = 'shipment' and entity_id = $1 and tenant_id = $2 and deleted_at is null
             order by created_at desc`,
            [id, req.user.tid]),
          c.query(
            `select id, full_name from users
             where tenant_id = $1 and deleted_at is null and status = 'active'
               and user_type in ('director','staff') order by full_name`,
            [req.user.tid])
        ]);

        return {
          ...s.rows[0],
          tasks: tasks.rows,
          documents: docs.rows,
          staff: staff.rows
        };
      });
    });

  // ---------- Edit (full-form PUT; file number and type are immutable) ----------
  app.put("/cargo/:id", { preHandler: [requireAuth, requirePermission("shipments.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = shipmentBase.partial().parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select status, container_type from cargo_shipments where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
        if (prev.rows[0].status === "cancelled" || prev.rows[0].status === "completed") {
          throw new ApiError("CONFLICT", `A ${prev.rows[0].status} file can no longer be edited.`, 409);
        }

        // Container type on an open file may change; re-run the strict rules.
        const containerType = body.containerType ?? prev.rows[0].container_type;
        const loose = LOOSE_TYPES.includes(containerType);
        if (!loose) {
          const count = body.containerCount ?? null;
          const nums = body.containerNumbers ?? null;
          if (!count || count < 1 || (nums ?? []).length !== count) {
            throw new ApiError("VALIDATION_FAILED",
              "Container count must match the number of container numbers entered.", 400);
          }
        }

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid]; // $1 id, $2 updated_by, $3 tenant_id
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("hsCode" in body) set("hs_code", body.hsCode ?? null);
        if ("declarationMode" in body) set("declaration_mode", body.declarationMode ?? null);
        if ("cargoDescription" in body) set("cargo_description", body.cargoDescription ?? null);
        if ("containerType" in body) set("container_type", body.containerType!);
        set("container_count", loose ? null : body.containerCount ?? null);
        set("container_numbers", loose ? null : body.containerNumbers ?? null);
        if ("cbm" in body) set("cbm", body.cbm ?? null);
        if ("weightTonnes" in body) set("weight_tonnes", body.weightTonnes ?? null);
        if ("consigneeName" in body) set("consignee_name", body.consigneeName!);
        if ("consignorName" in body) set("consignor_name", body.consignorName!);
        if ("shippingLine" in body) set("shipping_line", body.shippingLine ?? null);
        if ("billNumber" in body) set("bill_number", body.billNumber ?? null);
        if ("orderDate" in body) set("order_date", body.orderDate ?? null);
        if ("documentReceiptDate" in body) set("document_receipt_date", body.documentReceiptDate ?? null);
        if ("eta" in body) set("eta", body.eta ?? null);
        if ("dischargeDate" in body) set("discharge_date", body.dischargeDate ?? null);
        if ("carryInDate" in body) set("carry_in_date", body.carryInDate ?? null);
        if ("termsDelivery" in body) set("terms_delivery", body.termsDelivery ?? null);
        if ("tansadNumber" in body) set("tansad_number", body.tansadNumber ?? null);
        if ("rcnNumber" in body) set("rcn_number", body.rcnNumber ?? null);
        if ("referenceNumber" in body) set("reference_number", body.referenceNumber ?? null);
        if ("officeDeclaration" in body) set("office_declaration", body.officeDeclaration ?? null);
        if ("borderPoint" in body) set("border_point", body.borderPoint ?? null);
        if ("nominatedIcd" in body) set("nominated_icd", body.nominatedIcd ?? null);
        if ("cabinetPosition" in body) set("cabinet_position", body.cabinetPosition ?? null);
        if ("processingCost" in body) set("processing_cost", body.processingCost ?? null);
        if ("paymentAmount" in body) set("payment_amount", body.paymentAmount ?? null);
        if ("paymentStatus" in body) set("payment_status", body.paymentStatus ?? "unpaid");
        if ("notes" in body) set("notes", body.notes ?? null);

        if (sets.length) {
          await c.query(
            `update cargo_shipments set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
             where id = $1 and tenant_id = $3 and deleted_at is null`,
            params);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "cargo_shipments", entityId: id,
          action: "shipment.updated"
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Workflow stage ----------
  app.put("/cargo/:id/stage", { preHandler: [requireAuth, requirePermission("shipments.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = stageSchema.parse(req.body);
      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select stage, file_number from cargo_shipments where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
        if (prev.rows[0].stage === body.stage) return; // caller sees { ok: true }

        await c.query(
          `update cargo_shipments set stage = $2, updated_by = $3, updated_at = now()
           where id = $1 and tenant_id = $4 and deleted_at is null`,
          [id, body.stage, req.user.sub, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "cargo_shipments", entityId: id,
          action: "shipment.stage_changed",
          before: { stage: prev.rows[0].stage }, after: { stage: body.stage }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Status (open / on hold / completed / cancelled) ----------
  app.put("/cargo/:id/status", { preHandler: [requireAuth, requirePermission("shipments.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = statusSchema.parse(req.body);
      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select status from cargo_shipments where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
        if (prev.rows[0].status === body.status) return; // caller sees { ok: true }

        await c.query(
          `update cargo_shipments set status = $2,
             completed_at = case when $2 = 'completed' then now() else null end,
             updated_by = $3, updated_at = now()
           where id = $1 and tenant_id = $4 and deleted_at is null`,
          [id, body.status, req.user.sub, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "cargo_shipments", entityId: id,
          action: "shipment.status_changed",
          before: { status: prev.rows[0].status }, after: { status: body.status }
        });
      });
      return reply.send({ ok: true });
    });

  // ---------- Duplicate (new file number, same content) ----------
  app.post("/cargo/:id/duplicate", { preHandler: [requireAuth, requirePermission("shipments.create")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const newId = uuidv7();
      let fileNumber = "";
      try {
        await withTenant(req.user.tid, async (c) => {
          const src = await c.query(
            "select * from cargo_shipments where id=$1 and tenant_id=$2 and deleted_at is null",
            [id, req.user.tid]);
          if (!src.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
          const s = src.rows[0];
          const { fileNumber: fn, seq, year } = await nextFileNumber(c, req.user.tid, s.shipment_type);
          fileNumber = fn;

          await c.query(
            `insert into cargo_shipments (id, tenant_id, file_number, seq, file_year,
               shipment_type, hs_code, declaration_mode, cargo_description,
               container_type, container_count, container_numbers, cbm, weight_tonnes,
               consignee_name, consignor_name, shipping_line, bill_number,
               order_date, document_receipt_date, eta, discharge_date, carry_in_date,
               terms_delivery, tansad_number, rcn_number, reference_number,
               office_declaration, border_point, nominated_icd, cabinet_position,
               processing_cost, payment_amount, payment_status, notes,
               status, created_by, updated_by)
             select $1,$2,$3,$4,$5,
               shipment_type, hs_code, declaration_mode, cargo_description,
               container_type, container_count, container_numbers, cbm, weight_tonnes,
               consignee_name, consignor_name, shipping_line, bill_number,
               order_date, document_receipt_date, eta, discharge_date, carry_in_date,
               terms_delivery, tansad_number, rcn_number, reference_number,
               office_declaration, border_point, nominated_icd, cabinet_position,
               processing_cost, payment_amount, payment_status, notes,
               'open',$6,$6
             from cargo_shipments where id = $7`,
            [newId, req.user.tid, fn, seq, year, req.user.sub, id]);

          await openJob(c, req.user.tid, newId, req.user.sub);

          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "cargo_shipments", entityId: newId,
            action: "shipment.duplicated",
            after: { from: s.file_number, fileNumber }
          });
        });
      } catch (e: any) {
        if (e.code === "23505") {
          throw new ApiError("CONFLICT", "File number collision — try again.", 409);
        }
        throw e;
      }
      return reply.status(201).send({ id: newId, fileNumber });
    });

  // ---------- Delete (admin gate; soft) ----------
  app.delete("/cargo/:id", { preHandler: [requireAuth, requirePermission("shipments.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update cargo_shipments set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "cargo_shipments", entityId: id,
            action: "shipment.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
      return reply.send({ ok: true });
    });

  // ---------- Tasks ----------
  app.post("/cargo/:id/tasks", { preHandler: [requireAuth, requirePermission("shipments.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = taskSchema.parse(req.body);
      const taskId = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        const own = await c.query(
          "select id from cargo_shipments where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!own.rowCount) throw new ApiError("NOT_FOUND", "Cargo file not found", 404);
        if (body.assignedTo) await assertAssignable(c, req.user.tid, body.assignedTo);

        await c.query(
          `insert into cargo_tasks (id, tenant_id, shipment_id, title, assigned_to, due_date, notes, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
          [taskId, req.user.tid, id, body.title, body.assignedTo ?? null,
           body.dueDate ?? null, body.notes ?? null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "cargo_tasks", entityId: taskId,
          action: "task.assigned",
          after: { shipmentId: id, title: body.title, assignedTo: body.assignedTo ?? null, dueDate: body.dueDate ?? null }
        });
      });
      return reply.status(201).send({ id: taskId });
    });

  app.put("/cargo/:id/tasks/:taskId", { preHandler: [requireAuth, requirePermission("shipments.edit")] },
    async (req: any, reply) => {
      const { id, taskId } = req.params as { id: string; taskId: string };
      const body = z.object({ status: z.enum(["pending", "done", "cancelled"]) }).parse(req.body);
      await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update cargo_tasks set status = $2,
             done_at = case when $2 = 'done' then now() else done_at end,
             updated_by = $3, updated_at = now()
           where id = $1 and shipment_id = $4 and tenant_id = $5`,
          [taskId, body.status, req.user.sub, id, req.user.tid]);
        if (!res.rowCount) throw new ApiError("NOT_FOUND", "Task not found", 404);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "cargo_tasks", entityId: taskId,
          action: "task.status_changed", after: { status: body.status }
        });
      });
      return reply.send({ ok: true });
    });
}
