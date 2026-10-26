"use client";
import { useState, type ReactNode } from "react";

/**
 * The two doors that answer a question (140).
 *
 * `What stands` is `GET /control/pricing/rate` — one scope, one day, the line the register itself
 * picks. `Work a quote` is `GET /control/pricing/quote` — the same price multiplied by the quantity
 * the job carries, with the working printed beside it.
 *
 * Neither panel ever does arithmetic. A quote this screen assembled from a rate and a distance would
 * be a figure the register never said, and 140 exists because a freight price that is worked out in
 * two places disagrees in the third. So the rate is printed exactly as the column returns it — four
 * decimals, trailing zeros included, because that text is what the second seat's signature is cut on
 * — and the refusal is printed in full, since `no_price` ("The price is not zero — it has not been
 * set") is the answer a clerk has to be able to read out loud.
 */

const cell = "w-full rounded-input border px-8 py-8 text-sm";
const cellStyle = { borderColor: "var(--adm-line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const btn = "waisha-btn rounded-input px-16 py-8 text-xs font-semibold";
const th = "border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]";
const td = "border-b px-8 py-8 align-top";

/** Everything the desk needs from the page that owns the session. Same arrangement the ledger desk
 *  uses for the registers above its book: one set of cookies, one duty list, one green strip. */
export interface Desk {
  call: (path: string, method?: string, body?: unknown) => Promise<any>;
  fig: (v: unknown) => string;
  today: () => string;
  notify: (s: string) => void;
  fault: (s: string) => void;
  can: { manage: boolean; publish: boolean };
}

/** One row of `pricing_dimensions` — the vocabulary the register prices on, read from
 *  `GET /control/pricing/dimensions` rather than copied into this file. */
export interface Dim { kind: string; key: string; label: string; needs: string | null; sort: number }

/** One corridor of this book, as `GET /control/pricing/corridors` returns it. */
export interface Corridor {
  id: string; name: string; corridor: string | null; origin: string; dest: string;
  distance_km: number | null; has_distance: boolean; duration_hours: number | null;
  road_class: string | null; priced_on: number; updated_at: string;
}

/** What one basis multiplies, in the words the desk hands the clerk beside the field. */
const NEEDS: Record<string, string> = {
  distance_km: "the kilometres on file for the corridor",
  tonnes: "the job’s tonnage",
  teu: "how many containers it carries",
  cbm: "the job’s cubic metres",
  days: "how many days it runs",
  one: "nothing — one trip is the quantity",
  none: "nothing — the figure is the whole charge"
};

/** A question is only asked with the halves that were typed; an empty one is left out so the door
 *  answers with its own default rather than with an empty string the register would refuse. */
function qs(parts: object): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(parts)) {
    const s = String(v ?? "").trim();
    if (s) out.push(`${k}=${encodeURIComponent(s)}`);
  }
  return out.join("&");
}

const labelOf = (dims: Dim[], kind: string, key?: string | null) =>
  key ? (dims.find(d => d.kind === kind && d.key === key)?.label ?? key) : "";

/** Which quantity each basis multiplies, in the field the register will ask for. A basis missing from
 *  this map — `per_trip`, `flat`, `per_km` — has no box, because its half of the multiplication is
 *  either already one or is filed on the corridor rather than typed on the desk. */
const FIELD_FOR: Record<string, keyof Qty> = {
  tonnes: "tonnes", teu: "teu", cbm: "cbm", days: "days"
};
const QTY_KEYS: (keyof Qty)[] = ["tonnes", "teu", "cbm", "days"];
const FIELD_LABEL: Record<keyof Qty, string> = {
  tonnes: "Tonnage", teu: "Containers (TEU)", cbm: "Cubic metres", days: "Days"
};

interface Q { day: string; code: string; route: string; vehicle_class: string; container: string; basis: string }
interface Qty { tonnes: string; teu: string; cbm: string; days: string }
const EMPTY: Q = { day: "", code: "", route: "", vehicle_class: "", container: "", basis: "" };
const EMPTY_QTY: Qty = { tonnes: "", teu: "", cbm: "", days: "" };

