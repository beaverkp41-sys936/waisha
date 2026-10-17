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

interface CompanyDay {
  workStart: string; workEnd: string; grace: number; annualLeaveDays: number;
  zone: string; today: string; isWeekday: boolean; saved: boolean;
}
interface BoardRow {
  employee_id: string; full_name: string; job_title: string | null; department: string | null;
  employment_type: string | null; has_account: boolean;
  attendance_id: string | null; day_status: string | null;
  clock_in: string | null; clock_out: string | null; minutes_late: number | null;
  note: string | null; hours_worked: number | null;
  leave_id: string | null; leave_kind: string | null; leave_status: string | null;
  leave_starts_on: string | null; leave_ends_on: string | null;
}
interface Board { day: CompanyDay; workDate: string; rows: BoardRow[] }
interface Line {
  id: string; employee_id: string; full_name: string; job_title: string | null;
  department: string | null; employment_type: string | null; work_date: string;
  day_status: string; clock_in: string | null; clock_out: string | null;
  minutes_late: number | null; note: string | null; hours_worked: number | null;
}
interface PersonTotal {
  employee_id: string; full_name: string; days: number; present_days: number; late_days: number;
  half_days: number; absent_days: number; leave_days: number; holiday_days: number;
  clocked_days: number; minutes_late: number; hours_worked: number; punctuality: number | null;
}
interface LeaveRow {
  id: string; employee_id: string; full_name: string; job_title: string | null;
  department: string | null; leave_kind: string; starts_on: string; ends_on: string;
  working_days: number; reason: string | null; status: string; decision_note: string | null;
  created_at: string; decided_by_name: string | null; decided_at: string | null; mine: boolean;
}
interface BalanceRow {
  employee_id: string; full_name: string; job_title: string | null; department: string | null;
  entitlement: number; annualUsed: number; annualPending: number; annualRemaining: number;
  byKind: { kind: string; approved: number; pending: number }[];
}
interface Balances {
  day: CompanyDay; year: number;
  totals: { entitlement: number; used: number; pending: number; overdrawn: number };
  rows: BalanceRow[];
}
interface MineResp {
  linked: boolean; day: CompanyDay;
  employee?: { id: string; full_name: string; job_title?: string | null };
  attendance?: Line[];
  leave?: { id: string; leave_kind: string; starts_on: string; ends_on: string; working_days: number; status: string; reason: string | null; decision_note: string | null }[];
  annual?: { year: number; entitlement: number; used: number; remaining: number };
}
interface RegisterResp {
  day: CompanyDay; range: { from: string; to: string };
  lines: Line[]; totals: PersonTotal[];
  leave: { id: string; employee_id: string; full_name: string; leave_kind: string; status: string; starts_on: string; ends_on: string; working_days: number }[];
}
interface EmpOption { id: string; full_name: string; status: string; job_title?: string | null }

const DAY_STATUS_LABELS: Record<string, string> = {
  present: "Present", late: "Late", half_day: "Half day", absent: "Absent",
  on_leave: "On leave", holiday: "Holiday"
};
const DAY_STATUS_COLORS: Record<string, string> = {
  present: "var(--success)", late: "var(--warning)", half_day: "var(--brand)",
  absent: "var(--danger)", on_leave: "var(--gold-on-photo)", holiday: "var(--gold-green)"
};
const LEAVE_KIND_LABELS: Record<string, string> = {
  annual: "Annual", sick: "Sick", bereavement: "Bereavement", maternity: "Maternity",
  paternity: "Paternity", unpaid: "Unpaid", other: "Other"
};
const LEAVE_STATUS_LABELS: Record<string, string> = {
  pending: "Waiting", approved: "Granted", rejected: "Refused", cancelled: "Cancelled"
};
const LEAVE_STATUS_COLORS: Record<string, string> = {
  pending: "var(--warning)", approved: "var(--success)", rejected: "var(--danger)",
  cancelled: "var(--ink-soft)"
};
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const TABS = [
  { key: "today", label: "Today" },
  { key: "mine", label: "My time" },
  { key: "register", label: "Register" },
  { key: "leave", label: "Leave" },
  { key: "balances", label: "Balances" },
  { key: "settings", label: "Working day" }
] as const;
type View = typeof TABS[number]["key"];

const pad = (n: number) => String(n).padStart(2, "0");
const localDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayName = (date: string) => DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
const monthName = (date: string) => MONTH_NAMES[Number(date.slice(5, 7)) - 1] ?? date;
const longDate = (date: string) => `${dayName(date)}, ${Number(date.slice(8, 10))} ${monthName(date)} ${date.slice(0, 4)}`;
const shortDate = (date: string | null) => (date ? `${date.slice(8, 10)}/${date.slice(5, 7)}` : "—");

/** Wall-clock time as the company's own timezone sees it — never the browser's. */
function zoneTime(iso: string | null, zone: string | undefined, withSeconds = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}),
      hour12: false, ...(zone ? { timeZone: zone } : {})
    });
  } catch {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
}
function zoneShort(zone: string | undefined, iso: string): string {
  if (!zone) return "";
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" }).formatToParts(new Date(iso));
    return p.find(x => x.type === "timeZoneName")?.value ?? zone;
  } catch { return ""; }
}
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const fmtHours = (n: number | null | undefined) => (n == null ? "—" : `${Number(n).toFixed(1)} h`);
const fmtLate = (m: number | null) => (m == null ? "—" : m > 0 ? `${m} min` : "on time");

interface LineDraft {
  id: string; employee: string; workDate: string; dayStatus: string;
  clockIn: string; clockOut: string; note: string;
}
interface StateDraft {
  employeeId: string; workDate: string; dayStatus: string; clockIn: string; clockOut: string; note: string;
}
interface LeaveDraft {
  id?: string; employeeId: string; leaveKind: string; startsOn: string; endsOn: string; reason: string;
}

