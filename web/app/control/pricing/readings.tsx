"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Desk } from "./ask";
import { ChoicePicker, Press, StatusChip, type Choice, type Transaction } from "./cuts";

/**
 * The readings and the money that carries them (142; task #420b).
 *
 * A reading is the register saying *this transaction was cut under that agreement, on that day, for that
 * figure*. Nothing on this screen works anything out: `GET /cuts/ask` answers what the cut is before a press,
 * `POST /readings` recomputes it inside its own statement, and what appears below is the answer the register
 * gave — never a percentage multiplied by an amount here. That is 140's argument for the price doors, and it
 * is sharper for a commission, because a cut is arithmetic on a figure the office does not own.
 *
 * Three things this desk deliberately cannot do:
 *
 * **It cannot say a cut has been paid by typing a number.** `Carry the cut` points at a 134 payout or a 133
 * posting and the door reads the money *out of the book* — a payout still `raised`, a `reversed` posting, a
 * movement in another money, a payout aimed at another payee, a posting with no `FEE-INCOME`/`COST-OPS` leg
 * and a leg that does not equal the figure are each refused with their own code
 * (`payout_has_not_moved`, `posting_is_reversed`, `carrier_is_other_money`, `carrier_is_another_payee`,
 * `carrier_has_no_such_leg`, `carrier_does_not_carry_the_cut`). The desk mirrors those checks so a clerk sees
 * the refusal before the press, but the mirror is a convenience: the register is the rule.
 *
 * **It cannot count two monies together.** The count is `GET /control/pricing/summary`, which returns TZS and
 * USD apart because 138 found the defect in a sum. Every figure below is labelled with its money, and there is
 * no grand total on this page.
 *
 * **It cannot discharge from a seat that only prices.** The pointer door asks 133's `control.money.post` as
 * well as the pricing duty, because claiming the book already moved is asserting a fact about the book. When
 * this seat lacks it the press says so (`no_money_duty`) rather than offering a button the door would refuse.
 */

const cell = "w-full rounded-input border px-8 py-8 text-sm";
const cellStyle = { borderColor: "var(--adm-line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const btn = "waisha-btn rounded-input px-16 py-8 text-xs font-semibold";
const th = "border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]";
const td = "border-b px-8 py-8 align-top text-sm";

const PAGE = 30;

/** One reading as the board prints it — every money half is the register's own `::text`, so the fourth decimal
 *  a signature was cut on survives the trip. */
export interface ReadingRow {
  id: string; ref: string; status: string;
  rate_id: string; rate_ref: string; rate_version: number;
  rate_basis: string; rate_value: string; rate_currency: string | null;
  subject_kind: string; subject_name: string;
  payee_kind: string; payee_id: string | null; payee_name: string;
  source_kind: string; source_id: string; source_ref: string;
  source_amount: string; raw_amount: string; figure: string; currency: string;
  assessed_on: string | null; note: string | null;
  assessed_by: string | null; assessed_role: string | null;
  discharged_at: string | null; discharged_by: string | null;
  carrier_kind: string | null; carrier_ref: string | null; discharge_note: string | null;
  voided_at: string | null; voided_by: string | null; void_reason: string | null;
  created_at: string;
}

/** One reading whole. The reading half is the table's own row, returned as a record rather than as a list of
 *  chosen keys, so its money arrives as numbers and its timestamps in Postgres's text form — the shape a desk
 *  has to know it is looking at, because the same figure is text on the board and a number here. */
export interface ReadingDetail {
  ok?: boolean;
  reading: {
    id: string; ref: string; status: string;
    rate_id: string; rate_ref: string; rate_version: number;
    rate_basis: string; rate_value: string; rate_currency: string | null;
    subject_kind: string; subject_name: string;
    payee_kind: string; payee_id: string | null; payee_name: string;
    source_kind: string; source_id: string; source_ref: string;
    source_amount: number; currency: string; raw_amount: number; figure: number;
    assessed_on: string | null; note: string | null;
    carrier_kind: string | null; carrier_id: string | null; carrier_ref: string | null;
    discharge_note: string | null; void_reason: string | null;
    voided_at: string | null; discharged_at: string | null;
    assessed_by: string | null; assessed_role: string | null; created_at: string;
  };
  rate: { id: string; ref: string; status: string; version: number; basis: string; value: string;
    currency: string | null; payee_kind: string; payee_name: string;
    effective_from: string | null; effective_to: string | null; said: string } | null;
  memory: { at: string | null; what: string; said: string | null; old_value: string | null;
    new_value: string | null; currency: string | null; reason: string | null; actor: string | null }[];
  source_now: { ok?: boolean; amount?: number; currency?: string; ref?: string; company?: string | null;
    on_day?: string | null; state?: string | null; error?: string; message?: string } | null;
  carrier: {
    kind: string; id: string; ref: string; status: string; currency?: string;
    amount?: string; fee_amount?: string; payee_kind?: string; payee_name?: string;
    released_at?: string | null; paid_at?: string | null;
    total?: string; posted_on?: string | null; memo?: string | null;
    legs?: { account: string; direction: string; amount: string }[];
  } | null;
}

/** What `GET /cuts/ask` answers: the rung that spoke, the transaction's own money, the raw figure and the
 *  figure after the agreement's least and most. `answer` is the register's word, and two of its three values
 *  carry a `message` written for a clerk rather than a code a desk has to interpret. */
interface Ask {
  ok?: boolean; answer: string; message?: string;
  source?: { ok?: boolean; ref?: string; amount?: number; currency?: string; on_day?: string | null;
    state?: string; company?: string | null; error?: string; message?: string };
  rate?: any;
  raw?: string; figure?: string | null; currency?: string;
  rounded?: boolean; lifted?: boolean; clamped?: boolean;
  asked_on?: string; asked_currency?: string; rate_currency?: string;
  already_assessed?: { id: string; ref: string; status: string; figure: string | null;
    currency: string | null; assessed_on: string | null; rate_ref: string | null;
    carrier_ref: string | null; void_reason: string | null; assessed_by: string | null } | null;
}

interface Count {
  from: string | null; to: string | null;
  by_currency: { currency: string; reading_count: number; open_count: number; open_amount: string;
    discharged_count: number; discharged_amount: string; void_count: number; void_amount: string;
    owed_to_others_amount: string; kept_by_office_amount: string }[];
  by_source: { currency: string; parts: Record<string, unknown> }[];
  by_payee: { currency: string; parts: Record<string, unknown> }[];
  note: string;
}

function qs(parts: Record<string, string>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(parts)) {
    const s = String(v ?? "").trim();
    if (s) out.push(`${k}=${encodeURIComponent(s)}`);
  }
  return out.join("&");
}

