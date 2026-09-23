"use client";
import { useEffect, useMemo, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
type Panel = "login" | "signup" | "otp" | "success";

function useGreeting() {
  const [greeting, setGreeting] = useState("");
  useEffect(() => {
    const h = parseInt(
      new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Africa/Dar_es_Salaam" })
        .format(new Date()), 10);
    if (h >= 5 && h < 12) setGreeting("Good morning");
    else if (h >= 12 && h < 17) setGreeting("Good afternoon");
    else if (h >= 17 && h < 21) setGreeting("Good evening");
    else setGreeting("Welcome");
  }, []);
  return greeting;
}

function useToday() {
  const [d, setD] = useState("");
  useEffect(() => {
    setD(new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase());
  }, []);
  return d;
}

function Chip({ text, color }: { text: string; color: string }) {
  return (
    <span className="px-8 py-4 text-[10px] font-bold uppercase tracking-[0.14em]"
      style={{ borderLeft: `4px solid ${color}`, background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}>
      {text}
    </span>
  );
}

function Kicker({ n, text }: { n: string; text: string }) {
  return (
    <p className="mb-8 flex items-baseline gap-8 text-[11px] font-semibold uppercase tracking-[0.18em]"
      style={{ color: "var(--ink-soft)" }}>
      <span style={{ color: "var(--brand)" }}>{n}</span>
      <span className="flex-1 border-b" style={{ borderColor: "var(--line)" }}>{text}</span>
    </p>
  );
}

function Corridor() {
  return (
    <div className="mx-auto w-full max-w-[320px]">
      <div className="flex items-center gap-12">
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-white">Dar es Salaam</span>
        <span className="relative h-px flex-1" style={{ background: "rgba(255,255,255,0.35)" }}>
          <span className="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full" style={{ background: "var(--gold)", left: 0 }} />
          <span className="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full" style={{ background: "var(--gold)", left: "50%" }} />
          <span className="absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full" style={{ background: "var(--gold)", right: 0 }} />
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-white">Kigali</span>
      </div>
      <p className="mt-4 text-center text-[10px] font-semibold uppercase tracking-[0.22em] tabular-nums"
        style={{ color: "rgba(255,255,255,0.7)" }}>
        1,500 KM · Central Corridor
      </p>
    </div>
  );
}

function Segmented({ items, index, onChange }: { items: string[]; index: number; onChange: (i: number) => void }) {
  return (
    <div role="tablist" className="relative flex border-b" style={{ borderColor: "var(--line)" }}>
      {items.map((label, i) => (
        <button key={label} type="button" role="tab" aria-selected={i === index}
          onClick={() => onChange(i)}
          className={`flex-1 pb-8 pt-4 text-xs font-semibold uppercase tracking-[0.08em] ${i === index ? "" : "opacity-50"}`}
          style={{ color: i === index ? "var(--brand-deep)" : "var(--ink-soft)" }}>
          {label}
        </button>
      ))}
      <span aria-hidden className="underline-slide absolute bottom-0 left-0 h-[2px]"
        style={{ width: `calc(100% / ${items.length})`, background: "var(--brand-deep)", transform: `translateX(${index * 100}%)` }} />
    </div>
  );
}

function Field({ label, error, ...props }: any) {
  return (
    <label className="block">
      <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</span>
      <input {...props} className="waisha-input w-full rounded-input border px-12 py-12 text-sm"
        style={{ borderColor: error ? "var(--danger)" : "var(--line)", background: "var(--milk)" }} />
      {error && <span className="mt-4 block text-xs" style={{ color: "var(--danger)" }}>{error}</span>}
    </label>
  );
}

function PasswordField({ label, error, show, onToggle, ...props }: any) {
  return (
    <label className="block">
      <span className="mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{label}</span>
      <div className="relative">
        <input {...props} type={show ? "text" : "password"}
          className="waisha-input w-full rounded-input border px-12 py-12 pr-64 text-sm"
          style={{ borderColor: error ? "var(--danger)" : "var(--line)", background: "var(--milk)" }} />
        <button type="button" onClick={onToggle}
          className="absolute right-12 top-1/2 -translate-y-1/2 text-[10px] font-bold tracking-[0.16em]"
          style={{ color: "var(--brand)" }}>
          {show ? "HIDE" : "SHOW"}
        </button>
      </div>
      {error && <span className="mt-4 block text-xs" style={{ color: "var(--danger)" }}>{error}</span>}
    </label>
  );
}

function OtpInput({ onComplete }: { onComplete: (code: string) => void }) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(""));
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  useEffect(() => { refs.current[0]?.focus(); }, []);
  const setAt = (i: number, v: string) => {
    const next = [...digits];
    next[i] = v;
    setDigits(next);
    if (v && i < 5) refs.current[i + 1]?.focus();
    if (next.every(d => d !== "")) onComplete(next.join(""));
  };
  return (
    <div className="flex justify-between gap-8" role="group" aria-label="Verification code">
      {digits.map((d, i) => (
        <input key={i} ref={el => { refs.current[i] = el; }} value={d}
          inputMode="numeric" maxLength={1} aria-label={`Digit ${i + 1}`}
          className="waisha-input h-56 w-full rounded-input border text-center text-xl"
          style={{ borderColor: "var(--line)", background: "var(--milk)" }}
          onChange={e => setAt(i, e.target.value.replace(/\D/g, "").slice(-1))}
          onKeyDown={e => { if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus(); }}
          onPaste={e => {
            e.preventDefault();
            const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6).split("");
            if (!pasted.length) return;
            const next = Array(6).fill("");
            pasted.forEach((c, j) => (next[j] = c));
            setDigits(next);
            if (next.every(x => x !== "")) onComplete(next.join(""));
            else refs.current[pasted.length]?.focus();
          }} />
      ))}
    </div>
  );
}

