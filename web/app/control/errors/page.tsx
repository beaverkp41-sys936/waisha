"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

type Summary = {
  window_days?: number;
  lines?: number; occurrences?: number;
  server_lines?: number; server_occurrences?: number;
  client_lines?: number; client_occurrences?: number;
  in_last_24h?: number; in_prior_24h?: number; server_in_last_24h?: number;
  tenants?: number;
  open?: number; triaged?: number; resolved?: number; ignored?: number; untouched?: number;
};

type Line = {
  fingerprint: string; kind: string; code: string | null; status: number | null;
  path: string | null; route: string | null; message: string;
  occurrences: number; lines: number; first_seen: string; last_seen: string;
  tenants: number; request_id: string | null; state: string; triage_note: string | null;
};

type Occurrence = {
  bucket: string; kind: string; code: string | null; status: number | null; method: string | null;
  path: string | null; route: string | null; message: string; detail: string | null;
  request_id: string | null; repeats: number; tenant_id: string | null; tenant_name: string | null;
  actor_user_id: string | null; actor_name: string | null; ip: string | null;
  user_agent: string | null; environment: string | null;
};

/**
 * The error desk (082).
 *
 * One line per bug, not one row per failure — `platform_auth.error_register` folds every
 * minute a bug was alive into a single entry and counts the repeats, so the register reads
 * as a list of things to fix rather than a flood of the same stack. Because the rows belong
 * to no single company, every statement here is a definer call behind `control.system.view`;
 * a bare query would answer with zero rows on a system that is failing loudly, which is the
 * most dangerous empty screen the panel could show.
 *
 * Two things this desk deliberately cannot do: delete a line (only an explicit retention
 * decision removes evidence, and it is audited), and read anything back into the app. It
 * judges a bug and prunes old ones; that is the whole of its write surface.
 */

const KINDS = ["", "server", "client"] as const;
const STATES = ["", "untouched", "open", "triaged", "resolved", "ignored"] as const;
const TRIAGE = ["open", "triaged", "resolved", "ignored"] as const;
const WINDOWS = [1, 7, 30, 90];

const KIND_LABEL: Record<string, string> = { server: "Server", client: "Browser" };
const STATE_LABEL: Record<string, string> = {
  untouched: "Never judged", open: "Open", triaged: "Triaged", resolved: "Resolved", ignored: "Ignored"
};
const STATE_EDGE: Record<string, string> = {
  untouched: "var(--adm-line)", open: "var(--danger)", triaged: "var(--adm-accent)",
  resolved: "var(--success)", ignored: "var(--ink-soft)"
};

const CARD = { borderColor: "var(--line)", background: "var(--surface)" };
const INPUT = "rounded-input border px-10 py-6 text-xs";
const INPUT_STYLE = { borderColor: "var(--adm-line)", background: "transparent", color: "var(--ink)" };

function ago(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
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

function stamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC"
  });
}

function Pill({ label, edge }: { label: string; edge: string }) {
  return (
    <span className="rounded-input px-8 py-4 text-[10px] font-bold uppercase tracking-[0.12em]"
      style={{ background: `color-mix(in srgb, ${edge} 16%, transparent)`, color: edge }}>
      {label}
    </span>
  );
}

function Kpi({ value, label, edge }: { value: string | number; label: string; edge?: string }) {
  return (
    <div className="rounded-card border px-12 py-12" style={CARD}>
      <p className="text-lg font-bold" style={{ color: edge ?? "var(--ink)" }}>{value}</p>
      <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: "var(--ink-soft)" }}>{label}</p>
    </div>
  );
}

/**
 * The minutes behind one line. Opened on demand, because a register of 200 bugs should not
 * fetch 200 drill-downs — and the stack is the one part of this screen that only ever matters
 * to whoever is about to fix it.
 */
