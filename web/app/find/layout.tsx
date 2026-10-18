"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { seekerFetch } from "./api-client";
import { MeterProvider, useMeter } from "./meter";
import { hm } from "./labels";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

const NAV = [
  { href: "/find", label: "Search" },
  { href: "/find/history", label: "My searches" },
  { href: "/find/recommendations", label: "Recommendations" },
  { href: "/find/account", label: "Account" }
];

/**
 * The meter, in one line of the header. It reads exactly like the database decides:
 * a live pass shows what is left on it, otherwise the countdown to the next free
 * credit. When a free search is waiting the chip is only a pointer to the search
 * page — the claiming itself happens there, on the meter card, so the header never
 * offers a second action with the same words as the first.
 */
function MeterChip() {
  const { state } = useMeter();
  if (!state?.found) return null;

  const live = state.live_pass_id !== null;
  const wait = state.free_wait_minutes ?? 0;

  if (live) {
    return (
      <span className="badge-plain rounded-input px-12 py-4 text-[10px] font-bold uppercase tracking-[0.12em]">
        {state.live_kind === "weekly" ? "Weekly pass" : "Free search"} ·{" "}
        {state.live_remaining ?? 0} left
      </span>
    );
  }
  if (wait > 0) {
    return (
      <span className="badge-plain rounded-input px-12 py-4 text-[10px] font-bold uppercase tracking-[0.12em]">
        Next free search in {hm(wait)}
      </span>
    );
  }
  return (
    <Link href="/find"
      className="on-photo-btn rounded-input px-12 py-4 text-[10px] font-bold uppercase tracking-[0.12em]">
      Free search ready
    </Link>
  );
}

export default function FindLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [me, setMe] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    seekerFetch("/auth/me").then(async res => {
      if (res.ok && !cancelled) setMe(await res.json());
    }).catch(() => { });
    return () => { cancelled = true; };
  }, []);

  async function signOut() {
    sessionStorage.removeItem("waisha_access");
    await fetch(`${API}/api/v1/auth/logout`, { method: "POST", credentials: "include" })
      .catch(() => { });
    window.location.href = "/login?tab=seeker";
  }

  return (
    <MeterProvider>
      {/* The seeker shell borrows the shipper portal's photo, pane and type scale
          wholesale — the scrim over that sunset is already contrast-audited, and a
          seeker is looking at the same road the companies on it are driving. */}
      <div className="portal-shell flex-1">
        <div aria-hidden className="ws-bg" data-area="shipper">
          <div className="ws-bg-img" data-on="shipper" />
          <div className="ws-bg-scrim" />
        </div>
        <header className="portal-head">
          <div className="flex flex-wrap items-center justify-between gap-12 px-16 py-12">
            <div className="flex items-baseline gap-12">
              <span className="text-sm font-bold tracking-[0.08em] text-white">WAISHA</span>
              <span className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ color: "rgba(255,255,255,0.6)" }}>
                Find a transporter or a CFA
              </span>
            </div>
            <AnnouncementTicker />
            <div className="flex items-center gap-16">
              <MeterChip />
              {me?.full_name && (
                <span className="text-[11px] font-semibold" style={{ color: "rgba(255,255,255,0.75)" }}>
                  {me.full_name}
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
              const active = n.href === "/find" ? pathname === "/find" : pathname.startsWith(n.href);
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
    </MeterProvider>
  );
}
