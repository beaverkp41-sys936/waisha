import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
  /**
   * Stable, content-addressed identity for the alert. Read state (alert_reads)
   * keys off this, so it must change whenever the underlying alert materially
   * changes — a new hold, a new booking, a rescheduled deadline — and must NOT
   * change while the same event stands. Entity alerts use the row id; clocks
   * and holds append the stamp that defines the event.
   */
  key: string;
  type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  href: string;
  date: string;
  seen?: boolean;
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** pg DATE columns arrive as JS Dates at local midnight; normalise to day strings. */
const dayKey = (v: unknown) =>
  v instanceof Date
    ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
    : String(v ?? "");
/** Full ISO identity for timestamptz stamps used in keys. */
const isoOf = (v: unknown) => (v ? new Date(v as any).toISOString() : "");

const COST_CATEGORY_LABELS: Record<string, string> = {
  allowance: "Allowances", meals: "Meals & refreshments", utilities: "Utilities",
  rent: "Rent", transport: "Transport", supplies: "Supplies",
  communication: "Communication", other: "Other"
};

/**
 * Alerts are computed live from real signals — nothing is stored, so there
 * is no write-sync to drift. Sources: overdue invoices, expiring vessel and
 * driver documents, low stock, open incidents, overdue supplier expenses,
 * pending staff invites and imminent departures. Read state is the ONE thing
 * that is stored, per user, in alert_reads (migration 050) — keyed by the
 * stable `key` each item carries.
 */
