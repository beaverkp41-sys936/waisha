"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Ship, Plane, TrainFront, Truck, Plus, X } from "lucide-react";
import { apiFetch } from "../../api-client";
import {
  CAPACITY_HINT, CAPACITY_LABELS, CAPACITY_UNITS, MODES, MODE_LABELS, MODE_SHORT,
  SPECIALISATIONS, SPECIALISATION_LABELS, SPECIALISATION_NOTE, UNIT_LABELS, UNITS_BY_MODE,
  capacityText, errorText, qty, unitText
} from "./shared";
import type { CapacityUnit, Carrier, Mode, Specialisation, UnitType } from "./shared";

const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const card = "rounded-card border bg-surface p-24";

const MODE_ICONS: Record<Mode, typeof Truck> = {
  road: Truck, marine: Ship, air: Plane, rail: TrainFront
};

interface Draft {
  mode: Mode; unitType: UnitType;
  displayName: string; registration: string; operatorName: string;
  make: string; model: string; yearManufactured: string;
  capacityUnit: CapacityUnit; capacityMax: string;
  homeBase: string; notes: string; isActive: boolean;
  specialisations: Specialisation[];
}

const BLANK: Draft = {
  mode: "road", unitType: "truck_head",
  displayName: "", registration: "", operatorName: "",
  make: "", model: "", yearManufactured: "",
  capacityUnit: "tonnes", capacityMax: "",
  homeBase: "", notes: "", isActive: true,
  specialisations: ["general"]
};

function draftFrom(c: Carrier): Draft {
  return {
    mode: c.mode, unitType: c.unit_type,
    displayName: c.display_name, registration: c.registration ?? "",
    operatorName: c.operator_name ?? "", make: c.make ?? "", model: c.model ?? "",
    yearManufactured: c.year_manufactured === null ? "" : String(c.year_manufactured),
    capacityUnit: c.capacity_unit,
    capacityMax: c.capacity_max === null ? "" : String(Number(c.capacity_max)),
    homeBase: c.home_base ?? "", notes: c.notes ?? "", isActive: c.is_active,
    specialisations: (c.specialisations as Specialisation[]) ?? []
  };
}

