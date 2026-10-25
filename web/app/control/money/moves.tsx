"use client";
import { useEffect, useRef, useState } from "react";

/**
 * The three registers that sit on top of the book (134): a holder's wallet, the money parked against
 * a job, and the money the office owes out — plus the batches that carry the last one.
 *
 * Two facts about this half of the desk are invisible in the markup and are the reason it is written
 * the way it is:
 *
 * **A plan and a payout are not signed at this desk.** `money.escrow` and `money.payout` are kinds in
 * 121's register, so the second seat signs on Approvals and the effect runs in its order (decide →
 * claim → apply → settle). Every door here can put a paper up or take one down; none of them can
 * release its own signature, and the captions say so rather than letting a clerk wait for a button
 * that does not exist.
 *
 * **A payee line is never read out of a list.** The whole number is encrypted on the way in, the board
 * carries its last four digits, and the keyed hash the definer returns is stripped by the route.
 * Opening the number is a separate duty (`control.money.reveal`), is twelve an hour, and is written to
 * the register before the value is returned — so it is offered here one payout at a time, in the
 * detail panel, and never as a column.
 *
 * Stopping a holder's wallet costs `control.money.escrow`, not the pen: the register's own words for
 * the two duties give the seat that adjudicates a job the halt, and 133 keeps the freeze out of the
 * pen for the same reason. The button is gated accordingly, beside the money it stops.
 */

export type MovesTab = "wallets" | "escrow" | "payouts" | "batches";

export interface Desk {
  call: (path: string, method: string, body?: unknown,
    extra?: Record<string, string>) => Promise<any>;
  download: (path: string, filename: string) => Promise<void>;
  fig: (v: unknown) => string;
  when: (v?: string | null) => string;
  today: () => string;
  cents: (s: string) => number;
  mint: () => string;
  notify: (s: string) => void;
  fault: (s: string) => void;
  can: { pay: boolean; escrow: boolean; reveal: boolean; recon: boolean };
  go: (t: MovesTab) => void;
}

