"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface ArCustomer {
  customer_name: string; invoices: number; invoiced: number; paid: number;
  outstanding: number; overdue_amount: number; oldest_due: string | null;
}
interface Pnl {
  revenueIssued: number; cashIn: number; expensesRecorded: number;
  cashOut: number; net: number;
}
interface TrendMonth { month: string; revenue: number; expenses: number; }
interface ApSupplier {
  supplier_name: string; bills: number; billed: number; paid: number;
  outstanding: number; overdue_amount: number;
}
interface Expense {
  id: string; supplier_name: string; description: string | null;
  category: string; amount: string; amount_paid: string; currency: string;
  expense_date: string; due_date: string | null; trip_reference: string | null;
  effective_status: string;
}

const STATUS_LABELS: Record<string, string> = {
  open: "Open", partial: "Partially paid", paid: "Paid",
  overdue: "Overdue", cancelled: "Cancelled"
};
const STATUS_COLORS: Record<string, string> = {
  open: "var(--brand)", partial: "var(--gold)", paid: "var(--success)",
  overdue: "var(--danger)", cancelled: "var(--ink-soft)"
};
const CATEGORIES = ["fuel", "maintenance", "salaries", "rent", "office", "border", "toll", "loading", "other"];
const CURRENCY_CODES = ["TZS", "USD", "EUR", "GBP", "CNY", "RUB", "JPY"];

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: "short" });
};

const EMPTY_EXPENSE = {
  supplierName: "", description: "", category: "other", amount: "",
  currency: "TZS", expenseDate: "", dueDate: ""
};

