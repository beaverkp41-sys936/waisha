import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, withTenant } from "../db/pool.js";
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
const money = (n: number) => Math.round(n * 100) / 100;

/**
 * The finance desk.
 *
 * Nothing here moves money, and nothing here talks to a tax authority. The
 * dashboard foots the company's own paper; the return register puts those figures
 * into the shape a return asks for, keeps what was prepared, and records the
 * reference an accountant typed in after filing by hand.
 *
 * Four rules the whole file is built around:
 *
 *  1. **Computed figures are never accepted from a caller.** Create and edit take
 *     the period and the declared credits; the base, the charge and the invoice
 *     count are re-footed from `freight_invoices` inside the same transaction, so
 *     a return cannot be talked into a smaller liability.
 *  2. **A figure the records cannot show is labelled declared, and must come with
 *     the sentence saying where it came from.** WAISHA holds no supplier tax
 *     invoices (`freight_expenses` has a supplier, a category and a gross amount,
 *     with no tax split and no supplier TIN) and no withholding certificate from a
 *     customer, so input VAT, credits, exempt supplies and withheld VAT are typed —
 *     and the register keeps the provenance next to the number.
 *  3. **Money leaves this file as a number rounded to the cent, never as a float
 *     that came out of a JS division.** Postgres does the summing; `::text` keeps
 *     the exact decimal in transit; `money()` rounds once, at the boundary.
 *  4. **Every sum is TZS, and paper in another currency is named instead of added.**
 *     A return is denominated in one currency and this system converts nothing, so a
 *     dollar bill is counted and listed under `otherCurrencies` rather than folded
 *     into a shilling total that would look authoritative and be meaningless.
 *
 * Every statement is assembled from constants with `+`, so the SQL a `.query()`
 * receives is static and provable by the security scanner (the 072 precedent).
 */

// An issued bill is `sent`: freight_invoices keeps only draft / sent / cancelled
// (029), and paid, partial and overdue are derived from the money, not stored.
export const ISSUED_SQL = "i.deleted_at is null and i.status = 'sent'";
// A cost is owed once it is recorded; only a cancelled one stops being owed.
export const LIVE_COST_SQL = "deleted_at is null and status <> 'cancelled'";
// Every figure on this desk is TZS. A bill in another currency is named and counted
// (FOREIGN_SQL) but never added into a sum, because a return is denominated in one
// currency and the system holds no exchange-rate policy to convert one bill with.
export const IN_TZS_SQL = " and i.currency = 'TZS'";
export const COST_IN_TZS_SQL = " and currency = 'TZS'";

/**
 * Per-invoice splits from the line table, aggregated once and joined.
 *
 * A bill converted from a proforma carries its statutory charges as their own
 * section, so its taxable base is the company's own charges and the statutory line
 * is a pass-through memo. A bill typed at the desk has one headline rate over its
 * whole subtotal and no section split at all — its subtotal is the base, stated as
 * it is, and `hand_built` counts how many bills are in that weaker shape.
 */
export const LINES_AGG_SQL =
  "select invoice_id," +
  // Rated and untaxed port/transport lines are kept apart on purpose: a zero-rated
  // supply belongs on the return in the zero-rated column only. Fold it into the
  // taxable base as well and the same shilling is declared twice, once as a base
  // the VAT rate is applied to and once as a supply that owed none.
  " sum(amount) filter (where section in ('port', 'transport') and tax_kind <> 'none') as rated_base," +
  " sum(amount) filter (where section = 'statutory') as statutory_base," +
  " sum(amount) filter (where section in ('port', 'transport') and tax_kind = 'none') as untaxed_base," +
  " sum(tax_amount) filter (where tax_kind = 'excise') as excise_amount" +
  " from freight_invoice_items where tenant_id = $1 group by invoice_id";

export const POSITION_SQL =
  "with li as (" + LINES_AGG_SQL + ") " +
  "select count(*)::int as invoices," +
  " count(*) filter (where i.source_quotation_id is null)::int as hand_built," +
  " coalesce(sum(i.total), 0)::text as billed_total," +
  " coalesce(sum(i.amount_paid), 0)::text as collected_total," +
  " coalesce(sum(case when i.source_quotation_id is not null" +
  "                   then coalesce(li.rated_base, 0)" +
  "                   when i.vat_rate > 0 then i.subtotal else 0 end), 0)::text as base_amount," +
  " coalesce(sum(case when i.source_quotation_id is not null" +
  "                   then coalesce(li.statutory_base, 0) else 0 end), 0)::text as statutory_collected," +
  " coalesce(sum(case when i.source_quotation_id is not null" +
  "                   then coalesce(li.untaxed_base, 0)" +
  "                   when i.vat_rate = 0 then i.subtotal else 0 end), 0)::text as zero_rated_base," +
  " coalesce(sum(case when i.source_quotation_id is not null" +
  "                   then coalesce(li.excise_amount, 0) else 0 end), 0)::text as excise_amount," +
  " coalesce(sum(i.vat_amount), 0)::text as tax_charged" +
  " from freight_invoices i" +
  " left join li on li.invoice_id = i.id" +
  " where i.tenant_id = $1 and " + ISSUED_SQL + IN_TZS_SQL +
  " and i.issue_date between $2::date and $3::date";

export const SCHEDULE_SQL =
  "with li as (" + LINES_AGG_SQL + ") " +
  "select i.id, i.invoice_number, i.customer_name, i.customer_tin, i.currency," +
  " i.issue_date::text as issue_date, i.due_date::text as due_date," +
  " i.subtotal::text as subtotal, i.vat_rate::text as vat_rate," +
  " i.vat_amount::text as vat_amount, i.total::text as total," +
  " i.amount_paid::text as amount_paid," +
  " (i.source_quotation_id is not null) as from_proforma," +
  " case when i.source_quotation_id is not null then coalesce(li.rated_base, 0)" +
  "      when i.vat_rate > 0 then i.subtotal else 0 end::text as base_amount," +
  " case when i.source_quotation_id is not null then coalesce(li.statutory_base, 0)" +
  "      else 0 end::text as statutory_base," +
  " case when i.source_quotation_id is not null then coalesce(li.untaxed_base, 0)" +
  "      when i.vat_rate = 0 then i.subtotal else 0 end::text as untaxed_base" +
  " from freight_invoices i" +
  " left join li on li.invoice_id = i.id" +
  " where i.tenant_id = $1 and " + ISSUED_SQL + IN_TZS_SQL +
  " and i.issue_date between $2::date and $3::date" +
  " order by i.issue_date, i.invoice_number";

