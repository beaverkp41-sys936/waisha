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

function Segmented({ items, index, onChange }: { items: string[]; index: number; onChange: (i: number) => void }) {
  return (
    <div role="tablist" className="relative flex rounded-full p-4" style={{ background: "var(--milk)" }}>
      <span aria-hidden className="absolute bottom-4 top-4 rounded-full"
        style={{
          left: 4,
          width: `calc((100% - 8px) / ${items.length})`,
          transform: `translateX(${index * 100}%)`,
          background: "var(--surface)",
          boxShadow: "0 1px 4px rgba(15,42,56,0.18)",
          transition: "transform 200ms cubic-bezier(0.4,0,0.2,1)"
        }} />
      {items.map((label, i) => (
        <button key={label} type="button" role="tab" aria-selected={i === index}
          onClick={() => onChange(i)}
          className="relative z-10 flex-1 rounded-full py-8 text-xs font-semibold"
          style={{ color: i === index ? "var(--brand-deep)" : "var(--ink-soft)" }}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, error, ...props }: any) {
  return (
    <label className="block">
      <span className="mb-4 block text-xs font-medium" style={{ color: "var(--ink-soft)" }}>{label}</span>
      <input {...props}
        className="w-full rounded-full border px-16 py-12 text-sm"
        style={{
          borderColor: error ? "var(--danger)" : "var(--line)",
          background: "var(--milk)"
        }} />
      {error && <span className="mt-4 block text-xs" style={{ color: "var(--danger)" }}>{error}</span>}
    </label>
  );
}

function PasswordField({ label, error, show, onToggle, ...props }: any) {
  return (
    <label className="block">
      <span className="mb-4 block text-xs font-medium" style={{ color: "var(--ink-soft)" }}>{label}</span>
      <div className="relative my-auto">
        <input {...props} type={show ? "text" : "password"}
          className="w-full rounded-full border px-16 py-12 pr-64 text-sm"
          style={{
            borderColor: error ? "var(--danger)" : "var(--line)",
            background: "var(--milk)"
          }} />
        <button type="button" onClick={onToggle}
          className="absolute right-16 top-1/2 -translate-y-1/2 text-xs font-bold tracking-wider"
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
          className="h-48 w-full rounded-full border text-center text-lg"
          style={{ borderColor: "var(--line)", background: "var(--milk)" }}
          onChange={e => setAt(i, e.target.value.replace(/\D/g, "").slice(-1))}
          onKeyDown={e => {
            if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
          }}
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
    <div role="alert" aria-live="polite" className="mb-16 rounded-card px-16 py-8 text-sm"
      style={{
        background: "color-mix(in srgb, var(--danger) 8%, transparent)",
        borderLeft: "4px solid var(--danger)"
      }}>
      {msg}
    </div>
  );
}

export default function LoginPage() {
  const greeting = useGreeting();
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
    <div className="flex min-h-screen flex-col items-center justify-center px-16 py-32" style={{ background: "var(--milk)" }}>
      <div className="w-full max-w-[960px]">
        {/* Logo — mobile only; desktop shows it inside the brand panel */}
        <div className="mb-16 flex justify-center md:hidden">
          <div className="inline-flex items-center self-start rounded-card bg-white px-24 py-16">
              <img
                src="/waisha-logo.png"
                alt="WAISHA logo"
                style={{ height: 110, width: "auto", maxWidth: "100%" }}
              />
            </div>
        </div>

        <div className="grid overflow-hidden rounded-card border bg-surface shadow-sm md:grid-cols-2"
          style={{ borderColor: "var(--line)" }}>

          {/* Brand panel — the picture's left side, in spec navy */}
          <aside className="relative hidden flex-col justify-start overflow-hidden p-32 md:flex"
            style={{ background: "linear-gradient(160deg, var(--brand-deep) 15%, var(--brand) 100%)" }}>
            <div aria-hidden className="absolute inset-0">
              <div className="absolute rounded-full" style={{ width: 360, height: 360, right: -130, bottom: -120, background: "rgba(255,255,255,0.08)" }} />
              <div className="absolute rounded-full" style={{ width: 240, height: 240, left: -90, bottom: -70, background: "rgba(255,255,255,0.06)" }} />
              <div className="absolute rounded-full" style={{ width: 150, height: 150, right: 60, top: -60, background: "rgba(255,255,255,0.05)" }} />
            </div>
            <div className="relative">
              <div className="inline-flex items-center self-start rounded-card bg-white px-24 py-12">
                <img src="/waisha-logo.png" alt="WAISHA logo" style={{ height: 80 }} className="w-auto" />
              </div>
              <h2 className="mt-24 text-3xl font-extrabold tracking-wide text-white">{greeting.toUpperCase()}</h2>
              <p className="mt-4 text-sm font-bold uppercase tracking-[0.18em]" style={{ color: "#BFD4E2" }}>
                Your logistics connected
              </p>
              <p className="mt-16 max-w-[320px] text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.85)" }}>
                Sign in to access your WAISHA dashboard and connect with shippers or transporters across Tanzania and beyond.
              </p>
            </div>
          </aside>

          {/* Form side */}
          <section className="flex flex-col justify-center p-24 md:p-32">
            <p className="mb-8 text-sm font-semibold md:hidden" style={{ color: "var(--brand-deep)" }}>{greeting}</p>
            <ErrorChip msg={error} />

            {panel === "login" && (
              <div key="login" className="panel-enter">
                <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>Sign in</h1>
                <p className="mb-16 mt-4 text-sm" style={{ color: "var(--ink-soft)" }}>Sign in to WAISHA</p>

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
                  <PasswordField label="Password" name="password" required show={showPw}
                    onToggle={() => setShowPw(v => !v)} />
                  <div className="flex justify-end">
                    <button type="button" className="text-xs underline" style={{ color: "var(--brand)" }}
                      onClick={() => { setShowReset(true); setResetDone(false); }}>
                      Forgot password?
                    </button>
                  </div>
                  <button type="submit" disabled={busy}
                    className="w-full rounded-full py-12 text-sm font-semibold text-white disabled:opacity-60"
                    style={{ background: "var(--gold-green)" }}>
                    {busy ? "Signing in" : "Sign in"}
                  </button>
                </form>
              </div>
            )}

            {panel === "signup" && (
              <div key="signup" className="panel-enter">
                <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>Create account</h1>
                <p className="mb-16 mt-4 text-sm" style={{ color: "var(--ink-soft)" }}>Join WAISHA</p>

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
                  <PasswordField label="Password" name="password" required minLength={10} show={showPw}
                    onToggle={() => setShowPw(v => !v)} />
                  <PasswordField label="Confirm password" name="confirm" required show={showPw}
                    onToggle={() => setShowPw(v => !v)} />
                  <label className="flex items-start gap-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                    <input type="checkbox" name="terms" required className="mt-2" />
                    <span>I accept the Terms of Service and Privacy Policy</span>
                  </label>
                  <button type="submit" disabled={busy}
                    className="w-full rounded-full py-12 text-sm font-semibold text-white disabled:opacity-60"
                    style={{ background: "var(--gold-green)" }}>
                    {busy ? "Creating account" : "Create account"}
                  </button>
                </form>
                <button type="button" className="mt-16 text-sm underline" style={{ color: "var(--brand)" }}
                  onClick={() => { setError(null); setPanel("login"); }}>Back to sign in</button>
              </div>
            )}

            {panel === "otp" && pending && (
              <div key="otp" className="panel-enter">
                <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>Verify your phone</h1>
                <p className="mb-16 mt-4 text-sm" style={{ color: "var(--ink-soft)" }}>
                  A 6-digit code was sent by SMS to {pending.phoneMasked}. It expires in 5 minutes.
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
              <div key="success" className="panel-enter py-24 text-center">
                <div className="mx-auto mb-16 h-[2px] w-48" style={{ background: "var(--success)" }} aria-hidden />
                <h2 className="text-lg font-semibold" style={{ color: "var(--success)" }}>Account successfully created</h2>
                <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                  Your account is ready. Redirecting you to the sign-in screen.
                </p>
                <button type="button" className="mt-16 text-sm underline" style={{ color: "var(--brand)" }}
                  onClick={() => setPanel("login")}>Go to login now</button>
              </div>
            )}
          </section>
        </div>

        {panel === "login" && (
          <p className="mt-16 text-center text-sm" style={{ color: "var(--ink-soft)" }}>
            Don&apos;t have an account?{" "}
            <button type="button" className="font-semibold underline" style={{ color: "var(--brand)" }}
              onClick={() => { setError(null); setPanel("signup"); }}>
              Sign Up
            </button>
          </p>
        )}
      </div>

      {showReset && (
        <div role="dialog" aria-modal="true" aria-label="Reset your password"
          className="fixed inset-0 z-50 flex items-center justify-center p-16"
          style={{ background: "rgba(15,42,56,0.5)" }}
          onClick={e => { if (e.target === e.currentTarget) setShowReset(false); }}>
          <div className="w-full max-w-[380px] rounded-modal bg-surface p-24" style={{ border: "1px solid var(--line)" }}>
            <h2 className="mb-16 text-base font-semibold">Reset your password</h2>
            {resetDone ? (
              <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
                If that email is registered, a reset link has been sent.
              </p>
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
                <button type="submit" className="w-full rounded-full py-12 text-sm font-semibold text-white"
                  style={{ background: "var(--gold-green)" }}>Send reset link</button>
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