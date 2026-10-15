"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { portalFetch } from "../../api-client";
import {
  STAGE_LABELS, STAGE_COLORS, STAGE_ORDER, TYPE_LABELS, CONTAINER_LABELS,
  fmt, fmtDate, fmtDateTime, fmtBytes, errorText
} from "../../labels";

export default function PortalFileDetailPage() {
  const params = useParams<{ id: string }>();
  const [file, setFile] = useState<any>(null);
  const [documents, setDocuments] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [ready, setReady] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await portalFetch(`/portal/files/${params.id}`);
      const j = await res.json().catch(() => ({}));
      if (res.status === 404) setNotFound(true);
      else if (!res.ok) setError(errorText(j, "Could not load this file."));
      else { setFile(j.file); setDocuments(j.documents); }
    } catch (e: any) {
      if (e.message !== "session ended") setError("Could not load this file.");
    } finally { setReady(true); }
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  async function openDocument(id: string) {
    const res = await portalFetch(`/portal/documents/${id}/url`);
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.url) window.open(j.url, "_blank", "noopener");
  }

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setUploadMsg(null);
    const f = fileInput.current?.files?.[0];
    if (!f) { setUploadMsg("Choose a file first."); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("shipmentId", params.id);
      fd.append("file", f);
      const res = await portalFetch("/portal/documents", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setUploadMsg(errorText(j, "Upload failed.")); return; }
      setUploadMsg(`Uploaded “${j.fileName}”.`);
      if (fileInput.current) fileInput.current.value = "";
      load();
    } finally { setUploading(false); }
  }

  if (!ready) {
    return <div className="px-16 py-64 text-center text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</div>;
  }
  if (notFound) {
    return (
      <div className="mx-auto max-w-[640px] px-16 py-64">
        <div className="rounded-card border bg-surface p-24 text-center" style={{ borderColor: "var(--line)" }}>
          <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>File not found</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            This cargo file is not shared with your company.
          </p>
          <Link href="/portal/files" className="mt-16 inline-block text-sm underline" style={{ color: "var(--brand)" }}>
            Back to my files
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
  if (!file) return null;

  const stageIdx = STAGE_ORDER.indexOf(file.stage);

  const fields: [string, string][] = [
    ["Shipment type", TYPE_LABELS[file.shipment_type] ?? file.shipment_type],
    ["HS code", file.hs_code ?? "—"],
    ["Cargo description", file.cargo_description ?? "—"],
    ["Containers", file.container_count
      ? `${file.container_count} × ${CONTAINER_LABELS[file.container_type] ?? file.container_type}`
      : (CONTAINER_LABELS[file.container_type] ?? "—")],
    ["Container numbers", (file.container_numbers ?? []).join(", ") || "—"],
    ["Volume / weight", [file.cbm ? `${file.cbm} CBM` : null, file.weight_tonnes ? `${file.weight_tonnes} t` : null].filter(Boolean).join(" · ") || "—"],
    ["Consignee", file.consignee_name ?? "—"],
    ["Consignor", file.consignor_name ?? "—"],
    ["Shipping line", file.shipping_line ?? "—"],
    ["Bill of lading", file.bill_number ?? "—"],
    ["Order date", fmtDate(file.order_date)],
    ["Documents received", fmtDate(file.document_receipt_date)],
    ["ETA", fmtDate(file.eta)],
    ["Discharge date", fmtDate(file.discharge_date)],
    ["Carry-in date", fmtDate(file.carry_in_date)],
    ["Terms of delivery", file.terms_delivery ?? "—"],
    ["TANSAD number", file.tansad_number ?? "—"],
    ["RCN number", file.rcn_number ?? "—"],
    ["Your reference", file.reference_number ?? "—"],
    ["Amount payable", file.payment_amount ? `${fmt(file.payment_amount)} (${file.payment_status})` : "—"]
  ];

  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <Link href="/portal/files" className="text-xs underline" style={{ color: "var(--brand)" }}>← My files</Link>
      <div className="mt-12 flex flex-wrap items-center justify-between gap-12">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>{file.file_number}</h1>
          <p className="mt-4 text-sm" style={{ color: "var(--ink-soft)" }}>
            {TYPE_LABELS[file.shipment_type] ?? file.shipment_type} ·{" "}
            {file.consignee_name ?? file.consignor_name}
          </p>
        </div>
        <span className="px-12 py-6 text-[10px] font-bold uppercase tracking-[0.14em]"
          style={{
            background: `color-mix(in srgb, ${STAGE_COLORS[file.stage] ?? "var(--ink)"} 12%, transparent)`,
            color: STAGE_COLORS[file.stage] ?? "var(--ink)",
            borderLeft: `4px solid ${STAGE_COLORS[file.stage] ?? "var(--ink)"}`
          }}>
          {STAGE_LABELS[file.stage] ?? file.stage} · {file.status}
        </span>
      </div>

      {/* Stage stepper */}
      <div className={`${card} mt-24`} style={cardStyle}>
        <div className="flex items-center">
          {STAGE_ORDER.map((s, i) => {
            const done = stageIdx >= i;
            return (
              <div key={s} className="flex flex-1 items-center last:flex-none">
                <div className="flex flex-col items-center">
                  <span className="flex h-24 w-24 items-center justify-center rounded-full text-[10px] font-bold"
                    style={{
                      background: done ? "var(--brand-deep)" : "var(--milk-deep)",
                      color: done ? "#fff" : "var(--ink-soft)",
                      border: `2px solid ${stageIdx === i ? "var(--gold)" : done ? "var(--brand-deep)" : "var(--line)"}`
                    }}>
                    {i + 1}
                  </span>
                  <span className="mt-8 whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.08em]"
                    style={{ color: stageIdx === i ? "var(--ink)" : "var(--ink-soft)" }}>
                    {STAGE_LABELS[s]}
                  </span>
                </div>
                {i < STAGE_ORDER.length - 1 && (
                  <span className="mx-8 mb-20 h-[2px] flex-1"
                    style={{ background: stageIdx > i ? "var(--brand-deep)" : "var(--line)" }} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className={`${card} mt-24`} style={cardStyle}>
        <h2 className="mb-16 text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>File details</h2>
        <dl className="grid grid-cols-1 gap-x-24 gap-y-12 md:grid-cols-2">
          {fields.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-12 border-b pb-8" style={{ borderColor: "var(--line)" }}>
              <dt className="text-xs font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>{label}</dt>
              <dd className="text-right text-sm" style={{ color: "var(--ink)" }}>{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-12 text-[10px]" style={{ color: "var(--ink-soft)" }}>
          Last updated {fmtDateTime(file.updated_at)}
        </p>
      </div>

      <div className={`${card} mt-24`} style={cardStyle}>
        <h2 className="mb-16 text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Documents</h2>
        {documents.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No documents on this file yet.</p>
        ) : (
          <ul className="space-y-8">
            {documents.map(d => (
              <li key={d.id} className="flex items-center justify-between gap-12 rounded-input border px-12 py-8"
                style={{ borderColor: "var(--line)" }}>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold" style={{ color: "var(--ink)" }}>{d.file_name}</span>
                  <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    {d.kind.replace(/_/g, " ")} · {fmtBytes(d.size_bytes)} · {fmtDateTime(d.created_at)}
                  </span>
                </span>
                <button type="button" onClick={() => openDocument(d.id)}
                  className="whitespace-nowrap text-xs underline" style={{ color: "var(--brand)" }}>
                  View
                </button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={upload} className="mt-24 border-t pt-16" style={{ borderColor: "var(--line)" }}>
          <p className="mb-8 text-xs font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>
            Share a document with your agent
          </p>
          <div className="flex flex-wrap items-center gap-12">
            <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
              className="text-sm" disabled={uploading} />
            <button type="submit" disabled={uploading}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-60">
              {uploading ? "Uploading…" : "Upload"}
            </button>
          </div>
          {uploadMsg && <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>{uploadMsg}</p>}
          <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
            JPEG, PNG, WebP or PDF, up to 8 MB. Uploaded files go straight to your agent&apos;s file.
          </p>
        </form>
      </div>
    </div>
  );
}