export const RECEIVABLE_SQL =
  "select coalesce(sum(total), 0)::text as billed," +
  " coalesce(sum(amount_paid), 0)::text as collected," +
  " coalesce(sum(total - amount_paid), 0)::text as outstanding," +
  " coalesce(sum(case when due_date is not null and due_date < current_date" +
  "                   and amount_paid < total then total - amount_paid else 0 end), 0)::text as overdue," +
  " count(*)::int as bills," +
  " count(*) filter (where due_date is not null and due_date < current_date" +
  "   and amount_paid < total)::int as overdue_count," +
  " coalesce(sum(case when due_date >= current_date then total - amount_paid else 0 end), 0)::text as age_current," +
  " coalesce(sum(case when due_date < current_date and current_date - due_date <= 30" +
  "                   then total - amount_paid else 0 end), 0)::text as age_1_30," +
  " coalesce(sum(case when due_date < current_date and current_date - due_date between 31 and 60" +
  "                   then total - amount_paid else 0 end), 0)::text as age_31_60," +
  " coalesce(sum(case when due_date < current_date and current_date - due_date between 61 and 90" +
  "                   then total - amount_paid else 0 end), 0)::text as age_61_90," +
  " coalesce(sum(case when due_date < current_date and current_date - due_date > 90" +
  "                   then total - amount_paid else 0 end), 0)::text as age_90_plus" +
  " from freight_invoices i where i.tenant_id = $1 and " + ISSUED_SQL + IN_TZS_SQL;

export const PAYABLE_SQL =
  "select coalesce(sum(amount), 0)::text as billed," +
  " coalesce(sum(amount_paid), 0)::text as paid," +
  " coalesce(sum(amount - amount_paid), 0)::text as outstanding," +
  " coalesce(sum(case when due_date is not null and due_date < current_date" +
  "                   and amount_paid < amount then amount - amount_paid else 0 end), 0)::text as overdue," +
  " count(*)::int as bills" +
  " from freight_expenses where tenant_id = $1 and " + LIVE_COST_SQL + COST_IN_TZS_SQL;

/**
 * What the desk cannot add up. A bill in another currency is owed all the same, so
 * it is counted and named here rather than dropped; it is simply never summed into a
 * TZS figure, because converting it is a policy this system does not hold.
 */
export const FOREIGN_SQL =
  "select i.currency, count(*)::int as bills," +
  " coalesce(sum(i.total), 0)::text as billed," +
  " coalesce(sum(i.total - i.amount_paid), 0)::text as outstanding" +
  " from freight_invoices i" +
  " where i.tenant_id = $1 and " + ISSUED_SQL + " and i.currency <> 'TZS'" +
  " and ($2::date is null or i.issue_date between $2::date and $3::date)" +
  " group by i.currency order by i.currency";

// There is no dated payment register for expenses — freight_expenses only carries
// `amount_paid`. So money that left is attributed to the expense's own date and
// the response says so, rather than pretending to a precision the records lack.
export const CASH_SQL =
  "select coalesce(sum(p.amount), 0)::text as inflow" +
  " from freight_invoice_payments p" +
  " join freight_invoices i on i.id = p.invoice_id and i.tenant_id = p.tenant_id" +
  " where p.tenant_id = $1 and " + ISSUED_SQL + IN_TZS_SQL +
  " and p.paid_at between $2::date and $3::date";

export const CASH_OUT_SQL =
  "select coalesce(sum(amount_paid), 0)::text as outflow" +
  " from freight_expenses" +
  " where tenant_id = $1 and " + LIVE_COST_SQL + COST_IN_TZS_SQL +
  " and expense_date between $2::date and $3::date";

export const DSO_SQL =
  "select coalesce(sum((p.paid_at - i.issue_date) * p.amount) / nullif(sum(p.amount), 0), 0)::float8 as dso," +
  " count(*)::int as payments" +
  " from freight_invoice_payments p" +
  " join freight_invoices i on i.id = p.invoice_id and i.tenant_id = p.tenant_id" +
  " where p.tenant_id = $1 and " + ISSUED_SQL + IN_TZS_SQL +
  " and p.paid_at between $2::date and $3::date" +
  " and p.paid_at >= i.issue_date";

export const TREND_SQL =
  "select to_char(date_trunc('month', i.issue_date), 'YYYY-MM') as month," +
  " coalesce(sum(i.total), 0)::text as billed," +
  " coalesce(sum(i.vat_amount), 0)::text as vat" +
  " from freight_invoices i" +
  " where i.tenant_id = $1 and " + ISSUED_SQL + IN_TZS_SQL +
  " and i.issue_date between $2::date and $3::date" +
  " group by 1";

export const SPEND_SQL =
  "select to_char(date_trunc('month', expense_date), 'YYYY-MM') as month," +
  " coalesce(sum(amount), 0)::text as value" +
  " from freight_expenses" +
  " where tenant_id = $1 and " + LIVE_COST_SQL + COST_IN_TZS_SQL +
  " and expense_date between $2::date and $3::date" +
  " group by 1";

export const CUSTOMERS_SQL =
  "select i.customer_name, coalesce(max(i.customer_tin), '') as customer_tin," +
  " count(*)::int as invoices, coalesce(sum(i.total), 0)::text as billed," +
  " coalesce(sum(i.total - i.amount_paid), 0)::text as outstanding," +
  " coalesce(sum(i.vat_amount), 0)::text as vat" +
  " from freight_invoices i" +
  " where i.tenant_id = $1 and " + ISSUED_SQL + IN_TZS_SQL +
  " and i.issue_date between $2::date and $3::date" +
  " group by i.customer_name" +
  " order by sum(i.total - i.amount_paid) desc, sum(i.total) desc" +
  " limit 8";

export const SUPPLIERS_SQL =
  "select supplier_name, count(*)::int as bills," +
  " coalesce(sum(amount), 0)::text as billed," +
  " coalesce(sum(amount - amount_paid), 0)::text as outstanding," +
  " coalesce(max(category), '') as top_category" +
  " from freight_expenses" +
  " where tenant_id = $1 and " + LIVE_COST_SQL + COST_IN_TZS_SQL +
  " and expense_date between $2::date and $3::date" +
  " group by supplier_name" +
  " order by sum(amount) desc" +
  " limit 8";

