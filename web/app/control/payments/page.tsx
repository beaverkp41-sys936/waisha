"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The money ledger: every payment record the platform holds, company invoices and
 * seekers' search passes side by side (spec §8; task #104).
 *
 * Two clocks, one table. `recorded_at` is when the desk wrote the row; `money_at` is
 * when it became income — a company invoice when the office marked it paid, a pass
 * when the office confirmed the reference the seeker typed. A row with no money date
 * is real but is not money yet, and this page is the queue that says so.
 */

type Entry = {
  source: string; payment_id: string; reference: string | null;
  payer_name: string; payer_kind: string; detail: string;
  channel: string | null; amount: number; vat: number; currency: string; status: string;
  recorded_at: string; money_at: string | null;
  period_start: string | null; period_end: string | null; note: string | null;
};

const SUB_STATUS = ["paid", "issued", "draft", "void", "refunded"];
const PASS_STATUS = ["live", "awaiting_verification", "rejected", "expired", "cancelled"];
const STATUS_EDGE: Record<string, string> = {
  paid: "var(--success)", approved: "var(--success)", live: "var(--success)",
  issued: "var(--adm-accent)", draft: "var(--ink-soft)", awaiting_verification: "var(--warning)",
  grace: "var(--warning)", void: "var(--danger)", rejected: "var(--danger)",
  expired: "var(--danger)", cancelled: "var(--ink-soft)", refunded: "var(--warning)"
};

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const money = (v: unknown) => `${n(v).toLocaleString("en-US", { maximumFractionDigits: 2 })} TZS`;
const short = (v: unknown) => {
  const x = n(v);
  if (Math.abs(x) >= 1e6) return `${(x / 1e6).toFixed(Math.abs(x) >= 1e7 ? 0 : 1)}M`;
  if (Math.abs(x) >= 1e3) return `${(x / 1e3).toFixed(0)}K`;
  return x.toFixed(0);
};
const stamp = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—";

