"use client";
import { useCallback, useEffect, useState } from "react";
import { useLicence, TrialBanner, LicenceGate } from "./gate";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

function ErrorChip({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div role="alert" className="mb-16 rounded-input px-12 py-8 text-sm"
      style={{
        background: "color-mix(in srgb, var(--danger) 8%, transparent)",
        borderLeft: "4px solid var(--danger)"
      }}>
      {msg}
    </div>
  );
}

export default function PostLogin() {
  const [me, setMe] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState({ fullName: "", phone: "", jobTitle: "" });
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState<string | null>(null);
  const { licence, loading, reload } = useLicence();
  const [gateOpen, setGateOpen] = useState(false);

  const api = useCallback(async (path: string, init?: RequestInit): Promise<Response> => {
    const token = sessionStorage.getItem("waisha_access");
    const doFetch = (t: string | null) =>
      fetch(`${API}/api/v1${path}`, {
        ...init, credentials: "include",
        headers: { ...(init?.headers ?? {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) }
      });
    let res = await doFetch(token);
    if (res.status === 401) {
      const r = await fetch(`${API}/api/v1/auth/refresh`, { method: "POST", credentials: "include" });
      if (r.ok) {
        const j = await r.json();
        sessionStorage.setItem("waisha_access", j.accessToken);
        res = await doFetch(j.accessToken);
      } else {
        window.location.href = "/login";
        throw new Error("session ended");
      }
    }
    return res;
  }, []);

  const load = useCallback(async () => {
    try {
      const m = await api("/auth/me");
      if (m.ok) setMe(await m.json());
      const s = await api("/auth/sessions");
      if (s.ok) setSessions(await s.json());
    } catch (e: any) {
      if (e.message !== "session ended") setError(e.message);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // Prefill the self-service profile once identity is known.
  useEffect(() => {
    if (me) setProfile(p => ({ ...p, fullName: me.full_name ?? "" }));
  }, [me]);

  async function saveProfile(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setProfileBusy(true); setError(null); setProfileNotice(null);
    try {
      const r = await api("/users/me/profile", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: profile.fullName,
          // blank phone keeps the stored (encrypted) value
          phone: profile.phone || undefined,
          jobTitle: profile.jobTitle || null
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j?.error?.message ?? "Could not save profile"); return; }
      setProfileNotice("Profile saved.");
      setProfile(p => ({ ...p, phone: "" }));
      load();
    } finally { setProfileBusy(false); }
  }

  async function revoke(id: string) {
    await api(`/auth/sessions/${id}`, { method: "DELETE" });
    load();
  }

  async function signOut() {
    await fetch(`${API}/api/v1/auth/logout`, { method: "POST", credentials: "include" });
    sessionStorage.removeItem("waisha_access");
    window.location.href = "/login";
  }

  async function startTrial() {
    setError(null);
    try {
      const r = await api("/licence/trial", { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { setGateOpen(false); reload(); }
      else setError(j?.error?.message ?? "Could not start trial");
    } catch (e: any) {
      if (e.message !== "session ended") setError(e.message);
    }
  }

  return (
    <div className="mx-auto max-w-[720px] px-16 py-48">
      <h1 className="mb-24 text-xl font-bold" style={{ color: "var(--brand-deep)" }}>Account</h1>

      {licence && (
        <TrialBanner licence={licence} onActivate={() => setGateOpen(true)} />
      )}

      <ErrorChip msg={error} />

      {me && (
        <section className="mb-32 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
          <p className="text-sm font-semibold">{me.full_name ?? me.email}</p>
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
            {me.tenant_name} · {me.tenant_type} · {me.tenant_status}
          </p>
          {licence?.plan && (
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Plan: <strong>{licence.plan}</strong> · Status: {licence.subscription_status ?? licence.tenant_status}
            </p>
          )}
        </section>
      )}

      {me && (
        <section className="mb-32 rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
          <h2 className="mb-16 text-sm font-semibold">Your profile</h2>
          {profileNotice && (
            <div role="status" className="mb-16 rounded-input px-12 py-8 text-sm"
              style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>
              {profileNotice}
            </div>
          )}
          <form onSubmit={saveProfile} className="space-y-12">
            <div className="grid grid-cols-2 gap-12">
              <label className="block">
                <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>Full name</span>
                <input value={profile.fullName} required
                  onChange={e => setProfile(p => ({ ...p, fullName: e.target.value }))}
                  className="w-full rounded-input border px-12 py-8 text-sm"
                  style={{ borderColor: "var(--line)", background: "var(--milk)" }} />
              </label>
              <label className="block">
                <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                  Phone — blank keeps current
                </span>
                <input value={profile.phone} placeholder="+255712345678"
                  onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))}
                  className="w-full rounded-input border px-12 py-8 text-sm"
                  style={{ borderColor: "var(--line)", background: "var(--milk)" }} />
              </label>
              <label className="block col-span-2">
                <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                  Job title / rank
                </span>
                <input value={profile.jobTitle} placeholder="e.g. Dispatcher"
                  onChange={e => setProfile(p => ({ ...p, jobTitle: e.target.value }))}
                  className="w-full rounded-input border px-12 py-8 text-sm"
                  style={{ borderColor: "var(--line)", background: "var(--milk)" }} />
              </label>
            </div>
            <button type="submit" disabled={profileBusy}
              className="waisha-btn rounded-input px-24 py-8 text-xs font-semibold disabled:opacity-60">
              {profileBusy ? "Saving…" : "Save profile"}
            </button>
          </form>
        </section>
      )}

      <section className="rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>
        <h2 className="mb-16 text-sm font-semibold">Active sessions</h2>
        {sessions.length === 0 && (
          <p className="text-sm" style={{ color: "var(--ink-soft)" }}>No active sessions.</p>
        )}
        {sessions.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="py-8">Device</th>
                <th className="py-8">Signed in</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s, i) => (
                <tr key={s.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                  <td className="py-8">
                    {(s.user_agent ?? "Unknown device").slice(0, 40)}
                    {s.current && <strong> · this device</strong>}
                  </td>
                  <td>{new Date(s.created_at).toLocaleString()}</td>
                  <td className="text-right">
                    {!s.current && (
                      <button type="button" className="underline" style={{ color: "var(--danger)" }}
                        onClick={() => revoke(s.id)}>Revoke</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <button type="button"
        className="on-photo-btn mt-24 px-24 py-8 text-sm font-semibold"
        onClick={signOut}>
        Sign out
      </button>

      {licence && licence.tenant_status === "pending_verification" && (
        <LicenceGate
          licence={licence}
          onPay={() => { window.location.href = "/pay"; }}
          onTrial={startTrial}
        />
      )}
    </div>
  );
}