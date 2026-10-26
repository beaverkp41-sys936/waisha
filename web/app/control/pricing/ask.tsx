"use client";
import { useState } from "react";

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

function Question({ q, setQ, dims, corridors }: {
  q: Q; setQ: (n: Partial<Q>) => void; dims: Dim[]; corridors: Corridor[];
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
      <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
        Priced by
        <select className={`${cell} mt-4`} style={cellStyle} value={q.basis}
          onChange={e => setQ({ basis: e.target.value })}>
          <option value="">let the register answer every basis</option>
          {bases.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select></span></label>
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

export function PricingAsk({ desk, dims, corridors }:
  { desk: Desk; dims: Dim[]; corridors: Corridor[] }) {
  return (
    <>
      <WhatStands desk={desk} dims={dims} corridors={corridors} />
      <WorkQuote desk={desk} dims={dims} corridors={corridors} />
      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
        Both panels read <code>control.pricing.view</code> and write nothing: they are the register
        answering, not a desk deciding. A quote read here is not a booking, and no price appears in a
        published list until a second seat signs it on Approvals.
      </p>
    </>
  );
}
