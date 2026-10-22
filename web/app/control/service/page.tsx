"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The Service desk (126; task #341) — what the office does after the call has been settled.
 *
 * `/control/tickets` is the call itself: who rang, which desk holds it, when it was answered.
 * This desk is the four registers that sit behind it — a dispute a caller can be quoted a number
 * for, the satisfaction question asked once the work is finished, a mark on how a seat handled
 * the call, and a refund paper that this desk cannot pay out by itself.
 *
 * Every rule the desk obeys is the table's, not this page's. A finding needs a paper filed under
 * it, a settled figure has to be the paper's figure, a mark is worked out of six ticks and cannot
 * contradict them, a question cannot be asked about a call that is still open, an answer is given
 * once. So the buttons ask for the sentence the register wants and then say what the register
 * answered — including when it refused, which is shown in its own words rather than translated
 * into a generic "something went wrong".
 *
 * Money is the one thing this desk deliberately cannot finish. Proposing a signature is here,
 * refusing one is here, releasing it is not: that is the second seat pressing "sign" on
 * `/control/approvals`, and a panel that could both write and release a refund would be the
 * thing the office's two-person rule exists to prevent.
 */

// The vocabulary is the API's (control-service.routes.ts). A word the route does not accept is a
// 400 with a field list, so these are mirrors of the register, not preferences.
const GROUNDS: [string, string][] = [
  ["wrong_advice", "Wrong advice given"], ["missed_promise", "A promise was missed"],
  ["unanswered_call", "Nobody came back"], ["fee_dispute", "A fee is disputed"],
  ["overcharge", "Charged too much"], ["lost_paperwork", "Paperwork lost"],
  ["discourtesy", "Uncourteous handling"], ["other", "Something else"]
];
const DISPUTE_STATES: [string, string][] = [
  ["open", "Open"], ["investigating", "Being looked into"], ["upheld", "Upheld"],
  ["rejected", "Rejected"], ["settled", "Settled"], ["withdrawn", "Withdrawn"]
];
/** The four moves that end the argument, and so need the finding written down. */
const DECIDED = ["upheld", "rejected", "settled", "withdrawn"];
/**
 * The acts this desk cannot take back: a finding that closes a dispute, a paper taken off a file,
 * a word written on somebody else's money or somebody else's mark. The button asks for these
 * twice, because there is no undo on the other side of them and one stray click on a register is
 * a line an auditor has to be told about.
 */
const ARMS: Panel["kind"][] = ["move", "retire", "decline", "void", "withdraw"];
const armKey = (p: Panel) => `${p.kind}:${p.id ?? ""}:${p.docId ?? ""}`;
const PAPER_STATES: [string, string][] = [
  ["raised", "Raised, not asked yet"], ["pending_signature", "Waiting on a second seat"],
  ["released", "Signed and released"], ["declined", "Refused"], ["void", "Voided after release"]
];
const PAY_BACK: [string, string][] = [
  ["original_channel", "Back the way it came"], ["mpesa", "M-Pesa"], ["telwa", "Tigo Pesa"],
  ["airtel", "Airtel Money"], ["bank", "Into a bank account"], ["credit_note", "As a credit note"]
];
const CURRENCIES = ["TZS", "USD"];
const ASK_WAYS: [string, string][] = [
  ["phone_call", "On the phone"], ["whatsapp", "On WhatsApp"], ["email", "By email"],
  ["walk_in", "Face to face"], ["other", "Some other way"]
];
/** How the caller reached the register (101's channel list). Wider than the five ways a question
 *  can be asked, because a mark can be given on a chat line as easily as on a phone call. */
const CALL_WAYS: [string, string][] = [
  ["phone_call", "Phone call"], ["whatsapp", "WhatsApp"], ["email", "Email"],
  ["walk_in", "Walked in"], ["portal_message", "Portal message"], ["chat", "Live chat"],
  ["web_form", "Web form"], ["other", "Something else"]
];
const CALL_STATES: [string, string][] = [
  ["open", "In the queue"], ["allocated", "Handed over"], ["in_progress", "Being worked on"],
  ["resolved", "Resolved"], ["closed", "Closed"], ["merged", "Folded into another call"]
];
const RESULTS: [string, string][] = [
  ["met", "Met the promise"], ["partly_met", "Partly met"], ["below", "Below the promise"]
];
/** The six things the office says a good call does — in the order a clerk reads them. */
const SIX: [string, string][] = [
  ["answered_the_caller", "Answered the caller"], ["identity_confirmed", "Confirmed who was calling"],
  ["right_desk", "Was the right desk"], ["action_offered", "Offered an action"],
  ["words_suitable", "Used suitable words"], ["settled_with_answer", "Settled it with an answer"]
];
const ACTIONS: [string, string][] = [
  ["opened", "Written into the register"], ["status_changed", "State changed"],
  ["decided", "Decided, with a finding"], ["note", "A line was added"],
  ["paper_filed", "A paper was filed"], ["paper_retired", "A paper was taken off"],
  ["refund_raised", "A refund paper was raised"]
];

const label = (list: [string, string][], key: string | null | undefined) =>
  list.find(([k]) => k === key)?.[1] ?? key ?? "—";


const DISPUTE_EDGE: Record<string, string> = {
  open: "var(--warning)", investigating: "var(--adm-accent)", upheld: "var(--success)",
  rejected: "var(--ink-soft)", settled: "var(--gold)", withdrawn: "var(--ink-soft)"
};
const PAPER_EDGE: Record<string, string> = {
  raised: "var(--adm-accent)", pending_signature: "var(--warning)", released: "var(--success)",
  declined: "var(--danger)", void: "var(--ink-soft)"
};
const RESULT_EDGE: Record<string, string> = {
  met: "var(--success)", partly_met: "var(--warning)", below: "var(--danger)"
};
const EVENT_EDGE: Record<string, string> = {
  opened: "var(--adm-accent)", status_changed: "var(--warning)", decided: "var(--success)",
  note: "var(--ink-soft)", paper_filed: "var(--adm-accent)", paper_retired: "var(--danger)",
  refund_raised: "var(--gold)"
};

const when = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const day = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—";
/** numeric(14,2) comes back as a decimal string, so it is formatted, never added up here. */
const cash = (v: string | number | null | undefined, cur?: string | null) =>
  v === null || v === undefined || v === "" ? "—"
    : `${new Intl.NumberFormat("en-GB").format(Number(v))}${cur ? ` ${cur}` : ""}`;
