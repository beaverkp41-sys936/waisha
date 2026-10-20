"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiFetch } from "../../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  // Domain details (e.g. { missingDocument }) carry no field/message — drop
  // entries with nothing to say instead of rendering an empty "( )".
  const parts = Array.isArray(d)
    ? d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).filter(Boolean)
    : [];
  return (json?.error?.message ?? fallback) + (parts.length ? ` (${parts.join("; ")})` : "");
}

const DOC_KINDS = ["bill_of_lading", "packing_list", "invoice", "arrival_notice", "delivery_order",
  "declaration", "assessment", "receipt", "inspection", "release_note", "permit", "pod",
  "handover", "contract", "delivery_note", "other"];
const DOC_LABEL: Record<string, string> = {
  bill_of_lading: "Bill of Lading", packing_list: "Packing list", invoice: "Invoice",
  arrival_notice: "Arrival notice", delivery_order: "Delivery order", declaration: "Declaration",
  assessment: "Customs assessment", receipt: "Receipt", inspection: "Inspection report",
  release_note: "Release note", permit: "Permit", pod: "Proof of delivery", handover: "Handover note",
  contract: "Contract", delivery_note: "Delivery note", other: "Other"
};
const DOC_EDGE: Record<string, string> = {
  pending: "var(--ink-soft)", received: "var(--gold)", verified: "var(--success)", rejected: "var(--danger)"
};
const STAGE_EDGE: Record<string, string> = {
  not_started: "var(--ink-soft)", in_progress: "var(--gold)", blocked: "var(--danger)", done: "var(--success)"
};
const STAGE_LABEL: Record<string, string> = {
  not_started: "not started", in_progress: "in progress", blocked: "blocked", done: "done"
};

const card = "rounded-card border bg-surface p-24";
const cardStyle = { borderColor: "var(--line)" };
const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const headingCls = "text-sm font-bold uppercase tracking-[0.14em]";
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : "—");
const fmtWhen = (v: string) => new Date(v).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

// Mirrors the vehicle types the API accepts on a transport request.
const VEHICLES = [
  { key: "truck_head", label: "Truck head" }, { key: "trailer", label: "Trailer" },
  { key: "tanker", label: "Tanker" }, { key: "flatbed", label: "Flatbed" },
  { key: "tipper", label: "Tipper" }, { key: "reefer", label: "Reefer" },
  { key: "box_truck", label: "Box truck" }, { key: "van", label: "Van" },
  { key: "pickup", label: "Pickup" }, { key: "lowbed", label: "Lowbed" }
];
const CONTAINERS = [
  { key: "20ft", label: "20 ft" }, { key: "40ft", label: "40 ft" },
  { key: "loose_cargo", label: "Loose cargo" }, { key: "car", label: "Vehicle" }
];
const vecLabel = (k: string) => VEHICLES.find(v => v.key === k)?.label ?? k;

