"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { portalFetch } from "./api-client";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

const NAV = [
  { href: "/portal", label: "Overview" },
  { href: "/portal/files", label: "My files" },
  { href: "/portal/invoices", label: "Invoices" },
  { href: "/portal/documents", label: "Documents" }
];

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [me, setMe] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    portalFetch("/auth/me").then(async res => {
      if (res.ok && !cancelled) setMe(await res.json());
    }).catch(() => { });
    return () => { cancelled = true; };
  }, []);

  async function signOut() {
    sessionStorage.removeItem("waisha_access");
    await fetch(`${API}/api/v1/auth/logout`, { method: "POST", credentials: "include" })
      .catch(() => { });
    window.location.href = "/login?tab=shipper";
  }

  return (
    <div className="portal-shell flex-1" style={{ background: "var(--milk)" }}>
      <header style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--gold)" }}>
        <div className="flex flex-wrap items-center justify-between gap-12 px-16 py-12">
          <div className="flex items-baseline gap-12">
            <span className="text-sm font-bold tracking-[0.08em] text-white">WAISHA</span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{ color: "rgba(255,255,255,0.6)" }}>
              {me?.tenant_name ?? "Client portal"}
            </span>
          </div>
          <div className="flex items-center gap-16">
            {me?.name && (
              <span className="text-[11px] font-semibold" style={{ color: "rgba(255,255,255,0.75)" }}>
                {me.name}
              </span>
            )}
            <button type="button" onClick={signOut}
              className="rounded-input border px-12 py-6 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors"
              style={{ borderColor: "rgba(255,255,255,0.35)", color: "rgba(255,255,255,0.85)" }}>
              Sign out
            </button>
          </div>
        </div>
        <nav className="flex gap-x-24 px-16 pb-12 pt-4 text-xs font-semibold">
          {NAV.map(n => {
            const active = n.href === "/portal"
              ? pathname === "/portal"
              : pathname.startsWith(n.href);
            return (
              <Link key={n.href} href={n.href}
                className="relative pb-8 pt-4 transition-colors duration-200"
                style={{ color: active ? "var(--gold)" : "rgba(255,255,255,0.65)" }}>
                {n.label}
                {active && (
                  <span aria-hidden className="absolute bottom-0 left-0 right-0 h-[2px]" style={{ background: "var(--gold)" }} />
                )}
              </Link>
            );
          })}
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
