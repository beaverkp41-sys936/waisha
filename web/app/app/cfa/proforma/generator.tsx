"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, FileText, Link2, Plus, ShieldAlert, Trash2, X } from "lucide-react";
import { apiFetch } from "../../api-client";
import {
  BASIS_LABELS, BASIS_PRINT, CURRENCIES, SECTION_NOTE, SECTION_SHORT, SECTION_TITLES, SECTIONS,
  SOURCE_LABELS, STATUS_LABELS, TAXES, TAX_LABELS, errorText, fmt, fromCatalog, fromProposal,
  lineAmount, lineTax, lineTotal, money, newLine
} from "./shared";
import type { CatalogRow, LineDraft, Proposal, RefFile, Section } from "./shared";

const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

interface Meta {
  kind: "proforma" | "quotation";
  quotationNumber: string;
  customerName: string; customerPhone: string; customerEmail: string;
  customerTin: string; customerAddress: string; shipmentId: string;
  vesselName: string; voyage: string; blNumber: string; tradeType: string;
  issueDate: string; validUntil: string;
  currency: string; customCurrency: string; exchangeRate: string; vatRate: string;
  paymentInstructions: string; notes: string;
}

const META_EMPTY: Meta = {
  kind: "proforma", quotationNumber: "",
  customerName: "", customerPhone: "", customerEmail: "", customerTin: "", customerAddress: "",
  shipmentId: "", vesselName: "", voyage: "", blNumber: "", tradeType: "",
  issueDate: "", validUntil: "",
  currency: "TZS", customCurrency: "", exchangeRate: "", vatRate: "18",
  paymentInstructions: "", notes: ""
};

