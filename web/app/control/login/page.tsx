"use client";
import { useState } from "react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
type Step = "password" | "enroll" | "code" | "recovery";

export default function ControlLoginPage() {
  const [step, setStep] = useState<Step>("password");
  const [challenge, setChallenge] = useState("");
  const [qr, setQr] = useState("");
  const [who, setWho] = useState("");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(path: string, body: any) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "include", body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }

  function errText(json: any, fallback: string) {
    return json?.error?.message ?? fallback;
  }

  async function submitPassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setBusy(true);
    const fd = new FormData(e.currentTarget);
    try {
      const r = await post("/control/auth/login", {
        email: String(fd.get("email") ?? ""), password: String(fd.get("password") ?? "")
      });
      if (!r.ok) { setError(errText(r.json, "Sign in failed")); return; }
      setChallenge(r.json.challengeToken);
      setWho(r.json.email ?? "Super Admin");
      if (r.json.totpEnabled) { setStep("code"); return; }
      const s = await post("/control/auth/totp/setup", { challengeToken: r.json.challengeToken });
      if (!s.ok) { setError(errText(s.json, "Could not start enrollment")); return; }
      setQr(s.json.qrDataUrl);
      setStep("enroll");
    } finally { setBusy(false); }
  }

  async function submitCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setBusy(true);
    try {
      const r = await post("/control/auth/totp/verify", { challengeToken: challenge, code: code.trim() });
      if (!r.ok) {
        // One attempt per challenge: a wrong code burns it. Restart cleanly.
        setError(errText(r.json, "Invalid code. Sign in again."));
        setChallenge(""); setCode(""); setQr("");
        setStep("password");
        return;
      }
      if (r.json.recoveryCodes?.length) { setCodes(r.json.recoveryCodes); setStep("recovery"); }
      else window.location.href = "/control";
    } finally { setBusy(false); }
  }

  async function copyCodes() {
    await navigator.clipboard.writeText(codes.join("\n"));
    setSaved(true);
  }

  const inputCls = "w-full rounded-input border px-12 py-12 text-sm";
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="control-shell page-shell relative flex flex-1 items-center justify-center px-16 py-32">
      <div aria-hidden className="absolute inset-0"
        style={{ backgroundImage: "url(/bg/office.jpg)", backgroundSize: "cover", backgroundPosition: "center" }} />
      <div aria-hidden className="absolute inset-0"
        style={{ background: "linear-gradient(180deg, rgba(5, 8, 12, 0.85) 0%, rgba(5, 8, 12, 0.72) 100%)" }} />

      <div className="relative w-full max-w-[440px]">
        <div className="control-card sheet-in relative overflow-hidden rounded-card">

          <header className="px-24 py-12" style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
            <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
            <p className="mt-4 text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
              Restricted access
            </p>
          </header>

          <div className="p-24">
            {error && (
              <div role="alert" aria-live="polite" className="mb-16 px-12 py-8 text-sm"
                style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
                {error}
              </div>
            )}

            {step === "password" && (
              <form onSubmit={submitPassword} className="space-y-12">
                <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Control sign in</h1>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Email</span>
                  <input name="email" type="email" required className={inputCls}
                    style={{ borderColor: "var(--line)", background: "var(--milk)" }} />
                </label>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Password</span>
                  <input name="password" type="password" required className={inputCls}
                    style={{ borderColor: "var(--line)", background: "var(--milk)" }} />
                </label>
                <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
                  {busy ? "Checking" : "Continue"}
                </button>
              </form>
            )}

            {step === "enroll" && (
              <div>
                <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Set up two-factor authentication</h1>
                <p className="mb-16 mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                  Welcome, {who}. Scan this code with your authenticator app (Google Authenticator,
                  Microsoft Authenticator, Authy, 1Password), then enter the six-digit code it shows.
                </p>
                {qr && (
                  <div className="flex justify-center p-16">
                    <img src={qr} alt="TOTP enrollment QR code" width={220} height={220}
                      style={{ border: "1px solid var(--line)", borderRadius: "10px" }} />
                  </div>
                )}
                <form onSubmit={submitCode} className="mt-8 space-y-12">
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Six-digit code</span>
                    <input value={code} onChange={e => setCode(e.target.value)} required
                      inputMode="numeric" maxLength={6} className={`${inputCls} text-center text-lg tracking-[0.3em]`}
                      style={{ borderColor: "var(--line)", background: "var(--milk)" }} />
                  </label>
                  <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
                    {busy ? "Verifying" : "Confirm and enable"}
                  </button>
                </form>
              </div>
            )}

            {step === "code" && (
              <form onSubmit={submitCode} className="space-y-12">
                <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Two-factor code</h1>
                <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
                  Enter the current code from your authenticator app — or a recovery code if your phone is unavailable.
                </p>
                <label className="block">
                  <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Code</span>
                  <input value={code} onChange={e => setCode(e.target.value)} required
                    className={`${inputCls} text-center text-lg tracking-[0.2em]`}
                    style={{ borderColor: "var(--line)", background: "var(--milk)" }} />
                </label>
                <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
                  {busy ? "Verifying" : "Verify"}
                </button>
              </form>
            )}

            {step === "recovery" && (
              <div>
                <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Save your recovery codes</h1>
                <p className="mb-16 mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                  These ten single-use codes are the only way in if you lose your phone.
                  They are shown <strong>once</strong> and stored only as hashes. Save them now.
                </p>
                <div className="grid grid-cols-2 gap-8 rounded-card border p-16"
                  style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
                  {codes.map((c) => (
                    <span key={c} className="font-mono text-sm tabular-nums" style={{ color: "var(--ink)" }}>{c}</span>
                  ))}
                </div>
                <div className="mt-16 space-y-12">
                  <button type="button" onClick={copyCodes}
                    className="w-full rounded-input border py-12 text-sm font-semibold"
                    style={{ borderColor: "var(--line)" }}>
                    {saved ? "Copied to clipboard" : "Copy all codes"}
                  </button>
                  <label className="flex items-start gap-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                    <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} className="mt-2" />
                    <span>I have stored these codes somewhere safe (password manager or printed and locked away)</span>
                  </label>
                  <button type="button" disabled={!saved} onClick={() => { window.location.href = "/control"; }}
                    className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
                    Continue to Control
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}