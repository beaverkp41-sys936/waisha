"use client";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

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
    <button type="button" className="text-xs underline" style={{ color: "var(--adm-accent)" }}
      onClick={() => setOpen(true)}>Change password</button>
  );

  return (
    <form onSubmit={submit} className="mb-24 space-y-12 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
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
  const [canPrice, setCanPrice] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const pr = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      setCanPrice(pr.ok ? (await pr.json()).permissions.includes("control.plans.manage") : false);
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

  const cell = "w-full rounded-input border px-8 py-8 text-sm tabular-nums";
  const cellStyle = { borderColor: "var(--line)", background: "var(--milk)" };

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Pricing desk · Plans and WAISHA packages
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1080px] px-16 py-32">
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

        <div className="overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
          <table className="w-full text-sm" style={{ minWidth: 900 }}>
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
                    <td className="p-8 min-w-[190px]"><input className={cell} style={cellStyle} defaultValue={d.name ?? p.name}
                      onChange={e => edit(p.key, "name", e.target.value)} /></td>
                    <td className="p-8 w-[86px] min-w-[86px]"><input className={cell} style={cellStyle} type="number" min={1}
                      defaultValue={d.seat_limit ?? p.seat_limit}
                      onChange={e => edit(p.key, "seat_limit", e.target.value)} /></td>
                    <td className="p-8 w-[128px] min-w-[128px]"><input className={cell} style={cellStyle} type="number" step="0.01" min={0}
                      defaultValue={d.price_monthly ?? p.price_monthly}
                      onChange={e => edit(p.key, "price_monthly", e.target.value)} /></td>
                    <td className="p-8 w-[128px] min-w-[128px]"><input className={cell} style={cellStyle} type="number" step="0.01" min={0}
                      defaultValue={d.price_quarterly ?? p.price_quarterly}
                      onChange={e => edit(p.key, "price_quarterly", e.target.value)} /></td>
                    <td className="p-8 w-[128px] min-w-[128px]"><input className={cell} style={cellStyle} type="number" step="0.01" min={0}
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

        {canPrice === false && (
          <div role="status" className="mt-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--warning) 8%, transparent)", borderLeft: "4px solid var(--warning)" }}>
            Signed in as {me?.email ?? "a platform seat"} without the pricing duty, so these figures are
            what the ladder currently sells at, not something you can change.
          </div>
        )}

        <PackagePrices canPrice={canPrice === true} />

        <p className="mt-24 text-xs" style={{ color: "var(--ink-soft)" }}>
          Changing a price here changes what the next applicant is invoiced at; it does not restate an
          invoice already issued, and it does not re-price a customer mid-term. Both editors are audited
          with your seat id. The rest of the panel —{" "}
          <a href="/control/tenants" className="underline" style={{ color: "var(--adm-accent)" }}>licences</a>,{" "}
          <a href="/control/subscriptions" className="underline" style={{ color: "var(--adm-accent)" }}>customers</a>,{" "}
          <a href="/control/payments" className="underline" style={{ color: "var(--adm-accent)" }}>money</a>,{" "}
          <a href="/control/revenue" className="underline" style={{ color: "var(--adm-accent)" }}>reports</a>{" "}
          and{" "}
          <a href="/control/staff" className="underline" style={{ color: "var(--adm-accent)" }}>the roster</a>
          {" "}— is in the header.
        </p>
      </main>
    </div>
  );
}

type Pkg = {
  id: string; key: string; name: string; description: string | null; services: string[];
  seat_limit: number; price_monthly: number; price_quarterly: number; price_annual: number;
  currency: string; is_active: boolean;
};

/**
 * The three WAISHA packages (spec §8; task #104).
 *
 * These are what a company chooses at the licence gate when it wants transport, CFA and office
 * together, so the row a pricing seat edits here is the row an applicant is invoiced from. The
 * ladder behind a package still licenses the seats — the package sets the money, the rung sets
 * how many staff can sign in — which is why both tables sit on this one page.
 */
