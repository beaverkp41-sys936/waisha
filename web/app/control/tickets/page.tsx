"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The customer service register (101; task #247).
 *
 * The caller gets a number — CS-2026-00042 — and the office gets a line saying who said
 * what, which desk now owns it and when it was last touched. Everything the desk can do is a
 * move the API already guards: a ticket only leaves the queue by being handed to a department,
 * nobody can call a job finished without writing how, and nothing is hidden until somebody has
 * closed it. Every one of those moves asks for a sentence, and the button stays shut until four
 * characters are in the box, because the register is evidence and "it needed doing" is not.
 *
 * The callback number is the one piece of it that is somebody's personal data: it is on every
 * detail read for a seat that holds the view duty, and on no list row at all — a row prints
 * "number on file" and nothing else.
 */

// The vocabulary is the API's (control-tickets.routes.ts). A key the route does not accept is
// a 400 with a field list, so this is a mirror, not a preference.
const CHANNELS: [string, string][] = [
  ["phone_call", "Phone call"], ["whatsapp", "WhatsApp"], ["email", "Email"],
  ["walk_in", "Walked in"], ["portal_message", "Portal message"], ["other", "Something else"]
];
const CATEGORIES: [string, string][] = [
  ["onboarding", "Onboarding"], ["account_access", "Account access"],
  ["licence_billing", "Licence and billing"], ["cargo_clearing", "Cargo and clearing"],
  ["transport_fleet", "Transport and fleet"], ["marketplace_directory", "Marketplace and directory"],
  ["system_error", "System error"], ["complaint", "Complaint"], ["other", "Other"]
];
const PRIORITIES: [string, string][] = [
  ["low", "Low"], ["normal", "Normal"], ["high", "High"], ["urgent", "Urgent"]
];
const STATUSES: [string, string][] = [
  ["open", "In the queue"], ["allocated", "Handed over"], ["in_progress", "Being worked on"],
  ["resolved", "Resolved"], ["closed", "Closed"]
];
const ACTIONS: [string, string][] = [
  ["logged", "Written into the register"], ["allocated", "Handed to a department"],
  ["reallocated", "Moved between desks"], ["status_changed", "State changed"],
  ["priority_changed", "Re-rated"], ["note_added", "A line was added"],
  ["resolved", "Resolved"], ["reopened", "Reopened"], ["closed", "Closed"],
  ["withdrawn", "Taken off the boards"]
];

const label = (list: [string, string][], key: string | null | undefined) =>
  list.find(([k]) => k === key)?.[1] ?? key ?? "—";

type Row = {
  id: string; ref: string; ts: string; updated_at: string; reporter_name: string;
  reporter_email: string | null; channel: string; category: string; subject: string;
  priority: string; status: string; company_tenant_id: string | null; company_name: string | null;
  department_id: string | null; department_name: string | null; has_phone: boolean;
  allocated_at: string | null; resolved_at: string | null; allocated_by_name: string | null;
  events: number; last_activity: string | null;
};
type DeskSeat = { id: string; name: string; key: string };
type Load = DeskSeat & {
  sort: number; unallocated: number; working: number; pressing: number; settled: number;
  oldest_open: string | null;
};
type Summary = { n: number; unallocated: number; working: number; settled: number; pressing: number };
type Desk = {
  can_manage: boolean; window_days: number; summary: Summary; departments: Load[];
  my_departments: DeskSeat[]; items: Row[];
};
type Ticket = Omit<Row, "has_phone" | "events" | "last_activity" | "allocated_by_name"> & {
  body: string; department_key: string | null; resolution: string | null;
  allocated_by_name: string | null; resolved_by_name: string | null; created_by_name: string | null;
  phone: string | null; phone_unreadable: boolean;
  caller_history: {
    calls: number; still_open: number; last_30d: number;
    first_call: string | null; last_call: string | null;
  } | null;
};
type EventLine = {
  id: string; ts: string; action: string; reason: string | null;
  from_label: string | null; to_label: string | null;
  department_from_id: string | null; department_to_id: string | null;
  detail: Record<string, any> | null; actor_user_id: string | null;
  actor_role: string | null; actor_name: string | null;
};

type Filter = {
  status: string; department: string; mine: string; category: string; priority: string;
  q: string; phone: string; company: string; days: string; limit: string;
};
const EMPTY_FILTER: Filter = {
  status: "", department: "", mine: "", category: "", priority: "",
  q: "", phone: "", company: "", days: "60", limit: "60"
};

/** One draft object for every form on the desk, the way the org chart does it: a panel that
 *  reuses the last panel's typing is how a reason ends up on the wrong incidence. */
type Draft = {
  reporterName: string; reporterEmail: string; reporterPhone: string; channel: string;
  companyTenantId: string; companyName: string; category: string; subject: string;
  body: string; priority: string; departmentId: string; reason: string;
  toDepartment: string; workStatus: string; reopen: boolean; outcome: string; resolution: string;
  priorityTo: string;
};
const EMPTY_DRAFT: Draft = {
  reporterName: "", reporterEmail: "", reporterPhone: "", channel: "phone_call",
  companyTenantId: "", companyName: "", category: "", subject: "", body: "",
  priority: "normal", departmentId: "", reason: "", toDepartment: "", workStatus: "in_progress",
  reopen: false, outcome: "resolved", resolution: "", priorityTo: ""
};
type PanelKind = "new" | "allocate" | "unallocate" | "work" | "resolve" | "priority" | "note" | "tombstone";
type Panel = { kind: PanelKind; ticketId?: string; ticketRef?: string };

const E164 = /^\+[1-9]\d{7,14}$/;
const when = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const day = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—";

/** How long it has been sitting, in the unit an operator acts on. The register is read by
 *  somebody deciding whether to ring back, so "3 days" beats a timestamp they must subtract. */
