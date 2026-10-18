"use client";
import { useEffect, useMemo, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
type Panel = "login" | "signup" | "otp" | "success";
/** Which door a code went out of. A seeker is verified by email because the SMS
 *  transport is still a dev stub, so the same six boxes have to tell two truths. */
type Channel = "sms" | "email";
type ServiceGroup = {
  key: string; name: string; description: string | null; services: string[];
  seat_limit: number; price_monthly: string; price_quarterly: string;
  price_annual: string; currency: string;
};

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
    <div role="tablist" className="auth-tab relative flex border-b">
      {items.map((label, i) => (
        <button key={label} type="button" role="tab" aria-selected={i === index}
          onClick={() => onChange(i)}
          className={`auth-tab flex-1 pb-8 pt-4 text-xs font-semibold uppercase tracking-[0.08em] ${i === index ? "font-bold" : "opacity-90"}`}>
          {label}
        </button>
      ))}
      <span aria-hidden className="auth-tab-ink underline-slide absolute bottom-0 left-0 h-[2px]"
        style={{ width: `calc(100% / ${items.length})`, transform: `translateX(${index * 100}%)` }} />
    </div>
  );
}

function Field({ label, error, ...props }: any) {
  return (
    <label className="block">
      <span className="auth-label mb-4 block font-semibold">{label}</span>
      <input {...props} className="auth-field waisha-input w-full rounded-input px-12 py-12 text-sm"
        style={error ? { borderColor: "#e07d7d" } : undefined} />
      {error && <span className="mt-4 block text-xs" style={{ color: "#ffb3b3" }}>{error}</span>}
    </label>
  );
}

/** 3,000 TZS reads as "TSh 3,000" here; the API sends numeric(12,2) as a string. */
function money(v: string | number) {
  const n = Number(v);
  return `TSh ${n.toLocaleString("en-TZ", { maximumFractionDigits: 0 })}`;
}

/**
 * The three bundles the platform sells, read from GET /content/service-groups so the
 * labels and prices on this form are the ones the control panel set tonight. A radio
 * rather than a dropdown: this choice decides which workspaces the company pays for,
 * so it should be read, not picked from a closed list.
 */