interface Position {
  invoices: number;
  handBuilt: number;
  baseAmount: number;
  zeroRatedBase: number;
  taxCharged: number;
  statutoryCollected: number;
  exciseAmount: number;
  billedTotal: number;
  collectedTotal: number;
}

function toPosition(r: any): Position {
  return {
    invoices: Number(r.invoices),
    handBuilt: Number(r.hand_built),
    baseAmount: money(Number(r.base_amount)),
    zeroRatedBase: money(Number(r.zero_rated_base)),
    taxCharged: money(Number(r.tax_charged)),
    statutoryCollected: money(Number(r.statutory_collected)),
    exciseAmount: money(Number(r.excise_amount)),
    billedTotal: money(Number(r.billed_total)),
    collectedTotal: money(Number(r.collected_total))
  };
}

const EMPTY_POSITION: Position = {
  invoices: 0, handBuilt: 0, baseAmount: 0, zeroRatedBase: 0, taxCharged: 0,
  statutoryCollected: 0, exciseAmount: 0, billedTotal: 0, collectedTotal: 0
};

/**
 * Foot the return's own figures for one period. $1 tenant, $2 from, $3 to.
 *
 * A statutory-charges return accounts for the pass-through itself, so its charge is
 * the statutory section and it has no taxable base of its own; a VAT return
 * accounts for the VAT and shows the pass-through as a memo beside it.
 */
async function footPosition(c: PoolClient, tenantId: string, from: string, to: string, kind: string) {
  // A withheld-VAT return has nothing to foot: the system holds no certificate of
  // withholding and cannot tell which customers are withholding agents, so footing
  // its own VAT and calling it withheld would be a claim the records do not make.
  if (kind === "withholding_vat") return { ...EMPTY_POSITION };
  const res = await c.query(POSITION_SQL, [tenantId, from, to]);
  const p = toPosition(res.rows[0]);
  const statutory = kind === "statutory_charges";
  return {
    ...p,
    taxCharged: money(statutory ? p.statutoryCollected : p.taxCharged),
    baseAmount: money(statutory ? 0 : p.baseAmount)
  };
}

async function schedule(c: PoolClient, tenantId: string, from: string, to: string) {
  const res = await c.query(SCHEDULE_SQL, [tenantId, from, to]);
  return res.rows.map((r: any) => ({
    ...r,
    base_amount: money(Number(r.base_amount)),
    statutory_base: money(Number(r.statutory_base)),
    untaxed_base: money(Number(r.untaxed_base))
  }));
}

export const RATES_VERSION_SQL =
  "select version, effective_from::text as effective_from, effective_to::text as effective_to" +
  " from duty_rates where is_active order by effective_from desc limit 1";

export const RATES_LINES_SQL =
  "select kind, label, rate_value::text as rate_value, basis, rate_type" +
  " from duty_rates where version = $1 and is_active and kind in ('vat', 'levy', 'fee')" +
  " order by kind, label";

/**
 * The rates register the figures were read against, for the paper to cite.
 *
 * Read by `kind`, never by a hard-coded number: a rate the register does not hold
 * is left out of the answer rather than typed in from memory. The window is
 * returned too, because the register can be the newest one on file and still be
 * expired — a return prepared over a period after `effective_to` must be told that
 * before it is printed, not after.
 */
async function ratesContext() {
  const head = await pool.query(RATES_VERSION_SQL);
  if (!head.rowCount) return null;
  const v = head.rows[0];
  const lines = await pool.query(RATES_LINES_SQL, [v.version]);
  const rows = lines.rows as any[];
  const pick = (kind: string, needle: string) =>
    rows.find((r) => r.kind === kind && r.label.includes(needle)) ?? null;
  const line = (kind: string, needle: string, label: string) => {
    const r = pick(kind, needle);
    return r ? { label: r.label, rate: money(Number(r.rate_value)), basis: r.basis } : null;
  };
  return {
    version: v.version,
    effectiveFrom: v.effective_from,
    effectiveTo: v.effective_to,
    lines: [
      line("vat", "Withholding VAT — goods", "Withholding VAT on goods"),
      line("vat", "Withholding VAT — services", "Withholding VAT on services"),
      line("levy", "Railway", "Railway development levy"),
      line("fee", "Customs Processing", "Customs processing fee")
    ].filter(Boolean),
    standardVat: (() => {
      const r = pick("vat", "taxable imports and supplies");
      return r ? money(Number(r.rate_value)) : null;
    })()
  };
}

export const RETURN_SELECT_SQL =
  "select t.id, t.kind, t.basis, t.status," +
  " t.period_start::text as period_start, t.period_end::text as period_end," +
  " t.currency, t.base_amount::text as base_amount," +
  " t.zero_rated_base::text as zero_rated_base, t.exempt_base::text as exempt_base," +
  " t.tax_charged::text as tax_charged, t.input_tax::text as input_tax," +
  " t.credits_declared::text as credits_declared, t.net_payable::text as net_payable," +
  " t.statutory_collected::text as statutory_collected, t.invoices_count," +
  " t.input_basis, t.rates_version, t.note, t.filing_reference," +
  " t.filed_at::text as filed_at, t.supersedes_id, t.prepared_at::text as prepared_at," +
  " t.created_at, t.updated_at, pu.full_name as prepared_by_name, fu.full_name as filed_by_name," +
  // detail defaults to '{}' and the schedule is only ever written as an array, but
  // a count is taken from a set-returning function, so the shape is proven first.
  " case when jsonb_typeof(t.detail -> 'schedule') = 'array'" +
  "      then (select count(*) from jsonb_array_elements(t.detail -> 'schedule'))" +
  "      else 0 end::int as schedule_lines" +
  " from tax_returns t" +
  " left join users pu on pu.id = t.prepared_by" +
  " left join users fu on fu.id = t.filed_by";

function toReturn(r: any) {
  return {
    id: r.id, kind: r.kind, basis: r.basis, status: r.status,
    periodStart: r.period_start, periodEnd: r.period_end, currency: r.currency,
    baseAmount: money(Number(r.base_amount)), zeroRatedBase: money(Number(r.zero_rated_base)),
    exemptBase: money(Number(r.exempt_base)), taxCharged: money(Number(r.tax_charged)),
    inputTax: money(Number(r.input_tax)), creditsDeclared: money(Number(r.credits_declared)),
    netPayable: money(Number(r.net_payable)),
    statutoryCollected: money(Number(r.statutory_collected)),
    invoicesCount: Number(r.invoices_count), inputBasis: r.input_basis,
    ratesVersion: r.rates_version, note: r.note,
    filingReference: r.filing_reference, filedAt: r.filed_at,
    preparedAt: r.prepared_at, supersedesId: r.supersedes_id,
    preparedByName: r.prepared_by_name, filedByName: r.filed_by_name,
    scheduleLines: Number(r.schedule_lines), createdAt: r.created_at, updatedAt: r.updated_at
  };
}

