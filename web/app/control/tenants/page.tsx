"use client";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementTicker } from "@/components/AnnouncementTicker";
import { ControlNav } from "@/components/ControlNav";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

interface TenantRow {
  tenant_id: string; name: string; tenant_type: string; status: string;
  trial_ends_at: string | null; licence_expires_at: string | null;
  subscription_status: string | null; plan_name: string | null; plan_key: string | null;
  plan_seats: number | null; seats_licensed: number | null; members: number;
  blocked_reason: string | null; blocked_note: string | null; blocked_since: string | null;
  created_at: string;
}
interface Plan { key: string; name: string; seat_limit: number;
  price_monthly: string; price_quarterly: string; price_annual: string; vat_rate: string; }
type Cycle = "monthly" | "quarterly" | "annual";

interface Receipt {
  subject?: string; recipients?: number;
  sms?: { sent: number; failed: number }; email?: { sent: number; failed: number };
  to?: { sms?: string; email?: string }[]; errors?: string[]; sent_at?: string;
}
interface Outcome {
  action_id: string; action: string; tenant_name: string;
  prior_status: string; new_status: string; closed: boolean;
  seats_licensed: number | null; sessions_revoked?: number;
  reason_code: string; note: string; delivery?: Receipt;
}
interface RegisterRow {
  id: string; action: string; reason_code: string; note: string;
  prior_status: string; new_status: string; seats_licensed: number | null;
  actor_kind: string; actor_role: string | null; delivery: Receipt; created_at: string;
}
interface Candidate {
  tenant_id: string; name: string; action: string; days_idle: number; lapsed_at: string | null;
}

const CHANNELS: [string, string][] = [
  ["azampesa", "Azampesa"], ["mpesa", "M-Pesa"], ["tigopesa", "Mixx by Yas (Tigo Pesa)"],
  ["airtel", "Airtel Money"], ["halopesa", "Halopesa"], ["bank", "Bank / Lipa Namba (direct)"]
];
const CYCLES: Cycle[] = ["monthly", "quarterly", "annual"];

/** The same seven keys the definer accepts, in the words the office uses. */
const REASONS: [string, string][] = [
  ["terms_violation", "Breach of the WAISHA terms"],
  ["long_idle", "No paid licence for a long time"],
  ["payment_default", "Unpaid subscription"],
  ["abuse", "Misuse of the platform"],
  ["complaint", "A complaint against this company"],
  ["security", "A security concern"],
  ["other", "Another decision by the WAISHA office"]
];
const reasonLabel = (k: string) => REASONS.find(([v]) => v === k)?.[1] ?? k;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

/** 0 means the licence is unmetered, null that no subscription row exists yet. */
function seatLine(t: TenantRow) {
  if (t.seats_licensed === null) return "no licence yet";
  if (t.seats_licensed === 0) return `${t.members} · unmetered`;
  return `${t.members} of ${t.seats_licensed}`;
}
const seatsFull = (t: TenantRow) =>
  t.seats_licensed !== null && t.seats_licensed > 0 && t.members >= t.seats_licensed;

function Receipt({ r }: { r: Receipt }) {
  const sent = (r.sms?.sent ?? 0) + (r.email?.sent ?? 0);
  return (
    <div className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
      <p>
        {sent > 0
          ? `Told ${r.recipients ?? 0}: SMS ${r.sms?.sent ?? 0}/${r.recipients ?? 0}, email ${r.email?.sent ?? 0}/${r.recipients ?? 0}`
          : `Notice did not go out — SMS ${r.sms?.failed ?? 0} failed, email ${r.email?.failed ?? 0} failed`}
        {r.sent_at ? ` · ${when(r.sent_at)}` : ""}
      </p>
      {!!r.to?.length && (
        <p className="mt-2 tabular-nums">{r.to.map((c, i) => c.sms ?? c.email ?? "—").join(" · ")}</p>
      )}
      {!!r.errors?.length && (
        <p className="mt-2" style={{ color: "var(--warning)" }}>{r.errors.join(" · ")}</p>
      )}
    </div>
  );
}

