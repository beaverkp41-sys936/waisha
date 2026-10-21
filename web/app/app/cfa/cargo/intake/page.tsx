"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, seatPermissions } from "../../../api-client";
import { kindLabel } from "../../../doc-kinds";

/**
 * The intake shelf. A clerk numbers the papers, this page reads what each page prints and
 * keeps every candidate beside the line it came from, and nothing here opens a cargo file —
 * that happens on the cargo desk, where the file number is issued and the money fields are
 * this office's own decision.
 *
 * A page with no text layer is a result, not an error: it is filed as "needs typing" and the
 * desk types it. Photographs and scans are never guessed at, because a confidently wrong
 * container number is a container that cannot be found.
 */

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

type ScanField = { value: string | number | string[]; raw: string; line: number; variants: number };
type Extraction = {
  fields: Record<string, ScanField>;
  containers: { number: string; line: number; valid: boolean }[];
  printed_reference: string | null;
  missing: string[];
  notes: string[];
  linesRead: number;
  unparsed: string[];
};
type Draft = {
  id: string; batch_id: string; position: number; label: string | null;
  shipment_type: string; printed_reference: string | null; extract_status: string;
  extract_notes: string | null; document_id: string; document_kind: string;
  file_name: string; size_bytes: number; created_at: string;
  committed_shipment_id: string | null; committed_file_number: string | null;
};
type Batch = {
  batch_id: string; pages: number; needs_typing: number; read_ok: number;
  filed: number; last_upload: string;
};
type QueueRow = {
  key: string; file: File; position: string; label: string;
  shipmentType: string; kind: string;
  state: "ready" | "reading" | "done" | "failed"; message: string;
};

const TYPES: Record<string, string> = {
  export: "Export (1)", import: "Import (4)",
  transhipment: "Transhipment (7)", transit: "Transit (8)"
};
/**
 * The kinds the scanner will file a page under — the server's INTAKE_KINDS list minus the two
 * that are not cargo paper (`contract`, `attachment`). Three of these labels say more than the
 * vault word does, because a scanned page often arrives as the pair rather than one sheet.
 */
const KINDS: string[] = [
  "declaration", "bill_of_lading", "arrival_notice", "packing_list", "invoice", "delivery_order",
  "delivery_note", "release_note", "assessment", "permit",
  "handover", "pod", "receipt",
  "prevision", "tdrn", "warehouse_entry", "warehouse_exit", "warehouse_receipt",
  "other"
];
const SCAN_HINTS: Record<string, string> = {
  bill_of_lading: "Bill of lading / AWB",
  invoice: "Invoice / advisory",
  other: "Other paper"
};
const scanKindLabel = (kind: string) => SCAN_HINTS[kind] ?? kindLabel(kind);

/** The cargo form's own field names, in the order a clerk reads them down the page. */
const FIELD_LABELS: [string, string][] = [
  ["shipmentType", "Shipment type"],
  ["consigneeName", "Consignee"],
  ["consignorName", "Consignor"],
  ["shippingLine", "Shipping line"],
  ["billNumber", "Bill number"],
  ["cargoDescription", "Cargo description"],
  ["hsCode", "HS / BHTN code"],
  ["containerType", "Container size"],
  ["containerNumbers", "Container numbers"],
  ["weightTonnes", "Weight (tonnes)"],
  ["cbm", "Measurement (CBM)"],
  ["eta", "ETA"],
  ["dischargeDate", "Discharge date"],
  ["carryInDate", "Carry-in date"],
  ["orderDate", "Order date"],
  ["documentReceiptDate", "Document receipt date"],
  ["termsDelivery", "Terms of delivery"],
  ["tansadNumber", "TANSAD / declaration no."],
  ["rcnNumber", "RCN number"],
  ["referenceNumber", "Reference number"],
  ["officeDeclaration", "Office of declaration"],
  ["borderPoint", "Border point"],
  ["nominatedIcd", "Nominated ICD"],
  ["cabinetPosition", "Cabinet position"],
  ["declarationMode", "Declaration mode"]
];

const STATUS_COLORS: Record<string, string> = {
  extracted: "var(--success)", manual: "var(--warning)",
  failed: "var(--danger)", pending: "var(--ink-soft)"
};
const STATUS_LABELS: Record<string, string> = {
  extracted: "Read", manual: "Needs typing", failed: "Could not read", pending: "Waiting"
};

const shown = (v: ScanField): string =>
  Array.isArray(v.value) ? v.value.join(", ") : String(v.value);

const KB = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

