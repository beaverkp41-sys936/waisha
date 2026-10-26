"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ControlNav } from "@/components/ControlNav";
import { PricingAsk, type Corridor, type Desk, type Dim } from "./ask";
import { PricingCardPanel } from "./card";

const API = process.env.NEXT_PUBLIC_API_ORIGIN ?? "http://localhost:4000";

const VIEW = "control.pricing.view";
const MANAGE = "control.pricing.manage";
const PUBLISH = "control.pricing.publish";

const cell = "w-full rounded-input border px-8 py-8 text-sm";
const cellStyle = { borderColor: "var(--adm-line)", background: "var(--milk)" };
const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
const btn = "waisha-btn rounded-input px-16 py-8 text-xs font-semibold";
const th = "border-b px-8 py-8 text-left font-semibold uppercase tracking-[0.1em]";
const td = "border-b px-8 py-8 align-top text-sm";

const PAGE = 30;
const ROAD_PAGE = 60;

type Tab = "lists" | "roads" | "ask";
const TABS: [Tab, string][] = [["lists", "Price lists"], ["roads", "Roads it prices"], ["ask", "Ask the register"]];

/** The five states a card can be in, and the pile the desk filters it into. `counts` from the board
 *  answer only names the states that have rows, so the pile list is the register's own and not a guess. */
const PILES: [string, string][] = [
  ["all", "Everything"], ["draft", "Drafts"], ["pending_signature", "Papers out"],
  ["published", "Live"], ["superseded", "Superseded"], ["withdrawn", "Withdrawn"]
];

const HEAD: Record<Tab, string> = {
  lists: "The office’s price lists",
  roads: "The corridors this book can price",
  ask: "What a job costs"
};
const SUB: Record<Tab, string> = {
  lists: "Every version the office has opened, is being asked to sign, has stood live or has stopped — "
    + "with the figures, the paper raised against it and the memory of what a signature changed.",
  roads: "A price that names a road prices that road. The register refuses a per-kilometre figure on a "
    + "corridor nobody measured, so this board says which of its roads have a distance and how many lists "
    + "already carry a line along them.",
  ask: "Two questions the register answers itself: what stands for one scope on one day, and what a job "
    + "of a given size costs. Neither is worked out on this screen."
};

interface BoardRow {
  id: string; ref: string; code: string; label: string; currency: string; status: string;
  version: number; effective_from: string | null; effective_to: string | null;
  line_count: number; cheapest: string | null; refusals: number; approval_id: string | null;
  approval_status: string | null; published_by: string | null; published_at: string | null;
  published_note: string | null; withdrawn_reason: string | null; supersedes: string | null;
  updated_at: string;
}

/** The door's refusal extras are the register's own facts (`ref`, `status`, `asked`), and they carry
 *  neither `field` nor `message`, so the money desk's formatter would print them empty and drop the
 *  half of the answer that names which list is in the way. Both shapes are kept here. */
function message(j: any, fallback: string) {
  const m = j?.error?.message ?? (j?.error?.code === "FORBIDDEN"
    ? `This seat holds no ${VIEW.split(".").pop()} duty, so the price register is closed to it.`
    : fallback);
  const hints: string[] = [];
  for (const d of (j?.error?.details ?? []) as any[]) {
    const words = String(d?.message ?? "").trim();
    const where = String(d?.field ?? "").trim();
    if (words || where) { hints.push(words ? (where ? `${where}: ${words}` : words) : where); continue; }
    for (const [k, v] of Object.entries(d ?? {})) {
      if (v === null || v === undefined || v === "") continue;
      // An object extra is another register's whole answer quoted underneath the sentence that already
      // quotes it (`approval_answer` under "The signature was not answered: …"), so a clerk would read
      // the same words twice, one of them inside braces. Scalars stay: they name the list in the way.
      if (typeof v === "object") continue;
      hints.push(`${k} ${String(v)}`);
    }
  }
  return hints.length ? `${m} — ${hints.slice(0, 4).join("; ")}` : m;
}