/** A record's `timestamptz` comes back in Postgres's own text form (`2026-10-27 07:58:12.34+00`) rather than
 *  the `to_char` shape the board rows carry. The minutes are what a clerk reads; the seconds and the offset
 *  are cut, never converted. */
function stamp(v: unknown): string {
  const s = String(v ?? "");
  if (!s) return "—";
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s.slice(0, 16);
}

const PAYEE_SAYS: Record<string, string> = {
  platform: "kept by the office", company: "owed out to a company",
  driver: "owed out to a driver", staff: "owed out to a staff member"
};

/** The two movements the book itself makes. These are a table CHECK and the door's own enum, not a register —
 *  a third carrier is a migration, because it would have to name a column the legs live in. */
const CARRIERS: [string, string][] = [
  ["payout", "A payout that moved"], ["posting", "A posting in the office's book"]
];

const dayBox = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : "");

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="mt-20 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
      <h3 className="text-sm font-bold" style={{ color: "var(--ink)" }}>{title}</h3>
      {note && <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{note}</p>}
      <div className="mt-12">{children}</div>
    </div>
  );
}

// ============================================================
// take the cut — the question, then the press
// ============================================================

/**
 * One transaction, asked and then cut.
 *
 * The amount is never typed here: the picker hands over an id and `GET /cuts/ask` reads the figure, the money
 * and the day out of the register that owns them. So the preview a clerk presses against is the same arithmetic
 * the door will run — and when the answer is `no_rate` or `money_mismatch` the press is not offered, because
 * the register has said there is no cut to take and a reading of nothing is a row nobody owes.
 */
