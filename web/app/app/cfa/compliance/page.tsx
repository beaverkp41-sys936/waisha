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

interface Entry {
  id: string; party_name: string; tin: string | null; reason: string;
  source: string; severity: string; status: string; notes: string | null; created_at: string;
}
interface Match {
  entryId: string; entryName: string; severity: string; field: string; name: string;
}
interface Flagged {
  subjectType: "file" | "client"; subjectId: string; label: string; matches: Match[];
}
interface Check {
  id: string; subject_type: string; subject_id: string; subject_label: string;
  result: string; matches: Match[]; checked_at: string; checked_by_name: string | null;
}
interface Licence {
  id: string; authority: string; title: string; licence_number: string | null;
  issued_date: string | null; expiry_date: string; notes: string | null;
  days: number; status: string; document_count: number; latest_document_id: string | null;
}
interface FileOption { id: string; file_number: string; status: string }

const SOURCE_LABELS: Record<string, string> = {
  tra: "TRA", customs: "Customs", court: "Court", police: "Police",
  internal: "Internal", other: "Other"
};
const AUTHORITY_LABELS: Record<string, string> = {
  tra: "TRA", brela: "BRELA", tpa: "TPA", other: "Other"
};
const SEVERITY_COLORS: Record<string, string> = {
  high: "var(--danger)", medium: "var(--warning)", low: "var(--ink-soft)"
};
const LICENCE_STATUS_COLORS: Record<string, string> = {
  expired: "var(--danger)", expiring: "var(--warning)", valid: "var(--success)"
};
const FIELD_LABELS: Record<string, string> = {
  consignee: "Consignee", consignor: "Consignor", name: "Name"
};

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : "—");
const emptyEntryForm = { partyName: "", tin: "", reason: "", source: "internal", severity: "high", notes: "" };
const emptyLicenceForm = { authority: "tra", title: "", licenceNumber: "", issuedDate: "", expiryDate: "", notes: "" };

