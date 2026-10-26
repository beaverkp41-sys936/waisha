"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Corridor, Desk, Dim } from "./ask";

/**
 * One price list, whole (140).
 *
 * The door `pricing_card_detail` returns the header, the lines, the version line the code has travelled
 * through, the paper that is out against it, its last twenty memory rows and the hash the register would
 * cut a signature on. Every write in this file answers with that same object, so what the desk says after
 * a press is the card's new shape rather than an echo of what was typed — which is the only arrangement
 * that is honest about a versioned price: the figures a seat just wrote are the figures the next read
 * returns, or the write did not happen.
 *
 * Three facts decide what may be pressed here, and none of them is a preference:
 * · a card that has been a live price is never edited — it is cloned forward (`already_lived`);
 * · a card whose paper is out changes underneath nobody (`paper_is_out`);
 * · the money is fixed by the first figure written to it (`figures_are_typed`).
 * The buttons that would be refused are shown disabled with the register's own reason, because a clerk
 * who has to discover a rule by pressing a button is a clerk filling an audit register with attempts.
 *
 * This desk never publishes. `POST /cards/:id/publish` raises the paper and prints the hash it was cut
 * on; the signature is spent by the seat that holds it, on the Approvals desk, through 121's effect.
 */

const cell = "w-full rounded-input border px-8 py-8 text-sm";
const cellStyle = { borderColor: "var(--adm-line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const btn = "waisha-btn rounded-input px-16 py-8 text-xs font-semibold";
const th = "border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]";
const td = "border-b px-8 py-8 align-top text-sm";

export interface CardHead {
  id: string; ref: string; code: string; label: string; currency: string; status: string;
  version: number; effective_from: string | null; effective_to: string | null; note: string | null;
  refusals: number; approval_id: string | null; supersedes: string | null;
  published_by: string | null; published_at: string | null; published_note: string | null;
  withdrawn_reason: string | null; withdrawn_at: string | null; created_at: string;
}
export interface Line {
  id: string; scope_key: string; route_id: string | null; route: string; route_label: string | null;
  distance_km: number | null; vehicle_class: string | null; container_type: string | null;
  basis: string; basis_label: string | null; rate: string; min_charge: string | null;
}
export interface Version {
  ref: string; version: number; status: string; effective_from: string | null;
  effective_to: string | null; published_at: string | null; published_by: string | null;
}
export interface Paper {
  id: string; status: string; reason: string | null; proposed_by: string | null;
  proposed_at: string | null; decided_by: string | null; expires_at: string | null;
  payload_sha256: string;
}
export interface Detail {
  card: CardHead; lines: Line[]; versions: Version[]; paper: Paper | null;
  memory: MemRow[]; paper_sha256: string | null;
}
/** A row of the memory — the same shape from `card_detail.memory` and from the paged history read, so
 *  one table prints both. `detail` fills neither `card` nor `actor_role`: the card is already named. */
export interface MemRow {
  id?: string; card?: string; code?: string; what: string; scope: string | null;
  old_value: string | null; new_value: string | null; currency: string | null;
  reason: string | null; actor: string | null; actor_role?: string | null; at: string;
}

const STATUS: Record<string, { label: string; why: string }> = {
  draft: { label: "Draft", why: "nobody is quoting it yet" },
  pending_signature: { label: "Paper out", why: "a second seat is being asked to sign it" },
  published: { label: "Live", why: "this is what a quote reads today" },
  superseded: { label: "Superseded", why: "a newer version carries the price now" },
  withdrawn: { label: "Withdrawn", why: "stopped on purpose, and kept" }
};

/** The register's own shape for a rate and a floor: four decimals on the figure, two on the minimum. */
const RATE_OK = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/;
const MIN_OK = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/;

const EMPTY_LINE = { route: "", vehicle_class: "", container: "", basis: "", rate: "", min_charge: "" };

export function PricingCardPanel({ desk, cardId, dims, corridors, onClose, onGoto, refresh }: {
  desk: Desk; cardId: string; dims: Dim[]; corridors: Corridor[];
  onClose: () => void; onGoto: (id: string) => void; refresh: () => Promise<void>;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [head, setHead] = useState({ label: "", currency: "", effective_from: "", note: "" });
  const [line, setLine] = useState({ ...EMPTY_LINE });
  const [rowReason, setRowReason] = useState("");
  const [press, setPress] = useState({ reason: "", note: "", effective_to: "", clone_from: "", clone_note: "" });
  const [mem, setMem] = useState<{ rows: MemRow[]; total: number; offset: number }>(
    { rows: [], total: 0, offset: 0 });
  const [showAllMem, setShowAllMem] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [localFault, setLocalFault] = useState<string | null>(null);

  const card = d?.card ?? null;
  const canManage = desk.can.manage;
  const canPublish = desk.can.publish;
  const isDraft = card?.status === "draft";
  const isLive = card?.status === "published";
  const isPaperOut = card?.status === "pending_signature";
  const hasFigures = (d?.lines.length ?? 0) > 0;

  // The card is re-read by identity, never by a copy kept in the board row: a press rewrites the status,
  // the version line and the paper, and a panel holding the old shape would go on offering a press the
  // register has just refused to allow.
  const load = useCallback(async () => {
    setLoading(true); setLocalFault(null);
    try {
      const j = await desk.call(`/control/pricing/cards/${cardId}`);
      setD({ ...j, paper: j.approval ?? null } as Detail);
    } catch (e) {
      setLocalFault((e as Error).message);
      setD(null);
    } finally { setLoading(false); }
  }, [cardId, desk]);

  useEffect(() => { void load(); setShowAllMem(false); setLine({ ...EMPTY_LINE }); setArmed(null); }, [load]);

  async function readMemory(offset: number) {
    try {
      const j = await desk.call(`/control/pricing/cards/${cardId}/history?limit=20&offset=${offset}`);
      setMem({ rows: (j.rows ?? []) as MemRow[], total: Number(j.total ?? 0), offset: Number(j.offset ?? offset) });
    } catch (e) { setLocalFault((e as Error).message); }
  }

  useEffect(() => { if (showAllMem) void readMemory(0); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [showAllMem]);

  /** Every press ends the same way: the door's own answer becomes the panel's shape, the board above is
   *  re-read, and the sentence the register wrote is what the clerk is left holding. */
  async function run(key: string, fn: () => Promise<any>, then: (j: any) => string) {
    setBusy(key); setLocalFault(null); setArmed(null);
    try {
      const j = await fn();
      const fresh = j?.card?.card ? j.card : j;
      const shown = fresh?.card ? ({ ...fresh, paper: fresh.approval ?? null } as Detail) : null;
      // Cloning is the one press whose answer is a card other than the one this panel was opened on, and
      // every read and write below is addressed by `card.id`. So the desk follows the clone rather than
      // offering a live list's pens to a draft that has not been edited yet.
      if (shown && shown.card.id !== cardId) {
        await refresh();
        desk.notify(then(j));
        onGoto(shown.card.id);
        return;
      }
      if (shown) setD(shown);
      await refresh();
      desk.notify(then(j));
    } catch (e) {
      // A refused press still says something the desk could not know on its own — that the paper is out,
      // that the money is already typed, that a corridor is priced twice — so it is reported here, inside
      // the card that provoked it, rather than in the strip a page above the fold.
      setLocalFault((e as Error).message);
    } finally { setBusy(null); }
  }

  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  // A patch sends only the halves that changed: the door keeps an absent key at its current value, and a
  // body that asks for nothing is refused, because every call that reaches it is audited.
  function changedHead() {
    if (!card) return null;
    const body: Record<string, string> = {};
    if (head.label.trim() && head.label.trim() !== card.label) body.label = head.label.trim();
    if (head.currency && head.currency !== card.currency) body.currency = head.currency;
    if (head.effective_from && head.effective_from !== (card.effective_from ?? "")) {
      body.effective_from = head.effective_from;
    }
    if (head.note.trim() && head.note.trim() !== (card.note ?? "")) body.note = head.note.trim();
    return Object.keys(body).length ? body : null;
  }
  const headPatch = changedHead();

  const rateOk = RATE_OK.test(line.rate.trim());
  const minOk = !line.min_charge.trim() || MIN_OK.test(line.min_charge.trim());
  const lineReady = !!line.basis && rateOk && minOk && !!line.rate.trim();
  const sameScopeLine = d?.lines.find(l => l.scope_key === scopeKeyOf(line));

  if (loading && !d) {
    return (
      <section className="mt-24 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Reading the list…</p>
      </section>
    );
  }
  if (!card) {
    return (
      <section className="mt-24 rounded-card border p-16" style={{ borderColor: "var(--danger)" }}>
        <p className="text-sm font-semibold" style={{ color: "var(--danger)" }}>{localFault
          ?? "That price list could not be read."}</p>
        <button className={`${btn} mt-12`} onClick={onClose}>Back to the board</button>
      </section>
    );
  }

  return (
    <section className="mt-24 rounded-card border p-16" style={{ borderColor: "var(--adm-accent)" }}>
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div>
          <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
            {card.ref} · v{card.version} — {card.label}
          </h2>
          <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
            {card.code} · {card.currency} · {(STATUS[card.status]?.label ?? card.status)}
            {" "}({STATUS[card.status]?.why ?? "an unusual state"}) · {d?.lines.length ?? 0}{" "}
            {d?.lines.length === 1 ? "figure" : "figures"} · opens {card.effective_from ?? "with no start"}
            {card.effective_to ? `, ends ${card.effective_to}` : ", with no end"}
          </p>
        </div>
        <button className={btn} onClick={onClose}>Close</button>
      </div>

      {localFault && (
        <div className="mt-12 rounded-input px-12 py-8 text-sm" role="alert"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {localFault}
        </div>
      )}

      {/* What the register will and will not accept for this card, in its own words, said before the
          press rather than after it. */}
      <p className="mt-12 rounded-input px-12 py-8 text-xs"
        style={{ background: "var(--milk)", borderLeft: "4px solid var(--adm-line)", color: "var(--ink)" }}>
        {isDraft && canManage
          ? `${card.ref} is a draft: its figures are yours to write, and the money is fixed by the first line.`
          : isDraft
            ? `${card.ref} is a draft, and this seat holds no ${"control.pricing.manage"}, so it reads the `
              + "figures but cannot write them."
          : isPaperOut
            ? `${card.ref} is waiting for a second seat. Nothing on it changes — header or figures — until `
              + "a seat holding control.pricing.publish refuses the paper."
            : card.published_at
              ? `${card.ref} was a live price${card.published_by ? `, signed by ${card.published_by}` : ""}. `
                + "A version a customer was quoted is kept exactly as it was signed, so it is cloned forward "
                + "rather than edited."
              : `${card.ref} is ${card.status}, so its figures are kept. Clone it to carry them forward.`}
      </p>

      {card.withdrawn_reason && (
        <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>
          Stopped {card.withdrawn_at?.slice(0, 10) ?? "on a day the register names"}: {card.withdrawn_reason}
        </p>
      )}
      {card.refusals > 0 && (
        <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
          A second seat has refused this paper {card.refusals} {card.refusals === 1 ? "time" : "times"}.
          Each refusal is kept against the list, not written over it.
        </p>
      )}

      {/* ---------------------------------------------------------- the paper */}
      {d?.paper && (
        <div className="mt-16 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
          <h3 className="text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
            {/* A refused paper is kept but nothing waits on it, so only a pending one is "out". */}
            {d.paper.status === "pending" ? "The paper out against it"
              : "The paper it kept, and how it ended"}
          </h3>
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            {d.paper.status} · raised by {d.paper.proposed_by ?? "a seat the register cannot name"} on{" "}
            {d.paper.proposed_at?.slice(0, 16).replace("T", " ") ?? "a day the register holds"}
            {d.paper.expires_at ? ` · expires ${d.paper.expires_at.slice(0, 16).replace("T", " ")}` : ""}
            {d.paper.decided_by ? ` · decided by ${d.paper.decided_by}` : ""}
          </p>
          {d.paper.reason && (
            <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>“{d.paper.reason}”</p>
          )}
          {/* The desk's own derived fact: the hash the signature was cut on against the hash of the
              figures now on the card. Two different strings mean the applying seat will be refused. */}
          <p className="mt-12 text-xs"
            style={{ color: d.paper.payload_sha256 === d.paper_sha256 ? "var(--success)" : "var(--danger)" }}>
            {d.paper.payload_sha256 === d.paper_sha256
              ? `The paper is cut on the figures now on the card — ${short(d.paper_sha256)}.`
              : `The figures moved after the paper was raised: it was cut on ${short(d.paper.payload_sha256)} `
                + `and this card now reads ${short(d.paper_sha256)}. The signature will be refused with `
                + "`paper_moved`, and the office is right to refuse it — a seat must sign what it was shown."}
          </p>
          {isPaperOut && canPublish && (
            <div className="mt-12">
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Say why the paper is refused — it is the sentence the next version answers
                <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} value={press.note}
                  maxLength={600} onChange={e => setPress(x => ({ ...x, note: e.target.value }))} /></span></label>
              <button className={`${btn} mt-8`} disabled={press.note.trim().length < 8 || busy !== null}
                onClick={arm(`refuse`, () => void run("refuse",
                  () => desk.call(`/control/pricing/cards/${card.id}/refuse`, "POST", { note: press.note.trim() }),
                  (j) => `${card.ref} is back to a draft${j.refusals ? `, refused its ${j.refusals}th time` : ""} — `
                    + "the figures are editable again."))}>
                {armed === "refuse" ? "Press again to refuse the paper"
                  : busy === "refuse" ? "Refusing…" : "Refuse this paper"}
              </button>
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                Refusing is the duty <code>control.pricing.publish</code> holds, because it is the same
                authority as signing: the seat that may say no is the seat that may say yes. Signing itself
                happens on the Approvals desk, never here.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------- the figures */}
      <h3 className="mt-20 text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
        The figures
      </h3>
      <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
        One line per scope, keyed on corridor · class · container · basis. A line that names a corridor
        beats one that names only a class when a quote is asked, and the least specific of all is the
        wildcard. Writing a scope that already stands replaces its figure, and the office&rsquo;s audit log
        keeps the one it replaced.
      </p>

      {d && d.lines.length === 0 && (
        <p className="mb-12 text-sm" style={{ color: "var(--ink-soft)" }}>
          This list carries no figures yet. The register refuses to put an empty list up for a signature —{" "}
          <em>a signature that approves an empty list approves whatever is typed next.</em>
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
              <th className={th} style={{ borderColor: "var(--adm-line)" }}>Scope</th>
              <th className={th} style={{ borderColor: "var(--adm-line)" }}>Priced by</th>
              <th className={th} style={{ borderColor: "var(--adm-line)" }}>Rate</th>
              <th className={th} style={{ borderColor: "var(--adm-line)" }}>Never under</th>
              {isDraft && canManage && <th className={th} style={{ borderColor: "var(--adm-line)" }}>&nbsp;</th>}
            </tr>
          </thead>
          <tbody>
            {(d?.lines ?? []).map(l => (
              <tr key={l.id}>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  <span className="block font-semibold" style={{ color: "var(--ink)" }}>
                    {l.route_id ? (l.route_label || l.route) : "any corridor"}
                  </span>
                  <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                    {labelOf(dims, "vehicle_class", l.vehicle_class) || "any class"}
                    {" · "}{labelOf(dims, "container", l.container_type) || "no container"}
                    {l.distance_km !== null ? ` · ${l.distance_km} km on file` : ""}
                  </span>
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {l.basis_label ?? l.basis}
                  <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>{l.basis}</span>
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {/* Printed as the column returns it: a rate is numeric(14,4) because 900 km at a figure
                      rounded to two decimals is a different price. */}
                  <span className="font-mono">{l.rate}</span>
                  <span className="ml-8 text-xs">{card.currency}</span>
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {l.min_charge ? <span className="font-mono">{l.min_charge}</span> : "—"}
                </td>
                {isDraft && canManage && (
                  <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                    <button className="text-xs underline"
                      style={{ color: armed === `line:${l.id}` ? "var(--danger)" : "var(--ink-soft)" }}
                      disabled={busy !== null}
                      onClick={arm(`line:${l.id}`, () => void run(`line:${l.id}`,
                        () => desk.call(`/control/pricing/lines/${l.id}`, "DELETE"),
                        () => `The ${l.basis_label ?? l.basis} figure on ${l.scope_key} is off ${card.ref}. `
                          + "The removal is in the office's audit log — this book remembers only figures a "
                          + "signature put live."))}>
                      {armed === `line:${l.id}` ? "Press again to remove" : "remove"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {isDraft && canManage && (
        <div className="mt-16 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
          <h4 className="text-sm font-bold" style={{ color: "var(--ink)" }}>Put a figure on one scope</h4>
          <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
            The corridor has to be one of this book&rsquo;s roads — pick it on the Roads tab first if the list
            below is empty. A per-kilometre figure is refused on a corridor nobody measured, because the
            register will not invent the half of a multiplication.
          </p>
          <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Corridor
              <select className={`${cell} mt-4`} style={cellStyle} value={line.route}
                onChange={e => setLine(x => ({ ...x, route: e.target.value }))}>
                <option value="">any corridor (wildcard)</option>
                {corridors.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.distance_km === null ? " (no distance filed)" : ` — ${c.distance_km} km`}
                  </option>
                ))}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Vehicle class
              <select className={`${cell} mt-4`} style={cellStyle} value={line.vehicle_class}
                onChange={e => setLine(x => ({ ...x, vehicle_class: e.target.value }))}>
                <option value="">any class</option>
                {dims.filter(x => x.kind === "vehicle_class").map(x => (
                  <option key={x.key} value={x.key}>{x.label}</option>
                ))}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Container kind
              <select className={`${cell} mt-4`} style={cellStyle} value={line.container}
                onChange={e => setLine(x => ({ ...x, container: e.target.value }))}>
                <option value="">not a container</option>
                {dims.filter(x => x.kind === "container").map(x => (
                  <option key={x.key} value={x.key}>{x.label}</option>
                ))}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Priced by
              <select className={`${cell} mt-4`} style={cellStyle} value={line.basis}
                onChange={e => setLine(x => ({ ...x, basis: e.target.value }))}>
                <option value="">choose the noun the price multiplies</option>
                {dims.filter(x => x.kind === "basis").map(x => (
                  <option key={x.key} value={x.key}>{x.label}</option>
                ))}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Rate in {card.currency}
              <input className={`${cell} mt-4`} style={cellStyle} value={line.rate} inputMode="decimal"
                placeholder="4250.0000" onChange={e => setLine(x => ({ ...x, rate: e.target.value }))} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Never under (optional)
              <input className={`${cell} mt-4`} style={cellStyle} value={line.min_charge} inputMode="decimal"
                placeholder="250000.00"
                onChange={e => setLine(x => ({ ...x, min_charge: e.target.value }))} /></span></label>
          </div>

          <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
            {line.basis && dims.find(x => x.kind === "basis" && x.key === line.basis)?.needs === "distance_km"
              ? "A per-kilometre price needs a corridor with a distance filed against it: the kilometres are "
                + "read off the road, never typed here."
              : sameScopeLine
                ? `That scope already stands at ${sameScopeLine.rate} ${card.currency}. Pressing writes the new `
                  + "figure over it — one line, not two — and the figure it replaced stays in the office's "
                  + "audit log until a signature puts the pair into this book."
              : "The money is the card’s, not the line’s: a TZS list prices in TZS."}
          </p>
          {(!rateOk || !minOk) && (
            <p className="mt-8 text-xs font-semibold" style={{ color: "var(--danger)" }}>
              {RATE_OK.test(line.rate.trim() || "0") ? "" : "A rate is whole units or up to four decimals, with no separators. "}
              {MIN_OK.test(line.min_charge.trim() || "0") ? "" : "A minimum is whole units or up to two decimals."}
            </p>
          )}

          <div className="mt-12 flex flex-wrap items-center gap-12">
            <button className={btn} disabled={!lineReady || busy !== null}
              onClick={() => void run("line", () => desk.call(`/control/pricing/cards/${card.id}/lines`, "PUT", {
                route: line.route || undefined, vehicle_class: line.vehicle_class || undefined,
                container: line.container || undefined, basis: line.basis, rate: line.rate.trim(),
                min_charge: line.min_charge.trim() || undefined
              }), (j) => {
                const n = j?.lines?.length ?? 0;
                return `${card.ref} now prices ${labelOf(dims, "basis", line.basis)}`
                  + (line.route ? ` along ${corridors.find(c => c.id === line.route)?.name ?? "that corridor"}` : "")
                  + ` at ${line.rate.trim()} ${card.currency}`
                  + (line.min_charge.trim() ? `, never under ${line.min_charge.trim()}` : "")
                  + ` — ${n} ${n === 1 ? "figure" : "figures"} on the list.`;
              })}>
              {busy === "line" ? "Writing…" : sameScopeLine ? "Replace that figure" : "Write the figure"}
            </button>
            <button className="text-xs underline" style={{ color: "var(--ink-soft)" }}
              onClick={() => setLine({ ...EMPTY_LINE })}>clear</button>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- the header */}
      {isDraft && canManage && (
        <div className="mt-16 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
          <h4 className="text-sm font-bold" style={{ color: "var(--ink)" }}>Change what the list is called</h4>
          <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
            Only the halves you change are sent. The code and the version are the register&rsquo;s own, and
            the money cannot be swapped once the first figure is written on it.
          </p>
          <div className="grid gap-12 sm:grid-cols-2">
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Label
              <input className={`${cell} mt-4`} style={cellStyle} defaultValue={card.label} maxLength={80}
                onChange={e => setHead(x => ({ ...x, label: e.target.value }))} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Money
              <select className={`${cell} mt-4`} style={cellStyle}
                disabled={hasFigures} value={head.currency || card.currency}
                onChange={e => setHead(x => ({ ...x, currency: e.target.value }))}>
                <option value="TZS">TZS</option>
                <option value="USD">USD</option>
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              In force from
              <input className={`${cell} mt-4`} style={cellStyle} value={head.effective_from}
                placeholder={card.effective_from ?? "the day it starts"}
                onChange={e => setHead(x => ({ ...x, effective_from: e.target.value }))} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Note for the second seat
              <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
                defaultValue={card.note ?? ""}
                onChange={e => setHead(x => ({ ...x, note: e.target.value }))} /></span></label>
          </div>
          {hasFigures && (
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              The money is stopped: {card.ref} already carries {d?.lines.length}{" "}
              {d?.lines.length === 1 ? "figure" : "figures"}, and a TZS rate relabelled USD is not a price
              in USD. Open a new list instead.
            </p>
          )}
          <button className={`${btn} mt-12`} disabled={!headPatch || busy !== null}
            onClick={() => void run("head",
              () => desk.call(`/control/pricing/cards/${card.id}`, "PATCH", headPatch ?? {}),
              () => `${card.ref} ${Object.keys(headPatch ?? {}).join(", ")} saved as the register holds it.`)}>
            {busy === "head" ? "Saving…" : headPatch
              ? `Save ${Object.keys(headPatch).join(" · ")}` : "Nothing to save"}
          </button>
        </div>
      )}

      {/* ---------------------------------------------------------- the presses */}
      <div className="mt-20 grid gap-16 lg:grid-cols-2">
        {isDraft && canPublish && (
          <Press title="Put it up for a second seat"
            body={`${card.ref} carries ${d?.lines.length} ${d?.lines.length === 1 ? "figure" : "figures"}. `
              + "Raising the paper hashes exactly those figures, and the hash below is what the other seat "
              + "signs — this desk never makes a price live."}
            blocked={!hasFigures || !card.effective_from
              ? (!hasFigures
                ? "The register refuses a paper with no figures on it: a signature over an empty list is a "
                  + "signature over whatever is typed next."
                : `${card.ref} has no start date, so the resolver could never tell which day it was the `
                  + "price for. Set \u201cin force from\u201d above first.")
              : null}
            field={<label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                The sentence the second seat signs
                <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
                  value={press.reason} onChange={e => setPress(x => ({ ...x, reason: e.target.value }))} /></span></label>}
            busy={busy} busyKey="publish" armed={armed} arm={arm}
            pressName="Raise the paper"
            ready={press.reason.trim().length >= 8}
            go={() => run("publish",
              () => desk.call(`/control/pricing/cards/${card.id}/publish`, "POST", { reason: press.reason.trim() }),
              (j) => `${j.ref ?? card.ref} v${j.version} is on ${j.lines} figures, and the paper is cut on `
                + short(j.payload_sha256) + ". A seat holding the signature — not this one — decides it.")} />
        )}

        {isDraft && canManage && (
          <Press title="Throw away this draft"
            body={"A draft nobody has been asked to sign is thrown away: the card and its figures are gone, "
              + "and only the audit line will remember it existed. The reason you type is what that line says."}
            blocked={card.approval_id
              ? "A paper was raised on this draft, so the register keeps it. A card a seat was asked to sign "
                + "is not thrown away even when that seat refused it — clone it forward, or leave it as the "
                + "book’s own record of the refusal."
              : null}
            field={<label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Why it is thrown away
                <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
                  value={rowReason} onChange={e => setRowReason(e.target.value)} /></span></label>}
            busy={busy} busyKey="discard" armed={armed} arm={arm}
            pressName="Throw away the draft"
            ready={rowReason.trim().length >= 8}
            warn="This closes the list. Nothing is priced and nothing is signed, and it cannot be undone."
            go={() => run("discard",
              () => desk.call(`/control/pricing/cards/${card.id}/discard`, "POST", { reason: rowReason.trim() }),
              (j) => { onClose(); return `${j.discarded ?? card.ref} was thrown away — nothing was priced `
                + "and nothing was signed. The board has been re-read."; })} />
        )}

        {isLive && canManage && (
          <Press title="Stop this price"
            body={"One seat, no signature: stopping a wrong figure is the act that keeps it out of tomorrow's "
              + "quotes. The list stays in the book with its reason against it."}
            blocked={null}
            field={<>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                  Stops on (today or later)
                  <input className={`${cell} mt-4`} style={cellStyle} value={press.effective_to}
                    placeholder={desk.today()}
                    onChange={e => setPress(x => ({ ...x, effective_to: e.target.value }))} /></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                  Why it is stopped
                  <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
                    value={press.reason} onChange={e => setPress(x => ({ ...x, reason: e.target.value }))} /></span></label>
            </>}
            busy={busy} busyKey="withdraw" armed={armed} arm={arm}
            pressName="Withdraw it"
            ready={press.reason.trim().length >= 8 && /^\d{4}-\d{2}-\d{2}$/.test(press.effective_to.trim())}
            go={() => run("withdraw",
              () => desk.call(`/control/pricing/cards/${card.id}/withdraw`, "POST", {
                effective_to: press.effective_to.trim() || desk.today(), reason: press.reason.trim()
              }),
              () => `${card.ref} stops on ${press.effective_to.trim() || desk.today()}. A quote asked for that `
                + "day now answers no_price until another version stands.")} />
        )}

        {!isDraft && !isPaperOut && canManage && (
          <Press title="Clone it forward"
            body={"This is how a live price changes, and it is also the rollback: copy the version, edit the "
              + "copy, and sign it. No figure in the memory is ever rewritten."}
            blocked={null}
            field={<>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                  The new version starts (today or later)
                  <input className={`${cell} mt-4`} style={cellStyle} value={press.clone_from}
                    placeholder={desk.today() + " — blank is the register's own today"}
                    onChange={e => setPress(x => ({ ...x, clone_from: e.target.value }))} /></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                  What this version is for
                  <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
                    defaultValue={card.note ?? ""}
                    onChange={e => setPress(x => ({ ...x, clone_note: e.target.value }))} /></span></label>
            </>}
            busy={busy} busyKey="clone" armed={armed} arm={arm}
            pressName={`Clone ${card.ref} to v${(d?.versions?.[0]?.version ?? card.version) + 1}`}
            ready={press.clone_note.trim().length >= 8}
            go={() => run("clone",
              () => desk.call(`/control/pricing/cards/${card.id}/clone`, "POST", {
                effective_from: press.clone_from.trim() || undefined,
                note: press.clone_note.trim() || undefined
              }),
              (j) => { setPress(x => ({ ...x, clone_from: "", clone_note: "" }));
                const nc = j?.card?.card ?? j;
                return `${nc?.card?.ref ?? "A new version"} v${nc?.card?.version ?? ""} is open as a draft with `
                  + `${nc?.lines?.length ?? 0} figures carried over — ${card.ref} itself is untouched.`; })} />
        )}
      </div>

      {/* ---------------------------------------------------------- the version line */}
      <h3 className="mt-24 text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
        {card.code} — the version line
      </h3>
      <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
        Every version this code has ever been, newest first. Two of them may hold the same figures; only
        one may be the price on a given day, and the resolver is what decides that.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
              {["Version", "Reference", "State", "Window", "Signed", "By"].map(h => (
                <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(d?.versions ?? []).map(v => (
              <tr key={v.ref} style={v.ref === card.ref ? { background: "color-mix(in srgb, var(--adm-accent) 8%, transparent)" } : undefined}>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>v{v.version}</td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  <span className="font-mono">{v.ref}</span>
                  {v.ref === card.ref ? <span className="ml-8 text-xs">· open here</span> : null}
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {STATUS[v.status]?.label ?? v.status}</td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {v.effective_from ?? "—"} → {v.effective_to ?? "no end"}
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {v.published_at ? v.published_at.slice(0, 10) : "never"}
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>{v.published_by ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------------------------------------------------------- the memory */}
      <h3 className="mt-24 text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
        What changed, and who changed it
      </h3>
      <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
        Written by the register itself, not by the desk: the figure a signature replaced, the day a window
        was closed, the state a paper moved into — each with the seat and the sentence that did it. It opens
        at the signature: what a draft was typed and re-typed is kept in the office&rsquo;s audit log, and a
        price that never went live never entered this book.
      </p>
      <MemoryTable rows={showAllMem ? mem.rows : (d?.memory ?? [])} draft={isDraft} />
      <div className="mt-12 flex flex-wrap items-center gap-12">
        {!showAllMem ? (
          // A draft's memory is empty before the door is even knocked on, so pressing to read it would
          // return a page of nothing and leave the clerk doubting the log the typing really went to.
          (d?.memory ?? []).length === 0 ? null : (
            <button className={btn} onClick={() => setShowAllMem(true)}
              style={{ background: "var(--milk)", color: "var(--ink)" }}>
              {mem.total ? `Read all ${mem.total} rows of its memory` : "Read the whole memory"}
            </button>
          )
        ) : (
          <>
            <button className={btn} disabled={mem.offset <= 0 || busy !== null}
              onClick={() => void readMemory(Math.max(0, mem.offset - 20))}>Newer 20</button>
            <button className={btn} disabled={mem.offset + mem.rows.length >= mem.total || busy !== null}
              onClick={() => void readMemory(mem.offset + 20)}>Older 20</button>
            <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
              rows {mem.offset + 1}–{mem.offset + mem.rows.length} of {mem.total}
            </span>
            <button className="text-xs underline" style={{ color: "var(--ink-soft)" }}
              onClick={() => setShowAllMem(false)}>back to the last twenty</button>
          </>
        )}
      </div>
    </section>
  );
}

/** The memory is the register's own book of changes, and a draft has no entry in it: 140 writes here when
 *  a signature publishes a version or a window closes, not when a clerk types. The sentence says so,
 *  because an empty table under "every figure that was replaced" reads like the register forgot. */
function MemoryTable({ rows, draft }: { rows: MemRow[]; draft: boolean }) {
  if (!rows.length) {
    return (
      <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
        {draft
          ? "Nothing here yet, and nothing is missing: this list is a draft, and the register opens its "
            + "memory at the signature that puts a price live. The figures typed on it are in the office's "
            + "audit log until then."
          : "The register has written nothing in this book for this list. It writes here when a signature "
            + "publishes a version, when a window closes, or when a live price is stopped."}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
            {["When", "What", "Scope", "From", "To", "Said", "By"].map(h => (
              <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((m, i) => (
            <tr key={m.id ?? `${m.at}-${i}`}>
              <td className={`${td} whitespace-nowrap`} style={{ borderColor: "var(--adm-line)" }}>
                {m.at.slice(0, 16).replace("T", " ")}
              </td>
              <td className={td} style={{ borderColor: "var(--adm-line)" }}>{m.what}</td>
              <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                <span className="font-mono text-xs">{m.scope ?? "—"}</span>
              </td>
              <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                {m.old_value ? <span className="font-mono">{m.old_value}</span> : "—"}
              </td>
              <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                {m.new_value ? <span className="font-mono">{m.new_value}</span> : "—"}
              </td>
              <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                <span className="text-xs">{m.reason ?? "—"}</span>
              </td>
              <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                {m.actor ?? "a seat the register cannot name"}
                {m.actor_role ? <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>{m.actor_role}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A press that the register's own rule may refuse. `blocked` is written out rather than hidden: a seat
 *  that cannot raise a paper needs to know which half of the card is missing, not that a button is
 *  absent. `busyKey` is the key the press is run under, so the panel can say which of its four buttons
 *  the register is answering. */
function Press({ title, body, blocked, field, go, pressName, ready, busyKey, busy, armed, arm, warn }: {
  title: string; body: string; blocked: string | null; field: ReactNode;
  go: () => Promise<void>; pressName: string; ready: boolean; busyKey: string;
  busy: string | null; armed: string | null; arm: (k: string, f: () => void) => () => void;
  warn?: string;
}) {
  const key = title.toLowerCase().replace(/\W+/g, "-");
  return (
    <div className="rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
      <h4 className="text-sm font-bold" style={{ color: "var(--ink)" }}>{title}</h4>
      <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>{body}</p>
      {blocked && (
        <p className="mb-12 rounded-input px-12 py-8 text-xs"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", color: "var(--danger)" }}>
          {blocked}
        </p>
      )}
      <div className="grid gap-12">{field}</div>
      {warn && <p className="mt-8 text-xs font-semibold" style={{ color: "var(--danger)" }}>{warn}</p>}
      <button className={`${btn} mt-12`} disabled={!!blocked || !ready || busy !== null}
        onClick={arm(key, () => void go())}>
        {armed === key ? "Press again to confirm"
          : busy === busyKey ? "The register is answering…" : pressName}
      </button>
    </div>
  );
}

/** The canonical scope key 140 stores a line under: `route|class|cont|basis`, with `*` for a half that
 *  is not named. Same order, same wildcard, so the desk can say "that scope already stands" before the
 *  press rather than after it. */
function scopeKeyOf(l: { route: string; vehicle_class: string; container: string; basis: string }) {
  return [l.route || "*", l.vehicle_class || "*", l.container || "*", l.basis || "*"].join("|");
}

const labelOf = (dims: Dim[], kind: string, key?: string | null) =>
  key ? (dims.find(x => x.kind === kind && x.key === key)?.label ?? key) : "";

/** A hash is only useful at a desk if two of them can be compared by eye. */
const short = (h?: string | null) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "no hash");
