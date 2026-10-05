"use client";
import Link from "next/link";
import { useLicence } from "../account/gate";
import { AREAS, areaUnlocked } from "../areas";

const MODULES = [
  {
    name: "Invoices & Billing",
    description: "Shipping-grade invoices on your letterhead — line items with a live 18% VAT calculator, payment tracking (Paid / Partial / Overdue), record payments and print-ready output.",
    plan: "Business"
  },
  {
    name: "Financial Ledger",
    description: "Accounts receivable and payable, profit-and-loss summary cards and a monthly revenue-versus-expenses view of cash flow.",
    plan: "Business"
  },
  {
    name: "Documents Vault",
    description: "Licences, insurance certificates, inspection papers and delivery notes stored against vessels, drivers and trips.",
    plan: "Business"
  },
  {
    name: "Duty Calculator",
    description: "Enter an HS code and CIF value — import duty, excise, railway levy, VAT and total landed cost computed against TRA rates.",
    plan: "Business"
  },
  {
    name: "Internal Messages",
    description: "One conversation per cargo file — read states, attachments and a general team channel.",
    plan: "Enterprise"
  },
  {
    name: "ETA Calendar",
    description: "Month calendar marking arrivals, deadlines, renewals and payments, with an upcoming-events sidebar.",
    plan: "Enterprise"
  },
  {
    name: "Compliance & Screening",
    description: "Client blacklist screening, plus a licence tracker for TRA, BRELA and bond permits with renewal alerts.",
    plan: "Enterprise"
  }
];

export default function CfaAreaPage() {
  const { licence } = useLicence();
  const unlocked = areaUnlocked(AREAS.find(a => a.key === "cfa")!, licence);

  const inputStyle = { borderColor: "var(--line)" };

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>CFA Management</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Clearing, forwarding and finance — the working back office for cargo files.
      </p>
      {!unlocked && (
        <div role="status" className="mt-16 px-16 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--gold) 14%, transparent)", borderLeft: "4px solid var(--gold)" }}>
          These modules arrive with the Business plan and are in build — your plan unlocks them the day they land.
        </div>
      )}
      {unlocked && (
        <div role="status" className="mt-16 px-16 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>
          Included in your plan — modules below are in build and will appear here as they ship.
        </div>
      )}

      <div className="mt-24 grid grid-cols-1 gap-16 md:grid-cols-2">
        {MODULES.map(m => (
          <div key={m.name} className="rounded-card border bg-surface p-24" style={inputStyle}>
            <div className="flex items-start justify-between gap-12">
              <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{m.name}</p>
              <span className="whitespace-nowrap px-8 py-2 text-[10px] font-bold uppercase"
                style={{ borderLeft: `4px solid ${m.plan === "Enterprise" ? "var(--gold)" : "var(--brand)"}`, color: "var(--ink-soft)" }}>
                {m.plan}
              </span>
            </div>
            <p className="mt-8 text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>{m.description}</p>
            <p className="mt-12 text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--gold-green)" }}>
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
