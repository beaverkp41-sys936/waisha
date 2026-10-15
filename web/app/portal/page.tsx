"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { portalFetch } from "./api-client";
import { STAGE_LABELS, STAGE_COLORS, TYPE_LABELS, fmt, fmtDate, fmtDateTime, fmtBytes, errorText } from "./labels";

interface Overview {
  client: { id: string; name: string; fullName: string | null };
  counts: { total: number; open: number; on_hold: number; in_customs: number; arriving_soon: number; completed: number };
  outstanding: { count: number; amount: number };
  recentFiles: any[];
  recentDocuments: any[];
}

export default function PortalOverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await portalFetch("/portal/overview");
        const j = await res.json().catch(() => ({}));
        if (res.status === 403) setDenied(errorText(j, "Portal access is not active."));
        else if (!res.ok) setError(errorText(j, "Could not load your portal."));
        else setData(j);
      } catch (e: any) {
        if (e.message !== "session ended") setError("Could not load your portal.");
      } finally { setReady(true); }
    })();
  }, []);

  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  if (denied) {
    return (
      <div className="mx-auto max-w-[640px] px-16 py-64">
        <div className={`${card} text-center`} style={cardStyle}>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Portal not activated</h1>
          <p className="mt-12 text-sm" style={{ color: "var(--ink-soft)" }}>{denied}</p>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Once your clearing agent creates a portal account for your company, your files,
            invoices and documents will appear here.
          </p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return <div className="px-16 py-64 text-center text-sm" style={{ color: "var(--ink-soft)" }}>Loading your portal…</div>;
  }
  if (error) {
    return (
      <div className="mx-auto max-w-[640px] px-16 py-64">
        <div role="alert" className="px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error}
        </div>
      </div>
    );
  }
  if (!data) return null;

  const stats = [
    { label: "Files in progress", value: data.counts.open, hint: "open files" },
    { label: "On hold", value: data.counts.on_hold, hint: "awaiting action" },
    { label: "In customs", value: data.counts.in_customs, hint: "clearance stage" },
    { label: "Arriving ≤ 7 days", value: data.counts.arriving_soon, hint: "ETA this week" },
    { label: "Completed", value: data.counts.completed, hint: "all time" }
  ];

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>
        Hello, {data.client.fullName?.split(" ")[0] ?? data.client.name}
      </h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Tracking shipments for <strong style={{ color: "var(--ink)" }}>{data.client.name}</strong>.
      </p>

      {data.outstanding.count > 0 && (
        <Link href="/portal/invoices"
          className="mt-24 block rounded-card border p-16 transition-colors"
          style={{ borderColor: "var(--warning)", background: "color-mix(in srgb, var(--warning) 7%, transparent)" }}>
          <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
            {data.outstanding.count} invoice{data.outstanding.count === 1 ? "" : "s"} awaiting payment —{" "}
            TZS {fmt(data.outstanding.amount)}
          </span>
          <span className="ml-8 text-xs underline" style={{ color: "var(--brand)" }}>Review invoices</span>
        </Link>
      )}

      <div className="mt-24 grid grid-cols-2 gap-12 md:grid-cols-5">
        {stats.map(s => (
          <div key={s.label} className={card} style={cardStyle}>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{s.label}</p>
            <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{s.value}</p>
            <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>{s.hint}</p>
          </div>
        ))}
      </div>

      <section className={`${card} mt-24`} style={cardStyle}>
        <div className="mb-16 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Recent files</h2>
          <Link href="/portal/files" className="text-xs underline" style={{ color: "var(--brand)" }}>View all</Link>
        </div>
        {data.recentFiles.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
            No files yet. Your agent&apos;s shipments for your company will appear here automatically.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="py-8 pr-12">File</th><th className="py-8 pr-12">Type</th>
                <th className="py-8 pr-12">Stage</th><th className="py-8 pr-12">ETA</th>
                <th className="py-8 pr-12">Payment</th><th className="py-8"></th>
              </tr>
            </thead>
            <tbody>
              {data.recentFiles.map(f => (
                <tr key={f.id} className="border-b" style={{ borderColor: "var(--line)" }}>
                  <td className="py-8 pr-12 font-semibold" style={{ color: "var(--ink)" }}>{f.file_number}</td>
                  <td className="py-8 pr-12" style={{ color: "var(--ink-soft)" }}>{TYPE_LABELS[f.shipment_type] ?? f.shipment_type}</td>
                  <td className="py-8 pr-12">
                    <span className="text-xs font-semibold" style={{ color: STAGE_COLORS[f.stage] ?? "var(--ink)" }}>
                      {STAGE_LABELS[f.stage] ?? f.stage}
                    </span>
                  </td>
                  <td className="py-8 pr-12" style={{ color: "var(--ink-soft)" }}>
                    {f.eta ? `${fmtDate(f.eta)}${f.eta_days != null ? ` (${f.eta_days >= 0 ? `in ${f.eta_days}d` : `${Math.abs(f.eta_days)}d ago`})` : ""}` : "—"}
                  </td>
                  <td className="py-8 pr-12 text-xs font-semibold uppercase" style={{ color: "var(--ink-soft)" }}>{f.payment_status}</td>
                  <td className="py-8 text-right">
                    <Link href={`/portal/files/${f.id}`} className="text-xs underline" style={{ color: "var(--brand)" }}>Open</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={`${card} mt-24`} style={cardStyle}>
        <div className="mb-16 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Latest documents</h2>
          <Link href="/portal/documents" className="text-xs underline" style={{ color: "var(--brand)" }}>View all</Link>
        </div>
        {data.recentDocuments.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No documents shared yet.</p>
        ) : (
          <ul className="space-y-8">
            {data.recentDocuments.map(d => (
              <li key={d.id} className="flex items-center justify-between rounded-input border px-12 py-8 text-sm"
                style={{ borderColor: "var(--line)" }}>
                <span>
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>{d.file_name}</span>
                  <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {d.file_number} · {fmtBytes(d.size_bytes)} · {fmtDateTime(d.created_at)}
                  </span>
                </span>
                <span className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                  {d.kind.replace(/_/g, " ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
