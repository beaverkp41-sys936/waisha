"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

function ResetContent() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(null);
    if (password !== confirm) { setError("Passwords do not match."); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/v1/auth/reset-password`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const extra = Array.isArray(j?.error?.details) && j.error.details.length
          ? ` (${j.error.details.map((d: any) => d.message ?? "").filter(Boolean).join("; ")})`
          : "";
        setError((j?.error?.message ?? "This reset link is invalid or has expired.") + extra);
        return;
      }
      setDone(true);
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-[440px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>
        {done ? "Password set" : token ? "Choose a new password" : "Link problem"}
      </h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        {done
          ? "Your password is set. Sign in with the company TIN and your email."
          : token
            ? "This link also accepts staff invitations — setting a password activates the account."
            : "This page needs a valid link. Request a new one from the sign-in page."}
      </p>

      {error && <div role="alert" className="mt-16 px-12 py-8 text-sm"
        style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>{error}</div>}

      {done ? (
        <Link href="/login" className="waisha-btn mt-24 block rounded-input py-12 text-center text-sm font-semibold">
          Go to sign in
        </Link>
      ) : token ? (
        <form onSubmit={submit} className="mt-24 space-y-12 rounded-card border bg-surface p-24"
          style={{ borderColor: "var(--line)" }}>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>New password *</span>
            <input type="password" required minLength={10} value={password}
              onChange={e => setPassword(e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <label className="block">
            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Confirm password *</span>
            <input type="password" required minLength={10} value={confirm}
              onChange={e => setConfirm(e.target.value)} className={inputCls} style={inputStyle} />
          </label>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            At least 10 characters with an uppercase letter, a lowercase letter, a digit and a symbol.
          </p>
          <button type="submit" disabled={busy}
            className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
            {busy ? "Saving…" : "Set password"}
          </button>
        </form>
      ) : (
        <Link href="/login" className="waisha-btn mt-24 block rounded-input py-12 text-center text-sm font-semibold">
          Back to sign in
        </Link>
      )}
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="mx-auto max-w-[440px] px-16 py-32 text-sm" style={{ color: "var(--ink-soft)" }}>
        Loading…
      </div>
    }>
      <ResetContent />
    </Suspense>
  );
}