export default function OfficeAttendancePage() {
  const [view, setView] = useState<View>("today");
  const [day, setDay] = useState<CompanyDay | null>(null);
  const [boardDate, setBoardDate] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [mine, setMine] = useState<MineResp | null>(null);
  const [leave, setLeave] = useState<LeaveRow[]>([]);
  const [pending, setPending] = useState<LeaveRow[]>([]);
  const [leaveStatus, setLeaveStatus] = useState("pending");
  const [balances, setBalances] = useState<Balances | null>(null);
  const [employees, setEmployees] = useState<EmpOption[]>([]);
  const [period, setPeriod] = useState({ from: "", to: "" });
  const [register, setRegister] = useState<RegisterResp | null>(null);
  const [personFilter, setPersonFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState("");

  const [draft, setDraft] = useState<LineDraft | null>(null);
  const [stated, setStated] = useState<StateDraft | null>(null);
  const [leaveForm, setLeaveForm] = useState<LeaveDraft | null>(null);
  const [deciding, setDeciding] = useState<{ row: LeaveRow; decision: "approve" | "reject" } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [settings, setSettings] = useState({ workStart: "", workEnd: "", grace: "", annualDays: "", timezone: "" });

  const zone = day?.zone;

  // The desk opens on the queue it was nudged about, so an alert can deep-link here.
  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab && TABS.some(t => t.key === tab)) setView(tab as View);
  }, []);

  useEffect(() => {
    const tick = () => setClockNow(zoneTime(new Date().toISOString(), zone, true));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [zone]);

  const load = useCallback(async () => {
    const q = boardDate ? `?day=${boardDate}` : "";
    const needPending = leaveStatus !== "pending";
    const [b, m, l, ba, s, e, p] = await Promise.all([
      apiFetch(`/attendance/today${q}`),
      apiFetch("/attendance/me"),
      apiFetch(`/leave${leaveStatus ? `?status=${leaveStatus}` : ""}`),
      apiFetch("/leave/balances"),
      apiFetch("/office-settings"),
      apiFetch("/employees"),
      // The Leave tab carries the queue length whatever is being browsed, so an
      // unanswered request cannot be lost while looking at the granted ones.
      needPending ? apiFetch("/leave?status=pending") : Promise.resolve(null as Response | null)
    ]);
    const bj = await readJson(b);
    if (b.ok) {
      setBoard(bj);
      setDay(bj.day);
      if (!boardDate) setBoardDate(bj.workDate);
      setPeriod(x => x.from ? x : { from: `${bj.day.today.slice(0, 8)}01`, to: bj.day.today });
    } else {
      setError(errorText(bj, "Could not read today's register."));
    }
    const mj = await readJson(m); if (m.ok) setMine(mj);
    const lj = await readJson(l);
    if (l.ok) {
      const rows: LeaveRow[] = Array.isArray(lj) ? lj : [];
      setLeave(rows);
      if (!needPending) setPending(rows);
    }
    if (p?.ok) {
      const pj = await readJson(p);
      if (Array.isArray(pj)) setPending(pj);
    }
    const baj = await readJson(ba); if (ba.ok) setBalances(baj);
    const sj = await readJson(s);
    if (sj?.saved) {
      setSettings({
        workStart: sj.workStart, workEnd: sj.workEnd, grace: String(sj.grace),
        annualDays: String(sj.annualLeaveDays), timezone: sj.zone
      });
    }
    const ej = await readJson(e); if (Array.isArray(ej)) setEmployees(ej);
    setReady(true);
  }, [boardDate, leaveStatus]);

  useEffect(() => { load(); }, [load]);

  const loadRegister = useCallback(async () => {
    if (!period.from || !period.to) return;
    const qs = new URLSearchParams({ from: period.from, to: period.to });
    if (personFilter) qs.set("employeeId", personFilter);
    if (statusFilter) qs.set("status", statusFilter);
    const res = await apiFetch(`/attendance?${qs}`);
    const j = await readJson(res);
    if (res.ok) setRegister(j);
    else setError(errorText(j, "Could not read that stretch of the register."));
  }, [period, personFilter, statusFilter]);

  useEffect(() => { if (view === "register") loadRegister(); }, [view, loadRegister]);

  function reset() { setError(null); setNotice(null); }

  async function run(label: string, fn: () => Promise<{ status: number; json: any }>, onOk?: (j: any) => string) {
    reset(); setBusy(true);
    try {
      const { status, json } = await fn();
      if (!status) { setError(`${label} — the request never reached the office.`); return false; }
      if (status >= 400) { setError(errorText(json, `${label} failed.`)); return false; }
      setNotice(onOk ? onOk(json) : `${label}.`);
      await load();
      if (view === "register") await loadRegister();
      return true;
    } finally {
      setBusy(false);
    }
  }

  function post(path: string, body?: unknown) {
    return apiFetch(path, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    }).then(async r => ({ status: r.status, json: await readJson(r) }));
  }
  function put(path: string, body: unknown) {
    return apiFetch(path, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    }).then(async r => ({ status: r.status, json: await readJson(r) }));
  }

  function nameOf(id: string) {
    return employees.find(e => e.id === id)?.full_name
      ?? board?.rows.find(r => r.employee_id === id)?.full_name
      ?? "that person";
  }

  const clock = (kind: "in" | "out", employeeId?: string) => run(
    kind === "in" ? "Clocked in" : "Day closed",
    () => post(`/attendance/clock-${kind}`, employeeId ? { employeeId } : {}),
    (j) => kind === "in"
      ? `${employeeId ? nameOf(employeeId) : "You"} clocked in at ${zoneTime(j.clock_in, zone)}${j.minutes_late > 0 ? ` — ${j.minutes_late} min late` : " — on time"}.`
      : `Closed at ${zoneTime(j.clock_out, zone)} — ${fmtHours(j.hours_worked)} on the clock.`
  );

  function openLine(l: { id: string; employee_id: string; full_name: string; work_date: string; day_status: string; clock_in: string | null; clock_out: string | null; note: string | null }) {
    setDraft({
      id: l.id, employee: l.full_name, workDate: l.work_date, dayStatus: l.day_status,
      clockIn: toLocalInput(l.clock_in), clockOut: toLocalInput(l.clock_out), note: l.note ?? ""
    });
    reset();
  }

  const saveLine = () => run("Correction recorded", async () => {
    if (!draft) return { status: 0, json: null };
    const body: Record<string, unknown> = { dayStatus: draft.dayStatus };
    // An empty box is a decision, not a shrug: the desk cleared the stamp.
    if (draft.workDate) body.workDate = draft.workDate;
    body.clockIn = fromLocalInput(draft.clockIn);
    body.clockOut = fromLocalInput(draft.clockOut);
    body.note = draft.note || null;
    return put(`/attendance/${draft.id}`, body);
  }, () => `${draft?.employee}: ${DAY_STATUS_LABELS[draft!.dayStatus] ?? draft!.dayStatus} saved for ${draft!.workDate}.`);

  const stateDay = () => run("Day stated", async () => {
    if (!stated) return { status: 0, json: null };
    return post("/attendance/day", {
      employeeId: stated.employeeId, workDate: stated.workDate, dayStatus: stated.dayStatus,
      clockIn: fromLocalInput(stated.clockIn), clockOut: fromLocalInput(stated.clockOut),
      note: stated.note || null
    });
  }, () => `${nameOf(stated!.employeeId)}: ${DAY_STATUS_LABELS[stated!.dayStatus] ?? stated!.dayStatus} for ${stated!.workDate}.`);

  const askLeave = () => run("Request sent to the office", () => {
    if (!leaveForm) return Promise.resolve({ status: 0, json: null });
    const body = {
      ...(leaveForm.employeeId ? { employeeId: leaveForm.employeeId } : {}),
      leaveKind: leaveForm.leaveKind, startsOn: leaveForm.startsOn,
      endsOn: leaveForm.endsOn, reason: leaveForm.reason || null
    };
    return leaveForm.id ? put(`/leave/${leaveForm.id}`, body) : post("/leave", body);
  }, (j) => `${LEAVE_KIND_LABELS[leaveForm!.leaveKind] ?? leaveForm!.leaveKind}: ${j?.working_days ?? 0} working day(s) counted, waiting to be decided.`);

  const decide = (row: LeaveRow, decision: "approve" | "reject") => run(
    decision === "approve" ? "Leave granted" : "Leave refused",
    () => post(`/leave/${row.id}/decision`, { decision, note: decisionNote || null }),
    () => `${row.full_name}'s ${LEAVE_KIND_LABELS[row.leave_kind] ?? row.leave_kind.toLowerCase()} leave ${decision === "approve" ? "granted" : "refused"}.`
  ).then(ok => { if (ok) { setDeciding(null); setDecisionNote(""); } });

  const cancelLeave = (row: LeaveRow) => run("Request withdrawn",
    () => post(`/leave/${row.id}/cancel`, { note: "Withdrawn from the office screen" }),
    () => `${row.full_name}'s request is closed and costs nobody any days.`);

  const saveSettings = () => run("The working day is set", () => put("/office-settings", {
    workStart: settings.workStart, workEnd: settings.workEnd,
    lateGraceMinutes: Number(settings.grace || 0), annualLeaveDays: Number(settings.annualDays || 0),
    timezone: settings.timezone
  }), () => `${settings.workStart}–${settings.workEnd} in ${settings.timezone}, grace ${settings.grace} min, ${settings.annualDays} annual days.`);

  // ---------- shared bits ----------

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };
  const h2Cls = "text-sm font-bold uppercase tracking-[0.14em]";
  const thCls = "p-12";

  const chip = (label: string, color: string) => (
    <span className="whitespace-nowrap px-8 py-2 text-[10px] font-bold uppercase"
      style={{ borderLeft: `4px solid ${color}`, color }}>
      {label}
    </span>
  );

  const bar = (pct: number, color: string, height = 6) => (
    <div className="w-full overflow-hidden rounded" style={{ background: "color-mix(in srgb, var(--ink) 8%, transparent)", height }}>
      <div className="h-full rounded" style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </div>
  );

  const rows = board?.rows ?? [];
  const counted = (s: string) => rows.filter(r => r.day_status === s).length;
  const onApprovedLeave = rows.filter(r => r.leave_id && !r.attendance_id).length;
  const unrecorded = rows.filter(r => !r.attendance_id && !r.leave_id).length;
  const filled = rows.length ? Math.round(((rows.length - unrecorded) / rows.length) * 100) : 0;
  const windowPct = day ? (() => {
    const [sh, sm] = day.workStart.split(":").map(Number);
    const [eh, em] = day.workEnd.split(":").map(Number);
    const start = sh * 60 + sm, end = eh * 60 + em;
    const nowParts = (clockNow || "00:00:00").split(":").map(Number);
    const nowMin = nowParts[0] * 60 + nowParts[1];
    if (end <= start) return { startPct: 0, nowPct: 0, endPct: 100 };
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    return {
      startPct: 0,
      nowPct: clamp(((nowMin - start) / (end - start)) * 100),
      endPct: 100
    };
  })() : null;

  return (
    <div className="mx-auto max-w-[1080px] px-16 py-32">
      <div className="flex flex-wrap items-start justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Attendance &amp; Leave</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            The daily register, the clock each person stamps, leave requests and the working day
            itself — counted in {day?.zone ?? "the company's own timezone"}, never the server's.
          </p>
        </div>
        <div className="flex items-center gap-12">
          {day && (
            <div className="rounded-card border px-16 py-8 text-right" style={cardStyle}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                {day.zone ? zoneShort(day.zone, new Date().toISOString()) : ""} office clock
              </p>
              <p className="text-xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{clockNow || "—"}</p>
            </div>
          )}
          <Link href="/app/office" className="pane-note text-xs underline">← Office area</Link>
        </div>
      </div>

      {error && <div role="alert" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}
      {notice && <div role="status" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>{notice}</div>}

      <div className="mt-24 flex flex-wrap gap-8">
        {TABS.map(t => (
          <button key={t.key} type="button"
            onClick={() => { setView(t.key); reset(); setDraft(null); setStated(null); setLeaveForm(null); setDeciding(null); }}
            className={"on-photo-btn rounded-input px-16 py-8 text-xs font-semibold" + (view === t.key ? " is-on" : "")}>
            {t.label}{t.key === "leave" && pending.length ? ` (${pending.length})` : ""}
          </button>
        ))}
      </div>

      {/* ================= Today ================= */}
      {view === "today" && board && (
        <>
          <section className={card} style={{ ...cardStyle, marginTop: 24 }}>
            <div className="flex flex-wrap items-end justify-between gap-12">
              <div>
                <p className={labelCls} style={{ color: "var(--ink-soft)" }}>{longDate(board.workDate)}</p>
                <p className="text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                  {filled}% of the register filled
                </p>
                <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {day?.isWeekday
                    ? `${day.workStart}–${day.workEnd}, ${day.grace} min of grace before a minute counts`
                    : "A rest day in this company's calendar — nobody is expected."}
                </p>
              </div>
              <div className="flex items-end gap-8">
                {chip(`${counted("present")} present`, DAY_STATUS_COLORS.present)}
                {chip(`${counted("late")} late`, DAY_STATUS_COLORS.late)}
                {chip(`${onApprovedLeave} on leave`, DAY_STATUS_COLORS.on_leave)}
                {chip(`${unrecorded} unrecorded`, unrecorded ? DAY_STATUS_COLORS.absent : "var(--ink-soft)")}
              </div>
            </div>
            <div className="mt-16">{bar(filled, filled === 100 ? "var(--success)" : "var(--brand)", 8)}</div>
            {windowPct && day?.isWeekday && board.workDate === day.today && (
              <div className="mt-20">
                <div className="relative h-8 rounded"
                  style={{ background: "color-mix(in srgb, var(--ink) 8%, transparent)" }}>
                  <div className="absolute left-0 top-0 h-full rounded"
                    style={{
                      width: `${windowPct.nowPct}%`,
                      background: "color-mix(in srgb, var(--brand) 45%, transparent)"
                    }} />
                  <div className="absolute top-[-6px] h-[20px] w-[2px]"
                    style={{ left: `${windowPct.nowPct}%`, background: "var(--ink)" }} />
                </div>
                <div className="mt-8 flex justify-between text-[10px] font-semibold uppercase tracking-[0.14em]"
                  style={{ color: "var(--ink-soft)" }}>
                  <span>{day.workStart} start</span>
                  <span style={{ color: "var(--ink)" }}>{clockNow} now</span>
                  <span>{day.workEnd} end</span>
                </div>
              </div>
            )}
            <div className="mt-20 flex flex-wrap items-end gap-12">
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Look at another day</span>
                <input type="date" value={boardDate} max={day?.today}
                  onChange={e => setBoardDate(e.target.value)}
                  className="rounded-input border px-12 py-8 text-sm" style={inputStyle} />
              </label>
              <button type="button" disabled={busy || !mine?.linked}
                onClick={() => (mine?.attendance?.find(a => a.work_date === day?.today)?.clock_in
                  ? clock("out") : clock("in"))}
                className="waisha-btn rounded-input px-20 py-8 text-xs font-semibold">
                {mine?.linked
                  ? (mine?.attendance?.find(a => a.work_date === day?.today)?.clock_in
                    ? (mine?.attendance?.find(a => a.work_date === day?.today)?.clock_out ? "My day is closed" : "Clock out")
                    : "Clock myself in")
                  : "No staff record for your sign-in"}
              </button>
            </div>
          </section>

          {stated && (
            <section className="mt-16 px-16 py-12"
              style={{ background: "color-mix(in srgb, var(--brand) 6%, transparent)", borderLeft: "4px solid var(--brand)" }}>
              <p className={h2Cls} style={{ color: "var(--ink)" }}>State a day</p>
              <div className="mt-12 grid grid-cols-1 gap-12 md:grid-cols-4">
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Whose day</span>
                  <select value={stated.employeeId}
                    onChange={e => setStated(s => s ? { ...s, employeeId: e.target.value } : s)}
                    className={inputCls} style={inputStyle}>
                    {rows.map(r => <option key={r.employee_id} value={r.employee_id}>{r.full_name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Day</span>
                  <input type="date" value={stated.workDate} max={day?.today}
                    onChange={e => setStated(s => s ? { ...s, workDate: e.target.value } : s)}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Status</span>
                  <select value={stated.dayStatus}
                    onChange={e => setStated(s => s ? { ...s, dayStatus: e.target.value } : s)}
                    className={inputCls} style={inputStyle}>
                    {Object.entries(DAY_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note</span>
                  <input value={stated.note} placeholder="Why the day is stated"
                    onChange={e => setStated(s => s ? { ...s, note: e.target.value } : s)}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Arrival (optional)</span>
                  <input type="datetime-local" value={stated.clockIn}
                    onChange={e => setStated(s => s ? { ...s, clockIn: e.target.value } : s)}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Departure (optional)</span>
                  <input type="datetime-local" value={stated.clockOut}
                    onChange={e => setStated(s => s ? { ...s, clockOut: e.target.value } : s)}
                    className={inputCls} style={inputStyle} />
                </label>
                <div className="flex items-end gap-8 md:col-span-2">
                  <button type="button" disabled={busy || !stated.employeeId}
                    onClick={stateDay}
                    className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">Record the day</button>
                  <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                    onClick={() => setStated(null)}>Cancel</button>
                </div>
              </div>
            </section>
          )}

          {draft && (
            <section className="mt-16 px-16 py-12"
              style={{ background: "color-mix(in srgb, var(--warning) 8%, transparent)", borderLeft: "4px solid var(--warning)" }}>
              <p className={h2Cls} style={{ color: "var(--ink)" }}>Correct {draft.employee}&apos;s line</p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                The database re-counts lateness and hours from the two stamps — a correction is never a silent edit.
              </p>
              <div className="mt-12 grid grid-cols-1 gap-12 md:grid-cols-4">
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Day</span>
                  <input type="date" value={draft.workDate} max={day?.today}
                    onChange={e => setDraft(d => d ? { ...d, workDate: e.target.value } : d)}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Status</span>
                  <select value={draft.dayStatus}
                    onChange={e => setDraft(d => d ? { ...d, dayStatus: e.target.value } : d)}
                    className={inputCls} style={inputStyle}>
                    {Object.entries(DAY_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Arrival</span>
                  <input type="datetime-local" value={draft.clockIn}
                    onChange={e => setDraft(d => d ? { ...d, clockIn: e.target.value } : d)}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Departure</span>
                  <input type="datetime-local" value={draft.clockOut}
                    onChange={e => setDraft(d => d ? { ...d, clockOut: e.target.value } : d)}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block md:col-span-4">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note for the record</span>
                  <input value={draft.note} placeholder="e.g. Gate register says 07:55"
                    onChange={e => setDraft(d => d ? { ...d, note: e.target.value } : d)}
                    className={inputCls} style={inputStyle} />
                </label>
                <div className="flex items-end gap-8 md:col-span-4">
                  <button type="button" disabled={busy} onClick={saveLine}
                    className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">Save correction</button>
                  <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                    onClick={() => setDraft(null)}>Cancel</button>
                </div>
              </div>
            </section>
          )}

          <section className="mt-24">
            <div className="flex flex-wrap items-center justify-between gap-12">
              <h2 className={`${h2Cls} pane-note`}>Who is in — {shortDate(board.workDate)}</h2>
              <button type="button" disabled={busy || rows.length === 0}
                onClick={() => setStated({
                  employeeId: rows[0]?.employee_id ?? "", workDate: board.workDate,
                  dayStatus: "absent", clockIn: "", clockOut: "", note: ""
                })}
                className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold">
                State a day
              </button>
            </div>
            <div className="mt-16 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                    <th className={thCls}>Person</th>
                    <th className={thCls}>Day</th>
                    <th className={thCls}>In</th>
                    <th className={thCls}>Out</th>
                    <th className={thCls}>Late</th>
                    <th className={thCls}>Hours</th>
                    <th className={thCls}> </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const status = r.day_status ?? (r.leave_id ? "on_leave" : null);
                    const open = !!r.clock_in && !r.clock_out;
                    return (
                      <tr key={r.employee_id} className="border-b" style={{
                        borderColor: "var(--line)",
                        background: i % 2 ? "var(--milk-deep)" : "transparent"
                      }}>
                        <td className={thCls}>
                          <p className="font-semibold" style={{ color: "var(--ink)" }}>{r.full_name}</p>
                          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                            {[r.job_title, r.department].filter(Boolean).join(" · ") || "No post recorded"}
                            {r.has_account ? "" : " · no sign-in"}
                          </p>
                        </td>
                        <td className={thCls}>
                          {status ? chip(DAY_STATUS_LABELS[status] ?? status, DAY_STATUS_COLORS[status] ?? "var(--ink-soft)")
                            : <span className="text-xs font-semibold" style={{ color: "var(--danger)" }}>Unrecorded</span>}
                          {r.leave_id && r.leave_kind && (
                            <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                              {LEAVE_KIND_LABELS[r.leave_kind] ?? r.leave_kind} leave {shortDate(r.leave_starts_on)}–{shortDate(r.leave_ends_on)}
                            </p>
                          )}
                          {r.note && <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>{r.note}</p>}
                        </td>
                        <td className={`${thCls} tabular-nums`} style={{ color: "var(--ink)" }}>{zoneTime(r.clock_in, zone)}</td>
                        <td className={`${thCls} tabular-nums`} style={{ color: "var(--ink)" }}>{zoneTime(r.clock_out, zone)}</td>
                        <td className={`${thCls} tabular-nums`}
                          style={{ color: (r.minutes_late ?? 0) > 0 ? "var(--warning)" : "var(--ink-soft)" }}>
                          {status === "present" || status === "late" || r.clock_in ? fmtLate(r.minutes_late) : "—"}
                        </td>
                        <td className={`${thCls} tabular-nums`} style={{ color: "var(--ink)" }}>{fmtHours(r.hours_worked)}</td>
                        <td className={thCls}>
                          <div className="flex flex-wrap gap-8">
                            {!r.clock_in && (
                              <button type="button" disabled={busy}
                                onClick={() => clock("in", r.employee_id)}
                                className="on-photo-btn rounded-input px-12 py-4 text-[11px] font-semibold">
                                Clock in
                              </button>
                            )}
                            {open && (
                              <button type="button" disabled={busy}
                                onClick={() => clock("out", r.employee_id)}
                                className="on-photo-btn rounded-input px-12 py-4 text-[11px] font-semibold">
                                Clock out
                              </button>
                            )}
                            {r.attendance_id && (
                              <button type="button" disabled={busy}
                                onClick={() => {
                                  const l = board.rows.find(x => x.employee_id === r.employee_id)!;
                                  openLine({
                                    id: l.attendance_id!, employee_id: l.employee_id, full_name: l.full_name,
                                    work_date: board.workDate, day_status: l.day_status ?? "present",
                                    clock_in: l.clock_in, clock_out: l.clock_out, note: l.note
                                  });
                                }}
                                className="text-[11px] underline" style={{ color: "var(--ink-soft)" }}>
                                Correct
                              </button>
                            )}
                            {!r.attendance_id && !open && (
                              <button type="button" disabled={busy}
                                onClick={() => setStated({
                                  employeeId: r.employee_id, workDate: board.workDate,
                                  dayStatus: r.leave_id ? "on_leave" : "absent",
                                  clockIn: "", clockOut: "", note: ""
                                })}
                                className="text-[11px] underline" style={{ color: "var(--ink-soft)" }}>
                                State the day
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {ready && rows.length === 0 && (
                    <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                      No active member of staff yet — add people under Employees first.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* ================= My time ================= */}
      {view === "mine" && mine && (
        <>
          {!mine.linked ? (
            <div role="status" className="pane-note mt-24 px-16 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--warning) 8%, transparent)", borderLeft: "4px solid var(--warning)" }}>
              Your sign-in is not joined to a staff record, so there is nothing to clock. The office joins
              the two on the Employees screen.
            </div>
          ) : (
            <>
              <section className="mt-24 grid grid-cols-1 gap-16 md:grid-cols-3">
                {(() => {
                  const today = mine.attendance?.find(a => a.work_date === mine.day.today) ?? null;
                  return (
                    <div className={card} style={cardStyle}>
                      <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Today — {longDate(mine.day.today)}</p>
                      <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{clockNow}</p>
                      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                        {today
                          ? (today.clock_out
                            ? `Closed — ${zoneTime(today.clock_in, zone)} to ${zoneTime(today.clock_out, zone)}, ${fmtHours(today.hours_worked)}`
                            : `On the clock since ${zoneTime(today.clock_in, zone)}`)
                          : "Not clocked yet."}
                      </p>
                      <div className="mt-16 flex gap-8">
                        <button type="button" disabled={busy || !!today?.clock_in}
                          onClick={() => clock("in")} className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                          Clock in
                        </button>
                        <button type="button" disabled={busy || !today?.clock_in || !!today?.clock_out}
                          onClick={() => clock("out")}
                          className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold">
                          Clock out
                        </button>
                      </div>
                      <p className="mt-12 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        Times are stamped by the server clock — a missed stamp is put right by the office, not by you.
                      </p>
                    </div>
                  );
                })()}
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Annual leave {mine.annual?.year}</p>
                  <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                    {mine.annual?.remaining ?? 0} <span className="text-sm font-semibold">days left</span>
                  </p>
                  <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {mine.annual?.used ?? 0} taken of {mine.annual?.entitlement ?? 0}
                  </p>
                  <div className="mt-12">
                    {bar(mine.annual?.entitlement
                      ? ((mine.annual.used / mine.annual.entitlement) * 100)
                      : 0, "var(--gold-green)", 8)}
                  </div>
                </div>
                <div className={card} style={cardStyle}>
                  <p className={labelCls} style={{ color: "var(--ink-soft)" }}>This fortnight</p>
                  <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                    {fmtHours((mine.attendance ?? []).reduce((a, x) => a + Number(x.hours_worked ?? 0), 0))}
                  </p>
                  <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {(mine.attendance ?? []).filter(a => a.day_status === "late").length} late ·{" "}
                    {(mine.attendance ?? []).filter(a => a.day_status === "present").length} present ·{" "}
                    {(mine.attendance ?? []).filter(a => a.day_status === "absent").length} absent
                  </p>
                  <p className="mt-12 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    Working window {mine.day.workStart}–{mine.day.workEnd}, {mine.day.grace} min grace.
                  </p>
                </div>
              </section>

              <section className="mt-32 grid grid-cols-1 gap-16 md:grid-cols-2">
                <div className="rounded-card border bg-surface" style={cardStyle}>
                  <div className="flex items-center justify-between p-24 pb-0">
                    <h2 className={`${h2Cls}`} style={{ color: "var(--ink)" }}>My days</h2>
                    <button type="button" disabled={busy}
                      onClick={() => setLeaveForm({
                        employeeId: "", leaveKind: "annual",
                        startsOn: mine.day.today, endsOn: mine.day.today, reason: ""
                      })}
                      className="on-photo-btn rounded-input px-12 py-4 text-[11px] font-semibold">
                      Ask for leave
                    </button>
                  </div>
                  <table className="mt-16 w-full text-sm">
                    <tbody>
                      {(mine.attendance ?? []).map((a, i) => (
                        <tr key={a.id} className="border-b" style={{
                          borderColor: "var(--line)", background: i % 2 ? "var(--milk-deep)" : "transparent"
                        }}>
                          <td className="p-12">
                            <p className="font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{shortDate(a.work_date)}</p>
                            <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{dayName(a.work_date).slice(0, 3)}</p>
                          </td>
                          <td className="p-12">{chip(DAY_STATUS_LABELS[a.day_status] ?? a.day_status, DAY_STATUS_COLORS[a.day_status] ?? "var(--ink-soft)")}</td>
                          <td className="p-12 tabular-nums text-xs" style={{ color: "var(--ink-soft)" }}>
                            {zoneTime(a.clock_in, zone)} – {zoneTime(a.clock_out, zone)}
                          </td>
                          <td className="p-12 tabular-nums text-xs" style={{ color: "var(--ink)" }}>{fmtHours(a.hours_worked)}</td>
                        </tr>
                      ))}
                      {mine.attendance?.length === 0 && (
                        <tr><td className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                          Nothing clocked in the last fortnight.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="rounded-card border bg-surface" style={cardStyle}>
                  <h2 className={`${h2Cls} p-24 pb-0`} style={{ color: "var(--ink)" }}>My leave</h2>
                  <ul className="mt-12 px-24 pb-24">
                    {(mine.leave ?? []).map(l => (
                      <li key={l.id} className="mb-12 flex flex-wrap items-start justify-between gap-8 border-b pb-12"
                        style={{ borderColor: "var(--line)" }}>
                        <div>
                          <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                            {LEAVE_KIND_LABELS[l.leave_kind] ?? l.leave_kind} · {shortDate(l.starts_on)}–{shortDate(l.ends_on)}
                          </p>
                          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                            {l.working_days} working day(s){l.reason ? ` — ${l.reason}` : ""}
                          </p>
                          {l.decision_note && (
                            <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>Office: {l.decision_note}</p>
                          )}
                        </div>
                        <div className="flex flex-col items-end gap-8">
                          {chip(LEAVE_STATUS_LABELS[l.status] ?? l.status, LEAVE_STATUS_COLORS[l.status] ?? "var(--ink-soft)")}
                          {l.status === "pending" && (
                            <button type="button" disabled={busy}
                              onClick={() => setLeaveForm({
                                id: l.id, employeeId: "", leaveKind: l.leave_kind,
                                startsOn: l.starts_on, endsOn: l.ends_on, reason: l.reason ?? ""
                              })}
                              className="text-[11px] underline" style={{ color: "var(--ink-soft)" }}>Amend</button>
                          )}
                          {l.status === "pending" && (
                            <button type="button" disabled={busy}
                              onClick={() => cancelLeave({
                                id: l.id, employee_id: "", full_name: "Your", job_title: null, department: null,
                                leave_kind: l.leave_kind, starts_on: l.starts_on, ends_on: l.ends_on,
                                working_days: l.working_days, reason: l.reason, status: l.status,
                                decision_note: null, created_at: "", decided_by_name: null, decided_at: null, mine: true
                              })}
                              className="text-[11px] underline" style={{ color: "var(--ink-soft)" }}>Withdraw</button>
                          )}
                        </div>
                      </li>
                    ))}
                    {mine.leave?.length === 0 && (
                      <li className="text-sm" style={{ color: "var(--ink-soft)" }}>No leave asked for yet.</li>
                    )}
                  </ul>
                </div>
              </section>
            </>
          )}

          {leaveForm && (
            <section className="mt-16 px-16 py-12"
              style={{ background: "color-mix(in srgb, var(--brand) 6%, transparent)", borderLeft: "4px solid var(--brand)" }}>
              <p className={h2Cls} style={{ color: "var(--ink)" }}>{leaveForm.id ? "Amend the request" : "Ask for leave"}</p>
              <div className="mt-12 grid grid-cols-1 gap-12 md:grid-cols-4">
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Type</span>
                  <select value={leaveForm.leaveKind}
                    onChange={e => setLeaveForm(f => f ? { ...f, leaveKind: e.target.value } : f)}
                    className={inputCls} style={inputStyle}>
                    {Object.entries(LEAVE_KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>From</span>
                  <input type="date" required value={leaveForm.startsOn}
                    onChange={e => setLeaveForm(f => f ? { ...f, startsOn: e.target.value } : f)}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>To</span>
                  <input type="date" required value={leaveForm.endsOn}
                    onChange={e => setLeaveForm(f => f ? { ...f, endsOn: e.target.value } : f)}
                    className={inputCls} style={inputStyle} />
                </label>
                {mine.employee && view === "mine" && (
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>On behalf of</span>
                    <select value={leaveForm.employeeId}
                      onChange={e => setLeaveForm(f => f ? { ...f, employeeId: e.target.value } : f)}
                      className={inputCls} style={inputStyle}>
                      <option value="">Myself</option>
                      {employees.filter(x => x.status !== "left")
                        .map(x => <option key={x.id} value={x.id}>{x.full_name}</option>)}
                    </select>
                  </label>
                )}
                <label className="block md:col-span-4">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Reason</span>
                  <input value={leaveForm.reason} placeholder="Short reason for the file"
                    onChange={e => setLeaveForm(f => f ? { ...f, reason: e.target.value } : f)}
                    className={inputCls} style={inputStyle} />
                </label>
                <div className="flex items-end gap-8 md:col-span-4">
                  <button type="button" disabled={busy} onClick={askLeave}
                    className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                    {leaveForm.id ? "Save the change" : "Send to the office"}
                  </button>
                  <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                    onClick={() => setLeaveForm(null)}>Cancel</button>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      {/* ================= Register ================= */}
      {view === "register" && (
        <>
          <div className="mt-24 flex flex-wrap items-end gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>From</span>
              <input type="date" value={period.from} max={day?.today}
                onChange={e => setPeriod(p => ({ ...p, from: e.target.value }))}
                className="rounded-input border px-12 py-8 text-sm" style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>To</span>
              <input type="date" value={period.to} max={day?.today}
                onChange={e => setPeriod(p => ({ ...p, to: e.target.value }))}
                className="rounded-input border px-12 py-8 text-sm" style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Person</span>
              <select value={personFilter} onChange={e => setPersonFilter(e.target.value)}
                className="rounded-input border px-12 py-8 text-sm" style={inputStyle}>
                <option value="">Everyone</option>
                {(register?.totals ?? []).map(t => <option key={t.employee_id} value={t.employee_id}>{t.full_name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Day status</span>
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="rounded-input border px-12 py-8 text-sm" style={inputStyle}>
                <option value="">Any</option>
                {Object.entries(DAY_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>

          {register && (
            <>
              <section className="mt-24 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      <th className={thCls}>Person</th>
                      <th className={thCls}>Days</th>
                      <th className={thCls}>Present</th>
                      <th className={thCls}>Late</th>
                      <th className={thCls}>Absent</th>
                      <th className={thCls}>Hours</th>
                      <th className={thCls} style={{ minWidth: 140 }}>Punctuality</th>
                    </tr>
                  </thead>
                  <tbody>
                    {register.totals.map((t, i) => (
                      <tr key={t.employee_id} className="border-b" style={{
                        borderColor: "var(--line)", background: i % 2 ? "var(--milk-deep)" : "transparent"
                      }}>
                        <td className={thCls}>
                          <p className="font-semibold" style={{ color: "var(--ink)" }}>{t.full_name}</p>
                          <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                            {t.clocked_days} of {t.days} days carry a stamp
                          </p>
                        </td>
                        <td className={`${thCls} tabular-nums`} style={{ color: "var(--ink)" }}>{t.days}</td>
                        <td className={`${thCls} tabular-nums`} style={{ color: "var(--success)" }}>{t.present_days}</td>
                        <td className={`${thCls} tabular-nums`} style={{ color: t.late_days ? "var(--warning)" : "var(--ink-soft)" }}>
                          {t.late_days}
                          <span className="text-[10px]"> ({t.minutes_late} min)</span>
                        </td>
                        <td className={`${thCls} tabular-nums`} style={{ color: t.absent_days ? "var(--danger)" : "var(--ink-soft)" }}>{t.absent_days}</td>
                        <td className={`${thCls} tabular-nums`} style={{ color: "var(--ink)" }}>{fmtHours(t.hours_worked)}</td>
                        <td className={thCls}>
                          {t.punctuality == null
                            ? <span className="text-xs" style={{ color: "var(--ink-soft)" }}>no stamps</span>
                            : (
                              <>
                                <p className="text-xs font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{t.punctuality}%</p>
                                {bar(t.punctuality, t.punctuality >= 90 ? "var(--success)" : t.punctuality >= 70 ? "var(--warning)" : "var(--danger)")}
                              </>
                            )}
                        </td>
                      </tr>
                    ))}
                    {register.totals.length === 0 && (
                      <tr><td colSpan={7} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        Nobody has a line in that stretch yet.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </section>

              <section className="mt-32 flex flex-wrap items-center justify-between gap-12">
                <h2 className={`${h2Cls} pane-note`}>Every line — {shortDate(register.range.from)} to {shortDate(register.range.to)}</h2>
                <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                  {register.lines.length} lines{register.lines.length >= 3000 ? " (page is capped at 3 000 — shorten the period)" : ""}
                </p>
              </section>
              <div className="mt-16 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      <th className={thCls}>Day</th>
                      <th className={thCls}>Person</th>
                      <th className={thCls}>Status</th>
                      <th className={thCls}>In</th>
                      <th className={thCls}>Out</th>
                      <th className={thCls}>Late</th>
                      <th className={thCls}>Hours</th>
                      <th className={thCls}> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {register.lines.map((l, i) => (
                      <tr key={l.id} className="border-b" style={{
                        borderColor: "var(--line)", background: i % 2 ? "var(--milk-deep)" : "transparent"
                      }}>
                        <td className={`${thCls} tabular-nums`} style={{ color: "var(--ink)" }}>
                          {shortDate(l.work_date)}
                          <span className="ml-6 text-[10px]" style={{ color: "var(--ink-soft)" }}>{dayName(l.work_date).slice(0, 3)}</span>
                        </td>
                        <td className={thCls}>
                          <p className="font-semibold" style={{ color: "var(--ink)" }}>{l.full_name}</p>
                          {l.note && <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{l.note}</p>}
                        </td>
                        <td className={thCls}>{chip(DAY_STATUS_LABELS[l.day_status] ?? l.day_status, DAY_STATUS_COLORS[l.day_status] ?? "var(--ink-soft)")}</td>
                        <td className={`${thCls} tabular-nums`} style={{ color: "var(--ink)" }}>{zoneTime(l.clock_in, zone)}</td>
                        <td className={`${thCls} tabular-nums`} style={{ color: "var(--ink)" }}>{zoneTime(l.clock_out, zone)}</td>
                        <td className={`${thCls} tabular-nums`} style={{ color: (l.minutes_late ?? 0) > 0 ? "var(--warning)" : "var(--ink-soft)" }}>
                          {l.clock_in ? fmtLate(l.minutes_late) : "—"}
                        </td>
                        <td className={`${thCls} tabular-nums`} style={{ color: "var(--ink)" }}>{fmtHours(l.hours_worked)}</td>
                        <td className={thCls}>
                          <button type="button" disabled={busy} onClick={() => openLine(l)}
                            className="text-[11px] underline" style={{ color: "var(--ink-soft)" }}>Correct</button>
                        </td>
                      </tr>
                    ))}
                    {register.lines.length === 0 && (
                      <tr><td colSpan={8} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                        No lines match those filters.
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {register.leave.length > 0 && (
                <section className="mt-32">
                  <h2 className={`${h2Cls} pane-note`}>Leave across the period</h2>
                  <div className="mt-16 grid grid-cols-1 gap-12 md:grid-cols-3">
                    {register.leave.map(l => (
                      <div key={l.id} className="rounded-card border p-16" style={{ borderColor: "var(--line)" }}>
                        <div className="flex items-start justify-between gap-8">
                          <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{l.full_name}</p>
                          {chip(LEAVE_STATUS_LABELS[l.status] ?? l.status, LEAVE_STATUS_COLORS[l.status] ?? "var(--ink-soft)")}
                        </div>
                        <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                          {LEAVE_KIND_LABELS[l.leave_kind] ?? l.leave_kind} · {shortDate(l.starts_on)}–{shortDate(l.ends_on)} · {l.working_days} working day(s)
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {draft && (
                <section className="mt-24 px-16 py-12"
                  style={{ background: "color-mix(in srgb, var(--warning) 8%, transparent)", borderLeft: "4px solid var(--warning)" }}>
                  <p className={h2Cls} style={{ color: "var(--ink)" }}>Correct {draft.employee}&apos;s line</p>
                  <div className="mt-12 grid grid-cols-1 gap-12 md:grid-cols-4">
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Day</span>
                      <input type="date" value={draft.workDate} max={day?.today}
                        onChange={e => setDraft(d => d ? { ...d, workDate: e.target.value } : d)}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Status</span>
                      <select value={draft.dayStatus}
                        onChange={e => setDraft(d => d ? { ...d, dayStatus: e.target.value } : d)}
                        className={inputCls} style={inputStyle}>
                        {Object.entries(DAY_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                      </select>
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Arrival</span>
                      <input type="datetime-local" value={draft.clockIn}
                        onChange={e => setDraft(d => d ? { ...d, clockIn: e.target.value } : d)}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Departure</span>
                      <input type="datetime-local" value={draft.clockOut}
                        onChange={e => setDraft(d => d ? { ...d, clockOut: e.target.value } : d)}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <label className="block md:col-span-4">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note</span>
                      <input value={draft.note} onChange={e => setDraft(d => d ? { ...d, note: e.target.value } : d)}
                        className={inputCls} style={inputStyle} />
                    </label>
                    <div className="flex items-end gap-8 md:col-span-4">
                      <button type="button" disabled={busy} onClick={saveLine}
                        className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">Save correction</button>
                      <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                        onClick={() => setDraft(null)}>Cancel</button>
                    </div>
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}

      {/* ================= Leave queue ================= */}
      {view === "leave" && (
        <>
          <div className="mt-24 flex flex-wrap items-center gap-8">
            {["", "pending", "approved", "rejected", "cancelled"].map(s => (
              <button key={s || "all"} type="button" onClick={() => setLeaveStatus(s)}
                className={"on-photo-btn rounded-input px-12 py-4 text-xs font-semibold" + (leaveStatus === s ? " is-on" : "")}>
                {s === "" ? "All" : LEAVE_STATUS_LABELS[s]}
              </button>
            ))}
            <button type="button" disabled={busy || employees.length === 0}
              onClick={() => setLeaveForm({
                employeeId: employees.find(e => e.status !== "left")?.id ?? "", leaveKind: "annual",
                startsOn: day?.today ?? localDateStr(new Date()), endsOn: day?.today ?? localDateStr(new Date()), reason: ""
              })}
              className="waisha-btn ml-auto rounded-input px-16 py-8 text-xs font-semibold">
              Raise for staff
            </button>
          </div>

          {leaveForm && (
            <section className="mt-16 px-16 py-12"
              style={{ background: "color-mix(in srgb, var(--brand) 6%, transparent)", borderLeft: "4px solid var(--brand)" }}>
              <p className={h2Cls} style={{ color: "var(--ink)" }}>{leaveForm.id ? "Amend the request" : "A request on someone's behalf"}</p>
              <div className="mt-12 grid grid-cols-1 gap-12 md:grid-cols-4">
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Who</span>
                  <select value={leaveForm.employeeId} disabled={!!leaveForm.id}
                    onChange={e => setLeaveForm(f => f ? { ...f, employeeId: e.target.value } : f)}
                    className={inputCls} style={inputStyle}>
                    {employees.filter(x => x.status !== "left")
                      .map(x => <option key={x.id} value={x.id}>{x.full_name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Type</span>
                  <select value={leaveForm.leaveKind}
                    onChange={e => setLeaveForm(f => f ? { ...f, leaveKind: e.target.value } : f)}
                    className={inputCls} style={inputStyle}>
                    {Object.entries(LEAVE_KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>From</span>
                  <input type="date" required value={leaveForm.startsOn}
                    onChange={e => setLeaveForm(f => f ? { ...f, startsOn: e.target.value } : f)}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>To</span>
                  <input type="date" required value={leaveForm.endsOn}
                    onChange={e => setLeaveForm(f => f ? { ...f, endsOn: e.target.value } : f)}
                    className={inputCls} style={inputStyle} />
                </label>
                <label className="block md:col-span-4">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Reason</span>
                  <input value={leaveForm.reason} onChange={e => setLeaveForm(f => f ? { ...f, reason: e.target.value } : f)}
                    className={inputCls} style={inputStyle} />
                </label>
                <div className="flex items-end gap-8 md:col-span-4">
                  <button type="button" disabled={busy || !leaveForm.employeeId} onClick={askLeave}
                    className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                    {leaveForm.id ? "Save the change" : "Send for decision"}
                  </button>
                  <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                    onClick={() => setLeaveForm(null)}>Cancel</button>
                </div>
              </div>
            </section>
          )}

          <section className="mt-24 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className={thCls}>Who</th>
                  <th className={thCls}>Dates</th>
                  <th className={thCls}>Type</th>
                  <th className={thCls}>Working days</th>
                  <th className={thCls}>State</th>
                  <th className={thCls}> </th>
                </tr>
              </thead>
              <tbody>
                {leave.map((l, i) => (
                  <tr key={l.id} className="border-b" style={{
                    borderColor: "var(--line)", background: i % 2 ? "var(--milk-deep)" : "transparent"
                  }}>
                    <td className={thCls}>
                      <p className="font-semibold" style={{ color: "var(--ink)" }}>{l.full_name}</p>
                      <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        {[l.job_title, l.department].filter(Boolean).join(" · ")}
                        {l.mine ? " · yours" : ""}
                      </p>
                      {l.reason && <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>{l.reason}</p>}
                    </td>
                    <td className={`${thCls} tabular-nums`} style={{ color: "var(--ink)" }}>
                      {shortDate(l.starts_on)}–{shortDate(l.ends_on)}
                      <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{dayName(l.starts_on).slice(0, 3)} to {dayName(l.ends_on).slice(0, 3)}</p>
                    </td>
                    <td className={thCls} style={{ color: "var(--ink)" }}>{LEAVE_KIND_LABELS[l.leave_kind] ?? l.leave_kind}</td>
                    <td className={`${thCls} tabular-nums`} style={{ color: l.working_days ? "var(--ink)" : "var(--ink-soft)" }}>
                      {l.working_days}
                    </td>
                    <td className={thCls}>
                      {chip(LEAVE_STATUS_LABELS[l.status] ?? l.status, LEAVE_STATUS_COLORS[l.status] ?? "var(--ink-soft)")}
                      {l.decided_by_name && (
                        <p className="mt-4 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          {l.decided_by_name}{l.decided_at ? ` · ${shortDate(l.decided_at.slice(0, 10))}` : ""}
                        </p>
                      )}
                      {l.decision_note && (
                        <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>“{l.decision_note}”</p>
                      )}
                    </td>
                    <td className={thCls}>
                      <div className="flex flex-wrap gap-8">
                        {l.status === "pending" ? (
                          <>
                            <button type="button" disabled={busy}
                              onClick={() => { reset(); setDeciding({ row: l, decision: "approve" }); }}
                              className="on-photo-btn rounded-input px-12 py-4 text-[11px] font-semibold is-on">Grant</button>
                            <button type="button" disabled={busy}
                              onClick={() => { reset(); setDeciding({ row: l, decision: "reject" }); }}
                              className="on-photo-btn rounded-input px-12 py-4 text-[11px] font-semibold">Refuse</button>
                            {l.mine && (
                              <button type="button" disabled={busy}
                                onClick={() => setLeaveForm({
                                  id: l.id, employeeId: "", leaveKind: l.leave_kind,
                                  startsOn: l.starts_on, endsOn: l.ends_on, reason: l.reason ?? ""
                                })}
                                className="text-[11px] underline" style={{ color: "var(--ink-soft)" }}>Amend</button>
                            )}
                          </>
                        ) : (
                          <button type="button" disabled={busy} onClick={() => cancelLeave(l)}
                            className="text-[11px] underline" style={{ color: "var(--ink-soft)" }}>Withdraw</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {ready && leave.length === 0 && (
                  <tr><td colSpan={6} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    {leaveStatus === "pending"
                      ? "Nobody is waiting on a decision — the queue is clear."
                      : "Nothing in this part of the register."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </section>

          {deciding && (
            <div className="mt-16 flex flex-wrap items-end gap-12 px-16 py-12"
              style={{
                background: `color-mix(in srgb, ${deciding.decision === "approve" ? "var(--success)" : "var(--danger)"} 7%, transparent)`,
                borderLeft: `4px solid ${deciding.decision === "approve" ? "var(--success)" : "var(--danger)"}`
              }}>
              <p className="text-sm" style={{ color: "var(--ink)" }}>
                {deciding.decision === "approve" ? "Granting" : "Refusing"}{" "}
                <span className="font-semibold">{deciding.row.full_name}</span>&apos;s{" "}
                {LEAVE_KIND_LABELS[deciding.row.leave_kind] ?? deciding.row.leave_kind.toLowerCase()} leave,{" "}
                {deciding.row.working_days} working day(s) from {shortDate(deciding.row.starts_on)}.
              </p>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note for the file</span>
                <input value={decisionNote} onChange={e => setDecisionNote(e.target.value)}
                  className={inputCls} style={{ ...inputStyle, minWidth: 260 }}
                  placeholder={deciding.decision === "approve" ? "Cover arranged with…" : "Why it cannot be granted"} />
              </label>
              <button type="button" disabled={busy}
                onClick={() => decide(deciding.row, deciding.decision)}
                className="rounded-input px-16 py-8 text-xs font-semibold text-white"
                style={{ background: deciding.decision === "approve" ? "var(--success)" : "var(--danger)" }}>
                Confirm {deciding.decision === "approve" ? "grant" : "refusal"}
              </button>
              <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                onClick={() => { setDeciding(null); setDecisionNote(""); }}>Cancel</button>
            </div>
          )}
        </>
      )}

      {/* ================= Balances ================= */}
      {view === "balances" && balances && (
        <>
          <section className="mt-24 grid grid-cols-2 gap-16 md:grid-cols-4">
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Staff</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{balances.rows.length}</p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>entitlement {balances.totals.entitlement} days</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Granted this year</p>
              <p className="mt-8 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{balances.totals.used}</p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>working days taken</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Still waiting</p>
              <p className="mt-8 text-2xl font-bold tabular-nums"
                style={{ color: balances.totals.pending ? "var(--warning)" : "var(--ink)" }}>{balances.totals.pending}</p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>days in undecided requests</p>
            </div>
            <div className={card} style={cardStyle}>
              <p className={labelCls} style={{ color: "var(--ink-soft)" }}>Past entitlement</p>
              <p className="mt-8 text-2xl font-bold tabular-nums"
                style={{ color: balances.totals.overdrawn ? "var(--danger)" : "var(--ink)" }}>{balances.totals.overdrawn}</p>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>people already over</p>
            </div>
          </section>

          <div className="mt-24 overflow-x-auto rounded-card border bg-surface" style={cardStyle}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                  <th className={thCls}>Person</th>
                  <th className={thCls} style={{ minWidth: 180 }}>Annual leave {balances.year}</th>
                  <th className={thCls}>Waiting</th>
                  <th className={thCls}>Other kinds</th>
                </tr>
              </thead>
              <tbody>
                {balances.rows.map((r, i) => (
                  <tr key={r.employee_id} className="border-b" style={{
                    borderColor: "var(--line)", background: i % 2 ? "var(--milk-deep)" : "transparent"
                  }}>
                    <td className={thCls}>
                      <p className="font-semibold" style={{ color: "var(--ink)" }}>{r.full_name}</p>
                      <p className="text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        {[r.job_title, r.department].filter(Boolean).join(" · ") || "No post recorded"}
                      </p>
                    </td>
                    <td className={thCls}>
                      <div className="flex items-center gap-12">
                        <div className="flex-1">{bar(r.entitlement ? (r.annualUsed / r.entitlement) * 100 : 0,
                          r.annualRemaining < 0 ? "var(--danger)" : "var(--gold-green)", 8)}</div>
                        <p className="whitespace-nowrap text-xs tabular-nums" style={{ color: "var(--ink)" }}>
                          {r.annualUsed}/{r.entitlement}
                        </p>
                      </div>
                      <p className="mt-4 text-[10px]" style={{ color: r.annualRemaining < 0 ? "var(--danger)" : "var(--ink-soft)" }}>
                        {r.annualRemaining} day(s) left
                      </p>
                    </td>
                    <td className={`${thCls} tabular-nums`} style={{ color: r.annualPending ? "var(--warning)" : "var(--ink-soft)" }}>
                      {r.annualPending}
                    </td>
                    <td className={thCls}>
                      {r.byKind.filter(k => k.kind !== "annual").length === 0
                        ? <span className="text-xs" style={{ color: "var(--ink-soft)" }}>—</span>
                        : r.byKind.filter(k => k.kind !== "annual").map(k => (
                          <span key={k.kind} className="mr-6 whitespace-nowrap px-8 py-2 text-[10px] font-bold uppercase"
                            style={{ borderLeft: "4px solid var(--gold-on-photo)", color: "var(--ink)" }}>
                            {LEAVE_KIND_LABELS[k.kind] ?? k.kind} {k.approved}{k.pending ? ` (+${k.pending})` : ""}
                          </span>
                        ))}
                    </td>
                  </tr>
                ))}
                {balances.rows.length === 0 && (
                  <tr><td colSpan={4} className="p-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    No active member of staff to count.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="pane-note mt-16 text-xs">
            Unpaid leave and the kinds with no entitlement are counted on their own line — only annual leave
            draws down the {balances.totals.entitlement / Math.max(balances.rows.length, 1)} days each.
          </p>
        </>
      )}

      {/* ================= Working day ================= */}
      {view === "settings" && day && (
        <section className={card} style={{ ...cardStyle, marginTop: 24, maxWidth: 720 }}>
          <h2 className={h2Cls} style={{ color: "var(--ink)" }}>The working day</h2>
          <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
            Everything else on this screen is measured against these five numbers. Lateness, the day a register
            belongs to and the annual entitlement all read {day.zone} — the server runs on UTC, so a company
            in Tanzania is three hours ahead of its own database.
          </p>
          <div className="mt-20 grid grid-cols-1 gap-12 md:grid-cols-2">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Day starts</span>
              <input type="time" value={settings.workStart}
                onChange={e => setSettings(s => ({ ...s, workStart: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Day ends</span>
              <input type="time" value={settings.workEnd}
                onChange={e => setSettings(s => ({ ...s, workEnd: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Grace (minutes late before it counts)</span>
              <input type="number" min={0} max={120} value={settings.grace}
                onChange={e => setSettings(s => ({ ...s, grace: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Annual leave days a year</span>
              <input type="number" min={0} max={60} value={settings.annualDays}
                onChange={e => setSettings(s => ({ ...s, annualDays: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
            <label className="block md:col-span-2">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Timezone (IANA name)</span>
              <input value={settings.timezone} placeholder="Africa/Dar_es_Salaam"
                onChange={e => setSettings(s => ({ ...s, timezone: e.target.value }))}
                className={inputCls} style={inputStyle} />
            </label>
          </div>
          <div className="mt-20 flex flex-wrap items-center gap-12">
            <button type="button" disabled={busy} onClick={saveSettings}
              className="waisha-btn rounded-input px-20 py-8 text-xs font-semibold">Save the working day</button>
            {!day.saved && (
              <span className="text-xs" style={{ color: "var(--warning)" }}>
                Nothing has been set yet — the register is using {day.workStart}–{day.workEnd}, {day.grace} min grace,
                {day.annualLeaveDays} annual days.
              </span>
            )}
          </div>
        </section>
      )}

      {ready && !board && (
        <div role="status" className="pane-note mt-24 px-16 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--warning) 8%, transparent)", borderLeft: "4px solid var(--warning)" }}>
          This register is not open to your seat. Attendance and leave are read by anyone with the
          attendance permission, clocked by the clocking one, and decided only by the office.
        </div>
      )}
    </div>
  );
}
