"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import { apiFetch } from "../../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

const STAGES = ["pre_arrival", "arrival", "customs", "inspection", "release", "exit"];
const STAGE_LABELS: Record<string, string> = {
  pre_arrival: "Pre-arrival", arrival: "Arrival", customs: "Customs",
  inspection: "Inspection", release: "Release", exit: "Exit"
};
const TYPE_PREFIX: Record<string, string> = { export: "1", import: "4", transhipment: "7", transit: "8" };
const CONTAINER_LABELS: Record<string, string> = {
  "20ft": "20FT", "40ft": "40FT", loose_cargo: "Loose Cargo", car: "Car"
};
const DOC_KINDS = [
  { kind: "invoice", label: "Invoice" },
  { kind: "bill_of_lading", label: "Bill of Lading" },
  { kind: "packing_list", label: "Packing list" },
  { kind: "other", label: "Other" }
];
const DOC_KIND_LABELS: Record<string, string> = {
  invoice: "Invoice", bill_of_lading: "Bill of Lading",
  packing_list: "Packing list", other: "Other"
};

interface Shipment {
  id: string; file_number: string; seq: number; file_year: number;
  shipment_type: string; hs_code: string | null; declaration_mode: string | null;
  cargo_description: string | null;
  container_type: string; container_count: number | null; container_numbers: string[] | null;
  cbm: string | null; weight_tonnes: string | null;
  consignee_name: string; consignor_name: string; shipping_line: string | null; bill_number: string | null;
  order_date: string | null; document_receipt_date: string | null; eta: string | null;
  discharge_date: string | null; carry_in_date: string | null; terms_delivery: string | null;
  tansad_number: string | null; rcn_number: string | null; reference_number: string | null;
  office_declaration: string | null; border_point: string | null; nominated_icd: string | null;
  cabinet_position: string | null;
  processing_cost: string | null; payment_amount: string | null; payment_status: string;
  stage: string; status: string; notes: string | null;
  tasks: { id: string; title: string; assigned_to: string | null; assignee_name: string | null;
           due_date: string | null; status: string; notes: string | null }[];
  documents: { id: string; kind: string; file_name: string; mime_type: string; size_bytes: number; created_at: string }[];
  staff: { id: string; full_name: string }[];
}

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : "—");
const money = (v: string | null) => (v ? Number(v).toLocaleString() : "—");

