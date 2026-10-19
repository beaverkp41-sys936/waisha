"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, seatPermissions } from "../../api-client";

function errorText(json: any, fallback: string): string {
  const d = json?.error?.details;
  const extra = Array.isArray(d) && d.length
    ? ` (${d.map((x: any) => `${x.field ? `${x.field}: ` : ""}${x.message ?? ""}`).join("; ")})`
    : "";
  return (json?.error?.message ?? fallback) + extra;
}
const readJson = (res: Response) => res.json().catch(() => null) as Promise<any>;

// ---------------------------------------------------------------------------
// Shapes the finance API answers with. Every money figure is a number rounded
// to the cent at the boundary — the sums themselves are done in Postgres.
// ---------------------------------------------------------------------------
interface Overview {
  period: { from: string; to: string };
  currency: string;
  mixedCurrency: boolean;
  otherCurrencies: { currency: string; bills: number; billed: number; outstanding: number }[];
  receivable: {
    bills: number; billed: number; collected: number; outstanding: number;
    overdue: number; overdueCount: number;
    ageing: {
      current: number; oneToThirty: number; thirtyOneToSixty: number;
      sixtyOneToNinety: number; overNinety: number; bucketTotal: number;
    };
  };
  payable: { bills: number; billed: number; paid: number; outstanding: number; overdue: number };
  cash: { in: number; out: number; net: number; outBasis: string };
  collection: { daysToCollect: number; payments: number };
  tax: {
    outputCharged: number; baseAmount: number; zeroRatedBase: number;
    statutoryCollected: number; exciseAmount: number; invoicesCount: number; handBuiltCount: number;
  };
  months: { month: string; billed: number; vat: number; spend: number; net: number }[];
  topCustomers: { name: string; tin: string; invoices: number; billed: number; outstanding: number; vat: number }[];
  topSuppliers: { name: string; bills: number; billed: number; outstanding: number; topCategory: string }[];
}

interface Rates {
  version: string; effectiveFrom: string; effectiveTo: string;
  lines: { label: string; rate: number; basis: string }[];
  standardVat: number | null;
}

interface Position {
  kind: string; periodStart: string; periodEnd: string; currency: string;
  figures: {
    baseAmount: number; zeroRatedBase: number; taxCharged: number; statutoryCollected: number;
    exciseAmount: number; invoicesCount: number; handBuiltCount: number;
    billedTotal: number; collectedTotal: number;
  };
  standardVatRate: number | null;
  computed: boolean;
  otherCurrencies: { currency: string; bills: number; value: number }[];
  notes: string[];
  openReturn: { id: string; status: string; basis: string; netPayable: number } | null;
  rates: Rates | null;
}

interface ReturnRow {
  id: string; kind: string; basis: string; status: string;
  periodStart: string; periodEnd: string; currency: string;
  baseAmount: number; zeroRatedBase: number; exemptBase: number;
  taxCharged: number; inputTax: number; creditsDeclared: number; netPayable: number;
  statutoryCollected: number; invoicesCount: number;
  inputBasis: string | null; ratesVersion: string | null; note: string | null;
  filingReference: string | null; filedAt: string | null; preparedAt: string | null;
  supersedesId: string | null; preparedByName: string | null; filedByName: string | null;
  scheduleLines: number; createdAt: string; updatedAt: string;
}
interface ScheduleLine {
  id: string; invoice_number: string; customer_name: string; customer_tin: string | null;
  currency: string; issue_date: string; due_date: string | null;
  subtotal: string; vat_rate: string; vat_amount: string; total: string; amount_paid: string;
  from_proforma: boolean; base_amount: number; statutory_base: number; untaxed_base: number;
}
interface ReturnDetail extends ReturnRow {
  figures: Position["figures"] | null;
  schedule: ScheduleLine[];
  rates: Rates | null;
}

const TABS = [
  { key: "desk", label: "The month", needs: "finance.view" },
  { key: "position", label: "Tax position", needs: "tax.view" },
  { key: "returns", label: "Return register", needs: "tax.view" }
] as const;
type View = typeof TABS[number]["key"];

const KINDS = [
  { key: "vat", label: "VAT on supplies", note: "Footed from the bills this company issued." },
  { key: "withholding_vat", label: "VAT withheld from us", note: "Declared: no withholding certificate is held here." },
  { key: "statutory_charges", label: "Statutory charges", note: "RDL and CPF/IDF collected on imports and passed on." }
] as const;
const kindLabel = (k: string) => KINDS.find(x => x.key === k)?.label ?? k;

const STATUS_LABELS: Record<string, string> = { draft: "Draft", prepared: "Prepared", filed: "Filed" };
const STATUS_COLORS: Record<string, string> = {
  draft: "var(--warning)", prepared: "var(--gold)", filed: "var(--success)"
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** The desk can only file a period that has finished, so it opens on the last closed month. */
function closedMonth(back = 1) {
  const now = new Date();
  return {
    from: iso(new Date(now.getFullYear(), now.getMonth() - back, 1)),
    to: iso(new Date(now.getFullYear(), now.getMonth() - back + 1, 0))
  };
}
const twelveBack = () => {
  const now = new Date();
  return { from: iso(new Date(now.getFullYear(), now.getMonth() - 11, 1)), to: iso(now) };
};
const monthLabel = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return `${(MONTH_NAMES[(m ?? 1) - 1] ?? String(m)).slice(0, 3)} ${String(y).slice(2)}`;
};
/** A period that runs 1st to the last day of its own month reads as a month, not a span. */
const fmtPeriod = (from: string, to: string) => {
  const [y, m] = from.split("-").map(Number);
  const name = MONTH_NAMES[(m ?? 1) - 1] ?? String(m);
  const lastDay = String(new Date(y, m, 0).getDate()).padStart(2, "0");
  return from.slice(8) === "01" && to.slice(0, 7) === from.slice(0, 7) && to.slice(8) === lastDay
    ? `${name} ${y}` : `${from} → ${to}`;
};
/** A date column arrives as "YYYY-MM-DD"; parsing it at noon keeps the day it names. */
const fmtDay = (v: string | null | undefined) =>
  v ? new Date(`${v}T12:00:00`).toLocaleDateString() : "—";
const fmtStamp = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "—");
const money = (v: number | string | null | undefined) =>
  v == null ? "—" : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Each kind of return asks the card a different question. A VAT return foots a base
 * and a charge; a statutory return accounts for a pass-through that has no base of
 * its own; a withheld return has nothing here to foot at all, so the card names the
 * figures the desk will have to type rather than showing a column of zeros.
 */
