"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/app/app/api-client";
import { downloadMasterBundle } from "@/app/app/export-client";
import { kindLabel } from "@/app/app/doc-kinds";
import { fmtBytes } from "@/app/portal/labels";

/**
 * The master document for one cargo file (task #187).
 *
 * This is the declaration sheet, not the paper list: three lines of figures — the
 * commercial invoice, the packing list, the bill of lading or air waybill — each with
 * the PDF filed behind it. The bytes stay in the vault against the cargo file; this
 * panel only ever points at them, which is why a bill that arrives a week after the
 * sheet was signed can still be attached while the figures cannot move.
 *
 * The freeze, the gap list and the shape rules all live in migration 111 and the
 * master routes, and this panel reads the answers from the server instead of keeping
 * its own copies — a desk that decides on its own when a sheet is complete is a desk
 * with a Sign button the database then refuses.
 */

const BILL_KINDS: { value: string; label: string }[] = [
  { value: "bill_of_lading", label: "Bill of lading" },
  { value: "sea_waybill", label: "Sea waybill" },
  { value: "air_waybill", label: "Air waybill" },
  { value: "rail_waybill", label: "Rail waybill" },
  { value: "road_waybill", label: "Road waybill" }
];

/** The kind a paper uploaded into this slot is filed under in the vault. */
const UPLOAD_KIND = { invoice: "invoice", packing: "packing_list", bill: "bill_of_lading" };

type SlotKey = "invoice" | "packing" | "bill";
type FieldKind = "text" | "date" | "number" | "select";

interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  hint?: string;
  step?: string;
  max?: number;
  /** Frozen by a signature — 111 lets only the three pointers and the note change after signing. */
  figure: boolean;
}

interface Slot {
  key: SlotKey;
  paper: string;
  slot: string;
  docKey: string;
  fields: Field[];
}

const SLOTS: Slot[] = [
  {
    key: "invoice", paper: "Commercial invoice", slot: "the invoice",
    docKey: "invoiceDocumentId",
    fields: [
      { key: "invoiceNumber", label: "Number printed on it", kind: "text",
        placeholder: "INV-2026-0188", max: 80, figure: true },
      { key: "invoiceDate", label: "Date", kind: "date", figure: true },
      { key: "invoiceCurrency", label: "Currency", kind: "text", placeholder: "USD",
        hint: "3 letters, as printed", max: 3, figure: true },
      { key: "invoiceValue", label: "Value", kind: "number", step: "0.01",
        placeholder: "0.00", figure: true }
    ]
  },
  {
    key: "packing", paper: "Packing list", slot: "the packing list",
    docKey: "packingDocumentId",
    fields: [
      { key: "packingListNumber", label: "Number printed on it", kind: "text",
        placeholder: "PL-0188", max: 80, figure: true },
      { key: "packagesCount", label: "Packages", kind: "number", step: "1",
        placeholder: "e.g. 48", figure: true },
      { key: "packageType", label: "Packaging", kind: "text",
        placeholder: "cartons, drums, pallets…", max: 60, figure: true },
      { key: "grossWeightKg", label: "Gross weight (kg)", kind: "number", step: "0.001",
        placeholder: "0.000", figure: true },
      { key: "netWeightKg", label: "Net weight (kg)", kind: "number", step: "0.001",
        placeholder: "0.000", figure: true }
    ]
  },
  {
    key: "bill", paper: "Bill of lading / air waybill", slot: "the bill or air waybill",
    docKey: "billDocumentId",
    fields: [
      { key: "billKind", label: "Which document", kind: "select", figure: true },
      { key: "billNumber", label: "Number printed on it", kind: "text",
        placeholder: "MEDUX-1188245", max: 60, figure: true },
      { key: "billDate", label: "Date", kind: "date", figure: true }
    ]
  }
];

const NOTE_FIELD: Field = { key: "notes", label: "Clerk's note", kind: "text",
  hint: "Stays editable after the sheet is signed", max: 1000, figure: false };

interface Paper {
  id: string; kind: string; file_name: string; mime_type: string;
  size_bytes: number; created_at: string;
}

