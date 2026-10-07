"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api-client";

function errorText(json: any, fallback: string): string {
  return json?.error?.message ?? fallback;
}

interface Summary {
  from: string; to: string;
  revenue: { issued: number; received: number; count: number };
  expenses: { recorded: number; paid: number; count: number };
  net: number;
  trips: { planned: number; in_transit: number; completed: number; cancelled: number; total: number };
  fuel: { litres: number; cost: number; entries: number };
  incidents: { open: number; resolved: number };
  topCustomers: { customer_name: string; invoiced: number; invoices: number }[];
}

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function iso(d: Date) { return d.toISOString().slice(0, 10); }

type Preset = "today" | "week" | "month" | "year" | "all" | "custom";

function rangeFor(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const to = iso(now);
  switch (preset) {
    case "today": return { from: to, to };
    case "week": return { from: iso(new Date(now.getTime() - 6 * 86_400_000)), to };
    case "month": return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to };
    case "year": return { from: `${now.getFullYear()}-01-01`, to };
    case "all": return { from: "2000-01-01", to };
    default: return { from: iso(new Date(now.getTime() - 30 * 86_400_000)), to };
  }
}

export default function ReportsPage() {
  const [preset, setPreset] = useState<Preset>("month");
  const [from, setFrom] = useState(rangeFor("month").from);
  const [to, setTo] = useState(rangeFor("month").to);
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (f: string, t: string) => {
    setError(null); setBusy(true);
    try {
      const res = await apiFetch(`/reports/summary?from=${f}&to=${t}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not load the report.")); return; }
      setData(j);
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { const r = rangeFor("month"); load(r.from, r.to); }, [load]);

  function applyPreset(p: Preset) {
    setPreset(p);
    if (p === "custom") return;
    const r = rangeFor(p);
    setFrom(r.from); setTo(r.to);
    load(r.from, r.to);
  }

  function downloadCsv() {
    if (!data) return;
    const rows: string[][] = [
      ["Report", `${data.from} to ${data.to}`],
      [],
      ["Revenue issued", fmt(data.revenue.issued)],
      ["Revenue received", fmt(data.revenue.received)],
      ["Invoices", String(data.revenue.count)],
      ["Expenses recorded", fmt(data.expenses.recorded)],
      ["Expenses paid", fmt(data.expenses.paid)],
      ["Net position (cash)", fmt(data.net)],
      [],
      ["Trips planned", String(data.trips.planned)],
      ["Trips in transit", String(data.trips.in_transit)],
      ["Trips completed", String(data.trips.completed)],
      ["Trips cancelled", String(data.trips.cancelled)],
      [],
      ["Fuel litres", fmt(data.fuel.litres)],
      ["Fuel cost", fmt(data.fuel.cost)],
      ["Incidents open", String(data.incidents.open)],
      ["Incidents resolved", String(data.incidents.resolved)],
      [],
      ["Top customer", "Invoiced", "Invoices"],
      ...data.topCustomers.map(c => [c.customer_name, fmt(c.invoiced), String(c.invoices)])
    ];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `waisha-report-${data.from}-to-${data.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  const chips: { key: Preset; label: string }[] = [
    { key: "today", label: "Today" }, { key: "week", label: "7 days" },
    { key: "month", label: "This month" }, { key: "year", label: "This year" },
    { key: "all", label: "All time" }, { key: "custom", label: "Custom" }
  ];

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="flex items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Reports</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Revenue, operations and costs for any period.
          </p>
        </div>
        <div className="flex gap-8">
          <button type="button" onClick={downloadCsv} disabled={!data}
            className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-50"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Export CSV</button>
          <button type="button" onClick={() => window.print()} disabled={!data}
            className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
            Print / PDF
          </button>
        </div>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      <section className="no-print mt-24 rounded-card border bg-surface p-24" style={cardStyle}>
        <div className="flex flex-wrap gap-8">
          {chips.map(c => (
            <button key={c.key} type="button" onClick={() => applyPreset(c.key)}
              className="rounded-input border px-16 py-8 text-xs font-semibold transition-colors"
              style={{
                borderColor: preset === c.key ? "var(--brand)" : "var(--line)",
                background: preset === c.key ? "color-mix(in srgb, var(--brand) 10%, transparent)" : "transparent",
                color: "var(--ink)"
              }}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="mt-16 grid grid-cols-2 gap-12">
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>From</span>
            <input type="date" value={from} onChange={e => { setFrom(e.target.value); setPreset("custom"); }}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>To</span>
            <input type="date" value={to} onChange={e => { setTo(e.target.value); setPreset("custom"); }}
              className={inputCls} style={inputStyle} />
          </label>
        </div>
        {preset === "custom" && (
          <button type="button" onClick={() => load(from, to)} disabled={busy}
            className="waisha-btn mt-16 rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-60">
            {busy ? "Loading…" : "Apply range"}
          </button>
        )}
      </section>

      {data && (
        <>
          <section className="no-print mt-24 grid grid-cols-2 gap-16 lg:grid-cols-4">
            <div className={card} style={cardStyle}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Revenue issued</p>
              <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>{fmt(data.revenue.issued)}</p>
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{data.revenue.count} invoice{data.revenue.count === 1 ? "" : "s"}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Cash received</p>
              <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--success)" }}>{fmt(data.revenue.received)}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Expenses paid</p>
              <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--danger)" }}>{fmt(data.expenses.paid)}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Net (cash)</p>
              <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: data.net >= 0 ? "var(--success)" : "var(--danger)" }}>{fmt(data.net)}</p>
            </div>
          </section>

          {/* Printable report body */}
          <section className="mt-24 rounded-card border bg-surface p-24" style={cardStyle}>
            <div className="flex items-start justify-between border-b pb-16" style={{ borderColor: "var(--line)" }}>
              <div>
                <p className="text-base font-bold" style={{ color: "var(--ink)" }}>WAISHA report</p>
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>Period: {data.from} to {data.to}</p>
              </div>
              <p className="text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
                Generated {new Date().toLocaleDateString()}
              </p>
            </div>

            <div className="mt-16 grid grid-cols-2 gap-24 text-sm">
              <div>
                <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Operations</p>
                <p style={{ color: "var(--ink)" }}>Trips: {data.trips.total} ({data.trips.completed} completed, {data.trips.in_transit} in transit, {data.trips.planned} planned)</p>
                <p className="mt-4" style={{ color: "var(--ink)" }}>Fuel: {data.fuel.litres.toLocaleString()} litres ({data.fuel.entries} fill-ups)</p>
                <p className="mt-4" style={{ color: "var(--ink)" }}>Incidents: {data.incidents.open} open, {data.incidents.resolved} resolved</p>
              </div>
              <div>
                <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Finance</p>
                <p style={{ color: "var(--ink)" }}>Revenue issued: {fmt(data.revenue.issued)}</p>
                <p className="mt-4" style={{ color: "var(--ink)" }}>Cash received: {fmt(data.revenue.received)}</p>
                <p className="mt-4" style={{ color: "var(--ink)" }}>Expenses recorded: {fmt(data.expenses.recorded)}</p>
                <p className="mt-4" style={{ color: "var(--ink)" }}>Expenses paid: {fmt(data.expenses.paid)}</p>
              </div>
            </div>

            {data.topCustomers.length > 0 && (
              <div className="mt-24">
                <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Top customers by invoiced value</p>
                <table className="mt-8 w-full text-sm">
                  <tbody>
                    {data.topCustomers.map(c => (
                      <tr key={c.customer_name} className="border-b" style={{ borderColor: "var(--line)" }}>
                        <td className="py-8" style={{ color: "var(--ink)" }}>{c.customer_name}</td>
                        <td className="py-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(c.invoiced)}</td>
                        <td className="py-8 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{c.invoices} invoice{c.invoices === 1 ? "" : "s"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
