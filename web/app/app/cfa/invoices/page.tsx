"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Invoice {
  id: string; invoice_number: string; customer_name: string;
  customer_email: string | null; customer_tin: string | null;
  issue_date: string; due_date: string | null;
  currency: string; vat_rate: string; subtotal: string;
  vat_amount: string; total: string; amount_paid: string;
  status: string; effective_status: string; created_at: string;
}
interface Kpis { invoiced: number; received: number; outstanding: number; overdue: number; }

interface ItemRow { description: string; quantity: string; unitPrice: string; }
interface InvoiceForm {
  customerName: string; customerPhone: string; customerEmail: string;
  customerTin: string; customerAddress: string;
  issueDate: string; dueDate: string; paymentTerms: string; notes: string;
  vatRate: string; items: ItemRow[];
}
const EMPTY: InvoiceForm = {
  customerName: "", customerPhone: "", customerEmail: "", customerTin: "",
  customerAddress: "", issueDate: "", dueDate: "", paymentTerms: "Net 30",
  notes: "", vatRate: "18", items: [{ description: "", quantity: "1", unitPrice: "" }]
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", sent: "Sent", partial: "Partially paid",
  paid: "Paid", overdue: "Overdue", cancelled: "Cancelled"
};
const STATUS_COLORS: Record<string, string> = {
  draft: "var(--ink-soft)", sent: "var(--brand)", partial: "var(--gold)",
  paid: "var(--success)", overdue: "var(--danger)", cancelled: "var(--ink-soft)"
};