function TakeCut({ desk, sources, onGoto, refresh }: {
  desk: Desk; sources: Transaction[]; onGoto: (id: string) => void; refresh: () => void | Promise<void>;
}) {
  const [sourceKind, setSourceKind] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [chosen, setChosen] = useState<Choice | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [asking, setAsking] = useState(false);
  const [askFault, setAskFault] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const seq = useRef(0);

  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  // Choosing another transaction is a different question, so the answer, the note and the armed press all
  // belong to the number that was picked rather than to whatever was asked a minute ago.
  useEffect(() => { setAsk(null); setAskFault(null); setNote(""); setArmed(null); }, [sourceKind]);
  useEffect(() => { setAsk(null); setAskFault(null); setArmed(null); }, [sourceId]);

  useEffect(() => {
    if (!sourceKind || !sourceId) { setAsk(null); return; }
    const my = ++seq.current;
    const t = setTimeout(() => {
      setAsking(true);
      desk.call(`/control/pricing/cuts/ask?${qs({ source: sourceKind, source_id: sourceId })}`)
        .then((j: any) => { if (my !== seq.current) return; setAsk(j as Ask); setAskFault(null); })
        .catch((e: Error) => { if (my !== seq.current) return; setAsk(null); setAskFault(e.message); })
        .finally(() => { if (my === seq.current) setAsking(false); });
    }, 200);
    return () => clearTimeout(t);
  }, [sourceKind, sourceId, desk]);

  const src = sources.find(s => s.key === sourceKind);
  const inForce = ask && ask.answer !== "no_rate" ? ask.rate : null;
  const existing = ask?.already_assessed ?? null;
  // The door's own refusal, found from the preview: one agreement names one payee, so a reading already taken
  // under the same paper is the second reading of the same cut. A different paper with the same payee still
  // refuses, and there the door answers — the mirror explains, it never overrules.
  const samePaper = !!existing && !!inForce && existing.rate_ref === inForce.ref;
  const noteOk = !note.trim() || (note.trim().length >= 8 && note.trim().length <= 600);

  const blocked = !desk.can.manage
    ? "Taking a cut writes a reading, and this seat holds no `control.pricing.manage` duty."
    : !ask ? (asking ? "Asking the register what it takes from this transaction…"
      : askFault ? askFault : "Pick the transaction the cut is taken from.")
      : ask.answer === "no_rate"
        ? (ask.message ?? "No agreement puts a cut on this transaction for its day.")
        : ask.answer === "money_mismatch"
          ? (ask.message ?? "A flat cut in one money is not taken out of a transaction in another.")
          : samePaper
            ? `${existing?.ref} already cuts ${inForce?.ref} out of this transaction. A second reading of the `
              + "same cut is the double-count the register exists to refuse; void the first one if its figure "
              + "was wrong (`already_assessed`)."
            : !noteOk ? "A note beside a reading is either nothing or 8-600 characters (`bad_note`)."
              : null;

  async function take() {
    setBusy("assess"); setArmed(null); setAskFault(null);
    try {
      const j = await desk.call("/control/pricing/readings", "POST",
        { source_kind: sourceKind, source_id: sourceId, ...(note.trim() ? { note: note.trim() } : {}) });
      const took = j?.reading?.reading;
      await refresh();
      desk.notify(`${took?.ref ?? "The reading"} is taken: ${desk.fig(took?.figure)} ${took?.currency ?? ""} `
        + `cut from ${took?.source_ref ?? "that transaction"} under ${took?.rate_ref ?? "the agreement"} for `
        + `${took?.payee_kind === "platform" ? "the office" : took?.payee_name ?? "its payee"}. It is owed `
        + "until a movement carries it.");
      setAsk(null); setSourceId(""); setChosen(null); setNote("");
      if (took?.id) onGoto(took.id);
    } catch (e) {
      setAskFault((e as Error).message);
    } finally { setBusy(null); }
  }

  return (
    <div className="rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
      <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>Take the cut a transaction owes</h2>
      <p className="mt-4 text-sm" style={{ color: "var(--ink)" }}>
        One transaction, asked before it is pressed. The register reads the amount, the money and the day out
        of the book that owns them, walks the ladder and answers with the figure — so the number below is the
        number the reading will carry, not a preview this screen assembled.
      </p>

      <div className="mt-16 grid gap-12 lg:grid-cols-2">
        <div>
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>The transaction it is cut from</span>
          <div className="flex flex-wrap gap-8">
            {sources.map(s => (
              <button key={s.key} className={btn}
                style={{
                  background: sourceKind === s.key ? "var(--adm-ink)" : "transparent",
                  color: sourceKind === s.key ? "var(--adm-paper)" : "var(--ink)",
                  border: "1px solid var(--adm-line)"
                }}
                onClick={() => { setSourceKind(s.key); setSourceId(""); setChosen(null); }}>
                {s.label} · {s.side === "in" ? "money in" : "money out"}
              </button>
            ))}
            {!sources.length && <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
              The transaction register has not been read yet — the cuts board carries it.</span>}
          </div>
          {src?.note && <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>{src.note}</p>}
        </div>
        {sourceKind && (
          <ChoicePicker desk={desk} kind={sourceKind} value={sourceId}
            label={`Which ${src?.label ?? sourceKind}`}
            placeholder="a number, a company, an amount"
            nothing="nothing chosen yet"
            savedName={chosen?.ref ?? null}
            hint={sourceKind === "payout"
              ? "A payout is cut from wherever it was raised — the ladder is resolved from the company the "
                + "money lands at."
              : "The list is the register’s own: a cancelled, void, empty or unpaid paper is not offered, "
                + "because there is nothing real to cut from it."}
            onPick={(id, row) => { setSourceId(id); setChosen(row); }} />
        )}
      </div>

      {(ask || asking || askFault) && (
        <div className="mt-16 rounded-input p-12" style={{ background: "var(--milk)", border: "1px solid var(--adm-line)" }}>
          {asking && <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Asking the register…</p>}
          {askFault && <p className="text-sm font-semibold" style={{ color: "var(--danger)" }}>{askFault}</p>}
          {ask && !asking && (
            <>
              <div className="flex flex-wrap items-baseline gap-8">
                <span className="text-sm font-bold" style={{ color: ask.answer === "cut" ? "var(--success)" : "var(--danger)" }}>
                  {ask.answer === "cut" ? "A cut is agreed" : ask.answer === "no_rate"
                    ? "No agreement speaks for this day" : "The monies do not match"}
                </span>
                {ask.answer === "cut" && (
                  <span className="text-base font-bold" style={{ color: "var(--ink)" }}>
                    {desk.fig(ask.figure)} {ask.currency}
                  </span>
                )}
              </div>
              {ask.message && (
                <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>{ask.message}</p>
              )}
              {ask.answer === "no_rate" && Array.isArray(ask.rate?.ladder) && (
                <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  The ladder it walked: {ask.rate.ladder.map((l: any) => l.label).join(" → ")}.
                </p>
              )}
              {ask.source && (
                <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {ask.source.ref} · {desk.fig(ask.source.amount)} {ask.source.currency} ·{" "}
                  {ask.source.state} · the day the rate was read for is {ask.asked_on ?? ask.source.on_day}
                </p>
              )}
              {inForce && (
                <div className="mt-12 grid gap-8 sm:grid-cols-2">
                  <div>
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>The rung that spoke</span>
                    <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {inForce.rung?.label} · {inForce.subject_name}
                    </p>
                    <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                      {inForce.said} · {inForce.ref} version {inForce.version} ·{" "}
                      {inForce.payee_kind === "platform" ? "the office keeps it" : `owed to ${inForce.payee_name}`}
                    </p>
                  </div>
                  <div>
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>The arithmetic</span>
                    <p className="text-sm" style={{ color: "var(--ink)" }}>
                      {desk.fig(ask.raw)} raw{ask.rounded ? ", rounded to the pesa" : ""}
                      {ask.clamped ? ", held down by the most the agreement sets" : ""}
                      {ask.lifted ? ", raised to the least the agreement sets" : ""}
                    </p>
                    <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                      It runs from {inForce.effective_from ?? "the first day"} until{" "}
                      {inForce.effective_to ?? "it is superseded"} — the day it was read for is{" "}
                      {ask.asked_on ?? inForce.asked_on}.
                    </p>
                  </div>
                </div>
              )}
              {existing && (
                <p className="mt-12 text-sm font-semibold" style={{ color: "var(--warning)" }}>
                  Already cut: {existing.ref} · {desk.fig(existing.figure)} {existing.currency} ·{" "}
                  {existing.status} on {existing.assessed_on} under {existing.rate_ref}
                  {existing.carrier_ref ? ` · carried by ${existing.carrier_ref}` : ""}
                  {existing.assessed_by ? ` · taken by ${existing.assessed_by}` : ""}
                </p>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-16">
        <Press title="Take the cut"
          body="The door resolves the rung again inside its own statement, copies the transaction&apos;s figure out of the book and writes the reading. Nothing here is sent as an amount."
          blocked={blocked}
          ready={!!sourceId && !blocked}
          busyKey="assess" busy={busy} armed={armed} arm={arm}
          pressName="Take the cut"
          field={
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Why this reading is being taken now (optional)
              <textarea className={`${cell} mt-4 min-h-[70px]`} style={cellStyle} rows={3} value={note}
                placeholder="The invoice was issued after the month closed and nobody had cut it."
                onChange={e => setNote(e.target.value)} /></span>
              {!noteOk && <span className="mt-4 block text-xs font-semibold" style={{ color: "var(--danger)" }}>
                {note.trim().length}/600 — either nothing or 8 characters at least (`bad_note`).</span>}
            </label>
          }
          go={take} />
      </div>
    </div>
  );
}

// ============================================================
// the count, per money and never across one
// ============================================================

function CutCount({ desk, sources }: { desk: Desk; sources: Transaction[] }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [c, setC] = useState<Count | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        setC(await desk.call(`/control/pricing/summary?${qs({ from: dayBox(from), to: dayBox(to) })}`) as Count);
        setFault(null);
      } catch (e) { setC(null); setFault((e as Error).message); }
      finally { setLoading(false); }
    }, 260);
    return () => clearTimeout(t);
  }, [from, to, desk]);

  const sourceLabel = (k: string) => sources.find(s => s.key === k)?.label ?? k;

  return (
    <Card title="What the office cut, counted per money"
      note="The window is the day each reading was taken for, which is the transaction's own day rather than the day the press happened.">
      <div className="mb-12 grid gap-12 sm:grid-cols-2 lg:max-w-[560px]">
        <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>From
          <input className={`${cell} mt-4`} style={cellStyle} type="date" value={from}
            onChange={e => setFrom(e.target.value)} /></span></label>
        <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>To
          <input className={`${cell} mt-4`} style={cellStyle} type="date" value={to}
            onChange={e => setTo(e.target.value)} /></span></label>
      </div>
      {loading && <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Counting…</p>}
      {fault && <p className="text-sm font-semibold" style={{ color: "var(--danger)" }}>{fault}</p>}
      {c && !loading && (
        <>
          {!c.by_currency?.length && (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
              No reading was taken in this window, in either money.
            </p>
          )}
          <div className="grid gap-12 lg:grid-cols-2">
            {(c.by_currency ?? []).map(g => (
              <div key={g.currency} className="rounded-input p-12"
                style={{ background: "var(--milk)", border: "1px solid var(--adm-line)" }}>
                <div className="flex items-baseline justify-between gap-8">
                  <span className="text-sm font-bold" style={{ color: "var(--ink)" }}>{g.currency}</span>
                  <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                    {g.reading_count} reading{g.reading_count === 1 ? "" : "s"}
                  </span>
                </div>
                <table className="mt-8 w-full border-collapse text-sm">
                  <tbody>
                    {([
                      ["still owed", g.open_count, g.open_amount],
                      ["carried by a movement", g.discharged_count, g.discharged_amount],
                      ["cancelled", g.void_count, g.void_amount],
                      ["owed out to somebody", null, g.owed_to_others_amount],
                      ["kept by the office", null, g.kept_by_office_amount]
                    ] as [string, number | null, string][]).map(([w, n, amount]) => (
                      <tr key={String(w)} style={{ borderTop: "1px solid var(--adm-line)" }}>
                        <td className="py-4 pr-8 text-xs" style={{ color: "var(--ink-soft)" }}>{w}</td>
                        <td className="py-4 pr-8 text-xs tabular-nums">{n === null ? "" : `${n}×`}</td>
                        <td className="py-4 text-right font-semibold tabular-nums" style={{ color: "var(--ink)" }}>
                          {desk.fig(amount)} {g.currency}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {(c.by_source ?? []).filter(x => x.currency === g.currency).map(x => Object.entries(x.parts)
                    .map(([k, v]) => `${sourceLabel(k)} ${desk.fig(v)}`).join(" · ")).join(" — ")}
                </div>
                <div className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {(c.by_payee ?? []).filter(x => x.currency === g.currency).map(x => Object.entries(x.parts)
                    .map(([k, v]) => `${PAYEE_SAYS[k] ?? k} ${desk.fig(v)}`).join(" · ")).join(" — ")}
                </div>
              </div>
            ))}
          </div>
          {c.note && <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>{c.note}</p>}
        </>
      )}
    </Card>
  );
}

// ============================================================
// the readings board
// ============================================================

const PILES: [string, string][] = [["all", "Everything"], ["assessed", "Still owed"],
  ["discharged", "Carried"], ["voided", "Cancelled"]];

export function ReadingsBoard({ desk, sources, onPick, pickedId, nonce, onGotoCut }: {
  desk: Desk; sources: Transaction[];
  onPick: (id: string) => void; pickedId: string | null; nonce: number;
  onGotoCut: (id: string) => void;
}) {
  const [board, setBoard] = useState<{ rows: ReadingRow[]; total: number; counts: Record<string, number> }>(
    { rows: [], total: 0, counts: {} });
  const [f, setF] = useState({ status: "all", source: "", search: "", from: "", to: "", offset: 0 });
  const [fault, setFault] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const read = useCallback(async (q: typeof f) => {
    setLoading(true);
    try {
      const j = await desk.call(`/control/pricing/readings?${qs({
        limit: String(PAGE), offset: String(q.offset),
        status: q.status === "all" ? "" : q.status,
        source: q.source, search: q.search.trim(), from: dayBox(q.from), to: dayBox(q.to)
      })}`);
      setBoard({ rows: (j.rows ?? []) as ReadingRow[], total: Number(j.total ?? 0),
        counts: (j.counts ?? {}) as Record<string, number> });
      setFault(null);
    } catch (e) { setFault((e as Error).message); setBoard({ rows: [], total: 0, counts: {} }); }
    finally { setLoading(false); }
  }, [desk]);

  useEffect(() => {
    const t = setTimeout(() => { void read(f); }, 260);
    return () => clearTimeout(t);
  }, [f, read, nonce]);
  useEffect(() => { setF(x => ({ ...x, offset: 0 })); }, [f.search, f.status, f.source, f.from, f.to]);

  // The piles and the transactions are the door's own filter words, so a chip writes the key the reading
  // asks with — a label would be a sixth transaction the register has never heard of.
  const chip = (on: boolean) => ({
    background: on ? "var(--adm-accent)" : "var(--milk)",
    color: on ? "var(--brand-deep)" : "var(--ink)",
    fontWeight: on ? 800 : 400
  });

  return (
    <>
      <TakeCut desk={desk} sources={sources} onGoto={onPick} refresh={() => read(f)} />

      <Card title="Every cut the register has taken"
        note="The search reaches the reading&apos;s own number, the transaction&apos;s reference, the agreement it was cut under, the rung it was agreed on and the payee it is owed to. A clerk asks “has this invoice been cut?” first, so that is the question this table answers.">
        <div className="mb-12 flex flex-wrap gap-8" role="group" aria-label="Piles of readings">
          {PILES.map(([k, l]) => (
            <button key={k} className={btn} onClick={() => setF(x => ({ ...x, status: k }))}
              aria-pressed={f.status === k} style={chip(f.status === k)}>
              {l}
              <span className="ml-6 font-normal">{k === "all" ? board.total : board.counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="mb-12 flex flex-wrap gap-8" role="group" aria-label="Transactions the cut was taken from">
          {sources.map(s => (
            <button key={s.key} className={btn}
              onClick={() => setF(x => ({ ...x, source: x.source === s.key ? "" : s.key }))}
              aria-pressed={f.source === s.key} style={chip(f.source === s.key)}>
              {s.side === "in" ? "+" : "−"} {s.label}
              <span className="ml-6 font-normal">{board.counts[`src_${s.key}`] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
          <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Find a reading
            <input className={`${cell} mt-4`} style={cellStyle} value={f.search}
              placeholder="CMA-2026-00014, INV-2026-00114, KILISA"
              onChange={e => setF(x => ({ ...x, search: e.target.value }))} /></span></label>
          <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Taken from
            <input className={`${cell} mt-4`} style={cellStyle} type="date" value={f.from}
              onChange={e => setF(x => ({ ...x, from: e.target.value }))} /></span></label>
          <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Taken to
            <input className={`${cell} mt-4`} style={cellStyle} type="date" value={f.to}
              onChange={e => setF(x => ({ ...x, to: e.target.value }))} /></span></label>
          <div className="self-end text-xs" style={{ color: "var(--ink-soft)" }}>
            {board.total} reading{board.total === 1 ? "" : "s"} in this pile
            {board.total > 0 ? ` · showing ${f.offset + 1}–${Math.min(board.total, f.offset + board.rows.length)}` : ""}.
          </div>
        </div>

        {fault && <p className="mb-12 text-sm font-semibold" style={{ color: "var(--danger)" }}>{fault}</p>}
        {loading && !board.rows.length && (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Reading the readings…</p>
        )}
        {!loading && !board.rows.length && !fault && (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
            No cut has been taken in this pile. Nothing here is owing, and nothing here has been cancelled.
          </p>
        )}

        {board.rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
                  <th className={th}>Reading</th><th className={th}>Cut under</th>
                  <th className={th}>Transaction</th><th className={th}>The cut</th>
                  <th className={th}>Owed to</th><th className={th}>Carried by</th>
                </tr>
              </thead>
              <tbody>
                {board.rows.map(r => (
                  <tr key={r.id} className="cursor-pointer" style={{ borderTop: "1px solid var(--adm-line)" }}
                    onClick={() => onPick(r.id)}>
                    <td className={td}>
                      <div className="font-bold" style={{ color: "var(--ink)" }}>{r.ref}</div>
                      <StatusChip status={r.status} />
                      <div className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                        for {r.assessed_on ?? "a day the row keeps to itself"}
                      </div>
                    </td>
                    <td className={td}>
                      <button className="text-sm font-semibold underline decoration-dotted"
                        style={{ color: "var(--ink)" }}
                        onClick={e => { e.stopPropagation(); onGotoCut(r.rate_id); }}>{r.rate_ref}</button>
                      <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
                        v{r.rate_version} · {r.rate_basis === "flat"
                          ? `${r.rate_value} ${r.rate_currency ?? ""}` : `${r.rate_value}%`} · {r.subject_name}
                      </div>
                    </td>
                    <td className={td}>
                      <div className="text-sm" style={{ color: "var(--ink)" }}>{r.source_ref}</div>
                      <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
                        {sources.find(s => s.key === r.source_kind)?.label ?? r.source_kind} ·{" "}
                        {desk.fig(r.source_amount)} {r.currency}
                      </div>
                    </td>
                    <td className={td}>
                      <div className="font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                        {desk.fig(r.figure)} {r.currency}
                      </div>
                      {Number(r.raw_amount) !== Number(r.figure) && (
                        <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
                          {desk.fig(r.raw_amount)} raw, held by the agreement
                        </div>
                      )}
                    </td>
                    <td className={td}>
                      <div className="text-sm" style={{ color: "var(--ink)" }}>
                        {r.payee_kind === "platform" ? "the office keeps it" : r.payee_name}
                      </div>
                      {r.assessed_by && (
                        <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
                          taken by {r.assessed_by}{r.assessed_role ? ` (${r.assessed_role})` : ""}
                        </div>
                      )}
                    </td>
                    <td className={td}>
                      {r.carrier_ref ? (
                        <div className="text-sm" style={{ color: "var(--success)" }}>
                          {r.carrier_kind} {r.carrier_ref}
                          <div className="text-xs" style={{ color: "var(--ink-soft)" }}>
                            on {stamp(r.discharged_at)} by {r.discharged_by ?? "a seat"}
                          </div>
                        </div>
                      ) : r.void_reason ? (
                        <div className="text-xs" style={{ color: "var(--danger)" }}>cancelled — {r.void_reason}</div>
                      ) : (
                        <div className="text-sm font-semibold" style={{ color: "var(--warning)" }}>
                          nothing has carried it
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-12 flex flex-wrap items-center gap-8">
          <button className={btn} disabled={f.offset === 0 || loading}
            onClick={() => setF(x => ({ ...x, offset: Math.max(0, x.offset - PAGE) }))}>Newer {PAGE}</button>
          <button className={btn} disabled={f.offset + PAGE >= board.total || loading}
            onClick={() => setF(x => ({ ...x, offset: x.offset + PAGE }))}>More</button>
        </div>
      </Card>

      <CutCount desk={desk} sources={sources} />
    </>
  );
}

// ============================================================
// one reading, the paper behind it and the movement in front
// ============================================================

/**
 * One reading whole, and the two presses that finish it.
 *
 * The transaction is re-read through `source_now` so a paper that has since been cancelled or refunded is
 * shown with that fact beside the reading rather than hidden — the office still holds the row that says it
 * asked for the cut. The carrier half is read out of 133/134's book, so what is printed under a carried
 * reading is the movement's own figure and legs, not the pointer the desk typed.
 */
export function ReadingPanel({ desk, readingId, onClose, onGotoCut, refresh }: {
  desk: Desk; readingId: string; onClose: () => void; onGotoCut: (id: string) => void;
  refresh: () => void | Promise<void>;
}) {
  const [d, setD] = useState<ReadingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [fault, setFault] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [press, setPress] = useState({ carrier_kind: "payout", carrier_id: "",
    carrier: null as Choice | null, note: "", reason: "" });

  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  const load = useCallback(async () => {
    setLoading(true); setFault(null);
    try {
      setD(await desk.call(`/control/pricing/readings/${readingId}`) as ReadingDetail);
    } catch (e) { setD(null); setFault((e as Error).message); }
    finally { setLoading(false); }
  }, [desk, readingId]);

  // Another row is another reading: the pointer, the note and the armed press belong to the number clicked.
  useEffect(() => {
    void load();
    setArmed(null);
    setPress(x => ({ ...x, carrier_id: "", carrier: null, note: "", reason: "" }));
  }, [readingId, load]);

  const m = d?.reading ?? null;
  const open = m?.status === "assessed";
  const sourceBad = !!d?.source_now && d.source_now.ok === false;

  const noManage = desk.can.manage ? null
    : "This seat holds no `control.pricing.manage` duty, so it reads the register and does not write in it.";
  const noMoney = desk.can.moneyPost ? null
    : "Carrying a cut names a movement in 133’s book, and a seat that cannot write in the book cannot "
      + "claim the book already did. The pointer door answers `no_money_duty` — ask for "
      + "`control.money.post`.";

  const c = press.carrier;
  const figure = Number(m?.figure ?? 0);
  const same = (a?: string | null, b?: string | null) => String(a ?? "") === String(b ?? "");

  /** The pointer checks the door applies, restated from the picker’s own row — the figures come out of
   *  the same registers the door reads them from, so the sentence below is the refusal the press would get. */
  const carrierProblem = (() => {
    if (!m || !c) return null;
    if (c.currency && c.currency !== m.currency) {
      return `It moves ${c.currency} and ${m.ref} is a cut in ${m.currency} (` + "`carrier_is_other_money`)."
        + " One currency per movement is 133’s rule.";
    }
    if (press.carrier_kind === "payout") {
      if (!c.raised_in_this_book) {
        return `${c.detail ?? c.ref} is raised in ${c.book_name ?? "another book"}. The pointer door only looks `
          + "in the office’s own book and answers `no_such_payout`.";
      }
      if (c.state !== "released" && c.state !== "paid") {
        return `${c.ref} is ${c.state}. A raised paper is a plan and an unsigned one is a question; neither is `
          + "money that left (`payout_has_not_moved`).";
      }
      if (m.payee_kind === "platform") {
        if (c.state !== "paid") {
          return `${c.ref} carries a fee of ${c.fee_amount} but has not been paid, so the office’s part `
            + "sits on no income line yet (`fee_is_not_booked_yet`).";
        }
        if (!c.fee_amount || Number(c.fee_amount) !== figure) {
          return `${m.ref} is ${desk.fig(figure)} ${m.currency} the office keeps, and ${c.ref} carries a fee `
            + `of ${c.fee_amount ?? "nothing"} (` + "`carrier_does_not_carry_the_cut`)."
            + " Fix the payout or void the reading, not the pointer.";
        }
      } else {
        if (!same(c.payee_kind, m.payee_kind) || !same(c.payee_id, m.payee_id)) {
          return `${m.ref} is owed to ${m.payee_name} (${m.payee_kind}) and ${c.ref} pays `
            + `${c.payee_name ?? "somebody else"} (${c.payee_kind ?? "?"}) (`
            + "`carrier_is_another_payee`). A cut paid to the wrong person is still owed.";
        }
        if (!c.amount || Number(c.amount) !== figure) {
          return `${m.ref} is ${desk.fig(figure)} ${m.currency} owed to ${m.payee_name}, and ${c.ref} sends `
            + `${c.amount ?? "nothing"} (` + "`carrier_does_not_carry_the_cut`)"
            + ". The gap is the part nobody has been paid.";
        }
      }
      return null;
    }
    if (c.state === "reversed") {
      return `${c.ref} has been reversed. An undone movement cannot be the proof a cut was carried (`
        + "`posting_is_reversed`).";
    }
    const legWord = m.payee_kind === "platform" ? "fee_leg" : "cost_leg";
    const leg = c[legWord as "fee_leg" | "cost_leg"];
    const code = m.payee_kind === "platform" ? `FEE-INCOME${m.currency === "USD" ? "-USD" : ""}`
      : `COST-OPS${m.currency === "USD" ? "-USD" : ""}`;
    if (leg === null || leg === undefined || leg === "") {
      return `${c.ref} has no ${m.payee_kind === "platform" ? "credit" : "debit"} leg on ${code} (`
        + "`carrier_has_no_such_leg`). Post it, or point the reading at the paper that carries it.";
    }
    if (Number(leg) !== figure) {
      return `${m.ref} is ${desk.fig(figure)} ${m.currency} and ${c.ref} books ${leg} to ${code} (`
        + "`carrier_does_not_carry_the_cut`). The two books cannot drift apart on a pointer.";
    }
    return null;
  })();

  const noteOk = press.note.trim().length >= 8 && press.note.trim().length <= 600;
  const reasonOk = press.reason.trim().length >= 8 && press.reason.trim().length <= 600;

  const blockedCarry = !m ? "Nothing loaded yet." : !open
    ? m.status === "discharged"
      ? `${m.ref} is already carried by ${m.carrier_ref}. A cut is paid once, and a second movement pointed at `
        + "it is the double-count the register exists to refuse (`already_carried`)."
        : `${m.ref} was cancelled${m.void_reason ? `: ${m.void_reason}` : ""}. A cancelled reading owes nothing, `
          + "so there is nothing to carry (`is_voided`)."
    : noManage ? noManage
      : noMoney ? noMoney
      : !press.carrier_id ? "Point it at a movement first: the press carries no figure, only a number from "
        + "133’s or 134’s book."
        : carrierProblem ? carrierProblem
          : !noteOk ? "Say in 8-600 characters what carried the cut; the sentence is read beside the "
            + "movement’s own number (`bad_note`)."
            : null;

  const blockedVoid = !m ? "Nothing loaded yet." : noManage
    ? noManage
    : m.status === "voided"
      ? `${m.ref} was already cancelled${m.voided_at ? ` on ${stamp(m.voided_at)}` : ""} — the reason is kept `
        + "above (`already_voided`)."
      : m.status === "discharged"
        ? `${m.ref} was carried by ${m.carrier_ref}. The money moved, so cancelling the reading would leave the `
          + "register disagreeing with the book — answer it in the book, by reversing the posting or letting "
          + "the payout fail (`already_carried`)."
        : !reasonOk ? "Say in 8-600 characters why the reading is cancelled: the sentence is the only thing "
          + "that explains a void to whoever reads the count next month (`bad_reason`)."
          : null;

  async function run(key: string, fn: () => Promise<any>, then: (j: any) => string) {
    setBusy(key); setArmed(null); setFault(null);
    try {
      const j = await fn();
      if (j?.reading) setD(j.reading as ReadingDetail); else await load();
      await refresh();
      desk.notify(then(j));
      setPress(x => ({ ...x, carrier_id: "", carrier: null, note: "", reason: "" }));
    } catch (e) {
      // A refused pointer is a sentence about the movement this panel is staring at, so it is printed here
      // rather than in the strip a page above the fold.
      setFault((e as Error).message);
    } finally { setBusy(null); }
  }

  if (loading && !d) return <p className="mt-20 text-sm" style={{ color: "var(--ink-soft)" }}>Reading the cut…</p>;

  if (!m) {
    return (
      <div className="mt-20 rounded-card border p-16" style={{ borderColor: "var(--danger)" }}>
        <h3 className="text-sm font-bold" style={{ color: "var(--danger)" }}>
          The register would not answer for this reading
        </h3>
        <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>{fault}</p>
        <button className={`${btn} mt-12`} onClick={onClose}>Back to the readings</button>
      </div>
    );
  }

  return (
    <section className="mt-20 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}
      aria-label={`Commission reading ${m.ref}`}>
      <div className="mb-16 flex flex-wrap items-start justify-between gap-12">
        <div>
          <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>{m.ref}</h2>
          <p className="mt-4 text-sm" style={{ color: "var(--ink)" }}>
            {desk.fig(m.figure)} {m.currency} cut from {m.source_ref} for {m.assessed_on ?? "a day the row keeps"}
          </p>
          <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
            {m.payee_kind === "platform" ? "the office keeps it" : `owed out to ${m.payee_name}`} ·{" "}
            {PAYEE_SAYS[m.payee_kind] ?? m.payee_kind} · raw {desk.fig(m.raw_amount)} ·{" "}
            out of {desk.fig(m.source_amount)} {m.currency}
          </p>
        </div>
        <div className="flex items-center gap-8">
          <StatusChip status={m.status} />
          <button className={btn} style={{ border: "1px solid var(--adm-line)", color: "var(--ink)" }}
            onClick={onClose}>Close</button>
        </div>
      </div>

      {fault && (
        <p className="mb-16 rounded-input px-12 py-8 text-sm font-semibold"
          style={{ background: "color-mix(in srgb, var(--danger) 10%, transparent)", color: "var(--danger)" }}>
          {fault}
        </p>
      )}

      <div className="grid gap-16 lg:grid-cols-2">
        <div>
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>The paper it was cut under</span>
          {d?.rate ? (
            <>
              <button className="text-sm font-bold underline decoration-dotted" style={{ color: "var(--ink)" }}
                onClick={() => d.rate && onGotoCut(d.rate.id)}>{d.rate.ref}</button>
              <p className="mt-4 text-sm" style={{ color: "var(--ink)" }}>{d.rate.said}</p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                version {d.rate.version} · copied onto the reading as v{m.rate_version} ·{" "}
                {d.rate.status} · {d.rate.effective_from ?? "no start"}
                {d.rate.effective_to ? ` → ${d.rate.effective_to}` : " → open"}
              </p>
              {d.rate.version !== m.rate_version && (
                <p className="mt-8 text-xs font-semibold" style={{ color: "var(--warning)" }}>
                  The ladder has moved since: this reading was taken at version {m.rate_version} and the
                  agreement is now version {d.rate.version}. The reading keeps the version it was cut on —
                  {m.ref} is not re-costed by a new version.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm" style={{ color: "var(--danger)" }}>
              {m.rate_ref} is not in this book. The register cannot be answered for a paper this office never
              signed (`rate_missing`), and the pointer door refuses a reading whose agreement is gone.
            </p>
          )}
        </div>

        <div>
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>The transaction now</span>
          {sourceBad ? (
            <p className="text-sm" style={{ color: "var(--warning)" }}>
              {d?.source_now?.message ?? "The register that owns this transaction no longer answers for it."}
              {" "}The reading stays: the office still holds the paper that says it asked for the cut.
            </p>
          ) : d?.source_now ? (
            <p className="text-sm" style={{ color: "var(--ink)" }}>
              {d.source_now.ref} · {desk.fig(d.source_now.amount)} {d.source_now.currency} ·{" "}
              {d.source_now.state} · day {d.source_now.on_day}
              {String(d.source_now.amount) !== String(m.source_amount) && (
                <span className="mt-4 block text-xs font-semibold" style={{ color: "var(--warning)" }}>
                  The transaction now carries {desk.fig(d.source_now.amount)} and the reading was taken against{" "}
                  {desk.fig(m.source_amount)}. The cut is not re-costed — void the reading and take it again
                  against the paper that stands.
                </span>
              )}
            </p>
          ) : <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Nothing read back.</p>}
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            Taken by {d?.memory?.find(h => h.what === "assess")?.actor ?? "a seat this book no longer names"}
            {m.assessed_role ? ` (${m.assessed_role})` : ""} on {stamp(m.created_at)}.
            {m.note ? ` Their sentence: ${m.note}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-20 grid gap-16 lg:grid-cols-2">
        <Press title="Carry the cut"
          body="Point the reading at the movement that carried it. No figure is typed and no leg is written — the door reads the money out of 133&apos;s and 134&apos;s book and refuses the pointer when the movement does not carry exactly what the register computed."
          blocked={blockedCarry}
          ready={open && !!press.carrier_id && noteOk && !carrierProblem}
          busyKey="carry" busy={busy} armed={armed} arm={arm}
          pressName="Mark it carried"
          field={
            <>
              <div>
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>What carried it</span>
                <div className="flex flex-wrap gap-8">
                  {CARRIERS.map(([k, l]) => (
                    <button key={k} className={btn}
                      style={{
                        background: press.carrier_kind === k ? "var(--adm-ink)" : "transparent",
                        color: press.carrier_kind === k ? "var(--adm-paper)" : "var(--ink)",
                        border: "1px solid var(--adm-line)"
                      }}
                      onClick={() => setPress(x => ({ ...x, carrier_kind: k, carrier_id: "", carrier: null }))}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <ChoicePicker desk={desk} kind={press.carrier_kind} value={press.carrier_id}
                label={press.carrier_kind === "payout" ? "Which payout moved the money"
                  : "Which posting stands in the office's book"}
                placeholder={press.carrier_kind === "payout" ? "PAY-, a payee, a company" : "MPO-, a memo"}
                nothing="nothing chosen yet"
                savedName={c?.ref ?? null}
                disabled={!open || !!noManage || !!noMoney}
                hint={press.carrier_kind === "payout"
                  ? `The register looks for ${m.payee_kind === "platform"
                      ? `a paid payout whose fee is ${desk.fig(figure)} ${m.currency}`
                      : `a released or paid payout of ${desk.fig(figure)} ${m.currency} to ${m.payee_name}`}.`
                  : `The register looks for ${m.payee_kind === "platform" ? "a credit" : "a debit"} leg of `
                    + `${desk.fig(figure)} ${m.currency} on ${
                      m.payee_kind === "platform" ? "FEE-INCOME" : "COST-OPS"}`
                    + `${m.currency === "USD" ? "-USD" : ""}.`}
                onPick={(id, row) => setPress(x => ({ ...x, carrier_id: id, carrier: row }))} />
              {c && (
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  {c.detail}
                  {c.readings !== undefined && c.kind !== "posting"
                    ? ` · ${c.readings} reading${c.readings === 1 ? "" : "s"} cut from it` : ""}
                  {c.carried !== undefined ? ` · ${c.carried} reading${c.carried === 1 ? "" : "s"} it already carries` : ""}
                </p>
              )}
              {c && Array.isArray(c.legs) && c.legs.length > 0 && (
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  legs: {c.legs.map(l => `${l.direction} ${l.account} ${l.amount}`).join(" · ")}
                </p>
              )}
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                What carried it, in your words
                <textarea className={`${cell} mt-4 min-h-[70px]`} style={cellStyle} rows={3}
                  placeholder="The 134 payout paid Amina the July cut with the fee the office kept."
                  value={press.note} disabled={!open || !!blockedCarry}
                  onChange={e => setPress(x => ({ ...x, note: e.target.value }))} /></span></label>
            </>
          }
          go={() => run("carry", () => desk.call(`/control/pricing/readings/${readingId}/discharge`, "POST",
            { carrier_kind: press.carrier_kind, carrier_id: press.carrier_id, note: press.note.trim() }),
          (j) => j?.message ?? `${j?.ref ?? m.ref} is carried by ${j?.carried_by ?? "the movement"}.`)} />

        <Press title="Cancel the reading"
          body="A wrong cut is kept and stops counting. The row leaves every column of the count except the void one, because the voiding is the evidence that the mistake happened and who corrected it — and it frees the transaction for a corrected reading."
          blocked={blockedVoid}
          ready={!!desk.can.manage && m.status === "assessed" && reasonOk}
          busyKey="void" busy={busy} armed={armed} arm={arm}
          pressName="Cancel it"
          field={
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Why it is cancelled
              <textarea className={`${cell} mt-4 min-h-[70px]`} style={cellStyle} rows={3}
                placeholder="The invoice was refunded in full the week after, so there is no cut on it."
                value={press.reason} disabled={!open}
                onChange={e => setPress(x => ({ ...x, reason: e.target.value }))} /></span>
              {!reasonOk && <span className="mt-4 block text-xs font-semibold" style={{ color: "var(--danger)" }}>
                {press.reason.trim().length}/600 — 8 characters at least (`bad_reason`).</span>}
            </label>
          }
          go={() => run("void", () => desk.call(`/control/pricing/readings/${readingId}/void`, "POST",
            { reason: press.reason.trim() }),
          (j) => `${j?.voided ?? m.ref} is cancelled and drops out of every count except the void column. `
            + `${m.source_ref} is free for a corrected reading — the same cut, taken once.`)} />
      </div>

      {m.status === "discharged" && (
        <Card title={`Carried by ${m.carrier_kind ?? "a movement"} ${m.carrier_ref ?? ""}`}
          note="These are the movement's own columns, read out of the book after the pointer was accepted — not the figure the desk typed.">
          {d?.carrier ? (
            <div className="grid gap-8 sm:grid-cols-2">
              <div><span className={labelCls} style={{ color: "var(--ink-soft)" }}>The movement</span>
                <p className="text-sm" style={{ color: "var(--ink)" }}>
                  {d.carrier.ref} · {d.carrier.status} ·{" "}
                  {desk.fig(d.carrier.kind === "payout" ? d.carrier.amount : d.carrier.total)} {d.carrier.currency}
                </p>
                {d.carrier.kind === "payout" && (
                  <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                    to {d.carrier.payee_name} ({d.carrier.payee_kind}) · fee {desk.fig(d.carrier.fee_amount)}{" "}
                    {d.carrier.currency} · released {stamp(d.carrier.released_at)} · paid {stamp(d.carrier.paid_at)}
                  </p>
                )}
                {d.carrier.kind === "posting" && (
                  <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {d.carrier.memo} · posted {d.carrier.posted_on}
                  </p>
                )}
              </div>
              {Array.isArray(d.carrier.legs) && d.carrier.legs.length > 0 && (
                <div><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Its legs</span>
                  {d.carrier.legs.map((l, i) => (
                    <p key={`${l.account}-${i}`} className="text-sm tabular-nums" style={{ color: "var(--ink)" }}>
                      {l.direction === "debit" ? "dr" : "cr"} {l.account} · {desk.fig(l.amount)}
                    </p>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm" style={{ color: "var(--danger)" }}>
              {m.ref} says it was carried by {m.carrier_ref}, and that movement is no longer in the book. The
              reading stays discharged — the register will not disagree with a mark it already made — but
              somebody has to find the paper it was pointed at.
            </p>
          )}
          {m.discharge_note && (
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              The seat&apos;s sentence: {m.discharge_note} · carried on {stamp(m.discharged_at)} by{" "}
              {d?.memory?.find(h => h.what === "discharge")?.actor ?? "a seat"}
            </p>
          )}
        </Card>
      )}

      {m.status === "voided" && (
        <p className="mt-16 text-sm" style={{ color: "var(--danger)" }}>
          Cancelled on {stamp(m.voided_at)} by {d?.memory?.find(h => h.what === "void")?.actor ?? "a seat"}:{" "}
          {m.void_reason}
        </p>
      )}

      <Card title="What happened to this reading"
        note="The reading's own memory rows — the cut taken, the movement it was pointed at, the cancellation. These are the same rows the agreement's memory carries, filtered to this one reading.">
        {!d?.memory?.length && <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Nothing is kept.</p>}
        {d?.memory?.length ? (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
                <th className={th}>When</th><th className={th}>What</th><th className={th}>From → to</th>
                <th className={th}>Seat</th><th className={th}>Their sentence</th>
              </tr>
            </thead>
            <tbody>
              {d.memory.map((h, i) => (
                <tr key={`${h.at}-${i}`} style={{ borderTop: "1px solid var(--adm-line)" }}>
                  <td className={`${td} whitespace-nowrap`}>{stamp(h.at)}</td>
                  <td className={td}><span className="font-semibold">{h.what}</span></td>
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
        ) : null}
      </Card>
    </section>
  );
}
