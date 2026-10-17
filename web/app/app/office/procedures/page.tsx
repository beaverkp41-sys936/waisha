"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface ProcStep {
  seq: number; name: string; instructions: string | null;
  checklist: string[]; required_documents: string[]; is_final: boolean;
}
interface Procedure {
  id: string; name: string; description: string | null; scope: string;
  is_active: boolean; is_system: boolean; steps: ProcStep[]; open_tasks: number;
}
interface OfficeTask {
  id: string; title: string; employee_name: string | null; status: string;
  due_date: string | null; file_number: string | null;
}
interface FlowCheck {
  id: string; seq: number; label: string; requires_document: boolean;
  doc_kind: string | null; ticked_at: string | null; evidence: string | null;
}
interface FlowStep {
  id: string; seq: number; name: string; instructions: string | null; is_final: boolean;
  status: string; blocked_reason: string | null;
  started_at: string | null; completed_at: string | null; checks: FlowCheck[];
}
interface TaskFlow {
  procedureId: string | null; procedureName: string | null;
  steps: FlowStep[]; stepsTotal: number; stepsDone: number;
  checksTotal: number; checksOpen: number; currentSeq: number | null;
}

const STEP_STATUS_LABELS: Record<string, string> = {
  not_started: "Not started", in_progress: "In progress", blocked: "Blocked", done: "Done"
};
const STEP_STATUS_COLORS: Record<string, string> = {
  not_started: "var(--ink-soft)", in_progress: "var(--brand)",
  blocked: "var(--danger)", done: "var(--success)"
};

const EMPTY_STEP: ProcStep = {
  seq: 1, name: "", instructions: "", checklist: [], required_documents: [], is_final: false
};

