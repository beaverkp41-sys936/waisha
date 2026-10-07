import type { FastifyInstance } from "fastify";
import { withTenant } from "../db/pool.js";
import { verifyAccessToken } from "../security/jwt.js";
import { ApiError } from "../util/errors.js";

async function requireAuth(req: any) {
  const auth = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const claims = auth ? await verifyAccessToken(auth) : null;
  if (!claims) throw new ApiError("TOKEN_EXPIRED", "Sign in to continue", 401);
  req.user = claims;
}

interface Notification {
  type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  href: string;
  date: string;
}

const DAY = 86_400_000;

export async function notificationsRoutes(app: FastifyInstance, _opts: unknown) {

  /**
   * Alerts are computed live from real signals — nothing is stored, so there
   * is no write-sync to drift. Sources: overdue invoices, expiring vessel and
   * driver documents, low stock, open incidents, overdue supplier expenses,
   * pending staff invites and imminent departures.
   */
  app.get("/notifications", { preHandler: [requireAuth] }, async (req: any) => {
    return withTenant(req.user.tid, async (c) => {
      const items: Notification[] = [];
      const today = Date.now();

      // Overdue customer invoices
      const overdueInv = await c.query(
        `select id, invoice_number, customer_name, due_date, (total - amount_paid)::float8 as balance
         from freight_invoices
         where tenant_id = $1 and deleted_at is null and status not in ('draft','cancelled')
           and due_date < current_date and amount_paid < total
         order by due_date`, [req.user.tid]);
      for (const r of overdueInv.rows) {
        const days = Math.floor((today - new Date(r.due_date).getTime()) / DAY);
        items.push({
          type: "invoice_overdue", severity: "critical",
          title: `Invoice ${r.invoice_number} overdue ${days} day${days === 1 ? "" : "s"}`,
          detail: `${r.customer_name} owes ${Number(r.balance).toLocaleString()}`,
          href: "/app/cfa/invoices", date: r.due_date
        });
      }

      // Vessel documents (insurance, inspection, road licence)
      const vessels = await c.query(
        `select id, name, insurance_expiry, inspection_expiry, road_licence_expiry
         from vessels where tenant_id = $1 and deleted_at is null`, [req.user.tid]);
      for (const v of vessels.rows) {
        for (const [doc, expiry] of [
          ["Insurance", v.insurance_expiry],
          ["Inspection", v.inspection_expiry],
          ["Road licence", v.road_licence_expiry]
        ] as [string, string | null][]) {
          if (!expiry) continue;
          const days = Math.floor((new Date(expiry).getTime() - today) / DAY);
          if (days < 0) {
            items.push({
              type: "document_expired", severity: "critical",
              title: `${v.name}: ${doc.toLowerCase()} expired`,
              detail: `Expired ${-days} day${-days === 1 ? "" : "s"} ago (${new Date(expiry).toLocaleDateString()})`,
              href: "/app/compliance", date: expiry
            });
          } else if (days <= 30) {
            items.push({
              type: "document_expiring", severity: "warning",
              title: `${v.name}: ${doc.toLowerCase()} expires in ${days} day${days === 1 ? "" : "s"}`,
              detail: `Expires ${new Date(expiry).toLocaleDateString()}`,
              href: "/app/compliance", date: expiry
            });
          }
        }
      }

      // Driver licences
      const drivers = await c.query(
        `select id, full_name, licence_expiry from drivers
         where tenant_id = $1 and deleted_at is null and licence_expiry is not null`, [req.user.tid]);
      for (const d of drivers.rows) {
        const days = Math.floor((new Date(d.licence_expiry).getTime() - today) / DAY);
        if (days < 0) {
          items.push({
            type: "document_expired", severity: "critical",
            title: `${d.full_name}: driving licence expired`,
            detail: `Expired ${-days} day${-days === 1 ? "" : "s"} ago`,
            href: "/app/compliance", date: d.licence_expiry
          });
        } else if (days <= 30) {
          items.push({
            type: "document_expiring", severity: "warning",
            title: `${d.full_name}: driving licence expires in ${days} day${days === 1 ? "" : "s"}`,
            detail: `Expires ${new Date(d.licence_expiry).toLocaleDateString()}`,
            href: "/app/compliance", date: d.licence_expiry
          });
        }
      }

      // Low stock
      const low = await c.query(
        `select id, name, quantity, min_quantity from inventory_items
         where tenant_id = $1 and deleted_at is null and quantity <= min_quantity`, [req.user.tid]);
      for (const it of low.rows) {
        items.push({
          type: "low_stock", severity: "warning",
          title: `Low stock: ${it.name}`,
          detail: `${Number(it.quantity).toLocaleString()} on hand, minimum ${Number(it.min_quantity).toLocaleString()}`,
          href: "/app/inventory", date: new Date().toISOString().slice(0, 10)
        });
      }

      // Open incidents
      const openIncidents = await c.query(
        `select id, type, severity, description from incidents
         where tenant_id = $1 and deleted_at is null and status <> 'resolved'`, [req.user.tid]);
      for (const inc of openIncidents.rows) {
        items.push({
          type: "incident_open", severity: inc.severity === "minor" ? "warning" : "critical",
          title: `Open ${inc.severity} ${inc.type}`,
          detail: inc.description,
          href: "/app/incidents", date: new Date().toISOString().slice(0, 10)
        });
      }

      // Overdue supplier expenses
      const overdueExp = await c.query(
        `select id, supplier_name, due_date, (amount - amount_paid)::float8 as balance
         from freight_expenses
         where tenant_id = $1 and deleted_at is null and status <> 'cancelled'
           and due_date < current_date and amount_paid < amount
         order by due_date`, [req.user.tid]);
      for (const r of overdueExp.rows) {
        items.push({
          type: "expense_overdue", severity: "warning",
          title: `Supplier payment overdue: ${r.supplier_name}`,
          detail: `Balance ${Number(r.balance).toLocaleString()} since ${new Date(r.due_date).toLocaleDateString()}`,
          href: "/app/cfa/ledger", date: r.due_date
        });
      }

      // Pending staff invites
      const pending = await c.query(
        `select id, full_name, email, created_at from users
         where tenant_id = $1 and deleted_at is null and status = 'pending_verification'
           and user_type = 'staff' and created_at < now() - interval '2 days'`, [req.user.tid]);
      for (const u of pending.rows) {
        items.push({
          type: "invite_pending", severity: "info",
          title: `Invite not accepted: ${u.full_name ?? u.email}`,
          detail: "Resend the invite link from the Staff page if it lapsed.",
          href: "/app/staff", date: u.created_at
        });
      }

      // Imminent departures
      const departing = await c.query(
        `select id, coalesce(reference, id::text) as label, planned_departure from trips
         where tenant_id = $1 and deleted_at is null and status = 'planned'
           and planned_departure between now() and now() + interval '48 hours'`, [req.user.tid]);
      for (const t of departing.rows) {
        items.push({
          type: "trip_departing", severity: "info",
          title: `Trip ${t.label} departs soon`,
          detail: `Planned departure ${new Date(t.planned_departure).toLocaleString()}`,
          href: "/app/trips", date: t.planned_departure
        });
      }

      // Cargo file ETAs arriving within 3 days
      const etaFiles = await c.query(
        `select id, file_number, consignee_name, eta from cargo_shipments
         where tenant_id = $1 and deleted_at is null and status = 'open'
           and eta between current_date and current_date + 3`, [req.user.tid]);
      for (const s of etaFiles.rows) {
        const days = Math.ceil((new Date(s.eta).getTime() - today) / DAY);
        items.push({
          type: "cargo_eta", severity: "info",
          title: `ETA ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}: ${s.file_number}`,
          detail: `Consignee ${s.consignee_name}`,
          href: "/app/cfa/cargo", date: s.eta
        });
      }

      // Arrived cargo files still unpaid
      const unpaidFiles = await c.query(
        `select id, file_number, consignee_name, payment_status, eta from cargo_shipments
         where tenant_id = $1 and deleted_at is null and status = 'open'
           and payment_status <> 'paid' and eta < current_date`, [req.user.tid]);
      for (const s of unpaidFiles.rows) {
        items.push({
          type: "cargo_payment", severity: "warning",
          title: `Payment due on file ${s.file_number}`,
          detail: `${s.consignee_name} — ${s.payment_status.replace("_", " ")} since arrival`,
          href: "/app/cfa/cargo", date: s.eta
        });
      }

      // Task deadlines (due today/soon) and overdue tasks
      const dueTasks = await c.query(
        `select k.id, k.title, k.due_date, s.file_number
         from cargo_tasks k join cargo_shipments s on s.id = k.shipment_id
         where k.tenant_id = $1 and k.status = 'pending' and k.due_date is not null
           and k.due_date <= current_date + 2`, [req.user.tid]);
      for (const t of dueTasks.rows) {
        const days = Math.floor((new Date(t.due_date).getTime() - today) / DAY);
        items.push({
          type: "task_deadline", severity: days < 0 ? "critical" : "warning",
          title: days < 0
            ? `Task overdue: ${t.title}`
            : `Task due ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}: ${t.title}`,
          detail: `File ${t.file_number}`,
          href: "/app/cfa/cargo", date: t.due_date
        });
      }

      const rank = { critical: 0, warning: 1, info: 2 };
      items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.date.localeCompare(b.date));

      return {
        items,
        counts: {
          critical: items.filter(i => i.severity === "critical").length,
          warning: items.filter(i => i.severity === "warning").length,
          info: items.filter(i => i.severity === "info").length,
          total: items.length
        }
      };
    });
  });
}
