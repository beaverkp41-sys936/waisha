import type { FastifyInstance } from "fastify";
import { withTenant } from "../db/pool.js";
import { verifyAccessToken } from "../security/jwt.js";
import { ApiError } from "../util/errors.js";
import { namesMatch } from "../util/name-match.js";

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

const COST_CATEGORY_LABELS: Record<string, string> = {
  allowance: "Allowances", meals: "Meals & refreshments", utilities: "Utilities",
  rent: "Rent", transport: "Transport", supplies: "Supplies",
  communication: "Communication", other: "Other"
};

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
      // pg DATE columns arrive at local midnight, so count days from the start
      // of today — otherwise a date falling today reads as a negative fraction.
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const today = startOfToday.getTime();

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
              title: `${v.name}: ${doc.toLowerCase()} ${days === 0 ? "expires today" : `expires in ${days} day${days === 1 ? "" : "s"}`}`,
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
            title: `${d.full_name}: driving licence ${days === 0 ? "expires today" : `expires in ${days} day${days === 1 ? "" : "s"}`}`,
            detail: `Expires ${new Date(d.licence_expiry).toLocaleDateString()}`,
            href: "/app/compliance", date: d.licence_expiry
          });
        }
      }

      // Regulatory licences (TRA, BRELA, TPA and bond permits)
      const licences = await c.query(
        `select id, authority, title, expiry_date from regulatory_licences
         where tenant_id = $1 and deleted_at is null`, [req.user.tid]);
      for (const l of licences.rows) {
        const days = Math.floor((new Date(l.expiry_date).getTime() - today) / DAY);
        if (days < 0) {
          items.push({
            type: "licence_expired", severity: "critical",
            title: `${l.title} expired`,
            detail: `${l.authority.toUpperCase()} licence expired ${-days} day${-days === 1 ? "" : "s"} ago (${new Date(l.expiry_date).toLocaleDateString()})`,
            href: "/app/cfa/compliance", date: l.expiry_date
          });
        } else if (days <= 30) {
          items.push({
            type: "licence_expiring", severity: "warning",
            title: `${l.title} ${days === 0 ? "expires today" : `expires in ${days} day${days === 1 ? "" : "s"}`}`,
            detail: `${l.authority.toUpperCase()} — renew before ${new Date(l.expiry_date).toLocaleDateString()}`,
            href: "/app/cfa/compliance", date: l.expiry_date
          });
        }
      }

      // Watchlist screening hits on open cargo files
      const watch = await c.query(
        `select id, party_name, severity from screening_entries
         where tenant_id = $1 and deleted_at is null and status = 'active'`, [req.user.tid]);
      if (watch.rowCount) {
        const openFiles = await c.query(
          `select id, file_number, consignee_name, consignor_name from cargo_shipments
           where tenant_id = $1 and deleted_at is null and status = 'open'`, [req.user.tid]);
        for (const f of openFiles.rows) {
          const hits = [
            ...watch.rows.filter((w: any) => namesMatch(f.consignee_name, w.party_name))
              .map((w: any) => `consignee ${f.consignee_name} → ${w.party_name}`),
            ...watch.rows.filter((w: any) => namesMatch(f.consignor_name, w.party_name))
              .map((w: any) => `consignor ${f.consignor_name} → ${w.party_name}`)
          ];
          if (hits.length) {
            const high = watch.rows.some((w: any) =>
              w.severity === "high" &&
              (namesMatch(f.consignee_name, w.party_name) || namesMatch(f.consignor_name, w.party_name)));
            items.push({
              type: "screening_hit", severity: high ? "critical" : "warning",
              title: `Screening hit on cargo file ${f.file_number}`,
              detail: hits.join("; "),
              href: "/app/cfa/compliance", date: new Date().toISOString().slice(0, 10)
            });
          }
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

      // Employment contract renewals
      const contracts = await c.query(
        `select id, full_name, employment_type, contract_end from employees
         where tenant_id = $1 and deleted_at is null and status = 'active'
           and contract_end is not null`, [req.user.tid]);
      for (const e of contracts.rows) {
        const days = Math.floor((new Date(e.contract_end).getTime() - today) / DAY);
        const kind = e.employment_type === "intern" ? "Internship" : "Contract";
        if (days < 0) {
          items.push({
            type: "contract_ended", severity: "critical",
            title: `${e.full_name}: ${kind.toLowerCase()} ended`,
            detail: `${kind} ended ${-days} day${-days === 1 ? "" : "s"} ago — renew or close`,
            href: "/app/office/employees", date: e.contract_end
          });
        } else if (days <= 30) {
          items.push({
            type: "contract_expiring", severity: "warning",
            title: `${e.full_name}: ${kind.toLowerCase()} ${days === 0 ? "ends today" : `ends in ${days} day${days === 1 ? "" : "s"}`}`,
            detail: `Renewal due ${new Date(e.contract_end).toLocaleDateString()}`,
            href: "/app/office/employees", date: e.contract_end
          });
        }
      }

      // Office task deadlines
      const officeDue = await c.query(
        `select t.id, t.title, t.due_date, e.full_name from office_tasks t
         join employees e on e.id = t.employee_id
         where t.tenant_id = $1 and t.status in ('pending','in_progress') and t.due_date is not null
           and t.due_date <= current_date + 2`, [req.user.tid]);
      for (const t of officeDue.rows) {
        const days = Math.floor((new Date(t.due_date).getTime() - today) / DAY);
        items.push({
          type: "task_deadline", severity: days < 0 ? "critical" : "warning",
          title: days < 0
            ? `Task overdue: ${t.title}`
            : `Task due ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}: ${t.title}`,
          detail: `Assigned to ${t.full_name}`,
          href: "/app/office/employees", date: t.due_date
        });
      }

      // Office costs awaiting approval
      const pendingCosts = await c.query(
        `select count(*)::int as n,
                coalesce(sum(amount), 0)::float8 as total,
                count(*) filter (where created_at < now() - interval '7 days')::int as stale
         from office_costs
         where tenant_id = $1 and deleted_at is null and status = 'pending'`, [req.user.tid]);
      const pc = pendingCosts.rows[0];
      if (pc && Number(pc.n) > 0) {
        items.push({
          type: "office_cost_pending",
          severity: Number(pc.stale) > 0 ? "warning" : "info",
          title: `${pc.n} office cost${Number(pc.n) === 1 ? "" : "s"} awaiting approval`,
          detail: `Total ${Number(pc.total).toLocaleString()} to review`,
          href: "/app/office/costs", date: new Date().toISOString().slice(0, 10)
        });
      }

      // Current-month office budgets against approved spend
      const budgets = await c.query(
        `select b.category, b.amount::float8 as budget,
                coalesce(sum(c.amount) filter (where c.status = 'approved'), 0)::float8 as spent
         from office_budgets b
         left join office_costs c
           on c.tenant_id = b.tenant_id and c.category = b.category and c.deleted_at is null
           and c.cost_date >= b.period and c.cost_date < (b.period + interval '1 month')
         where b.tenant_id = $1 and b.deleted_at is null
           and b.period = date_trunc('month', current_date)::date
         group by b.id`, [req.user.tid]);
      for (const b of budgets.rows) {
        const budget = Number(b.budget);
        const spent = Number(b.spent);
        if (budget <= 0) continue;
        const label = COST_CATEGORY_LABELS[b.category] ?? b.category;
        if (spent > budget) {
          items.push({
            type: "office_budget_over", severity: "critical",
            title: `Office budget exceeded: ${label}`,
            detail: `Spent ${spent.toLocaleString()} of ${budget.toLocaleString()} this month`,
            href: "/app/office/costs", date: new Date().toISOString().slice(0, 10)
          });
        } else if (spent >= budget * 0.9) {
          items.push({
            type: "office_budget_near", severity: "warning",
            title: `Office budget nearly used: ${label}`,
            detail: `Spent ${spent.toLocaleString()} of ${budget.toLocaleString()} this month`,
            href: "/app/office/costs", date: new Date().toISOString().slice(0, 10)
          });
        }
      }

      // Job pipeline: blocked stages and the real clocks on a file — container
      // free days, ETA, transit permit validity.
      const blockedStages = await c.query(
        `select g.name, g.blocked_reason, g.updated_at, s.file_number, j.id as job_id
           from job_stages g
           join jobs j on j.id = g.job_id and j.status = 'open' and j.deleted_at is null
           join cargo_shipments s on s.id = j.shipment_id and s.deleted_at is null
          where g.tenant_id = $1 and g.deleted_at is null and g.status = 'blocked'
          order by g.updated_at desc limit 12`, [req.user.tid]);
      for (const b of blockedStages.rows) {
        items.push({
          type: "job_stage_blocked", severity: "warning",
          title: `File ${b.file_number} blocked at ${b.name.toLowerCase()}`,
          detail: b.blocked_reason ?? "No reason recorded",
          href: `/app/jobs/${b.job_id}`, date: new Date(b.updated_at).toISOString().slice(0, 10)
        });
      }

      const jobTasks = await c.query(
        `select k.title, k.due_date, s.file_number, j.id as job_id,
                coalesce(u.full_name, 'Unassigned') as assignee
           from cargo_tasks k
           join jobs j on j.shipment_id = k.shipment_id and j.status = 'open' and j.deleted_at is null
           join cargo_shipments s on s.id = k.shipment_id and s.deleted_at is null
           left join users u on u.id = k.assigned_to
          where k.tenant_id = $1 and k.status = 'pending'
            and k.due_date is not null and k.due_date <= current_date + 1
          order by k.due_date limit 12`, [req.user.tid]);
      for (const t of jobTasks.rows) {
        const days = Math.floor((new Date(t.due_date).getTime() - today) / DAY);
        items.push({
          type: "job_task_deadline", severity: days < 0 ? "critical" : "warning",
          title: days < 0
            ? `File ${t.file_number}: task overdue ${-days} day${-days === 1 ? "" : "s"} — ${t.title}`
            : `File ${t.file_number}: task due ${days === 0 ? "today" : `tomorrow`} — ${t.title}`,
          detail: `Assigned to ${t.assignee}`,
          href: `/app/jobs/${t.job_id}`, date: t.due_date
        });
      }

      const jobClocks = await c.query(
        `select * from (
           select j.id as job_id, s.file_number, 'free_days' as kind,
                  (j.free_days_start + j.free_days) as due_on
             from jobs j join cargo_shipments s on s.id = j.shipment_id and s.deleted_at is null
            where j.tenant_id = $1 and j.deleted_at is null and j.status = 'open'
              and j.free_days is not null and j.free_days_start is not null
              and (j.free_days_start + j.free_days) <= current_date + 3
         union all
           select j.id, s.file_number, 'eta', s.eta
             from jobs j join cargo_shipments s on s.id = j.shipment_id and s.deleted_at is null
            where j.tenant_id = $1 and j.deleted_at is null and j.status = 'open'
              and s.eta is not null and s.eta <= current_date + 3
         union all
           select d.job_id, s.file_number, 'permit', d.doc_date
             from job_documents d
             join jobs j on j.id = d.job_id and j.status = 'open' and j.deleted_at is null
             join cargo_shipments s on s.id = j.shipment_id and s.deleted_at is null
            where d.tenant_id = $1 and d.deleted_at is null and d.kind = 'permit'
              and d.doc_date is not null and d.doc_date <= current_date + 7
         ) x where x.due_on is not null order by x.due_on limit 12`, [req.user.tid]);
      const clockLabels: Record<string, string> = {
        free_days: "container free days end", eta: "vessel / flight ETA", permit: "transit permit expires"
      };
      for (const k of jobClocks.rows) {
        const days = Math.floor((new Date(k.due_on).getTime() - today) / DAY);
        items.push({
          type: `job_${k.kind}`, severity: days < 0 ? "critical" : "warning",
          title: `File ${k.file_number}: ${clockLabels[k.kind]} ${
            days < 0 ? `passed ${-days} day${-days === 1 ? "" : "s"} ago`
              : days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`,
          detail: k.kind === "free_days"
            ? "Demurrage starts accruing after this date"
            : k.kind === "eta" ? "Arrival handling steps should be ready" : "Renew before the cargo moves",
          href: `/app/jobs/${k.job_id}`, date: k.due_on
        });
      }

      const rank = { critical: 0, warning: 1, info: 2 };
      const pad = (n: number) => String(n).padStart(2, "0");
      // pg DATE columns arrive as JS Dates at local midnight; normalise to day
      // strings so mixed Date/string sources can be compared.
      const dayKey = (v: unknown) =>
        v instanceof Date
          ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
          : String(v ?? "");
      items.sort((a, b) => rank[a.severity] - rank[b.severity] || dayKey(a.date).localeCompare(dayKey(b.date)));

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
