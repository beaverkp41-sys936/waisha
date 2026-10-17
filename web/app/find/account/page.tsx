"use client";
import { useEffect, useState } from "react";
import { seekerFetch } from "../api-client";
import { useMeter } from "../meter";
import { errorText, fmtDate, fmtDateTime, hm, money, PAYMENT_METHODS } from "../labels";

type Profile = {
  seekerId: string; firstName: string; lastName: string; email: string; phoneMasked: string | null;
  lookingFor: string[]; industry: string | null; country: string; company: string;
  emailVerifiedAt: string | null; phoneVerifiedAt: string | null; since: string;
};

const CARD = "rounded-card border bg-surface p-24";
const CARD_STYLE = { borderColor: "var(--line)" };
const INPUT = "rounded-input border px-12 py-8 text-sm w-full";
const INPUT_STYLE = { borderColor: "var(--line)", background: "var(--milk)" };

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-4 block text-[10px] font-bold uppercase tracking-[0.14em]"
      style={{ color: "var(--ink-soft)" }}>
      {children}
    </span>
  );
}

export default function FindAccountPage() {
  const { state, claimFree, recordWeekly } = useMeter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [looking, setLooking] = useState<string[]>([]);
  const [industry, setIndustry] = useState("");
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState("mpesa");
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    seekerFetch("/seeker/profile")
      .then(async res => {
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setMsg({ kind: "bad", text: errorText(j, "Could not load your account.") });
          return;
        }
        setProfile(j);
        setFirst(j.firstName ?? "");
        setLast(j.lastName ?? "");
        setLooking(j.lookingFor ?? []);
        setIndustry(j.industry ?? "");
      })
      .catch(() => { })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await seekerFetch("/seeker/profile", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: first.trim(), lastName: last.trim(),
          lookingFor: looking, industry: industry.trim() || null
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ kind: "bad", text: errorText(json, "Could not save.") }); return; }
      setProfile(p => (p ? { ...p, ...json } : p));
      setMsg({ kind: "ok", text: "Saved." });
    } catch (e: any) {
      if (e?.message !== "session ended") setMsg({ kind: "bad", text: "Could not save." });
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    setBusy(true); setMsg(null);
    const r = await claimFree();
    setMsg(r.ok
      ? { kind: "ok", text: "Free search ready — one search for the next 24 hours." }
      : { kind: "bad", text: r.message });
    setBusy(false);
  }

  async function record(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const r = await recordWeekly(reference.trim(), method);
    if (r.ok) {
      setReference("");
      setMsg({ kind: "ok", text: r.json.note ?? "Recorded. The office will confirm your payment." });
    } else {
      setMsg({ kind: "bad", text: r.message });
    }
    setBusy(false);
  }

  const weekly = state?.products?.find(p => p.key === "weekly");

  return (
    <div className="mx-auto max-w-[720px] px-16 py-32">
      <h1 className="text-2xl font-bold" style={{ color: "var(--ink)" }}>My account</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        Who you are, what you are looking for, and the search passes on your account.
      </p>

      {msg && (
        <div role="status" className="mt-16 px-12 py-8 text-sm"
          style={msg.kind === "ok"
            ? { background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }
            : { background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {msg.text}
        </div>
      )}

      {!ready ? (
        <p className="mt-24 text-sm" style={{ color: "var(--ink-soft)" }}>Loading…</p>
      ) : profile && (
        <form className={`${CARD} mt-24`} style={CARD_STYLE} onSubmit={saveProfile}>
          <h2 className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            Your details
          </h2>
          <div className="mt-12 grid gap-12 sm:grid-cols-2">
            <label className="block">
              <Label>First name</Label>
              <input value={first} onChange={e => setFirst(e.target.value)} required maxLength={60}
                className={INPUT} style={INPUT_STYLE} />
            </label>
            <label className="block">
              <Label>Last name</Label>
              <input value={last} onChange={e => setLast(e.target.value)} required maxLength={60}
                className={INPUT} style={INPUT_STYLE} />
            </label>
          </div>

          <fieldset className="mt-16">
            <Label>Who are you looking for?</Label>
            <div className="flex gap-24">
              {[["transporter", "A transporter"], ["cfa", "A CFA (clearing & forwarding)"]].map(([v, label]) => (
                <label key={v} className="flex items-center gap-8 text-sm" style={{ color: "var(--ink)" }}>
                  <input type="checkbox" checked={looking.includes(v)}
                    onChange={e => setLooking(cur => e.target.checked ? [...cur, v] : cur.filter(x => x !== v))} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="mt-16 block">
            <Label>Your industry</Label>
            <input value={industry} onChange={e => setIndustry(e.target.value)} maxLength={80}
              placeholder="Manufacturing, mining, retail…" className={INPUT} style={INPUT_STYLE} />
          </label>

          <div className="mt-16 grid gap-8 text-xs sm:grid-cols-2">
            <p style={{ color: "var(--ink-soft)" }}>Email · <span style={{ color: "var(--ink)" }}>{profile.email}</span></p>
            <p style={{ color: "var(--ink-soft)" }}>
              Phone · <span style={{ color: "var(--ink)" }}>{profile.phoneMasked ?? "—"}</span>
            </p>
            <p style={{ color: "var(--ink-soft)" }}>
              Verified · <span style={{ color: "var(--ink)" }}>
                {fmtDate(profile.emailVerifiedAt ?? profile.phoneVerifiedAt)}
              </span>
            </p>
            <p style={{ color: "var(--ink-soft)" }}>
              With WAISHA since · <span style={{ color: "var(--ink)" }}>{fmtDate(profile.since)}</span>
            </p>
          </div>
          <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
            Email and phone are not editable here: either one is a login identity, and changing it
            would leave the verified stamp pointing at an address nobody confirmed.
          </p>

          <button type="submit" disabled={busy}
            className="waisha-btn mt-16 rounded-input px-24 py-8 text-sm font-semibold disabled:opacity-50">
            {busy ? "Saving" : "Save"}
          </button>
        </form>
      )}

      <section className={`${CARD} mt-24`} style={CARD_STYLE}>
        <h2 className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
          Search passes
        </h2>
        {!state ? (
          <p className="mt-12 text-sm" style={{ color: "var(--ink-soft)" }}>Reading your meter…</p>
        ) : (
          <>
            <div className="mt-12 grid gap-12 sm:grid-cols-2">
              {state.products.map(p => (
                <div key={p.key} className="rounded-input border p-16" style={CARD_STYLE}>
                  <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>{p.name}</p>
                  <p className="mt-4 text-lg font-bold tabular-nums" style={{ color: "var(--gold)" }}>
                    {Number(p.price) === 0 ? "Free" : money(p.price, p.currency)}
                  </p>
                  <p className="mt-4 text-[11px] leading-snug" style={{ color: "var(--ink-soft)" }}>
                    {p.description}
                  </p>
                  <p className="mt-8 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                    {p.searches_allowed} search{p.searches_allowed === 1 ? "" : "es"} ·{" "}
                    {p.window_hours >= 24 ? `${Math.round(p.window_hours / 24)} day(s)` : `${p.window_hours}h`}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-16 flex flex-wrap items-center gap-12">
              {state.live_pass_id ? (
                <p className="text-sm" style={{ color: "var(--ink)" }}>
                  Live now: <strong>{state.live_kind === "weekly" ? "weekly pass" : "free search"}</strong>{" "}
                  — {state.live_remaining ?? 0} left{state.live_expires_at ? `, until ${fmtDateTime(state.live_expires_at)}` : ""}.
                </p>
              ) : state.free_wait_minutes > 0 ? (
                <p className="text-sm" style={{ color: "var(--ink)" }}>
                  Next free search unlocks in <strong>{hm(state.free_wait_minutes)}</strong>.
                </p>
              ) : (
                <button type="button" onClick={claim} disabled={busy}
                  className="waisha-btn rounded-input px-24 py-8 text-sm font-semibold disabled:opacity-50">
                  Claim today&apos;s free search
                </button>
              )}
              {state.awaiting_count > 0 && (
                <span className="rounded-input px-12 py-4 text-[10px] font-bold uppercase tracking-[0.12em]"
                  style={{ background: "color-mix(in srgb, var(--warning) 14%, transparent)", color: "var(--ink)" }}>
                  {state.awaiting_count} payment awaiting confirmation
                </span>
              )}
            </div>

            {/* `record_weekly_pass` refuses a second week while one is running and a
                second reference while one is with the office, so the page does not
                offer a form the database is going to send back. */}
            {state.awaiting_count > 0 || (state.live_kind === "weekly" && state.live_pass_id) ? (
              <div className="mt-16 border-t pt-16 text-sm" style={{ ...CARD_STYLE, borderColor: "var(--line)" }}>
                {state.awaiting_count > 0 ? (
                  <>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      Waiting for the office
                    </p>
                    <p className="mt-8" style={{ color: "var(--ink)" }}>
                      Your payment reference is already with the office. There is nothing to send
                      again — your week starts the moment somebody confirms the money, and you can
                      keep searching meanwhile if you have a credit left.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      Nothing to pay yet
                    </p>
                    <p className="mt-8" style={{ color: "var(--ink)" }}>
                      Your week is open until <strong>{fmtDateTime(state.live_expires_at)}</strong> with{" "}
                      <strong>{state.live_remaining ?? 0}</strong> search{state.live_remaining === 1 ? "" : "es"} left
                      on it. Record the next one from that moment — the office will not take a second
                      payment for a week that is already running.
                    </p>
                    <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                      If the week expires and you still have searches left on it, it is finished:
                      the pass lasts seven days, not until the searches run out.
                    </p>
                  </>
                )}
              </div>
            ) : (
              <form className="mt-16 border-t pt-16" style={CARD_STYLE} onSubmit={record}>
                <h3 className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                  Record a weekly pass — {weekly ? money(weekly.price, weekly.currency) : "TSh 3,000"}
                </h3>
                <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  Pay through your mobile money or bank app, then type the transaction reference here.
                  WAISHA does not charge you anything inside the app — the office confirms the payment
                  and the week starts from that moment.
                </p>
                <div className="mt-12 flex flex-wrap gap-12">
                  <label className="min-w-[200px] flex-1">
                    <Label>Transaction reference</Label>
                    <input value={reference} onChange={e => setReference(e.target.value)} required
                      minLength={4} maxLength={80} placeholder="e.g. SGC24Q7X9" className={INPUT} style={INPUT_STYLE} />
                  </label>
                  <label className="min-w-[180px]">
                    <Label>How you paid</Label>
                    <select value={method} onChange={e => setMethod(e.target.value)} className={INPUT} style={INPUT_STYLE}>
                      {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                    </select>
                  </label>
                </div>
                <button type="submit" disabled={busy || reference.trim().length < 4}
                  className="waisha-btn mt-16 rounded-input px-24 py-8 text-sm font-semibold disabled:opacity-50">
                  {busy ? "Recording" : "Send reference to the office"}
                </button>
              </form>
            )}
          </>
        )}
      </section>
    </div>
  );
}
