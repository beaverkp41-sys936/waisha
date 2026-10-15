"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { portalFetch } from "../../api-client";
import { fmt, fmtDate, fmtDateTime, INVOICE_STATUS_COLORS, errorText } from "../../labels";

export default function PortalInvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await portalFetch(`/portal/invoices/${params.id}`);
        const j = await res.json().catch(() => ({}));
        if (res.status === 404) setNotFound(true);
        else if (!res.ok) setError(errorText(j, "Could not load this invoice."));
        else { setInvoice(j.invoice); setItems(j.items); setPayments(j.payments); }
      } catch (e: any) {
        if (e.message !== "session ended") setError("Could not load this invoice.");
      } finally { setReady(true); }
    })();
  }, [params.id]);

  if (!ready) {
    return <div className="px-16 py-64 text-center text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</div>;
  }
  if (notFound) {
    return (
      <div className="mx-auto max-w-[640px] px-16 py-64">
        <div className="rounded-card border bg-surface p-24 text-center" style={{ borderColor: "var(--line)" }}>
          <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>Invoice not found</h1>
          <Link href="/portal/invoices" className="mt-16 inline-block text-sm underline" style={{ color: "var(--brand)" }}>
            Back to invoices
          </Link>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto max-w-[640px] px-16 py-64">
        <div role="alert" className="px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>
      </div>
    );
  }
  if (!invoice) return null;

  const balance = invoice.total - invoice.amount_paid;
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <Link href="/portal/invoices" className="text-xs underline" style={{ color: "var(--brand)" }}>← Invoices</Link>
      <div className="mt-12 flex flex-wrap items-center justify-between gap-12">
        <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>{invoice.invoice_number}</h1>
        <span className="px-12 py-6 text-[10px] font-bold uppercase tracking-[0.14em]"
          style={{
            color: INVOICE_STATUS_COLORS[invoice.effective_status] ?? "var(--ink)",
            background: `color-mix(in srgb, ${INVOICE_STATUS_COLORS[invoice.effective_status] ?? "var(--ink)"} 12%, transparent)`,
            borderLeft: `4px solid ${INVOICE_STATUS_COLORS[invoice.effective_status] ?? "var(--ink)"}`
          }}>
          {invoice.effective_status}
        </span>
      </div>

      <div className={`${card} mt-24 grid grid-cols-2 gap-12 md:grid-cols-4`} style={cardStyle}>
        {[
          ["Issued", fmtDate(invoice.issue_date)],
          ["Due", fmtDate(invoice.due_date)],
          ["Currency", invoice.currency],
          ["VAT rate", invoice.vat_rate != null ? `${invoice.vat_rate}%` : "—"]
        ].map(([l, v]) => (
          <div key={l}>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{l}</p>
            <p className="mt-8 text-sm font-semibold" style={{ color: "var(--ink)" }}>{v}</p>
          </div>
        ))}
      </div>

      <div className={`${card} mt-24`} style={cardStyle}>
        <h2 className="mb-16 text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Line items</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="py-8 pr-12">#</th><th className="py-8 pr-12">Description</th>
              <th className="py-8 pr-12 text-right">Qty</th><th className="py-8 pr-12">Unit</th>
              <th className="py-8 pr-12 text-right">Unit price</th><th className="py-8 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.seq} className="border-b" style={{ borderColor: "var(--line)" }}>
                <td className="py-8 pr-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{it.seq}</td>
                <td className="py-8 pr-12" style={{ color: "var(--ink)" }}>{it.description}</td>
                <td className="py-8 pr-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{it.quantity}</td>
                <td className="py-8 pr-12" style={{ color: "var(--ink-soft)" }}>{it.unit ?? "—"}</td>
                <td className="py-8 pr-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(it.unit_price)}</td>
                <td className="py-8 text-right tabular-nums font-semibold" style={{ color: "var(--ink)" }}>{fmt(it.amount)}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={6} className="py-12 text-sm" style={{ color: "var(--ink-soft)" }}>No line items on this invoice.</td></tr>
            )}
          </tbody>
        </table>
        <div className="mt-16 space-y-8 border-t pt-16 text-sm" style={{ borderColor: "var(--line)" }}>
          <div className="flex justify-between"><span style={{ color: "var(--ink-soft)" }}>Subtotal</span><span className="tabular-nums" style={{ color: "var(--ink)" }}>{fmt(invoice.subtotal)}</span></div>
          <div className="flex justify-between"><span style={{ color: "var(--ink-soft)" }}>VAT</span><span className="tabular-nums" style={{ color: "var(--ink)" }}>{fmt(invoice.vat_amount)}</span></div>
          <div className="flex justify-between text-base font-bold"><span style={{ color: "var(--ink)" }}>Total</span><span className="tabular-nums" style={{ color: "var(--ink)" }}>{fmt(invoice.total)} {invoice.currency}</span></div>
          <div className="flex justify-between"><span style={{ color: "var(--ink-soft)" }}>Paid</span><span className="tabular-nums" style={{ color: "var(--success)" }}>{fmt(invoice.amount_paid)}</span></div>
          <div className="flex justify-between font-bold"><span style={{ color: "var(--ink)" }}>Balance due</span><span className="tabular-nums" style={{ color: balance > 0 ? "var(--danger)" : "var(--success)" }}>{fmt(balance)}</span></div>
        </div>
      </div>

      {(invoice.payment_terms || invoice.payment_instructions || invoice.notes) && (
        <div className={`${card} mt-24`} style={cardStyle}>
          <h2 className="mb-16 text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Payment details</h2>
          <dl className="space-y-12 text-sm">
            {invoice.payment_terms && (
              <div><dt className="text-xs font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>Terms</dt>
                <dd className="mt-4" style={{ color: "var(--ink)" }}>{invoice.payment_terms}</dd></div>
            )}
            {invoice.payment_instructions && (
              <div><dt className="text-xs font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>How to pay</dt>
                <dd className="mt-4 whitespace-pre-line" style={{ color: "var(--ink)" }}>{invoice.payment_instructions}</dd></div>
            )}
            {invoice.notes && (
              <div><dt className="text-xs font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>Notes</dt>
                <dd className="mt-4 whitespace-pre-line" style={{ color: "var(--ink)" }}>{invoice.notes}</dd></div>
            )}
          </dl>
        </div>
      )}

      <div className={`${card} mt-24`} style={cardStyle}>
        <h2 className="mb-16 text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Payments recorded</h2>
        {payments.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No payments recorded yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="py-8 pr-12">Date</th><th className="py-8 pr-12">Method</th>
                <th className="py-8 pr-12">Reference</th><th className="py-8 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p, i) => (
                <tr key={i} className="border-b" style={{ borderColor: "var(--line)" }}>
                  <td className="py-8 pr-12" style={{ color: "var(--ink-soft)" }}>{fmtDateTime(p.paid_at)}</td>
                  <td className="py-8 pr-12" style={{ color: "var(--ink)" }}>{p.method}</td>
                  <td className="py-8 pr-12" style={{ color: "var(--ink-soft)" }}>{p.reference ?? "—"}</td>
                  <td className="py-8 text-right tabular-nums font-semibold" style={{ color: "var(--success)" }}>{fmt(p.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
