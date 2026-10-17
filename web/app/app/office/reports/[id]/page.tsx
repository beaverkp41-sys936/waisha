"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "../../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Signoff {
  id: string; role: string; signatoryName: string; signatoryTitle: string | null;
  note: string | null; signedBy: string | null; signedAt: string;
}
interface Report {
  id: string; employee_id: string; status: string;
  period_start: string | null; period_end: string | null;
  tasks_total: number; tasks_done: number; tasks_on_time: number;
  grade_task_completion: number | null; grade_punctuality: number | null;
  grade_client_satisfaction: number | null; grade_collaboration: number | null;
  task_overview: string | null; attendance_note: string | null; supervisor_remarks: string | null;
  generated_at: string | null; completed_at: string | null;
  full_name: string; job_title: string | null; department: string | null;
  college: string | null; academic_status: string | null; gender: string | null;
  qualifications: string[] | null; date_of_birth: string | null; age: number | null;
  employment_type: string; intern_absorbed: boolean;
  contract_start: string | null; contract_end: string | null;
  supervisor_name: string | null; supervisor_title: string | null;
  photo_document_id: string | null; signoffs: Signoff[];
}
interface Letterhead {
  company_name: string | null; tin_display: string | null; vat_number: string | null;
  website: string | null; postal_address: string | null; street: string | null;
  branch_email: string | null; logo_document_id: string | null;
}

const ROLES = [
  { key: "hod", label: "Head of Department" },
  { key: "hr_manager", label: "HR Manager" },
  { key: "direct_supervisor", label: "Direct Supervisor" }
] as const;

const GRADES = [
  { key: "taskCompletion", label: "Task completion", field: "grade_task_completion" as const },
  { key: "punctuality", label: "Punctuality", field: "grade_punctuality" as const },
  { key: "clientSatisfaction", label: "Client satisfaction", field: "grade_client_satisfaction" as const },
  { key: "collaboration", label: "Collaboration", field: "grade_collaboration" as const }
] as const;

const fmt = (v: string | null) => (v ? new Date(v).toLocaleString() : "—");
const day = (v: string | null) => (v ? new Date(v).toLocaleDateString() : "—");

/** Only the fixed vocabularies get a label — a name, college or qualification prints as typed. */
const GENDER_LABELS: Record<string, string> = { male: "Male", female: "Female", other: "Other" };
const ACADEMIC_LABELS: Record<string, string> = { student: "Student", graduate: "Graduate" };
const ENGAGEMENT_LABELS: Record<string, string> = {
  permanent: "Permanent", fixed_term: "Fixed-term", intern: "Trainee"
};