/** The register and its entry form — one form for all four modes of carry. */
export default function UnitsPanel({ onError, onNotice }: {
  onError: (m: string | null) => void; onNotice: (m: string | null) => void;
}) {
  const [carriers, setCarriers] = useState<Carrier[]>([]);
  const [mode, setMode] = useState<Mode | "">("");
  const [showParked, setShowParked] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (mode) qs.set("mode", mode);
    if (showParked) qs.set("active", "false");
    const res = await apiFetch(`/consolidation/carriers${qs.toString() ? `?${qs}` : ""}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { onError(errorText(j, "Could not load the carrier register.")); return; }
    setCarriers(j.carriers ?? []);
  }, [mode, showParked, onError]);

  useEffect(() => { load(); }, [load]);

  const units = UNITS_BY_MODE[draft.mode];

  function pickMode(next: Mode) {
    setDraft(d => ({
      ...d, mode: next,
      // The unit list follows the mode, so the old pick is re-filed onto the
      // first unit of the new mode rather than left pointing at nothing.
      unitType: UNITS_BY_MODE[next].includes(d.unitType) ? d.unitType : UNITS_BY_MODE[next][0]
    }));
  }

  function toggleLane(lane: Specialisation) {
    setDraft(d => ({
      ...d,
      specialisations: d.specialisations.includes(lane)
        ? d.specialisations.filter(x => x !== lane) : [...d.specialisations, lane]
    }));
  }

  function startNew() { setDraft(BLANK); setEditingId(null); setFormOpen(true); }
  function startEdit(c: Carrier) { setDraft(draftFrom(c)); setEditingId(c.id); setFormOpen(true); }
  function closeForm() { setFormOpen(false); setEditingId(null); setDraft(BLANK); }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onError(null); onNotice(null);
    if (draft.displayName.trim().length < 2) { onError("Give the unit a name as it should print on the manifest."); return; }
    setBusy(true);
    try {
      const body = {
        mode: draft.mode, unitType: draft.unitType,
        displayName: draft.displayName.trim(),
        registration: draft.registration.trim() || null,
        operatorName: draft.operatorName.trim() || null,
        make: draft.make.trim() || null, model: draft.model.trim() || null,
        yearManufactured: draft.yearManufactured.trim() === ""
          ? null : Math.round(Number(draft.yearManufactured)),
        capacityUnit: draft.capacityUnit,
        capacityMax: draft.capacityMax.trim() === "" ? null : Math.max(0, Number(draft.capacityMax)),
        specialisations: draft.specialisations,
        homeBase: draft.homeBase.trim() || null,
        notes: draft.notes.trim() || null,
        isActive: draft.isActive
      };
      const res = await apiFetch(editingId ? `/consolidation/carriers/${editingId}` : "/consolidation/carriers", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { onError(errorText(j, "Could not save the unit.")); return; }
      onNotice(editingId ? `${body.displayName} updated.` : `${body.displayName} added to the register.`);
      closeForm();
    } finally { setBusy(false); load(); }
  }

  async function setActive(c: Carrier, isActive: boolean) {
    onError(null); onNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/consolidation/carriers/${c.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { onError(errorText(j, "Could not change that unit.")); return; }
      onNotice(isActive ? `${c.display_name} is back on the board.` : `${c.display_name} parked — it cannot be given a new leg.`);
    } finally { setBusy(false); load(); }
  }

  async function remove(c: Carrier) {
    onError(null); onNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/consolidation/carriers/${c.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { onError(errorText(j, "Could not retire that unit.")); return; }
      onNotice(`${c.display_name} retired from the register.`);
    } finally { setBusy(false); load(); }
  }

  const counts = useMemo(() => {
    const by = (m: Mode) => carriers.filter(c => c.mode === m).length;
    return MODES.map(m => ({ mode: m, n: by(m) }));
  }, [carriers]);

  return (
    <div className="mt-24">
      <div className="flex flex-wrap items-center justify-between gap-12">
        <div className="flex flex-wrap items-center gap-8">
          <button type="button" onClick={() => setMode("")}
            className={`on-photo-btn px-12 py-6 text-xs font-semibold${mode === "" ? " is-on" : ""}`}>
            All modes
          </button>
          {counts.map(({ mode: m, n }) => {
            const Icon = MODE_ICONS[m];
            return (
              <button key={m} type="button" onClick={() => setMode(m)}
                className={`on-photo-btn inline-flex items-center gap-6 px-12 py-6 text-xs font-semibold${mode === m ? " is-on" : ""}`}>
                <Icon size={14} strokeWidth={1.8} aria-hidden />{MODE_SHORT[m]}
                <span className="tabular-nums opacity-70">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-12">
          <label className="inline-flex items-center gap-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            <input type="checkbox" checked={showParked} onChange={e => setShowParked(e.target.checked)} />
            Parked units only
          </label>
          <button type="button" onClick={startNew}
            className="waisha-btn inline-flex items-center gap-6 rounded-input px-16 py-8 text-xs font-semibold">
            <Plus size={14} strokeWidth={2} aria-hidden /> Register a unit
          </button>
        </div>
      </div>

      {formOpen && (
        <form onSubmit={save} className={`${card} mt-16`} style={inputStyle}>
          <div className="flex items-start justify-between gap-12">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                {editingId ? "Edit unit" : "New carrier unit"}
              </h2>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                One register for every mode the office consolidates for — the mode decides which units can be filed.
              </p>
            </div>
            <button type="button" onClick={closeForm} aria-label="Close the form"
              className="on-photo-btn inline-flex items-center gap-6 px-12 py-6 text-xs font-semibold">
              <X size={14} strokeWidth={2} aria-hidden /> Close
            </button>
          </div>

          <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {MODES.map(m => {
              const Icon = MODE_ICONS[m];
              const on = draft.mode === m;
              return (
                <button key={m} type="button" onClick={() => pickMode(m)} aria-pressed={on}
                  className={`on-photo-btn inline-flex items-center gap-8 px-12 py-8 text-left text-xs font-semibold${on ? " is-on" : ""}`}>
                  <Icon size={15} strokeWidth={1.8} aria-hidden />
                  <span>{MODE_LABELS[m]}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-16 grid gap-12 md:grid-cols-3">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Unit type *</span>
              <select value={draft.unitType} onChange={e => setDraft(d => ({ ...d, unitType: e.target.value as UnitType }))}
                className={inputCls} style={inputStyle}>
                {units.map(u => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
              </select>
            </label>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Name as it should print *</span>
              <input required value={draft.displayName} maxLength={160}
                onChange={e => setDraft(d => ({ ...d, displayName: e.target.value }))}
                placeholder="MLANGO EXPRESS — 765 T 4471" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Plate / registration</span>
              <input value={draft.registration} maxLength={60}
                onChange={e => setDraft(d => ({ ...d, registration: e.target.value }))}
                placeholder={draft.mode === "road" ? "765 T 4471" : draft.mode === "rail" ? "Wagon 41207" : "IMO 9123445"}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Operator / carrier</span>
              <input value={draft.operatorName} maxLength={160}
                onChange={e => setDraft(d => ({ ...d, operatorName: e.target.value }))}
                placeholder="Who owns and drives the unit" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Make</span>
              <input value={draft.make} maxLength={80}
                onChange={e => setDraft(d => ({ ...d, make: e.target.value }))}
                placeholder={draft.mode === "road" ? "Isuzu" : draft.mode === "air" ? "Boeing" : ""}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Model</span>
              <input value={draft.model} maxLength={80}
                onChange={e => setDraft(d => ({ ...d, model: e.target.value }))}
                placeholder={draft.mode === "road" ? "FRR" : ""} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Year manufactured</span>
              <input type="number" min={1900} max={2100} step={1} value={draft.yearManufactured}
                onChange={e => setDraft(d => ({ ...d, yearManufactured: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Max capacity</span>
              <div className="flex gap-8">
                <input type="number" min={0} step="0.001" value={draft.capacityMax}
                  onChange={e => setDraft(d => ({ ...d, capacityMax: e.target.value }))}
                  placeholder="blank until the plate says" className={`${inputCls} flex-1`} style={inputStyle} />
                <select value={draft.capacityUnit}
                  onChange={e => setDraft(d => ({ ...d, capacityUnit: e.target.value as CapacityUnit }))}
                  className={`${inputCls} w-[120px]`} style={inputStyle} aria-label="Capacity unit">
                  {CAPACITY_UNITS.map(u => <option key={u} value={u}>{CAPACITY_LABELS[u]}</option>)}
                </select>
              </div>
              <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                {CAPACITY_HINT[draft.capacityUnit]}
              </span>
            </label>
            <label className="block md:col-span-3">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Home base / berth</span>
              <input value={draft.homeBase} maxLength={160}
                onChange={e => setDraft(d => ({ ...d, homeBase: e.target.value }))}
                placeholder="Berth 4, T1 Container Terminal" className={inputCls} style={inputStyle} />
            </label>
          </div>

          <div className="mt-16">
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Cargo it is listed for</p>
            <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
              {SPECIALISATIONS.map(lane => {
                const on = draft.specialisations.includes(lane);
                return (
                  <label key={lane} className="flex cursor-pointer items-start gap-8 rounded-input border p-8"
                    style={{ ...inputStyle, borderColor: on ? "var(--brand)" : "var(--line)" }}>
                    <input type="checkbox" checked={on} className="mt-4" onChange={() => toggleLane(lane)} />
                    <span>
                      <span className="block text-xs font-semibold" style={{ color: "var(--ink)" }}>
                        {SPECIALISATION_LABELS[lane]}
                      </span>
                      <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        {SPECIALISATION_NOTE[lane]}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
              General cargo rides any unit. A lane not ticked here cannot be given a parcel on a leg that uses this unit.
            </p>
          </div>

          <label className="block">
            <span className={`${labelCls} mt-16`}>
              <input type="checkbox" checked={draft.isActive} className="mr-8"
                onChange={e => setDraft(d => ({ ...d, isActive: e.target.checked }))} />
              <span style={{ color: "var(--ink-soft)" }}>Available for new legs</span>
            </span>
          </label>

          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Office notes (not printed)</span>
            <textarea value={draft.notes} maxLength={600} rows={2}
              onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>

          <div className="mt-16 flex flex-wrap items-center gap-12">
            <button type="submit" disabled={busy}
              className="waisha-btn rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-50">
              {busy ? "Saving…" : editingId ? "Save unit" : "Register unit"}
            </button>
            <button type="button" onClick={closeForm} className="on-photo-btn px-16 py-8 text-xs font-semibold">
              Discard
            </button>
            <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
              {unitText({ mode: draft.mode, unit_type: draft.unitType })}
              {" · "}
              {capacityText({ capacity_unit: draft.capacityUnit, capacity_max: draft.capacityMax || null })}
            </span>
          </div>
        </form>
      )}

      <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={inputStyle}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Unit</th><th className="p-12">Operator</th>
              <th className="p-12">Build</th><th className="p-12 text-right">Max capacity</th>
              <th className="p-12">Lanes</th><th className="p-12 text-right">Legs booked</th><th></th>
            </tr>
          </thead>
          <tbody>
            {carriers.map((c, i) => (
              <tr key={c.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12">
                  <span className="block font-semibold" style={{ color: "var(--ink)" }}>{c.display_name}</span>
                  <span className="block text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                    {unitText(c)}{c.registration ? ` · ${c.registration}` : ""}{c.is_active ? "" : " · parked"}
                  </span>
                </td>
                <td className="p-12" style={{ color: "var(--ink)" }}>
                  {c.operator_name ?? "—"}
                  {c.home_base && (
                    <span className="block text-[11px]" style={{ color: "var(--ink-soft)" }}>{c.home_base}</span>
                  )}
                </td>
                <td className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {c.make || c.model ? `${c.make ?? ""} ${c.model ?? ""}`.trim() : "—"}
                  {c.year_manufactured ? <span className="block">{c.year_manufactured}</span> : null}
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink)" }}>
                  {c.capacity_max === null ? "—"
                    : `${qty(Number(c.capacity_max))} ${CAPACITY_LABELS[c.capacity_unit]}`}
                </td>
                <td className="p-12">
                  <span className="flex flex-wrap gap-4">
                    {c.specialisations.length
                      ? c.specialisations.map(s => (
                        <span key={s} className="badge-plain px-8 py-2 text-[10px] font-semibold uppercase"
                          style={{ color: "var(--ink)" }}>
                          {SPECIALISATION_LABELS[s as Specialisation] ?? s}
                        </span>
                      ))
                      : <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>General only</span>}
                  </span>
                </td>
                <td className="p-12 text-right tabular-nums" style={{ color: c.live_manifests ? "var(--ink)" : "var(--ink-soft)" }}>
                  {c.live_manifests ?? 0}
                </td>
                <td className="p-12 whitespace-nowrap text-right">
                  <button type="button" className="mr-12 underline" style={{ color: "var(--brand)" }}
                    disabled={busy} onClick={() => startEdit(c)}>Edit</button>
                  <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                    disabled={busy} onClick={() => setActive(c, !c.is_active)}>
                    {c.is_active ? "Park" : "Release"}
                  </button>
                  {!c.is_active && !c.live_manifests && (
                    <button type="button" className="underline" style={{ color: "var(--danger)" }}
                      disabled={busy} onClick={() => remove(c)}>Retire</button>
                  )}
                </td>
              </tr>
            ))}
            {!carriers.length && (
              <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                {showParked ? "No parked units." : "No units registered for this mode yet — register one to open a leg on it."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
