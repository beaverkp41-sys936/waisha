"use client";
import { useEffect, useRef, useState } from "react";

/**
 * The delivery log (135; task #344).
 *
 * 005 made `payment_webhooks` insert-only: every body a rail pushed is kept, forever, and nothing may
 * change it. That is the right rule for evidence and the wrong rule for a desk, because it means the
 * only place a stuck payment shows up is a row nobody can mark as worked. 135 answers it without
 * touching that table — the office&rsquo;s own state lives beside the delivery, in a retry ledger that
 * counts attempts and names the seat that spent one.
 *
 * **&ldquo;Stuck&rdquo; is the pile this desk exists for.** A delivery whose signature matched, whose
 * charge is still open and which the office never acted on is a customer who paid and was not served,
 * and before 135 the only way to find one was to be told about them. The chips above the board count
 * exactly the piles the `state` filter offers, from the door&rsquo;s own heading, so the number and
 * the rows underneath it cannot disagree.
 *
 * **A retry spends no money.** It re-asks 009&rsquo;s idempotent completion to close a charge the rail
 * already answered for, so it cannot bill or activate anything twice — which is why the duty here
 * (`control.gateway.retry`) is not 114&rsquo;s `control.gateway.manage`, the key that can switch a rail
 * off for every company on the platform. The ceiling of five attempts is about a person&rsquo;s time
 * and a rail&rsquo;s support ticket, and the door says which of its four tests refused the press.
 *
 * **Nothing here shows a phone number, an account or a secret.** The payload the desk prints is the
 * door&rsquo;s scrubbed copy, keyed by name at every depth; the charge is read without its encrypted
 * PII columns. That is a property of the reader, not of this screen, and it is why opening a delivery
 * is safe for a support seat.
 */

export interface Hooks {
  call: (path: string, method: string, body?: unknown) => Promise<any>;
  notify: (s: string) => void;
  fault: (s: string) => void;
  canRetry: boolean;
  retryKey: string;
}

/** The five piles the door will filter to, in the order a desk works them: what has to be acted on
 *  first, then what cannot be, then what is finished. */
const PILES: [string, string][] = [
  ["all", "Everything"], ["stuck", "Stuck"], ["unverified", "Unsigned"],
  ["landed", "Landed"], ["retried", "Re-driven"], ["orphan", "Name no charge"]];

