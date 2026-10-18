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

interface NoteItem {
  id: string; seq: number; description: string; quantity: string;
  unit: string | null; unit_price: string; amount: string;
}
interface NoteDetail {
  id: string; debit_note_number: string; customer_name: string;
  customer_phone: string | null; customer_email: string | null;
  customer_tin: string | null; customer_address: string | null;
  reason: string; reference: string | null;
  related_invoice_id: string | null; against_invoice_number: string | null;
  issue_date: string; currency: string; vat_rate: string;
  subtotal: string; vat_amount: string; total: string;
  status: string; notes: string | null; created_at: string;
  issued_at: string | null; issued_by_name: string | null;
  cancelled_at: string | null; cancelled_by_name: string | null; cancel_reason: string | null;
  items: NoteItem[];
  letterhead: {
    company_name: string | null; tin_display: string | null; brela_number: string | null;
    vat_number: string | null; website: string | null; postal_address: string | null;
    street: string | null; branch_email: string | null; logo_document_id: string | null;
  } | null;
}

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", issued: "Issued", cancelled: "Cancelled"
};
const STATUS_COLORS: Record<string, string> = {
  draft: "var(--ink-soft)", issued: "var(--success)", cancelled: "var(--danger)"
};
const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** issue_date arrives as plain "YYYY-MM-DD"; noon UTC keeps the clerk's day in any offset. */
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString();

