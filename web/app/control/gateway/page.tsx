"use client";
import { useEffect, useState } from "react";
import { ControlNav } from "@/components/ControlNav";
import { WebhookLog } from "./webhooks";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";
/** 135's key. Held by the seats that settle charges, deliberately not by 114's manage duty — so
 *  the desk can hand a support seat the re-drive button without handing them the rail switch. */
const RETRY = "control.gateway.retry";

interface Rail {
  providerKey: string;
  label: string;
  adapter: string;
  adaptable: boolean;
  baseUrl: string | null;
  environment: string;
  enabled: boolean;
  hasCredentials: boolean;
  hasWebhookSecret: boolean;
  credentialHint: string | null;
  updatedAt: string;
  lastCheck: { at?: string; ok?: boolean; detail?: string } | null;
}

type Draft = Partial<Record<"label" | "baseUrl" | "environment" | "clientId" | "clientSecret"
  | "webhookSecret", string>>;

/**
 * The payment gateway desk.
 *
 * One question decides everything on this page: *which network is a company's money going
 * through right now?* The register answers it, `src/payments/registry.ts` reads that answer on
 * every charge, and nothing here needs a deploy or a shell. So a rail can be filed, tried,
 * switched on and switched off from this screen — the ask was "enter the credential in admin
 * panel, then activate it and the system work", and the webhook address below is the half of
 * "the system work" that closes a charge once the customer answers their phone.
 *
 * Credentials are write-only. The desk shows `credentialHint` — six characters of the app id, or
 * the last four of a secret — and never the stored value, because the register keeps them sealed
 * and the reader that feeds this list was written without the credential columns in it.
 *
 * 135 added the board under the rails: every webhook the platform received, whether its signature
 * matched, whether the office acted on it, and every time a seat has since re-driven it. The rails
 * above and the deliveries below are the same question asked of one rail — is this network working,
 * and what did it tell us — so they share a screen. The board reads through definer doors and the
 * register it describes is insert-only: nothing on this page can rewrite a rail&rsquo;s message.
 */
