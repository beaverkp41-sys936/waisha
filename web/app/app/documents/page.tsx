"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Doc {
  id: string; entity_type: string; entity_id: string; kind: string;
  file_name: string; mime_type: string; size_bytes: number; created_at: string;
  entity_label: string | null;
}

const ENTITY_LABELS: Record<string, string> = {
  tenant: "Company", user: "Staff member", vessel: "Vessel",
  driver: "Driver", trip: "Trip", shipment: "Cargo file", message: "Message"
};
const KIND_LABELS: Record<string, string> = {
  logo: "Logo", avatar: "Photo", licence: "Licence", insurance: "Insurance",
  inspection: "Inspection", road_licence: "Road licence", delivery_note: "Delivery note",
  invoice: "Invoice", bill_of_lading: "Bill of Lading", packing_list: "Packing list",
  other: "Other", attachment: "Attachment"
};

export default function DocumentsVaultPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [entityType, setEntityType] = useState("");
  const [kind, setKind] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (entityType) qs.set("entityType", entityType);
    if (kind) qs.set("kind", kind);
    const res = await apiFetch(`/documents/vault${qs.toString() ? `?${qs}` : ""}`);
    if (res.ok) setDocs(await res.json());
    setLoaded(true);
  }, [entityType, kind]);

  useEffect(() => { load(); }, [load]);

  async function remove(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/documents/${id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Failed to delete.")); return; }
    setNotice("Document deleted.");
    load();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Documents vault</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Every file stored in the portal — licences, insurance, invoices, bills of lading and packing lists.
      </p>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      <section className="mt-24 grid grid-cols-2 gap-12">
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Attached to</span>
          <select value={entityType} onChange={e => setEntityType(e.target.value)} className={inputCls} style={inputStyle}>
            <option value="">Everything</option>
            {Object.entries(ENTITY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Document type</span>
          <select value={kind} onChange={e => setKind(e.target.value)} className={inputCls} style={inputStyle}>
            <option value="">All types</option>
            {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
      </section>

      <div className="mt-24 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Document</th><th className="p-12">Type</th>
              <th className="p-12">Attached to</th><th className="p-12 text-right">Size</th>
              <th className="p-12 text-right">Uploaded</th><th></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d, i) => (
              <tr key={d.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{d.file_name}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{KIND_LABELS[d.kind] ?? d.kind}</td>
                <td className="p-12" style={{ color: "var(--ink)" }}>
                  {d.entity_label ?? "—"}
                  <span className="ml-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>
                    {ENTITY_LABELS[d.entity_type] ?? d.entity_type}
                  </span>
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {(d.size_bytes / 1024).toFixed(0)} KB
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {new Date(d.created_at).toLocaleDateString()}
                </td>
                <td className="p-12 text-right whitespace-nowrap">
                  <DocLink docId={d.id} />
                  <button type="button" className="ml-12 underline" style={{ color: "var(--danger)" }}
                    onClick={() => remove(d.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {loaded && docs.length === 0 && (
              <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No documents yet — upload files from the Profile (logo), Staff (photos), Fleet, Drivers or cargo files.
              </td></tr>
            )}
            {!loaded && (
              <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DocLink({ docId }: { docId: string }) {
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
    ? <a href={url} target="_blank" rel="noreferrer" className="underline" style={{ color: "var(--brand)" }}>View</a>
    : <span style={{ color: "var(--ink-soft)" }}>—</span>;
}