const cell = "w-full rounded-input border px-8 py-8 text-sm";
const cellStyle = { borderColor: "var(--adm-line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const btn = "waisha-btn rounded-input px-16 py-8 text-xs font-semibold";
const card = "mb-24 rounded-card border p-16";
const th = "border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]";
const td = "px-8 py-8 align-top";
const soft = { color: "var(--ink-soft)" };
const ink = { color: "var(--ink)" };

const CURRENCIES = ["", "TZS", "USD"];
const REASONS = ["terms_violation", "long_idle", "payment_default", "abuse", "complaint",
  "security", "other"];
const SUBJECT_KINDS: [string, string][] = [
  ["booking", "A booking"], ["cargo_file", "A cargo file"], ["call", "A call"],
  ["dispute", "A dispute"]];
const PAYEE_KINDS: [string, string][] = [
  ["company", "A company"], ["driver", "A driver"], ["staff", "A staff member"],
  ["other", "Somebody else, named here"]];
const SOURCE_KINDS: [string, string][] = [
  ["manual", "The office's own pen"], ["refund", "A signed refund paper"],
  ["payroll", "A payroll run"], ["wallet_withdrawal", "A holder's withdrawal"],
  ["cost", "A cost the office settled"]];
const INFLOWS: [string, string][] = [["bank", "The office's bank"], ["cash", "The office's till"],
  ["gateway", "The gateway line (TZS only)"]];

/** The definer answers an account as a row, a posting as a detail object and — on a board — as a bare
 *  code. A panel that assumed one of the three prints `undefined` for the other two, so both are
 *  asked for. */
const codeOf = (v: any) => (typeof v === "string" ? v : v?.code ?? "");
const refOf = (v: any) => (typeof v === "string" ? v : v?.ref ?? "");
const day = (v?: string | null) => (v ? new Date(v).toLocaleDateString() : "—");
const words = (s?: string | null) => String(s ?? "").replace(/_/g, " ");

function Pill({ v }: { v: any }) {
  const s = String(v ?? "none");
  const bad = /^(failed|declined|frozen|rejected|lapsed|revoked|expired|reversed|disagrees)$/.test(s);
  const good = /^(paid|released|discharged|closed|approved|applied|settled|open|held|square)$/.test(s);
  const wait = /^(pending|pending_signature|pending_discharge|awaiting|raised|in_review)$/.test(s);
  const c = bad ? "var(--danger)" : good ? "var(--success)" : wait ? "var(--adm-accent)"
    : "var(--ink-soft)";
  return <span className="whitespace-nowrap rounded-input px-8 py-4 text-[11px] font-semibold"
    style={{ color: c, background: `color-mix(in srgb, ${c} 12%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>{words(s)}</span>;
}

function Card({ title, note, right, children }: { title: string; note?: string;
  right?: any; children: any }) {
  return (
    <section className={card} style={{ borderColor: "var(--adm-line)" }}>
      <div className="mb-12 flex flex-wrap items-start justify-between gap-12">
        <div className="min-w-0">
          <h2 className="text-base font-bold" style={ink}>{title}</h2>
          {note && <p className="mt-4 max-w-[70ch] text-xs" style={soft}>{note}</p>}
        </div>
        {right && <div className="flex flex-wrap items-center gap-8">{right}</div>}
      </div>
      {children}
    </section>
  );
}

function Counters({ cells }: { cells: { k: string; v: string; s: string }[] }) {
  return (
    <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
      {cells.map(c => (
        <div key={c.k} className="rounded-card border p-12"
          style={{ borderColor: "var(--adm-line)" }}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>{c.k}</p>
          <p className="mt-4 text-lg font-bold" style={ink}>{c.v}</p>
          <p className="mt-4 text-[11px]" style={soft}>{c.s}</p>
        </div>
      ))}
    </div>
  );
}

function Pager({ count, returned, offset, onOffset }: { count: number; returned: number;
  offset: number; onOffset: (n: number) => void }) {
  if (count === 0) return null;
  const size = Math.max(returned, 1);
  return (
    <div className="mt-12 flex flex-wrap items-center gap-8 text-[11px]" style={soft}>
      <span>{count === returned ? `${count} in all`
        : `${offset + 1}–${offset + returned} of ${count}`}</span>
      <button className={`${btn} px-8 py-4`} disabled={offset <= 0}
        style={offset <= 0 ? { opacity: 0.4 } : undefined}
        onClick={() => onOffset(Math.max(0, offset - size))}>Previous</button>
      <button className={`${btn} px-8 py-4`} disabled={offset + returned >= count}
        style={offset + returned >= count ? { opacity: 0.4 } : undefined}
        onClick={() => onOffset(offset + size)}>Next</button>
    </div>
  );
}

function Busy({ loading, err, empty }: { loading: boolean; err: string | null; empty: string }) {
  if (err) return <p className="mt-8 text-xs font-semibold" style={{ color: "var(--danger)" }}>{err}</p>;
  if (loading) return <p className="mt-8 text-xs" style={soft}>Reading the register…</p>;
  return <p className="mt-8 text-xs" style={soft}>{empty}</p>;
}

function Note({ children }: { children: any }) {
  return <p className="mt-8 text-[11px]" style={soft}>{children}</p>;
}

/** A filter typed into a box is committed a beat after it stops changing, so a stray letter cannot
 *  page the register — and the page a clerk is looking at never disagrees with the controls above it. */
function useCommitted<T>(value: T, ms = 260): T {
  const [sent, setSent] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSent(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return sent;
}

function useLatest<T>(v: T) {
  const r = useRef(v);
  useEffect(() => { r.current = v; });
  return r;
}

/** A board read, with its heading figures. `sums` is `held` for wallets and escrow and `due` for
 *  payouts: the register's own totals over every row the filters still name, not over the page. An
 *  empty path means the panel is closed and nothing is asked. */
function useBoard(desk: Desk, path: string) {
  const D = useLatest(desk);
  const [b, setB] = useState({ rows: [] as any[], count: 0, returned: 0, sums: [] as any[],
    loading: !!path, err: null as string | null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) { setB({ rows: [], count: 0, returned: 0, sums: [], loading: false, err: null }); return; }
    setB(s => ({ ...s, loading: true, err: null }));
    D.current.call(path, "GET")
      .then((j: any) => setB({ rows: j?.rows ?? [], count: Number(j?.count ?? 0),
        returned: Number(j?.returned ?? 0), sums: j?.held ?? j?.due ?? [], loading: false, err: null }))
      .catch((e: any) => setB(s => ({ ...s, loading: false, err: (e as Error).message })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick]);
  return { ...b, reload: () => setTick(t => t + 1) };
}

function useOne(desk: Desk, path: string | null) {
  const D = useLatest(desk);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) { setData(null); setErr(null); return; }
    setLoading(true);
    D.current.call(path, "GET")
      .then((j: any) => { setData(j); setErr(null); })
      .catch((e: any) => { setData(null); setErr((e as Error).message); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick]);
  return { data, err, loading, reload: () => setTick(t => t + 1) };
}

/** The signature a paper is waiting on, read off 121's register by the door. Nothing on this desk can
 *  move it along — Approvals is where the second seat signs. */
function Signature({ a }: { a: any }) {
  if (!a) {
    return <p className="mt-12 text-xs" style={soft}>No signature has been asked for on this paper.</p>;
  }
  return (
    <div className="mt-12 rounded-input border px-12 py-8 text-xs"
      style={{ borderColor: "var(--adm-line)", ...soft }}>
      <p className="font-semibold" style={ink}>
        The signature <Pill v={a.status} /> {a.action ?? ""}
      </p>
      <p className="mt-4">
        Asked for by {a.proposed_role ?? "a seat"} on {day(a.proposed_at)}
        {a.expires_at ? ` · it lapses ${day(a.expires_at)}` : ""}
      </p>
      {a.reason && <p className="mt-4">&ldquo;{a.reason}&rdquo;</p>}
      {a.decided_at && (
        <p className="mt-4">
          Answered by {a.decided_role ?? "a second seat"} on {day(a.decided_at)}
          {a.decided_note ? ` — &ldquo;${a.decided_note}&rdquo;` : ""}
        </p>
      )}
      {a.applied_at && <p className="mt-4">The book was written from it on {day(a.applied_at)}.</p>}
      <Note>A second seat signs this on Approvals. The desk that asked cannot sign its own paper.</Note>
    </div>
  );
}

function Picker({ title, rows, pick, cols, empty }: { title: string; rows: any[];
  pick: (r: any) => void; cols: (r: any) => (string | null | undefined)[]; empty: string }) {
  return (
    <div className="mt-8 rounded-input border px-12 py-8" style={cellStyle}>
      <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>{title}</p>
      {rows.length === 0 && <p className="text-xs" style={soft}>{empty}</p>}
      {rows.map((r, i) => {
        const bits = cols(r).filter(Boolean) as string[];
        return (
          <button key={r.id ?? i} type="button" onClick={() => pick(r)}
            className="block w-full border-b px-4 py-6 text-left text-xs last:border-0 hover:underline"
            style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>
            {bits[0]}
            <span style={soft}>{bits.slice(1).map(b => ` · ${b}`).join("")}</span>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// wallets
// ============================================================

function Wallets({ desk, onWithdraw }: { desk: Desk; onWithdraw: (w: any) => void }) {
  const [f, setF] = useState({ status: "all", currency: "", search: "", offset: 0 });
  const sent = useCommitted(f);
  const board = useBoard(desk, `/control/money/wallets?limit=60&offset=${sent.offset}`
    + `&status=${sent.status}`
    + (sent.currency ? `&currency=${sent.currency}` : "")
    + (sent.search.trim() ? `&search=${encodeURIComponent(sent.search.trim())}` : ""));
  const [picked, setPicked] = useState<string | null>(null);
  const detail = useOne(desk, picked ? `/control/money/wallets/${picked}` : null);
  const w = detail.data;

  const [showOpen, setShowOpen] = useState(false);
  const [open, setOpen] = useState({ search: "", owner: "", ownerName: "", currency: "TZS", note: "" });
  const owners = useBoard(desk, showOpen
    ? `/control/money/payees?kind=company&limit=20`
      + (open.search.trim() ? `&search=${encodeURIComponent(open.search.trim())}` : "")
    : "");
  const [fund, setFund] = useState({ amount: "", from: "bank", memo: "", posted_on: "" });
  const [move, setMove] = useState({ to: "", amount: "", memo: "", posted_on: "" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const memo = (s: string) => s.trim().length >= 8 && s.trim().length <= 200;
  const figure = (s: string) => !Number.isNaN(desk.cents(s)) && desk.cents(s) > 0;

  async function write(key: string, fn: () => Promise<any>, then: (j: any) => string) {
    setBusy(key); setArmed(null);
    try {
      const j = await fn();
      board.reload(); detail.reload();
      desk.notify(then(j));
      return j;
    } catch (e) { desk.fault((e as Error).message); return null; } finally { setBusy(null); }
  }
  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  const held = (board.sums as any[]).map(h => ({
    k: `${h.currency} with holders`, v: desk.fig(h.held),
    s: `${h.wallets} wallet(s)${h.frozen ? `, ${h.frozen} stopped` : ""}`
  }));
  const drifted = (board.rows as any[]).filter(r => Number(r.drift ?? 0) !== 0);

  return (
    <>
      <Card title="Wallets"
        note="A holder's balance is a liability line in the office's own book, counted from its legs — the total the account keeps is printed beside it, because a column a trigger forgot to update is not the money.">
        <div className="mb-12 grid gap-8 sm:grid-cols-4">
          <label><span className={labelCls} style={soft}>State</span>
            <select className={cell} style={cellStyle} value={f.status}
              onChange={e => setF(x => ({ ...x, status: e.target.value, offset: 0 }))}>
              {["all", "open", "frozen"].map(k => <option key={k} value={k}>{k}</option>)}
            </select></label>
          <label><span className={labelCls} style={soft}>Money</span>
            <select className={cell} style={cellStyle} value={f.currency}
              onChange={e => setF(x => ({ ...x, currency: e.target.value, offset: 0 }))}>
              {CURRENCIES.map(k => <option key={k} value={k || "any"}>{k || "any"}</option>)}
            </select></label>
          <label><span className={labelCls} style={soft}>Holder or note</span>
            <input className={cell} style={cellStyle} value={f.search}
              onChange={e => setF(x => ({ ...x, search: e.target.value, offset: 0 }))} /></label>
          <div className="flex items-end gap-8">
            <button className={btn} onClick={() => board.reload()}>Re-read</button>
            {desk.can.pay && (
              <button className={btn} onClick={() => setShowOpen(o => !o)}>
                {showOpen ? "Close" : "Open a wallet"}
              </button>)}
          </div>
        </div>
        {!desk.can.pay && (
          <p className="mb-12 text-xs" style={soft}>
            This seat reads a holder&rsquo;s balance but does not hold <code>control.money.pay</code>,
            so it cannot put money in or move it between holders. Stopping a wallet is a third duty
            again — see the panel under a wallet.
          </p>
        )}

        {showOpen && desk.can.pay && (
          <div className="mb-16 rounded-card border p-16"
            style={{ borderColor: "var(--adm-line)", background: "var(--surface)" }}>
            <p className="mb-12 text-sm font-semibold" style={ink}>A holder the office keeps money for</p>
            <label><span className={labelCls} style={soft}>Find the company</span>
              <input className={cell} style={cellStyle} value={open.search}
                placeholder="Two letters at least"
                onChange={e => setOpen(x => ({ ...x, search: e.target.value }))} /></label>
            {!open.owner ? (
              <Picker title="Pick the company the wallet belongs to" rows={owners.rows}
                cols={r => [r.name, r.detail, r.can_wallet ? null
                  : "the door refuses this one — only a live transporter or shipper holds a wallet"]}
                empty="Type two letters of a company name, or the office has none to hold money."
                pick={r => setOpen(x => ({ ...x, owner: r.id, ownerName: r.name }))} />
            ) : (
              <p className="mt-8 text-xs" style={ink}>
                Holder: <strong>{open.ownerName}</strong>{" "}
                <button className="underline" style={soft} type="button"
                  onClick={() => setOpen(x => ({ ...x, owner: "", ownerName: "" }))}>change</button>
              </p>
            )}
            <div className="mt-12 grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={soft}>Money</span>
                <select className={cell} style={cellStyle} value={open.currency}
                  onChange={e => setOpen(x => ({ ...x, currency: e.target.value }))}>
                  <option value="TZS">TZS</option><option value="USD">USD</option>
                </select></label>
              <label><span className={labelCls} style={soft}>What it is for (8–600, optional)</span>
                <input className={cell} style={cellStyle} value={open.note}
                  placeholder="Balances carried from the old float sheet"
                  onChange={e => setOpen(x => ({ ...x, note: e.target.value }))} /></label>
            </div>
            <button className={`${btn} mt-12`} disabled={busy === "open" || !open.owner
              || (open.note.trim().length > 0 && open.note.trim().length < 8)}
              onClick={() => void write("open", () => desk.call("/control/money/wallets", "POST", {
                owner_tenant: open.owner, currency: open.currency,
                note: open.note.trim() || undefined
              }), j => `${j.wallet?.holder ?? open.ownerName} has a ${j.wallet?.currency ?? open.currency} wallet on ${codeOf(j.wallet?.account)}.`)
                .then(j => j && setOpen(x => ({ ...x, owner: "", ownerName: "", note: "" })))}>
              {busy === "open" ? "Opening…" : "Open it"}
            </button>
            <Note>
              One company, one money, one balance: the line&rsquo;s code is built from the two, so a
              second wallet for the same holder is refused rather than silently splitting a balance.
            </Note>
          </div>
        )}

        {held.length > 0 && <Counters cells={held} />}
        {drifted.length > 0 && (
          <div className="mb-12 rounded-input px-12 py-8 text-sm" role="alert"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)",
              borderLeft: "4px solid var(--danger)" }}>
            {drifted.length === 1 ? "One wallet line" : `${drifted.length} wallet lines`} whose cached
            total disagrees with their own legs: {drifted.map(r => codeOf(r.account)).join(", ")}. The
            balance column is the truth until 135 puts the trigger right.
          </div>
        )}

        {board.rows.length === 0
          ? <Busy loading={board.loading} err={board.err}
            empty="No wallet the office holds matches these filters." />
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] border-collapse text-xs">
                <thead><tr style={soft}>
                  {["Holder", "Money", "Balance (legs)", "Cached", "Legs", "Holds", "Withdrawals",
                    "State", ""].map(h => (
                    <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {board.rows.map((r: any) => (
                    <tr key={r.id} style={picked === r.id
                      ? { background: "color-mix(in srgb, var(--adm-accent) 10%, transparent)" }
                      : undefined}>
                      <td className={td} style={ink}>
                        <button className="font-semibold hover:underline" style={ink}
                          onClick={() => setPicked(p => (p === r.id ? null : r.id))}>
                          {r.holder}
                        </button>
                        <p style={soft}>{r.owner_type} · {codeOf(r.account)}</p>
                      </td>
                      <td className={td}>{r.currency}</td>
                      <td className={td} style={ink}>{desk.fig(r.balance)}</td>
                      <td className={td}>
                        {desk.fig(r.cached)}
                        {Number(r.drift ?? 0) !== 0 && (
                          <p style={{ color: "var(--danger)" }}>out by {desk.fig(r.drift)}</p>)}
                      </td>
                      <td className={td}>{r.legs}</td>
                      <td className={td}>{r.holds}</td>
                      <td className={td}>{r.withdrawals}</td>
                      <td className={td}>
                        <Pill v={r.status} />
                        {r.frozen_reason && <p style={soft}>{r.frozen_reason}</p>}
                      </td>
                      <td className={td}>
                        <button className={`${btn} px-8 py-4`}
                          onClick={() => setPicked(p => (p === r.id ? null : r.id))}>
                          {picked === r.id ? "Close" : "Open"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <Pager count={board.count} returned={board.returned} offset={sent.offset}
          onOffset={n => setF(x => ({ ...x, offset: n }))} />
      </Card>

      {picked && (
        <Card title={w ? `${w.holder} — a ${w.currency} wallet` : "The wallet"}
          note="The balance is counted from the legs on this holder's own line. The movements below are the last twelve that made it, each with its own reference."
          right={w && <Pill v={w.status} />}>
        {detail.loading && <p className="text-xs" style={soft}>Reading the line…</p>}
        {detail.err && (
          <p className="text-xs font-semibold" style={{ color: "var(--danger)" }}>{detail.err}</p>)}
        {w && (
          <>
            <Counters cells={[
              { k: "Balance", v: `${desk.fig(w.balance)} ${w.currency}`, s: `on ${codeOf(w.account)}` },
              { k: "Owner", v: w.owner_name ?? "—", s: words(w.owner_type) },
              { k: "Opened", v: day(w.opened_at), s: w.opened_by ?? "—" },
              { k: "Stopped", v: w.frozen_at ? day(w.frozen_at) : "never",
                s: w.frozen_by ?? w.frozen_reason ?? "" }
            ]} />

            <div className="grid gap-12 lg:grid-cols-3">
              {desk.can.pay && (
                <div className="rounded-input border p-12" style={cellStyle}>
                  <p className="mb-8 text-sm font-semibold" style={ink}>Put money in</p>
                  <label><span className={labelCls} style={soft}>Amount</span>
                    <input className={cell} style={cellStyle} value={fund.amount}
                      placeholder="150000"
                      onChange={e => setFund(x => ({ ...x, amount: e.target.value }))} /></label>
                  <label className="mt-8 block"><span className={labelCls} style={soft}>From</span>
                    <select className={cell} style={cellStyle} value={fund.from}
                      onChange={e => setFund(x => ({ ...x, from: e.target.value }))}>
                      {INFLOWS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select></label>
                  <label className="mt-8 block"><span className={labelCls} style={soft}>
                    Why the holder was topped up (8–200)
                  </span>
                    <input className={cell} style={cellStyle} value={fund.memo}
                      placeholder="Float called in on CS-2026-000114"
                      onChange={e => setFund(x => ({ ...x, memo: e.target.value }))} /></label>
                  <label className="mt-8 block"><span className={labelCls} style={soft}>
                    Day it is booked on</span>
                    <input type="date" className={cell} style={cellStyle} value={fund.posted_on}
                      onChange={e => setFund(x => ({ ...x, posted_on: e.target.value }))} /></label>
                  {Number(w.balance) < 0 && (
                    <p className="mt-8 text-[11px] font-semibold" style={{ color: "var(--danger)" }}>
                      This line is overdrawn by {desk.fig(Math.abs(Number(w.balance)))} {w.currency}.
                      The door books what you type; it does not refuse a negative balance, so check the
                      figure against the receipt first.
                    </p>
                  )}
                  <button className={`${btn} mt-12`}
                    disabled={busy !== null || !figure(fund.amount) || !memo(fund.memo)}
                    style={armed === `fund:${w.id}:${fund.amount}:${fund.from}:${fund.memo}:${fund.posted_on}`
                      ? { background: "var(--danger)", color: "#fff" } : undefined}
                    onClick={arm(`fund:${w.id}:${fund.amount}:${fund.from}:${fund.memo}:${fund.posted_on}`,
                      () => void write("fund", () => desk.call(`/control/money/wallets/${w.id}/fund`,
                        "POST", {
                          amount: fund.amount.trim(), from: fund.from, memo: fund.memo.trim(),
                          posted_on: fund.posted_on || undefined
                        }, { "Idempotency-Key": desk.mint() }), j => j.replayed
                        ? `${refOf(j.posting)} was already booked under this key — the balance is ${desk.fig(j.wallet?.balance ?? w.balance)} ${w.currency} and nothing was added twice.`
                        : `${refOf(j.posting)}: ${desk.fig(j.wallet?.balance ?? w.balance)} ${w.currency} now with ${w.holder}.`)
                        .then(j => j && setFund(x => ({ ...x, amount: "", memo: "" }))))}>
                    {busy === "fund" ? "Booking…"
                      : armed === `fund:${w.id}:${fund.amount}:${fund.from}:${fund.memo}:${fund.posted_on}`
                        ? "Tap again — this books a movement" : "Fund it"}
                  </button>
                  <Note>
                    Money the gateway has only reported waits on the gateway line until 135 reconciles
                    it, and a gateway inflow is TZS only.
                  </Note>
                </div>
              )}

              {desk.can.pay && (
                <div className="rounded-input border p-12" style={cellStyle}>
                  <p className="mb-8 text-sm font-semibold" style={ink}>Pay another holder</p>
                  <label><span className={labelCls} style={soft}>To</span>
                    <select className={cell} style={cellStyle} value={move.to}
                      onChange={e => setMove(x => ({ ...x, to: e.target.value }))}>
                      <option value="">Pick a holder</option>
                      {board.rows.filter((r: any) => r.id !== w.id && r.status === "open"
                        && r.currency === w.currency).map((r: any) => (
                        <option key={r.id} value={r.id}>{r.holder} — {desk.fig(r.balance)}</option>
                      ))}
                    </select></label>
                  <label className="mt-8 block"><span className={labelCls} style={soft}>Amount</span>
                    <input className={cell} style={cellStyle} value={move.amount}
                      onChange={e => setMove(x => ({ ...x, amount: e.target.value }))} /></label>
                  <label className="mt-8 block"><span className={labelCls} style={soft}>Why (8–200)</span>
                    <input className={cell} style={cellStyle} value={move.memo}
                      placeholder="Settled the Dar→Mwanza leg by hand"
                      onChange={e => setMove(x => ({ ...x, memo: e.target.value }))} /></label>
                  <label className="mt-8 block"><span className={labelCls} style={soft}>Day</span>
                    <input type="date" className={cell} style={cellStyle} value={move.posted_on}
                      onChange={e => setMove(x => ({ ...x, posted_on: e.target.value }))} /></label>
                  <button className={`${btn} mt-12`}
                    disabled={busy !== null || !move.to || !figure(move.amount) || !memo(move.memo)}
                    style={armed === `move:${w.id}:${move.to}:${move.amount}:${move.memo}:${move.posted_on}`
                      ? { background: "var(--danger)", color: "#fff" } : undefined}
                    onClick={arm(`move:${w.id}:${move.to}:${move.amount}:${move.memo}:${move.posted_on}`,
                      () => void write("move", () => desk.call("/control/money/wallets/move", "POST", {
                        from_wallet: w.id, to_wallet: move.to, amount: move.amount.trim(),
                        memo: move.memo.trim(), posted_on: move.posted_on || undefined
                      }, { "Idempotency-Key": desk.mint() }), j => j.replayed
                        ? `${refOf(j.posting)} was already booked under this key; nothing moved twice.`
                        : `${refOf(j.posting)}: ${desk.fig(move.amount)} ${w.currency} from ${w.holder} to ${j.to?.holder ?? "the other holder"}, whose balance is now ${desk.fig(j.to?.balance)}.`)
                        .then(j => j && setMove(x => ({ ...x, to: "", amount: "", memo: "" }))))}>
                    {busy === "move" ? "Moving…"
                      : armed === `move:${w.id}:${move.to}:${move.amount}:${move.memo}:${move.posted_on}`
                        ? "Tap again — no money leaves the office" : "Move it"}
                  </button>
                  <Note>
                    One holder paying another inside the office&rsquo;s own book: both sides of the
                    movement are liability lines, so the office&rsquo;s total out does not change.
                  </Note>
                </div>
              )}

              <div className="rounded-input border p-12" style={cellStyle}>
                <p className="mb-8 text-sm font-semibold" style={ink}>
                  {w.status === "frozen" ? "Start this wallet again" : "Stop this wallet"}
                </p>
                <label><span className={labelCls} style={soft}>
                  {w.status === "frozen"
                    ? "Reason, if you have one (optional)"
                    : "Why it is stopped — 8 characters at least"}
                </span>
                  <input className={cell} style={cellStyle} value={reason}
                    placeholder="Withdrawal held pending the dispute answer"
                    onChange={e => setReason(e.target.value)} /></label>
                <button className={`${btn} mt-12`}
                  disabled={busy !== null || !desk.can.escrow
                    || (w.status !== "frozen" && reason.trim().length < 8)}
                  onClick={() => void write("freeze", () => desk.call(
                    `/control/money/wallets/${w.id}/${w.status === "frozen" ? "unfreeze" : "freeze"}`,
                    "POST", w.status === "frozen" && !reason.trim() ? {} : { reason: reason.trim() }
                  ), () => w.status === "frozen"
                    ? `${w.holder}'s wallet is open again. The reason lives in the history, not on the wallet.`
                    : `${w.holder}'s wallet is stopped. No movement passes it until a seat lifts it.`)
                    .then(j => j && setReason(""))}>
                  {busy === "freeze" ? "Working…"
                    : w.status === "frozen" ? "Lift the stop" : "Stop it"}
                </button>
                {!desk.can.escrow && (
                  <Note>
                    Stopping a holder&rsquo;s money needs <code>control.money.escrow</code> — the duty
                    that adjudicates a job, not the one that holds a pen.
                  </Note>
                )}
                <Note>
                  The wallet and its book line are stopped together, because the guard that actually
                  refuses a movement is 133&rsquo;s leg check on the account.
                </Note>
              </div>
            </div>

            <div className="mt-16 grid gap-16 lg:grid-cols-3">
              <div>
                <p className="mb-8 text-sm font-semibold" style={ink}>The last twelve movements</p>
                {(w.movements ?? []).length === 0
                  ? <p className="text-xs" style={soft}>Nothing has passed this line yet.</p>
                  : (w.movements ?? []).map((m: any, i: number) => (
                    <p key={`${m.ref}-${i}`} className="border-b py-6 text-xs"
                      style={{ borderColor: "var(--adm-line)" }}>
                      <span className="font-semibold" style={{ color: m.direction === "credit"
                        ? "var(--success)" : "var(--danger)" }}>
                        {m.direction === "credit" ? "+" : "−"}{desk.fig(m.amount)}
                      </span>{" "}{m.posted_on} · {m.ref} · {m.memo}
                      {m.posting_status !== "posted" && <> <Pill v={m.posting_status} /></>}
                    </p>
                  ))}
              </div>
              <div>
                <p className="mb-8 text-sm font-semibold" style={ink}>Holds it is a party to</p>
                {(w.holds ?? []).length === 0
                  ? <p className="text-xs" style={soft}>No money is parked against this holder.</p>
                  : (w.holds ?? []).map((hh: any) => (
                    <p key={hh.id} className="border-b py-6 text-xs"
                      style={{ borderColor: "var(--adm-line)" }}>
                      <span className="font-semibold" style={ink}>{hh.ref}</span> · {hh.side} ·{" "}
                      {desk.fig(hh.amount)} {hh.currency} · {hh.subject_ref} <Pill v={hh.status} />
                    </p>
                  ))}
              </div>
              <div>
                <p className="mb-8 text-sm font-semibold" style={ink}>
                  Withdrawal payouts on this wallet
                </p>
                {(w.withdrawals ?? []).length === 0
                  ? <p className="text-xs" style={soft}>No payout stands on this wallet yet.</p>
                  : (w.withdrawals ?? []).map((pp: any) => (
                    <p key={pp.id} className="border-b py-6 text-xs"
                      style={{ borderColor: "var(--adm-line)" }}>
                      <span className="font-semibold" style={ink}>{pp.ref}</span> ·{" "}
                      {desk.fig(pp.amount)} {pp.currency} · {pp.rail} · {day(pp.raised_at)}{" "}
                      <Pill v={pp.status} />
                    </p>
                  ))}
                {desk.can.pay && w.status === "open" && (
                  <button className={`${btn} mt-8`}
                    onClick={() => {
                      onWithdraw({ walletId: w.id, holder: w.holder,
                        ownerTenantId: w.owner_tenant_id, currency: w.currency,
                        balance: w.balance });
                      desk.go("payouts");
                    }}>
                    Raise a withdrawal payout for this holder
                  </button>
                )}
              </div>
            </div>
          </>
        )}
        </Card>
      )}
    </>
  );
}

