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
 */

// ---------- the vocabulary (web/app/control/customers/checks.ts mirrors the API and the table) ----------

const label = (list: [string, string][], key: string | null | undefined) =>
  list.find(([k]) => k === key)?.[1] ?? key ?? "—";
const kindWord = (k: string | null | undefined) =>
  k ? KIND_LABELS[k as CheckKind] ?? k : "—";
const stateWord = (s: string | null | undefined) =>
  s ? CHECK_STATE_LABELS[s] ?? s : "—";

/** The acts that cannot be taken back on the other side of the button: a terminal answer, a note
 *  withdrawn, a label taken off or retired, a number copied onto a screen. These ask for a second
 *  press; everything else writes on the first. */
const ARMS: Panel["kind"][] = ["answer", "void", "retire", "off", "reveal"];
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

// ---------- tabs ----------

type Tab = "board" | "checks" | "notes" | "tags";
const TABS: [Tab, string][] = [
  ["board", "Accounts"], ["checks", "Checks"], ["notes", "The office's notes"], ["tags", "Labels"]
];
/** The export takes the register's own name for the tab (`board` is the accounts register). */
const EXPORT_REGISTER: Record<Tab, string> = {
  board: "accounts", checks: "checks", notes: "notes", tags: "tags"
};

// ---------- forms ----------

type Draft = {
  accountQuery: string; accountId: string; kind: CheckKind; status: string; reference: string;
  expiresOn: string; answer: string; reason: string; text: string; labelName: string;
  labelColour: string; labelNote: string; tagId: string;
};
const EMPTY_DRAFT: Draft = {
  accountQuery: "", accountId: "", kind: "national_id", status: "awaiting", reference: "",
  expiresOn: "", answer: "approved", reason: "", text: "", labelName: "", labelColour: "#0e7490",
  labelNote: "", tagId: ""
};
type Panel = {
  kind: "raise" | "paper" | "answer" | "reveal" | "note" | "edit" | "void" | "label"
    | "wear" | "off" | "retire";
  id?: string; companyId?: string; companyName?: string; ref?: string; tagId?: string;
  tagName?: string; checkKind?: CheckKind; lineStatus?: string; hasReference?: boolean;
  expiresOn?: string | null; body?: string;
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

  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [dossierFor, setDossierFor] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [tlSource, setTlSource] = useState("");
  const [wearers, setWearers] = useState<Wearer[] | null>(null);
  const [wearersTag, setWearersTag] = useState<TagRow | null>(null);

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [library, setLibrary] = useState<TagRow[] | null>(null);

  const seq = useRef(0);

  const canView = perms.includes("control.customers.view");
  const canManage = perms.includes("control.customers.manage");
  const canVerify = perms.includes("control.customers.verify");

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
    setTRows(j.rows ?? []); setTCounts(j.counts ?? null); setError(null);
  }, [bFilter, cFilter, nFilter, tFilter]);

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
    const key = ++seq.current;
    const t = setTimeout(() => { load(tab, key); }, 260);
    return () => clearTimeout(t);
  }, [tab, canView, load]);

  const refresh = useCallback(() => {
    const key = ++seq.current;
    load(tab, key);
    loadFacets();
    if (dossierFor) {
      readDossier(dossierFor);
      readTimeline(dossierFor, tlSource);
    }
    if (wearersTag) setWearers(null);
  }, [tab, load, loadFacets, dossierFor, tlSource, readDossier, readTimeline, wearersTag]);

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
    if (["raise", "note", "wear", "off"].includes(p.kind) && !company) {
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
    setPanelError(null); setArmed(null); setRevealed(null);
    if (next.kind === "raise" || next.kind === "wear" || next.kind === "note") setAccounts(null);
    setDraft({ ...EMPTY_DRAFT, ...seed });
    if (closing) { setPanel(null); return; }
    setPanel(next);
    if (next.kind === "wear") loadLibrary();
    if (next.kind === "raise" && !next.companyId) searchAccounts("");
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
        : `The ${tab === "board" ? "account board" : tab} was exported with the filters on screen.`);
    } finally { setExporting(false); }
  }

  // ---------- form gates, in the register's own words ----------

  const kind = panel?.checkKind ?? draft.kind;
  const numberOk = !draft.reference.trim() || referenceLooksRight(kind, draft.reference);
  const dayOk = !draft.expiresOn || expiresOnKind(kind);
  const lineHasNumber = !!panel?.hasReference || !!draft.reference.trim();
  const lineHasDay = !!panel?.expiresOn || !!draft.expiresOn;
  const approvedNeedsDay = expiresOnKind(kind) && !lineHasDay;

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

            <div className="mt-16 flex flex-wrap items-center gap-12">
              <button type="button" disabled={!formReady() || busy} onClick={async () => {
                if (panel.kind === "reveal") {
                  if (!armed) { setArmed(armKey(panel)); return; }
                  await revealReference(panel.id!); setArmed(null); return;
                }
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
      </main>
    </div>
  );
}

// ---------- the dossier ----------

function DossierBlock({ d, panel, openPanel, close, canManage, canVerify, busy, timeline,
  tlSource, setTlSource, openDossier }: {
    d: Dossier; panel: Panel | null; openPanel: (p: Panel, seed?: Partial<Draft>) => void;
    close: () => void; canManage: boolean; canVerify: boolean; busy: boolean;
    timeline: Timeline | null; tlSource: string; setTlSource: (s: string) => void;
    openDossier: (id: string, name: string) => void;
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
    wear: `Mark an account${who}`, off: `Take “${p.tagName ?? "the label"}” off${who}`
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
  }
}

function submitWords(k: Panel["kind"]) {
  return {
    raise: "Open the line", paper: "Mark the paper as in", answer: "Sign the answer",
    reveal: "Read the number", note: "Write it", edit: "Rewrite it", void: "Withdraw the note",
    label: "Add it to the library", retire: "Retire the label", wear: "Mark the account",
    off: "Take it off"
  }[k];
}