interface Gate {
  file: { id: string; file_number: string; shipment_type: string; bill_number: string | null;
          weight_tonnes: string | null; cbm: string | null;
          /** 130: the mode the cargo file travels by, and the document that mode expects. */
          mode_label: string | null; mode_bill_kind: string | null };
  master: Record<string, string | number | null> | null;
  papers: Paper[];
  state: {
    has_master: boolean; declared: boolean; declared_on: string | null;
    declared_by: string | null; complete: boolean; gaps: string | null;
    papers_named: number; can_sign: boolean;
  };
  warnings: string[];
  can: { edit: boolean; declare: boolean; bundle: boolean };
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const emptyForm = (): Record<string, string> => {
  const f: Record<string, string> = { notes: "" };
  for (const s of SLOTS) for (const x of s.fields) f[x.key] = "";
  for (const s of SLOTS) f[s.docKey] = "";
  return f;
};

/**
 * The form is keyed by the write body's camelCase; the row comes back with its column names.
 * Reading the row by the wrong case returns nothing, and a desk that saves a sheet and watches
 * every box empty itself has no reason to trust the next one it fills.
 */
const COLUMN: Record<string, string> = {
  invoiceNumber: "invoice_number",
  invoiceDate: "invoice_date",
  invoiceCurrency: "invoice_currency",
  invoiceValue: "invoice_value",
  packingListNumber: "packing_list_number",
  packagesCount: "packages_count",
  packageType: "package_type",
  grossWeightKg: "gross_weight_kg",
  netWeightKg: "net_weight_kg",
  billKind: "bill_kind",
  billNumber: "bill_number",
  billDate: "bill_date",
  invoiceDocumentId: "invoice_document_id",
  packingDocumentId: "packing_document_id",
  billDocumentId: "bill_document_id",
  notes: "notes"
};

/** The words 111 froze for the five transport documents, as the sheet's own pick-list names them. */
const billWord = (kind: string) => BILL_KINDS.find(k => k.value === kind)?.label ?? kind;

/** The paper with the article its own first letter asks for — "an Air waybill", not "a Air …". */
const aBill = (kind: string) => {
  const w = billWord(kind);
  return `${/^[aeiou]/i.test(w) ? "an" : "a"} ${w}`;
};

/**
 * The sheet as the office left it, with one exception: a transport document nobody has chosen yet
 * is filled from the mode the cargo file carries.
 *
 * 130 says a sea movement travels on a bill of lading and an air movement on an air waybill, and the
 * master route refuses a sheet that contradicts the file. Asking the clerk to answer that question a
 * second time — and then being refused — would be a form that argues with the office. A sheet that
 * already names its document is left exactly as it was signed.
 */
function formFrom(master: Gate["master"], modeBillKind: string | null): Record<string, string> {
  const f = emptyForm();
  if (!master) return modeBillKind ? { ...f, billKind: modeBillKind } : f;
  for (const [key, column] of Object.entries(COLUMN)) f[key] = str(master[column]);
  if (!f.billKind && modeBillKind) f.billKind = modeBillKind;
  return f;
}

/** A box emptied on the desk means empty; a number typed badly never reaches the server. */
function bodyOf(form: Record<string, string>): Record<string, unknown> {
  const num = (v: string) => (v.trim() === "" ? null : Number(v.trim()));
  const txt = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    invoiceNumber: txt(form.invoiceNumber),
    invoiceDate: form.invoiceDate || null,
    invoiceCurrency: form.invoiceCurrency.trim()
      ? form.invoiceCurrency.trim().toUpperCase() : null,
    invoiceValue: num(form.invoiceValue),
    packingListNumber: txt(form.packingListNumber),
    packagesCount: num(form.packagesCount),
    packageType: txt(form.packageType),
    grossWeightKg: num(form.grossWeightKg),
    netWeightKg: num(form.netWeightKg),
    billKind: form.billKind || null,
    billNumber: txt(form.billNumber),
    billDate: form.billDate || null,
    invoiceDocumentId: form.invoiceDocumentId || null,
    packingDocumentId: form.packingDocumentId || null,
    billDocumentId: form.billDocumentId || null,
    notes: txt(form.notes)
  };
}

