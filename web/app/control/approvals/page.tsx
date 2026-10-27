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
    // 140–142's price papers. The figure is the text the register printed and the window is the two
    // dates on the paper, so a signature can disagree with its price only by the paper's own digits.
    // A cut nests its rung, its transaction and its wallet as objects — read through `cut()` below,
    // because a payout's `payee` is a plain name and the two must not share one declared type.
    code?: string; line_count?: number; kind_label?: string; basis?: string; value?: string;
    value_said?: string; cap?: string; min_amount?: string; max_uses?: number | null;
    version?: number; route?: string; effective_from?: string; effective_to?: string;
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
    discharge_kind?: string; to_payee?: string; back_to_payer?: string; subject_ref?: string;
    // The receipt a price signature left behind. A publish, a charge and a cut each write their own
    // ref and version, and all three say how many earlier versions of the same code they closed.
    code?: string; version?: number; basis?: string; value?: string; effective_from?: string;
    superseded_versions?: number; subject_name?: string; source_kind?: string;
    payee_name?: string; max_uses?: number | null; uses_taken?: number } | null;
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

/**
 * The answer to a spent price signature — a card, a charge or a cut. All three go live in the call
 * that spends the signature and all three close the versions they supersede in the same statement,
 * which is why the receipt counts them: a seat that publishes a second price for one code needs to
 * be told it replaced one, not that it added one. Nothing is emailed about a tariff.
 */
interface SpentPrice {
  approval_id: string; ref?: string; code?: string; version?: number; currency?: string;
  basis?: string; value?: string; effective_from?: string; superseded_versions?: number;
  published_by?: string; card_id?: string; addendum_id?: string; kind?: string;
  max_uses?: number | null; uses_taken?: number; rate_id?: string; subject_kind?: string;
  subject_name?: string; source_kind?: string; payee_kind?: string; payee_name?: string;
}

