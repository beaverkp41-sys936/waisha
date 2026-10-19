"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ContactRound } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { apiFetch, seatPermissions } from "../api-client";

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

/** One driver as the pay module reads them: the agreement, and what it has earned. */
interface PayRow {
  driver_id: string; driver_name: string; driver_status: string; licence_class: string | null;
  terms_id: string | null; basis: string | null; rate: string | null;
  currency: string | null; note: string | null;
  employee_id: string | null; employee_name: string | null; employee_job: string | null;
  employee_status: string | null; terms_updated_at: string | null;
  unpaid_count: number; unpaid_total: string; unlinked_count: number;
  entry_count: number; earned_total: string; unpriced_trips: number;
}
interface RosterSeat {
  id: string; full_name: string; job_title: string | null;
  department: string | null; monthly_salary: string;
}
interface PayTotals {
  unpaid_count: number; unpaid_total: string; unlinked_count: number;
  unlinked_total: string; claimed_count: number; claimed_total: string;
}
interface PayGap { reason: string; trips: number; km: number; }
interface TermsDraft {
  driverId: string; driverName: string; basis: string; rate: string;
  employeeId: string; note: string;
}

/** Why a completed leg has no row in the register — each one is something the desk can fix. */
const GAP_LABELS: Record<string, string> = {
  no_driver: "ran, but no driver is named on the trip",
  no_terms: "the driver has no pay terms yet",
  salary_only: "the driver's terms say salary only, so the leg earns nothing extra",
  no_roster_seat: "priced, but nobody on the payroll roster is paid through that driver",
  missing_entry: "terms were set after the leg — re-price to write these"
};
const money = (v: string | null | undefined) =>
  v == null ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const errorText = (json: any, fallback: string) => {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
};

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

  // Pay terms are a finance duty, not a fleet duty: the desk below appears only for a seat
  // that actually holds the key, and an empty set never means "allow it anyway".
  const [can, setCan] = useState<Set<string>>(new Set());
  const [pay, setPay] = useState<PayRow[] | null>(null);
  const [payTotals, setPayTotals] = useState<PayTotals | null>(null);
  const [payGaps, setPayGaps] = useState<PayGap[]>([]);
  const [basisLabels, setBasisLabels] = useState<Record<string, string>>({});
  const [seats, setSeats] = useState<RosterSeat[]>([]);
  const [draft, setDraft] = useState<TermsDraft | null>(null);
  const [arm, setArm] = useState<string | null>(null);

  const loadPay = useCallback(async (keys: Set<string>) => {
    if (!keys.has("driver_pay.view")) return;
    const t = await apiFetch("/driver-pay/terms");
    const tj = await t.json().catch(() => null);
    if (t.ok) {
      setPay(tj?.drivers ?? []);
      setBasisLabels(tj?.basisLabels ?? {});
      setSeats(tj?.employees ?? []);
    }
    // The totals and the gaps are company-wide whatever window is asked for, and only the
    // entry list obeys `limit` — so one entry is the cheapest honest way to read them.
    const r = await apiFetch("/driver-pay/register?limit=1");
    const rj = await r.json().catch(() => null);
    if (r.ok) { setPayTotals(rj?.totals ?? null); setPayGaps(rj?.gaps ?? []); }
  }, []);

  useEffect(() => {
    (async () => {
      const keys = await seatPermissions();
      setCan(keys);
      loadPay(keys);
    })();
  }, [loadPay]);

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

  function openTerms(d: PayRow) {
    setDraft({
      driverId: d.driver_id, driverName: d.driver_name,
      basis: d.basis ?? "per_trip", rate: d.rate ?? "",
      employeeId: d.employee_id ?? "", note: d.note ?? ""
    });
    setError(null); setNotice(null);
    requestAnimationFrame(() => {
      document.getElementById("pay-terms-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  /**
   * The agreement is written, then the database decides what it is worth: existing unclaimed
   * legs are only re-priced when the desk presses the button, so a rate typed today cannot
   * silently rewrite what last month's legs earned.
   */
  async function saveTerms() {
    if (!draft) return;
    const rate = Number(draft.rate || "0");
    if (draft.basis !== "salary_only" && !(rate > 0)) {
      setError("Every basis except “salary only” needs a rate above zero."); return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await apiFetch(`/driver-pay/terms/${draft.driverId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          basis: draft.basis,
          rate: draft.basis === "salary_only" ? null : rate,
          employeeId: draft.employeeId || null,
          note: draft.note.trim() || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not set those terms.")); return; }
      setNotice(`${j.driver_name}: ${basisLabels[draft.basis] ?? draft.basis} at ${draft.basis === "salary_only" ? "no extra rate" : `${money(j.rate)} each`}` +
        `${j.employee_name ? `, paid into ${j.employee_name}` : ", not paid through a roster seat yet"}` +
        `${j.entries_relinked ? ` — ${j.entries_relinked} earlier leg${j.entries_relinked === 1 ? "" : "s"} now reach a payslip line` : ""}.`);
      setDraft(null);
      await loadPay(can);
    } finally { setBusy(false); }
  }

  /** Ask the database to price the legs it never got to. Idempotent — a priced leg stays priced. */
  async function reprice(driverId?: string) {
    const key = driverId ?? "all";
    if (arm !== key) {
      setArm(key);
      setTimeout(() => setArm(a => (a === key ? null : a)), 6000);
      return;
    }
    setArm(null); setBusy(true); setError(null); setNotice(null);
    try {
      const res = await apiFetch("/driver-pay/accrue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(driverId ? { driverId } : {})
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not re-price the register.")); return; }
      const t = (j.tallies ?? {}) as Record<string, number>;
      const parts = [
        t.accrued ? `${t.accrued} priced` : "",
        t.repriced ? `${t.repriced} re-priced` : "",
        t.claimed ? `${t.claimed} already paid in a run, left alone` : "",
        t.skipped_no_terms ? `${t.skipped_no_terms} with no terms` : "",
        t.skipped_no_driver ? `${t.skipped_no_driver} with no driver named` : "",
        t.skipped_salary_only ? `${t.skipped_salary_only} on salary-only terms` : ""
      ].filter(Boolean);
      setNotice(`Looked at ${j.trips} completed trip${j.trips === 1 ? "" : "s"}: ${parts.length ? parts.join(", ") : "nothing to price"}.`);
      await loadPay(can);
    } finally { setBusy(false); }
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
      {can.has("driver_pay.view") && (
        <section className="mt-40">
          <div className="flex flex-wrap items-end justify-between gap-16">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                Driver pay
              </h2>
              <p className="mt-8 max-w-[620px] text-xs" style={{ color: "var(--ink-soft)" }}>
                What a leg earns is agreed here. The database works the sum out the moment a trip is marked completed —
                never by hand — and the payroll line for that month pays it through the roster seat named below.
              </p>
            </div>
            {can.has("driver_pay.edit") && (
              <button type="button" disabled={busy} onClick={() => reprice()}
                className="rounded-input border px-16 py-8 text-xs font-bold"
                style={{
                  borderColor: arm === "all" ? "var(--danger)" : "var(--line)",
                  color: arm === "all" ? "var(--danger)" : "var(--ink)"
                }}>
                {arm === "all" ? "Tap again to price the missed legs" : "Price the legs that were missed"}
              </button>
            )}
          </div>

          {payTotals && (
            <div className="mt-20 grid grid-cols-1 gap-16 sm:grid-cols-3">
              <div className="rounded-card border bg-surface p-16" style={{ borderColor: "var(--line)" }}>
                <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Owed, not yet paid</p>
                <p className="text-lg font-bold tabular-nums">{money(payTotals.unpaid_total)}</p>
                <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {payTotals.unpaid_count} leg{payTotals.unpaid_count === 1 ? "" : "s"} waiting for a payroll run
                </p>
              </div>
              <div className="rounded-card border bg-surface p-16" style={{ borderColor: "var(--line)" }}>
                <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Paid through a run</p>
                <p className="text-lg font-bold tabular-nums" style={{ color: "var(--success)" }}>
                  {money(payTotals.claimed_total)}
                </p>
                <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {payTotals.claimed_count} leg{payTotals.claimed_count === 1 ? "" : "s"} claimed by an issued month —
                  those figures are frozen
                </p>
              </div>
              <div className="rounded-card border bg-surface p-16" style={{ borderColor: "var(--line)" }}>
                <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Earned, but unpayable</p>
                <p className="text-lg font-bold tabular-nums"
                  style={{ color: payTotals.unlinked_count ? "var(--danger)" : "var(--ink-soft)" }}>
                  {money(payTotals.unlinked_total)}
                </p>
                <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {payTotals.unlinked_count} leg{payTotals.unlinked_count === 1 ? "" : "s"} whose driver has no roster seat.
                  A driver is paid through a person on{" "}
                  <Link href="/app/office/employees" className="underline">Employees</Link>.
                </p>
              </div>
            </div>
          )}

          {!!payGaps.length && (
            <div className="mt-16 rounded-card border bg-surface p-16" style={{ borderColor: "var(--line)" }}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Completed legs with nothing in the register
              </p>
              <ul className="space-y-4 text-[11px]">
                {payGaps.map(g => (
                  <li key={g.reason} className="flex flex-wrap items-baseline gap-8">
                    <span className="font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                      {g.trips} trip{g.trips === 1 ? "" : "s"}
                    </span>
                    <span style={{ color: "var(--ink-soft)" }}>{GAP_LABELS[g.reason] ?? g.reason}</span>
                    {!!g.km && <span className="tabular-nums" style={{ color: "var(--ink-soft)" }}>· {g.km} km</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {draft && (
            <div id="pay-terms-panel" className="mt-20 rounded-card border bg-surface p-24"
              style={{ borderColor: "var(--line)", borderLeft: "4px solid var(--gold)" }}>
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                Setting terms for <strong style={{ color: "var(--ink)" }}>{draft.driverName}</strong>. Legs already claimed
                by an issued month keep the figure they were paid with; unclaimed ones pick up the new seat below.
              </p>
              <div className="mt-16 grid grid-cols-1 gap-12 md:grid-cols-2">
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>What the trip earns</span>
                  <select value={draft.basis}
                    onChange={e => setDraft(d => d ? { ...d, basis: e.target.value } : d)}
                    className={inputCls} style={inputStyle}>
                    {Object.entries(basisLabels).map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                    {!Object.keys(basisLabels).length && <option value={draft.basis}>{draft.basis}</option>}
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                    {draft.basis === "salary_only" ? "Rate — none, on purpose"
                      : draft.basis === "percent_of_freight" ? "Percent of the freight charged"
                        : "Rate (TZS)"}
                  </span>
                  <input type="number" step="0.0001" min="0" disabled={draft.basis === "salary_only"}
                    value={draft.basis === "salary_only" ? "" : draft.rate}
                    onChange={e => setDraft(d => d ? { ...d, rate: e.target.value } : d)}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Paid into the payroll as</span>
                  <select value={draft.employeeId}
                    onChange={e => setDraft(d => d ? { ...d, employeeId: e.target.value } : d)}
                    className={inputCls} style={inputStyle}>
                    <option value="">— nobody yet: their legs cannot be paid —</option>
                    {seats.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.full_name}{s.job_title ? ` · ${s.job_title}` : ""}
                      </option>
                    ))}
                  </select>
                  {!draft.employeeId && (
                    <p className="mt-4 text-[10px]" style={{ color: "var(--danger)" }}>
                      Without a seat, every leg this driver drives stays in the register unpaid.
                    </p>
                  )}
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note on the agreement</span>
                  <input maxLength={500} value={draft.note}
                    onChange={e => setDraft(d => d ? { ...d, note: e.target.value } : d)}
                    placeholder="Night allowance paid flat, per the 2026 agreement"
                    className={inputCls} style={inputStyle} />
                </label>
              </div>
              <div className="mt-16 flex flex-wrap gap-12">
                <button type="button" disabled={busy} onClick={saveTerms}
                  className="waisha-btn rounded-input px-20 py-8 text-xs font-semibold">
                  {busy ? "Saving…" : "Save these terms"}
                </button>
                <button type="button" disabled={busy} onClick={() => setDraft(null)}
                  className="rounded-input border px-16 py-8 text-xs" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  Leave them as they are
                </button>
              </div>
            </div>
          )}

          <div className="mt-20 overflow-x-auto rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className="p-12">Driver</th><th className="p-12">A trip earns</th>
                  <th className="p-12">Rate</th><th className="p-12">Paid into</th>
                  <th className="p-12">Waiting</th><th className="p-12">Unpriced legs</th><th className="p-12" />
                </tr>
              </thead>
              <tbody>
                {(pay ?? []).map(d => (
                  <tr key={d.driver_id} className="border-t align-top" style={{ borderColor: "var(--line)" }}>
                    <td className="p-12">
                      <p className="font-semibold" style={{ color: "var(--ink)" }}>{d.driver_name}</p>
                      <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        {STATUS_LABELS[d.driver_status] ?? d.driver_status}
                        {d.licence_class ? ` · ${d.licence_class}` : ""}
                      </p>
                    </td>
                    <td className="p-12 text-xs" style={{ color: d.basis ? "var(--ink)" : "var(--danger)" }}>
                      {d.basis ? basisLabels[d.basis] ?? d.basis : "not set"}
                      {d.note && <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{d.note}</p>}
                    </td>
                    <td className="p-12 text-right text-xs tabular-nums">
                      {d.basis && d.basis !== "salary_only"
                        ? `${money(d.rate)}${d.basis === "percent_of_freight" ? "%" : ""}`
                        : "—"}
                      {d.currency && d.basis && d.basis !== "salary_only" && (
                        <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{d.currency}</p>
                      )}
                    </td>
                    <td className="p-12 text-xs">
                      {d.employee_name
                        ? <>
                          {d.employee_name}
                          <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {[d.employee_job, d.employee_status].filter(Boolean).join(" · ")}
                          </p>
                        </>
                        : <span style={{ color: "var(--danger)" }}>— no seat —</span>}
                    </td>
                    <td className="p-12 text-right text-xs tabular-nums">
                      {d.unpaid_count ? (
                        <>
                          <p style={{ color: "var(--warning)" }}>{money(d.unpaid_total)}</p>
                          <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {d.unpaid_count} leg{d.unpaid_count === 1 ? "" : "s"}
                            {d.unlinked_count ? ` · ${d.unlinked_count} unpayable` : ""}
                          </p>
                        </>
                      ) : <span style={{ color: "var(--ink-soft)" }}>—</span>}
                      {d.entry_count > 0 && (
                        <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          {money(d.earned_total)} earned all told
                        </p>
                      )}
                    </td>
                    <td className="p-12 text-right text-xs tabular-nums"
                      style={{ color: d.unpriced_trips ? "var(--danger)" : "var(--ink-soft)" }}>
                      {d.unpriced_trips || "—"}
                    </td>
                    <td className="p-12 text-right whitespace-nowrap">
                      {can.has("driver_pay.edit") && (
                        <>
                          <button type="button" disabled={busy} onClick={() => openTerms(d)}
                            className="mr-8 underline text-[11px]" style={{ color: "var(--ink-soft)" }}>
                            {d.terms_id ? "Change terms" : "Set terms"}
                          </button>
                          {!!d.unpriced_trips && (
                            <button type="button" disabled={busy} onClick={() => reprice(d.driver_id)}
                              className="px-10 py-4 text-[11px]"
                              style={{
                                color: arm === d.driver_id ? "var(--danger)" : "var(--ink-soft)",
                                border: "1px solid currentColor", borderRadius: 8
                              }}>
                              {arm === d.driver_id ? "Tap again" : "Price their legs"}
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {pay?.length === 0 && (
                  <tr><td colSpan={7} className="p-24 text-center text-xs" style={{ color: "var(--ink-soft)" }}>
                    No drivers are registered yet.
                  </td></tr>
                )}
                {!pay && (
                  <tr><td colSpan={7} className="p-24 text-center text-xs" style={{ color: "var(--ink-soft)" }}>
                    Reading the pay register…
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
            What a driver has actually earned, leg by leg, is paid on{" "}
            <Link href="/app/office/payroll" className="underline">Payroll</Link> — the trip-pay column there is this
            register read through the roster seat, not a second copy of the sum.
          </p>
        </section>
      )}
    </div>
  );
}
