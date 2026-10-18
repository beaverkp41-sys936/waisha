"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

type Row = {
  id: string; created_at: string; tenant_id: string;
  company_name: string | null; company_type: string | null;
  author_user_id: string; author_name: string | null; author_email: string | null;
  author_type: string | null; author_job_title: string | null;
  area: string; title: string; body: string; status: string; priority: string | null;
  reply: string | null; replied_at: string | null; replied_by_name: string | null;
  decided_at: string | null; decided_by_name: string | null;
  matched: number; matched_new: number;
};

/**
 * The recommendation desk (070).
 *
 * One register across every company, read through `platform_auth.control_recommendation_register`
 * because nothing narrower can work: the rows belong to other people's tenants, and a bare
 * query would answer with zero rows on a busy system. The total and the unread count come
 * from the same statement as the rows (window counts, computed before the limit), so the
 * header line and the list underneath it cannot disagree.
 *
 * A card is the unit of work here, not a queue row: what makes a recommendation worth
 * acting on is the sentence plus who said it and from which company, and the desk needs to
 * be able to call them back. That is also the limit of what it shows — name, address, duty.
 * No phone, no NIDA, nothing from the company's own data.
 */

const STATUSES = ["new", "reviewing", "planned", "built", "declined"] as const;
const AREAS = ["transport", "cfa", "office", "marketplace", "billing",
  "documents", "account", "support", "other"];
const PRIORITIES = ["high", "medium", "low"];

const STATUS_LABEL: Record<string, string> = {
  new: "Unread", reviewing: "Reviewing", planned: "Planned", built: "Built", declined: "Declined"
};
const STATUS_EDGE: Record<string, string> = {
  new: "var(--danger)", reviewing: "var(--adm-accent)", planned: "var(--warning)",
  built: "var(--success)", declined: "var(--adm-line)"
};
const PRIORITY_EDGE: Record<string, string> = {
  high: "var(--danger)", medium: "var(--warning)", low: "var(--adm-line)"
};

const CARD_STYLE = { borderColor: "var(--line)", background: "var(--surface)" };
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

function Pill({ label, edge }: { label: string; edge: string }) {
  return (
    <span className="rounded-input px-8 py-4 text-[10px] font-bold uppercase tracking-[0.12em]"
      style={{ background: `color-mix(in srgb, ${edge} 16%, transparent)`, color: edge }}>
      {label}
    </span>
  );
}

/**
 * One card, one decision. The controls start from what the register said, so what the desk
 * sends is what it was looking at — including an empty answer box, which means "retract the
 * sentence", exactly as the definer reads it.
 */
