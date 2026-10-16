"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../api-client";

interface Notification {
  key: string; type: string; severity: "critical" | "warning" | "info";
  title: string; detail: string; href: string; date: string; seen?: boolean;
}
interface Payload {
  items: Notification[];
  counts: { critical: number; warning: number; info: number; total: number; unread: number };
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: "var(--danger)", warning: "var(--warning)", info: "var(--brand)"
};
const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical", warning: "Warning", info: "Info"
};

/** The topbar badge listens for this and re-reads the unread count at once. */
function announceAlerts() {
  window.dispatchEvent(new CustomEvent("waisha:alerts"));
}

export default function NotificationsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch("/notifications");
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(j?.error?.message ?? "Could not load alerts."); return; }
    setData(j);
    setError(null);
  }, []);

  useEffect(() => { load(); }, [load]);

  const markRead = useCallback(async (keys: string[]) => {
    if (!keys.length) return;
    // Optimistic: the keys are stable, so the marker flips immediately and a
    // failed call is corrected by the next load.
    setData((d) => d && ({
      ...d,
      items: d.items.map((n) => keys.includes(n.key) ? { ...n, seen: true } : n),
      counts: { ...d.counts, unread: Math.max(0, d.counts.unread - keys.filter(
        (k) => d.items.some((n) => n.key === k && !n.seen)).length) }
    }));
    announceAlerts();
    setBusy(true);
    try {
      const res = await apiFetch("/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys })
      });
      if (!res.ok) await load();
    } catch {
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  const markAll = useCallback(async () => {
    setData((d) => d && ({
      ...d,
      items: d.items.map((n) => ({ ...n, seen: true })),
      counts: { ...d.counts, unread: 0 }
    }));
    announceAlerts();
    setBusy(true);
    try {
      const res = await apiFetch("/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true })
      });
      if (!res.ok) await load();
    } catch {
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  const unread = data?.counts.unread ?? 0;

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="flex flex-wrap items-center justify-between gap-12">
        <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Alerts</h1>
        {unread > 0 && (
          <button type="button" onClick={markAll} disabled={busy}
            className="badge-plain rounded-input px-12 py-4 text-xs font-semibold"
            style={{ color: "var(--ink)" }}>
            Mark all read
          </button>
        )}
      </div>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Computed live from your data — overdue invoices, expiring documents, low stock, open incidents and departures.
      </p>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      {data && (
        <div className="mt-16 flex flex-wrap gap-16 text-xs">
          {unread > 0 && (
            <span className="rounded-input px-12 py-4 font-semibold"
              style={{ background: "color-mix(in srgb, var(--brand) 12%, transparent)", color: "var(--ink)" }}>
              {unread} unread
            </span>
          )}
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
        {(data?.items ?? []).map((n) => (
          <div key={n.key}
            className="flex items-start gap-12 rounded-card border bg-surface px-16 py-12 transition-colors"
            style={{ borderColor: "var(--line)",
              borderLeft: `4px solid ${SEVERITY_COLORS[n.severity] ?? "var(--ink-soft)"}`,
              opacity: n.seen ? 0.62 : 1 }}>
            <Link href={n.href} className="min-w-0 flex-1">
              <p className="flex items-center gap-8 text-sm" style={{ color: "var(--ink)" }}>
                {!n.seen && (
                  <span aria-label="Unread" className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ background: "var(--brand)" }} />
                )}
                <span className={n.seen ? "font-normal" : "font-semibold"}>{n.title}</span>
              </p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{n.detail}</p>
            </Link>
            <div className="flex shrink-0 flex-col items-end gap-4 text-right">
              <span className="px-0 py-2 text-[10px] font-bold uppercase"
                style={{ color: SEVERITY_COLORS[n.severity] ?? "var(--ink-soft)" }}>
                {SEVERITY_LABELS[n.severity]}
              </span>
              <p className="text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                {new Date(n.date).toLocaleDateString()}
              </p>
              {!n.seen && (
                <button type="button" onClick={() => markRead([n.key])} disabled={busy}
                  className="text-[10px] font-semibold underline underline-offset-2"
                  style={{ color: "var(--ink-soft)" }}>
                  Mark read
                </button>
              )}
            </div>
          </div>
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
