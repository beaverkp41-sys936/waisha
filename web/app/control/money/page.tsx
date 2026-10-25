"use client";
import { useCallback, useEffect, useState } from "react";
import { ControlNav } from "@/components/ControlNav";
import { MoneyMoves, type Desk, type MovesTab } from "./moves";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

const VIEW = "control.money.view";
const POST = "control.money.post";
const FREEZE = "control.money.freeze";
const PAY = "control.money.pay";
const ESCROW = "control.money.escrow";
const REVEAL = "control.money.reveal";

type Tab = MovesTab | "book";
const TABS: [Tab, string][] = [
  ["book", "The book"], ["wallets", "Wallets"], ["escrow", "Escrow holds"],
  ["payouts", "Payouts"], ["batches", "Batches"]];

/** What each tab is for, in the words the desk itself uses. The book answers "does it agree with
 *  itself"; the three registers above it (134) each answer a different question about money that has
 *  not moved yet, and a clerk who cannot see which question is being asked reads the wrong answer. */
const HEAD: Record<Tab, string> = {
  book: "Double-entry book",
  wallets: "Holders’ wallets",
  escrow: "Money parked against a job",
  payouts: "Money the office owes out",
  batches: "Payouts carried together"
};
const SUB: Record<Tab, string> = {
  book: "Every movement the office has written, counted from its legs.",
  wallets: "A holder’s balance is a line of the book, not a column someone maintains beside it.",
  escrow: "Money stopped against a booking, a cargo file, a call or a dispute — and the plan a second seat has to sign.",
  payouts: "Drafted, signed, accrued, then answered on the day the cash actually goes.",
  batches: "Many papers under one signature, closed only when none of them is still owed."
};

const KINDS = ["asset", "liability", "equity", "income", "expense"];
const SOURCE_KINDS = ["opening", "manual", "adjustment", "reversal", "invoice", "payment",
  "refund", "payout", "fee", "escrow", "cost", "payroll", "tax"];

interface Account {
  id: string;
  code: string;
  label: string;
  kind: string;
  currency: string;
  status: string;
  note: string | null;
  frozen_reason: string | null;
  opened_at: string;
  last_posted_at: string | null;
  entry_count: number;
  cached: { debit: number; credit: number };
  recomputed: { debit: number; credit: number };
  drift: boolean;
  balance: number;
  natural_side: string;
}

interface Totals {
  accounts: number;
  frozen_accounts: number;
  postings: number;
  movements_reversed: number;
  tzs_postings: number;
  usd_postings: number;
  legs: number;
  debited: number;
  credited: number;
  out_by: number;
  square: boolean;
}

interface Square {
  postings: number;
  short_legged: number;
  one_sided: number;
  unbalanced: number;
  figure_disagrees: number;
  refs: string[];
  square: boolean;
}

interface Side {
  direction: string;
  amount: number;
  account: string;
  label: string;
  account_id: string;
  kind: string;
  detail: string | null;
}

interface Row {
  id: string;
  ref: string;
  posted_on: string;
  memo: string;
  currency: string;
  total: number;
  source_kind: string;
  source_ref: string | null;
  status: string;
  raised_at: string;
  raised_by: string | null;
  reversed_by: string | null;
  sides: Side[];
  moved: string;
  debited: number;
  credited: number;
}

interface Leg {
  id: string;
  direction: string;
  amount: number;
  detail: string | null;
  code: string;
  label: string;
  kind: string;
  currency: string;
}

interface Detail {
  id: string;
  ref: string;
  posted_on: string;
  memo: string;
  currency: string;
  total: number;
  source_kind: string;
  source_ref: string | null;
  source_id: string | null;
  status: string;
  reversal_note: string | null;
  raised_at: string;
  raised_by_name: string | null;
  reversed_by_name: string | null;
  legs: Leg[];
  answers: { ref: string; posted_on: string }[] | null;
  answered_by: { ref: string; posted_on: string } | null;
}

interface Draft {
  account: string;
  direction: string;
  amount: string;
  detail: string;
}

/**
 * The office's book.
 *
 * One question is worth more here than any figure: *does the book agree with itself?* The register
 * answers it (`/control/money/square` counts it from the legs, not from the running columns), and
 * the chart prints both sets of totals side by side, because a ledger that only ever shows its own
 * cached total cannot tell a stale trigger from an honest book.
 *
 * Nothing on this desk edits a movement. A movement is written once and, if it was wrong, answered
 * by its own mirror with a reference and a sentence — the tables refuse UPDATE and DELETE at the
 * trigger, so the desk that offered a correction would be lying about what it can do.
 *
 * The pen is not the freeze: posting needs `control.money.post`, stopping an account needs
 * `control.money.freeze`, and 133 gives them to different seats on purpose — a finance officer can
 * move money and cannot halt a colleague's, a compliance officer can halt it and cannot move any.
 * The whole book is the office's own (099 makes a control session platform-only), so no company's
 * ledger is reachable from this screen and none is shown.
 */