export default function ComplianceScreeningPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [flagged, setFlagged] = useState<Flagged[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [licences, setLicences] = useState<Licence[]>([]);
  const [files, setFiles] = useState<FileOption[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [entryForm, setEntryForm] = useState(emptyEntryForm);
  const [editingEntry, setEditingEntry] = useState<string | null>(null);
  const [entryEdit, setEntryEdit] = useState(emptyEntryForm);

  const [licenceForm, setLicenceForm] = useState(emptyLicenceForm);
  const [editingLicence, setEditingLicence] = useState<string | null>(null);
  const [licenceEdit, setLicenceEdit] = useState(emptyLicenceForm);

  const [screenFileId, setScreenFileId] = useState("");
  const attachInput = useRef<HTMLInputElement | null>(null);
  const attachTargetRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const [e, m, k, l, f] = await Promise.all([
      apiFetch("/screening/entries"),
      apiFetch("/screening/matches"),
      apiFetch("/screening/checks"),
      apiFetch("/licences"),
      apiFetch("/cargo")
    ]);
    if (e.ok) setEntries(await e.json());
    if (k.ok) setChecks(await k.json());
    if (l.ok) setLicences(await l.json());
    if (f.ok) setFiles((await f.json()).filter((x: FileOption) => x.status === "open"));
    if (m.ok) {
      const j = await m.json();
      setFlagged([...(j.files ?? []), ...(j.clients ?? [])]);
    }
    if (!e.ok && !m.ok && !l.ok) setError(errorText(null, "Could not load compliance data."));
    setReady(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runScreening(payload: { shipmentId?: string; clientId?: string }) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch("/screening/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Screening failed.")); return; }
      setNotice(j.result === "hit"
        ? `Logged: hit — ${j.matches.length} watchlist match${j.matches.length === 1 ? "" : "es"} on ${j.subjectLabel}.`
        : `Logged: clear — no watchlist matches on ${j.subjectLabel}.`);
      await load();
    } finally { setBusy(false); }
  }

  async function addEntry(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch("/screening/entries", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyName: entryForm.partyName,
          tin: entryForm.tin || null,
          reason: entryForm.reason,
          source: entryForm.source,
          severity: entryForm.severity,
          notes: entryForm.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to add the watchlist entry.")); return; }
      setNotice("Watchlist entry added.");
      setEntryForm(emptyEntryForm);
      await load();
    } finally { setBusy(false); }
  }

  async function saveEntry(id: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/screening/entries/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partyName: entryEdit.partyName,
          tin: entryEdit.tin || null,
          reason: entryEdit.reason,
          source: entryEdit.source,
          severity: entryEdit.severity,
          notes: entryEdit.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the entry.")); return; }
      setNotice("Watchlist entry updated.");
      setEditingEntry(null);
      await load();
    } finally { setBusy(false); }
  }

  async function setEntryStatus(id: string, status: "active" | "lifted") {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/screening/entries/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to change the status.")); return; }
      setNotice(status === "lifted" ? "Entry lifted — no longer screened." : "Entry reinstated on the watchlist.");
      await load();
    } finally { setBusy(false); }
  }

  async function removeEntry(id: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/screening/entries/${id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to delete the entry.")); return; }
      setNotice("Watchlist entry deleted.");
      await load();
    } finally { setBusy(false); }
  }

  async function addLicence(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch("/licences", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authority: licenceForm.authority,
          title: licenceForm.title,
          licenceNumber: licenceForm.licenceNumber || null,
          issuedDate: licenceForm.issuedDate || null,
          expiryDate: licenceForm.expiryDate,
          notes: licenceForm.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to add the licence.")); return; }
      setNotice("Licence added to the register.");
      setLicenceForm(emptyLicenceForm);
      await load();
    } finally { setBusy(false); }
  }

  async function saveLicence(id: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/licences/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authority: licenceEdit.authority,
          title: licenceEdit.title,
          licenceNumber: licenceEdit.licenceNumber || null,
          issuedDate: licenceEdit.issuedDate || null,
          expiryDate: licenceEdit.expiryDate,
          notes: licenceEdit.notes || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the licence.")); return; }
      setNotice("Licence updated.");
      setEditingLicence(null);
      await load();
    } finally { setBusy(false); }
  }

  async function removeLicence(id: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/licences/${id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to delete the licence.")); return; }
      setNotice("Licence deleted.");
      await load();
    } finally { setBusy(false); }
  }

  function pickAttachment(licenceId: string) {
    attachTargetRef.current = licenceId;
    attachInput.current?.click();
  }

  async function uploadAttachment(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    const licenceId = attachTargetRef.current;
    attachTargetRef.current = null;
    if (!f || !licenceId) return;
    setError(null); setNotice(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("entityType", "licence");
      fd.append("entityId", licenceId);
      fd.append("kind", "licence");
      fd.append("file", f);
      const res = await apiFetch("/documents", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Upload failed.")); return; }
      setNotice("Licence scan attached.");
      await load();
    } finally { setBusy(false); }
  }

  async function viewAttachment(documentId: string) {
    setError(null);
    const res = await apiFetch(`/documents/${documentId}/url`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Could not open the file.")); return; }
    window.open(j.url, "_blank");
  }

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };
  const h2Cls = "text-sm font-bold uppercase tracking-[0.14em]";
  const pill = (color: string) => ({ borderLeft: `4px solid ${color}`, color: "var(--ink)" });

  const activeEntries = entries.filter(x => x.status === "active").length;
  const expiredLicences = licences.filter(x => x.status === "expired").length;
  const expiringLicences = licences.filter(x => x.status === "expiring").length;

  return (
    <div className="mx-auto max-w-[980px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Compliance &amp; Screening</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Screen every open cargo file and client against your watchlist, and keep the
        company&apos;s TRA, BRELA and bond licences current — renewals alert automatically 30 days out.
      </p>
      {error && <div role="alert" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      {ready && (
        <section className="mt-24 grid grid-cols-2 gap-16 md:grid-cols-4">
          <div className={card} style={cardStyle}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Watchlist active</p>
            <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{activeEntries}</p>
          </div>
          <div className={card} style={cardStyle}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Flagged now</p>
            <p className="mt-8 text-2xl font-bold tabular-nums"
              style={{ color: flagged.length ? "var(--danger)" : "var(--success)" }}>{flagged.length}</p>
          </div>
          <div className={card} style={cardStyle}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Licences expired</p>
            <p className="mt-8 text-2xl font-bold tabular-nums"
              style={{ color: expiredLicences ? "var(--danger)" : "var(--ink)" }}>{expiredLicences}</p>
          </div>
          <div className={card} style={cardStyle}>
            <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Expiring in 30 days</p>
            <p className="mt-8 text-2xl font-bold tabular-nums"
              style={{ color: expiringLicences ? "var(--warning)" : "var(--ink)" }}>{expiringLicences}</p>
          </div>
        </section>
      )}

      {/* ---------- Flagged parties ---------- */}
      <section className="mt-32">
        <div className="flex flex-wrap items-end justify-between gap-12">
          <div>
            <h2 className={h2Cls} style={{ color: "var(--ink-soft)" }}>Flagged — needs review</h2>
            <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
              Open cargo files and clients that match an active watchlist entry, worst first.
            </p>
          </div>
          <div className="flex items-end gap-8">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Screen any open file</span>
              <select value={screenFileId} onChange={e => setScreenFileId(e.target.value)}
                className={inputCls} style={inputStyle}>
                <option value="">Pick a file…</option>
                {files.map(f => <option key={f.id} value={f.id}>{f.file_number}</option>)}
              </select>
            </label>
            <button type="button" disabled={busy || !screenFileId}
              onClick={() => runScreening({ shipmentId: screenFileId })}
              className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold disabled:opacity-50">
              Screen &amp; log
            </button>
          </div>
        </div>
        <div className="mt-16 space-y-8">
          {flagged.map(f => (
            <div key={`${f.subjectType}-${f.subjectId}`}
              className="flex flex-wrap items-center justify-between gap-12 rounded-input border bg-surface px-16 py-12"
              style={cardStyle}>
              <div className="min-w-0">
                <p className="text-sm" style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{f.label}</span>
                  <span className="ml-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>
                    {f.subjectType === "file" ? "Cargo file" : "Client"}
                  </span>
                </p>
                <div className="mt-4 flex flex-wrap gap-8">
                  {f.matches.map((m, i) => (
                    <span key={i} className="px-8 py-2 text-[11px]"
                      style={{ background: "var(--milk-deep)", borderLeft: `3px solid ${SEVERITY_COLORS[m.severity] ?? "var(--ink-soft)"}`, color: "var(--ink)" }}>
                      {FIELD_LABELS[m.field] ?? m.field} <strong>{m.name}</strong> → {m.entryName} ({m.severity})
                    </span>
                  ))}
                </div>
              </div>
              <button type="button" disabled={busy}
                onClick={() => runScreening(f.subjectType === "file" ? { shipmentId: f.subjectId } : { clientId: f.subjectId })}
                className="rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-50"
                style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                Screen &amp; log
              </button>
            </div>
          ))}
          {ready && flagged.length === 0 && (
            <div className="rounded-input border bg-surface px-16 py-12 text-sm"
              style={{ ...cardStyle, borderLeft: "4px solid var(--success)", color: "var(--ink-soft)" }}>
              No matches — every open file and client is clear of the watchlist.
            </div>
          )}
        </div>
      </section>

      {/* ---------- Watchlist register ---------- */}
      <section className="mt-32">
        <h2 className={h2Cls} style={{ color: "var(--ink-soft)" }}>Watchlist register</h2>
        <form onSubmit={addEntry} className="mt-16 grid grid-cols-2 gap-12 rounded-card border bg-surface p-24 md:grid-cols-6" style={cardStyle}>
          <label className="block md:col-span-2">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Party name *</span>
            <input required value={entryForm.partyName} onChange={e => setEntryForm(f => ({ ...f, partyName: e.target.value }))}
              placeholder="e.g. Acme Trading Ltd" className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>TIN</span>
            <input value={entryForm.tin} onChange={e => setEntryForm(f => ({ ...f, tin: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Source</span>
            <select value={entryForm.source} onChange={e => setEntryForm(f => ({ ...f, source: e.target.value }))}
              className={inputCls} style={inputStyle}>
              {Object.entries(SOURCE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Severity</span>
            <select value={entryForm.severity} onChange={e => setEntryForm(f => ({ ...f, severity: e.target.value }))}
              className={inputCls} style={inputStyle}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
          <label className="block md:col-span-5">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Reason *</span>
            <input required value={entryForm.reason} onChange={e => setEntryForm(f => ({ ...f, reason: e.target.value }))}
              placeholder="Why this party is flagged" className={inputCls} style={inputStyle} />
          </label>
          <button type="submit" disabled={busy}
            className="waisha-btn self-end rounded-input py-8 text-xs font-semibold disabled:opacity-60">
            Add entry
          </button>
        </form>

        <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Party</th><th className="p-12">Source</th>
                <th className="p-12">Severity</th><th className="p-12">Status</th>
                <th className="p-12">Reason</th><th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((en, i) => editingEntry === en.id ? (
                <tr key={en.id} style={{ background: "var(--milk-deep)" }}>
                  <td className="p-12" colSpan={5}>
                    <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
                      <input value={entryEdit.partyName} onChange={e => setEntryEdit(f => ({ ...f, partyName: e.target.value }))}
                        className={inputCls} style={inputStyle} />
                      <input value={entryEdit.tin} placeholder="TIN" onChange={e => setEntryEdit(f => ({ ...f, tin: e.target.value }))}
                        className={inputCls} style={inputStyle} />
                      <select value={entryEdit.source} onChange={e => setEntryEdit(f => ({ ...f, source: e.target.value }))}
                        className={inputCls} style={inputStyle}>
                        {Object.entries(SOURCE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                      <select value={entryEdit.severity} onChange={e => setEntryEdit(f => ({ ...f, severity: e.target.value }))}
                        className={inputCls} style={inputStyle}>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </select>
                      <input value={entryEdit.reason} placeholder="Reason"
                        onChange={e => setEntryEdit(f => ({ ...f, reason: e.target.value }))}
                        className={inputCls} style={{ ...inputStyle, gridColumn: "span 3" }} />
                    </div>
                  </td>
                  <td className="p-12 text-right whitespace-nowrap">
                    <button type="button" disabled={busy} className="underline" style={{ color: "var(--success)" }}
                      onClick={() => saveEntry(en.id)}>Save</button>
                    <button type="button" className="ml-12 underline" style={{ color: "var(--ink-soft)" }}
                      onClick={() => setEditingEntry(null)}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={en.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-12" style={{ color: "var(--ink)" }}>
                    <span className="font-semibold">{en.party_name}</span>
                    {en.tin && <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>TIN {en.tin}</span>}
                  </td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>{SOURCE_LABELS[en.source] ?? en.source}</td>
                  <td className="p-12">
                    <span className="px-8 py-4 text-[10px] font-bold uppercase" style={pill(SEVERITY_COLORS[en.severity] ?? "var(--ink-soft)")}>
                      {en.severity}
                    </span>
                  </td>
                  <td className="p-12">
                    <span className="px-8 py-4 text-[10px] font-bold uppercase"
                      style={pill(en.status === "active" ? "var(--danger)" : "var(--success)")}>
                      {en.status}
                    </span>
                  </td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>{en.reason}</td>
                  <td className="p-12 text-right whitespace-nowrap">
                    <button type="button" className="underline" style={{ color: "var(--ink-soft)" }}
                      onClick={() => { setEditingEntry(en.id); setEntryEdit({
                        partyName: en.party_name, tin: en.tin ?? "", reason: en.reason,
                        source: en.source, severity: en.severity, notes: en.notes ?? ""
                      }); }}>Edit</button>
                    <button type="button" disabled={busy} className="ml-12 underline"
                      style={{ color: en.status === "active" ? "var(--success)" : "var(--warning)" }}
                      onClick={() => setEntryStatus(en.id, en.status === "active" ? "lifted" : "active")}>
                      {en.status === "active" ? "Lift" : "Reinstate"}
                    </button>
                    <button type="button" disabled={busy} className="ml-12 underline" style={{ color: "var(--danger)" }}
                      onClick={() => removeEntry(en.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {ready && entries.length === 0 && (
                <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                  The watchlist is empty — add parties flagged by TRA, customs, the courts or your own risk review.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------- Recent checks ---------- */}
      <section className="mt-32">
        <h2 className={h2Cls} style={{ color: "var(--ink-soft)" }}>Screening log</h2>
        <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Subject</th><th className="p-12">Result</th>
                <th className="p-12">Matches</th><th className="p-12 text-right">Checked</th>
                <th className="p-12">By</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((k, i) => (
                <tr key={k.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-12" style={{ color: "var(--ink)" }}>
                    <span className="font-semibold">{k.subject_label}</span>
                    <span className="ml-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>
                      {k.subject_type === "shipment" ? "Cargo file" : "Client"}
                    </span>
                  </td>
                  <td className="p-12">
                    <span className="px-8 py-4 text-[10px] font-bold uppercase"
                      style={pill(k.result === "clear" ? "var(--success)" : "var(--danger)")}>
                      {k.result}
                    </span>
                  </td>
                  <td className="p-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {k.matches.length ? k.matches.map(m => `${m.name} → ${m.entryName}`).join("; ") : "—"}
                  </td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {new Date(k.checked_at).toLocaleString()}
                  </td>
                  <td className="p-12" style={{ color: "var(--ink-soft)" }}>{k.checked_by_name ?? "—"}</td>
                </tr>
              ))}
              {ready && checks.length === 0 && (
                <tr><td colSpan={5} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                  No checks yet — every screen you run is logged here for the file.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------- Licence register ---------- */}
      <section className="mt-32">
        <h2 className={h2Cls} style={{ color: "var(--ink-soft)" }}>Regulatory licence register</h2>
        <form onSubmit={addLicence} className="mt-16 grid grid-cols-2 gap-12 rounded-card border bg-surface p-24 md:grid-cols-6" style={cardStyle}>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Authority</span>
            <select value={licenceForm.authority} onChange={e => setLicenceForm(f => ({ ...f, authority: e.target.value }))}
              className={inputCls} style={inputStyle}>
              {Object.entries(AUTHORITY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="block md:col-span-2">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Licence *</span>
            <input required value={licenceForm.title} onChange={e => setLicenceForm(f => ({ ...f, title: e.target.value }))}
              placeholder="e.g. Customs clearing agent licence" className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Number</span>
            <input value={licenceForm.licenceNumber} onChange={e => setLicenceForm(f => ({ ...f, licenceNumber: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Issued</span>
            <input type="date" value={licenceForm.issuedDate}
              onChange={e => setLicenceForm(f => ({ ...f, issuedDate: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Expires *</span>
            <input required type="date" value={licenceForm.expiryDate}
              onChange={e => setLicenceForm(f => ({ ...f, expiryDate: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <label className="block md:col-span-5">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
            <input value={licenceForm.notes} onChange={e => setLicenceForm(f => ({ ...f, notes: e.target.value }))}
              className={inputCls} style={inputStyle} />
          </label>
          <button type="submit" disabled={busy}
            className="waisha-btn self-end rounded-input py-8 text-xs font-semibold disabled:opacity-60">
            Add licence
          </button>
        </form>

        <input ref={attachInput} type="file" hidden accept=".pdf,image/jpeg,image/png,image/webp"
          onChange={uploadAttachment} />

        <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Licence</th><th className="p-12">Number</th>
                <th className="p-12">Expires</th><th className="p-12 text-right">Days</th>
                <th className="p-12">Status</th><th className="p-12">Scan</th><th></th>
              </tr>
            </thead>
            <tbody>
              {licences.map((l, i) => editingLicence === l.id ? (
                <tr key={l.id} style={{ background: "var(--milk-deep)" }}>
                  <td className="p-12" colSpan={6}>
                    <div className="grid grid-cols-2 gap-8 md:grid-cols-5">
                      <select value={licenceEdit.authority} onChange={e => setLicenceEdit(f => ({ ...f, authority: e.target.value }))}
                        className={inputCls} style={inputStyle}>
                        {Object.entries(AUTHORITY_LABELS).map(([k, lab]) => <option key={k} value={k}>{lab}</option>)}
                      </select>
                      <input value={licenceEdit.title} placeholder="Licence"
                        onChange={e => setLicenceEdit(f => ({ ...f, title: e.target.value }))}
                        className={inputCls} style={inputStyle} />
                      <input value={licenceEdit.licenceNumber} placeholder="Number"
                        onChange={e => setLicenceEdit(f => ({ ...f, licenceNumber: e.target.value }))}
                        className={inputCls} style={inputStyle} />
                      <input type="date" value={licenceEdit.issuedDate}
                        onChange={e => setLicenceEdit(f => ({ ...f, issuedDate: e.target.value }))}
                        className={inputCls} style={inputStyle} />
                      <input type="date" value={licenceEdit.expiryDate}
                        onChange={e => setLicenceEdit(f => ({ ...f, expiryDate: e.target.value }))}
                        className={inputCls} style={inputStyle} />
                    </div>
                  </td>
                  <td className="p-12 text-right whitespace-nowrap">
                    <button type="button" disabled={busy} className="underline" style={{ color: "var(--success)" }}
                      onClick={() => saveLicence(l.id)}>Save</button>
                    <button type="button" className="ml-12 underline" style={{ color: "var(--ink-soft)" }}
                      onClick={() => setEditingLicence(null)}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={l.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="p-12" style={{ color: "var(--ink)" }}>
                    <span className="font-semibold">{l.title}</span>
                    <span className="ml-8 text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>
                      {AUTHORITY_LABELS[l.authority] ?? l.authority}
                    </span>
                    {l.issued_date && (
                      <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                        issued {fmtDate(l.issued_date)}
                      </span>
                    )}
                  </td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>{l.licence_number ?? "—"}</td>
                  <td className="p-12 tabular-nums" style={{ color: "var(--ink)" }}>{fmtDate(l.expiry_date)}</td>
                  <td className="p-12 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {l.days < 0 ? `${-l.days} ago` : l.days}
                  </td>
                  <td className="p-12">
                    <span className="px-8 py-4 text-[10px] font-bold uppercase" style={pill(LICENCE_STATUS_COLORS[l.status] ?? "var(--ink-soft)")}>
                      {l.status}
                    </span>
                  </td>
                  <td className="p-12 whitespace-nowrap">
                    {l.latest_document_id && (
                      <button type="button" className="underline" style={{ color: "var(--brand)" }}
                        onClick={() => viewAttachment(l.latest_document_id!)}>
                        View{l.document_count > 1 ? ` (${l.document_count})` : ""}
                      </button>
                    )}
                    <button type="button" disabled={busy}
                      className={l.latest_document_id ? "ml-12 underline" : "underline"}
                      style={{ color: "var(--ink-soft)" }}
                      onClick={() => pickAttachment(l.id)}>Attach</button>
                  </td>
                  <td className="p-12 text-right whitespace-nowrap">
                    <button type="button" className="underline" style={{ color: "var(--ink-soft)" }}
                      onClick={() => { setEditingLicence(l.id); setLicenceEdit({
                        authority: l.authority, title: l.title, licenceNumber: l.licence_number ?? "",
                        issuedDate: l.issued_date ? String(l.issued_date).slice(0, 10) : "",
                        expiryDate: String(l.expiry_date).slice(0, 10), notes: l.notes ?? ""
                      }); }}>
                      {l.status === "expired" ? "Renew" : "Edit"}
                    </button>
                    <button type="button" disabled={busy} className="ml-12 underline" style={{ color: "var(--danger)" }}
                      onClick={() => removeLicence(l.id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {ready && licences.length === 0 && (
                <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                  No licences tracked yet — add the company&apos;s TRA, BRELA and bond permits to get renewal alerts 30 days out.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-16 text-xs" style={{ color: "var(--ink-soft)" }}>
        Renewal alerts appear in <Link href="/app/notifications" className="underline">Alerts</Link> and the{" "}
        <Link href="/app/cfa/calendar" className="underline">ETA calendar</Link>. Licence scans live in the{" "}
        <Link href="/app/documents" className="underline">documents vault</Link>.
      </p>
    </div>
  );
}