const cell = "w-full rounded-input border px-8 py-8 text-sm";
const cellStyle = { borderColor: "var(--adm-line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const btn = "waisha-btn rounded-input px-16 py-8 text-xs font-semibold";
const card = "mb-24 rounded-card border p-16";
const th = "border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]";
const td = "px-8 py-8 align-top";
const soft = { color: "var(--ink-soft)" };
const ink = { color: "var(--ink)" };

const words = (s?: string | null) => String(s ?? "").replace(/_/g, " ");

function State({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <Chip tone={ok ? "good" : "bad"} v={ok ? yes : no} />;
}

function Chip({ tone, v }: { tone: "good" | "bad" | "soft"; v: string }) {
  const c = tone === "good" ? "var(--success)" : tone === "bad" ? "var(--danger)" : "var(--ink-soft)";
  return <span className="whitespace-nowrap rounded-input px-8 py-4 text-[11px] font-semibold"
    style={tone === "soft"
      ? { color: c, background: "var(--milk-deep)" }
      : { color: c, background: `color-mix(in srgb, ${c} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>{words(v)}</span>;
}

function Fig({ v, cur }: { v: any; cur?: string }) {
  const n = Number(v ?? 0);
  return <>{n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    {cur ? <span className="ml-4 text-[11px]" style={soft}>{cur}</span> : null}</>;
}

function useCommitted<T>(value: T, ms = 260): T {
  const [sent, setSent] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSent(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return sent;
}

export function WebhookLog({ hooks }: { hooks: Hooks }) {
  const [f, setF] = useState({ state: "all", provider: "", search: "", offset: 0 });
  const search = useCommitted(f.search.trim());
  const [board, setBoard] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const H = useRef(hooks);
  useEffect(() => { H.current = hooks; });

  const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : "—");

  async function readBoard() {
    setLoading(true); setErr(null);
    const parts = [`limit=50`, `offset=${f.offset}`, `state=${f.state}`];
    if (f.provider) parts.push(`provider=${f.provider}`);
    if (search) parts.push(`search=${encodeURIComponent(search)}`);
    try {
      setBoard(await H.current.call(`/control/gateway/webhooks?${parts.join("&")}`, "GET"));
    } catch (e: any) {
      setErr((e as Error).message);
      setBoard(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { readBoard(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [f.state, f.provider, f.offset, search]);

  /** The detail is re-read rather than taken from the row: a retry changes the attempt count, the
   *  charge&rsquo;s state and whether the button is still offered, and a panel built from the board
   *  would say none of that happened. */
  async function openRow(id: string) {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null); setDetailErr(null); setArmed(null);
    try {
      setDetail(await H.current.call(`/control/gateway/webhooks/${id}`, "GET"));
    } catch (e: any) {
      setDetailErr((e as Error).message);
      setOpenId(null);
    }
  }

  async function retry() {
    if (!detail) return;
    setBusy(`retry:${detail.id}`); setArmed(null);
    try {
      const j = await H.current.call(`/control/gateway/webhooks/${detail.id}/retry`, "POST", {});
      setDetail(await H.current.call(`/control/gateway/webhooks/${detail.id}`, "GET").catch(() => null));
      H.current.notify(`Attempt ${j?.attempt ?? "?"} on ${detail.provider} · `
        + `${detail.charge?.reference ?? "the reference it names"}: ${j?.message ?? "the door answered."}`);
      await readBoard();
    } catch (e: any) {
      H.current.fault((e as Error).message);
      // The refusal is a fact about the ledger, not a typo in the form: five spent or a charge that
      // closed under another seat's hand both change what the board says, so it is read again.
      await readBoard();
      setDetail(await H.current.call(`/control/gateway/webhooks/${detail.id}`, "GET").catch(() => null));
    } finally {
      setBusy(null);
    }
  }

  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  const heading: any[] = board?.heading ?? [];
  const rows: any[] = board?.rows ?? [];
  const pile = (k: string) => heading.reduce((a, h) => a + Number(h[k] ?? 0), 0);
  // The rail select is built from both the heading and the page of rows, because a filter can name a
  // rail whose deliveries all live on another page — and a board that only offered the rails currently
  // on screen would hide the one a seat is looking for.
  const providerSet = new Set<string>();
  [...heading, ...rows].forEach(x => { if (typeof x.provider === "string") providerSet.add(x.provider); });
  const providers = Array.from(providerSet);

  return (
    <>
      <section className={card} style={{ borderColor: "var(--adm-line)" }}>
        <div className="mb-12 flex flex-wrap items-start justify-between gap-12">
          <div className="min-w-0">
            <h2 className="text-base font-bold" style={ink}>What the rails pushed</h2>
            <p className="mt-4 max-w-[72ch] text-xs" style={soft}>
              Every body the platform has received, newest first, with the office&rsquo;s own state
              beside it: whether the signature matched, whether the completion landed, how many times a
              seat has re-driven it and which charge it names. The register itself is insert-only — a
              delivery cannot be edited or thrown away here, only answered.
            </p>
          </div>
        </div>

        <div className="mb-12 flex flex-wrap gap-8" role="group" aria-label="The piles of deliveries">
          {PILES.map(([k, l]) => {
            const n = k === "all" ? Number(board?.count ?? 0) : pile(k);
            return (
              <button key={k} type="button" className={`${btn} px-12 py-6`}
                aria-pressed={f.state === k}
                onClick={() => setF(x => ({ ...x, state: k, offset: 0 }))}
                style={f.state === k
                  ? { background: "var(--adm-accent)", color: "var(--brand-deep)", fontWeight: 800 }
                  : { background: "var(--milk)", color: "var(--ink)" }}>
                {l} <span className="ml-4 font-bold">{loading ? "…" : n}</span>
              </button>
            );
          })}
        </div>

        {heading.length > 0 && (
          <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
            {heading.map(h => (
              <div key={h.provider} className="rounded-card border p-12"
                style={{ borderColor: Number(h.stuck) > 0 ? "var(--danger)" : "var(--adm-line)" }}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={ink}>
                  {h.provider}
                  {Number(h.stuck) > 0 && (
                    <span className="ml-8 font-bold" style={{ color: "var(--danger)" }}>
                      {h.stuck} to work
                    </span>
                  )}
                </p>
                <p className="mt-4 text-xl font-bold" style={ink}>{h.deliveries}
                  <span className="ml-4 text-[11px] font-normal" style={soft}>deliveries the filters name</span>
                </p>
                <p className="mt-4 text-[11px]" style={soft}>
                  {h.landed} landed · {h.unverified} unsigned · {h.retried} re-driven ·{" "}
                  {h.orphan} name no charge · {h.attempts} attempt(s) filed, {h.spent} out of attempts
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
          <label><span className={labelCls} style={soft}>Rail</span>
            <select className={cell} style={cellStyle} value={f.provider}
              onChange={e => setF(x => ({ ...x, provider: e.target.value, offset: 0 }))}>
              <option value="">every rail</option>
              {providers.map(p => <option key={p} value={p}>{p}</option>)}
            </select></label>
          <label className="sm:col-span-2">
            <span className={labelCls} style={soft}>Reference, event, error or company</span>
            <input className={cell} style={cellStyle} value={f.search}
              placeholder="WSH-… , approved, signature, WEMA LTD"
              onChange={e => setF(x => ({ ...x, search: e.target.value, offset: 0 }))} />
          </label>
          <div className="flex items-end">
            <button className={btn} onClick={readBoard}>Re-read</button>
          </div>
        </div>

        {loading && <p className="mb-8 text-xs" style={soft}>Reading the deliveries…</p>}
        {err && <p className="mb-8 text-sm" style={{ color: "var(--danger)" }}>{err}</p>}
        {!loading && !err && rows.length === 0 && (
          <p className="mb-8 text-xs" style={soft}>
            {f.state === "stuck"
              ? "Nothing is stuck under these filters — every delivery the rail signed has been acted on."
              : "No delivery of this rail has reached the platform. The address a rail posts to is the one on the card above."}
          </p>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-xs">
              <thead>
                <tr style={soft}>
                  {["Arrived", "Rail", "Event", "Charge named", "Signature", "Acted on",
                    "Attempts", "Last attempt", "Company"].map(h => (
                    <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} onClick={() => openRow(r.id)} className="cursor-pointer border-b"
                    style={{ borderColor: "var(--adm-line)",
                      background: openId === r.id
                        ? "color-mix(in srgb, var(--adm-accent) 10%, transparent)" : undefined }}>
                    <td className={td} style={soft}>{when(r.arrived_at)}</td>
                    <td className={td}>{r.provider}</td>
                    <td className={td}>
                      {/* The door&rsquo;s `readable` is two tests at once — the body parsed into an event
                          and a reference came out of it. Only the first failure belongs in this column;
                          the second is the &ldquo;Charge named&rdquo; column&rsquo;s sentence. */}
                      {r.event === "unparsed"
                        ? <span style={{ color: "var(--danger)" }}>body the platform could not read</span>
                        : <Chip tone="soft" v={r.event} />}
                      {r.outcome_wanted && r.outcome_wanted !== r.event
                        ? <span className="ml-4" style={soft}>wants {words(r.outcome_wanted)}</span> : null}
                    </td>
                    <td className={`${td} break-all`}>
                      {r.reference
                        ? <span style={ink}>{r.reference}</span>
                        : <span style={{ color: "var(--danger)" }}>no reference</span>}
                    </td>
                    <td className={td}>
                      <State ok={!!r.verified} yes="signed" no="did not verify" />
                    </td>
                    <td className={td}>
                      {r.processed_at
                        ? <Chip tone="good" v="landed" />
                        : <span className="whitespace-nowrap rounded-input px-8 py-4 text-[11px] font-semibold"
                            style={{ color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 12%, transparent)",
                              border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)" }}>
                            {r.attempts > 0 ? `not acted on · ${r.attempts} try(ies)` : "never acted on"}
                          </span>}
                      {r.processing_error && (
                        <p className="mt-4 max-w-[34ch] text-[11px]" style={{ color: "var(--danger)" }}>
                          {r.processing_error}
                        </p>
                      )}
                    </td>
                    <td className={td}>{r.attempts} of 5</td>
                    <td className={td} style={soft}>
                      {r.last_attempt ? (
                        <>
                          <Chip tone="soft" v={r.last_attempt.outcome} />
                          <p className="mt-4 max-w-[34ch] text-[11px]">{r.last_attempt.message}</p>
                          <p className="text-[11px]">{r.last_attempt.acted_by ?? "a seat"} · {when(r.last_attempt.at)}</p>
                        </>
                      ) : "nobody yet"}
                    </td>
                    <td className={td} style={soft}>{r.charge?.tenant ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {Number(board?.count ?? 0) > rows.length && (
              <div className="mt-12 flex flex-wrap items-center gap-8 text-[11px]" style={soft}>
                <span>{rows.length} of {board?.count} on this page</span>
                <button className={`${btn} px-8 py-4`} disabled={f.offset <= 0}
                  style={f.offset <= 0 ? { opacity: 0.4 } : undefined}
                  onClick={() => setF(x => ({ ...x, offset: Math.max(0, x.offset - rows.length) }))}>
                  Previous
                </button>
                <button className={`${btn} px-8 py-4`}
                  disabled={f.offset + rows.length >= Number(board?.count ?? 0)}
                  style={f.offset + rows.length >= Number(board?.count ?? 0) ? { opacity: 0.4 } : undefined}
                  onClick={() => setF(x => ({ ...x, offset: x.offset + rows.length }))}>
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      {openId && (
        <section className={card} style={{ borderColor: "var(--adm-line)" }}>
          {detailErr && <p className="text-sm" style={{ color: "var(--danger)" }}>{detailErr}</p>}
          {detail && (
            <>
              <div className="mb-12 flex flex-wrap items-start justify-between gap-12">
                <div className="min-w-0">
                  <h2 className="text-base font-bold" style={ink}>
                    {detail.provider} · {words(detail.event)} ·{" "}
                    <span className="break-all">{detail.charge?.reference ?? detail.payload?.reference ?? "no reference"}</span>
                  </h2>
                  <p className="mt-4 text-xs" style={soft}>
                    Arrived {when(detail.arrived_at)} ·{" "}
                    {detail.processed_at ? `acted on ${when(detail.processed_at)}` : "the office has never acted on it"}
                    {" · "}{detail.attempts.length} attempt(s) filed
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-8">
                  <State ok={!!detail.verified} yes="signature matched" no="did not verify" />
                  {detail.can_retry
                    ? <Chip tone="good" v="can be re-driven" />
                    : <span className="whitespace-nowrap rounded-input px-8 py-4 text-[11px] font-semibold"
                        style={{ color: "var(--ink-soft)", background: "var(--milk-deep)" }}>
                        cannot be re-driven</span>}
                </div>
              </div>

              {detail.can_retry && hooks.canRetry && (
                <div className="mb-16 rounded-card border p-12"
                  style={{ borderColor: "var(--adm-line)", background: "var(--surface)" }}>
                  <p className="text-sm font-semibold" style={ink}>Re-drive the completion</p>
                  <p className="mt-4 max-w-[80ch] text-xs" style={soft}>
                    This asks 009&rsquo;s own door to close the charge {detail.charge?.reference ?? "the body names"} with{" "}
                    {words(detail.payload?.outcome ?? detail.event)}. Nothing is sent to the rail and no
                    money moves twice — the completion is idempotent and answers that the charge was
                    already final if it was. The attempt is written to the ledger either way, with the
                    seat that spent it.
                  </p>
                  <button className={`${btn} mt-12`}
                    disabled={busy === `retry:${detail.id}`}
                    style={armed === `retry:${detail.id}`
                      ? { background: "var(--danger)", color: "var(--milk)" } : undefined}
                    onClick={arm(`retry:${detail.id}`, retry)}>
                    {armed === `retry:${detail.id}`
                      ? "Tap again — this spends one of the five attempts"
                      : busy === `retry:${detail.id}` ? "Re-driving…" : "Re-drive it"}
                  </button>
                </div>
              )}

              {detail.can_retry && !hooks.canRetry && (
                <p className="mb-16 text-xs" style={soft}>
                  This delivery can be re-driven, but the button is not offered to this seat: re-driving
                  needs <code>{hooks.retryKey}</code>, which is kept apart from the gateway&rsquo;s
                  manage duty so that a support seat can finish a charge without being able to switch a
                  rail off for every company on the platform.
                </p>
              )}

              {!detail.can_retry && detail.why_not && (
                <p className="mb-16 rounded-input border-l-4 px-12 py-8 text-sm" role="note"
                  style={{ borderColor: "var(--adm-accent)", background: "var(--surface)", color: "var(--ink)" }}>
                  {detail.why_not}
                </p>
              )}

              <div className="grid gap-12 lg:grid-cols-2">
                <div className="rounded-card border p-12" style={{ borderColor: "var(--adm-line)" }}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>The charge it names</p>
                  {detail.charge ? (
                    <>
                      <p className="mt-8 text-sm font-semibold break-all" style={ink}>
                        {detail.charge.reference} · <Chip tone="soft" v={detail.charge.status} />
                      </p>
                      <p className="mt-8 text-xs" style={soft}>
                        <Fig v={detail.charge.amount} cur={detail.charge.currency} /> through{" "}
                        {detail.charge.rail ?? "no rail recorded"} · {detail.charge.tenant}
                        {detail.charge.tenant_type ? ` (${detail.charge.tenant_type})` : ""}
                        {detail.charge.invoice ? ` · invoice ${detail.charge.invoice}` : ""}
                      </p>
                      <p className="mt-4 text-[11px]" style={soft}>
                        Asked {when(detail.charge.requested_at)} ·{" "}
                        {detail.charge.completed_at ? `closed ${when(detail.charge.completed_at)}` : "still open"}
                        {detail.charge.provider_txn_id ? ` · rail says ${detail.charge.provider_txn_id}` : ""}
                      </p>
                      {detail.charge.status === "approved" && (
                        <p className="mt-8 text-[11px]" style={{ color: "var(--success)" }}>
                          The charge is closed, so the company&rsquo;s licence runs on it — which is why
                          a delivery that landed was audited on the company&rsquo;s rows as well as here.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>
                      No charge carries this reference. The delivery is real and the office did not
                      invent it, but there is nothing on the platform for it to complete — that is the
                      pile the chips above call &ldquo;name no charge&rdquo;, and the rail is the only
                      place left to ask.
                    </p>
                  )}
                  {detail.processing_error && (
                    <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>
                      The first arrival also failed: {detail.processing_error}
                    </p>
                  )}
                </div>

                <div className="rounded-card border p-12" style={{ borderColor: "var(--adm-line)" }}>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>The rail&rsquo;s row on the register above</p>
                  {detail.rail ? (
                    <p className="mt-8 text-xs" style={soft}>
                      {detail.rail.label} · <code className="px-4" style={{ background: "var(--milk-deep)" }}>{detail.rail.adapter}</code>{" "}
                      · {detail.rail.environment} · {detail.rail.live ? "switched on" : "switched off"}
                      <br />
                      {detail.rail.credential_hint
                        ? <>credentials <code className="px-4" style={{ background: "var(--milk-deep)" }}>{detail.rail.credential_hint}</code></>
                        : "no credentials filed"}
                      {detail.rail.last_check?.detail
                        ? <><span style={{ color: detail.rail.last_check.ok ? "var(--success)" : "var(--danger)" }}>
                            {detail.rail.last_check.ok ? " · checked: " : " · last check failed: "}
                            {detail.rail.last_check.detail}</span></>
                        : null}
                      <br />
                      Last changed {when(detail.rail.updated_at)}
                      {detail.rail.updated_by ? ` by ${detail.rail.updated_by}` : ""}
                    </p>
                  ) : (
                    <p className="mt-8 text-xs" style={soft}>
                      This rail has no row in 114&rsquo;s register: a delivery came in from a provider
                      the office never filed. The webhook secret on the rail is the thing to check, not
                      a gateway switch.
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-12 rounded-card border p-12" style={{ borderColor: "var(--adm-line)" }}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>
                  The body the rail sent, scrubbed
                </p>
                <p className="mt-4 text-[11px]" style={soft}>
                  Keys: {detail.payload_keys.map((k: string) => (
                    <code key={k} className="mr-4 px-4" style={{ background: "var(--milk-deep)" }}>{k}</code>
                  ))}
                  {detail.nonce ? <> · seen once, nonce {String(detail.nonce).slice(0, 12)}…</> : null}
                </p>
                <pre className="mt-8 max-h-[280px] overflow-auto break-all rounded-input p-8 text-[11px]"
                  style={{ background: "var(--milk)", color: "var(--ink)", border: "1px solid var(--adm-line)" }}>
                  {JSON.stringify(detail.payload, null, 2)}
                </pre>
                <p className="mt-8 text-[11px]" style={soft}>
                  Anything a rail uses for a person&rsquo;s account, a secret or a signature is removed
                  by name at every depth before this reaches the screen, so a delivery can be read by a
                  support seat without the desk becoming a PII dump.
                </p>
              </div>

              <div className="mt-12">
                <p className="mb-8 text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>
                  What the office has done about it ({detail.attempts.length})
                </p>
                {detail.attempts.length === 0 ? (
                  <p className="text-xs" style={soft}>
                    Nothing yet. The ledger beside this register only has a row when a seat presses the
                    button, which is why an unworked delivery and a worked one look the same until 135.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] border-collapse text-xs">
                      <thead>
                        <tr style={soft}>
                          {["#", "Outcome", "Answer", "Charge", "Seat", "When"].map(h => (
                            <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {detail.attempts.map((a: any, i: number) => (
                          <tr key={i} className="border-b" style={{ borderColor: "var(--adm-line)" }}>
                            <td className={td}>{a.attempt}</td>
                            <td className={td}><Chip tone={a.outcome === "succeeded" ? "good"
                              : a.outcome === "refused" ? "bad" : "soft"} v={a.outcome} /></td>
                            <td className={`${td} max-w-[52ch]`}>{a.message}</td>
                            <td className={`${td} break-all`} style={soft}>
                              {a.intent_reference ?? "—"}
                              {a.payment_status ? ` · ${words(a.payment_status)}` : ""}
                            </td>
                            <td className={td} style={soft}>{a.acted_by ?? "a seat"}
                              {a.acted_role ? ` (${words(a.acted_role)})` : ""}</td>
                            <td className={td} style={soft}>{when(a.at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
