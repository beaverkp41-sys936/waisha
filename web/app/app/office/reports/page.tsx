"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface RegisterRow {
  id: string; employee_id: string; full_name: string; department: string | null;
  employment_type: string; status: string;
  period_start: string | null; period_end: string | null;
  tasks_total: number; tasks_done: number; tasks_on_time: number;
  signed_count: number; rating: number | null;
}
interface EmployeeOption {
  id: string; full_name: string; department: string | null; employment_type: string;
  status: string; contract_start: string | null; contract_end: string | null;
}

const EMPLOYMENT_LABELS: Record<string, string> = {
  permanent: "Permanent", fixed_term: "Fixed-term", intern: "Trainee"
};

export default function TraineeReportsPage() {
  const router = useRouter();
  const [reports, setReports] = useState<RegisterRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [employeeId, setEmployeeId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    const [r, e] = await Promise.all([apiFetch("/trainee-reports"), apiFetch("/employees")]);
    if (r.ok) setReports(await r.json());
    if (e.ok) setEmployees(await e.json());
    if (!r.ok && !e.ok) setError(errorText(null, "Could not load the register."));
    setReady(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  const chosen = useMemo(() => employees.find(e => e.id === employeeId) ?? null, [employees, employeeId]);

  function pickEmployee(id: string) {
    setEmployeeId(id);
    const e = employees.find(x => x.id === id);
    // The contract dates the register already carries are the training period.
    if (e) { setPeriodStart(e.contract_start ?? ""); setPeriodEnd(e.contract_end ?? ""); }
  }

  async function generate() {
    if (!employeeId) { setError("Pick the person the report is about."); return; }
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch("/trainee-reports/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId,
          ...(periodStart ? { periodStart } : {}),
          ...(periodEnd ? { periodEnd } : {})
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not build the report.")); return; }
      router.push(`/app/office/reports/${j.id}`);
    } finally { setBusy(false); }
  }

  const rows = filter === "all" ? reports
    : filter === "complete" ? reports.filter(r => r.status === "complete")
    : reports.filter(r => r.status === "draft");

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[1180px] px-16 py-32">
      <p className="text-[11px] font-bold uppercase tracking-[0.2em]" style={{ color: "var(--gold-green)" }}>
        Office
      </p>
      <h1 className="mt-6 text-2xl font-bold">Trainee completion reports</h1>
      <p className="mt-6 text-sm" style={{ color: "var(--ink-soft)" }}>
        One page per person: what they were given, what they finished, how they were graded, and the
        three signatures that make it an official document.
      </p>

      {error && (
        <div role="alert" className={card} style={{ borderLeft: "4px solid var(--danger)", marginTop: 16 }}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className={card} style={{ borderLeft: "4px solid var(--success)", marginTop: 16 }}>
          {notice}
        </div>
      )}

      <div className={"mt-24 " + card} style={cardStyle}>
        <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
          Build a report from the record
        </h2>
        <div className="mt-16 grid grid-cols-1 gap-16 md:grid-cols-4">
          <label className="block md:col-span-2">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Who</span>
            <select className={inputCls} value={employeeId} onChange={e => pickEmployee(e.target.value)}
              style={inputStyle}>
              <option value="">— choose a person —</option>
              {employees.filter(e => e.status !== "left").map(e => (
                <option key={e.id} value={e.id}>
                  {e.full_name} · {EMPLOYMENT_LABELS[e.employment_type] ?? e.employment_type}
                  {e.department ? ` · ${e.department}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Period from</span>
            <input type="date" className={inputCls} style={inputStyle} value={periodStart}
              onChange={e => setPeriodStart(e.target.value)} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Period to</span>
            <input type="date" className={inputCls} style={inputStyle} value={periodEnd}
              onChange={e => setPeriodEnd(e.target.value)} />
          </label>
        </div>
        <p className="pane-note mt-12 text-xs">
          {chosen
            ? "Tasks, attendance and grades are counted from the assignments and evaluations in this window — nobody types the result."
            : "Pick a person and the contract dates fill the period."}
        </p>
        <button type="button" disabled={busy || !employeeId} onClick={generate}
          className="mt-16 rounded-input px-20 py-10 text-xs font-bold"
          style={{ background: "var(--brand)", color: "var(--on-solid)", opacity: busy || !employeeId ? 0.6 : 1 }}>
          Generate the draft
        </button>
      </div>

      <div className="mt-24 flex gap-8">
        {["all", "draft", "complete"].map(k => (
          <button key={k} type="button" onClick={() => setFilter(k)}
            className={"on-photo-btn rounded-input px-16 py-8 text-xs font-semibold uppercase" + (filter === k ? " is-on" : "")}>
            {k === "all" ? `All (${reports.length})`
              : k === "draft" ? `Drafts (${reports.filter(r => r.status === "draft").length})`
              : `Signed off (${reports.filter(r => r.status === "complete").length})`}
          </button>
        ))}
      </div>

      <div className={"mt-16 " + card} style={cardStyle}>
        {!ready ? (
          <p className="pane-note text-xs">Loading…</p>
        ) : !rows.length ? (
          <p className="pane-note text-xs">No reports in this state yet.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr style={{ color: "var(--ink-soft)" }}>
                <th className="p-12">Trainee</th>
                <th className="p-12">Period</th>
                <th className="p-12">Tasks</th>
                <th className="p-12">On time</th>
                <th className="p-12">Grade</th>
                <th className="p-12">Signatures</th>
                <th className="p-12">Status</th>
                <th className="p-12" />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                  <td className="p-12">
                    <p className="font-bold" style={{ color: "var(--ink)" }}>{r.full_name}</p>
                    <p style={{ color: "var(--ink-soft)" }}>
                      {r.department} · {EMPLOYMENT_LABELS[r.employment_type] ?? r.employment_type}
                    </p>
                  </td>
                  <td className="p-12" style={{ color: "var(--ink)" }}>
                    {r.period_start ?? "—"} → {r.period_end ?? "—"}
                  </td>
                  <td className="p-12" style={{ color: "var(--ink)" }}>{r.tasks_done} / {r.tasks_total}</td>
                  <td className="p-12" style={{ color: "var(--ink)" }}>
                    {r.tasks_done ? Math.round((r.tasks_on_time / r.tasks_done) * 100) + "%" : "—"}
                  </td>
                  <td className="p-12" style={{ color: "var(--ink)" }}>{r.rating ?? "—"}</td>
                  <td className="p-12" style={{ color: r.signed_count === 3 ? "var(--success)" : "var(--warning)" }}>
                    {r.signed_count} / 3
                  </td>
                  <td className="p-12">
                    <span className="badge-plain rounded-input px-8 py-4 text-[10px] font-bold uppercase"
                      style={{ color: r.status === "complete" ? "var(--success-on-photo, var(--success))" : "var(--warning)" }}>
                      {r.status === "complete" ? "Signed off" : "Draft"}
                    </span>
                  </td>
                  <td className="p-12 text-right">
                    <Link href={`/app/office/reports/${r.id}`}
                      className="on-photo-btn rounded-input px-12 py-6 text-[11px]">
                      Open the page
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="pane-note mt-16 text-xs">
          A signed page is paper: it cannot be edited, deleted or unsigned. Reopen it from the report
          itself when a signature has to be corrected.
        </p>
      </div>

      <p className="pane-note mt-24 text-xs">
        People and their entry forms live in{" "}
        <Link href="/app/office/employees" className="underline">Employees</Link>; the steps a trainee
        works through live in{" "}
        <Link href="/app/office/procedures" className="underline">Procedural flows</Link>.
      </p>
    </div>
  );
}
