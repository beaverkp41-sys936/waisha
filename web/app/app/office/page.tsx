"use client";
import Link from "next/link";
import { useLicence } from "../account/gate";
import { AREAS, areaUnlocked } from "../areas";

const MODULES = [
  {
    name: "Employees Management",
    href: "/app/office/employees",
    description: "Your people, ranked by task handling — overview KPIs and a leaderboard, roster with skills and contracts, daily assignments linked to cargo files, monthly evaluations, renewal countdowns and the trainee register with absorption.",
    plan: "Enterprise"
  },
  {
    name: "Procedural flows",
    href: "/app/office/procedures",
    description: "How work is meant to be done here — the procedure library (system defaults you copy, house flows you own) and, per task, the steps from Initiation to Final Sign-off with the mandatory checklist that has to be ticked before a step can close.",
    plan: "Enterprise"
  },
  {
    name: "Trainee reports",
    href: "/app/office/reports",
    description: "The one-page performance and completion report, counted from the tasks and evaluations inside the period, graded on four competencies and closed only when the Head of Department, HR Manager and Direct Supervisor have each put their name to it. Prints as issued.",
    plan: "Enterprise"
  },
  {
    name: "Office Management",
    href: "/app/office/costs",
    description: "What running the office costs — dashboard by period, allowances, meals and refreshments, daily costs with approvals, file costs against revenue, and budget-versus-spend reports.",
    plan: "Enterprise"
  }
];

export default function OfficeAreaPage() {
  const { licence } = useLicence();
  const unlocked = areaUnlocked(AREAS.find(a => a.key === "office")!, licence);

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Office Management</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        The back office — people, performance and running costs.
      </p>
      {!unlocked && (
        <div role="status" className="pane-note mt-16 px-16 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--gold) 14%, transparent)", borderLeft: "4px solid var(--gold)" }}>
          This workspace arrives with the Enterprise plan and is in build.
        </div>
      )}
      {unlocked && (
        <div role="status" className="pane-note mt-16 px-16 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>
          Included in your plan — shipped modules open below, the rest land here as they are built.
        </div>
      )}

      <div className="mt-24 grid grid-cols-1 gap-16 md:grid-cols-2">
        {MODULES.map(m => {
          const card = (
            <div key={m.name} className="rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
              <div className="flex items-start justify-between gap-12">
                <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{m.name}</p>
                <span className="whitespace-nowrap px-8 py-2 text-[10px] font-bold uppercase"
                  style={{ borderLeft: "4px solid var(--gold)", color: "var(--ink-soft)" }}>
                  {m.plan}
                </span>
              </div>
              <p className="mt-8 text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>{m.description}</p>
              <p className="mt-12 text-[10px] font-bold uppercase tracking-[0.14em]"
                style={{ color: m.href ? "var(--brand)" : "var(--gold-green)" }}>
                {m.href ? "Open module" : "In build"}
              </p>
            </div>
          );
          return m.href ? <Link key={m.name} href={m.href} className="block">{card}</Link> : card;
        })}
      </div>

      <p className="pane-note mt-24 text-xs">
        Plan and billing live in <Link href="/app/account" className="underline">Account</Link>.
      </p>
    </div>
  );
}