async function buildAlerts(c: any, tenantId: string): Promise<Notification[]> {
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
     order by due_date`, [tenantId]);
  for (const r of overdueInv.rows) {
    const days = Math.floor((today - new Date(r.due_date).getTime()) / DAY);
    items.push({
      key: `invoice_overdue:${r.id}`,
      type: "invoice_overdue", severity: "critical",
      title: `Invoice ${r.invoice_number} overdue ${days} day${days === 1 ? "" : "s"}`,
      detail: `${r.customer_name} owes ${Number(r.balance).toLocaleString()}`,
      href: "/app/cfa/invoices", date: r.due_date
    });
  }

  // Vessel documents (insurance, inspection, road licence)
  const vessels = await c.query(
    `select id, name, insurance_expiry, inspection_expiry, road_licence_expiry
     from vessels where tenant_id = $1 and deleted_at is null`, [tenantId]);
  for (const v of vessels.rows) {
    for (const [doc, slug, expiry] of [
      ["Insurance", "insurance", v.insurance_expiry],
      ["Inspection", "inspection", v.inspection_expiry],
      ["Road licence", "road_licence", v.road_licence_expiry]
    ] as [string, string, string | null][]) {
      if (!expiry) continue;
      const days = Math.floor((new Date(expiry).getTime() - today) / DAY);
      const state = days < 0 ? "expired" : "expiring";
      if (days < 0) {
        items.push({
          key: `document:vessel:${v.id}:${slug}:${state}`,
          type: "document_expired", severity: "critical",
          title: `${v.name}: ${doc.toLowerCase()} expired`,
          detail: `Expired ${-days} day${-days === 1 ? "" : "s"} ago (${new Date(expiry).toLocaleDateString()})`,
          href: "/app/compliance", date: expiry
        });
      } else if (days <= 30) {
        items.push({
          key: `document:vessel:${v.id}:${slug}:${state}`,
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
     where tenant_id = $1 and deleted_at is null and licence_expiry is not null`, [tenantId]);
  for (const d of drivers.rows) {
    const days = Math.floor((new Date(d.licence_expiry).getTime() - today) / DAY);
    const state = days < 0 ? "expired" : "expiring";
    if (days < 0) {
      items.push({
        key: `document:driver:${d.id}:licence:${state}`,
        type: "document_expired", severity: "critical",
        title: `${d.full_name}: driving licence expired`,
        detail: `Expired ${-days} day${-days === 1 ? "" : "s"} ago`,
        href: "/app/compliance", date: d.licence_expiry
      });
    } else if (days <= 30) {
      items.push({
        key: `document:driver:${d.id}:licence:${state}`,
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
     where tenant_id = $1 and deleted_at is null`, [tenantId]);
  for (const l of licences.rows) {
    const days = Math.floor((new Date(l.expiry_date).getTime() - today) / DAY);
    const state = days < 0 ? "expired" : "expiring";
    if (days < 0) {
      items.push({
        key: `licence:${l.id}:${state}`,
        type: "licence_expired", severity: "critical",
        title: `${l.title} expired`,
        detail: `${l.authority.toUpperCase()} licence expired ${-days} day${-days === 1 ? "" : "s"} ago (${new Date(l.expiry_date).toLocaleDateString()})`,
        href: "/app/cfa/compliance", date: l.expiry_date
      });
    } else if (days <= 30) {
      items.push({
        key: `licence:${l.id}:${state}`,
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
     where tenant_id = $1 and deleted_at is null and status = 'active'`, [tenantId]);
  if (watch.rowCount) {
    const openFiles = await c.query(
      `select id, file_number, consignee_name, consignor_name from cargo_shipments
       where tenant_id = $1 and deleted_at is null and status = 'open'`, [tenantId]);
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
          key: `screening:${f.id}:${hits.length}`,
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
     where tenant_id = $1 and deleted_at is null and quantity <= min_quantity`, [tenantId]);
  for (const it of low.rows) {
    items.push({
      key: `low_stock:${it.id}`,
      type: "low_stock", severity: "warning",
      title: `Low stock: ${it.name}`,
      detail: `${Number(it.quantity).toLocaleString()} on hand, minimum ${Number(it.min_quantity).toLocaleString()}`,
      href: "/app/inventory", date: new Date().toISOString().slice(0, 10)
    });
  }

  // Open incidents
  const openIncidents = await c.query(
    `select id, type, severity, description from incidents
     where tenant_id = $1 and deleted_at is null and status <> 'resolved'`, [tenantId]);
  for (const inc of openIncidents.rows) {
    items.push({
      key: `incident:${inc.id}`,
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
     order by due_date`, [tenantId]);
  for (const r of overdueExp.rows) {
    items.push({
      key: `expense_overdue:${r.id}`,
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
       and user_type = 'staff' and created_at < now() - interval '2 days'`, [tenantId]);
  for (const u of pending.rows) {
    items.push({
      key: `invite:${u.id}`,
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
       and planned_departure between now() and now() + interval '48 hours'`, [tenantId]);
  for (const t of departing.rows) {
    items.push({
      key: `trip_departing:${t.id}`,
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
       and eta between current_date and current_date + 3`, [tenantId]);
  for (const s of etaFiles.rows) {
    const days = Math.ceil((new Date(s.eta).getTime() - today) / DAY);
    items.push({
      key: `cargo_eta:${s.id}`,
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
       and payment_status <> 'paid' and eta < current_date`, [tenantId]);
  for (const s of unpaidFiles.rows) {
    items.push({
      key: `cargo_payment:${s.id}`,
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
       and k.due_date <= current_date + 2`, [tenantId]);
  for (const t of dueTasks.rows) {
    const days = Math.floor((new Date(t.due_date).getTime() - today) / DAY);
    items.push({
      key: `cargo_task:${t.id}:${dayKey(t.due_date)}`,
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
       and contract_end is not null`, [tenantId]);
  for (const e of contracts.rows) {
    const days = Math.floor((new Date(e.contract_end).getTime() - today) / DAY);
    const kind = e.employment_type === "intern" ? "Internship" : "Contract";
    if (days < 0) {
      items.push({
        key: `contract:${e.id}:${dayKey(e.contract_end)}`,
        type: "contract_ended", severity: "critical",
        title: `${e.full_name}: ${kind.toLowerCase()} ended`,
        detail: `${kind} ended ${-days} day${-days === 1 ? "" : "s"} ago — renew or close`,
        href: "/app/office/employees", date: e.contract_end
      });
    } else if (days <= 30) {
      items.push({
        key: `contract:${e.id}:${dayKey(e.contract_end)}`,
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
       and t.due_date <= current_date + 2`, [tenantId]);
  for (const t of officeDue.rows) {
    const days = Math.floor((new Date(t.due_date).getTime() - today) / DAY);
    items.push({
      key: `office_task:${t.id}:${dayKey(t.due_date)}`,
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
     where tenant_id = $1 and deleted_at is null and status = 'pending'`, [tenantId]);
  const pc = pendingCosts.rows[0];
  if (pc && Number(pc.n) > 0) {
    items.push({
      key: `office_cost_pending:${pc.n}:${pc.stale}`,
      type: "office_cost_pending",
      severity: Number(pc.stale) > 0 ? "warning" : "info",
      title: `${pc.n} office cost${Number(pc.n) === 1 ? "" : "s"} awaiting approval`,
      detail: `Total ${Number(pc.total).toLocaleString()} to review`,
      href: "/app/office/costs", date: new Date().toISOString().slice(0, 10)
    });
  }

  // Current-month office budgets against approved spend
  const budgets = await c.query(
    `select b.id, b.category, b.period, b.amount::float8 as budget,
            coalesce(sum(c.amount) filter (where c.status = 'approved'), 0)::float8 as spent
     from office_budgets b
     left join office_costs c
       on c.tenant_id = b.tenant_id and c.category = b.category and c.deleted_at is null
       and c.cost_date >= b.period and c.cost_date < (b.period + interval '1 month')
     where b.tenant_id = $1 and b.deleted_at is null
       and b.period = date_trunc('month', current_date)::date
     group by b.id`, [tenantId]);
  for (const b of budgets.rows) {
    const budget = Number(b.budget);
    const spent = Number(b.spent);
    if (budget <= 0) continue;
    const label = COST_CATEGORY_LABELS[b.category] ?? b.category;
    if (spent > budget) {
      items.push({
        key: `office_budget:${b.id}:${dayKey(b.period)}:over`,
        type: "office_budget_over", severity: "critical",
        title: `Office budget exceeded: ${label}`,
        detail: `Spent ${spent.toLocaleString()} of ${budget.toLocaleString()} this month`,
        href: "/app/office/costs", date: new Date().toISOString().slice(0, 10)
      });
    } else if (spent >= budget * 0.9) {
      items.push({
        key: `office_budget:${b.id}:${dayKey(b.period)}:near`,
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
    `select g.id, g.name, g.blocked_reason, g.updated_at, s.file_number, j.id as job_id
       from job_stages g
       join jobs j on j.id = g.job_id and j.status = 'open' and j.deleted_at is null
       join cargo_shipments s on s.id = j.shipment_id and s.deleted_at is null
      where g.tenant_id = $1 and g.deleted_at is null and g.status = 'blocked'
      order by g.updated_at desc limit 12`, [tenantId]);
  for (const b of blockedStages.rows) {
    items.push({
      key: `job_blocked:${b.id}`,
      type: "job_stage_blocked", severity: "warning",
      title: `File ${b.file_number} blocked at ${b.name.toLowerCase()}`,
      detail: b.blocked_reason ?? "No reason recorded",
      href: `/app/jobs/${b.job_id}`, date: new Date(b.updated_at).toISOString().slice(0, 10)
    });
  }

  const jobTasks = await c.query(
    `select k.id, k.title, k.due_date, s.file_number, j.id as job_id,
            coalesce(u.full_name, 'Unassigned') as assignee
       from cargo_tasks k
       join jobs j on j.shipment_id = k.shipment_id and j.status = 'open' and j.deleted_at is null
       join cargo_shipments s on s.id = k.shipment_id and s.deleted_at is null
       left join users u on u.id = k.assigned_to
      where k.tenant_id = $1 and k.status = 'pending'
        and k.due_date is not null and k.due_date <= current_date + 1
      order by k.due_date limit 12`, [tenantId]);
  for (const t of jobTasks.rows) {
    const days = Math.floor((new Date(t.due_date).getTime() - today) / DAY);
    items.push({
      key: `job_task:${t.id}:${dayKey(t.due_date)}`,
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
     ) x where x.due_on is not null order by x.due_on limit 12`, [tenantId]);
  const clockLabels: Record<string, string> = {
    free_days: "container free days end", eta: "vessel / flight ETA", permit: "transit permit expires"
  };
  for (const k of jobClocks.rows) {
    const days = Math.floor((new Date(k.due_on).getTime() - today) / DAY);
    items.push({
      key: `job_clock:${k.job_id}:${k.kind}:${dayKey(k.due_on)}`,
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

  // Bookings on the publisher's own requests: a hold runs on a 12h clock,
  // so the countdown is the alert. Confirmed bookings stay visible too.
  const holds = await c.query(
    `select t.id, t.status, t.booked_company_name, t.booked_contact_name,
            t.booked_contact_channel, t.temp_booked_at, t.reminder_sent_at, t.confirmed_at
       from transport_requests t
      where t.tenant_id = $1 and t.deleted_at is null
        and t.status in ('temp_booked','confirmed')`, [tenantId]);
  for (const h of holds.rows) {
    if (h.status === "temp_booked") {
      const deadline = new Date(h.temp_booked_at).getTime() + 12 * 3_600_000;
      const leftMs = Math.max(0, deadline - Date.now());
      const leftH = Math.floor(leftMs / 3_600_000);
      const leftM = Math.floor((leftMs % 3_600_000) / 60_000);
      items.push({
        key: `booking_hold:${h.id}:${isoOf(h.temp_booked_at)}`,
        type: "booking_hold",
        severity: leftMs <= 2 * 3_600_000 ? "critical" : "warning",
        title: `Confirm within ${leftH}h ${pad(leftM)}m — ${h.booked_company_name} is holding a load`,
        detail: `${h.booked_contact_name} · ${h.booked_contact_channel} · auto-releases at ` +
          `${new Date(deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` +
          (h.reminder_sent_at ? " · 6h reminder sent" : ""),
        href: "/app/cfa/jobs", date: h.temp_booked_at
      });
    } else {
      items.push({
        key: `booking_confirmed:${h.id}:${isoOf(h.confirmed_at)}`,
        type: "booking_confirmed", severity: "info",
        title: `Booking confirmed — ${h.booked_company_name} will move the load`,
        detail: `Contact ${h.booked_contact_name} on ${h.booked_contact_channel}`,
        href: "/app/cfa/jobs", date: h.confirmed_at
      });
    }
  }

  // Holds that ended recently: the load is open to every company again.
  const backOnBoard = await c.query(
    `select id, booked_company_name, released_at from transport_requests
      where tenant_id = $1 and deleted_at is null and status = 'open'
        and released_at > now() - interval '7 days'`, [tenantId]);
  for (const r of backOnBoard.rows) {
    items.push({
      key: `booking_released:${r.id}:${isoOf(r.released_at)}`,
      type: "booking_released", severity: "info",
      title: "A load is back on the board",
      detail: `${r.booked_company_name ?? "A transporter"}'s hold ended ` +
        `${new Date(r.released_at).toLocaleString()} — other companies can book it again.`,
      href: "/app/cfa/jobs", date: r.released_at
    });
  }

  // The booker's side, from their own booking rows. Self-releases are
  // skipped — you do not need an alert for something you just did.
  const myBookings = await c.query(
    `select b.id, b.status, b.cargo_label, b.dest_text, b.company_name, b.ended_reason,
            b.temp_booked_at, b.confirmed_at, b.ended_at,
            not exists (select 1 from users u
                         where u.id = b.ended_by and u.tenant_id = b.tenant_id) as ended_by_other
       from transport_bookings b
      where b.tenant_id = $1 and b.deleted_at is null
        and b.created_at > now() - interval '30 days'`, [tenantId]);
  const lane = (b: any) => `${b.cargo_label} → ${b.dest_text}`;
  for (const b of myBookings.rows) {
    if (b.status === "temp_booked") {
      const deadline = new Date(b.temp_booked_at).getTime() + 12 * 3_600_000;
      const leftMs = Math.max(0, deadline - Date.now());
      items.push({
        key: `booking_mine_hold:${b.id}`,
        type: "booking_mine_hold",
        severity: leftMs <= 2 * 3_600_000 ? "warning" : "info",
        title: `You are holding the load: ${lane(b)}`,
        detail: `${b.company_name} has until ` +
          `${new Date(deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ` +
          "to confirm, or it goes back on the board.",
        href: "/app/board", date: b.temp_booked_at
      });
    } else if (b.status === "confirmed") {
      items.push({
        key: `booking_mine_confirmed:${b.id}`,
        type: "booking_mine_confirmed", severity: "info",
        title: `Booking confirmed by ${b.company_name}: ${lane(b)}`,
        detail: "You can release it from My bookings if plans change.",
        href: "/app/board", date: b.confirmed_at
      });
    } else if (b.status === "rejected") {
      items.push({
        key: `booking_mine_rejected:${b.id}`,
        type: "booking_mine_rejected", severity: "warning",
        title: `Declined by ${b.company_name}: ${lane(b)}`,
        detail: b.ended_reason ? `Reason: ${b.ended_reason}` : "The hold was declined.",
        href: "/app/board", date: b.ended_at
      });
    } else if (b.status === "expired") {
      items.push({
        key: `booking_mine_expired:${b.id}`,
        type: "booking_mine_expired", severity: "warning",
        title: `Hold expired: ${lane(b)}`,
        detail: "No confirmation came within 12 hours — the load went back on the board.",
        href: "/app/board", date: b.ended_at
      });
    } else if (b.status === "cancelled" && b.ended_by_other) {
      items.push({
        key: `booking_mine_cancelled:${b.id}`,
        type: "booking_mine_cancelled", severity: "warning",
        title: `Booking cancelled by ${b.company_name}: ${lane(b)}`,
        detail: b.ended_reason ? `Reason: ${b.ended_reason}` : "The booking was cancelled.",
        href: "/app/board", date: b.ended_at
      });
    }
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity] || dayKey(a.date).localeCompare(dayKey(b.date)));
  return items;
}

/** Marking read is idempotent by PK; bounded so a rogue call cannot swell the table. */
const readSchema = z.object({
  keys: z.array(z.string().trim().min(2).max(200)).min(1).max(500).optional(),
  all: z.boolean().optional()
}).strict().refine(
  (b) => b.all === true || (b.keys?.length ?? 0) > 0,
  { message: "Send all: true, or the keys to mark as seen.", path: ["keys"] }
);

export async function notificationsRoutes(app: FastifyInstance, _opts: unknown) {
  app.get("/notifications", { preHandler: [requireAuth] }, async (req: any) => {
    return withTenant(req.user.tid, async (c) => {
      const items = await buildAlerts(c, req.user.tid);
      const reads = await c.query(
        `select alert_key from alert_reads where user_id = $1 and tenant_id = $2`,
        [req.user.sub, req.user.tid]);
      const seen = new Set<string>(reads.rows.map((r: any) => r.alert_key as string));
      const marked = items.map((i) => ({ ...i, seen: seen.has(i.key) }));
      return {
        items: marked,
        counts: {
          critical: marked.filter(i => i.severity === "critical").length,
          warning: marked.filter(i => i.severity === "warning").length,
          info: marked.filter(i => i.severity === "info").length,
          total: marked.length,
          unread: marked.filter(i => !i.seen).length
        }
      };
    });
  });

  // Mark alerts as seen. Keys reference the derived feed, so unknown keys are
  // harmless — the row just sits there unread-adjacent until the same alert
  // re-appears (or never). No delete path: dismissal state is append-only in
  // spirit, and PK-idempotent.
  app.post("/notifications/read", { preHandler: [requireAuth] }, async (req: any) => {
    const body = readSchema.parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      const keys = body.all
        ? (await buildAlerts(c, req.user.tid)).map((i) => i.key)
        : body.keys!;
      if (!keys.length) return { ok: true, marked: 0 };
      const r = await c.query(
        `insert into alert_reads (user_id, tenant_id, alert_key)
         select $1, $2, k from unnest($3::text[]) as k
         on conflict (user_id, alert_key) do nothing`,
        [req.user.sub, req.user.tid, keys]);
      return { ok: true, marked: r.rowCount ?? 0 };
    });
  });
}
