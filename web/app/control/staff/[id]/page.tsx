"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";
import { SeatFace } from "@/components/SeatFace";
import { ProgressRing } from "@/components/ProgressRing";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
const WINDOWS = [7, 30, 90, 180];

type Duty = {
  key: string; name: string; granted_at: string; expires_at: string | null;
  permissions: { key: string; description: string | null }[];
};
type CatalogDuty = {
  key: string; name: string; is_system: boolean; holders: number;
  permissions: { key: string; description: string | null }[];
};
type Profile = {
  can_manage: boolean; is_self: boolean; user_id: string;
  full_name: string | null; job_title: string | null; email: string; status: string;
  language: string | null; timezone: string | null; totp_enabled: boolean;
  last_login_at: string | null; created_at: string; tenure_days: number;
  avatar_document_id: string | null;
  duties: Duty[]; permission_keys: string[];
  stats: {
    window_days: number; events_in_window: number; events_previous_window: number;
    events_last_7d: number; trend_pct: number | null; entities_touched: number;
    days_active: number; last_event_at: string | null; active_sessions: number;
  };
  workload: { day: string; events: number }[];
  duty_mix: { action: string; events: number; last_seen: string }[];
  work_log: {
    id: string; ts: string; action: string; actor_role: string | null;
    entity: string | null; entity_id: string | null; request_id: string | null;
  }[];
};

const STATUS_EDGE: Record<string, string> = {
  active: "var(--success)", suspended: "var(--warning)", deactivated: "var(--danger)"
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
};
const short = (id: string | null) => (id ? id.slice(0, 8) : "—");

/** One number with a caption under it — the shape every tile on this page takes. */
function Tile({ value, label, sub, color }:
  { value: string | number; label: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-card border px-16 py-12" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <p className="text-xl font-bold tabular-nums" style={{ color: color ?? "var(--ink)" }}>{value}</p>
      <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</p>
      {sub ? <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>{sub}</p> : null}
    </div>
  );
}

