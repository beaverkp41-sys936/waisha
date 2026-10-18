"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

const readJson = (res: Response) => res.json().catch(() => null) as Promise<any>;

interface Bounds {
  from: string; to: string; countedUpTo: string; today: string; workingDays: number;
}
interface Charge {
  unpaid_leave_dates: string[]; absence_dates: string[]; unrecorded_dates: string[];
}
interface Line {
  id?: string;
  employee_id: string; employee_name: string; job_title: string | null; department: string | null;
  monthly_salary: string; working_days: number;
  unpaid_leave_days: number; absence_days: number; unrecorded_days: number;
  half_days: number; late_minutes: number; days_paid: number;
  base_amount: string; deduction_amount: string;
  adjustment_amount?: string; adjustment_label?: string | null;
  net_amount: string; detail?: Charge | null;
  // only on a line that is stored in a run
  full_name?: string; employment_type?: string; employee_status?: string;
  hired_date?: string | null; note?: string | null;
}
interface Totals {
  gross_total: string; deduction_total: string; net_total: string; headcount: number;
}
interface Preview {
  period: string; bounds: Bounds; totals: Totals; lines: Line[];
  alreadyBuilt: { id: string; status: string; headcount: number; net_total: string } | null;
  skipped: { employee_id: string; full_name: string; job_title: string | null; no_salary: boolean }[];
}
interface Run {
  id: string; period: string; status: string; currency: string; working_days: number;
  gross_total: string; deduction_total: string; adjustment_total: string; net_total: string;
  headcount: number; payment_reference: string | null; paid_on: string | null; note: string | null;
  issued_at: string | null; issued_by_name: string | null;
  cancelled_at: string | null; cancelled_by_name: string | null; cancel_reason: string | null;
  lines_with_gaps: number; lines_adjusted: number;
  bounds?: Bounds; lines?: Line[];
  skipped?: { full_name: string; job_title: string | null }[];
}
interface Slip {
  company_name: string | null; tin_display: string | null;
  run_id: string; period: string; status: string; currency: string;
  payment_reference: string | null; paid_on: string | null;
  issued_at: string | null; issued_by_name: string | null;
  id: string; employee_id: string; employee_name: string; job_title: string | null;
  department: string | null; monthly_salary: string; working_days: number;
  unpaid_leave_days: number; absence_days: number; unrecorded_days: number;
  half_days: number; late_minutes: number; days_paid: number;
  base_amount: string; deduction_amount: string;
  adjustment_amount: string; adjustment_label: string | null;
  net_amount: string; detail: Charge | null; note: string | null;
  employment_type: string; hired_date: string | null;
}
interface RegisterRow {
  employee_id: string; full_name: string; job_title: string | null; department: string | null;
  run_id: string; period: string; status: string; monthly_salary: string;
  days_paid: number; working_days: number; unpaid_leave_days: number; absence_days: number;
  unrecorded_days: number; base_amount: string; deduction_amount: string;
  adjustment_amount: string; adjustment_label: string | null; net_amount: string;
  paid_on: string | null; payment_reference: string | null;
}
interface Register {
  window: { from: string | null; to: string | null };
  totals: { people: number; net: string; base: string; deductions: string; adjustments: string };
  rows: RegisterRow[];
  employees: {
    employee_id: string; full_name: string; job_title: string | null; department: string | null;
    months: number; days_paid: number; periods: string[];
    net_total: string; base_total: string; deduction_total: string; adjustment_total: string;
  }[];
}

const TABS = [
  { key: "prepare", label: "Prepare the month" },
  { key: "run", label: "The run" },
  { key: "runs", label: "Register of runs" },
  { key: "payslip", label: "Payslip" },
  { key: "salary", label: "Salary register" }
] as const;
type View = typeof TABS[number]["key"];

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const STATUS_LABELS: Record<string, string> = { draft: "Draft", issued: "Issued", cancelled: "Cancelled" };
const STATUS_COLORS: Record<string, string> = {
  draft: "var(--warning)", issued: "var(--success)", cancelled: "var(--ink-soft)"
};
const EMPLOYMENT_LABELS: Record<string, string> = {
  permanent: "Permanent", fixed_term: "Fixed-term", intern: "Trainee"
};

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** The API takes a period as the first day of a month — nothing else parses. */
const firstOfMonth = (iso: string) => `${iso.slice(0, 7)}-01`;
const monthInput = (period: string) => period.slice(0, 7);
const fmtPeriod = (v: string | null | undefined) => {
  if (!v) return "—";
  const [y, m] = v.split("-").map(Number);
  return `${MONTH_NAMES[(m ?? 1) - 1] ?? m} ${y}`;
};
const monthShort = (v: string) => {
  const [y, m] = v.split("-").map(Number);
  return `${(MONTH_NAMES[(m ?? 1) - 1] ?? String(m)).slice(0, 3)} ${y}`;
};
const fmtDay = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString() : "—");
const fmtStamp = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "—");
/** Money is a numeric string from the API; it is never run through a float for a total. */
const money = (v: string | number | null | undefined) =>
  v == null ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);

/** A short date for the charged-day lists on a line: "14 Oct". */
const dayTag = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso
    : `${String(d.getDate()).padStart(2, "0")} ${(MONTH_NAMES[d.getMonth()] ?? "").slice(0, 3)}`;
};

