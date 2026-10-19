"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The customer register: every company the platform has sold to, priced the way the
 * invoice was priced (spec §8; task #104), and the exits the office recorded against it
 * (task #155).
 *
 * The pricing rule lives in the database, not here. A bundle customer is priced from
 * the bundle and a ladder customer from the rung, because subscriptions.plan_id is
 * NOT NULL and always carries a rung even when the office sold a package — a client
 * that read the plan first would quietly re-price every package customer off the
 * ladder and disagree with its own invoice.
 *
 * Churn lives there too. This desk never adds an exit to an out-of-term company to
 * draw a bigger number: 008's gate reads the licence date and never writes a status,
 * so the two are different sentences and are drawn apart on purpose.
 */

type Row = {
  tenant_id: string; company_name: string; company_type: string; company_status: string;
  subscription_id: string | null; subscription_status: string; billing_cycle: string | null;
  seats_licensed: number; auto_renew: boolean;
  offering: string; offering_name: string; offering_kind: string | null; services: string[];
  monthly_equivalent: number; collected: number; invoices_paid: number;
  period_start: string | null; period_end: string | null; days_to_renewal: number | null;
  licence_expires_at: string | null; grace_ends_at: string | null; trial_ends_at: string | null;
  signed_up_at: string;
};
type Option = { key: string; name: string };

type ExitRow = {
  id: string; subscription_id: string; offering: string; offering_name: string;
  billing_cycle: string | null; seats_licensed: number; monthly_equivalent: number;
  collected: number; prior_status: string; reason_code: string; note: string;
  actor_role: string | null; cancelled_at: string;
};
/** What the definer answers a recorded exit with — the receipt the desk just wrote. */
type ExitReceipt = {
  status: string; cancel_id: string; subscription_id: string; tenant_id: string;
  company_name: string; prior_status: string; offering: string; offering_name: string;
  billing_cycle: string; seats_licensed: number; monthly_equivalent: number;
  collected: number; paid_invoices: number; licence_expires_at: string | null;
  reason_code: string; note: string;
};
type Churn = {
  window_days: number; sold_before_window: number; exit_rate_pct: number | null;
  exits: {
    companies: number; mrr_lost: number; seats_lost: number; paid_before_exit: number;
    avg_tenure_days: number | null; still_cancelled: number; came_back: number;
  };
  by_reason: { reason_code: string; companies: number; mrr_lost: number }[];
  by_month: { month: string; cancellations: number; out_of_term: number; mrr_lost: number }[];
  today: {
    customers: number; live: number; out_of_term: number; cancelled: number; blocked: number;
    closed: number; mrr_live: number; mrr_at_risk: number; seats_live: number;
  };
  recent: (ExitRow & { company_name: string; company_type: string; offering_kind: string | null;
    auto_renew_at_exit: boolean; paid_invoices: number; licence_expires_at: string | null;
    signed_up_at: string | null; came_back: boolean })[];
};

/** The same seven keys the definer accepts, in the words the office uses. */
const EXIT_REASONS: [string, string][] = [
  ["company_decision", "They chose to stop"],
  ["price", "The price"],
  ["went_dormant", "They went quiet and stopped trading"],
  ["service_failure", "What we sold them did not work"],
  ["terms_violation", "Breach of the WAISHA terms"],
  ["payment_default", "They stopped paying"],
  ["other", "Another reason"]
];
const reasonLabel = (k: string) => EXIT_REASONS.find(([v]) => v === k)?.[1] ?? k.replace(/_/g, " ");
const WINDOWS = ["30", "90", "180", "365"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const STATUS_EDGE: Record<string, string> = {
  active: "var(--success)", trial: "var(--adm-accent)", pending: "var(--warning)",
  grace: "var(--warning)", expired: "var(--danger)", suspended: "var(--danger)",
  cancelled: "var(--ink-soft)"
};
const STATUSES = ["active", "trial", "pending", "grace", "expired", "suspended", "cancelled"];
const SERVICE_EDGE: Record<string, string> = {
  transport: "var(--adm-accent)", cfa: "var(--success)", office: "var(--warning)"
};

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const money = (v: unknown) => `${n(v).toLocaleString("en-US", { maximumFractionDigits: 0 })} TZS`;
const short = (v: unknown) => {
  const x = n(v);
  if (Math.abs(x) >= 1e6) return `${(x / 1e6).toFixed(Math.abs(x) >= 1e7 ? 0 : 1)}M`;
  if (Math.abs(x) >= 1e3) return `${(x / 1e3).toFixed(0)}K`;
  return x.toFixed(0);
};
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—";
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
/** "2026-07-01" is a month bucket, not an instant: cut it by hand so no timezone can
 *  shift a bar into the next one. */
const monthLabel = (m: string) => {
  const [y, mo] = m.split("-");
  return `${MONTHS[Number(mo) - 1] ?? mo} ${String(y).slice(2)}`;
};

/** Days-to-renewal is the number the desk acts on, so it says which action it wants. */
function RenewalCell({ row }: { row: Row }) {
  const d = row.days_to_renewal;
  const tone = d === null ? "var(--ink-soft)"
    : d < 0 ? "var(--danger)" : d <= 7 ? "var(--danger)"
      : d <= 30 ? "var(--warning)" : "var(--success)";
  const words = d === null ? "no period recorded"
    : d < 0 ? `${Math.abs(d)} d overdue`
      : d === 0 ? "ends today" : `in ${d} d`;
  return (
    <td className="p-12 align-top">
      <p className="text-xs tabular-nums" style={{ color: "var(--ink)" }}>{day(row.period_end)}</p>
      <p className="mt-4 text-[11px] font-semibold tabular-nums" style={{ color: tone }}>{words}</p>
      {row.subscription_status === "grace" && row.grace_ends_at && (
        <p className="text-[10px]" style={{ color: "var(--warning)" }}>
          grace to {day(row.grace_ends_at)}
        </p>
      )}
      {row.subscription_status === "trial" && row.trial_ends_at && (
        <p className="text-[10px]" style={{ color: "var(--adm-accent)" }}>
          trial to {day(row.trial_ends_at)}
        </p>
      )}
    </td>
  );
}

/** One number with the sentence that says what it counts. */
function Figure({ label, value, sub, tone, title }: {
  label: string; value: string | number; sub?: string; tone?: string; title?: string;
}) {
  return (
    <div title={title}>
      <p className="text-lg font-bold tabular-nums" style={{ color: tone ?? "var(--ink)" }}>{value}</p>
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
        {label}
      </p>
      {!!sub && <p className="mt-2 text-[10px]" style={{ color: "var(--ink-soft)" }}>{sub}</p>}
    </div>
  );
}

export default function ControlSubscriptionsPage() {
  const [me, setMe] = useState<any>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [mrr, setMrr] = useState(0);
  const [packages, setPackages] = useState<Option[]>([]);
  const [rungs, setRungs] = useState<Option[]>([]);
  const [status, setStatus] = useState("");
  const [cycle, setCycle] = useState("");
  const [offering, setOffering] = useState("");
  const [dueWithin, setDueWithin] = useState("");
  const [limit, setLimit] = useState("200");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [canManage, setCanManage] = useState(false);

  // The exits half of the desk: one company, its reason, its history.
  const [churn, setChurn] = useState<Churn | null>(null);
  const [churnDays, setChurnDays] = useState("90");
  const [churnError, setChurnError] = useState<string | null>(null);
  const [exitFor, setExitFor] = useState<Row | null>(null);
  const [reason, setReason] = useState("price");
  const [note, setNote] = useState("");
  const [exitHistory, setExitHistory] = useState<ExitRow[]>([]);
  const [exitError, setExitError] = useState<string | null>(null);
  const [exitOutcome, setExitOutcome] = useState<ExitReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  // Which company's dialog is open, readable inside a slow write. The register and the
  // churn panel are shared, so a response that lands after the desk moved on must paint
  // nothing over the company that is now open.
  const openId = useRef<string | null>(null);

  // Filters arrive as an explicit set rather than being read from state inside the
  // fetch, so the callback has no dependencies and the mount effect runs once.
  const load = useCallback(async (f: Record<string, string>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
    const res = await fetch(`${API}/api/v1/control/subscriptions?${params}`, { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    if (!res.ok) { setError("The register did not answer."); setLoading(false); return; }
    const j = await res.json();
    setRows(j.companies ?? []);
    setTotal(n(j.total));
    setMrr(n(j.mrr));
    // The register reads the same matrix the POST checks, so this is the only truth the
    // desk needs about whether to draw an exit control at all.
    setCanManage(j.can_manage === true);
    setError(null); setLoading(false);
  }, []);

  const loadChurn = useCallback(async (days: string) => {
    const res = await fetch(`${API}/api/v1/control/churn?days=${days}`, { credentials: "include" });
    if (!res.ok) {
      setChurnError(res.status === 403
        ? "Your duty does not include reading who left." : "The churn reader did not answer.");
      return;
    }
    setChurn(await res.json());
    setChurnError(null);
  }, []);

  const loadExits = useCallback(async (tenantId: string) => {
    const res = await fetch(`${API}/api/v1/control/churn/exits/${tenantId}`, { credentials: "include" });
    setExitHistory(res.ok ? (await res.json()).exits ?? [] : []);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      load({});
      loadChurn("90");
      // Both lists are the public buying catalog — the same rows the applicant sees at
      // the licence gate — so filtering by an offering needs no extra duty.
      const [g, p] = await Promise.all([
        fetch(`${API}/api/v1/content/service-groups`, { credentials: "include" }),
        fetch(`${API}/api/v1/control/plans-public`)
      ]);
      if (g.ok) setPackages(await g.json());
      if (p.ok) setRungs(await p.json());
    })();
  }, [load, loadChurn]);

  const openExit = (row: Row | null) => {
    openId.current = row?.subscription_id ?? null;
    setExitFor(row);
    setExitError(null);
    setExitOutcome(null);
    setNote("");
    setArmed(null);
    setExitHistory([]);
    if (row) { void loadExits(row.tenant_id); }
  };

  /** Arm on the first tap, write on the second: this ends a company's sale. */
  const twoTap = (key: string, run: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    run();
  };

  async function recordExit() {
    const row = exitFor;
    if (!row?.subscription_id) return;
    const id = row.subscription_id;
    setBusy(true); setExitError(null); setExitOutcome(null);
    try {
      const res = await fetch(`${API}/api/v1/control/subscriptions/${id}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ reasonCode: reason, note: note.trim() })
      });
      const j = await res.json().catch(() => ({}));
      // Both reads are worth doing whatever the answer was: a refusal may still have been
      // a race with another seat, and the register is the only thing that says which.
      await load(filters());
      void loadChurn(churnDays);
      void loadExits(row.tenant_id);
      if (openId.current !== id) return;
      if (!res.ok) {
        const hints = (j?.error?.details ?? []).map((d: any) => d.message).join(" · ");
        setExitError([j?.error?.message ?? "The exit was refused.", hints]
          .filter(Boolean).join(" — "));
      } else {
        setExitOutcome(j as ExitReceipt);
      }
      setArmed(null);
    } finally { setBusy(false); }
  }

  const seats = rows.reduce((s, r) => s + r.seats_licensed, 0);
  const collected = rows.reduce((s, r) => s + n(r.collected), 0);
  const due30 = rows.filter((r) => r.days_to_renewal !== null && r.days_to_renewal <= 30).length;
  const onPackage = rows.filter((r) => r.offering_kind === "bundle").length;

  const field = "rounded-input border px-12 py-8 text-sm";
  const fieldStyle = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" } as const;

  const SELECTS: [string, string, string, (v: string) => void, string[]][] = [
    ["status", "Subscription", status, setStatus, STATUSES],
    ["cycle", "Cycle", cycle, setCycle, ["monthly", "quarterly", "annual"]],
    ["dueWithin", "Due within (days)", dueWithin, setDueWithin, ["7", "30", "60", "90"]],
    ["limit", "Rows", limit, setLimit, ["100", "200", "400"]]
  ];

  const filters = (over: Record<string, string> = {}) =>
    ({ status, cycle, offering, q: search, dueWithin, limit, ...over });

  // The dialog opens on a snapshot of one row, and the write rewrites that row: after an
  // exit the register line is cancelled, so take the live row when it is still on the page.
  const exRow: Row | null = exitFor
    ? (rows.find(r => r.subscription_id === exitFor.subscription_id) ?? exitFor)
    : null;
  const exEnded = exRow?.subscription_status === "cancelled";
  const tooShort = note.trim().length < 8;
  const maxReason = Math.max(1, ...(churn?.by_reason ?? []).map(x => x.companies));
  const maxMonth = Math.max(1, ...(churn?.by_month ?? [])
    .map(x => Math.max(x.cancellations, x.out_of_term)));

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between gap-16 px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Customers · Who the platform is selling to
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1240px] px-16 py-32">
        {forbidden ? (
          <div className="rounded-card border p-24" style={{ borderColor: "var(--line)" }}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>This register is not yours to read</h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ") || "no platform duty"}.
              The customer register needs the duty <code>control.subscriptions.view</code>; the panel itself stays
              open to you.
            </p>
            <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-16">
              <div>
                <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Every customer on the system</h1>
                <p className="mt-8 max-w-[78ch] text-sm" style={{ color: "var(--ink-soft)" }}>
                  One row per company with a subscription, priced at what the office actually
                  sold it — a WAISHA package at the package price, a plan-ladder customer at the
                  rung. Seekers are not here: they buy search passes, not subscriptions, and
                  their money is on the{" "}
                  <Link href="/control/payments" className="underline" style={{ color: "var(--adm-accent)" }}>
                    money ledger
                  </Link>.
                </p>
              </div>
              <div className="flex flex-wrap gap-24 text-right">
                {[["Companies matched", total], ["On this page", rows.length],
                  ["MRR of the match", short(mrr)], ["Seats licensed", seats],
                  ["Collected on page", short(collected)], ["Renew within 30 d", due30],
                  ["Sold as a package", onPackage]]
                  .map(([label, value]) => (
                    <div key={String(label)} title={label === "MRR of the match" || label === "Collected on page"
                      ? money(label === "MRR of the match" ? mrr : collected) : undefined}>
                      <p className="text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>{value}</p>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                        {label}
                      </p>
                    </div>
                  ))}
              </div>
            </div>

            {error && (
              <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
                {error}
              </div>
            )}

            <div className="mt-24 flex flex-wrap items-end gap-12">
              <label className="min-w-[240px] flex-1 text-[11px] font-semibold uppercase tracking-[0.12em]"
                style={{ color: "var(--ink-soft)" }}>
                Company
                <input value={q} onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { setSearch(q.trim()); load(filters({ q: q.trim() })); } }}
                  placeholder="name, then Enter"
                  className={field + " mt-4 block w-full"} style={fieldStyle} />
              </label>
              {SELECTS.map(([param, label, value, set, options]) => (
                <label key={param} className="text-[11px] font-semibold uppercase tracking-[0.12em]"
                  style={{ color: "var(--ink-soft)" }}>
                  {label}
                  <select value={value}
                    onChange={(e) => { const v = e.target.value; set(v); load({ ...filters(), [param]: v }); }}
                    className={field + " mt-4 block"} style={fieldStyle}>
                    <option value="">Any</option>
                    {options.map((o) => <option key={o} value={o}>{String(o).replace(/_/g, " ")}</option>)}
                  </select>
                </label>
              ))}
              <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                Sold as
                <select value={offering}
                  onChange={(e) => { const v = e.target.value; setOffering(v); load({ ...filters(), offering: v }); }}
                  className={field + " mt-4 block"} style={fieldStyle}>
                  <option value="">Every offering</option>
                  <option value="bundles">WAISHA packages only</option>
                  <option value="ladder">Plan ladder only</option>
                  {!!packages.length && (
                    <optgroup label="A package">
                      {packages.map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
                    </optgroup>
                  )}
                  {!!rungs.length && (
                    <optgroup label="A rung">
                      {rungs.map((p: any) => <option key={p.key} value={p.key}>{p.name}</option>)}
                    </optgroup>
                  )}
                </select>
              </label>
              <button type="button" className="rounded-input border px-16 py-8 text-xs font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}
                onClick={() => { setQ(""); setSearch(""); setStatus(""); setCycle(""); setOffering(""); setDueWithin(""); setLimit("200"); load({ status: "", cycle: "", offering: "", q: "", dueWithin: "", limit: "200" }); }}>
                Clear filters
              </button>
            </div>

            <section className="mt-16 overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ minWidth: 1000 }}>
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      <th className="p-12">Company</th>
                      <th className="p-12">Subscription</th>
                      <th className="p-12">What was sold</th>
                      <th className="p-12">Cycle</th>
                      <th className="p-12 text-right">Seats</th>
                      <th className="p-12 text-right">Per month</th>
                      <th className="p-12 text-right">Collected</th>
                      <th className="p-12">Renews</th>
                      <th className="p-12">Licence</th>
                      <th className="p-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.subscription_id ?? r.tenant_id}
                        style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className="p-12 align-top">
                          <p className="font-semibold" style={{ color: "var(--ink)" }}>{r.company_name}</p>
                          <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                            {r.company_type} · joined {day(r.signed_up_at)}
                          </p>
                        </td>
                        <td className="p-12 align-top">
                          <span className="px-8 py-4 text-[10px] font-bold uppercase"
                            style={{ borderLeft: `4px solid ${STATUS_EDGE[r.subscription_status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                            {r.subscription_status}
                          </span>
                          <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {r.auto_renew ? "renews itself" : "renews only when the office acts"}
                          </p>
                        </td>
                        <td className="p-12 align-top">
                          <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>{r.offering_name}</p>
                          <p className="mt-4 text-[10px] uppercase tracking-[0.1em]"
                            style={{ color: r.offering_kind === "bundle" ? "var(--adm-accent)" : "var(--ink-soft)" }}>
                            {r.offering_kind === "bundle" ? "WAISHA package" : r.offering_kind === "plan" ? "plan ladder" : "unpriced"}
                          </p>
                          {!!(r.services ?? []).length && (
                            <div className="mt-6 flex flex-wrap gap-4">
                              {r.services.map((s) => (
                                <span key={s} className="px-6 py-2 text-[10px] font-bold uppercase"
                                  style={{ color: SERVICE_EDGE[s] ?? "var(--ink-soft)", border: `1px solid ${SERVICE_EDGE[s] ?? "var(--line)"}`, borderRadius: 4 }}>
                                  {s}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="p-12 align-top text-xs" style={{ color: "var(--ink)" }}>{r.billing_cycle ?? "—"}</td>
                        <td className="p-12 text-right align-top tabular-nums" style={{ color: "var(--ink)" }}>{r.seats_licensed}</td>
                        <td className="p-12 text-right align-top tabular-nums font-semibold" style={{ color: "var(--ink)" }}
                          title={money(r.monthly_equivalent)}>
                          {short(r.monthly_equivalent)}
                        </td>
                        <td className="p-12 text-right align-top tabular-nums" style={{ color: "var(--ink-soft)" }}
                          title={money(r.collected)}>
                          <span style={{ color: n(r.collected) ? "var(--ink)" : "var(--ink-soft)" }}>{short(r.collected)}</span>
                          <p className="text-[10px]">{r.invoices_paid} paid invoice{r.invoices_paid === 1 ? "" : "s"}</p>
                        </td>
                        <RenewalCell row={r} />
                        <td className="p-12 align-top text-xs" style={{ color: "var(--ink-soft)" }}>
                          <p>{day(r.licence_expires_at)}</p>
                          <p className="mt-4 text-[10px] font-semibold uppercase"
                            style={{ color: STATUS_EDGE[r.company_status] ?? "var(--ink-soft)" }}>
                            {r.company_status}
                          </p>
                        </td>
                        <td className="p-12 text-right align-top">
                          <div className="flex flex-col items-end gap-6">
                            <Link href={`/control/payments?q=${encodeURIComponent(r.company_name)}`}
                              className="inline-block rounded-input border px-12 py-6 text-[11px] font-semibold"
                              style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                              Money
                            </Link>
                            {r.subscription_id && r.subscription_status !== "cancelled" && canManage && (
                              <button type="button" onClick={() => openExit(r)}
                                className="inline-block rounded-input border px-12 py-6 text-[11px] font-semibold"
                                style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                                End sale
                              </button>
                            )}
                            {r.subscription_status === "cancelled" && (
                              <button type="button" onClick={() => openExit(r)}
                                className="inline-block rounded-input border px-12 py-6 text-[11px] font-semibold"
                                style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                                Exit on file
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {loading && (
                      <tr><td colSpan={10} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        Reading every subscription…
                      </td></tr>
                    )}
                    {!loading && !rows.length && (
                      <tr><td colSpan={10} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        No company matches this filter. A company that has signed up but never been
                        activated has no subscription row yet, so it will not appear here — look for
                        it on the <Link href="/control/tenants" className="underline" style={{ color: "var(--adm-accent)" }}>tenants desk</Link>.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-32 overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
              <div className="flex flex-wrap items-end justify-between gap-16 border-b px-20 py-16"
                style={{ borderColor: "var(--line)" }}>
                <div>
                  <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>Who left</h2>
                  <p className="mt-6 max-w-[92ch] text-xs" style={{ color: "var(--ink-soft)" }}>
                    An exit is a person on this desk writing down that a company is gone and why —
                    the only churn figure this system can state as a fact. A company whose term date
                    has passed with nothing written is <strong>out of term</strong>, not an exit:
                    some of them will renew. The two are counted apart on this page and never added
                    together, because one needs a phone call and the other needs a decision.
                  </p>
                </div>
                <label className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                  Window
                  <select value={churnDays}
                    onChange={(e) => { const v = e.target.value; setChurnDays(v); loadChurn(v); }}
                    className={field + " mt-4 block"} style={fieldStyle}>
                    {WINDOWS.map((w) => <option key={w} value={w}>{w} days</option>)}
                  </select>
                </label>
              </div>

              {churnError && (
                <p role="alert" className="m-20 rounded-input px-12 py-8 text-xs"
                  style={{ borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
                  {churnError}
                </p>
              )}
              {!churn && !churnError && (
                <p className="m-20 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the exit register…</p>
              )}

              {churn && (
                <div className="px-20 py-16">
                  <div className="flex flex-wrap gap-24">
                    <Figure label="Exits recorded" value={churn.exits.companies}
                      tone={churn.exits.companies ? "var(--danger)" : "var(--ink)"}
                      sub={`${churn.exits.still_cancelled} still gone · ${churn.exits.came_back} came back`} />
                    <Figure label="Monthly lost" value={short(churn.exits.mrr_lost)}
                      title={money(churn.exits.mrr_lost)}
                      sub="what they were paying, frozen at the exit" />
                    <Figure label="Exit rate" value={churn.exit_rate_pct === null ? "no base"
                      : `${churn.exit_rate_pct}%`}
                      title={`of the ${churn.sold_before_window} subscriptions already open at the start of the window`}
                      sub={churn.exit_rate_pct === null
                        ? "nothing was sold before this window"
                        : `of ${churn.sold_before_window} open at the start`} />
                    <Figure label="Seats lost" value={churn.exits.seats_lost}
                      sub={churn.exits.avg_tenure_days === null
                        ? "no exit has a term length yet"
                        : `average tenure ${churn.exits.avg_tenure_days} d`} />
                    <Figure label="Paid before leaving" value={short(churn.exits.paid_before_exit)}
                      title={money(churn.exits.paid_before_exit)}
                      sub="the system moves no money back" />
                    <Figure label="Past their term" value={churn.today.out_of_term}
                      tone={churn.today.out_of_term ? "var(--warning)" : "var(--ink)"}
                      title={`${money(churn.today.mrr_at_risk)} a month on companies still marked active`}
                      sub={`${short(churn.today.mrr_at_risk)} a month at risk`} />
                  </div>

                  <div className="mt-24 grid gap-24 md:grid-cols-2">
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                        Why they said they left
                      </p>
                      {!churn.by_reason.length && (
                        <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                          No exit has been recorded on this window. That is not the same as nobody
                          having left — {churn.today.out_of_term} compan{churn.today.out_of_term === 1 ? "y is" : "ies are"}{" "}
                          past their term with nothing written down.
                        </p>
                      )}
                      <div className="mt-8 space-y-8">
                        {churn.by_reason.map((r) => (
                          <div key={r.reason_code}>
                            <div className="flex items-baseline justify-between gap-8 text-xs">
                              <span className="font-semibold" style={{ color: "var(--ink)" }}>
                                {reasonLabel(r.reason_code)}
                              </span>
                              <span className="tabular-nums" style={{ color: "var(--ink-soft)" }}>
                                {r.companies} · {short(r.mrr_lost)}/mo
                              </span>
                            </div>
                            <div className="mt-4 h-6 overflow-hidden rounded-full" style={{ background: "var(--milk-deep)" }}>
                              <div className="h-full rounded-full"
                                style={{ width: `${Math.max(4, 100 * r.companies / maxReason)}%`, background: "var(--danger)" }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                        Month by month
                      </p>
                      <div className="mt-8 flex flex-wrap items-end gap-12">
                        {churn.by_month.map((m) => (
                          <div key={m.month} className="w-[52px] text-center"
                            title={`${m.month}: ${m.cancellations} recorded exit${m.cancellations === 1 ? "" : "s"} `
                              + `(${money(m.mrr_lost)} a month), ${m.out_of_term} fell out of term`}>
                            <p className="text-[10px] font-bold tabular-nums" style={{ color: "var(--danger)" }}>
                              {m.cancellations || ""}
                            </p>
                            <div className="mx-auto flex h-[72px] w-[18px] items-end justify-center rounded-sm"
                              style={{ background: "var(--milk-deep)" }}>
                              <div className="w-full" style={{
                                height: `${100 * m.cancellations / maxMonth}%`,
                                minHeight: m.cancellations ? 3 : 0,
                                background: "var(--danger)"
                              }} />
                            </div>
                            <div className="mx-auto mt-2 h-[26px] w-[18px] rounded-sm"
                              style={{ background: "var(--milk-deep)" }}>
                              <div className="w-full rounded-sm" style={{
                                height: `${100 * m.out_of_term / maxMonth}%`,
                                minHeight: m.out_of_term ? 3 : 0,
                                background: "var(--warning)"
                              }} />
                            </div>
                            <p className="mt-2 text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {monthLabel(m.month)}
                            </p>
                          </div>
                        ))}
                      </div>
                      <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        <span style={{ color: "var(--danger)" }}>■</span> written by this desk ·{" "}
                        <span style={{ color: "var(--warning)" }}>■</span> licence date passed with
                        nothing written — different columns, different calls, never one number
                      </p>
                    </div>
                  </div>

                  <div className="mt-24 flex flex-wrap items-center gap-24 border-t pt-16" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      Today on the register
                    </p>
                    {[["Customers sold", churn.today.customers, "var(--ink)"],
                      ["Live", churn.today.live, "var(--success)"],
                      ["Out of term", churn.today.out_of_term, "var(--warning)"],
                      ["Cancelled", churn.today.cancelled, "var(--ink-soft)"],
                      ["Blocked", churn.today.blocked, "var(--danger)"],
                      ["Closed", churn.today.closed, "var(--danger)"]]
                      .map(([label, value, tone]) => (
                        <span key={String(label)} className="text-xs" style={{ color: "var(--ink-soft)" }}>
                          <span className="mr-6 text-sm font-bold tabular-nums" style={{ color: String(tone) }}>
                            {n(value)}
                          </span>
                          {label}
                        </span>
                      ))}
                    <span className="text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}
                      title={`${money(churn.today.mrr_live)} a month live, ${money(churn.today.mrr_at_risk)} a month past its term`}>
                      {short(churn.today.mrr_live)}/mo live · {short(churn.today.mrr_at_risk)}/mo at risk ·{" "}
                      {churn.today.seats_live} seats
                    </span>
                  </div>

                  <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    Blocked and closed are the tenants desk's sanctions, not customer decisions, so they
                    are not churn either; sold = live + out of term + cancelled, and a blocked or closed
                    company sits inside one of those three.
                  </p>

                  {!!churn.recent.length && (
                    <div className="mt-24">
                      <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                        The exits themselves
                      </p>
                      <div className="mt-8 space-y-8">
                        {churn.recent.slice(0, 12).map((x) => (
                          <div key={x.id} className="rounded-input px-12 py-8"
                            style={{ borderLeft: `4px solid ${x.came_back ? "var(--success)" : "var(--danger)"}`, background: "var(--milk)" }}>
                            <div className="flex flex-wrap items-baseline justify-between gap-8">
                              <Link href={`/control/subscriptions?q=${encodeURIComponent(x.company_name)}`}
                                className="text-sm font-semibold underline" style={{ color: "var(--ink)" }}>
                                {x.company_name}
                              </Link>
                              <span className="text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                                {when(x.cancelled_at)} · {x.actor_role?.replace(/_/g, " ") ?? "a seat on the desk"}
                              </span>
                            </div>
                            <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              {x.offering_name} · {x.billing_cycle ?? "—"} · {n(x.seats_licensed)} seats ·{" "}
                              {short(x.monthly_equivalent)}/mo lost · paid {short(x.collected)} over{" "}
                              {n(x.paid_invoices)} invoice{x.paid_invoices === 1 ? "" : "s"}
                              {x.came_back ? " · back on the register again" : ""}
                            </p>
                            <p className="mt-4 text-xs" style={{ color: "var(--ink)" }}>
                              <span className="font-semibold uppercase tracking-[0.08em]"
                                style={{ color: x.came_back ? "var(--success)" : "var(--danger)" }}>
                                {reasonLabel(x.reason_code)}
                              </span>
                              {" — "}
                              <span title={x.note}>{x.note.length > 180 ? `${x.note.slice(0, 180)}…` : x.note}</span>
                            </p>
                          </div>
                        ))}
                      </div>
                      {churn.recent.length > 12 && (
                        <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          Showing the 12 newest of {churn.recent.length} the reader returned (it keeps the
                          last 40 on this window).
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            <p className="mt-16 text-xs" style={{ color: "var(--ink-soft)" }}>
              Total monthly equivalent is the sum of the matched rows, so a filter that narrows the
              register narrows the figure with it — that is the point of showing it beside the count.
              It is a rate, not money received: collected is what the office confirmed as paid, and
              both are on this page because a renewal conversation needs them together.
            </p>
          </>
        )}
      </main>

      {exRow && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-16"
          style={{ background: "rgba(2, 4, 8, 0.7)" }}>
          <div className="max-h-[88vh] w-full max-w-[640px] overflow-y-auto rounded-modal bg-surface p-24"
            style={{ border: "1px solid var(--line)" }}>
            <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              {exEnded ? "This sale is already ended" : "End the sale with this company"}
            </h2>
            <p className="mt-4 text-sm" style={{ color: "var(--ink-soft)" }}>
              {exRow.company_name} · {exRow.company_type} · {exRow.offering_name}
              {" · "}{money(exRow.monthly_equivalent)} a month
            </p>

            <div className="mt-16 grid grid-cols-2 gap-12 sm:grid-cols-4">
              <Figure label="Subscription" value={exRow.subscription_status}
                tone={STATUS_EDGE[exRow.subscription_status] ?? "var(--ink)"} />
              <Figure label="Collected" value={short(exRow.collected)}
                title={money(exRow.collected)} sub={`${exRow.invoices_paid} paid`} />
              <Figure label="Renews" value={exRow.days_to_renewal === null ? "—"
                : `${exRow.days_to_renewal} d`} sub={day(exRow.period_end)} />
              <Figure label="Licence to" value={day(exRow.licence_expires_at)}
                sub={exRow.company_status} />
            </div>

            <p className="mt-16 text-xs" style={{ color: "var(--ink-soft)" }}>
              Recording an exit marks the subscription cancelled and stops auto-renew. It takes back
              nothing the company has paid — {money(exRow.collected)} stays on the{" "}
              <Link href={`/control/payments?q=${encodeURIComponent(exRow.company_name)}`}
                className="underline" style={{ color: "var(--adm-accent)" }}>ledger</Link> — and it does
              not move the licence date, block the portal or tell the company: those are the{" "}
              <Link href="/control/tenants" className="underline" style={{ color: "var(--adm-accent)" }}>
                tenants desk</Link>’s acts, on their own duty and their own clock.
            </p>

            {!exEnded && (
              <div className="mt-16 space-y-12">
                <label className="block">
                  <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]"
                    style={{ color: "var(--ink-soft)" }}>
                    Why they are leaving
                  </span>
                  <select value={reason} onChange={(e) => setReason(e.target.value)}
                    className="w-full rounded-input border px-12 py-8 text-sm"
                    style={fieldStyle}>
                    {EXIT_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]"
                    style={{ color: "var(--ink-soft)" }}>
                    What the register should say (8–600 characters)
                  </span>
                  <textarea value={note} rows={4}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Who said it, in their words, and what would bring them back. This is the sentence a renewal call reads first."
                    className="w-full rounded-input border px-12 py-8 text-sm font-sans"
                    style={fieldStyle} />
                  <span className="mt-2 block text-[10px]" style={{ color: tooShort ? "var(--warning)" : "var(--ink-soft)" }}>
                    {note.trim().length}/600{tooShort ? " · a one-word reason cannot be read back in a year" : ""}
                  </span>
                </label>
              </div>
            )}

            {exitError && (
              <p role="alert" className="mt-12 rounded-input px-12 py-8 text-xs"
                style={{ borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
                {exitError}
              </p>
            )}
            {exitOutcome && (
              <div role="status" className="mt-12 rounded-input px-12 py-8"
                style={{ borderLeft: "4px solid var(--success)", color: "var(--ink)" }}>
                <p className="text-sm font-semibold">Exit recorded — the register reads it as cancelled.</p>
                <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {money(exitOutcome.monthly_equivalent)} a month off the recurring line ·{" "}
                  {reasonLabel(exitOutcome.reason_code)} · receipt {String(exitOutcome.cancel_id).slice(0, 8)}
                </p>
                <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Their {money(exitOutcome.collected)} across {exitOutcome.paid_invoices} paid invoice
                  {exitOutcome.paid_invoices === 1 ? "" : "s"} stays on the ledger — this system moves no money back.
                </p>
              </div>
            )}

            <div className="mt-16 border-t pt-16" style={{ borderColor: "var(--line)" }}>
              <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Exits recorded against this company
              </p>
              {!exitHistory.length && (
                <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  None. Whatever happens at the licence gate, this is the first time the office has
                  written this company off.
                </p>
              )}
              <div className="mt-8 space-y-8">
                {exitHistory.map((x) => (
                  <div key={x.id} className="rounded-input px-12 py-8"
                    style={{ borderLeft: "4px solid var(--ink-soft)", background: "var(--milk)" }}>
                    <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>
                      {when(x.cancelled_at)} · {reasonLabel(x.reason_code)} ·{" "}
                      {short(x.monthly_equivalent)}/mo · {x.offering_name} ({x.billing_cycle ?? "—"})
                    </p>
                    <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      {x.prior_status} at the time · paid {short(x.collected)} · {x.actor_role?.replace(/_/g, " ") ?? "a seat on the desk"}
                    </p>
                    <p className="mt-4 text-[11px]" style={{ color: "var(--ink)" }}>{x.note}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-16 flex gap-8">
              {!exEnded && (
                <button type="button" disabled={busy || tooShort}
                  onClick={twoTap(`exit-${exRow.subscription_id}`, recordExit)}
                  className="flex-1 rounded-input py-12 text-sm font-semibold disabled:opacity-50"
                  style={armed === `exit-${exRow.subscription_id}`
                    ? { background: "var(--danger)", color: "#fff", border: "none" }
                    : { border: "1px solid var(--danger)", color: "var(--danger)", background: "transparent" }}>
                  {busy ? "Recording"
                    : armed === `exit-${exRow.subscription_id}`
                      ? "Tap again to record the exit" : "Record the exit"}
                </button>
              )}
              <button type="button" onClick={() => openExit(null)}
                className="rounded-input border px-16 py-12 text-sm font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                {exEnded ? "Close" : "Do not record"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