export default function OfficeProceduresPage() {
  const [tab, setTab] = useState<"library" | "flows">("library");
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [tasks, setTasks] = useState<OfficeTask[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; description: string; scope: string; steps: ProcStep[] }>({
    name: "", description: "", scope: "office", steps: [{ ...EMPTY_STEP }]
  });

  const [taskId, setTaskId] = useState<string>("");
  const [flow, setFlow] = useState<TaskFlow | null>(null);
  const [attachTo, setAttachTo] = useState<string>("");
  /** The step currently showing its "what is holding this?" field. A native
   * prompt() blocks the whole tab, so the reason is typed in place instead. */
  const [blockFor, setBlockFor] = useState<string | null>(null);
  const [blockReason, setBlockReason] = useState("");

  const load = useCallback(async () => {
    const [p, t] = await Promise.all([apiFetch("/procedures"), apiFetch("/office-tasks")]);
    if (p.ok) setProcedures(await p.json());
    if (t.ok) setTasks(await t.json());
    if (!p.ok && !t.ok) setError(errorText(null, "Could not load the procedure library."));
    setReady(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openTasks = useMemo(
    () => tasks.filter(t => t.status === "pending" || t.status === "in_progress"),
    [tasks]);

  async function readFlow(id: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/office-tasks/${id}/flow`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Could not open the flow.")); setFlow(null); return; }
    setFlow(j as TaskFlow);
  }

  // A task with no flow yet still answers — stepsTotal 0 — so the panel can
  // offer to attach one instead of failing.
  useEffect(() => { if (taskId) readFlow(taskId); else setFlow(null); }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  function startNew() {
    setEditingId(null);
    setDraft({ name: "", description: "", scope: "office", steps: [{ ...EMPTY_STEP, seq: 1 }] });
    setError(null); setNotice(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startEdit(p: Procedure) {
    setEditingId(p.id);
    setDraft({
      name: p.name, description: p.description ?? "", scope: p.scope,
      steps: (p.steps ?? []).map((s, i) => ({ ...s, seq: i + 1, checklist: s.checklist ?? [], required_documents: s.required_documents ?? [] }))
    });
    setError(null); setNotice(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setStep(i: number, patch: Partial<ProcStep>) {
    setDraft(d => ({ ...d, steps: d.steps.map((s, n) => (n === i ? { ...s, ...patch } : s)) }));
  }

  async function submit() {
    setError(null); setNotice(null);
    if (!draft.name.trim()) { setError("Give the procedure a name."); return; }
    if (draft.steps.some(s => !s.name.trim())) { setError("Every step needs a name."); return; }
    setBusy(true);
    try {
      const body = {
        name: draft.name.trim(), description: draft.description.trim() || null,
        scope: draft.scope,
        steps: draft.steps.map((s, i) => ({
          seq: i + 1, name: s.name.trim(), instructions: s.instructions?.trim() || null,
          checklist: (s.checklist ?? []).map(x => x.trim()).filter(Boolean),
          requiredDocuments: (s.required_documents ?? []).map(x => x.trim()).filter(Boolean),
          isFinal: !!s.is_final
        }))
      };
      const res = await apiFetch(editingId ? `/procedures/${editingId}` : "/procedures", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the procedure.")); return; }
      setNotice(editingId ? "Procedure updated." : "Procedure added to the library.");
      setEditingId(null); setDraft({ name: "", description: "", scope: "office", steps: [{ ...EMPTY_STEP }] });
      await load();
    } finally { setBusy(false); }
  }

  async function duplicate(p: Procedure) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/procedures/${p.id}/duplicate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not copy the procedure.")); return; }
      setNotice(`"${p.name}" copied into your library — edit the copy freely.`);
      await load();
    } finally { setBusy(false); }
  }

  async function retire(p: Procedure) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/procedures/${p.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not retire the procedure.")); return; }
      setNotice(`${p.name} retired. Tasks already working it keep their flow.`);
      await load();
    } finally { setBusy(false); }
  }

  async function attachFlow() {
    if (!taskId || !attachTo) { setError("Pick a task and a procedure."); return; }
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/office-tasks/${taskId}/flow`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ procedureId: attachTo })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not lay the flow under the task.")); return; }
      setNotice("Flow laid under the task. Later edits to the procedure cannot reach this copy.");
      await readFlow(taskId);
      await load();
    } finally { setBusy(false); }
  }

  async function tick(ck: FlowCheck, ticked: boolean, evidence?: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/task-step-checks/${ck.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticked, evidence: evidence ?? null })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not record the tick.")); return; }
      await readFlow(taskId);
    } finally { setBusy(false); }
  }

  async function removeCheck(ck: FlowCheck) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/task-step-checks/${ck.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not remove the item.")); return; }
      await readFlow(taskId);
    } finally { setBusy(false); }
  }

  async function addCheck(step: FlowStep, label: string) {
    if (!label.trim()) return;
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/task-steps/${step.id}/checks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), requiresDocument: false })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not add the item.")); return; }
      await readFlow(taskId);
    } finally { setBusy(false); }
  }

  async function setStepStatus(step: FlowStep, status: string, blockedReason?: string | null) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/task-steps/${step.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...(blockedReason !== undefined ? { blockedReason } : {}) })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not move the step.")); return; }
      await readFlow(taskId);
    } finally { setBusy(false); }
  }

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
      <h1 className="mt-6 text-2xl font-bold">Procedural flows</h1>
      <p className="mt-6 text-sm" style={{ color: "var(--ink-soft)" }}>
        How work is meant to be done here — a library of procedures, and the checklist each task
        actually works through. A step cannot close while its list is open.
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

      <div className="mt-24 flex gap-8">
        {(["library", "flows"] as const).map(k => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={"on-photo-btn rounded-input px-16 py-8 text-xs font-semibold" + (tab === k ? " is-on" : "")}>
            {k === "library" ? "Procedure library" : "Task flows"}
          </button>
        ))}
      </div>

      {/* ================= Library ================= */}
      {tab === "library" && (
        <>
          <div className="mt-24" style={cardStyle}>
            <div className={card}>
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                {editingId ? "Edit the house procedure" : "Write a new procedure"}
              </h2>
              <div className="mt-16 grid grid-cols-1 gap-16 md:grid-cols-3">
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Name</span>
                  <input className={inputCls} style={inputStyle} value={draft.name}
                    onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={160} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>What it is for</span>
                  <input className={inputCls} style={inputStyle} value={draft.description}
                    onChange={e => setDraft({ ...draft, description: e.target.value })} maxLength={500} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Applies to</span>
                  <select className={inputCls} style={inputStyle} value={draft.scope}
                    onChange={e => setDraft({ ...draft, scope: e.target.value })}>
                    <option value="office">Office task</option>
                    <option value="cargo">Cargo file</option>
                  </select>
                </label>
              </div>

              <ol className="mt-20 space-y-16">
                {draft.steps.map((s, i) => (
                  <li key={i} className="rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
                    <div className="flex items-center gap-12">
                      <span className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--gold-green)" }}>
                        Step {i + 1}
                      </span>
                      <input className={inputCls} style={inputStyle} value={s.name} placeholder="Step name"
                        onChange={e => setStep(i, { name: e.target.value })} maxLength={160} />
                      <label className="flex items-center gap-6 whitespace-nowrap text-[11px] font-semibold"
                        style={{ color: "var(--ink-soft)" }}>
                        <input type="checkbox" checked={!!s.is_final}
                          onChange={e => setDraft(d => ({
                            ...d, steps: d.steps.map((x, n) => ({ ...x, is_final: n === i ? e.target.checked : false }))
                          }))} />
                        Final sign-off
                      </label>
                      <button type="button" className="on-photo-btn rounded-input px-10 py-6 text-[11px]"
                        onClick={() => setDraft(d => ({ ...d, steps: d.steps.filter((_, n) => n !== i).map((x, n) => ({ ...x, seq: n + 1 })) }))}>
                        Remove
                      </button>
                    </div>
                    <input className={inputCls + " mt-10"} style={inputStyle} value={s.instructions ?? ""}
                      placeholder="What the person doing this step must actually do"
                      onChange={e => setStep(i, { instructions: e.target.value })} maxLength={1000} />
                    <div className="mt-10 grid grid-cols-1 gap-12 md:grid-cols-2">
                      <label className="block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                          Mandatory checklist (one per line — all must be ticked)
                        </span>
                        <textarea className={inputCls + " min-h-[92px]"} style={inputStyle}
                          value={(s.checklist ?? []).join("\n")}
                          onChange={e => setStep(i, { checklist: e.target.value.split("\n").filter(x => x.trim()) })} />
                      </label>
                      <label className="block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                          Documents this step needs (snake_case kinds, one per line)
                        </span>
                        <textarea className={inputCls + " min-h-[92px]"} style={inputStyle}
                          value={(s.required_documents ?? []).join("\n")}
                          onChange={e => setStep(i, { required_documents: e.target.value.split("\n").filter(x => x.trim()) })} />
                      </label>
                    </div>
                  </li>
                ))}
              </ol>

              <div className="mt-20 flex flex-wrap gap-12">
                <button type="button" className="on-photo-btn rounded-input px-14 py-8 text-xs font-semibold"
                  onClick={() => setDraft(d => ({ ...d, steps: [...d.steps, { ...EMPTY_STEP, seq: d.steps.length + 1 }] }))}>
                  Add a step
                </button>
                <button type="button" disabled={busy} onClick={submit}
                  className="rounded-input px-20 py-8 text-xs font-bold"
                  style={{ background: "var(--brand)", color: "var(--on-solid)", opacity: busy ? 0.6 : 1 }}>
                  {editingId ? "Save procedure" : "Create procedure"}
                </button>
                {editingId && (
                  <button type="button" className="on-photo-btn rounded-input px-14 py-8 text-xs"
                    onClick={() => { setEditingId(null); startNew(); }}>
                    Cancel the edit
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className={"mt-24 " + card} style={cardStyle}>
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              The library
            </h2>
            {!ready ? (
              <p className="pane-note mt-12 text-xs">Loading…</p>
            ) : !procedures.length ? (
              <p className="pane-note mt-12 text-xs">No procedures yet.</p>
            ) : (
              <table className="mt-16 w-full text-left text-xs">
                <thead>
                  <tr style={{ color: "var(--ink-soft)" }}>
                    <th className="p-12">Procedure</th>
                    <th className="p-12">Steps</th>
                    <th className="p-12">Open tasks</th>
                    <th className="p-12">Source</th>
                    <th className="p-12" />
                  </tr>
                </thead>
                <tbody>
                  {procedures.map(p => (
                    <tr key={p.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                      <td className="p-12">
                        <p className="font-bold" style={{ color: "var(--ink)" }}>{p.name}</p>
                        <p className="mt-4" style={{ color: "var(--ink-soft)" }}>{p.description}</p>
                      </td>
                      <td className="p-12" style={{ color: "var(--ink)" }}>
                        {p.steps.length}
                        <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          {p.steps.reduce((n, s) => n + (s.checklist?.length ?? 0), 0)} checklist items
                        </span>
                      </td>
                      <td className="p-12" style={{ color: "var(--ink)" }}>{p.open_tasks}</td>
                      <td className="p-12">
                        <span className="badge-plain rounded-input px-8 py-4 text-[10px] font-bold uppercase"
                          style={{ color: p.is_system ? "var(--gold-on-photo)" : "var(--ink)" }}>
                          {p.is_system ? "System default" : "This house"}
                        </span>
                      </td>
                      <td className="p-12 text-right whitespace-nowrap">
                        {p.is_system ? (
                          <button type="button" disabled={busy} className="on-photo-btn rounded-input px-10 py-6 text-[11px]"
                            onClick={() => duplicate(p)}>
                            Copy into our library
                          </button>
                        ) : (
                          <>
                            <button type="button" className="on-photo-btn rounded-input px-10 py-6 text-[11px]"
                              onClick={() => startEdit(p)}>Edit</button>
                            <button type="button" disabled={busy} className="on-photo-btn rounded-input px-10 py-6 text-[11px]"
                              onClick={() => retire(p)}>Retire</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="pane-note mt-16 text-xs">
              System defaults are shared and read-only below your tenant line. Copy one, then bend the
              copy to how your office works — a task keeps the flow it was given, not the one you edit
              tomorrow.
            </p>
          </div>
        </>
      )}

      {/* ================= Task flows ================= */}
      {tab === "flows" && (
        <div className="mt-24 grid grid-cols-1 gap-24 lg:grid-cols-[320px_1fr]">
          <div className={card} style={cardStyle}>
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
              Pick a task
            </h2>
            <select className={inputCls + " mt-12"} style={inputStyle} value={taskId}
              onChange={e => setTaskId(e.target.value)}>
              <option value="">— choose —</option>
              {openTasks.map(t => (
                <option key={t.id} value={t.id}>{t.title} · {t.employee_name ?? "unassigned"}</option>
              ))}
            </select>
            <p className="pane-note mt-12 text-xs">
              Assignments come from{" "}
              <Link href="/app/office/employees" className="underline">Employees</Link>.
            </p>
            {flow && flow.stepsTotal === 0 && (
              <div className="mt-16">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Lay a flow under it</span>
                <select className={inputCls} style={inputStyle} value={attachTo}
                  onChange={e => setAttachTo(e.target.value)}>
                  <option value="">— procedure —</option>
                  {procedures.filter(p => p.is_active).map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <button type="button" disabled={busy || !attachTo} onClick={attachFlow}
                  className="mt-12 w-full rounded-input px-14 py-8 text-xs font-bold"
                  style={{ background: "var(--brand)", color: "var(--on-solid)", opacity: busy || !attachTo ? 0.6 : 1 }}>
                  Attach the flow
                </button>
              </div>
            )}
          </div>

          <div>
            {!taskId ? (
              <div className={card} style={cardStyle}>
                <p className="pane-note text-xs">Choose a task to see the steps it is working through.</p>
              </div>
            ) : !flow ? (
              <div className={card} style={cardStyle}><p className="pane-note text-xs">Loading…</p></div>
            ) : flow.stepsTotal === 0 ? (
              <div className={card} style={cardStyle}>
                <p className="pane-note text-xs">This task carries no flow yet — pick one on the left.</p>
              </div>
            ) : (
              <>
                <div className={card} style={cardStyle}>
                  <div className="flex flex-wrap items-center justify-between gap-12">
                    <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                      {flow.procedureName}
                    </h2>
                    <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                      {flow.stepsDone} of {flow.stepsTotal} steps · {flow.checksTotal - flow.checksOpen}
                      /{flow.checksTotal} items ticked
                    </p>
                  </div>
                  {/* Initiation → Final Sign-off, in that order, always. */}
                  <div className="mt-16 flex items-center gap-8 overflow-x-auto pb-8">
                    {flow.steps.map((s, i) => (
                      <div key={s.id} className="flex items-center gap-8">
                        <span className="badge-plain whitespace-nowrap rounded-input px-10 py-6 text-[10px] font-bold uppercase"
                          style={{ color: STEP_STATUS_COLORS[s.status] }}>
                          {s.seq}. {s.name}
                        </span>
                        {i < flow.steps.length - 1 && (
                          <span aria-hidden style={{ color: "var(--ink-soft)" }}>→</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <ol className="mt-20 space-y-20">
                  {flow.steps.map((s, i) => {
                    const open = s.checks.filter(c => !c.ticked_at).length;
                    const earlier = flow.steps.slice(0, i).some(x => x.status !== "done");
                    return (
                      <li key={s.id} className={card} style={cardStyle}>
                        <div className="flex flex-wrap items-start justify-between gap-12">
                          <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.14em]"
                              style={{ color: STEP_STATUS_COLORS[s.status] }}>
                              Step {s.seq} · {STEP_STATUS_LABELS[s.status]}
                              {s.is_final ? " · final sign-off" : ""}
                            </p>
                            <h3 className="mt-4 text-sm font-bold" style={{ color: "var(--ink)" }}>{s.name}</h3>
                            <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{s.instructions}</p>
                          </div>
                          <div className="flex flex-wrap gap-8">
                            {s.status !== "done" && (
                              <>
                                {s.status === "not_started" && (
                                  <button type="button" className="on-photo-btn rounded-input px-10 py-6 text-[11px]"
                                    onClick={() => setStepStatus(s, "in_progress")}>Start</button>
                                )}
                                <button type="button" disabled={open > 0 || earlier || s.status === "blocked"}
                                  className="on-photo-btn rounded-input px-10 py-6 text-[11px]"
                                  onClick={() => setStepStatus(s, "done")}>
                                  Close step
                                </button>
                                <button type="button" className="on-photo-btn rounded-input px-10 py-6 text-[11px]"
                                  onClick={() => { setBlockFor(blockFor === s.id ? null : s.id); setBlockReason(""); }}>
                                  {blockFor === s.id ? "Never mind" : "Block"}
                                </button>
                              </>
                            )}
                            {s.status === "blocked" && (
                              <button type="button" className="on-photo-btn rounded-input px-10 py-6 text-[11px]"
                                onClick={() => setStepStatus(s, "in_progress", null)}>
                                Unblock
                              </button>
                            )}
                            {s.status === "done" && (
                              <button type="button" className="on-photo-btn rounded-input px-10 py-6 text-[11px]"
                                onClick={() => setStepStatus(s, "in_progress")}>
                                Reopen
                              </button>
                            )}
                          </div>
                        </div>

                        {blockFor === s.id && (
                          <form className="no-print mt-12 flex flex-wrap items-center gap-8"
                            onSubmit={e => {
                              e.preventDefault();
                              const reason = blockReason.trim();
                              if (!reason) return;
                              setBlockFor(null); setBlockReason("");
                              void setStepStatus(s, "blocked", reason);
                            }}>
                            <label className="min-w-[220px] flex-1">
                              <span className="sr-only">What is holding step {s.seq}?</span>
                              <input autoFocus value={blockReason} maxLength={300}
                                onChange={e => setBlockReason(e.target.value)}
                                placeholder="What is holding this step?" className={inputCls} style={inputStyle} />
                            </label>
                            <button type="submit" disabled={busy || !blockReason.trim()}
                              className="waisha-btn rounded-input px-12 py-6 text-[11px] font-semibold">
                              Hold the step
                            </button>
                          </form>
                        )}

                        {s.blocked_reason && (
                          <p role="status" className="mt-12 text-xs" style={{ color: "var(--danger)" }}>
                            Held by: {s.blocked_reason}
                          </p>
                        )}

                        <ul className="mt-16 space-y-8">
                          {s.checks.map(ck => (
                            <li key={ck.id} className="flex items-start gap-10 text-xs">
                              <input type="checkbox" checked={!!ck.ticked_at} disabled={busy}
                                onChange={e => tick(ck, e.target.checked)} className="mt-4" />
                              <span className="flex-1" style={{ color: ck.ticked_at ? "var(--ink-soft)" : "var(--ink)" }}>
                                {ck.label}
                                {ck.requires_document && (
                                  <span className="badge-plain ml-8 rounded-input px-6 py-2 text-[10px] uppercase"
                                    style={{ color: "var(--gold-on-photo)" }}>
                                    needs {ck.doc_kind}
                                  </span>
                                )}
                                {ck.ticked_at && (
                                  <span className="mt-2 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                                    {new Date(ck.ticked_at).toLocaleString()}
                                    {ck.evidence ? ` — ${ck.evidence}` : ""}
                                  </span>
                                )}
                              </span>
                              {!ck.ticked_at && (
                                <button type="button" className="on-photo-btn px-8 py-4 text-[10px]"
                                  onClick={() => removeCheck(ck)}>Remove</button>
                              )}
                            </li>
                          ))}
                          {!s.checks.length && (
                            <li className="pane-note text-xs">No mandatory items on this step.</li>
                          )}
                        </ul>

                        <AddItem onAdd={label => addCheck(s, label)} disabled={busy} />

                        {s.status !== "done" && open > 0 && (
                          <p className="mt-12 text-[11px]" style={{ color: "var(--warning)" }}>
                            {open} item{open === 1 ? "" : "s"} still open — the database will not let this
                            step close until every one is ticked.
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AddItem({ onAdd, disabled }: { onAdd: (label: string) => void; disabled: boolean }) {
  const [value, setValue] = useState("");
  return (
    <form className="mt-12 flex gap-8"
      onSubmit={e => { e.preventDefault(); onAdd(value); setValue(""); }}>
      <input className="w-full rounded-input border px-12 py-8 text-xs"
        style={{ borderColor: "var(--line)", background: "var(--milk)" }}
        value={value} placeholder="Add an item this step must have ticked" maxLength={120}
        onChange={e => setValue(e.target.value)} />
      <button type="submit" disabled={disabled || !value.trim()}
        className="on-photo-btn whitespace-nowrap rounded-input px-12 py-8 text-[11px]">
        Add item
      </button>
    </form>
  );
}
