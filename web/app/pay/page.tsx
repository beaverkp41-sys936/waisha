"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

type Cycle = "monthly" | "quarterly" | "annual";
interface Plan { key: string; name: string; seat_limit: number;
  price_monthly: string; price_quarterly: string; price_annual: string; }
interface Intent {
  intentReference: string; provider: string;
  subtotal: number; vat: number; total: number; timeoutAt: string;
}
type Phase = "form" | "waiting" | "approved" | "failed" | "timeout";

const PROVIDER_LABELS: Record<string, string> = {
  mpesa: "M-Pesa", airtel: "Airtel Money", tigopesa: "Mixx by Yas (Tigo Pesa)",
  halopesa: "Halopesa", azampesa: "Azampesa"
};

function ErrorChip({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div role="alert" className="mb-16 rounded-input px-12 py-8 text-sm"
      style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
      {msg}
    </div>
  );
}

function PayContent() {
  const params = useSearchParams();
  const token = typeof window !== "undefined" ? sessionStorage.getItem("waisha_access") : null;

  const [plans, setPlans] = useState<Plan[]>([]);
  const [planKey, setPlanKey] = useState(params.get("plan") ?? "business");
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [seats, setSeats] = useState(1);
  const [phone, setPhone] = useState("");
  const [providerOverride, setProviderOverride] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [intent, setIntent] = useState<Intent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(120);
  const [licenceAfter, setLicenceAfter] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch(`${API}/api/v1/control/plans-public`).catch(() => null);
      if (res?.ok) setPlans(await res.json());
    })();
  }, []);

  const plan = plans.find(p => p.key === planKey);
  const subtotal = plan ? Number(plan[`price_${cycle}`]) : 0;
  const vat = Math.round(subtotal * 0.18 * 100) / 100;
  const total = Math.round((subtotal + vat) * 100) / 100;

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const checkStatus = useCallback(async (ref: string) => {
    const res = await fetch(`${API}/api/v1/payments/${ref}/status`, {
      credentials: "include",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    });
    if (!res.ok) return;
    const j = await res.json();
    if (j.payment.status === "approved") {
      stopPolling();
      setLicenceAfter(j.licence?.licence_expires_at ?? null);
      setPhase("approved");
    } else if (j.payment.status === "failed") { stopPolling(); setPhase("failed"); }
    else if (j.payment.status === "cancelled") { stopPolling(); setPhase("failed"); }
  }, [token, stopPolling]);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null); setBusy(true);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch(`${API}/api/v1/payments/intent`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          planKey, billingCycle: cycle, seats: Number(seats),
          payerPhone: String(fd.get("phone") ?? "")
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "Could not start payment"); return; }
      setIntent(j);
      setSecondsLeft(Math.max(1, Math.round((new Date(j.timeoutAt).getTime() - Date.now()) / 1000)));
      setPhase("waiting");
    } finally { setBusy(false); }
  }

  // Countdown + polling fallback (spec 5.2: WebSocket primary comes with AzamPay;
  // polling every 5s is the designed fallback and the sandbox mode of operation)
  useEffect(() => {
    if (phase !== "waiting" || !intent) return;
    const tick = setInterval(() => setSecondsLeft(s => Math.max(0, s - 1)), 1000);
    pollRef.current = setInterval(() => checkStatus(intent.intentReference), 5000);
    void checkStatus(intent.intentReference);
    return () => { clearInterval(tick); stopPolling(); };
  }, [phase, intent, checkStatus, stopPolling]);

  useEffect(() => {
    if (phase === "waiting" && secondsLeft === 0) { stopPolling(); setPhase("timeout"); }
  }, [phase, secondsLeft, stopPolling]);

  const inputCls = "w-full rounded-input border px-12 py-12 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="page-shell flex flex-1 items-center justify-center px-16 py-32" style={{ background: "var(--milk)" }}>
      <div className="w-full max-w-[460px]">
        <h1 className="mb-24 text-center text-xl font-bold" style={{ color: "var(--brand-deep)" }}>WAISHA</h1>
        <div className="rounded-card border bg-surface p-24" style={{ borderColor: "var(--line)" }}>

          {phase === "form" && (
            <form onSubmit={submit} className="space-y-12">
              <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>Activate your licence</h2>
              <ErrorChip msg={error} />

              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Plan</span>
                <select value={planKey} onChange={e => setPlanKey(e.target.value)} className={inputCls} style={inputStyle}>
                  {plans.map(p => <option key={p.key} value={p.key}>{p.name} — up to {p.seat_limit} seats</option>)}
                </select>
              </label>

              <div>
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Billing cycle</span>
                <div className="grid grid-cols-3 gap-8">
                  {(["monthly", "quarterly", "annual"] as Cycle[]).map(c => (
                    <button key={c} type="button" onClick={() => setCycle(c)}
                      className={`rounded-input border py-8 text-xs font-semibold capitalize ${cycle === c ? "" : "opacity-60"}`}
                      style={cycle === c
                        ? { borderColor: "var(--brand)", background: "var(--milk)", color: "var(--brand-deep)" }
                        : { borderColor: "var(--line)" }}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Seats (staff accounts)</span>
                <input type="number" min={1} max={plan?.seat_limit ?? 100} value={seats}
                  onChange={e => setSeats(Number(e.target.value))} className={inputCls} style={inputStyle} />
              </label>

              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Phone number that will pay</span>
                <input name="phone" required placeholder="+255712345678" defaultValue={phone}
                  className={inputCls} style={inputStyle} />
              </label>

              {phone.length >= 9 && (
                <p className="text-sm" style={{ color: "var(--ink-soft)" }}>
                  Paying with: <strong style={{ color: "var(--ink)" }}>
                    {PROVIDER_LABELS[providerOverride] ?? "auto-detected on confirm"}</strong>
                </p>
              )}

              <div className="rounded-card border p-16 text-sm" style={{ borderColor: "var(--line)", background: "var(--milk)" }}>
                <div className="flex justify-between"><span>Subtotal</span><span className="tabular-nums">{subtotal.toLocaleString()} TZS</span></div>
                <div className="mt-4 flex justify-between"><span>VAT (18%)</span><span className="tabular-nums">{vat.toLocaleString()} TZS</span></div>
                <div className="mt-8 flex justify-between border-t pt-8 font-bold" style={{ borderColor: "var(--line)" }}>
                  <span>Total</span><span className="tabular-nums">{total.toLocaleString()} TZS</span>
                </div>
              </div>

              <button type="submit" disabled={busy} className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
                {busy ? "Sending request" : "Confirm payment"}
              </button>
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                A payment request will be sent to your phone. Enter your PIN to approve.
              </p>
            </form>
          )}

          {phase === "waiting" && intent && (
            <div className="text-center">
              <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>Approve on your phone</h2>
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                A payment request has been sent to your phone.
                Enter your PIN to approve {intent.total.toLocaleString()} TZS
                ({PROVIDER_LABELS[intent.provider] ?? intent.provider}).
              </p>
              <p className="my-24 text-3xl font-bold tabular-nums" style={{ color: "var(--brand-deep)" }}>
                {String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:{String(secondsLeft % 60).padStart(2, "0")}
              </p>
              <div className="mx-auto mb-16 h-8 w-8 animate-spin rounded-full border-2"
                style={{ borderColor: "var(--line)", borderTopColor: "var(--brand)" }} />
              <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
                Reference: <span className="tabular-nums">{intent.intentReference}</span>
              </p>
            </div>
          )}

          {phase === "approved" && (
            <div className="py-16 text-center">
              <div className="mx-auto mb-16 h-[2px] w-48" style={{ background: "var(--success)" }} />
              <h2 className="text-lg font-bold" style={{ color: "var(--success)" }}>Payment successful</h2>
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                Your licence is active{licenceAfter ? ` until ${new Date(licenceAfter).toLocaleDateString()}` : ""}.
              </p>
              <button type="button" onClick={() => { window.location.href = "/post-login"; }}
                className="waisha-btn mt-24 w-full rounded-input py-12 text-sm font-semibold">
                Go to dashboard
              </button>
            </div>
          )}

          {(phase === "failed" || phase === "timeout") && (
            <div className="py-16 text-center">
              <div className="mx-auto mb-16 h-[2px] w-48" style={{ background: "var(--danger)" }} />
              <h2 className="text-lg font-bold" style={{ color: "var(--danger)" }}>
                {phase === "timeout" ? "Payment request timed out" : "Payment was not completed"}
              </h2>
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                {phase === "timeout"
                  ? "You did not approve in time. No money has left your account."
                  : "The payment did not go through. No money has left your account."}
              </p>
              <button type="button" onClick={() => { setPhase("form"); setIntent(null); }}
                className="waisha-btn mt-24 w-full rounded-input py-12 text-sm font-semibold">
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PayPage() {
  return (
    <Suspense fallback={
      <div className="page-shell flex flex-1 items-center justify-center" style={{ background: "var(--milk)" }}>
        <p className="text-sm" style={{ color: "var(--ink-soft)" }}>Loading payment page</p>
      </div>
    }>
      <PayContent />
    </Suspense>
  );
}