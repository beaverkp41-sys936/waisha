"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The customer register: every company the platform has sold to, priced the way the
 * invoice was priced (spec §8; task #104).
 *
 * The pricing rule lives in the database, not here. A bundle customer is priced from
 * the bundle and a ladder customer from the rung, because subscriptions.plan_id is
 * NOT NULL and always carries a rung even when the office sold a package — a client
 * that read the plan first would quietly re-price every package customer off the
 * ladder and disagree with its own invoice.
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
    setError(null); setLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      load({});
      // Both lists are the public buying catalog — the same rows the applicant sees at
      // the licence gate — so filtering by an offering needs no extra duty.
      const [g, p] = await Promise.all([
        fetch(`${API}/api/v1/content/service-groups`, { credentials: "include" }),
        fetch(`${API}/api/v1/control/plans-public`)
      ]);
      if (g.ok) setPackages(await g.json());
      if (p.ok) setRungs(await p.json());
    })();
  }, [load]);

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

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex items-center justify-between gap-16 px-24 py-12"
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
                          <Link href={`/control/payments?q=${encodeURIComponent(r.company_name)}`}
                            className="inline-block rounded-input border px-12 py-6 text-[11px] font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                            Money
                          </Link>
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

            <p className="mt-16 text-xs" style={{ color: "var(--ink-soft)" }}>
              Total monthly equivalent is the sum of the matched rows, so a filter that narrows the
              register narrows the figure with it — that is the point of showing it beside the count.
              It is a rate, not money received: collected is what the office confirmed as paid, and
              both are on this page because a renewal conversation needs them together.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