export default function ControlMoneyPage() {
  const [me, setMe] = useState<any>(null);
  const [perms, setPerms] = useState<string[]>([]);
  // The duty list is read a beat after the seat is, so an empty `perms` proves nothing on its own.
  // Without this the desk's first paint tells a seat that can read the book that it cannot — and if
  // the probe never answers, that lie is what stays on the screen while the doors return 200.
  const [permsKnown, setPermsKnown] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [square, setSquare] = useState<Square | null>(null);
  const [reg, setReg] = useState<{ rows: Row[]; count: number; returned: number }>(
    { rows: [], count: 0, returned: 0 });
  const [q, setQ] = useState({ status: "all", currency: "", account: "", search: "", offset: 0 });
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  // The selected line is held as an id, not as the row object: a freeze rewrites the account, and a
  // panel built from the old copy would go on offering "Freeze this account" to an account the desk
  // has just stopped.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [showPost, setShowPost] = useState(false);
  const [showOpen, setShowOpen] = useState(false);
  const [openForm, setOpenForm] = useState({ code: "", label: "", kind: "asset", currency: "TZS", note: "" });
  const [freezeReason, setFreezeReason] = useState("");
  const [reverseReason, setReverseReason] = useState("");
  const [head, setHead] = useState({ posted_on: "", memo: "", currency: "TZS", source_kind: "manual", source_ref: "" });
  const [legs, setLegs] = useState<Draft[]>([]);
  // Minted when the form opens, not when it renders: a retry of the same paper must carry the same
  // key, and a value born during render makes the server's HTML and the browser's disagree.
  const [idem, setIdem] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("book");

  const canView = perms.includes(VIEW);
  const canPost = perms.includes(POST);
  const canFreeze = perms.includes(FREEZE);
  const canPay = perms.includes(PAY);
  const canEscrow = perms.includes(ESCROW);
  const canReveal = perms.includes(REVEAL);
  const picked = accounts.find(a => a.id === pickedId) ?? null;

  async function load() {
    const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
    if (!m.ok) { window.location.href = "/control/login"; return; }
    setMe(await m.json());
    const p = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
    if (p.ok) {
      setPerms((await p.json()).permissions ?? []);
      setPermsKnown(true);
    } else setError(message(await p.json().catch(() => ({})),
      "The desk could not read this seat's duties, so it cannot show its pen. "
      + "The book itself is still readable below."));

    const [b, s, r] = await Promise.all([
      fetch(`${API}/api/v1/control/money/book`, { credentials: "include" }),
      fetch(`${API}/api/v1/control/money/square`, { credentials: "include" }),
      fetch(`${API}/api/v1/control/money/register?limit=60&offset=0`, { credentials: "include" })
    ]);
    if (b.ok) {
      const j = await b.json();
      setAccounts(j.accounts ?? []);
      setTotals(j.totals ?? null);
    } else setError(message(await b.json().catch(() => ({})), "The chart would not answer."));
    if (s.ok) setSquare(await s.json());
    if (r.ok) {
      const j = await r.json();
      setReg({ rows: j.rows ?? [], count: Number(j.count ?? 0), returned: Number(j.returned ?? 0) });
    } else setError(message(await r.json().catch(() => ({})), "The register would not answer."));
    setReady(true);
  }

  useEffect(() => { load(); }, []);

  function message(j: any, fallback: string) {
    const m = j?.error?.message ?? (j?.error?.code === "FORBIDDEN"
      ? `This seat holds no ${VIEW.split(".").pop()} duty, so the book is closed to it.`
      : fallback);
    // "Request validation failed" names the shape the book refused, not the line that was wrong, and
    // this is the one desk where a wrong figure cannot be corrected afterwards — so the field the
    // validator named travels with the sentence. A detail with no message still names its field, and
    // never prints the bare "field: " a clerk cannot act on.
    const hints = (j?.error?.details ?? []).map((d: any) => {
      const words = String(d?.message ?? "").trim();
      const where = String(d?.field ?? "").trim();
      return words ? (where ? `${where}: ${words}` : words) : where;
    }).filter(Boolean).slice(0, 4);
    return hints.length ? `${m} — ${hints.join("; ")}` : m;
  }

  async function call(path: string, method: string, body?: unknown,
    extra?: Record<string, string>): Promise<any> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    Object.assign(headers, extra ?? {});
    const res = await fetch(`${API}/api/v1${path}`, {
      method, credentials: "include", headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(message(j, `The desk refused (${res.status})`));
    return j;
  }

  /** A file the browser keeps, not a tab it opens. The payout export answers with an attachment, so
   *  the reply is read as a blob and handed to a throwaway anchor — a `window.open` would carry no
   *  session cookie at all and would show the seat a login page instead of its own register.
   *  Nothing throws: a call made with `void` has nobody left to catch it, so the fault is reported
   *  the same way every other fault on this desk is. */
  async function download(path: string, filename: string): Promise<void> {
    setError(null); setNotice(null);
    try {
      const res = await fetch(`${API}/api/v1${path}`, { credentials: "include" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(message(j, `The export would not answer (${res.status})`));
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`${filename} saved — ${Math.max(1, Math.round(blob.size / 1024))} KB of the register the filters still named.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Every write ends with the same three reads it started from, so what the desk says afterwards is
   *  the book's answer rather than a repetition of what was just typed. A movement left open is
   *  re-read with them: the row that has just been answered gains a status, a reverser and a mirror,
   *  and a panel holding the copy from before the write would say none of that happened. */
  async function run(key: string, fn: () => Promise<any>, then?: (j: any) => string) {
    setBusy(key); setError(null); setNotice(null); setArmed(null);
    try {
      const j = await fn();
      await load();
      if (detailFor) {
        const fresh = await call(`/control/money/postings/${detailFor}`, "GET").catch(() => null);
        if (fresh) setDetail(fresh);
      }
      if (then) setNotice(then(j));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setTimeout(() => setNotice(null), 12000);
    }
  }

  const readRegister = useCallback(async (f: typeof q) => {
    const parts = [`limit=60`, `offset=${f.offset}`, `status=${f.status}`];
    if (f.currency) parts.push(`currency=${f.currency}`);
    if (f.account) parts.push(`account=${f.account}`);
    if (f.search.trim()) parts.push(`search=${encodeURIComponent(f.search.trim())}`);
    setError(null);
    try {
      const j = await call(`/control/money/register?${parts.join("&")}`, "GET");
      setReg({ rows: j.rows ?? [], count: Number(j.count ?? 0), returned: Number(j.returned ?? 0) });
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Filters are applied on their own: the chart is not re-cut for a typo in a search box, and the
  // desk must never show a page that disagrees with the controls above it.
  useEffect(() => {
    if (!canView) return;
    const t = setTimeout(() => { readRegister(q); }, 260);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.status, q.currency, q.account, q.search, q.offset, canView, readRegister]);
  // `search` is typed, so it is the one filter that also resets the page back to the first one.
  useEffect(() => { setQ(f => ({ ...f, offset: 0 })); }, [q.search]);

  async function openMovement(id: string) {
    if (detailFor === id) { setDetail(null); setDetailFor(null); return; }
    setDetailFor(id); setDetail(null); setError(null);
    try {
      setDetail(await call(`/control/money/postings/${id}`, "GET"));
      setReverseReason("");
    } catch (e) {
      setError((e as Error).message);
      setDetailFor(null);
    }
  }

  // A new leg defaults to the office's own cash line when the book has one, and always to an account
  // a movement can pass through: pre-filling a frozen line would hand the clerk a leg the book refuses
  // for a reason already sitting in that row, while the select shows the same line disabled.
  const firstOpen = () => {
    const open = accounts.filter(a => a.status !== "frozen");
    return open.find(a => a.code === "OPS-CASH") ?? open[0];
  };

  function addLeg(d: Partial<Draft>) {
    setLegs(l => [...l, {
      account: d.account ?? (firstOpen()?.id ?? ""), direction: d.direction ?? "debit",
      amount: d.amount ?? "", detail: d.detail ?? ""
    }]);
  }

  function editLeg(i: number, field: keyof Draft, value: string) {
    setLegs(l => l.map((x, n) => (n === i ? { ...x, [field]: value } : x)));
  }

  // The desk's own running total, in cents so that two typed figures cannot disagree with each other
  // the way floats do. It is a hint for the clerk, not a gate: `record_money_posting` adds the legs
  // up again before the header exists, and the deferred trigger asks the same question at commit.
  const cents = (s: string) => {
    const m = /^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.exec(s.trim());
    if (!m) return NaN;
    const [whole, frac = ""] = m[1].split(".");
    return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  };
  const sum = (side: string) => legs.filter(l => l.direction === side)
    .reduce((a, l) => a + (Number.isNaN(cents(l.amount)) ? 0 : cents(l.amount)), 0);
  const badLeg = legs.some(l => !l.account || !l.amount || Number.isNaN(cents(l.amount)) || cents(l.amount) <= 0);
  const debitC = sum("debit"), creditC = sum("credit");
  const squares = legs.length >= 2 && !badLeg && debitC > 0 && creditC > 0 && debitC === creditC;

  /** Posting a movement and answering one are the two presses on this desk that the book can never
   *  take back: 133 refuses an UPDATE or a DELETE on a header and on a leg at the trigger, so a wrong
   *  figure does not get corrected, it lives in the register and is answered by a second row. Both
   *  are armed by a second tap — and the arm is keyed to the paper rather than to the button, because
   *  a clerk who edits a leg after the first tap is holding a different movement from the one the
   *  warning named. A freeze is not armed: its own opposite is one press away. */
  const paper = [idem, head.posted_on, head.currency, head.source_kind, head.source_ref.trim(),
    head.memo.trim(), legs.map(l => `${l.account}>${l.direction}>${l.amount.trim()}>${l.detail.trim()}`)
      .join("|")].join("§");
  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  function startPost() {
    setShowPost(true);
    setIdem(mint());
    const first = firstOpen();
    setLegs([
      { account: first?.id ?? "", direction: "credit", amount: "", detail: "" },
      { account: "", direction: "debit", amount: "", detail: "" }
    ]);
    // The two defaults have to be the same money: a TZS paper opened over a USD cash line is a
    // movement the book refuses before the clerk has typed anything.
    setHead(h => ({ ...h, posted_on: today(), currency: first?.currency ?? h.currency }));
  }

  /** A movement must be reachable by the number the office can quote, so the desk shows the key it
   *  is about to send and keeps it until the book answers. */
  function mint(): string {
    const c = (globalThis as any).crypto;
    if (c?.randomUUID) return `desk-${c.randomUUID()}`;
    return `desk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function post() {
    return run("post", () => call("/control/money/postings", "POST", {
      posted_on: head.posted_on,
      memo: head.memo.trim(),
      currency: head.currency,
      source_kind: head.source_kind,
      source_ref: head.source_ref.trim() || undefined,
      legs: legs.map(l => ({
        account: l.account, direction: l.direction, amount: l.amount.trim(),
        detail: l.detail.trim() || undefined
      }))
    }, { "Idempotency-Key": idem }), (j) => {
      const p = j.posting;
      return j.replayed
        ? `${p?.ref ?? "That movement"} was already in the book under this key — nothing was added a second time.`
        : `${p?.ref ?? "Movement"} posted: ${fig(p?.total)} ${p?.currency ?? ""} across ${p?.legs?.length ?? legs.length} legs.`;
    });
  }

  function reverse() {
    if (!detail) return Promise.resolve();
    return run(`reverse:${detail.id}`,
      () => call(`/control/money/postings/${detail.id}/reverse`, "POST",
        { reason: reverseReason.trim() }),
      (j) => `${detail.ref} is marked reversed; ${j.reversal?.ref ?? "its mirror"} was posted in answer to it.`);
  }

  function openAccount() {
    return run("open", () => call("/control/money/accounts", "POST", {
      code: openForm.code.trim(), label: openForm.label.trim(), kind: openForm.kind,
      currency: openForm.currency, note: openForm.note.trim() || undefined
    }), (a) => `${a.code} — ${a.label} is on the chart as ${a.kind} in ${a.currency}.`);
  }

  function freeze(frozen: boolean) {
    if (!picked) return Promise.resolve();
    return run(`freeze:${picked.id}`,
      () => call(`/control/money/accounts/${picked.id}/${frozen ? "freeze" : "unfreeze"}`,
        "POST", frozen || freezeReason.trim().length >= 8
          ? { reason: freezeReason.trim() } : {}),
      () => {
        // The sentence has been spent: it is in the history now, and a box that kept it would let the
        // opposite act — a lift followed by a stop — carry yesterday's reason onto the account today.
        setFreezeReason("");
        return frozen
          ? `${picked.label} is frozen. Nothing may be posted through it until a seat lifts it.`
          : `${picked.label} is open again. The reason is kept in the history, not on the account.`;
      });
  }

  const fig = (v: unknown) => Number(v ?? 0).toLocaleString("en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : "never");
  const today = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /** A tab asks a different question, so neither the sentence one panel wrote nor the fault another
   *  provoked follows the clerk across it. `desk.go` is the same move from inside a panel: a wallet
   *  that hands a withdrawal to the payout register changes the tab on the desk's side, not its own. */
  function pickTab(t: Tab) {
    setTab(t); setError(null); setNotice(null);
    // Every register above the book writes into it: funding a wallet posts a movement, releasing a
    // payout accrues one. The counters were read the last time the book was open, so they are read
    // again on the way back rather than shown as the figures from before the money moved.
    if (t === "book" && tab !== "book") void load();
  }

  /**
   * The four registers that sit on top of the book (134) are handed this desk rather than given their
   * own session: the same cookies, the same duty list, the same green strip that says what the doors
   * answered. A payout booked from a wallet therefore reports itself beside the movement it created,
   * and a seat without `control.money.pay` sees the same closed pen here as on the book.
   */
  const desk: Desk = {
    call, download, fig, when, today, cents, mint,
    notify: (s) => { setError(null); setNotice(s); setTimeout(() => setNotice(null), 12000); },
    fault: (s) => { setNotice(null); setError(s); },
    can: { pay: canPay, escrow: canEscrow, reveal: canReveal },
    go: pickTab,
  };

  const cell = "w-full rounded-input border px-8 py-8 text-sm";
  const cellStyle = { borderColor: "var(--adm-line)", background: "var(--milk)" };
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const btn = "waisha-btn rounded-input px-16 py-8 text-xs font-semibold";

  const drifted = accounts.filter(a => a.drift);

  if (me && permsKnown && !canView) {
    return (
      <div className="control-shell page-shell flex-1">
        <header className="flex flex-wrap items-center justify-between px-24 py-12"
          style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <ControlNav />
        </header>
        <main className="mx-auto max-w-[900px] px-16 py-32">
          <div className="rounded-card border p-24" style={{ borderColor: "var(--adm-line)" }}>
            <h1 className="text-lg font-bold" style={{ color: "var(--ink)" }}>
              This book is not yours to read
            </h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ")
                || "no platform duty"}. Reading the chart and the register needs <code>{VIEW}</code>.
            </p>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Posting a movement and opening an account needs <code>{POST}</code>; freezing one needs{" "}
              <code>{FREEZE}</code>, and 133 gives the two to different seats — the hand that stops
              somebody else&rsquo;s money is the one that settles disputes, not the one that holds a pen.
            </p>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              The three registers above the book need duties of their own: <code>{PAY}</code> funds a
              wallet and raises, signs off or declines a payout; <code>{ESCROW}</code> parks money
              against a job, halts a dispute, decides a plan and stops a holder&rsquo;s wallet;{" "}
              <code>{REVEAL}</code> is the only one that reads a payee&rsquo;s whole number out of the
              encrypted line, and each time it does, the register records that it did.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="control-shell page-shell flex-1">
      <header className="flex flex-wrap items-center justify-between px-24 py-12"
        style={{ background: "var(--brand-deep)", borderBottom: "3px solid var(--adm-accent)" }}>
        <div>
          <p className="text-sm font-bold tracking-[0.08em] text-white">T ENGO AEGIS Control</p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--adm-accent)" }}>
            Super Admin · The office&rsquo;s book
          </p>
        </div>
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1100px] px-16 py-32">
        <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>{HEAD[tab]}</h1>
        <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{SUB[tab]}</p>

        {/* One page, five registers. Every tab is a read of `control.money.view`; the pens inside them
            are separate duties, so a seat that may fund a wallet but may not halt one sees the same
            five buttons and a different set of arms beneath them. */}
        <div className="mt-16 mb-8 flex flex-wrap gap-8" role="tablist"
          aria-label="The book and the three registers above it">
          {TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={k === tab} className={btn}
              onClick={() => pickTab(k)}
              style={k === tab
                ? { background: "var(--adm-accent)", color: "var(--brand-deep)", fontWeight: 800 }
                : { background: "var(--milk)", color: "var(--ink)" }}>
              {l}
            </button>
          ))}
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

        {tab === "book" && (
          <>

        {/* The one fact this desk exists to state, counted from the legs and not from the running
            columns the legs also keep. */}
        <div className="mt-12 mb-8 rounded-card border p-16"
          style={{
            borderColor: square?.square ? "var(--success)" : "var(--danger)",
            background: square?.square
              ? "color-mix(in srgb, var(--success) 8%, transparent)"
              : "color-mix(in srgb, var(--danger) 8%, transparent)"
          }}>
          {square?.square ? (
            <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
              The book squares.
              <span className="ml-8 font-normal" style={{ color: "var(--ink-soft)" }}>
                {square.postings} movements, {fig(totals?.debited)} debited against{" "}
                {fig(totals?.credited)} credited · every one balanced, two legs at least, counted
                from the legs themselves
              </span>
            </p>
          ) : (
            <>
              <p className="text-sm font-semibold" style={{ color: "var(--danger)" }}>
                {ready ? "The book does not square." : "Reading the book…"}
                {square && (
                  <span className="ml-8 font-normal" style={{ color: "var(--ink)" }}>
                    {square.unbalanced} unbalanced, {square.short_legged} with fewer than two legs,{" "}
                    {square.one_sided} all on one side, {square.figure_disagrees} whose header
                    disagrees with its legs.
                  </span>
                )}
              </p>
              {square && square.refs.length > 0 && (
                <p className="mt-8 break-all text-xs" style={{ color: "var(--ink-soft)" }}>
                  Named: {square.refs.join(", ")} — a movement that does not balance is not posted,
                  so one of these was written around a door.
                </p>
              )}
            </>
          )}
        </div>

        {drifted.length > 0 && (
          <div className="mb-16 rounded-input px-12 py-8 text-sm" role="alert"
            style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
            {drifted.length === 1 ? "One account" : `${drifted.length} accounts`} carry cached totals
            that disagree with their own legs: {drifted.map(a => a.code).join(", ")}. The recomputed
            column is the truth until the trigger is fixed.
          </div>
        )}

        {/* ---------- the counters, both sides of every question ---------- */}
        <div className="mb-24 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { k: "Movements", v: `${totals?.postings ?? 0}`, s: `${totals?.movements_reversed ?? 0} reversed · ${totals?.tzs_postings ?? 0} TZS / ${totals?.usd_postings ?? 0} USD` },
            { k: "Legs", v: `${totals?.legs ?? 0}`, s: `${totals?.accounts ?? 0} accounts, ${totals?.frozen_accounts ?? 0} frozen` },
            { k: "Debited", v: fig(totals?.debited), s: "credited " + fig(totals?.credited) },
            { k: "Out by", v: fig(Math.abs(totals?.out_by ?? 0)), s: (totals?.out_by ?? 0) === 0 ? "the two sides agree" : "the two sides disagree" }
          ].map(c => (
            <div key={c.k} className="rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>{c.k}</p>
              <p className="mt-4 text-xl font-bold" style={{ color: "var(--ink)" }}>{c.v}</p>
              <p className="mt-4 text-[11px]" style={{ color: "var(--ink-soft)" }}>{c.s}</p>
            </div>
          ))}
        </div>

        {/* ---------- the chart ---------- */}
        <section className="mb-24 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
          <div className="mb-12 flex flex-wrap items-center justify-between gap-12">
            <div>
              <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>The chart</h2>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                Both sets of figures are printed: the total the account keeps and the total counted
                from its legs. A balance is read on the side its kind puts it — assets and expenses
                grow when debited, the other three when credited. Select a line to stop or start it.
              </p>
            </div>
            {canPost && (
              <button className={btn} onClick={() => setShowOpen(o => !o)}>
                {showOpen ? "Close" : "Open an account"}
              </button>
            )}
          </div>

          {showOpen && canPost && (
            <div className="mb-16 rounded-card border p-16" style={{ borderColor: "var(--adm-line)", background: "var(--surface)" }}>
              <p className="mb-12 text-sm font-semibold" style={{ color: "var(--ink)" }}>
                A new line on the chart
              </p>
              <div className="grid gap-12 sm:grid-cols-2">
                <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Code</span>
                  <input className={cell} style={cellStyle} value={openForm.code} placeholder="OPS-FLOAT"
                    onChange={e => setOpenForm(f => ({ ...f, code: e.target.value }))} /></label>
                <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Label</span>
                  <input className={cell} style={cellStyle} value={openForm.label} placeholder="Office float"
                    onChange={e => setOpenForm(f => ({ ...f, label: e.target.value }))} /></label>
                <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Kind</span>
                  <select className={cell} style={cellStyle} value={openForm.kind}
                    onChange={e => setOpenForm(f => ({ ...f, kind: e.target.value }))}>
                    {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                  </select></label>
                <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Currency</span>
                  <select className={cell} style={cellStyle} value={openForm.currency}
                    onChange={e => setOpenForm(f => ({ ...f, currency: e.target.value }))}>
                    <option value="TZS">TZS</option><option value="USD">USD</option>
                  </select></label>
              </div>
              <label className="mt-12 block"><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                What this account holds (8 to 600 characters)</span>
                <textarea className={cell} style={cellStyle} rows={2} value={openForm.note}
                  onChange={e => setOpenForm(f => ({ ...f, note: e.target.value }))} /></label>
              <button className={`${btn} mt-12`} disabled={busy === "open" || openForm.code.trim().length < 2
                || openForm.label.trim().length < 3 || openForm.note.trim().length > 0
                && openForm.note.trim().length < 8}
                onClick={openAccount}>
                {busy === "open" ? "Opening…" : "Open it"}
              </button>
              <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                Codes are stored upper-case and one book cannot hold a code twice — two accounts for
                the same money is how a book stops meaning anything.
              </p>
            </div>
          )}

          {/* The line sits above the register, not in a cell of it. On a phone the table is its own
           *  scroller and a cell spans the columns' full intrinsic width — wider than the pane — so a
           *  sentence centred in one is laid out off-screen and the clerk reads a fragment of it. */}
          {ready && accounts.length === 0 && (
            <p className="mb-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              No account in the office&rsquo;s book.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-xs">
              <thead>
                <tr style={{ color: "var(--ink-soft)" }}>
                  {["Code", "Label", "Kind", "Money", "Cached debit", "Cached credit",
                    "Recomputed", "Legs", "Balance", "Last movement", ""].map(h => (
                    <th key={h} className="border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]"
                      style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {accounts.map(a => (
                  <tr key={a.id} className="cursor-pointer" style={{
                    background: picked?.id === a.id ? "color-mix(in srgb, var(--adm-accent) 10%, transparent)" : undefined
                  }} onClick={() => {
                    setPickedId(id => (id === a.id ? null : a.id));
                    setFreezeReason("");
                  }}>
                    <td className="border-b px-8 py-8 font-semibold" style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>
                      {a.code}
                      {a.status === "frozen" && (
                        <span className="ml-8 rounded-full px-8 py-2 text-[10px] font-bold uppercase tracking-[0.1em]"
                          style={{ background: "var(--danger)", color: "#fff" }}>Frozen</span>
                      )}
                    </td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>{a.label}</td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>{a.kind}</td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>{a.currency}</td>
                    <td className="border-b px-8 py-8 text-right" style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>{fig(a.cached.debit)}</td>
                    <td className="border-b px-8 py-8 text-right" style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>{fig(a.cached.credit)}</td>
                    <td className="border-b px-8 py-8 text-right" style={{
                      borderColor: "var(--adm-line)",
                      color: a.drift ? "var(--danger)" : "var(--ink-soft)"
                    }}>
                      {fig(a.recomputed.debit)} / {fig(a.recomputed.credit)}
                      {a.drift && <span className="ml-8 font-bold uppercase">drift</span>}
                    </td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>{a.entry_count}</td>
                    <td className="border-b px-8 py-8 text-right font-semibold" style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>
                      {fig(a.balance)} <span className="font-normal" style={{ color: "var(--ink-soft)" }}>{a.natural_side}</span>
                    </td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>{when(a.last_posted_at)}</td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>
                      <button className="underline" onClick={(e) => {
                        e.stopPropagation();
                        setQ(f => ({ ...f, account: f.account === a.id ? "" : a.id, offset: 0 }));
                      }}>
                        {q.account === a.id ? "clear filter" : "movements"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {picked && (
            <div className="mt-16 rounded-card border p-16" style={{ borderColor: "var(--adm-line)", background: "var(--surface)" }}>
              <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
                {picked.code} — {picked.label}
                <span className="ml-8 font-normal" style={{ color: "var(--ink-soft)" }}>
                  {picked.kind} · {picked.currency} · {picked.status} · opened {when(picked.opened_at)}
                </span>
              </p>
              {picked.note && (
                <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>{picked.note}</p>
              )}
              {picked.status === "frozen" && (
                <p className="mt-8 text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  Frozen: {picked.frozen_reason}
                </p>
              )}
              {canFreeze ? (
                <>
                  <label className="mt-12 block">
                    <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                      {picked.status === "frozen" ? "Why it can be lifted (kept in the history)"
                        : "Why this account is stopped — 8 characters at least"}
                    </span>
                    <input className={cell} style={cellStyle} value={freezeReason}
                      onChange={e => setFreezeReason(e.target.value)} />
                  </label>
                  <div className="mt-12 flex flex-wrap gap-12">
                    {picked.status !== "frozen" && (
                      <button className={btn} disabled={busy === `freeze:${picked.id}`
                        || freezeReason.trim().length < 8}
                        onClick={() => freeze(true)}>
                        {busy === `freeze:${picked.id}` ? "Freezing…" : "Freeze this account"}
                      </button>
                    )}
                    {picked.status === "frozen" && (
                      <button className={btn} disabled={busy === `freeze:${picked.id}`}
                        onClick={() => freeze(false)}>
                        {busy === `freeze:${picked.id}` ? "Opening…" : "Unfreeze it"}
                      </button>
                    )}
                  </div>
                  <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                    A freeze stops every movement that would touch the account. The book keeps one
                    reason per account rather than a history, so the words that lift it are written
                    to the forensic log, where the office&rsquo;s history actually lives.
                  </p>
                </>
              ) : (
                <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                  Stopping or starting an account needs <code>{FREEZE}</code>, which this seat does not
                  hold. Movements still post through this account as before.
                </p>
              )}
            </div>
          )}
        </section>

        {/* ---------- the register ---------- */}
        <section className="mb-24 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
          <div className="mb-12 flex flex-wrap items-center justify-between gap-12">
            <div>
              <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>The register</h2>
              <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                Newest first, {reg.returned} of {reg.count} movements on this page. Select one to read
                its legs, the paper it stands for and whatever answered it.
              </p>
            </div>
            {canPost && (
              <button className={btn} onClick={() => (showPost ? setShowPost(false) : startPost())}>
                {showPost ? "Close" : "Post a movement"}
              </button>
            )}
          </div>

          <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Status</span>
              <select className={cell} style={cellStyle} value={q.status}
                onChange={e => setQ(f => ({ ...f, status: e.target.value, offset: 0 }))}>
                <option value="all">all</option><option value="posted">posted</option>
                <option value="reversed">reversed</option>
              </select></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Currency</span>
              <select className={cell} style={cellStyle} value={q.currency}
                onChange={e => setQ(f => ({ ...f, currency: e.target.value, offset: 0 }))}>
                <option value="">any</option><option value="TZS">TZS</option><option value="USD">USD</option>
              </select></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Account</span>
              <select className={cell} style={cellStyle} value={q.account}
                onChange={e => setQ(f => ({ ...f, account: e.target.value, offset: 0 }))}>
                <option value="">any</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.label}</option>)}
              </select></label>
            <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Search the number or the words</span>
              <input className={cell} style={cellStyle} value={q.search} placeholder="PST-2026-000"
                onChange={e => setQ(f => ({ ...f, search: e.target.value }))} /></label>
          </div>

          {showPost && canPost && (
            <div className="mb-16 rounded-card border p-16" style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
              <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>A new movement</p>
              <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                Two legs at least, both sides, one currency for the whole paper. The book works the
                figure out from the legs before the movement exists, so a movement that does not
                balance is refused with both totals named — nothing is written and nothing is half-written.
              </p>
              <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
                <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>The day it moved</span>
                  <input className={cell} style={cellStyle} value={head.posted_on} placeholder="YYYY-MM-DD"
                    onChange={e => setHead(h => ({ ...h, posted_on: e.target.value }))} /></label>
                <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>Currency</span>
                  <select className={cell} style={cellStyle} value={head.currency}
                    onChange={e => setHead(h => ({ ...h, currency: e.target.value }))}>
                    <option value="TZS">TZS</option><option value="USD">USD</option>
                  </select></label>
                <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>What it stands for</span>
                  <select className={cell} style={cellStyle} value={head.source_kind}
                    onChange={e => setHead(h => ({ ...h, source_kind: e.target.value }))}>
                    {SOURCE_KINDS.filter(k => k !== "reversal").map(k => <option key={k} value={k}>{k}</option>)}
                  </select></label>
              </div>
              <label className="mt-12 block"><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Memo — 8 characters at least, the sentence a clerk will read in a year</span>
                <input className={cell} style={cellStyle} value={head.memo}
                  onChange={e => setHead(h => ({ ...h, memo: e.target.value }))} /></label>
              <label className="mt-12 block"><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                The paper it stands for (optional — an invoice or receipt number)</span>
                <input className={cell} style={cellStyle} value={head.source_ref} placeholder="INV-2026-041"
                  onChange={e => setHead(h => ({ ...h, source_ref: e.target.value }))} /></label>

              <div className="mt-16 space-y-12">
                {legs.map((l, i) => (
                  <div key={i} className="grid gap-8 sm:grid-cols-2 lg:grid-cols-[1fr_110px_120px_1fr_auto]">
                    <select className={cell} style={cellStyle} value={l.account} aria-label={`Leg ${i + 1} account`}
                      onChange={e => editLeg(i, "account", e.target.value)}>
                      <option value="">choose an account…</option>
                      {accounts.map(a => (
                        <option key={a.id} value={a.id} disabled={a.status === "frozen"}>
                          {a.code} — {a.label}{a.status === "frozen" ? " (frozen)" : ""}
                        </option>
                      ))}
                    </select>
                    <select className={cell} style={cellStyle} value={l.direction} aria-label={`Leg ${i + 1} side`}
                      onChange={e => editLeg(i, "direction", e.target.value)}>
                      <option value="debit">debit</option><option value="credit">credit</option>
                    </select>
                    <input className={cell} style={cellStyle} value={l.amount} inputMode="decimal"
                      placeholder="1500.00" aria-label={`Leg ${i + 1} amount`}
                      onChange={e => editLeg(i, "amount", e.target.value.replace(/,/g, ""))} />
                    <input className={cell} style={cellStyle} value={l.detail}
                      placeholder="why this line (optional)" aria-label={`Leg ${i + 1} detail`}
                      onChange={e => editLeg(i, "detail", e.target.value)} />
                    <button className="rounded-input px-8 py-8 text-xs" aria-label={`Remove leg ${i + 1}`}
                      style={{ border: "1px solid var(--adm-line)", color: "var(--danger)" }}
                      disabled={legs.length < 2}
                      onClick={() => setLegs(x => x.filter((_, n) => n !== i))}>
                      remove
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-12 flex flex-wrap items-center gap-12">
                <button className={btn} onClick={() => addLeg({})}>Add a leg</button>
                <p className="text-xs" style={{ color: squares ? "var(--success)" : "var(--ink-soft)" }}>
                  This desk&rsquo;s own adding-up: {fig(debitC / 100)} debited against {fig(creditC / 100)} credited —{" "}
                  {legs.length < 2 ? "a movement needs two legs"
                    : badLeg ? "a leg has no account or a figure with more than two decimals"
                      : squares ? "it squares. The book decides, not this line."
                        : `out by ${fig(Math.abs(debitC - creditC) / 100)} — the book will refuse it`}
                </p>
              </div>

              <p className="mt-12 break-all text-[11px]" style={{ color: "var(--ink-soft)" }}>
                Sent under <code className="px-4" style={{ background: "var(--milk-deep)" }}>Idempotency-Key: {idem}</code>{" "}
                — if this request is retried, the book answers with the movement it already made instead
                of booking the same money twice.
              </p>

              <button className={`${btn} mt-12`} disabled={!squares || busy === "post"
                || head.memo.trim().length < 8 || !/^\d{4}-\d{2}-\d{2}$/.test(head.posted_on)}
                style={armed === `post:${paper}`
                  ? { background: "var(--danger)", color: "#fff" } : undefined}
                onClick={arm(`post:${paper}`, () => { void post(); })}>
                {busy === "post" ? "Posting…" : armed === `post:${paper}`
                  ? `Tap again to post ${fig(debitC / 100)} ${head.currency} across ${legs.length} legs`
                  : "Post it"}
              </button>
              {armed === `post:${paper}` && busy !== "post" && (
                <p className="mt-8 text-xs" style={{ color: "var(--danger)" }}>
                  The book keeps this paper as it is typed, and 133 gives the desk no way to change a
                  leg afterwards. Changing any figure or line above takes this warning off.
                </p>
              )}
            </div>
          )}

          {ready && reg.rows.length === 0 && (
            <p className="mb-8 text-xs" style={{ color: "var(--ink-soft)" }}>
              Nothing in the book answers those filters.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-xs">
              <thead>
                <tr style={{ color: "var(--ink-soft)" }}>
                  {["Number", "Day", "Memo", "Total", "Which way", "Stands for", "Status", "By"].map(h => (
                    <th key={h} className="border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]"
                      style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reg.rows.map(r => (
                  <tr key={r.id} className="cursor-pointer align-top" style={{
                    background: detailFor === r.id
                      ? "color-mix(in srgb, var(--adm-accent) 10%, transparent)" : undefined
                  }} onClick={() => openMovement(r.id)}>
                    <td className="border-b px-8 py-8 font-mono" style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>{r.ref}</td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>{r.posted_on}</td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>{r.memo}</td>
                    <td className="border-b px-8 py-8 text-right whitespace-nowrap" style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>
                      {fig(r.total)} <span style={{ color: "var(--ink-soft)" }}>{r.currency}</span>
                    </td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>{r.moved}</td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>
                      {r.source_kind}{r.source_ref ? ` · ${r.source_ref}` : ""}
                    </td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: r.status === "reversed" ? "var(--danger)" : "var(--success)" }}>
                      {r.status}
                    </td>
                    <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>{r.raised_by ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-12 flex flex-wrap items-center gap-12">
            <button className={btn} disabled={q.offset === 0 || busy !== null}
              onClick={() => setQ(f => ({ ...f, offset: Math.max(0, f.offset - 60) }))}>Newer</button>
            <button className={btn} disabled={q.offset + 60 >= reg.count || busy !== null}
              onClick={() => setQ(f => ({ ...f, offset: f.offset + 60 }))}>Older</button>
            <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
              {reg.returned} shown of {reg.count} matching · page {Math.floor(q.offset / 60) + 1}
            </p>
          </div>

          {detail && (
            <div className="mt-16 rounded-card border p-16" style={{ borderColor: "var(--adm-accent)", background: "var(--surface)" }}>
              <div className="flex flex-wrap items-start justify-between gap-12">
                <div className="min-w-0">
                  <p className="text-sm font-bold" style={{ color: "var(--ink)" }}>
                    {detail.ref} <span className="font-normal" style={{ color: "var(--ink-soft)" }}>
                      · {detail.posted_on} · {fig(detail.total)} {detail.currency} · {detail.status}
                    </span>
                  </p>
                  <p className="mt-4 text-sm" style={{ color: "var(--ink)" }}>{detail.memo}</p>
                  <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>
                    written by {detail.raised_by_name ?? "a seat with no name"} on{" "}
                    {when(detail.raised_at)} · stands for {detail.source_kind}
                    {detail.source_ref ? ` (${detail.source_ref})` : ""}
                  </p>
                </div>
                <button className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                  onClick={() => { setDetail(null); setDetailFor(null); }}>close</button>
              </div>

              {detail.reversal_note && (
                <p className="mt-12 text-xs font-semibold" style={{ color: "var(--danger)" }}>
                  Reversed by {detail.reversed_by_name ?? "a seat"}: {detail.reversal_note}
                </p>
              )}
              {detail.answered_by && (
                <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  Answered by {detail.answered_by.ref} on {detail.answered_by.posted_on}.
                </p>
              )}
              {detail.answers && detail.answers.length > 0 && (
                <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  Mirrors raised against this paper: {detail.answers.map(a => a.ref).join(", ")}.
                </p>
              )}

              <div className="mt-12 overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-xs">
                  <thead>
                    <tr style={{ color: "var(--ink-soft)" }}>
                      {["Side", "Account", "Amount", "Line"].map(h => (
                        <th key={h} className="border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]"
                          style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {detail.legs.map(l => (
                      <tr key={l.id}>
                        <td className="border-b px-8 py-8 font-semibold" style={{
                          borderColor: "var(--adm-line)",
                          color: l.direction === "debit" ? "var(--ink)" : "var(--ink-soft)"
                        }}>{l.direction}</td>
                        <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>
                          {l.code} — {l.label}
                        </td>
                        <td className="border-b px-8 py-8 text-right whitespace-nowrap" style={{ borderColor: "var(--adm-line)", color: "var(--ink)" }}>
                          {fig(l.amount)} {l.currency}
                        </td>
                        <td className="border-b px-8 py-8" style={{ borderColor: "var(--adm-line)", color: "var(--ink-soft)" }}>
                          {l.detail ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {canPost && (
                detail.source_kind === "reversal" ? (
                  <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {detail.ref} is itself a reversal. Undoing an undoing is a fresh movement, written
                    out with its own words — post one above.
                  </p>
                ) : detail.status === "reversed" ? (
                  <p className="mt-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                    {detail.ref} has already been answered. A book is corrected by a second movement,
                    never by a second edit of the first.
                  </p>
                ) : (
                  <>
                    <label className="mt-12 block">
                      <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                        Why {detail.ref} is being reversed — 8 characters at least
                      </span>
                      <input className={cell} style={cellStyle} value={reverseReason}
                        placeholder="Posted against the wrong month"
                        onChange={e => setReverseReason(e.target.value)} />
                    </label>
                    <button className={`${btn} mt-12`} disabled={busy === `reverse:${detail.id}`
                      || reverseReason.trim().length < 8}
                      style={armed === `reverse:${detail.id}:${reverseReason.trim()}`
                        ? { background: "var(--danger)", color: "#fff" } : undefined}
                      onClick={arm(`reverse:${detail.id}:${reverseReason.trim()}`,
                        () => { void reverse(); })}>
                      {busy === `reverse:${detail.id}` ? "Reversing…"
                        : armed === `reverse:${detail.id}:${reverseReason.trim()}`
                          ? `Tap again to reverse ${detail.ref} for good` : "Post its mirror"}
                    </button>
                    <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                      The mirror carries its own number and points back here; this row gains only the
                      two facts that it has been reversed and by whom, which is all the header&rsquo;s
                      own guard will let it gain.
                    </p>
                  </>
                )
              )}
            </div>
          )}
        </section>

        <p className="text-xs" style={{ color: "var(--ink-soft)" }}>
          Money is never edited here. <code>{POST}</code> opens an account, posts a movement and answers
          one; <code>{FREEZE}</code> stops an account and starts it again; both write to the forensic
          log beside the book, so a movement whose history was lost is a movement that did not happen.
          This is the office&rsquo;s own book — a company&rsquo;s ledger is the same tables under a
          different seat and is not reachable from a control session.
        </p>
          </>
        )}

        {tab !== "book" && <MoneyMoves tab={tab} desk={desk} />}
      </main>
    </div>
  );
}
