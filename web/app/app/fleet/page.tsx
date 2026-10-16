"use client";
import { useCallback, useEffect, useState } from "react";
import { Truck } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { apiFetch } from "../api-client";

interface Vessel {
  id: string; name: string; vessel_type: string; plate_number: string;
  make: string | null; model: string | null; year_manufactured: number | null;
  capacity_tonnes: string | null; fuel_type: string; odometer_km: number;
  status: string; branch_name: string | null; document_status: string;
  imo_number: string | null; home_port: string | null; water_body: string | null;
  gross_weight_kg: string | null; length_m: string | null;
  width_m: string | null; height_m: string | null;
  active_trip_reference: string | null;
}
interface Branch { id: string; name: string; }

const TYPES: Record<string, string> = {
  truck_head: "Truck Head", trailer: "Trailer", tanker: "Tanker",
  flatbed: "Flatbed", tipper: "Tipper", reefer: "Reefer Truck",
  box_truck: "Box Truck", van: "Van", pickup: "Pickup", lowbed: "Low-bed",
  barge: "Barge", boat: "Boat", rail_wagon: "Rail Wagon",
  cargo_ship: "Cargo Ship", ferry: "Ferry", tank_barge: "Tank Barge"
};
const WATER_TYPES = ["barge", "boat", "cargo_ship", "ferry", "tank_barge"];
const STATUS_COLORS: Record<string, string> = {
  on_route: "var(--success)", standby: "var(--brand)", booked: "var(--gold)",
  in_garage: "var(--warning)", out_of_service: "var(--danger)"
};
const STATUS_LABELS: Record<string, string> = {
  on_route: "On route", standby: "Standby", booked: "Booked",
  in_garage: "In garage", out_of_service: "Out of service"
};
const FUELS: Record<string, string> = {
  diesel: "Diesel", petrol: "Petrol", cng: "CNG", lng: "LNG",
  electric: "Electric", hydrogen: "Hydrogen", hybrid: "Hybrid"
};
const WATER_BODIES: Record<string, string> = {
  lake_victoria: "Lake Victoria", lake_tanganyika: "Lake Tanganyika",
  lake_nyasa: "Lake Nyasa", indian_ocean: "Indian Ocean", river: "River"
};

