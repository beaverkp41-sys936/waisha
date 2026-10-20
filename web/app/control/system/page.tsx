"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The machine room (069).
 *
 * Three halves on one desk. The advisory is first because it is the part that changes
 * what someone does today; the delivery register (112) is the evidence an account call is
 * argued from — what was sent, to a masked whom, and the provider's own words when it was
 * refused; the technical report is underneath both because it is the ground they stand on.
 *
 * Everything here is a read of a fact the database already holds. The panel shows the
 * `not_measured` list for the same reason a lab report lists its limits: the office has
 * asked for churn curves and reliability numbers, and there is no data behind them yet.
 * Saying so on the screen is what stops a reader from trusting the numbers beside it.
 */

type Evidence = Array<Record<string, unknown> | string>;

type AdvisoryItem = {
  item_id: string; rank: number; kind: string; priority: string; area: string;
  title: string; detail: string; metric: number | null; unit: string | null;
  action: string; evidence: Evidence;
};

type Advisory = {
  generated_at: string; total: number;
  by_priority: Record<string, number>; by_kind: Record<string, number>;
  items: AdvisoryItem[];
  not_measured: Array<{ thing: string; why: string }>;
  reliability?: {
    uptime_pct: number | null; requests: number; p95_ms: number | null; captures: number;
  };
};

type Report = {
  generated_at: string; currency: string;
  shape: {
    postgres: string; tables: number; partitioned_parents: number; views: number;
    indexes: number; triggers: number; functions: number; functions_platform_auth: number;
    schemas: string[];
  };
  posture: {
    rls_enabled: number; policies: number; definer_functions: number;
    app_runtime_write_grants: number; app_runtime_delete_grants: number;
    tenant_tables_without_rls: string[]; rls_without_policy: string[];
    definer_public_reachable: string[]; definer_without_search_path: string[];
  };
  size: { database_bytes: number | string; largest: Array<Record<string, any>>; rows_estimated: Array<Record<string, any>> };
  migrations: Record<string, any>;
  access: Record<string, unknown>;
  activity: Record<string, any>;
  modules: Record<string, any>;
  statistics: Record<string, any>;
  caveats: string[];
  runtime: {
    node: string; platform: string; pid: number; started_at: string;
    uptime_seconds: number; environment: string; timezone: string; web_origin: string;
    readiness: Record<string, unknown>;
    booking_timer: { in_process_loop: boolean; http_tick_enabled: boolean };
  };
};

/**
 * The delivery register (112), read through GET /control/system/deliveries.
 *
 * Masked addresses only: the register is safe to put in front of a platform seat because
 * it cannot answer "does this exact email have an account" — the same reason the auth
 * desks print `j***@domain.test` and never the whole thing.
 */
type DeliveryLine = {
  id: number; channel: string; purpose: string; to_masked: string; subject: string | null;
  status: string; provider: string | null; provider_message_id: string | null;
  error: string | null; attempts: number; sent_at: string;
};
type Deliveries = {
  window_days: number;
  filters: { purpose: string | null; status: string | null; channel: string | null; q: string | null };
  readiness: { mail_configured: boolean; mail_sender: string | null };
  summary: Array<{ channel: string; purpose: string; status: string; sends: number;
    addresses: number; last_at: string | null }>;
  items: DeliveryLine[];
};
const PURPOSE_LABEL: Record<string, string> = {
  signup_otp: "Sign-up code", otp_resend: "Code resend", password_reset: "Password reset",
  staff_invite: "Staff invite", notification: "Notification", other: "Other"
};
const DELIVERY_WINDOWS = [1, 7, 30, 90];

const PRIORITY_EDGE: Record<string, string> = {
  high: "var(--danger)", medium: "var(--warning)", low: "var(--adm-line)"
};const KIND_LABEL: Record<string, string> = {
  risk: "Risk", revenue: "Revenue", growth: "Growth", retention: "Retain", improve: "Improve"
};
const KIND_FILTERS = ["", "risk", "revenue", "growth", "retention", "improve"];

const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

function int(v: unknown): string {
  const x = n(v);
  return x === null ? "—" : x.toLocaleString("en-GB");
}

/** Four names is a sample, not the list, so the tile says how many it left out. */
function schemaNote(names: string[]): string {
  if (!names.length) return "none";
  const shown = names.slice(0, 4).join(", ");
  return names.length > 4 ? `${shown} +${names.length - 4} more` : shown;
}

/** Bytes arrive as numbers from the report; Postgres would have sent int8 as a string. */
function bytes(v: unknown): string {
  const x = n(v);
  if (x === null) return "—";
  if (x >= 1073741824) return `${(x / 1073741824).toFixed(2)} GB`;
  if (x >= 1048576) return `${(x / 1048576).toFixed(1)} MB`;
  if (x >= 1024) return `${(x / 1024).toFixed(0)} kB`;
  return `${x} B`;
}

function ago(iso: unknown): string {
  if (!iso) return "never";
  const t = new Date(String(iso)).getTime();
  if (Number.isNaN(t)) return String(iso);
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  if (days < 60) return `${days} d ago`;
  return new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric",
    timeZone: "UTC" });
}

