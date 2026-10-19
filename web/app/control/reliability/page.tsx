"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The reliability desk (085).
 *
 * 082 made a failure leave a trace. This desk is about the three things that never did: a
 * request that succeeded slowly, a worker that was gone for eleven minutes, and a table
 * whose dead tuples doubled while nobody looked. Every figure comes out of a definer,
 * because all of it is cross-tenant or catalog-reading — a bare query would answer with
 * nothing and the screen would read "no slow routes, no gaps, no bloat", which is the most
 * dangerous empty result a panel can produce.
 *
 * Three honesty rules the page follows, because the store cannot say them by itself:
 *
 *  - a percentile here is banded. The register keeps five buckets, not durations, so p50 and
 *    p95 are interpolated inside their band and printed with a tilde. The mean and the max
 *    are exact, so they are printed without one;
 *  - a percentage needs a window in which the collector existed. `uptime_pct` is null until
 *    the first boot line, and the desk says "nothing measured" rather than showing 0%, which
 *    would be an outage that never happened;
 *  - a trend needs two points. With one capture the bloat half prints today's figures and
 *    states that it has no direction.
 */

type Boot = { instance: string; started_at: string; environment: string | null; node: string | null };
type Gap = { before: string; after: string; minutes: number };

type Uptime = {
  window_days?: number;
  measured_from?: string | null;
  expected_minutes?: number;
  alive_minutes?: number;
  uptime_pct?: number | null;
  instances?: number;
  boots?: Boot[];
  boot_count?: number;
  last_boot?: string | null;
  longest_gap_minutes?: number | null;
  gaps?: Gap[];
  collector_note?: string;
};

type Overall = {
  window_days?: number; requests?: number; routes?: number; mean_ms?: number | null;
  max_ms?: number | null; over_1s?: number; server_errors?: number;
  error_rate?: number | null; p95_ms?: number | null;
};

type RouteRow = {
  method: string; route: string; requests: number; mean_ms: number | null;
  p50_ms: number | null; p95_ms: number | null; max_ms: number; server_errors: number;
  error_rate: number | null; over_1s: number; last_seen: string | null;
};

type DayRow = {
  day: string; requests: number; mean_ms: number | null;
  over_1s: number; server_errors: number; routes: number;
};

type BloatRow = {
  relname: string; snapshots: number; first_seen: string | null; last_seen: string | null;
  live_tuples: number; dead_tuples: number; dead_pct: number | null;
  table_bytes: number; index_bytes: number;
  dead_growth: number | null; table_growth_bytes: number | null;
  seq_scans: number; idx_scans: number; scan_ratio: number | null;
  last_vacuum: string | null; last_autovacuum: string | null;
  vacuum_stale_hours: number | null;
};

type Desk = {
  window_days: number;
  bloat_window_days: number;
  collector: { instance: string; answered_by: string };
  uptime: Uptime;
  latency: {
    overall: Overall;
    approximate: boolean;
    band_edges_ms: number[];
    routes: RouteRow[];
    daily: DayRow[];
  };
  bloat: {
    meta: { captures: number; relations: number; first_capture: string | null;
      last_capture: string | null; has_history: boolean };
    relations: BloatRow[];
  };
  can_manage: boolean;
};

const WINDOWS = [1, 7, 30, 90];
const BLOAT_WINDOWS = [7, 30, 90, 365];
const LIMITS = [20, 40, 100, 200];

const SORTS = [
  { key: "requests", label: "Busiest" },
  { key: "p95", label: "Slowest p95" },
  { key: "max", label: "Worst single answer" },
  { key: "errors", label: "Most 5xx" }
] as const;

const CARD = { borderColor: "var(--line)", background: "var(--surface)" };
const INPUT = "rounded-input border px-10 py-6 text-xs";
const INPUT_STYLE = { borderColor: "var(--adm-line)", background: "transparent", color: "var(--ink)" };

const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

function int(v: unknown): string {
  const x = n(v);
  return x === null ? "—" : x.toLocaleString("en-GB");
}

/** A duration, in the unit a reader compares against rather than the one stored. */
function ms(v: unknown, approx = false): string {
  const x = n(v);
  if (x === null) return "—";
  const body = x >= 10000 ? `${(x / 1000).toFixed(0)} s`
    : x >= 1000 ? `${(x / 1000).toFixed(1)} s`
    : `${Math.round(x)} ms`;
  // The tilde is the whole point of the column: a banded estimate must not read as a
  // measurement at the same precision as the max beside it.
  return approx && x > 0 ? `~${body}` : body;
}