export default function OfficePayrollPage() {
  const [view, setView] = useState<View>("prepare");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A control that destroys or signs off is armed by a first tap, like the rest of the office.
  const [arm, setArm] = useState<string | null>(null);

  const [period, setPeriod] = useState(firstOfMonth(localToday()));
  const [preview, setPreview] = useState<Preview | null>(null);

  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [adj, setAdj] = useState<{ lineId: string; amount: string; label: string; note: string } | null>(null);
  const [issueForm, setIssueForm] = useState({ paymentReference: "", paidOn: "" });
  const [book, setBook] = useState({ paymentReference: "", paidOn: "", note: "" });
  const [cancelReason, setCancelReason] = useState("");

  const [slipRunId, setSlipRunId] = useState("");
  const [slipRun, setSlipRun] = useState<Run | null>(null);
  const [slipLineId, setSlipLineId] = useState("");
  const [slip, setSlip] = useState<Slip | null>(null);

  const [regPerson, setRegPerson] = useState("");
  const [regFrom, setRegFrom] = useState("");
  const [regTo, setRegTo] = useState("");
  const [register, setRegister] = useState<Register | null>(null);
  const [people, setPeople] = useState<{ employee_id: string; full_name: string }[]>([]);

  function reset() { setError(null); setNotice(null); }

  async function act(label: string, fn: () => Promise<Response>, onOk?: (j: any) => string) {
    reset(); setBusy(true);
    try {
      const res = await fn();
      const json = await readJson(res);
      if (!res.ok) { setError(errorText(json, `${label} failed.`)); return null; }
      setNotice(onOk ? onOk(json) : `${label}.`);
      return json;
    } finally { setBusy(false); }
  }

  function post(path: string, body?: unknown) {
    return apiFetch(path, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    });
  }
  function put(path: string, body: unknown) {
    return apiFetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  const loadRuns = useCallback(async () => {
    const res = await apiFetch("/payroll/runs");
    const j = await readJson(res);
    if (res.ok) setRuns(Array.isArray(j?.runs) ? j.runs : []);
    else setError(errorText(j, "Could not read the register of runs."));
    return j?.runs as Run[] | undefined;
  }, []);

  const loadPreview = useCallback(async () => {
    const res = await apiFetch(`/payroll/preview?period=${period}`);
    const j = await readJson(res);
    if (res.ok) { setPreview(j); setError(null); }
    else { setPreview(null); setError(errorText(j, "Could not read that month's derivation.")); }
  }, [period]);

  const loadRun = useCallback(async (id: string) => {
    const res = await apiFetch(`/payroll/runs/${id}`);
    const j = await readJson(res);
    if (res.ok) {
      setRun(j);
      setAdj(null);
      setBook({
        paymentReference: j.payment_reference ?? "", paidOn: j.paid_on ?? "", note: j.note ?? ""
      });
      setError(null);
    } else {
      setRun(null); setError(errorText(j, "Could not open that payroll run."));
    }
  }, []);

  useEffect(() => {
    (async () => {
      const list = await loadRuns();
      if (list?.length) {
        const open = list.find(r => r.status === "draft") ?? list[0];
        setRunId(open.id);
        setSlipRunId(open.id);
      }
      setReady(true);
    })();
    // once on mount — every list is re-read after a write
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (view === "prepare") loadPreview(); }, [view, loadPreview]);
  useEffect(() => { if (view === "run" && runId) loadRun(runId); }, [view, runId, loadRun]);

  const loadSlip = useCallback(async (runIdArg: string, lineId: string) => {
    const res = await apiFetch(`/payroll/runs/${runIdArg}/payslip/${lineId}`);
    const j = await readJson(res);
    if (res.ok) { setSlip(j); setError(null); }
    else { setSlip(null); setError(errorText(j, "Could not read that payslip.")); }
  }, []);

  useEffect(() => {
    if (view !== "payslip" || !slipRunId) { setSlipRun(null); return; }
    let cancelled = false;
    (async () => {
      const res = await apiFetch(`/payroll/runs/${slipRunId}`);
      const j = await readJson(res);
      if (cancelled) return;
      if (res.ok) {
        setSlipRun(j);
        const lines = (j.lines ?? []) as Line[];
        const firstId = lines[0]?.id;
        if (!firstId) { setSlipLineId(""); setSlip(null); }
        else setSlipLineId(prev => (prev && lines.some(l => l.id === prev) ? prev : firstId));
      } else setError(errorText(j, "Could not open that month's lines."));
    })();
    return () => { cancelled = true; };
  }, [view, slipRunId]);

  useEffect(() => {
    if (view === "payslip" && slipRunId && slipLineId) loadSlip(slipRunId, slipLineId);
  }, [view, slipRunId, slipLineId, loadSlip]);

  const loadRegister = useCallback(async (person: string, from: string, to: string) => {
    const qs = new URLSearchParams();
    if (person) qs.set("employeeId", person);
    if (from) qs.set("from", firstOfMonth(from));
    if (to) qs.set("to", firstOfMonth(to));
    const res = await apiFetch(`/payroll/register${qs.toString() ? `?${qs}` : ""}`);
    const j = await readJson(res);
    if (!res.ok) { setError(errorText(j, "Could not read the salary register.")); return; }
    setRegister(j);
    // The unfiltered pass is what populates the person list — a register narrowed
    // to one member must not leave the picker with one name in it.
    if (!person && !from && !to) {
      setPeople((j.employees as Register["employees"]).map(p => ({ employee_id: p.employee_id, full_name: p.full_name })));
    }
    setError(null);
  }, []);

  useEffect(() => { if (view === "runs") loadRuns(); }, [view, loadRuns]);
  useEffect(() => { if (view === "salary") loadRegister(regPerson, regFrom, regTo); },
    [view, regPerson, regFrom, regTo, loadRegister]);

  // ---------- the writes ----------

  async function buildMonth() {
    const j = await act("Built the draft", () => post("/payroll/runs", { period }),
      (r: any) => `${r.headcount} line${r.headcount === 1 ? "" : "s"} derived against ${
        r.bounds.countedUpTo === r.bounds.to
          ? fmtPeriod(r.period)
          : `${fmtPeriod(r.period)} counted to ${fmtDay(r.bounds.countedUpTo)}`
      } — net ${money(r.net_total)} ${r.currency}. Adjust the lines, then issue.`);
    if (!j) return;
    setRunId(j.id);
    setSlipRunId(j.id);
    await loadRuns();
    setView("run");
  }

  async function rebuild() {
    if (!run) return;
    if (arm !== `rebuild:${run.id}`) { setArm(`rebuild:${run.id}`); setTimeout(() => setArm(a => (a === `rebuild:${run.id}` ? null : a)), 6000); return; }
    setArm(null);
    const j = await act("Rebuilt the draft", () => post(`/payroll/runs/${run.id}/rebuild`));
    if (!j) return;
    await Promise.all([loadRun(run.id), loadRuns()]);
  }

  async function saveAdjustment() {
    if (!adj || !run) return;
    const amount = Number(adj.amount || "0");
    if (!Number.isFinite(amount)) { setError("The adjustment has to be a number — a credit or a debit in the figures."); return; }
    const body: Record<string, unknown> = { adjustmentAmount: amount };
    if (adj.label.trim()) body.adjustmentLabel = adj.label.trim();
    if (adj.note.trim()) body.note = adj.note.trim();
    const j = await act(amount === 0 ? "Cleared the adjustment" : "Saved the adjustment",
      () => put(`/payroll/lines/${adj.lineId}`, body),
      (r: any) => `${r.employee_name}: net ${money(r.net_amount)} ${run.currency}.`);
    if (!j) return;
    setAdj(null);
    await Promise.all([loadRun(run.id), loadRuns()]);
  }

  async function dropLine(line: Line) {
    if (!line.id || !run) return;
    if (arm !== line.id) { setArm(line.id); setTimeout(() => setArm(a => (a === line.id ? null : a)), 6000); return; }
    setArm(null);
    const j = await act(`Took ${line.employee_name} out of the run`, () =>
      apiFetch(`/payroll/lines/${line.id}`, { method: "DELETE" }));
    if (!j) return;
    await Promise.all([loadRun(run.id), loadRuns()]);
  }

  async function issueRun() {
    if (!run) return;
    const body: Record<string, unknown> = {};
    if (issueForm.paymentReference.trim()) body.paymentReference = issueForm.paymentReference.trim();
    if (issueForm.paidOn) body.paidOn = issueForm.paidOn;
    const j = await act("Issued the run", () => post(`/payroll/runs/${run.id}/issue`, body),
      () => `Issued. The figures are frozen — a correction now needs a new run for the month.`);
    if (!j) return;
    setIssueForm({ paymentReference: "", paidOn: "" });
    await Promise.all([loadRun(run.id), loadRuns()]);
  }

  async function cancelRun() {
    if (!run) return;
    if (cancelReason.trim().length < 5) { setError("Say why the run is being cancelled — five characters at least."); return; }
    const j = await act("Cancelled the run", () => post(`/payroll/runs/${run.id}/cancel`, { reason: cancelReason.trim() }));
    if (!j) return;
    setCancelReason("");
    await Promise.all([loadRun(run.id), loadRuns()]);
  }

  async function recordPayment() {
    if (!run) return;
    const body: Record<string, unknown> = {
      paymentReference: book.paymentReference.trim() || null,
      paidOn: book.paidOn || null,
      note: book.note.trim() || null
    };
    const j = await act("Recorded the payment", () => put(`/payroll/runs/${run.id}`, body));
    if (!j) return;
    await Promise.all([loadRun(run.id), loadRuns()]);
  }

  // ---------- shared bits ----------

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };
  const h2Cls = "text-sm font-bold uppercase tracking-[0.14em]";
  const thCls = "p-12";
  const solid = (bg: string, disabled: boolean) =>
    ({ background: bg, color: "var(--on-solid)", opacity: disabled ? 0.45 : 1 });
  const ghostBtn = "on-photo-btn rounded-input px-14 py-8 text-xs";

  const chip = (label: string, color: string) => (
    <span className="whitespace-nowrap px-8 py-2 text-[10px] font-bold uppercase"
      style={{ borderLeft: `4px solid ${color}`, color }}>
      {label}
    </span>
  );

  /** The three day-counts that cost money, and the one that does not. */
  const charged = (label: string, n: number, dates: string[] | undefined, color: string) => (
    <div className="flex flex-wrap items-center gap-8">
      <span className="tabular-nums font-bold" style={{ color: n ? color : "var(--ink-soft)" }}>{n}</span>
      {n > 0 && dates?.length ? (
        <span className="flex flex-wrap gap-4">
          {dates.map(d => (
            <span key={d} className="px-6 py-2 text-[10px]"
              style={{ background: "color-mix(in srgb, var(--ink) 6%, transparent)", color: "var(--ink-soft)" }}>
              {dayTag(d)}
            </span>
          ))}
        </span>
      ) : null}
      <span className="sr-only">{label}</span>
    </div>
  );

  const lineCells = (l: Line, persisted: boolean) => (
    <>
      <td className="p-12">
        <p className="font-semibold" style={{ color: "var(--ink)" }}>{l.employee_name}</p>
        <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
          {[l.job_title, l.department].filter(Boolean).join(" · ") || "—"}
        </p>
      </td>
      <td className="p-12 text-right tabular-nums">{money(l.monthly_salary)}</td>
      <td className="p-12">{charged("approved unpaid leave", l.unpaid_leave_days, l.detail?.unpaid_leave_dates, "var(--danger)")}</td>
      <td className="p-12">{charged("recorded absences", l.absence_days, l.detail?.absence_dates, "var(--danger)")}</td>
      <td className="p-12">{charged("unrecorded weekdays", l.unrecorded_days, l.detail?.unrecorded_dates, "var(--warning)")}</td>
      <td className="p-12 text-right tabular-nums">{l.days_paid} / {l.working_days}</td>
      <td className="p-12 text-right tabular-nums" style={{ color: toCents(l.deduction_amount) ? "var(--danger)" : "var(--ink-soft)" }}>
        −{money(l.deduction_amount)}
      </td>
      <td className="p-12 text-right tabular-nums">{money(l.base_amount)}</td>
      {persisted && (
        <td className="p-12 text-right tabular-nums">
          {toCents(l.adjustment_amount) ? (
            <>
              <p style={{ color: toCents(l.adjustment_amount) < 0 ? "var(--danger)" : "var(--success)" }}>
                {toCents(l.adjustment_amount) > 0 ? "+" : "−"}{money(Math.abs(toCents(l.adjustment_amount) / 100))}
              </p>
              <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{l.adjustment_label ?? ""}</p>
            </>
          ) : <span style={{ color: "var(--ink-soft)" }}>—</span>}
        </td>
      )}
      <td className="p-12 text-right font-bold tabular-nums" style={{ color: "var(--ink)" }}>{money(l.net_amount)}</td>
    </>
  );

  if (!ready) return <div className="px-16 py-32"><p className="pane-note text-xs">Loading payroll…</p></div>;

  const drafts = runs.filter(r => r.status === "draft");
  // Only an issued month counts as paid. A draft's net sits in its own row, never in
  // this total, because a draft is a calculation that has not been signed off yet.
  const issuedNetCents = runs.filter(r => r.status === "issued").reduce((s, r) => s + toCents(r.net_total), 0);
  const previewTotals = preview?.totals;
  // The API's gross_total is the payable-after-deduction figure (the sum of base_amount),
  // so the contract total is summed here from the same lines, in whole cents.
  const contractCents = (preview?.lines ?? []).reduce((s, l) => s + toCents(l.monthly_salary), 0);
  const monthStillRunning = preview && preview.bounds.countedUpTo !== preview.bounds.to;

  return (
    <div className="mx-auto max-w-[1080px] px-16 py-32">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Payroll</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            A month's pay derived from the attendance register and the leave queue — one figure per person,
            adjusted only by a named hand, frozen the day it is issued. Every amount is {runs[0]?.currency ?? "TZS"}.
          </p>
        </div>
        <Link href="/app/office" className="pane-note text-xs underline">← Office area</Link>
      </div>

      {error && <div role="alert" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      <div className="mt-24 flex flex-wrap gap-8">
        {TABS.map(t => (
          <button key={t.key} type="button"
            onClick={() => { setView(t.key); reset(); setArm(null); }}
            className={ghostBtn + " font-semibold" + (view === t.key ? " is-on" : "")}>
            {t.label}{t.key === "run" && drafts.length ? ` (${drafts.length})` : ""}
          </button>
        ))}
      </div>

      {/* ================= Prepare the month ================= */}
      {view === "prepare" && (
        <section className="mt-24">
          <div className="flex flex-wrap items-end gap-16">
            <label className="min-w-[220px]">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Month to prepare</span>
              <input type="month" className={inputCls} style={inputStyle} value={monthInput(period)}
                onChange={e => { if (e.target.value) setPeriod(`${e.target.value}-01`); }} />
            </label>
            <button type="button" disabled={busy || !preview} onClick={buildMonth}
              className="rounded-input px-20 py-10 text-sm font-bold"
              style={solid("var(--brand)", busy || !preview)}>
              {preview?.alreadyBuilt
                ? `Build ${fmtPeriod(period)} anyway`
                : `Build the draft for ${fmtPeriod(period)}`}
            </button>
          </div>

          {preview && (
            <>
              <p className="pane-note mt-12 text-xs">
                Counted from {fmtDay(preview.bounds.from)} to <strong>{fmtDay(preview.bounds.countedUpTo)}</strong> —
                {" "}{preview.bounds.workingDays} Mon–Fri days in the month. Nothing after the date in bold is in these figures;
                {" "}{monthStillRunning ? "the month is still running, so rebuild it before you issue." : "the month has closed."}
              </p>

              {preview.alreadyBuilt && (
                <div role="status" className="mt-16 px-12 py-8 text-sm"
                  style={{ background: "color-mix(in srgb, var(--warning) 10%, transparent)", borderLeft: "4px solid var(--warning)" }}>
                  There is already a <strong>{STATUS_LABELS[preview.alreadyBuilt.status]}</strong> run for {fmtPeriod(period)} —{" "}
                  {preview.alreadyBuilt.headcount} line{preview.alreadyBuilt.headcount === 1 ? "" : "s"}, net{" "}
                  {money(preview.alreadyBuilt.net_total)}.{" "}
                  {preview.alreadyBuilt.status === "draft"
                    ? <button type="button" className="underline font-bold" onClick={() => { setRunId(preview.alreadyBuilt!.id); setView("run"); }}>Open it</button>
                    : "A month is never issued twice; correct a paid run by cancelling it and building a new one."}
                </div>
              )}

              <section className="mt-24 grid grid-cols-2 gap-16 md:grid-cols-3 xl:grid-cols-6">
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>In the run</p>
                  <p className="mt-8 text-2xl font-bold tabular-nums">{previewTotals?.headcount ?? 0}</p>
                </div>
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Contract</p>
                  <p className="mt-8 text-lg font-bold tabular-nums">{money(contractCents / 100)}</p>
                </div>
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Deducted</p>
                  <p className="mt-8 text-lg font-bold tabular-nums"
                    style={{ color: toCents(previewTotals?.deduction_total) ? "var(--danger)" : "var(--ink)" }}>
                    −{money(previewTotals?.deduction_total)}
                  </p>
                </div>
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Payable after deduction</p>
                  <p className="mt-8 text-lg font-bold tabular-nums">{money(previewTotals?.gross_total)}</p>
                </div>
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Net to pay</p>
                  <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--success)" }}>
                    {money(previewTotals?.net_total)}
                  </p>
                </div>
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Days in month</p>
                  <p className="mt-8 text-2xl font-bold tabular-nums">{preview.bounds.workingDays}</p>
                </div>
              </section>

              <section className="mt-32">
                <h2 className={`${h2Cls} pane-note`}>What the register says — {preview.lines.length} payable line{preview.lines.length === 1 ? "" : "s"}</h2>
                <div className="mt-16 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
                  <table className="w-full min-w-[860px] text-sm">
                    <thead>
                      <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                        <th className={thCls}>Member</th><th className={thCls}>Salary</th>
                        <th className={thCls}>Unpaid leave</th><th className={thCls}>Absent</th>
                        <th className={thCls}>Unrecorded</th><th className={thCls}>Days paid</th>
                        <th className={thCls}>Deducted</th><th className={thCls}>Payable</th><th className={thCls}>Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.lines.map(l => (
                        <tr key={l.employee_id} className="border-t" style={{ borderColor: "var(--line)" }}>
                          {lineCells(l, false)}
                        </tr>
                      ))}
                      {!preview.lines.length && (
                        <tr><td colSpan={9} className="p-24 text-center text-xs" style={{ color: "var(--ink-soft)" }}>
                          Nobody on the roster is active with a salary on file, so there is nothing to pay this month.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="pane-note mt-12 text-[11px]">
                  A weekday with no attendance row is <strong>unrecorded</strong> — shown here and charged nothing, because a
                  clerk who forgot to clock someone in must not cost them four days' pay. Fix the register, then rebuild.
                </p>
              </section>

              {preview.skipped.length > 0 && (
                <section className="mt-32">
                  <h2 className={`${h2Cls} pane-note`} style={{ color: "var(--danger)" }}>
                    Left out because no salary is on file
                  </h2>
                  <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
                    {preview.skipped.map(s => (
                      <div key={s.employee_id} className="flex flex-wrap items-center justify-between gap-12 border-b p-16 last:border-b-0"
                        style={{ borderColor: "var(--line)" }}>
                        <div>
                          <p className="text-sm font-semibold">{s.full_name}</p>
                          <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>{s.job_title ?? "—"}</p>
                        </div>
                        <Link href="/app/office/employees" className={ghostBtn}>Set their salary</Link>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </section>
      )}

      {/* ================= The run ================= */}
      {view === "run" && (
        <section className="mt-24">
          <div className="flex flex-wrap items-end gap-16">
            <label className="min-w-[280px]">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Payroll run</span>
              <select className={inputCls} style={inputStyle} value={runId ?? ""}
                onChange={e => setRunId(e.target.value || null)}>
                <option value="">— choose a month —</option>
                {runs.map(r => (
                  <option key={r.id} value={r.id}>
                    {fmtPeriod(r.period)} · {STATUS_LABELS[r.status]} · {r.headcount} · {money(r.net_total)}
                  </option>
                ))}
              </select>
            </label>
            {!runs.length && (
              <button type="button" onClick={() => { setView("prepare"); reset(); }} className={ghostBtn}>
                Nothing has been built yet — prepare a month
              </button>
            )}
          </div>

          {run && (
            <>
              <div className="mt-24 flex flex-wrap items-start justify-between gap-16 rounded-card border bg-surface p-24" style={cardStyle}>
                <div>
                  <div className="flex items-center gap-12">
                    <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>{fmtPeriod(run.period)} payroll</h2>
                    {chip(STATUS_LABELS[run.status] ?? run.status, STATUS_COLORS[run.status] ?? "var(--ink-soft)")}
                  </div>
                  <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {run.headcount} line{run.headcount === 1 ? "" : "s"} · divisor {run.working_days} working days ·{" "}
                    {run.lines_with_gaps} with an unrecorded weekday · {run.lines_adjusted} hand-adjusted
                  </p>
                  {run.status === "issued" && (
                    <p className="mt-8 text-xs">
                      Issued {fmtStamp(run.issued_at)} by <strong>{run.issued_by_name ?? "—"}</strong>.
                      {run.payment_reference ? ` Reference ${run.payment_reference}.` : " No payment reference typed yet."}
                      {run.paid_on ? ` Paid ${fmtDay(run.paid_on)}.` : ""}
                    </p>
                  )}
                  {run.status === "cancelled" && (
                    <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>
                      Cancelled {fmtStamp(run.cancelled_at)} by {run.cancelled_by_name ?? "—"} — {run.cancel_reason}
                    </p>
                  )}
                  {run.note && <p className="mt-8 whitespace-pre-line text-xs">{run.note}</p>}
                </div>
                <div className="grid grid-cols-3 gap-16 text-right">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Payable</p>
                    <p className="text-sm font-bold tabular-nums">{money(run.gross_total)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Deducted</p>
                    <p className="text-sm font-bold tabular-nums" style={{ color: "var(--danger)" }}>
                      −{money(run.deduction_total)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Adjustments</p>
                    <p className="text-sm font-bold tabular-nums"
                      style={{ color: toCents(run.adjustment_total) < 0 ? "var(--danger)" : "var(--success)" }}>
                      {toCents(run.adjustment_total) > 0 ? "+" : toCents(run.adjustment_total) < 0 ? "−" : ""}
                      {money(Math.abs(toCents(run.adjustment_total) / 100))}
                    </p>
                  </div>
                  <div className="col-span-3 border-t pt-12" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Net for the month</p>
                    <p className="text-2xl font-bold tabular-nums" style={{ color: "var(--success)" }}>{money(run.net_total)}</p>
                  </div>
                </div>
              </div>

              {/* draft-only actions */}
              {run.status === "draft" && (
                <div className="mt-24 grid grid-cols-1 gap-16 md:grid-cols-2">
                  <div className={card} style={cardStyle}>
                    <h3 className={h2Cls} style={{ color: "var(--ink)" }}>Re-derive from the register</h3>
                    <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                      Throws the draft's lines away and reads the attendance and leave queues again as they stand right now.
                      Any hand-typed adjustment on a line that survives the rebuild is lost — a rebuild is arithmetic, not memory.
                    </p>
                    <button type="button" disabled={busy} onClick={rebuild}
                      className="mt-12 rounded-input border px-16 py-8 text-xs font-bold"
                      style={{ borderColor: arm === `rebuild:${run.id}` ? "var(--danger)" : "var(--line)", color: "var(--danger)" }}>
                      {arm === `rebuild:${run.id}` ? "Tap again to rebuild and clear adjustments" : "Rebuild this draft"}
                    </button>
                  </div>

                  <div className={card} style={cardStyle}>
                    <h3 className={h2Cls} style={{ color: "var(--ink)" }}>Issue it</h3>
                    <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                      Issuing freezes every line: nobody can re-type a derived figure, drop a person or rebuild the month.
                      A reference for the transfer is typed afterwards by whoever moved the money, so it is optional here.
                    </p>
                    <div className="mt-12 grid grid-cols-1 gap-12 sm:grid-cols-2">
                      <label>
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Payment reference (optional)</span>
                        <input className={inputCls} style={inputStyle} value={issueForm.paymentReference} maxLength={160}
                          placeholder="Bank / transfer slip number"
                          onChange={e => setIssueForm(f => ({ ...f, paymentReference: e.target.value }))} />
                      </label>
                      <label>
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Paid on (optional)</span>
                        <input type="date" className={inputCls} style={inputStyle} value={issueForm.paidOn}
                          onChange={e => setIssueForm(f => ({ ...f, paidOn: e.target.value }))} />
                      </label>
                    </div>
                    <button type="button" disabled={busy || run.headcount === 0} onClick={issueRun}
                      className="mt-12 rounded-input px-20 py-8 text-xs font-bold"
                      style={solid("var(--success)", busy || run.headcount === 0)}>
                      Issue {fmtPeriod(run.period)} — {money(run.net_total)} {run.currency}
                    </button>
                    {run.headcount === 0 && (
                      <p className="mt-8 text-[11px]" style={{ color: "var(--danger)" }}>
                        This run has nobody in it, so there is nothing to sign off. Rebuild it or delete the month.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* lines */}
              <section className="mt-32">
                <h2 className={`${h2Cls} pane-note`}>Lines {run.status === "draft" ? "— derived, and the adjustment block is yours" : "— as issued"}</h2>
                <div className="mt-16 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
                  <table className="w-full min-w-[980px] text-sm">
                    <thead>
                      <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                        <th className={thCls}>Member</th><th className={thCls}>Salary</th>
                        <th className={thCls}>Unpaid leave</th><th className={thCls}>Absent</th>
                        <th className={thCls}>Unrecorded</th><th className={thCls}>Days paid</th>
                        <th className={thCls}>Deducted</th><th className={thCls}>Payable</th>
                        <th className={thCls}>Adjustment</th><th className={thCls}>Net</th>
                        {run.status === "draft" && <th className={thCls}>&nbsp;</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(run.lines ?? []).map(l => (
                        <tr key={l.id} className="border-t align-top" style={{ borderColor: "var(--line)" }}>
                          {lineCells(l, true)}
                          {run.status === "draft" && (
                            <td className="p-12 text-right whitespace-nowrap">
                              <button type="button" disabled={busy || !l.id}
                                onClick={() => setAdj(adj?.lineId === l.id ? null
                                  : { lineId: l.id!, amount: l.adjustment_amount ?? "0", label: l.adjustment_label ?? "", note: l.note ?? "" })}
                                className="on-photo-btn px-10 py-4 text-[11px]">
                                {adj?.lineId === l.id ? "Close" : "Adjust"}
                              </button>
                              <button type="button" disabled={busy || !l.id} onClick={() => dropLine(l)}
                                className="ml-8 px-10 py-4 text-[11px]"
                                style={{ color: arm === l.id ? "var(--danger)" : "var(--ink-soft)", border: "1px solid currentColor", borderRadius: 8 }}>
                                {arm === l.id ? "Tap again" : "Drop"}
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                      {!(run.lines ?? []).length && (
                        <tr><td colSpan={run.status === "draft" ? 11 : 10} className="p-24 text-center text-xs" style={{ color: "var(--ink-soft)" }}>
                          No lines. Rebuild the draft to derive them from the register.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {adj && run.status === "draft" && (
                  <div className="mt-16 rounded-card border bg-surface p-24" style={{ ...cardStyle, borderLeft: "4px solid var(--gold)" }}>
                    <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                      The only figure on a payslip a person types. Everything to the left of it comes from the register and
                      the roster, and the office will be asked to explain this one — so it carries its own label.
                    </p>
                    <div className="mt-16 grid grid-cols-1 gap-16 md:grid-cols-3">
                      <label>
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Amount (negative is a deduction)</span>
                        <input type="number" step="0.01" className={inputCls} style={inputStyle} value={adj.amount}
                          onChange={e => setAdj(a => a ? { ...a, amount: e.target.value } : a)} />
                      </label>
                      <label>
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>What it is for</span>
                        <input className={inputCls} style={inputStyle} value={adj.label} maxLength={120}
                          placeholder="Statutory deduction, loan recovery, bonus"
                          onChange={e => setAdj(a => a ? { ...a, label: e.target.value } : a)} />
                      </label>
                      <label>
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note on the line (optional)</span>
                        <input className={inputCls} style={inputStyle} value={adj.note} maxLength={500}
                          onChange={e => setAdj(a => a ? { ...a, note: e.target.value } : a)} />
                      </label>
                    </div>
                    <div className="mt-16 flex flex-wrap gap-12">
                      <button type="button" disabled={busy} onClick={saveAdjustment}
                        className="rounded-input px-20 py-8 text-xs font-bold" style={solid("var(--brand)", busy)}>
                        Save the adjustment
                      </button>
                      <button type="button" disabled={busy} onClick={() => setAdj(null)} className={ghostBtn}>Leave it alone</button>
                      <p className="pane-note self-center text-[11px]">
                        Zero clears it and the label with it. The net re-reads as base + adjustment — the database checks it, not this page.
                      </p>
                    </div>
                  </div>
                )}
              </section>

              {/* issued: bookkeeping; anything: cancel */}
              {run.status === "issued" && (
                <section className="mt-32">
                  <h2 className={`${h2Cls} pane-note`}>Payment bookkeeping</h2>
                  <div className="mt-16 rounded-card border bg-surface p-24" style={cardStyle}>
                    <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                      A reference string and a date, nothing more — this system never moves money, holds a bank credential or
                      talks to a payment provider. The figures on the run do not change here.
                    </p>
                    <div className="mt-16 grid grid-cols-1 gap-16 md:grid-cols-3">
                      <label>
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Payment reference</span>
                        <input className={inputCls} style={inputStyle} value={book.paymentReference} maxLength={160}
                          onChange={e => setBook(b => ({ ...b, paymentReference: e.target.value }))} />
                      </label>
                      <label>
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Paid on</span>
                        <input type="date" className={inputCls} style={inputStyle} value={book.paidOn ?? ""}
                          onChange={e => setBook(b => ({ ...b, paidOn: e.target.value }))} />
                      </label>
                      <label>
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note</span>
                        <input className={inputCls} style={inputStyle} value={book.note} maxLength={1000}
                          onChange={e => setBook(b => ({ ...b, note: e.target.value }))} />
                      </label>
                    </div>
                    <button type="button" disabled={busy} onClick={recordPayment}
                      className="mt-16 rounded-input px-20 py-8 text-xs font-bold" style={solid("var(--brand)", busy)}>
                      Save the record
                    </button>
                  </div>
                </section>
              )}

              {run.status !== "cancelled" && (
                <section className="mt-32">
                  <h2 className={`${h2Cls} pane-note`} style={{ color: "var(--danger)" }}>The only way out</h2>
                  <div className="mt-16 rounded-card border bg-surface p-24" style={{ ...cardStyle, borderLeft: "4px solid var(--danger)" }}>
                    <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                      Cancelling keeps every line and its figures — a payroll is corrected, never erased — and the month then
                      leaves the salary register so what was not paid is not totalled. It needs a reason and a name, and it is
                      the only route back for an issued run.
                    </p>
                    <div className="mt-16 flex flex-wrap items-end gap-12">
                      <label className="min-w-[320px] flex-1">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Why it is being cancelled</span>
                        <input className={inputCls} style={inputStyle} value={cancelReason} maxLength={500}
                          placeholder="Two people were on the wrong salary band; the register was rebuilt wrongly"
                          onChange={e => setCancelReason(e.target.value)} />
                      </label>
                      <button type="button" disabled={busy || cancelReason.trim().length < 5} onClick={cancelRun}
                        className="rounded-input px-20 py-8 text-xs font-bold"
                        style={solid("var(--danger)", busy || cancelReason.trim().length < 5)}>
                        Cancel {fmtPeriod(run.period)}
                      </button>
                    </div>
                  </div>
                </section>
              )}
            </>
          )}
        </section>
      )}

      {/* ================= Register of runs ================= */}
      {view === "runs" && (
        <section className="mt-24">
          <h2 className={`${h2Cls} pane-note`}>Every month this company has run payroll for</h2>
          <div className="mt-16 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className={thCls}>Month</th><th className={thCls}>Status</th><th className={thCls}>People</th>
                  <th className={thCls}>Payable</th><th className={thCls}>Deducted</th><th className={thCls}>Adjusted</th>
                  <th className={thCls}>Net</th><th className={thCls}>Issued by</th><th className={thCls}>Paid</th>
                  <th className={thCls}>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                    <td className="p-12">
                      <p className="font-semibold">{fmtPeriod(r.period)}</p>
                      <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        divisor {r.working_days} · {r.lines_with_gaps} with gaps · {r.lines_adjusted} adjusted
                      </p>
                    </td>
                    <td className="p-12">{chip(STATUS_LABELS[r.status] ?? r.status, STATUS_COLORS[r.status] ?? "var(--ink-soft)")}</td>
                    <td className="p-12 tabular-nums">{r.headcount}</td>
                    <td className="p-12 text-right tabular-nums">{money(r.gross_total)}</td>
                    <td className="p-12 text-right tabular-nums" style={{ color: toCents(r.deduction_total) ? "var(--danger)" : "var(--ink-soft)" }}>
                      −{money(r.deduction_total)}
                    </td>
                    <td className="p-12 text-right tabular-nums"
                      style={{ color: toCents(r.adjustment_total) ? (toCents(r.adjustment_total) < 0 ? "var(--danger)" : "var(--success)") : "var(--ink-soft)" }}>
                      {toCents(r.adjustment_total) ? `${toCents(r.adjustment_total) > 0 ? "+" : "−"}${money(Math.abs(toCents(r.adjustment_total) / 100))}` : "—"}
                    </td>
                    <td className="p-12 text-right font-bold tabular-nums">{money(r.net_total)}</td>
                    <td className="p-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      {r.issued_by_name ? `${r.issued_by_name} · ${fmtStamp(r.issued_at)}` : "—"}
                      {r.cancelled_at && <p style={{ color: "var(--danger)" }}>{r.cancelled_by_name} · {fmtStamp(r.cancelled_at)}</p>}
                    </td>
                    <td className="p-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      {r.paid_on ? fmtDay(r.paid_on) : "—"}
                      {r.payment_reference && <p className="truncate" style={{ maxWidth: 160 }}>{r.payment_reference}</p>}
                    </td>
                    <td className="p-12 text-right whitespace-nowrap">
                      <button type="button" className="on-photo-btn px-10 py-4 text-[11px]"
                        onClick={() => { setRunId(r.id); setView("run"); reset(); }}>Open</button>
                      <button type="button" className="on-photo-btn ml-8 px-10 py-4 text-[11px]"
                        onClick={() => { setSlipRunId(r.id); setView("payslip"); reset(); }}>Payslips</button>
                    </td>
                  </tr>
                ))}
                {!runs.length && (
                  <tr><td colSpan={10} className="p-24 text-center text-xs" style={{ color: "var(--ink-soft)" }}>
                    No payroll has been built yet. Prepare a month to see the derivation before anything is written.
                  </td></tr>
                )}
              </tbody>
              {!!runs.length && (
                <tfoot>
                  <tr className="border-t" style={{ borderColor: "var(--line)" }}>
                    <td className="p-12 text-[11px] uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }} colSpan={6}>
                      Net paid across the months that were issued
                    </td>
                    <td className="p-12 text-right font-bold tabular-nums" style={{ color: "var(--success)" }}>{money(issuedNetCents / 100)}</td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="pane-note mt-12 text-[11px]">
            {drafts.length
              ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"} still open — a draft pays nobody and a rebuild would change it.`
              : "No draft is open, so nothing here can change except a payment reference."}
          </p>
        </section>
      )}

      {/* ================= Payslip ================= */}
      {view === "payslip" && (
        <section className="mt-24">
          <div className="no-print flex flex-wrap items-end gap-16">
            <label className="min-w-[260px]">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Month</span>
              <select className={inputCls} style={inputStyle} value={slipRunId} onChange={e => setSlipRunId(e.target.value)}>
                <option value="">— choose a month —</option>
                {runs.map(r => (
                  <option key={r.id} value={r.id}>{fmtPeriod(r.period)} · {STATUS_LABELS[r.status]} · {r.headcount}</option>
                ))}
              </select>
            </label>
            <label className="min-w-[260px]">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Member</span>
              <select className={inputCls} style={inputStyle} value={slipLineId}
                onChange={e => setSlipLineId(e.target.value)} disabled={!(slipRun?.lines ?? []).length}>
                {(slipRun?.lines ?? []).map(l => (
                  <option key={l.id} value={l.id}>{l.employee_name} — {money(l.net_amount)}</option>
                ))}
                {!(slipRun?.lines ?? []).length && <option value="">Nobody in this run</option>}
              </select>
            </label>
            {slip && (
              <button type="button" onClick={() => window.print()} className={ghostBtn}>Print / Save as PDF</button>
            )}
          </div>

          {slip && (
            <div className="payslip-sheet mt-24 rounded-card border bg-surface p-32"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
              <header className="flex items-start justify-between gap-24 border-b pb-16" style={{ borderColor: "var(--line)" }}>
                <div>
                  <p className="text-sm font-bold">{slip.company_name ?? ""}</p>
                  <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {slip.tin_display ? `TIN ${slip.tin_display}` : ""}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em]">Payslip</p>
                  <p className="text-[11px] font-bold uppercase tracking-[0.14em]">{fmtPeriod(slip.period)}</p>
                  <p className="mt-6 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    {STATUS_LABELS[slip.status] ?? slip.status}
                    {slip.issued_at ? ` · ${fmtStamp(slip.issued_at)}` : ""}
                  </p>
                </div>
              </header>

              <section className="mt-20 grid grid-cols-1 gap-x-24 gap-y-10 text-xs sm:grid-cols-3">
                <SlipField label="Member" value={slip.employee_name} />
                <SlipField label="Job" value={slip.job_title} />
                <SlipField label="Department" value={slip.department} />
                <SlipField label="Engagement"
                  value={EMPLOYMENT_LABELS[slip.employment_type] ?? slip.employment_type} />
                <SlipField label="On payroll since" value={slip.hired_date ? fmtDay(slip.hired_date) : null} />
                <SlipField label="Currency" value={slip.currency} />
              </section>

              <section className="mt-24">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--ink)" }}>
                      <th className="py-8">Pay item</th><th className="py-8 text-right">Days</th><th className="py-8 text-right">Amount ({slip.currency})</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t" style={{ borderColor: "var(--line)" }}>
                      <td className="py-8">Monthly salary on file</td>
                      <td className="py-8 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>—</td>
                      <td className="py-8 text-right tabular-nums">{money(slip.monthly_salary)}</td>
                    </tr>
                    {toCents(slip.deduction_amount) !== 0 && (
                      <tr className="border-t" style={{ borderColor: "var(--line)" }}>
                        <td className="py-8">
                          Absence and unpaid-leave deduction
                          <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {slip.unpaid_leave_days} approved unpaid leave day{slip.unpaid_leave_days === 1 ? "" : "s"} ·{" "}
                            {slip.absence_days} recorded absence{slip.absence_days === 1 ? "" : "s"}
                          </p>
                        </td>
                        <td className="py-8 text-right tabular-nums">{slip.unpaid_leave_days + slip.absence_days}</td>
                        <td className="py-8 text-right tabular-nums">−{money(slip.deduction_amount)}</td>
                      </tr>
                    )}
                    <tr className="border-t" style={{ borderColor: "var(--line)" }}>
                      <td className="py-8">
                        Pay for days worked
                        <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          {slip.days_paid} of {slip.working_days} working days in the month
                        </p>
                      </td>
                      <td className="py-8 text-right tabular-nums">{slip.days_paid}</td>
                      <td className="py-8 text-right tabular-nums">{money(slip.base_amount)}</td>
                    </tr>
                    {toCents(slip.adjustment_amount) !== 0 && (
                      <tr className="border-t" style={{ borderColor: "var(--line)" }}>
                        <td className="py-8">
                          {slip.adjustment_label || "Adjustment"}
                          <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>Entered by hand, with the run</p>
                        </td>
                        <td className="py-8 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>—</td>
                        <td className="py-8 text-right tabular-nums">
                          {toCents(slip.adjustment_amount) > 0 ? "+" : "−"}{money(Math.abs(toCents(slip.adjustment_amount) / 100))}
                        </td>
                      </tr>
                    )}
                    <tr className="border-t-2 font-bold" style={{ borderColor: "var(--ink)" }}>
                      <td className="py-12">Net pay for {fmtPeriod(slip.period)}</td>
                      <td className="py-12" />
                      <td className="py-12 text-right tabular-nums">{money(slip.net_amount)}</td>
                    </tr>
                  </tbody>
                </table>
              </section>

              <section className="mt-20 grid grid-cols-1 gap-16 text-[10px] sm:grid-cols-2">
                <SlipDates label="Days of approved unpaid leave" dates={slip.detail?.unpaid_leave_dates} color="var(--danger)" />
                <SlipDates label="Days recorded as absent" dates={slip.detail?.absence_dates} color="var(--danger)" />
                <SlipDates label="Weekdays with no attendance record — not charged"
                  dates={slip.detail?.unrecorded_dates} color="var(--warning)" />
                <div>
                  <p className="font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Other attendance</p>
                  <p className="mt-4">
                    {slip.half_days} half day{slip.half_days === 1 ? "" : "s"} · {slip.late_minutes} minute{slip.late_minutes === 1 ? "" : "s"} late.
                    Neither is charged on a payslip.
                  </p>
                </div>
              </section>

              {slip.note && (
                <section className="mt-20">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Note on this line</p>
                  <p className="mt-4 whitespace-pre-line text-xs">{slip.note}</p>
                </section>
              )}

              <section className="sig-block mt-28 grid grid-cols-1 gap-20 border-t pt-20 sm:grid-cols-3" style={{ borderColor: "var(--line)" }}>
                <SlipSign label="Issued by" name={slip.issued_by_name} at={slip.issued_at} />
                <SlipSign label="Payment reference" name={slip.payment_reference} at={slip.paid_on ? `Paid ${fmtDay(slip.paid_on)}` : null} />
                <div className="rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Received by</p>
                  <div className="mt-24 border-t pt-6" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Signature</p>
                  </div>
                </div>
              </section>

              <p className="mt-20 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                {slip.status === "issued"
                  ? "This slip is a record of what was paid. It is derived from the attendance register and the leave queue; the only hand-written figure on it is the labelled adjustment."
                  : "Draft slip — the run has not been issued, so these figures can still move. It is not yet a record of pay."}
              </p>
            </div>
          )}
        </section>
      )}

      {/* ================= Salary register ================= */}
      {view === "salary" && (
        <section className="mt-24">
          <div className="flex flex-wrap items-end gap-16">
            <label className="min-w-[240px]">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Member</span>
              <select className={inputCls} style={inputStyle} value={regPerson} onChange={e => setRegPerson(e.target.value)}>
                <option value="">Everyone paid at least once</option>
                {people.map(p => <option key={p.employee_id} value={p.employee_id}>{p.full_name}</option>)}
              </select>
            </label>
            <label>
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>From month</span>
              <input type="month" className={inputCls + " min-w-[160px]"} style={inputStyle} value={regFrom}
                onChange={e => setRegFrom(e.target.value)} />
            </label>
            <label>
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>To month</span>
              <input type="month" className={inputCls + " min-w-[160px]"} style={inputStyle} value={regTo}
                onChange={e => setRegTo(e.target.value)} />
            </label>
            {(regPerson || regFrom || regTo) && (
              <button type="button" className={ghostBtn}
                onClick={() => { setRegPerson(""); setRegFrom(""); setRegTo(""); }}>Whole register</button>
            )}
          </div>

          {register && (
            <>
              <section className="mt-24 grid grid-cols-2 gap-16 md:grid-cols-4">
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>People paid</p>
                  <p className="mt-8 text-2xl font-bold tabular-nums">{register.totals.people}</p>
                </div>
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Payable (after deduction)</p>
                  <p className="mt-8 text-lg font-bold tabular-nums">{money(register.totals.base)}</p>
                </div>
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Deducted</p>
                  <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--danger)" }}>
                    −{money(register.totals.deductions)}
                  </p>
                </div>
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Net paid</p>
                  <p className="mt-8 text-lg font-bold tabular-nums" style={{ color: "var(--success)" }}>
                    {money(register.totals.net)}
                  </p>
                </div>
              </section>

              <section className="mt-32">
                <h2 className={`${h2Cls} pane-note`}>Per person, across the months that were actually paid</h2>
                <div className="mt-16 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
                  <table className="w-full min-w-[820px] text-sm">
                    <thead>
                      <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                        <th className={thCls}>Member</th><th className={thCls}>Months</th><th className={thCls}>Days paid</th>
                        <th className={thCls}>Deducted</th><th className={thCls}>Payable</th><th className={thCls}>Adjustments</th>
                        <th className={thCls}>Net</th><th className={thCls}>Periods</th>
                      </tr>
                    </thead>
                    <tbody>
                      {register.employees.map(p => (
                        <tr key={p.employee_id} className="border-t" style={{ borderColor: "var(--line)" }}>
                          <td className="p-12">
                            <p className="font-semibold">{p.full_name}</p>
                            <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                              {[p.job_title, p.department].filter(Boolean).join(" · ") || "—"}
                            </p>
                          </td>
                          <td className="p-12 tabular-nums">{p.months}</td>
                          <td className="p-12 tabular-nums">{p.days_paid}</td>
                          <td className="p-12 text-right tabular-nums" style={{ color: toCents(p.deduction_total) ? "var(--danger)" : "var(--ink-soft)" }}>
                            −{money(p.deduction_total)}
                          </td>
                          <td className="p-12 text-right tabular-nums">{money(p.base_total)}</td>
                          <td className="p-12 text-right tabular-nums">
                            {toCents(p.adjustment_total) ? `${toCents(p.adjustment_total) > 0 ? "+" : "−"}${money(Math.abs(toCents(p.adjustment_total) / 100))}` : "—"}
                          </td>
                          <td className="p-12 text-right font-bold tabular-nums">{money(p.net_total)}</td>
                          <td className="p-12 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {p.periods.slice(0, 8).map(monthShort).join(", ")}
                            {p.periods.length > 8 ? ` +${p.periods.length - 8}` : ""}
                          </td>
                        </tr>
                      ))}
                      {!register.employees.length && (
                        <tr><td colSpan={8} className="p-24 text-center text-xs" style={{ color: "var(--ink-soft)" }}>
                          Nothing has been paid in this window. A cancelled run does not appear here — what was not paid is not totalled.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="mt-32">
                <h2 className={`${h2Cls} pane-note`}>Line by line — {register.rows.length} month{register.rows.length === 1 ? "" : "s"} of pay</h2>
                <div className="mt-16 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
                  <table className="w-full min-w-[900px] text-sm">
                    <thead>
                      <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                        <th className={thCls}>Member</th><th className={thCls}>Month</th><th className={thCls}>Status</th>
                        <th className={thCls}>Days</th><th className={thCls}>Deducted</th><th className={thCls}>Payable</th>
                        <th className={thCls}>Adjustment</th><th className={thCls}>Net</th><th className={thCls}>Paid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {register.rows.slice(0, 400).map(r => (
                        <tr key={`${r.run_id}-${r.employee_id}`} className="border-t" style={{ borderColor: "var(--line)" }}>
                          <td className="p-12 text-xs font-semibold">{r.full_name}</td>
                          <td className="p-12 text-xs">{monthShort(r.period)}</td>
                          <td className="p-12">{chip(STATUS_LABELS[r.status] ?? r.status, STATUS_COLORS[r.status] ?? "var(--ink-soft)")}</td>
                          <td className="p-12 text-xs tabular-nums">{r.days_paid} / {r.working_days}</td>
                          <td className="p-12 text-right text-xs tabular-nums" style={{ color: toCents(r.deduction_amount) ? "var(--danger)" : "var(--ink-soft)" }}>
                            −{money(r.deduction_amount)}
                          </td>
                          <td className="p-12 text-right text-xs tabular-nums">{money(r.base_amount)}</td>
                          <td className="p-12 text-right text-xs tabular-nums">
                            {toCents(r.adjustment_amount)
                              ? <>{money(r.adjustment_amount)}<p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{r.adjustment_label ?? ""}</p></>
                              : "—"}
                          </td>
                          <td className="p-12 text-right text-xs font-bold tabular-nums">{money(r.net_amount)}</td>
                          <td className="p-12 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {r.paid_on ? fmtDay(r.paid_on) : "—"}
                            {r.payment_reference && <p className="truncate" style={{ maxWidth: 140 }}>{r.payment_reference}</p>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {register.rows.length > 400 && (
                  <p className="pane-note mt-12 text-[11px]">
                    Showing the first 400 rows of {register.rows.length} — narrow the window or the member to read the rest.
                  </p>
                )}
              </section>
            </>
          )}
        </section>
      )}

      <p className="pane-note mt-32 text-xs">
        The arithmetic is not in this page — it lives in one database function, so the preview above and the payslip below
        cannot disagree. Attendance and leave are kept in{" "}
        <Link href="/app/office/attendance" className="underline">Attendance &amp; Leave</Link>, salaries in{" "}
        <Link href="/app/office/employees" className="underline">Employees</Link>.
      </p>
    </div>
  );
}

function SlipField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</p>
      <p className="mt-2" style={{ color: "var(--ink)" }}>{value || "—"}</p>
    </div>
  );
}

function SlipDates({ label, dates, color }: { label: string; dates?: string[]; color: string }) {
  return (
    <div>
      <p className="font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</p>
      <p className="mt-4" style={{ color: dates?.length ? color : "var(--ink-soft)" }}>
        {dates?.length ? dates.map(dayTag).join(" · ") : "None"}
      </p>
    </div>
  );
}

function SlipSign({ label, name, at }: { label: string; name: string | null; at: string | null }) {
  return (
    <div className="rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
      <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</p>
      <p className="mt-10 text-xs font-bold">{name || "—"}</p>
      {at && <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{at.includes("T") ? fmtStamp(at) : at}</p>}
      <div className="mt-16 border-t pt-6" style={{ borderColor: "var(--line)" }}>
        <p className="text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Signature</p>
      </div>
    </div>
  );
}
