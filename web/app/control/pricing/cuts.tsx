"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Desk } from "./ask";

/**
 * The cut and the money it is cut from (142; task #420b).
 *
 * A commission is not a price. A price is what the office charges; a cut is what the office takes out of a
 * transaction that already has a figure of its own, and the two are worked out by different doors for
 * different reasons. So nothing below multiplies anything: the desk prints `value_said`, the register's own
 * one-line `said`, and whatever `GET /cuts/ask` answers. A figure this screen assembled from a percentage
 * and an amount would be a figure the register never said — 140's argument, and 138's defect one table away.
 *
 * Three registers decide what this desk can offer, and none of them is a list typed into this file:
 * `pricing_commission_subjects` (the rungs the ladder walks, with the priority that decides which one
 * speaks), `pricing_commission_sources` (the five transactions a cut can be taken from, and whether each is
 * money coming in or going out), and `GET /cuts/choices`, which is the ten lists a clerk picks a company, a
 * plan, a payee, a transaction or a carrying movement off. The board's answer carries the first two and the
 * page holds them, so a fourth rung or a sixth transaction is a row in the register rather than an edit here.
 *
 * **Four halves of an agreement never move once it is opened.** The subject, the transaction, the payee and
 * the basis are frozen by the trigger in 142's section 6, and the panel shows them as reading rather than as
 * pens: a seat that signed “3 percent of a payout” cannot be made to have signed “50,000 on a payout” by an
 * edit, and a cut that can be retargeted from one company to another is a signed paper somebody can move.
 *
 * **No button here makes a cut live.** `Put it up for a signature` raises the paper and prints the hash it
 * was cut on; the signature is spent by the seat that holds it, on Approvals, through 121's
 * `commission_publish` effect. The one thing this desk can do that a clerk may expect it not to is refuse a
 * paper — and even that leaves the draft editable rather than live.
 *
 * Every disabled press below quotes the code the register answers with (`paper_is_out`, `already_lived`,
 * `no_start`, `days_are_taken`, `kept`, `has_not_lived`, `not_live`, `stop_is_in_the_past`, `nothing_open`),
 * because the rule and the sentence belong to 142 and a friendlier paraphrase here would be a second set of
 * rules that eventually disagrees with the first.
 */

const cell = "w-full rounded-input border px-8 py-8 text-sm";
const cellStyle = { borderColor: "var(--adm-line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const btn = "waisha-btn rounded-input px-16 py-8 text-xs font-semibold";
const th = "border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]";
const td = "border-b px-8 py-8 align-top text-sm";

const PAGE = 30;

/** One row of `pricing_commission_subjects` — the rung a cut is agreed on, and the order the resolver walks
 *  them in. `names` is the word the desk uses for the id it has to ask for (`company`, `plan`, `none`). */
export interface Rung { key: string; label: string; priority: number; names: string; note: string | null }

/** One row of `pricing_commission_sources` — a transaction the office takes a cut from. `side` is the
 *  register's own word for whether that money comes in or goes out, which is what decides whether a cut is
 *  income the office keeps or a sum it owes somebody. */
export interface Transaction { key: string; label: string; side: string; sort: number; note: string | null }

/** One agreement as the board prints it. */
export interface CutRow {
  id: string; ref: string; status: string; version: number;
  subject_kind: string; subject_key: string; subject_name: string; subject_label: string | null;
  subject_tenant_id: string | null; subject_plan_id: string | null;
  source_kind: string; source_label: string | null; source_side: string | null;
  payee_kind: string; payee_id: string | null; payee_name: string | null;
  basis: string; value: string; currency: string | null;
  floor_amount: string | null; cap: string | null; value_said: string;
  effective_from: string | null; effective_to: string | null; live_today: boolean;
  refusals: number; approval_id: string | null; approval_status: string | null;
  published_by: string | null; published_at: string | null; published_note: string | null;
  withdrawn_reason: string | null; supersedes: string | null;
  readings: number; owed: string; said: string; note: string; updated_at: string;
}

/** One agreement whole, as `pricing_commission_rate_detail` returns it — the shape every write answers with,
 *  so what the desk says after a press is the agreement's new figure rather than an echo of what was typed. */
export interface CutDetail {
  ok?: boolean;
  rate: {
    id: string; ref: string; status: string; version: number;
    subject_kind: string; subject_key: string; subject_name: string;
    subject_tenant_id: string | null; subject_plan_id: string | null;
    source_kind: string; source_label: string | null; source_side: string | null;
    payee_kind: string; payee_id: string | null; payee_name: string | null;
    basis: string; value: string; currency: string | null;
    floor_amount: string | null; cap: string | null;
    effective_from: string | null; effective_to: string | null;
    refusals: number; note: string; said: string; supersedes: string | null;
    published_by: string | null; published_at: string | null; published_note: string | null;
    withdrawn_by: string | null; withdrawn_at: string | null; withdrawn_reason: string | null;
    created_at: string;
  };
  paper: {
    register: string; id: string; ref: string; book: string;
    subject: { kind: string; name: string; company: string | null; plan: string | null; says: string };
    source: { kind: string; label: string | null; side: string };
    payee: { kind: string; name: string; id: string | null; says: string };
    basis: string; value: string; value_said: string; currency: string | null;
    floor_amount: string | null; cap: string | null;
    window: { effective_from: string | null; effective_to: string | null };
    version: { number: number; supersedes: string | null };
    note: string; status: string;
  } | null;
  paper_sha256: string | null;
  versions: { id: string; ref: string; version: number; status: string; basis: string; value: string;
    currency: string | null; payee_name: string | null; effective_from: string | null;
    effective_to: string | null; published_at: string | null; published_by: string | null;
    withdrawn_reason: string | null }[];
  approval: { id: string; status: string; action: string; reason: string | null;
    proposed_by: string | null; proposed_at: string | null; decided_by: string | null;
    decided_note: string | null; decided_at: string | null; expires_at: string | null;
    payload_sha256: string } | null;
  memory: { at: string | null; what: string; said: string | null; old_value: string | null;
    new_value: string | null; currency: string | null; reason: string | null;
    assessment_ref: string | null; actor: string | null }[];
  readings: { id: string; ref: string; source_kind: string; source_ref: string | null;
    source_amount: string | null; figure: string | null; currency: string | null; status: string;
    assessed_on: string | null; carrier_ref: string | null; void_reason: string | null;
    assessed_by: string | null }[];
}

/** One row of `GET /cuts/choices`, for every kind the door will list. A kind's rows carry only the fields
 *  that kind has, so the union stays optional rather than lying about a payout having a plan. */
export interface Choice {
  kind: string; id: string; name?: string | null; ref?: string | null;
  detail: string | null; note?: string | null;
  plan?: string | null; key?: string | null; agreements?: number;
  active?: boolean; companies?: number; company?: string | null; archived?: boolean;
  amount?: string | null; currency?: string | null; state?: string | null;
  on_day?: string | null; company_tenant_id?: string | null; readings?: number;
  fee_amount?: string | null; book?: string | null; book_name?: string | null;
  raised_in_this_book?: boolean; payee_kind?: string | null; payee_id?: string | null;
  payee_name?: string | null; memo?: string | null; source_kind?: string | null;
  source_ref?: string | null; carried?: number;
  legs?: { account: string; direction: string; amount: string }[];
  fee_leg?: string | null; cost_leg?: string | null;
}

const PILES: [string, string][] = [
  ["all", "Everything"], ["draft", "Drafts"], ["pending_signature", "Papers out"],
  ["published", "Live"], ["superseded", "Superseded"], ["withdrawn", "Stopped"]
];

/** A cut is kept by the office or owed out to one of three registers. These four words are a table CHECK,
 *  not a register — 142 keeps them fixed because each one names a foreign key the row has to point at, and
 *  a fifth payee is a migration, not a chip. */
const PAYEE: [string, string][] = [
  ["platform", "The office keeps it"], ["company", "A company"],
  ["driver", "A driver"], ["staff", "A staff member"]
];
const PICKER_FOR_PAYEE: Record<string, string> = {
  company: "company", driver: "driver", staff: "staff"
};

/** The half of a draft that is emptied rather than replaced. The door answers `bad_clear` on a word outside
 *  this list, and the identity halves cannot be emptied at all — they are what the paper was signed against. */
const CLEARS = ["floor_amount", "cap", "effective_to"] as const;
const CLEAR_LABEL: Record<string, string> = {
  floor_amount: "the least", cap: "the most", effective_to: "the last day"
};

/** `numeric(14,4)` for a figure — four decimals, because a percentage rounded to two is a different cut on a
 *  small invoice — and `numeric(14,2)` for a least and a most, which a clerk says out loud in cents. */
const FIGURE_OK = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/;
const MONEY_OK = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;

function qs(parts: Record<string, string>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(parts)) {
    const s = String(v ?? "").trim();
    if (s) out.push(`${k}=${encodeURIComponent(s)}`);
  }
  return out.join("&");
}

const short = (h?: string | null) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "no hash");

/** A register label dropped into the middle of a sentence. `pricing_commission_sources.label` is written for
 *  the top of a picker — "A freight invoice" — and the board quotes it after "on", so the capital comes off
 *  rather than the desk inventing its own word for the transaction. */
const midSay = (s?: string | null) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
/** Which side of the book a transaction sits on, in the words the detail card already uses. The column holds
 *  `in`/`out`, and a clerk reading a live rung's row needs the sentence, not the letter. */
const sideSaid = (side?: string | null) =>
  side === "in" ? "money coming in" : side === "out" ? "money going out" : undefined;