function RecommendationCard({ row, manage, onDecided }:
  { row: Row; manage: boolean; onDecided: (id: string, patch: Partial<Row>) => void }) {
  const [status, setStatus] = useState(row.status);
  const [priority, setPriority] = useState<string>(row.priority ?? "");
  const [reply, setReply] = useState(row.reply ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    setStatus(row.status); setPriority(row.priority ?? ""); setReply(row.reply ?? "");
  }, [row.status, row.priority, row.reply]);

  async function save() {
    setBusy(true); setErr(""); setNote("");
    try {
      const res = await fetch(`${API}/api/v1/control/recommendations/${row.id}/decision`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          ...(priority ? { priority } : {}),
          reply: reply.trim() ? reply.trim() : null
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(typeof json?.message === "string" && json.message
          ? json.message : "The desk could not record that.");
        return;
      }
      onDecided(row.id, {
        status: json.status, priority: json.priority,
        reply: json.reply, replied_at: reply.trim() ? new Date().toISOString() : null,
        replied_by_name: reply.trim() ? "you" : null,
        decided_at: new Date().toISOString()
      });
      setNote("Recorded.");
    } catch {
      setErr("The desk could not record that.");
    } finally {
      setBusy(false);
    }
  }

  const changed = status !== row.status
    || (priority || null) !== row.priority
    || (reply.trim() || null) !== (row.reply ?? null);

  return (
    <article className="rounded-card border p-18"
      style={{ ...CARD_STYLE, borderLeft: `4px solid ${STATUS_EDGE[row.status] ?? "var(--line)"}` }}>
      <div className="flex flex-wrap items-center gap-8 text-[10px] font-semibold uppercase tracking-[0.12em]">
        <Pill label={STATUS_LABEL[row.status] ?? row.status} edge={STATUS_EDGE[row.status] ?? "var(--ink-soft)"} />
        {row.priority && <Pill label={row.priority} edge={PRIORITY_EDGE[row.priority] ?? "var(--ink-soft)"} />}
        <Pill label={row.area} edge="var(--adm-line)" />
        <span className="ml-auto normal-case tracking-normal" style={{ color: "var(--ink-soft)" }}>
          {ago(row.created_at)}
        </span>
      </div>

      <h3 className="mt-12 text-base font-bold" style={{ color: "var(--ink)" }}>{row.title}</h3>
      <p className="mt-8 whitespace-pre-wrap text-sm leading-relaxed" style={{ color: "var(--ink-soft)" }}>
        {row.body}
      </p>

      <div className="mt-12 flex flex-wrap gap-x-18 gap-y-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
        <span>
          From <strong style={{ color: "var(--ink)" }}>{row.author_name ?? "someone without a name"}</strong>
          {row.author_job_title ? ` · ${row.author_job_title}` : ""}
          {row.author_type ? ` · ${row.author_type}` : ""}
        </span>
        <span>
          Company <strong style={{ color: "var(--ink)" }}>{row.company_name ?? "—"}</strong>
          {row.company_type ? ` · ${row.company_type}` : ""}
        </span>
        {row.author_email && (
          <a href={`mailto:${row.author_email}`} className="underline"
            style={{ color: "var(--adm-accent)" }}>{row.author_email}</a>
        )}
      </div>

      {row.reply && (
        <p className="mt-12 rounded-input border-l-4 px-12 py-8 text-xs"
          style={{ borderLeftColor: "var(--success)",
            background: "color-mix(in srgb, var(--success) 8%, transparent)", color: "var(--ink)" }}>
          Answered by {row.replied_by_name ?? "the desk"} {ago(row.replied_at)} — {row.reply}
        </p>
      )}
      {!row.reply && row.decided_at && (
        <p className="mt-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          Triaged by {row.decided_by_name ?? "the desk"} {ago(row.decided_at)}, no answer sent yet.
        </p>
      )}

      {manage ? (
        <div className="mt-14 border-t pt-14" style={{ borderColor: "var(--adm-line)" }}>
          <div className="flex flex-wrap items-end gap-10">
            <label className="block">
              <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
                style={{ color: "var(--ink-soft)" }}>State</span>
              <select value={status} onChange={e => setStatus(e.target.value)}
                className={INPUT} style={INPUT_STYLE}>
                {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
                style={{ color: "var(--ink-soft)" }}>Priority</span>
              <select value={priority} onChange={e => setPriority(e.target.value)}
                className={INPUT} style={INPUT_STYLE}>
                <option value="">unset</option>
                {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <span className="pb-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              {row.decided_by_name
                ? `last triaged by ${row.decided_by_name} ${ago(row.decided_at)}`
                : "nobody has triaged this yet"}
            </span>
          </div>

          <label className="mt-10 block">
            <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.12em]"
              style={{ color: "var(--ink-soft)" }}>
              Answer the author (optional — 5 to 2,000 characters)
            </span>
            <textarea value={reply} onChange={e => setReply(e.target.value)} rows={3} maxLength={2000}
              placeholder="What will happen about it, or why it will not. Clearing this box retracts an answer."
              className={`${INPUT} w-full leading-relaxed`} style={INPUT_STYLE} />
          </label>

          <div className="mt-10 flex flex-wrap items-center gap-12">
            <button type="button" onClick={save} disabled={busy || !changed}
              className="rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-40"
              style={{ background: "var(--adm-accent)", color: "var(--brand-deep)" }}>
              {busy ? "Recording" : "Record decision"}
            </button>
            {changed
              ? <span className="text-[11px]" style={{ color: "var(--warning)" }}>unsaved</span>
              : <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>nothing to save</span>}
            {note && <span className="text-[11px]" style={{ color: "var(--success)" }}>{note}</span>}
            {err && (
              <span role="alert" className="text-[11px]" style={{ color: "var(--danger)" }}>{err}</span>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          This seat reads the register but does not triage it — the desk needs{" "}
          <code>control.recommendations.manage</code>.
        </p>
      )}
    </article>
  );
}

export default function ControlRecommendationsPage() {
  const [me, setMe] = useState<{ email?: string; roles?: string[] } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [manage, setManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<string>("");
  const [area, setArea] = useState("");
  const [priority, setPriority] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [unreadDelta, setUnreadDelta] = useState(0);

  // The register filters on the server, so typing filters after a short pause rather
  // than on every keystroke — the desk is a read across every tenant, not a local array.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true); setError(""); setUnreadDelta(0);
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (area) params.set("area", area);
    if (priority) params.set("priority", priority);
    if (q) params.set("q", q);
    try {
      const res = await fetch(`${API}/api/v1/control/recommendations?${params}`,
        { credentials: "include" });
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const json = await res.json();
      setRows(Array.isArray(json) ? json : []);
    } catch {
      setError("The register did not answer.");
    } finally {
      setLoading(false);
    }
  }, [status, area, priority, q]);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const p = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (p.ok) {
        const j = await p.json();
        setManage((j.permissions ?? []).includes("control.recommendations.manage"));
      }
    })();
  }, []);

  useEffect(() => { load(); }, [load]);

  const patch = useCallback((id: string, changes: Partial<Row>) => {
    const before = rows.find(r => r.id === id);
    if (before && (before.status === "new") !== (changes.status === "new")) {
      setUnreadDelta(d => d + (changes.status === "new" ? 1 : -1));
    }
    setRows(cur => cur.map(r => (r.id === id ? { ...r, ...changes } : r)));
  }, [rows]);

  const counts = useMemo(() => {
    const first = rows[0];
    // matched_new is a window count from the fetch, so a triage the desk just made is not
    // in it — the header would contradict the card underneath it until the next reload.
    return {
      total: first?.matched ?? 0,
      unread: Math.max(0, (first?.matched_new ?? 0) + unreadDelta)
    };
  }, [rows, unreadDelta]);

  const shown = rows.length;
  // The register counts the filtered set, not the whole table — so the header has to say
  // which of the two the number is.
  const filtered = !!(status || area || priority || q);

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex items-center justify-between gap-16 px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--adm-accent)" }}>
            Platform · Recommendation inbox
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1120px] px-16 py-32">
        {forbidden ? (
          <div className="rounded-card border p-24" style={CARD_STYLE}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              The inbox is not open to this seat
            </h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ")
                || "no platform duty"}. This desk needs the duty{" "}
              <code>control.recommendations.view</code>.
            </p>
            <Link href="/control"
              className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
              What the people using WAISHA have asked for
            </h1>
            <p className="mt-8 max-w-[880px] text-sm" style={{ color: "var(--ink-soft)" }}>
              {loading ? "Reading the register…"
                : filtered
                  ? `${counts.total} matching this filter · ${counts.unread} of them unread`
                  : `${counts.total} on the register · ${counts.unread} nobody has read yet`}
              {shown !== counts.total && !loading
                ? ` · ${shown} shown here` : ""}. Triaging and answering are the only writes this
              desk makes, and both are recorded with your name on them.
            </p>

            {error && (
              <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                  borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
                {error}
              </div>
            )}

            <div className="mt-20 flex flex-wrap items-end gap-10">
              {["", ...STATUSES].map(s => {
                const active = status === s;
                return (
                  <button key={s || "all"} type="button" onClick={() => setStatus(s)}
                    className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                    style={{
                      borderColor: active ? "var(--adm-accent)" : "var(--adm-line)",
                      background: active ? "var(--adm-accent-soft)" : "transparent",
                      color: active ? "var(--adm-accent)" : "var(--ink-soft)"
                    }}>
                    {s ? STATUS_LABEL[s] : "All"}
                  </button>
                );
              })}
              <label className="ml-auto block">
                <span className="sr-only">Search the register</span>
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search title, body, company or author" maxLength={200}
                  className={`${INPUT} min-w-[260px]`} style={INPUT_STYLE} />
              </label>
              <label>
                <span className="sr-only">Area</span>
                <select value={area} onChange={e => setArea(e.target.value)}
                  className={INPUT} style={INPUT_STYLE}>
                  <option value="">every area</option>
                  {AREAS.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <label>
                <span className="sr-only">Priority</span>
                <select value={priority} onChange={e => setPriority(e.target.value)}
                  className={INPUT} style={INPUT_STYLE}>
                  <option value="">any priority</option>
                  {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </label>
              <button type="button" onClick={load}
                className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase tracking-[0.1em]"
                style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>
                Reload
              </button>
            </div>

            <div className="mt-20 space-y-16">
              {rows.map(r => (
                <RecommendationCard key={r.id} row={r} manage={manage} onDecided={patch} />
              ))}

              {!rows.length && !loading && (
                <div className="rounded-card border p-24" style={CARD_STYLE}>
                  <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                    {filtered
                      ? "Nothing matches that filter."
                      : "The register is empty."}
                  </p>
                  <p className="mt-8 max-w-[720px] text-sm" style={{ color: "var(--ink-soft)" }}>
                    {filtered
                      ? "The filters go to the register itself, so an empty answer means nothing on it matched — not that it was not asked."
                      : "Nobody has sent a recommendation yet. Accounts on the transporter, shipper and seeker portals each carry a box for it, and a note lands here the moment it is sent."}
                  </p>
                </div>
              )}
            </div>

            <p className="mt-32 text-xs" style={{ color: "var(--ink-soft)" }}>
              Authors write from <code>/app/recommendations</code>, <code>/portal/recommendations</code>{" "}
              or <code>/find/recommendations</code>; each only ever reads back its own notes. The
              register and the decision both live in <code>platform_auth</code> (070), and every
              triage is audited as{" "}
              <code>control.recommendation.decided</code> — readable on the{" "}
              <Link href="/control/staff" className="underline" style={{ color: "var(--adm-accent)" }}>staff</Link>{" "}
              desk.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