/** What zod would refuse outright — caught here so the clerk reads a sentence, not a 400. */
function checkForm(form: Record<string, string>): string | null {
  if (form.invoiceCurrency.trim() && !/^[A-Za-z]{3}$/.test(form.invoiceCurrency.trim()))
    return "The currency has to be the three letters as printed on the invoice, e.g. USD.";
  for (const s of SLOTS) {
    for (const f of s.fields) {
      if (f.kind !== "number") continue;
      const raw = form[f.key].trim();
      if (!raw) continue;
      if (!Number.isFinite(Number(raw))) return `The ${f.label.toLowerCase()} is not a number.`;
      if (f.key === "packagesCount" && (!Number.isInteger(Number(raw)) || Number(raw) < 1))
        return "The package count is whole packages — 48, not 48.5.";
    }
  }
  return null;
}

export function ImportMaster({ shipmentId, onNotice }: {
  shipmentId: string;
  onNotice?: (message: string) => void;
}) {
  const [gate, setGate] = useState<Gate | null>(null);
  const [form, setForm] = useState<Record<string, string>>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slotBusy, setSlotBusy] = useState<SlotKey | null>(null);

  const load = useCallback(async (keepDraft: boolean) => {
    const res = await apiFetch(`/cargo/${shipmentId}/master`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(serveError(j, "The master sheet would not load.")); return; }
    const g = j as Gate;
    setGate(g);
    setError(null);
    // After a write the server's row is the truth; while the clerk is still typing, their
    // draft is. A reload that overwrote live keystrokes is how a half-filled sheet dies.
    if (!keepDraft) setForm(formFrom(g.master, g.file.mode_bill_kind));
  }, [shipmentId]);

  useEffect(() => { load(false); }, [load]);

  type Picker = React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;
  const set = (key: string) => (e: Picker) =>
    setForm(f => ({ ...f, [key]: e.target.value }));

  const editable = (f: Field) => !!gate?.can.edit && (!gate.state.declared || !f.figure);

  /**
   * The caption under "Which document", written by the mode the cargo file travels by.
   *
   * 130 ties a sea movement to a bill of lading and an air movement to an air waybill, and the
   * master route refuses a sheet that names another paper. The route is the authority, but a desk
   * that only learns it said the wrong document after pressing Save has filled three lines for
   * nothing — so the expected paper is stated here, and the sentence turns red while the typed one
   * contradicts the file. A mode that names no document (mail, a multimodal consignment) says none.
   */
  function modeHint(key: string): { text: string; danger: boolean } | null {
    const want = gate?.file.mode_bill_kind;
    const mode = gate?.file.mode_label;
    if (key !== "billKind" || !want || !mode) return null;
    if (form.billKind && form.billKind !== want) {
      return { text: `This file moves by ${mode}, so its paper is ${aBill(want)}, not `
        + `${aBill(form.billKind)}.`, danger: true };
    }
    return { text: `The file moves by ${mode}, so this line names ${aBill(want)}.`,
      danger: false };
  }

  /** A field's own caption, unless the file's mode has a stronger claim on it. */
  function hintFor(f: Field): { text: string; danger: boolean } | null {
    const byMode = modeHint(f.key);
    if (byMode) return byMode;
    if (!f.hint) return null;
    if (f.key !== "invoiceCurrency") return { text: f.hint, danger: false };
    return { text: f.hint, danger: !!form[f.key].trim()
      && !/^[A-Za-z]{3}$/.test(form[f.key].trim()) };
  }

  /**
   * Say the office refused, then bring the sheet back — in that order, because load() clears the
   * error box. A refusal shown before the reload is a refusal nobody reads: the write is refused,
   * the numbers re-sync and the sentence that told the clerk which box to fix is gone.
   */
  async function refuse(message: string) {
    await load(true);
    setError(message);
  }

  async function save() {
    setError(null); setBusy(true);
    try {
      const bad = checkForm(form);
      if (bad) { setError(bad); return; }
      const res = await apiFetch(`/cargo/${shipmentId}/master`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyOf(form))
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { await refuse(serveError(j, "The office refused the sheet.")); return; }
      const g = j as Gate;
      setGate(g);
      setForm(formFrom(g.master, g.file.mode_bill_kind));
      onNotice?.(g.state.has_master
        ? `Master sheet saved for ${g.file.file_number}.`
        : "Master sheet saved.");
    } finally { setBusy(false); }
  }

  async function sign() {
    setError(null); setBusy(true);
    try {
      const res = await apiFetch(`/cargo/${shipmentId}/master/declare`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { await refuse(serveError(j, "The sheet would not sign.")); return; }
      const g = j as Gate;
      setGate(g);
      setForm(formFrom(g.master, g.file.mode_bill_kind));
      onNotice?.(`Signed${g.state.declared_by ? ` by ${g.state.declared_by}` : ""} on `
        + `${g.state.declared_on}. The figures are now the office's declaration; the papers and `
        + "the note can still change.");
    } finally { setBusy(false); }
  }

  async function bundle() {
    setError(null); setBusy(true);
    try {
      const name = await downloadMasterBundle(shipmentId);
      onNotice?.(`Downloaded ${name} — the printed sheet, the papers it names, and a README `
        + "that lists anything that could not be packed.");
    } catch (e: any) {
      setError(String(e?.message ?? "The archive failed to build."));
    } finally { setBusy(false); }
  }

  /** Point one slot at a paper already on the file, as its own write. */
  async function point(slot: Slot, docId: string) {
    setForm(f => ({ ...f, [slot.docKey]: docId }));
    setError(null); setSlotBusy(slot.key);
    try {
      const res = await apiFetch(`/cargo/${shipmentId}/master`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [slot.docKey]: docId || null })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { await refuse(serveError(j, "The paper would not attach.")); return; }
      const g = j as Gate;
      setGate(g);
      // The pointers are the whole write, so the typed figures stay as the clerk left them.
      setForm(f => ({ ...f, [slot.docKey]: docId }));
    } finally { setSlotBusy(null); }
  }

  /** Upload the paper onto the file and point this slot at it, in one motion. */
  async function upload(slot: Slot, file: File | undefined) {
    if (!file) return;
    setError(null); setSlotBusy(slot.key);
    try {
      const fd = new FormData();
      // Metadata before the file part: the server reads fields only as they arrive.
      fd.append("entityType", "shipment");
      fd.append("entityId", shipmentId);
      fd.append("kind", UPLOAD_KIND[slot.key]);
      fd.append("file", file);
      const res = await apiFetch("/documents", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(serveError(j, "The upload failed.")); return; }
      const fresh = await apiFetch(`/cargo/${shipmentId}/master`);
      const gj = await fresh.json().catch(() => ({}));
      if (!fresh.ok) { setError(serveError(gj, "The sheet would not reload.")); return; }
      setGate(gj as Gate);
      await point(slot, String((j as { id?: string }).id ?? ""));
      onNotice?.(`Filed ${file.name} behind ${slot.slot}.`);
    } finally { setSlotBusy(null); }
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  if (error && !gate) {
    return (
      <section className="no-print mt-24">
        <div role="alert" className="px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
            borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
          {error}
        </div>
      </section>
    );
  }
  if (!gate) {
    return <p className="pane-note mt-24 text-sm">Loading the master sheet…</p>;
  }

  const s = gate.state;
  const signed = s.declared;
  const statusColor = signed ? "var(--success)" : s.complete ? "var(--gold)" : "var(--ink-soft)";
  const statusText = signed ? `Signed ${s.declared_on ?? ""}`.trim()
    : s.has_master ? (s.complete ? "Ready to sign" : "Draft") : "No sheet yet";

  return (
    <section className="no-print mt-24">
      <div className="flex flex-wrap items-end justify-between gap-12">
        <h2 className="pane-note text-sm font-bold uppercase tracking-[0.14em]">
          Master document — invoice · packing list · bill / air waybill
        </h2>
        <span className="px-8 py-4 text-[10px] font-bold uppercase"
          style={{ borderLeft: `4px solid ${statusColor}`, color: "var(--ink)" }}>
          {statusText}
        </span>
      </div>
      <p className="pane-note mt-8 text-xs">
        One cover sheet for this file: what each of its three papers states, and the PDF filed
        behind each line. {signed
          ? "It is signed, so the figures are the declaration this office already gave and cannot be rewritten here — the papers and the note can still change."
          : "The figures are the office's declaration once signed: after that they freeze, while a paper that arrives late can still be attached."}
      </p>

      {gate.warnings.length > 0 && (
        <div role="alert" className="mt-16 space-y-6 rounded-card border p-16"
          style={{ borderColor: "var(--line)",
            background: "color-mix(in srgb, var(--warning) 8%, transparent)" }}>
          {gate.warnings.map((w, i) => (
            <p key={i} className="text-sm" style={{ color: "var(--ink)" }}>
              <span className="font-semibold">Check · </span>{w}
            </p>
          ))}
        </div>
      )}

      {error && (
        <div role="alert" className="mt-16 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
            borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
          {error}
        </div>
      )}

      <div className="mt-16 grid grid-cols-1 gap-16 md:grid-cols-3">
        {SLOTS.map(slot => {
          const named = gate.papers.find(p => p.id === form[slot.docKey]) ?? null;
          return (
            <div key={slot.key} className="rounded-card border bg-surface p-20"
              style={{ borderColor: "var(--line)" }}>
              <h3 className="text-xs font-bold uppercase tracking-[0.14em]"
                style={{ color: "var(--ink)" }}>
                {slot.paper}
              </h3>

              <div className="mt-12 space-y-12">
                {slot.fields.map(f => {
                  const hint = hintFor(f);
                  return (
                  <label key={f.key} className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>{f.label}</span>
                    {f.kind === "select" ? (
                      <select value={form[f.key]} onChange={set(f.key)} disabled={!editable(f)}
                        className={inputCls} style={inputStyle}>
                        <option value="">Not stated</option>
                        {BILL_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
                      </select>
                    ) : (
                      <input
                        type={f.kind === "date" ? "date" : f.kind === "number" ? "number" : "text"}
                        step={f.step}
                        maxLength={f.kind === "text" ? f.max : undefined}
                        placeholder={f.placeholder}
                        value={form[f.key]} onChange={set(f.key)} disabled={!editable(f)}
                        className={inputCls}
                        style={f.key === "invoiceCurrency"
                          ? { ...inputStyle, textTransform: "uppercase" } : inputStyle}
                      />
                    )}
                    {hint && (
                      <span className="mt-4 block text-[11px]"
                        style={{ color: hint.danger ? "var(--danger)" : "var(--ink-soft)" }}>
                        {hint.text}
                      </span>
                    )}
                  </label>
                  );
                })}
              </div>

              <div className="mt-16 border-t pt-16" style={{ borderColor: "var(--line)" }}>
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>The paper</span>
                <select value={form[slot.docKey]} disabled={!gate.can.edit || slotBusy === slot.key}
                  onChange={e => point(slot, e.target.value)}
                  className={inputCls} style={inputStyle}>
                  <option value="">Not pointed at a paper</option>
                  {gate.papers.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.file_name} · {kindLabel(p.kind)}
                      {p.id === form[slot.docKey] ? " — on this line" : ""}
                    </option>
                  ))}
                </select>
                {named ? (
                  <p className="mt-8 flex flex-wrap items-center gap-8 text-[11px]"
                    style={{ color: "var(--ink-soft)" }}>
                    <span>{fmtBytes(named.size_bytes)} · {kindLabel(named.kind)}</span>
                    <PaperLink docId={named.id} />
                  </p>
                ) : (
                  <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {gate.papers.length
                      ? "Nothing on this file is pointed at this line yet."
                      : "No papers are on this cargo file yet."}
                  </p>
                )}
                {gate.can.edit && (
                  <label className="mt-8 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    <span className="sr-only">Upload a PDF or photo for {slot.slot}</span>
                    <input type="file" accept=".pdf,image/jpeg,image/png,image/webp"
                      disabled={busy || slotBusy === slot.key}
                      onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; upload(slot, f); }}
                      className="text-xs" />
                    <span className="mt-4 block">
                      {slotBusy === slot.key ? "Filing…" : "or upload it — it is filed under the vault kind for this line"}
                    </span>
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-16 rounded-card border bg-surface p-20" style={{ borderColor: "var(--line)" }}>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
            {NOTE_FIELD.label}
          </span>
          <textarea rows={2} maxLength={NOTE_FIELD.max}
            value={form.notes} onChange={set("notes")} disabled={!gate.can.edit}
            placeholder="Anything the customs desk should hear with this sheet — e.g. the packing list arrived by email, paper to follow."
            className={inputCls} style={inputStyle} />
        </label>
        <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          {`${s.papers_named} of 3 lines point at a paper · `}
          {s.has_master ? `the file itself carries ${gate.file.weight_tonnes ?? "no"} t and ${gate.file.cbm ?? "no"} m³ — the master's weights are what the packing list says`
            : "nothing has been saved to this sheet yet"}
        </p>
      </div>

      <div className="mt-16 flex flex-wrap items-center gap-12">
        {gate.can.edit && (
          <button type="button" disabled={busy} onClick={save}
            className="waisha-btn rounded-input px-20 py-8 text-xs font-semibold disabled:opacity-60">
            Save the sheet
          </button>
        )}
        {gate.can.declare && !signed && (
          <button type="button" disabled={busy || !s.can_sign}
            onClick={sign}
            className="on-photo-btn rounded-input border px-20 py-8 text-xs font-semibold disabled:opacity-50"
            style={{ borderColor: "var(--gold)", color: "var(--ink)" }}
            title={s.can_sign ? "Sign the declaration" : `Still missing: ${s.gaps ?? "the sheet itself"}`}>
            Sign as declared
          </button>
        )}
        {gate.can.bundle && (
          <button type="button" disabled={busy || !s.has_master} onClick={bundle}
            className="on-photo-btn px-16 py-8 text-xs font-semibold disabled:opacity-50">
            Bundle the sheet and its papers
          </button>
        )}
        <Link href="#documents" className="pane-note text-xs underline">
          All papers on this file
        </Link>
      </div>

      {!signed && s.has_master && s.gaps && (
        <p className="pane-note mt-12 text-xs">
          {`A signature still needs ${s.gaps}.`}
          {gate.can.declare ? " The button opens as soon as the sheet is whole." : ""}
        </p>
      )}
      {signed && (
        <p className="pane-note mt-12 text-xs">
          {`Signed on ${s.declared_on ?? "—"} by ${s.declared_by ?? "a seat no longer on this company"}. `
            + "The papers behind each line and the note can still be changed; every change is in the audit."}
        </p>
      )}
    </section>
  );
}

/** The server's own sentence, with the names of the boxes it rejected. */
function serveError(json: any, fallback: string): string {
  const d = json?.error?.details;
  // A detail that only names a box is already said by the sentence above it; printing it again
  // reads as "(billKind: )" — the clerk sees a label with nothing to do with it.
  const said = Array.isArray(d) ? d.filter((x: any) => !!x?.message) : [];
  const extra = said.length
    ? ` (${said.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message}`).join("; ")})`
    : "";
  return (json?.error?.message ?? json?.message ?? fallback) + extra;
}

function PaperLink({ docId }: { docId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/documents/${docId}/url`).then(async res => {
      if (!res.ok || cancelled) return;
      const j = await res.json();
      if (!cancelled) setUrl(j.url);
    }).catch(() => { });
    return () => { cancelled = true; };
  }, [docId]);
  return url
    ? <a href={url} target="_blank" rel="noreferrer" className="doc-view underline"
        style={{ color: "var(--brand)" }}>View the paper</a>
    : <span>opening…</span>;
}
