"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch } from "../../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface InvoiceDetail {
  id: string; invoice_number: string; customer_name: string;
  customer_phone: string | null; customer_email: string | null;
  customer_tin: string | null; customer_address: string | null;
  issue_date: string; due_date: string | null; payment_terms: string | null;
  currency: string; vat_rate: string; subtotal: string; vat_amount: string;
  total: string; amount_paid: string; status: string; effective_status: string;
  notes: string | null; payment_instructions: string | null; created_at: string;
  items: { id: string; seq: number; description: string; quantity: string; unit: string | null; unit_price: string; amount: string }[];
  payments: { id: string; amount: string; method: string; reference: string | null; paid_at: string; notes: string | null }[];
  letterhead: {
    company_name: string | null; tin_display: string | null; brela_number: string | null;
    vat_number: string | null; website: string | null; postal_address: string | null;
    street: string | null; branch_email: string | null; logo_document_id: string | null;
  } | null;
  qr_data_url: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", sent: "Sent", partial: "Partially paid",
  paid: "Paid", overdue: "Overdue", cancelled: "Cancelled"
};
const METHOD_LABELS: Record<string, string> = {
  cash: "Cash", bank: "Bank transfer", mobile_money: "Mobile money",
  cheque: "Cheque", other: "Other"
};
const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [inv, setInv] = useState<InvoiceDetail | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [receiptMode, setReceiptMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pay, setPay] = useState({ amount: "", method: "cash", reference: "", paidAt: "", notes: "" });

  const load = useCallback(async () => {
    const res = await apiFetch(`/invoices/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Invoice not found.")); return; }
    setInv(j);
    if (j.letterhead?.logo_document_id) {
      const lr = await apiFetch(`/documents/${j.letterhead.logo_document_id}/url`);
      if (lr.ok) { const lj = await lr.json(); setLogoUrl(lj.url); }
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function action(kind: "sent" | "cancelled") {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/invoices/${id}/status`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: kind })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed.")); return; }
      setNotice(kind === "sent" ? "Invoice issued." : "Invoice cancelled.");
      await load();
    } finally { setBusy(false); }
  }

  async function recordPayment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/invoices/${id}/payments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: Number(pay.amount),
          method: pay.method,
          reference: pay.reference || null,
          paidAt: pay.paidAt || undefined,
          notes: pay.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to record the payment.")); return; }
      setNotice("Payment recorded.");
      setPay({ amount: "", method: "cash", reference: "", paidAt: "", notes: "" });
      await load();
    } finally { setBusy(false); }
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  if (error && !inv) {
    return (
      <div className="mx-auto max-w-[900px] px-16 py-32">
        <div role="alert" className="pane-note px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error} <Link href="/app/cfa/invoices" className="underline">Back to invoices</Link>
        </div>
      </div>
    );
  }
  if (!inv) {
    return <div className="pane-note mx-auto max-w-[900px] px-16 py-32 text-sm">Loading invoice…</div>;
  }

  const balance = Math.round((Number(inv.total) - Number(inv.amount_paid)) * 100) / 100;
  const lh = inv.letterhead;

  return (
    <div className="mx-auto max-w-[860px] px-16 py-32">
      {/* Actions — never printed */}
      <div className="no-print flex flex-wrap items-center justify-between gap-12">
        <Link href="/app/cfa/invoices" className="pane-note text-xs underline">
          ← All invoices
        </Link>
        <div className="flex flex-wrap gap-12">
          {inv.status === "draft" && (
            <button type="button" disabled={busy} onClick={() => action("sent")}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">Mark as sent</button>
          )}
          <button type="button" onClick={() => setReceiptMode(m => !m)}
            className="on-photo-btn px-16 py-8 text-xs font-semibold">
            {receiptMode ? "Invoice view" : "EFD-style receipt"}
          </button>
          <button type="button" onClick={() => window.print()}
            className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">Print / Save PDF</button>
          {inv.status !== "cancelled" && Number(inv.amount_paid) === 0 && (
            <button type="button" disabled={busy} onClick={() => action("cancelled")}
              className="on-photo-btn px-16 py-8 text-xs font-semibold disabled:opacity-50"
              style={{ color: "#ff9d94" }}>Cancel invoice</button>
          )}
        </div>
      </div>
      {error && <div role="alert" className="no-print mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="no-print mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {/* The invoice sheet — everything inside prints */}
      {!receiptMode && (
      <div className="mt-24 rounded-card border bg-surface p-32" style={{ borderColor: "var(--line)" }}>
        {/* Letterhead */}
        <div className="flex items-start justify-between gap-24 border-b pb-24" style={{ borderColor: "var(--ink)" }}>
          <div className="flex items-center gap-16">
            {logoUrl && <img src={logoUrl} alt="Company logo" className="h-64 w-64 object-contain" />}
            <div>
              <p className="text-lg font-bold" style={{ color: "var(--ink)" }}>
                {lh?.company_name ?? "Your company"}
              </p>
              {lh?.postal_address && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{lh.postal_address}{lh.street ? `, ${lh.street}` : ""}</p>}
              {lh?.tin_display && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>TIN: {lh.tin_display}</p>}
              {lh?.brela_number && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>BRELA: {lh.brela_number}</p>}
              {lh?.vat_number && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>VAT: {lh.vat_number}</p>}
              {lh?.branch_email && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{lh.branch_email}</p>}
              {lh?.website && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{lh.website}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold tracking-[0.08em]" style={{ color: "var(--ink)" }}>INVOICE</p>
            <p className="mt-4 text-sm font-semibold" style={{ color: "var(--ink)" }}>{inv.invoice_number}</p>
            <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.14em]"
              style={{ color: inv.effective_status === "overdue" ? "var(--danger)" :
                       inv.effective_status === "paid" ? "var(--success)" : "var(--ink-soft)" }}>
              {STATUS_LABELS[inv.effective_status] ?? inv.effective_status}
            </p>
          </div>
        </div>

        {/* Meta + bill to */}
        <div className="grid grid-cols-2 gap-24 py-24">
          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Bill to</p>
            <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{inv.customer_name}</p>
            {inv.customer_address && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{inv.customer_address}</p>}
            {inv.customer_tin && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>TIN: {inv.customer_tin}</p>}
            {inv.customer_phone && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{inv.customer_phone}</p>}
            {inv.customer_email && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{inv.customer_email}</p>}
          </div>
          <div className="text-right text-xs" style={{ color: "var(--ink)" }}>
            <p><span style={{ color: "var(--ink-soft)" }}>Issue date: </span>{new Date(inv.issue_date).toLocaleDateString()}</p>
            {inv.due_date && <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Due date: </span>{new Date(inv.due_date).toLocaleDateString()}</p>}
            {inv.payment_terms && <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Payment terms: </span>{inv.payment_terms}</p>}
            <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Currency: </span>{inv.currency}</p>
          </div>
        </div>

        {/* Line items */}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--ink)", background: "var(--milk)" }}>
              <th className="p-12">Code</th>
              <th className="p-12">Description</th>
              <th className="p-12 text-right">Qty</th>
              <th className="p-12 text-right">Unit price</th>
              <th className="p-12 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.items.map(it => (
              <tr key={it.id} className="border-b" style={{ borderColor: "var(--line)" }}>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{String(it.seq).padStart(2, "0")}</td>
                <td className="p-12" style={{ color: "var(--ink)" }}>{it.description}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {fmt(Number(it.quantity))}{it.unit ? ` ${it.unit}` : ""}
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(it.unit_price))}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(it.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="mt-16 ml-auto w-full max-w-[340px] space-y-4 text-sm">
          <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
            <span>Subtotal</span><span className="tabular-nums">{inv.currency} {fmt(Number(inv.subtotal))}</span>
          </div>
          <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
            <span>VAT ({Number(inv.vat_rate)}%)</span><span className="tabular-nums">{inv.currency} {fmt(Number(inv.vat_amount))}</span>
          </div>
          <div className="flex justify-between border-t pt-8 text-base font-bold" style={{ borderColor: "var(--ink)", color: "var(--ink)" }}>
            <span>Total</span><span className="tabular-nums">{inv.currency} {fmt(Number(inv.total))}</span>
          </div>
          <div className="flex justify-between" style={{ color: "var(--success)" }}>
            <span>Amount paid</span><span className="tabular-nums">{inv.currency} {fmt(Number(inv.amount_paid))}</span>
          </div>
          <div className="flex justify-between font-bold" style={{ color: balance > 0 ? "var(--gold)" : "var(--success)" }}>
            <span>Balance due</span><span className="tabular-nums">{inv.currency} {fmt(balance)}</span>
          </div>
        </div>

        {/* Where to pay + verification QR */}
        {(inv.payment_instructions || inv.qr_data_url) && (
          <div className="mt-24 flex items-start justify-between gap-24 border-t pt-16" style={{ borderColor: "var(--line)" }}>
            <div className="min-w-0">
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Where to pay</p>
              {inv.payment_instructions
                ? <p className="whitespace-pre-line text-xs" style={{ color: "var(--ink)" }}>{inv.payment_instructions}</p>
                : <p className="text-xs" style={{ color: "var(--ink-soft)" }}>Contact our office for payment details.</p>}
            </div>
            {inv.qr_data_url && (
              <div className="shrink-0 text-center">
                <img src={inv.qr_data_url} alt="Invoice verification QR" className="h-28 w-28" />
                <p className="mt-4 text-[9px]" style={{ color: "var(--ink-soft)" }}>Scan to verify</p>
              </div>
            )}
          </div>
        )}

        {inv.notes && (
          <div className="mt-24 border-t pt-16" style={{ borderColor: "var(--line)" }}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</p>
            <p className="text-xs" style={{ color: "var(--ink)" }}>{inv.notes}</p>
          </div>
        )}
        <p className="mt-16 text-[10px]" style={{ color: "var(--ink-soft)" }}>
          Payment terms: {inv.payment_terms ?? "As agreed"} · Please quote the invoice number with your payment.
        </p>
      </div>
      )}

      {/* EFD-style receipt — narrow thermal-roll format */}
      {receiptMode && (
        <div className="mx-auto mt-24 max-w-[320px] border bg-surface p-16 text-xs"
          style={{ borderColor: "var(--ink)" }}>
          <div className="text-center">
            <p className="font-bold" style={{ color: "var(--ink)" }}>{lh?.company_name ?? "Your company"}</p>
            {lh?.postal_address && <p style={{ color: "var(--ink-soft)" }}>{lh.postal_address}{lh.street ? `, ${lh.street}` : ""}</p>}
            {lh?.tin_display && <p style={{ color: "var(--ink-soft)" }}>TIN: {lh.tin_display}</p>}
            {lh?.vat_number && <p style={{ color: "var(--ink-soft)" }}>VAT: {lh.vat_number}</p>}
            {lh?.branch_email && <p style={{ color: "var(--ink-soft)" }}>{lh.branch_email}</p>}
            <p className="mt-8 font-bold tracking-[0.2em]" style={{ color: "var(--ink)" }}>TAX INVOICE</p>
            <p className="text-[9px]" style={{ color: "var(--ink-soft)" }}>
              EFD-style print — not a fiscal document. Fiscal receipts require a TRA-licensed EFD/VFD.
            </p>
          </div>
          <div className="mt-8 border-t border-b py-8" style={{ borderColor: "var(--ink)" }}>
            <div className="flex justify-between"><span>No:</span><span className="tabular-nums font-bold">{inv.invoice_number}</span></div>
            <div className="flex justify-between"><span>Date:</span><span>{new Date(inv.issue_date).toLocaleDateString()}</span></div>
            {inv.due_date && <div className="flex justify-between"><span>Due:</span><span>{new Date(inv.due_date).toLocaleDateString()}</span></div>}
            <div className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Customer: </span>{inv.customer_name}</div>
            {inv.customer_tin && <div><span style={{ color: "var(--ink-soft)" }}>TIN: </span>{inv.customer_tin}</div>}
          </div>
          <table className="mt-8 w-full">
            <thead>
              <tr className="border-b" style={{ borderColor: "var(--ink)" }}>
                <th className="py-4 text-left font-semibold">Item</th>
                <th className="py-4 text-right font-semibold">Qty</th>
                <th className="py-4 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.items.map(it => (
                <tr key={it.id} className="align-top">
                  <td className="py-4" style={{ color: "var(--ink)" }}>{it.description}</td>
                  <td className="py-4 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                    {fmt(Number(it.quantity))}{it.unit ? ` ${it.unit}` : ""}
                  </td>
                  <td className="py-4 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(it.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-8 space-y-2 border-t pt-8" style={{ borderColor: "var(--ink)" }}>
            <div className="flex justify-between"><span>Subtotal</span><span className="tabular-nums">{fmt(Number(inv.subtotal))}</span></div>
            <div className="flex justify-between"><span>VAT {Number(inv.vat_rate)}%</span><span className="tabular-nums">{fmt(Number(inv.vat_amount))}</span></div>
            <div className="flex justify-between font-bold" style={{ color: "var(--ink)" }}>
              <span>TOTAL {inv.currency}</span><span className="tabular-nums">{fmt(Number(inv.total))}</span>
            </div>
            <div className="flex justify-between"><span>Paid</span><span className="tabular-nums">{fmt(Number(inv.amount_paid))}</span></div>
            <div className="flex justify-between font-bold" style={{ color: "var(--ink)" }}>
              <span>Balance</span><span className="tabular-nums">{fmt(balance)}</span>
            </div>
          </div>
          {inv.qr_data_url && (
            <div className="mt-8 flex justify-center"><img src={inv.qr_data_url} alt="Invoice QR" className="h-28 w-28" /></div>
          )}
          {inv.payment_instructions && (
            <div className="mt-8 whitespace-pre-line text-center" style={{ color: "var(--ink)" }}>{inv.payment_instructions}</div>
          )}
          <p className="mt-8 text-center text-[10px]" style={{ color: "var(--ink-soft)" }}>
            Thank you — quote invoice {inv.invoice_number} with your payment.
          </p>
        </div>
      )}

      {/* Payments — not printed */}
      <section className="no-print mt-24 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
        <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Payments</h2>
        {inv.payments.length > 0 && (
          <table className="mt-16 w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Date</th><th className="p-12">Method</th>
                <th className="p-12">Reference</th><th className="p-12 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.payments.map(p => (
                <tr key={p.id} className="border-b" style={{ borderColor: "var(--line)" }}>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{new Date(p.paid_at).toLocaleDateString()}</td>
                  <td className="p-12" style={{ color: "var(--ink)" }}>{METHOD_LABELS[p.method] ?? p.method}</td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>{p.reference ?? "—"}</td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--success)" }}>{fmt(Number(p.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {inv.payments.length === 0 && (
          <p className="mt-12 text-sm" style={{ color: "var(--ink-soft)" }}>No payments recorded yet.</p>
        )}

        {inv.status !== "cancelled" && balance > 0 && (
          <form onSubmit={recordPayment} className="mt-16 space-y-12 border-t pt-16" style={{ borderColor: "var(--line)" }}>
            <div className="grid grid-cols-2 gap-12">
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Amount ({inv.currency}) *</span>
                <input type="number" required min={0.01} step="0.01" max={balance} value={pay.amount}
                  onChange={e => setPay(p => ({ ...p, amount: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Method</span>
                <select value={pay.method} onChange={e => setPay(p => ({ ...p, method: e.target.value }))}
                  className={inputCls} style={inputStyle}>
                  {Object.entries(METHOD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Reference</span>
                <input value={pay.reference} placeholder="Receipt / txn no."
                  onChange={e => setPay(p => ({ ...p, reference: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Date paid</span>
                <input type="date" value={pay.paidAt}
                  onChange={e => setPay(p => ({ ...p, paidAt: e.target.value }))}
                  className={inputCls} style={inputStyle} />
              </label>
            </div>
            <button type="submit" disabled={busy}
              className="waisha-btn rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-60">
              {busy ? "Recording…" : "Record payment"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
