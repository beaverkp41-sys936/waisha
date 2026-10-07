"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../../api-client";

interface Analytics {
  byType: { shipment_type: string; count: number }[];
  months: { month: string; shipments: number; revenue: number }[];
  byStage: { stage: string; count: number }[];
  processingBuckets: { label: string; count: number }[];
  pnl: { revenue: number; received: number; paid: number; net: number };
}

const TYPE_LABELS: Record<string, string> = {
  export: "Export", import: "Import", transhipment: "Transhipment", transit: "Transit"
};
const STAGE_LABELS: Record<string, string> = {
  pre_arrival: "Pre-arrival", arrival: "Arrival", customs: "Customs",
  inspection: "Inspection", release: "Release", exit: "Exit"
};
const PIE_COLORS = ["var(--brand)", "var(--gold)", "var(--gold-green)", "var(--danger)"];
const fmt = (n: number) => n.toLocaleString();
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: "short" });
};

const C = 2 * Math.PI * 40; // pie circumference for r=40

export default function CargoAnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch("/cargo/analytics");
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(j?.error?.message ?? "Could not load analytics."); return; }
    setData(j);
  }, []);

  useEffect(() => { load(); }, [load]);

  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };
  const heading = "text-sm font-bold uppercase tracking-[0.14em]";

  const typeTotal = (data?.byType ?? []).reduce((a, b) => a + b.count, 0);
  const stageMax = Math.max(...(data?.byStage ?? []).map(s => s.count), 1);
  const bucketMax = Math.max(...(data?.processingBuckets ?? []).map(b => b.count), 1);
  const revMax = Math.max(...(data?.months ?? []).map(m => m.revenue), 1);
  const shipMax = Math.max(...(data?.months ?? []).map(m => m.shipments), 1);

  // SVG line geometry
  const W = 620, H = 160, PAD = 24;
  const linePts = (data?.months ?? []).map((m, i, arr) => {
    const x = PAD + (i / Math.max(arr.length - 1, 1)) * (W - 2 * PAD);
    const y = H - PAD - (m.shipments / shipMax) * (H - 2 * PAD);
    return `${x},${y}`;
  }).join(" ");

  let pieOffset = 0;

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Cargo analytics</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            File mix, throughput, processing times and money — from live data.
          </p>
        </div>
        <Link href="/app/cfa/cargo" className="rounded-input border px-16 py-8 text-xs font-semibold"
          style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Back to files</Link>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      {/* P&L */}
      {data && (
        <section className="mt-24 grid grid-cols-2 gap-16 lg:grid-cols-4">
          <div className={card} style={cardStyle}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Revenue issued</p>
            <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>{fmt(data.pnl.revenue)}</p>
          </div>
          <div className={card} style={cardStyle}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Cash received</p>
            <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--success)" }}>{fmt(data.pnl.received)}</p>
          </div>
          <div className={card} style={cardStyle}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Cash paid out</p>
            <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--danger)" }}>{fmt(data.pnl.paid)}</p>
          </div>
          <div className={card} style={cardStyle}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Net position</p>
            <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: data.pnl.net >= 0 ? "var(--success)" : "var(--danger)" }}>{fmt(data.pnl.net)}</p>
          </div>
        </section>
      )}

      <div className="mt-24 grid grid-cols-1 gap-16 md:grid-cols-2">
        {/* Pie: shipment type mix */}
        <section className={card} style={cardStyle}>
          <h2 className={heading} style={{ color: "var(--ink-soft)" }}>Files by shipment type</h2>
          {typeTotal > 0 ? (
            <div className="mt-16 flex items-center gap-24">
              <svg viewBox="0 0 120 120" className="h-32 w-32">
                {(data?.byType ?? []).map((s, i) => {
                  const frac = s.count / typeTotal;
                  const el = (
                    <circle key={s.shipment_type} r="40" cx="60" cy="60" fill="transparent"
                      stroke={PIE_COLORS[i % PIE_COLORS.length]} strokeWidth="22"
                      strokeDasharray={`${frac * C} ${C}`} strokeDashoffset={-pieOffset * C} />
                  );
                  pieOffset += frac;
                  return el;
                })}
              </svg>
              <div className="space-y-8 text-xs">
                {(data?.byType ?? []).map((s, i) => (
                  <div key={s.shipment_type} className="flex items-center gap-8">
                    <span className="inline-block h-8 w-8 rounded-sm" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span style={{ color: "var(--ink)" }}>{TYPE_LABELS[s.shipment_type] ?? s.shipment_type}</span>
                    <span className="tabular-nums" style={{ color: "var(--ink-soft)" }}>{s.count} ({Math.round((s.count / typeTotal) * 100)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="mt-16 text-sm" style={{ color: "var(--ink-soft)" }}>No files yet.</p>
          )}
        </section>

        {/* Work progress: stage pipeline */}
        <section className={card} style={cardStyle}>
          <h2 className={heading} style={{ color: "var(--ink-soft)" }}>Work progress — open files by stage</h2>
          <div className="mt-16 space-y-8">
            {(data?.byStage ?? []).map(s => (
              <div key={s.stage}>
                <div className="mb-4 flex justify-between text-xs" style={{ color: "var(--ink-soft)" }}>
                  <span>{STAGE_LABELS[s.stage] ?? s.stage}</span>
                  <span className="tabular-nums">{s.count}</span>
                </div>
                <div className="h-8 w-full rounded-full" style={{ background: "var(--milk-deep)" }}>
                  <div className="h-8 rounded-full" style={{ width: `${(s.count / stageMax) * 100}%`, background: "var(--brand)" }} />
                </div>
              </div>
            ))}
            {(data?.byStage ?? []).length === 0 && (
              <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No open files.</p>
            )}
          </div>
        </section>
      </div>

      <div className="mt-16 grid grid-cols-1 gap-16 md:grid-cols-2">
        {/* Histogram: processing time */}
        <section className={card} style={cardStyle}>
          <h2 className={heading} style={{ color: "var(--ink-soft)" }}>Processing time (completed files)</h2>
          <div className="mt-16 space-y-8">
            {(data?.processingBuckets ?? []).map(b => (
              <div key={b.label}>
                <div className="mb-4 flex justify-between text-xs" style={{ color: "var(--ink-soft)" }}>
                  <span>{b.label}</span>
                  <span className="tabular-nums">{b.count}</span>
                </div>
                <div className="h-8 w-full rounded-full" style={{ background: "var(--milk-deep)" }}>
                  <div className="h-8 rounded-full" style={{ width: `${(b.count / bucketMax) * 100}%`, background: "var(--gold)" }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
            Days from file opening to completion, files completed in the last 12 months.
          </p>
        </section>

        {/* Line: monthly shipments + bar: monthly revenue */}
        <section className={card} style={cardStyle}>
          <h2 className={heading} style={{ color: "var(--ink-soft)" }}>Monthly shipments (line) and revenue (bars)</h2>
          <svg viewBox={`0 0 ${W} ${H}`} className="mt-16 w-full">
            <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--line)" />
            {(data?.months ?? []).map((m, i, arr) => {
              const x = PAD + (i / Math.max(arr.length - 1, 1)) * (W - 2 * PAD);
              const bw = ((W - 2 * PAD) / arr.length) * 0.5;
              const bh = (m.revenue / revMax) * (H - 2 * PAD);
              return (
                <g key={m.month}>
                  <rect x={x - bw / 2} y={H - PAD - bh} width={bw} height={bh}
                    fill="color-mix(in srgb, var(--gold) 35%, transparent)" />
                  {m.shipments > 0 && <circle cx={x} cy={H - PAD - (m.shipments / shipMax) * (H - 2 * PAD)} r="3" fill="var(--brand)" />}
                  {i % 2 === 0 && (
                    <text x={x} y={H - 6} textAnchor="middle" fontSize="9" fill="var(--ink-soft)">
                      {monthLabel(m.month)}
                    </text>
                  )}
                </g>
              );
            })}
            <polyline points={linePts} fill="none" stroke="var(--brand)" strokeWidth="2" />
          </svg>
          <div className="flex gap-16 text-[10px]" style={{ color: "var(--ink-soft)" }}>
            <span className="flex items-center gap-4">
              <span className="inline-block h-8 w-8 rounded-sm" style={{ background: "var(--brand)" }} /> Shipments
            </span>
            <span className="flex items-center gap-4">
              <span className="inline-block h-8 w-8 rounded-sm" style={{ background: "color-mix(in srgb, var(--gold) 35%, transparent)" }} /> Invoiced revenue
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
