"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
const LICENCE = ["super_admin", "billing_admin"];

type Screen = { href: string; label: string; roles?: string[]; keys?: string[] };

/**
 * Which desk a seat may open, keyed on what each route actually enforces.
 *
 * The panel used to show every link to everybody and let the API answer 403, which
 * reads to a new analyst as "the panel is broken". Two of the gates are still role
 * checks from before the permission matrix (tenants, plans, notices, directory), so
 * those keys are matched here as roles — a link conditioned on a permission the route
 * never reads would promise a door that then shuts.
 */
const SCREENS: Screen[] = [
  { href: "/control", label: "Pricing", roles: LICENCE },
  { href: "/control/revenue", label: "Revenue", keys: ["control.analytics.view"] },
  { href: "/control/subscriptions", label: "Customers",
    keys: ["control.subscriptions.view", "control.analytics.view"] },
  { href: "/control/payments", label: "Money", keys: ["control.subscriptions.view"] },
  { href: "/control/tenants", label: "Tenants", roles: LICENCE },
  { href: "/control/directory", label: "Directory", roles: LICENCE },
  { href: "/control/recommendations", label: "Inbox",
    keys: ["control.recommendations.view", "control.recommendations.manage"] },
  { href: "/control/staff", label: "Staff", keys: ["control.staff.view", "control.staff.manage"] },
  { href: "/control/forensics", label: "Forensics", keys: ["control.audit.view"] },
  { href: "/control/system", label: "System", keys: ["control.system.view"] },
  { href: "/control/announcements", label: "Notices", roles: LICENCE }
];

function open(s: Screen, roles: string[], permissions: string[]) {
  if (s.roles?.some((r) => roles.includes(r))) return true;
  return !!s.keys?.some((k) => permissions.includes(k));
}

export function ControlNav() {
  const pathname = usePathname();
  const [access, setAccess] = useState<{ roles: string[]; permissions: string[] }>(
    { roles: [], permissions: [] });

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (!res.ok) return;
      const j = await res.json();
      setAccess({ roles: j.roles ?? [], permissions: j.permissions ?? [] });
    })();
  }, []);

  const visible = SCREENS.filter((s) => open(s, access.roles, access.permissions));

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-14 gap-y-6 text-xs font-semibold"
      style={{ maxWidth: 660 }}>
      {visible.map((s) => {
        const active = pathname === s.href;
        return active ? (
          <span key={s.href} aria-current="page" className="text-white">{s.label}</span>
        ) : (
          <Link key={s.href} href={s.href} className="underline" style={{ color: "var(--adm-accent)" }}>
            {s.label}
          </Link>
        );
      })}
      <button type="button"
        className="rounded-input border px-16 py-8 text-white"
        style={{ borderColor: "rgba(255,255,255,0.4)" }}
        onClick={async () => {
          await fetch(`${API}/api/v1/control/auth/logout`, { method: "POST", credentials: "include" });
          window.location.href = "/control/login";
        }}>
        Sign out
      </button>
    </div>
  );
}
