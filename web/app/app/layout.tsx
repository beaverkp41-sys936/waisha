"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "./api-client";
import { CFA_NAV, OFFICE_NAV, TRANSPORTER_NAV } from "./nav";
import type { NavItem } from "./nav";
import { ShellFooter } from "@/components/ShellFooter";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";

const WORKSPACES = [
  { key: "transporter", label: "Transporter", home: "/app/dashboard" },
  { key: "cfa", label: "CFA", home: "/app/cfa" },
  { key: "office", label: "Office", home: "/app/office" }
] as const;

const NAV_BY_AREA: Record<string, NavItem[]> = {
  transporter: TRANSPORTER_NAV,
  cfa: CFA_NAV,
  office: OFFICE_NAV
};

function areaOf(pathname: string) {
  if (pathname.startsWith("/app/cfa") || pathname === "/app/documents") return "cfa";
  if (pathname.startsWith("/app/office")) return "office";
  return "transporter";
}

/** Longest matching href wins, so /app/cfa/cargo is not also /app/cfa. */
function activeHref(pathname: string, items: NavItem[]) {
  let best = "";
  for (const item of items) {
    const hit = pathname === item.href || pathname.startsWith(item.href + "/");
    if (hit && item.href.length > best.length) best = item.href;
  }
  return best;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const area = areaOf(pathname);
  const items = NAV_BY_AREA[area];
  const current = items.find(i => i.href === activeHref(pathname, items));
  const workspace = WORKSPACES.find(w => w.key === area)!;

  // Header alert count — the number of unseen alerts, refreshed on a timer
  // and on demand (the alerts page raises "waisha:alerts" when it marks read).
  const [alertCount, setAlertCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      apiFetch("/notifications").then(async res => {
        if (!res.ok || cancelled) return;
        const j = await res.json();
        if (!cancelled) setAlertCount(j.counts?.unread ?? 0);
      }).catch(() => { });
    };
    read();
    const tick = setInterval(read, 60_000);
    window.addEventListener("waisha:alerts", read);
    return () => {
      cancelled = true;
      clearInterval(tick);
      window.removeEventListener("waisha:alerts", read);
    };
  }, []);

  return (
    <div className="app-shell">
      <div aria-hidden className="ws-bg" data-area={area}>
        <div className="ws-bg-img" data-on="transporter" />
        <div className="ws-bg-img" data-on="cfa" />
        <div className="ws-bg-img" data-on="office" />
        <div className="ws-bg-scrim" />
      </div>

      <aside className="sidebar">
        <Link href={workspace.home} className="brand-lockup">
          <Image src="/brand/waisha-white@2x.png" width={452} height={211}
            alt="WAISHA" priority />
          <span className="brand-tagline">Where shippers meet transporters</span>
        </Link>

        <div className="workspace-switch" role="group" aria-label="Workspace">
          {WORKSPACES.map(w => (
            <Link key={w.key} href={w.home} aria-current={area === w.key ? "true" : undefined}>
              {w.label}
            </Link>
          ))}
        </div>

        <nav className="nav-scroll" aria-label="Portal sections">
          {items.map(({ href, label, icon: Icon }) => {
            const active = activeHref(pathname, items) === href;
            return (
              <Link key={href} href={href} className={"nav-item" + (active ? " is-active" : "")}
                aria-current={active ? "page" : undefined}>
                <Icon aria-hidden strokeWidth={1.8} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="aegis">
          <Image src="/brand/tengo-emblem@2x.png" width={112} height={112} alt="" />
          <span>
            <span className="aegis-name">A Tengo Aegis product</span>
            <span className="aegis-line">From the shadow side to the edge of space</span>
          </span>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <p className="crumb">
            <span className="crumb-area">{workspace.label} / </span>
            <b>{current?.label ?? workspace.label}</b>
          </p>
          <AnnouncementTicker />
          <div className="topbar-right">
            <Link href="/app/notifications" className="alert-pill">
              <span className={"alert-dot" + (alertCount ? " is-live" : "")} aria-hidden />
              Alerts{alertCount ? ` (${alertCount})` : ""}
            </Link>
            <span className="flagpole" aria-hidden>
              <span className="flagpole-finial" />
              <span className="flagpole-mast" />
              <span className="flagpole-flag">
                <Image src="/brand/tengo-flag.jpg" width={204} height={136} alt="" />
              </span>
            </span>
          </div>
        </header>
        <div className="app-content">{children}</div>
        <ShellFooter />
      </div>
    </div>
  );
}