export default function TraineeReportPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [report, setReport] = useState<Report | null>(null);
  const [letterhead, setLetterhead] = useState<Letterhead | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [armDiscard, setArmDiscard] = useState(false);

  const [form, setForm] = useState({
    attendanceNote: "", supervisorRemarks: "",
    taskCompletion: 3, punctuality: 3, clientSatisfaction: 3, collaboration: 3
  });
  const [signs, setSigns] = useState<Record<string, { name: string; title: string }>>({
    hod: { name: "", title: "" }, hr_manager: { name: "", title: "" }, direct_supervisor: { name: "", title: "" }
  });

  const load = useCallback(async () => {
    const res = await apiFetch(`/trainee-reports/${id}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Could not open the report.")); setReady(true); return; }
    const r: Report = j.report;
    setReport(r);
    setLetterhead(j.letterhead ?? null);
    setForm({
      attendanceNote: r.attendance_note ?? "", supervisorRemarks: r.supervisor_remarks ?? "",
      taskCompletion: r.grade_task_completion ?? 3, punctuality: r.grade_punctuality ?? 3,
      clientSatisfaction: r.grade_client_satisfaction ?? 3, collaboration: r.grade_collaboration ?? 3
    });
    setError(null);
    setReady(true);
    for (const [docId, setter] of [[r.photo_document_id, setPhotoUrl], [j.letterhead?.logo_document_id, setLogoUrl]] as const) {
      if (!docId) continue;
      const u = await apiFetch(`/documents/${docId}/url`);
      if (u.ok) setter((await u.json()).url);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const signed = report?.signoffs ?? [];
  const signedCount = signed.length;
  const isDraft = report?.status === "draft";
  const remarks = (form.supervisorRemarks ?? "").trim();

  async function save() {
    setBusy(true); setError(null); setNotice(null); setRefused(null);
    try {
      const res = await apiFetch(`/trainee-reports/${id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attendanceNote: form.attendanceNote || null,
          supervisorRemarks: form.supervisorRemarks || null,
          taskCompletion: form.taskCompletion, punctuality: form.punctuality,
          clientSatisfaction: form.clientSatisfaction, collaboration: form.collaboration
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the page.")); return; }
      setNotice("Saved.");
      await load();
    } finally { setBusy(false); }
  }

  async function sign(role: string) {
    const s = signs[role];
    if (!s?.name?.trim()) { setError("A signature needs the person's name."); return; }
    setBusy(true); setError(null); setNotice(null); setRefused(null);
    try {
      const res = await apiFetch(`/trainee-reports/${id}/signoffs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, signatoryName: s.name.trim(), signatoryTitle: s.title.trim() || null })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "The signature was not registered.")); return; }
      setSigns(prev => ({ ...prev, [role]: { name: "", title: "" } }));
      await load();
    } finally { setBusy(false); }
  }

  async function unsign(signoff: Signoff) {
    setBusy(true); setError(null);
    try {
      const res = await apiFetch(`/trainee-report-signoffs/${signoff.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "That signature cannot be pulled.")); return; }
      await load();
    } finally { setBusy(false); }
  }

  async function act(kind: "close" | "reopen") {
    setBusy(true); setError(null); setNotice(null); setRefused(null);
    try {
      const res = await apiFetch(`/trainee-reports/${id}/${kind}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = errorText(j, "The page refused.");
        // The database holds these rules, so its sentence is the honest reason.
        if (res.status === 409) setRefused(message); else setError(message);
        return;
      }
      setNotice(kind === "close" ? "The report is signed off." : "Reopened as a draft.");
      await load();
    } finally { setBusy(false); }
  }

  /** Discard is a two-tap control: the first tap arms it, the second one removes the page. */
  function askDiscard() {
    if (!armDiscard) {
      setArmDiscard(true);
      setTimeout(() => setArmDiscard(false), 6000);
      return;
    }
    discard();
  }

  async function discard() {
    setBusy(true); setError(null); setNotice(null); setRefused(null);
    try {
      const res = await apiFetch(`/trainee-reports/${id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "The draft was not removed.")); return; }
    } finally { setBusy(false); }
    router.push("/app/office/reports");
  }

  if (!ready) return <div className="px-16 py-32"><p className="pane-note text-xs">Loading…</p></div>;
  if (!report) return (
    <div className="px-16 py-32">
      <div role="alert" className="rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
        {error ?? "Report not found."}{" "}
        <Link href="/app/office/reports" className="underline">Back to the register</Link>
      </div>
    </div>
  );

  const inputCls = "w-full rounded-input border px-10 py-6 text-xs";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <div className="no-print flex flex-wrap items-center justify-between gap-12">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.2em]" style={{ color: "var(--gold-green)" }}>
            {report.status === "complete" ? "Signed off" : "Draft — not yet an official page"}
          </p>
          <h1 className="mt-4 text-xl font-bold" style={{ color: "var(--ink)" }}>
            {report.full_name}
          </h1>
        </div>
        <div className="flex flex-wrap gap-8">
          <Link href="/app/office/reports" className="on-photo-btn rounded-input px-14 py-8 text-xs">
            Register
          </Link>
          <button type="button" onClick={() => window.print()}
            className="on-photo-btn rounded-input px-14 py-8 text-xs">Print / Save as PDF</button>
          {isDraft && (
            <>
              <button type="button" disabled={busy} onClick={save}
                className="rounded-input px-16 py-8 text-xs font-bold"
                style={{ background: "var(--brand)", color: "var(--on-solid)", opacity: busy ? 0.6 : 1 }}>
                Save the page
              </button>
              <button type="button" disabled={busy || signedCount < 3 || !remarks} onClick={() => act("close")}
                className="rounded-input px-16 py-8 text-xs font-bold"
                style={{
                  background: "var(--success)", color: "var(--on-solid)",
                  opacity: busy || signedCount < 3 || !remarks ? 0.45 : 1
                }}>
                Sign it off ({signedCount}/3)
              </button>
              <button type="button" disabled={busy || signedCount > 0} onClick={askDiscard}
                className="rounded-input border px-14 py-8 text-xs"
                style={{
                  borderColor: armDiscard ? "var(--danger)" : "var(--line)",
                  color: "var(--danger)",
                  opacity: busy || signedCount > 0 ? 0.45 : 1
                }}>
                {armDiscard ? "Tap again to discard" : "Discard draft"}
              </button>
            </>
          )}
          {report.status === "complete" && (
            <button type="button" disabled={busy} onClick={() => act("reopen")}
              className="on-photo-btn rounded-input px-14 py-8 text-xs">
              Reopen to correct a signature
            </button>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" className="no-print rounded-card border bg-surface p-16 text-xs"
          style={{ borderColor: "var(--line)", borderLeft: "4px solid var(--danger)", marginTop: 16 }}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="no-print rounded-card border bg-surface p-16 text-xs"
          style={{ borderColor: "var(--line)", borderLeft: "4px solid var(--success)", marginTop: 16 }}>
          {notice}
        </div>
      )}
      {refused && (
        <div role="alert" className="no-print mt-16 rounded-card border bg-surface p-16 text-xs"
          style={{ borderColor: "var(--line)", borderLeft: "4px solid var(--warning)" }}>
          {refused}
        </div>
      )}

      {/* The page itself — one sheet, printed as it reads. */}
      <div className="report-sheet mt-24 rounded-card border bg-surface p-32"
        style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
        <header className="flex items-start justify-between gap-24 border-b pb-16"
          style={{ borderColor: "var(--line)" }}>
          <div className="flex items-center gap-16">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="h-44 w-44 object-contain" />
            ) : null}
            <div>
              <p className="text-sm font-bold">{letterhead?.company_name ?? ""}</p>
              <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                {[letterhead?.postal_address, letterhead?.street].filter(Boolean).join(" · ")}
                {letterhead?.tin_display ? ` · TIN ${letterhead.tin_display}` : ""}
                {letterhead?.branch_email ? ` · ${letterhead.branch_email}` : ""}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-bold uppercase tracking-[0.14em]">Trainee performance</p>
            <p className="text-[11px] font-bold uppercase tracking-[0.14em]">&amp; completion report</p>
            <p className="mt-6 text-[10px]" style={{ color: "var(--ink-soft)" }}>
              Issued {fmt(report.generated_at)}
            </p>
          </div>
        </header>

        <section className="mt-20 flex gap-24">
          {photoUrl && (
            <img src={photoUrl} alt={report.full_name}
              className="h-[96px] w-[80px] rounded-card border object-cover" style={{ borderColor: "var(--line)" }} />
          )}
          <dl className="grid flex-1 grid-cols-1 gap-x-24 gap-y-10 text-xs sm:grid-cols-2">
            <Field label="Legal name (as on NIDA)" value={report.full_name} />
            <Field label="Department" value={report.department} />
            <Field label="Age" value={report.age != null ? `${report.age} (born ${day(report.date_of_birth)})` : day(report.date_of_birth)} />
            <Field label="Gender" value={report.gender ? GENDER_LABELS[report.gender] ?? report.gender : null} />
            <Field label="Academic status"
              value={report.academic_status ? ACADEMIC_LABELS[report.academic_status] ?? report.academic_status : null} />
            <Field label="College" value={report.college} />
            <Field label="Qualifications" value={(report.qualifications ?? []).join(", ") || null} />
            <Field label="Engagement"
              value={`${ENGAGEMENT_LABELS[report.employment_type] ?? report.employment_type}${report.intern_absorbed ? " — absorbed" : ""}`} />
            <Field label="Training period"
              value={`${day(report.period_start)} → ${day(report.period_end)}`} />
            <Field label="Direct supervisor"
              value={[report.supervisor_name, report.supervisor_title].filter(Boolean).join(", ") || null} />
          </dl>
        </section>

        <section className="mt-24">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--gold-green)" }}>
            Work carried out
          </h2>
          <div className="mt-10 grid grid-cols-3 gap-16 text-center">
            <Stat label="Tasks given" value={String(report.tasks_total)} />
            <Stat label="Tasks completed" value={String(report.tasks_done)} />
            <Stat label="Completed on time"
              value={report.tasks_done ? `${Math.round((report.tasks_on_time / report.tasks_done) * 100)}%` : "—"} />
          </div>
          <p className="mt-12 whitespace-pre-line text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
            {report.task_overview || "No tasks fall inside this period."}
          </p>
        </section>

        <section className="mt-24 grid grid-cols-1 gap-20 md:grid-cols-2">
          <div>
            <h2 className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--gold-green)" }}>
              Attendance
            </h2>
            {isDraft ? (
              <textarea className={inputCls + " mt-8 min-h-[72px]"} style={inputStyle} value={form.attendanceNote}
                onChange={e => setForm({ ...form, attendanceNote: e.target.value })} maxLength={1000} />
            ) : (
              <p className="mt-8 whitespace-pre-line text-xs">{report.attendance_note || "—"}</p>
            )}
          </div>
          <div>
            <h2 className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--gold-green)" }}>
              Competency grades (1 weak — 5 outstanding)
            </h2>
            <table className="mt-8 w-full text-xs">
              <tbody>
                {GRADES.map(g => (
                  <tr key={g.key} className="border-t" style={{ borderColor: "var(--line)" }}>
                    <td className="py-6" style={{ color: "var(--ink-soft)" }}>{g.label}</td>
                    <td className="py-6 text-right">
                      {isDraft ? (
                        <select className="rounded-input border px-8 py-4 text-xs" style={inputStyle}
                          value={form[g.key as keyof typeof form] as number}
                          onChange={e => setForm({ ...form, [g.key]: Number(e.target.value) })}>
                          {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      ) : (
                        <strong>{report[g.field] ?? "—"}</strong>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-24">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--gold-green)" }}>
            Supervisor remarks
          </h2>
          {isDraft ? (
            <textarea className={inputCls + " mt-8 min-h-[96px]"} style={inputStyle} value={form.supervisorRemarks}
              onChange={e => setForm({ ...form, supervisorRemarks: e.target.value })}
              placeholder="What the trainee actually did, what they must carry into the next post — this must be written before the page can be signed."
              maxLength={4000} />
          ) : (
            <p className="mt-8 whitespace-pre-line text-xs">{report.supervisor_remarks || "—"}</p>
          )}
        </section>

        <section className="mt-28 border-t pt-20" style={{ borderColor: "var(--line)" }}>
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--gold-green)" }}>
            Official sign-off
          </h2>
          <div className="mt-16 grid grid-cols-1 gap-20 md:grid-cols-3">
            {ROLES.map(role => {
              const on = signed.find(s => s.role === role.key);
              return (
                <div key={role.key} className="sig-block rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                    {role.label}
                  </p>
                  {on ? (
                    <>
                      <p className="mt-10 text-xs font-bold">{on.signatoryName}</p>
                      <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        {on.signatoryTitle ?? "—"} · {fmt(on.signedAt)}
                      </p>
                      {on.note && <p className="mt-6 text-[10px]">{on.note}</p>}
                      {isDraft && (
                        <button type="button" disabled={busy} onClick={() => unsign(on)}
                          className="no-print mt-10 on-photo-btn px-8 py-4 text-[10px]">
                          Pull this signature
                        </button>
                      )}
                    </>
                  ) : isDraft ? (
                    <div className="no-print mt-10 space-y-8">
                      <input className={inputCls} style={inputStyle} placeholder="Name of signatory"
                        value={signs[role.key].name} maxLength={160}
                        onChange={e => setSigns(p => ({ ...p, [role.key]: { ...p[role.key], name: e.target.value } }))} />
                      <input className={inputCls} style={inputStyle} placeholder="Title (optional)"
                        value={signs[role.key].title} maxLength={120}
                        onChange={e => setSigns(p => ({ ...p, [role.key]: { ...p[role.key], title: e.target.value } }))} />
                      <button type="button" disabled={busy} onClick={() => sign(role.key)}
                        className="rounded-input px-12 py-6 text-[11px] font-bold"
                        style={{ background: "var(--brand)", color: "var(--on-solid)", opacity: busy ? 0.6 : 1 }}>
                        Sign this block
                      </button>
                    </div>
                  ) : (
                    <p className="mt-10 text-[10px]" style={{ color: "var(--danger)" }}>Not signed</p>
                  )}
                  <div className="mt-16 border-t pt-6" style={{ borderColor: "var(--line)" }}>
                    <p className="text-[9px] uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      Signature
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-16 text-[10px]" style={{ color: "var(--ink-soft)" }}>
            {report.status === "complete"
              ? `Signed off ${fmt(report.completed_at)}. This page is a record: it cannot be edited, deleted or unsigned as it stands.`
              : `The page becomes official when all three blocks above carry a name and the supervisor remarks are written. ${signedCount}/3 signed.`}
          </p>
        </section>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
        {label}
      </dt>
      <dd className="mt-2" style={{ color: "var(--ink)" }}>{value || "—"}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border p-12" style={{ borderColor: "var(--line)" }}>
      <p className="text-lg font-bold">{value}</p>
      <p className="mt-2 text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</p>
    </div>
  );
}
