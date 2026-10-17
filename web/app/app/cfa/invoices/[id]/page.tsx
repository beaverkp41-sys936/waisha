"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiFetch } from "../../../api-client";
import {
  BASIS_PRINT, SECTIONS, SECTION_SHORT, SECTION_TITLES, TAX_LABELS, type TaxKind
} from "../../proforma/shared";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface InvoiceItem {
  id: string; seq: number; description: string; quantity: string; unit: string | null;
  unit_price: string; amount: string;
  section: string | null; catalog_code: string | null; basis: string | null;
  tax_kind: string; tax_rate: string; tax_amount: string;
}

interface InvoiceDetail {
  id: string; invoice_number: string; customer_name: string;
  customer_phone: string | null; customer_email: string | null;
  customer_tin: string | null; customer_address: string | null;
  issue_date: string; due_date: string | null; payment_terms: string | null;
  currency: string; vat_rate: string; subtotal: string; vat_amount: string;
  total: string; amount_paid: string; status: string; effective_status: string;
  notes: string | null; payment_instructions: string | null; created_at: string;
  source_quotation_id: string | null;
  items: InvoiceItem[];
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
const money = (n: number) => Math.round(n * 100) / 100;
/** A converted proforma bills tax per line, so the line the customer reads is
 * the charge plus that line's own tax. */
const lineTotal = (it: InvoiceItem) => money(Number(it.amount) + Number(it.tax_amount));
const blockOf = (it: InvoiceItem) => it.section ?? "transport";

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

  const balance = money(Number(inv.total) - Number(inv.amount_paid));
  const lh = inv.letterhead;
  /** Only a converted proforma carries the three statutory blocks; a plain
   * invoice has no sections to print and must not be shown any. */
  const billed = inv.source_quotation_id != null;
  /** Excise lives only on its own line, and the invoice header has no column for
   * it — footed from the lines so the printed figures still add up. */
  const excise = money(inv.items.reduce((a, it) => a + (it.tax_kind === "excise" ? Number(it.tax_amount) : 0), 0));

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
      <div className="invoice-sheet mt-24 rounded-card border bg-surface p-32" style={{ borderColor: "var(--line)" }}>
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
        <div className="grid grid-cols-1 gap-24 py-24 sm:grid-cols-2">
          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Bill to</p>
            <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{inv.customer_name}</p>
            {inv.customer_address && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{inv.customer_address}</p>}
            {inv.customer_tin && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>TIN: {inv.customer_tin}</p>}
            {inv.customer_phone && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{inv.customer_phone}</p>}
            {inv.customer_email && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{inv.customer_email}</p>}
          </div>
          <div className="text-xs sm:text-right" style={{ color: "var(--ink)" }}>
            <p><span style={{ color: "var(--ink-soft)" }}>Issue date: </span>{new Date(inv.issue_date).toLocaleDateString()}</p>
            {inv.due_date && <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Due date: </span>{new Date(inv.due_date).toLocaleDateString()}</p>}
            {inv.payment_terms && <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Payment terms: </span>{inv.payment_terms}</p>}
            <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Currency: </span>{inv.currency}</p>
            {billed && (
              <p className="mt-4">
                <span style={{ color: "var(--ink-soft)" }}>Billed from: </span>
                <Link href={`/app/cfa/proforma/${inv.source_quotation_id}`} className="underline">
                  the proforma it was converted from
                </Link>
              </p>
            )}
          </div>
        </div>

