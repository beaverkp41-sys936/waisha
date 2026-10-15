"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { portalFetch } from "../api-client";
import { fmt, fmtDate, INVOICE_STATUS_COLORS, errorText } from "../labels";

export default function PortalInvoicesPage() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await portalFetch("/portal/invoices");
        const j = await res.json().catch(() => ({}));
        if (!res.ok) setError(errorText(j, "Could not load your invoices."));
        else setInvoices(j);
      } catch (e: any) {
        if (e.message !== "session ended") setError("Could not load your invoices.");
      } finally { setReady(true); }
    })();
  }, []);

  const outstandingTotal = invoices
    .filter(i => !["paid", "cancelled", "draft"].includes(i.effective_status))
    .reduce((sum, i) => sum + (i.total - i.amount_paid), 0);

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Invoices</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Freight invoices issued to your company, with payment status and balances.
      </p>

      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      {ready && invoices.length > 0 && (
        <div className="mt-24 rounded-card border px-16 py-12 text-sm font-semibold" style={{
          borderColor: outstandingTotal > 0 ? "var(--warning)" : "var(--success)",
          color: "var(--ink)", background: "var(--surface)"
        }}>
          Outstanding balance: {fmt(outstandingTotal)} {invoices[0]?.currency ?? "TZS"}
        </div>
      )}

      {!ready ? (
        <p className="mt-24 text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</p>
      ) : invoices.length === 0 ? (
        <div className="mt-24 rounded-card border bg-surface p-24 text-sm" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
          No invoices yet. Invoices issued to your company will appear here.
        </div>
      ) : (
        <div className="mt-24 overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Invoice</th><th className="p-12">Issued</th><th className="p-12">Due</th>
                <th className="p-12 text-right">Total</th><th className="p-12 text-right">Paid</th>
                <th className="p-12 text-right">Balance</th><th className="p-12">Status</th><th className="p-12"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i, idx) => (
                <tr key={i.id} style={{ background: idx % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{i.invoice_number}</td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>{fmtDate(i.issue_date)}</td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>{fmtDate(i.due_date)}</td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(i.total)}</td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--success)" }}>{fmt(i.amount_paid)}</td>
                  <td className="p-12 text-right tabular-nums font-semibold"
                    style={{ color: i.total - i.amount_paid > 0 ? "var(--danger)" : "var(--ink-soft)" }}>
                    {fmt(i.total - i.amount_paid)}
                  </td>
                  <td className="p-12">
                    <span className="text-xs font-bold uppercase tracking-[0.1em]"
                      style={{ color: INVOICE_STATUS_COLORS[i.effective_status] ?? "var(--ink)" }}>
                      {i.effective_status}
                    </span>
                  </td>
                  <td className="p-12 text-right">
                    <Link href={`/portal/invoices/${i.id}`} className="text-xs underline" style={{ color: "var(--brand)" }}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