function Drilldown({ fingerprint, manage }: { fingerprint: string; manage: boolean }) {
  const [rows, setRows] = useState<Occurrence[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API}/api/v1/control/errors/${encodeURIComponent(fingerprint)}?limit=20`,
          { credentials: "include" });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(typeof j?.message === "string" && j.message ? j.message : `answered ${res.status}`);
        }
        const json = await res.json();
        if (alive) setRows(Array.isArray(json?.occurrences) ? json.occurrences : []);
      } catch (e: any) {
        if (alive) setError(e?.message ?? "The register did not answer.");
      }
    })();
    return () => { alive = false; };
  }, [fingerprint]);

  if (error) return <p className="mt-12 text-xs" style={{ color: "var(--danger)" }}>{error}</p>;
  if (!rows) {
    return <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>Reading the minutes…</p>;
  }

  return (
    <div className="mt-14 space-y-16 border-t pt-14" style={{ borderColor: "var(--adm-line)" }}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: "var(--ink-soft)" }}>
        {rows.length} of the most recent minutes this bug was alive
      </p>
      {rows.map((o, i) => (
        <div key={`${o.bucket}-${i}`} className="rounded-input border p-12"
          style={{ borderColor: "var(--adm-line)", background: "transparent" }}>
          <div className="flex flex-wrap items-center gap-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            <strong style={{ color: "var(--ink)" }}>{stamp(o.bucket)}</strong>
            <span>×{1 + o.repeats} in this minute</span>
            {o.status && <span>HTTP {o.status}</span>}
            {o.method && <span>{o.method}</span>}
            {o.request_id && <span className="font-mono">{o.request_id}</span>}
          </div>
          <p className="mt-6 break-words text-xs" style={{ color: "var(--ink)" }}>
            {o.path ?? "(no path)"}{o.route ? ` · ${o.route}` : ""}
          </p>
          <div className="mt-6 flex flex-wrap gap-x-16 gap-y-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            <span>Company <strong style={{ color: "var(--ink)" }}>{o.tenant_name ?? "nobody's"}</strong></span>
            <span>Seat <strong style={{ color: "var(--ink)" }}>{o.actor_name ?? "unknown"}</strong></span>
            <span>IP <span className="font-mono">{o.ip ?? "—"}</span></span>
            <span>Env <span className="font-mono">{o.environment ?? "—"}</span></span>
          </div>
          {o.detail && (
            // Plain text inside a <pre>: the stack is the API's own, but it is still
            // untrusted bytes on a page, so it is never parsed as markup.
            <pre className="mt-10 max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded-input p-12 font-mono text-[10px] leading-relaxed"
              style={{ background: "color-mix(in srgb, var(--danger) 6%, transparent)", color: "var(--ink)" }}>
              {o.detail}
            </pre>
          )}
          {o.user_agent && (
            <p className="mt-6 break-words text-[10px]" style={{ color: "var(--ink-soft)" }}>
              {o.user_agent}
            </p>
          )}
        </div>
      ))}
      {!rows.length && (
        <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
          The line is on the register but no minute came back — reload the desk.
        </p>
      )}
      {!manage && (
        <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
          This seat reads the register but cannot judge it.
        </p>
      )}
    </div>
  );
}

function LineCard({ line, manage, onJudged }: {
  line: Line; manage: boolean; onJudged: (fp: string, patch: Partial<Line>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(line.state);
  const [note, setNote] = useState(line.triage_note ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { setState(line.state); setNote(line.triage_note ?? ""); },
    [line.state, line.triage_note]);

  async function judge() {
    setBusy(true); setError(""); setFeedback("");
    try {
      const res = await fetch(
        `${API}/api/v1/control/errors/${encodeURIComponent(line.fingerprint)}/triage`,
        {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" },
          // A blank sentence is not sent: the definer reads an absent note as "keep the one
          // that is there", which is what changing a state should mean.
          body: JSON.stringify({ state, ...(note.trim() ? { note: note.trim() } : {}) })
        });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof json?.message === "string" && json.message
          ? json.message : "The desk could not record that.");
        return;
      }
      onJudged(line.fingerprint, {
        state: json.state, triage_note: json.note ?? null
      });
      setFeedback("Judged.");
    } catch {
      setError("The desk could not record that.");
    } finally {
      setBusy(false);
    }
  }

  // An emptied box is not "retract the note" — the definer keeps the sentence already on the
  // line — so it must not read as an unsaved change either.
  const sentence = note.trim() || null;
  const changed = state !== line.state || (sentence !== null && sentence !== line.triage_note);

  return (
    <article className="rounded-card border p-16"
      style={{ ...CARD, borderLeft: `4px solid ${STATE_EDGE[line.state] ?? "var(--line)"}` }}>
      <div className="flex flex-wrap items-center gap-8 text-[10px] font-semibold uppercase tracking-[0.12em]">
        <Pill label={STATE_LABEL[line.state] ?? line.state}
          edge={STATE_EDGE[line.state] ?? "var(--ink-soft)"} />
        <Pill label={KIND_LABEL[line.kind] ?? line.kind}
          edge={line.kind === "server" ? "var(--danger)" : "var(--adm-accent)"} />
        {line.status && <Pill label={`HTTP ${line.status}`} edge="var(--warning)" />}
        <span className="ml-auto normal-case tracking-normal" style={{ color: "var(--ink-soft)" }}>
          last {ago(line.last_seen)}
        </span>
      </div>

      <p className="mt-12 break-words text-sm font-semibold leading-relaxed" style={{ color: "var(--ink)" }}>
        {line.message}
      </p>

      <div className="mt-10 flex flex-wrap gap-x-16 gap-y-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
        <span>
          <strong style={{ color: "var(--ink)" }}>{line.occurrences}</strong> occurrence{line.occurrences === 1 ? "" : "s"}
          {line.lines > 1 ? ` over ${line.lines} minutes` : ""}
        </span>
        <span>first {ago(line.first_seen)}</span>
        {line.tenants > 0 && (
          <span>{line.tenants} compan{line.tenants === 1 ? "y" : "ies"} hit</span>
        )}
        {line.code && <span className="font-mono">{line.code}</span>}
        {line.path && <span className="break-all font-mono">{line.path}</span>}
        {line.request_id && <span className="font-mono">{line.request_id}</span>}
      </div>

      {line.triage_note && (
        <p className="mt-12 rounded-input px-12 py-8 text-xs"
          style={{ background: "color-mix(in srgb, var(--adm-accent) 8%, transparent)", color: "var(--ink)" }}>
          {line.triage_note}
        </p>
      )}

      <div className="mt-12 flex flex-wrap items-center gap-12">
        <button type="button" onClick={() => setOpen(v => !v)}
          className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
          style={{ borderColor: "var(--adm-line)", color: "var(--adm-accent)" }}>
          {open ? "Hide the minutes" : "Minute by minute"}
        </button>
        <span className="break-all font-mono text-[10px]" style={{ color: "var(--ink-soft)" }}>
          {line.fingerprint.slice(0, 16)}
        </span>
      </div>

      {open && <Drilldown fingerprint={line.fingerprint} manage={manage} />}

      {manage && (
        <div className="mt-14 border-t pt-14" style={{ borderColor: "var(--adm-line)" }}>
          <div className="flex flex-wrap items-end gap-10">
            <label className="block">
              <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
                style={{ color: "var(--ink-soft)" }}>Judgement</span>
              <select value={state} onChange={e => setState(e.target.value)}
                className={INPUT} style={INPUT_STYLE}>
                {TRIAGE.map(s => <option key={s} value={s}>{STATE_LABEL[s]}</option>)}
              </select>
            </label>
            <span className="pb-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              one judgement per bug, shared by every seat on the panel
            </span>
          </div>
          <label className="mt-10 block">
            <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
              style={{ color: "var(--ink-soft)" }}>Why (optional — 600 characters)</span>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={600}
              placeholder="What causes it, what you are doing about it. Leave it empty to keep the sentence already on the line."
              className={`${INPUT} w-full leading-relaxed`} style={INPUT_STYLE} />
          </label>
          <div className="mt-10 flex flex-wrap items-center gap-12">
            <button type="button" onClick={judge} disabled={busy || !changed}
              className="rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-40"
              style={{ background: "var(--adm-accent)", color: "var(--brand-deep)" }}>
              {busy ? "Recording" : "Record judgement"}
            </button>
            {changed
              ? <span className="text-[11px]" style={{ color: "var(--warning)" }}>unsaved</span>
              : <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>nothing to save</span>}
            {feedback && <span className="text-[11px]" style={{ color: "var(--success)" }}>{feedback}</span>}
            {error && <span role="alert" className="text-[11px]" style={{ color: "var(--danger)" }}>{error}</span>}
          </div>
        </div>
      )}
    </article>
  );
}

export default function ControlErrorsPage() {
  const [me, setMe] = useState<{ email?: string; roles?: string[] } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [summary, setSummary] = useState<Summary>({});
  const [manage, setManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<string>("");
  const [state, setState] = useState<string>("");
  const [days, setDays] = useState(7);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [keepDays, setKeepDays] = useState(30);
  const [armed, setArmed] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [pruneNote, setPruneNote] = useState("");

  // The register filters on the server, so typing filters after a pause — a search here runs
  // across every company's failures, not over the array already on screen.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const params = new URLSearchParams({ days: String(days) });
    if (kind) params.set("kind", kind);
    if (state) params.set("state", state);
    if (q) params.set("q", q);
    try {
      const res = await fetch(`${API}/api/v1/control/errors?${params}`, { credentials: "include" });
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const json = await res.json();
      setLines(Array.isArray(json?.items) ? json.items : []);
      setSummary(json?.summary ?? {});
    } catch {
      setError("The register did not answer.");
    } finally {
      setLoading(false);
    }
  }, [kind, state, days, q]);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const p = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (p.ok) {
        const j = await p.json();
        setManage((j.permissions ?? []).includes("control.system.manage"));
      }
    })();
  }, []);

  useEffect(() => { load(); }, [load]);

  const judge = useCallback((fp: string, patch: Partial<Line>) => {
    setLines(cur => cur.map(l => (l.fingerprint === fp ? { ...l, ...patch } : l)));
  }, []);

  const filtered = !!(kind || state || q);
  const trend = useMemo(() => {
    const now = summary.in_last_24h ?? 0;
    const prior = summary.in_prior_24h ?? 0;
    if (!prior) return now ? "and the day before that was quiet" : "the last day has been still";
    const ratio = now / prior;
    if (ratio >= 1.5) return `up from ${prior} the day before`;
    if (ratio <= 0.67) return `down from ${prior} the day before`;
    return `about the same as the ${prior} the day before`;
  }, [summary]);

  async function prune() {
    setPruning(true); setArmed(false); setPruneNote("");
    try {
      const res = await fetch(`${API}/api/v1/control/errors/retention`, {
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
      setPruneNote(`${json.deleted} older line${json.deleted === 1 ? "" : "s"} removed — everything up to ${json.cutoff ? stamp(json.cutoff) : `${json.keep_days} days`} is kept.`);
      load();
    } catch {
      setPruneNote("Retention was refused.");
    } finally {
      setPruning(false);
    }
  }

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex items-center justify-between gap-16 px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--adm-accent)" }}>
            Platform · Error register
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1120px] px-16 py-32">
        {forbidden ? (
          <div className="rounded-card border p-24" style={CARD}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              The register is not open to this seat
            </h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ")
                || "no platform duty"}. This desk needs the duty <code>control.system.view</code>.
            </p>
            <Link href="/control"
              className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
              What the system got wrong
            </h1>
            <p className="mt-8 max-w-[880px] text-sm" style={{ color: "var(--ink-soft)" }}>
              {loading ? "Reading the register…"
                : `${summary.lines ?? 0} distinct failures · ${summary.occurrences ?? 0} occurrences in ${days} day${days === 1 ? "" : "s"}`}
              {!loading && lines.length !== (summary.lines ?? 0)
                ? ` · ${lines.length} shown here` : ""}.
              {" "}{summary.in_last_24h ?? 0} in the last 24 hours, {trend}. Contact-shaped text is
              masked before a line is stored, so a message here never carries a customer&rsquo;s phone
              or national ID.
            </p>

            <div className="mt-20 grid grid-cols-2 gap-12 sm:grid-cols-4">
              <Kpi value={summary.server_occurrences ?? 0}
                label={`server · ${summary.server_lines ?? 0} bugs`} edge="var(--danger)" />
              <Kpi value={summary.client_occurrences ?? 0}
                label={`browser · ${summary.client_lines ?? 0} bugs`} edge="var(--adm-accent)" />
              <Kpi value={summary.tenants ?? 0} label="companies touched" edge="var(--warning)" />
              <Kpi value={`${summary.open ?? 0} / ${summary.untouched ?? 0}`}
                label="open · never judged" edge="var(--ink)" />
            </div>

            {error && (
              <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                  borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
                {error}
              </div>
            )}

            <div className="mt-20 flex flex-wrap items-end gap-10">
              {KINDS.map(k => {
                const active = kind === k;
                return (
                  <button key={k || "all"} type="button" onClick={() => setKind(k)}
                    className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                    style={{
                      borderColor: active ? "var(--adm-accent)" : "var(--adm-line)",
                      background: active ? "var(--adm-accent-soft)" : "transparent",
                      color: active ? "var(--adm-accent)" : "var(--ink-soft)"
                    }}>
                    {k ? KIND_LABEL[k] : "Both"}
                  </button>
                );
              })}
              <span className="mx-6 h-[20px] w-1" style={{ background: "var(--adm-line)" }} />
              {STATES.map(s => {
                const active = state === s;
                return (
                  <button key={s || "any"} type="button" onClick={() => setState(s)}
                    className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                    style={{
                      borderColor: active ? "var(--adm-accent)" : "var(--adm-line)",
                      background: active ? "var(--adm-accent-soft)" : "transparent",
                      color: active ? (STATE_EDGE[s] ?? "var(--adm-accent)") : "var(--ink-soft)"
                    }}>
                    {s ? STATE_LABEL[s] : "Any judgement"}
                  </button>
                );
              })}
              <label className="ml-auto block">
                <span className="sr-only">Search the register</span>
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search message, path, code or route" maxLength={200}
                  className={`${INPUT} min-w-[240px]`} style={INPUT_STYLE} />
              </label>
              <label>
                <span className="sr-only">Window</span>
                <select value={days} onChange={e => setDays(Number(e.target.value))}
                  className={INPUT} style={INPUT_STYLE}>
                  {WINDOWS.map(d => <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>)}
                </select>
              </label>
              <button type="button" onClick={load}
                className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>
                Reload
              </button>
            </div>

            <div className="mt-20 space-y-16">
              {lines.map(l => <LineCard key={l.fingerprint} line={l} manage={manage} onJudged={judge} />)}

              {!lines.length && !loading && (
                <div className="rounded-card border p-24" style={CARD}>
                  <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                    {filtered ? "Nothing matches that filter." : "The register is empty."}
                  </p>
                  <p className="mt-8 max-w-[720px] text-sm" style={{ color: "var(--ink-soft)" }}>
                    {filtered
                      ? "The filters go to the register itself, so an empty answer means nothing matched it — not that nothing failed."
                      : "No 5xx from the API and no uncaught failure from a browser inside this window. Widen the window above before reading that as a healthy system: the register only holds what has been kept, and pruning is a decision this desk makes on purpose."}
                  </p>
                </div>
              )}
            </div>

            {manage && (
              <section className="mt-32 rounded-card border p-20" style={CARD}>
                <h2 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                  Retention
                </h2>
                <p className="mt-8 max-w-[760px] text-sm" style={{ color: "var(--ink-soft)" }}>
                  Lines older than the number below are deleted, with their stacks and their triage
                  notes. Nothing runs this on a timer — the register is evidence, so clearing it is
                  an operator decision and is audited as <code>control.error.retention</code>.
                </p>
                <div className="mt-14 flex flex-wrap items-end gap-12">
                  <label className="block">
                    <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
                      style={{ color: "var(--ink-soft)" }}>Keep the last (days)</span>
                    <input type="number" min={7} max={3650} value={keepDays}
                      onChange={e => { setKeepDays(Number(e.target.value)); setArmed(false); }}
                      className={`${INPUT} w-[120px]`} style={INPUT_STYLE} />
                  </label>
                  <button type="button"
                    onClick={() => { if (!armed) { setArmed(true); return; } if (!pruning) prune(); }}
                    disabled={pruning || !(keepDays >= 7 && keepDays <= 3650)}
                    className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-40"
                    style={{
                      borderColor: armed ? "var(--danger)" : "var(--adm-line)",
                      color: armed ? "var(--danger)" : "var(--ink)"
                    }}>
                    {pruning ? "Pruning" : armed ? "Tap again to delete the old lines" : "Prune older lines"}
                  </button>
                  {pruneNote && <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>{pruneNote}</span>}
                </div>
              </section>
            )}

            <p className="mt-32 text-xs" style={{ color: "var(--ink-soft)" }}>
              Server lines come from the API&rsquo;s own 500s; browser lines from{" "}
              <code>web/components/ErrorReporter.tsx</code> and the render boundary at{" "}
              <code>web/app/error.tsx</code>. Both fold into one register in <code>app_errors</code>{" "}
              (082), grouped by minute and fingerprinted so the same bug is one line however many
              seats it hit. The counts agree with the{" "}
              <Link href="/control/system" className="underline" style={{ color: "var(--adm-accent)" }}>
                technical report
              </Link>{" "}
              because both read <code>platform_auth.error_summary</code>.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
