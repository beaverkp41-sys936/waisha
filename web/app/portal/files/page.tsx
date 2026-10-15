"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { portalFetch } from "../api-client";
import { STAGE_LABELS, STAGE_COLORS, TYPE_LABELS, CONTAINER_LABELS, fmt, fmtDate, errorText } from "../labels";

export default function PortalFilesPage() {
  const [files, setFiles] = useState<any[]>([]);
  const [stage, setStage] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await portalFetch("/portal/files");
        const j = await res.json().catch(() => ({}));
        if (!res.ok) setError(errorText(j, "Could not load your files."));
        else setFiles(j);
      } catch (e: any) {
        if (e.message !== "session ended") setError("Could not load your files.");
      } finally { setReady(true); }
    })();
  }, []);

  const term = search.trim().toLowerCase();
  const shown = files.filter(f =>
    (!stage || f.stage === stage) &&
    (!term || f.file_number.toLowerCase().includes(term)
      || (f.consignee_name ?? "").toLowerCase().includes(term)
      || (f.consignor_name ?? "").toLowerCase().includes(term)
      || (f.bill_number ?? "").toLowerCase().includes(term)));

  const inputCls = "rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>My files</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Every shipment your agent handles for your company, with live clearance status.
      </p>

      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      <div className="mt-24 mb-16 flex flex-wrap gap-12">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search file number, consignee, B/L…"
          className={`${inputCls} min-w-[220px] flex-1`} style={inputStyle} />
        <select value={stage} onChange={e => setStage(e.target.value)} className={inputCls} style={inputStyle}>
          <option value="">All stages</option>
          {Object.entries(STAGE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      {!ready ? (
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</p>
      ) : shown.length === 0 ? (
        <div className="rounded-card border bg-surface p-24 text-sm" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
          No files match. Files appear here when your agent opens them in your company&apos;s name.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">File</th><th className="p-12">Type</th><th className="p-12">Stage</th>
                <th className="p-12">Status</th><th className="p-12">ETA</th>
                <th className="p-12">Containers</th><th className="p-12">Payment</th><th className="p-12"></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((f, i) => (
                <tr key={f.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                    {f.file_number}
                    {f.bill_number && <span className="block text-xs font-normal" style={{ color: "var(--ink-soft)" }}>B/L {f.bill_number}</span>}
                  </td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>{TYPE_LABELS[f.shipment_type] ?? f.shipment_type}</td>
                  <td className="p-12">
                    <span className="text-xs font-semibold" style={{ color: STAGE_COLORS[f.stage] ?? "var(--ink)" }}>
                      {STAGE_LABELS[f.stage] ?? f.stage}
                    </span>
                  </td>
                  <td className="p-12 text-xs font-semibold uppercase" style={{ color: "var(--ink-soft)" }}>{f.status}</td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                    {f.eta ? `${fmtDate(f.eta)}${f.eta_days != null ? ` (${f.eta_days >= 0 ? `in ${f.eta_days}d` : `${Math.abs(f.eta_days)}d ago`})` : ""}` : "—"}
                  </td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                    {f.container_count ? `${f.container_count} × ${CONTAINER_LABELS[f.container_type] ?? f.container_type}` : (CONTAINER_LABELS[f.container_type] ?? "—")}
                  </td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                    {f.payment_amount ? `${fmt(f.payment_amount)} (${f.payment_status})` : "—"}
                  </td>
                  <td className="p-12 text-right">
                    <Link href={`/portal/files/${f.id}`} className="text-xs underline" style={{ color: "var(--brand)" }}>Open</Link>
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
