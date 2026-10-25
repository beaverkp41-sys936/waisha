"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";
import { categoryWord } from "../customers/data-requests";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

/** One proposal on the board — the exact bytes a second seat is asked to sign. */
interface ApprovalRow {
  id: string; action: string; target_kind: string; target_id: string; target_name: string;
  reason: string; approval_status: string;
  payload: { tenant_id?: string; reason_code?: string; note?: string;
    request_id?: string; ref?: string; ticket_ref?: string; amount?: string;
    currency?: string; pay_back?: string; company_name?: string; reason?: string;
    kind?: string; register_tenant_id?: string; company_tenant_id?: string;
    closed_at?: string; categories?: string[];
    // 134's papers. Every figure arrives as the text the proposer's own function printed, so a
    // signature can disagree with its paper only by the paper's own digits, not by jsonb rounding.
    hold_id?: string; payout_id?: string; batch_id?: string; subject_kind?: string;
    subject_ref?: string; discharge_kind?: string; to_payee?: string; back_to_payer?: string;
    fee_amount?: string; payer_holder?: string; payee_holder?: string; plan_note?: string;
    payee?: string; payee_kind?: string; rail?: string; rail_code?: string; rail_family?: string;
    payee_ref_tail?: string; total_out?: string; source_kind?: string; source_ref?: string;
    purpose?: string; raised_by_name?: string; label?: string; lines?: number;
    fee_total?: string; total_amount?: string;
    pays?: { ref?: string; payee?: string; amount?: string; fee?: string; rail?: string }[] };
  payload_sha256: string;
  proposed_name: string | null; proposed_role: string | null; proposed_at: string;
  decided_name: string | null; decided_role: string | null;
  decided_note: string | null; decided_at: string | null;
  applied_at: string | null;
  result: { action_id?: string; new_status?: string; sessions_revoked?: number | null;
    request_id?: string; ref?: string; amount?: string; currency?: string;
    pay_back?: string; request_status?: string;
    reached?: Record<string, number>; kept?: { key: string; label: string; rows: number }[];
    target_kind?: string; payout_id?: string; batch_id?: string; hold_id?: string;
    payee?: string; fee_amount?: string; lines?: number; accrued?: number; posting?: string;
    discharge_kind?: string; to_payee?: string; back_to_payer?: string; subject_ref?: string } | null;
  expires_at: string;
}
interface Counts {
  pending: number; approved: number; applied: number;
  rejected: number; lapsed: number; total: number;
}
/** The answer to a signature that was spent: what the company is now, and who was told. */
interface Applied {
  action_id: string; action: string; tenant_name: string;
  prior_status: string; new_status: string; closed: boolean;
  seats_licensed: number | null; sessions_revoked?: number;
  reason_code: string; note: string; approval_id: string;
  delivery?: {
    subject?: string; recipients?: number;
    sms?: { sent: number; failed: number }; email?: { sent: number; failed: number };
    errors?: string[]; sent_at?: string;
  };
}
/** The answer to a spent refund signature. `released` is the office agreeing to pay, not a
 *  payment: the money leaves with #344's ledger, and saying so here is the whole honesty of
 *  this panel. */
interface SpentRefund {
  request_id: string; ref: string; amount: string; currency: string; pay_back: string;
  ticket_ref?: string; company_name: string; request_status: string;
  approval_id: string; raised_by?: string; released_by?: string;
}
/**
 * The answer to a spent erasure signature: what the mask reached and what it left, counted inside
 * the transaction that ran it. `reached` is keyed by category and `kept` is the register's own
 * list of the twelve things an erasure cannot touch, so the desk that signed reads the same
 * numbers the Customers desk reads back off the paper.
 */
interface SpentErasure {
  request_id: string; ref: string; company_tenant_id: string;
  categories: string[]; reached: Record<string, number>;
  kept: { key: string; label: string; rows: number }[];
  request_status: string; erased_by: string; erased_name?: string;
  approval_id: string; payload_sha256?: string;
}

/**
 * The answer to a spent money signature. A payout that has been accrued is not a payout that has
 * been paid — 134 books the obligation on this signature and answers the cash later, on the day it
 * actually goes, through its own door — so this panel's whole job is to say which of the two
 * happened. A batch answers with one posting per line, keyed by the line's own ref, and a single
 * payout or a discharge with one movement.
 */
interface SpentMoney {
  approval_id: string; ref?: string; target_kind?: string;
  payout_id?: string; batch_id?: string; hold_id?: string;
  payee?: string; payee_id?: string; amount?: string; fee_amount?: string; currency?: string;
  source_kind?: string; source_id?: string;
  label?: string; total_amount?: string; lines?: number; accrued?: number;
  postings?: Record<string, string>;
  subject_kind?: string; subject_ref?: string; discharge_kind?: string;
  to_payee?: string; back_to_payer?: string; payee_wallet_id?: string;
  posting?: { ref?: string; id?: string };
  raised_by?: string; released_by?: string; discharged_by?: string;
}