export default function FleetPage() {
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [fleetLimit, setFleetLimit] = useState<number | null>(null);
  const [fleetUsed, setFleetUsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, any>>({
    name: "", vesselType: "truck_head", plateNumber: "", make: "", model: "",
    yearManufactured: "", capacityTonnes: "", fuelType: "diesel",
    grossWeightKg: "", lengthM: "", widthM: "", heightM: "",
    branchId: "", insuranceExpiry: "", inspectionExpiry: "", roadLicenceExpiry: "",
    imoNumber: "", homePort: "", waterBody: ""
  });

  const load = useCallback(async () => {
    const res = await apiFetch("/vessels");
    if (res.ok) {
      const j = await res.json();
      setVessels(j.vessels);
      setFleetLimit(j.fleetLimit);
      setFleetUsed(j.fleetUsed);
    }
    const b = await apiFetch("/branches");
    if (b.ok) setBranches(await b.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  const isWater = WATER_TYPES.includes(form.vesselType);
  const trialBlocked = fleetLimit !== null && fleetUsed >= fleetLimit;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      // Presence-based PUT: an empty field clears the stored value.
      const payload = {
        name: form.name, vesselType: form.vesselType, plateNumber: form.plateNumber,
        make: form.make || null, model: form.model || null,
        yearManufactured: form.yearManufactured ? Number(form.yearManufactured) : null,
        capacityTonnes: form.capacityTonnes ? Number(form.capacityTonnes) : null,
        grossWeightKg: form.grossWeightKg ? Number(form.grossWeightKg) : null,
        lengthM: form.lengthM ? Number(form.lengthM) : null,
        widthM: form.widthM ? Number(form.widthM) : null,
        heightM: form.heightM ? Number(form.heightM) : null,
        fuelType: form.fuelType,
        branchId: form.branchId || null,
        insuranceExpiry: form.insuranceExpiry || null,
        inspectionExpiry: form.inspectionExpiry || null,
        roadLicenceExpiry: form.roadLicenceExpiry || null,
        imoNumber: isWater ? (form.imoNumber || null) : null,
        homePort: isWater ? (form.homePort || null) : null,
        waterBody: isWater ? (form.waterBody || null) : null
      };
      const res = await apiFetch(editingId ? `/vessels/${editingId}` : "/vessels", {
        method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "Failed"); return; }
      setNotice(editingId ? `Vessel "${form.name}" updated.` : `Vessel "${form.name}" registered.`);
      setShowForm(false);
      setEditingId(null);
      setForm(f => ({ ...f, name: "", plateNumber: "", make: "", model: "", yearManufactured: "", capacityTonnes: "" }));
      load();
    } finally { setBusy(false); }
  }

  function startEdit(v: Vessel) {
    setEditingId(v.id);
    setForm(f => ({
      ...f,
      name: v.name ?? "", vesselType: v.vessel_type ?? "truck_head",
      plateNumber: v.plate_number ?? "", make: v.make ?? "", model: v.model ?? "",
      yearManufactured: v.year_manufactured ? String(v.year_manufactured) : "",
      capacityTonnes: v.capacity_tonnes ?? "",
      grossWeightKg: v.gross_weight_kg ?? "", lengthM: v.length_m ?? "",
      widthM: v.width_m ?? "", heightM: v.height_m ?? "",
      insuranceExpiry: (v as any).insurance_expiry ? String((v as any).insurance_expiry).slice(0, 10) : "",
      inspectionExpiry: (v as any).inspection_expiry ? String((v as any).inspection_expiry).slice(0, 10) : "",
      roadLicenceExpiry: (v as any).road_licence_expiry ? String((v as any).road_licence_expiry).slice(0, 10) : "",
      branchId: (v as any).branch_id ?? "",
      imoNumber: v.imo_number ?? "", homePort: v.home_port ?? "", waterBody: v.water_body ?? ""
    }));
    setError(null); setNotice(null); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function changeStatus(v: Vessel, status: string) {
    const reason = status === "in_garage" || status === "out_of_service"
      ? prompt(`Reason for marking ${STATUS_LABELS[status]}:`) ?? undefined : undefined;
    const res = await apiFetch(`/vessels/${v.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, statusReason: reason })
    });
    if (res.ok) load();
    else { const j = await res.json().catch(() => ({})); setError(j?.error?.message ?? "Failed"); }
  }

  async function remove(id: string) {
    await apiFetch(`/vessels/${id}`, { method: "DELETE" });
    load();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Fleet</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Vessels and marine units — road, lake and sea.
          </p>
        </div>
        <button type="button" onClick={() => { setEditingId(null); setShowForm(s => !s); }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ Add vessel"}
        </button>
      </div>

      {fleetLimit !== null && (
        <div role="status" className="mt-16 mb-16 px-16 py-8 text-sm font-semibold"
          style={{ background: "var(--warning)", color: "var(--on-solid)" }}>
          Trial fleet: {fleetUsed} of {fleetLimit} vessels used — Activate a licence for unlimited fleet.
        </div>
      )}
      {trialBlocked && showForm && (
        <div role="alert" className="mb-16 px-16 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 10%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          Trial fleet limit reached ({fleetLimit} vessels). Activate a licence to add more.
        </div>
      )}

      {error && <div role="alert" className="mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {showForm && (
        <form onSubmit={submit} className="mb-32 space-y-12 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Vessel type</span>
              <select value={form.vesselType} onChange={e => setForm(f => ({ ...f, vesselType: e.target.value }))}
                className={inputCls} style={inputStyle}>
                {Object.entries(TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Name / Call sign *</span>
              <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Nyegezi Express" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                {isWater ? "Registration / IMO number *" : "Plate number *"}
              </span>
              <input required value={form.plateNumber} onChange={e => setForm(f => ({ ...f, plateNumber: e.target.value }))}
                placeholder={isWater ? "e.g. MV-2024-001" : "e.g. T 123 ABC"} className={inputCls} style={inputStyle} />
            </label>
            {isWater && (<>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>IMO number</span>
                <input value={form.imoNumber} onChange={e => setForm(f => ({ ...f, imoNumber: e.target.value }))} className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Home port</span>
                <input value={form.homePort} onChange={e => setForm(f => ({ ...f, homePort: e.target.value }))}
                  placeholder="e.g. Mwanza North Port" className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Water body</span>
                <select value={form.waterBody} onChange={e => setForm(f => ({ ...f, waterBody: e.target.value }))} className={inputCls} style={inputStyle}>
                  <option value="">Select</option>
                  {Object.entries(WATER_BODIES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </label>
            </>)}
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Make</span>
              <input value={form.make} onChange={e => setForm(f => ({ ...f, make: e.target.value }))}
                placeholder={isWater ? "e.g. Karimjee shipyard" : "e.g. Isuzu"} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Model</span>
              <input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Year</span>
              <input type="number" min={1950} max={2100} value={form.yearManufactured}
                onChange={e => setForm(f => ({ ...f, yearManufactured: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Capacity (tonnes)</span>
              <input type="number" step="0.01" min={0} value={form.capacityTonnes}
                onChange={e => setForm(f => ({ ...f, capacityTonnes: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Gross weight (kg)</span>
              <input type="number" step="0.01" min={0} value={form.grossWeightKg}
                onChange={e => setForm(f => ({ ...f, grossWeightKg: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Length (m)</span>
              <input type="number" step="0.01" min={0} value={form.lengthM}
                onChange={e => setForm(f => ({ ...f, lengthM: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Width (m)</span>
              <input type="number" step="0.01" min={0} value={form.widthM}
                onChange={e => setForm(f => ({ ...f, widthM: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Height (m)</span>
              <input type="number" step="0.01" min={0} value={form.heightM}
                onChange={e => setForm(f => ({ ...f, heightM: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Fuel</span>
              <select value={form.fuelType} onChange={e => setForm(f => ({ ...f, fuelType: e.target.value }))} className={inputCls} style={inputStyle}>
                {Object.entries(FUELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Home branch</span>
              <select value={form.branchId} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))} className={inputCls} style={inputStyle}>
                <option value="">Select</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Insurance expiry</span>
              <input type="date" value={form.insuranceExpiry} onChange={e => setForm(f => ({ ...f, insuranceExpiry: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Inspection expiry</span>
              <input type="date" value={form.inspectionExpiry} onChange={e => setForm(f => ({ ...f, inspectionExpiry: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Road licence expiry</span>
              <input type="date" value={form.roadLicenceExpiry} onChange={e => setForm(f => ({ ...f, roadLicenceExpiry: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
          </div>
          <button type="submit" disabled={trialBlocked || busy}
            className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
            {busy ? "Saving" : (editingId ? "Save changes" : "Register vessel")}
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Name</th><th className="p-12">Type</th>
              <th className="p-12">Reg/Plate</th><th className="p-12">Capacity</th>
              <th className="p-12">Status</th><th className="p-12">Branch</th>
              <th className="p-12">Docs</th><th></th>
            </tr>
          </thead>
          <tbody>
            {vessels.map((v, i) => (
              <tr key={v.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{v.name}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{TYPES[v.vessel_type] ?? v.vessel_type}</td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{v.plate_number}</td>
                <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {v.capacity_tonnes ? `${Number(v.capacity_tonnes).toLocaleString()} t` : "—"}
                  {(v.length_m || v.width_m || v.height_m) && (
                    <span className="block text-xs">
                      {[v.length_m, v.width_m, v.height_m].filter(Boolean).map(n => Number(n)).join(" × ")} m
                    </span>
                  )}
                  {v.gross_weight_kg && <span className="block text-xs">{Number(v.gross_weight_kg).toLocaleString()} kg GVW</span>}
                </td>
                <td className="p-12">
                  <span className="px-8 py-4 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${STATUS_COLORS[v.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                    {STATUS_LABELS[v.status] ?? v.status}
                  </span>
                  {v.active_trip_reference && (
                    <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      Trip {v.active_trip_reference}
                    </span>
                  )}
                </td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{v.branch_name ?? "—"}</td>
                <td className="p-12">
                  {v.document_status === "expiring" && (
                    <span className="px-8 py-4 text-[10px] font-bold uppercase"
                      style={{ borderLeft: "4px solid var(--warning)", color: "var(--warning)" }}>
                      Expiring
                    </span>
                  )}
                  {v.document_status === "ok" && <span style={{ color: "var(--ink-soft)" }}>OK</span>}
                </td>
                <td className="p-12 text-right whitespace-nowrap">
                  <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                    onClick={() => startEdit(v)}>Edit</button>
                  <select defaultValue="" onChange={e => { if (e.target.value) changeStatus(v, e.target.value); e.target.value = ""; }}
                    className="rounded-input border px-8 py-4 text-xs mr-8"
                    style={{ borderColor: "var(--line)", background: "var(--milk)", color: "var(--ink)" }}>
                    <option value="">Set status…</option>
                    {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                  <button type="button" className="underline" style={{ color: "var(--danger)" }}
                    onClick={() => remove(v.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {vessels.length === 0 && (
              <EmptyState colSpan={8} icon={Truck} title="No vessels yet"
                hint="Register your first truck, trailer or ship — everything you move is tied to a vessel."
                action={{ label: "Add a vessel", onClick: () => { setEditingId(null); setShowForm(true); } }} />
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}