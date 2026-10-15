"use client";
import { useCallback, useEffect, useState } from "react";
import { ContactRound } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { apiFetch } from "../api-client";

interface Driver {
  id: string; full_name: string; licence_class: string | null;
  licence_number: string | null; licence_expiry: string | null;
  status: string; blood_group: string | null; vessel_name: string | null;
  branch_name: string | null; branch_id: string | null; licence_status: string;
  assigned_vessel_id: string | null; address: string | null;
  next_of_kin: string | null; notes: string | null;
  defensive_driving_cert: boolean | null; dangerous_goods_cert: boolean | null;
  active_trip_reference: string | null;
}
interface Vessel { id: string; name: string; }
interface Branch { id: string; name: string; }

const STATUS_COLORS: Record<string, string> = {
  available: "var(--success)", on_trip: "var(--brand)",
  on_leave: "var(--gold)", suspended: "var(--danger)"
};
const STATUS_LABELS: Record<string, string> = {
  available: "Available", on_trip: "On trip", on_leave: "On leave", suspended: "Suspended"
};

interface DriverForm {
  fullName: string; nida: string; phone: string; licenceClass: string;
  licenceNumber: string; licenceExpiry: string; bloodGroup: string;
  assignedVesselId: string; branchId: string; status: string;
  address: string; nextOfKin: string; nextOfKinPhone: string;
  defensiveDrivingCert: boolean; dangerousGoodsCert: boolean; notes: string;
}

const EMPTY: DriverForm = {
  fullName: "", nida: "", phone: "", licenceClass: "", licenceNumber: "",
  licenceExpiry: "", bloodGroup: "", assignedVesselId: "", branchId: "",
  status: "available", address: "", nextOfKin: "", nextOfKinPhone: "",
  defensiveDrivingCert: false, dangerousGoodsCert: false, notes: ""
};

