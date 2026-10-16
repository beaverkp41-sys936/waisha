"use client";
import { useCallback, useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

interface TenantRow {
  tenant_id: string; name: string; tenant_type: string; status: string;
  trial_ends_at: string | null; licence_expires_at: string | null;
  subscription_status: string | null; plan_name: string | null;
  seats_licensed: number | null; created_at: string;
}
interface Plan { key: string; name: string; seat_limit: number;
  price_monthly: string; price_quarterly: string; price_annual: string; vat_rate: string; }
type Cycle = "monthly" | "quarterly" | "annual";

const CHANNELS: [string, string][] = [
  ["azampesa", "Azampesa"], ["mpesa", "M-Pesa"], ["tigopesa", "Mixx by Yas (Tigo Pesa)"],
  ["airtel", "Airtel Money"], ["halopesa", "Halopesa"], ["bank", "Bank / Lipa Namba (direct)"]
];
const CYCLES: Cycle[] = ["monthly", "quarterly", "annual"];
export default function TenantsPage() {
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [target, setTarget] = useState<TenantRow | null>(null);
  const [planKey, setPlanKey] = useState("starter");
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [provider, setProvider] = useState("mpesa");
  const [txnRef, setTxnRef] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (search: string) => {
    const res = await fetch(`${API}/api/v1/control/tenants${search ? `?q=${encodeURIComponent(search)}` : ""}`,
      { credentials: "include" });
    if (res.status === 401 || res.status === 403) { window.location.href = "/control/login"; return; }
    if (res.ok) setRows(await res.json());
  }, []);

  useEffect(() => {
    (async () => {
      const p = await fetch(`${API}/api/v1/control/plans-public`);
      if (p.ok) setPlans(await p.json());
    })();
    load("");
  }, [load]);

  function openDialog(t: TenantRow) {
    setTarget(t);
    setPlanKey("starter"); setCycle("monthly"); setProvider("mpesa"); setTxnRef("");
    const pl = plans.find(p => p.key === "starter");
    if (pl) setAmount(String(Math.round(Number(pl.price_monthly) * 1.18)));
    setError(null); setNotice(null);
  }

  const sel = plans.find(p => p.key === planKey);
  const listed = sel ? Number(sel[`price_${cycle}`]) : 0;
  const listedTotal = sel ? Math.round(listed * (1 + Number(sel.vat_rate))) : 0;

  async function confirm() {
    if (!target) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/api/v1/control/tenants/${target.tenant_id}/activate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          planKey, billingCycle: cycle, provider,
          providerTxnId: txnRef.trim() || undefined,
          amountOverride: amount ? Number(amount) : undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "Activation failed"); return; }
      setNotice(`${j.mode === "extend" ? "Extended" : "Activated"}: ${target.name} — invoice ${j.invoice_number}, valid until ${new Date(j.licence_expires_at).toLocaleDateString()}`);
      setTarget(null);
      load(q);
    } finally { setBusy(false); }
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Super Admin · Tenants and licences
          </p>
        </div>
        <div className="flex items-center gap-16 text-xs font-semibold">
          <a href="/control" className="underline" style={{ color: "var(--adm-accent)" }}>Plans</a>
          <span className="text-white">Tenants</span>
          <button type="button" className="rounded-input border px-16 py-8 text-white"
            style={{ borderColor: "rgba(255,255,255,0.4)" }}
            onClick={async () => {
              await fetch(`${API}/api/v1/control/auth/logout`, { method: "POST", credentials: "include" });
              window.location.href = "/control/login";
            }}>Sign out</button>
        </div>
      </header>

      <main className="mx-auto max-w-[900px] px-16 py-32">
        <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Tenants</h1>
        <p className="mt-8 mb-16 text-sm" style={{ color: "var(--ink-soft)" }}>
          Activate or extend licences when payment was verified out-of-band (wallet/bank transfer, gateway outage).
          Every activation is atomic and audited with your admin ID.
        </p>

        <input value={q} onChange={e => { setQ(e.target.value); load(e.target.value); }}
          placeholder="Search by company name"
          className={`${inputCls} mb-16`} style={inputStyle} />

        {notice && (
          <div className="mb-16 rounded-input px-12 py-8 text-sm" role="status"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="mb-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
            {error}
          </div>
        )}

        <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Company</th>
                <th className="p-12">Type</th>
                <th className="p-12">Status</th>
                <th className="p-12">Plan</th>
                <th className="p-12">Licence until</th>
                <th className="p-12"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => {
                const live = t.licence_expires_at && new Date(t.licence_expires_at) > new Date();
                return (
                  <tr key={t.tenant_id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{t.name}</td>
                    <td className="p-12" style={{ color: "var(--ink-soft)" }}>{t.tenant_type}</td>
                    <td className="p-12">
                      <span className="px-8 py-4 text-[10px] font-bold uppercase"
                        style={{ borderLeft: `4px solid ${t.status === "active" ? "var(--success)" : t.status === "trial" ? "var(--warning)" : "var(--ink-soft)"}`, color: "var(--ink)" }}>
                        {t.status}
                      </span>
                    </td>
                    <td className="p-12" style={{ color: "var(--ink-soft)" }}>{t.plan_name ?? "—"}</td>
                    <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                      {t.licence_expires_at ? new Date(t.licence_expires_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="p-12 text-right">
                      <button type="button" onClick={() => openDialog(t)}
                        className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                        {live ? "Extend" : "Activate"}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td className="p-16 text-sm" style={{ color: "var(--ink-soft)" }} colSpan={6}>No tenants found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>

      {target && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-16"
          style={{ background: "rgba(2, 4, 8, 0.7)" }}>
          <div className="w-full max-w-[420px] rounded-modal bg-surface p-24" style={{ border: "1px solid var(--line)" }}>
            <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              {target.licence_expires_at && new Date(target.licence_expires_at) > new Date() ? "Extend licence" : "Activate licence"}
            </h2>
            <p className="mt-4 mb-16 text-sm" style={{ color: "var(--ink-soft)" }}>{target.name}</p>

            <div className="space-y-12">
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Plan</span>
                <select value={planKey} onChange={e => {
                  setPlanKey(e.target.value);
                  const pl = plans.find(p => p.key === e.target.value);
                  if (pl) setAmount(String(Math.round(Number(pl[`price_${cycle}`]) * (1 + Number(pl.vat_rate)))));
                }} className={inputCls} style={inputStyle}>
                  {plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                </select>
              </label>
              <div>
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Period</span>
                <div className="grid grid-cols-3 gap-8">
                  {CYCLES.map(c => (
                    <button key={c} type="button"
                      onClick={() => {
                        setCycle(c);
                        const pl = plans.find(p => p.key === planKey);
                        if (pl) setAmount(String(Math.round(Number(pl[`price_${c}`]) * (1 + Number(pl.vat_rate)))));
                      }}
                      className={`rounded-input border py-8 text-xs font-semibold capitalize ${cycle === c ? "" : "opacity-60"}`}
                      style={cycle === c
                        ? { borderColor: "var(--adm-accent)", background: "var(--adm-accent-soft)", color: "var(--adm-accent)" }
                        : { borderColor: "var(--line)", color: "var(--ink)" }}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Payment channel (how they actually paid)</span>
                <select value={provider} onChange={e => setProvider(e.target.value)} className={inputCls} style={inputStyle}>
                  {CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Transaction reference (from their SMS/receipt — optional)</span>
                <input value={txnRef} onChange={e => setTxnRef(e.target.value)} className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                  Total TZS {listedTotal ? `(list price ${listedTotal.toLocaleString()})` : ""} — editable for agreed discounts
                </span>
                <input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)}
                  className={inputCls} style={inputStyle} />
              </label>
            </div>

            {error && <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>{error}</p>}

            <div className="mt-16 flex gap-8">
              <button type="button" disabled={busy} onClick={confirm}
                className="waisha-btn flex-1 rounded-input py-12 text-sm font-semibold disabled:opacity-60">
                {busy ? "Working" : "Confirm and activate"}
              </button>
              <button type="button" onClick={() => setTarget(null)}
                className="rounded-input border px-16 py-12 text-sm font-semibold" style={{ borderColor: "var(--line)" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}