function Question({ q, setQ, dims, corridors, noBasis }: {
  q: Q; setQ: (n: Partial<Q>) => void; dims: Dim[]; corridors: Corridor[]; noBasis?: boolean;
}) {
  const classes = dims.filter(d => d.kind === "vehicle_class");
  const containers = dims.filter(d => d.kind === "container");
  const bases = dims.filter(d => d.kind === "basis");
  return (
    <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
      <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
        The day the price is asked for
        <input className={`${cell} mt-4`} style={cellStyle} value={q.day} placeholder="blank is the register’s own today"
          onChange={e => setQ({ day: e.target.value })} /></span></label>
      <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
        Price list
        <input className={`${cell} mt-4`} style={cellStyle} value={q.code} placeholder="FREIGHT-STD · blank is any live list"
          onChange={e => setQ({ code: e.target.value })} /></span></label>
      <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
        Corridor
        <select className={`${cell} mt-4`} style={cellStyle} value={q.route}
          onChange={e => setQ({ route: e.target.value })}>
          <option value="">any route</option>
          {corridors.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}{c.distance_km === null ? " (no distance filed)" : ` — ${c.distance_km} km`}
            </option>
          ))}
        </select></span></label>
      <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
        Vehicle class
        <select className={`${cell} mt-4`} style={cellStyle} value={q.vehicle_class}
          onChange={e => setQ({ vehicle_class: e.target.value })}>
          <option value="">any class</option>
          {classes.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select></span></label>
      <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
        Container kind
        <select className={`${cell} mt-4`} style={cellStyle} value={q.container}
          onChange={e => setQ({ container: e.target.value })}>
          <option value="">any / not a container</option>
          {containers.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select></span></label>
      {!noBasis && (
        <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
          Priced by
          <select className={`${cell} mt-4`} style={cellStyle} value={q.basis}
            onChange={e => setQ({ basis: e.target.value })}>
            <option value="">let the register answer every basis</option>
            {bases.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select></span></label>
      )}
    </div>
  );
}

/** The other bases that stand for the same scope on the same day. A clerk told one figure and never
 *  told that a handling charge stands beside it is a clerk who under-quotes, so the register names
 *  them and the desk prints them. */
function AlsoSaid({ price }: { price: any }) {
  const bases = (price?.other_bases ?? []) as any[];
  if (!bases.length) return null;
  return (
    <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
      {bases.length === 1 ? "One price also" : `${bases.length} prices also`} stands for that same scope
      {" — "}
      {bases.map((b, i) => (
        <span key={i}>
          {i > 0 ? ", " : ""}
          <strong style={{ color: "var(--ink)" }}>{b.basis}</strong> at {b.rate} ({b.ref} v{b.version})
        </span>
      ))}.
    </p>
  );
}

function WhatStands({ desk, dims, corridors }:
  { desk: Desk; dims: Dim[]; corridors: Corridor[] }) {
  const [q, setQState] = useState<Q>(EMPTY);
  const [hit, setHit] = useState<any | null>(null);
  const [no, setNo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setQ = (n: Partial<Q>) => { setQState(x => ({ ...x, ...n })); setHit(null); setNo(null); };

  async function ask() {
    setBusy(true); setNo(null); setHit(null);
    try {
      setHit(await desk.call(`/control/pricing/rate?${qs(q)}`));
    } catch (e) {
      // A `no_price` is an answer about the book, not a fault with the desk, so it belongs in the
      // panel that asked — the page's own alert strip would leave the clerk reading a sentence with
      // no question above it.
      setNo((e as Error).message);
    } finally { setBusy(false); }
  }

  const p = hit?.price;
  return (
    <section className="mb-24 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
      <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>What stands for one job</h2>
      <p className="mt-4 mb-16 text-xs" style={{ color: "var(--ink-soft)" }}>
        One scope, one day, and the line the register itself picks: a price that names the corridor
        beats one that names only the vehicle class, and the least specific is the wildcard. Asked with
        no basis it answers the most specific line and names the others that also stand, so the desk
        never shows half of a price list.
      </p>

      <Question q={q} setQ={setQ} dims={dims} corridors={corridors} />

      <div className="mt-16 flex flex-wrap items-center gap-12">
        <button className={btn} disabled={busy} onClick={ask}>
          {busy ? "Asking the register…" : "Ask what it costs"}
        </button>
        <button className="text-xs underline" style={{ color: "var(--ink-soft)" }}
          onClick={() => { setQ(EMPTY); }}>clear</button>
      </div>

      {no && (
        <div className="mt-16 rounded-input px-12 py-8 text-sm" role="alert"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {no}
        </div>
      )}

      {p && (
        <div className="mt-16 rounded-card border p-16"
          style={{ borderColor: "var(--success)", background: "color-mix(in srgb, var(--success) 7%, transparent)" }}>
          <p className="text-lg font-bold" style={{ color: "var(--ink)" }}>
            {p.rate} <span className="text-sm font-semibold">{p.currency}</span>
            <span className="ml-8 text-sm font-normal" style={{ color: "var(--ink-soft)" }}>
              {p.basis_label ?? p.basis}
              {p.basis === "per_km" && p.distance_km !== null
                ? ` × ${p.distance_km} km on ${p.route ?? "the corridor"}` : ""}
            </span>
          </p>
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            {p.ref} v{p.version} — {p.label} ({p.code}) · in force from {p.effective_from}
            {p.effective_to ? ` to ${p.effective_to}` : " with no end"} · asked on {hit.asked_on}
          </p>
          <p className="mt-8 text-xs" style={{ color: "var(--ink)" }}>
            Scope: {p.route ?? "any route"} · {labelOf(dims, "vehicle_class", p.vehicle_class) || "any class"}
            {" · "}{labelOf(dims, "container", p.container_type) || "no container"}
            {p.min_charge ? ` · never under ${p.min_charge} ${p.currency}` : ""}
            {` — matched on ${p.specificity} of 3 halves`}
          </p>
          <AlsoSaid price={hit} />
        </div>
      )}
    </section>
  );
}

function WorkQuote({ desk, dims, corridors }:
  { desk: Desk; dims: Dim[]; corridors: Corridor[] }) {
  const [q, setQState] = useState<Q>(EMPTY);
  const [qty, setQtyState] = useState<Qty>(EMPTY_QTY);
  const [hit, setHit] = useState<any | null>(null);
  const [no, setNo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setQ = (n: Partial<Q>) => { setQState(x => ({ ...x, ...n })); setHit(null); setNo(null); };
  const setQty = (n: Partial<Qty>) => { setQtyState(x => ({ ...x, ...n })); setHit(null); setNo(null); };

  const basisDim = dims.find(d => d.kind === "basis" && d.key === q.basis);
  const needs = basisDim?.needs ?? "";
  // A basis with no quantity to multiply (`per_trip`, `flat`) needs no field; `per_km` needs the
  // corridor rather than a typed figure, and the register refuses the quote when the road has never
  // been measured — which is the one thing the desk can say before the press rather than after.
  const one = FIELD_FOR[needs];
  const fields = basisDim ? (one ? [one] : []) : QTY_KEYS;
  const corridor = corridors.find(c => c.id === q.route);
  const kmMissing = needs === "distance_km" && !!corridor && corridor.distance_km === null;

  async function ask() {
    setBusy(true); setNo(null); setHit(null);
    // Only the quantities the chosen basis actually multiplies go out. A figure left in a box the
    // clerk has since hidden would be a quantity the register was never asked to use.
    const asked: Record<string, string> = { ...q };
    for (const f of fields) asked[f] = qty[f];
    try {
      setHit(await desk.call(`/control/pricing/quote?${qs(asked)}`));
    } catch (e) { setNo((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <section className="mb-24 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
      <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>Work a quote</h2>
      <p className="mt-4 mb-16 text-xs" style={{ color: "var(--ink-soft)" }}>
        The same price the register just stood, multiplied by the quantity the job carries, with the
        minimum charge applied inside the same statement. Nothing here is worked out on the desk: the
        figure below is the one the register says, and the sentence beside it is how it got there.
      </p>

      <Question q={q} setQ={setQ} dims={dims} corridors={corridors} />

      <div className="mt-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
        {fields.map(f => (
          <label key={f}><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
            {FIELD_LABEL[f]}
            <input className={`${cell} mt-4`} style={cellStyle} value={qty[f]} inputMode="decimal"
              placeholder={f === "teu" || f === "days" ? "12" : "18.5"}
              onChange={e => setQty({ [f]: e.target.value.replace(/,/g, "") })} /></span></label>
        ))}
        {basisDim && (needs === "one" || needs === "none") && (
          <p className="self-end text-xs" style={{ color: "var(--ink-soft)" }}>
            {basisDim.label} needs no quantity — {NEEDS[needs]}.
          </p>
        )}
        {basisDim && needs === "distance_km" && (
          <p className="self-end text-xs" style={{ color: kmMissing ? "var(--danger)" : "var(--ink-soft)" }}>
            {kmMissing
              ? `${corridor?.name} has no distance on file, so a per-kilometre price has nothing to `
                + "multiply. File it on the Roads tab first — the register will refuse this quote."
              : "The kilometres come off the corridor, not off a typed box: the register multiplies by "
                + "the distance on file for the road it was priced along."}
          </p>
        )}
      </div>

      <div className="mt-16 flex flex-wrap items-center gap-12">
        <button className={btn} disabled={busy} onClick={ask}>
          {busy ? "Working it out…" : "Ask the register to price it"}
        </button>
        <button className="text-xs underline" style={{ color: "var(--ink-soft)" }}
          onClick={() => { setQ(EMPTY); setQty(EMPTY_QTY); }}>clear</button>
      </div>

      {no && (
        <div className="mt-16 rounded-input px-12 py-8 text-sm" role="alert"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {no}
        </div>
      )}

      {hit?.amount && (
        <div className="mt-16 rounded-card border p-16"
          style={{ borderColor: "var(--success)", background: "color-mix(in srgb, var(--success) 7%, transparent)" }}>
          <p className="text-xl font-bold" style={{ color: "var(--ink)" }}>
            {desk.fig(hit.amount)} <span className="text-sm font-semibold">{hit.currency}</span>
          </p>
          <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>{hit.working}</p>
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            {hit.rate} per {hit.basis} × {hit.quantity} · {hit.card?.ref} v{hit.card?.version}
            {" "}({hit.card?.code}) in force {hit.card?.effective_from}
            {hit.card?.effective_to ? ` to ${hit.card.effective_to}` : ""} · asked on {hit.asked_on}
          </p>
          {hit.floor_applied && (
            <p className="mt-8 text-xs font-semibold" style={{ color: "var(--danger)" }}>
              The figure the multiplication gave was under this book&rsquo;s floor, so the register held it
              up to {hit.min_charge} {hit.currency}. The minimum is part of the price, not a discount
              taken off it later.
            </p>
          )}
          <AlsoSaid price={hit} />
        </div>
      )}
    </section>
  );
}

/** One row of the in-force board, as `pricing_addenda_in_force` prints it. The desk needs no kind
 *  catalog here: every row carries its own sign and says whether it counts places. */
interface InForceRow {
  id: string; ref: string; code: string; kind: string; label: string; sign: number;
  counted: boolean; currency: string; version: number; basis: string; value: string;
  cap: string | null; min_amount: string | null; max_uses: number | null; uses_taken: number;
  scope: string | null; route_id: string | null; vehicle_class: string | null;
  container_type: string | null; effective_from: string | null; effective_to: string | null;
}

/** A row the composer applied, either as an extra stacked on the freight or as a code taken off it. */
interface AppliedRow {
  id: string; ref: string; code: string; kind: string; label: string; basis: string; value: string;
  amount: string; capped: boolean; floor_applied: boolean; clipped_to_job?: boolean;
  cap: string | null; min_amount: string | null; scope: string | null; effective_from?: string | null;
  counted?: boolean; max_uses?: number | null; uses_taken?: number | null; uses_left?: number | null;
}

function Applied({ rows, sign, desk, dims }:
  { rows: AppliedRow[]; sign: 1 | -1; desk: Desk; dims: Dim[] }) {
  if (!rows.length) return null;
  return (
    <ul className="mt-8 space-y-6">
      {rows.map(r => (
        <li key={r.ref} className="text-xs" style={{ color: "var(--ink)" }}>
          <span className="font-semibold" style={{ color: sign > 0 ? "var(--danger)" : "var(--success)" }}>
            {sign > 0 ? "+" : "−"}{desk.fig(r.amount)}
          </span>
          {" "}<strong>{r.label}</strong>
          <span style={{ color: "var(--ink-soft)" }}>
            {" "}{r.value} {labelOf(dims, "basis", r.basis) || r.basis} · {r.ref} ({r.code})
          </span>
          <span className="block pl-12" style={{ color: "var(--ink-soft)" }}>
            {r.scope ?? "every job in this book"}
            {r.capped ? " · held to its own ceiling" : ""}
            {r.floor_applied ? " · held up to its own floor" : ""}
            {r.clipped_to_job ? " · clipped to what is payable, so no quote comes back negative" : ""}
            {r.counted && r.max_uses !== null && r.max_uses !== undefined
              ? ` · ${r.uses_left} of ${r.max_uses} places still free (${r.uses_taken} taken)` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Which charges stand on this scope on this day, and how many places are left on each. This is the
 *  availability a quotation is answered from without spending anything: a clerk asked "can this customer
 *  still use NEWYEAR" is told here, and the place is only taken afterwards by the desk that claims it.
 *
 *  The in-force door matches on six halves only — day, kind, code, corridor, class, container — and has
 *  no basis, because a charge's basis is not one of the things it is matched on. So this panel borrows
 *  the shared question with the basis picker put away rather than sending a word the door would refuse,
 *  and rather than leaving a select on the desk that changes nothing. */
function WhatStandsOnIt({ desk, dims, corridors }:
  { desk: Desk; dims: Dim[]; corridors: Corridor[] }) {
  const [q, setQState] = useState<Q>(EMPTY);
  const [kind, setKind] = useState("");
  const [rows, setRows] = useState<InForceRow[] | null>(null);
  const [askedOn, setAskedOn] = useState("");
  const [no, setNo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setQ = (n: Partial<Q>) => { setQState(x => ({ ...x, ...n })); setRows(null); setNo(null); };

  async function ask() {
    setBusy(true); setNo(null); setRows(null);
    try {
      // Only the halves the door accepts go out — `q.basis` is left behind rather than refused.
      const j = await desk.call(`/control/pricing/charges/in-force?${qs({
        day: q.day, code: q.code, route: q.route, vehicle_class: q.vehicle_class,
        container: q.container, kind: kind.trim().toLowerCase().replace(/\s+/g, "_")
      })}`);
      setRows((j.rows ?? []) as InForceRow[]);
      setAskedOn(String(j.asked_on ?? ""));
    } catch (e) { setNo((e as Error).message); }
    finally { setBusy(false); }
  }

  const levies = (rows ?? []).filter(r => r.sign > 0);
  const codes = (rows ?? []).filter(r => r.sign < 0);

  return (
    <section className="mb-24 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
      <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>
        What stands on that scope today
      </h2>
      <p className="mt-4 mb-16 text-xs" style={{ color: "var(--ink-soft)" }}>
        Every charge in force on one scope on one day, in the order the composer applies them. These are
        the ones a quote carries whether anybody names them or not, and the codes a clerk is allowed to
        name. Nothing here spends a place: a ceiling is only reached by the desk that takes the place.
      </p>

      <Question q={q} setQ={setQ} dims={dims} corridors={corridors} noBasis />

      <div className="mt-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
        <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
          Only one kind of charge
          <input className={`${cell} mt-4`} style={cellStyle} value={kind}
            placeholder="surcharge · promo · blank is both"
            onChange={e => { setKind(e.target.value); setRows(null); }} /></span></label>
        <div className="self-end text-xs" style={{ color: "var(--ink-soft)" }}>
          Asking with no corridor, class or container answers what stands on <em>every</em> job in the
          book — the wildcard scope, not the whole register.
        </div>
      </div>

      <div className="mt-16 flex flex-wrap items-center gap-12">
        <button className={btn} disabled={busy} onClick={ask}>
          {busy ? "Asking the register…" : "Ask what stands on it"}
        </button>
        <button className="text-xs underline" style={{ color: "var(--ink-soft)" }}
          onClick={() => { setQ(EMPTY); setKind(""); }}>clear</button>
      </div>

      {no && (
        <div className="mt-16 rounded-input px-12 py-8 text-sm" role="alert"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {no}
        </div>
      )}

      {rows && (
        <div className="mt-16">
          <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
            {rows.length === 0
              ? "Nothing stands on that scope today."
              : `${rows.length} charge${rows.length === 1 ? "" : "s"} stand on it on ${askedOn}: `}
            {rows.length > 0 && (
              <span className="font-normal" style={{ color: "var(--ink-soft)" }}>
                {levies.length} added, {codes.length} named away
              </span>
            )}
          </p>
          {rows.length === 0 && (
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              A levy that has never been signed adds nothing to a quote and a code that has never been
              signed gives nothing away. A charge in force only from a future day is not on this list yet.
            </p>
          )}
          <div className="mt-12 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
                  {["Charge", "Adds or takes off", "Figure", "Where", "Places", "Window"].map(h => (
                    <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                      <span className="block font-semibold" style={{ color: "var(--ink)" }}>{r.label}</span>
                      <span className="block text-xs font-mono" style={{ color: "var(--ink-soft)" }}>
                        {r.ref} v{r.version} · {r.code}
                      </span>
                    </td>
                    <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                      <span style={{ color: r.sign > 0 ? "var(--danger)" : "var(--success)" }}>
                        {r.sign > 0 ? "added to the freight" : "only when named"}
                      </span>
                    </td>
                    <td className={`${td} whitespace-nowrap`} style={{ borderColor: "var(--adm-line)" }}>
                      {r.sign > 0 ? "+" : "−"}{r.value} {r.currency}
                      <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                        {labelOf(dims, "basis", r.basis) || r.basis}
                        {r.cap ? ` · capped ${r.cap}` : ""}{r.min_amount ? ` · floor ${r.min_amount}` : ""}
                      </span>
                    </td>
                    <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                      <span className="text-xs">{r.scope ?? "every job in this book"}</span>
                    </td>
                    <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                      {!r.counted
                        ? <span style={{ color: "var(--ink-soft)" }}>counts none</span>
                        : r.max_uses === null
                          ? <span style={{ color: "var(--ink-soft)" }}>unlimited</span>
                          : <span>{Math.max(r.max_uses - r.uses_taken, 0)} of {r.max_uses} free</span>}
                    </td>
                    <td className={`${td} whitespace-nowrap`} style={{ borderColor: "var(--adm-line)" }}>
                      {r.effective_from ?? "—"} → {r.effective_to ?? "no end"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/** The whole quote: 140's freight, the levies stacked on it, the named codes taken off it, and the
 *  working printed beside the total. It is one GET and it writes nothing — including no place taken on a
 *  promo, which is why a quotation can be worked out as often as a clerk likes. */
function TheWholeQuote({ desk, dims, corridors }:
  { desk: Desk; dims: Dim[]; corridors: Corridor[] }) {
  const [q, setQState] = useState<Q>(EMPTY);
  const [qty, setQtyState] = useState<Qty>(EMPTY_QTY);
  const [codes, setCodes] = useState("");
  const [hit, setHit] = useState<any | null>(null);
  const [no, setNo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setQ = (n: Partial<Q>) => { setQState(x => ({ ...x, ...n })); setHit(null); setNo(null); };
  const setQty = (n: Partial<Qty>) => { setQtyState(x => ({ ...x, ...n })); setHit(null); setNo(null); };

  const basisDim = dims.find(d => d.kind === "basis" && d.key === q.basis);
  const one = basisDim ? FIELD_FOR[basisDim.needs ?? ""] : undefined;
  const fields = basisDim ? (one ? [one] : []) : QTY_KEYS;
  const corridor = corridors.find(c => c.id === q.route);
  const kmMissing = basisDim?.needs === "distance_km" && !!corridor && corridor.distance_km === null;

  async function ask() {
    setBusy(true); setNo(null); setHit(null);
    const asked: Record<string, string> = { ...q, promo_codes: codes.trim() };
    for (const f of fields) asked[f] = qty[f];
    try { setHit(await desk.call(`/control/pricing/job?${qs(asked)}`)); }
    catch (e) { setNo((e as Error).message); }
    finally { setBusy(false); }
  }

  const extras = (hit?.extras ?? []) as AppliedRow[];
  const offs = (hit?.discounts ?? []) as AppliedRow[];

  return (
    <section className="mb-24 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
      <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>The whole quote</h2>
      <p className="mt-4 mb-16 text-xs" style={{ color: "var(--ink-soft)" }}>
        140&rsquo;s freight, the levies the register stacks on it for that scope and day, and the codes
        named in the box below taken off what is payable — all worked out in one statement, with the
        working printed beside the total. A surcharge is capped by its own ceiling, a code is clipped so
        no quote comes back negative, and a code written in another money than the card is refused rather
        than converted. Naming a code here does not take a place on it.
      </p>

      <Question q={q} setQ={setQ} dims={dims} corridors={corridors} />

      <div className="mt-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
        {fields.map(f => (
          <label key={f}><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
            {FIELD_LABEL[f]}
            <input className={`${cell} mt-4`} style={cellStyle} value={qty[f]} inputMode="decimal"
              placeholder={f === "teu" || f === "days" ? "12" : "18.5"}
              onChange={e => setQty({ [f]: e.target.value.replace(/,/g, "") })} /></span></label>
        ))}
        <label className="lg:col-span-2"><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
          Codes the customer is named
          <input className={`${cell} mt-4`} style={cellStyle} value={codes}
            placeholder="NEWYEAR, EARLY_BIRD · comma separated"
            onChange={e => { setCodes(e.target.value); setHit(null); setNo(null); }} /></span></label>
        {basisDim && needsNote(basisDim, kmMissing, corridor)}
      </div>

      <div className="mt-16 flex flex-wrap items-center gap-12">
        <button className={btn} disabled={busy} onClick={ask}>
          {busy ? "Composing it…" : "Ask the register for the whole quote"}
        </button>
        <button className="text-xs underline" style={{ color: "var(--ink-soft)" }}
          onClick={() => { setQ(EMPTY); setQty(EMPTY_QTY); setCodes(""); }}>clear</button>
      </div>

      {no && (
        <div className="mt-16 rounded-input px-12 py-8 text-sm" role="alert"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {no}
        </div>
      )}

      {hit && (
        <div className="mt-16 rounded-card border p-16"
          style={{ borderColor: "var(--success)", background: "color-mix(in srgb, var(--success) 7%, transparent)" }}>
          <p className="text-xl font-bold" style={{ color: "var(--ink)" }}>
            {desk.fig(hit.total)} <span className="text-sm font-semibold">{hit.currency}</span>
          </p>
          <p className="mt-4 text-sm" style={{ color: "var(--ink)" }}>{hit.working}</p>

          <div className="mt-12 grid gap-8 text-xs sm:grid-cols-3">
            <p style={{ color: "var(--ink-soft)" }}>
              Freight<span className="block text-sm font-semibold" style={{ color: "var(--ink)" }}>
                {desk.fig(hit.freight)} {hit.currency}</span>
              {hit.card?.ref} v{hit.card?.version} ({hit.card?.code}) in force {hit.card?.effective_from}
            </p>
            <p style={{ color: "var(--ink-soft)" }}>
              Levies added<span className="block text-sm font-semibold"
              style={{ color: "var(--danger)" }}>+{desk.fig(hit.extras_total)}</span>
              {hit.charges_in_force?.length ?? 0} standing on that scope
            </p>
            <p style={{ color: "var(--ink-soft)" }}>
              Codes taken off<span className="block text-sm font-semibold"
              style={{ color: "var(--success)" }}>−{desk.fig(hit.discount_total)}</span>
              {hit.codes_in_force?.length ?? 0} available to name
            </p>
          </div>

          <Applied rows={extras} sign={1} desk={desk} dims={dims} />
          <Applied rows={offs} sign={-1} desk={desk} dims={dims} />

          {!extras.length && !offs.length && (
            <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
              Nothing was added and nothing was named away, so the payable figure is the freight. Ask
              “What stands on that scope today” above to see whether the book holds a levy for this
              corridor on this day at all.
            </p>
          )}

          <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
            Asked on {hit.asked_on}
            {hit.codes_in_force?.length
              ? ` · codes the register would honour on this job: ${
                (hit.codes_in_force as any[]).map(c => `${c.code}${c.max_uses == null
                  ? "" : ` (${Math.max(c.max_uses - c.uses_taken, 0)} of ${c.max_uses} places left)`
                }`).join(", ")}` : ""}
          </p>
          <AlsoSaid price={hit} />
        </div>
      )}
    </section>
  );
}

/** The one thing the desk can say about a quantity before the press: `per_km` multiplies the distance on
 *  file, and a road nobody measured has nothing to multiply, so the register will refuse the quote. */
function needsNote(dim: Dim, kmMissing: boolean, corridor?: Corridor): ReactNode {
  const needs = dim.needs ?? "";
  if (needs === "distance_km") {
    return (
      <p className="self-end text-xs" style={{ color: kmMissing ? "var(--danger)" : "var(--ink-soft)" }}>
        {kmMissing
          ? `${corridor?.name} has no distance on file, so a per-kilometre price has nothing to `
            + "multiply. File it on the Roads tab first — the register will refuse this quote."
          : "The kilometres come off the corridor, not off a typed box."}
      </p>
    );
  }
  if (needs === "one" || needs === "none") {
    return (
      <p className="self-end text-xs" style={{ color: "var(--ink-soft)" }}>
        {dim.label} needs no quantity — {NEEDS[needs]}.
      </p>
    );
  }
  return null;
}

export function PricingAsk({ desk, dims, corridors }:
  { desk: Desk; dims: Dim[]; corridors: Corridor[] }) {
  return (
    <>
      <WhatStands desk={desk} dims={dims} corridors={corridors} />
      <WorkQuote desk={desk} dims={dims} corridors={corridors} />
      <WhatStandsOnIt desk={desk} dims={dims} corridors={corridors} />
      <TheWholeQuote desk={desk} dims={dims} corridors={corridors} />
      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
        Every panel here reads <code>control.pricing.view</code> and writes nothing: they are the register
        answering, not a desk deciding. A quote read here is not a booking, a place on a promo is not
        taken by naming its code, and no charge appears on a job until a second seat signs it on
        Approvals.
      </p>
    </>
  );
}
