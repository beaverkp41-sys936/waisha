"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Cost {
  id: string; cost_date: string; category: string; description: string;
  amount: number; payee: string | null; payment_method: string; receipt_no: string | null;
  status: string; review_note: string | null; notes: string | null; created_at: string;
  employee_id: string | null; employee_name: string | null;
  shipment_id: string | null; file_number: string | null;
  approved_by: string | null; approved_by_name: string | null; approved_at: string | null;
  document_count: number; latest_document_id: string | null;
}
interface CategoryRow {
  category: string; budget: number; spent: number; pending: number;
  pendingCount: number; approvedCount: number; remaining: number;
}
interface Summary {
  month: string;
  categories: CategoryRow[];
  totals: {
    budget: number; spent: number; pending: number;
    pendingCount: number; approvedCount: number; remaining: number;
  };
  months: { month: string; value: number; count: number }[];
}
interface FileCost {
  id: string; file_number: string; shipment_type: string; stage: string; status: string;
  consignee_name: string; payment_status: string;
  payment_amount: number | null; processing_cost: number | null;
  allocated: number; pending_amount: number; entries: number; margin: number | null;
}
interface FileCosts { totals: { files: number; allocated: number; pending: number }; rows: FileCost[] }
interface Budget { id: string; period: string; category: string; amount: number; notes: string | null; created_at: string }
interface EmployeeOption { id: string; full_name: string; status: string }
interface FileOption { id: string; file_number: string; status: string }

const CATEGORY_LABELS: Record<string, string> = {
  allowance: "Allowances", meals: "Meals & refreshments", utilities: "Utilities",
  rent: "Rent", transport: "Transport", supplies: "Supplies",
  communication: "Communication", other: "Other"
};
const CATEGORIES = Object.keys(CATEGORY_LABELS);
const STATUS_LABELS: Record<string, string> = { pending: "Pending", approved: "Approved", rejected: "Rejected" };
const STATUS_COLORS: Record<string, string> = {
  pending: "var(--warning)", approved: "var(--success)", rejected: "var(--danger)"
};
const METHOD_LABELS: Record<string, string> = {
  cash: "Cash", mobile_money: "Mobile money", bank: "Bank", cheque: "Cheque"
};
const STAGE_LABELS: Record<string, string> = {
  pre_arrival: "Pre-arrival", arrival: "Arrival", customs: "Customs",
  inspection: "Inspection", release: "Release", exit: "Exit"
};
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "daily", label: "Daily Costs" },
  { key: "allowances", label: "Allowances" },
  { key: "meals", label: "Meals & Refreshments" },
  { key: "filecosts", label: "File Costs" },
  { key: "budgets", label: "Budgets" }
] as const;
type View = typeof TABS[number]["key"];

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const localMonth = () => localToday().slice(0, 7);
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : "—");
const fmtPeriod = (v: string | null) => {
  if (!v) return "—";
  const [y, m] = v.split("-").map(Number);
  return `${MONTH_NAMES[(m ?? 1) - 1] ?? m} ${y}`;
};
const monthShort = (v: string) => {
  const [y, m] = v.split("-").map(Number);
  return `${(MONTH_NAMES[(m ?? 1) - 1] ?? m).slice(0, 3)} ${y}`;
};
const fmtMoney = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString());

interface CostForm {
  costDate: string; category: string; description: string; amount: string;
  payee: string; employeeId: string; shipmentId: string; paymentMethod: string;
  receiptNo: string; notes: string;
}
const EMPTY_COST = (): CostForm => ({
  costDate: localToday(), category: "other", description: "", amount: "",
  payee: "", employeeId: "", shipmentId: "", paymentMethod: "cash",
  receiptNo: "", notes: ""
});

