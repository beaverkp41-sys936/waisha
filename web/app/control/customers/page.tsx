"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";
import {
  ACCOUNT_STATES, ANSWERS, BAND_EDGE, BAND_LABELS, BOARD_STATES, CHECK_EDGE, CHECK_KINDS,
  CHECK_STATE_LABELS, EXPIRING_KINDS, KIND_LABELS, KIND_SHAPES, OPEN_STATES, TIMELINE_SOURCES,
  expiresOnKind, isOpenState, referenceLooksRight, referenceTail, type CheckKind
} from "./checks";
import {
  ASKED_IN_EXAMPLES, BOARD_CHIPS, CATEGORIES, CATEGORY_LABELS, DATA_REQUEST_KINDS, EXPORT_SECTION_COUNT,
  KIND_SENTENCES, REASON_FLOOR, REQUEST_STATUSES, STATUS_EDGE, STATUS_LABELS,
  categoriesAllowedFor, categoryList, categoryWord, erasedCount, isOpenRequest, kindWord as drKindWord,
  maskWords, shaWords, statusWord as drStatusWord, type DataRequestKind
} from "./data-requests";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/**
 * The Customers desk (127; task #342) — who an account is, what the office has looked at, and
 * what all of that is worth at the moment the question was asked.
 *
 * Four registers, one account at the centre of each: the **board** answers "who is not clear",
 * the **checks** queue answers "what does the office still owe a decision on", the **notes** tab is
 * the office's own prose about an account, and the **labels** tab is the words it marks accounts
 * with. Opening any row brings up the dossier — one account with its trust read, its filed papers
 * and its story — and every act on this desk is opened from there or from the row it belongs to.
 *
 * The rules are the register's, not this page's. An answer cannot be edited into a different
 * answer, an approval cannot be written on a line with no number behind it, a day only belongs on
 * the three kinds that lapse, a note keeps its author, a label cannot leave the library while
 * accounts still wear it. Each of those is a CHECK or a trigger in 127, so where this page stops a
 * person early it says so in the register's own words, and where the register refuses it prints
 * the refusal rather than a generic "something went wrong".
 *
 * Two things this desk deliberately cannot do, and the buttons say so:
 *
 * **It cannot stop a company trading.** A block is raised on `/control/approvals` and applied by a
 * second seat's signature. A check answers "is this paper what it says it is" — one seat, because
 * the answer is terminal, it names who gave it, and re-checking opens a new line beside the old
 * one instead of replacing it.
 *
 * **It cannot show a whole identity number by accident.** Every read here carries a four-character
 * tail. The value itself comes from one route, costs the duty that answers checks, is limited to
 * twelve reads an hour, and is written into the audit register as it happens — which is why the
 * panel that does it asks twice and then says out loud that it was recorded.
 *
 * Two more things the register does not pretend, both of them 128's:
 *
 * **A claim is not a merge.** Around seventy foreign keys and forty per-tenant unique indexes point
 * at `tenants`, and 127 freezes an account's answered checks against its own row, so nothing here
 * moves a company's history. A claim records which account carries on, carries the *unanswered*
 * checks onto it as new lines that still have to be checked, and lists what stayed behind.
 *
 * **A cut-off ends sessions, not an account.** An access token is a signed key with no row behind
 * it, so it stays usable for up to fifteen minutes; the desk says so in the same breath as the
 * count, and points at the two-seat block on the tenants desk for anything shorter.
 *
 * And one thing 129 added, which is why this desk has a sixth tab:
 *
 * **A copy is handed over, an erasure is signed.** When a caller asks what the platform holds about
 * them, this desk raises the paper, reads the preview the mask itself will read, and hands the
 * archive over — the bytes leaving as a hashed bundle, the register counting every hand-off. When
 * they ask for it to be taken away, the desk may only write the paper and ask a second seat to sign
 * it: the mask runs from `/control/approvals`, in the transaction that spends a signature the
 * proposer cannot give. Those two acts sit behind `control.customers.gdpr` and
 * `control.customers.erase`, and the tab does not appear for a desk holding neither.
 */

// ---------- the vocabulary (web/app/control/customers/checks.ts mirrors the API and the table) ----------

const label = (list: [string, string][], key: string | null | undefined) =>
  list.find(([k]) => k === key)?.[1] ?? key ?? "—";
const kindWord = (k: string | null | undefined) =>
  k ? KIND_LABELS[k as CheckKind] ?? k : "—";
const stateWord = (s: string | null | undefined) =>
  s ? CHECK_STATE_LABELS[s] ?? s : "—";

/** The acts that cannot be taken back on the other side of the button: a terminal answer, a note
 *  withdrawn, a label taken off or retired, a number copied onto a screen, a pair of accounts
 *  declared one account, every session on an account ended, a signature asked for on an erasure and
 *  an ask refused. These ask for a second press; everything else writes on the first. */
const ARMS: Panel["kind"][] = ["answer", "void", "retire", "off", "reveal", "claim", "voidclaim",
  "cut", "sig", "refuse"];
const armKey = (p: Panel) => `${p.kind}:${p.id ?? ""}:${p.tagId ?? ""}`;

const EXPIRING_WORDS = EXPIRING_KINDS.map((k) => KIND_LABELS[k].toLowerCase()).join(", or ");

// ---------- formats ----------

