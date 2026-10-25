"use client";
import { useEffect, useRef, useState } from "react";
import type { Desk } from "./moves";

/**
 * The count (135; task #344).
 *
 * A reconciliation is not a report the office generates out of interest. It is the one paper that
 * answers &ldquo;does the book agree with the things beside it?&rdquo; — the payments, the refund
 * papers, the escrow plans, the deliveries the rails pushed — and 135 writes down every place they
 * disagree, in the words of the check that failed.
 *
 * **A count is read and signed by two different seats, and this desk holds both halves.** The door
 * refuses the signature of whoever raised the run, so the Sign panel is offered to every seat that
 * holds the duty and refused by the book if it is the wrong hand — the desk does not guess at who is
 * allowed, because a screen that decides it locally is a second opinion the door is free to disagree
 * with.
 *
 * **A discarded run takes its findings with it.** The reason typed there is the only thing that will
 * ever explain the gap in the `REC-YYYY-NNNNN` numbering, so it is asked for in its own box, cannot be
 * shorter than eight characters, and is armed by a second tap before it is spent.
 */

const SCOPES: [string, string][] = [
  ["all", "Everything at once"], ["book", "The book against itself"], ["wallet", "Wallets"],
  ["escrow", "Escrow holds"], ["payout", "Payouts"], ["refund", "Refund papers"],
  ["gateway", "The gateway"]
];
const STATUSES: [string, string][] = [
  ["all", "Every count"], ["open", "Waiting for a signature"], ["reviewed", "Signed"]
];

/** 135's five words for how a check failed. They are the report's own vocabulary, so they are printed
 *  with the sentence beside them rather than folded into a colour. */
const VERDICTS: Record<string, string> = {
  differs: "both sides exist and disagree",
  missing_book: "the paper says money and the book has never heard of it",
  missing_paper: "the book carries a figure no paper stands behind",
  refused: "the office turned it away and the report keeps the fact",
  stale: "held open past the office's own promise"
};

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
const firstOfMonth = (today: string) => `${today.slice(0, 8)}01`;

function Pill({ v }: { v: any }) {
  const s = String(v ?? "none");
  const bad = /^(differs|missing_book|missing_paper|refused|stale|open)$/.test(s);
  const good = /^(reviewed|clean|agrees)$/.test(s);
  const c = good ? "var(--success)" : bad ? "var(--danger)" : "var(--ink-soft)";
  return <span className="whitespace-nowrap rounded-input px-8 py-4 text-[11px] font-semibold"
    style={{ color: c, background: `color-mix(in srgb, ${c} 12%, transparent)`,
      border: `1px solid color-mix(in srgb, ${c} 35%, transparent)` }}>{words(s)}</span>;
}

