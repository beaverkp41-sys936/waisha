"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/app/dashboard", label: "Dashboard", accent: "var(--gold)" },
  { href: "/app/profile", label: "Profile", accent: "var(--success)" },
  { href: "/app/branches", label: "Branches", accent: "var(--brand)" },
  { href: "/app/fleet", label: "Fleet", accent: "var(--gold-green)" },
  { href: "/app/routes", label: "Routes", accent: "var(--gold)" },
  { href: "/app/drivers", label: "Drivers", accent: "var(--success)" },
  { href: "/app/trips", label: "Trips", accent: "var(--gold)" },
  { href: "/app/staff", label: "Staff", accent: "var(--brand)" },
  { href: "/app/account", label: "Account", accent: "rgba(255,255,255,0.7)" }
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const area =
    pathname.startsWith("/app/cfa") ? "cfa" :
    pathname.startsWith("/app/office") ? "office" : "transporter";

  return (
    <div className="min-h-screen" style={{ background: "var(--milk)" }}>
      <header style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--gold)" }}>
        <div className="flex items-center justify-between px-24 pt-12">
          <span className="text-sm font-bold tracking-[0.08em] text-white">WAISHA</span>
          <nav className="flex gap-16 text-[11px] font-bold uppercase tracking-[0.12em]">
            <Link href="/app/dashboard"
              className="px-8 pb-8 transition-colors duration-200"
              style={{ color: area === "transporter" ? "var(--gold)" : "rgba(255,255,255,0.55)",
                       borderBottom: area === "transporter" ? "2px solid var(--gold)" : "2px solid transparent" }}>
              Transporter
            </Link>
            <Link href="/app/cfa"
              className="px-8 pb-8 transition-colors duration-200"
              style={{ color: area === "cfa" ? "var(--gold)" : "rgba(255,255,255,0.55)",
                       borderBottom: area === "cfa" ? "2px solid var(--gold)" : "2px solid transparent" }}>
              CFA Management
            </Link>
            <Link href="/app/office"
              className="px-8 pb-8 transition-colors duration-200"
              style={{ color: area === "office" ? "var(--gold)" : "rgba(255,255,255,0.55)",
                       borderBottom: area === "office" ? "2px solid var(--gold)" : "2px solid transparent" }}>
              Office Management
            </Link>
          </nav>
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "rgba(255,255,255,0.6)" }}>
            Transporter portal
          </span>
        </div>
        {area === "transporter" && (
          <nav className="flex gap-24 px-24 pb-12 pt-4 text-xs font-semibold">
            {NAV.map(n => {
              const active = pathname === n.href || pathname.startsWith(n.href + "/");
              return (
                <Link key={n.href} href={n.href}
                  className="relative pb-4 pt-4 transition-colors duration-200"
                  style={{ color: active ? n.accent : "rgba(255,255,255,0.65)" }}>
                  {n.label}
                  {active && (
                    <span aria-hidden className="absolute bottom-0 left-0 right-0 h-[2px]"
                      style={{ background: n.accent }} />
                  )}
                </Link>
              );
            })}
          </nav>
        )}
      </header>
      <main>{children}</main>
    </div>
  );
}
