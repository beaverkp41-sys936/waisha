"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The forensic desk (066's trail + 071's actor register).
 *
 * A forensic read starts from a person, not from a row. The register up top answers
 * "who has been in the system, and how far did they reach"; picking one narrows the
 * trail underneath to them. Both halves come from SECURITY DEFINER readers because
 * every row here belongs to somebody else's tenant — a bare query would answer with
 * 200 and an empty list, which on a log looks exactly like a quiet system.
 *
 * Read-only by construction: there is no fetch with a method on this page. The trail
 * is append-only and this desk's job is to show it, including what the redactor
 * withheld — a "[redacted]" cell is part of the evidence that the screen shows rather
 * than hides.
 */

type Actor = {
  actor_user_id: string; actor_name: string | null; actor_email: string | null;
  actor_type: string | null; account_status: string | null;
  tenant_id: string | null; tenant_name: string | null;
  events: number; distinct_actions: number; distinct_entities: number;
  distinct_ips: number; tenants_touched: number;
  first_seen: string; last_seen: string;
};

type TrailRow = {
  id: string; ts: string; tenant_id: string | null; tenant_name: string | null;
  actor_user_id: string | null; actor_name: string | null; actor_email: string | null;
  actor_role: string | null; ip: string | null;
  entity: string; entity_id: string | null; action: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};

const WINDOWS = [
  { days: 1, label: "24 h" }, { days: 7, label: "7 d" },
  { days: 30, label: "30 d" }, { days: 90, label: "90 d" },
  { days: 365, label: "a year" }
];

const CARD_STYLE = { borderColor: "var(--line)", background: "var(--surface)" };
const INPUT = "rounded-input border px-10 py-6 text-xs";
const INPUT_STYLE = { borderColor: "var(--adm-line)", background: "transparent", color: "var(--ink)" };
const TH = "px-10 py-6 text-left text-[10px] font-bold uppercase tracking-[0.12em]";
const TD = "px-10 py-6 text-xs align-top";

const TZ = "Africa/Dar_es_Salaam";

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
  if (days < 400) return `${days} d ago`;
  return clock(iso);
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: TZ
  });
}

/** Everything on one person's row is an integer; a zero is a fact, not an absence. */
function Metric({ value, label, warn }: { value: number; label: string; warn?: boolean }) {
  return (
    <div className="min-w-[64px]">
      <p className="text-[15px] font-bold tabular-nums"
        style={{ color: warn ? "var(--warning)" : "var(--ink)" }}>
        {value ?? 0}
      </p>
      <p className="text-[9px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: "var(--ink-soft)" }}>
        {label}
      </p>
    </div>
  );
}

/**
 * before/after are row snapshots with the sensitive columns already replaced by
 * "[redacted]" inside the reader. The union of their keys is what actually changed —
 * a column present in one and not the other is a set or a clear, so it is shown too.
 */
function diffCells(before: Record<string, unknown> | null,
  after: Record<string, unknown> | null): { key: string; from: string; to: string }[] {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  const show = (v: unknown) => v === undefined ? "—"
    : v === null ? "null"
      : typeof v === "object" ? JSON.stringify(v)
        : String(v);
  return keys.sort().map(key => ({
    key,
    from: show((before ?? {})[key]),
    to: show((after ?? {})[key])
  }));
}

