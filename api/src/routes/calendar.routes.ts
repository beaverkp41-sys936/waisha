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

export interface CalendarEvent {
  date: string;      // YYYY-MM-DD
  type: string;      // eta | discharge | carry_in | trip_departure | trip_arrival |
                     // invoice_due | task_due | doc_expiry
  label: string;
  detail: string;
  href: string;
}

export async function calendarRoutes(app: FastifyInstance, _opts: unknown) {

  /** Month grid events — computed live from every dated record the portal holds. */
  app.get("/calendar/events", { preHandler: [requireAuth] }, async (req: any) => {
    const { month } = z.object({
      month: z.string().regex(/^\d{4}-\d{2}$/)
    }).parse(req.query);

    const [y, m] = month.split("-").map(Number);
    if (m < 1 || m > 12) throw new ApiError("VALIDATION_FAILED", "Bad month.", 400);
    const first = `${month}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const last = `${month}-${String(lastDay).padStart(2, "0")}`;

    return withTenant(req.user.tid, async (c) => {
      const events: CalendarEvent[] = [];
      const push = (date: string | null, type: string, label: string, detail: string, href: string) => {
        if (!date) return;
        const d = String(date).slice(0, 10);
        if (d < first || d > last) return;
        events.push({ date: d, type, label, detail, href });
      };

      const cargo = await c.query(
        `select id, file_number, consignee_name, eta, discharge_date, carry_in_date
         from cargo_shipments
         where tenant_id = $1 and deleted_at is null and status = 'open'`, [req.user.tid]);
      for (const s of cargo.rows) {
        push(s.eta, "eta", `${s.file_number} arrives`, `Consignee ${s.consignee_name}`, "/app/cfa/cargo");
        push(s.discharge_date, "discharge", `${s.file_number} discharge`, "Vessel discharge", "/app/cfa/cargo");
        push(s.carry_in_date, "carry_in", `${s.file_number} carry-in`, "ICD carry-in", "/app/cfa/cargo");
      }

      const trips = await c.query(
        `select t.id, coalesce(t.reference, left(t.id::text, 8)) as label,
                r.name as route_name, t.planned_departure, t.planned_arrival
         from trips t left join routes r on r.id = t.route_id
         where t.tenant_id = $1 and t.deleted_at is null and t.status in ('planned','in_transit')`,
        [req.user.tid]);
      for (const t of trips.rows) {
        if (t.planned_departure) push(
          t.planned_departure, "trip_departure", `Trip ${t.label} departs`,
          t.route_name ?? "", "/app/trips");
        if (t.planned_arrival) push(
          t.planned_arrival, "trip_arrival", `Trip ${t.label} arrives`,
          t.route_name ?? "", "/app/trips");
      }

      const invoices = await c.query(
        `select invoice_number, customer_name, due_date, (total - amount_paid)::float8 as balance
         from freight_invoices
         where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled')
           and amount_paid < total`, [req.user.tid]);
      for (const i of invoices.rows) {
        push(i.due_date, "invoice_due", `Invoice ${i.invoice_number} due`,
          `${i.customer_name} — ${Number(i.balance).toLocaleString()} outstanding`, "/app/cfa/invoices");
      }

      const tasks = await c.query(
        `select k.title, k.due_date, s.file_number
         from cargo_tasks k join cargo_shipments s on s.id = k.shipment_id
         where k.tenant_id = $1 and k.status = 'pending' and k.due_date is not null`,
        [req.user.tid]);
      for (const t of tasks.rows) {
        push(t.due_date, "task_due", `Task due: ${t.title}`, `File ${t.file_number}`, "/app/cfa/cargo");
      }

      const vessels = await c.query(
        `select name, insurance_expiry, inspection_expiry, road_licence_expiry
         from vessels where tenant_id = $1 and deleted_at is null`, [req.user.tid]);
      for (const v of vessels.rows) {
        push(v.insurance_expiry, "doc_expiry", `${v.name} insurance expires`, "Renew insurance", "/app/compliance");
        push(v.inspection_expiry, "doc_expiry", `${v.name} inspection expires`, "Renew inspection", "/app/compliance");
        push(v.road_licence_expiry, "doc_expiry", `${v.name} road licence expires`, "Renew road licence", "/app/compliance");
      }

      const drivers = await c.query(
        `select full_name, licence_expiry from drivers
         where tenant_id = $1 and deleted_at is null and licence_expiry is not null`, [req.user.tid]);
      for (const d of drivers.rows) {
        push(d.licence_expiry, "doc_expiry", `${d.full_name} licence expires`, "Renew driving licence", "/app/compliance");
      }

      events.sort((a, b) => a.date.localeCompare(b.date));
      return { month, events };
    });
  });
}
