"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../api-client";

interface Notification {
  type: string; severity: "critical" | "warning" | "info";
  title: string; detail: string; href: string; date: string;
}
interface Payload {
  items: Notification[];
  counts: { critical: number; warning: number; info: number; total: number };
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "var(--danger)", warning: "var(--warning)", info: "var(--brand)"
};
const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical", warning: "Warning", info: "Info"
};

export default function NotificationsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch("/notifications");
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(j?.error?.message ?? "Could not load alerts."); return; }
    setData(j);
  }, []);

  useEffect(() => { load(); }, [load]);

  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Alerts</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Computed live from your data — overdue invoices, expiring documents, low stock, open incidents and departures.
      </p>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      {data && (
        <div className="mt-16 flex gap-16 text-xs">
          <span className="badge-plain rounded-input px-12 py-4 font-semibold">
            {data.counts.critical} critical
          </span>
          <span className="badge-plain rounded-input px-12 py-4 font-semibold">
            {data.counts.warning} warnings
          </span>
          <span className="badge-plain rounded-input px-12 py-4 font-semibold">
            {data.counts.info} info
          </span>
        </div>
      )}

      <div className="mt-24 space-y-8">
        {(data?.items ?? []).map((n, i) => (
          <Link key={`${n.type}-${i}-${n.title}`} href={n.href}
            className="block rounded-card border bg-surface px-16 py-12 transition-colors"
            style={{ ...cardStyle, borderLeft: `4px solid ${SEVERITY_COLORS[n.severity] ?? "var(--ink-soft)"}` }}>
            <div className="flex items-start justify-between gap-12">
              <div className="min-w-0">
                <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{n.title}</p>
                <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{n.detail}</p>
              </div>
              <div className="shrink-0 text-right">
                <span className="px-8 py-2 text-[10px] font-bold uppercase"
                  style={{ color: SEVERITY_COLORS[n.severity] ?? "var(--ink-soft)" }}>
                  {SEVERITY_LABELS[n.severity]}
                </span>
                <p className="text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {new Date(n.date).toLocaleDateString()}
                </p>
              </div>
            </div>
          </Link>
        ))}
        {data && data.items.length === 0 && (
          <p className="pane-note text-sm">
            Nothing needs attention right now.
          </p>
        )}
        {!data && !error && (
          <p className="pane-note text-sm">Loading alerts…</p>
        )}
      </div>
    </div>
  );
}
