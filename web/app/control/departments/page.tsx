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

/** One day of the desk's week as 123 keeps it: two wall-clock minutes in Dar es Salaam, or
 *  null when the desk is shut that day. A closed day is written rather than left out, so the
 *  page can say "shut Sunday" instead of letting a reader infer it from a gap. */
type DayHours = { open: string; close: string } | null;
type Week = Record<DayKey, DayHours>;
type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
const DAY_KEYS: [DayKey, string][] = [
  ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"],
  ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"]
];
const SHUT_WEEK: Week = { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
const OFFICE_WEEK: Week = {
  mon: { open: "08:00", close: "17:00" }, tue: { open: "08:00", close: "17:00" },
  wed: { open: "08:00", close: "17:00" }, thu: { open: "08:00", close: "17:00" },
  fri: { open: "08:00", close: "17:00" }, sat: null, sun: null
};
/** The week in the words a clerk would say down the phone: "Mon–Fri 08:00–17:00", not seven
 *  rows of JSON. A desk that keeps odd hours gets the days named one by one instead. */
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

/** Whether the week has an open minute anywhere in it: the difference between a clock that runs
 *  slowly and a promise that can never be kept. */
function openSomewhere(w: Week | null): boolean {
  return !!w && DAY_KEYS.some(([k]) => !!w[k]);
}

const asMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
/** Whether the desk is standing at this instant, read on the desk's own wall clock. The
 *  register counts minutes in Dar es Salaam and Tanzania keeps +02:00 all year, so a laptop on
 *  a ship's clock still sees the right answer. The close minute is exclusive, as `inside_hours`
 *  makes it. */
function deskOpenNow(w: Week | null, at: Date = new Date()): boolean {
  if (!openSomewhere(w)) return false;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Dar_es_Salaam", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const openDay = (w as Week)[get("weekday").slice(0, 3).toLowerCase() as DayKey];
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

/** The ceiling as the register applies it — a desk with no ceiling never says it is full. Named
 *  once because the card and the routing board must answer it the same way. */
const full = (d: { live_tickets: number; max_open_tickets: number | null }) =>
  d.max_open_tickets !== null && d.live_tickets >= d.max_open_tickets;

type Department = {
  id: string; key: string; name: string; purpose: string | null; sort: number; is_active: boolean;
  head_user_id: string | null; head_name: string | null; seat_count: number; live_covers: number;
  first_response_minutes: number | null; resolve_minutes: number | null;
  business_hours: Week | null; max_open_tickets: number | null; ticket_seq: number;
  escalation_department_id: string | null; escalation_key: string | null;
  escalation_name: string | null;
  live_tickets: number; breached_tickets: number; oldest_open: string | null;
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

/** The chart's own words for a rule (control-departments.routes.ts). A predicate the API does
 *  not accept is a rule that sits on the desk matching nothing, so this is a mirror. */
const RULE_CHANNELS: [string, string][] = [
  ["phone_call", "Phone call"], ["whatsapp", "WhatsApp"], ["email", "Email"],
  ["walk_in", "Walked in"], ["portal_message", "Portal message"], ["other", "Other"]
];
const RULE_CATEGORIES: [string, string][] = [
  ["onboarding", "Onboarding"], ["account_access", "Account access"],
  ["licence_billing", "Licence and billing"], ["cargo_clearing", "Cargo and clearing"],
  ["transport_fleet", "Transport and fleet"], ["marketplace_directory", "Marketplace"],
  ["system_error", "System error"], ["complaint", "Complaint"], ["other", "Other"]
];
const RULE_PRIORITIES: [string, string][] = [
  ["low", "Low"], ["normal", "Normal"], ["high", "High"], ["urgent", "Urgent"]
];
const RULE_LANGUAGES: [string, string][] = [["en", "English"], ["sw", "Swahili"]];
type Rule = {
  id: string; name: string; department_id: string; department_name: string;
  channels: string[] | null; categories: string[] | null; priorities: string[] | null;
  languages: string[] | null; region_ids: number[] | null;
  regions: { id: number; name: string }[];
  precedence: number; is_active: boolean; note: string | null; sentence: string; fired: number;
};
type RulesBoard = {
  can_manage: boolean; rules: Rule[];
  precedence_clashes: { precedence: number; names: string[] }[];
  desks: { id: string; key: string; name: string; max_open_tickets: number | null;
    live_tickets: number; breached_tickets: number }[];
  regions: { id: number; code: string | null; name: string }[];
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

/** A promise in the unit a clerk quotes: minutes under the hour, hours under the day. */
function clockWords(n: number | null): string {
  if (n === null) return "no clock";
  if (n < 60) return `${n} min`;
  if (n < 1440) return `${Math.round(n / 6) / 10} h`;
  const days = n / 1440;
  return `${Number.isInteger(days) ? days : Math.round(days * 10) / 10} day${days === 1 ? "" : "s"}`;
}

type RegFilter = { action: string; user: string; q: string; days: string; limit: string };
type PanelKind = "open" | "edit" | "terms" | "place" | "head" | "stepdown" | "move" | "leave"
  | "close" | "reopen" | "rule" | "retire" | "ruledry";
type Panel = { kind: PanelKind; deptId?: string; userId?: string; userName?: string | null;
  /** Which rule a "rule" panel is rewriting. Kept out of deptId so a rule edit can never be
   *  mistaken for a desk edit by the identity guard below. */
  ruleId?: string };
type Draft = {
  key: string; name: string; purpose: string; sort: string; reason: string; endsOn: string;
  picked: string[]; headUserId: string; moveTo: string;
  /** The desk's five terms, edited together because they are read together: a clock without
   *  the week it is counted against is the panel that gets argued with. */
  answer: string; fix: string; ceiling: string; escalateTo: string; week: Week;
  /** Closing a desk that still holds calls has to name where they go. */
  moveTicketsTo: string;
  /** A routing rule, all five predicates and the desk it points at. */
  ruleName: string; ruleDesk: string; rulePrecedence: string; ruleNote: string; ruleOn: boolean;
  ruleChannels: string[]; ruleCategories: string[]; rulePriorities: string[];
  ruleLanguages: string[]; ruleRegions: number[];
  /** The dry run: a call shape, not a call. Nothing is written by it. */
  dryChannel: string; dryCategory: string; dryPriority: string; dryLanguage: string;
  dryRegion: string;
};
const EMPTY: Draft = { key: "", name: "", purpose: "", sort: "100", reason: "", endsOn: "",
  picked: [], headUserId: "", moveTo: "", answer: "", fix: "", ceiling: "", escalateTo: "",
  week: { ...OFFICE_WEEK }, moveTicketsTo: "",
  ruleName: "", ruleDesk: "", rulePrecedence: "100", ruleNote: "", ruleOn: true,
  ruleChannels: [], ruleCategories: [], rulePriorities: [], ruleLanguages: [], ruleRegions: [],
  dryChannel: "phone_call", dryCategory: "cargo_clearing", dryPriority: "normal",
  dryLanguage: "en", dryRegion: "" };

/** One predicate group of a routing rule. Ticked chips rather than a multi-select because the
 *  difference between "any channel" and "these two channels" is the whole rule, and a list you
 *  have to Cmd-click to read hides it. */
function Chips(props: { title: string; options: [string, string][]; picked: string[];
  toggle: (key: string, on: boolean) => void }) {
  return (
    <div className="rounded-input border p-10" style={{ borderColor: "var(--line)" }}>
      <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
        {props.title}
      </p>
      <div className="mt-8 flex flex-wrap gap-6">
        {props.options.map(([key, what]) => {
          const on = props.picked.includes(key);
          return (
            <button key={key} type="button" aria-pressed={on}
              onClick={() => props.toggle(key, !on)}
              className="rounded-input px-8 py-4 text-[11px] font-semibold"
              style={{
                border: `1px solid ${on ? "var(--adm-accent)" : "var(--line)"}`,
                background: on ? "var(--adm-accent-soft)" : "transparent",
                color: on ? "var(--ink)" : "var(--ink-soft)"
              }}>
              {what}
            </button>
          );
        })}
      </div>
      <p className="mt-6 text-[10px]" style={{ color: props.picked.length ? "var(--success)" : "var(--ink-soft)" }}>
        {props.picked.length ? `${props.picked.length} chosen` : "nothing chosen — this predicate asks nothing"}
      </p>
    </div>
  );
}

/**
 * The platform's own org chart (084; task #130c) — which desk every staff seat sits in,
 * who answers for it, and the register of every move with the reason behind it.
 *
 * Since 123 a desk also keeps promises: the week it is open, how fast it answers, how fast it
 * fixes, how many calls it will hold, and the desk above it when it cannot answer. Those five
 * terms are edited as one panel because they are read as one clock, and the panel shows the
 * register's own sentence for what they produce — a desk that promises an answer but is shut
 * every day gets no due date, and this page says so rather than printing an empty column.
 *
 * The routing rules live on the same desk because they point at it. A rule is five predicates
 * and a precedence; two rules at one precedence are legal and 123 breaks the tie by name, so
 * the clash is warned about rather than refused — and the dry run answers "where would a call
 * like this go?" without logging anything.
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

  const [board, setBoard] = useState<RulesBoard | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  /** The dry run's answer, kept beside the form that asked it so the desk can read which call
   *  shape produced which sentence. */
  const [dry, setDry] = useState<any | null>(null);

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

  /** The rules board is a second read of the same chart: which call shapes go where, how many
   *  times each rule has actually fired, and the desks it can point at with their headroom. */
  const loadRules = useCallback(async () => {
    const res = await fetch(`${API}/api/v1/control/departments/routes`, { credentials: "include" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setRulesError(j?.error?.message ?? "The routing rules did not answer.");
      return;
    }
    setBoard(await res.json());
    setRulesError(null);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const f = { action: "", user: "", q: "", days: "30", limit: "60" };
      load(f.days);
      loadRegister(f);
      loadRules();
    })();
  }, [load, loadRegister, loadRules]);

  /** Every write re-reads all three halves of the desk: the chart it changed, the rules that
   *  point at it and the line it added to the register. */
  const refresh = useCallback((f: RegFilter) => {
    load(f.days); loadRegister(f); loadRules();
  }, [load, loadRegister, loadRules]);

  /** Every write goes through here: the message the API returns is the sentence the desk shows. */
  async function write(method: "POST" | "PATCH" | "PUT", path: string, body: unknown): Promise<any | null> {
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
    setPanel(panel?.kind === next.kind && panel?.deptId === next.deptId
      && panel?.userId === next.userId && panel?.ruleId === next.ruleId ? null : next);
  }

  /** Terms are seeded from the desk, not from the last panel: an empty box means "no clock",
   *  so a panel that inherited another desk's number would write a promise nobody typed. */
  const openTerms = (d: Department) => openPanel({ kind: "terms", deptId: d.id }, {
    answer: d.first_response_minutes === null ? "" : String(d.first_response_minutes),
    fix: d.resolve_minutes === null ? "" : String(d.resolve_minutes),
    ceiling: d.max_open_tickets === null ? "" : String(d.max_open_tickets),
    escalateTo: d.escalation_department_id ?? "",
    week: { ...(d.business_hours ?? SHUT_WEEK) }
  });

  /** A day is open only when both of its minutes are written, but a half-written day keeps its
   *  text while the clerk types the other box — a form that wipes what was just typed is a form
   *  that gets filled in wrong. The half state is caught on save, in words. */
  const setDayHours = (k: DayKey, which: "open" | "close", value: string) => {
    const cur = draft.week[k] ?? { open: "", close: "" };
    const next = { ...cur, [which]: value };
    setDraft({ ...draft, week: { ...draft.week, [k]: next.open || next.close ? next : null } });
  };

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
      reason: draft.reason.trim(), moveTo: draft.moveTo || null,
      moveTicketsTo: draft.moveTicketsTo || null
    });
    if (!j) return;
    setNotice(`${deptById(panel!.deptId)?.name ?? "The desk"} is shut: ${j.seats_released} seat(s) `
      + `released, ${j.seats_moved} moved on`
      + (j.tickets_moved ? `, ${j.tickets_moved} incidence(s) carried to another desk with their `
        + "numbers intact" : "") + ".");
    closePanel(panel); refresh(regFilter);
  }

  async function submitReopen(id: string, name: string) {
    const j = await write("POST", `/${id}/reopen`, { reason: draft.reason.trim() });
    if (!j) return;
    setNotice(`${name} is open again — its seats were not resurrected, so place them afresh.`);
    closePanel(panel); refresh(regFilter);
  }

  // ---------- the desk's terms ----------
  /** A number box that is empty is an answer, not a gap: it means "this desk promises no
   *  clock". So the boxes are read as sent-or-null and the hint under them says so. */
  function submitTerms() {
    const mine = panel;
    const num = (v: string) => (v.trim() ? Number(v.trim()) : null);
    const answer = num(draft.answer), fix = num(draft.fix), ceiling = num(draft.ceiling);
    const bad: string[] = [];
    if (answer !== null && (!Number.isInteger(answer) || answer < 5 || answer > 4320))
      bad.push("A first answer is between 5 and 4320 minutes, or empty for no clock.");
    if (fix !== null && (!Number.isInteger(fix) || fix < 15 || fix > 20160))
      bad.push("A resolution is between 15 and 20160 minutes, or empty for no clock.");
    if (ceiling !== null && (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 500))
      bad.push("The number of calls a desk will hold is between 1 and 500, or empty for no ceiling.");
    if (answer !== null && fix !== null && answer > fix)
      bad.push(`An answer in ${answer} minutes cannot sit outside a fix in ${fix}.`);
    const week: Week = { ...draft.week };
    for (const [k, name] of DAY_KEYS) {
      const hrs = week[k];
      if (!hrs) continue;
      if (!hrs.open || !hrs.close)
        bad.push(`${name} has ${hrs.open ? `an opening minute (${hrs.open}) but no closing minute`
          : hrs.close ? `a closing minute (${hrs.close}) but no opening minute` : "neither minute"}: `
          + "fill both to keep the desk open, or clear both to shut it.");
      else if (!/^\d{2}:\d{2}$/.test(hrs.open) || !/^\d{2}:\d{2}$/.test(hrs.close) || hrs.open >= hrs.close)
        bad.push(`${name} is written as ${hrs.open}–${hrs.close}: use a 24-hour time like 08:00 and `
          + "open before close, or clear both boxes to shut the day.");
    }
    if (!reasonReady) bad.push("Say why the terms are changing — the register keeps the sentence.");
    if (bad.length) { setPanelError(bad.join(" ")); return; }

    // A day is open only when both minutes are filled; anything else is written as an explicit
    // null, so the chart can say "shut Sunday" instead of letting a reader infer it from a gap.
    const shipped: Week = { ...SHUT_WEEK };
    for (const [k] of DAY_KEYS) {
      const hrs = week[k];
      if (hrs?.open && hrs?.close) shipped[k] = { open: hrs.open, close: hrs.close };
    }

    (async () => {
      const j = await write("PUT", `/${mine!.deptId}/terms`, {
        firstResponseMinutes: answer, resolveMinutes: fix, maxOpenTickets: ceiling,
        escalationDepartmentId: draft.escalateTo || null,
        businessHours: shipped,
        reason: draft.reason.trim()
      });
      if (!j) return;
      const words = [
        j.first_response_minutes === null ? "no first answer is promised"
          : `a first answer in ${j.first_response_minutes} working minutes`,
        j.resolve_minutes === null ? "no fix is promised"
          : `a fix in ${j.resolve_minutes} working minutes`,
        `open ${weekWords(j.business_hours)} (Dar es Salaam)`,
        j.max_open_tickets === null ? "no ceiling on how many it holds"
          : `${j.max_open_tickets} live call(s) before it is full`,
        j.escalation_department_id
          ? `work it cannot answer goes up to ${deptById(j.escalation_department_id)?.name ?? "the desk above"}`
          : "nothing escalates above it"
      ].join(" · ");
      setNotice(`${j.name}: ${words}.${j.clock_note ? ` ${j.clock_note}` : ""}`);
      closePanel(mine); refresh(regFilter);
    })();
  }

  // ---------- the routing rules ----------
  const openRule = (r?: Rule) => openPanel(
    { kind: "rule", ruleId: r?.id },
    r ? {
      ruleName: r.name, ruleDesk: r.department_id, rulePrecedence: String(r.precedence),
      ruleNote: r.note ?? "", ruleOn: r.is_active,
      ruleChannels: r.channels ?? [], ruleCategories: r.categories ?? [],
      rulePriorities: r.priorities ?? [], ruleLanguages: r.languages ?? [],
      ruleRegions: r.region_ids ?? []
    } : { ruleChannels: [], ruleCategories: [], rulePriorities: [], ruleLanguages: [], ruleRegions: [] }
  );

  async function submitRule() {
    const mine = panel;
    const lists = [draft.ruleChannels, draft.ruleCategories, draft.rulePriorities,
      draft.ruleLanguages, draft.ruleRegions];
    const bad: string[] = [];
    if (draft.ruleName.trim().length < 3) bad.push("A rule needs a name a clerk can say down the phone — three letters at least.");
    if (!draft.ruleDesk) bad.push("Choose the desk a matching call lands on.");
    if (!lists.some((l) => l.length))
      bad.push("A rule that narrows on nothing would take the whole queue. Pick a channel, a "
        + "subject, an urgency, a language or a region.");
    const precedence = Number(draft.rulePrecedence || 100);
    if (!Number.isInteger(precedence) || precedence < 1 || precedence > 999)
      bad.push("Precedence is a whole number from 1 to 999; lower wins.");
    if (!reasonReady) bad.push("Say why this rule exists.");
    if (bad.length) { setPanelError(bad.join(" ")); return; }

    const body = {
      name: draft.ruleName.trim(), departmentId: draft.ruleDesk,
      channels: draft.ruleChannels, categories: draft.ruleCategories,
      priorities: draft.rulePriorities, languages: draft.ruleLanguages,
      regionIds: draft.ruleRegions, precedence, isActive: draft.ruleOn,
      note: draft.ruleNote.trim() || null, reason: draft.reason.trim()
    };
    const j = mine?.ruleId
      ? await write("PATCH", `/routes/${mine.ruleId}`, body)
      : await write("POST", "/routes", body);
    if (!j) return;
    const headroom = j.headroom === null || j.headroom === undefined
      ? "" : ` That desk has room for ${j.headroom} more live call(s).`;
    setNotice(`${j.sentence}${headroom}${j.clock_note ? ` ${j.clock_note}` : ""}`);
    closePanel(mine); refresh(regFilter);
  }

  async function submitRetire(r: Rule) {
    const mine = panel;
    const j = await write("POST", `/routes/${r.id}/retire`, { reason: draft.reason.trim() });
    if (!j) return;
    setNotice(`"${j.name}" is retired — it fired ${j.fired_so_far} time(s) and the register keeps `
      + "it exactly as it stood. It takes no calls from now on.");
    closePanel(mine); refresh(regFilter);
  }

  /** Where a call like this would go. The API matches the rules it already holds and writes
   *  nothing, which is what makes it safe to offer to a read-only seat. */
  async function runDry() {
    const j = await write("POST", "/routes/match", {
      channel: draft.dryChannel, category: draft.dryCategory, priority: draft.dryPriority,
      language: draft.dryLanguage,
      regionId: draft.dryRegion ? Number(draft.dryRegion) : null
    });
    if (!j) { setDry(null); return; }
    setDry(j);
  }

  const twoTap = (key: string, run: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    setArmed(null); run();
  };

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

  const promisedClock = departments.filter((d) => d.first_response_minutes !== null
    || d.resolve_minutes !== null).length;
  const standing = departments.reduce((n, d) => n + d.live_tickets, 0);
  const pastDue = departments.reduce((n, d) => n + d.breached_tickets, 0);

  const stats: [string | number, string][] = summary ? [
    [summary.departments, "Open desks"],
    [`${summary.placed_seats} of ${summary.seats}`, "Seats placed"],
    [summary.live_covers, "Covers running"],
    [summary.covers_ending_7d, "Covers ending in 7 days"],
    [unassigned.length, "Seats without a desk"],
    [`${promisedClock} of ${summary.departments}`, "Desks that promise a clock"],
    [standing, "Calls standing on a desk"],
    [pastDue, "Past the minute they were owed"],
    [`${summary.register_rows} in ${regFilter.days} days`, "Moves on record"]
  ] : [];

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
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
          <div className="mt-14 grid gap-16" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 430px), 1fr))" }}>
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

                  {/* 123's promises, read next to each other because the register reads them
                      together: a clock is only meaningful against the week it is counted in,
                      and a ceiling is only meaningful against how many are standing now. */}
                  <dl className="mt-10 grid gap-6 text-[11px]"
                    style={{ gridTemplateColumns: "auto 1fr", color: "var(--ink-soft)" }}>
                    <dt className="font-semibold uppercase tracking-[0.1em]">Clock</dt>
                    <dd style={{ color: "var(--ink)" }}>
                      {d.first_response_minutes === null && d.resolve_minutes === null
                        ? <span style={{ color: "var(--warning)" }}>
                            no answer time promised — calls here get no due date
                          </span>
                        : `first answer ${clockWords(d.first_response_minutes)}, `
                          + `fixed ${clockWords(d.resolve_minutes)}`}
                    </dd>
                    <dt className="font-semibold uppercase tracking-[0.1em]">Open</dt>
                    <dd style={{ color: deskOpenNow(d.business_hours) ? "var(--success)" : "var(--ink-soft)" }}>
                      {weekWords(d.business_hours)}
                      <span className="ml-6">{deskOpenNow(d.business_hours) ? "— open now" : "— shut right now"}</span>
                      {d.first_response_minutes !== null && !openSomewhere(d.business_hours) && (
                        <span className="ml-6" style={{ color: "var(--danger)" }}>
                          so no call can be answered on time
                        </span>
                      )}
                    </dd>
                    <dt className="font-semibold uppercase tracking-[0.1em]">Queue</dt>
                    <dd>
                      <span style={{ color: full(d) ? "var(--danger)" : "var(--ink)" }}>
                        {d.live_tickets} live call(s)
                        {d.max_open_tickets !== null ? ` of ${d.max_open_tickets} accepted` : ""}
                      </span>
                      {d.breached_tickets > 0 && (
                        <span className="ml-6 font-semibold" style={{ color: "var(--danger)" }}>
                          {d.breached_tickets} past due
                        </span>
                      )}
                      {d.oldest_open && (
                        <span className="ml-6">oldest {age(d.oldest_open)}</span>
                      )}
                    </dd>
                    <dt className="font-semibold uppercase tracking-[0.1em]">Above it</dt>
                    <dd style={{ color: "var(--ink)" }}>
                      {d.escalation_name ?? <span style={{ color: "var(--ink-soft)" }}>
                        nothing — work that cannot be answered stops here
                      </span>}
                    </dd>
                  </dl>

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
                              placeholder="Name" className="w-full rounded-input border px-10 py-6 text-sm"
                              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                            <input type="number" defaultValue={d.sort} onChange={(e) => setDraft({ ...draft, sort: e.target.value })}
                              placeholder="Sort" className="w-full rounded-input border px-10 py-6 text-sm"
                              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                          </div>
                          <textarea defaultValue={d.purpose ?? ""} rows={2}
                            onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} placeholder="Purpose"
                            className="mt-10 w-full rounded-input border px-10 py-6 text-sm"
                            style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                          <div className="mt-10 flex flex-wrap gap-10">
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

                      {panel.kind === "terms" && (
                        <>
                          <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                            What {d.name} promises
                          </p>
                          <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                            The register counts these minutes only while the desk is open, in Dar es
                            Salaam time. An empty clock box is an answer, not a gap: it means this desk
                            promises no deadline, and a call that lands here gets no due date.
                          </p>
                          <div className="mt-12 grid gap-12"
                            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
                            <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              First answer, working minutes
                              <input type="number" min={5} max={4320} value={draft.answer}
                                onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
                                placeholder="empty = no promise"
                                className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                            </label>
                            <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              Resolution, working minutes
                              <input type="number" min={15} max={20160} value={draft.fix}
                                onChange={(e) => setDraft({ ...draft, fix: e.target.value })}
                                placeholder="empty = no promise"
                                className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                            </label>
                            <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              Live calls it will accept
                              <input type="number" min={1} max={500} value={draft.ceiling}
                                onChange={(e) => setDraft({ ...draft, ceiling: e.target.value })}
                                placeholder="empty = no ceiling"
                                className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                            </label>
                            <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              Desk above it when it cannot answer
                              <select value={draft.escalateTo}
                                onChange={(e) => setDraft({ ...draft, escalateTo: e.target.value })}
                                className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                                style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                                <option value="">Nothing — work stops here</option>
                                {departments.filter((o) => o.id !== d.id).map((o) => (
                                  <option key={o.id} value={o.id}>{o.name}</option>
                                ))}
                              </select>
                            </label>
                          </div>
                          {(draft.ceiling && Number(draft.ceiling) <= d.live_tickets) && (
                            <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>
                              {d.live_tickets} call(s) are already standing here, so the desk opens full:
                              new calls will still be logged — a ceiling never turns a caller away — but
                              a hand-over to it is refused until room appears.
                            </p>
                          )}
                          {(() => {
                            const target = departments.find((o) => o.id === draft.escalateTo);
                            return target?.escalation_department_id === d.id ? (
                              <p className="mt-8 text-[11px]" style={{ color: "var(--danger)" }}>
                                {target.name} already sends its work up to {d.name}, so this would be a
                                loop with no top. The register refuses it: escalate one of the two to a
                                third desk, or end the chain.
                              </p>
                            ) : null;
                          })()}

                          <div className="mt-14 flex flex-wrap items-center gap-10">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.12em]"
                              style={{ color: "var(--ink)" }}>The desk's week</p>
                            <button type="button" onClick={() => setDraft({ ...draft, week: { ...OFFICE_WEEK } })}
                              className="rounded-input border px-10 py-5 text-[11px]"
                              style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>Mon–Fri 08:00–17:00</button>
                            <button type="button" onClick={() => setDraft({ ...draft, week: { ...SHUT_WEEK } })}
                              className="rounded-input border px-10 py-5 text-[11px]"
                              style={{ borderColor: "var(--line)", color: "var(--warning)" }}>Shut every day</button>
                            <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              Clear both boxes on a day to shut it.
                            </span>
                          </div>
                          <ul className="mt-10 divide-y" style={{ borderColor: "var(--line)" }}>
                            {DAY_KEYS.map(([k, name]) => {
                              const hrs = draft.week[k];
                              return (
                                <li key={k} className="flex flex-wrap items-center gap-12 py-8">
                                  <span className="w-[86px] text-xs font-semibold" style={{ color: "var(--ink)" }}>
                                    {name}
                                  </span>
                                  {(["open", "close"] as const).map((which) => (
                                    <input key={which} type="time" value={hrs?.[which] ?? ""}
                                      onChange={(e) => setDayHours(k, which, e.target.value)}
                                      aria-label={`${name} ${which === "open" ? "opens" : "closes"}`}
                                      className="rounded-input border px-10 py-6 text-sm"
                                      style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                                  ))}
                                  <span className="text-[11px]" style={{ color: hrs ? "var(--success)" : "var(--ink-soft)" }}>
                                    {hrs?.open && hrs?.close ? "open" : hrs ? "half written — fill both or clear both" : "shut"}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>

                          <label className="mt-12 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                            Why the terms are changing — at least four characters, and the register keeps it
                            <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                              placeholder="The quay calls cannot wait eight working hours for an answer."
                              className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                          </label>
                          <div className="mt-10 flex flex-wrap gap-10">
                            <button type="button" disabled={busy || !reasonReady} onClick={submitTerms}
                              className="waisha-btn rounded-input px-14 py-6 text-xs font-semibold">
                              Save the terms
                            </button>
                            <button type="button" onClick={() => setPanel(null)}
                              className="rounded-input border px-14 py-6 text-xs"
                              style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>Cancel</button>
                          </div>
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
                          <p className="mt-6 text-[11px]" style={{ color: d.live_tickets ? "var(--danger)" : "var(--ink-soft)" }}>
                            {d.live_tickets
                              ? `${d.live_tickets} incidence(s) are still standing on this desk, `
                                + `oldest ${age(d.oldest_open)}. The register will refuse the close until `
                                + "they are settled or named a desk to move to — and a moved call keeps "
                                + "the number the caller was quoted."
                              : "Nothing is being worked here, so the close takes no call away from an answer."}
                          </p>
                          {!!d.live_tickets && (
                            <select value={draft.moveTicketsTo}
                              onChange={(e) => setDraft({ ...draft, moveTicketsTo: e.target.value })}
                              className="mt-10 w-full rounded-input border px-10 py-6 text-sm"
                              style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                              <option value="">Nowhere — refuse this close until I choose</option>
                              {departments.filter((o) => o.id !== d.id).map((o) => (
                                <option key={o.id} value={o.id}>
                                  Move the calls to {o.name}
                                  {o.max_open_tickets !== null
                                    ? ` — ${o.live_tickets} of ${o.max_open_tickets} held` : ""}
                                </option>
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

                  <div className="mt-14 flex flex-wrap items-center gap-8">
                    <Link href={`/control/departments/${d.id}`}
                      className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                      style={{ borderColor: "var(--adm-line)", color: "var(--adm-accent)" }}>
                      Desk sheet — {d.live_tickets} live, {d.breached_tickets} past due
                    </Link>
                    {canManage && !isOpen && (
                      <>
                        <button type="button" onClick={() => openTerms(d)}
                          className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                          style={{ borderColor: "var(--line)", color: "var(--gold)" }}>
                          Terms
                        </button>
                        {[
                          ["Add seats", "place"], ["Edit", "edit"], ["Name a head", "head"], ["Shut", "close"]
                        ].map(([what, kind]) => (
                          <button key={kind} type="button"
                            onClick={() => openPanel({ kind: kind as PanelKind, deptId: d.id })}
                            className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                            style={{ borderColor: "var(--line)", color: kind === "close" ? "var(--danger)" : "var(--adm-accent)" }}>
                            {what}
                          </button>
                        ))}
                        {d.head_user_id && (
                          <button type="button" onClick={() => openPanel({ kind: "stepdown", deptId: d.id })}
                            className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--warning)" }}>
                            Head steps down
                          </button>
                        )}
                      </>
                    )}
                  </div>

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
                      <div className="mt-10 flex flex-wrap gap-10">
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
                      <div className="mt-10 flex flex-wrap gap-10">
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
        <div className="mt-28 grid gap-16" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 360px), 1fr))" }}>
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

        {/* ---------------- the routing rules ---------------- */}
        <section className="mt-28">
          <div className="flex flex-wrap items-end justify-between gap-12">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                Routing rules
              </h2>
              <p className="mt-6 text-sm" style={{ color: "var(--ink-soft)" }}>
                {board ? `${board.rules.length} rule(s) on the chart` : "Reading the rules…"} · a call
                logged without a desk pointed at it is matched against these, lowest precedence first,
                and only ever onto a desk that is open. Asking where a call would go writes nothing —
                the register routes a call somebody actually took.
              </p>
            </div>
            <div className="flex flex-wrap gap-8">
              <button type="button" onClick={() => openPanel({ kind: "ruledry" })}
                className="rounded-input border px-14 py-6 text-xs font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                {panel?.kind === "ruledry" ? "Close the dry run" : "Where would a call go?"}
              </button>
              {board?.can_manage && (
                <button type="button" onClick={() => openRule()}
                  className="waisha-btn rounded-input px-14 py-6 text-xs font-semibold">
                  {panel?.kind === "rule" && !panel.ruleId ? "Close the form" : "Write a rule"}
                </button>
              )}
            </div>
          </div>

          {rulesError && (
            <div role="alert" className="mt-14 rounded-input px-12 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
              {rulesError}
            </div>
          )}

          {!!board?.precedence_clashes.length && (
            <div role="status" className="mt-14 rounded-input px-12 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
              {board.precedence_clashes.map((c) => (
                <p key={c.precedence}>
                  <span className="font-semibold">Two rules answer to precedence {c.precedence}: </span>
                  {c.names.join(" and ")}. That is allowed and 123 settles it by name, alphabetically —
                  so one of them wins every single call that fits both, quietly. Give them different
                  numbers if the order matters.
                </p>
              ))}
            </div>
          )}

          {panel?.kind === "rule" && (
            <div className="mt-16 rounded-card border p-18"
              style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
              <h3 className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                {panel.ruleId ? `Rewrite "${board?.rules.find((r) => r.id === panel.ruleId)?.name ?? "the rule"}"`
                  : "A new rule"}
              </h3>
              <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                A rule is one sentence: a call shaped like this goes to that desk. Leave a predicate
                empty to ask nothing on it — but at least one of the five must ask something, or the
                rule would take the whole platform queue.
              </p>
              <div className="mt-12 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
                <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Name — what a clerk says down the phone
                  <input value={draft.ruleName} onChange={(e) => setDraft({ ...draft, ruleName: e.target.value })}
                    placeholder="Dangerous goods, by phone" className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                </label>
                <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  The desk it lands on
                  <select value={draft.ruleDesk} onChange={(e) => setDraft({ ...draft, ruleDesk: e.target.value })}
                    className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                    <option value="">Choose a desk</option>
                    {(board?.desks ?? []).map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} — {o.live_tickets} live{o.max_open_tickets !== null ? ` of ${o.max_open_tickets}` : ""}
                        {o.breached_tickets ? `, ${o.breached_tickets} past due` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Precedence — 1 is first, lower wins
                  <input type="number" min={1} max={999} value={draft.rulePrecedence}
                    onChange={(e) => setDraft({ ...draft, rulePrecedence: e.target.value })}
                    className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                </label>
                <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Switched on
                  <select value={draft.ruleOn ? "yes" : "no"}
                    onChange={(e) => setDraft({ ...draft, ruleOn: e.target.value === "yes" })}
                    className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                    <option value="yes">Yes — it takes calls</option>
                    <option value="no">No — kept but silent</option>
                  </select>
                </label>
              </div>

              <div className="mt-14 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
                <Chips title="Channel" options={RULE_CHANNELS} picked={draft.ruleChannels}
                  toggle={(k, on) => setDraft({ ...draft,
                    ruleChannels: on ? [...draft.ruleChannels, k] : draft.ruleChannels.filter((x) => x !== k) })} />
                <Chips title="Subject" options={RULE_CATEGORIES} picked={draft.ruleCategories}
                  toggle={(k, on) => setDraft({ ...draft,
                    ruleCategories: on ? [...draft.ruleCategories, k] : draft.ruleCategories.filter((x) => x !== k) })} />
                <Chips title="Urgency" options={RULE_PRIORITIES} picked={draft.rulePriorities}
                  toggle={(k, on) => setDraft({ ...draft,
                    rulePriorities: on ? [...draft.rulePriorities, k] : draft.rulePriorities.filter((x) => x !== k) })} />
                <Chips title="Spoken in" options={RULE_LANGUAGES} picked={draft.ruleLanguages}
                  toggle={(k, on) => setDraft({ ...draft,
                    ruleLanguages: on ? [...draft.ruleLanguages, k] : draft.ruleLanguages.filter((x) => x !== k) })} />
                <Chips title="Region of the head office"
                  options={(board?.regions ?? []).map((g) => [String(g.id), g.name] as [string, string])}
                  picked={draft.ruleRegions.map(String)}
                  toggle={(k, on) => setDraft({ ...draft,
                    ruleRegions: on ? [...draft.ruleRegions, Number(k)]
                      : draft.ruleRegions.filter((x) => x !== Number(k)) })} />
              </div>
              <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {(() => {
                  const chosen = [draft.ruleChannels.length && `${draft.ruleChannels.length} channel(s)`,
                    draft.ruleCategories.length && `${draft.ruleCategories.length} subject(s)`,
                    draft.rulePriorities.length && `${draft.rulePriorities.length} urgency level(s)`,
                    draft.ruleLanguages.length && `${draft.ruleLanguages.length} language(s)`,
                    draft.ruleRegions.length && `${draft.ruleRegions.length} region(s)`].filter(Boolean);
                  return chosen.length
                    ? `This rule asks on ${chosen.join(", ")} — a call must satisfy every one of them.`
                    : "Nothing is chosen yet, so the register would refuse this rule.";
                })()}
                {draft.ruleRegions.length
                  ? " A rule that names regions matches a company with a head office region on file — one without a region matches no rule at all."
                  : ""}
              </p>

              <label className="mt-12 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                Note — why this rule exists, kept on the rule
                <input value={draft.ruleNote} onChange={(e) => setDraft({ ...draft, ruleNote: e.target.value })}
                  placeholder="Hazmat moved to the duty manager after the Dar es Salaam spill."
                  className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                  style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
              </label>
              <label className="mt-10 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                Why — at least four characters, and the register keeps it
                <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                  className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                  style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
              </label>
              <div className="mt-10 flex flex-wrap gap-10">
                <button type="button" disabled={busy} onClick={submitRule}
                  className="waisha-btn rounded-input px-14 py-6 text-xs font-semibold">
                  {panel.ruleId ? "Save the rule" : "Write the rule"}
                </button>
                <button type="button" onClick={() => setPanel(null)}
                  className="rounded-input border px-14 py-6 text-xs"
                  style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>Cancel</button>
              </div>
            </div>
          )}

          {panel?.kind === "ruledry" && (
            <div className="mt-16 rounded-card border p-18"
              style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
              <h3 className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                Where would a call like this go?
              </h3>
              <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                The same test the register runs, on a call that was never made. Nothing is written and
                no number is minted — this is a picture of the answer.
              </p>
              <div className="mt-12 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
                <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  How it came in
                  <select value={draft.dryChannel}
                    onChange={(e) => setDraft({ ...draft, dryChannel: e.target.value })}
                    className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                    {RULE_CHANNELS.map(([k, o]) => <option key={k} value={k}>{o}</option>)}
                  </select>
                </label>
                <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  About
                  <select value={draft.dryCategory}
                    onChange={(e) => setDraft({ ...draft, dryCategory: e.target.value })}
                    className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                    {RULE_CATEGORIES.map(([k, o]) => <option key={k} value={k}>{o}</option>)}
                  </select>
                </label>
                <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Urgency
                  <select value={draft.dryPriority}
                    onChange={(e) => setDraft({ ...draft, dryPriority: e.target.value })}
                    className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                    {RULE_PRIORITIES.map(([k, o]) => <option key={k} value={k}>{o}</option>)}
                  </select>
                </label>
                <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Spoken in
                  <select value={draft.dryLanguage}
                    onChange={(e) => setDraft({ ...draft, dryLanguage: e.target.value })}
                    className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                    {RULE_LANGUAGES.map(([k, o]) => <option key={k} value={k}>{o}</option>)}
                  </select>
                </label>
                <label className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  From the head office in
                  <select value={draft.dryRegion}
                    onChange={(e) => setDraft({ ...draft, dryRegion: e.target.value })}
                    className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                    <option value="">Any region / not known</option>
                    {(board?.regions ?? []).map((g) => (
                      <option key={g.id} value={String(g.id)}>{g.name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <button type="button" disabled={busy} onClick={runDry}
                className="waisha-btn mt-12 rounded-input px-14 py-6 text-xs font-semibold">
                Ask the chart
              </button>

              {dry && (
                <div className="mt-14 rounded-input border p-14" style={{ borderColor: "var(--adm-line)" }}>
                  <p className="text-sm font-semibold" style={{ color: dry.routed_to ? "var(--success)" : "var(--warning)" }}>
                    {dry.note}
                  </p>
                  {dry.routed_to && (
                    <dl className="mt-10 grid gap-6 text-[11px]" style={{ gridTemplateColumns: "auto 1fr" }}>
                      <dt className="font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>Desk</dt>
                      <dd style={{ color: "var(--ink)" }}>
                        {dry.routed_to.department_name}{" "}
                        <span style={{ color: "var(--adm-accent)" }}>{dry.routed_to.department_key}</span>
                        {" · "}{dry.routed_to.open_tickets} live
                        {dry.routed_to.max_open_tickets !== null
                          ? ` of ${dry.routed_to.max_open_tickets}, room for ${dry.routed_to.headroom}` : ""}
                      </dd>
                      <dt className="font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>Rule</dt>
                      <dd style={{ color: "var(--ink)" }}>
                        {dry.routed_to.rule_name} at precedence {dry.routed_to.precedence}
                      </dd>
                      {dry.region_name && (
                        <>
                          <dt className="font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>Read as</dt>
                          <dd style={{ color: "var(--ink)" }}>
                            {dry.company ?? "The company"} — head office in {dry.region_name}
                          </dd>
                        </>
                      )}
                    </dl>
                  )}
                  {dry.region_note && (
                    <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>{dry.region_note}</p>
                  )}
                  {Array.isArray(dry.rules_that_fit) && dry.rules_that_fit.length > 1 && (
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      Also fitted and lost on precedence:{" "}
                      {dry.rules_that_fit.filter((r: any) => !r.won)
                        .map((r: any) => `${r.name} (${r.precedence})`).join(", ")}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <ul className="mt-16 divide-y" style={{ borderColor: "var(--line)" }}>
            {[...(board?.rules ?? [])]
              .sort((a, b) => a.precedence - b.precedence || a.name.localeCompare(b.name))
              .map((r) => {
                const open = panel?.kind === "rule" && panel.ruleId === r.id;
                const retiring = panel?.kind === "retire" && panel.ruleId === r.id;
                return (
                  <li key={r.id} className="py-14">
                    <div className="flex flex-wrap items-start gap-12">
                      <span className="rounded-input px-10 py-6 text-sm font-bold tabular-nums"
                        style={{ background: "var(--adm-accent-soft)", color: "var(--adm-accent)",
                          border: "1px solid var(--adm-line)" }}
                        title="Lower precedence is tried first">
                        {r.precedence}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                          {r.name}
                          {!r.is_active && (
                            <span className="ml-8 px-6 py-2 text-[10px] font-bold uppercase tracking-[0.1em]"
                              style={{ background: "color-mix(in srgb, var(--warning) 18%, transparent)",
                                color: "var(--warning)", borderRadius: 999 }}>
                              silent
                            </span>
                          )}
                        </p>
                        <p className="mt-4 text-xs" style={{ color: "var(--ink)" }}>{r.sentence}</p>
                        <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          {r.fired} call(s) routed by it
                          {r.note ? ` · ${r.note}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-8">
                        <Link href={`/control/departments/${r.department_id}`}
                          className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                          style={{ borderColor: "var(--adm-line)", color: "var(--adm-accent)" }}>
                          {r.department_name}
                        </Link>
                        {board?.can_manage && (
                          <>
                            <button type="button"
                              onClick={() => openRule(r)}
                              className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                              style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                              Rewrite
                            </button>
                            <button type="button"
                              onClick={() => openPanel({ kind: "retire", ruleId: r.id })}
                              className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                              style={{ borderColor: "var(--line)", color: "var(--danger)" }}>
                              Retire
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {retiring && (
                      <div className="mt-12 rounded-input border p-12" style={{ borderColor: "var(--adm-line)" }}>
                        <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          Retiring keeps "{r.name}" and every count it ever made in the register and
                          stops it taking calls. It does not delete a rule that answered somebody.
                        </p>
                        <label className="mt-8 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          Why it is being retired
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            className="mt-4 w-full rounded-input border px-10 py-6 text-sm"
                            style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                        </label>
                        <button type="button" disabled={busy || !reasonReady}
                          onClick={twoTap(`retire:${r.id}`, () => submitRetire(r))}
                          className="mt-10 rounded-input px-14 py-6 text-xs font-semibold"
                          style={{
                            background: armed === `retire:${r.id}` ? "var(--danger)" : "transparent",
                            border: "1px solid var(--danger)",
                            color: armed === `retire:${r.id}` ? "#fff" : "var(--danger)"
                          }}>
                          {armed === `retire:${r.id}` ? "Tap again to retire it" : "Retire the rule"}
                        </button>
                      </div>
                    )}
                    {open && <p className="mt-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      The form is above the list — rewrite it there and save.
                    </p>}
                  </li>
                );
              })}
            {board && board.rules.length === 0 && (
              <li className="py-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                No rule is written, so every call lands in the queue until a clerk points it at a desk.
                That is a working state, not an error — but it is the state where a call can be missed.
              </li>
            )}
          </ul>
        </section>

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
              className="min-w-[min(100%,240px)] flex-1 rounded-input border px-10 py-6 text-xs"
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