// ============================================================
// escrow
// ============================================================

function Escrow({ desk }: { desk: Desk }) {
  const [f, setF] = useState({ status: "pending_discharge", currency: "", subject_kind: "", offset: 0 });
  const sent = useCommitted(f);
  const board = useBoard(desk, `/control/money/escrow?limit=60&offset=${sent.offset}`
    + `&status=${sent.status}`
    + (sent.currency ? `&currency=${sent.currency}` : "")
    + (sent.subject_kind ? `&subject_kind=${sent.subject_kind}` : ""));
  const wallets = useBoard(desk, "/control/money/wallets?limit=200&status=open");
  const [picked, setPicked] = useState<string | null>(null);
  const detail = useOne(desk, picked ? `/control/money/escrow/${picked}` : null);
  const h = detail.data;

  const [showRaise, setShowRaise] = useState(false);
  const [sub, setSub] = useState({ kind: "call", search: "", id: "", ref: "" });
  const subjects = useBoard(desk, showRaise
    ? `/control/money/subjects?kind=${sub.kind}&limit=20`
      + (sub.search.trim() ? `&search=${encodeURIComponent(sub.search.trim())}` : "")
    : "");
  const [raise, setRaise] = useState({ amount: "", currency: "TZS", payer_wallet: "",
    from: "bank", reason_code: "complaint", reason: "", posted_on: "" });
  const [plan, setPlan] = useState({ kind: "split", to_payee: "", back_to_payer: "",
    fee_amount: "0", payee_wallet: "", reason: "" });
  const [refuse, setRefuse] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const sentence = (s: string) => s.trim().length >= 8 && s.trim().length <= 600;
  const figure = (s: string) => !Number.isNaN(desk.cents(s)) && desk.cents(s) >= 0;
  const heldC = h ? desk.cents(String(h.amount)) : 0;
  const planC = (plan.kind === "refunded"
    ? desk.cents(plan.back_to_payer || "0") + desk.cents(plan.fee_amount || "0")
    : desk.cents(plan.to_payee || "0") + desk.cents(plan.back_to_payer || "0")
      + desk.cents(plan.fee_amount || "0"));
  const planWhole = Number.isFinite(planC) && planC === heldC && planC > 0;

  async function write(key: string, fn: () => Promise<any>, then: (j: any) => string) {
    setBusy(key); setArmed(null);
    try {
      const j = await fn();
      board.reload(); detail.reload(); wallets.reload();
      desk.notify(then(j));
      return j;
    } catch (e) { desk.fault((e as Error).message); return null; } finally { setBusy(null); }
  }
  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  const open = h && String(h.approval?.status ?? "") === "pending";

  return (
    <>
      <Card title="Money parked against a job"
        note="A hold is raised by the seat that adjudicates a job and ended by a plan a second seat signs. The money sits on an escrow line until then, and the figures under the filters count every hold the register names — not the page.">
        <div className="mb-12 grid gap-8 sm:grid-cols-4">
          <label><span className={labelCls} style={soft}>State</span>
            <select className={cell} style={cellStyle} value={f.status}
              onChange={e => setF(x => ({ ...x, status: e.target.value, offset: 0 }))}>
              {["pending_discharge", "held", "discharged", "all"].map(k => (
                <option key={k} value={k}>{words(k)}</option>))}
            </select></label>
          <label><span className={labelCls} style={soft}>Money</span>
            <select className={cell} style={cellStyle} value={f.currency}
              onChange={e => setF(x => ({ ...x, currency: e.target.value, offset: 0 }))}>
              {CURRENCIES.map(k => <option key={k} value={k || "any"}>{k || "any"}</option>)}
            </select></label>
          <label><span className={labelCls} style={soft}>Kind of job</span>
            <select className={cell} style={cellStyle} value={f.subject_kind}
              onChange={e => setF(x => ({ ...x, subject_kind: e.target.value, offset: 0 }))}>
              <option value="">any</option>
              {SUBJECT_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select></label>
          <div className="flex items-end gap-8">
            <button className={btn} onClick={() => board.reload()}>Re-read</button>
            {desk.can.escrow && (
              <button className={btn} onClick={() => setShowRaise(o => !o)}>
                {showRaise ? "Close" : "Park money"}
              </button>)}
          </div>
        </div>
        <p className="mb-12 text-xs" style={soft}>
          A hold is <em>held</em> from the moment its movement is booked, in the same call that made it,
          so there is no <em>raised</em> page to look at.
        </p>
        {!desk.can.escrow && (
          <p className="mb-12 text-xs" style={soft}>
            Parking money against a job needs <code>control.money.escrow</code>. This seat reads the
            holds but cannot raise, plan or refuse one.
          </p>
        )}

        {showRaise && desk.can.escrow && (
          <div className="mb-16 rounded-card border p-16"
            style={{ borderColor: "var(--adm-line)", background: "var(--surface)" }}>
            <p className="mb-12 text-sm font-semibold" style={ink}>What the money waits on</p>
            <div className="grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={soft}>The job is</span>
                <select className={cell} style={cellStyle} value={sub.kind}
                  onChange={e => setSub({ kind: e.target.value, search: "", id: "", ref: "" })}>
                  {SUBJECT_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></label>
              <label><span className={labelCls} style={soft}>Search that register</span>
                <input className={cell} style={cellStyle} value={sub.search}
                  placeholder="Two letters at least"
                  onChange={e => setSub(x => ({ ...x, search: e.target.value }))} /></label>
            </div>
            {!sub.id ? (
              <Picker title="Pick the job the money waits on" rows={subjects.rows}
                cols={x => [x.ref ?? x.id, x.subject ?? x.what, x.company, words(x.status),
                  x.can_hold ? null : "this one names no job — the guard would refuse it"]}
                empty="Nothing in that register matches. A deleted row is not a job, and a one-letter search is every job the office has ever had."
                pick={x => setSub(y => ({ ...y, id: x.id, ref: x.ref }))} />
            ) : (
              <p className="mt-8 text-xs" style={ink}>
                Waiting on <strong>{sub.ref}</strong>{" "}
                <button className="underline" style={soft} type="button"
                  onClick={() => setSub(x => ({ ...x, id: "", ref: "" }))}>change</button>
              </p>
            )}
            <div className="mt-12 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
              <label><span className={labelCls} style={soft}>Amount</span>
                <input className={cell} style={cellStyle} value={raise.amount}
                  onChange={e => setRaise(x => ({ ...x, amount: e.target.value }))} /></label>
              <label><span className={labelCls} style={soft}>Money</span>
                <select className={cell} style={cellStyle} value={raise.currency}
                  onChange={e => setRaise(x => ({ ...x, currency: e.target.value }))}>
                  <option value="TZS">TZS</option><option value="USD">USD</option>
                </select></label>
              <label><span className={labelCls} style={soft}>Out of whose wallet</span>
                <select className={cell} style={cellStyle} value={raise.payer_wallet}
                  onChange={e => setRaise(x => ({ ...x, payer_wallet: e.target.value }))}>
                  <option value="">the office&rsquo;s own line</option>
                  {wallets.rows.filter((r: any) => r.currency === raise.currency).map((r: any) => (
                    <option key={r.id} value={r.id}>{r.holder} — {desk.fig(r.balance)}</option>
                  ))}
                </select></label>
              <label><span className={labelCls} style={soft}>…or parked from</span>
                <select className={cell} style={cellStyle} value={raise.from}
                  disabled={!!raise.payer_wallet}
                  onChange={e => setRaise(x => ({ ...x, from: e.target.value }))}>
                  {[["bank", "The office's bank"], ["cash", "The office's till"]].map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>))}
                </select></label>
            </div>
            <div className="mt-12 grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={soft}>Reason code</span>
                <select className={cell} style={cellStyle} value={raise.reason_code}
                  onChange={e => setRaise(x => ({ ...x, reason_code: e.target.value }))}>
                  {REASONS.map(k => <option key={k} value={k}>{words(k)}</option>)}
                </select></label>
              <label><span className={labelCls} style={soft}>Day it is booked on</span>
                <input type="date" className={cell} style={cellStyle} value={raise.posted_on}
                  onChange={e => setRaise(x => ({ ...x, posted_on: e.target.value }))} /></label>
            </div>
            <label className="mt-12 block"><span className={labelCls} style={soft}>
              Why the money is held — 8 to 600 characters, in the words the caller is owed
            </span>
              <textarea className={cell} style={cellStyle} rows={2} value={raise.reason}
                onChange={e => setRaise(x => ({ ...x, reason: e.target.value }))} /></label>
            <button className={`${btn} mt-12`}
              disabled={busy !== null || !sub.id || !figure(raise.amount)
                || desk.cents(raise.amount) <= 0 || !sentence(raise.reason)}
              style={armed === ["raise", sub.id, raise.amount, raise.currency, raise.payer_wallet,
                raise.from, raise.reason_code, raise.reason, raise.posted_on].join(":")
                ? { background: "var(--danger)", color: "#fff" } : undefined}
              onClick={arm(["raise", sub.id, raise.amount, raise.currency, raise.payer_wallet,
                raise.from, raise.reason_code, raise.reason, raise.posted_on].join(":"),
                () => void write("raise", () => desk.call("/control/money/escrow", "POST", {
                  subject_kind: sub.kind, subject_id: sub.id, amount: raise.amount.trim(),
                  currency: raise.currency, payer_wallet: raise.payer_wallet || undefined,
                  from: raise.payer_wallet ? undefined : raise.from,
                  reason_code: raise.reason_code, reason: raise.reason.trim(),
                  posted_on: raise.posted_on || undefined
                }, { "Idempotency-Key": desk.mint() }), j => {
                  const hold = j.hold ?? {};
                  return `${hold.ref ?? "A hold"} parks ${desk.fig(hold.amount ?? raise.amount)} ${hold.currency ?? raise.currency} against ${hold.subject_ref ?? sub.ref} — booked by ${refOf(j.posting)}.`;
                })
                  .then(() => { setShowRaise(false); setSub(x => ({ ...x, id: "", ref: "" })); }))}>
              {busy === "raise" ? "Parking…"
                : armed?.startsWith("raise:") ? "Tap again — this books the hold in the book"
                  : "Park it"}
            </button>
            <Note>
              A job holds at most one live paper. Press this twice on a job that is already held and the
              answer names that hold&rsquo;s reference, its figure and its state.
            </Note>
          </div>
        )}

        {board.sums.length > 0 && <Counters cells={(board.sums as any[]).map(x => ({
          k: `${x.currency} parked`, v: desk.fig(x.held),
          s: `${x.holds} hold(s)${x.awaiting ? ` · ${x.awaiting} never booked` : ""}` }))} />}

        {board.rows.length === 0
          ? <Busy loading={board.loading} err={board.err}
            empty="Nothing is parked against a job under these filters." />
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-xs">
                <thead><tr style={soft}>
                  {["Hold", "State", "Money", "Waiting on", "Payer → payee", "Plan", "Signature",
                    "Raised", ""].map(x => (
                    <th key={x} className={th} style={{ borderColor: "var(--adm-line)" }}>{x}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {board.rows.map((r: any) => (
                    <tr key={r.id} style={picked === r.id
                      ? { background: "color-mix(in srgb, var(--adm-accent) 10%, transparent)" }
                      : undefined}>
                      <td className={td} style={ink}>
                        <button className="font-semibold hover:underline" style={ink}
                          onClick={() => setPicked(p => (p === r.id ? null : r.id))}>{r.ref}</button>
                        <p style={soft}>{words(r.reason_code)}</p>
                      </td>
                      <td className={td}><Pill v={r.status} /></td>
                      <td className={td}>{desk.fig(r.amount)} {r.currency}</td>
                      <td className={td}>
                        {r.subject_ref}
                        <p style={soft}>{words(r.subject_kind)}
                          {r.subject_name ? ` · ${r.subject_name}` : ""}</p>
                        {r.subject_note && <p style={soft}>{r.subject_note}</p>}
                      </td>
                      <td className={td}>
                        {r.payer ?? codeOf(r.from_account) ?? "the office"}
                        <p style={soft}>→ {r.payee ?? codeOf(r.into_account)}</p>
                      </td>
                      <td className={td}>
                        {r.plan ? (
                          <>
                            <p>{words(r.plan.kind)}</p>
                            <p style={soft}>{desk.fig(r.plan.to_payee)} out ·{" "}
                              {desk.fig(r.plan.back_to_payer)} back · fee {desk.fig(r.plan.fee)}</p>
                          </>
                        ) : <span style={soft}>no plan</span>}
                      </td>
                      <td className={td}>{r.approval ? <Pill v={r.approval} /> : <span style={soft}>—</span>}</td>
                      <td className={td}>{day(r.raised_at)}
                        <p style={soft}>{r.raised_by ?? ""}</p></td>
                      <td className={td}>
                        <button className={`${btn} px-8 py-4`}
                          onClick={() => setPicked(p => (p === r.id ? null : r.id))}>
                          {picked === r.id ? "Close" : "Open"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <Pager count={board.count} returned={board.returned} offset={sent.offset}
          onOffset={n => setF(x => ({ ...x, offset: n }))} />
      </Card>

      {picked && (
        <Card title={h ? `${h.ref} — ${desk.fig(h.amount)} ${h.currency} held` : "The hold"}
          note="A plan says what happens to the money when the job is answered. It is put up here and signed on Approvals; a refused plan leaves the money parked and has to be planned again."
          right={h && <Pill v={h.status} />}>
        {detail.loading && <p className="text-xs" style={soft}>Reading the paper…</p>}
        {detail.err && (
          <p className="text-xs font-semibold" style={{ color: "var(--danger)" }}>{detail.err}</p>
        )}
        {h && (
          <>
            <Counters cells={[
              { k: "Held", v: `${desk.fig(h.amount)} ${h.currency}`, s: `on ${codeOf(h.into)}` },
              { k: "Payer", v: h.payer_wallet?.holder ?? "the office",
                s: h.payer_wallet
                  ? `${words(h.payer_wallet.status)} · balance ${desk.fig(h.payer_wallet.balance)}`
                  : `parked from ${codeOf(h.from)}` },
              { k: "Payee wallet", v: h.payee_wallet?.holder ?? "not named yet",
                s: h.payee_wallet ? words(h.payee_wallet.status) : "a plan names it" },
              { k: "Plan adds to", v: `${desk.fig(h.plan_total)} ${h.currency}`,
                s: h.plan_agrees ? "the whole of the money held"
                  : "not the money held — the door refuses it" }
            ]} />
            <p className="mt-8 text-xs" style={soft}>
              {words(h.subject_kind)} {h.subject_ref}: &ldquo;{h.reason}&rdquo;
            </p>
            {Number(h.refusals ?? 0) > 0 && (
              <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>
                {h.refusals} plan(s) refused. The last answer, from {h.refused_by_name ?? "a seat"} on{" "}
                {day(h.refused_at)}: &ldquo;{h.refused_note}&rdquo;
              </p>
            )}
            <p className="mt-8 text-xs" style={soft}>
              {h.hold_posting && <>The hold is booked by {refOf(h.hold_posting)}. </>}
              {h.discharge_posting && <>It was discharged by {refOf(h.discharge_posting)}.</>}
            </p>

            <Signature a={h.approval} />

            {desk.can.escrow && (h.status === "held" || h.status === "pending_discharge") && (
              <div className="mt-16 grid gap-16 lg:grid-cols-2">
                <div className="rounded-input border p-12" style={cellStyle}>
                  <p className="mb-8 text-sm font-semibold" style={ink}>
                    {h.discharge_kind ? "Put a new plan on it" : "Plan its end"}
                  </p>
                  <label><span className={labelCls} style={soft}>The money is</span>
                    <select className={cell} style={cellStyle} value={plan.kind}
                      onChange={e => setPlan(x => ({ ...x, kind: e.target.value }))}>
                      <option value="released">released to a payee</option>
                      <option value="refunded">refunded to the holder it came from</option>
                      <option value="split">split: some out, some back, a fee</option>
                    </select></label>
                  <div className="mt-8 grid gap-8 sm:grid-cols-3">
                    {plan.kind !== "refunded" && (
                      <label><span className={labelCls} style={soft}>To the payee</span>
                        <input className={cell} style={cellStyle} value={plan.to_payee}
                          onChange={e => setPlan(x => ({ ...x, to_payee: e.target.value }))} /></label>)}
                    <label><span className={labelCls} style={soft}>Back to the payer</span>
                      <input className={cell} style={cellStyle} value={plan.back_to_payer}
                        onChange={e => setPlan(x => ({ ...x, back_to_payer: e.target.value }))} /></label>
                    <label><span className={labelCls} style={soft}>Fee the office keeps</span>
                      <input className={cell} style={cellStyle} value={plan.fee_amount}
                        onChange={e => setPlan(x => ({ ...x, fee_amount: e.target.value }))} /></label>
                  </div>
                  {plan.kind !== "refunded" && (
                    <label className="mt-8 block">
                      <span className={labelCls} style={soft}>Which wallet takes the money</span>
                      <select className={cell} style={cellStyle} value={plan.payee_wallet}
                        onChange={e => setPlan(x => ({ ...x, payee_wallet: e.target.value }))}>
                        <option value="">Pick a holder</option>
                        {wallets.rows.filter((r: any) => r.currency === h.currency).map((r: any) => (
                          <option key={r.id} value={r.id}>{r.holder} — {desk.fig(r.balance)}</option>
                        ))}
                      </select></label>
                  )}
                  <label className="mt-8 block"><span className={labelCls} style={soft}>
                    The plan in the words the second seat signs — 8 to 600
                  </span>
                    <textarea className={cell} style={cellStyle} rows={2} value={plan.reason}
                      onChange={e => setPlan(x => ({ ...x, reason: e.target.value }))} /></label>
                  <p className="mt-8 text-xs font-semibold"
                    style={{ color: planWhole ? "var(--success)" : "var(--danger)" }}>
                    {desk.fig(planC / 100)} of {desk.fig(h.amount)} —{" "}
                    {planWhole ? "the three figures are the whole of the money held."
                      : "the three figures have to be the whole of the money held, to the unit."}
                  </p>
                  <button className={`${btn} mt-8`}
                    disabled={busy !== null || !planWhole || !sentence(plan.reason)
                      || (plan.kind !== "refunded" && !plan.payee_wallet)}
                    onClick={() => void write("plan", () => desk.call(
                      `/control/money/escrow/${h.id}/plan`, "POST", {
                        kind: plan.kind,
                        to_payee: plan.kind === "refunded" ? undefined : plan.to_payee.trim() || "0",
                        back_to_payer: plan.back_to_payer.trim() || "0",
                        fee_amount: plan.fee_amount.trim() || "0",
                        payee_wallet: plan.kind === "refunded" ? undefined : plan.payee_wallet,
                        reason: plan.reason.trim()
                      }), j => `${j.ref ?? h.ref}: ${words(j.discharge_kind ?? plan.kind)} plan is up for a second seat to sign, and lapses ${day(j.expires_at)}.`)
                      .then(j => j && setPlan(x => ({ ...x, reason: "" })))}>
                    {busy === "plan" ? "Putting it up…" : "Put the plan up for signature"}
                  </button>
                  <Note>
                    Nothing moves here. The discharge runs when the signature is spent, in 121&rsquo;s
                    order: decide, claim, apply, settle.
                  </Note>
                </div>

                <div className="rounded-input border p-12" style={cellStyle}>
                  <p className="mb-8 text-sm font-semibold" style={ink}>Say no to the plan</p>
                  <p className="mb-8 text-xs" style={soft}>
                    The signature is answered first and the paper stamped from the answer, so a plan
                    cannot be refused here and left standing open on Approvals. The money stays parked.
                  </p>
                  <label><span className={labelCls} style={soft}>Why — 8 to 600 characters</span>
                    <textarea className={cell} style={cellStyle} rows={2} value={refuse}
                      onChange={e => setRefuse(e.target.value)} /></label>
                  <button className={`${btn} mt-8`}
                    disabled={busy !== null || !sentence(refuse) || !open}
                    onClick={() => void write("refuse", () => desk.call(
                      `/control/money/escrow/${h.id}/refuse`, "POST", { note: refuse.trim() }),
                      j => `${h.ref}: plan refused (${j.refusals} now on this hold) and the signature closed. The money stays parked.`)
                      .then(j => j && setRefuse(""))}>
                    {busy === "refuse" ? "Refusing…" : "Refuse this plan"}
                  </button>
                  {!open && (
                    <Note>There is no plan standing open on this hold to refuse.</Note>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        </Card>
      )}
    </>
  );
}

// ============================================================
// payouts
// ============================================================

function Payouts({ desk, draft, draftUsed }: { desk: Desk; draft: any; draftUsed: () => void }) {
  const [f, setF] = useState({ status: "all", currency: "", payee_kind: "", rail: "",
    search: "", offset: 0 });
  const sent = useCommitted(f);
  const filters = `status=${sent.status}`
    + (sent.currency ? `&currency=${sent.currency}` : "")
    + (sent.payee_kind ? `&payee_kind=${sent.payee_kind}` : "")
    + (sent.rail ? `&rail=${sent.rail}` : "")
    + (sent.search.trim() ? `&search=${encodeURIComponent(sent.search.trim())}` : "");
  const board = useBoard(desk, `/control/money/payouts?limit=60&offset=${sent.offset}&${filters}`);
  const rails = useBoard(desk, "/control/money/rails");
  const batches = useBoard(desk, "/control/money/batches?limit=200&status=open");
  const [picked, setPicked] = useState<string | null>(null);
  const detail = useOne(desk, picked ? `/control/money/payouts/${picked}` : null);
  const p = detail.data;
  const [line, setLine] = useState<any>(null);
  const [lineErr, setLineErr] = useState<string | null>(null);
  const [lineBusy, setLineBusy] = useState(false);

  const [showRaise, setShowRaise] = useState(false);
  const [payee, setPayee] = useState({ kind: "company", search: "", id: "", name: "" });
  const payees = useBoard(desk, showRaise && payee.kind !== "other"
    ? `/control/money/payees?kind=${payee.kind}&limit=20`
      + (payee.search.trim() ? `&search=${encodeURIComponent(payee.search.trim())}` : "")
    : "");
  const [r, setR] = useState({ rail: "mpesa", payee_line: "", amount: "", fee_amount: "0",
    currency: "TZS", source_kind: "manual", source_id: "", source_ref: "", purpose: "",
    batch_id: "" });
  // Two separate boxes, because one field that is sometimes a filter and sometimes the value the
  // paper carries is a desk that loses what it typed the moment the list answers.
  const [refFind, setRefFind] = useState("");
  const refSent = useCommitted(refFind);
  const [paste, setPaste] = useState("");
  const refunds = useBoard(desk, showRaise && r.source_kind === "refund"
    ? `/control/service/refunds?limit=20&status=released`
      + (refSent.trim() ? `&search=${encodeURIComponent(refSent.trim())}` : "")
    : "");
  const [paper, setPaper] = useState({ reason: "", note: "", decline: "", posted_on: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const sentence = (s: string) => s.trim().length >= 8 && s.trim().length <= 600;
  const figure = (s: string) => !Number.isNaN(desk.cents(s)) && desk.cents(s) >= 0;
  const railRow = (rails.rows as any[]).find(x => x.code === r.rail);
  const needs = railRow?.needs ?? (r.rail === "bank" ? "account"
    : r.rail === "cash" ? "none" : "phone");

  async function write(key: string, fn: () => Promise<any>, then: (j: any) => string) {
    setBusy(key); setArmed(null);
    try {
      const j = await fn();
      board.reload(); detail.reload(); batches.reload();
      desk.notify(then(j));
      return j;
    } catch (e) { desk.fault((e as Error).message); return null; } finally { setBusy(null); }
  }
  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  // A withdrawal handed over from the wallets panel arrives as the shape of the paper, not as a
  // completed one: the figure and the line the money travels on stay the clerk's to type.
  useEffect(() => {
    if (!draft) return;
    setShowRaise(true);
    setPayee({ kind: "company", search: "", id: draft.ownerTenantId ?? "", name: draft.holder ?? "" });
    setR(x => ({ ...x, currency: draft.currency ?? x.currency, source_kind: "wallet_withdrawal",
      source_id: draft.walletId ?? "",
      purpose: x.purpose || `Paying ${draft.holder ?? "the holder"} out of their own wallet.` }));
    desk.notify(`${draft.holder}: name the rail and the line the money travels on, then raise the paper.`);
    draftUsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // The pasted id belongs to the refund branch only. A typed id carried over onto a payroll or a
  // withdrawal paper would book a payout standing on the wrong document.
  const sourceId = r.source_kind === "refund" && !r.source_id ? paste.trim() : r.source_id;
  const sourceOk = r.source_kind === "manual"
    || (r.source_kind === "cost" ? r.source_ref.trim().length >= 3 : !!sourceId);
  const canRaise = desk.can.pay
    && (payee.kind === "other" ? payee.name.trim().length >= 2 : !!payee.id)
    && !!r.rail && figure(r.amount) && desk.cents(r.amount) > 0 && figure(r.fee_amount)
    && (needs === "none" ? !r.payee_line.trim() : r.payee_line.trim().length >= 4)
    && sentence(r.purpose) && sourceOk;

  return (
    <>
      <Card title="Money the office owes out"
        note="A payout is raised as a draft, signed by a second seat, accrued when the signature is spent, and answered on the day the cash actually goes. A failed one is answered by its mirror: the office owed the money, tried to pay it, and the book keeps both facts.">
        <div className="mb-12 grid gap-8 sm:grid-cols-3 lg:grid-cols-6">
          <label><span className={labelCls} style={soft}>State</span>
            <select className={cell} style={cellStyle} value={f.status}
              onChange={e => setF(x => ({ ...x, status: e.target.value, offset: 0 }))}>
              {["all", "raised", "pending_signature", "released", "paid", "failed", "declined"]
                .map(k => <option key={k} value={k}>{words(k)}</option>)}
            </select></label>
          <label><span className={labelCls} style={soft}>Money</span>
            <select className={cell} style={cellStyle} value={f.currency}
              onChange={e => setF(x => ({ ...x, currency: e.target.value, offset: 0 }))}>
              {CURRENCIES.map(k => <option key={k} value={k || "any"}>{k || "any"}</option>)}
            </select></label>
          <label><span className={labelCls} style={soft}>Payee kind</span>
            <select className={cell} style={cellStyle} value={f.payee_kind}
              onChange={e => setF(x => ({ ...x, payee_kind: e.target.value, offset: 0 }))}>
              <option value="">any</option>
              {PAYEE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select></label>
          <label><span className={labelCls} style={soft}>Rail</span>
            <select className={cell} style={cellStyle} value={f.rail}
              onChange={e => setF(x => ({ ...x, rail: e.target.value, offset: 0 }))}>
              <option value="">any</option>
              {(rails.rows as any[]).filter(x => !x.retired).map((x: any) => (
                <option key={x.code} value={x.code}>{x.label}</option>))}
            </select></label>
          <label><span className={labelCls} style={soft}>Ref, payee or purpose</span>
            <input className={cell} style={cellStyle} value={f.search}
              onChange={e => setF(x => ({ ...x, search: e.target.value, offset: 0 }))} /></label>
          <div className="flex items-end gap-8">
            <button className={btn} onClick={() => board.reload()}>Re-read</button>
            <button className={btn} onClick={() => void desk.download(
              `/control/money/payouts.csv?${filters}`, `payouts-${desk.today()}.csv`)}>CSV</button>
            {desk.can.pay && (
              <button className={btn} onClick={() => setShowRaise(o => !o)}>
                {showRaise ? "Close" : "Raise a payout"}
              </button>)}
          </div>
        </div>
        {!desk.can.pay && (
          <p className="mb-12 text-xs" style={soft}>
            This seat reads the register but does not hold <code>control.money.pay</code>, so it cannot
            raise, sign off, confirm or fail a payout.
          </p>
        )}
        <p className="mb-12 text-xs" style={soft}>
          The CSV carries the last four digits of a payee line, never the line: a sheet that leaves the
          office is read by whoever picks it up.
        </p>

        {showRaise && desk.can.pay && (
          <div className="mb-16 rounded-card border p-16"
            style={{ borderColor: "var(--adm-line)", background: "var(--surface)" }}>
            <p className="mb-12 text-sm font-semibold" style={ink}>Who is owed, and on what line</p>
            <div className="grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={soft}>The payee is</span>
                <select className={cell} style={cellStyle} value={payee.kind}
                  onChange={e => setPayee({ kind: e.target.value, search: "", id: "", name: "" })}>
                  {PAYEE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></label>
              {payee.kind === "other" ? (
                <label><span className={labelCls} style={soft}>
                  Their name, as the receipt carries it</span>
                  <input className={cell} style={cellStyle} value={payee.name}
                    onChange={e => setPayee(x => ({ ...x, name: e.target.value }))} /></label>
              ) : (
                <label><span className={labelCls} style={soft}>Search the register</span>
                  <input className={cell} style={cellStyle} value={payee.search}
                    placeholder="Two letters at least"
                    onChange={e => setPayee(x => ({ ...x, search: e.target.value }))} /></label>
              )}
            </div>
            {payee.kind !== "other" && !payee.id && (
              <Picker title="Pick the payee" rows={payees.rows}
                cols={x => [x.name, x.company, x.detail]}
                empty="Nobody in that register matches, or the search is still too short. Somebody the office has no paper for is `somebody else, named here`."
                pick={x => setPayee(y => ({ ...y, id: x.id, name: x.name }))} />
            )}
            {payee.id && (
              <p className="mt-8 text-xs" style={ink}>
                Paying <strong>{payee.name}</strong>{" "}
                <button className="underline" style={soft} type="button"
                  onClick={() => setPayee(x => ({ ...x, id: "", name: "" }))}>change</button>
              </p>
            )}

            <div className="mt-12 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
              <label><span className={labelCls} style={soft}>Rail</span>
                <select className={cell} style={cellStyle} value={r.rail}
                  onChange={e => setR(x => ({ ...x, rail: e.target.value, payee_line: "" }))}>
                  {(rails.rows as any[]).filter(x => !x.retired).map((x: any) => (
                    <option key={x.code} value={x.code}>{x.label}</option>))}
                </select></label>
              <label><span className={labelCls} style={soft}>Amount</span>
                <input className={cell} style={cellStyle} value={r.amount}
                  onChange={e => setR(x => ({ ...x, amount: e.target.value }))} /></label>
              <label><span className={labelCls} style={soft}>Fee</span>
                <input className={cell} style={cellStyle} value={r.fee_amount}
                  onChange={e => setR(x => ({ ...x, fee_amount: e.target.value }))} /></label>
              <label><span className={labelCls} style={soft}>Money</span>
                <select className={cell} style={cellStyle} value={r.currency}
                  onChange={e => setR(x => ({ ...x, currency: e.target.value }))}>
                  <option value="TZS">TZS</option><option value="USD">USD</option>
                </select></label>
            </div>
            {needs !== "none" && (
              <label className="mt-12 block"><span className={labelCls} style={soft}>
                Their {needs === "phone" ? "phone number on the rail" : "bank account"} — encrypted on
                the way in, only the last four are ever shown
              </span>
                <input className={cell} style={cellStyle} value={r.payee_line} autoComplete="off"
                  spellCheck={false}
                  placeholder={needs === "phone" ? "07… or +255 7…" : "as the bank printed it"}
                  onChange={e => setR(x => ({ ...x, payee_line: e.target.value }))} /></label>
            )}
            {needs === "none" && (
              <p className="mt-8 text-xs" style={soft}>
                That rail hands the money over at the desk, so the paper carries no number — a cash
                payout with a line on it is a number read out to the wrong person.
              </p>
            )}

            <div className="mt-12 grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={soft}>What it stands for</span>
                <select className={cell} style={cellStyle} value={r.source_kind}
                  onChange={e => setR(x => ({ ...x, source_kind: e.target.value, source_id: "" }))}>
                  {SOURCE_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></label>
              <label><span className={labelCls} style={soft}>Carried on a batch, if any</span>
                <select className={cell} style={cellStyle} value={r.batch_id}
                  onChange={e => setR(x => ({ ...x, batch_id: e.target.value }))}>
                  <option value="">on its own paper</option>
                  {(batches.rows as any[]).filter(x => x.currency === r.currency).map((x: any) => (
                    <option key={x.id} value={x.id}>{x.ref} — {x.label}</option>))}
                </select></label>
            </div>
            {r.source_kind === "refund" && (
              <>
                {!r.source_id ? (
                  <>
                    <label className="mt-8 block"><span className={labelCls} style={soft}>
                      Find the paper by its CS- or DP- ref, or by the company it owes</span>
                      <input className={cell} style={cellStyle} value={refFind}
                        onChange={e => setRefFind(e.target.value)} /></label>
                    <Picker title="Released refund papers" rows={refunds.rows}
                      cols={x => [x.ref, `${desk.fig(x.amount)} ${x.currency}`, x.company_name,
                        words(x.request_status)]}
                      empty={refunds.err
                        ?? "No released refund paper answers to that. A refund has to be signed by a second seat before a payout can stand on it."}
                      pick={x => { setPaste(""); setR(y => ({ ...y, source_id: x.id,
                        amount: y.amount || String(x.amount),
                        currency: x.currency ?? y.currency })); }} />
                    {refunds.err && (
                      <label className="mt-8 block"><span className={labelCls} style={soft}>
                        This seat cannot read the service register, so paste the paper&rsquo;s id</span>
                        <input className={cell} style={cellStyle} value={paste}
                          onChange={e => setPaste(e.target.value)} /></label>
                    )}
                  </>
                ) : (
                  <p className="mt-8 text-xs" style={ink}>
                    Stands on refund{" "}
                    <strong>{(refunds.rows as any[]).find((x: any) => x.id === r.source_id)?.ref
                      ?? r.source_id}</strong>{" "}
                    <button className="underline" style={soft} type="button"
                      onClick={() => { setR(x => ({ ...x, source_id: "" })); setPaste(""); }}>change</button>
                  </p>
                )}
              </>
            )}
            {(r.source_kind === "payroll" || r.source_kind === "wallet_withdrawal") && (
              <>
                <label className="mt-8 block"><span className={labelCls} style={soft}>
                  The {r.source_kind === "payroll" ? "payroll run" : "wallet"}&rsquo;s id</span>
                  <input className={cell} style={cellStyle} value={r.source_id}
                    onChange={e => setR(x => ({ ...x, source_id: e.target.value }))} /></label>
                <Note>
                  {r.source_kind === "payroll"
                    ? "The office has no control read of a company's payroll runs, so the run's id is copied off the payroll desk. The door refuses a payout bigger than the run issued."
                    : "A withdrawal drains the holder's own wallet line. Pick the wallet on the Wallets tab and use its button, or paste the wallet's id here."}
                </Note>
              </>
            )}
            {r.source_kind === "cost" && (
              <label className="mt-8 block"><span className={labelCls} style={soft}>
                The reference the office keeps on the cost (3–60)</span>
                <input className={cell} style={cellStyle} value={r.source_ref}
                  onChange={e => setR(x => ({ ...x, source_ref: e.target.value }))} /></label>
            )}

            <label className="mt-12 block"><span className={labelCls} style={soft}>
              What it is for — 8 to 600 characters
            </span>
              <textarea className={cell} style={cellStyle} rows={2} value={r.purpose}
                onChange={e => setR(x => ({ ...x, purpose: e.target.value }))} /></label>

            <button className={`${btn} mt-12`} disabled={busy !== null || !canRaise}
              onClick={() => void write("raise", () => desk.call("/control/money/payouts", "POST", {
                payee_kind: payee.kind,
                payee_id: payee.kind === "other" ? undefined : payee.id || undefined,
                payee_name: payee.kind === "other" ? payee.name.trim() : undefined,
                rail: r.rail,
                payee_line: needs === "none" ? undefined : r.payee_line.trim() || undefined,
                amount: r.amount.trim(), fee_amount: r.fee_amount.trim() || "0",
                currency: r.currency, source_kind: r.source_kind,
                source_id: sourceId || undefined,
                source_ref: r.source_ref.trim() || undefined,
                purpose: r.purpose.trim(), batch_id: r.batch_id || undefined
              }), j => `${j.payout?.ref ?? "The paper"} drafted: ${desk.fig(j.payout?.amount ?? r.amount)} ${j.payout?.currency ?? r.currency} to ${j.payout?.payee_name ?? "the payee"}, on ${(rails.rows as any[]).find((x: any) => x.code === r.rail)?.label ?? r.rail}. It waits on a second seat.`)
                .then(j => j && setShowRaise(false))}>
              {busy === "raise" ? "Drafting…" : "Raise the paper"}
            </button>
            <Note>
              Nothing moves and nothing is owed yet: this writes a draft. Ask for the signature from the
              row once it is in the register.
            </Note>
          </div>
        )}

        {board.sums.length > 0 && <Counters cells={(board.sums as any[]).map(x => ({
          k: `${x.currency} owed out`, v: desk.fig(x.due),
          s: `${x.released} released · ${x.awaiting} awaiting signature · ${x.failed} failed` }))} />}

        {board.rows.length === 0
          ? <Busy loading={board.loading} err={board.err}
            empty="No payout paper under these filters." />
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1020px] border-collapse text-xs">
                <thead><tr style={soft}>
                  {["Payout", "State", "Payee", "Rail", "Amount", "Fee", "Total", "Stands on",
                    "Batch", "Signature", "Paid", ""].map(x => (
                    <th key={x} className={th} style={{ borderColor: "var(--adm-line)" }}>{x}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {board.rows.map((row: any) => (
                    <tr key={row.id} style={picked === row.id
                      ? { background: "color-mix(in srgb, var(--adm-accent) 10%, transparent)" }
                      : undefined}>
                      <td className={td} style={ink}>
                        <button className="font-semibold hover:underline" style={ink}
                          onClick={() => { setPicked(x => (x === row.id ? null : row.id)); setLine(null); setLineErr(null); }}>
                          {row.ref}
                        </button>
                      </td>
                      <td className={td}><Pill v={row.status} /></td>
                      <td className={td}>
                        {row.payee_name}
                        <p style={soft}>{words(row.payee_kind)}</p>
                      </td>
                      <td className={td}>
                        {row.rail_label}
                        <p style={soft}>{row.line_tail ? `•••• ${row.line_tail}`
                          : row.line_sealed ? "line sealed" : "no line"}</p>
                      </td>
                      <td className={td}>{desk.fig(row.amount)}</td>
                      <td className={td}>{desk.fig(row.fee)}</td>
                      <td className={td}>{desk.fig(row.total)} {row.currency}</td>
                      <td className={td}>
                        {words(row.source_kind)}
                        {row.source_ref && <p style={soft}>{row.source_ref}</p>}
                      </td>
                      <td className={td}>{row.batch ?? "—"}</td>
                      <td className={td}>{row.approval ? <Pill v={row.approval} />
                        : <span style={soft}>—</span>}</td>
                      <td className={td}>{row.paid_at ? day(row.paid_at) : "—"}</td>
                      <td className={td}>
                        <button className={`${btn} px-8 py-4`}
                          onClick={() => { setPicked(x => (x === row.id ? null : row.id)); setLine(null); setLineErr(null); }}>
                          {picked === row.id ? "Close" : "Open"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <Pager count={board.count} returned={board.returned} offset={sent.offset}
          onOffset={n => setF(x => ({ ...x, offset: n }))} />
      </Card>

      {picked && (
        <Card title={p ? `${p.ref} — ${desk.fig(p.amount)} ${p.currency} to ${p.payee_name}` : "The payout"}
          note="The three lines a paper uses — the expense or wallet it drains, the liability it owes, the cash that answers it — are chosen by the door from the money and the source, and a trigger refuses a set that is not this book's."
          right={p && <Pill v={p.status} />}>
        {detail.loading && <p className="text-xs" style={soft}>Reading the paper…</p>}
        {detail.err && (
          <p className="text-xs font-semibold" style={{ color: "var(--danger)" }}>{detail.err}</p>
        )}
        {p && (
          <>
            <Counters cells={[
              { k: "Amount", v: `${desk.fig(p.amount)} ${p.currency}`,
                s: `fee ${desk.fig(p.fee_amount)} · the payee's total ${desk.fig(p.total)}` },
              { k: "Owed on", v: codeOf(p.payable),
                s: `drains ${codeOf(p.fund)}, answered in ${codeOf(p.cash)}` },
              { k: "Rail", v: p.rail_label ?? "",
                s: `${words(p.rail_family)} · ${p.line_sealed ? `line •••• ${p.payee_ref_tail}`
                  : "no line was written"}` },
              { k: "Raised", v: day(p.raised_at), s: p.raised_by ?? "" }
            ]} />
            <p className="mt-8 text-xs" style={soft}>&ldquo;{p.purpose}&rdquo;</p>
            <p className="mt-4 text-xs" style={soft}>
              Stands for {words(p.source_kind)}
              {p.source_ref ? ` · reference on the paper: ${p.source_ref}` : ""}
              {p.source_id ? ` · id ${p.source_id}` : ""}
            </p>
            {p.source_paper && (
              <p className="mt-4 text-xs" style={soft}>
                The paper itself:{" "}
                {Object.entries(p.source_paper)
                  .map(([k, v]) => `${words(k)} ${String(v ?? "—")}`).slice(0, 4).join(" · ")}
              </p>
            )}
            {p.batch && (
              <p className="mt-4 text-xs" style={soft}>
                Carried by batch {p.batch.ref} — {p.batch.label} <Pill v={p.batch.status} />{" "}
                {Number(p.batch.lines) > 0 && `· ${p.batch.lines} line(s), ${desk.fig(p.batch.total_amount)} signed`}
              </p>
            )}
            {(p.accrual_posting || p.payment_posting) && (
              <p className="mt-4 text-xs" style={soft}>
                {p.accrual_posting && <>Obligation booked by {refOf(p.accrual_posting)} </>}
                {p.payment_posting && <>· cash answered by {refOf(p.payment_posting)}</>}
              </p>
            )}
            {p.paid_at && (
              <p className="mt-4 text-xs" style={soft}>
                Paid {day(p.paid_at)} by {p.paid_by ?? "a seat"} — &ldquo;{p.paid_note}&rdquo;
              </p>
            )}
            {p.failed_at && (
              <p className="mt-4 text-xs" style={{ color: "var(--danger)" }}>
                The rail said no on {day(p.failed_at)} — &ldquo;{p.failure_reason}&rdquo;. The accrual
                is answered by its own mirror.
              </p>
            )}
            {p.declined_at && (
              <p className="mt-4 text-xs" style={soft}>
                Declined {day(p.declined_at)} by {p.declined_by ?? "a second seat"}
                {p.declined_note ? ` — &ldquo;${p.declined_note}&rdquo;` : ""}. Nothing ever moved.
              </p>
            )}

            <Signature a={p.approval} />

            {desk.can.reveal && (
              <div className="mt-16 rounded-input border p-12" style={cellStyle}>
                <p className="mb-8 text-sm font-semibold" style={ink}>
                  The line the money travels on
                </p>
                {p.line_sealed ? (
                  <>
                    <button className={btn} disabled={lineBusy}
                      onClick={() => {
                        setLineBusy(true); setLineErr(null);
                        desk.call(`/control/money/payouts/${p.id}/line`, "GET")
                          .then(j => setLine(j))
                          .catch(e => { setLine(null); setLineErr((e as Error).message); })
                          .finally(() => setLineBusy(false));
                      }}>
                      {lineBusy ? "Opening…" : line ? "Open it again" : "Read the whole line"}
                    </button>
                    {line && (
                      <p className="mt-8 text-sm font-semibold" style={ink}>
                        {line.line}
                        <span className="ml-8 text-[11px] font-normal" style={soft}>
                          {line.rail_label} · {line.payee_name} · {desk.fig(line.amount)} {line.currency}
                        </span>
                      </p>
                    )}
                    {lineErr && (
                      <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>{lineErr}</p>)}
                    <Note>
                      Twelve openings an hour, and each one is written to the register with the seat and
                      the reference before the number comes back. It is for reading to a bank, not for
                      building a list.
                    </Note>
                  </>
                ) : (
                  <p className="text-xs" style={soft}>
                    {p.rail_label ?? "This rail"} hands the money over at the desk, so no line was ever
                    written on this paper.
                  </p>
                )}
              </div>
            )}

            {desk.can.pay && (
              <div className="mt-16 grid gap-16 lg:grid-cols-2">
                <div className="rounded-input border p-12" style={cellStyle}>
                  <p className="mb-8 text-sm font-semibold" style={ink}>The paper</p>
                  {(p.status === "raised" || p.status === "pending_signature") && (
                    <label><span className={labelCls} style={soft}>
                      {p.status === "raised"
                        ? "What you are asking the second seat to sign — 8 to 600"
                        : "Why this paper is answered no — 8 to 600"}
                    </span>
                      <textarea className={cell} style={cellStyle} rows={2}
                        value={p.status === "raised" ? paper.reason : paper.decline}
                        onChange={e => setPaper(x => ({ ...x,
                          [p.status === "raised" ? "reason" : "decline"]: e.target.value }))} /></label>
                  )}
                  {p.status === "raised" && (
                    <button className={`${btn} mt-8`}
                      disabled={busy !== null || !sentence(paper.reason)}
                      onClick={() => void write("propose", () => desk.call(
                        `/control/money/payouts/${p.id}/propose`, "POST",
                        { reason: paper.reason.trim() }),
                        j => `${j.ref ?? p.ref} stands on one signature (${j.approval_id?.slice(0, 8)}…), which lapses ${day(j.expires_at)}.`)
                        .then(j => j && setPaper(x => ({ ...x, reason: "" })))}>
                      {busy === "propose" ? "Asking…" : "Ask a second seat to sign"}
                    </button>
                  )}
                  {p.status === "pending_signature" && (
                    <button className={`${btn} mt-8`}
                      disabled={busy !== null || !sentence(paper.decline)}
                      onClick={() => void write("decline", () => desk.call(
                        `/control/money/payouts/${p.id}/decline`, "POST",
                        { note: paper.decline.trim() }),
                        () => `${p.ref} is declined. The signature was answered first, so nothing stands open.`)
                        .then(j => j && setPaper(x => ({ ...x, decline: "" })))}>
                      {busy === "decline" ? "Declining…" : "Say no to this paper"}
                    </button>
                  )}
                  {p.status === "pending_signature" && (
                    <Note>Nothing can be paid until the signature is spent on Approvals. The seat that
                      asked for it cannot answer it, so a paper carrying its own proposal is declined by
                      a second seat refusing it there.</Note>
                  )}
                  {p.status === "released" && (
                    <Note>The obligation is in the book. The cash is confirmed from the next box.</Note>
                  )}
                </div>

                <div className="rounded-input border p-12" style={cellStyle}>
                  <p className="mb-8 text-sm font-semibold" style={ink}>The cash</p>
                  <label><span className={labelCls} style={soft}>
                    What the payment was, in the words of the receipt — 8 to 600
                  </span>
                    <textarea className={cell} style={cellStyle} rows={2} value={paper.note}
                      onChange={e => setPaper(x => ({ ...x, note: e.target.value }))} /></label>
                  {p.status === "released" && (
                    <label className="mt-8 block"><span className={labelCls} style={soft}>
                      The day it actually went</span>
                      <input type="date" className={cell} style={cellStyle} value={paper.posted_on}
                        onChange={e => setPaper(x => ({ ...x, posted_on: e.target.value }))} /></label>
                  )}
                  <button className={`${btn} mt-8`}
                    disabled={busy !== null || p.status !== "released" || !sentence(paper.note)}
                    style={armed === `paid:${p.id}:${paper.note}:${paper.posted_on}`
                      ? { background: "var(--danger)", color: "#fff" } : undefined}
                    onClick={arm(`paid:${p.id}:${paper.note}:${paper.posted_on}`, () => void write("paid",
                      () => desk.call(`/control/money/payouts/${p.id}/paid`, "POST", {
                        note: paper.note.trim(), posted_on: paper.posted_on || undefined
                      }, { "Idempotency-Key": desk.mint() }),
                      j => `${p.ref} is paid: ${refOf(j.posting)} moves ${desk.fig(j.payout?.total ?? p.total)} ${p.currency} out of ${codeOf(j.payout?.cash ?? p.cash)}.`)
                      .then(j => j && setPaper(x => ({ ...x, note: "", posted_on: "" }))))}>
                    {busy === "paid" ? "Booking…"
                      : armed === `paid:${p.id}:${paper.note}:${paper.posted_on}`
                        ? "Tap again — this books the cash leaving" : "Confirm the cash went"}
                  </button>
                  <p className="mt-12 text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>
                    Or the rail said no
                  </p>
                  <label className="mt-4 block"><span className={labelCls} style={soft}>
                    What the rail answered — 8 to 600</span>
                    <input className={cell} style={cellStyle} value={paper.reason}
                      onChange={e => setPaper(x => ({ ...x, reason: e.target.value }))} /></label>
                  <button className={`${btn} mt-8`}
                    disabled={busy !== null || p.status !== "released" || !sentence(paper.reason)}
                    style={armed === `failed:${p.id}:${paper.reason}`
                      ? { background: "var(--danger)", color: "#fff" } : undefined}
                    onClick={arm(`failed:${p.id}:${paper.reason}`, () => void write("failed",
                      () => desk.call(`/control/money/payouts/${p.id}/failed`, "POST",
                        { reason: paper.reason.trim() }),
                      j => `${p.ref} is marked failed. ${refOf(j.reversal)} answers the accrual: the office owed the money, tried to pay it, and the book keeps both facts.`)
                      .then(j => j && setPaper(x => ({ ...x, reason: "" }))))}>
                    {busy === "failed" ? "Recording…"
                      : armed === `failed:${p.id}:${paper.reason}`
                        ? "Tap again — this books the mirror" : "Mark it failed"}
                  </button>
                  {p.status !== "released" && (
                    <Note>Only a released payout can be paid or failed — the money has to be owed first.</Note>
                  )}
                </div>
              </div>
            )}
          </>
        )}
        </Card>
      )}
    </>
  );
}

// ============================================================
// batches
// ============================================================

function Batches({ desk }: { desk: Desk }) {
  const [f, setF] = useState({ status: "all", currency: "", search: "", offset: 0 });
  const sent = useCommitted(f);
  const board = useBoard(desk, `/control/money/batches?limit=60&offset=${sent.offset}`
    + `&status=${sent.status}`
    + (sent.currency ? `&currency=${sent.currency}` : "")
    + (sent.search.trim() ? `&search=${encodeURIComponent(sent.search.trim())}` : ""));
  const [picked, setPicked] = useState<string | null>(null);
  const detail = useOne(desk, picked ? `/control/money/batches/${picked}` : null);
  const b = detail.data;

  const [showOpen, setShowOpen] = useState(false);
  const [open, setOpen] = useState({ label: "", currency: "TZS" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const sentence = (s: string) => s.trim().length >= 8 && s.trim().length <= 600;

  async function write(key: string, fn: () => Promise<any>, then: (j: any) => string) {
    setBusy(key);
    try {
      const j = await fn();
      board.reload(); detail.reload();
      desk.notify(then(j));
      return j;
    } catch (e) { desk.fault((e as Error).message); return null; } finally { setBusy(null); }
  }

  return (
    <>
      <Card title="Batches"
        note="A batch is a label and one money. Its total is never typed: it is copied off the lines standing under it at the moment the desk asks for a signature, and the trigger freezes it — so the figure a second seat signs is provably the set of lines it is signing over.">
        <div className="mb-12 grid gap-8 sm:grid-cols-4">
          <label><span className={labelCls} style={soft}>State</span>
            <select className={cell} style={cellStyle} value={f.status}
              onChange={e => setF(x => ({ ...x, status: e.target.value, offset: 0 }))}>
              {["all", "open", "pending_signature", "released", "closed"]
                .map(k => <option key={k} value={k}>{words(k)}</option>)}
            </select></label>
          <label><span className={labelCls} style={soft}>Money</span>
            <select className={cell} style={cellStyle} value={f.currency}
              onChange={e => setF(x => ({ ...x, currency: e.target.value, offset: 0 }))}>
              {CURRENCIES.map(k => <option key={k} value={k || "any"}>{k || "any"}</option>)}
            </select></label>
          <label><span className={labelCls} style={soft}>Ref or label</span>
            <input className={cell} style={cellStyle} value={f.search}
              onChange={e => setF(x => ({ ...x, search: e.target.value, offset: 0 }))} /></label>
          <div className="flex items-end gap-8">
            <button className={btn} onClick={() => board.reload()}>Re-read</button>
            {desk.can.pay && (
              <button className={btn} onClick={() => setShowOpen(o => !o)}>
                {showOpen ? "Close" : "Open a batch"}
              </button>)}
          </div>
        </div>

        {showOpen && desk.can.pay && (
          <div className="mb-16 grid gap-8 sm:grid-cols-[2fr_1fr_auto]">
            <label><span className={labelCls} style={soft}>What the batch is (3–80)</span>
              <input className={cell} style={cellStyle} value={open.label}
                placeholder="Driver payouts — October 2026"
                onChange={e => setOpen(x => ({ ...x, label: e.target.value }))} /></label>
            <label><span className={labelCls} style={soft}>Money</span>
              <select className={cell} style={cellStyle} value={open.currency}
                onChange={e => setOpen(x => ({ ...x, currency: e.target.value }))}>
                <option value="TZS">TZS</option><option value="USD">USD</option>
              </select></label>
            <div className="flex items-end">
              <button className={btn} disabled={busy !== null || open.label.trim().length < 3}
                onClick={() => void write("open", () => desk.call("/control/money/batches", "POST", {
                  label: open.label.trim(), currency: open.currency
                }), j => `${j.batch?.ref ?? "The batch"} is open for ${j.batch?.currency ?? open.currency} lines. Name the payouts it carries, then ask for one signature over them.`)
                  .then(j => j && setOpen(x => ({ ...x, label: "" })))}>
                {busy === "open" ? "Opening…" : "Open it"}
              </button>
            </div>
          </div>
        )}

        {board.rows.length === 0
          ? <Busy loading={board.loading} err={board.err}
            empty="No batch under these filters. Payouts can still be raised on their own paper." />
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] border-collapse text-xs">
                <thead><tr style={soft}>
                  {["Batch", "State", "Money", "Signed total", "Lines", "Paid", "Failed",
                    "Declined", "Still owed", "Signature", "Closed", ""].map(x => (
                    <th key={x} className={th} style={{ borderColor: "var(--adm-line)" }}>{x}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {board.rows.map((row: any) => (
                    <tr key={row.id} style={picked === row.id
                      ? { background: "color-mix(in srgb, var(--adm-accent) 10%, transparent)" }
                      : undefined}>
                      <td className={td} style={ink}>
                        <button className="font-semibold hover:underline" style={ink}
                          onClick={() => setPicked(x => (x === row.id ? null : row.id))}>
                          {row.ref}</button>
                        <p style={soft}>{row.label}</p>
                      </td>
                      <td className={td}><Pill v={row.status} /></td>
                      <td className={td}>{row.currency}</td>
                      <td className={td}>{desk.fig(row.total_amount)}</td>
                      <td className={td}>{row.lines}</td>
                      <td className={td}>{row.paid}</td>
                      <td className={td}>{row.failed}</td>
                      <td className={td}>{row.declined}</td>
                      <td className={td}>
                        <span style={Number(row.outstanding) > 0
                          ? { color: "var(--danger)" } : soft}>{row.outstanding}</span>
                        <p style={soft}>{desk.fig(row.paid_total)} paid</p>
                      </td>
                      <td className={td}>{row.approval ? <Pill v={row.approval} />
                        : <span style={soft}>—</span>}</td>
                      <td className={td}>{row.closed_at ? day(row.closed_at) : "—"}</td>
                      <td className={td}>
                        <button className={`${btn} px-8 py-4`}
                          onClick={() => setPicked(x => (x === row.id ? null : row.id))}>
                          {picked === row.id ? "Close" : "Open"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <Pager count={board.count} returned={board.returned} offset={sent.offset}
          onOffset={n => setF(x => ({ ...x, offset: n }))} />
      </Card>

      {picked && (
        <Card title={b ? `${b.ref} — ${b.label}` : "The batch"}
          note="A batch is finished when every line under it has answered. Nothing is booked here; the release runs from Approvals, across every line the one signature covers."
          right={b && <Pill v={b.status} />}>
        {detail.loading && <p className="text-xs" style={soft}>Reading the batch…</p>}
        {detail.err && (
          <p className="text-xs font-semibold" style={{ color: "var(--danger)" }}>{detail.err}</p>
        )}
        {b && (() => {
          const bs: any = b.by_status ?? {};
          const answered = Number(bs.paid ?? 0) + Number(bs.failed ?? 0) + Number(bs.declined ?? 0)
            + Number(bs.discharged ?? 0);
          const owed = Number(b.lines_now ?? 0) - answered;
          return (
            <>
              <Counters cells={[
                { k: "Signed total", v: `${desk.fig(b.signed_sum)} ${b.currency}`,
                  s: `its lines now add up to ${desk.fig(b.sum_now)}` },
                { k: "The two agree", v: b.figures_agree ? "yes" : "no",
                  s: b.figures_agree ? "the signature covers what stands under it"
                    : "a line moved after the total was frozen" },
                { k: "Lines", v: `${b.lines_now}`,
                  s: Object.entries(bs).map(([k, v]) => `${words(k)} ${v}`).join(" · ") || "none yet" },
                { k: "Raised", v: day(b.raised_at), s: b.raised_by_name ?? "" }
              ]} />
              {b.figures_agree === false && (
                <p className="mt-8 text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  The frozen total and the lines under it disagree. Ask for a signature again once the
                  register is steady — a seat cannot sign over figures that have moved.
                </p>
              )}
              {b.reason && <p className="mt-8 text-xs" style={soft}>&ldquo;{b.reason}&rdquo;</p>}
              {b.released_at && (
                <p className="mt-4 text-xs" style={soft}>
                  Released {day(b.released_at)} by {b.released_by_name ?? "a second seat"}.
                </p>
              )}
              {b.closed_at && (
                <p className="mt-4 text-xs" style={soft}>
                  Closed {day(b.closed_at)} by {b.closed_by_name ?? "a seat"} —
                  &ldquo;{b.closed_note}&rdquo;
                </p>
              )}

              <Signature a={b.approval} />

              <div className="mt-16 overflow-x-auto">
                <p className="mb-8 text-sm font-semibold" style={ink}>The lines it carries</p>
                {(b.payouts ?? []).length === 0
                  ? <p className="text-xs" style={soft}>
                    No line stands under this batch yet. Raise a payout and name it here.</p>
                  : (
                    <table className="w-full min-w-[760px] border-collapse text-xs">
                      <thead><tr style={soft}>
                        {["Payout", "State", "Payee", "Rail", "Line", "Total", "Paid"].map(x => (
                          <th key={x} className={th}
                            style={{ borderColor: "var(--adm-line)" }}>{x}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {(b.payouts ?? []).map((l: any) => (
                          <tr key={l.id}>
                            <td className={td} style={ink}>{l.ref}</td>
                            <td className={td}><Pill v={l.status} /></td>
                            <td className={td}>{l.payee_name}
                              <p style={soft}>{words(l.payee_kind)}</p></td>
                            <td className={td}>{l.rail}</td>
                            <td className={td}>{l.line_tail ? `•••• ${l.line_tail}` : "no line"}</td>
                            <td className={td}>{desk.fig(l.total)} {l.currency}</td>
                            <td className={td}>{l.paid_at ? day(l.paid_at) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              </div>

              {desk.can.pay && (
                <div className="mt-16 grid gap-16 lg:grid-cols-2">
                  <div className="rounded-input border p-12" style={cellStyle}>
                    <p className="mb-8 text-sm font-semibold" style={ink}>The signature</p>
                    <label><span className={labelCls} style={soft}>
                      {b.status === "pending_signature"
                        ? "Why you are refusing the whole batch — 8 to 600"
                        : "What the second seat is signing — 8 to 600"}
                    </span>
                      <textarea className={cell} style={cellStyle} rows={2} value={note}
                        onChange={e => setNote(e.target.value)} /></label>
                    {b.status === "open" ? (
                      <button className={`${btn} mt-8`}
                        disabled={busy !== null || !sentence(note) || Number(b.lines_now) === 0}
                        onClick={() => void write("propose", () => desk.call(
                          `/control/money/batches/${b.id}/propose`, "POST", { reason: note.trim() }),
                          j => `${j.ref ?? b.ref}: ${j.lines ?? b.lines_now} line(s), ${desk.fig(j.total_amount)} ${j.currency ?? b.currency} — one signature over all of them, lapsing ${day(j.expires_at)}.`)
                          .then(j => j && setNote(""))}>
                        {busy === "propose" ? "Asking…" : "Ask a second seat to sign the batch"}
                      </button>
                    ) : b.status === "pending_signature" ? (
                      <button className={`${btn} mt-8`}
                        disabled={busy !== null || !sentence(note)}
                        onClick={() => void write("decline", () => desk.call(
                          `/control/money/batches/${b.id}/decline`, "POST", { note: note.trim() }),
                          j => `${b.ref}: ${j.lines_declined} line(s) declined with it, and the paper is a draft again.`)
                          .then(j => j && setNote(""))}>
                        {busy === "decline" ? "Declining…" : "Say no to the whole batch"}
                      </button>
                    ) : (
                      <p className="mt-8 text-xs" style={soft}>
                        {b.status === "released"
                          ? "The batch is released: its lines are owed out and are confirmed one cash movement at a time on the Payouts tab."
                          : "This batch is closed. Nothing more can be put up under it."}
                      </p>
                    )}
                    {b.status === "open" && Number(b.lines_now) === 0 && (
                      <Note>A batch with no lines under it has nothing to sign.</Note>
                    )}
                    {b.status === "open" && (
                      <Note>
                        One signature over {b.lines_now} line(s). The lines carry no approval of their
                        own — that is exactly why two lines cannot each claim one signature.
                      </Note>
                    )}
                  </div>

                  <div className="rounded-input border p-12" style={cellStyle}>
                    <p className="mb-8 text-sm font-semibold" style={ink}>Close it</p>
                    <label><span className={labelCls} style={soft}>
                      The sentence on the closed batch — 8 to 600</span>
                      <textarea className={cell} style={cellStyle} rows={2} value={note}
                        onChange={e => setNote(e.target.value)} /></label>
                    <button className={`${btn} mt-8`}
                      disabled={busy !== null || !sentence(note) || b.status === "closed" || owed > 0}
                      onClick={() => void write("close", () => desk.call(
                        `/control/money/batches/${b.id}/close`, "POST", { note: note.trim() }),
                        () => `${b.ref} is closed with every line answered.`).then(j => j && setNote(""))}>
                      {busy === "close" ? "Closing…" : "Close the batch"}
                    </button>
                    <Note>
                      {owed > 0
                        ? `${owed} line(s) still owe an answer — paid, failed or declined. The door refuses to close a batch while one stands, and names it.`
                        : b.status === "closed"
                          ? "Already closed."
                          : "Every line under this batch has answered, so it can be closed."}
                    </Note>
                  </div>
                </div>
              )}
            </>
          );
        })()}
        </Card>
      )}
    </>
  );
}

// ============================================================
// the payable question, asked of the book and the papers separately
// ============================================================

function Payable({ desk }: { desk: Desk }) {
  const board = useBoard(desk, "/control/money/payable");
  const rows = board.rows as any[];
  const drift = rows.filter(r => Number(r.drift ?? 0) !== 0);
  const unaccounted = rows.filter(r => r.disagrees === true);
  return (
    <Card title="What the papers say the book owes"
      note="The escrow lines, the payout-due lines and the wallet lines: the balance counted from the legs, the total the account keeps, and the holds or released payouts counted off the registers. Three separate answers to one question, printed side by side.">
      <div className="mb-12 flex flex-wrap items-center gap-8">
        <button className={btn} onClick={() => board.reload()}>Re-read</button>
        <span className="text-xs" style={soft}>
          {board.loading ? "asking the book…" : `${rows.length} line(s) · ${drift.length} cached wrong · ${unaccounted.length} the papers cannot account for`}
        </span>
      </div>
      {rows.length === 0
        ? <Busy loading={board.loading} err={board.err}
          empty="Nothing to ask yet: no wallet, escrow or payable line carries a figure." />
        : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-xs">
              <thead><tr style={soft}>
                {["Line", "What it holds", "Money", "From legs", "Cached", "Papers", "Papers n",
                  "Legs vs cached", "Legs vs papers"].map(x => (
                  <th key={x} className={th} style={{ borderColor: "var(--adm-line)" }}>{x}</th>
                ))}
              </tr></thead>
              <tbody>
                {rows.map((row: any) => (
                  <tr key={row.account}>
                    <td className={td} style={ink}><strong>{row.account}</strong>
                      <p style={soft}>{words(row.kind)}</p></td>
                    <td className={td} style={soft}>{row.what}</td>
                    <td className={td}>{row.currency}</td>
                    <td className={td}>{desk.fig(row.book)}</td>
                    <td className={td}>
                      {desk.fig(row.cached)}
                      {Number(row.drift ?? 0) !== 0 && (
                        <p style={{ color: "var(--danger)" }}>out by {desk.fig(row.drift)}</p>)}
                    </td>
                    <td className={td}>{row.papers === null
                      ? <span style={soft}>not asked</span> : desk.fig(row.papers)}</td>
                    <td className={td}>{row.papers_n}</td>
                    <td className={td}><Pill v={Number(row.drift ?? 0) === 0 ? "square" : "disagrees"} /></td>
                    <td className={td}>{row.disagrees === null || row.disagrees === undefined
                      ? <span style={soft}>—</span>
                      : <Pill v={row.disagrees ? "disagrees" : "square"} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <Note>
        A wallet line has no independent paper — a holder&rsquo;s balance is what its legs say it is,
        so its two paper columns say <em>not asked</em>. A cached total that disagrees with its legs is
        a trigger that got it wrong; a line the papers cannot account for is money the office is holding
        or owing without a document behind it, which is the fault 135 is written to answer.
      </Note>
    </Card>
  );
}

// ============================================================
// the shell
// ============================================================

export function MoneyMoves({ tab, desk }: { tab: MovesTab; desk: Desk }) {
  const [withdrawal, setWithdrawal] = useState<any>(null);
  return (
    <>
      {(tab === "escrow" || tab === "payouts" || tab === "batches") && <Payable desk={desk} />}
      {tab === "wallets" && (
        <Wallets desk={desk} onWithdraw={(w) => setWithdrawal(w)} />
      )}
      {tab === "escrow" && <Escrow desk={desk} />}
      {tab === "payouts" && (
        <Payouts desk={desk} draft={withdrawal} draftUsed={() => setWithdrawal(null)} />
      )}
      {tab === "batches" && <Batches desk={desk} />}
    </>
  );
}