/** Whether a live agreement rules today. The board is answered with `live_today` by the register; a detail
 *  row is not, and the panel must say the same thing the board said about the same row — so the same three
 *  conditions are applied to the reloaded halves, never to what the clerk has in the boxes. */
export function isLiveToday(r: { status: string; effective_from: string | null;
  effective_to: string | null }, today: string): boolean {
  return r.status === "published"
    && (!r.effective_from || r.effective_from <= today)
    && (!r.effective_to || r.effective_to >= today);
}

function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
      <h4 className="text-sm font-bold" style={{ color: "var(--ink)" }}>{title}</h4>
      <div className="mt-8 grid gap-12">{children}</div>
    </div>
  );
}

/** The one-press-arms-itself button every write on this desk uses. A commission agreement is the figure a
 *  company is cut at, so putting a paper out, stopping a live cut or throwing a draft away is confirmed by a
 *  second tap rather than by a sentence the clerk has to re-read. */
export function Press({ title, body, blocked, field, go, pressName, ready, busyKey, busy, armed, arm, warn }: {
  title: string; body: ReactNode; blocked: string | null; field: ReactNode;
  go: () => Promise<void>; pressName: string; ready: boolean; busyKey: string;
  busy: string | null; armed: string | null; arm: (k: string, f: () => void) => () => void;
  warn?: string | null;
}) {
  const key = title.toLowerCase().replace(/\W+/g, "-");
  return (
    <Field title={title}>
      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{body}</p>
      {blocked && (
        <p className="rounded-input px-12 py-8 text-xs"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", color: "var(--danger)" }}>
          {blocked}
        </p>
      )}
      {field}
      {warn && <p className="text-xs font-semibold" style={{ color: "var(--danger)" }}>{warn}</p>}
      <button className={btn} disabled={!!blocked || !ready || busy !== null}
        onClick={arm(key, () => void go())}>
        {armed === key ? "Press again to confirm"
          : busy === busyKey ? "The register is answering…" : pressName}
      </button>
    </Field>
  );
}

/** A status is the register's word for where the paper is, and a clerk reads the colour before the word, so
 *  the five states are coloured apart rather than printed in one ink. */
export function StatusChip({ status, live }: { status: string; live?: boolean }) {
  const ink: Record<string, string> = {
    draft: "var(--ink-soft)", pending_signature: "var(--warning)", published: "var(--success)",
    superseded: "var(--ink-soft)", withdrawn: "var(--danger)",
    assessed: "var(--warning)", discharged: "var(--success)", voided: "var(--danger)"
  };
  const words: Record<string, string> = {
    draft: "a draft", pending_signature: "paper out", published: "live", superseded: "superseded",
    withdrawn: "stopped", assessed: "owing", discharged: "carried", voided: "voided"
  };
  return (
    <span className="whitespace-nowrap rounded-input px-8 py-4 text-[11px] font-bold uppercase tracking-[0.08em]"
      style={{
        background: "color-mix(in srgb, " + (ink[status] ?? "var(--ink-soft)") + " 12%, transparent)",
        color: ink[status] ?? "var(--ink-soft)"
      }}>
      {words[status] ?? status}{live ? " · today" : ""}
    </span>
  );
}

// ============================================================
// the picker every id is chosen from
// ============================================================

/**
 * One of the ten lists `GET /cuts/choices` answers, in one component, because every id field on both 142
 * desks is the same problem: a pricing seat cannot read the companies, plans, drivers, staff, invoices,
 * payments, expenses, payouts or postings registers, so without this door each of those boxes is an uuid a
 * clerk pastes off another desk.
 *
 * The paste is the danger, not the inconvenience: 142 prices a pasted id happily, and the agreement ends up
 * filed under a company nobody meant. So the picker shows the row the register itself calls it — `detail`,
 * the same string the door builds — and the transaction lists carry the amount, the money, the state and how
 * many readings that row has already produced, which is `assess_commission`'s second refusal read off the
 * list instead of pressed for.
 */