export default function CargoIntakePage() {
  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const cardStyle = { borderColor: "var(--line)" };

  const [batchId, setBatchId] = useState("");
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [needsTyping, setNeedsTyping] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<(Draft & { extraction: Extraction | null }) | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [canFile, setCanFile] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch("/cargo/intake");
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      setDrafts(j.drafts ?? []);
      setBatches(j.batches ?? []);
      setNeedsTyping(j.needsTyping ?? 0);
    } else {
      setError(errorText(j, "The intake shelf could not be listed."));
    }
    setLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // Minted here, not in the useState initializer: a uuid taken during render
    // differs on server and client, and React throws the whole page away on the
    // mismatch. Nothing can be read into a batch before this has run.
    setBatchId(crypto.randomUUID());
  }, []);
  useEffect(() => {
    // The shelf is open to a seat that may extract; only a seat that may open files is
    // offered the "fill the cargo form" step, so the button never leads to a 403.
    seatPermissions().then(keys => setCanFile(keys.has("shipments.create")));
  }, []);

  const openDraft = useCallback(async (id: string) => {
    setError(null); setSelected(id); setPageUrl(null);
    const res = await apiFetch(`/cargo/intake/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "That page could not be opened.")); setDetail(null); return; }
    setDetail(j);
  }, []);

  // The signed URL is what a <iframe> can load; a Bearer header cannot reach one.
  const viewPaper = useCallback(async (documentId: string) => {
    const res = await apiFetch(`/documents/${documentId}/url`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "The paper itself could not be opened.")); return; }
    setPageUrl(j.url ?? null);
  }, []);

  function pickFiles(files: FileList | null) {
    if (!files?.length) return;
    const rows: QueueRow[] = Array.from(files).slice(0, 60).map((file, i) => ({
      key: `${file.name}-${i}-${file.size}`,
      file,
      position: String(queue.length + i + 1),
      label: "", shipmentType: "import", kind: guessKind(file.name),
      state: "ready" as const, message: ""
    }));
    setQueue(q => [...q, ...rows]);
  }

  async function readBatch() {
    if (!queue.length) return;
    setError(null); setBusy(true); setNotice(null);
    let filed = 0, typed = 0;
    for (const row of queue) {
      setQueue(q => q.map(r => r.key === row.key ? { ...r, state: "reading", message: "Reading…" } : r));
      const fd = new FormData();
      // Every field must be appended before the file part or the API never sees it.
      if (row.position.trim()) fd.append("position", row.position.trim());
      fd.append("batchId", batchId);
      if (row.label.trim()) fd.append("label", row.label.trim());
      fd.append("shipmentType", row.shipmentType);
      fd.append("kind", row.kind);
      fd.append("file", row.file, row.file.name);
      const res = await apiFetch("/cargo/intake", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setQueue(q => q.map(r => r.key === row.key
          ? { ...r, state: "failed", message: errorText(j, "Could not read this page.") } : r));
        continue;
      }
      if (j.extractStatus === "extracted") filed++; else typed++;
      setQueue(q => q.map(r => r.key === row.key
        ? { ...r, state: "done", message: `${STATUS_LABELS[j.extractStatus] ?? j.extractStatus} — ${j.extractNotes ?? ""}` } : r));
    }
    setNotice(typed
      ? `${filed} page(s) read; ${typed} page(s) need typing by hand. Nothing was saved as a cargo file yet.`
      : `${filed} page(s) read and waiting on the shelf. Nothing was saved as a cargo file yet.`);
    setBusy(false);
    load();
  }

  async function reRead(id: string) {
    setError(null);
    const res = await apiFetch(`/cargo/intake/${id}/read`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "The page could not be read again.")); return; }
    setNotice(`Read again — ${STATUS_LABELS[j.extractStatus] ?? j.extractStatus}.`);
    await openDraft(id);
    load();
  }

  async function relabel(id: string, patch: Record<string, unknown>) {
    setError(null);
    const res = await apiFetch(`/cargo/intake/${id}/details`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "That page could not be re-labelled.")); return false; }
    load();
    return true;
  }

  async function remove(id: string) {
    setError(null);
    const res = await apiFetch(`/cargo/intake/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(errorText(j, "That page could not be taken off the shelf."));
      return;
    }
    if (selected === id) { setSelected(null); setDetail(null); }
    load();
  }

  const grouped = useMemo(() => {
    const by = new Map<string, Draft[]>();
    drafts.forEach(d => {
      const list = by.get(d.batch_id) ?? [];
      list.push(d); by.set(d.batch_id, list);
    });
    return [...by.entries()].map(([batch, rows]) => ({
      batch, rows: rows.sort((a, b) => a.position - b.position)
    }));
  }, [drafts]);

  const fields = detail?.extraction?.fields ?? {};
  const present = FIELD_LABELS.filter(([k]) => fields[k]);
  const untouched = FIELD_LABELS.filter(([k]) => !fields[k] && detail?.extraction?.missing?.includes(k));

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="flex items-start justify-between gap-16">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Scan papers into cargo files</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Number the PDFs and the desk reads what each page prints — consignee, bill number, HS code,
            containers, dates. Every value stays beside the line it came from, and nothing here opens a
            cargo file: you check the fields, then save the file on the cargo desk.
          </p>
        </div>
        <Link href="/app/cfa/cargo" className="on-photo-btn shrink-0 px-16 py-8 text-xs font-semibold">
          Cargo files
        </Link>
      </div>

      {error && <div role="alert" className="mt-16 mb-8 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-8 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {/* ---------- The batch being numbered ---------- */}
      <section className="mt-24 rounded-card border bg-surface p-24" style={cardStyle}>
        <p className="text-xs font-bold uppercase tracking-[0.14em] pb-8 mb-12 border-b"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
          {batchId ? `Batch ${batchId.slice(0, 8)}` : "New batch"}
        </p>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>PDF pages</span>
          <input type="file" accept="application/pdf" multiple
            onChange={e => pickFiles(e.target.files)}
            className={inputCls} style={inputStyle} />
        </label>
        <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
          A digital PDF is read. A photograph or a scan has no text layer, so it is filed as needing
          typing rather than guessed at — 8 MB per page, up to 60 pages in a batch.
        </p>

        {queue.length > 0 && (
          <div className="mt-16 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className="p-8">No.</th><th className="p-8">Name it</th>
                  <th className="p-8">Type</th><th className="p-8">Paper</th>
                  <th className="p-8">File</th><th className="p-8">Result</th>
                </tr>
              </thead>
              <tbody>
                {queue.map((r, i) => (
                  <tr key={r.key}>
                    <td className="p-8">
                      <input aria-label={`Page number ${i + 1}`} value={r.position}
                        onChange={e => setQueue(q => q.map(x => x.key === r.key ? { ...x, position: e.target.value } : x))}
                        className="w-16 rounded-input border px-8 py-4 text-sm" style={inputStyle} />
                    </td>
                    <td className="p-8">
                      <input aria-label={`Label ${i + 1}`} value={r.label} placeholder={r.file.name}
                        onChange={e => setQueue(q => q.map(x => x.key === r.key ? { ...x, label: e.target.value } : x))}
                        className="w-40 rounded-input border px-8 py-4 text-sm" style={inputStyle} />
                    </td>
                    <td className="p-8">
                      <select aria-label={`Shipment type ${i + 1}`} value={r.shipmentType}
                        onChange={e => setQueue(q => q.map(x => x.key === r.key ? { ...x, shipmentType: e.target.value } : x))}
                        className="rounded-input border px-8 py-4 text-xs" style={inputStyle}>
                        {Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </td>
                    <td className="p-8">
                      <select aria-label={`Paper kind ${i + 1}`} value={r.kind}
                        onChange={e => setQueue(q => q.map(x => x.key === r.key ? { ...x, kind: e.target.value } : x))}
                        className="rounded-input border px-8 py-4 text-xs" style={inputStyle}>
                        {KINDS.map(k => <option key={k} value={k}>{scanKindLabel(k)}</option>)}
                      </select>
                    </td>
                    <td className="p-8 text-xs" style={{ color: "var(--ink)" }}>
                      {r.file.name}<span className="ml-8" style={{ color: "var(--ink-soft)" }}>{KB(r.file.size)}</span>
                    </td>
                    <td className="p-8 text-xs" style={{ color: r.state === "failed" ? "var(--danger)" : "var(--ink-soft)" }}>
                      {r.message || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-16 flex flex-wrap gap-12">
          <button type="button" onClick={readBatch} disabled={busy || !queue.length}
            className="waisha-btn rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-60">
            {busy ? "Reading…" : `Read ${queue.length || ""} page(s)`}
          </button>
          <button type="button" disabled={busy}
            onClick={() => { setQueue([]); setBatchId(crypto.randomUUID()); setNotice(null); }}
            className="rounded-input border px-24 py-8 text-xs font-semibold disabled:opacity-50"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>New batch</button>
          {queue.length > 0 && (
            <button type="button" disabled={busy} onClick={() => setQueue([])}
              className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-50"
              style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>Clear the list</button>
          )}
        </div>
      </section>

      {needsTyping > 0 && (
        <p className="mt-16 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
          {needsTyping} unfiled page(s) on the shelf have to be typed in — their PDFs carry no text layer.
        </p>
      )}

      {/* ---------- The shelf ---------- */}
      <section className="mt-24">
        <p className="text-xs font-bold uppercase tracking-[0.14em] pb-8 mb-12 border-b"
          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
          On the shelf — {drafts.length} page(s) in {batches.length} batch(es)
        </p>
        {!loaded && <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</p>}
        {loaded && drafts.length === 0 && (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
            Nothing on the shelf yet. Add PDFs above and read them.
          </p>
        )}
        {grouped.map(({ batch, rows }) => (
          <div key={batch} className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className="p-12">No.</th><th className="p-12">Paper</th>
                  <th className="p-12">Type</th><th className="p-12">Read as</th>
                  <th className="p-12">Reference found</th><th className="p-12">Filed on</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d, i) => (
                  <tr key={d.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className="p-12 font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{d.position}</td>
                    <td className="p-12" style={{ color: "var(--ink)" }}>
                      {d.label || d.file_name}
                      <span className="ml-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>
                        {kindLabel(d.document_kind)} · {KB(d.size_bytes)}
                      </span>
                    </td>
                    <td className="p-12" style={{ color: "var(--ink-soft)" }}>{TYPES[d.shipment_type] ?? d.shipment_type}</td>
                    <td className="p-12">
                      <span className="px-8 py-4 text-[10px] font-bold uppercase"
                        style={{ borderLeft: `4px solid ${STATUS_COLORS[d.extract_status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                        {STATUS_LABELS[d.extract_status] ?? d.extract_status}
                      </span>
                    </td>
                    <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{d.printed_reference || "—"}</td>
                    <td className="p-12" style={{ color: d.committed_file_number ? "var(--success)" : "var(--ink-soft)" }}>
                      {d.committed_file_number || "not filed"}
                    </td>
                    <td className="p-12 text-right whitespace-nowrap">
                      <button type="button" onClick={() => openDraft(d.id)}
                        className="text-xs underline" style={{ color: "var(--brand)" }}>
                        {selected === d.id ? "Shown" : "Review"}
                      </button>
                      <button type="button" onClick={() => remove(d.id)}
                        className="ml-16 text-xs underline" style={{ color: "var(--danger)" }}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="border-t px-12 py-8 text-[11px]"
              style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              Batch {batch.slice(0, 8)} · {rows.length} page(s) on this row of the shelf
            </p>
          </div>
        ))}
      </section>

      {/* ---------- One page, as the reader found it ---------- */}
      {detail && (
        <section className="mt-24 rounded-card border bg-surface p-24" style={cardStyle}>
          <div className="flex flex-wrap items-start justify-between gap-12">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Page {detail.position} — {detail.label || detail.file_name}
              </p>
              <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>
                {STATUS_LABELS[detail.extract_status] ?? detail.extract_status}: {detail.extract_notes}
              </p>
            </div>
            <div className="flex flex-wrap gap-8">
              <button type="button" onClick={() => viewPaper(detail.document_id)}
                className="rounded-input border px-16 py-8 text-xs font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Open the paper</button>
              <button type="button" onClick={() => reRead(detail.id)}
                className="rounded-input border px-16 py-8 text-xs font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Read again</button>
            </div>
          </div>

          {pageUrl && (
            <iframe title={`Page ${detail.position} — ${detail.file_name}`} src={pageUrl}
              className="mt-16 h-[420px] w-full rounded-card border" style={{ borderColor: "var(--line)" }} />
          )}

          {/* Keyed by the page: the three controls below are seeded with defaultValue,
              so without a remount the previous page's number and name would stay on
              screen and a blur would write them onto the page just opened. */}
          <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-12" key={detail.id}>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Number</span>
              <input type="number" min={1} max={60} defaultValue={detail.position}
                disabled={Boolean(detail.committed_shipment_id)}
                onBlur={async e => {
                  const v = Number(e.target.value);
                  if (v === detail.position || !v) return;
                  if (await relabel(detail.id, { position: v })) {
                    setDetail(d => d ? { ...d, position: v } : d);
                    setNotice(`Page re-numbered ${v}.`);
                  }
                }}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Name it</span>
              <input defaultValue={detail.label ?? ""} placeholder={detail.file_name}
                disabled={Boolean(detail.committed_shipment_id)}
                onBlur={async e => {
                  const v = e.target.value.trim();
                  if (v === (detail.label ?? "")) return;
                  if (await relabel(detail.id, { label: v })) {
                    setDetail(d => d ? { ...d, label: v } : d);
                  }
                }}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Shipment type</span>
              <select defaultValue={detail.shipment_type}
                disabled={Boolean(detail.committed_shipment_id)}
                onChange={async e => {
                  if (await relabel(detail.id, { shipmentType: e.target.value })) {
                    setDetail(d => d ? { ...d, shipment_type: e.target.value } : d);
                  }
                }}
                className={inputCls} style={inputStyle}>
                {Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>

          {present.length > 0 && (
            <div className="mt-24 overflow-hidden rounded-card border" style={cardStyle}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className="p-12">Field</th><th className="p-12">Taken as</th>
                    <th className="p-12">Printed on the page</th>
                  </tr>
                </thead>
                <tbody>
                  {present.map(([key, label], i) => {
                    const v = fields[key]!;
                    return (
                      <tr key={key} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className="p-12 whitespace-nowrap font-semibold" style={{ color: "var(--ink)" }}>{label}</td>
                        <td className="p-12" style={{ color: "var(--ink)" }}>
                          {shown(v)}
                          {v.variants > 1 && (
                            <span className="ml-8 text-[10px] font-bold uppercase" style={{ color: "var(--warning)" }}>
                              {v.variants} on the page
                            </span>
                          )}
                        </td>
                        <td className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                          <span className="tabular-nums">line {v.line}:</span> {v.raw}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {detail.extraction?.containers && detail.extraction.containers.length > 0 && (
            <p className="mt-16 text-xs" style={{ color: "var(--ink-soft)" }}>
              Containers as printed:{" "}
              {detail.extraction.containers.map(c => (
                <span key={c.number} className="mr-12 tabular-nums"
                  style={{ color: c.valid ? "var(--ink)" : "var(--danger)" }}
                  title={c.valid ? `Check digit agrees (line ${c.line})` : `Check digit does not agree — read it against the paper (line ${c.line})`}>
                  {c.number}{c.valid ? "" : " ⚠"}
                </span>
              ))}
            </p>
          )}

          {untouched.length > 0 && (
            <p className="mt-16 text-sm" style={{ color: "var(--warning)" }}>
              Still to type: {untouched.map(([l]) => l).join(", ")}.
            </p>
          )}

          {(detail.extraction?.notes?.length ?? 0) > 0 && (
            <ul className="mt-16 list-disc pl-20 text-xs" style={{ color: "var(--ink-soft)" }}>
              {detail.extraction!.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}

          {(detail.extraction?.unparsed?.length ?? 0) > 0 && (
            <details className="mt-16">
              <summary className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Lines the reader did not place ({detail.extraction!.unparsed.length})
              </summary>
              <pre className="mt-8 overflow-x-auto whitespace-pre-wrap rounded-card border p-12 text-xs"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                {detail.extraction!.unparsed.join("\n")}
              </pre>
            </details>
          )}

          <div className="mt-24 flex flex-wrap items-center gap-12">
            {canFile && !detail.committed_shipment_id && (
              <Link href={`/app/cfa/cargo?draft=${detail.id}`}
                className="waisha-btn rounded-input px-24 py-8 text-xs font-semibold">
                Fill the cargo form with these
              </Link>
            )}
            {detail.committed_file_number && (
              <Link href={`/app/cfa/cargo/${detail.committed_shipment_id}`}
                className="text-xs underline" style={{ color: "var(--brand)" }}>
                Open {detail.committed_file_number}
              </Link>
            )}
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
              {detail.committed_shipment_id
                ? "Filed. The paper now sits on that cargo file's documents."
                : "Nothing has been saved as a cargo file. Check the values, then fill the form."}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

function guessKind(name: string): string {
  const n = name.toLowerCase();
  if (/bl\b|bill|b_l|b-l/.test(n)) return "bill_of_lading";
  // 117: the three slips a store signs, then the prevision note. These come before the older
  // tests because a file called "prevision notice.pdf" would otherwise be read as an arrival.
  if (/warehouse.*receipt|goods.*receipt/.test(n)) return "warehouse_receipt";
  if (/warehouse.*entr|gate.*entr|store.*entr/.test(n)) return "warehouse_entry";
  if (/warehouse.*exit|gate.*exit|store.*exit|out.?going/.test(n)) return "warehouse_exit";
  if (/tdrn/.test(n)) return "tdrn";
  if (/prevision|provision/.test(n)) return "prevision";
  if (/declar|tansad|dsid|c10/.test(n)) return "declaration";
  if (/invoice|advis|charges/.test(n)) return "invoice";
  if (/pack/.test(n)) return "packing_list";
  if (/arrival|notice|manifest/.test(n)) return "arrival_notice";
  if (/delivery|do\b/.test(n)) return "delivery_order";
  if (/rcn/.test(n)) return "assessment";
  return "other";
}
