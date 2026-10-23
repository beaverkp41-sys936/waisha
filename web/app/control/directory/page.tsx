"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

const VIEW = "control.directory.view";
const MODERATE = "control.directory.moderate";
const EXCLUSION = "control.directory.exclusion";

// ---------- what the four registers answer ----------

type PassRow = {
  pass_id: string; tenant_id: string; seeker_name: string | null; email: string;
  kind: string; amount: string; currency: string;
  payment_method: string | null; payment_reference: string; recorded_at: string;
};
type ListingRow = {
  listing_id: string; tenant_id: string; company_name: string; serves: string[];
  status: string; is_verified: boolean;
  region_names: string[]; contact_name: string | null; contact_channel: string | null;
  published_at: string | null; updated_at: string; searches: string | number;
};
type MarkRow = {
  id: string; listing_id: string; listed_name: string; listed_tenant_id: string;
  stars: number; comment: string | null; basis: "booking" | "engagement";
  booking_id: string | null; search_id: string | null;
  rater_name: string; rater_kind: "company" | "seeker"; rater_email: string | null;
  created_at: string; reply: string | null; replied_at: string | null;
  replied_name: string | null; hidden_at: string | null; hidden_reason: string | null;
  hidden_name: string | null; withdrawn_at: string | null; total: number;
};
type MarkCounts = {
  live: number; mean: number; awaiting_answer: number; replied: number; hidden: number;
  withdrawn: number; companies: number; seekers: number; total: number;
};
type HoldRow = {
  id: string; ref: string; subject_kind: "company" | "vehicle" | "driver";
  subject_id: string; subject_name: string; subject_label: string | null;
  company_name: string; company_tenant_id: string; listing_id: string | null;
  reason_code: string; reason: string; note: string; days: number;
  exclusion_status: "raised" | "pending_signature" | "active" | "lifted" | "refused";
  raised_name: string | null; raised_at: string;
  approval_id: string | null; approval_status: string | null; signed_name: string | null;
  approval_expires_at: string | null; payload_sha256: string | null;
  starts_at: string | null; ends_at: string | null; days_left: number | null;
  lifted_name: string | null; lifted_at: string | null; lifted_note: string | null;
  refused_name: string | null; refused_at: string | null; refused_note: string | null;
  total: number;
};
type HoldCounts = {
  running: number; expired_hold: number; awaiting: number; raised: number; lifted: number;
  refused: number; companies: number; vehicles: number; drivers: number; total: number;
};
type Paper = {
  exclusion: Record<string, any>;
  approval: {
    id: string; status: string; reason: string | null; payload: Record<string, any> | null;
    payload_sha256: string | null; expires_at: string | null; proposed_at: string | null;
    proposed_name: string | null; decided_at: string | null; decided_name: string | null;
    decided_note: string | null; applied_at: string | null; result: Record<string, any> | null;
  } | null;
  card: {
    id: string; status: string; is_verified: boolean; suspension_reason: string | null;
    held_by_exclusion: boolean; serves: string[]; published_at: string | null;
  } | null;
  marks: { marks?: number; mean?: number; one?: number; awaiting_answer?: number };
  holds: { ref: string; subject_kind: string; subject_name: string;
    starts_at: string | null; ends_at: string | null }[];
};
type HeldAnswer = { ref: string; ends_at: string; reason_code: string;
  company_name: string; subject_name: string } | null;

// ---------- words the desk is allowed to use ----------

const METHODS: Record<string, string> = {
  mpesa: "M-Pesa", airtel_money: "Airtel Money", tigo_pesa: "Mixx by Yas (Tigo Pesa)",
  halotel_cash: "Halotel Cash", bank_transfer: "Bank / Lipa Namba", cash: "Cash", other: "Other"
};

const MARK_STATES: [string, string][] = [
  ["all", "Every mark on the board"], ["live", "Counting — not hidden, not withdrawn"],
  ["answered", "Waiting on the company's answer"], ["replied", "The company has answered"],
  ["hidden", "Taken off the board by the office"], ["withdrawn", "Taken back by who wrote it"]
];
const HOLD_STATES: [string, string][] = [
  ["all", "Every paper on the register"], ["live", "Holds running today"],
  ["running", "Active, whatever the date says"], ["waiting", "Open on a second seat's signature"],
  ["raised", "Written, no signature asked for yet"], ["lifted", "Taken off early"],
  ["refused", "Put down"]
];
const SUBJECTS: [string, string][] = [
  ["company", "A company's card"], ["vehicle", "A vehicle"], ["driver", "A driver"]
];
const REASON_CODES: [string, string][] = [
  ["terms_violation", "Against the terms"], ["long_idle", "Idle past any sense"],
  ["payment_default", "Money owed and not paid"], ["abuse", "Abuse of a seat or a caller"],
  ["complaint", "Complaints that piled up"], ["security", "Security"], ["other", "Something else"]
];
const HOLD_EDGES: Record<string, string> = {
  raised: "var(--ink-soft)", pending_signature: "var(--warning)", active: "var(--danger)",
  lifted: "var(--success)", refused: "var(--ink-soft)"
};
const WINDOWS = [7, 14, 30, 90, 180, 365];

type Tab = "passes" | "listings" | "marks" | "holds";
const TABS: [Tab, string][] = [
  ["passes", "Passes"], ["listings", "Listings"], ["marks", "Marks"], ["holds", "Blacklist"]
];
/** Only two of the four registers have a file behind them; a pass queue is a screen, not a record. */
const EXPORT_REGISTER: Partial<Record<Tab, string>> = { marks: "ratings", holds: "exclusions" };

type Panel = {
  kind: "mark" | "raise" | "sig" | "refuse" | "lift";
  id?: string; name?: string; listedName?: string; action?: "hide" | "unhide";
  stars?: number; comment?: string | null; listingId?: string | null;
  status?: string; ref?: string; days?: number; endsAt?: string | null;
  subjectKind?: string;
};

