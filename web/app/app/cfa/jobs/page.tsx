"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const parts = Array.isArray(d)
    ? d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).filter(Boolean)
    : [];
  return (json?.error?.message ?? fallback) + (parts.length ? ` (${parts.join("; ")})` : "");
}

const STAGES = ["job_opening", "pre_arrival_docs", "shipment_tracking", "declaration_prep",
  "customs_submission", "payment", "inspection", "release", "transport_decision", "closing_billing"];
const STAGE_LABELS: Record<string, string> = {
  job_opening: "1. Job opening", pre_arrival_docs: "2. Pre-arrival documents",
  shipment_tracking: "3. Shipment tracking", declaration_prep: "4. Declaration preparation",
  customs_submission: "5. Customs submission", payment: "6. Payment",
  inspection: "7. Inspection", release: "8. Release",
  transport_decision: "9. Transport decision", closing_billing: "10. Closing and billing"
};

type Tab = "dashboard" | "board" | "mine" | "all" | "transport";

const card = "rounded-card border bg-surface p-24";
const cardStyle = { borderColor: "var(--line)" };
const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const headingCls = "text-sm font-bold uppercase tracking-[0.14em]";
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : "—");

const STATUS_EDGE: Record<string, string> = {
  open: "var(--success)", closed: "var(--brand)", cancelled: "var(--ink-soft)"
};

function Badge({ label, color }: { label: string; color: string }) {
  return <span className="whitespace-nowrap px-8 py-4 text-[10px] font-bold uppercase"
    style={{ borderLeft: `4px solid ${color}`, color: "var(--ink)" }}>{label}</span>;
}

/**
 * The booker's company profile, as captured when they booked (migration 050
 * snapshots it onto the request — a copy, never a live join). The licence
 * state chip is the verification at a glance before confirming a hold.
 */
function BookerCard({ t }: { t: any }) {
  const exp = t.booked_licence_expiry ? new Date(`${t.booked_licence_expiry}T00:00:00`) : null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const licState =
    !t.booked_licence_no ? "none"
      : !exp ? "no-expiry"
        : exp.getTime() >= today.getTime() ? "valid" : "expired";
  const chip = {
    valid: { label: `Licence valid to ${exp!.toLocaleDateString()}`, color: "var(--success)" },
    expired: { label: `Licence expired ${exp!.toLocaleDateString()}`, color: "var(--danger)" },
    "no-expiry": { label: "Licence — no expiry on file", color: "var(--warning)" },
    none: { label: "No transport licence on file", color: "var(--warning)" }
  }[licState]!;
  const facts = [
    t.booked_fleet_size != null ? `Fleet: ${t.booked_fleet_size} vehicles` : null,
    t.booked_year_established ? `Est. ${t.booked_year_established}` : null
  ].filter(Boolean) as string[];
  return (
    <div className="mt-8 rounded-card p-12" style={{ background: "var(--milk)", border: "1px solid var(--line)" }}>
      <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: "var(--ink-soft)" }}>
        Who you would be working with
      </p>
      <p className="mt-4 text-sm font-bold" style={{ color: "var(--ink)" }}>{t.booked_company_name}</p>
      <div className="mt-6 flex flex-wrap items-center gap-x-12 gap-y-4">
        <span className="rounded-input px-8 py-2 text-[10px] font-bold uppercase"
          style={{ background: `color-mix(in srgb, ${chip.color} 12%, transparent)`, color: chip.color }}>
          {chip.label}
        </span>
        {facts.map(f => (
          <span key={f} className="text-[11px]" style={{ color: "var(--ink-soft)" }}>{f}</span>
        ))}
      </div>
      {t.booked_company_description && (
        <p className="mt-6 text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
          {t.booked_company_description}
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-x-16 gap-y-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
        {t.booked_company_services && <span>{t.booked_company_services}</span>}
        {t.booked_company_corridors && <span>{t.booked_company_corridors}</span>}
        {t.booked_company_website && <span>{t.booked_company_website}</span>}
      </div>
      {t.booked_licence_no && (
        <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>
          Licence no. {t.booked_licence_no}
        </p>
      )}
    </div>
  );
}

