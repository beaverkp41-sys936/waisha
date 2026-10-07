import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../db/pool.js";
import { verifyAccessToken } from "../security/jwt.js";
import { ApiError } from "../util/errors.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

const summarySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function reportsRoutes(app: FastifyInstance, _opts: unknown) {

  /** Period-filtered operational + financial summary. Defaults: last 30 days. */
  app.get("/reports/summary", { preHandler: [requireAuth] }, async (req: any) => {
    const q = summarySchema.parse(req.query);
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from = q.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw new ApiError("VALIDATION_FAILED", "The start date is after the end date.", 400);

    return withTenant(req.user.tid, async (c) => {
      const revenue = await c.query(
        `select coalesce(sum(total), 0)::float8 as issued,
                coalesce(sum(amount_paid), 0)::float8 as received,
                count(*)::int as count
         from freight_invoices
         where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled')
           and issue_date between $2 and $3`, [req.user.tid, from, to]);

      const expenses = await c.query(
        `select coalesce(sum(amount), 0)::float8 as recorded,
                coalesce(sum(amount_paid), 0)::float8 as paid,
                count(*)::int as count
         from freight_expenses
         where tenant_id = $1 and deleted_at is null and status <> 'cancelled'
           and expense_date between $2 and $3`, [req.user.tid, from, to]);

      const trips = await c.query(
        `select status, count(*)::int as n from trips
         where tenant_id = $1 and deleted_at is null
           and coalesce(created_at::date, current_date) between $2 and $3
         group by status`, [req.user.tid, from, to]);

      const fuel = await c.query(
        `select coalesce(sum(litres), 0)::float8 as litres,
                coalesce(sum(coalesce(total_cost, litres * coalesce(price_per_litre, 0))), 0)::float8 as cost,
                count(*)::int as entries
         from fuel_logs
         where tenant_id = $1 and deleted_at is null
           and log_date between $2 and $3`, [req.user.tid, from, to]);

      const incidents = await c.query(
        `select status, count(*)::int as n from incidents
         where tenant_id = $1 and deleted_at is null
           and incident_date between $2 and $3
         group by status`, [req.user.tid, from, to]);

      const topCustomers = await c.query(
        `select customer_name,
                coalesce(sum(total), 0)::float8 as invoiced,
                count(*)::int as invoices
         from freight_invoices
         where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled')
           and issue_date between $2 and $3
         group by customer_name
         order by invoiced desc
         limit 5`, [req.user.tid, from, to]);

      const tripsByStatus: Record<string, number> = {};
      for (const r of trips.rows) tripsByStatus[r.status] = r.n;
      const incidentsByStatus: Record<string, number> = {};
      for (const r of incidents.rows) incidentsByStatus[r.status] = r.n;

      const rev = revenue.rows[0];
      const exp = expenses.rows[0];

      return {
        from, to,
        revenue: { issued: rev.issued, received: rev.received, count: rev.count },
        expenses: { recorded: exp.recorded, paid: exp.paid, count: exp.count },
        net: Math.round((rev.received - exp.paid) * 100) / 100,
        trips: {
          planned: tripsByStatus.planned ?? 0,
          in_transit: tripsByStatus.in_transit ?? 0,
          completed: tripsByStatus.completed ?? 0,
          cancelled: tripsByStatus.cancelled ?? 0,
          total: Object.values(tripsByStatus).reduce((a, b) => a + b, 0)
        },
        fuel: { litres: fuel.rows[0].litres, cost: fuel.rows[0].cost, entries: fuel.rows[0].entries },
        incidents: {
          open: (incidentsByStatus.open ?? 0) + (incidentsByStatus.investigating ?? 0),
          resolved: incidentsByStatus.resolved ?? 0
        },
        topCustomers: topCustomers.rows
      };
    });
  });
}