export default function CargoDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [file, setFile] = useState<Shipment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [task, setTask] = useState({ title: "", assignedTo: "", dueDate: "" });
  const [docKind, setDocKind] = useState("invoice");
  const [docFile, setDocFile] = useState<File | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch(`/cargo/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Cargo file not found.")); return; }
    setFile(j);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function changeStage(stage: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/cargo/${id}/stage`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed.")); return; }
      setNotice(`Stage moved to ${STAGE_LABELS[stage]}.`);
      await load();
    } finally { setBusy(false); }
  }

  async function changeStatus(status: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/cargo/${id}/status`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed.")); return; }
      setNotice(`File marked ${status.replace("_", " ")}.`);
      await load();
    } finally { setBusy(false); }
  }

  async function duplicate() {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/cargo/${id}/duplicate`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to duplicate.")); return; }
      window.location.href = `/app/cfa/cargo/${j.id}`;
    } finally { setBusy(false); }
  }

  async function remove() {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/cargo/${id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to delete.")); return; }
      window.location.href = "/app/cfa/cargo";
    } finally { setBusy(false); }
  }

  async function addTask(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/cargo/${id}/tasks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: task.title,
          assignedTo: task.assignedTo || null,
          dueDate: task.dueDate || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to assign the task.")); return; }
      setNotice("Task assigned.");
      setTask({ title: "", assignedTo: "", dueDate: "" });
      await load();
    } finally { setBusy(false); }
  }

  async function setTaskStatus(taskId: string, status: string) {
    setError(null); setNotice(null);
    const res = await apiFetch(`/cargo/${id}/tasks/${taskId}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) setError(errorText(j, "Failed."));
    await load();
  }

  async function attachDocument(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError(null); setNotice(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("entityType", "shipment");
      fd.append("entityId", id);
      fd.append("kind", docKind);
      fd.append("file", f);
      const res = await apiFetch("/documents", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Upload failed.")); return; }
      setNotice("Document attached.");
      await load();
    } finally { setBusy(false); }
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  if (error && !file) {
    return (
      <div className="mx-auto max-w-[980px] px-16 py-32">
        <div role="alert" className="px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error} <Link href="/app/cfa/cargo" className="underline">Back to cargo files</Link>
        </div>
      </div>
    );
  }
  if (!file) {
    return <div className="mx-auto max-w-[980px] px-16 py-32 text-sm" style={{ color: "var(--ink-soft)" }}>Loading cargo file…</div>;
  }

  const stageIndex = STAGES.indexOf(file.stage);
  const editable = file.status !== "completed" && file.status !== "cancelled";

  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div>
      <p className={labelCls} style={{ color: "var(--ink-soft)" }}>{label}</p>
      <p className="text-sm" style={{ color: "var(--ink)" }}>{value ?? "—"}</p>
    </div>
  );

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <div className="no-print flex flex-wrap items-center justify-between gap-12">
        <Link href="/app/cfa/cargo" className="text-xs underline" style={{ color: "var(--ink-soft)" }}>← All cargo files</Link>
        <div className="flex flex-wrap gap-8">
          <Link href={`/app/cfa/jobs?file=${id}`}
            className="rounded-input border px-16 py-8 text-xs font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--brand)" }}>Job pipeline</Link>
          <Link href={`/app/cfa/messages?file=${id}`}
            className="rounded-input border px-16 py-8 text-xs font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--brand)" }}>Messages</Link>
          {editable && (
            <Link href={`/app/cfa/cargo?edit=${id}`}
              className="rounded-input border px-16 py-8 text-xs font-semibold"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Edit</Link>
          )}
          <button type="button" disabled={busy} onClick={duplicate}
            className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-50"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Duplicate</button>
          {editable && file.status === "open" && (
            <button type="button" disabled={busy} onClick={() => changeStatus("on_hold")}
              className="rounded-input border px-16 py-8 text-xs font-semibold"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Hold</button>
          )}
          {file.status === "on_hold" && (
            <button type="button" disabled={busy} onClick={() => changeStatus("open")}
              className="rounded-input border px-16 py-8 text-xs font-semibold"
              style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Reopen</button>
          )}
          {editable && (
            <button type="button" disabled={busy} onClick={() => changeStatus("completed")}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">Mark completed</button>
          )}
          {editable && (
            <button type="button" disabled={busy} onClick={() => changeStatus("cancelled")}
              className="rounded-input border px-16 py-8 text-xs font-semibold"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>Cancel file</button>
          )}
          <button type="button" onClick={() => window.print()}
            className="rounded-input border px-16 py-8 text-xs font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>Print</button>
          {editable && (
            <button type="button" disabled={busy} onClick={remove}
              className="rounded-input border px-16 py-8 text-xs font-semibold"
              style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>Delete</button>
          )}
        </div>
      </div>
      {error && <div role="alert" className="no-print mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="no-print mt-16 mb-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      <div className="mt-24 flex flex-wrap items-center justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
            {file.file_number}
          </h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            {file.consignee_name} · {file.consignor_name}
          </p>
        </div>
        <span className="px-8 py-4 text-[10px] font-bold uppercase"
          style={{ borderLeft: `4px solid ${file.status === "open" ? "var(--success)" : "var(--ink-soft)"}`, color: "var(--ink)" }}>
          {file.status.replace("_", " ")}
        </span>
      </div>

      {/* Workflow stage bar */}
      <section className="no-print mt-24 rounded-card border bg-surface p-24" style={cardStyle}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Workflow</h2>
          {editable && stageIndex < STAGES.length - 1 && (
            <button type="button" disabled={busy} onClick={() => changeStage(STAGES[stageIndex + 1])}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
              Move to {STAGE_LABELS[STAGES[stageIndex + 1]]}
            </button>
          )}
        </div>
        <div className="mt-16 flex flex-wrap gap-8">
          {STAGES.map((s, n) => (
            <button key={s} type="button" disabled={busy || !editable}
              onClick={() => changeStage(s)}
              className="rounded-input border px-12 py-8 text-xs font-semibold disabled:cursor-default"
              style={{
                borderColor: n <= stageIndex ? "var(--brand)" : "var(--line)",
                background: n === stageIndex ? "color-mix(in srgb, var(--brand) 12%, transparent)" : "transparent",
                color: n <= stageIndex ? "var(--ink)" : "var(--ink-soft)"
              }}>
              {n + 1}. {STAGE_LABELS[s]}
            </button>
          ))}
        </div>
      </section>

      {/* File details */}
      <section className={`${card} mt-24`} style={cardStyle}>
        <div className="grid grid-cols-2 gap-16 text-sm md:grid-cols-3">
          <Row label="Shipment type" value={file.shipment_type[0].toUpperCase() + file.shipment_type.slice(1)} />
          <Row label="HS code" value={file.hs_code ?? "—"} />
          <Row label="Declaration mode" value={file.declaration_mode ?? "—"} />
          <Row label="Container" value={`${CONTAINER_LABELS[file.container_type] ?? file.container_type}${file.container_count ? ` ×${file.container_count}` : ""}`} />
          <Row label="Container numbers" value={(file.container_numbers ?? []).length ? (file.container_numbers ?? []).join(", ") : "—"} />
          <Row label="Weight (t)" value={file.weight_tonnes ? Number(file.weight_tonnes).toLocaleString() : "—"} />
          <Row label="CBM" value={file.cbm ? Number(file.cbm).toLocaleString() : "—"} />
          <Row label="Shipping line" value={file.shipping_line ?? "—"} />
          <Row label="Bill number" value={file.bill_number ?? "—"} />
          <Row label="Order date" value={fmtDate(file.order_date)} />
          <Row label="Documents received" value={fmtDate(file.document_receipt_date)} />
          <Row label="ETA" value={fmtDate(file.eta)} />
          <Row label="Discharge" value={fmtDate(file.discharge_date)} />
          <Row label="Carry-in" value={fmtDate(file.carry_in_date)} />
          <Row label="Terms" value={file.terms_delivery ?? "—"} />
          <Row label="TANSAD" value={file.tansad_number ?? "—"} />
          <Row label="RCN" value={file.rcn_number ?? "—"} />
          <Row label="Reference" value={file.reference_number ?? "—"} />
          <Row label="Office of declaration" value={file.office_declaration ?? "—"} />
          <Row label="Border point" value={file.border_point ?? "—"} />
          <Row label="Nominated ICD" value={file.nominated_icd ?? "—"} />
          <Row label="Cabinet position" value={file.cabinet_position ?? "—"} />
          <Row label="Processing cost" value={file.processing_cost ? `TZS ${money(file.processing_cost)}` : "—"} />
          <Row label="Payment" value={`${money(file.payment_amount)} TZS · ${file.payment_status}`} />
        </div>
        {file.cargo_description && (
          <div className="mt-16 border-t pt-16" style={{ borderColor: "var(--line)" }}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Cargo description</p>
            <p className="text-sm" style={{ color: "var(--ink)" }}>{file.cargo_description}</p>
          </div>
        )}
        {file.notes && (
          <div className="mt-16 border-t pt-16" style={{ borderColor: "var(--line)" }}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</p>
            <p className="text-sm" style={{ color: "var(--ink)" }}>{file.notes}</p>
          </div>
        )}
      </section>

      {/* Tasks */}
      <section className="no-print mt-24">
        <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
          Tasks ({file.tasks.filter(t => t.status === "pending").length} pending)
        </h2>
        <form onSubmit={addTask} className="mt-16 grid grid-cols-[1fr_1fr_150px_140px] items-end gap-12 rounded-card border bg-surface p-24" style={cardStyle}>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Task *</span>
            <input required value={task.title} onChange={e => setTask(t => ({ ...t, title: e.target.value }))}
              placeholder="e.g. Submit TANSAD at TRA office" className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Assign to</span>
            <select value={task.assignedTo} onChange={e => setTask(t => ({ ...t, assignedTo: e.target.value }))}
              className={inputCls} style={inputStyle}>
              <option value="">Unassigned</option>
              {file.staff.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Deadline</span>
            <input type="date" value={task.dueDate} onChange={e => setTask(t => ({ ...t, dueDate: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <button type="submit" disabled={busy}
            className="waisha-btn rounded-input py-8 text-xs font-semibold disabled:opacity-60">
            Assign
          </button>
        </form>
        <div className="mt-16 space-y-8">
          {file.tasks.map(t => (
            <div key={t.id} className="flex items-center justify-between rounded-input border bg-surface px-16 py-12" style={cardStyle}>
              <div className="min-w-0 text-sm">
                <p style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{t.title}</span>
                  {t.assignee_name && <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>{t.assignee_name}</span>}
                  {t.due_date && (
                    <span className="ml-8 text-xs tabular-nums"
                      style={{ color: t.status === "pending" && new Date(t.due_date) < new Date() ? "var(--danger)" : "var(--ink-soft)" }}>
                      due {new Date(t.due_date).toLocaleDateString()}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-12">
                <span className="px-8 py-4 text-[10px] font-bold uppercase"
                  style={{ borderLeft: `4px solid ${t.status === "done" ? "var(--success)" : t.status === "cancelled" ? "var(--ink-soft)" : "var(--gold)"}`, color: "var(--ink)" }}>
                  {t.status}
                </span>
                {t.status === "pending" && (
                  <>
                    <button type="button" className="underline text-xs" style={{ color: "var(--success)" }}
                      onClick={() => setTaskStatus(t.id, "done")}>Done</button>
                    <button type="button" className="underline text-xs" style={{ color: "var(--ink-soft)" }}
                      onClick={() => setTaskStatus(t.id, "cancelled")}>Drop</button>
                  </>
                )}
              </div>
            </div>
          ))}
          {file.tasks.length === 0 && (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No tasks assigned yet.</p>
          )}
        </div>
      </section>

      {/* Documents */}
      <section className="no-print mt-24">
        <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
          Documents ({file.documents.length})
        </h2>
        <div className="mt-16 flex flex-wrap items-end gap-12 rounded-card border bg-surface p-24" style={cardStyle}>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Type</span>
            <select value={docKind} onChange={e => setDocKind(e.target.value)} className={inputCls} style={inputStyle}>
              {DOC_KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Attach file (JPEG, PNG, WebP, PDF — 8MB)</span>
            <input type="file" accept=".pdf,image/jpeg,image/png,image/webp" disabled={busy}
              onChange={attachDocument} className="text-xs" />
          </label>
        </div>
        <div className="mt-16 space-y-8">
          {file.documents.map(d => (
            <div key={d.id} className="flex items-center justify-between rounded-input border bg-surface px-16 py-12" style={cardStyle}>
              <div className="min-w-0 text-sm">
                <span className="font-semibold" style={{ color: "var(--ink)" }}>{DOC_KIND_LABELS[d.kind] ?? d.kind}</span>
                <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>{d.file_name}</span>
              </div>
              <DocLink docId={d.id} />
            </div>
          ))}
          {file.documents.length === 0 && (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
              No documents attached — upload the invoice, BL and packing list above.
            </p>
          )}
        </div>
      </section>
    </div>
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
    ? <a href={url} target="_blank" rel="noreferrer" className="shrink-0 text-xs underline" style={{ color: "var(--brand)" }}>View</a>
    : <span className="shrink-0 text-xs" style={{ color: "var(--ink-soft)" }}>—</span>;
}
