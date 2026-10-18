"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";
import { initials } from "@/components/SeatFace";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

type ChartSeat = {
  membership_id: string; user_id: string; full_name: string | null; job_title: string | null;
  status: string; standing: string; starts_at: string; ends_at: string | null;
  note: string | null; last_login_at: string | null; duties: string[];
};
type Department = {
  id: string; key: string; name: string; purpose: string | null; sort: number; is_active: boolean;
  head_user_id: string | null; head_name: string | null; seat_count: number; live_covers: number;
  seats: ChartSeat[];
};
type LooseSeat = { user_id: string; full_name: string | null; job_title: string | null;
  status: string; last_login_at: string | null; duties: string[] };
type ShutDesk = { id: string; key: string; name: string; closed_at: string;
  closed_by: string | null; register_rows: number };
type Summary = { departments: number; placed_seats: number; live_covers: number;
  covers_ending_7d: number; seats: number; register_rows: number };
type Move = {
  id: string; ts: string; action: string; user_id: string | null; seat_name: string | null;
  from_label: string | null; to_label: string | null; reason: string; detail: Record<string, any>;
  actor_role: string | null; actor_name: string | null; ip: string | null;
};

const ACTIONS: [string, string][] = [
  ["department_created", "A desk was opened"],
  ["department_updated", "A desk was rewritten"],
  ["department_closed", "A desk was shut"],
  ["department_reopened", "A desk was reopened"],
  ["seat_joined", "A seat joined"],
  ["seat_moved", "A seat moved"],
  ["seat_released", "A seat left"],
  ["head_appointed", "A head was named"],
  ["head_released", "A head stepped down"]
];
const actionLabel = (k: string) => ACTIONS.find(([v]) => v === k)?.[1] ?? k;

const STATUS_EDGE: Record<string, string> = {
  active: "var(--success)", suspended: "var(--warning)", deactivated: "var(--danger)"
};
const MOVE_EDGE: Record<string, string> = {
  department_created: "var(--success)", department_updated: "var(--adm-accent)",
  department_closed: "var(--danger)", department_reopened: "var(--success)",
  seat_joined: "var(--success)", seat_moved: "var(--adm-accent)",
  seat_released: "var(--warning)", head_appointed: "var(--gold)", head_released: "var(--warning)"
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—";
/** How much of a cover is left, in the unit a person acts on: days, then hours. */
function coverLeft(iso: string): { text: string; soon: boolean } {
  const hours = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000);
  if (hours <= 0) return { text: "ran out", soon: true };
  if (hours < 48) return { text: `${hours} h left`, soon: true };
  return { text: `${Math.round(hours / 24)} days left`, soon: false };
}

type RegFilter = { action: string; user: string; q: string; days: string; limit: string };
type PanelKind = "open" | "edit" | "place" | "head" | "stepdown" | "move" | "leave" | "close" | "reopen";
type Panel = { kind: PanelKind; deptId?: string; userId?: string; userName?: string | null };
type Draft = {
  key: string; name: string; purpose: string; sort: string; reason: string; endsOn: string;
  picked: string[]; headUserId: string; moveTo: string;
};
const EMPTY: Draft = { key: "", name: "", purpose: "", sort: "100", reason: "", endsOn: "",
  picked: [], headUserId: "", moveTo: "" };

/**
 * The platform's own org chart (084; task #130c) — which desk every staff seat sits in,
 * who answers for it, and the register of every move with the reason behind it.
 *
 * The API refuses any write that cannot say why, so every panel below ends in a reason box
 * that must hold four characters before its button unlocks — an org chart that cannot say
 * why is a rumour. A cover is a membership with an end date, and the date the desk picks is
 * a day, so the hint under every date box says what happens to it: the seat ends at the
 * close of that day in Dar es Salaam, and expires by being read, not by a sweeper.
 *
 * Destructive buttons arm on the first tap and run on the second, because closing a desk
 * releases every seat on it and the answer "who took my team away" comes out of the register.
 */
