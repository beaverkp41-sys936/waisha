"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Corridor, Desk, Dim } from "./ask";

/**
 * The charges that sit on top of a price (141).
 *
 * A surcharge and a discount code are one register and two signs, and that is the whole reason nothing
 * below branches on the word a charge's kind holds. The board door answers `kinds` — the words the register
 * knows, each with its prefix, its sign, whether it counts places and the bases it may be worked out on
 * — and every picker below is cut from that answer. A third kind added to 141's catalog appears here as a
 * chip, a basis list and a ceiling field without this file being opened.
 *
 * Three facts decide what may be pressed, and none of them is a preference:
 * · a charge that has been a live levy is never edited — it is cloned forward (`already_lived`);
 * · a charge whose paper is out changes underneath nobody (`paper_is_out`);
 * · a place is only handed out on a code that is in force, and only on a kind that counts them
 *   (`not_live`, `kind_is_not_counted`).
 * The presses that would be refused are shown with the register's own reason beside them.
 *
 * **This desk never publishes.** `POST /charges/:id/publish` raises the paper and prints the hash it was
 * cut on; the signature is spent by the seat that holds it, on Approvals, through 121's
 * `addendum_publish` effect. And `GET /job` reports which codes are available without consuming a place,
 * because a quote is not a booking — the place is taken afterwards, deliberately, by `POST /claims`.
 */

const cell = "w-full rounded-input border px-8 py-8 text-sm";
const cellStyle = { borderColor: "var(--adm-line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const btn = "waisha-btn rounded-input px-16 py-8 text-xs font-semibold";
const th = "border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]";
const td = "border-b px-8 py-8 align-top text-sm";

const PAGE = 30;

/** One row of `pricing_addendum_kinds`, exactly as the board door prints it. */
export interface AddKind {
  key: string; prefix: string; label: string; sign: number; counted: boolean;
  basis_set: string[];
}

export interface ChargeRow {
  id: string; ref: string; code: string; kind: string; kind_label: string | null;
  sign: number; label: string; currency: string; status: string; version: number;
  basis: string; value: string; cap: string | null; min_amount: string | null;
  max_uses: number | null; uses_taken: number; uses_left: number | null; unlimited: boolean;
  scope: string | null; effective_from: string | null; effective_to: string | null;
  refusals: number; approval_id: string | null; approval_status: string | null;
  published_by: string | null; published_at: string | null; published_note: string | null;
  withdrawn_reason: string | null; supersedes: string | null; updated_at: string;
}

/** One charge whole, as `pricing_addendum_detail` returns it — the shape every write answers with, so
 *  what the desk says after a press is the charge's new figure rather than an echo of what was typed. */
export interface ChargeDetail {
  addendum: {
    id: string; ref: string; code: string; kind: string; label: string; sign: number;
    counted: boolean; currency: string; status: string; version: number; basis: string;
    value: string; cap: string | null; min_amount: string | null; max_uses: number | null;
    route_id: string | null; route: string | null; distance_km: number | null;
    vehicle_class: string | null; container_type: string | null; scope: string | null;
    effective_from: string | null; effective_to: string | null; note: string | null;
    refusals: number; approval_id: string | null; supersedes: string | null;
    published_by: string | null; published_at: string | null; published_note: string | null;
    withdrawn_reason: string | null; withdrawn_at: string | null; created_at: string;
  };
  uses: { taken: number; max_uses: number | null; left: number | null; unlimited: boolean };
  versions: { ref: string; version: number; status: string; basis: string; value: string;
    currency: string; effective_from: string | null; effective_to: string | null;
    published_at: string | null; published_by: string | null }[];
  /** `reason` is what the proposing seat asked for; `decided_note` is what the second seat answered. A
   *  desk that prints only the first reads as a dead end after a refusal. */
  approval: { id: string; status: string; reason: string | null; proposed_by: string | null;
    proposed_at: string | null; decided_by: string | null; decided_note: string | null;
    decided_at: string | null; expires_at: string | null; payload_sha256: string } | null;
  memory: { at: string | null; what: string; said: string | null; old_value: string | null;
    new_value: string | null; currency: string | null; reason: string | null;
    actor: string | null }[];
  claims: { id: string; subject_kind: string; subject_id: string; job_ref: string | null;
    freight: string | null; taken: string | null; currency: string | null; note: string | null;
    claimed_by: string | null; claimed_at: string | null; voided_at: string | null;
    voided_by: string | null; void_reason: string | null }[];
  paper_sha256: string | null;
}

const PILES: [string, string][] = [
  ["all", "Everything"], ["draft", "Drafts"], ["pending_signature", "Papers out"],
  ["published", "In force"], ["superseded", "Superseded"], ["withdrawn", "Stopped"]
];

const CLEARS = ["cap", "min_amount", "max_uses", "route", "vehicle_class", "container"] as const;
const CLEAR_LABEL: Record<string, string> = {
  cap: "the ceiling", "min_amount": "the floor", max_uses: "the number of places",
  route: "the corridor", vehicle_class: "the vehicle class", container: "the container kind"
};

const SUBJECTS = ["tenant", "customer", "user", "vehicle", "driver"];

/** Both figures are `numeric(14,4)` at the register, but a ceiling, a floor and a discount taken off are
 *  said out loud in two decimals — the same split the door makes, mirrored here so a clerk is stopped at
 *  the desk rather than in the audit register. */
const FIGURE_OK = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$/;
const MONEY_OK = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/;

const labelOf = (dims: Dim[], kind: string, key?: string | null) =>
  key ? (dims.find(d => d.kind === kind && d.key === key)?.label ?? key) : "";
const short = (h?: string | null) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "no hash");

function qs(parts: Record<string, string>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(parts)) {
    const s = String(v ?? "").trim();
    if (s) out.push(`${k}=${encodeURIComponent(s)}`);
  }
  return out.join("&");
}

/** A sign is the register's, not a word this screen chose: `+1` is read as a levy added and `−1` as a
 *  discount taken off, which is the one difference between the two kinds that a clerk must never get
 *  backwards on a quotation. The board answers `kind_label` and the detail does not, so the name is looked
 *  up in the register's own catalog rather than printed from the row. */
function SignChip({ row, kinds }: {
  row: { sign: number; kind: string; kind_label?: string | null }; kinds: AddKind[];
}) {
  const label = row.kind_label ?? kinds.find(k => k.key === row.kind)?.label ?? row.kind;
  return (
    <span className="whitespace-nowrap rounded-input px-8 py-4 text-[11px] font-bold uppercase tracking-[0.08em]"
      style={{
        background: row.sign > 0
          ? "color-mix(in srgb, var(--danger) 12%, transparent)"
          : "color-mix(in srgb, var(--success) 14%, transparent)",
        color: row.sign > 0 ? "var(--danger)" : "var(--success)"
      }}>
      {row.sign > 0 ? "+" : "−"} {label}
    </span>
  );
}

function Field({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
      <h4 className="text-sm font-bold" style={{ color: "var(--ink)" }}>{title}</h4>
      <div className="mt-8 grid gap-12">{children}</div>
    </div>
  );
}

