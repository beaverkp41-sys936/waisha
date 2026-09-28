"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

interface Plan {
  id: string; key: string; name: string; seat_limit: number;
  price_monthly: string; price_quarterly: string; price_annual: string;
  vat_rate: string; is_active: boolean;
}
type Draft = Partial<Record<"name" | "seat_limit" | "price_monthly" | "price_quarterly" | "price_annual" | "is_active", any>>;

function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch(`${API}/api/v1/control/auth/change-password`, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ currentPassword: fd.get("cur"), newPassword: fd.get("new") })
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) { setMsg("Password changed. Other sessions revoked."); setOpen(false); }
    else setErr(j?.error?.message ?? "Failed");
  }

  if (!open) return (
    <button type="button" className="text-xs underline" style={{ color: "var(--gold)" }}
      onClick={() => setOpen(true)}>Change password</button>
  );

  return (
    <form onSubmit={submit} className="mb-24 space-y-12 rounded-card border p-16" style={{ borderColor: "var(--gold)" }}>
      <input name="cur" type="password" required placeholder="Current password"
        className="w-full rounded-input border px-12 py-8 text-sm"
        style={{ borderColor: "var(--line)", background: "var(--milk)" }} />
      <input name="new" type="password" required minLength={10}
        placeholder="New password (10+ chars, upper, lower, digit, symbol)"
        className="w-full rounded-input border px-12 py-8 text-sm"
        style={{ borderColor: "var(--line)", background: "var(--milk)" }} />
      {err && <p className="text-xs" style={{ color: "var(--danger)" }}>{err}</p>}
      {msg && <p className="text-xs" style={{ color: "var(--success)" }}>{msg}</p>}
      <div className="flex gap-8">
        <button type="submit" className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">Change</button>
        <button type="button" onClick={() => setOpen(false)}
          className="rounded-input border px-16 py-8 text-xs font-semibold"
          style={{ borderColor: "var(--line)" }}>Cancel</button>
      </div>
    </form>
  );
}

export default function ControlPage() {
  const [me, setMe] = useState<any>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const p = await fetch(`${API}/api/v1/control/plans`, { credentials: "include" });
      if (p.ok) setPlans(await p.json());
    })();
  }, []);

  function edit(key: string, field: string, value: any) {
    setDrafts(d => ({ ...d, [key]: { ...d[key], [field]: value } }));
  }

  async function save(plan: Plan) {
    setBusyKey(plan.key); setError(null);
    const d = drafts[plan.key] ?? {};
    try {
      const res = await fetch(`${API}/api/v1/control/plans/${plan.key}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          name: d.name ?? plan.name,
          seatLimit: Number(d.seat_limit ?? plan.seat_limit),
          priceMonthly: Number(d.price_monthly ?? plan.price_monthly),
          priceQuarterly: Number(d.price_quarterly ?? plan.price_quarterly),
          priceAnnual: Number(d.price_annual ?? plan.price_annual),
          isActive: d.is_active ?? plan.is_active
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "Save failed"); return; }
      setPlans(ps => ps.map(p => (p.key === plan.key ? j : p)));
      setSavedKey(plan.key);
      setTimeout(() => setSavedKey(null), 2500);
    } finally { setBusyKey(null); }
  }

  async function logout() {
    await fetch(`${API}/api/v1/control/auth/logout`, { method: "POST", credentials: "include" });
    window.location.href = "/control/login";
  }

  const cell = "w-full rounded-input border px-8 py-8 text-sm tabular-nums";
  const cellStyle = { borderColor: "var(--line)", background: "var(--milk)" };

  return (
    <div className="min-h-screen" style={{ background: "var(--milk)" }}>
      <header className="flex items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--gold)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--gold)" }}>
            Super Admin · Plans and pricing
          </p>
        </div>
        <div className="flex items-center gap-16">
          {me?.roles?.length ? (
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "rgba(255,255,255,0.7)" }}>
              {me.roles.join(" · ")}
            </span>
          ) : null}
          <a href="/control/tenants" className="text-xs font-semibold underline" style={{ color: "var(--gold)" }}>Tenants</a>
          <button type="button" onClick={logout}
            className="rounded-input border px-16 py-8 text-xs font-semibold text-white"
            style={{ borderColor: "rgba(255,255,255,0.4)" }}>
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[900px] px-16 py-32">
        <div className="flex items-start justify-between">
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Plans and pricing</h1>
          <ChangePassword />
        </div>
        <p className="mt-8 mb-24 text-sm" style={{ color: "var(--ink-soft)" }}>
          These plans are what transporters see at the licence gate. Prices in TZS, exclusive of VAT (VAT is added at 18% on the payment page).
        </p>

        {error && (
          <div role="alert" className="mb-16 px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
            {error}
          </div>
        )}

        <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Plan</th>
                <th className="p-12">Seats</th>
                <th className="p-12">Monthly</th>
                <th className="p-12">Quarterly</th>
                <th className="p-12">Annual</th>
                <th className="p-12">Active</th>
                <th className="p-12"></th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p, i) => {
                const d = drafts[p.key] ?? {};
                return (
                  <tr key={p.key} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className="p-8"><input className={cell} style={cellStyle} defaultValue={d.name ?? p.name}
                      onChange={e => edit(p.key, "name", e.target.value)} /></td>
                    <td className="p-8 w-24"><input className={cell} style={cellStyle} type="number" min={1}
                      defaultValue={d.seat_limit ?? p.seat_limit}
                      onChange={e => edit(p.key, "seat_limit", e.target.value)} /></td>
                    <td className="p-8 w-36"><input className={cell} style={cellStyle} type="number" step="0.01" min={0}
                      defaultValue={d.price_monthly ?? p.price_monthly}
                      onChange={e => edit(p.key, "price_monthly", e.target.value)} /></td>
                    <td className="p-8 w-36"><input className={cell} style={cellStyle} type="number" step="0.01" min={0}
                      defaultValue={d.price_quarterly ?? p.price_quarterly}
                      onChange={e => edit(p.key, "price_quarterly", e.target.value)} /></td>
                    <td className="p-8 w-36"><input className={cell} style={cellStyle} type="number" step="0.01" min={0}
                      defaultValue={d.price_annual ?? p.price_annual}
                      onChange={e => edit(p.key, "price_annual", e.target.value)} /></td>
                    <td className="p-8 text-center">
                      <input type="checkbox" defaultChecked={d.is_active ?? p.is_active}
                        onChange={e => edit(p.key, "is_active", e.target.checked)} />
                    </td>
                    <td className="p-8">
                      <button type="button" disabled={busyKey === p.key} onClick={() => save(p)}
                        className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                        {busyKey === p.key ? "Saving" : savedKey === p.key ? "Saved" : "Save"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-24 text-xs" style={{ color: "var(--ink-soft)" }}>
          First slice of the Super Admin panel (spec §8). Tenants, trials, licences, payments ledger, content editor and the remaining sections follow in later phases.
        </p>
      </main>
    </div>
  );
}