export default function ControlStaffProfilePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [p, setP] = useState<Profile | null>(null);
  const [catalog, setCatalog] = useState<CatalogDuty[]>([]);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);

  const load = useCallback(async (win: number) => {
    const res = await fetch(`${API}/api/v1/control/staff/${id}?days=${win}`, { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    if (res.status === 404) { setMissing(true); setLoading(false); return; }
    if (!res.ok) { setError("The desk did not answer."); setLoading(false); return; }
    const j: Profile = await res.json();
    setP(j);
    setName(j.full_name ?? "");
    setTitle(j.job_title ?? "");
    setPicked(j.duties.map((d) => d.key));
    setMissing(false); setError(null); setLoading(false);
  }, [id]);

  useEffect(() => {
    load(days);
  }, [load, days]);

  useEffect(() => {
    (async () => {
      const r = await fetch(`${API}/api/v1/control/staff/roles`, { credentials: "include" });
      if (r.ok) setCatalog((await r.json()).roles ?? []);
    })();
  }, []);

  async function post(path: string, body: any, done: string, withReason = false) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch(`${API}/api/v1${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "The platform refused that."); return false; }
      setNotice(done);
      if (withReason) setReason("");
      await load(days);
      return true;
    } finally {
      setBusy(false); setArmed(null);
    }
  }

  async function patchIdentity() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch(`${API}/api/v1/control/staff/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ jobTitle: title.trim() || null, fullName: name.trim() || undefined })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "The platform refused that."); return; }
      setNotice("The seat is called that now.");
      await load(days);
    } finally { setBusy(false); }
  }

  async function uploadPicture() {
    if (!file) { setError("Choose a picture first."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${API}/api/v1/control/staff/${id}/avatar`, {
        method: "POST", credentials: "include", body: fd
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "That picture was not accepted."); return; }
      setNotice(j.replaced ? "The old picture is retired; this one is on the roster now."
        : "The picture is on the roster.");
      setFile(null);
      await load(days);
    } finally { setBusy(false); setArmed(null); }
  }

  const setStatus = (status: string) =>
    post(`/control/staff/${id}/status`, { status, reason: reason.trim() },
      status === "active" ? `${p?.full_name ?? "That seat"} is back on the desk.`
        : `${p?.full_name ?? "That seat"} is ${status} and signed out of every device.`,
      true);

  const assignDuties = () =>
    post(`/control/staff/${id}/roles`, { roleKeys: picked },
      picked.length ? "Duties replaced — the seat now holds exactly these."
        : "Every platform duty has been withdrawn from this seat.", false);

  // Armed on the first tap, executed on the second — these write to another person's
  // account and their access, and a stray click must cost nothing.
  const twoTap = (key: string, run: () => void) => () => {
    if (armed !== key) { setArmed(key); setError(null); return; }
    run();
  };

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const btn = "rounded-input border px-14 py-8 text-xs font-semibold";

  const head = (
    <header className="flex flex-wrap items-center justify-between px-24 py-12"
      style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
      <div>
        <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
          {p?.can_manage ? "Super Admin" : "Read-only"} · Duty profile
        </p>
      </div>
      <AnnouncementTicker />
      <ControlNav />
    </header>
  );

  const card = (title2: string, note: string, body: React.ReactNode, aside?: React.ReactNode) => (
    <section className="mt-28 overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-8 border-b px-16 py-12" style={{ borderColor: "var(--line)" }}>
        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>{title2}</h2>
          <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>{note}</p>
        </div>
        {aside}
      </div>
      <div className="p-16">{body}</div>
    </section>
  );

  if (forbidden || missing || loading || !p) {
    return (
      <div className="control-shell page-shell flex-1">
        {head}
        <main className="mx-auto max-w-[900px] px-16 py-32">
          {missing ? (
            <div className="rounded-card border p-24" style={{ borderColor: "var(--line)" }}>
              <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>No such platform seat</h1>
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                It was never on this desk, or it belongs to a company rather than to WAISHA.
                A company's own director is signed in at their portal, not here.
              </p>
              <Link href="/control/staff" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
                Back to the roster
              </Link>
            </div>
          ) : forbidden ? (
            <div className="rounded-card border p-24" style={{ borderColor: "var(--line)" }}>
              <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>This desk is not yours</h1>
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                The roster needs the duty <code>control.staff.view</code>. Your own control panel is
                still open to you.
              </p>
              <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
                Back to the control panel
              </Link>
            </div>
          ) : (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Loading this seat…</p>
          )}
        </main>
      </div>
    );
  }

  const maxDay = Math.max(1, ...p.workload.map((w) => w.events));
  const maxMix = Math.max(1, ...p.duty_mix.map((m) => m.events));
  const trend = p.stats.trend_pct;
  const activePct = Math.round((p.stats.days_active / p.stats.window_days) * 100);
  const canEdit = p.can_manage && !p.is_self;

  return (
    <div className="control-shell page-shell flex-1">
      {head}
      <main className="mx-auto max-w-[1180px] px-16 py-32">
        <Link href="/control/staff" className="text-xs font-semibold underline" style={{ color: "var(--adm-accent)" }}>
          ← The roster
        </Link>

        {/* ---------- who ---------- */}
        <div className="mt-12 flex flex-wrap items-start gap-24">
          <SeatFace userId={p.user_id} avatarDocumentId={p.avatar_document_id}
            name={p.full_name} email={p.email} size={96} />
          <div className="min-w-[260px] flex-1">
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>{p.full_name ?? "—"}</h1>
            <p className="mt-4 text-sm" style={{ color: "var(--ink-soft)" }}>
              {p.job_title ? `${p.job_title} · ` : ""}{p.email}
            </p>
            <p className="mt-8 flex flex-wrap items-center gap-12 text-xs" style={{ color: "var(--ink-soft)" }}>
              <span className="px-8 py-4 text-[10px] font-bold uppercase"
                style={{ borderLeft: `4px solid ${STATUS_EDGE[p.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                {p.status}
              </span>
              {p.is_self && (
                <span className="px-8 py-4 text-[10px] font-bold uppercase tracking-[0.12em]"
                  style={{ background: "var(--adm-accent-soft)", color: "var(--adm-accent)", borderRadius: 999 }}>
                  this is you
                </span>
              )}
              {!p.can_manage && (
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--warning)" }}>
                  read-only duty
                </span>
              )}
              <span>second factor {p.totp_enabled ? "on" : "off"}</span>
              <span>signed in {ago(p.last_login_at)}</span>
              <span>{p.tenure_days} days on the desk</span>
              <span>{p.language ?? "—"} / {p.timezone ?? "—"}</span>
            </p>
          </div>
          <div className="flex flex-col items-center gap-8">
            <ProgressRing value={activePct} size={96} label="%" />
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              {p.stats.days_active} of {p.stats.window_days} days worked
            </p>
          </div>
        </div>

        {notice && (
          <div className="mt-20 rounded-input px-12 py-8 text-sm" role="status"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="mt-20 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
            {error}
          </div>
        )}

        {/* ---------- progress ---------- */}
        {card(
          "Progress",
          `Counted from this seat's own trail entries over ${p.stats.window_days} days, against the ${p.stats.window_days} days before that.`,
          <div className="grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <Tile value={p.stats.events_in_window} label={`Actions · ${p.stats.window_days}d`}
              sub={trend === null ? "no previous window to compare"
                : `${trend > 0 ? "+" : ""}${trend}% against the ${p.stats.window_days}d before`}
              color={trend === null ? undefined : trend >= 0 ? "var(--success)" : "var(--warning)"} />
            <Tile value={p.stats.events_last_7d} label="Actions · last 7d" />
            <Tile value={p.stats.entities_touched} label="Kinds of thing touched" sub="distinct entities in the window" />
            <Tile value={p.stats.active_sessions} label="Live sessions"
              color={p.stats.active_sessions ? "var(--success)" : undefined} />
          </div>,
          <div className="flex items-center gap-6">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Window</span>
            {WINDOWS.map((w) => (
              <button key={w} type="button" onClick={() => setDays(w)} className={btn}
                style={{
                  borderColor: w === days ? "var(--adm-accent)" : "var(--line)",
                  color: w === days ? "var(--adm-accent)" : "var(--ink-soft)"
                }}>{w}d</button>
            ))}
          </div>
        )}

        {/* ---------- the day-by-day line ---------- */}
        {card(
          "Work, day by day",
          "Dar es Salaam days, because a chart that lands someone's Tuesday on their Monday reads as laziness.",
          p.workload.every((w) => w.events === 0) ? (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
              Nothing written down in this window. Either the seat has been quiet or it works
              somewhere that has not been wired into the trail yet.
            </p>
          ) : (
            <>
              <div className="flex items-end gap-1" style={{ height: 140 }}
                role="img" aria-label={`${p.stats.events_in_window} actions across ${p.workload.length} days`}>
                {p.workload.map((w) => (
                  <div key={w.day} className="flex-1" title={`${w.day} — ${w.events} action${w.events === 1 ? "" : "s"}`}
                    style={{
                      height: w.events ? `${Math.max(3, Math.round((w.events / maxDay) * 100))}%` : 2,
                      background: w.events ? "var(--adm-accent)" : "var(--adm-line)",
                      borderRadius: "2px 2px 0 0", opacity: w.events ? 1 : 0.45, minWidth: 3
                    }} />
                ))}
              </div>
              <div className="mt-8 flex justify-between text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                <span>{p.workload[0]?.day}</span>
                <span>peak {maxDay} in a day</span>
                <span>{p.workload[p.workload.length - 1]?.day}</span>
              </div>
            </>
          )
        )}

        {/* ---------- duty mix ---------- */}
        {card(
          "What the work was",
          "The twelve busiest action names in the window, with the last time each one happened.",
          p.duty_mix.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No action recorded in this window.</p>
          ) : (
            <ul className="space-y-8">
              {p.duty_mix.map((m) => (
                <li key={m.action} className="flex items-center gap-12">
                  <span className="w-[220px] shrink-0 truncate text-xs" style={{ color: "var(--ink)" }} title={m.action}>
                    {m.action}
                  </span>
                  <span className="h-8 flex-1 overflow-hidden rounded-full" style={{ background: "var(--adm-line)" }}>
                    <span className="block h-full rounded-full" style={{
                      width: `${Math.max(2, Math.round((m.events / maxMix) * 100))}%`, background: "var(--adm-accent)"
                    }} />
                  </span>
                  <span className="w-10 text-right text-xs tabular-nums" style={{ color: "var(--ink)" }}>{m.events}</span>
                  <span className="w-[92px] text-right text-[10px]" style={{ color: "var(--ink-soft)" }}>{ago(m.last_seen)}</span>
                </li>
              ))}
            </ul>
          )
        )}

        {/* ---------- duties ---------- */}
        {card(
          "Duties held",
          p.duties.length
            ? `Lived right now, with every key they grant — ${p.permission_keys.length} distinct permissions.`
            : "This seat holds no platform duty, so it can sign in and see nothing.",
          <div className="space-y-16">
            <div className="grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
              {p.duties.map((d) => (
                <div key={d.key} className="rounded-input border p-12" style={{ borderColor: "var(--line)" }}>
                  <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{d.name}</p>
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: "var(--adm-accent)" }}>{d.key}</p>
                  <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    granted {when(d.granted_at)}{d.expires_at ? ` · lapses ${when(d.expires_at)}` : " · no end date"}
                  </p>
                  <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {d.permissions.length ? d.permissions.map((x) => x.description ?? x.key).join(" · ") : "grants no keys"}
                  </p>
                </div>
              ))}
            </div>
            <div>
              <p className="mb-8 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Permission keys this seat can use
              </p>
              <div className="flex flex-wrap gap-6">
                {p.permission_keys.map((k) => (
                  <code key={k} className="px-8 py-4 text-[10px]"
                    style={{ background: "var(--milk-deep)", color: "var(--ink-soft)", borderRadius: 4 }}>{k}</code>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---------- hand the duties over ---------- */}
        {p.can_manage && (
          card(
            "Hand these duties over",
            canEdit
              ? "The set below replaces what the seat holds — untick a duty and it is withdrawn. A seat cannot re-write its own keys, which is why this box is closed on your own profile."
              : "You are signed in as this seat. Re-writing your own duties is refused by design: it is how a platform loses its keys in one click.",
            canEdit ? (
              <div className="space-y-16">
                <div className="grid gap-8" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
                  {catalog.map((d) => {
                    const on = picked.includes(d.key);
                    return (
                      <label key={d.key} className="flex cursor-pointer items-start gap-10 rounded-input border px-12 py-8"
                        style={{ borderColor: on ? "var(--adm-accent)" : "var(--line)", background: on ? "var(--adm-accent-soft)" : "transparent" }}>
                        <input type="checkbox" checked={on} className="mt-4"
                          onChange={() => setPicked((s) => s.includes(d.key) ? s.filter((k) => k !== d.key) : [...s, d.key])} />
                        <span className="min-w-0">
                          <span className="block text-xs font-semibold" style={{ color: "var(--ink)" }}>{d.name}</span>
                          <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {d.key} · {d.permissions.length} keys · {d.holders} seat{d.holders === 1 ? "" : "s"} hold it
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <button type="button" disabled={busy} onClick={twoTap("roles", assignDuties)}
                  className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold"
                  style={armed === "roles"
                    ? { background: "var(--adm-accent-soft)", color: "var(--adm-accent)" } : undefined}>
                  {armed === "roles" ? "Tap again to replace the duties"
                    : `Set ${picked.length} dut${picked.length === 1 ? "y" : "ies"}`}
                </button>
              </div>
            ) : null
          )
        )}

        {/* ---------- the desk or off it ---------- */}
        {p.can_manage && (
          card(
            "On the desk, or off it",
            canEdit
              ? "Taking a seat off the desk also ends every session it holds, in the same write — the panel would otherwise keep reading a token that was issued before the suspension."
              : "You cannot put your own control session out of service from this desk.",
            canEdit ? (
              <div className="space-y-16">
                <div className="flex flex-wrap gap-16">
                  {(["suspended", "deactivated", "active"] as const)
                    .filter((s) => s !== p.status)
                    .map((s) => (
                      <button key={s} type="button" disabled={busy}
                        onClick={twoTap(`status-${s}`, () => {
                          if (reason.trim().length < 4) {
                            setError("A change of status needs a reason in the record — the next person at this desk has to read it.");
                            setArmed(null);
                            return;
                          }
                          setStatus(s);
                        })}
                        className={btn}
                        style={{
                          borderColor: s === "active" ? "var(--success)" : s === "suspended" ? "var(--warning)" : "var(--danger)",
                          color: "var(--ink)",
                          background: armed === `status-${s}` ? "var(--adm-accent-soft)" : undefined
                        }}>
                        {armed === `status-${s}` ? "Tap again to confirm" : `Mark ${s}`}
                      </button>
                    ))}
                  <button type="button" disabled={busy} onClick={twoTap("revoke", () =>
                    post(`/control/staff/${id}/sessions/revoke`, {}, "Their sessions are ended; the next call needs a fresh sign-in.", false))}
                    className={btn} style={{ borderColor: "var(--line)", color: "var(--ink)",
                      background: armed === "revoke" ? "var(--adm-accent-soft)" : undefined }}>
                    {armed === "revoke" ? "Tap again to sign them out" : "End their sessions"}
                  </button>
                </div>
                <input value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason for the record (needed to take a seat off the desk)"
                  className={inputCls} style={inputStyle} />
              </div>
            ) : null
          )
        )}

        {/* ---------- the work log ---------- */}
        {card(
          "Work log",
          "The last forty things this seat did, with the request id so a strand can be followed into the forensic reader. Payloads are not shown here — that is control.audit.view.",
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className="p-8">When</th>
                  <th className="p-8">Action</th>
                  <th className="p-8">As</th>
                  <th className="p-8">Thing</th>
                  <th className="p-8 text-right">Request</th>
                </tr>
              </thead>
              <tbody>
                {p.work_log.map((l, i) => (
                  <tr key={l.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className="p-8 whitespace-nowrap tabular-nums" style={{ color: "var(--ink-soft)" }} title={when(l.ts)}>
                      {ago(l.ts)}
                    </td>
                    <td className="p-8 font-semibold" style={{ color: "var(--ink)" }}>{l.action}</td>
                    <td className="p-8" style={{ color: "var(--ink-soft)" }}>{l.actor_role ?? "—"}</td>
                    <td className="p-8" style={{ color: "var(--ink-soft)" }}>
                      {l.entity ?? "—"} <span className="opacity-60">{short(l.entity_id)}</span>
                    </td>
                    <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{short(l.request_id)}</td>
                  </tr>
                ))}
                {p.work_log.length === 0 && (
                  <tr><td colSpan={5} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    This seat has never written to the trail.
                  </td></tr>
                )}
              </tbody>
              </table>
            </div>
            <Link href={`/control/forensics?actor=${p.user_id}`}
              className="mt-14 inline-block text-[11px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: "var(--adm-accent)" }}>
              Open this seat in the forensic desk →
            </Link>
          </>
        )}

        {/* ---------- the picture and the name ---------- */}
        {p.can_manage && (
          card(
            "What the roster shows",
            "A real JPEG, PNG or WebP under 2 MB. The file is sniffed, not trusted — a document renamed to .png is refused before it is stored.",
            <div className="grid gap-24" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
              <div className="space-y-12">
                <label className="block text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                  Picture
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="mt-8 block w-full text-xs"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={!p.can_manage} />
                </label>
                <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {file ? `${file.name} · ${Math.round(file.size / 1024)} kB` : "No file chosen — the seat keeps the picture on file."}
                </p>
                <button type="button" disabled={busy || !file} onClick={uploadPicture}
                  className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                  {busy && file ? "Uploading" : p.avatar_document_id ? "Replace the picture" : "Upload the picture"}
                </button>
              </div>
              <div className="space-y-12">
                <label className="block text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                  Name
                  <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputCls} mt-8`}
                    style={inputStyle} disabled={busy} />
                </label>
                <label className="block text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                  Job title
                  <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${inputCls} mt-8`}
                    style={inputStyle} disabled={busy} placeholder="e.g. Compliance officer, Dar desk" />
                </label>
                <button type="button" disabled={busy} onClick={patchIdentity}
                  className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                  Save the name and title
                </button>
                <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {p.is_self ? "A seat may fix its own name — duties and status are the two things it may not touch."
                    : "The seat's own sign-in name and the title shown on the roster."}
                </p>
              </div>
            </div>
          )
        )}

        <p className="mt-28 text-xs" style={{ color: "var(--ink-soft)" }}>
          Joined {when(p.created_at)} · every figure above is this seat's own trail inside the platform
          tenant, so a company's staff can never appear here.
        </p>
      </main>
    </div>
  );
}