export default function ControlPaymentsPage() {
  const [me, setMe] = useState<any>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [income, setIncome] = useState(0);
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState("200");
  const [q, setQ] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (f: Record<string, string>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
    const res = await fetch(`${API}/api/v1/control/payments?${params}`, { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    if (!res.ok) { setError("The ledger did not answer."); setLoading(false); return; }
    const j = await res.json();
    setEntries(j.entries ?? []);
    setTotal(n(j.total));
    setIncome(n(j.income));
    setError(null); setLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      // A register row links here with the company's name, so the drill-down arrives
      // already filtered. Read off the location rather than useSearchParams, which
      // would make this page a statically-rendered client page needing a boundary.
      const seeded = new URLSearchParams(window.location.search).get("q") ?? "";
      if (seeded) setQ(seeded);
      load(seeded ? { q: seeded } : {});
    })();
  }, [load]);

  const filters = (over: Record<string, string> = {}) =>
    ({ source, status, from, to, q, limit, ...over });

  const statuses = source === "subscription" ? SUB_STATUS
    : source === "search_pass" ? PASS_STATUS
      : [...SUB_STATUS, ...PASS_STATUS];

  const queued = entries.filter((e) => e.money_at === null && e.status === "awaiting_verification").length;
  const issued = entries.filter((e) => e.money_at === null && e.status === "issued").length;
  const notMoney = entries.filter((e) => e.money_at === null).length;
  const passMoney = entries.reduce((s, e) => s + (e.source === "search_pass" && e.money_at ? n(e.amount) : 0), 0);

  const field = "rounded-input border px-12 py-8 text-sm";
  const fieldStyle = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" } as const;

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between gap-16 px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Money · Every payment record on the platform
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1240px] px-16 py-32">
        {forbidden ? (
          <div className="rounded-card border p-24" style={{ borderColor: "var(--line)" }}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>The ledger is not yours to read</h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ") || "no platform duty"}.
              Money needs the duty <code>control.subscriptions.view</code> — the confirmations desk
              for a seeker's reference is a separate duty, so a role can read this without being able
              to change it.
            </p>
            <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-16">
              <div>
                <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>The money ledger</h1>
                <p className="mt-8 max-w-[80ch] text-sm" style={{ color: "var(--ink-soft)" }}>
                  Nothing here is a payment: the platform does not touch money. Each row is a record
                  the office wrote after money moved elsewhere, and the amount is what that record
                  states. Amounts are VAT-inclusive totals, which is why the confirmed money on this
                  page is larger than net income on the{" "}
                  <Link href="/control/revenue" className="underline" style={{ color: "var(--adm-accent)" }}>reports</Link>.
                </p>
              </div>
              <div className="flex flex-wrap gap-24 text-right">
                {[["Records matched", total], ["On this page", entries.length],
                  ["Confirmed money", short(income)], ["Not money yet", notMoney],
                  ["Awaiting a reference", queued], ["Invoices still issued", issued],
                  ["Pass money on page", short(passMoney)]]
                  .map(([label, value]) => (
                    <div key={String(label)}
                      title={label === "Confirmed money" ? money(income)
                        : label === "Pass money on page" ? money(passMoney) : undefined}>
                      <p className="text-lg font-bold tabular-nums"
                        style={{ color: label === "Not money yet" && notMoney ? "var(--warning)" : "var(--ink)" }}>
                        {value}
                      </p>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                        {label}
                      </p>
                    </div>
                  ))}
              </div>
            </div>

            {(!!queued || !!issued) && (
              <div className="mt-16 rounded-input px-12 py-10 text-sm"
                style={{ background: "color-mix(in srgb, var(--warning) 8%, transparent)", borderLeft: "4px solid var(--warning)" }}>
                {!!queued && (
                  <>
                    {queued} seeker {queued === 1 ? "pass is" : "passes are"} waiting on the office to
                    confirm the reference they typed —{" "}
                  </>
                )}
                <Link href="/control/directory" className="underline font-semibold" style={{ color: "var(--adm-accent)" }}>
                  the confirmation desk
                </Link>
                {" "}holds that queue.{" "}
                {!!issued && <>A further {issued} invoice{issued === 1 ? "" : "s"} here {issued === 1 ? "is" : "are"} still issued rather than paid.</>}
              </div>
            )}

            {error && (
              <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
                {error}
              </div>
            )}

            <div className="mt-24 flex flex-wrap items-end gap-12">
              <div className="flex overflow-hidden rounded-input border" style={{ borderColor: "var(--line)" }}>
                {[["", "Everything"], ["subscription", "Companies"], ["search_pass", "Search passes"]]
                  .map(([v, label]) => (
                    <button key={label} type="button"
                      onClick={() => { setSource(v); setStatus(""); load({ ...filters(), source: v, status: "" }); }}
                      className="px-16 py-8 text-xs font-semibold"
                      style={{
                        background: source === v ? "var(--adm-accent-soft)" : "transparent",
                        color: source === v ? "var(--adm-accent)" : "var(--ink-soft)"
                      }}>
                      {label}
                    </button>
                  ))}
              </div>
              <label className="min-w-[220px] flex-1 text-[11px] font-semibold uppercase tracking-[0.12em]"
                style={{ color: "var(--ink-soft)" }}>
                Who or which reference
                <input value={q} onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") load({ ...filters(), q: q.trim() }); }}
                  placeholder="payer name or reference, then Enter"
                  className={field + " mt-4 block w-full"} style={fieldStyle} />
              </label>
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                Status
                <select value={status}
                  onChange={(e) => { const v = e.target.value; setStatus(v); load({ ...filters(), status: v }); }}
                  className={field + " mt-4 block"} style={fieldStyle}>
                  <option value="">Any</option>
                  {statuses.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
                </select>
              </label>
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                Recorded from
                <input type="date" value={from}
                  onChange={(e) => { const v = e.target.value; setFrom(v); load({ ...filters(), from: v }); }}
                  className={field + " mt-4 block"} style={fieldStyle} />
              </label>
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                to
                <input type="date" value={to}
                  onChange={(e) => { const v = e.target.value; setTo(v); load({ ...filters(), to: v }); }}
                  className={field + " mt-4 block"} style={fieldStyle} />
              </label>
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                Rows
                <select value={limit}
                  onChange={(e) => { const v = e.target.value; setLimit(v); load({ ...filters(), limit: v }); }}
                  className={field + " mt-4 block"} style={fieldStyle}>
                  {["100", "200", "400"].map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <button type="button" className="rounded-input border px-16 py-8 text-xs font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}
                onClick={() => { setSource(""); setStatus(""); setFrom(""); setTo(""); setQ(""); setLimit("200"); load({}); }}>
                Clear
              </button>
            </div>

            <section className="mt-16 overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ minWidth: 1120 }}>
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      <th className="p-12">Who paid</th>
                      <th className="p-12">What the record is for</th>
                      <th className="p-12">Reference</th>
                      <th className="p-12">Channel</th>
                      <th className="p-12 text-right">Amount</th>
                      <th className="p-12 text-right">of which VAT</th>
                      <th className="p-12">Status</th>
                      <th className="p-12">Recorded</th>
                      <th className="p-12">Became money</th>
                      <th className="p-12">Covers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e, i) => (
                      <tr key={`${e.source}-${e.payment_id}`}
                        style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className="p-12 align-top">
                          <p className="font-semibold" style={{ color: "var(--ink)" }}>{e.payer_name}</p>
                          <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.1em]"
                            style={{ color: "var(--ink-soft)" }}>
                            {e.source === "search_pass" ? "search pass · seeker" : e.payer_kind}
                          </p>
                        </td>
                        <td className="p-12 align-top text-xs" style={{ color: "var(--ink)" }}>
                          {e.detail}
                          {e.note && <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>{e.note}</p>}
                        </td>
                        <td className="p-12 align-top">
                          <p className="text-[11px] tabular-nums" style={{ color: e.reference ? "var(--ink)" : "var(--warning)" }}>
                            {e.reference ?? "no reference typed"}
                          </p>
                        </td>
                        <td className="p-12 align-top text-xs" style={{ color: "var(--ink)" }}>{e.channel ?? "—"}</td>
                        <td className="p-12 text-right align-top tabular-nums font-semibold"
                          style={{ color: e.money_at ? "var(--ink)" : "var(--ink-soft)" }} title={money(e.amount)}>
                          {short(e.amount)}
                        </td>
                        <td className="p-12 text-right align-top tabular-nums text-xs" style={{ color: "var(--ink-soft)" }}>
                          {n(e.vat) ? short(e.vat) : "—"}
                        </td>
                        <td className="p-12 align-top">
                          <span className="px-8 py-4 text-[10px] font-bold uppercase"
                            style={{ borderLeft: `4px solid ${STATUS_EDGE[e.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                            {e.status.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="p-12 align-top text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                          {stamp(e.recorded_at)}
                        </td>
                        <td className="p-12 align-top text-[11px] tabular-nums"
                          style={{ color: e.money_at ? "var(--success)" : "var(--warning)" }}>
                          {e.money_at ? stamp(e.money_at) : "not money yet"}
                        </td>
                        <td className="p-12 align-top text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          {e.period_start || e.period_end ? `${day(e.period_start)} → ${day(e.period_end)}` : "—"}
                        </td>
                      </tr>
                    ))}
                    {loading && (
                      <tr><td colSpan={10} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        Reading both money streams…
                      </td></tr>
                    )}
                    {!loading && !entries.length && (
                      <tr><td colSpan={10} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        No record matches this filter. An empty ledger at the start is normal: every
                        row here is written by the office after a payment, or by a seeker typing a
                        reference.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <p className="mt-16 text-xs" style={{ color: "var(--ink-soft)" }}>
              Confirmed money is the sum of the matched rows that have a money date, so it moves when
              you filter and can be read against the page it sits on. Rows without one are kept here
              on purpose — an issued invoice or an unconfirmed reference is the work still to do, and
              hiding it would make this look like a cleaner book than it is.{" "}
              <Link href="/control/subscriptions" className="underline" style={{ color: "var(--adm-accent)" }}>
                Customers
              </Link>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
