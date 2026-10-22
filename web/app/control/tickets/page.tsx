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
 *
 * Since 123 a call carries two numbers and two clocks. The CS number is the platform's and never
 * changes; the desk number is the holding desk's own queue position, minted once by
 * `platform_auth.next_ticket_number`, and both survive an escalation to the desk above — so this
 * page prints the number that was quoted, the desk that quoted it, and the register's own sentence
 * whenever a deadline does not exist. A grey "no clock set" is never shown as a kept promise.
 */

// The vocabulary is the API's (control-tickets.routes.ts). A key the route does not accept is
// a 400 with a field list, so this is a mirror, not a preference.
const CHANNELS: [string, string][] = [
  ["phone_call", "Phone call"], ["whatsapp", "WhatsApp"], ["email", "Email"],
  ["walk_in", "Walked in"], ["portal_message", "Portal message"],
  ["chat", "Live chat"], ["web_form", "Web form"], ["other", "Something else"]
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
  ["resolved", "Resolved"], ["closed", "Closed"], ["merged", "Folded into another call"]
];
const LANGUAGES: [string, string][] = [["en", "English"], ["sw", "KiSwahili"]];
const ACTIONS: [string, string][] = [
  ["logged", "Written into the register"], ["allocated", "Handed to a department"],
  ["reallocated", "Moved between desks"],
  ["routed", "Sent to a desk by the chart"],
  ["escalated", "Pushed up to the desk above"],
  ["status_changed", "State changed"],
  ["priority_changed", "Re-rated"], ["note_added", "A line was added"],
  ["resolved", "Resolved"], ["reopened", "Reopened"], ["closed", "Closed"],
  ["withdrawn", "Taken off the boards"],
  ["merged", "Folded into another call"],
  ["tagged", "Given a label"], ["untagged", "Had a label taken off"],
  ["file_attached", "A file was put on it"], ["file_dropped", "A file was taken off it"],
  ["alerted", "Its desk head was told"]
];

/** The two clocks, in the words the register returns them in (`CLOCK_STATES`). `none` is not a
 *  pass: it means the desk set no deadline, so nothing was promised and nothing can be late. */
const CLOCK_WORDS: Record<string, string> = {
  none: "no clock set", running: "clock running", breached: "past its deadline",
  met: "kept", late: "missed it"
};
const CLOCK_EDGE: Record<string, string> = {
  none: "var(--ink-soft)", running: "var(--adm-accent)", breached: "var(--danger)",
  met: "var(--success)", late: "var(--danger)"
};

const label = (list: [string, string][], key: string | null | undefined) =>
  list.find(([k]) => k === key)?.[1] ?? key ?? "—";

type Row = {
  id: string; ref: string; ts: string; updated_at: string; reporter_name: string;
  reporter_email: string | null; channel: string; category: string; subject: string;
  priority: string; status: string; language: string;
  company_tenant_id: string | null; company_name: string | null;
  department_id: string | null; department_name: string | null; has_phone: boolean;
  // What the desk it is standing on promised it, and whether it has been kept.
  dept_ref: string | null; dept_number: number | null;
  numbered_by_key: string | null; numbered_by_name: string | null;
  response_due_at: string | null; resolution_due_at: string | null;
  first_response_at: string | null; after_hours: boolean;
  escalated_at: string | null; escalated_from_name: string | null;
  response_state: string; resolution_state: string;
  allocated_at: string | null; resolved_at: string | null; allocated_by_name: string | null;
  // What 125 put on the same row: the labels the office invented, the paper filed against the
  // call, and where a folded duplicate went. A list row carries them because the queue is read
  // by somebody deciding which of sixty lines to open first.
  tags: { id: string; name: string; colour: string | null }[] | null; files: number;
  merged_into_id: string | null; merged_into_ref: string | null; merged_at: string | null;
  reopen_count: number; last_reopened_at: string | null;
  events: number; last_activity: string | null;
};
type DeskSeat = { id: string; name: string; key: string };
type Load = DeskSeat & {
  sort: number; unallocated: number; working: number; pressing: number; settled: number;
  oldest_open: string | null;
  first_response_minutes: number | null; resolve_minutes: number | null;
  max_open_tickets: number | null; escalation_department_id: string | null;
  desk_is_open_now: boolean; overdue: number; unanswered: number; no_clock: number;
  unnumbered: number; live_tickets: number;
};
type Summary = { n: number; unallocated: number; working: number; settled: number;
  folded: number; pressing: number; overdue: number; unanswered: number; no_clock: number;
  unnumbered: number; reopened: number };
type Desk = {
  can_manage: boolean; window_days: number; summary: Summary; departments: Load[];
  my_departments: DeskSeat[]; items: Row[];
};
type Ticket = Omit<Row, "has_phone" | "events" | "last_activity" | "allocated_by_name"> & {
  body: string; department_key: string | null; resolution: string | null;
  numbered_by: string | null;
  allocated_by_name: string | null; resolved_by_name: string | null; created_by_name: string | null;
  phone: string | null; phone_unreadable: boolean;
  // The holding desk's own terms, on the same row the deadlines were read from, so the panel
  // can never quote a due minute without the week and the promise it was counted against.
  first_response_minutes: number | null; resolve_minutes: number | null;
  business_hours: Record<string, { open: string; close: string } | null> | null;
  max_open_tickets: number | null; escalation_department_id: string | null;
  escalation_key: string | null; escalation_name: string | null; desk_is_open_now: boolean;
  // The fold, the window and the alert — all read on the incidence's own row, so the panel that
  // says "this one is folded" and the one that says "you may reopen it" are the same read.
  merged_into_id: string | null; merged_into_ref: string | null;
  merged_into_status: string | null; merged_into_dept_ref: string | null;
  merged_at: string | null; merged_by_name: string | null;
  reopen_days: number | null; department_head_name: string | null;
  breach_alerted_at: string | null;
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

/** The three libraries 125 added: the labels the office invents for itself, the answers it
 *  gives every week, and the paper filed against one call. */
type Tag = { id: string; name: string; colour: string | null; note: string | null;
  live: number; tagged: number; created_at?: string; updated_at?: string };
type Reply = { id: string; slug: string; title: string; body_en: string; body_sw: string | null;
  category: string | null; is_active: boolean; note: string | null;
  created_at?: string; updated_at?: string; updated_by_name?: string | null };
type FileRow = { id: string; kind: string; file_name: string; mime_type: string;
  size_bytes: number; created_at: string; uploaded_by_name: string | null };
type BreachDeskRow = { department_id: string; department_key: string; department_name: string;
  head_user_id: string | null; head_name: string | null; breached: number;
  unanswered_over: number; unresolved_over: number; unalerted: number;
  last_alerted_at: string | null; worst_overdue_since: string | null };
type BreachLineRow = { id: string; ref: string; subject: string; priority: string;
  channel: string; dept_ref: string | null; company_name: string | null;
  response_due_at: string | null; resolution_due_at: string | null;
  first_response_at: string | null; breach_alerted_at: string | null;
  department_id: string | null; total: number };
type BreachBoard = {
  can_manage: boolean; mail_configured: boolean;
  overdue: { breached: number; unanswered_over: number; unresolved_over: number;
    unalerted: number; unheld: number; worst_overdue_since: string | null };
  unheld: { n: number; oldest_since: string | null; waiting_over_a_day: number };
  board: BreachDeskRow[]; waiting: BreachLineRow[]; waiting_total: number; note: string | null;
};
/** The register returns applied lines first and refused lines after them, with the count of the
 *  first group; `done` is that split marked on each row, so the receipt table never has to guess
 *  from the wording whether a line moved. */
type BulkReceipt = { id: string; ref: string | null; note: string; done: boolean };

type Filter = {
  status: string; department: string; mine: string; category: string; priority: string;
  q: string; phone: string; company: string; days: string; limit: string; clock: string;
  channel: string; tag: string; offset: string;
};
const EMPTY_FILTER: Filter = {
  status: "", department: "", mine: "", category: "", priority: "",
  q: "", phone: "", company: "", days: "60", limit: "60", clock: "",
  channel: "", tag: "", offset: "0"
};
const CLOCKS: [string, string][] = [
  ["", "Any clock"], ["late", "Past a deadline"], ["on_time", "Still inside every promise"],
  ["no_clock", "Nobody set a deadline"]
];

/** One draft object for every form on the desk, the way the org chart does it: a panel that
 *  reuses the last panel's typing is how a reason ends up on the wrong incidence. */
type Draft = {
  reporterName: string; reporterEmail: string; reporterPhone: string; channel: string;
  companyTenantId: string; companyName: string; category: string; subject: string;
  body: string; priority: string; language: string; departmentId: string; reason: string;
  toDepartment: string; escalateTo: string; workStatus: string; reopen: boolean;
  outcome: string; resolution: string; priorityTo: string;
  // The 125 forms. A fold names the line that stays; a label is picked from the office's own
  // list; an answer is a reply plus the language it was asked for; paper is a file and a
  // sentence about why it belongs on the call; bulk is one act repeated over the ticked rows.
  mergeInto: string; mergeQuery: string; tagId: string; tagName: string; tagColour: string;
  tagNote: string; replyId: string; replySlug: string; replyTitle: string; replyBodyEn: string;
  replyBodySw: string; replyCategory: string; replyActive: boolean; replyNote: string;
  answerLanguage: string; answerText: string; answerChannel: string; bulkAction: string;
  bulkDepartment: string; bulkPriority: string; bulkTagIds: string[];
};
const EMPTY_DRAFT: Draft = {
  reporterName: "", reporterEmail: "", reporterPhone: "", channel: "phone_call",
  companyTenantId: "", companyName: "", category: "", subject: "", body: "",
  priority: "normal", language: "en", departmentId: "", reason: "", toDepartment: "",
  escalateTo: "", workStatus: "in_progress", reopen: false, outcome: "resolved",
  resolution: "", priorityTo: "",
  mergeInto: "", mergeQuery: "", tagId: "", tagName: "", tagColour: "", tagNote: "",
  replyId: "", replySlug: "", replyTitle: "", replyBodyEn: "", replyBodySw: "",
  replyCategory: "", replyActive: true, replyNote: "", answerLanguage: "en", answerText: "",
  answerChannel: "", bulkAction: "allocate", bulkDepartment: "", bulkPriority: "",
  bulkTagIds: []
};
type PanelKind = "new" | "allocate" | "unallocate" | "work" | "resolve" | "priority"
  | "note" | "escalate" | "tombstone" | "merge" | "tags" | "answer" | "files" | "bulk"
  | "tag" | "canned" | "notify";
/** `tagId`/`replyId`/`docId` say which row of a library the form is editing, and `fileKind`
 *  which file of an incidence is being retired — a panel that only knew the ticket could not
 *  tell "new label" from "rename this one". */
type Panel = { kind: PanelKind; ticketId?: string; ticketRef?: string; tagId?: string;
  replyId?: string; docId?: string; fileName?: string };

const E164 = /^\+[1-9]\d{7,14}$/;
const when = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const day = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—";
/** A library row shows the start of an answer so a clerk recognises it, not so they read it here. */
const clip = (s: string, n = 220) => `${s.slice(0, n)}${s.length > n ? "…" : ""}`;

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
  resolved: "var(--success)", closed: "var(--ink-soft)", merged: "var(--gold)"
};
const PRIORITY_EDGE: Record<string, string> = {
  low: "var(--ink-soft)", normal: "var(--adm-accent)", high: "var(--warning)", urgent: "var(--danger)"
};
const EVENT_EDGE: Record<string, string> = {
  logged: "var(--adm-accent)", allocated: "var(--success)", reallocated: "var(--warning)",
  routed: "var(--gold)", escalated: "var(--danger)",
  status_changed: "var(--adm-accent)", priority_changed: "var(--warning)",
  note_added: "var(--ink-soft)", resolved: "var(--success)", reopened: "var(--danger)",
  closed: "var(--ink-soft)", withdrawn: "var(--danger)",
  merged: "var(--gold)", tagged: "var(--gold)", untagged: "var(--ink-soft)",
  file_attached: "var(--adm-accent)", file_dropped: "var(--warning)", alerted: "var(--danger)"
};

/** A promise in the unit a clerk quotes back over the phone. */
function clockWords(n: number | null): string {
  if (n === null) return "no clock";
  if (n < 60) return `${n} min`;
  if (n < 1440) return `${Math.round(n / 6) / 10} h`;
  const days = n / 1440;
  return `${Number.isInteger(days) ? days : Math.round(days * 10) / 10} day${days === 1 ? "" : "s"}`;
}

const WEEK_DAYS: [string, string][] = [
  ["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"],
  ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]
];
/** The desk's week in one line. The detail read returns the JSON 123 stores, and a deadline
 *  quoted without the hours it was counted against is the deadline that gets argued with. */
function weekShort(w: Ticket["business_hours"]): string {
  if (!w) return "no working week set";
  const open = WEEK_DAYS.filter(([k]) => !!(w as any)[k]?.open && !!(w as any)[k]?.close);
  if (!open.length) return "shut every day of the week";
  return open.map(([k]) =>
    `${k.toUpperCase()} ${(w as any)[k].open}–${(w as any)[k].close}`).join(" · ");
}

/** One of the two clocks, as a chip. `none` is grey on purpose: a promise nobody made cannot be
 *  broken, and printing it as kept would say the desk hit a target it never had. */
