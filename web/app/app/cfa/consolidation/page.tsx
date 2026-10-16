"use client";
import { Boxes, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../api-client";
import { EmptyState } from "@/components/EmptyState";
import UnitsPanel from "./units";
import {
  MODE_SHORT, NEXT_STATUSES, STATUS_COLORS, STATUS_LABELS,
  errorText, fmt, num, qty, unitText
} from "./shared";
import type { Kpis, Manifest, ManifestStatus, Mode } from "./shared";

const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
const card = "rounded-card border bg-surface p-24";

export default function ConsolidationPage() {
  const [tab, setTab] = useState<"legs" | "units">("legs");
  const [rows, setRows] = useState<Manifest[]>([]);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [regions, setRegions] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<Mode | "">("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Searched as the clerk types — one request per pause, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    (async () => {
      const res = await apiFetch("/geo/regions");
      if (!res.ok) return;
      const list = await res.json();
      setRegions(Object.fromEntries((list as any[]).map(r => [String(r.id), r.name_en])));
    })();
  }, []);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (query) qs.set("q", query);
    const res = await apiFetch(`/consolidation${qs.toString() ? `?${qs}` : ""}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Could not load the consolidation desk.")); return; }
    setError(null);
    setRows(j.manifests ?? []);
    setKpis(j.kpis ?? null);
  }, [status, query]);

  useEffect(() => { load(); }, [load]);

  const shown = useMemo(
    () => mode ? rows.filter(r => r.carrier_mode === mode) : rows,
    [rows, mode]
  );

  async function advance(m: Manifest, next: ManifestStatus) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/consolidation/${m.id}/status`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not move that leg.")); return; }
      setNotice(`${m.manifest_number} is now ${STATUS_LABELS[next].toLowerCase()}.`);
    } finally { setBusy(false); load(); }
  }

  async function remove(m: Manifest) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/consolidation/${m.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not delete that leg.")); return; }
      setNotice(`${m.manifest_number} removed from the desk.`);
    } finally { setBusy(false); load(); }
  }

  const lane = (m: Manifest) => {
    const end = (regionId: number | null, text: string | null) => {
      const region = regionId === null ? "" : regions[String(regionId)] ?? "";
      return [region, text].filter(Boolean).join(" · ") || "—";
    };
    return { from: end(m.origin_region_id, m.origin_text), to: end(m.dest_region_id, m.dest_text) };
  };

  const kpi = (label: string, value: string, color: string) => (
    <div className={card} style={inputStyle}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</p>
      <p className="mt-8 text-lg font-bold tabular-nums" style={{ color }}>{value}</p>
    </div>
  );

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Consolidation</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Every leg the office consolidates — truck, trailer, vessel, rail wagon or air unit — with its part-load
            parcels itemised, weighed and settled line by line.
          </p>
        </div>
        <div className="flex flex-wrap gap-12">
          <TabButton active={tab === "legs"} onClick={() => setTab("legs")}>Legs</TabButton>
          <TabButton active={tab === "units"} onClick={() => setTab("units")}>Carrier units</TabButton>
          <Link href="/app/cfa/consolidation/new"
            className="waisha-btn inline-flex items-center gap-6 rounded-input px-16 py-8 text-xs font-semibold">
            <Plus size={14} strokeWidth={2} aria-hidden /> New leg
          </Link>
        </div>
      </div>

      {error && <div role="alert" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {tab === "legs" ? (
        <>
          {kpis && (
            <section className="mt-24 grid grid-cols-2 gap-16 lg:grid-cols-4">
              {kpi("Legs on the desk", String(kpis.manifests), "var(--ink)")}
              {kpi("In transit", String(kpis.in_transit), "var(--gold)")}
              {kpi("Freight billed", fmt(kpis.billed), "var(--ink)")}
              {kpi("Outstanding", fmt(kpis.outstanding), "var(--danger)")}
            </section>
          )}

          <div className="no-print mt-24 grid gap-12 md:grid-cols-[1fr_180px_180px]">
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search manifest number, B/L, container or unit" className={inputCls} style={inputStyle} />
            <select value={mode} onChange={e => setMode(e.target.value as Mode | "")}
              className={inputCls} style={inputStyle} aria-label="Mode of carry">
              <option value="">Any mode</option>
              {(Object.keys(MODE_SHORT) as Mode[]).map(m => <option key={m} value={m}>{MODE_SHORT[m]}</option>)}
            </select>
            <select value={status} onChange={e => setStatus(e.target.value)}
              className={inputCls} style={inputStyle} aria-label="Leg status">
              <option value="">Any status</option>
              {(Object.keys(STATUS_LABELS) as ManifestStatus[]).map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>

          <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={inputStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className="p-12">Manifest</th><th className="p-12">From → To</th>
                  <th className="p-12">Unit</th><th className="p-12 text-right">On board</th>
                  <th className="p-12 text-right">Freight</th><th className="p-12 text-right">Balance</th>
                  <th className="p-12">Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((m, i) => {
                  const l = lane(m);
                  return (
                    <tr key={m.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                      <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                        <Link href={`/app/cfa/consolidation/${m.id}`} className="underline">{m.manifest_number}</Link>
                        <span className="block text-[11px] font-normal" style={{ color: "var(--ink-soft)" }}>
                          {m.parcel_count} parcel(s){m.container_no ? ` · ${m.container_no}` : ""}
                          {m.departure_date ? ` · dep ${m.departure_date}` : ""}
                        </span>
                      </td>
                      <td className="p-12 text-xs" style={{ color: "var(--ink)" }}>
                        <span className="block">{l.from}</span>
                        <span className="block" style={{ color: "var(--ink-soft)" }}>→ {l.to}</span>
                      </td>
                      <td className="p-12 text-xs" style={{ color: "var(--ink)" }}>
                        {m.carrier_name}
                        <span className="block" style={{ color: "var(--ink-soft)" }}>
                          {unitText({ mode: m.carrier_mode, unit_type: m.unit_type })}
                        </span>
                      </td>
                      <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                        {qty(num(m.weight_on_board_kg))} kg
                        <span className="block" style={{ color: "var(--ink-soft)" }}>{qty(num(m.cbm_total))} m³</span>
                      </td>
                      <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                        {m.currency} {fmt(num(m.transport_fee_total))}
                      </td>
                      <td className="p-12 text-right font-semibold tabular-nums"
                        style={{ color: m.balance_due > 0 ? "var(--danger)" : "var(--success)" }}>
                        {fmt(m.balance_due)}
                      </td>
                      <td className="p-12">
                        <span className="px-8 py-4 text-[10px] font-bold uppercase"
                          style={{ borderLeft: `4px solid ${STATUS_COLORS[m.status]}`, color: "var(--ink)" }}>
                          {STATUS_LABELS[m.status]}
                        </span>
                      </td>
                      <td className="p-12 whitespace-nowrap text-right">
                        <Link href={`/app/cfa/consolidation/${m.id}`}
                          className="mr-12 inline-flex items-center gap-6 underline" style={{ color: "var(--brand)" }}>
                          <Boxes size={13} strokeWidth={1.8} aria-hidden /> Open
                        </Link>
                        {NEXT_STATUSES[m.status].filter(s => s !== "cancelled").map(s => (
                          <button key={s} type="button" className="mr-12 underline"
                            style={{ color: "var(--ink)" }} disabled={busy} onClick={() => advance(m, s)}>
                            {s === "manifested" ? "Manifest" : s === "in_transit" ? "Dispatch" : s === "delivered" ? "Deliver" : "Reopen"}
                          </button>
                        ))}
                        {(m.status === "draft" || m.status === "cancelled") && (
                          <button type="button" className="underline" style={{ color: "var(--danger)" }}
                            disabled={busy} onClick={() => remove(m)}>Delete</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!shown.length && (
                  <EmptyState colSpan={8} icon={Boxes}
                    title={query || status || mode ? "Nothing matches these filters" : "No legs consolidated yet"}
                    hint={query || status || mode
                      ? "Widen the filters, or open a new leg to start building the board."
                      : "Register a carrier unit, then open a leg on it to consolidate a part load."}
                    action={{ label: "New leg", href: "/app/cfa/consolidation/new" }} />
                )}
              </tbody>
            </table>
          </div>

          <p className="pane-note mt-24 text-xs">
            Weight on board, volume, freight and what has been collected are all footed from the parcels on the leg —
            nothing here is typed twice. A delivered or cancelled leg keeps its lines as they were signed for.
          </p>
        </>
      ) : (
        <UnitsPanel onError={setError} onNotice={setNotice} />
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`on-photo-btn px-16 py-8 text-xs font-semibold${active ? " is-on" : ""}`}>
      {children}
    </button>
  );
}