const SENT = 8;
const box = "mt-4 w-full rounded-input border px-10 py-8 text-sm";
const boxStyle = { borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" };
const labelText = "text-[11px]";
const headBtn = "min-h-[36px] rounded-input border px-14 py-8 text-xs font-semibold disabled:opacity-40";
const mini = "min-h-[36px] rounded-input border px-10 py-4 text-[11px] font-semibold";
const miniStyle = { borderColor: "var(--line)", color: "var(--ink)" };
const chip = "whitespace-nowrap rounded-input px-8 py-2 text-[10px] font-semibold";

// Display only — the amount arrives as text from a numeric column and is never recomputed here,
// because the price the seeker paid lives in the pass row.
function show(amount: string, currency: string) {
  const n = Number(amount);
  return `${currency} ${Number.isFinite(n)
    ? n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : amount}`;
}
const when = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—";
const day = (iso: string | null | undefined) => iso
  ? new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" }) : "—";
const word = (list: [string, string][], key: string | null | undefined, fallback?: string) =>
  list.find(([k]) => k === key)?.[1] ?? fallback ?? "—";

function errorMessage(j: any, fallback: string) {
  const e = j?.error ?? j ?? {};
  const msg = typeof e.message === "string" && e.message.trim() ? e.message.trim() : fallback;
  const field = Array.isArray(e.details)
    ? e.details.map((d: any) => d?.field).filter(Boolean).join(", ") : "";
  return field ? `${msg} (${field})` : msg;
}

/** A reinstate pressed on a card a signed hold is keeping down comes back as LISTING_HELD with the
 *  paper's own number and its end date — the way out is the hold, so the words have to name it. */
function heldWords(j: any, fallback: string) {
  const d = (j?.error?.details ?? []).find((x: any) => x?.reason === "held");
  if (!d) return errorMessage(j, fallback);
  const until = d.endsAt ? ` until ${day(d.endsAt)}` : "";
  return `${errorMessage(j, fallback)} Lift ${d.ref ?? "the exclusion"}${until} on the Blacklist tab `
    + "first — this button cannot release a hold, and is not meant to.";
}

export default function ControlDirectoryPage() {
  const [me, setMe] = useState<any>(null);
  const [perms, setPerms] = useState<string[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [tab, setTab] = useState<Tab>("passes");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [draft, setDraft] = useState({ reason: "", note: "", markReason: "" });
  const [notes, setNotes] = useState<Record<string, string>>({});

  const [passes, setPasses] = useState<PassRow[] | null>(null);
  const [listings, setListings] = useState<ListingRow[] | null>(null);
  const [lq, setLq] = useState("");

  const [marks, setMarks] = useState<{ rows: MarkRow[]; total: number } | null>(null);
  const [mCounts, setMCounts] = useState<MarkCounts | null>(null);
  const [mFilter, setMFilter] = useState({ state: "all", q: "", limit: "30", offset: "0" });

  const [holds, setHolds] = useState<{ rows: HoldRow[]; total: number } | null>(null);
  const [hCounts, setHCounts] = useState<HoldCounts | null>(null);
  const [hFilter, setHFilter] = useState({ state: "all", kind: "", q: "", limit: "30", offset: "0" });

  const [paper, setPaper] = useState<Paper | null>(null);
  const [paperFor, setPaperFor] = useState<string | null>(null);

  const [raise, setRaise] = useState({
    subjectKind: "company", subjectId: "", companyQuery: "", reasonCode: "complaint",
    reason: "", note: "", days: "30"
  });
  const [pick, setPick] = useState<ListingRow[] | null>(null);
  const [pickBusy, setPickBusy] = useState(false);
  const [held, setHeld] = useState<HeldAnswer | null>(null);
  const [heldFor, setHeldFor] = useState<string | null>(null);

  const canView = perms.includes(VIEW);
  const canModerate = perms.includes(MODERATE);
  const canHold = perms.includes(EXCLUSION);

  const seq = useRef(0);
  const pseq = useRef(0);

  // ---------- the four reads ----------

  const loadPasses = useCallback(async (key: number) => {
    const res = await fetch(`${API}/api/v1/control/directory/passes`, { credentials: "include" });
    if (key !== seq.current) return;
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); return; }
    if (!res.ok) { setPasses([]); return; }
    setPasses(await res.json());
  }, []);

  const loadListings = useCallback(async (key: number, search: string) => {
    const res = await fetch(
      `${API}/api/v1/control/directory/listings${search ? `?q=${encodeURIComponent(search)}` : ""}`,
      { credentials: "include" });
    if (key !== seq.current) return;
    if (res.status === 401) { window.location.href = "/control/login"; return; }
    if (res.status === 403) { setForbidden(true); return; }
    if (!res.ok) { setListings([]); return; }
    setListings(await res.json());
  }, []);

  const loadMarks = useCallback(async (key: number, f: typeof mFilter) => {
    const p = new URLSearchParams({ state: f.state, limit: f.limit, offset: f.offset });
    if (f.q.trim()) p.set("q", f.q.trim());
    const res = await fetch(`${API}/api/v1/control/directory/ratings?${p}`, { credentials: "include" });
    if (key !== seq.current) return;
    if (res.status === 403) { setForbidden(true); return; }
    if (!res.ok) {
      setError(errorMessage(await res.json().catch(() => ({})),
        "The marks board would not answer."));
      setMarks({ rows: [], total: 0 });
      return;
    }
    const j = await res.json();
    setMarks({ rows: j.rows ?? [], total: Number(j.rows?.[0]?.total ?? 0) });
    setMCounts(j.counts ?? null);
  }, []);

  const loadHolds = useCallback(async (key: number, f: typeof hFilter) => {
    const p = new URLSearchParams({ state: f.state, limit: f.limit, offset: f.offset });
    if (f.kind) p.set("kind", f.kind);
    if (f.q.trim()) p.set("q", f.q.trim());
    const res = await fetch(`${API}/api/v1/control/directory/exclusions?${p}`,
      { credentials: "include" });
    if (key !== seq.current) return;
    if (res.status === 403) { setForbidden(true); return; }
    if (!res.ok) {
      setError(errorMessage(await res.json().catch(() => ({})),
        "The exclusion register would not answer."));
      setHolds({ rows: [], total: 0 });
      return;
    }
    const j = await res.json();
    setHolds({ rows: j.rows ?? [], total: Number(j.rows?.[0]?.total ?? 0) });
    setHCounts(j.counts ?? null);
  }, []);

  useEffect(() => {
    (async () => {
      const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
      if (!m.ok) { window.location.href = "/control/login"; return; }
      setMe(await m.json());
      const p = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (p.ok) setPerms((await p.json()).permissions ?? []);
    })();
  }, []);

  // The two queues 061 left are unpaginated reads, so both are taken once and re-taken after a
  // write; the registers that page are re-taken only for the tab on screen.
  useEffect(() => {
    if (!canView) return;
    const key = ++seq.current;
    const t = setTimeout(() => {
      if (tab === "passes") loadPasses(key);
      else if (tab === "listings") loadListings(key, lq);
      else if (tab === "marks") loadMarks(key, mFilter);
      else loadHolds(key, hFilter);
    }, 260);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, canView, lq, mFilter, hFilter, loadPasses, loadListings, loadMarks, loadHolds]);

  /** Re-read the tab that just moved. A caption restating a fact and the row it restates must come
   *  off the same read, or the desk shows a hold that has already been lifted. */
  const refresh = useCallback(() => {
    const key = ++seq.current;
    if (tab === "passes") loadPasses(key);
    else if (tab === "listings") loadListings(key, lq);
    else if (tab === "marks") loadMarks(key, mFilter);
    else loadHolds(key, hFilter);
    if (paperFor) readPaper(paperFor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, lq, mFilter, hFilter, loadPasses, loadListings, loadMarks, loadHolds, paperFor]);

  async function readPaper(id: string) {
    const key = ++pseq.current;
    const res = await fetch(`${API}/api/v1/control/directory/exclusions/${id}`,
      { credentials: "include" });
    if (key !== pseq.current) return;
    if (!res.ok) {
      setError(errorMessage(await res.json().catch(() => ({})),
        "That paper would not open."));
      setPaper(null); setPaperFor(null); return;
    }
    setPaper(await res.json());
  }

  // ---------- the writes ----------

  /** One door for every write, so a refusal reads the same whatever the register raised it in. */
  async function send(path: string, body: any):
    Promise<{ ok: boolean; j: any; message: string | null }> {
    setBusy(true); setError(null); setNotice(null); setPanelError(null);
    try {
      const res = await fetch(`${API}/api/v1${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 401) { window.location.href = "/control/login"; }
      if (!res.ok) return { ok: false, j, message: errorMessage(j, "The register refused that.") };
      return { ok: true, j, message: null };
    } finally {
      setBusy(false); setArmed(null);
    }
  }

  // Armed on the first tap, executed on the second — these write to other people's accounts and
  // money records, and a stray click must cost nothing.
  const twoTap = (key: string, run: () => void) => () => {
    if (armed !== key) { setArmed(key); setError(null); setNotice(null); return; }
    run();
  };

  async function decide(p: PassRow, approve: boolean) {
    const note = (notes[p.pass_id] ?? "").trim();
    if (!approve && note.length < 4) {
      setError("A refusal needs the reason in the record — the seeker cannot see it, but the next "
        + "person at this desk has to.");
      return;
    }
    const r = await send(`/control/directory/passes/${p.pass_id}/verify`,
      { approve, note: note || undefined });
    if (!r.ok) { setError(r.message); return; }
    setNotes((s) => ({ ...s, [p.pass_id]: "" }));
    setNotice(approve
      ? `Confirmed: ${p.seeker_name ?? p.email}'s week is live from this moment `
      + `(${show(p.amount, p.currency)}, ref ${p.payment_reference}). The week is measured from the `
      + "confirmation, not from the hour the money landed."
      : `Refused: reference ${p.payment_reference} is marked rejected with your note on it.`);
    refresh();
  }

  async function moderate(l: ListingRow, action: "verify" | "unverify" | "suspend" | "reinstate") {
    const note = (notes[l.listing_id] ?? "").trim();
    if (action === "suspend" && note.length < 4) {
      setError("A suspension needs a reason the company can act on.");
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await fetch(`${API}/api/v1/control/directory/listings/${l.listing_id}/moderate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ action, note: note || undefined })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 409 && j?.error?.code === "LISTING_HELD"
          ? heldWords(j, "A signed exclusion is holding this card off the board.")
          : errorMessage(j, "The card would not move."));
        return;
      }
      setNotes((s) => ({ ...s, [l.listing_id]: "" }));
      setNotice({
        verify: `Verified ${l.company_name} — the badge is on the card seekers see.`,
        unverify: `Verification withdrawn from ${l.company_name}.`,
        suspend: `Suspended ${l.company_name} — it no longer appears in searches.`,
        reinstate: `${l.company_name} is live again and counts in searches from this second.`
      }[action]);
      refresh();
    } finally {
      setBusy(false); setArmed(null);
    }
  }

  async function moveMark(m: MarkRow, action: "hide" | "unhide") {
    const reason = draft.markReason.trim();
    if (reason.length < SENT) {
      setPanelError(`A mark is put off the board, or brought back, with the sentence that says why `
        + `— at least ${SENT} characters.`);
      return;
    }
    const r = await send(`/control/directory/ratings/${m.id}/moderate`, { action, reason });
    if (!r.ok) { setPanelError(r.message); return; }
    setPanel(null); setDraft({ ...draft, markReason: "" });
    setNotice(action === "hide"
      ? `Hidden: ${m.listed_name}'s ${m.stars}-star mark is off the board. The stars, who wrote it and `
      + "your reason all stay on the register — that is how this is answerable later."
      : `Back on the board: ${m.listed_name}'s mark counts again, and your reason for returning it is kept `
      + "with it.");
    setError(null);
    refresh();
  }

  async function pressHold(p: Panel) {
    // One sentence, one body. A lift is signed off with the note field, a signature request and a
    // refusal with the reason field — which is what the routes each of them calls expects.
    const sentence = (p.kind === "lift" ? draft.note : draft.reason).trim();
    if (sentence.length < SENT) {
      setPanelError(`The register wants the sentence the paper is moved on — at least ${SENT} characters.`);
      return;
    }
    const body = p.kind === "sig" ? { reason: sentence } : { note: sentence };
    const path = { sig: "signature", refuse: "refuse", lift: "lift" }[p.kind as "sig" | "refuse" | "lift"];
    const r = await send(`/control/directory/exclusions/${p.id}/${path}`, body);
    if (!r.ok) { setPanelError(r.message); return; }
    setPanel(null); setDraft({ reason: "", note: "", markReason: "" });
    setNotice(
      p.kind === "sig"
        ? `Asked. ${p.ref} now stands open on a second seat's signature for ${r.j.days ?? p.days ?? ""} `
        + `days on ${p.name}. Nothing has happened to them yet — the window they sign is the window `
        + "that runs, and the signature is spent on the Approvals desk by somebody who did not raise this."
        : p.kind === "refuse"
          ? `Put down. ${p.ref} is refused, the paper stays on the register with your note, and the `
          + "company keeps trading. Re-asking is still open."
          : `Lifted. ${p.ref} is off the register. ${
            r.j.card_restored
              ? "The card is back on the board."
              : "The card did NOT come back — the register kept it down for its own reason, and says "
                + "so on the paper."}`);
    setError(null);
    refresh();
  }

  async function raiseHold() {
    const days = Number(raise.days);
    const picked = raise.subjectKind === "company"
      ? pick?.find((r) => r.listing_id === raise.subjectId) ?? null : null;
    if (raise.subjectKind === "company" && !picked) {
      setPanelError("Name the card from the search — a hold filed against a card id copied from "
        + "somewhere else is a hold on the wrong company.");
      return;
    }
    if (raise.subjectKind !== "company" && !/^[0-9a-f-]{36}$/i.test(raise.subjectId.trim())) {
      setPanelError("Paste the id of the vehicle or the driver. The register reads the plate, the "
        + "class and the account off its own tables, so an id that is not there is refused rather "
        + "than filed against the wrong subject.");
      return;
    }
    if (raise.reason.trim().length < SENT || raise.note.trim().length < SENT) {
      setPanelError(`Two sentences are needed, both at least ${SENT} characters: the reason is what `
        + "the second seat signs, the note is what the company is told.");
      return;
    }
    if (!Number.isInteger(days) || days < 1 || days > 1095) {
      setPanelError("The window is between 1 and 1095 days. There is no open-ended hold here.");
      return;
    }
    const r = await send("/control/directory/exclusions", {
      subjectKind: raise.subjectKind, subjectId: raise.subjectId.trim(),
      reasonCode: raise.reasonCode, reason: raise.reason.trim(), note: raise.note.trim(), days
    });
    if (!r.ok) { setPanelError(r.message); return; }
    setPanel(null);
    setRaise({ subjectKind: "company", subjectId: "", companyQuery: "", reasonCode: "complaint",
      reason: "", note: "", days: "30" });
    setPick(null); setHeld(null); setHeldFor(null);
    setNotice(`Written: ${r.j.ref} is a ${days}-day ${raise.subjectKind} hold on the register, in the "raised" `
      + "state. It does nothing until a second seat signs it — press Ask for a signature on the row, "
      + "then have somebody who did not raise it sign on Approvals.");
    setError(null);
    setTab("holds");
    refresh();
  }

  async function searchCompanies(term: string) {
    setPickBusy(true);
    const res = await fetch(
      `${API}/api/v1/control/directory/listings${term ? `?q=${encodeURIComponent(term)}` : ""}`,
      { credentials: "include" });
    if (!res.ok) {
      setPanelError(errorMessage(await res.json().catch(() => ({})),
        "The register of cards would not answer."));
      setPick([]); setPickBusy(false); return;
    }
    setPick(await res.json());
    setPickBusy(false);
  }

  async function checkHeld() {
    const id = raise.subjectId.trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      setPanelError("Paste the id first — the register answers for one subject, not for a name.");
      return;
    }
    setPanelError(null); setError(null); setHeld(null); setHeldFor(id);
    const p = new URLSearchParams({ kind: raise.subjectKind, id });
    const res = await fetch(`${API}/api/v1/control/directory/held?${p}`, { credentials: "include" });
    if (!res.ok) {
      setError(errorMessage(await res.json().catch(() => ({})),
        "The register would not say whether that subject is held."));
      setHeldFor(null); return;
    }
    setHeld((await res.json()).held ?? null);
  }

  // ---------- the CSV ----------

  async function exportCsv() {
    const register = EXPORT_REGISTER[tab];
    if (!register) return;
    setExporting(true); setError(null);
    try {
      const p = new URLSearchParams({ register });
      if (register === "ratings") {
        if (mFilter.state) p.set("state", mFilter.state);
        if (mFilter.q.trim()) p.set("q", mFilter.q.trim());
      } else {
        if (hFilter.state) p.set("state", hFilter.state);
        if (hFilter.kind) p.set("kind", hFilter.kind);
        if (hFilter.q.trim()) p.set("q", hFilter.q.trim());
      }
      const res = await fetch(`${API}/api/v1/control/directory/export?${p}`,
        { credentials: "include" });
      if (!res.ok) {
        setError(errorMessage(await res.json().catch(() => ({})), "The export did not answer."));
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `directory-${register}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      setNotice(register === "ratings"
        ? "The marks board was exported with the filter on screen — both names, the answer, and who "
        + "hid what."
        : "The exclusion register was exported with the filter on screen — each paper with the state "
        + "its signature reached and the window it runs.");
    } finally { setExporting(false); }
  }

  function openPanel(next: Panel) {
    setArmed(null); setPanelError(null); setDraft({ reason: "", note: "", markReason: "" });
    if (next.kind === "raise") { setPick(null); setHeld(null); setHeldFor(null); }
    const closing = panel?.kind === next.kind && panel?.id === next.id;
    if (closing) { setPanel(null); return; }
    setPanel(next);
    if (next.kind === "raise") searchCompanies("");
    requestAnimationFrame(() =>
      document.getElementById("directory-form")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  function openPaper(h: HoldRow) {
    if (paperFor === h.id) { setPaper(null); setPaperFor(null); return; }
    setPaperFor(h.id); setPaper(null); setError(null);
    readPaper(h.id);
  }

  const armKey = (p: Panel) => `${p.kind}:${p.id ?? ""}`;

  // ---------- the screen ----------

  // Either the permissions probe already says this seat holds no directory duty, or a register
  // answered 403 to a read the probe implied it could make. Both are the same screen: the desk is
  // not this seat's to read, and saying so is better than four empty tables.
  if (forbidden || (me && !canView)) {
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
              This desk is not yours to read
            </h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ")
                || "no platform duty"}. Reading the four registers needs <code>{VIEW}</code>.
            </p>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Confirming a seeker&apos;s money reference, verifying or suspending a card and taking a
              mark off the board needs <code>{MODERATE}</code> — a seat paid to move money holds that,
              and holds nothing else here.
            </p>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Writing, signing off or lifting a dated exclusion needs <code>{EXCLUSION}</code>, and no
              hold takes effect on one seat&apos;s word: the signature is spent on{" "}
              <Link href="/control/approvals" className="underline">Approvals</Link> by somebody who
              did not raise it.
            </p>
            <Link href="/control" className="waisha-btn mt-16 inline-block rounded-input px-16 py-8 text-xs font-semibold">
              Back to the control panel
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const markStats: [any, string][] = [
    [mCounts?.live ?? "—", "Counting"],
    [mCounts?.awaiting_answer ?? "—", "Owe an answer"],
    [mCounts?.replied ?? "—", "Answered"],
    [mCounts?.hidden ?? "—", "Hidden by the office"],
    [mCounts?.withdrawn ?? "—", "Taken back"],
    [mCounts ? `${mCounts.mean} of 5` : "—", "The mean that counts"],
    [mCounts?.seekers ?? "—", "From seekers"],
    [mCounts?.companies ?? "—", "From companies"]
  ];
  const holdStats: [any, string, string?][] = [
    [hCounts?.running ?? "—", "Holds running", "var(--danger)"],
    [hCounts?.expired_hold ?? "—", "Past their date, still active", "var(--warning)"],
    [hCounts?.awaiting ?? "—", "Open on a signature", "var(--warning)"],
    [hCounts?.raised ?? "—", "Written, not yet asked"],
    [hCounts?.lifted ?? "—", "Lifted early", "var(--success)"],
    [hCounts?.refused ?? "—", "Put down"],
    [hCounts?.companies ?? "—", "On companies"],
    [hCounts?.vehicles ?? "—", "On vehicles"],
    [hCounts?.drivers ?? "—", "On drivers"]
  ];

  const pickedCard = pick?.find((r) => r.listing_id === raise.subjectId) ?? null;
  const markOk = draft.markReason.trim().length >= SENT;
  const sigOk = draft.reason.trim().length >= SENT;
  const refuseOk = draft.reason.trim().length >= SENT;
  const liftOk = draft.note.trim().length >= SENT;
  const raiseOk = !!raise.subjectId
    && raise.reason.trim().length >= SENT && raise.note.trim().length >= SENT
    && Number.isInteger(Number(raise.days)) && Number(raise.days) >= 1 && Number(raise.days) <= 1095;

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Marketplace desk · {canHold ? "cards, marks and holds"
              : canModerate ? "cards and marks" : "read-only"}
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1240px] px-16 py-32">
        <div className="flex flex-wrap items-end justify-between gap-16">
          <div className="min-w-0">
            <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
              What a company is worth on the board, and what takes it off
            </h1>
            <p className="mt-8 max-w-[80ch] text-sm" style={{ color: "var(--ink-soft)" }}>
              Four registers on one desk. Nothing here moves money: a pass is a reference somebody
              typed after paying the office out of band. A mark is what a seeker or a counterparty
              said about a card, and the office can take it off the board but never delete it. A hold
              is a dated exclusion — written by one seat, signed by another, and the only hand that
              pulls a company out of the searches.
            </p>
          </div>
          {canHold && (
            <button type="button" onClick={() => openPanel({ kind: "raise" })}
              className="waisha-btn min-h-[36px] rounded-input px-16 py-8 text-xs font-semibold">
              {panel?.kind === "raise" ? "Close the hold form" : "Hold a company, a plate or a driver"}
            </button>
          )}
        </div>

        {notice && (
          <div role="status" className="mt-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)",
              borderLeft: "4px solid var(--success)" }}>
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="mt-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
              borderLeft: "4px solid var(--danger)" }}>
            {error}
          </div>
        )}

        {/* ---------------- the panels ---------------- */}
        {panel && (
          <section id="directory-form" className="mt-20 rounded-card border p-16"
            style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
            <div className="flex flex-wrap items-baseline justify-between gap-8">
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                {panel.kind === "mark"
                  ? `${panel.action === "hide" ? "Take a mark off the board" : "Put a mark back on"} — ${panel.listedName ?? ""}`
                  : panel.kind === "raise" ? "Write a dated exclusion"
                    : panel.kind === "sig" ? "Ask a second seat to sign this hold"
                      : panel.kind === "refuse" ? "Put this paper down"
                        : "Lift a running hold"}
              </h2>
              {panel.ref && (
                <p className="text-[11px] font-bold tabular-nums" style={{ color: "var(--adm-accent)" }}>
                  {panel.ref}
                </p>
              )}
            </div>

            {panelError && (
              <div role="alert" className="mt-10 rounded-input px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
                  borderLeft: "4px solid var(--danger)" }}>
                {panelError}
              </div>
            )}

            {panel.kind === "mark" && (
              <>
                <p className="mt-10 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {panel.stars} of 5 {panel.comment ? `· "${panel.comment}"` : "· no comment was written"}
                  {" "}· taken off the board and back both need a reason that stays on the register.
                </p>
                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  Why — the sentence the next person at this desk reads
                  <textarea value={draft.markReason} rows={3} className={box} style={boxStyle}
                    placeholder="the mark names a driver by number and a route that was never booked — held for the office's own check"
                    onChange={(e) => setDraft({ ...draft, markReason: e.target.value })} />
                </label>
              </>
            )}

            {panel.kind === "raise" && (
              <>
                <div className="mt-12 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
                  <label className={labelText} style={{ color: "var(--ink-soft)" }}>
                    What is being held
                    <select value={raise.subjectKind} className={box} style={boxStyle}
                      onChange={(e) => {
                        setRaise({ ...raise, subjectKind: e.target.value, subjectId: "" });
                        setPick(null); setHeld(null); setHeldFor(null);
                      }}>
                      {SUBJECTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                  <label className={labelText} style={{ color: "var(--ink-soft)" }}>
                    Why, in the register&apos;s own words
                    <select value={raise.reasonCode} className={box} style={boxStyle}
                      onChange={(e) => setRaise({ ...raise, reasonCode: e.target.value })}>
                      {REASON_CODES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </label>
                  <label className={labelText} style={{ color: "var(--ink-soft)" }}>
                    How many days (1-1095)
                    <input value={raise.days} inputMode="numeric" className={box} style={boxStyle}
                      onChange={(e) => setRaise({ ...raise, days: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
                  </label>
                </div>
                <div className="mt-10 flex flex-wrap gap-8">
                  {WINDOWS.map((d) => (
                    <button key={d} type="button" className={mini}
                      style={Number(raise.days) === d
                        ? { borderColor: "var(--adm-accent)", color: "var(--ink)",
                          background: "color-mix(in srgb, var(--adm-accent) 14%, transparent)" }
                        : miniStyle}
                      onClick={() => setRaise({ ...raise, days: String(d) })}>
                      {d} days
                    </button>
                  ))}
                </div>

                {raise.subjectKind === "company" ? (
                  <fieldset className="mt-16 rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
                    <legend className="px-8 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                      Which card
                    </legend>
                    <div className="flex flex-wrap gap-10">
                      <input value={raise.companyQuery} aria-label="Search cards"
                        onChange={(e) => setRaise({ ...raise, companyQuery: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchCompanies(raise.companyQuery); } }}
                        placeholder="The name it trades under"
                        className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
                      <button type="button" className={headBtn} style={miniStyle} disabled={pickBusy}
                        onClick={() => searchCompanies(raise.companyQuery)}>
                        {pickBusy ? "Reading…" : "Find"}
                      </button>
                    </div>
                    {pickedCard && (
                      <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
                        Holding <span className="font-semibold">{pickedCard.company_name}</span> off the
                        board — {pickedCard.serves.join(" + ") || "no service on the card"},{" "}
                        {pickedCard.region_names.join(", ") || "no region"}, currently {pickedCard.status}.
                      </p>
                    )}
                    {pick === null ? null : pick.length === 0 ? (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--ink)" }}>
                        No card by that name. A company that never published one is not on the
                        directory and cannot be held off it.
                      </p>
                    ) : (
                      <ul className="mt-8 max-h-[240px] overflow-y-auto">
                        {pick.map((r) => (
                          <li key={r.listing_id} className="border-b py-10 last:border-b-0">
                            <button type="button" onClick={() => setRaise({ ...raise, subjectId: r.listing_id })}
                              className="w-full border-0 bg-transparent p-0 text-left"
                              style={{ background: r.listing_id === raise.subjectId
                                ? "color-mix(in srgb, var(--adm-accent) 12%, transparent)" : undefined }}>
                              <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>
                                {r.company_name}
                              </p>
                              <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                                {r.serves.join(" + ") || "—"} · {r.region_names.join(", ") || "no region"} ·{" "}
                                {r.status}{r.is_verified ? " · verified" : ""} ·{" "}
                                {Number(r.searches ?? 0)} opens
                              </p>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </fieldset>
                ) : (
                  <fieldset className="mt-16 rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
                    <legend className="px-8 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                      Which {raise.subjectKind}
                    </legend>
                    <div className="flex flex-wrap gap-10">
                      <input value={raise.subjectId} aria-label="Subject id"
                        onChange={(e) => { setRaise({ ...raise, subjectId: e.target.value }); setHeld(null); setHeldFor(null); }}
                        placeholder="the uuid of the vehicle or the driver"
                        className="min-w-[240px] flex-1 rounded-input border px-12 py-8 text-sm tabular-nums" style={boxStyle} />
                      <button type="button" className={headBtn} style={miniStyle} onClick={checkHeld}>
                        Is it held already?
                      </button>
                    </div>
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      Nothing about the subject is typed but the id: the register reads the plate and
                      type, or the name and licence class, out of its own tables and refuses an id it
                      cannot find. A driver&apos;s identity number and phone are sealed columns and are
                      never copied into the label — the label is the class and the status. The picker
                      that searches plates and names arrives with the registry reads; until then this
                      box is filled from the fleet desk.
                    </p>
                    {heldFor && heldFor === raise.subjectId.trim() && (
                      held ? (
                        <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>
                          Already held: {held.ref} on {held.subject_name} ({held.company_name}) until{" "}
                          {day(held.ends_at)} — {word(REASON_CODES, held.reason_code)}. One live hold per
                          subject, so this paper would be refused.
                        </p>
                      ) : (
                        <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                          Nothing running on that id right now.
                        </p>
                      )
                    )}
                  </fieldset>
                )}

                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  The reason the second seat signs
                  <textarea value={raise.reason} rows={3} className={box} style={boxStyle}
                    placeholder="three booked jobs left unloaded and two disputes upheld against this card in ninety days"
                    onChange={(e) => setRaise({ ...raise, reason: e.target.value })} />
                </label>
                <label className={`${labelText} mt-12 block`} style={{ color: "var(--ink-soft)" }}>
                  The note the company is given
                  <textarea value={raise.note} rows={3} className={box} style={boxStyle}
                    placeholder="off the directory until 22 November while the office settles the two open disputes"
                    onChange={(e) => setRaise({ ...raise, note: e.target.value })} />
                </label>
                <p className="mt-10 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Two sentences, because they are not the same words — one is signed, one is read by
                  the company. Writing this paper takes a company off the board only after a second
                  seat signs it, and the window they sign is the window that runs.
                </p>
              </>
            )}

            {panel.kind === "sig" && (
              <>
                <p className="mt-10 text-xs" style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{panel.ref}</span> — {panel.name}, {panel.days} days.
                </p>
                <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  The subject, the reason and the window are read out of the row and hashed; what the
                  second seat signs is provably this paper. Nothing happens to{" "}
                  {panel.name} until that signature is spent on{" "}
                  <Link href="/control/approvals" className="underline">Approvals</Link> by somebody
                  who did not raise it.
                </p>
                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  What you are asking them to sign for
                  <textarea value={draft.reason} rows={3} className={box} style={boxStyle}
                    placeholder="hold asked on the two upheld disputes; 30 days off the board, reviewed when it expires"
                    onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                </label>
              </>
            )}

            {panel.kind === "refuse" && (
              <>
                <p className="mt-10 text-xs" style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{panel.ref}</span> — {panel.name},{" "}
                  {word(SUBJECTS, panel.subjectKind)} for {panel.days} days.
                </p>
                {panel.status && (
                  <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    The paper says {word(HOLD_STATES, panel.status, panel.status)} now. Refusing it is an
                    answer, not a deletion: the row and your note stay, the company keeps trading, and
                    the hold can be asked again. One seat is enough, because nothing is taken away by a
                    refusal.
                  </p>
                )}
                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  Why the hold is not upheld
                  <textarea value={draft.reason} rows={3} className={box} style={boxStyle}
                    placeholder="both disputes were settled on the service desk before the paper was written — refused, card stays live"
                    onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                </label>
              </>
            )}

            {panel.kind === "lift" && (
              <>
                <p className="mt-10 text-xs" style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{panel.ref}</span> — {panel.name},{" "}
                  {word(SUBJECTS, panel.subjectKind)}
                  {panel.days ? `, ${panel.days} days` : ""}
                  {panel.endsAt ? `, running to ${day(panel.endsAt)}` : ""}.
                </p>
                <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  One seat is enough to let a company back — the two-seat rule guards the hand that
                  stops it trading. If another hold still runs on the same account, or the licence gate
                  has shut it since, the paper leaves the register and the card stays down with the
                  other reason written on it. The answer will say which.
                </p>
                <label className={`${labelText} mt-14 block`} style={{ color: "var(--ink-soft)" }}>
                  Why it comes off early
                  <textarea value={draft.note} rows={3} className={box} style={boxStyle}
                    placeholder="the office settled the two disputes on 14 November and the caller agreed the hold is answered"
                    onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
                </label>
              </>
            )}

            <div className="mt-16 flex flex-wrap items-center gap-12">
              <button type="button" disabled={!ready() || busy}
                onClick={() => {
                  if (armed !== armKey(panel)) { setArmed(armKey(panel)); return; }
                  if (panel.kind === "mark") moveMark(m2r(panel), panel.action!);
                  else if (panel.kind === "raise") raiseHold();
                  else pressHold(panel);
                }}
                className="waisha-btn min-h-[36px] rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-40">
                {busy ? "Writing…" : armed !== armKey(panel)
                  ? `${WORDS[panel.kind]} — press again to confirm`
                  : `${WORDS[panel.kind]} — yes, write it`}
              </button>
              <button type="button" onClick={() => { setPanel(null); setArmed(null); setPanelError(null); }}
                className={headBtn} style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                Cancel
              </button>
              {!ready() ? (
                <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>{whyNotReady()}</p>
              ) : armed === armKey(panel) ? (
                <p className="text-[11px]" style={{ color: "var(--warning)" }}>
                  {panel.kind === "raise"
                    ? "This writes a paper onto a register other desks read. Nothing is taken from the company until a second seat signs it."
                    : panel.kind === "lift"
                      ? "This takes a running hold off the register and may put a card back on the board."
                      : "Press it again and this is written on the register. Nothing here takes it back."}
                </p>
              ) : null}
            </div>
          </section>
        )}

        {/* ---------------- the tabs ---------------- */}
        <div className="mt-28 flex flex-wrap items-center gap-10">
          {TABS.map(([k, v]) => (
            <button key={k} type="button"
              onClick={() => { setTab(k); setPanel(null); setError(null); }}
              className={headBtn}
              style={tab === k
                ? { borderColor: "var(--adm-accent)", color: "var(--ink)",
                  background: "color-mix(in srgb, var(--adm-accent) 14%, transparent)" }
                : { borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              {v}
              {k === "passes" && passes ? ` (${passes.length})` : ""}
              {k === "holds" && hCounts ? ` (${hCounts.total})` : ""}
            </button>
          ))}
          {EXPORT_REGISTER[tab] && (
            <button type="button" onClick={exportCsv} disabled={exporting || !canView}
              className={`${headBtn} ml-auto`} style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
              {exporting ? "Reading…" : `Export ${EXPORT_REGISTER[tab]} (CSV)`}
            </button>
          )}
        </div>
        {EXPORT_REGISTER[tab] && (
          <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            The CSV carries the filter on screen, not the page on screen — walked a hundred rows at a
            time, up to three thousand.
          </p>
        )}

        {/* ---------------- the passes ---------------- */}
        {tab === "passes" && (
          <section className="mt-20">
            <div className="flex flex-wrap items-baseline justify-between gap-8 border-b px-4 py-10"
              style={{ borderColor: "var(--line)" }}>
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                Payment references awaiting confirmation
              </h2>
              <span className="text-[11px] font-semibold" style={{ color: "var(--ink-soft)" }}>
                {passes === null ? "Reading…"
                  : passes.length >= 200 ? "200 waiting — the queue is read oldest first and stops there"
                    : `${passes.length} waiting`}
              </span>
            </div>
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              These are references people typed after paying the office out of band. WAISHA never
              touches the money; confirming one starts their week from this moment, not from the hour
              they paid, because the money usually lands a day late.
            </p>
            {passes === null ? (
              <p role="status" className="mt-16 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the queue…</p>
            ) : passes.length === 0 ? (
              <p className="mt-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                Nobody is waiting on the office right now.
              </p>
            ) : (
              <ul className="mt-12">
                {passes.map((p, i) => (
                  <li key={p.pass_id} className="border-b py-14 last:border-b-0"
                    style={{ background: i % 2 ? "var(--milk-deep)" : undefined }}>
                    <div className="flex flex-wrap items-start justify-between gap-12">
                      <div className="min-w-[240px] flex-1">
                        <p className="text-sm font-semibold break-words" style={{ color: "var(--ink)" }}>
                          {p.seeker_name ?? "—"}{" "}
                          <span className="font-normal break-all" style={{ color: "var(--ink-soft)" }}>· {p.email}</span>
                        </p>
                        <p className="mt-4 text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
                          {show(p.amount, p.currency)} · {METHODS[p.payment_method ?? ""] ?? p.payment_method ?? "channel not stated"} ·
                          recorded {when(p.recorded_at)}
                        </p>
                        <p className="mt-4 text-[11px] font-bold uppercase tracking-[0.12em] break-words" style={{ color: "var(--adm-accent)" }}>
                          Ref {p.payment_reference} · {p.kind}
                        </p>
                      </div>
                      <div className="flex min-w-[220px] flex-col gap-8">
                        <input value={notes[p.pass_id] ?? ""}
                          onChange={(e) => setNotes((s) => ({ ...s, [p.pass_id]: e.target.value }))}
                          placeholder="Note for the record (optional)"
                          className="w-full rounded-input border px-10 py-8 text-sm" style={boxStyle} />
                        <div className="flex flex-wrap gap-8">
                          {canModerate && (
                            <>
                              <button type="button" disabled={busy}
                                onClick={twoTap(`pass-${p.pass_id}-ok`, () => decide(p, true))}
                                className={mini}
                                style={armed === `pass-${p.pass_id}-ok`
                                  ? { borderColor: "var(--success)", color: "var(--ink)",
                                    background: "color-mix(in srgb, var(--success) 16%, transparent)" }
                                  : { borderColor: "var(--success)", color: "var(--ink)" }}>
                                {armed === `pass-${p.pass_id}-ok` ? "Tap again to confirm" : "Confirm payment"}
                              </button>
                              <button type="button" disabled={busy}
                                onClick={twoTap(`pass-${p.pass_id}-no`, () => decide(p, false))}
                                className={mini} style={{ borderColor: "var(--danger)", color: "var(--ink)" }}>
                                {armed === `pass-${p.pass_id}-no` ? "Tap again to refuse" : "Refuse"}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* ---------------- the cards ---------------- */}
        {tab === "listings" && (
          <section className="mt-20">
            <div className="flex flex-wrap gap-12">
              <input value={lq} aria-label="Search cards"
                onChange={(e) => setLq(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { ++seq.current; loadListings(seq.current, lq); } }}
                placeholder="Company name — press Enter"
                className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <button type="button" className={headBtn} style={miniStyle}
                onClick={() => { const key = ++seq.current; loadListings(key, lq); }}>
                Find
              </button>
            </div>
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              Companies publish and edit their own card from their portal; this register is every one
              that exists. A card a signed hold is keeping down cannot be reinstated from here — the
              hold is released on the Blacklist tab, and this desk is told so when it tries.
            </p>
            {!!listings && listings.length >= 200 && (
              <p className="mt-8 text-[11px] font-semibold" style={{ color: "var(--warning)" }}>
                The reader stops at the first 200 cards. Narrow the name box rather than counting the
                page as the whole register.
              </p>
            )}
            <List loading={listings === null} empty={!!listings && listings.length === 0}
              emptyWords="No card by that name. Clear the box and read again — the register carries every company that ever published."
              head={["Company", "Serves", "Regions", "Status", "Opens", "Contact", "The office's hand"]}
              rows={(listings ?? []).map((l) => ([
                <span key="a" className="break-words">
                  <span className="font-semibold">{l.company_name}</span>
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    updated {when(l.updated_at)}{l.published_at ? ` · live since ${day(l.published_at)}` : ""}
                  </span>
                </span>,
                <span key="b" className="break-words">{l.serves.join(" + ") || "—"}</span>,
                <span key="c" className="break-words">{l.region_names.join(", ") || "—"}</span>,
                <span key="d">
                  <Chip edge={l.status === "live" ? "var(--success)"
                    : l.status === "suspended" ? "var(--danger)" : "var(--ink-soft)"}>
                    {l.status}
                  </Chip>
                  {l.is_verified && (
                    <span className="mt-6 block text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: "var(--adm-accent)" }}>
                      verified
                    </span>
                  )}
                </span>,
                <span key="e" className="tabular-nums">{Number(l.searches ?? 0)}</span>,
                <span key="f" className="break-words text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {l.contact_name ?? "—"}{l.contact_channel ? ` · ${l.contact_channel}` : ""}
                </span>,
                <span key="g" className="flex flex-col gap-8">
                  <span className="flex flex-wrap gap-8">
                    {canModerate && (
                      <>
                        <button type="button" disabled={busy}
                          onClick={twoTap(`lst-${l.listing_id}-v`, () => moderate(l, l.is_verified ? "unverify" : "verify"))}
                          className={mini} style={miniStyle}>
                          {armed === `lst-${l.listing_id}-v` ? "Tap again" : l.is_verified ? "Unverify" : "Verify"}
                        </button>
                        <button type="button" disabled={busy}
                          onClick={twoTap(`lst-${l.listing_id}-s`,
                            () => moderate(l, l.status === "suspended" ? "reinstate" : "suspend"))}
                          className={mini}
                          style={{ borderColor: l.status === "suspended" ? "var(--success)" : "var(--danger)", color: "var(--ink)" }}>
                          {armed === `lst-${l.listing_id}-s` ? "Tap again"
                            : l.status === "suspended" ? "Reinstate" : "Suspend"}
                        </button>
                      </>
                    )}
                  </span>
                  <input value={notes[l.listing_id] ?? ""}
                    onChange={(e) => setNotes((s) => ({ ...s, [l.listing_id]: e.target.value }))}
                    placeholder="Reason for the record (needed to suspend)"
                    className="w-full min-w-[180px] rounded-input border px-10 py-6 text-[11px]" style={boxStyle} />
                </span>
              ]))}
            />
          </section>
        )}

        {/* ---------------- the marks ---------------- */}
        {tab === "marks" && (
          <section className="mt-20">
            <div className="mt-0 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
              {markStats.map(([value, text]) => (
                <div key={text} className="rounded-card border p-12"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <p className="text-base font-bold tabular-nums" style={{ color: "var(--ink)" }}>{value}</p>
                  <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                    {text}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              The eight numbers count the whole board, not this filter. The mean is worked out only of
              marks that are neither hidden nor withdrawn — the same predicate every card shows its
              seeker.
            </p>
            <div className="mt-16 flex flex-wrap gap-12">
              <input value={mFilter.q} aria-label="Search marks"
                onChange={(e) => setMFilter({ ...mFilter, q: e.target.value, offset: "0" })}
                placeholder="The name on the card, the mark, or the company's answer"
                className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={mFilter.state} aria-label="Filter the marks board"
                onChange={(e) => setMFilter({ ...mFilter, state: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                {MARK_STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <List loading={marks === null} empty={!!marks && marks.rows.length === 0}
              emptyWords="Nothing on the board under this filter. A board that is empty after a filter is the filter, not an empty register."
              head={["The card", "The mark", "Who wrote it", "Answer", "The office", ""]}
              rows={(marks?.rows ?? []).map((m) => ([
                <span key="a" className="break-words">
                  <span className="font-semibold">{m.listed_name}</span>
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {m.basis === "booking" ? "a booked job between two companies" : "a seeker who opened the card"}
                  </span>
                </span>,
                <span key="b">
                  <span className="tabular-nums font-semibold">{m.stars} of 5</span>
                  <span className="block mt-4 max-w-[40ch] break-words text-[11px]" style={{ color: "var(--ink)" }}>
                    {m.comment ?? "no comment was written"}
                  </span>
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {when(m.created_at)}
                  </span>
                </span>,
                <span key="c" className="break-words text-[10px]">
                  {m.rater_kind === "company"
                    ? <span className="font-semibold">{m.rater_name}</span>
                    : <span style={{ color: "var(--ink-soft)" }}>a seeker on WAISHA</span>}
                  <span className="block" style={{ color: "var(--ink-soft)" }}>
                    {m.rater_kind === "company" && m.rater_email ? m.rater_email : "never named to a reader"}
                  </span>
                </span>,
                <span key="d" className="break-words text-[11px]">
                  {m.reply ? (
                    <>
                      <span className="block max-w-[40ch]" style={{ color: "var(--ink)" }}>{m.reply}</span>
                      <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        {m.replied_name ?? "the company"} · {when(m.replied_at)}
                      </span>
                    </>
                  ) : m.withdrawn_at ? (
                    <span className="text-[10px]" style={{ color: "var(--ink-soft)" }}>taken back by who wrote it</span>
                  ) : (
                    <Chip edge="var(--warning)">owes an answer</Chip>
                  )}
                </span>,
                <span key="e" className="break-words text-[10px]">
                  {m.hidden_at ? (
                    <>
                      <Chip edge="var(--danger)">hidden</Chip>
                      <span className="mt-4 block max-w-[34ch]" style={{ color: "var(--ink)" }}>
                        {m.hidden_reason}
                      </span>
                      <span className="block" style={{ color: "var(--ink-soft)" }}>
                        {m.hidden_name ?? "the office"} · {when(m.hidden_at)}
                      </span>
                    </>
                  ) : m.withdrawn_at ? (
                    <Chip edge="var(--ink-soft)">withdrawn {day(m.withdrawn_at)}</Chip>
                  ) : (
                    <span style={{ color: "var(--ink-soft)" }}>on the board</span>
                  )}
                </span>,
                <span key="f">
                  {canModerate && (
                    <button type="button" className={mini} style={miniStyle}
                      onClick={() => openPanel({
                        kind: "mark", id: m.id, listedName: m.listed_name, action: m.hidden_at ? "unhide" : "hide",
                        stars: m.stars, comment: m.comment
                      })}>
                      {panel?.kind === "mark" && panel.id === m.id
                        ? "Close" : m.hidden_at ? "Put it back" : "Hide it"}
                    </button>
                  )}
                </span>
              ]))}
            />
            <Pager filter={mFilter} setFilter={setMFilter} total={marks?.total ?? 0} />
          </section>
        )}

        {/* ---------------- the holds ---------------- */}
        {tab === "holds" && (
          <section className="mt-20">
            <div className="mt-0 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
              {holdStats.map(([value, text, tone]) => (
                <div key={text} className="rounded-card border p-12"
                  style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
                  <p className="text-base font-bold tabular-nums" style={{ color: tone ?? "var(--ink)" }}>{value}</p>
                  <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                    {text}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              &quot;Past their date, still active&quot; is the number to act on: the row is still marked
              active because nobody has run the expiry yet, so the card is down on a paper that has run
              out. Every count is the whole register, not the filter.
            </p>
            <div className="mt-16 flex flex-wrap gap-12">
              <input value={hFilter.q} aria-label="Search holds"
                onChange={(e) => setHFilter({ ...hFilter, q: e.target.value, offset: "0" })}
                placeholder="The BL number, the subject, the company or the reason"
                className="min-w-[220px] flex-1 rounded-input border px-12 py-8 text-sm" style={boxStyle} />
              <select value={hFilter.state} aria-label="Filter the register"
                onChange={(e) => setHFilter({ ...hFilter, state: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                {HOLD_STATES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select value={hFilter.kind} aria-label="Filter by subject"
                onChange={(e) => setHFilter({ ...hFilter, kind: e.target.value, offset: "0" })}
                className="rounded-input border px-12 py-8 text-sm" style={boxStyle}>
                <option value="">Any subject</option>
                {SUBJECTS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <List loading={holds === null} empty={!!holds && holds.rows.length === 0}
              emptyWords="No paper on the register under this filter. The blacklist is empty, which is the state you want it in."
              head={["Reference", "Held", "Reason", "The window", "The signature", "Whose word", ""]}
              rows={(holds?.rows ?? []).map((h) => ([
                <span key="a" className="break-words">
                  <span className="font-semibold tabular-nums">{h.ref}</span>
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {word(SUBJECTS, h.subject_kind)} · raised {when(h.raised_at)}
                  </span>
                </span>,
                <span key="b" className="break-words">
                  <span className="font-semibold">{h.subject_name}</span>
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {h.subject_label}
                  </span>
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    on {h.company_name}
                  </span>
                </span>,
                <span key="c" className="break-words text-[11px]">
                  <Chip edge={HOLD_EDGES[h.exclusion_status] ?? "var(--ink-soft)"}>
                    {word(HOLD_STATES, h.exclusion_status, h.exclusion_status)}
                  </Chip>
                  <span className="mt-4 block max-w-[40ch]" style={{ color: "var(--ink)" }}>
                    {word(REASON_CODES, h.reason_code, h.reason_code)} — {h.reason}
                  </span>
                  <span className="mt-4 block max-w-[40ch] text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    The company is told: {h.note}
                  </span>
                </span>,
                <span key="d" className="tabular-nums text-[11px]">
                  {h.days} days
                  <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {h.starts_at ? `${day(h.starts_at)} → ${day(h.ends_at)}` : "not started"}
                  </span>
                  {h.exclusion_status === "active" && h.days_left !== null && (
                    <span className="block text-[10px] font-semibold"
                      style={{ color: h.days_left <= 7 ? "var(--warning)" : "var(--ink-soft)" }}>
                      {h.days_left} day(s) left
                    </span>
                  )}
                </span>,
                <span key="e" className="break-words text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {h.approval_status ? (
                    <>
                      {h.approval_status}
                      {h.signed_name && <span className="block" style={{ color: "var(--ink)" }}>signed by {h.signed_name}</span>}
                      {h.approval_expires_at && h.approval_status === "pending" && (
                        <span className="block">asks until {day(h.approval_expires_at)}</span>
                      )}
                      {h.payload_sha256 && (
                        <span className="block tabular-nums">hash {h.payload_sha256.slice(0, 12)}…</span>
                      )}
                    </>
                  ) : <span>no signature asked for</span>}
                </span>,
                <span key="f" className="break-words text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  <span className="block">raised by {h.raised_name ?? "a platform seat"}</span>
                  {h.lifted_at && (
                    <span className="block" style={{ color: "var(--success)" }}>
                      lifted {when(h.lifted_at)} by {h.lifted_name ?? "the office"} — {h.lifted_note}
                    </span>
                  )}
                  {h.refused_at && (
                    <span className="block" style={{ color: "var(--danger)" }}>
                      refused {when(h.refused_at)} by {h.refused_name ?? "the office"} — {h.refused_note}
                    </span>
                  )}
                </span>,
                <span key="g" className="flex flex-col items-start gap-8">
                  <button type="button" className={mini} style={miniStyle} onClick={() => openPaper(h)}>
                    {paperFor === h.id ? "Close the paper" : "The paper"}
                  </button>
                  {canHold && (h.exclusion_status === "raised" || h.exclusion_status === "pending_signature") && (
                    <>
                      <button type="button" className={mini} style={miniStyle}
                        onClick={() => openPanel({
                          kind: "sig", id: h.id, ref: h.ref, name: h.subject_name, days: h.days,
                          subjectKind: h.subject_kind
                        })}>
                        {panel?.kind === "sig" && panel.id === h.id ? "Close" : "Ask a second seat"}
                      </button>
                      <button type="button" className={mini} style={{ borderColor: "var(--danger)", color: "var(--ink)" }}
                        onClick={() => openPanel({
                          kind: "refuse", id: h.id, ref: h.ref, name: h.subject_name, days: h.days,
                          status: h.exclusion_status, subjectKind: h.subject_kind
                        })}>
                        {panel?.kind === "refuse" && panel.id === h.id ? "Close" : "Put it down"}
                      </button>
                    </>
                  )}
                  {canHold && h.exclusion_status === "active" && (
                    <button type="button" className={mini} style={{ borderColor: "var(--success)", color: "var(--ink)" }}
                      onClick={() => openPanel({
                        kind: "lift", id: h.id, ref: h.ref, name: h.subject_name, days: h.days,
                        endsAt: h.ends_at, subjectKind: h.subject_kind
                      })}>
                      {panel?.kind === "lift" && panel.id === h.id ? "Close" : "Lift it"}
                    </button>
                  )}
                </span>
              ]))}
            />
            <Pager filter={hFilter} setFilter={setHFilter} total={holds?.total ?? 0} />

            {paper && paperFor && (
              <section className="mt-20 rounded-card border p-16" style={{ borderColor: "var(--adm-accent)" }}>
                <div className="flex flex-wrap items-baseline justify-between gap-8">
                  <h3 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                    {paper.exclusion?.ref} — everything this paper is made of
                  </h3>
                  <button type="button" className={mini} style={miniStyle}
                    onClick={() => { setPaper(null); setPaperFor(null); }}>
                    Close
                  </button>
                </div>
                <div className="mt-12 grid gap-12" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                  <Block head="The paper">
                    <Line k="Subject" v={`${word(SUBJECTS, paper.exclusion?.subject_kind)} — ${paper.exclusion?.subject_name}`} />
                    <Line k="As it reads on the register" v={paper.exclusion?.subject_label ?? "—"} />
                    <Line k="Account" v={paper.exclusion?.company_name ?? "—"} />
                    <Line k="State" v={word(HOLD_STATES, paper.exclusion?.status, String(paper.exclusion?.status ?? "—"))} />
                    <Line k="Window" v={paper.exclusion?.days ? `${paper.exclusion.days} days from signature` : "—"} />
                    <Line k="Runs" v={paper.exclusion?.starts_at
                      ? `${day(paper.exclusion.starts_at)} → ${day(paper.exclusion.ends_at)}` : "not started"} />
                    <Line k="Reason" v={paper.exclusion?.reason ?? "—"} />
                    <Line k="The company is told" v={paper.exclusion?.note ?? "—"} />
                  </Block>
                  <Block head="The signature it stands on"
                    hint="Spent on Approvals by a seat that did not raise this paper. The window replayed at approval is read off the hashed payload, never from the call.">
                    {paper.approval ? (
                      <>
                        <Line k="Status" v={paper.approval.status} />
                        <Line k="Asked by" v={paper.approval.proposed_name ?? "a platform seat"} />
                        <Line k="Asked on" v={when(paper.approval.proposed_at)} />
                        <Line k="Words they were given" v={paper.approval.reason ?? "—"} />
                        <Line k="Signature" v={paper.approval.decided_name
                          ? `${paper.approval.decided_name} · ${when(paper.approval.decided_at)}`
                          : "not yet signed"} />
                        <Line k="Asks until" v={day(paper.approval.expires_at)} />
                        <Line k="Payload hash" v={paper.approval.payload_sha256 ?? "—"} />
                      </>
                    ) : <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      No signature has been asked for on this paper yet.
                    </p>}
                  </Block>
                  <Block head="The card it is holding down">
                    {paper.card ? (
                      <>
                        <Line k="Status" v={paper.card.status} />
                        <Line k="Flag" v={paper.card.held_by_exclusion
                          ? "held by an exclusion — reinstate on the Listings tab is refused"
                          : "not flagged"} />
                        <Line k="Reason written on it" v={paper.card.suspension_reason ?? "none"} />
                        <Line k="Serves" v={(paper.card.serves ?? []).join(" + ") || "—"} />
                        <Line k="Verified" v={paper.card.is_verified ? "yes" : "no"} />
                      </>
                    ) : <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      This hold is on a vehicle or a driver, which the directory does not list.
                    </p>}
                  </Block>
                  <Block head="What its marks look like now"
                    hint="Counted on the same predicate a seeker sees: neither hidden nor withdrawn.">
                    <Line k="Counting" v={String(paper.marks?.marks ?? 0)} />
                    <Line k="Mean" v={String(paper.marks?.mean ?? 0)} />
                    <Line k="One-star" v={String(paper.marks?.one ?? 0)} />
                    <Line k="Owe an answer" v={String(paper.marks?.awaiting_answer ?? 0)} />
                  </Block>
                </div>
                {(paper.holds ?? []).length > 0 && (
                  <div className="mt-14">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                      Every other hold this account has been under
                    </p>
                    <ul className="mt-8 flex flex-wrap gap-8">
                      {paper.holds.map((o) => (
                        <li key={o.ref} className={chip}
                          style={{ border: "1px solid var(--line)", color: "var(--ink-soft)" }}>
                          {o.ref} · {word(SUBJECTS, o.subject_kind)} {o.subject_name} ·{" "}
                          {day(o.starts_at)} → {day(o.ends_at)}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      The history beside the decision — have we held this company before, and did the
                      last one run out or come off?
                    </p>
                  </div>
                )}
              </section>
            )}
          </section>
        )}
      </main>
    </div>
  );

  function ready() {
    if (!panel) return false;
    switch (panel.kind) {
      case "mark": return markOk;
      case "raise": return raiseOk;
      case "sig": return sigOk;
      case "refuse": return refuseOk;
      case "lift": return liftOk;
      default: return false;
    }
  }

  function whyNotReady() {
    if (!panel) return "";
    if (panel.kind === "mark") {
      return markOk ? "" : `The reason is ${draft.markReason.trim().length} of ${SENT} characters at least.`;
    }
    if (panel.kind === "sig") {
      return sigOk ? "" : "The second seat signs a sentence, not a button.";
    }
    if (panel.kind === "refuse") return refuseOk ? "" : "A refusal is an answer, and an answer needs its reason.";
    if (panel.kind === "lift") return liftOk ? "" : "A hold comes off the register with the sentence that says why.";
    if (raise.subjectKind === "company" && !raise.subjectId) return "Name the card from the search.";
    if (raise.subjectKind !== "company" && !/^[0-9a-f-]{36}$/i.test(raise.subjectId.trim())) {
      return "The id of the vehicle or the driver, as the register holds it.";
    }
    if (raise.reason.trim().length < SENT) return "The reason the second seat signs, in 8 characters or more.";
    if (raise.note.trim().length < SENT) return "The note the company is given, in 8 characters or more.";
    if (!Number.isInteger(Number(raise.days)) || Number(raise.days) < 1 || Number(raise.days) > 1095) {
      return "The window is 1 to 1095 days.";
    }
    return "";
  }

  // The mark panel was opened from a row the board has since re-read; rebuild the row it acts on so a
  // write never lands on a stale copy of it.
  function m2r(p: Panel): MarkRow {
    const found = (marks?.rows ?? []).find((r) => r.id === p.id);
    return found ?? {
      id: p.id!, listing_id: p.listingId ?? "", listed_name: p.listedName ?? "",
      listed_tenant_id: "", stars: p.stars ?? 0, comment: p.comment ?? null, basis: "engagement",
      booking_id: null, search_id: null, rater_name: "", rater_kind: "seeker", rater_email: null,
      created_at: "", reply: null, replied_at: null, replied_name: null, hidden_at: null,
      hidden_reason: null, hidden_name: null, withdrawn_at: null, total: 0
    };
  }
}

const WORDS: Record<Panel["kind"], string> = {
  mark: "Write it on the board", raise: "Write the paper", sig: "Ask for the signature",
  refuse: "Put the paper down", lift: "Lift the hold"
};

// ---------- small pieces of the same desk ----------

function Chip({ edge, children }: { edge: string; children: React.ReactNode }) {
  return (
    <span className={chip} style={{ border: `1px solid ${edge}`, color: edge }}>
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

function Line({ k, v }: { k: string; v: string }) {
  return (
    <p className="mt-8 border-b pb-6 text-[11px] last:border-b-0" style={{ borderColor: "var(--line)" }}>
      <span className="block font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--ink-soft)" }}>
        {k}
      </span>
      <span className="mt-4 block break-words" style={{ color: "var(--ink)" }}>{v || "—"}</span>
    </p>
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
