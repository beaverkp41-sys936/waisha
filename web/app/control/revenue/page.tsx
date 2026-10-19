"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The platform's own accounts page: what comes in, what goes out, what the trend says
 * is coming next, and which offering is actually selling (spec §8; task #104).
 *
 * Every figure here is a number the database produced. The routes only bind parameters
 * and turn numeric into a JS number, so the MRR on this screen is the same arithmetic
 * the register runs and the same clock the ledger keeps — a chart that disagreed with
 * its own table would be the worst kind of report.
 */

type Overview = {
  generated_at: string; currency: string;
  companies: Record<string, number>;
  seekers: Record<string, number>;
  users: Record<string, number>;
  subscriptions: Record<string, number>;
  recurring: { mrr: string | number; arr: string | number };
  money: Record<string, string | number>;
  passes: Record<string, string | number>;
  costs: Record<string, string | number>;
  marketplace: Record<string, number>;
  activity: Record<string, number>;
};
type Pl = {
  month: string; subscription_income: number; pass_income: number; gross: number;
  vat: number; net: number; costs: number; profit: number;
  paid_invoices: number; paid_passes: number;
};
type Growth = {
  month: string; new_companies: number; new_seekers: number; new_users: number;
  activated: number; lapsed: number; searches: number;
};
type Metric = {
  slope: number | null; fit_r2: number | null;
  series: { month: string; actual: number | null; projected: number | null }[];
};
type Mix = {
  offering: string; offering_name: string; offering_kind: string;
  customers: number; invoices_paid: number; income: number; share: number;
};
type AllocLine = {
  module: string; module_label: string; basis: string; customers: number; units: number;
  income: number; share: number; usage_income: number; even_income: number;
};
type AllocCompany = {
  tenant_id: string; company_name: string; company_type: string;
  offering: string; offering_name: string; services: string[]; basis: string;
  invoices_paid: number; income: number;
  transport_units: number; cfa_units: number; office_units: number;
  transport_income: number | null; cfa_income: number | null; office_income: number | null;
  transport_share: number | null; cfa_share: number | null; office_share: number | null;
};
type Cost = { id: string; period: string; category: string; amount: number; note: string | null };

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const money = (v: unknown) => `${n(v).toLocaleString("en-US", { maximumFractionDigits: 0 })} TZS`;
const short = (v: unknown) => {
  const x = n(v);
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(0)}K`;
  return `${sign}${a.toFixed(0)}`;
};
const monthLabel = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });

const INCOME = "var(--adm-accent)";
const COST = "var(--warning)";
const PROFIT_UP = "var(--success)";
const PROFIT_DOWN = "var(--danger)";

/** One month, one cluster of bars. Heights are shares of the busiest month in view, so
 *  the eye compares months rather than reading six numbers per row. */
function ColumnChart({ rows, series, height = 120 }: {
  rows: Record<string, any>[];
  series: { key: string; label: string; color: (row: any) => string }[];
  height?: number;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Math.abs(n(r[s.key])))));
  return (
    <div className="flex items-end gap-10 overflow-x-auto pt-8">
      {rows.map((r) => (
        <div key={r.month} className="min-w-[52px] flex-1 text-center">
          <div className="flex items-end justify-center gap-4" style={{ height }}>
            {series.map((s) => {
              const v = n(r[s.key]);
              return (
                <div key={s.key} title={`${s.label} · ${monthLabel(r.month)}: ${money(v)}`}
                  style={{
                    width: 14, borderRadius: "3px 3px 0 0",
                    height: `${Math.max(2, (Math.abs(v) / max) * 100)}%`,
                    background: s.color(r), opacity: v === 0 ? 0.25 : 1
                  }} />
              );
            })}
          </div>
          <p className="mt-6 text-[10px] font-semibold uppercase" style={{ color: "var(--ink-soft)" }}>
            {monthLabel(r.month)}
          </p>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="mt-10 flex flex-wrap gap-16">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          <i style={{ width: 10, height: 10, background: color, display: "inline-block", borderRadius: 2 }} />
          {label}
        </span>
      ))}
    </div>
  );
}

const CATEGORY_KEYS = ["infrastructure", "salaries", "marketing", "licences", "support", "other"];

function CostBook({ costs, canRecord, onRecorded }: {
  costs: Cost[]; canRecord: boolean; onRecorded: () => void;
}) {
  const [period, setPeriod] = useState(() => new Date().toISOString().slice(0, 7) + "-01");
  const [category, setCategory] = useState("infrastructure");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() - i, 1);
    return d.toISOString().slice(0, 7) + "-01";
  });

  async function save() {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/api/v1/control/costs`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period, category, amount: Number(amount),
          ...(note.trim() ? { note: note.trim() } : {})
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "The cost was not recorded."); return; }
      setAmount(""); setNote("");
      onRecorded();
    } finally { setBusy(false); }
  }

  const field = "rounded-input border px-10 py-8 text-sm";
  const fieldStyle = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" };

  return (
    <section className="mt-32">
      <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
        What the platform spends
      </h2>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        One row per month and category, keyed by the month it belongs to. Recording a month
        again replaces the figure rather than sitting beside it, and the change is audited —
        a month that has already been reported on keeps its numbers.
      </p>

      {canRecord && (
        <div className="mt-16 flex flex-wrap items-end gap-12 rounded-card border p-16"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            Month
            <select value={period} onChange={(e) => setPeriod(e.target.value)}
              className={field + " mt-4 block"} style={fieldStyle}>
              {months.map((m) => <option key={m} value={m}>{m.slice(0, 7)}</option>)}
            </select>
          </label>
          <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className={field + " mt-4 block"} style={fieldStyle}>
              {CATEGORY_KEYS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            Amount (TZS)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min={0}
              placeholder="0" className={field + " mt-4 block w-40 tabular-nums"} style={fieldStyle} />
          </label>
          <label className="min-w-[220px] flex-1 text-[11px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: "var(--ink-soft)" }}>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={280}
              placeholder="what the money went to" className={field + " mt-4 block w-full"} style={fieldStyle} />
          </label>
          <button type="button" className="waisha-btn rounded-input px-20 py-10 text-xs font-semibold"
            disabled={busy || !amount || Number(amount) < 0} onClick={save}>
            {busy ? "Recording" : "Record"}
          </button>
          {error && <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>}
        </div>
      )}

      <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Month</th>
              <th className="p-12">Category</th>
              <th className="p-12 text-right">Amount</th>
              <th className="p-12">Note</th>
            </tr>
          </thead>
          <tbody>
            {costs.map((c, i) => (
              <tr key={c.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>{c.period.slice(0, 7)}</td>
                <td className="p-12" style={{ color: "var(--ink)" }}>{c.category}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{money(c.amount)}</td>
                <td className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>{c.note ?? "—"}</td>
              </tr>
            ))}
            {!costs.length && (
              <tr><td colSpan={4} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No month has a cost recorded yet, so every profit figure below is really a gross
                figure. Until the platform's own outgoings are in here, treat profit as an
                upper bound.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ControlRevenuePage() {
  const [me, setMe] = useState<any>(null);
  const [perm, setPerm] = useState<string[]>([]);
  const [ov, setOv] = useState<Overview | null>(null);
  const [pl, setPl] = useState<Pl[]>([]);
  const [growth, setGrowth] = useState<Growth[]>([]);
  const [forecast, setForecast] = useState<Record<string, Metric>>({});
  const [mix, setMix] = useState<Mix[]>([]);
  const [alloc, setAlloc] = useState<AllocLine[]>([]);
  const [allocUnits, setAllocUnits] = useState<string[]>([]);
  const [allocMoney, setAllocMoney] = useState(0);
  const [allocCompanies, setAllocCompanies] = useState<AllocCompany[]>([]);
  const [allocMatched, setAllocMatched] = useState(0);
  const [allocMatchedIncome, setAllocMatchedIncome] = useState(0);
  const [allocLimit, setAllocLimit] = useState(12);
  const [costs, setCosts] = useState<Cost[]>([]);
  const [months, setMonths] = useState(12);
  const [mixDays, setMixDays] = useState(90);
  const [metric, setMetric] = useState("profit");
  const [growthKey, setGrowthKey] = useState<keyof Growth>("new_companies");
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const get = useCallback(async (path: string) => {
    const res = await fetch(`${API}/api/v1${path}`, { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return null; }
    if (res.status === 403) { setForbidden(true); return null; }
    if (!res.ok) { setError("The platform did not answer its own reports."); return null; }
    return res.json();
  }, []);

  const load = useCallback(async (m: number, d: number, al: number) => {
    setLoading(true);
    const [o, p, g, f, x, a, ac] = await Promise.all([
      get("/control/analytics/overview"),
      get(`/control/analytics/revenue?months=${m}`),
      get(`/control/analytics/growth?months=${m}`),
      get(`/control/analytics/forecast?months=${m}&horizon=6`),
      get(`/control/revenue/mix?days=${d}`),
      get(`/control/revenue/allocation?days=${d}`),
      get(`/control/revenue/allocation/companies?days=${d}&limit=${al}`)
    ]);
    if (o) setOv(o);
    if (p) setPl(p);
    if (g) setGrowth(g);
    if (f) setForecast(f.metrics ?? {});
    if (x) setMix(x.offerings ?? []);
    if (a) { setAlloc(a.lines ?? []); setAllocUnits(a.unit_definition ?? []); setAllocMoney(n(a.platform_income)); }
    if (ac) {
      setAllocCompanies(ac.companies ?? []);
      setAllocMatched(n(ac.total));
      setAllocMatchedIncome(n(ac.total_income));
    }
    setLoading(false);
  }, [get]);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const pr = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (pr.ok) setPerm((await pr.json()).permissions ?? []);
      load(12, 90, 12);
      const c = await get("/control/costs");
      if (c) setCosts(c);
    })();
  }, [load, get]);

  const reloadCosts = useCallback(async () => {
    const c = await get("/control/costs");
    if (c) setCosts(c);
    load(months, mixDays, allocLimit);
  }, [get, load, months, mixDays, allocLimit]);

  const totals = pl.reduce((t, r) => ({
    net: t.net + r.net, costs: t.costs + r.costs, profit: t.profit + r.profit,
    vat: t.vat + r.vat, gross: t.gross + r.gross
  }), { net: 0, costs: 0, profit: 0, vat: 0, gross: 0 });

  const tiles: [string, string | number, string?][] = ov ? [
    ["MRR", short(ov.recurring.mrr), money(ov.recurring.mrr)],
    ["ARR", short(ov.recurring.arr), money(ov.recurring.arr)],
    ["Collected this month", short(ov.money.collected_month), money(ov.money.collected_month)],
    ["Collected in 30 days", short(ov.money.collected_30d), money(ov.money.collected_30d)],
    ["Costs this month", short(ov.costs.month), money(ov.costs.month)],
    ["Outstanding invoices", short(ov.money.outstanding), money(ov.money.outstanding)],
    ["Overdue", short(ov.money.overdue), money(ov.money.overdue)],
    ["Companies", ov.companies.total, `${ov.companies.active} active · ${ov.companies.trial} on trial`],
    ["Subscriptions", ov.subscriptions.total,
      `${ov.subscriptions.active} active · ${ov.subscriptions.bundles} on a package`],
    ["Seats licensed", ov.subscriptions.seats_licensed, "on live subscriptions"],
    ["Seekers", ov.seekers.total, `${ov.seekers.unverified} still unverified`],
    ["Passes awaiting a reference", ov.passes.awaiting_verification,
      `${ov.passes.live_now} live passes now`],
    ["Paid invoices ever", ov.money.invoices_paid_all_time, "invoices the office confirmed"],
    ["Searches in 30 days", ov.marketplace.searches_30d, `${ov.marketplace.searches_7d} this week`]
  ] : [];

  const forecastMetrics = Object.keys(forecast);
  const shown = forecast[metric];

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between gap-16 px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Platform reports · Revenue, costs and forecast
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1180px] px-16 py-32">
        {forbidden ? (
          <div className="rounded-card border p-24" style={{ borderColor: "var(--line)" }}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>These reports are not yours to read</h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ") || "no platform duty"}.
              The platform accounts need the duty <code>control.analytics.view</code>.
            </p>
            <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-16">
              <div>
                <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Revenue and the platform's own numbers</h1>
                <p className="mt-8 max-w-[70ch] text-sm" style={{ color: "var(--ink-soft)" }}>
                  Dar es Salaam months throughout. A company is income when the office confirms
                  its invoice; a seeker's search pass is income when the office confirms the
                  reference they typed. Both clocks are the ones the money ledger uses, so this
                  page and that ledger cannot tell two stories.
                </p>
              </div>
              <div className="flex items-end gap-16">
                <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                  Months
                  <select value={months} onChange={(e) => { const v = Number(e.target.value); setMonths(v); load(v, mixDays, allocLimit); }}
                    className="mt-4 block rounded-input border px-10 py-8 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                    {[3, 6, 12, 24, 36].map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <div className="text-right">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                    Generated
                  </p>
                  <p className="text-xs tabular-nums" style={{ color: "var(--ink)" }}>
                    {ov ? new Date(ov.generated_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—"}
                  </p>
                </div>
              </div>
            </div>

            {(error || loading) && (
              <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
                style={{
                  background: error ? "color-mix(in srgb, var(--danger) 8%, transparent)" : "var(--milk-deep)",
                  borderLeft: `4px solid ${error ? "var(--danger)" : "var(--adm-line)"}`,
                  color: "var(--ink)"
                }}>
                {error ?? "Reading the platform's own tables…"}
              </div>
            )}

            {ov && (
              <section className="mt-24">
                <div className="grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(178px, 1fr))" }}>
                  {tiles.map(([label, value, detail]) => (
                    <div key={label} className="rounded-card border p-16"
                      style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                      <p className="text-xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{value}</p>
                      <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                        {label}
                      </p>
                      {detail && <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>{detail}</p>}
                    </div>
                  ))}
                </div>
                <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Read the money as it moved:{" "}
                  <Link href="/control/subscriptions" className="underline" style={{ color: "var(--adm-accent)" }}>
                    every customer
                  </Link>{" "}
                  and{" "}
                  <Link href="/control/payments" className="underline" style={{ color: "var(--adm-accent)" }}>
                    every payment record
                  </Link>
                  .
                </p>
              </section>
            )}

            <section className="mt-32">
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                Profit and loss, month by month
              </h2>
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                Income is what landed in the month; VAT is shown but it is not the platform's
                money and is excluded from net. Profit is net income less the costs recorded for
                that month.
              </p>
              <div className="mt-16 rounded-card border p-16" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                <ColumnChart rows={pl} series={[
                  { key: "net", label: "Net income", color: () => INCOME },
                  { key: "costs", label: "Costs", color: () => COST },
                  { key: "profit", label: "Profit", color: (r) => (r.profit < 0 ? PROFIT_DOWN : PROFIT_UP) }
                ]} />
                <Legend items={[["Net income", INCOME], ["Costs", COST], ["Profit", PROFIT_UP], ["Loss", PROFIT_DOWN]]} />
              </div>
              <div className="mt-16 overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      {["Month", "Subscriptions", "Search passes", "Gross", "VAT", "Net", "Costs", "Profit", "Records"].map((h) => (
                        <th key={h} className={"p-12 " + (h === "Month" ? "" : "text-right")}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pl.map((r, i) => (
                      <tr key={r.month} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>{r.month.slice(0, 7)}</td>
                        <td className="p-12 text-right tabular-nums">{money(r.subscription_income)}</td>
                        <td className="p-12 text-right tabular-nums">{money(r.pass_income)}</td>
                        <td className="p-12 text-right tabular-nums">{money(r.gross)}</td>
                        <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{money(r.vat)}</td>
                        <td className="p-12 text-right tabular-nums" style={{ color: INCOME }}>{money(r.net)}</td>
                        <td className="p-12 text-right tabular-nums" style={{ color: COST }}>{money(r.costs)}</td>
                        <td className="p-12 text-right font-semibold tabular-nums"
                          style={{ color: r.profit < 0 ? PROFIT_DOWN : PROFIT_UP }}>{money(r.profit)}</td>
                        <td className="p-12 text-right tabular-nums text-xs" style={{ color: "var(--ink-soft)" }}>
                          {r.paid_invoices} inv · {r.paid_passes} pass
                        </td>
                      </tr>
                    ))}
                    {!!pl.length && (
                      <tr className="border-t font-semibold" style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                        <td className="p-12">{pl.length} months</td>
                        <td className="p-12 text-right" />
                        <td className="p-12 text-right" />
                        <td className="p-12 text-right tabular-nums">{money(totals.gross)}</td>
                        <td className="p-12 text-right tabular-nums">{money(totals.vat)}</td>
                        <td className="p-12 text-right tabular-nums">{money(totals.net)}</td>
                        <td className="p-12 text-right tabular-nums">{money(totals.costs)}</td>
                        <td className="p-12 text-right tabular-nums" style={{ color: totals.profit < 0 ? PROFIT_DOWN : PROFIT_UP }}>
                          {money(totals.profit)}
                        </td>
                        <td className="p-12" />
                      </tr>
                    )}
                    {!pl.length && !loading && (
                      <tr><td colSpan={9} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        Nothing has been confirmed as paid in this window yet.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-32">
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                Where the trend says the money is going
              </h2>
              <p className="mt-8 max-w-[80ch] text-sm" style={{ color: "var(--ink-soft)" }}>
                A least-squares fit over the months above, projected {Math.max(1, n(forecast?.[metric]?.series?.length ?? 6) - pl.length)} months
                forward. It is a straight line through real figures, not a model that knows about a
                price change or a campaign — read the fit quality next to it, and treat a low R² as
                "there is no trend here yet".
              </p>
              <div className="mt-16 flex flex-wrap gap-8">
                {forecastMetrics.map((k) => (
                  <button key={k} type="button" onClick={() => setMetric(k)}
                    className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                    style={{
                      borderColor: k === metric ? "var(--adm-accent)" : "var(--line)",
                      background: k === metric ? "var(--adm-accent-soft)" : "transparent",
                      color: k === metric ? "var(--adm-accent)" : "var(--ink-soft)"
                    }}>
                    {k.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
              {shown ? (
                <div className="mt-16 rounded-card border p-16" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <div className="flex flex-wrap items-baseline gap-24">
                    <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {metric.replace(/_/g, " ")}
                    </p>
                    <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                      trend {shown.slope === null ? "unknown" : `${money(shown.slope)} per month`}
                      {" · "}fit quality {shown.fit_r2 === null ? "—" : `${Math.round(shown.fit_r2 * 100)}%`}
                    </p>
                  </div>
                  <ColumnChart
                    rows={shown.series.map((s) => ({ month: s.month, actual: s.actual, projected: s.projected }))}
                    series={[
                      { key: "actual", label: "Actual", color: () => INCOME },
                      { key: "projected", label: "Projected", color: () => "var(--adm-line)" }
                    ]} />
                  <Legend items={[["Actual", INCOME], ["Projected", "var(--adm-line)"]]} />
                </div>
              ) : <p className="mt-16 text-sm" style={{ color: "var(--ink-soft)" }}>No months to fit yet.</p>}
            </section>

            <section className="mt-32">
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                How fast the platform is growing
              </h2>
              <div className="mt-16 flex flex-wrap gap-8">
                {(["new_companies", "new_seekers", "new_users", "activated", "lapsed", "searches"] as const)
                  .map((k) => (
                    <button key={k} type="button" onClick={() => setGrowthKey(k)}
                      className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                      style={{
                        borderColor: k === growthKey ? "var(--adm-accent)" : "var(--line)",
                        background: k === growthKey ? "var(--adm-accent-soft)" : "transparent",
                        color: k === growthKey ? "var(--adm-accent)" : "var(--ink-soft)"
                      }}>
                      {k.replace(/_/g, " ")}
                    </button>
                  ))}
              </div>
              <div className="mt-16 rounded-card border p-16" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                <ColumnChart
                  rows={growth}
                  height={96}
                  series={[{
                    key: growthKey,
                    label: growthKey.replace(/_/g, " "),
                    color: () => (growthKey === "lapsed" ? PROFIT_DOWN : "var(--success)")
                  }]} />
                <p className="mt-10 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {growth.reduce((s, g) => s + n(g[growthKey]), 0)} {growthKey.replace(/_/g, " ")} across{" "}
                  {growth.length} months. Lapsed counts licences that expired in the month without
                  renewing — the one number worth watching every week.
                </p>
              </div>
            </section>

            <section className="mt-32">
              <div className="flex flex-wrap items-end justify-between gap-16">
                <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                  What is actually selling
                </h2>
                <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                  Window
                  <select value={mixDays} onChange={(e) => { const v = Number(e.target.value); setMixDays(v); load(months, v, allocLimit); }}
                    className="ml-8 rounded-input border px-10 py-8 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                    {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
                  </select>
                </label>
              </div>
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                Confirmed invoices grouped by the package or the rung the customer was sold on.
                A seeker's pass money is not here — it has no offering — and it is on the{" "}
                <Link href="/control/payments" className="underline" style={{ color: "var(--adm-accent)" }}>money ledger</Link>.
              </p>
              <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      <th className="p-12">Offering</th>
                      <th className="p-12">Sold as</th>
                      <th className="p-12 text-right">Customers</th>
                      <th className="p-12 text-right">Invoices</th>
                      <th className="p-12 text-right">Income</th>
                      <th className="p-12" style={{ width: 220 }}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mix.map((m, i) => (
                      <tr key={m.offering} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{m.offering_name}</td>
                        <td className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>{m.offering_kind === "bundle" ? "WAISHA package" : "plan ladder"}</td>
                        <td className="p-12 text-right tabular-nums">{m.customers}</td>
                        <td className="p-12 text-right tabular-nums">{m.invoices_paid}</td>
                        <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{money(m.income)}</td>
                        <td className="p-12">
                          <div className="flex items-center gap-8">
                            <div style={{ height: 8, flex: 1, background: "var(--adm-line)", borderRadius: 4, overflow: "hidden" }}>
                              <div style={{
                                height: "100%", width: `${Math.max(1, Math.round(m.share * 100))}%`,
                                background: INCOME, opacity: 0.8
                              }} />
                            </div>
                            <span className="w-12 text-right text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {Math.round(m.share * 100)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!mix.length && !loading && (
                      <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        No invoice has been confirmed in this window.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-32">
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                How the money is allocated across the offices
              </h2>
              <p className="mt-8 max-w-[78ch] text-sm" style={{ color: "var(--ink-soft)" }}>
                No price in this system belongs to one office: a package is sold as one number.
                So each bundle's income is split across the offices it actually sells, weighted by
                the work each one recorded inside the window. That is an allocation, printed as
                one — not a price list. A plan ladder rung is never split, a seeker's pass is its
                own line, and money with no subscription behind it stays on a line of its own, so
                the six lines below add up to the {money(allocMoney)} the window holds.
              </p>
              {allocUnits.length > 0 && (
                <ul className="mt-12 max-w-[78ch] space-y-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {allocUnits.map((u) => (
                    <li key={u} className="flex gap-8">
                      <span style={{ color: "var(--adm-accent)" }}>•</span>
                      <span>a unit is {u}</span>
                    </li>
                  ))}
                  <li className="flex gap-8">
                    <span style={{ color: "var(--adm-accent)" }}>•</span>
                    <span>work done in an office the package never sold earns that office
                      nothing, and is not counted in its column</span>
                  </li>
                </ul>
              )}
              <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      <th className="p-12">Office</th>
                      <th className="p-12">How it was placed</th>
                      <th className="p-12 text-right">Customers</th>
                      <th className="p-12 text-right">Units</th>
                      <th className="p-12 text-right">Income</th>
                      <th className="p-12" style={{ width: 190 }}>Share</th>
                      <th className="p-12 text-right">By recorded work</th>
                      <th className="p-12 text-right">By the even fall-back</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alloc.map((a, i) => (
                      <tr key={a.module} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{a.module_label}</td>
                        <td className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>{a.basis}</td>
                        <td className="p-12 text-right tabular-nums">{a.customers}</td>
                        <td className="p-12 text-right tabular-nums">{a.units || "—"}</td>
                        <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{money(a.income)}</td>
                        <td className="p-12">
                          <div className="flex items-center gap-8">
                            <div style={{ height: 8, flex: 1, background: "var(--adm-line)", borderRadius: 4, overflow: "hidden" }}>
                              <div style={{
                                height: "100%", width: `${Math.max(1, Math.round(n(a.share) * 100))}%`,
                                background: ["transport", "cfa", "office"].includes(a.module) ? INCOME : COST,
                                opacity: 0.8
                              }} />
                            </div>
                            <span className="w-12 text-right text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {Math.round(n(a.share) * 100)}%
                            </span>
                          </div>
                        </td>
                        <td className="p-12 text-right tabular-nums text-xs" style={{ color: "var(--ink-soft)" }}>
                          {["transport", "cfa", "office"].includes(a.module) ? money(a.usage_income) : "—"}
                        </td>
                        <td className="p-12 text-right tabular-nums text-xs" style={{ color: "var(--ink-soft)" }}>
                          {["transport", "cfa", "office"].includes(a.module) ? money(a.even_income) : "—"}
                        </td>
                      </tr>
                    ))}
                    {!alloc.length && !loading && (
                      <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        Nothing was paid in this window, so there is nothing to allocate.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="mt-20 flex flex-wrap items-center justify-between gap-12">
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  {allocMatched} {allocMatched === 1 ? "company" : "companies"} paid {money(allocMatchedIncome)}{" "}
                  of package money in these {mixDays} days; the table shows the richest{" "}
                  {allocCompanies.length}.
                </p>
                {allocCompanies.length < allocMatched ? (
                  <button type="button"
                    onClick={() => { setAllocLimit(400); load(months, mixDays, 400); }}
                    className="rounded-input border px-12 py-8 text-xs font-semibold"
                    style={{ borderColor: "var(--adm-accent)", color: "var(--adm-accent)", background: "transparent" }}>
                    Show every company
                  </button>
                ) : allocLimit > 12 ? (
                  <button type="button"
                    onClick={() => { setAllocLimit(12); load(months, mixDays, 12); }}
                    className="rounded-input border px-12 py-8 text-xs font-semibold"
                    style={{ borderColor: "var(--line)", color: "var(--ink-soft)", background: "transparent" }}>
                    Back to the top 12
                  </button>
                ) : null}
              </div>

              <div className="mt-12 overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      <th className="p-12">Company</th>
                      <th className="p-12">Sold as</th>
                      <th className="p-12 text-right">Invoices</th>
                      <th className="p-12 text-right">Income</th>
                      <th className="p-12 text-right">Work t·c·o</th>
                      <th className="p-12 text-right">Transport</th>
                      <th className="p-12 text-right">Clearing</th>
                      <th className="p-12 text-right">Office</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocCompanies.map((c, i) => (
                      <tr key={c.tenant_id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>
                          {c.company_name}
                          <span className="ml-8 text-[10px] font-normal uppercase tracking-[0.1em]"
                            style={{ color: "var(--ink-soft)" }}>{c.company_type}</span>
                        </td>
                        <td className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                          {c.offering_name}
                          <span className="mt-2 block text-[10px]" style={{ color: "var(--ink-soft)" }}>{c.basis}</span>
                        </td>
                        <td className="p-12 text-right tabular-nums">{c.invoices_paid}</td>
                        <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{money(c.income)}</td>
                        <td className="p-12 text-right tabular-nums text-xs" style={{ color: "var(--ink-soft)" }}>
                          {c.transport_units}·{c.cfa_units}·{c.office_units}
                        </td>
                        {(["transport", "cfa", "office"] as const).map((k) => (
                          <td key={k} className="p-12 text-right tabular-nums text-xs"
                            style={{ color: c[`${k}_income`] === null ? "var(--ink-soft)" : "var(--ink)" }}>
                            {c[`${k}_income`] === null
                              ? "not split"
                              : `${money(c[`${k}_income`])} · ${Math.round(n(c[`${k}_share`]) * 100)}%`}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {!allocCompanies.length && !loading && (
                      <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        No company paid a subscription invoice inside this window.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="mt-12 max-w-[78ch] text-xs" style={{ color: "var(--ink-soft)" }}>
                Read the columns as three sentences. "allocated by recorded work" is the weight
                doing the work. "even" means the company bought the offices but recorded nothing
                in them, so the money was shared evenly rather than dropped — that part is a
                convention, not evidence. "not split" and "no subscription" are printed as they
                are: a ladder rung has no component list to divide, and an invoice with no
                subscription behind it belongs to no office at all. The last rounding cent of a
                company's split goes to its busiest office whole, so the three figures always add
                up to that company's income to the cent.
              </p>
            </section>

            <CostBook costs={costs} canRecord={perm.includes("control.costs.manage")} onRecorded={reloadCosts} />
          </>
        )}
      </main>
    </div>
  );
}