/** One door call, shared by every panel on the desk: the same cookies, the same sentence for a refusal. */
async function call(path: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${API}/api/v1${path}`, {
    method, credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(message(j, `The desk refused (${res.status})`));
  return j;
}

const fig = (v: unknown) => Number(v ?? 0).toLocaleString("en-US",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * The freight price desk (140).
 *
 * Three duties, and the desk shows the difference between them rather than hiding it. Reading is
 * `control.pricing.view`: the board, one list, its memory, its corridors and the two doors that answer
 * what a job costs. Writing is `control.pricing.manage`: a draft, its figures, its header, a corridor, a
 * clone and a withdrawal. The paper is `control.pricing.publish` — and this desk only ever raises it or
 * refuses it. **No button here makes a price live.** That happens on the Approvals desk, by the seat that
 * signs, through 121's `price_publish` effect, because a desk that could edit a figure and publish it
 * alone is a desk that never needed a second person.
 *
 * Every assertion the panels make about what is allowed comes from migration 140's own refusals
 * (`paper_is_out`, `already_lived`, `figures_are_typed`, `no_prices`, `no_start`, `nothing_to_clone`), so
 * a button that is disabled states the rule that disables it instead of inventing a friendlier one.
 *
 * The whole book is one office's: the doors read the tenant out of the control session and nothing else,
 * so a seat sees its own company's prices and no other's.
 */
export default function ControlPricingPage() {
  const [me, setMe] = useState<any>(null);
  const [perms, setPerms] = useState<string[]>([]);
  // The duty list answers a beat after the seat does, so an empty `perms` proves nothing on its own —
  // without this flag the desk's first paint would tell a pricing clerk that it cannot see its own book.
  const [permsKnown, setPermsKnown] = useState(false);
  const [tab, setTab] = useState<Tab>("lists");
  const [board, setBoard] = useState<{ rows: BoardRow[]; total: number; counts: Record<string, number> }>(
    { rows: [], total: 0, counts: {} });
  const [f, setF] = useState({ status: "all", code: "", search: "", offset: 0 });
  const [corridors, setCorridors] = useState<{ rows: Corridor[]; total: number; offset: number }>(
    { rows: [], total: 0, offset: 0 });
  const [roadQ, setRoadQ] = useState({ search: "", offset: 0 });
  const [dims, setDims] = useState<Dim[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [showOpen, setShowOpen] = useState(false);
  const [openForm, setOpenForm] = useState({ code: "", label: "", currency: "TZS", effective_from: "", note: "" });
  const [roadForm, setRoadForm] = useState({ name: "", origin: "", dest: "", distance_km: "" });
  const [ready, setReady] = useState(false);

  const canView = perms.includes(VIEW);
  const canManage = perms.includes(MANAGE);
  const canPublish = perms.includes(PUBLISH);

  const notify = useCallback((s: string) => { setNotice(s); setError(null); }, []);
  const fault = useCallback((s: string) => { setError(s); setNotice(null); }, []);
  // Stable across renders so a panel's read effect re-runs when the card it is showing changes, and not
  // every time the page repaints behind it.
  const desk: Desk = useMemo(() => ({
    call, fig, today, notify, fault, can: { manage: canManage, publish: canPublish }
  }), [notify, fault, canManage, canPublish]);

  const readBoard = useCallback(async (q: typeof f) => {
    const parts = [`limit=${PAGE}`, `offset=${q.offset}`];
    if (q.status !== "all") parts.push(`status=${q.status}`);
    if (q.code.trim()) parts.push(`code=${encodeURIComponent(q.code.trim())}`);
    if (q.search.trim()) parts.push(`search=${encodeURIComponent(q.search.trim())}`);
    try {
      const j = await call(`/control/pricing/board?${parts.join("&")}`);
      setBoard({ rows: (j.rows ?? []) as BoardRow[], total: Number(j.total ?? 0),
        counts: (j.counts ?? {}) as Record<string, number> });
    } catch (e) { fault((e as Error).message); }
  }, [fault]);

  const readRoads = useCallback(async (q: typeof roadQ) => {
    const parts = [`limit=${ROAD_PAGE}`, `offset=${q.offset}`];
    if (q.search.trim()) parts.push(`search=${encodeURIComponent(q.search.trim())}`);
    try {
      const j = await call(`/control/pricing/corridors?${parts.join("&")}`);
      setCorridors({ rows: (j.rows ?? []) as Corridor[], total: Number(j.total ?? 0),
        offset: Number(j.offset ?? q.offset) });
    } catch (e) { fault((e as Error).message); }
  }, [fault]);

  async function load() {
    const m = await fetch(`${API}/api/v1/control/auth/me`, { credentials: "include" });
    if (!m.ok) { window.location.href = "/control/login"; return; }
    setMe(await m.json());
    const p = await fetch(`${API}/api/v1/control/auth/permissions`, { credentials: "include" });
    if (p.ok) {
      setPerms((await p.json()).permissions ?? []);
      setPermsKnown(true);
    } else {
      setError(message(await p.json().catch(() => ({})),
        "The desk could not read this seat's duties, so it cannot show its pens. The lists below are "
        + "still the register's own answer."));
    }
    // The vocabulary is read before anything else: every picker on this desk — class, container, basis —
    // is built from `pricing_dimensions`, so a basis 141 adds appears here without this file being edited.
    try {
      const d = await call("/control/pricing/dimensions");
      setDims((d.rows ?? []) as Dim[]);
    } catch (e) {
      setError((e as Error).message);
    }
    setReady(true);
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!canView) return;
    const t = setTimeout(() => { void readBoard(f); }, 260);
    return () => clearTimeout(t);
  }, [f.status, f.code, f.search, f.offset, canView, readBoard]);
  // `search` is typed, so it is the one filter that also sends the clerk back to the first page.
  useEffect(() => { setF(x => ({ ...x, offset: 0 })); }, [f.search, f.status, f.code]);

  useEffect(() => {
    if (!canView) return;
    const t = setTimeout(() => { void readRoads(roadQ); }, 260);
    return () => clearTimeout(t);
  }, [roadQ.search, roadQ.offset, canView, readRoads]);
  useEffect(() => { setRoadQ(x => ({ ...x, offset: 0 })); }, [roadQ.search]);

  function pickTab(t: Tab) { setTab(t); setError(null); setNotice(null); }

  /** A press the desk is proud of: the board is re-read, so the pile counts beside the new list are the
   *  register's answer rather than arithmetic this screen did on its own. */
  async function run(key: string, fn: () => Promise<any>, then: (j: any) => string) {
    setBusy(key); setError(null); setNotice(null); setArmed(null);
    try {
      const j = await fn();
      await readBoard(f);
      setNotice(then(j));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setTimeout(() => setNotice(null), 14000);
    }
  }

  const arm = (key: string, go: () => void) => () => {
    if (armed !== key) { setArmed(key); return; }
    go();
  };

  const openReady = openForm.code.trim().length >= 2 && openForm.label.trim().length >= 3
    && openForm.note.trim().length >= 8;
  const roadReady = roadForm.name.trim().length >= 3 && roadForm.origin.trim().length >= 2
    && roadForm.dest.trim().length >= 2;

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
              The price register is closed to this seat
            </h1>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Signed in as {me?.email ?? "a platform seat"} with {(me?.roles ?? []).join(", ")
                || "no platform duty"}. Reading the lists, their versions and their memory needs{" "}
              <code>{VIEW}</code>.
            </p>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Opening a draft, writing a figure, filing a corridor, cloning a version and stopping a price
              need <code>{MANAGE}</code>. Putting a list up for a second seat, and refusing a paper that is
              out, need <code>{PUBLISH}</code> — which 140 keeps away from <code>{MANAGE}</code> on purpose,
              the way 135 kept the count away from the pen: a seat that writes the figures and signs them
              alone has not needed anybody since the day the register opened.
            </p>
            <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
              Nothing on this desk makes a price live, in any seat. That is decided on Approvals by the seat
              that holds the signature.
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
            {(me?.roles ?? []).join(" · ") || "A platform seat"} · The office&rsquo;s prices
          </p>
        </div>
        <ControlNav />
      </header>

      <main className="mx-auto max-w-[1100px] px-16 py-32">
        <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>{HEAD[tab]}</h1>
        <p className="mt-4 text-xs" style={{ color: "var(--ink-soft)" }}>{SUB[tab]}</p>

        <div className="mt-16 mb-8 flex flex-wrap gap-8" role="tablist" aria-label="The price register">
          {TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={k === tab} className={btn} onClick={() => pickTab(k)}
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

        {tab === "lists" && (
          <>
            {/* The piles are the register's own counts over the whole book, not a tally of the page the
                clerk is looking at — a heading that says "3 drafts" while the page shows 30 of 400 is a
                heading nobody can navigate by. */}
            <div className="mb-12 flex flex-wrap gap-8" role="group" aria-label="Piles of price lists">
              {PILES.map(([k, l]) => (
                <button key={k} className={btn} onClick={() => setF(x => ({ ...x, status: k }))}
                  aria-pressed={f.status === k}
                  style={f.status === k
                    ? { background: "var(--adm-accent)", color: "var(--brand-deep)", fontWeight: 800 }
                    : { background: "var(--milk)", color: "var(--ink)" }}>
                  {l}
                  <span className="ml-6 font-normal">{k === "all" ? board.total : board.counts[k] ?? 0}</span>
                </button>
              ))}
            </div>

            <div className="mb-16 grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Search the book
                <input className={`${cell} mt-4`} style={cellStyle} value={f.search}
                  placeholder="a label, a code, a PRC- number or a road it prices"
                  onChange={e => setF(x => ({ ...x, search: e.target.value }))} /></span></label>
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Only one list code
                <input className={`${cell} mt-4`} style={cellStyle} value={f.code}
                  placeholder="FREIGHT-STD" onChange={e => setF(x => ({ ...x, code: e.target.value }))} /></span></label>
              <div className="self-end text-xs" style={{ color: "var(--ink-soft)" }}>
                A search reaches the corridors a list prices, not only the name the office gave it: the
                question at this desk is “is there a price for Kigoma”.
              </div>
            </div>

            {canManage && (
              <div className="mb-20">
                {!showOpen ? (
                  <button className={btn} onClick={() => setShowOpen(true)}>Open a price list</button>
                ) : (
                  <div className="rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
                    <h2 className="text-sm font-bold" style={{ color: "var(--ink)" }}>Open a draft list</h2>
                    <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                      The reference number and the version are minted by the register off the code, so a
                      second draft called FREIGHT-STD comes back as version 2 with its own PRC- number. A
                      draft prices nothing until a second seat signs it.
                    </p>
                    <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
                      <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                        Code
                        <input className={`${cell} mt-4`} style={cellStyle} value={openForm.code}
                          placeholder="FREIGHT-STD"
                          onChange={e => setOpenForm(x => ({ ...x, code: e.target.value }))} /></span></label>
                      <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                        Label
                        <input className={`${cell} mt-4`} style={cellStyle} value={openForm.label}
                          placeholder="Standard freight, Dar es Salaam corridor"
                          onChange={e => setOpenForm(x => ({ ...x, label: e.target.value }))} /></span></label>
                      <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                        Money
                        <select className={`${cell} mt-4`} style={cellStyle} value={openForm.currency}
                          onChange={e => setOpenForm(x => ({ ...x, currency: e.target.value }))}>
                          <option value="TZS">TZS</option>
                          <option value="USD">USD</option>
                        </select></span></label>
                      <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                        In force from (blank is no start yet)
                        <input className={`${cell} mt-4`} style={cellStyle} value={openForm.effective_from}
                          placeholder={today()}
                          onChange={e => setOpenForm(x => ({ ...x, effective_from: e.target.value }))} /></span></label>
                      <label className="lg:col-span-2"><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                        Note the second seat will read
                        <textarea className={`${cell} mt-4`} style={cellStyle} rows={2} maxLength={600}
                          value={openForm.note} placeholder="What this list is for, and what it replaces"
                          onChange={e => setOpenForm(x => ({ ...x, note: e.target.value }))} /></span></label>
                    </div>
                    {!openForm.effective_from.trim() && (
                      <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                        Left without a start date, the register will refuse to put this list up for a
                        signature — a price with no day cannot be the price for any day.
                      </p>
                    )}
                    <div className="mt-12 flex flex-wrap gap-12">
                      <button className={btn} disabled={!openReady || busy !== null}
                        onClick={() => void run("open", () => call("/control/pricing/cards", "POST", {
                          code: openForm.code.trim(), label: openForm.label.trim(),
                          currency: openForm.currency,
                          effective_from: openForm.effective_from.trim() || undefined,
                          note: openForm.note.trim()
                        }), (j) => {
                          const c = j?.card;
                          setShowOpen(false);
                          setOpenForm({ code: "", label: "", currency: "TZS", effective_from: "", note: "" });
                          if (c?.id) setPickedId(c.id);
                          return `${c?.ref ?? "A new list"} v${c?.version ?? ""} is open as a draft — `
                            + "nothing on it is quoted until a second seat signs it.";
                        })}>
                        {busy === "open" ? "The register is writing it…" : "Open the draft"}
                      </button>
                      <button className="text-xs underline" style={{ color: "var(--ink-soft)" }}
                        onClick={() => setShowOpen(false)}>cancel</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
                    {["List", "State", "Figures", "Window", "Paper", "Money", "Touched"].map(h => (
                      <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {board.rows.map(r => (
                    <tr key={r.id}
                      onClick={() => setPickedId(pickedId === r.id ? null : r.id)}
                      style={pickedId === r.id
                        ? { background: "color-mix(in srgb, var(--adm-accent) 10%, transparent)" }
                        : { cursor: "pointer" }}>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                        <span className="block font-semibold" style={{ color: "var(--ink)" }}>{r.label}</span>
                        <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                          <span className="font-mono">{r.ref}</span> · v{r.version} · {r.code}
                          {r.supersedes ? ` · answers ${r.supersedes}` : ""}
                        </span>
                      </td>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                        {r.status.replace(/_/g, " ")}
                        {r.withdrawn_reason ? (
                          <span className="block text-xs" style={{ color: "var(--danger)" }}>
                            stopped: {r.withdrawn_reason.slice(0, 60)}
                          </span>
                        ) : null}
                      </td>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                        {r.line_count}
                        {r.cheapest ? (
                          <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                            from {r.cheapest} {r.currency}
                          </span>
                        ) : null}
                      </td>
                      <td className={`${td} whitespace-nowrap`} style={{ borderColor: "var(--adm-line)" }}>
                        {r.effective_from ?? "no start"} → {r.effective_to ?? "no end"}
                      </td>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                        {r.approval_status
                          ? <span>{r.approval_status}{r.refusals ? ` · refused ${r.refusals}×` : ""}</span>
                          : r.refusals
                            ? <span style={{ color: "var(--danger)" }}>refused {r.refusals}×</span>
                            : <span style={{ color: "var(--ink-soft)" }}>
                                {r.published_by ? `signed by ${r.published_by}` : "no paper"}
                              </span>}
                      </td>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>{r.currency}</td>
                      <td className={`${td} whitespace-nowrap`} style={{ borderColor: "var(--adm-line)" }}>
                        {r.updated_at.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                  {!board.rows.length && ready && (
                    <tr>
                      <td className={td} colSpan={7} style={{ borderColor: "var(--adm-line)" }}>
                        {canView
                          ? "No list in this book matches the pile and the words above it. Open a draft, or "
                            + "clear the filters — a price that has never been set is not a price of zero."
                          : "Reading the register…"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-16 flex flex-wrap items-center gap-12">
              <button className={btn} disabled={f.offset <= 0 || busy !== null}
                onClick={() => setF(x => ({ ...x, offset: Math.max(0, x.offset - PAGE) }))}>Newer {PAGE}</button>
              <button className={btn} disabled={f.offset + PAGE >= board.total || busy !== null}
                onClick={() => setF(x => ({ ...x, offset: x.offset + PAGE }))}>More</button>
              <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                {board.total} list{board.total === 1 ? "" : "s"} in this pile · showing{" "}
                {f.offset + 1}–{Math.min(board.total, f.offset + board.rows.length)}
              </span>
            </div>

            {/* Keyed on the card, not on the panel: a second list opened beside this one must not inherit
                the label typed into the first one's form. A clone is the same case seen from the other
                side — the answer is a different card, so the desk moves to it rather than holding the new
                draft's figures under the old list's number. */}
            {pickedId && (
              <PricingCardPanel key={pickedId} desk={desk} cardId={pickedId} dims={dims}
                corridors={corridors.rows} onClose={() => setPickedId(null)}
                onGoto={setPickedId} refresh={() => readBoard(f)} />
            )}
          </>
        )}

        {tab === "roads" && (
          <>
            <div className="mb-16 grid gap-12 sm:grid-cols-2">
              <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                Find a corridor
                <input className={`${cell} mt-4`} style={cellStyle} value={roadQ.search}
                  placeholder="Kigoma, Dar → Mwanza, a road name"
                  onChange={e => setRoadQ(x => ({ ...x, search: e.target.value }))} /></span></label>
              <div className="self-end text-xs" style={{ color: "var(--ink-soft)" }}>
                {corridors.total} road{corridors.total === 1 ? "" : "s"} this book may price a line along.
              </div>
            </div>

            {canManage && (
              <div className="mb-20 rounded-card border p-16" style={{ borderColor: "var(--adm-line)" }}>
                <h2 className="text-sm font-bold" style={{ color: "var(--ink)" }}>File a corridor of this book</h2>
                <p className="mt-4 mb-12 text-xs" style={{ color: "var(--ink-soft)" }}>
                  The register files its own roads, into the book that asked — a line keyed on a corridor
                  that is not in this book is refused before it is written. A road with no distance is still
                  worth filing, but nothing per kilometre can be priced along it until somebody measures it.
                </p>
                <div className="grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
                  <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                    Name
                    <input className={`${cell} mt-4`} style={cellStyle} value={roadForm.name}
                      placeholder="Dar es Salaam → Kigoma"
                      onChange={e => setRoadForm(x => ({ ...x, name: e.target.value }))} /></span></label>
                  <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                    From
                    <input className={`${cell} mt-4`} style={cellStyle} value={roadForm.origin}
                      placeholder="Dar es Salaam"
                      onChange={e => setRoadForm(x => ({ ...x, origin: e.target.value }))} /></span></label>
                  <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                    To
                    <input className={`${cell} mt-4`} style={cellStyle} value={roadForm.dest}
                      placeholder="Kigoma" onChange={e => setRoadForm(x => ({ ...x, dest: e.target.value }))} /></span></label>
                  <label><span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                    Kilometres (whole)
                    <input className={`${cell} mt-4`} style={cellStyle} value={roadForm.distance_km}
                      inputMode="decimal" placeholder="985"
                      onChange={e => setRoadForm(x => ({ ...x, distance_km: e.target.value }))} /></span></label>
                </div>
                {/* Armed by a second tap: 140 files a corridor into `routes` and offers no door that takes
                    one back, so this is the one press on this page that the desk cannot undo. */}
                <button className={`${btn} mt-12`} disabled={!roadReady || busy !== null}
                  onClick={arm("road", () => void run("road", () => call("/control/pricing/corridors", "POST", {
                    name: roadForm.name.trim(), origin: roadForm.origin.trim(),
                    dest: roadForm.dest.trim(),
                    distance_km: roadForm.distance_km.trim() || undefined
                  }), (j) => {
                    setRoadForm({ name: "", origin: "", dest: "", distance_km: "" });
                    void readRoads(roadQ);
                    // The corridor board answers with the register's own sentence about what it wrote —
                    // including whether the road has a distance. It is the desk's news, not a paraphrase.
                    return j?.message ?? `${j?.corridor?.name ?? "The corridor"} is filed.`;
                  }))}>
                  {armed === "road" ? "Press again to file it in this book"
                    : busy === "road" ? "Filing…" : "File the corridor"}
                </button>
                <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  A second road of the same name in one book is refused: two cards priced along two roads
                  of one name is a price nobody can be held to.
                </p>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr style={{ color: "var(--ink-soft)", background: "var(--milk)" }}>
                    {["Corridor", "Ends", "Distance", "Run time", "Class", "Priced on"].map(h => (
                      <th key={h} className={th} style={{ borderColor: "var(--adm-line)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {corridors.rows.map(c => (
                    <tr key={c.id}>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                        <span className="block font-semibold" style={{ color: "var(--ink)" }}>{c.name}</span>
                        {c.corridor ? (
                          <span className="block text-xs" style={{ color: "var(--ink-soft)" }}>
                            {c.corridor}
                          </span>
                        ) : null}
                      </td>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                        {c.origin} → {c.dest}
                      </td>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                        {c.distance_km === null ? (
                          <span style={{ color: "var(--danger)" }}>no distance filed</span>
                        ) : `${c.distance_km} km`}
                      </td>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                        {c.duration_hours !== null ? `${c.duration_hours} h` : "—"}
                      </td>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>{c.road_class ?? "—"}</td>
                      <td className={td} style={{ borderColor: "var(--adm-line)" }}>
                        {c.priced_on
                          ? `${c.priced_on} list${c.priced_on === 1 ? "" : "s"}`
                          : "not yet priced"}
                      </td>
                    </tr>
                  ))}
                  {!corridors.rows.length && ready && (
                    <tr>
                      <td className={td} colSpan={6} style={{ borderColor: "var(--adm-line)" }}>
                        This book files no corridor that matches. Until one is filed, every line on every
                        list here is a wildcard — and no per-kilometre price can be written at all.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-16 flex flex-wrap items-center gap-12">
              <button className={btn} disabled={corridors.offset <= 0}
                onClick={() => setRoadQ(x => ({ ...x, offset: Math.max(0, x.offset - ROAD_PAGE) }))}>
                First roads
              </button>
              <button className={btn} disabled={corridors.offset + ROAD_PAGE >= corridors.total}
                onClick={() => setRoadQ(x => ({ ...x, offset: x.offset + ROAD_PAGE }))}>More roads</button>
              <span className="text-xs" style={{ color: "var(--ink-soft)" }}>
                showing {corridors.offset + 1}–{Math.min(corridors.total, corridors.offset + corridors.rows.length)}
                {" "}of {corridors.total}
              </span>
            </div>
          </>
        )}

        {tab === "ask" && <PricingAsk desk={desk} dims={dims} corridors={corridors.rows} />}

        <p className="mt-24 text-xs" style={{ color: "var(--ink-soft)" }}>
          {dims.filter(d => d.kind === "basis").length} bases, {" "}
          {dims.filter(d => d.kind === "vehicle_class").length} vehicle classes and{" "}
          {dims.filter(d => d.kind === "container").length} container kinds are what this register prices
          on, read from the book itself. A list only changes after it has lived by being cloned forward, and
          the version a customer was quoted is never rewritten.
        </p>
      </main>
    </div>
  );
}