const ACTIONS: [string, string][] = [
  ["", "Any act"], ["tenant.block", "A proposed block"], ["tenant.close", "A proposed close"],
  ["service.refund", "A proposed refund"], ["customer.erase", "A proposed erasure"],
  ["money.payout", "A proposed payout"], ["money.escrow", "A proposed escrow plan"],
  ["pricing.publish", "A proposed price list"], ["pricing.addendum", "A proposed charge or code"],
  ["pricing.commission", "A proposed commission"]
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
/**
 * 140, 141 and 142 each put a signature on this same register, and all three are a price rather than
 * a ban: a freight price list, a levy or a discount code, a commission agreement. None of them names
 * a company's state or sends a letter, and each one's payload is the paper its own door hashed — so
 * every figure below is read out of those bytes, never typed into this page.
 */
const isPublish = (r: ApprovalRow) => r.action === "pricing.publish";
const isAddendum = (r: ApprovalRow) => r.action === "pricing.addendum";
const isCommission = (r: ApprovalRow) => r.action === "pricing.commission";
const isPrice = (r: ApprovalRow) => isPublish(r) || isAddendum(r) || isCommission(r);
/** A cut's paper nests the rung, the transaction and the wallet as objects, while a payout's `payee`
 *  is a plain name — so the cut is read through its own view rather than a row type that would let
 *  either of the two answer for the other. */
interface CutPaper {
  subject?: { kind?: string; name?: string; says?: string };
  source?: { kind?: string; label?: string | null; side?: string };
  payee?: { kind?: string; name?: string; says?: string };
  currency?: string | null;
  window?: { effective_from?: string; effective_to?: string | null };
  // The version is nested on a cut's paper and a plain number on a card's, so the two are read apart
  // rather than through one field that would print `[object Object]` on a signature.
  version?: { number?: number; supersedes?: string | null };
  value_said?: string; floor_amount?: string | null; cap?: string | null;
}
const cut = (r: ApprovalRow) => (r.payload ?? {}) as unknown as CutPaper;
/** A register label dropped into the middle of a sentence. `pricing_commission_sources.label` is
 *  written for the top of a picker — “A freight invoice” — and this desk quotes it inside a sentence,
 *  so the capital comes off rather than the desk inventing its own word for the transaction. */
const midSentence = (s?: string | null) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** Which side of the book a transaction sits on, in the pricing desk's words: `cuts.tsx` names the
 *  same column “money coming in” / “money going out”, and a bare `(in)` after a transaction on a
 *  signature a seat is about to spend is not a word anyone can act on. */
const cutSide = (side?: string | null) =>
  side === "in" ? "money coming in" : side === "out" ? "money going out" : undefined;
/** The transaction a cut is taken out of. A receipt carries `source_kind`, which is a key; the paper
 *  carries the label the picker was built from, so the seat that signed reads the name it chose. */
const cutSource = (c: CutPaper, key?: string) =>
  midSentence(c.source?.label ?? c.source?.kind) ?? key ?? "a transaction";
/** A least or a most, with its money beside it. The paper carries the currency the pair is kept in,
 *  and a figure printed with no money on a page that quotes two currencies is 138's defect. */
const cutBound = (v?: string | null, currency?: string | null) =>
  `${fig(v)}${currency ? ` ${currency}` : ""}`;
/** The cut's figure in the paper's own words — a percent with its fourth decimal, a flat with its
 *  money. The receipt only ever has to name the same fields back, so the fallback is what the desk
 *  says when a paper is not beside it; neither branch multiplies a percentage. */
const cutFigure = (e: { value?: string; currency?: string; basis?: string }, said?: string) => said
  ?? `${fig(e.value)}${e.currency ? ` ${e.currency}` : ""}`
    + (e.basis === "flat" ? " a flat sum" : e.basis ? " percent of the transaction" : "");
/** What the price is, in the form the paper printed it. A cut carries its own sentence; a charge
 *  carries a figure and the basis word the register knows it by; a card is its lines and its money. */
const priceFigure = (r: ApprovalRow): string => {
  const p = r.payload ?? {};
  if (isCommission(r)) return cut(r).value_said ?? `${fig(p.value)} ${p.currency ?? ""}`.trim();
  if (isAddendum(r)) {
    return `${fig(p.value)}${p.currency ? ` ${p.currency}` : ""}`
      + ` on a ${p.basis ?? "an unstated"} basis`;
  }
  return `${p.line_count ?? 0} line(s) priced in ${p.currency ?? "one money"}`;
};
/** What the row is about, said the way a seat can act on it. A refund paper's target_name is
 *  the uuid behind the request, and no one signs a uuid — the armed tap and the export both
 *  have to carry the ref the caller was quoted. */
const subject = (r: ApprovalRow) =>
  isRefund(r) || isErase(r) || isMoney(r) || isPrice(r)
    ? r.payload?.ref ?? r.target_name : r.target_name;
/** The rows on the board whose subject is a paper rather than a company. */
const isPaper = (r: ApprovalRow) => isRefund(r) || isErase(r) || isMoney(r) || isPrice(r);
/** The words that follow a paper's ref on the row's first line. A refund or an erasure is about the
 *  caller's company; a payout is about who it pays and how the money travels; a batch is about how
 *  many papers one signature covers; a hold is about whose wallet the money is waiting on; a price
 *  is about which code goes live and what it is taken on. */
const about = (r: ApprovalRow) =>
  isHold(r) ? `${r.payload?.payee_holder ?? "a waiting payee"} · held against `
    + `${r.payload?.subject_kind ?? "a job"}`
    : isBatch(r) ? `${r.payload?.lines ?? "?"} line(s) · ${r.payload?.label ?? "a batch"}`
      : isPayout(r) ? `${r.payload?.payee ?? "a payee"} · `
        + `${r.payload?.rail ?? r.payload?.rail_code ?? "a rail"}`
        : isCommission(r) ? `${cut(r).subject?.name ?? "a rung"} · `
          + `${cut(r).source?.label ?? cut(r).source?.kind ?? "a transaction"}`
          : isPrice(r) ? `${r.payload?.code ?? "a code"} · `
            + `${isPublish(r) ? `${r.payload?.line_count ?? 0} line(s)`
              : r.payload?.kind_label ?? r.payload?.kind ?? "a charge"}`
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
 * What the price signature actually puts in force, read off the hashed paper rather than typed into
 * this page. All three of 140–142's papers close the versions they supersede in the same statement
 * that publishes them, so each sentence names the code it goes live under and the day it starts — and
 * a commission adds that it changes the next transaction, never a reading already taken.
 */
function priceWords(r: ApprovalRow): string {
  const p = r.payload ?? {};
  const c = cut(r);
  const from = c.window?.effective_from ?? p.effective_from;
  const to = c.window?.effective_to ?? p.effective_to;
  const days = `in force from ${from ?? "the day it is signed"}`
    + `${to ? ` until ${to}` : " and no end written on it"}`;
  if (isPublish(r)) {
    return `Puts the price list ${p.code ?? "as drafted"} “${p.label ?? ""}” version `
      + `${p.version ?? "?"} in force — ${priceFigure(r)} — ${days}. Signing it closes every earlier `
      + "version of the same code in this same statement, because two prices in force for one code is "
      + "the answer no resolver should have to choose between.";
  }
  if (isAddendum(r)) {
    return `Puts the ${p.kind_label ?? p.kind ?? "charge"} ${p.code ?? "as drafted"}`
      + ` “${p.label ?? ""}” version ${p.version ?? "?"} in force: ${priceFigure(r)}`
      + `${p.cap ? `, never more than ${fig(p.cap)} ${p.currency ?? ""}` : ""}`
      + `${p.min_amount ? `, never less than ${fig(p.min_amount)} ${p.currency ?? ""}` : ""}`
      + `${p.route && p.route !== "any route" ? `, on ${p.route}` : ""}`
      + `${p.max_uses ? `, for at most ${p.max_uses} use(s)` : ""} — ${days}. A charge that is live `
      + "moves onto the next quote a clerk builds; nothing already priced is re-summed by a signature.";
  }
  const side = cutSide(c.source?.side);
  return `${c.subject?.says ?? `The cut agreed with ${c.subject?.name ?? "a rung"}`} — `
    + `${c.value_said ?? priceFigure(r)}`
    + `${c.floor_amount && Number(c.floor_amount) > 0
      ? `, never under ${cutBound(c.floor_amount, c.currency)}` : ""}`
    + `${c.cap ? `, never over ${cutBound(c.cap, c.currency)}` : ""} — taken out of `
    + `${cutSource(c)}${side ? `, ${side}` : ""}, kept by ${c.payee?.name ?? "the office"}`
    + `: ${c.payee?.says ?? "the office keeps it"}. Version ${c.version?.number ?? p.version ?? "?"}`
    + `${c.version?.supersedes ? ` ends ${c.version.supersedes}` : ""}, ${days}. A signature `
    + "here changes what the next transaction is worth to the office — it re-assesses no reading that "
    + "has already been taken, and the paper's own figures are what the arithmetic replays.";
}

/** What a spent price signature left on the register, read off the result written in the same
 *  transaction that spent it. The receipt has to keep saying which of the three papers went live and
 *  how many versions of its code it closed, because a seat that reads "published" as "added" will
 *  publish the same code twice. */
function appliedPriceWords(r: ApprovalRow): string {
  const e = r.result ?? {};
  const ref = e.ref ?? r.payload?.ref ?? "the paper";
  const closed = e.superseded_versions ? ` · ${e.superseded_versions} earlier version(s) closed` : "";
  if (isCommission(r)) {
    const c = cut(r);
    return `${ref} v${e.version ?? c.version?.number ?? "?"} is in force on `
      + `${e.subject_name ?? c.subject?.name ?? "its rung"} against ${cutSource(c, e.source_kind)}`
      + `: ${cutFigure(e, c.value_said)}`
      + `, kept by ${e.payee_name ?? c.payee?.name ?? "the office"}, `
      + `from ${e.effective_from ?? "—"}${closed}. `
      + "No reading already taken was re-assessed by it.";
  }
  if (isAddendum(r)) {
    return `${ref} v${e.version ?? r.payload?.version ?? "?"} in force: ${fig(e.value)}`
      + `${e.currency ? ` ${e.currency}` : ""} on a ${e.basis ?? "—"} basis`
      + `${e.max_uses ? `, ${e.uses_taken ?? 0} of ${e.max_uses} use(s) taken` : ""}`
      + `, from ${e.effective_from ?? "—"}${closed}`;
  }
  return `${ref} v${e.version ?? r.payload?.version ?? "?"} — ${e.code ?? "its code"} priced in `
    + `${e.currency ?? "one money"}, in force from ${e.effective_from ?? "—"}${closed}`;
}

/**
 * What the desk is told the moment its price signature is spent. The paper went live in this call and
 * the register row is the only notice it gets: no director is emailed about a tariff, a levy or a
 * cut, and the pricing desk's own read-back is where the desk that signed checks it.
 */
function PriceSpent({ e, kind, paper }: { e: SpentPrice;
  kind: "publish" | "addendum" | "commission"; paper?: CutPaper }) {
  const c = paper ?? {};
  const side = cutSide(c.source?.side);
  // A card or a charge closes earlier versions of a code; a cut's chain is one rung and one
  // transaction, so its receipt names the agreement it ends by its own ref. Printing "that code" on a
  // cut would borrow a levy's vocabulary for a register row that has none.
  const older = e.code ?? (kind === "commission" ? e.ref : undefined);
  const closed = e.superseded_versions
    ? `${e.superseded_versions} earlier version${e.superseded_versions === 1 ? "" : "s"} of `
      + `${older ?? (kind === "commission" ? "that agreement" : "that code")} closed by the same signature`
    : "no earlier version of it was in force";
  const figure = `${fig(e.value)}${e.currency ? ` ${e.currency}` : ""}`;
  const head = kind === "commission" ? (e.subject_name ?? c.subject?.name ?? "its rung")
    : kind === "addendum" ? (e.code ?? "the charge") : (e.code ?? "the price list");
  const said = kind === "commission"
    ? `The cut of ${cutFigure(e, c.value_said)} is in force on ${head} against `
      + `${cutSource(c, e.source_kind)}${side ? `, ${side}` : ""}, kept by `
      + `${e.payee_name ?? c.payee?.name ?? "the office"}, from `
      + `${e.effective_from ?? "the day it was signed"} — ${closed}.`
    : kind === "addendum"
      ? `${e.code ?? "The charge"} is in force at ${figure} on a ${e.basis ?? "—"} basis`
        + `${e.max_uses ? `, ${e.uses_taken ?? 0} of ${e.max_uses} use(s) taken` : ""}, from `
        + `${e.effective_from ?? "the day it was signed"} — ${closed}.`
      : `${e.code ?? "The price list"} is in force priced in ${e.currency ?? "one money"}, from `
        + `${e.effective_from ?? "the day it was signed"} — ${closed}.`;
  return (
    <div role="status" className="mb-16 rounded-input px-12 py-8 text-sm"
      style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)",
        borderLeft: "4px solid var(--success)", color: "var(--ink)" }}>
      <p className="text-xs font-semibold uppercase tracking-[0.12em]">
        Signed and published · {e.ref ?? "the paper"} · v{e.version ?? "?"} · {head}
      </p>
      <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{said}</p>
      <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
        {kind === "commission"
          ? "Nothing was assessed by this signature: the cut is asked of the next transaction that "
            + "matches it, and a reading already taken keeps the figures it was taken at."
          : <>Nobody is emailed that a price went live — the register row and the memory lines written
            on the paper are the answer. Read it back on the{" "}
            <Link href="/control/pricing" className="underline"
              style={{ color: "var(--adm-accent)" }}>pricing desk</Link>.</>}
      </p>
    </div>
  );
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
  // The receipt carries which of the three price papers went live, because the one body shape answers
  // for a card, a charge and a cut and a panel that guesses would quote a levy as a price list. A cut
  // travels with the paper it was signed on: the receipt has `source_kind` and `value`, while the
  // label and the fourth-decimal figure the seat read only exist in the hashed payload.
  const [spentPrice, setSpentPrice] = useState<{ e: SpentPrice; paper?: CutPaper;
    kind: "publish" | "addendum" | "commission" } | null>(null);

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
    setSpent(null); setSpentRefund(null); setSpentErasure(null); setSpentMoney(null); setSpentPrice(null);
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
    setSpent(null); setSpentRefund(null); setSpentErasure(null); setSpentMoney(null); setSpentPrice(null);
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
        // …and the seat stays where it was. A 409 here means the register answered “no”, not that the
        // paper moved out of reach, so the sentence the seat typed — which is the reason it means to
        // say no — is the one thing this desk must not throw away on the way back. 134's money desk
        // learned it the same way: a refusal belongs in the alert, and the form keeps what was typed.
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
        // 140–142 each answer with the paper that went live: its ref, its version and the count of the
        // earlier versions the same statement closed. None of them is the ban's shape, and a panel that
        // read one as the other would publish a price and show `· →`.
        else if (isPublish(row)) setSpentPrice({ e: j as SpentPrice, kind: "publish" });
        else if (isAddendum(row)) setSpentPrice({ e: j as SpentPrice, kind: "addendum" });
        else if (isCommission(row)) setSpentPrice({ e: j as SpentPrice, kind: "commission",
          paper: cut(row) });
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
          and this page shows the last digits of a payee&apos;s account number, never the whole of it.
          Three more papers arrive from the{" "}
          <Link href="/control/pricing" className="underline"
            style={{ color: "var(--adm-accent)" }}>pricing desk</Link>: a freight price list, a levy or
          discount code, and a commission agreement. Signing one puts it in force and closes the version
          of the same code it replaces, in this same call — the figures, the window and the rung a cut
          sits on are read out of the hashed paper, and nobody is emailed that a price went live. The
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

        {spentPrice && <PriceSpent e={spentPrice.e} kind={spentPrice.kind}
          paper={spentPrice.paper} />}

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
                    style={{ color: "var(--adm-accent)" }}>Customers</Link> desk, a payout or an escrow plan
                  raised on the{" "}
                  <Link href="/control/money" className="underline"
                    style={{ color: "var(--adm-accent)" }}>ledger desk</Link>, or a price list, a charge
                  or a commission agreement raised on the{" "}
                  <Link href="/control/pricing" className="underline"
                    style={{ color: "var(--adm-accent)" }}>pricing desk</Link> — all appear here the moment
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
          // A price paper is a fourth kind of act: it names no company state, sends no letter and
          // changes what the next quote or transaction is worth. Its row has to say which of the
          // three it is, or a seat signs a tariff reading ban words.
          const price = isPrice(r);
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
                {price
                  ? <>{priceWords(r)} Read the paper back on the{" "}
                    <Link href="/control/pricing" className="underline"
                      style={{ color: "var(--adm-accent)" }}>pricing desk</Link> — nobody is messaged or
                    emailed that a price went live, so the register row and the paper&apos;s own memory
                    lines are the answer here too.</>
                  : money
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
                    : price ? ` · ${appliedPriceWords(r)}`
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
                  ban — the same duty signs a refund, an erasure, a money paper or a price. A payout needs{" "}
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>
                    control.money.pay</span>, a plan for a hold needs{" "}
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>
                    control.money.escrow</span>, and a price list, a charge or a commission agreement
                  needs{" "}
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>
                    control.pricing.publish</span> — and the seat that raised a paper cannot sign it.
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
                          : price ? `Sign or refuse this ${isCommission(r) ? "cut"
                            : isAddendum(r) ? "charge" : "price list"}`
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
                            : price ? "publish"
                              : r.action === "tenant.close" ? "close" : "block"} ${subject(r)}`
                        : `Sign and ${refund ? "release the paper"
                          : erase ? "run the mask, which cannot be undone"
                            : isHold(r) ? "move the money out of escrow"
                              : money ? "accrue the obligation, not pay it"
                                : price ? "put this price in force, closing the version it replaces"
                                  : r.action === "tenant.close" ? "close the account"
                                    : "block access"}`}
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
