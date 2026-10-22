"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
const WINDOWS = [7, 30, 90, 180];
const CAPS = [25, 60, 120, 200];

/** One day of the desk's week as 123 keeps it: two wall-clock minutes in Dar es Salaam, or
 *  null when the desk is shut that day. */
type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type DayHours = { open: string; close: string } | null;
type Week = Record<DayKey, DayHours>;
const DAY_KEYS: [DayKey, string][] = [
  ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"],
  ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]
];

/** The week in the words a clerk would say down the phone. */
function weekWords(w: Week | null): string {
  if (!w) return "no working week set";
  const open = DAY_KEYS.filter(([k]) => !!w[k]);
  if (!open.length) return "shut every day of the week";
  const spans = open.map(([k]) => `${k.toUpperCase()} ${w[k]!.open}–${w[k]!.close}`);
  const same = open.length > 2
    && open.every(([k]) => w[k]!.open === w[open[0][0]]!.open && w[k]!.close === w[open[0][0]]!.close);
  return same
    ? `${open.length} days, ${w[open[0][0]]!.open}–${w[open[0][0]]!.close} (from ${open[0][1]})`
    : spans.join(" · ");
}

const asMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
/** Whether the desk is standing at this instant, on the desk's own wall clock. Tanzania keeps
 *  +02:00 all year and 123 counts minutes in Dar es Salaam, so a laptop on a ship's clock still
 *  gets the right answer. The close minute is exclusive, as `inside_hours` makes it. */
function deskOpenNow(w: Week | null, at: Date = new Date()): boolean {
  if (!w || !DAY_KEYS.some(([k]) => !!w[k])) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Dar_es_Salaam", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const openDay = w[get("weekday").slice(0, 3).toLowerCase() as DayKey];
  if (!openDay) return false;
  const mins = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
  return asMinutes(openDay.open) <= mins && mins < asMinutes(openDay.close);
}