function GroupChoice({ groups, value, onChange, loaded }:
  { groups: ServiceGroup[]; value: string | null; onChange: (key: string) => void; loaded: boolean }) {
  if (!loaded) return null;
  if (!groups.length) {
    return (
      <p className="pane-note text-xs" style={{ color: "rgba(255,255,255,0.72)" }}>
        Packages are being updated — your account will be created either way, and the
        office will confirm which one you need.
      </p>
    );
  }
  return (
    <fieldset className="space-y-8">
      <legend className="auth-label mb-4 font-semibold">What does your company need?</legend>
      {groups.map(g => {
        const on = value === g.key;
        return (
          <label key={g.key}
            className="flex cursor-pointer items-start gap-10 rounded-input border px-12 py-10 transition-colors"
            style={{
              borderColor: on ? "var(--gold)" : "rgba(255,255,255,0.26)",
              background: on ? "rgba(201,169,81,0.16)" : "rgba(255,255,255,0.06)"
            }}>
            <input type="radio" name="serviceGroup" value={g.key} checked={on}
              onChange={() => onChange(g.key)} required className="auth-check mt-2" />
            <span className="min-w-0">
              <span className="flex flex-wrap items-baseline justify-between gap-8">
                <span className="text-sm font-semibold text-white">{g.name}</span>
                <span className="text-[11px] font-bold tabular-nums" style={{ color: "var(--gold-on-photo)" }}>
                  {money(g.price_monthly)} / month
                </span>
              </span>
              {g.description && (
                <span className="mt-2 block text-[11px] leading-snug" style={{ color: "rgba(255,255,255,0.78)" }}>
                  {g.description}
                </span>
              )}
              <span className="mt-2 block text-[10px] font-bold uppercase tracking-[0.14em]"
                style={{ color: "rgba(255,255,255,0.66)" }}>
                {g.services.join(" · ")} · up to {g.seat_limit} seats
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

function PasswordField({ label, error, show, onToggle, ...props }: any) {
  return (
    <label className="block">
      <span className="auth-label mb-4 block font-semibold">{label}</span>
      <div className="relative">
        <input {...props} type={show ? "text" : "password"}
          className="auth-field waisha-input w-full rounded-input px-12 py-12 pr-64 text-sm"
          style={error ? { borderColor: "#e07d7d" } : undefined} />
        <button type="button" onClick={onToggle}
          className="auth-link absolute right-12 top-1/2 -translate-y-1/2 text-[10px] font-bold tracking-[0.16em]">
          {show ? "HIDE" : "SHOW"}
        </button>
      </div>
      {error && <span className="mt-4 block text-xs" style={{ color: "#ffb3b3" }}>{error}</span>}
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
        <div className="flex items-center justify-between gap-8" role="group" aria-label="Verification code">
      {digits.map((d, i) => (
        <input key={i} ref={el => { refs.current[i] = el; }} value={d}
          inputMode="numeric" maxLength={1} aria-label={`Digit ${i + 1}`}
                    className="auth-field waisha-input h-48 w-48 rounded-input text-center text-lg"
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
    <div role="alert" aria-live="polite" className="auth-error mb-16 px-12 py-8 text-sm">
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
  const [pending, setPending] = useState<{
    userId: string; tab: number; channel: Channel; resendAt: string;
    /** Which panel the code was asked for. "Change details" must not push a user who
     *  was only ever signing in into the sign-up form. */
    from: "login" | "signup";
  } | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [showReset, setShowReset] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [groups, setGroups] = useState<ServiceGroup[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [group, setGroup] = useState<string | null>(null);

  // One tab per kind of account that exists. A transport company and a clearing &
  // forwarding company share a tab because they share a login branch (TIN + email) —
  // two tabs that ran the same query would be decoration. A shipper has no sign-up tab
  // at all because a shipper is opened by the transporter handling their cargo; they
  // only ever sign in.
  const loginTabs = useMemo(() => ["Company", "Shipper", "Seeker", "Customer"], []);
  const loginNotes = [
    "Transport and clearing & forwarding companies — sign in with your TIN and email.",
    "Your account was opened by the transporter handling your cargo. Sign in with the email they used.",
    "Looking for a transporter or a CFA to hire? Your search account signs in here.",
    "Track a shipment with the access your company gave you."
  ];
  const loginTargets = ["/app/dashboard", "/portal", "/find", "/app/dashboard"];

  useEffect(() => {
    if (panel !== "signup" || signupTab !== 0 || groupsLoaded) return;
    let cancelled = false;
    fetch(`${API}/api/v1/content/service-groups`)
      .then(res => (res.ok ? res.json() : []))
      .then(rows => {
        if (cancelled) return;
        setGroups(Array.isArray(rows) ? rows : []);
        setGroupsLoaded(true);
      })
      .catch(() => { if (!cancelled) setGroupsLoaded(true); });
    return () => { cancelled = true; };
  }, [panel, signupTab, groupsLoaded]);

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
      else if (loginTab === 2) body = { mode: "seeker", email: fd.get("identifier"), password: fd.get("password") };
      else body = { mode: "customer", companyName: fd.get("company"), tin: fd.get("tin"), username: fd.get("username"), password: fd.get("password") };
      const r = await post("/auth/login", body);
      if (r.status === 403 && r.json?.error?.code === "PENDING_VERIFICATION" && r.json?.error?.details?.[0]?.userId) {
        const userId = r.json.error.details[0].userId;
        const rr = await post("/auth/otp/resend", { userId }).catch(() => null);
        setPending({
          userId, tab: loginTab, from: "login",
          channel: loginTab === 2 ? "email" : "sms",
          resendAt: rr?.json?.resendAt ?? new Date(Date.now() + 60000).toISOString()
        });
        setPanel("otp");
        return;
      }
      if (!r.ok) { setError(errorText(r.json, "Sign in failed")); return; }
      sessionStorage.setItem("waisha_access", r.json.accessToken);
      window.location.href = loginTargets[loginTab];
    } finally { setBusy(false); }
  }

  async function submitSignup(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setBusy(true);
    const fd = new FormData(e.currentTarget);
    const seeker = signupTab === 1;
    try {
      const body = seeker ? {
        firstName: fd.get("firstName"), lastName: fd.get("lastName"),
        phone: fd.get("phone"), email: fd.get("email"),
        password: fd.get("password"), confirmPassword: fd.get("confirm"),
        lookingFor: fd.getAll("lookingFor") as string[],
        industry: fd.get("industry") || undefined,
        acceptTerms: fd.get("terms") === "on"
      } : {
        companyName: fd.get("companyName"), tin: fd.get("tin"), phone: fd.get("phone"),
        email: fd.get("email"), password: fd.get("password"), confirmPassword: fd.get("confirm"),
        serviceGroup: group,
        acceptTerms: fd.get("terms") === "on"
      };
      const r = await post(seeker ? "/auth/seeker/signup" : "/auth/transporter/signup", body);
      if (!r.ok) { setError(errorText(r.json, "Sign up failed")); return; }
      // otp/verify only stamps the account — it mints no token — so the verified
      // account is handed back to the sign-in tab that matches what it just created.
      // Sending a seeker straight to /find would bounce off the no-session redirect.
      setPending({
        userId: r.json.userId,
        tab: seeker ? 2 : 0, from: "signup",
        channel: seeker ? "email" : "sms",
        resendAt: new Date().toISOString()
      });
      setPanel("otp");
    } finally { setBusy(false); }
  }

  async function verifyOtp(code: string) {
    setError(null);
    if (!pending) return;
    const r = await post("/auth/otp/verify", { userId: pending.userId, code });
    if (!r.ok) { setError(errorText(r.json, "Verification failed")); return; }
    setLoginTab(pending.tab);
    setPanel("success");
  }

  async function resendCode() {
    if (!pending) return;
    const r = await post("/auth/otp/resend", { userId: pending.userId });
    if (r.ok && r.json?.resendAt) setPending({ ...pending, resendAt: r.json.resendAt });
    else if (!r.ok) setError(errorText(r.json, "Could not resend"));
  }

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const tab = q.get("tab");
    if (tab === "shipper") setLoginTab(1);
    if (tab === "seeker" || tab === "cfa") setLoginTab(tab === "seeker" ? 2 : 0);
    if (q.get("panel") === "signup") {
      setPanel("signup");
      if (tab === "seeker") setSignupTab(1);
    }
  }, []);

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

  useEffect(() => {
    if (panel !== "success") return;
    const t = setTimeout(() => setPanel("login"), 5000);
    return () => clearTimeout(t);
  }, [panel]);

  // The sign-up panel is much taller than the login one (three bundle cards, or a
  // seeker's name pair plus the looking-for checkboxes). Centring a card that is
  // taller than the viewport hides its top behind the fold with no way to scroll to
  // it, so while that panel is open the sheet is pinned to the top instead.
  const tall = panel === "signup";

  return (
    <div className={`flex flex-1 justify-center px-16 py-16 ${tall ? "items-start" : "items-center"}`}>
      <div aria-hidden className="auth-bg" />
      <div className="auth-shell w-full max-w-[560px]">
        <div className="auth-card auth-sheet sheet-in relative flex flex-col overflow-hidden rounded-card border p-32">
          {/* The lockup is the sheet's masthead, not a label above the form: it spans
              the card edge to edge and is the first thing read on every screen size. */}
          <div className="auth-head">
            <img src="/brand/waisha-white@2x.png" alt="WAISHA — where shippers meet transporters"
              width={452} height={211} className="auth-mark" />
            <span className="brand-tagline">Where shippers meet transporters</span>
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={{ color: "rgba(255,255,255,0.82)" }}>
            Sign in to WAISHA
          </p>
          <h1 className="mb-4 text-[28px] font-extrabold tracking-tight" style={{ color: "#ffffff" }}>
            {greeting}.
          </h1>
          <p className="mb-16 text-[10px] font-bold uppercase tracking-[0.22em]" style={{ color: "var(--gold-on-photo)" }}>
            Your logistics connected
          </p>
          <ErrorChip msg={error} />

          <div className="flex flex-1 flex-col justify-center">
            {panel === "login" && (
              <div key="login" className="panel-enter">
                <Segmented items={loginTabs} index={loginTab} onChange={setLoginTab} />
                <p className="mt-10 text-[11px] leading-snug" style={{ color: "rgba(255,255,255,0.78)" }}>
                  {loginNotes[loginTab]}
                </p>
                <form onSubmit={submitLogin} className="mt-12 space-y-12">
                  {loginTab === 0 && (<>
                    <Field label="TIN" name="tin" required placeholder="123-456-789" />
                    <Field label="Email" name="email" type="email" required />
                  </>)}
                  {(loginTab === 1 || loginTab === 2) && (
                    <Field label="Email or phone" name="identifier" required />
                  )}
                  {loginTab === 3 && (<>
                    <Field label="Company name" name="company" required />
                    <Field label="TIN" name="tin" required placeholder="123-456-789" />
                    <Field label="Username" name="username" required />
                  </>)}
                  <PasswordField label="Password" name="password" required show={showPw} onToggle={() => setShowPw(v => !v)} />
                  <div className="flex justify-end">
                    <button type="button" className="auth-link text-xs underline"
                      onClick={() => { setShowReset(true); setResetDone(false); }}>
                      Forgot password?
                    </button>
                  </div>
                  <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
                    {busy ? "Signing in" : "Sign in"}
                  </button>
                </form>
                {loginTab === 1 && (
                  <p className="mt-12 text-[11px]" style={{ color: "rgba(255,255,255,0.7)" }}>
                    No account yet? A transporter handling your cargo opens one for you —
                    ask them for access, then sign in here.
                  </p>
                )}
              </div>
            )}

            {panel === "signup" && (
              <div key="signup" className="panel-enter">
                <Segmented items={["Transport / CFA company", "Find a company"]}
                  index={signupTab} onChange={setSignupTab} />
                <p className="mt-10 text-[11px] leading-snug" style={{ color: "rgba(255,255,255,0.78)" }}>
                  {signupTab === 0
                    ? "Hauliers, clearing and forwarding agents and freight offices register here with their TIN."
                    : "Two names, a phone and an email. You get one free search of the directory every 24 hours."}
                </p>
                <form onSubmit={submitSignup} className="mt-12 space-y-12">
                  {signupTab === 0 && (<>
                    <Field label="Registered company name" name="companyName" required minLength={3} maxLength={120} />
                    <Field label="TIN" name="tin" required placeholder="123-456-789" />
                    <GroupChoice groups={groups} value={group} onChange={setGroup} loaded={groupsLoaded} />
                  </>)}
                  {signupTab === 1 && (<>
                    <div className="grid gap-12 sm:grid-cols-2">
                      <Field label="First name" name="firstName" required maxLength={60} />
                      <Field label="Last name" name="lastName" required maxLength={60} />
                    </div>
                    <fieldset className="space-y-8">
                      <legend className="auth-label mb-4 font-semibold">Who are you looking for?</legend>
                      <div className="flex gap-16">
                        {[["transporter", "A transporter"], ["cfa", "A CFA (clearing & forwarding)"]].map(([v, label]) => (
                          <label key={v} className="flex items-center gap-8 text-xs"
                            style={{ color: "rgba(255,255,255,0.86)" }}>
                            <input type="checkbox" name="lookingFor" value={v} className="auth-check" />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                    <Field label="Your industry (optional)" name="industry" maxLength={80}
                      placeholder="Manufacturing, mining, retail…" />
                  </>)}
                  <Field label="Active phone (international format)" name="phone" required placeholder="+255712345678" />
                  <Field label="Email" name="email" type="email" required />
                  <PasswordField label="Password" name="password" required minLength={10} show={showPw} onToggle={() => setShowPw(v => !v)} />
                  <PasswordField label="Confirm password" name="confirm" required show={showPw} onToggle={() => setShowPw(v => !v)} />
                  <label className="flex items-start gap-8 text-xs" style={{ color: "rgba(255,255,255,0.86)" }}>
                    <input type="checkbox" name="terms" required className="auth-check mt-2" />
                    <span>I accept the Terms of Service and Privacy Policy</span>
                  </label>
                  <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
                    {busy ? "Creating account" : "Create account"}
                  </button>
                </form>
                {signupTab === 1 && (
                  <p className="mt-12 text-[11px]" style={{ color: "rgba(255,255,255,0.7)" }}>
                    Shipper accounts are not self-registered: the transporter or CFA handling
                    your cargo opens one and sends you the access.
                  </p>
                )}
              </div>
            )}

            {panel === "otp" && pending && (
              <div key="otp" className="panel-enter">
                <h2 className="mb-8 text-2xl font-bold tracking-tight" style={{ color: "#ffffff" }}>Six-digit code</h2>
                <p className="mb-16 text-sm" style={{ color: "rgba(255,255,255,0.82)" }}>
                  {pending.channel === "email"
                    ? "We emailed you a verification code. It expires in 5 minutes."
                    : "Sent by SMS to the phone you typed. Expires in 5 minutes."}
                </p>
                <OtpInput onComplete={verifyOtp} />
                <div className="mt-16 flex items-center justify-between text-sm">
                  <button type="button" disabled={cooldown > 0} className="auth-link underline disabled:opacity-50"
                    onClick={resendCode}>
                    {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
                  </button>
                  <button type="button" className="auth-link underline"
                    onClick={() => {
                      setError(null);
                      setPanel(pending.from === "signup" ? "signup" : "login");
                    }}>
                    {pending.from === "signup" ? "Change details" : "Back to sign in"}
                  </button>
                </div>
              </div>
            )}

            {panel === "success" && (
              <div key="success" className="panel-enter py-16 text-center">
                <div className="mx-auto mb-16 h-[2px] w-48" style={{ background: "#7fd6ab" }} aria-hidden />
                <h2 className="text-lg font-semibold" style={{ color: "#8fdcbc" }}>
                  {loginTab === 2 ? "Search account verified" : "Account successfully created"}
                </h2>
                <p className="mt-8 text-sm" style={{ color: "rgba(255,255,255,0.82)" }}>
                  {loginTab === 2
                    ? "Sign in to search the directory. Your first free search is ready now."
                    : "Sign in with your TIN and email to reach your workspace."}
                </p>
                <button type="button" className="auth-link mt-16 text-sm underline"
                  onClick={() => setPanel("login")}>Sign in now</button>
              </div>
            )}
          </div>

          {panel === "login" && (
            <div className="mt-16 border-t pt-8 text-center text-sm" style={{ borderColor: "rgba(255,255,255,0.22)" }}>
              <span style={{ color: "rgba(255,255,255,0.8)" }}>New to WAISHA? </span>
              <button type="button" className="auth-link font-semibold underline"
                onClick={() => { setError(null); setPanel("signup"); }}>Create an account</button>
            </div>
          )}
          {panel === "signup" && (
            <div className="mt-16 border-t pt-8 text-center text-sm" style={{ borderColor: "rgba(255,255,255,0.22)" }}>
              <span style={{ color: "rgba(255,255,255,0.8)" }}>Already registered? </span>
              <button type="button" className="auth-link font-semibold underline"
                onClick={() => { setError(null); setPanel("login"); }}>Sign in</button>
            </div>
          )}
        </div>
      </div>

      {showReset && (
        <div role="dialog" aria-modal="true" aria-label="Reset your password"
          className="fixed inset-0 z-50 flex items-center justify-center p-16"
          style={{ background: "rgba(5, 18, 26, 0.6)" }}
          onClick={e => { if (e.target === e.currentTarget) setShowReset(false); }}>
          <div className="auth-card w-full max-w-[380px] rounded-modal border p-24">
            <h2 className="mb-16 text-base font-semibold" style={{ color: "#ffffff" }}>Reset your password</h2>
            {resetDone ? (
              <p className="text-sm" style={{ color: "rgba(255,255,255,0.82)" }}>If that email is registered, a reset link has been sent.</p>
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
                <button type="submit" className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">Send reset link</button>
              </form>
            )}
            <button type="button" className="auth-link mt-16 text-sm underline"
              onClick={() => setShowReset(false)}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
}