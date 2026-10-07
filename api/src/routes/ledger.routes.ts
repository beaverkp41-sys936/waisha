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

const expenseSchema = z.object({
  supplierName: z.string().trim().min(2).max(160),
  description: z.string().trim().max(300).nullable().optional(),
  category: z.enum(["fuel", "maintenance", "salaries", "rent", "office", "border", "toll", "loading", "other"]).optional(),
  amount: z.number().positive().max(1_000_000_000),
  currency: z.string().trim().min(3).max(8).optional(),
  expenseDate: dateOnly.optional(),
  dueDate: dateOnly.nullable().optional(),
  relatedTripId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional()
});

const paymentSchema = z.object({
  amount: z.number().positive().max(1_000_000_000),
  notes: z.string().trim().max(300).nullable().optional()
});

const money = (n: number) => Math.round(n * 100) / 100;

/** Derived expense status — mirrors the invoice logic. */
const EXPENSE_STATUS_SQL = `case
  when e.status = 'cancelled' then 'cancelled'
  when e.amount_paid >= e.amount and e.amount > 0 then 'paid'
  when e.amount_paid > 0 then 'partial'
  when e.due_date is not null and e.due_date < current_date then 'overdue'
  else 'open'
end`;

export async function ledgerRoutes(app: FastifyInstance, _opts: unknown) {

  // ---------- Receivables + P&L + trend (invoices.view) ----------
  app.get("/ledger/receivables", { preHandler: [requireAuth, requirePermission("invoices.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const ar = await c.query(
          `select customer_name,
                  count(*)::int as invoices,
                  coalesce(sum(total), 0)::float8 as invoiced,
                  coalesce(sum(amount_paid), 0)::float8 as paid,
                  coalesce(sum(total - amount_paid), 0)::float8 as outstanding,
                  coalesce(sum(case when due_date < current_date and amount_paid < total
                              then total - amount_paid else 0 end), 0)::float8 as overdue_amount,
                  min(case when amount_paid < total and due_date is not null then due_date end) as oldest_due
           from freight_invoices
           where tenant_id = $1 and deleted_at is null and status not in ('draft', 'cancelled')
           group by customer_name
           having sum(total - amount_paid) > 0
           order by outstanding desc`, [req.user.tid]);

        const pnl = await c.query(
          `select
             (select coalesce(sum(total), 0)::float8 from freight_invoices
               where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled')) as revenue_issued,
             (select coalesce(sum(amount_paid), 0)::float8 from freight_invoices
               where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled')) as cash_in,
             (select coalesce(sum(amount), 0)::float8 from freight_expenses
               where tenant_id = $1 and deleted_at is null and status <> 'cancelled') as expenses_recorded,
             (select coalesce(sum(amount_paid), 0)::float8 from freight_expenses
               where tenant_id = $1 and deleted_at is null and status <> 'cancelled') as cash_out`,
          [req.user.tid]);

        const revenue = await c.query(
          `select to_char(date_trunc('month', issue_date), 'YYYY-MM') as month,
                  coalesce(sum(total), 0)::float8 as value
           from freight_invoices
           where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled')
             and issue_date >= (current_date - interval '11 months')
           group by 1`, [req.user.tid]);
        const spend = await c.query(
          `select to_char(date_trunc('month', expense_date), 'YYYY-MM') as month,
                  coalesce(sum(amount), 0)::float8 as value
           from freight_expenses
           where tenant_id = $1 and deleted_at is null and status <> 'cancelled'
             and expense_date >= (current_date - interval '11 months')
           group by 1`, [req.user.tid]);

        // Merge into one continuous 12-month series.
        const months: { month: string; revenue: number; expenses: number }[] = [];
        const revMap = new Map(revenue.rows.map((r: any) => [r.month, Number(r.value)]));
        const expMap = new Map(spend.rows.map((r: any) => [r.month, Number(r.value)]));
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          months.push({ month: key, revenue: revMap.get(key) ?? 0, expenses: expMap.get(key) ?? 0 });
        }

        const p = pnl.rows[0];
        return {
          customers: ar.rows,
          pnl: {
            revenueIssued: Number(p.revenue_issued),
            cashIn: Number(p.cash_in),
            expensesRecorded: Number(p.expenses_recorded),
            cashOut: Number(p.cash_out),
            net: money(Number(p.cash_in) - Number(p.cash_out))
          },
          trend: months
        };
      });
    });

  // ---------- Payables (costs.view) ----------
  app.get("/ledger/payables", { preHandler: [requireAuth, requirePermission("costs.view")] },
    async (req: any) => {
      return withTenant(req.user.tid, async (c) => {
        const suppliers = await c.query(
          `select supplier_name,
                  count(*)::int as bills,
                  coalesce(sum(amount), 0)::float8 as billed,
                  coalesce(sum(amount_paid), 0)::float8 as paid,
                  coalesce(sum(amount - amount_paid), 0)::float8 as outstanding,
                  coalesce(sum(case when due_date < current_date and amount_paid < amount
                              then amount - amount_paid else 0 end), 0)::float8 as overdue_amount
           from freight_expenses
           where tenant_id = $1 and deleted_at is null and status <> 'cancelled'
           group by supplier_name
           order by outstanding desc`, [req.user.tid]);

        const expenses = await c.query(
          `select e.id, e.supplier_name, e.description, e.category, e.amount, e.amount_paid,
                  e.currency, e.expense_date, e.due_date, e.related_trip_id, e.notes,
                  t.reference as trip_reference, ${EXPENSE_STATUS_SQL} as effective_status
           from freight_expenses e
           left join trips t on t.id = e.related_trip_id
           where e.tenant_id = $1 and e.deleted_at is null
           order by e.expense_date desc, e.created_at desc
           limit 100`, [req.user.tid]);

        const totals = await c.query(
          `select coalesce(sum(amount), 0)::float8 as billed,
                  coalesce(sum(amount_paid), 0)::float8 as paid,
                  coalesce(sum(amount - amount_paid), 0)::float8 as outstanding
           from freight_expenses
           where tenant_id = $1 and deleted_at is null and status <> 'cancelled'`, [req.user.tid]);

        return { suppliers: suppliers.rows, expenses: expenses.rows, totals: totals.rows[0] };
      });
    });

  // ---------- Record expense (costs.create) ----------
  app.post("/expenses", { preHandler: [requireAuth, requirePermission("costs.create")] },
    async (req: any, reply) => {
      const body = expenseSchema.parse(req.body);
      const id = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        await c.query(
          `insert into freight_expenses (id, tenant_id, supplier_name, description, category,
             amount, currency, expense_date, due_date, related_trip_id, notes, created_by, updated_by)
           values ($1,$2,$3,$4,$5,$6,$7, coalesce($8, current_date), $9,$10,$11,$12,$12)`,
          [id, req.user.tid, body.supplierName, body.description ?? null,
           body.category ?? "other", body.amount, body.currency ?? "TZS",
           body.expenseDate ?? null, body.dueDate ?? null,
           body.relatedTripId ?? null, body.notes ?? null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "freight_expenses", entityId: id,
          action: "expense.recorded",
          after: { supplier: body.supplierName, amount: body.amount, category: body.category ?? "other" }
        });
      });
      return reply.status(201).send({ id });
    });

  // ---------- Pay a supplier (costs.edit) ----------
  app.post("/expenses/:id/payments", { preHandler: [requireAuth, requirePermission("costs.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = paymentSchema.parse(req.body);
      await withTenant(req.user.tid, async (c) => {
        const prev = await c.query(
          "select supplier_name, amount, amount_paid, status from freight_expenses where id=$1 and tenant_id=$2 and deleted_at is null",
          [id, req.user.tid]);
        if (!prev.rowCount) throw new ApiError("NOT_FOUND", "Expense not found", 404);
        if (prev.rows[0].status === "cancelled") {
          throw new ApiError("CONFLICT", "Payments cannot be recorded on a cancelled expense.", 409);
        }
        const already = Number(prev.rows[0].amount_paid);
        if (money(already + body.amount) > money(Number(prev.rows[0].amount)) + 0.001) {
          throw new ApiError("CONFLICT",
            `This payment exceeds the outstanding balance of ${money(Number(prev.rows[0].amount) - already).toLocaleString()} TZS.`, 409);
        }
        const paid = await c.query(
          `update freight_expenses set amount_paid = amount_paid + $2, updated_by = $3, updated_at = now()
           where id = $1 and tenant_id = $4 and deleted_at is null`,
          [id, body.amount, req.user.sub, req.user.tid]);
        if (!paid.rowCount) {
          throw new ApiError("INTERNAL", "Payment could not be applied — nothing was changed.", 500);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "freight_expenses", entityId: id,
          action: "expense.paid",
          after: { supplier: prev.rows[0].supplier_name, amount: body.amount,
                   balanceAfter: money(Number(prev.rows[0].amount) - already - body.amount) }
        });
      });
      return reply.status(201).send({ ok: true });
    });

  // ---------- Cancel / delete expense ----------
  app.put("/expenses/:id/status", { preHandler: [requireAuth, requirePermission("costs.edit")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({ status: z.literal("cancelled") }).parse(req.body);
      await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update freight_expenses set status = $2, updated_by = $3, updated_at = now()
           where id = $1 and tenant_id = $4 and deleted_at is null and amount_paid = 0 and status <> 'cancelled'`,
          [id, body.status, req.user.sub, req.user.tid]);
        if (!res.rowCount) {
          throw new ApiError("CONFLICT", "Only unpaid, open expenses can be cancelled.", 409);
        }
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          requestId: req.requestId, entity: "freight_expenses", entityId: id,
          action: "expense.cancelled"
        });
      });
      return reply.send({ ok: true });
    });

  app.delete("/expenses/:id", { preHandler: [requireAuth, requirePermission("costs.delete")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const r = await withTenant(req.user.tid, async (c) => {
        const res = await c.query(
          `update freight_expenses set deleted_at = now(), updated_by = $2
           where id = $1 and tenant_id = $3 and deleted_at is null and amount_paid = 0`,
          [id, req.user.sub, req.user.tid]);
        if (res.rowCount) {
          await writeAudit(c, {
            tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
            requestId: req.requestId, entity: "freight_expenses", entityId: id,
            action: "expense.deleted"
          });
        }
        return res;
      });
      if (!r.rowCount) {
        throw new ApiError("CONFLICT", "Only unpaid expenses can be deleted.", 409);
      }
      return reply.send({ ok: true });
    });
}