const money = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<InvoiceForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch("/invoices");
    if (res.ok) { const j = await res.json(); setInvoices(j.invoices ?? []); setKpis(j.kpis ?? null); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live totals — the server recomputes these authoritatively on save.
  const lines = form.items.map(i => money((Number(i.quantity) || 0) * (Number(i.unitPrice) || 0)));
  const subtotal = money(lines.reduce((a, b) => a + b, 0));
  const vatRate = Number(form.vatRate) || 0;
  const vatAmount = money((subtotal * vatRate) / 100);
  const total = money(subtotal + vatAmount);

  function setItem(idx: number, patch: Partial<ItemRow>) {
    setForm(f => ({ ...f, items: f.items.map((it, n) => n === idx ? { ...it, ...patch } : it) }));
  }
  function addItem() { setForm(f => ({ ...f, items: [...f.items, { description: "", quantity: "1", unitPrice: "" }] })); }
  function removeItem(idx: number) {
    setForm(f => ({ ...f, items: f.items.filter((_, n) => n !== idx) }));
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const editing = editingId !== null;
      const res = await apiFetch(editing ? `/invoices/${editingId}` : "/invoices", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: form.customerName,
          customerPhone: form.customerPhone || null,
          customerEmail: form.customerEmail || null,
          customerTin: form.customerTin || null,
          customerAddress: form.customerAddress || null,
          issueDate: form.issueDate || undefined,
          dueDate: form.dueDate || null,
          paymentTerms: form.paymentTerms || null,
          notes: form.notes || null,
          vatRate: Number(form.vatRate) || 0,
          items: form.items
            .filter(i => i.description.trim() && Number(i.unitPrice) >= 0)
            .map(i => ({
              description: i.description,
              quantity: Number(i.quantity) || 1,
              unitPrice: Number(i.unitPrice) || 0
            }))
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the invoice.")); return; }
      setNotice(editing ? "Draft updated." : "Invoice created as a draft — open it to print or mark it sent.");
      setForm(EMPTY); setEditingId(null); setShowForm(false);
      load();
    } finally { setBusy(false); }
  }

  function startEdit(inv: Invoice) {
    setEditingId(inv.id);
    setError(null); setNotice(null);
    // Prefill needs the full invoice — fetch the detail.
    (async () => {
      const res = await apiFetch(`/invoices/${inv.id}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not load the invoice.")); return; }
      setForm({
        customerName: j.customer_name ?? "", customerPhone: "", customerEmail: j.customer_email ?? "",
        customerTin: j.customer_tin ?? "", customerAddress: j.customer_address ?? "",
        issueDate: j.issue_date ? String(j.issue_date).slice(0, 10) : "",
        dueDate: j.due_date ? String(j.due_date).slice(0, 10) : "",
        paymentTerms: j.payment_terms ?? "", notes: j.notes ?? "",
        vatRate: String(Number(j.vat_rate ?? 18)),
        items: (j.items ?? []).length
          ? (j.items as any[]).map(it => ({
              description: it.description, quantity: String(Number(it.quantity)),
              unitPrice: String(Number(it.unit_price))
            }))
          : [{ description: "", quantity: "1", unitPrice: "" }]
      });
      setShowForm(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    })();
  }

  async function markSent(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/invoices/${id}/status`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "sent" })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed."));
    else setNotice("Invoice issued — it is now visible as sent. Use Print on the invoice page to share it.");
    load();
  }

  async function cancel(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/invoices/${id}/status`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed."));
    load();
  }

  async function remove(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/invoices/${id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed to delete."));
    load();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };
  const kpi = (label: string, value: number, color: string) => (
    <div className={`${card}`} style={cardStyle}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</p>
      <p className="mt-8 text-xl font-bold tabular-nums" style={{ color }}>TZS {fmt(value)}</p>
    </div>
  );

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Invoices</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Customer invoices with 18% VAT, payment tracking and print-ready output.
          </p>
        </div>
        <button type="button" onClick={() => { setForm(EMPTY); setEditingId(null); setShowForm(s => !s); }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ New invoice"}
        </button>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {kpis && (
        <section className="mt-24 grid grid-cols-2 gap-16 lg:grid-cols-4">
          {kpi("Invoiced", kpis.invoiced, "var(--ink)")}
          {kpi("Received", kpis.received, "var(--success)")}
          {kpi("Outstanding", kpis.outstanding, "var(--gold)")}
          {kpi("Overdue invoices", kpis.overdue, kpis.overdue > 0 ? "var(--danger)" : "var(--ink)")}
        </section>
      )}

      {showForm && (
        <form onSubmit={submit} className="mt-24 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
          <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
            {editingId ? "Edit draft" : "New invoice"}
          </p>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Customer *</span>
              <input required value={form.customerName}
                onChange={e => setForm(f => ({ ...f, customerName: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Customer phone</span>
              <input value={form.customerPhone} placeholder="+255712345678"
                onChange={e => setForm(f => ({ ...f, customerPhone: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Customer email</span>
              <input type="email" value={form.customerEmail}
                onChange={e => setForm(f => ({ ...f, customerEmail: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Customer TIN</span>
              <input value={form.customerTin}
                onChange={e => setForm(f => ({ ...f, customerTin: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Customer address</span>
              <input value={form.customerAddress}
                onChange={e => setForm(f => ({ ...f, customerAddress: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Issue date</span>
              <input type="date" value={form.issueDate}
                onChange={e => setForm(f => ({ ...f, issueDate: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Due date</span>
              <input type="date" value={form.dueDate}
                onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Payment terms</span>
              <input value={form.paymentTerms} placeholder="e.g. Net 30"
                onChange={e => setForm(f => ({ ...f, paymentTerms: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>VAT rate (%)</span>
              <input type="number" min={0} max={100} step="0.01" value={form.vatRate}
                onChange={e => setForm(f => ({ ...f, vatRate: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>

          <div className="border-t pt-16" style={{ borderColor: "var(--line)" }}>
            <div className="mb-8 flex items-center justify-between">
              <span className={labelCls} style={{ color: "var(--ink-soft)", marginBottom: 0 }}>Line items</span>
              <button type="button" onClick={addItem}
                className="rounded-input border px-12 py-4 text-xs font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}>+ Add line</button>
            </div>
            <div className="space-y-8">
              {form.items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_90px_130px_130px_32px] items-end gap-8">
                  <label className="block">
                    {idx === 0 && <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Description</span>}
                    <input required value={it.description}
                      onChange={e => setItem(idx, { description: e.target.value })}
                      placeholder="e.g. Freight — Dar es Salaam to Mwanza, 25 t"
                      className={inputCls} style={inputStyle} />
                  </label>
                  <label className="block">
                    {idx === 0 && <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Qty</span>}
                    <input type="number" min={0} step="0.01" value={it.quantity}
                      onChange={e => setItem(idx, { quantity: e.target.value })}
                      className={inputCls} style={inputStyle} />
                  </label>
                  <label className="block">
                    {idx === 0 && <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Unit price</span>}
                    <input type="number" min={0} step="0.01" value={it.unitPrice}
                      onChange={e => setItem(idx, { unitPrice: e.target.value })}
                      className={inputCls} style={inputStyle} />
                  </label>
                  <div className="pb-8 text-right text-sm tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {fmt(lines[idx] ?? 0)}
                  </div>
                  <button type="button" aria-label="Remove line"
                    className="pb-8 text-sm underline disabled:opacity-30"
                    style={{ color: "var(--danger)" }}
                    disabled={form.items.length === 1}
                    onClick={() => removeItem(idx)}>x</button>
                </div>
              ))}
            </div>
          </div>

          <div className="ml-auto w-full max-w-[320px] space-y-4 rounded-card border p-16 text-sm" style={cardStyle}>
            <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
              <span>Subtotal</span><span className="tabular-nums">TZS {fmt(subtotal)}</span>
            </div>
            <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
              <span>VAT ({vatRate}%)</span><span className="tabular-nums">TZS {fmt(vatAmount)}</span>
            </div>
            <div className="flex justify-between border-t pt-8 font-bold" style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
              <span>Total</span><span className="tabular-nums">TZS {fmt(total)}</span>
            </div>
          </div>

          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
            <textarea rows={2} value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>

          <button type="submit" disabled={busy || subtotal <= 0}
            className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving…" : (editingId ? "Save draft" : "Create invoice")}
          </button>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            Invoices start as drafts. Open one to print it or mark it sent; payments are recorded there too.
          </p>
        </form>
      )}

      <div className="mt-24 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Invoice</th><th className="p-12">Customer</th>
              <th className="p-12">Issued</th><th className="p-12">Due</th>
              <th className="p-12">Total</th><th className="p-12">Paid</th>
              <th className="p-12">Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv, i) => (
              <tr key={inv.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                  <Link href={`/app/cfa/invoices/${inv.id}`} className="underline">{inv.invoice_number}</Link>
                </td>
                <td className="p-12" style={{ color: "var(--ink)" }}>
                  {inv.customer_name}
                  {inv.customer_tin && <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>TIN {inv.customer_tin}</span>}
                </td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {inv.issue_date ? new Date(inv.issue_date).toLocaleDateString() : "—"}
                </td>
                <td className="p-12 tabular-nums" style={{
                  color: inv.effective_status === "overdue" ? "var(--danger)" : "var(--ink-soft)"
                }}>
                  {inv.due_date ? new Date(inv.due_date).toLocaleDateString() : "—"}
                </td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(inv.total))}</td>
                <td className="p-12 tabular-nums" style={{ color: "var(--success)" }}>{fmt(Number(inv.amount_paid))}</td>
                <td className="p-12">
                  <span className="px-8 py-4 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${STATUS_COLORS[inv.effective_status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                    {STATUS_LABELS[inv.effective_status] ?? inv.effective_status}
                  </span>
                </td>
                <td className="p-12 text-right whitespace-nowrap">
                  {inv.status === "draft" && (
                    <>
                      <button type="button" className="mr-12 underline" style={{ color: "var(--brand)" }}
                        onClick={() => markSent(inv.id)}>Send</button>
                      <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                        onClick={() => startEdit(inv)}>Edit</button>
                    </>
                  )}
                  {inv.status !== "cancelled" && inv.effective_status !== "paid" && (
                    <button type="button" className="mr-12 underline" style={{ color: "var(--danger)" }}
                      onClick={() => cancel(inv.id)}>Cancel</button>
                  )}
                  {Number(inv.amount_paid) === 0 && (
                    <button type="button" className="underline" style={{ color: "var(--danger)" }}
                      onClick={() => remove(inv.id)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No invoices yet — create your first one above.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