export default function JobsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [error, setError] = useState<string | null>(null);

  const [dash, setDash] = useState<any>(null);
  const [board, setBoard] = useState<any>(null);
  const [mine, setMine] = useState<any[]>([]);
  const [mineScope, setMineScope] = useState("open");
  const [rows, setRows] = useState<any[]>([]);
  const [filters, setFilters] = useState({ status: "open", recordKind: "", stageKey: "", search: "" });
  const [trans, setTrans] = useState<any[]>([]);
  const [transScope, setTransScope] = useState("open");

  const load = useCallback(async () => {
    setError(null);
    if (tab === "dashboard") {
      const res = await apiFetch("/jobs/dashboard");
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to load the dashboard.")); return; }
      setDash(j);
    } else if (tab === "board") {
      const res = await apiFetch("/jobs/board");
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to load the board.")); return; }
      setBoard(j);
    } else if (tab === "mine") {
      const res = await apiFetch(`/jobs/my-tasks?scope=${mineScope}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to load your tasks.")); return; }
      setMine(j);
    } else if (tab === "transport") {
      const q = transScope === "all" ? "" : `?status=${transScope}`;
      const res = await apiFetch(`/transport-requests${q}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to load transport requests.")); return; }
      setTrans(j);
    } else {
      const p = new URLSearchParams();
      if (filters.status) p.set("status", filters.status);
      if (filters.recordKind) p.set("recordKind", filters.recordKind);
      if (filters.stageKey) p.set("stageKey", filters.stageKey);
      if (filters.search) p.set("search", filters.search);
      const res = await apiFetch(`/jobs?${p.toString()}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorText(j, "Failed to load jobs.")); return; }
      setRows(j);
    }
  }, [tab, mineScope, transScope, filters]);

  useEffect(() => { load(); }, [load]);

  // Deep link from a cargo file: /app/cfa/jobs?file=<shipmentId> — opening is
  // idempotent, so this both resolves and (for older files) backfills the job.
  useEffect(() => {
    const file = new URLSearchParams(window.location.search).get("file");
    if (!file) return;
    apiFetch("/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shipmentId: file })
    }).then(async res => {
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.jobId) { setError(errorText(j, "Could not open the job for this file.")); return; }
      router.replace(`/app/cfa/jobs/${j.jobId}`);
    }).catch(() => setError("Could not open the job for this file."));
  }, [router]);

  async function completeTask(t: any, status: string) {
    setError(null);
    const res = await apiFetch(`/jobs/${t.job_id}/tasks/${t.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(errorText(j, "Failed to update the task.")); return; }
    await load();
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "dashboard", label: "Dashboard" },
    { key: "board", label: "Kanban board" },
    { key: "mine", label: "My tasks" },
    { key: "all", label: "All jobs" },
    { key: "transport", label: "Transport requests" }
  ];

  return (
    <div className="mx-auto max-w-[1240px] px-16 py-32">
      <div className="flex flex-wrap items-end justify-between gap-12">
        <div>
          <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Job Pipeline</h1>
          <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
            Every cargo file is a job through ten clearing stages — documents gate each stage.
          </p>
        </div>
        <Link href="/app/cfa/cargo" className="pane-note text-xs underline">
          Cargo files
        </Link>
      </div>

      <nav className="mt-24 flex flex-wrap gap-8" aria-label="Job views">
        {tabs.map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className="on-photo-btn rounded-input px-16 py-8 text-xs font-semibold"
            style={tab === t.key ? { borderColor: "#c9a84c", background: "rgba(201,168,76,0.24)" } : undefined}>
            {t.label}
          </button>
        ))}
        <button type="button" onClick={load}
          className="on-photo-btn ml-auto px-16 py-8 text-xs font-semibold">Reload</button>
      </nav>

      {error && (
        <div role="alert" className="mt-16 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error}
        </div>
      )}

      {tab === "dashboard" && dash && <Dashboard dash={dash} />}
      {tab === "board" && board && <Board board={board} />}
      {tab === "mine" && (
        <Mine tasks={mine} scope={mineScope} setScope={setMineScope} onStatus={completeTask} />
      )}
      {tab === "all" && <AllJobs rows={rows} filters={filters} setFilters={setFilters} />}
      {tab === "transport" && (
        <Transport rows={trans} scope={transScope} setScope={setTransScope} onChanged={load} />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-card border bg-surface p-16" style={cardStyle}>
      <p className={labelCls} style={{ color: "var(--ink-soft)" }}>{label}</p>
      <p className="text-2xl font-bold tabular-nums" style={{ color: tone }}>{value}</p>
    </div>
  );
}

function Dashboard({ dash }: { dash: any }) {
  const c = dash.counts ?? {};
  return (
    <div className="mt-24 space-y-24">
      <div className="grid grid-cols-2 gap-12 md:grid-cols-6">
        <Stat label="Live jobs" value={c.open_live ?? 0} tone="var(--brand)" />
        <Stat label="Records" value={c.open_archive ?? 0} tone="var(--ink)" />
        <Stat label="Closed" value={c.closed ?? 0} tone="var(--success)" />
        <Stat label="Blocked stages" value={c.blocked_stages ?? 0} tone="var(--danger)" />
        <Stat label="Overdue tasks" value={c.overdue_tasks ?? 0} tone="var(--warning)" />
        <Stat label="Rejected docs" value={c.rejected_docs ?? 0} tone="var(--warning)" />
      </div>

      <section className={card} style={cardStyle}>
        <h2 className={headingCls} style={{ color: "var(--ink-soft)" }}>
          Deadlines ({dash.deadlines.length})
        </h2>
        <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
          Free days, ETA, transit permits and task deadlines — counted from the real dates on file.
        </p>
        <div className="mt-16 space-y-8">
          {dash.deadlines.map((d: any, n: number) => (
            <div key={n} className="flex items-center justify-between gap-12 rounded-input border px-16 py-12" style={cardStyle}>
              <div className="min-w-0 text-sm">
                <Link href={`/app/cfa/jobs/${d.job_id}`} className="font-semibold underline" style={{ color: "var(--brand)" }}>
                  {d.file_number}
                </Link>
                <span className="ml-8" style={{ color: "var(--ink)" }}>{d.label}</span>
              </div>
              <span className="shrink-0 text-xs tabular-nums font-semibold"
                style={{ color: d.days_left < 0 ? "var(--danger)" : d.days_left <= 2 ? "var(--warning)" : "var(--ink-soft)" }}>
                {fmtDate(d.due_on)} · {d.days_left < 0 ? `${-d.days_left}d over` : d.days_left === 0 ? "today" : `${d.days_left}d`}
              </span>
            </div>
          ))}
          {dash.deadlines.length === 0 && (
            <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Nothing due within five days.</p>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-24 lg:grid-cols-2">
        <section className={card} style={cardStyle}>
          <h2 className={headingCls} style={{ color: "var(--ink-soft)" }}>
            Blocked stages ({dash.blocked.length})
          </h2>
          <div className="mt-16 space-y-8">
            {dash.blocked.map((b: any) => (
              <div key={b.job_id + b.stage} className="rounded-input border px-16 py-12" style={cardStyle}>
                <Link href={`/app/cfa/jobs/${b.job_id}`} className="text-sm font-semibold underline" style={{ color: "var(--brand)" }}>
                  {b.file_number}
                </Link>
                <span className="ml-8 text-sm" style={{ color: "var(--ink)" }}>{b.stage}</span>
                <p className="mt-4 text-xs" style={{ color: "var(--danger)" }}>{b.blocked_reason}</p>
              </div>
            ))}
            {dash.blocked.length === 0 && (
              <p className="text-sm" style={{ color: "var(--success)" }}>No stage is blocked.</p>
            )}
          </div>
        </section>

        <section className={card} style={cardStyle}>
          <h2 className={headingCls} style={{ color: "var(--ink-soft)" }}>
            Overdue tasks ({dash.overdue.length})
          </h2>
          <div className="mt-16 space-y-8">
            {dash.overdue.map((t: any) => (
              <div key={t.id} className="flex items-center justify-between gap-12 rounded-input border px-16 py-12" style={cardStyle}>
                <div className="min-w-0 text-sm">
                  <span style={{ color: "var(--ink)" }}>{t.title}</span>
                  <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>{t.assignee}</span>
                </div>
                <div className="shrink-0 text-right">
                  <Link href={`/app/cfa/jobs/${t.job_id}`} className="text-xs underline" style={{ color: "var(--brand)" }}>
                    {t.file_number}
                  </Link>
                  <p className="text-[10px] tabular-nums" style={{ color: "var(--danger)" }}>
                    due {fmtDate(t.due_date)}
                  </p>
                </div>
              </div>
            ))}
            {dash.overdue.length === 0 && (
              <p className="text-sm" style={{ color: "var(--success)" }}>Nothing overdue.</p>
            )}
          </div>
        </section>
      </div>

      {dash.expiringLicences.length > 0 && (
        <section className={card} style={cardStyle}>
          <h2 className={headingCls} style={{ color: "var(--ink-soft)" }}>Permits and licences expiring</h2>
          <div className="mt-16 space-y-8">
            {dash.expiringLicences.map((l: any, n: number) => (
              <div key={n} className="flex items-center justify-between gap-12 text-sm">
                <span style={{ color: "var(--ink)" }}>{l.title} · {l.licence_number}</span>
                <span className="tabular-nums font-semibold"
                  style={{ color: l.days_left < 0 ? "var(--danger)" : "var(--warning)" }}>
                  {fmtDate(l.expiry_date)} ({l.days_left}d)
                </span>
              </div>
            ))}
          </div>
          <Link href="/app/cfa/compliance" className="mt-16 inline-block text-xs underline" style={{ color: "var(--brand)" }}>
            Open compliance tracker
          </Link>
        </section>
      )}
    </div>
  );
}

function Board({ board }: { board: any }) {
  return (
    <div className="mt-24">
      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
        {board.total} open job{board.total === 1 ? "" : "s"} — each card sits in its current stage.
      </p>
      <div className="mt-16 flex gap-12 overflow-x-auto pb-16">
        {board.columns.map((col: any) => (
          <div key={col.stageKey} className="w-[230px] shrink-0 rounded-card border bg-surface p-12" style={cardStyle}>
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-[0.1em]" style={{ color: "var(--ink)" }}>
                {STAGE_LABELS[col.stageKey] ?? col.name}
              </p>
              <span className="text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>{col.jobs.length}</span>
            </div>
            <div className="mt-12 space-y-8">
              {col.jobs.map((j: any) => (
                <Link key={j.id} href={`/app/cfa/jobs/${j.id}`}
                  className="block rounded-input border px-12 py-10 text-xs" style={cardStyle}>
                  <p className="font-bold" style={{ color: "var(--brand)" }}>{j.file_number}</p>
                  <p className="mt-4 truncate" style={{ color: "var(--ink)" }}>{j.consignee_name}</p>
                  <p className="mt-4 flex items-center justify-between text-[10px]" style={{ color: "var(--ink-soft)" }}>
                    <span>{j.stages_done}/10 stages</span>
                    <span>{j.open_tasks} tasks</span>
                  </p>
                  {j.blocked && <p className="mt-4 text-[10px] font-bold uppercase" style={{ color: "var(--danger)" }}>blocked</p>}
                  {j.record_kind === "archive" && (
                    <p className="mt-4 text-[10px] font-bold uppercase" style={{ color: "var(--ink-soft)" }}>record only</p>
                  )}
                </Link>
              ))}
              {col.jobs.length === 0 && (
                <p className="py-16 text-center text-[11px]" style={{ color: "var(--line)" }}>empty</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Mine({ tasks, scope, setScope, onStatus }: {
  tasks: any[]; scope: string; setScope: (s: string) => void;
  onStatus: (t: any, s: string) => void;
}) {
  return (
    <div className="mt-24">
      <div className="flex flex-wrap items-center gap-12">
        <span className={headingCls} style={{ color: "var(--ink-soft)" }}>Assigned to you</span>
        {["open", "overdue", "all"].map(s => (
          <button key={s} type="button" onClick={() => setScope(s)}
            className="rounded-input border px-12 py-6 text-[11px] font-semibold uppercase"
            style={{
              borderColor: scope === s ? "var(--gold)" : "var(--line)",
              color: scope === s ? "var(--ink)" : "var(--ink-soft)"
            }}>{s}</button>
        ))}
      </div>
      <div className="mt-16 space-y-8">
        {tasks.map(t => {
          const late = t.status === "pending" && t.due_date && new Date(t.due_date) < new Date();
          return (
            <div key={t.id} className="flex items-center justify-between gap-12 rounded-card border bg-surface px-16 py-12" style={cardStyle}>
              <div className="min-w-0 text-sm">
                <p style={{ color: "var(--ink)" }}>
                  <span className="font-semibold">{t.title}</span>
                  {t.stage_name && <span className="ml-8 text-xs" style={{ color: "var(--ink-soft)" }}>{t.stage_name}</span>}
                </p>
                <p className="mt-4 text-xs">
                  <Link href={`/app/cfa/jobs/${t.job_id}`} className="underline" style={{ color: "var(--brand)" }}>
                    {t.file_number}
                  </Link>
                  <span className="ml-8" style={{ color: "var(--ink-soft)" }}>{t.consignee_name}</span>
                  {t.due_date && (
                    <span className="ml-8 tabular-nums" style={{ color: late ? "var(--danger)" : "var(--ink-soft)" }}>
                      due {fmtDate(t.due_date)}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-12">
                {t.status !== "pending" && <Badge label={t.status} color={t.status === "done" ? "var(--success)" : "var(--ink-soft)"} />}
                {t.status === "pending" && (
                  <>
                    <button type="button" className="text-xs underline" style={{ color: "var(--success)" }}
                      onClick={() => onStatus(t, "done")}>Done</button>
                    <button type="button" className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                      onClick={() => onStatus(t, "cancelled")}>Drop</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
        {tasks.length === 0 && (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Nothing on your list for this filter.</p>
        )}
      </div>
    </div>
  );
}

function AllJobs({ rows, filters, setFilters }: {
  rows: any[]; filters: any; setFilters: (f: any) => void;
}) {
  const set = (k: string, v: string) => setFilters({ ...filters, [k]: v });
  return (
    <div className="mt-24">
      <div className="flex flex-wrap items-end gap-12">
        {([["status", ["", "open", "closed", "cancelled"]],
           ["recordKind", ["", "live", "archive"]],
           ["stageKey", ["", ...STAGES]]] as [string, string[]][]).map(([key, opts]) => (
          <label key={key} className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>{key}</span>
            <select value={filters[key]} onChange={e => set(key, e.target.value)}
              className="rounded-input border px-12 py-8 text-xs" style={inputStyle}>
              {opts.map(o => <option key={o} value={o}>{o || "any"}</option>)}
            </select>
          </label>
        ))}
        <label className="block min-w-[220px] flex-1">
          <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Search</span>
          <input value={filters.search} onChange={e => set("search", e.target.value)}
            placeholder="file number, consignee, reference" className={inputCls} style={inputStyle} />
        </label>
      </div>

      <div className="mt-24 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
              <th className="py-8 pr-12 font-semibold">File</th>
              <th className="py-8 pr-12 font-semibold">Consignee</th>
              <th className="py-8 pr-12 font-semibold">Current stage</th>
              <th className="py-8 pr-12 font-semibold">Progress</th>
              <th className="py-8 pr-12 font-semibold">Tasks</th>
              <th className="py-8 pr-12 font-semibold">Free days</th>
              <th className="py-8 font-semibold">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(j => (
              <tr key={j.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                <td className="py-12 pr-12">
                  <Link href={`/app/cfa/jobs/${j.id}`} className="font-semibold underline" style={{ color: "var(--brand)" }}>
                    {j.file_number}
                  </Link>
                  <p className="text-[10px] uppercase" style={{ color: "var(--ink-soft)" }}>{j.shipment_type}</p>
                </td>
                <td className="py-12 pr-12" style={{ color: "var(--ink)" }}>{j.consignee_name}</td>
                <td className="py-12 pr-12">
                  <span style={{ color: "var(--ink)" }}>{j.current_stage ?? "All stages done"}</span>
                  {j.blocked_reason && (
                    <p className="mt-4 text-[11px]" style={{ color: "var(--danger)" }}>{j.blocked_reason}</p>
                  )}
                </td>
                <td className="py-12 pr-12 tabular-nums" style={{ color: "var(--ink)" }}>
                  {j.stages_done}/{j.stages_total}
                </td>
                <td className="py-12 pr-12 tabular-nums" style={{ color: j.overdue_tasks ? "var(--danger)" : "var(--ink-soft)" }}>
                  {j.open_tasks} open{j.overdue_tasks ? ` · ${j.overdue_tasks} late` : ""}
                </td>
                <td className="py-12 pr-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {j.free_days ? `${j.free_days}d from ${fmtDate(j.free_days_start)}` : "—"}
                </td>
                <td className="py-12">
                  <Badge label={j.record_kind === "archive" ? "record" : j.status} color={STATUS_EDGE[j.status] ?? "var(--ink-soft)"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="mt-24 text-sm" style={{ color: "var(--ink-soft)" }}>
            No jobs match these filters. A job opens automatically when a cargo file is created.
          </p>
        )}
      </div>
    </div>
  );
}

const TRANS_EDGE: Record<string, string> = {
  open: "var(--success)", temp_booked: "var(--gold)", confirmed: "var(--brand)",
  cancelled: "var(--ink-soft)"
};

const TRANS_LABEL: Record<string, string> = {
  open: "On the board", temp_booked: "Being booked", confirmed: "Confirmed",
  cancelled: "Withdrawn"
};

/** Mirrors the server's 12-hour auto-release window. */
const HOLD_HOURS = 12;
const holdDeadline = (iso: string) => new Date(iso).getTime() + HOLD_HOURS * 3_600_000;
function countdown(ms: number): string {
  if (ms <= 0) return "any moment now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
}

function Transport({ rows, scope, setScope, onChanged }:
  { rows: any[]; scope: string; setScope: (s: string) => void; onChanged: () => void }) {
  const chips = [
    { key: "open", label: "On the board" }, { key: "temp_booked", label: "Being booked" },
    { key: "confirmed", label: "Confirmed" },
    { key: "cancelled", label: "Withdrawn" }, { key: "all", label: "All" }
  ];
  const [panel, setPanel] = useState<{ id: string; kind: "decline" | "cancel" } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [, setClock] = useState(0);

  // Countdowns re-render without touching the server.
  useEffect(() => {
    const t = window.setInterval(() => setClock(c => c + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  async function act(t: any, kind: "confirm" | "reject" | "cancel", reasonText?: string) {
    setBusy(true); setActError(null); setNotice(null);
    try {
      const path = kind === "confirm" ? "confirm" : kind === "reject" ? "reject" : "cancel-booking";
      const res = await apiFetch(`/transport-requests/${t.id}/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reasonText ? { reason: reasonText } : {})
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setActError(errorText(j, "That action could not be completed. Try again.")); return; }
      setPanel(null); setReason("");
      setNotice(kind === "confirm"
        ? `Booking confirmed with ${t.booked_company_name} — they have been told to proceed.`
        : kind === "reject"
          ? "Declined — the load is back on the board."
          : "Booking cancelled — the load is back on the board.");
      onChanged();
    } catch { setActError("That action could not be completed. Try again."); }
    finally { setBusy(false); }
  }

  function openPanel(id: string, kind: "decline" | "cancel") {
    const next = panel?.id === id && panel.kind === kind ? null : { id, kind };
    setPanel(next); setReason(""); setActError(null);
  }

  return (
    <section className="mt-24">
      <div className="flex flex-wrap items-center gap-8">
        {chips.map(c => (
          <button key={c.key} type="button" onClick={() => setScope(c.key)}
            className="rounded-input border px-12 py-6 text-[11px] font-bold uppercase tracking-[0.1em]"
            style={{
              borderColor: scope === c.key ? "var(--brand)" : "var(--line)",
              color: scope === c.key ? "var(--brand)" : "var(--ink-soft)"
            }}>
            {c.label}
          </button>
        ))}
      </div>

      <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
        Each row is the approved copy that other companies see — never the live cargo file.
        Publish from a job at stage 9, once the client has given consent.
        A hold is confirmed or declined here, within 12 hours.
      </p>

      {notice && (
        <div role="status" className="mt-12 px-16 py-12 text-sm"
          style={{ background: "color-mix(in srgb, #5fce93 14%, transparent)", borderLeft: "4px solid #5fce93" }}>
          {notice}
        </div>
      )}
      {actError && !panel && (
        <div role="alert" className="mt-12 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {actError}
        </div>
      )}

      <div className="mt-16 space-y-12">
        {rows.map(t => (
          <div key={t.id} className={card} style={cardStyle}>
            <div className="flex flex-wrap items-start justify-between gap-12">
              <div className="min-w-0">
                <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                  {t.pickup_text} → {t.dest_text}{t.via_label && ` via ${t.via_label}`}
                </p>
                <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {t.cargo_label}
                  {t.container_count ? ` · ${t.container_count} × ${t.container_type?.replace("_", " ") ?? ""}` : ""}
                  {t.weight_tonnes ? ` · ${t.weight_tonnes} t` : ""}
                  {t.distance_km ? ` · ${t.distance_km} km` : ""}
                </p>
              </div>
              <Badge label={TRANS_LABEL[t.status] ?? t.status.replace("_", " ")} color={TRANS_EDGE[t.status] ?? "var(--ink-soft)"} />
            </div>

            <div className="mt-12 grid grid-cols-1 gap-8 text-xs md:grid-cols-3">
              <p style={{ color: "var(--ink)" }}>
                <span style={{ color: "var(--ink-soft)" }}>Needed </span>{fmtDate(t.required_date)}
              </p>
              <p style={{ color: "var(--ink)" }}>
                <span style={{ color: "var(--ink-soft)" }}>Vehicles </span>
                {t.vehicle_types?.length ? t.vehicle_types.map((v: string) => v.replace("_", " ")).join(", ") : "any"}
              </p>
              <p style={{ color: "var(--ink)" }}>
                <span style={{ color: "var(--ink-soft)" }}>Contact </span>{t.contact_name}
              </p>
            </div>
            <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              Card: {t.company_name} · file {t.file_number} (visible to you only)
            </p>

            {t.status === "temp_booked" && (() => {
              const left = holdDeadline(t.temp_booked_at) - Date.now();
              return (
                <div className="mt-12 rounded-card p-12"
                  style={{
                    background: "color-mix(in srgb, var(--gold) 10%, transparent)",
                    border: "1px solid var(--line)"
                  }}>
                  <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>
                    {t.booked_company_name} is holding this load
                  </p>
                  <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {t.booked_contact_name} · {t.booked_contact_channel}
                  </p>
                  <BookerCard t={t} />
                  <p className="mt-8 text-xs font-semibold"
                    style={{ color: left <= 2 * 3_600_000 ? "var(--danger)" : "var(--ink)" }}>
                    Confirm within {countdown(left)} (by{" "}
                    {new Date(holdDeadline(t.temp_booked_at)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    ) — without an answer it goes back on the board automatically
                    {t.reminder_sent_at ? " · 6h reminder sent" : ""}.
                  </p>
                  <div className="mt-8 flex flex-wrap gap-8">
                    <button type="button" disabled={busy} onClick={() => act(t, "confirm")}
                      className="waisha-btn rounded-input px-12 py-6 text-xs font-semibold"
                      style={{ background: "var(--brand)", color: "#fff", opacity: busy ? 0.6 : 1 }}>
                      {busy ? "Working…" : "Confirm booking"}
                    </button>
                    <button type="button" onClick={() => openPanel(t.id, "decline")}
                      className="rounded-input border px-12 py-6 text-xs font-semibold"
                      style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                      {panel !== null && panel.id === t.id && panel.kind === "decline" ? "Keep the hold" : "Decline…"}
                    </button>
                  </div>
                  {panel !== null && panel.id === t.id && panel.kind === "decline" && (
                    <div className="mt-8">
                      <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                        Declining puts the load straight back on the board. A note is optional.
                      </p>
                      <input value={reason} maxLength={300} placeholder="Note for the company (optional)"
                        onChange={e => setReason(e.target.value)}
                        className="mt-6 w-full rounded-input border px-12 py-8 text-sm" style={inputStyle} />
                      {actError && (
                        <p role="alert" className="mt-6 text-xs" style={{ color: "var(--danger)" }}>{actError}</p>
                      )}
                      <button type="button" disabled={busy}
                        onClick={() => act(t, "reject", reason.trim().length >= 2 ? reason.trim() : undefined)}
                        className="mt-8 rounded-input px-12 py-6 text-xs font-semibold"
                        style={{ background: "var(--danger)", color: "#fff", opacity: busy ? 0.6 : 1 }}>
                        {busy ? "Working…" : "Decline booking"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {t.status === "confirmed" && (
              <div className="mt-12 rounded-card p-12"
                style={{ background: "var(--milk)", border: "1px solid var(--line)" }}>
                <p className="text-xs font-semibold" style={{ color: "var(--ink)" }}>
                  Confirmed with {t.booked_company_name}
                </p>
                <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {t.booked_contact_name} · {t.booked_contact_channel}
                  {t.confirmed_at ? ` · confirmed ${new Date(t.confirmed_at).toLocaleString()}` : ""}
                </p>
                <BookerCard t={t} />
                <button type="button" onClick={() => openPanel(t.id, "cancel")}
                  className="mt-8 rounded-input border px-12 py-6 text-xs font-semibold"
                  style={{ borderColor: "var(--line)", color: "var(--danger)" }}>
                  {panel !== null && panel.id === t.id && panel.kind === "cancel" ? "Keep the booking" : "Cancel booking…"}
                </button>
                {panel !== null && panel.id === t.id && panel.kind === "cancel" && (
                  <div className="mt-8">
                    <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                      Cancelling a confirmed booking needs a reason — it is logged and shared with
                      {" "}{t.booked_company_name}. The load goes back on the board.
                    </p>
                    <input value={reason} maxLength={300} placeholder="Why is this booking being cancelled?"
                      onChange={e => setReason(e.target.value)}
                      className="mt-6 w-full rounded-input border px-12 py-8 text-sm" style={inputStyle} />
                    {actError && (
                      <p role="alert" className="mt-6 text-xs" style={{ color: "var(--danger)" }}>{actError}</p>
                    )}
                    <button type="button" disabled={busy || reason.trim().length < 4}
                      onClick={() => act(t, "cancel", reason.trim())}
                      className="mt-8 rounded-input px-12 py-6 text-xs font-semibold"
                      style={{
                        background: "var(--danger)", color: "#fff",
                        opacity: busy || reason.trim().length < 4 ? 0.55 : 1
                      }}>
                      {busy ? "Working…" : "Cancel booking"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {t.status === "open" && t.released_at && (
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                Back on the board since {new Date(t.released_at).toLocaleString()}
                {t.booked_company_name ? ` — the hold by ${t.booked_company_name} ended.` : "."}
              </p>
            )}

            <Link href={`/app/cfa/jobs/${t.job_id}`}
              className="mt-12 inline-block text-xs underline" style={{ color: "var(--brand)" }}>
              Open the job
            </Link>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
            Nothing published under this filter yet.
          </p>
        )}
      </div>
    </section>
  );
}