interface Stage {
  id: string; stage_key: string; name: string; position: number; status: string;
  blocked_reason: string | null; required_documents: string[]; started_at: string | null;
  completed_at: string | null; open_tasks: number; docs_in_stage: number;
}
interface Job {
  id: string; shipment_id: string; file_number: string; shipment_type: string;
  consignee_name: string; consignor_name: string; eta: string | null;
  record_kind: string; status: string; transport_needed: boolean; transport_consent: string;
  free_days: number | null; free_days_start: string | null; closed_at: string | null;
  notes: string | null; shipment_status: string; discharge_date: string | null;
  stages: Stage[];
  tasks: any[]; documents: any[]; handovers: any[]; activity: any[]; staff: any[];
}

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openStage, setOpenStage] = useState<string | null>(null);

  const [task, setTask] = useState({ title: "", assignedTo: "", dueDate: "", stageKey: "" });
  const [doc, setDoc] = useState({
    title: "", kind: "invoice", direction: "received", fromParty: "", toParty: "",
    docDate: "", stageKey: ""
  });
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [decision, setDecision] = useState({
    recordKind: "live", transportNeeded: "no", consent: "not_asked",
    handoverName: "", handoverId: "", handoverMethod: "signature", notes: ""
  });
  const [freeDays, setFreeDays] = useState({ days: "", start: "" });
  const [treq, setTreq] = useState<any | null>(null);
  const [prev, setPrev] = useState<any | null>(null);
  const [pub, setPub] = useState<any | null>(null);
  const [safe, setSafe] = useState(false);
  const [flags, setFlags] = useState<string[] | null>(null);
  const [forced, setForced] = useState(false);

  const loadRequest = useCallback(async () => {
    const res = await apiFetch(`/transport-requests?jobId=${id}`);
    const rows = await res.json().catch(() => []);
    const live = Array.isArray(rows) ? rows.find(r => r.status !== "cancelled") ?? null : null;
    setTreq(live);
  }, [id]);

  useEffect(() => { loadRequest(); }, [loadRequest]);

  async function openPreview() {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/jobs/${id}/transport-preview`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Could not build the preview.")); return; }
      const f = j.fields ?? {};
      setPrev(j);
      setSafe(false); setFlags(null); setForced(false);
      setPub({
        cargoLabel: f.cargoLabel ?? "", pickupText: f.pickupText ?? "", destText: f.destText ?? "",
        viaLabel: f.viaLabel ?? "", requiredDate: f.requiredDate ?? "",
        contactName: f.contactName ?? "", contactChannel: f.contactChannel ?? "",
        contactUserId: f.contactUserId ?? "", publicNote: f.publicNote ?? "",
        routeId: "", containerType: f.containerType ?? "",
        containerCount: f.containerCount ?? "", weightTonnes: f.weightTonnes ?? "", cbm: f.cbm ?? "",
        vehicleTypes: f.vehicleTypes ?? []
      });
    } finally { setBusy(false); }
  }

  async function publishTransport(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const num = (v: any) => (v === "" || v === null || v === undefined ? null : Number(v));
    setBusy(true); setError(null); setFlags(null);
    try {
      const res = await apiFetch(`/jobs/${id}/transport-request`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cargoLabel: pub.cargoLabel, pickupText: pub.pickupText, destText: pub.destText,
          viaLabel: pub.viaLabel || null, requiredDate: pub.requiredDate,
          contactName: pub.contactName, contactChannel: pub.contactChannel,
          contactUserId: pub.contactUserId || null, publicNote: pub.publicNote || null,
          routeId: pub.routeId || null, containerType: pub.containerType || null,
          containerCount: num(pub.containerCount), weightTonnes: num(pub.weightTonnes), cbm: num(pub.cbm),
          vehicleTypes: pub.vehicleTypes, acknowledgeWarnings: forced
        })
      });
      const j = await res.json().catch(() => ({}));
      // The server re-scans the text as submitted. Only its publicText flags are a
      // re-confirmable warning — every other 409 (consent, duplicate) is a hard stop.
      const flagged = res.status === 409
        ? (j?.error?.details ?? []).filter((d: any) => d.field === "publicText").map((d: any) => d.message)
        : [];
      if (flagged.length) { setFlags(flagged); setForced(false); return; }
      if (!res.ok) { setError(errorText(j, "Could not publish.")); return; }
      setNotice("Published — transporters can now see this request.");
      setForced(false); setFlags(null); setPrev(null); setPub(null);
      await loadRequest();
    } finally { setBusy(false); }
  }

  function cancelTransport() {
    if (!treq) return;
    if (!window.confirm("Withdraw this request? Transporters will no longer see it.")) return;
    send(`/transport-requests/${treq.id}/cancel`, "POST", undefined, "Request withdrawn.")
      .then(ok => { if (ok) { loadRequest(); setPrev(null); } });
  }

  const load = useCallback(async () => {
    const res = await apiFetch(`/jobs/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Job not found.")); return; }
    setJob(j);
    setFreeDays(f => f.days || f.start ? f : {
      days: j.free_days ? String(j.free_days) : "", start: j.free_days_start ?? ""
    });
    setDecision(d => d.recordKind === "live" && d.consent === "not_asked"
      ? { ...d, recordKind: j.record_kind, consent: j.transport_consent ?? "not_asked",
          transportNeeded: j.transport_needed ? "yes" : "no" } : d);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function send(path: string, method: string, body?: any, ok?: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(path, {
        method, headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed.")); return false; }
      if (ok) setNotice(ok);
      await load();
      return true;
    } finally { setBusy(false); }
  }

  function setStageStatus(stage: Stage, status: string, blockedReason?: string) {
    return send(`/jobs/${id}/stages/${stage.id}/status`, "PUT",
      { status, blockedReason: blockedReason ?? null },
      `${stage.name} — ${STAGE_LABEL[status]}.`);
  }

  function blockStage(stage: Stage) {
    const reason = window.prompt(`Why is "${stage.name}" blocked?`);
    if (!reason) return;
    setStageStatus(stage, "blocked", reason);
  }

  function addTask(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    send(`/jobs/${id}/tasks`, "POST", {
      title: task.title,
      stageKey: task.stageKey || null,
      assignedTo: task.assignedTo || null,
      dueDate: task.dueDate || null
    }, "Task added to the checklist.").then(ok => ok && setTask({ title: "", assignedTo: "", dueDate: "", stageKey: "" }));
  }

  async function addDocument(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null); setNotice(null);
    let storedId: string | null = null;
    if (pendingFile) {
      setBusy(true);
      try {
        const fd = new FormData();
        fd.append("entityType", "shipment");
        fd.append("entityId", job!.shipment_id);
        fd.append("kind", doc.kind);
        fd.append("file", pendingFile);
        const res = await apiFetch("/documents", { method: "POST", body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { setError(errorText(j, "Upload failed.")); return; }
        storedId = j.id ?? null;
      } finally { setBusy(false); }
      setPendingFile(null);
    }
    await send(`/jobs/${id}/documents`, "POST", {
      title: doc.title, kind: doc.kind, direction: doc.direction,
      fromParty: doc.fromParty || null, toParty: doc.toParty || null,
      docDate: doc.docDate || null, stageKey: doc.stageKey || null,
      documentId: storedId
    }, "Document entered in the register.");
    setDoc({ ...doc, title: "", fromParty: "", toParty: "", docDate: "" });
  }

  function setDocStatus(docId: string, status: string) {
    let reason: string | null = null;
    if (status === "rejected") {
      reason = window.prompt("Why is this document rejected?");
      if (!reason) return;
    }
    send(`/jobs/${id}/documents/${docId}/status`, "PUT", { status, reason },
      `Document marked ${status}.`);
  }

  function saveDecision(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const wantsTransport = decision.transportNeeded === "yes";
    const body: any = {
      recordKind: decision.recordKind,
      transportNeeded: decision.recordKind === "archive" ? false : wantsTransport,
      consent: decision.recordKind === "archive" ? null
        : wantsTransport ? decision.consent : null,
      notes: decision.notes || null
    };
    if (decision.recordKind === "live" && !wantsTransport && decision.handoverName) {
      body.handover = {
        receivedByName: decision.handoverName,
        receivedByIdNumber: decision.handoverId || null,
        method: decision.handoverMethod
      };
    }
    send(`/jobs/${id}/decision`, "POST", body, "Stage 9 decision recorded.");
  }

  function saveFreeDays() {
    return send(`/jobs/${id}`, "PATCH", {
      freeDays: freeDays.days === "" ? null : Number(freeDays.days),
      freeDaysStart: freeDays.start || null
    }, "Free-days clock saved.");
  }

  if (error && !job) {
    return (
      <div className="mx-auto max-w-[1100px] px-16 py-32">
        <div role="alert" className="pane-note px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error} <Link href="/app/cfa/jobs" className="underline">Back to the pipeline</Link>
        </div>
      </div>
    );
  }
  if (!job) {
    return <div className="pane-note mx-auto max-w-[1100px] px-16 py-32 text-sm">Loading job…</div>;
  }

  const workable = job.status === "open";
  const verifiedKinds = new Set(job.documents.filter(d => d.status === "verified").map(d => d.kind));
  const current = job.stages.find(s => s.status !== "done");
  const stageTasks = (stageId: string) => job.tasks.filter(t => t.stage_id === stageId);

  return (
    <div className="mx-auto max-w-[1100px] px-16 py-32">
      <div className="flex flex-wrap items-center justify-between gap-12">
        <Link href="/app/cfa/jobs" className="pane-note text-xs underline">← Job pipeline</Link>
        <div className="flex flex-wrap gap-8">
          <Link href={`/app/cfa/cargo/${job.shipment_id}`}
            className="on-photo-btn px-16 py-8 text-xs font-semibold">Cargo file</Link>
          <Link href={`/app/cfa/messages?file=${job.shipment_id}`}
            className="on-photo-btn px-16 py-8 text-xs font-semibold">Messages</Link>
          {workable && (
            <button type="button" disabled={busy} onClick={() => send(`/jobs/${id}/close`, "POST", {}, "Job closed and billing complete.")}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-60">
              Close job
            </button>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-16 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>
      )}
      {notice && (
        <div role="status" className="mt-16 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>
      )}

      <header className="mt-24 flex flex-wrap items-start justify-between gap-16">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>{job.file_number}</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            {job.consignee_name} · {job.shipment_type} · ETA {fmtDate(job.eta)}
          </p>
          <p className="pane-note mt-8 text-xs">
            Current stage: <span className="font-semibold">{current ? current.name : "all ten stages done"}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-8">
          <span className="badge-plain px-8 py-4 text-[10px] font-bold uppercase"
            style={{ borderLeft: `4px solid ${job.status === "open" ? "#5fce93" : "rgba(255,255,255,0.6)"}` }}>
            {job.status}
          </span>
          <span className="badge-plain px-8 py-4 text-[10px] font-bold uppercase"
            style={{ borderLeft: `4px solid ${job.record_kind === "archive" ? "rgba(255,255,255,0.6)" : "#c9a84c"}` }}>
            {job.record_kind === "archive" ? "record of past shipment" : "live job"}
          </span>
          {job.transport_needed && (
            <span className="badge-plain px-8 py-4 text-[10px] font-bold uppercase"
              style={{ borderLeft: `4px solid ${job.transport_consent === "granted" ? "#5fce93" : "#e2b45f"}` }}>
              transport · consent {job.transport_consent.replace("_", " ")}
            </span>
          )}
        </div>
      </header>

      {/* ---------- Timeline of the ten stages ---------- */}
      <section className={`${card} mt-24`}>
        <div className="flex flex-wrap items-center justify-between gap-12">
          <h2 className={headingCls} style={{ color: "var(--ink-soft)" }}>Pipeline</h2>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            {job.stages.filter(s => s.status === "done").length}/10 stages done ·{" "}
            {job.tasks.filter(t => t.status === "pending").length} tasks open
          </p>
        </div>
        <ol className="mt-16 space-y-8">
          {job.stages.map(s => {
            const missing = (s.required_documents ?? []).filter(k => !verifiedKinds.has(k));
            const expanded = openStage === s.id;
            return (
              <li key={s.id} className="rounded-input border" style={cardStyle}>
                <div className="flex flex-wrap items-center justify-between gap-12 px-16 py-12">
                  <button type="button" onClick={() => setOpenStage(expanded ? null : s.id)}
                    className="min-w-0 flex-1 text-left">
                    <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                      {s.position}. {s.name}
                    </p>
                    <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      {s.open_tasks} task{s.open_tasks === 1 ? "" : "s"} open · {s.docs_in_stage} document{s.docs_in_stage === 1 ? "" : "s"} registered
                      {missing.length > 0 && (
                        <span style={{ color: "var(--danger)" }}> · needs verified: {missing.map(k => DOC_LABEL[k] ?? k).join(", ")}</span>
                      )}
                    </p>
                    {s.status === "blocked" && s.blocked_reason && (
                      <p className="mt-4 text-[11px]" style={{ color: "var(--danger)" }}>Blocked: {s.blocked_reason}</p>
                    )}
                  </button>
                  <div className="flex shrink-0 items-center gap-8">
                    <span className="px-8 py-4 text-[10px] font-bold uppercase"
                      style={{ borderLeft: `4px solid ${STAGE_EDGE[s.status]}`, color: "var(--ink)" }}>
                      {STAGE_LABEL[s.status]}
                    </span>
                    {workable && s.status !== "done" && (
                      <>
                        {s.status === "not_started" && (
                          <button type="button" disabled={busy} onClick={() => setStageStatus(s, "in_progress")}
                            className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Start</button>
                        )}
                        {s.status !== "blocked" ? (
                          <button type="button" disabled={busy} onClick={() => blockStage(s)}
                            className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                            style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>Block</button>
                        ) : (
                          <button type="button" disabled={busy} onClick={() => setStageStatus(s, "in_progress")}
                            className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Unblock</button>
                        )}
                        <button type="button" disabled={busy} onClick={() => setStageStatus(s, "done")}
                          className="rounded-input border px-12 py-6 text-[11px] font-semibold"
                          style={{ borderColor: "var(--success)", color: "var(--success)" }}>Complete</button>
                      </>
                    )}
                    {workable && s.status === "done" && (
                      <button type="button" disabled={busy} onClick={() => setStageStatus(s, "in_progress")}
                        className="text-[11px] underline" style={{ color: "var(--ink-soft)" }}>Reopen</button>
                    )}
                  </div>
                </div>

                {expanded && (
                  <div className="border-t px-16 py-16" style={{ borderColor: "var(--line)" }}>
                    <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Checklist</p>
                    <div className="space-y-6">
                      {stageTasks(s.id).map(t => {
                        const late = t.status === "pending" && t.due_date && new Date(t.due_date) < new Date();
                        return (
                          <div key={t.id} className="flex items-center justify-between gap-12 text-sm">
                            <span style={{ color: t.status === "done" ? "var(--ink-soft)" : "var(--ink)" }}>
                              <span className={t.status === "done" ? "line-through" : ""}>{t.title}</span>
                              <span className="ml-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>{t.assignee_name}</span>
                              {t.due_date && (
                                <span className="ml-8 text-[11px] tabular-nums" style={{ color: late ? "var(--danger)" : "var(--ink-soft)" }}>
                                  due {fmtDate(t.due_date)}
                                </span>
                              )}
                            </span>
                            <span className="shrink-0">
                              {t.status === "pending" && workable && (
                                <button type="button" className="text-[11px] underline" style={{ color: "var(--success)" }}
                                  onClick={() => send(`/jobs/${id}/tasks/${t.id}`, "PATCH", { status: "done" })}>Mark done</button>
                              )}
                              {t.status !== "pending" && (
                                <span className="text-[10px] font-bold uppercase"
                                  style={{ color: t.status === "done" ? "var(--success)" : "var(--ink-soft)" }}>{t.status}</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                      {stageTasks(s.id).length === 0 && (
                        <p className="text-xs" style={{ color: "var(--ink-soft)" }}>No task in this stage.</p>
                      )}
                    </div>
                    <p className="mt-16 border-t pt-16 text-[11px]" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      Required verified documents: {(s.required_documents ?? []).map(k => DOC_LABEL[k] ?? k).join(", ") || "none"}
                      {s.started_at && ` · started ${fmtWhen(s.started_at)}`}
                      {s.completed_at && ` · completed ${fmtWhen(s.completed_at)}`}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      {/* ---------- Checklist: add a task ---------- */}
      {workable && (
        <section className="mt-24">
          <h2 className={`${headingCls} pane-note`}>Add a task</h2>
          <form onSubmit={addTask} className="mt-16 grid grid-cols-1 gap-12 rounded-card border bg-surface p-24 md:grid-cols-[1fr_160px_150px_170px_120px]">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Task *</span>
              <input required value={task.title} onChange={e => setTask({ ...task, title: e.target.value })}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Stage</span>
              <select value={task.stageKey} onChange={e => setTask({ ...task, stageKey: e.target.value })}
                className={inputCls} style={inputStyle}>
                <option value="">General</option>
                {job.stages.map(s => <option key={s.stage_key} value={s.stage_key}>{s.position}. {s.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Assign to</span>
              <select value={task.assignedTo} onChange={e => setTask({ ...task, assignedTo: e.target.value })}
                className={inputCls} style={inputStyle}>
                <option value="">Unassigned</option>
                {job.staff.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Deadline</span>
              <input type="date" value={task.dueDate} onChange={e => setTask({ ...task, dueDate: e.target.value })}
                className={inputCls} style={inputStyle} />
            </label>
            <button type="submit" disabled={busy}
              className="waisha-btn rounded-input py-8 text-xs font-semibold disabled:opacity-60">Assign</button>
          </form>
        </section>
      )}

      {/* ---------- Document register ---------- */}
      <section className="mt-24">
        <h2 className={`${headingCls} pane-note`}>
          Document register ({job.documents.length})
        </h2>
        {workable && (
          <form onSubmit={addDocument} className="mt-16 grid grid-cols-2 gap-12 rounded-card border bg-surface p-24 md:grid-cols-3">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Title *</span>
              <input required value={doc.title} onChange={e => setDoc({ ...doc, title: e.target.value })}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Type</span>
              <select value={doc.kind} onChange={e => setDoc({ ...doc, kind: e.target.value })}
                className={inputCls} style={inputStyle}>
                {DOC_KINDS.map(k => <option key={k} value={k}>{DOC_LABEL[k] ?? k}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Direction</span>
              <select value={doc.direction} onChange={e => setDoc({ ...doc, direction: e.target.value })}
                className={inputCls} style={inputStyle}>
                <option value="received">Received</option>
                <option value="issued">Issued</option>
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>From</span>
              <input value={doc.fromParty} onChange={e => setDoc({ ...doc, fromParty: e.target.value })}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>To</span>
              <input value={doc.toParty} onChange={e => setDoc({ ...doc, toParty: e.target.value })}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Date on document</span>
              <input type="date" value={doc.docDate} onChange={e => setDoc({ ...doc, docDate: e.target.value })}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Stage</span>
              <select value={doc.stageKey} onChange={e => setDoc({ ...doc, stageKey: e.target.value })}
                className={inputCls} style={inputStyle}>
                <option value="">Unassigned</option>
                {job.stages.map(s => <option key={s.stage_key} value={s.stage_key}>{s.position}. {s.name}</option>)}
              </select>
            </label>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Scan or photo (JPEG, PNG, WebP, PDF — 8MB)
              </span>
              <input type="file" accept=".pdf,image/jpeg,image/png,image/webp" disabled={busy}
                onChange={e => { setPendingFile(e.target.files?.[0] ?? null); e.target.value = ""; }}
                className="text-xs" />
              {pendingFile && (
                <p className="mt-4 text-[11px]" style={{ color: "var(--brand)" }}>
                  {pendingFile.name} uploads with the entry
                </p>
              )}
            </label>
            <button type="submit" disabled={busy}
              className="waisha-btn rounded-input py-8 text-xs font-semibold disabled:opacity-60">Enter in register</button>
          </form>
        )}
        <div className="mt-16 space-y-8">
          {job.documents.map(d => (
            <div key={d.id} className="flex flex-wrap items-center justify-between gap-12 rounded-card border bg-surface px-16 py-12" style={cardStyle}>
              <div className="min-w-0 text-sm">
                <span className="font-semibold" style={{ color: "var(--ink)" }}>{d.title}</span>
                <span className="ml-8 text-[11px] uppercase" style={{ color: "var(--ink-soft)" }}>{DOC_LABEL[d.kind] ?? d.kind}</span>
                <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  {d.direction === "issued" ? "Issued by us" : "Received"}
                  {d.from_party && ` from ${d.from_party}`}{d.to_party && ` to ${d.to_party}`}
                  {d.doc_date && ` · dated ${fmtDate(d.doc_date)}`}
                  {d.file_name && ` · ${d.file_name}`}
                </p>
                {d.rejection_reason && (
                  <p className="mt-4 text-[11px]" style={{ color: "var(--danger)" }}>Rejected: {d.rejection_reason}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-12">
                <span className="px-8 py-4 text-[10px] font-bold uppercase"
                  style={{ borderLeft: `4px solid ${DOC_EDGE[d.status]}`, color: "var(--ink)" }}>{d.status}</span>
                {workable && d.status !== "verified" && (
                  <button type="button" className="text-xs underline" style={{ color: "var(--success)" }}
                    onClick={() => setDocStatus(d.id, "verified")}>Verify</button>
                )}
                {workable && d.status !== "rejected" && (
                  <button type="button" className="text-xs underline" style={{ color: "var(--danger)" }}
                    onClick={() => setDocStatus(d.id, "rejected")}>Reject</button>
                )}
                {d.document_id && <DocLink docId={d.document_id} />}
              </div>
            </div>
          ))}
          {job.documents.length === 0 && (
            <p className="pane-note text-sm">
              Nothing in the register yet — every stage gate is checked against these entries.
            </p>
          )}
        </div>
      </section>

      {/* ---------- Stage 9: transport decision ---------- */}
      <section className="mt-24">
        <h2 className={`${headingCls} pane-note`}>Stage 9 — transport decision</h2>
        <div className="mt-16 grid grid-cols-1 gap-24 lg:grid-cols-[1fr_320px]">
          {workable ? (
            <form onSubmit={saveDecision} className={card} style={cardStyle}>
              <div className="grid grid-cols-1 gap-12 md:grid-cols-2">
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>What is this job?</span>
                  <select value={decision.recordKind}
                    onChange={e => setDecision({ ...decision, recordKind: e.target.value })}
                    className={inputCls} style={inputStyle}>
                    <option value="live">Current shipment we are clearing</option>
                    <option value="archive">Record of a shipment already completed</option>
                  </select>
                </label>
                {decision.recordKind === "live" && (
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Does the client need transport?</span>
                    <select value={decision.transportNeeded}
                      onChange={e => setDecision({ ...decision, transportNeeded: e.target.value })}
                      className={inputCls} style={inputStyle}>
                      <option value="no">No — client collects the cargo</option>
                      <option value="yes">Yes — book road transport</option>
                    </select>
                  </label>
                )}
              </div>

              {decision.recordKind === "archive" && (
                <p className="mt-16 text-xs" style={{ color: "var(--ink-soft)" }}>
                  Saved as information only: no transport prompt, no notice board and no further action.
                </p>
              )}

              {decision.recordKind === "live" && decision.transportNeeded === "yes" && (
                <div className="mt-16 rounded-input border p-16" style={cardStyle}>
                  <p className="text-xs" style={{ color: "var(--ink)" }}>
                    The system asks the client before it reuses this shipment's properties and route to
                    create a transport request. Nothing is posted without consent.
                  </p>
                  <label className="mt-12 block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Client consent to reuse the details</span>
                    <select value={decision.consent} onChange={e => setDecision({ ...decision, consent: e.target.value })}
                      className={inputCls} style={inputStyle}>
                      <option value="not_asked">Not asked yet</option>
                      <option value="granted">Granted</option>
                      <option value="declined">Declined</option>
                      <option value="deferred">Deferred — ask later</option>
                    </select>
                  </label>
                </div>
              )}

              {decision.recordKind === "live" && decision.transportNeeded === "no" && (
                <div className="mt-16 grid grid-cols-1 gap-12 md:grid-cols-3">
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Handover — who collected</span>
                    <input value={decision.handoverName}
                      onChange={e => setDecision({ ...decision, handoverName: e.target.value })}
                      className={inputCls} style={inputStyle} />
                  </label>
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>ID / pass number</span>
                    <input value={decision.handoverId}
                      onChange={e => setDecision({ ...decision, handoverId: e.target.value })}
                      className={inputCls} style={inputStyle} />
                  </label>
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Proof</span>
                    <select value={decision.handoverMethod}
                      onChange={e => setDecision({ ...decision, handoverMethod: e.target.value })}
                      className={inputCls} style={inputStyle}>
                      <option value="signature">Signature</option>
                      <option value="photo">Photo</option>
                    </select>
                  </label>
                </div>
              )}

              <label className="mt-12 block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
                <input value={decision.notes} onChange={e => setDecision({ ...decision, notes: e.target.value })}
                  className={inputCls} style={inputStyle} />
              </label>
              <button type="submit" disabled={busy}
                className="waisha-btn mt-16 rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-60">
                Record decision
              </button>
            </form>
          ) : (
            <div className={card} style={cardStyle}>
              <p className="text-sm" style={{ color: "var(--ink)" }}>
                {job.record_kind === "archive"
                  ? "Held as a record of a completed shipment — no transport prompt and no notice board."
                  : `Decision on file: transport ${job.transport_needed ? "needed" : "not needed"}, consent ${job.transport_consent.replace("_", " ")}.`}
              </p>
            </div>
          )}

          {/* ---------- Transport request: consent preview, then publish ---------- */}
          {workable && job.record_kind === "live" && (
            <div className={card} style={cardStyle}>
              <h3 className={headingCls} style={{ color: "var(--ink)" }}>Transport request</h3>
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                Publishing sends a copy of the cargo details and route to the notice board for other
                companies to quote. Nothing is shared until you have read the preview and confirmed it.
              </p>

              {treq ? (
                <div className="mt-16 space-y-12">
                  <div className="rounded-input border p-16" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em]"
                      style={{ color: "var(--ink-soft)" }}>
                      {treq.status === "open" ? "Live on the board" : `Booking ${treq.status.replace("_", " ")}`}
                    </p>
                    <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>
                      {treq.pickup_text} → {treq.dest_text}
                      {treq.via_label && ` via ${treq.via_label}`}
                    </p>
                    <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                      {treq.cargo_label}
                      {treq.distance_km ? ` · ${treq.distance_km} km` : ""}
                      {` · needed ${fmtDate(treq.required_date)}`} · {treq.contact_name} ({treq.contact_channel})
                    </p>
                    <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                      Published {fmtWhen(treq.disclosed_at)}
                    </p>
                  </div>
                  {treq.status === "open" && (
                    <button type="button" disabled={busy} onClick={cancelTransport}
                      className="rounded-input border px-16 py-8 text-xs font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--danger, var(--ink))" }}>
                      Withdraw from the board
                    </button>
                  )}
                </div>
              ) : job.transport_consent !== "granted" ? (
                <p className="mt-16 text-xs" style={{ color: "var(--ink)" }}>
                  {job.transport_needed
                    ? "Consent to use this shipment's details is not recorded as granted. Set it in the decision above."
                    : "Record the transport decision above first — the client must allow their cargo details and route to be used."}
                </p>
              ) : !prev || !pub ? (
                <button type="button" disabled={busy} onClick={openPreview}
                  className="waisha-btn mt-16 rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-60">
                  Preview what becomes public
                </button>
              ) : (
                <form onSubmit={publishTransport} className="mt-16 space-y-16">
                  <div className="rounded-input border p-16 text-xs" style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                    <p className="font-semibold uppercase tracking-[0.14em] text-[11px]"
                      style={{ color: "var(--ink-soft)" }}>Company card transporters will see</p>
                    <p className="mt-8 font-semibold">{prev.company.companyName}</p>
                    {prev.company.description && <p className="mt-4">{prev.company.description}</p>}
                    <p className="mt-4" style={{ color: "var(--ink-soft)" }}>
                      {[prev.company.services, prev.company.corridors].filter(Boolean).join(" · ")}
                      {prev.company.fleetSizeDeclared ? ` · fleet ${prev.company.fleetSizeDeclared}` : ""}
                      {prev.company.yearEstablished ? ` · since ${prev.company.yearEstablished}` : ""}
                      {prev.company.website ? ` · ${prev.company.website}` : ""}
                    </p>
                  </div>

                  {(prev.warnings ?? []).length > 0 && (
                    <div className="rounded-input border p-16 text-xs"
                      style={{ borderColor: "var(--gold)", color: "var(--ink)" }}>
                      <p className="font-semibold">Flagged before you edit</p>
                      {prev.warnings.map((w: string, i: number) => <p key={i} className="mt-4">{w}</p>)}
                    </div>
                  )}

                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Cargo description shown publicly</span>
                    <textarea rows={2} value={pub.cargoLabel}
                      onChange={e => setPub({ ...pub, cargoLabel: e.target.value })}
                      className={inputCls} style={inputStyle} />
                  </label>

                  <div className="grid grid-cols-1 gap-12 md:grid-cols-3">
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Pickup point</span>
                      <input value={pub.pickupText} required maxLength={200}
                        onChange={e => setPub({ ...pub, pickupText: e.target.value })}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Destination</span>
                      <input value={pub.destText} required maxLength={200}
                        onChange={e => setPub({ ...pub, destText: e.target.value })}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Via / border</span>
                      <input value={pub.viaLabel} maxLength={200}
                        onChange={e => setPub({ ...pub, viaLabel: e.target.value })}
                        className={inputCls} style={inputStyle} />
                    </label>
                  </div>

                  <div className="grid grid-cols-1 gap-12 md:grid-cols-3">
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Required by</span>
                      <input type="date" value={pub.requiredDate} required
                        onChange={e => setPub({ ...pub, requiredDate: e.target.value })}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Your route (copies distance)</span>
                      <select value={pub.routeId}
                        onChange={e => setPub({ ...pub, routeId: e.target.value })}
                        className={inputCls} style={inputStyle}>
                        <option value="">Not linked</option>
                        {prev.routes.map((r: any) => (
                          <option key={r.id} value={r.id}>
                            {r.label}{r.distance_km ? ` · ${r.distance_km} km` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Container / load</span>
                      <select value={pub.containerType}
                        onChange={e => setPub({ ...pub, containerType: e.target.value })}
                        className={inputCls} style={inputStyle}>
                        <option value="">Not stated</option>
                        {CONTAINERS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 gap-12 md:grid-cols-3">
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Containers</span>
                      <input type="number" min={1} max={500} value={pub.containerCount}
                        onChange={e => setPub({ ...pub, containerCount: e.target.value })}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Tonnes</span>
                      <input type="number" step="0.001" min={0} value={pub.weightTonnes}
                        onChange={e => setPub({ ...pub, weightTonnes: e.target.value })}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>CBM</span>
                      <input type="number" step="0.001" min={0} value={pub.cbm}
                        onChange={e => setPub({ ...pub, cbm: e.target.value })}
                        className={inputCls} style={inputStyle} />
                    </label>
                  </div>

                  <div>
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Vehicles wanted</span>
                    <div className="flex flex-wrap gap-8">
                      {VEHICLES.map(v => {
                        const on = pub.vehicleTypes.includes(v.key);
                        return (
                          <button type="button" key={v.key}
                            onClick={() => setPub({
                              ...pub,
                              vehicleTypes: on ? pub.vehicleTypes.filter((x: string) => x !== v.key)
                                : [...pub.vehicleTypes, v.key].slice(0, 6)
                            })}
                            className="rounded-input border px-12 py-6 text-xs font-semibold"
                            style={{
                              borderColor: on ? "var(--brand)" : "var(--line)",
                              color: on ? "var(--brand)" : "var(--ink-soft)",
                              background: on ? "var(--milk)" : "transparent"
                            }}>
                            {v.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-12 md:grid-cols-3">
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Named contact</span>
                      <select value={pub.contactUserId}
                        onChange={e => {
                          const s = prev.staff.find((x: any) => x.id === e.target.value);
                          setPub({ ...pub, contactUserId: e.target.value,
                            contactName: s?.full_name ?? pub.contactName,
                            contactChannel: s?.email ?? pub.contactChannel });
                        }}
                        className={inputCls} style={inputStyle}>
                        {prev.staff.map((s: any) => (
                          <option key={s.id} value={s.id}>{s.full_name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Contact name published</span>
                      <input value={pub.contactName} required maxLength={120}
                        onChange={e => setPub({ ...pub, contactName: e.target.value })}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Reachable on (work)</span>
                      <input value={pub.contactChannel} required maxLength={160}
                        onChange={e => setPub({ ...pub, contactChannel: e.target.value })}
                        className={inputCls} style={inputStyle} />
                    </label>
                  </div>

                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note to transporters</span>
                    <textarea rows={2} maxLength={600} value={pub.publicNote}
                      placeholder="e.g. 2 x 20ft, collect from ICD Tema, tail-lift needed"
                      onChange={e => setPub({ ...pub, publicNote: e.target.value })}
                      className={inputCls} style={inputStyle} />
                  </label>

                  <div className="rounded-input border p-16 text-xs" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <p className="font-semibold uppercase tracking-[0.14em]">Never published</p>
                    <ul className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
                      {(prev.withheld ?? []).map((w: string) => <li key={w}>· {w}</li>)}
                    </ul>
                  </div>

                  <label className="flex items-start gap-10 text-xs" style={{ color: "var(--ink)" }}>
                    <input type="checkbox" checked={safe}
                      onChange={e => setSafe(e.target.checked)} className="mt-4" />
                    <span>
                      I have read every field above. Nothing here names my client, quotes a declaration,
                      container or tax number, or shows costs.
                    </span>
                  </label>

                  {flags && flags.length > 0 && (
                    <div className="rounded-input border p-16 text-xs"
                      style={{ borderColor: "var(--gold)", color: "var(--ink)" }}>
                      <p className="font-semibold">Waisha will not publish this yet</p>
                      {flags.map((w, i) => <p key={i} className="mt-4">{w}</p>)}
                      <label className="mt-12 flex items-start gap-10">
                        <input type="checkbox" checked={forced}
                          onChange={e => setForced(e.target.checked)} className="mt-4" />
                        <span>Publish anyway — I have reworded nothing and accept that these fields
                          may name my client.</span>
                      </label>
                    </div>
                  )}

                  <div className="flex gap-8">
                    <button type="submit" disabled={busy || !safe || (!!flags?.length && !forced)}
                      className="waisha-btn rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-60">
                      Publish to the board
                    </button>
                    <button type="button" disabled={busy} onClick={() => { setPrev(null); setPub(null); setFlags(null); setForced(false); }}
                      className="rounded-input border px-16 py-8 text-xs font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                      Not now
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          <div className={card} style={cardStyle}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Handovers recorded</p>
            <div className="space-y-8">
              {job.handovers.map(h => (
                <div key={h.id} className="text-xs" style={{ color: "var(--ink)" }}>
                  <p className="font-semibold">{h.received_by_name}</p>
                  <p style={{ color: "var(--ink-soft)" }}>
                    {h.method} · {fmtWhen(h.happened_at)}{h.file_name && ` · ${h.file_name}`}
                  </p>
                </div>
              ))}
              {job.handovers.length === 0 && (
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  None yet. A handover or a verified proof of delivery is needed before the job can close.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ---------- Free days + activity ---------- */}
      <div className="mt-24 grid grid-cols-1 gap-24 lg:grid-cols-[320px_1fr]">
        <section className={card} style={cardStyle}>
          <h2 className={headingCls} style={{ color: "var(--ink-soft)" }}>Free days clock</h2>
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            Demurrage runs from the day the container is available. The alert fires three days before it ends.
          </p>
          <div className="mt-16 space-y-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Free days</span>
              <input type="number" min={0} max={365} value={freeDays.days}
                onChange={e => setFreeDays({ ...freeDays, days: e.target.value })}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Counted from</span>
              <input type="date" value={freeDays.start}
                onChange={e => setFreeDays({ ...freeDays, start: e.target.value })}
                className={inputCls} style={inputStyle} />
            </label>
            {workable && (
              <button type="button" disabled={busy} onClick={saveFreeDays}
                className="rounded-input border px-16 py-8 text-xs font-semibold"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Save clock</button>
            )}
          </div>
          <p className="mt-16 border-t pt-16 text-xs" style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
            {job.free_days && job.free_days_start
              ? `${job.free_days} days from ${fmtDate(job.free_days_start)}`
              : "No clock set on this job."}
          </p>
        </section>

        <Timeline job={job} />
      </div>
    </div>
  );
}

function Timeline({ job }: { job: Job }) {
  const name = (s: string | null) => job.stages.find(x => x.id === s)?.name ?? null;
  return (
    <section className={card} style={cardStyle}>
      <h2 className={headingCls} style={{ color: "var(--ink-soft)" }}>Activity</h2>
      <ol className="mt-16 space-y-12">
        {job.activity.map(a => (
          <li key={a.id} className="flex gap-12 text-xs">
            <span className="mt-4 h-8 w-8 shrink-0 rounded-full"
              style={{ background: a.action.endsWith(".done") ? "var(--success)" : "var(--gold)" }} aria-hidden />
            <span className="min-w-0">
              <p style={{ color: "var(--ink)" }}>{a.summary}</p>
              <p style={{ color: "var(--ink-soft)" }}>
                {fmtWhen(a.created_at)} · {a.actor_name}
                {name(a.stage_id) && ` · ${name(a.stage_id)}`}
              </p>
            </span>
          </li>
        ))}
        {job.activity.length === 0 && (
          <li className="text-xs" style={{ color: "var(--ink-soft)" }}>No activity logged yet.</li>
        )}
      </ol>
    </section>
  );
}

function DocLink({ docId }: { docId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/documents/${docId}/url`).then(async res => {
      if (!res.ok || cancelled) return;
      const j = await res.json();
      if (!cancelled) setUrl(j.url);
    }).catch(() => { });
    return () => { cancelled = true; };
  }, [docId]);
  return url
    ? <a href={url} target="_blank" rel="noreferrer" className="doc-view text-xs underline" style={{ color: "var(--brand)" }}>View</a>
    : <span className="text-xs" style={{ color: "var(--ink-soft)" }}>—</span>;
}
