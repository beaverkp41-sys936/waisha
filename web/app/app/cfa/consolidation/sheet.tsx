"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDownUp, Plus, Printer, X } from "lucide-react";
import { apiFetch } from "../../api-client";
import {
  CAPACITY_LABELS, CONTAINER_LABELS, CONTAINER_TYPES, CURRENCIES, FROZEN_STATUSES,
  MODE_SHORT, NEXT_STATUSES, PAYMENT_COLORS, PAYMENT_LABELS, SPECIALISATION_LABELS,
  STATUS_COLORS, STATUS_LABELS, UNIT_LABELS, capacityText, cbmOf, errorText, fmt,
  geoLabel, money, newParcelDraft, num, parcelBalance, parcelFromRow, parcelPayload,
  paymentStatusOf, qty, unitText
} from "./shared";
import type {
  Carrier, GeoEnd, LegDetail, Letterhead, ManifestStatus, Parcel, ParcelDraft, Specialisation
} from "./shared";

const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const card = "rounded-card border bg-surface p-24";

interface GeoRow { id: number; name_en?: string; name?: string; code?: string }
interface LegForm {
  carrierId: string; routeId: string; billOfLading: string; containerNo: string;
  sealNo: string; containerType: string; departureDate: string; arrivalDate: string;
  currency: string; routingNotes: string; origin: GeoEnd; destination: GeoEnd;
}

const EMPTY_GEO: GeoEnd = { regionId: "", districtId: "", wardId: "", text: "" };

const FORM_EMPTY: LegForm = {
  carrierId: "", routeId: "", billOfLading: "", containerNo: "", sealNo: "",
  containerType: "", departureDate: "", arrivalDate: "", currency: "TZS",
  routingNotes: "", origin: { ...EMPTY_GEO }, destination: { ...EMPTY_GEO }
};

const nameOf = (list: GeoRow[], id: string) => {
  const row = list.find(r => String(r.id) === id);
  return row ? (row.name_en ?? row.name ?? "") : "";
};

type Panel =
  | { kind: "none" }
  | { kind: "new"; draft: ParcelDraft }
  | { kind: "edit"; draft: ParcelDraft }
  | { kind: "settle"; parcel: Parcel; amount: string; reference: string; paidAt: string };