const ACTIONS: [string, string][] = [
  ["", "Any act"], ["tenant.block", "A proposed block"], ["tenant.close", "A proposed close"],
  ["service.refund", "A proposed refund"], ["customer.erase", "A proposed erasure"],
  ["money.payout", "A proposed payout"], ["money.escrow", "A proposed escrow plan"]
];
const TABS: [string, string][] = [
  ["pending", "Waiting"], ["applied", "Done"], ["rejected", "Refused"],
  ["lapsed", "Lapsed"], ["all", "Everything"]
];
const actionLabel = (a: string) => ACTIONS.find(([v]) => v === a)?.[1] ?? a;
const reasonLabel = (k?: string) => ({
  terms_violation: "breach of the WAISHA terms", long_idle: "no paid licence for a long time",
  payment_default: "unpaid subscription", abuse: "misuse of the platform",
  complaint: "a complaint against this company", security: "a security concern", other: "another decision"
} as Record<string, string>)[k ?? ""] ?? (k ?? "—");
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const seat = (name: string | null, role: string | null) =>
  name ? `${name}${role ? ` (${role})` : ""}` : (role ?? "a platform seat");
/** A figure as the office writes it. Money payloads carry text, not jsonb numbers. */
const fig = (v?: string | number | null) =>
  v === undefined || v === null || v === "" ? "—" : new Intl.NumberFormat("en-GB").format(Number(v));
const isRefund = (r: ApprovalRow) => r.action === "service.refund";
/** An erasure is a third act on the same board: it names no company state and no figure, but a
 *  list of categories the mask will blank out. Its target is a `data_request`, so the board's
 *  `target_name` is the uuid behind the paper — and nobody signs a uuid. */
const isErase = (r: ApprovalRow) => r.action === "customer.erase";
/**
 * 134's two signatures ride this same register: a payout is accrued by a released signature and a
 * hold is discharged by one. Both are raised by the money doors themselves, which read the payee,
 * the rail, the figure, the fee and the payee line's hash out of the paper and hash what they read —
 * so the row's payload is the paper, and the sentence below is what a second seat is signing.
 */
const isMoney = (r: ApprovalRow) => r.action === "money.payout" || r.action === "money.escrow";
const isHold = (r: ApprovalRow) => r.action === "money.escrow";
/** A batch is one signature over many papers, so it says how many before it says anything else. */
const isBatch = (r: ApprovalRow) => r.action === "money.payout" && r.target_kind === "payout_batch";
const isPayout = (r: ApprovalRow) => r.action === "money.payout" && !isBatch(r);
/** What the row is about, said the way a seat can act on it. A refund paper's target_name is
 *  the uuid behind the request, and no one signs a uuid — the armed tap and the export both
 *  have to carry the ref the caller was quoted. */
const subject = (r: ApprovalRow) =>
  isRefund(r) || isErase(r) || isMoney(r) ? r.payload?.ref ?? r.target_name : r.target_name;
/** The rows on the board whose subject is a paper rather than a company. */
const isPaper = (r: ApprovalRow) => isRefund(r) || isErase(r) || isMoney(r);
/** The words that follow a paper's ref on the row's first line. A refund or an erasure is about the
 *  caller's company; a payout is about who it pays and how the money travels; a batch is about how
 *  many papers one signature covers; a hold is about whose wallet the money is waiting on. */
const about = (r: ApprovalRow) =>
  isHold(r) ? `${r.payload?.payee_holder ?? "a waiting payee"} · held against `
    + `${r.payload?.subject_kind ?? "a job"}`
    : isBatch(r) ? `${r.payload?.lines ?? "?"} line(s) · ${r.payload?.label ?? "a batch"}`
      : isPayout(r) ? `${r.payload?.payee ?? "a payee"} · `
        + `${r.payload?.rail ?? r.payload?.rail_code ?? "a rail"}`
        : r.payload?.company_name ?? "a caller";

/**
 * What the money signature actually buys, read off the hashed payload rather than typed into this
 * page. The three figures of a plan add up to the money parked — that is the CHECK on the paper and
 * the comparison the discharge door replays — and a payout sentence is an accrual, never a payment.
 */