function pct(v: unknown, digits = 2): string {
  const x = n(v);
  return x === null ? "—" : `${x.toFixed(digits)}%`;
}

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
  return new Date(t).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "UTC"
  });
}

/** Clock time in Dar es Salaam: a gap is read against the office day, not against UTC. */
function stamp(iso: unknown): string {
  if (!iso) return "—";
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    timeZone: "Africa/Dar_es_Salaam"
  });
}

function minutes(v: unknown): string {
  const x = n(v);
  if (x === null) return "—";
  if (x < 60) return `${Math.round(x)} min`;
  const h = Math.floor(x / 60), m = Math.round(x % 60);
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

function Pill({ label, edge }: { label: string; edge: string }) {
  return (
    <span className="rounded-input px-8 py-4 text-[10px] font-bold uppercase tracking-[0.12em]"
      style={{ background: `color-mix(in srgb, ${edge} 16%, transparent)`, color: edge }}>
      {label}
    </span>
  );
}

function Kpi({ value, label, note, edge }:
  { value: string; label: string; note?: string; edge?: string }) {
  return (
    <div className="rounded-card border px-12 py-12" style={CARD}>
      <p className="text-lg font-bold tabular-nums" style={{ color: edge ?? "var(--ink)" }}>
        {value}
      </p>
      <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: "var(--ink-soft)" }}>{label}</p>
      {note && <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>{note}</p>}
    </div>
  );
}

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