function PackagePrices({ canPrice }: { canPrice: boolean }) {
  const [pkgs, setPkgs] = useState<Pkg[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Partial<Record<keyof Pkg, any>>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`${API}/api/v1/control/service-groups`, { credentials: "include" });
    // 403 here means the seat holds neither the pricing duty nor the analytics one — the
    // section is simply not this desk's business, so it stays out of the page.
    setPkgs(res.ok ? await res.json() : null);
  }, []);

  useEffect(() => { load(); }, [load]);

  function edit(key: string, field: keyof Pkg, value: any) {
    setDrafts(d => ({ ...d, [key]: { ...d[key], [field]: value } }));
  }

  async function save(p: Pkg) {
    setBusy(p.key); setError(null);
    const d = drafts[p.key] ?? {};
    try {
      const body: Record<string, any> = {};
      if (d.name !== undefined) body.name = d.name;
      if (d.description !== undefined) body.description = d.description;
      if (d.seat_limit !== undefined) body.seatLimit = Number(d.seat_limit);
      if (d.price_monthly !== undefined) body.priceMonthly = Number(d.price_monthly);
      if (d.price_quarterly !== undefined) body.priceQuarterly = Number(d.price_quarterly);
      if (d.price_annual !== undefined) body.priceAnnual = Number(d.price_annual);
      if (d.is_active !== undefined) body.isActive = d.is_active;
      if (!Object.keys(body).length) { setSaved(p.key); setTimeout(() => setSaved(null), 2000); return; }
      const res = await fetch(`${API}/api/v1/control/service-groups/${p.key}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "The package was not saved."); return; }
      setPkgs(ps => (ps ?? []).map(x => (x.key === p.key ? j : x)));
      setDrafts(dd => { const n = { ...dd }; delete n[p.key]; return n; });
      setSaved(p.key);
      setTimeout(() => setSaved(null), 2500);
    } finally { setBusy(null); }
  }

  if (pkgs === null) return null;

  const cell = "w-full rounded-input border px-8 py-8 text-sm tabular-nums";
  const cellStyle = { borderColor: "var(--line)", background: "var(--milk)" };

  return (
    <section className="mt-32">
      <h2 className="text-xl font-bold" style={{ color: "var(--ink)" }}>WAISHA packages</h2>
      <p className="mt-8 mb-16 text-sm" style={{ color: "var(--ink-soft)" }}>
        The three service groups an applicant can ask for: transport and office, CFA and office, or
        all three. A company sold on one of these is invoiced at the package price, and the reports
        price its monthly run-rate from it too — so a figure changed here is the figure the next
        invoice and the MRR both use.
      </p>

      {error && (
        <div role="alert" className="mb-16 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm" style={{ minWidth: 1000 }}>
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Package</th>
              <th className="p-12">Gives</th>
              <th className="p-12">Seats</th>
              <th className="p-12">Monthly</th>
              <th className="p-12">Quarterly</th>
              <th className="p-12">Annual</th>
              <th className="p-12">Sold</th>
              <th className="p-12"></th>
            </tr>
          </thead>
          <tbody>
            {pkgs.map((p, i) => {
              const d = drafts[p.key] ?? {};
              return (
                <tr key={p.key} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-8 min-w-[210px]">
                    <input className={cell} style={cellStyle} disabled={!canPrice}
                      defaultValue={d.name ?? p.name} onChange={e => edit(p.key, "name", e.target.value)} />
                    <p className="mt-4 text-[10px] font-semibold tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                      {p.key}
                    </p>
                  </td>
                  <td className="p-12 align-top">
                    <div className="flex flex-wrap gap-4">
                      {(p.services ?? []).map((s) => (
                        <span key={s} className="px-6 py-2 text-[10px] font-bold uppercase"
                          style={{ background: "var(--adm-accent-soft)", color: "var(--adm-accent)", borderRadius: 4 }}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="p-8 w-[78px] min-w-[78px]"><input className={cell} style={cellStyle} type="number" min={1} disabled={!canPrice}
                    defaultValue={d.seat_limit ?? p.seat_limit} onChange={e => edit(p.key, "seat_limit", e.target.value)} /></td>
                  <td className="p-8 w-[128px] min-w-[128px]"><input className={cell} style={cellStyle} type="number" min={0} disabled={!canPrice}
                    defaultValue={d.price_monthly ?? p.price_monthly}
                    onChange={e => edit(p.key, "price_monthly", e.target.value)} /></td>
                  <td className="p-8 w-[128px] min-w-[128px]"><input className={cell} style={cellStyle} type="number" min={0} disabled={!canPrice}
                    defaultValue={d.price_quarterly ?? p.price_quarterly}
                    onChange={e => edit(p.key, "price_quarterly", e.target.value)} /></td>
                  <td className="p-8 w-[128px] min-w-[128px]"><input className={cell} style={cellStyle} type="number" min={0} disabled={!canPrice}
                    defaultValue={d.price_annual ?? p.price_annual}
                    onChange={e => edit(p.key, "price_annual", e.target.value)} /></td>
                  <td className="p-8 text-center">
                    <input type="checkbox" disabled={!canPrice} defaultChecked={d.is_active ?? p.is_active}
                      onChange={e => edit(p.key, "is_active", e.target.checked)} />
                  </td>
                  <td className="p-8">
                    {canPrice && (
                      <button type="button" disabled={busy === p.key} onClick={() => save(p)}
                        className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                        {busy === p.key ? "Saving" : saved === p.key ? "Saved" : "Save"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!canPrice && (
        <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
          Read with the analytics duty; only the pricing desk can change these.
        </p>
      )}
    </section>
  );
}