function moneyWords(r: ApprovalRow): string {
  const p = r.payload ?? {};
  if (isHold(r)) {
    return `The plan ${p.discharge_kind === "refunded" ? "puts the money back on the payer"
      : p.discharge_kind === "split" ? "splits the money"
        : "releases the money to the payee"}: ${fig(p.to_payee)} to `
      + `${p.payee_holder ?? "the payee's wallet"}, ${fig(p.back_to_payer)} back to `
      + `${p.payer_holder ?? "the payer"}, ${fig(p.fee_amount)} kept by the office — out of `
      + `${fig(p.amount)} ${p.currency ?? ""} held against ${p.subject_kind ?? "a job"}`
      + `${p.subject_ref ? ` ${p.subject_ref}` : ""}. The three figures add up to the money parked, `
      + "and the door re-reads them, the wallets and the plan before it cuts a leg.";
  }
  if (isBatch(r)) {
    const pays = (p.pays ?? []).map(x =>
      `${x.ref ?? "a line"} ${x.payee ?? "—"} ${fig(x.amount)}${x.fee && x.fee !== "0.00" ? ` + ${fig(x.fee)} fee` : ""}`)
      .join(" · ");
    return `One signature accrues ${p.lines ?? "?"} line(s) under “${p.label ?? "this batch"}” `
      + `totalling ${fig(p.total_amount)} ${p.currency ?? ""}, with ${fig(p.fee_total)} of fees on top`
      + `${pays ? `: ${pays}` : ""}. The batch is stamped released before its lines, because each `
      + "line's own guard asks the batch what state its signature is in.";
  }
  return `Accrues ${fig(p.amount)} ${p.currency ?? ""} to ${p.payee ?? "a payee"}`
    + ` (${p.payee_kind ?? "a holder"}) on ${p.rail ?? p.rail_code ?? "a rail"}`
    + `${p.payee_ref_tail ? `, account ending ${p.payee_ref_tail}` : ""} — the office keeps `
    + `${fig(p.fee_amount)} of fee, so ${fig(p.total_out)} leaves its fund in total`
    + `${p.source_kind ? `, standing on ${p.source_kind}${p.source_ref ? ` ${p.source_ref}` : ""}` : ""}.`
    + " This is the obligation being booked, not the cash being sent: the day it goes, a seat"
    + " answers it on the ledger desk and the book takes its second movement.";
}

/** The list a signature is spent against, read off the payload the proposer's own function hashed. */
const categoryList = (c?: string[]) =>
  !c || c.length === 0 ? "no category was named" : c.map(categoryWord).join(", ");

/** One line for the receipt: what each category gave up, then the two totals the mask counted in
 *  the same transaction that wrote the answer. Both the body this desk is handed after a signature
 *  and the fields the register kept on the row call the second list `kept`, so a receipt that adds
 *  up to nothing is this page reading the wrong key, not a mask that left nothing behind. */
function erasureWords(e: { reached?: Record<string, number> | null;
  kept?: { rows: number }[] | null }): string {
  const per = Object.entries(e.reached ?? {})
    .map(([k, v]) => `${categoryWord(k)} — ${Number(v || 0)} row(s)`).join(" · ");
  const reached = Object.values(e.reached ?? {}).reduce((a, b) => a + Number(b || 0), 0);
  const kept = (e.kept ?? []).reduce((a, b) => a + Number(b?.rows || 0), 0);
  return `${per || "the mask reached no row"} — ${reached} row(s) blanked, and ${kept} row(s) the `
    + "register holds that an erasure cannot reach";
}

/** What a spent money signature left behind, read off the result the register wrote in the same
 *  transaction that spent it. A payout accrual is not a payment and a discharge is only as good as
 *  the plan it replayed, so the line has to name the movement and keep saying which of the two it is.
 *  A batch has one movement per line, so it counts them instead of quoting a ref. */
function appliedMoneyWords(r: ApprovalRow): string {
  const e = r.result ?? {};
  const ref = e.ref ?? r.payload?.ref ?? "the paper";
  if (isHold(r)) {
    return `${ref} discharged as ${e.discharge_kind ?? "the plan named"} — ${fig(e.to_payee)} to the `
      + `payee, ${fig(e.back_to_payer)} back to the payer, ${fig(e.fee_amount)} kept by the office`
      + `${e.posting ? `, movement ${e.posting}` : ""}`;
  }
  return `${ref} accrued${e.amount ? ` · ${fig(e.amount)} ${e.currency ?? ""}` : ""}`
    + (isBatch(r) ? ` · ${e.accrued ?? 0} of ${e.lines ?? "?"} line(s) booked` : "")
    + " — the obligation is in the book, and the cash is answered on the ledger desk the day it goes"
    + `${e.posting ? `, movement ${e.posting}` : ""}`;
}

/**
 * What the desk is told the moment its money signature is spent. The receipt names the movement the
 * book cut, and a payout panel has to keep saying that an accrual is not a payment: 134 books the
 * obligation here and answers the cash in a second posting on the day it goes, and a desk that reads
 * this line as "paid" is the desk that pays the same paper twice.
 */
