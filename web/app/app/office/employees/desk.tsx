"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch, seatPermissions } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}

interface Employee {
  id: string; full_name: string; job_title: string | null; department: string | null;
  skills: string[]; employment_type: string; status: string; intern_absorbed: boolean;
  hired_date: string | null; contract_start: string | null; contract_end: string | null;
  contract_days: number | null; monthly_salary: number | null;
  supervisor_id: string | null; supervisor_name: string | null;
  leave_approver_user_id: string | null; leave_approver_name: string | null;
  user_id: string | null; notes: string | null; has_phone: boolean;
  open_tasks: number; overdue_tasks: number; done_tasks: number; late_tasks: number;
  flowed_tasks: number;
  evaluation_count: number; rating: number | null; rating_period: string | null;
  document_count: number; latest_document_id: string | null;
  date_of_birth: string | null; age: number | null; gender: string | null;
  academic_status: string | null; college: string | null; qualifications: string[] | null;
  emergency_contact_name: string | null; emergency_relationship: string | null;
  has_emergency_phone: boolean; avatar_document_id: string | null;
}
interface Task {
  id: string; employee_id: string; employee_name: string; department: string | null;
  shipment_id: string | null; file_number: string | null;
  file_stage: string | null; file_status: string | null; file_eta: string | null;
  file_consignee: string | null; file_live: boolean;
  file_stages_total: number; file_stages_done: number; file_tasks_open: number;
  requested_by_name: string | null;
  title: string; priority: string; due_date: string | null; days: number | null;
  status: string; done_at: string | null; on_time: boolean | null; notes: string | null;
  created_at: string;
}
interface Evaluation {
  id: string; employee_id: string; employee_name: string; department: string | null;
  period: string; task_completion: number; punctuality: number;
  client_satisfaction: number; collaboration: number; average: number;
  notes: string | null; evaluated_by: string | null; evaluated_by_name: string | null;
  created_at: string;
}
interface FileOption { id: string; file_number: string; status: string; stage: string }

/** Where a cargo file has got to, spelled the way the CFA page spells it. */
const FILE_STAGES: Record<string, string> = {
  pre_arrival: "Pre-arrival", arrival: "Arrival", customs: "Customs",
  inspection: "Inspection", release: "Release", exit: "Exit"
};
const FILE_STATUS_LABELS: Record<string, string> = {
  open: "Open", on_hold: "On hold", completed: "Completed", cancelled: "Cancelled"
};

const EMPLOYMENT_LABELS: Record<string, string> = {
  permanent: "Permanent", fixed_term: "Fixed-term", intern: "Trainee"
};
const STATUS_LABELS: Record<string, string> = { active: "Active", inactive: "Inactive", left: "Left" };
const GENDER_LABELS: Record<string, string> = { male: "Male", female: "Female", other: "Other" };
const ACADEMIC_LABELS: Record<string, string> = { student: "Student", graduate: "Graduate" };
/** The spec caps the profile picture at 1 MB, and the cap is held client-side. */
const MAX_PHOTO_BYTES = 1024 * 1024;
const STATUS_COLORS: Record<string, string> = {
  active: "var(--success)", inactive: "var(--ink-soft)", left: "var(--danger)"
};
const PRIORITY_COLORS: Record<string, string> = {
  urgent: "var(--danger)", high: "var(--warning)", normal: "var(--brand)", low: "var(--ink-soft)"
};
const TASK_STATUS_LABELS: Record<string, string> = {
  pending: "Pending", in_progress: "In progress", done: "Done", cancelled: "Cancelled"
};
const TASK_STATUS_COLORS: Record<string, string> = {
  pending: "var(--warning)", in_progress: "var(--brand)", done: "var(--success)", cancelled: "var(--ink-soft)"
};
const SCORES = [1, 2, 3, 4, 5];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "roster", label: "Roster" },
  { key: "tasks", label: "Tasks & Files" },
  { key: "evaluations", label: "Evaluations" },
  { key: "contracts", label: "Contracts" },
  { key: "trainees", label: "Trainees" },
  { key: "reports", label: "Reports" }
] as const;
type View = typeof TABS[number]["key"];

/** The CFA mount carries the working half of the same staff book. Grades, the trainee register and
 *  the office reports are Enterprise office desks in their own right, so they stay there. */
const CFA_TABS: View[] = ["overview", "roster", "tasks", "contracts"];

const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : "—");
const fmtPeriod = (v: string | null) => {
  if (!v) return "—";
  const [y, m] = v.split("-").map(Number);
  return `${MONTH_NAMES[(m ?? 1) - 1] ?? m} ${y}`;
};
const onTimePct = (e: { done_tasks: number; late_tasks: number }) =>
  e.done_tasks ? Math.round(((e.done_tasks - e.late_tasks) / e.done_tasks) * 100) : null;

/** Age for the hint while the date is still being typed; the register stores the date. */
const yearsSince = (d: string | null) => {
  if (!d) return null;
  const dob = new Date(`${d}T00:00:00`);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let n = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) n -= 1;
  return n;
};

/** Two letters stand in for a person until their picture is on file. */
function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
}

function Avatar({ name, url }: { name: string; url?: string | null }) {
  return (
    <span className="flex h-48 w-48 shrink-0 items-center justify-center overflow-hidden rounded-full border text-xs font-bold uppercase"
      style={{ borderColor: "var(--line)", background: "var(--milk-deep)", color: "var(--ink-soft)" }}>
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : initialsOf(name)}
    </span>
  );
}

function gradeOf(e: Employee): string {
  const parts: number[] = [];
  const ot = onTimePct(e);
  if (ot !== null) parts.push(ot);
  if (e.rating !== null) parts.push(e.rating * 20);
  if (!parts.length) return "—";
  const score = parts.reduce((a, b) => a + b, 0) / parts.length;
  return score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "D";
}

interface EmpForm {
  fullName: string; phone: string; jobTitle: string; department: string; skills: string;
  employmentType: string; status: string; hiredDate: string; contractStart: string;
  contractEnd: string; supervisorId: string; leaveApproverUserId: string; monthlySalary: string; notes: string;
  dateOfBirth: string; gender: string; academicStatus: string; college: string;
  qualifications: string; emergencyContactName: string; emergencyRelationship: string;
  emergencyPhone: string;
}
const EMPTY_EMP: EmpForm = {
  fullName: "", phone: "", jobTitle: "", department: "", skills: "",
  employmentType: "permanent", status: "active", hiredDate: "", contractStart: "",
  contractEnd: "", supervisorId: "", leaveApproverUserId: "", monthlySalary: "", notes: "",
  dateOfBirth: "", gender: "", academicStatus: "", college: "", qualifications: "",
  emergencyContactName: "", emergencyRelationship: "", emergencyPhone: ""
};
interface TaskForm {
  employeeId: string; shipmentId: string; title: string; priority: string;
  dueDate: string; notes: string;
}
const EMPTY_TASK: TaskForm = { employeeId: "", shipmentId: "", title: "", priority: "normal", dueDate: "", notes: "" };
interface EvalForm {
  employeeId: string; period: string; taskCompletion: number; punctuality: number;
  clientSatisfaction: number; collaboration: number; notes: string;
}
const EMPTY_EVAL: EvalForm = {
  employeeId: "", period: new Date().toISOString().slice(0, 7),
  taskCompletion: 3, punctuality: 3, clientSatisfaction: 3, collaboration: 3, notes: ""
};

/** One staff book serves the whole company, but a clearing house lives in the CFA area, so the same
 *  component mounts from either home. Only the way back and the tab list change. */