const when = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const day = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—";
const age = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 0)} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h`;
  const d = Math.round(mins / 1440);
  return d < 30 ? `${d} d` : `${Math.round(d / 30)} mo`;
};
/** A `date` column arrives as a plain ISO day from the definer; parsed at noon so a register west
 *  of Greenwich cannot read it as the day before (094). */
const dayPast = (iso: string | null | undefined) => {
  if (!iso) return false;
  const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
  return d.getTime() < Date.now();
};
const size = (bytes: number | null | undefined) => !bytes ? "—"
  : bytes > 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** A refusal the register wrote for the person at the desk, printed in its own words. */
function errorMessage(j: any, fallback: string) {
  const m = j?.error?.message;
  if (typeof m === "string" && m.trim()) return m;
  const first = j?.error?.details?.[0];
  if (first?.field) return `${first.field}: ${j?.error?.message ?? "the register refused it"}`;
  return fallback;
}

// ---------- shapes the reads answer with ----------

type Trust = {
  status?: string; company_id?: string; name?: string; account_status?: string;
  score?: number; band?: string; base?: number; clock?: string;
  factors?: { label: string; points: number; detail: string }[];
  basis?: Record<string, number>;
};
type BoardRow = {
  company_tenant_id: string; name: string; type: string; account_status: string; slug: string;
  created_at: string; trial_ends_at: string | null; licence_expires_at: string | null;
  plan_name: string | null; seats_licensed: number; seats: number;
  checks: { lines: number; approved: number; open: number; refused: number; expired: number };
  tags: { id: string; name: string; colour: string }[];
  blocked_note: string | null; last_note: string | null; trust: Trust | null;
};
type Board = {
  status: string; total: number; limit: number; offset: number; rows: BoardRow[];
  facets?: { accounts?: number; never_checked?: number; checks?: Record<string, number> };
  clock?: string;
};
type CheckRow = {
  id: string; kind: string; status: string; reference_tail: string | null;
  expires_on: string | null; reason: string | null; document_id: string | null;
  raised_at: string; raised_name: string | null; decided_at: string | null;
  decided_name: string | null; company_tenant_id: string; company_name: string;
  company_type: string; has_reference: boolean; total?: number;
};
type CheckCounts = {
  total: number; awaiting: number; submitted: number; approved: number; refused: number;
  awaiting_more: number; expired: number; accounts: number;
};
type NoteRow = {
  id: string; body: string; created_at: string; edited_at: string | null;
  voided_at: string | null; void_reason: string | null; company_tenant_id: string;
  author_name: string | null; voided_by_name: string | null; company_name: string;
  company_type: string; total?: number;
};
type NoteCounts = { total: number; live: number; withdrawn: number; edited: number; accounts: number };
type TagRow = {
  id: string; name: string; colour: string | null; note: string | null; created_at: string;
  deleted_at: string | null; live: number; worn: number; total?: number;
};
type TagCounts = { in_library: number; live: number; retired: number };
type Wearer = {
  tagging_id: string; company_tenant_id: string; applied_at: string; company_name: string;
  company_type: string; account_status: string; applied_by_name: string | null;
};
type Account = {
  id: string; name: string; type: string; account_status: string; slug: string; created_at: string;
  open_checks: number; approved: number; notes: number; labels: number;
};
/** A tombstone. It has no check counts because 128 refuses a claim whose survivor is closed and the
 *  loser's own lines stay behind on its file — the list only has to name the account. */
type ClosedAccount = {
  id: string; name: string; type: string; account_status: string; slug: string;
  created_at: string; deleted_at: string;
};
type Line = {
  id: string; kind: string; status: string; reason: string | null;
  reference_tail: string | null; document_id: string | null; raised_at: string;
  expires_on: string | null; company_tenant_id: string; has_reference: boolean;
  raised_name: string | null; decided_at: string | null; decided_name: string | null;
  // The dossier answers this per line; the checks tab lists every line and cannot.
  is_current?: boolean;
};
type Dossier = {
  status: string; company: {
    id: string; name: string; type: string; account_status: string; slug: string | null;
    email: string | null; phone_on_file: boolean; tin_on_file: boolean; created_at: string;
    trial_ends_at: string | null; licence_expires_at: string | null; deleted_at: string | null;
    seats_licensed: number; plan_name: string | null;
  };
  profile: Record<string, any> | null;
  licences: { authority: string; title: string | null; licence_number: string | null; expiry_date: string | null }[];
  seats: { live: number; pending: number; last_login: string | null; sessions_live: number };
  actions: { action: string; reason_code: string | null; note: string | null; created_at: string; actor_kind: string }[];
  exit: { reason_code: string; note: string | null; created_at: string } | null;
  calls: { open: number; all: number; disputes: number; papers: number };
  checks: Line[];
  notes: {
    id: string; body: string; author_name: string | null; created_at: string;
    edited_at: string | null; voided_at: string | null; voided_by_name: string | null;
    void_reason: string | null;
  }[];
  // `id` is the label's own — the desk retires a pairing by that, not by the tagging row.
  tags: { id: string; tagging_id: string; name: string; colour: string | null;
    applied_at: string; applied_by_name: string | null }[];
  paper: { id: string; kind: string; file_name: string; mime_type: string; size_bytes: number; created_at: string }[];
  trust: Trust | null;
  clock: string;
};
type Timeline = { rows: { ts: string; source: string; title: string; detail: string | null; ref: string | null; actor: string | null }[] };

type ClaimRow = {
  id: string; status: string; reason: string; carried_kinds: string[]; raised_at: string;
  voided_at: string | null; void_reason: string | null; raised_name: string | null;
  voided_name: string | null; survivor_id: string; survivor_name: string; survivor_type: string;
  survivor_status: string; loser_id: string; loser_name: string; loser_type: string;
  loser_status: string; loser_closed_at: string | null; total?: number;
};
type ClaimCounts = { all: number; standing: number; withdrawn: number; carried: number };
/** `duplicate_preview` answers the six questions the trigger will ask, in its own order, so the
 *  sentence on the screen is the sentence the write would have raised. */
type Preview = {
  status: string;
  survivor: { id: string; name: string; type: string; account_status: string; closed_at: string | null };
  loser: { id: string; name: string; type: string; account_status: string; closed_at: string | null };
  eligible: boolean; refusal: string | null;
  carries: { kind: string; loser_status: string; loser_raised_at: string; loser_tail: string | null }[];
  skips: { kind: string; because: string }[];
  stays_behind: {
    checks_answered: number; checks_open: number; notes: number; labels: number; papers: number;
    calls: number; calls_open: number; disputes: number; refund_papers: number;
    cargo_files: number; seats: number; sessions_live: number;
  };
  already: { id: string; status: string; reason: string; raised_at: string;
    carried_kinds: string[]; direction: "same" | "reversed" }[];
  clock: string;
};
type SeatRow = {
  user_id: string; name: string | null; user_type: string; last_seen: string | null;
  ip: string | null; device: string; borrowed_by: string | null;
};
type Access = {
  status: string; company: { id: string; name: string; type: string; account_status: string;
    closed_at: string | null };
  sessions: SeatRow[]; live: number; borrowed_views: number; seats: number;
  cut_offs: { sessions_cut: number; last_at: string | null }; clock: string;
};

// ---------- 129: the copy and the erasure ----------

/** One paper on the data-request register, as `data_requests_board` rows it. The two counters a
 *  supervisory question is actually about — what the mask reached and what it was told to leave —
 *  travel with the row, so a desk never has to open a paper to know what it did. */
type RequestRow = {
  id: string; ref: string; kind: string; request_status: string; categories: string[] | null;
  reason: string; asked_in: string | null; company_id: string; company_name: string;
  company_closed_at: string | null; raised_at: string; raised_name: string | null;
  approval_status: string | null; approval_expires_at: string | null; payload_sha256: string | null;
  signed_name: string | null; erased_at: string | null; erased_name: string | null;
  erased_rows: Record<string, number> | null; kept: { key: string; label: string; rows: number }[] | null;
  deliveries: number; delivered_at: string | null; bundle_sha256: string | null;
  bundle_bytes: number | null; refused_at: string | null; refused_note: string | null;
  total?: number;
};
type RequestCounts = {
  all: number; raised: number; pending_signature: number; delivered: number; erased: number;
  refused: number; export: number; erase: number;
};
/** The whole paper, read through `data_request_detail` — what a second seat is shown before signing
 *  and what this desk reads back after a download. `status` is the paper's own state. */
type Paper = {
  status: string; id: string; ref: string; kind: string; categories: string[] | null;
  reason: string; asked_in: string | null;
  company: { id: string; name: string; type: string; account_status: string; closed_at: string | null };
  raised_at: string; raised_name: string | null; raised_role: string | null;
  approval_id: string | null; approval_status: string | null; approval_proposed_name: string | null;
  approval_expires_at: string | null; payload_sha256: string | null;
  signed_name: string | null; signed_at: string | null; signed_note: string | null;
  erased_at: string | null; erased_name: string | null;
  erased: Record<string, number> | null;
  keeps: { key: string; label: string; rows: number; because: string }[] | null;
  bundle_sha256: string | null; bundle_bytes: number | null; bundle_entries: number | null;
  deliveries: number; delivered_at: string | null; delivered_name: string | null;
  refused_at: string | null; refused_note: string | null; refused_name: string | null;
  open_slot: boolean; clock: string;
};
/** What a request would touch, read live off the registers by `data_request_preview`. The same two
 *  questions the mask will ask, in the mask's own words — the desk raises a paper from this screen. */
type DataPreview = {
  status: string; kind: string;
  company: { id: string; name: string; type: string; account_status: string; closed_at: string | null };
  eligible: boolean; refusal: string | null;
  masks: Record<string, Record<string, number>>;
  keeps: { key: string; label: string; rows: number; because: string }[];
  sessions_live: number; clock: string;
};

// ---------- tabs ----------

type Tab = "board" | "checks" | "notes" | "tags" | "claims" | "requests";
const TABS: [Tab, string][] = [
  ["board", "Accounts"], ["checks", "Checks"], ["notes", "The office's notes"], ["tags", "Labels"],
  ["claims", "Duplicate claims"], ["requests", "Copies and erasures"]
];
/** The export takes the register's own name for the tab (`board` is the accounts register). */
const EXPORT_REGISTER: Record<Tab, string> = {
  board: "accounts", checks: "checks", notes: "notes", tags: "tags", claims: "claims",
  requests: "requests"
};

// ---------- forms ----------

type Draft = {
  accountQuery: string; accountId: string; kind: CheckKind; status: string; reference: string;
  expiresOn: string; answer: string; reason: string; text: string; labelName: string;
  labelColour: string; labelNote: string; tagId: string; loserQuery: string; loserId: string;
  // 129: the ask's own kind, how the caller reached the office, the categories it ticks, and the
  // search box that finds a shut account (the ask needs one because an erasure only applies to a
  // closed account, while a copy is owed whether the account trades or not).
  askKind: DataRequestKind; askedIn: string; cats: string[]; closedQuery: string;
};
const EMPTY_DRAFT: Draft = {
  accountQuery: "", accountId: "", kind: "national_id", status: "awaiting", reference: "",
  expiresOn: "", answer: "approved", reason: "", text: "", labelName: "", labelColour: "#0e7490",
  labelNote: "", tagId: "", loserQuery: "", loserId: "",
  askKind: "export", askedIn: "", cats: [], closedQuery: ""
};
type Panel = {
  kind: "raise" | "paper" | "answer" | "reveal" | "note" | "edit" | "void" | "label"
    | "wear" | "off" | "retire" | "claim" | "voidclaim" | "cut" | "ask" | "sig" | "refuse";
  id?: string; companyId?: string; companyName?: string; ref?: string; tagId?: string;
  tagName?: string; checkKind?: CheckKind; lineStatus?: string; hasReference?: boolean;
  expiresOn?: string | null; body?: string;
  // 128: the pair a claim is being raised on, and the claim or account a withdrawal is about.
  loserName?: string; loserId?: string; carried?: string[]; live?: number;
  borrowedViews?: number; seats?: number;
  // 129: the paper a signature is being asked for or a refusal written on, and what it is about.
  requestKind?: string; requestStatus?: string; categories?: string[]; openSlot?: boolean;
};

const box = "mt-4 w-full rounded-input border px-10 py-8 text-sm";
const boxStyle = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" };
const labelText = "text-[11px]";
const headBtn = "min-h-[36px] rounded-input border px-14 py-8 text-xs font-semibold disabled:opacity-40";
const chip = "whitespace-nowrap rounded-input px-8 py-2 text-[10px] font-semibold";
const mini = "min-h-[36px] rounded-input border px-10 py-4 text-[11px] font-semibold";
const miniStyle = { borderColor: "var(--line)", color: "var(--ink)" };
const line = "border-b py-10 last:border-b-0";
const ACTION_EDGE: Record<string, string> = {
  block: "var(--danger)", unblock: "var(--success)", close: "var(--danger)",
  notice: "var(--adm-accent)", notify: "var(--adm-accent)"
};

export default function ControlCustomersPage() {
  const [me, setMe] = useState<any>(null);
  const [perms, setPerms] = useState<string[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [tab, setTab] = useState<Tab>("board");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [revealed, setRevealed] = useState<any | null>(null);

  const [board, setBoard] = useState<Board | null>(null);
  const [facets, setFacets] = useState<Board["facets"] | null>(null);
  const [facetsClock, setFacetsClock] = useState<string | null>(null);
  const [bFilter, setBFilter] = useState({
    search: "", tin: "", status: "", kind: "", limit: "25", offset: "0"
  });

  const [cRows, setCRows] = useState<CheckRow[]>([]);
  const [cCounts, setCCounts] = useState<CheckCounts | null>(null);
  const [cFilter, setCFilter] = useState({ status: "", kind: "", q: "", limit: "30", offset: "0" });

  const [nRows, setNRows] = useState<NoteRow[]>([]);
  const [nCounts, setNCounts] = useState<NoteCounts | null>(null);
  const [nFilter, setNFilter] = useState({ status: "", q: "", limit: "30", offset: "0" });

  const [tRows, setTRows] = useState<TagRow[]>([]);
  const [tCounts, setTCounts] = useState<TagCounts | null>(null);
  const [tFilter, setTFilter] = useState({ status: "", q: "", limit: "30", offset: "0" });

  const [kRows, setKRows] = useState<ClaimRow[]>([]);
  const [kCounts, setKCounts] = useState<ClaimCounts | null>(null);
  const [kFilter, setKFilter] = useState({ status: "", q: "", limit: "30", offset: "0" });

  // 129: the data-request register, the paper open on the desk and what an ask would touch.
  const [rRows, setRRows] = useState<RequestRow[]>([]);
  const [rCounts, setRCounts] = useState<RequestCounts | null>(null);
  const [rFilter, setRFilter] = useState({ status: "", kind: "", q: "", limit: "30", offset: "0" });
  const [paper, setPaper] = useState<Paper | null>(null);
  const [paperFor, setPaperFor] = useState<string | null>(null);
  const [dpreview, setDpreview] = useState<DataPreview | null>(null);
  const [dpBusy, setDpBusy] = useState(false);

  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [dossierFor, setDossierFor] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [tlSource, setTlSource] = useState("");
  const [wearers, setWearers] = useState<Wearer[] | null>(null);
  const [wearersTag, setWearersTag] = useState<TagRow | null>(null);

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [library, setLibrary] = useState<TagRow[] | null>(null);

  // 128: the closed half of a pair, what a claim would do, and who is in an account right now.
  const [closed, setClosed] = useState<ClosedAccount[] | null>(null);
  const [closedBusy, setClosedBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [access, setAccess] = useState<Access | null>(null);
  const [accessFor, setAccessFor] = useState<string | null>(null);
  // What the last cut-off actually said — the count and the fifteen-minute sentence. The seat list
  // re-reads the register afterwards, so the only place those words survive is here.
  const [lastCut, setLastCut] = useState<any | null>(null);

  const seq = useRef(0);
  // The claim form's preview has its own counter: it is re-read every time a half of the pair
  // changes, and a late answer about a pair the clerk has already changed must not be the one on
  // screen — the button is gated on it. The data-request form reads the same rule.
  const pseq = useRef(0);
  const qseq = useRef(0);
  // A paper is read on its own counter too. Raising a new one re-reads the register, and that
  // refresh still names the paper open *before* the write — if its answer is allowed to land after
  // the new paper has been put on the desk, the clerk is left looking at the previous ask while the
  // notice below tells them to go and sign this one.
  const dseq = useRef(0);

  const canView = perms.includes("control.customers.view");
  const canManage = perms.includes("control.customers.manage");
  const canVerify = perms.includes("control.customers.verify");
  const canMerge = perms.includes("control.customers.merge");
  const canDisconnect = perms.includes("control.customers.disconnect");
  // 129's two keys. `gdpr` opens the register, the preview and the copy — an archive holding the
  // account's contact book, its drivers and the office's notes, which is not a duty to hand to the
  // desk that answers the phone. `erase` raises the erasure and asks for a signature; spending one
  // belongs to whoever holds `control.approvals.decide`, and never to the seat that asked.
  const canGdpr = perms.includes("control.customers.gdpr");
  const canErase = perms.includes("control.customers.erase");

  // ---------- reads ----------

  /** The six numbers above every tab, counted over the whole register by asking the board for one
   *  row. The facets ignore the status and kind a clerk has picked, so they must be read on their
   *  own — a board filtered to `refused` that counted its own chips would show nought everywhere else. */
  const loadFacets = useCallback(async () => {
    const res = await fetch(`${API}/api/v1/control/customers/board?limit=1`, { credentials: "include" });
    if (!res.ok) return;
    const j = await res.json();
    setFacets(j.facets ?? null);
    setFacetsClock(j.clock ?? null);
  }, []);

  const load = useCallback(async (which: Tab, key: number) => {
    const at = (r: Response) => {
      if (key !== seq.current) return false;
      if (r.status === 401) { window.location.href = "/control/login"; return true; }
      if (r.status === 403) { setForbidden(true); return true; }
      return false;
    };
    const p = new URLSearchParams();
    let path = "board", words = "The customer register did not answer.";
    if (which === "board") {
      if (bFilter.search.trim()) p.set("search", bFilter.search.trim());
      if (bFilter.tin.trim()) p.set("tin", bFilter.tin.trim());
      if (bFilter.status) p.set("status", bFilter.status);
      if (bFilter.kind) p.set("kind", bFilter.kind);
      p.set("limit", bFilter.limit); p.set("offset", bFilter.offset);
      words = "The board did not answer.";
    } else if (which === "checks") {
      if (cFilter.status) p.set("status", cFilter.status);
      if (cFilter.kind) p.set("kind", cFilter.kind);
      if (cFilter.q.trim()) p.set("search", cFilter.q.trim());
      p.set("limit", cFilter.limit); p.set("offset", cFilter.offset);
      path = "checks"; words = "The check queue did not answer.";
    } else if (which === "notes") {
      if (nFilter.status) p.set("status", nFilter.status);
      if (nFilter.q.trim()) p.set("search", nFilter.q.trim());
      p.set("limit", nFilter.limit); p.set("offset", nFilter.offset);
      path = "notes"; words = "The note register did not answer.";
    } else if (which === "claims") {
      if (kFilter.status) p.set("status", kFilter.status);
      if (kFilter.q.trim()) p.set("search", kFilter.q.trim());
      p.set("limit", kFilter.limit); p.set("offset", kFilter.offset);
      path = "duplicates"; words = "The claim register did not answer.";
    } else if (which === "requests") {
      if (rFilter.status) p.set("status", rFilter.status);
      if (rFilter.kind) p.set("kind", rFilter.kind);
      if (rFilter.q.trim()) p.set("search", rFilter.q.trim());
      p.set("limit", rFilter.limit); p.set("offset", rFilter.offset);
      path = "data-requests"; words = "The data-request register did not answer.";
    } else {
      if (tFilter.status) p.set("status", tFilter.status);
      if (tFilter.q.trim()) p.set("search", tFilter.q.trim());
      p.set("limit", tFilter.limit); p.set("offset", tFilter.offset);
      path = "tags"; words = "The label library did not answer.";
    }
    const res = await fetch(`${API}/api/v1/control/customers/${path}?${p}`, { credentials: "include" });
    if (at(res)) return;
    if (!res.ok) { setError(errorMessage(await res.json().catch(() => ({})), words)); return; }
    const j = await res.json();
    if (key !== seq.current) return;
    if (which === "board") { setBoard(j); setError(null); return; }
    if (which === "checks") {
      setCRows(j.rows ?? []); setCCounts(j.counts ?? null); setError(null); return;
    }
    if (which === "notes") {
      setNRows(j.rows ?? []); setNCounts(j.counts ?? null); setError(null); return;
    }
    if (which === "claims") {
      setKRows(j.claims ?? []); setKCounts(j.counts ?? null); setError(null); return;
    }
    if (which === "requests") {
      setRRows(j.rows ?? []); setRCounts(j.counts ?? null); setError(null); return;
    }
    setTRows(j.rows ?? []); setTCounts(j.counts ?? null); setError(null);
  }, [bFilter, cFilter, nFilter, tFilter, kFilter, rFilter]);

  const readDossier = useCallback(async (companyId: string) => {
    const res = await fetch(`${API}/api/v1/control/customers/${companyId}/dossier`,
      { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); return; }
    if (!res.ok) {
      setError(errorMessage(await res.json().catch(() => ({})), "That account did not answer."));
      return;
    }
    setError(null);
    setDossier(await res.json());
    setDossierFor(companyId);
  }, []);

  const readTimeline = useCallback(async (companyId: string, source: string) => {
    const p = new URLSearchParams({ limit: "120" });
    if (source) p.set("source", source);
    const res = await fetch(`${API}/api/v1/control/customers/${companyId}/timeline?${p}`,
      { credentials: "include" });
    if (!res.ok) { setTimeline(null); return; }
    setTimeline(await res.json());
  }, []);

  /** What a claim would do, read live from the pair on the form. The preview is the trigger's own
   *  six questions in the trigger's own order, so a refusal on the screen is the refusal the write
   *  would have raised — which is why the form will not offer the button until it has answered. */
  const readPreview = useCallback(async (key: number, survivor: string, loser: string) => {
    setPreviewBusy(true); setPanelError(null);
    try {
      const res = await fetch(`${API}/api/v1/control/customers/duplicates/${survivor}/${loser}`,
        { credentials: "include" });
      if (key !== pseq.current) return;
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      if (res.status === 403) { setForbidden(true); setPreview(null); return; }
      if (!res.ok) {
        setPreview(null);
        setPanelError(errorMessage(await res.json().catch(() => ({})),
          "The register would not say what a claim on that pair would do."));
        return;
      }
      setPreview(await res.json());
    } finally { if (key === pseq.current) setPreviewBusy(false); }
  }, []);

  /** The closed accounts a claim can name as the extra one. The live picker cannot: 127 keeps a
   *  closed account out of every list, and a claim is only legal on a pair the office has already
   *  shut one half of. */
  const searchClosed = useCallback(async (term: string) => {
    setClosedBusy(true); setClosed(null);
    try {
      const p = new URLSearchParams({ closed: "1" });
      if (term.trim()) p.set("search", term.trim());
      const res = await fetch(`${API}/api/v1/control/customers/accounts?${p}`,
        { credentials: "include" });
      if (!res.ok) {
        setPanelError(errorMessage(await res.json().catch(() => ({})),
          "The closed accounts did not answer."));
        return;
      }
      setClosed((await res.json()).rows ?? []);
    } finally { setClosedBusy(false); }
  }, []);

  /** Who is signed into an account at the moment the question is asked. Gated on the disconnect
   *  duty and audited as a read, so this is only ever asked from the panel that can act on it. */
  const readAccess = useCallback(async (companyId: string) => {
    setAccess(null); setLastCut(null);
    const res = await fetch(`${API}/api/v1/control/customers/${companyId}/access`,
      { credentials: "include" });
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); return; }
    if (!res.ok) {
      setAccessFor(null);
      setError(errorMessage(await res.json().catch(() => ({})),
        "Nobody would say who is in that account."));
      return;
    }
    const j = await res.json();
    setAccess(j);
    setAccessFor(companyId);
    setError(null);
  }, []);

  /** One paper, whole. The same read a second seat is shown before signing and the one the desk
   *  reads back after a download, so every number on the screen is the register's own — the detail
   *  is built by `data_request_detail`, not by anything this page added up. */
  const readPaper = useCallback(async (id: string) => {
    const key = ++dseq.current;
    const res = await fetch(`${API}/api/v1/control/customers/data-requests/${id}`,
      { credentials: "include" });
    if (key !== dseq.current) return;
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); return; }
    if (!res.ok) {
      setPaper(null); setPaperFor(null);
      setError(errorMessage(await res.json().catch(() => ({})), "That paper did not answer."));
      return;
    }
    const j = await res.json();
    if (key !== dseq.current) return;
    if (j?.status === "not_found" || !j?.id) {
      setPaper(null); setPaperFor(null);
      setError("The register has never held a paper under that number.");
      return;
    }
    setPaper(j); setPaperFor(id); setError(null);
  }, []);

  /** What an ask would touch, read by the same definer the mask reads. An erasure is never raised
   *  from a description of one: the form waits for this answer because the signature a second seat
   *  gives is taken against exactly these counts. */
  const readDataPreview = useCallback(async (key: number, companyId: string, kind: string) => {
    setDpBusy(true);
    try {
      const res = await fetch(
        `${API}/api/v1/control/customers/${companyId}/data-preview?kind=${encodeURIComponent(kind)}`,
        { credentials: "include" });
      if (key !== qseq.current) return;
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      if (res.status === 403) { setForbidden(true); setDpreview(null); return; }
      if (!res.ok) {
        setDpreview(null);
        setPanelError(errorMessage(await res.json().catch(() => ({})),
          "The register would not say what that ask would touch."));
        return;
      }
      setDpreview(await res.json());
    } finally { if (key === qseq.current) setDpBusy(false); }
  }, []);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const p = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (p.ok) setPerms((await p.json()).permissions ?? []);
    })();
    loadFacets();
  }, [loadFacets]);

  useEffect(() => {
    if (!canView) return;
    // The register is behind its own duty. A desk holding only the view duty would take a 403 from
    // it, and `at()` would read that as "this whole tab is forbidden" — losing five working registers
    // to the sixth one's key. The tab is not offered either, so this is a guard, not a screen.
    if (tab === "requests" && !canGdpr) return;
    const key = ++seq.current;
    const t = setTimeout(() => { load(tab, key); }, 260);
    return () => clearTimeout(t);
  }, [tab, canView, canGdpr, load]);

  // A claim is raised on a pair the register has looked at, so the form asks the question the
  // moment both halves are named and again when either changes. The button waits for the answer.
  useEffect(() => {
    if (panel?.kind !== "claim") return;
    const survivor = draft.accountId, loser = draft.loserId;
    if (!survivor || !loser || survivor === loser) { setPreview(null); return; }
    const key = ++pseq.current;
    const t = setTimeout(() => { readPreview(key, survivor, loser); }, 300);
    return () => clearTimeout(t);
  }, [panel?.kind, draft.accountId, draft.loserId, readPreview]);

  // An ask is raised from the counts the mask itself will read, so the form asks the register the
  // moment an account is named and again when the kind changes — a copy and an erasure answer
  // differently, and the second seat signs against the answer, not against a description of it.
  useEffect(() => {
    if (panel?.kind !== "ask") { setDpreview(null); return; }
    const company = panel.companyId ?? draft.accountId;
    if (!company) { setDpreview(null); return; }
    const key = ++qseq.current;
    const t = setTimeout(() => { readDataPreview(key, company, draft.askKind); }, 300);
    return () => clearTimeout(t);
  }, [panel?.kind, panel?.companyId, draft.accountId, draft.askKind, readDataPreview]);

  const refresh = useCallback(() => {
    const key = ++seq.current;
    load(tab, key);
    loadFacets();
    if (dossierFor) {
      readDossier(dossierFor);
      readTimeline(dossierFor, tlSource);
    }
    if (wearersTag) setWearers(null);
    // A seat list is only honest as of the second it was read. After a write, re-read it rather
    // than let a clerk believe a session that just ended is still open.
    if (accessFor) readAccess(accessFor);
    // Same rule for a paper: the counters on it are what the mask reached and how many times a copy
    // was handed over, and both change underneath the desk that just acted.
    if (paperFor) readPaper(paperFor);
  }, [tab, load, loadFacets, dossierFor, tlSource, readDossier, readTimeline, wearersTag,
    accessFor, readAccess, paperFor, readPaper]);

  /** A row is opened, not navigated to: the dossier is the only place an account's own facts, its
   *  checks, notes and labels are all together, and it is where every act on them is started. */
  function openDossier(companyId: string, name: string) {
    if (dossierFor === companyId && panel?.kind !== "raise") {
      setDossier(null); setDossierFor(null); setTimeline(null); setPanel(null); return;
    }
    setNotice(`The dossier for ${name} — everything this register holds about that account.`);
    setError(null);
    readDossier(companyId);
    readTimeline(companyId, tlSource);
  }

  async function openWearers(tag: TagRow) {
    if (wearersTag?.id === tag.id) { setWearersTag(null); setWearers(null); return; }
    setWearersTag(tag); setWearers(null); setError(null);
    const res = await fetch(`${API}/api/v1/control/customers/tags/${tag.id}/wearers`,
      { credentials: "include" });
    if (!res.ok) {
      setError(errorMessage(await res.json().catch(() => ({})), "The label would not say who wears it."));
      setWearersTag(null); return;
    }
    setWearers((await res.json()).rows ?? []);
  }

  /** The seat list opens and closes by account, like the wearers of a label: it is a live look into
   *  a company, so it is not read on page load and not kept on screen once it has been answered. */
  function toggleSeats(companyId: string) {
    if (accessFor === companyId) { setAccessFor(null); setAccess(null); setLastCut(null); return; }
    readAccess(companyId);
  }

  /** The paper opens and closes by its own number, like a seat list: it is the register's read of one
   *  row, and a desk that has finished with it should not be left looking at a second copy of the
   *  counters the board already carries. */
  function openPaper(id: string) {
    if (paperFor === id) { setPaper(null); setPaperFor(null); return; }
    readPaper(id);
  }

  /**
   * Hand the copy over.
   *
   * The archive is the answer the caller is owed, so it goes to disk and is never rendered here —
   * a page that printed an account's contact book would be a second place PII exists, which is the
   * one thing this register is meant to reduce. What the desk shows afterwards is read back off the
   * row: the definer stamps the SHA and the hand-over count only once the last byte has left, so the
   * re-read is the register's own statement that the copy was received, not this page's belief that
   * a download finished.
   */
  async function handOver(p: Paper) {
    setBusy(true); setError(null); setPanelError(null);
    try {
      const res = await fetch(`${API}/api/v1/control/customers/data-requests/${p.id}/bundle`,
        { method: "POST", credentials: "include" });
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      if (res.status === 403) { setForbidden(true); return; }
      // Everything the register can still refuse is refused with a status code before a byte of the
      // archive exists, so a JSON body here is a refusal rather than a broken file.
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || type.includes("json")) {
        setError(errorMessage(await res.json().catch(() => ({})),
          "The register would not hand that copy over."));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `data-copy-${p.ref.replace(/[^A-Za-z0-9-]/g, "")}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      let fresh: Paper | null = null;
      try {
        const r = await fetch(`${API}/api/v1/control/customers/data-requests/${p.id}`,
          { credentials: "include" });
        if (r.ok) fresh = await r.json();
      } catch { /* the file has already left; the stamp is read the next time the paper is opened */ }
      if (fresh?.id) {
        ++dseq.current;
        setPaper(fresh); setPaperFor(fresh.id);
        setNotice(fresh.bundle_sha256
          ? `${fresh.deliveries} hand-over(s) on ${fresh.ref}${fresh.deliveries > 1
            ? " — the SHA below is still the first one, because a re-download cannot change what the "
            + "register says the caller was handed" : ""}: ${size(fresh.bundle_bytes)} in ${fresh.bundle_entries} file(s), `
            + `SHA-256 ${shaWords(fresh.bundle_sha256)}. The archive is in your downloads. A TIN, phone or `
            + "NIDA in plain text exists only inside it — no read on this desk returns one."
          : `${fresh.ref} left this desk as ${size(blob.size)}, but the register has not stamped it. An `
            + "abandoned download is not a copy anybody received — hand it over again before you tell the "
            + "caller it was sent.");
        load("requests", ++seq.current);
      } else {
        setNotice(`The file was handed over, but the register did not answer when the stamp was read back. `
          + "Open the paper again before you tell the caller it was sent.");
      }
    } finally { setBusy(false); }
  }

  /** The account picker every write is opened from. A clerk finds an account by the name it trades
   *  under, never by a uuid, and the register's own read is what limits the list. */
  const searchAccounts = useCallback(async (term: string) => {
    setPickerBusy(true); setAccounts(null);
    try {
      const p = new URLSearchParams();
      if (term.trim()) p.set("search", term.trim());
      const res = await fetch(`${API}/api/v1/control/customers/accounts?${p}`, { credentials: "include" });
      if (!res.ok) {
        setPanelError(errorMessage(await res.json().catch(() => ({})), "The account register did not answer."));
        return;
      }
      setAccounts((await res.json()).rows ?? []);
    } finally { setPickerBusy(false); }
  }, []);

  /** The live library a label is chosen from when marking an account. Read when the form opens,
   *  because a desk that picked from a paged tab list could mark an account with a retired label. */
  const loadLibrary = useCallback(async () => {
    if (library) return;
    const res = await fetch(`${API}/api/v1/control/customers/tags?status=live&limit=100`,
      { credentials: "include" });
    if (res.ok) setLibrary((await res.json()).rows ?? []);
  }, [library]);

  // ---------- writes ----------

  async function send(path: string, body?: unknown): Promise<any | null> {
    setBusy(true); setPanelError(null);
    try {
      const res = await fetch(`${API}/api/v1/control/customers/${path}`, {
        method: "POST", credentials: "include",
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" } })
      });
      if (res.status === 401) { window.location.href = "/control/login"; return null; }
      if (res.status === 403) { setForbidden(true); return null; }
      if (!res.ok) {
        setPanelError(errorMessage(await res.json().catch(() => ({})), "The register refused that."));
        return null;
      }
      const j = await res.json().catch(() => ({}));
      setPanel(null); setDraft(EMPTY_DRAFT); setArmed(null); setAccounts(null); setRevealed(null);
      setPreview(null); setClosed(null);
      refresh();
      return j;
    } finally { setBusy(false); }
  }

  const numberBody = () => {
    const b: Record<string, unknown> = {};
    if (draft.reference.trim()) b.reference = draft.reference.trim();
    if (draft.expiresOn) b.expiresOn = draft.expiresOn;
    return b;
  };

  async function press() {
    const p = panel;
    if (!p) return;
    const company = p.companyId ?? draft.accountId;
    if (["raise", "note", "wear", "off", "claim", "ask"].includes(p.kind) && !company) {
      setPanelError("Pick the account first — nothing on this register is written without one.");
      return;
    }
    switch (p.kind) {
      case "raise": {
        const j = await send(`${company}/checks`,
          { kind: draft.kind, status: draft.status, ...numberBody() });
        if (j) setNotice(`${kindWord(draft.kind)} is open on ${p.companyName ?? j.account?.name ?? "that account"} — `
          + "the board counts it as waiting until an answer is signed.");
        return;
      }
      case "paper": {
        const j = await send(`checks/${p.id}/submit`, numberBody());
        if (j) setNotice(`The paper is in: ${stateWord(j.status)}${j.reference_tail
          ? `, read as ending ${j.reference_tail}` : ""}. An answer now has to be signed.`);
        return;
      }
      case "answer": {
        const j = await send(`checks/${p.id}/decide`,
          { status: draft.answer, ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
            ...numberBody() });
        if (j) setNotice(`${kindWord(p.checkKind)} is ${stateWord(j.status)}. That answer is kept — `
          + "checking the account again means raising a new line beside it.");
        return;
      }
      case "note": {
        const j = await send(`${company}/notes`, { text: draft.text.trim() });
        if (j) setNotice("The office's words are on the file. A note keeps its author, so the name on it is yours.");
        return;
      }
      case "edit": {
        const j = await send(`notes/${p.id}/edit`, { text: draft.text.trim() });
        if (j) setNotice(`Rewritten on ${when(j.edited_at)}. What the note said before is in the audit register, `
          + "not here.");
        return;
      }
      case "void": {
        const j = await send(`notes/${p.id}/void`, { reason: draft.reason.trim() });
        if (j) setNotice("The note is withdrawn. Its words stay, because the withdrawal is about them.");
        return;
      }
      case "label": {
        const j = await send("tags", {
          name: draft.labelName.trim(),
          ...(draft.labelColour ? { colour: draft.labelColour } : {}),
          ...(draft.labelNote.trim() ? { note: draft.labelNote.trim() } : {})
        });
        if (j) setNotice(`“${j.name}” is in the library. Nothing is wearing it yet.`);
        return;
      }
      case "retire": {
        const j = await send(`tags/${p.id}/retire`);
        if (j) setNotice(`“${j.name}” is off the library. The accounts that used to wear it keep their history.`);
        return;
      }
      case "wear": {
        const j = await send(`${company}/tags`, { tagId: draft.tagId });
        if (j) setNotice(`${p.companyName ?? "That account"} now wears “${j.tag_name ?? p.tagName}”.`);
        return;
      }
      case "off": {
        const j = await send(`${company}/tags/retire`, { tagId: p.tagId });
        if (j) setNotice(`“${p.tagName}” is off that account. The pairing is kept — who wore it, and when it stopped.`);
        return;
      }
      case "claim": {
        const j = await send(`${company}/duplicates`,
          { loser: draft.loserId, reason: draft.reason.trim() });
        if (j) {
          const carried = (j.claim?.carried_kinds ?? []) as string[];
          setNotice(`The register now holds ${j.claim?.survivor?.name ?? "that account"} as the account that `
            + `carries on and ${j.claim?.loser?.name ?? "the closed account"} as its extra one. `
            + (carried.length
              ? `It had unanswered ${carried.map(kindWord).join(", ")} — those came across as new lines on `
                + "the survivor, with no number and no paper copied, because the paper was on the other file."
              : "It had nothing unanswered to carry, so no line moved at all.")
            + " Everything else stayed on the closed account's own file.");
        }
        return;
      }
      case "voidclaim": {
        const j = await send(`duplicates/${p.id}/void`, { reason: draft.reason.trim() });
        if (j) setNotice(`The claim is withdrawn, with ${j.claim?.voided_name ?? "this seat"}'s name on the `
          + "withdrawal. The checks it carried stay open on the survivor — a carried line is that account's own "
          + "check now, and an answer once given is kept.");
        return;
      }
      case "cut": {
        const j = await send(`${p.companyId}/cut-off`, { reason: draft.reason.trim() });
        if (j) {
          setLastCut(j);
          setNotice(`${j.sessions_revoked} session(s) ended on ${j.company?.name ?? "that account"}, of which `
            + `${j.of_which_borrowed_views} were a read-only visit from this office. ${j.window?.words ?? ""}`);
        }
        return;
      }
      case "ask": {
        // The definer answers with the row *and* the preview of it, so the paper the desk now sees is
        // built from the same read the second seat will be asked to sign — no arithmetic of ours in
        // between the register and the screen.
        const j = await send(`${company}/data-requests`, {
          kind: draft.askKind,
          ...(draft.askKind === "erase" ? { categories: draft.cats } : {}),
          reason: draft.reason.trim(),
          ...(draft.askedIn.trim() ? { askedIn: draft.askedIn.trim() } : {})
        });
        if (j?.request?.id) {
          // The register was refreshed by the write itself, and that read is still about the paper
          // open a moment ago. Discard it before naming the new one, or the desk shows the old ask
          // under a notice about the new one.
          ++dseq.current;
          setPaper(j.request); setPaperFor(j.request.id);
          const n = (j.request.categories ?? []).length;
          setNotice(draft.askKind === "export"
            ? `${j.request.ref} is on the register: a copy of everything the sections hold about `
            + `${j.request.company?.name ?? "that account"}. Nothing was taken and nothing changed — the `
            + `answer leaves when this desk hands the archive over, and the row counts every hand-off.`
            : `${j.request.ref} is on the register with ${n} category(ies) named — ${categoryList(j.request.categories)}. `
            + "This desk has written the paper and cannot run the mask: a second seat signs it on Approvals, "
            + "against the hash of exactly these counts.");
        } else if (j) {
          setNotice("The paper is on the register.");
        }
        return;
      }
      case "sig": {
        const j = await send(`data-requests/${p.id}/erase-signature`, { reason: draft.reason.trim() });
        if (j) {
          setNotice(`A signature is asked for on ${j.ref ?? p.ref}: ${categoryList(j.categories)}, hashed as `
            + `${shaWords(j.payload_sha256)}, expiring ${day(j.expires_at)}. It is not yours to give — `
            + "129 keeps the seat that raised a paper off the seat that spends its signature, so the mask "
            + "runs from Approvals under a different name.");
          readPaper(p.id!);
        }
        return;
      }
      case "refuse": {
        const j = await send(`data-requests/${p.id}/refuse`, { note: draft.reason.trim() });
        if (j) {
          setNotice(`${j.ref ?? p.ref} is refused, with ${j.refused_name ?? "this seat"}'s name on it and `
            + `these words kept beside it: “${draft.reason.trim()}”. The row stays and the account's open `
            + "slot is freed, so the same person can be answered properly next month.");
          readPaper(p.id!);
        }
        return;
      }
    }
  }

  /** The only door that decrypts. It asks twice, and the panel says what it costs afterwards. */
  async function revealReference(id: string) {
    setBusy(true); setPanelError(null); setRevealed(null);
    try {
      const res = await fetch(`${API}/api/v1/control/customers/checks/${id}/reference`,
        { credentials: "include" });
      if (res.status === 401) { window.location.href = "/control/login"; return; }
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) {
        setPanelError(errorMessage(await res.json().catch(() => ({})),
          "There was no number on that line to read."));
        return;
      }
      const j = await res.json();
      setRevealed(j);
      setNotice(`The whole ${kindWord(j.kind)} was put on this screen. The read itself is in the audit `
        + "register, with the tail and not the number.");
    } finally { setBusy(false); }
  }

  function openPanel(next: Panel, seed?: Partial<Draft>) {
    const closing = panel?.kind === next.kind && panel?.id === next.id
      && panel?.companyId === next.companyId && panel?.tagId === next.tagId;
    setPanelError(null); setArmed(null); setRevealed(null); setPreview(null);
    if (next.kind === "raise" || next.kind === "wear" || next.kind === "note") setAccounts(null);
    if (next.kind === "claim" || next.kind === "ask") setClosed(null);
    if (next.kind === "ask") setDpreview(null);
    if (next.kind === "claim" && !next.companyId) searchAccounts("");
    setDraft({ ...EMPTY_DRAFT, askKind: next.requestKind === "erase" ? "erase" : "export", ...seed });
    if (closing) { setPanel(null); return; }
    setPanel(next);
    if (next.kind === "wear") loadLibrary();
    if (next.kind === "raise" && !next.companyId) searchAccounts("");
    // An ask can be raised on either half of the register: a copy is owed whether the account trades
    // or not, and an erasure only ever applies to one the office has shut. So both lists are read,
    // and the account is named from whichever one holds it.
    if ((next.kind === "claim" || next.kind === "ask") && next.companyId) searchAccounts(next.companyName ?? "");
    if (next.kind === "claim") searchClosed("");
    if (next.kind === "ask") {
      if (!next.companyId) searchAccounts("");
      searchClosed("");
    }
    requestAnimationFrame(() =>
      document.getElementById("customers-form")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  // ---------- the CSV ----------

  async function exportCsv() {
    setExporting(true); setError(null);
    try {
      const p = new URLSearchParams({ register: EXPORT_REGISTER[tab] });
      if (tab === "board") {
        if (bFilter.status) p.set("status", bFilter.status);
        if (bFilter.kind) p.set("kind", bFilter.kind);
        if (bFilter.search.trim()) p.set("search", bFilter.search.trim());
      } else if (tab === "checks") {
        if (cFilter.status) p.set("status", cFilter.status);
        if (cFilter.kind) p.set("kind", cFilter.kind);
        if (cFilter.q.trim()) p.set("search", cFilter.q.trim());
      } else if (tab === "notes") {
        if (nFilter.status) p.set("status", nFilter.status);
        if (nFilter.q.trim()) p.set("search", nFilter.q.trim());
      } else if (tab === "claims") {
        if (kFilter.status) p.set("status", kFilter.status);
        if (kFilter.q.trim()) p.set("search", kFilter.q.trim());
      } else if (tab === "requests") {
        if (rFilter.status) p.set("status", rFilter.status);
        if (rFilter.kind) p.set("kind", rFilter.kind);
        if (rFilter.q.trim()) p.set("search", rFilter.q.trim());
      } else {
        if (tFilter.status) p.set("status", tFilter.status);
        if (tFilter.q.trim()) p.set("search", tFilter.q.trim());
      }
      const res = await fetch(`${API}/api/v1/control/customers/export?${p}`, { credentials: "include" });
      if (!res.ok) {
        setError(errorMessage(await res.json().catch(() => ({})), "The export did not answer."));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `customers-${EXPORT_REGISTER[tab]}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setNotice(tab === "tags"
        ? "The file is the label history — which account wore what, who put it on and who took it off — "
        : `The ${tab === "board" ? "account board"
          : tab === "claims" ? "claim register, both halves named"
            : tab === "requests" ? "data-request register, one line per paper with what it reached and what it kept"
              : tab}`
          + " was exported with the filters on screen.");
    } finally { setExporting(false); }
  }

  // ---------- form gates, in the register's own words ----------

  const kind = panel?.checkKind ?? draft.kind;
  const numberOk = !draft.reference.trim() || referenceLooksRight(kind, draft.reference);
  const dayOk = !draft.expiresOn || expiresOnKind(kind);
  const lineHasNumber = !!panel?.hasReference || !!draft.reference.trim();
  const lineHasDay = !!panel?.expiresOn || !!draft.expiresOn;
  const approvedNeedsDay = expiresOnKind(kind) && !lineHasDay;
  // Named out of the list the clerk just searched, not out of the panel: a claim's loser is only ever
  // chosen from the closed accounts, so this is the one place the desk can say which tombstone it means.
  const loserChosen = closed?.find((c) => c.id === draft.loserId) ?? null;

  function formReady(): boolean {
    const p = panel;
    if (!p) return false;
    switch (p.kind) {
      case "raise":
      case "paper": return numberOk && dayOk && (!!p.companyId || !!draft.accountId);
      case "answer":
        if (draft.answer === "approved") {
          return numberOk && dayOk && lineHasNumber && !approvedNeedsDay;
        }
        return draft.reason.trim().length >= 8;
      case "note": return draft.text.trim().length >= 4 && (!!p.companyId || !!draft.accountId);
      case "edit": return draft.text.trim().length >= 4 && draft.text.trim() !== (p.body ?? "").trim();
      case "void": return draft.reason.trim().length >= 8;
      case "label": return /^[a-z0-9][a-z0-9 ._+-]{1,27}$/i.test(draft.labelName.trim());
      case "wear": return !!draft.tagId && (!!p.companyId || !!draft.accountId);
      case "off": return !!p.tagId;
      case "retire": return !!p.id;
      case "reveal": return !!p.id;
      // The preview is the trigger's own answer, so the button waits for it rather than letting the
      // desk type a reason against a pair the register will never accept.
      case "claim":
        return !!draft.accountId && !!draft.loserId && draft.reason.trim().length >= 8
          && !previewBusy && !!preview && preview.eligible;
      case "voidclaim": return !!p.id && draft.reason.trim().length >= 8;
      case "cut": return !!p.companyId && draft.reason.trim().length >= 8;
      // The ask is gated on the preview for the same reason a claim is gated on its preview: the
      // answer comes from `data_request_preview`, which is the function the mask itself reads. A
      // paper raised against counts the register has not given is a signature asked for blind.
      case "ask":
        return (!!p.companyId || !!draft.accountId) && !dpBusy && !!dpreview && dpreview.eligible
          && (!categoriesAllowedFor(draft.askKind) || draft.cats.length > 0)
          && draft.reason.trim().length >= REASON_FLOOR;
      case "sig": return !!p.id && !!p.openSlot && draft.reason.trim().length >= REASON_FLOOR;
      case "refuse": return !!p.id && !!p.openSlot && draft.reason.trim().length >= REASON_FLOOR;
    }
  }

  function whyNotReady(): string {
    const p = panel;
    if (!p) return "";
    if ((p.kind === "raise" || p.kind === "note" || p.kind === "wear")
      && !p.companyId && !draft.accountId) {
      return "Choose the account first. The register will not hold a line, a note or a label without one.";
    }
    if (!numberOk) return `The number is not the shape this kind expects: ${KIND_SHAPES[kind].hint}.`;
    if (!dayOk) return `A ${kindWord(kind)} does not lapse on this register, so it cannot carry a day. `
      + `Only a ${EXPIRING_WORDS} does.`;
    if (p.kind === "answer" && draft.answer === "approved") {
      if (!lineHasNumber) return "An approval has to say which paper was read. Type the number, or answer "
        + "‘more information asked’ and let the account send it.";
      if (approvedNeedsDay) return `A ${kindWord(kind)} approval needs the day it runs out, because that is `
        + "the next thing the office has to watch.";
    }
    if (p.kind === "answer" && draft.answer !== "approved" && draft.reason.trim().length < 8) {
      return "A refusal, or an answer of ‘send more’, has to say what was wrong. The account is told those words.";
    }
    if ((p.kind === "note" || p.kind === "edit") && draft.text.trim().length < 4) {
      return "Four characters is the shortest line the register keeps.";
    }
    if (p.kind === "edit" && draft.text.trim() === (panel?.body ?? "").trim()) {
      return "The note says that already — an edit that changes nothing still stamps the row, so the desk "
        + "asks for an actual change.";
    }
    if (p.kind === "void" && draft.reason.trim().length < 8) {
      return "Say why the note comes off. Eight characters, because a withdrawal has to be arguable.";
    }
    if (p.kind === "label" && !/^[a-z0-9][a-z0-9 ._+-]{1,27}$/i.test(draft.labelName.trim())) {
      return "A label is 2 to 28 characters: letters, digits, space, dot, underscore, dash or plus. "
        + "It is stored lower-case, so KYC-Hold and kyc-hold are one label.";
    }
    if (p.kind === "wear" && !draft.tagId) return "Pick the label from the live library.";
    if (p.kind === "claim") {
      if (!draft.accountId) return "Name the account that carries on first.";
      if (!draft.loserId) return "Then name the extra one — a claim is written on a pair, and the closed "
        + "half is only ever found by searching the accounts the office has shut.";
      if (previewBusy) return "Asking the register what this pair would do…";
      if (!preview) return "The register has not answered whether this pair can be claimed. Search both "
        + "halves again — a claim is never raised on a preview it refused to read.";
      if (!preview.eligible) return preview.refusal ?? "The register will not accept this pair as one account.";
      if (draft.reason.trim().length < 8) return "Say what makes them the same account: the same NIDA, the "
        + "same TIN, the same director who signed up twice. Eight characters, because the sentence is kept.";
    }
    if (p.kind === "voidclaim" && draft.reason.trim().length < 8) {
      return "Taking a claim back needs a sentence as good as the one that made it.";
    }
    if (p.kind === "cut" && draft.reason.trim().length < 8) {
      return "Say on the register why every session is being ended. Three weeks from now, when the account "
        + "says it was cut twice, this is the sentence that answers it.";
    }
    if (p.kind === "ask") {
      if (!p.companyId && !draft.accountId) return "Name the account the ask is about. A paper with no company "
        + "on it cannot be answered, and cannot be traced back when a supervisory office asks who it was for.";
      if (dpBusy) return "Asking the register what this would touch…";
      if (!dpreview) return "The register has not answered what this ask would touch. Search the account again — "
        + "a paper is never raised on a preview it refused to read.";
      if (!dpreview.eligible) return dpreview.refusal ?? "The register will not accept this ask on that account.";
      if (categoriesAllowedFor(draft.askKind) && draft.cats.length === 0) {
        return "Tick what an erasure takes away. A mask that names nothing is a refusal wearing a form, so the "
          + "register asks for at least one of the ten — and a copy carries no menu at all.";
      }
      if (draft.reason.trim().length < REASON_FLOOR) {
        return `Say what the caller asked for and why, in ${REASON_FLOOR} characters or more. These words are `
          + "quoted back when someone asks how this answer was reached, and a second seat reads them before signing.";
      }
    }
    if ((p.kind === "sig" || p.kind === "refuse") && !p.openSlot) {
      return "That paper is already answered. A signature is asked for, or a refusal written, on an ask that is "
        + "still open — an erased or delivered row is history and stays that way.";
    }
    if ((p.kind === "sig" || p.kind === "refuse") && draft.reason.trim().length < REASON_FLOOR) {
      return p.kind === "sig"
        ? "Say what is being signed for. The sentence goes on the approval paper a second seat reads, and it is "
          + `kept whether or not they sign. ${REASON_FLOOR} characters.`
        : "Say why the ask is refused, in the words the caller will be quoted. Eight characters, because the "
          + "refusal is the answer and an answer has to be arguable.";
    }
    return "The register will take this — press the button.";
  }

  const isArmed = () => !!panel && ARMS.includes(panel.kind);

  // ---------- the render ----------

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
              Reading the board, the checks, the notes and the labels needs <code>control.customers.view</code>;
              opening a check, writing a note and labelling an account needs <code>control.customers.manage</code>;
              answering a check and reading back a whole identity number needs{" "}
              <code>control.customers.verify</code>.
            </p>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Two more acts sit behind their own keys, because both of them change what a company is or who
              is standing in it: declaring two accounts one needs <code>control.customers.merge</code>, and
              reading a live seat list or cutting every session off needs{" "}
              <code>control.customers.disconnect</code>. A desk without them still sees the board, the
              checks, the notes and the labels — it simply cannot claim a duplicate or sign anybody out.
            </p>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              A copy and an erasure stand behind two more keys again, because answering them changes what the
              registers hold: reading that register, its preview and handing an archive over needs{" "}
              <code>control.customers.gdpr</code>, and writing an erasure paper or refusing one needs{" "}
              <code>control.customers.erase</code>. Neither of them runs the mask — that is a second seat&apos;s
              signature, on <Link href="/control/approvals" className="underline">Approvals</Link>.
            </p>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              A ban, a price or a refund is not on this desk at all: those need a second seat&apos;s
              signature and live on <Link href="/control/approvals" className="underline">Approvals</Link>.
            </p>
            <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const fchecks = facets?.checks ?? {};
  const stats: [any, string, string | undefined, string?][] = [
    [facets?.accounts ?? "—", "Accounts on the platform", "Transporters, shippers and seekers — the board's own count", undefined],
    [facets?.never_checked ?? "—", "Never looked at", "No check line of any kind has ever been raised",
      (facets?.never_checked ?? 0) > 0 ? "var(--warning)" : undefined],
    [fchecks.open ?? "—", "Checks the office owes", "Awaiting paper, or paper in and waiting on an answer",
      (fchecks.open ?? 0) > 0 ? "var(--warning)" : undefined],
    [fchecks.approved ?? "—", "Checks approved", "The newest line of each kind per account", undefined],
    [fchecks.refused ?? "—", "Refused or sent back", "An answer that said no, or asked for more",
      (fchecks.refused ?? 0) > 0 ? "var(--danger)" : undefined],
    [fchecks.expired ?? "—", "Paper past its day", "Approved, but the day it ran out has gone by",
      (fchecks.expired ?? 0) > 0 ? "var(--danger)" : undefined]
  ];

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Customers · {canVerify ? (canManage ? "checks, notes and labels" : "answers and numbers")
              : canManage ? "the queue and the file" : "read-only"}
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1240px] px-16 py-32">
        <div className="flex flex-wrap items-end justify-between gap-16">
          <div className="min-w-0">
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
              Who each account is, and what the office has checked about it
            </h1>
            <p className="mt-8 max-w-[76ch] text-sm" style={{ color: "var(--ink-soft)" }}>
              Five things get looked at — a national ID, a TIN, a trade licence, a transport licence and an
              insurance certificate. A line is raised, paper comes in, and one seat signs an answer that is
              kept forever. The trust number beside an account is worked out of those answers, the office&apos;s
              own blocks this year and how long the account has been here; it is never stored.
            </p>
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              {facetsClock ? `Measured at ${when(facetsClock)}.` : "Reading the register…"}{" "}
              The six numbers below count the whole register, not the filter on screen.
            </p>
          </div>
          {canManage && (
            <button type="button" onClick={() => openPanel({ kind: "raise" })}
              className="waisha-btn min-h-[36px] rounded-input px-16 py-8 text-xs font-semibold">
              {panel?.kind === "raise" && !panel.companyId ? "Close the form" : "Check an account"}
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

        {/* ---------------- one account, everything the register holds ---------------- */}
        {dossier && <DossierBlock
          d={dossier} panel={panel} openPanel={openPanel} close={() => {
            setDossier(null); setDossierFor(null); setTimeline(null);
          }}
          canManage={canManage} canVerify={canVerify} busy={busy}
          timeline={timeline} tlSource={tlSource} setTlSource={(s: string) => {
            setTlSource(s); readTimeline(dossier.company.id, s);
          }}
          openDossier={openDossier}
          canMerge={canMerge} canDisconnect={canDisconnect} toggleSeats={toggleSeats}
          accessFor={accessFor}
        />}

        {/* ---------------- the wearers of one label ---------------- */}
        {wearersTag && (
          <section className="mt-20 rounded-card border p-20"
            style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
            <div className="flex flex-wrap items-center justify-between gap-12">
              <h2 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                <span className="inline-block h-3 w-3 rounded-full align-middle"
                  style={{ background: wearersTag.colour ?? "var(--ink-soft)" }} />{" "}
                Who wears “{wearersTag.name}”
              </h2>
              <button type="button" className={headBtn} style={miniStyle}
                onClick={() => { setWearersTag(null); setWearers(null); }}>
                Close
              </button>
            </div>
            <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              {wearersTag.live} live pairing(s), {wearersTag.worn} in total including the ones taken off. A label
              cannot leave the library while a live pairing stands — retiring it here is a statement about
              these accounts, so the desk takes the label off first and then retires the word.
            </p>
            {wearers === null && <p role="status" className="mt-12 text-sm" style={{ color: "var(--ink-soft)" }}>Reading…</p>}
            {wearers?.length === 0 && (
              <p className="mt-12 text-sm" style={{ color: "var(--ink)" }}>
                Nobody wears it. This label can be retired out of the library.
              </p>
            )}
            {wearers?.map((w) => (
              <div key={w.tagging_id} className={line}>
                <div className="flex flex-wrap items-center justify-between gap-10">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {w.company_name}{" "}
                      <span className="chip" style={{ border: "1px solid var(--line)", color: "var(--ink-soft)" }}>
                        {label(ACCOUNT_STATES, w.account_status)}
                      </span>
                    </p>
                    <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      put on by {w.applied_by_name ?? "—"} · {day(w.applied_at)} ({age(w.applied_at)} ago)
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-8">
                    <button type="button" className={mini} style={miniStyle}
                      onClick={() => openDossier(w.company_tenant_id, w.company_name)}>
                      Open the account
                    </button>
                    {canManage && (
                      <button type="button" className={mini} style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                        onClick={() => openPanel({
                          kind: "off", companyId: w.company_tenant_id, companyName: w.company_name,
                          tagId: wearersTag.id, tagName: wearersTag.name
                        })}>
                        Take it off
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* ---------------- who is inside one account, right now ---------------- */}
        {accessFor && (
          <section className="mt-20 rounded-card border p-20"
            style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
            <div className="flex flex-wrap items-center justify-between gap-12">
              <h2 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                Who is inside {access?.company.name ?? "that account"}
              </h2>
              <button type="button" className={headBtn} style={miniStyle} onClick={() => toggleSeats(accessFor)}>
                Close
              </button>
            </div>
            <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              A live look into a company while the lights are on, so this read is gated on its own duty and
              written into the audit register as it happens. It lists names, the device and the last activity —
              not emails, not identity numbers.
            </p>
            {access === null ? (
              <p role="status" className="mt-12 text-sm" style={{ color: "var(--ink-soft)" }}>Reading…</p>
            ) : (
              <>
                <p className="mt-12 text-xs" style={{ color: "var(--ink)" }}>
                  {access.live} live session(s) · {access.seats} seat(s) on the account
                  {access.borrowed_views > 0 && (
                    <> · <span style={{ color: "var(--warning)" }}>
                      {access.borrowed_views} of them a read-only visit opened by this office</span></>
                  )}
                  {access.cut_offs.sessions_cut > 0 && (
                    <> · {access.cut_offs.sessions_cut} ever cut off from here, last {day(access.cut_offs.last_at)}</>
                  )}
                </p>
                {access.sessions.length === 0 && (
                  <p className="mt-12 text-[11px]" style={{ color: "var(--ink)" }}>
                    Nobody is in. Every session on this account has been signed out or has expired; the seats
                    above can sign in again whenever they like.
                  </p>
                )}
                {access.sessions.map((s) => (
                  <div key={`${s.user_id}-${s.ip ?? "n"}`} className={line}>
                    <div className="flex flex-wrap items-center justify-between gap-10">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                          {s.name ?? "a seat with no name on it"}{" "}
                          <span className="chip" style={{ border: "1px solid var(--line)", color: "var(--ink-soft)" }}>
                            {s.user_type}
                          </span>
                        </p>
                        <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          last seen {age(s.last_seen)} ago · {when(s.last_seen)} · {s.ip ?? "no address recorded"} · {s.device}
                        </p>
                        {s.borrowed_by && (
                          <p className="mt-4 text-[11px]" style={{ color: "var(--warning)" }}>
                            opened as a read-only visit by this office — {s.borrowed_by}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {lastCut && (
                  <p className="mt-12 text-[11px]" style={{ color: "var(--success)" }}>
                    {lastCut.sessions_revoked} session(s) ended just now, of which{" "}
                    {lastCut.of_which_borrowed_views} were this office&apos;s own visits. {lastCut.window?.words}
                  </p>
                )}
                <div className="mt-14 flex flex-wrap gap-10">
                  {canDisconnect && (
                    <button type="button" className={headBtn}
                      style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                      onClick={() => openPanel({
                        kind: "cut", companyId: access.company.id, companyName: access.company.name,
                        live: access.live, borrowedViews: access.borrowed_views, seats: access.seats
                      })}>
                      {panel?.kind === "cut" ? "Close the form" : "Cut every session off"}
                    </button>
                  )}
                  <button type="button" className={headBtn} style={miniStyle}
                    onClick={() => readAccess(accessFor)}>
                    Read it again
                  </button>
                </div>
                <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  A cut-off ends sessions. It does not close or block the account, and a token already handed
                  out keeps working for up to fifteen minutes — the panel says so before the button is pressed.
                </p>
              </>
            )}
          </section>
        )}

        {/* ---------------- one paper, whole ---------------- */}
        {paper && <PaperBlock p={paper} panel={panel} canGdpr={canGdpr} canErase={canErase} busy={busy}
          openPanel={openPanel} openDossier={openDossier} handOver={handOver}
          close={() => { setPaper(null); setPaperFor(null); }} readAgain={() => readPaper(paper.id)} />}

        {/* ---------------- the form every act opens ---------------- */}
        {panel && (
          <section id="customers-form" className="mt-20 rounded-card border p-20"
            style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
            <h2 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
              {panelTitle(panel)}
            </h2>
            <p className="mt-6 max-w-[84ch] text-[11px]" style={{ color: "var(--ink-soft)" }}>
              {panelHint(panel)}
            </p>
            {panelError && (
              <div role="alert" className="mt-12 rounded-input px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
                {panelError}
              </div>
            )}

            {panel.kind === "raise" && !panel.companyId && (
              <AccountPicker draft={draft} setDraft={setDraft} rows={accounts} busy={pickerBusy}
                search={searchAccounts} onPick={(a) => setDraft({ ...draft, accountId: a.id })} />
            )}
            {panel.kind === "wear" && (
              <fieldset className="mt-14 rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
                <legend className="px-8 text-[11px] font-semibold uppercase tracking-[0.12em]"
                  style={{ color: "var(--ink-soft)" }}>
                  The live library
                </legend>
                {library === null && <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>Reading the labels…</p>}
                {library?.length === 0 && (
                  <p className="text-[11px]" style={{ color: "var(--ink)" }}>
                    The library is empty. A label has to be written before an account can wear one.
                  </p>
                )}
                <div className="mt-8 flex flex-wrap gap-8">
                  {library?.map((t) => (
                    <button key={t.id} type="button" onClick={() => setDraft({ ...draft, tagId: t.id })}
                      className={chip}
                      style={draft.tagId === t.id
                        ? { background: t.colour ?? "var(--adm-accent)", color: "#fff", border: "1px solid transparent" }
                        : { border: `1px solid ${t.colour ?? "var(--line)"}`, color: "var(--ink)" }}>
                      {t.name} · {t.live}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}

            {["raise", "paper", "answer"].includes(panel.kind) && (
              <div className="mt-14 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  What is being checked
                  <select value={panel.kind === "raise" ? draft.kind : (panel.checkKind ?? draft.kind)}
                    disabled={panel.kind !== "raise"}
                    onChange={(e) => setDraft({ ...draft, kind: e.target.value as CheckKind, reference: "", expiresOn: "" })}
                    className={box} style={boxStyle}>
                    {CHECK_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                  </select>
                </label>
                {panel.kind === "raise" && (
                  <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                    The line starts as
                    <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                      className={box} style={boxStyle}>
                      {OPEN_STATES.map((s) => <option key={s} value={s}>{CHECK_STATE_LABELS[s]}</option>)}
                    </select>
                  </label>
                )}
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  The number on the paper — {KIND_SHAPES[kind].hint}
                  <input value={draft.reference} inputMode={kind === "national_id" || kind === "tin" ? "numeric" : "text"}
                    onChange={(e) => setDraft({ ...draft, reference: e.target.value })}
                    placeholder={draft.reference.trim() ? "" : "leave empty until the paper is in"}
                    className={box} style={boxStyle} />
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  {expiresOnKind(kind) ? "It runs out on" : "A day — not for this kind"}
                  <input type="date" value={draft.expiresOn} disabled={!expiresOnKind(kind)}
                    onChange={(e) => setDraft({ ...draft, expiresOn: e.target.value })}
                    className={box} style={boxStyle} />
                </label>
                <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {draft.reference.trim()
                    ? `Only the last four — ${referenceTail(draft.reference)} — leave this desk without a decision.`
                    : "A line can be opened with nothing read yet. Only an approval needs a number."}
                </p>
              </div>
            )}

            {panel.kind === "answer" && (
              <>
                <fieldset className="mt-14 rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
                  <legend className="px-8 text-[11px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>
                    The answer — one seat, kept forever
                  </legend>
                  <div className="grid gap-10" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                    {ANSWERS.map((a) => (
                      <label key={a} className="flex min-h-[36px] items-start gap-8 text-sm" style={{ color: "var(--ink)" }}>
                        <input type="radio" name="answer" checked={draft.answer === a}
                          onChange={() => setDraft({ ...draft, answer: a })} />
                        <span>
                          {CHECK_STATE_LABELS[a]}
                          <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {a === "approved" ? "The paper is what it says. Needs the number, and a day for the three kinds that lapse."
                              : a === "rejected" ? "It is not, and the account is told why in these words."
                                : "Not refused — the office is waiting for something specific."}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {draft.answer !== "approved" && (
                  <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                    What was wrong with it — the account reads these words
                    <textarea value={draft.reason} rows={3} className={box} style={boxStyle}
                      onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                  </label>
                )}
                {draft.answer === "approved" && (
                  <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {panel.hasReference
                      ? `The number on the line ends ${panel.ref ?? ""}. Type another only if the paper you are looking at says something else.`
                      : "No number has ever been written on this line. An approval that cannot say which paper it read is an opinion, so the register refuses it."}
                  </p>
                )}
              </>
            )}

            {(panel.kind === "note" || panel.kind === "edit") && (
              <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                {panel.kind === "edit" ? "The new words" : "What the office knows, in its own words"}
                <textarea value={draft.text} rows={4} className={box} style={boxStyle}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
              </label>
            )}
            {(panel.kind === "void" || panel.kind === "off") && (
              <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                {panel.kind === "void"
                  ? `The note says: “${(panel.body ?? "").slice(0, 160)}”`
                  : `“${panel.tagName}” comes off ${panel.companyName}. The pairing is kept, with who took it off and when.`}
              </p>
            )}
            {panel.kind === "void" && (
              <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                Why it comes off the file
                <textarea value={draft.reason} rows={3} className={box} style={boxStyle}
                  onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
              </label>
            )}
            {panel.kind === "label" && (
              <div className="mt-14 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  The word — stored lower-case, 2 to 28 characters
                  <input value={draft.labelName} className={box} style={boxStyle}
                    placeholder="kyc-hold" onChange={(e) => setDraft({ ...draft, labelName: e.target.value })} />
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  Colour
                  <input type="color" value={draft.labelColour} className="mt-4 h-[38px] w-full border-0 bg-transparent"
                    onChange={(e) => setDraft({ ...draft, labelColour: e.target.value })} />
                </label>
                <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                  What it means — optional, 160 characters
                  <input value={draft.labelNote} maxLength={160} className={box} style={boxStyle}
                    onChange={(e) => setDraft({ ...draft, labelNote: e.target.value })} />
                </label>
              </div>
            )}
            {panel.kind === "reveal" && (
              <div className="mt-14">
                {revealed ? (
                  <div className="rounded-card border p-16"
                    style={{ borderColor: "var(--danger)", background: "var(--milk)" }}>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--danger)" }}>
                      {kindWord(revealed.kind)} — read off the register at {when(new Date().toISOString())}
                    </p>
                    <p className="mt-8 break-all font-mono text-lg" style={{ color: "var(--ink)" }}>
                      {revealed.reference}
                    </p>
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      On the line of {revealed.reference_tail}. This read is written into the audit register; the
                      number itself never is. Close this panel when you have finished with it.
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    Nothing is on the screen yet. Press the button twice and the whole value is decrypted for
                    this seat only — one of twelve reads the register allows an hour, each one recorded.
                  </p>
                )}
              </div>
            )}

            {/* ---------------- 128: the claim, its withdrawal and the cut-off ---------------- */}
            {panel.kind === "claim" && (
              <>
                {!panel.companyId && (
                  <AccountPicker draft={draft} setDraft={setDraft} rows={accounts} busy={pickerBusy}
                    search={searchAccounts} onPick={(a) => setDraft({ ...draft, accountId: a.id })} />
                )}
                {panel.companyId && (
                  <p className="mt-12 text-xs" style={{ color: "var(--ink)" }}>
                    The account that carries on is <span className="font-semibold">{panel.companyName}</span>.
                    Close this form to raise the claim on a different one.
                  </p>
                )}

                <fieldset className="mt-14 rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
                  <legend className="px-8 text-[11px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>
                    The extra one — always an account this office has shut
                  </legend>
                  <div className="flex flex-wrap gap-10">
                    <input value={draft.loserQuery} aria-label="Search closed accounts"
                      onChange={(e) => setDraft({ ...draft, loserQuery: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchClosed(draft.loserQuery); } }}
                      placeholder="The name it was shut under"
                      className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
                    <button type="button" className={headBtn} style={miniStyle} disabled={closedBusy}
                      onClick={() => searchClosed(draft.loserQuery)}>
                      {closedBusy ? "Reading…" : "Find"}
                    </button>
                  </div>
                  {(loserChosen || panel.loserName) && (
                    <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
                      Named as the extra one: <span className="font-semibold">
                        {loserChosen?.name ?? panel.loserName}</span>
                      {loserChosen ? ` — shut ${day(loserChosen.deleted_at)}.` : ". "
                        + "It is not in the twenty-five most recently closed accounts, so search its name "
                        + "to see it in the list — the register already knows which one this is."}
                    </p>
                  )}
                  {closed === null ? (
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      The twenty-five accounts shut most recently. Type a name and press Find — a claim is
                      raised on the accounts the office has already closed, so none of these are on the live list.
                    </p>
                  ) : closed.length === 0 ? (
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>
                      No shut account matches. Nothing here searches the live accounts: an account that is
                      still open cannot be anybody&apos;s extra one until the tenants desk closes it.
                    </p>
                  ) : (
                    <ul className="mt-8 max-h-[240px] overflow-y-auto">
                      {closed.map((c) => (
                        <li key={c.id} className={line}>
                          <button type="button"
                            onClick={() => setDraft({ ...draft, loserId: c.id, loserQuery: c.name })}
                            className="w-full border-0 bg-transparent p-0 text-left"
                            style={{ background: c.id === draft.loserId ? "color-mix(in srgb, var(--adm-accent) 12%, transparent)" : undefined }}>
                            <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>{c.name}</p>
                            <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                              {c.type} · {label(ACCOUNT_STATES, c.account_status)} · opened {day(c.created_at)} ·{" "}
                              shut {day(c.deleted_at)}
                            </p>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </fieldset>

                {previewBusy && (
                  <p role="status" className="mt-14 text-sm" style={{ color: "var(--ink-soft)" }}>
                    Asking the register what this pair would do…
                  </p>
                )}
                {preview && !previewBusy && (
                  <div className="mt-14 grid gap-12">
                    <div className="rounded-card border p-14"
                      style={{
                        borderColor: preview.eligible ? "var(--success)" : "var(--warning)",
                        background: preview.eligible ? "var(--milk)"
                          : "color-mix(in srgb, var(--warning) 8%, transparent)"
                      }}>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em]"
                        style={{ color: preview.eligible ? "var(--success)" : "var(--danger)" }}>
                        {preview.eligible ? "The register would accept this pair" : "This pair cannot be claimed"}
                      </p>
                      <p className="mt-6 text-xs" style={{ color: "var(--ink)" }}>
                        {preview.survivor.name} carries on{preview.survivor.closed_at ? ` (shut ${day(preview.survivor.closed_at)})` : ""}
                        {" "}· {preview.loser.name} is the extra one
                        {preview.loser.closed_at ? `, shut ${day(preview.loser.closed_at)}` : ""}
                      </p>
                      {!preview.eligible && (
                        <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>
                          {preview.refusal ?? "The register gave no reason."}
                        </p>
                      )}
                      <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        Read at {when(preview.clock)}. It is the same answer the write itself would give, in
                        the same order, so nothing here is the desk&apos;s guess about what the trigger thinks.
                      </p>
                    </div>

                    {preview.eligible && (
                      <>
                        <Block head="What moves to the account that carries on"
                          hint="Only the unanswered lines, and only as new lines. An answer already signed is kept on the file it was signed on.">
                          {preview.carries.length === 0 ? (
                            <p className="mt-6 text-[11px]" style={{ color: "var(--ink)" }}>
                              Nothing. That closed account has no line waiting for an answer, so this claim
                              moves no work at all — it only writes down that the two are one company.
                            </p>
                          ) : (
                            <ul className="mt-6 grid gap-6">
                              {preview.carries.map((c, i) => (
                                <li key={`${c.kind}-${i}`} className="text-[11px]" style={{ color: "var(--ink)" }}>
                                  <span className="font-semibold">{kindWord(c.kind)}</span> — {stateWord(c.loser_status)}
                                  {c.loser_tail ? `, read as ending ${c.loser_tail}` : ", no number ever written"}
                                  {" "}· raised {day(c.loser_raised_at)}
                                </li>
                              ))}
                            </ul>
                          )}
                          {preview.skips.length > 0 && (
                            <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                              {preview.skips.map((s) => `${kindWord(s.kind)}: ${s.because}`).join(" · ")}
                            </p>
                          )}
                        </Block>

                        <Block head="What stays behind on the closed account"
                          hint="A claim is not a merge. These stay on that file and are still readable there.">
                          <div className="mt-6 flex flex-wrap gap-8">
                            {([
                              ["answered checks", preview.stays_behind.checks_answered],
                              ["open checks", preview.stays_behind.checks_open],
                              ["notes", preview.stays_behind.notes],
                              ["labels worn", preview.stays_behind.labels],
                              ["filed papers", preview.stays_behind.papers],
                              ["calls logged", preview.stays_behind.calls],
                              ["open disputes", preview.stays_behind.disputes],
                              ["refund papers", preview.stays_behind.refund_papers],
                              ["cargo files", preview.stays_behind.cargo_files],
                              ["seats", preview.stays_behind.seats],
                              ["live sessions", preview.stays_behind.sessions_live]
                            ] as [string, number][]).map(([w, n]) => (
                              <Chip key={w} edge={n > 0 ? "var(--adm-accent)" : "var(--ink-soft)"}>{n} {w}</Chip>
                            ))}
                          </div>
                        </Block>
                      </>
                    )}

                    {preview.already.length > 0 && (
                      <Block head="Claims the register already holds on this pair">
                        <ul className="mt-6 grid gap-6">
                          {preview.already.map((a) => (
                            <li key={a.id} className="text-[11px]" style={{ color: "var(--ink)" }}>
                              <span className="font-semibold">{a.direction === "same"
                                ? "This pair, the same way round"
                                : "These two accounts, the other way round"}</span>
                              {" "}· {a.status === "declared" ? "standing" : "withdrawn"} · raised {day(a.raised_at)} · “{a.reason.slice(0, 120)}”
                              {a.carried_kinds.length > 0 && (
                                <> · carried {a.carried_kinds.map(kindWord).join(", ")}</>
                              )}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          A withdrawn claim is history, not a wall: the same pair can be claimed again, and the
                          register keeps both sentences.
                        </p>
                      </Block>
                    )}
                  </div>
                )}

                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  What makes them one account — kept on the register forever
                  <textarea value={draft.reason} rows={3} className={box} style={boxStyle}
                    placeholder="the same NIDA number, the same TIN, the same director signed up twice"
                    onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                </label>
              </>
            )}

            {panel.kind === "voidclaim" && (
              <>
                <p className="mt-12 text-xs" style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{panel.companyName}</span> keeps its place as the account that
                  carried on; <span className="font-semibold">{panel.loserName}</span> stays shut exactly as it
                  was. Only the pairing stops.
                </p>
                {(panel.carried?.length ?? 0) > 0 && (
                  <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>
                    This claim had carried {panel.carried!.map(kindWord).join(", ")} onto{" "}
                    {panel.companyName}. Those lines are that account&apos;s own checks now and an answer given
                    on one is kept, so withdrawing the claim does not take them back.
                  </p>
                )}
                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  Why the claim comes off
                  <textarea value={draft.reason} rows={3} className={box} style={boxStyle}
                    onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                </label>
              </>
            )}

            {panel.kind === "cut" && (
              <>
                <p className="mt-12 text-xs" style={{ color: "var(--ink)" }}>
                  {panel.live} live session(s) on {panel.companyName}, across {panel.seats} seat(s)
                  {panel.borrowedViews ? `, of which ${panel.borrowedViews} is a read-only visit from this office` : ""}.
                </p>
                <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>
                  An access token is a signed key with no row behind it, so one already issued keeps working for
                  up to fifteen minutes even after the cut-off. Nothing on this desk shortens that; stopping an
                  account sooner is a block, and a block needs a second seat on Approvals.
                </p>
                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  Why every session is being ended
                  <textarea value={draft.reason} rows={3} className={box} style={boxStyle}
                    placeholder="the director telephoned: somebody else has the password"
                    onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                </label>
              </>
            )}

            {/* ---------------- 129: the ask, what it touches, and the signature it asks for ---------------- */}
            {panel.kind === "ask" && (
              <>
                {!panel.companyId && (
                  <AccountPicker draft={draft} setDraft={setDraft} rows={accounts} busy={pickerBusy}
                    search={searchAccounts} onPick={(a) => setDraft({ ...draft, accountId: a.id })} />
                )}
                {!panel.companyId && (
                  <fieldset className="mt-14 rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
                    <legend className="px-8 text-[11px] font-semibold uppercase tracking-[0.12em]"
                      style={{ color: "var(--ink-soft)" }}>
                      …or an account this office has shut
                    </legend>
                    <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      A copy is owed whether the account trades or not, and an erasure can only be raised on one
                      that has been shut — so both halves of the register have to be findable from here.
                    </p>
                    <div className="mt-8 flex flex-wrap gap-10">
                      <input value={draft.closedQuery} aria-label="Search shut accounts"
                        onChange={(e) => setDraft({ ...draft, closedQuery: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchClosed(draft.closedQuery); } }}
                        placeholder="The name it was shut under"
                        className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
                      <button type="button" className={headBtn} style={miniStyle} disabled={closedBusy}
                        onClick={() => searchClosed(draft.closedQuery)}>
                        {closedBusy ? "Reading…" : "Find"}
                      </button>
                    </div>
                    {closed === null ? (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        The shut accounts the office closed most recently. Press Find to search the rest by name.
                      </p>
                    ) : closed.length === 0 ? (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>
                        No shut account matches that name. The live list above is the other half.
                      </p>
                    ) : (
                      <ul className="mt-8 max-h-[200px] overflow-y-auto">
                        {closed.map((c) => (
                          <li key={c.id} className={line}>
                            <button type="button"
                              onClick={() => setDraft({ ...draft, accountId: c.id, closedQuery: c.name })}
                              className="w-full border-0 bg-transparent p-0 text-left"
                              style={{ background: c.id === draft.accountId ? "color-mix(in srgb, var(--adm-accent) 12%, transparent)" : undefined }}>
                              <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>{c.name}</p>
                              <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                                {c.type} · shut {day(c.deleted_at)}
                              </p>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </fieldset>
                )}
                {panel.companyId && (
                  <p className="mt-12 text-xs" style={{ color: "var(--ink)" }}>
                    The ask is about <span className="font-semibold">{panel.companyName}</span>. Close this form
                    to raise a paper on a different account.
                  </p>
                )}

                <fieldset className="mt-14 rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
                  <legend className="px-8 text-[11px] font-semibold uppercase tracking-[0.12em]"
                    style={{ color: "var(--ink-soft)" }}>
                    What was asked for
                  </legend>
                  <div className="grid gap-10" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                    {DATA_REQUEST_KINDS.map((k) => (
                      <label key={k} className="flex min-h-[36px] items-start gap-8 text-sm" style={{ color: "var(--ink)" }}>
                        <input type="radio" name="askKind" checked={draft.askKind === k}
                          onChange={() => setDraft({ ...draft, askKind: k, cats: [] })} />
                        <span>
                          {drKindWord(k)}
                          <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {KIND_SENTENCES[k]}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {categoriesAllowedFor(draft.askKind)
                      ? "An erasure has to name what it takes. The ten words below are the whole list the mask "
                        + "knows, in the order it walks them."
                      : `A copy is not a menu: the archive is written in ${EXPORT_SECTION_COUNT} sections and its `
                        + "manifest says what each one withheld. Choosing the parts would be choosing what to hide."}
                  </p>
                </fieldset>

                {dpBusy && (
                  <p role="status" className="mt-14 text-sm" style={{ color: "var(--ink-soft)" }}>
                    Asking the register what this would touch…
                  </p>
                )}
                {dpreview && !dpBusy && (
                  <div className="mt-14 grid gap-12">
                    <div className="rounded-card border p-14"
                      style={{
                        borderColor: dpreview.eligible ? "var(--success)" : "var(--warning)",
                        background: dpreview.eligible ? "var(--milk)"
                          : "color-mix(in srgb, var(--warning) 8%, transparent)"
                      }}>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em]"
                        style={{ color: dpreview.eligible ? "var(--success)" : "var(--danger)" }}>
                        {dpreview.eligible
                          ? draft.askKind === "export"
                            ? "The register would answer this with a copy"
                            : "The register would accept this erasure"
                          : "This ask cannot be raised yet"}
                      </p>
                      <p className="mt-6 text-xs" style={{ color: "var(--ink)" }}>
                        {dpreview.company.name} — {dpreview.company.type},{" "}
                        {dpreview.company.closed_at
                          ? `shut ${day(dpreview.company.closed_at)}`
                          : label(ACCOUNT_STATES, dpreview.company.account_status)}
                        {dpreview.sessions_live > 0 && draft.askKind === "erase"
                          ? ` · ${dpreview.sessions_live} session(s) still open on it` : ""}
                      </p>
                      {!dpreview.eligible && (
                        <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>
                          {dpreview.refusal ?? "The register gave no reason."}
                        </p>
                      )}
                      <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        Read at {when(dpreview.clock)} by the same function the mask runs, so the counts under
                        these words are the counts the signature is taken against — nothing here is this desk&apos;s
                        arithmetic.
                      </p>
                    </div>

                    <Block head={draft.askKind === "export"
                      ? "What the copy carries, category by category"
                      : "Tick what the mask takes — the counts are the register's"}
                      hint={draft.askKind === "export"
                        ? "All ten go into the archive. A value stored encrypted is decrypted for the copy alone and never for a screen."
                        : "A category with nought rows can still be ticked — the register then reports that it reached nothing there."}>
                      <ul className="mt-6 grid gap-8">
                        {CATEGORIES.map((c) => (
                          <li key={c} className="flex items-start gap-8">
                            {categoriesAllowedFor(draft.askKind) && (
                              <input type="checkbox" aria-label={`Erase ${c}`} checked={draft.cats.includes(c)}
                                onChange={(e) => setDraft({
                                  ...draft,
                                  cats: e.target.checked
                                    ? CATEGORIES.filter((x) => draft.cats.includes(x as string) || x === c) as string[]
                                    : draft.cats.filter((x) => x !== c)
                                })} />
                            )}
                            <span className="min-w-0">
                              <span className="text-[11px] font-semibold" style={{ color: "var(--ink)" }}>
                                {categoryWord(c)}
                              </span>
                              <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                                {maskWords(dpreview.masks?.[c])}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Block>

                    <Block head="What stays whatever is ticked"
                      hint="Twelve things an erasure cannot reach — the answers a check already signed, the office's own notes, the money, and the audit register itself. These are the register's words, not this desk's promise.">
                      <ul className="mt-6 grid gap-6">
                        {dpreview.keeps.map((k) => (
                          <li key={k.key} className="text-[11px]" style={{ color: "var(--ink)" }}>
                            <span className="font-semibold">{k.rows}</span> · {k.label}
                            <span className="block" style={{ color: "var(--ink-soft)" }}>{k.because}</span>
                          </li>
                        ))}
                      </ul>
                    </Block>
                  </div>
                )}

                <div className="mt-14 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                  <label className={`${labelText} block`} style={{ color: "var(--ink-soft)" }}>
                    How the caller reached the office — 3 to 80 characters
                    <input value={draft.askedIn} list="asked-in" maxLength={80} className={box} style={boxStyle}
                      placeholder="walked in with a letter"
                      onChange={(e) => setDraft({ ...draft, askedIn: e.target.value })} />
                    <datalist id="asked-in">
                      {ASKED_IN_EXAMPLES.map((w) => <option key={w} value={w} />)}
                    </datalist>
                  </label>
                  <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    Kept on the row, because &quot;who asked, and how&quot; is the first thing a supervisory
                    office reads when it checks an answer was given to the right person.
                  </p>
                </div>
                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  What was asked for, and why — {REASON_FLOOR} to 600 characters, kept forever
                  <textarea value={draft.reason} rows={3} className={box} style={boxStyle}
                    placeholder="the caller asked, on the phone, for every record held under their NIDA — read back and agreed"
                    onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                </label>
              </>
            )}

            {panel.kind === "sig" && (
              <>
                <p className="mt-12 text-xs" style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{panel.ref}</span> on{" "}
                  <span className="font-semibold">{panel.companyName}</span> — an erasure of{" "}
                  {categoryList(panel.categories)}, {panel.categories?.length ?? 0} category(ies).
                </p>
                <p className="mt-8 text-[11px]" style={{ color: "var(--warning)" }}>
                  Nothing is masked by pressing this. The register writes a proposal and a hash of what it read,
                  and the mask only runs when a seat that is not this one approves it on{" "}
                  <Link href="/control/approvals" className="underline">Approvals</Link> — the paper carries these
                  counts, and the signature is against the hash of them.
                </p>
                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  What the second seat is being asked to sign for
                  <textarea value={draft.reason} rows={3} className={box} style={boxStyle}
                    placeholder="Article 17 request received by email; the account was closed on the tenants desk on 3 March; masks the seat, session and call records only"
                    onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                </label>
              </>
            )}

            {panel.kind === "refuse" && (
              <>
                <p className="mt-12 text-xs" style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{panel.ref}</span> — {drKindWord(panel.requestKind)} on{" "}
                  <span className="font-semibold">{panel.companyName}</span>.
                </p>
                {panel.requestStatus && (
                  <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    The paper says {drStatusWord(panel.requestStatus)} now. Refusing it is an answer, not a
                    deletion: the row stays and the reason below is quoted back to the caller.
                  </p>
                )}
                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  Why the ask is refused — the words the caller will be given
                  <textarea value={draft.reason} rows={3} className={box} style={boxStyle}
                    placeholder="the request asked for a competitor's cargo records, which are another account's data — refused under Article 17(3)"
                    onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                </label>
              </>
            )}

            <div className="mt-16 flex flex-wrap items-center gap-12">
              <button type="button" disabled={!formReady() || busy} onClick={async () => {
                // The label and the caption below both promise a second press; every irreversible act
                // on this desk has to keep that promise, not only the one that decrypts a number.
                if (isArmed() && armed !== armKey(panel)) { setArmed(armKey(panel)); return; }
                setArmed(null);
                if (panel.kind === "reveal") { await revealReference(panel.id!); return; }
                await press();
              }}
                className="waisha-btn min-h-[36px] rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-40">
                {busy ? "Writing…" : isArmed() && !armed
                  ? `${submitWords(panel.kind)} — press again to confirm`
                  : armed ? `${submitWords(panel.kind)} — yes, write it` : submitWords(panel.kind)}
              </button>
              <button type="button" onClick={() => {
                setPanel(null); setDraft(EMPTY_DRAFT); setArmed(null); setRevealed(null);
              }} className={headBtn} style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                Cancel
              </button>
              {!formReady() ? (
                <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>{whyNotReady()}</p>
              ) : isArmed() ? (
                <p className="text-[11px]" style={{ color: "var(--warning)" }}>
                  {panel.kind === "reveal"
                    ? "This copies a whole identity number onto this screen and records that you did."
                    : "Press it again and this is written on the register. Nothing here takes it back."}
                </p>
              ) : null}
            </div>
          </section>
        )}

        {/* ---------------- the tabs ---------------- */}
        <div className="mt-28 flex flex-wrap items-center gap-10">
          {/* The sixth register is not offered to a seat that cannot open it — the tab loads a queue
              the API would answer with a 403, and an empty queue reads as an empty register. */}
          {TABS.filter(([k]) => k !== "requests" || canGdpr).map(([k, v]) => (
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
            {exporting ? "Reading…" : `Export ${EXPORT_REGISTER[tab]} (CSV)`}
          </button>
        </div>
        <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          The CSV carries the filters on screen, not the page on screen — up to two thousand lines.
        </p>

        {tab === "board" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={bFilter.search} aria-label="Search accounts"
                onChange={(e) => setBFilter({ ...bFilter, search: e.target.value, offset: "0" })}
                placeholder="Company name or the email it signed up with"
                className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <input value={bFilter.tin} aria-label="Search by taxpayer number" inputMode="numeric"
                onChange={(e) => setBFilter({ ...bFilter, tin: e.target.value.replace(/\D/g, ""), offset: "0" })}
                placeholder="TIN — 6 to 20 digits" className="min-w-[160px] rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={bFilter.status} aria-label="Filter the board"
                onChange={(e) => setBFilter({ ...bFilter, status: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any state of the file</option>
                {BOARD_STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select value={bFilter.kind} aria-label="Filter by open check"
                onChange={(e) => setBFilter({ ...bFilter, kind: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">With any check open</option>
                {CHECK_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
            </div>
            <p className="mt-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              The TIN box searches a hash of the number — the column itself is encrypted, so nothing here
              can read it back. <code>With any check open</code> means an account with an{" "}
              <em>open</em> line of that kind, exactly as the board&apos;s own filter does.
            </p>
            <List loading={!board} empty={!!board && board.rows.length === 0}
              emptyWords="No account matches this filter. A board that is empty after a filter is the filter, not an empty register — clear the boxes and read again."
              head={["Account", "The file", "Labels", "Trust", "Plan and seats", "Last word", ""]}
              rows={(board?.rows ?? []).map((r) => ([
                <span key="a" className="break-words">
                  <span className="font-semibold">{r.name}</span>
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {r.type} · {label(ACCOUNT_STATES, r.account_status)} · since {day(r.created_at)}
                  </span>
                </span>,
                <span key="b" className="tabular-nums whitespace-nowrap">
                  {(r.checks.open ?? 0) > 0 && <Chip edge={CHECK_EDGE.awaiting}>{r.checks.open} open</Chip>}{" "}
                  {(r.checks.approved ?? 0) > 0 && <Chip edge={CHECK_EDGE.approved}>{r.checks.approved} approved</Chip>}{" "}
                  {(r.checks.refused ?? 0) > 0 && <Chip edge={CHECK_EDGE.rejected}>{r.checks.refused} refused</Chip>}{" "}
                  {(r.checks.expired ?? 0) > 0 && <Chip edge={CHECK_EDGE.needs_more}>{r.checks.expired} past day</Chip>}{" "}
                  {(r.checks.lines ?? 0) === 0 && <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>never checked</span>}
                </span>,
                <span key="c" className="flex flex-wrap gap-6">
                  {r.tags.length === 0 && <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>none</span>}
                  {r.tags.map((t) => (
                    <span key={t.id} className={chip}
                      style={{ border: `1px solid ${t.colour ?? "var(--line)"}`, color: t.colour ?? "var(--ink-soft)" }}>
                      {t.name}
                    </span>
                  ))}
                </span>,
                <span key="d">
                  <TrustCell t={r.trust} />
                </span>,
                <span key="e" className="tabular-nums">
                  {r.plan_name ?? "no plan"}
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {r.seats} of {r.seats_licensed} seats ·{" "}
                    {r.licence_expires_at ? (dayPast(r.licence_expires_at) ? "licence gone" : "licence live") : "no platform licence"}
                  </span>
                </span>,
                <span key="f" className="break-words text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {r.blocked_note && (
                    <span className="block" style={{ color: "var(--danger)" }}>blocked: {r.blocked_note}</span>
                  )}
                  {r.last_note ? r.last_note : "no note on file"}
                </span>,
                <span key="g" className="flex flex-wrap gap-8">
                  <button type="button" className={mini} style={miniStyle}
                    onClick={() => openDossier(r.company_tenant_id, r.name)}>
                    {dossierFor === r.company_tenant_id ? "Close the dossier" : "Open"}
                  </button>
                  {canManage && (
                    <button type="button" className={mini} style={miniStyle}
                      onClick={() => openPanel({ kind: "raise", companyId: r.company_tenant_id, companyName: r.name })}>
                      Raise a check
                    </button>
                  )}
                  {canManage && (
                    <button type="button" className={mini} style={miniStyle}
                      onClick={() => openPanel({ kind: "note", companyId: r.company_tenant_id, companyName: r.name })}>
                      Note
                    </button>
                  )}
                </span>
              ]))}
            />
            <Pager filter={bFilter} setFilter={setBFilter} total={board?.total ?? 0} />
          </section>
        )}

        {tab === "checks" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={cFilter.q} aria-label="Search checks"
                onChange={(e) => setCFilter({ ...cFilter, q: e.target.value, offset: "0" })}
                placeholder="Company name, its email or the last four of a number"
                className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={cFilter.status} aria-label="Filter by state"
                onChange={(e) => setCFilter({ ...cFilter, status: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any state</option>
                <option value="open">Open — anything the office owes</option>
                {CHECK_KINDS.length > 0 && [...OPEN_STATES, ...ANSWERS].map((s) => (
                  <option key={s} value={s}>{CHECK_STATE_LABELS[s]}</option>
                ))}
              </select>
              <select value={cFilter.kind} aria-label="Filter by kind"
                onChange={(e) => setCFilter({ ...cFilter, kind: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any kind</option>
                {CHECK_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
            </div>
            {cCounts && (
              <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                {cCounts.total} lines over {cCounts.accounts} account(s) · {cCounts.awaiting} waiting on the account ·{" "}
                {cCounts.submitted} paper in, no answer · {cCounts.approved} approved · {cCounts.refused} refused or
                sent back ({cCounts.awaiting_more} asking for more) · {cCounts.expired} approved but past their day
              </p>
            )}
            <List loading={cRows.length === 0 && !cCounts} empty={cRows.length === 0 && !!cCounts}
              emptyWords="No check line matches this filter. Open lines are the ones the office owes an answer on — choose “Open” above."
              head={["Account", "What", "State", "Number", "Day", "The words", "Raised", ""]}
              rows={cRows.map((r) => ([
                <span key="a" className="break-words">
                  <span className="font-semibold">{r.company_name}</span>
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>{r.company_type}</span>
                </span>,
                <span key="b">{kindWord(r.kind)}</span>,
                <span key="c"><Chip edge={CHECK_EDGE[r.status]}>{stateWord(r.status)}</Chip></span>,
                <span key="d" className="font-mono">
                  {r.reference_tail ?? <span style={{ color: "var(--ink-soft)" }}>nothing read</span>}
                </span>,
                <span key="e" className="whitespace-nowrap">
                  {r.expires_on
                    ? <span style={{ color: dayPast(r.expires_on) ? "var(--danger)" : "var(--ink)" }}>{day(r.expires_on)}</span>
                    : "—"}
                </span>,
                <span key="f" className="break-words text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {r.reason ?? (r.decided_name ? `${r.decided_name} signed it ${day(r.decided_at)}` : "no answer yet")}
                </span>,
                <span key="g" className="whitespace-nowrap">{day(r.raised_at)}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {age(r.raised_at)} ago · {r.raised_name ?? "—"}
                  </span></span>,
                <span key="h" className="flex flex-wrap gap-8">
                  <button type="button" className={mini} style={miniStyle}
                    onClick={() => openDossier(r.company_tenant_id, r.company_name)}>
                    Account
                  </button>
                  {canManage && isOpenState(r.status) && (
                    <button type="button" className={mini} style={miniStyle}
                      onClick={() => openPanel({
                        kind: "paper", id: r.id, checkKind: r.kind as CheckKind,
                        hasReference: r.has_reference, expiresOn: r.expires_on,
                        companyName: r.company_name, companyId: r.company_tenant_id
                      })}>
                      Paper is in
                    </button>
                  )}
                  {canVerify && isOpenState(r.status) && (
                    <button type="button" className={mini} style={{ borderColor: "var(--adm-accent)", color: "var(--ink)" }}
                      onClick={() => openPanel({
                        kind: "answer", id: r.id, checkKind: r.kind as CheckKind,
                        hasReference: r.has_reference, expiresOn: r.expires_on, ref: r.reference_tail ?? undefined,
                        companyName: r.company_name, companyId: r.company_tenant_id
                      })}>
                      Answer
                    </button>
                  )}
                  {canVerify && r.has_reference && (
                    <button type="button" className={mini} style={{ borderColor: "var(--warning)", color: "var(--warning)" }}
                      onClick={() => openPanel({
                        kind: "reveal", id: r.id, checkKind: r.kind as CheckKind,
                        ref: r.reference_tail ?? undefined, companyName: r.company_name
                      })}>
                      Read the number
                    </button>
                  )}
                </span>
              ]))}
            />
            <Pager filter={cFilter} setFilter={setCFilter} total={cRows[0]?.total ?? 0} />
          </section>
        )}

        {tab === "notes" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={nFilter.q} aria-label="Search notes"
                onChange={(e) => setNFilter({ ...nFilter, q: e.target.value, offset: "0" })}
                placeholder="A company, or a sentence the office wrote"
                className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={nFilter.status} aria-label="Filter notes"
                onChange={(e) => setNFilter({ ...nFilter, status: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Live and withdrawn</option>
                <option value="live">Still on the file</option>
                <option value="withdrawn">Withdrawn</option>
              </select>
            </div>
            {nCounts && (
              <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                {nCounts.total} note(s) over {nCounts.accounts} account(s) · {nCounts.live} on the file ·{" "}
                {nCounts.withdrawn} withdrawn · {nCounts.edited} rewritten at least once
              </p>
            )}
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              A note keeps its author forever — 127&apos;s trigger refuses a rewrite of that column — and a
              withdrawn note keeps its words, because the withdrawal is about them. What a note said before it
              was rewritten is in the audit register, not here.
            </p>
            <List loading={nRows.length === 0 && !nCounts} empty={nRows.length === 0 && !!nCounts}
              emptyWords="No note matches this filter. Notes are written on an account, from its dossier or from a row on the board."
              head={["Account", "What the office wrote", "By", "When", ""]}
              rows={nRows.map((r) => ([
                <span key="a" className="break-words font-semibold">{r.company_name}<br />
                  <span className="text-[10px] font-normal" style={{ color: "var(--ink-soft)" }}>{r.company_type}</span></span>,
                <span key="b" className="break-words">
                  {r.body}
                  {r.voided_at && (
                    <span className="mt-6 block text-[10px]" style={{ color: "var(--danger)" }}>
                      withdrawn {day(r.voided_at)} by {r.voided_by_name ?? "—"} — {r.void_reason}
                    </span>
                  )}
                  {r.edited_at && !r.voided_at && (
                    <span className="mt-6 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      rewritten {day(r.edited_at)}
                    </span>
                  )}
                </span>,
                <span key="c">{r.author_name ?? "—"}</span>,
                <span key="d" className="whitespace-nowrap">{day(r.created_at)}<br />
                  <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{age(r.created_at)} ago</span></span>,
                <span key="e" className="flex flex-wrap gap-8">
                  <button type="button" className={mini} style={miniStyle}
                    onClick={() => openDossier(r.company_tenant_id, r.company_name)}>
                    Account
                  </button>
                  {canManage && !r.voided_at && (
                    <>
                      <button type="button" className={mini} style={miniStyle}
                        onClick={() => openPanel({
                          kind: "edit", id: r.id, companyId: r.company_tenant_id,
                          companyName: r.company_name, body: r.body
                        }, { text: r.body })}>
                        Rewrite
                      </button>
                      <button type="button" className={mini} style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                        onClick={() => openPanel({
                          kind: "void", id: r.id, companyId: r.company_tenant_id,
                          companyName: r.company_name, body: r.body
                        })}>
                        Withdraw
                      </button>
                    </>
                  )}
                </span>
              ]))}
            />
            <Pager filter={nFilter} setFilter={setNFilter} total={nRows[0]?.total ?? 0} />
          </section>
        )}

        {tab === "tags" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={tFilter.q} aria-label="Search labels"
                onChange={(e) => setTFilter({ ...tFilter, q: e.target.value, offset: "0" })}
                placeholder="A label, or what it means"
                className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={tFilter.status} aria-label="Filter labels"
                onChange={(e) => setTFilter({ ...tFilter, status: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Live and retired</option>
                <option value="live">Still in the library</option>
                <option value="retired">Retired</option>
              </select>
              {canManage && (
                <button type="button" onClick={() => openPanel({ kind: "label" })} className={headBtn}
                  style={{ borderColor: "var(--adm-accent)", color: "var(--ink)" }}>
                  {panel?.kind === "label" ? "Close the form" : "Write a label"}
                </button>
              )}
            </div>
            {tCounts && (
              <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                {tCounts.in_library} label(s) ever written · {tCounts.live} in the library now · {tCounts.retired} retired
              </p>
            )}
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              This tab is the library. The accounts wearing a word are behind “Who wears it”, and the CSV is
              the pairing history rather than the library itself.
            </p>
            <List loading={tRows.length === 0 && !tCounts} empty={tRows.length === 0 && !!tCounts}
              emptyWords="No label matches this filter. The library starts empty — a word has to be written before an account can wear it."
              head={["Label", "What it means", "Worn now", "Ever", "Written", ""]}
              rows={tRows.map((r) => ([
                <span key="a">
                  <span className={chip} style={{
                    border: `1px solid ${r.colour ?? "var(--line)"}`,
                    color: r.colour ?? "var(--ink-soft)",
                    background: r.deleted_at ? "transparent" : "color-mix(in srgb, var(--milk) 60%, transparent)"
                  }}>{r.name}</span>
                  {r.deleted_at && <span className="ml-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>retired {day(r.deleted_at)}</span>}
                </span>,
                <span key="b" className="break-words text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {r.note ?? "nothing written"}
                </span>,
                <span key="c" className="tabular-nums">
                  <Chip edge={r.live > 0 ? "var(--adm-accent)" : "var(--ink-soft)"}>{r.live}</Chip>
                </span>,
                <span key="d" className="tabular-nums">{r.worn}</span>,
                <span key="e" className="whitespace-nowrap">{day(r.created_at)}</span>,
                <span key="f" className="flex flex-wrap gap-8">
                  <button type="button" className={mini} style={miniStyle} onClick={() => openWearers(r)}>
                    {wearersTag?.id === r.id ? "Close" : "Who wears it"}
                  </button>
                  {canManage && !r.deleted_at && (
                    <button type="button" className={mini} style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                      onClick={() => openPanel({ kind: "retire", id: r.id, tagName: r.name })}>
                      Retire it
                    </button>
                  )}
                </span>
              ]))}
            />
            <Pager filter={tFilter} setFilter={setTFilter} total={tRows[0]?.total ?? 0} />
          </section>
        )}

        {tab === "claims" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={kFilter.q} aria-label="Search claims"
                onChange={(e) => setKFilter({ ...kFilter, q: e.target.value, offset: "0" })}
                placeholder="Either account, or the sentence that made them one"
                className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={kFilter.status} aria-label="Filter claims"
                onChange={(e) => setKFilter({ ...kFilter, status: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Standing and withdrawn</option>
                <option value="declared">Standing</option>
                <option value="voided">Withdrawn</option>
              </select>
              {canMerge && (
                <button type="button" onClick={() => openPanel({ kind: "claim" })} className={headBtn}
                  style={{ borderColor: "var(--adm-accent)", color: "var(--ink)" }}>
                  {panel?.kind === "claim" ? "Close the form" : "Declare a duplicate"}
                </button>
              )}
            </div>
            {kCounts && (
              <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                {kCounts.all} claim(s) ever raised · {kCounts.standing} standing · {kCounts.withdrawn} withdrawn ·{" "}
                {kCounts.carried} that moved a check
              </p>
            )}
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              This register is not a merge. A claim writes down which account carries on and which one is the
              extra one, and it carries only the checks nobody had answered yet — as new lines that still have
              to be checked. Everything else stays on the closed account&apos;s own file, and both halves stay
              readable below.
            </p>
            <List loading={kRows.length === 0 && !kCounts} empty={kRows.length === 0 && !!kCounts}
              emptyWords="No claim on this office's register. Two accounts are only ever declared one here — the extra one has to be an account the tenants desk has already shut."
              head={["The pair", "Why they are one", "Carried", "Raised by", "Day", ""]}
              rows={kRows.map((r) => ([
                <span key="a">
                  <button type="button" className="border-0 bg-transparent p-0 text-left"
                    style={{ color: "var(--ink)" }} onClick={() => openDossier(r.survivor_id, r.survivor_name)}>
                    <span className="text-xs font-semibold">{r.survivor_name}</span>
                    <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      carries on · {label(ACCOUNT_STATES, r.survivor_status)}
                    </span>
                  </button>
                  <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    the extra one:
                  </span>
                  <button type="button" className="mt-2 border-0 bg-transparent p-0 text-left"
                    style={{ color: "var(--ink)" }} onClick={() => openDossier(r.loser_id, r.loser_name)}>
                    <span className="text-xs font-semibold">{r.loser_name}</span>
                    <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      shut {day(r.loser_closed_at)}
                    </span>
                  </button>
                  {r.status === "voided" && (
                    <span className="mt-4 block text-[10px]" style={{ color: "var(--danger)" }}>
                      withdrawn {day(r.voided_at)} by {r.voided_name ?? "—"}
                    </span>
                  )}
                </span>,
                <span key="b" className="break-words text-[11px]" style={{ color: "var(--ink)" }}>
                  {r.reason}
                  {r.void_reason && (
                    <span className="mt-4 block" style={{ color: "var(--ink-soft)" }}>
                      taken back because: {r.void_reason}
                    </span>
                  )}
                </span>,
                <span key="c">
                  {r.carried_kinds.length === 0 ? (
                    <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>nothing</span>
                  ) : (
                    <span className="flex flex-wrap gap-6">
                      {r.carried_kinds.map((k) => <Chip key={k} edge="var(--adm-accent)">{kindWord(k)}</Chip>)}
                    </span>
                  )}
                </span>,
                <span key="d" className="text-[11px]" style={{ color: "var(--ink)" }}>{r.raised_name ?? "—"}</span>,
                <span key="e" className="whitespace-nowrap text-[11px]">{day(r.raised_at)}</span>,
                <span key="f" className="flex flex-wrap gap-8">
                  {canMerge && r.status === "declared" && (
                    <button type="button" className={mini}
                      style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                      onClick={() => openPanel({
                        kind: "voidclaim", id: r.id, companyId: r.survivor_id, companyName: r.survivor_name,
                        loserName: r.loser_name, carried: r.carried_kinds
                      })}>
                      Withdraw it
                    </button>
                  )}
                  {canMerge && r.status === "voided" && (
                    <button type="button" className={mini} style={miniStyle}
                      onClick={() => openPanel({
                        kind: "claim", companyId: r.survivor_id, companyName: r.survivor_name,
                        loserId: r.loser_id, loserName: r.loser_name
                      }, { accountId: r.survivor_id, loserId: r.loser_id, loserQuery: r.loser_name })}>
                      Claim them again
                    </button>
                  )}
                </span>
              ]))}
            />
            <Pager filter={kFilter} setFilter={setKFilter} total={kRows[0]?.total ?? 0} />
          </section>
        )}

        {tab === "requests" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={rFilter.q} aria-label="Search data requests"
                onChange={(e) => setRFilter({ ...rFilter, q: e.target.value, offset: "0" })}
                placeholder="DR number, the account, or what the caller asked for"
                className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={rFilter.status} aria-label="Filter by state of the paper"
                onChange={(e) => setRFilter({ ...rFilter, status: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any state of the paper</option>
                {REQUEST_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select>
              <select value={rFilter.kind} aria-label="Filter by kind of ask"
                onChange={(e) => setRFilter({ ...rFilter, kind: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Either kind of ask</option>
                {DATA_REQUEST_KINDS.map((k) => <option key={k} value={k}>{drKindWord(k)}</option>)}
              </select>
              {canGdpr && (
                <button type="button" onClick={() => openPanel({ kind: "ask" })} className={headBtn}
                  style={{ borderColor: "var(--adm-accent)", color: "var(--ink)" }}>
                  {panel?.kind === "ask" ? "Close the form" : "Answer an ask"}
                </button>
              )}
            </div>
            {rCounts && (
              <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                {rCounts.all} paper(s) ever raised · {rCounts.raised} nothing done ·{" "}
                {rCounts.pending_signature} waiting on a second seat · {rCounts.delivered} copies handed over ·{" "}
                {rCounts.erased} masked · {rCounts.refused} refused. The register holds {rCounts.export} copy
                and {rCounts.erase} erasure paper(s).
              </p>
            )}
            <div className="mt-12 flex flex-wrap gap-8">
              {BOARD_CHIPS.map((c) => {
                const on = c.sends.status ? rFilter.status === c.sends.status
                  : c.sends.kind ? rFilter.kind === c.sends.kind
                    : !rFilter.status && !rFilter.kind;
                return (
                  <button key={c.key} type="button" className={mini}
                    style={on ? {
                      borderColor: "var(--adm-accent)", color: "var(--ink)",
                      background: "color-mix(in srgb, var(--adm-accent) 14%, transparent)"
                    } : miniStyle}
                    onClick={() => setRFilter({
                      ...rFilter, offset: "0",
                      status: on && c.sends.status ? "" : c.sends.status ?? rFilter.status,
                      kind: on && c.sends.kind ? "" : c.sends.kind ?? rFilter.kind
                    })}>
                    {c.label} · {rCounts?.[c.key as keyof RequestCounts] ?? "—"}
                  </button>
                );
              })}
            </div>
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              The eight numbers are the board&apos;s own counts over the whole register, and each one is the filter
              it sends back — a paper counted under a word the row does not hold would read nought forever. Two
              acts sit behind two duties here: reading the register and handing a copy over cost{" "}
              <code>control.customers.gdpr</code>, and writing an erasure or refusing one costs{" "}
              <code>control.customers.erase</code>. Neither one runs the mask — that is a second seat&apos;s
              signature on <Link href="/control/approvals" className="underline">Approvals</Link>.
            </p>
            <List loading={rRows.length === 0 && !rCounts} empty={rRows.length === 0 && !!rCounts}
              emptyWords="No paper on this register with that filter. An empty queue after a chip is the chip, not an empty register — clear it and read again."
              head={["The paper", "What was asked", "Account", "State", "What the answer did", ""]}
              rows={rRows.map((r) => ([
                <span key="a">
                  <button type="button" className="border-0 bg-transparent p-0 text-left"
                    style={{ color: "var(--ink)" }} onClick={() => openPaper(r.id)}>
                    <span className="text-xs font-semibold">{r.ref}</span>
                    <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      {drKindWord(r.kind)} · raised {day(r.raised_at)}
                    </span>
                  </button>
                  <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    by {r.raised_name ?? "—"}
                  </span>
                </span>,
                <span key="b" className="break-words text-[11px]" style={{ color: "var(--ink)" }}>
                  {r.reason}
                  <span className="mt-4 block" style={{ color: "var(--ink-soft)" }}>
                    asked in: {r.asked_in ?? "not written down"}
                  </span>
                  {(r.categories ?? []).length > 0 && (
                    <span className="mt-4 block">
                      {r.categories!.map((c) => <Chip key={c} edge="var(--adm-accent)">{c}</Chip>)}
                    </span>
                  )}
                </span>,
                <span key="c">
                  <button type="button" className="border-0 bg-transparent p-0 text-left"
                    style={{ color: "var(--ink)" }} onClick={() => openDossier(r.company_id, r.company_name)}>
                    <span className="text-xs font-semibold">{r.company_name}</span>
                  </button>
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {r.company_closed_at ? `shut ${day(r.company_closed_at)}` : "still trading"}
                  </span>
                </span>,
                <span key="d" className="whitespace-nowrap">
                  <Chip edge={STATUS_EDGE[r.request_status] ?? "var(--line)"}>
                    {drStatusWord(r.request_status)}
                  </Chip>
                  {r.approval_status && (
                    <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      paper {r.approval_status}
                      {r.approval_expires_at ? ` · expires ${day(r.approval_expires_at)}` : ""}
                    </span>
                  )}
                </span>,
                <span key="e" className="break-words text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {r.request_status === "delivered" && (
                    <>
                      {r.deliveries} hand-over(s) · {size(r.bundle_bytes)} · SHA {shaWords(r.bundle_sha256)}
                      <span className="block">
                        {r.delivered_at ? `received ${when(r.delivered_at)}` : "stamped without a received time"}
                      </span>
                    </>
                  )}
                  {r.request_status === "erased" && (
                    <>
                      masked {when(r.erased_at)} by {r.erased_name ?? "—"} ·{" "}
                      {Object.values(r.erased_rows ?? {}).reduce((a, b) => a + Number(b || 0), 0)} row(s) reached
                      <span className="block">
                        {(r.kept ?? []).length} register(s) kept — {(r.kept ?? []).filter((k) => k.rows > 0)
                          .reduce((a, b) => a + b.rows, 0)} row(s) untouched
                      </span>
                    </>
                  )}
                  {r.request_status === "refused" && (
                    <>
                      refused {day(r.refused_at)}
                      <span className="block" style={{ color: "var(--ink)" }}>“{(r.refused_note ?? "").slice(0, 140)}”</span>
                    </>
                  )}
                  {r.request_status === "pending_signature" && (
                    <>waiting on a seat that did not raise it · hash {shaWords(r.payload_sha256)}
                      <span className="block">signed by: {r.signed_name ?? "nobody yet"}</span>
                    </>
                  )}
                  {r.request_status === "raised" && "nothing has been handed over or masked yet"}
                </span>,
                <span key="f" className="flex flex-wrap gap-8">
                  <button type="button" className={mini} style={miniStyle} onClick={() => openPaper(r.id)}>
                    {paperFor === r.id ? "Close the paper" : "Read the paper"}
                  </button>
                  {!isOpenRequest(r.request_status) && (
                    <button type="button" className={mini} style={miniStyle}
                      onClick={() => openPanel({
                        kind: "ask", companyId: r.company_id, companyName: r.company_name, requestKind: r.kind
                      }, { accountId: r.company_id, askKind: r.kind as DataRequestKind, closedQuery: r.company_name })}>
                      Answer them again
                    </button>
                  )}
                </span>
              ]))}
            />
            <Pager filter={rFilter} setFilter={setRFilter} total={rRows[0]?.total ?? 0} />
          </section>
        )}
      </main>
    </div>
  );
}

// ---------- the dossier ----------

function DossierBlock({ d, panel, openPanel, close, canManage, canVerify, busy, timeline,
  tlSource, setTlSource, openDossier, canMerge, canDisconnect, toggleSeats, accessFor }: {
    d: Dossier; panel: Panel | null; openPanel: (p: Panel, seed?: Partial<Draft>) => void;
    close: () => void; canManage: boolean; canVerify: boolean; busy: boolean;
    timeline: Timeline | null; tlSource: string; setTlSource: (s: string) => void;
    openDossier: (id: string, name: string) => void;
    canMerge: boolean; canDisconnect: boolean; toggleSeats: (id: string) => void;
    accessFor: string | null;
  }) {
  const c = d.company;
  const t = d.trust;
  const open = d.checks.filter((x) => isOpenState(x.status));
  const profile = d.profile ?? {};
  return (
    <section id="customers-dossier" className="mt-24 rounded-card border-2 p-20"
      style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
      <div className="flex flex-wrap items-start justify-between gap-16">
        <div className="min-w-0">
          <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>{c.name}</h2>
          <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            {c.type} · {label(ACCOUNT_STATES, c.account_status)} · trading as {c.slug ?? "no slug"} ·{" "}
            {c.email ?? "no email on file"} · opened {day(c.created_at)} ({age(c.created_at)} ago)
          </p>
          <p className="mt-4 flex flex-wrap gap-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
            <span className={chip} style={{ border: "1px solid var(--line)" }}>
              {c.phone_on_file ? "phone on file" : "no phone"}
            </span>
            <span className={chip} style={{ border: "1px solid var(--line)" }}>
              {c.tin_on_file ? "TIN on file" : "no TIN"}
            </span>
            {c.deleted_at && <Chip edge="var(--danger)">closed {day(c.deleted_at)}</Chip>}
            {c.trial_ends_at && <Chip edge={dayPast(c.trial_ends_at) ? "var(--warning)" : "var(--adm-accent)"}>
              trial {dayPast(c.trial_ends_at) ? "ran out" : "to"} {day(c.trial_ends_at)}
            </Chip>}
            {c.licence_expires_at && <Chip edge={dayPast(c.licence_expires_at) ? "var(--danger)" : "var(--success)"}>
              platform licence {dayPast(c.licence_expires_at) ? "gone" : "to"} {day(c.licence_expires_at)}
            </Chip>}
          </p>
        </div>
        <div className="flex flex-wrap gap-8">
          {canManage && (
            <>
              <button type="button" className={headBtn} style={miniStyle}
                onClick={() => openPanel({ kind: "raise", companyId: c.id, companyName: c.name })}>
                Raise a check
              </button>
              <button type="button" className={headBtn} style={miniStyle}
                onClick={() => openPanel({ kind: "note", companyId: c.id, companyName: c.name })}>
                Write a note
              </button>
              <button type="button" className={headBtn} style={miniStyle}
                onClick={() => openPanel({ kind: "wear", companyId: c.id, companyName: c.name })}>
                Label it
              </button>
            </>
          )}
          {canMerge && !c.deleted_at && (
            <button type="button" className={headBtn} style={miniStyle}
              onClick={() => openPanel({ kind: "claim", companyId: c.id, companyName: c.name },
                { accountId: c.id })}>
              {panel?.kind === "claim" && panel.companyId === c.id ? "Close the claim" : "Declare a duplicate"}
            </button>
          )}
          {canDisconnect && (
            <button type="button" className={headBtn} style={miniStyle}
              onClick={() => toggleSeats(c.id)}>
              {accessFor === c.id ? "Hide the seats" : "Who is inside"}
            </button>
          )}
          <Link href={`/control/tenants?account=${c.id}`} className={headBtn}
            style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
            Bans and actions
          </Link>
          <button type="button" className={headBtn} style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}
            onClick={close}>
            Close the dossier
          </button>
        </div>
      </div>

      <div className="mt-20 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        {/* trust */}
        <Block head="What the account is worth right now"
          hint="Worked out of the answers, the blocks this year and how long the account has been here. Nothing is stored — ask again next week and it can move.">
          {!t || t.status !== "ok" ? (
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              The trust read has no opinion: this account is not on the register.
            </p>
          ) : (
            <>
              <div className="mt-8 flex items-end gap-12">
                <p className="text-3xl font-bold tabular-nums" style={{ color: BAND_EDGE[t.band ?? ""] ?? "var(--ink)" }}>
                  {t.score}
                </p>
                <div>
                  <Chip edge={BAND_EDGE[t.band ?? ""] ?? "var(--line)"}>{label(Object.entries(BAND_LABELS), t.band)}</Chip>
                  <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    from a base of {t.base ?? 50}, clamped 0 to 100
                  </p>
                </div>
              </div>
              <div className="mt-8 h-6 overflow-hidden rounded-input" style={{ background: "var(--milk)", border: "1px solid var(--line)" }}>
                <div className="h-full" style={{
                  width: `${Math.max(0, Math.min(100, t.score ?? 0))}%`,
                  background: BAND_EDGE[t.band ?? ""] ?? "var(--adm-accent)"
                }} />
              </div>
              {(t.factors ?? []).length === 0 && (
                <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Nothing has moved it off the base yet.
                </p>
              )}
              <ul className="mt-8">
                {(t.factors ?? []).map((f, i) => (
                  <li key={`${f.label}-${i}`} className={line}>
                    <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>
                      <span className="tabular-nums" style={{ color: f.points > 0 ? "var(--success)" : "var(--danger)" }}>
                        {f.points > 0 ? `+${f.points}` : f.points}
                      </span>{" "}
                      {f.label}
                    </p>
                    <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{f.detail}</p>
                  </li>
                ))}
              </ul>
              {t.basis && (
                <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {t.basis.approved ?? 0} approved · {t.basis.open ?? 0} open · {t.basis.refused ?? 0} refused ·{" "}
                  {t.basis.expired ?? 0} past their day · {t.basis.lines ?? 0} line(s) in all ·{" "}
                  {t.basis.blocks_365d ?? 0} block(s) this year · {t.basis.seats ?? 0} seat(s)
                </p>
              )}
            </>
          )}
        </Block>

        {/* seats, calls, exit */}
        <Block head="Seats, calls and how it left">
          <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>
            {d.seats.live} active seat(s), {d.seats.pending} waiting to verify, of {c.seats_licensed} licensed ·{" "}
            {d.seats.sessions_live} live session(s).
          </p>
          <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            last login {when(d.seats.last_login)}.
          </p>
          <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>
            {d.calls.open} call(s) still open of {d.calls.all} · {d.calls.disputes} dispute(s) live ·{" "}
            {d.calls.papers} refund paper(s).
          </p>
          <Link href="/control/tickets" className="mt-4 flex w-fit min-h-[36px] items-center text-[11px] underline" style={{ color: "var(--adm-accent)" }}>
            The call register
          </Link>
          <Link href="/control/service" className="mt-4 flex w-fit min-h-[36px] items-center text-[11px] underline" style={{ color: "var(--adm-accent)" }}>
            Disputes and refund papers
          </Link>
          {d.exit ? (
            <div className="mt-8 rounded-input px-12 py-8 text-xs"
              style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
              <span className="font-semibold" style={{ color: "var(--ink)" }}>Cancelled</span>{" "}
              <span style={{ color: "var(--ink-soft)" }}>{day(d.exit.created_at)} · {d.exit.reason_code}</span>
              <p className="mt-4 break-words" style={{ color: "var(--ink)" }}>{d.exit.note}</p>
            </div>
          ) : (
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>No cancellation on the register.</p>
          )}
          {d.actions.length > 0 && (
            <ul className="mt-8">
              {d.actions.map((a, i) => (
                <li key={`${a.created_at}-${i}`} className={line}>
                  <p className="text-xs font-semibold" style={{ color: ACTION_EDGE[a.action] ?? "var(--ink)" }}>
                    {a.action} · {day(a.created_at)}
                  </p>
                  <p className="text-[10px] break-words" style={{ color: "var(--ink-soft)" }}>
                    {a.note ?? "no reason recorded"} — {a.actor_kind}{a.reason_code ? ` (${a.reason_code})` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Block>

        {/* what the account itself filed */}
        <Block head="What the account says about itself"
          hint="Its own filed words, not the office's verdict. The two can disagree, and a clerk needs to see that before answering a check.">
          <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
            {profile.company_name ?? c.name}
            {profile.tin_display ? ` · TIN ${profile.tin_display}` : ""}
            {profile.vat_number ? ` · VAT ${profile.vat_number}` : ""}
            {profile.brela_number ? ` · BRELA ${profile.brela_number}` : ""}
          </p>
          <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            {profile.transport_licence_no
              ? `transport licence ${profile.transport_licence_no}${profile.transport_licence_expiry ? `, to ${day(profile.transport_licence_expiry)}` : ""}`
              : "no transport licence number in its profile"}
            {profile.fleet_size_declared ? ` · fleet declared ${profile.fleet_size_declared}` : ""}
            {profile.website ? ` · ${profile.website}` : ""}
          </p>
          {d.licences.length > 0 && (
            <ul className="mt-8">
              {d.licences.map((l, i) => (
                <li key={`${l.authority}-${i}`} className={line}>
                  <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>
                    {l.authority}{l.title ? ` — ${l.title}` : ""}
                  </p>
                  <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {l.licence_number ?? "number not recorded"} ·{" "}
                    {l.expiry_date
                      ? <span style={{ color: dayPast(l.expiry_date) ? "var(--danger)" : undefined }}>
                        {dayPast(l.expiry_date) ? "runs out " : "runs out "}{day(l.expiry_date)}
                      </span>
                      : "no expiry date"}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {d.paper.length > 0 && (
            <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
              {d.paper.length} file(s) filed against this account:{" "}
              {d.paper.slice(0, 4).map((p) => `${p.file_name} (${size(p.size_bytes)})`).join(", ")}
              {d.paper.length > 4 ? ", …" : ""}
            </p>
          )}
        </Block>
      </div>

      {/* the checks */}
      <div className="mt-20">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          The checks — {d.checks.length} line(s), {open.length} the office still owes an answer on
        </h3>
        {d.checks.length === 0 ? (
          <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>
            Nothing has ever been checked about this account. That is a fact the board counts, not an
            oversight — the trust read calls it <em>never verified</em>.
          </p>
        ) : (
          <div className="mt-8 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--line)" }}>
                  {["What", "State", "Number", "Runs out", "The answer", "Raised by", "Signed by", ""].map((h) => (
                    <th key={h} className="px-10 py-8 text-left font-semibold uppercase tracking-[0.1em]"
                      style={{ color: "var(--ink-soft)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.checks.map((x) => (
                  <tr key={x.id} className="align-top" style={{ borderBottom: "1px solid var(--line)" }}>
                    <td className="px-10 py-10">
                      {kindWord(x.kind)}
                      {!x.is_current && <span className="ml-6 text-[10px]" style={{ color: "var(--ink-soft)" }}>older line</span>}
                    </td>
                    <td className="px-10 py-10"><Chip edge={CHECK_EDGE[x.status]}>{stateWord(x.status)}</Chip></td>
                    <td className="px-10 py-10 font-mono">
                      {x.reference_tail ?? <span style={{ color: "var(--ink-soft)" }}>nothing read</span>}
                    </td>
                    <td className="px-10 py-10 whitespace-nowrap">
                      {x.expires_on
                        ? <span style={{ color: dayPast(x.expires_on) ? "var(--danger)" : "var(--ink)" }}>{day(x.expires_on)}</span>
                        : "—"}
                    </td>
                    <td className="px-10 py-10 break-words" style={{ color: "var(--ink-soft)" }}>
                      {x.reason ?? (x.status === "approved" ? "confirmed against the paper on file" : "—")}
                    </td>
                    <td className="px-10 py-10 whitespace-nowrap">
                      {x.raised_name ?? "—"}
                      <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>{day(x.raised_at)}</span>
                    </td>
                    <td className="px-10 py-10 whitespace-nowrap">
                      {x.decided_name ?? "—"}
                      <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        {x.decided_at ? day(x.decided_at) : ""}
                      </span>
                    </td>
                    <td className="px-10 py-10">
                      <span className="flex flex-wrap gap-8">
                        {canManage && isOpenState(x.status) && (
                          <button type="button" className={mini} style={miniStyle}
                            onClick={() => openPanel({
                              kind: "paper", id: x.id, checkKind: x.kind as CheckKind,
                              hasReference: x.has_reference, expiresOn: x.expires_on, companyName: c.name, companyId: c.id
                            })}>
                            Paper is in
                          </button>
                        )}
                        {canVerify && isOpenState(x.status) && (
                          <button type="button" className={mini} style={{ borderColor: "var(--adm-accent)", color: "var(--ink)" }}
                            onClick={() => openPanel({
                              kind: "answer", id: x.id, checkKind: x.kind as CheckKind, hasReference: x.has_reference,
                              expiresOn: x.expires_on, ref: x.reference_tail ?? undefined, companyName: c.name, companyId: c.id
                            })}>
                            Answer
                          </button>
                        )}
                        {canVerify && x.has_reference && (
                          <button type="button" className={mini} style={{ borderColor: "var(--warning)", color: "var(--warning)" }}
                            onClick={() => openPanel({
                              kind: "reveal", id: x.id, checkKind: x.kind as CheckKind,
                              ref: x.reference_tail ?? undefined, companyName: c.name
                            })}>
                            Read it
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* notes and labels */}
      <div className="mt-20 grid gap-14" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        <Block head={`The office's notes — ${d.notes.filter((n) => !n.voided_at).length} on the file`}>
          {d.notes.length === 0 ? (
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Nobody has written anything about this account yet.
            </p>
          ) : (
            <ul className="mt-8">
              {d.notes.map((n) => (
                <li key={n.id} className={line}>
                  <p className="text-xs break-words" style={{ color: n.voided_at ? "var(--ink-soft)" : "var(--ink)" }}>
                    {n.body}
                  </p>
                  <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {n.author_name ?? "—"} · {day(n.created_at)}
                    {n.edited_at ? ` · rewritten ${day(n.edited_at)}` : ""}
                    {n.voided_at ? ` · withdrawn ${day(n.voided_at)} by ${n.voided_by_name ?? "—"}` : ""}
                  </p>
                  {n.voided_at && (
                    <p className="text-[10px]" style={{ color: "var(--danger)" }}>{n.void_reason}</p>
                  )}
                  {canManage && !n.voided_at && (
                    <span className="mt-4 flex flex-wrap gap-8">
                      <button type="button" className={mini} style={miniStyle}
                        onClick={() => openPanel({ kind: "edit", id: n.id, companyId: c.id, companyName: c.name, body: n.body },
                          { text: n.body })}>
                        Rewrite
                      </button>
                      <button type="button" className={mini} style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                        onClick={() => openPanel({ kind: "void", id: n.id, companyId: c.id, companyName: c.name, body: n.body })}>
                        Withdraw
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block head={`Labels — ${d.tags.length} on this account`}>
          {d.tags.length === 0 ? (
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              No word is marked on it.
            </p>
          ) : (
            <ul className="mt-8">
              {d.tags.map((g) => (
                <li key={g.tagging_id} className={line}>
                  <div className="flex flex-wrap items-center justify-between gap-10">
                    <span>
                      <span className={chip} style={{ border: `1px solid ${g.colour ?? "var(--line)"}`, color: g.colour ?? "var(--ink-soft)" }}>
                        {g.name}
                      </span>
                      <span className="ml-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        put on by {g.applied_by_name ?? "—"} · {day(g.applied_at)}
                      </span>
                    </span>
                    {canManage && (
                      <button type="button" className={mini} style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                        onClick={() => openPanel({
                          kind: "off", companyId: c.id, companyName: c.name, tagId: g.id, tagName: g.name
                        })}>
                        Take it off
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <button type="button" className={`${headBtn} mt-12`} style={miniStyle}
              onClick={() => openPanel({ kind: "wear", companyId: c.id, companyName: c.name })}>
              Mark it with a label
            </button>
          )}
        </Block>
      </div>

      {/* the story */}
      <div className="mt-20">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
          The story so far — assembled out of the trails the platform already keeps
        </h3>
        <div className="mt-8 flex flex-wrap gap-8">
          <button type="button" className={mini} style={tlSource === "" ? {
            borderColor: "var(--adm-accent)", color: "var(--ink)",
            background: "color-mix(in srgb, var(--adm-accent) 14%, transparent)"
          } : miniStyle} onClick={() => setTlSource("")}>
            Everything
          </button>
          {TIMELINE_SOURCES.map(([k, v]) => (
            <button key={k} type="button" className={mini}
              style={tlSource === k ? {
                borderColor: "var(--adm-accent)", color: "var(--ink)",
                background: "color-mix(in srgb, var(--adm-accent) 14%, transparent)"
              } : miniStyle}
              onClick={() => setTlSource(tlSource === k ? "" : k)}>
              {v}
            </button>
          ))}
        </div>
        <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
          A block is 078&apos;s register, a call is 101&apos;s, a dispute or a refund paper is 126&apos;s, the exit
          is 086&apos;s. Nothing is copied here, because a second copy of an activity trail is a trail that can
          disagree with the first.
        </p>
        {!timeline ? (
          <p role="status" className="mt-12 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the trail…</p>
        ) : timeline.rows.length === 0 ? (
          <p className="mt-12 text-sm" style={{ color: "var(--ink)" }}>
            Nothing on this trail with that filter. The account exists; nothing else has been written down about it.
          </p>
        ) : (
          <ul className="mt-12">
            {timeline.rows.map((r, i) => (
              <li key={`${r.ts}-${i}`} className={line}>
                <div className="flex flex-wrap items-start justify-between gap-10">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold break-words" style={{ color: "var(--ink)" }}>{r.title}</p>
                    {r.detail && <p className="text-[11px] break-words" style={{ color: "var(--ink-soft)" }}>{r.detail}</p>}
                  </div>
                  <p className="text-[10px] whitespace-nowrap" style={{ color: "var(--ink-soft)" }}>
                    {when(r.ts)}
                    <span className="block">{r.actor ?? "—"}</span>
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {busy && <p role="status" className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>Writing…</p>}
    </section>
  );
}

// ---------- the paper ----------

/**
 * One data request, whole (129).
 *
 * Every number here comes from `data_request_detail`, which is the same read a second seat is shown
 * before signing and the same read this desk goes back to after a download — so the counters beside
 * the words are the register&apos;s and not a second copy of them. What the block deliberately does
 * not do is show a value: the archive carries the plain TIN, phone and NIDA, and a desk that printed
 * one into a screen would have made the erasure&apos;s own point moot.
 */
function PaperBlock({ p, panel, canGdpr, canErase, busy, openPanel, openDossier, handOver, close,
  readAgain }: {
    p: Paper; panel: Panel | null; canGdpr: boolean; canErase: boolean; busy: boolean;
    openPanel: (next: Panel, seed?: Partial<Draft>) => void;
    openDossier: (id: string, name: string) => void;
    handOver: (p: Paper) => void; close: () => void; readAgain: () => void;
  }) {
  const cats = (p.categories ?? []) as string[];
  const reached = Object.values(p.erased ?? {}).reduce((a, b) => a + Number(b || 0), 0);
  const kept = (p.keeps ?? []).reduce((a, b) => a + b.rows, 0);
  const sigOpen = p.kind === "erase" && p.open_slot && canErase;
  const refuseOpen = p.open_slot && (p.kind === "erase" ? canErase : canGdpr);
  const handOpen = p.kind === "export" && p.status !== "refused";
  return (
    <section className="mt-20 rounded-card border p-20"
      style={{ borderColor: STATUS_EDGE[p.status] ?? "var(--line)", background: "var(--surface)" }}>
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div className="min-w-0">
          <h2 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
            {p.ref} — {drKindWord(p.kind)} on {p.company.name}
          </h2>
          <p className="mt-6 flex flex-wrap items-center gap-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            <Chip edge={STATUS_EDGE[p.status] ?? "var(--line)"}>{drStatusWord(p.status)}</Chip>
            raised {when(p.raised_at)} by {p.raised_name ?? "—"}
            {p.raised_role ? ` (${p.raised_role})` : ""} · read at {when(p.clock)}
          </p>
        </div>
        <button type="button" className={headBtn} style={miniStyle} onClick={close}>
          Close the paper
        </button>
      </div>

      <div className="mt-16 grid gap-12">
        <Block head="What was asked, and by whom"
          hint="Kept on the row forever, because this is the sentence a supervisory office reads first.">
          <p className="mt-6 text-xs break-words" style={{ color: "var(--ink)" }}>{p.reason}</p>
          <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            reached the office: {p.asked_in ?? "not written down"} ·{" "}
            <button type="button" className="border-0 bg-transparent p-0 text-left underline"
              style={{ color: "var(--ink)" }} onClick={() => openDossier(p.company.id, p.company.name)}>
              {p.company.name}
            </button>{" "}
            ({p.company.type}, {p.company.closed_at
              ? `shut ${day(p.company.closed_at)}`
              : label(ACCOUNT_STATES, p.company.account_status)})
          </p>
          {cats.length > 0 && (
            <p className="mt-8 flex flex-wrap gap-6">
              {cats.map((c) => <Chip key={c} edge="var(--adm-accent)">{categoryWord(c)}</Chip>)}
            </p>
          )}
          {p.kind === "export" && cats.length === 0 && (
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              A copy carries every category — {EXPORT_SECTION_COUNT} sections and a manifest that says what
              each one withheld. Choosing the parts would be choosing what to hide.
            </p>
          )}
        </Block>

        {p.status === "erased" && (
          <Block head="What the mask reached"
            hint="Counted in the transaction that wrote the answer, per category, in the register's own numbers.">
            <ul className="mt-6 grid gap-6">
              {CATEGORIES.filter((c) => cats.includes(c)).map((c) => (
                <li key={c} className={line}>
                  <span className="text-[11px]" style={{ color: "var(--ink)" }}>
                    <span className="font-semibold tabular-nums">{erasedCount(p.erased, c) ?? 0}</span> row(s) —{" "}
                    {categoryWord(c)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>
              {reached} row(s) masked in all, and {kept} row(s) the register was told to leave —{" "}
              {(p.keeps ?? []).map((k) => `${k.rows} ${k.label.toLowerCase()}`).join(", ")}.
              Erased {when(p.erased_at)} by {p.erased_name ?? "—"}.
            </p>
          </Block>
        )}

        {(p.keeps ?? []).length > 0 && p.status !== "erased" && (
          <Block head="What an erasure here could not touch"
            hint="The twelve keeps the same function that answered the preview carries, in the register's words.">
            <ul className="mt-6 grid gap-6">
              {(p.keeps ?? []).map((k) => (
                <li key={k.key} className="text-[11px]" style={{ color: "var(--ink)" }}>
                  <span className="font-semibold tabular-nums">{k.rows}</span> · {k.label}
                  <span className="block" style={{ color: "var(--ink-soft)" }}>{k.because}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {p.kind === "erase" && (
          <Block head="The signature it is waiting on"
            hint="Written on 121's approval register by this desk, spent by a different seat on Approvals.">
            <p className="mt-6 text-[11px]" style={{ color: "var(--ink)" }}>
              paper {p.approval_status ?? "not proposed yet"}
              {p.approval_proposed_name ? ` · proposed by ${p.approval_proposed_name}` : ""}
              {p.approval_expires_at ? ` · lapses ${day(p.approval_expires_at)}` : ""}
            </p>
            <p className="mt-6 text-[11px] break-all" style={{ color: "var(--ink-soft)" }}>
              {p.payload_sha256
                ? `signed against the hash ${shaWords(p.payload_sha256)} of the account, its closed date `
                  + "and these categories — the mask re-reads it before it touches a column."
                : "No hash sits on it yet: asking a second seat to sign writes one over the account, its "
                  + "closed date and these categories, and the mask re-reads it before it touches a column."}
            </p>
            {p.signed_name && (
              <p className="mt-6 text-[11px]" style={{ color: "var(--success)" }}>
                signed {when(p.signed_at)} by {p.signed_name}
                {p.signed_note ? ` — “${p.signed_note}”` : ""}
              </p>
            )}
            <p className="mt-8 text-[10px]" style={{ color: "var(--ink-soft)" }}>
              Nothing here can spend it. The seat that raised the paper is refused by the register itself,
              so the decision is made on <Link href="/control/approvals" className="underline">Approvals</Link>.
            </p>
          </Block>
        )}

        {p.kind === "export" && (
          <Block head="The copy, and every time it left"
            hint="The hash is of the bytes as they left the socket, stamped once — a download nobody finished is not a copy anybody received.">
            <p className="mt-6 text-[11px] break-all" style={{ color: "var(--ink)" }}>
              {p.bundle_sha256
                ? <>SHA-256 {shaWords(p.bundle_sha256)} · {size(p.bundle_bytes)} in {p.bundle_entries ?? "—"} file(s)</>
                : "Nothing has been handed over yet — the register has no bytes to hash."}
            </p>
            <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              {p.deliveries} hand-over(s)
              {p.delivered_at ? ` · last one ${when(p.delivered_at)} by ${p.delivered_name ?? "—"}` : ""}
            </p>
          </Block>
        )}

        {p.status === "refused" && (
          <Block head="The refusal the caller was given">
            <p className="mt-6 text-xs break-words" style={{ color: "var(--ink)" }}>“{p.refused_note ?? "—"}”</p>
            <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              refused {when(p.refused_at)} by {p.refused_name ?? "—"}. The row stays, and the account&apos;s open
              slot of this kind is free again.
            </p>
          </Block>
        )}
      </div>

      <div className="mt-16 flex flex-wrap gap-10">
        {handOpen && canGdpr && (
          <button type="button" className={headBtn} disabled={busy}
            style={{ borderColor: "var(--success)", color: "var(--success)" }}
            onClick={() => handOver(p)}>
            {busy ? "Writing…" : p.deliveries > 0 ? "Hand the copy over again" : "Hand the copy over"}
          </button>
        )}
        {sigOpen && (
          <button type="button" className={headBtn}
            style={{ borderColor: "var(--adm-accent)", color: "var(--ink)" }}
            onClick={() => openPanel({
              kind: "sig", id: p.id, ref: p.ref, companyId: p.company.id, companyName: p.company.name,
              categories: cats, openSlot: p.open_slot, requestKind: p.kind, requestStatus: p.status
            })}>
            {panel?.kind === "sig" && panel.id === p.id ? "Close the form" : "Ask a second seat to sign"}
          </button>
        )}
        {refuseOpen && (
          <button type="button" className={headBtn}
            style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
            onClick={() => openPanel({
              kind: "refuse", id: p.id, ref: p.ref, companyId: p.company.id, companyName: p.company.name,
              categories: cats, openSlot: p.open_slot, requestKind: p.kind, requestStatus: p.status
            })}>
            {panel?.kind === "refuse" && panel.id === p.id ? "Close the form" : "Refuse the ask"}
          </button>
        )}
        {!p.open_slot && canGdpr && (
          <button type="button" className={headBtn} style={miniStyle}
            onClick={() => openPanel({
              kind: "ask", companyId: p.company.id, companyName: p.company.name,
              requestKind: p.kind === "erase" ? "erase" : "export"
            }, { accountId: p.company.id, askKind: p.kind as DataRequestKind, closedQuery: p.company.name })}>
            Raise a new paper on this account
          </button>
        )}
        <button type="button" className={headBtn} style={miniStyle} onClick={readAgain}>
          Read it again
        </button>
      </div>
      <p className="mt-12 text-[10px]" style={{ color: "var(--ink-soft)" }}>
        The plain numbers are not on this screen. A TIN, phone or NIDA is decrypted only into the archive a
        caller is handed, and this desk shows the counts and the hash rather than the values — which is the
        whole point of an erasure register.
      </p>
    </section>
  );
}

// ---------- small pieces ----------

function TrustCell({ t }: { t: Trust | null }) {
  if (!t || typeof t.score !== "number") {
    return <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>not on the register</span>;
  }
  return (
    <span title={(t.factors ?? []).map((f) => `${f.points > 0 ? "+" : ""}${f.points} ${f.label}`).join(" · ") || "nothing has moved it"}>
      <span className="font-bold tabular-nums" style={{ color: BAND_EDGE[t.band ?? ""] ?? "var(--ink)" }}>{t.score}</span>
      <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
        {label(Object.entries(BAND_LABELS), t.band)}
      </span>
    </span>
  );
}

function Chip({ edge, children }: { edge: string; children: React.ReactNode }) {
  return (
    <span className={chip} style={{ border: `1px solid ${edge}`, color: edge === "var(--ink-soft)" ? "var(--ink-soft)" : edge }}>
      {children}
    </span>
  );
}

function Block({ head, hint, children }: { head: string; hint?: string; children: React.ReactNode }) {
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

function AccountPicker({ draft, setDraft, rows, busy, search, onPick }: {
  draft: Draft; setDraft: (d: Draft) => void; rows: Account[] | null; busy: boolean;
  search: (term: string) => void; onPick: (a: Account) => void;
}) {
  const picked = rows?.find((r) => r.id === draft.accountId);
  return (
    <fieldset className="mt-14 rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
      <legend className="px-8 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
        Which account
      </legend>
      <div className="flex flex-wrap gap-10">
        <input value={draft.accountQuery} aria-label="Search accounts"
          onChange={(e) => setDraft({ ...draft, accountQuery: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(draft.accountQuery); } }}
          placeholder="The name it trades under, or its email"
          className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
        <button type="button" className={headBtn} style={miniStyle} disabled={busy}
          onClick={() => search(draft.accountQuery)}>
          {busy ? "Reading…" : "Find"}
        </button>
      </div>
      {picked && (
        <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
          Writing about <span className="font-semibold">{picked.name}</span> — {picked.type},{" "}
          {label(ACCOUNT_STATES, picked.account_status)}, {picked.open_checks} open check(s).
        </p>
      )}
      {rows === null ? (
        <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          Type a name and press Find. A closed account is not on this list — it is still a customer, but the
          office cannot check it.
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>
          Nothing on the register matches. A transporter, a shipper or a seeker, by the name it trades under.
        </p>
      ) : (
        <ul className="mt-8 max-h-[240px] overflow-y-auto">
          {rows.map((a) => (
            <li key={a.id} className={line}>
              <button type="button" onClick={() => onPick(a)}
                className="w-full border-0 bg-transparent p-0 text-left"
                style={{ background: a.id === draft.accountId ? "color-mix(in srgb, var(--adm-accent) 12%, transparent)" : undefined }}>
                <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>{a.name}</p>
                <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {a.type} · {label(ACCOUNT_STATES, a.account_status)} · opened {day(a.created_at)} ·{" "}
                  {a.open_checks} open · {a.approved} approved · {a.notes} note(s) · {a.labels} label(s)
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
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

/** `total` is what the board says it matched, or the count each list SQL carries on its own first
 *  row — the rows the filter found, not the rows on this page. */
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
        {[10, 25, 30, 60, 100].map((n) => <option key={n} value={String(n)}>{n} a page</option>)}
      </select>
    </div>
  );
}

// ---------- panel words ----------

function panelTitle(p: Panel) {
  const who = p.companyName ? ` — ${p.companyName}` : "";
  return {
    raise: `Raise a check${who}`, paper: `The paper has arrived${who}`,
    answer: `Answer the check${who}`, reveal: `Read the whole number${who}`,
    note: `Write on the file${who}`, edit: `Rewrite a note`, void: `Withdraw a note`,
    label: "Write a label into the library", retire: `Retire “${p.tagName ?? "that label"}”`,
    wear: `Mark an account${who}`, off: `Take “${p.tagName ?? "the label"}” off${who}`,
    claim: "Declare a duplicate",
    voidclaim: `Withdraw the claim on ${p.loserName ? `“${p.loserName}”` : "that pair"}`,
    cut: `Cut every session off${who}`,
    ask: `Answer a caller's ask${who}`,
    sig: `Ask a second seat to sign ${p.ref ?? "the erasure"}`,
    refuse: `Refuse ${p.ref ?? "that ask"}${who}`
  }[p.kind];
}

function panelHint(p: Panel) {
  switch (p.kind) {
    case "raise":
      return "An open line is a question the office has asked. A second line of the same kind cannot stand "
        + "while one is open — the register keeps it as history beside the answer instead of over it.";
    case "paper":
      return "The envelope reached the desk. What is written here is what is on the paper, read now, so the "
        + "seat that answers does not have to ask again.";
    case "answer":
      return "One seat signs this, and the trigger then keeps it: an answer cannot be edited into a different "
        + "answer. Checking an account again means raising a new line, not overwriting this one.";
    case "reveal":
      return "This is the only door on the platform that decrypts an identity number. Twelve reads an hour, "
        + "each one recorded with the kind and the last four — never the value.";
    case "note":
      return "The office's own prose about an account. It keeps your name on it forever, so write what a "
        + "person in three years will need to have believed.";
    case "edit":
      return "The words change; the author does not. What was there before goes into the audit register.";
    case "void":
      return "A withdrawal is not a deletion. The note stays, marked withdrawn, with these words beside it.";
    case "label":
      return "A label is one word the office marks accounts with, lower-cased by the table so that "
        + "KYC-Hold and kyc-hold are one label and not an afternoon of working out whether they were ever two.";
    case "retire":
      return "The pairing rows under it stay — which accounts were marked, and when that stopped, is the "
        + "question a label answers when something went wrong. Nothing can be retired while an account wears it.";
    case "wear":
      return "A label is the office's word about an account, not the account's fact. It never changes what "
        + "the trust read is worked out of.";
    case "off":
      return "Taking a label off retires the pairing rather than deleting it, so the register can still say "
        + "who wore it and when it stopped.";
    case "claim":
      return "A claim is not a merge. Nothing is moved, copied or deleted by declaring one — it is the office "
        + "writing down that two accounts are the same company, and keeping the extra one shut so it cannot be "
        + "checked again. What carries over, if anything, is a separate decision made against that pair.";
    case "voidclaim":
      return "Withdrawing the claim retires the pairing, not the accounts. The extra one stays closed exactly "
        + "as it was, and the register keeps this sentence beside the claim as the reason it stopped.";
    case "cut":
      return "Every live seat on this account is signed out at once, whatever device it was opened on. Nothing "
        + "is deleted: the sessions the office cut off stay in the register with the reason and the hand that "
        + "cut them, and the account can sign in again on its own.";
    case "ask":
      return "One paper for either answer, and the counts below are read by the same function the mask reads. "
        + "A copy is handed over by this desk and every hand-off is counted on the row; an erasure is only "
        + "written here, and the mask runs from Approvals under a seat that did not raise it. A copy carries "
        + "no menu — withholding part of an Article 15 answer is not this desk's to decide.";
    case "sig":
      return "This writes a proposal and a hash of what the register read, and then stops. The seat that signs "
        + "cannot be the seat that asked — 121's rule, kept by the register rather than by this page — and the "
        + "signature lapses after seven days. Nothing is masked until somebody else gives it.";
    case "refuse":
      return "A refusal is not a delete. The paper stays, these words stay with it, and the account's open slot "
        + "of that kind is freed — so the same person can be answered properly next month instead of having to "
        + "start a new register somewhere else.";
  }
}

function submitWords(k: Panel["kind"]) {
  return {
    raise: "Open the line", paper: "Mark the paper as in", answer: "Sign the answer",
    reveal: "Read the number", note: "Write it", edit: "Rewrite it", void: "Withdraw the note",
    label: "Add it to the library", retire: "Retire the label", wear: "Mark the account",
    off: "Take it off",
    // A claim, a cut-off, a signature asked for and a refusal are the acts on this desk that a clerk
    // cannot take back from the screen, so each button says what is being written rather than a verb.
    claim: "Declare them one account", voidclaim: "Withdraw the claim",
    cut: "Cut every session off",
    ask: "Write the paper", sig: "Ask for the signature", refuse: "Refuse the ask"
  }[k];
}
