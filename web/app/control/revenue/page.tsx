"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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

/** 143's doors answer a refusal as an object too, so every read shape below keeps `ok`/`message` optional
 *  rather than trusting that the answer was the register. */
type CutKind = "account" | "source" | "desk" | "route";
type PeriodKind = "day" | "week" | "month";
type CountState = {
  ok?: boolean; message?: string; since: string; days: number; today: string;
  currencies: {
    currency: string; snapshots: number; first_day: string | null; last_day: string | null;
    revisions: number; income_in_window: string | number;
    yesterday_counted: boolean; today_counted: boolean;
    uncounted_count: number; uncounted_days: string[]; next_day: string | null;
  }[];
};
type Reading = {
  id: string; ref: string; day: string; currency: string;
  income: string | number; postings: number; entries: number; reversed_postings: number;
  revisions: number; retaken: boolean; taken_at: string; taken_by_name: string | null;
  note: string | null; accounts: number; sources: number; desks: number; roads: number;
};
type BookPage = {
  ok?: boolean; message?: string; currency: string;
  counted_days: number; window_income: string | number; rows: Reading[];
};
type Bucket = {
  key: string; label: string | null; total: string | number;
  credit: string | number; debit: string | number; postings: number; readings: number;
  share: string | number | null;
};
type CutPage = {
  ok?: boolean; message?: string; cut: CutKind; currency: string;
  income: string | number; buckets: number; omitted: number; note: string | null; rows: Bucket[];
};
type Fold = {
  period_start: string; period_end: string; label: string; currency: string;
  actual: string | number; snapshots: number; days_counted: number; reversed_postings: number;
  uncounted_count: number; uncounted_days: string[]; complete: boolean;
  target: { ref: string; amount: string | number; note: string | null; raised_by_name: string | null } | null;
  gap: string | number | null; attainment: string | number | null;
};
type WindowPage = {
  ok?: boolean; message?: string; kind: PeriodKind; currency: string;
  periods: number; actual: string | number; target: string | number;
  gap: string | number; attainment: string | number | null; rows: Fold[];
};
type Target = {
  ok?: boolean; id: string; ref: string; currency: string; kind: PeriodKind;
  period_start: string; period_end: string; label: string;
  amount: string | number; note: string | null; status: string;
  raised_by_name: string | null; withdrawn_by_name: string | null;
  withdrawn_at: string | null; withdrawn_reason: string | null;
  counted_days: number; actual: string | number; days_left: number; in_the_past: boolean;
};
type TargetsPage = { ok?: boolean; message?: string; currency: string; count: number; rows: Target[] };

/** A figure always travels with the money it is counted in. `money()` above prints "TZS" into its own
 *  text, and 138's defect was a USD sum wearing a TZS label — so every number this register prints goes
 *  through here with the currency its own row carries. */
const figure = (v: unknown, c: string | null | undefined) =>
  `${n(v).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${c ?? "TZS"}`;
const FIELD = "rounded-input border px-10 py-8 text-sm";
const FIELD_STYLE = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" };

/** The words a refusal was written with. `error.message` is what the framework says — "Request validation
 *  failed" tells an office nothing about which box it got wrong — while the sentence the door meant for a
 *  person to read is carried one level down in `error.details`. Every other control desk reads the details
 *  for this reason; a press that is refused here without them is a press the clerk cannot correct. */
function refused(j: any, fallback: string) {
  const m = String(j?.error?.message ?? "").trim() || fallback;
  const hints = ((j?.error?.details ?? []) as any[])
    .map((d) => [String(d?.field ?? "").trim(), String(d?.message ?? "").trim()].filter(Boolean).join(": "))
    .filter((s) => s.length > 0);
  return hints.length ? `${m} — ${hints.slice(0, 3).join("; ")}` : m;
}