/** The one-press-arms-itself button every write on this desk uses: a charge is a figure a customer is
 *  quoted, so stopping a live levy or throwing a draft away is confirmed by a second tap rather than by a
 *  sentence the clerk has to re-read. */
function Press({ title, body, blocked, field, go, pressName, ready, busyKey, busy, armed, arm, warn }: {
  title: string; body: ReactNode; blocked: string | null; field: ReactNode;
  go: () => Promise<void>; pressName: string; ready: boolean; busyKey: string;
  busy: string | null; armed: string | null; arm: (k: string, f: () => void) => () => void;
  warn?: string;
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

// ============================================================
// the board
// ============================================================

const EMPTY_OPEN = { kind: "", code: "", label: "", basis: "", value: "", cap: "", min_amount: "",
  max_uses: "", currency: "TZS", route: "", vehicle_class: "", container: "", effective_from: "", note: "" };

export function ChargesBoard({ desk, dims, corridors, kinds, onKinds, onPick, pickedId, nonce }: {
  desk: Desk; dims: Dim[]; corridors: Corridor[]; kinds: AddKind[];
  onKinds: (k: AddKind[]) => void; onPick: (id: string) => void; pickedId: string | null;
  nonce: number;
}) {
  const [board, setBoard] = useState<{ rows: ChargeRow[]; total: number; counts: Record<string, number> }>(
    { rows: [], total: 0, counts: {} });
  const [f, setF] = useState({ status: "all", kind: "", code: "", search: "", offset: 0 });
  const [showOpen, setShowOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_OPEN });
  const [busy, setBusy] = useState<string | null>(null);
  const [localFault, setLocalFault] = useState<string | null>(null);
  const [readOnce, setReadOnce] = useState(false);

  const read = useCallback(async (q: typeof f) => {
    const parts: Record<string, string> = { limit: String(PAGE), offset: String(q.offset) };
    if (q.status !== "all") parts.status = q.status;
    if (q.kind) parts.kind = q.kind;
    if (q.code.trim()) parts.code = q.code.trim();
    if (q.search.trim()) parts.search = q.search.trim();
    try {
      const j = await desk.call(`/control/pricing/charges?${qs(parts)}`);
      setBoard({ rows: (j.rows ?? []) as ChargeRow[], total: Number(j.total ?? 0),
        counts: (j.counts ?? {}) as Record<string, number> });
      // The kind chips ride on every board answer. They are handed to the page rather than kept here
      // because the panel below is opened by a row of this table and needs the same catalog to build its
      // basis picker — and a second read of the register's vocabulary is a second answer that can differ.
      if (Array.isArray(j.kinds) && j.kinds.length) onKinds(j.kinds as AddKind[]);
      setReadOnce(true);
    } catch (e) { setLocalFault((e as Error).message); setReadOnce(true); }
  }, [desk, onKinds]);

  useEffect(() => {
    const t = setTimeout(() => { void read(f); }, 260);
    return () => clearTimeout(t);
  }, [f, read, nonce]);
  useEffect(() => { setF(x => ({ ...x, offset: 0 })); }, [f.search, f.status, f.kind, f.code]);

  const kindOf = (key: string) => kinds.find(k => k.key === key);
  const chosen = kindOf(form.kind);
  const bases = dims.filter(d => d.kind === "basis"
    && (!chosen || chosen.basis_set.includes(d.key)));
  const classes = dims.filter(d => d.kind === "vehicle_class");
  const containers = dims.filter(d => d.kind === "container");

  const valueOk = FIGURE_OK.test(form.value.trim());
  const capOk = !form.cap.trim() || MONEY_OK.test(form.cap.trim());
  const minOk = !form.min_amount.trim() || MONEY_OK.test(form.min_amount.trim());
  const usesOk = !form.max_uses.trim() || /^[1-9][0-9]{0,6}$/.test(form.max_uses.trim());
  const openReady = !!form.kind && !!form.basis && form.code.trim().length >= 2
    && form.label.trim().length >= 3 && !!form.value.trim() && valueOk && capOk && minOk && usesOk
    && form.note.trim().length >= 8;

  // The register refuses a percent figure outside 0–100 before it reaches the row (`percent_too_wide`),
  // because a code that takes more off than is payable would make a quote negative — so it is said here
  // rather than typed into a door that will send it back.
  const percentWide = (form.basis === "percent_off" || form.basis === "percent_of_freight")
    && Number(form.value) > 100;

  async function openCharge() {
    setBusy("open"); setLocalFault(null);
    try {
      const j = await desk.call("/control/pricing/charges", "POST", {
        kind: form.kind, code: form.code.trim(), label: form.label.trim(), basis: form.basis,
        value: form.value.trim(), cap: form.cap.trim() || undefined,
        min_amount: form.min_amount.trim() || undefined,
        max_uses: form.max_uses.trim() ? Number(form.max_uses.trim()) : undefined,
        currency: form.currency, route: form.route || undefined,
        vehicle_class: form.vehicle_class || undefined, container: form.container || undefined,
        effective_from: form.effective_from.trim() || undefined, note: form.note.trim()
      });
      const a = j?.addendum;
      setShowOpen(false);
      setForm({ ...EMPTY_OPEN });
      await read(f);
      if (a?.id) onPick(a.id);
      desk.notify(`${a?.ref ?? "A new charge"} v${a?.version ?? ""} is open as a draft — ${a?.scope
        ?? "for every job in this book"}. Nothing is quoted off it until a second seat signs it.`);
    } catch (e) { setLocalFault((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <>
      <p className="mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
        {kinds.map(k => `${k.sign > 0 ? "+" : "−"} ${k.label}: ${k.basis_set.join(", ")}`).join(" · ")
          || "Reading the register’s kinds…"}
      </p>

      <div className="mb-12 flex flex-wrap gap-8" role="group" aria-label="Piles of charges">
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

      {/* The kind chips are the register's own two words, counted over the whole book. A third kind in
          141's catalog is a third chip here without this file changing. */}
      <div className="mb-12 flex flex-wrap gap-8" role="group" aria-label="Kinds of charge">
        <button className={btn} onClick={() => setF(x => ({ ...x, kind: "" }))}
          aria-pressed={!f.kind}
          style={!f.kind
            ? { background: "var(--brand-deep)", color: "var(--milk)", fontWeight: 800 }
            : { background: "var(--milk)", color: "var(--ink)" }}>
          Both kinds
        </button>
        {kinds.map(k => (
          <button key={k.key} className={btn} onClick={() => setF(x => ({ ...x, kind: k.key }))}
            aria-pressed={f.kind === k.key}
            style={f.kind === k.key
              ? { background: "var(--brand-deep)", color: "var(--milk)", fontWeight: 800 }
              : { background: "var(--milk)", color: "var(--ink)" }}>
            {k.sign > 0 ? "+" : "−"} {k.label}
            <span className="ml-6 font-normal">{board.counts[`kind_${k.key}`] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
        <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
          Search the book
          <input className={`${cell} mt-4`} style={cellStyle} value={f.search}
            placeholder="fuel, NEWYEAR, a SUR- number or a road it sits on"
            onChange={e => setF(x => ({ ...x, search: e.target.value }))} /></span></label>
        <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
          Only one charge code
          <input className={`${cell} mt-4`} style={cellStyle} value={f.code}
            placeholder="FUEL_SURCHARGE" onChange={e => setF(x => ({ ...x, code: e.target.value }))} /></span></label>
        <div className="self-end text-xs" style={{ color: "var(--ink-soft)" }}>
          A search reaches the corridor a charge is laid on, so “does anything add to a Kigoma quote” is
          answerable from this board.
        </div>
      </div>

      {localFault && (
        <div className="mb-16 rounded-input px-12 py-8 text-sm" role="alert"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {localFault}
        </div>
      )}

      {desk.can.manage && !showOpen && (
        <button className={`${btn} mb-16`} onClick={() => setShowOpen(true)}>Open a charge</button>
      )}
      {desk.can.manage && showOpen && (
        <div className="mb-20 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
          <h2 className="text-sm font-bold" style={{ color: "var(--ink)" }}>Open a charge with its figure on it</h2>
          <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
            The reference and the version are minted off the code, so a second draft called FUEL_SURCHARGE
            comes back as version 2 with its own number. A charge holds one number, and the kind decides
            which bases it may be worked out on — the list below is that kind&rsquo;s own{" "}
            <code>basis_set</code>, read off the register.
          </p>
          <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Kind
              <select className={`${cell} mt-4`} style={cellStyle} value={form.kind}
                onChange={e => setForm(x => ({ ...x, kind: e.target.value,
                  // The basis belongs to the kind, so changing the kind cannot leave a basis the new kind
                  // has never agreed to be worked out on.
                  basis: kindOf(e.target.value)?.basis_set.includes(x.basis) === true ? x.basis : "",
                  max_uses: kindOf(e.target.value)?.counted === false ? "" : x.max_uses }))}>
                <option value="">choose which charge this is</option>
                {kinds.map(k => <option key={k.key} value={k.key}>
                  {k.sign > 0 ? "+ " : "− "}{k.label} ({k.prefix})
                </option>)}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Worked out on
              <select className={`${cell} mt-4`} style={cellStyle} value={form.basis}
                onChange={e => setForm(x => ({ ...x, basis: e.target.value }))}>
                <option value="">choose a kind first</option>
                {bases.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              The figure
              <input className={`${cell} mt-4`} style={cellStyle} value={form.value} inputMode="decimal"
                placeholder={form.basis === "percent_off" ? "7.5" : "150000"}
                onChange={e => setForm(x => ({ ...x, value: e.target.value.replace(/,/g, "") }))} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Code
              <input className={`${cell} mt-4`} style={cellStyle} value={form.code}
                placeholder="FUEL SURCHARGE · typed as it is said"
                onChange={e => setForm(x => ({ ...x, code: e.target.value }))} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Label the clerk reads out
              <input className={`${cell} mt-4`} style={cellStyle} value={form.label}
                placeholder="Fuel levy on the Dar corridor"
                onChange={e => setForm(x => ({ ...x, label: e.target.value }))} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Money
              <select className={`${cell} mt-4`} style={cellStyle} value={form.currency}
                onChange={e => setForm(x => ({ ...x, currency: e.target.value }))}>
                <option value="TZS">TZS</option>
                <option value="USD">USD</option>
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Ceiling (blank is none)
              <input className={`${cell} mt-4`} style={cellStyle} value={form.cap} inputMode="decimal"
                placeholder="900000"
                onChange={e => setForm(x => ({ ...x, cap: e.target.value.replace(/,/g, "") }))} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Never under (blank is no floor)
              <input className={`${cell} mt-4`} style={cellStyle} value={form.min_amount} inputMode="decimal"
                placeholder="20000"
                onChange={e => setForm(x => ({ ...x, min_amount: e.target.value.replace(/,/g, "") }))} /></span></label>
            {chosen?.counted ? (
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Places it gives away (blank is unlimited)
                <input className={`${cell} mt-4`} style={cellStyle} value={form.max_uses} inputMode="numeric"
                  placeholder="50" onChange={e => setForm(x => ({ ...x, max_uses: e.target.value }))} /></span></label>
            ) : (
              <p className="self-end text-xs" style={{ color: "var(--ink-soft)" }}>
                {chosen ? `${chosen.label} does not count places: the ceiling is a field on a kind the `
                  + "register runs out of, and a standing levy never runs out." : ""}
              </p>
            )}
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Corridor it sits on
              <select className={`${cell} mt-4`} style={cellStyle} value={form.route}
                onChange={e => setForm(x => ({ ...x, route: e.target.value }))}>
                <option value="">every corridor in this book</option>
                {corridors.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.distance_km === null ? " (no distance filed)" : ` — ${c.distance_km} km`}
                  </option>
                ))}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Vehicle class
              <select className={`${cell} mt-4`} style={cellStyle} value={form.vehicle_class}
                onChange={e => setForm(x => ({ ...x, vehicle_class: e.target.value }))}>
                <option value="">any class</option>
                {classes.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Container kind
              <select className={`${cell} mt-4`} style={cellStyle} value={form.container}
                onChange={e => setForm(x => ({ ...x, container: e.target.value }))}>
                <option value="">any / not a container</option>
                {containers.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              In force from (blank is the register&rsquo;s today)
              <input className={`${cell} mt-4`} style={cellStyle} value={form.effective_from}
                placeholder={desk.today()}
                onChange={e => setForm(x => ({ ...x, effective_from: e.target.value }))} /></span></label>
            <label className="lg:col-span-2"><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Note the second seat will read
              <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
                value={form.note} placeholder="What this levy is for, and what it answers"
                onChange={e => setForm(x => ({ ...x, note: e.target.value }))} /></span></label>
          </div>
          {percentWide && (
            <p className="mt-8 text-xs font-semibold" style={{ color: "var(--danger)" }}>
              A percent figure over 100 is the whole price and more, and the register refuses it: a code
              that takes more off than is payable would make a quote negative.
            </p>
          )}
          <div className="mt-12 flex flex-wrap gap-12">
            <button className={btn} disabled={!openReady || busy !== null} onClick={openCharge}>
              {busy === "open" ? "The register is writing it…" : "Open the charge"}
            </button>
            <button className="text-xs underline" style={{ color: "var(--ink-soft)" }}
              onClick={() => setShowOpen(false)}>cancel</button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
              {["Charge", "State", "Figure", "Where it applies", "Places", "Window", "Paper"].map(h => (
                <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {board.rows.map(r => (
              <tr key={r.id} onClick={() => onPick(pickedId === r.id ? "" : r.id)}
                style={pickedId === r.id
                  ? { background: "color-mix(in srgb, var(--adm-accent) 10%, transparent)" }
                  : { cursor: "pointer" }}>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  <span className="block font-semibold" style={{ color: "var(--ink)" }}>{r.label}</span>
                  <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                    <span className="font-mono">{r.ref}</span> · v{r.version} · {r.code}
                  </span>
                  <span className="mt-4 block"><SignChip row={r} kinds={kinds} /></span>
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {r.status.replace(/_/g, " ")}
                  {r.withdrawn_reason ? (
                    <span className="block text-xs" style={{ color: "var(--danger)" }}>
                      stopped: {r.withdrawn_reason.slice(0, 60)}
                    </span>
                  ) : null}
                </td>
                <td className={`${td} whitespace-nowrap`} style={{ borderColor: "var(--adm-line)" }}>
                  <span className="font-semibold" style={{ color: r.sign > 0 ? "var(--danger)" : "var(--success)" }}>
                    {r.sign > 0 ? "+" : "−"}{r.value}
                  </span>
                  <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                    {labelOf(dims, "basis", r.basis) || r.basis} · {r.currency}
                    {r.cap ? ` · capped ${r.cap}` : ""}{r.min_amount ? ` · floor ${r.min_amount}` : ""}
                  </span>
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  <span className="text-xs">{r.scope ?? "every job in this book"}</span>
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {r.unlimited
                    ? <span style={{ color: "var(--ink-soft)" }}>unlimited</span>
                    : <span>{r.uses_left} of {r.max_uses} left
                        <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                          {r.uses_taken} taken
                        </span></span>}
                </td>
                <td className={`${td} whitespace-nowrap`} style={{ borderColor: "var(--adm-line)" }}>
                  {r.effective_from ?? "no start"} → {r.effective_to ?? "no end"}
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {r.approval_status
                    ? <span>{r.approval_status}{r.refusals ? ` · refused ${r.refusals}×` : ""}</span>
                    : r.refusals
                      ? <span style={{ color: "var(--danger)" }}>refused {r.refusals}×</span>
                      : <span style={{ color: "var(--ink-soft)" }}>
                          {r.published_by ? `signed by ${r.published_by}` : "no paper"}
                        </span>}
                </td>
              </tr>
            ))}
            {!board.rows.length && readOnce && (
              <tr>
                <td className={td} colSpan={7} style={{ borderColor: "var(--adm-line)" }}>
                  No charge in this book matches the pile and the words above it. A levy that has never
                  been signed adds nothing to a quote, and a code that has never been signed gives nothing
                  away — the register answers with the charges it actually has.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-16 flex flex-wrap items-center gap-12">
        <button className={btn} disabled={f.offset <= 0}
          onClick={() => setF(x => ({ ...x, offset: Math.max(0, x.offset - PAGE) }))}>Newer {PAGE}</button>
        <button className={btn} disabled={f.offset + PAGE >= board.total}
          onClick={() => setF(x => ({ ...x, offset: x.offset + PAGE }))}>More</button>
        <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
          {board.total} charge{board.total === 1 ? "" : "s"} in this pile · showing{" "}
          {f.offset + 1}–{Math.min(board.total, f.offset + board.rows.length)}
        </span>
      </div>
    </>
  );
}

// ============================================================
// one charge, whole
// ============================================================

export function ChargePanel({ desk, dims, corridors, kinds, chargeId, onClose, onGoto, refresh }: {
  desk: Desk; dims: Dim[]; corridors: Corridor[]; kinds: AddKind[]; chargeId: string;
  onClose: () => void; onGoto: (id: string) => void; refresh: () => Promise<void>;
}) {
  const [d, setD] = useState<ChargeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState({ ...EMPTY_OPEN });
  const [clears, setClears] = useState<string[]>([]);
  // Each press keeps its own sentence: a reason typed to raise a paper must not reappear in the box
  // beside "Stop the charge", because the clerk would read their own words back as an answer.
  const [press, setPress] = useState({ reason: "", note: "", clone_note: "", effective_from: "",
    effective_to: "", withdraw_reason: "", discard_reason: "",
    subject_kind: "customer", subject_id: "", job_ref: "", freight: "", taken: "", claim_note: "",
    void_reason: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [localFault, setLocalFault] = useState<string | null>(null);

  const a = d?.addendum ?? null;
  const isDraft = a?.status === "draft";
  const isPaperOut = a?.status === "pending_signature";
  const isLive = a?.status === "published";
  const hasLived = !!a?.published_at;

  // The pens are filled from the register's own row, never from what the clerk typed into them: a press
  // rewrites the figure, the places and the window, and a panel holding the old shape would go on offering
  // a clear the row has already answered.
  const seed = useCallback((x: ChargeDetail["addendum"]) => {
    setEdit({ kind: x.kind, code: x.code, label: x.label, basis: x.basis, value: x.value,
      cap: x.cap ?? "", min_amount: x.min_amount ?? "",
      max_uses: x.max_uses === null ? "" : String(x.max_uses),
      currency: x.currency, route: x.route_id ?? "", vehicle_class: x.vehicle_class ?? "",
      container: x.container_type ?? "", effective_from: x.effective_from ?? "", note: x.note ?? "" });
    setClears([]);
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setLocalFault(null);
    try {
      const j = await desk.call(`/control/pricing/charges/${chargeId}`) as ChargeDetail;
      setD(j); seed(j.addendum);
    } catch (e) {
      setLocalFault((e as Error).message);
      setD(null);
    } finally { setLoading(false); }
  }, [chargeId, desk, seed]);

  // Opening another row is a new charge, not a patch on this one: the pens, the armed press and the
  // cleared columns all belong to the number that was clicked.
  useEffect(() => {
    void load();
    setArmed(null);
  }, [chargeId, load]);

  /** Both shapes the write doors answer with: `open`, `edit`, `clone` and `withdraw` return the whole
   *  detail at the top level, while `publish`, `refuse`, `claim` and `void` hand the same detail back
   *  under `addendum`. A press whose answer was missed leaves the panel showing the figure the register
   *  has already changed. */
  const detailOf = (j: any): ChargeDetail | null =>
    j?.addendum?.addendum?.id ? (j.addendum as ChargeDetail)
      : j?.addendum?.id ? (j as ChargeDetail) : null;

  async function run(key: string, fn: () => Promise<any>, then: (j: any) => string, gone = false) {
    setBusy(key); setLocalFault(null); setArmed(null);
    try {
      const j = await fn();
      const shown = detailOf(j);
      // Discard is the one press that leaves no charge to show, so the panel closes on the register's
      // sentence rather than re-reading a row that is gone.
      if (gone) { await refresh(); desk.notify(then(j)); onClose(); return; }
      // Cloning is the press whose answer is a charge other than the one this panel was opened on, and
      // every read and write below is addressed by `chargeId` — so the desk follows the new draft instead
      // of offering a live levy's pens to the version that has not been edited yet.
      if (shown && shown.addendum.id !== chargeId) {
        await refresh();
        desk.notify(then(j));
        onGoto(shown.addendum.id);
        return;
      }
      if (shown) { setD(shown); seed(shown.addendum); } else await load();
      await refresh();
      desk.notify(then(j));
    } catch (e) {
      // A refused press still says something the desk could not know on its own — that the paper is out,
      // that the code gives no places, that this one is already signed — so it is reported here, inside
      // the charge that provoked it, rather than in the strip a page above the fold.
      setLocalFault((e as Error).message);
    } finally { setBusy(null); }
  }

  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  // Absent keys keep what the row holds and `clear` empties a column, so only the halves that were
  // changed go out — and a body that asks for nothing is refused by the door, because every call that
  // reaches it is audited.
  function changedPatch(): Record<string, unknown> | null {
    if (!a) return null;
    const body: Record<string, unknown> = {};
    if (edit.label.trim() && edit.label.trim() !== a.label) body.label = edit.label.trim();
    if (edit.basis && edit.basis !== a.basis) body.basis = edit.basis;
    if (edit.value.trim() && edit.value.trim() !== a.value) body.value = edit.value.trim();
    if (edit.cap.trim() && edit.cap.trim() !== (a.cap ?? "")) body.cap = edit.cap.trim();
    if (edit.min_amount.trim() && edit.min_amount.trim() !== (a.min_amount ?? "")) {
      body.min_amount = edit.min_amount.trim();
    }
    if (edit.max_uses.trim() && Number(edit.max_uses.trim()) !== a.max_uses) {
      body.max_uses = Number(edit.max_uses.trim());
    }
    if (edit.route && edit.route !== (a.route_id ?? "")) body.route = edit.route;
    if (edit.vehicle_class && edit.vehicle_class !== (a.vehicle_class ?? "")) {
      body.vehicle_class = edit.vehicle_class;
    }
    if (edit.container && edit.container !== (a.container_type ?? "")) body.container = edit.container;
    if (edit.effective_from && edit.effective_from !== (a.effective_from ?? "")) {
      body.effective_from = edit.effective_from;
    }
    if (edit.note.trim() && edit.note.trim() !== (a.note ?? "")) body.note = edit.note.trim();
    // A column the desk says to empty is emptied: the boxes beside it are disabled while its clear is
    // ticked, and the figure is dropped here too, because the door refuses a body that both clears a
    // column and asks for a new value in it.
    if (clears.length) {
      for (const c of clears) delete body[c];
      body.clear = clears;
    }
    return Object.keys(body).length ? body : null;
  }
  const patch = changedPatch();
  const figureOk = FIGURE_OK.test(edit.value.trim());
  const moneyOk = (!edit.cap.trim() || MONEY_OK.test(edit.cap.trim()))
    && (!edit.min_amount.trim() || MONEY_OK.test(edit.min_amount.trim()));
  // The basis picker is the kind's own `basis_set` read off the catalog the board carried, so a third
  // kind in the register is a third list here without this file being opened.
  const editKind = kinds.find(k => k.key === a?.kind);
  const editBases = dims.filter(x => x.kind === "basis"
    && (!editKind || editKind.basis_set.includes(x.key)));

  if (loading && !d) {
    return (
      <section className="mt-24 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Reading the charge…</p>
      </section>
    );
  }
  if (!d || !a) {
    return (
      <section className="mt-24 rounded-card border p-16" style={{ borderColor: "var(--danger)" }}>
        <p className="text-sm" role="alert" style={{ color: "var(--danger)" }}>{localFault
          ?? "This charge could not be read."}</p>
        <button className={`${btn} mt-12`} onClick={onClose}>Close</button>
      </section>
    );
  }

  const blockedEdit = !isDraft
    ? (isPaperOut
      ? "Its paper is out for a second seat. Refuse it first — a figure cannot change under the seat "
        + "being asked to sign it."
      : hasLived
        ? "It has been a live levy, so it is never edited. Clone it forward: the figure a customer was "
          + "quoted for stays in the book."
        : `It is ${a.status.replace(/_/g, " ")}. A draft changes; a version that has lived is answered `
          + "with a new version.")
    : null;
  const blockedPublish = !isDraft
    ? "Only a draft goes up for a signature." : null;
  const blockedRefuse = !isPaperOut ? "No signature is standing on this charge." : null;
  // `discard_pricing_addendum` and the keep-trigger both read `approval_id`, not the paper's answer: a
  // refused paper leaves the row a draft with its approval still attached, so the charge is never
  // discardable again. The gate used to follow the status alone, which freed this press the moment the
  // paper was refused and offered a write the register answers 409 — a clerk who had just been told the
  // charge is kept then presses "discard" and is told the opposite.
  const blockedDiscard = !isDraft
    ? (isPaperOut
      ? "Its paper is out for a second seat. Refuse it first — the draft frees, but the charge stays: "
        + "the register keeps a charge a seat was ever asked to sign."
      : "A charge that has been a live levy is not a draft. The figure a customer was quoted for stays.")
    : a?.approval_id
      ? "A seat was asked to sign this charge, so the register keeps it and its paper goes on naming it. "
        + "Change the figure and ask again, or leave the draft."
      : null;
  const blockedClone = hasLived || a.status === "superseded" || a.status === "withdrawn"
    ? null : "Clone a version that has been published, superseded or stopped.";
  const blockedWithdraw = isLive ? null : `It is ${a.status.replace(/_/g, " ")}. There is nothing to stop.`;
  const blockedClaim = !isLive
    ? "A place is only taken on a charge that is in force."
    : !a.counted
      ? `${editKind?.label ?? a.kind} does not count places, so there is no place to give on it.` : null;

  return (
    <section className="mt-24 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div>
          <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>
            <SignChip row={a} kinds={kinds} /> {a.label}
          </h2>
          <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
            <span className="font-mono">{a.ref}</span> v{a.version} · {a.code} · {a.status.replace(/_/g, " ")}
            {" "}· {a.currency} · {labelOf(dims, "basis", a.basis) || a.basis} · created {a.created_at.slice(0, 10)}
          </p>
        </div>
        <button className="text-xs underline" style={{ color: "var(--ink-soft)" }} onClick={onClose}>
          close
        </button>
      </div>

      <p className="mt-12 text-lg font-bold" style={{ color: a.sign > 0 ? "var(--danger)" : "var(--success)" }}>
        {a.sign > 0 ? "+" : "−"}{a.value}{" "}
        <span className="text-sm font-semibold" style={{ color: "var(--ink-soft)" }}>{a.currency}</span>
        {a.cap ? ` · never over ${a.cap}` : ""}{a.min_amount ? ` · never under ${a.min_amount}` : ""}
      </p>
      <p className="mt-4 text-xs" style={{ color: "var(--ink)" }}>
        {a.scope ?? "Every job in this book"}
        {a.route ? ` — ${a.route}${a.distance_km !== null ? `, ${a.distance_km} km` : ", no distance filed"}` : ""}
      </p>
      <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
        In force {a.effective_from ?? "no start"} → {a.effective_to ?? "no end"} ·{" "}
        {d.uses.unlimited
          ? "no ceiling on places"
          : `${d.uses.left} of ${d.uses.max_uses} places left, ${d.uses.taken} taken`}
        {a.supersedes ? ` · answers ${a.supersedes}` : ""}
      </p>
      {a.note && <p className="mt-8 text-xs italic" style={{ color: "var(--ink-soft)" }}>{a.note}</p>}
      {a.published_by && (
        <p className="mt-8 text-xs" style={{ color: "var(--success)" }}>
          Signed by {a.published_by} on {a.published_at?.slice(0, 10)}
          {a.published_note ? ` — ${a.published_note}` : ""}
        </p>
      )}
      {a.withdrawn_reason && (
        <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>
          Stopped {a.withdrawn_at?.slice(0, 10)} — {a.withdrawn_reason}
        </p>
      )}
      <p className="mt-8 text-[11px] font-mono" style={{ color: "var(--ink-soft)" }}>
        the paper a signature is cut on: {short(d.paper_sha256)}
      </p>

      {localFault && (
        <div className="mt-12 rounded-input px-12 py-8 text-sm" role="alert"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {localFault}
        </div>
      )}

      {/* The paper, both sentences and neither of them paraphrased. A refusal that shows only "rejected"
          is a dead end; the words the second seat typed came back out of `decided_note` and are the answer
          to the question the clerk is actually asking. */}
      {d.approval && (
        <div className="mt-16 rounded-card border p-16"
          style={{ borderColor: d.approval.status === "rejected" ? "var(--danger)" : "var(--adm-line)" }}>
          <h3 className="text-sm font-bold" style={{ color: "var(--ink)" }}>
            The paper — {d.approval.status.replace(/_/g, " ")}
          </h3>
          <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
            Asked for by {d.approval.proposed_by ?? "a seat"} {d.approval.proposed_at?.slice(0, 16)
              .replace("T", " ")} · hash {short(d.approval.payload_sha256)}
            {d.approval.expires_at ? ` · lapses ${d.approval.expires_at.slice(0, 16).replace("T", " ")}` : ""}
          </p>
          {d.approval.reason && (
            <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
              <strong>Asked for:</strong> {d.approval.reason}
            </p>
          )}
          {d.approval.decided_note ? (
            <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>
              <strong>Answered by {d.approval.decided_by ?? "a second seat"}
                {d.approval.decided_at ? ` on ${d.approval.decided_at.slice(0, 10)}` : ""}:</strong>{" "}
              {d.approval.decided_note}
            </p>
          ) : d.approval.status === "pending" ? (
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              Nobody has answered it yet. {a.refusals
                ? `This code has been refused ${a.refusals} time${a.refusals === 1 ? "" : "s"} before.` : ""}
            </p>
          ) : null}
        </div>
      )}

      <h3 className="mt-24 text-sm font-bold" style={{ color: "var(--ink)" }}>Change the draft</h3>
      <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
        A field left as it is stays as it is. Empty one by its own box below rather than typing over it —
        the door clears a column only when the desk says which one.
      </p>
      {blockedEdit && (
        <p className="mb-12 rounded-input px-12 py-8 text-xs"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", color: "var(--danger)" }}>
          {blockedEdit}
        </p>
      )}
      {desk.can.manage && (
        <>
          <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Label
              <input className={`${cell} mt-4`} style={cellStyle} value={edit.label}
                onChange={e => setEdit(x => ({ ...x, label: e.target.value }))} disabled={!!blockedEdit} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Basis
              <select className={`${cell} mt-4`} style={cellStyle} value={edit.basis}
                onChange={e => setEdit(x => ({ ...x, basis: e.target.value }))} disabled={!!blockedEdit}>
                {editBases.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              The figure ({a.currency})
              <input className={`${cell} mt-4`} style={cellStyle} value={edit.value} inputMode="decimal"
                onChange={e => setEdit(x => ({ ...x, value: e.target.value.replace(/,/g, "") }))}
                disabled={!!blockedEdit} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Ceiling
              <input className={`${cell} mt-4`} style={cellStyle} value={edit.cap} inputMode="decimal"
                onChange={e => setEdit(x => ({ ...x, cap: e.target.value.replace(/,/g, "") }))}
                disabled={!!blockedEdit || clears.includes("cap")} /></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Never under
              <input className={`${cell} mt-4`} style={cellStyle} value={edit.min_amount} inputMode="decimal"
                onChange={e => setEdit(x => ({ ...x, min_amount: e.target.value.replace(/,/g, "") }))}
                disabled={!!blockedEdit || clears.includes("min_amount")} /></span></label>
            {editKind?.counted ? (
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Places
                <input className={`${cell} mt-4`} style={cellStyle} value={edit.max_uses} inputMode="numeric"
                  onChange={e => setEdit(x => ({ ...x, max_uses: e.target.value }))}
                  disabled={!!blockedEdit || clears.includes("max_uses")} /></span></label>
            ) : null}
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Corridor
              <select className={`${cell} mt-4`} style={cellStyle} value={edit.route}
                onChange={e => setEdit(x => ({ ...x, route: e.target.value }))}
                disabled={!!blockedEdit || clears.includes("route")}>
                <option value="">every corridor in this book</option>
                {corridors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Vehicle class
              <select className={`${cell} mt-4`} style={cellStyle} value={edit.vehicle_class}
                onChange={e => setEdit(x => ({ ...x, vehicle_class: e.target.value }))}
                disabled={!!blockedEdit || clears.includes("vehicle_class")}>
                <option value="">any class</option>
                {dims.filter(x => x.kind === "vehicle_class").map(x => (
                  <option key={x.key} value={x.key}>{x.label}</option>))}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Container kind
              <select className={`${cell} mt-4`} style={cellStyle} value={edit.container}
                onChange={e => setEdit(x => ({ ...x, container: e.target.value }))}
                disabled={!!blockedEdit || clears.includes("container")}>
                <option value="">any / not a container</option>
                {dims.filter(x => x.kind === "container").map(x => (
                  <option key={x.key} value={x.key}>{x.label}</option>))}
              </select></span></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              In force from
              <input className={`${cell} mt-4`} style={cellStyle} value={edit.effective_from}
                placeholder={desk.today()}
                onChange={e => setEdit(x => ({ ...x, effective_from: e.target.value }))}
                disabled={!!blockedEdit} /></span></label>
            <label className="lg:col-span-2"><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Note
              <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
                value={edit.note} onChange={e => setEdit(x => ({ ...x, note: e.target.value }))}
                disabled={!!blockedEdit} /></span></label>
          </div>
          <div className="mt-12 flex flex-wrap items-center gap-12">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em]"
              style={{ color: "var(--ink-soft)" }}>Clear:</span>
            {CLEARS.filter(c => c !== "max_uses" || editKind?.counted).map(c => (
              <label key={c} className="flex items-center gap-6 text-xs" style={{ color: "var(--ink)" }}>
                <input type="checkbox" checked={clears.includes(c)} disabled={!!blockedEdit}
                  onChange={e => setClears(x => e.target.checked ? [...x, c] : x.filter(y => y !== c))} />
                {CLEAR_LABEL[c]}
              </label>
            ))}
          </div>
          <button className={`${btn} mt-12`} disabled={!!blockedEdit || !patch || busy !== null
            || !figureOk || !moneyOk}
            onClick={() => void run("edit", () => desk.call(`/control/pricing/charges/${chargeId}`,
              "PATCH", patch), () => `${a.ref} is changed — read it back above: the figure, the places and `
              + "the window shown there are the register’s answer, not what was typed here.")}>
            {busy === "edit" ? "The register is writing it…"
              : !figureOk || !moneyOk ? "A figure is four decimals, a ceiling two"
                : !patch ? "Nothing has changed" : "Save the change"}
            </button>
        </>
      )}

      <h3 className="mt-24 text-sm font-bold" style={{ color: "var(--ink)" }}>The presses</h3>
      <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
        Raising the paper and answering it are a different duty from writing the figure, and no press here
        puts a charge in force. That happens on Approvals, by the seat that signs.
      </p>
      <div className="grid gap-12 lg:grid-cols-2">
        <Press title="Put it up for a second seat"
          body={<>The register reads the figure, the ceiling, the places and the dates out of the row and
            hashes them, so what the other seat signs is what this book holds.{" "}
            <strong>Nothing here publishes it.</strong></>}
          blocked={!desk.can.publish ? "This seat holds no publish duty." : blockedPublish}
          field={<label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
            Reason the second seat reads
            <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
              value={press.reason} placeholder="Why the office is asking for this levy to stand"
              onChange={e => setPress(x => ({ ...x, reason: e.target.value }))} /></span></label>}
          ready={press.reason.trim().length >= 8} busy={busy} busyKey="publish" armed={armed} arm={arm}
          pressName="Raise the paper"
          go={async () => { await run("publish", () => desk.call(
            `/control/pricing/charges/${chargeId}/publish`, "POST", { reason: press.reason.trim() }),
            (j) => `A paper was raised on ${j?.ref ?? a.ref} v${j?.version ?? ""} at ${j?.value} ${j?.currency} — `
              + `hash ${short(j?.payload_sha256)}. It waits for the seat that signs, on Approvals.`);
            setPress(x => ({ ...x, reason: "" })); }} />

        <Press title="Answer the paper with a no"
          body="It is the second seat’s own duty, and it frees the draft to be edited again. The seat that asked cannot answer its own paper."
          blocked={!desk.can.publish ? "This seat holds no publish duty." : blockedRefuse}
          field={<label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
            The words the desk will read back
            <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
              value={press.note} placeholder="What is wrong with the figure"
              onChange={e => setPress(x => ({ ...x, note: e.target.value }))} /></span></label>}
          ready={press.note.trim().length >= 8} busy={busy} busyKey="refuse" armed={armed} arm={arm}
          pressName="Refuse it" warn={a.refusals ? `Already refused ${a.refusals} time${a.refusals === 1 ? "" : "s"}.` : undefined}
          go={async () => { await run("refuse", () => desk.call(
            `/control/pricing/charges/${chargeId}/refuse`, "POST", { note: press.note.trim() }),
            (j) => `The paper is refused. ${a.ref} is a draft again with ${j?.refusals ?? ""} refusal on it — `
              + "the words are printed on the paper above."); setPress(x => ({ ...x, note: "" })); }} />

        {desk.can.manage && (
          <Press title="Raise a new version off this one"
            body="This is how a live levy changes: the figure a customer was quoted for is never edited, it is answered by the next version."
            blocked={blockedClone}
            field={<div className="grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                The new version stands from
                <input className={`${cell} mt-4`} style={cellStyle} value={press.effective_from}
                  placeholder={desk.today()}
                  onChange={e => setPress(x => ({ ...x, effective_from: e.target.value }))} /></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Note (optional)
                <input className={`${cell} mt-4`} style={cellStyle} value={press.clone_note}
                  onChange={e => setPress(x => ({ ...x, clone_note: e.target.value }))} /></span></label>
            </div>}
            ready
            busy={busy} busyKey="clone" armed={armed} arm={arm} pressName="Clone it forward"
            go={async () => { await run("clone", () => desk.call(
              `/control/pricing/charges/${chargeId}/clone`, "POST", {
                effective_from: press.effective_from.trim() || undefined,
                note: press.clone_note.trim() || undefined }),
              (j) => `${j?.addendum?.ref ?? "A new draft"} v${j?.addendum?.version ?? ""} is open, `
                + `answering ${a.ref}. Change its figure on the panel above.`);
            setPress(x => ({ ...x, effective_from: "", clone_note: "" })); }} />
        )}

        {desk.can.manage && (
          <Press title="Stop it from a day that is not in the past"
            body="One seat, no signature, and never earlier than today: it stops the levy being quoted tomorrow and does not un-charge a job already billed."
            blocked={blockedWithdraw}
            field={<div className="grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Stopped from
                <input className={`${cell} mt-4`} style={cellStyle} value={press.effective_to}
                  placeholder={desk.today()}
                  onChange={e => setPress(x => ({ ...x, effective_to: e.target.value }))} /></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Why
                <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
                  value={press.withdraw_reason}
                  onChange={e => setPress(x => ({ ...x, withdraw_reason: e.target.value }))} /></span></label>
            </div>}
            ready={press.effective_to.trim().length === 10 && press.withdraw_reason.trim().length >= 8}
            busy={busy} busyKey="withdraw" armed={armed} arm={arm} pressName="Stop the charge"
            go={async () => { await run("withdraw", () => desk.call(
              `/control/pricing/charges/${chargeId}/withdraw`, "POST", {
                effective_to: press.effective_to.trim(), reason: press.withdraw_reason.trim() }),
              (j) => `${j?.addendum?.ref ?? a.ref} stops being quoted from ${j?.addendum?.effective_to}.`);
            setPress(x => ({ ...x, effective_to: "", withdraw_reason: "" })); }} />
        )}

        {desk.can.manage && (
          <Press title="Throw the draft away"
            body={"Only a draft nobody was asked to sign. A charge whose paper stood or was refused is "
              + "kept, and a charge that has been a live levy is kept with its paper."}
            blocked={blockedDiscard}
            field={<label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
              Why the desk is throwing it away
              <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
                value={press.discard_reason}
                onChange={e => setPress(x => ({ ...x, discard_reason: e.target.value }))} /></span></label>}
            ready={press.discard_reason.trim().length >= 8} busy={busy} busyKey="discard"
            armed={armed} arm={arm} pressName="Discard it"
            go={async () => { await run("discard", () => desk.call(
              `/control/pricing/charges/${chargeId}/discard`, "POST",
              { reason: press.discard_reason.trim() }),
              (j) => j?.message ?? `${a.ref} was thrown away.`, true);
            setPress(x => ({ ...x, discard_reason: "" })); }} />
        )}

        {desk.can.manage && (
          <Press title="Give a place on this code"
            body="A quote does not take a place. This does — and the ceiling is counted from these rows, never stored on the code, so this press is the only thing that makes a promo run out."
            blocked={blockedClaim}
            field={<div className="grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                The place is given to
                <select className={`${cell} mt-4`} style={cellStyle} value={press.subject_kind}
                  onChange={e => setPress(x => ({ ...x, subject_kind: e.target.value }))}>
                  {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
                </select></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Its number in this book
                <input className={`${cell} mt-4`} style={cellStyle} value={press.subject_id}
                  placeholder="a uuid the directory or the fleet desk shows"
                  onChange={e => setPress(x => ({ ...x, subject_id: e.target.value }))} /></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Job reference (optional)
                <input className={`${cell} mt-4`} style={cellStyle} value={press.job_ref} placeholder="JOB-4471"
                  onChange={e => setPress(x => ({ ...x, job_ref: e.target.value }))} /></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Freight it was quoted on (optional)
                <input className={`${cell} mt-4`} style={cellStyle} value={press.freight} inputMode="decimal"
                  onChange={e => setPress(x => ({ ...x, freight: e.target.value.replace(/,/g, "") }))} /></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Actually taken off (optional)
                <input className={`${cell} mt-4`} style={cellStyle} value={press.taken} inputMode="decimal"
                  onChange={e => setPress(x => ({ ...x, taken: e.target.value.replace(/,/g, "") }))} /></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Note (optional)
                <input className={`${cell} mt-4`} style={cellStyle} value={press.claim_note}
                  onChange={e => setPress(x => ({ ...x, claim_note: e.target.value }))} /></span></label>
            </div>}
            ready={press.subject_id.trim().length >= 8} busy={busy} busyKey="claim" armed={armed} arm={arm}
            pressName="Take the place"
            go={async () => { await run("claim", () => desk.call(
              `/control/pricing/charges/${chargeId}/claims`, "POST", {
                subject_kind: press.subject_kind, subject_id: press.subject_id.trim(),
                job_ref: press.job_ref.trim() || undefined,
                freight: press.freight.trim() || undefined, taken: press.taken.trim() || undefined,
                note: press.claim_note.trim() || undefined }),
              (j) => j?.message ?? `A place was taken on ${a.ref}.`);
            setPress(x => ({ ...x, subject_id: "", job_ref: "", freight: "", taken: "", claim_note: "" })); }} />
        )}
      </div>

      {/* The version ladder, the memory and the places — three reads the same door answered, printed from
          the answer rather than tallied here. */}
      <h3 className="mt-24 text-sm font-bold" style={{ color: "var(--ink)" }}>
        The ladder this code has travelled
      </h3>
      <div className="mt-8 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
              {["Version", "State", "Figure", "Window", "Signed"].map(h => (
                <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.versions.map(v => (
              <tr key={v.ref}>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  <span className="font-mono">{v.ref}</span> v{v.version}
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>{v.status.replace(/_/g, " ")}</td>
                <td className={`${td} whitespace-nowrap`} style={{ borderColor: "var(--adm-line)" }}>
                  {a.sign > 0 ? "+" : "−"}{v.value} {v.currency} · {v.basis}
                </td>
                <td className={`${td} whitespace-nowrap`} style={{ borderColor: "var(--adm-line)" }}>
                  {v.effective_from ?? "—"} → {v.effective_to ?? "—"}
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {v.published_by ? `${v.published_by}, ${v.published_at?.slice(0, 10) ?? ""}`
                    : <span style={{ color: "var(--ink-soft)" }}>never signed</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-24 text-sm font-bold" style={{ color: "var(--ink)" }}>
        The places taken on {a.code}
      </h3>
      <p className="mt-4 mb-8 text-xs" style={{ color: "var(--ink-soft)" }}>
        {d.uses.unlimited
          ? "This charge gives places away without a ceiling, so nothing here is a limit."
          : `${d.uses.taken} of ${d.uses.max_uses} taken, ${d.uses.left} left. The ceiling is counted from `
            + "these rows — a void gives the place back but the row stays, because the voiding is the "
            + "evidence the mistake happened."}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
              {["Given to", "Job", "Freight", "Taken off", "By", "Void"]
                .filter(h => a.counted || h !== "Taken off").map(h => (
                  <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                ))}
            </tr>
          </thead>
          <tbody>
            {d.claims.map(c => (
              <tr key={c.id}>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  <span className="block text-xs">{c.subject_kind}</span>
                  <span className="block font-mono text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {c.subject_id.slice(0, 8)}…
                  </span>
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>{c.job_ref ?? "—"}</td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>{c.freight ?? "—"}</td>
                {a.counted && <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  −{c.taken ?? "—"} <span className="text-xs">{c.currency}</span>
                </td>}
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {c.claimed_by ?? "a seat"}
                  <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                    {c.claimed_at?.slice(0, 16).replace("T", " ")}
                    {c.note ? ` · ${c.note}` : ""}
                  </span>
                </td>
                <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                  {c.voided_at ? (
                    <span style={{ color: "var(--danger)" }}>
                      given back by {c.voided_by ?? "a seat"} — {c.void_reason}
                    </span>
                  ) : desk.can.manage ? (
                    <div className="flex flex-wrap items-center gap-8">
                      <input className={`${cell} w-[220px]`} style={cellStyle} value={press.void_reason}
                        placeholder="why it was a mistake"
                        onChange={e => setPress(x => ({ ...x, void_reason: e.target.value }))} />
                      <button className={btn} disabled={press.void_reason.trim().length < 8 || busy !== null}
                        onClick={arm(`void:${c.id}`, () => void run(`void:${c.id}`, () => desk.call(
                          `/control/pricing/claims/${c.id}/void`, "POST",
                          { reason: press.void_reason.trim() }),
                          (j) => j?.message ?? "The place was given back."))}>
                        {armed === `void:${c.id}` ? "Press again" : "Void it"}
                      </button>
                    </div>
                  ) : <span style={{ color: "var(--ink-soft)" }}>standing</span>}
                </td>
              </tr>
            ))}
            {!d.claims.length && (
              <tr>
                <td className={td} colSpan={a.counted ? 6 : 5} style={{ borderColor: "var(--adm-line)" }}>
                  {a.counted
                    ? "Nobody has taken a place on this code in this book yet."
                    : "A standing levy does not hand out places, so there is nothing to void."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="mt-24 text-sm font-bold" style={{ color: "var(--ink)" }}>What the office signed</h3>
      <p className="mt-4 mb-8 text-xs" style={{ color: "var(--ink-soft)" }}>
        The memory is what a signed figure used to be. A draft&rsquo;s edits are audited, not remembered, so
        a code that has never been signed has nothing here.
      </p>
      <ul className="space-y-8">
        {d.memory.map((m, i) => (
          <li key={i} className="rounded-input px-12 py-8 text-xs" style={cellStyle}>
            <strong style={{ color: "var(--ink)" }}>{m.what.replace(/_/g, " ")}</strong>
            <span style={{ color: "var(--ink-soft)" }}> — {m.said}</span>
            {(m.old_value || m.new_value) && (
              <span className="block" style={{ color: "var(--ink)" }}>
                {m.old_value ?? "nothing"} → {m.new_value ?? "nothing"} {m.currency ?? ""}
              </span>
            )}
            <span className="block" style={{ color: "var(--ink-soft)" }}>
              {m.at?.slice(0, 16).replace("T", " ")} · {m.actor ?? "a seat"}
              {m.reason ? ` · ${m.reason}` : ""}
            </span>
          </li>
        ))}
        {!d.memory.length && (
          <li className="text-xs" style={{ color: "var(--ink-soft)" }}>Nothing yet.</li>
        )}
      </ul>
    </section>
  );
}