const size = (bytes: number | null | undefined) => !bytes ? "—"
  : bytes > 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const age = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 0)} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h`;
  const d = Math.round(mins / 1440);
  return d < 30 ? `${d} d` : `${Math.round(d / 30)} mo`;
};

type CallRow = {
  id: string; ref: string; subject: string; status: string; channel: string;
  company_name: string | null; dept_ref: string | null; ts: string;
  disputes?: number; asked?: number; marks?: number; resolved_at?: string | null;
};
type DisputeRow = {
  id: string; ref: string; ground: string; claim: string; amount: string | null;
  currency: string | null; status: string; outcome: string | null; ticket_id: string;
  ticket_ref: string; company_name: string | null; opened_at: string;
  decided_at: string | null; refund_request_id: string | null; opened_name: string | null;
  decided_name: string | null; refund_ref: string | null; refund_status: string | null;
  papers: number | null; lines: number | null; total?: number;
};
type DisputeCounts = {
  total: number; open: number; investigating: number; upheld: number; rejected: number;
  settled: number; withdrawn: number; awaiting_paper: number; awaiting_refund: number;
  claimed_tzs: string; claimed_usd: string;
};
type DisputeSheet = DisputeRow & {
  company_tenant_id: string | null; ticket_subject: string | null;
  ticket_channel: string | null; ticket_dept_ref: string | null;
  ticket_status: string | null; ticket_resolved_at: string | null;
  department_name: string | null; refund_amount: string | null; refund_currency: string | null;
  refund_pay_back: string | null;
  files: { id: string; file_name: string; mime_type: string; size_bytes: number;
    created_at: string; uploaded_name: string | null }[];
  papers: { id: string; ref: string; amount: string; currency: string; pay_back: string;
    request_status: string; raised_at: string; raised_name: string | null }[];
  events: { id: string; ts: string; action: string; from_label: string | null;
    to_label: string | null; reason: string | null; actor_name: string | null }[];
};
type PaperRow = {
  id: string; ref: string; amount: string; currency: string; pay_back: string;
  reason: string; request_status: string; ticket_id: string; ticket_ref: string;
  dispute_id: string | null; company_name: string | null; raised_name: string | null;
  raised_at: string; approval_id: string | null; approval_status: string | null;
  approval_proposed_name: string | null; approval_expires_at: string | null;
  signed_name: string | null; signed_at: string | null; released_name: string | null;
  released_at: string | null; declined_note: string | null; void_note: string | null;
  payload_sha256: string | null; total?: number;
};
type PaperCounts = {
  raised: number; awaiting: number; released: number; declined: number; void: number;
  released_tzs: string; released_usd: string; total: number;
};
type PaperSheet = {
  id: string; ref: string; amount: string; currency: string; pay_back: string; reason: string;
  status: string; ticket_id: string; ticket_ref: string; dispute_id: string | null;
  dispute_ref: string | null; dispute_status: string | null; company_name: string | null;
  raised_name: string | null; raised_at: string; approval_id: string | null;
  released_at: string | null; released_name: string | null; declined_name: string | null;
  declined_note: string | null; void_note: string | null;
  signature: PaperRow | null;
};
type CsRow = {
  id: string; ticket_id: string; ticket_ref: string; asked_at: string; asked_channel: string;
  answered_at: string | null; score: number | null; word: string | null;
  recommends: boolean | null; asked_name: string | null; ticket_status: string | null;
  company_name: string | null; ticket_subject: string | null; total?: number;
};
type CsCounts = {
  asked: number; answered: number; unanswered: number; mean: string; happy: number;
  unhappy: number; would_recommend: number; with_words: number;
};
type MarkRow = {
  id: string; ticket_id: string; ticket_ref: string; checks: Record<string, boolean>;
  score: number; result: string; note: string | null; agent_response: string | null;
  responded_at: string | null; withdrawn_at: string | null; reviewed_at: string;
  reviewed_seat: string; reviewed_by: string; seat_name: string | null;
  reviewer_name: string | null; company_name: string | null; ticket_dept_ref: string | null;
  total?: number;
};
type MarkCounts = {
  live: number; met: number; partly: number; below: number; answered: number;
  withdrawn: number; mean: string;
};
type SeatMark = {
  seat_id: string; seat_name: string | null; marks: number; mean: string; met: number;
  below: number; answered: number; last_mark: string | null;
};
type Board = {
  disputes?: Record<string, any>; satisfaction?: Record<string, any>;
  quality?: Record<string, any>; refunds?: Record<string, any>; clock?: string;
};

type Tab = "disputes" | "refunds" | "satisfaction" | "quality";
const TABS: [Tab, string][] = [
  ["disputes", "Disputes"], ["refunds", "Refund papers"],
  ["satisfaction", "Satisfaction"], ["quality", "Quality marks"]
];

/** One draft for every form on the desk, so a sentence typed for one dispute can never land on
 *  another one because the last panel left its box full. */
type Draft = {
  callQuery: string; callId: string; ground: string; claim: string; amount: string;
  currency: string; reason: string; to: string; outcome: string; payBack: string;
  note: string; askedChannel: string; score: string; word: string; recommends: string;
  seat: string; checks: Record<string, boolean>; result: string; response: string;
  decline: string; file: File | null;
};
const EMPTY_DRAFT: Draft = {
  callQuery: "", callId: "", ground: "wrong_advice", claim: "", amount: "", currency: "TZS",
  reason: "", to: "investigating", outcome: "", payBack: "original_channel", note: "",
  askedChannel: "phone_call", score: "", word: "", recommends: "", seat: "",
  checks: Object.fromEntries(SIX.map(([k]) => [k, false])) as Record<string, boolean>,
  result: "met", response: "", decline: "", file: null
};
type Panel = {
  kind: "dispute" | "move" | "note" | "papers" | "retire" | "dispute_refund" | "refund"
    | "propose" | "decline" | "void" | "ask" | "answer" | "grade" | "respond" | "withdraw";
  id?: string; ref?: string; docId?: string; fileName?: string; seatId?: string;
  seatName?: string | null; mine?: boolean;
};

const box = "mt-4 w-full rounded-input border px-10 py-8 text-sm";
const boxStyle = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" };
const labelText = "text-[11px]";
const headBtn = "min-h-[36px] rounded-input border px-14 py-8 text-xs font-semibold disabled:opacity-40";
const chip = "whitespace-nowrap rounded-input px-8 py-2 text-[10px] font-semibold";
/** 126's own ceiling on a paper, named here only so the desk can say it before the write refuses. */
const MAX_PAPER_BYTES = 8 * 1024 * 1024;

/** A refusal the register wrote for the person at the desk, printed in its own words. */
function errorMessage(j: any, fallback: string) {
  const m = j?.error?.message;
  if (typeof m === "string" && m.trim()) return m;
  const first = j?.error?.details?.[0];
  if (first?.field) return `${first.field}: ${j?.error?.message ?? "the register refused it"}`;
  return fallback;
}

export default function ControlServicePage() {
  const [me, setMe] = useState<any>(null);
  const [perms, setPerms] = useState<string[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);

  const [board, setBoard] = useState<Board | null>(null);
  const [tab, setTab] = useState<Tab>("disputes");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);

  const [dRows, setDRows] = useState<DisputeRow[]>([]);
  const [dCounts, setDCounts] = useState<DisputeCounts | null>(null);
  const [dFilter, setDFilter] = useState({ status: "", ground: "", q: "", limit: "30", offset: "0" });
  const [sheet, setSheet] = useState<DisputeSheet | null>(null);

  const [pRows, setPRows] = useState<PaperRow[]>([]);
  const [pCounts, setPCounts] = useState<PaperCounts | null>(null);
  const [pFilter, setPFilter] = useState({ status: "", q: "", limit: "30", offset: "0" });
  const [paper, setPaper] = useState<PaperSheet | null>(null);

  const [cRows, setCRows] = useState<CsRow[]>([]);
  const [cCounts, setCCounts] = useState<CsCounts | null>(null);
  const [cFilter, setCFilter] = useState({ state: "", q: "", limit: "30", offset: "0" });

  const [mRows, setMRows] = useState<MarkRow[]>([]);
  const [mCounts, setMCounts] = useState<MarkCounts | null>(null);
  const [seatMarks, setSeatMarks] = useState<SeatMark[]>([]);
  const [mFilter, setMFilter] = useState({ result: "", seat: "", q: "", limit: "30", offset: "0" });

  const [calls, setCalls] = useState<CallRow[] | null>(null);
  const [callBusy, setCallBusy] = useState(false);
  const [seats, setSeats] = useState<{ id: string; full_name: string; roles: string[] }[]>([]);
  const [exporting, setExporting] = useState(false);

  const seq = useRef(0);

  const canView = perms.includes("control.service.view");
  const canManage = perms.includes("control.service.manage");
  const canReview = perms.includes("control.service.review");
  const canPay = perms.includes("control.payments.manage");
  const canDecide = perms.includes("control.approvals.decide");

  // ---------- reads ----------
  const loadBoard = useCallback(async () => {
    const res = await fetch(`${API}/api/v1/control/service/board`, { credentials: "include" });
    if (!res.ok) return;
    setBoard(await res.json());
  }, []);

  /** The four registers are four tabs but one page, so a filter change only re-reads the tab the
   *  operator is standing on. Reading all four on every keystroke would be four rate-limited
   *  calls to answer one question. */
  const load = useCallback(async (which: Tab, key: number) => {
    const at = (r: Response) => {
      if (key !== seq.current) return false;
      if (r.status === 401) { window.location.href = "/control/login"; return true; }
      if (r.status === 403) { setForbidden(true); return true; }
      return false;
    };
    const p = new URLSearchParams();
    if (which === "disputes") {
      if (dFilter.status) p.set("status", dFilter.status);
      if (dFilter.ground) p.set("ground", dFilter.ground);
      if (dFilter.q.trim()) p.set("search", dFilter.q.trim());
      p.set("limit", dFilter.limit); p.set("offset", dFilter.offset);
      const res = await fetch(`${API}/api/v1/control/service/disputes?${p}`, { credentials: "include" });
      if (at(res)) return;
      if (!res.ok) { setError(errorMessage(await res.json(), "The dispute register did not answer.")); return; }
      const j = await res.json();
      if (key !== seq.current) return;
      setDRows(j.rows ?? []); setDCounts(j.counts ?? null); setError(null);
      return;
    }
    if (which === "refunds") {
      if (pFilter.status) p.set("status", pFilter.status);
      if (pFilter.q.trim()) p.set("search", pFilter.q.trim());
      p.set("limit", pFilter.limit); p.set("offset", pFilter.offset);
      const res = await fetch(`${API}/api/v1/control/service/refunds?${p}`, { credentials: "include" });
      if (at(res)) return;
      if (!res.ok) { setError(errorMessage(await res.json(), "The paper register did not answer.")); return; }
      const j = await res.json();
      if (key !== seq.current) return;
      setPRows(j.rows ?? []); setPCounts(j.counts ?? null); setError(null);
      return;
    }
    if (which === "satisfaction") {
      if (cFilter.state) p.set("state", cFilter.state);
      if (cFilter.q.trim()) p.set("search", cFilter.q.trim());
      p.set("limit", cFilter.limit); p.set("offset", cFilter.offset);
      const res = await fetch(`${API}/api/v1/control/service/satisfaction?${p}`, { credentials: "include" });
      if (at(res)) return;
      if (!res.ok) { setError(errorMessage(await res.json(), "The satisfaction register did not answer.")); return; }
      const j = await res.json();
      if (key !== seq.current) return;
      setCRows(j.rows ?? []); setCCounts(j.counts ?? null); setError(null);
      return;
    }
    if (mFilter.result) p.set("result", mFilter.result);
    if (mFilter.seat) p.set("seat", mFilter.seat);
    if (mFilter.q.trim()) p.set("search", mFilter.q.trim());
    p.set("limit", mFilter.limit); p.set("offset", mFilter.offset);
    const res = await fetch(`${API}/api/v1/control/service/quality?${p}`, { credentials: "include" });
    if (at(res)) return;
    if (!res.ok) { setError(errorMessage(await res.json(), "The quality register did not answer.")); return; }
    const j = await res.json();
    if (key !== seq.current) return;
    setMRows(j.rows ?? []); setMCounts(j.counts ?? null); setSeatMarks(j.seats ?? []); setError(null);
  }, [dFilter, pFilter, cFilter, mFilter]);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const p = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (p.ok) setPerms((await p.json()).permissions ?? []);
    })();
    loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    if (!canView) return;
    const key = ++seq.current;
    const t = setTimeout(() => { load(tab, key); }, 260);
    return () => clearTimeout(t);
  }, [tab, canView, load]);

  // The seat picker belongs to a mark, so it is only asked for by a desk that can write one.
  useEffect(() => {
    if (!canReview || tab !== "quality" || seats.length) return;
    (async () => {
      const res = await fetch(`${API}/api/v1/control/service/seats`, { credentials: "include" });
      if (res.ok) setSeats((await res.json()).rows ?? []);
    })();
  }, [canReview, tab, seats.length]);

  const refresh = useCallback(() => {
    const key = ++seq.current;
    load(tab, key);
    loadBoard();
  }, [tab, load, loadBoard]);

  // ---------- the call a paper stands on ----------
  const searchCalls = useCallback(async (term: string) => {
    setCallBusy(true);
    setCalls(null);
    try {
      const p = new URLSearchParams();
      if (term.trim()) p.set("search", term.trim());
      const res = await fetch(`${API}/api/v1/control/service/calls?${p}`, { credentials: "include" });
      if (!res.ok) {
        setPanelError(errorMessage(await res.json(), "The call register did not answer."));
        return;
      }
      setCalls((await res.json()).rows ?? []);
    } finally { setCallBusy(false); }
  }, []);

  /** A dispute, a question, a mark and a paper all start from the same place: an incidence on the
   *  register. The row is picked rather than typed, because 126 copies the company and the
   *  incidence number off the call and a desk that could name a company itself would name the
   *  wrong one. */
  const pickCall = (c: CallRow) => {
    setDraft((d) => ({ ...d, callId: c.id }));
    setPanelError(null);
  };

  // ---------- one dispute ----------
  const openDispute = useCallback(async (id: string) => {
    setSheet(null);
    const res = await fetch(`${API}/api/v1/control/service/disputes/${id}`, { credentials: "include" });
    if (!res.ok) {
      setError(errorMessage(await res.json(), "That dispute did not answer."));
      return;
    }
    setSheet(await res.json());
    requestAnimationFrame(() =>
      document.getElementById("dispute-sheet")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  const openPaper = useCallback(async (id: string) => {
    setPaper(null);
    const res = await fetch(`${API}/api/v1/control/service/refunds/${id}`, { credentials: "include" });
    if (!res.ok) {
      setError(errorMessage(await res.json(), "That paper did not answer."));
      return;
    }
    setPaper(await res.json());
    requestAnimationFrame(() =>
      document.getElementById("paper-sheet")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  // ---------- writes ----------
  async function send(path: string, body?: unknown, form?: FormData): Promise<any | null> {
    setBusy(true); setPanelError(null);
    try {
      const res = await fetch(`${API}/api/v1/control/service/${path}`, {
        method: "POST", credentials: "include",
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
        ...(form || body === undefined ? {} : { headers: { "content-type": "application/json" } })
      });
      if (res.status === 401) { window.location.href = "/control/login"; return null; }
      if (!res.ok) {
        setPanelError(errorMessage(await res.json(), "The register refused this."));
        return null;
      }
      const j = await res.json().catch(() => ({}));
      setPanel(null); setDraft(EMPTY_DRAFT); setArmed(null); setCalls(null);
      refresh();
      return j;
    } finally { setBusy(false); }
  }

  /** Opening a form on the row it belongs to. Re-tapping the same button shuts it, and switching
   *  rows never inherits the previous row's sentence. */
  function openPanel(next: Panel, seed?: Partial<Draft>) {
    const closing = panel?.kind === next.kind && panel?.id === next.id
      && panel?.docId === next.docId && panel?.seatId === next.seatId;
    setPanelError(null); setNotice(null); setArmed(null); setCalls(null);
    setDraft({ ...EMPTY_DRAFT, ...seed });
    if (closing) { setPanel(null); return; }
    setPanel(next);
    requestAnimationFrame(() =>
      document.getElementById("service-form")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  // ---------- the CSV every tab is asked to carry ----------
  async function exportCsv() {
    setExporting(true); setPanelError(null);
    try {
      const p = new URLSearchParams({ register: tab });
      if (tab === "disputes") {
        if (dFilter.status) p.set("status", dFilter.status);
        if (dFilter.ground) p.set("ground", dFilter.ground);
        if (dFilter.q.trim()) p.set("search", dFilter.q.trim());
      } else if (tab === "refunds") {
        if (pFilter.status) p.set("status", pFilter.status);
        if (pFilter.q.trim()) p.set("search", pFilter.q.trim());
      } else if (tab === "satisfaction") {
        // The list filter is `state`; the export filter is `status`. One word for two routes is
        // not the register's fault, and sending the wrong one is a 400 the desk cannot guess at.
        if (cFilter.state) p.set("status", cFilter.state);
        if (cFilter.q.trim()) p.set("search", cFilter.q.trim());
      } else {
        if (mFilter.result) p.set("status", mFilter.result);
        if (mFilter.seat) p.set("seat", mFilter.seat);
        if (mFilter.q.trim()) p.set("search", mFilter.q.trim());
      }
      const res = await fetch(`${API}/api/v1/control/service/export?${p}`, { credentials: "include" });
      if (!res.ok) {
        setPanelError(errorMessage(await res.json(), "The export did not answer."));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `service-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setNotice(`The ${tab} register was exported with the filters on screen.`);
    } finally { setExporting(false); }
  }

  /** A paper on a dispute is read through the desk, never from a bucket link: the duty that could
   *  open the dispute is the duty that opened the file. */
  async function readPaperFile(docId: string, name: string) {
    if (!sheet) return;
    setPanelError(null);
    const res = await fetch(
      `${API}/api/v1/control/service/disputes/${sheet.id}/papers/${docId}/content`,
      { credentials: "include" });
    if (!res.ok) {
      setPanelError(errorMessage(await res.json().catch(() => ({})),
        `“${name}” could not be read.`));
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- form gates, in the register's own words ----------
  const reasonReady = draft.reason.trim().length >= 4;
  const sentenceReady = draft.reason.trim().length >= 8;
  const noteReady = draft.note.trim().length >= 8;
  const declineReady = draft.decline.trim().length >= 8;
  const responseReady = draft.response.trim().length >= 4;
  const claimReady = draft.claim.trim().length >= 10;
  const decided = DECIDED.includes(draft.to);
  const outcomeReady = draft.outcome.trim().length >= 8;
  const ticks = SIX.filter(([k]) => draft.checks[k]).length;
  const preview = Math.round(100 * ticks / 6);
  const band = preview >= 80 ? "met" : preview >= 40 ? "partly_met" : "below";
  const bandWords: Record<string, string> = {
    met: "five or six of the six", partly_met: "three or four", below: "two or fewer"
  };
  const markReady = draft.result === band
    && (draft.result === "met" || draft.note.trim().length >= 8) && !!draft.callId && !!draft.seat;

  const b = (section: keyof Board) => (board?.[section] ?? {}) as Record<string, any>;

  if (forbidden || (me && !forbidden && perms.length && !canView)) {
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
              Reading the disputes, the marks and the refund papers needs <code>control.service.view</code>;
              opening one needs <code>control.service.manage</code>, grading a call needs
              <code> control.service.review</code>, and asking a second seat to sign a figure needs
              <code> control.payments.manage</code>.
            </p>
            <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const dStats: [any, string, string | undefined, string?][] = [
    [b("disputes").open ?? 0, "Open disputes", "Nobody has looked into them yet",
      (b("disputes").open ?? 0) ? "var(--warning)" : undefined],
    [b("disputes").investigating ?? 0, "Being looked into", "A desk has taken the argument on", undefined],
    [b("disputes").awaiting_paper ?? 0, "Upheld on nothing yet",
      "A live dispute with no paper filed under it — a finding cannot be made on these",
      (b("disputes").awaiting_paper ?? 0) ? "var(--danger)" : undefined],
    [cash(b("disputes").claimed_tzs, "TZS"), "Claimed, in shillings",
      "Open, under look-in, upheld and settled lines added together", undefined],
    [cash(b("disputes").claimed_usd, "USD"), "Claimed, in dollars",
      "Kept apart from the shillings: one total of two currencies is a number nobody can pay", undefined],
    [b("refunds").awaiting_signature ?? 0, "Papers waiting on a signature",
      "Proposed here, signed only on the Approvals desk",
      (b("refunds").awaiting_signature ?? 0) ? "var(--warning)" : undefined],
    [cash(b("refunds").released, "") + " released", "Papers signed and released",
      "The office has agreed to pay. The money itself leaves with the ledger, not with this desk.",
      undefined],
    [`${b("satisfaction").answered ?? 0}/${b("satisfaction").asked ?? 0}`, "Callers answered the question",
      "Asked once per settled call", undefined],
    [b("satisfaction").mean ?? 0, "Mean satisfaction", "Out of five, on the answered lines only", undefined],
    [b("satisfaction").unhappy ?? 0, "Rated one or two", "The lines to read before the mean",
      (b("satisfaction").unhappy ?? 0) ? "var(--danger)" : undefined],
    [b("quality").reviews ?? 0, "Marks on the board", "A withdrawn mark is off this number", undefined],
    [b("quality").below ?? 0, "Below the promise", "Two ticks or fewer out of six",
      (b("quality").below ?? 0) ? "var(--danger)" : undefined]
  ];

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Service · after the call · {canManage ? (canPay ? "and the papers" : "the register") : "read-only"}
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1240px] px-16 py-32">
        <div className="flex flex-wrap items-end justify-between gap-16">
          <div className="min-w-0">
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
              Disputes, satisfaction, marks and refund papers
            </h1>
            <p className="mt-8 max-w-[70ch] text-sm" style={{ color: "var(--ink-soft)" }}>
              A caller who was mis-handled gets a number they can be quoted — <code>DP-YYYY-NNNNN</code> —
              and the office gets a file that has to hold the evidence before it can hold a finding.
              Satisfaction is asked after the work is finished, a mark is read out of six answers, and a
              refund is a paper that only pays out once a second seat has signed it somewhere else.
            </p>
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              {board?.clock ? `These numbers were measured at ${when(board.clock)}.` : "Reading the board…"}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-10">
              <button type="button" onClick={() => openPanel({ kind: "dispute" })}
                className="waisha-btn min-h-[36px] rounded-input px-16 py-8 text-xs font-semibold">
                {panel?.kind === "dispute" ? "Close the form" : "Open a dispute"}
              </button>
              <button type="button" onClick={() => openPanel({ kind: "refund" })}
                className={headBtn} style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                {panel?.kind === "refund" ? "Close the paper form" : "Raise a refund paper"}
              </button>
            </div>
          )}
        </div>

        <div className="mt-20 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          {dStats.map(([value, text, hint, tone]) => (
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

        {/* ---------------- one dispute, open ---------------- */}
        {sheet && <DisputeSheetView
          sheet={sheet} panel={panel} openPanel={openPanel} canManage={canManage}
          canPay={canPay} busy={busy} panelError={panelError} close={() => setSheet(null)}
          readPaperFile={readPaperFile} openPaper={openPaper}
        />}

        {/* ---------------- one paper, open ---------------- */}
        {paper && <PaperSheetView
          paper={paper} panel={panel} openPanel={openPanel} canManage={canManage}
          canPay={canPay} canDecide={canDecide} busy={busy} panelError={panelError}
          close={() => setPaper(null)} openDispute={openDispute}
        />}

        {/* ---------------- the form every action opens ---------------- */}
        {panel && (
          <section id="service-form" className="mt-20 rounded-card border p-20"
            style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
            <h2 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
              {panelTitle(panel)}
            </h2>
            <p className="mt-6 max-w-[80ch] text-[11px]" style={{ color: "var(--ink-soft)" }}>
              {panelHint(panel)}
            </p>
            {panelError && (
              <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
                {panelError}
              </div>
            )}

            {["dispute", "ask", "grade", "refund"].includes(panel.kind) && (
              <CallPicker draft={draft} setDraft={setDraft} calls={calls} busy={callBusy}
                search={searchCalls} pick={pickCall}
                hint={panel.kind === "ask"
                  ? "Satisfaction is only asked about a call the desk has finished."
                  : panel.kind === "grade"
                    ? "Any call the register holds, including the ones still being worked."
                    : "A dispute or a paper always stands on an incidence number."} />
            )}

            {panel.kind === "dispute" && (
              <div className="mt-14 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  What the office did wrong
                  <select value={draft.ground} onChange={(e) => setDraft({ ...draft, ground: e.target.value })}
                    className={box} style={boxStyle}>
                    {GROUNDS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  The figure the caller claims — optional
                  <input value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                    inputMode="decimal" placeholder="400000" className={box} style={boxStyle} />
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  In
                  <select value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                    className={box} style={boxStyle} disabled={!draft.amount.trim()}>
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label className={`${labelText} col-span-full block`} style={{ color: "var(--ink-soft)" }}>
                  The claim, in the caller's words
                  <textarea value={draft.claim} onChange={(e) => setDraft({ ...draft, claim: e.target.value })}
                    rows={4} placeholder="They were told the clearance would be released on Tuesday and it was not."
                    className={box} style={boxStyle} />
                </label>
                <label className={`${labelText} col-span-full block`} style={{ color: "var(--ink-soft)" }}>
                  Why this belongs in the register
                  <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                    placeholder="The caller quoted BILLING-7 and no one came back." className={box} style={boxStyle} />
                </label>
              </div>
            )}

            {panel.kind === "move" && (
              <div className="mt-14 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  Move it to
                  <select value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                    className={box} style={boxStyle}>
                    {DISPUTE_STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                {decided && (
                  <label className={`${labelText} col-span-full block`} style={{ color: "var(--ink-soft)" }}>
                    The finding, in writing — 8 to 2000 characters
                    <textarea value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}
                      rows={4} placeholder="Advice was wrong; the fee was refunded in full on RF-2026-00004."
                      className={box} style={boxStyle} />
                  </label>
                )}
                <label className={`${labelText} col-span-full block`} style={{ color: "var(--ink-soft)" }}>
                  Why it moves
                  <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                    className={box} style={boxStyle} />
                </label>
                {decided && (
                  <p className="col-span-full text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {panel.id === sheet?.id && (sheet?.files.length ?? 0) === 0
                      ? <>A finding of <span className="font-semibold" style={{ color: "var(--warning)" }}>upheld</span>{" "}
                        or <span className="font-semibold" style={{ color: "var(--warning)" }}>settled</span> is
                        refused until a paper is filed under this dispute — the register will not let the office
                        agree to something it cannot prove. File it above, then come back.</>
                      : <>Once decided, this line cannot be rewritten. A second argument about the same call is a
                        second dispute.</>}
                  </p>
                )}
              </div>
            )}

            {panel.kind === "note" && (
              <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                The line on the file
                <textarea value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                  rows={3} placeholder="Rang the clearing agent; they will answer by Thursday." className={box} style={boxStyle} />
              </label>
            )}

            {panel.kind === "dispute_refund" || panel.kind === "refund" ? (
              <div className="mt-14 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  The figure
                  <input value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                    inputMode="decimal" className={box} style={boxStyle} />
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  In
                  <select value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                    className={box} style={boxStyle}>
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  Paid back by
                  <select value={draft.payBack} onChange={(e) => setDraft({ ...draft, payBack: e.target.value })}
                    className={box} style={boxStyle}>
                    {PAY_BACK.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label className={`${labelText} col-span-full block`} style={{ color: "var(--ink-soft)" }}>
                  The sentence a second seat will read before signing
                  <textarea value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                    rows={3} placeholder="The office agrees the clearing fee was charged twice; one of the two is paid back."
                    className={box} style={boxStyle} />
                </label>
                {panel.kind === "dispute_refund" && sheet?.amount != null && (
                  <p className="col-span-full text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {sheet.amount} {sheet.currency} was what the caller claimed. The paper has to say that figure
                    or the dispute has to be opened again at the new one — the register refuses two numbers about
                    one argument.
                  </p>
                )}
              </div>
            ) : null}

            {(panel.kind === "papers" || panel.kind === "retire") && (
              <div className="mt-14">
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  {panel.kind === "papers" ? "Why this paper belongs on the dispute" : "Why it goes"}
                  <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                    className={box} style={boxStyle} />
                </label>
                {panel.kind === "papers" && (
                  <>
                    {/* The reason is appended before the file part: the API reads multipart fields in
                  the order they arrive, and a field sent after the part is a field it never saw. */}
                    <input type="file" accept=".jpg,.jpeg,.png,.webp,.pdf"
                      className="mt-12 block w-full max-w-full text-xs"
                      aria-label="The paper itself" style={{ color: "var(--ink-soft)" }}
                      onChange={(e) => setDraft({ ...draft, file: e.target.files?.[0] ?? null })} />
                    {draft.file && (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        {draft.file.name} · {size(draft.file.size)}
                        {draft.file.size > MAX_PAPER_BYTES ? " — over the 8 MB the register takes" : ""}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {panel.kind === "propose" && (
              <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                What the seat is being asked to sign
                <textarea value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                  rows={3} className={box} style={boxStyle} />
              </label>
            )}

            {(panel.kind === "decline" || panel.kind === "void") && (
              <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                {panel.kind === "decline" ? "Why this is not paid" : "Why a released paper is being voided"}
                <textarea value={draft.decline} onChange={(e) => setDraft({ ...draft, decline: e.target.value })}
                  rows={3} className={box} style={boxStyle} />
              </label>
            )}

            {panel.kind === "ask" && (
              <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                How the question is being put
                <select value={draft.askedChannel} onChange={(e) => setDraft({ ...draft, askedChannel: e.target.value })}
                  className={box} style={boxStyle}>
                  {ASK_WAYS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
            )}

            {panel.kind === "answer" && (
              <div className="mt-14 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  Their mark, out of five
                  <select value={draft.score} onChange={(e) => setDraft({ ...draft, score: e.target.value })}
                    className={box} style={boxStyle}>
                    <option value="">Choose the answer</option>
                    {[5, 4, 3, 2, 1].map((n) => <option key={n} value={String(n)}>{n} — {
                      ["", "worst", "poor", "all right", "good", "best"][n]}</option>)}
                  </select>
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  Would they recommend us
                  <select value={draft.recommends} onChange={(e) => setDraft({ ...draft, recommends: e.target.value })}
                    className={box} style={boxStyle}>
                    <option value="">They did not say</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>
                <label className={`${labelText} col-span-full block`} style={{ color: "var(--ink-soft)" }}>
                  Their own words — optional
                  <textarea value={draft.word} onChange={(e) => setDraft({ ...draft, word: e.target.value })}
                    rows={3} className={box} style={boxStyle} />
                </label>
                <p className="col-span-full text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  An answer is kept, not retyped. If the mark was written down wrong, the line stays and a note
                  goes on the call.
                </p>
              </div>
            )}

            {panel.kind === "grade" && (
              <div className="mt-14">
                <div className="grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                  <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                    Which seat handled the call
                    <select value={draft.seat} onChange={(e) => setDraft({ ...draft, seat: e.target.value })}
                      className={box} style={boxStyle}>
                      <option value="">Choose the seat</option>
                      {seats.filter((s) => s.id !== me?.userId).map((s) => (
                        <option key={s.id} value={s.id}>{s.full_name}</option>
                      ))}
                    </select>
                  </label>
                  <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                    The summary word
                    <select value={draft.result} onChange={(e) => setDraft({ ...draft, result: e.target.value })}
                      className={box} style={boxStyle}>
                      {RESULTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                </div>
                <fieldset className="mt-14 rounded-card border p-14" style={{ borderColor: "var(--line)" }}>
                  <legend className="px-8 text-[11px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>
                    The six answers the mark is read out of
                  </legend>
                  <div className="grid gap-10" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                    {SIX.map(([k, v]) => (
                      <label key={k} className="flex min-h-[36px] items-center gap-8 text-sm" style={{ color: "var(--ink)" }}>
                        <input type="checkbox" checked={!!draft.checks[k]}
                          onChange={(e) => setDraft({ ...draft, checks: { ...draft.checks, [k]: e.target.checked } })} />
                        {v}
                      </label>
                    ))}
                  </div>
                  <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {ticks} of six is <span className="font-bold tabular-nums" style={{ color: "var(--ink)" }}>{preview}</span>{" "}
                    — that is <span className="font-semibold" style={{ color: RESULT_EDGE[band] }}>{bandWords[band]}</span>,
                    so only <span className="font-semibold" style={{ color: "var(--ink)" }}>{label(RESULTS, band)}</span> can
                    be signed. The table works the mark out; this page only warns before it refuses.
                  </p>
                </fieldset>
                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  {draft.result === "met" ? "A line for the file — optional"
                    : "The coach's line — what to do differently"}
                  <textarea value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                    rows={3} className={box} style={boxStyle} />
                </label>
                {draft.result !== "met" && draft.note.trim().length < 8 && (
                  <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>
                    A mark short of the promise needs eight characters of explanation, or the seat learns nothing
                    and cannot argue with it.
                  </p>
                )}
              </div>
            )}

            {(panel.kind === "respond" || panel.kind === "withdraw") && (
              <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                {panel.kind === "respond" ? "The seat's answer, once" : "Why the mark comes off the board"}
                <textarea value={panel.kind === "respond" ? draft.response : draft.reason}
                  onChange={(e) => setDraft(panel.kind === "respond"
                    ? { ...draft, response: e.target.value } : { ...draft, reason: e.target.value })}
                  rows={3} className={box} style={boxStyle} />
              </label>
            )}

            <div className="mt-16 flex flex-wrap items-center gap-12">
              <button type="button" disabled={!formReady() || busy} onClick={press}
                className="waisha-btn min-h-[36px] rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-40">
                {busy ? "Writing…" : isArmed() ? `${submitWords(panel.kind)} — yes, press again`
                  : submitWords(panel.kind)}
              </button>
              <button type="button" onClick={() => { setPanel(null); setDraft(EMPTY_DRAFT); }}
                className={headBtn} style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                Cancel
              </button>
              {!formReady() ? (
                <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>{whyNotReady()}</p>
              ) : isArmed() ? (
                <p className="text-[11px]" style={{ color: "var(--warning)" }}>
                  Press it again and this is written on the register. Nothing here takes it back.
                </p>
              ) : null}
            </div>
          </section>
        )}

        {/* ---------------- the tabs ---------------- */}
        <div className="mt-28 flex flex-wrap items-center gap-10">
          {TABS.map(([k, v]) => (
            <button key={k} type="button" onClick={() => { setTab(k); setPanel(null); }}
              className={headBtn}
              style={tab === k
                ? { borderColor: "var(--adm-accent)", color: "var(--ink)",
                  background: "color-mix(in srgb, var(--adm-accent) 14%, transparent)" }
                : { borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              {v}
            </button>
          ))}
          <button type="button" onClick={exportCsv} disabled={exporting || !canView}
            className={`${headBtn} ml-auto`} style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
            {exporting ? "Reading…" : `Export ${tab} (CSV)`}
          </button>
        </div>
        <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          The CSV is the filter on screen, not the page on screen — up to two thousand lines.
        </p>

        {panelError && !panel && !sheet && !paper && (
          <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
            {panelError}
          </div>
        )}

        {tab === "disputes" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={dFilter.q} aria-label="Search disputes"
                onChange={(e) => setDFilter({ ...dFilter, q: e.target.value, offset: "0" })}
                placeholder="Number, incidence, company or the claim itself"
                className="min-w-[240px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={dFilter.status} aria-label="Filter by state"
                onChange={(e) => setDFilter({ ...dFilter, status: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any state</option>
                {DISPUTE_STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select value={dFilter.ground} aria-label="Filter by ground"
                onChange={(e) => setDFilter({ ...dFilter, ground: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any ground</option>
                {GROUNDS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {dCounts && (
              <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                {dCounts.total} in the register · {dCounts.open} open · {dCounts.investigating} being looked into ·{" "}
                {dCounts.awaiting_paper} awaiting a paper · {dCounts.awaiting_refund} with a figure and no paper ·{" "}
                {dCounts.upheld} upheld · {dCounts.rejected} rejected · {dCounts.settled} settled · {dCounts.withdrawn} withdrawn
              </p>
            )}
            <List loading={dRows.length === 0 && !dCounts} empty={dRows.length === 0}
              emptyWords="No dispute is on the register with this filter. A dispute is opened from a call that was written down first."
              head={["Number", "Against", "Ground", "Claimed", "State", "Papers", "Opened", ""]}
              rows={dRows.map((r) => ([
                <span key="a" className="font-semibold">{r.ref}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{r.ticket_ref}</span></span>,
                <span key="b" className="break-words">{r.company_name ?? "a caller"}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>by {r.opened_name ?? "—"}</span></span>,
                <span key="c">{label(GROUNDS, r.ground)}</span>,
                <span key="d" className="tabular-nums whitespace-nowrap">{r.amount ? cash(r.amount, r.currency) : "no figure"}</span>,
                <span key="e"><Chip edge={DISPUTE_EDGE[r.status]}>{label(DISPUTE_STATES, r.status)}</Chip></span>,
                <span key="f" className="tabular-nums">{r.papers ?? 0} filed · {r.lines ?? 0} lines</span>,
                <span key="g" className="whitespace-nowrap">{day(r.opened_at)}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{age(r.opened_at)} old</span></span>,
                <span key="h" className="flex flex-wrap gap-8">
                  <button type="button" onClick={() => openDispute(r.id)} className={mini}>Open</button>
                  {canManage && !r.decided_at && (
                    <button type="button" onClick={() => openPanel({ kind: "move", id: r.id, ref: r.ref },
                      { to: r.status === "open" ? "investigating" : r.status })} className={mini}>Move</button>
                  )}
                  {canManage && (
                    <button type="button" onClick={() => openPanel({ kind: "note", id: r.id, ref: r.ref })} className={mini}>
                      Add a line</button>
                  )}
                </span>
              ]))}
            />
            <Pager filter={dFilter} setFilter={setDFilter} total={dRows[0]?.total ?? 0} />
          </section>
        )}

        {tab === "refunds" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={pFilter.q} aria-label="Search papers"
                onChange={(e) => setPFilter({ ...pFilter, q: e.target.value, offset: "0" })}
                placeholder="Paper number, incidence, company or the reason"
                className="min-w-[240px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={pFilter.status} aria-label="Filter by state"
                onChange={(e) => setPFilter({ ...pFilter, status: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any state</option>
                {PAPER_STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {pCounts && (
              <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                {pCounts.total} papers · {pCounts.raised} raised · {pCounts.awaiting} waiting on a seat ·{" "}
                {pCounts.released} released · {pCounts.declined} refused · {pCounts.void} voided ·{" "}
                released {cash(pCounts.released_tzs, "TZS")} and {cash(pCounts.released_usd, "USD")}
              </p>
            )}
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              The board calls a waiting paper <code>awaiting</code>; the Service board above calls the same thing{" "}
              <code>awaiting_signature</code>. Both are the register&apos;s words and both count the same rows.
            </p>
            <List loading={pRows.length === 0 && !pCounts} empty={pRows.length === 0}
              emptyWords="No refund paper matches this filter. A paper is raised from a dispute or from a settled call."
              head={["Paper", "For", "Figure", "State", "Signature", "Raised", ""]}
              rows={pRows.map((r) => ([
                <span key="a" className="font-semibold">{r.ref}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{r.ticket_ref}</span></span>,
                <span key="b" className="break-words">{r.company_name ?? "a caller"}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {label(PAY_BACK, r.pay_back)} · by {r.raised_name ?? "—"}</span></span>,
                <span key="c" className="tabular-nums whitespace-nowrap">{cash(r.amount, r.currency)}</span>,
                <span key="d"><Chip edge={PAPER_EDGE[r.request_status]}>{label(PAPER_STATES, r.request_status)}</Chip></span>,
                <span key="e" className="text-[11px]">
                  {r.request_status === "pending_signature"
                    ? <>waiting on {r.signed_name ?? "a second seat"}{r.approval_proposed_name
                      ? ` (asked of ${r.approval_proposed_name})` : ""} ·{" "}
                      {r.approval_expires_at
                        ? <span style={{ color: new Date(r.approval_expires_at).getTime() < Date.now()
                          ? "var(--danger)" : "var(--ink-soft)" }}>
                          lapses {day(r.approval_expires_at)}</span> : "no window"}</>
                    : r.request_status === "released"
                      ? <>signed{r.signed_name ? ` by ${r.signed_name}` : ""} · released{" "}
                        {r.released_name ?? "a ledger"}</>
                      : r.request_status === "declined"
                        ? <span className="break-words">{r.declined_note ?? "refused"}</span>
                        : r.request_status === "void"
                          ? <span className="break-words">{r.void_note ?? "voided"}</span>
                          : "nothing asked yet"}
                </span>,
                <span key="f" className="whitespace-nowrap">{day(r.raised_at)}</span>,
                <span key="g" className="flex flex-wrap gap-8">
                  <button type="button" onClick={() => openPaper(r.id)} className={mini}>Open</button>
                  {canManage && canPay && ["raised", "pending_signature"].includes(r.request_status) && (
                    <button type="button"
                      onClick={() => openPanel({ kind: "propose", id: r.id, ref: r.ref })} className={mini}>
                      {r.request_status === "pending_signature" ? "Ask again" : "Ask a seat to sign"}
                    </button>
                  )}
                  {((r.request_status === "pending_signature" && canDecide)
                    || (r.request_status === "raised" && canManage && canPay)) && (
                    <button type="button" onClick={() => openPanel({ kind: "decline", id: r.id, ref: r.ref })}
                      className={mini}>Refuse it</button>
                  )}
                  {canPay && r.request_status === "released" && (
                    <button type="button" onClick={() => openPanel({ kind: "void", id: r.id, ref: r.ref })}
                      className={mini}>Void it</button>
                  )}
                </span>
              ]))}
            />
            <Pager filter={pFilter} setFilter={setPFilter} total={pRows[0]?.total ?? 0} />
          </section>
        )}

        {tab === "satisfaction" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={cFilter.q} aria-label="Search the answers"
                onChange={(e) => setCFilter({ ...cFilter, q: e.target.value, offset: "0" })}
                placeholder="Incidence number, company or the caller's words"
                className="min-w-[240px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={cFilter.state} aria-label="Filter by answer"
                onChange={(e) => setCFilter({ ...cFilter, state: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any line</option>
                <option value="answered">Answered</option>
                <option value="unanswered">Not answered</option>
                <option value="low">Rated one or two</option>
                <option value="good">Rated four or five</option>
              </select>
            </div>
            {cCounts && (
              <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                {cCounts.asked} asked · {cCounts.answered} answered · {cCounts.unanswered} still waiting ·{" "}
                mean {cCounts.mean} of 5 · {cCounts.happy} at four or five · {cCounts.unhappy} at one or two ·{" "}
                {cCounts.would_recommend} would recommend · {cCounts.with_words} wrote something
              </p>
            )}
            <List loading={cRows.length === 0 && !cCounts} empty={cRows.length === 0}
              emptyWords="Nothing here with this filter. The question is asked from a call the desk has settled."
              head={["Incidence", "Company", "Asked", "By", "Their mark", "Would recommend", "Their words", ""]}
              rows={cRows.map((r) => ([
                <span key="a" className="font-semibold">{r.ticket_ref}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {label(ASK_WAYS, r.asked_channel)}</span></span>,
                <span key="b" className="break-words">{r.company_name ?? "—"}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    call is {r.ticket_status ?? "—"}</span></span>,
                <span key="c" className="whitespace-nowrap">{when(r.asked_at)}</span>,
                <span key="d">{r.asked_name ?? "—"}</span>,
                <span key="e">{r.score === null
                  ? <Chip edge="var(--ink-soft)">not answered</Chip>
                  : <Chip edge={r.score >= 4 ? "var(--success)" : r.score <= 2 ? "var(--danger)" : "var(--warning)"}>
                    {r.score}/5</Chip>}</span>,
                <span key="f">{r.recommends === null ? "—" : r.recommends ? "yes" : "no"}</span>,
                <span key="g" className="max-w-[40ch] break-words text-[11px]">{r.word ?? ""}</span>,
                <span key="h" className="flex flex-wrap gap-8">
                  {canManage && !r.answered_at && (
                    <button type="button" onClick={() => openPanel({ kind: "answer", id: r.id, ref: r.ticket_ref })}
                      className={mini}>Write the answer</button>
                  )}
                  {r.answered_at && (
                    <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      answered {age(r.answered_at)} ago</span>
                  )}
                </span>
              ]))}
            />
            <Pager filter={cFilter} setFilter={setCFilter} total={cRows[0]?.total ?? 0} />
          </section>
        )}

        {tab === "quality" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={mFilter.q} aria-label="Search the marks"
                onChange={(e) => setMFilter({ ...mFilter, q: e.target.value, offset: "0" })}
                placeholder="Incidence number, company, the note or the seat's answer"
                className="min-w-[240px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={mFilter.result} aria-label="Filter by band"
                onChange={(e) => setMFilter({ ...mFilter, result: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any band</option>
                {RESULTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select value={mFilter.seat} aria-label="Filter by seat"
                onChange={(e) => setMFilter({ ...mFilter, seat: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any seat</option>
                {seatMarks.map((s) => (
                  <option key={s.seat_id} value={s.seat_id}>{s.seat_name ?? s.seat_id}</option>
                ))}
              </select>
              {canReview && (
                <button type="button" onClick={() => openPanel({ kind: "grade" })}
                  className={`${headBtn} ml-auto`} style={{ borderColor: "var(--adm-accent)", color: "var(--ink)" }}>
                  {panel?.kind === "grade" ? "Close the mark" : "Grade a call"}
                </button>
              )}
            </div>
            {mCounts && (
              <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                {mCounts.live} on the board · {mCounts.met} met · {mCounts.partly} partly met · {mCounts.below} below ·{" "}
                {mCounts.answered} answered by the seat · {mCounts.withdrawn} withdrawn · mean {mCounts.mean}
              </p>
            )}
            {seatMarks.length > 0 && (
              <div className="mt-14 rounded-card border p-14" style={{ borderColor: "var(--line)" }}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                  Where the marks have landed, seat by seat
                </p>
                <div className="mt-10 grid gap-10" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                  {seatMarks.map((s) => (
                    <div key={s.seat_id} className="rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
                      <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{s.seat_name ?? "a seat"}</p>
                      <p className="mt-4 text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
                        {s.marks} marks · mean {s.mean} · {s.met} met · {s.below} below · {s.answered} answered
                      </p>
                      <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        last one {s.last_mark ? day(s.last_mark) : "—"}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="mt-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  A withdrawn mark is still counted in &quot;answered&quot; but not in the mean: the seat&apos;s side of
                  the argument stays on the file even when the office takes its own mark off the board.
                </p>
              </div>
            )}
            <List loading={mRows.length === 0 && !mCounts} empty={mRows.length === 0}
              emptyWords="No mark here with this filter. A supervisor grades a call from the register itself."
              head={["Incidence", "Seat", "Mark", "The six answers", "Note", "The seat's side", "Given", ""]}
              rows={mRows.map((r) => ([
                <span key="a" className="font-semibold">{r.ticket_ref}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {r.company_name ?? "—"}{r.ticket_dept_ref ? ` · ${r.ticket_dept_ref}` : ""}</span></span>,
                <span key="b">{r.seat_name ?? "—"}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    by {r.reviewer_name ?? "—"}</span></span>,
                <span key="c">
                  <Chip edge={r.withdrawn_at ? "var(--ink-soft)" : RESULT_EDGE[r.result]}>
                    {r.withdrawn_at ? "withdrawn" : `${r.score} · ${label(RESULTS, r.result)}`}
                  </Chip>
                </span>,
                <span key="d" className="text-[10px] whitespace-nowrap">
                  {SIX.map(([k, v]) => (
                    <span key={k} title={v} style={{ color: r.checks?.[k] ? "var(--success)" : "var(--danger)" }}>
                      {r.checks?.[k] ? "✓" : "✗"}{" "}{v.split(" ")[0]}<br />
                    </span>
                  ))}
                </span>,
                <span key="e" className="max-w-[36ch] break-words text-[11px]">{r.note ?? ""}</span>,
                <span key="f" className="max-w-[36ch] break-words text-[11px]">
                  {r.responded_at
                    ? <>{r.agent_response}<br /><span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      answered {when(r.responded_at)}</span></>
                    : <span style={{ color: "var(--ink-soft)" }}>
                      {r.withdrawn_at ? "off the board" : "not answered yet"}</span>}
                </span>,
                <span key="g" className="whitespace-nowrap">{day(r.reviewed_at)}</span>,
                <span key="h" className="flex flex-wrap gap-8">
                  {(canReview || canManage) && !r.responded_at && !r.withdrawn_at && (
                    <button type="button"
                      onClick={() => openPanel({ kind: "respond", id: r.id, ref: r.ticket_ref,
                        seatId: r.reviewed_seat, seatName: r.seat_name,
                        mine: r.reviewed_seat === me?.userId })}
                      className={mini}>
                      {r.reviewed_seat === me?.userId ? "Answer it" : "Record the seat's answer"}
                    </button>
                  )}
                  {canReview && !r.withdrawn_at && (
                    <button type="button" onClick={() => openPanel({ kind: "withdraw", id: r.id, ref: r.ticket_ref })}
                      className={mini}>Withdraw</button>
                  )}
                </span>
              ]))}
            />
            <Pager filter={mFilter} setFilter={setMFilter} total={mRows[0]?.total ?? 0} />
          </section>
        )}

        <p className="mt-28 max-w-[80ch] text-[11px]" style={{ color: "var(--ink-soft)" }}>
          Nothing on this desk pays money. A released paper is the office agreeing to a figure; the transfer is
          made from the ledger, and until it is, the paper says <em>released</em> and not <em>paid</em>. A signature
          is spent on the <Link href="/control/approvals" className="underline" style={{ color: "var(--adm-accent)" }}>
            Approvals</Link> desk by a seat that did not ask for it.
        </p>
      </main>
    </div>
  );

  // ---------- the form's own answers ----------
  /** Which state the paper a panel was opened on is in. The detail reply and the board row carry
   *  the same fact under different keys, and a hint about who may refuse has to read the one the
   *  route actually checks. */
  function paperOf(p: Panel): string | null {
    if (paper && p.id === paper.id) return paper.status;
    return pRows.find((r) => r.id === p.id)?.request_status ?? null;
  }
  function panelTitle(p: Panel): string {
    return {
      dispute: "Open a dispute on a call",
      move: `Move ${p.ref ?? "the dispute"}`,
      note: `A line on ${p.ref ?? "the dispute"}`,
      papers: "File the paper a finding stands on",
      retire: `Take “${p.fileName ?? "the paper"}” off the file`,
      dispute_refund: `Raise a refund paper on ${p.ref ?? "the dispute"}`,
      refund: "Raise a refund paper",
      propose: `Ask a second seat to sign ${p.ref ?? "the paper"}`,
      decline: `Refuse ${p.ref ?? "the paper"}`,
      void: `Void ${p.ref ?? "the released paper"}`,
      ask: "Ask a caller how the call went",
      answer: `Write the answer for ${p.ref ?? "the call"}`,
      grade: "Grade how a call was handled",
      respond: p.mine ? "Answer the mark on your own call"
        : `Record what ${p.seatName ?? "the seat"} says about this mark`,
      withdraw: `Take the mark on ${p.ref ?? "the call"} off the board`
    }[p.kind];
  }
  function panelHint(p: Panel): string {
    return {
      dispute: "Say what the caller says went wrong, in their terms. A dispute stands on an incidence: "
        + "the company and the call number are copied off it by the register and never typed here.",
      move: "A finding is the last thing written on a dispute, so it is not edited afterwards. "
        + "Upheld and settled need a paper filed under them first.",
      note: "A note changes nothing about the state. It is the line that says what the desk did and when.",
      papers: "A JPEG, PNG, WebP or PDF up to 8 MB, with a sentence about why it belongs on this dispute.",
      retire: "The file is tombstoned, not deleted: the finding stays readable and the event line says "
        + "what was taken away.",
      dispute_refund: "This only starts the paper waiting. Nothing is paid until a seat that did not write "
        + "it signs it somewhere else.",
      refund: "A call the office agrees it owes something on, whether or not anybody was challenged about it.",
      propose: "The seat signs the bytes of this paper, so the figure asked for and the figure released are "
        + "provably the same one. A proposal lapses after a week.",
      decline: paperOf(p) === "pending_signature"
        ? "Refusing is the other answer to the signature somebody was asked for, so it costs the "
          + "signing duty, not the writing one."
        : "Saying no to money before it is put up for signature is the desk's own answer.",
      void: "A released paper nobody actually paid is exactly what an audit asks about, so it goes with a "
        + "sentence on the row.",
      ask: "The call has to be settled or closed first — satisfaction asked about work in progress is a "
        + "number about a promise that has not been kept yet.",
      answer: "One answer per call, and it is not retyped afterwards.",
      grade: "A seat does not grade its own call. The mark is read out of the six answers below by the "
        + "register, and the summary word has to agree with them.",
      respond: "It goes on the row that carries the mark, so an appeal can never be read apart from the "
        + "thing it appeals. It is given once.",
      withdraw: "The score stops counting in the roll-up and the row itself stays: a mark that was given "
        + "and then thought better of is part of what the office did."
    }[p.kind];
  }
  function submitWords(k: Panel["kind"]): string {
    return {
      dispute: "Write it into the register", move: "Move it", note: "Add the line",
      papers: "File it", retire: "Take it off the file", dispute_refund: "Raise the paper",
      refund: "Raise the paper", propose: "Ask for the signature", decline: "Refuse this paper",
      void: "Void the paper", ask: "Ask the question", answer: "Write the answer",
      grade: "Give the mark", respond: "Give the answer", withdraw: "Withdraw the mark"
    }[k];
  }
  function formReady(): boolean {
    const k = panel?.kind;
    if (!k) return false;
    if (["dispute", "ask", "grade", "refund"].includes(k) && !draft.callId) return false;
    if (k === "dispute") return claimReady && reasonReady;
    if (k === "move") return reasonReady && (!decided || outcomeReady);
    if (k === "note") return reasonReady;
    if (k === "papers") return reasonReady && !!draft.file;
    if (k === "retire") return reasonReady;
    if (["dispute_refund", "refund"].includes(k)) return sentenceReady && !!draft.amount.trim();
    if (k === "propose") return sentenceReady;
    if (k === "decline" || k === "void") return declineReady;
    if (k === "ask") return true;
    if (k === "answer") return !!draft.score;
    if (k === "grade") return markReady;
    if (k === "respond") return responseReady;
    return reasonReady;
  }
  function whyNotReady(): string {
    const k = panel?.kind;
    if (!k) return "";
    if (["dispute", "ask", "grade", "refund"].includes(k) && !draft.callId) {
      return "Find the incidence and pick it first — the number is copied off the call, not typed.";
    }
    if (k === "dispute") return claimReady ? "Say why this belongs in the register — 4 characters."
      : "The claim needs at least 10 characters.";
    if (k === "move") return decided && !outcomeReady
      ? "A decided dispute needs the finding in writing: 8 characters at least."
      : "Say why it moves — 4 characters.";
    if (k === "papers") return draft.file ? "Say why this paper belongs on the dispute."
      : "Choose a JPEG, PNG, WebP or PDF first.";
    if (k === "retire" || k === "note") return "Say why — 4 characters.";
    if (["dispute_refund", "refund"].includes(k)) return sentenceReady
      ? "Name the figure." : "A second seat signs this sentence: 8 characters at least.";
    if (k === "propose") return "Say what is being signed — 8 characters.";
    if (k === "decline") return "Give the reason the paper is not paid — 8 characters.";
    if (k === "void") return "Say why a released paper was never paid — 8 characters.";
    if (k === "answer") return "Choose the mark the caller gave.";
    if (k === "grade") {
      if (!draft.seat) return "Choose the seat that handled the call.";
      if (draft.result !== band) return `The ticks score ${preview}, which is ${bandWords[band]}.`;
      if (draft.result !== "met" && draft.note.trim().length < 8) return "A short mark needs the coach's line.";
      return "Fill the form in.";
    }
    if (k === "respond") return "The answer needs at least 4 characters.";
    return "";
  }
  /** Whether this panel is one of the irreversible acts and has not yet been confirmed. */
  function isArmed(): boolean {
    return !!panel && ARMS.includes(panel.kind) && armed === armKey(panel);
  }
  async function press() {
    if (!panel || !formReady()) return;
    if (ARMS.includes(panel.kind) && armed !== armKey(panel)) { setArmed(armKey(panel)); return; }
    await submit();
  }
  /** What the desk says back after a write. `send` has already re-read the tab and the board, so
   *  this is the one line the register gave that the operator could not have worked out. */
  async function submit() {
    const k = panel?.kind;
    if (!k || !formReady()) return;
    let j: any = null;
    if (k === "dispute") {
      j = await send("disputes", {
        ticketId: draft.callId, ground: draft.ground, claim: draft.claim.trim(),
        reason: draft.reason.trim(),
        ...(draft.amount.trim() ? { amount: Number(draft.amount), currency: draft.currency } : {})
      });
      if (j) setNotice(`${j.ref} is on the register against ${j.ticket_ref ?? "that call"}.`);
    } else if (k === "move" && panel!.id) {
      j = await send(`disputes/${panel!.id}/status`, {
        to: draft.to, reason: draft.reason.trim(),
        ...(decided ? { outcome: draft.outcome.trim() } : {})
      });
      if (j) setNotice(`${j.ref ?? panel!.ref} is now ${label(DISPUTE_STATES, j.status ?? draft.to)}.`);
    } else if (k === "note" && panel!.id) {
      j = await send(`disputes/${panel!.id}/note`, { reason: draft.reason.trim() });
      if (j) setNotice("The line is on the file.");
    } else if (k === "papers" && sheet) {
      const fd = new FormData();
      fd.append("reason", draft.reason.trim());
      if (draft.file) fd.append("file", draft.file, draft.file.name);
      j = await send(`disputes/${sheet.id}/papers`, undefined, fd);
      if (j) setNotice(`“${j.file_name}” is filed under ${sheet.ref}. A finding can now stand on it.`);
    } else if (k === "retire" && sheet && panel!.docId) {
      j = await send(`disputes/${sheet.id}/papers/${panel!.docId}/retire`,
        { reason: draft.reason.trim() });
      if (j) setNotice(`“${j.file_name ?? panel!.fileName}” is off the file.`);
    } else if (k === "dispute_refund" && panel!.id) {
      j = await send(`disputes/${panel!.id}/refund`, {
        amount: Number(draft.amount), currency: draft.currency, payBack: draft.payBack,
        reason: draft.reason.trim()
      });
      if (j) setNotice(`${j.ref} is raised. Ask a seat that did not write it to sign it.`);
    } else if (k === "refund") {
      j = await send("refunds", {
        ticketId: draft.callId, ...(panel!.id ? { disputeId: panel!.id } : {}),
        amount: Number(draft.amount), currency: draft.currency, payBack: draft.payBack,
        reason: draft.reason.trim()
      });
      if (j) setNotice(`${j.ref} is raised against ${j.ticket_ref ?? "the call"}.`);
    } else if (k === "propose" && panel!.id) {
      j = await send(`refunds/${panel!.id}/propose`, { reason: draft.reason.trim() });
      if (j) setNotice("A second seat has been asked to sign. Nothing is paid until they do, "
        + "and they sign it on the Approvals desk, not here.");
    } else if (k === "decline" && panel!.id) {
      j = await send(`refunds/${panel!.id}/decline`, { note: draft.decline.trim() });
      if (j) setNotice(`${j.ref ?? panel!.ref} is refused, and the answer went on the paper.`);
    } else if (k === "void" && panel!.id) {
      j = await send(`refunds/${panel!.id}/void`, { note: draft.decline.trim() });
      if (j) setNotice(`${j.ref ?? panel!.ref} is voided.`);
    } else if (k === "ask") {
      j = await send("satisfaction", { ticketId: draft.callId, askedChannel: draft.askedChannel });
      if (j) setNotice(`The question is asked on ${j.ticket_ref ?? "the call"}.`);
    } else if (k === "answer" && panel!.id) {
      j = await send(`satisfaction/${panel!.id}/answer`, {
        score: Number(draft.score),
        ...(draft.word.trim() ? { word: draft.word.trim() } : {}),
        ...(draft.recommends ? { recommends: draft.recommends === "yes" } : {})
      });
      if (j) setNotice(`${j.ticket_ref ?? panel!.ref} is answered at ${j.score} out of 5.`);
    } else if (k === "grade") {
      j = await send("quality", {
        ticketId: draft.callId, reviewedSeat: draft.seat, checks: draft.checks,
        result: draft.result, ...(draft.note.trim() ? { note: draft.note.trim() } : {})
      });
      if (j) setNotice(`Marked ${j.score} — ${label(RESULTS, j.result)}. `
        + "The register worked that out of the six ticks.");
    } else if (k === "respond" && panel!.id) {
      j = await send(`quality/${panel!.id}/response`, {
        response: draft.response.trim(),
        // A desk recording an answer has to name the seat it came from; the graded seat does not.
        ...(panel!.mine ? {} : { seat: panel!.seatId })
      });
      if (j) setNotice(`The seat's side is on the mark for ${j.ticket_ref ?? panel!.ref}.`);
    } else if (k === "withdraw" && panel!.id) {
      j = await send(`quality/${panel!.id}/withdraw`, { reason: draft.reason.trim() });
      if (j) setNotice("The mark is off the board. It stays on the register as a withdrawn line.");
    }
    // A sheet that is open shows the state before the write, so it is re-read from the register
    // rather than patched from the reply — the same reason the board above is re-read.
    if (j) {
      if (sheet) openDispute(sheet.id);
      if (paper) openPaper(paper.id);
    }
  }
}


// ============================================================
// the two detail sheets, the picker and the small parts
// ============================================================

function Chip({ edge, children }: { edge: string; children: React.ReactNode }) {
  return (
    <span className={chip} style={{ border: `1px solid ${edge}`, color: edge === "var(--ink-soft)"
      ? "var(--ink-soft)" : edge }}>
      {children}
    </span>
  );
}

const mini = "min-h-[32px] rounded-input border px-10 py-4 text-[11px] font-semibold";
const miniStyle = { borderColor: "var(--line)", color: "var(--ink)" };

function CallPicker({ draft, setDraft, calls, busy, search, pick, hint }: {
  draft: Draft; setDraft: (d: Draft) => void; calls: CallRow[] | null; busy: boolean;
  search: (term: string) => void; pick: (c: CallRow) => void; hint: string;
}) {
  const chosen = calls?.find((c) => c.id === draft.callId);
  return (
    <div className="mt-14 rounded-card border p-14" style={{ borderColor: "var(--line)" }}>
      <p className={`${labelText} font-semibold uppercase tracking-[0.12em]`} style={{ color: "var(--ink-soft)" }}>
        Which call this stands on
      </p>
      <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>{hint}</p>
      <div className="mt-10 flex flex-wrap items-end gap-10">
        <label className={`${labelText} min-w-[min(100%,240px)] flex-1 block`} style={{ color: "var(--ink-soft)" }}>
          Incidence number, subject or company
          <input value={draft.callQuery} onChange={(e) => setDraft({ ...draft, callQuery: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(draft.callQuery); } }}
            placeholder="CS-2026- or Amina" className={box} style={boxStyle} />
        </label>
        <button type="button" onClick={() => search(draft.callQuery)} disabled={busy}
          className={`${headBtn} mb-4`} style={{ borderColor: "var(--adm-accent)", color: "var(--ink)" }}>
          {busy ? "Searching…" : "Find the call"}
        </button>
      </div>
      {chosen && (
        <p className="mt-12 text-sm" style={{ color: "var(--ink)" }}>
          Picked: <span className="font-bold">{chosen.ref}</span> · {chosen.subject} ·{" "}
          {chosen.company_name ?? "no company"} —{" "}
          <Chip edge={chosen.status === "resolved" || chosen.status === "closed"
            ? "var(--success)" : "var(--warning)"}>{label(CALL_STATES, chosen.status)}</Chip>
        </p>
      )}
      {calls && calls.length === 0 && (
        <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
          Nothing on the register answers to that. Try the incidence number exactly, or write the call into{" "}
          <Link href="/control/tickets" className="underline" style={{ color: "var(--adm-accent)" }}>the call desk</Link>{" "}
          first — a dispute with no call under it is not a dispute anybody can check.
        </p>
      )}
      {calls && calls.length > 0 && (
        <ul className="mt-12 max-h-[320px] overflow-y-auto">
          {calls.map((c) => (
            <li key={c.id} className="border-b py-10" style={{ borderColor: "var(--line)" }}>
              <button type="button" onClick={() => pick(c)}
                className="w-full text-left"
                style={{ color: c.id === draft.callId ? "var(--adm-accent)" : "var(--ink)" }}>
                <span className="text-sm font-semibold">{c.ref}</span>
                <span className="ml-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {label(CALL_WAYS, c.channel)} · {label(CALL_STATES, c.status)} ·{" "}
                  {c.company_name ?? "no company"}
                </span>
                <span className="mt-4 block break-words text-xs" style={{ color: "var(--ink-soft)" }}>
                  {c.subject}
                </span>
                <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {c.disputes ?? 0} disputes · {c.asked ?? 0} asked · {c.marks ?? 0} marks · opened {day(c.ts)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Block({ head, hint, children }: {
  head: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border p-14" style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
        {head}
      </p>
      {hint && <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>{hint}</p>}
      {children}
    </div>
  );
}

const line = "border-b py-10 last:border-b-0";

type SheetProps = {
  sheet: DisputeSheet; panel: Panel | null; openPanel: (p: Panel, s?: Partial<Draft>) => void;
  canManage: boolean; canPay: boolean; busy: boolean; panelError: string | null;
  close: () => void; readPaperFile: (id: string, name: string) => void;
  openPaper: (id: string) => void;
};

function DisputeSheetView({ sheet, panel, openPanel, canManage, canPay, busy, panelError,
  close, readPaperFile, openPaper }: SheetProps) {
  const live = sheet.status === "open" || sheet.status === "investigating";
  return (
    <section id="dispute-sheet" className="mt-24 rounded-card border p-20"
      style={{ borderColor: DISPUTE_EDGE[sheet.status] ?? "var(--line)", background: "var(--surface)" }}>
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-8 text-base font-bold" style={{ color: "var(--ink)" }}>
            <Chip edge={DISPUTE_EDGE[sheet.status]}>{label(DISPUTE_STATES, sheet.status)}</Chip>
            {sheet.ref}
          </h2>
          <p className="mt-8 break-words text-sm" style={{ color: "var(--ink)" }}>{sheet.claim}</p>
          <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>
            {label(GROUNDS, sheet.ground)} · {sheet.amount ? cash(sheet.amount, sheet.currency) : "no figure claimed"}
            {" · "}
            <Link href="/control/tickets" className="underline" style={{ color: "var(--adm-accent)" }}>
              {sheet.ticket_ref}</Link>{" "}
            on {sheet.department_name ?? sheet.ticket_dept_ref ?? "the queue"} · call is {sheet.ticket_status ?? "—"}
          </p>
        </div>
        <div className="text-right text-xs" style={{ color: "var(--ink-soft)" }}>
          <p>opened {when(sheet.opened_at)}</p>
          <p className="mt-4 font-semibold" style={{ color: "var(--ink)" }}>by {sheet.opened_name ?? "—"}</p>
          {sheet.decided_at && (
            <p className="mt-4">decided {when(sheet.decided_at)} by {sheet.decided_name ?? "—"}</p>
          )}
          <button type="button" onClick={close} className={`${headBtn} mt-12`}
            style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
            Close the file
          </button>
        </div>
      </div>

      {sheet.outcome && (
        <div className="mt-14 rounded-card border p-14"
          style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
            The finding, as it was signed
          </p>
          <p className="mt-8 whitespace-pre-line break-words text-sm" style={{ color: "var(--ink)" }}>
            {sheet.outcome}
          </p>
        </div>
      )}

      {panelError && (
        <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
          {panelError}
        </div>
      )}

      <div className="mt-14 flex flex-wrap gap-10">
        {canManage && !sheet.decided_at && (
          <>
            <button type="button" disabled={busy}
              onClick={() => openPanel({ kind: "move", id: sheet.id, ref: sheet.ref },
                { to: sheet.status === "open" ? "investigating" : sheet.status })}
              className="waisha-btn min-h-[36px] rounded-input px-16 py-8 text-xs font-semibold">
              {panel?.kind === "move" && panel.id === sheet.id ? "Close that form" : "Move or decide it"}
            </button>
            <button type="button" disabled={busy}
              onClick={() => openPanel({ kind: "note", id: sheet.id, ref: sheet.ref })}
              className={headBtn} style={miniStyle}>Add a line</button>
            <button type="button" disabled={busy}
              onClick={() => openPanel({ kind: "papers", id: sheet.id }, { file: null })}
              className={headBtn} style={miniStyle}>
              {panel?.kind === "papers" && panel.id === sheet.id ? "Close the filing form" : "File a paper"}
            </button>
            {!sheet.refund_request_id && live && canPay && (
              <button type="button" disabled={busy}
                onClick={() => openPanel({ kind: "dispute_refund", id: sheet.id, ref: sheet.ref },
                  { amount: sheet.amount ?? "", currency: sheet.currency ?? "TZS" })}
                className={headBtn} style={miniStyle}>
                Raise a refund paper
              </button>
            )}
            {!sheet.refund_request_id && live && !canPay && (
              <span className="self-center text-[11px]" style={{ color: "var(--ink-soft)" }}>
                A refund paper also needs <code>control.payments.manage</code>.
              </span>
            )}
          </>
        )}
        {canManage && sheet.decided_at && (
          <button type="button" disabled={busy}
            onClick={() => openPanel({ kind: "note", id: sheet.id, ref: sheet.ref })}
            className={headBtn} style={miniStyle}>Add a line</button>
        )}
      </div>
      {!canManage && (
        <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          You can read this file and every line on it. Opening, moving and filing need{" "}
          <code>control.service.manage</code>.
        </p>
      )}

      {live && sheet.files.length === 0 && (
        <p className="mt-12 text-[11px]" style={{ color: "var(--warning)" }}>
          Nothing is filed under this dispute. The register will not let it be upheld or settled until a paper
          says what the finding stands on.
        </p>
      )}

      {/* What is filed, what the file has asked for, and every line the register wrote on it. */}
      <div className="mt-16 grid gap-16"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <Block head={`Papers filed under it · ${sheet.files.length}`}
          hint="Each one is read through this desk. The duty that opens the dispute is the duty that opens the file.">
          {sheet.files.length === 0 ? (
            <p className="mt-10 text-xs" style={{ color: "var(--ink-soft)" }}>Nothing filed yet.</p>
          ) : (
            <ul className="mt-10">
              {sheet.files.map((f) => (
                <li key={f.id} className={line} style={{ borderColor: "var(--line)" }}>
                  <p className="break-words text-xs font-semibold" style={{ color: "var(--ink)" }}>
                    {f.file_name}
                  </p>
                  <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {f.mime_type} · {size(f.size_bytes)} · filed {when(f.created_at)} by{" "}
                    {f.uploaded_name ?? "—"}
                  </p>
                  <span className="mt-8 flex flex-wrap gap-8">
                    <button type="button" disabled={busy} onClick={() => readPaperFile(f.id, f.file_name)}
                      className={mini}>Read it</button>
                    {canManage && (
                      <button type="button" disabled={busy}
                        onClick={() => openPanel({ kind: "retire", id: sheet.id, docId: f.id,
                          fileName: f.file_name })}
                        className={mini}>
                        {panel?.kind === "retire" && panel.docId === f.id ? "Close that form" : "Take it off"}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block head={`Refund papers it stands for · ${sheet.papers.length}`}
          hint="A figure leaves the register only when a second seat signs the paper this dispute raised.">
          {sheet.papers.length === 0 ? (
            <p className="mt-10 text-xs" style={{ color: "var(--ink-soft)" }}>
              This file has not asked for money.
            </p>
          ) : (
            <ul className="mt-10">
              {sheet.papers.map((p) => (
                <li key={p.id} className={line} style={{ borderColor: "var(--line)" }}>
                  <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>
                    {p.ref}{" "}
                    <Chip edge={PAPER_EDGE[p.request_status] ?? "var(--ink-soft)"}>
                      {label(PAPER_STATES, p.request_status)}
                    </Chip>
                  </p>
                  <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {cash(p.amount, p.currency)} · {label(PAY_BACK, p.pay_back)} · raised{" "}
                    {when(p.raised_at)} by {p.raised_name ?? "—"}
                  </p>
                  <button type="button" disabled={busy} onClick={() => openPaper(p.id)}
                    className={`${mini} mt-8`}>
                    Open the paper
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block head={`Every line on it · ${sheet.events.length}`}
          hint="Oldest first. The register writes these as the file moves and nothing on a desk takes a line back off.">
          <ol className="mt-10">
            {sheet.events.map((e) => (
              <li key={e.id} className={line} style={{ borderColor: "var(--line)" }}>
                <p>
                  <Chip edge={EVENT_EDGE[e.action] ?? "var(--ink-soft)"}>
                    {label(ACTIONS, e.action)}
                  </Chip>{" "}
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {when(e.ts)} · {e.actor_name ?? "the register"}
                  </span>
                </p>
                {e.from_label && (
                  <p className="mt-4 text-[11px]" style={{ color: "var(--ink)" }}>
                    {e.from_label} → {e.to_label ?? "—"}
                  </p>
                )}
                {e.reason && (
                  <p className="mt-4 break-words text-[11px]" style={{ color: "var(--ink)" }}>
                    {e.reason}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </Block>
      </div>
    </section>
  );
}

type PaperProps = {
  paper: PaperSheet; panel: Panel | null; openPanel: (p: Panel, s?: Partial<Draft>) => void;
  canManage: boolean; canPay: boolean; canDecide: boolean; busy: boolean;
  panelError: string | null; close: () => void; openDispute: (id: string) => void;
};

function PaperSheetView({ paper, panel, openPanel, canManage, canPay, canDecide, busy,
  panelError, close, openDispute }: PaperProps) {
  const sig = paper.signature;
  const waiting = paper.status === "pending_signature";
  const lapsed = !!sig?.approval_expires_at
    && new Date(sig.approval_expires_at).getTime() < Date.now();
  const canAsk = canManage && canPay && ["raised", "pending_signature"].includes(paper.status);
  const canRefuse = (waiting && canDecide)
    || (paper.status === "raised" && canManage && canPay);
  const canVoid = canPay && paper.status === "released";
  return (
    <section id="paper-sheet" className="mt-24 rounded-card border p-20"
      style={{ borderColor: PAPER_EDGE[paper.status] ?? "var(--line)", background: "var(--surface)" }}>
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div className="min-w-0">
          <h2 className="flex flex-wrap items-center gap-8 text-base font-bold" style={{ color: "var(--ink)" }}>
            <Chip edge={PAPER_EDGE[paper.status] ?? "var(--ink-soft)"}>
              {label(PAPER_STATES, paper.status)}
            </Chip>
            {paper.ref}
          </h2>
          <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>
            {cash(paper.amount, paper.currency)}
          </p>
          <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
            {label(PAY_BACK, paper.pay_back)} · for {paper.company_name ?? "a caller"} · raised{" "}
            {when(paper.raised_at)} by {paper.raised_name ?? "—"}
          </p>
        </div>
        <div className="text-right">
          <button type="button" onClick={close} className={`${headBtn}`}
            style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
            Close the paper
          </button>
        </div>
      </div>

      <p className="mt-14 whitespace-pre-line break-words text-sm" style={{ color: "var(--ink)" }}>
        {paper.reason}
      </p>

      <div className="mt-14 rounded-card border p-14"
        style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          What it stands on
        </p>
        <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
          Call{" "}
          <Link href="/control/tickets" className="underline" style={{ color: "var(--adm-accent)" }}>
            {paper.ticket_ref}</Link>
          {paper.dispute_id ? (
            <> · dispute {paper.dispute_ref ?? "—"} (
              {label(DISPUTE_STATES, paper.dispute_status)}{" "}</>
          ) : " · raised straight from the call, with no dispute under it"}
        </p>
        {paper.dispute_id && (
          <button type="button" disabled={busy} onClick={() => openDispute(paper.dispute_id!)}
            className={`${mini} mt-8`} style={{ borderColor: "var(--line)" }}>
            Open the dispute file
          </button>
        )}
      </div>

      {panelError && (
        <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)",
            borderLeft: "4px solid var(--warning)" }}>
          {panelError}
        </div>
      )}

      <div className="mt-14 rounded-card border p-14"
        style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          The signature
        </p>
        {!sig && paper.status === "raised" && (
          <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
            Nothing has been asked of a second seat yet. Until it is, this paper is a request on a
            file, not money on its way.
          </p>
        )}
        {sig && (
          <ul className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
            <li className={line} style={{ borderColor: "var(--line)" }}>
              Approval on the register: <span className="font-semibold">{sig.approval_status ?? "—"}</span>
            </li>
            {sig.approval_proposed_name && (
              <li className={line} style={{ borderColor: "var(--line)" }}>
                Asked of {sig.approval_proposed_name}
              </li>
            )}
            {sig.approval_expires_at && (
              <li className={line} style={{ borderColor: "var(--line)" }}>
                The window lapses {when(sig.approval_expires_at)}{" "}
                <span style={{ color: lapsed ? "var(--danger)" : "var(--ink-soft)" }}>
                  ({lapsed ? "lapsed — the ask has to be made again" : `${age(sig.approval_expires_at)} old`})
                </span>
              </li>
            )}
            {sig.signed_at && (
              <li className={line} style={{ borderColor: "var(--line)" }}>
                Signed by {sig.signed_name ?? "a second seat"} {when(sig.signed_at)}
              </li>
            )}
            {sig.payload_sha256 && (
              <li className="py-10 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                The bytes that were shown to the seat that signed:{" "}
                <code className="break-all">{sig.payload_sha256}</code>
              </li>
            )}
          </ul>
        )}
        {paper.released_at && (
          <p className="mt-10 text-xs" style={{ color: "var(--success)" }}>
            Released {when(paper.released_at)} by {paper.released_name ?? "the ledger"}. This desk
            records the release — it cannot pay it.
          </p>
        )}
        {paper.declined_note && (
          <p className="mt-10 text-xs" style={{ color: "var(--danger)" }}>
            Refused by {paper.declined_name ?? "a seat with the duty"}: {paper.declined_note}
          </p>
        )}
        {paper.void_note && (
          <p className="mt-10 text-xs" style={{ color: "var(--ink-soft)" }}>
            Voided after release: {paper.void_note}
          </p>
        )}
        <p className="mt-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          Money leaves the register on the approvals desk, never here.{" "}
          <Link href="/control/approvals" className="underline" style={{ color: "var(--adm-accent)" }}>
            Open the approval register</Link>.
        </p>
      </div>

      <div className="mt-14 flex flex-wrap gap-10">
        {canAsk && (
          <button type="button" disabled={busy}
            onClick={() => openPanel({ kind: "propose", id: paper.id, ref: paper.ref })}
            className="waisha-btn min-h-[36px] rounded-input px-16 py-8 text-xs font-semibold">
            {panel?.kind === "propose" && panel.id === paper.id
              ? "Close that form" : waiting ? "Ask a seat again" : "Ask a seat to sign"}
          </button>
        )}
        {canRefuse && (
          <button type="button" disabled={busy}
            onClick={() => openPanel({ kind: "decline", id: paper.id, ref: paper.ref })}
            className={headBtn} style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
            {panel?.kind === "decline" && panel.id === paper.id ? "Close that form" : "Refuse this paper"}
          </button>
        )}
        {canVoid && (
          <button type="button" disabled={busy}
            onClick={() => openPanel({ kind: "void", id: paper.id, ref: paper.ref })}
            className={headBtn} style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
            {panel?.kind === "void" && panel.id === paper.id ? "Close that form" : "Void a paper nobody paid"}
          </button>
        )}
      </div>
      {!canAsk && !canRefuse && !canVoid && (
        <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          Nothing on this paper can be changed by the duties you hold. Asking a seat to sign needs{" "}
          <code>control.service.manage</code> and <code>control.payments.manage</code>; refusing a
          paper that is waiting needs <code>control.approvals.decide</code>.
        </p>
      )}
    </section>
  );
}

function List({ loading, empty, emptyWords, head, rows }: {
  loading: boolean; empty: boolean; emptyWords: string; head: string[];
  rows: React.ReactNode[][];
}) {
  if (loading) {
    return <p role="status" className="mt-16 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the register…</p>;
  }
  if (empty) {
    return (
      <div className="mt-16 rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
        <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{emptyWords}</p>
      </div>
    );
  }
  return (
    <div className="mt-14 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--line)" }}>
            {head.map((h) => (
              <th key={h} className="px-10 py-8 text-left font-semibold uppercase tracking-[0.1em]"
                style={{ color: "var(--ink-soft)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="align-top" style={{ borderBottom: "1px solid var(--line)" }}>
              {cells.map((c, j) => <td key={j} className="px-10 py-10" style={{ color: "var(--ink)" }}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `total` is the count each list SQL carries on its own first row: the rows the filter matched,
 *  not the rows on this page. A desk that reads 30 of 214 papers has to be able to say 214. */
function Pager({ filter, setFilter, total }: {
  filter: { limit: string; offset: string } & Record<string, string>;
  setFilter: (f: any) => void; total: number;
}) {
  const limit = Number(filter.limit);
  const offset = Number(filter.offset);
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="mt-16 flex flex-wrap items-center gap-10">
      <button type="button" disabled={offset === 0}
        onClick={() => setFilter({ ...filter, offset: String(Math.max(0, offset - limit)) })}
        className={headBtn} style={miniStyle}>Newer</button>
      <span className="text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
        {total} rows · page {page} of {pages}
      </span>
      <button type="button" disabled={offset + limit >= total}
        onClick={() => setFilter({ ...filter, offset: String(offset + limit) })}
        className={headBtn} style={miniStyle}>Older</button>
      <select value={filter.limit} aria-label="Rows per page"
        onChange={(e) => setFilter({ ...filter, limit: e.target.value, offset: "0" })}
        className="rounded-input border px-10 py-6 text-xs" style={boxStyle}>
        {[10, 30, 60, 100].map((n) => <option key={n} value={String(n)}>{n} a page</option>)}
      </select>
    </div>
  );
}
