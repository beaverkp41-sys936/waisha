"use client";
import { useEffect, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

interface LicenceInfo {
  tenant_status?: string;
  trial_ends_at?: string | null;
  licence_expires_at?: string | null;
  plan?: string | null;
  plan_key?: string | null;
  seats_licensed?: number | null;
  subscription_status?: string | null;
  operational?: boolean;
}

export function useLicence() {
  const [licence, setLicence] = useState<LicenceInfo | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const token = sessionStorage.getItem("waisha_access");
    const res = await fetch(`${API}/api/v1/licence`, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (res.ok) setLicence(await res.json());
    setLoading(false);
  }
  useEffect(() => { load(); }, []);
  return { licence, loading, reload: load };
}

export function useTrialCountdown(endsAt?: string | null) {
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

export function TrialBanner({ licence, onActivate }: { licence: LicenceInfo; onActivate?: () => void }) {
  const left = useTrialCountdown(licence.trial_ends_at);
  if (licence.tenant_status !== "trial") return null;
  const expired = licence.operational === false;
  return (
    <div role="status" className="flex items-center justify-between gap-16 px-16 py-8 text-sm"
      style={{ background: "var(--warning)", color: "#fff" }}>
      <span className="font-semibold tabular-nums">
        {expired ? "Trial ended — read-only. " : `Trial: ${left} remaining — `}
      </span>
      {!expired && (
        <button type="button" onClick={onActivate}
          className="underline font-semibold">Activate licence</button>
      )}
    </div>
  );
}

export function LicenceGate({ licence, onPay, onTrial }: {
  licence: LicenceInfo; onPay: () => void; onTrial: () => void;
}) {
  const [busy, setBusy] = useState<"trial" | null>(null);

  return (
    <div role="dialog" aria-modal="true" aria-label="Activate your licence"
      className="fixed inset-0 z-50 flex items-center justify-center p-16"
      style={{ background: "rgba(5,18,26,0.6)" }}>
      <div className="w-full max-w-[420px] rounded-modal bg-surface p-24"
        style={{ border: "1px solid var(--line)" }}>
        <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>Activate your licence</h2>
        <p className="mt-8 mb-24 text-sm" style={{ color: "var(--ink-soft)" }}>
          Choose how you would like to begin. Your data is safe either way.
        </p>
        <div className="space-y-12">
          <button type="button" onClick={onPay}
            className="waisha-btn w-full rounded-input py-12 text-sm font-semibold">
            Pay now
          </button>
          <button type="button" disabled={busy !== null} onClick={() => { setBusy("trial"); onTrial(); }}
            className="w-full rounded-input border py-12 text-sm font-semibold disabled:opacity-60"
            style={{ borderColor: "var(--line)" }}>
            {busy === "trial" ? "Starting" : "Start 48-hour trial"}
          </button>
        </div>
        <p className="mt-16 text-xs" style={{ color: "var(--ink-soft)" }}>
          One trial per company, TIN and phone. Mobile-money payment (AzamPay) arrives with the payment step.
        </p>
      </div>
    </div>
  );
}