export default function DebitNoteDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    const res = await apiFetch(`/debit-notes/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Debit note not found.")); return; }
    setNote(j);
    if (j.letterhead?.logo_document_id) {
      const lr = await apiFetch(`/documents/${j.letterhead.logo_document_id}/url`);
      if (lr.ok) { const lj = await lr.json(); setLogoUrl(lj.url); }
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const issue = async () => {
    setBusy(true); setError(null); setNotice(null);
    const res = await apiFetch(`/debit-notes/${id}/issue`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(errorText(j, "The note could not be issued.")); return; }
    setNotice("Issued — the note is now a record and can only be cancelled with a reason.");
    await load();
  };

  const cancel = async () => {
    if (cancelReason.trim().length < 4) {
      setError("Say why the note is being cancelled — a cancellation without a reason cannot be defended.");
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    const res = await apiFetch(`/debit-notes/${id}/cancel`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: cancelReason.trim() })
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(errorText(j, "The note could not be cancelled.")); return; }
    setNotice("Cancelled. The note stays on the register as a record.");
    setArming(false); setCancelReason("");
    await load();
  };

  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  if (error && !note) {
    return (
      <div className="mx-auto max-w-[860px] px-16 py-32">
        <div role="alert" className="pane-note text-sm">{error}</div>
        <Link href="/app/cfa/debitnotes" className="pane-note mt-16 inline-block text-xs underline">← All debit notes</Link>
      </div>
    );
  }
  if (!note) {
    return <div className="pane-note mx-auto max-w-[900px] px-16 py-32 text-sm">Loading debit note…</div>;
  }

  const lh = note.letterhead;

  return (
    <div className="mx-auto max-w-[860px] px-16 py-32">
      {/* Actions — never printed */}
      <div className="no-print flex flex-wrap items-center justify-between gap-12">
        <Link href="/app/cfa/debitnotes" className="pane-note text-xs underline">← All debit notes</Link>
        <div className="flex flex-wrap gap-12">
          {note.status === "draft" && (
            <button type="button" disabled={busy} onClick={issue}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">Issue note</button>
          )}
          <button type="button" onClick={() => window.print()}
            className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">Print / Save PDF</button>
          {note.status !== "cancelled" && (
            <button type="button" disabled={busy} onClick={() => { setArming(a => !a); setCancelReason(""); }}
              className="on-photo-btn px-16 py-8 text-xs font-semibold disabled:opacity-50"
              style={{ color: "#ff9d94" }}>Cancel note</button>
          )}
        </div>
      </div>
      {arming && (
        <div className="no-print mt-16 flex flex-wrap items-center gap-12 rounded-card border bg-surface p-16" style={{ borderColor: "var(--line)" }}>
          <input autoFocus value={cancelReason} maxLength={600}
            placeholder="Why is this note being cancelled?"
            onChange={e => setCancelReason(e.target.value)}
            className="w-full flex-1 rounded-input border bg-transparent px-12 py-8 text-sm outline-none"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }} />
          <button type="button" disabled={busy} onClick={cancel}
            className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">Confirm cancel</button>
          <button type="button" onClick={() => setArming(false)}
            className="text-xs underline" style={{ color: "var(--ink-soft)" }}>Keep it</button>
        </div>
      )}
      {error && <div role="alert" className="no-print mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="no-print mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {/* The note sheet — everything inside prints */}
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
            <p className="text-2xl font-bold tracking-[0.08em]" style={{ color: "var(--ink)" }}>DEBIT NOTE</p>
            <p className="mt-4 text-sm font-semibold" style={{ color: "var(--ink)" }}>{note.debit_note_number}</p>
            <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.14em]"
              style={{ color: STATUS_COLORS[note.status] ?? "var(--ink-soft)" }}>
              {STATUS_LABELS[note.status] ?? note.status}
            </p>
          </div>
        </div>

        {/* Meta + bill to */}
        <div className="grid grid-cols-1 gap-24 py-24 sm:grid-cols-2">
          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Debited to</p>
            <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{note.customer_name}</p>
            {note.customer_address && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{note.customer_address}</p>}
            {note.customer_tin && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>TIN: {note.customer_tin}</p>}
            {note.customer_phone && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{note.customer_phone}</p>}
            {note.customer_email && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{note.customer_email}</p>}
          </div>
          <div className="text-xs sm:text-right" style={{ color: "var(--ink)" }}>
            <p><span style={{ color: "var(--ink-soft)" }}>Date: </span>{dayLabel(note.issue_date)}</p>
            <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Currency: </span>{note.currency}</p>
            {note.issued_at && (
              <p className="mt-4">
                <span style={{ color: "var(--ink-soft)" }}>Issued: </span>
                {new Date(note.issued_at).toLocaleDateString()}
                {note.issued_by_name ? ` by ${note.issued_by_name}` : ""}
              </p>
            )}
            {note.reference && <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Reference: </span>{note.reference}</p>}
            {note.related_invoice_id && (
              <p className="mt-4">
                <span style={{ color: "var(--ink-soft)" }}>Against: </span>
                <Link href={`/app/cfa/invoices/${note.related_invoice_id}`} className="underline">{note.against_invoice_number}</Link>
              </p>
            )}
          </div>
        </div>

        {/* Why — the sentence that defends the note. It prints. */}
        <section className="mb-16 rounded-input border px-16 py-12" style={{ borderColor: "var(--ink)" }}>
          <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Reason for the debit</p>
          <p className="text-sm" style={{ color: "var(--ink)" }}>{note.reason}</p>
        </section>

        {/* Charges */}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--ink)" }}>
              <th className="p-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Description</th>
              <th className="w-[76px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Qty</th>
              <th className="w-[110px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Unit price</th>
              <th className="w-[110px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {note.items.map(it => (
              <tr key={it.id} className="border-b" style={{ borderColor: "var(--line)" }}>
                <td className="p-8" style={{ color: "var(--ink)" }}>
                  {it.description}{it.unit ? <span className="text-xs" style={{ color: "var(--ink-soft)" }}> · per {it.unit}</span> : null}
                </td>
                <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(it.quantity))}</td>
                <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(it.unit_price))}</td>
                <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(it.amount))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="mt-16 flex justify-end">
          <div className="w-full max-w-[300px] text-sm">
            <div className="flex justify-between py-4">
              <span style={{ color: "var(--ink-soft)" }}>Subtotal</span>
              <span className="tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(note.subtotal))}</span>
            </div>
            <div className="flex justify-between py-4">
              <span style={{ color: "var(--ink-soft)" }}>VAT ({Number(note.vat_rate)}%)</span>
              <span className="tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(note.vat_amount))}</span>
            </div>
            <div className="mt-4 flex justify-between border-t pt-8 text-base font-bold" style={{ borderColor: "var(--ink)", color: "var(--ink)" }}>
              <span>Total due</span>
              <span className="tabular-nums">{fmt(Number(note.total))} {note.currency}</span>
            </div>
          </div>
        </div>

        {note.notes && (
          <section className="mt-20 border-t pt-16" style={{ borderColor: "var(--line)" }}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</p>
            <p className="whitespace-pre-line text-xs" style={{ color: "var(--ink)" }}>{note.notes}</p>
          </section>
        )}

        {note.status === "cancelled" && (
          <section className="mt-16 border-t pt-16" style={{ borderColor: "var(--danger)" }}>
            <p className={labelCls} style={{ color: "var(--danger)" }}>Cancelled</p>
            {note.cancel_reason && <p className="text-sm" style={{ color: "var(--ink)" }}>{note.cancel_reason}</p>}
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              Cancelled{note.cancelled_at ? ` on ${new Date(note.cancelled_at).toLocaleString()}` : ""}
              {note.cancelled_by_name ? ` by ${note.cancelled_by_name}` : ""}.
              This note stays on the register as a record.
            </p>
          </section>
        )}

        <p className="mt-24 border-t pt-16 text-[10px]" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
          This debit note adds to the amount owed on the files it names. It is not a receipt for money received.
        </p>
      </div>
    </div>
  );
}