function figureRows(p: Position): [string, string, string][] {
  const f = p.figures;
  if (!p.computed) {
    return [
      ["VAT withheld on us", "typed at the desk", "read off the certificates this office holds"],
      ["The amount it was taken on", "typed at the desk", "the records do not say who withheld"],
      ["Credit already handed over", "typed at the desk", "it reduces what the return owes"],
      ["Where they came from", "required", "printed on the paper beside the numbers"]
    ];
  }
  if (p.kind === "statutory_charges") {
    return [
      ["Statutory charges collected", money(f.statutoryCollected), `carried by ${f.invoicesCount} bill(s)`],
      ["Charge this return accounts for", money(f.taxCharged), "the pass-through itself, never a credit against VAT"],
      ["Bill total in the period", money(f.billedTotal), `${money(f.collectedTotal)} collected`],
      ["Zero-rated base", money(f.zeroRatedBase), "supplies on a bill that carried no VAT"]
    ];
  }
  return [
    ["Taxable base", money(f.baseAmount), `${f.invoicesCount} bill(s), ${f.handBuiltCount} typed at the desk`],
    ["Charge this return accounts for", money(f.taxCharged), "footed from the bills, never typed"],
    ["Zero-rated", money(f.zeroRatedBase), "no exemption codes are kept"],
    ["Statutory passed on", money(f.statutoryCollected), "RDL, CPF/IDF — a memo, never a credit"],
    ["Billed in the period", money(f.billedTotal), `${money(f.collectedTotal)} collected`],
    ["Input credit", "not in these records", "the system holds no supplier tax invoices"]
  ];
}

/** What a desk is allowed to type onto a return — the two groups are never mixed. */
const EMPTY_PAPER = {
  inputTax: "", credits: "", exempt: "",
  charge: "", chargeBase: "",
  basis: "", note: ""
};
const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const text = (v: number | null | undefined) => (v == null || v === 0 ? "" : String(v));