function Section({ title, note, children }:
  { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mt-32">
      <div className="flex flex-wrap items-end justify-between gap-8">
        <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
          {title}
        </h2>
        {note && <p className="max-w-[620px] text-[11px]" style={{ color: "var(--ink-soft)" }}>{note}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * The empty register is the first thing anyone will see on this desk, because the stores
 * open with 085. Each half needs its own sentence: "nothing was slow" and "nothing was
 * timed yet" are different facts, and a screen that prints a dash for both teaches the
 * reader to distrust dashes.
 */
function Nothing({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-14 rounded-card border p-20" style={{ ...CARD, background: "var(--milk)" }}>
      <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{title}</p>
      <p className="mt-8 max-w-[820px] text-sm" style={{ color: "var(--ink-soft)" }}>{body}</p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-14 overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
      {children}
    </div>
  );
}

/** The bar is a share of the busiest row on screen, and says so — it is not a scale. */
function BarRow({ share, edge }: { share: number; edge: string }) {
  return (
    <div className="flex items-center gap-8">
      <div style={{ height: 8, flex: 1, background: "var(--adm-line)", borderRadius: 4,
        overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.max(1, Math.round(share * 100))}%`,
          background: edge, opacity: 0.85 }} />
      </div>
    </div>
  );
}

export default function ControlReliabilityPage() {
  const [me, setMe] = useState<{ email?: string; fullName?: string; roles?: string[] } | null>(null);
  const [desk, setDesk] = useState<Desk | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");
  const [days, setDays] = useState(7);
  const [bloatDays, setBloatDays] = useState(30);
  const [limit, setLimit] = useState(40);
  const [sort, setSort] = useState<(typeof SORTS)[number]["key"]>("requests");
  const [filter, setFilter] = useState("");
  const [snapBusy, setSnapBusy] = useState(false);
  const [snapNote, setSnapNote] = useState("");
  const [keepDays, setKeepDays] = useState(30);
  const [armed, setArmed] = useState(false);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [pruneNote, setPruneNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const params = new URLSearchParams({
      days: String(days), bloat_days: String(bloatDays), limit: String(limit)
    });
    try {
      const res = await fetch(`${API}/api/v1/control/system/reliability?${params}`,
        { credentials: "include" });
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(`answered ${res.status}`);
      setDesk(await res.json());
    } catch {
      setError("The reliability register did not answer.");
    } finally {
      setLoading(false);
    }
  }, [days, bloatDays, limit]);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
    })();
  }, []);

  useEffect(() => { load(); }, [load]);

  const up: Uptime = desk?.uptime ?? {};
  const overall: Overall = desk?.latency?.overall ?? {};
  const meta: Desk["bloat"]["meta"] = desk?.bloat?.meta ?? {
    captures: 0, relations: 0, first_capture: null, last_capture: null, has_history: false
  };
  const timed = n(overall.requests) ?? 0;
  const hasTrend = !!meta.has_history;

  const routes = useMemo(() => {
    const all = desk?.latency?.routes ?? [];
    const q = filter.trim().toLowerCase();
    const rows = q ? all.filter(r => `${r.method} ${r.route}`.toLowerCase().includes(q)) : all;
    const key = (r: RouteRow) =>
      sort === "requests" ? r.requests
        : sort === "p95" ? r.p95_ms
        : sort === "max" ? r.max_ms
        : r.server_errors;
    return [...rows].sort((a, b) => {
      const av = n(key(a)), bv = n(key(b));
      if (av === null && bv === null) return b.requests - a.requests;
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });
  }, [desk, sort, filter]);

  const daily = desk?.latency?.daily ?? [];
  const maxDay = Math.max(1, ...daily.map(d => n(d.requests) ?? 0));
  const bloat = desk?.bloat?.relations ?? [];
  const maxDead = Math.max(1, ...bloat.map(r => n(r.dead_tuples) ?? 0));

  async function snapshot() {
    setSnapBusy(true); setSnapNote("");
    try {
      const res = await fetch(`${API}/api/v1/control/system/reliability/snapshot`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        // A body of its own: the desk sends no data, and an empty JSON request is a framing
        // error rather than a call with nothing in it.
        body: "{}"
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSnapNote(typeof json?.message === "string" && json.message
          ? json.message : "The snapshot was not taken.");
        return;
      }
      setSnapNote(`${int(json?.relations)} relations captured at ${stamp(json?.captured_at)}. `
        + (json?.relations && meta.captures < 2
          ? "Take the next one in a few hours and the bloat half becomes a trend."
          : ""));
      load();
    } catch {
      setSnapNote("The snapshot was not taken.");
    } finally {
      setSnapBusy(false);
    }
  }

  async function prune() {
    setPruneBusy(true); setArmed(false); setPruneNote("");
    try {
      const res = await fetch(`${API}/api/v1/control/system/reliability/retention`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepDays })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPruneNote(typeof json?.message === "string" && json.message
          ? json.message : "Retention was refused.");
        return;
      }
      setPruneNote(`Older than ${stamp(json?.cutoff)} gone — ${int(json?.request_lines)} timing `
        + `line${json?.request_lines === 1 ? "" : "s"}, ${int(json?.snapshot_lines)} snapshot `
        + `rows and ${int(json?.heartbeats)} heartbeat${json?.heartbeats === 1 ? "" : "s"} removed. `
        + "Boot lines are never pruned.");
      load();
    } catch {
      setPruneNote("Retention was refused.");
    } finally {
      setPruneBusy(false);
    }
  }

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between gap-16 px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--adm-accent)" }}>
            Platform · Uptime, latency and bloat
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1180px] px-16 py-32">
        {forbidden ? (
          <div className="rounded-card border p-24" style={CARD}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              The reliability register is not open to this seat
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
        ) : (
          <>
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
              How the system has been behaving
            </h1>
            {!desk && loading && (
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                Reading the four registers…
              </p>
            )}
            {desk && (
              <p className="mt-8 max-w-[880px] text-sm" style={{ color: "var(--ink-soft)" }}>
                Four registers, all written by the API itself: a boot line per process start, a
                heartbeat for every minute a worker was alive, one timing row per minute per route,
                and the database&rsquo;s janitor counters copied out on demand. Read for{" "}
                {desk.window_days} day{desk.window_days === 1 ? "" : "s"} · bloat over{" "}
                {desk.bloat_window_days} days · answered by <code>{desk.collector.answered_by}</code>.
                A percentile here is interpolated from five stored bands, so it carries a tilde;
                a mean and a worst-case do not.
              </p>
            )}

            {error && (
              <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                  borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
                {error}
              </div>
            )}

            {/* --------------------------------------------------- headline */}
            {desk && (
              <div className="mt-20 grid grid-cols-2 gap-12 sm:grid-cols-3 lg:grid-cols-6">
              <Kpi value={up.uptime_pct === null || up.uptime_pct === undefined
                  ? "not yet" : pct(up.uptime_pct)}
                label="uptime"
                note={n(up.expected_minutes) ? `${int(up.alive_minutes)} of ${int(up.expected_minutes)} min`
                  : "no window measured"}
                edge={n(up.uptime_pct) === null ? "var(--ink-soft)"
                  : (n(up.uptime_pct) ?? 100) < 99 ? "var(--danger)" : "var(--success)"} />
              <Kpi value={minutes(up.longest_gap_minutes ?? null)} label="longest silence"
                note={`${int(up.boot_count)} boots · ${int(up.instances)} instances`}
                edge={(n(up.longest_gap_minutes) ?? 0) > 10 ? "var(--warning)" : undefined} />
              <Kpi value={int(timed)} label="requests timed"
                note={`${int(overall.routes)} distinct routes`} />
              <Kpi value={ms(overall.p95_ms, true)} label="p95, all traffic"
                note={`mean ${ms(overall.mean_ms)} · max ${ms(overall.max_ms)}`}
                edge={(n(overall.p95_ms) ?? 0) >= 1000 ? "var(--warning)" : undefined} />
              <Kpi value={int(overall.over_1s)} label="answers over 1 s"
                note={`${pct(overall.error_rate, 2)} were 5xx`}
                edge={(n(overall.over_1s) ?? 0) > 0 ? "var(--warning)" : undefined} />
              <Kpi value={int(meta.captures)} label="snapshots taken"
                note={hasTrend ? `${int(meta.relations)} relations with history`
                  : "bloat has no trend yet"}
                edge={hasTrend ? "var(--success)" : "var(--ink-soft)"} />
            </div>
            )}

            {/* ----------------------------------------------------- filters */}
            <div className="mt-20 flex flex-wrap items-end gap-10">
              <label>
                <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
                  style={{ color: "var(--ink-soft)" }}>Window</span>
                <select value={days} onChange={e => setDays(Number(e.target.value))}
                  className={INPUT} style={INPUT_STYLE}>
                  {WINDOWS.map(d => <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>)}
                </select>
              </label>
              <label>
                <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
                  style={{ color: "var(--ink-soft)" }}>Bloat window</span>
                <select value={bloatDays} onChange={e => setBloatDays(Number(e.target.value))}
                  className={INPUT} style={INPUT_STYLE}>
                  {BLOAT_WINDOWS.map(d => <option key={d} value={d}>{d} days</option>)}
                </select>
              </label>
              <label>
                <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
                  style={{ color: "var(--ink-soft)" }}>Rows per table</span>
                <select value={limit} onChange={e => setLimit(Number(e.target.value))}
                  className={INPUT} style={INPUT_STYLE}>
                  {LIMITS.map(l => <option key={l} value={l}>{l} routes</option>)}
                </select>
              </label>
              <button type="button" onClick={load}
                className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>
                Reload
              </button>
              <Link href="/control/system"
                className="ml-auto rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                style={{ borderColor: "var(--adm-line)", color: "var(--adm-accent)" }}>
                Technical report
              </Link>
            </div>

            {desk && (
              <>
            {/* ------------------------------------------------------ uptime */}
            <Section title="Was it alive"
              note={up.collector_note}>
              {up.uptime_pct === null || up.uptime_pct === undefined ? (
                <Nothing title="Nothing is being measured yet"
                  body={`A percentage needs a first boot line, and this register has none since 085 was applied${
                    n(up.alive_minutes) ? ` — ${int(up.alive_minutes)} heartbeat minutes are already stored and will count from the first boot` : ""
                  }. Until then the desk prints nothing rather than the 0% an empty divide would give, because that would be an outage that never happened. It fills itself in at the next deploy or restart of the API.`} />
              ) : (
                <div className="mt-14 grid gap-14"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))" }}>
                  <div className="rounded-card border p-16" style={CARD}>
                    <Fact label="Uptime" value={`${pct(up.uptime_pct)} of ${minutes(up.expected_minutes)}`} />
                    <Fact label="Minutes heard alive" value={int(up.alive_minutes)} />
                    <Fact label="Measured from"
                      value={`${stamp(up.measured_from)} — the later of the window and the first boot`} />
                    <Fact label="Instances seen" value={int(up.instances)} />
                    <Fact label="Boots in window" value={int(up.boot_count)} />
                    <Fact label="Last boot" value={`${ago(up.last_boot)} (${stamp(up.last_boot)})`} />
                    <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      A restart of one instance while another kept answering is not a gap here, and a
                      worker that was alive but unreachable from outside is not one either — there is
                      no probe from outside this process.
                    </p>
                  </div>

                  <div className="rounded-card border p-16" style={CARD}>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em]"
                      style={{ color: "var(--ink-soft)" }}>
                      Gaps longer than five minutes
                    </p>
                    {(up.gaps ?? []).length ? (
                      <div className="mt-10 space-y-8">
                        {(up.gaps ?? []).map((g, i) => (
                          <div key={`${g.before}-${i}`}
                            className="flex flex-wrap items-baseline justify-between gap-8 text-xs"
                            style={{ borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                            <span className="tabular-nums" style={{ color: "var(--ink)" }}>
                              {stamp(g.before)} → {stamp(g.after)}
                            </span>
                            <span className="font-bold tabular-nums"
                              style={{ color: (g.minutes ?? 0) > 30 ? "var(--danger)" : "var(--warning)" }}>
                              {minutes(g.minutes)} silent
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-10 text-sm" style={{ color: "var(--success)" }}>
                        None — every minute in the window had a worker reporting itself alive.
                      </p>
                    )}

                    <p className="mt-16 text-[10px] font-semibold uppercase tracking-[0.12em]"
                      style={{ color: "var(--ink-soft)" }}>
                      Last boots
                    </p>
                    <div className="mt-10 space-y-6">
                      {(up.boots ?? []).map((b, i) => (
                        <div key={`${b.instance}-${b.started_at}-${i}`}
                          className="flex flex-wrap items-baseline justify-between gap-8 text-[11px]">
                          <span className="font-mono" style={{ color: "var(--ink)" }}>
                            {b.instance}
                          </span>
                          <span className="tabular-nums" style={{ color: "var(--ink-soft)" }}>
                            {stamp(b.started_at)} · {b.environment ?? "—"} · {b.node ?? "—"}
                          </span>
                        </div>
                      ))}
                      {!(up.boots ?? []).length && (
                        <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                          No boot lines at all.
                        </p>
                      )}
                      {(up.boot_count ?? 0) > (up.boots ?? []).length && (
                        <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          {int((up.boot_count ?? 0) - (up.boots ?? []).length)} older boots not listed —
                          the register caps the list at ten so a crash loop cannot fill the screen.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </Section>

            {/* ----------------------------------------------------- latency */}
            <Section title="Which route is slow"
              note="Five bands are stored per minute per route: under 100 ms, 300, 1000, 3000 and above. p50 and p95 are interpolated inside the band they land in, so they are a magnitude, not a measurement.">
              {timed === 0 ? (
                <Nothing title="Nothing has been timed in this window"
                  body="The timing store begins with 085, so this is what the week of that deploy looks like. Every request the API answers adds a line, and the desk's own visits count. Use the panel normally for a day and come back: an empty screen here is not a fast system, it is an unmeasured one." />
              ) : (
                <>
                  <div className="mt-14 flex flex-wrap items-center gap-10">
                    <Pill label={desk?.latency?.approximate ? "percentiles approximate" : "exact"}
                      edge="var(--warning)" />
                    <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      band edges {desk?.latency?.band_edges_ms?.join(" / ")} ms ·{" "}
                      {int(overall.server_errors)} of {int(timed)} answers were 5xx — those same
                      responses are on the <Link href="/control/errors" className="underline"
                        style={{ color: "var(--adm-accent)" }}>error desk</Link> with their stacks
                    </span>
                  </div>

                  <div className="mt-14 flex flex-wrap items-end gap-10">
                    {SORTS.map(s => {
                      const active = sort === s.key;
                      return (
                        <button key={s.key} type="button" onClick={() => setSort(s.key)}
                          className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                          style={{
                            borderColor: active ? "var(--adm-accent)" : "var(--adm-line)",
                            background: active ? "var(--adm-accent-soft)" : "transparent",
                            color: active ? "var(--adm-accent)" : "var(--ink-soft)"
                          }}>
                          {s.label}
                        </button>
                      );
                    })}
                    <label className="ml-auto block">
                      <span className="sr-only">Filter routes</span>
                      <input value={filter} onChange={e => setFilter(e.target.value)}
                        placeholder="Filter by method or path" maxLength={120}
                        className={`${INPUT} min-w-[220px]`} style={INPUT_STYLE} />
                    </label>
                  </div>

                  <Shell>
                    <table className="w-full text-xs" style={{ minWidth: 780 }}>
                      <thead>
                        <tr className="border-b text-left"
                          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                          <th className="p-12">Route</th>
                          <th className="p-12 text-right">Requests</th>
                          <th className="p-12 text-right">Mean</th>
                          <th className="p-12 text-right">p50 ~</th>
                          <th className="p-12 text-right">p95 ~</th>
                          <th className="p-12 text-right">Worst</th>
                          <th className="p-12 text-right">&gt; 1 s</th>
                          <th className="p-12 text-right">5xx</th>
                          <th className="p-12 text-right">Last seen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {routes.map((r, i) => (
                          <tr key={`${r.method} ${r.route}`}
                            style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                            <td className="p-12">
                              <span className="font-mono font-semibold" style={{ color: "var(--ink)" }}>
                                {r.method}
                              </span>{" "}
                              <span className="break-all" style={{ color: "var(--ink)" }}>{r.route}</span>
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                              {int(r.requests)}
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {ms(r.mean_ms)}
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {ms(r.p50_ms, true)}
                            </td>
                            <td className="p-12 text-right font-semibold tabular-nums"
                              style={{ color: (n(r.p95_ms) ?? 0) >= 1000 ? "var(--danger)"
                                : (n(r.p95_ms) ?? 0) >= 300 ? "var(--warning)" : "var(--ink)" }}>
                              {ms(r.p95_ms, true)}
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {ms(r.max_ms)}
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {int(r.over_1s)}
                            </td>
                            <td className="p-12 text-right tabular-nums"
                              style={{ color: n(r.server_errors) ? "var(--danger)" : "var(--ink-soft)" }}>
                              {int(r.server_errors)}
                              {n(r.error_rate) ? (
                                <span className="ml-4 text-[10px]">({r.error_rate}%)</span>
                              ) : null}
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {ago(r.last_seen)}
                            </td>
                          </tr>
                        ))}
                        {!routes.length && !loading && (
                          <tr>
                            <td colSpan={9} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                              {filter ? "No route in this window matches that filter."
                                : "The register has timings but none inside the rows shown — raise the row limit."}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </Shell>
                  {filter && routes.length !== (desk?.latency?.routes ?? []).length && (
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      {routes.length} of {(desk?.latency?.routes ?? []).length} routes on this screen
                      — the filter is applied here, after the register has already folded the window.
                    </p>
                  )}
                </>
              )}
            </Section>

            {/* ------------------------------------------------------- daily */}
            <Section title="Day by day"
              note="Dar es Salaam days. Whether the system got slower matters more than whether it is slow today, and one day of history cannot answer that.">
              {daily.length === 0 ? (
                <Nothing title="No day has been timed yet"
                  body="Same cause as the table above: the store is new. A day appears once any request has been answered inside it." />
              ) : (
                <Shell>
                  <table className="w-full text-xs" style={{ minWidth: 620 }}>
                    <thead>
                      <tr className="border-b text-left"
                        style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                        <th className="p-12">Day</th>
                        <th className="p-12">Share of traffic</th>
                        <th className="p-12 text-right">Requests</th>
                        <th className="p-12 text-right">Mean</th>
                        <th className="p-12 text-right">&gt; 1 s</th>
                        <th className="p-12 text-right">5xx</th>
                        <th className="p-12 text-right">Routes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {daily.map((d, i) => (
                        <tr key={d.day} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                          <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>{d.day}</td>
                          <td className="p-12 w-[220px]">
                            <BarRow share={(n(d.requests) ?? 0) / maxDay} edge="var(--adm-accent)" />
                          </td>
                          <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                            {int(d.requests)}
                          </td>
                          <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                            {ms(d.mean_ms)}
                          </td>
                          <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                            {int(d.over_1s)}
                          </td>
                          <td className="p-12 text-right tabular-nums"
                            style={{ color: n(d.server_errors) ? "var(--danger)" : "var(--ink-soft)" }}>
                            {int(d.server_errors)}
                          </td>
                          <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                            {int(d.routes)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Shell>
              )}
              {daily.length === 1 && (
                <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>
                  One day of timings — a direction needs two, so nothing above is a trend yet.
                </p>
              )}
            </Section>

            {/* ------------------------------------------------------- bloat */}
            <Section title="Is the database getting heavier"
              note="The janitor's counters are copied out of pg_stat on demand, because a statistics reset wipes them. Growth is only knowable between two captures.">
              {!bloat.length ? (
                <Nothing title="No snapshot has been stored"
                  body="This half of the desk needs a capture, and nothing takes one on a timer — it is a button below, and it is audited. The first press gives today's figures; a second one, hours later, turns them into a direction." />
              ) : (
                <>
                  <div className="mt-14 flex flex-wrap items-center gap-10 text-[11px]"
                    style={{ color: "var(--ink-soft)" }}>
                    <Pill label={hasTrend ? "trend from two captures" : "one capture · no trend"}
                      edge={hasTrend ? "var(--success)" : "var(--warning)"} />
                    <span>
                      {int(meta.captures)} captures · {int(meta.relations)} relations · first{" "}
                      {stamp(meta.first_capture)} · newest {ago(meta.last_capture)}
                    </span>
                  </div>

                  <Shell>
                    <table className="w-full text-xs" style={{ minWidth: 900 }}>
                      <thead>
                        <tr className="border-b text-left"
                          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                          <th className="p-12">Table</th>
                          <th className="p-12">Dead share</th>
                          <th className="p-12 text-right">Live rows</th>
                          <th className="p-12 text-right">Dead rows</th>
                          <th className="p-12 text-right">Dead growth</th>
                          <th className="p-12 text-right">Size</th>
                          <th className="p-12 text-right">Size growth</th>
                          <th className="p-12 text-right">Seq / idx scans</th>
                          <th className="p-12 text-right">Last vacuum</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bloat.map((r, i) => (
                          <tr key={r.relname}
                            style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                            <td className="p-12">
                              <span style={{ color: "var(--ink)" }}>{r.relname}</span>
                              <span className="ml-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                                {r.snapshots} capture{r.snapshots === 1 ? "" : "s"}
                              </span>
                            </td>
                            <td className="p-12 w-[180px]">
                              <div className="flex items-center gap-8">
                                <BarRow share={Math.min(1, (n(r.dead_pct) ?? 0) / 50)}
                                  edge={(n(r.dead_pct) ?? 0) > 30 ? "var(--danger)" : "var(--warning)"} />
                                <span className="w-[52px] text-right tabular-nums"
                                  style={{ color: "var(--ink-soft)" }}>
                                  {r.dead_pct === null ? "—" : `${r.dead_pct}%`}
                                </span>
                              </div>
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {int(r.live_tuples)}
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                              {int(r.dead_tuples)}
                            </td>
                            <td className="p-12 text-right tabular-nums"
                              style={{ color: (n(r.dead_growth) ?? 0) > 0 ? "var(--warning)" : "var(--ink-soft)" }}>
                              {hasTrend ? signed(r.dead_growth) : "needs 2"}
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {bytes(r.table_bytes)}
                              {n(r.index_bytes) ? <span className="ml-4 text-[10px]">idx {bytes(r.index_bytes)}</span> : null}
                            </td>
                            <td className="p-12 text-right tabular-nums"
                              style={{ color: (n(r.table_growth_bytes) ?? 0) > 0 ? "var(--warning)" : "var(--ink-soft)" }}>
                              {hasTrend ? signedBytes(r.table_growth_bytes) : "needs 2"}
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {int(r.seq_scans)} / {int(r.idx_scans)}
                              {n(r.scan_ratio) ? (
                                <span className="ml-4 text-[10px]">ratio {r.scan_ratio}</span>
                              ) : null}
                            </td>
                            <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                              {r.vacuum_stale_hours === null ? "never" : `${minutes(r.vacuum_stale_hours * 60)} before capture`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Shell>

                  <p className="mt-8 max-w-[880px] text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    Row figures are the collector&rsquo;s estimates, not a count, and the scan
                    counters have run since the last statistics reset — which is why{" "}
                    <Link href="/control/system" className="underline"
                      style={{ color: "var(--adm-accent)" }}>the technical report</Link> can show a
                    different number for the same table on a freshly restarted cluster. A high dead
                    share says the janitor has not been through yet; it does not say the table is
                    growing.
                  </p>
                </>
              )}
            </Section>
            </>
            )}

            {!desk && !loading && !error && !forbidden && (
              <Nothing title="The desk did not answer"
                body="No payload arrived, so nothing above is a measurement. Reload from the top of the page." />
            )}

            {/* ------------------------------------------------------ upkeep */}
            {desk?.can_manage && (
              <Section title="Taking the numbers"
                note="Both of these are writes and both are audited: a capture stores catalog facts, retention deletes evidence.">
                <div className="mt-14 grid gap-14"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
                  <div className="rounded-card border p-16" style={CARD}>
                    <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>Snapshot pg_stat</p>
                    <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                      One row per table in <code>public</code>, stamped with the database&rsquo;s own{" "}
                      <code>now()</code>. Cheap, and worth a press a day — or wire an external
                      scheduler to the same endpoint and stop thinking about it.
                    </p>
                    <div className="mt-12 flex flex-wrap items-center gap-12">
                      <button type="button" onClick={snapshot} disabled={snapBusy}
                        className="rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-40"
                        style={{ background: "var(--adm-accent)", color: "var(--brand-deep)" }}>
                        {snapBusy ? "Capturing" : "Capture now"}
                      </button>
                      {snapNote && (
                        <span className="max-w-[280px] text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          {snapNote}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="rounded-card border p-16" style={CARD}>
                    <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>Prune history</p>
                    <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                      Timing minutes, snapshot rows and heartbeats older than the number below are
                      deleted. Boot lines are kept — a restart two years ago is still the reason an
                      old gap looks the way it does. Nothing runs this on a timer.
                    </p>
                    <div className="mt-12 flex flex-wrap items-end gap-12">
                      <label className="block">
                        <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
                          style={{ color: "var(--ink-soft)" }}>Keep the last (days)</span>
                        <input type="number" min={7} max={3650} value={keepDays}
                          onChange={e => { setKeepDays(Number(e.target.value)); setArmed(false); }}
                          className={`${INPUT} w-[120px]`} style={INPUT_STYLE} />
                      </label>
                      <button type="button"
                        onClick={() => { if (!armed) { setArmed(true); return; } if (!pruneBusy) prune(); }}
                        disabled={pruneBusy || !(keepDays >= 7 && keepDays <= 3650)}
                        className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-40"
                        style={{
                          borderColor: armed ? "var(--danger)" : "var(--adm-line)",
                          color: armed ? "var(--danger)" : "var(--ink)"
                        }}>
                        {pruneBusy ? "Pruning"
                          : armed ? "Tap again to delete the old rows" : "Prune older rows"}
                      </button>
                    </div>
                    {pruneNote && (
                      <p className="mt-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>{pruneNote}</p>
                    )}
                  </div>
                </div>
              </Section>
            )}

            <p className="mt-32 text-xs" style={{ color: "var(--ink-soft)" }}>
              The stores are <code>service_boots</code>, <code>service_heartbeats</code>,{" "}
              <code>request_timings</code> and <code>pg_stat_snapshots</code> (085); every figure
              comes from a <code>platform_auth</code> definer, so this page cannot read a good week
              into existence. Timings are folded in the API process and flushed every five seconds —
              one row per minute per route, not one per request, because the database sits behind a
              pooler. Percentiles are banded by design; if a route needs an exact number, that is a
              profiler, not a dashboard. Failures with their stacks are on the{" "}
              <Link href="/control/errors" className="underline" style={{ color: "var(--adm-accent)" }}>
                error desk
              </Link>
              , and the catalog the readers live in is listed on the{" "}
              <Link href="/control/system" className="underline" style={{ color: "var(--adm-accent)" }}>
                technical report
              </Link>.
            </p>
          </>
        )}
      </main>
    </div>
  );
}

/** A growth figure is signed and stated against the window, because 0 and unknown differ. */
function signed(v: number | null | undefined): string {
  const x = n(v);
  if (x === null) return "—";
  return `${x > 0 ? "+" : ""}${x.toLocaleString("en-GB")}`;
}

function signedBytes(v: number | null | undefined): string {
  const x = n(v);
  if (x === null) return "—";
  return `${x > 0 ? "+" : x < 0 ? "−" : ""}${bytes(Math.abs(x))}`;
}
