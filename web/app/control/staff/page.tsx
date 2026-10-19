"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";
import { SeatFace } from "@/components/SeatFace";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

type Seat = {
  user_id: string; full_name: string | null; job_title: string | null; email: string;
  status: string; totp_enabled: boolean; last_login_at: string | null; created_at: string;
  roles: string[]; role_names: string[]; permission_count: number;
  events_30d: number; events_7d: number; active_sessions: number;
  avatar_document_id: string | null;
};
type Duty = {
  key: string; name: string; is_system: boolean; holders: number;
  permissions: { key: string; description: string | null }[];
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
/** Week against month: the only two windows a roster row carries. */
function WorkMeter({ seat, max }: { seat: Seat; max: number }) {
  const w = (n: number) => Math.max(n > 0 ? 3 : 0, Math.round((n / Math.max(1, max)) * 100));
  return (
    <div style={{ minWidth: 96 }} title={`${seat.events_7d} events this week, ${seat.events_30d} in 30 days`}>
      <div style={{ height: 6, background: "var(--adm-line)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${w(seat.events_30d)}%`, background: "var(--adm-accent)", opacity: 0.5 }} />
      </div>
      <div className="mt-4" style={{ height: 6, background: "var(--adm-line)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${w(seat.events_7d)}%`, background: "var(--success)" }} />
      </div>
      <p className="mt-4 text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
        {seat.events_7d} wk · {seat.events_30d} mo
      </p>
    </div>
  );
}

export default function ControlStaffPage() {
  const [me, setMe] = useState<any>(null);
  const [staff, setStaff] = useState<Seat[]>([]);
  const [dutyList, setDutyList] = useState<Duty[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [granted, setGranted] = useState(0);
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (search: string, duty: string) => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (duty) params.set("role", duty);
    const res = await fetch(`${API}/api/v1/control/staff?${params}`, { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    if (!res.ok) { setError("The desk did not answer."); setLoading(false); return; }
    const j = await res.json();
    setStaff(j.staff ?? []);
    setCanManage(!!j.can_manage);
    setGranted(Number(j.granted_permissions ?? 0));
    setError(null); setLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      load("", "");
      const r = await fetch(`${API}/api/v1/control/staff/roles`, { credentials: "include" });
      if (r.ok) setDutyList((await r.json()).roles ?? []);
    })();
  }, [load]);

  const maxEvents = Math.max(1, ...staff.map((s) => s.events_30d));
  const counts = {
    active: staff.filter((s) => s.status === "active").length,
    off: staff.filter((s) => s.status !== "active").length,
    sessions: staff.reduce((n, s) => n + s.active_sessions, 0),
    secondFactor: staff.filter((s) => s.totp_enabled).length
  };

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            {canManage ? "Super Admin" : "Read-only"} · Platform staff
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1180px] px-16 py-32">
        {forbidden ? (
          <div className="rounded-card border p-24" style={{ borderColor: "var(--line)" }}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>This desk is not yours</h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ") || "no platform duty"}.
              The roster needs the duty <code>control.staff.view</code>; the panel itself stays open to you.
            </p>
            <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-16">
              <div>
                <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Platform staff</h1>
                <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                  The people who run WAISHA itself, their duties and what each of them has actually
                  been doing. Every seat here signs into the control panel, not a company portal.
                </p>
              </div>
              <div className="flex gap-24 text-right">
                {[["On the desk", staff.length], ["Active", counts.active],
                  ["Off it", counts.off], ["Duties held", granted],
                  ["Live sessions", counts.sessions], ["Second factor", `${counts.secondFactor}/${staff.length}`]]
                  .map(([label, value]) => (
                    <div key={String(label)}>
                      <p className="text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>{value}</p>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</p>
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

            <div className="mt-24 flex flex-wrap items-center gap-12">
              <input value={q} onChange={(e) => { setQ(e.target.value); load(e.target.value, role); }}
                placeholder="Search a name, work address or job title"
                className="min-w-[280px] flex-1 rounded-input border px-12 py-8 text-sm"
                style={{ borderColor: "var(--line)", background: "var(--milk)" }} />
              <select value={role} onChange={(e) => { setRole(e.target.value); load(q, e.target.value); }}
                className="rounded-input border px-12 py-8 text-sm"
                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                <option value="">Every duty</option>
                {dutyList.map((d) => <option key={d.key} value={d.key}>{d.name}</option>)}
              </select>
              {!canManage && (
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--warning)" }}>
                  read-only duty
                </span>
              )}
            </div>

            <section className="mt-16 overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      <th className="p-12">Seat</th>
                      <th className="p-12">Duties</th>
                      <th className="p-12">Status</th>
                      <th className="p-12">Work, week against month</th>
                      <th className="p-12 text-right">Keys</th>
                      <th className="p-12 text-right">Sessions</th>
                      <th className="p-12">Last signed in</th>
                      <th className="p-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map((s, i) => (
                      <tr key={s.user_id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className="p-12">
                          <div className="flex items-center gap-12">
                            <SeatFace userId={s.user_id} avatarDocumentId={s.avatar_document_id}
                              name={s.full_name} email={s.email} />
                            <div className="min-w-0">
                              <p className="truncate font-semibold" style={{ color: "var(--ink)" }}>
                                {s.full_name ?? "—"}
                                {s.totp_enabled ? <span title="Second factor is on" style={{ color: "var(--success)" }}> ✓</span> : null}
                              </p>
                              <p className="truncate text-[11px]" style={{ color: "var(--ink-soft)" }}>
                                {s.job_title ? `${s.job_title} · ` : ""}{s.email}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="p-12 align-top">
                          <div className="flex flex-wrap gap-6" style={{ maxWidth: 240 }}>
                            {s.roles.length === 0 && <span className="text-[11px]" style={{ color: "var(--warning)" }}>no platform duty</span>}
                            {s.roles.map((k, n) => (
                              <span key={k} className="px-8 py-4 text-[10px] font-semibold uppercase tracking-[0.1em]"
                                style={{ background: "var(--adm-accent-soft)", color: "var(--adm-accent)", borderRadius: 999 }}
                                title={s.role_names[n] ?? k}>
                                {k.replace(/_/g, " ")}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="p-12 align-top">
                          <span className="px-8 py-4 text-[10px] font-bold uppercase"
                            style={{ borderLeft: `4px solid ${STATUS_EDGE[s.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                            {s.status}
                          </span>
                        </td>
                        <td className="p-12 align-top"><WorkMeter seat={s} max={maxEvents} /></td>
                        <td className="p-12 text-right align-top tabular-nums" style={{ color: "var(--ink)" }}>{s.permission_count}</td>
                        <td className="p-12 text-right align-top tabular-nums" style={{ color: s.active_sessions ? "var(--success)" : "var(--ink-soft)" }}>
                          {s.active_sessions}
                        </td>
                        <td className="p-12 align-top text-xs" style={{ color: "var(--ink-soft)" }} title={when(s.last_login_at)}>
                          {ago(s.last_login_at)}
                        </td>
                        <td className="p-12 text-right align-top">
                          <Link href={`/control/staff/${s.user_id}`}
                            className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                            Duty profile
                          </Link>
                        </td>
                      </tr>
                    ))}
                    {!loading && staff.length === 0 && (
                      <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        Nobody matches this filter. The roster lists every account whose type is
                        platform staff — a company's own director never appears here.
                      </td></tr>
                    )}
                    {loading && (
                      <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>Loading the desk…</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-32">
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                What each duty is allowed to do
              </h2>
              <p className="mt-8 mb-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                Read from the live grants, not from a description written somewhere else. Seats are
                counted on this desk only, so a role with no holder is a duty nobody can be given by mistake.
              </p>
              <div className="grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
                {dutyList.map((d) => (
                  <details key={d.key} className="rounded-card border p-16" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                    <summary className="cursor-pointer text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {d.name}
                      <span className="ml-8 text-[11px] font-normal" style={{ color: "var(--ink-soft)" }}>
                        {d.holders} seat{d.holders === 1 ? "" : "s"} · {d.permissions.length} keys
                      </span>
                    </summary>
                    <p className="mt-8 text-[11px] font-bold uppercase tracking-[0.12em]" style={{ color: "var(--adm-accent)" }}>{d.key}</p>
                    <ul className="mt-8 space-y-4">
                      {d.permissions.map((p) => (
                        <li key={p.key} className="text-xs" style={{ color: "var(--ink-soft)" }}>
                          <span style={{ color: "var(--ink)" }}>{p.description ?? p.key}</span>
                          <span className="ml-6 opacity-60">{p.key}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