export default function OfficeCostsPage() {
  const [view, setView] = useState<View>("overview");
  const [month, setMonth] = useState(localMonth());
  const [costs, setCosts] = useState<Cost[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [fileCosts, setFileCosts] = useState<FileCosts | null>(null);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [files, setFiles] = useState<FileOption[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState<CostForm>(() => EMPTY_COST());
  const [editing, setEditing] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");
  const [deciding, setDeciding] = useState<Cost | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [budgetEdits, setBudgetEdits] = useState<Record<string, string>>({});

  const attachInput = useRef<HTMLInputElement | null>(null);
  const attachTargetRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const [c, s, f, b, e, g] = await Promise.all([
      apiFetch(`/office-costs?month=${month}`),
      apiFetch(`/office-costs/summary?month=${month}`),
      apiFetch("/office-costs/file-costs"),
      apiFetch(`/office-budgets?period=${month}`),
      apiFetch("/employees"),
      apiFetch("/cargo")
    ]);
    if (c.ok) setCosts(await c.json());
    if (s.ok) setSummary(await s.json());
    if (f.ok) setFileCosts(await f.json());
    if (b.ok) setBudgets(await b.json());
    if (e.ok) setEmployees(await e.json());
    if (g.ok) setFiles((await g.json()).filter((x: FileOption) => x.status === "open"));
    if (!c.ok && !s.ok) setError(errorText(null, "Could not load office costs."));
    setReady(true);
  }, [month]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if ((view === "allowances" || view === "meals") && !editing) {
      setForm(f => ({ ...f, category: view === "allowances" ? "allowance" : "meals" }));
    }
  }, [view, editing]);

  // ---------- Register ----------

  function startEdit(c: Cost) {
    setEditing(c.id);
    setForm({
      costDate: c.cost_date, category: c.category, description: c.description,
      amount: String(c.amount), payee: c.payee ?? "",
      employeeId: c.employee_id ?? "", shipmentId: c.shipment_id ?? "",
      paymentMethod: c.payment_method, receiptNo: c.receipt_no ?? "",
      notes: c.notes ?? ""
    });
    setDeciding(null);
    setError(null); setNotice(null);
  }

  async function submitCost(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const payload = {
        costDate: form.costDate, category: form.category,
        description: form.description, amount: Number(form.amount),
        payee: form.payee || null,
        employeeId: form.employeeId || null, shipmentId: form.shipmentId || null,
        paymentMethod: form.paymentMethod, receiptNo: form.receiptNo || null,
        notes: form.notes || null
      };
      const res = await apiFetch(editing ? `/office-costs/${editing}` : "/office-costs", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the cost entry.")); return; }
      setNotice(editing
        ? "Entry updated — it goes back to pending for a fresh approval."
        : "Cost recorded — it is pending until approved.");
      setForm(EMPTY_COST()); setEditing(null);
      await load();
    } finally { setBusy(false); }
  }

  async function decide(c: Cost, decision: "approve" | "reject", note?: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/office-costs/${c.id}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: note || null })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to record the decision.")); return; }
      setNotice(decision === "approve"
        ? `Approved: ${c.description}`
        : `Rejected: ${c.description}`);
      setDeciding(null); setDecisionNote("");
      await load();
    } finally { setBusy(false); }
  }

  async function removeCost(c: Cost) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/office-costs/${c.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to delete the entry.")); return; }
      setNotice("Entry deleted — receipt scans detached.");
      if (editing === c.id) { setEditing(null); setForm(EMPTY_COST()); }
      await load();
    } finally { setBusy(false); }
  }

  // ---------- Receipt scans ----------

  function pickAttachment(costId: string) {
    attachTargetRef.current = costId;
    attachInput.current?.click();
  }

  async function uploadAttachment(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    const costId = attachTargetRef.current;
    attachTargetRef.current = null;
    if (!f || !costId) return;
    setError(null); setNotice(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("entityType", "office_cost");
      fd.append("entityId", costId);
      fd.append("kind", "receipt");
      fd.append("file", f);
      const res = await apiFetch("/documents", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Upload failed.")); return; }
      setNotice("Receipt attached.");
      await load();
    } finally { setBusy(false); }
  }

  async function viewReceipt(documentId: string) {
    setError(null);
    const res = await apiFetch(`/documents/${documentId}/url`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Could not open the file.")); return; }
    window.open(j.url, "_blank");
  }

  // ---------- Budgets ----------

  async function saveBudget(category: string) {
    const raw = budgetEdits[category];
    if (raw === undefined) return;
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch("/office-budgets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: month, category, amount: Number(raw || 0) })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the budget.")); return; }
      setNotice(`Budget for ${CATEGORY_LABELS[category] ?? category} saved.`);
      setBudgetEdits(b => { const n = { ...b }; delete n[category]; return n; });
      await load();
    } finally { setBusy(false); }
  }

  async function removeBudget(b: Budget) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/office-budgets/${b.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to remove the budget.")); return; }
      setNotice(`Budget for ${CATEGORY_LABELS[b.category] ?? b.category} removed.`);
      await load();
    } finally { setBusy(false); }
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };
  const h2Cls = "text-sm font-bold uppercase tracking-[0.14em]";
  const pill = (color: string) => ({ borderLeft: `4px solid ${color}`, color: "var(--ink)" });
  const thCls = "p-12";
  const tdCls = "p-12";
  const monthLabel = fmtPeriod(month);

  const term = search.trim().toLowerCase();
  const filtered = costs.filter(c =>
    (!statusFilter || c.status === statusFilter) &&
    (!categoryFilter || c.category === categoryFilter) &&
    (!term || c.description.toLowerCase().includes(term) ||
      (c.payee ?? "").toLowerCase().includes(term) ||
      (c.receipt_no ?? "").toLowerCase().includes(term) ||
      (c.file_number ?? "").toLowerCase().includes(term) ||
      (c.employee_name ?? "").toLowerCase().includes(term))
  );
  const pendingCount = costs.filter(c => c.status === "pending").length;

  const byDay = (() => {
    const map = new Map<string, { entries: number; total: number }>();
    for (const c of costs) {
      if (c.category !== "meals" || c.status !== "approved") continue;
      const row = map.get(c.cost_date) ?? { entries: 0, total: 0 };
      row.entries += 1; row.total += Number(c.amount);
      map.set(c.cost_date, row);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  })();

  const byEmployee = (() => {
    const map = new Map<string, { entries: number; total: number; pending: number }>();
    for (const c of costs) {
      if (c.category !== "allowance") continue;
      const key = c.employee_name ?? c.payee ?? "Unassigned";
      const row = map.get(key) ?? { entries: 0, total: 0, pending: 0 };
      if (c.status === "approved") { row.entries += 1; row.total += Number(c.amount); }
      if (c.status === "pending") row.pending += Number(c.amount);
      map.set(key, row);
    }
    return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  })();

  const trendMax = summary ? Math.max(1, ...summary.months.map(m => m.value)) : 1;

  const costForm = (lock: string | null) => (
    <form onSubmit={submitCost} className="mt-16 grid grid-cols-2 gap-12 rounded-card border bg-surface p-24 md:grid-cols-4" style={cardStyle}>
      <label className="block">
        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Date *</span>
        <input required type="date" value={form.costDate}
          onChange={e => setForm(f => ({ ...f, costDate: e.target.value }))}
          className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Category *</span>
        {lock && !editing ? (
          <input value={CATEGORY_LABELS[lock] ?? lock} disabled
            className={inputCls} style={inputStyle} />
        ) : (
          <select value={form.category}
            onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            className={inputCls} style={inputStyle}>
            {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
        )}
      </label>
      <label className="block">
        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Amount (TZS) *</span>
        <input required type="number" min={0} step="0.01" value={form.amount}
          onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
          className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Paid via</span>
        <select value={form.paymentMethod}
          onChange={e => setForm(f => ({ ...f, paymentMethod: e.target.value }))}
          className={inputCls} style={inputStyle}>
          {Object.entries(METHOD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label className="block md:col-span-2">
        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Description *</span>
        <input required value={form.description} placeholder="e.g. Office lunch for clearing team"
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Payee</span>
        <input value={form.payee} placeholder="e.g. Amina Hardware"
          onChange={e => setForm(f => ({ ...f, payee: e.target.value }))}
          className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Receipt no.</span>
        <input value={form.receiptNo}
          onChange={e => setForm(f => ({ ...f, receiptNo: e.target.value }))}
          className={inputCls} style={inputStyle} />
      </label>
      <label className="block">
        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Employee (allowances)</span>
        <select value={form.employeeId}
          onChange={e => setForm(f => ({ ...f, employeeId: e.target.value }))}
          className={inputCls} style={inputStyle}>
          <option value="">No employee</option>
          {employees.filter(e => e.status !== "left")
            .map(e => <option key={e.id} value={e.id}>{e.full_name}</option>)}
        </select>
      </label>
      <label className="block">
        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Cargo file (file costs)</span>
        <select value={form.shipmentId}
          onChange={e => setForm(f => ({ ...f, shipmentId: e.target.value }))}
          className={inputCls} style={inputStyle}>
          <option value="">No file — office expense</option>
          {files.map(f => <option key={f.id} value={f.id}>{f.file_number}</option>)}
        </select>
      </label>
      <label className="block md:col-span-2">
        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
        <input value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          className={inputCls} style={inputStyle} />
      </label>
      <div className="flex items-end gap-8 md:col-span-4">
        <button type="submit" disabled={busy} className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
          {editing ? "Save changes" : "Record cost"}
        </button>
        {editing && (
          <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
            onClick={() => { setEditing(null); setForm(EMPTY_COST()); }}>
            Cancel edit
          </button>
        )}
      </div>
    </form>
  );

  const register = (lock: string | null) => {
    const rows = lock ? filtered.filter(c => c.category === lock) : filtered;
    return (
      <>
        <div className="mt-16 flex flex-wrap items-center gap-8">
          <button type="button" onClick={() => setStatusFilter("")}
            className="on-photo-btn rounded-input px-12 py-4 text-xs font-semibold"
            style={statusFilter === "" ? { borderColor: "#c9a84c", background: "rgba(201,168,76,0.24)" } : undefined}>
            All {costs.length}
          </button>
          <button type="button" onClick={() => setStatusFilter("pending")}
            className="on-photo-btn rounded-input px-12 py-4 text-xs font-semibold"
            style={statusFilter === "pending" ? { borderColor: "#c9a84c", background: "rgba(201,168,76,0.24)" } : undefined}>
            Pending {pendingCount}
          </button>
          <button type="button" onClick={() => setStatusFilter("approved")}
            className="on-photo-btn rounded-input px-12 py-4 text-xs font-semibold"
            style={statusFilter === "approved" ? { borderColor: "#c9a84c", background: "rgba(201,168,76,0.24)" } : undefined}>
            Approved
          </button>
          <button type="button" onClick={() => setStatusFilter("rejected")}
            className="on-photo-btn rounded-input px-12 py-4 text-xs font-semibold"
            style={statusFilter === "rejected" ? { borderColor: "#c9a84c", background: "rgba(201,168,76,0.24)" } : undefined}>
            Rejected
          </button>
          {!lock && (
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
              className="rounded-input border px-12 py-4 text-xs" style={inputStyle}>
              <option value="">All categories</option>
              {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
            </select>
          )}
          <input value={search} placeholder="Search description, payee, file…"
            onChange={e => setSearch(e.target.value)}
            className="rounded-input border px-12 py-4 text-xs" style={{ ...inputStyle, minWidth: 220 }} />
        </div>

        {deciding && (
          <div className="mt-16 flex flex-wrap items-end gap-12 px-16 py-12"
            style={{ background: "color-mix(in srgb, var(--danger) 6%, transparent)", borderLeft: "4px solid var(--danger)" }}>
            <p className="text-sm" style={{ color: "var(--ink)" }}>
              Rejecting <span className="font-semibold">{deciding.description}</span> — add a note for the record.
            </p>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Reason</span>
              <input value={decisionNote}
                onChange={e => setDecisionNote(e.target.value)}
                className={inputCls} style={{ ...inputStyle, minWidth: 260 }} />
            </label>
            <button type="button" disabled={busy}
              className="rounded-input px-16 py-8 text-xs font-semibold text-white"
              style={{ background: "var(--danger)" }}
              onClick={() => decide(deciding, "reject", decisionNote)}>
              Confirm reject
            </button>
            <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
              onClick={() => { setDeciding(null); setDecisionNote(""); }}>
              Cancel
            </button>
          </div>
        )}

        <div className="mt-16 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className={thCls}>Date</th><th className={thCls}>Entry</th>
                <th className={thCls}>For</th><th className={thCls}>Paid via</th>
                <th className={thCls}>Receipt</th><th className={thCls}>Amount (TZS)</th>
                <th className={thCls}>Status</th><th className={thCls}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => (
                <tr key={c.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className={`${tdCls} whitespace-nowrap`} style={{ color: "var(--ink-soft)" }}>{fmtDate(c.cost_date)}</td>
                  <td className={tdCls} style={{ color: "var(--ink)" }}>
                    <span className="font-semibold">{c.description}</span>
                    <span className="ml-8 px-6 py-2 text-[10px] font-bold uppercase"
                      style={pill("var(--brand)")}>{CATEGORY_LABELS[c.category] ?? c.category}</span>
                    {c.payee && <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>{c.payee}</span>}
                    {c.notes && <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{c.notes}</p>}
                  </td>
                  <td className={tdCls} style={{ color: "var(--ink-soft)" }}>
                    {c.employee_name ?? c.file_number ?? "—"}
                  </td>
                  <td className={tdCls} style={{ color: "var(--ink-soft)" }}>{METHOD_LABELS[c.payment_method] ?? c.payment_method}</td>
                  <td className={`${tdCls} whitespace-nowrap`} style={{ color: "var(--ink-soft)" }}>
                    {c.document_count > 0 && c.latest_document_id ? (
                      <button type="button" className="text-xs underline" style={{ color: "var(--brand)" }}
                        onClick={() => viewReceipt(c.latest_document_id!)}>View</button>
                    ) : (
                      <span className="text-xs">None</span>
                    )}
                    <button type="button" className="ml-8 text-xs underline" style={{ color: "var(--ink-soft)" }}
                      onClick={() => pickAttachment(c.id)}>Attach</button>
                  </td>
                  <td className={`${tdCls} whitespace-nowrap tabular-nums font-semibold`} style={{ color: "var(--ink)" }}>
                    {fmtMoney(c.amount)}
                  </td>
                  <td className={tdCls}>
                    <span className="whitespace-nowrap px-6 py-2 text-[10px] font-bold uppercase"
                      style={pill(STATUS_COLORS[c.status] ?? "var(--ink-soft)")}>
                      {STATUS_LABELS[c.status] ?? c.status}
                    </span>
                    {c.status !== "pending" && c.approved_by_name && (
                      <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                        by {c.approved_by_name} · {fmtDate(c.approved_at)}
                      </p>
                    )}
                    {c.review_note && (
                      <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{c.review_note}</p>
                    )}
                  </td>
                  <td className={`${tdCls} whitespace-nowrap`}>
                    {c.status === "pending" && (
                      <>
                        <button type="button" disabled={busy} className="text-xs font-semibold underline"
                          style={{ color: "var(--success)" }}
                          onClick={() => decide(c, "approve")}>Approve</button>
                        <button type="button" disabled={busy} className="ml-8 text-xs font-semibold underline"
                          style={{ color: "var(--danger)" }}
                          onClick={() => { setDeciding(c); setDecisionNote(""); }}>Reject</button>
                      </>
                    )}
                    <button type="button" className="ml-8 text-xs underline" style={{ color: "var(--ink-soft)" }}
                      onClick={() => startEdit(c)}>Edit</button>
                    <button type="button" className="ml-8 text-xs underline" style={{ color: "var(--danger)" }}
                      onClick={() => removeCost(c)}>Delete</button>
                  </td>
                </tr>
              ))}
              {ready && rows.length === 0 && (
                <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                  {costs.length === 0
                    ? `Nothing recorded for ${monthLabel} yet — record the first entry above.`
                    : "No entries match the current filters."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  return (
    <div className="mx-auto max-w-[1080px] px-16 py-32">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Office Management</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            What running the office costs — the daily register with approvals, allowances,
            meals and refreshments, file costs against revenue, and budgets versus spend.
          </p>
        </div>
        <div className="flex items-center gap-12">
          <input type="month" value={month}
            onChange={e => e.target.value && setMonth(e.target.value)}
            className="rounded-input border px-12 py-4 text-xs" style={inputStyle} />
          <Link href="/app/office" className="pane-note text-xs underline">
            ← Office area
          </Link>
        </div>
      </div>
      {error && <div role="alert" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      <div className="mt-24 flex flex-wrap gap-8">
        {TABS.map(t => (
          <button key={t.key} type="button" onClick={() => setView(t.key)}
            className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold"
            style={view === t.key ? { borderColor: "#c9a84c", background: "rgba(201,168,76,0.24)" } : undefined}>
            {t.label}
          </button>
        ))}
      </div>

      <input ref={attachInput} type="file" hidden accept=".pdf,image/jpeg,image/png,image/webp"
        onChange={uploadAttachment} />

      {/* ================= Overview ================= */}
      {view === "overview" && summary && (
        <>
          <section className="mt-24 grid grid-cols-2 gap-16 md:grid-cols-5">
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Spent in {monthLabel}</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{fmtMoney(summary.totals.spent)}</p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{summary.totals.approvedCount} approved entries</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Awaiting approval</p>
              <p className="mt-8 text-2xl font-bold tabular-nums"
                style={{ color: summary.totals.pendingCount ? "var(--warning)" : "var(--ink)" }}>
                {summary.totals.pendingCount}
              </p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{fmtMoney(summary.totals.pending)} TZS</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Budget</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{fmtMoney(summary.totals.budget)}</p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>across {summary.categories.filter(c => c.budget > 0).length} categories</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Remaining</p>
              <p className="mt-8 text-2xl font-bold tabular-nums"
                style={{ color: summary.totals.remaining < 0 ? "var(--danger)" : "var(--ink)" }}>
                {fmtMoney(summary.totals.remaining)}
              </p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                {summary.totals.budget > 0
                  ? `${Math.round((summary.totals.spent / summary.totals.budget) * 100)}% of budget used`
                  : "no budget set"}
              </p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Biggest category</p>
              {(() => {
                const top = [...summary.categories].sort((a, b) => b.spent - a.spent)[0];
                return top && top.spent > 0 ? (
                  <>
                    <p className="mt-8 text-sm font-bold" style={{ color: "var(--ink)" }}>{CATEGORY_LABELS[top.category]}</p>
                    <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{fmtMoney(top.spent)} TZS this month</p>
                  </>
                ) : (
                  <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>Nothing approved yet</p>
                );
              })()}
            </div>
          </section>

          <section className="mt-32">
            <h2 className={`${h2Cls} pane-note`}>Spend — last 6 months</h2>
            <div className={card} style={{ ...cardStyle, marginTop: 16 }}>
              <div className="flex items-end gap-16" style={{ height: 140 }}>
                {summary.months.map(m => (
                  <div key={m.month} className="flex flex-1 flex-col items-center justify-end">
                    <p className="mb-4 text-[10px] tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmtMoney(m.value)}</p>
                    <div className="w-full rounded-t"
                      style={{
                        height: Math.round((m.value / trendMax) * 96) + 4,
                        background: m.month === month ? "var(--brand)" : "color-mix(in srgb, var(--brand) 35%, transparent)"
                      }} />
                  </div>
                ))}
              </div>
              <div className="mt-8 flex gap-16">
                {summary.months.map(m => (
                  <p key={m.month} className="flex-1 text-center text-[10px] font-semibold uppercase tracking-[0.1em]"
                    style={{ color: m.month === month ? "var(--ink)" : "var(--ink-soft)" }}>
                    {monthShort(m.month)}
                  </p>
                ))}
              </div>
            </div>
          </section>

          <section className="mt-32">
            <h2 className={`${h2Cls} pane-note`}>Categories this month</h2>
            <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className={thCls}>Category</th><th className={thCls}>Budget (TZS)</th>
                    <th className={thCls}>Spent (TZS)</th><th className={thCls}>Awaiting (TZS)</th>
                    <th className={thCls}>Remaining (TZS)</th><th className={thCls}>Used</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.categories.map((r, i) => {
                    const pct = r.budget > 0 ? Math.round((r.spent / r.budget) * 100) : null;
                    return (
                      <tr key={r.category} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className={`${tdCls} font-semibold`} style={{ color: "var(--ink)" }}>{CATEGORY_LABELS[r.category]}</td>
                        <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink-soft)" }}>{r.budget > 0 ? fmtMoney(r.budget) : "—"}</td>
                        <td className={`${tdCls} tabular-nums font-semibold`} style={{ color: "var(--ink)" }}>{fmtMoney(r.spent)}</td>
                        <td className={`${tdCls} tabular-nums`} style={{ color: r.pending > 0 ? "var(--warning)" : "var(--ink-soft)" }}>
                          {r.pending > 0 ? `${fmtMoney(r.pending)} (${r.pendingCount})` : "—"}
                        </td>
                        <td className={`${tdCls} tabular-nums`}
                          style={{ color: r.budget > 0 && r.remaining < 0 ? "var(--danger)" : "var(--ink-soft)" }}>
                          {r.budget > 0 ? fmtMoney(r.remaining) : "—"}
                        </td>
                        <td className={tdCls} style={{ minWidth: 120 }}>
                          {pct === null ? (
                            <span className="text-xs" style={{ color: "var(--ink-soft)" }}>no budget</span>
                          ) : (
                            <div>
                              <p className="text-xs tabular-nums font-semibold"
                                style={{ color: pct > 100 ? "var(--danger)" : pct >= 90 ? "var(--warning)" : "var(--ink)" }}>
                                {pct}%
                              </p>
                              <div className="mt-4 h-2 w-full rounded" style={{ background: "var(--milk-deep)" }}>
                                <div style={{
                                  width: `${Math.min(100, pct)}%`, height: "100%", borderRadius: 999,
                                  background: pct > 100 ? "var(--danger)" : pct >= 90 ? "var(--warning)" : "var(--success)"
                                }} />
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* ================= Daily costs ================= */}
      {view === "daily" && (
        <section className="mt-24">
          <h2 className={`${h2Cls} pane-note`}>
            Daily costs — {monthLabel} · {fmtMoney(summary?.totals.spent ?? 0)} TZS approved
          </h2>
          {costForm(null)}
          {register(null)}
        </section>
      )}

      {/* ================= Allowances ================= */}
      {view === "allowances" && (
        <section className="mt-24">
          <h2 className={`${h2Cls} pane-note`}>Allowances — {monthLabel}</h2>
          {byEmployee.length > 0 && (
            <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className={thCls}>Member</th><th className={thCls}>Approved</th>
                    <th className={thCls}>Total (TZS)</th><th className={thCls}>Awaiting (TZS)</th>
                  </tr>
                </thead>
                <tbody>
                  {byEmployee.map(([name, r], i) => (
                    <tr key={name} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                      <td className={`${tdCls} font-semibold`} style={{ color: "var(--ink)" }}>{name}</td>
                      <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink-soft)" }}>{r.entries}</td>
                      <td className={`${tdCls} tabular-nums font-semibold`} style={{ color: "var(--ink)" }}>{fmtMoney(r.total)}</td>
                      <td className={`${tdCls} tabular-nums`} style={{ color: r.pending ? "var(--warning)" : "var(--ink-soft)" }}>
                        {r.pending ? fmtMoney(r.pending) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {costForm("allowance")}
          {register("allowance")}
        </section>
      )}

      {/* ================= Meals & refreshments ================= */}
      {view === "meals" && (
        <section className="mt-24">
          <h2 className={`${h2Cls} pane-note`}>Meals & refreshments — {monthLabel}</h2>
          <div className="mt-16 grid grid-cols-2 gap-16 md:grid-cols-3">
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Approved this month</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                {fmtMoney((summary?.categories.find(c => c.category === "meals")?.spent) ?? 0)}
              </p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Days served</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{byDay.length}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Average per day</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                {byDay.length ? fmtMoney(Math.round(byDay.reduce((n, [, r]) => n + r.total, 0) / byDay.length)) : "—"}
              </p>
            </div>
          </div>
          {byDay.length > 0 && (
            <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className={thCls}>Day</th><th className={thCls}>Entries</th><th className={thCls}>Total (TZS)</th>
                  </tr>
                </thead>
                <tbody>
                  {byDay.map(([day, r], i) => (
                    <tr key={day} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                      <td className={`${tdCls} font-semibold`} style={{ color: "var(--ink)" }}>{fmtDate(day)}</td>
                      <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink-soft)" }}>{r.entries}</td>
                      <td className={`${tdCls} tabular-nums font-semibold`} style={{ color: "var(--ink)" }}>{fmtMoney(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {costForm("meals")}
          {register("meals")}
        </section>
      )}

      {/* ================= File costs ================= */}
      {view === "filecosts" && (
        <section className="mt-24">
          <h2 className={`${h2Cls} pane-note`}>File costs against revenue</h2>
          <section className="mt-16 grid grid-cols-2 gap-16 md:grid-cols-3">
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Files carrying office costs</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{fileCosts?.totals.files ?? 0}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Allocated (TZS)</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{fmtMoney(fileCosts?.totals.allocated ?? 0)}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Awaiting approval (TZS)</p>
              <p className="mt-8 text-2xl font-bold tabular-nums"
                style={{ color: (fileCosts?.totals.pending ?? 0) > 0 ? "var(--warning)" : "var(--ink)" }}>
                {fmtMoney(fileCosts?.totals.pending ?? 0)}
              </p>
            </div>
          </section>
          <div className="mt-16 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className={thCls}>File</th><th className={thCls}>Consignee</th>
                  <th className={thCls}>Payment (TZS)</th><th className={thCls}>Processing (TZS)</th>
                  <th className={thCls}>Office costs (TZS)</th><th className={thCls}>Awaiting (TZS)</th>
                  <th className={thCls}>Margin (TZS)</th><th className={thCls}>Entries</th>
                </tr>
              </thead>
              <tbody>
                {(fileCosts?.rows ?? []).map((r, i) => (
                  <tr key={r.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className={tdCls} style={{ color: "var(--ink)" }}>
                      <span className="font-semibold">{r.file_number}</span>
                      <span className="ml-8 px-6 py-2 text-[10px] font-bold uppercase"
                        style={pill("var(--brand)")}>{STAGE_LABELS[r.stage] ?? r.stage}</span>
                    </td>
                    <td className={tdCls} style={{ color: "var(--ink-soft)" }}>{r.consignee_name}</td>
                    <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink-soft)" }}>{fmtMoney(r.payment_amount)}</td>
                    <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink-soft)" }}>{fmtMoney(r.processing_cost)}</td>
                    <td className={`${tdCls} tabular-nums font-semibold`} style={{ color: "var(--ink)" }}>{fmtMoney(r.allocated)}</td>
                    <td className={`${tdCls} tabular-nums`} style={{ color: r.pending_amount > 0 ? "var(--warning)" : "var(--ink-soft)" }}>
                      {r.pending_amount > 0 ? fmtMoney(r.pending_amount) : "—"}
                    </td>
                    <td className={`${tdCls} tabular-nums font-semibold`}
                      style={{ color: r.margin === null ? "var(--ink-soft)" : r.margin < 0 ? "var(--danger)" : "var(--success)" }}>
                      {fmtMoney(r.margin)}
                    </td>
                    <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink-soft)" }}>{r.entries}</td>
                  </tr>
                ))}
                {ready && (fileCosts?.rows ?? []).length === 0 && (
                  <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    No office costs allocated to cargo files yet — pick a file when recording a cost and its
                    cost-against-revenue margin shows here.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="pane-note mt-8 text-xs">
            Margin = payment amount − processing cost − approved office costs allocated to the file.
          </p>
        </section>
      )}

      {/* ================= Budgets ================= */}
      {view === "budgets" && summary && (
        <section className="mt-24">
          <h2 className={`${h2Cls} pane-note`}>Budgets — {monthLabel} · budget versus spend</h2>
          <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className={thCls}>Category</th><th className={thCls}>Budget (TZS)</th>
                  <th className={thCls}>Spent (TZS)</th><th className={thCls}>Awaiting (TZS)</th>
                  <th className={thCls}>Remaining (TZS)</th><th className={thCls}></th>
                </tr>
              </thead>
              <tbody>
                {summary.categories.map((r, i) => {
                  const existing = budgets.find(b => b.category === r.category);
                  const value = budgetEdits[r.category] !== undefined
                    ? budgetEdits[r.category]
                    : existing ? String(existing.amount) : "";
                  const pct = r.budget > 0 ? Math.round((r.spent / r.budget) * 100) : null;
                  return (
                    <tr key={r.category} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                      <td className={`${tdCls} font-semibold`} style={{ color: "var(--ink)" }}>
                        {CATEGORY_LABELS[r.category]}
                        {pct !== null && (
                          <span className="ml-8 text-xs tabular-nums"
                            style={{ color: pct > 100 ? "var(--danger)" : pct >= 90 ? "var(--warning)" : "var(--ink-soft)" }}>
                            {pct}% used
                          </span>
                        )}
                      </td>
                      <td className={tdCls} style={{ minWidth: 160 }}>
                        <input type="number" min={0} step="0.01" value={value}
                          onChange={e => setBudgetEdits(b => ({ ...b, [r.category]: e.target.value }))}
                          className={inputCls} style={{ ...inputStyle, maxWidth: 140 }} />
                      </td>
                      <td className={`${tdCls} tabular-nums font-semibold`} style={{ color: "var(--ink)" }}>{fmtMoney(r.spent)}</td>
                      <td className={`${tdCls} tabular-nums`} style={{ color: r.pending > 0 ? "var(--warning)" : "var(--ink-soft)" }}>
                        {r.pending > 0 ? `${fmtMoney(r.pending)} (${r.pendingCount})` : "—"}
                      </td>
                      <td className={`${tdCls} tabular-nums`}
                        style={{ color: r.budget > 0 && r.remaining < 0 ? "var(--danger)" : "var(--ink-soft)" }}>
                        {r.budget > 0 ? fmtMoney(r.remaining) : "—"}
                      </td>
                      <td className={`${tdCls} whitespace-nowrap`}>
                        <button type="button" disabled={busy || budgetEdits[r.category] === undefined}
                          className="waisha-btn rounded-input px-12 py-4 text-xs font-semibold"
                          onClick={() => saveBudget(r.category)}>
                          {existing ? "Update" : "Set"}
                        </button>
                        {existing && (
                          <button type="button" className="ml-8 text-xs underline" style={{ color: "var(--danger)" }}
                            onClick={() => removeBudget(existing)}>Remove</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="pane-note mt-8 text-xs">
            Budgets are per category and month — overruns raise alerts in the notifications centre.
          </p>
        </section>
      )}
    </div>
  );
}