export function ChoicePicker({ desk, kind, value, onPick, savedName, label, placeholder, nothing, hint,
  disabled }: {
  desk: Desk; kind: string; value: string;
  onPick: (id: string, row: Choice | null) => void;
  savedName?: string | null; label: string; placeholder: string;
  nothing?: string; hint?: string; disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<Choice[]>([]);
  const [meta, setMeta] = useState({ count: 0, returned: 0 });
  const [refusal, setRefusal] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The row as the register described it when it was picked. A list that moves on — a word typed afterwards
  // — must not erase the name of what is already chosen.
  const [chosen, setChosen] = useState<Choice | null>(null);
  const seq = useRef(0);

  useEffect(() => { setChosen(null); setSearch(""); setRows([]); }, [kind]);

  useEffect(() => {
    if (!kind) return;
    const my = ++seq.current;
    const t = setTimeout(() => {
      setLoading(true);
      desk.call(`/control/pricing/cuts/choices?${qs({ kind, search, limit: "20" })}`)
        .then((j: any) => {
          if (my !== seq.current) return;
          setRows((j.rows ?? []) as Choice[]);
          setMeta({ count: Number(j.count ?? 0), returned: Number(j.returned ?? 0) });
          setRefusal(null);
        })
        .catch((e: Error) => {
          if (my !== seq.current) return;
          // `search_too_short`, `bad_kind` and `not_the_office` are sentences about this box, so they are
          // printed under it rather than in the page's strip, where a clerk would read them as a fault.
          setRows([]); setMeta({ count: 0, returned: 0 }); setRefusal(e.message);
        })
        .finally(() => { if (my === seq.current) setLoading(false); });
    }, 260);
    return () => clearTimeout(t);
  }, [kind, search, desk]);

  const shown = chosen?.id === value ? chosen : null;
  const named = shown?.name ?? shown?.ref ?? savedName ?? null;

  return (
    <div className="rounded-input px-12 py-8" style={{ background: "var(--milk)", border: "1px solid var(--adm-line)" }}>
      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>{label}</span>
      <input className={`${cell} mb-6`} style={cellStyle} value={search}
        placeholder={placeholder} disabled={disabled}
        onChange={e => setSearch(e.target.value)} />
      <select className={cell} style={cellStyle} value={value} disabled={disabled || !!refusal}
        onChange={e => {
          const r = rows.find(x => x.id === e.target.value) ?? null;
          setChosen(r);
          onPick(e.target.value, r);
        }}>
        <option value="">{nothing ?? "nothing chosen yet"}</option>
        {rows.map(r => <option key={r.id} value={r.id}>{r.detail ?? r.name ?? r.ref ?? r.id}</option>)}
      </select>
      <div className="mt-6 flex flex-wrap items-baseline gap-8 text-xs" style={{ color: "var(--ink-soft)" }}>
        {named
          ? <span className="font-semibold" style={{ color: "var(--ink)" }}>
              {shown && shown.archived ? `${named} — off the book, and the register refuses it` : named}
            </span>
          : <span>Nothing picked from this list yet.</span>}
        {!loading && rows.length > 0 && (
          <span>{meta.returned} of {meta.count} listed{meta.count > meta.returned ? " — type a word for the rest" : ""}.</span>
        )}
        {loading && <span>Asking the register…</span>}
      </div>
      {hint && <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{hint}</p>}
      {refusal && (
        <p className="mt-4 text-xs font-semibold" style={{ color: "var(--danger)" }}>{refusal}</p>
      )}
    </div>
  );
}

// ============================================================
// the board
// ============================================================

const EMPTY_OPEN = { subject_kind: "", subject_tenant: "", subject_plan: "", source_kind: "",
  payee_kind: "platform", payee_id: "", basis: "", value: "", currency: "", floor: "", cap: "",
  effective_from: "", effective_to: "", note: "" };

export function CutsBoard({ desk, rungs, sources, onRungs, onSources, onPick, pickedId, nonce }: {
  desk: Desk; rungs: Rung[]; sources: Transaction[];
  onRungs: (r: Rung[]) => void; onSources: (s: Transaction[]) => void;
  onPick: (id: string) => void; pickedId: string | null; nonce: number;
}) {
  const [board, setBoard] = useState<{ rows: CutRow[]; total: number; counts: Record<string, number> }>(
    { rows: [], total: 0, counts: {} });
  const [f, setF] = useState({ status: "all", subject: "", source: "", search: "", offset: 0 });
  const [showOpen, setShowOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_OPEN });
  const [busy, setBusy] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [readOnce, setReadOnce] = useState(false);

  const read = useCallback(async (q: typeof f) => {
    const parts: Record<string, string> = { limit: String(PAGE), offset: String(q.offset) };
    if (q.status !== "all") parts.status = q.status;
    if (q.subject) parts.subject = q.subject;
    if (q.source) parts.source = q.source;
    if (q.search.trim()) parts.search = q.search.trim();
    try {
      const j = await desk.call(`/control/pricing/cuts?${qs(parts)}`);
      setBoard({ rows: (j.rows ?? []) as CutRow[], total: Number(j.total ?? 0),
        counts: (j.counts ?? {}) as Record<string, number> });
      // The rungs and the transactions ride on every board answer and are handed to the page rather than kept
      // here, because the panel below and the readings desk build their own chips from the same two registers
      // — and a second read is a second answer that can differ from the first.
      if (Array.isArray(j.subjects) && j.subjects.length) onRungs(j.subjects as Rung[]);
      if (Array.isArray(j.sources) && j.sources.length) onSources(j.sources as Transaction[]);
      setReadOnce(true);
    } catch (e) { setFault((e as Error).message); setReadOnce(true); }
  }, [desk, onRungs, onSources]);

  useEffect(() => {
    const t = setTimeout(() => { void read(f); }, 260);
    return () => clearTimeout(t);
  }, [f, read, nonce]);
  useEffect(() => { setF(x => ({ ...x, offset: 0 })); }, [f.search, f.status, f.subject, f.source]);

  const rung = (k: string) => rungs.find(r => r.key === k);
  const chosenRung = rung(form.subject_kind);
  const source = (k: string) => sources.find(s => s.key === k);
  const payeeKind = PICKER_FOR_PAYEE[form.payee_kind] ?? "";

  // Every one of these is a guard the door applies to the same body, restated at the box: a draft that
  // reaches the register with a percentage over 100 comes back `percent_too_wide`, and the clerk who typed
  // it has to be told while the figure is still on the screen.
  const valueOk = FIGURE_OK.test(form.value.trim()) && Number(form.value) > 0;
  const floorOk = !form.floor.trim() || MONEY_OK.test(form.floor.trim());
  const capOk = !form.cap.trim() || MONEY_OK.test(form.cap.trim());
  const percentWide = form.basis === "percent_of_amount" && Number(form.value) > 100;
  const floorAbove = !!form.floor.trim() && !!form.cap.trim() && Number(form.floor) > Number(form.cap);
  const windowBad = !!form.effective_from.trim() && !!form.effective_to.trim()
    && form.effective_to.trim() < form.effective_from.trim();
  const moneyNeeded = form.basis === "flat" && !form.currency;
  const noteOk = form.note.trim().length >= 8 && form.note.trim().length <= 600;
  const subjectOk = !form.subject_kind ? false
    : form.subject_kind === "tenant" ? !!form.subject_tenant
      : form.subject_kind === "plan" ? !!form.subject_plan : true;
  const payeeOk = form.payee_kind === "platform" ? !form.payee_id : !!form.payee_id;
  const refundShape = form.payee_kind === "company" && !!form.subject_tenant
    && form.payee_id === form.subject_tenant;
  const openReady = !!form.subject_kind && subjectOk && !!form.source_kind && payeeOk && !!form.basis
    && valueOk && floorOk && capOk && noteOk && !percentWide && !floorAbove && !windowBad
    && !moneyNeeded && !refundShape;

  async function openCut() {
    setBusy("open"); setFault(null);
    try {
      const j = await desk.call("/control/pricing/cuts", "POST", {
        subject_kind: form.subject_kind,
        subject_tenant: form.subject_kind === "tenant" ? form.subject_tenant : undefined,
        subject_plan: form.subject_kind === "plan" ? form.subject_plan : undefined,
        source_kind: form.source_kind,
        payee_kind: form.payee_kind || undefined,
        payee_id: form.payee_kind !== "platform" && form.payee_id ? form.payee_id : undefined,
        basis: form.basis, value: form.value.trim(),
        // A percentage is worked out in the transaction's own money and the door refuses a money on it
        // (`percent_carries_a_money`), so the key is only ever sent for a flat cut.
        currency: form.basis === "flat" ? form.currency || undefined : undefined,
        floor: form.floor.trim() || undefined, cap: form.cap.trim() || undefined,
        effective_from: form.effective_from.trim() || undefined,
        effective_to: form.effective_to.trim() || undefined,
        note: form.note.trim()
      });
      const rate = j?.rate?.rate;
      setShowOpen(false);
      setForm({ ...EMPTY_OPEN });
      await read(f);
      if (rate?.id) onPick(rate.id);
      desk.notify(`${rate?.ref ?? "A new agreement"} v${rate?.version ?? ""} is open as a draft — ${rate?.said
        ?? "the register has it"}. Nobody is cut under it until a second seat signs it.`);
    } catch (e) { setFault((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <p className="mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
        The ladder walks {rungs.map(r => `${r.priority}. ${r.label}`).join(" → ")
          || "the register’s own rungs"}, and a cut is taken from{" "}
        {sources.map(s => `${s.side === "in" ? "+" : "−"} ${s.label}`).join(", ")
          || "the five transactions the register names"}.
      </p>

      <div className="mb-12 flex flex-wrap gap-8" role="group" aria-label="Piles of agreements">
        {PILES.map(([k, l]) => (
          <button key={k} className={btn} onClick={() => setF(x => ({ ...x, status: k }))}
            aria-pressed={f.status === k}
            style={f.status === k
              ? { background: "var(--adm-accent)", color: "var(--brand-deep)", fontWeight: 800 }
              : { background: "var(--milk)", color: "var(--ink)" }}>
            {l}
            <span className="ml-6 font-normal">{k === "all" ? board.total : board.counts[k] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* The rung chips and the transaction chips are the two registers' own rows, counted over the whole
          book: "does any company have a negotiated cut, or is everything inherited from a plan" is a question
          a status filter cannot answer. A fourth rung is a fourth chip here without this file being opened. */}
      <div className="mb-12 flex flex-wrap gap-8" role="group" aria-label="Which rung, which transaction">
        <button className={btn} onClick={() => setF(x => ({ ...x, subject: "", source: "" }))}
          aria-pressed={!f.subject && !f.source}
          style={!f.subject && !f.source
            ? { background: "var(--brand-deep)", color: "var(--milk)", fontWeight: 800 }
            : { background: "var(--milk)", color: "var(--ink)" }}>
          Whole ladder
        </button>
        {rungs.map(r => (
          <button key={r.key} className={btn}
            onClick={() => setF(x => ({ ...x, subject: x.subject === r.key ? "" : r.key }))}
            aria-pressed={f.subject === r.key}
            style={f.subject === r.key
              ? { background: "var(--brand-deep)", color: "var(--milk)", fontWeight: 800 }
              : { background: "var(--milk)", color: "var(--ink)" }}>
          {r.label}
            <span className="ml-6 font-normal">{board.counts[`subj_${r.key}`] ?? 0}</span>
          </button>
        ))}
        {sources.map(s => (
          <button key={s.key} className={btn}
            onClick={() => setF(x => ({ ...x, source: x.source === s.key ? "" : s.key }))}
            aria-pressed={f.source === s.key}
            style={f.source === s.key
              ? { background: "var(--adm-accent)", color: "var(--brand-deep)", fontWeight: 800 }
              : { background: "var(--milk)", color: "var(--ink)" }}>
            {s.side === "in" ? "+" : "−"} {s.label}
            <span className="ml-6 font-normal">{board.counts[`src_${s.key}`] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
        <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
          Search the register
          <input className={`${cell} mt-4`} style={cellStyle} value={f.search}
            placeholder="a CMR number, a company it was agreed with, a payee, a plan"
            onChange={e => setF(x => ({ ...x, search: e.target.value }))} /></span></label>
        <div className="self-end text-xs" style={{ color: "var(--ink-soft)" }}>
          The search reaches the agreement&apos;s own number, the name of the rung, the payee it is owed to and
          the note a second seat read before signing.
        </div>
      </div>

      {fault && (
        <div className="mb-16 rounded-input px-12 py-8 text-sm" role="alert"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {fault}
        </div>
      )}

      {desk.can.manage && !showOpen && (
        <button className={`${btn} mb-16`} onClick={() => setShowOpen(true)}>
          Agree a cut with a company or a plan
        </button>
      )}
      {desk.can.manage && showOpen && (
        <div className="mb-20 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
          <h2 className="text-sm font-bold" style={{ color: "var(--ink)" }}>
            Open a commission agreement
          </h2>
          <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
            The reference and the version are minted off the rung and the transaction, so a second agreement on
            the same step for the same transaction comes out as version 2. The number, the transaction it is
            cut from, who the cut is owed to and how the figure is worked out are fixed by this press and never
            move again — change any of them by cloning the agreement forward.
          </p>

          <div className="mb-12">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Who the cut is agreed with — the rung the ladder walks
            </span>
            <div className="flex flex-wrap gap-8">
              {rungs.map(r => (
                <button key={r.key} className={btn}
                  onClick={() => setForm(x => ({ ...x, subject_kind: r.key,
                    // A rung that names no company cannot keep a company picked against it.
                    subject_tenant: r.names === "company" ? x.subject_tenant : "",
                    subject_plan: r.names === "plan" ? x.subject_plan : "" }))}
                  aria-pressed={form.subject_kind === r.key}
                  style={form.subject_kind === r.key
                    ? { background: "var(--brand-deep)", color: "var(--milk)", fontWeight: 800 }
                    : { background: "var(--milk)", color: "var(--ink)" }}>
                  {r.priority}. {r.label}
                </button>
              ))}
            </div>
            {chosenRung?.note && (
              <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>{chosenRung.note}</p>
            )}
          </div>

          <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
            {form.subject_kind === "tenant" && (
              <ChoicePicker desk={desk} kind="company" value={form.subject_tenant}
                label="The company" placeholder="KILIAN, a company name or its plan"
                nothing="nobody agreed with yet"
                savedName={null}
                hint="Only a live company the office has registered is listed; the platform itself is not, because the office does not cut itself a separate rate."
                onPick={(id) => setForm(x => ({ ...x, subject_tenant: id }))} />
            )}
            {form.subject_kind === "plan" && (
              <ChoicePicker desk={desk} kind="plan" value={form.subject_plan}
                label="The plan" placeholder="PRO, a plan name or its key"
                nothing="no plan inherited from yet"
                hint="A cut on a plan is what every company sitting on that plan is taken at, and it is asked second — a company’s own agreement always wins."
                onPick={(id) => setForm(x => ({ ...x, subject_plan: id }))} />
            )}
            {form.subject_kind === "platform" && (
              <div className="rounded-input px-12 py-8 text-xs" style={{ background: "var(--milk)",
                border: "1px solid var(--adm-line)", color: "var(--ink-soft)" }}>
                The office&apos;s own standing cut names no company and no plan. It is asked last, so a rate
                nobody signed for never wins over one somebody did.
              </div>
            )}
            {!form.subject_kind && (
              <div className="rounded-input px-12 py-8 text-xs" style={{ background: "var(--milk)",
                border: "1px solid var(--adm-line)", color: "var(--ink-soft)" }}>
                Pick the rung first. The register asks a company&apos;s own agreement, then its plan&apos;s,
                then the office&apos;s standing cut — and a draft opened on the wrong rung cuts the wrong book.
              </div>
            )}

            <div className="sm:col-span-2 lg:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                The money it is cut from
              </span>
              <div className="flex flex-wrap gap-8">
                {sources.map(s => (
                  <button key={s.key} className={btn}
                    onClick={() => setForm(x => ({ ...x, source_kind: s.key }))}
                    aria-pressed={form.source_kind === s.key}
                    style={form.source_kind === s.key
                      ? { background: "var(--adm-accent)", color: "var(--brand-deep)", fontWeight: 800 }
                      : { background: "var(--milk)", color: "var(--ink)" }}>
                    {s.side === "in" ? "+" : "−"} {s.label}
                  </button>
                ))}
              </div>
              {source(form.source_kind)?.note && (
                <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {source(form.source_kind)!.note}
                </p>
              )}
            </div>
          </div>

          <div className="mt-12 grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Who the cut is owed to</span>
              <div className="flex flex-wrap gap-8">
                {PAYEE.map(([k, l]) => (
                  <button key={k} className={btn}
                    onClick={() => setForm(x => ({ ...x, payee_kind: k, payee_id: "" }))}
                    aria-pressed={form.payee_kind === k}
                    style={form.payee_kind === k
                      ? { background: "var(--brand-deep)", color: "var(--milk)", fontWeight: 800 }
                      : { background: "var(--milk)", color: "var(--ink)" }}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            {payeeKind && (
              <ChoicePicker desk={desk} kind={payeeKind} value={form.payee_id}
                label={`Which ${form.payee_kind}`}
                placeholder={form.payee_kind === "company" ? "a company the office pays" : "a name, or the company they drive for"}
                nothing="nobody owed out yet"
                onPick={(id) => setForm(x => ({ ...x, payee_id: id }))} />
            )}
            <div className="self-end text-xs" style={{ color: "var(--ink-soft)" }}>
              {form.payee_kind === "platform"
                ? "The office keeping its own cut names no register row — the payee is the office’s book."
                : "A cut owed out is a sum the office pays somebody, and the reading it produces is what that movement has to carry."}
              {refundShape && (
                <span className="mt-4 block font-semibold" style={{ color: "var(--danger)" }}>
                  That is the company the cut is agreed with. 142 refuses it: a cut taken from a company and
                  paid straight back to them is a refund wearing an agreement.
                </span>
              )}
            </div>
          </div>

          <div className="mt-12 grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2 lg:col-span-3">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                How the figure is worked out
              </span>
              <div className="flex flex-wrap gap-8">
                {[["percent_of_amount", "A percentage of the transaction"],
                  ["flat", "A flat sum named in a money"]].map(([k, l]) => (
                  <button key={k} className={btn}
                    onClick={() => setForm(x => ({ ...x, basis: k,
                      currency: k === "flat" ? (x.currency || "TZS") : "" }))}
                    aria-pressed={form.basis === k}
                    style={form.basis === k
                      ? { background: "var(--adm-accent)", color: "var(--brand-deep)", fontWeight: 800 }
                      : { background: "var(--milk)", color: "var(--ink)" }}>
                    {l}
                  </button>
                ))}
              </div>
              <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>
                The basis is one of two and it never changes after the draft is opened: a percentage and a flat
                sum are two promises, and a second seat that signed one cannot be made to have signed the other
                by an edit.
              </p>
            </div>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              {form.basis === "flat" ? "The sum" : "The percentage"}
              <input className={`${cell} mt-4`} style={cellStyle} value={form.value} inputMode="decimal"
                placeholder={form.basis === "flat" ? "50000" : "2.5"}
                onChange={e => setForm(x => ({ ...x, value: e.target.value }))} /></span>
              {form.value.trim() && !valueOk && (
                <span className="mt-4 block text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  A figure is whole units or up to four decimals, and a zero cut is no agreement.
                </span>
              )}
              {percentWide && (
                <span className="mt-4 block text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  {form.value} % is not a percentage: a cut above 100 takes the transaction away and owes the
                  office the difference.
                </span>
              )}
            </label>
            {form.basis === "flat" && (
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                In which money
                <select className={`${cell} mt-4`} style={cellStyle} value={form.currency}
                  onChange={e => setForm(x => ({ ...x, currency: e.target.value }))}>
                  <option value="">a flat cut has to name one</option>
                  <option value="TZS">TZS</option>
                  <option value="USD">USD</option>
                </select></span>
                <span className="mt-4 block text-xs" style={{ color: "var(--ink-soft)" }}>
                  A flat sum in one money is not taken out of a transaction in another — the register answers
                  that mismatch with `money_mismatch` when a cut is taken.
                </span>
              </label>
            )}
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              At least (optional)
              <input className={`${cell} mt-4`} style={cellStyle} value={form.floor} inputMode="decimal"
                placeholder="5000" onChange={e => setForm(x => ({ ...x, floor: e.target.value }))} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              At most (optional)
              <input className={`${cell} mt-4`} style={cellStyle} value={form.cap} inputMode="decimal"
                placeholder="200000" onChange={e => setForm(x => ({ ...x, cap: e.target.value }))} /></span>
              {floorAbove && (
                <span className="mt-4 block text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  The least cannot be above the most.
                </span>
              )}
            </label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              The cut starts
              <input className={`${cell} mt-4`} type="date" style={cellStyle} value={form.effective_from}
                onChange={e => setForm(x => ({ ...x, effective_from: e.target.value }))} /></span>
              <span className="mt-4 block text-xs" style={{ color: "var(--ink-soft)" }}>
                No start day and the ladder cannot tell which agreement ruled a transaction, so the register
                refuses the paper with `no_start`.
              </span>
            </label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              …and stops (optional)
              <input className={`${cell} mt-4`} type="date" style={cellStyle} value={form.effective_to}
                onChange={e => setForm(x => ({ ...x, effective_to: e.target.value }))} /></span>
              {windowBad && (
                <span className="mt-4 block text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  The last day cannot come before the first day.
                </span>
              )}
            </label>
            <label className="sm:col-span-2 lg:col-span-3"><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              What the second seat is being asked to sign
              <textarea className={`${cell} mt-4 min-h-[80px]`} style={cellStyle} value={form.note}
                rows={3} placeholder="Agreed with the owner on the 12th: 2.5% of every subscription invoice, at most 200,000 a month, kept by the office."
                onChange={e => setForm(x => ({ ...x, note: e.target.value }))} /></span>
              <span className="mt-4 block text-xs" style={{ color: form.note.trim().length >= 8 && form.note.trim().length <= 600
                ? "var(--ink-soft)" : "var(--danger)" }}>
                {form.note.trim().length}/600 — 8 characters at least. This sentence is the reason a signature is asked for.
              </span>
            </label>
          </div>

          <button className={`${btn} mt-16`} disabled={!openReady || busy !== null}
            onClick={() => void openCut()}>
            {busy === "open" ? "The register is writing…" : "Open the agreement as a draft"}
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
              <th className={th}>Paper</th>
              <th className={th}>The rung and what it is cut from</th>
              <th className={th}>The cut</th>
              <th className={th}>Its days</th>
              <th className={th}>Owed to</th>
              <th className={th}>Readings</th>
            </tr>
          </thead>
          <tbody>
            {board.rows.map(r => (
              <tr key={r.id} className="cursor-pointer hover:opacity-80"
                style={{ borderTop: "1px solid var(--adm-line)",
                  outline: pickedId === r.id ? "2px solid var(--adm-accent)" : undefined }}
                onClick={() => onPick(r.id)}>
                <td className={td}>
                  <span className="font-bold" style={{ color: "var(--ink)" }}>{r.ref}</span>
                  <span className="ml-6 text-xs" style={{ color: "var(--ink-soft)" }}>v{r.version}</span>
                  <div className="mt-4 flex flex-wrap gap-6">
                    <StatusChip status={r.status} live={r.live_today} />
                    {r.supersedes && <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                      replaces {r.supersedes}</span>}
                  </div>
                </td>
                <td className={td}>
                  <span className="font-semibold">{r.subject_label ?? r.subject_kind}</span>
                  <div>{r.subject_name}</div>
                  <div className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                    on {midSay(r.source_label) ?? r.source_kind}
                    {sideSaid(r.source_side) ? `, ${sideSaid(r.source_side)}` : ""}
                  </div>
                </td>
                <td className={td}>
                  <span className="font-bold whitespace-nowrap" style={{ color: "var(--ink)" }}>
                    {r.basis === "flat" ? r.value_said : `${r.value_said} of it`}
                  </span>
                  {r.floor_amount && <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    never under {desk.fig(r.floor_amount)}{r.currency ? ` ${r.currency}` : ""}</div>}
                  {r.cap && <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    never over {desk.fig(r.cap)}{r.currency ? ` ${r.currency}` : ""}</div>}
                </td>
                <td className={td}>
                  <span className="whitespace-nowrap">{r.effective_from ?? "any day from"}</span>
                  <span className="mx-4" style={{ color: "var(--ink-soft)" }}>→</span>
                  <span className="whitespace-nowrap">{r.effective_to ?? "still open"}</span>
                  {r.live_today && (
                    <div className="mt-4 text-xs font-semibold" style={{ color: "var(--success)" }}>
                      rules today
                    </div>
                  )}
                </td>
                <td className={td}>
                  <span className="font-semibold">{r.payee_name}</span>
                  <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    {r.payee_kind === "platform" ? "kept by the office" : `a ${r.payee_kind}`}
                  </div>
                  {r.refusals > 0 && (
                    <div className="mt-4 text-xs font-semibold" style={{ color: "var(--danger)" }}>
                      {r.refusals} signature{r.refusals === 1 ? "" : "s"} refused
                    </div>
                  )}
                </td>
                <td className={td}>
                  <span className="font-semibold">{r.readings}</span>
                  <span className="ml-4 text-xs" style={{ color: "var(--ink-soft)" }}>taken</span>
                  <div className="mt-4 whitespace-nowrap text-xs" style={{ color: "var(--ink-soft)" }}>
                    {desk.fig(r.owed)} still owed
                    {r.currency ? ` ${r.currency}` : ""}
                  </div>
                </td>
              </tr>
            ))}
            {!board.rows.length && (
              <tr><td className={td} colSpan={6}>
                {readOnce
                  ? "Nothing in this pile. The office’s standing cut, a plan’s cut and every company’s own "
                    + "agreement are one register — switch pile, rung or transaction to see the rest."
                  : "Reading the register…"}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
        “Still owed” is the register&apos;s own sum over the readings this agreement has not yet carried. A flat
        cut is one money, so its sum is one money; a percentage follows each transaction&apos;s own money, so
        where one rung has been cut in both TZS and USD the figure spans two and 138&apos;s rule says read it
        with that in mind — the per-money count is on the readings desk.
      </p>

      <div className="mt-12 mb-16 flex flex-wrap items-center gap-12">
        <button className={btn} disabled={f.offset === 0 || busy !== null}
          onClick={() => setF(x => ({ ...x, offset: Math.max(0, x.offset - PAGE) }))}>
          Newer {PAGE}
        </button>
        <button className={btn} disabled={f.offset + PAGE >= board.total || busy !== null}
          onClick={() => setF(x => ({ ...x, offset: x.offset + PAGE }))}>
          More
        </button>
        <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
          {board.total} agreement{board.total === 1 ? "" : "s"} in this pile · showing{" "}
          {board.total ? `${f.offset + 1}–${Math.min(board.total, f.offset + board.rows.length)}` : "nothing"}
        </span>
      </div>
    </>
  );
}

// ============================================================
// one agreement, its paper and its readings
// ============================================================

const EMPTY_EDIT = { value: "", floor: "", cap: "", effective_from: "", effective_to: "", note: "" };

export function CutPanel({ desk, rungs, sources, cutId, onClose, onGoto, onGotoReading, refresh }: {
  desk: Desk; rungs: Rung[]; sources: Transaction[]; cutId: string;
  onClose: () => void; onGoto: (id: string) => void; onGotoReading: (id: string) => void;
  refresh: () => void | Promise<void>;
}) {
  const [d, setD] = useState<CutDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState({ ...EMPTY_EDIT });
  const [clears, setClears] = useState<string[]>([]);
  // Each press keeps its own sentence: a reason typed to raise a paper must not reappear beside "Stop the
  // cut", or the clerk reads their own words back as an answer.
  const [press, setPress] = useState({ reason: "", refuse_note: "", clone_from: "", clone_note: "",
    stop_day: "", stop_reason: "", discard_reason: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  const r = d?.rate ?? null;
  const isDraft = r?.status === "draft";
  const isPaperOut = r?.status === "pending_signature";
  const isLive = r?.status === "published";
  const hasLived = !!r?.published_at;

  const load = useCallback(async () => {
    setLoading(true); setFault(null);
    try {
      const j = await desk.call(`/control/pricing/cuts/${cutId}`) as CutDetail;
      setD(j);
      // The pens are filled from the register's own row, never from what was typed into them: a press moves
      // a figure, and a panel holding the old shape would go on offering a clear the row has answered.
      setEdit({ value: j.rate.value, floor: j.rate.floor_amount ?? "", cap: j.rate.cap ?? "",
        effective_from: j.rate.effective_from ?? "", effective_to: j.rate.effective_to ?? "",
        note: j.rate.note ?? "" });
      setClears([]);
    } catch (e) { setFault((e as Error).message); setD(null); }
    finally { setLoading(false); }
  }, [cutId, desk]);

  useEffect(() => { void load(); setArmed(null); }, [cutId, load]);

  /** The three shapes the write doors answer with. `open`, `clone`, `propose`, `refuse` and `withdraw` nest
   *  the whole detail under `rate`; `edit` returns it at the top level; a press whose answer was missed would
   *  leave the panel showing a figure the register has already changed. */
  const detailOf = (j: any): CutDetail | null =>
    j?.rate?.rate?.id ? (j.rate as CutDetail) : j?.rate?.id ? (j as CutDetail) : null;

  async function run(key: string, fn: () => Promise<any>, then: (j: any) => string, gone = false) {
    setBusy(key); setFault(null); setArmed(null);
    try {
      const j = await fn();
      const shown = detailOf(j);
      // Discarding is the one press that leaves no agreement to show: the draft and its memory rows are
      // deleted, and only the audit line says it existed.
      if (gone) { await refresh(); desk.notify(then(j)); onClose(); return; }
      // Cloning answers with a different agreement, and every read and write below is addressed by `cutId` —
      // so the desk follows the new draft rather than offering a live agreement's pens to the version that
      // has not been edited yet.
      if (shown && shown.rate.id !== cutId) {
        await refresh();
        desk.notify(then(j));
        onGoto(shown.rate.id);
        return;
      }
      if (shown) { setD(shown); setEdit({ value: shown.rate.value, floor: shown.rate.floor_amount ?? "",
        cap: shown.rate.cap ?? "", effective_from: shown.rate.effective_from ?? "",
        effective_to: shown.rate.effective_to ?? "", note: shown.rate.note ?? "" }); setClears([]); }
      else await load();
      await refresh();
      desk.notify(then(j));
    } catch (e) {
      // A refused press still says something this desk could not know on its own — that the paper is out,
      // that the days are already taken, that the agreement has been live — so it is reported here, inside
      // the agreement that provoked it, rather than in the strip above the fold.
      setFault((e as Error).message);
    } finally { setBusy(null); }
  }

  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  // Absent keys keep what the row holds and `clear` empties a column, so only the halves that moved go out —
  // and a body that asks for nothing is refused by the door, because every call that reaches it is audited.
  function changedPatch(): Record<string, unknown> | null {
    if (!r) return null;
    const body: Record<string, unknown> = {};
    if (edit.value.trim() && edit.value.trim() !== r.value) body.value = edit.value.trim();
    if (edit.floor.trim() && edit.floor.trim() !== (r.floor_amount ?? "")) body.floor = edit.floor.trim();
    if (edit.cap.trim() && edit.cap.trim() !== (r.cap ?? "")) body.cap = edit.cap.trim();
    if (edit.effective_from && edit.effective_from !== (r.effective_from ?? "")) {
      body.effective_from = edit.effective_from;
    }
    if (edit.effective_to && edit.effective_to !== (r.effective_to ?? "")) {
      body.effective_to = edit.effective_to;
    }
    if (edit.note.trim() && edit.note.trim() !== (r.note ?? "")) body.note = edit.note.trim();
    // A column the desk says to empty is emptied: its box is disabled while the clear is ticked, and the
    // figure is dropped here too, because the door refuses a body that both clears a column and asks for a
    // new value in it.
    if (clears.length) {
      for (const c of clears) {
        delete body[c === "floor_amount" ? "floor" : c === "cap" ? "cap" : "effective_to"];
      }
      body.clear = clears;
    }
    return Object.keys(body).length ? body : null;
  }
  const patch = changedPatch();

  const figureOk = !edit.value.trim() || (FIGURE_OK.test(edit.value.trim()) && Number(edit.value) > 0);
  const moneyOk = (!edit.floor.trim() || MONEY_OK.test(edit.floor.trim()))
    && (!edit.cap.trim() || MONEY_OK.test(edit.cap.trim()));
  const percentWide = r?.basis === "percent_of_amount" && !!edit.value.trim() && Number(edit.value) > 100;
  // The pair the register judges is the one that results from the edit, not the one typed into it: a draft
  // whose ceiling sits under an old floor is a legal move, and 142's own comment says so.
  const resultingFloor = clears.includes("floor_amount") ? null : (edit.floor.trim() || r?.floor_amount || null);
  const resultingCap = clears.includes("cap") ? null : (edit.cap.trim() || r?.cap || null);
  const floorAbove = !!resultingFloor && !!resultingCap && Number(resultingFloor) > Number(resultingCap);
  const windowBad = !!edit.effective_from && !!edit.effective_to && edit.effective_to < edit.effective_from;
  const noteOk = edit.note.trim().length >= 8 && edit.note.trim().length <= 600;

  const noManage = desk.can.manage ? null
    : "This seat holds no `control.pricing.manage` duty, so it can read the ladder but not write on it.";
  const noPublish = desk.can.publish ? null
    : "Putting a cut up for a signature is `control.pricing.publish` — the seat that agrees a figure is not "
      + "the seat that asks somebody to sign it.";

  const blockedEdit = !r ? "Nothing loaded yet." : noManage
    ? noManage
    : isPaperOut ? `${r.ref} is waiting for a second seat. Refuse that paper before moving a figure under it `
        + "— the signature is cut on the bytes the paper was raised with, and a figure moved now is a "
        + "different paper from the one that seat was asked to sign (`paper_is_out`)."
      : hasLived ? `${r.ref} has been a live agreement, so its figures are frozen: clone it forward and the `
        + "company is cut under the new version from its own start day (`already_lived`)."
        : isDraft ? null : `Only a draft is edited (${r.status} is not one — \`not_a_draft\`).`;

  const blockedPublish = !r ? "Nothing loaded yet." : noPublish
    ? noPublish
    : isPaperOut ? `${r.ref} is already waiting for a second seat. Refuse that paper first (`
      + "`already_open`)."
      : hasLived ? `${r.ref} has already been live, so a signature on it is not this desk's to ask for (`
        + "`already_lived`)."
        : !isDraft ? `Only a draft goes up for a signature (${r.status} — \`not_a_draft\`).`
          : !r.effective_from ? `${r.ref} has no start day, so the ladder could never tell which agreement `
            + "ruled a transaction. A cut with no day cannot go live (`no_start`)."
            : null;

  const blockedRefuse = !r ? "Nothing loaded yet." : noPublish
    ? noPublish
    : !d?.approval ? `No signature is standing on ${r.ref}. Refusing an agreement the office never asked `
      + "anyone to sign is not a thing a register can record (`nothing_open`)."
      : d.approval.status !== "pending"
        ? `The signature on ${r.ref} was ${d.approval.status}. An agreement that has been signed is spent on `
          + "Approvals or withdrawn from this desk — it is not refused from here (`already_signed`)."
          : null;

  const blockedClone = !r ? "Nothing loaded yet." : noManage
    ? noManage
    : !hasLived ? `${r.ref} was never a live agreement. Edit the draft, or throw it away — a version chain is `
      + "the history of what the office actually cut people under (`has_not_lived`)."
        : isPaperOut ? `The paper out against ${r.ref} has to be answered before a version is raised off it `
          + "(`paper_is_out`)." : null;

  const stopDay = press.stop_day.trim();
  const blockedWithdraw = !r ? "Nothing loaded yet." : noManage
    ? noManage
    : !isLive ? `${r.ref} is ${r.status}. A draft is thrown away, an unsigned paper is refused on Approvals, `
      + "and a version that has been replaced has already stopped (`not_live`)."
      : !stopDay ? "A stop needs a day: an agreement that simply says “withdrawn” leaves the ladder without an "
        + "answer for the transactions between its last live day and now (`no_stop_day`)."
        : stopDay < desk.today() ? `The stop day is ${stopDay} and today is ${desk.today()}. An agreement cannot `
          + "be unmade over the days it was quoted under; a cut already taken is answered by voiding the "
          + "reading, not by rewriting the agreement (`stop_is_in_the_past`)."
          : !!r.effective_from && stopDay < r.effective_from
            ? `${r.ref} started ${r.effective_from} and would stop ${stopDay}: a window cannot end before it `
              + "opens (`empty_window`)." : null;

  // The gate reads the same three marks `discard_pricing_commission_rate` reads. `status` alone is not
  // enough: a *refused* paper puts the version back to a draft with its paper still attached, and a
  // desk that gated on the status would offer a press the register always refuses (141 taught this the
  // same way). The detail carries no `approval_id` on its rate row — it answers with the sibling
  // `approval` object, which exists exactly when that column is set — so that object is the mark here.
  const hasPaper = !!d?.approval;
  const blockedDiscard = !r ? "Nothing loaded yet." : noManage
    ? noManage
    : r.status !== "draft" || hasPaper || !!r.published_at
      ? `${r.ref} is a ${r.status}${hasPaper ? " paper that a seat was asked to sign"
        : r.published_at ? " agreement that has been live" : ""}, so it is kept. A live agreement is ended by `
        + "withdrawing it or by a new version, and an unsigned paper is refused on Approvals (`kept`)." : null;

  if (loading && !d) return <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Reading the agreement…</p>;

  if (!r) {
    return (
      <div className="mt-20 rounded-card border p-16" style={{ borderColor: "var(--danger)" }}>
        <h3 className="text-sm font-bold" style={{ color: "var(--danger)" }}>
          The register would not answer for this agreement
        </h3>
        <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>{fault}</p>
        <button className={`${btn} mt-12`} onClick={onClose}>Back to the board</button>
      </div>
    );
  }

  const paperPending = d?.approval?.status === "pending";
  const paperMoved = !!d?.approval && !!d.paper_sha256 && d.approval.payload_sha256 !== d.paper_sha256;
  const liveToday = isLiveToday(r, desk.today());
  // The transaction's own description is the register's row, not a sentence this file chose, so a cut on a
  // payout explains itself here in the words that decide whether the office keeps it or owes it out.
  const rungSource = sources.find(s => s.key === r.source_kind);

  return (
    <section className="mt-20 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}
      aria-label={`Commission agreement ${r.ref}`}>
      <div className="mb-16 flex flex-wrap items-start justify-between gap-12">
        <div>
          <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>
            {r.ref} · version {r.version}
          </h2>
          <p className="mt-4 text-sm" style={{ color: "var(--ink)" }}>{r.said}</p>
          <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
            {rups(rungs, r.subject_kind)} · {r.source_label ?? r.source_kind}
            {sideSaid(r.source_side) ? ` · ${sideSaid(r.source_side)}` : ""} · {r.payee_kind === "platform"
              ? `kept by ${r.payee_name}` : `owed out to ${r.payee_name}`}
            {r.supersedes ? ` · replaces ${r.supersedes}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-8">
          <StatusChip status={r.status} live={liveToday} />
          <button className={btn} onClick={onClose}>Close</button>
        </div>
      </div>

      {fault && (
        <div className="mb-16 rounded-input px-12 py-8 text-sm" role="alert"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {fault}
        </div>
      )}

      {/* The four frozen halves, printed as reading. A panel that offered them as pens would promise an edit
          the trigger refuses, and the refusal would arrive after a press rather than before one. */}
      <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
        {[["Agreed with", `${r.subject_name}`, r.subject_kind],
          ["Cut from", r.source_label ?? r.source_kind, r.source_side === "in"
            ? "money coming in" : "money going out"],
          ["Worked out as", r.basis === "flat" ? `a flat sum of ${desk.fig(r.value)} ${r.currency}`
            : `${desk.fig(r.value)} percent of the transaction`, r.basis],
          ["Owed to", r.payee_name, r.payee_kind === "platform" ? "the office keeps it" : `a ${r.payee_kind}`]]
          .map(([title, main, sub]) => (
            <div key={String(title)} className="rounded-input px-12 py-8"
              style={{ background: "var(--milk)", border: "1px solid var(--adm-line)" }}>
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>{title}</span>
              <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{main}</p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{sub}</p>
            </div>
          ))}
      </div>
      <p className="mb-16 text-xs" style={{ color: "var(--ink-soft)" }}>
        The rung, the transaction, the payee and the basis were fixed when this draft was opened and never move
        — a cut that could be retargeted from one company to another after the fact is a signed paper somebody
        can move. Change one of them by cloning the agreement forward.
      </p>

      <div className="grid gap-16 lg:grid-cols-2">
        <Press title="Move the figures on the draft"
          body="A figure, a least, a most or the days change; the identity of the agreement does not. An absent box keeps what the row holds, and a ticked box empties its column."
          blocked={blockedEdit}
          ready={!!patch && figureOk && moneyOk && !percentWide && !floorAbove && !windowBad && noteOk}
          busyKey="edit" busy={busy} armed={armed} arm={arm}
          pressName={patch ? "Save the draft" : "Nothing has changed"}
          warn={patch ? null : "Nothing to send: the boxes hold exactly what the register has."}
          field={
            <div className="grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                {r.basis === "flat" ? "The sum" : "The percentage"}
                <input className={`${cell} mt-4`} style={cellStyle} value={edit.value} inputMode="decimal"
                  onChange={e => setEdit(x => ({ ...x, value: e.target.value }))} /></span>
                {!figureOk && <span className="mt-4 block text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  A figure is whole units or up to four decimals, and a positive one.</span>}
                {percentWide && <span className="mt-4 block text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  {edit.value} % is not a percentage (`percent_too_wide`).</span>}
              </label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                The note a second seat reads
                <textarea className={`${cell} mt-4 min-h-[70px]`} style={cellStyle} value={edit.note} rows={3}
                  onChange={e => setEdit(x => ({ ...x, note: e.target.value }))} /></span>
                {!noteOk && <span className="mt-4 block text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  {edit.note.trim().length}/600 — 8 characters at least (`bad_note`).</span>}
              </label>
              {(["floor", "cap"] as const).map(k => {
                const word = k === "floor" ? "floor_amount" : "cap";
                const off = clears.includes(word);
                return (
                  <label key={k} className="block"><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                    {k === "floor" ? "At least" : "At most"}
                    {r.currency ? ` (${r.currency})` : " (the transaction’s money)"}
                    <input className={`${cell} mt-4`} style={cellStyle} disabled={off}
                      value={off ? "" : (k === "floor" ? edit.floor : edit.cap)} inputMode="decimal"
                      placeholder={off ? "emptied" : "0.00"}
                      onChange={e => setEdit(x => ({ ...x, [k]: e.target.value }))} /></span>
                    <span className="mt-4 flex items-center gap-6 text-xs" style={{ color: "var(--ink-soft)" }}>
                      <input type="checkbox" checked={off} disabled={!!blockedEdit}
                        onChange={() => setClears(x => off ? x.filter(c => c !== word) : [...x, word])} />
                      Empty {CLEAR_LABEL[word]} — the cut stops being clamped.
                    </span>
                  </label>
                );
              })}
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                The cut starts
                <input className={`${cell} mt-4`} type="date" style={cellStyle} value={edit.effective_from}
                  onChange={e => setEdit(x => ({ ...x, effective_from: e.target.value }))} /></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                …and stops
                <input className={`${cell} mt-4`} type="date" disabled={clears.includes("effective_to")}
                  style={cellStyle} value={clears.includes("effective_to") ? "" : edit.effective_to}
                  onChange={e => setEdit(x => ({ ...x, effective_to: e.target.value }))} /></span>
                <span className="mt-4 flex items-center gap-6 text-xs" style={{ color: "var(--ink-soft)" }}>
                  <input type="checkbox" checked={clears.includes("effective_to")} disabled={!!blockedEdit}
                    onChange={() => setClears(x => clears.includes("effective_to")
                      ? x.filter(c => c !== "effective_to") : [...x, "effective_to"])} />
                  Leave {CLEAR_LABEL.effective_to} open — the cut runs until it is stopped.
                </span>
              </label>
              {(floorAbove || windowBad) && (
                <p className="sm:col-span-2 text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  {floorAbove ? "The least cannot be above the most, whichever way the pair is being moved."
                    : "The last day cannot come before the first day."}
                </p>
              )}
            </div>
          }
          go={async () => {
            await run("edit", () => desk.call(`/control/pricing/cuts/${cutId}`, "PATCH", patch!),
              (j) => `${detailOf(j)?.rate.ref ?? r.ref} now reads: ${detailOf(j)?.rate.said ?? r.said}.`);
          }} />

        <div className="grid gap-16">
          <Field title="The paper a second seat signs">
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
              Raised here, spent on Approvals. 142 reads the rung, the transaction, the payee, the figure and
              the window out of the row and hashes them, so what the register holds is the paper — and the hash
              below is what the other seat&apos;s signature is cut against.
            </p>
            {rungSource?.note && (
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                What a cut on this transaction is, in the register&apos;s own words: {rungSource.note}
              </p>
            )}
            {d?.paper && (
              <div className="rounded-input px-12 py-8 text-xs"
                style={{ background: "var(--milk)", border: "1px solid var(--adm-line)" }}>
                <p className="font-bold" style={{ color: "var(--ink)" }}>{d.paper.subject.says}</p>
                <p className="mt-4">{d.paper.value_said}</p>
                <p className="mt-4">{d.paper.payee.says}</p>
                <p className="mt-4">
                  valid {d.paper.window.effective_from ?? "any day"} → {d.paper.window.effective_to ?? "until stopped"}
                  {(d.paper.floor_amount || d.paper.cap) ? ` · between ${d.paper.floor_amount ?? "nothing"} `
                    + `and ${d.paper.cap ?? "nothing"}` : ""}
                </p>
                <p className="mt-4">version {d.paper.version.number}
                  {d.paper.version.supersedes ? ` · ends ${d.paper.version.supersedes}` : ""}</p>
                <p className="mt-8 font-mono" style={{ color: "var(--ink-soft)" }}>
                  sha256 {short(d.paper_sha256)}
                </p>
              </div>
            )}
            {d?.approval ? (
              <div className="rounded-input px-12 py-8 text-xs"
                style={{ background: "var(--milk)", border: "1px solid var(--adm-line)" }}>
                <p className="font-bold" style={{ color: "var(--ink)" }}>
                  {d.approval.action} · {d.approval.status}
                </p>
                <p className="mt-4">asked of a second seat by {d.approval.proposed_by ?? "a seat this book "
                  + "no longer names"}, {d.approval.proposed_at ?? "no time"}
                  {d.approval.expires_at ? ` · expires ${d.approval.expires_at}` : ""}</p>
                {d.approval.reason && <p className="mt-4">asked because: {d.approval.reason}</p>}
                {d.approval.decided_by && (
                  <p className="mt-4">answered by {d.approval.decided_by}: {d.approval.decided_note
                    ?? "no note was given"}
                  </p>
                )}
                <p className="mt-8 font-mono" style={{ color: paperMoved && paperPending ? "var(--danger)" : "var(--ink-soft)" }}>
                  signed against {short(d.approval.payload_sha256)}
                </p>
                {/* Only a paper that is still waiting can be acted on. An answered one whose bytes differ is
                    history: 121 keeps the hash the signature was cut on, so the line has to say what happened
                    rather than send the clerk to a press the desk only shows while the paper is pending. */}
                {paperMoved && (
                  <p className="mt-4 font-semibold"
                    style={{ color: paperPending ? "var(--danger)" : "var(--ink-soft)" }}>
                    {paperPending
                      ? "The bytes moved after the signature was asked for. 121 refuses the release with "
                        + "`paper_moved`; refuse the paper here, or re-raise it from the current figures."
                      : `The paper's own words changed after this ${d.approval.status} signature was cut, so the `
                        + "hash above is not the one the register would build today. The answer stands on the "
                        + "bytes it was given; a new paper would be cut on the current ones."}
                  </p>
                )}
                <p className="mt-8">
                  <a className="waisha-link text-xs font-semibold" href="/control/approvals">
                    {paperPending ? "Sign or release it on Approvals →" : "See this paper on Approvals →"}
                  </a>
                </p>
              </div>
            ) : (
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                No paper stands on this agreement. {isDraft ? "Put it up below when the figures are the ones "
                  + "the office means." : "It has been answered, or it never was asked."}
              </p>
            )}
          </Field>

          <Press title="Put it up for a signature"
            body="The press that asks a second seat. It writes no figure and makes nothing live: the seat that signs does it on Approvals, through 121's `commission_publish` effect."
            blocked={blockedPublish}
            ready={press.reason.trim().length >= 8}
            busyKey="publish" busy={busy} armed={armed} arm={arm}
            pressName="Raise the paper"
            field={
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Why the office is asking
                <textarea className={`${cell} mt-4 min-h-[70px]`} style={cellStyle} rows={3}
                  placeholder="Two years at 2.5% on the owner’s word; the plan’s own rung would cut them at 4."
                  value={press.reason}
                  onChange={e => setPress(x => ({ ...x, reason: e.target.value }))} /></span></label>
            }
            go={async () => {
              await run("publish", () => desk.call(`/control/pricing/cuts/${cutId}/publish`, "POST",
                { reason: press.reason.trim() }),
              (j) => `${detailOf(j)?.rate.ref ?? r.ref} is out for a second signature against `
                + `${short(j?.payload_sha256 ?? detailOf(j)?.paper_sha256)}. Nobody is cut under it until that `
                + "seat signs.");
            }} />

          {d?.approval && d.approval.status === "pending" && (
            <Press title="Answer the paper with a no"
              body={"The second seat's own duty, from the desk that can see the figures. It frees the draft to "
                + "be edited; it does not delete the paper or the memory of it. The seat that raised the paper "
                + "is not the seat that may answer it: 121 refuses that and tells the office to ask a second "
                + "person (`refused_the_signature_first`)."}
              blocked={blockedRefuse}
              ready={press.refuse_note.trim().length >= 8}
              busyKey="refuse" busy={busy} armed={armed} arm={arm}
              pressName="Refuse the signature"
              field={
                <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                  What is wrong with it
                  <textarea className={`${cell} mt-4 min-h-[70px]`} style={cellStyle} rows={3}
                    placeholder="The floor makes a small invoice more expensive than the plan’s own cut."
                    value={press.refuse_note}
                    onChange={e => setPress(x => ({ ...x, refuse_note: e.target.value }))} /></span></label>
              }
              go={async () => {
                await run("refuse", () => desk.call(`/control/pricing/cuts/${cutId}/refuse`, "POST",
                  { note: press.refuse_note.trim() }),
                (j) => `${detailOf(j)?.rate.ref ?? r.ref} came back as a draft after `
                  + `${detailOf(j)?.rate.refusals ?? r.refusals} refusal`
                  + `${(detailOf(j)?.rate.refusals ?? r.refusals) === 1 ? "" : "s"}. `
                  + "The figure is editable again.");
              }} />
          )}
        </div>

        <Press title="Copy the figure forward as a new version"
          body="The only way a cut that has lived changes: a new draft on the same rung and the same transaction, with the day the new figure starts. The number is copied rather than retyped, because the office is changing one thing, not writing the agreement again from memory."
          blocked={blockedClone}
          ready={/^\d{4}-\d{2}-\d{2}$/.test(press.clone_from.trim())}
          busyKey="clone" busy={busy} armed={armed} arm={arm}
          pressName="Open the next version"
          field={
            <div className="grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                The new cut starts
                <input className={`${cell} mt-4`} type="date" style={cellStyle} value={press.clone_from}
                  onChange={e => setPress(x => ({ ...x, clone_from: e.target.value }))} /></span>
                <span className="mt-4 block text-xs" style={{ color: "var(--ink-soft)" }}>
                  The agreement being replaced is closed the day before — that is only a sentence with a date in it.
                </span>
              </label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                A note on the new version (optional)
                <textarea className={`${cell} mt-4 min-h-[70px]`} style={cellStyle} rows={3}
                  value={press.clone_note}
                  onChange={e => setPress(x => ({ ...x, clone_note: e.target.value }))} /></span></label>
            </div>
          }
          go={async () => {
            await run("clone", () => desk.call(`/control/pricing/cuts/${cutId}/clone`, "POST", {
              effective_from: press.clone_from.trim(),
              note: press.clone_note.trim() || undefined
            }), (j) => `${detailOf(j)?.rate.ref ?? "A new version"} v${detailOf(j)?.rate.version
              ?? ""} is open as a draft from ${press.clone_from}, replacing ${j?.supersedes ?? r.ref}.`);
          }} />

        <Press title="Stop the cut on a day"
          body="One seat, no signature. It stops the office asking for a cut from that day and does not unmake the days it was quoted under — a reading already taken is answered on the readings desk, not here."
          blocked={blockedWithdraw}
          ready={!!stopDay && press.stop_reason.trim().length >= 8}
          busyKey="withdraw" busy={busy} armed={armed} arm={arm}
          pressName="Stop it on that day"
          field={
            <div className="grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                The last day it rules
                <input className={`${cell} mt-4`} type="date" min={desk.today()} style={cellStyle}
                  value={stopDay} onChange={e => setPress(x => ({ ...x, stop_day: e.target.value }))} /></span>
                <span className="mt-4 block text-xs" style={{ color: "var(--ink-soft)" }}>
                  Today is {desk.today()}. A stop in the past would rewrite days a company was already cut under.
                </span>
              </label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Why the office is stopping it
                <textarea className={`${cell} mt-4 min-h-[70px]`} style={cellStyle} rows={3}
                  value={press.stop_reason}
                  onChange={e => setPress(x => ({ ...x, stop_reason: e.target.value }))} /></span></label>
            </div>
          }
          go={async () => {
            await run("withdraw", () => desk.call(`/control/pricing/cuts/${cutId}/withdraw`, "POST", {
              effective_to: stopDay, reason: press.stop_reason.trim()
            }), (j) => `${j?.stopped ?? r.ref} stops on ${j?.effective_to ?? stopDay}`
              + `${j?.open_readings ? ` with ${j.open_readings} reading(s) still owed — they stay owed and `
                + "are carried or voided on the readings desk." : " and nothing was left owing under it."}`);
          }} />

        <Press title="Throw the draft away"
          body="Only a draft that was never signed and never lived. The agreement and its memory rows are deleted; the audit line stays and is the register's proof that it existed, so the reason has to be a sentence."
          blocked={blockedDiscard}
          ready={press.discard_reason.trim().length >= 8}
          busyKey="discard" busy={busy} armed={armed} arm={arm}
          pressName="Discard the draft"
          field={
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Why it is going
              <textarea className={`${cell} mt-4 min-h-[70px]`} style={cellStyle} rows={3}
                placeholder="Typed the percentage on the wrong rung — the office’s standing cut, not theirs."
                value={press.discard_reason}
                onChange={e => setPress(x => ({ ...x, discard_reason: e.target.value }))} /></span></label>
          }
          go={async () => {
            await run("discard", () => desk.call(`/control/pricing/cuts/${cutId}/discard`, "POST",
              { reason: press.discard_reason.trim() }),
            (j) => `${j?.discarded ?? r.ref} was discarded. The audit register keeps the reason: `
              + `${j?.reason ?? press.discard_reason.trim()}.`, true);
          }} />
      </div>

      {/* The version ladder, the readings and the memory all come from the same read as the figure above, so a
          press that moved one of them cannot leave a caption below still describing the old row. */}
      <div className="mt-20 overflow-x-auto">
        <h3 className="mb-8 text-sm font-bold" style={{ color: "var(--ink)" }}>
          Every version of this rung for this transaction
        </h3>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
              <th className={th}>Version</th><th className={th}>Figure</th><th className={th}>Days</th>
              <th className={th}>State</th><th className={th}>Signed / stopped</th>
            </tr>
          </thead>
          <tbody>
            {(d?.versions ?? []).map(v => (
              <tr key={v.id} className="cursor-pointer hover:opacity-80"
                style={{ borderTop: "1px solid var(--adm-line)" }} onClick={() => onGoto(v.id)}>
                <td className={td}>
                  <span className="font-bold">{v.ref}</span>
                  <span className="ml-6 text-xs" style={{ color: "var(--ink-soft)" }}>v{v.version}</span>
                </td>
                <td className={td}>
                  {desk.fig(v.value)}{v.currency ? ` ${v.currency}` : v.basis === "percent_of_amount" ? " %" : ""}
                  <div className="text-xs" style={{ color: "var(--ink-soft)" }}>{v.payee_name}</div>
                </td>
                <td className={td}>
                  <span className="whitespace-nowrap">{v.effective_from ?? "any"}</span>
                  <span className="mx-4" style={{ color: "var(--ink-soft)" }}>→</span>
                  <span className="whitespace-nowrap">{v.effective_to ?? "open"}</span>
                </td>
                <td className={td}><StatusChip status={v.status} /></td>
                <td className={td}>
                  <span className="text-xs">{v.published_by ? `live since ${v.published_at?.slice(0, 10) ?? "?"}`
                    : v.withdrawn_reason ? "stopped" : "never lived"}</span>
                  {v.withdrawn_reason && (
                    <div className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                      {v.withdrawn_reason}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-20 overflow-x-auto">
        <h3 className="mb-8 text-sm font-bold" style={{ color: "var(--ink)" }}>
          The readings this agreement has produced
        </h3>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
              <th className={th}>Reading</th><th className={th}>Cut from</th><th className={th}>Figure</th>
              <th className={th}>State</th><th className={th}>Taken by / carried by</th>
            </tr>
          </thead>
          <tbody>
            {(d?.readings ?? []).map(m => (
              <tr key={m.id} className="cursor-pointer hover:opacity-80"
                style={{ borderTop: "1px solid var(--adm-line)" }}
                onClick={() => onGotoReading(m.id)}>
                <td className={td}>
                  <span className="font-bold">{m.ref}</span>
                  <div className="text-xs" style={{ color: "var(--ink-soft)" }}>{m.assessed_on}</div>
                </td>
                <td className={td}>
                  <span>{m.source_ref ?? "a row the register no longer names"}</span>
                  <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    {desk.fig(m.source_amount)}{m.currency ? ` ${m.currency}` : ""} on it
                  </div>
                </td>
                <td className={td}>
                  <span className="font-bold whitespace-nowrap">
                    {desk.fig(m.figure)}{m.currency ? ` ${m.currency}` : ""}
                  </span>
                </td>
                <td className={td}><StatusChip status={m.status} /></td>
                <td className={td}>
                  <span className="text-xs">{m.assessed_by ?? "a seat this book no longer names"}</span>
                  <div className="mt-4 text-xs" style={{ color: m.carrier_ref ? "var(--success)" : "var(--ink-soft)" }}>
                    {m.carrier_ref ? `carried by ${m.carrier_ref}`
                      : m.void_reason ? `voided — ${m.void_reason}` : "still owed"}
                  </div>
                </td>
              </tr>
            ))}
            {!(d?.readings ?? []).length && (
              <tr><td className={td} colSpan={5}>
                Nothing has been cut under this agreement yet. {liveToday
                  ? "The readings desk takes them against a transaction."
                  : "It rules no transaction until it is live, so nothing can be taken under it."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-20 overflow-x-auto">
        <h3 className="mb-8 text-sm font-bold" style={{ color: "var(--ink)" }}>
          What the office did to this agreement
        </h3>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
              <th className={th}>When</th><th className={th}>What</th><th className={th}>From → to</th>
              <th className={th}>Seat</th><th className={th}>Their sentence</th>
            </tr>
          </thead>
          <tbody>
            {(d?.memory ?? []).map((h, i) => (
              <tr key={`${h.at}-${i}`} style={{ borderTop: "1px solid var(--adm-line)" }}>
                <td className={`${td} whitespace-nowrap`}>{h.at ? h.at.replace("T", " ").slice(0, 16) : "—"}</td>
                <td className={td}>
                  <span className="font-semibold">{h.what}</span>
                  {h.assessment_ref && (
                    <div className="text-xs" style={{ color: "var(--ink-soft)" }}>{h.assessment_ref}</div>
                  )}
                </td>
                <td className={td}>
                  <span className="whitespace-nowrap">{h.old_value ?? "—"}</span>
                  <span className="mx-4" style={{ color: "var(--ink-soft)" }}>→</span>
                  <span className="whitespace-nowrap">{h.new_value ?? "—"}</span>
                  {h.currency && <span className="ml-4 text-xs">{h.currency}</span>}
                </td>
                <td className={td}><span className="text-xs">{h.actor ?? "a seat this book no longer names"}</span></td>
                <td className={td}>
                  <span className="text-xs">{h.said ?? h.reason ?? "no sentence was kept"}</span>
                  {h.reason && h.said && (
                    <div className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{h.reason}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {r.withdrawn_reason && (
        <p className="mt-16 text-xs" style={{ color: "var(--danger)" }}>
          Stopped on {r.withdrawn_at?.slice(0, 10) ?? "a day this row keeps to itself"} by{" "}
          {r.withdrawn_by ?? "a seat"}: {r.withdrawn_reason}
        </p>
      )}
    </section>
  );
}

/** The rung's own word for the half that has to be named: a draft is agreed with a company or inherited from
 *  a plan, and the label the register carries is what a clerk reads, not the key the row holds. */
function rups(rungs: Rung[], kind: string): string {
  const r = rungs.find(x => x.key === kind);
  return r ? `${r.priority}. ${r.label}` : kind;
}