function age(iso: string | null | undefined): string {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 0)} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h`;
  const days = Math.round(mins / 1440);
  return days < 30 ? `${days} d` : `${Math.round(days / 30)} mo`;
}

const STATUS_EDGE: Record<string, string> = {
  open: "var(--warning)", allocated: "var(--adm-accent)", in_progress: "var(--adm-accent)",
  resolved: "var(--success)", closed: "var(--ink-soft)"
};
const PRIORITY_EDGE: Record<string, string> = {
  low: "var(--ink-soft)", normal: "var(--adm-accent)", high: "var(--warning)", urgent: "var(--danger)"
};
const EVENT_EDGE: Record<string, string> = {
  logged: "var(--adm-accent)", allocated: "var(--success)", reallocated: "var(--warning)",
  status_changed: "var(--adm-accent)", priority_changed: "var(--warning)",
  note_added: "var(--ink-soft)", resolved: "var(--success)", reopened: "var(--danger)",
  closed: "var(--ink-soft)", withdrawn: "var(--danger)"
};

const box = "mt-4 w-full rounded-input border px-10 py-8 text-sm";
const boxStyle = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" };
const labelText = "text-[11px]";

export default function ControlTicketsPage() {
  const [me, setMe] = useState<any>(null);
  const [desk, setDesk] = useState<Desk | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);

  const [f, setF] = useState<Filter>(EMPTY_FILTER);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const [opened, setOpened] = useState<string | null>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [events, setEvents] = useState<EventLine[]>([]);
  const [sheetLoading, setSheetLoading] = useState(false);

  const [companyQ, setCompanyQ] = useState("");
  const [companyHits, setCompanyHits] = useState<any[] | null>(null);
  const [companyNote, setCompanyNote] = useState<string | null>(null);
  const [companyBusy, setCompanyBusy] = useState(false);

  const seq = useRef(0);
  const detailSeq = useRef(0);

  const canManage = !!desk?.can_manage;
  const myDesks = desk?.my_departments ?? [];

  // ---------- the queue ----------
  const load = useCallback(async (filter: Filter) => {
    const mine = ++seq.current;
    const params = new URLSearchParams();
    if (filter.status) params.set("status", filter.status);
    if (filter.department) params.set("department", filter.department);
    if (filter.mine) params.set("mine", "1");
    if (filter.category) params.set("category", filter.category);
    if (filter.priority) params.set("priority", filter.priority);
    if (filter.q.trim()) params.set("q", filter.q.trim());
    // Eight digits is the API's floor for a number search; sending a shorter term is a 400
    // the desk would rather not show while somebody is still typing.
    if (filter.phone.replace(/\D/g, "").length >= 8) params.set("phone", filter.phone.trim());
    if (filter.company) params.set("company", filter.company);
    params.set("days", filter.days);
    params.set("limit", filter.limit);
    const res = await fetch(`${API}/api/v1/control/tickets?${params}`, { credentials: "include" });
    if (mine !== seq.current) return;
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j?.error?.message ?? "The register did not answer.");
      setLoading(false);
      return;
    }
    setDesk(await res.json());
    setError(null); setLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
    })();
  }, []);

  // Two of the ten filters are typed, so the register is re-read on a pause rather than on
  // every keystroke — an ilike over the whole body column on each letter is a queue that
  // arrives late, and the operator keeps typing anyway.
  useEffect(() => {
    const t = setTimeout(() => { load(f); }, 320);
    return () => clearTimeout(t);
  }, [f, load]);

  // ---------- one incidence ----------
  const loadDetail = useCallback(async (id: string) => {
    const mine = ++detailSeq.current;
    setSheetLoading(true);
    const res = await fetch(`${API}/api/v1/control/tickets/${id}`, { credentials: "include" });
    if (mine !== detailSeq.current) return;
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j?.error?.message ?? "That incidence did not answer.");
      setSheetLoading(false);
      return;
    }
    const j = await res.json();
    setTicket(j.ticket); setEvents(j.events ?? []);
    setSheetLoading(false);
  }, []);

  function openTicket(id: string) {
    setPanel(null); setPanelError(null); setArmed(null);
    setNotice(null);
    setOpened(id); setTicket(null); setEvents([]);
    setDraft({ ...EMPTY_DRAFT });
    loadDetail(id);
  }
  function closeTicket() {
    setOpened(null); setTicket(null); setEvents([]); setPanel(null); setPanelError(null);
    setArmed(null);
  }

  /** Opening an action form on the incidence it belongs to. Re-tapping the same button closes
   *  it; tapping another one never inherits the previous panel's reason or resolution. */
  function openPanel(next: Panel) {
    const closing = panel?.kind === next.kind && panel?.ticketId === next.ticketId;
    // A half-written call survives its own panel being closed by a mis-tap; a reason box does
    // not survive a different panel, because that is how one sentence lands on another ticket.
    if (!closing || next.kind !== "new") setDraft({ ...EMPTY_DRAFT });
    setPanelError(null); setNotice(null); setArmed(null);
    setPanel(closing ? null : next);
  }

  const refresh = useCallback(() => { load(f); }, [f, load]);
  const settle = (message: string) => {
    setNotice(message); setPanel(null); setArmed(null);
    if (opened) loadDetail(opened);
    refresh();
  };

  /** Every write goes through here. The API answers a bad body with a field list, and that
   *  list is the only part of the reply that says what to fix. */
  async function write(method: "POST", path: string, body: unknown): Promise<any | null> {
    setBusy(true); setPanelError(null);
    try {
      const res = await fetch(`${API}/api/v1/control/tickets${path}`, {
        method, headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify(body ?? {})
      });
      if (res.status === 401) { window.location.href = "/control/login"; return null; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hints = (j?.error?.details ?? []).map((d: any) => d.message ?? d.field).filter(Boolean).slice(0, 3);
        setPanelError([j?.error?.message ?? "The register refused.", ...hints].join(" — "));
        return null;
      }
      return j;
    } finally { setBusy(false); }
  }

  // ---------- the log-a-call form ----------
  const callReady = useMemo(() => {
    const p: string[] = [];
    if (draft.reporterName.trim().length < 2) p.push("Who rang, as they said it (two letters at least).");
    if (draft.reporterEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(draft.reporterEmail.trim()))
      p.push("The email is not an address, or leave it empty.");
    if (draft.reporterPhone.trim() && !E164.test(draft.reporterPhone.trim()))
      p.push("A callback number needs the country code: +255…");
    if (!draft.companyTenantId && draft.companyName.trim().length < 2)
      p.push("Which company rang — pick the account or type the name.");
    if (!draft.category) p.push("Choose what kind of problem it is.");
    if (draft.subject.trim().length < 4) p.push("The subject in four letters or more.");
    if (draft.body.trim().length < 10) p.push("Write down what they said — ten letters at least.");
    return p;
  }, [draft]);

  async function searchCompany() {
    const q = companyQ.trim();
    if (q.length < 2) { setCompanyNote("Type at least two letters of the company name."); return; }
    setCompanyBusy(true); setCompanyHits(null); setCompanyNote(null);
    try {
      const res = await fetch(`${API}/api/v1/control/tenants?q=${encodeURIComponent(q)}`,
        { credentials: "include" });
      if (res.status === 403) {
        setCompanyNote("This seat cannot read the account list. Type the name the caller gave — "
          + "the register keeps what was said.");
        return;
      }
      if (!res.ok) { setCompanyNote("The account list did not answer. Type the name instead."); return; }
      const rows = await res.json();
      setCompanyHits(rows);
      if (!rows.length) setCompanyNote("No live account is spelled like that. If they have not signed "
        + "up yet, type the name as the caller said it.");
    } finally { setCompanyBusy(false); }
  }

  async function submitCall() {
    if (callReady.length) { setPanelError("Not yet: " + callReady.join(" ")); return; }
    const j = await write("POST", "", {
      reporterName: draft.reporterName.trim(),
      reporterEmail: draft.reporterEmail.trim() || null,
      reporterPhone: draft.reporterPhone.trim() || null,
      channel: draft.channel,
      companyTenantId: draft.companyTenantId || null,
      companyName: draft.companyName.trim() || null,
      category: draft.category, subject: draft.subject.trim(), body: draft.body.trim(),
      priority: draft.priority, departmentId: draft.departmentId || null,
      reason: draft.reason.trim() || null
    });
    if (!j) return;
    setNotice(`${j.ref} is in the register — `
      + (j.allocated_to ? `straight to ${j.allocated_to}.` : "waiting for a department."));
    setPanel(null); setDraft({ ...EMPTY_DRAFT });
    setCompanyQ(""); setCompanyHits(null); setCompanyNote(null);
    refresh();
  }

  // ---------- the six moves on an incidence ----------
  async function submitAllocate(to: string | null) {
    const j = await write("POST", `/${ticket!.id}/allocate`, {
      departmentId: to, reason: draft.reason.trim()
    });
    if (!j) return;
    settle(to
      ? `${j.ref} now belongs to ${desk?.departments.find((d) => d.id === to)?.name ?? "that desk"}.`
      : `${j.ref} is back in the queue — nobody holds it.`);
  }

  async function submitWork() {
    const j = await write("POST", `/${ticket!.id}/work`, {
      status: draft.workStatus, reopen: draft.reopen, reason: draft.reason.trim()
    });
    if (!j) return;
    settle(`${j.ref} is ${label(STATUSES, j.status)} now`
      + (draft.reopen ? " — reopened, because the first answer did not hold." : "."));
  }

  async function submitResolve() {
    if (draft.resolution.trim().length < 4) {
      setPanelError("Say what was done — the register will not call a job finished without it.");
      return;
    }
    const j = await write("POST", `/${ticket!.id}/resolve`, {
      outcome: draft.outcome, resolution: draft.resolution.trim(), reason: draft.reason.trim()
    });
    if (!j) return;
    settle(`${j.ref} is ${j.status}. ${j.resolution.slice(0, 90)}${j.resolution.length > 90 ? "…" : ""}`);
  }

  async function submitPriority() {
    if (!draft.priorityTo) { setPanelError("Choose the new rating first."); return; }
    const j = await write("POST", `/${ticket!.id}/priority`, {
      priority: draft.priorityTo, reason: draft.reason.trim()
    });
    if (!j) return;
    settle(`${j.ref} is ${label(PRIORITIES, j.priority)} now.`);
  }

  async function submitNote() {
    const j = await write("POST", `/${ticket!.id}/note`, { reason: draft.reason.trim() });
    if (!j) return;
    settle(`A line was added to ${j.ref}. Nothing about it changed.`);
  }

  async function submitTombstone() {
    const j = await write("POST", `/${ticket!.id}/tombstone`, { reason: draft.reason.trim() });
    if (!j) return;
    setNotice(`${j.ref} is off the boards. The register keeps every line it has ever had.`);
    setPanel(null); setArmed(null); closeTicket(); refresh();
  }

  const twoTap = (key: string, run: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    setArmed(null); run();
  };

  const reasonReady = draft.reason.trim().length >= 4;
  const deptName = (id: string | null | undefined) =>
    desk?.departments.find((d) => d.id === id)?.name ?? id ?? "—";
  /** Which desk a register line moved the incidence between. "the queue" is an answer to
   *  "who has it", so it is named instead of left blank; a line that moved nothing between
   *  desks — a note, a re-rate, work on the same desk — says nothing here. */
  const moveWords = (ev: EventLine) => {
    if (ev.action === "logged" || (!ev.department_from_id && !ev.department_to_id)) return "";
    const from = ev.department_from_id ? deptName(ev.department_from_id) : "the queue";
    const to = ev.department_to_id ? deptName(ev.department_to_id) : "the queue";
    return from === to ? "" : ` · ${from} → ${to}`;
  };

  const summary: Summary = desk?.summary ?? { n: 0, unallocated: 0, working: 0, settled: 0, pressing: 0 };
  const stats: [string | number, string, string?][] = desk ? [
    [summary.n, `Written down in ${desk.window_days} days`,
      `CS numbers issued since ${desk.window_days} days ago, on this filter`],
    [summary.unallocated, "Nobody holds them", "Still in the queue — 101 will not let one be worked"],
    [summary.working, "With a department", "Allocated or being worked on"],
    [summary.pressing, "High or urgent and not finished", "The list to read first"],
    [summary.settled, "Settled", "Resolved or closed on this filter"]
  ] : [];

  if (forbidden) {
    return (
      <div className="control-shell page-shell flex-1">
        <header className="flex flex-wrap items-center justify-between px-24 py-12"
          style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <ControlNav />
        </header>
        <main className="mx-auto max-w-[900px] px-16 py-32">
          <div className="rounded-card border p-24" style={{ borderColor: "var(--line)" }}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              This register is not yours to read
            </h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ") || "no platform duty"}.
              Reading the customer service register needs <code>control.tickets.view</code>; logging a call,
              handing it to a department and settling it needs <code>control.tickets.manage</code>. A callback
              number is only ever shown to a seat that can read the register.
            </p>
            <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            {canManage ? "Customer service" : "Customer service · read-only"} · every call, numbered
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1240px] px-16 py-32">
        <div className="flex flex-wrap items-end justify-between gap-16">
          <div>
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
              The customer service register
            </h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Who rang, what they said the problem is, and which department owns it now. Each incidence
              gets a number the caller can quote — <code>CS-{new Date().getFullYear()}-00042</code> — and
              every move on it is written with the reason a person would defend out loud.
            </p>
          </div>
          {canManage && (
            <button type="button" onClick={() => openPanel({ kind: "new" })}
              className="waisha-btn min-h-[36px] rounded-input px-16 py-8 text-xs font-semibold">
              {panel?.kind === "new" ? "Close the form" : "Log a call"}
            </button>
          )}
        </div>

        <div className="mt-20 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          {stats.map(([value, text, hint]) => (
            <div key={text} className="rounded-card border p-14"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }} title={hint}>
              <p className="text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>{value}</p>
              <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ color: "var(--ink-soft)" }}>{text}</p>
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

        {/* ---------------- log a call ---------------- */}
        {panel?.kind === "new" && (
          <section className="mt-20 rounded-card border p-20"
            style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
            <h2 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
              Write down what the caller said
            </h2>
            <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              Say their name as they said it. If you cannot hear it, say so in the body rather than guessing —
              a register that is tidy instead of true is useless to the next person who picks up.
            </p>
            {panelError && (
              <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
                {panelError}
              </div>
            )}

            <div className="mt-14 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                Who rang
                <input value={draft.reporterName} onChange={(e) => setDraft({ ...draft, reporterName: e.target.value })}
                  placeholder="Amina Juma" className={box} style={boxStyle} />
              </label>
              <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                Callback number — +255…
                <input value={draft.reporterPhone} onChange={(e) => setDraft({ ...draft, reporterPhone: e.target.value })}
                  placeholder="+255717601440" inputMode="tel" className={box} style={boxStyle} />
              </label>
              <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                Email (optional)
                <input value={draft.reporterEmail} onChange={(e) => setDraft({ ...draft, reporterEmail: e.target.value })}
                  placeholder="amina@company.co.tz" className={box} style={boxStyle} />
              </label>
              <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                How they reached us
                <select value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value })}
                  className={box} style={boxStyle}>
                  {CHANNELS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            </div>

            <div className="mt-14 rounded-card border p-14" style={{ borderColor: "var(--line)" }}>
              <p className={`${labelText} font-semibold uppercase tracking-[0.12em]`} style={{ color: "var(--ink-soft)" }}>
                Which company is this about
              </p>
              <div className="mt-8 flex flex-wrap items-end gap-10">
                <label className={`${labelText} min-w-[240px] flex-1 block`} style={{ color: "var(--ink-soft)" }}>
                  Find the account on the platform
                  <input value={companyQ} onChange={(e) => setCompanyQ(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchCompany(); } }}
                    placeholder="Wema" className={box} style={boxStyle} />
                </label>
                <button type="button" onClick={searchCompany} disabled={companyBusy}
                  className="rounded-input border px-14 py-8 text-xs font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                  {companyBusy ? "Searching…" : "Search accounts"}
                </button>
              </div>
              {companyHits?.map((t: any) => (
                <button key={t.tenant_id} type="button"
                  onClick={() => {
                    setDraft({ ...draft, companyTenantId: t.tenant_id, companyName: t.name });
                    setCompanyNote(null);
                  }}
                  className="mt-8 block w-full rounded-input border px-12 py-8 text-left text-xs"
                  style={{
                    borderColor: draft.companyTenantId === t.tenant_id ? "var(--adm-accent)" : "var(--line)",
                    background: draft.companyTenantId === t.tenant_id ? "var(--adm-accent-soft)" : "var(--milk)",
                    color: "var(--ink)"
                  }}>
                  <span className="font-semibold">{t.name}</span>
                  <span style={{ color: "var(--ink-soft)" }}>
                    {" "}{t.tenant_type} · {t.status}
                    {t.plan_name ? ` · ${t.plan_name}` : ""}
                  </span>
                  {draft.companyTenantId === t.tenant_id && (
                    <span className="ml-8 font-semibold" style={{ color: "var(--adm-accent)" }}>chosen</span>
                  )}
                </button>
              ))}
              {companyNote && (
                <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>{companyNote}</p>
              )}
              <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                Company name
                <input value={draft.companyName} disabled={!!draft.companyTenantId}
                  onChange={(e) => setDraft({ ...draft, companyName: e.target.value })}
                  placeholder="Type it as the caller said it" className={box}
                  style={draft.companyTenantId ? { ...boxStyle, opacity: 0.6 } : boxStyle} />
              </label>
              {draft.companyTenantId && (
                <button type="button"
                  onClick={() => { setDraft({ ...draft, companyTenantId: "", companyName: "" }); setCompanyHits(null); }}
                  className="mt-8 rounded-input border px-12 py-6 text-[11px] font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  It is not that account — type the name instead
                </button>
              )}
              <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                Linking the account is better than typing it: the register can then show every call that
                company has ever made. The platform's own spelling wins over what is typed here.
              </p>
            </div>

            <div className="mt-14 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
              <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                What kind of problem
                <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  className={box} style={boxStyle}>
                  <option value="">Choose one</option>
                  {CATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                How pressing
                <select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}
                  className={box} style={boxStyle}>
                  {PRIORITIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                Send it straight to a department (optional)
                <select value={draft.departmentId} onChange={(e) => setDraft({ ...draft, departmentId: e.target.value })}
                  className={box} style={boxStyle}>
                  <option value="">Nobody yet — leave it in the queue</option>
                  {(desk?.departments ?? []).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
              Subject — one line somebody will quote
              <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
                placeholder="Clearing agent cannot open the cargo file" className={box} style={boxStyle} />
            </label>
            <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
              What they said, in their words
              <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                rows={4} placeholder="She says the file CS-… opens for the director and errors for the clearing agent. They tried twice this morning."
                className={box} style={boxStyle} />
              <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                {draft.body.trim().length} of 4000 characters — ten is the floor.
              </span>
            </label>
            <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
              Why it is being logged (optional — the register defaults to the subject)
              <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                placeholder="The caller asked for it to be written down rather than repeated." className={box}
                style={boxStyle} />
            </label>

            {!!callReady.length && !panelError && (
              <ul className="mt-12 space-y-4 text-[11px]" style={{ color: "var(--warning)" }}>
                {callReady.map((p) => <li key={p}>· {p}</li>)}
              </ul>
            )}
            <div className="mt-14 flex gap-12">
              <button type="button" disabled={busy || !!callReady.length} onClick={submitCall}
                className="waisha-btn rounded-input px-18 py-8 text-xs font-semibold">
                Write it into the register
              </button>
              <button type="button" onClick={() => setPanel(null)}
                className="rounded-input border px-18 py-8 text-xs font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>Cancel</button>
            </div>
            {(desk?.departments ?? []).length === 0 && (
              <p className="mt-12 text-[11px]" style={{ color: "var(--warning)" }}>
                No desk is open on the platform chart, so nothing can be handed over — the org chart page
                opens one.
              </p>
            )}
          </section>
        )}

        {/* ---------------- one incidence ---------------- */}
        {opened && (
          <section className="mt-24 rounded-card border p-20"
            style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
            {sheetLoading && <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Reading the file…</p>}
            {!sheetLoading && ticket && (
              <>
                <div className="flex flex-wrap items-start justify-between gap-16">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-[0.16em]" style={{ color: "var(--adm-accent)" }}>
                      {ticket.ref}
                    </p>
                    <h2 className="mt-4 text-lg font-bold" style={{ color: "var(--ink)" }}>{ticket.subject}</h2>
                    <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>
                      {label(CHANNELS, ticket.channel)} from {ticket.reporter_name}
                      {ticket.company_name ? ` — ${ticket.company_name}` : ""}
                      {` · called in ${when(ticket.ts)} · `}
                      {label(CATEGORIES, ticket.category)}
                    </p>
                  </div>
                  <div className="flex items-center gap-10">
                    <span className="px-10 py-5 text-[10px] font-bold uppercase tracking-[0.1em]"
                      style={{ borderLeft: `4px solid ${STATUS_EDGE[ticket.status]}`, color: "var(--ink)" }}>
                      {label(STATUSES, ticket.status)}
                    </span>
                    <span className="px-10 py-5 text-[10px] font-bold uppercase tracking-[0.1em]"
                      style={{ borderLeft: `4px solid ${PRIORITY_EDGE[ticket.priority]}`, color: "var(--ink)" }}>
                      {label(PRIORITIES, ticket.priority)}
                    </span>
                    <button type="button" onClick={closeTicket}
                      className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      Close the file
                    </button>
                  </div>
                </div>

                <p className="mt-14 whitespace-pre-line text-sm" style={{ color: "var(--ink)" }}>{ticket.body}</p>

                <div className="mt-16 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
                  <div className="rounded-card border p-14" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      Who to ring back
                    </p>
                    {ticket.phone ? (
                      <a href={`tel:${ticket.phone}`} className="mt-6 block text-sm font-semibold"
                        style={{ color: "var(--adm-accent)" }}>
                        {ticket.phone}
                      </a>
                    ) : ticket.phone_unreadable ? (
                      <p className="mt-6 text-sm" style={{ color: "var(--warning)" }}>
                        A number is on file but this key cannot open it — the encryption key changed
                        after the call was logged.
                      </p>
                    ) : (
                      <p className="mt-6 text-sm" style={{ color: "var(--ink-soft)" }}>No number was given.</p>
                    )}
                    {ticket.reporter_email && (
                      <a href={`mailto:${ticket.reporter_email}`} className="mt-6 block truncate text-xs"
                        style={{ color: "var(--adm-accent)" }}>{ticket.reporter_email}</a>
                    )}
                    {ticket.caller_history && (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        {ticket.caller_history.calls} call{ticket.caller_history.calls === 1 ? "" : "s"} from this
                        number · {ticket.caller_history.still_open} still open ·{" "}
                        {ticket.caller_history.last_30d} in the last 30 days · first {day(ticket.caller_history.first_call)}
                      </p>
                    )}
                    <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      Shown because this seat holds <code>control.tickets.view</code>. It is on no list row.
                    </p>
                  </div>

                  <div className="rounded-card border p-14" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      Who holds it
                    </p>
                    <p className="mt-6 text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {ticket.department_name ?? <span style={{ color: "var(--warning)" }}>the unallocated queue</span>}
                    </p>
                    <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      {ticket.allocated_at
                        ? `Handed over ${when(ticket.allocated_at)}${ticket.allocated_by_name ? ` by ${ticket.allocated_by_name}` : ""}`
                        : "Nobody has it yet."}
                      <br />Logged by {ticket.created_by_name ?? "—"} · sitting {age(ticket.ts)}
                    </p>
                    {ticket.resolved_at && (
                      <p className="mt-6 text-[11px]" style={{ color: "var(--success)" }}>
                        {ticket.status === "closed" ? "Closed" : "Resolved"} {when(ticket.resolved_at)}
                        {ticket.resolved_by_name ? ` by ${ticket.resolved_by_name}` : ""}
                      </p>
                    )}
                  </div>
                </div>

                {ticket.resolution && (
                  <div className="mt-14 rounded-card border p-14"
                    style={{ borderColor: "var(--success)", background: "color-mix(in srgb, var(--success) 6%, transparent)" }}>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--success)" }}>
                      What was done
                    </p>
                    <p className="mt-6 whitespace-pre-line text-sm" style={{ color: "var(--ink)" }}>{ticket.resolution}</p>
                  </div>
                )}

                {panelError && (
                  <div role="alert" className="mt-14 rounded-input px-12 py-8 text-sm"
                    style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
                    {panelError}
                  </div>
                )}

                {/* -------- the moves -------- */}
                {canManage && (
                  <div className="mt-18 flex flex-wrap gap-8">
                    {ticket.status !== "resolved" && ticket.status !== "closed" && (
                      <>
                        <button type="button" onClick={() => openPanel({ kind: "allocate", ticketId: ticket.id, ticketRef: ticket.ref })}
                          className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                          style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                          {ticket.department_id ? "Move it to another desk" : "Hand it to a department"}
                        </button>
                        {ticket.department_id && (
                          <button type="button" onClick={() => openPanel({ kind: "unallocate", ticketId: ticket.id, ticketRef: ticket.ref })}
                            className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--warning)" }}>
                            Back to the queue
                          </button>
                        )}
                        <button type="button" onClick={() => openPanel({ kind: "work", ticketId: ticket.id, ticketRef: ticket.ref })}
                          className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                          style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                          Say it is being worked
                        </button>
                      </>
                    )}
                    {ticket.department_id && ticket.status !== "closed" && (
                      <button type="button" onClick={() => openPanel({ kind: "resolve", ticketId: ticket.id, ticketRef: ticket.ref })}
                        className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                        style={{ borderColor: "var(--line)", color: "var(--success)" }}>
                        Settle it
                      </button>
                    )}
                    {(ticket.status === "resolved" || ticket.status === "closed") && (
                      <button type="button" onClick={() => openPanel({ kind: "work", ticketId: ticket.id, ticketRef: ticket.ref })}
                        className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                        style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                        The caller rang back
                      </button>
                    )}
                    <button type="button" onClick={() => openPanel({ kind: "priority", ticketId: ticket.id, ticketRef: ticket.ref })}
                      className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                      Re-rate it
                    </button>
                    <button type="button" onClick={() => openPanel({ kind: "note", ticketId: ticket.id, ticketRef: ticket.ref })}
                      className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      Add a line, change nothing
                    </button>
                    {ticket.status === "closed" && (
                      <button type="button" onClick={() => openPanel({ kind: "tombstone", ticketId: ticket.id, ticketRef: ticket.ref })}
                        className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                        style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                        Take it off the boards
                      </button>
                    )}
                  </div>
                )}

                {canManage && panel && panel.kind !== "new" && panel.ticketId === ticket.id && (
                  <div className="mt-16 rounded-card border p-16"
                    style={{ borderColor: "var(--adm-line)", background: "var(--milk)" }}>
                    {panel.kind === "allocate" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                          Who owns {ticket.ref} now
                        </p>
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          {ticket.department_name
                            ? `It is with ${ticket.department_name}. Moving it writes both desks into the register.`
                            : "It is in the queue. Handing it over is the move that takes it out."}
                        </p>
                        <select value={draft.toDepartment}
                          onChange={(e) => setDraft({ ...draft, toDepartment: e.target.value })}
                          className={box} style={boxStyle}>
                          <option value="">Choose a desk</option>
                          {(desk?.departments ?? [])
                            .filter((d) => d.id !== ticket.department_id)
                            .map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name} — {d.working} working, {d.pressing} pressing
                              </option>
                            ))}
                        </select>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Why it goes there
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="The clearing agent's login problem is an access fault, not a billing one."
                            className={box} style={boxStyle} />
                        </label>
                        <button type="button" disabled={busy || !reasonReady || !draft.toDepartment}
                          onClick={() => submitAllocate(draft.toDepartment)}
                          className="waisha-btn mt-12 rounded-input px-14 py-6 text-xs font-semibold">
                          Hand it over
                        </button>
                      </>
                    )}

                    {panel.kind === "unallocate" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--warning)" }}>
                          Put {ticket.ref} back in the queue
                        </p>
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          Nobody holds it after this, and the allocation line goes with it — 101 will not let a
                          ticket claim an owner it does not have.
                        </p>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Why nobody holds it
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="Fleet answered that the plate is not theirs; it needs the directory desk."
                            className={box} style={boxStyle} />
                        </label>
                        <button type="button" disabled={busy || !reasonReady} onClick={() => submitAllocate(null)}
                          className="mt-12 rounded-input px-14 py-6 text-xs font-semibold"
                          style={{ border: "1px solid var(--warning)", color: "var(--warning)" }}>
                          Back to the queue
                        </button>
                      </>
                    )}

                    {panel.kind === "work" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                          {ticket.department_name ?? "A desk"} is on it
                        </p>
                        {!ticket.department_id && (
                          <p className="mt-6 text-[11px]" style={{ color: "var(--danger)" }}>
                            Nobody holds {ticket.ref} yet, so work cannot start — the API says so, and it is
                            right: the number means nothing to the caller until somebody owns it.
                          </p>
                        )}
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          What state it is in
                          <select value={draft.workStatus}
                            onChange={(e) => setDraft({ ...draft, workStatus: e.target.value })}
                            className={box} style={boxStyle}>
                            <option value="allocated">Handed over, not yet started</option>
                            <option value="in_progress">Being worked on</option>
                          </select>
                        </label>
                        {(ticket.status === "resolved" || ticket.status === "closed") && (
                          <label className={`${labelText} mt-12 flex items-start gap-8`} style={{ color: "var(--ink)" }}>
                            <input type="checkbox" checked={draft.reopen} className="mt-4"
                              onChange={(e) => setDraft({ ...draft, reopen: e.target.checked })} />
                            The caller rang back — this is a second attempt at a finished job, not a quiet edit.
                          </label>
                        )}
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Why
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="Chumba opened a session with the clearing agent and is reproducing it."
                            className={box} style={boxStyle} />
                        </label>
                        <button type="button"
                          disabled={busy || !reasonReady || !ticket.department_id
                            || ((ticket.status === "resolved" || ticket.status === "closed") && !draft.reopen)}
                          onClick={submitWork}
                          className="waisha-btn mt-12 rounded-input px-14 py-6 text-xs font-semibold">
                          {ticket.status === "resolved" || ticket.status === "closed" ? "Reopen it" : "Record the state"}
                        </button>
                      </>
                    )}

                    {panel.kind === "resolve" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--success)" }}>
                          Finish {ticket.ref}
                        </p>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Which kind of finished
                          <select value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}
                            className={box} style={boxStyle}>
                            <option value="resolved">Resolved — we answered them</option>
                            <option value="closed">Closed — it ends here (not our problem, or they stopped answering)</option>
                          </select>
                        </label>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          What was done — the sentence the caller is told
                          <textarea value={draft.resolution} rows={3}
                            onChange={(e) => setDraft({ ...draft, resolution: e.target.value })}
                            placeholder="Reset the agent's role to clearing staff and rang her back; she confirmed the file opens."
                            className={box} style={boxStyle} />
                        </label>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Why now
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="She confirmed on the phone that it works."
                            className={box} style={boxStyle} />
                        </label>
                        <button type="button" disabled={busy || !reasonReady || draft.resolution.trim().length < 4}
                          onClick={submitResolve}
                          className="waisha-btn mt-12 rounded-input px-14 py-6 text-xs font-semibold">
                          {draft.outcome === "resolved" ? "Mark it resolved" : "Close it"}
                        </button>
                      </>
                    )}

                    {panel.kind === "priority" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                          Re-rate {ticket.ref}
                        </p>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          How pressing — it is {label(PRIORITIES, ticket.priority)} now
                          <select value={draft.priorityTo}
                            onChange={(e) => setDraft({ ...draft, priorityTo: e.target.value })}
                            className={box} style={boxStyle}>
                            <option value="">Choose the new rating</option>
                            {PRIORITIES.filter(([k]) => k !== ticket.priority).map(([k, v]) => (
                              <option key={k} value={k}>{v}</option>
                            ))}
                          </select>
                        </label>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Why
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="Their whole clearing team is standing still, not one agent."
                            className={box} style={boxStyle} />
                        </label>
                        <button type="button" disabled={busy || !reasonReady || !draft.priorityTo}
                          onClick={submitPriority}
                          className="waisha-btn mt-12 rounded-input px-14 py-6 text-xs font-semibold">
                          Change the rating
                        </button>
                      </>
                    )}

                    {panel.kind === "note" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                          A line on {ticket.ref}, nothing else
                        </p>
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          Use it for what the next person needs and no state change carries: who you spoke to,
                          what you are waiting for.
                        </p>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          The line
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="Rang the head office; they are checking with the agent in Dar."
                            className={box} style={boxStyle} />
                        </label>
                        <button type="button" disabled={busy || !reasonReady} onClick={submitNote}
                          className="waisha-btn mt-12 rounded-input px-14 py-6 text-xs font-semibold">
                          Add it
                        </button>
                      </>
                    )}

                    {panel.kind === "tombstone" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--danger)" }}>
                          Take {ticket.ref} off the boards
                        </p>
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          It stops appearing in every queue. The row, its number and every line of its register
                          stay — a support record that can be destroyed is not evidence. Only a closed incidence
                          can be withdrawn.
                        </p>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Why it is being withdrawn
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="Duplicate of CS-2026-00039, logged twice by two desks."
                            className={box} style={boxStyle} />
                        </label>
                        <button type="button" disabled={busy || !reasonReady}
                          onClick={twoTap(`tomb:${ticket.id}`, submitTombstone)}
                          className="mt-12 rounded-input px-14 py-6 text-xs font-semibold"
                          style={{
                            background: armed === `tomb:${ticket.id}` ? "var(--danger)" : "transparent",
                            border: "1px solid var(--danger)",
                            color: armed === `tomb:${ticket.id}` ? "#fff" : "var(--danger)"
                          }}>
                          {armed === `tomb:${ticket.id}` ? "Tap again to withdraw it" : "Withdraw it"}
                        </button>
                      </>
                    )}
                  </div>
                )}

                {/* -------- the story -------- */}
                <div className="mt-20">
                  <h3 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                    Everything that has been done to it — {events.length} line{events.length === 1 ? "" : "s"}
                  </h3>
                  <ol className="mt-12 space-y-10">
                    {events.map((ev) => (
                      <li key={ev.id} className="rounded-card border p-12"
                        style={{ borderColor: "var(--line)", borderLeft: `4px solid ${EVENT_EDGE[ev.action] ?? "var(--line)"}` }}>
                        <p className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--ink)" }}>
                          {label(ACTIONS, ev.action)}
                          <span className="ml-10 font-normal normal-case tracking-normal" style={{ color: "var(--ink-soft)" }}>
                            {[ev.from_label && label(STATUSES, ev.from_label),
                              ev.to_label && (STATUSES.some(([k]) => k === ev.to_label)
                                ? label(STATUSES, ev.to_label) : ev.to_label)]
                              .filter(Boolean).join(" → ")}
                            {moveWords(ev)}
                          </span>
                        </p>
                        <p className="mt-6 text-sm" style={{ color: "var(--ink)" }}>
                          {ev.reason || "No reason recorded."}
                        </p>
                        <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          {when(ev.ts)} · {ev.actor_name ?? "a seat that has since gone"}
                          {ev.actor_role ? ` (${ev.actor_role})` : ""}
                          {ev.actor_user_id === me?.userId ? " — you" : ""}
                          {ev.detail?.previous_resolution
                            ? ` · the earlier answer was: ${String(ev.detail.previous_resolution).slice(0, 120)}` : ""}
                          {ev.detail?.withdrawn ? " · withdrawn from the register" : ""}
                        </p>
                      </li>
                    ))}
                    {!events.length && !sheetLoading && (
                      <li className="text-sm" style={{ color: "var(--ink-soft)" }}>
                        Nothing has been written against it yet.
                      </li>
                    )}
                  </ol>
                </div>
              </>
            )}
          </section>
        )}

        {/* ---------------- the boards ---------------- */}
        <section className="mt-28">
          <div className="flex flex-wrap items-center gap-8">
            {([["", "The whole register"], ["open", "Nobody holds it"],
              ["allocated,in_progress", "With a department"], ["resolved,closed", "Settled"]] as [string, string][])
              .map(([status, text]) => (
                <button key={text} type="button" onClick={() => setF({ ...f, status })}
                  className="rounded-input border px-14 py-8 text-xs font-semibold"
                  style={{
                    borderColor: f.status === status ? "var(--adm-accent)" : "var(--line)",
                    background: f.status === status ? "var(--adm-accent-soft)" : "transparent",
                    color: f.status === status ? "var(--adm-accent)" : "var(--ink-soft)"
                  }}>
                  {text}
                </button>
              ))}
            <button type="button"
              onClick={() => setF({ ...f, mine: f.mine ? "" : "1", department: "" })}
              disabled={!myDesks.length}
              title={myDesks.length
                ? "Only the desks this seat actually sits in"
                : "This seat sits at no desk on the platform chart — ask for one on the org chart page"}
              className="rounded-input border px-14 py-8 text-xs font-semibold"
              style={{
                borderColor: f.mine ? "var(--gold)" : "var(--line)",
                background: f.mine ? "color-mix(in srgb, var(--gold) 14%, transparent)" : "transparent",
                color: myDesks.length ? "var(--gold)" : "var(--ink-soft)",
                opacity: myDesks.length ? 1 : 0.6
              }}>
              My desk{myDesks.length ? ` — ${myDesks.map((d) => d.name).join(", ")}` : ""}
            </button>
          </div>

          <div className="mt-14 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Search numbers, names, subjects and what was said
              <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })}
                placeholder="CS-2026-00042, or Wema, or invoice" className={box} style={boxStyle} />
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Every call from one number — +255…
              <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })}
                placeholder="+255717601440" inputMode="tel" className={box} style={boxStyle} />
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Department
              <select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}
                className={box} style={boxStyle}>
                <option value="">Any desk</option>
                {(desk?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Kind
              <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}
                className={box} style={boxStyle}>
                <option value="">Any kind</option>
                {CATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Rating
              <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}
                className={box} style={boxStyle}>
                <option value="">Any rating</option>
                {PRIORITIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              How far back
              <select value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })}
                className={box} style={boxStyle}>
                {[["7", "7 days"], ["30", "30 days"], ["60", "60 days"], ["180", "6 months"], ["365", "a year"]]
                  .map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Rows
              <select value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })}
                className={box} style={boxStyle}>
                {[["30", "30"], ["60", "60"], ["120", "120"], ["200", "200"]]
                  .map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
          </div>

          {(f.status || f.department || f.mine || f.category || f.priority || f.q || f.phone || f.company
            || f.days !== EMPTY_FILTER.days) && (
            <div className="mt-12 flex flex-wrap items-center gap-8">
              <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                Filtered{f.phone.trim().length >= 7 ? " to one callback number" : ""}
                {f.company ? " to one company" : ""}.
              </p>
              <button type="button" onClick={() => setF({ ...EMPTY_FILTER })}
                className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                Show me the register again
              </button>
            </div>
          )}
        </section>

        {/* ---------------- where the work is sitting ---------------- */}
        <section className="mt-24">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
            Desk by desk
          </h2>
          <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            This is what a department sees when it opens this page on “My desk”: what it holds, how much of it
            is pressing, and how long the oldest one has been waiting.
          </p>
          <div className="mt-14 grid gap-12"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(250px, 100%), 1fr))" }}>
            {(desk?.departments ?? []).map((d) => {
              const mine = myDesks.some((m) => m.id === d.id);
              return (
                <button key={d.id} type="button" onClick={() => setF({ ...f, department: d.id, mine: "" })}
                  className="rounded-card border p-14 text-left"
                  style={{
                    borderColor: f.department === d.id ? "var(--adm-accent)" : "var(--line)",
                    background: "var(--surface)"
                  }}>
                  <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                    {d.name}{mine && <span className="ml-8 text-[10px] uppercase tracking-[0.1em]" style={{ color: "var(--gold)" }}>my desk</span>}
                  </p>
                  <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--adm-accent)" }}>
                    {d.key}
                  </p>
                  {/* One line per count, and the count travels with its word: six loose
                      flex children cannot wrap in pairs, so on a phone the third label was
                      pushed past the card and took the whole page with it. */}
                  <div className="mt-10 flex flex-wrap gap-x-16 gap-y-6">
                    <p className="flex items-baseline gap-6">
                      <span className="text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                        {d.working}
                      </span>
                      <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>working</span>
                    </p>
                    <p className="flex items-baseline gap-6">
                      <span className="text-lg font-bold tabular-nums"
                        style={{ color: d.pressing ? "var(--danger)" : "var(--ink-soft)" }}>
                        {d.pressing}
                      </span>
                      <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>pressing</span>
                    </p>
                    <p className="flex items-baseline gap-6">
                      <span className="text-lg font-bold tabular-nums" style={{ color: "var(--ink-soft)" }}>
                        {d.settled}
                      </span>
                      <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>settled</span>
                    </p>
                  </div>
                  <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {d.oldest_open ? `Oldest one waiting since ${when(d.oldest_open)} (${age(d.oldest_open)})`
                      : "Nothing in work right now."}
                  </p>
                </button>
              );
            })}
            {desk && !desk.departments.length && (
              <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
                No desk is open on the platform chart, so nothing can be handed to anybody.{" "}
                <Link href="/control/departments" style={{ color: "var(--adm-accent)" }}>Open one</Link>.
              </p>
            )}
          </div>
        </section>

        {/* ---------------- the queue ---------------- */}
        <section className="mt-28">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
            The register
          </h2>
          {loading && <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the register…</p>}
          {!loading && (desk?.items ?? []).length === 0 && (
            <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>
              Nothing on this filter. Whoever answered the phone may not have written it down yet.
            </p>
          )}
          {!!(desk?.items ?? []).length && (
            <div className="mt-14 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className="p-12">Number</th>
                    <th className="p-12">What they said</th>
                    <th className="p-12">Who rang</th>
                    <th className="p-12">Company</th>
                    <th className="p-12">Rating</th>
                    <th className="p-12">State</th>
                    <th className="p-12">Held by</th>
                    <th className="p-12">Last touched</th>
                  </tr>
                </thead>
                <tbody>
                  {(desk?.items ?? []).map((t, i) => (
                    <tr key={t.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                      <td className="p-12 align-top">
                        <button type="button" onClick={() => openTicket(t.id)}
                          className="text-xs font-bold tabular-nums underline"
                          style={{ color: "var(--adm-accent)" }}
                          title={t.events ? `${t.events} line(s) on the register` : "No lines yet"}>
                          {t.ref}
                        </button>
                        <p className="mt-4 text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                          {day(t.ts)} · {age(t.ts)} old
                        </p>
                      </td>
                      <td className="p-12 align-top" style={{ color: "var(--ink)", maxWidth: 320 }}>
                        <button type="button" onClick={() => openTicket(t.id)}
                          className="text-left text-sm font-semibold underline" style={{ color: "var(--ink)" }}>
                          {t.subject}
                        </button>
                        <p className="mt-4 text-[10px] uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>
                          {label(CATEGORIES, t.category)} · {label(CHANNELS, t.channel)}
                        </p>
                      </td>
                      <td className="p-12 align-top text-xs" style={{ color: "var(--ink)" }}>
                        {t.reporter_name}
                        <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          {t.has_phone ? "number on file" : "no number"}
                          {t.reporter_email ? " · email on file" : ""}
                        </p>
                      </td>
                      <td className="p-12 align-top text-xs" style={{ color: "var(--ink)" }}>
                        {t.company_name ?? "—"}
                        {t.company_tenant_id && (
                          <button type="button"
                            onClick={() => setF({ ...f, company: t.company_tenant_id!, q: "", phone: "" })}
                            className="mt-4 block text-[10px] underline" style={{ color: "var(--adm-accent)" }}>
                            every call about them
                          </button>
                        )}
                      </td>
                      <td className="p-12 align-top">
                        <span className="px-8 py-4 text-[10px] font-bold uppercase"
                          style={{ borderLeft: `3px solid ${PRIORITY_EDGE[t.priority]}`, color: "var(--ink)" }}>
                          {label(PRIORITIES, t.priority)}
                        </span>
                      </td>
                      <td className="p-12 align-top">
                        <span className="px-8 py-4 text-[10px] font-bold uppercase"
                          style={{ borderLeft: `3px solid ${STATUS_EDGE[t.status]}`, color: "var(--ink)" }}>
                          {label(STATUSES, t.status)}
                        </span>
                      </td>
                      <td className="p-12 align-top text-xs" style={{ color: t.department_name ? "var(--ink)" : "var(--warning)" }}>
                        {t.department_name ?? "the queue"}
                        {t.allocated_by_name && (
                          <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            by {t.allocated_by_name}
                          </p>
                        )}
                      </td>
                      <td className="p-12 align-top text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}
                        title={when(t.last_activity ?? t.updated_at)}>
                        {age(t.last_activity ?? t.updated_at)}
                        <p className="mt-4">{t.events} line{t.events === 1 ? "" : "s"}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-14 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            Urgent and unfinished rows print first, then the newest. A withdrawn incidence is off this list and
            still in the table; <Link href="/control/forensics" style={{ color: "var(--adm-accent)" }}>Forensics</Link>{" "}
            carries every write as <code>control.tickets.*</code>.
          </p>
        </section>
      </main>
    </div>
  );
}