export default function ConsolidationSheet({ id: routeId }: { id?: string | null }) {
  const router = useRouter();
  const id = routeId ?? null;
  const [detail, setDetail] = useState<LegDetail | null>(null);
  const [form, setForm] = useState<LegForm>(FORM_EMPTY);
  const [status, setStatus] = useState<ManifestStatus>("draft");
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [routes, setRoutes] = useState<{ id: string; name: string; corridor: string | null; distance_km: string | null }[]>([]);
  const [regions, setRegions] = useState<GeoRow[]>([]);
  const [geoLists, setGeoLists] = useState<Record<"origin" | "destination", { districts: GeoRow[]; wards: GeoRow[] }>>({
    origin: { districts: [], wards: [] }, destination: { districts: [], wards: [] }
  });
  const [letterhead, setLetterhead] = useState<Letterhead | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [printView, setPrintView] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saved = id !== null;
  const frozen = FROZEN_STATUSES.includes(status);
  // Editing covers the unsaved leg too — that is how the unit gets picked. Only
  // the parcel tools need a saved leg: tracking numbers are issued from its number.
  const editing = !frozen && !printView;
  const pickedCarrier = carriers.find(c => c.id === form.carrierId) ?? detail?.carrier ?? null;

  const fetchDistricts = useCallback(async (side: "origin" | "destination", regionId: string) => {
    if (!regionId) { setGeoLists(g => ({ ...g, [side]: { districts: [], wards: [] } })); return; }
    const res = await apiFetch(`/geo/districts/${regionId}`);
    const list = res.ok ? await res.json() : [];
    setGeoLists(g => ({ ...g, [side]: { ...g[side], districts: list, wards: [] } }));
  }, []);

  const fetchWards = useCallback(async (side: "origin" | "destination", districtId: string) => {
    if (!districtId) { setGeoLists(g => ({ ...g, [side]: { ...g[side], wards: [] } })); return; }
    const res = await apiFetch(`/geo/wards/${districtId}`);
    const list = res.ok ? await res.json() : [];
    setGeoLists(g => ({ ...g, [side]: { ...g[side], wards: list } }));
  }, []);

  const load = useCallback(async () => {
    if (!id) return;
    const res = await apiFetch(`/consolidation/${id}`);
    const j: LegDetail = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Manifest not found.")); return; }
    setDetail(j);
    setStatus(j.status);
    setLetterhead(j.letterhead ?? null);
    setForm({
      carrierId: j.carrier_id, routeId: j.route_id ?? "",
      billOfLading: j.bill_of_lading ?? "", containerNo: j.container_no ?? "",
      sealNo: j.seal_no ?? "", containerType: j.container_type ?? "",
      departureDate: j.departure_date ?? "", arrivalDate: j.arrival_date ?? "",
      currency: j.currency, routingNotes: j.routing_notes ?? "",
      origin: {
        regionId: String(j.origin_region_id ?? ""), districtId: String(j.origin_district_id ?? ""),
        wardId: String(j.origin_ward_id ?? ""), text: j.origin_text ?? ""
      },
      destination: {
        regionId: String(j.dest_region_id ?? ""), districtId: String(j.dest_district_id ?? ""),
        wardId: String(j.dest_ward_id ?? ""), text: j.dest_text ?? ""
      }
    });
    // The saved picks have to be re-expanded so the cascades show their names.
    const ends = {
      origin: { regionId: j.origin_region_id, districtId: j.origin_district_id },
      destination: { regionId: j.dest_region_id, districtId: j.dest_district_id }
    };
    for (const side of ["origin", "destination"] as const) {
      const end = ends[side];
      if (end.regionId) await fetchDistricts(side, String(end.regionId));
      if (end.districtId) await fetchWards(side, String(end.districtId));
    }
    if (j.letterhead?.logo_document_id) {
      const lr = await apiFetch(`/documents/${j.letterhead.logo_document_id}/url`);
      if (lr.ok) { const lj = await lr.json(); setLogoUrl(lj.url); }
    }
  }, [id, fetchDistricts, fetchWards]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    (async () => {
      const [c, r, g] = await Promise.all([
        apiFetch("/consolidation/carriers?active=true"),
        apiFetch("/routes"),
        apiFetch("/geo/regions")
      ]);
      if (c.ok) setCarriers(((await c.json()).carriers ?? []) as Carrier[]);
      if (r.ok) setRoutes(await r.json());
      if (g.ok) setRegions(await g.json());
    })();
  }, []);

  // A leg whose unit was parked after it was opened still has to show that unit.
  const unitChoices = useMemo(() => {
    if (!detail?.carrier) return carriers;
    return carriers.some(c => c.id === detail.carrier.id) ? carriers : [...carriers, detail.carrier];
  }, [carriers, detail]);

  const parcels = useMemo<ParcelDraft[]>(() => detail?.parcels.map(parcelFromRow) ?? [], [detail]);

  const totals = useMemo(() => ({
    kg: num(detail?.weight_on_board_kg), cbm: num(detail?.cbm_total),
    billed: num(detail?.transport_fee_total), collected: num(detail?.amount_paid_total),
    balance: detail ? num(detail.balance_due) : 0
  }), [detail]);

  function pickRegion(side: "origin" | "destination", regionId: string) {
    setForm(f => ({
      ...f,
      [side]: { regionId, districtId: "", wardId: "", text: f[side].text }
    }));
    fetchDistricts(side, regionId);
  }

  function pickDistrict(side: "origin" | "destination", districtId: string) {
    setForm(f => ({ ...f, [side]: { ...f[side], districtId, wardId: "" } }));
    fetchWards(side, districtId);
  }

  function legPayload(f: LegForm) {
    const end = (e: GeoEnd) => ({
      regionId: e.regionId ? Number(e.regionId) : null,
      districtId: e.districtId ? Number(e.districtId) : null,
      wardId: e.wardId ? Number(e.wardId) : null,
      text: e.text.trim() || null
    });
    return {
      carrierId: f.carrierId, origin: end(f.origin), destination: end(f.destination),
      routeId: f.routeId || null, billOfLading: f.billOfLading.trim() || null,
      containerNo: f.containerNo.trim().toUpperCase() || null, sealNo: f.sealNo.trim() || null,
      containerType: f.containerType || null, departureDate: f.departureDate || null,
      arrivalDate: f.arrivalDate || null, currency: f.currency, routingNotes: f.routingNotes.trim() || null
    };
  }

  async function saveLeg() {
    setError(null); setNotice(null);
    if (!form.carrierId) { setError("Pick the unit carrying this leg before saving."); return; }
    if (form.departureDate && form.arrivalDate && form.arrivalDate < form.departureDate) {
      setError("The load cannot arrive before it departs."); return;
    }
    setBusy(true);
    try {
      if (saved) {
        const res = await apiFetch(`/consolidation/${id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(legPayload(form))
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { setError(errorText(j, "Could not save the leg.")); return; }
        setNotice("Leg details saved.");
        await load();
      } else {
        const res = await apiFetch("/consolidation", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(legPayload(form))
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { setError(errorText(j, "Could not open the leg.")); return; }
        router.push(`/app/cfa/consolidation/${j.id}`);
      }
    } finally { setBusy(false); }
  }

  async function changeStatus(next: ManifestStatus) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/consolidation/${id}/status`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not move the leg.")); return; }
      setNotice(`${detail?.manifest_number} is now ${STATUS_LABELS[next].toLowerCase()}.`);
      await load();
    } finally { setBusy(false); }
  }

  function startParcel(): ParcelDraft {
    return newParcelDraft({ specialisation: laneChoices()[0] ?? "" });
  }

  /** The lanes this unit is listed for, general cargo always included. */
  function laneChoices(): Specialisation[] {
    const lanes = (pickedCarrier?.specialisations ?? []) as Specialisation[];
    const extra = lanes.filter(l => l !== "general");
    return ["general", ...extra] as Specialisation[];
  }

  async function saveParcel(draft: ParcelDraft) {
    setError(null); setNotice(null);
    if (draft.consignorName.trim().length < 2) { setError("Every parcel needs a consignor — the paper names who sent it."); return; }
    if (draft.goodsDescription.trim().length < 2) { setError("Describe the goods on the parcel."); return; }
    const phone = draft.consignorPhone.trim();
    if (phone && phone !== draft.storedPhone && !/^\+[1-9]\d{7,14}$/.test(phone)) {
      setError("A consignor phone has to be a full +255 number, or left blank."); return;
    }
    setBusy(true);
    try {
      const body = parcelPayload(draft);
      const res = await apiFetch(
        draft.id ? `/consolidation/${id}/parcels/${draft.id}` : `/consolidation/${id}/parcels`, {
        method: draft.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not save the parcel.")); return; }
      setNotice(draft.id ? "Parcel updated." : `Parcel added as ${j.trackingNumber}.`);
      setPanel({ kind: "none" });
      await load();
    } finally { setBusy(false); }
  }

  async function removeParcel(p: Parcel) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/consolidation/${id}/parcels/${p.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not remove that parcel.")); return; }
      setNotice(`${p.tracking_number} came off the leg — its number stays issued.`);
      await load();
    } finally { setBusy(false); }
  }

  async function settle(p: Extract<Panel, { kind: "settle" }>) {
    setError(null); setNotice(null);
    const amount = Number(p.amount);
    if (!Number.isFinite(amount) || amount < 0) { setError("Enter the amount collected, or 0 to reverse it."); return; }
    const ref = p.reference.trim();
    if (ref && !/^[A-Za-z0-9./# -]{4,60}$/.test(ref)) {
      setError("That payment reference reads like a document number, not a narrative."); return;
    }
    setBusy(true);
    try {
      const res = await apiFetch(`/consolidation/${id}/parcels/${p.parcel.id}/payment`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountPaid: Math.max(0, amount),
          paymentReference: ref || null,
          paidAt: p.paidAt || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not record that payment.")); return; }
      setNotice(`${p.parcel.tracking_number}: ${qty(j.balanceDue)} ${p.parcel.currency} still owing.`);
      setPanel({ kind: "none" });
      await load();
    } finally { setBusy(false); }
  }

  // ---------------- the printed view ----------------

  const labels = {
    origin: detail ? detail.origin_label
      : geoLabel(form.origin, {
        region: nameOf(regions, form.origin.regionId),
        district: nameOf(geoLists.origin.districts, form.origin.districtId),
        ward: nameOf(geoLists.origin.wards, form.origin.wardId)
      }),
    destination: detail ? detail.destination_label
      : geoLabel(form.destination, {
        region: nameOf(regions, form.destination.regionId),
        district: nameOf(geoLists.destination.districts, form.destination.districtId),
        ward: nameOf(geoLists.destination.wards, form.destination.wardId)
      })
  };

  const capacity = detail?.capacity ?? null;
  const currency = form.currency;

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="no-print flex flex-wrap items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
            {saved ? `${detail?.manifest_number ?? "Manifest"}` : "New consolidator leg"}
          </h1>
          <p className="mt-4 text-sm" style={{ color: "var(--ink-soft)" }}>
            {saved
              ? "The unit, the lane and every piece of part load riding them — weighed and settled line by line."
              : "Pick the unit, set the lane, save once, then add the parcels the load is made of."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-12">
          <Link href="/app/cfa/consolidation" className="pane-note text-xs underline">← All legs</Link>
          {saved && (
            <button type="button" onClick={() => setPrintView(v => !v)}
              className="on-photo-btn px-16 py-8 text-xs font-semibold">
              {printView ? "Back to editing" : "Print preview"}
            </button>
          )}
          <button type="button" onClick={() => window.print()}
            className="on-photo-btn inline-flex items-center gap-6 px-16 py-8 text-xs font-semibold">
            <Printer size={14} strokeWidth={1.8} aria-hidden /> Print / Save PDF
          </button>
          {!printView && !frozen && (
            <button type="button" onClick={saveLeg} disabled={busy || !saved && !form.carrierId}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
              {busy ? "Saving…" : saved ? "Save leg" : "Open the leg"}
            </button>
          )}
        </div>
      </div>

      {error && <div role="alert" className="no-print mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="no-print mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {!saved && (
        <div role="status" className="no-print pane-note mt-16 px-12 py-8 text-sm">
          The manifest number is issued by Waisha when the leg is opened, and every parcel gets
          <span className="font-semibold"> {`CSL-0001-001`}</span> style tracking from it. Totals are footed from the
          parcels — weight on board is never typed.
        </div>
      )}

      {frozen && (
        <div role="status" className="no-print pane-note mt-16 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--gold) 14%, transparent)", borderLeft: "4px solid var(--gold)" }}>
          A {STATUS_LABELS[status].toLowerCase()} leg keeps its paper: the cargo, unit and dates are the record now.
          Payments against the parcels can still be entered.
        </div>
      )}

      {/* ---------------- entry form ---------------- */}
      {!printView && (
        <section className={`no-print mt-24 ${card}`} style={inputStyle}>
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            Unit and lane
          </h2>
          <div className="mt-16 grid gap-12 md:grid-cols-3">
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Carrier unit *</span>
              <select value={form.carrierId} disabled={!editing} className={inputCls} style={inputStyle}
                onChange={e => setForm(f => ({ ...f, carrierId: e.target.value }))}>
                <option value="">Pick a registered unit</option>
                {unitChoices.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.display_name} — {unitText(c)}, {capacityText(c)}
                    {c.specialisations.length ? ` · ${c.specialisations.join(", ")}` : " · general only"}
                  </option>
                ))}
              </select>
              {pickedCarrier && !pickedCarrier.is_active && (
                <span className="mt-4 block text-[10px]" style={{ color: "var(--gold)" }}>
                  This unit is parked — existing legs still ride it.
                </span>
              )}
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Registered route</span>
              <select value={form.routeId} disabled={!editing} className={inputCls} style={inputStyle}
                onChange={e => setForm(f => ({ ...f, routeId: e.target.value }))}>
                <option value="">Not on a filed route</option>
                {routes.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.name}{r.corridor ? ` · ${r.corridor}` : ""}{r.distance_km ? ` · ${qty(num(r.distance_km))} km` : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-16 grid gap-16 md:grid-cols-2">
            {(["origin", "destination"] as const).map(side => (
              <div key={side}>
                <p className={labelCls} style={{ color: "var(--ink-soft)" }}>
                  {side === "origin" ? "Origin — where it is collected" : "Destination — where it is delivered"}
                </p>
                <div className="grid gap-8 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Region</span>
                    <select value={form[side].regionId} disabled={!editing}
                      className={`${inputCls} mt-4`} style={inputStyle}
                      onChange={e => pickRegion(side, e.target.value)}>
                      <option value="">Pick region</option>
                      {regions.map(r => <option key={r.id} value={String(r.id)}>{r.name_en}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Council</span>
                    <select value={form[side].districtId} disabled={!editing || !form[side].regionId}
                      className={`${inputCls} mt-4`} style={{ ...inputStyle, opacity: form[side].regionId ? 1 : 0.5 }}
                      onChange={e => pickDistrict(side, e.target.value)}>
                      <option value="">{form[side].regionId ? "Pick council" : "Pick region"}</option>
                      {geoLists[side].districts.map(d => <option key={d.id} value={String(d.id)}>{d.name_en}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>Ward</span>
                    <select value={form[side].wardId} disabled={!editing || !form[side].districtId}
                      className={`${inputCls} mt-4`} style={{ ...inputStyle, opacity: form[side].districtId ? 1 : 0.5 }}
                      onChange={e => setForm(f => ({ ...f, [side]: { ...f[side], wardId: e.target.value } }))}>
                      <option value="">{form[side].districtId ? "Pick ward" : "Pick council"}</option>
                      {geoLists[side].wards.map(w => <option key={w.id} value={String(w.id)}>{w.name}</option>)}
                    </select>
                  </label>
                </div>
                <label className="mt-8 block">
                  <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>
                    Physical address / berth / plot
                  </span>
                  <input value={form[side].text} disabled={!editing} maxLength={240}
                    className={`${inputCls} mt-4`} style={inputStyle}
                    placeholder={side === "origin" ? "Berth 4, T1 Container Terminal" : "Plot 27, Kisuluilui"}
                    onChange={e => setForm(f => ({ ...f, [side]: { ...f[side], text: e.target.value } }))} />
                </label>
              </div>
            ))}
          </div>

          <div className="mt-16 grid gap-12 md:grid-cols-4">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Departure</span>
              <input type="date" value={form.departureDate} disabled={!editing} className={inputCls} style={inputStyle}
                onChange={e => setForm(f => ({ ...f, departureDate: e.target.value }))} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Arrival</span>
              <input type="date" value={form.arrivalDate} disabled={!editing} className={inputCls} style={inputStyle}
                onChange={e => setForm(f => ({ ...f, arrivalDate: e.target.value }))} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Bill of lading</span>
              <input value={form.billOfLading} disabled={!editing} maxLength={60} className={inputCls} style={inputStyle}
                placeholder="B/L or consignment note"
                onChange={e => setForm(f => ({ ...f, billOfLading: e.target.value }))} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Currency</span>
              <select value={form.currency} disabled={!editing} className={inputCls} style={inputStyle}
                onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
                {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.code}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Container number</span>
              <input value={form.containerNo} disabled={!editing} maxLength={40} className={inputCls} style={inputStyle}
                placeholder="MSKU1234567" onChange={e => setForm(f => ({ ...f, containerNo: e.target.value }))} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Seal number</span>
              <input value={form.sealNo} disabled={!editing} maxLength={40} className={inputCls} style={inputStyle}
                onChange={e => setForm(f => ({ ...f, sealNo: e.target.value }))} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Load type</span>
              <select value={form.containerType} disabled={!editing} className={inputCls} style={inputStyle}
                onChange={e => setForm(f => ({ ...f, containerType: e.target.value }))}>
                <option value="">Not stated</option>
                {CONTAINER_TYPES.map(t => <option key={t} value={t}>{CONTAINER_LABELS[t]}</option>)}
              </select>
            </label>
            <label className="block md:col-span-4">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Routing instructions</span>
              <textarea value={form.routingNotes} disabled={!editing} rows={2} maxLength={1000}
                className={inputCls} style={inputStyle}
                placeholder="Avoid the Weightmo bridge — declared at 32t."
                onChange={e => setForm(f => ({ ...f, routingNotes: e.target.value }))} />
            </label>
          </div>
        </section>
      )}

      {/* ---------------- the manifest ---------------- */}
      <div className="manifest-sheet mt-24 rounded-card border bg-surface p-32" style={inputStyle}>
        <div className="flex items-start justify-between gap-24 border-b pb-24" style={{ borderColor: "var(--ink)" }}>
          <div className="flex items-start gap-16">
            {logoUrl && <img src={logoUrl} alt="Company logo" className="h-64 w-64 object-contain" />}
            <div>
              <p className="text-lg font-bold" style={{ color: "var(--ink)" }}>
                {letterhead?.company_name ?? "Your company"}
              </p>
              {letterhead?.postal_address && (
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  {letterhead.postal_address}{letterhead.street ? `, ${letterhead.street}` : ""}
                </p>
              )}
              {letterhead?.tin_display && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>TIN: {letterhead.tin_display}</p>}
              {letterhead?.vat_number && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>VAT No: {letterhead.vat_number}</p>}
              {letterhead?.brela_number && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>BRELA: {letterhead.brela_number}</p>}
              {letterhead?.branch_email && <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{letterhead.branch_email}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold tracking-[0.06em]" style={{ color: "var(--ink)" }}>CONSOLIDATOR MANIFEST</p>
            <p className="mt-4 text-sm font-semibold" style={{ color: "var(--ink)" }}>
              {detail?.manifest_number ?? "unsaved leg"}
            </p>
            <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              {STATUS_LABELS[status]}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-24 py-24 md:grid-cols-2">
          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Carrying unit</p>
            {pickedCarrier ? (
              <div className="text-sm" style={{ color: "var(--ink)" }}>
                <p className="font-bold">{pickedCarrier.display_name}</p>
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  {UNIT_LABELS[pickedCarrier.unit_type]} · {MODE_SHORT[pickedCarrier.mode]}
                  {pickedCarrier.registration ? ` · ${pickedCarrier.registration}` : ""}
                </p>
                {pickedCarrier.operator_name && (
                  <p className="text-xs" style={{ color: "var(--ink-soft)" }}>Operator: {pickedCarrier.operator_name}</p>
                )}
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  Stated capacity: {capacityText(pickedCarrier)}
                </p>
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  Cargo lanes: {pickedCarrier.specialisations.length
                    ? pickedCarrier.specialisations.map(s => SPECIALISATION_LABELS[s as Specialisation] ?? s).join(", ")
                    : "General cargo only"}
                </p>
                {pickedCarrier.home_base && (
                  <p className="text-xs" style={{ color: "var(--ink-soft)" }}>Base: {pickedCarrier.home_base}</p>
                )}
              </div>
            ) : (
              <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No unit picked yet.</p>
            )}
          </div>

          <div>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>The leg</p>
            <div className="text-sm" style={{ color: "var(--ink)" }}>
              <p className="flex items-start gap-8">
                <ArrowDownUp size={14} strokeWidth={1.8} aria-hidden className="mt-4 shrink-0" />
                <span>
                  <span className="block font-bold">{labels.origin ?? "Origin not set"}</span>
                  <span className="block">{labels.destination ?? "Destination not set"}</span>
                </span>
              </p>
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                Departs {form.departureDate || "—"} · arrives {form.arrivalDate || "—"}
              </p>
              {(form.billOfLading || form.containerNo || form.sealNo || form.containerType) && (
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  {[form.billOfLading && `B/L ${form.billOfLading}`, form.containerNo,
                    form.sealNo && `seal ${form.sealNo}`,
                    form.containerType && CONTAINER_LABELS[form.containerType]]
                    .filter(Boolean).join(" · ")}
                </p>
              )}
              {detail?.route && (
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  Route: {detail.route.name}
                  {detail.route.corridor ? ` (${detail.route.corridor})` : ""}
                  {detail.route.distance_km ? ` · ${qty(num(detail.route.distance_km))} km` : ""}
                </p>
              )}
              {form.routingNotes && (
                <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  Routing: {form.routingNotes}
                </p>
              )}
            </div>
          </div>
        </div>

        <table className="w-full text-xs">
          <thead>
            <tr className="border-y text-left" style={{ borderColor: "var(--ink)" }}>
              <th className="p-8">#</th><th className="p-8">Tracking</th>
              <th className="p-8">Consignor</th><th className="p-8">Goods</th>
              <th className="p-8 text-right">Net kg</th><th className="p-8 text-right">m³</th>
              <th className="p-8">Lane</th><th className="p-8 text-right">Freight</th>
              <th className="p-8 text-right">Paid</th><th className="p-8 text-right">Balance</th>
              <th className="p-8">Settled</th>
              <th className="no-print w-[92px] p-8 text-right">Lines</th>
            </tr>
          </thead>
          <tbody>
            {parcels.map((p, i) => (
              <tr key={p.key} className="border-b align-top" style={{ borderColor: "var(--line)" }}>
                <td className="p-8 tabular-nums" style={{ color: "var(--ink-soft)" }}>{i + 1}</td>
                <td className="p-8 font-semibold" style={{ color: "var(--ink)" }}>{p.trackingNumber}</td>
                <td className="p-8" style={{ color: "var(--ink)" }}>
                  {p.consignorName}
                  {(p.consignorPhone || p.consignorEmail) && (
                    <span className="block" style={{ color: "var(--ink-soft)" }}>
                      {[p.consignorPhone, p.consignorEmail].filter(Boolean).join(" · ")}
                    </span>
                  )}
                  {p.consignorAddress && (
                    <span className="block" style={{ color: "var(--ink-soft)" }}>{p.consignorAddress}</span>
                  )}
                </td>
                <td className="p-8" style={{ color: "var(--ink)" }}>
                  {p.goodsDescription}
                  <span className="block" style={{ color: "var(--ink-soft)" }}>
                    {`${p.packageCount} × ${p.packageKind || "package"}`.trim()}
                    {p.marksNumbers ? ` · marks ${p.marksNumbers}` : ""}
                  </span>
                  {(p.lengthM || p.widthM || p.heightM) && (
                    <span className="block" style={{ color: "var(--ink-soft)" }}>
                      {[p.lengthM, p.widthM, p.heightM].map(v => v ? qty(Number(v)) : "—").join(" × ")} m
                    </span>
                  )}
                </td>
                <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{qty(num(p.netWeightKg))}</td>
                <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{qty(cbmOf(p))}</td>
                <td className="p-8" style={{ color: "var(--ink)" }}>
                  {p.specialisation ? SPECIALISATION_LABELS[p.specialisation] : "General"}
                </td>
                <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(num(p.transportFee))}</td>
                <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmt(num(p.amountPaid))}</td>
                <td className="p-8 text-right font-semibold tabular-nums"
                  style={{ color: parcelBalance(p) > 0 ? "var(--danger)" : "var(--ink-soft)" }}>
                  {fmt(parcelBalance(p))}
                </td>
                <td className="p-8">
                  <span className="px-8 py-2 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${PAYMENT_COLORS[paymentStatusOf(p)]}`, color: "var(--ink)" }}>
                    {PAYMENT_LABELS[paymentStatusOf(p)]}
                  </span>
                  {p.paymentReference && (
                    <span className="block" style={{ color: "var(--ink-soft)" }}>
                      {p.paymentReference}{p.paidAt ? ` · ${p.paidAt}` : ""}
                    </span>
                  )}
                </td>
                <td className="no-print p-8 text-right whitespace-nowrap align-top">
                  {editing && (
                    <button type="button" className="mr-8 underline" style={{ color: "var(--brand)" }}
                      disabled={busy} onClick={() => setPanel({ kind: "edit", draft: p })}>Edit</button>
                  )}
                  {/* Delivery freezes the paper, not the money: a payment that lands
                      after the cargo arrives still has to be able to reach the line. */}
                  {!printView && num(p.transportFee) > 0 && (
                    <button type="button" className="mr-8 underline" style={{ color: "var(--ink)" }}
                      disabled={busy}
                      onClick={() => setPanel({
                        kind: "settle", parcel: detail!.parcels.find(x => x.id === p.id)!,
                        amount: p.amountPaid, reference: p.paymentReference, paidAt: p.paidAt
                      })}>Settle</button>
                  )}
                  {editing && (
                    <button type="button" className="underline" style={{ color: "var(--danger)" }}
                      disabled={busy || num(p.amountPaid) > 0}
                      onClick={() => detail && removeParcel(detail.parcels.find(x => x.id === p.id)!)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!parcels.length && (
              <tr><td colSpan={12} className="p-16 text-center text-xs" style={{ color: "var(--ink-soft)" }}>
                {saved ? "No parcels on this leg yet." : "The leg has to be opened before parcels can be listed."}
              </td></tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-b font-bold" style={{ borderColor: "var(--ink)" }}>
              <td className="p-8" colSpan={4}>
                {parcels.length} parcel line(s) consolidated
              </td>
              <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{qty(totals.kg)}</td>
              <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{qty(totals.cbm)}</td>
              <td></td>
              <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(totals.billed)}</td>
              <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{fmt(totals.collected)}</td>
              <td className="p-8 text-right tabular-nums" style={{ color: totals.balance > 0 ? "var(--danger)" : "var(--ink)" }}>
                {fmt(totals.balance)}
              </td>
              <td className="p-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>{currency}</td>
              <td className="no-print"></td>
            </tr>
          </tfoot>
        </table>

        {capacity?.over_capacity && (
          <p className="mt-16 px-12 py-8 text-xs"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
            On board {qty(capacity.weight_on_board_kg)} kg against a stated capacity of{" "}
            {qty(num(pickedCarrier?.capacity_max ?? null))} {CAPACITY_LABELS[capacity.unit]} —
            this leg is over the unit's stated capacity and cannot be dispatched as it stands.
          </p>
        )}
        {capacity && capacity.stated_in_mass && capacity.utilisation_pct !== null && !capacity.over_capacity && (
          <p className="mt-16 text-xs" style={{ color: "var(--ink-soft)" }}>
            Utilisation {capacity.utilisation_pct}% of the stated {CAPACITY_LABELS[capacity.unit]} capacity.
          </p>
        )}

        {detail?.settlement && (detail.settlement.parcels_partial + detail.settlement.parcels_unpaid) > 0 && (
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            Settlement: {detail.settlement.parcels_paid} paid, {detail.settlement.parcels_partial} partially paid,{" "}
            {detail.settlement.parcels_unpaid} unpaid — {fmt(detail.settlement.balance_due)} {currency} owing on the leg.
          </p>
        )}

        <div className="mt-32 grid grid-cols-1 gap-24 pt-24 sm:grid-cols-3" style={{ borderTop: "1px solid var(--line)" }}>
          {["Consolidated by", "Driver / agent received", "Consignee accepted"].map(role => (
            <div key={role} className="sig-block">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{role}</p>
              <p className="mt-24 border-b" style={{ borderColor: "var(--ink)" }} />
              <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>Signature and date</p>
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- parcel tools ---------------- */}
      {saved && editing && panel.kind === "none" && (
        <div className="no-print mt-24 flex flex-wrap items-center gap-12">
          <button type="button" onClick={() => setPanel({ kind: "new", draft: startParcel() })}
            className="waisha-btn inline-flex items-center gap-6 rounded-input px-16 py-8 text-xs font-semibold">
            <Plus size={14} strokeWidth={2} aria-hidden /> Add a parcel line
          </button>
          <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
            Each line is issued its own tracking number from {detail?.manifest_number ?? "the leg"}.
          </span>
        </div>
      )}

      {(panel.kind === "new" || panel.kind === "edit") && (
        <ParcelForm draft={panel.draft} lanes={laneChoices()} unitName={pickedCarrier?.display_name ?? "the unit"}
          busy={busy} mode={panel.kind}
          onChange={patch => setPanel(p => (p.kind === "new" || p.kind === "edit" ? { ...p, draft: { ...p.draft, ...patch } } : p))}
          onSave={() => saveParcel((panel as { draft: ParcelDraft }).draft)}
          onCancel={() => setPanel({ kind: "none" })} />
      )}

      {panel.kind === "settle" && (
        <SettleForm panel={panel} busy={busy}
          onChange={patch => setPanel(p => (p.kind === "settle" ? { ...p, ...patch } : p))}
          onSave={() => settle(panel)} onCancel={() => setPanel({ kind: "none" })} />
      )}

      {saved && (
        <section className={`no-print mt-24 ${card}`} style={inputStyle}>
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            Leg state
          </h2>
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            A leg moves draft → manifested → in transit → delivered. The stage after draft needs at least one parcel
            on board, and a delivered leg closes its own paper.
          </p>
          <div className="mt-16 flex flex-wrap items-center gap-12">
            {NEXT_STATUSES[status].map(next => (
              <button key={next} type="button" disabled={busy} onClick={() => changeStatus(next)}
                className={next === "cancelled" ? "on-photo-btn px-16 py-8 text-xs font-semibold" : "waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50"}
                style={next === "cancelled" ? undefined : { background: "var(--danger)", color: "#fff" }}>
                {next === "manifested" ? "Mark manifested" : next === "in_transit" ? "Dispatch"
                  : next === "delivered" ? "Mark delivered" : next === "cancelled" ? "Cancel the leg" : "Reopen as draft"}
              </button>
            ))}
            {!NEXT_STATUSES[status].length && (
              <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                This leg is closed — a delivered manifest has no way back.
              </span>
            )}
            <span className="px-8 py-4 text-[10px] font-bold uppercase"
              style={{ borderLeft: `4px solid ${STATUS_COLORS[status]}`, color: "var(--ink)" }}>
              {STATUS_LABELS[status]}
            </span>
          </div>
        </section>
      )}

      <p className="no-print pane-note mt-24 text-xs">
        Freight and payments are recorded here for the office's own reckoning; Waisha never moves money and holds no
        payment credentials — only the reference the clerk types from the slip.
      </p>
    </div>
  );
}

// ---------------- module-level pieces ----------------

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>{label}</span>
      {children}
    </label>
  );
}

function ParcelForm({ draft, lanes, unitName, mode, busy, onChange, onSave, onCancel }: {
  draft: ParcelDraft; lanes: Specialisation[]; unitName: string; mode: "new" | "edit";
  busy: boolean; onChange: (patch: Partial<ParcelDraft>) => void;
  onSave: () => void; onCancel: () => void;
}) {
  const cbm = cbmOf(draft);
  const balance = parcelBalance(draft);
  return (
    <section className={`no-print mt-24 ${card}`} style={inputStyle}>
      <div className="flex items-start justify-between gap-12">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            {mode === "new" ? "Parcel on this leg" : `Editing ${draft.trackingNumber}`}
          </h2>
          <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
            Riding {unitName}. Weight, cube and freight are footed into the leg total the moment this is saved.
          </p>
        </div>
        <button type="button" onClick={onCancel} aria-label="Close the parcel form"
          className="on-photo-btn inline-flex items-center gap-6 px-12 py-6 text-xs font-semibold">
          <X size={14} strokeWidth={2} aria-hidden /> Close
        </button>
      </div>

      <div className="mt-16 grid gap-12 md:grid-cols-3">
        <Cell label="Consignor full name *">
          <input required value={draft.consignorName} maxLength={160} className={inputCls} style={inputStyle}
            placeholder="As on the delivery note" onChange={e => onChange({ consignorName: e.target.value })} />
        </Cell>
        <Cell label="Consignor phone">
          <input value={draft.consignorPhone} className={inputCls} style={inputStyle} placeholder="+255712345678"
            onChange={e => onChange({ consignorPhone: e.target.value })} />
          <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
            Stored encrypted. {draft.storedPhone ? "Leave blank to keep the number on file." : "Blank until entered."}
          </span>
        </Cell>
        <Cell label="Consignor email">
          <input type="email" value={draft.consignorEmail} maxLength={254} className={inputCls} style={inputStyle}
            onChange={e => onChange({ consignorEmail: e.target.value })} />
        </Cell>
        <Cell label="Physical / postal address">
          <input value={draft.consignorAddress} maxLength={300} className={inputCls} style={inputStyle}
            placeholder="Plot, street, P.O. Box" onChange={e => onChange({ consignorAddress: e.target.value })} />
        </Cell>
        <Cell label="Goods description *">
          <input required value={draft.goodsDescription} maxLength={300} className={inputCls} style={inputStyle}
            placeholder="1 pallet of roofing sheets" onChange={e => onChange({ goodsDescription: e.target.value })} />
        </Cell>
        <Cell label="Cargo lane">
          <select value={draft.specialisation || "general"} className={inputCls} style={inputStyle}
            onChange={e => onChange({ specialisation: e.target.value as Specialisation })}>
            {lanes.map(l => <option key={l} value={l}>{SPECIALISATION_LABELS[l]}</option>)}
          </select>
          <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
            Only lanes {unitName} is listed for can be picked.
          </span>
        </Cell>
        <Cell label="Packages">
          <div className="flex gap-8">
            <input type="number" min={1} step={1} value={draft.packageCount}
              className={`${inputCls} w-[90px]`} style={inputStyle}
              onChange={e => onChange({ packageCount: e.target.value })} />
            <input value={draft.packageKind} maxLength={60} className={`${inputCls} flex-1`} style={inputStyle}
              placeholder="pallet, drum, carton" onChange={e => onChange({ packageKind: e.target.value })} />
          </div>
        </Cell>
        <Cell label="Marks and numbers">
          <input value={draft.marksNumbers} maxLength={120} className={inputCls} style={inputStyle}
            placeholder="KIL/DR/01-04" onChange={e => onChange({ marksNumbers: e.target.value })} />
        </Cell>
        <Cell label="Net weight (kg)">
          <input type="number" min={0} step="0.001" value={draft.netWeightKg} className={inputCls} style={inputStyle}
            placeholder="weighed, not guessed" onChange={e => onChange({ netWeightKg: e.target.value })} />
        </Cell>
        <Cell label="Dimensions L × W × H (metres)">
          <div className="flex gap-8">
            {(["lengthM", "widthM", "heightM"] as const).map(k => (
              <input key={k} type="number" min={0} step="0.01" value={draft[k]} className={`${inputCls} flex-1`}
                style={inputStyle} placeholder={k === "lengthM" ? "L" : k === "widthM" ? "W" : "H"}
                onChange={e => onChange({ [k]: e.target.value } as Partial<ParcelDraft>)} />
            ))}
          </div>
          <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
            {cbm ? `${qty(cbm)} m³ measured from the three dimensions` : "All three to get a cube"}
          </span>
        </Cell>
        <Cell label="Transport fee on this parcel">
          <input type="number" min={0} step="0.01" value={draft.transportFee} className={inputCls} style={inputStyle}
            onChange={e => onChange({ transportFee: e.target.value })} />
          <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
            Collected so far {fmt(num(draft.amountPaid))} · balance {fmt(balance)}
          </span>
        </Cell>
        <Cell label="Office notes (not printed)">
          <input value={draft.notes} maxLength={600} className={inputCls} style={inputStyle}
            onChange={e => onChange({ notes: e.target.value })} />
        </Cell>
      </div>

      <div className="mt-16 flex flex-wrap items-center gap-12">
        <button type="button" onClick={onSave} disabled={busy}
          className="waisha-btn rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-50">
          {busy ? "Saving…" : mode === "new" ? "Add parcel to the leg" : "Save parcel"}
        </button>
        <button type="button" onClick={onCancel} className="on-photo-btn px-16 py-8 text-xs font-semibold">Discard</button>
      </div>
    </section>
  );
}

function SettleForm({ panel, busy, onChange, onSave, onCancel }: {
  panel: Extract<Panel, { kind: "settle" }>; busy: boolean;
  onChange: (patch: { amount?: string; reference?: string; paidAt?: string }) => void;
  onSave: () => void; onCancel: () => void;
}) {
  const fee = num(panel.parcel.transport_fee);
  const amount = Number(panel.amount) || 0;
  const balance = money(Math.max(0, fee - amount));
  return (
    <section className={`no-print mt-24 ${card}`} style={inputStyle}>
      <div className="flex items-start justify-between gap-12">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            Settlement on {panel.parcel.tracking_number}
          </h2>
          <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
            {panel.parcel.consignor_name} · {panel.parcel.goods_description} — owes {fmt(fee)} {panel.parcel.currency}.
          </p>
        </div>
        <button type="button" onClick={onCancel} aria-label="Close the settlement form"
          className="on-photo-btn inline-flex items-center gap-6 px-12 py-6 text-xs font-semibold">
          <X size={14} strokeWidth={2} aria-hidden /> Close
        </button>
      </div>
      <div className="mt-16 grid gap-12 md:grid-cols-3">
        <Cell label="Total collected on this parcel">
          <input type="number" min={0} step="0.01" value={panel.amount} className={inputCls} style={inputStyle}
            onChange={e => onChange({ amount: e.target.value })} />
          <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
            Enter the running total, not this payment alone — the balance is footed from it.
          </span>
        </Cell>
        <Cell label="Payment reference">
          <input value={panel.reference} maxLength={60} className={inputCls} style={inputStyle}
            placeholder="CRDB RTGS 4412" onChange={e => onChange({ reference: e.target.value })} />
        </Cell>
        <Cell label="Date paid">
          <input type="date" value={panel.paidAt} className={inputCls} style={inputStyle}
            onChange={e => onChange({ paidAt: e.target.value })} />
        </Cell>
      </div>
      <p className="mt-12 text-xs" style={{ color: "var(--ink)" }}>
        {amount >= fee ? `Fully settled — ${panel.parcel.tracking_number} shows Paid.`
          : `${fmt(balance)} ${panel.parcel.currency} still owing on this parcel.`}
      </p>
      <div className="mt-16 flex flex-wrap items-center gap-12">
        <button type="button" onClick={onSave} disabled={busy}
          className="waisha-btn rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-50">
          {busy ? "Saving…" : "Record settlement"}
        </button>
        <button type="button" onClick={onCancel} className="on-photo-btn px-16 py-8 text-xs font-semibold">Discard</button>
      </div>
    </section>
  );
}