export default function TenantsPage() {
  const [rows, setRows] = useState<TenantRow[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canSell, setCanSell] = useState(false);

  const [target, setTarget] = useState<TenantRow | null>(null);
  const [planKey, setPlanKey] = useState("starter");
  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [provider, setProvider] = useState("mpesa");
  const [txnRef, setTxnRef] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  // The shutting half of the desk: one company, its reason, its register.
  const [manage, setManage] = useState<TenantRow | null>(null);
  const [reasonCode, setReasonCode] = useState("terms_violation");
  const [note, setNote] = useState("");
  const [mError, setMError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [history, setHistory] = useState<RegisterRow[]>([]);
  const [armed, setArmed] = useState<string | null>(null);

  // The idle clock: what it will do on its own, and the button that does it now.
  const [idle, setIdle] = useState<{ block_after_days: number; close_after_days: number; candidates: Candidate[] } | null>(null);
  const [swept, setSwept] = useState<string | null>(null);

  const load = useCallback(async (search: string): Promise<TenantRow[]> => {
    const res = await fetch(`${API}/api/v1/control/tenants${search ? `?q=${encodeURIComponent(search)}` : ""}`,
      { credentials: "include" });
    if (res.status === 401 || res.status === 403) { window.location.href = "/control/login"; return []; }
    if (!res.ok) return [];
    const fresh = (await res.json()) as TenantRow[];
    setRows(fresh);
    return fresh;
  }, []);

  const loadIdle = useCallback(async () => {
    const res = await fetch(`${API}/api/v1/control/tenants/policy/idle`, { credentials: "include" });
    if (res.ok) setIdle(await res.json());
  }, []);

  const loadHistory = useCallback(async (tenantId: string) => {
    const res = await fetch(`${API}/api/v1/control/tenants/${tenantId}/actions`, { credentials: "include" });
    if (res.ok) { setHistory(((await res.json())?.actions ?? []) as RegisterRow[]); return; }
    setHistory([]);
  }, []);

  useEffect(() => {
    (async () => {
      const p = await fetch(`${API}/api/v1/control/plans-public`);
      if (p.ok) setPlans(await p.json());
      const a = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
      if (a.ok) {
        const j = await a.json();
        const roles: string[] = j.roles ?? [];
        setCanManage((j.permissions ?? []).includes("control.tenants.manage"));
        setCanSell(roles.includes("super_admin") || roles.includes("billing_admin"));
      }
    })();
    load("");
  }, [load]);

  useEffect(() => { if (canManage) loadIdle(); }, [canManage, loadIdle]);

  function openDialog(t: TenantRow) {
    setTarget(t);
    setPlanKey("starter"); setCycle("monthly"); setProvider("mpesa"); setTxnRef("");
    const pl = plans.find(p => p.key === "starter");
    if (pl) setAmount(String(Math.round(Number(pl.price_monthly) * 1.18)));
    setError(null); setNotice(null);
  }

  function openManage(t: TenantRow) {
    setManage(t); setReasonCode("terms_violation"); setNote("");
    setMError(null); setOutcome(null); setArmed(null);
    loadHistory(t.tenant_id);
  }

  const sel = plans.find(p => p.key === planKey);
  const listed = sel ? Number(sel[`price_${cycle}`]) : 0;
  const listedTotal = sel ? Math.round(listed * (1 + Number(sel.vat_rate))) : 0;

  async function confirm() {
    if (!target) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${API}/api/v1/control/tenants/${target.tenant_id}/activate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({
          planKey, billingCycle: cycle, provider,
          providerTxnId: txnRef.trim() || undefined,
          amountOverride: amount ? Number(amount) : undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setError(j?.error?.message ?? "Activation failed"); return; }
      setNotice(`${j.mode === "extend" ? "Extended" : "Activated"}: ${target.name} — invoice ${j.invoice_number}, valid until ${new Date(j.licence_expires_at).toLocaleDateString()}`);
      setTarget(null);
      load(q);
    } finally { setBusy(false); }
  }

  /**
   * Act on a company. The API writes the register row and sends the notice before it
   * answers, so whatever comes back — even an error — is a reason to re-read both.
   */
  async function act(action: "block" | "unblock" | "close" | "notice") {
    if (!manage) return;
    setBusy(true); setMError(null); setOutcome(null);
    try {
      const res = await fetch(`${API}/api/v1/control/tenants/${manage.tenant_id}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ reasonCode, note: note.trim() })
      });
      const j = await res.json().catch(() => ({}));
      loadHistory(manage.tenant_id);
      if (canManage) loadIdle();
      // Re-read the list before the outcome paints: the dialog takes the company's live
      // status from these rows, and a closed company is no longer among them.
      await load(q);
      setArmed(null);
      if (!res.ok) {
        // The API answers a short note with "Request validation failed"; the field list
        // is the part that says what to type, and the desk has to be able to read it.
        const hints = (j?.error?.details ?? []).map((d: any) => d.message).join(" · ");
        setMError([j?.error?.message ?? "The action was refused.", hints].filter(Boolean).join(" — "));
      }
      else setOutcome(j as Outcome);
    } finally { setBusy(false); }
  }

  async function sweep() {
    setBusy(true); setError(null); setSwept(null);
    try {
      const res = await fetch(`${API}/api/v1/control/tenants/policy/sweep`, {
        // The route takes no input, but a POST with a JSON content-type and no body is
        // refused by Fastify before it ever reaches the handler, so say {} out loud.
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: "{}"
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        // This button sits on the page, not in the dialog, so its failure has to go to
        // the page-level banner — mError is only read inside the dialog.
        setError(j?.error?.message ?? "The clock could not run.");
      }
      else {
        setSwept(`Blocked ${j.blocked ?? 0} · closed ${j.closed ?? 0} · notices sent ${j.notices_sent ?? 0} · `
          + `skipped ${j.skipped ?? 0}${j.errors?.length ? ` · ${j.errors.join("; ")}` : ""}`);
        load(q); loadIdle();
      }
      setArmed(null);
    } finally { setBusy(false); }
  }

  // Armed on the first tap, run on the second. These write to another company's access
  // and its directors' phones, so a stray click must cost nothing.
  const twoTap = (key: string, run: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    run();
  };

  // The dialog opens on a snapshot of one row and every action below rewrites that row:
  // after a block the desk must offer the unblock, and after an unblock the reason is
  // gone. Take the live row whole — a null blocked_reason is the answer, not a gap to
  // fall back on. A closed company is no longer in the list, so the outcome says it.
  const mRow: TenantRow | null = manage
    ? rows.find(r => r.tenant_id === manage.tenant_id)
      ?? (outcome?.closed ? { ...manage, status: "closed", blocked_reason: null } : manage)
    : null;
  const mSuspended = mRow?.status === "suspended";
  const mClosed = mRow?.status === "closed";

  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const chip = (color: string) => ({ borderLeft: `4px solid ${color}`, color: "var(--ink)" });

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Super Admin · Tenants and licences
          </p>
        </div>
        <AnnouncementTicker />
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1080px] px-16 py-32">
        <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Tenants</h1>
        <p className="mt-8 mb-16 text-sm" style={{ color: "var(--ink-soft)" }}>
          Activate or extend licences when payment was verified out-of-band (wallet/bank transfer, gateway outage),
          and block, notify or close a company that has broken the terms. Every act is recorded on the company&apos;s
          register and told to its directors by SMS and email before it leaves this screen.
        </p>

        <input value={q} onChange={e => { setQ(e.target.value); load(e.target.value); }}
          placeholder="Search by company name"
          className={`${inputCls} mb-16`} style={inputStyle} />

        {notice && (
          <div className="mb-16 rounded-input bg-surface px-12 py-8 text-sm" role="status"
            style={{ borderLeft: "4px solid var(--success)" }}>
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="mb-16 rounded-input bg-surface px-12 py-8 text-sm"
            style={{ borderLeft: "4px solid var(--danger)" }}>
            {error}
          </div>
        )}

        {canManage && idle && (
          <section className="mb-24 rounded-card bg-surface p-16" style={{ border: "1px solid var(--line)" }}>
            <h2 className="text-sm font-bold" style={{ color: "var(--ink)" }}>The idle clock</h2>
            <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
              A company with no paid licence is blocked after {idle.block_after_days} days and closed after{" "}
              {idle.close_after_days}. The platform runs this every fifteen minutes; a company you unblocked here
              is ignored until its licence lapses again.
            </p>
            {idle.candidates.length === 0 ? (
              <p className="mt-8 text-xs font-semibold" style={{ color: "var(--success)" }}>
                Nothing is overdue. No company is due an action.
              </p>
            ) : (
              <ul className="mt-8 space-y-4">
                {idle.candidates.map(c => (
                  <li key={c.tenant_id} className="text-xs" style={{ color: "var(--ink)" }}>
                    <span className="font-semibold">{c.name}</span> — {c.days_idle} days without a licence,
                    due to <span className="font-semibold uppercase">{c.action}</span>
                  </li>
                ))}
              </ul>
            )}
            <button type="button" disabled={busy || idle.candidates.length === 0}
              onClick={twoTap("sweep", sweep)}
              className="mt-12 rounded-input border px-16 py-8 text-xs font-semibold disabled:opacity-50"
              style={armed === "sweep"
                ? { borderColor: "var(--danger)", color: "var(--danger)" }
                : { borderColor: "var(--line)", color: "var(--ink)" }}>
              {armed === "sweep" ? "Tap again to run the clock" : "Run the clock now"}
            </button>
            {swept && (
              <p className="mt-8 rounded-input bg-surface px-12 py-8 text-xs" role="status"
                style={{ borderLeft: "4px solid var(--success)", color: "var(--ink)" }}>
                {swept}
              </p>
            )}
          </section>
        )}

        <div className="overflow-hidden rounded-card border bg-surface" style={{ borderColor: "var(--line)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                <th className="p-12">Company</th>
                <th className="p-12">Type</th>
                <th className="p-12">Status</th>
                <th className="p-12">Plan</th>
                <th className="p-12">Seats</th>
                <th className="p-12">Licence until</th>
                <th className="p-12"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => {
                const live = t.licence_expires_at && new Date(t.licence_expires_at) > new Date();
                const suspended = t.status === "suspended";
                return (
                  <tr key={t.tenant_id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                    <td className="p-12 font-semibold" style={{ color: "var(--ink)" }}>{t.name}</td>
                    <td className="p-12" style={{ color: "var(--ink-soft)" }}>{t.tenant_type}</td>
                    <td className="p-12">
                      <span className="block px-8 py-4 text-[10px] font-bold uppercase"
                        style={chip(suspended ? "var(--danger)" : t.status === "active" ? "var(--success)"
                          : t.status === "trial" ? "var(--warning)" : "var(--ink-soft)")}>
                        {t.status}
                      </span>
                      {t.blocked_reason && (
                        <span className="mt-2 block text-[10px]" style={{ color: "var(--danger)" }}
                          title={t.blocked_note ?? ""}>
                          {reasonLabel(t.blocked_reason)}
                          {t.blocked_since ? ` · ${new Date(t.blocked_since).toLocaleDateString()}` : ""}
                        </span>
                      )}
                    </td>
                    <td className="p-12" style={{ color: "var(--ink-soft)" }}>
                      {t.plan_name ?? "—"}
                      {t.plan_seats !== null && (
                        <span className="mt-2 block text-[10px]">plan seats {t.plan_seats}</span>
                      )}
                    </td>
                    <td className="p-12 tabular-nums" style={{ color: seatsFull(t) ? "var(--warning)" : "var(--ink-soft)" }}>
                      {seatLine(t)}
                      {seatsFull(t) && (
                        <span className="mt-2 block text-[10px] font-bold uppercase">seats full</span>
                      )}
                    </td>
                    <td className="p-12 tabular-nums" style={{ color: "var(--ink-soft)" }}>
                      {t.licence_expires_at ? new Date(t.licence_expires_at).toLocaleDateString() : "—"}
                    </td>
                    <td className="p-12 text-right">
                      <div className="flex flex-wrap justify-end gap-8">
                        {canSell && (
                          <button type="button" onClick={() => openDialog(t)}
                            className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold">
                            {live ? "Extend" : "Activate"}
                          </button>
                        )}
                        {canManage && (
                          <button type="button" onClick={() => openManage(t)}
                            className="rounded-input border px-12 py-8 text-xs font-semibold"
                            style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                            Manage
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td className="p-16 text-sm" style={{ color: "var(--ink-soft)" }} colSpan={7}>No tenants found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>

      {target && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-16"
          style={{ background: "rgba(2, 4, 8, 0.7)" }}>
          <div className="w-full max-w-[420px] rounded-modal bg-surface p-24" style={{ border: "1px solid var(--line)" }}>
            <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              {target.licence_expires_at && new Date(target.licence_expires_at) > new Date() ? "Extend licence" : "Activate licence"}
            </h2>
            <p className="mt-4 mb-16 text-sm" style={{ color: "var(--ink-soft)" }}>{target.name}</p>

            <div className="space-y-12">
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Plan</span>
                <select value={planKey} onChange={e => {
                  setPlanKey(e.target.value);
                  const pl = plans.find(p => p.key === e.target.value);
                  if (pl) setAmount(String(Math.round(Number(pl[`price_${cycle}`]) * (1 + Number(pl.vat_rate)))));
                }} className={inputCls} style={inputStyle}>
                  {plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                </select>
              </label>
              <div>
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Period</span>
                <div className="grid grid-cols-3 gap-8">
                  {CYCLES.map(c => (
                    <button key={c} type="button"
                      onClick={() => {
                        setCycle(c);
                        const pl = plans.find(p => p.key === planKey);
                        if (pl) setAmount(String(Math.round(Number(pl[`price_${c}`]) * (1 + Number(pl.vat_rate)))));
                      }}
                      className={`rounded-input border py-8 text-xs font-semibold capitalize ${cycle === c ? "" : "opacity-60"}`}
                      style={cycle === c
                        ? { borderColor: "var(--adm-accent)", background: "var(--adm-accent-soft)", color: "var(--adm-accent)" }
                        : { borderColor: "var(--line)", color: "var(--ink)" }}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Payment channel (how they actually paid)</span>
                <select value={provider} onChange={e => setProvider(e.target.value)} className={inputCls} style={inputStyle}>
                  {CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Transaction reference (from their SMS/receipt — optional)</span>
                <input value={txnRef} onChange={e => setTxnRef(e.target.value)} className={inputCls} style={inputStyle} />
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                  Total TZS {listedTotal ? `(list price ${listedTotal.toLocaleString()})` : ""} — editable for agreed discounts
                </span>
                <input type="number" min={0} value={amount} onChange={e => setAmount(e.target.value)}
                  className={inputCls} style={inputStyle} />
              </label>
            </div>

            {error && <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>{error}</p>}

            <div className="mt-16 flex gap-8">
              <button type="button" disabled={busy} onClick={confirm}
                className="waisha-btn flex-1 rounded-input py-12 text-sm font-semibold disabled:opacity-60">
                {busy ? "Working" : "Confirm and activate"}
              </button>
              <button type="button" onClick={() => setTarget(null)}
                className="rounded-input border px-16 py-12 text-sm font-semibold" style={{ borderColor: "var(--line)" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {mRow && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center p-16"
          style={{ background: "rgba(2, 4, 8, 0.7)" }}>
          <div className="max-h-[88vh] w-full max-w-[620px] overflow-y-auto rounded-modal bg-surface p-24"
            style={{ border: "1px solid var(--line)" }}>
            <h2 className="text-lg font-bold" style={{ color: "var(--ink)" }}>Act on this company</h2>
            <p className="mt-4 text-sm" style={{ color: "var(--ink-soft)" }}>
              {mRow.name} · {mRow.status}
              {mRow.blocked_reason ? ` · blocked for ${reasonLabel(mRow.blocked_reason)}` : ""}
            </p>

            <div className="mt-16 space-y-12">
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Reason</span>
                <select value={reasonCode} onChange={e => setReasonCode(e.target.value)}
                  className={inputCls} style={inputStyle}>
                  {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="block">
                <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                  What the company is told (8–600 characters)
                </span>
                <textarea value={note} onChange={e => setNote(e.target.value)} rows={4}
                  placeholder="Which term was broken, and what has to happen for it to be lifted."
                  className={`${inputCls} font-sans`} style={inputStyle} />
                <span className="mt-2 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                  {note.trim().length}/600
                </span>
              </label>
            </div>

            {mError && (
              <p role="alert" className="mt-12 rounded-input px-12 py-8 text-xs"
                style={{ borderLeft: "4px solid var(--danger)", color: "var(--ink)" }}>
                {mError}
              </p>
            )}
            {outcome && (
              <div role="status" className="mt-12 rounded-input px-12 py-8"
                style={{ borderLeft: `4px solid ${outcome.action === "notice" ? "var(--warning)"
                  : outcome.action === "unblock" ? "var(--success)" : "var(--danger)"}` }}>
                <p className="text-xs font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                  {outcome.action} · {outcome.prior_status} → {outcome.new_status}
                  {outcome.sessions_revoked ? ` · ${outcome.sessions_revoked} sessions revoked` : ""}
                </p>
                <Receipt r={outcome.delivery ?? {}} />
              </div>
            )}

            <div className="mt-16 flex flex-wrap gap-8">
              <button type="button" disabled={busy || mSuspended || mClosed}
                onClick={() => act("block")}
                className="rounded-input border px-16 py-10 text-xs font-semibold disabled:opacity-40"
                style={{ borderColor: "var(--danger)", color: "var(--ink)" }}>
                {mClosed ? "Account closed" : mSuspended ? "Already suspended" : "Block access"}
              </button>
              <button type="button" disabled={busy || !mSuspended}
                onClick={() => act("unblock")}
                className="rounded-input border px-16 py-10 text-xs font-semibold disabled:opacity-40"
                style={{ borderColor: "var(--success)", color: "var(--ink)" }}>
                {mSuspended ? "Restore access" : "Not suspended"}
              </button>
              <button type="button" disabled={busy || mClosed} onClick={() => act("notice")}
                className="rounded-input border px-16 py-10 text-xs font-semibold disabled:opacity-40"
                style={{ borderColor: "var(--warning)", color: "var(--ink)" }}>
                Send notice only
              </button>
              <button type="button" disabled={busy || mClosed}
                onClick={twoTap(`close-${mRow.tenant_id}`, () => act("close"))}
                className="rounded-input border px-16 py-10 text-xs font-semibold disabled:opacity-40"
                style={armed === `close-${mRow.tenant_id}`
                  ? { borderColor: "var(--danger)", background: "color-mix(in srgb, var(--danger) 14%, transparent)", color: "var(--ink)" }
                  : { borderColor: "var(--danger)", color: "var(--ink)" }}>
                {armed === `close-${mRow.tenant_id}` ? "Tap again to close the account" : "Close account"}
              </button>
            </div>

            <h3 className="mt-24 text-[11px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
              Register for {mRow.name}
            </h3>
            {history.length === 0 ? (
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                Nothing has been done to this company. The first entry you write here is the one it will be told about.
              </p>
            ) : (
              <ol className="mt-8 space-y-12">
                {history.map(h => (
                  <li key={h.id} className="rounded-input px-12 py-8" style={{ borderLeft: "4px solid var(--line)" }}>
                    <p className="text-xs font-bold uppercase tracking-[0.1em]" style={{ color: "var(--ink)" }}>
                      {h.action} · {reasonLabel(h.reason_code)} · {when(h.created_at)}
                    </p>
                    <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                      {h.prior_status} → {h.new_status} · by {h.actor_kind}
                      {h.actor_role ? ` (${h.actor_role})` : ""}
                    </p>
                    <p className="mt-4 text-xs" style={{ color: "var(--ink)" }}>{h.note}</p>
                    <Receipt r={h.delivery ?? {}} />
                  </li>
                ))}
              </ol>
            )}

            <div className="mt-20 flex gap-8">
              <button type="button" onClick={() => setManage(null)}
                className="rounded-input border px-16 py-12 text-sm font-semibold" style={{ borderColor: "var(--line)" }}>
                Close this panel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