export default function CfaFinancePage() {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("desk");
  const [duties, setDuties] = useState({ read: false, tax: false, prepare: false, file: false });

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Destructive or irreversible controls arm on a second tap, like the rest of the portal.
  const [arm, setArm] = useState<string | null>(null);

  // --- the dashboard -------------------------------------------------------
  const [window_, setWindow] = useState(closedMonth());
  const [overview, setOverview] = useState<Overview | null>(null);

  // --- the position --------------------------------------------------------
  const [pkind, setPkind] = useState<string>("vat");
  const [pfrom, setPfrom] = useState(closedMonth().from);
  const [pto, setPto] = useState(closedMonth().to);
  const [position, setPosition] = useState<Position | null>(null);
  const [draft, setDraft] = useState(EMPTY_PAPER);

  // --- the register --------------------------------------------------------
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [filter, setFilter] = useState({ kind: "", status: "" });
  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [edit, setEdit] = useState(EMPTY_PAPER);
  const [filing, setFiling] = useState({ reference: "", filedAt: iso(new Date()) });

  useEffect(() => {
    let cancelled = false;
    seatPermissions().then(keys => {
      if (cancelled) return;
      setDuties({
        read: keys.has("finance.view"), tax: keys.has("tax.view"),
        prepare: keys.has("tax.prepare"), file: keys.has("tax.file")
      });
      setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  const loadDesk = useCallback(async () => {
    setError(null);
    const res = await apiFetch(`/finance/overview?from=${window_.from}&to=${window_.to}`);
    const j = await readJson(res);
    if (!res.ok) { setError(errorText(j, "Could not load the money dashboard.")); return; }
    setOverview(j as Overview);
  }, [window_.from, window_.to]);

  const loadPosition = useCallback(async () => {
    setError(null);
    const res = await apiFetch(`/finance/tax/position?kind=${pkind}&periodStart=${pfrom}&periodEnd=${pto}`);
    const j = await readJson(res);
    if (!res.ok) { setError(errorText(j, "Could not foot the position for that period.")); return; }
    setPosition(j as Position);
  }, [pkind, pfrom, pto]);

  const loadRows = useCallback(async () => {
    setError(null);
    const q = new URLSearchParams({ limit: "80" });
    if (filter.kind) q.set("kind", filter.kind);
    if (filter.status) q.set("status", filter.status);
    const res = await apiFetch(`/finance/tax/returns?${q.toString()}`);
    const j = await readJson(res);
    if (!res.ok) { setError(errorText(j, "Could not read the return register.")); return; }
    setRows((j?.returns ?? []) as ReturnRow[]);
  }, [filter.kind, filter.status]);

  useEffect(() => { if (ready && view === "desk" && duties.read) loadDesk(); },
    [ready, view, duties.read, loadDesk]);
  useEffect(() => { if (ready && view === "position" && duties.tax) loadPosition(); },
    [ready, view, duties.tax, loadPosition]);
  useEffect(() => { if (ready && view === "returns" && duties.tax) loadRows(); },
    [ready, view, duties.tax, loadRows]);

  async function openRow(id: string) {
    setError(null);
    const res = await apiFetch(`/finance/tax/returns/${id}`);
    const j = await readJson(res);
    if (!res.ok) { setError(errorText(j, "Could not open that return.")); return; }
    const d = j as ReturnDetail;
    setDetail(d);
    setEdit({
      inputTax: text(d.inputTax), credits: text(d.creditsDeclared), exempt: text(d.exemptBase),
      charge: text(d.taxCharged), chargeBase: text(d.baseAmount),
      basis: d.inputBasis ?? "", note: d.note ?? ""
    });
    setFiling(f => ({ ...f, reference: "" }));
    setArm(null);
  }

  // --- writing -------------------------------------------------------------
  async function raiseReturn() {
    setBusy(true); setError(null); setNotice(null);
    const common = {
      kind: pkind, periodStart: pfrom, periodEnd: pto,
      inputBasis: draft.basis.trim(), note: draft.note.trim() || undefined
    };
    // A withheld return has nothing to foot, so the charge and the amount it was
    // taken on are the figures the office read off its certificates, and no credit
    // is claimed against them here. A footed return sends only its credits: the
    // server re-foots the base and the charge from the bills.
    const body = pkind === "withholding_vat"
      ? { ...common, taxCharged: num(draft.charge), baseAmount: num(draft.chargeBase) }
      : { ...common, inputTax: num(draft.inputTax), creditsDeclared: num(draft.credits), exemptBase: num(draft.exempt) };
    const res = await apiFetch("/finance/tax/returns", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await readJson(res);
    setBusy(false);
    if (!res.ok) { setError(errorText(j, "Could not raise the return.")); return; }
    setNotice(`${kindLabel(pkind)} — a draft for ${fmtPeriod(pfrom, pto)} is on the register.`);
    setDraft(EMPTY_PAPER);
    setView("returns");
    await loadRows();
    openRow(j.id as string);
  }

  async function saveCredits() {
    if (!detail) return;
    setBusy(true); setError(null); setNotice(null);
    const common = {
      inputBasis: edit.basis.trim(),
      // The route keeps a note it is not given a replacement for, so a blank box is
      // left out of the call rather than sent as though it were a new note.
      ...(edit.note.trim() ? { note: edit.note.trim() } : {})
    };
    const body = detail.basis === "declared"
      ? { ...common, taxCharged: num(edit.charge), baseAmount: num(edit.chargeBase), inputTax: num(edit.inputTax) }
      : { ...common, inputTax: num(edit.inputTax), creditsDeclared: num(edit.credits), exemptBase: num(edit.exempt) };
    const res = await apiFetch(`/finance/tax/returns/${detail.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await readJson(res);
    setBusy(false);
    if (!res.ok) { setError(errorText(j, "Could not save the figures.")); return; }
    setNotice(detail.basis === "declared"
      ? `Saved. The figures are the ones this desk typed, and they foot to ${money(j.netPayable)} ${detail.currency}.`
      : `Re-footed from the bills on file: the return now claims ${money(j.netPayable)} ${detail.currency}.`);
    await openRow(detail.id);
    loadRows();
  }

  async function act(path: string, method: "POST" | "PUT" | "DELETE", payload?: unknown) {
    if (!detail) return;
    setBusy(true); setError(null); setNotice(null);
    const res = await apiFetch(`/finance/tax/returns/${detail.id}${path}`, {
      method,
      ...(payload === undefined ? { headers: { "Content-Type": "application/json" }, body: "{}" }
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
    });
    const j = await readJson(res);
    setBusy(false);
    if (!res.ok) { setError(errorText(j, "That did not go through.")); return; }
    return j;
  }

  async function prepare() {
    const j = await act("/prepare", "POST");
    if (!j) return;
    setNotice(`Prepared — the schedule behind it is copied in and cannot move now.`);
    await openRow(detail!.id); loadRows();
  }

  async function file() {
    const j = await act("/file", "PUT", { filingReference: filing.reference.trim(), filedAt: filing.filedAt });
    if (!j) return;
    setNotice(`Filed under ${filing.reference.trim()}. The paper is kept exactly as filed.`);
    await openRow(detail!.id); loadRows();
  }

  async function supersede() {
    if (arm !== `supersede:${detail?.id}`) { setArm(`supersede:${detail?.id}`); return; }
    setArm(null);
    const j = await act("/supersede", "POST");
    if (!j) return;
    setNotice("A replacement draft has been raised. The filed one stays as it was filed.");
    setView("returns");
    await loadRows();
    openRow(j.id as string);
  }

  async function withdraw() {
    if (arm !== `withdraw:${detail?.id}`) { setArm(`withdraw:${detail?.id}`); return; }
    setArm(null);
    const j = await act("", "DELETE");
    if (!j) return;
    setNotice("The draft has been withdrawn. It leaves the register; the row itself stays in the file stamped, with the audit trail behind it.");
    setDetail(null);
    loadRows();
  }

  async function exportCsv() {
    if (!detail) return;
    setError(null);
    const res = await apiFetch(`/finance/tax/returns/${detail.id}/schedule.csv`);
    if (!res.ok) {
      const j = await readJson(res);
      setError(errorText(j, "Could not export the schedule."));
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tax-return-${detail.kind}-${detail.periodStart}-to-${detail.periodEnd}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice("The schedule downloaded as the file an accountant takes to the portal.");
  }

  // -------------------------------------------------------------------------
  const card = "rounded-card border bg-surface p-20";
  const cardStyle = { borderColor: "var(--line)" } as const;
  const labelCls = "mb-4 block text-[11px] font-semibold uppercase tracking-[0.14em]";
  const inputCls = "w-full rounded-input border px-12 py-8 text-sm";
  const inputStyle = { borderColor: "var(--line)", background: "var(--milk)" } as const;
  const ghostBtn = "rounded-input border px-12 py-8 text-xs font-semibold disabled:opacity-50";
  const tileLabel = "text-[11px] font-semibold uppercase tracking-[0.14em]";

  const trend = overview?.months ?? [];
  const trendMax = Math.max(...trend.map(m => Math.max(m.billed, m.spend)), 1);
  const buckets = overview ? [
    { label: "Not due yet", value: overview.receivable.ageing.current, colour: "var(--success)" },
    { label: "1–30 days", value: overview.receivable.ageing.oneToThirty, colour: "var(--brand)" },
    { label: "31–60", value: overview.receivable.ageing.thirtyOneToSixty, colour: "var(--gold)" },
    { label: "61–90", value: overview.receivable.ageing.sixtyOneToNinety, colour: "var(--warning)" },
    { label: "Over 90", value: overview.receivable.ageing.overNinety, colour: "var(--danger)" }
  ] : [];
  const shownTotal = buckets.reduce((s, b) => s + b.value, 0);
  const unaged = overview ? overview.receivable.outstanding - shownTotal : 0;

  const shown = TABS.filter(t => (t.needs === "finance.view" ? duties.read : duties.tax));

  return (
    <div className="mx-auto max-w-[1140px] px-16 py-32">
      <h1 className="text-xl font-bold" style={{ color: "var(--ink)" }}>Finance and tax</h1>
      <p className="mt-8 text-sm" style={{ color: "var(--ink-soft)" }}>
        The company&rsquo;s own paper, footed: who owes what is overdue, what is owed out, and the
        figures a return asks for. Nothing here moves money and nothing here files to a tax authority.
      </p>

      <nav className="no-print mt-20 flex flex-wrap gap-8" aria-label="Finance views">
        {shown.map(t => (
          <button key={t.key} type="button" onClick={() => setView(t.key)}
            className="rounded-input border px-14 py-8 text-xs font-semibold"
            style={view === t.key
              ? { borderColor: "var(--brand)", background: "var(--brand)", color: "#fff" }
              : { borderColor: "var(--line)", color: "var(--ink-soft)" }}>
            {t.label}
          </button>
        ))}
      </nav>

      {error && (
        <div role="alert" className="no-print mt-16 mb-8 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--danger) 8%, transparent)", borderLeft: "4px solid var(--danger)" }}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="no-print mt-16 mb-8 px-12 py-8 text-sm"
          style={{ background: "color-mix(in srgb, var(--success) 10%, transparent)", borderLeft: "4px solid var(--success)" }}>
          {notice}
        </div>
      )}

      {/* =============================================================== */}
      {/* The month                                                       */}
      {/* =============================================================== */}
      {view === "desk" && !duties.read && (
        <p className="pane-note mt-24 text-sm">This seat does not hold the finance duty, so the money dashboard is not shown.</p>
      )}
      {view === "desk" && duties.read && (
        <>
          <section className="no-print mt-24 flex flex-wrap items-end gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>From</span>
              <input type="date" value={window_.from} className={inputCls} style={inputStyle}
                onChange={e => setWindow(w => ({ ...w, from: e.target.value }))} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>To</span>
              <input type="date" value={window_.to} className={inputCls} style={inputStyle}
                onChange={e => setWindow(w => ({ ...w, to: e.target.value }))} />
            </label>
            <button type="button" className={ghostBtn} style={{ borderColor: "var(--line)", color: "var(--ink)" }}
              onClick={() => setWindow(closedMonth())}>Last closed month</button>
            <button type="button" className={ghostBtn} style={{ borderColor: "var(--line)", color: "var(--ink)" }}
              onClick={() => setWindow(twelveBack())}>Twelve months</button>
          </section>

          {overview && (
            <>
              <section className="mt-20 grid grid-cols-2 gap-14 lg:grid-cols-4">
                <div className="stat-tile">
                  <p className={tileLabel} style={{ color: "var(--ink-soft)" }}>Owed to us</p>
                  <p className="mt-6 text-lg font-bold tabular-nums" style={{ color: "var(--gold)" }}>
                    {money(overview.receivable.outstanding)}
                  </p>
                  <p className="mt-4 text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {overview.receivable.bills} issued bill(s) · {money(overview.receivable.billed)} billed
                  </p>
                </div>
                <div className="stat-tile">
                  <p className={tileLabel} style={{ color: "var(--ink-soft)" }}>Late</p>
                  <p className="mt-6 text-lg font-bold tabular-nums" style={{ color: "var(--danger)" }}>
                    {money(overview.receivable.overdue)}
                  </p>
                  <p className="mt-4 text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {overview.receivable.overdueCount} bill(s) past their due date
                  </p>
                </div>
                <div className="stat-tile">
                  <p className={tileLabel} style={{ color: "var(--ink-soft)" }}>We owe suppliers</p>
                  <p className="mt-6 text-lg font-bold tabular-nums" style={{ color: "var(--ink)" }}>
                    {money(overview.payable.outstanding)}
                  </p>
                  <p className="mt-4 text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {overview.payable.bills} cost(s) recorded · {money(overview.payable.overdue)} past due
                  </p>
                </div>
                <div className="stat-tile">
                  <p className={tileLabel} style={{ color: "var(--ink-soft)" }}>Cash in the window</p>
                    <p className="mt-6 text-lg font-bold tabular-nums"
                      style={{ color: overview.cash.net >= 0 ? "var(--success)" : "var(--danger)" }}>
                    {money(overview.cash.net)}
                  </p>
                  <p className="mt-4 text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                    {money(overview.cash.in)} in · {money(overview.cash.out)} out
                  </p>
                </div>
              </section>

              <p className="pane-note mt-10 text-[11px]">
                Every figure is {overview.currency}. Collections average{" "}
                {overview.collection.daysToCollect.toLocaleString(undefined, { maximumFractionDigits: 1 })} days
                over {overview.collection.payments} recorded payment(s). {overview.cash.outBasis}
              </p>

              {overview.mixedCurrency && (
                <div role="status" className="mt-16 px-12 py-10 text-sm"
                  style={{ background: "color-mix(in srgb, var(--gold) 12%, transparent)", borderLeft: "4px solid var(--gold)" }}>
                  <span className="font-semibold">Paper this desk cannot add:</span>{" "}
                  {overview.otherCurrencies.map(c =>
                    `${c.bills} bill(s) in ${c.currency} worth ${money(c.billed)}, ${money(c.outstanding)} of it still owed`).join("; ")}.
                  A return is denominated in one currency and nothing here converts, so that paper is named, not summed.
                </div>
              )}

              {/* Ageing */}
              <section className={card} style={cardStyle}>
                <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                  Receivables by age — {fmtPeriod(window_.from, window_.to)}
                </h2>
                <div className="mt-16 flex h-14 w-full overflow-hidden rounded-input border" style={cardStyle}>
                  {buckets.map(b => (
                    <div key={b.label} title={`${b.label}: ${money(b.value)}`}
                      style={{ width: `${(b.value / (shownTotal || 1)) * 100}%`, background: b.colour }} />
                  ))}
                </div>
                <div className="mt-14 grid grid-cols-2 gap-12 sm:grid-cols-3 lg:grid-cols-5">
                  {buckets.map(b => (
                    <div key={b.label}>
                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>
                        {b.label}
                      </p>
                      <p className="mt-4 text-sm font-bold tabular-nums" style={{ color: b.colour }}>{money(b.value)}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-14 text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                  {money(overview.receivable.ageing.bucketTotal)} of it is late and {money(overview.receivable.ageing.current)}
                  {" "}is not yet due, so the five buckets foot to {money(shownTotal)} of the {money(overview.receivable.outstanding)} outstanding.{" "}
                  {unaged > 0
                    ? `${money(unaged)} sits on paper with no due date — it is owed, but it carries no age.`
                    : "Every owed bill carries a due date, so nothing falls outside the buckets."}
                </p>
              </section>

              {/* Trend */}
              {trend.length > 0 && (
                <section className={`${card} mt-20`}>
                  <div className="flex flex-wrap items-center justify-between gap-8">
                    <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      Billed against spent
                    </h2>
                    <div className="flex gap-14 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                      <span className="flex items-center gap-4">
                        <span className="inline-block h-8 w-8 rounded-sm" style={{ background: "var(--brand)" }} /> Billed
                      </span>
                      <span className="flex items-center gap-4">
                        <span className="inline-block h-8 w-8 rounded-sm" style={{ background: "var(--danger)" }} /> Spent
                      </span>
                    </div>
                  </div>
                  <div className="mt-16 flex items-end gap-4 overflow-x-auto" style={{ height: 190 }}>
                    {trend.map(m => (
                      <div key={m.month} className="flex min-w-[34px] flex-1 flex-col items-center gap-4">
                        <div className="flex w-full items-end justify-center gap-2" style={{ height: 140 }}>
                          <div className="w-1/3 rounded-t" style={{
                            height: `${Math.max((m.billed / trendMax) * 100, m.billed > 0 ? 2 : 0)}%`,
                            background: "var(--brand)"
                          }} title={`Billed ${money(m.billed)} · VAT ${money(m.vat)}`} />
                          <div className="w-1/3 rounded-t" style={{
                            height: `${Math.max((m.spend / trendMax) * 100, m.spend > 0 ? 2 : 0)}%`,
                            background: "var(--danger)"
                          }} title={`Spent ${money(m.spend)}`} />
                        </div>
                        <span className="text-[9px] uppercase" style={{ color: "var(--ink-soft)" }}>{monthLabel(m.month)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* VAT snapshot + who owes */}
              <div className="mt-20 grid gap-20 lg:grid-cols-2">
                <section className={card} style={cardStyle}>
                  <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                    VAT on the paper in this window
                  </h2>
                  <dl className="mt-14 space-y-10 text-sm">
                    {[
                      ["Taxable base", money(overview.tax.baseAmount)],
                      ["VAT charged", money(overview.tax.outputCharged)],
                      ["Zero-rated supplies", money(overview.tax.zeroRatedBase)],
                      ["Statutory collected (memo)", money(overview.tax.statutoryCollected)],
                      ["Excise", money(overview.tax.exciseAmount)]
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-12 border-b pb-8"
                        style={{ borderColor: "var(--line)" }}>
                        <dt style={{ color: "var(--ink-soft)" }}>{k}</dt>
                        <dd className="font-semibold tabular-nums" style={{ color: "var(--ink)" }}>{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    {overview.tax.invoicesCount} issued bill(s), of which {overview.tax.handBuiltCount} were typed at the desk
                    rather than converted from a proforma — those carry no section split. Draft and cancelled bills are outside a return.
                  </p>
                </section>

                <section className={card} style={cardStyle}>
                  <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                    Who owes the most
                  </h2>
                  <div className="mt-12 overflow-x-auto">
                    <table className="w-full min-w-[420px] text-sm">
                      <thead>
                        <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                          <th className="p-8">Customer</th><th className="p-8">Bills</th>
                          <th className="p-8 text-right">Owed</th><th className="p-8 text-right">VAT</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.topCustomers.map((c, i) => (
                          <tr key={c.name} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                            <td className="p-8">
                              <span className="font-semibold" style={{ color: "var(--ink)" }}>{c.name}</span>
                              {c.tin && <span className="block text-[10px]" style={{ color: "var(--ink-soft)" }}>TIN {c.tin}</span>}
                            </td>
                            <td className="p-8 tabular-nums" style={{ color: "var(--ink-soft)" }}>{c.invoices}</td>
                            <td className="p-8 text-right tabular-nums font-semibold" style={{ color: "var(--gold)" }}>
                              {money(c.outstanding)}
                            </td>
                            <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{money(c.vat)}</td>
                          </tr>
                        ))}
                        {overview.topCustomers.length === 0 && (
                          <tr><td colSpan={4} className="p-12 text-sm" style={{ color: "var(--ink-soft)" }}>
                            No bill was issued in this window.
                          </td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <h3 className="mt-20 text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                    Who we owe
                  </h3>
                  <div className="mt-8 overflow-x-auto">
                    <table className="w-full min-w-[420px] text-sm">
                      <tbody>
                        {overview.topSuppliers.map((s, i) => (
                          <tr key={s.name} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                            <td className="p-8">
                              <span className="font-semibold" style={{ color: "var(--ink)" }}>{s.name}</span>
                              <span className="block text-[10px] capitalize" style={{ color: "var(--ink-soft)" }}>
                                {s.topCategory} · {s.bills} cost(s)
                              </span>
                            </td>
                            <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{money(s.billed)}</td>
                            <td className="p-8 text-right tabular-nums font-semibold" style={{ color: "var(--danger)" }}>
                              {money(s.outstanding)}
                            </td>
                          </tr>
                        ))}
                        {overview.topSuppliers.length === 0 && (
                          <tr><td className="p-12 text-sm" style={{ color: "var(--ink-soft)" }}>
                            No cost was recorded in this window.
                          </td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </>
          )}
        </>
      )}

      {/* =============================================================== */}
      {/* Tax position                                                    */}
      {/* =============================================================== */}
      {view === "position" && duties.tax && (
        <>
          <section className="no-print mt-24 grid gap-12 sm:grid-cols-3">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Return</span>
              <select value={pkind} onChange={e => setPkind(e.target.value)} className={inputCls} style={inputStyle}>
                {KINDS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Period from</span>
              <input type="date" value={pfrom} className={inputCls} style={inputStyle}
                onChange={e => setPfrom(e.target.value)} />
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Period to</span>
              <input type="date" value={pto} className={inputCls} style={inputStyle}
                onChange={e => setPto(e.target.value)} />
            </label>
          </section>

          {position && (
            <div className="mt-20 grid gap-20 lg:grid-cols-[1fr_360px]">
              <section className={card} style={cardStyle}>
                <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                  {kindLabel(position.kind)} — {fmtPeriod(pfrom, pto)}
                </h2>
                <p className="mt-8 text-xs" style={{ color: "var(--ink-soft)" }}>
                  {position.computed
                    ? "Recomputed from the bills on file. The server foots these again the moment a return is raised from them."
                    : "Nothing here can be footed — the records hold no certificate of withholding from a customer."}
                </p>
                <dl className="mt-16 grid grid-cols-2 gap-14">
                  {figureRows(position).map(([k, v, hint]) => (
                    <div key={k} className="border-b pb-10" style={{ borderColor: "var(--line)" }}>
                      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--ink-soft)" }}>{k}</dt>
                      <dd className="mt-4 text-base font-bold tabular-nums" style={{ color: "var(--ink)" }}>{v}</dd>
                      <dd className="text-[10px]" style={{ color: "var(--ink-soft)" }}>{hint}</dd>
                    </div>
                  ))}
                </dl>

                <ul className="mt-18 space-y-8">
                  {position.notes.map((n, i) => (
                    <li key={i} className="flex gap-8 text-[11px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                      <span aria-hidden style={{ color: "var(--warning)" }}>▲</span>
                      <span>{n}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <div className="space-y-20">
                <section className={card} style={cardStyle}>
                  <h3 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                    Rates register on file
                  </h3>
                  {position.rates ? (
                    <>
                      <p className="mt-8 text-sm font-semibold" style={{ color: "var(--ink)" }}>{position.rates.version}</p>
                      <p className="text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                        Effective {fmtDay(position.rates.effectiveFrom)} – {fmtDay(position.rates.effectiveTo)}
                      </p>
                      <ul className="mt-12 space-y-6 text-[11px]">
                        <li className="flex justify-between" style={{ color: "var(--ink-soft)" }}>
                          <span>Standard VAT</span>
                          <span className="tabular-nums font-semibold" style={{ color: "var(--ink)" }}>
                            {position.standardVatRate == null ? "not in the register" : `${position.standardVatRate}%`}
                          </span>
                        </li>
                        {position.rates.lines.map(l => (
                          <li key={l.label} className="flex justify-between gap-8" style={{ color: "var(--ink-soft)" }}>
                            <span>{l.label}</span>
                            <span className="text-right tabular-nums" style={{ color: "var(--ink)" }}>{l.rate}% {l.basis}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-12 text-[10px]" style={{ color: "var(--ink-soft)" }}>
                        Read from the published register by kind — a rate it does not hold is left out rather than typed from memory.
                      </p>
                    </>
                  ) : (
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      No duty-rate register is on file, so nothing here can cite a version.
                    </p>
                  )}
                </section>

                {position.openReturn && (
                  <section className={card} style={cardStyle}>
                    <h3 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      This period already has a return
                    </h3>
                    <p className="mt-8 text-sm" style={{ color: "var(--ink)" }}>
                      {STATUS_LABELS[position.openReturn.status] ?? position.openReturn.status} ·{" "}
                      {position.openReturn.basis} · {money(position.openReturn.netPayable)}
                    </p>
                    <button type="button" className={`${ghostBtn} mt-12`}
                      style={{ borderColor: "var(--brand)", color: "var(--brand)" }}
                      onClick={() => { setView("returns"); openRow(position.openReturn!.id); }}>
                      Open it
                    </button>
                  </section>
                )}

                {duties.prepare && !position.openReturn && (
                  <section className={card} style={cardStyle}>
                    <h3 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                      Raise a draft for this period
                    </h3>
                    <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      {pkind === "withholding_vat"
                        ? "These records hold no withholding certificate, so this return is raised as declared: the figures are typed here and the source beside them is printed on the paper."
                        : "The base and the charge are taken from the bills by the server, never typed. Only the credits are this desk's own figures — and each one has to say where it came from."}
                    </p>
                    <div className="mt-14 space-y-12">
                      {pkind === "withholding_vat" ? (
                        <>
                          <label className="block">
                            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>VAT withheld on us *</span>
                            <input type="number" min={0} step="0.01" value={draft.charge} className={inputCls} style={inputStyle}
                              onChange={e => setDraft(c => ({ ...c, charge: e.target.value }))} />
                          </label>
                          <label className="block">
                            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>The amount it was taken on</span>
                            <input type="number" min={0} step="0.01" value={draft.chargeBase} className={inputCls} style={inputStyle}
                              onChange={e => setDraft(c => ({ ...c, chargeBase: e.target.value }))} />
                          </label>
                        </>
                      ) : (
                        <>
                          <label className="block">
                            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Input credit claimed</span>
                            <input type="number" min={0} step="0.01" value={draft.inputTax} className={inputCls} style={inputStyle}
                              onChange={e => setDraft(c => ({ ...c, inputTax: e.target.value }))} />
                          </label>
                          <label className="block">
                            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Other credits</span>
                            <input type="number" min={0} step="0.01" value={draft.credits} className={inputCls} style={inputStyle}
                              onChange={e => setDraft(c => ({ ...c, credits: e.target.value }))} />
                          </label>
                          <label className="block">
                            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Exempt supplies</span>
                            <input type="number" min={0} step="0.01" value={draft.exempt} className={inputCls} style={inputStyle}
                              onChange={e => setDraft(c => ({ ...c, exempt: e.target.value }))} />
                          </label>
                        </>
                      )}
                      <label className="block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                          Where those figures came from {pkind === "withholding_vat" ? "*" : ""}
                        </span>
                        <textarea rows={2} value={draft.basis} className={inputCls} style={inputStyle}
                          placeholder="e.g. Six supplier tax invoices held in the office file"
                          onChange={e => setDraft(c => ({ ...c, basis: e.target.value }))} />
                      </label>
                      <label className="block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note on the paper</span>
                        <input value={draft.note} className={inputCls} style={inputStyle}
                          onChange={e => setDraft(c => ({ ...c, note: e.target.value }))} />
                      </label>
                      <button type="button" disabled={busy} onClick={raiseReturn}
                        className="waisha-btn w-full rounded-input py-12 text-sm font-semibold disabled:opacity-60">
                        {busy ? "Raising…" : "Raise the draft"}
                      </button>
                    </div>
                  </section>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* =============================================================== */}
      {/* The register                                                    */}
      {/* =============================================================== */}
      {view === "returns" && duties.tax && (
        <>
          <section className="no-print mt-24 flex flex-wrap items-end gap-12">
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Kind</span>
              <select value={filter.kind} className={inputCls} style={inputStyle}
                onChange={e => setFilter(f => ({ ...f, kind: e.target.value }))}>
                <option value="">Every kind</option>
                {KINDS.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Status</span>
              <select value={filter.status} className={inputCls} style={inputStyle}
                onChange={e => setFilter(f => ({ ...f, status: e.target.value }))}>
                <option value="">Every status</option>
                {["draft", "prepared", "filed"].map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select>
            </label>
          </section>

          <div className="return-grid mt-20 grid gap-20 lg:grid-cols-[minmax(0,420px)_1fr]">
            <section className={`${card} no-print`} style={cardStyle}>
              <h2 className="text-sm font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                The register
              </h2>
              <ul className="mt-12 space-y-10">
                {rows.map(r => (
                  <li key={r.id}>
                    <button type="button" onClick={() => openRow(r.id)}
                      className="w-full rounded-input border px-12 py-10 text-left"
                      style={{
                        borderColor: detail?.id === r.id ? "var(--brand)" : "var(--line)",
                        background: detail?.id === r.id ? "color-mix(in srgb, var(--brand) 8%, transparent)" : "transparent"
                      }}>
                      <span className="flex items-center justify-between gap-8">
                        <span className="text-sm font-semibold" style={{ color: "var(--ink)" }}>{kindLabel(r.kind)}</span>
                        <span className="text-[10px] font-bold uppercase"
                          style={{ color: STATUS_COLORS[r.status] ?? "var(--ink-soft)" }}>
                          {STATUS_LABELS[r.status] ?? r.status}
                        </span>
                      </span>
                      <span className="mt-4 block text-[11px] tabular-nums" style={{ color: "var(--ink-soft)" }}>
                        {fmtPeriod(r.periodStart, r.periodEnd)} · {r.basis} · {money(r.netPayable)} {r.currency}
                      </span>
                      {r.filingReference && (
                        <span className="mt-4 block text-[10px]" style={{ color: "var(--ink-soft)" }}>
                          Ref {r.filingReference}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
                {rows.length === 0 && (
                  <li className="text-sm" style={{ color: "var(--ink-soft)" }}>
                    Nothing on the register yet. Foot a period on the tax position and raise a draft from it.
                  </li>
                )}
              </ul>
            </section>

            {!detail && (
              <p className="pane-note mt-8 text-sm">Pick a return to read its figures, the schedule behind it and what may be done to it.</p>
            )}

            {detail && (
              <section className="return-sheet rounded-card border bg-surface p-24" style={cardStyle}>
                <div className="flex flex-wrap items-start justify-between gap-12">
                  <div>
                    <h2 className="text-base font-bold" style={{ color: "var(--ink)" }}>{kindLabel(detail.kind)}</h2>
                    <p className="mt-4 text-xs tabular-nums" style={{ color: "var(--ink-soft)" }}>
                      {fmtPeriod(detail.periodStart, detail.periodEnd)} · {detail.currency} ·{" "}
                      <span style={{ color: STATUS_COLORS[detail.status] }}>{STATUS_LABELS[detail.status]}</span> · {detail.basis}
                    </p>
                  </div>
                  <p className="text-right text-xs" style={{ color: "var(--ink-soft)" }}>
                    {detail.ratesVersion ? `Rates ${detail.ratesVersion}` : "No rates version"}
                    <span className="block">{detail.invoicesCount} bill(s) · {detail.scheduleLines} schedule line(s)</span>
                  </p>
                </div>

                <div className="mt-20 overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm">
                    <tbody>
                      {[
                        ["Taxable base", detail.baseAmount], ["Zero-rated", detail.zeroRatedBase],
                        ["Exempt (declared)", detail.exemptBase], ["Charge", detail.taxCharged],
                        ["Input credit", detail.inputTax], ["Other credits", detail.creditsDeclared],
                        ["Statutory passed on", detail.statutoryCollected]
                      ].map(([k, v]) => (
                        <tr key={String(k)} className="border-b" style={{ borderColor: "var(--line)" }}>
                          <th className="py-8 text-left font-normal" style={{ color: "var(--ink-soft)" }}>{k}</th>
                          <td className="py-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{money(Number(v))}</td>
                        </tr>
                      ))}
                      <tr>
                        <th className="py-10 text-left text-sm font-bold uppercase tracking-[0.12em]" style={{ color: "var(--ink)" }}>
                          Net payable
                        </th>
                        <td className="py-10 text-right text-base font-bold tabular-nums"
                          style={{ color: detail.netPayable >= 0 ? "var(--gold)" : "var(--success)" }}>
                          {money(detail.netPayable)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                  Net payable is check-held by the register itself: charge minus input credit minus credits. A return that does not
                  foot cannot be saved, and a negative figure is a refund claim, not an error.
                </p>

                {detail.inputBasis && (
                  <p className="mt-12 border-l-4 pl-12 text-[11px]"
                    style={{ borderColor: "var(--gold)", color: "var(--ink-soft)" }}>
                    <span className="font-semibold">Declared figures come from: </span>{detail.inputBasis}
                  </p>
                )}
                {detail.note && (
                  <p className="mt-8 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    <span className="font-semibold">Note: </span>{detail.note}
                  </p>
                )}

                {detail.schedule.length > 0 && (
                  <div className="sheet-scroll mt-20 overflow-x-auto">
                    <table className="w-full min-w-[840px] text-xs">
                      <thead>
                        <tr className="border-b text-left" style={{ borderColor: "var(--line)", color: "var(--ink-soft)" }}>
                          <th className="p-8">Bill</th><th className="p-8">Issued</th><th className="p-8">Customer</th>
                          <th className="p-8 text-right">Base</th><th className="p-8 text-right">Zero-rated</th>
                          <th className="p-8 text-right">VAT</th>
                          <th className="p-8 text-right">Statutory</th><th className="p-8 text-right">Total</th>
                          <th className="p-8 text-right">Paid</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.schedule.map((l, i) => (
                          <tr key={l.id} style={{ background: i % 2 ? "var(--milk-deep)" : "transparent" }}>
                            <td className="p-8 whitespace-nowrap" style={{ color: "var(--ink)" }}>
                              {l.invoice_number}
                              <span className="block text-[9px]" style={{ color: "var(--ink-soft)" }}>
                                {l.from_proforma ? "from a proforma" : "typed at the desk"}
                              </span>
                            </td>
                            <td className="p-8 tabular-nums" style={{ color: "var(--ink-soft)" }}>{fmtDay(l.issue_date)}</td>
                            <td className="p-8" style={{ color: "var(--ink)" }}>
                              {l.customer_name}
                              {l.customer_tin && <span className="block text-[9px]" style={{ color: "var(--ink-soft)" }}>TIN {l.customer_tin}</span>}
                            </td>
                            <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{money(l.base_amount)}</td>
                            <td className="p-8 text-right tabular-nums" style={{ color: l.untaxed_base > 0 ? "var(--ink)" : "var(--ink-soft)" }}>{money(l.untaxed_base)}</td>
                            <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{money(l.vat_amount)}</td>
                            <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink-soft)" }}>{money(l.statutory_base)}</td>
                            <td className="p-8 text-right tabular-nums" style={{ color: "var(--ink)" }}>{money(l.total)}</td>
                            <td className="p-8 text-right tabular-nums" style={{ color: "var(--success)" }}>{money(l.amount_paid)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {detail.basis === "declared" && (
                  <p className="mt-12 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                    A declared return has no schedule: these records hold nothing to foot it from, which is why the source above is
                    required and printed on the paper.
                  </p>
                )}

                <div className="sig-block mt-20 grid gap-10 text-[11px] sm:grid-cols-2">
                  <p style={{ color: "var(--ink-soft)" }}>
                    Prepared by {detail.preparedByName ?? "—"}
                    <span className="block">{fmtStamp(detail.preparedAt)}</span>
                  </p>
                  <p style={{ color: "var(--ink-soft)" }}>
                    Filed by {detail.filedByName ?? "—"}
                    <span className="block">{detail.filingReference ? `Reference ${detail.filingReference}` : "not filed"}</span>
                    <span className="block">{detail.filedAt ? fmtDay(detail.filedAt.slice(0, 10)) : ""}</span>
                  </p>
                </div>

                {/* --- what this seat may do to the paper ------------------- */}
                <div className="no-print mt-24 space-y-20">
                  {detail.status !== "filed" && duties.prepare && (
                    <div className="rounded-card border p-18" style={cardStyle}>
                      <h3 className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                        {detail.basis === "declared" ? "The declared figures" : "The credits on this return"}
                      </h3>
                      <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                        {detail.basis === "declared"
                          ? "A declared return has nothing to re-foot: what is typed here is what the paper carries, and the source below has to name it."
                          : "Saving asks the server to foot the charge, the base and the schedule from the bills again. These boxes are only the credits this desk claims — never the liability itself."}
                      </p>
                      <div className="mt-14 grid gap-12 sm:grid-cols-3">
                        {detail.basis === "declared" ? (
                          <>
                            <label className="block">
                              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>VAT withheld on us *</span>
                              <input type="number" min={0} step="0.01" value={edit.charge} className={inputCls} style={inputStyle}
                                onChange={e => setEdit(x => ({ ...x, charge: e.target.value }))} />
                            </label>
                            <label className="block">
                              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>The amount it was taken on</span>
                              <input type="number" min={0} step="0.01" value={edit.chargeBase} className={inputCls} style={inputStyle}
                                onChange={e => setEdit(x => ({ ...x, chargeBase: e.target.value }))} />
                            </label>
                            <label className="block">
                              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Credit already handed to us</span>
                              <input type="number" min={0} step="0.01" value={edit.inputTax} className={inputCls} style={inputStyle}
                                onChange={e => setEdit(x => ({ ...x, inputTax: e.target.value }))} />
                            </label>
                          </>
                        ) : (
                          <>
                            <label className="block">
                              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Input credit claimed</span>
                              <input type="number" min={0} step="0.01" value={edit.inputTax} className={inputCls} style={inputStyle}
                                onChange={e => setEdit(x => ({ ...x, inputTax: e.target.value }))} />
                            </label>
                            <label className="block">
                              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Other credits</span>
                              <input type="number" min={0} step="0.01" value={edit.credits} className={inputCls} style={inputStyle}
                                onChange={e => setEdit(x => ({ ...x, credits: e.target.value }))} />
                            </label>
                            <label className="block">
                              <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Exempt supplies</span>
                              <input type="number" min={0} step="0.01" value={edit.exempt} className={inputCls} style={inputStyle}
                                onChange={e => setEdit(x => ({ ...x, exempt: e.target.value }))} />
                            </label>
                          </>
                        )}
                      </div>
                      <label className="mt-12 block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>
                          Where they came from{detail.basis === "declared" ? " *" : ""}
                        </span>
                        <textarea rows={2} value={edit.basis} className={inputCls} style={inputStyle}
                          placeholder="Required whenever a credit, an exempt figure or a declared amount is on the return"
                          onChange={e => setEdit(x => ({ ...x, basis: e.target.value }))} />
                      </label>
                      <label className="mt-12 block">
                        <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Note on the paper</span>
                        <input value={edit.note} className={inputCls} style={inputStyle}
                          placeholder="Type over it to replace the note already printed — an empty box keeps it"
                          onChange={e => setEdit(x => ({ ...x, note: e.target.value }))} />
                      </label>
                      <button type="button" disabled={busy} onClick={saveCredits}
                        className="waisha-btn mt-14 w-full rounded-input py-10 text-sm font-semibold disabled:opacity-60">
                        {busy ? "Saving…" : detail.basis === "declared" ? "Save the figures" : "Save and re-foot"}
                      </button>
                    </div>
                  )}

                  <div className="flex flex-wrap gap-10">
                    {detail.status === "draft" && duties.prepare && (
                      <button type="button" disabled={busy} onClick={prepare}
                        className="waisha-btn rounded-input px-16 py-10 text-xs font-semibold disabled:opacity-60">
                        Prepare it
                      </button>
                    )}
                    {detail.status === "prepared" && duties.file && (
                      <div className="w-full rounded-card border p-18" style={cardStyle}>
                        <h3 className="text-xs font-bold uppercase tracking-[0.14em]" style={{ color: "var(--ink-soft)" }}>
                          Record the filing
                        </h3>
                        <p className="mt-6 text-[11px]" style={{ color: "var(--ink-soft)" }}>
                          Nothing is submitted from here. This is the reference the portal gave back, written down so the company can
                          prove what it filed and when.
                        </p>
                        <div className="mt-12 grid gap-12 sm:grid-cols-[1fr_180px]">
                          <label className="block">
                            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Submission reference *</span>
                            <input value={filing.reference} className={inputCls} style={inputStyle}
                              placeholder="e.g. TTMS-2026-000123"
                              onChange={e => setFiling(f => ({ ...f, reference: e.target.value }))} />
                          </label>
                          <label className="block">
                            <span className={labelCls} style={{ color: "var(--ink-soft)" }}>Filed on *</span>
                            <input type="date" value={filing.filedAt} className={inputCls} style={inputStyle}
                              onChange={e => setFiling(f => ({ ...f, filedAt: e.target.value }))} />
                          </label>
                        </div>
                        <button type="button" disabled={busy || filing.reference.trim().length < 3} onClick={file}
                          className="waisha-btn mt-14 w-full rounded-input py-10 text-sm font-semibold disabled:opacity-60">
                          {busy ? "Filing…" : "File it"}
                        </button>
                      </div>
                    )}
                    {detail.status === "filed" && duties.prepare && (
                      <button type="button" disabled={busy} onClick={supersede}
                        className="rounded-input border px-16 py-10 text-xs font-semibold disabled:opacity-60"
                        style={{ borderColor: arm === `supersede:${detail.id}` ? "var(--danger)" : "var(--line)", color: "var(--danger)" }}>
                        {arm === `supersede:${detail.id}` ? "Tap again to raise a replacement" : "Supersede this filing"}
                      </button>
                    )}
                    {detail.status !== "filed" && duties.prepare && (
                      <button type="button" disabled={busy} onClick={withdraw}
                        className="rounded-input border px-16 py-10 text-xs font-semibold disabled:opacity-60"
                        style={{ borderColor: arm === `withdraw:${detail.id}` ? "var(--danger)" : "var(--line)", color: "var(--danger)" }}>
                        {arm === `withdraw:${detail.id}` ? "Tap again to withdraw the draft" : "Withdraw"}
                      </button>
                    )}
                    <button type="button" onClick={exportCsv}
                      className={ghostBtn} style={{ borderColor: "var(--line)", color: "var(--brand)" }}>
                      Export the schedule (CSV)
                    </button>
                    <button type="button" onClick={() => window.print()}
                      className={ghostBtn} style={{ borderColor: "var(--line)", color: "var(--ink)" }}>
                      Print / Save as PDF
                    </button>
                  </div>

                  {detail.supersedesId && (
                    <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      This return replaces {detail.supersedesId.slice(0, 8)}… — the filed paper it replaces is still on the register.
                    </p>
                  )}
                  {detail.status === "filed" && (
                    <p className="text-[11px]" style={{ color: "var(--ink-soft)" }}>
                      A filed return cannot be edited or withdrawn by anybody, including the person who filed it. A mistake is
                      corrected the way it is corrected on paper: a new return that names this one.
                    </p>
                  )}
                </div>
              </section>
            )}
          </div>
        </>
      )}
    </div>
  );
}
