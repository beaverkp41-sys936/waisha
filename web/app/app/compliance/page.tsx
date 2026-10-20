"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../api-client";

interface ComplianceItem {
  entity_type: string;
  entity_name: string;
  document: string;
  expiry: string;
  days: number;
  status: "expired" | "expiring" | "ok";
}

interface Vessel {
  id: string; name: string;
  insurance_expiry: string | null; inspection_expiry: string | null; road_licence_expiry: string | null;
}
interface Driver { id: string; full_name: string; licence_expiry: string | null; }
interface Profile { transport_licence_expiry?: string | null; company_name?: string; }

const STATUS_COLORS: Record<string, string> = {
  expired: "var(--danger)", expiring: "var(--warning)", ok: "var(--success)"
};

export default function CompliancePage() {
  const [items, setItems] = useState<ComplianceItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      const today = Date.now();
      const list: ComplianceItem[] = [];
      const push = (entityType: string, name: string, doc: string, expiry: string | null) => {
        if (!expiry) return;
        const days = Math.floor((new Date(expiry).getTime() - today) / 86_400_000);
        list.push({
          entity_type: entityType, entity_name: name, document: doc, expiry,
          days,
          status: days < 0 ? "expired" : days <= 30 ? "expiring" : "ok"
        });
      };

      const v = await apiFetch("/vessels");
      if (v.ok) {
        const j = await v.json();
        for (const vessel of (j.vessels ?? j) as Vessel[]) {
          push("Vessel", vessel.name, "Insurance", vessel.insurance_expiry);
          push("Vessel", vessel.name, "Inspection", vessel.inspection_expiry);
          push("Vessel", vessel.name, "Road licence", vessel.road_licence_expiry);
        }
      }
      const d = await apiFetch("/drivers");
      if (d.ok) {
        for (const driver of (await d.json()) as Driver[]) {
          push("Driver", driver.full_name, "Driving licence", driver.licence_expiry);
        }
      }
      const p = await apiFetch("/profile");
      if (p.ok) {
        const profile: Profile = await p.json();
        push("Company", profile.company_name ?? "Your company", "Transport licence", profile.transport_licence_expiry ?? null);
      }

      list.sort((a, b) => a.days - b.days);
      setItems(list);
    } catch (e: any) {
      if (e.message !== "session ended") setError(e.message);
    } finally { setReady(true); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const expired = items.filter(i => i.status === "expired").length;
  const expiring = items.filter(i => i.status === "expiring").length;
  const valid = items.filter(i => i.status === "ok").length;

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Compliance</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Every licence, insurance and inspection across the company — expired and soonest first.
      </p>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      {ready && (
        <section className="mt-24 grid grid-cols-2 md:grid-cols-3 gap-16">
          <div className={card} style={cardStyle}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Expired</p>
            <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: expired > 0 ? "var(--danger)" : "var(--ink)" }}>{expired}</p>
          </div>
          <div className={card} style={cardStyle}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Expiring in 30 days</p>
            <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: expiring > 0 ? "var(--warning)" : "var(--ink)" }}>{expiring}</p>
          </div>
          <div className={card} style={cardStyle}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Valid</p>
            <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--success)" }}>{valid}</p>
          </div>
        </section>
      )}

      <div className="mt-24 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Entity</th><th className="p-12">Document</th>
              <th className="p-12 text-right">Expiry</th><th className="p-12 text-right">Days</th>
              <th className="p-12">Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={`${it.entity_name}-${it.document}`} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12" style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{it.entity_name}</span>
                  <span className="ml-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>{it.entity_type}</span>
                </td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{it.document}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {new Date(it.expiry).toLocaleDateString()}
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {it.days < 0 ? `${-it.days} ago` : it.days}
                </td>
                <td className="p-12">
                  <span className="px-8 py-4 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${STATUS_COLORS[it.status]}`, color: "var(--ink)" }}>
                    {it.status}
                  </span>
                </td>
              </tr>
            ))}
            {ready && items.length === 0 && (
              <tr><td colSpan={5} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No tracked documents yet — expiry dates appear here once entered on vessels, drivers or the company profile.
              </td></tr>
            )}
            {!ready && (
              <tr><td colSpan={5} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="pane-note mt-16 text-xs">
        Update expiry dates on the Fleet, Drivers and Profile pages. Alerts fire automatically from here 30 days out.
      </p>
    </div>
  );
}