function TrailCard({ row }: { row: TrailRow }) {
  const [open, setOpen] = useState(false);
  const cells = useMemo(() => diffCells(row.before, row.after), [row.before, row.after]);
  const changed = cells.some(c => c.from !== c.to);

  return (
    <div className="rounded-card border" style={CARD_STYLE}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className="flex w-full flex-wrap items-start gap-10 p-14 text-left">
        <span className="rounded-input px-8 py-4 text-[10px] font-mono"
          style={{ background: "var(--adm-accent-soft)", color: "var(--adm-accent)" }}
          title={row.ts}>
          {ago(row.ts)}
        </span>
        <span className="min-w-[200px] flex-1">
          <span className="block text-sm font-semibold" style={{ color: "var(--ink)" }}>
            {row.action}
          </span>
          <span className="mt-2 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
            {row.actor_name ?? "an identity nobody recognised"}
            {row.actor_email ? ` · ${row.actor_email}` : ""}
            {row.actor_role ? ` · ${row.actor_role}` : ""}
            {row.tenant_name ? ` · ${row.tenant_name}` : " · no company on the row"}
          </span>
        </span>
        <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
          <span className="block font-semibold" style={{ color: "var(--ink)" }}>
            {row.entity}
          </span>
          <span className="mt-2 block font-mono text-[10px]">
            {(row.entity_id ?? "").slice(0, 8)}
          </span>
          <span className="mt-2 block font-mono text-[10px]">{row.ip ?? "no address"}</span>
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: "var(--adm-accent)" }}>
          {cells.length ? (open ? "Hide" : "Show") : "No"} payload
        </span>
      </button>

      {open && (
        <div className="border-t px-14 pb-14" style={{ borderColor: "var(--adm-line)" }}>
          {!cells.length && (
            <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              This entry carries no before or after — the action recorded that a thing
              happened, not that a row changed.
            </p>
          )}
          {!!cells.length && (
            <>
              <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {changed
                  ? `${cells.filter(c => c.from !== c.to).length} of ${cells.length} columns differ.`
                  : `Both sides are identical — recorded, not changed.`}
              </p>
              <table className="mt-10 w-full border-collapse">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--adm-line)" }}>
                    <th className={TH} style={{ color: "var(--ink-soft)" }}>Column</th>
                    <th className={TH} style={{ color: "var(--ink-soft)" }}>Before</th>
                    <th className={TH} style={{ color: "var(--ink-soft)" }}>After</th>
                    <th className={TH} style={{ color: "var(--ink-soft)" }}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {cells.map(c => {
                    const redacted = c.from === "[redacted]" || c.to === "[redacted]";
                    return (
                      <tr key={c.key} style={{ borderBottom: "1px solid var(--adm-line)" }}>
                        <td className={TD} style={{ color: "var(--ink-soft)" }}>{c.key}</td>
                        <td className={`${TD} font-mono`}
                          style={{ color: c.from === c.to ? "var(--ink-soft)" : "var(--ink)" }}>
                          {c.from}
                        </td>
                        <td className={`${TD} font-mono`}
                          style={{ color: c.from === c.to ? "var(--ink-soft)" : "var(--success)" }}>
                          {c.to}
                        </td>
                        <td className={TD} style={{ color: "var(--warning)" }}>
                          {redacted ? "withheld" : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-10 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                National IDs, phones, emails, tax numbers, passwords, tokens and one-time
                codes are withheld by the reader, not by this page.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function ControlForensicsPage() {
  const [me, setMe] = useState<any>(null);
  const [forbidden, setForbidden] = useState(false);

  const [days, setDays] = useState(30);
  const [who, setWho] = useState("");
  const [actors, setActors] = useState<Actor[]>([]);
  const [actorErr, setActorErr] = useState("");
  const [actorLoading, setActorLoading] = useState(true);

  const [focus, setFocus] = useState<{ id: string; name: string } | null>(null);
  const [action, setAction] = useState("");
  const [entity, setEntity] = useState("");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(100);
  const [vocabulary, setVocabulary] = useState<string[]>([]);
  const [rows, setRows] = useState<TrailRow[]>([]);
  const [trailErr, setTrailErr] = useState("");
  const [trailLoading, setTrailLoading] = useState(true);

  const loadActors = useCallback(async (windowDays: number) => {
    setActorLoading(true); setActorErr("");
    try {
      const res = await fetch(`${API}/api/v1/control/audit/actors?days=${windowDays}&limit=500`,
        { credentials: "include" });
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const json = await res.json();
      setActors(Array.isArray(json) ? json : []);
    } catch {
      setActorErr("The actor register did not answer.");
    } finally {
      setActorLoading(false);
    }
  }, []);

  const loadTrail = useCallback(async () => {
    setTrailLoading(true); setTrailErr("");
    const params = new URLSearchParams();
    if (focus) params.set("actorUserId", focus.id);
    if (action) params.set("action", action);
    if (entity.trim()) params.set("entity", entity.trim());
    if (q.trim()) params.set("q", q.trim());
    params.set("from", new Date(Date.now() - days * 86400000).toISOString());
    params.set("limit", String(limit));
    try {
      const res = await fetch(`${API}/api/v1/control/audit?${params}`,
        { credentials: "include" });
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const json = await res.json();
      setRows(Array.isArray(json) ? json : []);
    } catch {
      setTrailErr("The trail did not answer.");
    } finally {
      setTrailLoading(false);
    }
  }, [focus, action, entity, q, days, limit]);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const p = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (p.ok) {
        const j = await p.json();
        if (!(j.permissions ?? []).includes("control.audit.view")) setForbidden(true);
      }
    })();
  }, []);

  useEffect(() => { loadActors(days); }, [days, loadActors]);
  useEffect(() => { loadTrail(); }, [loadTrail]);

  // The vocabulary pick-list comes from the same table, so the desk never offers a
  // free-text guess at an action name it cannot match.
  useEffect(() => {
    (async () => {
      const res = await fetch(`${API}/api/v1/control/audit/actions?days=${days}`,
        { credentials: "include" });
      if (!res.ok) return;
      const json = await res.json();
      setVocabulary((Array.isArray(json) ? json : []).map((r: any) => r.action as string));
    })();
  }, [days]);

  // A link from a seat's profile arrives as ?actor=; it is read once, here rather than via
  // useSearchParams, so the desk stays a plain client page. The name is filled in when the
  // register lands, because this effect must not re-run every time it does.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("actor");
    if (id) setFocus({ id, name: "the seat this link was opened from" });
  }, []);

  useEffect(() => {
    if (!focus) return;
    const known = actors.find(a => a.actor_user_id === focus.id);
    if (known && focus.name !== (known.actor_name ?? known.actor_email ?? "")) {
      setFocus({ id: known.actor_user_id,
        name: known.actor_name ?? known.actor_email ?? "this person" });
    }
  }, [actors, focus]);

  const shown = useMemo(() => {
    const needle = who.trim().toLowerCase();
    if (!needle) return actors;
    return actors.filter(a => [a.actor_name, a.actor_email, a.tenant_name, a.actor_type]
      .some(v => (v ?? "").toLowerCase().includes(needle)));
  }, [actors, who]);

  const totals = useMemo(() => ({
    events: actors.reduce((s, a) => s + (a.events ?? 0), 0),
    reached: actors.reduce((s, a) => Math.max(s, a.tenants_touched ?? 0), 0)
  }), [actors]);

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between gap-16 px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--adm-accent)" }}>
            Platform · Forensics
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1120px] px-16 py-32">
        {forbidden ? (
          <div className="rounded-card border p-24" style={CARD_STYLE}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              The forensic desk is not open to this seat
            </h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ")
                || "no platform duty"}. This desk reads every company's trail, so it needs
              the duty <code>control.audit.view</code>.
            </p>
            <Link href="/control"
              className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
              Every action anyone has taken on the platform
            </h1>
            <p className="mt-8 max-w-[880px] text-sm" style={{ color: "var(--ink-soft)" }}>
              {actorLoading
                ? "Reading the trail…"
                : `${actors.length} people acted in this window · ${totals.events} entries · `
                  + `the widest reach in one seat is ${totals.reached} ${totals.reached === 1 ? "company" : "companies"}`}
              . This desk reads the log and writes nothing to it; the trail is append-only,
              so a row that is here cannot have been edited since.
            </p>

            <div className="mt-20 flex flex-wrap items-end gap-10">
              {WINDOWS.map(w => {
                const active = days === w.days;
                return (
                  <button key={w.days} type="button" onClick={() => setDays(w.days)}
                    className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                    style={{
                      borderColor: active ? "var(--adm-accent)" : "var(--adm-line)",
                      background: active ? "var(--adm-accent-soft)" : "transparent",
                      color: active ? "var(--adm-accent)" : "var(--ink-soft)"
                    }}>
                    {w.label}
                  </button>
                );
              })}
              <Link href="/control"
                className="ml-auto rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>
                Control overview
              </Link>
            </div>

            {/* ---------------- the people ---------------- */}
            <section className="mt-28">
              <div className="flex flex-wrap items-center gap-12">
                <h2 className="text-sm font-bold uppercase tracking-[0.14em]"
                  style={{ color: "var(--adm-accent)" }}>
                  Who has been in the system
                </h2>
                <label className="ml-auto block">
                  <span className="sr-only">Filter people by name, company or account type</span>
                  <input value={who} onChange={e => setWho(e.target.value)}
                    placeholder="Filter by name, email, company or type" maxLength={80}
                    className={`${INPUT} min-w-[280px]`} style={INPUT_STYLE} />
                </label>
              </div>

              {actorErr && (
                <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
                  style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                    borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
                  {actorErr}
                </div>
              )}

              <div className="mt-14 overflow-x-auto rounded-card border" style={CARD_STYLE}>
                <table className="w-full border-collapse">
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--adm-line)" }}>
                      <th className={TH} style={{ color: "var(--ink-soft)" }}>Person</th>
                      <th className={TH} style={{ color: "var(--ink-soft)" }}>Company</th>
                      <th className={TH} style={{ color: "var(--ink-soft)" }}>Entries</th>
                      <th className={TH} style={{ color: "var(--ink-soft)" }}>Actions</th>
                      <th className={TH} style={{ color: "var(--ink-soft)" }}>Addresses</th>
                      <th className={TH} style={{ color: "var(--ink-soft)" }}>Companies touched</th>
                      <th className={TH} style={{ color: "var(--ink-soft)" }}>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(a => {
                      const picked = focus?.id === a.actor_user_id;
                      return (
                        <tr key={a.actor_user_id}
                          style={{ borderBottom: "1px solid var(--adm-line)",
                            background: picked ? "var(--adm-accent-soft)" : "transparent" }}>
                          <td className={TD}>
                            <button type="button"
                              onClick={() => setFocus(picked ? null
                                : { id: a.actor_user_id, name: a.actor_name ?? a.actor_email ?? "this person" })}
                              className="text-left text-sm font-semibold underline-offset-2"
                              style={{ color: "var(--ink)" }}>
                              {a.actor_name ?? "a name no longer on the account"}
                            </button>
                            <span className="mt-2 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                              {a.actor_email ?? "no email on file"} · {a.actor_type ?? "unknown type"}
                              {" · "}{a.account_status ?? "unknown status"}
                            </span>
                          </td>
                          <td className={TD} style={{ color: "var(--ink-soft)" }}>
                            {a.tenant_name ?? "no company"}
                          </td>
                          <td className={TD}><Metric value={a.events} label="logged" /></td>
                          <td className={TD}><Metric value={a.distinct_actions} label="kinds" /></td>
                          <td className={TD}>
                            <Metric value={a.distinct_ips} label="source" warn={a.distinct_ips > 4} />
                          </td>
                          <td className={TD}>
                            <Metric value={a.tenants_touched} label="touched"
                              warn={a.tenants_touched > 1 && a.actor_type !== "platform"} />
                          </td>
                          <td className={TD} title={clock(a.last_seen)}>
                            <span className="block" style={{ color: "var(--ink)" }}>
                              {ago(a.last_seen)}
                            </span>
                            <span className="mt-2 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                              first {ago(a.first_seen)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                    {!shown.length && !actorLoading && (
                      <tr>
                        <td colSpan={7} className={TD} style={{ color: "var(--ink-soft)" }}>
                          {actors.length
                            ? "Nobody on this list matches that filter — the trail below is still readable."
                            : "No logged action in this window. Widen it above; on a quiet day a week is often empty."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <p className="mt-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                An address count is a person on hotel wifi or a whole office behind one NAT —
                it is a reason to look, not a finding. A non-platform seat touching more than
                one company is the number on this desk that deserves a question.
              </p>
            </section>

            {/* ---------------- the trail ---------------- */}
            <section className="mt-32">
              <div className="flex flex-wrap items-center gap-12">
                <h2 className="text-sm font-bold uppercase tracking-[0.14em]"
                  style={{ color: "var(--adm-accent)" }}>
                  The trail
                </h2>
                {focus && (
                  <span className="rounded-input px-10 py-5 text-[11px]"
                    style={{ background: "var(--adm-accent-soft)", color: "var(--adm-accent)" }}>
                    One person: {focus.name}
                    <button type="button" onClick={() => setFocus(null)}
                      className="ml-8 font-bold uppercase tracking-[0.1em]"
                      style={{ color: "var(--ink-soft)" }}>
                      clear
                    </button>
                  </span>
                )}
              </div>

              {trailErr && (
                <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
                  style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                    borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
                  {trailErr}
                </div>
              )}

              <div className="mt-14 flex flex-wrap items-end gap-10">
                <label className="block">
                  <span className="mb-4 block text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>
                    Action
                  </span>
                  <select value={action} onChange={e => setAction(e.target.value)}
                    className={`${INPUT} min-w-[220px]`} style={INPUT_STYLE}>
                    <option value="">every action</option>
                    {vocabulary.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-4 block text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>
                    Entity
                  </span>
                  <input value={entity} onChange={e => setEntity(e.target.value)}
                    placeholder="users, drivers, invoices…" maxLength={80}
                    className={`${INPUT} min-w-[160px]`} style={INPUT_STYLE} />
                </label>
                <label className="block">
                  <span className="mb-4 block text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>
                    Contains
                  </span>
                  <input value={q} onChange={e => setQ(e.target.value)}
                    placeholder="a word in any row" maxLength={200}
                    className={`${INPUT} min-w-[220px]`} style={INPUT_STYLE} />
                </label>
                <label className="block">
                  <span className="mb-4 block text-[10px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>
                    Rows
                  </span>
                  <select value={limit} onChange={e => setLimit(Number(e.target.value))}
                    className={INPUT} style={INPUT_STYLE}>
                    {[50, 100, 250, 500].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <button type="button" onClick={loadTrail}
                  className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                  style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>
                  Reload
                </button>
              </div>

              <div className="mt-16 space-y-12">
                {rows.map(r => <TrailCard key={r.id} row={r} />)}

                {!rows.length && !trailLoading && (
                  <div className="rounded-card border p-24" style={CARD_STYLE}>
                    <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      Nothing matches
                    </p>
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      The filters are combined and the window is the one at the top of the
                      page. An attempt against an identity that does not exist is logged with
                      no person on it, so it never appears in the people list — clear the
                      person filter and search the trail for the address or the name instead.
                    </p>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
