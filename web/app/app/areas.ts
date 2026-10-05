// Workspace areas — the portal's top-level structure. An area unlocks when
// the tenant's plan module list (licence.modules) carries any of the area's
// module keys, or "*" for enterprise. Server-side enforcement arrives with
// each module; these gates drive what the portal shows today.

export interface AreaDef {
  key: string;
  label: string;
  href: string;
  /** Module entitlement keys that unlock the area. */
  modules: string[];
  /** Cheapest plan name that carries the area (for locked-state copy). */
  planLabel: string;
  /** One-line description for hub cards. */
  description: string;
}

export const AREAS: AreaDef[] = [
  {
    key: "transporter",
    label: "Transporter",
    href: "/app/dashboard",
    modules: [],
    planLabel: "All plans",
    description: "Fleet, drivers, routes, trips, cargo and staff — the operating core."
  },
  {
    key: "cfa",
    label: "CFA Management",
    href: "/app/cfa",
    modules: ["invoices", "documents", "ledger", "duty_calculator", "costs"],
    planLabel: "Business",
    description: "Invoices and billing, financial ledger, duty calculator, messages, ETA calendar, compliance."
  },
  {
    key: "office",
    label: "Office Management",
    href: "/app/office",
    modules: ["office"],
    planLabel: "Enterprise",
    description: "Employees, tasks and ranks, evaluations, contracts, trainees and office costs."
  }
];

export interface LicenceModules {
  modules?: string[] | null;
}

export function areaUnlocked(area: AreaDef, licence: LicenceModules | null | undefined): boolean {
  if (area.key === "transporter") return true;
  const mods = licence?.modules ?? [];
  if (mods.includes("*")) return true;
  return area.modules.some((m) => mods.includes(m));
}