export default function DriversPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DriverForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch("/drivers");
    if (res.ok) setDrivers(await res.json());
    const v = await apiFetch("/vessels");
    if (v.ok) { const j = await v.json(); setVessels(j.vessels ?? j); }
    const b = await apiFetch("/branches");
    if (b.ok) setBranches(await b.json());
  }, []);

  useEffect(() => { load(); }, [load]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    const editing = editingId !== null;
    try {
      // On edit, blank NIDA/phone are sent as undefined so the backend keeps the
      // stored (encrypted) values — they are never returned by the API.
      const res = await apiFetch(editing ? `/drivers/${editingId}` : "/drivers", {
        method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: form.fullName,
          // blank keeps the stored (encrypted) values — the API never returns them
          nida: form.nida || undefined,
          phone: form.phone || undefined,
          nextOfKinPhone: form.nextOfKinPhone || undefined,
          // blank clears the stored value
          licenceClass: form.licenceClass || null,
          licenceNumber: form.licenceNumber || null,
          licenceExpiry: form.licenceExpiry || null,
          bloodGroup: form.bloodGroup || null,
          address: form.address || null,
          nextOfKin: form.nextOfKin || null,
          notes: form.notes || null,
          assignedVesselId: form.assignedVesselId || null,
          branchId: form.branchId || null,
          status: form.status || undefined,
          defensiveDrivingCert: form.defensiveDrivingCert,
          dangerousGoodsCert: form.dangerousGoodsCert
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "Failed"); return; }
      setNotice(editing ? `Driver "${form.fullName}" updated.` : `Driver "${form.fullName}" registered.`);
      setForm(EMPTY); setEditingId(null); setShowForm(false);
      load();
    } finally { setBusy(false); }
  }

  function startEdit(d: Driver) {
    setEditingId(d.id);
    setForm({
      fullName: d.full_name ?? "", nida: "", phone: "",
      licenceClass: d.licence_class ?? "", licenceNumber: d.licence_number ?? "",
      licenceExpiry: d.licence_expiry ? d.licence_expiry.slice(0, 10) : "",
      bloodGroup: d.blood_group ?? "",
      assignedVesselId: d.assigned_vessel_id ?? "",
      branchId: d.branch_id ?? "", status: d.status ?? "available",
      address: d.address ?? "", nextOfKin: d.next_of_kin ?? "", nextOfKinPhone: "",
      defensiveDrivingCert: !!d.defensive_driving_cert,
      dangerousGoodsCert: !!d.dangerous_goods_cert,
      notes: d.notes ?? ""
    });
    setError(null); setNotice(null); setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(id: string) {
    await apiFetch(`/drivers/${id}`, { method: "DELETE" });
    load();
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Drivers</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Licences, certifications and vessel assignments.
          </p>
        </div>
        <button type="button" onClick={() => { setForm(EMPTY); setEditingId(null); setShowForm(s => !s); }}
          className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {showForm ? "Close form" : "+ Add driver"}
        </button>
      </div>
      {error && <div role="alert" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {showForm && (
        <form onSubmit={submit} className="mb-32 space-y-12 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Full name *</span>
              <input required value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                NIDA (20 digits){editingId ? " — blank keeps current" : ""}
              </span>
              <input inputMode="numeric" maxLength={20} value={form.nida}
                onChange={e => setForm(f => ({ ...f, nida: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Phone {editingId ? "— blank keeps current" : "*"}
              </span>
              <input required={editingId === null} value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="+255712345678" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Blood group</span>
              <select value={form.bloodGroup} onChange={e => setForm(f => ({ ...f, bloodGroup: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">Select</option>
                {["A+","A-","B+","B-","AB+","AB-","O+","O-"].map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Licence class</span>
              <input value={form.licenceClass} onChange={e => setForm(f => ({ ...f, licenceClass: e.target.value }))}
                placeholder="e.g. Class C (Heavy)" className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Licence number</span>
              <input value={form.licenceNumber} onChange={e => setForm(f => ({ ...f, licenceNumber: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Licence expiry</span>
              <input type="date" value={form.licenceExpiry} onChange={e => setForm(f => ({ ...f, licenceExpiry: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Assigned vessel</span>
              <select value={form.assignedVesselId} onChange={e => setForm(f => ({ ...f, assignedVesselId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">Unassigned</option>
                {vessels.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Home branch</span>
              <select value={form.branchId} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">Select</option>
                {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Status</span>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                className={inputCls} style={inputStyle}>
                {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Address</span>
              <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Next of kin</span>
              <input value={form.nextOfKin} onChange={e => setForm(f => ({ ...f, nextOfKin: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Next of kin phone</span>
              <input value={form.nextOfKinPhone} onChange={e => setForm(f => ({ ...f, nextOfKinPhone: e.target.value }))}
                placeholder="+255..." className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
              <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className={inputCls} style={inputStyle} />
            </label>
          </div>
          <div className="flex gap-24 text-xs" style={{ color: "var(--ink-soft)" }}>
            <label className="flex items-center gap-8">
              <input type="checkbox" checked={form.defensiveDrivingCert}
                onChange={e => setForm(f => ({ ...f, defensiveDrivingCert: e.target.checked }))} />
              Defensive driving certified
            </label>
            <label className="flex items-center gap-8">
              <input type="checkbox" checked={form.dangerousGoodsCert}
                onChange={e => setForm(f => ({ ...f, dangerousGoodsCert: e.target.checked }))} />
              Dangerous goods certified
            </label>
          </div>
          <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
            {busy ? (editingId ? "Saving…" : "Registering…") : (editingId ? "Save changes" : "Register driver")}
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
              <th className="p-12">Driver</th><th className="p-12">Licence</th>
              <th className="p-12">Expiry</th><th className="p-12">Vessel</th>
              <th className="p-12">Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((d, i) => (
              <tr key={d.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{d.full_name}</td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{d.licence_class ?? "—"}</td>
                <td className="p-12 tabular-nums" style={{
                  color: d.licence_status === "expiring" ? "var(--warning)" :
                         d.licence_status === "expired" ? "var(--danger)" : "var(--ink-soft)"
                }}>
                  {d.licence_expiry ? new Date(d.licence_expiry).toLocaleDateString() : "—"}
                  {d.licence_status !== "ok" && " ⚠"}
                </td>
                <td className="p-12" style={{ color: "var(--ink-soft)" }}>{vessels.find(v => v.id === d.assigned_vessel_id)?.name ?? "—"}</td>
                <td className="p-12">
                  <span className="px-8 py-4 text-[10px] font-bold uppercase"
                    style={{ borderLeft: `4px solid ${STATUS_COLORS[d.status] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                    {STATUS_LABELS[d.status] ?? d.status}
                  </span>
                  {d.active_trip_reference && (
                    <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      Trip {d.active_trip_reference}
                    </span>
                  )}
                </td>
                <td className="p-12 text-right whitespace-nowrap">
                  <button type="button" className="mr-12 underline" style={{ color: "var(--ink-soft)" }}
                    onClick={() => startEdit(d)}>Edit</button>
                  <button type="button" className="underline" style={{ color: "var(--danger)" }}
                    onClick={() => remove(d.id)}>Remove</button>
                </td>
              </tr>
            ))}
            {drivers.length === 0 && (
              <EmptyState colSpan={6} icon={ContactRound} title="No drivers yet"
                hint="Add the people behind the wheel so every trip carries a named, licensed crew."
                action={{ label: "Add a driver", onClick: () => { setForm(EMPTY); setEditingId(null); setShowForm(true); } }} />
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