/** One read of one of 143's doors. A 401 is the session ending, not an answer about the book. */
async function read<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}/api/v1${path}`, { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return null; }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: refused(j, "The register did not answer.") } as unknown as T;
    }
    return await res.json() as T;
  } catch {
    return null;
  }
}

/** One press on one of 143's doors: the door's own sentence is the useful half of the answer, so a
 *  refusal is shown as it arrived and never paraphrased into "something went wrong". The whole answer
 *  travels with it because a sentence is not the whole of what a door says — `count_revenue_days` names
 *  the days it passed over and the days it could not read in fields no sentence carries. */
async function press(path: string, body: unknown):
  Promise<{ ok: boolean; words: string; answer: unknown }> {
  try {
    const res = await fetch(`${API}/api/v1${path}`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, words: refused(j, "The register refused the press."), answer: null };
    }
    return { ok: true, words: j?.message ?? "Done.", answer: j };
  } catch {
    return { ok: false, words: "The register did not answer.", answer: null };
  }
}

/** What the sweep answers besides its sentence. `days_read + passed_over` is the width of the window and
 *  the desk prints both halves, because a clerk told only how many days were read cannot tell whether the
 *  window was empty or the register was. `refused` is the half the sentence leaves out entirely.
 *  `readings` is one entry per day per money — the register's own list, not a figure it rounded first —
 *  so the desk counts it rather than putting it on the page, and an array here is not something a screen
 *  can print. */
type SweepAnswer = {
  from_day: string; to_day: string; days_read: number; new: number; retaken: number;
  unchanged: number; passed_over: number;
  readings: { day: string; currency: string; state: string; income: string | number }[];
  passed_over_days: string[]; passed_over_days_capped: boolean;
  refused: { day: string; refused: string }[] | null;
};

/**
 * The count the office keeps of the money in (143). Readings of 133's book, one per day per money, and the
 * four cuts each reading carries.
 *
 * Nothing here is worked out by the page. `income_in_window`, every bucket's total and share, the count of
 * days and the gap list all arrive from the doors — a screen that added a column by hand would be a second
 * arithmetic path, and two paths is how a desk shows one figure while the book carries another.
 */
function CountBook({ perm }: { perm: string[] }) {
  const canCount = perm.includes("control.revenue.count");
  const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  const [currency, setCurrency] = useState("TZS");
  const [state, setState] = useState<CountState | null>(null);
  const [rows, setRows] = useState<Reading[]>([]);
  const [countedDays, setCountedDays] = useState(0);
  const [windowIncome, setWindowIncome] = useState<string | number>(0);
  const [cutKind, setCutKind] = useState<CutKind>("account");
  const [cutDays, setCutDays] = useState(30);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [cutIncome, setCutIncome] = useState<string | number>(0);
  const [cutOmitted, setCutOmitted] = useState(0);
  const [cutNote, setCutNote] = useState<string | null>(null);
  const [day, setDay] = useState(yesterday);
  const [note, setNote] = useState("");
  // "" is not a money, it is the other answer the door takes: count every money the book moved income in.
  const [takeMoney, setTakeMoney] = useState("");
  const [sweepFrom, setSweepFrom] = useState(() => new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10));
  const [sweepTo, setSweepTo] = useState(yesterday);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [swept, setSwept] = useState<SweepAnswer | null>(null);
  const [dropFor, setDropFor] = useState<string | null>(null);
  const [dropReason, setDropReason] = useState("");
  // The money, the cut and the days are three pickers a clerk moves in quick succession, and the reply to
  // the earlier question can land after the later one. Only the newest read is allowed to write the screen.
  const pass = useRef(0);

  const load = useCallback(async () => {
    const mine = ++pass.current;
    const [s, b, c] = await Promise.all([
      read<CountState>("/control/revenue/book/state?days=120"),
      read<BookPage>(`/control/revenue/book?currency=${currency}&limit=40`),
      read<CutPage>(
        `/control/revenue/cut/${cutKind}?currency=${currency}`
        + `&from=${new Date(Date.now() - (cutDays - 1) * 86400000).toISOString().slice(0, 10)}`
        + `&to=${new Date().toISOString().slice(0, 10)}&limit=12`)
    ]);
    if (mine !== pass.current) return;
    if (s && s.ok !== false) setState(s);
    if (b && b.ok !== false) {
      setRows(b.rows ?? []); setCountedDays(n(b.counted_days)); setWindowIncome(b.window_income ?? 0);
    }
    if (c && c.ok !== false) {
      setBuckets(c.rows ?? []); setCutIncome(c.income ?? 0);
      setCutOmitted(n(c.omitted)); setCutNote(c.note ?? null);
    }
    // A read the register refused leaves the panel holding whatever it last had, or nothing at all, and a
    // desk that shows an empty register without saying why looks exactly like a book with no readings in it.
    const failed = [s, b, c].find((x) => x && x.ok === false);
    if (failed) setNotice(String((failed as { message?: string }).message ?? "The register did not answer."));
  }, [currency, cutKind, cutDays]);

  useEffect(() => { void load(); }, [load]);

  async function take() {
    setBusy("take"); setNotice(null); setSwept(null);
    const r = await press("/control/revenue/book/take",
      { day, ...(takeMoney ? { currency: takeMoney } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
    setNotice(r.words); setBusy(null);
    if (r.ok) { setNote(""); void load(); }
  }

  async function sweep() {
    setBusy("sweep"); setNotice(null); setSwept(null);
    const r = await press("/control/revenue/book/sweep", { from: sweepFrom, to: sweepTo });
    // The sweep's own numbers belong to the press that made them. They are kept from this answer and from
    // no reload, and any later write closes the panel — a window counted before a new reading would
    // otherwise go on saying what the register looked like a minute ago. A press that was refused has no
    // numbers to keep, and without the sentence below the desk would answer the press with silence.
    setSwept(r.ok ? (r.answer as SweepAnswer) : null);
    if (!r.ok) setNotice(r.words);
    setBusy(null);
    if (r.ok) void load();
  }

  async function discard(id: string) {
    setBusy(id); setNotice(null); setSwept(null);
    const r = await press(`/control/revenue/book/${id}/discard`, { reason: dropReason.trim() });
    setBusy(null);
    setNotice(r.words);
    if (r.ok) { setDropFor(null); setDropReason(""); void load(); }
  }

  const gapDays = (state?.currencies ?? []).flatMap((c) =>
    c.uncounted_count > 0 ? [`${c.currency}: ${c.uncounted_count} (${c.uncounted_days.slice(0, 6).join(", ")})`] : []);

  return (
    <section className="mt-32">
      <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
        The count the office keeps of the money in
      </h2>
      <p className="mt-8 max-w-[78ch] text-sm" style={{ color: "var(--ink-soft)" }}>
        Everything below is read from the book 133 keeps, and kept: one count per day per money, with the
        seat and the minute that took it. The figures above this panel are worked out again on every press
        and answer &ldquo;what do the rows say today&rdquo;; these answer &ldquo;what did the book say on
        the 26th&rdquo;, and can be produced again after the rows underneath move. A day the book moved
        income and nobody counted is listed as a gap rather than quietly read as nothing.
      </p>

      {state && (
        <div className="mt-16 grid gap-12 sm:grid-cols-2">
          {state.currencies.map((c) => (
            <div key={c.currency} className="rounded-card border p-16"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--adm-accent)" }}>
                {c.currency} register
              </p>
              <p className="mt-8 text-lg font-semibold tabular-nums" style={{ color: "var(--ink)" }}>
                {figure(c.income_in_window, c.currency)}
              </p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                counted in the {state.days} days from {state.since}, across {c.snapshots} reading(s)
                {c.first_day ? <> — first {c.first_day}, last {c.last_day}</> : " — none yet"}
              </p>
              <p className="mt-8 text-xs tabular-nums" style={{ color: "var(--ink)" }}>
                {c.snapshots > 0
                  ? <>Yesterday {c.yesterday_counted ? "counted" : "not counted"} · today {c.today_counted ? "counted" : "not counted"}</>
                  : "The register holds no reading in this money yet."}
                {c.revisions > 0 && <> · {c.revisions - c.snapshots} re-take(s)</>}
              </p>
              {c.uncounted_count > 0 && (
                <p className="mt-8 text-xs" style={{ color: "var(--warning)" }}>
                  {c.uncounted_count} day(s) the book moved income and the register never read
                  {c.next_day ? <> — oldest {c.next_day}</> : null}.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {canCount && (
        <div className="mt-16 flex flex-wrap items-end gap-12 rounded-card border p-16"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            Count the day
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)}
              className={FIELD + " mt-4 block"} style={FIELD_STYLE} />
          </label>
          <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            Money to count
            <select value={takeMoney} onChange={(e) => setTakeMoney(e.target.value)}
              className={FIELD + " mt-4 block"} style={FIELD_STYLE}>
              <option value="">Every money the book moved</option>
              <option value="TZS">TZS only</option>
              <option value="USD">USD only</option>
            </select>
          </label>
          <label className="min-w-[220px] flex-1 text-[11px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: "var(--ink-soft)" }}>
            Why a note, if any
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={600}
              placeholder="e.g. the 26th was re-read after the August reversal landed"
              className={FIELD + " mt-4 block w-full"} style={FIELD_STYLE} />
          </label>
          <button type="button" onClick={take} disabled={busy !== null || !day}
            className="waisha-btn rounded-input px-20 py-10 text-xs font-semibold">
            {busy === "take" ? "Reading the book" : "Count it"}
          </button>
          <p className="w-full max-w-[78ch] text-xs" style={{ color: "var(--ink-soft)" }}>
            Leaving the money on &ldquo;every money the book moved&rdquo; counts whatever came in and refuses a
            day that had nothing at all. Naming one money is the only way an honest zero is written — a day the
            office read and found empty is a day the register can say it read, and a zero has to be a zero in a
            money or the row means nothing.
          </p>
          <span className="w-full border-t pt-12 text-[11px] uppercase tracking-[0.12em]"
            style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
            or sweep a window
          </span>
          <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            From
            <input type="date" value={sweepFrom} onChange={(e) => setSweepFrom(e.target.value)}
              className={FIELD + " mt-4 block"} style={FIELD_STYLE} />
          </label>
          <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            To
            <input type="date" value={sweepTo} onChange={(e) => setSweepTo(e.target.value)}
              className={FIELD + " mt-4 block"} style={FIELD_STYLE} />
          </label>
          <button type="button" onClick={sweep} disabled={busy !== null || !sweepFrom || !sweepTo}
            className="rounded-input border px-20 py-10 text-xs font-semibold"
            style={{ borderColor: "var(--adm-accent)", color: "var(--adm-accent)", background: "transparent" }}>
            {busy === "sweep" ? "Counting" : "Count every day in it"}
          </button>
          <p className="w-full max-w-[78ch] text-xs" style={{ color: "var(--ink-soft)" }}>
            A sweep counts every day the book moved income in and re-reads every day already counted, so a
            month that was reported can be proved not to have drifted. Days that already say the same thing
            are left alone; days with nothing to read are reported as passed over, never written as zeros.
          </p>
        </div>
      )}

      {notice && (
        <div className="mt-12 rounded-input px-12 py-8 text-sm" role="status"
          style={{ background: "var(--surface)", border: "1px solid var(--adm-line)", color: "var(--ink)" }}>
          {notice}
        </div>
      )}

      {swept && (
        <div className="mt-12 rounded-card border p-16"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--adm-accent)" }}>
            The window the desk just read
          </p>
          <p className="mt-8 text-sm tabular-nums" style={{ color: "var(--ink)" }}>
            {swept.days_read} day(s) read between {swept.from_day} and {swept.to_day}: {swept.new} new,
            {" "}{swept.retaken} re-taken, {swept.unchanged} already said the same thing — {swept.readings.length}
            {" "}reading(s) in all, because one day can be counted in more than one money.
          </p>
          <p className="mt-8 text-sm tabular-nums" style={{ color: "var(--ink)" }}>
            {swept.passed_over} day(s) in that window had nothing for the register to read. They are passed
            over, not written as zeros, so the figure above is not a count of empty days.
          </p>
          {swept.passed_over_days.length > 0 && (
            <p className="mt-8 text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
              Passed over: {swept.passed_over_days.join(", ")}
              {swept.passed_over_days_capped
                ? " — the register lists the first thirty; the figure above is the whole window."
                : null}
            </p>
          )}
          {(swept.refused ?? []).length > 0 && (
            <p className="mt-8 text-xs tabular-nums" style={{ color: "var(--warning)" }}>
              {(swept.refused ?? []).map((r) => `${r.day} (${r.refused})`).join(", ")} — the door refused
              these, and the register kept what it already held for them. They are not counted as read.
            </p>
          )}
        </div>
      )}

      <div className="mt-16 flex flex-wrap items-end gap-12">
        <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          Money
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}
            className={FIELD + " mt-4 block"} style={FIELD_STYLE}>
            <option value="TZS">TZS</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          Cut the window by
          <select value={cutKind} onChange={(e) => setCutKind(e.target.value as CutKind)}
            className={FIELD + " mt-4 block"} style={FIELD_STYLE}>
            <option value="account">Account</option>
            <option value="source">Kind of movement</option>
            <option value="desk">Desk</option>
            <option value="route">Route</option>
          </select>
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          Days
          <select value={cutDays} onChange={(e) => setCutDays(Number(e.target.value))}
            className={FIELD + " mt-4 block"} style={FIELD_STYLE}>
            {[7, 30, 60].map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
          {countedDays} day(s) counted in this register · {figure(windowIncome, currency)} in the window
        </p>
      </div>

      <div className="mt-12 overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Day</th>
              <th className="p-12">Money</th>
              <th className="p-12 text-right">Income</th>
              <th className="p-12 text-right">Movements</th>
              <th className="p-12 text-right">Legs</th>
              <th className="p-12 text-right">Since undone</th>
              <th className="p-12">Cuts kept</th>
              <th className="p-12">Taken</th>
              <th className="p-12" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>
                  {r.day}
                  <span className="ml-8 text-[10px] uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>
                    {r.ref}{r.retaken ? ` · rev ${r.revisions}` : ""}
                  </span>
                </td>
                <td className="p-12">{r.currency}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {figure(r.income, r.currency)}
                </td>
                <td className="p-12 text-right tabular-nums">{r.postings}</td>
                <td className="p-12 text-right tabular-nums">{r.entries}</td>
                <td className="p-12 text-right tabular-nums"
                  style={{ color: r.reversed_postings > 0 ? "var(--warning)" : "var(--ink-soft)" }}>
                  {r.reversed_postings}
                </td>
                <td className="p-12 text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {r.accounts}·{r.sources}·{r.desks}·{r.roads}
                </td>
                <td className="p-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {r.taken_at}
                  <span className="mt-2 block" style={{ color: "var(--ink)" }}>{r.taken_by_name ?? "—"}</span>
                  {r.note && <span className="mt-2 block normal-case tracking-normal">{r.note}</span>}
                </td>
                <td className="p-12 text-right">
                  {canCount && (
                    <button type="button"
                      onClick={() => { setDropFor(dropFor === r.id ? null : r.id); setDropReason(""); }}
                      disabled={r.postings > 0}
                      title={r.postings > 0
                        ? "The book moved money on this day, so its count is kept forever."
                        : "This day held nothing; the reading can be thrown away."}
                      className="rounded-input border px-10 py-6 text-[11px] font-semibold disabled:opacity-40"
                      style={{ borderColor: "var(--line)", color: "var(--ink-soft)", background: "transparent" }}>
                      {r.postings > 0 ? "kept" : "discard"}
                    </button>
                  )}
                  {dropFor === r.id && (
                    <div className="mt-8 flex flex-col items-end gap-8">
                      <input value={dropReason} onChange={(e) => setDropReason(e.target.value)}
                        placeholder="why it goes (8-600 characters)" maxLength={600}
                        className={FIELD + " w-full text-xs"} style={FIELD_STYLE} />
                      <button type="button" onClick={() => discard(r.id)}
                        disabled={busy !== null || dropReason.trim().length < 8}
                        className="rounded-input px-12 py-6 text-[11px] font-semibold"
                        style={{ background: "var(--danger)", color: "var(--milk)" }}>
                        {busy === r.id ? "Throwing away" : "Confirm"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={9} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                Nothing has been counted in {currency} yet. Name a day above, or sweep a window, and the
                register reads the book once and keeps what it read.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-20 overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Bucket</th>
              <th className="p-12 text-right">Total</th>
              <th className="p-12 text-right">Credit</th>
              <th className="p-12 text-right">Debit</th>
              <th className="p-12 text-right">Movements</th>
              <th className="p-12">Share of the window</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b, i) => (
              <tr key={b.key} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{b.label}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {figure(b.total, currency)}
                </td>
                <td className="p-12 text-right tabular-nums text-xs" style={{ color: "var(--ink-soft)" }}>
                  {n(b.credit).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                </td>
                <td className="p-12 text-right tabular-nums text-xs" style={{ color: "var(--ink-soft)" }}>
                  {n(b.debit).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                </td>
                <td className="p-12 text-right tabular-nums">{b.postings}</td>
                <td className="p-12">
                  <div className="flex items-center gap-8">
                    <div style={{ height: 8, flex: 1, background: "var(--adm-line)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", width: `${Math.max(1, Math.round(n(b.share)))}%`,
                        background: INCOME, opacity: 0.8
                      }} />
                    </div>
                    <span className="w-12 text-right text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                      {b.share === null ? "—" : `${Math.round(n(b.share))}%`}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
            {!buckets.length && (
              <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                The register holds no reading in {currency} for these {cutDays} days, so there is nothing to
                cut. Count a day above first.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-12 max-w-[78ch] text-xs" style={{ color: "var(--ink-soft)" }}>
        The cut adds to {figure(cutIncome, currency)} — the whole window&rsquo;s figure, printed even when
        only the top buckets are listed{cutOmitted > 0 ? ` (${cutOmitted} smaller bucket(s) left off the list, not off the total)` : ""}.
        Whatever the doors could not resolve is filed under a named bucket rather than dropped, and a
        bucket&rsquo;s share is a share of what this desk also claims to have earned.{" "}
        {cutNote}
      </p>
      {gapDays.length > 0 && (
        <p className="mt-12 max-w-[78ch] text-xs" style={{ color: "var(--warning)" }}>
          Days the book moved income and this register never read: {gapDays.join(" · ")}. A month reported
          from a register with a hole in it is part of a month reported as all of it.
        </p>
      )}
    </section>
  );
}

/**
 * The figure the office means to earn (143). Actual against ambition, folded by day, week or month, read
 * from the register above rather than re-derived from the rows underneath it.
 */
function TargetBook({ perm }: { perm: string[] }) {
  const canTarget = perm.includes("control.revenue.target");

  const [currency, setCurrency] = useState("TZS");
  const [kind, setKind] = useState<PeriodKind>("month");
  const [rows, setRows] = useState<Fold[]>([]);
  const [sums, setSums] = useState<{ actual: string | number; target: string | number;
    gap: string | number; attainment: string | number | null }>({ actual: 0, target: 0, gap: 0, attainment: null });
  const [targets, setTargets] = useState<Target[]>([]);
  const [from, setFrom] = useState(() => new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [promiseNote, setPromiseNote] = useState("");
  const [showWithdrawn, setShowWithdrawn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopReason, setStopReason] = useState("");
  // A press re-reads the register by asking for another pass, not by calling the read itself: the read is a
  // closure over the filters, and a press that also changes one of them (a stop opens the stopped rows)
  // would otherwise reload through the old filter — or, once that filter already stood where the press put
  // it, not reload at all, and leave a stopped promise looking live on the board under a notice that said
  // it had stopped.
  const [again, setAgain] = useState(0);
  // Two filter changes in a row start two reads, and the older reply can arrive last — a board that had
  // just opened the stopped promises would be blanked by the answer to the question before it. Each read
  // carries the pass number it started under and only the newest one is allowed to write to the screen.
  // A counter, not a cleanup flag: a cleanup flag is false during the second mount a dev StrictMode tree
  // makes, and the desk then answers the operator with nothing at all.
  const pass = useRef(0);

  const load = useCallback(async () => {
    const mine = ++pass.current;
    const [w, t] = await Promise.all([
      read<WindowPage>(`/control/revenue/window?kind=${kind}&from=${from}&to=${to}&currency=${currency}`),
      read<TargetsPage>(`/control/revenue/targets?currency=${currency}`
        + `&withdrawn=${showWithdrawn ? "true" : "false"}`)
    ]);
    if (mine !== pass.current) return;
    if (w && w.ok !== false) {
      setRows(w.rows ?? []);
      setSums({ actual: w.actual ?? 0, target: w.target ?? 0, gap: w.gap ?? 0,
        attainment: w.attainment ?? null });
    } else if (w?.message) setNotice(w.message);
    if (t && t.ok !== false) setTargets(t.rows ?? []);
    else if (t?.message) setNotice(t.message);
  }, [currency, kind, from, to, showWithdrawn]);

  useEffect(() => { void load(); }, [load, again]);

  async function promise() {
    setBusy("set"); setNotice(null);
    const r = await press("/control/revenue/targets", {
      kind, day, amount, currency, ...(promiseNote.trim() ? { note: promiseNote.trim() } : {})
    });
    setNotice(r.words); setBusy(null);
    if (r.ok) { setAmount(""); setPromiseNote(""); setAgain((a) => a + 1); }
  }

  async function stop(id: string, act: "withdraw" | "discard") {
    setBusy(id); setNotice(null);
    const r = await press(`/control/revenue/targets/${id}/${act}`, { reason: stopReason.trim() });
    setNotice(r.words); setBusy(null);
    if (!r.ok) return;
    setStopping(null); setStopReason("");
    // The door answers a stop with „the month keeps its promise in the register as a stopped one", and the
    // board hides stopped ones until the box is ticked — so without opening it here the sentence and the
    // table underneath it contradicted each other, and the desk that proved the promise looked like it had
    // lost it. Both changes land in one commit, so the register is read once, through the opened filter.
    if (act === "withdraw") setShowWithdrawn(true);
    setAgain((a) => a + 1);
  }

  return (
    <section className="mt-32">
      <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
        What the office meant to earn
      </h2>
      <p className="mt-8 max-w-[78ch] text-sm" style={{ color: "var(--ink-soft)" }}>
        An ambition is a separate register from a count, and a separate duty: the hand that sets the figure
      the office hopes for is not the hand that proves it was reached. A stopped promise keeps its row and
      its reason, because &ldquo;we promised 8M and stopped promising it in March&rdquo; is a fact the
      office has to be able to say — only a target the register never counted against can be thrown away.
      The fold above measures a period only against the promises still standing, so a month whose ambition
      was stopped reads &ldquo;not promised&rdquo; there and keeps its figure on the board underneath; the
      board is the register, the fold is the arithmetic of what the office means now.
      </p>

      <div className="mt-16 flex flex-wrap items-end gap-12">
        <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          Fold by
          <select value={kind} onChange={(e) => setKind(e.target.value as PeriodKind)}
            className={FIELD + " mt-4 block"} style={FIELD_STYLE}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          Money
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}
            className={FIELD + " mt-4 block"} style={FIELD_STYLE}>
            <option value="TZS">TZS</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className={FIELD + " mt-4 block"} style={FIELD_STYLE} />
        </label>
        <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className={FIELD + " mt-4 block"} style={FIELD_STYLE} />
        </label>
        <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
          {figure(sums.actual, currency)} counted against {figure(sums.target, currency)} promised
          {sums.attainment !== null ? ` · ${Math.round(n(sums.attainment))}% reached` : " · nothing promised in this window"}
        </p>
      </div>

      <div className="mt-12 overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Period</th>
              <th className="p-12 text-right">Days counted</th>
              <th className="p-12 text-right">Counted</th>
              <th className="p-12 text-right">Promised</th>
              <th className="p-12 text-right">Gap</th>
              <th className="p-12">Reached</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.period_start} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12" style={{ color: "var(--ink)" }}>
                  {r.label}
                  <span className="mt-2 block text-[10px] uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>
                    {r.period_start} → {r.period_end}
                  </span>
                </td>
                <td className="p-12 text-right tabular-nums">{r.days_counted}</td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {figure(r.actual, r.currency)}
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {r.target ? figure(r.target.amount, r.currency) : "—"}
                  {r.target && (
                    <span className="mt-2 block text-[10px] uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>
                      {r.target.ref}{r.target.raised_by_name ? ` · ${r.target.raised_by_name}` : ""}
                    </span>
                  )}
                </td>
                <td className="p-12 text-right tabular-nums"
                  style={{ color: r.gap === null ? "var(--ink-soft)" : n(r.gap) > 0 ? "var(--warning)" : "var(--success)" }}>
                  {r.gap === null ? "—" : figure(r.gap, r.currency)}
                </td>
                <td className="p-12">
                  {r.attainment === null ? <span style={{ color: "var(--ink-soft)" }}>not promised</span> : (
                    <div className="flex items-center gap-8">
                      <div style={{ height: 8, flex: 1, background: "var(--adm-line)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{
                          height: "100%", width: `${Math.min(100, Math.max(1, Math.round(n(r.attainment))))}%`,
                          background: n(r.attainment) >= 100 ? PROFIT_UP : INCOME, opacity: 0.85
                        }} />
                      </div>
                      <span className="w-12 text-right text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                        {Math.round(n(r.attainment))}%
                      </span>
                    </div>
                  )}
                  {!r.complete && (
                    <p className="mt-6 text-[11px]" style={{ color: "var(--warning)" }}>
                      {r.uncounted_count} day(s) the book moved income here were never counted
                      {r.uncounted_days.slice(0, 4).length ? ` (${r.uncounted_days.slice(0, 4).join(", ")})` : ""}
                      — this figure is part of the period, not all of it.
                    </p>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                The window answers nothing. A fold takes at most 60 periods — narrow it, or fold by month
                rather than by day.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {canTarget && (
        <div className="mt-16 flex flex-wrap items-end gap-12 rounded-card border p-16"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            Promise a
            <select value={kind} onChange={(e) => setKind(e.target.value as PeriodKind)}
              className={FIELD + " mt-4 block"} style={FIELD_STYLE}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </label>
          <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            A period containing
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)}
              className={FIELD + " mt-4 block"} style={FIELD_STYLE} />
          </label>
          <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            {currency} figure
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
              placeholder="0.00" className={FIELD + " mt-4 block w-44 tabular-nums"} style={FIELD_STYLE} />
          </label>
          <label className="min-w-[220px] flex-1 text-[11px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: "var(--ink-soft)" }}>
            Why, if a note
            <input value={promiseNote} onChange={(e) => setPromiseNote(e.target.value)} maxLength={600}
              placeholder="e.g. the CFA bundle renewal expected in November"
              className={FIELD + " mt-4 block w-full"} style={FIELD_STYLE} />
          </label>
          <button type="button" onClick={promise}
            disabled={busy !== null || !day || !amount || Number(amount) <= 0}
            className="waisha-btn rounded-input px-20 py-10 text-xs font-semibold">
            {busy === "set" ? "Writing it down" : "Promise it"}
          </button>
          <p className="w-full max-w-[78ch] text-xs" style={{ color: "var(--ink-soft)" }}>
            Naming a day inside a period is enough — the register works out where that week or month starts
            and says so back, because a week promised on a Wednesday and a week starting on Monday are
            otherwise two different promises wearing one label. Changing a promise means withdrawing it and
            setting the new figure as its own target.
          </p>
        </div>
      )}

      {notice && (
        <div className="mt-12 rounded-input px-12 py-8 text-sm" role="status"
          style={{ background: "var(--surface)", border: "1px solid var(--adm-line)", color: "var(--ink)" }}>
          {notice}
        </div>
      )}

      <div className="mt-16 flex flex-wrap items-center gap-12">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
          The promises on the board ({currency})
        </h3>
        {/* The stopped ones are the read this desk's own copy promises: a seat that may not set an ambition
            still has to be able to ask the register what was once promised and then stopped, because that is
            what an audit is. The door takes `withdrawn` on the view duty, so the box stands on the view duty
            too — the write behind it is the "Promise it" panel above, not this filter. */}
        <label className="flex items-center gap-8 text-[11px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: "var(--ink-soft)" }}>
          <input type="checkbox" checked={showWithdrawn} onChange={(e) => setShowWithdrawn(e.target.checked)} />
          also show stopped ones
        </label>
      </div>
      <div className="mt-12 overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Ref</th>
              <th className="p-12">Period</th>
              <th className="p-12 text-right">Promised</th>
              <th className="p-12 text-right">Counted</th>
              <th className="p-12 text-right">Days left</th>
              <th className="p-12">Status</th>
              <th className="p-12" />
            </tr>
          </thead>
          <tbody>
            {targets.map((t, i) => (
              <tr key={t.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>{t.ref}</td>
                <td className="p-12 text-xs" style={{ color: "var(--ink)" }}>
                  {t.label}
                  <span className="mt-2 block" style={{ color: "var(--ink-soft)" }}>
                    {t.kind} from {t.period_start}{t.note ? ` · ${t.note}` : ""}
                  </span>
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {figure(t.amount, t.currency)}
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {figure(t.actual, t.currency)}
                  <span className="mt-2 block text-[10px]">{t.counted_days} day(s) counted</span>
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {t.in_the_past ? "closed" : t.days_left}
                </td>
                <td className="p-12 text-[11px] uppercase tracking-[0.1em]"
                  style={{ color: t.status === "live" ? "var(--success)" : "var(--ink-soft)" }}>
                  {t.status}
                  {t.withdrawn_at && (
                    <span className="mt-2 block normal-case tracking-normal" style={{ color: "var(--ink-soft)" }}>
                      {t.withdrawn_at} — {t.withdrawn_reason}
                      {t.withdrawn_by_name ? ` (${t.withdrawn_by_name})` : ""}
                    </span>
                  )}
                </td>
                <td className="p-12 text-right">
                  {canTarget && t.status === "live" && (
                    <button type="button"
                      onClick={() => { setStopping(stopping === t.id ? null : t.id); setStopReason(""); }}
                      className="rounded-input border px-10 py-6 text-[11px] font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--ink-soft)", background: "transparent" }}>
                      stop it
                    </button>
                  )}
                  {stopping === t.id && (
                    <div className="mt-8 flex flex-col items-end gap-8">
                      <input value={stopReason} onChange={(e) => setStopReason(e.target.value)}
                        placeholder="why it stops (8-600 characters)" maxLength={600}
                        className={FIELD + " w-full text-xs"} style={FIELD_STYLE} />
                      <div className="flex gap-8">
                        <button type="button" onClick={() => stop(t.id, "withdraw")}
                          disabled={busy !== null || stopReason.trim().length < 8}
                          className="rounded-input px-12 py-6 text-[11px] font-semibold"
                          style={{ background: "var(--adm-accent)", color: "var(--milk)" }}>
                          {busy === t.id ? "Stopping" : "Stop it"}
                        </button>
                        <button type="button" onClick={() => stop(t.id, "discard")}
                          disabled={busy !== null || stopReason.trim().length < 8 || t.counted_days > 0}
                          title={t.counted_days > 0
                            ? "The register has measured this promise; it is kept, stopped rather than erased."
                            : "Never counted against: this was a slip, not a decision."}
                          className="rounded-input px-12 py-6 text-[11px] font-semibold disabled:opacity-40"
                          style={{ background: "var(--danger)", color: "var(--milk)" }}>
                          Throw away
                        </button>
                      </div>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!targets.length && (
              <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                No ambition is filed in {currency}{showWithdrawn ? "" : " that is still standing"}.
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
  // These reports and that register are two separate duties, and a seat may hold either one alone: 143 gives
  // `control.revenue.view` to the auditor and the analyst, neither of which need hold the analytics duty. So a
  // 403 on the P&L may hide the reports, but must not hide a count whose own door answers the seat.
  const mayCount = perm.includes("control.revenue.view");

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
        {forbidden && !mayCount ? (
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
            {!forbidden && (
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
              </>
            )}

            {forbidden && (
              <div className="mt-8 rounded-card border p-20" style={{ borderColor: "var(--line)" }}>
                <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
                  The count the office keeps, without the platform's own reports
                </h1>
                <p className="mt-8 max-w-[78ch] text-sm" style={{ color: "var(--ink-soft)" }}>
                  Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ") || "no platform duty"}.
                  The tiles, the profit and loss, the growth, the forecast, the mix and the cost book are read through the
                  duty <code>control.analytics.view</code>, which this seat does not hold, so they are not shown — an empty
                  table would say the office earned nothing, and that is not what a refused read means. What this seat does
                  hold is <code>control.revenue.view</code>: the days the office has counted, the money each held, and the
                  ambition the month was promised. Both registers stand underneath.
                </p>
              </div>
            )}

            {/* The register 143 keeps is a separate duty from these reports: a seat that may read the P&L
                but not the count gets no panel at all, rather than an empty table claiming nobody has
                counted a day. */}
            {mayCount && (
              <>
                <CountBook perm={perm} />
                <TargetBook perm={perm} />
              </>
            )}

            {!forbidden && (
              <CostBook costs={costs} canRecord={perm.includes("control.costs.manage")} onRecorded={reloadCosts} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