export default function ControlDepartmentsPage() {
  const [me, setMe] = useState<any>(null);
  const [canManage, setCanManage] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [unassigned, setUnassigned] = useState<LooseSeat[]>([]);
  const [closed, setClosed] = useState<ShutDesk[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [panel, setPanel] = useState<Panel | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);

  const [moves, setMoves] = useState<Move[]>([]);
  const [regTotal, setRegTotal] = useState(0);
  const [regLast7, setRegLast7] = useState(0);
  const [regFilter, setRegFilter] = useState<RegFilter>({ action: "", user: "", q: "", days: "30", limit: "60" });
  const [regError, setRegError] = useState<string | null>(null);

  const load = useCallback(async (days: string) => {
    const res = await fetch(`${API}/api/v1/control/departments?days=${days}`,
      { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    if (!res.ok) { setError("The chart did not answer."); setLoading(false); return; }
    const j = await res.json();
    setDepartments(j.departments ?? []);
    setUnassigned(j.unassigned ?? []);
    setClosed(j.closed ?? []);
    setSummary(j.summary ?? null);
    setCanManage(!!j.can_manage);
    setError(null); setLoading(false);
  }, []);

  const loadRegister = useCallback(async (f: RegFilter) => {
    const params = new URLSearchParams();
    if (f.action) params.set("action", f.action);
    if (f.user) params.set("user", f.user);
    if (f.q.trim()) params.set("q", f.q.trim());
    params.set("days", f.days);
    params.set("limit", f.limit);
    const res = await fetch(`${API}/api/v1/control/departments/register?${params}`,
      { credentials: "include" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setRegError(j?.error?.message ?? "The register did not answer.");
      return;
    }
    const j = await res.json();
    setMoves(j.items ?? []); setRegTotal(j.total ?? 0); setRegLast7(j.last_7 ?? 0);
    setRegError(null);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const f = { action: "", user: "", q: "", days: "30", limit: "60" };
      load(f.days);
      loadRegister(f);
    })();
  }, [load, loadRegister]);

  /** Every write re-reads both halves of the desk: the chart it changed and the line it added. */
  const refresh = useCallback((f: RegFilter) => { load(f.days); loadRegister(f); }, [load, loadRegister]);

  /** Every write goes through here: the message the API returns is the sentence the desk shows. */
  async function write(method: "POST" | "PATCH", path: string, body: unknown): Promise<any | null> {
    setBusy(true); setPanelError(null);
    try {
      const res = await fetch(`${API}/api/v1/control/departments${path}`, {
        method, headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify(body ?? {})
      });
      if (res.status === 401) { window.location.href = "/control/login"; return null; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A rejected body comes back as "Request validation failed" plus a field list;
        // the list is the part that says what to type.
        const hints = (j?.error?.details ?? []).map((d: any) => d.message ?? d.path).filter(Boolean).slice(0, 3);
        setPanelError([j?.error?.message ?? "The desk refused.", ...hints].join(" — "));
        return null;
      }
      return j;
    } finally { setBusy(false); }
  }

  function openPanel(next: Panel, seed: Partial<Draft> = {}) {
    setDraft({ ...EMPTY, ...seed });
    setPanelError(null); setNotice(null); setArmed(null);
    setPanel(panel?.kind === next.kind && panel?.deptId === next.deptId && panel?.userId === next.userId
      ? null : next);
  }

  const reasonReady = draft.reason.trim().length >= 4;
  /** A write that lands late must not close a panel the operator opened in the meantime. */
  const closePanel = (mine: Panel | null) => setPanel((cur) => (cur === mine ? null : cur));
  const deptById = (id?: string) => departments.find((d) => d.id === id);
  /** Every seat the chart can see, by id — the register's seat filter has to offer the same
   *  people the chart does, including a seat whose only desk has since been shut. */
  const people = (() => {
    const byId = new Map<string, string | null>();
    for (const d of departments) for (const s of d.seats) if (!byId.has(s.user_id)) byId.set(s.user_id, s.full_name);
    for (const u of unassigned) if (!byId.has(u.user_id)) byId.set(u.user_id, u.full_name);
    return [...byId].map(([user_id, full_name]) => ({ user_id, full_name }));
  })();
  const seatOptions = (dept?: Department) => {
    const inDesk = new Set((dept?.seats ?? []).map((s) => s.user_id));
    return [
      ...(dept?.seats ?? []).map((s) => ({ ...s, tag: s.standing === "head" ? "head" : "member" })),
      ...unassigned.filter((u) => !inDesk.has(u.user_id)).map((u) => ({ ...u, tag: "no desk" }))
    ];
  };

  // ---------- the nine writes ----------
  async function submitOpen() {
    const j = await write("POST", "", {
      key: draft.key.trim().toLowerCase(), name: draft.name.trim(),
      purpose: draft.purpose.trim(), sort: Number(draft.sort || 100)
    });
    if (!j) return;
    setNotice(`${j.name} is open on the chart as "${j.key}".`);
    closePanel(panel); refresh(regFilter);
  }

  async function submitEdit() {
    const j = await write("PATCH", `/${panel!.deptId}`, {
      name: draft.name.trim() || undefined,
      purpose: draft.purpose.trim() || undefined,
      sort: draft.sort ? Number(draft.sort) : undefined
    });
    if (!j) return;
    setNotice(`${j.name} was rewritten on the chart.`);
    closePanel(panel); refresh(regFilter);
  }

  async function submitPlace() {
    if (!draft.picked.length) { setPanelError("Tick at least one seat to place."); return; }
    const j = await write("POST", `/${panel!.deptId}/seats`, {
      userIds: draft.picked, reason: draft.reason.trim(), endsOn: draft.endsOn || null
    });
    if (!j) return;
    const skipped = (j.already_seated ?? []).length
      ? ` Already sitting there: ${j.already_seated.join(", ")}.` : "";
    setNotice(`${j.placed} seat(s) placed in ${deptById(panel!.deptId)?.name ?? "the desk"}.${skipped}`);
    closePanel(panel); refresh(regFilter);
  }

  async function submitHead() {
    if (!draft.headUserId) { setPanelError("Choose who answers for the desk."); return; }
    const j = await write("POST", `/${panel!.deptId}/head`, {
      userId: draft.headUserId, reason: draft.reason.trim(), endsOn: draft.endsOn || null
    });
    if (!j) return;
    const who = seatOptions(deptById(panel!.deptId)).find((s) => s.user_id === draft.headUserId)?.full_name;
    setNotice(`${who ?? "The seat"} answers for ${deptById(panel!.deptId)?.name ?? "the desk"} now`
      + `${draft.endsOn ? `, until ${draft.endsOn}` : ""}.`);
    closePanel(panel); refresh(regFilter);
  }

  async function submitStepDown() {
    const j = await write("POST", `/${panel!.deptId}/head`, {
      userId: null, reason: draft.reason.trim()
    });
    if (!j) return;
    setNotice(`${deptById(panel!.deptId)?.name ?? "The desk"} is without a head until one is named.`);
    closePanel(panel); refresh(regFilter);
  }

  async function submitMove() {
    if (!draft.moveTo) { setPanelError("Choose the desk they move to."); return; }
    const j = await write("POST", "/move", {
      userId: panel!.userId, toDepartmentId: draft.moveTo,
      reason: draft.reason.trim(), endsOn: draft.endsOn || null
    });
    if (!j) return;
    setNotice(`${panel!.userName}: ${j.from || "nowhere"} → ${j.to}` +
      (j.joined === 0 ? " — already sat there, nothing to place." : ""));
    closePanel(panel); refresh(regFilter);
  }

  async function submitLeave() {
    const j = await write("POST", "/leave", { userId: panel!.userId, reason: draft.reason.trim() });
    if (!j) return;
    setNotice(`${panel!.userName} left ${j.released} desk(s) and is unplaced.`);
    closePanel(panel); refresh(regFilter);
  }

  async function submitClose() {
    const j = await write("POST", `/${panel!.deptId}/close`, {
      reason: draft.reason.trim(), moveTo: draft.moveTo || null
    });
    if (!j) return;
    setNotice(`${deptById(panel!.deptId)?.name ?? "The desk"} is shut: ${j.seats_released} seat(s) `
      + `released, ${j.seats_moved} moved on.`);
    closePanel(panel); refresh(regFilter);
  }

  async function submitReopen(id: string, name: string) {
    const j = await write("POST", `/${id}/reopen`, { reason: draft.reason.trim() });
    if (!j) return;
    setNotice(`${name} is open again — its seats were not resurrected, so place them afresh.`);
    closePanel(panel); refresh(regFilter);
  }

  const twoTap = (key: string, run: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    setArmed(null); run();
  };

  if (forbidden) {
    return (
      <div className="control-shell page-shell flex-1">
        <header className="flex items-center justify-between px-24 py-12"
          style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <ControlNav />
        </header>
        <main className="mx-auto max-w-[900px] px-16 py-32">
          <div className="rounded-card border p-24" style={{ borderColor: "var(--line)" }}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>This chart is not yours to read</h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ") || "no platform duty"}.
              The org chart needs the duty <code>control.departments.view</code>; reshaping it needs
              <code> control.departments.manage</code>.
            </p>
            <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const stats: [string | number, string][] = summary ? [
    [summary.departments, "Open desks"],
    [`${summary.placed_seats} of ${summary.seats}`, "Seats placed"],
    [summary.live_covers, "Covers running"],
    [summary.covers_ending_7d, "Covers ending in 7 days"],
    [unassigned.length, "Seats without a desk"],
    [`${summary.register_rows} in ${regFilter.days} days`, "Moves on record"]
  ] : [];

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            {canManage ? "Super Admin" : "Read-only"} · Departments and duty moves
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1240px] px-16 py-32">
        <div className="flex flex-wrap items-end justify-between gap-16">
          <div>
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>The platform org chart</h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Which desk each staff seat sits in, who answers for it, and the register of every move
              with the reason a person would defend out loud. A cover is a seat with an end date; it
              stops on its own at the close of the day named here, in Dar es Salaam time.
            </p>
          </div>
          {canManage && (
            <button type="button" onClick={() => openPanel({ kind: "open" })}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
              {panel?.kind === "open" ? "Close the form" : "Open a desk"}
            </button>
          )}
        </div>

        <div className="mt-20 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          {stats.map(([value, label]) => (
            <div key={label} className="rounded-card border p-14"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
              <p className="text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>{value}</p>
              <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ color: "var(--ink-soft)" }}>{label}</p>
            </div>
          ))}
        </div>

        {error && (
          <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="mt-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--success) 8%, transparent)", borderLeft: "4px solid var(--success)" }}>
            {notice}
          </div>
        )}
        {panelError && (
          <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
            {panelError}
          </div>
        )}

        {panel?.kind === "open" && (
          <section className="mt-20 rounded-card border p-20" style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
            <h2 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
              A new desk
            </h2>
            <div className="mt-14 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              <label className="text-xs" style={{ color: "var(--ink-soft)" }}>
                Key — lowercase, used by the API
                <input value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                  placeholder="compliance" className="mt-6 w-full rounded-input border px-12 py-8 text-sm"
                  style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
              </label>
              <label className="text-xs" style={{ color: "var(--ink-soft)" }}>
                Name
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Compliance and Permits" className="mt-6 w-full rounded-input border px-12 py-8 text-sm"
                  style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
              </label>
              <label className="text-xs" style={{ color: "var(--ink-soft)" }}>
                Sort — where it prints on the chart
                <input type="number" min={0} max={9999} value={draft.sort}
                  onChange={(e) => setDraft({ ...draft, sort: e.target.value })}
                  className="mt-6 w-full rounded-input border px-12 py-8 text-sm"
                  style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
              </label>
            </div>
            <label className="mt-14 block text-xs" style={{ color: "var(--ink-soft)" }}>
              Purpose — what this desk exists to do; it becomes the first line of the register
              <textarea value={draft.purpose} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
                rows={2} className="mt-6 w-full rounded-input border px-12 py-8 text-sm"
                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
            </label>
            <div className="mt-14 flex gap-12">
              <button type="button" disabled={busy || !draft.key.trim() || draft.name.trim().length < 2}
                onClick={submitOpen} className="waisha-btn rounded-input px-18 py-8 text-xs font-semibold">
                Open the desk
              </button>
              <button type="button" onClick={() => setPanel(null)}
                className="rounded-input border px-18 py-8 text-xs font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>Cancel</button>
            </div>
          </section>
        )}

        {/* ---------------- the chart ---------------- */}
        <section className="mt-28">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
            Open desks
          </h2>
          {loading && <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the chart…</p>}
          {!loading && departments.length === 0 && (
            <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>
              No desk is open on this platform tenant yet.
            </p>
          )}
          <div className="mt-14 grid gap-16" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(430px, 1fr))" }}>
            {departments.map((d) => {
              const isOpen = panel?.deptId === d.id && panel.kind !== "open";
              return (
                <article key={d.id} className="rounded-card border p-18"
                  style={{ borderColor: isOpen ? "var(--adm-accent)" : "var(--line)", background: "var(--surface)" }}>
                  <div className="flex items-start justify-between gap-12">
                    <div className="min-w-0">
                      <h3 className="text-base font-bold" style={{ color: "var(--ink)" }}>{d.name}</h3>
                      <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em]"
                        style={{ color: "var(--adm-accent)" }}>{d.key}</p>
                      <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>{d.purpose || "No purpose recorded."}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                        {d.seat_count} seat{d.seat_count === 1 ? "" : "s"}
                      </p>
                      <p className="mt-2 text-[11px]" style={{ color: d.live_covers ? "var(--warning)" : "var(--ink-soft)" }}>
                        {d.live_covers} on cover
                      </p>
                      <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>sort {d.sort}</p>
                    </div>
                  </div>

                  <p className="mt-12 text-xs" style={{ color: "var(--ink)" }}>
                    <span className="font-semibold" style={{ color: "var(--gold)" }}>Answerable: </span>
                    {d.head_name ?? <span style={{ color: "var(--warning)" }}>no head named</span>}
                  </p>

                  <ul className="mt-10 divide-y" style={{ borderColor: "var(--line)" }}>
                    {d.seats.map((s) => {
                      const left = s.ends_at ? coverLeft(s.ends_at) : null;
                      return (
                        <li key={s.membership_id} className="flex items-center gap-12 py-10">
                          <span aria-hidden style={{
                            width: 30, height: 30, flex: "0 0 auto", borderRadius: "50%",
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            fontSize: 11, fontWeight: 700, background: "var(--adm-accent-soft)",
                            color: "var(--adm-accent)", border: "1px solid var(--adm-line)"
                          }}>{initials(s.full_name, "")}</span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold" style={{ color: "var(--ink)" }}>
                              {s.full_name ?? "—"}
                              {s.standing === "head" && (
                                <span className="ml-8 px-6 py-2 text-[10px] font-bold uppercase tracking-[0.1em]"
                                  style={{ background: "color-mix(in srgb, var(--gold) 18%, transparent)", color: "var(--gold)", borderRadius: 999 }}>
                                  head
                                </span>
                              )}
                            </p>
                            <p className="truncate text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              {s.job_title ? `${s.job_title} · ` : ""}
                              {s.duties.length ? s.duties.join(", ") : "no platform duty"}
                              {" · since "}{day(s.starts_at)}
                            </p>
                            {s.note && (
                              <p className="truncate text-[11px] italic" style={{ color: "var(--ink-soft)" }}>{s.note}</p>
                            )}
                          </div>
                          <div className="text-right">
                            <span className="px-6 py-2 text-[10px] font-bold uppercase"
                              style={{ borderLeft: `3px solid ${STATUS_EDGE[s.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                              {s.status}
                            </span>
                            {left && (
                              <p className="mt-4 text-[10px] font-semibold" style={{ color: left.soon ? "var(--warning)" : "var(--ink-soft)" }}
                                title={`The cover ends ${when(s.ends_at)}`}>
                                {left.text}
                              </p>
                            )}
                          </div>
                          {canManage && (
                            <div className="flex flex-col gap-6">
                              <button type="button" title="Move this seat to another desk"
                                onClick={() => openPanel({ kind: "move", deptId: d.id, userId: s.user_id, userName: s.full_name },
                                  { moveTo: "" })}
                                className="rounded-input border px-8 py-4 text-[10px] font-semibold"
                                style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>Move</button>
                              <button type="button" title="Take this seat off every desk"
                                onClick={() => openPanel({ kind: "leave", deptId: d.id, userId: s.user_id, userName: s.full_name })}
                                className="rounded-input border px-8 py-4 text-[10px] font-semibold"
                                style={{ borderColor: "var(--line)", color: "var(--danger)" }}>Release</button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                    {d.seats.length === 0 && (
                      <li className="py-10 text-xs" style={{ color: "var(--warning)" }}>
                        Nobody sits here — an empty desk has no answer to give.
                      </li>
                    )}
                  </ul>

                  {isOpen && panel.kind !== "move" && panel.kind !== "leave"
                    && panel.kind !== "stepdown" && panel.kind !== "reopen" && (
                    <div className="mt-14 rounded-input border p-14" style={{ borderColor: "var(--adm-line)" }}>
                      {panel.kind === "edit" && (
                        <>
                          <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                            Rewrite {d.name}
                          </p>
                          <div className="mt-10 grid gap-10" style={{ gridTemplateColumns: "1fr 1fr" }}>
                            <input defaultValue={d.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                              placeholder="Name" className="rounded-input border px-10 py-6 text-sm"
                              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                            <input type="number" defaultValue={d.sort} onChange={(e) => setDraft({ ...draft, sort: e.target.value })}
                              placeholder="Sort" className="rounded-input border px-10 py-6 text-sm"
                              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                          </div>
                          <textarea defaultValue={d.purpose ?? ""} rows={2}
                            onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} placeholder="Purpose"
                            className="mt-10 w-full rounded-input border px-10 py-6 text-sm"
                            style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                          <div className="mt-10 flex gap-10">
                            <button type="button" disabled={busy} onClick={submitEdit}
                              className="waisha-btn rounded-input px-14 py-6 text-xs font-semibold">Save</button>
                            <button type="button" onClick={() => setPanel(null)}
                              className="rounded-input border px-14 py-6 text-xs" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                              Cancel</button>
                          </div>
                        </>
                      )}

                      {panel.kind === "place" && (
                        <>
                          <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                            Seat people in {d.name}
                          </p>
                          <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                            Only platform seats of this tenant can be placed, and only active ones —
                            a suspended seat has to change status on the staff desk first.
                          </p>
                          <div className="mt-10 max-h-[190px] overflow-y-auto rounded-input border p-8"
                            style={{ borderColor: "var(--line)" }}>
                            {unassigned.length === 0 && (
                              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                                Every platform seat already sits in a desk. Move one instead.
                              </p>
                            )}
                            {unassigned.map((u) => (
                              <label key={u.user_id} className="flex cursor-pointer items-center gap-8 py-4 text-xs"
                                style={{ color: "var(--ink)" }}>
                                <input type="checkbox" checked={draft.picked.includes(u.user_id)}
                                  onChange={(e) => setDraft({
                                    ...draft,
                                    picked: e.target.checked
                                      ? [...draft.picked, u.user_id]
                                      : draft.picked.filter((i) => i !== u.user_id)
                                  })} />
                                <span className="font-semibold">{u.full_name ?? u.user_id}</span>
                                <span style={{ color: STATUS_EDGE[u.status] ?? "var(--ink-soft)" }}>{u.status}</span>
                                <span className="truncate" style={{ color: "var(--ink-soft)" }}>
                                  {u.duties.length ? u.duties.join(", ") : "no platform duty"}
                                </span>
                              </label>
                            ))}
                          </div>
                          <div className="mt-10 grid gap-10" style={{ gridTemplateColumns: "190px 1fr" }}>
                            <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              Cover until (optional)
                              <input type="date" value={draft.endsOn}
                                onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })}
                                className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                            </label>
                            <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              Why — at least four characters, and it is what the register will say
                              <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                                placeholder="Hassan takes billing while Amina is on leave."
                                className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                            </label>
                          </div>
                          <p className="mt-6 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            A date makes this a cover: the seat ends at the close of that day in Dar es Salaam
                            and disappears from the chart by itself. Leave it empty for a posting.
                          </p>
                          <button type="button" disabled={busy || !reasonReady} onClick={submitPlace}
                            className="waisha-btn mt-10 rounded-input px-14 py-6 text-xs font-semibold">
                            Place {draft.picked.length || ""} seat(s)
                          </button>
                        </>
                      )}

                      {panel.kind === "head" && (
                        <>
                          <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                            Name the head of {d.name}
                          </p>
                          <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                            One head per desk is an index, not a habit: whoever answers for it now steps down
                            to a plain member and stays on the desk.
                          </p>
                          <select value={draft.headUserId}
                            onChange={(e) => setDraft({ ...draft, headUserId: e.target.value })}
                            className="mt-10 w-full rounded-input border px-10 py-6 text-sm"
                            style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                            <option value="">Choose a seat</option>
                            {seatOptions(d).map((s) => (
                              <option key={s.user_id} value={s.user_id}>
                                {s.full_name ?? s.user_id} — {s.tag}{s.job_title ? `, ${s.job_title}` : ""}
                              </option>
                            ))}
                          </select>
                          <div className="mt-10 grid gap-10" style={{ gridTemplateColumns: "190px 1fr" }}>
                            <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              Acting until (optional)
                              <input type="date" value={draft.endsOn}
                                onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })}
                                className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                            </label>
                            <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              Why
                              <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                                placeholder="Amina was already answering for it; this makes it official."
                                className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                            </label>
                          </div>
                          <button type="button" disabled={busy || !reasonReady || !draft.headUserId} onClick={submitHead}
                            className="waisha-btn mt-10 rounded-input px-14 py-6 text-xs font-semibold">
                            Appoint the head
                          </button>
                        </>
                      )}

                      {panel.kind === "close" && (
                        <>
                          <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--danger)" }}>
                            Shut {d.name}
                          </p>
                          <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                            {d.seat_count
                              ? `This desk holds ${d.seat_count} seat(s). Name where they go, or release them one by one first.`
                              : "Nothing sits here, so closing it takes nobody's desk away."}
                          </p>
                          {!!d.seat_count && (
                            <select value={draft.moveTo} onChange={(e) => setDraft({ ...draft, moveTo: e.target.value })}
                              className="mt-10 w-full rounded-input border px-10 py-6 text-sm"
                              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                              <option value="">Nowhere — refuse this close until I choose</option>
                              {departments.filter((o) => o.id !== d.id).map((o) => (
                                <option key={o.id} value={o.id}>Move them all to {o.name}</option>
                              ))}
                            </select>
                          )}
                          <label className="mt-10 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                            Why the desk is being shut
                            <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                              placeholder="Billing and compliance merged into one desk."
                              className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                          </label>
                          <button type="button" disabled={busy || !reasonReady}
                            onClick={twoTap(`close:${d.id}`, submitClose)}
                            className="mt-10 rounded-input px-14 py-6 text-xs font-semibold"
                            style={{
                              background: armed === `close:${d.id}` ? "var(--danger)" : "transparent",
                              border: "1px solid var(--danger)",
                              color: armed === `close:${d.id}` ? "#fff" : "var(--danger)"
                            }}>
                            {armed === `close:${d.id}` ? "Tap again to shut it" : "Shut the desk"}
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {canManage && !isOpen && (
                    <div className="mt-14 flex flex-wrap gap-8">
                      {[
                        ["Add seats", "place"], ["Edit", "edit"], ["Name a head", "head"], ["Shut", "close"]
                      ].map(([label, kind]) => (
                        <button key={kind} type="button" onClick={() => openPanel({ kind: kind as PanelKind, deptId: d.id })}
                          className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                          style={{ borderColor: "var(--line)", color: kind === "close" ? "var(--danger)" : "var(--adm-accent)" }}>
                          {label}
                        </button>
                      ))}
                      {d.head_user_id && (
                        <button type="button" onClick={() => openPanel({ kind: "stepdown", deptId: d.id })}
                          className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                          style={{ borderColor: "var(--line)", color: "var(--warning)" }}>
                          Head steps down
                        </button>
                      )}
                    </div>
                  )}

                  {isOpen && panel.kind === "stepdown" && (
                    <div className="mt-14 rounded-input border p-14" style={{ borderColor: "var(--adm-line)" }}>
                      <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--warning)" }}>
                        {d.head_name} steps down from {d.name}
                      </p>
                      <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        They stay on the desk as a plain member; the desk is left without an answer until
                        another head is named.
                      </p>
                      <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                        placeholder="They asked to hand it over."
                        className="mt-10 w-full rounded-input border px-10 py-6 text-sm"
                        style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                      <div className="mt-10 flex gap-10">
                        <button type="button" disabled={busy || !reasonReady}
                          onClick={twoTap(`step:${d.id}`, submitStepDown)}
                          className="rounded-input px-14 py-6 text-xs font-semibold"
                          style={{
                            background: armed === `step:${d.id}` ? "var(--warning)" : "transparent",
                            border: "1px solid var(--warning)",
                            color: armed === `step:${d.id}` ? "#05262a" : "var(--warning)"
                          }}>
                          {armed === `step:${d.id}` ? "Tap again to release the headship" : "Release the headship"}
                        </button>
                        <button type="button" onClick={() => setPanel(null)}
                          className="rounded-input border px-14 py-6 text-xs" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                          Cancel</button>
                      </div>
                    </div>
                  )}

                  {isOpen && (panel.kind === "move" || panel.kind === "leave") && (
                    <div className="mt-14 rounded-input border p-14" style={{ borderColor: "var(--adm-line)" }}>
                      <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                        {panel.kind === "move" ? `Move ${panel.userName}` : `Release ${panel.userName} from every desk`}
                      </p>
                      {panel.kind === "move" ? (
                        <select value={draft.moveTo} onChange={(e) => setDraft({ ...draft, moveTo: e.target.value })}
                          className="mt-10 w-full rounded-input border px-10 py-6 text-sm"
                          style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                          <option value="">Choose the desk they go to</option>
                          {departments.filter((o) => o.id !== panel.deptId).map((o) => (
                            <option key={o.id} value={o.id}>{o.name} — {o.seat_count} seat(s)</option>
                          ))}
                        </select>
                      ) : (
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          They come back to the unplaced list. If they headed a desk, that desk loses its head
                          in the same write — a person who has left cannot answer for a team.
                        </p>
                      )}
                      {panel.kind === "move" && (
                        <label className="mt-10 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          Cover until (optional — empty means a posting)
                          <input type="date" value={draft.endsOn}
                            onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })}
                            className="mt-4 rounded-input border px-10 py-6 text-sm"
                            style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                        </label>
                      )}
                      <label className="mt-10 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        Why
                        <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                          placeholder="Their work is permits now, not invoices."
                          className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                          style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                      </label>
                      <div className="mt-10 flex gap-10">
                        <button type="button" disabled={busy || !reasonReady || (panel.kind === "move" && !draft.moveTo)}
                          onClick={panel.kind === "move" ? submitMove
                            : twoTap(`leave:${panel.userId}`, submitLeave)}
                          className={panel.kind === "move" ? "waisha-btn rounded-input px-14 py-6 text-xs font-semibold" : "rounded-input px-14 py-6 text-xs font-semibold"}
                          style={panel.kind === "leave" ? {
                            background: armed === `leave:${panel.userId}` ? "var(--danger)" : "transparent",
                            border: "1px solid var(--danger)",
                            color: armed === `leave:${panel.userId}` ? "#fff" : "var(--danger)"
                          } : undefined}>
                          {panel.kind === "move" ? "Move them"
                            : armed === `leave:${panel.userId}` ? "Tap again to release" : "Release the seat"}
                        </button>
                        <button type="button" onClick={() => setPanel(null)}
                          className="rounded-input border px-14 py-6 text-xs" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                          Cancel</button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        {/* ---------------- the two edges of the chart ---------------- */}
        <div className="mt-28 grid gap-16" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))" }}>
          <section className="rounded-card border p-18" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              Seats with no desk
            </h2>
            <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              Every platform seat of this tenant that sits nowhere. An unplaced seat is the chart's own
              warning: nobody is answerable for the work this person does.
            </p>
            <ul className="mt-12 divide-y" style={{ borderColor: "var(--line)" }}>
              {unassigned.map((u) => (
                <li key={u.user_id} className="flex items-center justify-between gap-10 py-8">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {u.full_name ?? "—"}
                    </p>
                    <p className="truncate text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      {u.job_title ? `${u.job_title} · ` : ""}{u.duties.length ? u.duties.join(", ") : "no platform duty"}
                      {" · signed in "}{u.last_login_at ? when(u.last_login_at) : "never"}
                    </p>
                  </div>
                  <span className="text-[10px] font-bold uppercase" style={{ color: STATUS_EDGE[u.status] ?? "var(--ink-soft)" }}>
                    {u.status}
                  </span>
                </li>
              ))}
              {unassigned.length === 0 && (
                <li className="py-8 text-xs" style={{ color: "var(--success)" }}>
                  Every seat is placed. The chart is complete.
                </li>
              )}
            </ul>
          </section>

          <section className="rounded-card border p-18" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              Shut desks
            </h2>
            <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              A closed desk is kept, not deleted — its name and its moves stay readable, and reopening it
              does not resurrect the seats that were released when it shut.
            </p>
            <ul className="mt-12 divide-y" style={{ borderColor: "var(--line)" }}>
              {closed.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-10 py-8">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold" style={{ color: "var(--ink)" }}>{c.name}</p>
                    <p className="truncate text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      shut {when(c.closed_at)} by {c.closed_by ?? "a seat that has since gone"} · {c.register_rows} moves
                    </p>
                  </div>
                  {canManage && (
                    <button type="button"
                      onClick={() => openPanel({ kind: "reopen", deptId: c.id }, { reason: "" })}
                      className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                      Reopen
                    </button>
                  )}
                </li>
              ))}
              {closed.length === 0 && (
                <li className="py-8 text-xs" style={{ color: "var(--ink-soft)" }}>No desk has been shut.</li>
              )}
            </ul>
            {panel?.kind === "reopen" && !deptById(panel.deptId) && (
              <div className="mt-12 rounded-input border p-12" style={{ borderColor: "var(--adm-line)" }}>
                <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>
                  Reopen {closed.find((c) => c.id === panel.deptId)?.name ?? "this desk"}
                </p>
                <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  If another desk has taken the key since it closed, this is refused and a new desk must be opened.
                </p>
                <label className="mt-8 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Why it is needed again
                  <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                    className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                </label>
                <button type="button" disabled={busy || !reasonReady}
                  onClick={() => submitReopen(panel.deptId!, closed.find((c) => c.id === panel.deptId)?.name ?? "The desk")}
                  className="waisha-btn mt-10 rounded-input px-14 py-6 text-xs font-semibold">
                  Reopen it
                </button>
              </div>
            )}
          </section>
        </div>

        {/* ---------------- the register ---------------- */}
        <section className="mt-28">
          <div className="flex flex-wrap items-end justify-between gap-12">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                Register of duty moves
              </h2>
              <p className="mt-6 text-sm" style={{ color: "var(--ink-soft)" }}>
                {regTotal} line(s) in the last {regFilter.days} days, {regLast7} of them this week.
                Append-only: the API can add to this and cannot change a line already written.
              </p>
            </div>
            <button type="button" onClick={() => loadRegister(regFilter)}
              className="rounded-input border px-14 py-6 text-xs font-semibold"
              style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
              Re-read the register
            </button>
          </div>

          <div className="mt-14 flex flex-wrap gap-10">
            <select value={regFilter.action}
              onChange={(e) => { const f = { ...regFilter, action: e.target.value }; setRegFilter(f); loadRegister(f); }}
              className="rounded-input border px-10 py-6 text-xs"
              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
              <option value="">Every kind of move</option>
              {ACTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <select value={regFilter.user}
              onChange={(e) => { const f = { ...regFilter, user: e.target.value }; setRegFilter(f); loadRegister(f); }}
              className="rounded-input border px-10 py-6 text-xs"
              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
              <option value="">Every seat</option>
              {people.map((p) => (
                <option key={p.user_id} value={p.user_id}>{p.full_name ?? p.user_id}</option>
              ))}
            </select>
            <input value={regFilter.q} placeholder="Search a name, desk or reason"
              onChange={(e) => setRegFilter({ ...regFilter, q: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") loadRegister(regFilter); }}
              className="min-w-[240px] flex-1 rounded-input border px-10 py-6 text-xs"
              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
            <select value={regFilter.days}
              onChange={(e) => { const f = { ...regFilter, days: e.target.value }; setRegFilter(f); loadRegister(f); load(f.days); }}
              className="rounded-input border px-10 py-6 text-xs"
              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
              {["7", "30", "90", "180", "365"].map((n) => <option key={n} value={n}>Last {n} days</option>)}
            </select>
            <select value={regFilter.limit}
              onChange={(e) => { const f = { ...regFilter, limit: e.target.value }; setRegFilter(f); loadRegister(f); }}
              className="rounded-input border px-10 py-6 text-xs"
              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
              {["30", "60", "120", "200"].map((n) => <option key={n} value={n}>{n} lines</option>)}
            </select>
          </div>

          {regError && (
            <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
              {regError}
            </div>
          )}

          <div className="mt-14 overflow-hidden rounded-card border" style={{ borderColor: "var(--line)" }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className="p-12">When</th>
                    <th className="p-12">Move</th>
                    <th className="p-12">Seat</th>
                    <th className="p-12">From → to</th>
                    <th className="p-12">Why</th>
                    <th className="p-12">Who made it</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m, i) => (
                    <tr key={m.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                      <td className="p-12 align-top text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}
                        title={when(m.ts)}>{when(m.ts)}</td>
                      <td className="p-12 align-top">
                        <span className="px-8 py-4 text-[10px] font-bold uppercase tracking-[0.08em]"
                          style={{ borderLeft: `4px solid ${MOVE_EDGE[m.action] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                          {actionLabel(m.action)}
                        </span>
                      </td>
                      <td className="p-12 align-top text-xs font-semibold" style={{ color: "var(--ink)" }}>
                        {m.seat_name ?? "—"}
                      </td>
                      <td className="p-12 align-top text-xs" style={{ color: "var(--ink-soft)" }}>
                        {[m.from_label, m.to_label].filter(Boolean).join(" → ") || "—"}
                        {m.detail?.ends_on ? (
                          <span className="ml-6" style={{ color: "var(--warning)" }}>cover to {String(m.detail.ends_on)}</span>
                        ) : null}
                        {m.detail?.already_at ? (
                          <span className="ml-6">already at {String(m.detail.already_at)}</span>
                        ) : null}
                      </td>
                      <td className="p-12 align-top text-xs" style={{ color: "var(--ink)", maxWidth: 360 }}>{m.reason}</td>
                      <td className="p-12 align-top text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        {m.actor_name ?? "the platform"}
                        {m.actor_role ? <span className="ml-4 opacity-70">{m.actor_role.replace(/_/g, " ")}</span> : null}
                        {m.ip ? <p className="mt-2 tabular-nums opacity-60">{m.ip}</p> : null}
                      </td>
                    </tr>
                  ))}
                  {!moves.length && (
                    <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                      Nothing in the register matches this filter. A line appears the moment a seat is
                      placed, moved, released or named — including the reason it was typed.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            The staff roster and the forensic trail are where a seat's picture, duties and full payload live —
            <Link href="/control/staff" className="ml-4 underline" style={{ color: "var(--adm-accent)" }}>Platform staff</Link>
            <Link href="/control/forensics" className="ml-8 underline" style={{ color: "var(--adm-accent)" }}>Forensics</Link>.
          </p>
        </section>
      </main>
    </div>
  );
}
