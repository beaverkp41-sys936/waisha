"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

/** issue_date arrives as plain "YYYY-MM-DD". Reading it at noon keeps the day the
    clerk chose whatever the browser's offset is — parsing it as UTC would lose a day west of Greenwich. */
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString();

interface Note {
  id: string; debit_note_number: string; customer_name: string;
  customer_tin: string | null; reason: string; reference: string | null;
  related_invoice_id: string | null; against_invoice_number: string | null;
  issue_date: string; currency: string; subtotal: string; vat_amount: string;
  total: string; status: string; created_at: string;
}
interface Kpis { debited: number; issued_total: number; drafts: number; cancelled: number; }
interface InvoiceLite { id: string; invoice_number: string; customer_name: string; status: string; }

interface ItemRow { description: string; quantity: string; unit: string; unitPrice: string; }
interface NoteForm {
  customerName: string; customerPhone: string; customerEmail: string;
  customerTin: string; customerAddress: string;
  reason: string; reference: string; relatedInvoiceId: string;
  issueDate: string; currency: string; vatRate: string; notes: string;
  items: ItemRow[];
}
const EMPTY: NoteForm = {
  customerName: "", customerPhone: "", customerEmail: "", customerTin: "",
  customerAddress: "", reason: "", reference: "", relatedInvoiceId: "",
  issueDate: "", currency: "TZS", vatRate: "18", notes: "",
  items: [{ description: "", quantity: "1", unit: "", unitPrice: "" }]
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft", issued: "Issued", cancelled: "Cancelled"
};
const STATUS_COLORS: Record<string, string> = {
  draft: "var(--ink-soft)", issued: "var(--success)", cancelled: "var(--danger)"
};
const CURRENCIES = ["TZS", "USD", "EUR", "GBP", "CNY"];

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DebitNotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [invoices, setInvoices] = useState<InvoiceLite[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<NoteForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [arm, setArm] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    const res = await apiFetch("/debit-notes");
    const j = await res.json().catch(() => ({}));
    if (res.ok) { setNotes(j.notes ?? []); setKpis(j.kpis ?? null); }
    else setError(errorText(j, "Could not load the debit notes."));
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);

  const openForm = useCallback(async (n?: Note) => {
    setError(null); setNotice(null); setCancelId(null);
    if (n) {
      const res = await apiFetch(`/debit-notes/${n.id}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not load the note.")); return; }
      setForm({
        customerName: j.customer_name ?? "", customerPhone: j.customer_phone ?? "",
        customerEmail: j.customer_email ?? "", customerTin: j.customer_tin ?? "",
        customerAddress: j.customer_address ?? "", reason: j.reason ?? "",
        reference: j.reference ?? "", relatedInvoiceId: j.related_invoice_id ?? "",
        issueDate: j.issue_date ? String(j.issue_date).slice(0, 10) : "",
        currency: j.currency ?? "TZS", vatRate: String(Number(j.vat_rate)),
        notes: j.notes ?? "",
        items: (j.items ?? []).map((it: any) => ({
          description: it.description, quantity: String(Number(it.quantity)),
          unit: it.unit ?? "", unitPrice: String(Number(it.unit_price))
        }))
      });
      setEditingId(n.id);
    } else {
      setForm(EMPTY);
      setEditingId(null);
    }
    setShowForm(true);
    const inv = await apiFetch("/invoices");
    const ij = await inv.json().catch(() => ({}));
    if (inv.ok) setInvoices(ij.invoices ?? []);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    const body = {
      customerName: form.customerName,
      customerPhone: form.customerPhone || null,
      customerEmail: form.customerEmail || null,
      customerTin: form.customerTin || null,
      customerAddress: form.customerAddress || null,
      reason: form.reason,
      reference: form.reference || null,
      relatedInvoiceId: form.relatedInvoiceId || null,
      issueDate: form.issueDate || undefined,
      currency: form.currency,
      vatRate: Number(form.vatRate) || 0,
      notes: form.notes || null,
      items: form.items.map(it => ({
        description: it.description, quantity: Number(it.quantity) || 0,
        unit: it.unit || null, unitPrice: Number(it.unitPrice) || 0
      }))
    };
    const res = await apiFetch(editingId ? `/debit-notes/${editingId}` : "/debit-notes", {
      method: editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(errorText(j, "The note could not be saved.")); return; }
    setNotice(editingId ? "Draft updated." : "Debit note raised as a draft — issue it from the desk when it has been checked.");
    setShowForm(false); setEditingId(null);
    load();
  };

  const issue = async (n: Note) => {
    setBusy(true); setError(null); setNotice(null);
    const res = await apiFetch(`/debit-notes/${n.id}/issue`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(errorText(j, "The note could not be issued.")); return; }
    setNotice(`${n.debit_note_number} issued — it is now a record and can only be cancelled.`);
    load();
  };

  const cancel = async (n: Note) => {
    if (cancelReason.trim().length < 4) {
      setError("Say why the note is being cancelled — a cancellation without a reason cannot be defended.");
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    const res = await apiFetch(`/debit-notes/${n.id}/cancel`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: cancelReason.trim() })
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(errorText(j, "The note could not be cancelled.")); return; }
    setNotice(`${n.debit_note_number} cancelled.`);
    setCancelId(null); setCancelReason("");
    load();
  };

  const remove = async (n: Note) => {
    // The only action here that cannot be undone, so a first tap arms it and the
    // second one deletes — the same shape the payroll desk uses.
    const key = `del:${n.id}`;
    if (arm !== key) {
      setArm(key);
      setTimeout(() => setArm(a => (a === key ? null : a)), 6000);
      return;
    }
    setArm(null);
    setBusy(true); setError(null); setNotice(null);
    const res = await apiFetch(`/debit-notes/${n.id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(errorText(j, "The note could not be deleted.")); return; }
    setNotice(`${n.debit_note_number} deleted.`);
    load();
  };

  const inputCls = "w-full rounded-input border bg-transparent px-12 py-8 text-sm outline-none focus:border-current";
  const inputStyle = { borderColor: "var(--line)", color: "var(--ink)" };
  const cardStyle = { borderColor: "var(--line)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const money = (n: number) => Math.round(n * 100) / 100;
  const formTotals = (() => {
    const lines = form.items.map(it => money((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0)));
    const subtotal = money(lines.reduce((a, b) => a + b, 0));
    const vat = money((subtotal * (Number(form.vatRate) || 0)) / 100);
    return { subtotal, vat, total: money(subtotal + vat) };
  })();

  const kpi = (label: string, value: string | number, color: string) => (
    <div className="rounded-card border bg-surface p-16" style={cardStyle}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</p>
      <p className="mt-8 text-lg font-bold tabular-nums" style={{ color }}>{value}</p>
    </div>
  );

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Debit notes</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Charges raised after the bill was written — demurrage, re-worked entries, extra handling.
            A note is issued once, then it is a record.
          </p>
        </div>
        <button type="button" onClick={() => showForm ? setShowForm(false) : openForm()}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ New debit note"}
        </button>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {kpis && (
        <section className="mt-24 grid grid-cols-2 gap-16 lg:grid-cols-4">
          {kpi("Debited (all notes)", fmt(kpis.debited), "var(--ink)")}
          {kpi("Issued", fmt(kpis.issued_total), "var(--success)")}
          {kpi("Drafts", String(kpis.drafts), "var(--gold)")}
          {kpi("Cancelled", String(kpis.cancelled), "var(--ink-soft)")}
        </section>
      )}

      {showForm && (
        <form onSubmit={submit} className="mt-24 space-y-12 rounded-card border bg-surface p-24" style={cardStyle}>
          <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
            {editingId ? "Edit draft" : "New debit note"}
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
            <label className="block col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Why the debit *</span>
              <input required minLength={4} maxLength={600} value={form.reason}
                placeholder="e.g. Demurrage beyond seven free days on BL ..."
                onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Reference (BL / file)</span>
              <input value={form.reference}
                onChange={e => setForm(f => ({ ...f, reference: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Against invoice</span>
              <select value={form.relatedInvoiceId}
                onChange={e => setForm(f => ({ ...f, relatedInvoiceId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">— none —</option>
                {invoices.map(i => (
                  <option key={i.id} value={i.id}>{i.invoice_number} · {i.customer_name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Issue date</span>
              <input type="date" value={form.issueDate}
                onChange={e => setForm(f => ({ ...f, issueDate: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Currency</span>
              <select value={form.currency}
                onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}
                className={inputCls} style={inputStyle}>
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>VAT rate (%)</span>
              <input type="number" min={0} max={100} step="0.01" value={form.vatRate}
                onChange={e => setForm(f => ({ ...f, vatRate: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
              <input value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>

          <div className="pt-8">
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Charges</p>
            {form.items.map((it, n) => (
              <div key={n} className="mb-8 grid grid-cols-12 gap-8">
                <input required placeholder="Description" value={it.description}
                  onChange={e => setForm(f => ({ ...f, items: f.items.map((x, i) => i === n ? { ...x, description: e.target.value } : x) }))}
                  className={`${inputCls} col-span-6`} style={inputStyle} />
                <input required type="number" min={0} step="0.01" placeholder="Qty" value={it.quantity}
                  onChange={e => setForm(f => ({ ...f, items: f.items.map((x, i) => i === n ? { ...x, quantity: e.target.value } : x) }))}
                  className={`${inputCls} col-span-2`} style={inputStyle} />
                <input placeholder="Unit" value={it.unit}
                  onChange={e => setForm(f => ({ ...f, items: f.items.map((x, i) => i === n ? { ...x, unit: e.target.value } : x) }))}
                  className={`${inputCls} col-span-2`} style={inputStyle} />
                <input required type="number" min={0} step="0.01" placeholder="Unit price" value={it.unitPrice}
                  onChange={e => setForm(f => ({ ...f, items: f.items.map((x, i) => i === n ? { ...x, unitPrice: e.target.value } : x) }))}
                  className={`${inputCls} col-span-2`} style={inputStyle} />
              </div>
            ))}
            <button type="button"
              onClick={() => setForm(f => ({ ...f, items: [...f.items, { description: "", quantity: "1", unit: "", unitPrice: "" }] }))}
              className="text-xs underline" style={{ color: "var(--brand)" }}>+ Add a line</button>
            {form.items.length > 1 && (
              <button type="button"
                onClick={() => setForm(f => ({ ...f, items: f.items.slice(0, -1) }))}
                className="ml-16 text-xs underline" style={{ color: "var(--ink-soft)" }}>Remove last</button>
            )}
          </div>

          <div className="flex items-center justify-between border-t pt-12" style={{ borderColor: "var(--line)" }}>
            <p className="text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
              Subtotal {fmt(formTotals.subtotal)} · VAT {fmt(formTotals.vat)} ·{" "}
              <span className="font-bold" style={{ color: "var(--ink)" }}>Total {fmt(formTotals.total)} {form.currency}</span>
            </p>
            <button type="submit" disabled={busy}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
              {editingId ? "Save draft" : "Raise the note"}
            </button>
          </div>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            Notes start as drafts. Open one to print it or issue it; an issued note is frozen and can only be cancelled with a reason.
          </p>
        </form>
      )}

      <div className="mt-24 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Note</th><th className="p-12">Customer</th>
              <th className="p-12">Why</th><th className="p-12">Against</th>
              <th className="p-12">Issued on</th>
              <th className="p-12 text-right">Total</th>
              <th className="p-12">Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {notes.map((n, i) => (
              <Fragment key={n.id}>
                <tr style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                    <Link href={`/app/cfa/debitnotes/${n.id}`} className="underline">{n.debit_note_number}</Link>
                  </td>
                  <td className="p-12" style={{ color: "var(--ink)" }}>
                    {n.customer_name}
                    {n.customer_tin && <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>TIN {n.customer_tin}</span>}
                  </td>
                  <td className="p-12 max-w-[240px] truncate text-xs" style={{ color: "var(--ink-soft)" }} title={n.reason}>{n.reason}</td>
                  <td className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {n.related_invoice_id ? (
                      <Link href={`/app/cfa/invoices/${n.related_invoice_id}`} className="underline">{n.against_invoice_number}</Link>
                    ) : (n.reference || "—")}
                  </td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {n.issue_date ? dayLabel(n.issue_date) : "—"}
                  </td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(n.total))}</td>
                  <td className="p-12">
                    <span className="px-8 py-4 text-[10px] font-bold uppercase"
                      style={{ borderLeft: `4px solid ${STATUS_COLORS[n.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                      {STATUS_LABELS[n.status] ?? n.status}
                    </span>
                  </td>
                  <td className="p-12 text-right whitespace-nowrap">
                    {n.status === "draft" && (
                      <>
                        <button type="button" className="mr-12 underline" style={{ color: "var(--brand)" }}
                          onClick={() => issue(n)}>Issue</button>
                        <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                          onClick={() => openForm(n)}>Edit</button>
                      </>
                    )}
                    {n.status !== "cancelled" && (
                      <button type="button" className="mr-12 underline" style={{ color: "var(--danger)" }}
                        onClick={() => { setCancelId(cancelId === n.id ? null : n.id); setCancelReason(""); }}>Cancel</button>
                    )}
                    {n.status === "draft" && (
                      <button type="button" className="underline" style={{ color: "var(--danger)" }}
                        onClick={() => remove(n)}>
                        {arm === `del:${n.id}` ? "Tap again to delete" : "Delete"}
                      </button>
                    )}
                  </td>
                </tr>
                {cancelId === n.id && (
                  <tr style={{ background: "var(--milk-deep)" }}>
                    <td colSpan={8} className="p-12">
                      <div className="flex items-center gap-12">
                        <input autoFocus value={cancelReason} maxLength={600}
                          placeholder="Why is this note being cancelled?"
                          onChange={e => setCancelReason(e.target.value)}
                          className={`${inputCls} max-w-[420px] flex-1`} style={inputStyle} />
                        <button type="button" disabled={busy} onClick={() => cancel(n)}
                          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
                          Confirm cancel
                        </button>
                        <button type="button" onClick={() => { setCancelId(null); setCancelReason(""); }}
                          className="text-xs underline" style={{ color: "var(--ink-soft)" }}>Keep it</button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!loaded && (
              <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>Loading the register…</td></tr>
            )}
            {loaded && notes.length === 0 && (
              <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No debit notes yet — raise the first one above.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