function ClockChip({ which, state }: { which: "Answer" | "Fix"; state: string }) {
  const edge = CLOCK_EDGE[state] ?? "var(--line)";
  return (
    <span className="whitespace-nowrap rounded-input px-8 py-2 text-[10px] font-semibold"
      style={{ border: `1px solid ${edge}`, color: edge }}
      title={`${which} clock: ${CLOCK_WORDS[state] ?? state}`}>
      {which.toLowerCase()}: {CLOCK_WORDS[state] ?? state}
    </span>
  );
}

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
  // The register's own sentence about why a call has no deadline, read with the call. The desk
  // does not invent this: a clock the platform could not set is the desk's problem to explain.
  const [sheetNote, setSheetNote] = useState<string | null>(null);
  const [canEscalate, setCanEscalate] = useState(false);

  const [companyQ, setCompanyQ] = useState("");
  const [companyHits, setCompanyHits] = useState<any[] | null>(null);
  const [companyNote, setCompanyNote] = useState<string | null>(null);
  const [companyBusy, setCompanyBusy] = useState(false);

  // The three libraries 125 added and the board the clocks feed. Each is read from its own
  // route rather than reconstructed here, so a label count, a reply's missing Swahili half or a
  // desk's overdue lines are the register's answer and not this page's arithmetic.
  const [tags, setTags] = useState<{ can_manage: boolean; items: Tag[] } | null>(null);
  const [replies, setReplies] = useState<{ can_manage: boolean; tokens: string[]; items: Reply[] } | null>(null);
  const [libError, setLibError] = useState<string | null>(null);
  const [files, setFiles] = useState<{ items: FileRow[]; storage_configured: boolean } | null>(null);
  const [breach, setBreach] = useState<BreachBoard | null>(null);
  const [breachDept, setBreachDept] = useState("");
  // One row per desk the board tried to tell, with the provider's answer. Kept apart from the
  // board itself because the board is re-read after the send — the receipt is the one place the
  // desk can see that a notice went out or did not, per desk, not as a single "ok".
  const [receipts, setReceipts] = useState<any[] | null>(null);
  // A fold is a search of the register, not a guess at a number: the keeper is the line that
  // will be worked afterwards, so the desk has to see its subject and its desk before it picks.
  const [mergeHits, setMergeHits] = useState<Row[] | null>(null);
  const [preview, setPreview] = useState<any | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [bulkLines, setBulkLines] = useState<BulkReceipt[] | null>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);

  const seq = useRef(0);
  const detailSeq = useRef(0);
  const mergeSeq = useRef(0);

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
    if (filter.clock) params.set("clock", filter.clock);
    if (filter.channel) params.set("channel", filter.channel);
    if (filter.tag) params.set("tag", filter.tag);
    params.set("days", filter.days);
    params.set("limit", filter.limit);
    // Page one is the default, so it is not sent; an offset the register already applied is
    // the only thing that says "these are the next sixty", and a filter change that forgets it
    // is how a desk reads an empty table as an empty queue.
    if (filter.offset !== "0") params.set("offset", filter.offset);
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

  // A selection belongs to the screen it was ticked on. Change the filter and the rows under it
  // are different rows, so the ticks go with them rather than following the operator to a queue
  // they never selected against.
  useEffect(() => { setPicked([]); }, [f]);

  // A desk sheet links here with the calls it is standing on: `?department=` filters the queue
  // to it, `?open=` brings one incidence out. Read off the location rather than
  // useSearchParams, which would make this page a suspense boundary for a query string only
  // our own links write. A value that is not an id is dropped, not sent — the register would
  // answer a stray link with a 400 the operator cannot fix.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const dept = qs.get("department");
    if (dept && UUID.test(dept)) setF((prev) => ({ ...prev, department: dept, mine: "" }));
    const one = qs.get("open");
    if (one && UUID.test(one)) openTicket(one);
    // Once, from the address the page was opened with — later typing in the filters is the
    // operator's, not something a stale query string may overwrite.
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
    setSheetNote(j.clock_note ?? null); setCanEscalate(!!j.can_escalate);
    setSheetLoading(false);
  }, []);

  // ---------- the paper on one incidence ----------
  const loadFiles = useCallback(async (id: string) => {
    const res = await fetch(`${API}/api/v1/control/tickets/${id}/files`, { credentials: "include" });
    if (!res.ok) { setFiles(null); return; }
    setFiles(await res.json());
  }, []);

  function openTicket(id: string) {
    setPanel(null); setPanelError(null); setArmed(null);
    setNotice(null);
    setOpened(id); setTicket(null); setEvents([]);
    setSheetNote(null); setCanEscalate(false);
    setFiles(null); setPreview(null); setMergeHits(null);
    setDraft({ ...EMPTY_DRAFT });
    loadDetail(id);
    loadFiles(id);
    jumpTo("ticket-sheet");
  }
  function closeTicket() {
    setOpened(null); setTicket(null); setEvents([]); setPanel(null); setPanelError(null);
    setArmed(null); setSheetNote(null); setCanEscalate(false);
    setFiles(null); setPreview(null); setMergeHits(null);
  }

  /** Opening an action form on the incidence it belongs to. Re-tapping the same button closes
   *  it; tapping another one never inherits the previous panel's reason or resolution.
   *  `seed` carries the one thing a panel cannot invent: the language and the channel the call
   *  arrived on, which decide which half of a reply the caller is given. */
  function openPanel(next: Panel, seed?: Partial<Draft>) {
    const closing = panel?.kind === next.kind
      && panel?.ticketId === next.ticketId && panel?.tagId === next.tagId
      && panel?.replyId === next.replyId && panel?.docId === next.docId;
    setPanelError(null); setNotice(null); setArmed(null);
    setPreview(null); setMergeHits(null); setBulkLines(null); setPickedFile(null);
    setReceipts(null);
    if (closing) {
      // A half-written call survives its own panel being closed by a mis-tap; a reason box does
      // not survive a different panel, because that is how one sentence lands on another ticket.
      if (next.kind !== "new") setDraft({ ...EMPTY_DRAFT });
      setPanel(null);
      return;
    }
    setDraft({ ...EMPTY_DRAFT, ...seed });
    if (next.kind === "files" && next.ticketId) loadFiles(next.ticketId);
    setPanel(next);
  }

  /** The desk is one long page: a call's sheet sits above the register, and the two libraries
   *  below it. Opening one from the other therefore has to carry the operator to it, or the
   *  tap reads as a button that did nothing at all. */
  const jumpTo = (id: string) => requestAnimationFrame(() => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  /** A library form is its own section, not part of a call's sheet, because a label belongs to
   *  the office and not to one incidence. */
  function openLibrary(next: Panel, seed?: Partial<Draft>) {
    openPanel(next, seed);
    jumpTo(next.kind === "canned" ? "canned-replies" : "ticket-tags");
  }

  const refresh = useCallback(() => { load(f); }, [f, load]);

  /** A filter change always goes through here. Changing what the queue is filtered to while
   *  sitting on page four shows sixty rows that are not the ones the operator was counting, so
   *  the offset is cleared by the same act that changes the shape of the list. */
  const patch = (next: Partial<Filter>) => setF((prev) => ({ ...prev, ...next, offset: "0" }));

  /** Paging is the one filter change that must keep its own place: a step is a move along the
   *  same list, so it goes through the offset rather than through `patch`, which exists to clear
   *  it. The register counts the whole filter, not the screen, so the desk can see how far from
   *  the top of its own queue it is standing. */
  const step = (delta: number) => setF((prev) => ({
    ...prev,
    offset: String(Math.max(0, Number(prev.offset || 0) + delta * Number(prev.limit)))
  }));

  const settle = (message: string) => {
    setNotice(message); setPanel(null); setArmed(null);
    if (opened) { loadDetail(opened); loadFiles(opened); }
    // A move on a call changes the clock it is standing on, and a label count changes when a
    // call is folded or labelled — both boards restate those numbers, so both are re-read.
    refresh(); loadBreaches(); loadTags();
  };

  /** Every write goes through here. The API answers a bad body with a field list, and that
   *  list is the only part of the reply that says what to fix. `path` is under `/api/v1/control`,
   *  because 125's libraries live on their own prefixes — `/control/ticket-tags` and
   *  `/control/canned-replies` are not under the register, and a helper that could only reach
   *  `/control/tickets/…` would leave the desk unable to make a label at all. */
  async function send(method: "POST" | "PUT", path: string, body: unknown): Promise<any | null> {
    setBusy(true); setPanelError(null);
    try {
      const res = await fetch(`${API}/api/v1/control${path}`, {
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

  /** The moves on one incidence, which all live under the register itself. */
  const write = (method: "POST", path: string, body: unknown) =>
    send(method, `/tickets${path}`, body);

  /** Bytes go up as multipart, and the sentence about why belongs on the call has to be
   *  appended before the file — a field that arrives after the file part is never seen. */
  async function upload(id: string, doc: File | null, reason: string): Promise<any | null> {
    if (!doc) { setPanelError("Choose the file first."); return null; }
    setBusy(true); setPanelError(null);
    try {
      const form = new FormData();
      form.append("reason", reason);
      form.append("file", doc, doc.name);
      const res = await fetch(`${API}/api/v1/control/tickets/${id}/files`, {
        method: "POST", body: form, credentials: "include"
      });
      if (res.status === 401) { window.location.href = "/control/login"; return null; }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hints = (j?.error?.details ?? []).map((d: any) => d.message ?? d.field).filter(Boolean).slice(0, 3);
        setPanelError([j?.error?.message ?? "The file was refused.", ...hints].join(" — "));
        return null;
      }
      return j;
    } finally { setBusy(false); }
  }

  // ---------- the two libraries ----------
  const loadTags = useCallback(async () => {
    const res = await fetch(`${API}/api/v1/control/ticket-tags`, { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (!res.ok) { setLibError("The label list did not answer."); return; }
    setTags(await res.json()); setLibError(null);
  }, []);

  const loadReplies = useCallback(async () => {
    const res = await fetch(`${API}/api/v1/control/canned-replies`, { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (!res.ok) { setLibError("The answer library did not answer."); return; }
    setReplies(await res.json()); setLibError(null);
  }, []);

  // ---------- the breach board ----------
  const loadBreaches = useCallback(async (department?: string) => {
    const params = department ? `?department=${department}` : "";
    const res = await fetch(`${API}/api/v1/control/tickets/breaches${params}`,
      { credentials: "include" });
    if (!res.ok) return;
    setBreach(await res.json());
  }, []);

  // The two libraries and the breach board are read once on arrival. They are the register's
  // own numbers, so the desk is never shown a label count or an overdue line this page made up.
  useEffect(() => {
    loadTags(); loadReplies(); loadBreaches();
  }, [loadTags, loadReplies, loadBreaches]);

  /** The keeper is chosen from the register, not from memory. A year back and twenty rows, on
   *  the words the clerk typed — because the fold is the one action that decides which of two
   *  lines a caller's number still means something on. */
  async function searchMerge(term: string) {
    const mine = ++mergeSeq.current;
    const q = term.trim();
    if (q.length < 2) { setMergeHits([]); setPanelError("Type at least two letters, or the whole CS number."); return; }
    const params = new URLSearchParams({ q, days: "365", limit: "20" });
    const res = await fetch(`${API}/api/v1/control/tickets?${params}`, { credentials: "include" });
    if (mine !== mergeSeq.current) return;
    if (!res.ok) { setMergeHits(null); setPanelError("The register did not answer that search."); return; }
    const j = await res.json();
    setMergeHits((j.items ?? []).filter((r: Row) => r.status !== "merged"));
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
      priority: draft.priority, language: draft.language,
      departmentId: draft.departmentId || null,
      reason: draft.reason.trim() || null
    });
    if (!j) return;
    // Every part of this sentence is the register's own answer, not a guess at what happened:
    // the desk the chart chose, the number the caller was quoted, and the reason there is no
    // number when there isn't one.
    const who = j.allocated_to
      ? (j.routed_by_rule ? `${j.allocated_to}, by the rule "${j.routed_by_rule}"` : `straight to ${j.allocated_to}`)
      : "waiting for a department";
    const number = j.dept_ref ? ` Quoted ${j.dept_ref}.` : (j.number_note ? ` ${j.number_note}` : "");
    setNotice(`${j.ref} is in the register — ${who}.${number}`
      + (j.clock_note ? ` ${j.clock_note}` : "")
      + (j.over_ceiling ? ` ${j.allocated_to} is already at its ceiling, so it takes this one as an extra.` : ""));
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
    // The desk's own number and the register's own sentence about its clock are both in the
    // reply. Repeating them is the point: the operator reads the caller the same words the
    // table kept, and a hand-over that started no clock says so instead of looking quiet.
    settle(to
      ? `${j.ref} now belongs to ${j.department_name ?? "that desk"}`
        + (j.dept_ref ? `, quoted ${j.dept_ref} by it.` : ".")
      : `${j.ref} is back in the queue — nobody holds it.`
      + (j.clock_note ? ` ${j.clock_note}` : ""));
  }

  /** Hand it to the desk above, and write down who could not answer. The number and both
   *  deadlines ride up with the work — the register says so, so the sentence here must not
   *  imply a fresh start the caller will not get. */
  async function submitEscalate() {
    const target = draft.escalateTo || ticket?.escalation_department_id || null;
    const j = await write("POST", `/${ticket!.id}/escalate`, {
      departmentId: target, reason: draft.reason.trim()
    });
    if (!j) return;
    settle(`${j.ref} is with ${j.department_name} now — ${j.escalated_from_name ?? "that desk"}`
      + " is on record as not having answered it."
      + (j.dept_ref ? ` It keeps ${j.dept_ref}, the number the caller already has.`
        : " It has no desk number of its own yet.")
      + (j.over_ceiling ? ` ${j.department_name} is already at its ceiling, so it takes this one as an extra.` : "")
      + (j.clock_note ? ` ${j.clock_note}` : ""));
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

  // ---------- the 125 moves: fold, label, answer, file, batch ----------
  /** Fold this line onto the one that is being answered. Two taps, because the folded call
   *  stops being work: everything the desk writes from now on belongs to the keeper, and the
   *  caller keeps only the number they were already given. */
  async function submitMerge() {
    if (!draft.mergeInto) { setPanelError("Say which line stays. Search the register and choose it."); return; }
    const kept = await send("POST", `/tickets/${ticket!.id}/merge`, {
      intoId: draft.mergeInto, reason: draft.reason.trim()
    });
    if (!kept) return;
    const under = kept.folded_under?.length ?? 0;
    settle(`${kept.ref} is folded into ${kept.merged_into_ref}`
      + `${kept.merged_into_subject ? ` — "${kept.merged_into_subject}"` : ""}, which is the line`
      + ` to work now. ${under + 1} call(s) sit under it${under > 0 ? ", so this problem was" : ""}`
      + `${under > 0 ? " raised more than once." : "."}`);
  }

  async function submitTagOn(tagId: string) {
    const j = await write("POST", `/${ticket!.id}/tags`, { tagId, reason: draft.reason.trim() });
    if (!j) return;
    setTicket({ ...ticket!, tags: j.tags });
    setNotice(`${j.ref} now wears ${j.tags.map((t: any) => `"${t.name}"`).join(", ") || "nothing"}.`);
    setDraft({ ...draft, tagId: "" });
    refresh(); loadTags();
  }

  async function submitTagOff(tagId: string) {
    const j = await write("POST", `/${ticket!.id}/tags/drop`, { tagId, reason: draft.reason.trim() });
    if (!j) return;
    setTicket({ ...ticket!, tags: j.tags });
    setNotice(`${j.ref} no longer wears that label. The register keeps the line saying it did.`);
    refresh(); loadTags();
  }

  /** The words the caller is given. This is not an email the platform sends: 112 has no
   *  support-reply purpose, so the desk records what it said and says it itself, on the channel
   *  the call came in on. What moves is the answer clock — a human has now spoken to them. */
  async function runPreview() {
    const body: any = { ticketId: ticket!.id, language: draft.answerLanguage };
    if (draft.replyId) body.replyId = draft.replyId;
    else if (draft.answerText.trim()) body.body = draft.answerText.trim();
    else { setPanelError("Pick an answer, or write the words, then preview them."); return; }
    const j = await send("POST", "/canned-replies/preview", body);
    setPreview(j);
  }

  async function submitAnswer() {
    if (!draft.replyId && draft.answerText.trim().length < 4) {
      setPanelError("Say what was answered — pick one of the office's answers, or write the words.");
      return;
    }
    const body: any = {
      language: draft.answerLanguage, reason: draft.reason.trim(),
      channel: draft.answerChannel || undefined
    };
    if (draft.replyId) body.replyId = draft.replyId; else body.text = draft.answerText.trim();
    const j = await write("POST", `/${ticket!.id}/answer`, body);
    if (!j) return;
    settle(`${j.ref}: the answer was written on the line, in ${label(LANGUAGES, j.language)}.`
      + ` Its answer clock is ${CLOCK_WORDS[j.response_state] ?? j.response_state}.`
      + (j.fell_back ? " There is no KiSwahili half of that answer, so English went out —"
        + " the office should write one." : "")
      + (j.unfilled?.length ? ` This call could not fill: ${j.unfilled.map((t: string) => `{${t}}`).join(", ")}.`
        : " Every placeholder had a value on this call.")
      + " Say it down the phone or send it from the channel the call came in on — the platform"
      + " posted nothing.");
  }

  async function submitFile() {
    if (draft.reason.trim().length < 4) {
      setPanelError("Say why this paper belongs on the call — the register keeps the sentence.");
      return;
    }
    const j = await upload(ticket!.id, pickedFile, draft.reason.trim());
    if (!j) return;
    setNotice(`${j.file_name} is on ${ticket!.ref}. Bytes are capped at 8 MB and a file is only`
      + " taken as a real JPEG, PNG, WebP or PDF.");
    loadFiles(ticket!.id); setPickedFile(null);
    setDraft({ ...draft, reason: "" });
    refresh();
  }

  async function submitFileRetire(docId: string) {
    const j = await write("POST", `/${ticket!.id}/files/${docId}/tombstone`,
      { reason: draft.reason.trim() });
    if (!j) return;
    setNotice(`"${j.file_name}" is off the panel. The bytes and the line saying they were filed stay.`);
    loadFiles(ticket!.id); refresh();
  }

  async function openFile(docId: string) {
    setPanelError(null);
    const res = await fetch(`${API}/api/v1/control/tickets/${ticket!.id}/files/${docId}`,
      { credentials: "include" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setPanelError(j?.error?.message ?? "That file would not open.");
      return;
    }
    if (j.url) window.open(j.url, "_blank", "noopener,noreferrer");
  }

  /** One act, several times. Every line comes back named — moved or refused with the reason —
   *  because a bulk call that answers only "ok" leaves the desk unable to tell which of its own
   *  fifty calls went nowhere. */
  async function submitBulk() {
    const bad: string[] = [];
    if (!picked.length) bad.push("Tick the calls first — fifty is the ceiling.");
    if (picked.length > 50) bad.push("That is more than the register will move at once (50).");
    if (!reasonReady) bad.push("Say why the whole batch is being moved together.");
    if (draft.bulkAction === "allocate" && !draft.bulkDepartment) bad.push("Choose the desk they all go to.");
    if (draft.bulkAction === "priority" && !draft.bulkPriority) bad.push("Choose the rating they all get.");
    if ((draft.bulkAction === "tags_add" || draft.bulkAction === "tags_drop") && !draft.bulkTagIds.length)
      bad.push("Choose at least one label.");
    if (bad.length) { setPanelError(bad.join(" ")); return; }
    const j = await send("POST", "/tickets/bulk", {
      ids: picked, action: draft.bulkAction,
      departmentId: draft.bulkAction === "allocate" ? draft.bulkDepartment : null,
      priority: draft.bulkAction === "priority" ? draft.bulkPriority : undefined,
      tagIds: draft.bulkAction.startsWith("tags_") ? draft.bulkTagIds : undefined,
      reason: draft.reason.trim()
    });
    if (!j) return;
    setBulkLines((j.lines ?? []).map((l: BulkReceipt, i: number) => ({ ...l, done: i < j.applied })));
    const words: Record<string, string> = {
      allocate: "handed to " + (j.department?.name ?? "that desk"),
      escalate: "pushed up the chart",
      priority: `re-rated ${label(PRIORITIES, draft.bulkPriority)}`,
      tags_add: `labelled ${draft.bulkTagIds
        .map((id) => tags?.items.find((t) => t.id === id)?.name ?? "?").join(", ")}`,
      tags_drop: `unlabelled ${draft.bulkTagIds
        .map((id) => tags?.items.find((t) => t.id === id)?.name ?? "?").join(", ")}`
    };
    setNotice(`${j.asked} ticked, ${j.applied} ${words[j.action] ?? "moved"}. ${j.note}`
      + (j.department?.over_ceiling ? ` ${j.department.name} was already at its ceiling.` : ""));
    if (!j.refused.length) { setPanel(null); setPicked([]); }
    refresh(); loadTags(); loadBreaches();
  }

  // ---------- the two libraries ----------
  async function submitTag() {
    const name = draft.tagName.trim().toLowerCase();
    if (name.length < 2) { setPanelError("A label is two letters at least — it is what the queue reads."); return; }
    if (draft.tagColour && !/^#[0-9a-fA-F]{6}$/.test(draft.tagColour.trim())) {
      setPanelError("A colour is six hex digits like #7dd3fc, or leave it empty."); return;
    }
    const body = { name, colour: draft.tagColour.trim() || null, note: draft.tagNote.trim() || null };
    const j = panel?.tagId
      ? await send("PUT", `/ticket-tags/${panel.tagId}`, body)
      : await send("POST", "/ticket-tags", body);
    if (!j) return;
    setNotice(panel?.tagId
      ? `"${j.name}" is renamed. Every call already wearing it reads the new word.`
      : `"${j.name}" is on the office's list for ${j.live ?? 0} live call(s).`);
    setPanel(null); loadTags(); refresh();
  }

  async function submitTagRetire(t: Tag) {
    if (!reasonReady) { setPanelError("Say why the label is being retired — the register keeps the sentence."); return; }
    const j = await send("POST", `/ticket-tags/${t.id}/tombstone`, { reason: draft.reason.trim() });
    if (!j) return;
    setNotice(j.note);
    setPanel(null); loadTags(); refresh();
  }

  async function submitReply() {
    const bad: string[] = [];
    const slug = draft.replySlug.trim().toLowerCase();
    if (!panel?.replyId && !/^[a-z0-9_]{3,30}$/.test(slug))
      bad.push("A short name is 3 to 30 lowercase letters, numbers or underscores — it is what a "
        + "clerk types mid-call, so name the answer, not the mood.");
    if (draft.replyTitle.trim().length < 3) bad.push("The title in three letters or more.");
    if (draft.replyBodyEn.trim().length < 4) bad.push("The English words, four letters at least.");
    if (draft.replyBodySw.trim() && draft.replyBodySw.trim().length < 4)
      bad.push("Either write the KiSwahili half properly, or leave it empty and say so.");
    const invented = (text: string) => [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1])
      .filter((t) => !(replies?.tokens ?? ["name", "ref", "company", "department", "agent", "subject"]).includes(t));
    const holes = [...new Set([...invented(draft.replyBodyEn), ...invented(draft.replyBodySw)])];
    if (holes.length) bad.push(`Only these placeholders exist: ${replies?.tokens.join(", ")}. `
      + `Not understood: ${holes.map((h) => `{${h}}`).join(", ")}.`);
    if (bad.length) { setPanelError(bad.join(" ")); return; }
    const common = {
      title: draft.replyTitle.trim(), bodyEn: draft.replyBodyEn.trim(),
      bodySw: draft.replyBodySw.trim() || null, category: draft.replyCategory || null,
      note: draft.replyNote.trim() || null
    };
    const j = panel?.replyId
      ? await send("PUT", `/canned-replies/${panel.replyId}`, { ...common, isActive: draft.replyActive })
      : await send("POST", "/canned-replies", { ...common, slug });
    if (!j) return;
    setNotice(`"${j.title}" ${panel?.replyId ? "is rewritten" : "is on the office's list"}`
      + `${j.body_sw ? ", in both languages." : ", in English only — a caller who asks in "
        + "KiSwahili gets the English words and the desk is told."}`);
    setPanel(null); loadReplies();
  }

  async function submitReplyRetire(r: Reply) {
    if (!reasonReady) { setPanelError("Say why this answer is no longer what we tell callers."); return; }
    const j = await send("POST", `/canned-replies/${r.id}/tombstone`, { reason: draft.reason.trim() });
    if (!j) return;
    setNotice(`"${j.slug}" is retired. It is off every picker from now on and the register keeps it.`);
    setPanel(null); loadReplies();
  }

  /** Tell the desk heads their promises have run out. Nothing is stamped unless the provider
   *  took the message, so a send that failed leaves the line waiting for the next clerk. */
  async function submitNotify() {
    const j = await send("POST", "/tickets/breaches/notify", {
      department: breachDept || null, reason: draft.reason.trim()
    });
    if (!j) return;
    setReceipts(j.receipts ?? []);
    const failed = j.receipts.filter((r: any) => !r.delivered);
    setNotice(`${j.told} line(s) across ${j.desks} desk(s). ${j.note}`
      + (j.waiting ? ` ${j.waiting} overdue line(s) belong to no desk at all, so there is no head `
        + "to tell — hand them over first." : "")
      + (failed.length ? ` Not told: ${failed.map((r: any) =>
        `${r.department_name ?? "a desk"} (${r.error})`).join("; ")}` : ""));
    loadBreaches(breachDept || undefined); refresh();
  }

  /** The screen, as a file. Exported from the rows already read rather than from a new query:
   *  what a clerk downloads is what they were shown and argued with, on the filter they were
   *  standing on. The callback number is deliberately not in it — it lives on the incidence's
   *  own page for a seat that holds the duty, and never on a list row. */
  function exportCsv() {
    const rows = desk?.items ?? [];
    if (!rows.length) { setError("There is nothing on this screen to export."); return; }
    const head = ["Platform number", "Desk number", "Quoted by", "Day", "Channel", "Kind",
      "Rating", "State", "Subject", "Who rang", "Their email", "Company", "Desk",
      "Answer clock", "Answer due", "First answer", "Fix clock", "Fix due", "Settled",
      "Reopened", "Labels", "Files", "Lines", "Last touched"];
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const body = rows.map((t) => [
      t.ref, t.dept_ref ?? "", t.numbered_by_name ?? "", day(t.ts),
      label(CHANNELS, t.channel), label(CATEGORIES, t.category), label(PRIORITIES, t.priority),
      label(STATUSES, t.status), t.subject, t.reporter_name, t.reporter_email ?? "",
      t.company_name ?? "", t.department_name ?? "the queue",
      CLOCK_WORDS[t.response_state] ?? t.response_state, t.response_due_at ?? "",
      t.first_response_at ?? "", CLOCK_WORDS[t.resolution_state] ?? t.resolution_state,
      t.resolution_due_at ?? "", t.resolved_at ?? "", t.reopen_count,
      (t.tags ?? []).map((g) => g.name).join(" | "), t.files, t.events,
      t.last_activity ?? t.updated_at
    ].map(cell).join(","));
    const csv = [head.map(cell).join(","), ...[body]].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `waisha-register-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`${rows.length} line(s) of this screen written to a file. No callback numbers are in `
      + "it: a number is read on the incidence itself, by a seat that holds the duty.");
  }

  const reasonReady = draft.reason.trim().length >= 4;
  const deptName = (id: string | null | undefined) =>
    desk?.departments.find((d) => d.id === id)?.name ?? id ?? "—";
  /** Which desk a register line moved the incidence between. "the queue" is an answer to
   *  "who has it", so it is named instead of left blank; a line that moved nothing between
   *  desks — a note, a re-rate, work on the same desk — says nothing here. A rule and a desk
   *  above are not the same act as a clerk's hand-over, so they are not described as one. */
  const moveWords = (ev: EventLine) => {
    if (ev.action === "logged" || (!ev.department_from_id && !ev.department_to_id)) return "";
    const from = ev.department_from_id ? deptName(ev.department_from_id) : "the queue";
    const to = ev.department_to_id ? deptName(ev.department_to_id) : "the queue";
    if (from === to) return "";
    if (ev.action === "routed") return ` · the chart put it on ${to}`;
    if (ev.action === "escalated") return ` · ${from} could not answer, so it went up to ${to}`;
    return ` · ${from} → ${to}`;
  };

  const summary: Summary = desk?.summary ?? {
    n: 0, unallocated: 0, working: 0, settled: 0, folded: 0, pressing: 0,
    overdue: 0, unanswered: 0, no_clock: 0, unnumbered: 0, reopened: 0
  };
  // The first six count the register; the rest count the promises on it and the second attempts.
  // They are deliberately not merged into one number: "past a deadline" and "nobody set a
  // deadline" are different failures, and the desk has to be able to tell which one it is looking
  // at. `folded` is apart from `settled` because a folded line is not a call that was answered —
  // it is a call that was the same problem twice.
  const stats: [string | number, string, string?, string?][] = desk ? [
    [summary.n, `Written down in ${desk.window_days} days`,
      `CS numbers issued since ${desk.window_days} days ago, on this filter`],
    [summary.unallocated, "Nobody holds them", "Still in the queue — 101 will not let one be worked"],
    [summary.working, "With a department", "Allocated or being worked on"],
    [summary.pressing, "High or urgent and not finished", "The list to read first",
      summary.pressing ? "var(--danger)" : undefined],
    [summary.settled, "Settled", "Resolved or closed on this filter"],
    [summary.folded, "Folded into another call",
      "Duplicates: the line to work is the one they were folded into, not these",
      summary.folded ? "var(--gold)" : undefined],
    [summary.overdue, "Past a promise",
      "Never answered and past its answer minute, or past the fix date the desk gave",
      summary.overdue ? "var(--danger)" : undefined],
    [summary.unanswered, "Waiting for a first answer",
      "Nobody has written a human line on them yet, so the answer clock is still running",
      summary.unanswered ? "var(--warning)" : undefined],
    [summary.no_clock, "No deadline was set",
      "The holding desk promises no answer time, so nothing here can be called late — yet",
      summary.no_clock ? "var(--warning)" : undefined],
    [summary.unnumbered, "No desk number yet",
      "The caller holds the CS number; the desk has not quoted its own queue number for them",
      summary.unnumbered ? "var(--warning)" : undefined],
    [summary.reopened, "Rang back after being finished",
      "Settled once and put back into work — the first answer did not hold",
      summary.reopened ? "var(--danger)" : undefined]
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
              the desk that takes it adds one of its own, <code>BILLING-4</code>, which stays the call&apos;s
              name even after the work is pushed up the chart. Every move is written with the reason a
              person would defend out loud, and every desk&apos;s answer and fix promises run as two clocks
              against its own working week.
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
          {stats.map(([value, text, hint, tone]) => (
            <div key={text} className="rounded-card border p-14"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }} title={hint}>
              <p className="text-lg font-bold tabular-nums" style={{ color: tone ?? "var(--ink)" }}>{value}</p>
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
                <label className={`${labelText} min-w-[min(100%,240px)] flex-1 block`} style={{ color: "var(--ink-soft)" }}>
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
              {/* The language is not decoration: 123's routing rules can send a KiSwahili call to
                  a different desk, so what the clerk picks here decides who answers. */}
              <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                The call was made in
                <select value={draft.language} onChange={(e) => setDraft({ ...draft, language: e.target.value })}
                  className={box} style={boxStyle}>
                  {LANGUAGES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
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
          <section id="ticket-sheet" className="mt-24 rounded-card border p-20"
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
                  <div className="flex flex-wrap items-center justify-end gap-10">
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
                      <a href={`tel:${ticket.phone}`} className="rec-link mt-6 block text-sm font-semibold"
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
                      <a href={`mailto:${ticket.reporter_email}`} className="rec-link mt-6 block truncate text-xs"
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
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>
                      {ticket.department_id
                        ? (ticket.dept_ref
                          ? <>Quoted <strong>{ticket.dept_ref}</strong> by {ticket.numbered_by_name ?? ticket.department_name}
                            {ticket.numbered_by_name && ticket.numbered_by_name !== ticket.department_name
                              ? ` — the number came from the desk that first held it, and it is kept when the work moves.` : "."}</>
                          : <span style={{ color: "var(--warning)" }}>
                              That desk has not given it a queue number yet, so the caller can only quote {ticket.ref}.
                            </span>)
                        : "In the queue: no desk number and no clock until a department holds it."}
                    </p>
                  </div>

                  {/* The two clocks, the promises they were counted against, and the register's
                      own sentence about why a deadline is missing. A due minute shown without the
                      desk's week next to it is the number that gets argued with on the phone. */}
                  <div className="rounded-card border p-14" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      What it was promised
                    </p>
                    <div className="mt-6 flex flex-wrap gap-6">
                      <ClockChip which="Answer" state={ticket.response_state} />
                      <ClockChip which="Fix" state={ticket.resolution_state} />
                    </div>
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>
                      {ticket.department_name
                        ? `${ticket.department_name} promises: answer in ${clockWords(ticket.first_response_minutes)}, `
                          + `fix in ${clockWords(ticket.resolve_minutes)}.`
                        : "No desk holds it, so no promises have been counted against it."}
                    </p>
                    <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      Working week: {weekShort(ticket.business_hours)} ·{" "}
                      <span style={{ color: ticket.desk_is_open_now ? "var(--success)" : "var(--warning)" }}>
                        {ticket.desk_is_open_now ? "the desk is inside its hours now" : "the desk is outside its hours now"}
                      </span>
                    </p>
                    <ul className="mt-8 space-y-4 text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                      <li>Answer due {when(ticket.response_due_at)}
                        {ticket.first_response_at ? ` · first answered ${when(ticket.first_response_at)}` : " · nobody has answered yet"}</li>
                      <li>Fix due {when(ticket.resolution_due_at)}
                        {ticket.resolved_at ? ` · settled ${when(ticket.resolved_at)}` : " · not settled"}</li>
                    </ul>
                    {ticket.after_hours && (
                      <p className="mt-6 text-[11px]" style={{ color: "var(--warning)" }}>
                        Logged outside the desk&apos;s hours, so its clocks started when the desk opened, not when the phone rang.
                      </p>
                    )}
                    {sheetNote && (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--danger)" }}>
                        {sheetNote}
                      </p>
                    )}
                    {ticket.escalated_at && (
                      <p className="mt-6 text-[11px]" style={{ color: "var(--danger)" }}>
                        Escalated {when(ticket.escalated_at)}
                        {ticket.escalated_from_name ? ` from ${ticket.escalated_from_name}` : ""}
                        {" "}— the desk below it is on record as having failed to answer.
                      </p>
                    )}
                    {ticket.escalation_name && (
                      <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        Above this desk sits{" "}
                        <Link href={`/control/departments/${ticket.escalation_department_id}`}
                          className="underline" style={{ color: "var(--adm-accent)" }}>
                          {ticket.escalation_name}
                        </Link>
                        {" "}— where the work goes when this desk says it cannot answer.
                      </p>
                    )}
                  </div>

                  {/* The three things 125 put on a call: the words the office gave it, the paper
                      filed against it, and where it went if it was the same problem twice. All
                      three are read on this row, so a desk never has to open a second screen to
                      find out whether the line in front of it is still work. */}
                  <div className="rounded-card border p-14" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      Labels, paper and the fold
                    </p>
                    <div className="mt-6 flex flex-wrap gap-6">
                      {(ticket.tags ?? []).map((g) => (
                        <span key={g.id} className="rounded-input px-8 py-3 text-[10px] font-semibold"
                          style={{ border: `1px solid ${g.colour ?? "var(--line)"}`, color: g.colour ?? "var(--ink)" }}>
                          {g.name}
                        </span>
                      ))}
                      {!(ticket.tags ?? []).length && (
                        <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          No label on it yet — the queue has only the kind and the rating to sort by.
                        </p>
                      )}
                    </div>
                    <p className="mt-8 text-[11px]" style={{ color: ticket.files ? "var(--ink)" : "var(--ink-soft)" }}>
                      {ticket.files
                        ? `${ticket.files} file${ticket.files === 1 ? "" : "s"} of paper on it (JPEG, PNG, WebP or PDF, 8 MB each)`
                        : "No file on it — a screenshot or a document can be put on the call."}
                    </p>
                    {ticket.status === "merged" ? (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--gold)" }}>
                        This line is folded into{" "}
                        <button type="button" className="underline" style={{ color: "var(--adm-accent)" }}
                          onClick={() => ticket.merged_into_id && openTicket(ticket.merged_into_id)}>
                          {ticket.merged_into_ref}
                        </button>
                        {ticket.merged_into_status ? ` (${label(STATUSES, ticket.merged_into_status)})` : ""}
                        {ticket.merged_at ? ` since ${when(ticket.merged_at)}` : ""}
                        {ticket.merged_by_name ? `, by ${ticket.merged_by_name}` : ""}. Nothing can be
                        worked here — the answer goes on the line above.
                      </p>
                    ) : ticket.reopen_days !== null || ticket.reopen_count > 0 ? (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        {ticket.reopen_count > 0
                          ? `The caller rang back ${ticket.reopen_count} time(s)`
                          : "Nobody has had to ring back."}
                        {ticket.last_reopened_at ? ` — last on ${when(ticket.last_reopened_at)}.` : "."}
                        {ticket.reopen_days !== null
                          ? ` This desk lets a finished call come back for ${ticket.reopen_days} day(s) after it was settled; `
                          : " This desk never said how long a finished call may come back for, so "}
                        {ticket.reopen_days !== null ? "after that the register refuses it." : "the window is open at any age."}
                      </p>
                    ) : null}
                    <p className="mt-8 text-[11px]" style={{ color: ticket.breach_alerted_at ? "var(--danger)" : "var(--ink-soft)" }}>
                      {ticket.breach_alerted_at
                        ? `Its desk head was told it was past a promise on ${when(ticket.breach_alerted_at)}. `
                          + "A second notice waits twelve hours."
                        : "Nobody has been told this one is late."}
                      {ticket.department_head_name && !ticket.breach_alerted_at
                        ? ` The head to tell is ${ticket.department_head_name}.` : ""}
                    </p>
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
                    {/* The API decides whether this move is on the table at all: a call nobody
                        holds cannot be escalated, and a finished one must be reopened instead. */}
                    {canEscalate && (
                      <button type="button" onClick={() => openPanel({ kind: "escalate", ticketId: ticket.id, ticketRef: ticket.ref })}
                        className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                        style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
                        {ticket.escalation_name ? `Up to ${ticket.escalation_name}` : "Push it up the chart"}
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
                    {/* The three 125 moves that are not state changes: what was answered, what it
                        is called in the office's own words, and what paper proves it. A folded
                        line offers none of them — the register would refuse all three, and a
                        button that is known to be refused is a trap. */}
                    {ticket.status !== "merged" && (
                      <>
                        <button type="button"
                          onClick={() => openPanel({ kind: "answer", ticketId: ticket.id, ticketRef: ticket.ref },
                            { answerLanguage: ticket.language, answerChannel: ticket.channel })}
                          className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                          style={{ borderColor: "var(--success)", color: "var(--success)" }}>
                          Write what was answered
                        </button>
                        <button type="button" onClick={() => openPanel({ kind: "tags", ticketId: ticket.id, ticketRef: ticket.ref })}
                          className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                          style={{ borderColor: "var(--gold)", color: "var(--gold)" }}>
                          Label it
                        </button>
                        <button type="button" onClick={() => openPanel({ kind: "files", ticketId: ticket.id, ticketRef: ticket.ref })}
                          className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                          style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                          {ticket.files ? `Its paper (${ticket.files})` : "Put paper on it"}
                        </button>
                      </>
                    )}
                    {/* Anything that is not already folded can be folded — including a settled
                        duplicate, which is the common case: the same problem answered twice by
                        two desks. The keeper is where the answer goes from now on. */}
                    {ticket.status !== "merged" && (
                      <button type="button" onClick={() => openPanel({ kind: "merge", ticketId: ticket.id, ticketRef: ticket.ref })}
                        className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                        style={{ borderColor: "var(--gold)", color: "var(--gold)" }}>
                        It is the same call as another one
                      </button>
                    )}
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

                    {panel.kind === "escalate" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--danger)" }}>
                          {ticket.department_name} could not answer {ticket.ref}
                        </p>
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          This is not a quiet re-allocate: the register writes which desk gave up and when,
                          so the line is evidence about {ticket.department_name ?? "that desk"}. The number the
                          caller was quoted stays, and so do both deadlines — the desk above inherits the
                          time already lost.
                        </p>
                        {!ticket.escalation_department_id && (
                          <p className="mt-6 text-[11px]" style={{ color: "var(--warning)" }}>
                            Nothing is set above {ticket.department_name}
                            {" "}— pick the desk that should take it, or set an escalation target on{" "}
                            <Link href={`/control/departments/${ticket.department_id}`}
                              className="underline" style={{ color: "var(--adm-accent)" }}>its own terms</Link>.
                          </p>
                        )}
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Which desk takes it
                          <select value={draft.escalateTo || ticket.escalation_department_id || ""}
                            onChange={(e) => setDraft({ ...draft, escalateTo: e.target.value })}
                            className={box} style={boxStyle}>
                            <option value="">Use the desk named above {ticket.department_name}</option>
                            {(desk?.departments ?? [])
                              .filter((d) => d.id !== ticket.department_id)
                              .map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name} — {d.live_tickets}
                                  {d.max_open_tickets !== null ? ` of a ${d.max_open_tickets} ceiling` : " live"}
                                  {d.max_open_tickets !== null && d.live_tickets >= d.max_open_tickets
                                    ? " (already at its ceiling)" : ""}
                                  {d.desk_is_open_now ? "" : " · outside its hours"}
                                </option>
                              ))}
                          </select>
                        </label>
                        <p className="mt-6 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          A desk at its ceiling still takes an escalation — the ceiling stops a hand-over from
                          piling on, never a call that is going unanswered.
                        </p>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Why it goes up — say what this desk could not do
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="Billing cannot reach the customer's TIN; only the head office desk holds the tax keys."
                            className={box} style={boxStyle} />
                        </label>
                        <button type="button" disabled={busy || !reasonReady} onClick={submitEscalate}
                          className="mt-12 rounded-input px-14 py-6 text-xs font-semibold"
                          style={{ background: "var(--danger)", color: "#fff", border: "1px solid var(--danger)" }}>
                          Escalate it
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

                    {panel.kind === "merge" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--gold)" }}>
                          Which line stays — {ticket.ref} is folded onto it
                        </p>
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          Nothing is deleted and nothing is merged: {ticket.ref} keeps its number, its
                          subject and every line written on it, and stops being work. From now on the
                          answer goes on the keeper, which keeps its own desk number and its own two
                          deadlines. Search the register rather than guessing a number — the desk that
                          first took the call is usually the one to keep.
                        </p>
                        <div className="mt-12 flex flex-wrap items-end gap-10">
                          <label className={`${labelText} min-w-[min(100%,260px)] flex-1 block`} style={{ color: "var(--ink-soft)" }}>
                            Search by CS number, subject, who rang or the company
                            <input value={draft.mergeQuery}
                              onChange={(e) => setDraft({ ...draft, mergeQuery: e.target.value })}
                              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchMerge(draft.mergeQuery); } }}
                              placeholder="CS-2026-00039, or clearing agent login"
                              className={box} style={boxStyle} />
                          </label>
                          <button type="button" disabled={busy} onClick={() => searchMerge(draft.mergeQuery)}
                            className="rounded-input border px-14 py-8 text-xs font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                            Search a year back
                          </button>
                        </div>
                        {mergeHits && (
                          <div className="mt-12 space-y-8">
                            {mergeHits.map((h) => {
                              const chosen = draft.mergeInto === h.id;
                              return (
                                <button key={h.id} type="button"
                                  onClick={() => setDraft({ ...draft, mergeInto: h.id })}
                                  className="block w-full rounded-input border p-10 text-left"
                                  style={{
                                    borderColor: chosen ? "var(--gold)" : "var(--line)",
                                    background: chosen ? "color-mix(in srgb, var(--gold) 10%, transparent)" : "transparent"
                                  }}>
                                  <p className="text-[11px] font-bold tabular-nums" style={{ color: "var(--adm-accent)" }}>
                                    {h.ref}{h.dept_ref ? ` · ${h.dept_ref}` : ""}
                                    <span className="ml-8 font-normal" style={{ color: "var(--ink-soft)" }}>
                                      {label(STATUSES, h.status)} · {h.department_name ?? "the queue"} · {day(h.ts)}
                                    </span>
                                  </p>
                                  <p className="mt-4 text-sm" style={{ color: "var(--ink)" }}>{h.subject}</p>
                                  <p className="mt-2 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                                    {h.reporter_name}{h.company_name ? ` — ${h.company_name}` : ""}
                                    · {label(CHANNELS, h.channel)} · {chosen ? "this is the line to keep" : "tap to keep this one"}
                                  </p>
                                </button>
                              );
                            })}
                            {!mergeHits.length && (
                              <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                                Nothing else on the register matches that search. A call nobody else
                                wrote down is not a duplicate — work it on its own line.
                              </p>
                            )}
                          </div>
                        )}
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Why these two are the same call
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="Same clearing agent, same login fault, rang twice on the same morning."
                            className={box} style={boxStyle} />
                        </label>
                        <button type="button" disabled={busy || !reasonReady || !draft.mergeInto}
                          onClick={twoTap(`merge:${ticket.id}`, submitMerge)}
                          className="mt-12 rounded-input px-14 py-6 text-xs font-semibold"
                          style={{
                            border: "1px solid var(--gold)",
                            background: armed === `merge:${ticket.id}` ? "var(--gold)" : "transparent",
                            color: armed === `merge:${ticket.id}` ? "#1a1206" : "var(--gold)"
                          }}>
                          {armed === `merge:${ticket.id}`
                            ? "Tap again to fold it into the line above"
                            : draft.mergeInto ? "Fold it into that line" : "Choose the line that stays first"}
                        </button>
                      </>
                    )}

                    {panel.kind === "tags" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                          What {ticket.ref} is called in the office&apos;s own words
                        </p>
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          A label is how the desk sorts its own queue — &ldquo;port delay&rdquo;,
                          &ldquo;needs a supervisor&rdquo; — and the register will not invent one for
                          you. Taking a label off never deletes it: the call keeps the line saying it
                          wore it. Every act here needs a reason, because a queue that has been
                          relabelled without a reason cannot be explained afterwards.
                        </p>
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Say why first — it is written on the label line and on the audit
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="Cargo is held at the port, not at our end — keeping the list for the weekly port review."
                            className={box} style={boxStyle} />
                        </label>
                        <div className="mt-12">
                          <p className={`${labelText} font-semibold uppercase tracking-[0.12em]`} style={{ color: "var(--ink-soft)" }}>
                            On it now
                          </p>
                          <div className="mt-6 flex flex-wrap gap-8">
                            {(ticket.tags ?? []).map((g) => (
                              <button key={g.id} type="button" disabled={busy || !reasonReady}
                                onClick={() => submitTagOff(g.id)}
                                className="rounded-input px-10 py-5 text-[11px] font-semibold"
                                style={{ border: `1px solid ${g.colour ?? "var(--line)"}`,
                                  color: g.colour ?? "var(--ink)" }}>
                                {g.name} — take it off
                              </button>
                            ))}
                            {!(ticket.tags ?? []).length && (
                              <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                                Nothing on it yet.
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="mt-12">
                          <p className={`${labelText} font-semibold uppercase tracking-[0.12em]`} style={{ color: "var(--ink-soft)" }}>
                            The office&apos;s list — tap to put it on
                          </p>
                          <div className="mt-6 flex flex-wrap gap-8">
                            {(tags?.items ?? []).filter((g) => !(ticket.tags ?? []).some((w) => w.id === g.id))
                              .map((g) => (
                                <button key={g.id} type="button" disabled={busy || !reasonReady}
                                  onClick={() => submitTagOn(g.id)}
                                  className="rounded-input border px-10 py-5 text-[11px] font-semibold"
                                  style={{ borderColor: "var(--line)", color: g.colour ?? "var(--ink)" }}
                                  title={g.note ?? undefined}>
                                  + {g.name} · {g.live} live
                                </button>
                              ))}
                            {!(tags?.items ?? []).length && (
                              <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                                There is no label on the register yet — invent one in the label list
                                below; a word the office uses is worth writing once.
                              </p>
                            )}
                          </div>
                          <button type="button" onClick={() => openLibrary({ kind: "tag" })}
                            className="mt-10 rounded-input border px-12 py-6 text-[11px] font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                            A word the office needs is not on the list — make one
                          </button>
                        </div>
                      </>
                    )}

                    {panel.kind === "answer" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                          What was said back to {ticket.reporter_name}
                        </p>
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          This writes the answer onto the call and starts its answer clock; the
                          platform posts nothing. Say it down the phone, or send it from{" "}
                          {label(CHANNELS, ticket.channel)} yourself — the register records the words,
                          the language and the channel, and a later reader can tell what the caller
                          was actually told.
                        </p>
                        <div className="mt-12 grid gap-12"
                          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                          <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                            An answer the office already gives
                            <select value={draft.replyId}
                              onChange={(e) => setDraft({ ...draft, replyId: e.target.value })}
                              className={box} style={boxStyle}>
                              <option value="">Write it myself</option>
                              {/* A retired answer is off the picker: the register refuses to put one
                                  on a call, so listing it here would only be a 409 waiting to happen. */}
                              {(replies?.items ?? []).filter((r) => r.is_active).map((r) => (
                                <option key={r.id} value={r.id}>
                                  {r.title}{r.body_sw ? "" : " (English only)"}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                            In — the caller asked in {label(LANGUAGES, ticket.language)}
                            <select value={draft.answerLanguage}
                              onChange={(e) => setDraft({ ...draft, answerLanguage: e.target.value })}
                              className={box} style={boxStyle}>
                              {LANGUAGES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                          </label>
                          <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                            How it is being sent — it came in by {label(CHANNELS, ticket.channel)}
                            <select value={draft.answerChannel}
                              onChange={(e) => setDraft({ ...draft, answerChannel: e.target.value })}
                              className={box} style={boxStyle}>
                              <option value="">Same as the call</option>
                              {CHANNELS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                          </label>
                        </div>
                        {!draft.replyId && (
                          <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                            The words
                            <textarea value={draft.answerText} rows={4} maxLength={1200}
                              onChange={(e) => setDraft({ ...draft, answerText: e.target.value })}
                              placeholder="Tumeorodhesha wakiwa kwenye mfumo; anza upya kufuta posho."
                              className={box} style={boxStyle} />
                          </label>
                        )}
                        {!!draft.replyId && (
                          <p className="mt-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                            {(() => {
                              const r = (replies?.items ?? []).find((x) => x.id === draft.replyId);
                              if (!r) return "That answer is no longer on the list.";
                              const body = draft.answerLanguage === "sw" && r.body_sw ? r.body_sw : r.body_en;
                              return `The office's words: ${body.slice(0, 300)}${body.length > 300 ? "…" : ""}`;
                            })()}
                          </p>
                        )}
                        <div className="mt-12 flex flex-wrap gap-8">
                          <button type="button" disabled={busy} onClick={runPreview}
                            className="rounded-input border px-14 py-6 text-[11px] font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                            Preview it with this call&apos;s details
                          </button>
                          <button type="button" disabled={busy}
                            onClick={() => openLibrary({ kind: "canned" })}
                            className="rounded-input border px-14 py-6 text-[11px] font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                            Write a new answer for the office
                          </button>
                        </div>
                        {preview && (
                          <div className="mt-12 rounded-card border p-12"
                            style={{ borderColor: "var(--success)", background: "color-mix(in srgb, var(--success) 6%, transparent)" }}>
                            <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--success)" }}>
                              As the caller would be told — {label(LANGUAGES, preview.language)}
                              {preview.asked_for && preview.language !== preview.asked_for
                                ? ` (asked in ${label(LANGUAGES, preview.asked_for)})` : ""}
                            </p>
                            <p className="mt-6 whitespace-pre-line text-sm" style={{ color: "var(--ink)" }}>
                              {preview.text}
                            </p>
                            {!!preview.unfilled?.length && (
                              <p className="mt-6 text-[11px]" style={{ color: "var(--warning)" }}>
                                This call cannot fill {preview.unfilled.map((t: string) => `{${t}}`).join(", ")} —
                                the bracket stays out of the sentence, so write that part yourself before you send it.
                              </p>
                            )}
                            {preview.fell_back && (
                              <p className="mt-6 text-[11px]" style={{ color: "var(--warning)" }}>
                                There is no KiSwahili half of this answer, so the English words came
                                back. The office should write one.
                              </p>
                            )}
                          </div>
                        )}
                        <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                          Why this is the answer
                          <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                            placeholder="Confirmed on the phone that the code lands now; the OTP rule was the desk's own."
                            className={box} style={boxStyle} />
                        </label>
                        <button type="button" disabled={busy || !reasonReady
                          || (!draft.replyId && draft.answerText.trim().length < 4)}
                          onClick={submitAnswer}
                          className="waisha-btn mt-12 rounded-input px-14 py-6 text-xs font-semibold">
                          Write it on the line
                        </button>
                      </>
                    )}

                    {panel.kind === "files" && (
                      <>
                        <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                          The paper on {ticket.ref}
                        </p>
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          A screenshot of the error, the invoice they say they paid, the PDF the port
                          sent. Bytes are capped at 8 MB and a file is only taken as a real JPEG, PNG,
                          WebP or PDF — the register looks at the bytes, not the name. Taking a file
                          off hides it; the bytes and the line saying they were filed stay, because
                          evidence that can be unfiled is not evidence.
                        </p>
                        {files && !files.storage_configured && (
                          <p className="mt-10 text-[11px]" style={{ color: "var(--warning)" }}>
                            Storage is not configured on this platform, so paper cannot be filed yet.
                            The register still takes the call; the file waits.
                          </p>
                        )}
                        <div className="mt-12 space-y-8">
                          {(files?.items ?? []).map((doc) => (
                            <div key={doc.id} className="rounded-input border p-10"
                              style={{ borderColor: "var(--line)" }}>
                              <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>
                                {doc.file_name}
                                <span className="ml-8 font-normal" style={{ color: "var(--ink-soft)" }}>
                                  {doc.mime_type} · {Math.round(doc.size_bytes / 1024)} KB · {when(doc.created_at)}
                                  {doc.uploaded_by_name ? ` · put on it by ${doc.uploaded_by_name}` : ""}
                                </span>
                              </p>
                              <div className="mt-8 flex flex-wrap gap-8">
                                <button type="button" onClick={() => openFile(doc.id)}
                                  className="rounded-input border px-12 py-5 text-[11px] font-semibold"
                                  style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                                  Open it
                                </button>
                                <button type="button" disabled={busy || !reasonReady}
                                  onClick={twoTap(`file:${doc.id}`, () => submitFileRetire(doc.id))}
                                  className="rounded-input border px-12 py-5 text-[11px] font-semibold"
                                  style={{
                                    borderColor: "var(--danger)",
                                    color: armed === `file:${doc.id}` ? "#fff" : "var(--danger)",
                                    background: armed === `file:${doc.id}` ? "var(--danger)" : "transparent"
                                  }}>
                                  {armed === `file:${doc.id}` ? "Tap again to take it off" : "Take it off"}
                                </button>
                              </div>
                            </div>
                          ))}
                          {files && !(files?.items ?? []).length && (
                            <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              Nothing filed on this call.
                            </p>
                          )}
                        </div>
                        <div className="mt-12 grid gap-12"
                          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                          <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                            Choose the file
                            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf"
                              onChange={(e) => setPickedFile(e.target.files?.[0] ?? null)}
                              className={box} style={boxStyle} />
                          </label>
                          <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                            Why it belongs on this call
                            <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                              placeholder="The invoice they say was paid on 12 October, sent on WhatsApp."
                              className={box} style={boxStyle} />
                          </label>
                        </div>
                        {pickedFile && (
                          <p className="mt-8 text-[11px]" style={{ color: pickedFile.size > 8 * 1024 * 1024 ? "var(--danger)" : "var(--ink-soft)" }}>
                            {pickedFile.name} — {Math.round(pickedFile.size / 1024)} KB
                            {pickedFile.size > 8 * 1024 * 1024 ? " · over the 8 MB ceiling, the register will refuse it" : ""}
                          </p>
                        )}
                        <button type="button" disabled={busy || !pickedFile || !reasonReady}
                          onClick={submitFile}
                          className="waisha-btn mt-12 rounded-input px-14 py-6 text-xs font-semibold">
                          File it on {ticket.ref}
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
                          {ev.detail?.kept_number
                            ? ` · the caller kept the number ${String(ev.detail.kept_number)}` : ""}
                          {ev.detail?.over_ceiling
                            ? ` · onto a desk already at its ${String(ev.detail.ceiling ?? "—")} ceiling` : ""}
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
              ["allocated,in_progress", "With a department"],
              ["resolved,closed", "Settled"], ["merged", "Folded duplicates"]] as [string, string][])
              .map(([status, text]) => (
                <button key={text} type="button" onClick={() => patch({ status })}
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
              onClick={() => patch({ mine: f.mine ? "" : "1", department: "" })}
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
              <input value={f.q} onChange={(e) => patch({ q: e.target.value })}
                placeholder="CS-2026-00042, or Wema, or invoice" className={box} style={boxStyle} />
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Every call from one number — +255…
              <input value={f.phone} onChange={(e) => patch({ phone: e.target.value })}
                placeholder="+255717601440" inputMode="tel" className={box} style={boxStyle} />
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Department
              <select value={f.department} onChange={(e) => patch({ department: e.target.value })}
                className={box} style={boxStyle}>
                <option value="">Any desk</option>
                {(desk?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            {/* Both halves of 125's inbox are filters: how the call reached us and what the
                office chose to call it. A label is chosen from the register's own list, so a
                retired label cannot be picked and a typo cannot silently return nothing. */}
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              How it reached us
              <select value={f.channel} onChange={(e) => patch({ channel: e.target.value })}
                className={box} style={boxStyle}>
                <option value="">Any channel</option>
                {CHANNELS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Label
              <select value={f.tag} onChange={(e) => patch({ tag: e.target.value })}
                className={box} style={boxStyle}>
                <option value="">Any label</option>
                {(tags?.items ?? []).map((g) => (
                  <option key={g.id} value={g.id}>{g.name} — {g.live} live</option>
                ))}
              </select>
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Kind
              <select value={f.category} onChange={(e) => patch({ category: e.target.value })}
                className={box} style={boxStyle}>
                <option value="">Any kind</option>
                {CATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Rating
              <select value={f.priority} onChange={(e) => patch({ priority: e.target.value })}
                className={box} style={boxStyle}>
                <option value="">Any rating</option>
                {PRIORITIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Which clock
              <select value={f.clock} onChange={(e) => patch({ clock: e.target.value })}
                className={box} style={boxStyle}>
                {CLOCKS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              How far back
              <select value={f.days} onChange={(e) => patch({ days: e.target.value })}
                className={box} style={boxStyle}>
                {[["7", "7 days"], ["30", "30 days"], ["60", "60 days"], ["180", "6 months"], ["365", "a year"]]
                  .map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
            <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
              Rows
              <select value={f.limit} onChange={(e) => patch({ limit: e.target.value })}
                className={box} style={boxStyle}>
                {[["30", "30"], ["60", "60"], ["120", "120"], ["200", "200"]]
                  .map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
          </div>

          {(f.status || f.department || f.mine || f.category || f.priority || f.q || f.phone || f.company
            || f.clock || f.channel || f.tag || f.days !== EMPTY_FILTER.days) && (
            <div className="mt-12 flex flex-wrap items-center gap-8">
              <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                Filtered{f.phone.trim().length >= 7 ? " to one callback number" : ""}
                {f.company ? " to one company" : ""}
                {f.clock ? ` to "${label(CLOCKS, f.clock)}"` : ""}
                {f.channel ? ` to ${label(CHANNELS, f.channel).toLowerCase()}` : ""}
                {f.tag ? ` to the label "${tags?.items.find((g) => g.id === f.tag)?.name ?? "one"}"` : ""}
                {f.department ? " to one desk" : ""}.
              </p>
              {f.department && (
                <Link href={`/control/departments/${f.department}`}
                  className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                  That desk&apos;s own sheet
                </Link>
              )}
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
                <button key={d.id} type="button" onClick={() => patch({ department: d.id, mine: "" })}
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
                      <span className="text-lg font-bold tabular-nums"
                        style={{ color: d.overdue ? "var(--danger)" : "var(--ink-soft)" }}>
                        {d.overdue}
                      </span>
                      <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>past a promise</span>
                    </p>
                    <p className="flex items-baseline gap-6">
                      <span className="text-lg font-bold tabular-nums" style={{ color: "var(--ink-soft)" }}>
                        {d.settled}
                      </span>
                      <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>settled</span>
                    </p>
                  </div>
                  {/* What the desk promised and how full it is, read on the same card that hands
                      work to it. A ceiling is a warning, not a wall — the register keeps taking
                      calls over it, and the board has to say so out loud. */}
                  <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {d.first_response_minutes === null && d.resolve_minutes === null
                      ? "Sets no answer or fix time, so its calls carry no deadline."
                      : `Answers in ${clockWords(d.first_response_minutes)}, `
                        + `fixes in ${clockWords(d.resolve_minutes)}.`}
                  </p>
                  <p className="mt-4 text-[11px]" style={{ color: d.desk_is_open_now ? "var(--success)" : "var(--warning)" }}>
                    {d.desk_is_open_now ? "Open now" : "Outside its working week"}
                    {d.max_open_tickets !== null
                      ? ` · ${d.live_tickets} of ${d.max_open_tickets} ceiling`
                        + (d.live_tickets > d.max_open_tickets ? ", over by one" : "")
                      : ` · ${d.live_tickets} live, no ceiling set`}
                  </p>
                  {!!(d.no_clock || d.unnumbered) && (
                    <p className="mt-4 text-[11px]" style={{ color: "var(--warning)" }}>
                      {[d.no_clock ? `${d.no_clock} with no deadline` : null,
                        d.unnumbered ? `${d.unnumbered} without a desk number` : null]
                        .filter(Boolean).join(" · ")}
                    </p>
                  )}
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
          <div className="flex flex-wrap items-end justify-between gap-12">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              The register
            </h2>
            {/* One screen, one file. What is exported is the rows on this screen, so the words
                on the button say as much — a desk that wanted the whole year has to widen the
                filter first, and the sheet it downloads matches the one it argued from. */}
            {!!(desk?.items ?? []).length && (
              <button type="button" onClick={exportCsv}
                className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                Export this screen ({(desk?.items ?? []).length} rows) to CSV
              </button>
            )}
          </div>

          {/* Tick the rows, then one act for all of them. The bar is only on the page for a seat
              that can manage the register, and the ceiling is the API's: the fifty lines the
              register will move in one call, not the fifty the screen happens to show. */}
          {canManage && (
            <div className="mt-14 flex flex-wrap items-center gap-8 rounded-input border p-10"
              style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
              <p className="text-[11px] font-semibold" style={{ color: picked.length ? "var(--gold)" : "var(--ink-soft)" }}>
                {picked.length
                  ? `${picked.length} of ${(desk?.items ?? []).length} ticked${picked.length > 50 ? " — that is more than the register moves at once (50)" : ""}`
                  : `Tick rows to move them together (${(desk?.items ?? []).length} on this screen)`}
              </p>
              {!!(desk?.items ?? []).length && (
                <button type="button"
                  onClick={() => setPicked(picked.length === (desk?.items ?? []).length
                    ? [] : (desk?.items ?? []).map((t) => t.id))}
                  className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                  {picked.length === (desk?.items ?? []).length ? "Clear the ticks" : "Tick every row here"}
                </button>
              )}
              {picked.length > 0 && (
                <button type="button" onClick={() => openPanel({ kind: "bulk" })}
                  className="rounded-input px-12 py-6 text-[11px] font-semibold"
                  style={{
                    background: panel?.kind === "bulk" ? "transparent" : "var(--adm-accent-soft)",
                    border: "1px solid var(--adm-accent)", color: "var(--adm-accent)"
                  }}>
                  {panel?.kind === "bulk" ? "Close the batch form" : `Move ${picked.length} at once`}
                </button>
              )}
            </div>
          )}

          {/* One act, several times, and one sentence for the whole batch. The register answers
              every line by name — moved, or refused with the reason — because a batch that only
              says "ok" leaves the desk unable to tell which of its own calls went nowhere. */}
          {panel?.kind === "bulk" && (
            <div className="mt-14 rounded-card border p-16"
              style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
              <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                Move {picked.length} ticked call{picked.length === 1 ? "" : "s"} in one act
              </p>
              <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                The same reason is written on every line, so the register records one decision
                taken once — not fifty typed sentences. Nothing here can fold or settle a call:
                those are judgements about one problem, and the register will not take them in bulk.
              </p>
              {panelError && (
                <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
                  style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
                  {panelError}
                </div>
              )}
              <div className="mt-12 grid gap-12"
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  What to do to all of them
                  <select value={draft.bulkAction}
                    onChange={(e) => setDraft({ ...draft, bulkAction: e.target.value })}
                    className={box} style={boxStyle}>
                    <option value="allocate">Hand them to a desk</option>
                    <option value="escalate">Push them up the chart</option>
                    <option value="priority">Re-rate them</option>
                    <option value="tags_add">Give them a label</option>
                    <option value="tags_drop">Take a label off</option>
                  </select>
                </label>
                {draft.bulkAction === "allocate" && (
                  <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                    Which desk
                    <select value={draft.bulkDepartment}
                      onChange={(e) => setDraft({ ...draft, bulkDepartment: e.target.value })}
                      className={box} style={boxStyle}>
                      <option value="">Choose a desk</option>
                      {(desk?.departments ?? []).map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} — {d.working} working, {d.pressing} pressing
                          {d.max_open_tickets !== null ? `, ${d.live_tickets}/${d.max_open_tickets} ceiling` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {draft.bulkAction === "priority" && (
                  <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                    What rating they all get
                    <select value={draft.bulkPriority}
                      onChange={(e) => setDraft({ ...draft, bulkPriority: e.target.value })}
                      className={box} style={boxStyle}>
                      <option value="">Choose a rating</option>
                      {PRIORITIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                )}
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  Why the batch moves together — the sentence every line keeps
                  <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                    placeholder="All four are the same clearing agent's login, found in one sweep of the queue."
                    className={box} style={boxStyle} />
                </label>
              </div>

              {(draft.bulkAction === "tags_add" || draft.bulkAction === "tags_drop") && (
                <div className="mt-12">
                  <p className={`${labelText} font-semibold uppercase tracking-[0.12em]`} style={{ color: "var(--ink-soft)" }}>
                    Which labels — up to ten
                  </p>
                  <div className="mt-8 flex flex-wrap gap-8">
                    {(tags?.items ?? []).map((g) => {
                      const on = draft.bulkTagIds.includes(g.id);
                      return (
                        <button key={g.id} type="button"
                          onClick={() => setDraft({ ...draft, bulkTagIds: on
                            ? draft.bulkTagIds.filter((x) => x !== g.id)
                            : [...draft.bulkTagIds, g.id] })}
                          className="rounded-input border px-10 py-6 text-[11px] font-semibold"
                          style={{
                            borderColor: on ? "var(--gold)" : "var(--line)",
                            color: g.colour ?? (on ? "var(--gold)" : "var(--ink-soft)"),
                            background: on ? "color-mix(in srgb, var(--gold) 12%, transparent)" : "transparent"
                          }}>
                          {g.name} · {g.live} live
                        </button>
                      );
                    })}
                    {!(tags?.items ?? []).length && (
                      <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        The office has invented no labels yet — make one in the label list below.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {!!bulkLines?.length && (
                <div className="mt-14 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                        <th className="p-8">Number</th>
                        <th className="p-8">What the register did</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkLines.map((l) => (
                        <tr key={l.id}>
                          <td className="p-8 align-top tabular-nums" style={{ color: "var(--ink)" }}>
                            {l.ref ?? "not on this platform"}
                          </td>
                          <td className="p-8 align-top"
                            style={{ color: l.done ? "var(--success)" : "var(--warning)" }}>
                            {l.done ? "Done — " : "Left where it was — "}{l.note}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <button type="button" disabled={busy || !reasonReady || !picked.length || picked.length > 50}
                onClick={submitBulk}
                className="waisha-btn mt-12 rounded-input px-14 py-6 text-xs font-semibold">
                Do it to {picked.length} call{picked.length === 1 ? "" : "s"}
              </button>
            </div>
          )}

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
                    {canManage && <th className="p-12">
                      <span className="text-[10px] font-bold uppercase tracking-[0.1em]">Batch</span>
                    </th>}
                    <th className="p-12">Numbers it holds</th>
                    <th className="p-12">What they said</th>
                    <th className="p-12">Who rang</th>
                    <th className="p-12">Company</th>
                    <th className="p-12">Rating</th>
                    <th className="p-12">State</th>
                    <th className="p-12">Held by</th>
                    <th className="p-12">Its promises</th>
                    <th className="p-12">Last touched</th>
                  </tr>
                </thead>
                <tbody>
                  {(desk?.items ?? []).map((t, i) => (
                    <tr key={t.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                      {canManage && (
                        <td className="p-12 align-top">
                          <input type="checkbox" aria-label={`Tick ${t.ref} for a batch move`}
                            checked={picked.includes(t.id)}
                            onChange={() => setPicked(picked.includes(t.id)
                              ? picked.filter((x) => x !== t.id) : [...picked, t.id])}
                            className="h-16 w-16" style={{ accentColor: "var(--adm-accent)" }} />
                        </td>
                      )}
                      <td className="p-12 align-top">
                        <button type="button" onClick={() => openTicket(t.id)}
                          className="rec-link text-xs font-bold tabular-nums underline"
                          style={{ color: "var(--adm-accent)" }}
                          title={t.events ? `${t.events} line(s) on the register` : "No lines yet"}>
                          {t.ref}
                        </button>
                        {/* Two numbers ride on one call: the platform's, which the caller quotes
                            anywhere, and the desk's, which only means something at that desk.
                            A call that has not been given one is named, not left blank. */}
                        <p className="mt-4 text-[10px] font-semibold tabular-nums"
                          style={{ color: t.dept_ref ? "var(--ink)" : "var(--warning)" }}>
                          {t.dept_ref ?? "no desk number yet"}
                        </p>
                        {t.dept_ref && t.numbered_by_name && t.numbered_by_name !== t.department_name && (
                          <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            from {t.numbered_by_name}
                          </p>
                        )}
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
                          {label(CATEGORIES, t.category)} · {label(CHANNELS, t.channel)} · {label(LANGUAGES, t.language)}
                        </p>
                        {/* Labels are the office's own vocabulary, so they are shown in the colour
                            the office chose and tapping one filters the queue to it. A row with no
                            chip is not "unsorted" — it simply has not been given a word yet. */}
                        <div className="mt-6 flex flex-wrap gap-6">
                          {(t.tags ?? []).map((g) => (
                            <button key={g.id} type="button" onClick={() => patch({ tag: g.id })}
                              className="rounded-input px-6 py-2 text-[10px] font-semibold"
                              style={{
                                border: `1px solid ${g.colour ?? "var(--line)"}`,
                                color: g.colour ?? "var(--ink)",
                                background: g.colour
                                  ? "color-mix(in srgb, var(--gold) 8%, transparent)" : "transparent"
                              }}
                              title={`Filter the register to "${g.name}"`}>
                              {g.name}
                            </button>
                          ))}
                          {t.files > 0 && (
                            <button type="button" onClick={() => openTicket(t.id)}
                              className="rounded-input px-6 py-2 text-[10px] font-semibold"
                              style={{ border: "1px solid var(--line)", color: "var(--adm-accent)" }}
                              title="Open the call to read the paper filed on it">
                              {t.files} file{t.files === 1 ? "" : "s"}
                            </button>
                          )}
                        </div>
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
                            onClick={() => patch({ company: t.company_tenant_id!, q: "", phone: "" })}
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
                        {/* A folded line is not work, and the queue has to say where the work is
                            instead of leaving the desk to open it to find out. */}
                        {t.status === "merged" && t.merged_into_ref && (
                          <p className="mt-4 text-[10px]" style={{ color: "var(--gold)" }}>
                            answer {t.merged_into_ref} instead
                          </p>
                        )}
                        {t.reopen_count > 0 && (
                          <p className="mt-4 text-[10px]" style={{ color: "var(--danger)" }}>
                            rang back {t.reopen_count}×{t.last_reopened_at ? ` · ${when(t.last_reopened_at)}` : ""}
                          </p>
                        )}
                      </td>
                      <td className="p-12 align-top text-xs" style={{ color: t.department_name ? "var(--ink)" : "var(--warning)" }}>
                        {t.department_name ?? "the queue"}
                        {t.allocated_by_name && (
                          <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            by {t.allocated_by_name}
                          </p>
                        )}
                        {t.department_id && (
                          <Link href={`/control/departments/${t.department_id}`}
                            className="mt-4 block text-[10px] underline" style={{ color: "var(--adm-accent)" }}>
                            that desk&apos;s sheet
                          </Link>
                        )}
                      </td>
                      <td className="p-12 align-top">
                        <div className="flex flex-wrap gap-6">
                          <ClockChip which="Answer" state={t.response_state} />
                          <ClockChip which="Fix" state={t.resolution_state} />
                        </div>
                        <p className="mt-6 text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                          {[t.response_due_at ? `answer by ${when(t.response_due_at)}` : null,
                            t.resolution_due_at ? `fix by ${when(t.resolution_due_at)}` : null]
                            .filter(Boolean).join(" · ") || "no deadline was set"}
                        </p>
                        {t.first_response_at && (
                          <p className="text-[10px]" style={{ color: "var(--success)" }}>
                            first answered {when(t.first_response_at)}
                          </p>
                        )}
                        {t.after_hours && (
                          <p className="text-[10px]" style={{ color: "var(--warning)" }}>
                            logged out of hours — the clock waits for the desk to open
                          </p>
                        )}
                        {t.escalated_at && (
                          <p className="text-[10px]" style={{ color: "var(--danger)" }}>
                            pushed up {when(t.escalated_at)}
                            {t.escalated_from_name ? ` because ${t.escalated_from_name} could not answer` : ""}
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
          {/* The register counts every line on this filter, not the rows on the screen, so the
              desk can tell "this is the queue" from "this is the first sixty of it". */}
          {!!(desk?.items ?? []).length && (
            <div className="mt-14 flex flex-wrap items-center gap-8">
              <p className="text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                {Number(f.offset) + 1}–{Number(f.offset) + (desk?.items ?? []).length} of {summary.n}
                {" "}on this filter
              </p>
              <button type="button" disabled={Number(f.offset) === 0}
                onClick={() => step(-1)}
                className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                style={{
                  borderColor: "var(--line)", color: "var(--adm-accent)",
                  opacity: Number(f.offset) === 0 ? 0.45 : 1
                }}>
                Earlier rows
              </button>
              <button type="button" disabled={(desk?.items ?? []).length < Number(f.limit)}
                onClick={() => step(1)}
                className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                style={{
                  borderColor: "var(--line)", color: "var(--adm-accent)",
                  opacity: (desk?.items ?? []).length < Number(f.limit) ? 0.45 : 1
                }}>
                Next {f.limit} rows
              </button>
              {Number(f.offset) > 0 && (
                <button type="button" onClick={() => setF((prev) => ({ ...prev, offset: "0" }))}
                  className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  Back to the top of the queue
                </button>
              )}
            </div>
          )}
          <p className="mt-14 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            Urgent and unfinished rows print first, then the newest. A withdrawn incidence is off this list and
            still in the table; <Link href="/control/forensics" style={{ color: "var(--adm-accent)" }}>Forensics</Link>{" "}
            carries every write as <code>control.tickets.*</code>.
          </p>
          <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            “Past a deadline” counts only work still open: an answer never given and past its minute, or a fix
            date gone by. A settled call that missed one is not late — it is <code>missed it</code> on its own
            row, and the desk sheet keeps both. A grey “no clock set” is not a pass: it means the holding desk
            promised nothing, which is a decision somebody has to defend on Monday.
          </p>
        </section>

        {/* ---------------- the promises that ran out ---------------- */}
        <section id="breaches" className="mt-28">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
            When the promise ran out
          </h2>
          <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            Every deadline on this board is a desk&apos;s own — the answer time and the fix time it set for
            itself on the departments panel. Only work still open is counted. The twelve hours below is the
            register&apos;s rule rather than a habit: a head who was told about a line is not sent the same
            news again the same afternoon, and a send that failed stamps nothing.
          </p>
          {!breach && (
            <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the clocks…</p>
          )}
          {breach && (
            <>
              <div className="mt-14 grid gap-12"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(190px, 100%), 1fr))" }}>
                {([
                  [breach.overdue.breached, "Live calls past a promise",
                    `Held by ${breach.board.length} desk(s) with overdue work on them`,
                    breach.overdue.breached ? "var(--danger)" : undefined],
                  [breach.overdue.unanswered_over, "Never answered, past the minute",
                    "No human line has been written on them and the desk's answer time is gone by",
                    breach.overdue.unanswered_over ? "var(--danger)" : undefined],
                  [breach.overdue.unresolved_over, "Past the fix date",
                    "The desk's own finish promise is already behind it",
                    breach.overdue.unresolved_over ? "var(--danger)" : undefined],
                  [breach.overdue.unalerted, "Nobody has been told about them",
                    "Never alerted, or alerted more than twelve hours ago — this is the list a notice sends",
                    breach.overdue.unalerted ? "var(--warning)" : undefined],
                  [breach.overdue.unheld, "Past a promise with no desk at all",
                    "Handed to nobody, so no desk can be told — they need a hand-over, not a mail",
                    breach.overdue.unheld ? "var(--warning)" : undefined]
                ] as [number, string, string, string?][]).map(([value, text, hint, tone]) => (
                  <div key={text} className="rounded-card border p-14"
                    style={{ borderColor: "var(--line)", background: "var(--surface)" }} title={hint}>
                    <p className="text-lg font-bold tabular-nums" style={{ color: tone ?? "var(--ink)" }}>
                      {value}
                    </p>
                    <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em]"
                      style={{ color: "var(--ink-soft)" }}>{text}</p>
                  </div>
                ))}
                <div className="rounded-card border p-14"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}
                  title="The oldest overdue promise on the whole register, not on one desk">
                  <p className="text-lg font-bold tabular-nums"
                    style={{ color: breach.overdue.worst_overdue_since ? "var(--danger)" : "var(--ink-soft)" }}>
                    {breach.overdue.worst_overdue_since ? age(breach.overdue.worst_overdue_since) : "—"}
                  </p>
                  <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em]"
                    style={{ color: "var(--ink-soft)" }}>How long the worst has been overdue</p>
                  <p className="mt-2 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {breach.overdue.worst_overdue_since
                      ? `past its promise since ${when(breach.overdue.worst_overdue_since)}`
                      : "Nothing is overdue."}
                  </p>
                </div>
              </div>

              {!!breach.unheld.n && (
                <p className="mt-12 text-[11px]" style={{ color: "var(--warning)" }}>
                  {`${breach.unheld.n} call(s) are in the queue with nobody holding them`}
                  {breach.unheld.oldest_since
                    ? `, the oldest written down on ${when(breach.unheld.oldest_since)}` : ""}
                  {breach.unheld.waiting_over_a_day
                    ? `, and ${breach.unheld.waiting_over_a_day} of them have waited over a day` : ""}
                  {". They cannot be overdue in the register's terms — with no desk, nothing was promised. "
                    + "That is exactly how a call falls between two offices, so hand them over."}
                </p>
              )}

              {!breach.mail_configured && breach.note && (
                <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
                  style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                    borderLeft: "4px solid var(--warning)" }}>
                  {breach.note}
                </div>
              )}

              {/* The per-desk cards always show the whole chart — the board is one read of every desk.
                  What the choice scopes is the list of lines and the notice itself, which is what the
                  register's own `department` parameter decides. */}
              <div className="mt-16 flex flex-wrap items-end gap-10">
                <label className={`${labelText} min-w-[min(100%,280px)] flex-1 block`} style={{ color: "var(--ink-soft)" }}>
                  Scope the notice and the line list to one desk
                  <select value={breachDept}
                    onChange={(e) => {
                      setBreachDept(e.target.value);
                      loadBreaches(e.target.value || undefined);
                    }}
                    className={box} style={boxStyle}>
                    <option value="">Every desk at once</option>
                    {(desk?.departments ?? []).map((d) => (
                      <option key={d.id} value={d.id}>{d.name} ({d.key})</option>
                    ))}
                  </select>
                </label>
                <button type="button" disabled={busy} onClick={() => loadBreaches(breachDept || undefined)}
                  className="rounded-input border px-14 py-8 text-xs font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                  Read the clocks again
                </button>
                {!!breachDept && (
                  <button type="button" onClick={() => patch({ department: breachDept, mine: "" })}
                    className="rounded-input border px-14 py-8 text-xs font-semibold"
                    style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                    Show that desk&apos;s lines on the register
                  </button>
                )}
                {breach.can_manage && (
                  <button type="button" onClick={() => openPanel({ kind: "notify" })}
                    className="rounded-input px-14 py-8 text-xs font-semibold"
                    style={{
                      background: panel?.kind === "notify" ? "transparent" : "var(--adm-accent-soft)",
                      border: "1px solid var(--danger)", color: "var(--danger)"
                    }}>
                    {panel?.kind === "notify" ? "Close the notice form" : "Tell the desk heads"}
                  </button>
                )}
              </div>

              {!!breach.board.length && (
                <div className="mt-14 grid gap-12"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(290px, 100%), 1fr))" }}>
                  {breach.board.map((d) => (
                    <div key={d.department_id} className="rounded-card border p-14"
                      style={{
                        borderColor: "var(--line)", background: "var(--surface)",
                        borderLeft: `4px solid ${d.unalerted ? "var(--danger)" : "var(--warning)"}`
                      }}>
                      <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{d.department_name}</p>
                      <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em]"
                        style={{ color: "var(--adm-accent)" }}>{d.department_key}</p>
                      <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>
                        {`${d.breached} line(s) past a promise — ${d.unanswered_over} never answered, `
                          + `${d.unresolved_over} past the fix date.`}
                      </p>
                      <p className="mt-4 text-[11px]"
                        style={{ color: d.unalerted ? "var(--danger)" : "var(--success)" }}>
                        {d.unalerted
                          ? `${d.unalerted} of them have gone twelve hours without a head being told.`
                          : "Every one of them was told about within the last twelve hours."}
                      </p>
                      <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        {d.worst_overdue_since
                          ? `Its worst line has been overdue since ${when(d.worst_overdue_since)}.`
                          : "—"}
                      </p>
                      <p className="mt-4 text-[11px]"
                        style={{ color: d.head_name ? "var(--ink-soft)" : "var(--warning)" }}>
                        {d.head_name
                          ? `The head to tell is ${d.head_name}.`
                          : "No head is named on the chart, so a notice has nowhere to go. Name one on the departments panel."}
                      </p>
                      <p className="mt-2 text-[11px]"
                        style={{ color: d.last_alerted_at ? "var(--ink-soft)" : "var(--danger)" }}>
                        {d.last_alerted_at ? `Last told ${when(d.last_alerted_at)}.`
                          : "Nobody has ever been told this desk is late."}
                      </p>
                      <div className="mt-10 flex flex-wrap gap-8">
                        <button type="button" onClick={() => patch({ department: d.department_id, mine: "" })}
                          className="rounded-input border px-10 py-5 text-[10px] font-semibold"
                          style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                          Its lines on the register
                        </button>
                        <button type="button"
                          onClick={() => {
                            setBreachDept(d.department_id);
                            loadBreaches(d.department_id);
                          }}
                          className="rounded-input border px-10 py-5 text-[10px] font-semibold"
                          style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                          Scope the notice to this desk
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!breach.board.length && (
                <p className="mt-14 text-sm" style={{ color: "var(--success)" }}>
                  No desk is past one of its own promises right now — nothing to tell anybody.
                </p>
              )}

              <div className="mt-24">
                <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                  {`${breach.waiting.length} line(s) a notice would go out about`}
                  {breach.waiting_total > breach.waiting.length
                    ? ` — the first ${breach.waiting.length} of ${breach.waiting_total}` : ""}
                </p>
                <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  This is the same twelve-hour test the button runs, so what is listed here is exactly the
                  list the heads are sent{breachDept ? " for the desk you scoped to" : ""}. Tap a number to
                  open the call itself.
                </p>
                {!breach.waiting.length && (
                  <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>
                    {breach.overdue.breached
                      ? "Every overdue line has been told about within twelve hours, so this press would send "
                        + "nothing. The work is still owed — it is the notice that is waiting."
                      : "Nothing is overdue, so there is nothing to tell."}
                  </p>
                )}
                {!!breach.waiting.length && (
                  <div className="mt-10 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                          <th className="p-8">Number</th>
                          <th className="p-8">Subject</th>
                          <th className="p-8">Who holds it</th>
                          <th className="p-8">The promise it is past</th>
                          <th className="p-8">Told</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breach.waiting.map((l, i) => (
                          <tr key={l.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                            <td className="p-8 align-top">
                              <button type="button" onClick={() => openTicket(l.id)}
                                className="rec-link text-xs font-bold tabular-nums underline"
                                style={{ color: "var(--adm-accent)" }}>{l.ref}</button>
                              <p className="mt-4 text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                                {l.dept_ref ?? "no desk number"}
                              </p>
                            </td>
                            <td className="p-8 align-top" style={{ color: "var(--ink)", maxWidth: 320 }}>
                              {l.subject}
                              <p className="mt-2 text-[10px] uppercase tracking-[0.1em]"
                                style={{ color: "var(--ink-soft)" }}>
                                {`${label(PRIORITIES, l.priority)} · ${label(CHANNELS, l.channel)}`}
                                {l.company_name ? ` · ${l.company_name}` : ""}
                              </p>
                            </td>
                            <td className="p-8 align-top" style={{ color: l.department_id ? "var(--ink-soft)" : "var(--warning)" }}>
                              {l.department_id ? deptName(l.department_id) : "nobody holds it"}
                            </td>
                            <td className="p-8 align-top" style={{ color: "var(--danger)" }}>
                              {!l.first_response_at && l.response_due_at && (
                                <p>{`answer due ${when(l.response_due_at)}`}</p>
                              )}
                              {l.resolution_due_at && <p>{`fix due ${when(l.resolution_due_at)}`}</p>}
                            </td>
                            <td className="p-8 align-top" style={{ color: "var(--ink-soft)" }}>
                              {l.breach_alerted_at ? `told ${when(l.breach_alerted_at)}` : "never told"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {panel && panel.kind === "notify" && (
                <div className="mt-16 rounded-card border p-16"
                  style={{ borderColor: "var(--danger)", background: "var(--surface)" }}>
                  <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--danger)" }}>
                    Tell the desk heads their promises have run out
                  </p>
                  <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    One mail per desk, listing the calls that desk owes, through the platform&apos;s own mail
                    register — so the send leaves a line in the delivery log like every other message here.
                    {breachDept
                      ? " This press is scoped to the one desk you chose above."
                      : " This press goes to every desk with overdue lines that has a named head."}
                    Nothing is stamped unless the provider took the message: a failed send leaves the line
                    waiting for the next clerk instead of quietly looking told.
                  </p>
                  {!breach.mail_configured && (
                    <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>
                      No mail transport is configured, so this press cannot send and will stamp nothing. The
                      board above is still true — it is the notice that cannot happen.
                    </p>
                  )}
                  {panelError && (
                    <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
                      style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                        borderLeft: "4px solid var(--warning)" }}>
                      {panelError}
                    </div>
                  )}
                  <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                    Why the office is telling them now — written on every alert line and on the audit
                    <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                      placeholder="Weekly SLA review: three desks are past their own fix dates and nobody had been told."
                      className={box} style={boxStyle} />
                  </label>
                  <button type="button" disabled={busy || !reasonReady || !breach.waiting.length}
                    onClick={twoTap("notify", submitNotify)}
                    className="mt-12 rounded-input px-14 py-6 text-xs font-semibold"
                    style={{
                      border: "1px solid var(--danger)",
                      background: armed === "notify" ? "var(--danger)" : "transparent",
                      color: armed === "notify" ? "#fff" : "var(--danger)"
                    }}>
                    {armed === "notify" ? "Tap again to send the notice"
                      : !breach.waiting.length ? "Nothing is past its twelve hours"
                        : breachDept ? "Tell that desk's head" : "Tell every desk head"}
                  </button>

                  {!!receipts?.length && (
                    <div className="mt-14 overflow-x-auto">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em]"
                        style={{ color: "var(--ink-soft)" }}>
                        The register&apos;s answer, desk by desk
                      </p>
                      <table className="mt-8 w-full text-xs">
                        <thead>
                          <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                            <th className="p-8">Desk</th>
                            <th className="p-8">Head</th>
                            <th className="p-8">Lines</th>
                            <th className="p-8">What happened</th>
                          </tr>
                        </thead>
                        <tbody>
                          {receipts.map((r: any) => (
                            <tr key={`${r.department_id}-${r.head ?? "none"}`}>
                              <td className="p-8 align-top" style={{ color: "var(--ink)" }}>
                                {r.department_name ?? "a desk with no name"}
                              </td>
                              <td className="p-8 align-top" style={{ color: "var(--ink-soft)" }}>
                                {r.head ?? "none named"}
                              </td>
                              <td className="p-8 align-top tabular-nums" style={{ color: "var(--ink)" }}>
                                {r.lines}
                              </td>
                              <td className="p-8 align-top"
                                style={{ color: r.delivered ? "var(--success)" : "var(--danger)" }}>
                                {r.delivered
                                  ? `Told — ${r.stamped} line(s) stamped as alerted${r.provider_message_id
                                    ? `, provider message ${r.provider_message_id}` : ""}`
                                    + `${r.attempts > 1 ? ` after ${r.attempts} attempts` : ""}.`
                                  : `Not told — ${r.error}`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        A stamped line is not raised again for twelve hours. The lines under “Not told” are
                        still waiting for whoever presses this next — the board above is re-read, so the
                        numbers on it are after this send, not before it.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {/* ---------------- the labels the office invented ---------------- */}
        <section id="ticket-tags" className="mt-28">
          <div className="flex flex-wrap items-end justify-between gap-12">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              The office&apos;s own labels
            </h2>
            {(tags?.can_manage ?? canManage) && (
              <button type="button" onClick={() => openLibrary({ kind: "tag" })}
                className="rounded-input px-12 py-6 text-[11px] font-semibold"
                style={{
                  background: panel?.kind === "tag" && !panel.tagId ? "transparent" : "var(--adm-accent-soft)",
                  border: "1px solid var(--gold)", color: "var(--gold)"
                }}>
                {panel?.kind === "tag" && !panel.tagId ? "Close the new label" : "Make a new label"}
              </button>
            )}
          </div>
          <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            A label is neither a category nor a desk — it is the word the office uses for itself
            (&ldquo;port delay&rdquo;, &ldquo;needs a supervisor&rdquo;), and the register will not invent
            one. Retiring a label here takes it off the picker; it does not unlabel the calls that wore it,
            because the tagging is history. Ten labels is the ceiling on a batch move.
          </p>
          {libError && (
            <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                borderLeft: "4px solid var(--warning)" }}>
              {libError}
            </div>
          )}
          {!tags && !libError && (
            <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the label list…</p>
          )}
          {!!tags && !tags.items.length && !panel && (
            <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>
              The office has invented no labels yet. Nothing is wrong with the queue because of that — but
              the first time two clerks need the same word for the same problem, it is worth writing it once
              here instead of twice in the subject lines.
            </p>
          )}
          {!!(tags?.items ?? []).length && (
            <div className="mt-14 grid gap-12"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(260px, 100%), 1fr))" }}>
              {tags!.items.map((g) => (
                <div key={g.id} className="rounded-card border p-14"
                  style={{ borderColor: "var(--line)", background: "var(--surface)",
                    borderLeft: `4px solid ${g.colour ?? "var(--line)"}` }}>
                  <p className="text-sm font-bold" style={{ color: g.colour ?? "var(--ink)" }}>{g.name}</p>
                  <p className="mt-6 text-[11px] tabular-nums" style={{ color: "var(--ink)" }}>
                    {`${g.live} live call(s) wear it`}
                    {g.tagged > g.live ? `, ${g.tagged - g.live} more on lines that were folded or withdrawn` : ""}
                  </p>
                  <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {g.note ?? "No note — the word is all the office has written about what it means."}
                  </p>
                  <div className="mt-10 flex flex-wrap gap-8">
                    <button type="button" onClick={() => patch({ tag: g.id })}
                      className="rounded-input border px-10 py-5 text-[10px] font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--adm-accent)" }}>
                      Its queue
                    </button>
                    {f.tag === g.id && (
                      <button type="button" onClick={() => patch({ tag: "" })}
                        className="rounded-input border px-10 py-5 text-[10px] font-semibold"
                        style={{ borderColor: "var(--adm-accent)", color: "var(--adm-accent)" }}>
                        Stop filtering by it
                      </button>
                    )}
                    {(tags?.can_manage ?? canManage) && (
                      <button type="button"
                        onClick={() => openLibrary({ kind: "tag", tagId: g.id },
                          { tagName: g.name, tagColour: g.colour ?? "", tagNote: g.note ?? "" })}
                        className="rounded-input border px-10 py-5 text-[10px] font-semibold"
                        style={{ borderColor: "var(--line)", color: "var(--gold)" }}>
                        {panel?.kind === "tag" && panel.tagId === g.id ? "Close it" : "Change the word"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {panel && panel.kind === "tag" && (
            <div className="mt-14 rounded-card border p-16"
              style={{ borderColor: "var(--gold)", background: "var(--surface)" }}>
              <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--gold)" }}>
                {panel.tagId ? "Change a word the whole list already uses" : "A word the office needs"}
              </p>
              <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {panel.tagId
                  ? "Renaming it rewrites every call already wearing it, live and folded alike — the word is "
                    + "the key the filter reads, so this is a decision about the list, not about one call."
                  : "Two to twenty-eight characters, lowercase: letters, numbers and spaces, dots, underscores, "
                    + "plus and minus. It is read in a table cell, so keep it short and keep it true."}
              </p>
              {panelError && (
                <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
                  style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                    borderLeft: "4px solid var(--warning)" }}>
                  {panelError}
                </div>
              )}
              <div className="mt-12 grid gap-12"
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  The word
                  <input value={draft.tagName}
                    onChange={(e) => setDraft({ ...draft, tagName: e.target.value })}
                    placeholder="port delay" className={box} style={boxStyle} />
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  Its colour — six hex digits, or nothing
                  <input value={draft.tagColour}
                    onChange={(e) => setDraft({ ...draft, tagColour: e.target.value })}
                    placeholder="#f0b429" className={box} style={boxStyle} />
                </label>
              </div>
              <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {/^#[0-9a-fA-F]{6}$/.test(draft.tagColour.trim())
                  ? (
                    <span className="inline-flex items-center gap-8">
                      <span className="inline-block h-12 w-12 rounded-input border"
                        style={{ background: draft.tagColour.trim(), borderColor: "var(--line)" }} />
                      {"This is how the chip will read in the queue."}
                    </span>
                  )
                  : "No colour is not a failure — the chip simply reads in the desk's own ink."}
              </p>
              <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                What the office means by it — 160 characters, and every clerk who taps it reads this
                <textarea value={draft.tagNote} rows={3} maxLength={160}
                  onChange={(e) => setDraft({ ...draft, tagNote: e.target.value })}
                  placeholder="Cargo is held at the port, not at our end. Use it for the weekly port review, not for a customs paper fault."
                  className={box} style={boxStyle} />
                <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {`${draft.tagNote.trim().length} of 160 characters.`}
                </span>
              </label>
              <div className="mt-12 flex gap-12">
                <button type="button" disabled={busy || draft.tagName.trim().length < 2}
                  onClick={submitTag}
                  className="waisha-btn rounded-input px-14 py-6 text-xs font-semibold">
                  {panel.tagId ? "Rewrite the word" : "Put it on the list"}
                </button>
                <button type="button" onClick={() => setPanel(null)}
                  className="rounded-input border px-14 py-6 text-xs font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  Cancel
                </button>
              </div>

              {panel.tagId && (() => {
                const g = (tags?.items ?? []).find((x) => x.id === panel.tagId);
                if (!g) return null;
                return (
                  <div className="mt-16 border-t pt-14" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em]"
                      style={{ color: "var(--danger)" }}>
                      {`Take "${g.name}" off the office's list`}
                    </p>
                    <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      {`${g.live} live call(s) wear it now. Retiring the label leaves them wearing it and keeps `
                        + "every line saying they did — a word the office stops using is history, not a deletion. "
                        + "Taking it off a call is done on that call, one at a time."}
                    </p>
                    <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                      Why the word is being retired — the register keeps the sentence
                      <input value={draft.reason}
                        onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                        placeholder="We say 'port hold' in every review now; two words for one problem splits the filter."
                        className={box} style={boxStyle} />
                    </label>
                    <button type="button" disabled={busy || !reasonReady}
                      onClick={twoTap(`retire-tag:${g.id}`, () => submitTagRetire(g))}
                      className="mt-12 rounded-input px-14 py-6 text-xs font-semibold"
                      style={{
                        border: "1px solid var(--danger)",
                        background: armed === `retire-tag:${g.id}` ? "var(--danger)" : "transparent",
                        color: armed === `retire-tag:${g.id}` ? "#fff" : "var(--danger)"
                      }}>
                      {armed === `retire-tag:${g.id}` ? "Tap again to retire it" : "Retire the label"}
                    </button>
                  </div>
                );
              })()}
            </div>
          )}
        </section>

        {/* ---------------- the answers the office gives ---------------- */}
        <section id="canned-replies" className="mt-28">
          <div className="flex flex-wrap items-end justify-between gap-12">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              The answers the office gives callers
            </h2>
            {(replies?.can_manage ?? canManage) && (
              <button type="button" onClick={() => openLibrary({ kind: "canned" })}
                className="rounded-input px-12 py-6 text-[11px] font-semibold"
                style={{
                  background: panel?.kind === "canned" && !panel.replyId
                    ? "transparent" : "var(--adm-accent-soft)",
                  border: "1px solid var(--adm-accent)", color: "var(--adm-accent)"
                }}>
                {panel?.kind === "canned" && !panel.replyId ? "Close the new answer" : "Write a new answer"}
              </button>
            )}
          </div>
          <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            These are the words a clerk says down the phone or types into the channel the call came in on.
            The platform posts nothing: 112 has no support-reply purpose, so an answer is recorded on the
            call and said by the human holding it. A caller who asks in KiSwahili and gets an English-only
            answer is told so on the panel, and the office is asked to write the other half.
          </p>
          <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            {"The register fills these in from the call you preview against: "}
            {(replies?.tokens ?? []).map((t) => `{${t}}`).join(", ") || "{name}, {ref}"}
            {". Anything else in braces is refused by this form and by the table, so a half-written "
              + "placeholder never reaches a caller."}
          </p>
          {libError && (
            <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                borderLeft: "4px solid var(--warning)" }}>
              {libError}
            </div>
          )}
          {!replies && !libError && (
            <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the answer library…</p>
          )}
          {!!replies && !replies.items.length && panel?.kind !== "canned" && (
            <p className="mt-10 text-sm" style={{ color: "var(--ink-soft)" }}>
              Nothing is written down yet, so every clerk is inventing the answer on the call. The three you
              give most often — a login reset, a clearance wait, a payment that has not landed — are worth
              writing once.
            </p>
          )}
          {!!(replies?.items ?? []).length && (
            <div className="mt-14 space-y-12">
              {replies!.items.map((r) => (
                <div key={r.id} className="rounded-card border p-14"
                  style={{
                    borderColor: "var(--line)", background: "var(--surface)",
                    borderLeft: `4px solid ${r.is_active ? "var(--adm-accent)" : "var(--ink-soft)"}`,
                    opacity: r.is_active ? 1 : 0.62
                  }}>
                  <div className="flex flex-wrap items-start justify-between gap-12">
                    <div className="min-w-0">
                      <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{r.title}</p>
                      <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em]"
                        style={{ color: "var(--adm-accent)" }}>
                        {`${r.slug}${r.category ? ` · ${label(CATEGORIES, r.category)}` : ""}`
                          + ` · ${r.body_sw ? "English and KiSwahili" : "English only"}`}
                      </p>
                    </div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em]"
                      style={{ color: r.is_active ? "var(--success)" : "var(--ink-soft)" }}>
                      {r.is_active ? "in use" : "retired — off every picker"}
                    </p>
                  </div>
                  <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>{clip(r.body_en)}</p>
                  {r.body_sw && (
                    <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>{clip(r.body_sw)}</p>
                  )}
                  <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {r.note ?? "No note about when to give this answer."}
                  </p>
                  <p className="mt-4 text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {`Last written by ${r.updated_by_name ?? "a seat that is no longer on the register"} · `
                      + `${when(r.updated_at)}`}
                  </p>
                  <div className="mt-10 flex flex-wrap gap-8">
                    {ticket && r.is_active && (
                      <button type="button"
                        onClick={() => {
                          openPanel({ kind: "answer", ticketId: ticket.id, ticketRef: ticket.ref },
                            { answerLanguage: ticket.language, answerChannel: ticket.channel, replyId: r.id });
                          jumpTo("ticket-sheet");
                        }}
                        className="rounded-input border px-10 py-5 text-[10px] font-semibold"
                        style={{ borderColor: "var(--adm-accent)", color: "var(--adm-accent)" }}>
                        {`Answer ${ticket.ref} with this`}
                      </button>
                    )}
                    {(replies?.can_manage ?? canManage) && (
                      <button type="button"
                        onClick={() => openLibrary({ kind: "canned", replyId: r.id }, {
                          replySlug: r.slug, replyTitle: r.title, replyBodyEn: r.body_en,
                          replyBodySw: r.body_sw ?? "", replyCategory: r.category ?? "",
                          replyActive: r.is_active, replyNote: r.note ?? ""
                        })}
                        className="rounded-input border px-10 py-5 text-[10px] font-semibold"
                        style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                        {panel?.kind === "canned" && panel.replyId === r.id
                          ? "Close this one" : "Rewrite it"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {panel && panel.kind === "canned" && (
            <div className="mt-14 rounded-card border p-16"
              style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
              <p className="text-xs font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                {panel.replyId ? "Rewrite the words the office gives" : "An answer worth writing once"}
              </p>
              <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {panel.replyId
                  ? "Every picker shows the new words from now on. Calls already answered keep what they were "
                    + "told — the answer is on the line, not a pointer at this row."
                  : "Write it the way you would say it: the caller's name and their number are filled in by the "
                    + "register, so you do not type them twice and a clerk does not miss them out."}
              </p>
              {panelError && (
                <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
                  style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)",
                    borderLeft: "4px solid var(--warning)" }}>
                  {panelError}
                </div>
              )}
              <div className="mt-12 grid gap-12"
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  {panel.replyId ? "Its short name — it does not change" : "Its short name — what a clerk types mid-call"}
                  <input value={draft.replySlug} disabled={!!panel.replyId}
                    onChange={(e) => setDraft({ ...draft, replySlug: e.target.value })}
                    placeholder="clearing_agent_login" className={box}
                    style={panel.replyId ? { ...boxStyle, opacity: 0.6 } : boxStyle} />
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  The title the picker shows
                  <input value={draft.replyTitle}
                    onChange={(e) => setDraft({ ...draft, replyTitle: e.target.value })}
                    placeholder="Clearing agent cannot open the cargo file" className={box} style={boxStyle} />
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  Which kind of call it is for
                  <select value={draft.replyCategory}
                    onChange={(e) => setDraft({ ...draft, replyCategory: e.target.value })}
                    className={box} style={boxStyle}>
                    <option value="">No kind — any call may use it</option>
                    {CATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
              </div>
              <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                The English words
                <textarea value={draft.replyBodyEn} rows={4} maxLength={1200}
                  onChange={(e) => setDraft({ ...draft, replyBodyEn: e.target.value })}
                  placeholder="Hello {name}, your call {ref} is with {department}. Please sign out of {company} and in again — the clearing agent role only loads on a fresh session."
                  className={box} style={boxStyle} />
                <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {`${draft.replyBodyEn.trim().length} of 1200 characters — four is the floor.`}
                </span>
              </label>
              <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                The KiSwahili words — or leave it empty and know the cost
                <textarea value={draft.replyBodySw} rows={4} maxLength={1200}
                  onChange={(e) => setDraft({ ...draft, replyBodySw: e.target.value })}
                  placeholder="Habari {name}, simu yako {ref} iko kwa {department}. Tafadhali tokka kwenye {company} kisha ingia tena."
                  className={box} style={boxStyle} />
                <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {`${draft.replyBodySw.trim().length} of 1200 characters. `}
                  {draft.replyBodySw.trim()
                    ? "Both halves are filled, so a caller who asks in either language is answered in it."
                    : "Without it, a caller who asked in KiSwahili is handed the English words and the desk is told."}
                </span>
              </label>
              <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                When to give it, in the office&apos;s own words — 240 characters
                <textarea value={draft.replyNote} rows={2} maxLength={240}
                  onChange={(e) => setDraft({ ...draft, replyNote: e.target.value })}
                  placeholder="Only when the file opens for the director and errors for the agent; anything else is a paper fault."
                  className={box} style={boxStyle} />
              </label>
              {panel.replyId && (
                <label className="mt-12 flex items-center gap-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  <input type="checkbox" checked={draft.replyActive}
                    onChange={(e) => setDraft({ ...draft, replyActive: e.target.checked })}
                    className="h-16 w-16" style={{ accentColor: "var(--adm-accent)" }} />
                  {"Still what we tell callers — uncheck it and every picker drops it from now on."}
                </label>
              )}
              <div className="mt-12 flex gap-12">
                <button type="button" disabled={busy} onClick={submitReply}
                  className="waisha-btn rounded-input px-14 py-6 text-xs font-semibold">
                  {panel.replyId ? "Rewrite the answer" : "Put it on the list"}
                </button>
                <button type="button" onClick={() => setPanel(null)}
                  className="rounded-input border px-14 py-6 text-xs font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  Cancel
                </button>
              </div>

              {panel.replyId && (() => {
                const r = (replies?.items ?? []).find((x) => x.id === panel.replyId);
                if (!r) return null;
                return (
                  <div className="mt-16 border-t pt-14" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em]"
                      style={{ color: "var(--danger)" }}>
                      {`Retire "${r.title}"`}
                    </p>
                    <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      "Retired" and "deleted" are not the same thing here: the words stop being offered on
                      every call, the row and every answer already given from it stay on the register. A
                      retired answer can be put back to work by ticking it again.
                    </p>
                    <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                      Why this is no longer what we tell callers — the register keeps the sentence
                      <input value={draft.reason}
                        onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                        placeholder="The clearing agent role was fixed in September; telling callers to re-sign is no longer the answer."
                        className={box} style={boxStyle} />
                    </label>
                    <button type="button" disabled={busy || !reasonReady || !r.is_active}
                      onClick={twoTap(`retire-reply:${r.id}`, () => submitReplyRetire(r))}
                      className="mt-12 rounded-input px-14 py-6 text-xs font-semibold"
                      style={{
                        border: "1px solid var(--danger)",
                        background: armed === `retire-reply:${r.id}` ? "var(--danger)" : "transparent",
                        color: armed === `retire-reply:${r.id}` ? "#fff" : "var(--danger)"
                      }}>
                      {armed === `retire-reply:${r.id}` ? "Tap again to retire it"
                        : !r.is_active ? "It is already off every picker" : "Retire the answer"}
                    </button>
                  </div>
                );
              })()}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