function MoneySpent({ e }: { e: SpentMoney }) {
  const hold = !!e.hold_id;
  const batch = !!e.batch_id;
  const postings = Object.keys(e.postings ?? {}).length;
  return (
    <div role="status" className="mb-16 rounded-input px-12 py-8 text-sm"
      style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)",
        borderLeft: "4px solid var(--success)", color: "var(--ink)" }}>
      <p className="text-xs font-semibold uppercase tracking-[0.12em]">
        {hold ? "Signed and discharged" : "Signed and accrued"} · {e.ref ?? "the paper"} ·{" "}
        {hold ? (e.discharge_kind ?? "the plan named")
          : batch ? `${e.accrued ?? 0} of ${e.lines ?? "?"} line(s)` : e.payee ?? "one payee"}
      </p>
      <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
        {hold
          ? <>{fig(e.to_payee)} to the payee, {fig(e.back_to_payer)} back to the payer and{" "}
            {fig(e.fee_amount)} kept by the office, out of {fig(e.amount)} {e.currency ?? ""} held
            against {e.subject_kind ?? "a job"}{e.subject_ref ? ` ${e.subject_ref}` : ""}
            {e.posting?.ref ? ` · movement ${e.posting.ref}` : ""}.</>
          : <>{fig(e.amount ?? e.total_amount)} {e.currency ?? ""}{" "}
            {batch ? `across ${e.lines ?? 0} line(s) under “${e.label ?? "this batch"}”`
              : `owed to ${e.payee ?? "a payee"}`} has been accrued in the book
            {e.posting?.ref ? ` — movement ${e.posting.ref}`
              : postings ? ` — ${postings} movements, one per line` : ""}
            {e.source_kind ? `, standing on ${e.source_kind}` : ""}.</>}
      </p>
      <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
        {hold
          ? <>The money left escrow the moment this signature was spent. Read the paper back on the{" "}
            <Link href="/control/money" className="underline"
              style={{ color: "var(--adm-accent)" }}>Escrow holds</Link> panel.</>
          : <>Nothing has been sent yet: the cash is confirmed on the{" "}
            <Link href="/control/money" className="underline"
              style={{ color: "var(--adm-accent)" }}>Payouts</Link> panel on the day it goes, and the
            book takes its second movement then. No payee is emailed about a signature.</>}
      </p>
    </div>
  );
}

/** Left as it was, or already shut? The badge has to answer without reading the sentence. */function statusTone(s: string) {
  return s === "pending" ? "var(--warning)"
    : s === "applied" ? "var(--danger)"
    : s === "rejected" ? "var(--ink-soft)"
    : s === "lapsed" ? "var(--ink-soft)" : "var(--adm-accent)";
}