export default function ControlGatewayPage() {
  const [rails, setRails] = useState<Rail[]>([]);
  const [fallback, setFallback] = useState("mock");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [canRetry, setCanRetry] = useState(false);

  async function load() {
    const me = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
    if (!me.ok) { window.location.href = "/control/login"; return; }
    // The delivery log below is gated on a duty this register read does not answer for, so the
    // seat's keys are asked for separately — and a probe that fails is not treated as "no duty",
    // it just leaves the button unoffered, which is the same shape as a seat that lacks it.
    const p = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
    if (p.ok) setCanRetry(((await p.json().catch(() => ({}))).permissions ?? []).includes(RETRY));
    const res = await fetch(`${API}/api/v1/control/gateway`, { credentials: "include" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(j?.error?.message ?? "Could not read the gateway register"); setReady(true); return; }
    setRails(j.rails ?? []);
    setFallback(j.fallback ?? "mock");
    setReady(true);
  }

  useEffect(() => { load(); }, []);

  function edit(key: string, field: keyof Draft, value: string) {
    setDrafts(d => ({ ...d, [key]: { ...d[key], [field]: value } }));
  }

  async function call(path: string, method: string, body?: unknown): Promise<any> {
    const res = await fetch(`${API}/api/v1${path}`, {
      method, credentials: "include",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.error?.message ?? `The desk refused (${res.status})`);
    return j;
  }

  // Every action ends with the same reload it started from, so what the card says afterwards is
  // read back off the register rather than repeated from what the browser just typed.
  async function run(key: string, what: string, fn: () => Promise<any>) {
    setBusy(key); setError(null); setNotice(null);
    try {
      const j = await fn();
      await load();
      if (what === "test") {
        setNotice(j.ok
          ? `Checked. ${j.detail}`
          : `Not working. ${j.detail}`);
      } else if (what === "enable") {
        setNotice(j.enabled
          ? `${rails.find(r => r.providerKey === key)?.label ?? key} is live${j.deactivated ? `, and ${j.deactivated} was switched off to make room` : ""}.`
          : `${rails.find(r => r.providerKey === key)?.label ?? key} is off.`);
      } else if (what === "clear") {
        setNotice("Credentials removed. The rail stays in the register, empty.");
        setDrafts(d => ({ ...d, [key]: {} }));
      } else {
        setNotice("Saved.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setTimeout(() => setNotice(null), 9000);
    }
  }

  function save(key: string) {
    const d = drafts[key] ?? {};
    const credentials: Record<string, string> = {};
    if (d.clientId?.trim()) credentials.clientId = d.clientId.trim();
    if (d.clientSecret?.trim()) credentials.clientSecret = d.clientSecret.trim();
    const body: Record<string, unknown> = {};
    if (d.label !== undefined) body.label = d.label;
    if (d.baseUrl !== undefined) body.baseUrl = d.baseUrl.trim();
    if (d.environment !== undefined) body.environment = d.environment;
    if (Object.keys(credentials).length) body.credentials = credentials;
    if (d.webhookSecret?.trim()) body.webhookSecret = d.webhookSecret.trim();
    return run(key, "save", () => call(`/control/gateway/${key}`, "PUT", body));
  }

  const live = rails.find(r => r.enabled) ?? null;
  // A re-drive speaks in this desk's own voice, not in a panel of its own: the answer names the
  // attempt number the ledger filed and what the idempotent completion said back, which is the two
  // facts a seat needs before pressing again.
  const notify = (s: string) => { setError(null); setNotice(s); setTimeout(() => setNotice(null), 9000); };
  const fault = (s: string) => { setNotice(null); setError(s); };
  const cell = "w-full rounded-input border px-8 py-8 text-sm";
  const cellStyle = { borderColor: "var(--adm-line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Super Admin · Payment gateway
          </p>
        </div>
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1000px] px-16 py-32">
        <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Payment gateways</h1>

        {/* The one fact this whole desk exists to state. */}
        <div className="mt-12 mb-8 rounded-card border p-16"
          style={{
            borderColor: live ? "var(--success)" : "var(--adm-line)",
            background: live ? "color-mix(in srgb, var(--success) 8%, transparent)" : "transparent"
          }}>
          {ready && live ? (
            <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
              Charges go through {live.label}.
              <span className="ml-8 font-normal" style={{ color: "var(--ink-soft)" }}>
                {live.environment === "live" ? "Live network" : "Sandbox"} · last changed{" "}
                {new Date(live.updatedAt).toLocaleString()}
              </span>
            </p>
          ) : (
            <>
              <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                No rail is switched on — payments still answer from the server setting{" "}
                <code className="px-4" style={{ background: "var(--milk-deep)" }}>{fallback}</code>.
              </p>
              <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
                File a rail&rsquo;s credentials, test it, then switch it on. The next charge uses it;
                nothing needs redeploying.
              </p>
            </>
          )}
        </div>

        {notice && (
          <div className="mb-16 rounded-input px-12 py-8 text-sm" role="status"
            style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>
            {notice}
          </div>
        )}
        {error && (
          <div className="mb-16 rounded-input px-12 py-8 text-sm" role="alert"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
            {error}
          </div>
        )}

        <div className="mb-24 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
          <p className="mb-8 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
            Where the network sends its answer
          </p>
          <p className="mb-8 break-all font-mono text-xs" style={{ color: "var(--ink)" }}>
            POST {API}/api/v1/payments/webhook
          </p>
          <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
            Header <code style={{ background: "var(--milk-deep)" }} className="px-4">x-waisha-signature:
            sha256=&lt;hex&gt;</code> — an HMAC-SHA256 of the raw request body, keyed with the webhook
            secret saved below. The body is <code style={{ background: "var(--milk-deep)" }} className="px-4">
            {"{ reference, outcome, nonce?, event? }"}</code> and outcome is one of approved, failed,
            timed_out, cancelled. A call that is not signed completes nothing, and a call seen twice
            is answered but never spent twice.
          </p>
        </div>

        {rails.map(r => {
          const d = drafts[r.providerKey] ?? {};
          const isOpen = open === r.providerKey;
          return (
            <section key={r.providerKey} className="mb-16 rounded-card border p-16"
              style={{
                borderColor: r.enabled ? "var(--success)" : "var(--adm-line)",
                background: r.enabled ? "color-mix(in srgb, var(--success) 6%, transparent)" : "var(--surface)"
              }}>
              <div className="flex flex-wrap items-start justify-between gap-12">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-8 text-base font-bold" style={{ color: "var(--ink)" }}>
                    {r.label}
                    {r.enabled && (
                      <span className="rounded-full px-8 py-2 text-[10px] font-bold uppercase tracking-[0.1em]"
                        style={{ background: "var(--success)", color: "var(--brand-deep)" }}>
                        Live
                      </span>
                    )}
                    {!r.adaptable && (
                      <span className="rounded-full px-8 py-2 text-[10px] font-bold uppercase tracking-[0.1em]"
                        style={{ background: "var(--milk-deep)", color: "var(--ink-soft)" }}>
                        Adapter not written yet
                      </span>
                    )}
                  </h2>
                  <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {r.providerKey} · {r.baseUrl ?? "no gateway address"} · {r.environment}
                  </p>
                  <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {r.hasCredentials
                      ? <>Credentials saved <code className="px-4" style={{ background: "var(--milk-deep)" }}>{r.credentialHint}</code></>
                      : "No credentials saved"}
                    {" · "}{r.hasWebhookSecret ? "webhook secret saved" : "no webhook secret"}
                  </p>
                  {r.lastCheck?.detail && (
                    <p className="mt-8 text-xs"
                      style={{ color: r.lastCheck.ok ? "var(--success)" : "var(--danger)" }}>
                      {r.lastCheck.ok ? "Checked" : "Last check failed"}
                      {r.lastCheck.at ? ` ${new Date(r.lastCheck.at).toLocaleString()}` : ""} — {r.lastCheck.detail}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-8">
                  <button type="button" className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold"
                    disabled={busy === r.providerKey}
                    onClick={() => run(r.providerKey, "test",
                      () => call(`/control/gateway/${r.providerKey}/test`, "POST", {}))}>
                    Test
                  </button>
                  <button type="button"
                    className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold"
                    disabled={busy === r.providerKey}
                    onClick={() => run(r.providerKey, "enable",
                      () => call(`/control/gateway/${r.providerKey}/enable`, "POST", { enabled: !r.enabled }))}>
                    {r.enabled ? "Switch off" : "Switch on"}
                  </button>
                  <button type="button"
                    className="rounded-input border px-16 py-8 text-xs font-semibold"
                    style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}
                    onClick={() => setOpen(isOpen ? null : r.providerKey)}>
                    {isOpen ? "Close" : "Edit"}
                  </button>
                  <button type="button"
                    className="rounded-input border px-16 py-8 text-xs font-semibold"
                    style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                    disabled={busy === r.providerKey || !r.hasCredentials}
                    onClick={() => {
                      if (!window.confirm(`Remove every credential and the switch from ${r.label}?`)) return;
                      run(r.providerKey, "clear", () => call(`/control/gateway/${r.providerKey}`, "DELETE"));
                    }}>
                    Clear
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="mt-16 grid gap-12 sm:grid-cols-2">
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Name shown here</span>
                    <input className={cell} style={cellStyle} placeholder={r.label}
                      value={d.label ?? ""} onChange={e => edit(r.providerKey, "label", e.target.value)} />
                  </label>
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Gateway address (https)</span>
                    <input className={cell} style={cellStyle} placeholder={r.baseUrl ?? "https://checkout.example.tz"}
                      value={d.baseUrl ?? ""} onChange={e => edit(r.providerKey, "baseUrl", e.target.value)} />
                  </label>
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>App id / client id</span>
                    <input className={cell} style={cellStyle} autoComplete="off"
                      placeholder={r.hasCredentials ? (r.credentialHint ?? "saved") : "from the network"}
                      value={d.clientId ?? ""} onChange={e => edit(r.providerKey, "clientId", e.target.value)} />
                  </label>
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>App name / client secret</span>
                    <input className={cell} style={cellStyle} autoComplete="off" type="password"
                      placeholder={r.hasCredentials ? "keep blank to leave stored ones alone" : "from the network"}
                      value={d.clientSecret ?? ""} onChange={e => edit(r.providerKey, "clientSecret", e.target.value)} />
                  </label>
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Webhook secret</span>
                    <input className={cell} style={cellStyle} autoComplete="off" type="password"
                      placeholder={r.hasWebhookSecret ? "saved — blank keeps it" : "the key your network signs with"}
                      value={d.webhookSecret ?? ""} onChange={e => edit(r.providerKey, "webhookSecret", e.target.value)} />
                  </label>
                  <label className="block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Environment</span>
                    <select className={cell} style={cellStyle} value={d.environment ?? r.environment}
                      onChange={e => edit(r.providerKey, "environment", e.target.value)}>
                      <option value="sandbox">Sandbox — test numbers only</option>
                      <option value="live">Live — real money</option>
                    </select>
                  </label>
                  <p className="text-xs sm:col-span-2" style={{ color: "var(--ink-soft)" }}>
                    A credential set is stored as one sealed block: typing an app id and saving
                    replaces the whole set, so change both fields together. Blank fields are left
                    alone. Nothing typed here is ever shown back in full.
                  </p>
                  <div className="sm:col-span-2">
                    <button type="button" className="waisha-btn rounded-input px-16 py-8 text-xs font-semibold"
                      disabled={busy === r.providerKey} onClick={() => save(r.providerKey)}>
                      {busy === r.providerKey ? "Saving" : "Save"}
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })}

        <p className="mt-8 mb-24 text-xs" style={{ color: "var(--ink-soft)" }}>
          A rail whose badge says &ldquo;adapter not written yet&rdquo; can hold credentials but cannot
          take money: the code that speaks to that network does not exist yet, and switching it on
          would tell you the payment path is open when it is not. Only AzamPay can be activated today.
        </p>

        {/* The other half of a rail is what it pushes back. Filed here rather than on a page of its
            own because the first thing a desk does with a stalled charge is look at the row the rail
            left and the register above it in the same screen. */}
        <h2 className="mb-8 text-lg font-bold" style={{ color: "var(--ink)" }}>
          What the rails pushed back
        </h2>
        <p className="mb-16 max-w-[88ch] text-xs" style={{ color: "var(--ink-soft)" }}>
          Every webhook the platform has received since 005 opened the register, with the office&rsquo;s
          own state beside it. Nothing here can rewrite a delivery — the register is insert-only — and a
          re-drive asks 009&rsquo;s idempotent completion to close a charge the rail already answered for,
          so it cannot bill anybody twice.
        </p>
        <WebhookLog hooks={{ call, notify, fault, canRetry, retryKey: RETRY }} />
      </main>
    </div>
  );
}