/** How long a call has been standing, in the unit an operator acts on. */
function age(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 0)} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h`;
  const days = Math.round(mins / 1440);
  return days < 30 ? `${days} d` : `${Math.round(days / 30)} mo`;
}

/** A promise in the unit a clerk quotes: minutes under the hour, hours under the day. */
function clockWords(n: number | null): string {
  if (n === null) return "no clock";
  if (n < 60) return `${n} min`;
  if (n < 1440) return `${Math.round(n / 6) / 10} h`;
  const days = n / 1440;
  return `${Number.isInteger(days) ? days : Math.round(days * 10) / 10} day${days === 1 ? "" : "s"}`;
}

/** A clock in the unit it is owed in — minutes is what `percentile_cont` answers with, and a
 *  reader who is deciding whether to act needs "3 h 12 min", not 192. */
function mins(n: number | null): string {
  if (n === null) return "—";
  if (n < 60) return `${n} min`;
  if (n < 1440) return `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ""}`.trim();
  return `${Math.round(n / 1440)} d`;
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—";
const pct = (n: number, of: number): string => (of ? `${Math.round((n / of) * 100)}%` : "—");

const CHANNEL_WORDS: Record<string, string> = {
  phone_call: "Phone", whatsapp: "WhatsApp", email: "Email", walk_in: "Walked in",
  portal_message: "Portal", other: "Other"
};
const CATEGORY_WORDS: Record<string, string> = {
  onboarding: "Onboarding", account_access: "Account access", licence_billing: "Billing",
  cargo_clearing: "Cargo", transport_fleet: "Transport", marketplace_directory: "Marketplace",
  system_error: "System error", complaint: "Complaint", other: "Other"
};
const STATUS_WORDS: Record<string, string> = {
  open: "Nobody has started it", allocated: "Named, not started",
  in_progress: "Being worked", resolved: "Answered", closed: "Finished"
};
const STATUS_EDGE: Record<string, string> = {
  open: "var(--danger)", allocated: "var(--warning)", in_progress: "var(--adm-accent)",
  resolved: "var(--success)", closed: "var(--ink-soft)"
};

/** The two clock words this read returns (`control-departments.routes.ts`, DEPT_TICKETS_SQL).
 *  A call can hold both — answered late but fixed on time — so they are two chips, not one. */
const RESPONSE_WORDS: Record<string, string> = {
  kept: "answered on time", breached: "answer past due",
  at_risk: "answer due within the hour", on_time: "answer not yet due"
};
const RESOLUTION_WORDS: Record<string, string> = {
  kept: "fixed on time", late: "fixed late", breached: "fix past due",
  at_risk: "fix due within a day", on_time: "fix not yet due"
};
const CLOCK_EDGE: Record<string, string> = {
  kept: "var(--success)", on_time: "var(--ink-soft)", at_risk: "var(--warning)",
  breached: "var(--danger)", late: "var(--danger)"
};

function Clock({ kind, state }: { kind: "response" | "resolution"; state: string | null }) {
  const words = kind === "response" ? RESPONSE_WORDS : RESOLUTION_WORDS;
  if (!state) {
    return (
      <span className="rounded-input border px-8 py-2 text-[10px] font-semibold"
        style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
        title="This desk sets no clock, so nothing was promised about this call.">
        no clock
      </span>
    );
  }
  return (
    <span className="rounded-input px-8 py-2 text-[10px] font-semibold"
      style={{
        border: `1px solid ${CLOCK_EDGE[state] ?? "var(--line)"}`,
        color: CLOCK_EDGE[state] ?? "var(--ink)"
      }}>
      {words[state] ?? state}
    </span>
  );
}

/** One number with a caption under it — the shape every tile on this page takes. */
function Tile({ value, label, sub, color }:
  { value: string | number; label: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-card border px-16 py-12"
      style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <p className="text-xl font-bold tabular-nums" style={{ color: color ?? "var(--ink)" }}>{value}</p>
      <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em]"
        style={{ color: "var(--ink-soft)" }}>{label}</p>
      {sub ? <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>{sub}</p> : null}
    </div>
  );
}

type Desk = {
  id: string; key: string; name: string; purpose: string | null; sort: number; is_active: boolean;
  head_user_id: string | null; head_name: string | null;
  first_response_minutes: number | null; resolve_minutes: number | null;
  business_hours: Week | null; max_open_tickets: number | null; ticket_seq: number;
  reopen_days: number | null;
  escalation_department_id: string | null; escalation_key: string | null;
  escalation_name: string | null; live_tickets: number; live_seats: number;
};
type Kpi = {
  live: number; unworked: number; waiting: number; in_progress: number;
  response_breached: number; response_at_risk: number; resolution_breached: number;
  resolution_due_24h: number; no_clock: number; after_hours: number; escalated_in: number;
  oldest: string | null; settled: number; median_response_minutes: number;
  median_resolution_minutes: number; met_response: number; met_resolution: number;
  answered: number; numbers_issued: number; escalated_out: number;
};
type DeskTicket = {
  id: string; ref: string; dept_ref: string | null; dept_number: number | null;
  ts: string; updated_at: string; reporter_name: string; channel: string; category: string;
  subject: string; priority: string; status: string; language: string; company_name: string | null;
  response_due_at: string | null; resolution_due_at: string | null;
  first_response_at: string | null; resolved_at: string | null; after_hours: boolean;
  escalated_at: string | null; allocated_at: string | null; holder: string | null;
  escalated_from: string | null; has_phone: boolean;
  response_clock: string | null; resolution_clock: string | null;
};
type Rule = {
  id: string; name: string; department_id: string; precedence: number; is_active: boolean;
  note: string | null; channels: string[] | null; categories: string[] | null;
  priorities: string[] | null; languages: string[] | null;
  regions: { id: number; name: string }[]; fired: number; sentence: string;
};
type ChainDesk = { id: string; key: string; name: string; depth?: number; live_tickets?: number };
type Sheet = {
  can_manage: boolean; window_days: number; department: Desk; kpi: Kpi;
  headroom: number | null;
  escalation: { up: ChainDesk[]; down: ChainDesk[] };
  rules: Rule[]; tickets: DeskTicket[]; open_week: boolean;
};

export default function ControlDepartmentSheetPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [days, setDays] = useState(30);
  const [limit, setLimit] = useState(60);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clockFilter, setClockFilter] = useState<"all" | "late" | "at_risk" | "no_clock">("all");

  const load = useCallback(async () => {
    const res = await fetch(
      `${API}/api/v1/control/departments/${id}?days=${days}&limit=${limit}`,
      { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    if (res.status === 404) { setMissing(true); setLoading(false); return; }
    if (!res.ok) { setError("The desk did not answer."); setLoading(false); return; }
    const j: Sheet = await res.json();
    setSheet(j);
    setMissing(false); setForbidden(false); setError(null); setLoading(false);
  }, [id, days, limit]);

  useEffect(() => { load(); }, [load]);

  const desk = sheet?.department;
  const kpi = sheet?.kpi;

  if (loading) {
    return (
      <Shell>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Reading the desk…</p>
      </Shell>
    );
  }
  if (forbidden) {
    return (
      <Shell>
        <h1 className="text-lg font-bold">You are not on the platform chart.</h1>
        <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
          A desk sheet needs the departments duty. Sign in with a seat that holds it.
        </p>
        <Link href="/control/login" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
          Sign in
        </Link>
      </Shell>
    );
  }
  if (missing || !desk || !kpi) {
    return (
      <Shell>
        <h1 className="text-lg font-bold">No desk with that reference.</h1>
        <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
          It was filed away and removed from the chart, or the link was mistyped. The closed
          desks are listed at the bottom of the departments page.
        </p>
        <Link href="/control/departments" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
          Back to the departments desk
        </Link>
      </Shell>
    );
  }

  const openNow = deskOpenNow(desk.business_hours);
  const atCeiling = desk.max_open_tickets !== null && desk.live_tickets >= desk.max_open_tickets;
  const clockBreached = kpi.response_breached + kpi.resolution_breached;
  const settled = kpi.settled;

  // The rows the desk is working, narrowed by the one question a person opens this page to ask.
  const rows = (sheet?.tickets ?? []).filter((t) => {
    if (clockFilter === "all") return true;
    const live = t.status === "open" || t.status === "allocated" || t.status === "in_progress";
    if (clockFilter === "no_clock") return live && !t.response_due_at && !t.resolution_due_at;
    if (clockFilter === "late") {
      return (live && (t.response_clock === "breached" || t.resolution_clock === "breached"))
        || t.resolution_clock === "late";
    }
    return live && (t.response_clock === "at_risk" || t.resolution_clock === "at_risk");
  });

  function exportCsv() {
    const head = ["desk_number", "reference", "logged", "status", "priority", "channel",
      "category", "subject", "company", "reporter", "language", "holder", "answer_due",
      "answer_state", "first_answer", "fix_due", "fix_state", "fixed_at", "after_hours",
      "escalated_from", "escalated_at"];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = rows.map((t) => [
      t.dept_ref, t.ref, t.ts, t.status, t.priority, t.channel, t.category, t.subject,
      t.company_name, t.reporter_name, t.language, t.holder, t.response_due_at,
      t.response_clock, t.first_response_at, t.resolution_due_at, t.resolution_clock,
      t.resolved_at, t.after_hours ? "yes" : "no", t.escalated_from, t.escalated_at
    ].map(cell).join(","));
    const blob = new Blob([[head.map(cell).join(","), ...body].join("\n")],
      { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `waisha-desk-${desk!.key}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`Saved ${rows.length} row${rows.length === 1 ? "" : "s"} of this screen — the calls on `
      + "the desk, as they read now, not as a filter of the whole register.");
  }

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--adm-accent)" }}>
            {sheet!.can_manage ? "Super Admin" : "Read-only"} · Desk sheet — {desk.name}
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1240px] px-16 py-32">
        <Link href="/control/departments"
          className="text-[11px] font-semibold underline" style={{ color: "var(--ink-soft)" }}>
          Back to the departments desk
        </Link>

        <div className="mt-10 flex flex-wrap items-end justify-between gap-16">
          <div>
            <div className="flex flex-wrap items-center gap-12">
              <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>{desk.name}</h1>
              <span className="rounded-input px-8 py-2 text-[10px] font-bold uppercase tracking-[0.12em]"
                style={{ background: "var(--adm-accent-soft)", color: "var(--brand-deep)" }}>
                {desk.key}
              </span>
              <span className="rounded-input px-8 py-2 text-[10px] font-semibold"
                style={{
                  border: `1px solid ${openNow ? "var(--success)" : "var(--warning)"}`,
                  color: openNow ? "var(--success)" : "var(--warning)"
                }}>
                {openNow ? "Open on the desk's clock now" : "Shut on the desk's clock now"}
              </span>
              {!desk.is_active && (
                <span className="rounded-input px-8 py-2 text-[10px] font-semibold"
                  style={{ border: "1px solid var(--danger)", color: "var(--danger)" }}>
                  Stopped from taking work
                </span>
              )}
            </div>
            <p className="mt-8 max-w-[70ch] text-sm" style={{ color: "var(--ink-soft)" }}>
              {desk.purpose ?? "No purpose written on the chart."}
            </p>
            <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              Head: <span className="font-semibold" style={{ color: "var(--ink)" }}>
                {desk.head_name ?? "nobody named"}
              </span> · {desk.live_seats} seat(s) on the chart · desk number {desk.sort}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-12">
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Settled work counted back over
              </span>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}
                className="mt-4 rounded-input border px-10 py-6 text-xs"
                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                {WINDOWS.map((w) => <option key={w} value={w}>Last {w} days</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Rows read
              </span>
              <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}
                className="mt-4 rounded-input border px-10 py-6 text-xs"
                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                {CAPS.map((c) => <option key={c} value={c}>Top {c}</option>)}
              </select>
            </label>
            <button type="button" onClick={exportCsv}
              className="rounded-input border px-14 py-6 text-xs font-semibold"
              style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              Export this screen
            </button>
            <Link href={`/control/tickets?department=${desk.id}`}
              className="waisha-btn rounded-input px-14 py-6 text-xs font-semibold">
              Work them on the tickets desk
            </Link>
          </div>
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

        {/* ---------- what the desk promised ---------- */}
        <section className="mt-28 rounded-card border p-20"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
            What this desk promised
          </h2>
          <dl className="mt-14 grid grid-cols-1 gap-16 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Answer clock
              </dt>
              <dd className="mt-4 text-sm font-semibold" style={{ color: desk.first_response_minutes === null ? "var(--warning)" : "var(--ink)" }}>
                {clockWords(desk.first_response_minutes)}
              </dd>
              <dd className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {desk.first_response_minutes === null
                  ? "The desk sets no deadline for a first answer, so its calls are never late on that count."
                  : "Counted in the hours below, from the minute the call came in."}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Fix clock
              </dt>
              <dd className="mt-4 text-sm font-semibold" style={{ color: desk.resolve_minutes === null ? "var(--warning)" : "var(--ink)" }}>
                {clockWords(desk.resolve_minutes)}
              </dd>
              <dd className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {desk.resolve_minutes === null
                  ? "No deadline to settle a call by."
                  : `${desk.first_response_minutes !== null && desk.resolve_minutes <= desk.first_response_minutes
                    ? "Shorter than the answer clock — a call could be owed finished before it is owed a reply."
                    : "A call is late on this count once it passes it."}`}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Working week
              </dt>
              <dd className="mt-4 text-sm font-semibold" style={{ color: sheet!.open_week ? "var(--ink)" : "var(--danger)" }}>
                {weekWords(desk.business_hours)}
              </dd>
              <dd className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                Wall-clock hours in Dar es Salaam. A call logged outside them is marked after-hours
                and the clock waits for the desk to open.
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Queue ceiling
              </dt>
              <dd className="mt-4 text-sm font-semibold" style={{ color: atCeiling ? "var(--danger)" : "var(--ink)" }}>
                {desk.max_open_tickets === null ? "no ceiling"
                  : `${desk.live_tickets} of ${desk.max_open_tickets}`}
              </dd>
              <dd className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {desk.max_open_tickets === null
                  ? "The desk never says it is full."
                  : atCeiling
                    ? `Full. A new call pointed here is logged but left unnumbered; an escalation still lands.`
                    : `${sheet!.headroom} place(s) before it refuses new work.`}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Reopen window
              </dt>
              <dd className="mt-4 text-sm font-semibold" style={{ color: desk.reopen_days === null ? "var(--warning)" : "var(--ink)" }}>
                {desk.reopen_days === null ? "no window written" : `${desk.reopen_days} calendar day(s)`}
              </dd>
              <dd className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {desk.reopen_days === null
                  ? "A call settled here can be reopened at any time by anybody holding the duty — "
                    + "the desk never said how long it stands behind its own answer."
                  : "Counted in calendar days from the minute the call was settled, not the working "
                    + "hours above. Past them the register refuses the reopen and tells the clerk "
                    + "to log the caller's second contact as its own incidence."}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Desk numbers issued
              </dt>
              <dd className="mt-4 text-sm font-semibold tabular-nums" style={{ color: "var(--ink)" }}>
                {desk.ticket_seq}
              </dd>
              <dd className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {kpi.numbers_issued} of them are still on this desk's books in the register.
                A number never changes hands: {desk.key}-… stays this desk's promise even after
                the call moves.
              </dd>
            </div>
            <div>
              <dt className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Desk above it
              </dt>
              <dd className="mt-4 text-sm font-semibold">
                {desk.escalation_department_id ? (
                  <Link href={`/control/departments/${desk.escalation_department_id}`}
                    className="underline" style={{ color: "var(--adm-accent)" }}>
                    {desk.escalation_name ?? "a desk no longer on the chart"}
                  </Link>
                ) : <span style={{ color: "var(--warning)" }}>nothing</span>}
              </dd>
              <dd className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {desk.escalation_department_id
                  ? "Work this desk cannot answer goes up there, with the number and both deadlines intact."
                  : "Work that cannot be answered here stops here. Set a target on the terms panel."}
              </dd>
            </div>
          </dl>

          {!sheet!.open_week
            && (desk.first_response_minutes !== null || desk.resolve_minutes !== null) && (
            <p className="mt-16 rounded-input px-12 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
              This desk promises an answer but is shut every day of the week, so no call can be
              given a due date. {kpi.no_clock} live call(s) on it have no clock at all. Open the
              desk, or clear the clock.
            </p>
          )}
          {desk.is_active && desk.max_open_tickets !== null && kpi.live > desk.max_open_tickets && (
            <p className="mt-16 rounded-input px-12 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
              {kpi.live} live call(s) are standing here against a ceiling of {desk.max_open_tickets}.
              The ceiling is not a wall: escalations are allowed past it by design, because a call
              that cannot move is a call nobody is answering.
            </p>
          )}
        </section>

        {/* ---------- the numbers ---------- */}
        <section className="mt-28">
          <div className="flex flex-wrap items-end justify-between gap-12">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              The desk's numbers
            </h2>
            <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
              Live counts cover the whole register; settled work and the medians are the last
              {` ${sheet!.window_days} days `}only, so a desk that stopped answering in March
              cannot flatter itself with an old record.
            </p>
          </div>

          <div className="mt-16 grid gap-12"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            <Tile value={kpi.live} label="Live on the desk"
              sub={kpi.oldest ? `oldest since ${age(kpi.oldest)} (${day(kpi.oldest)})` : "nothing standing"} />
            <Tile value={kpi.unworked} label="Nobody has started" color={kpi.unworked ? "var(--danger)" : "var(--ink)"}
              sub="Status open — the desk knows the call exists, no hand is on it." />
            <Tile value={kpi.waiting} label="Named, not started" color={kpi.waiting ? "var(--warning)" : "var(--ink)"}
              sub="Allocated to somebody who has not begun." />
            <Tile value={kpi.in_progress} label="Being worked" sub="In progress on the register." />
            <Tile value={clockBreached} label="Past a deadline"
              color={clockBreached ? "var(--danger)" : "var(--ink)"}
              sub={`${kpi.response_breached} unanswered, ${kpi.resolution_breached} unfixed.`} />
            <Tile value={kpi.response_at_risk + kpi.resolution_due_24h} label="Due next"
              color={kpi.response_at_risk ? "var(--warning)" : "var(--ink)"}
              sub={`${kpi.response_at_risk} owe an answer within the hour, ${kpi.resolution_due_24h} a fix within a day.`} />
            <Tile value={kpi.no_clock} label="No clock at all"
              color={kpi.no_clock ? "var(--warning)" : "var(--ink)"}
              sub="Live calls whose desk sets no deadline. Nothing here can be called late." />
            <Tile value={kpi.after_hours} label="Logged out of hours"
              sub="The phone rang while the desk was shut. The clock waited for it to open." />
            <Tile value={kpi.escalated_in} label="Escalated here"
              sub="Live calls pushed up onto this desk by a desk below it." />
            <Tile value={kpi.escalated_out} label="Sent up from here"
              color={kpi.escalated_out ? "var(--gold)" : "var(--ink)"}
              sub="Live calls this desk could not answer and moved on." />
            <Tile value={kpi.settled} label={`Settled in ${sheet!.window_days} days`}
              sub="Resolved or closed, with a finish stamp inside the window." />
            <Tile value={mins(kpi.median_response_minutes) === "0 min" ? "under a min" : mins(kpi.median_response_minutes)}
              label="Median first answer"
              sub={`${kpi.answered} of the settled calls were ever answered.`} />
          </div>

          <div className="mt-16 grid gap-12"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
            <div className="rounded-card border px-16 py-12"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Answered inside the promise
              </p>
              <p className="mt-6 text-xl font-bold tabular-nums"
                style={{ color: kpi.answered === 0 ? "var(--ink-soft)" : "var(--ink)" }}>
                {kpi.met_response} of {kpi.answered}
                <span className="ml-8 text-sm font-normal" style={{ color: "var(--ink-soft)" }}>
                  {kpi.answered ? `(${pct(kpi.met_response, kpi.answered)})` : ""}
                </span>
              </p>
              <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {kpi.answered === 0
                  ? `No settled call in the window had both an answer and a clock, so there is no rate to quote — not a 0%.`
                  : `Only calls that were answered and had a deadline counted. ${kpi.answered - kpi.met_response} answered late.`}
              </p>
            </div>
            <div className="rounded-card border px-16 py-12"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Settled inside the promise
              </p>
              <p className="mt-6 text-xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                {kpi.met_resolution} of {kpi.settled}
                <span className="ml-8 text-sm font-normal" style={{ color: "var(--ink-soft)" }}>
                  {kpi.settled ? `(${pct(kpi.met_resolution, kpi.settled)})` : ""}
                </span>
              </p>
              <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {kpi.settled === 0
                  ? `Nothing finished in the last ${sheet!.window_days} days.`
                  : `A call settled without a fix clock was never late, and is not counted against the desk.`}
              </p>
            </div>
            <div className="rounded-card border px-16 py-12"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                Median time to finish
              </p>
              <p className="mt-6 text-xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                {mins(kpi.median_resolution_minutes)}
              </p>
              <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                From the minute the call came in to the minute it was settled, across the{" "}
                {kpi.settled} finished call(s) in the window. Half the desk is slower than this.
              </p>
            </div>
          </div>
        </section>

        {/* ---------- the chain ---------- */}
        <section className="mt-28 grid grid-cols-1 gap-16 lg:grid-cols-2">
          <div className="rounded-card border p-20" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              Up the chain
            </h2>
            {sheet!.escalation.up.length === 0 ? (
              <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>
                Nothing above this desk — {desk.escalation_department_id
                  ? "the chain stops at it, because it is top of the chart."
                  : "no target is set on its terms."}
              </p>
            ) : (
              <ol className="mt-10 space-y-6">
                {sheet!.escalation.up.map((u) => (
                  <li key={u.id} className="flex items-center justify-between gap-12">
                    <Link href={`/control/departments/${u.id}`}
                      className="text-sm font-semibold underline" style={{ color: "var(--adm-accent)" }}>
                      {u.depth}. {u.name}
                    </Link>
                    <span className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                      {u.key}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              The chart keeps one desk deep at a time; this is the walk an escalation would
              take if this desk passed it up and the next one did the same.
            </p>
          </div>

          <div className="rounded-card border p-20" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              Desks that push up here
            </h2>
            {sheet!.escalation.down.length === 0 ? (
              <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>
                No desk names this one as its answer to "we cannot handle this".
              </p>
            ) : (
              <ul className="mt-10 space-y-6">
                {sheet!.escalation.down.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-12">
                    <Link href={`/control/departments/${d.id}`}
                      className="text-sm font-semibold underline" style={{ color: "var(--adm-accent)" }}>
                      {d.name}
                    </Link>
                    <span className="text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                      {d.live_tickets} live
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              Every one of these desks sends its unanswerable work here. {kpi.escalated_in} live
              call(s) on this desk got here that way.
            </p>
          </div>
        </section>

        {/* ---------- the rules that name this desk ---------- */}
        <section className="mt-28 rounded-card border p-20"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          <div className="flex flex-wrap items-end justify-between gap-12">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              Routing rules that land calls here
            </h2>
            <Link href="/control/departments#rules"
              className="text-[11px] font-semibold underline" style={{ color: "var(--adm-accent)" }}>
              Write or rewrite one on the departments desk
            </Link>
          </div>
          {sheet!.rules.length === 0 ? (
            <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>
              No rule names this desk, so nothing arrives here by itself. A call only lands on it
              when a clerk points it here, or when somebody escalates it up.
            </p>
          ) : (
            <>
              <ul className="mt-12 space-y-10">
                {sheet!.rules.map((r) => (
                  <li key={r.id} className="rounded-input border px-14 py-10"
                    style={{ borderColor: "var(--adm-line)", opacity: r.is_active ? 1 : 0.55 }}>
                    <div className="flex flex-wrap items-center gap-10">
                      <span className="rounded-input px-8 py-2 text-[10px] font-bold tabular-nums"
                        style={{ background: "var(--adm-accent-soft)", color: "var(--brand-deep)" }}>
                        {r.precedence}
                      </span>
                      <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{r.name}</p>
                      {!r.is_active && (
                        <span className="rounded-input px-8 py-2 text-[10px] font-semibold"
                          style={{ border: "1px solid var(--warning)", color: "var(--warning)" }}>
                          switched off
                        </span>
                      )}
                      <span className="ml-auto text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                        {r.fired} call(s) routed by it
                      </span>
                    </div>
                    <p className="mt-6 text-[12px]" style={{ color: "var(--ink)" }}>{r.sentence}</p>
                    {r.note && (
                      <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        Note: {r.note}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                The matcher reads the chart in precedence order and stops at the first rule that
                fits, so a rule further down only ever sees what the ones above it let through.
                A call that fits no rule stays unassigned until a clerk points it somewhere.
              </p>
            </>
          )}
        </section>

        {/* ---------- the queue ---------- */}
        <section className="mt-28">
          <div className="flex flex-wrap items-end justify-between gap-12">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                The queue on this desk
              </h2>
              <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                Live calls first, then urgent, then by the nearest deadline. Up to {limit} rows
                read; {rows.length} shown after the filter.
              </p>
            </div>
            <div className="flex flex-wrap gap-8">
              {([["all", "Everything"], ["late", "Past a deadline"],
                ["at_risk", "Due next"], ["no_clock", "No clock"]] as const).map(([k, label]) => (
                <button key={k} type="button" onClick={() => setClockFilter(k)}
                  aria-pressed={clockFilter === k}
                  className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                  style={{
                    borderColor: clockFilter === k ? "var(--adm-accent)" : "var(--line)",
                    background: clockFilter === k ? "var(--adm-accent-soft)" : "transparent",
                    color: clockFilter === k ? "var(--brand-deep)" : "var(--ink-soft)"
                  }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="mt-14 rounded-card border px-16 py-20 text-sm"
              style={{ borderColor: "var(--line)", background: "var(--surface)", color: "var(--ink-soft)" }}>
              {sheet!.tickets.length === 0
                ? `Nothing is standing on this desk and nothing has passed through it in the window. The desk is quiet.`
                : `No call on this desk matches "${clockFilter === "late" ? "a broken deadline"
                  : clockFilter === "at_risk" ? "a deadline close enough to act on"
                    : "no clock at all"}". ${sheet!.tickets.length} row(s) are on the desk.`}
            </p>
          ) : (
            <div className="mt-14 overflow-x-auto rounded-card border" style={{ borderColor: "var(--line)" }}>
              <table className="w-full min-w-[980px] text-left text-[12px]">
                <thead>
                  <tr style={{ background: "var(--milk-deep)" }}>
                    {["Desk number", "Subject", "Status", "Clocks", "Who", "Logged", ""].map((h) => (
                      <th key={h} className="whitespace-nowrap px-12 py-8 text-[10px] font-bold uppercase tracking-[0.12em]"
                        style={{ color: "var(--ink-soft)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.id} className="border-t align-top" style={{ borderColor: "var(--line)" }}>
                        <td className="px-12 py-10">
                          {t.dept_ref ? (
                            <p className="font-mono text-[11px] font-bold" style={{ color: "var(--ink)" }}>{t.dept_ref}</p>
                          ) : (
                            <p className="text-[11px] font-semibold" style={{ color: "var(--warning)" }}>unnumbered</p>
                          )}
                          <p className="mt-4 font-mono text-[10px]" style={{ color: "var(--ink-soft)" }}>{t.ref}</p>
                        </td>
                        <td className="px-12 py-10">
                          <p className="font-semibold" style={{ color: "var(--ink)" }}>{t.subject}</p>
                          <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {CHANNEL_WORDS[t.channel] ?? t.channel} · {CATEGORY_WORDS[t.category] ?? t.category}
                            {" "}{t.language === "sw" ? "· KiSwahili" : "· English"}
                            {t.company_name ? ` · ${t.company_name}` : ""}
                          </p>
                          <p className="mt-6 flex flex-wrap gap-6">
                            {t.after_hours && (
                              <span className="rounded-input px-8 py-2 text-[10px] font-semibold"
                                style={{ border: "1px solid var(--adm-accent)", color: "var(--adm-accent)" }}
                                title="The call came in while this desk was shut, so its clock waited for the desk to open.">
                                out of hours
                              </span>
                            )}
                            {t.escalated_at && (
                              <span className="rounded-input px-8 py-2 text-[10px] font-semibold"
                                style={{ border: "1px solid var(--gold)", color: "var(--gold)" }}
                                title={`Pushed up onto this desk${t.escalated_from ? ` from ${t.escalated_from}` : ""}.`}>
                                escalated here{t.escalated_from ? ` from ${t.escalated_from}` : ""}
                              </span>
                            )}
                            {t.priority === "urgent" && (
                              <span className="rounded-input px-8 py-2 text-[10px] font-bold uppercase"
                                style={{ background: "var(--danger)", color: "#fff" }}>urgent</span>
                            )}
                            {t.priority === "high" && (
                              <span className="rounded-input px-8 py-2 text-[10px] font-semibold"
                                style={{ border: "1px solid var(--danger)", color: "var(--danger)" }}>high</span>
                            )}
                          </p>
                        </td>
                        <td className="px-12 py-10">
                          <span className="rounded-input px-8 py-2 text-[10px] font-semibold"
                            style={{ border: `1px solid ${STATUS_EDGE[t.status] ?? "var(--line)"}`, color: STATUS_EDGE[t.status] ?? "var(--ink)" }}>
                            {STATUS_WORDS[t.status] ?? t.status}
                          </span>
                        </td>
                        <td className="px-12 py-10">
                          <p className="flex flex-wrap gap-6">
                            <Clock kind="response" state={t.response_clock} />
                            <Clock kind="resolution" state={t.resolution_clock} />
                          </p>
                          <p className="mt-6 text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                            answer {t.response_due_at ? when(t.response_due_at) : "—"}
                            <br />
                            fix {t.resolution_due_at ? when(t.resolution_due_at) : "—"}
                          </p>
                        </td>
                        <td className="px-12 py-10">
                          <p className="font-semibold" style={{ color: "var(--ink)" }}>{t.reporter_name}</p>
                          <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {t.holder ? `held by ${t.holder}` : "no hand on it"}
                            {t.has_phone ? " · number on file" : ""}
                          </p>
                        </td>
                        <td className="px-12 py-10 whitespace-nowrap tabular-nums" style={{ color: "var(--ink-soft)" }}>
                          <p>{when(t.ts)}</p>
                          <p className="mt-4 text-[10px]">{age(t.ts)} standing</p>
                          {t.status === "open" || t.status === "allocated" || t.status === "in_progress" ? null : (
                            <p className="mt-4 text-[10px]">{t.resolved_at ? `settled ${day(t.resolved_at)}` : "—"}</p>
                          )}
                        </td>
                        <td className="px-12 py-10">
                          <Link href={`/control/tickets?open=${t.id}`}
                            className="text-[11px] font-semibold underline" style={{ color: "var(--adm-accent)" }}>
                            Open
                          </Link>
                        </td>
                      </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            A caller was quoted the desk number when the call was logged. It does not change when
            the work moves, so a number issued from {desk.key} stays this desk's promise for as
            long as the register lives — even if the call now sits on a desk above it.
          </p>
        </section>
      </main>
    </div>
  );
}

/** The three states a sheet can come back in that are not the sheet. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
        <ControlNav />
      </header>
      <main className="mx-auto max-w-[900px] px-16 py-32">
        <div className="rounded-card border p-24"
          style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
          {children}
        </div>
      </main>
    </div>
  );
}
