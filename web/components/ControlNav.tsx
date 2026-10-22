"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity, Banknote, Boxes, Bug, Building2, CreditCard, Globe, Headphones, Languages, Lightbulb, LogOut,
  Megaphone, Scale, ScrollText, Settings2, Stamp, Tag, TrendingUp, UserCog, Users, type LucideIcon
} from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
const LICENCE = ["super_admin", "billing_admin"];

type Screen = { href: string; label: string; icon: LucideIcon; roles?: string[]; keys?: string[] };

/**
 * Which desk a seat may open, keyed on what each route actually enforces.
 *
 * The panel used to show every link to everybody and let the API answer 403, which
 * reads to a new analyst as "the panel is broken". Three of the gates are still role
 * checks from before the permission matrix (plans, notices, directory), so those keys
 * are matched here as roles — a link conditioned on a permission the route never reads
 * would promise a door that then shuts. Tenants carries both: selling a licence is a
 * licence role, shutting a company is control.tenants.manage.
 *
 * The icon is the desk's own: fourteen lines of the same colour read as a wall of text,
 * and an operator hunting for the machine room looks for the gear, not the word.
 */
const SCREENS: Screen[] = [
  { href: "/control", label: "Pricing", icon: Tag, roles: LICENCE },
  { href: "/control/revenue", label: "Revenue", icon: TrendingUp, keys: ["control.analytics.view"] },
  { href: "/control/subscriptions", label: "Customers", icon: Users,
    keys: ["control.subscriptions.view", "control.analytics.view"] },
  { href: "/control/payments", label: "Money", icon: Banknote, keys: ["control.subscriptions.view"] },
  // Which network the platform takes money through. Read wider than it is written, exactly as
  // the routes enforce it — a support seat that cannot see which rail is live cannot answer
  // "my customer paid and nothing happened".
  { href: "/control/gateway", label: "Gateway", icon: CreditCard,
    keys: ["control.gateway.view", "control.gateway.manage"] },
  { href: "/control/tenants", label: "Tenants", icon: Building2, roles: LICENCE, keys: ["control.tenants.manage"] },
  // The second seat's desk. Both keys open it because the register is read by people who
  // cannot sign as well as by people who can — a ban that needs a second opinion must be
  // visible to whoever is asked for it, or the queue sits unnoticed and the company stays
  // blocked by nothing except waiting.
  { href: "/control/approvals", label: "Approvals", icon: Stamp,
    keys: ["control.approvals.view", "control.approvals.decide"] },
  { href: "/control/directory", label: "Directory", icon: Globe, roles: LICENCE },
  { href: "/control/recommendations", label: "Inbox", icon: Lightbulb,
    keys: ["control.recommendations.view", "control.recommendations.manage"] },
  { href: "/control/staff", label: "Staff", icon: UserCog, keys: ["control.staff.view", "control.staff.manage"] },
  { href: "/control/departments", label: "Departments", icon: Boxes,
    keys: ["control.departments.view", "control.departments.manage"] },
  // The customer service register: every call that was written down, and the desk that now
  // owns it. Its own two duties, because reading a register of complaints is not the same
  // authority as settling one.
  { href: "/control/tickets", label: "Calls", icon: Headphones,
    keys: ["control.tickets.view", "control.tickets.manage"] },
  // What a call left behind: the disputes written against it, the papers it owes, the caller's
  // answer and the mark on the seat. Three duties because opening a file, deciding one and
  // grading a call are three different authorities — and a seat that can only read them all
  // still needs the link to find them.
  { href: "/control/service", label: "Service", icon: Scale,
    keys: ["control.service.view", "control.service.manage", "control.service.review"] },
  // The command center. `control.view` is the floor every platform seat already holds and the
  // route reads it for the read, so this is the one desk a new analyst sees on day one — the
  // words are nobody's secret; publishing them is.
  { href: "/control/content", label: "Copy", icon: Languages,
    keys: ["control.view", "control.content.manage"] },
  { href: "/control/forensics", label: "Forensics", icon: ScrollText, keys: ["control.audit.view"] },
  { href: "/control/system", label: "System", icon: Settings2, keys: ["control.system.view"] },
  { href: "/control/reliability", label: "Reliability", icon: Activity, keys: ["control.system.view"] },
  { href: "/control/errors", label: "Errors", icon: Bug, keys: ["control.system.view"] },
  { href: "/control/announcements", label: "Notices", icon: Megaphone, roles: LICENCE }
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

  // The desks read left to right along their own row under the announcement bar, each
  // entry one unbreakable line of icon then name. `order: 4` is what keeps it on that
  // row: the header is a single wrapping flex shared by fifteen desk pages, and below
  // 560px the ticker claims order 3, so a nav that relied on DOM order alone would jump
  // back above it. Wrapping rather than columns because a panel this wide is scanned
  // along the top, not read down a list.
  return (
    <nav className="w-full" style={{ order: 4 }} aria-label="Control desks">
      <ul className="m-0 flex list-none flex-wrap items-center gap-x-20 gap-y-6 p-0">
        {visible.map((s) => {
          const active = pathname === s.href;
          const Icon = s.icon;
          // py-10, not py-4: at phone width these are thumb targets, and a 24px-tall line of
          // the sub-nav is the one thing on the shell a seat taps constantly. 36px is the
          // floor the phone probe stops flagging, and it reads the same on a desk.
          const row = "flex min-h-[36px] items-center gap-8 whitespace-nowrap border-l-2 py-4 pl-8 text-xs font-semibold";
          return (
            <li key={s.href}>
              {active ? (
                <span aria-current="page" className={`${row} text-white`}
                  style={{ borderColor: "var(--adm-accent)" }}>
                  <Icon aria-hidden width={15} height={15} strokeWidth={1.9} />
                  {s.label}
                </span>
              ) : (
                <Link href={s.href} className={`${row} hover:text-white`}
                  style={{ borderColor: "transparent", color: "var(--adm-accent)" }}>
                  <Icon aria-hidden width={15} height={15} strokeWidth={1.9} />
                  {s.label}
                </Link>
              )}
            </li>
          );
        })}
        <li>
          <button type="button"
            className="flex min-h-[36px] items-center gap-8 whitespace-nowrap border-0 bg-transparent py-4 text-xs font-semibold"
            style={{ color: "var(--adm-accent)" }}
            onClick={async () => {
              await fetch(`${API}/api/v1/control/auth/logout`, { method: "POST", credentials: "include" });
              window.location.href = "/control/login";
            }}>
            <LogOut aria-hidden width={15} height={15} strokeWidth={1.9} />
            Sign out
          </button>
        </li>
      </ul>
    </nav>
  );
}