const AREA_HOME: Record<string, { href: string; label: string }> = {
  office: { href: "/app/office", label: "← Office area" },
  cfa: { href: "/app/cfa", label: "← CFA area" }
};

export function StaffDesk({ area = "office" }: { area?: "office" | "cfa" }) {
  const home = AREA_HOME[area] ?? AREA_HOME.office;
  const tabs = area === "cfa" ? TABS.filter(t => CFA_TABS.includes(t.key)) : TABS;
  const [view, setView] = useState<View>("overview");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [files, setFiles] = useState<FileOption[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [empForm, setEmpForm] = useState(EMPTY_EMP);
  const [editingEmp, setEditingEmp] = useState<string | null>(null);

  const [taskForm, setTaskForm] = useState(EMPTY_TASK);
  const [editingTask, setEditingTask] = useState<string | null>(null);

  const [evalForm, setEvalForm] = useState(EMPTY_EVAL);
  const [editingEval, setEditingEval] = useState<string | null>(null);

  const [renewingId, setRenewingId] = useState<string | null>(null);
  const [renewForm, setRenewForm] = useState({ start: "", end: "" });

  // Whether this seat may follow a job out to the cargo file it names, and
  // whether it may use the file's conversation. A seat that may not still sees
  // the file's state on the task — it just gets no link.
  const [fileAccess, setFileAccess] = useState({ open: false, message: false });
  const [filesBlocked, setFilesBlocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    seatPermissions().then(keys => {
      if (cancelled) return;
      setFileAccess({ open: keys.has("shipments.view"), message: keys.has("messages.view") });
    });
    return () => { cancelled = true; };
  }, []);

  const attachInput = useRef<HTMLInputElement | null>(null);
  const attachTargetRef = useRef<string | null>(null);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const photoTargetRef = useRef<string | null>(null);
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [e, t, v, f] = await Promise.all([
      apiFetch("/employees"),
      apiFetch("/office-tasks"),
      apiFetch("/evaluations"),
      apiFetch("/cargo")
    ]);
    if (e.ok) setEmployees(await e.json());
    if (t.ok) setTasks(await t.json());
    if (v.ok) setEvaluations(await v.json());
    if (f.ok) setFiles((await f.json()).filter((x: FileOption) => x.status === "open"));
    else setFilesBlocked(true);
    if (!e.ok && !t.ok && !v.ok) setError(errorText(null, "Could not load office data."));
    setReady(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Signed URLs are resolved once per photo — an <img> cannot carry the bearer
  // token, and the roster only asks for the documents it actually shows.
  useEffect(() => {
    const missing = employees.filter(e => e.avatar_document_id && !avatarUrls[e.avatar_document_id]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(missing.map(async e => {
        const res = await apiFetch(`/documents/${e.avatar_document_id}/url`);
        if (!res.ok) return null;
        const j = await res.json();
        return [e.avatar_document_id as string, j.url] as const;
      }));
      if (!cancelled) {
        setAvatarUrls(prev => ({ ...prev, ...Object.fromEntries(entries.filter(Boolean) as any) }));
      }
    })();
    return () => { cancelled = true; };
  }, [employees]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Employees ----------

  function startEditEmp(e: Employee) {
    setEditingEmp(e.id);
    setEmpForm({
      fullName: e.full_name, phone: "", jobTitle: e.job_title ?? "",
      department: e.department ?? "", skills: (e.skills ?? []).join(", "),
      employmentType: e.employment_type, status: e.status,
      hiredDate: e.hired_date ?? "", contractStart: e.contract_start ?? "",
      contractEnd: e.contract_end ?? "", supervisorId: e.supervisor_id ?? "",
      leaveApproverUserId: e.leave_approver_user_id ?? "",
      monthlySalary: e.monthly_salary != null ? String(e.monthly_salary) : "",
      notes: e.notes ?? "",
      dateOfBirth: e.date_of_birth ?? "", gender: e.gender ?? "",
      academicStatus: e.academic_status ?? "", college: e.college ?? "",
      qualifications: (e.qualifications ?? []).join(", "),
      emergencyContactName: e.emergency_contact_name ?? "",
      emergencyRelationship: e.emergency_relationship ?? "", emergencyPhone: ""
    });
    setError(null); setNotice(null);
  }

  async function submitEmp(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const skills = empForm.skills.split(",").map(s => s.trim()).filter(Boolean);
      const qualifications = empForm.qualifications.split(",").map(s => s.trim()).filter(Boolean);
      const base = {
        // One name, taken exactly as NIDA has it — the report sheet prints this.
        fullName: empForm.fullName, jobTitle: empForm.jobTitle || null,
        department: empForm.department || null, skills,
        employmentType: empForm.employmentType, status: empForm.status,
        hiredDate: empForm.hiredDate || null,
        contractStart: empForm.contractStart || null,
        contractEnd: empForm.contractEnd || null,
        supervisorId: empForm.supervisorId || null,
        monthlySalary: empForm.monthlySalary ? Number(empForm.monthlySalary) : null,
        notes: empForm.notes || null,
        dateOfBirth: empForm.dateOfBirth || null,
        gender: empForm.gender || null,
        academicStatus: empForm.academicStatus || null,
        college: empForm.college || null,
        qualifications,
        emergencyContactName: empForm.emergencyContactName || null,
        emergencyRelationship: empForm.emergencyRelationship || null
      };
      // Phones are stored encrypted and never come back, so a blank box means
      // "keep what is on file" rather than "clear it".
      const payload: any = { ...base };
      if (editingEmp) {
        if (empForm.phone) payload.phone = empForm.phone;
        if (empForm.emergencyPhone) payload.emergencyPhone = empForm.emergencyPhone;
        // Only an edit carries this: a person is hired into a job first, and the office says
        // who decides their leave once they are on the roster with a seat of their own.
        payload.leaveApproverUserId = empForm.leaveApproverUserId || null;
      } else {
        payload.phone = empForm.phone || null;
        payload.emergencyPhone = empForm.emergencyPhone || null;
      }
      const res = await apiFetch(editingEmp ? `/employees/${editingEmp}` : "/employees", {
        method: editingEmp ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the employee.")); return; }
      setNotice(editingEmp ? "Employee updated." : "Employee added to the roster.");
      setEmpForm(EMPTY_EMP); setEditingEmp(null);
      await load();
    } finally { setBusy(false); }
  }

  async function setEmpStatus(e: Employee, status: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/employees/${e.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to change the status.")); return; }
      setNotice(status === "active"
        ? `${e.full_name} is active again.`
        : `${e.full_name} marked ${status}.`);
      await load();
    } finally { setBusy(false); }
  }

  async function removeEmp(e: Employee) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/employees/${e.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to remove the employee.")); return; }
      setNotice(`${e.full_name} removed — open assignments were cancelled and contract scans detached.`);
      await load();
    } finally { setBusy(false); }
  }

  async function absorbIntern(e: Employee) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/employees/${e.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employmentType: "permanent", absorbed: true })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to absorb the trainee.")); return; }
      setNotice(`${e.full_name} absorbed as permanent staff.`);
      await load();
    } finally { setBusy(false); }
  }

  // ---------- Office tasks ----------

  function startEditTask(t: Task) {
    setEditingTask(t.id);
    setTaskForm({
      employeeId: t.employee_id, shipmentId: t.shipment_id ?? "",
      title: t.title, priority: t.priority, dueDate: t.due_date ?? "", notes: t.notes ?? ""
    });
    setError(null); setNotice(null);
  }

  async function submitTask(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const payload = {
        employeeId: taskForm.employeeId, shipmentId: taskForm.shipmentId || null,
        title: taskForm.title, priority: taskForm.priority,
        dueDate: taskForm.dueDate || null, notes: taskForm.notes || null
      };
      const res = await apiFetch(editingTask ? `/office-tasks/${editingTask}` : "/office-tasks", {
        method: editingTask ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the task.")); return; }
      setNotice(editingTask ? "Task updated." : "Task assigned.");
      setTaskForm(EMPTY_TASK); setEditingTask(null);
      await load();
    } finally { setBusy(false); }
  }

  async function setTaskStatus(t: Task, status: string) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/office-tasks/${t.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to change the task.")); return; }
      setNotice(status === "done" ? `Done: ${t.title}` : `Task ${TASK_STATUS_LABELS[status]?.toLowerCase() ?? status}.`);
      await load();
    } finally { setBusy(false); }
  }

  async function removeTask(t: Task) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/office-tasks/${t.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to delete the task.")); return; }
      setNotice("Task deleted.");
      await load();
    } finally { setBusy(false); }
  }

  // ---------- Evaluations ----------

  function startEditEval(ev: Evaluation) {
    setEditingEval(ev.id);
    setEvalForm({
      employeeId: ev.employee_id, period: ev.period.slice(0, 7),
      taskCompletion: ev.task_completion, punctuality: ev.punctuality,
      clientSatisfaction: ev.client_satisfaction, collaboration: ev.collaboration,
      notes: ev.notes ?? ""
    });
    setError(null); setNotice(null);
  }

  async function submitEval(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const payload = {
        employeeId: evalForm.employeeId, period: evalForm.period,
        taskCompletion: evalForm.taskCompletion, punctuality: evalForm.punctuality,
        clientSatisfaction: evalForm.clientSatisfaction, collaboration: evalForm.collaboration,
        notes: evalForm.notes || null
      };
      const res = await apiFetch(editingEval ? `/evaluations/${editingEval}` : "/evaluations", {
        method: editingEval ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to save the evaluation.")); return; }
      setNotice(editingEval ? "Evaluation updated." : "Evaluation recorded.");
      setEvalForm(EMPTY_EVAL); setEditingEval(null);
      await load();
    } finally { setBusy(false); }
  }

  async function removeEval(ev: Evaluation) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/evaluations/${ev.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to delete the evaluation.")); return; }
      setNotice("Evaluation deleted.");
      await load();
    } finally { setBusy(false); }
  }

  // ---------- Contracts ----------

  function startRenew(e: Employee) {
    setRenewingId(e.id);
    setRenewForm({ start: e.contract_start ?? "", end: e.contract_end ?? "" });
    setError(null); setNotice(null);
  }

  async function saveRenew(e: Employee) {
    setError(null); setNotice(null); setBusy(true);
    try {
      const res = await apiFetch(`/employees/${e.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractStart: renewForm.start || null,
          contractEnd: renewForm.end || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to renew the contract.")); return; }
      setNotice(`Contract dates saved for ${e.full_name}.`);
      setRenewingId(null);
      await load();
    } finally { setBusy(false); }
  }

  // ---------- Contract scans ----------

  function pickAttachment(employeeId: string) {
    attachTargetRef.current = employeeId;
    attachInput.current?.click();
  }

  async function uploadAttachment(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    const employeeId = attachTargetRef.current;
    attachTargetRef.current = null;
    if (!f || !employeeId) return;
    setError(null); setNotice(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("entityType", "employee");
      fd.append("entityId", employeeId);
      fd.append("kind", "contract");
      fd.append("file", f);
      const res = await apiFetch("/documents", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Upload failed.")); return; }
      setNotice("Contract scan attached.");
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

  // ---------- Profile picture ----------

  function pickPhoto(employeeId: string) {
    photoTargetRef.current = employeeId;
    photoInput.current?.click();
  }

  async function uploadPhoto(ev: React.ChangeEvent<HTMLInputElement>) {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    const employeeId = photoTargetRef.current;
    photoTargetRef.current = null;
    if (!f || !employeeId) return;
    setError(null); setNotice(null);
    if (!f.type.startsWith("image/")) { setError("A profile picture has to be an image file."); return; }
    if (f.size > MAX_PHOTO_BYTES) {
      setError(
        `That photo is ${(f.size / (1024 * 1024)).toFixed(2)} MB. The entry form caps a profile ` +
        "picture at 1 MB — crop or compress it, then pick it again."
      );
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("entityType", "employee");
      fd.append("entityId", employeeId);
      fd.append("kind", "avatar");
      fd.append("file", f);
      const res = await apiFetch("/documents", { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Photo upload failed.")); return; }
      setNotice("Profile picture saved.");
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

  const activeStaff = employees.filter(e => e.status === "active");
  const openTasks = employees.reduce((n, e) => n + e.open_tasks, 0);
  const overdueTasks = employees.reduce((n, e) => n + e.overdue_tasks, 0);
  const renewalsDue = employees.filter(e =>
    e.status === "active" && e.contract_days !== null && e.contract_days <= 30).length;
  const interns = employees.filter(e => e.employment_type === "intern" && !e.intern_absorbed);
  const ranked = [...employees]
    .filter(e => e.status !== "left")
    .sort((a, b) => b.done_tasks - a.done_tasks || a.full_name.localeCompare(b.full_name));
  const contracts = employees.filter(e => e.employment_type !== "intern");
  const trainees = employees.filter(e => e.employment_type === "intern" || e.intern_absorbed);

  const payrollByDept = (() => {
    const map = new Map<string, { count: number; total: number }>();
    for (const e of activeStaff) {
      const key = e.department || "Unassigned";
      const row = map.get(key) ?? { count: 0, total: 0 };
      row.count += 1;
      row.total += e.monthly_salary ?? 0;
      map.set(key, row);
    }
    return [...map.entries()].sort((a, b) => b[1].total - a[1].total);
  })();
  const payrollTotal = activeStaff.reduce((n, e) => n + (e.monthly_salary ?? 0), 0);
  const todayISO = new Date().toISOString().slice(0, 10);
  const editingProfile = employees.find(e => e.id === editingEmp) ?? null;

  return (
    <div className="mx-auto max-w-[1080px] px-16 py-32">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
            {area === "cfa" ? "Staff Register" : "Employees Management"}
          </h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            {area === "cfa"
              ? "The clearing house's own people, ranked by task handling — the roster, the jobs each clerk is running and the contracts behind them."
              : "Your people, ranked by task handling — roster, daily assignments, evaluations, contracts with renewal countdowns and the trainee register."}
          </p>
          {area === "cfa" && (
            <p className="mt-6 text-xs" style={{ color: "var(--ink-soft)" }}>
              Evaluations, the trainee register and the office reports stay in the
              Enterprise office desk.
            </p>
          )}
        </div>
        <Link href={home.href} className="pane-note text-xs underline">
          {home.label}
        </Link>
      </div>
      {error && <div role="alert" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      <div className="mt-24 flex flex-wrap gap-8">
        {tabs.map(t => (
          <button key={t.key} type="button" onClick={() => setView(t.key)}
            className={"on-photo-btn rounded-input px-16 py-8 text-xs font-semibold" + (view === t.key ? " is-on" : "")}>
            {t.label}
          </button>
        ))}
      </div>

      <input ref={attachInput} type="file" hidden accept=".pdf,image/jpeg,image/png,image/webp"
        onChange={uploadAttachment} />
      <input ref={photoInput} type="file" hidden accept="image/jpeg,image/png,image/webp"
        onChange={uploadPhoto} />

      {/* ================= Overview ================= */}
      {view === "overview" && (
        <>
          <section className="mt-24 grid grid-cols-2 gap-16 md:grid-cols-5">
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Active staff</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{activeStaff.length}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Open tasks</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{openTasks}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Overdue</p>
              <p className="mt-8 text-2xl font-bold tabular-nums"
                style={{ color: overdueTasks ? "var(--danger)" : "var(--ink)" }}>{overdueTasks}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Renewals due 30d</p>
              <p className="mt-8 text-2xl font-bold tabular-nums"
                style={{ color: renewalsDue ? "var(--warning)" : "var(--ink)" }}>{renewalsDue}</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Trainees</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{interns.length}</p>
            </div>
          </section>

          <section className="mt-32">
            <h2 className={`${h2Cls} pane-note`}>Leaderboard — by completed tasks</h2>
            <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className={thCls}>#</th><th className={thCls}>Member</th>
                    <th className={thCls}>Done</th><th className={thCls}>On time</th>
                    <th className={thCls}>Rating</th><th className={thCls}>Open</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((e, i) => {
                    const ot = onTimePct(e);
                    return (
                      <tr key={e.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink-soft)" }}>{i + 1}</td>
                        <td className={tdCls} style={{ color: "var(--ink)" }}>
                          <span className="font-semibold">{e.full_name}</span>
                          <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                            {[e.job_title, e.department].filter(Boolean).join(" · ")}
                          </span>
                        </td>
                        <td className={`${tdCls} tabular-nums font-semibold`} style={{ color: "var(--ink)" }}>{e.done_tasks}</td>
                        <td className={`${tdCls} tabular-nums`}
                          style={{ color: ot !== null && ot < 80 ? "var(--danger)" : "var(--ink-soft)" }}>
                          {ot !== null ? `${ot}%` : "—"}
                        </td>
                        <td className={tdCls} style={{ color: "var(--ink-soft)" }}>
                          {e.rating !== null ? `${e.rating.toFixed(1)} / 5` : "—"}
                        </td>
                        <td className={`${tdCls} tabular-nums`}
                          style={{ color: e.overdue_tasks ? "var(--danger)" : "var(--ink-soft)" }}>
                          {e.open_tasks}{e.overdue_tasks ? ` (${e.overdue_tasks} late)` : ""}
                        </td>
                      </tr>
                    );
                  })}
                  {ready && ranked.length === 0 && (
                    <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                      No employees on the roster yet — add your team under Roster and their task standings appear here.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* ================= Roster ================= */}
      {view === "roster" && (
        <section className="mt-24">
          <div className="flex items-end justify-between gap-12">
            <div>
              <h2 className={`${h2Cls} pane-note`}>Roster</h2>
              <p className="pane-note mt-4 text-xs">
                Enter the legal name exactly as NIDA has it. The profile picture — 1 MB or less — is added from the row once the person is on file.
              </p>
            </div>
            {editingEmp && (
              <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                onClick={() => { setEditingEmp(null); setEmpForm(EMPTY_EMP); }}>
                Cancel edit
              </button>
            )}
          </div>
          <form onSubmit={submitEmp} className="mt-16 grid grid-cols-2 gap-12 rounded-card border bg-surface p-24 md:grid-cols-6" style={cardStyle}>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Full legal name — exactly as on NIDA *
              </span>
              <input required value={empForm.fullName} placeholder="e.g. Amina Juma Mkwawa"
                onChange={e => setEmpForm(f => ({ ...f, fullName: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Phone{editingProfile?.has_phone ? " — blank keeps current" : " (optional)"}
              </span>
              <input value={empForm.phone} placeholder="+255712345678"
                onChange={e => setEmpForm(f => ({ ...f, phone: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Job title</span>
              <input value={empForm.jobTitle} placeholder="e.g. Clearing clerk"
                onChange={e => setEmpForm(f => ({ ...f, jobTitle: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Department</span>
              <input value={empForm.department} placeholder="e.g. Operations"
                onChange={e => setEmpForm(f => ({ ...f, department: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Employment</span>
              <select value={empForm.employmentType}
                onChange={e => setEmpForm(f => ({ ...f, employmentType: e.target.value }))}
                className={inputCls} style={inputStyle}>
                {Object.entries(EMPLOYMENT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>

            <div className="flex items-center gap-12 pt-8 md:col-span-6">
              <span className={h2Cls} style={{ color: "var(--brand)" }}>Personnel profile</span>
              <span className="h-px flex-1" style={{ background: "var(--line)" }} />
              <span className="text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                Age {yearsSince(empForm.dateOfBirth) ?? "—"}
              </span>
            </div>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Date of birth</span>
              <input type="date" max={todayISO} value={empForm.dateOfBirth}
                onChange={e => setEmpForm(f => ({ ...f, dateOfBirth: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Gender</span>
              <select value={empForm.gender}
                onChange={e => setEmpForm(f => ({ ...f, gender: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">—</option>
                {Object.entries(GENDER_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Academic status</span>
              <select value={empForm.academicStatus}
                onChange={e => setEmpForm(f => ({ ...f, academicStatus: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">—</option>
                {Object.entries(ACADEMIC_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="block md:col-span-3">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>College / institution</span>
              <input value={empForm.college} placeholder="e.g. IASM — Institute of Accountancy"
                onChange={e => setEmpForm(f => ({ ...f, college: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block md:col-span-6">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Qualifications (comma separated)
              </span>
              <input value={empForm.qualifications} placeholder="e.g. Diploma in Customs Studies, TANCIS certificate"
                onChange={e => setEmpForm(f => ({ ...f, qualifications: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Skills (comma separated)</span>
              <input value={empForm.skills} placeholder="e.g. Customs clearance, TANCIS"
                onChange={e => setEmpForm(f => ({ ...f, skills: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Status</span>
              <select value={empForm.status}
                onChange={e => setEmpForm(f => ({ ...f, status: e.target.value }))}
                className={inputCls} style={inputStyle}>
                {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Hired</span>
              <input type="date" value={empForm.hiredDate}
                onChange={e => setEmpForm(f => ({ ...f, hiredDate: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Contract start</span>
              <input type="date" value={empForm.contractStart}
                onChange={e => setEmpForm(f => ({ ...f, contractStart: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Contract end</span>
              <input type="date" value={empForm.contractEnd}
                onChange={e => setEmpForm(f => ({ ...f, contractEnd: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Monthly salary (TZS)</span>
              <input type="number" min="0" step="1000" value={empForm.monthlySalary}
                onChange={e => setEmpForm(f => ({ ...f, monthlySalary: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Supervisor</span>
              <select value={empForm.supervisorId}
                onChange={e => setEmpForm(f => ({ ...f, supervisorId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">—</option>
                {employees.filter(x => x.id !== editingEmp && x.status !== "left").map(x =>
                  <option key={x.id} value={x.id}>{x.full_name}</option>)}
              </select>
            </label>
            {editingEmp && (
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Leave approver</span>
                <select value={empForm.leaveApproverUserId}
                  onChange={e => setEmpForm(f => ({ ...f, leaveApproverUserId: e.target.value }))}
                  className={inputCls} style={inputStyle}>
                  <option value="">— the office decides</option>
                  {employees.filter(x => x.user_id && x.id !== editingEmp && x.status !== "left").map(x =>
                    <option key={x.user_id!} value={x.user_id!}>{x.full_name}</option>)}
                </select>
                <span className="mt-4 block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Their leave requests go to this person, and only this person can answer them. Nobody
                  named here is sent a request they asked for themselves, and a request with no approver
                  — or an approver who is away for those days — is decided by the office.
                </span>
              </label>
            )}
            <label className="block md:col-span-4">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
              <input value={empForm.notes}
                onChange={e => setEmpForm(f => ({ ...f, notes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>

            <div className="flex items-center gap-12 pt-8 md:col-span-6">
              <span className={h2Cls} style={{ color: "var(--brand)" }}>Emergency contact</span>
              <span className="h-px flex-1" style={{ background: "var(--line)" }} />
              <span className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                Held encrypted — the number is never shown back
              </span>
            </div>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Contact name</span>
              <input value={empForm.emergencyContactName} placeholder="e.g. Fatuma Mkwawa"
                onChange={e => setEmpForm(f => ({ ...f, emergencyContactName: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Relationship</span>
              <input value={empForm.emergencyRelationship} placeholder="e.g. Sister"
                onChange={e => setEmpForm(f => ({ ...f, emergencyRelationship: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Phone{editingProfile?.has_emergency_phone ? " — blank keeps current" : " (optional)"}
              </span>
              <input value={empForm.emergencyPhone} placeholder="+255712345678"
                onChange={e => setEmpForm(f => ({ ...f, emergencyPhone: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>

            <button type="submit" disabled={busy}
              className="waisha-btn self-end rounded-input py-8 text-xs font-semibold disabled:opacity-60">
              {editingEmp ? "Save changes" : "Add employee"}
            </button>
          </form>

          <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className={thCls}>Member</th><th className={thCls}>Type</th>
                  <th className={thCls}>Contract</th><th className={thCls}>Rating</th>
                  <th className={thCls}>Tasks</th><th className={thCls}>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e, i) => (
                  <tr key={e.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className={tdCls} style={{ color: "var(--ink)" }}>
                      <div className="flex items-start gap-12">
                        <Avatar name={e.full_name} url={e.avatar_document_id ? avatarUrls[e.avatar_document_id] : null} />
                        <div className="min-w-0">
                          <span className="font-semibold">{e.full_name}</span>
                          <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                            {[e.job_title, e.department].filter(Boolean).join(" · ")}
                          </span>
                          <span className="block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                            {e.leave_approver_name
                              ? `Leave decided by ${e.leave_approver_name}`
                              : "Leave decided by the office"}
                          </span>
                          <span className="block text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                            {[
                              e.age !== null ? `${e.age} yrs` : null,
                              e.gender ? GENDER_LABELS[e.gender] : null,
                              e.academic_status ? ACADEMIC_LABELS[e.academic_status] : null
                            ].filter(Boolean).join(" · ") || "profile incomplete"}
                            {e.college ? ` — ${e.college}` : ""}
                          </span>
                          {(e.qualifications ?? []).length > 0 && (
                            <span className="mt-4 block truncate text-[11px]" style={{ color: "var(--ink-soft)" }}>
                              {(e.qualifications ?? []).join(", ")}
                            </span>
                          )}
                          {(e.skills ?? []).length > 0 && (
                            <span className="mt-4 flex flex-wrap gap-4">
                              {e.skills.map(s => (
                                <span key={s} className="rounded-input border px-8 py-2 text-[10px]"
                                  style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>{s}</span>
                              ))}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className={tdCls} style={{ color: "var(--ink-soft)" }}>
                      {EMPLOYMENT_LABELS[e.employment_type] ?? e.employment_type}
                      {e.intern_absorbed && (
                        <span className="block text-[10px] uppercase" style={{ color: "var(--gold)" }}>Absorbed</span>
                      )}
                    </td>
                    <td className={`${tdCls} tabular-nums text-xs`} style={{ color: "var(--ink-soft)" }}>
                      {e.contract_start || e.contract_end
                        ? `${fmtDate(e.contract_start)} → ${e.contract_end ? fmtDate(e.contract_end) : "open"}`
                        : "—"}
                    </td>
                    <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink)" }}>
                      {e.rating !== null ? `${e.rating.toFixed(1)}/5` : "—"}
                      {e.evaluation_count > 0 && (
                        <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          {e.evaluation_count} eval{e.evaluation_count === 1 ? "" : "s"}
                        </span>
                      )}
                    </td>
                    <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink-soft)" }}>
                      {e.open_tasks} open · {e.done_tasks} done
                    </td>
                    <td className={tdCls}>
                      <span className="px-8 py-4 text-[10px] font-bold uppercase"
                        style={pill(STATUS_COLORS[e.status] ?? "var(--ink-soft)")}>
                        {STATUS_LABELS[e.status] ?? e.status}
                      </span>
                    </td>
                    <td className={tdCls}>
                      <div className="flex flex-wrap items-center justify-end gap-x-12 gap-y-4 text-xs">
                        {e.avatar_document_id ? (
                          <>
                            <button type="button" className="underline" style={{ color: "var(--brand)" }}
                              onClick={() => viewAttachment(e.avatar_document_id!)}>Photo</button>
                            <button type="button" disabled={busy} className="underline"
                              style={{ color: "var(--ink-soft)" }}
                              onClick={() => pickPhoto(e.id)}>Replace</button>
                          </>
                        ) : (
                          <button type="button" disabled={busy} className="underline"
                            style={{ color: "var(--ink-soft)" }}
                            onClick={() => pickPhoto(e.id)}>Add photo</button>
                        )}
                        <button type="button" className="underline" style={{ color: "var(--ink-soft)" }}
                          onClick={() => { startEditEmp(e); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                          Edit
                        </button>
                        {e.status === "active" ? (
                          <button type="button" disabled={busy} className="underline" style={{ color: "var(--warning)" }}
                            onClick={() => setEmpStatus(e, "inactive")}>Deactivate</button>
                        ) : (
                          <button type="button" disabled={busy} className="underline" style={{ color: "var(--success)" }}
                            onClick={() => setEmpStatus(e, "active")}>Activate</button>
                        )}
                        <button type="button" disabled={busy} className="underline" style={{ color: "var(--danger)" }}
                          onClick={() => removeEmp(e)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {ready && employees.length === 0 && (
                  <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    No employees yet — add your first staff member above.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ================= Tasks & Files ================= */}
      {view === "tasks" && (
        <section className="mt-24">
          <div className="flex items-end justify-between gap-12">
            <div>
              <h2 className={`${h2Cls} pane-note`}>Tasks &amp; Files</h2>
              <p className="pane-note mt-4 text-xs">
                Daily assignments — link a cargo file, set a priority and a deadline. Completed in time counts toward the leaderboard.
              </p>
            </div>
            {editingTask && (
              <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                onClick={() => { setEditingTask(null); setTaskForm(EMPTY_TASK); }}>
                Cancel edit
              </button>
            )}
          </div>
          <form onSubmit={submitTask} className="mt-16 grid grid-cols-2 gap-12 rounded-card border bg-surface p-24 md:grid-cols-6" style={cardStyle}>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Assign to *</span>
              <select required value={taskForm.employeeId}
                onChange={e => setTaskForm(f => ({ ...f, employeeId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">Pick an employee…</option>
                {employees.filter(x => x.status !== "left").map(x =>
                  <option key={x.id} value={x.id}>{x.full_name}</option>)}
              </select>
            </label>
            <label className="block md:col-span-3">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Task *</span>
              <input required value={taskForm.title} placeholder="e.g. Verify TANSAD for the vessel manifest"
                onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Priority</span>
              <select value={taskForm.priority}
                onChange={e => setTaskForm(f => ({ ...f, priority: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="low">Low</option><option value="normal">Normal</option>
                <option value="high">High</option><option value="urgent">Urgent</option>
              </select>
            </label>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Cargo file (optional)</span>
              <select value={taskForm.shipmentId}
                onChange={e => setTaskForm(f => ({ ...f, shipmentId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">No file — general task</option>
                {files.map(f => <option key={f.id} value={f.id}>
                  {f.file_number}{f.stage ? ` · ${FILE_STAGES[f.stage] ?? f.stage}` : ""}
                </option>)}
              </select>
              {filesBlocked && (
                <span className="mt-4 block text-[11px]" style={{ color: "var(--warning)" }}>
                  Cargo files are hidden from your seat, so the list is empty. Ask a director for
                  shipments.view if your jobs are about them.
                </span>
              )}
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Due date</span>
              <input type="date" value={taskForm.dueDate}
                onChange={e => setTaskForm(f => ({ ...f, dueDate: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
              <input value={taskForm.notes}
                onChange={e => setTaskForm(f => ({ ...f, notes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <button type="submit" disabled={busy}
              className="waisha-btn self-end rounded-input py-8 text-xs font-semibold disabled:opacity-60">
              {editingTask ? "Save changes" : "Assign task"}
            </button>
          </form>

          <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className={thCls}>Task</th><th className={thCls}>Assignee</th>
                  <th className={thCls}>Priority</th><th className={thCls}>Due</th>
                  <th className={thCls}>Status</th><th className={thCls}>Completed</th><th></th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t, i) => (
                  <tr key={t.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className={tdCls} style={{ color: "var(--ink)" }}>
                      <span className="font-semibold">{t.title}</span>
                      {t.file_number && (
                        <span className="ml-8 inline-flex flex-wrap items-center gap-8 align-middle">
                          {fileAccess.open && t.file_live ? (
                            <Link href={`/app/cfa/cargo/${t.shipment_id}`}
                              className="text-[10px] font-bold uppercase underline" style={{ color: "var(--brand)" }}>
                              {t.file_number}
                            </Link>
                          ) : (
                            <span className="text-[10px] font-bold uppercase" style={{ color: "var(--brand)" }}>
                              {t.file_number}
                            </span>
                          )}
                          {t.file_stage && (
                            <span className="px-6 py-2 text-[10px] font-bold uppercase"
                              style={pill(t.file_live ? "var(--brand)" : "var(--ink-soft)")}>
                              {FILE_STAGES[t.file_stage] ?? t.file_stage}
                              {t.file_stages_total > 0 ? ` ${t.file_stages_done}/${t.file_stages_total}` : ""}
                            </span>
                          )}
                          {!t.file_live && (
                            <span className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>file gone</span>
                          )}
                        </span>
                      )}
                      {t.file_number && t.file_live && (
                        <span className="block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          {FILE_STATUS_LABELS[t.file_status ?? ""] ?? t.file_status}
                          {t.file_consignee ? ` · ${t.file_consignee}` : ""}
                          {t.file_tasks_open > 0 ? ` · ${t.file_tasks_open} checklist item${t.file_tasks_open === 1 ? "" : "s"} open` : ""}
                          {t.file_eta ? ` · ETA ${fmtDate(t.file_eta)}` : ""}
                          {fileAccess.message ? " · " : ""}
                          {fileAccess.message && (
                            <Link href={`/app/cfa/messages?file=${t.shipment_id}`} className="underline"
                              style={{ color: "var(--brand)" }}>ask on the file</Link>
                          )}
                        </span>
                      )}
                      {t.requested_by_name && (
                        <span className="block text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          asked by {t.requested_by_name}
                        </span>
                      )}
                      {t.notes && (
                        <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>{t.notes}</span>
                      )}
                    </td>
                    <td className={tdCls} style={{ color: "var(--ink-soft)" }}>
                      {t.employee_name}
                      {t.department && <span className="block text-xs">{t.department}</span>}
                    </td>
                    <td className={tdCls}>
                      <span className="px-8 py-4 text-[10px] font-bold uppercase"
                        style={pill(PRIORITY_COLORS[t.priority] ?? "var(--ink-soft)")}>
                        {t.priority}
                      </span>
                    </td>
                    <td className={`${tdCls} tabular-nums text-xs`} style={{ color: "var(--ink-soft)" }}>
                      {t.due_date ? fmtDate(t.due_date) : "—"}
                      {t.due_date && (t.status === "pending" || t.status === "in_progress") && t.days !== null && (
                        <span className="block"
                          style={{ color: t.days < 0 ? "var(--danger)" : t.days <= 2 ? "var(--warning)" : "var(--ink-soft)" }}>
                          {t.days < 0 ? `${-t.days}d overdue` : t.days === 0 ? "today" : `in ${t.days}d`}
                        </span>
                      )}
                    </td>
                    <td className={tdCls}>
                      <span className="px-8 py-4 text-[10px] font-bold uppercase"
                        style={pill(TASK_STATUS_COLORS[t.status] ?? "var(--ink-soft)")}>
                        {TASK_STATUS_LABELS[t.status] ?? t.status}
                      </span>
                    </td>
                    <td className={`${tdCls} text-xs`} style={{ color: "var(--ink-soft)" }}>
                      {t.done_at ? (
                        <>
                          {new Date(t.done_at).toLocaleDateString()}
                          {t.on_time === false && (
                            <span className="block text-[10px] font-bold uppercase" style={{ color: "var(--danger)" }}>Late</span>
                          )}
                          {t.on_time === true && (
                            <span className="block text-[10px] font-bold uppercase" style={{ color: "var(--success)" }}>On time</span>
                          )}
                        </>
                      ) : "—"}
                    </td>
                    <td className={`${tdCls} text-right whitespace-nowrap`}>
                      {t.status === "pending" && (
                        <button type="button" disabled={busy} className="underline" style={{ color: "var(--brand)" }}
                          onClick={() => setTaskStatus(t, "in_progress")}>Start</button>
                      )}
                      {(t.status === "pending" || t.status === "in_progress") && (
                        <button type="button" disabled={busy}
                          className={t.status === "pending" ? "ml-12 underline" : "underline"}
                          style={{ color: "var(--success)" }}
                          onClick={() => setTaskStatus(t, "done")}>Done</button>
                      )}
                      {(t.status === "pending" || t.status === "in_progress") && (
                        <button type="button" disabled={busy} className="ml-12 underline" style={{ color: "var(--ink-soft)" }}
                          onClick={() => setTaskStatus(t, "cancelled")}>Cancel</button>
                      )}
                      {(t.status === "done" || t.status === "cancelled") && (
                        <button type="button" disabled={busy} className="underline" style={{ color: "var(--warning)" }}
                          onClick={() => setTaskStatus(t, "pending")}>Reopen</button>
                      )}
                      <button type="button" className="ml-12 underline" style={{ color: "var(--ink-soft)" }}
                        onClick={() => { startEditTask(t); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                        Edit
                      </button>
                      <button type="button" disabled={busy} className="ml-12 underline" style={{ color: "var(--danger)" }}
                        onClick={() => removeTask(t)}>Delete</button>
                    </td>
                  </tr>
                ))}
                {ready && tasks.length === 0 && (
                  <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    No assignments yet — give the team its first daily task above.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ================= Evaluations ================= */}
      {view === "evaluations" && (
        <section className="mt-24">
          <div className="flex items-end justify-between gap-12">
            <div>
              <h2 className={`${h2Cls} pane-note`}>Evaluations</h2>
              <p className="pane-note mt-4 text-xs">
                Score each member monthly (1–5) across the four dimensions — the latest evaluation is the roster rating.
              </p>
            </div>
            {editingEval && (
              <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                onClick={() => { setEditingEval(null); setEvalForm(EMPTY_EVAL); }}>
                Cancel edit
              </button>
            )}
          </div>
          <form onSubmit={submitEval} className="mt-16 grid grid-cols-2 gap-12 rounded-card border bg-surface p-24 md:grid-cols-6" style={cardStyle}>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Employee *</span>
              <select required value={evalForm.employeeId}
                onChange={e => setEvalForm(f => ({ ...f, employeeId: e.target.value }))}
                className={inputCls} style={inputStyle}>
                <option value="">Pick an employee…</option>
                {employees.filter(x => x.status !== "left").map(x =>
                  <option key={x.id} value={x.id}>{x.full_name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Month *</span>
              <input required type="month" value={evalForm.period}
                onChange={e => setEvalForm(f => ({ ...f, period: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            {([
              ["taskCompletion", "Task completion"],
              ["punctuality", "Punctuality"],
              ["clientSatisfaction", "Client satisfaction"],
              ["collaboration", "Collaboration"]
            ] as const).map(([key, label]) => (
              <label className="block" key={key}>
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>{label}</span>
                <select value={evalForm[key]}
                  onChange={e => setEvalForm(f => ({ ...f, [key]: Number(e.target.value) }))}
                  className={inputCls} style={inputStyle}>
                  {SCORES.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            ))}
            <label className="block md:col-span-5">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Notes</span>
              <input value={evalForm.notes}
                onChange={e => setEvalForm(f => ({ ...f, notes: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <button type="submit" disabled={busy}
              className="waisha-btn self-end rounded-input py-8 text-xs font-semibold disabled:opacity-60">
              {editingEval ? "Save changes" : "Record evaluation"}
            </button>
          </form>

          <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className={thCls}>Employee</th><th className={thCls}>Period</th>
                  <th className={`${thCls} text-right`}>Tasks</th><th className={`${thCls} text-right`}>Punctual</th>
                  <th className={`${thCls} text-right`}>Client</th><th className={`${thCls} text-right`}>Teamwork</th>
                  <th className={thCls}>Average</th><th className={thCls}>By</th><th></th>
                </tr>
              </thead>
              <tbody>
                {evaluations.map((ev, i) => (
                  <tr key={ev.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className={tdCls} style={{ color: "var(--ink)" }}>
                      <span className="font-semibold">{ev.employee_name}</span>
                      {ev.department && <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>{ev.department}</span>}
                      {ev.notes && <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>{ev.notes}</span>}
                    </td>
                    <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink-soft)" }}>{fmtPeriod(ev.period.slice(0, 7))}</td>
                    <td className={`${tdCls} text-right tabular-nums`} style={{ color: "var(--ink-soft)" }}>{ev.task_completion}</td>
                    <td className={`${tdCls} text-right tabular-nums`} style={{ color: "var(--ink-soft)" }}>{ev.punctuality}</td>
                    <td className={`${tdCls} text-right tabular-nums`} style={{ color: "var(--ink-soft)" }}>{ev.client_satisfaction}</td>
                    <td className={`${tdCls} text-right tabular-nums`} style={{ color: "var(--ink-soft)" }}>{ev.collaboration}</td>
                    <td className={tdCls}>
                      <span className="px-8 py-4 text-[10px] font-bold uppercase"
                        style={pill(ev.average >= 4 ? "var(--success)" : ev.average >= 3 ? "var(--warning)" : "var(--danger)")}>
                        {ev.average.toFixed(1)}
                      </span>
                    </td>
                    <td className={`${tdCls} text-xs`} style={{ color: "var(--ink-soft)" }}>{ev.evaluated_by_name ?? "—"}</td>
                    <td className={`${tdCls} text-right whitespace-nowrap`}>
                      <button type="button" className="underline" style={{ color: "var(--ink-soft)" }}
                        onClick={() => { startEditEval(ev); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                        Edit
                      </button>
                      <button type="button" disabled={busy} className="ml-12 underline" style={{ color: "var(--danger)" }}
                        onClick={() => removeEval(ev)}>Delete</button>
                    </td>
                  </tr>
                ))}
                {ready && evaluations.length === 0 && (
                  <tr><td colSpan={9} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    No evaluations yet — grade each member monthly and the ratings update automatically.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ================= Contracts ================= */}
      {view === "contracts" && (
        <section className="mt-24">
          <h2 className={`${h2Cls} pane-note`}>Contracts — permanent &amp; fixed-term</h2>
          <p className="pane-note mt-4 text-xs">
            Renewal countdowns alert 30 days before the end date, in Alerts and the calendar. Attach the signed contract to keep it in the vault.
          </p>
          <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={{ ...cardStyle }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className={thCls}>Employee</th><th className={thCls}>Type</th>
                  <th className={thCls}>Start</th><th className={thCls}>End</th>
                  <th className={`${thCls} text-right`}>Days left</th><th className={thCls}>Contract scan</th><th></th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((e, i) => renewingId === e.id ? (
                  <tr key={e.id} style={{ background: "var(--milk-deep)" }}>
                    <td className={tdCls} colSpan={5}>
                      <div className="flex flex-wrap items-end gap-8">
                        <span className="pb-8 text-sm font-semibold" style={{ color: "var(--ink)" }}>{e.full_name}</span>
                        <label className="block">
                          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Start</span>
                          <input type="date" value={renewForm.start}
                            onChange={ev => setRenewForm(f => ({ ...f, start: ev.target.value }))}
                            className={inputCls} style={inputStyle} />
                        </label>
                        <label className="block">
                          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>End (blank = open-ended)</span>
                          <input type="date" value={renewForm.end}
                            onChange={ev => setRenewForm(f => ({ ...f, end: ev.target.value }))}
                            className={inputCls} style={inputStyle} />
                        </label>
                      </div>
                    </td>
                    <td className={tdCls}></td>
                    <td className={`${tdCls} text-right whitespace-nowrap`}>
                      <button type="button" disabled={busy} className="underline" style={{ color: "var(--success)" }}
                        onClick={() => saveRenew(e)}>Save</button>
                      <button type="button" className="ml-12 underline" style={{ color: "var(--ink-soft)" }}
                        onClick={() => setRenewingId(null)}>Cancel</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={e.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className={tdCls} style={{ color: "var(--ink)" }}>
                      <span className="font-semibold">{e.full_name}</span>
                      <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                        {[e.job_title, e.department].filter(Boolean).join(" · ")}
                      </span>
                    </td>
                    <td className={tdCls} style={{ color: "var(--ink-soft)" }}>
                      {EMPLOYMENT_LABELS[e.employment_type] ?? e.employment_type}
                    </td>
                    <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink-soft)" }}>{fmtDate(e.contract_start)}</td>
                    <td className={`${tdCls} tabular-nums`} style={{ color: "var(--ink)" }}>
                      {e.contract_end ? fmtDate(e.contract_end) : "Open-ended"}
                    </td>
                    <td className={`${tdCls} text-right tabular-nums`}
                      style={{ color: e.contract_days === null ? "var(--ink-soft)" :
                        e.contract_days < 0 ? "var(--danger)" :
                        e.contract_days <= 30 ? "var(--warning)" : "var(--ink)" }}>
                      {e.contract_days === null ? "—" :
                        e.contract_days < 0 ? `${-e.contract_days} overdue` : e.contract_days}
                    </td>
                    <td className={tdCls}>
                      {e.latest_document_id && (
                        <button type="button" className="underline" style={{ color: "var(--brand)" }}
                          onClick={() => viewAttachment(e.latest_document_id!)}>
                          View{e.document_count > 1 ? ` (${e.document_count})` : ""}
                        </button>
                      )}
                      <button type="button" disabled={busy}
                        className={e.latest_document_id ? "ml-12 underline" : "underline"}
                        style={{ color: "var(--ink-soft)" }}
                        onClick={() => pickAttachment(e.id)}>Attach</button>
                    </td>
                    <td className={`${tdCls} text-right whitespace-nowrap`}>
                      <button type="button" className="underline" style={{ color: "var(--brand)" }}
                        onClick={() => { startRenew(e); }}>Renew</button>
                      <button type="button" className="ml-12 underline" style={{ color: "var(--ink-soft)" }}
                        onClick={() => { setView("roster"); startEditEmp(e); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
                {ready && contracts.length === 0 && (
                  <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    No contracts on the register yet — add employees and set their contract dates.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="pane-note mt-16 text-xs">
            Contract scans are stored in the <Link href="/app/documents" className="underline">documents vault</Link> under the employee.
          </p>
        </section>
      )}

      {/* ================= Trainees ================= */}
      {view === "trainees" && (
        <section className="mt-24">
          <h2 className={`${h2Cls} pane-note`}>Trainees — internship register</h2>
          <p className="pane-note mt-4 text-xs">
            Interns with their supervisor and internship dates. Absorb a trainee on completion to take them on as staff.
          </p>
          <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className={thCls}>Trainee</th><th className={thCls}>Supervisor</th>
                  <th className={thCls}>Internship</th><th className={`${thCls} text-right`}>Days left</th>
                  <th className={thCls}>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {trainees.map((e, i) => (
                  <tr key={e.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className={tdCls} style={{ color: "var(--ink)" }}>
                      <div className="flex items-start gap-12">
                        <Avatar name={e.full_name} url={e.avatar_document_id ? avatarUrls[e.avatar_document_id] : null} />
                        <div className="min-w-0">
                          <span className="font-semibold">{e.full_name}</span>
                          <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                            {[e.job_title, e.department].filter(Boolean).join(" · ")}
                          </span>
                          <span className="block text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                            {[
                              e.age !== null ? `${e.age} yrs` : null,
                              e.academic_status ? ACADEMIC_LABELS[e.academic_status] : null,
                              e.college
                            ].filter(Boolean).join(" · ") || "academic profile not entered"}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className={tdCls} style={{ color: "var(--ink-soft)" }}>{e.supervisor_name ?? "—"}</td>
                    <td className={`${tdCls} tabular-nums text-xs`} style={{ color: "var(--ink-soft)" }}>
                      {e.contract_start || e.contract_end
                        ? `${fmtDate(e.contract_start)} → ${fmtDate(e.contract_end)}`
                        : "—"}
                    </td>
                    <td className={`${tdCls} text-right tabular-nums`}
                      style={{ color: e.contract_days !== null && e.contract_days < 0 ? "var(--danger)" : "var(--ink-soft)" }}>
                      {e.employment_type === "intern" && e.contract_days !== null
                        ? (e.contract_days < 0 ? `${-e.contract_days} past` : e.contract_days)
                        : "—"}
                    </td>
                    <td className={tdCls}>
                      {e.intern_absorbed ? (
                        <span className="px-8 py-4 text-[10px] font-bold uppercase" style={pill("var(--gold)")}>
                          Absorbed — {EMPLOYMENT_LABELS[e.employment_type]?.toLowerCase()}
                        </span>
                      ) : (
                        <span className="px-8 py-4 text-[10px] font-bold uppercase" style={pill("var(--brand)")}>Trainee</span>
                      )}
                    </td>
                    <td className={`${tdCls} text-right whitespace-nowrap`}>
                      <Link href="/app/office/reports" className="underline" style={{ color: "var(--brand)" }}>
                        Report
                      </Link>
                      {e.employment_type === "intern" && (
                        <button type="button" disabled={busy} className="ml-12 underline" style={{ color: "var(--success)" }}
                          onClick={() => absorbIntern(e)}>Absorb</button>
                      )}
                      <button type="button"
                        className="ml-12 underline"
                        style={{ color: "var(--ink-soft)" }}
                        onClick={() => { setView("roster"); startEditEmp(e); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
                {ready && trainees.length === 0 && (
                  <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    No trainees yet — add an employee with employment type Trainee and set their supervisor.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ================= Reports ================= */}
      {view === "reports" && (
        <>
          <section className="mt-24">
            <h2 className={`${h2Cls} pane-note`}>Payroll summary — active staff</h2>
            <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className={thCls}>Department</th>
                    <th className={`${thCls} text-right`}>Headcount</th>
                    <th className={`${thCls} text-right`}>Monthly payroll (TZS)</th>
                  </tr>
                </thead>
                <tbody>
                  {payrollByDept.map(([dept, row], i) => (
                    <tr key={dept} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                      <td className={tdCls} style={{ color: "var(--ink)" }}>{dept}</td>
                      <td className={`${tdCls} text-right tabular-nums`} style={{ color: "var(--ink-soft)" }}>{row.count}</td>
                      <td className={`${tdCls} text-right tabular-nums`} style={{ color: "var(--ink)" }}>
                        {row.total.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                  {payrollByDept.length > 0 && (
                    <tr className="border-t" style={{ borderColor: "var(--line)" }}>
                      <td className={`${tdCls} font-semibold`} style={{ color: "var(--ink)" }}>Total</td>
                      <td className={`${tdCls} text-right tabular-nums font-semibold`} style={{ color: "var(--ink)" }}>{activeStaff.length}</td>
                      <td className={`${tdCls} text-right tabular-nums font-semibold`} style={{ color: "var(--ink)" }}>
                        {payrollTotal.toLocaleString()}
                      </td>
                    </tr>
                  )}
                  {ready && payrollByDept.length === 0 && (
                    <tr><td colSpan={3} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                      No active staff yet — the payroll summary fills in as the roster grows.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-32">
            <h2 className={`${h2Cls} pane-note`}>Graded task performance</h2>
            <div className="mt-16 overflow-hidden rounded-card border bg-surface" style={cardStyle}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className={thCls}>Employee</th>
                    <th className={`${thCls} text-right`}>Done</th>
                    <th className={`${thCls} text-right`}>Late</th>
                    <th className={`${thCls} text-right`}>On time</th>
                    <th className={`${thCls} text-right`}>Rating</th>
                    <th className={thCls}>Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((e, i) => {
                    const ot = onTimePct(e);
                    const grade = gradeOf(e);
                    return (
                      <tr key={e.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                        <td className={tdCls} style={{ color: "var(--ink)" }}>
                          <span className="font-semibold">{e.full_name}</span>
                          <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>{e.department ?? ""}</span>
                        </td>
                        <td className={`${tdCls} text-right tabular-nums`} style={{ color: "var(--ink-soft)" }}>{e.done_tasks}</td>
                        <td className={`${tdCls} text-right tabular-nums`} style={{ color: "var(--ink-soft)" }}>{e.late_tasks}</td>
                        <td className={`${tdCls} text-right tabular-nums`} style={{ color: "var(--ink-soft)" }}>
                          {ot !== null ? `${ot}%` : "—"}
                        </td>
                        <td className={`${tdCls} text-right tabular-nums`} style={{ color: "var(--ink-soft)" }}>
                          {e.rating !== null ? e.rating.toFixed(1) : "—"}
                        </td>
                        <td className={tdCls}>
                          <span className="px-8 py-4 text-[10px] font-bold uppercase"
                            style={pill(grade === "A" ? "var(--success)" : grade === "B" ? "var(--brand)" :
                              grade === "C" ? "var(--warning)" : grade === "D" ? "var(--danger)" : "var(--ink-soft)")}>
                            {grade}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {ready && ranked.length === 0 && (
                    <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                      Nothing to grade yet — completed tasks and monthly evaluations feed this report.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <p className="pane-note mt-24 text-xs">
        Contract renewals and overdue tasks alert in <Link href="/app/notifications" className="underline">Alerts</Link> and the{" "}
        <Link href="/app/cfa/calendar" className="underline">calendar</Link>. Signed contracts live in the{" "}
        <Link href="/app/documents" className="underline">documents vault</Link>.
      </p>
    </div>
  );
}