const KINDS = ["vat", "withholding_vat", "statutory_charges"] as const;

// Every key here is optional: an edit that leaves a field out means "keep what is
// on the row", so the defaults that create a draft cannot silently zero a credit
// somebody had already typed.
const editSchema = z.object({
  periodStart: dateOnly.optional(),
  periodEnd: dateOnly.optional(),
  inputTax: z.number().nonnegative().optional(),
  creditsDeclared: z.number().nonnegative().optional(),
  exemptBase: z.number().nonnegative().optional(),
  taxCharged: z.number().nonnegative().optional(),
  baseAmount: z.number().nonnegative().optional(),
  inputBasis: z.string().trim().max(400).optional(),
  note: z.string().trim().max(2000).optional()
});

const periodSchema = z.object({
  kind: z.enum(KINDS),
  periodStart: dateOnly,
  periodEnd: dateOnly
});

// Everything a desk is allowed to type. Figures that are footed are not in here —
// except for a declared return, which has nothing to foot, so its charge is typed.
const declaredSchema = z.object({
  taxCharged: z.number().nonnegative().default(0),
  baseAmount: z.number().nonnegative().default(0),
  inputTax: z.number().nonnegative().default(0),
  creditsDeclared: z.number().nonnegative().default(0),
  exemptBase: z.number().nonnegative().default(0),
  inputBasis: z.string().trim().max(400).nullish(),
  note: z.string().trim().max(2000).nullish()
});

/**
 * A return is only as good as the sentence beside its typed figures. Input VAT,
 * credits and exempt supplies are all things the records cannot show, so any one
 * of them being non-null-or-non-zero obliges the desk to say where it came from.
 */
function requireProvenance(inputTax: number, credits: number, exempt: number, basis: string | null | undefined) {
  const typed = inputTax > 0 || credits > 0 || exempt > 0;
  if (typed && !(basis ?? "").trim()) {
    throw new ApiError("VALIDATION_FAILED",
      "Input VAT, credits and exempt supplies are not in these records — a return that carries them must say where they came from.",
      400, [{ field: "inputBasis", message: "Required when a figure is declared rather than footed" }]);
  }
}

/**
 * A declared row carries no footed figure at all, so its provenance is not optional
 * the way a credit line's is: the table itself refuses a declared basis with an
 * empty source, and the desk has to hear that as a 400 about a field, not as a
 * database error.
 */
function requireDeclaredBasis(basis: string | null | undefined) {
  if (!(basis ?? "").trim()) {
    throw new ApiError("VALIDATION_FAILED",
      "A declared return must name the paper its figures came from.",
      400, [{ field: "inputBasis", message: "Required for a declared return" }]);
  }
}

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * One live return per kind and period is the register's own rule (090), held by a
 * partial unique index. A second draft for October is a thing a desk can genuinely
 * try to do, so it has to come back as a conflict about that period rather than as
 * a server failure nobody can act on.
 */
function asConflict(e: unknown): never {
  if ((e as any)?.code === "23505") {
    throw new ApiError("CONFLICT",
      "This company already has an open return of that kind for the same period — edit it, or withdraw it first.", 409);
  }
  throw e;
}