        {/* Charges. A bill converted from a proforma prints the three statutory
            blocks in the order the office clears them in; a plain invoice prints
            the one list it was raised with. */}
        {billed ? (
          SECTIONS.map(section => {
            const rows = inv.items.filter(it => blockOf(it) === section);
            if (!rows.length) return null;
            const block = money(rows.reduce((a, it) => a + lineTotal(it), 0));
            return (
              <section key={section} className="mt-8">
                <h2 className="border-b pb-8 text-xs font-bold uppercase tracking-[0.12em]"
                  style={{ borderColor: "var(--ink)", color: "var(--ink)" }}>
                  {SECTION_TITLES[section]}
                </h2>
                <div className="overflow-x-auto sheet-scroll">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b text-left" style={{ borderColor: "var(--line)" }}>
                        <th className="w-[76px] p-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Code</th>
                        <th className="p-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Description</th>
                        <th className="w-[76px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Qty</th>
                        <th className="w-[110px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Unit price</th>
                        <th className="w-[110px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Charge</th>
                        <th className="w-[132px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Statutory tax</th>
                        <th className="w-[110px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Line total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(it => {
                        const basis = BASIS_PRINT[it.basis ?? ""] ?? "";
                        return (
                          <tr key={it.id} className="border-b align-top" style={{ borderColor: "var(--line)" }}>
                            <td className="p-8 text-[10px] font-semibold uppercase" style={{ color: "var(--ink-soft)" }}>
                              {it.catalog_code ?? "—"}
                            </td>
                            <td className="p-8" style={{ color: "var(--ink)" }}>
                              {it.description}
                              {basis && <span className="ml-8 text-[10px] italic" style={{ color: "var(--ink-soft)" }}> ({basis})</span>}
                            </td>
                            <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                              {fmt(Number(it.quantity))}{it.unit ? ` ${it.unit}` : ""}
                            </td>
                            <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(it.unit_price))}</td>
                            <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(it.amount))}</td>
                            <td className="p-8 text-right text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {it.tax_kind === "none"
                                ? "—"
                                : `${TAX_LABELS[it.tax_kind as TaxKind] ?? it.tax_kind} ${Number(it.tax_rate)}% · ${fmt(Number(it.tax_amount))}`}
                            </td>
                            <td className="p-8 text-right font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{fmt(lineTotal(it))}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t" style={{ borderColor: "var(--ink)" }}>
                        <td colSpan={6} className="p-8 text-right text-[11px] font-bold uppercase tracking-[0.12em]"
                          style={{ color: "var(--ink-soft)" }}>
                          {SECTION_SHORT[section]} block subtotal
                        </td>
                        <td className="p-8 text-right font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                          {inv.currency} {fmt(block)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>
            );
          })
        ) : (
          <div className="overflow-x-auto sheet-scroll">
            <table className="w-full min-w-[520px] text-sm">
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
          </div>
        )}

        {/* Totals */}
        <div className={billed ? "mt-24 grid grid-cols-1 gap-24 sm:grid-cols-2" : "mt-24"}>
          {billed && (
            <div className="min-w-0">
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>As laid out on this document</p>
              <table className="w-full max-w-[420px] text-sm">
                <tbody>
                  {SECTIONS.map(s => {
                    const rows = inv.items.filter(it => blockOf(it) === s);
                    if (!rows.length) return null;
                    return (
                      <tr key={s}>
                        <td className="py-4" style={{ color: "var(--ink-soft)" }}>{SECTION_SHORT[s]}</td>
                        <td className="py-4 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                          {inv.currency} {fmt(money(rows.reduce((a, it) => a + lineTotal(it), 0)))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className={`space-y-4 text-sm ${billed ? "" : "ml-auto w-full max-w-[340px]"}`}>
            <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
              <span>{billed ? "Charges before tax" : "Subtotal"}</span>
              <span className="tabular-nums">{inv.currency} {fmt(Number(inv.subtotal))}</span>
            </div>
            <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
              <span>{billed ? "VAT on the lines" : `VAT (${Number(inv.vat_rate)}%)`}</span>
              <span className="tabular-nums">{inv.currency} {fmt(Number(inv.vat_amount))}</span>
            </div>
            {excise > 0 && (
              <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
                <span>Excise on the lines</span>
                <span className="tabular-nums">{inv.currency} {fmt(excise)}</span>
              </div>
            )}
            <div className="flex justify-between border-t pt-8 text-base font-bold" style={{ borderColor: "var(--ink)", color: "var(--ink)" }}>
              <span>{billed ? "Total payable" : "Total"}</span>
              <span className="tabular-nums">{inv.currency} {fmt(Number(inv.total))}</span>
            </div>
            <div className="flex justify-between" style={{ color: "var(--success)" }}>
              <span>Amount paid</span><span className="tabular-nums">{inv.currency} {fmt(Number(inv.amount_paid))}</span>
            </div>
            <div className="flex justify-between font-bold" style={{ color: balance > 0 ? "var(--gold)" : "var(--success)" }}>
              <span>Balance due</span><span className="tabular-nums">{inv.currency} {fmt(balance)}</span>
            </div>
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

        {/* What the customer has already settled travels with the paper. */}
        {inv.payments.length > 0 && (
          <div className="mt-24 border-t pt-16" style={{ borderColor: "var(--line)" }}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Payments received</p>
            <div className="overflow-x-auto sheet-scroll">
              <table className="w-full min-w-[480px] text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className="p-12 text-[10px] uppercase">Date</th>
                    <th className="p-12 text-[10px] uppercase">Method</th>
                    <th className="p-12 text-[10px] uppercase">Reference</th>
                    <th className="p-12 text-right text-[10px] uppercase">Amount ({inv.currency})</th>
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
                <tfoot>
                  <tr className="border-t" style={{ borderColor: "var(--ink)" }}>
                    <td colSpan={3} className="p-8 text-right text-[11px] font-bold uppercase tracking-[0.12em]"
                      style={{ color: "var(--ink-soft)" }}>Total received</td>
                    <td className="p-8 text-right font-bold tabular-nums" style={{ color: "var(--success)" }}>
                      {inv.currency} {fmt(Number(inv.amount_paid))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {inv.notes && (
          <div className="mt-24 border-t pt-16" style={{ borderColor: "var(--line)" }}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</p>
            <p className="text-xs" style={{ color: "var(--ink)" }}>{inv.notes}</p>
          </div>
        )}

        {/* Signature blocks — the sheet is the document the office and the
            customer both sign, so the ruled lines belong to it. */}
        <div className="mt-32 grid grid-cols-1 gap-24 pt-24 sm:grid-cols-2" style={{ borderTop: "1px solid var(--line)" }}>
          {[`For and on behalf of ${lh?.company_name ?? "the issuing company"}`, "Received and accepted by the customer"].map(role => (
            <div key={role} className="sig-block">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{role}</p>
              <p className="mt-24 border-b" style={{ borderColor: "var(--ink)" }} />
              <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>Signature, name and date</p>
            </div>
          ))}
        </div>

        <p className="mt-16 text-[10px]" style={{ color: "var(--ink-soft)" }}>
          Payment terms: {inv.payment_terms ?? "As agreed"} · Please quote the invoice number with your payment.
        </p>
      </div>
      )}

      {/* EFD-style receipt — narrow thermal-roll format */}
      {receiptMode && (
        <div className="receipt-sheet mx-auto mt-24 max-w-[320px] border bg-surface p-16 text-xs"
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
            {excise > 0 && <div className="flex justify-between"><span>Excise</span><span className="tabular-nums">{fmt(excise)}</span></div>}
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

      {/* Recording a payment is a desk action, so it stays off the paper. */}
      <section className="no-print mt-24 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
        <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Record a payment</h2>
        {inv.payments.length === 0 && (
          <p className="mt-12 text-sm" style={{ color: "var(--ink-soft)" }}>
            Nothing settled yet — the full {inv.currency} {fmt(balance)} is outstanding.
          </p>
        )}

        {inv.status === "cancelled" ? (
          <p className="mt-12 text-sm" style={{ color: "var(--ink-soft)" }}>
            This invoice was cancelled, so nothing can be recorded against it.
          </p>
        ) : balance <= 0 ? (
          <p className="mt-12 text-sm" style={{ color: "var(--success)" }}>
            Settled in full — {inv.currency} {fmt(Number(inv.amount_paid))} received.
          </p>
        ) : (
          <form onSubmit={recordPayment} className="mt-16 grid grid-cols-1 gap-12 border-t pt-16 sm:grid-cols-2" style={{ borderColor: "var(--line)" }}>
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
            <button type="submit" disabled={busy}
              className="waisha-btn rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-60 sm:col-span-2 sm:justify-self-start">
              {busy ? "Recording…" : "Record payment"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
