"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight, Check, CircleDashed, MapPinned, Navigation, Route, Truck
} from "lucide-react";
import { ProgressRing } from "@/components/ProgressRing";
import { apiFetch } from "../api-client";
import { AREAS, areaUnlocked } from "../areas";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

function useTrialCountdown(endsAt?: string | null) {
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (!endsAt) return;
    const tick = () => {
      const ms = Math.max(0, new Date(endsAt).getTime() - Date.now());
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setLabel(`${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [endsAt]);
  return label;
}

export default function DashboardPage() {
  const [me, setMe] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [fleet, setFleet] = useState<{ vessels: any[]; fleetLimit: number | null; fleetUsed: number } | null>(null);
  const [branches, setBranches] = useState<any[]>([]);
  const [routes, setRoutes] = useState<any[]>([]);
  const [trips, setTrips] = useState<any[]>([]);
  const [licence, setLicence] = useState<any>(null);
  const [ready, setReady] = useState(false);

  const trialLeft = useTrialCountdown(licence?.trial_ends_at);

  useEffect(() => {
    (async () => {
      try {
        const m = await apiFetch("/auth/me");
        if (!m.ok) { window.location.href = "/login"; return; }
        setMe(await m.json());
        const [p, v, b, r, t, l] = await Promise.all([
          apiFetch("/profile"), apiFetch("/vessels"), apiFetch("/branches"),
          apiFetch("/routes"), apiFetch("/trips"), apiFetch("/licence")
        ]);
        if (p.ok) setProfile(await p.json());
        if (v.ok) setFleet(await v.json());
        if (b.ok) setBranches(await b.json());
        if (r.ok) setRoutes(await r.json());
        if (t.ok) { const j = await t.json(); setTrips(j.trips ?? []); }
        if (l.ok) setLicence(await l.json());
      } catch (e: any) {
        if (e.message !== "session ended") { /* show nothing */ }
      } finally { setReady(true); }
    })();
  }, []);

  // Profile completion meter (the onboarding UX, ledger 16 - first slice)
  const profileFields = ["company_name", "brela_number", "transport_licence_no",
    "transport_licence_expiry", "services_offered", "corridors_served", "description"];
  const filled = profile ? profileFields.filter(k => profile[k]).length : 0;
  const completion = Math.round((filled / profileFields.length) * 100);

  const nextActions: { label: string; href: string; done: boolean; hint: string }[] = [
    { label: "Complete your company profile", href: "/app/profile",
      done: completion >= 70, hint: "Builds trust with shippers" },
    { label: "Add your HQ branch", href: "/app/branches",
      done: branches.length > 0, hint: "Where your fleet is based" },
    { label: "Register your vessels", href: "/app/fleet",
      done: (fleet?.vessels.length ?? 0) > 0, hint: "Trucks, trailers, ships" },
    { label: "Create your first route", href: "/app/routes",
      done: routes.length > 0, hint: "The corridors you run" },
    { label: "Plan your first trip", href: "/app/trips",
      done: trips.length > 0, hint: "Put fleet and drivers to work" }
  ];
  const remaining = nextActions.filter(a => !a.done);

  const licenceActive = licence?.tenant_status === "active";
  const trialRunning = licence?.tenant_status === "trial" && licence?.operational !== false;

  const firstName = (me?.full_name ?? "").trim().split(/\s+/)[0];
  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };

  const tiles = [
    { label: "Fleet", href: "/app/fleet", icon: Truck, value: fleet?.fleetUsed ?? 0,
      note: fleet?.fleetLimit !== null && fleet?.fleetLimit !== undefined ? `of ${fleet.fleetLimit} (trial)` : "vessels" },
    { label: "Branches", href: "/app/branches", icon: MapPinned, value: branches.length, note: "locations" },
    { label: "Routes", href: "/app/routes", icon: Route, value: routes.length, note: "corridors" },
    { label: "Trips", href: "/app/trips", icon: Navigation,
      value: trips.filter(t => t.status === "planned" || t.status === "in_transit").length,
      note: `active of ${trips.length}` }
  ];

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-2xl font-bold">
        Welcome, {firstName || "Director"}
      </h1>
      <p className="mt-8 text-sm">
        {me?.tenant_name ?? "Your transport operation"} — fleet, routes and trips in one place.
      </p>

      {trialRunning && (
        <div role="status" className="licence-banner mt-16 px-16 py-10 text-sm font-semibold"
          style={{ borderLeftColor: "var(--warning)", background: "rgba(168, 121, 28, 0.18)", color: "#fff",
                   textShadow: "0 1px 6px rgba(4,18,28,.4)" }}>
          Trial: {trialLeft} remaining
        </div>
      )}
      {licenceActive && (
        <div role="status" className="licence-banner mt-16 px-16 py-10 text-sm font-semibold"
          style={{ color: "#fff", textShadow: "0 1px 6px rgba(4,18,28,.4)" }}>
          Licence active{licence?.licence_expires_at ? ` — valid until ${new Date(licence.licence_expires_at).toLocaleDateString()}` : ""}
        </div>
      )}

      {/* Next actions — the guided journey */}
      <section className={`${card} mt-24`} style={cardStyle}>
        <div className="flex items-center gap-20">
          <span style={{ color: "var(--ink)" }}><ProgressRing value={completion} /></span>
          <div className="min-w-0">
            <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              {remaining.length > 0 ? "Next steps" : "Setup complete — you're running"}
            </h2>
            <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
              {remaining.length} of {nextActions.length} left. Profile completeness {completion}%.
            </p>
          </div>
        </div>

        <ul className="mt-20 space-y-10">
          {nextActions.map(a => (
            <li key={a.label}>
              <Link href={a.href}
                className="flex items-center justify-between gap-12 rounded-input border px-16 py-12 text-sm transition-colors"
                style={{ borderColor: a.done ? "var(--success)" : "var(--line)" }}>
                <span className="flex min-w-0 items-center gap-10">
                  {a.done
                    ? <Check aria-hidden size={18} strokeWidth={2.2} style={{ color: "var(--success)", flex: "0 0 auto" }} />
                    : <CircleDashed aria-hidden size={18} strokeWidth={1.8} style={{ color: "var(--ink-soft)", flex: "0 0 auto" }} />}
                  <span className="truncate">
                    <span className="font-semibold" style={{ color: a.done ? "var(--success)" : "var(--ink)" }}>
                      {a.label}
                    </span>
                    {!a.done && <span className="ml-8" style={{ color: "var(--ink-soft)" }}>— {a.hint}</span>}
                  </span>
                </span>
                <span className="flex flex-0 items-center gap-6 whitespace-nowrap font-semibold"
                  style={{ color: "var(--brand)" }}>
                  {a.done ? "View" : "Start"}
                  <ArrowRight aria-hidden size={15} strokeWidth={2} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* Summary counts */}
      <section className="mt-24 grid grid-cols-2 gap-16 lg:grid-cols-4">
        {tiles.map(t => (
          <Link key={t.label} href={t.href} className="stat-tile">
            <t.icon aria-hidden size={20} strokeWidth={1.8} style={{ color: "var(--gold)" }} />
            <p className="mt-12 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              {t.label}
            </p>
            <p className="mt-4 text-2xl font-bold tabular-nums" style={{ color: "var(--ink)" }}>{t.value}</p>
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>{t.note}</p>
          </Link>
        ))}
      </section>

      {/* Workspaces — the portal's areas */}
      <section className="mt-24 grid grid-cols-1 gap-16 md:grid-cols-3">
        {AREAS.map(a => {
          const unlocked = areaUnlocked(a, licence);
          return (
            <Link key={a.key} href={a.href} className={`${card} block`} style={cardStyle}>
              <div className="flex items-start justify-between gap-8">
                <p className="text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink)" }}>
                  {a.label}
                </p>
                <span className="rounded-full px-10 py-2 text-[9px] font-bold uppercase whitespace-nowrap"
                  style={{
                    background: unlocked ? "color-mix(in srgb, var(--success) 16%, transparent)" : "color-mix(in srgb, var(--gold) 20%, transparent)",
                    color: unlocked ? "var(--success)" : "var(--ink)"
                  }}>
                  {unlocked ? "Included" : a.planLabel}
                </span>
              </div>
              <p className="mt-8 text-xs leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                {a.description}
              </p>
              <p className="mt-12 text-[10px] font-bold uppercase tracking-[0.14em]"
                style={{ color: unlocked ? "var(--brand)" : "var(--gold)" }}>
                {unlocked && a.key !== "transporter" ? "Open workspace" : a.key === "transporter" ? "You are here" : "Preview"}
              </p>
            </Link>
          );
        })}
      </section>

      <p className="mt-24 text-xs" style={{ color: "var(--ink-soft)" }}>
      <Link href="/app/account" className="underline">Account settings</Link> · sessions, devices and sign out
      </p>
    </div>
  );
}