export async function financeRoutes(app: FastifyInstance, _opts: unknown) {

  // ------------------------------------------------------------------
  // The dashboard: one window, everything the desk needs to judge it.
  // ------------------------------------------------------------------
  app.get("/finance/overview", { preHandler: [requireAuth, requirePermission("finance.view")] },
    async (req: any) => {
      const q = z.object({ from: dateOnly.optional(), to: dateOnly.optional() }).parse(req.query);
      const now = new Date();
      const to = q.to ?? isoDay(now);
      const from = q.from ?? isoDay(new Date(now.getFullYear(), now.getMonth() - 11, 1));

      return withTenant(req.user.tid, async (c) => {
        const tid = req.user.tid as string;
        const ar = await c.query(RECEIVABLE_SQL, [tid]);
        const ap = await c.query(PAYABLE_SQL, [tid]);
        const cashIn = await c.query(CASH_SQL, [tid, from, to]);
        const cashOut = await c.query(CASH_OUT_SQL, [tid, from, to]);
        const dso = await c.query(DSO_SQL, [tid, from, to]);
        const trend = await c.query(TREND_SQL, [tid, from, to]);
        const spend = await c.query(SPEND_SQL, [tid, from, to]);
        const customers = await c.query(CUSTOMERS_SQL, [tid, from, to]);
        const suppliers = await c.query(SUPPLIERS_SQL, [tid, from, to]);
        const foreign = await c.query(FOREIGN_SQL, [tid, null, null]);
        const pos = await footPosition(c, tid, from, to, "vat");

        const billedMap = new Map(trend.rows.map((r: any) => [r.month, r]));
        const spendMap = new Map(spend.rows.map((r: any) => [r.month, Number(r.value)]));
        const months: { month: string; billed: number; vat: number; spend: number; net: number }[] = [];
        const cursor = new Date(`${from}T00:00:00`);
        const last = new Date(`${to}T00:00:00`);
        while (cursor <= last) {
          const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
          const billed = Number(billedMap.get(key)?.billed ?? 0);
          const vat = Number(billedMap.get(key)?.vat ?? 0);
          const sp = spendMap.get(key) ?? 0;
          months.push({ month: key, billed: money(billed), vat: money(vat), spend: money(sp), net: money(billed - sp) });
          cursor.setMonth(cursor.getMonth() + 1);
        }

        const a = ar.rows[0];
        const p = ap.rows[0];
        const age = (v: string) => money(Number(v));
        const buckets = [a.age_1_30, a.age_31_60, a.age_61_90, a.age_90_plus];
        const outstanding = Number(a.outstanding);
        const otherCurrencies = foreign.rows.map((r: any) => ({
          currency: r.currency, bills: Number(r.bills),
          billed: money(Number(r.billed)), outstanding: money(Number(r.outstanding))
        }));
        const inflow = Number(cashIn.rows[0].inflow);
        const outflow = Number(cashOut.rows[0].outflow);

        return {
          period: { from, to },
          // Every figure below is TZS. A bill in another currency is owed just the
          // same, so it is listed here instead of being folded into a sum that would
          // silently mix shillings with dollars.
          currency: "TZS",
          otherCurrencies,
          mixedCurrency: otherCurrencies.length > 0,
          receivable: {
            bills: Number(a.bills),
            billed: money(Number(a.billed)), collected: money(Number(a.collected)),
            outstanding, overdue: money(Number(a.overdue)),
            overdueCount: Number(a.overdue_count),
            ageing: {
              current: money(Number(a.age_current)),
              oneToThirty: age(a.age_1_30), thirtyOneToSixty: age(a.age_31_60),
              sixtyOneToNinety: age(a.age_61_90), overNinety: age(a.age_90_plus),
              bucketTotal: money(buckets.reduce((s, v) => s + Number(v), 0))
            }
          },
          payable: {
            bills: Number(p.bills), billed: money(Number(p.billed)), paid: money(Number(p.paid)),
            outstanding: money(Number(p.outstanding)), overdue: money(Number(p.overdue))
          },
          cash: {
            in: money(inflow), out: money(outflow), net: money(inflow - outflow),
            // freight_expenses records how much of a bill has been paid, not when.
            outBasis: "Payments out are attributed to the expense's own date — the system keeps no dated expense payment register."
          },
          collection: { daysToCollect: money(Number(dso.rows[0].dso)), payments: Number(dso.rows[0].payments) },
          tax: {
            outputCharged: pos.taxCharged, baseAmount: pos.baseAmount,
            zeroRatedBase: pos.zeroRatedBase, statutoryCollected: pos.statutoryCollected,
            exciseAmount: pos.exciseAmount, invoicesCount: pos.invoices,
            handBuiltCount: pos.handBuilt
          },
          months,
          topCustomers: customers.rows.map((r: any) => ({
            name: r.customer_name, tin: r.customer_tin, invoices: Number(r.invoices),
            billed: money(Number(r.billed)), outstanding: money(Number(r.outstanding)),
            vat: money(Number(r.vat))
          })),
          topSuppliers: suppliers.rows.map((r: any) => ({
            name: r.supplier_name, bills: Number(r.bills),
            billed: money(Number(r.billed)), outstanding: money(Number(r.outstanding)),
            topCategory: r.top_category
          }))
        };
      });
    });

  // ------------------------------------------------------------------
  // The tax position for a period: what the company's own paper says.
  // ------------------------------------------------------------------
  app.get("/finance/tax/position", { preHandler: [requireAuth, requirePermission("tax.view")] },
    async (req: any) => {
      const q = periodSchema.parse(req.query);
      const rates = await ratesContext();
      const figures = await withTenant(req.user.tid, async (c) => {
        const pos = await footPosition(c, req.user.tid, q.periodStart, q.periodEnd, q.kind);
        const live = await c.query(
          "select id, status, basis, net_payable::text as net_payable from tax_returns" +
          " where tenant_id = $1 and kind = $2 and deleted_at is null and status <> 'filed'" +
          " and period_start = $3::date and period_end = $4::date" +
          " order by created_at desc limit 1",
          [req.user.tid, q.kind, q.periodStart, q.periodEnd]);
        const foreign = await c.query(FOREIGN_SQL, [req.user.tid, q.periodStart, q.periodEnd]);
        return { pos, live, foreign };
      });
      const pos = figures.pos;

      const notes: string[] = [];
      if (q.kind === "withholding_vat") {
        notes.push("Withheld VAT is not in these records — the system holds no certificate of withholding from a customer and cannot tell which customers are withholding agents. Prepare this return as declared and cite the source.");
      } else {
        notes.push("Footed from issued bills only. Draft and cancelled bills are outside a return.");
      }
      if (q.kind !== "withholding_vat" && pos.handBuilt > 0) {
        notes.push(`${pos.handBuilt} of ${pos.invoices} bill(s) were typed at the desk rather than converted from a proforma, so they carry no statutory-section split; their VAT is the headline rate over the whole subtotal.`);
      }
      if (q.kind !== "withholding_vat" && pos.zeroRatedBase > 0) {
        notes.push("Supplies on a bill with no VAT are counted as zero-rated. The system keeps no exemption codes, so exempt supplies must be declared on the return.");
      }
      const otherCurrencies = figures.foreign.rows.map((r: any) => ({
        currency: r.currency, bills: Number(r.bills), value: money(Number(r.billed))
      }));
      if (otherCurrencies.length) {
        const bills = otherCurrencies.reduce((s, r) => s + r.bills, 0);
        notes.push(`${bills} issued bill(s) in ${otherCurrencies.map((r) => r.currency).join(", ")} fall in this period and are outside this return. A return is denominated in one currency and the system holds no exchange-rate policy, so the foreign paper must be added as a declared figure with its source cited.`);
      }
      if (rates?.effectiveTo) {
        const today = isoDay(new Date());
        if (rates.effectiveTo < q.periodEnd || rates.effectiveTo < today) {
          notes.push(`The rates register on file (${rates.version}) stops at ${rates.effectiveTo}; a period after that date is being measured against expired rates.`);
        }
      }

      return {
        kind: q.kind, periodStart: q.periodStart, periodEnd: q.periodEnd, currency: "TZS",
        figures: {
          baseAmount: pos.baseAmount, zeroRatedBase: pos.zeroRatedBase,
          taxCharged: pos.taxCharged, statutoryCollected: pos.statutoryCollected,
          exciseAmount: pos.exciseAmount, invoicesCount: pos.invoices,
          handBuiltCount: pos.handBuilt, billedTotal: pos.billedTotal,
          collectedTotal: pos.collectedTotal
        },
        standardVatRate: rates?.standardVat ?? null,
        // The desk says "nothing to foot here" instead of showing a row of zeros and
        // letting them read as "no VAT withheld this period".
        computed: q.kind !== "withholding_vat",
        otherCurrencies,
        notes,
        openReturn: figures.live.rowCount
          ? {
            id: figures.live.rows[0].id, status: figures.live.rows[0].status,
            basis: figures.live.rows[0].basis,
            netPayable: money(Number(figures.live.rows[0].net_payable))
          }
          : null,
        rates
      };
    });

  // ------------------------------------------------------------------
  // The register.
  // ------------------------------------------------------------------
  app.get("/finance/tax/returns", { preHandler: [requireAuth, requirePermission("tax.view")] },
    async (req: any) => {
      const q = z.object({
        kind: z.enum(KINDS).optional(),
        status: z.enum(["draft", "prepared", "filed"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60)
      }).parse(req.query);
      const res = await withTenant(req.user.tid, (c) => c.query(
        RETURN_SELECT_SQL +
        " where t.tenant_id = $1 and t.deleted_at is null" +
        " and ($2::text is null or t.kind = $2)" +
        " and ($3::text is null or t.status = $3)" +
        " order by t.period_start desc, t.created_at desc limit $4",
        [req.user.tid, q.kind ?? null, q.status ?? null, q.limit]));
      return { returns: res.rows.map(toReturn) };
    });

  app.get("/finance/tax/returns/:id", { preHandler: [requireAuth, requirePermission("tax.view")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const head = await c.query(
          RETURN_SELECT_SQL + " where t.id = $1 and t.tenant_id = $2 and t.deleted_at is null",
          [id, req.user.tid]);
        if (!head.rowCount) throw new ApiError("NOT_FOUND", "Return not found", 404);
        const detail = await c.query(
          "select detail from tax_returns where id = $1 and tenant_id = $2", [id, req.user.tid]);
        const d = detail.rows[0]?.detail ?? {};
        return {
          ...toReturn(head.rows[0]),
          figures: d.figures ?? null,
          schedule: Array.isArray(d.schedule) ? d.schedule : [],
          rates: d.rates ?? null
        };
      });
    });

  /**
   * Create a draft. The period and the declared credits come from the desk; the
   * base, the charge and the count are re-footed here, in the same transaction,
   * from the invoices — so what a return claims to owe always has a paper trail.
   */
  app.post("/finance/tax/returns", { preHandler: [requireAuth, requirePermission("tax.prepare")] },
    async (req: any, reply) => {
      const body = periodSchema.merge(declaredSchema).parse(req.body);
      const inputTax = money(body.inputTax);
      const credits = money(body.creditsDeclared);
      const exempt = money(body.exemptBase);
      const declared = body.kind === "withholding_vat";
      if (declared) requireDeclaredBasis(body.inputBasis);
      requireProvenance(inputTax, credits, exempt, body.inputBasis);
      const id = uuidv7();
      const rates = await ratesContext();

      await withTenant(req.user.tid, async (c) => {
        // A computed return takes every headline figure from the records; a declared
        // one takes the charge and the base the desk typed, because there is no
        // paper here to foot them from.
        const pos = declared
          ? { ...EMPTY_POSITION, baseAmount: money(body.baseAmount), taxCharged: money(body.taxCharged) }
          : await footPosition(c, req.user.tid, body.periodStart, body.periodEnd, body.kind);
        const rows = declared ? [] : await schedule(c, req.user.tid, body.periodStart, body.periodEnd);
        const net = money(pos.taxCharged - inputTax - credits);
        await c.query(
          "insert into tax_returns (id, tenant_id, kind, basis, period_start, period_end, currency," +
          " base_amount, zero_rated_base, exempt_base, tax_charged, input_tax, credits_declared," +
          " net_payable, statutory_collected, invoices_count, input_basis, detail, rates_version," +
          " note, created_by, updated_by)" +
          " values ($1,$2,$3,$4,$5::date,$6::date,'TZS',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb," +
          " $18,$19,$20,$20)",
          [id, req.user.tid, body.kind, declared ? "declared" : "computed",
           body.periodStart, body.periodEnd,
           pos.baseAmount, pos.zeroRatedBase, exempt, pos.taxCharged, inputTax, credits, net,
           pos.statutoryCollected, pos.invoices,
           body.inputBasis?.trim() || null,
           JSON.stringify({ schedule: rows, figures: pos, rates }),
           rates?.version ?? null, body.note?.trim() || null, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
          entity: "tax_returns", entityId: id, action: "tax.return.drafted",
          after: { kind: body.kind, periodStart: body.periodStart, periodEnd: body.periodEnd, netPayable: net }
        });
      }).catch(asConflict);
      return reply.status(201).send({ id });
    });

  /** Re-foot and re-credit an unfiled return. The gate has already frozen anything filed. */
  app.put("/finance/tax/returns/:id", { preHandler: [requireAuth, requirePermission("tax.prepare")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = editSchema.parse(req.body);

      return withTenant(req.user.tid, async (c) => {
        const cur = await c.query(
          "select kind, status, basis," +
          " period_start::text as period_start, period_end::text as period_end," +
          " tax_charged::text as tax_charged, input_tax::text as input_tax," +
          " credits_declared::text as credits_declared, exempt_base::text as exempt_base," +
          " input_basis from tax_returns where id = $1 and tenant_id = $2 and deleted_at is null",
          [id, req.user.tid]);
        if (!cur.rowCount) throw new ApiError("NOT_FOUND", "Return not found", 404);
        const r = cur.rows[0];
        if (r.status === "filed") {
          throw new ApiError("CONFLICT", "A filed return is kept as filed — raise one that supersedes it.", 409);
        }
        const from = body.periodStart ?? r.period_start;
        const to = body.periodEnd ?? r.period_end;
        if (from > to) throw new ApiError("VALIDATION_FAILED", "The period end is before its start.", 400);
        const inputTax = money(body.inputTax ?? Number(r.input_tax));
        const credits = money(body.creditsDeclared ?? Number(r.credits_declared));
        const exempt = money(body.exemptBase ?? Number(r.exempt_base));
        const basis = body.inputBasis ?? r.input_basis;
        requireProvenance(inputTax, credits, exempt, basis);
        if (r.basis === "declared") requireDeclaredBasis(basis);

        // A declared (withheld) return is typed; anything else is re-footed, and a
        // typed charge is never accepted for a computed return.
        let charged = Number(r.tax_charged);
        let baseAmount = Number(r.base_amount);
        let zeroRated = Number(r.zero_rated_base);
        let statutory = Number(r.statutory_collected);
        let count = Number(r.invoices_count);
        // A computed return gets a fresh schedule and figures; a declared one has
        // nothing to foot, so its stored detail is left exactly as it was.
        let detail: string | null = null;
        if (r.basis === "declared") {
          if (body.taxCharged === undefined) throw new ApiError("VALIDATION_FAILED",
            "A declared return needs the amount it is accounting for.", 400,
            [{ field: "taxCharged", message: "Required for a declared return" }]);
          charged = money(body.taxCharged);
          if (body.baseAmount !== undefined) baseAmount = money(body.baseAmount);
        } else {
          const pos = await footPosition(c, req.user.tid, from, to, r.kind);
          charged = pos.taxCharged; baseAmount = pos.baseAmount; zeroRated = pos.zeroRatedBase;
          statutory = pos.statutoryCollected; count = pos.invoices;
          detail = JSON.stringify({
            schedule: await schedule(c, req.user.tid, from, to),
            figures: pos,
            rates: await ratesContext()
          });
        }
        const net = money(charged - inputTax - credits);

        const upd = await c.query(
          "update tax_returns set base_amount = $3, zero_rated_base = $4, exempt_base = $5," +
          " tax_charged = $6, input_tax = $7, credits_declared = $8, net_payable = $9," +
          " statutory_collected = $10, invoices_count = $11, input_basis = $12," +
          " note = coalesce($13, note), detail = coalesce($14::jsonb, detail)," +
          " period_start = $15::date, period_end = $16::date," +
          " updated_by = $17, updated_at = now()" +
          " where id = $1 and tenant_id = $2 and status <> 'filed' returning id",
          [id, req.user.tid, baseAmount, zeroRated, exempt, charged, inputTax, credits, net,
           statutory, count, basis?.trim() || null, body.note?.trim() || null,
           detail, from, to, req.user.sub]);
        if (!upd.rowCount) throw new ApiError("CONFLICT", "The return changed under you — reload it.", 409);

        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
          entity: "tax_returns", entityId: id, action: "tax.return.updated",
          before: {
            taxCharged: money(Number(r.tax_charged)),
            netPayable: money(Number(r.tax_charged) - Number(r.input_tax) - Number(r.credits_declared))
          },
          after: { taxCharged: charged, netPayable: net }
        });
        return { id, netPayable: net, taxCharged: charged };
      }).catch(asConflict);
    });

  /** Freeze the figures into a preparation: the schedule is copied in here. */
  app.post("/finance/tax/returns/:id/prepare", { preHandler: [requireAuth, requirePermission("tax.prepare")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      return withTenant(req.user.tid, async (c) => {
        const cur = await c.query(
          "select kind, status, basis, period_start::text as period_start," +
          " period_end::text as period_end, net_payable::text as net_payable" +
          " from tax_returns where id = $1 and tenant_id = $2 and deleted_at is null",
          [id, req.user.tid]);
        if (!cur.rowCount) throw new ApiError("NOT_FOUND", "Return not found", 404);
        const r = cur.rows[0];
        if (r.status !== "draft") throw new ApiError("CONFLICT", "Only a draft return is prepared.", 409);
        if (r.basis === "computed") {
          const pos = await footPosition(c, req.user.tid, r.period_start, r.period_end, r.kind);
          const rows = await schedule(c, req.user.tid, r.period_start, r.period_end);
          await c.query(
            "update tax_returns set base_amount = $3, zero_rated_base = $4, tax_charged = $5," +
            " statutory_collected = $6, invoices_count = $7, detail = $8::jsonb," +
            // The credit figures stay exactly as the desk typed them; the charge is
            // re-footed, and the net is footed from both by the table's own check.
            " net_payable = $5 - input_tax - credits_declared," +
            " prepared_by = $9, prepared_at = now(), status = 'prepared'," +
            " updated_by = $9, updated_at = now()" +
            " where id = $1 and tenant_id = $2 and status = 'draft'",
            [id, req.user.tid, pos.baseAmount, pos.zeroRatedBase, pos.taxCharged,
             pos.statutoryCollected, pos.invoices,
             JSON.stringify({ schedule: rows, figures: pos, rates: await ratesContext() }),
             req.user.sub]);
        } else {
          await c.query(
            "update tax_returns set status = 'prepared', prepared_by = $3, prepared_at = now()," +
            " updated_by = $3, updated_at = now()" +
            " where id = $1 and tenant_id = $2 and status = 'draft'",
            [id, req.user.tid, req.user.sub]);
        }
        const after = await c.query(
          "select status, net_payable::text as net_payable from tax_returns" +
          " where id = $1 and tenant_id = $2", [id, req.user.tid]);
        if (!after.rowCount || after.rows[0].status !== "prepared") {
          throw new ApiError("CONFLICT", "The return did not reach prepared — nothing was frozen.", 409);
        }
        const net = money(Number(after.rows[0].net_payable));
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
          entity: "tax_returns", entityId: id, action: "tax.return.prepared",
          after: { netPayable: net, kind: r.kind, periodStart: r.period_start, periodEnd: r.period_end }
        });
        return { id, status: "prepared", netPayable: net };
      });
    });

  /**
   * Record the filing. The system never submits anything — this is the desk writing
   * down the reference the portal gave back, which is what makes the register a
   * record rather than a pile of drafts.
   */
  app.put("/finance/tax/returns/:id/file", { preHandler: [requireAuth, requirePermission("tax.file")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      const body = z.object({
        filingReference: z.string().trim().min(3).max(120),
        filedAt: dateOnly
      }).parse(req.body);
      return withTenant(req.user.tid, async (c) => {
        const cur = await c.query(
          "select status, kind, net_payable::text as net_payable from tax_returns" +
          " where id = $1 and tenant_id = $2 and deleted_at is null", [id, req.user.tid]);
        if (!cur.rowCount) throw new ApiError("NOT_FOUND", "Return not found", 404);
        if (cur.rows[0].status !== "prepared") {
          throw new ApiError("CONFLICT", "A return is filed only after its figures have been prepared.", 409);
        }
        const upd = await c.query(
          "update tax_returns set status = 'filed', filing_reference = $3, filed_at = $4::date," +
          " filed_by = $5, updated_by = $5, updated_at = now()" +
          " where id = $1 and tenant_id = $2 and status = 'prepared' returning id",
          [id, req.user.tid, body.filingReference, body.filedAt, req.user.sub]);
        if (!upd.rowCount) throw new ApiError("CONFLICT", "The return changed under you — reload it.", 409);
        const net = money(Number(cur.rows[0].net_payable));
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
          entity: "tax_returns", entityId: id, action: "tax.return.filed",
          after: { reference: body.filingReference, filedAt: body.filedAt, netPayable: net, kind: cur.rows[0].kind }
        });
        return { id, status: "filed", netPayable: net };
      });
    });

  /** A filed return is corrected by replacing it, never by rewriting it. */
  app.post("/finance/tax/returns/:id/supersede", { preHandler: [requireAuth, requirePermission("tax.prepare")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const fresh = uuidv7();
      await withTenant(req.user.tid, async (c) => {
        const cur = await c.query(
          "select kind, status, basis, period_start::text as period_start," +
          " period_end::text as period_end, tax_charged::text as tax_charged," +
          " input_tax::text as input_tax, credits_declared::text as credits_declared," +
          " net_payable::text as net_payable, base_amount::text as base_amount," +
          " zero_rated_base::text as zero_rated_base, exempt_base::text as exempt_base," +
          " statutory_collected::text as statutory_collected, invoices_count," +
          " input_basis, detail, rates_version, filing_reference" +
          " from tax_returns where id = $1 and tenant_id = $2 and deleted_at is null",
          [id, req.user.tid]);
        if (!cur.rowCount) throw new ApiError("NOT_FOUND", "Return not found", 404);
        const r = cur.rows[0];
        if (r.status !== "filed") {
          throw new ApiError("CONFLICT", "Only a filed return is superseded — edit the draft instead.", 409);
        }
        await c.query(
          "insert into tax_returns (id, tenant_id, kind, basis, period_start, period_end, currency," +
          " base_amount, zero_rated_base, exempt_base, tax_charged, input_tax, credits_declared," +
          " net_payable, statutory_collected, invoices_count, input_basis, detail, rates_version," +
          " supersedes_id, created_by, updated_by)" +
          " values ($1,$2,$3,$4,$5::date,$6::date,'TZS',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb," +
          " $18,$19,$20,$20)",
          [fresh, req.user.tid, r.kind, r.basis, r.period_start, r.period_end,
           Number(r.base_amount), Number(r.zero_rated_base), Number(r.exempt_base),
           Number(r.tax_charged), Number(r.input_tax), Number(r.credits_declared),
           Number(r.net_payable), Number(r.statutory_collected), Number(r.invoices_count),
           r.input_basis, JSON.stringify(r.detail ?? {}), r.rates_version, id, req.user.sub]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
          entity: "tax_returns", entityId: fresh, action: "tax.return.superseded",
          after: { supersedes: id, kind: r.kind, periodStart: r.period_start }
        });
      }).catch(asConflict);
      return reply.status(201).send({ id: fresh });
    });

  // No DELETE is granted on tax_returns: a return that should not have happened is
  // withdrawn by a timestamp on its own row, and stays in the register.
  app.delete("/finance/tax/returns/:id", { preHandler: [requireAuth, requirePermission("tax.prepare")] },
    async (req: any) => {
      const { id } = req.params as { id: string };
      await withTenant(req.user.tid, async (c) => {
        const cur = await c.query(
          "select status, kind from tax_returns where id = $1 and tenant_id = $2 and deleted_at is null",
          [id, req.user.tid]);
        if (!cur.rowCount) throw new ApiError("NOT_FOUND", "Return not found", 404);
        if (cur.rows[0].status === "filed") {
          throw new ApiError("CONFLICT", "A filed return is kept as filed.", 409);
        }
        await c.query(
          "update tax_returns set deleted_at = now(), updated_by = $2, updated_at = now()" +
          " where id = $1 and tenant_id = $3 and status <> 'filed'",
          [id, req.user.sub, req.user.tid]);
        await writeAudit(c, {
          tenantId: req.user.tid, actorUserId: req.user.sub, ip: req.ip,
          userAgent: req.headers["user-agent"] ?? null, requestId: req.requestId,
          entity: "tax_returns", entityId: id, action: "tax.return.withdrawn",
          before: { status: cur.rows[0].status, kind: cur.rows[0].kind }
        });
      });
      return { ok: true };
    });

  /**
   * The schedule behind a return, as CSV — the file an accountant takes to the
   * portal. Leading =, +, - and @ are neutralised, because a spreadsheet treats
   * them as a formula and a figure that came out of a bank column must not turn
   * into code on somebody's desktop.
   */
  app.get("/finance/tax/returns/:id/schedule.csv",
    { preHandler: [requireAuth, requirePermission("tax.view")] },
    async (req: any, reply) => {
      const { id } = req.params as { id: string };
      const res = await withTenant(req.user.tid, (c) => c.query(
        "select kind, basis, status, net_payable::text as net_payable, filing_reference," +
        " period_start::text as period_start, period_end::text as period_end," +
        " rates_version, detail from tax_returns" +
        " where id = $1 and tenant_id = $2 and deleted_at is null", [id, req.user.tid]));
      if (!res.rowCount) throw new ApiError("NOT_FOUND", "Return not found", 404);
      const head = res.rows[0];
      const cell = (v: unknown) => {
        const s = v === null || v === undefined ? "" : String(v);
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      // The zero-rated column is printed next to the taxable base on purpose: a
      // supply that owed no VAT still has to be declared, and a sheet that shows
      // only the base would read as if that bill were missing from the return.
      const lines: string[] = [
        ["Invoice", "Issue date", "Due date", "Customer", "Customer TIN", "Currency",
          "Taxable base", "Zero-rated base", "VAT rate", "VAT charged",
          "Statutory pass-through", "Bill total",
          "Collected", "From proforma"].map(cell).join(",")
      ];
      const detail = head.detail ?? {};
      for (const r of (Array.isArray(detail.schedule) ? detail.schedule : [])) {
        lines.push([r.invoice_number, r.issue_date, r.due_date, r.customer_name, r.customer_tin,
          r.currency, r.base_amount, r.untaxed_base, r.vat_rate, r.vat_amount, r.statutory_base,
          r.total, r.amount_paid, r.from_proforma ? "yes" : "no"].map(cell).join(","));
      }
      const footer = (Array.isArray(detail.schedule) ? detail.schedule.length : 0) === 0
        ? (head.basis === "declared"
          ? ["", "", "", "Declared return — these records hold no schedule for it.", "", "",
            "", "", "", "", "", head.net_payable, "", ""]
          : ["", "", "", "No issued bill falls in this period."])
        : null;
      if (footer) lines.push(footer.map(cell).join(","));
      reply.header("Content-Disposition",
        `attachment; filename="tax-return-${head.kind}-${head.period_start}-to-${head.period_end}.csv"`);
      reply.type("text/csv; charset=utf-8");
      return lines.join("\r\n");
    });
}
