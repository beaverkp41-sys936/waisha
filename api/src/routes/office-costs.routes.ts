import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { ApiError } from "../util/errors.js";
import { uuidv7 } from "../util/uuid.js";
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
const monthOnly = z.string().regex(/^\d{4}-\d{2}$/);
const CATEGORIES = ["allowance", "meals", "utilities", "rent",
  "transport", "supplies", "communication", "other"] as const;

const costSchema = z.object({
  costDate: dateOnly,
  category: z.enum(CATEGORIES),
  description: z.string().trim().min(2).max(200),
  amount: z.number().nonnegative().max(1_000_000_000_000),
  payee: z.string().trim().max(160).nullable().optional(),
  employeeId: z.string().uuid().nullable().optional(),
  shipmentId: z.string().uuid().nullable().optional(),
  paymentMethod: z.enum(["cash", "mobile_money", "bank", "cheque"]).default("cash"),
  receiptNo: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional()
});

const costUpdateSchema = costSchema.partial();

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(1000).nullable().optional()
});

const budgetSchema = z.object({
  period: monthOnly,
  category: z.enum(CATEGORIES),
  amount: z.number().nonnegative().max(1_000_000_000_000),
  notes: z.string().trim().max(1000).nullable().optional()
});

export async function officeCostsRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Cost register ----------

  app.get("/office-costs", { preHandler: [requireAuth, requirePermission("office_costs.view")] },
    async (req: any) => {
      const q = z.object({
        month: monthOnly.optional(),
        category: z.enum(CATEGORIES).optional(),
        status: z.enum(["pending", "approved", "rejected"]).optional(),
        shipmentId: z.string().uuid().optional(),
        employeeId: z.string().uuid().optional(),
        search: z.string().trim().max(80).optional()
      }).parse(req.query);

      const term = q.search ? `%${q.search}%` : null;
      const monthStart = q.month ? `${q.month}-01` : null;
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select oc.id, oc.cost_date::text as cost_date, oc.category, oc.description,
                oc.amount::float8 as amount, oc.payee, oc.payment_method, oc.receipt_no,
                oc.status, oc.review_note, oc.notes, oc.created_at,
                oc.employee_id, e.full_name as employee_name,
                oc.shipment_id, cs.file_number,
                oc.approved_by, u.full_name as approved_by_name, oc.approved_at,
                (select count(*)::int from documents d
                  where d.tenant_id = oc.tenant_id and d.entity_type = 'office_cost'
                    and d.entity_id = oc.id and d.deleted_at is null) as document_count,
                (select d.id from documents d
                  where d.tenant_id = oc.tenant_id and d.entity_type = 'office_cost'
                    and d.entity_id = oc.id and d.deleted_at is null
                  order by d.created_at desc limit 1) as latest_document_id
         from office_costs oc
         left join employees e on e.id = oc.employee_id
         left join cargo_shipments cs on cs.id = oc.shipment_id
         left join users u on u.id = oc.approved_by
         where oc.tenant_id = $1 and oc.deleted_at is null
           and ($2::date is null or (oc.cost_date >= $2 and oc.cost_date < ($2::date + interval '1 month')))
           and ($3::text is null or oc.category = $3)
           and ($4::text is null or oc.status = $4)
           and ($5::uuid is null or oc.shipment_id = $5)
           and ($6::uuid is null or oc.employee_id = $6)
           and ($7::text is null or oc.description ilike $7 or oc.payee ilike $7 or oc.receipt_no ilike $7)
         order by case when oc.status = 'pending' then 0 else 1 end,
                  oc.cost_date desc, oc.created_at desc
         limit 400`,
        [req.user.tid, monthStart, q.category ?? null, q.status ?? null,
         q.shipmentId ?? null, q.employeeId ?? null, term]));
      return rows;
    });

  app.post("/office-costs", { preHandler: [requireAuth, requirePermission("office_costs.create")] },
    async (req: any, reply) => {
      const body = costSchema.parse(req.body);
      const id = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        if (body.employeeId) {
          const emp = await c.query(
            "select id from employees where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.employeeId, req.user.tid]);
          if (!emp.rowCount) throw new ApiError("VALIDATION_FAILED", "Employee not found.", 400, [{ field: "employeeId" }]);
        }
        if (body.shipmentId) {
          const sh = await c.query(
            "select id from cargo_shipments where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.shipmentId, req.user.tid]);
          if (!sh.rowCount) throw new ApiError("VALIDATION_FAILED", "Cargo file not found.", 400, [{ field: "shipmentId" }]);
        }
        await c.query(
          `insert into office_costs (id, tenant_id, cost_date, category, description, amount,
             payee, employee_id, shipment_id, payment_method, receipt_no, notes,
             created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
          [id, req.user.tid, body.costDate, body.category, body.description, body.amount,
           body.payee ?? null, body.employeeId ?? null, body.shipmentId ?? null,
           body.paymentMethod, body.receiptNo ?? null, body.notes ?? null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_costs", entityId: id,
          action: "office_cost.created",
          after: { category: body.category, amount: body.amount, description: body.description }
        });
      });
      return reply.status(201).send({ id });
    });

  app.put("/office-costs/:id", { preHandler: [requireAuth, requirePermission("office_costs.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = costUpdateSchema.parse(req.body);

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select description, status, amount::float8 as amount from office_costs
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Cost entry not found", 404);

        if (body.employeeId) {
          const emp = await c.query(
            "select id from employees where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.employeeId, req.user.tid]);
          if (!emp.rowCount) throw new ApiError("VALIDATION_FAILED", "Employee not found.", 400, [{ field: "employeeId" }]);
        }
        if (body.shipmentId) {
          const sh = await c.query(
            "select id from cargo_shipments where id = $1 and tenant_id = $2 and deleted_at is null",
            [body.shipmentId, req.user.tid]);
          if (!sh.rowCount) throw new ApiError("VALIDATION_FAILED", "Cargo file not found.", 400, [{ field: "shipmentId" }]);
        }

        const sets: string[] = [];
        const params: unknown[] = [id, req.user.sub, req.user.tid];
        const set = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if ("costDate" in body) set("cost_date", body.costDate);
        if ("category" in body) set("category", body.category);
        if ("description" in body) set("description", body.description);
        if ("amount" in body) set("amount", body.amount);
        if ("payee" in body) set("payee", body.payee ?? null);
        if ("employeeId" in body) set("employee_id", body.employeeId ?? null);
        if ("shipmentId" in body) set("shipment_id", body.shipmentId ?? null);
        if ("paymentMethod" in body) set("payment_method", body.paymentMethod);
        if ("receiptNo" in body) set("receipt_no", body.receiptNo ?? null);
        if ("notes" in body) set("notes", body.notes ?? null);

        if (sets.length) {
          // An edited entry is no longer the thing that was approved — it goes
          // back to pending for a fresh decision.
          if (prev.rows[0].status !== "pending") {
            set("status", "pending");
            set("approved_by", null);
            set("approved_at", null);
            set("review_note", null);
          }
          await c.query(
            `update office_costs set ${["updated_by = $2", "updated_at = now()", ...sets].join(", ")}
             where id = $1 and tenant_id = $3 and deleted_at is null`, params);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_costs", entityId: id,
          action: "office_cost.updated",
          before: { status: prev.rows[0].status, description: prev.rows[0].description, amount: prev.rows[0].amount },
          after: { status: prev.rows[0].status !== "pending" && sets.length ? "pending" : prev.rows[0].status }
        });
      });
      return reply.send({ ok: true });
    });

  app.post("/office-costs/:id/decision", { preHandler: [requireAuth, requirePermission("office_costs.approve")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = decisionSchema.parse(req.body);
      const status = body.decision === "approve" ? "approved" : "rejected";

      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          `select description, status from office_costs
           where id = $1 and tenant_id = $2 and deleted_at is null`,
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Cost entry not found", 404);
        if (prev.rows[0].status !== "pending") {
          throw new ApiError("CONFLICT", "This entry has already been reviewed — edit it to send it back for approval.", 409);
        }
        await c.query(
          `update office_costs set status = $4, approved_by = $2, approved_at = now(),
             review_note = $5, updated_by = $2, updated_at = now()
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid, status, body.note ?? null]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_costs", entityId: id,
          action: body.decision === "approve" ? "office_cost.approved" : "office_cost.rejected",
          before: { status: "pending", description: prev.rows[0].description },
          after: { status, note: body.note ?? null }
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/office-costs/:id", { preHandler: [requireAuth, requirePermission("office_costs.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update office_costs set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await c.query(
            `update documents set deleted_at = now()
             where tenant_id = $1 and entity_type = 'office_cost' and entity_id = $2 and deleted_at is null`,
            [req.user.tid, id]);
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "office_costs", entityId: id,
            action: "office_cost.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Cost entry not found", 404);
      return reply.send({ ok: true });
    });

  // ---------- Dashboard: period KPIs, category spend-vs-budget, trend ----------

  app.get("/office-costs/summary", { preHandler: [requireAuth, requirePermission("office_costs.view")] },
    async (req: any) => {
      const q = z.object({ month: monthOnly.optional() }).parse(req.query);
      const month = q.month ?? new Date().toISOString().slice(0, 7);
      const monthStart = `${month}-01`;

      return withTenant(req.user.tid, async (c) => {
        const byCat = await c.query(
          `select category,
                  coalesce(sum(amount) filter (where status = 'approved'), 0)::float8 as spent,
                  coalesce(sum(amount) filter (where status = 'pending'), 0)::float8 as pending,
                  count(*) filter (where status = 'pending')::int as pending_count,
                  count(*) filter (where status = 'approved')::int as approved_count
           from office_costs
           where tenant_id = $1 and deleted_at is null
             and cost_date >= $2 and cost_date < ($2::date + interval '1 month')
           group by category`,
          [req.user.tid, monthStart]);

        const budgets = await c.query(
          `select category, amount::float8 as amount from office_budgets
           where tenant_id = $1 and period = $2 and deleted_at is null`,
          [req.user.tid, monthStart]);

        const trend = await c.query(
          `select to_char(date_trunc('month', cost_date), 'YYYY-MM') as month,
                  coalesce(sum(amount) filter (where status = 'approved'), 0)::float8 as value,
                  count(*) filter (where status = 'approved')::int as count
           from office_costs
           where tenant_id = $1 and deleted_at is null
             and cost_date >= ($2::date - interval '5 months')
             and cost_date < ($2::date + interval '1 month')
           group by 1`,
          [req.user.tid, monthStart]);

        const spendMap = new Map(byCat.rows.map((r: any) => [r.category, r]));
        const budgetMap = new Map(budgets.rows.map((r: any) => [r.category, Number(r.amount)]));
        const categories = CATEGORIES.map((cat) => {
          const r = spendMap.get(cat);
          const budget = budgetMap.get(cat) ?? 0;
          const spent = r ? Number(r.spent) : 0;
          const pending = r ? Number(r.pending) : 0;
          const pendingCount = r ? Number(r.pending_count) : 0;
          const approvedCount = r ? Number(r.approved_count) : 0;
          return {
            category: cat, budget,
            spent: Math.round(spent * 100) / 100,
            pending: Math.round(pending * 100) / 100,
            pendingCount, approvedCount,
            remaining: Math.round((budget - spent) * 100) / 100
          };
        });
        const sum = (f: (x: typeof categories[number]) => number) =>
          Math.round(categories.reduce((a, x) => a + f(x), 0) * 100) / 100;
        const totals = {
          budget: sum(x => x.budget),
          spent: sum(x => x.spent),
          pending: sum(x => x.pending),
          pendingCount: categories.reduce((a, x) => a + x.pendingCount, 0),
          approvedCount: categories.reduce((a, x) => a + x.approvedCount, 0),
          remaining: sum(x => x.remaining)
        };

        const trendMap = new Map(trend.rows.map((r: any) => [r.month, r]));
        const months: { month: string; value: number; count: number }[] = [];
        const [y, m] = month.split("-").map(Number);
        for (let i = 5; i >= 0; i--) {
          const d = new Date(y, (m - 1) - i, 1);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          const r = trendMap.get(key);
          months.push({ month: key, value: r ? Number(r.value) : 0, count: r ? Number(r.count) : 0 });
        }

        return { month, categories, totals, months };
      });
    });

  // ---------- File costs against revenue ----------

  app.get("/office-costs/file-costs", { preHandler: [requireAuth, requirePermission("office_costs.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const totals = await c.query(
          `select count(distinct oc.shipment_id)::int as files,
                  coalesce(sum(oc.amount) filter (where oc.status = 'approved'), 0)::float8 as allocated,
                  coalesce(sum(oc.amount) filter (where oc.status = 'pending'), 0)::float8 as pending
           from office_costs oc
           where oc.tenant_id = $1 and oc.deleted_at is null and oc.shipment_id is not null`,
          [req.user.tid]);

        const { rows } = await c.query(
          `select s.id, s.file_number, s.shipment_type, s.stage, s.status, s.consignee_name,
                  s.payment_status,
                  s.payment_amount::float8 as payment_amount,
                  s.processing_cost::float8 as processing_cost,
                  c.allocated::float8 as allocated,
                  c.pending_amount::float8 as pending_amount,
                  c.entries::int as entries
           from cargo_shipments s
           join (select shipment_id,
                        coalesce(sum(amount) filter (where status = 'approved'), 0) as allocated,
                        coalesce(sum(amount) filter (where status = 'pending'), 0) as pending_amount,
                        count(*) as entries
                 from office_costs
                 where tenant_id = $1 and deleted_at is null and shipment_id is not null
                 group by shipment_id) c on c.shipment_id = s.id
           where s.tenant_id = $1 and s.deleted_at is null
           order by c.allocated desc, s.file_number
           limit 200`,
          [req.user.tid]);

        return {
          totals: {
            files: Number(totals.rows[0].files),
            allocated: Number(totals.rows[0].allocated),
            pending: Number(totals.rows[0].pending)
          },
          rows: rows.map((r: any) => ({
            ...r,
            margin: r.payment_amount === null
              ? null
              : Math.round((Number(r.payment_amount) - Number(r.processing_cost ?? 0) - Number(r.allocated)) * 100) / 100
          }))
        };
      });
    });

  // ---------- Monthly budgets ----------

  app.get("/office-budgets", { preHandler: [requireAuth, requirePermission("office_budgets.view")] },
    async (req: any) => {
      const q = z.object({ period: monthOnly.optional() }).parse(req.query);
      const period = q.period ?? new Date().toISOString().slice(0, 7);
      const { rows } = await withTenant(req.user.tid, (c) => c.query(
        `select id, period::text as period, category, amount::float8 as amount, notes, created_at
         from office_budgets
         where tenant_id = $1 and period = $2 and deleted_at is null
         order by category`,
        [req.user.tid, `${period}-01`]));
      return rows;
    });

  app.post("/office-budgets", { preHandler: [requireAuth, requirePermission("office_budgets.manage")] },
    async (req: any, reply) => {
      const body = budgetSchema.parse(req.body);
      const id = uuidv7();
      const budgetId = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `insert into office_budgets (id, tenant_id, period, category, amount, notes, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, $7)
           on conflict (tenant_id, period, category) where deleted_at is null
           do update set amount = excluded.amount, notes = excluded.notes,
                         updated_by = excluded.updated_by, updated_at = now()
           returning id`,
          [id, req.user.tid, `${body.period}-01`, body.category, body.amount,
           body.notes ?? null, req.user.sub]);
        const savedId = res.rows[0].id as string;
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "office_budgets", entityId: savedId,
          action: "office_budget.set",
          after: { period: body.period, category: body.category, amount: body.amount }
        });
        return savedId;
      });
      return reply.send({ id: budgetId });
    });

  app.delete("/office-budgets/:id", { preHandler: [requireAuth, requirePermission("office_budgets.manage")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update office_budgets set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "office_budgets", entityId: id,
            action: "office_budget.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) throw new ApiError("NOT_FOUND", "Budget not found", 404);
      return reply.send({ ok: true });
    });
}