export default function ApprovalsPage() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [status, setStatus] = useState("pending");
  const [action, setAction] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canDecide, setCanDecide] = useState<boolean | null>(null);
  const [csvNote, setCsvNote] = useState<string | null>(null);
  const [sign, setSign] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState<Applied | null>(null);
  const [spentRefund, setSpentRefund] = useState<SpentRefund | null>(null);
  const [spentErasure, setSpentErasure] = useState<SpentErasure | null>(null);
  const [spentMoney, setSpentMoney] = useState<SpentMoney | null>(null);

  const LIMIT = 30;

  const load = useCallback(async (s: string, a: string, search: string, off: number) => {
    setLoading(true);
    setCsvNote(null);
    try {
      const p = new URLSearchParams({ status: s, limit: String(LIMIT), offset: String(off) });
      if (a) p.set("action", a);
      if (search.trim()) p.set("q", search.trim());
      const res = await fetch(`${API}/api/v1/control/approvals?${p}`, { credentials: "include" });
      if (res.status === 401 || res.status === 403) { window.location.href = "/control/login"; return; }
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j?.error?.message ?? "The register could not be read.");
        setRows([]); setCounts(null);
        return;
      }
      const j = await res.json();
      setRows((j.rows ?? []) as ApprovalRow[]);
      setCounts((j.counts ?? null) as Counts | null);
      setError(null);
    } finally { setLoading(false); }
  }, []);

  /** Whether this seat holds the duty that spends a signature. A probe that never answered is not
   *  the same fact as a seat that was read and found to lack the duty, and the desk says different
   *  things about the two — so the answer is kept as three states, not one. */
  const probeDuty = useCallback(async () => {
    try {
      const a = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (!a.ok) { setCanDecide(null); return; }
      const j = await a.json();
      setCanDecide((j.permissions ?? []).includes("control.approvals.decide"));
    } catch { setCanDecide(null); }
  }, []);

  useEffect(() => { probeDuty(); }, [probeDuty]);

  useEffect(() => { load(status, action, q, offset); }, [status, action, q, offset, load]);

  function openRow(id: string) {
    setSign(sign === id ? null : id); setNote(""); setArmed(null);
    setSpent(null); setSpentRefund(null); setSpentErasure(null); setSpentMoney(null);
  }

  /**
   * Sign, or refuse. One call either way, and the difference is which button was pressed
   * inside the same panel — a desk that has to find a different endpoint to say "no" is a
   * desk that will eventually say "yes" by accident.
   *
   * Approving is not a note on a form: the definer applies the ban in the same transaction
   * that spends the signature, so this is the press that shuts a company out and the reason
   * the second tap is armed. A refund paper is released by the same press, and an erasure is
   * run by it — the mask has no undo, and no second desk to correct it from.
   */
  async function decide(row: ApprovalRow, decision: "approve" | "reject") {
    setBusy(true); setError(null);
    setSpent(null); setSpentRefund(null); setSpentErasure(null); setSpentMoney(null);
    try {
      const res = await fetch(`${API}/api/v1/control/approvals/${row.id}/${decision}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ note: note.trim() })
      });
      const j = await res.json().catch(() => ({}));
      await load(status, action, q, offset);
      setArmed(null);
      if (!res.ok) {
        // A seat signing its own proposal is refused by the definer with its own status, and
        // the answer has to name what to do about it rather than read as a broken button.
        setError(j?.error?.message ?? (decision === "approve"
          ? "The signature did not land. Nothing was changed."
          : "The refusal did not land."));
        if (res.status === 403 || res.status === 409 || res.status === 410) {
          setSign(null); setNote("");
        }
        return;
      }
      if (decision === "approve") {
        if (row.action === "service.refund") setSpentRefund(j as SpentRefund);
        else if (row.action === "customer.erase") setSpentErasure(j as SpentErasure);
        // Both of 134's effects answer with their own receipt — a payout names the paper it accrued
        // and the movement it cut, a discharge replays the three figures the plan promised — and
        // neither is the ban's shape. Reading one as the other would sign money and show a blank.
        else if (row.action === "money.payout" || row.action === "money.escrow")
          setSpentMoney(j as SpentMoney);
        else setSpent(j as Applied);
        setNote("");
      } else {
        setSign(null);
      }
    } finally { setBusy(false); }
  }

  const twoTap = (key: string, run: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    run();
  };

  // The board as the office keeps it: one line per proposal, quoted out for the file that
  // has to show why a company was shut. The read is already gated on the duty that lets a
  // seat see these rows at all, so a download of what is on screen adds no authority.
  function exportCsv() {
    const head = ["raised_at", "act", "company", "reason_for_the_office", "note_to_the_company",
      "payload_sha256", "raised_by", "status", "signed_by", "signed_note", "signed_at", "applied_at"];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = rows.map(r => [r.proposed_at, r.action, subject(r), r.reason,
      r.payload?.note, r.payload_sha256, seat(r.proposed_name, r.proposed_role),
      r.approval_status, seat(r.decided_name, r.decided_role), r.decided_note,
      r.decided_at, r.applied_at].map(cell).join(","));
    const blob = new Blob([[head.map(cell).join(","), ...body].join("\n")],
      { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `waisha-approvals-${status}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setCsvNote(`Saved ${rows.length} row${rows.length === 1 ? "" : "s"} of this screen.`);
  }

  const countFor = (tab: string): number | null =>
    counts && tab !== "all" ? counts[tab as keyof Counts] : null;

  const total = counts?.total ?? 0;
  const shown = rows.length;

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Approvals · two seats for one act
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1080px] px-16 py-32">
        <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Approvals</h1>
        <p className="mt-8 mb-16 text-sm" style={{ color: "var(--ink-soft)" }}>
          A ban is proposed by one platform seat and applied by another. Nothing on this page has happened
          to a company until a second seat signs it: signing a block or a close shuts the door in the same
          call, tells the company&apos;s directors by SMS and email, and writes both names on the
          company&apos;s register. A refund paper is raised on the <Link href="/control/service"
            className="underline" style={{ color: "var(--adm-accent)" }}>Service desk</Link> and signed
          here, and the figure the second seat signs is read out of the paper, not typed into this page.
          An erasure paper is raised on the <Link href="/control/customers"
            className="underline" style={{ color: "var(--adm-accent)" }}>Customers desk</Link>, and signing
          it runs the mask in this same call — the categories on the row below are what the register blanks
          out, and there is no undo and no notice to the caller, because the paper itself is the answer.
          Two money papers arrive from the <Link href="/control/money"
            className="underline" style={{ color: "var(--adm-accent)" }}>ledger desk</Link>: a payout and a
          plan for a hold. Signing a payout <span className="font-semibold"
            style={{ color: "var(--ink)" }}>accrues the obligation</span> into the double-entry book and
          sends nothing — the cash is confirmed by its own door on the day it goes, and the book takes its
          second movement then — while signing a plan moves the money out of escrow in this same call. The
          figures, the rail and the payee are read out of the paper the proposing door wrote and hashed,
          and this page shows the last digits of a payee&apos;s account number, never the whole of it. The
          seat that raised a proposal cannot sign it, and a proposal nobody signs lapses after a week.
        </p>

        {counts && (
          <p className="mb-16 text-xs" style={{ color: "var(--ink-soft)" }}>
            <span className="font-bold" style={{ color: statusTone("pending") }}>
              {counts.pending} waiting
            </span>
            {" "}· {counts.applied} applied · {counts.rejected} refused · {counts.lapsed} lapsed
            {" "}· {counts.approved} signed but not spent
          </p>
        )}

        {error && (
          <div role="alert" className="mb-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
              borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
            {error}
          </div>
        )}
        {spent && (
          <div role="status" className="mb-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)",
              borderLeft: "4px solid var(--success)", color: "var(--ink)" }}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em]">
              Signed and applied · {spent.action} · {spent.prior_status} → {spent.new_status}
              {spent.sessions_revoked ? ` · ${spent.sessions_revoked} sessions revoked` : ""}
            </p>
            <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
              {spent.tenant_name} · register row {spent.action_id} ·{" "}
              {spent.delivery
                ? `told ${(spent.delivery.sms?.sent ?? 0) + (spent.delivery.email?.sent ?? 0)} of `
                  + `${spent.delivery.recipients ?? 0} directors`
                  + `${spent.delivery.errors?.length ? ` · ${spent.delivery.errors.join("; ")}` : ""}`
                : "no delivery receipt"}
            </p>
          </div>
        )}

        {spentRefund && (
          <div role="status" className="mb-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)",
              borderLeft: "4px solid var(--success)", color: "var(--ink)" }}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em]">
              Signed and released · {spentRefund.ref} · {spentRefund.request_status}
            </p>
            <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
              {spentRefund.company_name} · {new Intl.NumberFormat("en-GB").format(Number(spentRefund.amount))} {spentRefund.currency} by {spentRefund.pay_back} ·{" "}
              the paper is agreed, not paid — the payment itself is settled from the{" "}
              <Link href="/control/service" className="underline"
                style={{ color: "var(--adm-accent)" }}>Service desk</Link>.
            </p>
          </div>
        )}

        {spentErasure && (
          <div role="status" className="mb-16 rounded-input px-12 py-8 text-sm"
            style={{ background: "color-mix(in srgb, var(--gold) 12%, transparent)",
              borderLeft: "4px solid var(--gold)", color: "var(--ink)" }}>
            <p className="text-xs font-semibold uppercase tracking-[0.12em]">
              Signed and masked · {spentErasure.ref} · {spentErasure.request_status}
            </p>
            <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
              {erasureWords(spentErasure)}
            </p>
            <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              Read it back on the{" "}
              <Link href="/control/customers" className="underline"
                style={{ color: "var(--adm-accent)" }}>Customers desk</Link>. Nobody is emailed that their
              data went: the paper on the register is the answer, and the mask has no undo.
            </p>
          </div>
        )}

        {spentMoney && <MoneySpent e={spentMoney} />}

        <div className="mb-16 flex flex-wrap items-center gap-8">
          {TABS.map(([v, l]) => (
            <button key={v} type="button" onClick={() => { setOffset(0); setStatus(v); setSign(null); }}
              className="rounded-input border px-16 py-8 text-xs font-semibold"
              style={status === v
                ? { borderColor: "var(--adm-accent)", color: "var(--ink)",
                  background: "color-mix(in srgb, var(--adm-accent) 14%, transparent)" }
                : { borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              {l}
              {counts && countFor(v) !== null && (
                <span className="ml-8 tabular-nums">{countFor(v)}</span>
              )}
            </button>
          ))}
          <button type="button" onClick={exportCsv} disabled={rows.length === 0}
            className="ml-auto rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-40"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
            Export this screen (CSV)
          </button>
        </div>

        {csvNote && (
          <p role="status" className="-mt-8 mb-16 text-xs" style={{ color: "var(--success)" }}>{csvNote}</p>
        )}

        <div className="mb-16 flex flex-wrap gap-12">
          <input value={q} onChange={e => { setQ(e.target.value); setOffset(0); }}
            placeholder="Search the reason, the note or the company" aria-label="Search proposals"
            className="min-w-[240px] flex-1 rounded-input border px-12 py-8 text-sm"
            style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
          <select value={action} onChange={e => { setAction(e.target.value); setOffset(0); }}
            aria-label="Filter by act" className="rounded-input border px-12 py-8 text-sm"
            style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
            {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>

        {loading && (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }} role="status">Reading the register…</p>
        )}
        {!loading && rows.length === 0 && (
          <div className="rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
            <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
              {status === "pending" ? "Nothing is waiting for a signature."
                : "No proposals match this filter."}
            </p>
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              {status === "pending"
                ? <>A ban raised on the <Link href="/control/tenants" className="underline"
                  style={{ color: "var(--adm-accent)" }}>Tenants</Link> desk, a refund raised on the{" "}
                  <Link href="/control/service" className="underline"
                    style={{ color: "var(--adm-accent)" }}>Service</Link> desk, an erasure raised on the{" "}
                  <Link href="/control/customers" className="underline"
                    style={{ color: "var(--adm-accent)" }}>Customers</Link> desk and a payout or an escrow
                  plan raised on the{" "}
                  <Link href="/control/money" className="underline"
                    style={{ color: "var(--adm-accent)" }}>ledger desk</Link> all appear here the moment
                  they are proposed, and stay until a second seat signs them or a week passes.</>
                : "Try Everything, or widen the search."}
            </p>
          </div>
        )}

        {rows.map(r => {
          const mine = sign === r.id;
          const waiting = r.approval_status === "pending";
          // A refund paper is a different act on the same register: it names a figure and a
          // call rather than a company and a notice, and the sentence beside it has to say
          // what is being signed instead of borrowing the ban's words. An erasure is a third:
          // it names a list of categories and blanks them, and no one is told it happened.
          const refund = isRefund(r);
          const erase = isErase(r);
          const money = isMoney(r);
          const figure = r.payload?.amount ? `${fig(r.payload.amount)} ${r.payload.currency ?? ""}` : null;
          const lapsedAt = new Date(r.expires_at).getTime() - Date.now();
          return (
            <section key={r.id} className="mb-16 rounded-card border p-16"
              style={{ borderColor: waiting ? statusTone(r.approval_status) : "var(--line)",
                background: "var(--surface)" }}>
              <div className="flex flex-wrap items-start justify-between gap-12">
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-8 text-base font-bold" style={{ color: "var(--ink)" }}>
                    <span className="rounded-full px-8 py-2 text-[10px] font-bold uppercase tracking-[0.1em]"
                      style={{ background: statusTone(r.approval_status), color: "var(--brand-deep)" }}>
                      {r.approval_status}
                    </span>
                    {actionLabel(r.action)}
                  </h2>
                  <p className="mt-8 break-words text-sm font-semibold" style={{ color: "var(--ink)" }}>
                    {isPaper(r) && r.payload?.ref
                      ? `${r.payload.ref} · ${about(r)}`
                      : r.target_name}
                  </p>
                  <p className="mt-4 text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                    {r.target_kind} · {r.target_id}
                  </p>
                  {erase && (
                    <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
                      The mask blanks {categoryList(r.payload?.categories)}.
                      <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        {r.payload?.closed_at
                          ? `the account was shut ${new Date(r.payload.closed_at).toLocaleDateString("en-GB", { dateStyle: "medium" })}`
                          : "this account is not shut — the register will refuse the mask"}
                      </span>
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    raised {when(r.proposed_at)}
                  </p>
                  <p className="mt-4 text-xs font-semibold" style={{ color: "var(--ink)" }}>
                    by {seat(r.proposed_name, r.proposed_role)}
                  </p>
                  {waiting && (
                    <p className="mt-4 text-[10px] tabular-nums"
                      style={{ color: lapsedAt < 0 ? "var(--danger)" : "var(--ink-soft)" }}>
                      {lapsedAt < 0 ? "expires on the next read"
                        : `lapses in ${Math.ceil(lapsedAt / 86_400_000)} day(s)`}
                    </p>
                  )}
                </div>
              </div>

              <p className="mt-12 text-sm" style={{ color: "var(--ink)" }}>{r.reason}</p>
              {/* Whether the company has been told is a fact the signature changed. A row
                  still waiting describes a notice that has not happened; an applied row has
                  already sent one, and this desk cannot see whether it arrived — only the
                  company's own register carries the receipt. A refund paper is never sent
                  anywhere: the paper is the record, and the money is paid from it. */}
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                {money
                  ? <>{moneyWords(r)} Read the paper back on the{" "}
                    <Link href="/control/money" className="underline"
                      style={{ color: "var(--adm-accent)" }}>ledger desk</Link> — nothing is messaged or
                    emailed to a payee about a signature, so the register row is the answer here too.</>
                  : erase
                  ? <>Nothing is posted, messaged or emailed about this act: the paper on the{" "}
                    <Link href="/control/customers" className="underline"
                      style={{ color: "var(--adm-accent)" }}>Customers register</Link> is the answer the
                    caller is owed, and what the mask left behind is counted there. The categories above are
                    read out of the hashed payload the proposer&apos;s own function wrote, not typed into
                    this page.</>
                  : refund
                    ? <>The paper asks to pay <span className="font-semibold"
                      style={{ color: "var(--ink)" }}>{figure ?? "a figure"}</span> back by{" "}
                      <span className="font-semibold" style={{ color: "var(--ink)" }}>
                        {r.payload?.pay_back ?? "the channel on the paper"}
                      </span>{" "}
                      {r.payload?.ticket_ref ? `on the call ${r.payload.ticket_ref}` : ""}
                      {r.payload?.reason ? ` — “${r.payload.reason}”` : ""}.</>
                    : r.approval_status === "applied"
                      ? <>The note that went with the effect: {r.payload?.note || "—"} — whether it
                        reached anyone is on{" "}
                        <Link href="/control/tenants" className="underline"
                          style={{ color: "var(--adm-accent)" }}>the company's register</Link>.</>
                      : r.approval_status === "pending" || r.approval_status === "approved"
                        ? `The company would be told: ${r.payload?.note || "—"}`
                        : `Never sent. The note would have read: ${r.payload?.note || "—"}`}
              </p>
              {/* The reason code is the ban's vocabulary, and 134's hold reuses it for a different
                  question — why the money was stopped rather than why a company is being shut — so
                  the line says which of the two it is answering. A payout paper carries no code at
                  all, and "For —" is not a reason a seat can sign against. */}
              {r.payload?.reason_code && (!isPaper(r) || isHold(r)) && (
                <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {isHold(r) ? "The money was stopped for " : "For "}
                  {reasonLabel(r.payload.reason_code)}
                </p>
              )}
              <p className="mt-8 break-all font-mono text-[10px]" style={{ color: "var(--ink-soft)" }}>
                sha256 {r.payload_sha256}
              </p>

              {r.decided_at && (
                <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
                  {r.approval_status === "rejected" ? "Refused" : "Signed"} by{" "}
                  {seat(r.decided_name, r.decided_role)} · {when(r.decided_at)}
                  {r.decided_note ? ` — “${r.decided_note}”` : ""}
                </p>
              )}
              {r.applied_at && (
                <p className="mt-4 text-xs" style={{ color: "var(--danger)" }}>
                  Applied {when(r.applied_at)}
                  {r.result?.new_status ? ` · company is now ${r.result.new_status}` : ""}
                  {r.result?.sessions_revoked ? ` · ${r.result.sessions_revoked} sessions revoked` : ""}
                  {money ? ` · ${appliedMoneyWords(r)}`
                    : r.result?.request_status && erase
                      ? ` · ${r.result.ref ?? "the paper"} is now ${r.result.request_status} — `
                        + erasureWords({ reached: r.result.reached, kept: r.result.kept })
                      : r.result?.request_status
                        ? ` · paper ${r.result.ref ?? r.result.request_id} is now ${r.result.request_status}`
                          + ` — the office has agreed to pay it, not paid it`
                        : ""}
                </p>
              )}

              {waiting && canDecide === false && (
                <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                  Your seat can read this register but not sign it. Ask a platform seat that can sign a
                  ban — the same duty signs a refund, an erasure or a money paper. A payout needs{" "}
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>
                    control.money.pay</span> and a plan for a hold needs{" "}
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>
                    control.money.escrow</span>, and the seat that raised one of those papers cannot
                  sign it.
                </p>
              )}

              {waiting && canDecide === null && !loading && (
                <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                  The duties this seat holds could not be read, so this desk will not offer a signature
                  it cannot check.
                  {" "}<button type="button" onClick={() => probeDuty()}
                    className="font-semibold underline" style={{ color: "var(--adm-accent)" }}>
                    Read them again
                  </button>
                </p>
              )}

              {waiting && canDecide && !mine && (
                <button type="button" onClick={() => openRow(r.id)}
                  className="mt-12 rounded-input border px-16 py-10 text-xs font-semibold"
                  style={{ borderColor: "var(--adm-accent)", color: "var(--ink)" }}>
                  {refund ? "Sign or refuse this refund"
                    : erase ? "Sign or refuse this erasure"
                      : isHold(r) ? "Sign or refuse this plan"
                        : money ? "Sign or refuse this payout"
                          : r.action === "tenant.close" ? "Sign or refuse this close"
                            : "Sign or refuse this block"}
                </button>
              )}

              {waiting && canDecide && mine && (
                <div className="mt-12 rounded-input border p-12" style={{ borderColor: "var(--line)" }}>
                  <label className="block">
                    <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]"
                      style={{ color: "var(--ink-soft)" }}>
                      Your line on it (4–400 characters) — it is kept with both names
                    </span>
                    <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
                      placeholder="What you checked before signing." aria-label="Signature note"
                      className="w-full rounded-input border px-12 py-8 text-sm"
                      style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }} />
                    <span className="mt-2 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      {note.trim().length}/400
                    </span>
                  </label>
                  <div className="mt-12 flex flex-wrap gap-8">
                    <button type="button" disabled={busy || note.trim().length < 4}
                      onClick={twoTap(`sign-${r.id}`, () => decide(r, "approve"))}
                      className="rounded-input border px-16 py-10 text-xs font-semibold disabled:opacity-40"
                      style={armed === `sign-${r.id}`
                        ? { borderColor: "var(--danger)",
                          background: "color-mix(in srgb, var(--danger) 14%, transparent)", color: "var(--ink)" }
                        : { borderColor: "var(--danger)", color: "var(--ink)" }}>
                      {armed === `sign-${r.id}`
                        ? `Tap again to ${refund ? "release" : erase ? "mask"
                          : isHold(r) ? "discharge" : money ? "accrue"
                            : r.action === "tenant.close" ? "close" : "block"} ${subject(r)}`
                        : `Sign and ${refund ? "release the paper"
                          : erase ? "run the mask, which cannot be undone"
                            : isHold(r) ? "move the money out of escrow"
                              : money ? "accrue the obligation, not pay it"
                                : r.action === "tenant.close" ? "close the account" : "block access"}`}
                    </button>
                    <button type="button" disabled={busy || note.trim().length < 4}
                      onClick={() => decide(r, "reject")}
                      className="rounded-input border px-16 py-10 text-xs font-semibold disabled:opacity-40"
                      style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                      Refuse it
                    </button>
                    <button type="button" onClick={() => { setSign(null); setNote(""); setArmed(null); }}
                      className="rounded-input border px-16 py-10 text-xs font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      Leave it waiting
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })}

        {!loading && total > LIMIT && (
          <div className="mt-16 flex flex-wrap items-center gap-12">
            <button type="button" disabled={offset === 0}
              onClick={() => { setOffset(Math.max(0, offset - LIMIT)); setSign(null); }}
              className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-40"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
              Newer
            </button>
            <button type="button" disabled={offset + shown >= total}
              onClick={() => { setOffset(offset + LIMIT); setSign(null); }}
              className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-40"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
              Older
            </button>
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
              {offset + 1}–{offset + shown} of {total} in this filter
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