export default function LedgerPage() {
  const [receivables, setReceivables] = useState<{ customers: ArCustomer[]; pnl: Pnl; trend: TrendMonth[] } | null>(null);
  const [payables, setPayables] = useState<{ suppliers: ApSupplier[]; expenses: Expense[]; totals: { billed: number; paid: number; outstanding: number } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [form, setForm] = useState(EMPTY_EXPENSE);
  const [payFor, setPayFor] = useState("");
  const [payAmount, setPayAmount] = useState("");

  const load = useCallback(async () => {
    const r = await apiFetch("/ledger/receivables");
    if (r.ok) setReceivables(await r.json());
    else {
      const j = await r.json().catch(() => ({}));
      setError(errorText(j, "Could not load receivables."));
    }
    const p = await apiFetch("/ledger/payables");
    if (p.ok) setPayables(await p.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  async function recordExpense(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch("/expenses", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierName: form.supplierName,
          description: form.description || null,
          category: form.category,
          amount: Number(form.amount),
          currency: form.currency,
          expenseDate: form.expenseDate || undefined,
          dueDate: form.dueDate || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to record the expense.")); return; }
      setNotice("Expense recorded.");
      setForm(EMPTY_EXPENSE); setShowExpenseForm(false);
      load();
    } finally { setBusy(false); }
  }

  async function paySupplier(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/expenses/${payFor}/payments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: Number(payAmount) })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to record the payment.")); return; }
      setNotice("Supplier payment recorded.");
      setPayFor(""); setPayAmount("");
      load();
    } finally { setBusy(false); }
  }

  async function cancelExpense(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/expenses/${id}/status`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed."));
    load();
  }

  async function deleteExpense(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/expenses/${id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed."));
    load();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  const pnl = receivables?.pnl;
  const trend = receivables?.trend ?? [];
  const trendMax = Math.max(...trend.map(m => Math.max(m.revenue, m.expenses)), 1);
  const unpaidExpenses = (payables?.expenses ?? []).filter(
    x => x.effective_status !== "paid" && x.effective_status !== "cancelled");

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Financial ledger</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Receivables, payables and cash flow in one view.
      </p>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {/* Profit & loss summary */}
      {pnl && (
        <section className="mt-24">
          <div className="grid grid-cols-2 gap-16 lg:grid-cols-5">
            <div className={card} style={cardStyle}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Revenue issued</p>
              <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>{fmt(pnl.revenueIssued)}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Cash in</p>
              <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--success)" }}>{fmt(pnl.cashIn)}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Expenses recorded</p>
              <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>{fmt(pnl.expensesRecorded)}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Cash out</p>
              <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--danger)" }}>{fmt(pnl.cashOut)}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Net position</p>
              <p className="mt-8 text-lg font-bold tabular-nums"
                style={{ color: pnl.net >= 0 ? "var(--success)" : "var(--danger)" }}>{fmt(pnl.net)}</p>
            </div>
          </div>
          <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
            Combined totals across currencies. Net position is cash received minus cash paid out.
          </p>
        </section>
      )}

      {/* Revenue vs expenses trend */}
      {trend.length > 0 && (
        <section className={`${card} mt-24`} style={cardStyle}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              Revenue vs expenses — last 12 months
            </h2>
            <div className="flex gap-16 text-[10px]" style={{ color: "var(--ink-soft)" }}>
              <span className="flex items-center gap-4">
                <span className="inline-block h-8 w-8 rounded-sm" style={{ background: "var(--brand)" }} /> Revenue
              </span>
              <span className="flex items-center gap-4">
                <span className="inline-block h-8 w-8 rounded-sm" style={{ background: "var(--danger)" }} /> Expenses
              </span>
            </div>
          </div>
          <div className="mt-16 flex items-end gap-6" style={{ height: 180 }}>
            {trend.map(m => (
              <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center gap-4">
                <div className="flex w-full items-end justify-center gap-2" style={{ height: 140 }}>
                  <div className="w-1/3 rounded-t" style={{
                    height: `${Math.max((m.revenue / trendMax) * 100, m.revenue > 0 ? 2 : 0)}%`,
                    background: "var(--brand)"
                  }} title={`Revenue ${fmt(m.revenue)}`} />
                  <div className="w-1/3 rounded-t" style={{
                    height: `${Math.max((m.expenses / trendMax) * 100, m.expenses > 0 ? 2 : 0)}%`,
                    background: "var(--danger)"
                  }} title={`Expenses ${fmt(m.expenses)}`} />
                </div>
                <span className="text-[9px] uppercase" style={{ color: "var(--ink-soft)" }}>{monthLabel(m.month)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Accounts receivable */}
      <section className="mt-24">
        <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
          Accounts receivable — clients owe you
        </h2>
        <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Customer</th><th className="p-12">Invoices</th>
                <th className="p-12 text-right">Invoiced</th><th className="p-12 text-right">Paid</th>
                <th className="p-12 text-right">Outstanding</th>
                <th className="p-12 text-right">Overdue</th>
                <th className="p-12 text-right">Oldest due</th>
              </tr>
            </thead>
            <tbody>
              {(receivables?.customers ?? []).map((c, i) => (
                <tr key={c.customer_name} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{c.customer_name}</td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{c.invoices}</td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmt(c.invoiced)}</td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--success)" }}>{fmt(c.paid)}</td>
                  <td className="p-12 text-right tabular-nums font-semibold" style={{ color: "var(--gold)" }}>{fmt(c.outstanding)}</td>
                  <td className="p-12 text-right tabular-nums" style={{ color: c.overdue_amount > 0 ? "var(--danger)" : "var(--ink-soft)" }}>
                    {c.overdue_amount > 0 ? fmt(c.overdue_amount) : "—"}
                  </td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {c.oldest_due ? new Date(c.oldest_due).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
              {(receivables?.customers ?? []).length === 0 && (
                <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                  Nothing outstanding — every issued invoice is settled.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Accounts payable */}
      <section className="mt-24">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            Accounts payable — you owe suppliers
          </h2>
          <button type="button" onClick={() => setShowExpenseForm(s => !s)}
            className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
            {showExpenseForm ? "Close form" : "+ Record expense"}
          </button>
        </div>

        {payables && (
          <p className="mt-8 text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
            {fmt(payables.totals.billed)} billed · {fmt(payables.totals.paid)} paid ·{" "}
            <span className="font-semibold" style={{ color: "var(--gold)" }}>{fmt(payables.totals.outstanding)} outstanding</span>
          </p>
        )}

        {showExpenseForm && (
          <form onSubmit={recordExpense} className="mt-16 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
            <div className="grid grid-cols-2 gap-12">
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Supplier *</span>
                <input required value={form.supplierName}
                  onChange={e => setForm(f => ({ ...f, supplierName: e.target.value }))}
                  placeholder="e.g. Total Tanzania" className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Description</span>
                <input value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Category</span>
                <select value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className={inputCls} style={inputStyle}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
                </select>
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Amount *</span>
                <input type="number" required min={0.01} step="0.01" value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Currency</span>
                <select value={form.currency}
                  onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}
                  className={inputCls} style={inputStyle}>
                  {CURRENCY_CODES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Expense date</span>
                <input type="date" value={form.expenseDate}
                  onChange={e => setForm(f => ({ ...f, expenseDate: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Due date</span>
                <input type="date" value={form.dueDate}
                  onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
            </div>
            <button type="submit" disabled={busy}
              className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
              {busy ? "Saving…" : "Record expense"}
            </button>
          </form>
        )}

        {payables && unpaidExpenses.length > 0 && (
          <form onSubmit={paySupplier} className="mt-16 grid grid-cols-[1fr_160px_140px] items-end gap-12 rounded-card border bg-surface p-24" style={cardStyle}>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Pay supplier</span>
              <select required value={payFor} onChange={e => setPayFor(e.target.value)}
                className={inputCls} style={inputStyle}>
                <option value="">Select an expense</option>
                {unpaidExpenses.map(x => (
                  <option key={x.id} value={x.id}>
                    {x.supplier_name} — balance {fmt(Number(x.amount) - Number(x.amount_paid))} {x.currency}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Amount *</span>
              <input type="number" required min={0.01} step="0.01" value={payAmount}
                onChange={e => setPayAmount(e.target.value)}
                className={inputCls} style={inputStyle} />
            </label>
            <button type="submit" disabled={busy || !payFor}
              className="waisha-btn rounded-input py-8 text-xs font-semibold disabled:opacity-60">
              Record payment
            </button>
          </form>
        )}

        <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Supplier</th><th className="p-12">Category</th>
                <th className="p-12">Date</th><th className="p-12">Due</th>
                <th className="p-12 text-right">Amount</th><th className="p-12 text-right">Paid</th>
                <th className="p-12">Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(payables?.expenses ?? []).map((x, i) => (
                <tr key={x.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                    {x.supplier_name}
                    {x.description && <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>{x.description}</span>}
                  </td>
                  <td className="p-12 capitalize" style={{ color: "var(--ink-soft)" }}>{x.category}</td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {new Date(x.expense_date).toLocaleDateString()}
                  </td>
                  <td className="p-12 tabular-nums" style={{
                    color: x.effective_status === "overdue" ? "var(--danger)" : "var(--ink-soft)"
                  }}>
                    {x.due_date ? new Date(x.due_date).toLocaleDateString() : "—"}
                  </td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                    {Number(x.amount).toLocaleString()} {x.currency}
                  </td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--success)" }}>
                    {Number(x.amount_paid).toLocaleString()}
                  </td>
                  <td className="p-12">
                    <span className="px-8 py-4 text-[10px] font-bold uppercase"
                      style={{ borderLeft: `4px solid ${STATUS_COLORS[x.effective_status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                      {STATUS_LABELS[x.effective_status] ?? x.effective_status}
                    </span>
                  </td>
                  <td className="p-12 text-right whitespace-nowrap">
                    {x.effective_status !== "paid" && x.effective_status !== "cancelled" && (
                      <>
                        <button type="button" className="mr-12 underline" style={{ color: "var(--danger)" }}
                          onClick={() => cancelExpense(x.id)}>Cancel</button>
                        <button type="button" className="underline" style={{ color: "var(--danger)" }}
                          onClick={() => deleteExpense(x.id)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {(payables?.expenses ?? []).length === 0 && (
                <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                  No expenses recorded yet — fuel, maintenance and office costs land here.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
