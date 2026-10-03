"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../api-client";

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
  const [licence, setLicence] = useState<any>(null);
  const [ready, setReady] = useState(false);

  const trialLeft = useTrialCountdown(licence?.trial_ends_at);

  useEffect(() => {
    (async () => {
      try {
        const m = await apiFetch("/auth/me");
        if (!m.ok) { window.location.href = "/login"; return; }
        setMe(await m.json());
        const [p, v, b, r, l] = await Promise.all([
          apiFetch("/profile"), apiFetch("/vessels"), apiFetch("/branches"),
          apiFetch("/routes"), apiFetch("/licence")
        ]);
        if (p.ok) setProfile(await p.json());
        if (v.ok) setFleet(await v.json());
        if (b.ok) setBranches(await b.json());
        if (r.ok) setRoutes(await r.json());
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
      done: routes.length > 0, hint: "The corridors you run" }
  ];
  const remaining = nextActions.filter(a => !a.done);

  const licenceActive = licence?.tenant_status === "active";
  const trialRunning = licence?.tenant_status === "trial" && licence?.operational !== false;

  const card = "rounded-card border bg-surface p-24";
  const cardStyle = { borderColor: "var(--line)" };
  const count = "text-2xl font-bold tabular-nums";

  return (
    <div className="mx-auto max-w-[900px] px-16 py-32">
      <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>
        Welcome, {me?.name ?? "Director"}
      </h1>

      {trialRunning && (
        <div role="status" className="mt-16 px-16 py-8 text-sm font-semibold"
          style={{ background: "var(--warning)", color: "#fff" }}>
          Trial: {trialLeft} remaining
        </div>
      )}
      {licenceActive && (
        <div role="status" className="mt-16 px-16 py-8 text-sm font-semibold"
          style={{ background: "var(--gold)", color: "var(--ink)" }}>
          Licence active{licence?.licence_expires_at ? ` — valid until ${new Date(licence.licence_expires_at).toLocaleDateString()}` : ""}
        </div>
      )}

      {/* Next actions — the guided journey */}
      <section className={`${card} mt-24`} style={cardStyle}>
        <h2 className="mb-16 text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
          {remaining.length > 0 ? "Next steps" : "Setup complete — you're running"}
        </h2>
        <div className="space-y-12">
          {nextActions.map(a => (
            <Link key={a.label} href={a.href}
              className="flex items-center justify-between rounded-input border px-16 py-12 text-sm transition-colors"
              style={{ borderColor: a.done ? "var(--success)" : "var(--line)" }}>
              <span>
                <span className="font-semibold" style={{ color: a.done ? "var(--success)" : "var(--ink)" }}>
                  {a.done ? "✓ " : ""}{a.label}
                </span>
                {!a.done && <span className="ml-8" style={{ color: "var(--ink-soft)" }}>— {a.hint}</span>}
              </span>
              <span style={{ color: "var(--brand)" }}>{a.done ? "View" : "Go →"}</span>
            </Link>
          ))}
        </div>
        {/* Profile completion meter */}
        <div className="mt-16 border-t pt-16" style={{ borderColor: "var(--line)" }}>
          <div className="mb-8 flex justify-between text-xs" style={{ color: "var(--ink-soft)" }}>
            <span>Profile completeness</span><span className="tabular-nums">{completion}%</span>
          </div>
          <div className="h-8 w-full rounded-full" style={{ background: "var(--milk-deep)" }}>
            <div className="h-8 rounded-full" style={{ width: `${completion}%`, background: "var(--gold-green)" }} />
          </div>
        </div>
      </section>

      {/* Summary counts */}
      <section className="mt-24 grid grid-cols-3 gap-16">
        <Link href="/app/fleet" className={`${card} block`} style={cardStyle}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Fleet</p>
          <p className={`${count} mt-8`} style={{ color: "var(--ink)" }}>{fleet?.fleetUsed ?? 0}</p>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            {fleet?.fleetLimit !== null && fleet?.fleetLimit !== undefined
              ? `of ${fleet.fleetLimit} (trial)` : "vessels"}
          </p>
        </Link>
        <Link href="/app/branches" className={`${card} block`} style={cardStyle}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Branches</p>
          <p className={`${count} mt-8`} style={{ color: "var(--ink)" }}>{branches.length}</p>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>locations</p>
        </Link>
        <Link href="/app/routes" className={`${card} block`} style={cardStyle}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Routes</p>
          <p className={`${count} mt-8`} style={{ color: "var(--ink)" }}>{routes.length}</p>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>corridors</p>
        </Link>
      </section>

      <p className="mt-24 text-xs" style={{ color: "var(--ink-soft)" }}>
        <Link href="/post-login" className="underline">Account settings</Link> · sessions, devices and sign out
      </p>
    </div>
  );
}