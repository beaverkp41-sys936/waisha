"use client";
import Link from "next/link";
import { useLicence } from "../account/gate";
import { AREAS, areaUnlocked } from "../areas";

const SYSTEMS = [
  {
    name: "Employees Management",
    description: "Your people, ranked by task handling.",
    items: [
      "Overview — staff KPIs and a leaderboard ranked by completed tasks",
      "Roster — member profiles with skills, contracts and ratings",
      "Tasks & Files — daily assignments linked to cargo files with priorities and deadlines",
      "Evaluation — performance across task completion, punctuality, client satisfaction and collaboration",
      "Contracts — permanent and fixed-term register with renewal countdowns",
      "Trainees — internship register with supervisors and absorption on completion",
      "Reports — payroll summary and graded task performance"
    ]
  },
  {
    name: "Office Management",
    description: "What running the office costs, per day and per file.",
    items: [
      "Dashboard — daily, weekly, monthly and yearly cost totals by category",
      "Allowances — transport, housing and field allowances per employee",
      "Meals & Drinks — daily meals and refreshments logs with period totals",
      "Daily Costs — expense log with approval and receipt tracking",
      "File Costs — clearance, transport and staff time per cargo file against revenue",
      "Reports — budget versus spend and revenue versus costs"
    ]
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
        <div role="status" className="mt-16 px-16 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--gold) 14%, transparent)", borderLeft: "4px solid var(--gold)" }}>
          This workspace arrives with the Enterprise plan and is in build.
        </div>
      )}
      {unlocked && (
        <div role="status" className="mt-16 px-16 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>
          Included in your plan — modules below are in build and will appear here as they ship.
        </div>
      )}

      <div className="mt-24 space-y-16">
        {SYSTEMS.map(s => (
          <div key={s.name} className="rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
            <div className="flex items-start justify-between gap-12">
              <div>
                <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{s.name}</p>
                <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{s.description}</p>
              </div>
              <span className="whitespace-nowrap px-8 py-2 text-[10px] font-bold uppercase"
                style={{ borderLeft: "4px solid var(--gold)", color: "var(--ink-soft)" }}>
                Enterprise
              </span>
            </div>
            <ul className="mt-16 space-y-8">
              {s.items.map(i => (
                <li key={i} className="text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                  {i}
                </li>
              ))}
            </ul>
            <p className="mt-16 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--gold-green)" }}>
              In build
            </p>
          </div>
        ))}
      </div>

      <p className="mt-24 text-xs" style={{ color: "var(--ink-soft)" }}>
        Plan and billing live in <Link href="/app/account" className="underline">Account</Link>.
      </p>
    </div>
  );
}