function uptime(seconds: unknown): string {
  const s = n(seconds);
  if (s === null) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** A chip is the only shape small enough to carry a yes/no configuration fact. */
function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="rounded-input border px-10 py-5 text-[11px] font-semibold"
      style={{
        borderColor: ok ? "var(--success)" : "var(--warning)",
        background: `color-mix(in srgb, ${ok ? "var(--success)" : "var(--warning)"} 12%, transparent)`,
        color: ok ? "var(--success)" : "var(--warning)"
      }}>
      {ok ? "✓ " : "! "}{label}
    </span>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-card border p-14"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: "var(--ink-soft)" }}>{label}</p>
      <p className="mt-6 text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>{value}</p>
      {note && <p className="mt-2 text-[11px]" style={{ color: "var(--ink-soft)" }}>{note}</p>}
    </div>
  );
}

/**
 * Evidence is whatever the rule produced: rows of objects for the named companies, a
 * flat array of strings for the posture findings. Columns are taken from the union of
 * the keys present, so a rule can add a field without this component being told.
 */
function EvidenceTable({ rows }: { rows: Evidence }) {
  const objects = rows.filter(r => typeof r === "object" && r !== null) as Array<Record<string, unknown>>;
  const scalars = rows.filter(r => typeof r !== "object" || r === null) as string[];

  if (!objects.length && scalars.length) {
    return (
      <div className="mt-10 flex flex-wrap gap-6">
        {scalars.map((s, i) => (
          <code key={i} className="rounded-input border px-8 py-4 text-[11px]"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>{String(s)}</code>
        ))}
      </div>
    );
  }
  if (!objects.length) return null;

  const cols: string[] = [];
  for (const row of objects)
    for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);

  return (
    <div className="mt-10 overflow-x-auto rounded-card border"
      style={{ borderColor: "var(--line)" }}>
      <table className="w-full text-xs" style={{ minWidth: 340 }}>
        <thead>
          <tr className="border-b" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
            {cols.map(c => (
              <th key={c} className="p-8 text-left font-semibold uppercase tracking-[0.08em]">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {objects.map((row, i) => (
            <tr key={i} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
              {cols.map(c => {
                const v = row[c];
                const text = v === null || v === undefined || v === "" ? "—"
                  : typeof v === "number" ? v.toLocaleString("en-GB")
                  : typeof v === "boolean" ? (v ? "yes" : "no")
                  : String(v);
                return (
                  <td key={c} className="p-8 align-top tabular-nums"
                    style={{ color: c === cols[0] ? "var(--ink)" : "var(--ink-soft)" }}>{text}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, note, children }:
  { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-32">
      <div className="flex flex-wrap items-end justify-between gap-8">
        <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
          {title}
        </h2>
        {note && <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>{note}</p>}
      </div>
      {children}
    </section>
  );
}

/** One fact line: name, value, and an optional flag colour for the posture reads. */
function Fact({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return (
    <div className="flex items-baseline justify-between gap-12 border-b py-8 text-sm"
      style={{ borderColor: "var(--line)" }}>
      <span style={{ color: "var(--ink-soft)" }}>{label}</span>
      <span className="text-right font-semibold tabular-nums"
        style={{ color: tone === "bad" ? "var(--danger)" : tone === "ok" ? "var(--success)" : "var(--ink)" }}>
        {value}
      </span>
    </div>
  );
}

const STATUS_EDGE: Record<string, string> = {
  active: "var(--success)", trial: "var(--adm-accent)", grace: "var(--warning)",
  expired: "var(--danger)", suspended: "var(--danger)",
  pending_verification: "var(--ink-soft)", paid: "var(--success)",
  issued: "var(--warning)", draft: "var(--ink-soft)", void: "var(--ink-soft)",
  live: "var(--success)", awaiting_verification: "var(--warning)",
  rejected: "var(--danger)", cancelled: "var(--ink-soft)",
  // The three outcomes the delivery register can hold (112).
  sent: "var(--success)", failed: "var(--danger)", skipped: "var(--warning)"
};

function StatusPills({ map }: { map: Record<string, number> | undefined }) {
  const entries = Object.entries(map ?? {});
  if (!entries.length) {
    return <span className="text-xs" style={{ color: "var(--ink-soft)" }}>none on the system</span>;
  }
  return (
    <div className="flex flex-wrap gap-6">
      {entries.sort((a, b) => b[1] - a[1]).map(([k, v]) => (
        <span key={k} className="rounded-input border px-8 py-4 text-[11px] font-semibold"
          style={{ borderColor: "var(--line)", color: STATUS_EDGE[k] ?? "var(--ink-soft)" }}>
          {k.replace(/_/g, " ")} · {v}
        </span>
      ))}
    </div>
  );
}

export default function ControlSystemPage() {
  const [me, setMe] = useState<{ email?: string; fullName?: string; roles?: string[] } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [advisory, setAdvisory] = useState<Advisory | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");
  const [kind, setKind] = useState("");

  const [delivery, setDelivery] = useState<Deliveries | null>(null);
  const [deliveryError, setDeliveryError] = useState("");
  const [days, setDays] = useState(7);
  const [sentStatus, setSentStatus] = useState("");
  const [manage, setManage] = useState(false);
  const [keepDays, setKeepDays] = useState(30);
  const [armed, setArmed] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [pruneNote, setPruneNote] = useState("");

  async function get(path: string): Promise<Response> {
    const res = await fetch(`${API}/api/v1${path}`, { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; throw new Error("signed out"); }
    if (res.status === 403) { setForbidden(true); throw new Error("forbidden"); }
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res;
  }

  useEffect(() => {
    (async () => {
      try {
        const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
        if (!m.ok) { window.location.href = "/control/login"; return; }
        setMe(await m.json());
        // The right to prune the register is a different duty from the right to read it, so
        // the desk asks which seat it is in rather than showing a button that will 403.
        const p = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
        if (p.ok) setManage(((await p.json()).permissions ?? []).includes("control.system.manage"));
        const [r, a] = await Promise.all([
          get("/control/system/report"), get("/control/system/advisory")
        ]);
        setReport(await r.json());
        setAdvisory(await a.json());
      } catch (e) {
        if ((e as Error).message !== "forbidden" && (e as Error).message !== "signed out")
          setError("The system report did not answer.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const loadDeliveries = useCallback(async () => {
    const params = new URLSearchParams({ days: String(days) });
    if (sentStatus) params.set("status", sentStatus);
    try {
      const res = await fetch(`${API}/api/v1/control/system/deliveries?${params}`,
        { credentials: "include" });
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      if (!res.ok) throw new Error(`answered ${res.status}`);
      setDelivery(await res.json());
      setDeliveryError("");
    } catch {
      // A register that will not answer is reported on the panel that reads it, not folded
      // into the system-report error: the report is fine, this window is not.
      setDeliveryError("The delivery register did not answer.");
    }
  }, [days, sentStatus]);

  useEffect(() => { loadDeliveries(); }, [loadDeliveries]);

  async function pruneDeliveries() {
    setPruning(true); setPruneNote("");
    try {
      const res = await fetch(`${API}/api/v1/control/system/deliveries/retention`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepDays })
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error(j?.error?.message ?? `answered ${res.status}`);
      setPruneNote(`${int(j?.deleted)} line(s) older than ${j?.keep_days} days deleted.`);
      await loadDeliveries();
    } catch (e) {
      setPruneNote((e as Error).message || "Retention was refused.");
    } finally {
      setPruning(false); setArmed(false);
    }
  }

  const items = useMemo(
    () => (advisory?.items ?? []).filter(i => !kind || i.kind === kind),
    [advisory, kind]);
  const urgent = (advisory?.by_priority?.high ?? 0) + (advisory?.by_priority?.medium ?? 0);

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between gap-16 px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--adm-accent)" }}>
            Platform · Technical report and advisory
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1180px] px-16 py-32">
        {forbidden && (
          <div className="rounded-card border p-24" style={{ borderColor: "var(--line)" }}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              The machine room is not open to this seat
            </h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? me?.fullName ?? "a platform seat"} with{" "}
              {(me?.roles ?? []).join(", ") || "no platform duty"}. This desk needs the duty{" "}
              <code>control.system.view</code>.
            </p>
            <Link href="/control"
              className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        )}

        {!forbidden && error && (
          <div role="alert" className="rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
              borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
            {error}
          </div>
        )}

        {!forbidden && (
          <>
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
              What the system is doing
            </h1>
            <p className="mt-8 max-w-[860px] text-sm" style={{ color: "var(--ink-soft)" }}>
              Read live from the database catalog and this process — {int(report?.shape?.tables)} tables,
              {int(report?.shape?.functions)} functions, {int(report?.migrations?.applied)} applied
              migrations, generated {ago(report?.generated_at)}. Nothing on this page is typed in by
              anyone; where a figure is an estimate, it is marked.
            </p>

            {/* ------------------------------------------------ advisory */}
            <Section title="Advisory"
              note={advisory ? `${advisory.total} findings · ${urgent} needing attention this week` : ""}>
              <div className="mt-14 flex flex-wrap gap-8">
                {KIND_FILTERS.map(k => {
                  const active = kind === k;
                  const count = k ? (advisory?.by_kind?.[k] ?? 0) : (advisory?.total ?? 0);
                  return (
                    <button key={k || "all"} type="button"
                      className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                      style={{
                        borderColor: active ? "var(--adm-accent)" : "var(--line)",
                        background: active ? "var(--adm-accent-soft)" : "transparent",
                        color: active ? "var(--adm-accent)" : "var(--ink-soft)"
                      }}
                      onClick={() => setKind(k)}>
                      {k ? KIND_LABEL[k] ?? k : "All"} · {count}
                    </button>
                  );
                })}
              </div>

              <div className="mt-14 space-y-14">
                {items.map(it => (
                  <article key={it.item_id} className="rounded-card border p-16"
                    style={{ borderColor: "var(--line)", background: "var(--surface)",
                      borderLeft: `4px solid ${PRIORITY_EDGE[it.priority] ?? "var(--line)"}` }}>
                    <div className="flex flex-wrap items-center gap-8 text-[10px] font-semibold uppercase tracking-[0.12em]">
                      <span className="rounded-input px-8 py-4"
                        style={{ background: `color-mix(in srgb, ${PRIORITY_EDGE[it.priority] ?? "var(--line)"} 16%, transparent)`,
                          color: PRIORITY_EDGE[it.priority] ?? "var(--ink-soft)" }}>
                        {it.priority}
                      </span>
                      <span style={{ color: "var(--adm-accent)" }}>{KIND_LABEL[it.kind] ?? it.kind}</span>
                      <span style={{ color: "var(--ink-soft)" }}>{it.area}</span>
                      {n(it.metric) !== 0 && it.metric !== null && (
                        <span className="ml-auto text-right tabular-nums" style={{ color: "var(--ink)" }}>
                          {int(it.metric)} <span className="normal-case">{it.unit}</span>
                        </span>
                      )}
                    </div>

                    <h3 className="mt-10 text-base font-bold" style={{ color: "var(--ink)" }}>
                      {it.title}
                    </h3>
                    <p className="mt-8 max-w-[900px] text-sm" style={{ color: "var(--ink-soft)" }}>
                      {it.detail}
                    </p>
                    <p className="mt-10 text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      → {it.action}
                    </p>
                    {Array.isArray(it.evidence) && it.evidence.length > 0 && (
                      <EvidenceTable rows={it.evidence} />
                    )}
                  </article>
                ))}

                {!items.length && !loading && (
                  <div className="rounded-card border p-20"
                    style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                    <p className="text-sm font-semibold" style={{ color: "var(--success)" }}>
                      Nothing was found in this category.
                    </p>
                    <p className="mt-6 text-sm" style={{ color: "var(--ink-soft)" }}>
                      Every rule here is a query with a guard, so an empty list means the
                      condition was not met — not that it was not asked.
                    </p>
                  </div>
                )}
                {loading && (
                  <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
                    Reading the catalog and every module…
                  </p>
                )}
              </div>
            </Section>

            {/* ---------------------------------------------- delivery register */}
            <Section title="Delivery register"
              note="every code, reset link and invite the platform tried to send, and what the provider said">
              <div className="mt-14 flex flex-wrap items-center gap-8">
                {DELIVERY_WINDOWS.map(d => {
                  const active = days === d;
                  return (
                    <button key={d} type="button" onClick={() => setDays(d)}
                      className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                      style={{
                        borderColor: active ? "var(--adm-accent)" : "var(--line)",
                        background: active ? "var(--adm-accent-soft)" : "transparent",
                        color: active ? "var(--adm-accent)" : "var(--ink-soft)"
                      }}>
                      last {d} day{d > 1 ? "s" : ""}
                    </button>
                  );
                })}
                <span className="mx-6 hidden h-4 sm:block"
                  style={{ borderLeft: "1px solid var(--line)" }} aria-hidden />
                {["", "sent", "failed", "skipped"].map(s => {
                  const active = sentStatus === s;
                  const count = s ? (delivery?.summary ?? [])
                    .filter(x => x.status === s).reduce((t, x) => t + x.sends, 0)
                    : (delivery?.summary ?? []).reduce((t, x) => t + x.sends, 0);
                  return (
                    <button key={s || "all"} type="button" onClick={() => setSentStatus(s)}
                      className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                      style={{
                        borderColor: active ? (STATUS_EDGE[s] ?? "var(--adm-accent)") : "var(--line)",
                        background: active
                          ? `color-mix(in srgb, ${STATUS_EDGE[s] ?? "var(--adm-accent)"} 14%, transparent)`
                          : "transparent",
                        color: active ? (STATUS_EDGE[s] ?? "var(--adm-accent)") : "var(--ink-soft)"
                      }}>
                      {s || "all"} · {int(count)}
                    </button>
                  );
                })}
              </div>

              {/* Read this before any number below: it decides what a failed line means. */}
              <div className="mt-14 rounded-card border p-16"
                style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                <div className="flex flex-wrap items-center gap-10">
                  <Chip ok={delivery?.readiness?.mail_configured === true}
                    label={delivery?.readiness?.mail_configured ? "provider key set" : "no provider key"} />
                  <span className="text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    sending as {delivery?.readiness?.mail_sender ?? "—"}
                  </span>
                </div>
                <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>
                  {delivery?.readiness?.mail_configured
                    ? "A sending key is configured, so each line below carries the provider's own answer, not a guess. A sent line means the provider accepted the message — it is still not proof that an inbox received it."
                    : "No sending key is configured. Every code was stored and printed to the server console, and delivered to nobody: an account that cannot verify is the expected result of this state, not a bug in the sign-up form."}
                </p>
                {/@resend\.dev$/i.test(delivery?.readiness?.mail_sender ?? "") && (
                  <p className="mt-8 text-sm font-semibold" style={{ color: "var(--danger)" }}>
                    {delivery?.readiness?.mail_sender} is Resend&rsquo;s shared test address. It accepts a
                    send and then delivers it only to the inbox that owns the Resend account, so every
                    other company that signs up is told a code is on its way and never gets one. Verify a
                    domain in the Resend console and point MAIL_FROM at it.
                  </p>
                )}
              </div>

              {deliveryError && (
                <div role="alert" className="mt-14 rounded-input px-12 py-8 text-sm"
                  style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                    borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
                  {deliveryError}
                </div>
              )}

              {(delivery?.summary ?? []).length > 0 && (
                <div className="mt-18 grid gap-12"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
                  {delivery!.summary.slice(0, 12).map(s => (
                    <div key={`${s.channel}-${s.purpose}-${s.status}`}
                      className="rounded-card border p-14"
                      style={{ borderColor: "var(--line)", background: "var(--surface)",
                        borderLeft: `4px solid ${STATUS_EDGE[s.status] ?? "var(--line)"}` }}>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em]"
                        style={{ color: "var(--adm-accent)" }}>
                        {PURPOSE_LABEL[s.purpose] ?? s.purpose} · {s.channel}
                      </p>
                      <p className="mt-6 text-base font-bold tabular-nums"
                        style={{ color: STATUS_EDGE[s.status] ?? "var(--ink)" }}>
                        {int(s.sends)} {s.status}
                      </p>
                      <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                        {int(s.addresses)} address{ s.addresses === 1 ? "" : "es"} · last {ago(s.last_at)}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {(delivery?.items ?? []).length > 0 && (
                <ul className="mt-18 space-y-10">
                  {delivery!.items.slice(0, 40).map(it => (
                    <li key={it.id} className="rounded-card border p-14"
                      style={{ borderColor: "var(--line)", background: "var(--surface)",
                        borderLeft: `4px solid ${STATUS_EDGE[it.status] ?? "var(--line)"}` }}>
                      <div className="flex flex-wrap items-center gap-8 text-[10px] font-semibold uppercase tracking-[0.12em]">
                        <span style={{ color: STATUS_EDGE[it.status] ?? "var(--ink-soft)" }}>
                          {it.status}
                        </span>
                        <span style={{ color: "var(--adm-accent)" }}>
                          {PURPOSE_LABEL[it.purpose] ?? it.purpose}
                        </span>
                        <span className="tabular-nums" style={{ color: "var(--ink)" }}>{it.to_masked}</span>
                        <span className="ml-auto text-right tabular-nums"
                          style={{ color: "var(--ink-soft)" }}>
                          {ago(it.sent_at)} · {it.attempts} attempt{it.attempts === 1 ? "" : "s"}
                        </span>
                      </div>
                      {it.subject && (
                        <p className="mt-6 text-sm font-semibold" style={{ color: "var(--ink)" }}>
                          {it.subject}
                        </p>
                      )}
                      {it.error && (
                        <p className="mt-4 text-xs" style={{ color: "var(--danger)" }}>{it.error}</p>
                      )}
                      {it.provider_message_id && (
                        <p className="mt-4 text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                          provider id {it.provider_message_id} · {it.provider ?? "resend"}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {!delivery && !deliveryError && (
                <p className="mt-14 text-sm" style={{ color: "var(--ink-soft)" }}>
                  Reading the register…
                </p>
              )}
              {delivery && !delivery.items.length && !deliveryError && (
                <p className="mt-14 text-sm" style={{ color: "var(--ink-soft)" }}>
                  Nothing was sent inside {delivery.window_days} day{delivery.window_days === 1 ? "" : "s"}.
                  Widen the window above before reading that as a healthy system — the register only
                  holds what has been kept, and pruning is a decision this desk makes on purpose.
                </p>
              )}

              {manage && (
                <div className="mt-24 rounded-card border p-20"
                  style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
                  <h3 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                    Retention
                  </h3>
                  <p className="mt-8 max-w-[760px] text-sm" style={{ color: "var(--ink-soft)" }}>
                    Lines older than the number below are deleted. Nothing runs this on a timer: the
                    register is the evidence behind every &ldquo;we never got the code&rdquo; call, so
                    clearing it is an operator decision and is audited as{" "}
                    <code>control.delivery.retention</code>.
                  </p>
                  <div className="mt-14 flex flex-wrap items-end gap-12">
                    <label className="block">
                      <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
                        style={{ color: "var(--ink-soft)" }}>Keep the last (days)</span>
                      <input type="number" min={7} max={3650} value={keepDays}
                        onChange={e => { setKeepDays(Number(e.target.value)); setArmed(false); }}
                        className="rounded-input border px-10 py-6 text-sm tabular-nums w-[120px]"
                        style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--ink)" }} />
                    </label>
                    <button type="button"
                      onClick={() => { if (!armed) { setArmed(true); return; } if (!pruning) pruneDeliveries(); }}
                      disabled={pruning || !(keepDays >= 7 && keepDays <= 3650)}
                      className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-40"
                      style={{
                        borderColor: armed ? "var(--danger)" : "var(--adm-line)",
                        color: armed ? "var(--danger)" : "var(--ink)"
                      }}>
                      {pruning ? "Pruning" : armed ? "Tap again to delete the old lines" : "Prune older lines"}
                    </button>
                    {pruneNote && (
                      <span role="status" aria-live="polite" className="text-[11px]"
                        style={{ color: "var(--ink-soft)" }}>{pruneNote}</span>
                    )}
                  </div>
                </div>
              )}
            </Section>

            {/* ---------------------------------------------- not measured */}
            <Section title="What this system cannot tell you yet"
              note="listed so nobody reads the numbers above as more than they are">
              <div className="mt-14 grid gap-12"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
                {(advisory?.not_measured ?? []).map(x => (
                  <div key={x.thing} className="rounded-card border p-14"
                    style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
                    <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{x.thing}</p>
                    <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>{x.why}</p>
                  </div>
                ))}
              </div>
            </Section>

            {/* ------------------------------------------- headline facts */}
            <Section title="Headline">
              <div className="mt-14 grid gap-12"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(178px, 1fr))" }}>
                <Tile label="Companies" value={int(report?.modules?.companies)}
                  note={`${int(report?.modules?.users_company)} staff accounts`} />
                <Tile label="Seats licensed" value={int(report?.modules?.seats_licensed)}
                  note="active, trial and grace only" />
                <Tile label="Seekers" value={int(report?.modules?.seekers)}
                  note={`${int(report?.modules?.seekers_email_verified)} email-verified`} />
                <Tile label="Searches 30d" value={int(report?.modules?.searches_30d)} />
                <Tile label="Database" value={bytes(report?.size?.database_bytes)}
                  note={`${int(report?.shape?.tables)} tables`} />
                <Tile label="Audit events 24h" value={int(report?.activity?.audit_24h)}
                  note={`${int(report?.activity?.refusals_24h)} refusals`} />
                <Tile label="Migrations" value={int(report?.migrations?.applied)}
                  note={String(report?.migrations?.last_name ?? "").replace(/\.sql$/, "")} />
                <Tile label="Live sessions" value={int(report?.access?.sessions_live)}
                  note={`${int(report?.access?.accounts_locked)} locked`} />
                {/* The three reliability halves, on the report that lists their limits. */}
                <Tile label="Uptime 7d"
                  value={advisory?.reliability?.uptime_pct === null
                    || advisory?.reliability?.uptime_pct === undefined
                    ? "not yet" : `${advisory.reliability.uptime_pct}%`}
                  note="minutes a worker reported itself alive" />
                <Tile label="Requests timed 7d" value={int(advisory?.reliability?.requests)}
                  note="folded to one row per minute per route" />
                <Tile label="p95 7d"
                  value={advisory?.reliability?.p95_ms === null
                    || advisory?.reliability?.p95_ms === undefined
                    ? "no samples" : `${Math.round(advisory.reliability.p95_ms)} ms`}
                  note="interpolated from five bands, so a magnitude" />
                <Tile label="pg_stat captures" value={int(advisory?.reliability?.captures)}
                  note="two are the minimum for a trend" />
              </div>
              <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                Uptime, per-route latency and bloat history live on their own{" "}
                <Link href="/control/reliability" className="underline"
                  style={{ color: "var(--adm-accent)" }}>Reliability desk</Link>, where the gaps,
                the band edges and the slow routes are named one by one.
              </p>
            </Section>

            {/* ------------------------------------------- deployment */}
            <Section title="Deployment"
              note="what is running, and whether the code and the schema agree">
              <div className="mt-14 grid gap-14"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
                <div className="rounded-card border p-16"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <Fact label="Migration files on disk"
                    value={int(report?.migrations?.files_on_disk)} />
                  <Fact label="Recorded as applied"
                    value={int(report?.migrations?.applied)} />
                  <Fact label="Never applied"
                    value={int((report?.migrations?.unapplied ?? []).length)}
                    tone={(report?.migrations?.unapplied ?? []).length ? "bad" : "ok"} />
                  <Fact label="Applied, file missing"
                    value={int((report?.migrations?.applied_without_file ?? []).length)}
                    tone={(report?.migrations?.applied_without_file ?? []).length ? "bad" : "ok"} />
                  <Fact label="Last applied"
                    value={`${String(report?.migrations?.last_name ?? "—").replace(/\.sql$/, "")} · ${ago(report?.migrations?.last_applied_at)}`} />
                  <Fact label="First applied" value={ago(report?.migrations?.first_applied_at)} />
                  <div className="mt-12 flex flex-wrap gap-6">
                    <Chip ok={!!report?.runtime?.readiness?.mail_configured} label="mail" />
                    <Chip ok={!!report?.runtime?.readiness?.storage_configured} label="document storage" />
                    <Chip ok={!!report?.runtime?.readiness?.app_role_password_configured}
                      label="app role password" />
                    <Chip ok={!!report?.runtime?.booking_timer?.http_tick_enabled}
                      label="external scheduler" />
                  </div>
                </div>

                <div className="rounded-card border p-16"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <Fact label="API process" value={`node ${report?.runtime?.node ?? "—"} · ${report?.runtime?.platform ?? ""}`} />
                  <Fact label="Environment" value={String(report?.runtime?.environment ?? "—")} />
                  <Fact label="Started" value={`${ago(report?.runtime?.started_at)} (${uptime(report?.runtime?.uptime_seconds)} up)`} />
                  <Fact label="Wall clock" value={String(report?.runtime?.timezone ?? "—")} />
                  <Fact label="Web origin" value={String(report?.runtime?.web_origin ?? "—")} />
                  <Fact label="Database server" value={`PostgreSQL ${report?.shape?.postgres ?? "—"}`} />
                  <Fact label="Database up" value={uptime(report?.statistics?.db_uptime_seconds)} />
                  <Fact label="Statistics since" value={ago(report?.statistics?.stats_reset)} />
                </div>
              </div>
            </Section>

            {/* ------------------------------------------- posture */}
            <Section title="Isolation and privilege"
              note="read from the catalog, the same way verify-isolation.ts reads it">
              <div className="mt-14 grid gap-14"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
                <div className="rounded-card border p-16"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <Fact label="Tables with RLS" value={`${int(report?.posture?.rls_enabled)} of ${int(report?.shape?.tables)}`} />
                  <Fact label="Tenant tables without RLS"
                    value={int((report?.posture?.tenant_tables_without_rls ?? []).length)}
                    tone={(report?.posture?.tenant_tables_without_rls ?? []).length ? "bad" : "ok"} />
                  <Fact label="RLS on, no policy"
                    value={int((report?.posture?.rls_without_policy ?? []).length)}
                    tone={(report?.posture?.rls_without_policy ?? []).length ? "bad" : "ok"} />
                  <Fact label="Policies" value={int(report?.posture?.policies)} />
                  <div className="mt-10 flex flex-wrap gap-6">
                    {((report?.posture?.tenant_tables_without_rls ?? []) as string[]).map(x => (
                      <code key={x} className="rounded-input border px-8 py-4 text-[11px]"
                        style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{x}</code>
                    ))}
                  </div>
                </div>

                <div className="rounded-card border p-16"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <Fact label="SECURITY DEFINER functions" value={int(report?.posture?.definer_functions)} />
                  <Fact label="Reachable from PUBLIC"
                    value={int((report?.posture?.definer_public_reachable ?? []).length)}
                    tone={(report?.posture?.definer_public_reachable ?? []).length ? "bad" : "ok"} />
                  <Fact label="No pinned search_path"
                    value={int((report?.posture?.definer_without_search_path ?? []).length)}
                    tone={(report?.posture?.definer_without_search_path ?? []).length ? "bad" : "ok"} />
                  <Fact label="app_runtime write grants" value={int(report?.posture?.app_runtime_write_grants)} />
                  <Fact label="…of which DELETE" value={int(report?.posture?.app_runtime_delete_grants)}
                    tone="ok" />
                  <div className="mt-10 flex flex-wrap gap-6">
                    {((report?.posture?.definer_public_reachable ?? []) as string[]).map(x => (
                      <code key={x} className="rounded-input border px-8 py-4 text-[11px]"
                        style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{x}</code>
                    ))}
                  </div>
                </div>
              </div>
            </Section>

            {/* ------------------------------------------- shape */}
            <Section title="Shape of the schema"
              note="what the migrations have built">
              <div className="mt-14 grid gap-12"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(158px, 1fr))" }}>
                <Tile label="Tables" value={int(report?.shape?.tables)}
                  note={`${int(report?.shape?.partitioned_parents)} partitioned parent`} />
                <Tile label="Views" value={int(report?.shape?.views)} />
                <Tile label="Indexes" value={int(report?.shape?.indexes)} />
                <Tile label="Triggers" value={int(report?.shape?.triggers)} note="guards and audit stamps" />
                <Tile label="Functions" value={int(report?.shape?.functions)}
                  note={`${int(report?.shape?.functions_platform_auth)} in platform_auth`} />
                <Tile label="Schemas" value={int((report?.shape?.schemas ?? []).length)}
                  note={schemaNote(report?.shape?.schemas ?? [])} />
              </div>
            </Section>

            {/* ------------------------------------------- bulk */}
            <Section title="Where the bulk sits"
              note="sizes are live; row figures are the collector's estimate">
              <div className="mt-14 grid gap-14"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))" }}>
                <div className="overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
                  <table className="w-full text-sm" style={{ minWidth: 320 }}>
                    <thead>
                      <tr className="border-b text-left"
                        style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                        <th className="p-12">Table</th>
                        <th className="p-12 text-right">Size</th>
                        <th className="p-12 text-right">Indexes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(report?.size?.largest ?? []).map((r, i) => (
                        <tr key={String(r.table)} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                          <td className="p-12" style={{ color: "var(--ink)" }}>{r.table}</td>
                          <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                            {bytes(r.bytes)}
                          </td>
                          <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                            {int(r.indexes)}
                          </td>
                        </tr>
                      ))}
                      {loading && (
                        <tr><td colSpan={3} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                          Asking the server for sizes…
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
                  <table className="w-full text-sm" style={{ minWidth: 320 }}>
                    <thead>
                      <tr className="border-b text-left"
                        style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                        <th className="p-12">Busiest by rows</th>
                        <th className="p-12 text-right">Estimated</th>
                        <th className="p-12 text-right">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const rows = report?.size?.rows_estimated ?? [];
                        const max = Math.max(1, ...rows.map(r => n(r.rows) ?? 0));
                        return rows.map((r, i) => {
                          const v = n(r.rows) ?? 0;
                          return (
                            <tr key={String(r.table)} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                              <td className="p-12" style={{ color: "var(--ink)" }}>{r.table}</td>
                              <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>{int(v)}</td>
                              <td className="p-12">
                                <div className="flex items-center gap-8">
                                  <div style={{ height: 8, flex: 1, background: "var(--adm-line)",
                                    borderRadius: 4, overflow: "hidden" }}>
                                    <div style={{ height: "100%", width: `${Math.max(1, Math.round((v / max) * 100))}%`,
                                      background: "var(--adm-accent)", opacity: 0.8 }} />
                                  </div>
                                  <span className="w-12 text-right text-[11px] tabular-nums"
                                    style={{ color: "var(--ink-soft)" }}>{Math.round((v / max) * 100)}%</span>
                                </div>
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            </Section>

            {/* ------------------------------------------- modules */}
            <Section title="Every module, counted"
              note="companies and seekers are platform-wide; a status with no rows is absent, not zero">
              <div className="mt-14 grid gap-14"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
                <div className="rounded-card border p-16"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>Companies by status</p>
                  <div className="mt-8"><StatusPills map={report?.modules?.companies_by_status} /></div>
                  <p className="mt-14 text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>Subscriptions</p>
                  <div className="mt-8"><StatusPills map={report?.modules?.subscriptions} /></div>
                  <p className="mt-14 text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>Invoices</p>
                  <div className="mt-8"><StatusPills map={report?.modules?.invoices} /></div>
                </div>

                <div className="rounded-card border p-16"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>Marketplace</p>
                  <p className="mt-14 text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>Search passes</p>
                  <div className="mt-8"><StatusPills map={report?.modules?.passes} /></div>
                  <p className="mt-14 text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>Directory listings</p>
                  <div className="mt-8"><StatusPills map={report?.modules?.listings} /></div>
                  <p className="mt-14 text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>Operations</p>
                  <Fact label="Cargo files open" value={int(report?.modules?.jobs_open)} />
                  <Fact label="Stages blocked" value={int(report?.modules?.job_stages_blocked)} />
                  <Fact label="Requests open" value={int(report?.modules?.transport_requests_open)} />
                  <Fact label="Bookings live" value={int(report?.modules?.transport_bookings_live)} />
                  <Fact label="Office employees" value={int(report?.modules?.office_employees)} />
                  <Fact label="Tasks open" value={int(report?.modules?.office_tasks_open)} />
                  <Fact label="Attendance rows 30d" value={int(report?.modules?.attendance_30d)} />
                  <Fact label="Documents" value={`${int(report?.modules?.documents)} · ${bytes(report?.modules?.document_bytes)}`} />
                </div>
              </div>
            </Section>

            {/* ------------------------------------------- activity */}
            <Section title="Auth and activity"
              note="refusals counted the way 066 counts them">
              <div className="mt-14 grid gap-14"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
                <div className="rounded-card border p-16"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <Fact label="Audit events 24h" value={int(report?.activity?.audit_24h)} />
                  <Fact label="Audit events 30d" value={int(report?.activity?.audit_30d)} />
                  <Fact label="Distinct actors 30d" value={int(report?.activity?.audit_actors_30d)} />
                  <Fact label="Refusals 24h" value={int(report?.activity?.refusals_24h)} />
                  <Fact label="Last event" value={ago(report?.activity?.last_event_at)} />
                </div>
                <div className="rounded-card border p-16"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <Fact label="Live sessions" value={int(report?.access?.sessions_live)} />
                  <Fact label="Expiring within 24h" value={int(report?.access?.sessions_expiring_24h)} />
                  <Fact label="Accounts locked now" value={int(report?.access?.accounts_locked)}
                    tone={n(report?.access?.accounts_locked) ? "bad" : "ok"} />
                  <Fact label="Accounts with failed attempts"
                    value={int(report?.access?.accounts_with_failures)} />
                  <Fact label="Rate-limit buckets 24h" value={int(report?.access?.rate_buckets_24h)} />
                  <Fact label="Counted hits 24h" value={int(report?.access?.rate_hits_24h)} />
                </div>
              </div>

              <div className="mt-14 overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
                <table className="w-full text-sm" style={{ minWidth: 420 }}>
                  <thead>
                    <tr className="border-b text-left"
                      style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      <th className="p-12">Most frequent actions (30 days)</th>
                      <th className="p-12 text-right">Events</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report?.activity?.top_actions_30d ?? []).map((a: any, i: number) => (
                      <tr key={a.action} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className="p-12" style={{ color: "var(--ink)" }}>{a.action}</td>
                        <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                          {int(a.events)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            {/* ------------------------------------------- upkeep */}
            <Section title="Upkeep"
              note="every figure here is measured since the statistics reset above">
              <div className="mt-14 grid gap-12"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))" }}>
                <Tile label="Indexes never scanned" value={int(report?.statistics?.indexes_never_scanned)}
                  note="candidates for removal, not proof" />
                <Tile label="Tables with no index" value={int((report?.statistics?.tables_without_indexes ?? []).length)} />
                <Tile label="Dead tuples" value={int(report?.statistics?.dead_tuples_total)}
                  note={`last autovacuum ${ago(report?.statistics?.last_autovacuum)}`} />
                <Tile label="Audit partitions" value={int((report?.statistics?.audit_partitions ?? []).length)}
                  note={((report?.statistics?.audit_partitions ?? []) as string[]).join(", ") || "none"} />
              </div>
              {(report?.statistics?.seq_scan_tables ?? []).length > 0 && (
                <div className="mt-14 overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
                  <table className="w-full text-sm" style={{ minWidth: 420 }}>
                    <thead>
                      <tr className="border-b text-left"
                        style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                        <th className="p-12">Scanned without an index</th>
                        <th className="p-12 text-right">Sequential scans</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(report?.statistics?.seq_scan_tables ?? []).map((s: any, i: number) => (
                        <tr key={s.table} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                          <td className="p-12" style={{ color: "var(--ink)" }}>{s.table}</td>
                          <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                            {int(s.seq_scans)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            {/* ------------------------------------------- caveats */}
            <Section title="Limits of this report">
              <ul className="mt-14 space-y-8">
                {(report?.caveats ?? []).map((c, i) => (
                  <li key={i} className="flex gap-10 text-sm" style={{ color: "var(--ink-soft)" }}>
                    <span aria-hidden style={{ color: "var(--adm-accent)" }}>—</span>
                    <span className="max-w-[900px]">{c}</span>
                  </li>
                ))}
              </ul>
            </Section>

            <p className="mt-32 text-xs" style={{ color: "var(--ink-soft)" }}>
              The advisory rules live in <code>platform_auth.control_advisory</code> (069) and each one
              is a query with a guard, so a rule that found nothing contributes no row rather than a
              zero. Cross-tenant counts come from{" "}
              <code>platform_auth.control_system_report</code>; nothing on this page is computed in the
              browser. Money and customers are on the{" "}
              <Link href="/control/revenue" className="underline" style={{ color: "var(--adm-accent)" }}>revenue</Link>,{" "}
              <Link href="/control/subscriptions" className="underline" style={{ color: "var(--adm-accent)" }}>customers</Link>{" "}
              and{" "}
              <Link href="/control/payments" className="underline" style={{ color: "var(--adm-accent)" }}>money</Link>{" "}
              desks.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