export default function ProformaGenerator({ id: routeId }: { id?: string | null }) {
  const router = useRouter();
  const [id, setId] = useState<string | null>(routeId ?? null);
  const [meta, setMeta] = useState<Meta>(META_EMPTY);
  const [lines, setLines] = useState<LineDraft[]>(() => [newLine("statutory"), newLine("port"), newLine("transport")]);
  const [status, setStatus] = useState("draft");
  const [convertedInvoiceId, setConvertedInvoiceId] = useState<string | null>(null);
  const [refs, setRefs] = useState<RefFile[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [letterhead, setLetterhead] = useState<any>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [printView, setPrintView] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ingesting, setIngesting] = useState<string | null>(null);
  const primaryInput = useRef<HTMLInputElement>(null);
  const secondaryInput = useRef<HTMLInputElement>(null);

  const editing = status === "draft" && !printView;

  const load = useCallback(async () => {
    if (!id) return;
    const res = await apiFetch(`/quotations/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Document not found.")); return; }
    setStatus(j.status);
    setConvertedInvoiceId(j.converted_invoice_id ?? null);
    setMeta({
      kind: j.kind,
      quotationNumber: j.quotation_number,
      customerName: j.customer_name ?? "",
      customerPhone: j.customer_phone ?? "",
      customerEmail: j.customer_email ?? "",
      customerTin: j.customer_tin ?? "",
      customerAddress: j.customer_address ?? "",
      shipmentId: j.shipment_id ?? "",
      vesselName: j.vessel_name ?? "",
      voyage: j.voyage ?? "",
      blNumber: j.bl_number ?? "",
      tradeType: j.trade_type ?? "",
      issueDate: j.issue_date ? String(j.issue_date).slice(0, 10) : "",
      validUntil: j.valid_until ? String(j.valid_until).slice(0, 10) : "",
      currency: CURRENCIES.some(c => c.code === j.currency) ? j.currency : "other",
      customCurrency: CURRENCIES.some(c => c.code === j.currency) ? "" : (j.currency ?? ""),
      exchangeRate: j.exchange_rate === null ? "" : String(Number(j.exchange_rate)),
      vatRate: String(Number(j.vat_rate ?? 18)),
      paymentInstructions: j.payment_instructions ?? "",
      notes: j.notes ?? ""
    });
    const loaded: LineDraft[] = (j.items as any[]).map(it => newLine(it.section, {
      catalogCode: it.catalog_code ?? "",
      description: it.description,
      basis: it.basis ?? "flat",
      quantity: String(Number(it.quantity)),
      unit: it.unit ?? "",
      unitPrice: String(Number(it.unit_price)),
      taxKind: it.tax_kind ?? "none",
      taxRate: String(Number(it.tax_rate ?? 0)),
      sourceDocumentId: it.source_document_id ?? null,
      verified: Boolean(it.verified),
      notes: it.notes ?? "",
      sourceFile: it.source_file ? `${it.source_role} file — ${it.source_file}` : null
    }));
    setLines(loaded.length ? loaded : [newLine("statutory"), newLine("port"), newLine("transport")]);
    setRefs(j.reference_files ?? []);
    setLetterhead(j.letterhead ?? null);
    setQr(j.qr_data_url ?? null);
    if (j.letterhead?.logo_document_id) {
      const lr = await apiFetch(`/documents/${j.letterhead.logo_document_id}/url`);
      if (lr.ok) { const lj = await lr.json(); setLogoUrl(lj.url); }
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      const res = await apiFetch("/charge-catalog");
      if (res.ok) setCatalog(await res.json());
    })();
  }, []);

  // Live totals — the server recomputes the same arithmetic on save.
  const totals = useMemo(() => {
    const by = (s: Section) => money(lines.filter(l => l.section === s).reduce((a, l) => a + lineTotal(l), 0));
    return {
      statutory: by("statutory"), port: by("port"), transport: by("transport"),
      subtotal: money(lines.reduce((a, l) => a + lineAmount(l), 0)),
      vat: money(lines.filter(l => l.taxKind === "vat").reduce((a, l) => a + lineTax(l), 0)),
      excise: money(lines.filter(l => l.taxKind === "excise").reduce((a, l) => a + lineTax(l), 0)),
      total: money(lines.reduce((a, l) => a + lineTotal(l), 0))
    };
  }, [lines]);

  const currency = meta.currency === "other"
    ? (meta.customCurrency.trim().toUpperCase() || "TZS") : meta.currency;

  const setLine = useCallback((key: string, patch: Partial<LineDraft>) =>
    setLines(ls => ls.map(l => {
      if (l.key !== key) return l;
      // Marking a line taxable seeds the document's own rate — a blank 0% would
      // otherwise print as "VAT 0.00" on a bill the office meant to charge VAT on.
      const seed = patch.taxRate === undefined && patch.taxKind && patch.taxKind !== "none" && !Number(l.taxRate)
        ? (patch.taxKind === "vat" ? { taxRate: String(Number(meta.vatRate) || 0) } : null)
        : null;
      return { ...l, ...patch, ...seed };
    })), [meta.vatRate]);

  function addLine(section: Section) { setLines(ls => [...ls, newLine(section)]); }
  function removeLine(key: string) { setLines(ls => ls.filter(l => l.key !== key)); }

  function applyCatalog(key: string, code: string) {
    if (!code) { setLine(key, { catalogCode: "" }); return; }
    const row = catalog.find(c => c.code === code);
    if (!row) return;
    // A standard charge belongs in its own block, so the row moves with it.
    setLines(ls => ls.map(l => l.key === key ? { ...l, ...fromCatalog(row), catalogCode: row.code } : l));
  }

  function buildPayload() {
    const body: any = {
      kind: meta.kind,
      customerName: meta.customerName.trim(),
      customerEmail: meta.customerEmail.trim() || null,
      customerTin: meta.customerTin.trim() || null,
      customerAddress: meta.customerAddress.trim() || null,
      vesselName: meta.vesselName.trim() || null,
      voyage: meta.voyage.trim() || null,
      blNumber: meta.blNumber.trim() || null,
      tradeType: meta.tradeType.trim() || null,
      currency,
      exchangeRate: Number(meta.exchangeRate) > 0 ? Number(meta.exchangeRate) : null,
      vatRate: Math.min(100, Math.max(0, Number(meta.vatRate) || 0)),
      validUntil: meta.validUntil || null,
      paymentInstructions: meta.paymentInstructions.trim() || null,
      notes: meta.notes.trim() || null,
      items: lines
        .filter(l => l.description.trim().length >= 2)
        .map(l => ({
          section: l.section,
          catalogCode: l.catalogCode || null,
          description: l.description.trim(),
          basis: l.basis,
          quantity: Number(l.quantity) || 1,
          unit: l.unit.trim() || null,
          unitPrice: Math.max(0, Number(l.unitPrice) || 0),
          taxKind: l.taxKind,
          taxRate: l.taxKind === "none" ? 0 : Math.min(100, Math.max(0, Number(l.taxRate) || 0)),
          sourceDocumentId: l.sourceDocumentId || null,
          verified: l.verified,
          notes: l.notes.trim() || null
        }))
    };
    if (meta.issueDate) body.issueDate = meta.issueDate;
    // A blank phone keeps what is stored — the same presence rule the driver
    // records use, so nobody clears a client number by editing a line.
    if (/^\+[1-9]\d{7,14}$/.test(meta.customerPhone.trim())) body.customerPhone = meta.customerPhone.trim();
    if (meta.shipmentId) body.shipmentId = meta.shipmentId;
    return body;
  }

  async function save() {
    setError(null); setNotice(null);
    if (!meta.customerName.trim()) { setError("A customer name is required before saving."); return; }
    if (!lines.some(l => l.description.trim().length >= 2)) {
      setError("Give at least one line a description — an empty document cannot be saved."); return;
    }
    const bad = lines.find(l => l.description.trim().length >= 2 &&
      (!(Number(l.quantity) > 0) || l.unitPrice.trim() === "" || Number(l.unitPrice) < 0));
    if (bad) { setError(`"${bad.description}" needs a quantity above zero and a unit price (0 is allowed).`); return; }
    setBusy(true);
    try {
      const hadId = id !== null;
      const res = await apiFetch(hadId ? `/quotations/${id}` : "/quotations", {
        method: hadId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload())
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the document.")); return; }
      if (hadId) {
        setNotice("Draft saved. The figures on the sheet are the ones that will print.");
        await load();
      } else {
        setId(j.id as string);
        router.push(`/app/cfa/proforma/${j.id}`);
      }
    } finally { setBusy(false); }
  }

  // A reference upload must never overwrite lines the clerk has typed but not
  // saved yet, so the refresh after ingest touches the files, not the sheet.
  async function refreshRefs() {
    if (!id) return;
    const res = await apiFetch(`/quotations/${id}`);
    if (!res.ok) return;
    const j = await res.json();
    setRefs(j.reference_files ?? []);
  }

  // ---------- reference files ----------
  async function uploadReference(role: "primary" | "secondary", file: File) {
    if (!id) { setError("Save the draft first — reference files are read against a saved document."); return; }
    setError(null); setNotice(null); setIngesting(role);
    try {
      const fd = new FormData();
      // The API reads multipart fields off the parts that arrive before the
      // file, so the file has to be appended last.
      fd.append("entityType", "quotation");
      fd.append("entityId", id);
      fd.append("kind", "proforma");
      fd.append("file", file);
      const up = await apiFetch("/documents", { method: "POST", body: fd });
      const upj = await up.json().catch(() => ({}));
      if (!up.ok) { setError(errorText(upj, "The reference file could not be uploaded.")); return; }

      const att = await apiFetch(`/quotations/${id}/reference-files`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, documentId: upj.id })
      });
      const attj = await att.json().catch(() => ({}));
      if (!att.ok) { setError(errorText(attj, "The reference file could not be read.")); return; }
      if (attj.extractStatus === "extracted") {
        setNotice(`${role === "primary" ? "Primary" : "Secondary"} file read. Check the proposal before it goes on the sheet.`);
      } else {
        setNotice(`${role === "primary" ? "Primary" : "Secondary"} file stored, but its figures could not be read (${attj.extractStatus}). Type the lines in — the file still stands as the source.`);
      }
      await refreshRefs();
      await runSuggest();
    } finally { setIngesting(null); }
  }

  async function detachReference(ref: RefFile) {
    if (!id) return;
    setError(null); setBusy(true);
    try {
      const res = await apiFetch(`/quotations/${id}/reference-files/${ref.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not remove the reference file.")); return; }
      // The server clears the provenance on the saved lines; the sheet has to
      // say the same thing, or the next save names a file that is no longer here.
      setLines(ls => ls.map(l => l.sourceDocumentId === ref.id
        ? { ...l, sourceDocumentId: null, sourceFile: null } : l));
      setProposal(null);
      await refreshRefs();
    } finally { setBusy(false); }
  }

  async function runSuggest() {
    if (!id) return;
    setError(null); setBusy(true);
    try {
      const res = await apiFetch(`/quotations/${id}/suggest-lines`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "The files could not be cross-checked.")); return; }
      setProposal(j);
      setPicked(Object.fromEntries(((j.lines ?? []) as any[]).map(l => [l.seq, true])));
    } finally { setBusy(false); }
  }

  function refIdFor(role: string) { return refs.find(r => r.role === role)?.id ?? null; }

  function addProposedLines() {
    if (!proposal) return;
    const chosen = proposal.lines.filter(l => picked[l.seq] !== false);
    if (!chosen.length) { setError("Tick at least one proposed line to add it to the sheet."); return; }
    setLines(ls => [
      ...ls.filter(l => l.description.trim()),
      ...chosen.map(l => fromProposal(l, l.source === "secondary_only" ? refIdFor("secondary") : (refIdFor("primary") ?? refIdFor("secondary"))))
    ]);
    setNotice(`${chosen.length} proposed line(s) added. Edit any figure before saving — a proposal is a starting point, not an assessment.`);
  }

  function addUnknownRow(u: Proposal["unknown"][number]) {
    setLines(ls => [...ls, newLine("transport", {
      description: (u.description ?? u.raw).slice(0, 300),
      unitPrice: u.amount !== null ? String(u.amount) : "",
      sourceDocumentId: u.role === "secondary" ? refIdFor("secondary") : (refIdFor("primary") ?? refIdFor("secondary")),
      notes: "Added from a line the charge catalogue does not know — check the section and the tax."
    })]);
  }

  // ---------- status ----------
  async function setStatusTo(next: string) {
    if (!id) return;
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/quotations/${id}/status`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed.")); return; }
      setNotice(next === "issued" ? "Document issued — it can now be accepted, declined or converted."
        : next === "accepted" ? "Client acceptance recorded."
          : next === "draft" ? "Back to draft; editing is open again."
            : `Document marked ${STATUS_LABELS[next] ?? next}.`);
      await load();
    } finally { setBusy(false); }
  }

  async function convert() {
    if (!id) return;
    setError(null); setBusy(true);
    try {
      const res = await apiFetch(`/quotations/${id}/convert`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not raise the invoice.")); return; }
      router.push(`/app/cfa/invoices/${j.id}`);
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!id) return;
    setError(null); setBusy(true);
    try {
      const res = await apiFetch(`/quotations/${id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not delete the document.")); return; }
      router.push("/app/cfa/proforma");
    } finally { setBusy(false); }
  }

  const shownLines = (section: Section) => lines.filter(l => l.section === section);

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="no-print flex flex-wrap items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
            {id ? (meta.kind === "quotation" ? "Quotation" : "Proforma invoice") : "New proforma / quotation"}
          </h1>
          <p className="mt-4 text-sm" style={{ color: "var(--ink-soft)" }}>
            Build the bill line by line, or read it off the port and agent documents. Everything here stays editable until the document is issued.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-12">
          {id && <Link href="/app/cfa/proforma" className="pane-note text-xs underline">← All documents</Link>}
          {id && (
            <button type="button" onClick={() => setPrintView(v => !v)} className="on-photo-btn px-16 py-8 text-xs font-semibold">
              {printView ? "Back to editing" : "Print preview"}
            </button>
          )}
          <button type="button" onClick={() => window.print()}
            className="on-photo-btn px-16 py-8 text-xs font-semibold">Print / Save PDF</button>
          {(!id || status === "draft") && (
            <button type="button" onClick={save} disabled={busy}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
              {busy ? "Saving…" : id ? "Save draft" : "Save as draft"}
            </button>
          )}
        </div>
      </div>

      {error && <div role="alert" className="no-print mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="no-print mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {!id && (
        <div role="status" className="no-print pane-note mt-16 px-12 py-8 text-sm">
          Save the draft once with a customer name and a first line, and the two-document reader opens below: upload the primary
          advisement and the supporting invoice, and Waisha cross-checks them and proposes the charge lines.
        </div>
      )}

      {id && (
        <section className="no-print mt-24 rounded-card border bg-surface p-24" style={inputStyle} >
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            Source documents
          </h2>
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            The primary is what you bill from; the secondary is the supporting invoice. Waisha reads the text layer of the files
            you upload and compares them — it is not connected to any port or revenue-authority system.
          </p>
          <div className="mt-16 grid gap-16 md:grid-cols-2">
            {(["primary", "secondary"] as const).map(role => (
              <RefSlot key={role} role={role} refFile={refs.find(r => r.role === role)}
                busy={ingesting === role} editable={editing}
                inputRef={role === "primary" ? primaryInput : secondaryInput}
                onPick={(f) => uploadReference(role, f)} onDetach={detachReference} />
            ))}
          </div>
          <div className="mt-16 flex flex-wrap items-center gap-12">
            <button type="button" onClick={runSuggest} disabled={busy || !refs.length}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
              Cross-check the files and propose lines
            </button>
            {!refs.length && <span className="text-xs" style={{ color: "var(--ink-soft)" }}>No file attached yet.</span>}
          </div>

          {proposal && (
            <ProposalPanel proposal={proposal} picked={picked} setPicked={setPicked}
              onAdd={addProposedLines} onAddUnknown={addUnknownRow} currency={currency} />
          )}
        </section>
      )}

      {/* ---------------- the sheet ---------------- */}
      <div className="proforma-sheet mt-24 rounded-card border bg-surface p-32" style={inputStyle} >
        <div className="flex items-start justify-between gap-24 border-b pb-24" style={{ borderColor: "var(--ink)" }}>
          <div className="flex items-start gap-16">
            {logoUrl && <img src={logoUrl} alt="Company logo" className="h-64 w-64 object-contain" />}
            <div>
              <p className="text-lg font-bold" style={{ color: "var(--ink)" }}>{letterhead?.company_name ?? "Your company"}</p>
              {letterhead?.postal_address && (
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  {letterhead.postal_address}{letterhead.street ? `, ${letterhead.street}` : ""}
                </p>
              )}
              {letterhead?.tin_display && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>TIN: {letterhead.tin_display}</p>}
              {letterhead?.vat_number && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>VAT No: {letterhead.vat_number}</p>}
              {letterhead?.brela_number && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>BRELA: {letterhead.brela_number}</p>}
              {letterhead?.branch_email && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{letterhead.branch_email}</p>}
              {letterhead?.website && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{letterhead.website}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold tracking-[0.06em]" style={{ color: "var(--ink)" }}>
              {meta.kind === "quotation" ? "QUOTATION" : "PROFORMA INVOICE"}
            </p>
            <p className="mt-4 text-sm font-semibold" style={{ color: "var(--ink)" }}>{meta.quotationNumber || "unsaved draft"}</p>
            <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              {STATUS_LABELS[status] ?? status}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-24 py-24 md:grid-cols-2">
          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Bill to</p>
            {editing ? (
              <div className="space-y-8">
                <Field label="Customer / consignee *" value={meta.customerName}
                  onChange={v => setMeta(m => ({ ...m, customerName: v }))} placeholder="As on the bill of lading" />
                <div className="grid grid-cols-2 gap-8">
                  <Field label="Phone" value={meta.customerPhone}
                    onChange={v => setMeta(m => ({ ...m, customerPhone: v }))} placeholder="+255…"
                    hint="blank keeps the stored number" />
                  <Field label="Email" value={meta.customerEmail}
                    onChange={v => setMeta(m => ({ ...m, customerEmail: v }))} />
                </div>
                <Field label="TIN" value={meta.customerTin} onChange={v => setMeta(m => ({ ...m, customerTin: v }))} />
                <Field label="Address" value={meta.customerAddress}
                  onChange={v => setMeta(m => ({ ...m, customerAddress: v }))} />
              </div>
            ) : (
              <div className="text-sm" style={{ color: "var(--ink)" }}>
                <p className="font-bold">{meta.customerName}</p>
                {meta.customerAddress && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{meta.customerAddress}</p>}
                {meta.customerTin && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>TIN: {meta.customerTin}</p>}
                {meta.customerPhone && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{meta.customerPhone}</p>}
                {meta.customerEmail && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{meta.customerEmail}</p>}
              </div>
            )}
          </div>

          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Consignment</p>
            {editing ? (
              <div className="grid grid-cols-2 gap-8">
                <Field label="Vessel" value={meta.vesselName} onChange={v => setMeta(m => ({ ...m, vesselName: v }))} />
                <Field label="Voyage" value={meta.voyage} onChange={v => setMeta(m => ({ ...m, voyage: v }))} />
                <Field label="B/L number" value={meta.blNumber} onChange={v => setMeta(m => ({ ...m, blNumber: v }))} />
                <Field label="Trade type" value={meta.tradeType} onChange={v => setMeta(m => ({ ...m, tradeType: v }))} placeholder="Import" />
                <Field label="Issue date" type="date" value={meta.issueDate} onChange={v => setMeta(m => ({ ...m, issueDate: v }))} />
                <Field label="Valid until" type="date" value={meta.validUntil} onChange={v => setMeta(m => ({ ...m, validUntil: v }))} />
                <Choice label="Document" value={meta.kind} onChange={v => setMeta(m => ({ ...m, kind: v as Meta["kind"] }))}
                  options={[["proforma", "Proforma invoice"], ["quotation", "Quotation"]]} />
                <Choice label="Currency" value={meta.currency} onChange={v => setMeta(m => ({ ...m, currency: v }))}
                  options={CURRENCIES.map(c => [c.code, c.label])} />
                {meta.currency === "other" && (
                  <Field label="Specify currency" value={meta.customCurrency}
                    onChange={v => setMeta(m => ({ ...m, customCurrency: v }))} placeholder="e.g. RWF" />
                )}
                <Field label="Exchange rate" type="number" value={meta.exchangeRate}
                  onChange={v => setMeta(m => ({ ...m, exchangeRate: v }))} placeholder="optional" />
                <Field label="Document VAT rate (%)" type="number" value={meta.vatRate}
                  onChange={v => setMeta(m => ({ ...m, vatRate: v }))} />
              </div>
            ) : (
              <div className="text-right text-xs" style={{ color: "var(--ink)" }}>
                {meta.vesselName && <p><span style={{ color: "var(--ink-soft)" }}>Vessel: </span>{meta.vesselName}{meta.voyage ? ` · ${meta.voyage}` : ""}</p>}
                {meta.blNumber && <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>B/L: </span>{meta.blNumber}</p>}
                {meta.tradeType && <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Trade: </span>{meta.tradeType}</p>}
                <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Issue date: </span>{meta.issueDate || "today"}</p>
                {meta.validUntil && <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Valid until: </span>{meta.validUntil}</p>}
                <p className="mt-4"><span style={{ color: "var(--ink-soft)" }}>Currency: </span>{currency}{meta.exchangeRate ? ` @ ${meta.exchangeRate}` : ""}</p>
              </div>
            )}
          </div>
        </div>

        {SECTIONS.map(section => (
          <SectionBlock key={section} section={section} title={SECTION_TITLES[section]} note={SECTION_NOTE[section]}
            lines={shownLines(section)} catalog={catalog.filter(c => c.section === section)}
            editing={editing} currency={currency} total={totals[section]}
            onAdd={() => addLine(section)} onRemove={removeLine} onChange={setLine} onCatalog={applyCatalog} />
        ))}

        <div className="mt-24 flex flex-wrap items-start justify-between gap-24 border-t pt-16" style={{ borderColor: "var(--ink)" }}>
          <div className="min-w-0 flex-1">
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>As laid out on this document</p>
            <table className="w-full max-w-[420px] text-sm">
              <tbody>
                {SECTIONS.map(s => (
                  <tr key={s}>
                    <td className="py-4" style={{ color: "var(--ink-soft)" }}>{SECTION_SHORT[s]}</td>
                    <td className="py-4 text-right tabular-nums" style={{ color: "var(--ink)" }}>{currency} {fmt(totals[s])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="w-full max-w-[340px] space-y-4 text-sm">
            <Row label="Charges before tax" value={`${currency} ${fmt(totals.subtotal)}`} />
            <Row label="VAT on the lines" value={`${currency} ${fmt(totals.vat)}`} />
            {totals.excise > 0 && <Row label="Excise on the lines" value={`${currency} ${fmt(totals.excise)}`} />}
            <div className="flex justify-between border-t pt-8 text-base font-bold"
              style={{ borderColor: "var(--ink)", color: "var(--ink)" }}>
              <span>Total payable</span><span className="tabular-nums">{currency} {fmt(totals.total)}</span>
            </div>
          </div>
        </div>

        <div className="mt-24 flex items-start justify-between gap-24 border-t pt-16" style={{ borderColor: "var(--line)" }}>
          <div className="min-w-0 flex-1">
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Where to pay</p>
            {editing ? (
              <>
                <textarea rows={3} value={meta.paymentInstructions}
                  onChange={e => setMeta(m => ({ ...m, paymentInstructions: e.target.value }))}
                  placeholder="Leave blank to use your profile's bank and mobile-money details"
                  className="w-full rounded-input border px-12 py-8 text-sm" style={inputStyle} />
                <label className="mt-12 block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes printed on the document</span>
                  <textarea rows={2} value={meta.notes}
                    onChange={e => setMeta(m => ({ ...m, notes: e.target.value }))}
                    className="w-full rounded-input border px-12 py-8 text-sm" style={inputStyle} />
                </label>
              </>
            ) : (
              <>
                {meta.paymentInstructions
                  ? <p className="whitespace-pre-line text-xs" style={{ color: "var(--ink)" }}>{meta.paymentInstructions}</p>
                  : <p className="text-xs" style={{ color: "var(--ink-soft)" }}>Contact our office for payment details.</p>}
                {meta.notes && <p className="mt-12 text-xs" style={{ color: "var(--ink)" }}>{meta.notes}</p>}
              </>
            )}
          </div>
          {qr && (
            <div className="shrink-0 text-center">
              <img src={qr} alt="Document verification QR" className="h-28 w-28" />
              <p className="mt-4 text-[9px]" style={{ color: "var(--ink-soft)" }}>Scan to verify</p>
            </div>
          )}
        </div>

        <p className="mt-16 border-t pt-12 text-[10px] leading-relaxed"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
          Duties, levies and statutory taxes are entered from the assessment and the advisement documents supplied to this office.
          Waisha is not connected to the Tanzania Revenue Authority, TPA or any other government system and does not compute these
          figures on its own. {meta.kind === "proforma"
            ? "A proforma is raised in advance of the final assessment; the bill changes if the assessment changes."
            : "A quotation states our charges and holds until the validity date above."}
        </p>
      </div>

      {id && (
        <section className="no-print mt-24 rounded-card border bg-surface p-24" style={inputStyle} >
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Document actions</h2>
          <div className="mt-16 flex flex-wrap gap-12">
            {status === "draft" && (
              <button type="button" disabled={busy} onClick={() => setStatusTo("issued")}
                className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">Issue document</button>
            )}
            {status === "issued" && (
              <>
                <button type="button" disabled={busy} onClick={() => setStatusTo("accepted")}
                  className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">Client accepted</button>
                <button type="button" disabled={busy} onClick={() => setStatusTo("declined")}
                  className="on-photo-btn px-16 py-8 text-xs font-semibold disabled:opacity-50">Client declined</button>
                <button type="button" disabled={busy} onClick={() => setStatusTo("draft")}
                  className="on-photo-btn px-16 py-8 text-xs font-semibold disabled:opacity-50">Back to draft</button>
              </>
            )}
            {(status === "issued" || status === "accepted") && (
              <button type="button" disabled={busy} onClick={convert}
                className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">Convert to invoice</button>
            )}
            {status === "converted" && convertedInvoiceId && (
              <Link href={`/app/cfa/invoices/${convertedInvoiceId}`}
                className="on-photo-btn px-16 py-8 text-xs font-semibold underline">Open the invoice raised from this</Link>
            )}
            {status !== "converted" && (
              <button type="button" disabled={busy} onClick={() => setStatusTo("cancelled")}
                className="on-photo-btn px-16 py-8 text-xs font-semibold disabled:opacity-50" style={{ color: "#ff9d94" }}>
                Cancel document
              </button>
            )}
            {(status === "draft" || status === "declined" || status === "cancelled") && (
              <button type="button" disabled={busy} onClick={remove}
                className="on-photo-btn px-16 py-8 text-xs font-semibold disabled:opacity-50" style={{ color: "#ff9d94" }}>
                Delete
              </button>
            )}
          </div>
          <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
            Issuing locks the sheet against edits. Converting raises a fresh draft invoice carrying the same three blocks and the
            same per-line tax figures, and this document stays as the record of what was quoted.
          </p>
        </section>
      )}
    </div>
  );
}

/* ---------------- module-level pieces ---------------- */

function Field({ label, value, onChange, type = "text", placeholder, hint }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; hint?: string;
}) {
  return (
    <label className="block">
      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>{label}</span>
      <input type={type} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)}
        className="w-full rounded-input border px-12 py-8 text-sm" style={inputStyle} />
      {hint && <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>{hint}</span>}
    </label>
  );
}

function Choice({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: [string, string][];
}) {
  return (
    <label className="block">
      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="w-full rounded-input border px-12 py-8 text-sm" style={inputStyle} >
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
      <span>{label}</span><span className="tabular-nums">{value}</span>
    </div>
  );
}

const HEADER_FIELDS: [string, string][] = [
  ["document_no", "Document no"], ["document_date", "Date"], ["consignee", "Consignee"],
  ["agent", "Agent"], ["vessel", "Vessel"], ["bl_number", "B/L"],
  ["printed_subtotal", "Printed net"], ["printed_vat", "Printed VAT"], ["printed_total", "Printed total"]
];

function HeaderRead({ header }: { header: any }) {
  const found = HEADER_FIELDS.filter(([k]) => header[k] !== null && header[k] !== undefined && header[k] !== "");
  if (!found.length) return null;
  return (
    <dl className="mt-8 flex flex-wrap gap-x-16 gap-y-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
      {found.map(([k, label]) => (
        <div key={k}>
          <dt className="uppercase tracking-[0.1em]">{label}</dt>
          <dd className="font-semibold tabular-nums" style={{ color: "var(--ink)" }}>
            {typeof header[k] === "number" ? fmt(header[k]) : String(header[k])}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RefSlot({ role, refFile, busy, editable, inputRef, onPick, onDetach }: {
  role: "primary" | "secondary";
  refFile: RefFile | undefined;
  busy: boolean;
  editable: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  onPick: (f: File) => void;
  onDetach: (r: RefFile) => void;
}) {
  return (
    <div className="rounded-card border p-16" style={inputStyle} >
      <p className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
        {role === "primary" ? "Primary — document to bill from" : "Secondary — supporting invoice"}
      </p>
      {refFile ? (
        <div className="mt-8">
          <p className="flex items-center gap-8 text-sm" style={{ color: "var(--ink)" }}>
            <FileText size={16} strokeWidth={1.8} aria-hidden /> {refFile.fileName}
          </p>
          <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
            {refFile.extractStatus === "extracted" ? "Figures read from the text layer."
              : refFile.extractStatus === "manual" ? "No text layer — the figures have to be typed in."
                : "The file could not be read."}
            {refFile.extractNotes ? ` ${refFile.extractNotes}` : ""}
          </p>
          {refFile.extraction?.header && <HeaderRead header={refFile.extraction.header} />}
          {editable && (
            <button type="button" disabled={busy} onClick={() => onDetach(refFile)}
              className="mt-8 inline-flex items-center gap-8 text-xs underline" style={{ color: "var(--danger)" }}>
              <X size={14} strokeWidth={1.8} aria-hidden /> Remove and un-read
            </button>
          )}
        </div>
      ) : (
        <div className="mt-8">
          <input ref={inputRef} type="file" accept=".pdf,application/pdf,image/jpeg,image/png,image/webp"
            className="hidden" disabled={!editable || busy}
            onChange={e => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
          <button type="button" disabled={!editable || busy} onClick={() => inputRef.current?.click()}
            className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
            {busy ? "Reading…" : `Upload ${role} file`}
          </button>
          {!editable && <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>Reference slots attach to a draft only.</p>}
        </div>
      )}
    </div>
  );
}

function SectionBlock({ section, title, note, lines, catalog, editing, currency, total, onAdd, onRemove, onChange, onCatalog }: {
  section: Section; title: string; note: string; lines: LineDraft[]; catalog: CatalogRow[];
  editing: boolean; currency: string; total: number;
  onAdd: () => void; onRemove: (key: string) => void;
  onChange: (key: string, patch: Partial<LineDraft>) => void; onCatalog: (key: string, code: string) => void;
}) {
  return (
    <section className="proforma-section mt-24">
      <div className="flex items-end justify-between gap-12 border-b pb-8" style={{ borderColor: "var(--ink)" }}>
        <h2 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>{title}</h2>
        {editing && (
          <button type="button" onClick={onAdd}
            className="no-print inline-flex items-center gap-8 rounded-input border px-12 py-4 text-xs font-semibold"
            style={{ ...inputStyle, color: "var(--ink)" }}>
            <Plus size={14} strokeWidth={1.8} aria-hidden /> Add line
          </button>
        )}
      </div>
      <p className="no-print mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>{note}</p>

      <table className="mt-12 w-full text-sm">
        <thead>
          <tr className="border-b text-left" style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
            <th className="w-[64px] p-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Code</th>
            <th className="p-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Description</th>
            <th className="w-[72px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Qty</th>
            <th className="w-[88px] p-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Unit</th>
            <th className="w-[120px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Unit price</th>
            <th className="w-[128px] p-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Statutory tax</th>
            <th className="w-[110px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Amount</th>
            <th className="no-print w-[88px] p-8 text-right text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Checked</th>
            <th className="no-print w-[32px]"></th>
          </tr>
        </thead>
        <tbody>
          {lines.map(l => (
            <LineRow key={l.key} line={l} catalog={catalog} editing={editing}
              onChange={onChange} onRemove={onRemove} onCatalog={onCatalog} />
          ))}
          {!lines.length && (
            <tr>
              <td colSpan={9} className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                No line in this block yet{editing ? " — use Add line, or read them off a source document above." : "."}
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t" style={{ borderColor: "var(--line)" }}>
            <td colSpan={6} className="p-8 text-right text-[11px] font-bold uppercase tracking-[0.12em]"
              style={{ color: "var(--ink-soft)" }}>Block subtotal</td>
            <td className="p-8 text-right font-bold tabular-nums" style={{ color: "var(--ink)" }}>{currency} {fmt(total)}</td>
            <td className="no-print"></td><td className="no-print"></td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

function LineRow({ line, catalog, editing, onChange, onRemove, onCatalog }: {
  line: LineDraft; catalog: CatalogRow[]; editing: boolean;
  onChange: (key: string, patch: Partial<LineDraft>) => void;
  onRemove: (key: string) => void; onCatalog: (key: string, code: string) => void;
}) {
  const cell = "w-full rounded-input border px-8 py-4 text-sm";
  const base = catalog.find(c => c.code === line.catalogCode);
  const basisPrint = BASIS_PRINT[line.basis] ?? "";

  return (
    <>
      <tr className="proforma-line border-b align-top" style={{ borderColor: "var(--line)" }}>
        <td className="p-8">
          {editing ? (
            <select value={line.catalogCode} onChange={e => onCatalog(line.key, e.target.value)}
              className={cell} style={inputStyle} aria-label="Charge code">
              <option value="">Own line</option>
              {catalog.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
          ) : (
            <span className="text-[10px] font-semibold uppercase" style={{ color: "var(--ink-soft)" }}>
              {line.catalogCode || "—"}
            </span>
          )}
        </td>
        <td className="p-8">
          {editing ? (
            <input value={line.description} onChange={e => onChange(line.key, { description: e.target.value })}
              className={cell} style={inputStyle} placeholder="As it should print" />
          ) : (
            <span style={{ color: "var(--ink)" }}>
              {line.description}
              {basisPrint && <span className="ml-8 text-[10px] italic" style={{ color: "var(--ink-soft)" }}> ({basisPrint})</span>}
            </span>
          )}
          {editing && line.catalogCode && (
            <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
              {BASIS_LABELS[line.basis] ?? line.basis}{base?.eacExempt ? " · EAC originating goods may qualify for exemption" : ""}
            </span>
          )}
          {line.sourceFile && (
            <span className="no-print mt-4 flex items-center gap-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
              <Link2 size={12} strokeWidth={1.8} aria-hidden /> {line.sourceFile}
            </span>
          )}
          {editing && line.notes && (
            <span className="no-print mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>{line.notes}</span>
          )}
        </td>
        <td className="p-8 text-right">
          {editing ? (
            <input type="number" min={0} step="0.01" value={line.quantity}
              onChange={e => onChange(line.key, { quantity: e.target.value })} className={cell} style={inputStyle} aria-label="Quantity" />
          ) : <span className="tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(line.quantity) || 0)}</span>}
        </td>
        <td className="p-8">
          {editing ? (
            <input value={line.unit} onChange={e => onChange(line.key, { unit: e.target.value })}
              className={cell} style={inputStyle} placeholder="—" aria-label="Unit" />
          ) : <span className="text-xs" style={{ color: "var(--ink-soft)" }}>{line.unit}</span>}
        </td>
        <td className="p-8 text-right">
          {editing ? (
            <input type="number" min={0} step="0.01" value={line.unitPrice}
              onChange={e => onChange(line.key, { unitPrice: e.target.value })} className={cell} style={inputStyle} aria-label="Unit price" />
          ) : <span className="tabular-nums" style={{ color: "var(--ink)" }}>{fmt(Number(line.unitPrice) || 0)}</span>}
        </td>
        <td className="p-8">
          {editing ? (
            <div className="flex items-center gap-4">
              <select value={line.taxKind} onChange={e => onChange(line.key, { taxKind: e.target.value as any })}
                className={cell} style={inputStyle} aria-label="Tax on this line">
                {TAXES.map(t => <option key={t} value={t}>{TAX_LABELS[t]}</option>)}
              </select>
              {line.taxKind !== "none" && (
                <input type="number" min={0} max={100} step="0.01" value={line.taxRate}
                  onChange={e => onChange(line.key, { taxRate: e.target.value })}
                  className={cell} style={inputStyle} aria-label="Tax rate" />
              )}
            </div>
          ) : line.taxKind !== "none" ? (
            <span className="text-xs" style={{ color: "var(--ink)" }}>{TAX_LABELS[line.taxKind]} {fmt(Number(line.taxRate) || 0)}%</span>
          ) : <span className="text-xs" style={{ color: "var(--ink-soft)" }}>—</span>}
        </td>
        <td className="p-8 text-right font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{fmt(lineTotal(line))}</td>
        <td className="no-print p-8 text-right">
          {editing && (
            <label className="inline-flex items-center gap-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
              <input type="checkbox" checked={line.verified}
                onChange={e => onChange(line.key, { verified: e.target.checked })} />
              <span className="sr-only">Checked against the assessment</span>
            </label>
          )}
        </td>
        <td className="no-print p-8 text-right">
          {editing && (
            <button type="button" onClick={() => onRemove(line.key)} aria-label="Remove this line"
              style={{ color: "var(--danger)" }}>
              <Trash2 size={14} strokeWidth={1.8} aria-hidden />
            </button>
          )}
        </td>
      </tr>
    </>
  );
}

function ProposalPanel({ proposal, picked, setPicked, onAdd, onAddUnknown, currency }: {
  proposal: Proposal; picked: Record<number, boolean>;
  setPicked: (up: (p: Record<number, boolean>) => Record<number, boolean>) => void;
  onAdd: () => void; onAddUnknown: (u: Proposal["unknown"][number]) => void; currency: string;
}) {
  const chosenCount = proposal.lines.filter(l => picked[l.seq] !== false).length;
  return (
    <div className="mt-24 border-t pt-16" style={{ borderColor: "var(--line)" }}>
      <h3 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
        Cross-check and proposal
      </h3>
      <ul className="mt-12 space-y-8">
        {proposal.checks.map(c => (
          <li key={c.kind} className="flex items-start gap-8 text-xs">
            <span style={{ color: c.ok ? "var(--success)" : "var(--warning)" }}>
              {c.ok ? <Check size={14} strokeWidth={1.8} aria-hidden /> : <ShieldAlert size={14} strokeWidth={1.8} aria-hidden />}
            </span>
            <span style={{ color: "var(--ink)" }}>
              <strong>{c.ok ? "Checked" : "Needs attention"} — {c.label}:</strong> {c.detail}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
        Read from: {proposal.read.primary ? "primary" : "no primary"} · {proposal.read.secondary ? "secondary" : "no secondary"}.
        Every figure below is a proposal — edit it on the sheet before saving.
      </p>

      <table className="mt-12 w-full text-xs">
        <thead>
          <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
            <th className="p-8"></th><th className="p-8">Charge</th><th className="p-8">Matched to</th>
            <th className="p-8 text-right">Amount</th><th className="p-8 text-right">Tax</th>
            <th className="p-8">Both files?</th><th className="p-8">Line as printed</th>
          </tr>
        </thead>
        <tbody>
          {proposal.lines.map(l => (
            <tr key={l.seq} className="border-b align-top" style={{ borderColor: "var(--line)" }}>
              <td className="p-8">
                <input type="checkbox" checked={picked[l.seq] !== false}
                  aria-label={`Add ${l.description}`}
                  onChange={e => setPicked(p => ({ ...p, [l.seq]: e.target.checked }))} />
              </td>
              <td className="p-8 font-semibold" style={{ color: "var(--ink)" }}>{l.description}</td>
              <td className="p-8 tabular-nums" style={{ color: "var(--ink-soft)" }}>{l.catalog_code ?? "not matched"}</td>
              <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(l.amount)}</td>
              <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{l.tax_amount ? fmt(l.tax_amount) : "—"}</td>
              <td className="p-8" style={{ color: l.source === "amount_mismatch" ? "var(--warning)" : "var(--ink-soft)" }}>
                {SOURCE_LABELS[l.source] ?? l.source}{l.note ? ` — ${l.note}` : ""}
              </td>
              <td className="p-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>{l.primary_raw ?? l.secondary_raw ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!proposal.lines.length && (
        <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
          Neither file produced a row this office can match to a charge code — add them from the list below.
        </p>
      )}

      <button type="button" onClick={onAdd} disabled={!chosenCount}
        className="waisha-btn mt-12 rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
        Add {chosenCount} proposed line(s) to the sheet ({currency})
      </button>

      {proposal.unknown.length > 0 && (
        <div className="mt-16">
          <p className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            Rows the catalogue does not know
          </p>
          <ul className="mt-8 space-y-8">
            {proposal.unknown.map((u, i) => (
              <li key={i} className="flex items-start justify-between gap-12 text-xs">
                <span style={{ color: "var(--ink)" }}>
                  <em>{u.role}</em> — {u.raw}
                  {u.amount !== null && <span className="ml-8 whitespace-nowrap tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    amount {fmt(u.amount)} {currency}
                  </span>}
                </span>
                <button type="button" onClick={() => onAddUnknown(u)} className="underline" style={{ color: "var(--brand)" }}>
                  Add as a line
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