function ErrorChip({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div role="alert" aria-live="polite" className="mb-16 px-12 py-8 text-sm"
      style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
      {msg}
    </div>
  );
}

export default function LoginPage() {
  const greeting = useGreeting();
  const today = useToday();
  const [panel, setPanel] = useState<Panel>("login");
  const [loginTab, setLoginTab] = useState(0);
  const [signupTab, setSignupTab] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [pending, setPending] = useState<{ userId: string; phoneMasked: string; resendAt: string } | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [showReset, setShowReset] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  const loginTabs = useMemo(() => ["Transporter", "Shipper", "Customer tracking"], []);

  async function post(path: string, body: any) {
    const res = await fetch(`${API}/api/v1${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "include", body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  }

  function errorText(json: any, fallback: string): string {
    const d = json?.error?.details;
    const extra = Array.isArray(d) && d.length
      ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
      : "";
    return (json?.error?.message ?? fallback) + extra;
  }

  async function submitLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setBusy(true);
    const fd = new FormData(e.currentTarget);
    try {
      let body: any;
      if (loginTab === 0) body = { mode: "transporter", tin: fd.get("tin"), email: fd.get("email"), password: fd.get("password") };
      else if (loginTab === 1) body = { mode: "shipper", email: fd.get("identifier"), password: fd.get("password") };
      else body = { mode: "customer", companyName: fd.get("company"), tin: fd.get("tin"), username: fd.get("username"), password: fd.get("password") };
      const r = await post("/auth/login", body);
      if (r.status === 403 && r.json?.error?.code === "PENDING_VERIFICATION" && r.json?.error?.details?.[0]?.userId) {
        const userId = r.json.error.details[0].userId;
        const rr = await post("/auth/otp/resend", { userId }).catch(() => null);
        setPending({ userId, phoneMasked: "your phone", resendAt: rr?.json?.resendAt ?? new Date(Date.now() + 60000).toISOString() });
        setPanel("otp");
        return;
      }
      if (!r.ok) { setError(errorText(r.json, "Sign in failed")); return; }
      sessionStorage.setItem("waisha_access", r.json.accessToken);
      window.location.href = "/post-login";
    } finally { setBusy(false); }
  }

  async function submitSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setBusy(true);
    const fd = new FormData(e.currentTarget);
    try {
      const body = signupTab === 0 ? {
        companyName: fd.get("companyName"), tin: fd.get("tin"), phone: fd.get("phone"),
        email: fd.get("email"), password: fd.get("password"), confirmPassword: fd.get("confirm"),
        acceptTerms: fd.get("terms") === "on"
      } : {
        firstName: fd.get("firstName"), lastName: fd.get("lastName"), nida: fd.get("nida"), phone: fd.get("phone"),
        email: fd.get("email"), password: fd.get("password"), confirmPassword: fd.get("confirm"),
        acceptTerms: fd.get("terms") === "on"
      };
      const r = await post(signupTab === 0 ? "/auth/transporter/signup" : "/auth/shipper/signup", body);
      if (!r.ok) { setError(errorText(r.json, "Sign up failed")); return; }
      setPending({ userId: r.json.userId, phoneMasked: r.json.phoneMasked, resendAt: new Date().toISOString() });
      setPanel("otp");
    } finally { setBusy(false); }
  }

  async function verifyOtp(code: string) {
    setError(null);
    if (!pending) return;
    const r = await post("/auth/otp/verify", { userId: pending.userId, code });
    if (!r.ok) { setError(errorText(r.json, "Verification failed")); return; }
    setPanel("success");
    setTimeout(() => setPanel("login"), 3000);
  }

  async function resendCode() {
    if (!pending) return;
    const r = await post("/auth/otp/resend", { userId: pending.userId });
    if (r.ok && r.json?.resendAt) setPending({ ...pending, resendAt: r.json.resendAt });
    else if (!r.ok) setError(errorText(r.json, "Could not resend"));
  }

  useEffect(() => {
    if (panel !== "otp" || !pending) return;
    const tick = () => {
      const msLeft = Math.max(0, new Date(pending.resendAt).getTime() - Date.now());
      setCooldown(Math.ceil(msLeft / 1000));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [panel, pending]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-16 py-32" style={{ background: "var(--brand-deep)" }}>
      <div className="w-full max-w-[440px]">
        <div className="relative">
          <div aria-hidden className="absolute inset-0 rounded-card"
            style={{ transform: "translate(10px, 10px)", border: "1px solid rgba(255,255,255,0.22)" }} />

          <div className="sheet-in relative overflow-hidden rounded-card border bg-surface"
            style={{ borderColor: "var(--line)", boxShadow: "0 24px 64px rgba(5, 18, 26, 0.45)" }}>

            {/* Integrated header: brand on the same sheet, top — Picture 1 structure */}
            <header className="flex items-center justify-between px-16 py-10"
              style={{ background: "var(--brand-deep)", borderBottom: "1px solid var(--line)" }}>
              <div className="inline-flex items-center rounded-input bg-white px-12 py-6">
                <img src="/waisha-logo.png" alt="WAISHA — where shippers meet transporters"
                  style={{ height: 36, width: "auto", maxWidth: 180 }} />
              </div>
              <Chip text="Secure portal" color="var(--success)" />
            </header>

            <div className="p-24">
              <Kicker n="01" text="Sign in to WAISHA" />
              <h1 className="mb-4 text-2xl font-extrabold tracking-tight" style={{ color: "var(--ink)" }}>
                {greeting}.
              </h1>
              <p className="mb-16 text-[10px] font-bold uppercase tracking-[0.22em]" style={{ color: "var(--gold)" }}>
                Your logistics connected
              </p>
              <ErrorChip msg={error} />

              {panel === "login" && (
                <div key="login" className="panel-enter">
                  <Segmented items={loginTabs} index={loginTab} onChange={setLoginTab} />
                  <form onSubmit={submitLogin} className="mt-16 space-y-12">
                    {loginTab === 0 && (<>
                      <Field label="TIN" name="tin" required placeholder="123-456-789" />
                      <Field label="Email" name="email" type="email" required />
                    </>)}
                    {loginTab === 1 && (<Field label="Email or phone" name="identifier" required />)}
                    {loginTab === 2 && (<>
                      <Field label="Company name" name="company" required />
                      <Field label="TIN" name="tin" required placeholder="123-456-789" />
                      <Field label="Username" name="username" required />
                    </>)}
                    <PasswordField label="Password" name="password" required show={showPw} onToggle={() => setShowPw(v => !v)} />
                    <div className="flex justify-end">
                      <button type="button" className="text-xs underline" style={{ color: "var(--brand)" }}
                        onClick={() => { setShowReset(true); setResetDone(false); }}>
                        Forgot password?
                      </button>
                    </div>
                    <button type="submit" disabled={busy}
                      className="w-full rounded-input py-12 text-sm font-semibold transition-colors duration-200 disabled:opacity-60"
                      style={{ background: "var(--gold-green)", color: "var(--ink)" }}>
                      {busy ? "Signing in" : "Sign in"}
                    </button>
                  </form>
                </div>
              )}

              {panel === "signup" && (
                <div key="signup" className="panel-enter">
                  <Segmented items={["Transporter", "Shipper"]} index={signupTab} onChange={setSignupTab} />
                  <form onSubmit={submitSignup} className="mt-16 space-y-12">
                    {signupTab === 0 && (<>
                      <Field label="Registered company name" name="companyName" required minLength={3} maxLength={120} />
                      <Field label="TIN" name="tin" required placeholder="123-456-789" />
                    </>)}
                    {signupTab === 1 && (<>
                      <Field label="First name" name="firstName" required />
                      <Field label="Last name" name="lastName" required />
                      <Field label="NIDA number (20 digits)" name="nida" required inputMode="numeric" maxLength={20} />
                    </>)}
                    <Field label="Active phone (international format)" name="phone" required placeholder="+255712345678" />
                    <Field label="Email" name="email" type="email" required />
                    <PasswordField label="Password" name="password" required minLength={10} show={showPw} onToggle={() => setShowPw(v => !v)} />
                    <PasswordField label="Confirm password" name="confirm" required show={showPw} onToggle={() => setShowPw(v => !v)} />
                    <label className="flex items-start gap-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                      <input type="checkbox" name="terms" required className="mt-2" />
                      <span>I accept the Terms of Service and Privacy Policy</span>
                    </label>
                    <button type="submit" disabled={busy}
                      className="w-full rounded-input py-12 text-sm font-semibold transition-colors duration-200 disabled:opacity-60"
                      style={{ background: "var(--gold-green)", color: "var(--ink)" }}>
                      {busy ? "Creating account" : "Create account"}
                    </button>
                  </form>
                </div>
              )}

              {panel === "otp" && pending && (
                <div key="otp" className="panel-enter">
                  <h2 className="mb-8 text-2xl font-bold tracking-tight" style={{ color: "var(--ink)" }}>Six-digit code</h2>
                  <p className="mb-16 text-sm" style={{ color: "var(--ink-soft)" }}>
                    Sent by SMS to {pending.phoneMasked}. Expires in 5 minutes.
                  </p>
                  <OtpInput onComplete={verifyOtp} />
                  <div className="mt-16 flex items-center justify-between text-sm">
                    <button type="button" disabled={cooldown > 0} className="underline disabled:opacity-50"
                      style={{ color: "var(--brand)" }} onClick={resendCode}>
                      {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
                    </button>
                    <button type="button" className="underline" style={{ color: "var(--brand)" }}
                      onClick={() => { setError(null); setPanel("signup"); }}>Change phone number</button>
                  </div>
                </div>
              )}

              {panel === "success" && (
                <div key="success" className="panel-enter py-16 text-center">
                  <div className="mx-auto mb-16 h-[2px] w-48" style={{ background: "var(--success)" }} aria-hidden />
                  <h2 className="text-lg font-semibold" style={{ color: "var(--success)" }}>Account successfully created</h2>
                  <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                    Your account is ready. Redirecting you to the sign-in screen.
                  </p>
                  <button type="button" className="mt-16 text-sm underline" style={{ color: "var(--brand)" }}
                    onClick={() => setPanel("login")}>Go to login now</button>
                </div>
              )}
            </div>

            {panel === "login" && (
              <div className="border-t px-24 py-12 text-center text-sm" style={{ borderColor: "var(--line)" }}>
                <span style={{ color: "var(--ink-soft)" }}>New to WAISHA? </span>
                <button type="button" className="font-semibold underline" style={{ color: "var(--brand)" }}
                  onClick={() => { setError(null); setPanel("signup"); }}>Create an account</button>
              </div>
            )}
            {panel === "signup" && (
              <div className="border-t px-24 py-12 text-center text-sm" style={{ borderColor: "var(--line)" }}>
                <span style={{ color: "var(--ink-soft)" }}>Already registered? </span>
                <button type="button" className="font-semibold underline" style={{ color: "var(--brand)" }}
                  onClick={() => { setError(null); setPanel("login"); }}>Sign in</button>
              </div>
            )}
          </div>
        </div>

        {/* Signature motif, slimmed: two lines under the card instead of a block above */}
        <div className="mt-24">
          <Corridor />
          <p className="mt-12 text-center text-[10px] font-semibold uppercase tracking-[0.16em] tabular-nums"
            style={{ color: "rgba(255,255,255,0.6)" }}>
            01 Isolated by design · 02 Every action audited · 03 EN · SW · WSH · {today}
          </p>
        </div>
      </div>

      {showReset && (
        <div role="dialog" aria-modal="true" aria-label="Reset your password"
          className="fixed inset-0 z-50 flex items-center justify-center p-16"
          style={{ background: "rgba(5, 18, 26, 0.6)" }}
          onClick={e => { if (e.target === e.currentTarget) setShowReset(false); }}>
          <div className="w-full max-w-[380px] rounded-modal bg-surface p-24" style={{ border: "1px solid var(--line)" }}>
            <h2 className="mb-16 text-base font-semibold">Reset your password</h2>
            {resetDone ? (
              <p className="text-sm" style={{ color: "var(--ink-soft)" }}>If that email is registered, a reset link has been sent.</p>
            ) : (
              <form onSubmit={async e => {
                e.preventDefault();
                const email = new FormData(e.currentTarget).get("email");
                await fetch(`${API}/api/v1/auth/forgot-password`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ email })
                });
                setResetDone(true);
              }} className="space-y-12">
                <Field label="Email" name="email" type="email" required />
                <button type="submit" className="w-full rounded-input py-12 text-sm font-semibold"
                  style={{ background: "var(--gold-green)", color: "var(--ink)" }}>Send reset link</button>
              </form>
            )}
            <button type="button" className="mt-16 text-sm underline" style={{ color: "var(--brand)" }}
              onClick={() => setShowReset(false)}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
}