function Card({ title, note, right, children }: { title: string; note?: string;
  right?: any; children?: any }) {
  return (
    <section className={card} style={{ borderColor: "var(--adm-line)" }}>
      <div className="mb-12 flex flex-wrap items-start justify-between gap-12">
        <div className="min-w-0">
          <h2 className="text-base font-bold" style={ink}>{title}</h2>
          {note && <p className="mt-4 max-w-[72ch] text-xs" style={soft}>{note}</p>}
        </div>
        {right && <div className="flex flex-wrap items-center gap-8">{right}</div>}
      </div>
      {children}
    </section>
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

function useLatest<T>(v: T) {
  const r = useRef(v);
  useEffect(() => { r.current = v; });
  return r;
}

/** A search box is committed a beat after it stops changing, so one stray letter cannot page a
 *  register the office is reading a figure out of. */
function useCommitted<T>(value: T, ms = 260): T {
  const [sent, setSent] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSent(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return sent;
}

export function MoneyRecon({ desk }: { desk: Desk }) {
  const [f, setF] = useState({ scope: "all", status: "all", currency: "", search: "", offset: 0 });
  const search = useCommitted(f.search.trim());
  const [board, setBoard] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [run, setRun] = useState<any>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [showRaise, setShowRaise] = useState(false);
  const [paper, setPaper] = useState({ scope: "all", currency: "TZS",
    from: firstOfMonth(desk.today()), to: desk.today() });
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const D = useLatest(desk);
  const canCount = desk.can.recon;

  async function readBoard() {
    if (!canCount) { setLoading(false); return; }
    setLoading(true); setErr(null);
    const parts = [`limit=40`, `offset=${f.offset}`, `status=${f.status}`, `scope=${f.scope}`];
    if (f.currency) parts.push(`currency=${f.currency}`);
    if (search) parts.push(`search=${encodeURIComponent(search)}`);
    try {
      setBoard(await D.current.call(`/control/money/recon?${parts.join("&")}`, "GET"));
    } catch (e: any) {
      setErr((e as Error).message);
      setBoard(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { readBoard(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [canCount, f.scope, f.status, f.currency, f.offset, search]);

  /** The detail is re-read rather than taken from the row: a run that has just been signed changes
   *  its status, its signer and its note, and a panel built from the board's copy would say none of
   *  that happened. */
  async function openRun(id: string) {
    if (openId === id) { setOpenId(null); setRun(null); return; }
    setOpenId(id); setRun(null); setRunErr(null); setNote(""); setReason(""); setArmed(null);
    try {
      setRun(await D.current.call(`/control/money/recon/${id}`, "GET"));
    } catch (e: any) {
      setRunErr((e as Error).message);
      setOpenId(null);
    }
  }

  async function write(key: string, fn: () => Promise<any>, then: (j: any) => string) {
    setBusy(key); setArmed(null);
    try {
      const j = await fn();
      desk.notify(then(j));
      await readBoard();
      if (openId) setRun(await D.current.call(`/control/money/recon/${openId}`, "GET").catch(() => null));
    } catch (e) {
      desk.fault((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function raise() {
    setBusy("raise");
    return desk.call("/control/money/recon/run", "POST", {
      scope: paper.scope, currency: paper.currency, from: paper.from, to: paper.to
    }).then(async (j: any) => {
      setPaper(p => ({ scope: j?.scope ?? p.scope, currency: j?.currency ?? p.currency,
        from: j?.from_day ?? p.from, to: j?.to_day ?? p.to }));
      setShowRaise(false);
      setOpenId(j?.id ?? null);
      setRun(j);
      desk.notify(`${j?.ref ?? "The count"} is written: ${j?.findings ?? 0} exception(s) against the `
        + `book over ${j?.from_day ?? paper.from} to ${j?.to_day ?? paper.to}, net `
        + `${desk.fig(j?.net_difference)} ${j?.currency ?? paper.currency}.`);
      await readBoard();
    }).catch((e: any) => desk.fault((e as Error).message)).finally(() => setBusy(null));
  }

  function sign() {
    if (!run) return Promise.resolve();
    return write(`sign:${run.id}`,
      () => desk.call(`/control/money/recon/${run.id}/sign`, "POST", { note: note.trim() }),
      (j) => `${j?.ref ?? run.ref} is signed by ${j?.reviewed_by ?? "another seat"} and kept. `
        + `${j?.findings ?? run.findings} findings stand behind it.`);
  }

  /** The reason leaves with the press: the row it explains is gone, and a box that kept its words
   *  would let the next draft inherit an explanation that belongs to nothing. */
  function discard() {
    if (!run) return Promise.resolve();
    setBusy(`discard:${run.id}`); setArmed(null);
    const ref = run.ref;
    return desk.call(`/control/money/recon/${run.id}/discard`, "POST", { reason: reason.trim() })
      .then(async () => {
        setOpenId(null); setRun(null); setReason(""); setNote("");
        desk.notify(`${ref} is thrown away and its findings went with it. The reason is in the `
          + `history, and the numbering keeps the gap.`);
        await readBoard();
      })
      .catch((e: any) => desk.fault((e as Error).message))
      .finally(() => setBusy(null));
  }

  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  const heading: any[] = board?.heading ?? [];
  const rows: any[] = board?.rows ?? [];
  const byCur = (k: string) => heading.reduce((a, h) => a + Number(h[k] ?? 0), 0);

  return (
    <>
      {canCount && (
        <Card title="Raise a count"
          note="The book is asked the same questions the papers answer, over a window of days, and every place the two disagree is written down with the check that failed. A run is a reading, not a movement: nothing here changes a figure."
          right={<button className={btn} onClick={() => setShowRaise(o => !o)}>
            {showRaise ? "Close" : "Open the form"}
          </button>}>
          {showRaise && (
            <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
              <label><span className={labelCls} style={soft}>What is being counted</span>
                <select className={cell} style={cellStyle} value={paper.scope}
                  onChange={e => setPaper(p => ({ ...p, scope: e.target.value }))}>
                  {SCOPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></label>
              <label><span className={labelCls} style={soft}>Money</span>
                <select className={cell} style={cellStyle} value={paper.currency}
                  onChange={e => setPaper(p => ({ ...p, currency: e.target.value }))}>
                  <option value="TZS">TZS</option><option value="USD">USD</option>
                </select></label>
              <label><span className={labelCls} style={soft}>From day</span>
                <input type="date" className={cell} style={cellStyle} value={paper.from}
                  onChange={e => setPaper(p => ({ ...p, from: e.target.value }))} /></label>
              <label><span className={labelCls} style={soft}>To day</span>
                <input type="date" className={cell} style={cellStyle} value={paper.to}
                  onChange={e => setPaper(p => ({ ...p, to: e.target.value }))} /></label>
              <div className="flex items-end gap-8 sm:col-span-2 lg:col-span-4">
                <button className={btn} disabled={busy === "raise" || !paper.from || !paper.to}
                  onClick={raise}>
                  {busy === "raise" ? "Counting…" : "Run it"}
                </button>
              </div>
              <p className="text-xs sm:col-span-2 lg:col-span-4" style={soft}>
                One money per count: the book holds TZS and USD and 133 refuses a movement that changes
                currency, so a run that added a TZS difference to a USD one would be an unreadable
                report. A window cannot end on a day that has not happened yet.
              </p>
            </div>
          )}
        </Card>
      )}

      {!canCount && (
        <div className={card + " rounded-card border p-16"} style={{ borderColor: "var(--adm-line)" }}>
          <p className="text-sm font-semibold" style={ink}>Counting is not this seat&rsquo;s duty.</p>
          <p className="mt-8 text-xs" style={soft}>
            A count is read and written under <code>control.money.recon</code>, which 135 keeps away
            from <code>control.money.post</code> on purpose: a reconciliation a seat can raise merely
            because it can post is a report that cannot catch that seat.
          </p>
        </div>
      )}

      {canCount && (
        <Card title="The counts this book has made"
          note="Newest first. The figures in the counters are the whole set the filters still name, not the page below, because the number an office argues about — how much the book is out by — is the one that must never be a fraction of a screen.">
          <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { k: "Counts", v: `${byCur("runs")}`,
                s: `${byCur("open")} waiting for a signature, ${byCur("reviewed")} signed` },
              { k: "Findings", v: `${byCur("findings")}`,
                s: `${byCur("exceptions_open")} of them on a run nobody has signed` },
              { k: "Net difference", v: desk.fig(byCur("net_difference")),
                s: heading.length > 1 ? "TZS and USD added together — read each money below"
                  : `${heading[0]?.currency ?? "TZS"} over every count the filters name` },
              { k: "Checks run", v: `${rows.reduce((a, r) => a + Number(r.checks ?? 0), 0)}`,
                s: `on the ${rows.length} count${rows.length === 1 ? "" : "s"} on this page` }
            ].map(c => (
              <div key={c.k} className="rounded-card border p-12"
                style={{ borderColor: "var(--adm-line)" }}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>{c.k}</p>
                <p className="mt-4 text-lg font-bold" style={ink}>{c.v}</p>
                <p className="mt-4 text-[11px]" style={soft}>{c.s}</p>
              </div>
            ))}
          </div>

          {heading.length > 1 && (
            <p className="mb-12 text-xs" style={soft}>
              Per money: {heading.map(h => `${h.currency} ${h.runs} count(s), `
                + `${h.findings} findings, net ${desk.fig(h.net_difference)}`).join(" · ")}
            </p>
          )}

          <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
            <label><span className={labelCls} style={soft}>What was counted</span>
              <select className={cell} style={cellStyle} value={f.scope}
                onChange={e => setF(x => ({ ...x, scope: e.target.value, offset: 0 }))}>
                {SCOPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
            <label><span className={labelCls} style={soft}>Answer</span>
              <select className={cell} style={cellStyle} value={f.status}
                onChange={e => setF(x => ({ ...x, status: e.target.value, offset: 0 }))}>
                {STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
            <label><span className={labelCls} style={soft}>Money</span>
              <select className={cell} style={cellStyle} value={f.currency}
                onChange={e => setF(x => ({ ...x, currency: e.target.value, offset: 0 }))}>
                <option value="">either</option><option value="TZS">TZS</option>
                <option value="USD">USD</option>
              </select></label>
            <div className="flex items-end gap-8">
              <button className={btn} onClick={readBoard}>Re-read</button>
            </div>
            <label className="sm:col-span-2 lg:col-span-3">
              <span className={labelCls} style={soft}>Reference, seat, check or paper named</span>
              <input className={cell} style={cellStyle} value={f.search}
                placeholder="REC-2026-00004, a seat&rsquo;s name, webhook_stalled…"
                onChange={e => setF(x => ({ ...x, search: e.target.value, offset: 0 }))} />
            </label>
          </div>

          {loading && <p className="mb-8 text-xs" style={soft}>Reading the counts…</p>}
          {err && <p className="mb-8 text-sm" style={{ color: "var(--danger)" }}>{err}</p>}
          {!loading && !err && rows.length === 0 && (
            <p className="mb-8 text-xs" style={soft}>
              No count answers these filters. A count is a paper the office has to ask for — the book
              never raises one on its own.
            </p>
          )}

          {rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-xs">
                <thead>
                  <tr style={soft}>
                    {["Reference", "Window", "Scope", "Money", "Findings", "Net",
                      "Answer", "Raised", "Signed"].map(h => (
                      <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} onClick={() => openRun(r.id)}
                      className="cursor-pointer border-b"
                      style={{ borderColor: "var(--adm-line)",
                        background: openId === r.id
                          ? "color-mix(in srgb, var(--adm-accent) 10%, transparent)" : undefined }}>
                      <td className={td}><span className="font-semibold" style={ink}>{r.ref}</span></td>
                      <td className={td} style={soft}>{r.from_day} → {r.to_day}</td>
                      <td className={td}>{words(r.scope)}</td>
                      <td className={td}>{r.currency}</td>
                      <td className={td}>{r.findings} of {r.checks} checks</td>
                      <td className={td} style={{ color: Number(r.net_difference) === 0
                        ? "var(--ink-soft)" : "var(--danger)" }}>{desk.fig(r.net_difference)}</td>
                      <td className={td}><Pill v={r.status} /></td>
                      <td className={td} style={soft}>{r.raised_by ?? "—"}<br />{desk.when(r.raised_at)}</td>
                      <td className={td} style={soft}>{r.reviewed_by
                        ? <>{r.reviewed_by}<br />{desk.when(r.reviewed_at)}</> : "nobody yet"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.some(r => (r.worst ?? []).length > 0) && (
                <p className="mt-8 text-[11px]" style={soft}>
                  Every count carries its three worst exceptions in the panel below the row it is
                  opened in. Select a reference to read the whole set.
                </p>
              )}
              <Pager count={Number(board?.count ?? 0)} returned={Number(board?.returned ?? 0)}
                offset={f.offset} onOffset={(n) => setF(x => ({ ...x, offset: n }))} />
            </div>
          )}
        </Card>
      )}

      {/* The worst three are folded onto each board row by the door, so a clerk triaging a pile can
          see which check keeps failing without opening twelve counts one at a time. */}
      {canCount && rows.length > 0 && !openId && (
        <Card title="What the counts found, three at a time"
          note="The three largest differences on each run. A finding has no foreign key out of this report, so it still says what it was about after the paper it names has been renamed or erased.">
          <div className="grid gap-12">
            {rows.filter(r => (r.worst ?? []).length > 0).map(r => (
              <div key={r.id} className="rounded-card border p-12"
                style={{ borderColor: "var(--adm-line)" }}>
                <p className="text-xs font-semibold" style={ink}>
                  {r.ref} · {words(r.scope)} · {r.from_day} → {r.to_day} · {r.currency}
                </p>
                <ul className="mt-8 space-y-4">
                  {(r.worst ?? []).map((w: any, i: number) => (
                    <li key={i} className="text-xs" style={soft}>
                      <span style={ink}>{w.check}</span> on {w.subject_ref || words(w.kind)} —{" "}
                      <Pill v={w.verdict} /> {desk.fig(w.difference)} {r.currency}
                      {w.why ? `: ${w.why}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {rows.every(r => (r.worst ?? []).length === 0) && (
              <p className="text-xs" style={soft}>None of these counts found anything.</p>
            )}
          </div>
        </Card>
      )}

      {openId && (
        <Card title={run ? `Count ${run.ref}` : "Opening the count…"}
          note={run ? `${words(run.scope)} over ${run.from_day} to ${run.to_day} in ${run.currency}.` : undefined}
          right={run && <button className={btn} onClick={() => { setOpenId(null); setRun(null); }}>
            Close
          </button>}>
          {runErr && <p className="mb-12 text-sm" style={{ color: "var(--danger)" }}>{runErr}</p>}
          {!run && !runErr && <p className="mb-12 text-xs" style={soft}>Reading…</p>}

          {run && (
            <>
              <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { k: "Status", v: words(run.status),
                    s: run.status === "reviewed" ? `signed by ${run.reviewed_by ?? "a second seat"}`
                      : "waiting on a signature from a seat that did not raise it" },
                  { k: "Findings", v: `${run.findings}`,
                    s: `${run.checks} checks asked, ${(run.examined ?? []).length} came back clean` },
                  { k: "Net difference", v: desk.fig(run.net_difference),
                    s: `${run.currency} — the book minus the papers, per finding` },
                  { k: "Raised", v: run.raised_by ?? "—", s: desk.when(run.raised_at) }
                ].map(c => (
                  <div key={c.k} className="rounded-card border p-12"
                    style={{ borderColor: "var(--adm-line)" }}>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>{c.k}</p>
                    <p className="mt-4 text-lg font-bold" style={ink}>{c.v}</p>
                    <p className="mt-4 text-[11px]" style={soft}>{c.s}</p>
                  </div>
                ))}
              </div>

              {(run.examined ?? []).length > 0 && (
                <div className="mb-16">
                  <p className="mb-8 text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>
                    Asked and clean
                  </p>
                  <div className="flex flex-wrap gap-8">
                    {(run.examined ?? []).map((c: string) => (
                      <span key={c} className="rounded-input px-8 py-4 text-[11px]"
                        style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)",
                          color: "var(--ink)" }}>{words(c)}</span>
                    ))}
                  </div>
                </div>
              )}

              {(run.by_check ?? []).length > 0 && (
                <div className="mb-16 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse text-xs">
                    <thead>
                      <tr style={soft}>
                        {["Check", "Exceptions", "Net", "Worst paper"].map(h => (
                          <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(run.by_check ?? []).map((b: any) => (
                        <tr key={b.check} className="border-b" style={{ borderColor: "var(--adm-line)" }}>
                          <td className={td} style={ink}>{words(b.check)}</td>
                          <td className={td}>{b.exceptions}</td>
                          <td className={td}>{desk.fig(b.net)} {run.currency}</td>
                          <td className={td} style={soft}>{b.worst_subject || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {(run.exceptions ?? []).length === 0 ? (
                <p className="mb-8 text-sm" style={{ color: "var(--success)" }}>
                  Nothing. Every check this run asked came back agreeing.
                </p>
              ) : (
                <div className="mb-16 overflow-x-auto">
                  <table className="w-full min-w-[860px] border-collapse text-xs">
                    <thead>
                      <tr style={soft}>
                        {["#", "Check", "About", "The book says", "The papers say",
                          "Difference", "Verdict"].map(h => (
                          <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(run.exceptions ?? []).map((e: any) => (
                        <tr key={e.id} className="border-b" style={{ borderColor: "var(--adm-line)" }}>
                          <td className={td}>{e.line}</td>
                          <td className={td} style={ink}>{words(e.check)}</td>
                          <td className={td} style={soft}>
                            {words(e.subject_kind)} {e.subject_ref || "· no reference"}
                          </td>
                          <td className={td}>{desk.fig(e.book_figure)}</td>
                          <td className={td}>{desk.fig(e.paper_figure)}</td>
                          <td className={td}
                            style={{ color: Number(e.difference) === 0
                              ? "var(--ink-soft)" : "var(--danger)" }}>{desk.fig(e.difference)}</td>
                          <td className={td}>
                            <Pill v={e.verdict} />
                            <p className="mt-4 max-w-[46ch]" style={soft}>
                              {VERDICTS[String(e.verdict)] ?? ""}
                              {e.detail?.why ? ` — ${e.detail.why}` : ""}
                            </p>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-8 text-[11px]" style={soft}>
                    The difference is the table&rsquo;s own derived column — book minus papers — and no
                    door can write a finding whose figure does not follow from its own two sides.
                  </p>
                </div>
              )}

              {run.status === "reviewed" && (
                <div className="rounded-input border px-12 py-8 text-xs"
                  style={{ borderColor: "var(--success)", ...soft }}>
                  <p className="font-semibold" style={ink}>
                    Signed by {run.reviewed_by ?? "a second seat"} on {desk.when(run.reviewed_at)}.
                  </p>
                  {run.review_note && <p className="mt-4 max-w-[80ch]">{run.review_note}</p>}
                  <p className="mt-4">A signed count is kept and cannot be thrown away: it is a paper
                    somebody answered for.</p>
                </div>
              )}

              {run.status === "open" && (
                <div className="grid gap-12 lg:grid-cols-2">
                  <div className="rounded-card border p-12" style={{ borderColor: "var(--adm-line)" }}>
                    <p className="text-sm font-semibold" style={ink}>Sign for this count</p>
                    <p className="mt-4 text-xs" style={soft}>
                      A second pair of eyes, in writing. The door refuses the seat that raised the run —
                      that is the only reason a signature on a report means anything — and the note is
                      kept beside the figures.
                    </p>
                    <label className="mt-12 block">
                      <span className={labelCls} style={soft}>
                        What you checked, and what you accept (8 to 600 characters)
                      </span>
                      <textarea className={cell} style={cellStyle} rows={3} value={note}
                        onChange={e => setNote(e.target.value)}
                        placeholder="Bank statement for October matched line by line; the two wallet differences are the fees the rail kept." />
                    </label>
                    <button className={`${btn} mt-12`}
                      disabled={busy === `sign:${run.id}` || note.trim().length < 8}
                      onClick={sign}>
                      {busy === `sign:${run.id}` ? "Signing…" : "Sign it"}
                    </button>
                  </div>

                  <div className="rounded-card border p-12"
                    style={{ borderColor: "color-mix(in srgb, var(--danger) 40%, transparent)" }}>
                    <p className="text-sm font-semibold" style={ink}>Throw this draft away</p>
                    <p className="mt-4 text-xs" style={soft}>
                      For a count that asked the wrong question or was raised by mistake. Its findings
                      go with it — the reason typed here is the only thing left to explain the gap in
                      the numbering, so it is not optional and it is not a word.
                    </p>
                    <label className="mt-12 block">
                      <span className={labelCls} style={soft}>Why it is being thrown away (8 to 600 characters)</span>
                      <textarea className={cell} style={cellStyle} rows={3} value={reason}
                        onChange={e => setReason(e.target.value)}
                        placeholder="Raised over a window that ended mid-day; re-counted as the run after this one." />
                    </label>
                    <button className={`${btn} mt-12`}
                      disabled={busy === `discard:${run.id}` || reason.trim().length < 8}
                      style={armed === `discard:${run.id}`
                        ? { background: "var(--danger)", color: "var(--milk)" } : undefined}
                      onClick={arm(`discard:${run.id}`, discard)}>
                      {armed === `discard:${run.id}`
                        ? "Tap again — the findings go with it"
                        : busy === `discard:${run.id}` ? "Discarding…" : "Discard it"}
                    </button>
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

/** 135 clamps a statement page at 500 legs; the desk stays well under it because a clerk reads this
 *  table on a screen, and the whole window is in the heading figures above it either way. */
const STATEMENT_LIMIT = 200;

/**
 * One line of the chart, stated over a window of days (135).
 *
 * This is the paper an office hands to its own accountant, so the figures on it are the door&rsquo;s
 * and not the browser&rsquo;s: the opening is every leg before the first day, the totals cover the
 * whole window whether or not this page can see them, and the closing is the opening plus what the
 * window moved. Nothing here adds a column up.
 *
 * **The agreement line is honest about the window it was asked over.** The cached totals on an
 * account are lifetime figures, so they can only be compared with a statement that closes today; a
 * month read in October is not evidence that October&rsquo;s register has drifted, and the door says
 * `null` rather than `false`. The desk prints that third answer instead of quietly dropping it.
 *
 * **A file is walked off the book, not posted up from this screen.** The three buttons below ask the
 * door for the whole window and it paginates itself — up to 8,000 legs, 3,000 on the printed page —
 * so a clerk never has to page through a month to print it, and never gets a file whose figures came
 * from a spreadsheet instead of the ledger.
 */
export function AccountStatement({ desk, account }: {
  desk: Desk;
  account: { id: string; code: string; label: string; kind: string; currency: string };
}) {
  const [draft, setDraft] = useState({ from: firstOfMonth(desk.today()), to: desk.today() });
  const [asked, setAsked] = useState(draft);
  const [offset, setOffset] = useState(0);
  const [st, setSt] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const D = useLatest(desk);

  async function read() {
    setLoading(true); setErr(null);
    try {
      setSt(await D.current.call(
        `/control/money/accounts/${account.id}/statement?from=${asked.from}&to=${asked.to}`
        + `&limit=${STATEMENT_LIMIT}&offset=${offset}`, "GET"));
    } catch (e: any) {
      setErr((e as Error).message);
      setSt(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { read(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ },
    [asked, offset]);

  function file(ext: "csv" | "xlsx" | "pdf") {
    setBusy(ext);
    return desk.download(
      `/control/money/accounts/${account.id}/statement.${ext}?from=${asked.from}&to=${asked.to}`,
      `statement-${st?.code ?? account.code}-${asked.from}_${asked.to}.${ext}`
    ).finally(() => setBusy(null));
  }

  const rows: any[] = st?.rows ?? [];
  const drift = st?.drift ?? {};
  const legs = Number(st?.legs ?? 0);
  const cur = st?.currency ?? account.currency;
  const days = `${asked.from} to ${asked.to}`;

  return (
    <div className="mt-16 rounded-card border p-16"
      style={{ borderColor: "var(--adm-line)", background: "var(--milk)" }}>
      <div className="mb-12 flex flex-wrap items-start justify-between gap-12">
        <div className="min-w-0">
          <h3 className="text-sm font-bold" style={ink}>Statement of {account.code}</h3>
          <p className="mt-4 max-w-[72ch] text-xs" style={soft}>
            The window&rsquo;s figures are the book&rsquo;s own: {st?.basis
              ?? "the opening is every leg before the first day, the totals cover the whole window and not just this page."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-8">
          <button className={btn} disabled={busy === "csv"} onClick={() => file("csv")}>
            {busy === "csv" ? "CSV…" : "CSV"}
          </button>
          <button className={btn} disabled={busy === "xlsx"} onClick={() => file("xlsx")}>
            {busy === "xlsx" ? "Excel…" : "Excel"}
          </button>
          <button className={btn} disabled={busy === "pdf"} onClick={() => file("pdf")}>
            {busy === "pdf" ? "PDF…" : "PDF"}
          </button>
        </div>
      </div>

      <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
        <label><span className={labelCls} style={soft}>From day</span>
          <input type="date" className={cell} style={cellStyle} value={draft.from}
            onChange={e => setDraft(x => ({ ...x, from: e.target.value }))} /></label>
        <label><span className={labelCls} style={soft}>To day</span>
          <input type="date" className={cell} style={cellStyle} value={draft.to}
            onChange={e => setDraft(x => ({ ...x, to: e.target.value }))} /></label>
        <div className="flex items-end gap-8">
          <button className={btn} disabled={loading || !draft.from || !draft.to
            || (draft.from === asked.from && draft.to === asked.to && offset === 0)}
            onClick={() => { setOffset(0); setAsked(draft); }}>
            Read the window
          </button>
        </div>
        <p className="text-[11px] pb-8" style={soft}>
          The window is read as a whole whatever page is showing. A day that has not happened yet is
          refused, because a statement cannot close on it.
        </p>
      </div>

      {loading && <p className="mb-8 text-xs" style={soft}>Reading {account.code}…</p>}
      {err && <p className="mb-8 text-sm" style={{ color: "var(--danger)" }}>{err}</p>}

      {!loading && !err && st && (
        <>
          <div className="mb-12 grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { k: "Opening", v: desk.fig(st.opening), s: `every leg before ${asked.from}` },
              { k: "Debited", v: desk.fig(st.debited), s: `${asked.to === asked.from ? "one day" : "the window"} in, debit side` },
              { k: "Credited", v: desk.fig(st.credited), s: `${asked.to === asked.from ? "one day" : "the window"} out, credit side` },
              { k: "Moved", v: desk.fig(st.moved), s: `${account.kind} grows on the ${st.natural_side} side` },
              { k: "Closing", v: desk.fig(st.closing), s: `${legs} leg${legs === 1 ? "" : "s"} between ${days}` },
              { k: "On this page", v: `${rows.length}`, s: `${Number(st.returned ?? 0)} returned of ${legs}, from leg ${offset + 1}` }
            ].map(c => (
              <div key={c.k} className="rounded-input border px-12 py-8"
                style={{ borderColor: "var(--adm-line)" }}>
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={soft}>{c.k}</p>
                <p className="mt-4 text-lg font-bold" style={ink}>{c.v}<span className="ml-4 text-[11px] font-normal" style={soft}>{cur}</span></p>
                <p className="mt-4 text-[11px]" style={soft}>{c.s}</p>
              </div>
            ))}
          </div>

          <div className="mb-16 rounded-input border px-12 py-8 text-xs"
            style={{
              borderColor: drift.agrees === false ? "var(--danger)" : "var(--adm-line)",
              color: drift.agrees === false ? "var(--danger)" : undefined
            }}>
            {drift.agrees === true && (
              <p style={ink}>
                The book agrees: the cached totals on {account.code} equal this statement&rsquo;s
                closing figure of {desk.fig(drift.statement_balance)} {cur}, and the account has
                {Number(drift.legs_cached ?? 0)} legs against {Number(drift.legs_all_time ?? 0)} in the register.
              </p>
            )}
            {drift.agrees === false && (
              <p className="font-semibold">
                The cached totals say {desk.fig(drift.cached_balance)} {cur} and this window closes at{" "}
                {desk.fig(drift.statement_balance)} {cur}. The statement is counted from the legs, so it
                is the truth until the trigger that keeps the cached column is fixed — the ledger desk
                names the same drift above the chart.
              </p>
            )}
            {drift.agrees === null && (
              <p style={soft}>
                Not checked: the cached totals are lifetime figures and this window ends on {asked.to},
                not today, so the two are allowed to differ. Ask the agreement of a window that closes
                on {desk.today()} if you need that answer.
              </p>
            )}
          </div>

          {legs === 0 ? (
            <p className="mb-8 text-xs" style={soft}>
              Nothing moved on {account.code} between {days}. The opening and the closing are the same
              figure, which is the statement&rsquo;s own answer rather than an empty screen.
            </p>
          ) : rows.length === 0 ? (
            <p className="mb-8 text-xs" style={soft}>
              This window has {legs} legs and none of them is on this page.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] border-collapse text-xs">
                <thead>
                  <tr style={soft}>
                    {["Line", "Day", "Movement", "Memo", "Side", "Amount", "In its own side",
                      "Running", "Other side", "Paper", "Posted by"].map(h => (
                      <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.line} className="border-b" style={{ borderColor: "var(--adm-line)" }}>
                      <td className={td} style={soft}>{r.line}</td>
                      <td className={td} style={soft}>{r.day}</td>
                      <td className={td}><span className="font-semibold" style={ink}>{r.ref}</span></td>
                      <td className={`${td} max-w-[36ch]`}>{r.memo}</td>
                      <td className={td}><Pill v={r.direction} /></td>
                      <td className={`${td} text-right`}>{desk.fig(r.amount)}</td>
                      <td className={`${td} text-right`} style={{
                        color: Number(r.moved) < 0 ? "var(--danger)" : undefined
                      }}>{desk.fig(r.moved)}</td>
                      <td className={`${td} text-right font-semibold`} style={ink}>{desk.fig(r.running)}</td>
                      <td className={td} style={soft}>{r.other_side}</td>
                      <td className={td} style={soft}>
                        {words(r.source_kind)}{r.source_ref ? ` · ${r.source_ref}` : ""}
                        <br />
                        <span className="text-[11px]">{words(r.posting_status)}
                          {r.detail ? ` · ${r.detail}` : ""}</span>
                      </td>
                      <td className={td} style={soft}>{r.posted_by ?? "—"}
                        <br />{desk.when(r.raised_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pager count={legs} returned={Number(st.returned ?? 0)} offset={offset}
                onOffset={setOffset} />
            </div>
          )}

          <p className="mt-12 text-[11px]" style={soft}>
            A file carries the whole window rather than this page — up to 8,000 legs, and 3,000 on the
            printed page, which is where the office is told to narrow the days instead. Excel and PDF
            print the header figures the book produced, so the closing balance on the paper an
            accountant is handed is the closing balance the office holds; the CSV is the door&rsquo;s
            own row shape, with nothing formatted that a spreadsheet would have to undo. Every print is
            written to the history with the seat that asked for it.
          </p>
        </>
      )}
    </div>
  );
}
